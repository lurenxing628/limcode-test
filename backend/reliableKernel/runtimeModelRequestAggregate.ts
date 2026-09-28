import type Database from 'better-sqlite3';
import { compressionExecutionMetadata, readProviderRequestFailure } from '../../shared/compressionExecution';
import { parseNativeResponseMetrics } from './nativeResponseMetrics';
import { DOMAIN_REPOSITORIES } from './repositories';
import { requireRuntimeId } from './runtimeSqlRows';
import { prepareCached } from './runtimeStatementCache';

/**
 * A ModelRequest aggregate (its request, one Operation, one to eleven Attempts, the terminal fence)
 * and its stream identity, as the Runtime database worker asserts them: in every transaction that
 * touches an aggregate, and in a maintenance transaction at its commit. The large merge's online
 * dry run asserts the same on a source's private copy for every request it would insert
 * (runtimeDataSetStreamedMerge.ts), so a source the commit would refuse is refused before any
 * window waits for it. Plain functions of a connection: no worker state.
 */

const NATIVE_CAPABILITY_FIELDS: Readonly<Record<string, true>> = {
  asyncTools: true,
  steering: true,
  reasoningUpdates: true,
  multiplexing: true,
  explicitCaching: true
};

const NATIVE_RESPONSE_USAGE_FIELDS = new Set([
  'responseId', 'previousResponseId', 'streamSeq', 'attemptSeq', 'socketGeneration',
  'physicalResponseCount', 'inputTokens', 'outputTokens', 'contextRootId', 'contextCovered'
]);
const MAX_NATIVE_PHYSICAL_RESPONSE_COUNT = 8;

interface NativeResponseUsageStats {
  responseId: string;
  previousResponseId?: string;
  streamSeq: bigint;
  attemptSeq: bigint;
  socketGeneration: bigint;
  physicalResponseCount: number;
  inputTokens?: number;
  outputTokens?: number;
  contextRootId?: string;
  contextCovered?: true;
}

export function decodeModelStreamIdentity(value: unknown): {
  attemptSeq: bigint;
  socketGeneration: bigint;
  retryMaxAttempts?: number;
  retryDelayMs?: number;
  retryNotBeforeAt?: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('ModelRequest.stream_stats_json must be an object.');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const allowedKeys = new Set([
    'attemptSeq',
    'socketGeneration',
    'retryReason',
    'retryMaxAttempts',
    'retryDelayMs',
    'retryNotBeforeAt',
    'providerStartedAt',
    'firstOutputAt',
    'completedAt',
    'streamOutputDurationMs',
    'lastStreamSeq',
    'lastStreamEventAt',
    'nativeCapabilities',
    'thinkingSelection',
    'nativeInitialPromptTokenCount',
    'nativeLatestResponseUsage',
    'nativeResponseMetrics',
    'compressionPurpose',
    'compressionDecision',
    'failure',
    'claudeThinkingBinding'
  ]);
  if (
    !keys.includes('attemptSeq')
    || !keys.includes('retryReason')
    || !keys.includes('socketGeneration')
    || keys.some((key) => !allowedKeys.has(key))
    || (
      record.retryReason !== null
      && record.retryReason !== 'connection_interrupted'
      && record.retryReason !== 'rate_limited'
      && record.retryReason !== 'temporary_service_error'
      && record.retryReason !== 'first_semantic_timeout'
      && record.retryReason !== 'stream_stalled'
      && record.retryReason !== 'compression_timeout'
    )
  ) throw new TypeError('ModelRequest.stream_stats_json has an invalid shape.');
  compressionExecutionMetadata(record);
  if (record.failure !== undefined) readProviderRequestFailure(record.failure);
  assertOptionalBoundedInteger(record.retryMaxAttempts, 'retryMaxAttempts', 1, 10);
  assertOptionalBoundedInteger(record.retryDelayMs, 'retryDelayMs', 0, Number.MAX_SAFE_INTEGER);
  assertOptionalBoundedInteger(record.retryNotBeforeAt, 'retryNotBeforeAt', 1, Number.MAX_SAFE_INTEGER);
  const attemptSeq = decimalRuntimeInteger(record.attemptSeq, 'stream_stats.attemptSeq');
  const retryMaxAttempts = typeof record.retryMaxAttempts === 'number'
    ? record.retryMaxAttempts
    : attemptSeq === 2n ? 1 : undefined;
  const retryDelayMs = typeof record.retryDelayMs === 'number' ? record.retryDelayMs : undefined;
  const retryNotBeforeAt = typeof record.retryNotBeforeAt === 'number' ? record.retryNotBeforeAt : undefined;
  assertOptionalStreamTiming(record.providerStartedAt, 'providerStartedAt');
  assertOptionalStreamTiming(record.firstOutputAt, 'firstOutputAt');
  assertOptionalStreamTiming(record.completedAt, 'completedAt');
  assertOptionalStreamTiming(record.streamOutputDurationMs, 'streamOutputDurationMs', true);
  optionalDecimalInteger(record.lastStreamSeq, 'lastStreamSeq');
  optionalPositiveInteger(record.lastStreamEventAt, 'lastStreamEventAt');
  if (record.thinkingSelection !== undefined && (typeof record.thinkingSelection !== 'string' || record.thinkingSelection.length > 1024)) {
    throw new TypeError('ModelRequest.stream_stats_json.thinkingSelection must be a bounded string.');
  }
  if (record.claudeThinkingBinding !== undefined
    && record.claudeThinkingBinding !== 'drop_block' && record.claudeThinkingBinding !== 'strip_thinking') {
    throw new TypeError('ModelRequest.stream_stats_json.claudeThinkingBinding is invalid.');
  }
  optionalNonNegativeInteger(record.nativeInitialPromptTokenCount, 'nativeInitialPromptTokenCount');
  if (record.nativeCapabilities !== undefined) {
    const capabilities = record.nativeCapabilities;
    if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
      throw new TypeError('ModelRequest.stream_stats_json.nativeCapabilities must be an object.');
    }
    const native = capabilities as Record<string, unknown>;
    for (const key of Object.keys(native)) {
      if (NATIVE_CAPABILITY_FIELDS[key] !== true) {
        throw new TypeError(`Unknown ModelRequest native capability ${key}.`);
      }
    }
    for (const key in NATIVE_CAPABILITY_FIELDS) {
      if (typeof native[key] !== 'boolean') {
        throw new TypeError(`ModelRequest native capability ${key} must be boolean.`);
      }
    }
  }
  const socketGeneration = decimalRuntimeInteger(record.socketGeneration, 'stream_stats.socketGeneration');
  if (record.nativeLatestResponseUsage !== undefined) {
    decodeNativeResponseUsage(record.nativeLatestResponseUsage, attemptSeq, socketGeneration);
  }
  if (record.nativeResponseMetrics !== undefined) parseNativeResponseMetrics(record.nativeResponseMetrics);
  return {
    attemptSeq,
    socketGeneration,
    ...(retryMaxAttempts !== undefined ? { retryMaxAttempts } : {}),
    ...(retryDelayMs !== undefined ? { retryDelayMs } : {}),
    ...(retryNotBeforeAt !== undefined ? { retryNotBeforeAt } : {})
  };
}

function decodeNativeResponseUsage(
  value: unknown,
  outerAttemptSeq: bigint,
  outerSocketGeneration: bigint
): NativeResponseUsageStats {
  const label = 'ModelRequest.stream_stats_json.nativeLatestResponseUsage';
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !NATIVE_RESPONSE_USAGE_FIELDS.has(key))) {
    throw new TypeError(`${label} has an unknown field.`);
  }
  const responseId = requireRuntimeId(record.responseId);
  const previousResponseId = record.previousResponseId === undefined
    ? undefined : requireRuntimeId(record.previousResponseId);
  const contextRootId = record.contextRootId === undefined
    ? undefined : requireRuntimeId(record.contextRootId);
  if (record.contextCovered !== undefined && record.contextCovered !== true) {
    throw new TypeError(`${label}.contextCovered must be true when declared.`);
  }
  if (record.contextCovered === true && !contextRootId) {
    throw new TypeError(`${label}.contextCovered needs an explicit contextRootId.`);
  }
  const attemptSeq = decimalRuntimeInteger(record.attemptSeq, `${label}.attemptSeq`);
  const socketGeneration = decimalRuntimeInteger(record.socketGeneration, `${label}.socketGeneration`);
  const streamSeq = decimalRuntimeInteger(record.streamSeq, `${label}.streamSeq`);
  if (attemptSeq > outerAttemptSeq || (attemptSeq === outerAttemptSeq && socketGeneration > outerSocketGeneration)) {
    throw new TypeError(`${label} cannot claim a future stream identity.`);
  }
  assertOptionalBoundedInteger(record.physicalResponseCount, `${label}.physicalResponseCount`, 1, MAX_NATIVE_PHYSICAL_RESPONSE_COUNT);
  if (record.physicalResponseCount === undefined) throw new TypeError(`${label}.physicalResponseCount is required.`);
  assertOptionalBoundedInteger(record.inputTokens, `${label}.inputTokens`, 0, Number.MAX_SAFE_INTEGER);
  assertOptionalBoundedInteger(record.outputTokens, `${label}.outputTokens`, 0, Number.MAX_SAFE_INTEGER);
  return {
    responseId,
    previousResponseId,
    contextRootId,
    ...(record.contextCovered === true ? { contextCovered: true } : {}),
    attemptSeq,
    socketGeneration,
    streamSeq,
    physicalResponseCount: record.physicalResponseCount as number,
    ...(record.inputTokens === undefined ? {} : { inputTokens: record.inputTokens as number }),
    ...(record.outputTokens === undefined ? {} : { outputTokens: record.outputTokens as number })
  };
}

export function assertNativeResponseUsageTransition(
  currentValue: unknown,
  nextValue: unknown,
  currentIdentity: { attemptSeq: bigint; socketGeneration: bigint },
  nextIdentity: { attemptSeq: bigint; socketGeneration: bigint }
): void {
  const current = currentValue as Record<string, unknown>;
  const next = nextValue as Record<string, unknown>;
  const previous = current.nativeLatestResponseUsage === undefined ? undefined
    : decodeNativeResponseUsage(current.nativeLatestResponseUsage, currentIdentity.attemptSeq, currentIdentity.socketGeneration);
  const latest = next.nativeLatestResponseUsage === undefined ? undefined
    : decodeNativeResponseUsage(next.nativeLatestResponseUsage, nextIdentity.attemptSeq, nextIdentity.socketGeneration);
  if (!previous) {
    if (latest && (latest.attemptSeq !== nextIdentity.attemptSeq
      || latest.socketGeneration !== nextIdentity.socketGeneration)) {
      throw new Error('A new native response usage observation must belong to the active stream identity.');
    }
    return;
  }
  if (!latest) {
    // A retry starts a new attempt and may discard the old physical observation. Within one
    // attempt, heartbeat/terminal metadata must not silently erase a committed response.
    if (nextIdentity.attemptSeq === currentIdentity.attemptSeq) {
      throw new Error('ModelRequest native response usage cannot disappear within one attempt.');
    }
    return;
  }
  if (latest.responseId === previous.responseId) {
    // Replayed physical responses cannot upgrade unknown usage or invent Context coverage.
    if (latest.previousResponseId !== previous.previousResponseId
      || latest.streamSeq !== previous.streamSeq
      || latest.attemptSeq !== previous.attemptSeq
      || latest.socketGeneration !== previous.socketGeneration
      || latest.physicalResponseCount !== previous.physicalResponseCount
      || latest.inputTokens !== previous.inputTokens
      || latest.outputTokens !== previous.outputTokens
      || latest.contextRootId !== previous.contextRootId
      || latest.contextCovered !== previous.contextCovered) {
      throw new Error('Duplicate native physical response usage conflicts with committed facts.');
    }
    return;
  }
  if (latest.attemptSeq < previous.attemptSeq
    || (latest.attemptSeq === previous.attemptSeq && latest.socketGeneration < previous.socketGeneration)
    || latest.attemptSeq !== nextIdentity.attemptSeq
    || latest.socketGeneration !== nextIdentity.socketGeneration) {
    throw new Error('Native physical response usage cannot write from an old stream identity.');
  }
  const sameStreamIdentity = latest.attemptSeq === previous.attemptSeq
    && latest.socketGeneration === previous.socketGeneration;
  if (sameStreamIdentity && latest.streamSeq <= previous.streamSeq) {
    throw new Error('Native physical response stream sequence must advance within one socket generation.');
  }
  // A new socket can restart streamSeq, so sequence alone cannot distinguish a fresh physical
  // response from replaying an earlier responseId. The committed latest ID is the only bounded
  // continuation anchor: a new ID across stream identities must name it exactly. A retry that
  // explicitly cleared nativeLatestResponseUsage is handled by the no-previous branch above.
  // Within one socket stateless HTTP responses need not carry previousResponseId.
  if (!sameStreamIdentity && latest.previousResponseId !== previous.responseId) {
    throw new Error('Native physical response continuation lacks the committed latest predecessor.');
  }
  const brokenPredecessor = latest.attemptSeq === previous.attemptSeq
    && latest.previousResponseId !== undefined && latest.previousResponseId !== previous.responseId;
  const expectedCount = brokenPredecessor ? MAX_NATIVE_PHYSICAL_RESPONSE_COUNT
    : Math.min(MAX_NATIVE_PHYSICAL_RESPONSE_COUNT, previous.physicalResponseCount + 1);
  if (latest.physicalResponseCount !== expectedCount || (brokenPredecessor && latest.contextCovered === true)) {
    throw new Error('Native physical response count or Context coverage conflicts with its predecessor.');
  }
}

export function optionalDecimalInteger(value: unknown, label: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`ModelRequest.stream_stats_json.${label} must be a decimal integer string.`);
  }
  return BigInt(value);
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  if (Number.isSafeInteger(value) && (value as number) >= 0) return value as number;
  throw new TypeError(`ModelRequest.stream_stats_json.${label} must be a non-negative safe integer.`);
}

export function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  const parsed = optionalNonNegativeInteger(value, label);
  if (parsed === undefined) return undefined;
  if (parsed <= 0) throw new TypeError(`ModelRequest.stream_stats_json.${label} must be positive.`);
  return parsed;
}

function assertOptionalBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`ModelRequest.stream_stats_json.${label} must be an integer in [${minimum}, ${maximum}].`);
  }
}

function assertOptionalStreamTiming(value: unknown, label: string, allowZero = false): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (allowZero ? (value as number) < 0 : (value as number) <= 0)) {
    throw new TypeError(`ModelRequest.stream_stats_json.${label} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer.`);
  }
}

function decimalRuntimeInteger(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string.`);
  }
  return BigInt(value);
}

export function assertModelRequestAggregate(database: Database.Database, modelRequestId: string): void {
  const requestRaw = prepareCached(database, 'SELECT * FROM model_request WHERE id = ?').get(modelRequestId);
  if (!requestRaw) throw new Error(`ModelRequest ${modelRequestId} does not exist.`);
  const request = DOMAIN_REPOSITORIES.codec('ModelRequest').decode(requestRaw as Record<string, unknown>);
  const identity = decodeModelStreamIdentity(request.stream_stats_json);
  const operations = prepareCached(database,
    "SELECT id, status FROM operation WHERE owner_kind = 'model_request' AND owner_id = ?"
  ).all(modelRequestId) as Array<{ id: string; status: string }>;
  if (operations.length !== 1) throw new Error(`ModelRequest ${modelRequestId} must own exactly one Operation.`);
  const operation = operations[0];
  const attempts = prepareCached(database,
    'SELECT id, attempt_seq, status, completed_at FROM attempt WHERE operation_id = ? ORDER BY attempt_seq'
  ).all(operation.id) as Array<{ id: string; attempt_seq: bigint; status: string; completed_at: string | null }>;
  if (attempts.length < 1 || attempts.length > 11) {
    throw new Error(`ModelRequest ${modelRequestId} must have between one and eleven Attempts.`);
  }
  attempts.forEach((attempt, index) => {
    if (attempt.attempt_seq !== BigInt(index + 1)) {
      throw new Error(`ModelRequest ${modelRequestId} Attempt sequence is not contiguous.`);
    }
  });
  const currentAttempt = attempts.find((attempt) => attempt.attempt_seq === identity.attemptSeq);
  if (!currentAttempt) throw new Error(`ModelRequest ${modelRequestId} stream identity has no matching Attempt.`);
  if (identity.attemptSeq !== BigInt(attempts.length)) {
    throw new Error(`ModelRequest ${modelRequestId} current Attempt must be the contiguous tail.`);
  }
  const priorAttempts = attempts.slice(0, -1);
  if (priorAttempts.some((attempt) => attempt.status !== 'transient_failed' || attempt.completed_at === null)) {
    throw new Error(`ModelRequest ${modelRequestId} prior Attempts must be durably transient_failed.`);
  }
  const fence = prepareCached(database, 'SELECT * FROM model_stream_fence WHERE model_request_id = ?').get(modelRequestId) as {
    attempt_seq?: unknown;
    socket_generation?: unknown;
    outcome?: unknown;
  } | undefined;
  const status = String(request.status);
  const terminalState = request.terminal_state;
  if (status !== 'terminal' && terminalState !== null) {
    throw new Error(`Non-terminal ModelRequest ${modelRequestId} cannot carry terminal_state.`);
  }
  if (identity.attemptSeq > 1n && (
    identity.retryMaxAttempts === undefined
    || identity.attemptSeq - 1n > BigInt(identity.retryMaxAttempts)
  )) {
    throw new Error(`ModelRequest ${modelRequestId} current Attempt exceeds its frozen retry budget.`);
  }
  if (status === 'prepared') {
    if (
      identity.attemptSeq !== 1n
      || identity.socketGeneration !== 0n
      || operation.status !== 'pending'
      || currentAttempt.status !== 'pending'
      || fence
    ) throw new Error(`Prepared ModelRequest ${modelRequestId} aggregate is inconsistent.`);
    return;
  }
  if (status === 'streaming') {
    if (
      identity.socketGeneration <= 0n
      || operation.status !== 'running'
      || currentAttempt.status !== 'running'
      || fence
    ) throw new Error(`Streaming ModelRequest ${modelRequestId} aggregate is inconsistent.`);
    return;
  }
  if (status === 'retrying') {
    if (
      identity.attemptSeq < 2n
      || identity.attemptSeq > 11n
      || identity.socketGeneration !== 0n
      || identity.retryDelayMs === undefined
      || identity.retryNotBeforeAt === undefined
      || operation.status !== 'running'
      || currentAttempt.status !== 'pending'
      || priorAttempts.length !== Number(identity.attemptSeq - 1n)
      || fence
    ) throw new Error(`Retrying ModelRequest ${modelRequestId} aggregate is inconsistent.`);
    return;
  }
  if (status !== 'terminal' || typeof terminalState !== 'string' || terminalState.length === 0) {
    throw new Error(`ModelRequest ${modelRequestId} has an unsupported aggregate status.`);
  }
  if (terminalState === 'completed') {
    if (
      operation.status !== 'completed'
      || currentAttempt.status !== 'completed'
      || fence?.attempt_seq !== identity.attemptSeq
      || fence.socket_generation !== identity.socketGeneration
      || fence.outcome !== 'completed'
    ) throw new Error(`Completed ModelRequest ${modelRequestId} aggregate is inconsistent.`);
    return;
  }
  if (fence) throw new Error(`Non-completed ModelRequest ${modelRequestId} cannot have a terminal fence.`);
  if (
    !['cancelled', 'failed'].includes(currentAttempt.status)
    || operation.status !== currentAttempt.status
  ) throw new Error(`Terminal ModelRequest ${modelRequestId} aggregate is inconsistent.`);
}
