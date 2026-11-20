import type { LlmUsageMetadataRecord } from '@shared/protocol';
import { normalizeTokenUsage } from './tokenUsageModel';

/** 底栏固定统计最近这么多次请求：缓存寿命只有几分钟到一小时，更早的请求说明不了现在是否正常。 */
export const CACHE_HIT_RECENT_REQUEST_LIMIT = 100;

export interface CacheHitSample {
  providerId: string;
  turnId: string;
  createdAt?: number;
  input: number;
  /** 渠道没有返回缓存字段时为 undefined。 */
  cached?: number;
}

export interface CacheHitSummary {
  requests: number;
  /** 所在渠道从未报告过缓存字段、因此没有计入命中率的请求数。 */
  unreported: number;
  inputTokens: number;
  cachedTokens: number;
  ratio?: number;
  firstAt?: number;
  lastAt?: number;
}

/**
 * 单次请求的缓存命中率。接入库已把三家统一成"总输入（含缓存）+ 缓存命中"
 * （Claude 的 promptTokenCount = input + cache_creation + cache_read），直接相除即可。
 */
export function cacheHitRatio(usage: LlmUsageMetadataRecord): number | undefined {
  const { input, cached } = normalizeTokenUsage(usage);
  if (cached === undefined || input === undefined || input <= 0) return undefined;
  return Math.min(1, Math.max(0, cached / input));
}

export function cacheHitSample(
  usage: LlmUsageMetadataRecord | undefined,
  identity: { providerId: string; turnId: string; createdAt?: number }
): CacheHitSample | undefined {
  if (!usage) return undefined;
  const { input, cached, sourceEstimated } = normalizeTokenUsage(usage);
  if (sourceEstimated || input === undefined || input <= 0) return undefined;
  return { ...identity, input, ...(cached !== undefined ? { cached: Math.min(cached, input) } : {}) };
}

/**
 * 按 token 加权汇总。Gemini 与 OpenAI 兼容渠道命中为 0 时干脆不返回缓存字段，"没报"与"0"分不清：
 * 同一渠道只要有一次报过缓存数，其余没报的按 0 计；一次都没报过的渠道不计入，单独记为未报告。
 */
export function summarizeCacheHits(
  samples: readonly CacheHitSample[],
  reporting: ReadonlySet<string> = reportingProviders(samples)
): CacheHitSummary {
  let inputTokens = 0;
  let cachedTokens = 0;
  let unreported = 0;
  let firstAt: number | undefined;
  let lastAt: number | undefined;
  for (const sample of samples) {
    if (sample.createdAt !== undefined) {
      firstAt = firstAt === undefined ? sample.createdAt : Math.min(firstAt, sample.createdAt);
      lastAt = lastAt === undefined ? sample.createdAt : Math.max(lastAt, sample.createdAt);
    }
    if (!reporting.has(sample.providerId)) {
      unreported += 1;
      continue;
    }
    inputTokens += sample.input;
    cachedTokens += sample.cached ?? 0;
  }
  return {
    requests: samples.length,
    unreported,
    inputTokens,
    cachedTokens,
    ...(inputTokens > 0 ? { ratio: cachedTokens / inputTokens } : {}),
    ...(firstAt !== undefined ? { firstAt } : {}),
    ...(lastAt !== undefined ? { lastAt } : {})
  };
}

function reportingProviders(samples: readonly CacheHitSample[]): Set<string> {
  return new Set(samples.filter((sample) => sample.cached !== undefined).map((sample) => sample.providerId));
}

/** 样本按时间从新到旧排列：取最近 N 次与最近一轮（最新样本所在的那一轮）。 */
export function recentCacheHitSummaries(newestFirst: readonly CacheHitSample[]): {
  recent: CacheHitSummary;
  latestTurn?: CacheHitSummary;
} {
  // 一轮里的请求可能恰好都没命中、都没带缓存字段；渠道是否报告按已加载的全部请求判断。
  const reporting = reportingProviders(newestFirst);
  const latestTurnId = newestFirst[0]?.turnId;
  return {
    recent: summarizeCacheHits(newestFirst.slice(0, CACHE_HIT_RECENT_REQUEST_LIMIT), reporting),
    ...(latestTurnId
      ? { latestTurn: summarizeCacheHits(newestFirst.filter((sample) => sample.turnId === latestTurnId), reporting) }
      : {})
  };
}

export function formatCacheHitPercent(ratio: number): string {
  if (ratio > 0 && ratio < 0.01) return '<1%';
  if (ratio < 1 && ratio > 0.99) return '99%';
  return `${Math.round(ratio * 100)}%`;
}
