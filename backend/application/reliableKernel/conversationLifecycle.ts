import type { ContentObjectMetadata } from '../../reliableKernel/contentAddressedStore';
import type { StructuralContextRecord } from '../../reliableKernel/contextSequence';
import { ConversationForkRejectedError } from '../../reliableKernel/conversationFork';
import {
  ForkCompressionPrecedence,
  ForkContextCandidateProbe,
  isNativeRequest,
  readNativeMessageContextRevisions
} from '../../reliableKernel/conversationForkContext';
import { projectFolderAssignmentSteps, projectFolderForConversation } from '../../reliableKernel/conversationProject';
import { isTransactionAssertionFailure, stablePhaseFId } from '../../reliableKernel/phaseFIdentity';
import { ConversationRuntimeOwnerBusyError } from '../../reliableKernel/ConversationRuntimeOwnerManager';
import { DOMAIN_REPOSITORIES, type DomainRow } from '../../reliableKernel/repositories';
import type { ReliableKernelApplication } from '../../reliableKernel/runtimeApplication';
import type { VscodeConfigurationAuthority } from '../../reliableKernel/vscodeConfigurationAuthority';
import { DEFAULT_CONVERSATION_TITLE, displayConversationTitle, displayConversationTitleFromText } from '../../../shared/conversationTitle';
import { conversationHistoryTitleContentFromBytes } from './conversationHistoryProjection';

/** The Runtime and settings authorities every Conversation lifecycle operation writes through. */
export interface ConversationLifecycleComposition {
  readonly application: ReliableKernelApplication;
  readonly configuration: VscodeConfigurationAuthority;
}

export interface ConversationForkRequest {
  sourceConversationId: string;
  /** Last Message the branch retains; its Turns must have ended. */
  messageId: string;
  expectedRevisionId: string;
  /** Stable command identity: the same command always resolves to the same branch. */
  commandId: string;
}

export interface ConversationForkOutcome {
  conversationId: string;
  deduplicated: boolean;
}

export interface CompletedHistoryForkRequest {
  sourceConversationId: string;
  /** The fork_conversation ToolCall id: a replay resolves to the originally committed branch. */
  commandId: string;
}

export interface CreatedConversationRequest {
  /** Calling Turn and ToolCall: they fix the new Conversation's identity and first task source. */
  turnId: string;
  toolCallId: string;
  sourceConversationId: string;
  prompt: string;
  title?: string;
}

/**
 * Conversation lifecycle writes shared by the user bridge (the facade) and model tools. Every
 * operation is idempotent by its command identity and never touches a webview: navigation and
 * sidebar refresh belong to the caller.
 */
export class ReliableConversationLifecycle {
  public constructor(private readonly composition: ConversationLifecycleComposition) {}

  private get application(): ReliableKernelApplication { return this.composition.application; }
  private get configuration(): VscodeConfigurationAuthority { return this.composition.configuration; }

  public async fork(request: ConversationForkRequest): Promise<ConversationForkOutcome> {
    const sourceConversationId = requireText(request.sourceConversationId, 'Conversation fork sourceConversationId');
    const commandId = requireText(request.commandId, 'Conversation fork commandId');
    // The source Conversation DAG/configuration is read and copied under its ownership pin so a
    // peer Host cannot mutate or delete it mid-fork.
    return this.application.database.conversationOwners.run(sourceConversationId, () =>
      this.discardingRejectedTarget(commandId, (targetConversationId) =>
        this.forkCommand(request, commandId, targetConversationId)
      )
    );
  }

  /**
   * Forks the completed history of a Conversation: the branch ends with the last visible Message
   * of its latest ended Turn, so a Turn still in progress (including the caller's own) is never
   * copied. The branch starts no Turn and nothing is posted to a webview.
   */
  public async forkCompletedHistory(request: CompletedHistoryForkRequest): Promise<ConversationForkOutcome & { title: string }> {
    const sourceConversationId = requireText(request.sourceConversationId, 'Conversation fork sourceConversationId');
    const commandId = requireText(request.commandId, 'Conversation fork commandId');
    const targetConversationId = forkTargetConversationId(commandId);
    try {
      return await this.application.database.conversationOwners.run(sourceConversationId, async () => {
        // A source deleted after the tool call was admitted is refused as missing, not as a
        // Conversation without completed history.
        if (!await this.maybeRow('Conversation', sourceConversationId)) {
          throw new ConversationForkRejectedError(`Fork 源 Conversation ${sourceConversationId} 不存在。`);
        }
        // A replayed command keeps its committed boundary even if more Turns have ended since.
        const boundary = await this.committedForkBoundary(commandId) ?? await this.completedHistoryBoundary(sourceConversationId);
        const result = await this.forkCommand({ sourceConversationId, commandId, ...boundary }, commandId, targetConversationId);
        return { ...result, title: String((await this.requireRow('Conversation', result.conversationId)).title) };
      });
    } catch (error) {
      // The model's call is its only attempt: whatever failed, settings copied under a branch that
      // was never committed are removed, and the model gets a reason it can act on.
      await this.discardRejectedForkTarget(targetConversationId);
      throw forkToolError(error);
    }
  }

  /**
   * Creates a top-level Conversation whose first Turn is a collaboration task from the calling
   * Turn, never a user message. Every check that can refuse the task runs before anything is
   * written; the Conversation, its links and the task then commit in one transaction, so a refused
   * or interrupted creation leaves no Conversation behind, and a failed attempt clears the settings
   * it wrote. The first task is the durable creation marker: it outlives the Conversation, so a
   * replay after the user deleted it creates nothing.
   */
  public async createForCollaboration(request: CreatedConversationRequest): Promise<{
    conversationId: string; title: string; messageId: string; deduplicated: boolean;
  }> {
    const turnId = requireText(request.turnId, 'create_conversation turnId');
    const toolCallId = requireText(request.toolCallId, 'create_conversation toolCallId');
    const sourceConversationId = requireText(request.sourceConversationId, 'create_conversation sourceConversationId');
    if (typeof request.prompt !== 'string' || !request.prompt.trim()) throw new TypeError('create_conversation prompt must be non-empty text.');
    const conversationId = stablePhaseFId('conversation', 'cross-create', toolCallId);
    const title = request.title?.trim()
      ? displayConversationTitleFromText(request.title, 80)
      : displayConversationTitleFromText(request.prompt, 40);
    const collaboration = this.application.runtime.collaboration;
    // A running target never exists at creation, yet the task queues like every peer task.
    const task = {
      source: { kind: 'tool' as const, turnId, toolCallId }, targetConversationId: conversationId,
      text: request.prompt, mode: 'followup' as const, queueBehindActiveTurn: true, crossConversation: true
    };
    // This Host owns the new Conversation from its first write; the pending followup keeps it
    // owned until the delivery starts its first Turn.
    return this.application.database.conversationOwners.run(conversationId, async () => {
      const committed = await collaboration.toolCallMessage(toolCallId);
      if (committed) {
        if (committed.targetConversationId !== conversationId) throw new Error('create_conversation replay conflicts with its committed task.');
        const existing = await this.maybeRow('Conversation', conversationId);
        if (!existing) throw new Error('The conversation this call created has been deleted; it is not created again.');
        const replayed = await collaboration.send(task);
        return { conversationId, title: String(existing.title), messageId: replayed.messageId, deduplicated: true };
      }
      await collaboration.admitConversationCreation({ turnId, toolCallId });
      // The calling Turn's frozen selection fixes the model and work environment the new
      // Conversation starts with; everything else comes from its own settings scopes.
      const [model, environment, agent, project] = await Promise.all([
        this.application.runtime.children.frozenModelSelectionForTurn(turnId),
        this.application.runtime.children.frozenWorkEnvironmentPolicyForTurn(turnId),
        this.configuration.resolveAgent({ agentType: 'main' }),
        projectFolderForConversation(this.application.database, sourceConversationId)
      ]);
      // Settings go first and only fill empty slots. Once their writes have started, a failed
      // attempt clears them again; a refusal before that has nothing to clear. Only a Host that
      // dies before the commit leaves settings nothing refers to, which the replay of this call
      // reuses.
      try {
        if (environment?.defaultWorkEnvironmentId) {
          await this.configuration.mutations.initializeConversationWorkEnvironment(conversationId, environment.defaultWorkEnvironmentId);
        }
        await this.configuration.mutations.initializeConversationModelProfile({ conversationId, ...model });
        const now = new Date().toISOString();
        const sent = await collaboration.send({ ...task, newConversationSteps: [
          DOMAIN_REPOSITORIES.domain('Conversation').insert({
            id: conversationId, title, status: 'active', created_at: now, updated_at: now
          }),
          DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
            id: stablePhaseFId('agent_conversation_link', conversationId), conversation_id: conversationId,
            agent_id: agent.agentId, role: 'default', created_at: now, updated_at: now
          }),
          ...(project ? projectFolderAssignmentSteps({ conversationId, folder: project, now }) : [])
        ] });
        return {
          conversationId,
          title: String((await this.requireRow('Conversation', conversationId)).title),
          messageId: sent.messageId,
          deduplicated: sent.deduplicated
        };
      } catch (error) {
        await this.discardUncreatedConversationSettings(conversationId);
        throw error;
      }
    });
  }

  /**
   * A creation refused after admission (a budget race, the source Turn stopped, a settings write
   * failing midway) never commits its Conversation; the settings it wrote are removed under the
   * same ownership pin. A cleanup failure is logged and never replaces the original error.
   */
  private async discardUncreatedConversationSettings(conversationId: string): Promise<void> {
    try {
      if (await this.maybeRow('Conversation', conversationId)) return;
      await this.configuration.mutations.clearConversationConfiguration(conversationId);
    } catch (cleanupError) {
      console.warn(
        `[reliable-kernel] failed to clear settings of the uncreated conversation ${conversationId}:`,
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      );
    }
  }

  private async committedForkBoundary(commandId: string): Promise<{ messageId: string; expectedRevisionId: string } | undefined> {
    const reuse = await this.list('ConversationReuseLink', { reuse_key: `conversation-fork-command:${commandId}` }, 2);
    if (reuse.length !== 1) return undefined;
    const branches = await this.list('ConversationBranchLink', {
      target_conversation_id: requireText(reuse[0].conversation_id, 'ConversationReuseLink.conversation_id')
    }, 2);
    if (branches.length !== 1) return undefined;
    const expectedRevisionId = requireText(branches[0].source_message_revision_id, 'ConversationBranchLink.source_message_revision_id');
    const revision = await this.requireRow('MessageRevision', expectedRevisionId);
    return { messageId: requireText(revision.message_id, 'MessageRevision.message_id'), expectedRevisionId };
  }

  /** The newest visible user or assistant Message that is in Context and whose Turns all ended. */
  private async completedHistoryBoundary(conversationId: string): Promise<{ messageId: string; expectedRevisionId: string }> {
    let keyset: { column: string; value: bigint; id: string; direction: 'before' } | undefined;
    for (;;) {
      const page = requireRows((await this.application.database.snapshot([
        DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({
          where: { conversation_id: conversationId },
          orderBy: { column: 'message_seq', direction: 'desc' },
          ...(keyset ? { keyset } : {}),
          limit: 100
        })
      ])).snapshot[0], 'MessagePartOfConversation fork boundary');
      for (const membership of page) {
        const messageId = requireText(membership.message_id, 'MessagePartOfConversation.message_id');
        const [message, current, turnLinks] = await Promise.all([
          this.requireRow('Message', messageId),
          this.list('MessageCurrentRevisionLink', { message_id: messageId }, 2),
          this.list('MessageTurnLink', { message_id: messageId }, 16)
        ]);
        if (message.deleted_at !== null || current.length !== 1 || turnLinks.length === 0) continue;
        const revisionId = requireText(current[0].revision_id, 'MessageCurrentRevisionLink.revision_id');
        const revision = await this.requireRow('MessageRevision', revisionId);
        if (revision.role !== 'user' && revision.role !== 'model') continue;
        const turns = await Promise.all(turnLinks.map((link) => this.requireRow('Turn', requireText(link.turn_id, 'MessageTurnLink.turn_id'))));
        if (turns.some((turn) => turn.status !== 'terminated')) continue;
        const inContext = (await this.list('ContextSegmentSource', { source_kind: 'message_revision', source_id: revisionId }, 1)).length > 0
          || (revision.role === 'model' && (await readNativeMessageContextRevisions(this.application.database, messageId)).length > 0);
        if (inContext) return { messageId, expectedRevisionId: revisionId };
      }
      if (page.length < 100) throw new ConversationForkRejectedError('这个对话还没有已完成的轮次，无法创建分支。');
      const last = page[page.length - 1];
      keyset = { column: 'message_seq', value: last.message_seq as bigint, id: requireText(last.id, 'MessagePartOfConversation.id'), direction: 'before' };
    }
  }

  /**
   * Runs one fork command against its branch target. The target id is derived from the command
   * identity alone, so any permanent rejection of the command, including finding no completed
   * history, can find settings an earlier attempt of the same command copied under it.
   */
  private async discardingRejectedTarget<T>(commandId: string, run: (targetConversationId: string) => Promise<T>): Promise<T> {
    const targetConversationId = forkTargetConversationId(commandId);
    try {
      return await run(targetConversationId);
    } catch (error) {
      if (error instanceof ConversationForkRejectedError) await this.discardRejectedForkTarget(targetConversationId);
      throw error;
    }
  }

  /**
   * A permanently rejected command never commits its branch, but an earlier attempt that failed
   * at the commit may have copied Conversation-layer settings under the target id already. They are
   * removed so the rejection leaves nothing behind; a target committed by this command is kept. The
   * rejection is what the caller must see, so a failed cleanup is only logged.
   */
  private async discardRejectedForkTarget(targetConversationId: string): Promise<void> {
    try {
      await this.application.database.conversationOwners.run(targetConversationId, async () => {
        if (await this.maybeRow('Conversation', targetConversationId)) return;
        await this.configuration.mutations.clearConversationConfiguration(targetConversationId);
      });
    } catch (error) {
      console.warn('[LimCode] Failed to remove the settings of a rejected fork target.', targetConversationId, error);
    }
  }

  private async forkCommand(
    request: ConversationForkRequest,
    commandId: string,
    targetConversationId: string
  ): Promise<ConversationForkOutcome> {
    const sourceConversationId = requireText(request.sourceConversationId, 'Conversation fork sourceConversationId');
    const messageId = requireText(request.messageId, 'Conversation fork messageId');
    const expectedRevisionId = requireText(request.expectedRevisionId, 'Conversation fork expectedRevisionId');
    const reuseKey = `conversation-fork-command:${commandId}`;

    // Replay is resolved from the immutable branch/reuse facts before consulting today's mutable
    // MessageCurrentRevisionLink. A lost result therefore remains replayable even if the source is
    // edited after the original fork committed, and every rejection below follows this lookup, so
    // none of them can hide a committed branch: they are permanent for this command.
    const existingReuse = await this.list('ConversationReuseLink', { reuse_key: reuseKey }, 2);
    if (existingReuse.length > 1) throw new Error('Conversation fork command identity is not unique.');
    if (existingReuse.length === 1) {
      const conversationId = requireText(existingReuse[0].conversation_id, 'ConversationReuseLink.conversation_id');
      const branches = await this.list('ConversationBranchLink', { target_conversation_id: conversationId }, 2);
      if (
        branches.length !== 1
        || branches[0].source_conversation_id !== sourceConversationId
        || branches[0].source_message_revision_id !== expectedRevisionId
      ) throw new ConversationForkRejectedError('Conversation fork command was replayed with different source facts.');
      const revision = await this.requireRow('MessageRevision', expectedRevisionId);
      if (revision.message_id !== messageId) {
        throw new ConversationForkRejectedError('Conversation fork command was replayed with a different source Message.');
      }
      // The configuration copy completed before the branch committed; the target's settings now
      // belong to the user and a replay must not refill anything they changed or cleared.
      return { conversationId, deduplicated: true };
    }

    const sourceConversation = await this.maybeRow('Conversation', sourceConversationId);
    if (!sourceConversation) throw new ConversationForkRejectedError(`Fork 源 Conversation ${sourceConversationId} 不存在。`);
    const currentLinks = await this.list('MessageCurrentRevisionLink', { message_id: messageId }, 2);
    if (currentLinks.length !== 1) throw new ConversationForkRejectedError('Fork 源 Message 缺少唯一当前 Revision。');
    const revisionId = requireText(currentLinks[0].revision_id, 'MessageCurrentRevisionLink.revision_id');
    if (revisionId !== expectedRevisionId) {
      throw new ConversationForkRejectedError('Fork 源 Message Revision 已变化，请基于当前内容重新创建分支。');
    }
    const memberships = await this.list('MessagePartOfConversation', {
      conversation_id: sourceConversationId,
      message_id: messageId
    }, 2);
    if (memberships.length !== 1) throw new ConversationForkRejectedError('Fork 源 Message 不属于当前 Conversation。');
    if ((await this.requireRow('Message', messageId)).deleted_at !== null) {
      throw new ConversationForkRejectedError('分支点消息已被删除，无法从这条消息创建分支。');
    }
    const boundaryMessageSeq = memberships[0].message_seq;
    if (typeof boundaryMessageSeq !== 'bigint') throw new TypeError('MessagePartOfConversation.message_seq 必须是整数。');
    const turnLinks = (await this.application.database.snapshotAll(
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
    // Settled results of ended Turns are closed into the idle source Context here (unfenced closure
    // requires no ExecutionLease). While a later Turn runs, its executor owns the Context writes.
    if ((await this.list('ExecutionLease', { conversation_id: sourceConversationId }, 1)).length === 0) {
      const nativeWork = await this.application.runtime.effects.listNativePendingWork({
        conversationId: sourceConversationId
      });
      for (const work of nativeWork) {
        if (work.turnActive || !work.settled || !work.callContextSegmentId || work.resultContextSegmentId) continue;
        await this.application.context.appendNativeToolResult({
          conversationId: sourceConversationId,
          toolCallId: work.toolCallId,
          toolModelResultId: requireText(work.toolModelResultId, 'NativePendingToolCall.toolModelResultId')
        });
      }
    }
    // Native closure and in-flight steering are checked by the fork writer over the fork's own
    // retained segments and copied Turns; a still running later Turn never blocks this fork.
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
          for (const item of await readNativeMessageContextRevisions(this.application.database, messageId)) {
            for (const source of item.sources) {
              sourceSegmentIds.add(requireText(source.segment_id, 'ContextSegmentSource.segment_id'));
            }
          }
        }
      }
      const callLinks = (await this.application.database.snapshotAll(
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
          this.application.runtime.effects.readNativeAdmission(toolCallId)
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
    const roots = (await this.application.database.snapshotAll(
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
    let sourceRecords: StructuralContextRecord[] = [];
    let cutIndex = -1;
    const nativeContext = nativeMessageProjection || requiredToolContext.some((tool) => tool.native);
    // Prefer the newest context containing this boundary: an edit can leave the same assistant
    // revision in an older root whose preceding user revisions no longer match the transcript.
    const candidates = new ForkContextCandidateProbe(this.application.database, sourceSegmentIds);
    const compressionPrecedence = new ForkCompressionPrecedence(this.application.database, sourceConversationId, boundaryMessageSeq);
    for (const root of [...roots].reverse()) {
      if (!await candidates.mayContain(root)) continue;
      // A root whose compression can never precede this cut is skipped without reading it.
      const summarySegmentId = await candidates.compressionSummary(root);
      if (summarySegmentId && !await compressionPrecedence.mayPrecede(summarySegmentId)) continue;
      const rootId = requireText(root.id, 'ContextSequenceRoot.id');
      const structure = await this.application.context.materializeStructure(rootId);
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
          // A result settled after the selected message is moved behind the fork cut by the
          // writer; the cut itself never extends over the later history in between.
          if (callIndex < 0 || resultIndex < callIndex) return false;
          previousIndex = Math.max(previousIndex, callIndex);
          return true;
        }
        if (callIndex <= previousIndex || resultIndex !== callIndex) return false;
        previousIndex = resultIndex;
        return true;
      });
      if (messageIndex >= 0 && containsClosedToolSuffix) {
        // A compression made after this boundary (for example by a later, possibly still running
        // Turn) is not part of the forked history: fall back to the pre-compression root.
        if (!await compressionPrecedence.precedesCut(structure.records, previousIndex)) continue;
        sourceRootId = rootId;
        sourceContextEndSegmentId = requireText(structure.records[previousIndex].segment.id, 'ContextSegment.id');
        sourceContextSegmentIds = structure.records.slice(0, previousIndex + 1).map((record) =>
          requireText(record.segment.id, 'ContextSegment.id')
        );
        sourceRecords = structure.records;
        cutIndex = previousIndex;
        break;
      }
    }
    if (!sourceRootId || !sourceContextEndSegmentId || !sourceContextSegmentIds) {
      throw new Error('无法定位 Fork 源 MessageRevision 对应的 Context root。');
    }
    const lateNativeResultSegmentIds = await this.application.context.lateNativeResultSegmentIds(
      sourceConversationId,
      sourceRecords,
      cutIndex
    );
    const sourceAttachmentCatalogState = await this.application.modelProvider.projectAttachmentCatalogState(
      sourceConversationId,
      [...sourceContextSegmentIds, ...lateNativeResultSegmentIds].map((segmentId) => ({ segmentId }))
    );
    await this.application.modelProvider.ensureAttachmentHandles(
      sourceConversationId,
      sourceAttachmentCatalogState.catalog
    );

    const agentLinks = await this.list('AgentConversationLink', {
      conversation_id: sourceConversationId,
      role: 'default'
    }, 2);
    if (agentLinks.length !== 1) throw new Error('Fork 源 Conversation 缺少唯一默认 Agent 关系。');
    // The branch target is claimed BEFORE its first write: this Host owns the new Conversation
    // through the configuration copy and the fork transaction. The id is derived from the fork
    // command identity so concurrent same-command calls deterministically claim the same target
    // (and a peer's claim refuses busy) instead of forking divergent targets. The opening view
    // retains it via claim-before-open; without a view the owner idle-releases after this run.
    const targetTitle = `${await this.durableConversationTitle(sourceConversation)} 分支`;
    const result = await this.application.database.conversationOwners.run(targetConversationId, () =>
      this.application.runtime.conversationFork.fork({
        idempotencyKey: commandId,
        reuseKey,
        sourceConversationId,
        sourceContextRootId: sourceRootId,
        sourceContextEndSegmentId,
        sourceMessageRevisionId: revisionId,
        expectedCurrentMessageRevisionId: revisionId,
        ...(sourceTurnIds.length === 1 ? { sourceTurnId: sourceTurnIds[0] } : {}),
        targetConversationId,
        targetTitle,
        targetAgentId: requireText(agentLinks[0].agent_id, 'AgentConversationLink.agent_id')
      }, {
        // Conversation-layer settings are copied after every snapshot check and BEFORE the branch
        // commits: once the branch exists it is immediately usable and replays never touch its
        // settings again. An interrupted copy or commit is resumed by the same command, which only
        // fills still-empty target settings; a permanent rejection removes them again.
        beforeCommit: () => this.configuration.mutations.copyConversationConfiguration(
          sourceConversationId,
          targetConversationId
        )
      })
    );
    return { conversationId: result.targetConversationId, deduplicated: result.deduplicated };
  }

  /**
   * The title a Conversation displays, read from committed facts rather than the sidebar cache:
   * its stored title, or for a placeholder title its first user message (as the history list does).
   */
  private async durableConversationTitle(conversation: DomainRow): Promise<string> {
    const id = requireText(conversation.id, 'Conversation.id');
    const title = typeof conversation.title === 'string' ? conversation.title : '';
    const explicit = displayConversationTitle({ id, title });
    if (explicit !== DEFAULT_CONVERSATION_TITLE) return explicit;
    const memberships = requireRows((await this.application.database.snapshot([
      DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({
        where: { conversation_id: id },
        orderBy: { column: 'message_seq', direction: 'asc' },
        limit: 16
      })
    ])).snapshot[0], 'MessagePartOfConversation title lookup');
    for (const membership of memberships) {
      const messageId = requireText(membership.message_id, 'MessagePartOfConversation.message_id');
      const [message, current] = await Promise.all([
        this.requireRow('Message', messageId),
        this.list('MessageCurrentRevisionLink', { message_id: messageId }, 2)
      ]);
      if (message.deleted_at !== null || current.length !== 1) continue;
      const revision = await this.requireRow('MessageRevision', requireText(current[0].revision_id, 'MessageCurrentRevisionLink.revision_id'));
      if (revision.role !== 'user') continue;
      const metadata = await this.requireRow('ContentObject', requireText(revision.content_object_id, 'MessageRevision.content_object_id'));
      const content = conversationHistoryTitleContentFromBytes(
        await this.application.contentStore.read(metadata as unknown as ContentObjectMetadata),
        String(metadata.content_type)
      );
      if (content) return displayConversationTitle({ id, title, messages: [{ role: 'user', content }] });
    }
    return explicit;
  }

  private async maybeRow(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.application.database.snapshot([
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
    const snapshot = await this.application.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    return requireRows(snapshot.snapshot[0], `${domain} list`);
  }
}

/** A fork command's branch target: derived from the command identity alone. */
function forkTargetConversationId(commandId: string): string {
  return stablePhaseFId('conversation', `conversation-fork:${commandId}`);
}

/**
 * The reason a fork_conversation call reports. Nothing was created in every case. A permanent
 * rejection already says why; a source hosted by another window and a concurrent change to the
 * source get their own actionable message; anything else keeps its text behind that fact.
 */
function forkToolError(error: unknown): Error {
  if (error instanceof ConversationForkRejectedError) return error;
  // Forking reads and settles the source under its ownership, which listing, reading and sending
  // never need: only this call cares which window hosts the source.
  if (error instanceof ConversationRuntimeOwnerBusyError) {
    return new Error('That conversation is open in another VS Code window, and only the window hosting a conversation can fork it. Nothing was created; ask the user to fork it from that window, or try again once it is closed there.');
  }
  if (isTransactionAssertionFailure(error)) {
    return new Error('The conversation changed while it was being forked. Nothing was created; try again.');
  }
  return new Error(`Forking failed. Nothing was created: ${error instanceof Error ? error.message : String(error)}`);
}

function requireRows(value: DomainRow | DomainRow[] | null, label: string): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} 未返回数组。`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} 必须是非空字符串。`);
  return value.trim();
}

function compareBigInt(left: unknown, right: unknown): number {
  const leftValue = typeof left === 'bigint' ? left : BigInt(String(left));
  const rightValue = typeof right === 'bigint' ? right : BigInt(String(right));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}
