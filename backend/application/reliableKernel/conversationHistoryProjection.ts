import {
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  isInlineDataPart,
  isTextPart,
  type MessageContent
} from '../../../shared/protocol';
import type { DomainRow } from '../../reliableKernel/repositories';

export const CHILD_HISTORY_STATUS = {
  running: '运行中',
  awaitingParent: '等待主 Agent 接收',
  deliveryFailed: '答案交付失败',
  interrupted: '已中断'
} as const;

export type ChildConversationHistoryState =
  | 'running'
  | 'awaiting_parent'
  | 'completed'
  | 'delivery_failed'
  | 'interrupted';

export interface ChildConversationHistoryFacts {
  turns: readonly DomainRow[];
  leases: readonly DomainRow[];
  childExecutions: readonly DomainRow[];
  activeTurnLinks: readonly DomainRow[];
  answerBridges: readonly DomainRow[];
  inboxItems: readonly DomainRow[];
  deliveries: readonly DomainRow[];
  deliveryWakes: readonly DomainRow[];
  deliveryInputLinks: readonly DomainRow[];
}

export interface ChildConversationHistoryProjection {
  state: ChildConversationHistoryState;
  isRunning: boolean;
  runStatusLabel?: string;
}

/**
 * Derive the sidebar state from the independent ChildExecution/answer/delivery facts.
 *
 * In particular, a generic active Turn is not enough to keep a child marked as running: the
 * ChildExecutionActiveTurnLink, active Turn and matching ExecutionLease must all agree. Likewise,
 * parent handling is only complete when the exact RuntimeDeliveryInputLink has handled_at.
 */
export function projectChildConversationHistory(
  conversationId: string,
  facts: ChildConversationHistoryFacts
): ChildConversationHistoryProjection | undefined {
  const child = facts.childExecutions.find((row) => row.child_conversation_id === conversationId);
  if (!child) return undefined;

  const childExecutionId = String(child.id);
  const bridge = facts.answerBridges.find((row) => row.child_execution_id === childExecutionId);
  const childStatus = text(child.status);
  if (
    childStatus === 'interrupting'
    || childStatus === 'interrupted'
    || bridge?.status === 'interrupted'
  ) {
    return {
      state: 'interrupted',
      isRunning: false,
      runStatusLabel: CHILD_HISTORY_STATUS.interrupted
    };
  }
  const activeLink = facts.activeTurnLinks.find((row) => row.child_execution_id === childExecutionId);
  const activeTurnId = text(activeLink?.turn_id);
  const activeTurn = activeTurnId
    ? facts.turns.find((row) => row.id === activeTurnId && row.status === 'active')
    : undefined;
  const activeLease = activeTurnId
    ? facts.leases.find((row) => row.turn_id === activeTurnId && row.conversation_id === conversationId)
    : undefined;
  if (activeLink && activeTurn && activeLease) {
    return { state: 'running', isRunning: true, runStatusLabel: CHILD_HISTORY_STATUS.running };
  }

  const submissionId = text(bridge?.current_submission_id);
  if (!submissionId) {
    // An idle/resumable child has not submitted anything to deliver. Absence of a submission is
    // therefore not a failed RuntimeDelivery fact.
    return { state: 'completed', isRunning: false };
  }

  const inbox = facts.inboxItems.find((row) =>
    row.source_kind === 'answer_submission' && row.source_id === submissionId
  );
  if (!inbox) {
    return {
      state: 'delivery_failed',
      isRunning: false,
      runStatusLabel: CHILD_HISTORY_STATUS.deliveryFailed
    };
  }

  const delivery = latestDelivery(facts.deliveries.filter((row) => row.inbox_item_id === inbox.id));
  // No RuntimeDelivery means the answer directly settled a foreground run_agent wait. The
  // AnswerSubmission transaction itself is then the durable completion fact.
  if (!delivery) return { state: 'completed', isRunning: false };

  if (delivery.state === 'failed') {
    return {
      state: 'delivery_failed',
      isRunning: false,
      runStatusLabel: CHILD_HISTORY_STATUS.deliveryFailed
    };
  }
  // notify_only is deliberately not a parent-model input. Once the answer has a durable delivery
  // fact the child result is retained for history/read_agent_answer, even if the best-effort UI
  // notification acknowledgement has not run yet. It must never masquerade as parent handling.
  if (delivery.phase === 'notify_only') return { state: 'completed', isRunning: false };
  if (delivery.state === 'pending') {
    return {
      state: 'awaiting_parent',
      isRunning: false,
      runStatusLabel: CHILD_HISTORY_STATUS.awaitingParent
    };
  }
  if (delivery.state !== 'consumed') {
    return {
      state: 'delivery_failed',
      isRunning: false,
      runStatusLabel: CHILD_HISTORY_STATUS.deliveryFailed
    };
  }

  const inputLink = facts.deliveryInputLinks.find((row) => row.delivery_id === delivery.id);
  if (inputLink && text(inputLink.handled_at)) return { state: 'completed', isRunning: false };
  const wake = facts.deliveryWakes.find((row) => row.delivery_id === delivery.id);
  if (wake?.state === 'dead_letter') {
    return {
      state: 'delivery_failed',
      isRunning: false,
      runStatusLabel: CHILD_HISTORY_STATUS.deliveryFailed
    };
  }
  const targetTurnId = text(delivery.target_turn_id);
  if (targetTurnId && facts.turns.some((row) => row.id === targetTurnId && row.status === 'terminated')) {
    // consumed only proves that the input row was injected. A terminal target plus a missing exact
    // handled_at proves the model never acknowledged that input; continuing to show awaiting_parent
    // would create the permanent stuck state observed in the field.
    return {
      state: 'delivery_failed',
      isRunning: false,
      runStatusLabel: CHILD_HISTORY_STATUS.deliveryFailed
    };
  }
  return {
    state: 'awaiting_parent',
    isRunning: false,
    runStatusLabel: CHILD_HISTORY_STATUS.awaitingParent
  };
}

/** Produce a bounded, user-facing preview from an immutable MessageContent object. */
export function conversationHistoryPreview(content: MessageContent): string {
  const visibleText = content.parts
    .filter(isTextPart)
    .filter((part) => part.thought !== true)
    .map((part) => part.text)
    .join('\n');
  const normalizedVisibleText = normalizePreview(visibleText);
  if (normalizedVisibleText) return normalizedVisibleText;

  const toolNames = content.parts
    .filter(isFunctionCallPart)
    .map((part) => part.functionCall.name.trim())
    .filter(Boolean);
  if (toolNames.length > 0) return normalizePreview(`调用工具：${unique(toolNames).join('、')}`);

  const responseNames = content.parts
    .filter(isFunctionResponsePart)
    .map((part) => part.functionResponse.name.trim())
    .filter(Boolean);
  if (responseNames.length > 0) return normalizePreview(`工具结果：${unique(responseNames).join('、')}`);

  const thoughtText = content.parts
    .filter(isTextPart)
    .filter((part) => part.thought === true)
    .map((part) => part.text)
    .join('\n');
  const normalizedThought = normalizePreview(thoughtText);
  if (normalizedThought) return normalizePreview(`思考：${normalizedThought}`);

  if (content.parts.some((part) => isInlineDataPart(part) || isFileDataPart(part))) return '附件消息';
  return content.parts.length > 0 ? '结构化消息' : '消息未包含可显示内容';
}

export function decodeConversationHistoryContent(value: string): MessageContent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return conversationHistoryContentFromParsed(parsed);
}

function conversationHistoryContentFromParsed(parsed: unknown): MessageContent | undefined {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.parts)) return undefined;
  return {
    role: record.role === 'model' ? 'model' : 'user',
    parts: record.parts as MessageContent['parts']
  };
}

/** One decoded immutable object supplies both sidebar title and preview. */
export function conversationHistoryPresentationFromBytes(
  bytes: Buffer,
  contentType: string
): { preview?: string; titleContent?: MessageContent } {
  const source = bytes.toString('utf8');
  if (contentType.toLowerCase().startsWith('text/plain')) {
    const titleContent: MessageContent = { role: 'user', parts: source ? [{ text: source }] : [] };
    return { preview: conversationHistoryPreview(titleContent), titleContent };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return {};
  }
  const titleContent = conversationHistoryContentFromParsed(parsed);
  if (titleContent) return { preview: conversationHistoryPreview(titleContent), titleContent };
  if (contentType === 'application/vnd.limcode.message+json') return {};
  if (!parsed || typeof parsed !== 'object') return source.trim() ? { preview: '结构化消息' } : {};
  const record = Array.isArray(parsed) ? undefined : parsed as Record<string, unknown>;
  if (record && ('inlineData' in record || 'fileData' in record || 'attachment' in record)) return { preview: '附件消息' };
  if (record && ('toolCallId' in record || 'toolName' in record || 'detail' in record)) return { preview: '工具结果' };
  return { preview: '结构化消息' };
}

/** Decode the canonical first-user content used by the shared conversation title formatter. */
export function conversationHistoryTitleContentFromBytes(
  bytes: Buffer,
  contentType: string
): MessageContent | undefined {
  const source = bytes.toString('utf8');
  if (contentType.toLowerCase().startsWith('text/plain')) {
    return { role: 'user', parts: source ? [{ text: source }] : [] };
  }
  return decodeConversationHistoryContent(source);
}

function latestDelivery(rows: readonly DomainRow[]): DomainRow | undefined {
  return [...rows].sort((left, right) =>
    compareInteger(right.attempt_seq, left.attempt_seq)
      || timestamp(right.updated_at) - timestamp(left.updated_at)
      || String(right.id).localeCompare(String(left.id))
  )[0];
}

function compareInteger(left: unknown, right: unknown): number {
  const leftValue = integer(left);
  const rightValue = integer(right);
  return leftValue > rightValue ? 1 : leftValue < rightValue ? -1 : 0;
}

function integer(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  return 0n;
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizePreview(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
