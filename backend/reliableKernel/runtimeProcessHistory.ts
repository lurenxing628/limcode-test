import type { DomainRow } from './repositories';

/**
 * Durable process history, not OS liveness. outcome_unknown closes an observation without claiming
 * the child exited or succeeded. A complete receipt may be copied as history; missing evidence and
 * pending delivery/reconciliation must not be imported as work for the receiving Runtime.
 * Aliases are internal constants, never user input. Migration keeps its separate, stricter policy:
 * unknown process outcomes still cannot be carried to another execution environment.
 */
export function hasConsistentProcessReceiptExit(receipt: DomainRow): boolean {
  const code = receipt.exit_code;
  const signal = receipt.exit_signal;
  if (receipt.outcome === 'outcome_unknown') return code === null && signal === null;
  if ((code === null) === (signal === null)
    || (code !== null && typeof code !== 'bigint')
    || (signal !== null && (typeof signal !== 'string' || signal.length === 0))) return false;
  if (receipt.outcome === 'succeeded') return code === 0n;
  if (receipt.outcome === 'failed') return code !== 0n;
  return ['cancelled', 'timed_out', 'output_limit_exceeded'].includes(String(receipt.outcome));
}

/** A terminal observation needs matching durable identity, state and time; receipt time is not exit evidence. */
export function hasMatchingTerminalProcessReceipt(process: DomainRow, receipt: DomainRow): boolean {
  if (process.id !== receipt.process_id || process.wrapper_nonce !== receipt.wrapper_nonce
    || process.start_fingerprint !== receipt.start_fingerprint
    || typeof process.completed_at !== 'string' || process.completed_at.length === 0
    || !hasConsistentProcessReceiptExit(receipt)) return false;
  if (process.status === 'outcome_unknown') return receipt.outcome === 'outcome_unknown';
  if (process.status === 'exited') return receipt.outcome === 'succeeded' || receipt.outcome === 'failed';
  return ['cancelled', 'timed_out', 'output_limit_exceeded'].includes(String(process.status))
    && receipt.outcome === process.status;
}

export function terminalProcessReceiptSql(process = 'process_row', receipt = 'receipt'): string {
  const exitTuple = `(((${receipt}.exit_code IS NOT NULL) <> (${receipt}.exit_signal IS NOT NULL))
    AND (${receipt}.exit_signal IS NULL OR length(${receipt}.exit_signal) > 0))`;
  return `(${process}.completed_at IS NOT NULL AND length(${process}.completed_at) > 0
    AND ${receipt}.id IS NOT NULL
    AND ${receipt}.wrapper_nonce = ${process}.wrapper_nonce
    AND ${receipt}.start_fingerprint = ${process}.start_fingerprint
    AND (
      (${process}.status = 'outcome_unknown' AND ${receipt}.outcome = 'outcome_unknown'
        AND ${receipt}.exit_code IS NULL AND ${receipt}.exit_signal IS NULL)
      OR (${process}.status = 'exited' AND ${exitTuple}
        AND ((${receipt}.outcome = 'succeeded' AND ${receipt}.exit_code = 0)
          OR (${receipt}.outcome = 'failed'
            AND (${receipt}.exit_code <> 0 OR ${receipt}.exit_signal IS NOT NULL))))
      OR (${process}.status IN ('cancelled', 'timed_out', 'output_limit_exceeded')
        AND ${receipt}.outcome = ${process}.status
        AND ${exitTuple})
    ))`;
}

/** Independent of source links: detached records must not hide pending work either. */
export const UNSETTLED_PROCESS_HISTORY_SQL = `
  SELECT COUNT(*) FROM process AS process_row
    LEFT JOIN process_receipt AS receipt ON receipt.process_id = process_row.id
   WHERE NOT COALESCE(${terminalProcessReceiptSql()}, 0)
      OR EXISTS (
        SELECT 1 FROM operation AS o
         WHERE o.owner_kind = 'process' AND o.owner_id = process_row.id
           AND o.status IN ('pending', 'executing', 'running', 'waiting_answer')
      )
      OR EXISTS (
        SELECT 1 FROM process_completion_dispatch AS dispatch
         WHERE dispatch.process_receipt_id = receipt.id AND dispatch.state IN ('pending', 'claimed')
      )
      OR (NOT EXISTS (SELECT 1 FROM process_completion_dispatch AS dispatch WHERE dispatch.process_receipt_id = receipt.id)
        AND EXISTS (
          SELECT 1 FROM operation AS o JOIN attempt AS a ON a.operation_id = o.id
            JOIN effect_intent AS e ON e.attempt_id = a.id
           WHERE o.owner_kind = 'process' AND o.owner_id = process_row.id
             AND o.tool_call_id IS NULL AND e.effect_kind = 'process_exit'
        ))`;
