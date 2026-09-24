import { createHash } from 'node:crypto';
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
import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import { toolArtifactsIdentifyCalls } from './copiedToolIdentity';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryRead } from './repositories';
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
  cardSha256: string;
  frozenAtCommitSeq?: string;
}

/** Read-side state projection; the complete task content is also rendered into `card`. */
export interface CurrentTurnTaskProjection extends FrozenTurnTaskCard {
  snapshot: TaskListSnapshotView;
}

export interface TurnTaskCardReminderState {
  revision: string;
  cardSha256: string;
  boundaryKey: string;
}

/** Decide whether the volatile task reminder must be rendered for a new ModelRequest. */
export function shouldInjectTurnTaskCard(
  current: TurnTaskCardReminderState,
  previous: TurnTaskCardReminderState | undefined
): boolean {
  return !previous
    || current.revision !== previous.revision
    || current.cardSha256 !== previous.cardSha256
    || current.boundaryKey !== previous.boundaryKey;
}

interface TaskArtifactEnvelope {
  toolCallId: string;
  status: string;
  detail: unknown;
}

/**
 * Reduces already-settled facts for exactly one Turn. Updates before the latest eligible rewrite
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
    cardSha256: createHash('sha256').update(card).digest('hex'),
    ...(input.frozenAtCommitSeq ? { frozenAtCommitSeq: input.frozenAtCommitSeq } : {})
  };
}

/**
 * Reads and freezes the complete task context used by a ModelRequest recipe. The returned value is plain
 * data and should be saved with that recipe; retries must reuse it instead of calling this again.
 */
export async function readCurrentTurnTaskCard(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  turnIdInput: string
): Promise<FrozenTurnTaskCard | undefined> {
  const turnId = requiredText(turnIdInput, 'turnId');
  const turnBarrier = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('Turn').get(turnId)
  ]);
  const currentTurn = requireDomainRow(turnBarrier.snapshot[0], `Turn ${turnId}`);
  const conversationId = requiredText(currentTurn.conversation_id, 'Turn.conversation_id');

  // Task state belongs to the Conversation. A new Turn continues from the latest visible rewrite
  // and may therefore issue update-only operations without recreating the whole list.
  const turnsBarrier = await database.snapshotAll(DOMAIN_REPOSITORIES.domain('Turn').list({
    where: { conversation_id: conversationId },
    orderBy: { column: 'id', direction: 'asc' },
    limit: 1_000
  }));
  const callReads: RepositoryRead[] = turnsBarrier.snapshot.map((turn) =>
    DOMAIN_REPOSITORIES.domain('ToolCall').list({
      where: { turn_id: requiredText(turn.id, 'Turn.id') },
      orderBy: { column: 'id', direction: 'asc' },
      limit: 1_000
    }));
  const callsBarrier = await database.snapshot(callReads);
  const calls = callsBarrier.snapshot
    .flatMap(rows)
    .filter((call) => call.tool_name === TASK_LIST_TOOL_NAME || call.tool_name === SUBMIT_PLAN_TOOL_NAME);
  if (calls.length === 0) return undefined;

  const relatedReads: RepositoryRead[] = calls.flatMap((call) => [
    DOMAIN_REPOSITORIES.domain('ToolResultArtifact').list({
      where: { tool_call_id: requiredText(call.id, 'ToolCall.id'), role: 'no_effect_result' },
      limit: 2
    }),
    DOMAIN_REPOSITORIES.domain('ContentObject').get(requiredText(call.arguments_object_id, 'ToolCall.arguments_object_id')),
    DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').list({
      where: { tool_call_id: requiredText(call.id, 'ToolCall.id') },
      limit: 2
    })
  ]);
  const relatedBarrier = await database.snapshot(relatedReads);
  const artifactRows: DomainRow[] = [];
  const argumentMetadata = new Map<string, ContentObjectMetadata>();
  const sourceLinks = new Map<string, DomainRow>();
  for (let index = 0; index < calls.length; index += 1) {
    const toolCallId = requiredText(calls[index].id, 'ToolCall.id');
    const artifacts = rows(relatedBarrier.snapshot[index * 3]);
    if (artifacts.length > 1) throw new Error(`ToolCall ${toolCallId} has multiple no-effect result artifacts.`);
    if (artifacts[0]) artifactRows.push(artifacts[0]);
    const metadata = relatedBarrier.snapshot[index * 3 + 1];
    if (metadata && !Array.isArray(metadata)) {
      argumentMetadata.set(toolCallId, metadata as ContentObjectMetadata);
    }
    const links = rows(relatedBarrier.snapshot[index * 3 + 2]);
    if (links.length > 1) throw new Error(`ToolCall ${toolCallId} has multiple source links.`);
    if (links[0]) sourceLinks.set(toolCallId, links[0]);
  }

  const artifactMetadataBarrier = await database.snapshot(artifactRows.map((artifact) =>
    DOMAIN_REPOSITORIES.domain('ContentObject').get(requiredText(
      artifact.content_object_id,
      'ToolResultArtifact.content_object_id'
    ))));
  const artifactByCallId = new Map<string, unknown>();
  for (let index = 0; index < artifactRows.length; index += 1) {
    const metadata = artifactMetadataBarrier.snapshot[index];
    if (!metadata || Array.isArray(metadata)) {
      throw new Error(`ToolResultArtifact ${String(artifactRows[index].id)} references missing content.`);
    }
    artifactByCallId.set(
      requiredText(artifactRows[index].tool_call_id, 'ToolResultArtifact.tool_call_id'),
      await readJson(contentStore, metadata as ContentObjectMetadata, 'ToolResultArtifact')
    );
  }

  const sourcedCalls = calls.flatMap((call) => {
    const toolCallId = requiredText(call.id, 'ToolCall.id');
    const source = sourceLinks.get(toolCallId);
    return source ? [{ call, toolCallId, source }] : [];
  });
  const messageBarrier = await database.snapshot(sourcedCalls.flatMap(({ source }) => {
    const messageId = requiredText(source.message_id, 'ToolCallSourceLink.message_id');
    return [
      DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({
        where: { message_id: messageId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('Message').get(messageId)
    ];
  }));
  const ordering = new Map<string, {
    sourceMessageId: string;
    sourceMessageSeq: string;
    providerOrdinal: string;
  }>();
  for (let index = 0; index < sourcedCalls.length; index += 1) {
    const { toolCallId, source } = sourcedCalls[index];
    const memberships = rows(messageBarrier.snapshot[index * 2]);
    if (memberships.length !== 1) throw new Error(`Task ToolCall ${toolCallId} must have one Message membership.`);
    const message = messageBarrier.snapshot[index * 2 + 1];
    if (!message || Array.isArray(message)) throw new Error(`Task ToolCall ${toolCallId} references a missing Message.`);
    if (memberships[0].conversation_id !== conversationId || message.deleted_at !== null) continue;
    ordering.set(toolCallId, {
      sourceMessageId: requiredText(source.message_id, 'ToolCallSourceLink.message_id'),
      sourceMessageSeq: integerText(memberships[0].message_seq, 'MessagePartOfConversation.message_seq'),
      providerOrdinal: integerText(source.provider_ordinal, 'ToolCallSourceLink.provider_ordinal')
    });
  }

  // A fork copies ToolCalls under new ids while the artifact content still names the original call.
  const claimedArtifacts = calls.flatMap((call) => {
    const toolCallId = requiredText(call.id, 'ToolCall.id');
    const artifact = asRecord(artifactByCallId.get(toolCallId));
    if (!ordering.has(toolCallId) || !artifact || artifact.toolCallId === toolCallId) return [];
    return [{ call, toolCallId, artifact }];
  });
  let frozenAtCommitSeq = messageBarrier.snapshotCommitSeq;
  if (claimedArtifacts.length > 0) {
    const identities = await toolArtifactsIdentifyCalls(database, claimedArtifacts.map(({ call, artifact }) => ({
      claimedId: artifact.toolCallId,
      call
    })));
    claimedArtifacts.forEach(({ toolCallId, artifact }, index) => {
      if (identities.identified[index]) artifactByCallId.set(toolCallId, { ...artifact, toolCallId });
    });
    frozenAtCommitSeq = identities.snapshotCommitSeq ?? frozenAtCommitSeq;
  }

  const operations: CurrentTurnTaskOperationFact[] = [];
  for (const call of calls) {
    const toolCallId = requiredText(call.id, 'ToolCall.id');
    const artifact = artifactByCallId.get(toolCallId);
    const order = ordering.get(toolCallId);
    if (artifact === undefined || !order) continue;
    const common = {
      toolCallId,
      callSeq: integerText(call.call_seq, 'ToolCall.call_seq'),
      sourceTurnId: requiredText(call.turn_id, 'ToolCall.turn_id'),
      ...order
    };
    if (call.tool_name === TASK_LIST_TOOL_NAME) {
      const operation = taskListOperationFromSettledArtifact(artifact, toolCallId);
      if (!operation) continue;
      operations.push({ ...common, toolName: TASK_LIST_TOOL_NAME, operation });
      continue;
    }

    const argsMetadata = argumentMetadata.get(toolCallId);
    if (!argsMetadata) throw new Error(`submit_plan ToolCall ${toolCallId} references missing arguments.`);
    const operation = approvedSubmitPlanTaskOperation({
      argumentsValue: await readJson(contentStore, argsMetadata, 'submit_plan arguments'),
      resultArtifactValue: artifact,
      toolCallId
    });
    if (!operation) continue;
    operations.push({
      ...common,
      toolName: SUBMIT_PLAN_TOOL_NAME,
      operation,
      planApproved: true
    });
  }
  const projection = buildCurrentTurnTaskProjection({
    turnId,
    operations,
    frozenAtCommitSeq
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
    cardSha256: projection.cardSha256,
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
  const envelope = taskArtifactEnvelope(input.resultArtifactValue, input.toolCallId);
  if (envelope.status !== 'succeeded') return undefined;
  const output = submitPlanOutputFromResult(envelope.detail);
  if (output?.status !== 'approved' || output.executionTarget !== 'current_conversation') return undefined;
  const args = asRecord(input.argumentsValue);
  if (!args || args.taskList === undefined) return undefined;
  return requireTaskListOperation(args.taskList);
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

async function readJson(
  contentStore: ContentAddressedStore,
  metadata: ContentObjectMetadata,
  label: string
): Promise<unknown> {
  try {
    return JSON.parse((await contentStore.read(metadata)).toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`${label} content is not valid JSON: ${String(error)}`);
  }
}

function requireDomainRow(value: DomainRow | DomainRow[] | null, label: string): DomainRow {
  if (!value || Array.isArray(value)) throw new Error(`${label} is missing.`);
  return value;
}

function rows(value: DomainRow | DomainRow[] | null): DomainRow[] {
  return Array.isArray(value) ? value : [];
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
