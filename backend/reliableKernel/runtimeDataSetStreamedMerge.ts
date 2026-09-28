import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ResourceLimits } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import type { HistoricalRootBinding } from './rootAuthority';
import { RuntimeDatabase } from './runtimeDatabase';
import {
  HISTORICAL_MERGE_ENGINE as engine, planMergeChunk, RuntimeDataSetMergeEvidence, RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS,
  type ForeignHistoricalMergeCandidate, type ForeignHistoricalMergeHold, type HistoricalMergeCandidate,
  type HistoricalMergePickedSource, type HistoricalMergeRowPlan, type HistoricalMergeSourceMode, type HistoricalMergeSourceOutcome, type HistoricalMergeSourceProgress,
  type HistoricalMergeTargetContext, type RuntimeDataSetCasTransfer, type RuntimeDataSetCasVerification,
  type RuntimeDataSetMergeBatchResult, type RuntimeDataSetMergeChunkSink, type RuntimeDataSetMergeFaultPoint,
  type RuntimeDataSetMergeIssue, type RuntimeDataSetMergeOptions, type RuntimeDataSetMergeResult
} from './runtimeDataSetMerge';
import { runtimeDataSetFileState } from './runtimeDataSetFacts';
import { withLocatedRuntimeRootFence } from './runtimeForeignHistory';
import { holdForeignHistoricalMergeSource } from './runtimeForeignHistoryMerge';
import { locateLocalRuntimeDataSet, type LocatedRuntimeRoot } from './runtimeLocatedRoot';
import {
  readRuntimeDataSetMergeFinalization, readRuntimeDataSetMergeLedger, readRuntimeDataSetMergePreparation, removeRuntimeDataSetMergeCommit,
  removeRuntimeDataSetMergePreparation, removeRuntimeDataSetMergeRequest, sameRuntimeDataSetFingerprint, sameRuntimeDataSetIdentity,
  isRuntimeDataSetMergePreparationLive, pruneRuntimeDataSetMergePreparations, RUNTIME_DATA_SET_MERGE_PREPARATION_STALE_MS,
  writeRuntimeDataSetMergeCommit, writeRuntimeDataSetMergeLedgerRecord, writeRuntimeDataSetMergePreparation,
  pruneRuntimeDataSetMergeCommits,
  type RuntimeDataSetFingerprint, type RuntimeDataSetIdentity
} from './runtimeDataSetMergeLedger';
import { describeUnfinishedWork, hasFinalizableWork } from './runtimeDataSetMergeWork';
import { isRuntimeDataRootAdmissionHeld, isRuntimeMaintenanceHeld, withRuntimeDataRootAdmission } from './runtimeHostControl';
import {
  createLocatedRuntimeDatabaseSnapshot, requireCompleteRuntimeDataSet, type RuntimeDataSetDatabaseSnapshot
} from './runtimeStorageInspection';
import { RUNTIME_DOMAIN_SCHEMAS } from './schema/domainManifest';
import { createVscodeRootAuthority, inspectVscodeRuntimeDataSets, resolveVscodeRuntimeDataSet } from './vscodeRootAuthority';

/**
 * Large-merge session: historical data sets above the in-memory transaction bound
 * (RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS) are merged while every window of the target is paused,
 * each source in ONE streamed maintenance transaction of a private RuntimeDatabase (atomic: any
 * version, any installation only ever sees the source unmerged or merged).
 *
 * 1. prepareLargeMergeSources, online and without any claim held for long (every window keeps
 *    working): the sources are picked as a batch picks them; per source a private snapshot audited in
 *    a worker, the unfinished-work probes, a streamed scan against the open target (counts, at most 20
 *    conflict samples, time), finalization when needed (as an online merge does it, then snapshot,
 *    audit and scan again), the CAS objects published with their verified file identities kept, and
 *    one online Backup API copy of the target. Only one window prepares a source at a time
 *    (`preparing/<id>.json`, heartbeat, taken over when stale).
 * 2. Coordination, closing the window's Runtime and reloading afterwards belong to the caller.
 * 3. runLargeMergeSession, inside the caller's configuration admission and target maintenance claim
 *    with this process's target Runtime closed: the selected data set is opened privately
 *    (`historical-merge-<uuid>`, maintenance: true); per source under its maintenance claim the source
 *    is checked unchanged, copied privately again (the audit's conclusions hold for the same file
 *    state), CAS objects are only lstat'ed, the ledger is read again, the committing record written,
 *    then the source is streamed in chunks of RUNTIME_DATA_SET_STREAMED_MERGE_CHUNK_ROWS rows in
 *    MERGE_DOMAIN_ORDER and rowid order with exactly the row rules of an online merge (planMergeChunk:
 *    content identities in savepoints, renumbered columns allocated in the transaction, historical
 *    copies, the rows of conversations deleted here since an earlier merge left out) and each chunk's
 *    presence assertions; its bounded commit evidence is completed right before the durable commit,
 *    the WAL is checkpointed (TRUNCATE), and only then is the source recorded as merged. A cancellation
 *    or a full disk rolls back the current source only; the sources merged before it stay.
 */

/** Source rows compared and appended per chunk (streamed merge and online scan). */
export const RUNTIME_DATA_SET_STREAMED_MERGE_CHUNK_ROWS: number = engine.READ_CHUNK;
const PREPARATION_HEARTBEAT_MS = 10_000;
export { RUNTIME_DATA_SET_MERGE_PREPARATION_STALE_MS };
/** The estimated exclusive time is shown as this range of the estimate. */
export const RUNTIME_DATA_SET_LARGE_MERGE_ESTIMATE_RANGE = Object.freeze({ low: 0.8, high: 1.6 });
/** WAL of one streamed source until its TRUNCATE checkpoint, relative to the source database. */
const WAL_PEAK_FACTOR = 1.5;
/** A streamed merge also inserts: its per-row time relative to the online scan's. */
const SESSION_ROW_COST_FACTOR = 1.4;
/** lstat of a CAS object that was verified online. */
const CAS_OBJECT_MS = 0.03;
const SKIP_TABLE = 'limcode_merge_skip';
/**
 * Page cache of a source snapshot's connection, in KiB, for its main and TEMP databases (SQLite's
 * default here is 16 MiB each): its rows are read once, in order, so the cache does not grow with it.
 */
const SOURCE_PAGE_CACHE_KIB = 2048;

export type LargeMergeFaultPoint =
  | RuntimeDataSetMergeFaultPoint
  /** Session: before a source is started (detail.index). */
  | 'before-source'
  /** Session: the committing record and its (empty) evidence are written. */
  | 'after-committing'
  /** Session: a chunk was appended to the maintenance transaction (detail.chunk, 0-based). */
  | 'after-chunk'
  /** Session: every chunk is appended, the evidence not yet completed. */
  | 'after-last-chunk'
  /** Session: the evidence is complete, the transaction not committed. */
  | 'before-commit'
  /** Session: committed durably, the WAL not yet checkpointed. */
  | 'after-commit'
  /** Session: checkpointed (TRUNCATE), the merged record not yet written. */
  | 'before-merged-record';

export interface LargeMergeFaultDetail {
  candidateId?: string;
  index?: number;
  chunk?: number;
}

/** Test-only knobs besides the online merge's (freeSpace, linkFile, sizeLimits, onFaultPoint). */
export interface LargeMergeEngineOptions extends Omit<RuntimeDataSetMergeOptions, 'onFaultPoint'> {
  /** Rows per chunk; defaults to {@link RUNTIME_DATA_SET_STREAMED_MERGE_CHUNK_ROWS}. */
  chunkRows?: number;
  onFaultPoint?(point: LargeMergeFaultPoint, detail?: LargeMergeFaultDetail): void | Promise<void>;
  /** Heap limits of the private maintenance worker. */
  workerResourceLimits?: ResourceLimits;
}

// ---------------------------------------------------------------------------------------------
// Sources: located roots (I/O at `located`, identity fenced by `recorded`).
// ---------------------------------------------------------------------------------------------

/**
 * How a session finds and fences one source, as a LocatedRuntimeRoot: its `located` paths serve every
 * copy, file state, claim and CAS read, its `recorded` binding only as the identity fence. The session
 * holds the root's fence around its check, copy and transaction: a local data set's maintenance claim,
 * or a foreign history root's claim, which its preparation took and holds until the session released
 * it (runtimeForeignHistoryMerge); nothing is ever claimed inside a foreign directory.
 */
export interface HistoricalMergeSourceResolver {
  /** The source located again from where it was found; throws when it is gone or no complete data set. */
  locate(candidateId: string): Promise<LocatedRuntimeRoot>;
  /** Runs `operation` under the root's fence (never takes a foreign root's claim anew: its hold has it). */
  fence<T>(root: LocatedRuntimeRoot, operation: () => Promise<T>): Promise<T>;
  /** The source as the engine steps take it (a local candidate, or the foreign root its hold verified). */
  candidate(root: LocatedRuntimeRoot): Promise<HistoricalMergeCandidate>;
  /**
   * Inside the configuration admission and the root's fence: no Host uses the source and it is exactly
   * the audited state (recorded identity, root generation, pointer revision, epoch manifest, file state
   * at `located`). Throws the merge refusal otherwise.
   */
  assertUnchanged(root: LocatedRuntimeRoot, check: SourceCheck): Promise<void>;
  /** A private copy of the source's database, fenced by its recorded binding. */
  snapshot(root: LocatedRuntimeRoot): Promise<RuntimeDataSetDatabaseSnapshot>;
}

interface SourceCheck {
  paths: { globalStoragePath: string };
  target: HistoricalMergeTargetContext;
  state: HistoricalMergeSourceProgress;
  mode: HistoricalMergeSourceMode;
}

/** The unselected data sets of one configuration root (workspace scopes and the fixed root). */
export function localHistoricalMergeSources(paths: { globalStoragePath: string }): HistoricalMergeSourceResolver {
  const storagePaths = { globalStoragePath: path.resolve(paths.globalStoragePath) };
  return {
    locate: (candidateId) => locateLocalRuntimeDataSet(storagePaths, candidateId),
    fence: (root, operation) => withLocatedRuntimeRootFence(storagePaths, root, operation),
    candidate: (root) => resolveVscodeRuntimeDataSet(storagePaths, root.id),
    async assertUnchanged(root, check) {
      const candidate = await resolveVscodeRuntimeDataSet(storagePaths, root.id);
      await engine.assertSourceUnchanged(check.paths, check.target, candidate, locatedBinding(root), check.state, check.mode);
    },
    snapshot: (root) => createLocatedRuntimeDatabaseSnapshot(root)
  };
}

/**
 * Local data sets, and the foreign history roots whose claims a preparation holds (`held`). A foreign
 * root is only ever read through its hold, and checked against the root its preparation verified:
 * still the same place, records and exact file state.
 */
export function historicalMergeSources(
  paths: { globalStoragePath: string },
  held: (candidateId: string) => ForeignHistoricalMergeHold | undefined
): HistoricalMergeSourceResolver {
  const local = localHistoricalMergeSources(paths);
  const verified = (root: LocatedRuntimeRoot): { hold: ForeignHistoricalMergeHold; candidate: ForeignHistoricalMergeCandidate } => {
    const hold = held(root.id);
    if (!hold?.verified) {
      throw new engine.Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-source-changed', message: '这个外来历史库的准备已不在，本次不合并。' });
    }
    return { hold, candidate: hold.verified };
  };
  return {
    async locate(candidateId) {
      const hold = held(candidateId);
      return hold ? (await hold.locate()).root : local.locate(candidateId);
    },
    fence: (root, operation) => root.origin.kind === 'foreign' ? verified(root).hold.fence(operation) : local.fence(root, operation),
    candidate: async (root) => root.origin.kind === 'foreign' ? verified(root).candidate : local.candidate(root),
    async assertUnchanged(root, check) {
      if (root.origin.kind !== 'foreign') return local.assertUnchanged(root, check);
      const { candidate } = verified(root);
      await engine.assertSourceUnchanged(check.paths, check.target, candidate, engine.foreignBinding(candidate), check.state, check.mode);
    },
    snapshot: (root) => {
      if (root.origin.kind !== 'foreign') return local.snapshot(root);
      const { hold, candidate } = verified(root);
      return hold.snapshot(candidate);
    }
  };
}

/** The recorded identity with the located paths: what the shared engine helpers read and fence with. */
function locatedBinding(root: LocatedRuntimeRoot): HistoricalRootBinding {
  return { ...root.recorded, paths: root.located };
}

// ---------------------------------------------------------------------------------------------
// Rows left out (conversations deleted here since an earlier merge), without per-row memory.
// ---------------------------------------------------------------------------------------------

/**
 * Leaves out what belongs to the conversations an earlier merge of this source inserted here and the
 * user deleted since: the same closure as the online merge's skippedRows (foreign keys, SKIPPED_WITH,
 * SKIPPED_WITH_MEMBERS, to a fixed point, content identities never), computed in a TEMP table of the
 * private snapshot connection instead of in memory. True when rows are left out (see skipWhere).
 */
async function prepareSkippedRows(
  source: Database.Database,
  target: RuntimeDatabase,
  merged: readonly string[],
  state: HistoricalMergeSourceProgress
): Promise<boolean> {
  const deleted = merged.length > 0 ? await engine.deletedSinceMerge(source, target, merged) : undefined;
  state.skippedConversations = deleted?.count ?? 0;
  withTemporaryWrites(source, () => source.exec(`DROP TABLE IF EXISTS temp.${SKIP_TABLE}`));
  if (!deleted) return false;
  withTemporaryWrites(source, () => {
    source.exec(`CREATE TEMP TABLE ${SKIP_TABLE} (domain TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (domain, id)) WITHOUT ROWID`);
    const seed = source.prepare(`INSERT OR IGNORE INTO temp.${SKIP_TABLE} (domain, id) VALUES ('Conversation', ?)`);
    for (const id of deleted.conversations) seed.run(id);
    const rules = skipRuleStatements().map((sql) => source.prepare(sql));
    for (;;) {
      let added = 0;
      for (const rule of rules) added += rule.run().changes;
      if (added === 0) break;
    }
  });
  return true;
}

/** The skippedRows rules as INSERT … SELECT statements over the TEMP table (one fixed-point pass each). */
function skipRuleStatements(): string[] {
  const identity = engine.IDENTITY_MERGE_DIFFERENCES;
  const domainOf = new Map(RUNTIME_DOMAIN_SCHEMAS.map((schema) => [schema.table, schema.key]));
  const tableOf = new Map(RUNTIME_DOMAIN_SCHEMAS.map((schema) => [schema.key, schema.table]));
  const skipped = (domain: string, id: string): string =>
    `EXISTS (SELECT 1 FROM temp.${SKIP_TABLE} AS s WHERE s.domain = ${literal(domain)} AND s.id = ${id})`;
  const statements: string[] = [];
  for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
    if (identity.has(schema.key)) continue;
    const references = [
      ...schema.columns.flatMap((column) => {
        const owner = column.references ? domainOf.get(column.references.table) : undefined;
        return owner === undefined || identity.has(owner) ? [] : [{ column: column.name, owner, kind: undefined }];
      }),
      ...engine.SKIPPED_WITH.filter((rule) => rule.domain === schema.key)
    ];
    for (const { column, owner, kind } of references) {
      statements.push(`INSERT OR IGNORE INTO temp.${SKIP_TABLE} (domain, id)
        SELECT ${literal(schema.key)}, t.id FROM ${quoteIdentifier(schema.table)} AS t
         WHERE t.${quoteIdentifier(column)} IS NOT NULL${kind ? ` AND t.${quoteIdentifier(kind[0])} = ${literal(kind[1])}` : ''}
           AND ${skipped(owner, `t.${quoteIdentifier(column)}`)}`);
    }
  }
  for (const rule of engine.SKIPPED_WITH_MEMBERS) {
    const members = rule.members.map(([domain, column]) => ({ domain, column, table: tableOf.get(domain)! }));
    if (rule.mode === 'any') {
      for (const { domain, column, table } of members) {
        statements.push(`INSERT OR IGNORE INTO temp.${SKIP_TABLE} (domain, id)
          SELECT ${literal(rule.domain)}, t.${quoteIdentifier(column)} FROM ${quoteIdentifier(table)} AS t
           WHERE t.${quoteIdentifier(column)} IS NOT NULL AND ${skipped(domain, 't.id')}`);
      }
      continue;
    }
    // 'all': an owner goes once every membership naming it is a left-out row.
    const memberships = members.map(({ domain, column, table }) => `SELECT t.${quoteIdentifier(column)} AS owner, ${skipped(domain, 't.id')} AS gone
      FROM ${quoteIdentifier(table)} AS t WHERE t.${quoteIdentifier(column)} IS NOT NULL`).join(' UNION ALL ');
    statements.push(`INSERT OR IGNORE INTO temp.${SKIP_TABLE} (domain, id)
      SELECT ${literal(rule.domain)}, owner FROM (${memberships}) GROUP BY owner HAVING SUM(gone) = COUNT(*)`);
  }
  return statements;
}

function boundSourcePageCache(source: Database.Database): void {
  for (const schema of ['main', 'temp']) source.pragma(`${schema}.cache_size = -${SOURCE_PAGE_CACHE_KIB}`);
}

/** The read of one domain's source rows in merge order, without the left-out rows. */
function sourceRowsSql(schema: (typeof RUNTIME_DOMAIN_SCHEMAS)[number], skipping: boolean): string {
  return engine.mergeReadSql(schema, skipping
    ? ` AS t WHERE NOT EXISTS (SELECT 1 FROM temp.${SKIP_TABLE} AS s WHERE s.domain = ${literal(schema.key)} AND s.id = t.id)`
    : '');
}

/**
 * A snapshot connection opened with query_only (the online audit's) can still write its own TEMP
 * tables here: the main database is opened read-only either way.
 */
function withTemporaryWrites<T>(database: Database.Database, run: () => T): T {
  const queryOnly = Number(database.pragma('query_only', { simple: true })) !== 0;
  if (queryOnly) database.pragma('query_only = OFF');
  try {
    return run();
  } finally {
    if (queryOnly) database.pragma('query_only = ON');
  }
}

// ---------------------------------------------------------------------------------------------
// Online scan and the streamed transaction: the row rules of planRows, one chunk at a time.
// ---------------------------------------------------------------------------------------------

export interface RuntimeDataSetMergeScan {
  /** Source rows compared (left-out rows excluded). */
  rows: number;
  insertRows: number;
  reusedRows: number;
  insertConversations: number;
  conflicts: { count: number; samples: string[] };
  elapsedMs: number;
}

interface ChunkedRowsOptions {
  skipping: boolean;
  chunkRows: number;
  signal?: AbortSignal;
}

/**
 * Every source row in merge order, decoded by its codec, in chunks with their target rows (read
 * through the target's reader: the committed state, also while a maintenance transaction is open).
 */
async function forEachSourceChunk(
  source: Database.Database,
  target: RuntimeDatabase,
  options: ChunkedRowsOptions,
  visit: (schema: (typeof RUNTIME_DOMAIN_SCHEMAS)[number], chunk: DomainRow[], existing: Array<DomainRow | null>) => Promise<void>
): Promise<void> {
  if (!Number.isSafeInteger(options.chunkRows) || options.chunkRows < 1) throw new RangeError('chunkRows must be a positive integer.');
  for (const schema of engine.MERGE_DOMAIN_ORDER) {
    const repository = DOMAIN_REPOSITORIES.domain(schema.key);
    const statement = source.prepare(sourceRowsSql(schema, options.skipping));
    let chunk: DomainRow[] = [];
    const flush = async (): Promise<void> => {
      if (chunk.length === 0) return;
      options.signal?.throwIfAborted();
      const existing = (await target.snapshot(chunk.map((row) => repository.get(String(row.id))))).snapshot as Array<DomainRow | null>;
      const rows = chunk;
      chunk = [];
      await visit(schema, rows, existing);
      // Decoding stays on the extension thread; yield so a large source never monopolizes it.
      await new Promise((resolve) => setImmediate(resolve));
    };
    for (const raw of statement.iterate() as IterableIterator<Record<string, unknown>>) {
      chunk.push(engine.sourceRow(schema.key, String(raw.id), () => repository.codec.decode(raw)));
      if (chunk.length >= options.chunkRows) await flush();
    }
    await flush();
  }
}

/** Counts of a merge sink; steps are dropped after every chunk. */
function countingSink(scan: Omit<RuntimeDataSetMergeScan, 'elapsedMs'>, savepoints: { next: number }): RuntimeDataSetMergeChunkSink {
  return {
    steps: [],
    presence: [],
    inserted: (domain) => {
      scan.insertRows += 1;
      if (domain === 'Conversation') scan.insertConversations += 1;
    },
    reused: () => { scan.reusedRows += 1; },
    conflict: (sample) => {
      scan.conflicts.count += 1;
      if (scan.conflicts.samples.length < engine.MAX_REPORTED_CONFLICTS) scan.conflicts.samples.push(sample());
    },
    savepointName: () => `merge_identity_${savepoints.next++}`
  };
}

/**
 * Online dry run of a merge: every source row decoded and compared with the target row of its id, as
 * the merge will (planMergeChunk), keeping only counts, at most MAX_REPORTED_CONFLICTS conflict
 * samples and the time taken. Memory does not grow with the rows.
 */
export async function scanMergeRows(
  source: Database.Database,
  target: RuntimeDatabase,
  options: { skipping?: boolean; chunkRows?: number; signal?: AbortSignal; onRows?(rows: number): void } = {}
): Promise<RuntimeDataSetMergeScan> {
  const started = performance.now();
  const scan: Omit<RuntimeDataSetMergeScan, 'elapsedMs'> = {
    rows: 0, insertRows: 0, reusedRows: 0, insertConversations: 0, conflicts: { count: 0, samples: [] }
  };
  const sink = countingSink(scan, { next: 0 });
  await forEachSourceChunk(source, target, {
    skipping: options.skipping === true, chunkRows: options.chunkRows ?? RUNTIME_DATA_SET_STREAMED_MERGE_CHUNK_ROWS,
    ...(options.signal ? { signal: options.signal } : {})
  }, async (schema, chunk, existing) => {
    planMergeChunk(schema, chunk, existing, sink);
    sink.steps.length = 0;
    sink.presence.length = 0;
    scan.rows += chunk.length;
    options.onRows?.(scan.rows);
  });
  return { ...scan, elapsedMs: performance.now() - started };
}

interface StreamedMerge {
  /** False when nothing was inserted (the transaction was rolled back, nothing committed). */
  committed: boolean;
  rows: number;
  inserted: number;
  reused: number;
  insertedConversations: number;
}

/**
 * The one maintenance transaction of a source: chunk by chunk, compared with the target's committed
 * state and appended with that chunk's presence assertions. A conflict stops the writing at once (the
 * transaction is rolled back; the rest is still compared, for the count and samples) and refuses the
 * source; any failure or cancellation rolls it back. `beforeCommit` runs after the last chunk.
 */
async function streamMergeTransaction(
  source: Database.Database,
  database: RuntimeDatabase,
  input: ChunkedRowsOptions & {
    evidence: RuntimeDataSetMergeEvidence;
    state: HistoricalMergeSourceProgress;
    onChunk(chunk: number, rows: number): Promise<void>;
    beforeCommit(): Promise<void>;
  }
): Promise<StreamedMerge> {
  const scan: Omit<RuntimeDataSetMergeScan, 'elapsedMs'> = {
    rows: 0, insertRows: 0, reusedRows: 0, insertConversations: 0, conflicts: { count: 0, samples: [] }
  };
  const counting = countingSink(scan, { next: 0 });
  const sink: RuntimeDataSetMergeChunkSink = {
    ...counting,
    inserted: (domain, id) => {
      counting.inserted(domain, id);
      input.evidence.add(domain, id);
    }
  };
  let open = true;
  let chunk = 0;
  await database.maintenanceBegin();
  try {
    await forEachSourceChunk(source, database, input, async (schema, rows, existing) => {
      planMergeChunk(schema, rows, existing, sink);
      scan.rows += rows.length;
      const steps: RepositoryTransactionStep[] = [...sink.steps, ...sink.presence];
      sink.steps.length = 0;
      sink.presence.length = 0;
      if (scan.conflicts.count > 0) {
        if (open) {
          open = false;
          await database.maintenanceRollback();
        }
        return;
      }
      input.signal?.throwIfAborted();
      await database.maintenanceAppend(steps);
      await input.onChunk(chunk, scan.rows);
      chunk += 1;
    });
    if (scan.conflicts.count > 0) throw new engine.Outcome(engine.conflictRefusal(scan.conflicts, input.state));
    const merged = { rows: scan.rows, inserted: scan.insertRows, reused: scan.reusedRows, insertedConversations: scan.insertConversations };
    if (scan.insertRows === 0) {
      open = false;
      await database.maintenanceRollback();
      return { committed: false, ...merged };
    }
    input.signal?.throwIfAborted();
    await input.beforeCommit();
    open = false;
    await database.maintenanceCommit();
    return { committed: true, ...merged };
  } catch (error) {
    if (open) await database.maintenanceRollback().catch(() => undefined);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Preparation claims (preparing/<id>.json).
// ---------------------------------------------------------------------------------------------

class PreparationClaims {
  private readonly held = new Map<string, { token: string; startedAt: string }>();
  private timer: NodeJS.Timeout | undefined;

  public constructor(private readonly paths: { globalStoragePath: string }) {}

  /** False while another live window prepares or holds the source. */
  public async claim(candidateId: string): Promise<boolean> {
    return withRuntimeDataRootAdmission(this.paths.globalStoragePath, async () => {
      const current = await readRuntimeDataSetMergePreparation(this.paths, candidateId).catch(() => undefined);
      const mine = this.held.get(candidateId);
      if (current && current.token !== mine?.token && isRuntimeDataSetMergePreparationLive(current)) return false;
      const claim = mine ?? { token: randomUUID(), startedAt: new Date().toISOString() };
      await writeRuntimeDataSetMergePreparation(this.paths, {
        candidateId, token: claim.token, processId: process.pid, startedAt: claim.startedAt, heartbeatAt: new Date().toISOString()
      });
      this.held.set(candidateId, claim);
      this.startHeartbeat();
      return true;
    });
  }

  public async release(candidateId: string): Promise<void> {
    const claim = this.held.get(candidateId);
    if (!claim) return;
    this.held.delete(candidateId);
    if (this.held.size === 0) this.stopHeartbeat();
    await withRuntimeDataRootAdmission(this.paths.globalStoragePath, async () => {
      const current = await readRuntimeDataSetMergePreparation(this.paths, candidateId).catch(() => undefined);
      if (current?.token === claim.token) await removeRuntimeDataSetMergePreparation(this.paths, candidateId);
    }).catch(() => undefined);
  }

  public async releaseAll(): Promise<void> {
    for (const candidateId of [...this.held.keys()]) await this.release(candidateId);
  }

  private startHeartbeat(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.refresh(); }, PREPARATION_HEARTBEAT_MS);
    this.timer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Refreshed without the admission (it can be held for minutes): only while the record is still ours. */
  private async refresh(): Promise<void> {
    for (const [candidateId, claim] of this.held) {
      const current = await readRuntimeDataSetMergePreparation(this.paths, candidateId).catch(() => undefined);
      if (current?.token !== claim.token) continue;
      await writeRuntimeDataSetMergePreparation(this.paths, { ...current, heartbeatAt: new Date().toISOString() }).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Online preparation.
// ---------------------------------------------------------------------------------------------

export interface LargeMergeTarget {
  /** Configuration root of the target (this window's data directory root). */
  configurationRootPath: string;
  /** This window's open Runtime of the selected data set: read and backed up online. */
  database: RuntimeDatabase;
}

export type LargeMergePrepareStage = 'snapshot' | 'scan' | 'finalize' | 'cas' | 'backup';

export interface LargeMergePrepareProgress {
  stage: LargeMergePrepareStage;
  candidateId: string;
  /** 0-based among the sources this call works on. */
  index: number;
  total: number;
  /** Source rows compared so far (stage 'scan'). */
  rows?: number;
}

export interface PrepareLargeMergeInput {
  paths: { globalStoragePath: string };
  target: LargeMergeTarget;
  /** Only these sources (e.g. the batch's awaiting-exclusive ones); default every pending source. */
  candidateIds?: readonly string[];
  /** This call is the user's explicit request for `candidateIds` (as mergeHistoricalDataSetsOnline `requested`). */
  requested?: boolean;
  /**
   * Which sources the session takes: above the in-memory transaction bound (default), or also the
   * ones above the online bound (4,000 rows or 12 MiB) that would need their own coordination.
   * Smaller sources are left to the online merge (`small`).
   */
  threshold?: 'in-memory' | 'online';
  /** Cancels between sources and chunks; claims and an unused target backup are released. */
  signal?: AbortSignal;
  onProgress?(progress: LargeMergePrepareProgress): void;
  options?: LargeMergeEngineOptions;
}

export interface LargeMergeSpace {
  /** Where the target's WAL and data grow (the target's control root). */
  targetDirectory: string;
  /** Needed there during the session: the sources' databases (growth), the largest one's WAL peak and a margin. */
  targetBytes: number;
  /** Where the private source copies go (os.tmpdir()). */
  temporaryDirectory: string;
  /** The largest source database with its WAL. */
  temporaryBytes: number;
}

export interface PreparedLargeMergeSource {
  candidateId: string;
  /** A foreign history root's readable name (its id is not). */
  label?: string;
  sourceDataSetId: string;
  /** Where the source is (its Runtime data root, located), for details the user can open. */
  runtimeDataRootPath: string;
  /** Content digest of the source state this preparation judged (every table, every row): a coordination key part. */
  fingerprint: string;
  /** Rows and bytes of the audited source (every Runtime table). */
  rows: number;
  bytes: number;
  /** Size of the source's SQLite files (database and WAL). */
  databaseBytes: number;
  /** From the online scan: rows to insert and to reuse, conversations to insert and left out. */
  insertRows: number;
  reusedRows: number;
  insertConversations: number;
  skippedConversations: number;
  /** Content objects of the source (each only lstat'ed in the session). */
  casObjects: number;
  cas: RuntimeDataSetCasTransfer;
  finalized?: RuntimeDataSetMergeResult['finalized'];
  upgradedFromEpoch?: 3 | 4;
  /** Estimated exclusive time of this source (ms) and its [0.8 ×, 1.6 ×] range. */
  estimateMs: number;
  estimateRangeMs: [number, number];
}

/**
 * The prepared session: pass it to runLargeMergeSession, or to releaseLargeMergePreparation when it
 * will not run. Until then the sources stay claimed for this window (heartbeat).
 */
export interface LargeMergePreparation {
  configurationRootPath: string;
  targetCandidateId: string;
  target: RuntimeDataSetIdentity;
  /** Ready for the session, in candidate order. */
  sources: PreparedLargeMergeSource[];
  /** Outcomes that needed no session, as a batch reports them (already merged, nothing new, refused, deferred). */
  report: Omit<RuntimeDataSetMergeBatchResult, 'pendingSources'>;
  /** Left to the online merge: not above the chosen threshold. */
  small: string[];
  /** The online target backup taken for the session (removed again when no session uses it). */
  backupPath?: string;
  space: LargeMergeSpace;
  /** Sum of the sources' estimates (ms) and its [0.8 ×, 1.6 ×] range. */
  estimateMs: number;
  estimateRangeMs: [number, number];
}

interface PreparationInternals {
  claims: PreparationClaims;
  pickedAt: string;
  requested: boolean;
  earlierBackup?: string;
  options: LargeMergeEngineOptions;
  sources: Map<string, PreparedInternals>;
  released: boolean;
}

interface PreparedInternals {
  /** A foreign history root's claim is in it (`foreign`), held from this preparation until the session released it. */
  state: HistoricalMergeSourceProgress;
  casVerification: RuntimeDataSetCasVerification;
}

const PREPARATIONS = new WeakMap<LargeMergePreparation, PreparationInternals>();

type PreparedOutcome = { kind: 'prepared'; source: PreparedLargeMergeSource } | { kind: 'small' };

/**
 * Online preparation of a large-merge session (no claim held for long; every window keeps working).
 * Never throws for a single source: its outcome goes into `report` (and the ledger) as a batch's would.
 */
export async function prepareLargeMergeSources(input: PrepareLargeMergeInput): Promise<LargeMergePreparation> {
  const paths = { globalStoragePath: path.resolve(input.paths.globalStoragePath) };
  const options = input.options ?? {};
  const report: RuntimeDataSetMergeBatchResult = { merged: [], deferred: [], blocked: [], failures: [], pendingSources: 0, stopped: false };
  const keepGoing = (): boolean => {
    if (!input.signal?.aborted) return true;
    report.stopped = true;
    return false;
  };
  const target = engine.targetContext({ configurationRootPath: input.target.configurationRootPath, database: input.target.database });
  const requested = input.requested === true && input.candidateIds !== undefined;
  const { sources, pickedAt } = await engine.pickSources(paths, target, {
    ...(input.candidateIds ? { candidateIds: input.candidateIds } : {}), requested, ...(options.sizeLimits ? { sizeLimits: options.sizeLimits } : {})
  }, report, keepGoing);
  const internals: PreparationInternals = {
    claims: new PreparationClaims(paths), pickedAt, requested, options, sources: new Map(), released: false
  };
  const prepared: PreparedLargeMergeSource[] = [];
  const small: string[] = [];
  internals.earlierBackup = sources.length > 0 ? await engine.newestTargetBackup(target).catch(() => undefined) : undefined;
  try {
    for (const [index, picked] of sources.entries()) {
      if (!keepGoing()) break;
      const candidateId = picked.id;
      const issue = (outcome: { code: string; message: string; awaiting?: { rows: number; bytes: number } }): RuntimeDataSetMergeIssue => ({
        candidateId, code: outcome.code, message: outcome.message, newly: true, requested: picked.requested,
        ...(picked.label ? { label: picked.label } : {})
      });
      if (!await internals.claims.claim(candidateId)) {
        report.deferred.push(issue({ code: 'runtime-data-set-merge-preparing-elsewhere', message: '另一个窗口正在准备合并这份较大的旧聊天记录，由那个窗口完成。' }));
        continue;
      }
      const progress = (stage: LargeMergePrepareStage, rows?: number): void => input.onProgress?.({
        stage, candidateId, index, total: sources.length, ...(rows !== undefined ? { rows } : {})
      });
      const mode: HistoricalMergeSourceMode = { finalizeWork: true, requested: picked.requested, pickedAt };
      const sourceInternals: PreparedInternals = { state: {}, casVerification: new Map() };
      const held = await holdForeignSource(paths, picked, sourceInternals.state);
      if (held !== true) {
        await internals.claims.release(candidateId);
        if (held.kind !== 'stopped') report.deferred.push(issue(held));
        continue;
      }
      const outcome = await engine.runSourceAttempt<PreparedOutcome>(paths, target, candidateId, mode,
        (state) => prepareSource(paths, target, candidateId, mode, state, sourceInternals, input, progress), sourceInternals.state);
      if (outcome.kind === 'prepared') {
        prepared.push(picked.label ? { ...outcome.source, label: picked.label } : outcome.source);
        internals.sources.set(candidateId, sourceInternals);
        continue;
      }
      await sourceInternals.state.foreign?.release();
      await internals.claims.release(candidateId);
      if (outcome.kind === 'small') {
        small.push(candidateId);
        continue;
      }
      if (outcome.kind === 'stopped') break;
      if (outcome.kind === 'merged' || outcome.kind === 'current') {
        const { result } = outcome;
        if (outcome.kind === 'merged' || picked.requested || result.finalized || result.skippedConversations) report.merged.push(result);
        await removeRuntimeDataSetMergeRequest(paths, candidateId).catch(() => undefined);
        continue;
      }
      const refused = issue(outcome);
      if (outcome.kind === 'deferred') report.deferred.push(refused);
      else {
        (outcome.kind === 'blocked' ? report.blocked : report.failures).push(refused);
        await removeRuntimeDataSetMergeRequest(paths, candidateId).catch(() => undefined);
      }
    }
  } catch (error) {
    await releaseHolds(internals);
    await internals.claims.releaseAll();
    throw error;
  }
  if (sources.length > 0) {
    await withRuntimeDataRootAdmission(paths.globalStoragePath, async () => {
      await pruneRuntimeDataSetMergeCommits(paths);
      await pruneRuntimeDataSetMergePreparations(paths);
    }).catch(() => undefined);
  }
  const { pendingSources: _pending, ...batch } = report;
  const estimateMs = prepared.reduce((sum, source) => sum + source.estimateMs, 0);
  const preparation: LargeMergePreparation = {
    configurationRootPath: target.configurationRootPath,
    targetCandidateId: (await selectedCandidate(paths).catch(() => undefined))?.id ?? '',
    target: target.identity,
    sources: prepared,
    report: batch,
    small,
    ...(target.backup.path ? { backupPath: target.backup.path } : {}),
    space: sessionSpace(target, prepared),
    estimateMs,
    estimateRangeMs: estimateRange(estimateMs)
  };
  PREPARATIONS.set(preparation, internals);
  if (prepared.length === 0) await releaseLargeMergePreparation(preparation);
  return preparation;
}

/** Releases a preparation that will not run: the claims, and the target backup no session used. */
export async function releaseLargeMergePreparation(preparation: LargeMergePreparation): Promise<void> {
  const internals = PREPARATIONS.get(preparation);
  if (!internals || internals.released) return;
  internals.released = true;
  await releaseHolds(internals);
  await internals.claims.releaseAll();
  await removeUnusedBackup(preparation, internals);
}

/**
 * A foreign history root's claim, taken before any of its admission-taking steps and kept in its
 * state until the session released it; true when there is none to take or it is held now.
 */
async function holdForeignSource(
  paths: { globalStoragePath: string },
  picked: HistoricalMergePickedSource,
  state: HistoricalMergeSourceProgress
): Promise<true | ReturnType<typeof engine.sourceOutcome>> {
  if (!picked.foreign) return true;
  try {
    state.foreign = await holdForeignHistoricalMergeSource(paths, picked.id, picked.foreign);
    return true;
  } catch (error) {
    return engine.sourceOutcome(error, {});
  }
}

/** Lets go of every foreign root's claim a preparation still holds. */
async function releaseHolds(internals: PreparationInternals): Promise<void> {
  for (const source of internals.sources.values()) await source.state.foreign?.release();
}

/** The preparation's online target backup, which no transaction used: removed (as settleTargetBackup does). */
async function removeUnusedBackup(preparation: LargeMergePreparation, internals: PreparationInternals): Promise<void> {
  if (!preparation.backupPath) return;
  // Unused, settleTargetBackup only removes it (and syncs its directory); it reads nothing else.
  const target = { controlRoot: preparation.space.targetDirectory, backup: { path: preparation.backupPath } };
  await engine.settleTargetBackup(target as unknown as HistoricalMergeTargetContext, {
    ...(internals.earlierBackup ? { keep: internals.earlierBackup } : {})
  }).catch(() => undefined);
}

/** One source: the online merge's steps up to its commit, with a streamed scan instead of a plan. */
async function prepareSource(
  paths: { globalStoragePath: string },
  target: HistoricalMergeTargetContext,
  candidateId: string,
  mode: HistoricalMergeSourceMode,
  state: HistoricalMergeSourceProgress,
  internals: PreparedInternals,
  input: PrepareLargeMergeInput,
  progress: (stage: LargeMergePrepareStage, rows?: number) => void
): Promise<HistoricalMergeSourceOutcome | PreparedOutcome> {
  const options = input.options ?? {};
  const stopIfAsked = (): void => {
    if (input.signal?.aborted) throw new engine.StopRequested();
  };
  stopIfAsked();
  const earlier = await readRuntimeDataSetMergeFinalization(paths, await engine.sourceCandidate(paths, candidateId, state));
  if (earlier) {
    state.finalized = {
      turnIds: earlier.turnIds, intentIds: earlier.intentIds, turns: earlier.turns, intents: earlier.intents,
      sourceBackupPath: earlier.sourceBackupPath, complete: earlier.complete, earlier: true
    };
  }
  const settled = await engine.settledSource(paths, target, candidateId, state);
  if (settled) return settled;
  const { candidate, binding } = await engine.resolveSource(paths, target, candidateId, mode, state);
  const merged = await engine.recordedConversations(paths, target, candidate);
  const chunkRows = options.chunkRows ?? RUNTIME_DATA_SET_STREAMED_MERGE_CHUNK_ROWS;
  // The copy's own time, for the estimate (the audit that follows is not part of the session).
  const timing = { startedAt: 0, copyMs: 0 };
  const snapshotOptions: RuntimeDataSetMergeOptions = {
    ...options,
    onFaultPoint: async (point) => {
      if (point === 'after-snapshot-copy') timing.copyMs = performance.now() - timing.startedAt;
      await options.onFaultPoint?.(point);
    }
  };
  const snapshot = async (): Promise<Awaited<ReturnType<typeof engine.takeVerifiedSnapshot>>> => {
    progress('snapshot');
    timing.startedAt = performance.now();
    return engine.takeVerifiedSnapshot(candidate, binding, 'finalize', state, mode, snapshotOptions);
  };
  let taken = await snapshot();
  try {
    if (state.finalized?.earlier) engine.countFinalized(taken.snapshot.database, state.finalized);
    engine.assertMergeableSize(taken.audit.size!, options, state, true);
    if (!aboveThreshold(taken.audit.size!, input.threshold ?? 'in-memory', options)) return { kind: 'small' };
    const work = taken.audit.unfinishedWork!;
    if (work.refused.length > 0) throw new engine.Outcome(engine.unfinishedWorkOutcome(describeUnfinishedWork(work.refused), state));
    stopIfAsked();
    const scanSource = async (): Promise<RuntimeDataSetMergeScan> => {
      boundSourcePageCache(taken.snapshot.database);
      const skipping = await prepareSkippedRows(taken.snapshot.database, target.database, merged, state);
      progress('scan', 0);
      const scan = await scanMergeRows(taken.snapshot.database, target.database, {
        skipping, chunkRows, ...(input.signal ? { signal: input.signal } : {}), onRows: (rows) => progress('scan', rows)
      }).catch((error: unknown) => {
        if (isAbort(error)) throw new engine.StopRequested();
        throw error;
      });
      if (scan.conflicts.count > 0) throw new engine.Outcome(engine.conflictRefusal(scan.conflicts, state));
      return scan;
    };
    let scan = await scanSource();
    if (hasFinalizableWork(work)) {
      // Everything that can refuse the source was checked on the unfinalized snapshot; the CAS
      // objects are verified too. Only then is it backed up and its work closed, and checked again.
      progress('cas');
      await engine.transferSourceCas(candidate, binding, target, taken.snapshot.database, options, internals.casVerification, true);
      stopIfAsked();
      await engine.fault(options, 'before-source-finalization');
      progress('finalize');
      await engine.finalizeSource(paths, target, candidate, binding, work, state, options, mode, stopIfAsked);
      await taken.snapshot.close();
      taken = await snapshot();
      const remaining = taken.audit.unfinishedWork!;
      if (remaining.refused.length > 0 || hasFinalizableWork(remaining)) {
        throw new engine.Outcome(engine.unfinishedWorkOutcome(describeUnfinishedWork(remaining.refused) || '收尾后仍有未结束的任务', state, true));
      }
      stopIfAsked();
      scan = await scanSource();
    }
    if (scan.insertRows === 0) {
      // Nothing new (all its rows are here already): recorded as merged at once, as an online merge records it.
      const plan: HistoricalMergeRowPlan = { steps: [], inserted: [], reused: scan.reusedRows, insertedConversations: 0, conflicts: { count: 0, samples: [] } };
      return await engine.commitSource(paths, target, candidate, binding, plan, undefined, state, options, mode, stopIfAsked);
    }
    progress('backup');
    await engine.ensureTargetBackup(target, options);
    await engine.fault(options, 'after-target-backup');
    progress('cas');
    const cas = await engine.transferSourceCas(candidate, binding, target, taken.snapshot.database, options, internals.casVerification, false);
    await engine.fault(options, 'after-cas-transfer');
    const size = taken.audit.size!;
    const databaseBytes = await sqliteFilesBytes(binding.paths.databasePath);
    const casObjects = Number(taken.snapshot.database.prepare('SELECT COUNT(*) FROM content_object').pluck().get() as bigint | number);
    // Copy, stream (the scan's measured rate with the inserts on top), checkpoint (about a copy's worth of writing), lstat per object.
    const estimateMs = Math.round(2 * timing.copyMs + scan.elapsedMs * SESSION_ROW_COST_FACTOR + casObjects * CAS_OBJECT_MS);
    const finalized = engine.finalizedResult(state).finalized;
    return {
      kind: 'prepared',
      source: {
        candidateId, sourceDataSetId: binding.dataSetId, runtimeDataRootPath: candidate.runtimeDataRootPath,
        fingerprint: state.fingerprint!.contentDigest, rows: size.rows, bytes: size.bytes, databaseBytes,
        insertRows: scan.insertRows, reusedRows: scan.reusedRows, insertConversations: scan.insertConversations,
        skippedConversations: state.skippedConversations ?? 0, casObjects, cas,
        ...(finalized ? { finalized } : {}), ...(state.upgradedFromEpoch !== undefined ? { upgradedFromEpoch: state.upgradedFromEpoch } : {}),
        estimateMs, estimateRangeMs: estimateRange(estimateMs)
      }
    };
  } finally {
    await taken.snapshot.close();
  }
}

function aboveThreshold(size: { rows: number; bytes: number }, threshold: 'in-memory' | 'online', options: LargeMergeEngineOptions): boolean {
  if (threshold === 'online') return engine.exceedsOnlineLimits(size, options);
  return size.rows > (options.sizeLimits?.transactionRows ?? RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS);
}

function sessionSpace(target: HistoricalMergeTargetContext, sources: readonly PreparedLargeMergeSource[]): LargeMergeSpace {
  const largest = sources.reduce((max, source) => Math.max(max, source.databaseBytes), 0);
  return {
    targetDirectory: target.controlRoot,
    targetBytes: sources.length === 0 ? 0
      : Math.ceil(sources.reduce((sum, source) => sum + source.databaseBytes, 0) + largest * WAL_PEAK_FACTOR + engine.BACKUP_FREE_SPACE_MARGIN_BYTES),
    temporaryDirectory: os.tmpdir(),
    temporaryBytes: largest
  };
}

function estimateRange(ms: number): [number, number] {
  return [Math.round(ms * RUNTIME_DATA_SET_LARGE_MERGE_ESTIMATE_RANGE.low), Math.round(ms * RUNTIME_DATA_SET_LARGE_MERGE_ESTIMATE_RANGE.high)];
}

async function sqliteFilesBytes(databasePath: string): Promise<number> {
  let bytes = 0;
  for (const file of [databasePath, `${databasePath}-wal`]) bytes += await stat(file).then((info) => info.size, () => 0);
  return bytes;
}

async function selectedCandidate(paths: { globalStoragePath: string }) {
  const selected = (await inspectVscodeRuntimeDataSets(paths)).candidates.filter((candidate) => candidate.selected);
  return selected.length === 1 ? selected[0] : undefined;
}

// ---------------------------------------------------------------------------------------------
// Exclusive session.
// ---------------------------------------------------------------------------------------------

export type LargeMergeSessionStage = 'checking' | 'copying' | 'merging' | 'committing' | 'checkpointing' | 'recording';

export interface LargeMergeSessionProgress {
  stage: LargeMergeSessionStage;
  candidateId: string;
  /** 0-based source index, and the number of sources in the session. */
  index: number;
  total: number;
  /** Source rows compared in this source so far, and its audited rows. */
  rows: number;
  sourceRows: number;
  /** Rows of every source of the session done so far, and in all. */
  sessionRows: number;
  sessionTotalRows: number;
  /** Since the session started. */
  elapsedMs: number;
  /** From the measured rate of this session (the preparation's estimate before any row). */
  remainingMs: number;
}

export interface RunLargeMergeSessionInput {
  paths: { globalStoragePath: string };
  prepared: LargeMergePreparation;
  /** Rolls back the current source and stops; sources merged before stay merged. */
  signal?: AbortSignal;
  /** At most every 200 ms, and at every stage change. */
  onProgress?(progress: LargeMergeSessionProgress): void;
  /** Test-only; merged over the preparation's options. */
  options?: LargeMergeEngineOptions;
}

export type LargeMergeSourceResult =
  | { candidateId: string; state: 'merged'; result: RuntimeDataSetMergeResult }
  /** Nothing new, or merged by another window meanwhile (result.alreadyMerged). */
  | { candidateId: string; state: 'current'; result: RuntimeDataSetMergeResult }
  | { candidateId: string; state: 'deferred' | 'blocked' | 'failed'; issue: RuntimeDataSetMergeIssue }
  /** Not started: the session was cancelled or stopped at a full disk before this source. */
  | { candidateId: string; state: 'not-run'; reason: 'cancelled' | 'disk-full' };

export interface LargeMergeSessionResult {
  results: LargeMergeSourceResult[];
  cancelled: boolean;
}

export const RUNTIME_DATA_SET_MERGE_CANCELLED = 'runtime-data-set-merge-cancelled';
const DISK_FULL = 'runtime-data-set-merge-disk-full';

/**
 * Exclusive phase. Preconditions (checked): the caller holds this configuration root's admission and
 * the target data set's maintenance claim, and this process's Runtime of the target is closed (the
 * private maintenance instance cannot open otherwise). Merges every prepared source in order, each in
 * one streamed maintenance transaction, and returns one result per source. Never throws for a source.
 */
export async function runLargeMergeSession(input: RunLargeMergeSessionInput): Promise<LargeMergeSessionResult> {
  const paths = { globalStoragePath: path.resolve(input.paths.globalStoragePath) };
  const preparation = input.prepared;
  const internals = PREPARATIONS.get(preparation);
  if (!internals || internals.released) throw new Error('This large-merge preparation was released or is not one of this process.');
  const options: LargeMergeEngineOptions = { ...internals.options, ...input.options };
  if (!isRuntimeDataRootAdmissionHeld(paths.globalStoragePath)) {
    throw new Error('A large-merge session runs only inside the configuration admission of its data directory.');
  }
  const selected = await selectedCandidate(paths);
  if (!selected || !sameRuntimeDataSetIdentity(preparation.target, selected)) {
    throw new Error('The selected history data set is no longer the one this session was prepared for.');
  }
  const targetBinding = await requireCompleteRuntimeDataSet(selected);
  if (!isRuntimeMaintenanceHeld(targetBinding.paths)) {
    throw new Error('A large-merge session runs only while its caller holds the target maintenance claim.');
  }
  const results: LargeMergeSessionResult = { results: [], cancelled: false };
  const notRun = (from: number, reason: 'cancelled' | 'disk-full'): void => {
    for (const source of preparation.sources.slice(from)) results.results.push({ candidateId: source.candidateId, state: 'not-run', reason });
  };
  let backupSettled = false;
  try {
    const free = await (options.freeSpace ?? engine.freeSpace)(preparation.space.targetDirectory).catch(() => undefined);
    if (free !== undefined && free < preparation.space.targetBytes) {
      const message = `磁盘空间不足，需要约 ${Math.ceil(preparation.space.targetBytes / (1024 * 1024))} MB：合并较大的旧聊天记录要在 ${preparation.space.targetDirectory} 暂存数据`;
      for (const source of preparation.sources) {
        results.results.push({ candidateId: source.candidateId, state: 'deferred', issue: { candidateId: source.candidateId, code: DISK_FULL, message, newly: true } });
      }
      return results;
    }
    const database = await RuntimeDatabase.open(
      createVscodeRootAuthority({ runtimeDataRootPath: selected.runtimeDataRootPath, configurationRootPath: selected.configurationRootPath }),
      { hostBootId: `historical-merge-${randomUUID()}`, maintenance: true, ...(options.workerResourceLimits ? { resourceLimits: options.workerResourceLimits } : {}) }
    );
    const target = engine.targetContext({ configurationRootPath: preparation.configurationRootPath, database });
    if (preparation.backupPath) target.backup = { path: preparation.backupPath };
    const resolver = historicalMergeSources(paths, (candidateId) => internals.sources.get(candidateId)?.state.foreign);
    const clock = new SessionClock(preparation, input.onProgress);
    try {
      for (const [index, prepared] of preparation.sources.entries()) {
        if (input.signal?.aborted) {
          results.cancelled = true;
          notRun(index, 'cancelled');
          break;
        }
        await options.onFaultPoint?.('before-source', { candidateId: prepared.candidateId, index });
        const sourceInternals = internals.sources.get(prepared.candidateId)!;
        const mode: HistoricalMergeSourceMode = { finalizeWork: true, requested: internals.requested, pickedAt: internals.pickedAt };
        const outcome = await engine.runSourceAttempt(paths, target, prepared.candidateId, mode,
          (state) => mergePreparedSource(paths, target, resolver, prepared, sourceInternals.casVerification, state, mode, options, input.signal,
            clock.source(index, prepared)), { ...sourceInternals.state });
        clock.sourceDone(prepared);
        const result = sourceResult(prepared.candidateId, outcome, internals.requested, prepared.label);
        results.results.push(result);
        if (result.state === 'merged' || result.state === 'current' || result.state === 'blocked' || result.state === 'failed') {
          await removeRuntimeDataSetMergeRequest(paths, prepared.candidateId).catch(() => undefined);
        }
        await sourceInternals.state.foreign?.release();
        await internals.claims.release(prepared.candidateId);
        if (result.state === 'deferred' && result.issue.code === RUNTIME_DATA_SET_MERGE_CANCELLED) {
          results.cancelled = true;
          notRun(index + 1, 'cancelled');
          break;
        }
        if (result.state === 'deferred' && result.issue.code === DISK_FULL) {
          notRun(index + 1, 'disk-full');
          break;
        }
      }
    } finally {
      await database.close();
      backupSettled = true;
      await engine.settleTargetBackup(target, { ...(internals.earlierBackup ? { keep: internals.earlierBackup } : {}) }).catch(() => undefined);
    }
  } finally {
    internals.released = true;
    await releaseHolds(internals);
    await internals.claims.releaseAll();
    // Nothing ran (no room on the disk, or the private instance did not open): no transaction used it.
    if (!backupSettled) await removeUnusedBackup(preparation, internals);
    await pruneRuntimeDataSetMergeCommits(paths).catch(() => undefined);
  }
  return results;
}

function sourceResult(candidateId: string, outcome: HistoricalMergeSourceOutcome, requested: boolean, label?: string): LargeMergeSourceResult {
  if (outcome.kind === 'merged') return { candidateId, state: 'merged', result: outcome.result };
  if (outcome.kind === 'current') return { candidateId, state: 'current', result: outcome.result };
  const named = label ? { label } : {};
  if (outcome.kind === 'stopped') {
    return { candidateId, state: 'deferred', issue: { candidateId, code: RUNTIME_DATA_SET_MERGE_CANCELLED, message: '合并已停止。', newly: true, requested, ...named } };
  }
  return { candidateId, state: outcome.kind, issue: { candidateId, code: outcome.code, message: outcome.message, newly: true, requested, ...named } };
}

/** Progress of a session: throttled, with the remaining time from the rate measured so far. */
class SessionClock {
  private readonly startedAt = performance.now();
  private readonly totalRows: number;
  private doneRows = 0;
  private lastReport = 0;
  private lastStage: string | undefined;

  public constructor(private readonly preparation: LargeMergePreparation, private readonly report?: (progress: LargeMergeSessionProgress) => void) {
    this.totalRows = preparation.sources.reduce((sum, source) => sum + source.rows, 0);
  }

  public source(index: number, prepared: PreparedLargeMergeSource): (stage: LargeMergeSessionStage, rows: number) => void {
    return (stage, rows) => {
      if (!this.report) return;
      const now = performance.now();
      const key = `${index}:${stage}`;
      if (key === this.lastStage && now - this.lastReport < 200) return;
      this.lastStage = key;
      this.lastReport = now;
      const elapsedMs = now - this.startedAt;
      const sessionRows = this.doneRows + Math.min(rows, prepared.rows);
      const remainingMs = sessionRows > 0
        ? Math.max(0, Math.round(elapsedMs / sessionRows * (this.totalRows - sessionRows)))
        : this.preparation.estimateMs;
      this.report({
        stage, candidateId: prepared.candidateId, index, total: this.preparation.sources.length, rows, sourceRows: prepared.rows,
        sessionRows, sessionTotalRows: this.totalRows, elapsedMs: Math.round(elapsedMs), remainingMs
      });
    };
  }

  public sourceDone(prepared: PreparedLargeMergeSource): void {
    this.doneRows += prepared.rows;
  }
}

/**
 * One prepared source, inside the caller's admission and target maintenance claim: under the source's
 * maintenance claim, the audited state is checked unchanged and copied again, the ledger read again,
 * the committing record written, the rows streamed into one maintenance transaction and committed
 * durably, the WAL truncated, and only then the source recorded as merged. Once the transaction
 * committed, that is the outcome (writing the record or releasing a claim afterwards only logs).
 */
async function mergePreparedSource(
  paths: { globalStoragePath: string },
  target: HistoricalMergeTargetContext,
  resolver: HistoricalMergeSourceResolver,
  prepared: PreparedLargeMergeSource,
  verified: RuntimeDataSetCasVerification,
  state: HistoricalMergeSourceProgress,
  mode: HistoricalMergeSourceMode,
  options: LargeMergeEngineOptions,
  signal: AbortSignal | undefined,
  progress: (stage: LargeMergeSessionStage, rows: number) => void
): Promise<HistoricalMergeSourceOutcome> {
  const { candidateId } = prepared;
  const changed = (error: unknown): never => {
    throw new engine.Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-source-changed', message: `来源历史库在准备之后有变化，稍后重试：${engine.errorMessage(error)}` });
  };
  progress('checking', 0);
  const root = await resolver.locate(candidateId).catch(changed);
  const done: { outcome?: HistoricalMergeSourceOutcome } = {};
  try {
    return await resolver.fence(root, async () => {
      done.outcome = await mergeLocked(paths, target, resolver, root, prepared, verified, state, mode, options, signal, progress);
      return done.outcome;
    });
  } catch (error) {
    if (!done.outcome) throw error;
    console.warn('[LimCode] 较大的旧聊天记录已合并，但之后释放锁失败。', error);
    return done.outcome;
  }
}

async function mergeLocked(
  paths: { globalStoragePath: string },
  target: HistoricalMergeTargetContext,
  resolver: HistoricalMergeSourceResolver,
  root: LocatedRuntimeRoot,
  prepared: PreparedLargeMergeSource,
  verified: RuntimeDataSetCasVerification,
  state: HistoricalMergeSourceProgress,
  mode: HistoricalMergeSourceMode,
  options: LargeMergeEngineOptions,
  signal: AbortSignal | undefined,
  progress: (stage: LargeMergeSessionStage, rows: number) => void
): Promise<HistoricalMergeSourceOutcome> {
  const { candidateId } = prepared;
  await resolver.assertUnchanged(root, { paths, target, state, mode });
  const candidate = await resolver.candidate(root);
  const previous = (await readRuntimeDataSetMergeLedger(paths)).get(candidateId);
  if ((previous?.state === 'committing' || previous?.state === 'merged') && sameRuntimeDataSetIdentity(previous.target, target.identity)) {
    if (previous.state === 'committing') {
      throw new engine.Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-commit-pending', message: '另一个窗口合并这个库时中断，下次启动时先确认它的结果。' });
    }
    if (sameRuntimeDataSetIdentity(previous.source, candidate) && sameRuntimeDataSetFingerprint(previous.source, state.fingerprint)) {
      return { kind: 'current', result: await engine.currentResult(paths, candidate, target, state) };
    }
  }
  progress('copying', 0);
  const copy = await resolver.snapshot(root);
  try {
    // Under the source's fence with no Host on it the files cannot change: the audit's conclusions hold.
    if (await runtimeDataSetFileState(root.located.databasePath) !== state.files) {
      throw new engine.Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-source-changed', message: '来源历史库在核验之后又有变化，稍后重试。' });
    }
    const merged = await engine.recordedConversations(paths, target, candidate);
    boundSourcePageCache(copy.database);
    const skipping = await prepareSkippedRows(copy.database, target.database, merged, state);
    // Published online with their verified identities: unchanged objects are only lstat'ed here.
    const cas = await engine.transferSourceCas(candidate, locatedBinding(root), target, copy.database, options, verified, false);
    await engine.fault(options, 'after-cas-transfer');
    const result: RuntimeDataSetMergeResult = {
      ...engine.unchangedResult(candidate, target), ...cas,
      ...(target.backup.path ? { backupPath: target.backup.path } : {}),
      ...(state.upgradedFromEpoch !== undefined ? { upgradedFromEpoch: state.upgradedFromEpoch } : {}),
      ...(state.skippedConversations ? { skippedConversations: state.skippedConversations } : {}),
      exclusive: true
    };
    const evidence = new RuntimeDataSetMergeEvidence();
    const record = (inserted: StreamedMerge) => ({
      candidateId, state: 'merged' as const, source: state.fingerprint!, target: target.identity,
      mergedAt: new Date().toISOString(), insertedRows: inserted.inserted, reusedRows: inserted.reused,
      insertedConversations: inserted.insertedConversations, insertedConversationIds: evidence.conversationIds
    });
    // The evidence is completed right before the commit: until then it names nothing, so a crash
    // before the commit converges to "none of it is there" and puts the replaced record back.
    const commitId = await writeRuntimeDataSetMergeCommit(paths, []);
    await writeRuntimeDataSetMergeLedgerRecord(paths, {
      candidateId, state: 'committing', source: state.fingerprint!, target: target.identity, commitId, ...(previous ? { replaced: previous } : {})
    });
    const backupUsed = target.backup.used === true;
    target.backup.used = true;
    await options.onFaultPoint?.('after-committing', { candidateId });
    let streamed: StreamedMerge;
    try {
      progress('merging', 0);
      streamed = await streamMergeTransaction(copy.database, target.database, {
        skipping, chunkRows: options.chunkRows ?? RUNTIME_DATA_SET_STREAMED_MERGE_CHUNK_ROWS, ...(signal ? { signal } : {}), evidence, state,
        onChunk: async (chunk, rows) => {
          progress('merging', rows);
          await options.onFaultPoint?.('after-chunk', { candidateId, chunk });
        },
        beforeCommit: async () => {
          await options.onFaultPoint?.('after-last-chunk', { candidateId });
          progress('committing', prepared.rows);
          await writeRuntimeDataSetMergeCommit(paths, evidence.rows(), commitId);
          await options.onFaultPoint?.('before-commit', { candidateId });
        }
      });
    } catch (error) {
      // One transaction: measured, it either committed completely (only its reply was lost) or not at all.
      const presence = await engine.insertedRowsPresence(evidence.rows(), target.database).catch(() => undefined);
      if (presence === 'none') {
        target.backup.used = backupUsed;
        await restoreReplaced(paths, candidateId, previous);
        await removeRuntimeDataSetMergeCommit(paths, commitId).catch(() => undefined);
      }
      if (presence !== 'all') {
        // The rolled-back transaction's WAL is given back to the disk.
        await target.database.maintenanceCheckpoint().catch(() => undefined);
        throw streamFailure(error, prepared, target);
      }
      streamed = {
        committed: true, rows: prepared.rows, inserted: prepared.insertRows, reused: prepared.reusedRows,
        insertedConversations: evidence.conversationIds.length
      };
    }
    if (!streamed.committed) {
      // Every row is here already: recorded as merged without a transaction, as an empty plan is.
      target.backup.used = backupUsed;
      await writeRuntimeDataSetMergeLedgerRecord(paths, record(streamed));
      await removeRuntimeDataSetMergeCommit(paths, commitId).catch(() => undefined);
      return { kind: 'current', result: {
        ...result, reusedRows: streamed.reused, alreadyMerged: true, ...await engine.takeFinalized(paths, candidate, state).catch(() => engine.finalizedResult(state))
      } };
    }
    await options.onFaultPoint?.('after-commit', { candidateId });
    progress('checkpointing', prepared.rows);
    // The commit is on disk already (synchronous = FULL); the checkpoint writes the WAL back and frees it.
    const checkpoint = await target.database.maintenanceCheckpoint().catch((error: unknown) => {
      console.warn('[LimCode] 较大的旧聊天记录已合并，但之后收回预写日志失败。', error);
      return undefined;
    });
    if (checkpoint && checkpoint.busy !== 0) console.warn('[LimCode] 较大的旧聊天记录已合并，但预写日志还在被读取，没有完全收回。', checkpoint);
    await options.onFaultPoint?.('before-merged-record', { candidateId });
    progress('recording', prepared.rows);
    try {
      await writeRuntimeDataSetMergeLedgerRecord(paths, record(streamed));
      await removeRuntimeDataSetMergeCommit(paths, commitId).catch(() => undefined);
    } catch (error) {
      console.warn('[LimCode] 较大的旧聊天记录已合并，但合并记录没有写成；下次启动时按实测确认。', error);
    }
    return { kind: 'merged', result: {
      ...result, insertedRows: streamed.inserted, reusedRows: streamed.reused, insertedConversations: streamed.insertedConversations,
      ...await engine.takeFinalized(paths, candidate, state).catch(() => engine.finalizedResult(state))
    } };
  } finally {
    await copy.close();
  }
}

async function restoreReplaced(
  paths: { globalStoragePath: string },
  candidateId: string,
  previous: Awaited<ReturnType<typeof readRuntimeDataSetMergeLedger>> extends Map<string, infer R> ? R | undefined : never
): Promise<void> {
  await engine.restoreLedgerRecord(paths, candidateId, previous);
}

/** A failed streamed transaction (rolled back): a refusal as it is, a cancellation, a full disk, anything else deferred. */
function streamFailure(error: unknown, prepared: PreparedLargeMergeSource, target: HistoricalMergeTargetContext): unknown {
  if (error instanceof engine.Outcome) return error;
  if (isAbort(error)) {
    return new engine.Outcome({ kind: 'deferred', code: RUNTIME_DATA_SET_MERGE_CANCELLED, message: '合并已取消，这份旧聊天记录没有合并（之前合并完的库保留）；以后可以再合并。' });
  }
  if (hasErrorCode(error, 'SQLITE_FULL')) {
    const bytes = prepared.databaseBytes * (1 + WAL_PEAK_FACTOR) + engine.BACKUP_FREE_SPACE_MARGIN_BYTES;
    return new engine.Outcome({
      kind: 'deferred', code: DISK_FULL,
      message: `磁盘空间不足，需要约 ${Math.ceil(bytes / (1024 * 1024))} MB：合并这份旧聊天记录要在 ${target.controlRoot} 暂存数据，已撤回这份的写入`
    });
  }
  return new engine.Outcome({ kind: 'deferred', code: engine.errorCode(error), message: `写入当前库时出错，稍后重试：${engine.errorMessage(error)}` });
}

function hasErrorCode(error: unknown, code: string): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === 'object' && !seen.has(current); current = (current as { cause?: unknown }).cause) {
    seen.add(current);
    if ((current as { code?: unknown }).code === code) return true;
  }
  return false;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
