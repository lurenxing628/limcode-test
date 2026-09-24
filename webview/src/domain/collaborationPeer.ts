import type { PlainData } from '@shared/plainData';
import { displayConversationTitle } from '@shared/conversationTitle';

type FeedRecord = { [key: string]: PlainData };
type FeedRecords = Record<string, Record<string, FeedRecord>>;

/** The other Conversation of a collaboration message, as far as this view knows it. */
export type CollaborationPeer =
  | { state: 'known'; conversationId: string; title: string }
  | { state: 'deleted'; conversationId: string }
  /** No loaded fact names it: neither alive nor removed as far as this view knows. */
  | { state: 'unknown'; conversationId: string };

/**
 * Resolves a peer from the live Conversation rows, the snapshot's peer set and the removals this
 * view observed. Only an observed removal or a deleted status counts as deleted; a peer merely
 * missing from the bounded lists is unknown. Titles follow the sidebar: a placeholder title falls
 * back to the peer's first user message.
 */
export function resolveCollaborationPeer(
  records: FeedRecords,
  conversationId: string,
  removedConversationIds: readonly string[]
): CollaborationPeer {
  if (removedConversationIds.includes(conversationId)) return { state: 'deleted', conversationId };
  const live = records.Conversation?.[conversationId];
  const peer = records.CollaborationPeerConversation?.[conversationId];
  const current = live ?? peer;
  if (!current) return { state: 'unknown', conversationId };
  if (current.status === 'deleted') return { state: 'deleted', conversationId };
  const fallbackTitle = text(peer?.display_title);
  return {
    state: 'known',
    conversationId,
    title: displayConversationTitle({
      id: conversationId,
      title: text(current.title),
      ...(fallbackTitle ? { fallbackTitle } : {})
    })
  };
}

/**
 * Adds the Conversations removed by one committed change batch to this view's bounded memory of
 * removals, newest last.
 */
export function rememberRemovedConversations(previous: readonly string[], changes: unknown, limit = 256): string[] {
  const removed = (Array.isArray(changes) ? changes : []).flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const change = value as { type?: unknown; operation?: unknown; id?: unknown };
    return change.type === 'Conversation' && change.operation === 'remove' && typeof change.id === 'string' && change.id
      ? [change.id]
      : [];
  });
  if (removed.length === 0) return [...previous];
  return [...previous.filter((id) => !removed.includes(id)), ...removed].slice(-limit);
}

/** "对话 标题", "已删除的对话" or, for an unknown peer, "对话 3f9a2c…". */
export function collaborationPeerLabel(peer: CollaborationPeer): string {
  if (peer.state === 'known') return `对话 ${peer.title}`;
  if (peer.state === 'deleted') return '已删除的对话';
  return `对话 ${shortConversationId(peer.conversationId)}…`;
}

function shortConversationId(conversationId: string): string {
  return conversationId.replace(/^conversation[-:_]/i, '').slice(0, 6);
}

function text(value: PlainData | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}
