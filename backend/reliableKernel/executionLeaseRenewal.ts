import type {
  ExecutionLeaseRenewalClock,
  ExecutionLeaseRenewalInput,
  ExecutionLeaseRenewalResult
} from './databaseWorkerProtocol';
import type { DomainRow } from './repositories';

/** Called after BEGIN IMMEDIATE succeeds, so transport, scheduling and lock waits all count. */
export function executionLeaseRenewalNow(
  clock: ExecutionLeaseRenewalClock,
  monotonicNowNs = process.hrtime.bigint(),
  wallNowMs = Date.now()
): number {
  const sampledEpochMs = timestampMs(clock.now, 'renewal clock');
  if (typeof clock.sampledAtNs !== 'bigint' || typeof monotonicNowNs !== 'bigint'
    || clock.sampledAtNs < 0n || clock.sampledAtNs > monotonicNowNs
    || typeof clock.systemClock !== 'boolean') {
    throw new TypeError('ExecutionLease renewal requires a valid monotonic clock sample.');
  }
  const logicalNowMs = sampledEpochMs + Number(monotonicNowNs - clock.sampledAtNs) / 1_000_000;
  // An injected logical clock must not be replaced by the worker's wall-clock epoch. Production
  // also observes a forward wall-clock correction; a backwards correction cannot revive expiry.
  return clock.systemClock ? Math.max(logicalNowMs, wallNowMs) : logicalNowMs;
}

/** Pure authority decision, used only over rows read while the worker holds the write lock. */
export function decideExecutionLeaseRenewal(
  input: ExecutionLeaseRenewalInput,
  turn: DomainRow | null,
  leases: DomainRow[],
  workerHostBootId: string,
  nowMs: number
): ExecutionLeaseRenewalResult {
  const fence = input.fence;
  for (const value of [fence.id, fence.conversationId, fence.turnId, fence.ownerId, fence.hostBootId]) {
    if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
      throw new TypeError('ExecutionLease renewal requires non-empty fence identities.');
    }
  }
  if (typeof fence.generation !== 'bigint' || fence.generation <= 0n || !Number.isFinite(nowMs)) {
    throw new TypeError('ExecutionLease renewal requires a positive generation and current time.');
  }
  const requestedExpiresMs = timestampMs(input.leaseExpiresAt, 'requested lease expiry');
  if (requestedExpiresMs <= nowMs) return { renewed: false, reason: 'requested_expiry_not_future' };
  if (leases.length !== 1) return { renewed: false, reason: 'lease_missing' };
  const current = leases[0];
  const observedExpiresMs = timestampMs(current.expires_at, 'ExecutionLease.expires_at');
  if (typeof current.generation !== 'bigint' || current.generation <= 0n) {
    throw new TypeError('ExecutionLease.generation must be a positive integer.');
  }
  const observed = {
    observedExpiresAt: current.expires_at as string,
    observedGeneration: current.generation.toString()
  };
  if (!turn || turn.id !== fence.turnId || turn.conversation_id !== fence.conversationId
    || turn.status !== 'active' || fence.hostBootId !== workerHostBootId
    || current.id !== fence.id || current.conversation_id !== fence.conversationId
    || current.turn_id !== fence.turnId || current.owner_id !== fence.ownerId
    || current.host_boot_id !== fence.hostBootId || current.generation !== fence.generation) {
    return { renewed: false, reason: 'fence_replaced', ...observed };
  }
  if (observedExpiresMs <= nowMs) return { renewed: false, reason: 'lease_expired', ...observed };
  timestampMs(current.acquired_at, 'ExecutionLease.acquired_at');
  return {
    renewed: true,
    observedExpiresAt: observed.observedExpiresAt,
    renewedExpiresAt: observedExpiresMs > requestedExpiresMs ? observed.observedExpiresAt : input.leaseExpiresAt
  };
}

function timestampMs(value: unknown, label: string): number {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be a valid timestamp.`);
  }
  return Date.parse(value);
}
