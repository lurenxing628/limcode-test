import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtemp,rm,stat } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { ResourceLimits } from 'node:worker_threads';
import type { RootBinding } from './contracts';
import { DOMAIN_REPOSITORIES,type DomainRow,type RepositoryTransactionStep } from './repositories';
import type { HistoricalRootBinding } from './rootAuthority';
import { casTransferPackedStorageBytes } from './runtimeCasTransfer';
import { openRuntimeCasVerificationCache,type RuntimeCasVerificationCache,type RuntimeCasVerifier } from './runtimeCasVerificationCache';
import { ownProcessStartIdentity } from './runtimeClaimPrimitives';
import { RuntimeDatabase,RuntimeDatabaseWorkerError } from './runtimeDatabase';
import { isRuntimeDataInvariant } from './runtimeDataInvariant';
import { runtimeDataSetFileState } from './runtimeDataSetFacts';
import {
largeMergeDiskDevice,
largeMergeSqliteTemporaryBytes,largeMergeTargetBytes,
sqliteTemporaryDirectory
} from './runtimeDataSetLargeMergeSpace';
import {
HISTORICAL_MERGE_ENGINE as engine,planMergeChunk,
RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS,
RuntimeDataSetMergeEvidence,
type ForeignHistoricalMergeCandidate,type ForeignHistoricalMergeHold,
type HistoricalCasSnapshot,
type HistoricalMergeCandidate,
type HistoricalMergePickedSource,type HistoricalMergeRowPlan,type HistoricalMergeSourceMode,type HistoricalMergeSourceOutcome,type HistoricalMergeSourceProgress,
type HistoricalMergeTargetContext,type RuntimeDataSetCasTransfer,
type RuntimeDataSetMergeBatchResult,type RuntimeDataSetMergeChunkSink,type RuntimeDataSetMergeFaultPoint,
type RuntimeDataSetMergeIssue,type RuntimeDataSetMergeOptions,type RuntimeDataSetMergeResult
} from './runtimeDataSetMerge';
import {
isRuntimeDataSetMergePreparationLive,
pruneRuntimeDataSetMergeCommits,
readRuntimeDataSetMergeFinalization,readRuntimeDataSetMergeLedger,readRuntimeDataSetMergePreparation,removeRuntimeDataSetMergeCommit,
removeRuntimeDataSetMergePreparation,
removeRuntimeLargeMergeTargetBackup,
RUNTIME_DATA_SET_MERGE_PREPARATION_STALE_MS,
sameRuntimeDataSetFingerprint,sameRuntimeDataSetIdentity,
writeRuntimeDataSetMergeCommit,writeRuntimeDataSetMergeLedgerRecord,writeRuntimeDataSetMergePreparation,
writeRuntimeLargeMergeTargetBackup,
type RuntimeDataSetIdentity,type RuntimeLargeMergeTargetBackup
} from './runtimeDataSetMergeLedger';
import { describeUnfinishedWork,hasFinalizableWork,inspectUnfinishedWorkRows,type UnfinishedWorkInspection } from './runtimeDataSetMergeWork';
import { withLocatedRuntimeRootFence } from './runtimeForeignHistory';
import { holdForeignHistoricalMergeSource } from './runtimeForeignHistoryMerge';
import { recordRuntimeHistorySettlementConsents } from './runtimeHistoryConvergence';
import { isRuntimeDataRootAdmissionHeld,isRuntimeMaintenanceHeld,withRuntimeDataRootAdmission } from './runtimeHostControl';
import { locateLocalRuntimeDataSet,type LocatedRuntimeRoot } from './runtimeLocatedRoot';
import { MergeAggregatePreflight } from './runtimeMergeAggregatePreflight';
import { MergeContextHandleStates } from './runtimeMergeContextHandleStates';
import { RuntimeMergeConversationExclusions } from './runtimeMergeConversationExclusions';
import { RuntimeMergeSettlementBatch } from './runtimeMergeSettlementBatch';
import { auditRuntimeSnapshot } from './runtimeSnapshotAudit';
import {
createLocatedRuntimeDatabaseSnapshot,requireCompleteRuntimeDataSet,type RuntimeDataSetDatabaseSnapshot
} from './runtimeStorageInspection';
import { RUNTIME_DOMAIN_SCHEMAS } from './schema/domainManifest';
import { toSqliteFilePath } from './sqliteFilePath';
import {
readTimelineMergeSourceIdentity,
TIMELINE_IMPORT_PROVENANCE_DOMAIN,TIMELINE_MERGE_DOMAINS,
timelineMergeSourceRows,type TimelineMergeSourceRow
} from './timelineMergeSource';
import { createVscodeRootAuthority,inspectVscodeRuntimeDataSets,resolveVscodeRuntimeDataSet } from './vscodeRootAuthority';

/** Streamed history convergence. The explicit command prepares sources online, then coordinates
 * all windows and merges each source in one durable maintenance transaction. Discovery, published
 * upgrades, exclusions, source claims and per-source cancellation remain backend responsibilities.
 * No duration estimate, countdown, historical session rate or result cache is maintained. */

/** Source rows compared and appended per chunk (streamed merge and online scan). */
export const RUNTIME_DATA_SET_STREAMED_MERGE_CHUNK_ROWS: number = engine.READ_CHUNK;
const PREPARATION_HEARTBEAT_MS = 10_000;
export { RUNTIME_DATA_SET_MERGE_PREPARATION_STALE_MS };
const SKIP_TABLE = 'limcode_merge_skip';
/** An `all` skip rule's owners during one pass (allSkipRule). */
const SKIP_CANDIDATES = 'limcode_merge_skip_candidate';
/** A source's rows the Runtime refuses (invariantRefusal). */
const INVARIANT = 'runtime-data-set-merge-invariant';
/**
 * Page cache of a source snapshot's connection, in KiB, for its main and TEMP databases (SQLite's
 * default here is 16 MiB each): its rows are read once, in order, so the cache does not grow with it.
 */
const SOURCE_PAGE_CACHE_KIB = 2048;
/**
 * Rows of one table a skip rule reads between two yields, in read chunks: the rules do little per row
 * (an index probe), the scan's chunks much more (decode, compare), so a segment is many chunks.
 */
const SKIP_SEGMENT_CHUNKS = 64;

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
  | 'before-merged-record'
  /** Preparation: a heartbeat found a preparation record still this window's, not yet written (detail.candidateId). */
  | 'preparation-heartbeat';

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
  /** Tests: the preparation's heartbeat interval (PREPARATION_HEARTBEAT_MS). */
  heartbeatMs?: number;
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
  snapshot(root: LocatedRuntimeRoot): Promise<HistoricalCasSnapshot>;
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
    async snapshot(root) {
      const candidate = await resolveVscodeRuntimeDataSet(storagePaths, root.id);
      const files = await runtimeDataSetFileState(root.located.databasePath);
      return engine.withLocalPackedSnapshot(candidate, locatedBinding(root), await createLocatedRuntimeDatabaseSnapshot(root), files);
    }
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
 * private snapshot connection instead of in memory, a segment of `chunkRows` × SKIP_SEGMENT_CHUNKS rows
 * at a time (closeOver). True when rows are left out (see skipWhere).
 */
async function prepareSkippedRows(
  source: Database.Database,
  target: RuntimeDatabase,
  merged: readonly string[],
  state: HistoricalMergeSourceProgress,
  chunkRows: number
): Promise<boolean> {
  const deleted = merged.length > 0 ? await engine.deletedSinceMerge(source, target, merged) : undefined;
  state.skippedConversations = deleted?.count ?? 0;
  state.skippedConversationIds = deleted ? [...deleted.conversations].sort() : [];
  withTemporaryWrites(source, () => source.exec(`DROP TABLE IF EXISTS temp.${SKIP_TABLE}`));
  if (!deleted && !state.excluded?.length) return false;
  seedSkipTable(source, [...(deleted?.conversations ?? []), ...(state.excluded?.map(row => row.conversationId) ?? [])]);
  await closeOver(source, chunkRows * SKIP_SEGMENT_CHUNKS);
  return true;
}

/** The skipped rows prepareSkippedRows left in the snapshot, by domain. */
function skippedRowsOf(source: Database.Database): Map<string, Set<string>> {
  const skipped = new Map<string, Set<string>>();
  for (const [domain, id] of source.prepare(`SELECT domain, id FROM temp.${SKIP_TABLE}`).raw().iterate() as IterableIterator<[string, string]>) {
    let ids = skipped.get(domain);
    if (!ids) skipped.set(domain, ids = new Set());
    ids.add(id);
  }
  return skipped;
}

/**
 * Rechecks only kept work in the audit worker. Private TEMP keys are exported in bounded pages,
 * with no JS map and no second copy of the Runtime database. The source snapshot then
 * closes its sole reader until the worker has closed and exited; it cannot be used during the wait.
 * @internal Also exercised directly by the large-source responsiveness regression.
 */
export async function reinspectLargeMergeKeptWork(
  snapshot: RuntimeDataSetDatabaseSnapshot,
  signal?: AbortSignal
): Promise<UnfinishedWorkInspection> {
  const source = snapshot.database;
  if (!source.readonly || source.inTransaction) throw new Error('Kept-work recheck requires an idle read-only snapshot.');
  signal?.throwIfAborted();
  const directory = await mkdtemp(path.join(os.tmpdir(), `limcode-runtime-history-${process.pid}-`));
  const skippedRowsPath = path.join(directory, 'skipped.sqlite');
  try {
    await exportSkippedKeys(source, skippedRowsPath, signal);
    signal?.throwIfAborted();
    const audit = await snapshot.withClosedReader((snapshotPath) => auditRuntimeSnapshot(snapshotPath, {
      binding: snapshot.binding as RootBinding, unfinishedWork: 'finalize', integrity: false, skippedRowsPath
    }));
    signal?.throwIfAborted();
    return audit.unfinishedWork!;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch((error: unknown) => {
      // The audit/stop outcome is already decided. A scanner holding its disposable index must
      // not turn that into a new merge failure; report the disposable files left in the temp directory.
      console.warn('[LimCode] 历史重检的临时跳过索引没有删掉，留在临时目录里。', error);
    });
  }
}

/** A disposable transport index, never a Runtime root, backup, receipt or recovery authority. */
async function exportSkippedKeys(source: Database.Database, skippedRowsPath: string, signal?: AbortSignal): Promise<void> {
  const index = new Database(toSqliteFilePath(skippedRowsPath));
  try {
    // Backup API's final destination fsync can synchronously stall the window for the full index.
    // This derived index may be discarded after a crash; only its fully written, closed file is used.
    index.pragma('journal_mode = OFF');
    index.pragma('synchronous = OFF');
    index.pragma(`cache_size = -${SOURCE_PAGE_CACHE_KIB}`);
    index.exec(`CREATE TABLE ${SKIP_TABLE} (domain TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(domain,id)) WITHOUT ROWID`);
    const page = source.prepare(`SELECT domain, id FROM temp.${SKIP_TABLE}
      WHERE (domain, id) > (?, ?) ORDER BY domain, id LIMIT ${RUNTIME_DATA_SET_STREAMED_MERGE_CHUNK_ROWS}`);
    const insert = index.prepare(`INSERT INTO ${SKIP_TABLE} VALUES (?, ?)`);
    const append = index.transaction((rows: Array<{ domain: string; id: string }>) => {
      for (const row of rows) insert.run(row.domain, row.id);
    });
    let domain = '', id = '';
    for (;;) {
      signal?.throwIfAborted();
      const rows = page.all(domain, id) as Array<{ domain: string; id: string }>;
      if (rows.length === 0) return;
      append(rows);
      ({ domain, id } = rows[rows.length - 1]!);
      await yieldThread();
    }
  } finally { index.close(); }
}

function seedSkipTable(source: Database.Database, conversations: Iterable<string>): void {
  withTemporaryWrites(source, () => {
    source.exec(`CREATE TEMP TABLE ${SKIP_TABLE} (domain TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY (domain, id)) WITHOUT ROWID`);
    const seed = source.prepare(`INSERT OR IGNORE INTO temp.${SKIP_TABLE} (domain, id) VALUES ('Conversation', ?)`);
    for (const id of conversations) seed.run(id);
  });
}

/** Where the closure gives the thread back: after a segment of a one-table rule, or a step of an `all` rule. */
type SkipClosureYield = (step: 'rule' | 'all') => Promise<void>;

/**
 * @internal Tests: the closure as a preparation computes it (segments of `segmentRows`, `pause` at
 * every yield) from the left-out `conversations` of a source connection, as domain → ids.
 */
export async function largeMergeSkippedRows(
  source: Database.Database,
  conversations: Iterable<string>,
  segmentRows: number,
  pause?: SkipClosureYield
): Promise<Map<string, Set<string>>> {
  withTemporaryWrites(source, () => source.exec(`DROP TABLE IF EXISTS temp.${SKIP_TABLE}`));
  seedSkipTable(source, conversations);
  try {
    await closeOver(source, segmentRows, pause);
    return skippedRowsOf(source);
  } finally {
    withTemporaryWrites(source, () => source.exec(`DROP TABLE IF EXISTS temp.${SKIP_TABLE}; DROP TABLE IF EXISTS temp.${SKIP_CANDIDATES}`));
  }
}

/**
 * Runs the skip rules to their fixed point without holding this thread (review #7 and blind review
 * #4: the closure of a large source took seconds of the window's thread). A rule that reads one table
 * (`FROM "<table>" AS t WHERE …`) reads it in rowid segments of `segmentRows`; an `all` rule works
 * from its candidates (allSkipRule), a bounded step at a time; the thread yields after every segment
 * and step. Every rule only adds, and an `all` rule adds in a pass exactly what its GROUP BY form adds
 * (see allSkipRule), so the fixed point is the online merge's (skippedRows).
 */
async function closeOver(source: Database.Database, segmentRows: number, pause: SkipClosureYield = () => yieldThread()): Promise<void> {
  const runs = skipRules().map((rule) => typeof rule === 'string'
    ? segmentedRule(source, rule, segmentRows, pause)
    : allSkipRule(source, rule, segmentRows, pause));
  try {
    for (;;) {
      let added = 0;
      for (const run of runs) added += await run();
      if (added === 0) return;
    }
  } finally {
    withTemporaryWrites(source, () => source.exec(`DROP TABLE IF EXISTS temp.${SKIP_CANDIDATES}`));
  }
}

function segmentedRule(source: Database.Database, sql: string, segmentRows: number, pause: SkipClosureYield): () => Promise<number> {
  const scanned = /\bFROM ("(?:[^"]|"")+") AS t\s+WHERE\b/.exec(sql);
  if (!scanned) throw new Error('A skip rule reads one table (FROM "<table>" AS t WHERE …).');
  // NOT INDEXED: the rowid range is the scan (an index on the rule's column would be read whole per segment).
  const segment = source.prepare(`${sql.replace(scanned[0], `FROM ${scanned[1]} AS t NOT INDEXED WHERE`)} AND t.rowid > ? AND t.rowid <= ?`);
  const last = Number(source.prepare(`SELECT COALESCE(MAX(rowid), 0) FROM ${scanned[1]}`).pluck().get());
  return async () => {
    let added = 0;
    for (let after = 0; after < last; after += segmentRows) {
      added += withTemporaryWrites(source, () => segment.run(after, after + segmentRows).changes);
      await pause('rule');
    }
    return added;
  };
}

/**
 * One pass of an `all` rule (an owner goes once every membership naming it is a left-out row) in
 * bounded steps, instead of one GROUP BY over every membership table (seconds on a large source):
 *   1. candidates: the owners (not left out yet) of the left-out member rows, a page of `segmentRows`
 *      left-out ids at a time (each looked up by its primary key);
 *   2. every candidate with a membership that is not left out is dropped: by an index on the member
 *      column, `segmentRows` candidates at a time, else by the member table in rowid segments;
 *   3. the remaining candidates are left out, `segmentRows` at a time.
 * The left-out rows are read as they were before step 3, as the GROUP BY statement reads them before
 * its inserts: the same owners are added.
 */
function allSkipRule(source: Database.Database, rule: AllSkipRule, segmentRows: number, pause: SkipClosureYield): () => Promise<number> {
  const skipped = (domain: string, id: string): string =>
    `EXISTS (SELECT 1 FROM temp.${SKIP_TABLE} AS s WHERE s.domain = ${literal(domain)} AND s.id = ${id})`;
  const run = (statement: Database.Statement, ...parameters: unknown[]): number => withTemporaryWrites(source, () => statement.run(...parameters).changes);
  withTemporaryWrites(source, () => source.exec(`CREATE TEMP TABLE IF NOT EXISTS ${SKIP_CANDIDATES} (owner TEXT NOT NULL UNIQUE)`));
  const candidates = source.prepare(`SELECT COALESCE(MAX(rowid), 0) FROM temp.${SKIP_CANDIDATES}`).pluck();
  const clear = source.prepare(`DELETE FROM temp.${SKIP_CANDIDATES}`);
  const members = rule.members.map(({ domain, column, table }) => {
    const member = quoteIdentifier(table);
    const owner = `t.${quoteIdentifier(column)}`;
    const page = `SELECT id FROM temp.${SKIP_TABLE} WHERE domain = ${literal(domain)} AND id > ? ORDER BY id LIMIT ?`;
    const indexed = leadsIndex(source, table, column);
    return {
      pageEnd: source.prepare(`SELECT MAX(id) FROM (${page})`).pluck(),
      collect: source.prepare(`INSERT OR IGNORE INTO temp.${SKIP_CANDIDATES} (owner)
        SELECT ${owner} FROM (${page}) AS page JOIN ${member} AS t ON t.id = page.id
         WHERE ${owner} IS NOT NULL AND NOT ${skipped(rule.domain, owner)}`),
      indexed,
      last: indexed ? 0 : Number(source.prepare(`SELECT COALESCE(MAX(rowid), 0) FROM ${member}`).pluck().get()),
      keep: indexed
        ? source.prepare(`DELETE FROM temp.${SKIP_CANDIDATES} AS c WHERE c.rowid > ? AND c.rowid <= ?
            AND EXISTS (SELECT 1 FROM ${member} AS t WHERE ${owner} = c.owner AND NOT ${skipped(domain, 't.id')})`)
        : source.prepare(`DELETE FROM temp.${SKIP_CANDIDATES} WHERE owner IN (
            SELECT ${owner} FROM ${member} AS t NOT INDEXED WHERE ${owner} IS NOT NULL AND NOT ${skipped(domain, 't.id')}
               AND t.rowid > ? AND t.rowid <= ?)`)
    };
  });
  const insert = source.prepare(`INSERT OR IGNORE INTO temp.${SKIP_TABLE} (domain, id)
    SELECT ${literal(rule.domain)}, owner FROM temp.${SKIP_CANDIDATES} WHERE rowid > ? AND rowid <= ?`);
  return async () => {
    run(clear);
    for (const member of members) {
      for (let after: string | null = ''; after !== null;) {
        run(member.collect, after, segmentRows);
        after = member.pageEnd.get(after, segmentRows) as string | null;
        await pause('all');
      }
    }
    let last = Number(candidates.get());
    for (const member of members) {
      if (last === 0) break;
      const end = member.indexed ? last : member.last;
      for (let after = 0; after < end; after += segmentRows) {
        run(member.keep, after, after + segmentRows);
        await pause('all');
      }
      last = Number(candidates.get());
    }
    let added = 0;
    for (let after = 0; after < last; after += segmentRows) {
      added += run(insert, after, after + segmentRows);
      await pause('all');
    }
    run(clear);
    return added;
  };
}

/** Whether `column` leads an index of `table` that holds every row (a partial one does not). */
function leadsIndex(source: Database.Database, table: string, column: string): boolean {
  const indexes = source.pragma(`main.index_list(${quoteIdentifier(table)})`) as Array<{ name: string; partial: number | bigint }>;
  return indexes.some((index) => Number(index.partial) === 0
    && (source.pragma(`main.index_info(${quoteIdentifier(index.name)})`) as Array<{ seqno: number | bigint; name: string | null }>)
      .some((entry) => Number(entry.seqno) === 0 && entry.name === column));
}

function yieldThread(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface AllSkipRule {
  domain: string;
  members: Array<{ domain: string; column: string; table: string }>;
}

/**
 * The skippedRows rules over the TEMP table (one fixed-point pass each): INSERT … SELECT statements
 * that read one table, and the `all` rules (allSkipRule).
 */
function skipRules(): Array<string | AllSkipRule> {
  const identity = engine.IDENTITY_MERGE_DIFFERENCES;
  const domainOf = new Map(RUNTIME_DOMAIN_SCHEMAS.map((schema) => [schema.table, schema.key]));
  const tableOf = new Map(RUNTIME_DOMAIN_SCHEMAS.map((schema) => [schema.key, schema.table]));
  const skipped = (domain: string, id: string): string =>
    `EXISTS (SELECT 1 FROM temp.${SKIP_TABLE} AS s WHERE s.domain = ${literal(domain)} AND s.id = ${id})`;
  const rules: Array<string | AllSkipRule> = [];
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
      rules.push(`INSERT OR IGNORE INTO temp.${SKIP_TABLE} (domain, id)
        SELECT ${literal(schema.key)}, t.id FROM ${quoteIdentifier(schema.table)} AS t
         WHERE t.${quoteIdentifier(column)} IS NOT NULL${kind ? ` AND t.${quoteIdentifier(kind[0])} = ${literal(kind[1])}` : ''}
           AND ${skipped(owner, `t.${quoteIdentifier(column)}`)}`);
    }
  }
  for (const rule of engine.SKIPPED_WITH_MEMBERS) {
    const members = rule.members.map(([domain, column]) => ({ domain, column, table: tableOf.get(domain)! }));
    if (rule.mode === 'any') {
      for (const { domain, column, table } of members) {
        rules.push(`INSERT OR IGNORE INTO temp.${SKIP_TABLE} (domain, id)
          SELECT ${literal(rule.domain)}, t.${quoteIdentifier(column)} FROM ${quoteIdentifier(table)} AS t
           WHERE t.${quoteIdentifier(column)} IS NOT NULL AND ${skipped(domain, 't.id')}`);
      }
      continue;
    }
    rules.push({ domain: rule.domain, members });
  }
  return rules;
}

function boundSourcePageCache(source: Database.Database): void {
  for (const schema of ['main', 'temp']) source.pragma(`${schema}.cache_size = -${SOURCE_PAGE_CACHE_KIB}`);
}

/** The read of one domain's source rows in merge order, without the left-out rows. */
function sourceRowsSql(schema: (typeof RUNTIME_DOMAIN_SCHEMAS)[number]): string {
  // Filtering in SQL can synchronously scan millions of skipped rows before returning the first
  // kept row. Read every physical row in the original merge order and bound that work below.
  return engine.mergeReadSql(schema);
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
  /**
   * What the Runtime worker would refuse at the commit, found by its own aggregate assertion
   * (runtimeModelRequestAggregate) on the effective kept-source/target aggregate. Both orphan
   * operations and added attempts on existing requests are checked; counts cover the compared rows.
   */
  refusedAggregate?: string;
  elapsedMs: number;
}

interface ChunkedRowsOptions {
  skipping: boolean;
  chunkRows: number;
  signal?: AbortSignal;
  exclusions?: RuntimeMergeConversationExclusions;
  collecting?: boolean;
}

/**
 * Every source row in merge order, decoded by its codec, in chunks with their target rows (read
 * through the target's reader: the committed state, also while a maintenance transaction is open).
 */
async function forEachSourceChunk(
  source: Database.Database,
  target: RuntimeDatabase,
  options: ChunkedRowsOptions,
  visit: (entries: TimelineMergeSourceRow[], existing: Array<DomainRow | null>) => Promise<void>
): Promise<void> {
  if (!Number.isSafeInteger(options.chunkRows) || options.chunkRows < 1) throw new RangeError('chunkRows must be a positive integer.');
  const skipped = options.skipping ? source.prepare(`SELECT 1 FROM temp.${SKIP_TABLE} WHERE domain = ? AND id = ?`) : undefined;
  const visitDomain = async (schema: (typeof RUNTIME_DOMAIN_SCHEMAS)[number]): Promise<void> => {
    options.signal?.throwIfAborted();
    const repository = DOMAIN_REPOSITORIES.domain(schema.key);
    const statement = source.prepare(sourceRowsSql(schema));
    let chunk: DomainRow[] = [];
    let scannedSinceYield = 0;
    const pause = async (): Promise<void> => {
      await yieldThread();
      scannedSinceYield = 0;
      options.signal?.throwIfAborted();
    };
    const flush = async (): Promise<void> => {
      if (chunk.length === 0) return;
      options.signal?.throwIfAborted();
      const existing = (await target.snapshot(chunk.map((row) => repository.get(String(row.id))))).snapshot as Array<DomainRow | null>;
      const rows = chunk;
      chunk = [];
      await visit(rows.map(row => ({ schema, row })), existing);
      // Decoding stays on the extension thread; yield so a large source never monopolizes it.
      await pause();
    };
    for (const raw of statement.iterate() as IterableIterator<Record<string, unknown>>) {
      scannedSinceYield += 1;
      if (options.collecting) options.exclusions?.observe(schema.key, raw);
      if ((!skipped || skipped.get(schema.key, String(raw.id)) === undefined) && !options.exclusions?.includes(schema.key, String(raw.id))) {
        try { chunk.push(engine.sourceRow(schema.key, String(raw.id), () => repository.codec.decode(raw))); }
        catch (error) {
          if (!options.collecting || !options.exclusions) throw error;
          options.exclusions.exclude(schema.key, raw, 'runtime-data-set-merge-source-row-invalid');
        }
        if (chunk.length >= options.chunkRows) await flush();
      }
      // Even an entirely deleted conversation produces pauses and prompt cancellation. The write
      // chunk remains based on kept rows; CollaborationMessage's source sequence order is unchanged.
      if (scannedSinceYield >= RUNTIME_DATA_SET_STREAMED_MERGE_CHUNK_ROWS) await pause();
    }
    await flush();
  };
  for (const schema of engine.MERGE_DOMAIN_ORDER) {
    if (TIMELINE_MERGE_DOMAINS.has(schema.key) || schema.key === TIMELINE_IMPORT_PROVENANCE_DOMAIN) continue;
    await visitDomain(schema);
  }
  let timelineChunk: TimelineMergeSourceRow[] = [];
  let timelineScanned = 0;
  const flushTimeline = async (): Promise<void> => {
    if (timelineChunk.length === 0) return;
    options.signal?.throwIfAborted();
    const existing = (await target.snapshot(timelineChunk.map(({ schema, row }) =>
      DOMAIN_REPOSITORIES.domain(schema.key).get(String(row.id))))).snapshot as Array<DomainRow | null>;
    const entries = timelineChunk;
    timelineChunk = [];
    await visit(entries, existing);
  };
  for (const entry of timelineMergeSourceRows(source, (domain, id) => (!skipped || skipped.get(domain, id) === undefined) && !options.exclusions?.includes(domain, id), options.collecting && options.exclusions ? (domain, raw) => {
    options.exclusions!.observe(domain,raw);
    options.exclusions!.exclude(domain,raw,'runtime-data-set-merge-source-row-invalid');
  } : undefined)) {
    timelineScanned += 1;
    if (options.collecting) options.exclusions?.observe(entry.schema.key, entry.row);
    if (!entry.invalid && (!skipped || skipped.get(entry.schema.key, String(entry.row.id)) === undefined)) timelineChunk.push(entry);
    if (timelineChunk.length >= options.chunkRows) await flushTimeline();
    if (timelineScanned >= RUNTIME_DATA_SET_STREAMED_MERGE_CHUNK_ROWS) {
      await yieldThread();
      timelineScanned = 0;
      options.signal?.throwIfAborted();
    }
  }
  await flushTimeline();
  const provenance = engine.MERGE_DOMAIN_ORDER.find(schema => schema.key === TIMELINE_IMPORT_PROVENANCE_DOMAIN);
  if (provenance) await visitDomain(provenance);
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
 * samples and the time taken. Touched aggregate ids live in a disk-backed temporary table, not an
 * unbounded JS set. The shared preflight validates both directions of model ownership against the
 * target reader and kept source rows; the writer still revalidates at commit against later changes.
 */
export async function scanMergeRows(
  source: Database.Database,
  target: RuntimeDatabase,
  options: { skipping?: boolean; chunkRows?: number; signal?: AbortSignal; onRows?(rows: number): void; exclusions?: RuntimeMergeConversationExclusions; collecting?: boolean } = {}
): Promise<RuntimeDataSetMergeScan> {
  const started = performance.now();
  const timelineImportSource = readTimelineMergeSourceIdentity(source);
  const scan: Omit<RuntimeDataSetMergeScan, 'elapsedMs'> = {
    rows: 0, insertRows: 0, reusedRows: 0, insertConversations: 0, conflicts: { count: 0, samples: [] }
  };
  const aggregates = new MergeAggregatePreflight(source, target, (domain, id) => (!options.skipping
    || source.prepare(`SELECT 1 FROM temp.${SKIP_TABLE} WHERE domain = ? AND id = ?`).get(domain, id) === undefined) && !options.exclusions?.includes(domain,id));
  const counting = countingSink(scan, { next: 0 });
  const sink: RuntimeDataSetMergeChunkSink = {
    ...counting,
    timelineImportSource,
    ...(options.collecting && options.exclusions ? {invalid:(domain:string,row:DomainRow) => options.exclusions?.exclude(domain,row,'runtime-data-set-merge-source-row-invalid')} : {}),
    conflict: (sample, domain, row) => {
      counting.conflict(sample, domain, row);
      if (options.collecting) options.exclusions?.exclude(domain, row, 'runtime-data-set-merge-conflict');
    },
    inserted: (domain, id, row) => {
      counting.inserted(domain, id, row);
      aggregates.touch(domain, row);
    }
  };
  try {
    await forEachSourceChunk(source, target, {
      skipping: options.skipping === true, chunkRows: options.chunkRows ?? RUNTIME_DATA_SET_STREAMED_MERGE_CHUNK_ROWS,
      ...(options.signal ? { signal: options.signal } : {}), exclusions: options.exclusions, collecting: options.collecting
    }, async (entries, existing) => {
      for (const [index, { schema, row }] of entries.entries()) planMergeChunk(schema, [row], [existing[index]], sink);
      sink.steps.length = 0;
      sink.presence.length = 0;
      scan.rows += entries.length;
      options.onRows?.(scan.rows);
    });
    if (options.collecting && options.exclusions?.hasProblems()) await options.exclusions.finish(options.chunkRows);
    if (scan.conflicts.count === 0 || options.collecting) await aggregates.validate(options.signal,
      options.collecting && options.exclusions ? (domain,id,error) => {
        const row = source.prepare('SELECT * FROM model_request WHERE id=?').get(id) as Record<string,unknown> | undefined;
        if (!row) throw error;
        options.exclusions!.exclude(domain,row,'runtime-data-set-merge-invariant');
      } : undefined);
  } catch (error) {
    if (!isRuntimeDataInvariant(error)) throw error;
    return { ...scan, refusedAggregate: engine.errorMessage(error), elapsedMs: performance.now() - started };
  } finally {
    aggregates.close();
  }
  return { ...scan, elapsedMs: performance.now() - started };
}

/**
 * Rows of the source the Runtime does not accept: an aggregate or a historical copy's state its worker
 * asserts, or a UNIQUE constraint of the schema beyond the id (a scan compares ids only). The same
 * again for this source and target: blocked and recorded, so no later startup prepares a session for
 * it; a change of the source, or a request, has it checked again.
 */
function invariantRefusal(detail: string, state: HistoricalMergeSourceProgress): InstanceType<typeof engine.Outcome> {
  return engine.invariantRefusal(detail, state);
}

/**
 * An append or the commit the worker refused for the rows themselves (see invariantRefusal): an error
 * its typed data assertions threw or a constraint of the schema; its transaction is rolled
 * back already. Anything else stays as it is: an error with another code (I/O, a full disk, a busy
 * database, a presence assertion), or one of this thread (a lost worker, a closed instance).
 */
function workerRefusal(error: unknown, state: HistoricalMergeSourceProgress): unknown {
  if (!(error instanceof RuntimeDatabaseWorkerError)) return error;
  if (!isRuntimeDataInvariant(error)) return error;
  return invariantRefusal(error.message, state);
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
 * state and appended with that chunk's presence assertions. A conflict refuses the source at the chunk
 * it is found in: rolled back, the rest of the source not read (every window waits meanwhile), the
 * refusal counting "at least" that chunk's conflicts. Rows the worker refuses are refused too
 * (workerRefusal); any failure or cancellation rolls it back. `beforeCommit` runs after the last chunk.
 */
async function streamMergeTransaction(
  source: Database.Database,
  database: RuntimeDatabase,
  input: ChunkedRowsOptions & {
    evidence: RuntimeDataSetMergeEvidence;
    /** Its commit's marker (the historical merge's mergeCommitMarkerStep), appended after the last chunk. */
    marker: RepositoryTransactionStep;
    state: HistoricalMergeSourceProgress;
    onChunk(chunk: number, rows: number): Promise<void>;
    /** With what the transaction inserts and reuses, right before its commit. */
    beforeCommit(merged: StreamedMerge): Promise<void>;
  }
): Promise<StreamedMerge> {
  const scan: Omit<RuntimeDataSetMergeScan, 'elapsedMs'> = {
    rows: 0, insertRows: 0, reusedRows: 0, insertConversations: 0, conflicts: { count: 0, samples: [] }
  };
  const counting = countingSink(scan, { next: 0 });
  const handleStates = new MergeContextHandleStates(source, database, (domain, id) => (!input.skipping
    || !source.prepare(`SELECT 1 FROM temp.${SKIP_TABLE} WHERE domain = ? AND id = ?`).get(domain, id)) && !input.exclusions?.includes(domain,id));
  const sink: RuntimeDataSetMergeChunkSink = {
    ...counting,
    timelineImportSource: readTimelineMergeSourceIdentity(source),
    inserted: (domain, id, row) => {
      counting.inserted(domain, id, row);
      input.evidence.add(domain, id);
      handleStates.touch(domain, row);
    }
  };
  let open = true;
  let chunk = 0;
  const refused = (error: unknown): never => {
    throw workerRefusal(error, input.state);
  };
  try {
    await database.maintenanceBegin();
    await forEachSourceChunk(source, database, input, async (entries, existing) => {
      for (const [index, { schema, row }] of entries.entries()) planMergeChunk(schema, [row], [existing[index]], sink);
      scan.rows += entries.length;
      const steps: RepositoryTransactionStep[] = [...sink.steps, ...sink.presence];
      sink.steps.length = 0;
      sink.presence.length = 0;
      if (scan.conflicts.count > 0) throw new engine.Outcome(engine.conflictRefusal(scan.conflicts, input.state, true));
      input.signal?.throwIfAborted();
      if (steps.length > 0) await database.maintenanceAppend(steps).catch(refused);
      await input.onChunk(chunk, scan.rows);
      chunk += 1;
    });
    const merged = { rows: scan.rows, inserted: scan.insertRows, reused: scan.reusedRows, insertedConversations: scan.insertConversations };
    if (scan.insertRows === 0) {
      open = false;
      await database.maintenanceRollback();
      return { committed: false, ...merged };
    }
    input.signal?.throwIfAborted();
    await handleStates.append(steps => database.maintenanceAppend(steps).then(() => undefined).catch(refused), input.signal);
    await database.maintenanceAppend([input.marker]).catch(refused);
    await input.beforeCommit({ committed: true, ...merged });
    input.signal?.throwIfAborted();
    open = false;
    await database.maintenanceCommit().catch(refused);
    return { committed: true, ...merged };
  } catch (error) {
    if (open) await database.maintenanceRollback().catch(() => undefined);
    throw error;
  } finally { handleStates.close(); }
}

// ---------------------------------------------------------------------------------------------
// Preparation claims (preparing/<id>.json).
// ---------------------------------------------------------------------------------------------

class PreparationClaims {
  private readonly held = new Map<string, { token: string; startedAt: string }>();
  private timer: NodeJS.Timeout | undefined;
  /** The preparation's target backup while registered (RuntimeLargeMergeTargetBackup); its writes go one after another. */
  private backup: Omit<RuntimeLargeMergeTargetBackup, 'kind' | 'heartbeatAt'> | undefined;
  private backupWrites: Promise<void> = Promise.resolve();
  private refreshing = false;
  /** This process's start identity where it can be read: a record naming a reused pid is not this window's. */
  private readonly identity = ownProcessStartIdentity();

  public constructor(
    private readonly paths: { globalStoragePath: string },
    private readonly heartbeatMs: number = PREPARATION_HEARTBEAT_MS,
    private readonly fault?: LargeMergeEngineOptions['onFaultPoint']
  ) {}

  /** False while another live window prepares or holds the source. */
  public async claim(candidateId: string): Promise<boolean> {
    return withRuntimeDataRootAdmission(this.paths.globalStoragePath, async () => {
      const current = await readRuntimeDataSetMergePreparation(this.paths, candidateId).catch(() => undefined);
      const mine = this.held.get(candidateId);
      if (current && current.token !== mine?.token && isRuntimeDataSetMergePreparationLive(current)) return false;
      const claim = mine ?? { token: randomUUID(), startedAt: new Date().toISOString() };
      await writeRuntimeDataSetMergePreparation(this.paths, {
        candidateId, token: claim.token, processId: process.pid, ...this.processIdentity(),
        startedAt: claim.startedAt, heartbeatAt: new Date().toISOString()
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
    if (this.held.size === 0 && !this.backup) this.stopHeartbeat();
    await withRuntimeDataRootAdmission(this.paths.globalStoragePath, async () => {
      const current = await readRuntimeDataSetMergePreparation(this.paths, candidateId).catch(() => undefined);
      if (current?.token === claim.token) await removeRuntimeDataSetMergePreparation(this.paths, candidateId);
    }).catch(() => undefined);
  }

  public async releaseAll(): Promise<void> {
    for (const candidateId of [...this.held.keys()]) await this.release(candidateId);
  }

  /**
   * Registers the preparation's target backup (`root`, not written yet) on disk, refreshed with the
   * claims' heartbeat: a window that goes away before the session settled it leaves it to the next
   * pruning of preparations (see RuntimeLargeMergeTargetBackup). Throws when the registration cannot
   * be written: the backup is then not taken. A registration left by a backup that failed (its
   * directory already removed) is replaced.
   */
  public async registerBackup(root: string): Promise<void> {
    if (this.backup && this.backup.backupPath !== root) await this.releaseBackup();
    this.backup = {
      name: path.basename(root), backupPath: root, processId: process.pid, ...this.processIdentity(), startedAt: new Date().toISOString(), used: false
    };
    try {
      await this.persistBackup();
    } catch (error) {
      this.backup = undefined;
      throw error;
    }
    this.startHeartbeat();
  }

  /** Before a session's first source: the backup is kept as a pre-merge backup whatever happens to this window. */
  public async backupInUse(): Promise<void> {
    if (!this.backup || this.backup.used) return;
    this.backup = { ...this.backup, used: true };
    await this.persistBackup();
  }

  /**
   * The backup was settled (kept, or removed): its registration goes, after any write still on its
   * way. A backup that could not be removed (`settled` false; no transaction used it) keeps it, no
   * longer refreshed and marked unused again (a session that merged nothing leaves no pre-merge
   * backup): the pruning of preparations removes both once this window is gone.
   */
  public async releaseBackup(settled = true): Promise<void> {
    const backup = this.backup;
    if (!backup) return;
    if (!settled && backup.used) {
      this.backup = { ...backup, used: false };
      await this.persistBackup().catch(() => undefined);
    }
    this.backup = undefined;
    if (this.held.size === 0) this.stopHeartbeat();
    await this.backupWrites;
    if (settled) await removeRuntimeLargeMergeTargetBackup(this.paths, backup.name).catch(() => undefined);
  }

  /** Writes the registration as it is when its turn comes (a heartbeat never writes back an older `used`). */
  private persistBackup(): Promise<void> {
    const write = this.backupWrites.then(async () => {
      if (this.backup) await writeRuntimeLargeMergeTargetBackup(this.paths, { ...this.backup, heartbeatAt: new Date().toISOString() });
    });
    this.backupWrites = write.catch(() => undefined);
    return write;
  }

  private startHeartbeat(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.refresh(); }, this.heartbeatMs);
    this.timer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Only while the record is still ours, checked and written under the configuration admission (a
   * release or another window's claim, both under it, cannot come in between: a record released or
   * taken over is never written back). The beat waits for the admission (another window, or this
   * window's own session, may hold it for minutes) and refreshes as soon as the holder lets go
   * (another window judges the record stale only under the same admission); meanwhile no other beat
   * starts.
   */
  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      if (this.held.size > 0) {
        await withRuntimeDataRootAdmission(this.paths.globalStoragePath, async () => {
          for (const [candidateId, claim] of this.held) {
            const current = await readRuntimeDataSetMergePreparation(this.paths, candidateId).catch(() => undefined);
            if (current?.token !== claim.token) continue;
            await this.fault?.('preparation-heartbeat', { candidateId });
            await writeRuntimeDataSetMergePreparation(this.paths, { ...current, heartbeatAt: new Date().toISOString() }).catch(() => undefined);
          }
        }).catch(() => undefined);
      }
      if (this.backup) await this.persistBackup().catch(() => undefined);
    } finally {
      this.refreshing = false;
    }
  }

  private processIdentity(): { processStartIdentity?: string } {
    return this.identity !== undefined ? { processStartIdentity: this.identity } : {};
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
  /**
   * Needed there during the session: the sources' databases (growth), the largest WAL of one source
   * (its new pages and the target's index pages it rewrites) and a margin (largeMergeTargetBytes).
   */
  targetBytes: number;
  /**
   * Part of targetBytes: the target's index pages the inserts rewrite, measured on the preparation's
   * backup of the target (dbstat), estimated from the target's size where there is none.
   */
  targetIndexBytes: number;
  /** Where the private source copies go (os.tmpdir()). */
  temporaryDirectory: string;
  /** The largest source database with its WAL. */
  temporaryBytes: number;
  /** Where this process's SQLite puts its temporary files (sqliteTemporaryDirectory()). */
  sqliteTemporaryDirectory: string;
  /** SQLite's temporary files: largeMergeSqliteTemporaryBytes of the largest source. */
  sqliteTemporaryBytes: number;
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
  upgradedFromEpoch?: 3 | 4 | 5;
  /** Estimated exclusive time of this source (ms) and its range (RUNTIME_DATA_SET_LARGE_MERGE_ESTIMATE_RANGE). */

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
  /** Largest sum of private source copies retained for the batch's single settlement prompt. */
  preparationTemporaryBytes: number;
  /** Left to the online merge: not above the chosen threshold. */
  small: string[];
  /** The online target backup taken for the session (removed again when no session uses it). */
  backupPath?: string;
  space: LargeMergeSpace;


}

interface PreparationInternals {
  claims: PreparationClaims;
  pickedAt: string;
  requested: boolean;
  earlierBackup?: string;
  /** The target's index pages, measured on this preparation's backup of it. */
  targetIndexBytes?: number;
  options: LargeMergeEngineOptions;
  sources: Map<string, PreparedInternals>;
  released: boolean;
  retainedSnapshots: Map<string, number>;
  peakSnapshotBytes: number;
}

interface PreparedInternals {
  /** A foreign history root's claim is in it (`foreign`), held from this preparation until the session released it. */
  state: HistoricalMergeSourceProgress;
}

const PREPARATIONS = new WeakMap<LargeMergePreparation, PreparationInternals>();

type PreparedOutcome = { kind: 'prepared'; source: PreparedLargeMergeSource } | { kind: 'small' };

/**
 * A preparation that failed as a whole (none of it runs; everything it held is let go of): the reason
 * as the user is told it (a full disk in Chinese, never the system's own text), and how many sources'
 * unfinished work it had closed already (their data did change: “未被修改” would not be true).
 */
export class LargeMergePreparationError extends Error {
  public constructor(public readonly cause: unknown, public readonly finalizedSources: number) {
    super(isDiskFull(cause) ? '磁盘空间不足' : engine.errorMessage(cause));
    this.name = 'LargeMergePreparationError';
  }
}

/**
 * Online preparation of a large-merge session (no claim held for long; every window keeps working).
 * Never throws for a single source: its outcome goes into `report` (and the ledger) as a batch's would;
 * whatever else fails throws a LargeMergePreparationError.
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
  if (sources.length > 0) {
    // Windows gone since leave preparations and unused target backups: removed before this one takes its own.
    await withRuntimeDataRootAdmission(paths.globalStoragePath, () => engine.pruneMergePreparations(paths)).catch(() => undefined);
  }
  const internals: PreparationInternals = {
    claims: new PreparationClaims(paths, options.heartbeatMs, options.onFaultPoint), pickedAt, requested, options, sources: new Map(), released: false, retainedSnapshots: new Map(), peakSnapshotBytes: 0
  };
  const prepared: PreparedLargeMergeSource[] = [];
  const small: string[] = [];
  let finalizedSources = 0;
  let stopPreparing = false;
  const settlements = new RuntimeMergeSettlementBatch<PreparedOutcome | HistoricalMergeSourceOutcome>();
  internals.earlierBackup = sources.length > 0 ? await engine.newestTargetBackup(target).catch(() => undefined) : undefined;
  try {
    for (const [index, picked] of sources.entries()) {
      if (!keepGoing() || stopPreparing) break;
      const candidateId = picked.id;
      const issue = (outcome: { code: string; message: string; awaiting?: { rows: number; bytes: number } }): RuntimeDataSetMergeIssue => ({
        candidateId, code: outcome.code, message: outcome.message, newly: true, requested: picked.requested,
        ...(picked.label ? { label: picked.label } : {})
      });
      /** A full disk stops the preparation (as in the session): the sources after this one are not started. */
      const notStartedAfter = (): void => {
        for (const later of sources.slice(index + 1)) {
          report.deferred.push({
            candidateId: later.id, code: DISK_FULL, message: '前一份准备时磁盘空间不足，这一份没有开始；腾出空间后会再合并。',
            newly: true, requested: later.requested, ...(later.label ? { label: later.label } : {})
          });
        }
      };
      // Writing its preparation record can fail too (no room, I/O): this source's outcome, told as the batch tells it.
      const claimed = await internals.claims.claim(candidateId).catch(async (error: unknown) =>
        engine.sourceOutcome(await diskFull(error, target.controlRoot, '准备合并这份旧聊天记录时', '这次没有合并', undefined, options), {}));
      if (claimed !== true) {
        if (claimed === false) {
          report.deferred.push(issue({ code: 'runtime-data-set-merge-preparing-elsewhere', message: '另一个窗口正在准备合并这份较大的旧聊天记录，由那个窗口完成。' }));
          continue;
        }
        if (claimed.kind === 'stopped') break;
        report.deferred.push(issue(claimed));
        if (claimed.code === DISK_FULL) {
          notStartedAfter();
          break;
        }
        continue;
      }
      const progress = (stage: LargeMergePrepareStage, rows?: number): void => input.onProgress?.({
        stage, candidateId, index, total: sources.length, ...(rows !== undefined ? { rows } : {})
      });
      const mode: HistoricalMergeSourceMode = { finalizeWork: true, requested: picked.requested, pickedAt };
      const sourceInternals: PreparedInternals = { state: {} };
      const held = await holdForeignSource(paths, picked, sourceInternals.state);
      if (held !== true) {
        await internals.claims.release(candidateId);
        if (held.kind !== 'stopped') report.deferred.push(issue(held));
        continue;
      }
      internals.sources.set(candidateId, sourceInternals);
      await settlements.prepare(confirm => engine.runSourceAttempt<PreparedOutcome>(paths, target, candidateId, mode,
        (state) => prepareSource(paths, target, candidateId, mode, state,
          { ...input, options: { ...options, confirmSettlement: confirm } }, progress, internals)
          .catch(async (error: unknown) => { throw await diskFull(error, target.controlRoot, '准备合并这份旧聊天记录时', '这次没有合并', undefined, options); }),
        sourceInternals.state), async outcome => {
        // Its unfinished work was closed by this preparation (whatever came of it): its data changed.
        if (sourceInternals.state.finalized && !sourceInternals.state.finalized.earlier) finalizedSources += 1;
        if (outcome.kind === 'prepared') {
          prepared.push(picked.label ? { ...outcome.source, label: picked.label } : outcome.source);
          internals.sources.set(candidateId, sourceInternals);
          return;
        }
        sourceInternals.state.exclusions?.close();
        await sourceInternals.state.foreign?.release();
        await internals.claims.release(candidateId);
        internals.sources.delete(candidateId);
        if (outcome.kind === 'small') {
          small.push(candidateId);
          return;
        }
        if (outcome.kind === 'stopped') { stopPreparing = true; return; }
        if (outcome.kind === 'merged' || outcome.kind === 'current') {
          const { result } = outcome;
          if (outcome.kind === 'merged' || picked.requested || result.finalized || result.skippedConversations) report.merged.push(result);
          return;
        }
        const refused = issue(outcome);
        if (outcome.kind === 'deferred') {
          report.deferred.push(refused);
          if (outcome.code === DISK_FULL) {
            notStartedAfter();
            stopPreparing = true;
          }
        } else {
          (outcome.kind === 'blocked' ? report.blocked : report.failures).push(refused);
        }
      });
    }
    await settlements.confirm(async request => {
      if (!keepGoing() || stopPreparing || !await options.confirmSettlement?.(request)) return false;
      const agreed = (request.sources ?? [request]).map(item => {
        if (!item.dataSetId || !item.rootInstanceId) throw new Error('合并收尾同意缺少来源身份。');
        return {...item,dataSetId:item.dataSetId,rootInstanceId:item.rootInstanceId};
      });
      await recordRuntimeHistorySettlementConsents(paths,agreed);
      return true;
    }, () => keepGoing() && !stopPreparing);
  } catch (error) {
    // Resume denied continuations and await their snapshot finally blocks before releasing claims.
    await settlements.close();
    // Nothing of it runs: the claims, and the target backup it took for no transaction.
    await releaseHolds(internals);
    await internals.claims.releaseAll();
    await removeUnusedBackup(target.backup.path, target.controlRoot, internals);
    throw new LargeMergePreparationError(error, finalizedSources);
  }
  await settlements.close();
  const sourceOrder = new Map(sources.map((source,index) => [source.id,index]));
  prepared.sort((a,b) => sourceOrder.get(a.candidateId)! - sourceOrder.get(b.candidateId)!);
  if (sources.length > 0) {
    await withRuntimeDataRootAdmission(paths.globalStoragePath, async () => {
      await pruneRuntimeDataSetMergeCommits(paths);
      await engine.pruneMergePreparations(paths);
    }).catch(() => undefined);
  }
  if (!keepGoing() || report.stopped) {
    // Cancelled: nothing of it runs. Released below with the claims and the unused target backup.
    prepared.length = 0;
    small.length = 0;
  }
  const { pendingSources: _pending, ...batch } = report;

  const preparation: LargeMergePreparation = {
    configurationRootPath: target.configurationRootPath,
    targetCandidateId: (await selectedCandidate(paths).catch(() => undefined))?.id ?? '',
    target: target.identity,
    sources: prepared,
    report: batch,
    preparationTemporaryBytes: internals.peakSnapshotBytes,
    small,
    ...(target.backup.path ? { backupPath: target.backup.path } : {}),
    space: await sessionSpace(target, prepared, internals.targetIndexBytes ?? 0)
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
  await removeUnusedBackup(preparation.backupPath, preparation.space.targetDirectory, internals);
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
  for (const source of internals.sources.values()) {
    source.state.exclusions?.close();
    await source.state.foreign?.release();
  }
}

/**
 * The preparation's online target backup, which no transaction used: removed (as settleTargetBackup
 * does), and its registration with it; one that cannot be removed now stays registered for the
 * pruning of preparations.
 */
async function removeUnusedBackup(backupPath: string | undefined, controlRoot: string, internals: PreparationInternals): Promise<void> {
  let removed = true;
  if (backupPath) {
    // Unused, settleTargetBackup only removes it (and syncs its directory); it reads nothing else.
    const target = { controlRoot, backup: { path: backupPath } };
    removed = await engine.settleTargetBackup(target as unknown as HistoricalMergeTargetContext, {
      ...(internals.earlierBackup ? { keep: internals.earlierBackup } : {})
    }).then(() => true, () => false);
  }
  await internals.claims.releaseBackup(removed);
}

/** One source: the online merge's steps up to its commit, with a streamed scan instead of a plan. */
async function prepareSource(
  paths: { globalStoragePath: string },
  target: HistoricalMergeTargetContext,
  candidateId: string,
  mode: HistoricalMergeSourceMode,
  state: HistoricalMergeSourceProgress,
  input: PrepareLargeMergeInput,
  progress: (stage: LargeMergePrepareStage, rows?: number) => void,
  internals: PreparationInternals
): Promise<HistoricalMergeSourceOutcome | PreparedOutcome> {
  const options = input.options ?? {};
  const stopIfAsked = (): void => {
    if (input.signal?.aborted) throw new engine.StopRequested();
  };
  stopIfAsked();
  // Nothing is ever closed in a foreign root: it has no such record (as in the online merge).
  const earlier = state.foreign ? undefined : await readRuntimeDataSetMergeFinalization(paths, await engine.sourceCandidate(paths, candidateId, state));
  if (earlier) {
    state.finalized = {
      turnIds: earlier.turnIds, intentIds: earlier.intentIds, turns: earlier.turns, intents: earlier.intents,
      sourceBackupPath: earlier.sourceBackupPath, complete: earlier.complete, earlier: true,
      ...(earlier.settlement ? {settlement:earlier.settlement} : {})
    };
  }
  const settled = await engine.settledSource(paths, target, candidateId, state);
  if (settled) return settled;
  const { candidate, binding } = await engine.resolveSource(paths, target, candidateId, mode, state);
  const threshold = input.threshold ?? 'in-memory';
  // Audited before in exactly this file state: a source the session does not take is not copied.
  const cached = await engine.cachedAudit(paths, candidate, state);
  if (cached) {
    engine.assertMergeableSize(cached, options, state, true);
    if (!aboveThreshold(cached, threshold, options)) return { kind: 'small' };
  }
  const merged = await engine.recordedConversations(paths, target, candidate);
  const chunkRows = options.chunkRows ?? RUNTIME_DATA_SET_STREAMED_MERGE_CHUNK_ROWS;
  const snapshot = async (): Promise<Awaited<ReturnType<typeof engine.takeVerifiedSnapshot>>> => {
    progress('snapshot');
    const bytes = await sqliteFilesBytes(binding.paths.databasePath) + await casTransferPackedStorageBytes(binding.paths.casRootPath);
    const held = [...internals.retainedSnapshots].reduce((sum, [id, size]) => sum + (id === candidateId ? 0 : size), 0);
    const short = await engine.largeMergeShortDisk({
      targetDirectory: target.controlRoot, targetBytes: engine.BACKUP_FREE_SPACE_MARGIN_BYTES, temporaryDirectory: os.tmpdir(), temporaryBytes: bytes,
      sqliteTemporaryDirectory: await sqliteTemporaryDirectory(), sqliteTemporaryBytes: largeMergeSqliteTemporaryBytes(bytes)
    }, options);
    if (short) throw new engine.Outcome({kind:'deferred',code:DISK_FULL,
      message:`磁盘空间不足：待确认的来源快照合计需要约 ${megabytes(held + bytes)} MB，已有约 ${megabytes(held)} MB 保留在临时目录；${short.path} 还需要约 ${megabytes(short.requiredBytes)} MB。`});
    // Existing retained copies already consume the measured free space. Only the next copy is
    // charged again here; the prompt's total is retained explicitly for estimates and diagnostics.
    internals.retainedSnapshots.set(candidateId, bytes);
    internals.peakSnapshotBytes = Math.max(internals.peakSnapshotBytes, held + bytes);
    return engine.takeVerifiedSnapshot(candidate, binding, 'finalize', state, mode, options, paths).catch(error => {
      internals.retainedSnapshots.delete(candidateId);
      throw error;
    });
  };
  let taken = await snapshot();
  let verified: RuntimeCasVerificationCache | undefined;
  try {
    if (state.finalized?.earlier) engine.countFinalized(taken.snapshot.database, state.finalized);
    engine.assertMergeableSize(taken.audit.size!, options, state, true);
    if (!aboveThreshold(taken.audit.size!, threshold, options)) return { kind: 'small' };
    // What is verified here is kept on disk: the session (or a later preparation) only lstats it.
    verified = await openRuntimeCasVerificationCache(paths.globalStoragePath);
    state.exclusions = new RuntimeMergeConversationExclusions(taken.snapshot.database);
    // What belongs to conversations deleted here since is left out: it neither refuses the source nor is closed.
    const keptWork = async (): Promise<UnfinishedWorkInspection> => {
      const work = taken.audit.unfinishedWork!;
      if (work.refused.length === 0 && !hasFinalizableWork(work)) return work;
      boundSourcePageCache(taken.snapshot.database);
      if (!await prepareSkippedRows(taken.snapshot.database, target.database, merged, state, chunkRows)) return work;
      return reinspectLargeMergeKeptWork(taken.snapshot, input.signal).catch((error: unknown) => {
        if (isAbort(error)) throw new engine.StopRequested();
        throw error;
      });
    };
    stopIfAsked();
    let scanTargetVersion: string;
    const scanSource = async (): Promise<RuntimeDataSetMergeScan> => {
      scanTargetVersion = await engine.mergeTargetVersion(target.database);
      boundSourcePageCache(taken.snapshot.database);
      const skipping = await prepareSkippedRows(taken.snapshot.database, target.database, merged, state, chunkRows);
      progress('scan', 0);
      engine.prepareSettlement(taken.snapshot.database, state);
      for (const id of state.unsettledConversationIds ?? []) {
        state.exclusions!.exclude('Conversation', {id}, 'runtime-data-set-merge-unfinished-work');
      }
      for (const issue of inspectUnfinishedWorkRows(taken.snapshot.database, engine.isForeignCandidate(candidate) || (state.finalized !== undefined && !state.finalized.earlier))) {
        if (!skipping || !taken.snapshot.database.prepare(`SELECT 1 FROM temp.${SKIP_TABLE} WHERE domain=? AND id=?`).get(issue.domain,String(issue.row.id))) {
          state.exclusions!.exclude(issue.domain,issue.row,issue.code);
        }
      }
      let scan = await scanMergeRows(taken.snapshot.database, target.database, {
        skipping, chunkRows, ...(input.signal ? { signal: input.signal } : {}), onRows: (rows) => progress('scan', rows),
        exclusions: state.exclusions, collecting: true
      }).catch((error: unknown) => {
        if (isAbort(error)) throw new engine.StopRequested();
        throw error;
      });
      progress('cas');
      await engine.transferSourceCas(candidate, binding, target, taken.snapshot, options, verified!, true, state.exclusions);
      if (state.exclusions!.hasProblems()) {
        await state.exclusions!.finish(chunkRows);
        state.excluded = state.exclusions!.excluded();
        scan = await scanMergeRows(taken.snapshot.database, target.database, { skipping, chunkRows, signal: input.signal, exclusions: state.exclusions });
      }
      if (scan.refusedAggregate !== undefined) throw invariantRefusal(scan.refusedAggregate, state);
      if (scan.conflicts.count > 0) throw new engine.Outcome(engine.conflictRefusal(scan.conflicts, state));
      return scan;
    };
    let scan = await scanSource();
    const work = await keptWork();
    if (work.refused.length > 0) throw new engine.Outcome(engine.unfinishedWorkOutcome(describeUnfinishedWork(work.refused), state));
    if (hasFinalizableWork(work) || (options.settleSourceWork && state.settlementWork)) {
      // Everything that can refuse the source was checked on the unfinalized snapshot; the CAS
      // objects are verified too. Only then is it backed up and its work closed, and checked again.
      stopIfAsked();
      await engine.fault(options, 'before-source-finalization');
      progress('finalize');
      await engine.finalizeSource(paths, target, candidate, binding, work, state, options, mode, stopIfAsked);
      state.exclusions?.close();
      await taken.snapshot.close();
      taken = await snapshot();
      if (state.finalized) {
        engine.countFinalized(taken.snapshot.database,state.finalized);
        state.finalized.complete &&= !state.unsettledConversationIds?.length;
        await engine.rememberFinalized(paths,candidate,state.finalized);
      }
      state.exclusions = new RuntimeMergeConversationExclusions(taken.snapshot.database);
      state.excluded = undefined;
      scan = await scanSource();
      const remaining = await keptWork();
      if (remaining.refused.length > 0 || hasFinalizableWork(remaining)) {
        throw new engine.Outcome(engine.unfinishedWorkOutcome(describeUnfinishedWork(remaining.refused) || '收尾后仍有未结束的任务', state, true));
      }
      stopIfAsked();
    }
    if (scan.insertRows === 0) {
      // Nothing new (all its rows are here already): recorded as merged at once, as an online merge records it.
      const plan: HistoricalMergeRowPlan = { targetVersion: scanTargetVersion!, steps: [], inserted: [], reused: scan.reusedRows, insertedConversations: 0, conflicts: { count: 0, samples: [] } };
      return await engine.commitSource(paths, target, candidate, binding, plan, undefined, state, options, mode, stopIfAsked);
    }
    progress('backup');
    await engine.ensureTargetBackup(target, options, {
      register: (root) => internals.claims.registerBackup(root),
      // The target's index pages, which the session's inserts rewrite in its WAL: read on the finished copy.
      inspect: async (copy) => {
        internals.targetIndexBytes = (await auditRuntimeSnapshot(copy, { binding: target.binding, integrity: false, indexBytes: true })).indexBytes;
      }
    });
    await engine.fault(options, 'after-target-backup');
    progress('cas');
    const unrecorded = verified.unrecorded();
    const cas = await engine.transferSourceCas(candidate, binding, target, taken.snapshot, options, verified, false, state.exclusions);
    if (verified.unrecorded() > unrecorded) {
      // The session would hash those objects again while every window waits: not this time.
      throw new engine.Outcome({
        kind: 'deferred', code: 'runtime-data-set-merge-verification-unrecorded',
        message: '正文的核验结果没能全部记下（.limcode-runtime-merges 里的核验记录无法写入），为免所有窗口暂停时重新核验这些正文，这份较大的旧聊天记录这次不合并；以后启动时会再合并。'
      });
    }
    await engine.fault(options, 'after-cas-transfer');
    const size = taken.audit.size!;
    const databaseBytes = await sqliteFilesBytes(binding.paths.databasePath)
      + await casTransferPackedStorageBytes(binding.paths.casRootPath);
    const casObjects = taken.audit.content!.objects;
    // Fixed part, copy, stream (the scan's measured rate with the inserts on top), checkpoint (about a copy's worth of writing), lstat per object.

    const finalized = engine.finalizedResult(state).finalized;
    return {
      kind: 'prepared',
      source: {
        candidateId, sourceDataSetId: binding.dataSetId, runtimeDataRootPath: candidate.runtimeDataRootPath,
        fingerprint: state.fingerprint!.contentDigest, rows: size.rows, bytes: size.bytes, databaseBytes,
        insertRows: scan.insertRows, reusedRows: scan.reusedRows, insertConversations: scan.insertConversations,
        skippedConversations: state.skippedConversations ?? 0, casObjects, cas,
        ...(finalized ? { finalized } : {}), ...(state.upgradedFromEpoch !== undefined ? { upgradedFromEpoch: state.upgradedFromEpoch } : {})
      }
    };
  } finally {
    verified?.close();
    await engine.closeSnapshot(taken.snapshot);
    internals.retainedSnapshots.delete(candidateId);
  }
}

function aboveThreshold(size: { rows: number; bytes: number }, threshold: 'in-memory' | 'online', options: LargeMergeEngineOptions): boolean {
  if (threshold === 'online') return engine.exceedsOnlineLimits(size, options);
  return size.rows > (options.sizeLimits?.transactionRows ?? RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS);
}

/** A preparation's space: the target backed up and its index pages measured, the content published already. */
async function sessionSpace(
  target: HistoricalMergeTargetContext,
  sources: ReadonlyArray<{ databaseBytes: number }>,
  targetIndexBytes: number
): Promise<LargeMergeSpace> {
  const largest = sources.reduce((max, source) => Math.max(max, source.databaseBytes), 0);
  return {
    targetDirectory: target.controlRoot,
    targetBytes: largeMergeTargetBytes(sources, targetIndexBytes, engine.BACKUP_FREE_SPACE_MARGIN_BYTES),
    targetIndexBytes: sources.length === 0 ? 0 : targetIndexBytes,
    temporaryDirectory: os.tmpdir(),
    temporaryBytes: largest,
    sqliteTemporaryDirectory: await sqliteTemporaryDirectory(),
    sqliteTemporaryBytes: sources.length === 0 ? 0 : largeMergeSqliteTemporaryBytes(largest)
  };
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
  /** Nothing of the session starts: every source deferred with this reason. */
  const deferAll = (code: string, message: string): LargeMergeSessionResult => {
    for (const source of preparation.sources) {
      results.results.push({
        candidateId: source.candidateId, state: 'deferred',
        issue: { candidateId: source.candidateId, code, message, newly: true, ...(source.label ? { label: source.label } : {}) }
      });
    }
    return results;
  };
  let backupSettled = false;
  try {
    // Every disk the session writes to (the target's, the private copies', SQLite's temporary files'), as the window checked them.
    const short = await engine.largeMergeShortDisk(preparation.space, options);
    if (short) {
      return deferAll(DISK_FULL, `磁盘空间不足，需要约 ${megabytes(short.requiredBytes)} MB：合并较大的旧聊天记录要在 ${short.path} 暂存数据`);
    }
    if (preparation.backupPath) {
      // The pre-merge backup the preparation took: still there, and from now on kept whatever happens to this window.
      if (!await stat(preparation.backupPath).then((info) => info.isDirectory(), () => false)) {
        return deferAll('runtime-data-set-merge-backup-missing', '准备时做的当前历史库备份已经不在了，这次不合并；以后启动时会重新准备。');
      }
      try {
        await internals.claims.backupInUse();
      } catch (error) {
        return isDiskFull(error)
          ? deferAll(DISK_FULL, `磁盘空间不足：合并较大的旧聊天记录前要在 ${paths.globalStoragePath} 记下合并前备份的使用，这次没有合并`)
          : deferAll('runtime-data-set-merge-backup-unrecorded', '无法记下合并前备份的使用，这次没有合并；以后启动时会再合并。');
      }
    }
    const database = await RuntimeDatabase.open(
      createVscodeRootAuthority({ runtimeDataRootPath: selected.runtimeDataRootPath, configurationRootPath: selected.configurationRootPath }),
      { hostBootId: `historical-merge-${randomUUID()}`, maintenance: true, ...(options.workerResourceLimits ? { resourceLimits: options.workerResourceLimits } : {}) }
    );
    const target = engine.targetContext({ configurationRootPath: preparation.configurationRootPath, database });
    if (preparation.backupPath) target.backup = { path: preparation.backupPath };
    const resolver = historicalMergeSources(paths, (candidateId) => internals.sources.get(candidateId)?.state.foreign);
    const clock = new RuntimeHistoryMergeProgress(preparation, input.onProgress);
    let verified: (RuntimeCasVerifier & { close(): void }) | undefined;
    try {
      // The CAS objects the preparation verified and published: unchanged ones are only lstat'ed.
      verified = await openRuntimeCasVerificationCache(paths.globalStoragePath);
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
          (state) => mergePreparedSource(paths, target, resolver, prepared, verified!, state, mode, options, input.signal,
            clock.source(index, prepared), preparation.space.targetIndexBytes)
            .catch(async (error: unknown) => { throw await diskFull(error, target.controlRoot, '合并这份旧聊天记录时', '已撤回这份的写入', prepared, options); }),
          { ...sourceInternals.state });
        clock.sourceDone(prepared);
        const result = sourceResult(prepared.candidateId, outcome, internals.requested, prepared.label);
        results.results.push(result);
        sourceInternals.state.exclusions?.close();
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
      verified?.close();
      // Closing the private instance cannot undo what committed: a failure is logged, the results stand.
      await database.close().catch((error: unknown) => {
        console.warn('[LimCode] 合并较大的旧聊天记录之后关闭私有实例出错；已合并的部分不受影响。', error);
      });
      const used = target.backup.used === true;
      const settled = await engine.settleTargetBackup(target, { ...(internals.earlierBackup ? { keep: internals.earlierBackup } : {}) })
        .then(() => true, () => false);
      backupSettled = true;
      // A used backup stays as the pre-merge backup; an unused one that could not be removed stays
      // registered, as unused again (marked used before the first source), for the pruning to remove.
      await internals.claims.releaseBackup(used || settled);
    }

  } finally {
    internals.released = true;
    await releaseHolds(internals);
    await internals.claims.releaseAll();
    // Nothing ran (no room on the disk, the backup gone, or the private instance did not open): no transaction used it.
    if (!backupSettled) await removeUnusedBackup(preparation.backupPath, preparation.space.targetDirectory, internals);
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

/** Row/stage progress only; no time prediction or persisted rate. */
class RuntimeHistoryMergeProgress {
  private doneRows = 0;
  private lastReport = 0;
  private lastStage = '';
  private readonly startedAt = performance.now();
  private readonly totalRows: number;
  public constructor(private readonly preparation: Pick<LargeMergePreparation, 'sources'>,
    private readonly report?: (progress: LargeMergeSessionProgress) => void) {
    this.totalRows = preparation.sources.reduce((sum, source) => sum + source.rows, 0);
  }
  public source(index: number, prepared: PreparedLargeMergeSource): (stage: LargeMergeSessionStage, rows: number) => void {
    return (stage, rows) => {
      if (!this.report) return;
      const now = performance.now(), key = index + ':' + stage;
      if (key === this.lastStage && now - this.lastReport < 200) return;
      this.lastStage = key; this.lastReport = now;
      this.report({ stage, candidateId: prepared.candidateId, index, total: this.preparation.sources.length,
        rows, sourceRows: prepared.rows, sessionRows: this.doneRows + Math.min(rows, prepared.rows),
        sessionTotalRows: this.totalRows, elapsedMs: Math.round(now - this.startedAt) });
    };
  }
  public sourceDone(prepared: PreparedLargeMergeSource): void { this.doneRows += prepared.rows; }
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
  verified: RuntimeCasVerifier,
  state: HistoricalMergeSourceProgress,
  mode: HistoricalMergeSourceMode,
  options: LargeMergeEngineOptions,
  signal: AbortSignal | undefined,
  progress: (stage: LargeMergeSessionStage, rows: number) => void,
  targetIndexBytes: number
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
      done.outcome = await mergeLocked(paths, target, resolver, root, prepared, verified, state, mode, options, signal, progress, targetIndexBytes);
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
  verified: RuntimeCasVerifier,
  state: HistoricalMergeSourceProgress,
  mode: HistoricalMergeSourceMode,
  options: LargeMergeEngineOptions,
  signal: AbortSignal | undefined,
  progress: (stage: LargeMergeSessionStage, rows: number) => void,
  targetIndexBytes: number
): Promise<HistoricalMergeSourceOutcome> {
  const { candidateId } = prepared;
  await resolver.assertUnchanged(root, { paths, target, state, mode });
  const candidate = await resolver.candidate(root);
  const previous = (await readRuntimeDataSetMergeLedger(paths)).get(candidateId);
  engine.assertNoCommitElsewhere(previous, target);
  if ((previous?.state === 'committing' || previous?.state === 'merged' || previous?.state === 'partial') && sameRuntimeDataSetIdentity(previous.target, target.identity)) {
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
    const chunkRows = options.chunkRows ?? RUNTIME_DATA_SET_STREAMED_MERGE_CHUNK_ROWS;
    const skipping = await prepareSkippedRows(copy.database, target.database, merged, state, chunkRows);
    // Published online with their verified identities: unchanged objects are only lstat'ed here.
    const cas = await engine.transferSourceCas(candidate, locatedBinding(root), target, copy, options, verified, false, state.exclusions);
    await engine.fault(options, 'after-cas-transfer');
    const result: RuntimeDataSetMergeResult = {
      ...engine.unchangedResult(candidate, target), ...cas,
      ...(target.backup.path ? { backupPath: target.backup.path } : {}),
      ...(state.upgradedFromEpoch !== undefined ? { upgradedFromEpoch: state.upgradedFromEpoch } : {}),
      ...(state.skippedConversations ? { skippedConversations: state.skippedConversations } : {}),
      exclusive: true, ...(state.excluded?.length ? { excluded: state.excluded } : {})
    };
    const evidence = new RuntimeDataSetMergeEvidence();
    const skipped = state.skippedConversations ? { skippedConversations: state.skippedConversations } : {};
    const record = (inserted: StreamedMerge) => ({
      candidateId, ...(state.excluded?.length ? { state: 'partial' as const, excluded: state.excluded } : { state: 'merged' as const }), source: state.fingerprint!, target: target.identity,
      mergedAt: new Date().toISOString(), insertedRows: inserted.inserted, reusedRows: inserted.reused,
      insertedConversations: inserted.insertedConversations, insertedConversationIds: evidence.conversationIds, ...skipped
    });
    // The evidence is completed right before the commit (until then it names nothing); whether the
    // commit happened is read off its marker alone, so a crash before it puts the replaced record back.
    const commitId = await writeRuntimeDataSetMergeCommit(paths, [], { insertedRows: 0, reusedRows: 0 });
    await writeRuntimeDataSetMergeLedgerRecord(paths, {
      candidateId, state: 'committing', source: state.fingerprint!, target: target.identity, ...(state.excluded?.length ? { excluded: state.excluded } : {}), commitId, ...(previous ? { replaced: previous } : {}), ...skipped
    });
    const backupUsed = target.backup.used === true;
    target.backup.used = true;
    await options.onFaultPoint?.('after-committing', { candidateId });
    // What this transaction wrote so far, for the space it turns out to need (the WAL grows with it),
    // and what it counted once it got to its commit (for a commit whose reply was lost).
    const written: { rows: number; counted?: StreamedMerge } = { rows: 0 };
    const walBytes = (): Promise<number> => stat(`${target.binding.paths.databasePath}-wal`).then((info) => info.size, () => 0);
    let streamed: StreamedMerge;
    try {
      progress('merging', 0);
      streamed = await streamMergeTransaction(copy.database, target.database, {
        skipping, chunkRows, ...(signal ? { signal } : {}), exclusions: state.exclusions, evidence, marker: engine.mergeCommitMarkerStep(commitId), state,
        onChunk: async (chunk, rows) => {
          written.rows = rows;
          progress('merging', rows);
          await options.onFaultPoint?.('after-chunk', { candidateId, chunk });
          // Nearly full: rolled back now, before the disk is full for every other program too.
          const free = await (options.freeSpace ?? engine.freeSpace)(target.controlRoot).catch(() => undefined);
          if (free !== undefined && free < engine.BACKUP_FREE_SPACE_MARGIN_BYTES) {
            const need = measuredNeed(prepared, targetIndexBytes, rows, await walBytes());
            throw new engine.Outcome({
              kind: 'deferred', code: DISK_FULL,
              message: `磁盘空间快满了（${target.controlRoot} 只剩约 ${megabytes(free)} MB）：按已写入的部分推算，合并这份旧聊天记录需要约 ${megabytes(need)} MB，已提前撤回这份的写入`
            });
          }
        },
        beforeCommit: async (counted) => {
          await options.onFaultPoint?.('after-last-chunk', { candidateId });
          progress('committing', prepared.rows);
          written.counted = counted;
          await writeRuntimeDataSetMergeCommit(paths, evidence.rows(), { insertedRows: counted.inserted, reusedRows: counted.reused }, commitId);
          await options.onFaultPoint?.('before-commit', { candidateId });
        }
      });
    } catch (error) {
      // One transaction, all of it or none: its marker tells which (only its reply was lost, or it was rolled back).
      const committed = await engine.mergeCommitCommitted(commitId, target.database).catch(() => undefined);
      if (committed === false) {
        target.backup.used = backupUsed;
        await restoreReplaced(paths, candidateId, previous);
        await removeRuntimeDataSetMergeCommit(paths, commitId).catch(() => undefined);
      }
      if (committed !== true) {
        const wal = await walBytes();
        // Before anything is given back: a temporary directory full while the target's disk is not.
        const temporary = isDiskFull(error) ? await fullTemporaryDirectory(target.controlRoot, prepared, options) : undefined;
        // The rolled-back transaction's WAL is given back to the disk.
        await target.database.maintenanceCheckpoint().catch(() => undefined);
        throw streamFailure(error, prepared, target, measuredNeed(prepared, targetIndexBytes, written.rows, wal), temporary);
      }
      // Its marker is there: the transaction committed, so it got to its commit and counted.
      streamed = written.counted!;
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
    await engine.closeSnapshot(copy);
  }
}

async function restoreReplaced(
  paths: { globalStoragePath: string },
  candidateId: string,
  previous: Awaited<ReturnType<typeof readRuntimeDataSetMergeLedger>> extends Map<string, infer R> ? R | undefined : never
): Promise<void> {
  await engine.restoreLedgerRecord(paths, candidateId, previous);
}

/**
 * A failed streamed transaction (rolled back): a refusal as it is, a cancellation, a full disk (with
 * the space `need`ed as measured on the target's disk, or where a full temporary directory was and
 * what it needs; never the system's own text), anything else deferred.
 */
function streamFailure(
  error: unknown,
  prepared: PreparedLargeMergeSource,
  target: HistoricalMergeTargetContext,
  need: number,
  temporary?: FullTemporaryDirectory
): unknown {
  if (error instanceof engine.Outcome) return error;
  if (isAbort(error)) {
    return new engine.Outcome({ kind: 'deferred', code: RUNTIME_DATA_SET_MERGE_CANCELLED, message: '合并已取消，这份旧聊天记录没有合并（之前合并完的库保留）；以后可以再合并。' });
  }
  if (isDiskFull(error)) {
    return new engine.Outcome({
      kind: 'deferred', code: DISK_FULL,
      message: temporary
        ? `磁盘空间不足，需要约 ${megabytes(temporary.needBytes)} MB：合并这份旧聊天记录要在${temporary.label}（${temporary.path}）暂存数据，已撤回这份的写入`
        : `磁盘空间不足，需要约 ${megabytes(need)} MB：合并这份旧聊天记录要在 ${target.controlRoot} 暂存数据，已撤回这份的写入`
    });
  }
  return new engine.Outcome({ kind: 'deferred', code: engine.errorCode(error), message: `写入当前库时出错，稍后重试：${engine.errorMessage(error)}` });
}

/**
 * Space one source needs on the target's disk: the size model (largeMergeTargetBytes), or more when
 * the WAL its transaction wrote for its first `rows` rows says so (projected over all of them).
 */
function measuredNeed(prepared: PreparedLargeMergeSource, targetIndexBytes: number, rows: number, walBytes: number): number {
  const modelled = largeMergeTargetBytes([prepared], targetIndexBytes, engine.BACKUP_FREE_SPACE_MARGIN_BYTES);
  if (rows <= 0 || walBytes <= 0) return modelled;
  const projectedWal = (walBytes / rows) * Math.max(rows, prepared.rows);
  return Math.ceil(Math.max(modelled, prepared.databaseBytes + projectedWal + engine.BACKUP_FREE_SPACE_MARGIN_BYTES));
}

interface FullTemporaryDirectory {
  label: string;
  path: string;
  /** What a source needs there: its private copy (the temporary directory), SQLite's temporary files, a margin. */
  needBytes: number;
}

/**
 * Where a full disk that named no file (SQLite's own) most likely was when the target's disk still
 * has room: SQLite's temporary directory or the private copies' (os.tmpdir()), whichever has less than
 * the margin left. Undefined when the target's disk is nearly full too, or none of them is.
 */
async function fullTemporaryDirectory(
  targetDirectory: string,
  source: { databaseBytes: number },
  options: Pick<LargeMergeEngineOptions, 'freeSpace'>
): Promise<FullTemporaryDirectory | undefined> {
  const margin = engine.BACKUP_FREE_SPACE_MARGIN_BYTES;
  const free = (directory: string): Promise<number | undefined> => (options.freeSpace ?? engine.freeSpace)(directory).catch(() => undefined);
  const targetFree = await free(targetDirectory);
  if (targetFree === undefined || targetFree < margin) return undefined;
  const sqlite = await sqliteTemporaryDirectory();
  const copies = os.tmpdir();
  const oneDisk = await largeMergeDiskDevice(sqlite).then(async (device) => device !== undefined && device === await largeMergeDiskDevice(copies));
  const needs = {
    sqlite: largeMergeSqliteTemporaryBytes(source.databaseBytes) + (oneDisk ? source.databaseBytes : 0),
    copies: source.databaseBytes + (oneDisk ? largeMergeSqliteTemporaryBytes(source.databaseBytes) : 0)
  };
  for (const [directory, label, bytes] of [[sqlite, '数据库临时文件目录', needs.sqlite], [copies, '临时目录', needs.copies]] as const) {
    const left = await free(directory);
    if (left !== undefined && left < margin) return { label, path: directory, needBytes: bytes + margin };
  }
  return undefined;
}

/**
 * A full disk anywhere in a source's steps (ledger records, copies, the transaction) as the outcome a
 * session and a preparation stop at: said in Chinese with where (the file's directory when the error
 * names one, else a full temporary directory, else `directory`), never with the system's own text.
 * Anything else, and an outcome already decided, as it is.
 */
async function diskFull(
  error: unknown,
  directory: string,
  doing: string,
  undone: string,
  source?: { databaseBytes: number },
  options: Pick<LargeMergeEngineOptions, 'freeSpace'> = {}
): Promise<unknown> {
  if (error instanceof engine.Outcome || !isDiskFull(error)) return error;
  const named = engine.writtenDirectory(error, '');
  const where = named !== '' ? named : (await fullTemporaryDirectory(directory, source ?? { databaseBytes: 0 }, options))?.path ?? directory;
  return new engine.Outcome({ kind: 'deferred', code: DISK_FULL, message: `磁盘空间不足：${doing}在 ${where} 写不下了，${undone}；腾出空间后会再合并` });
}

function megabytes(bytes: number): number {
  return Math.max(1, Math.ceil(bytes / (1024 * 1024)));
}

/** A full disk or quota anywhere in the cause chain (the system's own text is never shown for it). */
function isDiskFull(error: unknown): boolean {
  return engine.isDiskFullError(error);
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
