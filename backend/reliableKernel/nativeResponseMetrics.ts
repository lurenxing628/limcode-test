/**
 * Generation metrics of each physical response of a native Responses chain, kept in
 * ModelRequest.stream_stats_json. One native ModelRequest spans many responses with tool execution
 * in between, so request-wide timing gives neither a first-token time per round nor an output speed
 * that excludes the time spent running tools.
 */

import type { ModelResponseMetric, ModelResponseMetrics, ModelResponseTiming } from '../../shared/protocol';

/** Newest responses kept for the per-round breakdown; the totals below cover every response. */
export const MAX_RECENT_NATIVE_RESPONSE_METRICS = 8;

const MAX_RESPONSE_ID_LENGTH = 512;

const TIMING_FIELDS = new Set(['startedAt', 'completedAt', 'firstOutputAt', 'ttftMs', 'outputDurationMs']);
const METRIC_FIELDS = new Set([...TIMING_FIELDS, 'responseId', 'outputTokens', 'reasoningTokens']);
const METRICS_FIELDS = new Set([
  'responseCount', 'first', 'recent', 'ttftTotalMs', 'ttftCount', 'speedOutputTokens', 'speedOutputDurationMs'
]);

/** Validates timing attached to a native response-end event; first output fields come together. */
export function parseNativeResponseTiming(value: unknown, label = 'Native response timing'): ModelResponseTiming {
  const record = requireRecord(value, label, TIMING_FIELDS);
  const firstOutputAt = optionalInteger(record.firstOutputAt, `${label}.firstOutputAt`, 1);
  const ttftMs = optionalInteger(record.ttftMs, `${label}.ttftMs`, 0);
  const outputDurationMs = optionalInteger(record.outputDurationMs, `${label}.outputDurationMs`, 0);
  const firstOutputFields = [firstOutputAt, ttftMs, outputDurationMs].filter((field) => field !== undefined).length;
  if (firstOutputFields !== 0 && firstOutputFields !== 3) {
    throw new TypeError(`${label} must give firstOutputAt, ttftMs and outputDurationMs together.`);
  }
  return {
    startedAt: requireInteger(record.startedAt, `${label}.startedAt`, 1),
    completedAt: requireInteger(record.completedAt, `${label}.completedAt`, 1),
    ...(firstOutputAt === undefined ? {} : { firstOutputAt, ttftMs: ttftMs!, outputDurationMs: outputDurationMs! })
  };
}

/** Adds one newly observed response; the caller guarantees a replayed response is not folded twice. */
export function foldNativeResponseMetrics(
  previous: ModelResponseMetrics | undefined,
  responseId: string,
  timing: ModelResponseTiming,
  usage: Record<string, unknown> | undefined
): ModelResponseMetrics {
  const outputTokens = optionalTokenCount(usage?.output_tokens);
  const details = usage?.output_tokens_details;
  const reasoningTokens = optionalTokenCount(isRecord(details) ? details.reasoning_tokens : undefined);
  const metric: ModelResponseMetric = {
    responseId: requireResponseId(responseId, 'Native response metric responseId'),
    ...parseNativeResponseTiming(timing),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens })
  };
  const timed = metric.outputTokens !== undefined && metric.outputDurationMs !== undefined && metric.outputDurationMs > 0;
  return {
    responseCount: (previous?.responseCount ?? 0) + 1,
    first: previous?.first ?? metric,
    recent: [...(previous?.recent ?? []), metric].slice(-MAX_RECENT_NATIVE_RESPONSE_METRICS),
    ttftTotalMs: (previous?.ttftTotalMs ?? 0) + (metric.ttftMs ?? 0),
    ttftCount: (previous?.ttftCount ?? 0) + (metric.ttftMs === undefined ? 0 : 1),
    speedOutputTokens: (previous?.speedOutputTokens ?? 0) + (timed ? metric.outputTokens! : 0),
    speedOutputDurationMs: (previous?.speedOutputDurationMs ?? 0) + (timed ? metric.outputDurationMs! : 0)
  };
}

export function parseNativeResponseMetrics(
  value: unknown,
  label = 'ModelRequest.stream_stats_json.nativeResponseMetrics'
): ModelResponseMetrics {
  const record = requireRecord(value, label, METRICS_FIELDS);
  const responseCount = requireInteger(record.responseCount, `${label}.responseCount`, 1);
  if (!Array.isArray(record.recent) || record.recent.length === 0
    || record.recent.length > Math.min(MAX_RECENT_NATIVE_RESPONSE_METRICS, responseCount)) {
    throw new TypeError(`${label}.recent must hold 1 to ${MAX_RECENT_NATIVE_RESPONSE_METRICS} responses, at most responseCount.`);
  }
  const ttftCount = requireInteger(record.ttftCount, `${label}.ttftCount`, 0);
  if (ttftCount > responseCount) throw new TypeError(`${label}.ttftCount cannot exceed responseCount.`);
  return {
    responseCount,
    first: parseMetric(record.first, `${label}.first`),
    recent: record.recent.map((entry, index) => parseMetric(entry, `${label}.recent[${index}]`)),
    ttftTotalMs: requireInteger(record.ttftTotalMs, `${label}.ttftTotalMs`, 0),
    ttftCount,
    speedOutputTokens: requireInteger(record.speedOutputTokens, `${label}.speedOutputTokens`, 0),
    speedOutputDurationMs: requireInteger(record.speedOutputDurationMs, `${label}.speedOutputDurationMs`, 0)
  };
}

function parseMetric(value: unknown, label: string): ModelResponseMetric {
  const record = requireRecord(value, label, METRIC_FIELDS);
  const { responseId: _responseId, outputTokens: _outputTokens, reasoningTokens: _reasoningTokens, ...timing } = record;
  const outputTokens = optionalInteger(record.outputTokens, `${label}.outputTokens`, 0);
  const reasoningTokens = optionalInteger(record.reasoningTokens, `${label}.reasoningTokens`, 0);
  return {
    responseId: requireResponseId(record.responseId, `${label}.responseId`),
    ...parseNativeResponseTiming(timing, label),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens })
  };
}

function requireRecord(value: unknown, label: string, fields: ReadonlySet<string>): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object.`);
  const unknown = Object.keys(value).find((key) => !fields.has(key));
  if (unknown !== undefined) throw new TypeError(`${label} has an unknown field ${unknown}.`);
  return value;
}

function requireResponseId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_RESPONSE_ID_LENGTH) {
    throw new TypeError(`${label} must be a non-empty string of at most ${MAX_RESPONSE_ID_LENGTH} characters.`);
  }
  return value;
}

function requireInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer of at least ${minimum}.`);
  }
  return value;
}

function optionalInteger(value: unknown, label: string, minimum: number): number | undefined {
  return value === undefined ? undefined : requireInteger(value, label, minimum);
}

function optionalTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
