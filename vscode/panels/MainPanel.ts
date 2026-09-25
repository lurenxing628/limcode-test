import * as vscode from 'vscode';
import {
  BridgeMessageType,
  createMessageId,
  type BridgeClientId,
  type OpenConversationPanelRecord,
  type PlanProposalOpenPayload,
  type WebviewClientMeta,
  type WebviewToExtensionMessage
} from '../../shared/protocol';
import { displayConversationTitle, displayConversationTitleFromText } from '../../shared/conversationTitle';
import { EXTENSION_AGENT_NAME, EXTENSION_BRAND, MAIN_PANEL_VIEW_TYPE, WEBVIEW_DEV_PORT } from '../../shared/extensionIdentity';
import {
  getInitializingWebviewHtml,
  getUnavailableWebviewHtml,
  getWebviewHtml,
  getWebviewLocalResourceRoots,
  getWebviewStaticResourceRoots,
  resolveLocalFileSourceUri
} from '../webview/getWebviewHtml';
import { isReliableKernelControlMessage } from '../../shared/reliableKernelClientFeed';
import type { ApplicationFacade } from '../ApplicationFacade';
import type { ApplicationStartup } from '../ApplicationStartup';
import { isConversationRuntimeOwnerBusyError } from '../../backend/reliableKernel/ConversationRuntimeOwnerManager';

export interface MainPanelOptions {
  conversationId?: string;
  title?: string;
  kind?: 'chat' | 'globalSettings' | 'workflowSettings' | 'agentSettings' | 'planDetail';
  toolCallId?: string;
  planProposalId?: string;
  reuse?: boolean;
}

type MainPanelKind = 'chat' | 'globalSettings' | 'workflowSettings' | 'agentSettings' | 'planDetail';

const PANEL_TAB_TITLE_MAX_DISPLAY_UNITS = 20;
const PANEL_TAB_TITLE_ELLIPSIS = '...';

export class MainPanel {
  public static readonly viewType = MAIN_PANEL_VIEW_TYPE;

  private static readonly panels = new Map<string, MainPanel>();
  /** In-flight claim-before-open per Conversation view identity; simultaneous opens share it. */
  private static readonly pendingConversationOpens = new Map<string, Promise<void>>();
  /** Serializes the check-claim-register section across command, restore and navigation opens. */
  private static readonly conversationOpenChains = new Map<string, Promise<void>>();
  private static readonly conversationPanelStateEmitter = new vscode.EventEmitter<void>();
  public static readonly onDidChangeConversationPanelState = MainPanel.conversationPanelStateEmitter.event;

  private readonly panel: vscode.WebviewPanel;
  private readonly extensionUri: vscode.Uri;
  private readonly backendApp: ApplicationFacade;
  private readonly panelId: string;
  private readonly clientId: BridgeClientId;
  private readonly kind: MainPanelKind;
  private readonly conversationId?: string;
  private readonly toolCallId?: string;
  private readonly planProposalId?: string;
  /** This view's independent Conversation owner reference; released only on dispose. */
  private readonly ownerReferenceId?: string;
  private readonly disposables: vscode.Disposable[] = [];

  public static registerSerializer(context: vscode.ExtensionContext, startup: ApplicationStartup): void {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(MainPanel.viewType, {
        async deserializeWebviewPanel(webviewPanel, state) {
          const serialized = optionsFromSerializedState(state, webviewPanel.title);
          let disposed = false;
          const startupDispose = webviewPanel.onDidDispose(() => { disposed = true; });
          MainPanel.renderInitializing(webviewPanel, serialized);
          try {
            const backendApp = await startup.wait();
            const options = await resolveRestoredPanelOptions(backendApp, serialized);
            if (disposed) {
              startupDispose.dispose();
              return;
            }
            await MainPanel.claimRestoredConversationPanel(
              webviewPanel,
              context.extensionUri,
              backendApp,
              options,
              () => disposed
            );
            startupDispose.dispose();
          } catch (error) {
            startupDispose.dispose();
            if (disposed) return;
            MainPanel.renderUnavailable(
              webviewPanel,
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      })
    );
  }

  /**
   * Restored Conversation views join the same per-Conversation open section as live opens: an
   * already-live main chat panel is adopted (the restored duplicate closes), otherwise the
   * restored view retains the Conversation owner before it revives. Every failure path either
   * leaves the reference held by the revived view or releases it; nothing leaks.
   */
  private static async claimRestoredConversationPanel(
    webviewPanel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    backendApp: ApplicationFacade,
    options: MainPanelOptions,
    isDisposed: () => boolean
  ): Promise<void> {
    const kind = panelKind(options);
    const conversationId = kind === 'chat' || kind === 'planDetail'
      ? stringValue(options.conversationId)
      : undefined;
    if (!conversationId) {
      if (isDisposed()) return;
      MainPanel.revive(webviewPanel, extensionUri, backendApp, options);
      return;
    }
    await MainPanel.enqueueConversationOpen(conversationId, async () => {
      if (isDisposed()) return;
      const existing = MainPanel.existingConversationPanel(kind, options, conversationId);
      if (existing && (kind === 'chat' || options.reuse)) {
        existing.refreshTitle(options.title);
        existing.panel.reveal(webviewPanel.viewColumn ?? vscode.ViewColumn.One);
        MainPanel.notifyConversationPanelStateChanged();
        webviewPanel.dispose();
        return;
      }
      const referenceId = createMessageId();
      try {
        await backendApp.retainConversation(conversationId, referenceId);
      } catch (error) {
        if (!isDisposed()) MainPanel.renderUnavailable(webviewPanel, MainPanel.conversationOpenFailureMessage(error));
        return;
      }
      // A restore blocked behind a queued open may already have been closed by the user.
      if (isDisposed()) {
        await backendApp.releaseConversation(conversationId, referenceId);
        return;
      }
      try {
        MainPanel.revive(webviewPanel, extensionUri, backendApp, options, referenceId);
      } catch (error) {
        await backendApp.releaseConversation(conversationId, referenceId);
        throw error;
      }
      if (options.conversationId) {
        MainPanel.scheduleRestoredTitleRefresh(backendApp, options.conversationId);
      }
    });
  }

  private static scheduleRestoredTitleRefresh(backendApp: ApplicationFacade, conversationId: string): void {
    // A serialized conversation identity is sufficient to restore and handshake. Refresh its
    // display title after lazy history hydration instead of blocking the whole view.
    void backendApp.waitUntilHydrated().then(
      () => MainPanel.refreshConversationTitle(conversationId),
      () => undefined
    );
  }

  public static registerUnavailableSerializer(context: vscode.ExtensionContext, message: string): void {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(MainPanel.viewType, {
        async deserializeWebviewPanel(webviewPanel) {
          MainPanel.renderUnavailable(webviewPanel, message);
        }
      })
    );
  }

  public static createUnavailable(message: string): void {
    const panel = vscode.window.createWebviewPanel(
      MainPanel.viewType,
      `${EXTENSION_BRAND} 无法启动`,
      vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
      { enableScripts: false, retainContextWhenHidden: true }
    );
    MainPanel.renderUnavailable(panel, message);
  }

  /**
   * Opens or focuses a panel. Conversation views claim the Conversation Runtime owner BEFORE the
   * panel exists: the main chat view is unique per Conversation in this Host regardless of the
   * reuse flag, simultaneous opens of the same view identity share one in-flight Promise, and a
   * failed claim reports a per-Conversation error without leaking the owner reference. Surfaces
   * without a Conversation identity (settings kinds) never touch ownership.
   */
  public static createOrShow(
    extensionUri: vscode.Uri,
    backendApp: ApplicationFacade,
    options: MainPanelOptions = {}
  ): Promise<void> {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    const kind = panelKind(options);
    const conversationId = kind === 'chat' || kind === 'planDetail'
      ? stringValue(options.conversationId)
      : undefined;

    if (!conversationId) {
      if (options.reuse) {
        const existing = [...MainPanel.panels.values()].find((candidate) => candidate.matches(options));
        if (existing) {
          existing.refreshTitle(options.title);
          existing.panel.reveal(column);
          MainPanel.notifyConversationPanelStateChanged();
          return Promise.resolve();
        }
      }
      const panel = vscode.window.createWebviewPanel(
        MainPanel.viewType,
        panelTitle(options, backendApp),
        column,
        MainPanel.webviewPanelOptions(extensionUri, kind)
      );
      MainPanel.revive(panel, extensionUri, backendApp, options);
      return Promise.resolve();
    }

    const existing = MainPanel.existingConversationPanel(kind, options, conversationId);
    if (existing && (kind === 'chat' || options.reuse)) {
      existing.refreshTitle(options.title);
      existing.panel.reveal(column);
      MainPanel.notifyConversationPanelStateChanged();
      return Promise.resolve();
    }

    const flightKey = kind === 'chat'
      ? `chat:${conversationId}`
      : `${kind}:${conversationId}:${options.toolCallId ?? ''}:${options.planProposalId ?? ''}`;
    const pending = MainPanel.pendingConversationOpens.get(flightKey);
    if (pending) return pending;
    const open = MainPanel.enqueueConversationOpen(conversationId, () =>
      MainPanel.openClaimedConversationPanel(extensionUri, backendApp, options, conversationId, column)
    );
    MainPanel.pendingConversationOpens.set(flightKey, open);
    const cleanup = () => {
      if (MainPanel.pendingConversationOpens.get(flightKey) === open) {
        MainPanel.pendingConversationOpens.delete(flightKey);
      }
    };
    void open.then(cleanup, cleanup);
    return open;
  }

  private static existingConversationPanel(
    kind: MainPanelKind,
    options: MainPanelOptions,
    conversationId: string
  ): MainPanel | undefined {
    for (const panel of MainPanel.panels.values()) {
      if (kind === 'chat') {
        if (panel.kind === 'chat' && panel.conversationId === conversationId) return panel;
      } else if (panel.matches(options)) {
        return panel;
      }
    }
    return undefined;
  }

  private static enqueueConversationOpen(conversationId: string, operation: () => Promise<void>): Promise<void> {
    const previous = MainPanel.conversationOpenChains.get(conversationId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    MainPanel.conversationOpenChains.set(conversationId, current);
    const cleanup = () => {
      if (MainPanel.conversationOpenChains.get(conversationId) === current) {
        MainPanel.conversationOpenChains.delete(conversationId);
      }
    };
    void current.then(cleanup, cleanup);
    return current;
  }

  private static async openClaimedConversationPanel(
    extensionUri: vscode.Uri,
    backendApp: ApplicationFacade,
    options: MainPanelOptions,
    conversationId: string,
    column: vscode.ViewColumn
  ): Promise<void> {
    const kind = panelKind(options);
    // A restore or a differently-keyed opener may have adopted this Conversation while queued.
    const existing = MainPanel.existingConversationPanel(kind, options, conversationId);
    if (existing && (kind === 'chat' || options.reuse)) {
      existing.refreshTitle(options.title);
      existing.panel.reveal(column);
      MainPanel.notifyConversationPanelStateChanged();
      return;
    }
    const referenceId = createMessageId();
    let panel: vscode.WebviewPanel | undefined;
    try {
      await backendApp.retainConversation(conversationId, referenceId);
      panel = vscode.window.createWebviewPanel(
        MainPanel.viewType,
        panelTitle(options, backendApp),
        column,
        MainPanel.webviewPanelOptions(extensionUri, kind)
      );
      MainPanel.revive(panel, extensionUri, backendApp, options, referenceId);
    } catch (error) {
      panel?.dispose();
      await backendApp.releaseConversation(conversationId, referenceId);
      void vscode.window.showWarningMessage(`${EXTENSION_BRAND}: ${MainPanel.conversationOpenFailureMessage(error)}`);
    }
  }

  private static conversationOpenFailureMessage(error: unknown): string {
    // A busy Conversation is the only expected refusal: another window owns exactly that
    // Conversation while the rest of this window keeps working.
    if (isConversationRuntimeOwnerBusyError(error)) return error.message;
    console.error('[LimCode] Failed to open conversation panel.', error);
    return `无法打开对话：${error instanceof Error ? error.message : String(error)}`;
  }

  private static revive(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    backendApp: ApplicationFacade,
    options: MainPanelOptions = {},
    ownerReferenceId?: string
  ): void {
    const instance = new MainPanel(panel, extensionUri, backendApp, options, ownerReferenceId);
    MainPanel.panels.set(instance.panelId, instance);
    MainPanel.notifyConversationPanelStateChanged();
  }

  private static webviewPanelOptions(
    extensionUri: vscode.Uri,
    kind: MainPanelKind
  ): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: supportsLocalFileResources(kind)
        ? getWebviewLocalResourceRoots(extensionUri)
        : getWebviewStaticResourceRoots(extensionUri),
      portMapping: [{ webviewPort: WEBVIEW_DEV_PORT, extensionHostPort: WEBVIEW_DEV_PORT }]
    };
  }

  private static renderUnavailable(panel: vscode.WebviewPanel, message: string): void {
    panel.webview.options = { enableScripts: false };
    panel.webview.html = getUnavailableWebviewHtml(message);
  }

  private static renderInitializing(panel: vscode.WebviewPanel, options: MainPanelOptions): void {
    panel.webview.options = { enableScripts: false };
    const kind = panelKind(options);
    const target = kind === 'globalSettings'
      ? '设置'
      : kind === 'workflowSettings'
        ? '工作流编辑器'
        : kind === 'agentSettings'
          ? 'Agent 设置'
          : kind === 'planDetail'
            ? 'Plan 详情'
            : '对话标签页';
    panel.webview.html = getInitializingWebviewHtml(
      `正在恢复${target}`,
      '界面已就绪，正在连接本地运行时。'
    );
  }

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    backendApp: ApplicationFacade,
    options: MainPanelOptions,
    ownerReferenceId?: string
  ) {
    this.panel = panel;
    this.extensionUri = extensionUri;
    this.backendApp = backendApp;
    this.panelId = createMessageId();
    this.kind = panelKind(options);
    this.conversationId = options.conversationId;
    this.toolCallId = options.toolCallId;
    this.planProposalId = options.planProposalId;
    this.ownerReferenceId = ownerReferenceId;

    this.refreshTitle(options.title);
    this.panel.webview.options = MainPanel.webviewPanelOptions(this.extensionUri, this.kind);
    this.clientId = this.backendApp.attachWebview(panel.webview, this.panelWebviewMeta());
    try {
      this.backendApp.setWebviewVisible(this.clientId, panel.visible);
      this.panel.webview.html = getWebviewHtml(this.panel.webview, this.extensionUri, {
        enableLocalFileResources: supportsLocalFileResources(this.kind)
      });
    } catch (error) {
      this.backendApp.detachWebview(this.clientId);
      throw error;
    }

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState(() => {
      this.backendApp.setWebviewVisible(this.clientId, this.panel.visible);
      MainPanel.notifyConversationPanelStateChanged();
    }, null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (raw: unknown) => {
        if (isReliableKernelControlMessage(raw)) {
          const handled = this.backendApp.handleReliableKernelControl?.(this.clientId, raw);
          if (handled instanceof Promise) {
            void handled.catch((error) => console.warn('[LimCode] Reliable client feed control failed.', error));
          }
          return;
        }
        const message = raw as WebviewToExtensionMessage;
        if (message.type === BridgeMessageType.ConversationOpen && message.payload?.conversationId) {
          this.openConversationFromPanel(message.payload.conversationId, message.payload.title);
          return;
        }
        if (message.type === BridgeMessageType.ConversationCreate) {
          this.createConversationFromPanel(message.payload?.projectFolderUri);
          return;
        }
        if (message.type === BridgeMessageType.PlanProposalOpen && message.payload) {
          this.openPlanProposalFromPanel(message.payload);
          return;
        }
        if (message.type === BridgeMessageType.LocalFileOpen && message.payload?.source) {
          this.openLocalFileFromPanel(message.payload.source);
          return;
        }
        this.backendApp.handleWebviewMessage(this.clientId, message);
        this.refreshTitleFromOutgoingMessage(message);
      },
      null,
      this.disposables
    );
  }

  public dispose(): void {
    MainPanel.panels.delete(this.panelId);
    MainPanel.notifyConversationPanelStateChanged();
    this.backendApp.detachWebview(this.clientId);
    // Only dispose releases this view's owner reference; a hidden panel stays retained so its
    // Conversation cannot idle-release to a peer Host while it is merely backgrounded.
    if (this.conversationId && this.ownerReferenceId) {
      void this.backendApp.releaseConversation(this.conversationId, this.ownerReferenceId);
    }

    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      disposable?.dispose();
    }
  }

  private openLocalFileFromPanel(source: string): void {
    if (!supportsLocalFileResources(this.kind)) return;
    const uri = resolveLocalFileSourceUri(source, this.extensionUri);
    if (!uri) {
      void vscode.window.showWarningMessage(`无法解析本地文件路径：${source}`);
      return;
    }
    void vscode.commands.executeCommand('vscode.open', uri).then(undefined, (error) => {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showWarningMessage(`无法打开本地文件：${message}`);
    });
  }

  private createConversationFromPanel(projectFolderUri?: string): void {
    const options = projectFolderUri?.trim() ? { projectFolderUri: projectFolderUri.trim() } : {};
    void this.backendApp
      .createConversation(options)
      .then((conversationId) => {
        void MainPanel.createOrShow(this.extensionUri, this.backendApp, { conversationId });
      })
      .catch((error) => console.warn('[LimCode] Failed to create panel conversation.', error));
  }

  private openConversationFromPanel(conversationIdInput: string, title?: string): void {
    const conversationId = conversationIdInput.trim();
    if (!conversationId) return;
    void this.backendApp.conversationExists(conversationId).then((exists) => {
      if (!exists) {
        void vscode.window.showWarningMessage(`${EXTENSION_BRAND}: 该对话已被删除或不再存在。`);
        return;
      }
      void MainPanel.createOrShow(this.extensionUri, this.backendApp, {
        conversationId,
        ...(title?.trim() ? { title: title.trim() } : {}),
        reuse: true
      });
    }).catch((error) => console.warn('[LimCode] Failed to open panel conversation.', error));
  }

  private openPlanProposalFromPanel(payload: PlanProposalOpenPayload): void {
    const conversationId = payload.conversationId?.trim() || this.conversationId;
    void MainPanel.createOrShow(this.extensionUri, this.backendApp, {
      kind: 'planDetail',
      ...(conversationId ? { conversationId } : {}),
      ...(payload.toolCallId?.trim() ? { toolCallId: payload.toolCallId.trim() } : {}),
      ...(payload.planProposalId?.trim() ? { planProposalId: payload.planProposalId.trim() } : {}),
      ...(payload.title?.trim() ? { title: payload.title.trim() } : {}),
      reuse: true
    });
  }

  private matches(options: MainPanelOptions): boolean {
    const kind = panelKind(options);
    if (kind !== this.kind) return false;
    if (kind === 'globalSettings' || kind === 'workflowSettings' || kind === 'agentSettings') return true;
    if (kind === 'planDetail') {
      return (options.conversationId ?? '') === (this.conversationId ?? '')
        && (options.toolCallId ?? '') === (this.toolCallId ?? '')
        && (options.planProposalId ?? '') === (this.planProposalId ?? '');
    }
    return (options.conversationId ?? '') === (this.conversationId ?? '');
  }

  private refreshTitle(title?: string): void {
    this.panel.title = panelTitle({ kind: this.kind, conversationId: this.conversationId, title }, this.backendApp);
  }

  private panelWebviewMeta(): WebviewClientMeta {
    return {
      kind: this.kind === 'globalSettings' ? 'globalSettings' : this.kind === 'workflowSettings' ? 'workflowSettings' : this.kind === 'agentSettings' ? 'agentSettings' : this.kind === 'planDetail' ? 'planDetail' : 'mainPanel',
      panelId: this.panelId,
      title: this.kind === 'chat' && this.conversationId
        ? this.backendApp.getConversationDisplayTitle(this.conversationId)
        : this.panel.title,
      conversationId: this.conversationId,
      ...(this.toolCallId ? { toolCallId: this.toolCallId } : {}),
      ...(this.planProposalId ? { planProposalId: this.planProposalId } : {})
    };
  }

  private refreshTitleFromOutgoingMessage(message: WebviewToExtensionMessage): void {
    if (message.type !== BridgeMessageType.TurnStart) return;
    const payload = message.payload;
    if (!this.conversationId || !payload || payload.conversationId !== this.conversationId) return;
    if (!isDefaultConversationTitle(this.panel.title)) return;
    this.panel.title = panelTabTitle(displayConversationTitleFromText(payload.text ?? payload.content?.parts.map((part) => 'text' in part ? part.text : '').join('\n') ?? ''));
  }

  public static refreshConversationTitle(conversationId: string): void {
    for (const panel of MainPanel.panels.values()) {
      if (panel.conversationId === conversationId) panel.refreshTitle();
    }
  }

  public static closePanelsByConversationId(conversationId: string): void {
    for (const panel of [...MainPanel.panels.values()]) {
      if (panel.conversationId === conversationId) panel.panel.dispose();
    }
  }

  public static getOpenConversationPanelStates(): OpenConversationPanelRecord[] {
    const byConversation = new Map<string, OpenConversationPanelRecord>();
    for (const item of MainPanel.panels.values()) {
      if (item.kind !== 'chat' || !item.conversationId) continue;
      const existing = byConversation.get(item.conversationId);
      byConversation.set(item.conversationId, {
        conversationId: item.conversationId,
        visible: (existing?.visible ?? false) || item.panel.visible,
        active: (existing?.active ?? false) || item.panel.active
      });
    }
    return [...byConversation.values()].sort((left, right) => left.conversationId.localeCompare(right.conversationId));
  }

  private static notifyConversationPanelStateChanged(): void {
    MainPanel.conversationPanelStateEmitter.fire();
  }
}

function panelKind(options: MainPanelOptions): MainPanelKind {
  if (options.kind === 'planDetail') return 'planDetail';
  if (options.kind === 'agentSettings') return 'agentSettings';
  if (options.kind === 'workflowSettings') return 'workflowSettings';
  return options.kind === 'globalSettings' ? 'globalSettings' : 'chat';
}

function panelTitle(options: MainPanelOptions, backendApp: ApplicationFacade): string {
  if (options.kind === 'globalSettings') return `${EXTENSION_BRAND} 设置`;
  if (options.kind === 'workflowSettings') return `${EXTENSION_BRAND} 工作流编辑`;
  if (options.kind === 'agentSettings') return `${EXTENSION_AGENT_NAME} 设置`;
  if (options.kind === 'planDetail') return panelTabTitle(options.title?.trim() || 'Plan 详情');
  if (!options.conversationId) return panelTabTitle(EXTENSION_BRAND);
  const title = options.title
    ? displayConversationTitle({ id: options.conversationId, title: options.title })
    : backendApp.getConversationDisplayTitle(options.conversationId);
  return panelTabTitle(title);
}

async function resolveRestoredPanelOptions(
  backendApp: ApplicationFacade,
  options: MainPanelOptions
): Promise<MainPanelOptions> {
  if (panelKind(options) !== 'chat') return options;
  await backendApp.waitUntilHydrated();
  if (options.conversationId && !await backendApp.conversationExists(options.conversationId)) {
    throw new Error('当前工作区中找不到这个对话。它可能属于其他工作区，或已被删除；请打开原工作区后重试。');
  }
  if (options.conversationId) {
    return {
      ...options,
      title: backendApp.getConversationDisplayTitle(options.conversationId)
    };
  }
  const existing = backendApp.getConversationHistoryEntries()[0];
  const conversationId = existing?.id ?? await backendApp.createConversation();
  return {
    ...options,
    conversationId,
    title: existing?.title ?? backendApp.getConversationDisplayTitle(conversationId),
    reuse: true
  };
}

function isDefaultConversationTitle(title: string): boolean {
  return title === '新对话' || title === '默认对话' || title === EXTENSION_BRAND || title.startsWith(`${EXTENSION_BRAND}: `);
}

function supportsLocalFileResources(kind: MainPanelKind): boolean {
  return kind === 'chat' || kind === 'planDetail';
}

function optionsFromSerializedState(state: unknown, fallbackTitle: string): MainPanelOptions {
  const record = asRecord(state);
  const meta = record ? metaFromState(record.meta) : undefined;
  const serializedKind = record ? stringValue(record.kind) : undefined;
  const isGlobalSettings =
    serializedKind === 'globalSettings' ||
    meta?.kind === 'globalSettings' ||
    fallbackTitle === `${EXTENSION_BRAND} 设置`;
  const isWorkflowSettings =
    serializedKind === 'workflowSettings' ||
    meta?.kind === 'workflowSettings' ||
    fallbackTitle === `${EXTENSION_BRAND} 工作流编辑`;
  const isAgentSettings =
    serializedKind === 'agentSettings' ||
    meta?.kind === 'agentSettings' ||
    fallbackTitle === `${EXTENSION_AGENT_NAME} 设置`;
  const isPlanDetail = serializedKind === 'planDetail' || meta?.kind === 'planDetail';

  if (isGlobalSettings) {
    return { kind: 'globalSettings', reuse: true };
  }
  if (isWorkflowSettings) {
    return { kind: 'workflowSettings', reuse: true };
  }
  if (isAgentSettings) {
    return { kind: 'agentSettings', reuse: true };
  }
  if (isPlanDetail) {
    return {
      kind: 'planDetail',
      conversationId: meta?.conversationId,
      toolCallId: meta?.toolCallId,
      planProposalId: meta?.planProposalId,
      title: meta?.title,
      reuse: true
    };
  }

  const conversationId =
    (record ? stringValue(record.conversationId) : undefined) ??
    meta?.conversationId ??
    conversationIdFromPanelTitle(fallbackTitle);

  return { kind: 'chat', conversationId, reuse: true };
}

function conversationIdFromPanelTitle(title: string): string | undefined {
  const prefix = `${EXTENSION_BRAND}: `;
  return title.startsWith(prefix) ? title.slice(prefix.length).trim() || undefined : undefined;
}

function metaFromState(value: unknown): WebviewClientMeta | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const kind = stringValue(record.kind);
  if (kind !== 'mainPanel' && kind !== 'globalSettings' && kind !== 'workflowSettings' && kind !== 'agentSettings' && kind !== 'planDetail' && kind !== 'sidebar' && kind !== 'unknown') {
    return undefined;
  }

  const meta: WebviewClientMeta = { kind };
  const panelId = stringValue(record.panelId);
  const title = stringValue(record.title);
  const conversationId = stringValue(record.conversationId);
  const toolCallId = stringValue(record.toolCallId);
  const planProposalId = stringValue(record.planProposalId);
  if (panelId) meta.panelId = panelId;
  if (title) meta.title = title;
  if (conversationId) meta.conversationId = conversationId;
  if (toolCallId) meta.toolCallId = toolCallId;
  if (planProposalId) meta.planProposalId = planProposalId;
  return meta;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function panelTabTitle(title: string): string {
  return ellipsizeDisplayText(
    title,
    PANEL_TAB_TITLE_MAX_DISPLAY_UNITS,
    PANEL_TAB_TITLE_ELLIPSIS
  );
}

function ellipsizeDisplayText(title: string, maxDisplayUnits: number, ellipsis: string): string {
  const normalized = title.replace(/\s+/g, ' ').trim();
  if (!normalized) return title;
  if (displayUnits(normalized) <= maxDisplayUnits) return normalized;

  const ellipsisUnits = displayUnits(ellipsis);
  const contentMaxUnits = Math.max(1, maxDisplayUnits - ellipsisUnits);
  let currentUnits = 0;
  let result = '';

  for (const char of normalized) {
    const nextUnits = currentUnits + displayUnits(char);
    if (nextUnits > contentMaxUnits) break;
    currentUnits = nextUnits;
    result += char;
  }

  return `${result.trimEnd()}${ellipsis}`;
}

function displayUnits(text: string): number {
  let units = 0;
  for (const char of text) units += isWideCharacter(char) ? 2 : 1;
  return units;
}

function isWideCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0;
  return codePoint >= 0x1f300 || /[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char);
}
