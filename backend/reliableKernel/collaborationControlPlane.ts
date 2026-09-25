import { RuntimeDeliveryControlPlane } from './answerDelivery';
import { AutomaticRuntimeDeliveryRouter } from './automaticRuntimeDelivery';
import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import { isCrossConversationFollowup, isCrossConversationReply, readCollaborationScope, type CollaborationScope } from './collaborationScope';
import { CROSS_CONVERSATION_LIMITS, readTurnCollaborationLimits, readTurnCrossConversationEnabled } from './collaborationPolicy';
import { DEFAULT_CONVERSATION_TITLE, displayConversationTitle, displayConversationTitleFromText } from '../../shared/conversationTitle';
import { TURN_INTENT_ENVELOPE_CONTENT_TYPE, parseRuntimeContinuationTurnIntentEnvelopeText } from './guidanceIntent';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import { isRuntimeMaintenanceTurn } from './maintenanceTurn';
import { listAllDomainRows } from './repositoryPagination';
import { isTransactionAssertionFailure, requirePhaseFId, stablePhaseFId, sqliteUniqueFailureIncludes } from './phaseFIdentity';
import type { RuntimeDatabase } from './runtimeDatabase';
import { estimateJsonTokens, estimateTextTokens } from './modelTokenEstimator';
import { forkSourceConversationIds } from './conversationChildHandles';

export const COLLABORATION_MESSAGE_CONTENT_TYPE = 'text/vnd.limcode.collaboration-message';
/** Every collaboration message body is 1..COLLABORATION_MESSAGE_MAX_TEXT_BYTES UTF-8 bytes. */
export const COLLABORATION_MESSAGE_MAX_TEXT_BYTES = 64_000;
/**
 * The budget of the task a cross-conversation reply answers is spent, or the Conversation that
 * funded it was deleted: the reply starts no Turn and waits for the requester's next Turn.
 */
export class CollaborationReplyBudgetExhaustedError extends Error {
  public readonly code = 'COLLABORATION_REPLY_BUDGET_EXHAUSTED';
  public constructor(message: string) {
    super(message);
    this.name = 'CollaborationReplyBudgetExhaustedError';
  }
}
export function isCollaborationReplyBudgetExhaustedError(error: unknown): error is CollaborationReplyBudgetExhaustedError {
  return error instanceof CollaborationReplyBudgetExhaustedError;
}
/**
 * Cross-conversation tools reach only Conversations of the caller's project. Conversations without
 * a project reach only each other, as the sidebar groups them under one 未绑定 scope.
 */
export const CROSS_PROJECT_REFUSAL = 'That conversation belongs to a different project. Cross-conversation tools only reach conversations of this conversation\'s project (conversations without a project only reach each other). Nothing was read, sent or created.';
export type CollaborationSource = { kind: 'tool'; turnId: string; toolCallId: string };
/** turnId is null for the failure reply to a task that no Turn will answer. */
interface CompletionSource { kind: 'completion'; turnId: string | null; requestId: string }
interface BoardSource { kind: 'board'; turnId: string; postId: string; conversationId: string }
export interface CollaborationSendCommand {
  source: CollaborationSource;
  targetConversationId: string;
  text: string;
  mode: 'message' | 'followup';
  replyToMessageId?: string;
  /** Trusted runtime-only guard for running-member notifications. No idle message is committed. */
  onlyIfRunning?: boolean;
  /**
   * Hold the message until the target's currently running Turn ends instead of injecting it at the
   * next safe boundary. A followup then starts a new Turn; a message joins the target's next Turn.
   */
  queueBehindActiveTurn?: boolean;
  /**
   * Sent by a cross-conversation tool: the only way a tool send may leave its team. It requires the
   * source Turn's frozen crossConversationCollaboration switch and two distinct top-level
   * Conversations; team tools never set it.
   */
  crossConversation?: boolean;
  /**
   * create_conversation only: these steps insert the target Conversation and its links in the same
   * transaction as its first task. The target must not exist yet, so a refused or interrupted
   * creation leaves nothing behind.
   */
  newConversationSteps?: RepositoryTransactionStep[];
}
export interface CrossConversationListing {
  conversations: Array<{ conversationId: string; title: string; running: boolean; updatedAt: string }>;
  hasMore: boolean;
}
export interface CollaborationMessageSummary {
  messageId: string; sourceConversationId: string; targetConversationId: string;
  mode: 'message' | 'followup'; sourceKind: string; createdAt: string;
  replyToMessageId: string | null; deliveryState: string; handled: boolean;
}
export class CollaborationControlPlane {
  private readonly now: () => string;
  private readonly router: AutomaticRuntimeDeliveryRouter;
  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly deliveries: RuntimeDeliveryControlPlane,
    options: { now?: () => string } = {}
  ) { this.now = options.now ?? (() => new Date().toISOString()); this.router = new AutomaticRuntimeDeliveryRouter(database, contentStore); }

  /** Team roster only. Conversations outside the derived team are never listed here. */
  public async listMembers(conversationId: string) {
    await this.existing('Conversation', conversationId);
    const scope = await readCollaborationScope(this.database, conversationId);
    const members = await Promise.all(scope.members.map(async (member) => {
      const reachable = member.conversationId !== conversationId && (!member.childExecutionId || ['active', 'idle'].includes(member.status));
      return { ...member, title: String((await this.existing('Conversation', member.conversationId)).title), allowRead: true, allowSend: reachable, allowWake: reachable };
    }));
    return { rootConversationId: scope.rootConversationId, members };
  }

  public async send(input: CollaborationSendCommand) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await this.sendInternal(input); }
      catch (error) {
        const raced = isTransactionAssertionFailure(error) || sqliteUniqueFailureIncludes(error, ['collaboration_budget.id', 'collaboration_budget.origin_kind, collaboration_budget.origin_key']);
        if (!raced) throw error;
        // Every attempt re-reads and re-checks: a lasting refusal surfaces as its own clear error.
        if (attempt >= 3) throw new Error('Other collaboration activity kept changing the target or the followup budget while this was being sent. Nothing was sent; try again.');
      }
    }
  }

  /** Board posts are a distinct immutable source, never impersonated user or reused ToolCalls. */
  public async notifyBoardPost(notice: { postId: string; channelId: string; threadId: string; sourceConversationId: string; targetConversationId: string; sourceTurnId?: string; sourceToolCallId?: string }): Promise<{ status: 'delivered' | 'skipped_idle' | 'failed'; reason?: string }> {
    const postId = requirePhaseFId(notice.postId, 'postId');
    const source = await this.one('CollaborationBoardPostSourceLink', { post_id: postId });
    const channel = await this.one('CollaborationBoardPostChannelLink', { post_id: postId });
    if (source.conversation_id !== notice.sourceConversationId || channel.channel_id !== notice.channelId) throw new Error('Board notice conflicts with committed post identity.');
    const post = await this.existing('CollaborationBoardPost', postId);
    const metadata = await this.existing('ContentObject', String(post.content_object_id)) as ContentObjectMetadata;
    const content = (await this.contentStore.read(metadata)).toString('utf8').slice(0, 1000);
    try {
      await this.sendInternal({ source: { kind: 'board', postId, conversationId: notice.sourceConversationId, turnId: requirePhaseFId(source.source_turn_id, 'CollaborationBoardPostSourceLink.source_turn_id') }, targetConversationId: notice.targetConversationId, text: `Team board update. Use agent_board list_channels/list_threads to read the full post.\n${content}`, mode: 'message', onlyIfRunning: true });
      return { status: 'delivered' };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (isTransactionAssertionFailure(error) || /target is idle|completed its output|cannot revive/.test(detail)) return { status: 'skipped_idle', reason: detail };
      return { status: 'failed', reason: detail };
    }
  }

  private async sendInternal(input: Omit<CollaborationSendCommand, 'source'> & { source: CollaborationSource | CompletionSource | BoardSource }) {
    if (input.mode !== 'message' && input.mode !== 'followup') throw new TypeError('Unsupported collaboration delivery mode.');
    if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > COLLABORATION_MESSAGE_MAX_TEXT_BYTES) throw new RangeError(`Collaboration text must contain 1..${COLLABORATION_MESSAGE_MAX_TEXT_BYTES} UTF-8 bytes.`);
    const targetConversationId = requirePhaseFId(input.targetConversationId, 'targetConversationId');
    const source = input.source;
    if (input.queueBehindActiveTurn !== undefined && typeof input.queueBehindActiveTurn !== 'boolean') throw new TypeError('queueBehindActiveTurn must be boolean.');
    if (input.crossConversation !== undefined && typeof input.crossConversation !== 'boolean') throw new TypeError('crossConversation must be boolean.');
    if (input.crossConversation && source.kind !== 'tool') throw new Error('Only a tool call may send across conversations.');
    // Completion replies and board notices always reach a running target; only tool sends may wait.
    if (input.queueBehindActiveTurn && (source.kind !== 'tool' || input.onlyIfRunning)) throw new Error('Only tool-sourced sends may queue behind a running target Turn.');
    const creating = input.newConversationSteps !== undefined;
    if (creating && (source.kind !== 'tool' || !input.crossConversation || input.mode !== 'followup')) throw new Error('Only a cross-conversation followup tool call may create its target Conversation.');
    const sourceKey = source.kind === 'tool' ? requirePhaseFId(source.toolCallId, 'toolCallId') : source.kind === 'completion' ? requirePhaseFId(source.requestId, 'requestId') : stablePhaseFId('board_notice', source.postId, targetConversationId);
    const dedupeKey = collaborationDedupeKey(source.kind, sourceKey);
    const messageId = stablePhaseFId('collaboration_message', dedupeKey);
    const inboxItemId = stablePhaseFId('runtime_inbox_item', messageId);
    const deliveryId = stablePhaseFId('runtime_delivery', 'collaboration', messageId);
    const replyToMessageId = input.replyToMessageId ? requirePhaseFId(input.replyToMessageId, 'replyToMessageId') : null;
    // A failure reply answers a task no Turn will answer: none took it in, or the one that did was
    // deleted with its Conversation. The task's target (the reply's source) may be gone as well.
    const failureReply = source.kind === 'completion' && source.turnId === null;
    const sourceTurn = source.turnId === null ? null : await this.existing('Turn', requirePhaseFId(source.turnId, 'turnId'));
    const sourceTurnId = sourceTurn ? String(sourceTurn.id) : null;
    const sourceConversationId = source.kind === 'board' ? requirePhaseFId(source.conversationId, 'conversationId')
      : sourceTurn ? String(sourceTurn.conversation_id)
        : await this.requestTargetConversationId(source.kind === 'completion' ? source.requestId : '');
    if (targetConversationId === sourceConversationId) throw new Error('A collaboration message must target another Conversation.');
    const prepared = await this.contentStore.prepare(this.database, input.text, COLLABORATION_MESSAGE_CONTENT_TYPE);
    const replay = async () => {
      const message = await this.maybe('CollaborationMessage', messageId);
      if (!message) return null;
      const [origins, targets, payloads, replies] = await Promise.all([this.rows('CollaborationMessageSourceLink', { message_id: messageId }), this.rows('CollaborationMessageTargetLink', { message_id: messageId }), this.rows('CollaborationMessagePayloadLink', { message_id: messageId }), this.rows('CollaborationMessageReplyLink', { message_id: messageId })]);
      if (message.mode !== input.mode || origins.length !== 1 || origins[0].conversation_id !== sourceConversationId || origins[0].turn_id !== sourceTurnId || targets.length !== 1 || targets[0].conversation_id !== targetConversationId || payloads.length !== 1 || payloads[0].content_object_id !== prepared.metadata.id || (replies[0]?.request_message_id ?? null) !== replyToMessageId) throw new Error('Collaboration send replay conflicts with immutable message facts.');
      // A tool send anchored to a running target Turn waits until that Turn ends.
      const queued = source.kind === 'tool' && targets[0].anchor_turn_id !== null;
      return { messageId, inboxItemId, deliveryId, mode: input.mode, accepted: true as const, queued, deduplicated: true };
    };
    const existing = await replay(); if (existing) return existing;
    if (input.crossConversation) await this.authorizeCrossConversation({ turnId: requirePhaseFId(sourceTurnId, 'turnId'), ...(creating ? {} : { targetConversationId }) });
    if (creating && await this.maybe('Conversation', targetConversationId)) throw new Error('The Conversation to create already exists without its first task.');
    const target = creating ? { id: targetConversationId, status: 'active' } : await this.existing('Conversation', targetConversationId);
    const origin = failureReply ? null : await this.existing('Conversation', sourceConversationId);
    if (target.status !== 'active' || (origin && origin.status !== 'active')) throw new Error('Collaboration requires active Conversations.');
    let sourceSteps: RepositoryTransactionStep[] = [];
    if (source.kind === 'board') {
      const boardSource = await this.one('CollaborationBoardPostSourceLink', { post_id: source.postId });
      if (boardSource.conversation_id !== sourceConversationId || boardSource.source_turn_id !== source.turnId) throw new Error('Board notification source conflicts with immutable post source.');
      sourceSteps.push(DOMAIN_REPOSITORIES.domain('CollaborationBoardPostSourceLink').assert(String(boardSource.id), { post_id: source.postId, conversation_id: sourceConversationId, source_turn_id: source.turnId }));
    }
    if (source.kind === 'tool') {
      const tool = await this.existing('ToolCall', source.toolCallId);
      if (tool.turn_id !== source.turnId || sourceTurn?.status !== 'active' || tool.status === 'terminal') throw new Error('Collaboration sender must be a live ToolCall in its exact active Turn.');
      sourceSteps = [DOMAIN_REPOSITORIES.domain('Turn').assert(source.turnId, { status: 'active', conversation_id: sourceConversationId }), DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: source.turnId }), DOMAIN_REPOSITORIES.domain('ToolCall').assert(source.toolCallId, { turn_id: source.turnId, status: tool.status })];
    }
    const sourceScope = failureReply ? null : await readCollaborationScope(this.database, sourceConversationId);
    const targetScope = creating ? newTopLevelScope(targetConversationId) : await readCollaborationScope(this.database, targetConversationId);
    const sourceMember = sourceScope?.members.find((entry) => entry.conversationId === sourceConversationId);
    if (source.kind === 'tool' && sourceMember?.childExecutionId && sourceMember.status !== 'active') throw new Error('A stopped child cannot initiate collaboration.');
    const targetMember = targetScope.members.find((entry) => entry.conversationId === targetConversationId)!;
    if (targetMember.childExecutionId && !['active', 'idle'].includes(targetMember.status)) throw new Error('Collaboration cannot revive a stopped, closed or starting child task.');
    // Completion replies return a result to the durable requester wherever it lives. Every other
    // source stays inside its derived team; another team's child tasks are never addressable.
    if (source.kind !== 'completion' && sourceScope?.rootConversationId !== targetScope.rootConversationId) {
      if (source.kind === 'board') throw new Error('Board notifications cannot cross team roots.');
      if (sourceMember?.childExecutionId || targetMember.childExecutionId) throw new Error('Cross-conversation collaboration cannot address or originate from a child task of another team.');
      if (!input.crossConversation) throw new Error('Cross-conversation collaboration is not enabled.');
    }
    if (replyToMessageId) {
      const previousSource = await this.one('CollaborationMessageSourceLink', { message_id: replyToMessageId });
      const previousTarget = await this.one('CollaborationMessageTargetLink', { message_id: replyToMessageId });
      if (previousSource.conversation_id !== targetConversationId || previousTarget.conversation_id !== sourceConversationId) {
        throw await this.foreignMessageError(sourceConversationId, [String(previousSource.conversation_id), String(previousTarget.conversation_id)], 'answer');
      }
      sourceSteps.push(DOMAIN_REPOSITORIES.domain('CollaborationMessageSourceLink').assert(String(previousSource.id), { conversation_id: targetConversationId }), DOMAIN_REPOSITORIES.domain('CollaborationMessageTargetLink').assert(String(previousTarget.id), { conversation_id: sourceConversationId }));
    }
    if (source.kind === 'completion') {
      if (!replyToMessageId) throw new Error('Completion requires a durable reply request.');
      const request = await this.existing('CollaborationRequest', source.requestId);
      if (request.message_id !== replyToMessageId) throw new Error('Completion reply request mismatch.');
      if (failureReply) {
        const [requestTurn, ...extra] = await this.rows('CollaborationRequestTurnLink', { request_id: source.requestId });
        if (request.state !== 'pending' || extra.length || (requestTurn && await this.maybe('Turn', String(requestTurn.turn_id)))) throw new Error('Only a pending task that no Turn will answer gets a failure reply.');
        sourceSteps.push(DOMAIN_REPOSITORIES.domain('CollaborationRequest').assert(source.requestId, { state: 'pending', message_id: replyToMessageId }),
          ...(requestTurn ? [DOMAIN_REPOSITORIES.domain('CollaborationRequestTurnLink').assert(String(requestTurn.id), { request_id: source.requestId, turn_id: requestTurn.turn_id }), DOMAIN_REPOSITORIES.domain('Turn').assertNone({ id: requestTurn.turn_id })]
            : [DOMAIN_REPOSITORIES.domain('CollaborationRequestTurnLink').assertNone({ request_id: source.requestId })]));
      } else {
        const requestTurn = await this.one('CollaborationRequestTurnLink', { request_id: source.requestId });
        if (requestTurn.turn_id !== source.turnId) throw new Error('Completion cannot answer a different task generation.');
        sourceSteps.push(DOMAIN_REPOSITORIES.domain('CollaborationRequest').assert(source.requestId, { state: request.state, message_id: replyToMessageId }), DOMAIN_REPOSITORIES.domain('CollaborationRequestTurnLink').assert(String(requestTurn.id), { turn_id: source.turnId }));
      }
    }
    const turns = creating ? [] : await this.rows('Turn', { conversation_id: targetConversationId });
    turns.sort(compareNewest);
    const active = turns.filter((turn) => turn.status === 'active');
    if (active.length > 1) throw new Error('Collaboration target has multiple active Turns.');
    // A manual compression or summary rebuild takes nothing in: a running-member notice finds the
    // target idle, and every other send waits for the next real Turn.
    const maintenance = active[0] ? await isRuntimeMaintenanceTurn(this.database, this.contentStore, String(active[0].id)) : false;
    if (input.onlyIfRunning && (!active[0] || maintenance)) throw new Error('Collaboration notification target is idle.');
    const fence = active[0] ? await this.rows('TurnFinalOutputFence', { turn_id: active[0].id }) : [];
    if (input.onlyIfRunning && fence.length) throw new Error('Collaboration notification target has completed its output.');
    // A queued send is anchored to the running Turn; routing only proceeds once that Turn has ended.
    const queuedTurnId = input.queueBehindActiveTurn && active[0] ? String(active[0].id) : null;
    const currentTurnId = !queuedTurnId && active[0] && !maintenance && !fence.length ? String(active[0].id) : null;
    const waitingTurnId = queuedTurnId ?? (maintenance ? String(active[0].id) : null);
    const now = this.now();
    const routingSteps: RepositoryTransactionStep[] = waitingTurnId ? [DOMAIN_REPOSITORIES.domain('Turn').assert(waitingTurnId, { status: 'active', conversation_id: targetConversationId }), DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: waitingTurnId })] : currentTurnId ? [DOMAIN_REPOSITORIES.domain('Turn').assert(currentTurnId, { status: 'active', conversation_id: targetConversationId }), DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: currentTurnId }), DOMAIN_REPOSITORIES.domain('TurnFinalOutputFence').assertNone({ turn_id: currentTurnId })] : active[0] ? [DOMAIN_REPOSITORIES.domain('TurnFinalOutputFence').assert(String(fence[0].id), { turn_id: active[0].id })] : [DOMAIN_REPOSITORIES.domain('Turn').assertNone({ conversation_id: targetConversationId, status: 'active' })];
    // Cross-conversation sends stop at a fixed backlog per target; replies owed to it never do.
    const inboundSteps = input.crossConversation ? await this.pendingInboundCapacitySteps(targetConversationId) : [];
    const requestId = stablePhaseFId('collaboration_request', messageId);
    const budgetSteps: RepositoryTransactionStep[] = [];
    if (input.mode === 'followup') {
      const { budget, persisted, spendSteps } = await this.availableFollowupBudget(requirePhaseFId(sourceTurnId, 'turnId'), sourceScope?.rootTurnId ?? null);
      if (!persisted) budgetSteps.push(DOMAIN_REPOSITORIES.domain('CollaborationBudget').insert(budget));
      budgetSteps.push(...spendSteps);
      budgetSteps.push(DOMAIN_REPOSITORIES.domain('CollaborationRequest').insert({ id: requestId, message_id: messageId, budget_id: budget.id, automatic: 1n, state: 'pending', created_at: now, updated_at: now }));
    }
    // A reply to a cross-conversation task starts a Turn of its requester once none is running;
    // that wake waits behind a Turn which will not take the reply in.
    const startsRequesterTurn = source.kind === 'completion' && await isCrossConversationFollowup(this.database, requirePhaseFId(replyToMessageId, 'replyToMessageId'));
    const wakeId = stablePhaseFId('runtime_delivery_wake', deliveryId);
    try {
      await this.database.transaction([
        ...(input.newConversationSteps ?? []),
        ...preparedContentObjectSteps([prepared], 'collaboration_content'), ...sourceSteps,
        ...(sourceScope?.authoritySteps ?? []), ...targetScope.authoritySteps, ...routingSteps, ...inboundSteps,
        ...(failureReply ? [] : [DOMAIN_REPOSITORIES.domain('Conversation').assert(sourceConversationId, { status: 'active' })]), DOMAIN_REPOSITORIES.domain('Conversation').assert(targetConversationId, { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('CollaborationMessage').insertWithNextSequence({ id: messageId, dedupe_key: dedupeKey, mode: input.mode, created_at: now }, { column: 'message_seq', scope: {} }),
        DOMAIN_REPOSITORIES.domain('CollaborationMessageSourceLink').insert({ id: stablePhaseFId('collaboration_source', messageId), message_id: messageId, conversation_id: sourceConversationId, source_kind: source.kind, source_key: sourceKey, turn_id: sourceTurnId, tool_call_id: source.kind === 'tool' ? source.toolCallId : null, board_post_id: source.kind === 'board' ? source.postId : null, created_at: now }),
        DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').insert({ id: inboxItemId, dedupe_key: dedupeKey, source_kind: 'collaboration_message', source_id: messageId, state: 'routed', created_at: now, updated_at: now }),
        DOMAIN_REPOSITORIES.domain('CollaborationMessageTargetLink').insert({ id: stablePhaseFId('collaboration_target', messageId), message_id: messageId, conversation_id: targetConversationId, inbox_item_id: inboxItemId, anchor_turn_id: source.kind === 'board' ? currentTurnId : queuedTurnId, created_at: now }),
        DOMAIN_REPOSITORIES.domain('CollaborationMessagePayloadLink').insert({ id: stablePhaseFId('collaboration_payload', messageId), message_id: messageId, content_object_id: prepared.metadata.id, created_at: now }),
        DOMAIN_REPOSITORIES.domain('RuntimeInboxPayloadLink').insert({ id: stablePhaseFId('runtime_inbox_payload_link', inboxItemId), inbox_item_id: inboxItemId, content_object_id: prepared.metadata.id, created_at: now }),
        ...(replyToMessageId ? [DOMAIN_REPOSITORIES.domain('CollaborationMessageReplyLink').insert({ id: stablePhaseFId('collaboration_reply', messageId), message_id: messageId, request_message_id: replyToMessageId, created_at: now })] : []),
        ...budgetSteps,
        DOMAIN_REPOSITORIES.domain('RuntimeDelivery').insert({ id: deliveryId, inbox_item_id: inboxItemId, target_conversation_id: targetConversationId, target_turn_id: currentTurnId, phase: currentTurnId ? 'current_turn' : 'next_turn', attempt_seq: 1n, retry_of_delivery_id: null, state: 'pending', failure_reason: null, created_at: now, updated_at: now }),
        ...(input.mode === 'followup' || currentTurnId || startsRequesterTurn ? [DOMAIN_REPOSITORIES.domain('RuntimeDeliveryWake').insert({ id: wakeId, delivery_id: deliveryId, state: 'pending', claim_owner_host_boot_id: null, claim_generation: 0n, claim_expires_at: null, attempt_count: 0n, failure_count: 0n, next_attempt_at: null, last_error: null, acknowledged_at: null, created_at: now, updated_at: now })] : [])
      ]);
    } catch (error) {
      if (!isTransactionAssertionFailure(error) && !sqliteUniqueFailureIncludes(error, ['collaboration_message.id', 'collaboration_message.dedupe_key', 'collaboration_message_source_link.source_kind, collaboration_message_source_link.source_key', ...(creating ? ['conversation.id'] : [])])) throw error;
      const raced = await replay(); if (raced) return raced;
      throw error;
    }
    return { messageId, inboxItemId, deliveryId, mode: input.mode, accepted: true as const, queued: queuedTurnId !== null, deduplicated: false };
  }

  public async listMessages(input: { conversationId: string; targetConversationId?: string; afterMessageId?: string; beforeMessageId?: string; limit?: number }): Promise<{ messages: CollaborationMessageSummary[]; nextCursor: string | null; olderCursor: string | null; hasMore: boolean }> {
    const caller = requirePhaseFId(input.conversationId, 'conversationId');
    const conversationId = input.targetConversationId ? requirePhaseFId(input.targetConversationId, 'targetConversationId') : caller;
    await this.assertReadPermission(caller, conversationId);
    await this.existing('Conversation', conversationId);
    const limit = input.limit ?? 30;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Message page limit must be 1..100.');
    if (input.afterMessageId && input.beforeMessageId) throw new Error('Choose one message cursor direction.');
    const cursorId = input.afterMessageId ?? input.beforeMessageId;
    let keyset: { column: string; value: bigint; id: string; direction: 'after' | 'before' } | undefined;
    if (cursorId) {
      const cursor = await this.existing('CollaborationMessage', requirePhaseFId(cursorId, 'message cursor'));
      const visible = await this.summary(cursor);
      if (![visible.sourceConversationId, visible.targetConversationId].includes(conversationId)) throw new Error('Message cursor is not visible in this Conversation.');
      keyset = { column: 'message_seq', value: cursor.message_seq as bigint, id: String(cursor.id), direction: input.afterMessageId ? 'after' : 'before' };
    }
    const result = await this.database.snapshot([DOMAIN_REPOSITORIES.domain('CollaborationMessage').list({ collaborationConversationId: conversationId, orderBy: { column: 'message_seq', direction: input.afterMessageId ? 'asc' : 'desc' }, ...(keyset ? { keyset } : {}), limit: limit + 1 })]);
    const rows = result.snapshot[0] as DomainRow[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit);
    if (!input.afterMessageId) selected.reverse();
    return { messages: await Promise.all(selected.map((row) => this.summary(row))), nextCursor: selected.length ? String(selected[selected.length - 1].id) : input.afterMessageId ?? null, olderCursor: !input.afterMessageId && hasMore && selected.length ? String(selected[0].id) : null, hasMore };
  }
  /**
   * One page of a collaboration message's full text, starting at a character offset. A page always
   * fits well under the model tool-result cap, so any accepted message, up to its byte limit, can be
   * read in full by following nextOffset until it is null.
   */
  public async readMessage(input: { conversationId: string; targetConversationId?: string; messageId: string; offset?: number }) {
    const message = await this.existing('CollaborationMessage', requirePhaseFId(input.messageId, 'messageId'));
    const summary = await this.summary(message);
    const reader = input.targetConversationId ?? input.conversationId;
    await this.assertReadPermission(input.conversationId, reader);
    if (![summary.sourceConversationId, summary.targetConversationId].includes(reader)) {
      throw await this.foreignMessageError(reader, [summary.sourceConversationId, summary.targetConversationId], 'read');
    }
    const payload = await this.one('CollaborationMessagePayloadLink', { message_id: input.messageId });
    const metadata = await this.existing('ContentObject', String(payload.content_object_id)) as ContentObjectMetadata;
    return { ...summary, ...collaborationTextPage((await this.contentStore.read(metadata)).toString('utf8'), input.offset ?? 0) };
  }
  /**
   * Bounded transcript read, authorized independently from send/wake and never a continuation.
   * A team member reads its team; crossConversationTurnId instead authorizes a top-level caller
   * through that Turn's frozen crossConversationCollaboration switch.
   *
   * The page budget is spent newest first, so the latest messages (a final answer above all) are
   * always shown. A message longer than one preview is shown from its start with its nextOffset for
   * readConversationMessage. Older messages that no longer fit end the page early: they are left
   * out, not relabelled, and olderMessageId always leads to them. The whole result stays under the
   * model tool-result cap.
   */
  public async readConversation(input: { conversationId: string; targetConversationId: string; beforeMessageId?: string; limit?: number; crossConversationTurnId?: string }) {
    const target = await this.authorizeTranscriptRead(input);
    const conversation = await this.existing('Conversation', target);
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError('Conversation read limit must be 1..50.');
    let keyset: { column: string; value: bigint; id: string; direction: 'before' } | undefined;
    if (input.beforeMessageId) {
      const cursor = await this.one('MessagePartOfConversation', { conversation_id: target, message_id: requirePhaseFId(input.beforeMessageId, 'beforeMessageId') });
      keyset = { column: 'message_seq', value: cursor.message_seq as bigint, id: String(cursor.id), direction: 'before' };
    }
    const result = await this.database.snapshot([DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({ where: { conversation_id: target }, orderBy: { column: 'message_seq', direction: 'desc' }, ...(keyset ? { keyset } : {}), limit: limit + 1 })]);
    const links = result.snapshot[0] as DomainRow[];
    const candidates = links.slice(0, limit);
    // Newest first. The collaboration inputs of a Turn are shown before its oldest message on the page.
    const newestFirst: TranscriptEntry[] = [];
    const turnInputs = new Map<string, CollaborationInputEntry[]>();
    const oldestEntryOfTurn = new Map<string, number>();
    let spent = 0;
    let consumed = 0;
    let pageFull = false;
    for (const link of candidates) {
      const messageId = String(link.message_id);
      const entry = await this.transcriptEntry(messageId);
      if (entry) {
        const turnIds = [...new Set((await this.rows('MessageTurnLink', { message_id: messageId })).map((row) => String(row.turn_id)))];
        const fresh: Array<[string, CollaborationInputEntry[]]> = [];
        for (const turnId of turnIds) if (!turnInputs.has(turnId)) fresh.push([turnId, await this.collaborationInputs(target, turnId)]);
        const cost = estimateJsonTokens(entry) + fresh.reduce((sum, [, inputs]) => sum + estimateJsonTokens(inputs), 0);
        if (newestFirst.length > 0 && spent + cost > TRANSCRIPT_PAGE_TOKENS) { pageFull = true; break; }
        for (const [turnId, inputs] of fresh) turnInputs.set(turnId, inputs);
        newestFirst.push(entry);
        for (const turnId of turnIds) oldestEntryOfTurn.set(turnId, newestFirst.length - 1);
        spent += cost;
      }
      consumed += 1;
    }
    const messages: Array<TranscriptEntry | CollaborationInputEntry> = [];
    for (let index = newestFirst.length - 1; index >= 0; index -= 1) {
      for (const [turnId, oldest] of oldestEntryOfTurn) if (oldest === index) messages.push(...turnInputs.get(turnId)!);
      messages.push(newestFirst[index]);
    }
    const hasMore = pageFull || links.length > limit;
    return {
      conversationId: target, title: await this.displayTitle(conversation), status: String(conversation.status), messages,
      olderMessageId: hasMore && consumed > 0 ? String(candidates[consumed - 1].message_id) : null, hasMore, pageFull
    };
  }

  /**
   * One page of a transcript message's visible text from a character offset, under the same read
   * authorization as readConversation. Following nextOffset until it is null returns it whole.
   */
  public async readConversationMessage(input: { conversationId: string; targetConversationId: string; messageId: string; offset?: number; crossConversationTurnId?: string }) {
    const target = await this.authorizeTranscriptRead(input);
    const messageId = requirePhaseFId(input.messageId, 'messageId');
    if ((await this.rows('MessagePartOfConversation', { conversation_id: target, message_id: messageId })).length !== 1) {
      throw new Error('That message reference is not a message of this conversation\'s transcript.');
    }
    const visible = await this.visibleTranscriptMessage(messageId, Number.POSITIVE_INFINITY);
    if (!visible) throw new Error('That transcript message was deleted or is not a user or assistant message.');
    return { conversationId: target, conversationMessageId: messageId, role: visible.role, createdAt: visible.createdAt,
      ...collaborationTextPage(visible.text ?? '', input.offset ?? 0) };
  }

  private async authorizeTranscriptRead(input: { conversationId: string; targetConversationId: string; crossConversationTurnId?: string }): Promise<string> {
    const caller = requirePhaseFId(input.conversationId, 'conversationId');
    const target = requirePhaseFId(input.targetConversationId, 'targetConversationId');
    if (input.crossConversationTurnId === undefined) await this.assertReadPermission(caller, target);
    else {
      const authorized = await this.authorizeCrossConversation({ turnId: input.crossConversationTurnId, targetConversationId: target });
      if (authorized.conversationId !== caller) throw new Error('Cross-conversation read Turn belongs to another Conversation.');
    }
    return target;
  }

  /**
   * The collaboration messages a Turn of the read Conversation took in: peer tasks, messages and
   * replies are no transcript Messages, yet without them a peer-driven Turn shows an answer with no
   * question. Each is a bounded preview; the full text stays private to its two Conversations.
   */
  private async collaborationInputs(conversationId: string, turnId: string): Promise<CollaborationInputEntry[]> {
    const deliveries = (await this.rows('RuntimeDelivery', { target_conversation_id: conversationId, state: 'consumed', target_turn_id: turnId }))
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)) || String(left.id).localeCompare(String(right.id)));
    const entries: CollaborationInputEntry[] = [];
    for (const delivery of deliveries) {
      const inbox = await this.existing('RuntimeInboxItem', String(delivery.inbox_item_id));
      if (inbox.source_kind !== 'collaboration_message') continue;
      const message = await this.existing('CollaborationMessage', String(inbox.source_id));
      const source = await this.one('CollaborationMessageSourceLink', { message_id: message.id });
      const payload = await this.one('CollaborationMessagePayloadLink', { message_id: message.id });
      const metadata = await this.existing('ContentObject', String(payload.content_object_id)) as ContentObjectMetadata;
      const page = collaborationTextPage((await this.contentStore.read(metadata)).toString('utf8'), 0, COLLABORATION_INPUT_PREVIEW_TOKENS);
      entries.push({ role: 'collaboration', mode: String(message.mode), sourceKind: String(source.source_kind),
        sourceConversationId: String(source.conversation_id), createdAt: String(message.created_at), text: page.text,
        ...(page.nextOffset === null ? {} : { shortened: true }) });
    }
    return entries;
  }

  /** A visible user or assistant message as one transcript entry: whole, or its first page when long. */
  private async transcriptEntry(messageId: string): Promise<TranscriptEntry | null> {
    const visible = await this.visibleTranscriptMessage(messageId, TRANSCRIPT_MESSAGE_READ_MAX_BYTES);
    if (!visible) return null;
    const base = { messageId, role: visible.role, createdAt: visible.createdAt };
    // Too large to read while listing: shown empty, its whole text is one paged read away.
    if (visible.text === null) return { ...base, text: '', truncated: true, sizeBytes: visible.sizeBytes, nextOffset: 0 };
    if (!visible.text.trim()) return null;
    const whole = { ...base, text: visible.text, truncated: false };
    if (estimateJsonTokens(whole) <= TRANSCRIPT_MESSAGE_PREVIEW_TOKENS) return whole;
    const page = collaborationTextPage(visible.text, 0, TRANSCRIPT_MESSAGE_PREVIEW_TOKENS - 100);
    return { ...base, text: page.text, truncated: true, totalCharacters: page.totalCharacters, nextOffset: page.nextOffset };
  }

  /** Visible text of a live user or assistant message; text is null above maxBytes. */
  private async visibleTranscriptMessage(messageId: string, maxBytes: number): Promise<{ role: string; createdAt: string; text: string | null; sizeBytes: number } | null> {
    const message = await this.existing('Message', messageId);
    if (message.deleted_at !== null) return null;
    const current = await this.rows('MessageCurrentRevisionLink', { message_id: messageId });
    if (current.length !== 1) throw new Error('Conversation transcript message has no unique current revision.');
    const revision = await this.existing('MessageRevision', String(current[0].revision_id));
    // The transcript carries what people and models said; tool activity stays out of it.
    if (revision.role !== 'user' && revision.role !== 'model') return null;
    const metadata = await this.existing('ContentObject', String(revision.content_object_id)) as ContentObjectMetadata;
    const sizeBytes = Number(metadata.byte_length);
    const text = sizeBytes > maxBytes ? null : visibleMessageText(String(metadata.content_type), (await this.contentStore.read(metadata)).toString('utf8'));
    return { role: String(revision.role), createdAt: String(revision.created_at), text, sizeBytes };
  }

  /**
   * The Turn's own switch and top-level placement authorize every cross-conversation action; an
   * optional target must be another active top-level Conversation of the caller's project. Child
   * task conversations stay inside their team on both sides. Every read, send and fork of another
   * Conversation passes here, so a reference obtained any other way never reaches another project.
   */
  public async authorizeCrossConversation(input: { turnId: string; targetConversationId?: string }): Promise<{ conversationId: string; projectContextId: string | null }> {
    const turn = await this.existing('Turn', requirePhaseFId(input.turnId, 'turnId'));
    const conversationId = String(turn.conversation_id);
    if (!await readTurnCrossConversationEnabled(this.database, this.contentStore, String(turn.id))) {
      throw new Error('Cross-conversation collaboration is not enabled for this Turn.');
    }
    if ((await this.rows('ChildExecution', { child_conversation_id: conversationId })).length) {
      throw new Error('Cross-conversation collaboration is only available to top-level conversations.');
    }
    const projectContextId = await this.projectOf(conversationId);
    if (input.targetConversationId === undefined) return { conversationId, projectContextId };
    const targetConversationId = requirePhaseFId(input.targetConversationId, 'targetConversationId');
    if (targetConversationId === conversationId) throw new Error('A cross-conversation action must target another Conversation.');
    const target = await this.existing('Conversation', targetConversationId);
    if (target.status !== 'active') throw new Error('Cross-conversation target is not an active Conversation.');
    if ((await this.rows('ChildExecution', { child_conversation_id: targetConversationId })).length) {
      throw new Error('Cross-conversation collaboration cannot address a child task conversation.');
    }
    if (await this.projectOf(targetConversationId) !== projectContextId) throw new Error(CROSS_PROJECT_REFUSAL);
    return { conversationId, projectContextId };
  }

  /**
   * The project a Conversation was created in, or null when it has none. A ConversationProjectLink
   * is written only with its Conversation and deleted only with it, so the answer never changes
   * while the Conversation exists and the checks that use it need no transaction assertion.
   */
  private async projectOf(conversationId: string): Promise<string | null> {
    const links = await this.rows('ConversationProjectLink', { conversation_id: conversationId });
    if (links.length > 1) throw new Error(`Conversation ${conversationId} has more than one project link.`);
    return links[0] ? String(links[0].project_context_id) : null;
  }

  /**
   * Runs every check that can refuse create_conversation's first task before the lifecycle writes
   * anything, settings included: the switch, a top-level live ToolCall in its active Turn, the
   * per-Turn creation limit and the automatic followup budget. The atomic send checks them again.
   */
  public async admitConversationCreation(input: { turnId: string; toolCallId: string }): Promise<void> {
    const turnId = requirePhaseFId(input.turnId, 'turnId');
    const toolCallId = requirePhaseFId(input.toolCallId, 'toolCallId');
    const { conversationId } = await this.authorizeCrossConversation({ turnId });
    const [turn, tool, terminations] = await Promise.all([this.existing('Turn', turnId), this.existing('ToolCall', toolCallId), this.rows('TurnTermination', { turn_id: turnId })]);
    if (tool.turn_id !== turnId || tool.tool_name !== 'create_conversation' || turn.status !== 'active' || terminations.length || tool.status === 'terminal') {
      throw new Error('Collaboration sender must be a live ToolCall in its exact active Turn.');
    }
    await this.assertConversationSpawnAllowed({ turnId, toolCallId });
    await this.availableFollowupBudget(turnId, (await readCollaborationScope(this.database, conversationId)).rootTurnId);
  }

  /** The collaboration message a tool call committed, if any; it outlives both Conversations. */
  public async toolCallMessage(toolCallIdInput: string): Promise<{ messageId: string; targetConversationId: string } | null> {
    const messageId = stablePhaseFId('collaboration_message', collaborationDedupeKey('tool', requirePhaseFId(toolCallIdInput, 'toolCallId')));
    if (!await this.maybe('CollaborationMessage', messageId)) return null;
    return { messageId, targetConversationId: String((await this.one('CollaborationMessageTargetLink', { message_id: messageId })).conversation_id) };
  }

  /**
   * One sender Turn may make at most CROSS_CONVERSATION_LIMITS.maxConversationSpawnsPerTurn
   * create_conversation and fork_conversation calls. Calls are ranked by their committed order, so
   * the verdict for a call never changes on replay and needs no write.
   */
  public async assertConversationSpawnAllowed(input: { turnId: string; toolCallId: string }): Promise<void> {
    const turnId = requirePhaseFId(input.turnId, 'turnId');
    const toolCallId = requirePhaseFId(input.toolCallId, 'toolCallId');
    const calls = (await this.rows('ToolCall', { turn_id: turnId }))
      .filter((call) => call.tool_name === 'create_conversation' || call.tool_name === 'fork_conversation')
      .sort((left, right) => compareSequence(left.call_seq, right.call_seq) || String(left.id).localeCompare(String(right.id)));
    const rank = calls.findIndex((call) => call.id === toolCallId);
    if (rank < 0) throw new Error('Conversation creation requires a create_conversation or fork_conversation ToolCall of this Turn.');
    const limit = CROSS_CONVERSATION_LIMITS.maxConversationSpawnsPerTurn;
    if (rank >= limit) throw new Error(`This turn already made ${limit} create_conversation or fork_conversation calls, the most one turn may make. Nothing was created; continue with the conversations that exist.`);
  }

  /**
   * Other active top-level Conversations of the caller's project, newest update first. The Runtime
   * is shared by every VS Code window, so the project, never the Runtime, bounds what is listed.
   */
  public async listConversations(input: { turnId: string; limit?: number }): Promise<CrossConversationListing> {
    const { conversationId, projectContextId } = await this.authorizeCrossConversation({ turnId: input.turnId });
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new RangeError('Conversation list limit must be 1..50.');
    const conversations: CrossConversationListing['conversations'] = [];
    let keyset: { column: string; value: string; id: string; direction: 'before' } | undefined;
    for (;;) {
      const page = (await this.database.snapshot([DOMAIN_REPOSITORIES.domain('Conversation').list({
        orderBy: { column: 'updated_at', direction: 'desc' }, ...(keyset ? { keyset } : {}), limit: 100
      })])).snapshot[0] as DomainRow[];
      for (const row of page) {
        const id = String(row.id);
        if (id === conversationId || row.status !== 'active') continue;
        if ((await this.rows('ChildExecution', { child_conversation_id: id })).length) continue;
        if (await this.projectOf(id) !== projectContextId) continue;
        if (conversations.length === limit) return { conversations, hasMore: true };
        const active = await this.database.snapshot([DOMAIN_REPOSITORIES.domain('Turn').list({ where: { conversation_id: id, status: 'active' }, limit: 1 })]);
        conversations.push({ conversationId: id, title: await this.displayTitle(row), running: (active.snapshot[0] as DomainRow[]).length > 0, updatedAt: String(row.updated_at) });
      }
      if (page.length < 100) return { conversations, hasMore: false };
      const last = page[page.length - 1];
      keyset = { column: 'updated_at', value: String(last.updated_at), id: String(last.id), direction: 'before' };
    }
  }

  /** The stored title, or for a placeholder its first user message, as the conversation list shows it. */
  private async displayTitle(conversation: DomainRow): Promise<string> {
    const id = String(conversation.id);
    const stored = displayConversationTitle({ id, title: String(conversation.title), maxLength: 80 });
    if (stored !== DEFAULT_CONVERSATION_TITLE) return stored;
    const links = (await this.database.snapshot([DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({ where: { conversation_id: id }, orderBy: { column: 'message_seq', direction: 'asc' }, limit: 16 })])).snapshot[0] as DomainRow[];
    for (const link of links) {
      const message = await this.existing('Message', String(link.message_id));
      const current = await this.rows('MessageCurrentRevisionLink', { message_id: link.message_id });
      if (message.deleted_at !== null || current.length !== 1) continue;
      const revision = await this.existing('MessageRevision', String(current[0].revision_id));
      if (revision.role !== 'user') continue;
      const metadata = await this.existing('ContentObject', String(revision.content_object_id)) as ContentObjectMetadata;
      if (metadata.byte_length > 256_000n) continue;
      const text = visibleMessageText(String(metadata.content_type), (await this.contentStore.read(metadata)).toString('utf8'));
      if (text.trim()) return displayConversationTitleFromText(text, 80);
    }
    return stored;
  }

  public async waitMessages(input: { conversationId: string; afterMessageId?: string; timeoutMs?: number; signal?: AbortSignal }) {
    const timeoutMs = input.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw new RangeError('Message wait timeout must be 0..60000 milliseconds.');
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const result = await this.listMessages(input);
      if (result.messages.length || input.signal?.aborted || Date.now() >= deadline) return { ...result, timedOut: !result.messages.length && !input.signal?.aborted, aborted: input.signal?.aborted ?? false };
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); unsubscribe(); input.signal?.removeEventListener('abort', done); resolve(); };
        const unsubscribe = this.database.onCommit(() => done());
        const timer = setTimeout(done, Math.min(1000, Math.max(1, deadline - Date.now())));
        input.signal?.addEventListener('abort', done, { once: true });
      });
    }
  }
  /**
   * Level-triggered recovery: input binding and completed-result replies survive every crash
   * boundary, and a task no Turn will answer is settled instead of staying pending.
   */
  public async reconcile(): Promise<void> {
    const requests = await this.rows('CollaborationRequest', { state: 'pending' });
    for (const request of requests) {
      const target = await this.one('CollaborationMessageTargetLink', { message_id: request.message_id });
      const deliveries = await this.rows('RuntimeDelivery', { inbox_item_id: target.inbox_item_id });
      const delivery = deliveries.find((row) => row.state === 'consumed');
      if (!delivery) {
        if (deliveries.length && deliveries.every((row) => row.state === 'failed')) {
          const [latest] = [...deliveries].sort(compareNewest);
          await this.failUnansweredRequest(request, `Task could not start: ${unstartedTaskReason(latest.failure_reason)}`);
        }
        continue;
      }
      // Acknowledged as a notification (for example to a child stopped meanwhile): no Turn took it in.
      if (delivery.target_turn_id === null) {
        await this.failUnansweredRequest(request, 'Task could not start: the target conversation could not take it.');
        continue;
      }
      // The Turn that took it in was deleted with its Conversation before the reply went out.
      if (!await this.maybe('Turn', String(delivery.target_turn_id))) {
        await this.failUnansweredRequest(request, 'Task ended without a result: the target conversation was deleted before it replied.');
        continue;
      }
      const links = await this.rows('CollaborationRequestTurnLink', { request_id: request.id });
      if (!links.length) {
        try { await this.database.transaction([DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(String(delivery.id), { state: 'consumed', target_turn_id: delivery.target_turn_id }), DOMAIN_REPOSITORIES.domain('CollaborationRequestTurnLink').insert({ id: stablePhaseFId('collaboration_request_turn', String(request.id)), request_id: request.id, turn_id: delivery.target_turn_id, created_at: this.now() })]); }
        catch (error) { if (!sqliteUniqueFailureIncludes(error, ['collaboration_request_turn_link.id', 'collaboration_request_turn_link.request_id'])) throw error; }
      }
      const terminal = await this.rows('TurnTermination', { turn_id: delivery.target_turn_id });
      if (terminal.length) await this.completeRequestsForTurn({ turnId: String(delivery.target_turn_id) });
    }
  }
  public async completeRequestsForTurn(input: { turnId: string; text?: string }): Promise<void> {
    const terminations = await this.rows('TurnTermination', { turn_id: input.turnId });
    if (terminations.length !== 1) return;
    const links = await this.rows('CollaborationRequestTurnLink', { turn_id: input.turnId });
    for (const link of links) {
      const request = await this.existing('CollaborationRequest', String(link.request_id));
      if (request.state !== 'pending') continue;
      const source = await this.one('CollaborationMessageSourceLink', { message_id: request.message_id });
      const target = await this.maybe('Conversation', String(source.conversation_id));
      if (!target || target.status !== 'active') { await this.finishRequest(request, 'failed'); continue; }
      const text = input.text ?? await this.finalText(input.turnId) ?? `Task ended with status ${String(terminations[0].terminal_status)}.`;
      try {
        await this.sendInternal({ source: { kind: 'completion', turnId: input.turnId, requestId: String(request.id) }, targetConversationId: String(source.conversation_id), text, mode: 'message', replyToMessageId: String(request.message_id) });
        await this.finishRequest(request, 'completed');
      } catch (error) {
        const targetChildren = await this.rows('ChildExecution', { child_conversation_id: source.conversation_id });
        if (targetChildren.some((child) => !['active', 'idle'].includes(String(child.status)))) { await this.finishRequest(request, 'failed'); continue; }
        throw error;
      }
    }
  }
  /**
   * A task no Turn will answer: every delivery failed (its target was deleted, or no continuation
   * could be admitted), it was acknowledged without a Turn, or the Turn that took it in was deleted
   * with its Conversation. A peer requester in another team is told so through the completion reply
   * path instead of waiting for an answer that cannot come. A team request keeps its original
   * contract and just fails: the team sees its members through its own tools.
   */
  private async failUnansweredRequest(request: DomainRow, text: string): Promise<void> {
    // A reply already committed before its Turn was deleted: only the settlement was lost.
    const replyId = stablePhaseFId('collaboration_message', collaborationDedupeKey('completion', String(request.id)));
    if (await this.maybe('CollaborationMessage', replyId)) {
      const replySource = await this.one('CollaborationMessageSourceLink', { message_id: replyId });
      await this.finishRequest(request, replySource.turn_id === null ? 'failed' : 'completed');
      return;
    }
    const source = await this.one('CollaborationMessageSourceLink', { message_id: request.message_id });
    const requester = await this.maybe('Conversation', String(source.conversation_id));
    if (requester?.status === 'active' && await isCrossConversationFollowup(this.database, String(request.message_id))) {
      try {
        await this.sendInternal({ source: { kind: 'completion', turnId: null, requestId: String(request.id) }, targetConversationId: String(source.conversation_id),
          text, mode: 'message', replyToMessageId: String(request.message_id) });
      } catch (error) {
        const requesterChildren = await this.rows('ChildExecution', { child_conversation_id: source.conversation_id });
        if (!requesterChildren.some((child) => !['active', 'idle'].includes(String(child.status)))) throw error;
      }
    }
    await this.finishRequest(request, 'failed');
  }
  private async requestTargetConversationId(requestId: string): Promise<string> {
    const request = await this.existing('CollaborationRequest', requirePhaseFId(requestId, 'requestId'));
    return String((await this.one('CollaborationMessageTargetLink', { message_id: request.message_id })).conversation_id);
  }
  private async finalText(turnId: string): Promise<string | null> {
    const fences = await this.rows('TurnFinalOutputFence', { turn_id: turnId });
    if (fences.length !== 1) return null;
    const requests = await this.rows('ModelRequestMessageLink', { model_request_id: fences[0].model_request_id });
    if (requests.length !== 1) return null;
    const links = await this.rows('MessageTurnLink', { turn_id: turnId, message_id: requests[0].message_id, role: 'model' });
    for (const link of links) {
      const current = await this.rows('MessageCurrentRevisionLink', { message_id: link.message_id });
      if (current.length !== 1) continue;
      const revision = await this.existing('MessageRevision', String(current[0].revision_id));
      if (!['assistant', 'model'].includes(String(revision.role))) continue;
      const content = await this.existing('ContentObject', String(revision.content_object_id)) as ContentObjectMetadata;
      const text = visibleMessageText(String(content.content_type), (await this.contentStore.read(content)).toString('utf8')).trim();
      if (text) return Buffer.byteLength(text) <= COLLABORATION_MESSAGE_MAX_TEXT_BYTES ? text : `${text.slice(0, 12000)}\n[Result truncated; read the destination task for the full answer.]`;
    }
    return null;
  }
  /**
   * Refuses a cross-conversation send while the target already holds the maximum undelivered
   * collaboration backlog: pending deliveries of collaboration messages other than completion
   * replies. Exactly that counted set is asserted, so concurrent senders cannot overshoot while
   * unrelated Process or answer deliveries never force a retry.
   */
  private async pendingInboundCapacitySteps(targetConversationId: string): Promise<RepositoryTransactionStep[]> {
    const limit = CROSS_CONVERSATION_LIMITS.maxPendingInboundMessages;
    const where = { target_conversation_id: targetConversationId, state: 'pending' };
    const backlog = (await this.database.snapshot([DOMAIN_REPOSITORIES.domain('RuntimeDelivery').list({ where, collaborationBacklog: true, limit })])).snapshot[0] as DomainRow[];
    if (backlog.length >= limit) {
      throw new Error(`The target conversation already has ${backlog.length} unread collaboration messages, the most it may hold. Nothing was sent, and no message or followup can be queued to it until it takes those in when its next turn starts.`);
    }
    return [DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assertExactIds(where, backlog.map((row) => String(row.id)), { collaborationBacklog: true })];
  }
  private async assertReadPermission(caller: string, target: string): Promise<void> {
    await this.existing('Conversation', caller);
    if (caller === target) return;
    const [callerScope, targetScope] = await Promise.all([readCollaborationScope(this.database, caller), readCollaborationScope(this.database, target)]);
    if (callerScope.rootConversationId !== targetScope.rootConversationId) throw new Error('Cross-conversation collaboration is not enabled.');
  }
  /**
   * Why a collaboration message cannot be read or answered by this Conversation. A fork or forked
   * child keeps the message refs of the history it copied, so its model is told where they come
   * from and what to do instead of a bare refusal.
   */
  private async foreignMessageError(conversationId: string, parties: readonly string[], use: 'read' | 'answer'): Promise<Error> {
    const sources = await forkSourceConversationIds(this.database, conversationId);
    const instead = use === 'answer' ? ' Send without replyToMessageRef instead.' : '';
    if (parties.some((party) => sources.includes(party))) {
      return new Error(`That message reference comes from history this conversation copied when it was forked: the message was exchanged by the conversation it was forked from, not by this one, so it cannot be ${use === 'read' ? 'read' : 'answered'} from here.${instead}`);
    }
    return new Error(use === 'read'
      ? 'Conversation cannot read another conversation\'s private messages.'
      : `A collaboration reply must reverse the exact original source and target: replyToMessageRef must name a message the target sent to this conversation.${instead}`);
  }

  /** The budget a followup from this Turn spends; refuses once its automatic followups are used up. */
  private async availableFollowupBudget(sourceTurnId: string, rootTurnId: string | null): Promise<{ budget: DomainRow; persisted: boolean; spendSteps: RepositoryTransactionStep[] }> {
    const budget = await this.budgetForTurn(sourceTurnId, rootTurnId);
    const persisted = await this.maybe('CollaborationBudget', String(budget.id));
    if (persisted && (persisted.origin_kind !== budget.origin_kind || persisted.origin_key !== budget.origin_key || persisted.authority_turn_id !== budget.authority_turn_id)) throw new Error('Collaboration budget identity conflicts.');
    const spend = await this.budgetSpend(String(budget.id), null);
    const limit = await this.followupBudgetLimit(String(budget.authority_turn_id));
    if (spend.spent >= limit) throw new Error(`Automatic followup budget exhausted (${limit}).`);
    return { budget, persisted: persisted !== null, spendSteps: spend.steps };
  }
  /**
   * What one automatic followup budget has spent: its automatic requests (followups and the first
   * tasks of create_conversation) plus every Turn a reply to one of them started in its idle
   * requester. The steps freeze exactly that spend for the transaction that adds to it; the reply
   * a starting Turn is admitted for is the one it may add.
   */
  private async budgetSpend(budgetId: string, startingReplyDeliveryId: string | null): Promise<{ spent: number; steps: RepositoryTransactionStep[] }> {
    const requests = await this.rows('CollaborationRequest', { budget_id: budgetId, automatic: 1n });
    const replyDeliveryIds = requests.map((request) => collaborationReplyDeliveryId(String(request.id)));
    const links = replyDeliveryIds.length === 0 ? [] : (await this.database.snapshot(replyDeliveryIds.map((deliveryId) =>
      DOMAIN_REPOSITORIES.domain('RuntimeDeliveryIntentLink').list({ where: { delivery_id: deliveryId }, limit: 1 })))).snapshot as DomainRow[][];
    // A reply continuation spends only while it opens (or opened) a Turn: one cancelled because
    // another Turn took its reply in never started anything. Cancellation is final, so this read
    // only ever overstates what the transaction below adds to.
    const replyTurns = await Promise.all(links.map(async (rows) => rows.length > 0
      && !await this.isCancelledIntent(String(rows[0].turn_intent_id))));
    return {
      spent: requests.length + replyTurns.filter(Boolean).length,
      steps: [
        DOMAIN_REPOSITORIES.domain('CollaborationRequest').assertExactIds({ budget_id: budgetId, automatic: 1n }, requests.map((row) => String(row.id))),
        ...replyDeliveryIds.filter((deliveryId, index) => links[index].length === 0 && deliveryId !== startingReplyDeliveryId)
          .map((deliveryId) => DOMAIN_REPOSITORIES.domain('RuntimeDeliveryIntentLink').assertNone({ delivery_id: deliveryId }))
      ]
    };
  }
  /**
   * The Turn a reply to a cross-conversation task starts in its idle requester spends the budget of
   * the task it answers, so two conversations trading followups and replies stay bounded. The
   * returned steps commit with that Turn's TurnIntent; every other runtime continuation spends
   * nothing here. A spent budget, or a deleted Conversation that funded it, throws
   * CollaborationReplyBudgetExhaustedError: the reply then waits for the requester's next Turn.
   */
  public async prepareReplyContinuationSteps(deliveryIdInput: string): Promise<RepositoryTransactionStep[]> {
    const deliveryId = requirePhaseFId(deliveryIdInput, 'deliveryId');
    const delivery = await this.existing('RuntimeDelivery', deliveryId);
    const inbox = await this.existing('RuntimeInboxItem', String(delivery.inbox_item_id));
    if (inbox.source_kind !== 'collaboration_message') return [];
    const request = await this.answeredCrossConversationRequest(String(inbox.source_id));
    if (!request) return [];
    const budget = await this.existing('CollaborationBudget', String(request.budget_id));
    const authorityTurnId = String(budget.authority_turn_id);
    if (!await this.maybe('Turn', authorityTurnId)) throw new CollaborationReplyBudgetExhaustedError('The conversation that started this task was deleted, so its reply starts no turn.');
    const limit = (await readTurnCollaborationLimits(this.database, this.contentStore, authorityTurnId)).maxAutomaticFollowups;
    const spend = await this.budgetSpend(String(budget.id), deliveryId);
    if (spend.spent >= limit) throw new CollaborationReplyBudgetExhaustedError(`Automatic followup budget exhausted (${limit}); the reply waits for the next turn.`);
    return spend.steps;
  }
  /** The cross-conversation request a completion or failure reply answers; null for any other message. */
  private async answeredCrossConversationRequest(messageId: string): Promise<DomainRow | null> {
    if (!await isCrossConversationReply(this.database, messageId)) return null;
    const reply = await this.one('CollaborationMessageReplyLink', { message_id: messageId });
    return this.one('CollaborationRequest', { message_id: reply.request_message_id });
  }
  /**
   * The budget's limit is frozen in the Turn that started the chain. Deleting that Turn's
   * Conversation ends the chain it funded: the tasks it started may finish their own work and send
   * plain messages, but they no longer spend its budget on followups or new conversations.
   */
  private async followupBudgetLimit(authorityTurnId: string): Promise<number> {
    try { return (await readTurnCollaborationLimits(this.database, this.contentStore, authorityTurnId)).maxAutomaticFollowups; }
    catch (error) {
      if (await this.maybe('Turn', authorityTurnId)) throw error;
      throw new Error('The conversation that started this task was deleted, so this turn can no longer send followups or create conversations. Nothing was sent; plain messages still work.');
    }
  }
  private async budgetForTurn(sourceTurnId: string, rootTurnId: string | null): Promise<DomainRow> {
    const visit = async (turnId: string, ancestryRoot: string | null, seen: Set<string>): Promise<DomainRow> => {
      if (seen.has(turnId)) throw new Error('Collaboration budget lineage is cyclic.');
      seen.add(turnId);
      // A Turn started for a peer's followup spends that request's budget, whatever else it absorbed.
      const started = await this.startingFollowupBudget(turnId);
      if (started) return started;
      const inputs = await this.rows('RuntimeDelivery', { target_turn_id: turnId, state: 'consumed' });
      const budgets = new Map<string, DomainRow>();
      for (const delivery of inputs) {
        const inbox = await this.existing('RuntimeInboxItem', String(delivery.inbox_item_id));
        if (inbox.source_kind !== 'collaboration_message') continue;
        const requests = await this.rows('CollaborationRequest', { message_id: inbox.source_id });
        if (!requests[0]) continue;
        const budget = await this.existing('CollaborationBudget', String(requests[0].budget_id));
        budgets.set(String(budget.id), budget);
      }
      // Unrelated agent requests cannot pool budgets or select one by an arbitrary id ordering.
      if (budgets.size > 1) throw new Error('Collaboration cannot combine independent root Turn followup budgets.');
      if (budgets.size === 1) return [...budgets.values()][0];
      if (ancestryRoot && ancestryRoot !== turnId) return visit(ancestryRoot, null, seen);
      const turn = await this.existing('Turn', turnId);
      const scope = await readCollaborationScope(this.database, String(turn.conversation_id));
      if (scope.rootTurnId && scope.rootTurnId !== turnId && scope.rootConversationId !== turn.conversation_id) return visit(scope.rootTurnId, null, seen);
      const intents = await this.rows('TurnIntent', { turn_id: turnId });
      const continuationSources = new Set<string>();
      for (const intent of intents) {
        const revisions = await this.database.snapshot([DOMAIN_REPOSITORIES.domain('TurnIntentRevision').list({ where: { intent_id: intent.id }, orderBy: { column: 'revision_seq', direction: 'desc' }, limit: 1 })]);
        const revision = (revisions.snapshot[0] as DomainRow[])[0];
        if (!revision) throw new Error('Collaboration budget TurnIntent has no revision.');
        const metadata = await this.existing('ContentObject', String(revision.content_object_id)) as ContentObjectMetadata;
        if (metadata.content_type !== TURN_INTENT_ENVELOPE_CONTENT_TYPE) continue;
        const continuation = parseRuntimeContinuationTurnIntentEnvelopeText((await this.contentStore.read(metadata)).toString('utf8'));
        // A collaboration continuation has no source Turn; its budget arrives through the delivery above.
        if (continuation?.sourceTurnId) continuationSources.add(continuation.sourceTurnId);
      }
      if (continuationSources.size > 1) throw new Error('Collaboration budget has conflicting automatic continuation sources.');
      if (continuationSources.size === 1) return visit([...continuationSources][0], null, seen);
      return { id: stablePhaseFId('collaboration_budget', 'turn', turnId), origin_kind: 'turn', origin_key: turnId, authority_turn_id: turnId, created_at: this.now() };
    };
    return visit(sourceTurnId, rootTurnId, new Set());
  }
  /**
   * The budget of the cross-conversation followup, or of the task a reply answers, whose runtime
   * continuation admitted this Turn, if any. Team and child continuations keep pooling what they
   * absorbed, so their independent root budgets still refuse to combine.
   */
  private async startingFollowupBudget(turnId: string): Promise<DomainRow | null> {
    for (const intent of await this.rows('TurnIntent', { turn_id: turnId })) {
      const links = await this.rows('RuntimeDeliveryIntentLink', { turn_intent_id: intent.id });
      if (links.length !== 1) continue;
      const delivery = await this.existing('RuntimeDelivery', String(links[0].delivery_id));
      if (delivery.target_turn_id !== turnId) continue;
      const inbox = await this.existing('RuntimeInboxItem', String(delivery.inbox_item_id));
      if (inbox.source_kind !== 'collaboration_message') continue;
      const answered = await this.answeredCrossConversationRequest(String(inbox.source_id));
      if (answered) return this.existing('CollaborationBudget', String(answered.budget_id));
      if (!await isCrossConversationFollowup(this.database, String(inbox.source_id))) continue;
      const requests = await this.rows('CollaborationRequest', { message_id: inbox.source_id });
      if (requests.length === 1) return this.existing('CollaborationBudget', String(requests[0].budget_id));
    }
    return null;
  }
  private async isCancelledIntent(turnIntentId: string): Promise<boolean> {
    return (await this.maybe('TurnIntent', turnIntentId))?.state === 'cancelled';
  }
  private async finishRequest(request: DomainRow, state: string): Promise<void> {
    try { await this.database.transaction([DOMAIN_REPOSITORIES.domain('CollaborationRequest').assert(String(request.id), { state: 'pending' }), DOMAIN_REPOSITORIES.domain('CollaborationRequest').update(String(request.id), { state, updated_at: this.now() })]); }
    catch (error) { if (!isTransactionAssertionFailure(error)) throw error; }
  }
  private async summary(message: DomainRow): Promise<CollaborationMessageSummary> {
    const [source, target, replies] = await Promise.all([this.one('CollaborationMessageSourceLink', { message_id: message.id }), this.one('CollaborationMessageTargetLink', { message_id: message.id }), this.rows('CollaborationMessageReplyLink', { message_id: message.id })]);
    const deliveries = await this.rows('RuntimeDelivery', { inbox_item_id: target.inbox_item_id });
    const delivery = deliveries.sort(compareNewest)[0];
    const inputs = delivery ? await this.rows('RuntimeDeliveryInputLink', { delivery_id: delivery.id }) : [];
    return { messageId: String(message.id), sourceConversationId: String(source.conversation_id), targetConversationId: String(target.conversation_id), mode: message.mode as 'message' | 'followup', sourceKind: String(source.source_kind), createdAt: String(message.created_at), replyToMessageId: replies[0] ? String(replies[0].request_message_id) : null, deliveryState: String(delivery?.state ?? 'pending'), handled: inputs[0]?.handled_at != null };
  }
  private rows(domain: string, where: DomainRow = {}) { return listAllDomainRows(this.database, domain, where); }
  private async one(domain: string, where: DomainRow): Promise<DomainRow> { const rows = await this.rows(domain, where); if (rows.length !== 1) throw new Error(`${domain} requires exactly one matching fact.`); return rows[0]; }
  private async maybe(domain: string, id: string): Promise<DomainRow | null> { return (await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)])).snapshot[0] as DomainRow | null; }
  private async existing(domain: string, id: string): Promise<DomainRow> { const row = await this.maybe(domain, id); if (!row) throw new Error(`${domain} ${id} does not exist.`); return row; }
}
function collaborationDedupeKey(sourceKind: string, sourceKey: string): string {
  return `collaboration:${sourceKind}:${sourceKey}`;
}
/** The delivery of the one completion or failure reply a request gets, as sendInternal names it. */
function collaborationReplyDeliveryId(requestId: string): string {
  return stablePhaseFId('runtime_delivery', 'collaboration', stablePhaseFId('collaboration_message', collaborationDedupeKey('completion', requestId)));
}
/** A Conversation inserted by the same transaction: top-level, alone in its team, without Turns. */
function newTopLevelScope(conversationId: string): CollaborationScope {
  return {
    rootConversationId: conversationId, rootTurnId: null,
    members: [{ conversationId, childExecutionId: null, parentConversationId: null, status: 'active' }],
    authoritySteps: [DOMAIN_REPOSITORIES.domain('ChildExecution').assertNone({ child_conversation_id: conversationId })]
  };
}
function compareSequence(left: unknown, right: unknown): number {
  const a = BigInt(String(left));
  const b = BigInt(String(right));
  return a < b ? -1 : a > b ? 1 : 0;
}
function unstartedTaskReason(failureReason: unknown): string {
  const reason = typeof failureReason === 'string' ? failureReason : '';
  if (reason === 'target-gone') return 'the target conversation was deleted.';
  if (reason.startsWith('wake-dead-letter:')) return `the target conversation could not start a turn (${reason.slice('wake-dead-letter:'.length).slice(0, 500)}).`;
  return reason ? `${reason.slice(0, 500)}.` : 'its delivery failed.';
}
function compareNewest(a: DomainRow, b: DomainRow): number { return String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)); }

/**
 * Each page of a paged message read stays well under the model tool-result cap
 * (TOOL_RESULT_MAX_TOKENS), leaving room for the result's own fields, and is also bounded in
 * characters because whitespace barely counts in the estimate.
 */
export const COLLABORATION_TEXT_PAGE_TOKENS = 2_400;
export const COLLABORATION_TEXT_PAGE_MAX_CHARACTERS = 12_000;

/**
 * A read_conversation page spends at most TRANSCRIPT_PAGE_TOKENS on its entries and one entry at
 * most TRANSCRIPT_MESSAGE_PREVIEW_TOKENS, so the whole result, with its notice, title and cursor,
 * stays under the model tool-result cap. Listing never reads a message above
 * TRANSCRIPT_MESSAGE_READ_MAX_BYTES; readConversationMessage pages any message.
 */
export const TRANSCRIPT_PAGE_TOKENS = 3_000;
export const TRANSCRIPT_MESSAGE_PREVIEW_TOKENS = 2_000;
const TRANSCRIPT_MESSAGE_READ_MAX_BYTES = 256_000;

const COLLABORATION_INPUT_PREVIEW_TOKENS = 400;

interface TranscriptEntry {
  messageId: string; role: string; createdAt: string; text: string; truncated: boolean;
  totalCharacters?: number; sizeBytes?: number; nextOffset?: number | null;
}

/** A collaboration message a Turn took in, shown in the transcript before that Turn's messages. */
interface CollaborationInputEntry {
  role: 'collaboration'; mode: string; sourceKind: string; sourceConversationId: string; createdAt: string; text: string; shortened?: true;
}

/**
 * One page of a stored text from a UTF-16 character offset: the longest slice whose JSON-escaped
 * estimate fits maxTokens, never splitting a surrogate pair. nextOffset is null once the text ends.
 */
export function collaborationTextPage(text: string, offset: number, maxTokens = COLLABORATION_TEXT_PAGE_TOKENS): {
  text: string; offset: number; nextOffset: number | null; totalCharacters: number;
} {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
    throw new RangeError(`offset must be an integer from 0 to ${text.length}, the message length in characters.`);
  }
  const fits = (end: number) => estimateTextTokens(JSON.stringify(text.slice(offset, end))) <= maxTokens;
  let end = Math.min(text.length, offset + COLLABORATION_TEXT_PAGE_MAX_CHARACTERS);
  if (!fits(end)) {
    let low = offset + 1;
    let high = end - 1;
    end = low;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      if (fits(middle)) { end = middle; low = middle + 1; } else high = middle - 1;
    }
  }
  if (end < text.length && end > offset + 1 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  if (end < text.length && end === offset + 1 && isHighSurrogate(text.charCodeAt(offset))) end += 1;
  return { text: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null, totalCharacters: text.length };
}

function isHighSurrogate(code: number): boolean { return code >= 0xd800 && code <= 0xdbff; }

function visibleMessageText(contentType: string, raw: string): string {
  if (contentType.toLowerCase().startsWith('text/plain')) return raw;
  if (contentType !== 'application/vnd.limcode.message+json') throw new Error(`Unsupported Conversation message content type ${contentType}.`);
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as { parts?: unknown }).parts)) throw new Error('Conversation message JSON requires a parts array.');
  return ((value as { parts: unknown[] }).parts).filter((part): part is { text: string; thought?: boolean } => Boolean(part) && typeof part === 'object' && !Array.isArray(part) && typeof (part as { text?: unknown }).text === 'string')
    .filter((part) => part.thought !== true).map((part) => part.text).join('\n');
}
