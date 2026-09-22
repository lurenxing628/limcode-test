export const TURN_INTENT_ENVELOPE_CONTENT_TYPE = 'application/vnd.limcode.turn-intent+json';

export type GuidanceIntentHold = 'none' | 'paused';

export interface GuidanceIntentMetadata {
  position: string;
  hold: GuidanceIntentHold;
}

export interface InputTurnIntentEnvelope {
  version: 1;
  kind: 'input';
  messageContentObjectId: string;
  guidance: GuidanceIntentMetadata;
}

export interface RuntimeContinuationTurnIntentEnvelope {
  version: 1;
  kind: 'runtime_continuation';
  /**
   * Same-Conversation Turn whose frozen authority the continuation inherits. Null only for a
   * collaboration delivery: that continuation compiles the destination's current settings and
   * may start the Conversation's very first Turn.
   */
  sourceTurnId: string | null;
}

export type TurnIntentEnvelope = InputTurnIntentEnvelope | RuntimeContinuationTurnIntentEnvelope;

/**
 * Queue controls are persisted by appending a TurnIntentRevision whose CAS payload is this
 * envelope. The user message itself remains a separate immutable ContentObject, so editing text
 * never mutates or drops attachment bytes already admitted into CAS.
 */
export function inputTurnIntentEnvelope(input: {
  messageContentObjectId: string;
  position: string;
  hold?: GuidanceIntentHold;
}): InputTurnIntentEnvelope {
  return {
    version: 1,
    kind: 'input',
    messageContentObjectId: requireId(input.messageContentObjectId, 'messageContentObjectId'),
    guidance: {
      position: requirePosition(input.position),
      hold: requireGuidanceHold(input.hold ?? 'none')
    }
  };
}

export function parseInputTurnIntentEnvelope(value: unknown): InputTurnIntentEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'input') return null;
  const guidance = record.guidance;
  if (!guidance || typeof guidance !== 'object' || Array.isArray(guidance)) {
    throw new TypeError('TurnIntent input envelope is missing guidance metadata.');
  }
  const guidanceRecord = guidance as Record<string, unknown>;
  return inputTurnIntentEnvelope({
    messageContentObjectId: requireId(record.messageContentObjectId, 'TurnIntent input.messageContentObjectId'),
    position: requirePosition(guidanceRecord.position),
    hold: requireGuidanceHold(guidanceRecord.hold)
  });
}

export function parseInputTurnIntentEnvelopeText(source: string): InputTurnIntentEnvelope | null {
  return parseInputTurnIntentEnvelope(JSON.parse(source) as unknown);
}

export function runtimeContinuationTurnIntentEnvelope(input: {
  sourceTurnId: string | null;
}): RuntimeContinuationTurnIntentEnvelope {
  return {
    version: 1,
    kind: 'runtime_continuation',
    sourceTurnId: input.sourceTurnId === null ? null : requireId(input.sourceTurnId, 'sourceTurnId')
  };
}

export function parseRuntimeContinuationTurnIntentEnvelope(
  value: unknown
): RuntimeContinuationTurnIntentEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'runtime_continuation') return null;
  return runtimeContinuationTurnIntentEnvelope({
    sourceTurnId: record.sourceTurnId === null
      ? null
      : requireId(record.sourceTurnId, 'TurnIntent runtime_continuation.sourceTurnId')
  });
}

export function parseRuntimeContinuationTurnIntentEnvelopeText(
  source: string
): RuntimeContinuationTurnIntentEnvelope | null {
  return parseRuntimeContinuationTurnIntentEnvelope(JSON.parse(source) as unknown);
}

/** New ordinary inputs naturally sort after any queue order explicitly persisted by controls. */
export function initialGuidancePosition(timestamp: string): string {
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new TypeError('Guidance timestamp must be a valid non-negative ISO timestamp.');
  }
  return (BigInt(milliseconds) * 1_000_000n).toString();
}

export function compareGuidancePositions(left: string, right: string): number {
  const leftValue = BigInt(requirePosition(left));
  const rightValue = BigInt(requirePosition(right));
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

export function reorderedGuidancePosition(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new TypeError('Guidance order index must be non-negative.');
  return (BigInt(index + 1) * 1_000_000n).toString();
}

export function requireGuidanceHold(value: unknown): GuidanceIntentHold {
  if (value !== 'none' && value !== 'paused') {
    throw new TypeError(`Unsupported guidance hold state: ${String(value)}`);
  }
  return value;
}

export function requirePosition(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError('Guidance position must be a decimal integer string.');
  }
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be non-empty.`);
  }
  return value;
}
