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
  /** Committed but not yet bound to a target Turn (for example queued behind a running Turn). */
  waiting: boolean;
}

export interface CollaborationTimeline {
  /** Rendered above the anchor message: a delivery that started the anchor Turn. */
  beforeMessage: Record<string, CollaborationTimelineCard[]>;
  /** Rendered below the anchor message: received or sent while the anchor Turn ran. */
  afterMessage: Record<string, CollaborationTimelineCard[]>;
  /** Incoming messages that still wait for a target Turn. */
  unbound: CollaborationTimelineCard[];
}

/**
 * Places each collaboration envelope at the first visible message of the Turn it belongs to: the
 * delivery Turn for incoming messages and the sending Turn for outgoing ones. Messages whose Turn is
 * outside the loaded window are omitted instead of being shown at a misleading position.
 */
export function projectCollaborationTimeline(input: {
  conversationId: string;
  records: FeedRecords;
  messages: ReadonlyArray<{ id: string; role: string }>;
  turnIdByMessageId: Readonly<Record<string, string>>;
  /** Conversations this view saw removed; only these (or a deleted status) read as deleted. */
  removedConversationIds: readonly string[];
}): CollaborationTimeline {
  const result: CollaborationTimeline = { beforeMessage: {}, afterMessage: {}, unbound: [] };
  if (!input.conversationId) return result;
  const firstMessageByTurn = new Map<string, { id: string; role: string }>();
  for (const message of input.messages) {
    const turnId = input.turnIdByMessageId[message.id];
    if (turnId && !firstMessageByTurn.has(turnId)) firstMessageByTurn.set(turnId, message);
  }
  const sources = linksByMessage(input.records.CollaborationMessageSourceLink);
  const targets = linksByMessage(input.records.CollaborationMessageTargetLink);
  const deliveries = Object.values(input.records.RuntimeDelivery ?? {});
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
    const card: CollaborationTimelineCard = {
      messageId,
      direction: incoming ? 'incoming' : 'outgoing',
      peer: resolveCollaborationPeer(input.records, peerConversationId, input.removedConversationIds),
      kind: source.source_kind === 'completion' ? 'result' : message.mode === 'followup' ? 'followup' : 'message',
      textPreview: text(message.text_preview),
      waiting: false
    };
    let turnId: string;
    if (incoming) {
      const delivery = deliveries
        .filter((row) => row.inbox_item_id === target.inbox_item_id && row.target_conversation_id === input.conversationId)
        .sort((left, right) => compareSequence(right.attempt_seq, left.attempt_seq))[0];
      if (!delivery) continue;
      turnId = text(delivery.target_turn_id);
      if (!turnId) {
        if (delivery.state === 'pending') result.unbound.push({ ...card, waiting: true });
        continue;
      }
    } else {
      turnId = text(source.turn_id);
    }
    const anchor = firstMessageByTurn.get(turnId);
    if (!anchor) continue;
    // A delivery that started a Turn precedes that Turn's first reply; everything else follows the
    // Turn's opening user message.
    const bucket = incoming && anchor.role !== 'user' ? result.beforeMessage : result.afterMessage;
    (bucket[anchor.id] ??= []).push(card);
  }
  return result;
}

export function collaborationCardLabel(card: CollaborationTimelineCard): string {
  const peer = collaborationPeerLabel(card.peer);
  return card.direction === 'incoming' ? `来自${peer}` : `发往${peer}`;
}

export function collaborationCardKindLabel(card: CollaborationTimelineCard): string {
  if (card.kind === 'result') return '任务结果';
  return card.kind === 'followup' ? '续派任务' : '消息';
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
