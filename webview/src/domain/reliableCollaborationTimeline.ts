import type { PlainData } from '@shared/plainData';
import {
  collaborationPeerLabel,
  collaborationPeerRelation,
  resolveAcceptedAnswerPeer,
  resolveCollaborationPeer,
  type CollaborationPeer,
  type CollaborationPeerRelation
} from './collaborationPeer';

type FeedRecord = { [key: string]: PlainData };
type FeedRecords = Record<string, Record<string, FeedRecord>>;
interface TimelinePosition { predecessorSeq: bigint; exchangeSeq: bigint }

/**
 * An independent envelope between Agents, never a Message or a transcript floor: a collaboration
 * message, or the answer a child Agent returned with the final reply of its Turn.
 */
export interface CollaborationTimelineCard {
  /** The CollaborationMessage id, or `answer:<AnswerSubmission id>` for a child answer. */
  messageId: string;
  direction: 'incoming' | 'outgoing';
  peer: CollaborationPeer;
  peerRelation: CollaborationPeerRelation;
  /** For a child answer: its Host-derived outcome (final, interrupted partial, or failed run). */
  kind: 'message' | 'followup' | 'result' | 'answer' | 'partial_answer' | 'failed_answer' | 'unknown_answer';
  textPreview: string;
  /** Parent-owned accepted evidence; detail access never resolves a source or arbitrary CAS id. */
  acceptedAnswerId?: string;
  /** Settled for a proven accepted event; otherwise the newest loaded delivery attempt. */
  status: 'waiting' | 'failed' | 'settled' | 'unknown';
  readBy?: 'current-turn' | 'next-turn';
  /** A child result delivered for display only, without creating a reply Turn. */
  notificationOnly?: boolean;
  /** Independent provenance records distinguish target-preserving historical import order. */
  imported?: boolean;
  /**
   * - ordered: an independent committed link proves the physical Message boundary and exchange order.
   * The remaining values explicitly describe older records whose exact position is unproven.
   * - turn: grouped after the newest loaded message of its Turn.
   * - turn-started: its Turn is loaded but none of its messages is; placed after the last loaded
   *   message whose Turn started no later than it (Turns of one Conversation share its start order).
   * - earlier-turn: its loaded Turn started before the Turn of every loaded message.
   * - turn-without-message: its Turn is loaded, but no loaded message has a Turn to compare with.
   * - turn-not-loaded: its Turn is outside loaded history.
   * - unbound: it never entered a Turn (waiting or failed delivery, or sent outside a Turn).
   */
  placement: 'ordered' | 'turn' | 'turn-started' | 'earlier-turn' | 'turn-without-message' | 'turn-not-loaded' | 'unbound';
}

/** The tail stays bounded: waiting, then failed, then recent display-only child results. */
export const COLLABORATION_UNLOCATED_TAIL_LIMIT = 3;

export interface CollaborationTimeline {
  /**
   * Proven boundaries before the first loaded Message (or before any Message exists), followed
   * by unlocated historical cards outside the bounded attention/notification tail.
   */
  beforeMessages: CollaborationTimelineCard[];
  /** Independent rows following a loaded physical boundary, never inserted into a Message. */
  afterMessage: Record<string, CollaborationTimelineCard[]>;
  /** At most COLLABORATION_UNLOCATED_TAIL_LIMIT waiting/failed cards and recent result notifications. */
  unlocated: CollaborationTimelineCard[];
}

/**
 * Merge independent envelopes at their durable physical Message boundary, then by the shared
 * Conversation-local exchange sequence. Display floors, timestamps and ids are never position
 * evidence. A missing/deleted/unloaded predecessor is resolved against the loaded physical
 * memberships; a transient reply has no membership and therefore follows accepted inputs.
 *
 * Published history without a proven link retains explicitly uncertain Turn grouping. Those
 * records never acquire coordinates from the current Turn or from another delivery attempt.
 */
export function projectCollaborationTimeline(input: {
  conversationId: string;
  records: FeedRecords;
  messages: ReadonlyArray<{ id: string }>;
  turnIdByMessageId: Readonly<Record<string, string>>;
  removedConversationIds: readonly string[];
  /** Snapshot generations invalidate only derived peer liveness, never the accepted fact. */
  peerStateGeneration?: number;
  acceptedAnswerPeerGenerations?: Readonly<Record<string, number>>;
  acceptedAnswerDetails?: Readonly<Record<string, {
    peerState?: 'known' | 'deleted' | 'unknown'; peerStateGeneration?: number;
  }>>;
}): CollaborationTimeline {
  const result: CollaborationTimeline = { beforeMessages: [], afterMessage: {}, unlocated: [] };
  if (!input.conversationId) return result;
  const lastMessageByTurn = new Map<string, string>();
  /** Loaded messages with the start of their Turn, in transcript order. */
  const messageTurnStarts: Array<{ messageId: string; startedAt: string }> = [];
  for (const message of input.messages) {
    const turnId = input.turnIdByMessageId[message.id];
    if (!turnId) continue;
    lastMessageByTurn.set(turnId, message.id);
    const startedAt = ownTurnStart(turnId);
    if (startedAt) messageTurnStarts.push({ messageId: message.id, startedAt });
  }
  const loadedMemberships = input.messages.flatMap((message) => {
    const record = input.records.Message?.[message.id];
    const messageSeq = nonnegativeSequence(record?.message_seq);
    return record?.conversation_id === input.conversationId && messageSeq !== undefined && messageSeq > 0n
      ? [{ messageId: message.id, messageSeq }] : [];
  }).sort((left, right) => compareBigint(left.messageSeq, right.messageSeq));
  const deliveryPositions = linksByField(input.records.RuntimeDeliveryTimelineLink, 'delivery_id');
  const acceptedAnswers = acceptedAnswerByDelivery(input.records, input.conversationId);
  const sendPositions = linksByField(input.records.CollaborationSendTimelineLink, 'message_id');
  const placed: Array<{
    card: CollaborationTimelineCard;
    anchorId?: string;
    position?: TimelinePosition;
  }> = [];
  const sources = linksByMessage(input.records.CollaborationMessageSourceLink);
  const targets = linksByMessage(input.records.CollaborationMessageTargetLink);
  const acceptedDeliveries = acceptedDeliveryByTarget(input.records, input.conversationId, acceptedAnswers);
  const deliveries = latestDeliveryByTarget(input.records.RuntimeDelivery);
  // A redelivery is another attempt, not a revocation of the already accepted logical envelope.
  // Keep the accepted attempt and its own proof together; never attach its link to the retry.
  for (const [key, delivery] of acceptedDeliveries) deliveries.set(key, delivery);
  const messages = Object.values(input.records.CollaborationMessage ?? {})
    .filter((message) => typeof message.id === 'string')
    .sort((left, right) => compareSequence(left.message_seq, right.message_seq) || text(left.id).localeCompare(text(right.id)));
  for (const message of messages) {
    const messageId = text(message.id);
    const source = sources.get(messageId);
    const target = targets.get(messageId);
    if (!source || !target) continue;
    const incoming = target.conversation_id === input.conversationId;
    if (!incoming && source.conversation_id !== input.conversationId) continue;
    const peerConversationId = text(incoming ? source.conversation_id : target.conversation_id);
    if (!peerConversationId) continue;
    const key = deliveryKey(target.inbox_item_id, target.conversation_id);
    const delivery = deliveries.get(key);
    const card: CollaborationTimelineCard = {
      messageId,
      direction: incoming ? 'incoming' : 'outgoing',
      peer: resolveCollaborationPeer(input.records, peerConversationId, input.removedConversationIds),
      peerRelation: collaborationPeerRelation(input.records, input.conversationId, peerConversationId),
      kind: source.source_kind === 'completion' ? 'result' : message.mode === 'followup' ? 'followup' : 'message',
      textPreview: text(message.text_preview),
      status: acceptedDeliveries.has(key) ? 'settled' : !delivery ? 'unknown' : delivery.state === 'failed' ? 'failed'
        : delivery.state === 'pending' ? 'waiting'
          : delivery.state === 'consumed' ? 'settled' : 'unknown',
      placement: 'unbound'
    };
    if (!incoming && card.status === 'waiting' && card.kind !== 'followup') {
      card.readBy = text(delivery?.target_turn_id) ? 'current-turn' : 'next-turn';
    }
    const turnId = incoming
      ? card.status === 'failed' ? '' : text(delivery?.target_turn_id)
      : text(source.turn_id);
    place(card, turnId, incoming ? deliveryPositions.get(text(delivery?.id)) : sendPositions.get(messageId));
  }
  // A child's answer delivered to this Conversation: same card, told apart by its kind. An answer
  // that settled a waiting run_agent call has no delivery and stays with that tool call.
  // Delivery creation order selects the newest notification cards deterministically, including
  // after history paging/reload. It does not locate them relative to any ordinary Message.
  const answerDeliveries = [...deliveries.values()].filter((delivery) =>
    text(delivery.target_conversation_id) === input.conversationId
    && input.records.RuntimeInboxItem?.[text(delivery.inbox_item_id)]?.source_kind === 'answer_submission'
  ).sort((left, right) =>
    text(left.created_at).localeCompare(text(right.created_at)) || text(left.id).localeCompare(text(right.id)));
  for (const delivery of answerDeliveries) {
    const inbox = input.records.RuntimeInboxItem?.[text(delivery.inbox_item_id)];
    if (!inbox || inbox.source_kind !== 'answer_submission') continue;
    const accepted = acceptedAnswers.get(text(delivery.id));
    const submission = input.records.AnswerSubmission?.[text(inbox.source_id)];
    const bridge = input.records.AnswerBridge?.[text(submission?.answer_bridge_id)];
    const child = input.records.ChildExecution?.[text(bridge?.child_execution_id)];
    const peerConversationId = text(child?.child_conversation_id);
    const kind = accepted ? ANSWER_KIND_BY_OUTCOME[text(accepted.outcome)]
      : submission && submission.outcome !== 'unknown' ? ANSWER_KIND_BY_OUTCOME[text(submission.outcome)] : undefined;
    if (!kind || (!accepted && (!submission || !peerConversationId))) continue;
    const acceptedId = text(accepted?.id);
    const acceptedDetail = input.acceptedAnswerDetails?.[`accepted-answer-content:${acceptedId}`];
    const peerStateCurrent = input.peerStateGeneration === undefined
      || input.acceptedAnswerPeerGenerations?.[acceptedId] === input.peerStateGeneration;
    const freshDetailPeerState = acceptedDetail?.peerStateGeneration === input.peerStateGeneration
      ? acceptedDetail?.peerState : undefined;
    const card: CollaborationTimelineCard = {
      messageId: `answer:${text(accepted?.submission_id ?? submission?.id)}`,
      direction: 'incoming',
      peer: accepted ? resolveAcceptedAnswerPeer(input.records, accepted, input.removedConversationIds,
        { current: peerStateCurrent, ...(freshDetailPeerState ? { state: freshDetailPeerState } : {}) })
        : resolveCollaborationPeer(input.records, peerConversationId, input.removedConversationIds),
      peerRelation: 'child',
      kind,
      textPreview: text(accepted?.answer_title_preview),
      ...(accepted ? { acceptedAnswerId: text(accepted.id) } : {}),
      ...(delivery.phase === 'notify_only' ? { notificationOnly: true } : {}),
      status: acceptedDeliveries.has(deliveryKey(delivery.inbox_item_id, delivery.target_conversation_id)) ? 'settled'
        : delivery.state === 'failed' ? 'failed'
        : delivery.state === 'pending' ? 'waiting'
          : delivery.state === 'consumed' ? 'settled' : 'unknown',
      placement: 'unbound'
    };
    place(card, card.status === 'failed' ? '' : text(delivery.target_turn_id), deliveryPositions.get(text(delivery.id)));
  }
  // A consumed notify-only result will never acquire Turn membership. Keep recent results in
  // the same bounded tail after waiting/failed priority, rather than moving a fresh result above
  // the user's original request. Older notifications stay reachable in the history group.
  const unbound = placed.filter((entry) => entry.card.placement === 'unbound').map((entry) => entry.card);
  const waiting = unbound.filter((card) => card.status === 'waiting').slice(-COLLABORATION_UNLOCATED_TAIL_LIMIT);
  const room = COLLABORATION_UNLOCATED_TAIL_LIMIT - waiting.length;
  const failed = room > 0 ? unbound.filter((card) => card.status === 'failed').slice(-room) : [];
  const notificationRoom = room - failed.length;
  const notifications = notificationRoom > 0 ? unbound
    .filter((card) => card.notificationOnly && card.status === 'settled').slice(-notificationRoom) : [];
  const tail = new Set([...waiting, ...failed, ...notifications]);
  // Sort all proven rows together before splitting buckets, including sent messages interleaved
  // with accepted child answers. Keep unproven records stable without assigning them a sequence.
  placed.sort((left, right) => {
    if (!left.position || !right.position) return left.position ? -1 : right.position ? 1 : 0;
    return compareBigint(left.position.predecessorSeq, right.position.predecessorSeq)
      || compareBigint(left.position.exchangeSeq, right.position.exchangeSeq);
  });
  for (const { card, anchorId } of placed) {
    if (anchorId) (result.afterMessage[anchorId] ??= []).push(card);
    else if (tail.has(card)) result.unlocated.push(card);
    else result.beforeMessages.push(card);
  }
  return result;

  function ownTurnStart(turnId: string): string {
    const turn = input.records.Turn?.[turnId];
    return turn && turn.conversation_id === input.conversationId ? text(turn.created_at) : '';
  }

  function place(card: CollaborationTimelineCard, turnId: string, link?: FeedRecord): void {
    const position = timelinePosition(link, input.conversationId);
    if (position) {
      const { predecessorSeq } = position;
      // Upper bound over physical membership, not a linear scan per collaboration card. The
      // predecessor itself need not be visible (hidden role, deleted message or another page).
      let low = 0;
      let high = loadedMemberships.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (loadedMemberships[middle].messageSeq <= predecessorSeq) low = middle + 1;
        else high = middle;
      }
      card.placement = 'ordered';
      if (link?.imported === true) card.imported = true;
      placed.push({ card, anchorId: loadedMemberships[low - 1]?.messageId, position });
      return;
    }
    if (!turnId) {
      placed.push({ card });
      return;
    }
    const anchorId = lastMessageByTurn.get(turnId);
    if (anchorId) {
      card.placement = 'turn';
      placed.push({ card, anchorId });
      return;
    }
    const turn = input.records.Turn?.[turnId];
    if (!turn || turn.conversation_id !== input.conversationId) {
      card.placement = 'turn-not-loaded';
      placed.push({ card });
      return;
    }
    const startedAt = text(turn.created_at);
    if (!startedAt || messageTurnStarts.length === 0) {
      card.placement = 'turn-without-message';
      placed.push({ card });
      return;
    }
    let previous: string | undefined;
    for (const entry of messageTurnStarts) {
      if (entry.startedAt <= startedAt) previous = entry.messageId;
    }
    card.placement = previous ? 'turn-started' : 'earlier-turn';
    placed.push({ card, ...(previous ? { anchorId: previous } : {}) });
  }
}

/** Proven positions need no warning; historical uncertainty is kept visible. */
export function collaborationCardPlacementLabel(card: CollaborationTimelineCard): string {
  if (card.placement === 'ordered') return card.imported ? '按导入顺序排列' : '';
  if (card.notificationOnly && card.placement === 'unbound') return '结果通知';
  if (card.placement === 'turn') return '按回合归组，具体顺序待确认';
  if (card.placement === 'turn-started') return '所属回合没有已加载的消息，按回合开始顺序排列';
  if (card.placement === 'earlier-turn') return '所属回合早于已加载的消息，位置待确认';
  if (card.placement === 'turn-without-message') return '所属回合没有已加载的消息，位置待确认';
  if (card.placement === 'turn-not-loaded') return '所属回合在更早的历史中，位置待确认';
  return card.status === 'failed' ? '投递未进入回合，位置待确认' : '尚未关联回合，位置待确认';
}

export function collaborationCardLabel(card: CollaborationTimelineCard): string {
  const peer = collaborationPeerLabel(card.peer, card.peerRelation);
  return card.direction === 'incoming' ? `来自${peer}` : `发往${peer}`;
}

/** The state badge, or an empty string when the message simply arrived. */
export function collaborationCardStatusLabel(card: CollaborationTimelineCard): string {
  if (card.status === 'failed') return '投递失败';
  if (card.status === 'unknown') return '投递状态待确认';
  if (card.status === 'settled') return '';
  if (card.notificationOnly) return '通知待送达';
  if (card.direction === 'incoming') return card.placement === 'unbound' ? '等待下一轮处理' : '已送达，等待本轮处理';
  if (card.readBy === 'current-turn') return '已送达，对方本轮读取';
  if (card.readBy === 'next-turn') return '已送达，对方下一轮读取';
  return '等待对方处理';
}

export function collaborationCardKindLabel(card: CollaborationTimelineCard): string {
  if (card.kind === 'answer') return '最终结果';
  if (card.kind === 'failed_answer') return '执行失败';
  if (card.kind === 'partial_answer') return '部分结果（已中断）';
  if (card.kind === 'unknown_answer') return '历史结果（状态未知）';
  if (card.kind === 'result') return '任务结果';
  return card.kind === 'followup' ? '续派任务' : '消息';
}

const ANSWER_KIND_BY_OUTCOME: Readonly<Record<string, CollaborationTimelineCard['kind']>> = Object.freeze({
  submitted: 'answer',
  interrupted: 'partial_answer',
  failed: 'failed_answer',
  unknown: 'unknown_answer'
});

function deliveryKey(inboxItemId: PlainData | undefined, conversationId: PlainData | undefined): string {
  return `${text(inboxItemId)}\0${text(conversationId)}`;
}

function timelinePosition(link: FeedRecord | undefined, conversationId: string): TimelinePosition | undefined {
  const predecessorSeq = nonnegativeSequence(link?.predecessor_message_seq);
  const exchangeSeq = nonnegativeSequence(link?.exchange_seq);
  const predecessorId = text(link?.predecessor_message_id);
  return link?.conversation_id === conversationId && predecessorSeq !== undefined
    && exchangeSeq !== undefined && exchangeSeq > 0n
    && (predecessorSeq === 0n ? link.predecessor_message_id === null : Boolean(predecessorId))
    ? { predecessorSeq, exchangeSeq } : undefined;
}

/** Canonical accepted event per logical envelope; all status/position reads use that exact attempt. */
function acceptedDeliveryByTarget(
  records: FeedRecords,
  conversationId: string,
  presentations: ReadonlyMap<string, FeedRecord>
): Map<string, FeedRecord> {
  const accepted = new Map<string, { delivery: FeedRecord; exchangeSeq: bigint }>();
  for (const link of Object.values(records.RuntimeDeliveryTimelineLink ?? {})) {
    const position = timelinePosition(link, conversationId);
    const delivery = records.RuntimeDelivery?.[text(link.delivery_id)];
    if (!position || !delivery || delivery.target_conversation_id !== conversationId) continue;
    const key = deliveryKey(delivery.inbox_item_id, delivery.target_conversation_id);
    const current = accepted.get(key);
    if (!current || position.exchangeSeq < current.exchangeSeq) {
      accepted.set(key, { delivery, exchangeSeq: position.exchangeSeq });
    }
  }
  // Positioned acceptance always wins. With semantic-only evidence, the lowest accepted attempt
  // is a stable display identity, not a claim about reception chronology or physical coordinates.
  for (const deliveryId of presentations.keys()) {
    const delivery = records.RuntimeDelivery?.[deliveryId];
    if (!delivery) continue;
    const key = deliveryKey(delivery.inbox_item_id, delivery.target_conversation_id);
    const current = accepted.get(key);
    if (!current || (current.exchangeSeq === 0n
      && compareSequence(delivery.attempt_seq, current.delivery.attempt_seq) < 0)) {
      accepted.set(key, { delivery, exchangeSeq: 0n });
    }
  }
  return new Map([...accepted].map(([key, entry]) => [key, entry.delivery]));
}

function acceptedAnswerByDelivery(records: FeedRecords, conversationId: string): Map<string, FeedRecord> {
  const result = new Map<string, FeedRecord>();
  for (const presentation of Object.values(records.RuntimeDeliveryAnswerPresentation ?? {})) {
    const deliveryId = text(presentation.delivery_id);
    const delivery = records.RuntimeDelivery?.[deliveryId];
    const inbox = records.RuntimeInboxItem?.[text(delivery?.inbox_item_id)];
    if (!text(presentation.id) || presentation.conversation_id !== conversationId
      || delivery?.target_conversation_id !== conversationId || inbox?.source_kind !== 'answer_submission'
      || presentation.inbox_item_id !== delivery.inbox_item_id
      || compareSequence(presentation.attempt_seq, delivery.attempt_seq) !== 0
      || !text(presentation.submission_id) || inbox.source_id !== presentation.submission_id) continue;
    result.set(deliveryId, presentation);
  }
  return result;
}

/** One pass over the deliveries: the newest attempt per inbox item and target Conversation. */
function latestDeliveryByTarget(records: Record<string, FeedRecord> | undefined): Map<string, FeedRecord> {
  const latest = new Map<string, FeedRecord>();
  for (const delivery of Object.values(records ?? {})) {
    const key = deliveryKey(delivery.inbox_item_id, delivery.target_conversation_id);
    const current = latest.get(key);
    if (!current || compareSequence(delivery.attempt_seq, current.attempt_seq) > 0) latest.set(key, delivery);
  }
  return latest;
}

function linksByMessage(records: Record<string, FeedRecord> | undefined): Map<string, FeedRecord> {
  return linksByField(records, 'message_id');
}

function linksByField(records: Record<string, FeedRecord> | undefined, field: string): Map<string, FeedRecord> {
  const result = new Map<string, FeedRecord>();
  for (const link of Object.values(records ?? {})) {
    const value = text(link[field]);
    if (value) result.set(value, link);
  }
  return result;
}

function compareSequence(left: PlainData | undefined, right: PlainData | undefined): number {
  const a = sequence(left);
  const b = sequence(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

function sequence(value: PlainData | undefined): bigint {
  return nonnegativeSequence(value) ?? 0n;
}

function nonnegativeSequence(value: PlainData | undefined): bigint | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  return undefined;
}

function compareBigint(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function text(value: PlainData | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}
