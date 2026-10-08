import { BridgeMessageType, type MessageContent, type MessageRecord } from '@shared/protocol';
import type { PendingTurnInputSubmission } from '@webview/composables/useChat';
import type { ReliableKernelDetailState } from '@webview/stores/useReliableKernelClientFeedStore';
import { reliableKernelDetailKey } from './reliableDetailKey';

type Records = Record<string, Record<string, Record<string, unknown>>>;

/** Identity only: the original body remains in its existing pending submission. */
export interface TurnInputDisplayTarget {
  messageId: string;
  revisionId: string;
}

export interface TurnInputObservation {
  observed: boolean;
  durableReceiptObserved: boolean;
  displayTarget?: TurnInputDisplayTarget;
  displayInvalidated: boolean;
}

/** A command ACK names the Turn; its input Link names the exact Message. Never compare bodies. */
export function observeTurnInputSubmission(records: Records, pending: PendingTurnInputSubmission): TurnInputObservation {
  const result = pending.result;
  const durableReceiptObserved = Object.values(records.ConversationCommandReceipt ?? {}).some((receipt) =>
    receipt.command_id === pending.commandId && receipt.conversation_id === pending.conversationId);
  const turn = result?.admitted && result.turnId ? records.Turn?.[result.turnId] : undefined;
  const intent = result?.intentId ? records.TurnIntent?.[result.intentId] : undefined;
  const resultProjectionObserved = Boolean(turn?.conversation_id === pending.conversationId
    || intent?.conversation_id === pending.conversationId);
  let displayTarget = pending.displayTarget;
  let displayInvalidated = false;
  if (!displayTarget && turn?.conversation_id === pending.conversationId) {
    const inputs = Object.values(records.MessageTurnLink ?? {}).filter((link) =>
      link.turn_id === result!.turnId && link.role === 'input');
    const message = inputs.length === 1 && typeof inputs[0].message_id === 'string'
      ? records.Message?.[inputs[0].message_id] : undefined;
    if (message?.conversation_id === pending.conversationId && message.role === 'user') {
      // Another window can edit or delete the input before its first detail response. Its current
      // revision must then render itself, rather than receiving the submitted draft as a body.
      displayInvalidated = message.deleted_at != null || String(message.revision_seq) !== '1';
      if (!displayInvalidated && typeof message.id === 'string' && typeof message.revision_id === 'string') {
        displayTarget = { messageId: message.id, revisionId: message.revision_id };
      }
    }
  }
  if (displayTarget) {
    const message = records.Message?.[displayTarget.messageId];
    displayInvalidated = !!message && (message.conversation_id !== pending.conversationId
      || message.role !== 'user' || message.deleted_at != null || message.revision_id !== displayTarget.revisionId);
  }
  return { observed: durableReceiptObserved || resultProjectionObserved, durableReceiptObserved,
    ...(displayTarget ? { displayTarget } : {}), displayInvalidated };
}

export function turnInputDisplayReady(
  observation: TurnInputObservation,
  details: Record<string, ReliableKernelDetailState>
): boolean {
  return !!observation.displayTarget
    && details[reliableKernelDetailKey('message-content', observation.displayTarget.revisionId)]?.status === 'ready';
}

export interface TurnInputEcho {
  submission: PendingTurnInputSubmission;
  displayTarget?: TurnInputDisplayTarget;
  label: string;
}

/** Local presentation only. Queued input never masquerades as an admitted Message or Turn. */
export function turnInputEcho(
  pending: PendingTurnInputSubmission,
  observation: TurnInputObservation,
  details: Record<string, ReliableKernelDetailState>
): TurnInputEcho | undefined {
  if (pending.withdrawnAt || pending.result?.admitted === false || observation.displayInvalidated
    || turnInputDisplayReady(observation, details)
    || (pending.requestType === BridgeMessageType.TurnEnqueue && pending.result?.admitted !== true)) return undefined;
  return { submission: pending, ...(observation.displayTarget ? { displayTarget: observation.displayTarget } : {}),
    label: pending.result || observation.durableReceiptObserved ? '已保存，正在显示'
      : (pending.automaticRetryCount ?? 0) > 0 ? '消息尚未确认，可重试' : '提交中' };
}

export function turnInputEchoContent(echo: TurnInputEcho): MessageContent {
  return echo.submission.content ?? { role: 'user', parts: [{ text: echo.submission.text }] };
}

/** Adapts the same pending draft to the existing renderer; never inserts it into Runtime records. */
export function turnInputEchoMessage(echo: TurnInputEcho): MessageRecord {
  return { id: `pending:${echo.submission.commandId}`, conversationId: echo.submission.conversationId,
    role: 'user', content: turnInputEchoContent(echo), status: 'final', createdAt: echo.submission.submittedAt, seq: 0 };
}
