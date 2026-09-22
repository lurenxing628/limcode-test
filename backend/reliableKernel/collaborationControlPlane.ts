import { createHash } from 'node:crypto';
import { RuntimeDeliveryControlPlane } from './answerDelivery';
import { AutomaticRuntimeDeliveryRouter } from './automaticRuntimeDelivery';
import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import { readCollaborationScope } from './collaborationScope';
import { readTurnCollaborationLimits } from './collaborationPolicy';
import { TURN_INTENT_ENVELOPE_CONTENT_TYPE, parseRuntimeContinuationTurnIntentEnvelopeText } from './guidanceIntent';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { isTransactionAssertionFailure, requirePhaseFId, stablePhaseFId, sqliteUniqueFailureIncludes } from './phaseFIdentity';
import type { RuntimeDatabase } from './runtimeDatabase';

export const COLLABORATION_MESSAGE_CONTENT_TYPE = 'text/vnd.limcode.collaboration-message';
const MAX_TEXT_BYTES = 64_000;
export type CollaborationSource = { kind: 'tool'; turnId: string; toolCallId: string } | { kind: 'user'; conversationId: string; commandId: string };
interface CompletionSource { kind: 'completion'; turnId: string; requestId: string }
interface BoardSource { kind: 'board'; turnId: string | null; postId: string; conversationId: string }
export interface CollaborationSendCommand {
  source: CollaborationSource;
  targetConversationId: string;
  text: string;
  mode: 'message' | 'followup';
  replyToMessageId?: string;
  /** Trusted runtime-only guard for running-member notifications. No idle message is committed. */
  onlyIfRunning?: boolean;
}
export interface CollaborationMessageSummary {
  messageId: string; sourceConversationId: string; targetConversationId: string;
  mode: 'message' | 'followup'; sourceKind: string; createdAt: string;
  replyToMessageId: string | null; deliveryState: string; handled: boolean;
}
export interface ConversationCommunicationPermission {
  sourceConversationId: string; targetConversationId: string; allowRead: boolean; allowSend: boolean; allowWake: boolean;
}
export class CollaborationControlPlane {
  private readonly now: () => string;
  private readonly router: AutomaticRuntimeDeliveryRouter;
  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly deliveries: RuntimeDeliveryControlPlane,
    options: { now?: () => string } = {}
  ) { this.now = options.now ?? (() => new Date().toISOString()); this.router = new AutomaticRuntimeDeliveryRouter(database); }

  public async listMembers(conversationId: string) {
    await this.existing('Conversation', conversationId);
    const scope = await readCollaborationScope(this.database, conversationId);
    const members = await Promise.all(scope.members.map(async (member) => ({ ...member, title: String((await this.existing('Conversation', member.conversationId)).title), allowRead: true, allowSend: member.conversationId !== conversationId && (!member.childExecutionId || ['active', 'idle'].includes(member.status)), allowWake: member.conversationId !== conversationId && (!member.childExecutionId || ['active', 'idle'].includes(member.status)), relation: 'team' as 'team' | 'permitted' })));
    for (const permission of await this.listPermissions(conversationId)) {
      if (!(permission.allowRead || permission.allowSend || permission.allowWake) || members.some((member) => member.conversationId === permission.targetConversationId)) continue;
      const target = await this.maybe('Conversation', permission.targetConversationId);
      if (target && target.status === 'active') members.push({ conversationId: permission.targetConversationId, childExecutionId: null, parentConversationId: null, status: String(target.status), title: String(target.title), allowRead: permission.allowRead, allowSend: permission.allowSend, allowWake: permission.allowWake, relation: 'permitted' });
    }
    return { rootConversationId: scope.rootConversationId, members };
  }

  /** User-facing discovery only. Model tools receive listMembers instead. */
  public async listPermissionCandidates(conversationId: string): Promise<Array<{ conversationId: string; title: string }>> {
    await this.existing('Conversation', conversationId);
    const children = new Set((await this.rows('ChildExecution')).map((row) => String(row.child_conversation_id)));
    if (children.has(conversationId)) return [];
    return (await this.rows('Conversation', { status: 'active' })).filter((row) => row.id !== conversationId && !children.has(String(row.id)))
      .map((row) => ({ conversationId: String(row.id), title: String(row.title) }));
  }
  public async listPermissions(conversationId: string): Promise<ConversationCommunicationPermission[]> {
    return (await this.rows('ConversationCommunicationLink', { source_conversation_id: conversationId })).map(permissionView);
  }
  /** This command is exposed only through the authenticated user bridge, never as an agent tool. */
  public async setPermission(input: ConversationCommunicationPermission & { commandId: string }): Promise<ConversationCommunicationPermission> {
    const source = requirePhaseFId(input.sourceConversationId, 'sourceConversationId');
    const target = requirePhaseFId(input.targetConversationId, 'targetConversationId');
    const commandId = requirePhaseFId(input.commandId, 'commandId');
    if (source === target) throw new Error('Conversation communication permission requires distinct Conversations.');
    if (![input.allowRead, input.allowSend, input.allowWake].every((entry) => typeof entry === 'boolean')) throw new TypeError('Communication permission flags must be booleans.');
    if (input.allowWake && !input.allowSend) throw new Error('Waking a Conversation requires send permission.');
    const [sourceRow, targetRow, sourceChildren, targetChildren] = await Promise.all([this.existing('Conversation', source), this.existing('Conversation', target), this.rows('ChildExecution', { child_conversation_id: source }), this.rows('ChildExecution', { child_conversation_id: target })]);
    if (sourceChildren.length || targetChildren.length) throw new Error('Explicit conversation permissions cannot bypass child team authority.');
    const id = stablePhaseFId('conversation_communication_link', source, target);
    const receiptId = stablePhaseFId('command_receipt', 'conversation-communication-permission', commandId);
    const digest = createHash('sha256').update(JSON.stringify({ source, target, allowRead: input.allowRead, allowSend: input.allowSend, allowWake: input.allowWake })).digest('hex');
    const receiptKey = `conversation-communication-permission:${commandId}:${digest}`;
    const replay = async (): Promise<ConversationCommunicationPermission | null> => {
      const receipt = await this.maybe('CommandReceipt', receiptId);
      if (!receipt) return null;
      if (receipt.source_kind !== 'command' || receipt.source_key !== receiptKey || receipt.conversation_id !== source || receipt.turn_id !== null) throw new Error('Communication permission command replay conflicts.');
      const current = await this.maybe('ConversationCommunicationLink', id);
      // Replaying an earlier grant after a later revoke observes the current link; it cannot grant
      // again. The receipt and original mutation were committed in the same transaction.
      return current ? permissionView(current) : { sourceConversationId: source, targetConversationId: target, allowRead: false, allowSend: false, allowWake: false };
    };
    const replayed = await replay(); if (replayed) return replayed;
    const old = await this.maybe('ConversationCommunicationLink', id);
    if (old?.command_id === commandId && (old.allow_read !== (input.allowRead ? 1n : 0n) || old.allow_send !== (input.allowSend ? 1n : 0n) || old.allow_wake !== (input.allowWake ? 1n : 0n))) throw new Error('Communication permission command replay conflicts.');
    const now = this.now();
    const patch = { allow_read: input.allowRead ? 1n : 0n, allow_send: input.allowSend ? 1n : 0n, allow_wake: input.allowWake ? 1n : 0n, command_id: commandId, updated_at: now };
    try {
      await this.database.transaction([
      DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({ id: receiptId, source_kind: 'command', source_key: receiptKey, conversation_id: source, turn_id: null, created_at: now }),
      DOMAIN_REPOSITORIES.domain('Conversation').assert(source, { status: sourceRow.status }),
      DOMAIN_REPOSITORIES.domain('Conversation').assert(target, { status: targetRow.status }),
      DOMAIN_REPOSITORIES.domain('ChildExecution').assertNone({ child_conversation_id: source }),
      DOMAIN_REPOSITORIES.domain('ChildExecution').assertNone({ child_conversation_id: target }),
      ...(old ? [DOMAIN_REPOSITORIES.domain('ConversationCommunicationLink').assert(id, { command_id: old.command_id }), DOMAIN_REPOSITORIES.domain('ConversationCommunicationLink').update(id, patch)] : [DOMAIN_REPOSITORIES.domain('ConversationCommunicationLink').insert({ id, source_conversation_id: source, target_conversation_id: target, ...patch, created_at: now })])
    ]);
    } catch (error) {
      if (!isTransactionAssertionFailure(error) && !sqliteUniqueFailureIncludes(error, ['command_receipt.id', 'command_receipt.source_kind, command_receipt.source_key', 'conversation_communication_link.id', 'conversation_communication_link.source_conversation_id, conversation_communication_link.target_conversation_id'])) throw error;
      const raced = await replay(); if (raced) return raced;
      throw error;
    }
    return permissionView(await this.existing('ConversationCommunicationLink', id));
  }

  public async send(input: CollaborationSendCommand) {
    for (let attempt = 0; ; attempt += 1) {
      try { return await this.sendInternal(input); }
      catch (error) { if (attempt >= 3 || (!isTransactionAssertionFailure(error) && !sqliteUniqueFailureIncludes(error, ['collaboration_budget.id', 'collaboration_budget.origin_kind, collaboration_budget.origin_key']))) throw error; }
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
      await this.sendInternal({ source: { kind: 'board', postId, conversationId: notice.sourceConversationId, turnId: source.source_turn_id === null ? null : String(source.source_turn_id) }, targetConversationId: notice.targetConversationId, text: `Team board update. Use agent_board list_channels/list_threads to read the full post.\n${content}`, mode: 'message', onlyIfRunning: true });
      return { status: 'delivered' };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (isTransactionAssertionFailure(error) || /target is idle|completed its output|cannot revive/.test(detail)) return { status: 'skipped_idle', reason: detail };
      return { status: 'failed', reason: detail };
    }
  }

  private async sendInternal(input: Omit<CollaborationSendCommand, 'source'> & { source: CollaborationSource | CompletionSource | BoardSource }) {
    if (input.mode !== 'message' && input.mode !== 'followup') throw new TypeError('Unsupported collaboration delivery mode.');
    if (typeof input.text !== 'string' || !input.text.trim() || Buffer.byteLength(input.text) > MAX_TEXT_BYTES) throw new RangeError(`Collaboration text must contain 1..${MAX_TEXT_BYTES} UTF-8 bytes.`);
    const targetConversationId = requirePhaseFId(input.targetConversationId, 'targetConversationId');
    const source = input.source;
    const sourceKey = source.kind === 'tool' ? requirePhaseFId(source.toolCallId, 'toolCallId') : source.kind === 'user' ? requirePhaseFId(source.commandId, 'commandId') : source.kind === 'completion' ? requirePhaseFId(source.requestId, 'requestId') : stablePhaseFId('board_notice', source.postId, targetConversationId);
    const dedupeKey = `collaboration:${source.kind}:${sourceKey}`;
    const messageId = stablePhaseFId('collaboration_message', dedupeKey);
    const inboxItemId = stablePhaseFId('runtime_inbox_item', messageId);
    const deliveryId = stablePhaseFId('runtime_delivery', 'collaboration', messageId);
    const replyToMessageId = input.replyToMessageId ? requirePhaseFId(input.replyToMessageId, 'replyToMessageId') : null;
    const sourceTurn = source.kind === 'user' || (source.kind === 'board' && source.turnId === null) ? null : await this.existing('Turn', requirePhaseFId(source.turnId, 'turnId'));
    const sourceConversationId = source.kind === 'user' || source.kind === 'board' ? requirePhaseFId(source.conversationId, 'conversationId') : String(sourceTurn!.conversation_id);
    if (targetConversationId === sourceConversationId) throw new Error('A collaboration message must target another Conversation.');
    const prepared = await this.contentStore.prepare(this.database, input.text, COLLABORATION_MESSAGE_CONTENT_TYPE);
    const replay = async () => {
      const message = await this.maybe('CollaborationMessage', messageId);
      if (!message) return null;
      const [origins, targets, payloads, replies] = await Promise.all([this.rows('CollaborationMessageSourceLink', { message_id: messageId }), this.rows('CollaborationMessageTargetLink', { message_id: messageId }), this.rows('CollaborationMessagePayloadLink', { message_id: messageId }), this.rows('CollaborationMessageReplyLink', { message_id: messageId })]);
      if (message.mode !== input.mode || origins.length !== 1 || origins[0].conversation_id !== sourceConversationId || origins[0].turn_id !== (sourceTurn?.id ?? null) || targets.length !== 1 || targets[0].conversation_id !== targetConversationId || payloads.length !== 1 || payloads[0].content_object_id !== prepared.metadata.id || (replies[0]?.request_message_id ?? null) !== replyToMessageId) throw new Error('Collaboration send replay conflicts with immutable message facts.');
      return { messageId, inboxItemId, deliveryId, mode: input.mode, accepted: true as const, deduplicated: true };
    };
    const existing = await replay(); if (existing) return existing;
    const target = await this.existing('Conversation', targetConversationId);
    const origin = await this.existing('Conversation', sourceConversationId);
    if (target.status !== 'active' || origin.status !== 'active') throw new Error('Collaboration requires active Conversations.');
    let sourceSteps: RepositoryTransactionStep[] = [];
    if (source.kind === 'board') {
      const boardSource = await this.one('CollaborationBoardPostSourceLink', { post_id: source.postId });
      if (boardSource.conversation_id !== sourceConversationId || boardSource.source_turn_id !== source.turnId) throw new Error('Board notification source conflicts with immutable post source.');
      sourceSteps.push(DOMAIN_REPOSITORIES.domain('CollaborationBoardPostSourceLink').assert(String(boardSource.id), { post_id: source.postId, conversation_id: sourceConversationId, source_turn_id: source.turnId }));
    }
    if (source.kind === 'tool') {
      const tool = await this.existing('ToolCall', source.toolCallId);
      if (tool.turn_id !== source.turnId || sourceTurn!.status !== 'active' || tool.status === 'terminal') throw new Error('Collaboration sender must be a live ToolCall in its exact active Turn.');
      sourceSteps = [DOMAIN_REPOSITORIES.domain('Turn').assert(source.turnId, { status: 'active', conversation_id: sourceConversationId }), DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: source.turnId }), DOMAIN_REPOSITORIES.domain('ToolCall').assert(source.toolCallId, { turn_id: source.turnId, status: tool.status })];
    }
    const sourceScope = await readCollaborationScope(this.database, sourceConversationId);
    const targetScope = await readCollaborationScope(this.database, targetConversationId);
    const sourceMember = sourceScope.members.find((entry) => entry.conversationId === sourceConversationId);
    if (source.kind === 'tool' && sourceMember?.childExecutionId && sourceMember.status !== 'active') throw new Error('A stopped child cannot initiate collaboration.');
    const targetMember = targetScope.members.find((entry) => entry.conversationId === targetConversationId)!;
    if (targetMember.childExecutionId && !['active', 'idle'].includes(targetMember.status)) throw new Error('Collaboration cannot revive a stopped, closed or starting child task.');
    let permissionSteps: RepositoryTransactionStep[] = [];
    if (sourceScope.rootConversationId !== targetScope.rootConversationId) {
      if (source.kind === 'board') throw new Error('Board notifications cannot cross team roots.');
      const permission = await this.maybe('ConversationCommunicationLink', stablePhaseFId('conversation_communication_link', sourceConversationId, targetConversationId));
      if (source.kind !== 'completion') {
        if (!permission || permission.allow_send !== 1n || (input.mode === 'followup' && permission.allow_wake !== 1n)) throw new Error('Conversation communication is not authorized.');
        permissionSteps = [DOMAIN_REPOSITORIES.domain('ConversationCommunicationLink').assert(String(permission.id), { allow_send: 1n, ...(input.mode === 'followup' ? { allow_wake: 1n } : {}) })];
      }
    }
    if (replyToMessageId) {
      const previousSource = await this.one('CollaborationMessageSourceLink', { message_id: replyToMessageId });
      const previousTarget = await this.one('CollaborationMessageTargetLink', { message_id: replyToMessageId });
      if (previousSource.conversation_id !== targetConversationId || previousTarget.conversation_id !== sourceConversationId) throw new Error('A collaboration reply must reverse the exact original source and target.');
      sourceSteps.push(DOMAIN_REPOSITORIES.domain('CollaborationMessageSourceLink').assert(String(previousSource.id), { conversation_id: targetConversationId }), DOMAIN_REPOSITORIES.domain('CollaborationMessageTargetLink').assert(String(previousTarget.id), { conversation_id: sourceConversationId }));
    }
    if (source.kind === 'completion') {
      if (!replyToMessageId) throw new Error('Completion requires a durable reply request.');
      const request = await this.existing('CollaborationRequest', source.requestId);
      if (request.message_id !== replyToMessageId) throw new Error('Completion reply request mismatch.');
      const requestTurn = await this.one('CollaborationRequestTurnLink', { request_id: source.requestId });
      if (requestTurn.turn_id !== source.turnId) throw new Error('Completion cannot answer a different task generation.');
      sourceSteps.push(DOMAIN_REPOSITORIES.domain('CollaborationRequest').assert(source.requestId, { state: request.state, message_id: replyToMessageId }), DOMAIN_REPOSITORIES.domain('CollaborationRequestTurnLink').assert(String(requestTurn.id), { turn_id: source.turnId }));
    }
    const turns = await this.rows('Turn', { conversation_id: targetConversationId });
    turns.sort(compareNewest);
    const active = turns.filter((turn) => turn.status === 'active');
    if (active.length > 1) throw new Error('Collaboration target has multiple active Turns.');
    const anchor = active[0] ?? turns[0];
    if (input.onlyIfRunning && !active[0]) throw new Error('Collaboration notification target is idle.');
    if (input.mode === 'followup' && !anchor) throw new Error('Start the destination Conversation before sending a followup.');
    const fence = active[0] ? await this.rows('TurnFinalOutputFence', { turn_id: active[0].id }) : [];
    if (input.onlyIfRunning && fence.length) throw new Error('Collaboration notification target has completed its output.');
    const currentTurnId = active[0] && !fence.length ? String(active[0].id) : null;
    const now = this.now();
    const routingSteps: RepositoryTransactionStep[] = currentTurnId ? [DOMAIN_REPOSITORIES.domain('Turn').assert(currentTurnId, { status: 'active', conversation_id: targetConversationId }), DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: currentTurnId }), DOMAIN_REPOSITORIES.domain('TurnFinalOutputFence').assertNone({ turn_id: currentTurnId })] : active[0] ? [DOMAIN_REPOSITORIES.domain('TurnFinalOutputFence').assert(String(fence[0].id), { turn_id: active[0].id })] : [DOMAIN_REPOSITORIES.domain('Turn').assertNone({ conversation_id: targetConversationId, status: 'active' })];
    const requestId = stablePhaseFId('collaboration_request', messageId);
    const budgetSteps: RepositoryTransactionStep[] = [];
    if (input.mode === 'followup') {
      const budget = source.kind === 'user'
        ? { id: stablePhaseFId('collaboration_budget', 'user_command', source.commandId), origin_kind: 'user_command', origin_key: source.commandId, authority_turn_id: sourceScope.rootTurnId ?? String(anchor!.id), created_at: now }
        : await this.budgetForTurn(sourceTurn ? String(sourceTurn.id) : null, sourceScope.rootTurnId);
      if (!budget) throw new Error('Followup requires a root Turn budget scope.');
      const persistedBudget = await this.maybe('CollaborationBudget', String(budget.id));
      if (persistedBudget && (persistedBudget.origin_kind !== budget.origin_kind || persistedBudget.origin_key !== budget.origin_key || persistedBudget.authority_turn_id !== budget.authority_turn_id)) throw new Error('Collaboration budget identity conflicts.');
      if (!persistedBudget) budgetSteps.push(DOMAIN_REPOSITORIES.domain('CollaborationBudget').insert(budget));
      const requests = await this.rows('CollaborationRequest', { budget_id: budget.id, automatic: 1n });
      if (source.kind !== 'user') {
        const limit = (await readTurnCollaborationLimits(this.database, this.contentStore, String(budget.authority_turn_id))).maxAutomaticFollowups;
        if (requests.length >= limit) throw new Error(`Automatic followup budget exhausted (${limit}).`);
        budgetSteps.push(DOMAIN_REPOSITORIES.domain('CollaborationRequest').assertExactIds({ budget_id: budget.id, automatic: 1n }, requests.map((row) => String(row.id))));
      }
      budgetSteps.push(DOMAIN_REPOSITORIES.domain('CollaborationRequest').insert({ id: requestId, message_id: messageId, budget_id: budget.id, automatic: source.kind === 'user' ? 0n : 1n, state: 'pending', created_at: now, updated_at: now }));
    }
    const wakeId = stablePhaseFId('runtime_delivery_wake', deliveryId);
    try {
      await this.database.transaction([
        ...preparedContentObjectSteps([prepared], 'collaboration_content'), ...sourceSteps, ...permissionSteps,
        ...sourceScope.authoritySteps, ...targetScope.authoritySteps, ...routingSteps,
        DOMAIN_REPOSITORIES.domain('Conversation').assert(sourceConversationId, { status: 'active' }), DOMAIN_REPOSITORIES.domain('Conversation').assert(targetConversationId, { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('CollaborationMessage').insertWithNextSequence({ id: messageId, dedupe_key: dedupeKey, mode: input.mode, created_at: now }, { column: 'message_seq', scope: {} }),
        DOMAIN_REPOSITORIES.domain('CollaborationMessageSourceLink').insert({ id: stablePhaseFId('collaboration_source', messageId), message_id: messageId, conversation_id: sourceConversationId, source_kind: source.kind, source_key: sourceKey, turn_id: sourceTurn?.id ?? null, tool_call_id: source.kind === 'tool' ? source.toolCallId : null, board_post_id: source.kind === 'board' ? source.postId : null, created_at: now }),
        DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').insert({ id: inboxItemId, dedupe_key: dedupeKey, source_kind: 'collaboration_message', source_id: messageId, state: 'routed', created_at: now, updated_at: now }),
        DOMAIN_REPOSITORIES.domain('CollaborationMessageTargetLink').insert({ id: stablePhaseFId('collaboration_target', messageId), message_id: messageId, conversation_id: targetConversationId, inbox_item_id: inboxItemId, anchor_turn_id: source.kind === 'board' ? currentTurnId : null, created_at: now }),
        DOMAIN_REPOSITORIES.domain('CollaborationMessagePayloadLink').insert({ id: stablePhaseFId('collaboration_payload', messageId), message_id: messageId, content_object_id: prepared.metadata.id, created_at: now }),
        DOMAIN_REPOSITORIES.domain('RuntimeInboxPayloadLink').insert({ id: stablePhaseFId('runtime_inbox_payload_link', inboxItemId), inbox_item_id: inboxItemId, content_object_id: prepared.metadata.id, created_at: now }),
        ...(replyToMessageId ? [DOMAIN_REPOSITORIES.domain('CollaborationMessageReplyLink').insert({ id: stablePhaseFId('collaboration_reply', messageId), message_id: messageId, request_message_id: replyToMessageId, created_at: now })] : []),
        ...budgetSteps,
        DOMAIN_REPOSITORIES.domain('RuntimeDelivery').insert({ id: deliveryId, inbox_item_id: inboxItemId, target_conversation_id: targetConversationId, target_turn_id: currentTurnId, phase: currentTurnId ? 'current_turn' : 'next_turn', attempt_seq: 1n, retry_of_delivery_id: null, state: 'pending', failure_reason: null, created_at: now, updated_at: now }),
        ...(input.mode === 'followup' || currentTurnId ? [DOMAIN_REPOSITORIES.domain('RuntimeDeliveryWake').insert({ id: wakeId, delivery_id: deliveryId, state: 'pending', claim_owner_host_boot_id: null, claim_generation: 0n, claim_expires_at: null, attempt_count: 0n, failure_count: 0n, next_attempt_at: null, last_error: null, acknowledged_at: null, created_at: now, updated_at: now })] : [])
      ]);
    } catch (error) {
      if (!isTransactionAssertionFailure(error) && !sqliteUniqueFailureIncludes(error, ['collaboration_message.id', 'collaboration_message.dedupe_key', 'collaboration_message_source_link.source_kind, collaboration_message_source_link.source_key'])) throw error;
      const raced = await replay(); if (raced) return raced;
      throw error;
    }
    return { messageId, inboxItemId, deliveryId, mode: input.mode, accepted: true as const, deduplicated: false };
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
  public async readMessage(input: { conversationId: string; targetConversationId?: string; messageId: string }) {
    const message = await this.existing('CollaborationMessage', requirePhaseFId(input.messageId, 'messageId'));
    const summary = await this.summary(message);
    const reader = input.targetConversationId ?? input.conversationId;
    await this.assertReadPermission(input.conversationId, reader);
    if (![summary.sourceConversationId, summary.targetConversationId].includes(reader)) throw new Error('Conversation cannot read another conversation\'s private messages.');
    const payload = await this.one('CollaborationMessagePayloadLink', { message_id: input.messageId });
    const metadata = await this.existing('ContentObject', String(payload.content_object_id)) as ContentObjectMetadata;
    return { ...summary, text: (await this.contentStore.read(metadata)).toString('utf8') };
  }
  /** Bounded transcript read, authorized independently from send/wake and never a continuation. */
  public async readConversation(input: { conversationId: string; targetConversationId: string; beforeMessageId?: string; limit?: number }) {
    const caller = requirePhaseFId(input.conversationId, 'conversationId');
    const target = requirePhaseFId(input.targetConversationId, 'targetConversationId');
    await this.assertReadPermission(caller, target);
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
    const selected = links.slice(0, limit).reverse();
    const messages: Array<{ messageId: string; role: string; text: string; createdAt: string; truncated: boolean }> = [];
    let remaining = 32_000;
    for (const link of selected) {
      const message = await this.existing('Message', String(link.message_id));
      if (message.deleted_at !== null) continue;
      const current = await this.rows('MessageCurrentRevisionLink', { message_id: link.message_id });
      if (current.length !== 1) throw new Error('Conversation transcript message has no unique current revision.');
      const revision = await this.existing('MessageRevision', String(current[0].revision_id));
      const metadata = await this.existing('ContentObject', String(revision.content_object_id)) as ContentObjectMetadata;
      // Reading a single enormous CAS object would defeat the API response bound. Such entries
      // retain their identity and an explicit marker so callers can open the original conversation.
      if (metadata.byte_length > 256_000n || remaining <= 0) {
        messages.push({ messageId: String(link.message_id), role: String(revision.role), text: '[Large message omitted; open the source Conversation.]', createdAt: String(revision.created_at), truncated: true });
        continue;
      }
      const text = visibleMessageText(String(metadata.content_type), (await this.contentStore.read(metadata)).toString('utf8'));
      const allowed = Math.min(8000, remaining);
      messages.push({ messageId: String(link.message_id), role: String(revision.role), text: text.slice(0, allowed), createdAt: String(revision.created_at), truncated: text.length > allowed });
      remaining -= Math.min(text.length, allowed);
    }
    return { conversationId: target, title: String(conversation.title), status: String(conversation.status), messages, olderMessageId: links.length > limit && selected.length ? String(selected[0].message_id) : null, hasMore: links.length > limit };
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
  /** Level-triggered recovery: input binding and completed-result replies survive every crash boundary. */
  public async reconcile(): Promise<void> {
    const requests = await this.rows('CollaborationRequest', { state: 'pending' });
    for (const request of requests) {
      const target = await this.one('CollaborationMessageTargetLink', { message_id: request.message_id });
      const deliveries = await this.rows('RuntimeDelivery', { inbox_item_id: target.inbox_item_id });
      const delivery = deliveries.find((row) => row.state === 'consumed' && row.target_turn_id !== null);
      if (!delivery) {
        if (deliveries.length && deliveries.every((row) => row.state === 'failed')) await this.finishRequest(request, 'failed');
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
      if (text) return Buffer.byteLength(text) <= MAX_TEXT_BYTES ? text : `${text.slice(0, 12000)}\n[Result truncated; read the destination task for the full answer.]`;
    }
    return null;
  }
  private async assertReadPermission(caller: string, target: string): Promise<void> {
    await this.existing('Conversation', caller);
    if (caller === target) return;
    const [callerScope, targetScope] = await Promise.all([readCollaborationScope(this.database, caller), readCollaborationScope(this.database, target)]);
    if (callerScope.rootConversationId === targetScope.rootConversationId) return;
    const link = await this.maybe('ConversationCommunicationLink', stablePhaseFId('conversation_communication_link', caller, target));
    if (!link || link.allow_read !== 1n) throw new Error('Reading this Conversation is not authorized.');
  }
  private async budgetForTurn(sourceTurnId: string | null, rootTurnId: string | null): Promise<DomainRow | null> {
    const visit = async (turnId: string, ancestryRoot: string | null, seen: Set<string>): Promise<DomainRow> => {
      if (seen.has(turnId)) throw new Error('Collaboration budget lineage is cyclic.');
      seen.add(turnId);
      const inputs = await this.rows('RuntimeDelivery', { target_turn_id: turnId, state: 'consumed' });
      const budgets = new Map<string, { budget: DomainRow; sequence: bigint }>();
      for (const delivery of inputs) {
        const inbox = await this.existing('RuntimeInboxItem', String(delivery.inbox_item_id));
        if (inbox.source_kind !== 'collaboration_message') continue;
        const requests = await this.rows('CollaborationRequest', { message_id: inbox.source_id });
        if (!requests[0]) continue;
        const budget = await this.existing('CollaborationBudget', String(requests[0].budget_id));
        const message = await this.existing('CollaborationMessage', String(inbox.source_id));
        budgets.set(String(budget.id), { budget, sequence: message.message_seq as bigint });
      }
      // A newer explicit user task may reset this Turn's budget. Unrelated agent requests cannot
      // pool budgets or select one by an arbitrary id ordering.
      const manual = [...budgets.values()].filter((entry) => entry.budget.origin_kind === 'user_command').sort((a, b) => a.sequence < b.sequence ? 1 : -1);
      if (manual.length) return manual[0].budget;
      if (budgets.size > 1) throw new Error('Collaboration cannot combine independent root Turn followup budgets.');
      if (budgets.size === 1) return [...budgets.values()][0].budget;
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
        if (continuation) continuationSources.add(continuation.sourceTurnId);
      }
      if (continuationSources.size > 1) throw new Error('Collaboration budget has conflicting automatic continuation sources.');
      if (continuationSources.size === 1) return visit([...continuationSources][0], null, seen);
      return { id: stablePhaseFId('collaboration_budget', 'turn', turnId), origin_kind: 'turn', origin_key: turnId, authority_turn_id: turnId, created_at: this.now() };
    };
    return sourceTurnId ? visit(sourceTurnId, rootTurnId, new Set()) : rootTurnId ? visit(rootTurnId, null, new Set()) : null;
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
function compareNewest(a: DomainRow, b: DomainRow): number { return String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)); }
function permissionView(row: DomainRow): ConversationCommunicationPermission { return { sourceConversationId: String(row.source_conversation_id), targetConversationId: String(row.target_conversation_id), allowRead: row.allow_read === 1n, allowSend: row.allow_send === 1n, allowWake: row.allow_wake === 1n }; }

function visibleMessageText(contentType: string, raw: string): string {
  if (contentType === 'text/plain') return raw;
  if (contentType !== 'application/vnd.limcode.message+json') throw new Error(`Unsupported Conversation message content type ${contentType}.`);
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as { parts?: unknown }).parts)) throw new Error('Conversation message JSON requires a parts array.');
  return ((value as { parts: unknown[] }).parts).filter((part): part is { text: string; thought?: boolean } => Boolean(part) && typeof part === 'object' && !Array.isArray(part) && typeof (part as { text?: unknown }).text === 'string')
    .filter((part) => part.thought !== true).map((part) => part.text).join('\n');
}
