import type { PlainData } from '../../shared/plainData';
import { CLIENT_MODEL_REQUEST_SUMMARY_MAX_BYTES, CLIENT_WINDOW_RECORD_SUMMARY_MAX_BYTES } from './clientFeedBounds';
import { projectModelRequestSummary } from './clientModelRequestSummary';

/** Converts database/runtime values to the exact plain representation sent to the Webview. */
export function toClientWirePlain(value: unknown, ancestors = new WeakSet<object>()): PlainData {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Client wire data contains a non-finite number.');
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (!value || typeof value !== 'object') throw new TypeError('Client wire data contains an unsupported value.');
  if (
    Buffer.isBuffer(value)
    || value instanceof Map
    || value instanceof Set
    || value instanceof Date
    || value instanceof RegExp
  ) throw new TypeError('Client wire data contains a forbidden non-plain value.');
  if (ancestors.has(value)) throw new TypeError('Client wire data contains a cycle.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => toClientWirePlain(entry, ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Client wire data contains a class instance.');
    }
    const result: Record<string, PlainData> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (nested !== undefined) result[key] = toClientWirePlain(nested, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

/** Applies the same per-record summary bound before page sizing and final bridge transport. */
export function boundClientRecordSummary(recordInput: Record<string, unknown>, domain?: string): Record<string, PlainData> {
  let record = toClientWirePlain(recordInput) as Record<string, PlainData>;
  if (domain === 'ModelRequest') {
    const summary = projectModelRequestSummary(record);
    if (clientWireBytes(summary) > CLIENT_MODEL_REQUEST_SUMMARY_MAX_BYTES) {
      // A broken bound is explicit, never a successfully delivered record with missing metrics.
      throw new RangeError('ModelRequest client summary exceeds its structured measurement byte limit.');
    }
    return summary;
  }
  if (clientWireBytes(record) <= CLIENT_WINDOW_RECORD_SUMMARY_MAX_BYTES) return record;
  record = truncateStrings(record, 256) as Record<string, PlainData>;
  if (clientWireBytes(record) <= CLIENT_WINDOW_RECORD_SUMMARY_MAX_BYTES) return record;
  const essential = new Set(['id', 'status', 'state', 'phase', 'parent_handling_state']);
  const compact: Record<string, PlainData> = { summary_truncated: true };
  for (const [key, value] of Object.entries(record)) {
    if (essential.has(key) || key.endsWith('_id') || key.endsWith('_seq')) compact[key] = value;
  }
  return compact;
}

export function clientWireBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Sets an exact self-inclusive byte count; the field's digit width stabilizes in at most a few passes. */
export function settleClientWireResponseBytes<T extends { responseBytes: number }>(value: T): number {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const bytes = clientWireBytes(value);
    if (value.responseBytes === bytes) return bytes;
    value.responseBytes = bytes;
  }
  throw new Error('Client wire responseBytes did not stabilize.');
}

function truncateStrings(value: PlainData, maxLength: number, field = ''): PlainData {
  if (typeof value === 'string') {
    if (field === 'id' || field.endsWith('_id') || field.endsWith('_seq')) return value;
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
  }
  if (Array.isArray(value)) return value.map((entry) => truncateStrings(entry, maxLength, field));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    truncateStrings(nested, maxLength, key)
  ]));
}
