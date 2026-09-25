import type { PlainData } from '@shared/plainData';
import {
  collaborationPeerLabel,
  collaborationPeerRelation,
  resolveCollaborationPeer,
  type CollaborationPeer,
  type CollaborationPeerRelation
} from './collaborationPeer';

type FeedRecord = { [key: string]: PlainData };
type FeedRecords = Record<string, Record<string, FeedRecord>>;

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
  kind: 'message' | 'followup' | 'result' | 'answer' | 'partial_answer' | 'failed_answer';
  textPreview: string;
  /** The newest delivery attempt, or unknown when its delivery is not in the bounded feed. */
  status: 'waiting' | 'failed' | 'settled' | 'unknown';
  readBy?: 'current-turn' | 'next-turn';
  /**
   * Only Turn membership is known; no within-Turn acceptance/send order is inferred.
   * - turn: grouped after the newest loaded message of its Turn.
   * - turn-started: its Turn is loaded but none of its messages is; placed after the last loaded
   *   message whose Turn started no later than it (Turns of one Conversation share its start order).
   * - earlier-turn: its loaded Turn started before the Turn of every loaded message.
   * - turn-without-message: its Turn is loaded, but no loaded message has a Turn to compare with.
   * - turn-not-loaded: its Turn is outside loaded history.
   * - unbound: it never entered a Turn (waiting or failed delivery, or sent outside a Turn).
   */
  placement: 'turn' | 'turn-started' | 'earlier-turn' | 'turn-without-message' | 'turn-not-loaded' | 'unbound';
}

/** Waiting or failed cards that never entered a Turn stay below every message, but only the newest few. */
export const COLLABORATION_UNLOCATED_TAIL_LIMIT = 3;

export interface CollaborationTimeline {
  /**
   * Above the first loaded message, oldest first: cards of Turns older than every loaded message
   * or outside loaded history (history pages add these), and cards that never entered a Turn but
   * are neither among the newest waiting/failed ones. None of them may displace the newest messages.
   */
  beforeMessages: CollaborationTimelineCard[];
  /** Grouped by a loaded message, not inserted into a Message. */
  afterMessage: Record<string, CollaborationTimelineCard[]>;
  /** At most COLLABORATION_UNLOCATED_TAIL_LIMIT newest waiting, then failed, cards that never entered a Turn. */
  unlocated: CollaborationTimelineCard[];
}

/**
 * Group envelopes by committed source/delivery Turn membership only. The newest visible message
 * from that Turn holds the group, so a 35-message Turn keeps its cards in the newest render segment
 * rather than stranding them at message 1. This grouping does NOT assert that delivery or sending
 * happened after that message. There is no committed within-Turn acceptance position here: show
 * that uncertainty to the user rather than comparing unrelated created_at timestamps.
 *
 * A card whose Turn has no loaded message is placed by that Turn only: a loaded Turn is compared
 * with the Turns of the loaded messages (never with a message or envelope timestamp); a Turn
 * outside loaded history belongs to older history and sits above the first loaded message. Of the
 * cards that never entered a Turn, only the newest few waiting or failed ones stay below every
 * message. None of these records are promoted to a Message, given a transcript floor, or silently
 * dropped.
 */
export function projectCollaborationTimeline(input: {
  conversationId: string;
  records: FeedRecords;
  messages: ReadonlyArray<{ id: string }>;
  turnIdByMessageId: Readonly<Record<string, string>>;
  removedConversationIds: readonly string[];
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
  // Every card in processing order (message_seq, then answers) with where it was placed.
  const placed: Array<{ card: CollaborationTimelineCard; anchorId?: string }> = [];
  const sources = linksByMessage(input.records.CollaborationMessageSourceLink);
  const targets = linksByMessage(input.records.CollaborationMessageTargetLink);
  const latestDeliveries = latestDeliveryByTarget(input.records.RuntimeDelivery);
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
    const delivery = latestDeliveries.get(deliveryKey(target.inbox_item_id, target.conversation_id));
    const card: CollaborationTimelineCard = {
      messageId,
      direction: incoming ? 'incoming' : 'outgoing',
      peer: resolveCollaborationPeer(input.records, peerConversationId, input.removedConversationIds),
      peerRelation: collaborationPeerRelation(input.records, input.conversationId, peerConversationId),
      kind: source.source_kind === 'completion' ? 'result' : message.mode === 'followup' ? 'followup' : 'message',
      textPreview: text(message.text_preview),
      status: !delivery ? 'unknown' : delivery.state === 'failed' ? 'failed'
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
    place(card, turnId);
  }
  // A child's answer delivered to this Conversation: same card, told apart by its kind. An answer
  // that settled a waiting run_agent call has no delivery and stays with that tool call.
  for (const delivery of latestDeliveries.values()) {
    if (text(delivery.target_conversation_id) !== input.conversationId) continue;
    const inbox = input.records.RuntimeInboxItem?.[text(delivery.inbox_item_id)];
    if (!inbox || inbox.source_kind !== 'answer_submission') continue;
    const submission = input.records.AnswerSubmission?.[text(inbox.source_id)];
    const bridge = input.records.AnswerBridge?.[text(submission?.answer_bridge_id)];
    const child = input.records.ChildExecution?.[text(bridge?.child_execution_id)];
    const peerConversationId = text(child?.child_conversation_id);
    const kind = submission ? ANSWER_KIND_BY_OUTCOME[text(submission.outcome)] : undefined;
    if (!submission || !peerConversationId || !kind) continue;
    const card: CollaborationTimelineCard = {
      messageId: `answer:${text(submission.id)}`,
      direction: 'incoming',
      peer: resolveCollaborationPeer(input.records, peerConversationId, input.removedConversationIds),
      peerRelation: 'child',
      kind,
      textPreview: '',
      status: delivery.state === 'failed' ? 'failed'
        : delivery.state === 'pending' ? 'waiting'
          : delivery.state === 'consumed' ? 'settled' : 'unknown',
      placement: 'unbound'
    };
    place(card, card.status === 'failed' ? '' : text(delivery.target_turn_id));
  }
  // Below the messages stay only the newest Turn-less cards that still need attention: waiting
  // ones first, then failed ones. Everything else that never entered a Turn joins older history.
  const unbound = placed.filter((entry) => entry.card.placement === 'unbound').map((entry) => entry.card);
  const waiting = unbound.filter((card) => card.status === 'waiting').slice(-COLLABORATION_UNLOCATED_TAIL_LIMIT);
  const room = COLLABORATION_UNLOCATED_TAIL_LIMIT - waiting.length;
  const failed = room > 0 ? unbound.filter((card) => card.status === 'failed').slice(-room) : [];
  const tail = new Set([...waiting, ...failed]);
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

  function place(card: CollaborationTimelineCard, turnId: string): void {
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

/** Every card gets a truthful explanation of grouping instead of a fabricated exact position. */
export function collaborationCardPlacementLabel(card: CollaborationTimelineCard): string {
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
  if (card.direction === 'incoming') return card.placement === 'unbound' ? '等待下一轮处理' : '已送达，等待本轮处理';
  if (card.readBy === 'current-turn') return '已送达，对方本轮读取';
  if (card.readBy === 'next-turn') return '已送达，对方下一轮读取';
  return '等待对方处理';
}

export function collaborationCardKindLabel(card: CollaborationTimelineCard): string {
  if (card.kind === 'answer') return '最终结果';
  if (card.kind === 'failed_answer') return '执行失败';
  if (card.kind === 'partial_answer') return '部分结果（已中断）';
  if (card.kind === 'result') return '任务结果';
  return card.kind === 'followup' ? '续派任务' : '消息';
}

const ANSWER_KIND_BY_OUTCOME: Readonly<Record<string, CollaborationTimelineCard['kind']>> = Object.freeze({
  submitted: 'answer',
  interrupted: 'partial_answer',
  failed: 'failed_answer'
});

function deliveryKey(inboxItemId: PlainData | undefined, conversationId: PlainData | undefined): string {
  return `${text(inboxItemId)}\0${text(conversationId)}`;
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
  const result = new Map<string, FeedRecord>();
  for (const link of Object.values(records ?? {})) {
    const messageId = text(link.message_id);
    if (messageId) result.set(messageId, link);
  }
  return result;
}

function compareSequence(left: PlainData | undefined, right: PlainData | undefined): number {
  const a = sequence(left);
  const b = sequence(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

function sequence(value: PlainData | undefined): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}

function text(value: PlainData | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}
