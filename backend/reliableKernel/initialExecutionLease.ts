import type { RuntimeCommitResult } from './contracts';
import type { ExecutionLeaseRenewalClock } from './databaseWorkerProtocol';
import type { ExecutionLeaseFence } from './executionLeaseFence';
import { executionLeaseRenewalNow } from './executionLeaseRenewal';
import type { DomainRow } from './repositories';

/** Explicit relative lifetime for a NEW first-generation row, never a renewal or recovery update. */
export interface InitialExecutionLeaseDuration {
  durationMs: number;
  clock: ExecutionLeaseRenewalClock;
}

export function requireInitialLeaseDuration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Initial ExecutionLease duration must be a positive safe integer.');
  }
  return value;
}

/** Called by the writer at the insertion point under the enclosing atomic transaction's lock. */
export function initialExecutionLeaseRow(
  row: DomainRow,
  lifetime: InitialExecutionLeaseDuration,
  hostBootId: string,
  turn: DomainRow | null,
  nowMs = executionLeaseRenewalNow(lifetime.clock)
): DomainRow {
  const durationMs = requireInitialLeaseDuration(lifetime.durationMs);
  if (row.generation !== 1n || row.host_boot_id !== hostBootId
    || !turn || turn.id !== row.turn_id || turn.conversation_id !== row.conversation_id
    || turn.status !== 'active') {
    throw new Error('Initial ExecutionLease duration requires a new local first-generation active Turn.');
  }
  const acquiredAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + durationMs).toISOString();
  return { ...row, acquired_at: acquiredAt, expires_at: expiresAt };
}

/** Capture the row just committed, without a read-back that could adopt a newer generation. */
export function committedInitialExecutionFence(commit: RuntimeCommitResult, leaseId: string): ExecutionLeaseFence {
  const row = commit.changes.find(change => change.domain === 'ExecutionLease'
    && change.id === leaseId && change.kind === 'upsert')?.record;
  if (!row || row.generation !== 1n) throw new Error('Initial ExecutionLease is missing from its atomic commit.');
  const id = (field: string): string => {
    const value = row[field];
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Invalid committed ExecutionLease.${field}.`);
    return value;
  };
  return { id: id('id'), conversationId: id('conversation_id'), turnId: id('turn_id'),
    ownerId: id('owner_id'), hostBootId: id('host_boot_id'), generation: row.generation };
}
