import { ref } from 'vue';
import { nativeSteeringStateFollows, type NativeSteeringReceipt } from '@shared/openAIResponsesNative';
import { hasSteeringApplicationReceipt } from '../domain/steeringReceiptProof.ts';

export { hasSteeringApplicationReceipt };

/**
 * 会话级已提交回执。通知从输入区退出不删除这里的状态：重载与 Host 重连仍须从后端持久
 * PendingTurnInput 的 status 重新读取，不以当前进程的发送成功或 UI 通知推断是否生效。
 */
const receiptsByConversation = ref<Record<string, Record<string, NativeSteeringReceipt>>>({});

export const STEERING_SUCCESS_NOTICE_MS = 4_000;

export interface SteeringReceiptPresentation {
  label: string;
  detail: string;
  provenApplied: boolean;
  dismissible: boolean;
}

export function steeringReceiptsByConversationState() {
  return receiptsByConversation;
}

/** 状态标签仅描述经证实的事实；ACK 与转向内容被模型消费是两件不同的事。 */
export function steeringReceiptPresentation(
  receipt: NativeSteeringReceipt,
  requestReceipts: readonly NativeSteeringReceipt[] = []
): SteeringReceiptPresentation {
  const provenApplied = hasSteeringApplicationReceipt(receipt, requestReceipts);
  switch (receipt.state) {
    case 'queued':
      return { label: '已提交', detail: '等待发送，生效待确认。', provenApplied, dismissible: false };
    case 'sent':
      return { label: '已发送', detail: '生效待确认。', provenApplied, dismissible: false };
    case 'accepted':
      return { label: '已接受', detail: '生效待确认。', provenApplied, dismissible: false };
    case 'waiting_for_input':
      return { label: '等待输入', detail: '生效待确认。', provenApplied, dismissible: false };
    case 'continuing':
      return provenApplied
        ? { label: '已生效', detail: '', provenApplied, dismissible: false }
        : { label: '继续中', detail: '生效待确认，请核对历史。', provenApplied, dismissible: false };
    case 'completed':
      return provenApplied
        ? { label: '已生效', detail: '', provenApplied, dismissible: false }
        : { label: '已结束', detail: '生效待确认，请核对历史。', provenApplied, dismissible: false };
    case 'failed':
      return { label: '转向失败', detail: '', provenApplied, dismissible: true };
    case 'delivery_unknown':
      return { label: '投递未知', detail: '请核对历史后决定是否重试（不会自动重发）。', provenApplied, dismissible: false };
  }
}

export function steeringReceiptDismissKey(receipt: Pick<NativeSteeringReceipt, 'conversationId' | 'submissionId'>): string {
  return `${receipt.conversationId}\u0000${receipt.submissionId}`;
}

/** 关闭只关闭当前状态的 UI 提示；新的持久回执更新会重新出现。 */
export function steeringReceiptVersion(receipt: NativeSteeringReceipt): string {
  return [receipt.state, receipt.updatedAt, receipt.modelRequestId, receipt.messageId,
    receipt.targetResponseId, receipt.successorResponseId, receipt.responseId].join('\u0000');
}

/** The key of this view's persisted state (VS Code webview state) that holds terminal dismissals. */
export const STEERING_DISMISSAL_STATE_KEY = 'steeringReceiptDismissals';
const STEERING_DISMISSALS_PER_CONVERSATION = 64;
const STEERING_DISMISSAL_CONVERSATIONS = 32;

/** This view's persisted state; per-viewer convenience only, never Runtime authority. */
export interface SteeringDismissalState {
  read(): unknown;
  write(value: Record<string, Record<string, string>>): void;
}

function persistedSteeringDismissals(state: SteeringDismissalState): Record<string, Record<string, string>> {
  let stored: unknown;
  try {
    stored = state.read();
  } catch {
    return {};
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const result: Record<string, Record<string, string>> = {};
  for (const [conversationId, entries] of Object.entries(stored as Record<string, unknown>)) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    const versions = Object.entries(entries as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string');
    if (versions.length > 0) result[conversationId] = Object.fromEntries(versions);
  }
  return result;
}

/**
 * Dismissed failed receipts of one Conversation from this view's persisted state, keyed like
 * `steeringReceiptDismissKey`. A reload or a new Host session does not bring back a failed steer the user already closed; its durable receipt is unchanged.
 */
export function readSteeringDismissals(state: SteeringDismissalState, conversationId: string): Record<string, string> {
  const entries = persistedSteeringDismissals(state)[conversationId] ?? {};
  return Object.fromEntries(Object.entries(entries).map(([submissionId, version]) =>
    [steeringReceiptDismissKey({ conversationId, submissionId }), version]));
}

/**
 * Remembers the dismissal of a failed receipt. Bounded per Conversation and across Conversations;
 * a failing state write keeps the dismissal for this session only.
 */
export function persistSteeringDismissal(state: SteeringDismissalState, receipt: NativeSteeringReceipt): void {
  if (!steeringReceiptPresentation(receipt).dismissible) return;
  const all = persistedSteeringDismissals(state);
  const { [receipt.conversationId]: current = {}, ...others } = all;
  const { [receipt.submissionId]: _previous, ...kept } = current;
  const entries = Object.entries({ ...kept, [receipt.submissionId]: steeringReceiptVersion(receipt) })
    .slice(-STEERING_DISMISSALS_PER_CONVERSATION);
  const next = Object.fromEntries([
    ...Object.entries(others).slice(-(STEERING_DISMISSAL_CONVERSATIONS - 1)),
    [receipt.conversationId, Object.fromEntries(entries)]
  ]);
  try {
    state.write(next);
  } catch {
    // Persisted view state is a convenience; the in-memory dismissal still applies.
  }
}

/** 当前 Host 会话的全量 status 最多自动读取一次；换 Host 必须再从持久记录读取。 */
export function steeringStatusSessionKey(conversationId: string, sessionId: string): string {
  return `${sessionId}\u0000${conversationId}`;
}

/** 输入区只展示已证实生效的短暂结果和明确失败；其它回执仍保留供历史投影使用。 */
export function visibleSteeringReceipts(
  receipts: readonly NativeSteeringReceipt[],
  now: number,
  dismissedVersions: Readonly<Record<string, string>> = {}
): NativeSteeringReceipt[] {
  return receipts.filter((receipt) =>
    (receipt.state === 'failed' || hasSteeringApplicationReceipt(receipt, receipts))
    && dismissedVersions[steeringReceiptDismissKey(receipt)] !== steeringReceiptVersion(receipt)
    && !(hasSteeringApplicationReceipt(receipt, receipts)
      && receipt.updatedAt + STEERING_SUCCESS_NOTICE_MS <= now)
  );
}

/** 已证实生效的继续中/已完成回执只短暂显示；面板按期限唤醒，无需等待下一次推送。 */
export function nextSteeringSuccessExpiry(
  receipts: readonly NativeSteeringReceipt[],
  now: number,
  dismissedVersions: Readonly<Record<string, string>> = {}
): number | undefined {
  let earliest: number | undefined;
  for (const receipt of receipts) {
    if (!hasSteeringApplicationReceipt(receipt, receipts)) continue;
    if (dismissedVersions[steeringReceiptDismissKey(receipt)] === steeringReceiptVersion(receipt)) continue;
    const deadline = receipt.updatedAt + STEERING_SUCCESS_NOTICE_MS;
    if (deadline <= now) continue;
    if (earliest === undefined || deadline < earliest) earliest = deadline;
  }
  return earliest;
}

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
      || (previous.state !== receipt.state && !nativeSteeringStateFollows(previous.state, receipt.state))
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
