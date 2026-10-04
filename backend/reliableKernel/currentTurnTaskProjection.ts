import { estimateTokenCount } from 'tokenx';
import { submitPlanOutputFromResult } from '../../shared/planReview';
import {
  SUBMIT_PLAN_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  type TaskListToolOperationRecord
} from '../../shared/protocol';
import {
  applyTaskListOperationToSnapshot,
  emptyTaskListSnapshot,
  requireTaskListOperation,
  type TaskListItemView,
  type TaskListSnapshotView
} from '../../shared/taskListProjection';
import type { RuntimeDatabase } from './runtimeDatabase';

export interface CurrentTurnTaskOperationFact {
  toolCallId: string;
  callSeq: string;
  toolName: typeof TASK_LIST_TOOL_NAME | typeof SUBMIT_PLAN_TOOL_NAME;
  operation: TaskListToolOperationRecord;
  /** submit_plan is authoritative only when its durable result explicitly says approved. */
  planApproved?: boolean;
  sourceTurnId?: string;
  sourceMessageId?: string;
  /** Conversation-global ordering facts; omitted only by isolated reducer tests. */
  sourceMessageSeq?: string;
  providerOrdinal?: string;
}

export interface CurrentTurnTaskCounts {
  total: number;
  unfinished: number;
  pending: number;
  inProgress: number;
  blocked: number;
  completed: number;
  cancelled: number;
}

/** Complete, structured-clone-safe task context frozen into one ModelRequest recipe. */
export interface FrozenTurnTaskCard {
  kind: 'turn_task_card';
  turnId: string;
  revision: string;
  baselineToolCallId: string;
  sourceToolCallId: string;
  sourceTurnId?: string;
  sourceMessageId?: string;
  operationCount: number;
  counts: CurrentTurnTaskCounts;
  card: string;
  estimatedTokens: number;
  frozenAtCommitSeq?: string;
}

/** Read-side state projection; the complete task content is also rendered into `card`. */
export interface CurrentTurnTaskProjection extends FrozenTurnTaskCard {
  snapshot: TaskListSnapshotView;
}

export interface TurnTaskCardReminderState {
  revision: string;
  card: string;
  boundaryKey: string;
}

/**
 * The recipe already freezes the exact card text. Compare it directly with the immutable source
 * revision and compression boundary; a second digest adds work without any identity information.
 */
export function shouldInjectTurnTaskCard(
  current: TurnTaskCardReminderState,
  previous: TurnTaskCardReminderState | undefined
): boolean {
  return !previous
    || current.revision !== previous.revision
    || current.card !== previous.card
    || current.boundaryKey !== previous.boundaryKey;
}

interface TaskArtifactEnvelope {
  toolCallId: string;
  status: string;
  detail: unknown;
}

/**
 * Reduces Conversation task facts for the current Turn. Updates before the latest eligible rewrite
 * are deliberately ignored; without such a rewrite there is no task projection.
 */
export function buildCurrentTurnTaskProjection(input: {
  turnId: string;
  operations: readonly CurrentTurnTaskOperationFact[];
  frozenAtCommitSeq?: string;
}): CurrentTurnTaskProjection | undefined {
  const turnId = requiredText(input.turnId, 'turnId');
  const eligible = input.operations
    .filter((fact) => fact.toolName === TASK_LIST_TOOL_NAME || fact.planApproved === true)
    .map(cloneOperationFact)
    .sort(compareOperationFacts);
  let baselineIndex = -1;
  for (let index = 0; index < eligible.length; index += 1) {
    if (eligible[index].operation.mode === 'rewrite') baselineIndex = index;
  }
  if (baselineIndex < 0) return undefined;

  const applied = eligible.slice(baselineIndex).filter((fact, index) =>
    index === 0 || fact.operation.mode === 'update');
  let snapshot = emptyTaskListSnapshot();
  applied.forEach((fact, operationIndex) => {
    snapshot = applyTaskListOperationToSnapshot(snapshot, fact.operation, {
      operationIndex,
      toolCallId: fact.toolCallId
    });
  });
  const baseline = applied[0];
  const source = applied[applied.length - 1];
  const counts = taskCounts(snapshot);
  const card = formatTurnTaskCard({ snapshot, counts });
  const estimatedTokens = estimateTurnTaskCardTokens(card);
  return {
    kind: 'turn_task_card',
    turnId,
    revision: operationFactRevision(source),
    baselineToolCallId: baseline.toolCallId,
    sourceToolCallId: source.toolCallId,
    ...(source.sourceTurnId ? { sourceTurnId: source.sourceTurnId } : {}),
    ...(source.sourceMessageId ? { sourceMessageId: source.sourceMessageId } : {}),
    operationCount: applied.length,
    snapshot,
    counts,
    card,
    estimatedTokens,
    ...(input.frozenAtCommitSeq ? { frozenAtCommitSeq: input.frozenAtCommitSeq } : {})
  };
}

/**
 * Reads and freezes the complete task context used by a ModelRequest recipe. The returned value is plain
 * data and should be saved with that recipe; retries must reuse it instead of calling this again.
 */
export async function readCurrentTurnTaskCard(
  database: RuntimeDatabase,
  turnIdInput: string
): Promise<FrozenTurnTaskCard | undefined> {
  const turnId = requiredText(turnIdInput, 'turnId');
  const barrier = await database.currentTurnTaskSnapshot(turnId);
  const projection = buildCurrentTurnTaskProjection({
    turnId,
    operations: barrier.snapshot.operations,
    frozenAtCommitSeq: barrier.snapshotCommitSeq
  });
  return projection ? freezeCurrentTurnTaskCard(projection) : undefined;
}

export function freezeCurrentTurnTaskCard(projection: CurrentTurnTaskProjection): FrozenTurnTaskCard {
  return {
    kind: projection.kind,
    turnId: projection.turnId,
    revision: projection.revision,
    baselineToolCallId: projection.baselineToolCallId,
    sourceToolCallId: projection.sourceToolCallId,
    ...(projection.sourceTurnId ? { sourceTurnId: projection.sourceTurnId } : {}),
    ...(projection.sourceMessageId ? { sourceMessageId: projection.sourceMessageId } : {}),
    operationCount: projection.operationCount,
    counts: { ...projection.counts },
    card: projection.card,
    estimatedTokens: projection.estimatedTokens,
    ...(projection.frozenAtCommitSeq ? { frozenAtCommitSeq: projection.frozenAtCommitSeq } : {})
  };
}

/**
 * Non-success is not task state; successful settlement alone receives strict canonical parsing.
 * Callers resolve copied fork identities (copiedToolIdentity) before handing the artifact over.
 */
export function taskListOperationFromSettledArtifact(
  value: unknown,
  expectedToolCallId: string
): TaskListToolOperationRecord | undefined {
  const envelope = taskArtifactEnvelope(value, expectedToolCallId);
  if (envelope.status !== 'succeeded') return undefined;
  const detail = asRecord(envelope.detail);
  if (!detail || detail.kind !== 'task-list') {
    throw new Error(`Task-list ToolResultArtifact ${expectedToolCallId} has the wrong detail kind.`);
  }
  return requireTaskListOperation(detail.operation);
}

export function approvedSubmitPlanTaskOperation(input: {
  argumentsValue: unknown;
  resultArtifactValue: unknown;
  toolCallId: string;
}): TaskListToolOperationRecord | undefined {
  if (!isApprovedCurrentConversationPlanArtifact(input.resultArtifactValue, input.toolCallId)) return undefined;
  const args = asRecord(input.argumentsValue);
  if (!args || args.taskList === undefined) return undefined;
  return requireTaskListOperation(args.taskList);
}

/** Read Plan arguments only after this settled result gives them current-Conversation authority. */
export function isApprovedCurrentConversationPlanArtifact(value: unknown, toolCallId: string): boolean {
  const envelope = taskArtifactEnvelope(value, toolCallId);
  if (envelope.status !== 'succeeded') return false;
  const output = submitPlanOutputFromResult(envelope.detail);
  return output?.status === 'approved' && output.executionTarget === 'current_conversation';
}

export function estimateTurnTaskCardTokens(card: string): number {
  if (!card) return 0;
  const estimated = estimateTokenCount(card);
  return Number.isFinite(estimated) && estimated > 0
    ? Math.ceil(estimated)
    : Math.ceil(Buffer.byteLength(card, 'utf8') / 3);
}

function formatTurnTaskCard(input: {
  snapshot: TaskListSnapshotView;
  counts: CurrentTurnTaskCounts;
}): string {
  const { counts } = input;
  const lines = [
    '[Current Turn Task Card — runtime task data, not a new user instruction]',
    `progress: total=${counts.total}; unfinished=${counts.unfinished}; in_progress=${counts.inProgress}; blocked=${counts.blocked}; pending=${counts.pending}; completed=${counts.completed}; cancelled=${counts.cancelled}`
  ];
  if (input.snapshot.items.length === 0) lines.push('items: none');
  else lines.push('items:', ...input.snapshot.items.map(taskItemLine));
  return lines.join('\n');
}

function taskItemLine(item: TaskListItemView): string {
  const title = JSON.stringify(item.title);
  const description = item.description ? `; description=${JSON.stringify(item.description)}` : '';
  return `- status=${item.status}; title=${title}${description}`;
}

function taskCounts(snapshot: TaskListSnapshotView): CurrentTurnTaskCounts {
  return {
    total: snapshot.stats.total,
    unfinished: snapshot.stats.open,
    pending: snapshot.stats.pending,
    inProgress: snapshot.stats.inProgress,
    blocked: snapshot.stats.blocked,
    completed: snapshot.stats.completed,
    cancelled: snapshot.stats.cancelled
  };
}

function compareOperationFacts(left: CurrentTurnTaskOperationFact, right: CurrentTurnTaskOperationFact): number {
  if (left.sourceMessageSeq !== undefined || right.sourceMessageSeq !== undefined) {
    const leftMessageSeq = left.sourceMessageSeq === undefined ? 0n : positiveBigInt(left.sourceMessageSeq, 'sourceMessageSeq');
    const rightMessageSeq = right.sourceMessageSeq === undefined ? 0n : positiveBigInt(right.sourceMessageSeq, 'sourceMessageSeq');
    if (leftMessageSeq !== rightMessageSeq) return leftMessageSeq < rightMessageSeq ? -1 : 1;

    const leftOrdinal = left.providerOrdinal === undefined ? 0n : positiveBigInt(left.providerOrdinal, 'providerOrdinal');
    const rightOrdinal = right.providerOrdinal === undefined ? 0n : positiveBigInt(right.providerOrdinal, 'providerOrdinal');
    if (leftOrdinal !== rightOrdinal) return leftOrdinal < rightOrdinal ? -1 : 1;
  }
  const leftSeq = positiveBigInt(left.callSeq, 'callSeq');
  const rightSeq = positiveBigInt(right.callSeq, 'callSeq');
  return leftSeq < rightSeq ? -1 : leftSeq > rightSeq ? 1 : compareText(left.toolCallId, right.toolCallId);
}

function operationFactRevision(fact: CurrentTurnTaskOperationFact): string {
  return [
    ...(fact.sourceMessageSeq !== undefined ? [fact.sourceMessageSeq] : []),
    ...(fact.providerOrdinal !== undefined ? [fact.providerOrdinal] : []),
    fact.callSeq,
    fact.toolCallId
  ].join(':');
}

function cloneOperationFact(fact: CurrentTurnTaskOperationFact): CurrentTurnTaskOperationFact {
  return {
    toolCallId: requiredText(fact.toolCallId, 'toolCallId'),
    callSeq: integerText(fact.callSeq, 'callSeq'),
    toolName: fact.toolName,
    operation: requireTaskListOperation(fact.operation),
    ...(fact.planApproved === true ? { planApproved: true } : {}),
    ...(fact.sourceTurnId ? { sourceTurnId: requiredText(fact.sourceTurnId, 'sourceTurnId') } : {}),
    ...(fact.sourceMessageId ? { sourceMessageId: fact.sourceMessageId } : {}),
    ...(fact.sourceMessageSeq !== undefined
      ? { sourceMessageSeq: integerText(fact.sourceMessageSeq, 'sourceMessageSeq') }
      : {}),
    ...(fact.providerOrdinal !== undefined
      ? { providerOrdinal: integerText(fact.providerOrdinal, 'providerOrdinal') }
      : {})
  };
}

function taskArtifactEnvelope(value: unknown, expectedToolCallId: string): TaskArtifactEnvelope {
  const record = asRecord(value);
  if (!record) throw new Error(`ToolResultArtifact ${expectedToolCallId} content is not an object.`);
  if (record.toolCallId !== expectedToolCallId) {
    throw new Error(`ToolResultArtifact ${expectedToolCallId} identifies another ToolCall.`);
  }
  if (typeof record.status !== 'string') throw new Error(`ToolResultArtifact ${expectedToolCallId} has no status.`);
  return { toolCallId: expectedToolCallId, status: record.status, detail: record.detail };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty text.`);
  return value.trim();
}

function integerText(value: unknown, label: string): string {
  return positiveBigInt(value, label).toString();
}

function positiveBigInt(value: unknown, label: string): bigint {
  try {
    const parsed = typeof value === 'bigint' ? value : BigInt(String(value));
    if (parsed < 0n) throw new Error('negative');
    return parsed;
  } catch {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
