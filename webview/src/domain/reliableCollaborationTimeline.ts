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
  kind: 'message' | 'followup' | 'result' | 'answer' | 'partial_answer';
  textPreview: string;
  /** The newest delivery attempt, or unknown when its delivery is not in the bounded feed. */
  status: 'waiting' | 'failed' | 'settled' | 'unknown';
  readBy?: 'current-turn' | 'next-turn';
  /** Only Turn membership is known; no within-Turn acceptance/send order is inferred. */
  placement: 'turn' | 'turn-without-message' | 'turn-not-loaded' | 'unbound';
}

export interface CollaborationTimeline {
  /** Grouped by the last loaded message of that Turn, not inserted into a Message. */
  afterMessage: Record<string, CollaborationTimelineCard[]>;
  /** The Turn has no loaded message, or delivery never entered a Turn. Location is not asserted. */
  unlocated: CollaborationTimelineCard[];
}

/**
 * Group envelopes by committed source/delivery Turn membership only. The newest visible message
 * from that Turn holds the group, so a 35-message Turn keeps its cards in the newest render segment
 * rather than stranding them at message 1. This grouping does NOT assert that delivery or sending
 * happened after that message. There is no committed within-Turn acceptance position here: show
 * that uncertainty to the user rather than comparing unrelated created_at timestamps.
 *
 * An envelope without a loaded Turn message remains a separate, unlocated row. This includes
 * waiting and failed deliveries, a Turn with no Message, and a Turn outside loaded history. None
 * of these records are promoted to a Message, given a transcript floor, or silently dropped.
 */
export function projectCollaborationTimeline(input: {
  conversationId: string;
  records: FeedRecords;
  messages: ReadonlyArray<{ id: string }>;
  turnIdByMessageId: Readonly<Record<string, string>>;
  removedConversationIds: readonly string[];
}): CollaborationTimeline {
  const result: CollaborationTimeline = { afterMessage: {}, unlocated: [] };
  if (!input.conversationId) return result;
  const lastMessageByTurn = new Map<string, string>();
  for (const message of input.messages) {
    const turnId = input.turnIdByMessageId[message.id];
    if (turnId) lastMessageByTurn.set(turnId, message.id);
  }
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
    if (!submission || !peerConversationId) continue;
    const card: CollaborationTimelineCard = {
      messageId: `answer:${text(submission.id)}`,
      direction: 'incoming',
      peer: resolveCollaborationPeer(input.records, peerConversationId, input.removedConversationIds),
      peerRelation: 'child',
      kind: submission.interrupted === true || submission.interrupted === 1 || submission.interrupted === '1'
        ? 'partial_answer' : 'answer',
      textPreview: '',
      status: delivery.state === 'failed' ? 'failed'
        : delivery.state === 'pending' ? 'waiting'
          : delivery.state === 'consumed' ? 'settled' : 'unknown',
      placement: 'unbound'
    };
    place(card, card.status === 'failed' ? '' : text(delivery.target_turn_id));
  }
  return result;

  function place(card: CollaborationTimelineCard, turnId: string): void {
    if (!turnId) {
      result.unlocated.push(card);
      return;
    }
    const anchorId = lastMessageByTurn.get(turnId);
    if (anchorId) {
      card.placement = 'turn';
      (result.afterMessage[anchorId] ??= []).push(card);
      return;
    }
    const turn = input.records.Turn?.[turnId];
    card.placement = turn?.conversation_id === input.conversationId
      ? 'turn-without-message' : 'turn-not-loaded';
    result.unlocated.push(card);
  }
}

/** Every card gets a truthful explanation of grouping instead of a fabricated exact position. */
export function collaborationCardPlacementLabel(card: CollaborationTimelineCard): string {
  if (card.placement === 'turn') return '按回合归组，具体顺序待确认';
  if (card.placement === 'turn-without-message') return '所属回合暂无消息，位置待确认';
  if (card.placement === 'turn-not-loaded') return '所属回合未加载，位置待确认';
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
  if (card.direction === 'incoming') return card.placement === 'turn' || card.placement === 'turn-without-message'
    ? '已送达，等待本轮处理' : '等待下一轮处理';
  if (card.readBy === 'current-turn') return '已送达，对方本轮读取';
  if (card.readBy === 'next-turn') return '已送达，对方下一轮读取';
  return '等待对方处理';
}

export function collaborationCardKindLabel(card: CollaborationTimelineCard): string {
  if (card.kind === 'answer') return '最终结果';
  if (card.kind === 'partial_answer') return '部分结果（已中断）';
  if (card.kind === 'result') return '任务结果';
  return card.kind === 'followup' ? '续派任务' : '消息';
}

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
