import type { ContentObjectMetadata } from '../../reliableKernel/contentAddressedStore';
import type { StructuralContextRecord } from '../../reliableKernel/contextSequence';
import { ConversationForkRejectedError } from '../../reliableKernel/conversationFork';
import { ForkContextCandidateProbe, isNativeRequest, readNativeMessageContextRevisions } from '../../reliableKernel/conversationForkContext';
import { stablePhaseFId } from '../../reliableKernel/phaseFIdentity';
import { DOMAIN_REPOSITORIES, type DomainRow } from '../../reliableKernel/repositories';
import type { ReliableKernelApplication } from '../../reliableKernel/runtimeApplication';
import type { VscodeConfigurationAuthority } from '../../reliableKernel/vscodeConfigurationAuthority';
import { DEFAULT_CONVERSATION_TITLE, displayConversationTitle } from '../../../shared/conversationTitle';
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
    // The source Conversation DAG/configuration is read and copied under its ownership pin so a
    // peer Host cannot mutate or delete it mid-fork.
    return this.application.database.conversationOwners.run(sourceConversationId, () =>
      this.forkUnderOwnership(request)
    );
  }

  private async forkUnderOwnership(request: ConversationForkRequest): Promise<ConversationForkOutcome> {
    const sourceConversationId = requireText(request.sourceConversationId, 'Conversation fork sourceConversationId');
    const messageId = requireText(request.messageId, 'Conversation fork messageId');
    const expectedRevisionId = requireText(request.expectedRevisionId, 'Conversation fork expectedRevisionId');
    const commandId = requireText(request.commandId, 'Conversation fork commandId');
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
      // The configuration copy completed before the branch committed; the target's settings now
      // belong to the user and a replay must not refill anything they changed or cleared.
      return { conversationId, deduplicated: true };
    }

    const sourceConversation = await this.requireRow('Conversation', sourceConversationId);
    const currentLinks = await this.list('MessageCurrentRevisionLink', { message_id: messageId }, 2);
    if (currentLinks.length !== 1) throw new Error('Fork 源 Message 缺少唯一当前 Revision。');
    const revisionId = requireText(currentLinks[0].revision_id, 'MessageCurrentRevisionLink.revision_id');
    if (revisionId !== expectedRevisionId) throw new Error('Fork 源 Message Revision 已变化，请基于当前内容重新创建分支。');
    const memberships = await this.list('MessagePartOfConversation', {
      conversation_id: sourceConversationId,
      message_id: messageId
    }, 2);
    if (memberships.length !== 1) throw new Error('Fork 源 Message 不属于当前 Conversation。');
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
    for (const root of [...roots].reverse()) {
      if (!await candidates.mayContain(root)) continue;
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
    // through the fork transaction and the configuration copy. The id is derived from the fork
    // command identity so concurrent same-command calls deterministically claim the same target
    // (and a peer's claim refuses busy) instead of forking divergent targets. The opening view
    // retains it via claim-before-open; without a view the owner idle-releases after this run.
    const targetConversationId = stablePhaseFId('conversation', `conversation-fork:${commandId}`);
    const result = await this.application.database.conversationOwners.run(targetConversationId, async () => {
      // Conversation-layer settings are copied BEFORE the branch commits: once the branch exists
      // it is immediately usable and replays never touch its settings again. An interrupted copy
      // or fork is resumed by the same command, which only fills still-empty target settings.
      await this.configuration.mutations.copyConversationConfiguration(
        sourceConversationId,
        targetConversationId
      );
      return this.application.runtime.conversationFork.fork({
        idempotencyKey: commandId,
        reuseKey,
        sourceConversationId,
        sourceContextRootId: sourceRootId,
        sourceContextEndSegmentId,
        sourceMessageRevisionId: revisionId,
        expectedCurrentMessageRevisionId: revisionId,
        ...(sourceTurnIds.length === 1 ? { sourceTurnId: sourceTurnIds[0] } : {}),
        targetConversationId,
        targetTitle: `${await this.durableConversationTitle(sourceConversation)} 分支`,
        targetAgentId: requireText(agentLinks[0].agent_id, 'AgentConversationLink.agent_id')
      });
    });
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
