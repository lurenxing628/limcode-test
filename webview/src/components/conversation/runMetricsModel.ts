import type { MessageRecord, ModelResponseMetric } from '../../../../shared/protocol';
import { normalizeTokenUsage } from './tokenUsageModel';

/** One physical response of a native request, numbered from the request's first response. */
export interface ModelRunRound {
  index: number;
  ttftMs?: number;
  outputDurationMs?: number;
  outputTokens?: number;
  tokenSpeed?: number;
}

export interface ModelRunMetrics {
  /** From the request to the first model output of its first response. */
  ttftMs?: number;
  /** Only once the request has finished. */
  totalMs?: number;
  /** Time the model spent producing output; a native request excludes the tool time between responses. */
  outputDurationMs?: number;
  outputTokens?: number;
  tokenSpeed?: number;
  /** Native requests only. */
  roundCount?: number;
  averageTtftMs?: number;
  /** The newest responses, oldest first. */
  rounds?: ModelRunRound[];
}

/**
 * Footer metrics of a model message. A native request reports each physical response as it ends,
 * so its first-token time and output speed are available while it is still running; other requests
 * are measured once at the end, except the first-token time, which is known after the first output.
 */
export function modelRunMetrics(message: MessageRecord, streaming: boolean): ModelRunMetrics {
  const requestStartedAt = positiveNumber(message.requestStartedAt);
  const firstChunkAt = positiveNumber(message.firstChunkAt ?? message.createdAt);
  const completedAt = streaming ? undefined : positiveNumber(message.completedAt);
  const observedTtftMs = requestStartedAt !== undefined && firstChunkAt !== undefined && firstChunkAt >= requestStartedAt
    ? firstChunkAt - requestStartedAt
    : undefined;
  const response = message.responseMetrics;
  if (response) {
    const ttftMs = response.first.ttftMs;
    const outputDurationMs = response.speedOutputDurationMs > 0 ? response.speedOutputDurationMs : undefined;
    const firstRoundIndex = response.responseCount - response.recent.length + 1;
    return {
      ...(ttftMs === undefined ? {} : { ttftMs }),
      ...totalMetric(requestStartedAt, completedAt),
      ...(outputDurationMs === undefined ? {} : {
        outputDurationMs,
        outputTokens: response.speedOutputTokens,
        tokenSpeed: response.speedOutputTokens / (outputDurationMs / 1000)
      }),
      roundCount: response.responseCount,
      ...(response.ttftCount > 0 ? { averageTtftMs: response.ttftTotalMs / response.ttftCount } : {}),
      rounds: response.recent.map((metric, offset) => roundMetric(metric, firstRoundIndex + offset))
    };
  }
  // A finished native request without per-response metrics predates them: its request-wide first
  // output and output time span tool execution, so neither gives a first-token time or a speed.
  if (message.usageMetadata?.nativeChainBilling === true) return totalMetric(requestStartedAt, completedAt);
  if (streaming) return observedTtftMs === undefined ? {} : { ttftMs: observedTtftMs };
  const outputDurationMs = nonNegativeNumber(message.streamOutputDurationMs)
    ?? (firstChunkAt !== undefined && completedAt !== undefined && completedAt >= firstChunkAt
      ? completedAt - firstChunkAt
      : undefined);
  const outputTokens = message.usageMetadata ? normalizeTokenUsage(message.usageMetadata).output : undefined;
  const totalMs = totalMetric(requestStartedAt, completedAt).totalMs
    ?? (observedTtftMs !== undefined && outputDurationMs !== undefined ? observedTtftMs + outputDurationMs : undefined);
  return {
    ...(observedTtftMs === undefined ? {} : { ttftMs: observedTtftMs }),
    ...(totalMs === undefined ? {} : { totalMs }),
    ...(outputDurationMs === undefined ? {} : { outputDurationMs }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(outputDurationMs !== undefined && outputDurationMs > 0 && outputTokens !== undefined
      ? { tokenSpeed: outputTokens / (outputDurationMs / 1000) }
      : {})
  };
}

function roundMetric(metric: ModelResponseMetric, index: number): ModelRunRound {
  const timed = metric.outputTokens !== undefined && metric.outputDurationMs !== undefined && metric.outputDurationMs > 0;
  return {
    index,
    ...(metric.ttftMs === undefined ? {} : { ttftMs: metric.ttftMs }),
    ...(metric.outputDurationMs === undefined ? {} : { outputDurationMs: metric.outputDurationMs }),
    ...(metric.outputTokens === undefined ? {} : { outputTokens: metric.outputTokens }),
    ...(timed ? { tokenSpeed: metric.outputTokens! / (metric.outputDurationMs! / 1000) } : {})
  };
}

function totalMetric(requestStartedAt: number | undefined, completedAt: number | undefined): { totalMs?: number } {
  return requestStartedAt !== undefined && completedAt !== undefined && completedAt >= requestStartedAt
    ? { totalMs: completedAt - requestStartedAt }
    : {};
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
