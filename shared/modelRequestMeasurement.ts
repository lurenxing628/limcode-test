import type { LlmUsageMetadataRecord, ModelResponseTiming } from './protocol';

/** Read-only projection of a verified ordinary physical response. Never persisted into usage_json. */
export interface SingleResponseMeasurement {
  recipeObjectId: string;
  responseId: string;
  attemptSeq: string;
  socketGeneration: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  timing: ModelResponseTiming;
}

export function measurementRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try { return measurementRecord(JSON.parse(value)); } catch { return undefined; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Only the backend supplies this evidence. Bind it to the exact row and its committed usage. */
export function singleResponseMeasurement(request: Record<string, unknown>): SingleResponseMeasurement | undefined {
  const measurement = measurementRecord(request.single_response_measurement);
  const usage = measurementRecord(request.usage_json);
  const stats = measurementRecord(request.stream_stats_json);
  if (!measurement || !usage || !stats || request.status !== 'terminal' || request.terminal_state !== 'completed'
    || usage.nativeChainBilling !== true || usage.nativeChainUsageIncomplete === true
    || usage.nativeChainUsageDetailsIncomplete === true || usage.estimated === true || usage.tokenEstimator !== undefined
    || typeof measurement.recipeObjectId !== 'string' || !measurement.recipeObjectId
    || typeof measurement.attemptSeq !== 'string' || !/^[1-9]\d*$/.test(measurement.attemptSeq)
    || typeof measurement.socketGeneration !== 'string' || !/^[1-9]\d*$/.test(measurement.socketGeneration)
    || measurement.recipeObjectId !== request.recipe_object_id
    || measurement.attemptSeq !== stats.attemptSeq || measurement.socketGeneration !== stats.socketGeneration
    || typeof measurement.responseId !== 'string' || !measurement.responseId
    || !count(measurement.inputTokens) || !count(measurement.outputTokens) || !count(measurement.totalTokens)
    || measurement.inputTokens !== usage.promptTokenCount || measurement.outputTokens !== usage.candidatesTokenCount
    || measurement.totalTokens !== usage.totalTokenCount
    || measurement.inputTokens + measurement.outputTokens !== measurement.totalTokens
    || stats.nativeCapabilities !== undefined || stats.nativeLatestResponseUsage !== undefined
    || stats.nativeInitialPromptTokenCount !== undefined || stats.nativeResponseMetrics !== undefined) return undefined;
  const timing = measurementRecord(measurement.timing);
  if (!timing || !count(timing.startedAt) || timing.startedAt <= 0 || !count(timing.completedAt)
    || !count(timing.firstOutputAt) || !count(timing.ttftMs) || !count(timing.outputDurationMs)
    || timing.completedAt < timing.firstOutputAt || timing.firstOutputAt < timing.startedAt) return undefined;
  return {
    recipeObjectId: measurement.recipeObjectId, responseId: measurement.responseId,
    attemptSeq: measurement.attemptSeq, socketGeneration: measurement.socketGeneration,
    inputTokens: measurement.inputTokens, outputTokens: measurement.outputTokens, totalTokens: measurement.totalTokens,
    timing: { startedAt: timing.startedAt, completedAt: timing.completedAt, firstOutputAt: timing.firstOutputAt,
      ttftMs: timing.ttftMs, outputDurationMs: timing.outputDurationMs }
  };
}

export function modelRequestObservedUsage(request: Record<string, unknown> | undefined): LlmUsageMetadataRecord | undefined {
  if (!request) return undefined;
  const usage = measurementRecord(request.usage_json) as LlmUsageMetadataRecord | undefined;
  // Preserve raw billing facts on the row. Only this shared consumer interpretation changes.
  return usage && singleResponseMeasurement(request) ? { ...usage, nativeChainBilling: false } : usage;
}

export function modelRequestObservedTiming(request: Record<string, unknown>): Record<string, unknown> | undefined {
  const stats = measurementRecord(request.stream_stats_json);
  const measurement = singleResponseMeasurement(request);
  return measurement ? { ...stats, providerStartedAt: measurement.timing.startedAt,
    firstOutputAt: measurement.timing.firstOutputAt, streamOutputDurationMs: measurement.timing.outputDurationMs } : stats;
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
