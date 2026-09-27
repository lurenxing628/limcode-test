import type { ConversationOriginLinkRecord } from '@shared/protocol';

/**
 * What the sidebar shows around a conversation deletion (conversationDeleteCommand): the confirm
 * text, the kind of the result notice, and which entries are hidden while it runs.
 */

/**
 * Confirm text. `target` is the already escaped label. A child Agent's parent only receives the
 * deletion result when it is waiting for this child right now; an answer it has not taken in yet is
 * dropped.
 */
export function deleteConfirmDescriptionHtml(target: string, childAgent: boolean): string {
  const parentNotice = childAgent
    ? '如果父对话正在等这个子任务，它会得知这个子任务对话已被用户删除；父对话还没接收的这个子任务的答复会被丢弃，不会再送达。'
    : '';
  return `会先停止${target}和它的子任务里正在运行的任务（包括后台进程），然后删除${target}、其启动的所有子 Agent 对话，以及关联消息、工具记录和运行记录，<strong>不能撤销</strong>。${parentNotice}`;
}

/** A deletion that did not complete in time is not a refusal: its stop requests stay. */
export function operationNoticeKind(ok: boolean, severity?: string): 'info' | 'warning' | 'error' {
  if (ok) return 'info';
  return severity === 'warning' ? 'warning' : 'error';
}

/**
 * The entries hidden while their deletion runs or after it: the deleted ones and every child Agent
 * conversation below them (they are deleted with them), never a user's fork of one.
 */
export function withDeletedDescendants(
  hiddenIds: ReadonlySet<string>,
  originLinks: readonly ConversationOriginLinkRecord[]
): Set<string> {
  const hidden = new Set(hiddenIds);
  const childrenBySource = new Map<string, string[]>();
  for (const link of originLinks) {
    if (link.originKind !== 'agent' || !link.sourceConversationId || link.sourceConversationId === link.conversationId) continue;
    const children = childrenBySource.get(link.sourceConversationId) ?? [];
    children.push(link.conversationId);
    childrenBySource.set(link.sourceConversationId, children);
  }
  const pending = [...hidden];
  while (pending.length > 0) {
    for (const childId of childrenBySource.get(pending.pop()!) ?? []) {
      if (hidden.has(childId)) continue;
      hidden.add(childId);
      pending.push(childId);
    }
  }
  return hidden;
}
