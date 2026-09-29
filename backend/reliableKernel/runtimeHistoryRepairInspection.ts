import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { DOMAIN_REPOSITORIES } from './repositories';
import { runtimeDataSetContentDigest } from './runtimeDataSetContent';
import { prepareCached } from './runtimeStatementCache';
import { terminalProcessReceiptSql } from './runtimeProcessHistory';
import { assertModelRequestAggregate } from './runtimeModelRequestAggregate';
import { isRuntimeDataInvariant } from './runtimeDataInvariant';

export const HISTORY_REPAIR_REVISION = '2026-09-30-terminal-model-orphans';
export const HISTORY_REPAIR_RECEIPT_PREFIX = 'historical-repair:';
const SAMPLE_LIMIT = 20;

/** A soft owner erased by the released Conversation -> Turn -> ModelRequest deletion. */
const ORPHAN = `o.owner_kind = 'model_request'
  AND NOT EXISTS (SELECT 1 FROM model_request AS r WHERE r.id = o.owner_id)`;
const RESTORE_UNKNOWN = `p.status = 'exited' AND p.completed_at IS NOT NULL AND length(p.completed_at) > 0 AND EXISTS (
  SELECT 1 FROM process_receipt AS r WHERE r.process_id = p.id AND r.outcome = 'outcome_unknown'
    AND r.wrapper_nonce = p.wrapper_nonce AND r.start_fingerprint = p.start_fingerprint
    AND r.exit_code IS NULL AND r.exit_signal IS NULL)`;

export interface RuntimeHistoryRepairInspection {
  revision: typeof HISTORY_REPAIR_REVISION;
  contentDigest: string;
  /** Every original table/row except the exact repair projection, including all message revisions. */
  preservedDigest: string;
  orphanOperations: number;
  orphanAttempts: number;
  restoredUnknownProcesses: number;
  refused: number;
  samples: Array<{ domain: string; id: string; reason: string }>;
}

export function historyRepairCount(plan: RuntimeHistoryRepairInspection): number {
  return plan.orphanOperations + plan.restoredUnknownProcesses;
}

/**
 * Read-only, bounded inspection. This is not a generic orphan collector: only terminal model
 * bookkeeping with no retained effect/pause dependency may be removed, after explicit confirmation
 * and a durable backup. Missing parents are not synthesized and no Process exit is invented.
 */
export function inspectHistoryRepair(database: Database.Database): RuntimeHistoryRepairInspection {
  const plan: RuntimeHistoryRepairInspection = {
    revision: HISTORY_REPAIR_REVISION, contentDigest: '', preservedDigest: '', orphanOperations: 0,
    orphanAttempts: 0, restoredUnknownProcesses: 0, refused: 0, samples: []
  };
  const sample = (domain: string, id: string, reason: string, refused = false): void => {
    if (refused) plan.refused += 1;
    if (refused) {
      plan.samples.unshift({ domain, id, reason });
      if (plan.samples.length > SAMPLE_LIMIT) plan.samples.pop();
    } else if (plan.samples.length < SAMPLE_LIMIT) plan.samples.push({ domain, id, reason });
  };
  const operations = prepareCached(database, `SELECT o.* FROM operation AS o WHERE ${ORPHAN} ORDER BY o.id`);
  const attempts = prepareCached(database, 'SELECT * FROM attempt WHERE operation_id = ? ORDER BY attempt_seq LIMIT 12');
  const pauses = prepareCached(database, 'SELECT id FROM outcome_pause WHERE operation_id = ? LIMIT 1');
  const effect = prepareCached(database, `SELECT id FROM effect_intent WHERE attempt_id = ?
    UNION ALL SELECT id FROM effect_receipt WHERE attempt_id = ? LIMIT 1`);
  for (const raw of operations.iterate() as IterableIterator<Record<string, unknown>>) {
    plan.orphanOperations += 1;
    try {
      const op = DOMAIN_REPOSITORIES.codec('Operation').decode(raw);
      const children = (attempts.all(op.id) as Record<string, unknown>[]).map((row) => DOMAIN_REPOSITORIES.codec('Attempt').decode(row));
      plan.orphanAttempts += children.length;
      const terminal = ['completed', 'cancelled', 'failed'].includes(String(op.status));
      const valid = terminal && op.tool_call_id === null && BigInt(String(op.operation_seq)) === 1n
        && children.length >= 1 && children.length <= 11
        && children.every((row, index) => BigInt(String(row.attempt_seq)) === BigInt(index + 1)
          && row.completed_at !== null
          && row.status === (index === children.length - 1 ? op.status : 'transient_failed'));
      if (!valid) { sample('Operation', String(op.id), '父模型请求缺失，但不是可清理的完整终态执行记录', true); continue; }
      if (pauses.get(op.id) || children.some((row) => effect.get(row.id, row.id))) {
        sample('Operation', String(op.id), '仍有结果暂停或外部效果记录依赖，不能自动清理', true);
        continue;
      }
      sample('Operation', String(op.id), '父模型请求缺失；终态执行元数据可在备份后清理');
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== undefined) throw error;
      sample('Operation', String(raw.id), `记录格式不完整：${error instanceof Error ? error.message : String(error)}`, true);
    }
  }
  // This retained soft reference is not indexed. Scan it ONCE, not once per orphan operation.
  for (const row of prepareCached(database, `SELECT e.id FROM effect_receipt AS e
    JOIN operation AS o ON o.id = e.operation_id WHERE ${ORPHAN}`).iterate() as IterableIterator<{ id: string }>) {
    sample('EffectReceipt', row.id, '保留的效果回执仍引用缺父记录的操作，不能自动清理', true);
  }
  for (const row of prepareCached(database, `SELECT p.id FROM process AS p WHERE ${RESTORE_UNKNOWN} ORDER BY p.id`)
    .iterate() as IterableIterator<{ id: string }>) {
    plan.restoredUnknownProcesses += 1;
    sample('Process', row.id, '状态与未知结果回执矛盾；仅恢复为 outcome_unknown，不改变回执或退出码');
  }
  for (const row of prepareCached(database, `SELECT p.id FROM process AS p LEFT JOIN process_receipt AS r ON r.process_id = p.id
    WHERE p.status <> 'running' AND NOT COALESCE(${terminalProcessReceiptSql('p', 'r')}, 0) AND NOT (${RESTORE_UNKNOWN})`)
    .iterate() as IterableIterator<{ id: string }>) {
    sample('Process', row.id, '缺少或无法匹配结束回执，不能从时间或状态推断退出结果', true);
  }
  for (const row of prepareCached(database, 'SELECT id FROM model_request ORDER BY id').iterate() as IterableIterator<{ id: string }>) {
    try { assertModelRequestAggregate(database, row.id); }
    catch (error) {
      if (!isRuntimeDataInvariant(error)) throw error;
      sample('ModelRequest', row.id, `现存模型请求聚合不一致，不能猜测修复：${error instanceof Error ? error.message : String(error)}`, true);
    }
  }
  plan.contentDigest = runtimeDataSetContentDigest(database);
  plan.preservedDigest = historyRepairPreservedDigest(database);
  return plan;
}

/**
 * The normalized state a repair MUST preserve. Main tables only, in stable primary-key order;
 * no unbounded JS sets. Exact known orphan metadata is omitted; only the mismatched process status
 * backed by an existing unknown receipt is normalized. Everything else, CAS metadata and every
 * message/current-revision/membership/link included, must hash identically before and after.
 * The same repair's one commit marker alone is excluded after the commit.
 */
export function historyRepairPreservedDigest(database: Database.Database, markerKey?: string): string {
  const hash = createHash('sha256').update('limcode-history-repair-preserved\0');
  const tables = prepareCached(database, "SELECT name FROM main.sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  const put = (value: unknown): void => {
    const encoded = JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { integer: item.toString() } : item);
    hash.update(`${Buffer.byteLength(encoded)}:`).update(encoded);
  };
  for (const { name } of tables) {
    const columns = database.prepare(`PRAGMA main.table_info(${quote(name)})`).all() as Array<{ name: string; type: string; pk: number | bigint }>;
    put([name, columns.map((column) => [column.name, column.type])]);
    const primary = columns.filter((column) => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk));
    const order = (primary.length ? primary : columns).map((column) => `t.${quote(column.name)}`).join(',');
    const fields = columns.map((column) => name === 'process' && column.name === 'status'
      ? `CASE WHEN t.id IN (SELECT p.id FROM process AS p WHERE ${RESTORE_UNKNOWN}) THEN 'outcome_unknown' ELSE t.status END`
      : `t.${quote(column.name)}`).join(',');
    const filter = name === 'operation' ? ` WHERE t.id NOT IN (SELECT o.id FROM operation AS o WHERE ${ORPHAN})`
      : name === 'attempt' ? ` WHERE t.operation_id NOT IN (SELECT o.id FROM operation AS o WHERE ${ORPHAN})`
        : name === 'command_receipt' && markerKey ? ' WHERE NOT (t.source_kind = \'internal\' AND t.source_key = ?)' : '';
    const statement = database.prepare(`SELECT ${fields} FROM main.${quote(name)} AS t${filter} ORDER BY ${order}`).raw(true).safeIntegers(true);
    const parameters = name === 'command_receipt' && markerKey ? [markerKey] : [];
    for (const row of statement.iterate(...parameters)) put(row);
  }
  return hash.digest('hex');
}

/** Only called inside the maintenance writer's checked transaction. All predicates are fixed. */
export function applyHistoryRepairRows(database: Database.Database): { operations: number; processes: number } {
  const operations = Number(prepareCached(database, `DELETE FROM operation WHERE id IN (SELECT o.id FROM operation AS o WHERE ${ORPHAN})`).run().changes);
  const processes = Number(prepareCached(database, `UPDATE process SET status = 'outcome_unknown'
    WHERE id IN (SELECT p.id FROM process AS p WHERE ${RESTORE_UNKNOWN})`).run().changes);
  return { operations, processes };
}

function quote(value: string): string { return `"${value.replace(/"/g, '""')}"`; }
