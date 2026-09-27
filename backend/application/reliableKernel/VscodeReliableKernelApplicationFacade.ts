import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { StorageDataResetResult } from '../../capabilities/types';
import { mapSettledWithBoundedConcurrency } from '../../capabilities/boundedConcurrency';
import {
  loadCommittedGlobalStatus, normalizeStatusDataRootPath, resolveDataRootUri, sameFsPath, updateGlobalStatusDataRoot
} from '../../capabilities/vscodeStorage/globalStatus';
import { createVscodeStoragePaths, type StoragePaths } from '../../capabilities/vscodeStorage/paths';
import { RUNTIME_KERNEL_EPOCH, createRuntimeRootPaths, type RuntimeRootPaths } from '../../reliableKernel/contracts';
import { listAllDomainRows } from '../../reliableKernel/repositoryPagination';
import { assertDataRootAvailable, ensureDataRootIdentity } from '../../reliableKernel/runtimeDataRootRelocation';
import type { ContentObjectMetadata } from '../../reliableKernel/contentAddressedStore';
import { projectFolderAssignmentSteps } from '../../reliableKernel/conversationProject';
import { DOMAIN_REPOSITORIES, type DomainRow } from '../../reliableKernel/repositories';
import {
  createVscodeRootAuthority,
  completeVscodeRuntimeDataSetSelection,
  assertConfigurationRootRuntimesOffline,
  selectVscodeRuntimeDataSet,
  resolveVscodeWorkspaceRuntimePlacement,
  resolveVscodeWorkspaceRuntimeScope,
  type VscodeWorkspaceRuntimePlacement
} from '../../reliableKernel/vscodeRootAuthority';
import type { RootBinding, RuntimeCommitResult } from '../../reliableKernel/contracts';
import type { ConversationHistoryPageBoundary as HistoryPageBoundary } from '../../reliableKernel/databaseWorkerProtocol';
import {
  assertRuntimeHostsOffline,
  openUnderCurrentDataRootAdmission,
  withRuntimeDataRootAdmission,
  withRuntimeMaintenance,
  type RuntimeClaimWait
} from '../../reliableKernel/runtimeHostControl';
import {
  DEFAULT_CONVERSATION_TITLE,
  displayConversationTitle
} from '../../../shared/conversationTitle';
import { BridgeMessageType } from '../../../shared/protocol';
import { EXTENSION_BRAND, EXTENSION_COMMAND_IDS } from '../../../shared/extensionIdentity';
import { STOP_WAITS_FOR_EXECUTING_WINDOW_MESSAGE } from './conversationHostEligibility';
import { toStructuredClonePlainData } from '../../../shared/plainData';
import type {
  BridgeClientId,
  ConversationForkPayload,
  ConversationHistoryPageRecord,
  ConversationHistoryScope,
  ConversationOriginLinkRecord,
  ExtensionToWebviewMessage,
  GlobalSettingsSection,
  ProjectFolderCandidateRecord,
  SidebarConversationHistoryEntry,
  SidebarHistoryScopeKind,
  WebviewClientMeta,
  WebviewToExtensionMessage
} from '../../../shared/protocol';
import type {
  ApplicationFacade,
  ConversationAbortResult,
  ConversationAbortTarget,
  ConversationForkResult,
  ConversationHistoryRevealTarget,
  ConversationRecoveryResult
} from '../../../vscode/ApplicationFacade';
import { VscodeReliableKernelCommandRouter } from './VscodeReliableKernelCommandRouter';
import {
  VscodeReliableKernelCutoverCoordinator,
  archiveCurrentRuntimeRootForReset
} from './VscodeReliableKernelCutoverCoordinator';
import { pinnedDataRootPaths, VscodeReliableKernelProductRuntime } from './VscodeReliableKernelProductRuntime';
import { ReliableConversationLifecycle } from './conversationLifecycle';
import { ExternalDataVersionWatcher } from './ExternalDataVersionWatcher';
import {
  InteractionAttentionNotifier,
  InteractionLeaseEdgeTracker,
  readPendingInteractionAttention,
  runtimeCommitNeedsInteractionAttention
} from './interactionAttention';
import {
  conversationHistoryPreviewFromBytes,
  conversationHistoryTitleContentFromBytes,
  projectChildConversationHistory
} from './conversationHistoryProjection';

const HISTORY_CACHE_LIMIT = 512;
const HISTORY_CONTENT_READ_CONCURRENCY = 4;
const DEFAULT_HISTORY_PAGE_SIZE = 50;
const INTERACTION_ATTENTION_REFRESH_DELAY_MS = 25;


/** VS Code shell facade backed only by the reliable SQLite/CAS Runtime and independent settings authority. */
export class VscodeReliableKernelApplicationFacade implements ApplicationFacade {
  private readonly historyEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeConversationHistory = this.historyEmitter.event;
  private readonly historyRevealEmitter = new vscode.EventEmitter<ConversationHistoryRevealTarget>();
  public readonly onDidRevealConversationHistoryTop = this.historyRevealEmitter.event;

  private readonly webviews = new Map<BridgeClientId, vscode.Webview>();
  /** Attach-meta Conversation binding per client; a feed may never retarget beyond it. */
  private readonly webviewConversationIds = new Map<BridgeClientId, string>();
  private readonly commandRouter: VscodeReliableKernelCommandRouter;
  private readonly externalHistoryWatcher: ExternalDataVersionWatcher;
  private readonly interactionAttentionNotifier: InteractionAttentionNotifier;
  private readonly interactionLeaseEdges: InteractionLeaseEdgeTracker;
  private historyEntries: SidebarConversationHistoryEntry[] = [];
  private originLinks: ConversationOriginLinkRecord[] = [];
  private readonly historyPreviewByRevisionId = new Map<string, string>();
  private readonly historyTitleByRevisionId = new Map<string, string>();
  private historyRefresh: Promise<void> | undefined;
  private historyRefreshPending = false;
  private historyRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private interactionAttentionRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private hydration: Promise<void> | undefined;
  private unsubscribeCommit: (() => void) | undefined;
  private unsubscribeSteering: (() => void) | undefined;
  private disposed = false;
  private productClosed = false;
  private dataRootMovedWarned = false;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    public readonly product: VscodeReliableKernelProductRuntime,
    private readonly getPaths: () => StoragePaths,
    private readonly runtimePlacement: VscodeWorkspaceRuntimePlacement
  ) {
    this.interactionAttentionNotifier = new InteractionAttentionNotifier({
      showInformationMessage: (message, action) => vscode.window.showInformationMessage(message, action),
      openConversation: ({ conversationId, conversationTitle }) => vscode.commands.executeCommand(
        EXTENSION_COMMAND_IDS.openPanel,
        {
          conversationId,
          ...(conversationTitle ? { title: conversationTitle } : {}),
          reuse: true
        }
      ),
      onError: (error) => console.warn('[LimCode] Failed to notify pending user interaction.', error)
    });
    this.interactionLeaseEdges = new InteractionLeaseEdgeTracker(product.application.database.hostBootId);
    this.commandRouter = new VscodeReliableKernelCommandRouter(product, {
      broadcast: (message) => this.broadcast(message),
      postToConversation: (conversationId, message) =>
        this.product.application.webviewFeed.postToConversation(conversationId, { ...message }),
      createConversation: (options) => this.createConversation(options),
      forkConversation: (request) => this.forkConversation(request),
      onConversationInputAccepted: (conversationId) => this.revealConversationHistoryTop(conversationId),
      conversationIdForClient: (clientId) => this.webviewConversationIds.get(clientId)
    });
    this.externalHistoryWatcher = new ExternalDataVersionWatcher(
      () => product.application.database.externalDataVersion(),
      () => this.refreshConversationHistory(),
      {
        onError: (error) => {
          console.error('[LimCode] Cross-host conversation history refresh failed.', error);
        }
      }
    );
    this.unsubscribeCommit = product.application.database.onCommit((commit) => this.onRuntimeCommit(commit));
    this.unsubscribeSteering = product.application.modelProvider.subscribeSteering((update) => {
      this.broadcast({
        id: randomUUID(),
        type: BridgeMessageType.TurnSteerResult,
        channel: 'control',
        payload: {
          conversationId: update.conversationId,
          receipts: update.receipts,
          ...(update.commandId ? { commandId: update.commandId } : {}),
          ...(update.error ? { error: update.error } : {})
        }
      });
    });
  }

  /**
   * `onRuntimeWait` reports a long wait on the data-root admission or the scope maintenance claim
   * (another window migrating the data directory, merging, or opening), with the holder's published
   * activity, so the window can say why; the wait itself never ends early.
   */
  public static async open(
    context: vscode.ExtensionContext,
    options: { onRuntimeWait?(wait: RuntimeClaimWait): void } = {}
  ): Promise<VscodeReliableKernelApplicationFacade> {
    const wait = options.onRuntimeWait ? { onWait: options.onRuntimeWait } : undefined;
    const getPaths = (): StoragePaths => createVscodeStoragePaths(resolveDataRootUri(context));
    let facade: VscodeReliableKernelApplicationFacade | undefined;
    // The data-root admission serializes placement/cutover across every workspace scope sharing
    // this configuration root. It is acquired before placement resolution and the scope
    // maintenance claim nests inside it; both lock orders (open and reset) agree.
    return openUnderCurrentDataRootAdmission(async () => {
      const status = await loadCommittedGlobalStatus(context);
      const root = getPaths().globalStoragePath;
      // A configured directory (VS Code's own storage excepted) must exist and hold LimCode data:
      // placement would otherwise create an empty history on an unmounted drive or lost share.
      if (normalizeStatusDataRootPath(context, status.dataRootPath)) await assertDataRootAvailable(root, status.dataRootId);
      return root;
    }, async () => {
      await recordDataRootIdentity(context);
      const runtimePlacement = await resolveVscodeWorkspaceRuntimePlacement(
        getPaths(),
        resolveVscodeWorkspaceRuntimeScope({
          workspaceFileUri: vscode.workspace.workspaceFile?.toString(),
          workspaceFolderUris: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString())
        })
      );
      const authority = createVscodeRootAuthority(runtimePlacement);
      // Root preparation and Runtime open share one short maintenance claim with the database
      // worker-ready + Host liveness registration, so a peer open or reset cannot interleave.
      const product = await withRuntimeMaintenance(authority.expectedPaths(), async () => {
        const rootPreparation = await new VscodeReliableKernelCutoverCoordinator(
          authority,
          runtimePlacement.runtimeScopeRootPath
        ).ensureCurrentRoot();
        if (rootPreparation.epochMigrationBackupPath) {
          console.info(
            `[LimCode] 已将第 ${rootPreparation.epochMigratedFrom} 代运行数据无损升级到第 ${RUNTIME_KERNEL_EPOCH} 代；`
            + `升级前 SQLite 备份：${rootPreparation.epochMigrationBackupPath}。`
          );
        }
        await completeVscodeRuntimeDataSetSelection(getPaths());
        return VscodeReliableKernelProductRuntime.open(context, {
          authority, runtimePlacement,
          onConfigurationChanged: async () => {
            await facade?.commandRouter.refreshConfiguration();
            await facade?.refreshConversationHistory();
          }
        });
      }, wait);
      facade = new VscodeReliableKernelApplicationFacade(
        context, product, pinnedDataRootPaths(context, runtimePlacement.configurationRootPath), runtimePlacement
      );
      return facade;
    }, undefined, wait);
  }

  /** Starts the history/watcher hydration after VS Code surfaces have been registered. */
  public startHydration(): Promise<void> {
    this.requireOpen();
    if (this.hydration) return this.hydration;
    this.hydration = (async () => {
      // Baseline external writer state before the initial history snapshot. A racing commit is then
      // discovered by the watcher instead of being lost between initialization and polling.
      await this.externalHistoryWatcher.start();
      if (this.disposed) return;
      await this.refreshConversationHistory();
      if (this.disposed) return;
      await this.refreshInteractionAttention();
      if (this.disposed) return;
      if (this.historyEntries.length === 0) await this.createConversation();
    })();
    // Lazy callers may only need a scoped page and intentionally do not await the global cache
    // hydration. Keep a failure observed while preserving the rejecting Promise for commands that
    // require the complete history cache.
    void this.hydration.catch((error) => {
      if (!this.disposed) console.error('[LimCode] Conversation history hydration failed.', error);
    });
    return this.hydration;
  }

  public startRuntimeRecovery(): ReturnType<VscodeReliableKernelProductRuntime['startRecovery']> {
    this.requireOpen();
    return this.product.startRecovery();
  }

  public async createConversation(options: { projectFolderUri?: string } = {}): Promise<string> {
    this.requireOpen();
    const conversationId = runtimeId('conversation');
    const agent = await this.product.configuration.resolveAgent({ agentType: 'main' });
    const now = new Date().toISOString();
    const projectFolder = this.resolveProjectFolderForNewConversation(options.projectFolderUri);
    // The new Conversation is owned only for this write; passive views do not keep the writer.
    // The owner idle-releases once the transaction and pending-work probe complete.
    await this.product.application.database.conversationOwners.run(conversationId, async () => {
      await this.product.application.database.transaction([
        DOMAIN_REPOSITORIES.domain('Conversation').insert({
          id: conversationId,
          title: DEFAULT_CONVERSATION_TITLE,
          status: 'active',
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
          id: runtimeId('agent_conversation_link'),
          conversation_id: conversationId,
          agent_id: agent.agentId,
          role: 'default',
          created_at: now,
          updated_at: now
        }),
        ...(projectFolder
          ? projectFolderAssignmentSteps({
              conversationId,
              folder: { uri: projectFolder.uri.toString(), name: projectFolder.name },
              now
            })
          : [])
      ]);
      await this.refreshConversationHistory();
    });
    this.historyRevealEmitter.fire({
      conversationId,
      ...(projectFolder ? { projectFolderUri: projectFolder.uri.toString() } : {})
    });
    return conversationId;
  }

  public async forkConversation(request: ConversationForkPayload): Promise<ConversationForkResult> {
    this.requireOpen();
    const result = await this.conversationLifecycle().fork({
      sourceConversationId: request.sourceConversationId,
      messageId: request.messageId,
      expectedRevisionId: request.expectedRevisionId,
      commandId: requireText(request.command?.commandId, 'Conversation fork commandId')
    });
    await this.refreshConversationHistory();
    await this.revealConversationHistoryTop(result.conversationId);
    return result;
  }

  /** Tells the sidebar this window just acted on a Conversation, with its primary project for scoping. */
  private async revealConversationHistoryTop(conversationId: string): Promise<void> {
    try {
      const [link] = await this.list('ConversationProjectLink', { conversation_id: conversationId, role: 'primary' }, 1);
      const project = link ? await this.maybeRow('ProjectContext', requireText(link.project_context_id, 'ConversationProjectLink.project_context_id')) : null;
      if (this.disposed) return;
      this.historyRevealEmitter.fire({
        conversationId,
        ...(project ? { projectFolderUri: requireText(project.uri, 'ProjectContext.uri') } : {})
      });
    } catch (error) {
      console.warn('[LimCode] Failed to reveal the acted-on Conversation in history.', error);
    }
  }

  /** The stateless lifecycle service shared with model tools; it never posts to a webview. */
  private conversationLifecycle(): ReliableConversationLifecycle {
    return new ReliableConversationLifecycle(this.product);
  }

  public waitUntilHydrated(): Promise<void> {
    return this.startHydration();
  }

  public async conversationExists(conversationId: string): Promise<boolean> {
    this.requireOpen();
    return !!await this.maybeRow('Conversation', conversationId);
  }

  /** Passive views may recover a definitely dead owner, but never hold ownership themselves. */
  public recoverConversation(conversationId: string): Promise<ConversationRecoveryResult> {
    this.requireOpen();
    return this.product.recoverConversation(conversationId);
  }

  public getConversationDisplayTitle(conversationId: string | undefined): string {
    if (!conversationId) return DEFAULT_CONVERSATION_TITLE;
    const entry = this.historyEntries.find((candidate) => candidate.id === conversationId);
    return displayConversationTitle({ id: conversationId, title: entry?.title });
  }

  public async renameConversationTitle(conversationId: string, title: string): Promise<boolean> {
    this.requireOpen();
    return this.product.application.database.conversationOwners.run(conversationId, async () => {
      const existing = await this.maybeRow('Conversation', conversationId);
      if (!existing) return false;
      const normalized = title.trim();
      if (!normalized) throw new TypeError('Conversation 标题不能为空。');
      await this.product.application.database.transaction([
        DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, {
          title: normalized,
          updated_at: new Date().toISOString()
        })
      ]);
      await this.refreshConversationHistory();
      return true;
    });
  }

  public async deleteConversation(conversationId: string): Promise<string[] | null> {
    this.requireOpen();
    // The deletion control plane additionally pins every cascaded descendant before its
    // transaction; this requested-id run is the facade boundary guard.
    const deleted = await this.product.application.database.conversationOwners.run(conversationId, () =>
      this.product.application.conversationDeletion.delete(conversationId)
    );
    if (!deleted) return null;
    await this.refreshConversationHistory();
    return deleted.deletedConversationIds;
  }

  public async abortConversation(
    conversationId: string,
    requestId: string,
    target: ConversationAbortTarget
  ): Promise<ConversationAbortResult> {
    this.requireOpen();
    // A stop is a fenced durable request, not a second writer for the peer-owned Turn.
    const turnId = requireText(target.turnId, 'abort target Turn.id');
    const expectedLeaseGeneration = requireDecimal(target.leaseGeneration, 'abort target lease generation');
    const turn = await this.maybeRow('Turn', turnId);
    if (!turn || turn.conversation_id !== conversationId) {
      return { status: 'stale', reason: 'target_turn_not_current', turnId };
    }
    if (turn.status === 'terminated') {
      return { status: 'already_satisfied', reason: 'target_turn_already_terminal', turnId };
    }
    if (turn.status !== 'active') return { status: 'stale', reason: 'target_turn_not_active', turnId };
    const leases = await this.list('ExecutionLease', { turn_id: turnId }, 2);
    if (leases.length !== 1 || requireBigInt(leases[0].generation, 'ExecutionLease.generation') !== BigInt(expectedLeaseGeneration)) {
      return { status: 'stale', reason: 'lease_generation_replaced', turnId };
    }
    try {
      const childMemberships = await this.list('ChildExecutionTurnLink', { turn_id: turnId }, 2);
      if (childMemberships.length > 1) throw new Error('Turn 存在多个 ChildExecution 调度归属。');
      if (childMemberships[0]) {
        const interrupted = await this.product.childAgents.interruptSubtree({
          sourceKey: `sidebar-child-interrupt:${requestId}`,
          childExecutionId: requireText(
            childMemberships[0].child_execution_id,
            'ChildExecutionTurnLink.child_execution_id'
          ),
          reason: '用户从侧栏请求递归终止当前子 Agent。'
        }, { userStop: true });
        if (interrupted?.executingWindowAlive) {
          void vscode.window.showInformationMessage(`${EXTENSION_BRAND}：${STOP_WAITS_FOR_EXECUTING_WINDOW_MESSAGE}`);
        }
      } else {
        const interrupted = await this.product.conversations.interrupt({
          commandId: requestId,
          conversationId,
          turnId,
          expectedLeaseGeneration,
          reason: '用户从侧栏请求终止当前 Conversation。'
        });
        if (interrupted?.executingWindowAlive) {
          void vscode.window.showInformationMessage(`${EXTENSION_BRAND}：${STOP_WAITS_FOR_EXECUTING_WINDOW_MESSAGE}`);
        }
      }
      return { status: 'committed', turnId };
    } catch (error) {
      const turn = await this.maybeRow('Turn', turnId);
      if (turn?.status === 'terminated') {
        return { status: 'already_satisfied', reason: 'target_turn_already_terminal', turnId };
      }
      throw error;
    }
  }

  public getConversationHistoryEntries(): SidebarConversationHistoryEntry[] {
    return this.historyEntries.map((entry) => ({ ...entry }));
  }

  public async getConversationHistoryPage(input: {
    scopeKind: SidebarHistoryScopeKind;
    projectFolderUri?: string;
    cursor?: string;
    limit?: number;
  }): Promise<ConversationHistoryPageRecord> {
    // Start global cache/watcher hydration, but let the requested visible page take its own bounded
    // read path immediately. Waiting for the all-conversation page here serialized two projections
    // (and up to two batches of CAS preview reads) before the sidebar could paint its first page.
    void this.startHydration().catch(() => undefined);
    const scope = this.resolveHistoryScope(input.scopeKind, input.projectFolderUri);
    const limit = normalizePageSize(input.limit);
    const page = await this.queryConversationHistoryPage(scope, input.cursor, limit);
    this.mergeHistoryCache(page.entries, page.originLinks);
    return page;
  }

  public getCurrentProjectHistoryScope(): ConversationHistoryScope {
    const folder = this.currentWorkspaceFolder();
    return folder ? { kind: 'project', folderUri: folder.uri.toString() } : { kind: 'all' };
  }

  public getProjectFolderCandidates(): ProjectFolderCandidateRecord[] {
    return (vscode.workspace.workspaceFolders ?? []).map((folder, index) => ({
      uri: folder.uri.toString(),
      name: folder.name,
      index
    }));
  }

  public getStorageRootUri(): vscode.Uri {
    return resolveDataRootUri(this.context);
  }

  public async refreshGlobalSettings(section: GlobalSettingsSection): Promise<void> {
    this.requireOpen();
    await this.commandRouter.refreshGlobalSettings(section);
    if (section === 'common') this.warnIfDataRootMoved();
  }

  /**
   * Another window switched the data-root pointer while this one still runs on the old directory
   * (e.g. back to the old directory while this one was unreachable): configuration paths are pinned
   * and refuse (pinnedDataRootPaths), and the user is asked once to reload.
   */
  private warnIfDataRootMoved(): void {
    if (this.dataRootMovedWarned || this.disposed) return;
    const current = resolveDataRootUri(this.context).fsPath;
    if (sameFsPath(current, this.runtimePlacement.configurationRootPath)) return;
    this.dataRootMovedWarned = true;
    void vscode.window.showWarningMessage(
      `${EXTENSION_BRAND} 数据目录已在其它窗口切换到 ${current}。本窗口仍在使用原来的目录，设置暂时不能修改，请重载窗口。`,
      '重载窗口'
    ).then((choice) => {
      if (choice) void vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
  }

  public async resetDevelopmentData(): Promise<StorageDataResetResult> {
    this.requireOpen();
    const storageRoot = this.runtimePlacement.runtimeScopeRootPath;

    const authority = createVscodeRootAuthority(this.runtimePlacement);
    const controlRootName = path.basename(path.dirname(authority.expectedPaths().rootPointerPath));
    // Lock order matches open: data-root admission first, scope maintenance inside. An opening
    // Host holds admission while waiting on the scope claim, so taking them in the same order
    // here cannot deadlock; reverse order could.
    return withRuntimeDataRootAdmission(this.runtimePlacement.configurationRootPath, () =>
      withRuntimeMaintenance(authority.expectedPaths(), async () => {
        // Peer windows on this data root must close before this Host stops its own writers. The
        // preflight exempts only this Host's own liveness record and never steals a live/unknown peer.
        await assertRuntimeHostsOffline(authority.expectedPaths(), this.product.application.database.hostBootId);
        this.unsubscribeCommit?.();
        this.unsubscribeCommit = undefined;
        this.unsubscribeSteering?.();
        this.unsubscribeSteering = undefined;
        this.productClosed = true;
        await this.product.close();
        // The gated archive/reinitialize rechecks (without exemption) that every Host, including
        // this one, has deregistered before mutating the control root.
        const archive = await archiveCurrentRuntimeRootForReset(authority, storageRoot);
        await new VscodeReliableKernelCutoverCoordinator(authority, storageRoot).ensureCurrentRoot();
        return {
          dataRootPath: storageRoot,
          epoch: RUNTIME_KERNEL_EPOCH,
          archivedEntries: archive.archived ? [controlRootName] : [],
          ...(archive.backupPath ? { backupPath: archive.backupPath } : {})
        };
      })
    );
  }

  public async inspectReliability(conversationId?: string): Promise<unknown> {
    this.requireOpen();
    const database = await this.product.application.database.inspect();
    return {
      runtime: {
        dataSetId: this.product.application.database.binding.dataSetId,
        rootInstanceId: this.product.application.database.binding.rootInstanceId,
        rootGeneration: this.product.application.database.binding.rootGeneration,
        pointerRevision: this.product.application.database.binding.pointerRevision,
        runtimeKernelEpoch: this.product.application.database.binding.runtimeKernelEpoch
      },
      database,
      recovery: this.product.recoveryState(),
      diagnostics: await this.product.diagnostics.inspect({ scopeId: conversationId, limit: 200 }),
      ...(conversationId ? {
        conversation: await this.maybeRow('Conversation', conversationId),
        activeLeases: await this.list('ExecutionLease', { conversation_id: conversationId }, 10),
        turns: await this.list('Turn', { conversation_id: conversationId }, 200)
      } : {})
    };
  }

  /** Native command confirmation precedes this offline switch; callers reload the window after it. */
  public async selectRuntimeDataSet(id: string): Promise<void> {
    this.requireOpen();
    const paths = this.getPaths();
    await withRuntimeDataRootAdmission(paths.globalStoragePath, async () => {
      await assertConfigurationRootRuntimesOffline(paths.globalStoragePath, this.product.application.database.hostBootId);
      await this.dispose();
      await selectVscodeRuntimeDataSet(this.getPaths(), id);
    });
  }

  public attachWebview(webview: vscode.Webview, meta: WebviewClientMeta = { kind: 'unknown' }): BridgeClientId {
    this.requireOpen();
    const clientId = this.product.application.webviewFeed.attach(webview, meta);
    this.webviews.set(clientId, webview);
    if (meta.conversationId?.trim()) this.webviewConversationIds.set(clientId, meta.conversationId.trim());
    return clientId;
  }

  public setWebviewVisible(clientId: BridgeClientId, visible: boolean): void {
    this.product.application.webviewFeed.setVisible(clientId, visible);
  }

  public detachWebview(clientId: BridgeClientId): void {
    this.commandRouter.detachClient(clientId);
    this.webviews.delete(clientId);
    this.webviewConversationIds.delete(clientId);
    this.product.application.webviewFeed.detach(clientId);
  }

  public handleWebviewMessage(clientId: BridgeClientId, message: WebviewToExtensionMessage): void {
    const webview = this.webviews.get(clientId);
    if (!webview) return;
    this.commandRouter.handle(clientId, webview, message);
  }

  public handleReliableKernelControl(clientId: BridgeClientId, message: unknown): Promise<boolean> {
    return this.product.application.webviewFeed.handleControl(clientId, message);
  }

  /** Root and Host identity used by cooperative exclusive maintenance on the selected data set. */
  public exclusiveMaintenanceTarget(): { paths: RuntimeRootPaths; hostBootId: string } {
    this.requireOpen();
    return {
      paths: createRuntimeRootPaths(this.runtimePlacement.runtimeDataRootPath),
      hostBootId: this.product.application.database.hostBootId
    };
  }

  /**
   * True while a reload of this window would interrupt work: an ExecutionLease of this Host, a
   * command or run in progress (an activity pin), or any durable pending work of a conversation it
   * owns — queued input, undelivered deliveries and wakes, a pending answer delivery, background
   * processes. The owner manager keeps a conversation exactly while that probe reports work.
   */
  public async hasOwnedExecution(): Promise<boolean> {
    this.requireOpen();
    const database = this.product.application.database;
    if ((await listAllDomainRows(database, 'ExecutionLease', { host_boot_id: database.hostBootId })).length > 0) return true;
    for (const { conversationId, pinned } of database.conversationOwners.ownedActivity()) {
      if (pinned || await database.hasConversationRuntimeWork(conversationId)) return true;
    }
    return false;
  }

  /** The configuration root this window's Runtime was opened under (data-directory commands). */
  public dataRootPath(): string {
    return this.runtimePlacement.configurationRootPath;
  }

  /**
   * The locks of an offline data-directory change, in the order open and reset take them: the
   * configuration admission, then the selected root's maintenance claim. Cooperative exclusive
   * maintenance calls this only for its short locked round (withLocks).
   */
  public withDataRootLocks<R>(body: () => Promise<R>): Promise<R> {
    this.requireOpen();
    const { paths } = this.exclusiveMaintenanceTarget();
    return withRuntimeDataRootAdmission(this.runtimePlacement.configurationRootPath, () => withRuntimeMaintenance(paths, body));
  }

  /** Closes this window's Runtime before an offline data-directory change; the window reloads afterwards. */
  public async closeRuntime(): Promise<void> {
    await this.dispose();
  }

  /** One Webview client only (e.g. the confirmation of a data-directory command); false when it is gone. */
  public postToWebview(clientId: BridgeClientId, message: ExtensionToWebviewMessage): boolean {
    if (this.disposed || !this.webviews.has(clientId)) return false;
    this.broadcast(message, clientId);
    return true;
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.historyRefreshTimer !== undefined) clearTimeout(this.historyRefreshTimer);
    this.historyRefreshTimer = undefined;
    if (this.interactionAttentionRefreshTimer !== undefined) clearTimeout(this.interactionAttentionRefreshTimer);
    this.interactionAttentionRefreshTimer = undefined;
    this.interactionAttentionNotifier.clear();
    this.unsubscribeCommit?.();
    this.unsubscribeCommit = undefined;
    this.unsubscribeSteering?.();
    this.unsubscribeSteering = undefined;
    this.externalHistoryWatcher.cancel();
    // Host handoff must not wait behind a projection read which the old Host no longer needs.
    // Closing the product below rejects/settles ordinary database work; keep rejection observed.
    void this.hydration?.catch(() => undefined);
    void this.historyRefresh?.catch(() => undefined);
    for (const clientId of [...this.webviews.keys()]) this.detachWebview(clientId);
    this.historyEmitter.dispose();
    this.historyRevealEmitter.dispose();
    if (!this.productClosed) {
      this.productClosed = true;
      await this.product.close();
    }
  }

  private onRuntimeCommit(commit: RuntimeCommitResult): void {
    if (this.disposed) return;
    const leaseAcquired = this.interactionLeaseEdges.observe(commit);
    if (leaseAcquired || runtimeCommitNeedsInteractionAttention(commit)) this.scheduleInteractionAttentionRefresh();
    if (!commit.changes.some((change) => [
      'Conversation',
      'Turn',
      'ExecutionLease',
      'Message',
      'ConversationOriginLink',
      'AgentConversationLink',
      'ProjectContext',
      'ConversationProjectLink',
      'ChildExecution',
      'ChildExecutionActiveTurnLink',
      'AnswerBridge',
      'RuntimeInboxItem',
      'RuntimeDelivery',
      'RuntimeDeliveryWake',
      // markInputHandled() advances only these two domains. Observing both prevents the sidebar
      // from remaining on “等待主 Agent 接收” after the exact delivery input was consumed.
      'RuntimeDeliveryInputLink',
      'PendingTurnInput'
    ].includes(change.domain))) return;
    if (this.historyRefreshTimer !== undefined) clearTimeout(this.historyRefreshTimer);
    this.historyRefreshTimer = setTimeout(() => {
      this.historyRefreshTimer = undefined;
      void this.refreshConversationHistory().catch((error) => {
        console.error('[LimCode] Reliable conversation history refresh failed.', error);
      });
    }, 25);
  }

  private scheduleInteractionAttentionRefresh(): void {
    if (this.interactionAttentionRefreshTimer !== undefined) {
      clearTimeout(this.interactionAttentionRefreshTimer);
    }
    this.interactionAttentionRefreshTimer = setTimeout(() => {
      this.interactionAttentionRefreshTimer = undefined;
      void this.refreshInteractionAttention().catch((error) => {
        console.warn('[LimCode] Pending user interaction refresh failed.', error);
      });
    }, INTERACTION_ATTENTION_REFRESH_DELAY_MS);
  }

  /** Only the Host holding the owner Turn's ExecutionLease announces a pending ASK/Plan. */
  private async refreshInteractionAttention(): Promise<void> {
    const database = this.product.application.database;
    const pending = await readPendingInteractionAttention(database, database.hostBootId);
    if (this.disposed) return;
    this.interactionAttentionNotifier.synchronize(pending);
  }

  private refreshConversationHistory(): Promise<void> {
    if (this.historyRefresh) {
      // A commit may arrive while CAS-backed previews are still being read. Remember that edge so
      // the exact delivery/handled state cannot remain stuck at the older snapshot indefinitely.
      this.historyRefreshPending = true;
      return this.historyRefresh;
    }
    this.historyRefresh = (async () => {
      do {
        this.historyRefreshPending = false;
        await this.readConversationHistory();
      } while (this.historyRefreshPending && !this.disposed);
    })()
      .finally(() => { this.historyRefresh = undefined; });
    return this.historyRefresh;
  }

  private async readConversationHistory(): Promise<void> {
    const page = await this.queryConversationHistoryPage({ kind: 'all' }, undefined, DEFAULT_HISTORY_PAGE_SIZE);
    this.historyEntries = page.entries;
    this.originLinks = page.originLinks;
    this.historyEmitter.fire();
  }

  private async queryConversationHistoryPage(
    scope: ConversationHistoryScope,
    cursor: string | undefined,
    limit: number
  ): Promise<ConversationHistoryPageRecord> {
    const scopeKey = conversationHistoryScopeKey(scope);
    const dataSetKey = historyCursorDataSetKey(this.product.application.database.binding);
    const position = decodeHistoryPageCursor(cursor, scopeKey, limit, dataSetKey);
    // One bounded read: the worker positions the page by number against current facts and clamps
    // a page emptied by deletions to the current last page.
    const projection = await this.product.application.database.conversationHistoryProjection({
      scopeKind: scope.kind,
      ...(scope.kind === 'project' ? { projectFolderUri: scope.folderUri } : {}),
      limit,
      pageIndex: position.pageIndex,
      ...(position.boundary ? { boundary: position.boundary } : {})
    });
    const messageCounts = new Map(projection.messageSummaries.map((row) => [
      String(row.conversation_id),
      Number(row.message_count)
    ]));
    const projectedTitles = await this.readConversationHistoryProjectionTitles(projection.titleTargets);
    const previews = await this.readConversationHistoryProjectionPreviews(projection.previewTargets);
    const activeTurnByConversation = new Map(
      projection.turns.filter((row) => row.status === 'active').map((row) => [String(row.conversation_id), row])
    );
    const leaseByTurn = new Map(projection.leases.map((row) => [String(row.turn_id), row]));
    const agentNames = new Map((await this.product.configuration.agents()).map((agent) => [agent.id, agent.name]));
    const defaultAgentByConversation = new Map(projection.agentLinks
      .filter((row) => row.role === 'default')
      .map((row) => [String(row.conversation_id), String(row.agent_id)]));
    const projectContextById = new Map(projection.projectContexts.map((row) => [String(row.id), row]));
    const projectByConversation = new Map(projection.conversationProjectLinks
      .filter((row) => row.role === 'primary')
      .flatMap((row) => {
        const project = projectContextById.get(String(row.project_context_id));
        return project ? [[String(row.conversation_id), project] as const] : [];
      }));
    const entries = projection.conversations.map((row): SidebarConversationHistoryEntry => {
      const id = requireText(row.id, 'Conversation.id');
      const messageCount = messageCounts.get(id) ?? 0;
      const childProjection = projectChildConversationHistory(id, {
        turns: projection.turns,
        leases: projection.leases,
        childExecutions: projection.childExecutions,
        activeTurnLinks: projection.activeChildTurnLinks,
        answerBridges: projection.answerBridges,
        inboxItems: projection.inboxItems,
        deliveries: projection.deliveries,
        deliveryWakes: projection.deliveryWakes,
        deliveryInputLinks: projection.deliveryInputLinks
      });
      const activeTurn = activeTurnByConversation.get(id);
      const activeLease = activeTurn ? leaseByTurn.get(String(activeTurn.id)) : undefined;
      const running = childProjection?.isRunning ?? activeTurn !== undefined;
      const agentId = defaultAgentByConversation.get(id);
      const preview = previews.get(id);
      const projectedTitle = projectedTitles.get(id);
      const project = projectByConversation.get(id);
      return {
        id,
        title: displayConversationTitle({
          id,
          title: String(row.title),
          ...(projectedTitle ? {
            messages: [{
              role: 'user',
              content: { role: 'user', parts: [{ text: projectedTitle }] }
            }]
          } : {})
        }),
        preview: messageCount === 0 ? '' : preview ?? '消息内容暂不可用',
        ...(messageCount === 0
          ? { previewState: 'empty' as const }
          : preview === undefined ? { previewState: 'pending' as const } : {}),
        messageCount,
        status: messageCount > 0 ? 'final' : 'empty',
        createdAt: timestampMs(row.created_at),
        updatedAt: timestampMs(row.updated_at),
        ...(agentId && agentNames.get(agentId) ? { agentName: agentNames.get(agentId) } : {}),
        ...(project ? {
          projectFolderUri: requireText(project.uri, 'ProjectContext.uri'),
          projectName: requireText(project.name, 'ProjectContext.name')
        } : {}),
        isRunning: running,
        ...(running && activeTurn && activeLease ? {
          activeTurnId: requireText(activeTurn.id, 'Turn.id'),
          executionLeaseGeneration: requireBigInt(
            activeLease.generation,
            'ExecutionLease.generation'
          ).toString()
        } : {}),
        ...(childProjection ? { runState: childProjection.state } : running ? { runState: 'running' as const } : {}),
        ...(childProjection?.runStatusLabel
          ? { runStatusLabel: childProjection.runStatusLabel }
          : running ? { runStatusLabel: '执行中' } : {})
      };
    });
    const originLinks = projection.origins.map(conversationOriginLink);
    const pageIndex = projection.pageIndex;
    const firstSeed = projection.seedRows[0];
    const lastSeed = projection.seedRows.at(-1);
    const boundary = (kind: HistoryPageBoundary['kind'], row: DomainRow | undefined): HistoryPageBoundary | undefined =>
      row ? { kind, updatedAt: requireText(row.updated_at, 'Conversation.updated_at'), id: requireText(row.id, 'Conversation.id') } : undefined;
    const currentCursor = encodeHistoryPageCursor(scopeKey, limit, dataSetKey, {
      pageIndex,
      boundary: boundary('from', firstSeed)
    });
    const nextCursor = projection.hasMore
      ? encodeHistoryPageCursor(scopeKey, limit, dataSetKey, { pageIndex: pageIndex + 1, boundary: boundary('after', lastSeed) })
      : undefined;
    const previousCursor = pageIndex > 0
      ? encodeHistoryPageCursor(scopeKey, limit, dataSetKey, { pageIndex: pageIndex - 1, boundary: boundary('before', firstSeed) })
      : undefined;
    return {
      scope,
      entries,
      originLinks,
      pageInfo: {
        cursor: currentCursor,
        ...(nextCursor ? { nextCursor } : {}),
        ...(previousCursor ? { previousCursor } : {}),
        pageIndex,
        pageSize: limit,
        total: projection.total,
        hasNext: Boolean(nextCursor),
        hasPrevious: Boolean(previousCursor)
      }
    };
  }

  private async readConversationHistoryProjectionPreviews(
    targets: Array<{ conversationId: string; revisionId: string; content: DomainRow }>
  ): Promise<Map<string, string>> {
    const previews = new Map<string, string>();
    const unresolved = targets.filter((target) => {
      const cached = this.historyPreviewByRevisionId.get(target.revisionId);
      if (cached === undefined) return true;
      previews.set(target.conversationId, cached);
      return false;
    });
    const settled = await mapSettledWithBoundedConcurrency(
      unresolved,
      HISTORY_CONTENT_READ_CONCURRENCY,
      (target) => this.product.application.contentStore.read(target.content as unknown as ContentObjectMetadata)
    );
    settled.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      const target = unresolved[index];
      if (!target) return;
      const preview = conversationHistoryPreviewFromBytes(result.value, String(target.content.content_type));
      if (preview === undefined) return;
      previews.set(target.conversationId, preview);
      this.historyPreviewByRevisionId.set(target.revisionId, preview);
    });
    while (this.historyPreviewByRevisionId.size > HISTORY_CACHE_LIMIT * 2) {
      const oldestRevisionId = this.historyPreviewByRevisionId.keys().next().value as string | undefined;
      if (!oldestRevisionId) break;
      this.historyPreviewByRevisionId.delete(oldestRevisionId);
    }
    return previews;
  }

  private async readConversationHistoryProjectionTitles(
    targets: Array<{ conversationId: string; revisionId: string; content: DomainRow }>
  ): Promise<Map<string, string>> {
    const titles = new Map<string, string>();
    const unresolved = targets.filter((target) => {
      const cached = this.historyTitleByRevisionId.get(target.revisionId);
      if (cached === undefined) return true;
      titles.set(target.conversationId, cached);
      return false;
    });
    const settled = await mapSettledWithBoundedConcurrency(
      unresolved,
      HISTORY_CONTENT_READ_CONCURRENCY,
      (target) => this.product.application.contentStore.read(target.content as unknown as ContentObjectMetadata)
    );
    settled.forEach((result, index) => {
      if (result.status !== 'fulfilled') return;
      const target = unresolved[index];
      if (!target) return;
      const content = conversationHistoryTitleContentFromBytes(
        result.value,
        String(target.content.content_type)
      );
      if (!content) return;
      const title = displayConversationTitle({
        id: target.conversationId,
        messages: [{ role: 'user', content }]
      });
      titles.set(target.conversationId, title);
      this.historyTitleByRevisionId.set(target.revisionId, title);
    });
    while (this.historyTitleByRevisionId.size > HISTORY_CACHE_LIMIT * 2) {
      const oldestRevisionId = this.historyTitleByRevisionId.keys().next().value as string | undefined;
      if (!oldestRevisionId) break;
      this.historyTitleByRevisionId.delete(oldestRevisionId);
    }
    return titles;
  }

  private mergeHistoryCache(
    entries: SidebarConversationHistoryEntry[],
    origins: ConversationOriginLinkRecord[]
  ): void {
    const entryIds = new Set(entries.map((entry) => entry.id));
    this.historyEntries = [
      ...entries.map((entry) => ({ ...entry })),
      ...this.historyEntries.filter((entry) => !entryIds.has(entry.id))
    ].slice(0, HISTORY_CACHE_LIMIT);
    const originIds = new Set(origins.map((origin) => origin.id));
    this.originLinks = [
      ...origins.map((origin) => ({ ...origin })),
      ...this.originLinks.filter((origin) => !originIds.has(origin.id))
    ].slice(0, HISTORY_CACHE_LIMIT * 2);
  }

  private resolveHistoryScope(kind: SidebarHistoryScopeKind, folderUri?: string): ConversationHistoryScope {
    if (kind === 'currentProject') return this.getCurrentProjectHistoryScope();
    if (kind === 'project' && folderUri?.trim()) {
      return { kind: 'project', folderUri: canonicalFolderUri(folderUri) };
    }
    if (kind === 'all') return { kind: 'all' };
    return { kind: 'unbound' };
  }

  private resolveProjectFolderForNewConversation(folderUriInput?: string): vscode.WorkspaceFolder | undefined {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folderUriInput?.trim()) {
      const folderUri = canonicalFolderUri(folderUriInput);
      const folder = folders.find((candidate) => candidate.uri.toString() === folderUri);
      if (!folder) throw new Error('新对话指定的项目不属于当前 VS Code 工作区。');
      return folder;
    }
    return folders.length === 1 ? folders[0] : undefined;
  }

  private currentWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    const activeDocument = vscode.window.activeTextEditor?.document.uri;
    const activeFolder = activeDocument ? vscode.workspace.getWorkspaceFolder(activeDocument) : undefined;
    if (activeFolder) return activeFolder;
    const folders = vscode.workspace.workspaceFolders ?? [];
    return folders.length === 1 ? folders[0] : undefined;
  }

  private async maybeRow(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.product.application.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).get(id)
    ]);
    const row = snapshot.snapshot[0];
    return row && !Array.isArray(row) ? row : null;
  }

  private async requireRow(domain: string, id: string): Promise<DomainRow> {
    const row = await this.maybeRow(domain, id);
    if (!row) throw new Error(`${domain} ${id} 不存在。`);
    return row;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.product.application.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    return requireRows(snapshot.snapshot[0], `${domain} list`);
  }

  /** Every broadcast is a bridge message of the shared protocol, including its channel; `onlyClientId` narrows it to one client. */
  private broadcast(message: ExtensionToWebviewMessage, onlyClientId?: BridgeClientId): void {
    const plain = toStructuredClonePlainData(message, 'reliable configuration broadcast');
    for (const [clientId, webview] of this.webviews) {
      if (onlyClientId !== undefined && clientId !== onlyClientId) continue;
      void webview.postMessage(plain).then(undefined, (error) => {
        console.warn('[LimCode] Reliable configuration broadcast failed.', error);
      });
    }
  }

  private requireOpen(): void {
    if (this.disposed || this.productClosed) throw new Error('可靠 ApplicationFacade 已关闭。');
  }
}

function runtimeId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

function requireRows(value: DomainRow | DomainRow[] | null, label: string): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} 未返回数组。`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} 必须是非空字符串。`);
  return value.trim();
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${label} 必须保持 SQLite INTEGER。`);
  return value;
}

function requireDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new TypeError(`${label} 必须是正十进制整数。`);
  }
  return value;
}

function timestampMs(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePageSize(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) return DEFAULT_HISTORY_PAGE_SIZE;
  return Math.min(200, value!);
}

function conversationHistoryScopeKey(scope: ConversationHistoryScope): string {
  return scope.kind === 'project' ? `project:${scope.folderUri}` : scope.kind;
}

interface HistoryPagePosition {
  pageIndex: number;
  boundary?: HistoryPageBoundary;
}

const FIRST_HISTORY_PAGE: HistoryPagePosition = { pageIndex: 0 };
const HISTORY_PAGE_BOUNDARY_KINDS: ReadonlySet<string> = new Set(['from', 'after', 'before']);

/**
 * History cursors name a page number plus the neighbouring (updated_at, id) key used only beyond
 * the exact page-number window. They are bound to the RootBinding identity: a cursor minted before a
 * data-set switch or root generation change starts again at the first page of the current data set.
 */
function historyCursorDataSetKey(binding: RootBinding): string {
  return `${binding.dataSetId}:${binding.rootInstanceId}:${binding.rootGeneration}`;
}

function encodeHistoryPageCursor(
  scopeKey: string,
  pageSize: number,
  dataSetKey: string,
  position: HistoryPagePosition
): string {
  return Buffer.from(JSON.stringify({
    kind: 'conversation-history-page',
    scopeKey,
    pageSize,
    dataSet: dataSetKey,
    pageIndex: position.pageIndex,
    ...(position.boundary ? { boundary: position.boundary } : {})
  }), 'utf8').toString('base64url');
}

function decodeHistoryPageCursor(
  cursor: string | undefined,
  scopeKey: string,
  pageSize: number,
  dataSetKey: string
): HistoryPagePosition {
  if (!cursor) return FIRST_HISTORY_PAGE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new TypeError('Conversation history cursor is malformed.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Conversation history cursor is malformed.');
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.kind !== 'conversation-history-page'
    || value.scopeKey !== scopeKey
    || value.pageSize !== pageSize
    || typeof value.dataSet !== 'string'
    || !Number.isSafeInteger(value.pageIndex)
    || (value.pageIndex as number) < 0
  ) {
    throw new TypeError('Conversation history cursor does not match the requested tree page.');
  }
  if (value.dataSet !== dataSetKey) return FIRST_HISTORY_PAGE;
  return {
    pageIndex: value.pageIndex as number,
    ...(value.boundary === undefined ? {} : { boundary: decodeHistoryPageBoundary(value.boundary) })
  };
}

function decodeHistoryPageBoundary(value: unknown): HistoryPageBoundary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Conversation history cursor boundary is malformed.');
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.kind !== 'string' || !HISTORY_PAGE_BOUNDARY_KINDS.has(record.kind)
    || typeof record.updatedAt !== 'string' || !record.updatedAt
    || typeof record.id !== 'string' || !record.id
  ) {
    throw new TypeError('Conversation history cursor boundary is malformed.');
  }
  return { kind: record.kind as HistoryPageBoundary['kind'], updatedAt: record.updatedAt, id: record.id };
}

function conversationOriginLink(row: DomainRow): ConversationOriginLinkRecord {
  const createdAt = timestampMs(row.created_at);
  return {
    id: String(row.id),
    conversationId: String(row.conversation_id),
    originKind: row.source_tool_call_id ? 'agent' : 'user',
    ...(row.source_conversation_id ? { sourceConversationId: String(row.source_conversation_id) } : {}),
    ...(row.source_tool_call_id ? { sourceToolCallId: String(row.source_tool_call_id) } : {}),
    createdAt,
    updatedAt: createdAt
  };
}


function canonicalFolderUri(value: string): string {
  const text = requireText(value, 'projectFolderUri');
  try {
    return vscode.Uri.parse(text, true).toString();
  } catch {
    throw new TypeError('projectFolderUri 必须是有效的 URI。');
  }
}

/**
 * A custom data directory set by an earlier version has no recorded identity yet. Its first normal
 * open records one (under the configuration admission, right after the directory passed the
 * structure check), so from then on only this very directory is accepted (assertDataRootAvailable).
 */
async function recordDataRootIdentity(context: vscode.ExtensionContext): Promise<void> {
  const status = await loadCommittedGlobalStatus(context);
  if (!normalizeStatusDataRootPath(context, status.dataRootPath) || status.dataRootId) return;
  const dataRootId = await ensureDataRootIdentity(resolveDataRootUri(context, status.dataRootPath).fsPath);
  await updateGlobalStatusDataRoot(context, { dataRootId, expectedDataRootPath: status.dataRootPath });
}
