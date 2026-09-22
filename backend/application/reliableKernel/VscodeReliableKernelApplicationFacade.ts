import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { StorageDataResetResult } from '../../capabilities/types';
import { mapSettledWithBoundedConcurrency } from '../../capabilities/boundedConcurrency';
import { loadCommittedGlobalStatus, resolveDataRootUri } from '../../capabilities/vscodeStorage/globalStatus';
import { createVscodeStoragePaths, type StoragePaths } from '../../capabilities/vscodeStorage/paths';
import { RUNTIME_KERNEL_EPOCH } from '../../reliableKernel/contracts';
import type { ContentObjectMetadata } from '../../reliableKernel/contentAddressedStore';
import { projectFolderAssignmentSteps } from '../../reliableKernel/conversationProject';
import { stablePhaseFId } from '../../reliableKernel/phaseFIdentity';
import { DOMAIN_REPOSITORIES, type DomainRow } from '../../reliableKernel/repositories';
import { readNativeSteeringInFlight } from '../../reliableKernel/nativeSteering';
import { ForkContextCandidateProbe, isNativeRequest, readNativeMessageContextRevisions } from '../../reliableKernel/conversationForkContext';
import { ConversationForkRejectedError } from '../../reliableKernel/conversationFork';
import {
  createVscodeRootAuthority,
  completeVscodeRuntimeDataSetSelection,
  assertConfigurationRootRuntimesOffline,
  selectVscodeRuntimeDataSet,
  resolveVscodeWorkspaceRuntimePlacement,
  resolveVscodeWorkspaceRuntimeScope,
  type VscodeWorkspaceRuntimePlacement
} from '../../reliableKernel/vscodeRootAuthority';
import type { RuntimeCommitResult } from '../../reliableKernel/contracts';
import {
  assertRuntimeHostsOffline,
  withRuntimeDataRootAdmission,
  withRuntimeMaintenance
} from '../../reliableKernel/runtimeHostControl';
import {
  DEFAULT_CONVERSATION_TITLE,
  displayConversationTitle
} from '../../../shared/conversationTitle';
import { BridgeMessageType } from '../../../shared/protocol';
import { EXTENSION_COMMAND_IDS } from '../../../shared/extensionIdentity';
import { toStructuredClonePlainData } from '../../../shared/plainData';
import type {
  BridgeClientId,
  ConversationForkPayload,
  ConversationHistoryPageRecord,
  ConversationHistoryScope,
  ConversationOriginLinkRecord,
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
  ConversationForkResult
} from '../../../vscode/ApplicationFacade';
import { VscodeReliableKernelCommandRouter } from './VscodeReliableKernelCommandRouter';
import {
  VscodeReliableKernelCutoverCoordinator,
  archiveCurrentRuntimeRootForReset
} from './VscodeReliableKernelCutoverCoordinator';
import { VscodeReliableKernelProductRuntime } from './VscodeReliableKernelProductRuntime';
import { ExternalDataVersionWatcher } from './ExternalDataVersionWatcher';
import {
  InteractionAttentionNotifier,
  runtimeCommitNeedsInteractionAttention,
  type InteractionAttentionKind,
  type PendingInteractionAttention
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

  private readonly webviews = new Map<BridgeClientId, vscode.Webview>();
  /** Attach-meta Conversation binding per client; a feed may never retarget beyond it. */
  private readonly webviewConversationIds = new Map<BridgeClientId, string>();
  private readonly commandRouter: VscodeReliableKernelCommandRouter;
  private readonly externalHistoryWatcher: ExternalDataVersionWatcher;
  private readonly interactionAttentionNotifier: InteractionAttentionNotifier;
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
    this.commandRouter = new VscodeReliableKernelCommandRouter(product, {
      broadcast: (message) => this.broadcast(message),
      postToConversation: (conversationId, message) =>
        this.product.application.webviewFeed.postToConversation(conversationId, message as Record<string, unknown>),
      createConversation: (options) => this.createConversation(options),
      forkConversation: (request) => this.forkConversation(request),
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

  public static async open(
    context: vscode.ExtensionContext
  ): Promise<VscodeReliableKernelApplicationFacade> {
    await loadCommittedGlobalStatus(context);
    const getPaths = (): StoragePaths => createVscodeStoragePaths(resolveDataRootUri(context));
    let facade: VscodeReliableKernelApplicationFacade | undefined;
    // The data-root admission serializes placement/cutover across every workspace scope sharing
    // this configuration root. It is acquired before placement resolution and the scope
    // maintenance claim nests inside it; both lock orders (open and reset) agree.
    return withRuntimeDataRootAdmission(path.resolve(getPaths().globalStoragePath), async () => {
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
        if (rootPreparation.epochResetBackupPath) {
          console.warn(
            `[LimCode] 已把第 ${rootPreparation.epochResetFrom} 代运行数据归档到 `
            + `${rootPreparation.epochResetBackupPath}，并创建第 ${RUNTIME_KERNEL_EPOCH} 代运行数据。`
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
      });
      facade = new VscodeReliableKernelApplicationFacade(context, product, getPaths, runtimePlacement);
      return facade;
    });
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
    // This Host owns the new Conversation from its first write. The opening view retains it
    // through claim-before-open; without a view the owner idle-releases after this run.
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
    return conversationId;
  }

  public async forkConversation(request: ConversationForkPayload): Promise<ConversationForkResult> {
    this.requireOpen();
    const sourceConversationId = requireText(request.sourceConversationId, 'Conversation fork sourceConversationId');
    // The source Conversation DAG/configuration is read and copied under its ownership pin so a
    // peer Host cannot mutate or delete it mid-fork.
    return this.product.application.database.conversationOwners.run(sourceConversationId, () =>
      this.forkConversationUnderOwnership(request)
    );
  }

  private async forkConversationUnderOwnership(request: ConversationForkPayload): Promise<ConversationForkResult> {
    const sourceConversationId = requireText(request.sourceConversationId, 'Conversation fork sourceConversationId');
    const messageId = requireText(request.messageId, 'Conversation fork messageId');
    const expectedRevisionId = requireText(request.expectedRevisionId, 'Conversation fork expectedRevisionId');
    const commandId = requireText(request.command?.commandId, 'Conversation fork commandId');
    const reuseKey = `conversation-fork-command:${commandId}`;

    // Replay is resolved from the immutable branch/reuse facts before consulting today's mutable
    // MessageCurrentRevisionLink. A lost result therefore remains replayable even if the source is
    // edited after the original fork committed.
    const existingReuse = await this.list('ConversationReuseLink', { reuse_key: reuseKey }, 2);
    if (existingReuse.length > 1) throw new Error('Conversation fork command identity is not unique.');
    if (existingReuse.length === 1) {
      const conversationId = requireText(existingReuse[0].conversation_id, 'ConversationReuseLink.conversation_id');
      const branches = await this.list('ConversationBranchLink', { target_conversation_id: conversationId }, 2);
      if (
        branches.length !== 1
        || branches[0].source_conversation_id !== sourceConversationId
        || branches[0].source_message_revision_id !== expectedRevisionId
      ) throw new Error('Conversation fork command was replayed with different source facts.');
      const revision = await this.requireRow('MessageRevision', expectedRevisionId);
      if (revision.message_id !== messageId) {
        throw new Error('Conversation fork command was replayed with a different source Message.');
      }
      // The replayed branch target may be owned by a peer window; its configuration copy runs
      // under the target ownership pin exactly like a fresh fork.
      await this.product.application.database.conversationOwners.run(conversationId, () =>
        this.product.configuration.mutations.copyConversationConfiguration(
          sourceConversationId,
          conversationId
        )
      );
      return { conversationId, deduplicated: true };
    }

    await this.requireRow('Conversation', sourceConversationId);
    const currentLinks = await this.list('MessageCurrentRevisionLink', { message_id: messageId }, 2);
    if (currentLinks.length !== 1) throw new Error('Fork 源 Message 缺少唯一当前 Revision。');
    const revisionId = requireText(currentLinks[0].revision_id, 'MessageCurrentRevisionLink.revision_id');
    if (revisionId !== expectedRevisionId) throw new Error('Fork 源 Message Revision 已变化，请基于当前内容重新创建分支。');
    const memberships = await this.list('MessagePartOfConversation', {
      conversation_id: sourceConversationId,
      message_id: messageId
    }, 2);
    if (memberships.length !== 1) throw new Error('Fork 源 Message 不属于当前 Conversation。');
    const turnLinks = (await this.product.application.database.snapshotAll(
      DOMAIN_REPOSITORIES.domain('MessageTurnLink').list({
        where: { message_id: messageId },
        orderBy: { column: 'id', direction: 'asc' },
        limit: 1000
      })
    )).snapshot;
    const sourceTurnIds = [...new Set(turnLinks.map((row) => requireText(row.turn_id, 'MessageTurnLink.turn_id')))];
    for (const turnId of sourceTurnIds) {
      const turn = await this.requireRow('Turn', turnId);
      if (turn.status !== 'terminated') {
        throw new ConversationForkRejectedError('分支点所在的轮次仍在运行，请等待本轮结束后再从这条消息创建分支。');
      }
    }
    const nativeSteering = await readNativeSteeringInFlight(this.product.application.database, sourceConversationId);
    if (nativeSteering.length > 0) {
      throw new Error('当前对话仍有未收口的原生转向，请等待完成后再创建分支。');
    }
    const nativeWork = await this.product.application.runtime.effects.listNativePendingWork({
      conversationId: sourceConversationId
    });
    for (const work of nativeWork) {
      if (work.turnActive || !work.settled || !work.callContextSegmentId || work.resultContextSegmentId) continue;
      await this.product.application.context.appendNativeToolResult({
        conversationId: sourceConversationId,
        toolCallId: work.toolCallId,
        toolModelResultId: requireText(work.toolModelResultId, 'NativePendingToolCall.toolModelResultId')
      });
    }
    await this.product.application.runtime.effects.assertNativeWorkSettledForConversation(sourceConversationId);
    const sources = await this.list('ContextSegmentSource', {
      source_kind: 'message_revision',
      source_id: revisionId
    }, 10);
    const sourceSegmentIds = new Set(sources.map((row) => requireText(row.segment_id, 'ContextSegmentSource.segment_id')));
    const revision = await this.requireRow('MessageRevision', revisionId);
    const requiredToolContext: Array<{ callSegmentId: string; resultSegmentId: string; native: boolean }> = [];
    let nativeMessageProjection = false;
    if (revision.role === 'model') {
      const requestLinks = await this.list('ModelRequestMessageLink', { message_id: messageId }, 2);
      if (requestLinks.length === 1) {
        const request = await this.requireRow('ModelRequest', requireText(requestLinks[0].model_request_id, 'ModelRequestMessageLink.model_request_id'));
        if (isNativeRequest(request)) {
          if (request.status !== 'terminal') throw new Error('原生模型消息尚未结束，请等待完整消息收口后再创建分支。');
          nativeMessageProjection = true;
          for (const item of await readNativeMessageContextRevisions(this.product.application.database, messageId)) {
            for (const source of item.sources) {
              sourceSegmentIds.add(requireText(source.segment_id, 'ContextSegmentSource.segment_id'));
            }
          }
        }
      }
      const callLinks = (await this.product.application.database.snapshotAll(
        DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').list({
          where: { message_id: messageId },
          orderBy: { column: 'id', direction: 'asc' },
          limit: 1000
        })
      )).snapshot.sort((left, right) =>
        compareBigInt(left.provider_ordinal, right.provider_ordinal) || String(left.id).localeCompare(String(right.id))
      );
      for (const callLink of callLinks) {
        const toolCallId = requireText(callLink.tool_call_id, 'ToolCallSourceLink.tool_call_id');
        const [callSources, results, nativeAdmission] = await Promise.all([
          this.list('ContextSegmentSource', { source_kind: 'tool_call', source_id: toolCallId }, 2),
          this.list('ToolModelResult', { tool_call_id: toolCallId }, 2),
          this.product.application.runtime.effects.readNativeAdmission(toolCallId)
        ]);
        if (callSources.length !== 1 || results.length !== 1) {
          throw new Error('Fork 源模型消息仍有未闭合工具调用，请等待工具完成后再创建分支。');
        }
        const resultSources = await this.list('ContextSegmentSource', {
          source_kind: 'tool_model_result',
          source_id: requireText(results[0].id, 'ToolModelResult.id')
        }, 2);
        if (resultSources.length !== 1
          || compareBigInt(callSources[0].source_revision, resultSources[0].source_revision) !== 0) {
          throw new Error('Fork 源工具结果尚未进入对应的 Context，请等待结果收口。');
        }
        const callSegmentId = requireText(callSources[0].segment_id, 'ContextSegmentSource.segment_id');
        const resultSegmentId = requireText(resultSources[0].segment_id, 'ContextSegmentSource.segment_id');
        if (!nativeAdmission && callSegmentId !== resultSegmentId) {
          throw new Error('Fork 源同步工具调用与结果没有组成原子 Context 工具对。');
        }
        requiredToolContext.push({ callSegmentId, resultSegmentId, native: nativeAdmission !== undefined });
        if (nativeAdmission) sourceSegmentIds.add(callSegmentId);
      }
    }
    if (sourceSegmentIds.size === 0) throw new Error('Fork 源 MessageRevision 尚未进入 Context DAG。');
    const roots = (await this.product.application.database.snapshotAll(
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').list({
        where: { conversation_id: sourceConversationId },
        orderBy: { column: 'id', direction: 'asc' },
        limit: 1000
      })
    )).snapshot.sort((left, right) =>
      compareBigInt(left.root_seq, right.root_seq) || String(left.id).localeCompare(String(right.id))
    );
    let sourceRootId: string | undefined;
    let sourceContextEndSegmentId: string | undefined;
    let sourceContextSegmentIds: string[] | undefined;
    const nativeContext = nativeMessageProjection || requiredToolContext.some((tool) => tool.native);
    // Prefer the newest context containing this boundary: an edit can leave the same assistant
    // revision in an older root whose preceding user revisions no longer match the transcript.
    const candidates = new ForkContextCandidateProbe(this.product.application.database, sourceSegmentIds);
    for (const root of [...roots].reverse()) {
      if (!await candidates.mayContain(root)) continue;
      const rootId = requireText(root.id, 'ContextSequenceRoot.id');
      const structure = await this.product.application.context.materializeStructure(rootId);
      const segmentIndexes = new Map(structure.records.map((record, index) => [String(record.segment.id), index]));
      let messageIndex = -1;
      for (const segmentId of sourceSegmentIds) {
        const index = segmentIndexes.get(segmentId);
        if (index === undefined) {
          messageIndex = -1;
          break;
        }
        messageIndex = Math.max(messageIndex, index);
      }
      let previousIndex = messageIndex;
      const containsClosedToolSuffix = messageIndex >= 0 && requiredToolContext.every((tool) => {
        const callIndex = segmentIndexes.get(tool.callSegmentId) ?? -1;
        const resultIndex = segmentIndexes.get(tool.resultSegmentId) ?? -1;
        if (nativeContext) {
          if (callIndex < 0 || resultIndex < callIndex) return false;
          previousIndex = Math.max(previousIndex, resultIndex);
          return true;
        }
        if (callIndex <= previousIndex || resultIndex !== callIndex) return false;
        previousIndex = resultIndex;
        return true;
      });
      if (messageIndex >= 0 && containsClosedToolSuffix) {
        sourceRootId = rootId;
        sourceContextEndSegmentId = requireText(structure.records[previousIndex].segment.id, 'ContextSegment.id');
        sourceContextSegmentIds = structure.records.slice(0, previousIndex + 1).map((record) =>
          requireText(record.segment.id, 'ContextSegment.id')
        );
        break;
      }
    }
    if (!sourceRootId || !sourceContextEndSegmentId || !sourceContextSegmentIds) {
      throw new Error('无法定位 Fork 源 MessageRevision 对应的 Context root。');
    }
    const sourceAttachmentCatalogState = await this.product.application.modelProvider.projectAttachmentCatalogState(
      sourceConversationId,
      sourceContextSegmentIds.map((segmentId) => ({ segmentId }))
    );
    await this.product.application.modelProvider.ensureAttachmentHandles(
      sourceConversationId,
      sourceAttachmentCatalogState.catalog
    );

    const agentLinks = await this.list('AgentConversationLink', {
      conversation_id: sourceConversationId,
      role: 'default'
    }, 2);
    if (agentLinks.length !== 1) throw new Error('Fork 源 Conversation 缺少唯一默认 Agent 关系。');
    // The branch target is claimed BEFORE its first write: this Host owns the new Conversation
    // through the fork transaction and the configuration copy. The id is derived from the fork
    // command identity so concurrent same-command calls deterministically claim the same target
    // (and a peer's claim refuses busy) instead of forking divergent targets. The opening view
    // retains it via claim-before-open; without a view the owner idle-releases after this run.
    const targetConversationId = stablePhaseFId('conversation', `conversation-fork:${commandId}`);
    const result = await this.product.application.database.conversationOwners.run(targetConversationId, async () => {
      const forkResult = await this.product.application.runtime.conversationFork.fork({
        idempotencyKey: commandId,
        reuseKey,
        sourceConversationId,
        sourceContextRootId: sourceRootId,
        sourceContextEndSegmentId,
        sourceMessageRevisionId: revisionId,
        expectedCurrentMessageRevisionId: revisionId,
        ...(sourceTurnIds.length === 1 ? { sourceTurnId: sourceTurnIds[0] } : {}),
        targetConversationId,
        targetTitle: `${this.getConversationDisplayTitle(sourceConversationId)} 分支`,
        targetAgentId: requireText(agentLinks[0].agent_id, 'AgentConversationLink.agent_id')
      });
      await this.product.configuration.mutations.copyConversationConfiguration(
        sourceConversationId,
        forkResult.targetConversationId
      );
      await this.refreshConversationHistory();
      return forkResult;
    });
    return { conversationId: result.targetConversationId, deduplicated: result.deduplicated };
  }

  public waitUntilHydrated(): Promise<void> {
    return this.startHydration();
  }

  public async conversationExists(conversationId: string): Promise<boolean> {
    this.requireOpen();
    return !!await this.maybeRow('Conversation', conversationId);
  }

  public async retainConversation(conversationId: string, referenceId: string): Promise<void> {
    this.requireOpen();
    const owners = this.product.application.database.conversationOwners;
    await owners.retain(conversationId, referenceId);
    try {
      // A peer Host may have died owning this Conversation; converging it here turns the open
      // into a takeover instead of a stale read-only view. The view reference stays held even
      // when recovery fails: background convergence/idle sweeps keep retrying, and every
      // mutation path still gates on ownership.
      await this.product.recoverConversation(conversationId);
    } catch (error) {
      console.warn('[LimCode] Scoped Conversation recovery after claim failed; the view remains owned.', error);
    }
  }

  public async releaseConversation(conversationId: string, referenceId: string): Promise<void> {
    // Dispose may race facade teardown; the owner manager closes with the database and releases
    // every reference, so a late release is a no-op rather than an error.
    if (this.disposed || this.productClosed) return;
    try {
      await this.product.application.database.conversationOwners.release(conversationId, referenceId);
    } catch (error) {
      console.warn('[LimCode] Failed to release Conversation ownership reference.', error);
    }
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
    return this.product.application.database.conversationOwners.run(conversationId, async () => {
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
          await this.product.childAgents.interruptSubtree({
            sourceKey: `sidebar-child-interrupt:${requestId}`,
            childExecutionId: requireText(
              childMemberships[0].child_execution_id,
              'ChildExecutionTurnLink.child_execution_id'
            ),
            reason: '用户从侧栏请求递归终止当前子 Agent。'
          });
        } else {
          await this.product.conversations.interrupt({
            commandId: requestId,
            conversationId,
            turnId,
            expectedLeaseGeneration,
            reason: '用户从侧栏请求终止当前 Conversation。'
          });
        }
        return { status: 'committed', turnId };
      } catch (error) {
        const turn = await this.maybeRow('Turn', turnId);
        if (turn?.status === 'terminated') {
          return { status: 'already_satisfied', reason: 'target_turn_already_terminal', turnId };
        }
        throw error;
      }
    });
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

  public refreshGlobalSettings(section: GlobalSettingsSection): Promise<void> {
    this.requireOpen();
    return this.commandRouter.refreshGlobalSettings(section);
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
    if (!this.productClosed) {
      this.productClosed = true;
      await this.product.close();
    }
  }

  private onRuntimeCommit(commit: RuntimeCommitResult): void {
    if (this.disposed) return;
    if (runtimeCommitNeedsInteractionAttention(commit)) this.scheduleInteractionAttentionRefresh();
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

  private async refreshInteractionAttention(): Promise<void> {
    const requests = await this.list('InteractionRequest', { status: 'pending' }, 1000);
    const resolved = await Promise.all(requests.map((request) => this.resolveInteractionAttention(request)));
    if (this.disposed) return;
    this.interactionAttentionNotifier.synchronize(
      resolved.filter((request): request is PendingInteractionAttention => request !== undefined)
    );
  }

  private async resolveInteractionAttention(
    request: DomainRow
  ): Promise<PendingInteractionAttention | undefined> {
    const kind = interactionAttentionKind(request.request_kind);
    if (!kind) return undefined;
    const requestId = requireText(request.id, 'InteractionRequest.id');
    const owners = await this.list('InteractionOwnerLink', { request_id: requestId }, 2);
    if (owners.length !== 1) return undefined;
    const turnId = requireText(owners[0].turn_id, 'InteractionOwnerLink.turn_id');
    if (kind === 'plan_review') {
      const childMemberships = await this.list('ChildExecutionTurnLink', { turn_id: turnId }, 1);
      if (childMemberships.length > 0) return undefined;
    }
    const turn = await this.maybeRow('Turn', turnId);
    if (!turn) return undefined;
    const conversationId = requireText(turn.conversation_id, 'Turn.conversation_id');
    const conversation = await this.maybeRow('Conversation', conversationId);
    if (!conversation) return undefined;
    const conversationTitle = displayConversationTitle({
      id: conversationId,
      title: typeof conversation.title === 'string' ? conversation.title : ''
    });
    return {
      requestId,
      kind,
      conversationId,
      conversationTitle,
      createdAt: timestampMs(request.created_at)
    };
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
    const decoded = decodeHistoryKeysetCursor(cursor, scopeKey, limit);
    const projection = await this.product.application.database.conversationHistoryProjection({
      scopeKind: scope.kind,
      ...(scope.kind === 'project' ? { projectFolderUri: scope.folderUri } : {}),
      limit,
      ...(decoded.anchor ? { afterUpdatedAt: decoded.anchor.updatedAt, afterId: decoded.anchor.id } : {}),
      ...(decoded.commitSeq ? { expectedCommitSeq: decoded.commitSeq } : {})
    });
    const state = projection.cursorReset ? emptyHistoryCursorState() : decoded;
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
    const lastSeed = projection.seedRows.at(-1);
    const currentCursor = encodeHistoryKeysetCursor(scopeKey, limit, {
      ...state,
      commitSeq: projection.snapshotCommitSeq
    });
    const nextCursor = projection.hasMore && lastSeed
      ? encodeHistoryKeysetCursor(scopeKey, limit, {
          commitSeq: projection.snapshotCommitSeq,
          anchor: { updatedAt: requireText(lastSeed.updated_at, 'Conversation.updated_at'), id: requireText(lastSeed.id, 'Conversation.id') },
          trail: [...state.trail, state.anchor]
        })
      : undefined;
    const previousAnchor = state.trail.at(-1) ?? null;
    const previousCursor = state.trail.length > 0
      ? encodeHistoryKeysetCursor(scopeKey, limit, {
          commitSeq: projection.snapshotCommitSeq,
          anchor: previousAnchor,
          trail: state.trail.slice(0, -1)
        })
      : undefined;
    return {
      scope,
      entries,
      originLinks,
      pageInfo: {
        cursor: currentCursor,
        ...(nextCursor ? { nextCursor } : {}),
        ...(previousCursor ? { previousCursor } : {}),
        pageIndex: state.trail.length,
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

  private broadcast(message: unknown): void {
    const plain = toStructuredClonePlainData(message, 'reliable configuration broadcast');
    for (const webview of this.webviews.values()) {
      void webview.postMessage(plain).then(undefined, (error) => {
        console.warn('[LimCode] Reliable configuration broadcast failed.', error);
      });
    }
  }

  private requireOpen(): void {
    if (this.disposed || this.productClosed) throw new Error('可靠 ApplicationFacade 已关闭。');
  }
}

function interactionAttentionKind(value: unknown): InteractionAttentionKind | undefined {
  return value === 'ask_user' || value === 'plan_review' ? value : undefined;
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

function compareBigInt(left: unknown, right: unknown): number {
  const leftValue = typeof left === 'bigint' ? left : BigInt(String(left));
  const rightValue = typeof right === 'bigint' ? right : BigInt(String(right));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
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

interface HistoryCursorAnchor { updatedAt: string; id: string }
interface HistoryCursorState {
  commitSeq?: string;
  anchor: HistoryCursorAnchor | null;
  trail: Array<HistoryCursorAnchor | null>;
}

function emptyHistoryCursorState(): HistoryCursorState {
  return { anchor: null, trail: [] };
}

function encodeHistoryKeysetCursor(scopeKey: string, pageSize: number, state: HistoryCursorState): string {
  return Buffer.from(JSON.stringify({
    kind: 'conversation-history-keyset-page',
    scopeKey,
    pageSize,
    commitSeq: state.commitSeq,
    anchor: state.anchor,
    trail: state.trail
  }), 'utf8').toString('base64url');
}

function decodeHistoryKeysetCursor(
  cursor: string | undefined,
  scopeKey: string,
  pageSize: number
): HistoryCursorState {
  if (!cursor) return emptyHistoryCursorState();
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
    value.kind !== 'conversation-history-keyset-page'
    || value.scopeKey !== scopeKey
    || value.pageSize !== pageSize
    || (value.commitSeq !== undefined && typeof value.commitSeq !== 'string')
    || !Array.isArray(value.trail)
  ) {
    throw new TypeError('Conversation history cursor does not match the requested tree page.');
  }
  return {
    ...(typeof value.commitSeq === 'string' ? { commitSeq: value.commitSeq } : {}),
    anchor: decodeHistoryCursorAnchor(value.anchor),
    trail: value.trail.map(decodeHistoryCursorAnchor)
  };
}

function decodeHistoryCursorAnchor(value: unknown): HistoryCursorAnchor | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Conversation history cursor anchor is malformed.');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.updatedAt !== 'string' || !record.updatedAt || typeof record.id !== 'string' || !record.id) {
    throw new TypeError('Conversation history cursor anchor is malformed.');
  }
  return { updatedAt: record.updatedAt, id: record.id };
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
