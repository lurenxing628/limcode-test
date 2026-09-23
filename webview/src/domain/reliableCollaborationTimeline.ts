import type { PlainData } from '@shared/plainData';
import { collaborationPeerLabel, resolveCollaborationPeer, type CollaborationPeer } from './collaborationPeer';

type FeedRecord = { [key: string]: PlainData };
type FeedRecords = Record<string, Record<string, FeedRecord>>;

/** One collaboration message as seen from the selected Conversation. */
export interface CollaborationTimelineCard {
  messageId: string;
  direction: 'incoming' | 'outgoing';
  peer: CollaborationPeer;
  kind: 'message' | 'followup' | 'result';
  textPreview: string;
  /**
   * From the newest delivery attempt: `waiting` is committed but not yet taken up by the target
   * (for example queued behind its running Turn), `failed` never reached it, `settled` did.
   */
  status: 'waiting' | 'failed' | 'settled';
  /**
   * An outgoing message or result that is waiting has already arrived in the recipient's inbox; it
   * starts no Turn and is read by the recipient's running Turn or by its next one.
   */
  readBy?: 'current-turn' | 'next-turn';
}

export interface CollaborationTimeline {
  /**
   * Rendered above the anchor message: a delivery that started the anchor Turn, or, when message 1
   * is loaded, an incoming message that failed before every loaded message and the cards of a Turn
   * without a loaded message that started before every loaded message.
   */
  beforeMessage: Record<string, CollaborationTimelineCard[]>;
  /**
   * Rendered below the anchor message: received or sent while the anchor Turn ran, an incoming
   * message that failed before reaching a Turn, after the last message created before it was sent,
   * or a card of a Turn without a loaded message, after the last message created before that Turn
   * started.
   */
  afterMessage: Record<string, CollaborationTimelineCard[]>;
  /**
   * Cards of a loaded Turn that has no loaded message (its first request is still running, or it
   * ended before saving any text) that started after every loaded message or has no time to compare
   * with: rendered below every message, ahead of that Turn's own notices.
   */
  turnWithoutMessage: CollaborationTimelineCard[];
  /**
   * Incoming messages that still wait for a target Turn, and the newest few failed ones that no
   * loaded message can place: sent after every loaded message, or with no loaded message (or no
   * creation time) to compare with.
   */
  unbound: CollaborationTimelineCard[];
}

/** Failed incoming cards no loaded message can place that stay pinned below the timeline. */
export const MAX_PINNED_FAILED_COLLABORATION_CARDS = 3;

/**
 * Places each collaboration envelope at the first visible message of the Turn it belongs to: the
 * delivery Turn for incoming messages and the sending Turn for outgoing ones. A loaded Turn with no
 * loaded message places its cards by when it started, and an incoming message that failed before
 * reaching a Turn by when it was sent: after the last message created before that time, or before
 * the first message when older than all of them and message 1 is loaded. Messages whose position is
 * outside the loaded window are omitted instead of being shown at a misleading position.
 */
export function projectCollaborationTimeline(input: {
  conversationId: string;
  records: FeedRecords;
  messages: ReadonlyArray<{ id: string; role: string; createdAt?: number }>;
  turnIdByMessageId: Readonly<Record<string, string>>;
  /** Conversations this view saw removed; only these (or a deleted status) read as deleted. */
  removedConversationIds: readonly string[];
  /**
   * The loaded messages begin at the Conversation's first message, so nothing earlier exists that
   * could hold a card older than all of them, whatever a later gap holds.
   */
  loadedFromFirstMessage: boolean;
}): CollaborationTimeline {
  const result: CollaborationTimeline = { beforeMessage: {}, afterMessage: {}, turnWithoutMessage: [], unbound: [] };
  const pinnedFailures: CollaborationTimelineCard[] = [];
  if (!input.conversationId) return result;
  const firstMessageByTurn = new Map<string, { id: string; role: string }>();
  for (const message of input.messages) {
    const turnId = input.turnIdByMessageId[message.id];
    if (turnId && !firstMessageByTurn.has(turnId)) firstMessageByTurn.set(turnId, message);
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
    // The newest attempt to the message's own target decides its state on both sides.
    const delivery = latestDeliveries.get(deliveryKey(target.inbox_item_id, target.conversation_id));
    if (incoming && !delivery) continue;
    const card: CollaborationTimelineCard = {
      messageId,
      direction: incoming ? 'incoming' : 'outgoing',
      peer: resolveCollaborationPeer(input.records, peerConversationId, input.removedConversationIds),
      kind: source.source_kind === 'completion' ? 'result' : message.mode === 'followup' ? 'followup' : 'message',
      textPreview: text(message.text_preview),
      // An incoming delivery already bound to a Turn is taken up there; only an unbound one waits.
      status: delivery?.state === 'failed' ? 'failed'
        : delivery?.state === 'pending' && !(incoming && text(delivery.target_turn_id)) ? 'waiting'
          : 'settled'
    };
    if (!incoming && card.status === 'waiting' && card.kind !== 'followup') {
      card.readBy = text(delivery?.target_turn_id) ? 'current-turn' : 'next-turn';
    }
    let turnId: string;
    if (incoming) {
      turnId = text(delivery?.target_turn_id);
      if (!turnId) {
        if (card.status === 'waiting') result.unbound.push(card);
        else if (card.status === 'failed') {
          placeByTime(result, card, timestamp(message.created_at), pinnedFailures, input);
        }
        continue;
      }
    } else {
      turnId = text(source.turn_id);
    }
    const anchor = firstMessageByTurn.get(turnId);
    if (anchor) {
      // A delivery that started a Turn precedes that Turn's first reply; everything else follows the
      // Turn's opening user message.
      const bucket = incoming && anchor.role !== 'user' ? result.beforeMessage : result.afterMessage;
      (bucket[anchor.id] ??= []).push(card);
      continue;
    }
    // A loaded Turn with no loaded message: its first request is still running, or it ended before
    // saving any text. Its cards stay where it started. A Turn outside the loaded window is not guessed.
    const turn = input.records.Turn?.[turnId];
    if (turn && turn.conversation_id === input.conversationId) {
      placeByTime(result, card, timestamp(turn.created_at), result.turnWithoutMessage, input);
    }
  }
  result.unbound.push(...pinnedFailures.slice(-MAX_PINNED_FAILED_COLLABORATION_CARDS));
  return result;
}

/**
 * Places a card by a time (when it was sent, or when its Turn started): after the last loaded
 * message created at or before it; into `pinned` when every loaded message is older, or when there
 * is no time or no loaded creation time to compare with; before the first message when it is older
 * than every loaded message and message 1 is loaded. Omitted when it predates a loaded window that
 * starts after message 1: the earlier history holds its position.
 */
function placeByTime(
  result: CollaborationTimeline,
  card: CollaborationTimelineCard,
  at: number | undefined,
  pinned: CollaborationTimelineCard[],
  input: { messages: ReadonlyArray<{ id: string; createdAt?: number }>; loadedFromFirstMessage: boolean }
): void {
  let anchor: string | undefined;
  let newer = false;
  if (at !== undefined) {
    for (const message of input.messages) {
      if (typeof message.createdAt !== 'number' || message.createdAt <= 0) continue;
      if (message.createdAt <= at) anchor = message.id;
      else newer = true;
    }
  }
  if (anchor && newer) (result.afterMessage[anchor] ??= []).push(card);
  else if (!newer) pinned.push(card);
  else if (input.loadedFromFirstMessage) (result.beforeMessage[input.messages[0].id] ??= []).push(card);
}

function timestamp(value: PlainData | undefined): number | undefined {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function collaborationCardLabel(card: CollaborationTimelineCard): string {
  const peer = collaborationPeerLabel(card.peer);
  return card.direction === 'incoming' ? `来自${peer}` : `发往${peer}`;
}

/** The state badge, or an empty string when the message simply arrived. */
export function collaborationCardStatusLabel(card: CollaborationTimelineCard): string {
  if (card.status === 'failed') return '投递失败';
  if (card.status === 'settled') return '';
  if (card.direction === 'incoming') return '等待下一轮处理';
  if (card.readBy === 'current-turn') return '已送达，对方本轮读取';
  if (card.readBy === 'next-turn') return '已送达，对方下一轮读取';
  return '等待对方处理';
}

export function collaborationCardKindLabel(card: CollaborationTimelineCard): string {
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
