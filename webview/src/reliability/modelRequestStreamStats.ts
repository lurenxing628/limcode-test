import type { OpenAIResponsesNativeCapabilities } from '@shared/openAIResponsesNative';
import type { ModelResponseMetric, ModelResponseMetrics } from '@shared/protocol';

/** ModelRequest.stream_stats_json 在 feed 里可能是对象或 JSON 字符串；两种形态都接受。 */
export function modelRequestStreamStats(request: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = request.stream_stats_json;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 进行中原生请求的冻结能力投影，由后端在原生 response.created 后写入 stream_stats。
 * 缺失或形状不符时返回 undefined——调用方必须把它当作「能力不可用」，不得回退到可编辑设置。
 */
export function modelRequestNativeCapabilities(
  request: Record<string, unknown> | undefined
): OpenAIResponsesNativeCapabilities | undefined {
  if (!request) return undefined;
  const raw = modelRequestStreamStats(request)?.nativeCapabilities;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  return {
    asyncTools: record.asyncTools === true,
    steering: record.steering === true,
    reasoningUpdates: record.reasoningUpdates === true,
    multiplexing: record.multiplexing === true,
    explicitCaching: record.explicitCaching === true
  };
}

/**
 * 原生请求每个物理 response 的首字与输出用时，由后端在每个 response 结束时写入 stream_stats。
 * 写入时已由数据库严格校验；这里形状不符就当作没有，不做修补。
 */
export function modelRequestResponseMetrics(
  streamStats: Record<string, unknown> | undefined
): ModelResponseMetrics | undefined {
  const raw = streamStats?.nativeResponseMetrics;
  if (!isRecord(raw) || !Array.isArray(raw.recent) || raw.recent.length === 0) return undefined;
  const first = responseMetric(raw.first);
  const recent = raw.recent.map(responseMetric);
  const totals = [raw.responseCount, raw.ttftTotalMs, raw.ttftCount, raw.speedOutputTokens, raw.speedOutputDurationMs];
  if (!first || recent.some((entry) => !entry) || totals.some((entry) => !isCount(entry))) return undefined;
  return {
    responseCount: raw.responseCount as number,
    first,
    recent: recent as ModelResponseMetric[],
    ttftTotalMs: raw.ttftTotalMs as number,
    ttftCount: raw.ttftCount as number,
    speedOutputTokens: raw.speedOutputTokens as number,
    speedOutputDurationMs: raw.speedOutputDurationMs as number
  };
}

function responseMetric(value: unknown): ModelResponseMetric | undefined {
  if (!isRecord(value) || typeof value.responseId !== 'string' || !value.responseId
    || !isCount(value.startedAt) || !isCount(value.completedAt)) return undefined;
  const metric: ModelResponseMetric = {
    responseId: value.responseId,
    startedAt: value.startedAt,
    completedAt: value.completedAt
  };
  for (const key of ['firstOutputAt', 'ttftMs', 'outputDurationMs', 'outputTokens', 'reasoningTokens'] as const) {
    const field = value[key];
    if (field === undefined) continue;
    if (!isCount(field)) return undefined;
    metric[key] = field;
  }
  return metric;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
