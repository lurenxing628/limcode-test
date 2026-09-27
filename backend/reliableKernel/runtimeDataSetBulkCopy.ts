import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { isPathBelow } from '../capabilities/filesystem/pathContainment';
import { RUNTIME_KERNEL_EPOCH } from './contracts';
import { DOMAIN_REPOSITORIES, schemaForDomain, type RepositoryTransactionStep } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';
import {
  isRuntimeDataSetMigrationSourceUnchanged, openRuntimeDataSetMigrationSource, runtimeDataSetCopyRow, runtimeDataSetMergeFailure,
  RuntimeDataSetMergeError, RUNTIME_DATA_SET_INSERT_ORDER, RUNTIME_DATA_SET_READ_CHUNK, transferRuntimeDataSetMigrationCas,
  type RuntimeDataSetCasTransfer, type RuntimeDataSetCasVerification, type RuntimeDataSetMigrationSource
} from './runtimeDataSetMerge';
import { assertRuntimeHostsOffline, isRuntimeDataRootAdmissionHeld, withRuntimeMaintenance } from './runtimeHostControl';
import { toSqliteFilePath } from './sqliteFilePath';
import { createVscodeRootAuthority } from './vscodeRootAuthority';

/**
 * Whole-data-set copy into an empty Runtime root that nobody can see yet (data-root migration: the
 * new directory before its completion record and the pointer switch). The source is read from its
 * verified private snapshot, in pages, and written through ordinary RuntimeDatabase write
 * transactions of codec-decoded Repository insert steps (historical copies for the started or
 * finished model-stream rows), exactly as a migration merge does, but in several transactions so
 * that memory depends on the batch size, not on the data set.
 *
 * Batches. The insert sequence is the one of a single-transaction copy: the manifest order (a
 * domain after every table it references) and rowid order within a domain, so every immediate
 * foreign key finds its row in an earlier or the same transaction. Only what a single transaction
 * checks across rows at its end then needs care, and each such coupling is handled explicitly:
 * - the worker checks a ModelRequest with its one Operation, that Operation's Attempts and its
 *   fence at the end of every transaction touching one of them (historical stream rows even need
 *   their request in the same transaction): one unit, emitted at the Operation's position;
 * - the commit's client projection of a CollaborationMessage requires its one payload link: one
 *   unit, emitted at the message's position;
 * - the commit's client projection of an active Turn follows an admitted retry intent to the source
 *   Message's membership, much later in the order: no transaction holds a Turn and a TurnIntent.
 * Every table a moved row references is ordered before its anchor (checked when this module loads),
 * and Turn or termination rows only ask the worker to check requests already present, which are
 * complete units. Consecutive units fill a batch of about `batchRows` rows; a unit is never split,
 * and a unit larger than a batch is a transaction of its own. Grouping by foreign-key connected
 * components was not used: a Conversation tree joined by child executions, collaboration messages
 * and forks would be one component of most of a real data set.
 *
 * Afterwards every domain's ids are compared in id order, streamed, between the source snapshot and
 * a Backup API copy of the target: every source id exists and the counts are equal.
 */

/**
 * Rows per transaction unless one unit is larger. Measured on a 286k-row data set: 1,000 rows keep
 * the extension host at about 530 MiB peak RSS (2,000: about 620 MiB) at the same total time.
 */
export const RUNTIME_DATA_SET_COPY_BATCH_ROWS = 1_000;

export interface RuntimeDataSetCopyTarget {
  /**
   * Configuration root of the target. The caller holds its configuration admission for the whole
   * call (no Host can register under it meanwhile) and must not have published it anywhere yet.
   */
  configurationRootPath: string;
  /** A freshly initialized Runtime data root below that configuration root (initializeEmptyRuntimeRoot). */
  runtimeDataRootPath: string;
}

export type RuntimeDataSetCopyFaultPoint = 'after-cas-transfer' | 'after-batch';

export interface RuntimeDataSetCopyBatch {
  index: number;
  rows: number;
  steps: number;
  /** Source queries this batch needed (pages and aggregate lookups). */
  reads: number;
  /** Rows of the largest unit in this batch (a ModelRequest aggregate or one row). */
  largestUnitRows: number;
  /** Main-thread time spent reading and decoding this batch (overlaps the previous transaction). */
  buildMs: number;
  /** Wall time of the RuntimeDatabase transaction call. */
  transactionMs: number;
}

export interface RuntimeDataSetCopyOptions {
  /** Defaults to {@link RUNTIME_DATA_SET_COPY_BATCH_ROWS}. */
  batchRows?: number;
  /** Defaults to fs.link; a cross-device or unsupported link falls back to a verified copy. */
  linkFile?(source: string, target: string): Promise<void>;
  /**
   * File identities of CAS objects verified earlier (the online pre-copy's `verification`, or a
   * previous receipt's): unchanged ones are not hashed again. Extended in place and returned.
   */
  casVerification?: RuntimeDataSetCasVerification;
  /** Stops before the next CAS object or batch; the caller then discards the target. */
  signal?: AbortSignal;
  onBatch?(batch: RuntimeDataSetCopyBatch): void;
  /** Test-only failure injection at durable boundaries. */
  onFaultPoint?(point: RuntimeDataSetCopyFaultPoint, batch?: number): void | Promise<void>;
  /** Passed to the target RuntimeDatabase (write-lock measurements). */
  performanceMetrics?: NonNullable<Parameters<typeof RuntimeDatabase.open>[1]>['performanceMetrics'];
}

export interface RuntimeDataSetCopyReceipt {
  candidateId: string;
  /** The copied source state; {@link isRuntimeDataSetCopyCurrent} compares against it. */
  source: { dataSetId: string; rootInstanceId: string; rootGeneration: number; pointerRevision: number; files: string };
  target: RuntimeDataSetCopyTarget & { dataSetId: string; rootInstanceId: string };
  rows: number;
  rowsByDomain: Record<string, number>;
  insertedConversations: number;
  cas: RuntimeDataSetCasTransfer;
  casVerification: RuntimeDataSetCasVerification;
  batches: {
    count: number; maxRows: number; maxSteps: number; maxReads: number; largestUnitRows: number;
    /** Source queries of the whole copy (the sum over every batch). */
    reads: number;
  };
  upgradedFromEpoch?: 3 | 4;
}

/**
 * Rows that must commit together with an earlier row (their anchor), so they are read with it and
 * emitted at its position:
 * - a ModelRequest aggregate, anchored at its Operation: the worker checks it at the end of every
 *   transaction touching it, and historical stream rows need their request in the same transaction;
 * - a CollaborationMessage and its payload link: the commit's client projection of the message
 *   requires exactly one payload.
 */
interface UnitRule {
  anchor: string;
  applies(raw: Record<string, unknown>): boolean;
  members: ReadonlyArray<{ domain: string; column: string; key(raw: Record<string, unknown>): unknown }>;
  /** Selects the member domain's rows that belong to no anchor (read in their own position). */
  orphans: ReadonlyMap<string, string>;
}

const UNIT_RULES: readonly UnitRule[] = [
  {
    anchor: 'Operation',
    applies: (raw) => raw.owner_kind === 'model_request',
    members: [
      { domain: 'Attempt', column: 'operation_id', key: (raw) => raw.id },
      { domain: 'ModelRequest', column: 'id', key: (raw) => raw.owner_id },
      { domain: 'ModelStreamCheckpoint', column: 'model_request_id', key: (raw) => raw.owner_id },
      { domain: 'ModelStreamFence', column: 'model_request_id', key: (raw) => raw.owner_id }
    ],
    orphans: new Map([
      ['Attempt', "NOT EXISTS (SELECT 1 FROM operation AS o WHERE o.id = t.operation_id AND o.owner_kind = 'model_request')"],
      ['ModelRequest', "NOT EXISTS (SELECT 1 FROM operation AS o WHERE o.owner_kind = 'model_request' AND o.owner_id = t.id)"],
      ['ModelStreamCheckpoint', "NOT EXISTS (SELECT 1 FROM operation AS o WHERE o.owner_kind = 'model_request' AND o.owner_id = t.model_request_id)"],
      ['ModelStreamFence', "NOT EXISTS (SELECT 1 FROM operation AS o WHERE o.owner_kind = 'model_request' AND o.owner_id = t.model_request_id)"]
    ])
  },
  {
    anchor: 'CollaborationMessage',
    applies: () => true,
    members: [{ domain: 'CollaborationMessagePayloadLink', column: 'message_id', key: (raw) => raw.id }],
    orphans: new Map([
      ['CollaborationMessagePayloadLink', 'NOT EXISTS (SELECT 1 FROM collaboration_message AS m WHERE m.id = t.message_id)']
    ])
  }
];

/**
 * A batch ends before the first row of these domains. The commit's client projection of an active
 * Turn follows its admitted retry intent to the source Message's membership, which comes much later
 * in the order; with no TurnIntent in a Turn's transaction the projection has nothing to follow.
 */
const BATCH_BOUNDARY_BEFORE: ReadonlySet<string> = new Set(['TurnIntent']);

// A unit is emitted at its anchor's position: every table a member references (other than the
// unit's own tables) must be ordered before the anchor, or a moved row would precede its reference.
(() => {
  const position = new Map(RUNTIME_DATA_SET_INSERT_ORDER.map((domain, index) => [schemaForDomain(domain).table, index]));
  for (const rule of UNIT_RULES) {
    const unitTables = new Set([rule.anchor, ...rule.members.map((member) => member.domain)].map((domain) => schemaForDomain(domain).table));
    const anchor = position.get(schemaForDomain(rule.anchor).table)!;
    for (const { domain } of rule.members) {
      if (!(position.get(schemaForDomain(domain).table)! > anchor)) throw new Error(`${domain} is not ordered after its unit anchor ${rule.anchor}.`);
      for (const column of schemaForDomain(domain).columns) {
        const table = column.references?.table;
        if (table !== undefined && !unitTables.has(table) && !(position.get(table)! < anchor)) {
          throw new Error(`${domain}.${column.name} references ${table}, which is not ordered before ${rule.anchor}; the copy cannot keep that unit whole.`);
        }
      }
    }
  }
  for (const domain of BATCH_BOUNDARY_BEFORE) schemaForDomain(domain);
})();

/**
 * Copies one complete data set of the configuration root `paths` into an empty target root, in
 * several transactions. Preconditions, all checked: the caller holds the target configuration
 * root's admission (so the target is not visible to any Host while partially written); the target
 * is under another configuration root than the source; no Host runs on the target, which is taken
 * under its maintenance claim, has the current epoch and holds no row at all; the source is offline
 * and passes every migration check (see openRuntimeDataSetMigrationSource); after the copy the
 * source is still exactly the copied state. Any failure leaves a partially written target: the
 * caller discards the whole target root (nothing referenced it yet). Throws RuntimeDataSetMergeError
 * for refusals, AbortError for a cancellation.
 */
export async function copyRuntimeDataSetIntoEmptyRoot(
  paths: { globalStoragePath: string },
  input: { candidateId: string; expectedDataSetId: string; expectedRootInstanceId: string },
  target: RuntimeDataSetCopyTarget,
  options: RuntimeDataSetCopyOptions = {}
): Promise<RuntimeDataSetCopyReceipt> {
  const sourcePaths = { globalStoragePath: path.resolve(paths.globalStoragePath) };
  const targetPlacement = {
    configurationRootPath: path.resolve(target.configurationRootPath),
    runtimeDataRootPath: path.resolve(target.runtimeDataRootPath)
  };
  const batchRows = options.batchRows ?? RUNTIME_DATA_SET_COPY_BATCH_ROWS;
  if (!Number.isSafeInteger(batchRows) || batchRows < 1) throw new RangeError('batchRows must be a positive integer.');
  if (!isRuntimeDataRootAdmissionHeld(targetPlacement.configurationRootPath)) {
    throw new RuntimeDataSetMergeError('runtime-data-set-copy-target-visible', '复制目标所在的数据目录没有被本次操作独占（必须持有它的配置根准入），不能分批写入。');
  }
  if (comparable(targetPlacement.configurationRootPath) === comparable(sourcePaths.globalStoragePath)
    || !isPathBelow(targetPlacement.configurationRootPath, targetPlacement.runtimeDataRootPath)) {
    throw new RuntimeDataSetMergeError('runtime-data-set-copy-target-invalid', '复制目标必须是另一个数据目录下的历史库。');
  }
  const authority = createVscodeRootAuthority(targetPlacement);
  return withRuntimeMaintenance(authority.expectedPaths(), async () => {
    await assertRuntimeHostsOffline(authority.expectedPaths());
    const database = await RuntimeDatabase.open(authority, {
      hostBootId: `data-set-copy-${randomUUID()}`,
      ...(options.performanceMetrics ? { performanceMetrics: options.performanceMetrics } : {})
    });
    let source: RuntimeDataSetMigrationSource | undefined;
    try {
      await assertEmptyTarget(database);
      source = await openRuntimeDataSetMigrationSource(sourcePaths, input,
        { dataSetId: database.binding.dataSetId, rootInstanceId: database.binding.rootInstanceId });
      options.signal?.throwIfAborted();
      const casVerification = options.casVerification ?? new Map<string, string>();
      const cas = await transferRuntimeDataSetMigrationCas(source, {
        configurationRootPath: targetPlacement.configurationRootPath, binding: database.binding
      }, { ...(options.linkFile ? { linkFile: options.linkFile } : {}), ...(options.signal ? { signal: options.signal } : {}), verified: casVerification });
      await options.onFaultPoint?.('after-cas-transfer');
      const batches = await writeBatches(source.database, database, batchRows, options);
      const rowsByDomain = await verifyCopy(source.database, database);
      const copied = Object.values(rowsByDomain).reduce((sum, count) => sum + count, 0);
      const receipt: RuntimeDataSetCopyReceipt = {
        candidateId: source.candidate.id,
        source: {
          dataSetId: source.binding.dataSetId, rootInstanceId: source.binding.rootInstanceId,
          rootGeneration: source.binding.rootGeneration, pointerRevision: source.binding.pointerRevision, files: source.files
        },
        target: { ...targetPlacement, dataSetId: database.binding.dataSetId, rootInstanceId: database.binding.rootInstanceId },
        rows: copied, rowsByDomain, insertedConversations: rowsByDomain.Conversation ?? 0, cas, casVerification, batches,
        ...(source.upgradedFromEpoch !== undefined ? { upgradedFromEpoch: source.upgradedFromEpoch } : {})
      };
      await database.close();
      if (!await isRuntimeDataSetCopyCurrent(sourcePaths, receipt)) {
        throw new RuntimeDataSetMergeError('runtime-data-set-merge-source-changed', '来源历史库在复制期间有变化，本次复制作废。');
      }
      return receipt;
    } catch (error) {
      throw runtimeDataSetMergeFailure(error, source ?? {});
    } finally {
      await database.close();
      await source?.close();
    }
  });
}

/**
 * True while the copied source is unchanged: same identity, root generation, pointer revision and
 * exact SQLite file state, with no Host on it (checked under its admission and maintenance claim).
 * Used in the exclusive phase for a data set copied while every window kept working.
 */
export function isRuntimeDataSetCopyCurrent(
  paths: { globalStoragePath: string },
  receipt: Pick<RuntimeDataSetCopyReceipt, 'candidateId' | 'source'>
): Promise<boolean> {
  return isRuntimeDataSetMigrationSourceUnchanged({ globalStoragePath: path.resolve(paths.globalStoragePath) },
    { candidateId: receipt.candidateId, ...receipt.source });
}

/**
 * Keeps an earlier copy when its source is unchanged; otherwise `resetTarget` discards the target
 * root and re-initializes it empty, and the source is copied again (still-valid CAS verifications
 * of the earlier copy are reused). Same preconditions as {@link copyRuntimeDataSetIntoEmptyRoot}.
 */
export async function ensureRuntimeDataSetCopyCurrent(
  paths: { globalStoragePath: string },
  receipt: RuntimeDataSetCopyReceipt,
  resetTarget: () => Promise<void>,
  options: RuntimeDataSetCopyOptions = {}
): Promise<{ receipt: RuntimeDataSetCopyReceipt; recopied: boolean }> {
  if (await isRuntimeDataSetCopyCurrent(paths, receipt)) return { receipt, recopied: false };
  await resetTarget();
  const copied = await copyRuntimeDataSetIntoEmptyRoot(paths, {
    candidateId: receipt.candidateId, expectedDataSetId: receipt.source.dataSetId, expectedRootInstanceId: receipt.source.rootInstanceId
  }, { configurationRootPath: receipt.target.configurationRootPath, runtimeDataRootPath: receipt.target.runtimeDataRootPath },
  { ...options, casVerification: options.casVerification ?? receipt.casVerification });
  return { receipt: copied, recopied: true };
}

async function assertEmptyTarget(database: RuntimeDatabase): Promise<void> {
  if (database.binding.runtimeKernelEpoch !== RUNTIME_KERNEL_EPOCH) {
    throw new RuntimeDataSetMergeError('runtime-data-set-copy-target-invalid', '复制目标不是当前格式的历史库。');
  }
  const reads = RUNTIME_DATA_SET_INSERT_ORDER.map((domain) => DOMAIN_REPOSITORIES.domain(domain).list({ limit: 1 }));
  const found = (await database.snapshot(reads)).snapshot as unknown[][];
  const occupied = RUNTIME_DATA_SET_INSERT_ORDER.filter((_, index) => found[index].length > 0);
  if (occupied.length > 0) {
    throw new RuntimeDataSetMergeError('runtime-data-set-copy-target-not-empty', `复制目标不是空库（已有 ${occupied.join('、')} 记录），不能整库复制进去。`);
  }
}

type Unit = Array<{ domain: string; raw: Record<string, unknown> }>;

/** Source units in insert order, read in rowid pages; `reads` counts every query. */
async function* sourceUnits(source: Database.Database, counter: { reads: number }): AsyncGenerator<Unit> {
  const read = <T>(run: () => T): T => {
    counter.reads += 1;
    return run();
  };
  const anchored = new Map(UNIT_RULES.map((rule) => [rule.anchor, {
    rule,
    members: rule.members.map((member) => ({
      ...member,
      statement: source.prepare(`SELECT * FROM "${schemaForDomain(member.domain).table}" WHERE "${member.column}" = ? ORDER BY rowid`)
    }))
  }]));
  const orphans = new Map(UNIT_RULES.flatMap((rule) => [...rule.orphans]));
  for (const domain of RUNTIME_DATA_SET_INSERT_ORDER) {
    const filter = orphans.get(domain);
    const units = anchored.get(domain);
    const page = source.prepare(`SELECT t.rowid AS "__copy_position", t.* FROM "${schemaForDomain(domain).table}" AS t
      WHERE t.rowid > ?${filter ? ` AND ${filter}` : ''} ORDER BY t.rowid LIMIT ${RUNTIME_DATA_SET_READ_CHUNK}`);
    for (let after = 0n; ;) {
      const rows = read(() => page.all(after)) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;
      after = rows[rows.length - 1].__copy_position as bigint;
      for (const raw of rows) {
        const unit: Unit = [{ domain, raw }];
        if (units?.rule.applies(raw)) {
          for (const member of units.members) {
            for (const row of read(() => member.statement.all(member.key(raw))) as Array<Record<string, unknown>>) {
              unit.push({ domain: member.domain, raw: row });
            }
          }
        }
        yield unit;
      }
      // Decoding stays on this thread; yield between pages so a large source never monopolizes it.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
}

/**
 * Builds the next batch while the previous transaction runs in the worker: at most two batches
 * exist at a time. A failed transaction stops the copy at the next batch boundary.
 */
async function writeBatches(
  source: Database.Database,
  database: RuntimeDatabase,
  batchRows: number,
  options: RuntimeDataSetCopyOptions
): Promise<RuntimeDataSetCopyReceipt['batches']> {
  const summary = { count: 0, maxRows: 0, maxSteps: 0, maxReads: 0, largestUnitRows: 0, reads: 0 };
  const counter = { reads: 0 };
  let steps: RepositoryTransactionStep[] = [];
  let rows = 0;
  let largestUnit = 0;
  let readsBefore = 0;
  let buildMs = 0;
  let inFlight: Promise<void> | undefined;
  let failure: { error: unknown } | undefined;
  const settle = async (): Promise<void> => {
    if (inFlight) await inFlight;
    inFlight = undefined;
    if (failure) throw failure.error;
  };
  const flush = async (): Promise<void> => {
    if (steps.length === 0) return;
    const batch: RuntimeDataSetCopyBatch = {
      index: summary.count, rows, steps: steps.length, reads: counter.reads - readsBefore, largestUnitRows: largestUnit,
      buildMs: Math.round(buildMs), transactionMs: 0
    };
    const transaction = steps;
    steps = [];
    rows = 0;
    largestUnit = 0;
    buildMs = 0;
    readsBefore = counter.reads;
    await settle();
    options.signal?.throwIfAborted();
    summary.count += 1;
    summary.maxRows = Math.max(summary.maxRows, batch.rows);
    summary.maxSteps = Math.max(summary.maxSteps, batch.steps);
    summary.maxReads = Math.max(summary.maxReads, batch.reads);
    summary.largestUnitRows = Math.max(summary.largestUnitRows, batch.largestUnitRows);
    const started = performance.now();
    inFlight = database.transaction(transaction).then(async () => {
      batch.transactionMs = performance.now() - started;
      options.onBatch?.(batch);
      await options.onFaultPoint?.('after-batch', batch.index);
    }).catch((error: unknown) => {
      failure ??= { error };
    });
  };
  let previousDomain: string | undefined;
  const units = sourceUnits(source, counter);
  for (;;) {
    let started = performance.now();
    const next = await units.next();
    if (next.done || failure) break;
    const unit = next.value;
    const domain = unit[0].domain;
    if ((rows > 0 && rows + unit.length > batchRows) || (domain !== previousDomain && BATCH_BOUNDARY_BEFORE.has(domain))) {
      buildMs += performance.now() - started;
      await flush();
      started = performance.now();
    }
    previousDomain = domain;
    for (const { domain: rowDomain, raw } of unit) steps.push(runtimeDataSetCopyRow(rowDomain, raw).step);
    rows += unit.length;
    largestUnit = Math.max(largestUnit, unit.length);
    buildMs += performance.now() - started;
    if (rows >= batchRows) await flush();
  }
  await units.return(undefined);
  await flush();
  await settle();
  summary.reads = counter.reads;
  return summary;
}

/**
 * Every domain's ids, in id order and streamed, on the source snapshot and on a Backup API copy of
 * the target (a private file of the target's control root, removed afterwards): equal sequences.
 */
async function verifyCopy(source: Database.Database, database: RuntimeDatabase): Promise<Record<string, number>> {
  const copyPath = path.join(path.dirname(path.resolve(database.binding.paths.dataRootPath)), `copy-verify-${randomUUID()}.sqlite`);
  const counts: Record<string, number> = {};
  try {
    await database.backupTo(copyPath);
    const copy = new Database(toSqliteFilePath(copyPath), { readonly: true, fileMustExist: true });
    try {
      for (const domain of RUNTIME_DATA_SET_INSERT_ORDER) {
        const sql = `SELECT id FROM "${schemaForDomain(domain).table}" ORDER BY id`;
        const expected = source.prepare(sql).pluck().iterate() as IterableIterator<string>;
        const actual = copy.prepare(sql).pluck().iterate() as IterableIterator<string>;
        let count = 0;
        try {
          for (;;) {
            const left = expected.next();
            const right = actual.next();
            if (left.done || right.done || left.value !== right.value) {
              if (left.done && right.done) break;
              throw new RuntimeDataSetMergeError('runtime-data-set-copy-verification-failed',
                `复制后的核对未通过：${domain} 的记录${left.done ? '多出' : '缺少'} ${left.done ? right.value : left.value}。`);
            }
            count += 1;
            if (count % 1_000 === 0) await new Promise((resolve) => setImmediate(resolve));
          }
        } finally {
          expected.return?.();
          actual.return?.();
        }
        if (count > 0) counts[domain] = count;
      }
    } finally {
      copy.close();
    }
  } finally {
    await Promise.all(['', '-wal', '-shm', '-journal'].map((suffix) => fs.rm(`${copyPath}${suffix}`, { force: true }).catch(() => undefined)));
  }
  return counts;
}

function comparable(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved;
}
