export interface ReliableCompressionTimelineProjection {
  byAnchor: Record<string, Array<Record<string, unknown>>>;
}

export interface ReliableCompressionTimelineMessage {
  id: string;
  createdAt: number;
}

export interface ReliableCompressionRequestPurpose {
  kind: 'context_compression';
  trigger: 'auto' | 'manual';
  requestKind: 'context_compression_pre' | 'context_compression_manual';
  blockId: string;
  methodKind: string;
  sourceSegmentCount: number;
  triggerReason?: 'manual' | 'configured_threshold' | 'provider_context_overflow';
  triggerTokens?: number;
  triggerTokenSource?: 'provider-observed-delta' | 'compression-output' | 'semantic';
  configuredThresholdTokens?: number;
}

/**
 * Places a committed compression card at the durable time at which the block was published.
 * The source anchor describes the end of the replaced prefix, which can be far above the actual
 * compression event; using it as presentation chronology made completed compactions look lost.
 */
export function projectReliableCompressionTimeline(
  blocks: readonly Record<string, unknown>[],
  messages: readonly ReliableCompressionTimelineMessage[]
): ReliableCompressionTimelineProjection {
  const byAnchor: ReliableCompressionTimelineProjection['byAnchor'] = {};
  const visibleMessageIds = new Set(messages.map((message) => message.id).filter(Boolean));
  for (const block of blocks) {
    const completedAt = timestamp(block.created_at ?? block.createdAt);
    let anchor = '';
    if (completedAt > 0) {
      for (const message of messages) {
        if (message.createdAt > 0 && message.createdAt <= completedAt) anchor = message.id;
      }
      // A block older than the bounded message window remains durable history, but placing it at
      // the first visible row would invent a false in-window chronology.
      if (!anchor) continue;
    } else {
      const sourceAnchor = text(block.anchor_message_id ?? block.anchorMessageId);
      if (sourceAnchor && visibleMessageIds.has(sourceAnchor)) anchor = sourceAnchor;
    }
    if (!anchor) continue;
    (byAnchor[anchor] ??= []).push(block);
  }
  return { byAnchor };
}

/** Parses the backend-whitelisted purpose detail; prompt/tool recipe fields never enter this API. */
export function parseReliableCompressionRequestPurpose(
  value: string
): ReliableCompressionRequestPurpose | undefined {
  if (!value.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (!record || record.kind !== 'context_compression') return undefined;
  const trigger = record.trigger;
  const requestKind = record.requestKind;
  const blockId = text(record.blockId);
  const methodKind = text(record.methodKind);
  const sourceSegmentCount = integer(record.sourceSegmentCount);
  const triggerReason = compressionTriggerReason(record.triggerReason);
  const triggerTokenSource = compressionTokenSource(record.triggerTokenSource);
  if (
    (trigger !== 'auto' && trigger !== 'manual')
    || (requestKind !== 'context_compression_pre' && requestKind !== 'context_compression_manual')
    || (trigger === 'auto') !== (requestKind === 'context_compression_pre')
    || !blockId
    || !methodKind
    || sourceSegmentCount <= 0
  ) return undefined;
  return {
    kind: 'context_compression',
    trigger,
    requestKind,
    blockId,
    methodKind,
    sourceSegmentCount,
    ...(triggerReason ? { triggerReason } : {}),
    ...(triggerTokenSource ? { triggerTokenSource } : {}),
    ...optionalTokenFields(record)
  };
}

function compressionTriggerReason(
  value: unknown
): ReliableCompressionRequestPurpose['triggerReason'] {
  return value === 'manual' || value === 'configured_threshold' || value === 'provider_context_overflow'
    ? value
    : undefined;
}

function compressionTokenSource(
  value: unknown
): ReliableCompressionRequestPurpose['triggerTokenSource'] {
  return value === 'provider-observed-delta' || value === 'compression-output' || value === 'semantic'
    ? value
    : undefined;
}

function optionalTokenFields(record: Record<string, unknown>): Pick<
  ReliableCompressionRequestPurpose,
  'triggerTokens' | 'configuredThresholdTokens'
> {
  const result: Record<string, number> = {};
  for (const field of [
    'triggerTokens',
    'configuredThresholdTokens'
  ] as const) {
    const value = record[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) result[field] = value;
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function timestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function integer(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
