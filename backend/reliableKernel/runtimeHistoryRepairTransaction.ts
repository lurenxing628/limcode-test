import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { auditDatabaseIntegrity } from './databaseSchema';
import { DOMAIN_REPOSITORIES } from './repositories';
import { prepareCached } from './runtimeStatementCache';
import {
  applyHistoryRepairRows, historyRepairCount, historyRepairPreservedDigest, inspectHistoryRepair,
  HISTORY_REPAIR_RECEIPT_PREFIX, HISTORY_REPAIR_REVISION, type RuntimeHistoryRepairInspection
} from './runtimeHistoryRepairInspection';

export interface RuntimeHistoryRepairInput {
  repairId: string;
  expected: RuntimeHistoryRepairInspection;
}
export interface RuntimeHistoryRepairResult {
  repairId: string;
  removedOperations: number;
  removedAttempts: number;
  restoredUnknownProcesses: number;
  alreadyApplied: boolean;
}

/** Bound to every confirmed fact, so reusing an id for a different plan cannot impersonate a commit. */
export function historyRepairMarker(input: RuntimeHistoryRepairInput): { id: string; key: string } {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(input.repairId)) throw new TypeError('Invalid history repair id.');
  const expected = input.expected;
  if (expected.revision !== HISTORY_REPAIR_REVISION || !/^[0-9a-f]{64}$/.test(expected.contentDigest)
    || !/^[0-9a-f]{64}$/.test(expected.preservedDigest)
    || ![expected.orphanOperations, expected.orphanAttempts, expected.restoredUnknownProcesses, expected.refused]
      .every((value) => Number.isSafeInteger(value) && value >= 0)) throw new TypeError('Invalid history repair plan.');
  const digest = createHash('sha256').update(JSON.stringify([
    expected.revision, expected.contentDigest, expected.preservedDigest, expected.orphanOperations,
    expected.orphanAttempts, expected.restoredUnknownProcesses, expected.refused
  ])).digest('hex');
  return { id: `history_repair_${input.repairId}`, key: `${HISTORY_REPAIR_RECEIPT_PREFIX}${input.repairId}:${digest}` };
}

export function historyRepairWasCommitted(database: Database.Database, input: RuntimeHistoryRepairInput): boolean {
  const marker = historyRepairMarker(input);
  const row = prepareCached(database, 'SELECT source_kind, source_key FROM command_receipt WHERE id = ?')
    .get(marker.id) as { source_kind: string; source_key: string } | undefined;
  if (row && (row.source_kind !== 'internal' || row.source_key !== marker.key)) throw new Error('History repair commit identity conflicts.');
  return row !== undefined;
}

/** Fixed, offline worker operation. Caller sets synchronous=FULL; the receipt and repair commit together. */
export function repairHistoryTransaction(database: Database.Database, input: RuntimeHistoryRepairInput): RuntimeHistoryRepairResult {
  const marker = historyRepairMarker(input);
  if (database.inTransaction) throw new Error('History repair cannot share a maintenance merge transaction.');
  if (BigInt(database.pragma('synchronous', { simple: true }) as bigint | number) !== 2n) {
    throw new Error('History repair must be durably committed.');
  }
  const result = (alreadyApplied: boolean): RuntimeHistoryRepairResult => ({
    repairId: input.repairId, removedOperations: input.expected.orphanOperations,
    removedAttempts: input.expected.orphanAttempts, restoredUnknownProcesses: input.expected.restoredUnknownProcesses, alreadyApplied
  });
  database.exec('BEGIN IMMEDIATE');
  try {
    if (historyRepairWasCommitted(database, input)) {
      database.exec('ROLLBACK');
      return result(true);
    }
    const current = inspectHistoryRepair(database);
    if (current.contentDigest !== input.expected.contentDigest || current.preservedDigest !== input.expected.preservedDigest
      || current.orphanOperations !== input.expected.orphanOperations || current.orphanAttempts !== input.expected.orphanAttempts
      || current.restoredUnknownProcesses !== input.expected.restoredUnknownProcesses) {
      throw Object.assign(new Error('历史库在检查后发生了变化，请重新检查并确认；本次没有修复。'), { code: 'runtime-history-repair-changed' });
    }
    if (current.refused > 0 || input.expected.refused > 0) {
      throw Object.assign(new Error('存在不能自动清理的依赖或非终态记录；本次没有修复。'), { code: 'runtime-history-repair-unsafe' });
    }
    if (historyRepairCount(current) === 0) { database.exec('ROLLBACK'); return result(false); }
    const applied = applyHistoryRepairRows(database);
    if (applied.operations !== current.orphanOperations || applied.processes !== current.restoredUnknownProcesses) {
      throw new Error('History repair changed an unexpected number of records.');
    }
    if (historyRepairPreservedDigest(database) !== current.preservedDigest) {
      throw new Error('History repair would alter protected history; the whole repair is rolled back.');
    }
    auditDatabaseIntegrity(database);
    const row = DOMAIN_REPOSITORIES.codec('CommandReceipt').encodeInsert({
      id: marker.id, source_kind: 'internal', source_key: marker.key, conversation_id: null, turn_id: null,
      created_at: new Date().toISOString()
    });
    prepareCached(database, `INSERT INTO command_receipt (id, source_kind, source_key, conversation_id, turn_id, created_at)
      VALUES (@id, @source_kind, @source_key, @conversation_id, @turn_id, @created_at)`).run(row);
    // No live commit consumers exist on a maintenance instance; discard the fixed operation's capture.
    database.exec('DELETE FROM temp.runtime_transaction_change');
    database.exec('COMMIT');
    return result(false);
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}
