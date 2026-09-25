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

/** How the peer relates to this Conversation, as far as committed child links in this view show. */
export type CollaborationPeerRelation = 'child' | 'conversation';

/**
 * A peer is this Conversation's child Agent when its ChildExecution was spawned by a Turn of this
 * Conversation. Anything the bounded view cannot prove stays an ordinary conversation.
 */
export function collaborationPeerRelation(
  records: FeedRecords,
  conversationId: string,
  peerConversationId: string
): CollaborationPeerRelation {
  const child = Object.values(records.ChildExecution ?? {})
    .find((execution) => text(execution.child_conversation_id) === peerConversationId);
  if (!child) return 'conversation';
  const parent = Object.values(records.ChildExecutionParentLink ?? {})
    .find((link) => text(link.child_execution_id) === text(child.id));
  const parentTurn = records.Turn?.[text(parent?.parent_turn_id)];
  return parentTurn && text(parentTurn.conversation_id) === conversationId ? 'child' : 'conversation';
}

/** "对话 标题" / "子 Agent 标题", "已删除的对话" or, for an unknown peer, "对话 3f9a2c…". */
export function collaborationPeerLabel(peer: CollaborationPeer, relation: CollaborationPeerRelation = 'conversation'): string {
  const noun = relation === 'child' ? '子 Agent' : '对话';
  if (peer.state === 'known') return `${noun} ${peer.title}`;
  if (peer.state === 'deleted') return relation === 'child' ? '已删除的子 Agent' : '已删除的对话';
  return `${noun} ${shortConversationId(peer.conversationId)}…`;
}

function shortConversationId(conversationId: string): string {
  return conversationId.replace(/^conversation[-:_]/i, '').slice(0, 6);
}

function text(value: PlainData | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}
