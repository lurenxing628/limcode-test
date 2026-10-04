import type { ReliableKernelCollaborationHistoryCursor } from '../../shared/reliableKernelClientFeed';
import { requireNonNegativeIntegerString, requireRuntimeId } from './runtimeSqlRows';

export function normalizeCollaborationHistoryCursor(value: unknown): ReliableKernelCollaborationHistoryCursor | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid exchange history cursor.');
  const cursor = value as Record<string, unknown>;
  const sequence = (input: unknown) => {
    const result = requireNonNegativeIntegerString(input, 'exchange history sequence');
    if (result === '0') throw new TypeError('Exchange history sequence must be positive.');
    return result;
  };
  if (cursor.kind === 'exchange') {
    if (Object.keys(cursor).some(key => !['kind', 'beforeExchangeSeq'].includes(key))) throw new TypeError('Invalid exchange cursor fields.');
    return { kind: 'exchange', ...(cursor.beforeExchangeSeq === undefined ? {} : { beforeExchangeSeq: sequence(cursor.beforeExchangeSeq) }) };
  }
  if (cursor.kind !== 'message' && cursor.kind !== 'answer') throw new TypeError('Invalid exchange history cursor kind.');
  const key = cursor.kind === 'message' ? 'beforeMessageSeq' : 'beforeCreatedAt';
  if (Object.keys(cursor).some(field => !['kind', key, 'beforeId'].includes(field))
    || (cursor[key] === undefined) !== (cursor.beforeId === undefined)) throw new TypeError('Incomplete exchange history cursor.');
  if (cursor.beforeId === undefined) return { kind: cursor.kind };
  const beforeId = requireRuntimeId(cursor.beforeId);
  if (cursor.kind === 'message') return { kind: 'message', beforeMessageSeq: sequence(cursor.beforeMessageSeq), beforeId };
  if (typeof cursor.beforeCreatedAt !== 'string' || !Number.isFinite(Date.parse(cursor.beforeCreatedAt))) throw new TypeError('Invalid answer inventory cursor.');
  return { kind: 'answer', beforeCreatedAt: cursor.beforeCreatedAt, beforeId };
}
