import { DEFAULT_LLM_COMPRESSION_OUTPUT_RESERVE_TOKENS, type LlmUsageMetadataRecord } from '@shared/protocol';
import { nativePhysicalContextUsage, normalizeTokenUsage } from './tokenUsageModel';

export interface ContextInputObservation {
  tokens?: number;
  /** A recent measurement is useful, but is not proof of the current root's occupancy. */
  quality: 'current' | 'recent' | 'unknown';
  native: boolean;
  responseId?: string;
}

/** The composer shows provider observations, never a root estimate or a native chain's bill. */
export function observeContextInput(input: {
  native: boolean;
  usage?: LlmUsageMetadataRecord;
  streamStats?: unknown;
  requestRootId?: string;
  currentRootId?: string;
}): ContextInputObservation {
  const native = input.native || input.usage?.nativeChainBilling === true;
  if (native) {
    const physical = nativePhysicalContextUsage(input.streamStats, input.currentRootId);
    return {
      native,
      ...(physical ? { responseId: physical.responseId } : {}),
      ...(physical?.inputTokens === undefined ? {} : { tokens: physical.inputTokens }),
      // A later native response may cover a newer root than the logical request's initial one.
      quality: physical?.inputTokens === undefined ? 'unknown' : physical.exact ? 'current' : 'recent'
    };
  }
  const usage = input.usage ? normalizeTokenUsage(input.usage) : undefined;
  const tokens = usage?.sourceEstimated ? undefined : usage?.input;
  return {
    native,
    ...(tokens === undefined ? {} : { tokens }),
    quality: tokens === undefined ? 'unknown'
      : input.currentRootId && input.currentRootId === input.requestRootId ? 'current' : 'recent'
  };
}

export interface CompressionEstimateHint {
  tokens: number;
  atThreshold: boolean;
}

/**
 * Display-only warning, not a compression/admission decision. Reuse the existing 16k output reserve,
 * capped at 10% of the configured trigger so a small threshold does not make estimates permanent.
 * A proven current measurement needs no estimated substitute. Only a current-root estimate may
 * be supplied; an old request/compaction estimate cannot establish this warning.
 */
export function compressionEstimateHint(input: {
  automatic: boolean;
  observation: ContextInputObservation;
  estimatedTokens?: number;
  thresholdTokens?: number;
}): CompressionEstimateHint | undefined {
  const { estimatedTokens, thresholdTokens } = input;
  if (!input.automatic || input.observation.quality === 'current'
    || !isTokenCount(estimatedTokens) || !isTokenCount(thresholdTokens) || thresholdTokens === 0) return undefined;
  const margin = Math.min(DEFAULT_LLM_COMPRESSION_OUTPUT_RESERVE_TOKENS, Math.ceil(thresholdTokens / 10));
  if (estimatedTokens < thresholdTokens - margin) return undefined;
  return { tokens: estimatedTokens, atThreshold: estimatedTokens >= thresholdTokens };
}

function isTokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
