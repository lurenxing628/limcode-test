import type Database from 'better-sqlite3';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { RuntimeDataInvariantError } from './runtimeDataInvariant';
import { requireRuntimeId } from './runtimeSqlRows';
import { prepareCached } from './runtimeStatementCache';

export const CORRUPTED_CONSUMED_DELIVERY_REASON = 'corrupted-consumed-delivery-without-input-link';
export const CORRUPTED_DELIVERY_WAKE_REASON = 'corrupted-runtime-delivery-wake';

const VALID_PHASES = new Set(['current_turn', 'next_turn', 'notify_only']);
const VALID_STATES = new Set(['pending', 'consumed', 'failed']);

export interface RuntimeDeliveryStartupRepairSummary {
  repairedDeliveries: number;
  repairedWakes: number;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateRuntimeDeliveryFields(
  id: string,
  state: unknown,
  phase: unknown,
  targetTurnId: unknown,
  failureReason: unknown,
  linkCount: number
): void {
  if (!VALID_PHASES.has(String(phase))) {
    throw new RuntimeDataInvariantError('RuntimeDelivery', id, `RuntimeDelivery ${id} has invalid phase ${String(phase)}.`);
  }
  if (!VALID_STATES.has(String(state))) {
    throw new RuntimeDataInvariantError('RuntimeDelivery', id, `RuntimeDelivery ${id} has invalid state ${String(state)}.`);
  }
  if (linkCount > 1) {
    throw new RuntimeDataInvariantError('RuntimeDelivery', id, `RuntimeDelivery ${id} has multiple input links.`);
  }
  if (state === 'pending') {
    if (failureReason !== null) {
      throw new RuntimeDataInvariantError('RuntimeDelivery', id, `Pending RuntimeDelivery ${id} cannot carry failure_reason.`);
    }
    if (linkCount !== 0) {
      throw new RuntimeDataInvariantError('RuntimeDelivery', id, `Pending RuntimeDelivery ${id} cannot have a RuntimeDeliveryInputLink.`);
    }
    if (phase === 'current_turn') {
      if (!nonEmptyString(targetTurnId)) {
        throw new RuntimeDataInvariantError('RuntimeDelivery', id, `Pending current_turn RuntimeDelivery ${id} requires target_turn_id.`);
      }
    } else if (targetTurnId !== null) {
      throw new RuntimeDataInvariantError('RuntimeDelivery', id, `Pending ${String(phase)} RuntimeDelivery ${id} cannot set target_turn_id.`);
    }
    return;
  }
  if (state === 'failed') {
    if (!nonEmptyString(failureReason)) {
      throw new RuntimeDataInvariantError('RuntimeDelivery', id, `Failed RuntimeDelivery ${id} requires failure_reason.`);
    }
    if (linkCount !== 0) {
      throw new RuntimeDataInvariantError('RuntimeDelivery', id, `Failed RuntimeDelivery ${id} cannot have a RuntimeDeliveryInputLink.`);
    }
    return;
  }
  if (failureReason !== null) {
    throw new RuntimeDataInvariantError('RuntimeDelivery', id, `Consumed RuntimeDelivery ${id} cannot carry failure_reason.`);
  }
  if (phase === 'notify_only') {
    if (targetTurnId !== null || linkCount !== 0) {
      throw new RuntimeDataInvariantError(
        'RuntimeDelivery',
        id,
        `Consumed notify_only RuntimeDelivery ${id} must have null target_turn_id and no RuntimeDeliveryInputLink.`
      );
    }
    return;
  }
  if (!nonEmptyString(targetTurnId) || linkCount !== 1) {
    throw new RuntimeDataInvariantError(
      'RuntimeDelivery',
      id,
      `Consumed ${String(phase)} RuntimeDelivery ${id} requires target_turn_id and exactly one RuntimeDeliveryInputLink.`
    );
  }
}

/**
 * Asserts the committed/copied aggregate of one RuntimeDelivery and its RuntimeDeliveryInputLink
 * unit. Used at the end of every ordinary or maintenance transaction touching either domain and
 * during offline history inspection.
 */
export function assertRuntimeDeliveryAggregate(database: Database.Database, deliveryIdInput: string): void {
  const id = requireRuntimeId(deliveryIdInput);
  const raw = prepareCached(
    database,
    'SELECT state, phase, target_turn_id, failure_reason FROM runtime_delivery WHERE id = ?'
  ).get(id) as {
    state: unknown;
    phase: unknown;
    target_turn_id: unknown;
    failure_reason: unknown;
  } | undefined;
  if (!raw) return;
  const links = prepareCached(
    database,
    'SELECT pending_turn_input_id FROM runtime_delivery_input_link WHERE delivery_id = ? LIMIT 2'
  ).all(id) as Array<{ pending_turn_input_id: string }>;
  validateRuntimeDeliveryFields(id, raw.state, raw.phase, raw.target_turn_id, raw.failure_reason, links.length);
}

/**
 * Validates a live RuntimeDeliveryRepository.update transition before the UPDATE statement runs.
 * When transitioning into `consumed` for `current_turn` or `next_turn`, the matching
 * RuntimeDeliveryInputLink and PendingTurnInput for `target_turn_id` must already be present in
 * the same transaction.
 */
export function assertRuntimeDeliveryStateTransition(
  database: Database.Database,
  id: string,
  patch: DomainRow
): { state: string; phase: unknown } {
  const raw = prepareCached(
    database,
    'SELECT * FROM runtime_delivery WHERE id = ?'
  ).get(id) as Record<string, unknown> | undefined;
  if (!raw) {
    throw new Error(`RuntimeDeliveryRepository update expected one row: ${id}`);
  }
  const current = DOMAIN_REPOSITORIES.codec('RuntimeDelivery').decode(raw);
  const currentState = String(current.state);
  const nextState = 'state' in patch ? String(patch.state) : currentState;
  const allowed: Record<string, readonly string[]> = {
    pending: ['pending', 'consumed', 'failed'],
    consumed: [],
    failed: []
  };
  if (!allowed[currentState]?.includes(nextState)) {
    throw new Error(`RuntimeDelivery state cannot transition from ${currentState} to ${nextState}.`);
  }
  const nextPhase = 'phase' in patch ? patch.phase : current.phase;
  const nextTargetTurnId = 'target_turn_id' in patch ? patch.target_turn_id : current.target_turn_id;
  const nextFailureReason = 'failure_reason' in patch ? patch.failure_reason : current.failure_reason;
  const links = prepareCached(
    database,
    'SELECT pending_turn_input_id FROM runtime_delivery_input_link WHERE delivery_id = ? LIMIT 2'
  ).all(id) as Array<{ pending_turn_input_id: string }>;

  validateRuntimeDeliveryFields(id, nextState, nextPhase, nextTargetTurnId, nextFailureReason, links.length);

  if (nextState === 'consumed' && nextPhase !== 'notify_only') {
    const input = prepareCached(
      database,
      'SELECT turn_id, input_kind FROM pending_turn_input WHERE id = ?'
    ).get(links[0]!.pending_turn_input_id) as { turn_id?: unknown; input_kind?: unknown } | undefined;
    if (!input || input.input_kind !== 'runtime_delivery' || input.turn_id !== nextTargetTurnId) {
      throw new RuntimeDataInvariantError(
        'RuntimeDelivery',
        id,
        `Consumed ${String(nextPhase)} RuntimeDelivery ${id} requires a PendingTurnInput owned by target_turn_id ${String(nextTargetTurnId)}.`
      );
    }
  }
  return { state: currentState, phase: current.phase };
}

/**
 * Validates initial insert invariants for ProcessCompletionDispatch and RuntimeDeliveryWake rows
 * (both live inserts and copied terminal rows).
 */
export function assertClaimedOutboxInsert(
  domain: 'ProcessCompletionDispatch' | 'RuntimeDeliveryWake',
  row: DomainRow,
  terminalTimestampColumn: 'completed_at' | 'acknowledged_at',
  successState: 'completed' | 'acknowledged'
): void {
  const id = String(row.id ?? '');
  const state = String(row.state);
  if (!['pending', 'claimed', successState, 'dead_letter'].includes(state)) {
    throw new RuntimeDataInvariantError(domain, id, `${domain} ${id} has invalid state ${state}.`);
  }
  const owner = row.claim_owner_host_boot_id;
  const expiresAt = row.claim_expires_at;
  const generation = BigInt(String(row.claim_generation ?? -1));
  const attempts = BigInt(String(row.attempt_count ?? -1));
  const failures = BigInt(String(row.failure_count ?? -1));
  if (generation < 0n || attempts < 0n || failures < 0n) {
    throw new RuntimeDataInvariantError(domain, id, `${domain} counters must be non-negative integers.`);
  }
  if (state === 'claimed') {
    if (!nonEmptyString(owner) || !nonEmptyString(expiresAt) || generation < 1n || attempts < 1n) {
      throw new RuntimeDataInvariantError(domain, id, `${domain} claimed state requires owner, expiry, and positive generation/attempt.`);
    }
  } else if (owner !== null || expiresAt !== null) {
    throw new RuntimeDataInvariantError(domain, id, `${domain} non-claimed state cannot retain a claim owner or expiry.`);
  }
  const terminalTimestamp = row[terminalTimestampColumn];
  if (state === successState) {
    if (!nonEmptyString(terminalTimestamp)) {
      throw new RuntimeDataInvariantError(domain, id, `${domain} ${successState} state requires ${terminalTimestampColumn}.`);
    }
  } else if (terminalTimestamp !== null) {
    throw new RuntimeDataInvariantError(domain, id, `${domain} ${terminalTimestampColumn} is only valid in ${successState} state.`);
  }
  if (state === 'dead_letter' && !nonEmptyString(row.last_error)) {
    throw new RuntimeDataInvariantError(domain, id, `${domain} dead_letter state requires last_error.`);
  }
}

const CORRUPTED_DELIVERY_OR_WAKE_PROBE_SQL = `
  SELECT 1 AS corrupted
    FROM runtime_delivery AS d
   WHERE (
     d.state = 'consumed'
     AND (
       d.failure_reason IS NOT NULL
       OR (
         d.phase = 'notify_only'
         AND (
           d.target_turn_id IS NOT NULL
           OR EXISTS (SELECT 1 FROM runtime_delivery_input_link AS l WHERE l.delivery_id = d.id)
         )
       )
       OR (
         d.phase IN ('current_turn', 'next_turn')
         AND (
           d.target_turn_id IS NULL
           OR length(d.target_turn_id) = 0
           OR (SELECT COUNT(*) FROM runtime_delivery_input_link AS l WHERE l.delivery_id = d.id) <> 1
         )
       )
     )
   )
   OR (
     d.state = 'failed'
     AND (
       d.failure_reason IS NULL
       OR length(d.failure_reason) = 0
     )
   )
  UNION ALL
  SELECT 1 AS corrupted
    FROM runtime_delivery_wake AS w
    LEFT JOIN runtime_delivery AS d ON d.id = w.delivery_id
   WHERE (
     w.state IN ('pending', 'claimed')
     AND d.state = 'failed'
   )
   OR (
     w.state = 'acknowledged'
     AND (
       w.acknowledged_at IS NULL
       OR length(w.acknowledged_at) = 0
       OR w.claim_owner_host_boot_id IS NOT NULL
       OR w.claim_expires_at IS NOT NULL
       OR d.state IN ('failed', 'pending')
     )
   )
   OR (
     w.state = 'dead_letter'
     AND (
       w.last_error IS NULL
       OR length(w.last_error) = 0
       OR w.claim_owner_host_boot_id IS NOT NULL
       OR w.claim_expires_at IS NOT NULL
       OR w.acknowledged_at IS NOT NULL
     )
   )
   LIMIT 1
`;

/**
 * Deterministic, idempotent startup repair run on the writer connection before live snapshot/projection
 * queries are served. Clean databases execute one read-only probe without acquiring a write transaction.
 * Historical rows corrupted by raw external SQL (for example `state='consumed', phase='next_turn',
 * target_turn_id=NULL` without a RuntimeDeliveryInputLink, or `wake.state='acknowledged'` without
 * `acknowledged_at`) are atomically converged to valid terminal/recoverable states instead of being
 * silently masked in clientProjection.
 */
export function reconcileCorruptedRuntimeDeliveriesOnOpen(
  database: Database.Database,
  now = new Date().toISOString()
): RuntimeDeliveryStartupRepairSummary {
  const hasCorruption = database.prepare(CORRUPTED_DELIVERY_OR_WAKE_PROBE_SQL).get();
  if (!hasCorruption) {
    return { repairedDeliveries: 0, repairedWakes: 0 };
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    let repairedDeliveries = 0;
    let repairedWakes = 0;

    // 1. Consumed current/next_turn delivery backed by a single runtime_delivery InputLink + PendingTurnInput: restore target_turn_id.
    repairedDeliveries += Number(database.prepare(`
      UPDATE runtime_delivery
         SET target_turn_id = COALESCE(
               NULLIF(target_turn_id, ''),
               (
                 SELECT p.turn_id
                   FROM runtime_delivery_input_link AS l
                   JOIN pending_turn_input AS p ON p.id = l.pending_turn_input_id
                  WHERE l.delivery_id = runtime_delivery.id
                    AND p.input_kind = 'runtime_delivery'
               )
             ),
             failure_reason = NULL,
             updated_at = @now
       WHERE state = 'consumed'
         AND phase IN ('current_turn', 'next_turn')
         AND (SELECT COUNT(*) FROM runtime_delivery_input_link AS l WHERE l.delivery_id = runtime_delivery.id) = 1
         AND (
           ((target_turn_id IS NULL OR length(target_turn_id) = 0) AND EXISTS (
             SELECT 1
               FROM runtime_delivery_input_link AS l
               JOIN pending_turn_input AS p ON p.id = l.pending_turn_input_id
              WHERE l.delivery_id = runtime_delivery.id
                AND p.input_kind = 'runtime_delivery'
                AND length(p.turn_id) > 0
           ))
           OR (target_turn_id IS NOT NULL AND length(target_turn_id) > 0 AND failure_reason IS NOT NULL)
         )
    `).run({ now }).changes);

    // 2. Consumed notify_only delivery: promote to current_turn if backed by a valid runtime_delivery InputLink,
    //    otherwise remove any orphan/duplicate InputLinks and normalize target_turn_id / failure_reason to NULL.
    repairedDeliveries += Number(database.prepare(`
      UPDATE runtime_delivery
         SET phase = 'current_turn',
             target_turn_id = (
               SELECT p.turn_id
                 FROM runtime_delivery_input_link AS l
                 JOIN pending_turn_input AS p ON p.id = l.pending_turn_input_id
                WHERE l.delivery_id = runtime_delivery.id
                  AND p.input_kind = 'runtime_delivery'
             ),
             failure_reason = NULL,
             updated_at = @now
       WHERE state = 'consumed'
         AND phase = 'notify_only'
         AND (SELECT COUNT(*) FROM runtime_delivery_input_link AS l WHERE l.delivery_id = runtime_delivery.id) = 1
         AND EXISTS (
           SELECT 1
             FROM runtime_delivery_input_link AS l
             JOIN pending_turn_input AS p ON p.id = l.pending_turn_input_id
            WHERE l.delivery_id = runtime_delivery.id
              AND p.input_kind = 'runtime_delivery'
              AND length(p.turn_id) > 0
         )
    `).run({ now }).changes);

    const corruptNotifyOnlyIds = (database.prepare(`
      SELECT id
        FROM runtime_delivery AS d
       WHERE d.state = 'consumed'
         AND d.phase = 'notify_only'
         AND (
           d.target_turn_id IS NOT NULL
           OR d.failure_reason IS NOT NULL
           OR EXISTS (SELECT 1 FROM runtime_delivery_input_link AS l WHERE l.delivery_id = d.id)
         )
    `).all() as Array<{ id: string }>).map((row) => row.id);
    if (corruptNotifyOnlyIds.length > 0) {
      const deleteNotifyLink = database.prepare('DELETE FROM runtime_delivery_input_link WHERE delivery_id = ?');
      const normalizeNotifyOnly = database.prepare(`
        UPDATE runtime_delivery
           SET target_turn_id = NULL,
               failure_reason = NULL,
               updated_at = @now
         WHERE id = @id
      `);
      for (const id of corruptNotifyOnlyIds) {
        deleteNotifyLink.run(id);
        repairedDeliveries += Number(normalizeNotifyOnly.run({ id, now }).changes);
      }
    }

    // 3. Consumed current/next_turn delivery without a RuntimeDeliveryInputLink: settle as failed.
    repairedDeliveries += Number(database.prepare(`
      UPDATE runtime_delivery
         SET state = 'failed',
             target_turn_id = NULL,
             failure_reason = COALESCE(NULLIF(failure_reason, ''), @reason),
             updated_at = @now
       WHERE state = 'consumed'
         AND phase IN ('current_turn', 'next_turn')
         AND NOT EXISTS (SELECT 1 FROM runtime_delivery_input_link AS l WHERE l.delivery_id = runtime_delivery.id)
    `).run({ now, reason: CORRUPTED_CONSUMED_DELIVERY_REASON }).changes);

    // 4. Consumed current/next_turn delivery still lacking target_turn_id (orphan InputLink without PendingTurnInput):
    //    remove orphan InputLink(s) and settle as failed without fabricating a Turn.
    const unrecoverableConsumedIds = (database.prepare(`
      SELECT id
        FROM runtime_delivery AS d
       WHERE d.state = 'consumed'
         AND d.phase IN ('current_turn', 'next_turn')
         AND (
           d.target_turn_id IS NULL
           OR length(d.target_turn_id) = 0
           OR (SELECT COUNT(*) FROM runtime_delivery_input_link AS l WHERE l.delivery_id = d.id) <> 1
         )
    `).all() as Array<{ id: string }>).map((row) => row.id);
    if (unrecoverableConsumedIds.length > 0) {
      const deleteLink = database.prepare('DELETE FROM runtime_delivery_input_link WHERE delivery_id = ?');
      const failDelivery = database.prepare(`
        UPDATE runtime_delivery
           SET state = 'failed',
               target_turn_id = NULL,
               failure_reason = COALESCE(NULLIF(failure_reason, ''), @reason),
               updated_at = @now
         WHERE id = @id
      `);
      for (const id of unrecoverableConsumedIds) {
        deleteLink.run(id);
        repairedDeliveries += Number(failDelivery.run({ id, now, reason: CORRUPTED_CONSUMED_DELIVERY_REASON }).changes);
      }
    }

    // 5. Failed delivery missing failure_reason.
    repairedDeliveries += Number(database.prepare(`
      UPDATE runtime_delivery
         SET failure_reason = @reason,
             updated_at = @now
       WHERE state = 'failed'
         AND (failure_reason IS NULL OR length(failure_reason) = 0)
    `).run({ now, reason: CORRUPTED_CONSUMED_DELIVERY_REASON }).changes);

    // 6. Wake whose delivery is failed while wake was left pending/claimed or acknowledged-without-timestamp: dead-letter it.
    repairedWakes += Number(database.prepare(`
      UPDATE runtime_delivery_wake
         SET state = 'dead_letter',
             claim_owner_host_boot_id = NULL,
             claim_expires_at = NULL,
             next_attempt_at = NULL,
             acknowledged_at = NULL,
             last_error = COALESCE(
               NULLIF(last_error, ''),
               (SELECT NULLIF(d.failure_reason, '') FROM runtime_delivery AS d WHERE d.id = runtime_delivery_wake.delivery_id),
               @reason
             ),
             updated_at = @now
       WHERE EXISTS (
         SELECT 1
           FROM runtime_delivery AS d
          WHERE d.id = runtime_delivery_wake.delivery_id
            AND d.state = 'failed'
       )
         AND state IN ('pending', 'claimed', 'acknowledged')
    `).run({ now, reason: CORRUPTED_DELIVERY_WAKE_REASON }).changes);

    // 7. Acknowledged wake missing acknowledged_at or retaining claim fields while delivery is consumed: normalize it.
    repairedWakes += Number(database.prepare(`
      UPDATE runtime_delivery_wake
         SET acknowledged_at = COALESCE(NULLIF(acknowledged_at, ''), NULLIF(updated_at, ''), NULLIF(created_at, ''), @now),
             claim_owner_host_boot_id = NULL,
             claim_expires_at = NULL
       WHERE state = 'acknowledged'
         AND (
           acknowledged_at IS NULL
           OR length(acknowledged_at) = 0
           OR claim_owner_host_boot_id IS NOT NULL
           OR claim_expires_at IS NOT NULL
         )
         AND EXISTS (
           SELECT 1
             FROM runtime_delivery AS d
            WHERE d.id = runtime_delivery_wake.delivery_id
              AND d.state = 'consumed'
         )
    `).run({ now }).changes);

    // 8. Acknowledged wake while delivery is still pending (or retaining claim fields / missing timestamp): return wake to pending.
    repairedWakes += Number(database.prepare(`
      UPDATE runtime_delivery_wake
         SET state = 'pending',
             acknowledged_at = NULL,
             claim_owner_host_boot_id = NULL,
             claim_expires_at = NULL,
             updated_at = @now
       WHERE state = 'acknowledged'
         AND EXISTS (
           SELECT 1
             FROM runtime_delivery AS d
            WHERE d.id = runtime_delivery_wake.delivery_id
              AND d.state = 'pending'
         )
    `).run({ now }).changes);

    // 9. Orphan acknowledged wake (delivery missing) with corrupt fields, or dead-letter wake missing last_error: normalize to dead_letter.
    repairedWakes += Number(database.prepare(`
      UPDATE runtime_delivery_wake
         SET state = 'dead_letter',
             last_error = COALESCE(NULLIF(last_error, ''), @reason),
             claim_owner_host_boot_id = NULL,
             claim_expires_at = NULL,
             next_attempt_at = NULL,
             acknowledged_at = NULL,
             updated_at = @now
       WHERE (
         state = 'dead_letter'
         AND (
           last_error IS NULL
           OR length(last_error) = 0
           OR claim_owner_host_boot_id IS NOT NULL
           OR claim_expires_at IS NOT NULL
           OR acknowledged_at IS NOT NULL
         )
       )
       OR (
         state = 'acknowledged'
         AND NOT EXISTS (SELECT 1 FROM runtime_delivery AS d WHERE d.id = runtime_delivery_wake.delivery_id)
         AND (
           acknowledged_at IS NULL
           OR length(acknowledged_at) = 0
           OR claim_owner_host_boot_id IS NOT NULL
           OR claim_expires_at IS NOT NULL
         )
       )
    `).run({ now, reason: CORRUPTED_DELIVERY_WAKE_REASON }).changes);

    if (database.prepare(CORRUPTED_DELIVERY_OR_WAKE_PROBE_SQL).get()) {
      throw new RuntimeDataInvariantError(
        'RuntimeDelivery',
        'startup-reconcile',
        'Corrupted RuntimeDelivery or RuntimeDeliveryWake remained after startup reconciliation.'
      );
    }

    database.exec('COMMIT');
    return { repairedDeliveries, repairedWakes };
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}
