import type { LlmCompressionMethodKind } from './protocol';

export type ExecutedCompressionMethod = Exclude<LlmCompressionMethodKind, 'disabled' | 'auto'>;
const METHODS: readonly string[] = ['provider_native', 'segmented_summary', 'llm_summary', 'deterministic_summary', 'manual_summary'];
const CATEGORIES = ['capability', 'transient', 'permanent', 'internal', 'cancelled'] as const;

/** Small committed metadata, not an alternate error/control journal and never raw provider payloads. */
export interface ProviderRequestFailureFact {
  category: typeof CATEGORIES[number];
  message: string;
  code?: string;
  reason?: string;
  status?: number;
  endpointKind?: string;
}
export interface CompressionAttemptFailure {
  methodKind: ExecutedCompressionMethod;
  message: string;
  code?: string;
  status?: number;
  modelRequestId?: string;
}
export interface CompressionRequestPurpose {
  groupId: string;
  blockId: string;
  methodKind: ExecutedCompressionMethod;
  trigger: 'auto' | 'manual';
  priorFailures: CompressionAttemptFailure[];
}
export interface CompressionRecoveryDecision {
  groupId: string;
  outcome: 'compressed' | 'continued_uncompressed';
  failures: CompressionAttemptFailure[];
  methodKind?: ExecutedCompressionMethod;
  estimatedTokens?: number;
  limitTokens?: number;
}

export function safeProviderFailureMessage(value: unknown): string {
  const text = typeof value === 'string' ? value : 'Provider request failed';
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, '[endpoint]')
    .replace(/\bBearer\s+[^\s,"';]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[=:]\s*["']?)[^\s,"';}]+/gi, '$1[redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .slice(0, 768) || 'Provider request failed';
}

export function readProviderRequestFailure(value: unknown): ProviderRequestFailureFact {
  const raw = object(value, 'request failure');
  exactKeys(raw, ['category', 'message', 'code', 'reason', 'status', 'endpointKind']);
  if (!CATEGORIES.includes(raw.category as ProviderRequestFailureFact['category'])) throw new TypeError('Invalid request failure category.');
  return {
    category: raw.category as ProviderRequestFailureFact['category'], message: boundedText(raw.message, 'failure message', 768),
    ...optionalText(raw, 'code'), ...optionalText(raw, 'reason'), ...optionalText(raw, 'endpointKind'),
    ...optionalStatus(raw.status)
  };
}

export function readCompressionFailures(value: unknown): CompressionAttemptFailure[] {
  if (!Array.isArray(value) || value.length > 6) throw new TypeError('Compression failures must be a bounded array.');
  return value.map((value) => {
    const raw = object(value, 'compression failure');
    exactKeys(raw, ['methodKind', 'message', 'code', 'status', 'modelRequestId']);
    return {
      methodKind: method(raw.methodKind), message: boundedText(raw.message, 'compression message', 768),
      ...optionalText(raw, 'code'), ...optionalText(raw, 'modelRequestId', 192), ...optionalStatus(raw.status)
    };
  });
}

export function readCompressionPurpose(value: unknown): CompressionRequestPurpose {
  const raw = object(value, 'compression purpose');
  exactKeys(raw, ['groupId', 'blockId', 'methodKind', 'trigger', 'priorFailures']);
  if (raw.trigger !== 'auto' && raw.trigger !== 'manual') throw new TypeError('Invalid compression trigger.');
  return {
    groupId: boundedText(raw.groupId, 'compression group', 192), blockId: boundedText(raw.blockId, 'compression block', 192),
    methodKind: method(raw.methodKind), trigger: raw.trigger, priorFailures: readCompressionFailures(raw.priorFailures)
  };
}

export function readCompressionDecision(value: unknown): CompressionRecoveryDecision {
  const raw = object(value, 'compression decision');
  exactKeys(raw, ['groupId', 'outcome', 'failures', 'methodKind', 'estimatedTokens', 'limitTokens']);
  if (raw.outcome !== 'compressed' && raw.outcome !== 'continued_uncompressed') throw new TypeError('Invalid compression decision outcome.');
  const tokenFields: { estimatedTokens?: number; limitTokens?: number } = {};
  for (const key of ['estimatedTokens', 'limitTokens'] as const) {
    if (raw[key] === undefined) continue;
    if (!Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0) throw new TypeError(`Invalid compression ${key}.`);
    tokenFields[key] = Number(raw[key]);
  }
  if (raw.outcome === 'continued_uncompressed' && (tokenFields.estimatedTokens === undefined
    || tokenFields.limitTokens === undefined || tokenFields.estimatedTokens > tokenFields.limitTokens)) {
    throw new TypeError('Uncompressed continuation lacks its bounded planning decision.');
  }
  return {
    groupId: boundedText(raw.groupId, 'compression group', 192), outcome: raw.outcome,
    failures: readCompressionFailures(raw.failures), ...tokenFields,
    ...(raw.methodKind === undefined ? {} : { methodKind: method(raw.methodKind) })
  };
}

/** Both initial and retry stats preserve these exact immutable recipe projections. */
export function compressionExecutionMetadata(value: unknown): {
  compressionPurpose?: CompressionRequestPurpose;
  compressionDecision?: CompressionRecoveryDecision;
} {
  const raw = object(value, 'execution metadata');
  return {
    ...(raw.compressionPurpose === undefined ? {} : { compressionPurpose: readCompressionPurpose(raw.compressionPurpose) }),
    ...(raw.compressionDecision === undefined ? {} : { compressionDecision: readCompressionDecision(raw.compressionDecision) })
  };
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TypeError('Unknown execution metadata field.');
}
function boundedText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`Invalid ${label}.`);
  return value;
}
function optionalText<K extends string>(value: Record<string, unknown>, key: K, max = 128): Partial<Record<K, string>> {
  return value[key] === undefined ? {} : { [key]: boundedText(value[key], key, max) } as Partial<Record<K, string>>;
}
function optionalStatus(value: unknown): { status?: number } {
  if (value === undefined) return {};
  if (!Number.isInteger(value) || Number(value) < 100 || Number(value) > 599) throw new TypeError('Invalid HTTP status.');
  return { status: Number(value) };
}
function method(value: unknown): ExecutedCompressionMethod {
  if (!METHODS.includes(String(value))) throw new TypeError('Invalid executed compression method.');
  return value as ExecutedCompressionMethod;
}
