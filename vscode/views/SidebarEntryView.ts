import * as vscode from 'vscode';
import { MainPanel, type MainPanelOptions } from '../panels/MainPanel';
import { getUnavailableWebviewHtml, getWebviewHtml } from '../webview/getWebviewHtml';
import type { ApplicationFacade, ConversationHistoryRevealTarget } from '../ApplicationFacade';
import type { ApplicationStartup } from '../ApplicationStartup';
import { EXTENSION_BRAND, SIDEBAR_ENTRY_VIEW_ID } from '../../shared/extensionIdentity';
import { isConversationDeleteIncompleteError } from '../../backend/application/reliableKernel/conversationDeleteCommand';
import { toStructuredClonePlainData } from '../../shared/plainData';
import type {
  ConversationHistoryPageRecord,
  ConversationHistoryScope,
  OpenConversationPanelRecord,
  ProjectFolderCandidateRecord,
  SidebarHistoryScopeKind
} from '../../shared/protocol';

const OPEN_CONVERSATION_MESSAGE = 'openConversation';
const NEW_CONVERSATION_MESSAGE = 'newConversation';
const OPEN_GLOBAL_SETTINGS_MESSAGE = 'openGlobalSettings';
const OPEN_WORKFLOW_SETTINGS_MESSAGE = 'openWorkflowSettings';
const OPEN_AGENT_SETTINGS_MESSAGE = 'openAgentSettings';
const HISTORY_PAGE_GET_MESSAGE = 'sidebar.historyPage.get';
const SIDEBAR_STATE_MESSAGE = 'sidebar.state';
const SIDEBAR_READY_MESSAGE = 'sidebar.ready';
const RENAME_CONVERSATION_MESSAGE = 'renameConversation';
const DELETE_CONVERSATION_MESSAGE = 'deleteConversation';
const ABORT_CONVERSATION_MESSAGE = 'abortConversation';
const CONVERSATION_OPERATION_RESULT_MESSAGE = 'sidebar.conversationOperation.result';

type SidebarConversationOperation = 'delete' | 'abort';

interface SidebarWebviewMessage {
  type?: string;
  conversationId?: string;
  title?: string;
  projectFolderUri?: string;
  scopeKind?: SidebarHistoryScopeKind;
  cursor?: string;
  limit?: number;
  requestId?: string;
  turnId?: string;
  leaseGeneration?: string;
}

interface SidebarStateMessage {
  type: typeof SIDEBAR_STATE_MESSAGE;
  history: ConversationHistoryPageRecord;
  activeScopeKind: SidebarHistoryScopeKind;
  activeProjectFolderUri?: string;
  currentProjectScope: ConversationHistoryScope;
  projectFolders: ProjectFolderCandidateRecord[];
  openConversations: OpenConversationPanelRecord[];
}

export function registerSidebarEntryView(context: vscode.ExtensionContext, startup: ApplicationStartup): void {
  const provider = new SidebarEntryViewProvider(context.extensionUri, startup);

  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(SIDEBAR_ENTRY_VIEW_ID, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      }
    })
  );
  context.subscriptions.push(MainPanel.onDidChangeConversationPanelState(() => provider.refreshOpenConversationPanelStates()));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => provider.refreshWorkspaceContext()));
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => provider.refreshWorkspaceContext()));
}

export function registerUnavailableSidebarEntryView(
  context: vscode.ExtensionContext,
  message: string
): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SIDEBAR_ENTRY_VIEW_ID, {
      resolveWebviewView(webviewView) {
        webviewView.webview.options = { enableScripts: false };
        webviewView.webview.html = getUnavailableWebviewHtml(message);
      }
    })
  );
}

class SidebarEntryViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private lastScopeKind: SidebarHistoryScopeKind = 'currentProject';
  private lastProjectFolderUri: string | undefined;
  private lastCursor: string | undefined;
  private activeWebview: vscode.Webview | undefined;
  private historyRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private historyRequestSeq = 0;
  private lastStateMessage: SidebarStateMessage | undefined;
  private backendApp: ApplicationFacade | undefined;
  private historySubscription: vscode.Disposable | undefined;
  private historyRevealSubscription: vscode.Disposable | undefined;
  private unavailableMessage: string | undefined;
  private disposed = false;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly startup: ApplicationStartup
  ) {}

  public attachApplication(backendApp: ApplicationFacade): void {
    if (this.disposed) return;
    this.backendApp = backendApp;
    this.historySubscription?.dispose();
    this.historySubscription = backendApp.onDidChangeConversationHistory(() => this.refreshConversationHistory());
    this.historyRevealSubscription?.dispose();
    this.historyRevealSubscription = backendApp.onDidRevealConversationHistoryTop(
      (target) => this.revealConversationHistoryTop(target)
    );
  }

  private async application(): Promise<ApplicationFacade> {
    try {
      const backendApp = await this.startup.wait();
      if (this.backendApp !== backendApp) this.attachApplication(backendApp);
      return backendApp;
    } catch (error) {
      this.renderUnavailable(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  public renderUnavailable(message: string): void {
    this.unavailableMessage = message;
    const target = this.activeWebview;
    if (!target) return;
    target.options = { enableScripts: false };
    target.html = getUnavailableWebviewHtml(message);
  }

  public dispose(): void {
    this.disposed = true;
    if (this.historyRefreshTimer !== undefined) clearTimeout(this.historyRefreshTimer);
    this.historyRefreshTimer = undefined;
    this.historySubscription?.dispose();
    this.historySubscription = undefined;
    this.historyRevealSubscription?.dispose();
    this.historyRevealSubscription = undefined;
    this.activeWebview = undefined;
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.activeWebview = webviewView.webview;
    webviewView.onDidDispose(() => {
      if (this.activeWebview === webviewView.webview) this.activeWebview = undefined;
    });

    if (this.unavailableMessage) {
      webviewView.webview.options = { enableScripts: false };
      webviewView.webview.html = getUnavailableWebviewHtml(this.unavailableMessage);
      return;
    }

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')
      ]
    };

    webviewView.webview.onDidReceiveMessage((message: SidebarWebviewMessage) => {
      if (message.type === OPEN_CONVERSATION_MESSAGE && message.conversationId) {
        this.openConversationFromSidebar(webviewView.webview, message.conversationId, message.title);
        return;
      }

      if (message.type === NEW_CONVERSATION_MESSAGE) {
        this.createConversationFromSidebar(webviewView.webview, message.projectFolderUri);
        return;
      }

      if (message.type === OPEN_GLOBAL_SETTINGS_MESSAGE) {
        this.openPanelFromSidebar({ kind: 'globalSettings', reuse: true });
        return;
      }

      if (message.type === OPEN_WORKFLOW_SETTINGS_MESSAGE) {
        this.openPanelFromSidebar({ kind: 'workflowSettings', reuse: true });
        return;
      }

      if (message.type === OPEN_AGENT_SETTINGS_MESSAGE) {
        this.openPanelFromSidebar({ kind: 'agentSettings', reuse: true });
        return;
      }

      if (message.type === RENAME_CONVERSATION_MESSAGE && message.conversationId && typeof message.title === 'string') {
        this.renameConversationFromSidebar(webviewView.webview, message.conversationId, message.title);
        return;
      }

      if (message.type === DELETE_CONVERSATION_MESSAGE && message.conversationId) {
        this.deleteConversationFromSidebar(webviewView.webview, message.conversationId);
        return;
      }

      if (
        message.type === ABORT_CONVERSATION_MESSAGE
        && message.conversationId
        && message.requestId
        && message.turnId
        && message.leaseGeneration
      ) {
        this.abortConversationFromSidebar(
          webviewView.webview,
          message.conversationId,
          message.requestId,
          message.turnId,
          message.leaseGeneration
        );
        return;
      }

      if (message.type === SIDEBAR_READY_MESSAGE) {
        this.postSidebarStateWhenReady(webviewView.webview, 'currentProject');
        return;
      }

      if (message.type === HISTORY_PAGE_GET_MESSAGE) {
        this.postSidebarStateWhenReady(webviewView.webview, message.scopeKind ?? 'currentProject', message.cursor, message.limit, message.projectFolderUri);
      }
    });

    webviewView.webview.html = getWebviewHtml(webviewView.webview, this.extensionUri, {
      htmlFileName: 'sidebar.html',
      devEntry: '/src/sidebar/main.ts',
      title: `${EXTENSION_BRAND} Sidebar`,
      rootId: 'sidebar-app'
    });
  }

  public refreshConversationHistory(): void {
    this.scheduleConversationHistoryRefresh();
  }

  public refreshOpenConversationPanelStates(): void {
    const target = this.activeWebview;
    if (!target) return;
    if (!this.lastStateMessage) {
      this.scheduleConversationHistoryRefresh();
      return;
    }
    const message = this.withLivePanelState(this.lastStateMessage);
    this.lastStateMessage = message;
    void postSidebarWebviewMessage(target, message);
  }

  /**
   * This window just created, forked or refreshed a Conversation (see ConversationHistoryRevealTarget).
   * When it belongs to the shown scope, the next refresh reads the first page, where that
   * Conversation now sits. Other projects' activity leaves a project page untouched.
   */
  private revealConversationHistoryTop(target: ConversationHistoryRevealTarget): void {
    const scope = this.lastStateMessage?.history.scope;
    if (scope && !conversationHistoryScopeContains(scope, target.projectFolderUri)) return;
    this.lastCursor = undefined;
    // Discard an in-flight page read so it cannot restore the previous page's cursor.
    this.historyRequestSeq += 1;
    this.scheduleConversationHistoryRefresh();
  }

  public refreshWorkspaceContext(): void {
    // A current-project cursor is scoped to the previously active folder. Reset it before resolving
    // the new active editor/workspace folder so an opaque tree cursor cannot cross project scopes.
    if (this.lastScopeKind === 'currentProject') {
      this.lastCursor = undefined;
      this.lastProjectFolderUri = undefined;
    }
    this.historyRequestSeq += 1;
    this.scheduleConversationHistoryRefresh();
  }

  private postSidebarStateWhenReady(webview: vscode.Webview, scopeKind: SidebarHistoryScopeKind = 'currentProject', cursor?: string, limit?: number, projectFolderUri?: string): Promise<void> {
    this.activeWebview = webview;
    const requestSeq = ++this.historyRequestSeq;
    return this.postSidebarState(webview, scopeKind, cursor, limit, projectFolderUri, requestSeq)
      .catch((error) => {
        console.warn('[LimCode] Failed to read sidebar state.', error);
        this.renderUnavailable(error instanceof Error ? error.message : String(error));
      });
  }

  private scheduleConversationHistoryRefresh(): void {
    if (this.historyRefreshTimer !== undefined) clearTimeout(this.historyRefreshTimer);
    this.historyRefreshTimer = setTimeout(() => {
      this.historyRefreshTimer = undefined;
      const target = this.activeWebview;
      if (!target) return;
      this.postSidebarStateWhenReady(target, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
    }, 180);
  }

  private openConversationFromSidebar(webview: vscode.Webview, conversationId: string, title?: string): void {
    void this.application().then(async (backendApp) => {
      if (!await backendApp.conversationExists(conversationId)) {
        this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
        void vscode.window.showWarningMessage(`${EXTENSION_BRAND}: 该对话已被删除或不再存在。`);
        return;
      }
      // A peer-owned Conversation reports its refusal inside createOrShow without affecting the
      // sidebar or any other Conversation.
      void MainPanel.createOrShow(this.extensionUri, backendApp, {
        conversationId,
        title,
        reuse: true
      });
    }).catch((error) => console.warn('[LimCode] Failed to open sidebar conversation.', error));
  }

  private openPanelFromSidebar(options: MainPanelOptions): void {
    void this.application().then(
      (backendApp) => void MainPanel.createOrShow(this.extensionUri, backendApp, options),
      (error) => console.warn('[LimCode] Failed to open sidebar panel.', error)
    );
  }

  private createConversationFromSidebar(webview: vscode.Webview, projectFolderUri?: string): void {
    void this.application()
      .then((backendApp) => backendApp.createConversation({ projectFolderUri }).then((conversationId) => ({ backendApp, conversationId })))
      .then(({ backendApp, conversationId }) => {
        void MainPanel.createOrShow(this.extensionUri, backendApp, { conversationId });
        this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
      })
      .catch((error) => console.warn('[LimCode] Failed to create sidebar conversation.', error));
  }

  private renameConversationFromSidebar(webview: vscode.Webview, conversationId: string, title: string): void {
    const nextTitle = title.trim();
    if (!nextTitle) return;

    void this.application()
      .then(async (backendApp) => {
        await backendApp.waitUntilHydrated();
        const renamed = await backendApp.renameConversationTitle(conversationId, nextTitle);
        if (!renamed) console.warn(`[LimCode] Sidebar rename target not found: ${conversationId}`);
        else MainPanel.refreshConversationTitle(conversationId);
        this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
      })
      .catch((error) => console.warn('[LimCode] Failed to rename sidebar conversation.', error));
  }

  private deleteConversationFromSidebar(webview: vscode.Webview, conversationId: string): void {
    void (async () => {
      try {
        const backendApp = await this.application();
        // Null: the conversation no longer exists (another window deleted it meanwhile), which is
        // what the user asked for.
        const deletedConversationIds = await backendApp.deleteConversation(conversationId) ?? [conversationId];
        for (const deletedConversationId of deletedConversationIds) {
          MainPanel.closePanelsByConversationId(deletedConversationId);
        }
        await this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
        await this.postConversationOperationResult(webview, 'delete', conversationId, true, undefined, { deletedConversationIds });
      } catch (error) {
        const message = error instanceof Error ? error.message : '删除对话失败。';
        console.warn('[LimCode] Failed to delete sidebar conversation.', error);
        await this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
        // Work that did not stop in time is not a refusal: the stop requests stay, deleting again completes.
        const incomplete = isConversationDeleteIncompleteError(error);
        await this.postConversationOperationResult(webview, 'delete', conversationId, false, message,
          incomplete ? { severity: 'warning' } : {});
        if (incomplete) void vscode.window.showWarningMessage(`${EXTENSION_BRAND}：${message}`);
        else void vscode.window.showErrorMessage(`${EXTENSION_BRAND}: ${message}`);
      }
    })();
  }

  private abortConversationFromSidebar(
    webview: vscode.Webview,
    conversationId: string,
    requestId: string,
    turnId: string,
    leaseGeneration: string
  ): void {
    void (async () => {
      try {
        const backendApp = await this.application();
        const outcome = await backendApp.abortConversation(conversationId, requestId, {
          turnId,
          leaseGeneration
        });
        await this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
        const ok = outcome.status !== 'stale';
        const message = outcome.status === 'already_satisfied'
          ? outcome.reason === 'target_turn_already_terminal'
            ? '目标回合已经结束；未影响后续排队任务。'
            : '当前对话没有正在执行的回合。'
          : outcome.status === 'stale'
            ? `中断目标状态已变化：${outcome.reason ?? 'turn_not_current'}`
            : undefined;
        await this.postConversationOperationResult(webview, 'abort', conversationId, ok, message, {
          requestId,
          status: outcome.status,
          ...(outcome.turnId ? { turnId: outcome.turnId } : {})
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : '终止后台任务失败。';
        console.warn('[LimCode] Failed to abort sidebar conversation.', error);
        await this.postSidebarStateWhenReady(webview, this.lastScopeKind, this.lastCursor, undefined, this.lastProjectFolderUri);
        await this.postConversationOperationResult(webview, 'abort', conversationId, false, message, { requestId });
        void vscode.window.showErrorMessage(`${EXTENSION_BRAND}: ${message}`);
      }
    })();
  }

  private async postConversationOperationResult(
    webview: vscode.Webview,
    operation: SidebarConversationOperation,
    conversationId: string,
    ok: boolean,
    message?: string,
    details: {
      requestId?: string;
      status?: 'committed' | 'already_applied' | 'already_satisfied' | 'stale';
      runId?: string;
      deletedConversationIds?: string[];
      severity?: 'warning';
    } = {}
  ): Promise<void> {
    try {
      await postSidebarWebviewMessage(webview, {
        type: CONVERSATION_OPERATION_RESULT_MESSAGE,
        operation,
        conversationId,
        ok,
        ...details,
        ...(message ? { message } : {})
      });
    } catch (error) {
      console.warn('[LimCode] Failed to post sidebar operation result.', error);
    }
  }

  private async postSidebarState(webview: vscode.Webview, scopeKind: SidebarHistoryScopeKind, cursor?: string, limit?: number, projectFolderUri?: string, requestSeq = this.historyRequestSeq): Promise<void> {
    this.lastScopeKind = scopeKind;
    this.lastProjectFolderUri = projectFolderUri;
    this.lastCursor = cursor;
    const backendApp = await this.application();
    const history = await backendApp.getConversationHistoryPage({ scopeKind, projectFolderUri, cursor, limit });
    if (requestSeq !== this.historyRequestSeq) {
      return;
    }
    // Later refreshes re-send the page the backend actually resolved (clamped or re-positioned).
    this.lastCursor = history.pageInfo.cursor;
    const activeProjectFolderUri = projectFolderUri
      ?? (history.scope.kind === 'project' ? history.scope.folderUri : undefined);
    const message: SidebarStateMessage = this.withLivePanelState({
      type: SIDEBAR_STATE_MESSAGE,
      history,
      activeScopeKind: scopeKind,
      ...(activeProjectFolderUri ? { activeProjectFolderUri } : {}),
      currentProjectScope: backendApp.getCurrentProjectHistoryScope(),
      projectFolders: backendApp.getProjectFolderCandidates(),
      openConversations: []
    }, backendApp);
    this.lastStateMessage = message;
    await postSidebarWebviewMessage(webview, message);
  }

  private withLivePanelState(message: SidebarStateMessage, backendApp = this.backendApp): SidebarStateMessage {
    if (!backendApp) return message;
    return {
      ...message,
      currentProjectScope: backendApp.getCurrentProjectHistoryScope(),
      projectFolders: backendApp.getProjectFolderCandidates(),
      openConversations: MainPanel.getOpenConversationPanelStates()
    };
  }
}

function conversationHistoryScopeContains(scope: ConversationHistoryScope, projectFolderUri: string | undefined): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'unbound') return projectFolderUri === undefined;
  return scope.folderUri === projectFolderUri;
}

function postSidebarWebviewMessage(webview: vscode.Webview, message: unknown): Thenable<boolean> {
  return webview.postMessage(toStructuredClonePlainData(message, 'sidebar webview message'));
}
