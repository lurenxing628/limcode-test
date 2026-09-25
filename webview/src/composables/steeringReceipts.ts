import { ref } from 'vue';
import type { NativeSteeringReceipt, OpenAIResponsesSteeringState } from '@shared/openAIResponsesNative';

/**
 * 会话级已提交回执。通知从输入区退出不删除这里的状态：重载与 Host 重连仍须从后端持久
 * PendingTurnInput 的 status 重新读取，不以当前进程的发送成功或 UI 通知推断是否生效。
 */
const receiptsByConversation = ref<Record<string, Record<string, NativeSteeringReceipt>>>({});

export const STEERING_COMPLETION_NOTICE_MS = 4_000;

export interface SteeringReceiptPresentation {
  label: string;
  detail: string;
  provenApplied: boolean;
  dismissible: boolean;
}

export function steeringReceiptsByConversationState() {
  return receiptsByConversation;
}

/** 只有具有完整后继身份、且同一请求没有其它回执认领同一前驱或后继时，才可标为已生效。 */
export function hasSteeringApplicationReceipt(
  receipt: NativeSteeringReceipt,
  requestReceipts: readonly NativeSteeringReceipt[] = []
): boolean {
  if (!((receipt.state === 'continuing' || receipt.state === 'completed')
    && Boolean(receipt.submissionId?.trim())
    && Boolean(receipt.conversationId?.trim())
    && Boolean(receipt.turnId?.trim())
    && Boolean(receipt.modelRequestId?.trim())
    && Boolean(receipt.messageId?.trim())
    && Boolean(receipt.targetResponseId?.trim())
    && Boolean(receipt.successorResponseId?.trim())
    && receipt.targetResponseId !== receipt.successorResponseId
    && (!receipt.responseId || receipt.responseId === receipt.successorResponseId))) return false;
  return !requestReceipts.some((other) =>
    other.submissionId !== receipt.submissionId
    && (other.state === 'continuing' || other.state === 'completed')
    && other.conversationId === receipt.conversationId
    && other.turnId === receipt.turnId
    && other.modelRequestId === receipt.modelRequestId
    && ((Boolean(other.targetResponseId) && other.targetResponseId === receipt.targetResponseId)
      || (Boolean(other.successorResponseId) && other.successorResponseId === receipt.successorResponseId))
  );
}

/** 状态标签仅描述经证实的事实；ACK 与转向内容被模型消费是两件不同的事。 */
export function steeringReceiptPresentation(
  receipt: NativeSteeringReceipt,
  requestReceipts: readonly NativeSteeringReceipt[] = []
): SteeringReceiptPresentation {
  const provenApplied = hasSteeringApplicationReceipt(receipt, requestReceipts);
  switch (receipt.state) {
    case 'queued':
      return { label: '已提交 · 未确认生效', detail: '已保存转向消息，尚未确认发送。', provenApplied, dismissible: false };
    case 'sent':
      return { label: '已发送 · 未确认生效', detail: '已发送到提供方，不能据此判断内容已生效。', provenApplied, dismissible: false };
    case 'accepted':
      return { label: '已接受 · 未确认生效', detail: '提供方已接受提交，仍需等待精确后继响应及持久回执。', provenApplied, dismissible: false };
    case 'waiting_for_input':
      return { label: '等待输入 · 未确认生效', detail: '提供方仍在等待必需输入；转向是否生效尚未确认。', provenApplied, dismissible: false };
    case 'continuing':
      return provenApplied
        ? { label: '已生效 · 正在继续', detail: '已确认后继响应与转向回执，并已提交模型上下文。', provenApplied, dismissible: false }
        : { label: '正在继续 · 生效待确认', detail: '后继身份缺失或多条回执相互冲突，请等待并核对历史详情。', provenApplied, dismissible: false };
    case 'completed':
      return provenApplied
        ? { label: '已完成', detail: '已确认转向生效；输入区提示将自动收起，历史消息与回执仍保留。', provenApplied, dismissible: false }
        : { label: '已结束 · 生效待确认', detail: '后继身份缺失或多条回执相互冲突；请核对历史详情，必要时在输入框重新提交。', provenApplied, dismissible: true };
    case 'failed':
      return { label: '失败 · 未生效', detail: '转向未生效；请检查原因，在输入框调整后重新提交。不会自动重发。', provenApplied, dismissible: true };
    case 'delivery_unknown':
      return { label: '投递状态未知', detail: '无法确认是否生效；请先核对后继回复及历史详情，再决定是否重新提交。不会自动重发。', provenApplied, dismissible: true };
  }
}

export function steeringReceiptDismissKey(receipt: NativeSteeringReceipt): string {
  return `${receipt.conversationId}\u0000${receipt.submissionId}`;
}

/** 关闭只关闭当前状态的 UI 提示；新的持久回执更新会重新出现。 */
export function steeringReceiptVersion(receipt: NativeSteeringReceipt): string {
  return [receipt.state, receipt.updatedAt, receipt.modelRequestId, receipt.messageId,
    receipt.targetResponseId, receipt.successorResponseId, receipt.responseId].join('\u0000');
}

/** 当前 Host 会话的全量 status 最多自动读取一次；换 Host 必须再从持久记录读取。 */
export function steeringStatusSessionKey(conversationId: string, sessionId: string): string {
  return `${sessionId}\u0000${conversationId}`;
}

export function visibleSteeringReceipts(
  receipts: readonly NativeSteeringReceipt[],
  now: number,
  dismissedVersions: Readonly<Record<string, string>> = {}
): NativeSteeringReceipt[] {
  return receipts.filter((receipt) =>
    dismissedVersions[steeringReceiptDismissKey(receipt)] !== steeringReceiptVersion(receipt)
    && !(receipt.state === 'completed'
      && hasSteeringApplicationReceipt(receipt, receipts)
      && receipt.updatedAt + STEERING_COMPLETION_NOTICE_MS <= now)
  );
}

/** 真实定时器由 Vue 面板使用此期限唤醒，状态不需要新的推送才能自动退出。 */
export function nextSteeringCompletionExpiry(
  receipts: readonly NativeSteeringReceipt[],
  now: number,
  dismissedVersions: Readonly<Record<string, string>> = {}
): number | undefined {
  let earliest: number | undefined;
  for (const receipt of receipts) {
    if (receipt.state !== 'completed' || !hasSteeringApplicationReceipt(receipt, receipts)) continue;
    if (dismissedVersions[steeringReceiptDismissKey(receipt)] === steeringReceiptVersion(receipt)) continue;
    const deadline = receipt.updatedAt + STEERING_COMPLETION_NOTICE_MS;
    if (deadline <= now) continue;
    if (earliest === undefined || deadline < earliest) earliest = deadline;
  }
  return earliest;
}

const FORWARD_STATES: Record<OpenAIResponsesSteeringState, readonly OpenAIResponsesSteeringState[]> = {
  queued: ['sent', 'accepted', 'waiting_for_input', 'continuing', 'completed', 'failed', 'delivery_unknown'],
  sent: ['accepted', 'waiting_for_input', 'continuing', 'completed', 'failed', 'delivery_unknown'],
  accepted: ['waiting_for_input', 'continuing', 'completed', 'failed', 'delivery_unknown'],
  waiting_for_input: ['continuing', 'completed', 'failed', 'delivery_unknown'],
  continuing: ['completed'],
  completed: [],
  failed: [],
  delivery_unknown: []
};

const STEERING_IDENTITY_FIELDS = ['modelRequestId', 'messageId', 'targetResponseId', 'successorResponseId'] as const;

function sameStateUpdateIsMoreComplete(previous: NativeSteeringReceipt, candidate: NativeSteeringReceipt): boolean {
  if (previous.responseId && previous.responseId !== candidate.responseId) return false;
  const fields = [...STEERING_IDENTITY_FIELDS, 'responseId'] as const;
  return fields.some((field) => !previous[field] && !!candidate[field]);
}

/** Live 推送与 status 全量读取可能乱序；旧状态和损坏身份不得覆盖已有回执。 */
export function mergeSteeringReceipts(conversationId: string, receipts: readonly NativeSteeringReceipt[]): void {
  if (receipts.length === 0) return;
  const merged = { ...(receiptsByConversation.value[conversationId] ?? {}) };
  let changed = false;
  for (const receipt of receipts) {
    if (receipt.conversationId !== conversationId || !receipt.submissionId || !Number.isFinite(receipt.updatedAt)) continue;
    const previous = merged[receipt.submissionId];
    if (previous && (
      previous.turnId !== receipt.turnId
      || STEERING_IDENTITY_FIELDS.some((field) => previous[field] && previous[field] !== receipt[field])
      || previous.updatedAt > receipt.updatedAt
      || (previous.state !== receipt.state
        && !(FORWARD_STATES[previous.state] as readonly string[]).includes(receipt.state))
      || (previous.state === receipt.state
        && !sameStateUpdateIsMoreComplete(previous, receipt)
        && (previous.updatedAt === receipt.updatedAt
          || Boolean(previous.responseId && previous.responseId !== receipt.responseId)))
    )) continue;
    merged[receipt.submissionId] = receipt;
    changed = true;
  }
  if (changed) receiptsByConversation.value = { ...receiptsByConversation.value, [conversationId]: merged };
}
