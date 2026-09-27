import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, lstatSync, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Database from 'better-sqlite3';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import { isPathBelow } from '../capabilities/filesystem/pathContainment';
import { storageKeyForDigest } from './contentAddressedStore';
import { RUNTIME_KERNEL_EPOCH, type RootBinding, type RuntimeRootPaths } from './contracts';
import { assertCurrentSchema } from './databaseSchema';
import {
  DOMAIN_REPOSITORIES, HISTORICAL_COPY_DOMAINS, savepoint, type DomainRow, type RepositoryTransactionStep
} from './repositories';
import type { HistoricalRootBinding } from './rootAuthority';
import type { RuntimeDatabase } from './runtimeDatabase';
import {
  describeUnfinishedWork, finalizeUnfinishedWork, hasFinalizableWork, KEPT_MERGE_FINALIZATION_REASON, MERGE_FINALIZATION_REASON,
  type CarriedWorkRefusals, type UnfinishedWorkInspection
} from './runtimeDataSetMergeWork';
import {
  cachedRuntimeDataSetFingerprint, isReadableRuntimeDataSetFingerprint, pruneRuntimeDataSetMergeCommits,
  readRuntimeDataSetMergeCommit, readRuntimeDataSetMergeFinalization, readRuntimeDataSetMergeLedger,
  readRuntimeDataSetMergeRequests, rememberRuntimeDataSetFingerprint, removeRuntimeDataSetMergeCommit, pruneRuntimeDataSetMergePreparations,
  removeRuntimeDataSetMergeFinalization, removeRuntimeDataSetMergeLedgerRecord, removeRuntimeDataSetMergeRequest,
  restoreRuntimeDataSetMergeLedgerRecord, runtimeDataSetFingerprint, runtimeDataSetLastMerge, runtimeDataSetMergedConversations,
  sameRuntimeDataSetFingerprint, sameRuntimeDataSetIdentity, writeRuntimeDataSetMergeCommit, writeRuntimeDataSetMergeFinalization,
  writeRuntimeDataSetMergeLedgerRecord, writeRuntimeDataSetMergeRequest,
  type RuntimeDataSetFingerprint, type RuntimeDataSetIdentity, type RuntimeDataSetMergeLedgerRecord,
  type RuntimeDataSetMergeLedgerRequest
} from './runtimeDataSetMergeLedger';
import { runtimeDataSetFileState } from './runtimeDataSetFacts';
import { upgradeRuntimeDataSet } from './runtimeDataSetUpgrade';
import {
  assertRuntimeHostsOffline, isRuntimeHostsActiveError, withRuntimeDataRootAdmission, withRuntimeMaintenance,
  withRuntimeMaintenanceActivity
} from './runtimeHostControl';
import {
  assertNoSymbolicPath, createRuntimeDataSetDatabaseSnapshot, requireCompleteRuntimeDataSet,
  type RuntimeDataSetDatabaseSnapshot
} from './runtimeStorageInspection';
import { auditRuntimeSnapshot, RuntimeSnapshotAuditError, type RuntimeSnapshotAudit } from './runtimeSnapshotAudit';
import { RUNTIME_DOMAIN_SCHEMAS } from './schema/domainManifest';
import { toSqliteFilePath } from './sqliteFilePath';
import {
  createVscodeRootAuthority, inspectVscodeRuntimeDataSets, isVscodeRuntimeDataSetKept, legacyWorkspaceRuntimeOwnerState,
  resolveVscodeRuntimeDataSet, type VscodeRuntimeDataSetCandidate
} from './vscodeRootAuthority';

/**
 * Historical data-set merge, online. The selected Runtime is already open; a source (another data
 * set of this configuration root) must be offline. Per source: exact published 3/4 upgrade, then,
 * without any claim, a private snapshot checked in a worker (integrity, unfinished work), the row
 * plan with its conflict and size checks and the CAS objects; only a source known to merge has its
 * unfinished work finalized (after a source backup, under its maintenance claim) and is checked
 * again. Last, under configuration admission and the source's maintenance claim, the source and
 * the ledger are checked again and ONE ordinary RuntimeDatabase write transaction of Repository
 * insert steps runs (codec-validated, worker insert invariants apply, other Hosts keep running and
 * see it as an external commit). Sources above the online size limit need the exclusive fallback,
 * which wraps that last step alone. The ledger records every outcome by exact source file state,
 * and the conversations each merge inserted: one the user deleted in the target since is left out
 * of every later merge of that source into it, with everything that belongs to it (skippedRows).
 */

/** One verified online Backup API copy of the target per batch that changes it (target control root). */
export const RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY = 'merge-backups';
/** Backup of a source taken before its unfinished work is finalized (source control root). */
export const RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY = 'merge-source-backups';
/**
 * A recorded merge request keeps its source pending for later startups (a window closed, or the
 * merge was deferred) until it merged, was refused, or this long passed.
 */
export const RUNTIME_DATA_SET_MERGE_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Target backups kept per control root; older ones are removed after a successful batch. */
export const RUNTIME_DATA_SET_MERGE_BACKUP_RETENTION = 3;
/**
 * Online transaction bound: the merge transaction blocks other Hosts' writes, and those have no
 * retry beyond busy_timeout (5 s). Measured with the SQLite worker reusing prepared statements
 * (runtimeStatementCache.ts): ~30 ms + 0.044 ms per source row and ~6 ms per MiB, ~0.2 s at 4,000
 * rows on an idle machine. With the merge, another process writing every 2 ms and six CPU-bound
 * processes all pinned to one core, 3,953 rows commit in ≤1.3 s (the other writer's longest wait
 * ~1.1 s) and 4,000 rows carrying 11.7 MiB in ~1.2 s, well below busy_timeout. Larger sources use
 * the exclusive fallback.
 */
export const RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS = Object.freeze({ maxRows: 4_000, maxBytes: 12 * 1024 * 1024 });
/**
 * Bound of the in-memory single-transaction path, online or exclusive: the plan and the worker's
 * transaction hold every row in memory. With prepared statements reused by the worker a merge
 * measures ~175 MB + 8 KB per row (~30 KB per row before); a 60,000-row source peaked at ~690 MB,
 * below ~1 GB even with a heavier extension host. A larger source is not planned, coordinated,
 * backed up or finalized here: it is deferred as awaiting a large-merge session (every window
 * pauses, one streamed maintenance transaction per source, runtimeDataSetStreamedMerge.ts), with
 * nothing recorded. Data-root migration has no such bound.
 */
export const RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS = 60_000;
/**
 * Hard bound of one historical merge: the streamed maintenance transaction of a large-merge session
 * holds no per-row state (memory does not grow with the rows); its WAL (up to about 1.5 times the
 * source database until the commit's TRUNCATE checkpoint) and its duration do. A larger source is not
 * merged at all and is recorded as too large for this limit (not a failure); a version with another
 * limit, or an older record naming another limit, judges it again.
 */
export const RUNTIME_DATA_SET_STREAMED_MERGE_MAX_ROWS = 20_000_000;
/**
 * Deferral code of a source above the in-memory bound, until a large-merge session merges it; also of
 * an automatic batch's sources above the online bounds while such a source is in the batch (taken along).
 */
export const RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE = 'runtime-data-set-merge-awaiting-exclusive';
/** Internal: a source the batch judges again once every other source was (never reported). */
const POSTPONED_IN_BATCH = 'runtime-data-set-merge-postponed-in-batch';

const MAX_REPORTED_CONFLICTS = 20;

/**
 * Insert order for one transaction with immediate foreign keys: the manifest order, except that a
 * domain moves just past every table it references (three manifest entries reference a later
 * table). Stable, so trigger-sensitive manifest pairs keep their relative order.
 */
const MERGE_DOMAIN_ORDER: readonly (typeof RUNTIME_DOMAIN_SCHEMAS)[number][] = (() => {
  const remaining = [...RUNTIME_DOMAIN_SCHEMAS];
  const placed = new Set<string>();
  const ordered: (typeof RUNTIME_DOMAIN_SCHEMAS)[number][] = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex((schema) => schema.columns.every((column) => {
      const table = column.references?.table;
      return table === undefined || table === schema.table || placed.has(table);
    }));
    if (index < 0) throw new Error('Runtime domain references form a cycle; historical merge cannot order inserts.');
    const [schema] = remaining.splice(index, 1);
    placed.add(schema.table);
    ordered.push(schema);
  }
  return Object.freeze(ordered);
})();
const READ_CHUNK = 250;

/**
 * Content-derived identities. The same id in two data sets is the same content, project or
 * observation; only these columns may differ and the receiving data set keeps its row.
 */
const IDENTITY_MERGE_DIFFERENCES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // id = hash(content_type, sha256, byte_length); storage_key derives from sha256.
  ['ContentObject', new Set(['created_at'])],
  // id = hash(uri); kind/uri must match, name and timestamps are presentation facts.
  ['ProjectContext', new Set(['name', 'created_at', 'updated_at'])],
  // id = hash(sha256, mime type, name).
  ['Attachment', new Set(['created_at'])],
  // id = hash(attachment_id, analysis_profile_sha256): the Runtime reuses an existing observation
  // for that pair instead of observing again, so the receiving data set's observation stays.
  ['AttachmentObservationLink', new Set(['content_object_id', 'created_at'])]
]);

/**
 * Columns renumbered on insert. CollaborationMessage.message_seq is one global, unique ordering
 * key (allocated as MAX + 1); it is not frozen in any JSON, CAS content or other row. Other windows
 * keep allocating it until the merge commits, so the worker allocates each source row's value
 * inside the merge transaction (MAX + 1, in source order), which keeps their relative order.
 */
const RENUMBERED_COLUMNS: ReadonlyMap<string, string> = new Map([['CollaborationMessage', 'message_seq']]);

export type RuntimeDataSetMergeFaultPoint =
  /** A private copy of the source was taken, before it is compared with the source files again. */
  | 'after-snapshot-copy'
  /** Every check passed on the unfinalized copy; the source's claim is taken next. */
  | 'before-source-finalization'
  | 'after-source-backup'
  | 'after-target-backup'
  | 'after-cas-transfer'
  | 'before-row-commit'
  | 'after-row-commit';

export interface RuntimeDataSetMergeOptions {
  /** Test-only crash or change injection at durable boundaries and between checks. */
  onFaultPoint?(point: RuntimeDataSetMergeFaultPoint): void | Promise<void>;
  /** Test-only: free bytes on the disk of `directory` (defaults to fs.statfs; undefined when unknown). */
  freeSpace?(directory: string): Promise<number | undefined>;
  /** Defaults to fs.link; a cross-device or unsupported link falls back to a verified copy. */
  linkFile?(source: string, target: string): Promise<void>;
  /** Defaults to {@link RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS}. */
  limits?: { maxRows: number; maxBytes: number };
  /**
   * Test-only: the in-memory transaction bound and the streamed hard bound (default
   * {@link RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS}, {@link RUNTIME_DATA_SET_STREAMED_MERGE_MAX_ROWS}).
   */
  sizeLimits?: { transactionRows?: number; streamedRows?: number };
}

/** The open Runtime that receives the merge. */
export interface RuntimeDataSetMergeTarget {
  configurationRootPath: string;
  database: RuntimeDatabase;
}

/** `reason` is the user-facing Chinese reason of an abandoned coordination. */
export type RuntimeDataSetExclusiveOutcome = { state: 'completed' } | { state: string; reason?: string };

/** One oversized source that is known to merge now; see coordinateOversized. */
export interface RuntimeDataSetOversizedMerge {
  targetPaths: RuntimeRootPaths;
  /** This window's own Host on the target: it stays open and runs the merge itself. */
  requesterHostBootId: string;
  candidateId: string;
  /** Identity of this work (source and its exact file state), for the coordination backoff. */
  operationKey: string;
  /** The user explicitly asked for this merge (the caller may wait for busy windows). */
  requested: boolean;
  /**
   * Takes configuration admission and then the target's maintenance claim around `body`: the
   * coordination calls it only once every window is ready (see runExclusiveRuntimeMaintenance).
   */
  withLocks<R>(body: () => Promise<R>): Promise<R>;
  /** A failure of `merge` that will fail the same way again, so the coordination may stop retrying it. */
  isDeterministicFailure(error: unknown): boolean;
}

export interface RuntimeDataSetMergeBatchOptions extends RuntimeDataSetMergeOptions {
  /** Stop before the next source when activation ends or its configuration root changes. */
  shouldContinue?(): boolean;
  /** Called once, only when at least one source actually needs work. */
  onWorkStart?(total: number): void;
  /** Awaited before the source is worked on (outside every claim). */
  onSourceStart?(candidate: VscodeRuntimeDataSetCandidate, index: number, total: number): void | Promise<void>;
  /** Restricts the batch, e.g. to a source the user just asked to merge. */
  candidateIds?: readonly string[];
  /**
   * This very call is the user's explicit request to merge the sources in candidateIds (required
   * with it): merged even when kept or merged before, a recorded refusal is tried again, every
   * outcome is reported, and an oversized source's coordination may wait for busy windows. Never
   * inferred from a recorded request: a later startup treats that source as ordinarily pending.
   */
  requested?: boolean;
  /**
   * Exclusive fallback for one source above the online limits, called only after everything that
   * can refuse the source passed (unfinished work, conflicts, CAS objects, which are already
   * transferred) and the target backup exists, outside every claim: ask the other windows of the
   * target to go offline (waiting for busy ones without a lock), then run `merge` inside
   * `input.withLocks`. `merge` is the final re-check of the source and the one row transaction.
   */
  coordinateOversized?(input: RuntimeDataSetOversizedMerge, merge: () => Promise<void>): Promise<RuntimeDataSetExclusiveOutcome>;
}

export interface RuntimeDataSetIntoDatabaseOptions extends RuntimeDataSetMergeOptions {
  /**
   * Data-root migration: the whole data set, normally the selected one after every Host of it went
   * offline, moves into a root under another data directory that then becomes the selected root.
   * Unfinished work is carried unchanged and recovered there as after a crash; a ModelRequest that
   * was receiving a reply and background processes still running (or whose output still sits in
   * the source-local process spool) are refused. Nothing is written to this configuration root's
   * merge ledger: the migration itself decides and records the outcome. Historical merges never
   * set this.
   */
  migration?: boolean;
  /** Objects an earlier online pre-copy verified ({@link precopyRuntimeDataSetCas}); unchanged ones are not hashed again. */
  casVerification?: RuntimeDataSetCasVerification;
  /**
   * Migration only: called with exactly the rows the one row transaction inserts, right before it
   * commits (the migration journals them, so an interrupted undo can tell its own rows apart). A
   * failure stops the merge before the commit.
   */
  beforeCommit?(inserted: ReadonlyArray<readonly [domain: string, id: string]>): Promise<void>;
}

export interface RuntimeDataSetCasTransfer {
  linkedCasObjects: number;
  copiedCasObjects: number;
  reusedCasObjects: number;
}

/** Online pre-copy result: the transfer counts and the verified objects' file identities. */
export interface RuntimeDataSetCasPrecopy extends RuntimeDataSetCasTransfer {
  verification: RuntimeDataSetCasVerification;
}

export interface RuntimeDataSetMergeResult extends RuntimeDataSetCasTransfer {
  candidateId: string;
  sourceDataSetId: string;
  targetDataSetId: string;
  insertedRows: number;
  reusedRows: number;
  insertedConversations: number;
  /** Absent when an interrupted commit was only confirmed. */
  backupPath?: string;
  /** A previous commit was found through its exact id set; rows were not merged again. */
  recoveredCommit: boolean;
  /** The source was upgraded from a published predecessor immediately before merging. */
  upgradedFromEpoch?: 3 | 4;
  /**
   * Unfinished work closed before the merge (source backup kept beside the source): Turns ended as
   * cancelled or interrupted and queued, unsent user messages cancelled, as counted in the source.
   */
  finalized?: { turns: number; intents: number; sourceBackupPath: string };
  /** Merged through the exclusive fallback because the source exceeded the online limits. */
  exclusive?: boolean;
  /**
   * Conversations left out because an earlier merge of this source inserted them into this data set
   * and the user deleted them there since (with everything that belongs to them); counted per
   * deleted conversation, its Subagent conversations included in it.
   */
  skippedConversations?: number;
  /** Nothing new was written: the source is merged into this data set already (已合并，没有新内容). */
  alreadyMerged?: true;
}

export interface RuntimeDataSetMergeIssue {
  candidateId?: string;
  code: string;
  message: string;
  /** False when the same unchanged source state was already reported earlier. */
  newly?: boolean;
  /** The user asked for this merge; its outcome is always reported. */
  requested?: boolean;
  /** Awaiting a large-merge session ({@link RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE}): the audited source size. */
  size?: { rows: number; bytes: number };
}

export interface RuntimeDataSetMergeBatchResult {
  targetCandidateId?: string;
  merged: RuntimeDataSetMergeResult[];
  /** Retried at a later startup: source in use, or too large while other windows stay busy. */
  deferred: RuntimeDataSetMergeIssue[];
  /**
   * Unfinished work without a terminal transition, a conflict with the receiving data set, too many
   * rows for one transaction, or a recorded merge request that ran out.
   */
  blocked: RuntimeDataSetMergeIssue[];
  /** The source itself cannot be merged in its current state (format, drift, integrity). */
  failures: RuntimeDataSetMergeIssue[];
  pendingSources: number;
  stopped: boolean;
}

/** The last merge of a data set, judged against the data sets and source files as they are now. */
export interface RuntimeDataSetMergedFacts {
  mergedAt: string;
  intoCurrent: boolean;
  /** No data set of this configuration root has the target's identity any more (deleted, reset, unreadable). */
  targetMissing: boolean;
  /** Its content differs from the merged state (false while it cannot be read, see sourceUnreadable). */
  changedSinceMerge: boolean;
  /** Its content cannot be read now (e.g. no room for the private copy): whether it changed is unknown. */
  sourceUnreadable?: true;
}

export type RuntimeDataSetMergeState =
  | ({ state: 'merged' } & RuntimeDataSetMergedFacts)
  | { state: 'blocked' | 'failed'; code: string; message: string; lastMerged?: RuntimeDataSetMergedFacts }
  | { state: 'requested'; requestedAt: string; lastMerged?: RuntimeDataSetMergedFacts }
  | { state: 'kept'; lastMerged?: RuntimeDataSetMergedFacts }
  /** Too many rows for one merge transaction in this version (see RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS). */
  | { state: 'too-large'; rows: number; maxRows: number; message: string; lastMerged?: RuntimeDataSetMergedFacts };

export class RuntimeDataSetMergeError extends Error {
  public constructor(public readonly code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'RuntimeDataSetMergeError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

type Refusal = {
  kind: 'deferred' | 'blocked' | 'failed';
  code: string;
  message: string;
  /** Blocked because the source is larger than one transaction may be (recorded as 'too-large'). */
  tooLarge?: { rows: number; maxRows: number };
  /** Deferred until a large-merge session: the audited source size. */
  awaiting?: { rows: number; bytes: number };
};

type SourceOutcome =
  | { kind: 'merged'; result: RuntimeDataSetMergeResult }
  /**
   * Every row is already in the target (or another window merged it meanwhile): nothing new, only
   * reported for an explicit request, closed work or conversations left out (result.alreadyMerged).
   */
  | { kind: 'current'; result: RuntimeDataSetMergeResult }
  /** shouldContinue turned false before this source changed anything; nothing is recorded. */
  | { kind: 'stopped' }
  | Refusal;

interface TargetContext {
  configurationRootPath: string;
  database: RuntimeDatabase;
  binding: RootBinding;
  identity: RuntimeDataSetIdentity;
  controlRoot: string;
  /** This batch's backup; `used` once a row transaction ran that is not proven rolled back. */
  backup: { path?: string; used?: boolean };
}

class Outcome extends Error {
  public constructor(public readonly outcome: Refusal) {
    super(outcome.message);
  }
}

class StopRequested extends Error {}

/** The source files changed while they were being copied; the copy is taken again. */
class SnapshotRaced extends Error {}

/** Another window merged the source into this target after this batch picked it: nothing to report. */
class MergedMeanwhile extends Error {
  public constructor(public readonly result: RuntimeDataSetMergeResult) {
    super('merged meanwhile');
  }
}

/**
 * Merges pending historical data sets of this configuration root into the open selected Runtime.
 * From before this version: every other data set (workspace scopes and the fixed root) is merged
 * once. Data sets the user switched away from in this version, and sources already merged once,
 * merge only on explicit request. Never throws for a single source; each outcome is recorded.
 *
 * Per source, the expensive work holds no claim: private snapshot, worker audit, plan, conflict
 * and size checks, CAS verification and transfer, target backup. Claims are held only to close
 * unfinished work in the source (after every check passed) and for the final re-check plus the one
 * row transaction, which the exclusive coordination of an oversized source wraps alone.
 */
export async function mergeHistoricalDataSetsOnline(
  paths: { globalStoragePath: string },
  targetInput: RuntimeDataSetMergeTarget,
  options: RuntimeDataSetMergeBatchOptions = {}
): Promise<RuntimeDataSetMergeBatchResult> {
  const storagePaths = { globalStoragePath: path.resolve(paths.globalStoragePath) };
  const report: RuntimeDataSetMergeBatchResult = {
    merged: [], deferred: [], blocked: [], failures: [], pendingSources: 0, stopped: false
  };
  const keepGoing = (): boolean => {
    if (options.shouldContinue?.() !== false) return true;
    report.stopped = true;
    return false;
  };
  if (!keepGoing()) return report;
  const target = targetContext(targetInput);
  const { sources, pickedAt } = await pickSources(storagePaths, target, options, report, keepGoing);
  report.pendingSources = sources.length;
  // The newest backup from before this batch is never pruned by it (other windows may add theirs).
  const earlierBackup = sources.length > 0 ? await newestTargetBackup(target).catch(() => undefined) : undefined;
  let started = false;
  const start = async (source: PickedSource, index: number): Promise<void> => {
    if (!started) {
      started = true;
      options.onWorkStart?.(sources.length);
    }
    await options.onSourceStart?.(source.candidate, index, sources.length);
  };
  const settle = async (source: PickedSource, outcome: Exclude<SourceOutcome, { kind: 'stopped' }>): Promise<void> => {
    if (outcome.kind === 'merged' || outcome.kind === 'current') {
      const { result } = outcome;
      if (outcome.kind === 'merged' || source.requested || result.finalized || result.skippedConversations) report.merged.push(result);
      await removeRuntimeDataSetMergeRequest(storagePaths, source.candidate.id).catch(() => undefined);
      return;
    }
    const issue = {
      candidateId: source.candidate.id, code: outcome.code, message: outcome.message, newly: true, requested: source.requested,
      ...(outcome.awaiting ? { size: outcome.awaiting } : {})
    };
    if (outcome.kind === 'deferred') report.deferred.push(issue);
    else {
      (outcome.kind === 'blocked' ? report.blocked : report.failures).push(issue);
      await removeRuntimeDataSetMergeRequest(storagePaths, source.candidate.id).catch(() => undefined);
    }
  };
  // An automatic source above the online bounds (it would be coordinated on its own) waits until every
  // other source was judged: when one of them waits for a large-merge session it goes along (one
  // coordination and one reload for all), else it is merged after them as ever.
  const postponed: Array<{ source: PickedSource; index: number; outcome: Refusal }> = [];
  let stopped = false;
  for (const [index, source] of sources.entries()) {
    if (!keepGoing()) {
      stopped = true;
      break;
    }
    await start(source, index);
    const postponeOversized = !source.requested && options.coordinateOversized !== undefined;
    const outcome = await mergeOneSource(storagePaths, target, source.candidate.id, options,
      { finalizeWork: true, requested: source.requested, pickedAt, ...(postponeOversized ? { postponeOversized } : {}) }, keepGoing);
    if (outcome.kind === 'stopped') {
      stopped = true;
      break;
    }
    if (outcome.kind === 'deferred' && outcome.code === POSTPONED_IN_BATCH) postponed.push({ source, index, outcome });
    else await settle(source, outcome);
  }
  const largeSession = report.deferred.some((issue) => issue.code === RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE);
  for (const { source, index, outcome } of stopped ? [] : postponed) {
    if (largeSession) {
      await settle(source, { ...outcome, code: RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE });
      continue;
    }
    if (!keepGoing()) break;
    await start(source, index);
    const again = await mergeOneSource(storagePaths, target, source.candidate.id, options,
      { finalizeWork: true, requested: source.requested, pickedAt }, keepGoing);
    if (again.kind === 'stopped') break;
    await settle(source, again);
  }
  await settleTargetBackup(target, { keep: earlierBackup }).catch(() => undefined);
  if (sources.length > 0) {
    await withRuntimeDataRootAdmission(storagePaths.globalStoragePath, async () => {
      await pruneRuntimeDataSetMergeCommits(storagePaths);
      // A large-merge preparation of a window that is gone holds nothing any more.
      await pruneRuntimeDataSetMergePreparations(storagePaths);
    }).catch(() => undefined);
  }
  return report;
}

/**
 * The sources a batch works on, in candidate order: read under the configuration admission (ledger,
 * requests, kept markers, file states and cached fingerprints only), a record whose judgment needs a
 * fingerprint that is not cached is judged outside it. Refusals of unchanged sources and expired
 * requests go into `report` as they are found.
 */
async function pickSources(
  storagePaths: { globalStoragePath: string },
  target: TargetContext,
  options: Pick<RuntimeDataSetMergeBatchOptions, 'candidateIds' | 'requested' | 'sizeLimits'>,
  report: RuntimeDataSetMergeBatchResult,
  keepGoing: () => boolean
): Promise<{ sources: PickedSource[]; pickedAt: string }> {
  const streamedRows = options.sizeLimits?.streamedRows ?? RUNTIME_DATA_SET_STREAMED_MERGE_MAX_ROWS;
  // Before anything is judged: a source merged into this target after this is another window's.
  const pickedAt = new Date().toISOString();
  const picked = await withRuntimeDataRootAdmission(storagePaths.globalStoragePath, async () => {
    const inspection = await inspectVscodeRuntimeDataSets(storagePaths);
    const selected = inspection.candidates.filter((candidate) => candidate.selected);
    if (selected.length !== 1 || !sameRuntimeDataSetIdentity(target.identity, selected[0])) return [];
    report.targetCandidateId = selected[0].id;
    const ledger = await readRuntimeDataSetMergeLedger(storagePaths);
    const requests = await readRuntimeDataSetMergeRequests(storagePaths);
    const explicit = options.requested === true && options.candidateIds !== undefined;
    const picked: PickedSource[] = [];
    for (const candidate of inspection.candidates) {
      if (candidate.selected || !candidate.dataSetId || !candidate.rootInstanceId) continue;
      let request = requests.get(candidate.id);
      let expired: RuntimeDataSetMergeLedgerRequest | undefined;
      if (request && !(Date.now() - Date.parse(request.requestedAt) < RUNTIME_DATA_SET_MERGE_REQUEST_TTL_MS)) {
        // Removed only together with a notice (or with the outcome of this batch's attempt).
        expired = request;
        request = undefined;
      }
      const recorded = ledger.get(candidate.id);
      const record = recorded && sameRuntimeDataSetIdentity(recorded.source, candidate) ? recorded : undefined;
      const source: PickedSource = {
        candidate, requested: explicit, record, request, expired,
        // A recorded request only keeps its source pending (see RUNTIME_DATA_SET_MERGE_REQUEST_TTL_MS).
        pending: request !== undefined && sameRuntimeDataSetIdentity(request.target, target.identity)
          && request.expectedDataSetId === candidate.dataSetId && request.expectedRootInstanceId === candidate.rootInstanceId
      };
      if (options.candidateIds && !options.candidateIds.includes(candidate.id)) {
        if (expired) await reportExpiredRequest(storagePaths, source, report);
        continue;
      }
      // Only a fingerprint cached for the exact current files is used here: computing one reads the
      // whole data set, which is done per source below, outside the admission.
      const fingerprint = record ? await cachedRuntimeDataSetFingerprint(candidate).catch(() => undefined) ?? 'uncached' : undefined;
      const selection = await selectSource(storagePaths, target, source, fingerprint, report, streamedRows);
      if (selection === 'skip') continue;
      source.unjudged = selection === 'later';
      picked.push(source);
    }
    return picked;
  });
  const sources: PickedSource[] = [];
  for (const source of picked) {
    if (source.unjudged) {
      if (!keepGoing()) break;
      const fingerprint = await runtimeDataSetFingerprint(source.candidate).catch(() => undefined);
      if (await selectSource(storagePaths, target, source, fingerprint, report, streamedRows) === 'skip') continue;
    }
    sources.push(source);
  }
  return { sources, pickedAt };
}

interface PickedSource {
  candidate: VscodeRuntimeDataSetCandidate;
  /** This very call is the user's explicit request for it. */
  requested: boolean;
  record?: RuntimeDataSetMergeLedgerRecord;
  request?: RuntimeDataSetMergeLedgerRequest;
  /** A recorded, unexpired request for this target keeps the source pending. */
  pending: boolean;
  /** A recorded request that ran out; removed with a notice unless the source is merged anyway. */
  expired?: RuntimeDataSetMergeLedgerRequest;
  /** Judging its record needs a fingerprint that was not cached: judged again outside the admission. */
  unjudged?: boolean;
}

/**
 * Whether a source needs work in this batch, judged on its record and its fingerprint (undefined:
 * unreadable; 'uncached': not known without reading the whole data set, so a judgment that needs it
 * comes 'later', outside the admission). A refusal of the unchanged source is reported again (not as
 * new) without redoing it.
 */
async function selectSource(
  paths: { globalStoragePath: string },
  target: TargetContext,
  source: PickedSource,
  fingerprint: RuntimeDataSetFingerprint | 'uncached' | undefined,
  report: RuntimeDataSetMergeBatchResult,
  streamedRows: number
): Promise<'work' | 'skip' | 'later'> {
  const { candidate, record, request, pending } = source;
  const later = record !== undefined && fingerprint === 'uncached';
  const unchanged = record !== undefined && fingerprint !== 'uncached' && sameRuntimeDataSetFingerprint(record.source, fingerprint);
  if (record?.state === 'merged' && sameRuntimeDataSetIdentity(record.target, target.identity) && unchanged) {
    if (request || source.expired) await removeRuntimeDataSetMergeRequest(paths, candidate.id);
    // An explicit request always hears back, also when there is nothing new.
    if (source.requested) report.merged.push({ ...unchangedResult(candidate, target), alreadyMerged: true });
    return 'skip';
  }
  if (source.requested) return later ? 'later' : 'work';
  // Kept by the user, or merged once already (into any data set, also when a later explicit
  // attempt ended otherwise): only on request. An interrupted commit still converges.
  if (!pending && ((record && record.state !== 'committing' && runtimeDataSetLastMerge(record))
    || await isVscodeRuntimeDataSetKept(candidate))) {
    await reportExpiredRequest(paths, source, report);
    return 'skip';
  }
  if (later) return 'later';
  // A refusal of this unchanged source is reported again without redoing it, unless the request
  // came after that judgment (a record put back after a rollback keeps its time of judgment). A
  // too-large record counts only for the current hard bound (older ones named the in-memory bound).
  const known = unchanged && (record?.state === 'failed'
    || (record?.state === 'blocked' && sameRuntimeDataSetIdentity(record.target, target.identity))
    || (record?.state === 'too-large' && record.maxRows === streamedRows))
    && !(pending && request!.requestedAt > record.updatedAt);
  if (known && (record.state === 'failed' || record.state === 'blocked' || record.state === 'too-large')) {
    (record.state === 'failed' ? report.failures : report.blocked).push({
      candidateId: candidate.id, code: record.code, message: record.message, newly: false
    });
    await reportExpiredRequest(paths, source, report);
    return 'skip';
  }
  return 'work';
}

/** A request that ran out without a merge is never dropped silently. */
async function reportExpiredRequest(
  paths: { globalStoragePath: string },
  source: PickedSource,
  report: RuntimeDataSetMergeBatchResult
): Promise<void> {
  if (!source.expired) return;
  await removeRuntimeDataSetMergeRequest(paths, source.candidate.id);
  const days = Math.round(RUNTIME_DATA_SET_MERGE_REQUEST_TTL_MS / (24 * 60 * 60 * 1000));
  report.blocked.push({
    candidateId: source.candidate.id, code: 'runtime-data-set-merge-request-expired', newly: true,
    message: `${source.expired.requestedAt.slice(0, 10)} 请求的合并在 ${days} 天内一直没有完成，已不再自动重试；`
      + '需要时请在“历史与存储管理”里再次选择“合并到当前库”。'
  });
}

/**
 * Merges one complete data set of this configuration root into an explicitly given open Runtime
 * (e.g. a fresh root under another data directory, for data-root migration). Throws for any
 * outcome other than merged. The caller holds the target's configuration admission when that
 * differs from `paths`; the source must be offline.
 */
export async function mergeRuntimeDataSetIntoDatabase(
  paths: { globalStoragePath: string },
  input: { candidateId: string; expectedDataSetId: string; expectedRootInstanceId: string },
  targetInput: RuntimeDataSetMergeTarget,
  options: RuntimeDataSetIntoDatabaseOptions = {}
): Promise<RuntimeDataSetMergeResult> {
  const storagePaths = { globalStoragePath: path.resolve(paths.globalStoragePath) };
  const target = targetContext(targetInput);
  const candidate = await resolveVscodeRuntimeDataSet(storagePaths, input.candidateId);
  if (candidate.dataSetId !== input.expectedDataSetId || candidate.rootInstanceId !== input.expectedRootInstanceId) {
    throw new RuntimeDataSetMergeError('runtime-data-set-merge-identity-mismatch', '来源历史库的身份已变化，本次不合并。');
  }
  // A fresh migration target has no other Host, so the online transaction bound does not apply.
  const outcome = await mergeOneSource(storagePaths, target, candidate.id,
    { limits: { maxRows: Infinity, maxBytes: Infinity }, ...options },
    { finalizeWork: !options.migration, requested: true, migration: options.migration === true });
  if (outcome.kind === 'merged' || outcome.kind === 'current') return outcome.result;
  await settleTargetBackup(target, { keepUsed: true }).catch(() => undefined);
  if (outcome.kind === 'stopped') throw new RuntimeDataSetMergeError('runtime-data-set-merge-stopped', '合并已停止。');
  throw new RuntimeDataSetMergeError(outcome.code, outcome.message);
}

/**
 * Online CAS pre-copy for a later exclusive merge or migration. The source is resolved and
 * validated through its RootAuthority binding. Best effort by design: a live source is read
 * through a SQLite Backup API snapshot (so the source's own files are never opened outside
 * SQLite), every published object is digest-verified before it becomes visible, and anything
 * missed is transferred again inside the later merge. An offline source (no WAL) is copied as a
 * plain file instead, so no SQLite sidecar is left beside it. Precondition: this process must not
 * have the source open; pass `sourceDatabase` when it does (the backup then runs on its worker).
 */
export async function precopyRuntimeDataSetCas(
  paths: { globalStoragePath: string },
  input: { candidateId: string; expectedDataSetId: string; expectedRootInstanceId: string },
  target: { configurationRootPath: string; binding: HistoricalRootBinding },
  options: Pick<RuntimeDataSetMergeOptions, 'linkFile'> & {
    sourceDatabase?: RuntimeDatabase;
    /** Cancels between objects (and around the snapshot); this call's temporary files are removed. */
    signal?: AbortSignal;
  } = {}
): Promise<RuntimeDataSetCasPrecopy> {
  const storagePaths = { globalStoragePath: path.resolve(paths.globalStoragePath) };
  const candidate = await resolveVscodeRuntimeDataSet(storagePaths, input.candidateId);
  if (candidate.dataSetId !== input.expectedDataSetId || candidate.rootInstanceId !== input.expectedRootInstanceId) {
    throw new RuntimeDataSetMergeError('runtime-data-set-merge-identity-mismatch', '来源历史库的身份已变化，本次不预复制。');
  }
  const binding = await requireCompleteRuntimeDataSet(candidate);
  options.signal?.throwIfAborted();
  // Named with this process id: a crashed process's copies are found and removed (sweepDataRootRelocationLeftovers).
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-merge-precopy-${process.pid}-`));
  try {
    const snapshotPath = path.join(temporaryRoot, 'limcode.sqlite');
    if (options.sourceDatabase) {
      if (!sameRuntimeDataSetIdentity(options.sourceDatabase.binding, candidate)) {
        throw new RuntimeDataSetMergeError('runtime-data-set-merge-identity-mismatch', '传入的数据库与来源历史库不一致。');
      }
      const staged = path.join(path.dirname(binding.paths.dataRootPath), `merge-precopy-${process.pid}-${randomUUID()}.sqlite`);
      try {
        await options.sourceDatabase.backupTo(staged);
        await fs.copyFile(staged, snapshotPath);
      } finally {
        await removeSqliteFiles(staged);
      }
    } else if (await fs.stat(`${binding.paths.databasePath}-wal`).then(() => true, () => false)) {
      // A live source (its WAL exists): read through SQLite's Backup API.
      const live = new Database(toSqliteFilePath(binding.paths.databasePath), { readonly: true, fileMustExist: true });
      try { await live.backup(toSqliteFilePath(snapshotPath), { progress: () => 0x7fffffff }); }
      finally { live.close(); }
    } else {
      // An offline, checkpointed source: a plain copy, so no SQLite sidecar appears beside it.
      await assertNoSymbolicPath(candidate.configurationRootPath, binding.paths.databasePath);
      await fs.copyFile(binding.paths.databasePath, snapshotPath, constants.COPYFILE_FICLONE);
    }
    options.signal?.throwIfAborted();
    const snapshot = new Database(toSqliteFilePath(snapshotPath), { readonly: true, fileMustExist: true });
    try {
      snapshot.defaultSafeIntegers(true);
      const verification: CasVerification = new Map();
      const transfer = await transferCas(candidate.configurationRootPath, binding, target.configurationRootPath, target.binding, snapshot, {
        ...(options.linkFile ? { linkFile: options.linkFile } : {}), ...(options.signal ? { signal: options.signal } : {}), verified: verification
      });
      return { ...transfer, verification };
    } finally { snapshot.close(); }
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

/** Records an explicit merge request of a complete non-selected data set into the current one. */
export async function requestRuntimeDataSetMerge(
  paths: { globalStoragePath: string },
  input: { candidateId: string; expectedDataSetId: string; expectedRootInstanceId: string }
): Promise<void> {
  const storagePaths = { globalStoragePath: path.resolve(paths.globalStoragePath) };
  await withRuntimeDataRootAdmission(storagePaths.globalStoragePath, async () => {
    const selected = (await inspectVscodeRuntimeDataSets(storagePaths)).candidates.filter((candidate) => candidate.selected);
    if (selected.length !== 1 || !selected[0].dataSetId || !selected[0].rootInstanceId) {
      throw new RuntimeDataSetMergeError('runtime-data-set-merge-target-missing', '请先选定当前历史库，再合并其它历史库。');
    }
    const candidate = await resolveVscodeRuntimeDataSet(storagePaths, input.candidateId);
    if (candidate.selected) {
      throw new RuntimeDataSetMergeError('runtime-data-set-merge-source-selected', '不能把当前历史库合并到自身。');
    }
    if (candidate.dataSetId !== input.expectedDataSetId || candidate.rootInstanceId !== input.expectedRootInstanceId) {
      throw new RuntimeDataSetMergeError('runtime-data-set-merge-identity-mismatch', '所选历史库的身份已变化，请重新打开历史与存储管理。');
    }
    await writeRuntimeDataSetMergeRequest(storagePaths, {
      candidateId: candidate.id,
      expectedDataSetId: input.expectedDataSetId,
      expectedRootInstanceId: input.expectedRootInstanceId,
      target: { dataSetId: selected[0].dataSetId, rootInstanceId: selected[0].rootInstanceId }
    });
  });
}

/**
 * Reads a data set other than the one this window has open (a private copy of its files) under the
 * configuration admission and that data set's maintenance claim: every opener of it in this
 * process (merge finalization, upgrade, read-only history) holds them, and copying files this
 * process has open in SQLite would release its POSIX locks on them.
 */
export async function withRuntimeDataSetReadClaims<T>(
  paths: { globalStoragePath: string },
  candidate: VscodeRuntimeDataSetCandidate,
  read: () => Promise<T>
): Promise<T> {
  return withRuntimeDataRootAdmission(path.resolve(paths.globalStoragePath),
    async () => withRuntimeMaintenance((await requireCompleteRuntimeDataSet(candidate)).paths, read));
}

/**
 * Merge state of every non-selected data set, relative to the currently selected one. A content
 * fingerprint not cached for the exact files is read under that data set's claims.
 */
export async function readRuntimeDataSetMergeStates(
  paths: { globalStoragePath: string }
): Promise<Map<string, RuntimeDataSetMergeState>> {
  const storagePaths = { globalStoragePath: path.resolve(paths.globalStoragePath) };
  const result = new Map<string, RuntimeDataSetMergeState>();
  const inspection = await inspectVscodeRuntimeDataSets(storagePaths);
  const selected = inspection.candidates.find((candidate) => candidate.selected);
  const current = selected?.dataSetId && selected.rootInstanceId
    ? { dataSetId: selected.dataSetId, rootInstanceId: selected.rootInstanceId } : undefined;
  const ledger = await readRuntimeDataSetMergeLedger(storagePaths);
  const requests = await readRuntimeDataSetMergeRequests(storagePaths);
  for (const candidate of inspection.candidates) {
    if (candidate.selected || !candidate.dataSetId) continue;
    const recorded = ledger.get(candidate.id);
    const record = recorded && sameRuntimeDataSetIdentity(recorded.source, candidate) ? recorded : undefined;
    const fingerprint = record ? await cachedRuntimeDataSetFingerprint(candidate).catch(() => undefined)
      ?? await withRuntimeDataSetReadClaims(storagePaths, candidate, () => runtimeDataSetFingerprint(candidate)).catch(() => undefined)
      : undefined;
    const readable = fingerprint !== undefined && isReadableRuntimeDataSetFingerprint(fingerprint);
    const unchanged = record !== undefined && sameRuntimeDataSetFingerprint(record.source, fingerprint);
    const merge = record ? runtimeDataSetLastMerge(record) : undefined;
    const lastMerged: RuntimeDataSetMergedFacts | undefined = merge && {
      mergedAt: merge.mergedAt,
      intoCurrent: sameRuntimeDataSetIdentity(merge.target, current),
      targetMissing: !inspection.candidates.some((dataSet) => sameRuntimeDataSetIdentity(merge.target, dataSet)),
      changedSinceMerge: readable && !sameRuntimeDataSetFingerprint(merge.source, fingerprint),
      ...(readable ? {} : { sourceUnreadable: true as const })
    };
    const carried = lastMerged ? { lastMerged } : {};
    const request = requests.get(candidate.id);
    if (request && current && sameRuntimeDataSetIdentity(request.target, current)
      && Date.now() - Date.parse(request.requestedAt) < RUNTIME_DATA_SET_MERGE_REQUEST_TTL_MS
      && request.expectedDataSetId === candidate.dataSetId && request.expectedRootInstanceId === candidate.rootInstanceId) {
      result.set(candidate.id, { state: 'requested', requestedAt: request.requestedAt, ...carried });
    } else if (unchanged && (record?.state === 'failed'
      || (record?.state === 'blocked' && sameRuntimeDataSetIdentity(record.target, current)))) {
      result.set(candidate.id, { state: record.state, code: record.code, message: record.message, ...carried });
    } else if (unchanged && record?.state === 'too-large' && record.maxRows === RUNTIME_DATA_SET_STREAMED_MERGE_MAX_ROWS) {
      result.set(candidate.id, { state: 'too-large', rows: record.rows, maxRows: record.maxRows, message: record.message, ...carried });
    } else if (lastMerged) {
      result.set(candidate.id, { state: 'merged', ...lastMerged });
    } else if (await isVscodeRuntimeDataSetKept(candidate).catch(() => true)) {
      result.set(candidate.id, { state: 'kept' });
    }
  }
  return result;
}

function targetContext(input: RuntimeDataSetMergeTarget): TargetContext {
  const binding = input.database.binding;
  if (binding.runtimeKernelEpoch !== RUNTIME_KERNEL_EPOCH) {
    throw new RuntimeDataSetMergeError('runtime-data-set-merge-target-unsupported', '当前历史库还不是当前格式，不能接收合并。');
  }
  const controlRoot = path.dirname(path.resolve(binding.paths.dataRootPath));
  if (!isPathBelow(path.resolve(input.configurationRootPath), controlRoot)) {
    throw new RuntimeDataSetMergeError('runtime-data-set-merge-target-invalid', '当前历史库路径越出配置根。');
  }
  return {
    configurationRootPath: path.resolve(input.configurationRootPath),
    database: input.database,
    binding,
    identity: { dataSetId: binding.dataSetId, rootInstanceId: binding.rootInstanceId },
    controlRoot,
    backup: {}
  };
}

async function mergeOneSource(
  paths: { globalStoragePath: string },
  target: TargetContext,
  candidateId: string,
  options: RuntimeDataSetMergeBatchOptions & RuntimeDataSetIntoDatabaseOptions,
  mode: SourceMode,
  keepGoing: () => boolean = () => true
): Promise<SourceOutcome> {
  return runSourceAttempt(paths, target, candidateId, mode, (state) => mode.migration
    // A migration keeps the configuration root closed throughout: no Host registers meanwhile.
    ? withRuntimeDataRootAdmission(paths.globalStoragePath,
      () => mergeSource(paths, target, candidateId, options, mode, state, keepGoing))
    : mergeSource(paths, target, candidateId, options, mode, state, keepGoing));
}

/**
 * One attempt on one source and its outcome: a refusal is classified (sourceOutcome), a deferral is
 * no outcome when another window merged the source into this target since the batch picked it, a
 * failure or block is recorded for the judged source state, and closed work a refusal reports is
 * taken off the record.
 */
async function runSourceAttempt<Prepared extends { kind: string } = never>(
  paths: { globalStoragePath: string },
  target: TargetContext,
  candidateId: string,
  mode: SourceMode,
  attempt: (state: SourceProgress) => Promise<SourceOutcome | Prepared>,
  state: SourceProgress = {}
): Promise<SourceOutcome | Prepared> {
  let outcome: SourceOutcome | Prepared;
  try {
    outcome = await attempt(state);
  } catch (error) {
    outcome = sourceOutcome(error, state);
    // A deferral (the source changed, or anything unexpected) is no outcome when another window
    // merged the source into this target since this batch picked it.
    const meanwhile = error instanceof MergedMeanwhile ? error.result
      : outcome.kind === 'deferred' ? await mergedMeanwhile(paths, target, candidateId, mode, state).catch(() => undefined) : undefined;
    if (meanwhile) outcome = { kind: 'current', result: meanwhile };
    if ((outcome.kind === 'failed' || outcome.kind === 'blocked') && !state.recorded && !mode.migration) {
      await recordRefusal(paths, target, candidateId, outcome, state).catch(() => undefined);
    }
  }
  // Closed work stays on record until an outcome that says so (see RuntimeDataSetMergeFinalization):
  // a refusal says it in its message; a merge or "already merged" takes it where decided (takeFinalized).
  if (state.finalized && (outcome.kind === 'blocked' || outcome.kind === 'failed') && !mode.migration) {
    await removeRuntimeDataSetMergeFinalization(paths, candidateId).catch(() => undefined);
  }
  return outcome;
}

interface SourceMode {
  /** Close finalizable unfinished work first (every historical merge; never a migration). */
  finalizeWork: boolean;
  requested: boolean;
  /** Data-root migration: the selected source is allowed and the ledger is not written. */
  migration?: boolean;
  /** When the batch started picking its sources: a merge recorded since is another window's. */
  pickedAt?: string;
  /**
   * An automatic batch's first pass: a source above the online bounds (it would need its own exclusive
   * coordination) is postponed right after its audit, before any plan, backup or finalization.
   */
  postponeOversized?: boolean;
}

interface SourceProgress {
  /**
   * The judged source: its exact SQLite file state when the checked copy was taken, and the
   * fingerprint (content digest) of that copy. A migration writes no ledger record and computes none.
   */
  files?: string;
  fingerprint?: RuntimeDataSetFingerprint;
  upgradedFromEpoch?: 3 | 4;
  /**
   * Unfinished work was (being) closed in the source; `complete` once every transition succeeded.
   * `earlier`: closed by an earlier attempt whose outcome did not say so (none in this attempt).
   * The ids are everything set out to close; the counts, how many of them the source has closed.
   */
  finalized?: {
    turnIds: string[]; intentIds: string[]; turns: number; intents: number; sourceBackupPath: string; complete: boolean; earlier?: boolean;
  };
  /** Conversations the plan leaves out (see skippedRows), counted per deleted conversation. */
  skippedConversations?: number;
  /** The outcome was already written to the ledger where it was found. */
  recorded?: boolean;
}

function sourceOutcome(error: unknown, state: SourceProgress): Refusal | { kind: 'stopped' } {
  // A stop after this attempt closed work in the source is deferred, so that is reported.
  if (error instanceof StopRequested && (!state.finalized || state.finalized.earlier)) return { kind: 'stopped' };
  // Only the source's own deterministic problems are failures (thrown as Outcome where found:
  // structure, fingerprint, integrity, rows, content digests). Anything else — a closed target, a
  // window going away, I/O — is retried at a later startup.
  const outcome: Refusal = error instanceof StopRequested
    ? { kind: 'deferred', code: 'runtime-data-set-merge-stopped', message: '合并在收尾之后停止了（窗口关闭或数据目录已切换），以后启动时会继续合并。' }
    : error instanceof Outcome
    ? { ...error.outcome }
    : isRuntimeHostsActiveError(error)
      ? { kind: 'deferred', code: 'runtime-hosts-active', message: '这个历史库正被其它窗口使用，关闭那个窗口后会自动合并。' }
      : { kind: 'deferred', code: errorCode(error), message: `暂时无法合并，以后会自动重试：${errorMessage(error)}` };
  if (state.upgradedFromEpoch !== undefined) {
    // The published predecessor was backed up and upgraded in place before this outcome.
    outcome.message += `（这个库已按已发布的第 ${state.upgradedFromEpoch} 代格式先备份并就地升级到当前格式，对话内容未改动。）`;
  }
  if (state.finalized) outcome.message += finalizedNote(state.finalized);
  return outcome;
}

function finalizedNote(finalized: NonNullable<SourceProgress['finalized']>): string {
  const work = [
    ...(finalized.turns > 0 ? [`${finalized.turns} 个中断的任务`] : []),
    ...(finalized.intents > 0 ? [`${finalized.intents} 条排队的消息`] : [])
  ].join('和');
  const when = finalized.earlier ? '之前一次合并时' : '合并前';
  return finalized.complete
    ? `（${when}已把这个库里的${work}按“中止”收尾，不会再被继续执行；收尾前的备份在 ${finalized.sourceBackupPath}。）`
    : `（${when}收尾这个库里的${work}时出错，其中一部分可能已按“中止”收尾；收尾前的备份在 ${finalized.sourceBackupPath}。）`;
}

/**
 * Records a refusal for the judged source state, unless another window merged or is merging it.
 * Judged on a checked copy: only while the files are still those of the copy (else the next startup
 * judges again). Judged before any copy (recovery, epoch, upgrade): the files as they are now.
 */
async function recordRefusal(
  paths: { globalStoragePath: string },
  target: TargetContext,
  candidateId: string,
  outcome: Refusal,
  state: SourceProgress
): Promise<void> {
  const candidate = await resolveVscodeRuntimeDataSet(paths, candidateId);
  if (state.files !== undefined
    && await runtimeDataSetFileState((await requireCompleteRuntimeDataSet(candidate)).paths.databasePath) !== state.files) return;
  const source = state.fingerprint ?? await runtimeDataSetFingerprint(candidate);
  await withRuntimeDataRootAdmission(paths.globalStoragePath, async () => {
    const current = (await readRuntimeDataSetMergeLedger(paths)).get(candidateId);
    if ((current?.state === 'merged' || current?.state === 'committing') && sameRuntimeDataSetFingerprint(current.source, source)) return;
    await writeRuntimeDataSetMergeLedgerRecord(paths, outcome.tooLarge
      ? { candidateId, state: 'too-large', source, code: outcome.code, message: outcome.message, ...outcome.tooLarge }
      : outcome.kind === 'failed'
        ? { candidateId, state: 'failed', source, code: outcome.code, message: outcome.message }
        : { candidateId, state: 'blocked', source, target: target.identity, code: outcome.code, message: outcome.message });
  });
}

async function mergeSource(
  paths: { globalStoragePath: string },
  target: TargetContext,
  candidateId: string,
  options: RuntimeDataSetMergeBatchOptions & RuntimeDataSetIntoDatabaseOptions,
  mode: SourceMode,
  state: SourceProgress,
  keepGoing: () => boolean
): Promise<SourceOutcome> {
  const stopIfAsked = (): void => {
    if (!keepGoing()) throw new StopRequested();
  };
  stopIfAsked();
  if (!mode.migration) {
    const earlier = await readRuntimeDataSetMergeFinalization(paths, await resolveVscodeRuntimeDataSet(paths, candidateId));
    if (earlier) {
      state.finalized = {
        turnIds: earlier.turnIds, intentIds: earlier.intentIds, turns: earlier.turns, intents: earlier.intents,
        sourceBackupPath: earlier.sourceBackupPath, complete: earlier.complete, earlier: true
      };
    }
    const settled = await settledSource(paths, target, candidateId, state);
    if (settled) return settled;
  }
  const { candidate, binding } = await resolveSource(paths, target, candidateId, mode, state);
  // Conversations earlier merges of this source inserted here: the ones deleted here since are left out.
  const merged = mode.migration ? [] : await recordedConversations(paths, target, candidate);
  const unfinishedWork = mode.finalizeWork ? 'finalize' as const : 'carry' as const;
  let taken = await takeVerifiedSnapshot(candidate, binding, unfinishedWork, state, mode, options);
  try {
    // An earlier attempt may have ended before it counted what it closed: counted in this copy.
    if (state.finalized?.earlier) countFinalized(taken.snapshot.database, state.finalized);
    if (!mode.migration) assertMergeableSize(taken.audit.size!, options, state);
    if (mode.postponeOversized && exceedsOnlineLimits(taken.audit.size!, options)) {
      const { rows, bytes } = taken.audit.size!;
      throw new Outcome({
        kind: 'deferred', code: POSTPONED_IN_BATCH, awaiting: { rows, bytes },
        message: `这份旧聊天记录较大（约 ${rows} 条记录），和更大的旧聊天记录一起在所有窗口暂停时合并，正在等待合并`
          + `${state.finalized ? '。' : '；这个库的对话内容没有改动。'}`
      });
    }
    let work: UnfinishedWorkInspection | undefined;
    if (!mode.finalizeWork) assertCarriable(taken.audit.carriedWork!);
    else {
      work = taken.audit.unfinishedWork!;
      if (work.refused.length > 0) throw new Outcome(unfinishedWorkOutcome(describeUnfinishedWork(work.refused), state));
    }
    const limits = options.limits ?? RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS;
    stopIfAsked();
    let plan = await planSource(taken.snapshot.database, target, merged, state);
    let size = checkPlan(plan, taken.audit.size!, limits, options, state);
    const verified: CasVerification = options.casVerification ?? new Map();
    if (work && hasFinalizableWork(work)) {
      // Everything that can refuse the source was checked on the unfinalized snapshot (unfinished
      // work, conflicts, size); the CAS objects are verified too. Only then is the source backed up
      // and its work closed, and the finalized source is checked again from a new snapshot.
      await transferSourceCas(candidate, binding, target, taken.snapshot.database, options, verified, true);
      stopIfAsked();
      await fault(options, 'before-source-finalization');
      await finalizeSource(paths, target, candidate, binding, work, state, options, mode, stopIfAsked);
      await taken.snapshot.close();
      taken = await takeVerifiedSnapshot(candidate, binding, unfinishedWork, state, mode, options);
      const remaining = taken.audit.unfinishedWork!;
      if (remaining.refused.length > 0 || hasFinalizableWork(remaining)) {
        throw new Outcome(unfinishedWorkOutcome(describeUnfinishedWork(remaining.refused) || '收尾后仍有未结束的任务', state, true));
      }
      stopIfAsked();
      plan = await planSource(taken.snapshot.database, target, merged, state);
      size = checkPlan(plan, taken.audit.size!, limits, options, state);
    }
    if (plan.steps.length === 0) {
      // Nothing new (e.g. a source whose files changed but whose rows all exist here already):
      // recorded as merged, without a target backup; reported only when there is something to say.
      return await commitSource(paths, target, candidate, binding, plan, undefined, state, options, mode, stopIfAsked);
    }
    await ensureTargetBackup(target, options);
    await fault(options, 'after-target-backup');
    const cas = await transferSourceCas(candidate, binding, target, taken.snapshot.database, options, verified, false);
    await fault(options, 'after-cas-transfer');
    const commit = (): Promise<SourceOutcome> => commitSource(
      paths, target, candidate, binding, plan, cas, state, options, mode, stopIfAsked
    );
    if (!size.oversized) return await commit();
    return await commitExclusively(paths, target, candidateId, size.rows, state, mode, options.coordinateOversized!, commit);
  } finally {
    await taken.snapshot.close();
  }
}

/**
 * Before any work on a source: an unchanged source already merged into this target (e.g. by
 * another window since this batch picked it) is left alone, and an interrupted commit into this
 * target is converged by measuring its exact inserted rows.
 */
async function settledSource(
  paths: { globalStoragePath: string },
  target: TargetContext,
  candidateId: string,
  state: SourceProgress
): Promise<SourceOutcome | undefined> {
  const recorded = (await readRuntimeDataSetMergeLedger(paths)).get(candidateId);
  if (recorded?.state === 'merged' && sameRuntimeDataSetIdentity(recorded.target, target.identity)) {
    const candidate = await resolveVscodeRuntimeDataSet(paths, candidateId);
    const fingerprint = await runtimeDataSetFingerprint(candidate).catch(() => undefined);
    return sameRuntimeDataSetIdentity(recorded.source, candidate) && sameRuntimeDataSetFingerprint(recorded.source, fingerprint)
      ? { kind: 'current', result: await currentResult(paths, candidate, target, state) } : undefined;
  }
  if (recorded?.state !== 'committing' || !sameRuntimeDataSetIdentity(recorded.target, target.identity)) return undefined;
  return withRuntimeDataRootAdmission(paths.globalStoragePath, async (): Promise<SourceOutcome | undefined> => {
    const candidate = await resolveVscodeRuntimeDataSet(paths, candidateId);
    const record = (await readRuntimeDataSetMergeLedger(paths)).get(candidateId);
    if (record?.state !== 'committing' || !sameRuntimeDataSetIdentity(record.target, target.identity)
      || !sameRuntimeDataSetIdentity(record.source, candidate)) return undefined;
    const rows = (await readRuntimeDataSetMergeCommit(paths, record.commitId))?.rows ?? [];
    const presence = rows.length > 0 ? await insertedRowsPresence(rows, target.database) : 'none';
    if (presence === 'none') {
      // Nothing of it was committed: the record it replaced is back, and the source is merged again.
      await restoreLedgerRecord(paths, candidateId, record.replaced);
      await removeRuntimeDataSetMergeCommit(paths, record.commitId).catch(() => undefined);
      return undefined;
    }
    state.fingerprint = record.source;
    // Some of it is here, so the one transaction committed: every conversation it inserted is on record
    // as merged here (one the user deleted since is left out of later merges into this data set).
    const insertedConversationIds = rows.filter(([domain]) => domain === 'Conversation').map(([, id]) => id);
    if (presence === 'partial') {
      const outcome: Refusal = { kind: 'blocked', code: 'runtime-data-set-merge-conflict', message: '上次合并在提交时中断，之后当前库里这批对话已有增删，无法确认合并状态；请在历史与存储管理中手动合并。' };
      await writeRuntimeDataSetMergeLedgerRecord(paths, {
        candidateId, state: 'blocked', source: record.source, target: target.identity, code: outcome.code, message: outcome.message,
        insertedConversationIds
      });
      state.recorded = true;
      throw new Outcome(outcome);
    }
    // Recorded for the source state that was committed; later changes show as changed since merge.
    await writeRuntimeDataSetMergeLedgerRecord(paths, {
      candidateId, state: 'merged', source: record.source, target: target.identity,
      mergedAt: new Date().toISOString(), insertedRows: rows.length, reusedRows: 0,
      insertedConversations: insertedConversationIds.length, insertedConversationIds
    });
    await removeRuntimeDataSetMergeCommit(paths, record.commitId).catch(() => undefined);
    return { kind: 'merged', result: {
      ...unchangedResult(candidate, target), insertedRows: rows.length, insertedConversations: insertedConversationIds.length,
      recoveredCommit: true, ...await takeFinalized(paths, candidate, state).catch(() => finalizedResult(state))
    } };
  });
}

/** Identity, idle state, recovery, epoch (a published 3/4 source is upgraded in place first). */
async function resolveSource(
  paths: { globalStoragePath: string },
  target: Pick<TargetContext, 'identity'>,
  candidateId: string,
  mode: SourceMode,
  state: SourceProgress
): Promise<{ candidate: VscodeRuntimeDataSetCandidate; binding: HistoricalRootBinding }> {
  let candidate = await resolveVscodeRuntimeDataSet(paths, candidateId);
  if ((candidate.selected && !mode.migration) || !candidate.dataSetId || !candidate.rootInstanceId) {
    throw new Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-source-changed', message: '来源已成为当前库或已被清空，本次不合并。' });
  }
  if (sameRuntimeDataSetIdentity(target.identity, candidate)) {
    throw new Outcome({ kind: 'failed', code: 'runtime-data-set-merge-same-identity', message: '来源与当前历史库是同一个数据集，不能合并。' });
  }
  // Without a claim this is an early answer only; the commit checks it again under the claims.
  await assertSourceIdle(candidate);
  if (candidate.requiresRecovery) {
    throw new Outcome({ kind: 'failed', code: 'runtime-data-set-merge-recovery-required', message: '这个历史库有一次未完成的归档或切换，需要先切换到它完成恢复，才能合并。' });
  }
  const epoch = candidate.runtimeKernelEpoch;
  if (epoch === 3 || epoch === 4) {
    const upgrade = await upgradeRuntimeDataSet(paths, {
      candidateId, expectedDataSetId: candidate.dataSetId, expectedRootInstanceId: candidate.rootInstanceId
    }).catch(async (error: unknown) => {
      if (isRuntimeHostsActiveError(error)) throw new Outcome({ kind: 'deferred', code: 'runtime-hosts-active', message: '这个历史库正被旧版本窗口使用，关闭那个窗口后会自动合并。' });
      if (isTransientError(error)) throw new Outcome({ kind: 'deferred', code: errorCode(error), message: `升级这份已发布的旧格式时出错，稍后重试：${errorMessage(error)}` });
      // Recorded for the files as they are then: a failed attempt may itself have touched them.
      throw new Outcome({ kind: 'failed', code: errorCode(error), message: `这份已发布的旧格式无法自动升级：${errorMessage(error)}` });
    });
    state.upgradedFromEpoch = upgrade.previousEpoch;
    candidate = await resolveVscodeRuntimeDataSet(paths, candidateId);
  } else if (epoch !== RUNTIME_KERNEL_EPOCH) {
    throw new Outcome({ kind: 'failed', code: 'runtime-data-set-merge-epoch-unsupported', message: `第 ${epoch ?? '?'} 代格式的历史库不能合并。` });
  }
  try {
    return { candidate, binding: await requireCompleteRuntimeDataSet(candidate) };
  } catch (error) {
    if (isTransientError(error)) throw error;
    throw new Outcome({ kind: 'failed', code: errorCode(error), message: `这个历史库不完整或结构不符：${errorMessage(error)}` });
  }
}

/**
 * Before any plan, coordination, backup or finalization: above the streamed hard bound this version
 * cannot merge the source safely (recorded as too large); above the in-memory bound it waits for a
 * large-merge session (deferred, nothing recorded).
 */
function assertMergeableSize(
  size: { rows: number; bytes: number },
  options: Pick<RuntimeDataSetMergeOptions, 'sizeLimits'>,
  state: SourceProgress,
  inSession = false
): void {
  const streamedRows = options.sizeLimits?.streamedRows ?? RUNTIME_DATA_SET_STREAMED_MERGE_MAX_ROWS;
  const { rows } = size;
  if (rows > streamedRows) {
    throw new Outcome({
      kind: 'blocked', code: 'runtime-data-set-merge-too-large-for-one-transaction',
      tooLarge: { rows, maxRows: streamedRows },
      message: `这份旧聊天记录约有 ${rows} 条记录，超过当前版本一次合并能安全处理的上限（${streamedRows} 条），暂不合并，也不会自动重试`
        + `${state.finalized ? '。' : '；这个库的对话内容没有改动。'}可以在“历史与存储管理”里切换到这个库查看或继续使用。`
    });
  }
  if (!inSession && rows > (options.sizeLimits?.transactionRows ?? RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS)) {
    throw new Outcome({
      kind: 'deferred', code: RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE, awaiting: { rows, bytes: size.bytes },
      message: `这份旧聊天记录较大（约 ${rows} 条记录），要在所有窗口暂停时一次合并，正在等待合并`
        + `${state.finalized ? '。' : '；这个库的对话内容没有改动。'}`
    });
  }
}

/** Above the online bounds: an online merge of it would need its own exclusive coordination. */
function exceedsOnlineLimits(size: { rows: number; bytes: number }, options: Pick<RuntimeDataSetMergeOptions, 'limits'>): boolean {
  const limits = options.limits ?? RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS;
  return size.rows > limits.maxRows || size.bytes > limits.maxBytes;
}

/** Carried unfinished work of a migration must be expressible as ordinary Repository rows. */
function assertCarriable(carried: CarriedWorkRefusals): void {
  // A request that was receiving a reply has no such form (the source's own recovery closes it
  // first), and a running process writes to the spool beside the source database.
  if (carried.streamingModelRequests > 0) {
    throw new Outcome({ kind: 'failed', code: 'runtime-data-set-merge-streaming-model-request', message: `这个历史库里有 ${carried.streamingModelRequests} 个正在接收回复的模型请求，需要先打开它完成恢复后再迁移。` });
  }
  if (carried.runningProcesses > 0) {
    throw new Outcome({ kind: 'failed', code: 'runtime-data-set-merge-running-process', message: `这个历史库里有 ${carried.runningProcesses} 个仍在运行或输出尚未登记完的后台进程，等它们结束后再迁移。` });
  }
}

/** Conflicts and size, before anything touches the source or the target. */
function checkPlan(
  plan: RowPlan,
  size: { rows: number; bytes: number },
  limits: { maxRows: number; maxBytes: number },
  options: RuntimeDataSetMergeBatchOptions,
  state: SourceProgress
): { rows: number; oversized: boolean } {
  if (plan.conflicts.count > 0) throw new Outcome(conflictRefusal(plan.conflicts, state));
  const oversized = plan.steps.length > 0 && (size.rows > limits.maxRows || size.bytes > limits.maxBytes);
  if (oversized && !options.coordinateOversized) {
    throw new Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-too-large', message: `这份旧聊天记录较大（约 ${size.rows} 行），需要其它窗口暂时让出后才能合并，稍后重试。` });
  }
  return { rows: size.rows, oversized };
}

/** Same ids with other content in source and target: the whole source is refused, nothing written. */
function conflictRefusal(conflicts: { count: number; samples: readonly string[] }, state: SourceProgress): Refusal {
  return {
    kind: 'blocked',
    code: 'runtime-data-set-merge-conflict',
    message: `这份旧聊天记录与当前历史库有 ${conflicts.count} 处同一条记录但内容不同（例如合并之后又在其中一边改动了同一对话），整体未合并，`
      + `${state.finalized ? '当前库没有改动' : '两边内容都没有改动'}。如需保留两边的改动，可以先切换到这个库查看，再决定删除哪一份。`
      + `\n${conflicts.samples.join('\n')}`
  };
}

/** Backs up the source and closes its finalizable work, under its maintenance claim. */
async function finalizeSource(
  paths: { globalStoragePath: string },
  target: TargetContext,
  candidate: VscodeRuntimeDataSetCandidate,
  binding: HistoricalRootBinding,
  work: UnfinishedWorkInspection,
  state: SourceProgress,
  options: RuntimeDataSetMergeOptions,
  mode: SourceMode,
  stopIfAsked: () => void
): Promise<void> {
  // Windows opening meanwhile wait on the admission and say why (the source backup can take a while).
  await withRuntimeDataRootAdmission(paths.globalStoragePath, () => withRuntimeMaintenance(binding.paths, () => withRuntimeMaintenanceActivity({
    operation: 'historical-merge-finalize', description: '备份并收尾要合并的旧聊天记录'
  }, async () => {
    await assertSourceUnchanged(paths, target, candidate, binding, state, mode);
    stopIfAsked();
    // Work in a data set the user switched away from in this version was not interrupted by an upgrade.
    const reason = await isVscodeRuntimeDataSetKept(candidate) ? KEPT_MERGE_FINALIZATION_REASON : MERGE_FINALIZATION_REASON;
    const sourceBackupPath = await backupSource(binding, options);
    await fault(options, 'after-source-backup');
    const earlier = state.finalized;
    const finalized: NonNullable<SourceProgress['finalized']> = state.finalized = {
      turnIds: [...new Set([...earlier?.turnIds ?? [], ...work.turns.map((turn) => turn.turnId)])],
      intentIds: [...new Set([...earlier?.intentIds ?? [], ...work.intents.map((intent) => intent.intentId)])],
      turns: earlier?.turns ?? 0,
      intents: earlier?.intents ?? 0,
      // The oldest backup holds the source from before any of its work was closed.
      sourceBackupPath: earlier?.sourceBackupPath ?? sourceBackupPath,
      complete: false
    };
    // On record before anything is closed: an attempt that ends without saying so leaves it for the next.
    const remember = (): Promise<void> => writeRuntimeDataSetMergeFinalization(paths, {
      candidateId: candidate.id, source: { dataSetId: candidate.dataSetId!, rootInstanceId: candidate.rootInstanceId! },
      turnIds: finalized.turnIds, intentIds: finalized.intentIds, turns: finalized.turns, intents: finalized.intents,
      sourceBackupPath: finalized.sourceBackupPath, complete: finalized.complete
    });
    await remember();
    // Counted in the source afterwards, also when a transition failed: never the planned numbers.
    const counted = (closed: { turns: number; intents: number }): void => { finalized.turns = closed.turns; finalized.intents = closed.intents; };
    try {
      await finalizeUnfinishedWork(createVscodeRootAuthority(candidate), work, { reason, count: finalized, onCounted: counted });
    } catch (error) {
      await remember().catch(() => undefined);
      throw error;
    }
    finalized.complete = true;
    await remember();
  })));
}

/**
 * How many of the Turns and queued messages set out to close are closed in this copy of the source
 * (an attempt that ended abruptly never counted its own).
 */
function countFinalized(source: Database.Database, finalized: NonNullable<SourceProgress['finalized']>): void {
  const turn = source.prepare('SELECT status FROM turn WHERE id = ?').pluck();
  const intent = source.prepare('SELECT state FROM turn_intent WHERE id = ?').pluck();
  finalized.turns = finalized.turnIds.filter((id) => ![undefined, 'active'].includes(turn.get(id) as string | undefined)).length;
  finalized.intents = finalized.intentIds.filter((id) => ![undefined, 'queued'].includes(intent.get(id) as string | undefined)).length;
  finalized.complete = finalized.turns === finalized.turnIds.length && finalized.intents === finalized.intentIds.length;
}

/**
 * Under the source's claim: no Host, same identity and pointer, and exactly the files that were
 * checked. Files changed because another window merged the source into this target since this batch
 * picked it (closing its work first) are that merge, not a reason to retry.
 */
async function assertSourceUnchanged(
  paths: { globalStoragePath: string },
  target: TargetContext,
  candidate: VscodeRuntimeDataSetCandidate,
  binding: HistoricalRootBinding,
  state: SourceProgress,
  mode: SourceMode
): Promise<void> {
  await assertSourceIdle(candidate);
  const current = await resolveVscodeRuntimeDataSet(paths, candidate.id);
  const pointer = await requireCompleteRuntimeDataSet(current).catch(() => undefined);
  if (!sameRuntimeDataSetIdentity(current as RuntimeDataSetIdentity, candidate) || (current.selected && !mode.migration)
    || pointer?.rootGeneration !== binding.rootGeneration || pointer.pointerRevision !== binding.pointerRevision
    || await runtimeDataSetFileState(binding.paths.databasePath) !== state.files) {
    const meanwhile = await mergedMeanwhile(paths, target, candidate.id, mode, state);
    if (meanwhile) throw new MergedMeanwhile(meanwhile);
    throw new Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-source-changed', message: '来源历史库在核验之后又有变化，稍后重试。' });
  }
}

/**
 * The merge of this source into this target that another window recorded after this batch picked
 * the source (merged, same source incarnation), as this attempt's result; undefined when there is
 * none (or no batch picked it: a single explicit merge).
 */
async function mergedMeanwhile(
  paths: { globalStoragePath: string },
  target: TargetContext,
  candidateId: string,
  mode: SourceMode,
  state: SourceProgress
): Promise<RuntimeDataSetMergeResult | undefined> {
  if (mode.pickedAt === undefined || mode.migration) return undefined;
  const record = (await readRuntimeDataSetMergeLedger(paths)).get(candidateId);
  if (record?.state !== 'merged' || !sameRuntimeDataSetIdentity(record.target, target.identity) || record.mergedAt < mode.pickedAt) return undefined;
  const candidate = await resolveVscodeRuntimeDataSet(paths, candidateId);
  return sameRuntimeDataSetIdentity(record.source, candidate) ? currentResult(paths, candidate, target, state) : undefined;
}

/**
 * The final step, under configuration admission and the source's maintenance claim: the source is
 * checked again (no Host, the exact files that were verified), the ledger is read again (another
 * window may have merged it meanwhile), then the committing record and ONE row transaction, synced
 * to disk before anything records it as merged. Once the transaction committed, that is the
 * outcome: writing the merged record or releasing a claim afterwards can fail only into the log
 * (the next startup converges a committing record).
 */
async function commitSource(
  paths: { globalStoragePath: string },
  target: TargetContext,
  candidate: VscodeRuntimeDataSetCandidate,
  binding: HistoricalRootBinding,
  plan: RowPlan,
  cas: RuntimeDataSetCasTransfer | undefined,
  state: SourceProgress,
  options: RuntimeDataSetMergeOptions & Pick<RuntimeDataSetIntoDatabaseOptions, 'beforeCommit'>,
  mode: SourceMode,
  stopIfAsked: () => void
): Promise<SourceOutcome> {
  const done: { outcome?: SourceOutcome } = {};
  try {
    return await withRuntimeDataRootAdmission(paths.globalStoragePath, () => withRuntimeMaintenance(binding.paths, async () => {
      done.outcome = await commitLocked(paths, target, candidate, binding, plan, cas, state, options, mode, stopIfAsked);
      return done.outcome;
    }));
  } catch (error) {
    if (!done.outcome) throw error;
    console.warn('[LimCode] 旧聊天记录的合并已完成，但之后释放锁失败。', error);
    return done.outcome;
  }
}

async function commitLocked(
  paths: { globalStoragePath: string },
  target: TargetContext,
  candidate: VscodeRuntimeDataSetCandidate,
  binding: HistoricalRootBinding,
  plan: RowPlan,
  cas: RuntimeDataSetCasTransfer | undefined,
  state: SourceProgress,
  options: RuntimeDataSetMergeOptions & Pick<RuntimeDataSetIntoDatabaseOptions, 'beforeCommit'>,
  mode: SourceMode,
  stopIfAsked: () => void
): Promise<SourceOutcome> {
  await assertSourceUnchanged(paths, target, candidate, binding, state, mode);
  const previous = mode.migration ? undefined : (await readRuntimeDataSetMergeLedger(paths)).get(candidate.id);
  if ((previous?.state === 'committing' || previous?.state === 'merged') && sameRuntimeDataSetIdentity(previous.target, target.identity)) {
    if (previous.state === 'committing') {
      throw new Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-commit-pending', message: '另一个窗口合并这个库时中断，下次启动时先确认它的结果。' });
    }
    if (previous.state === 'merged' && sameRuntimeDataSetIdentity(previous.source, candidate)
      && sameRuntimeDataSetFingerprint(previous.source, state.fingerprint)) {
      return { kind: 'current', result: await currentResult(paths, candidate, target, state) };
    }
  }
  stopIfAsked();
  const insertedConversationIds = plan.inserted.filter(([domain]) => domain === 'Conversation').map(([, id]) => id);
  const result: RuntimeDataSetMergeResult = {
    ...unchangedResult(candidate, target),
    insertedRows: plan.inserted.length,
    reusedRows: plan.reused,
    insertedConversations: plan.insertedConversations,
    ...(cas ?? {}),
    ...(plan.steps.length > 0 && target.backup.path ? { backupPath: target.backup.path } : {}),
    ...(state.upgradedFromEpoch !== undefined ? { upgradedFromEpoch: state.upgradedFromEpoch } : {}),
    ...(state.skippedConversations ? { skippedConversations: state.skippedConversations } : {})
  };
  const merged = (): Parameters<typeof writeRuntimeDataSetMergeLedgerRecord>[1] => ({
    candidateId: candidate.id, state: 'merged', source: state.fingerprint!, target: target.identity,
    mergedAt: new Date().toISOString(), insertedRows: plan.inserted.length, reusedRows: plan.reused,
    insertedConversations: plan.insertedConversations, insertedConversationIds
  });
  if (plan.steps.length === 0) {
    if (mode.migration) return { kind: 'merged', result };
    await writeRuntimeDataSetMergeLedgerRecord(paths, merged());
    const finalized = await takeFinalized(paths, candidate, state).catch(() => finalizedResult(state));
    return { kind: 'current', result: { ...result, alreadyMerged: true, ...finalized } };
  }
  const commitId = mode.migration ? undefined : await writeRuntimeDataSetMergeCommit(paths, mergeCommitEvidence(plan.inserted));
  if (commitId !== undefined) {
    await writeRuntimeDataSetMergeLedgerRecord(paths, {
      candidateId: candidate.id, state: 'committing', source: state.fingerprint!, target: target.identity, commitId,
      ...(previous ? { replaced: previous } : {})
    });
  }
  if (mode.migration) await options.beforeCommit?.(plan.inserted);
  const backupUsed = target.backup.used === true;
  target.backup.used = true;
  await fault(options, 'before-row-commit');
  try {
    // Synced at its commit (synchronous = FULL for this transaction alone): the merged record written
    // next, and the commit evidence removed with it, never outlive a merge a power loss takes back.
    await target.database.transaction(plan.steps, { durable: true });
  } catch (error) {
    // One transaction: measured, it either committed completely (only its reply was lost) or
    // not at all. A proven rollback drops the committing record at once; an unknown outcome
    // (the target is gone) keeps it for the next startup to converge.
    const presence = await insertedRowsPresence(plan.inserted, target.database).catch(() => undefined);
    if (presence === 'none') {
      target.backup.used = backupUsed;
      if (commitId !== undefined) {
        await restoreLedgerRecord(paths, candidate.id, previous);
        await removeRuntimeDataSetMergeCommit(paths, commitId).catch(() => undefined);
      }
    }
    if (presence !== 'all') {
      throw new Outcome({ kind: 'deferred', code: errorCode(error), message: `写入当前库时出错，稍后重试：${errorMessage(error)}` });
    }
  }
  await fault(options, 'after-row-commit');
  if (commitId === undefined) return { kind: 'merged', result };
  try {
    await writeRuntimeDataSetMergeLedgerRecord(paths, merged());
    await removeRuntimeDataSetMergeCommit(paths, commitId).catch(() => undefined);
  } catch (error) {
    console.warn('[LimCode] 旧聊天记录已合并，但合并记录没有写成；下次启动时按实测确认。', error);
  }
  return { kind: 'merged', result: { ...result, ...await takeFinalized(paths, candidate, state).catch(() => finalizedResult(state)) } };
}

/**
 * Oversized source: only now, with everything prepared and checked, the other windows of the
 * target are asked to go offline (waiting without any claim); the locks the coordination takes
 * once they are offline wrap the final commit alone. A commit that ran to its end is the outcome,
 * whatever the coordination reports about its own cleanup afterwards.
 */
async function commitExclusively(
  paths: { globalStoragePath: string },
  target: TargetContext,
  candidateId: string,
  rows: number,
  state: SourceProgress,
  mode: SourceMode,
  coordinate: NonNullable<RuntimeDataSetMergeBatchOptions['coordinateOversized']>,
  commit: () => Promise<SourceOutcome>
): Promise<SourceOutcome> {
  const done: { outcome?: SourceOutcome } = {};
  let exclusive: RuntimeDataSetExclusiveOutcome;
  try {
    exclusive = await coordinate({
      targetPaths: target.binding.paths,
      requesterHostBootId: target.database.hostBootId,
      candidateId,
      operationKey: `${candidateId}@${fingerprintDigest(state.fingerprint!)}`,
      requested: mode.requested,
      withLocks: (body) => withRuntimeDataRootAdmission(paths.globalStoragePath,
        () => withRuntimeMaintenance(target.binding.paths, body)),
      isDeterministicFailure: (error) => error instanceof Outcome && error.outcome.kind !== 'deferred'
    }, async () => { done.outcome = await commit(); });
  } catch (error) {
    if (!done.outcome) throw error;
    console.warn('[LimCode] 较大的旧聊天记录已合并，但之后结束独占维护时出错。', error);
    exclusive = { state: 'completed' };
  }
  if (!done.outcome) {
    const reason = 'reason' in exclusive && exclusive.reason ? exclusive.reason : '其它窗口暂时无法让出';
    throw new Outcome({ kind: 'deferred', code: `runtime-data-set-merge-exclusive-${exclusive.state}`,
      message: `这份旧聊天记录较大（约 ${rows} 条记录），需要其它窗口暂时让出才能合并：${sentence(reason)}以后会自动重试。` });
  }
  if (exclusive.state !== 'completed') console.warn('[LimCode] 较大的旧聊天记录已合并，但独占维护报告未完成。', exclusive);
  return done.outcome.kind === 'merged' ? { kind: 'merged', result: { ...done.outcome.result, exclusive: true } } : done.outcome;
}

function finalizedResult(state: SourceProgress): Pick<RuntimeDataSetMergeResult, 'finalized'> {
  const finalized = state.finalized;
  return finalized ? { finalized: { turns: finalized.turns, intents: finalized.intents, sourceBackupPath: finalized.sourceBackupPath } } : {};
}

function unchangedResult(candidate: VscodeRuntimeDataSetCandidate, target: TargetContext): RuntimeDataSetMergeResult {
  return {
    candidateId: candidate.id, sourceDataSetId: candidate.dataSetId!, targetDataSetId: target.identity.dataSetId,
    insertedRows: 0, reusedRows: 0, insertedConversations: 0,
    linkedCasObjects: 0, copiedCasObjects: 0, reusedCasObjects: 0, recoveredCommit: false
  };
}

/**
 * Nothing new for this target: a merge recorded before or during this attempt (another window's)
 * holds the source, or all its rows are here already. Closed work still on record goes with it.
 */
async function currentResult(
  paths: { globalStoragePath: string },
  candidate: VscodeRuntimeDataSetCandidate,
  target: TargetContext,
  state: SourceProgress
): Promise<RuntimeDataSetMergeResult> {
  return { ...unchangedResult(candidate, target), alreadyMerged: true, ...await takeFinalized(paths, candidate, state) };
}

/**
 * Closed work on record for the source goes into exactly one reported merge outcome: the one that
 * removes the record, under the configuration admission. None is left when another window's outcome
 * reported it first (also work this attempt closed itself: that merge holds it); one this attempt
 * did not know of (closed by another window after this attempt began) is reported as recorded.
 */
async function takeFinalized(
  paths: { globalStoragePath: string },
  candidate: VscodeRuntimeDataSetCandidate,
  state: SourceProgress
): Promise<Pick<RuntimeDataSetMergeResult, 'finalized'>> {
  return withRuntimeDataRootAdmission(paths.globalStoragePath, async () => {
    const recorded = await readRuntimeDataSetMergeFinalization(paths, candidate);
    if (!recorded) return {};
    await removeRuntimeDataSetMergeFinalization(paths, candidate.id);
    const finalized = state.finalized ?? recorded;
    return { finalized: { turns: finalized.turns, intents: finalized.intents, sourceBackupPath: finalized.sourceBackupPath } };
  });
}

function unfinishedWorkOutcome(found: string, state: SourceProgress, afterFinalization = false): Refusal {
  return {
    kind: 'blocked',
    code: 'runtime-data-set-merge-unfinished-work',
    message: (afterFinalization
      ? `收尾之后这份旧聊天记录里仍有无法自动收尾的工作（${found}），为避免在当前库里被自动继续执行，暂不合并。`
      : `这份旧聊天记录里还有无法自动收尾的工作（${found}），为避免在当前库里被自动继续执行，暂不合并`
        + (state.finalized ? '。' : '；这个库的对话内容没有改动。'))
      + '可以在“历史与存储管理”里切换到这个库，等任务结束或手动停止后，再切回当前库并选择“合并到当前库”。'
      + '切换过去时，这些任务会按那个库的正常恢复继续执行。'
  };
}

/** Other windows (current, or v0.0.10–v0.0.20 through their scope claim) must not use the source. */
async function assertSourceIdle(candidate: VscodeRuntimeDataSetCandidate): Promise<void> {
  const legacyOwner = await legacyWorkspaceRuntimeOwnerState(candidate);
  if (legacyOwner !== 'absent') {
    throw new Outcome({ kind: 'deferred', code: 'runtime-legacy-owner-active', message: '这个历史库正被旧版本窗口使用，关闭那个窗口后会自动合并。' });
  }
  if (!candidate.dataSetId) return;
  const binding = await requireCompleteRuntimeDataSet(candidate);
  try {
    await assertNoSymbolicPath(candidate.configurationRootPath, path.join(binding.paths.dataRootPath, 'host-liveness'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await assertRuntimeHostsOffline(binding.paths);
}

interface VerifiedSnapshot {
  snapshot: RuntimeDataSetDatabaseSnapshot;
  audit: RuntimeSnapshotAudit;
}

/**
 * Private snapshot copy of the source, verified in a worker before this thread opens it: current
 * schema, physical fingerprint, quick_check, foreign_key_check, the unfinished-work probes and the
 * size, all on the copy (see runtimeSnapshotAudit for why this keeps the POSIX lock rule). Taken
 * without a claim, so the copy counts only when the source files did not change while copied; the
 * fingerprint it represents becomes the judged state.
 */
async function takeVerifiedSnapshot(
  candidate: VscodeRuntimeDataSetCandidate,
  binding: HistoricalRootBinding,
  unfinishedWork: 'finalize' | 'carry',
  state: SourceProgress,
  mode: SourceMode,
  options: RuntimeDataSetMergeOptions = {}
): Promise<VerifiedSnapshot> {
  for (let attempt = 1; ; attempt += 1) {
    const files = await runtimeDataSetFileState(binding.paths.databasePath);
    let audit: RuntimeSnapshotAudit | undefined;
    try {
      const snapshot = await createRuntimeDataSetDatabaseSnapshot(candidate, binding, {
        beforeOpen: async (snapshotPath) => {
          await fault(options, 'after-snapshot-copy');
          if (await runtimeDataSetFileState(binding.paths.databasePath) !== files) throw new SnapshotRaced();
          state.files = files;
          state.fingerprint = undefined;
          try {
            audit = await auditRuntimeSnapshot(snapshotPath, {
              binding: binding as RootBinding, unfinishedWork, measure: true, contentDigest: !mode.migration
            });
          } catch (error) {
            // A structural or integrity finding is the source's own; a crashed worker or I/O is not.
            throw error instanceof RuntimeSnapshotAuditError && !isTransientError(error)
              ? new Outcome({ kind: 'failed', code: errorCode(error), message: `这个历史库的结构或完整性核验未通过：${errorMessage(error)}` })
              : new Outcome({ kind: 'deferred', code: errorCode(error), message: `核验这个历史库时出错，稍后重试：${errorMessage(error)}` });
          }
        }
      });
      if (audit!.contentDigest !== undefined) {
        state.fingerprint = {
          dataSetId: binding.dataSetId, rootInstanceId: binding.rootInstanceId,
          rootGeneration: binding.rootGeneration, pointerRevision: binding.pointerRevision,
          contentDigest: audit!.contentDigest
        };
        await rememberRuntimeDataSetFingerprint(candidate, files, state.fingerprint).catch(() => undefined);
      }
      return { snapshot, audit: audit! };
    } catch (error) {
      if (!(error instanceof SnapshotRaced)) throw error;
      if (attempt >= 3) {
        throw new Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-source-changed', message: '来源历史库正在变化，稍后重试。' });
      }
    }
  }
}

/**
 * Files whose SHA-256 was verified, by absolute path: `dev:ino:size:mtimeNs:ctimeNs` at that time.
 * An unchanged file is trusted without hashing it again; any difference hashes it in full.
 */
export type RuntimeDataSetCasVerification = Map<string, string>;
type CasVerification = RuntimeDataSetCasVerification;
/** Suffix of a private temporary copy under the target CAS `tmp/` directory. */
export const RUNTIME_DATA_SET_CAS_COPY_SUFFIX = '.merge.tmp';
const CAS_COPY_SUFFIX = RUNTIME_DATA_SET_CAS_COPY_SUFFIX;

async function transferSourceCas(
  candidate: VscodeRuntimeDataSetCandidate,
  binding: HistoricalRootBinding,
  target: TargetContext,
  source: Database.Database,
  options: RuntimeDataSetMergeOptions,
  verified: CasVerification,
  verifyOnly: boolean
): Promise<RuntimeDataSetCasTransfer> {
  return transferCas(candidate.configurationRootPath, binding, target.configurationRootPath, target.binding, source, {
    ...(options.linkFile ? { linkFile: options.linkFile } : {}), verified, verifyOnly
  }).catch((error: unknown) => {
    if (error instanceof Outcome) throw error;
    throw new Outcome({ kind: 'deferred', code: errorCode(error), message: `复制正文文件时出错，稍后重试：${errorMessage(error)}` });
  });
}

/** Conversations earlier merges of this source inserted into this target (its ledger record). */
async function recordedConversations(
  paths: { globalStoragePath: string },
  target: TargetContext,
  candidate: VscodeRuntimeDataSetCandidate
): Promise<string[]> {
  const record = (await readRuntimeDataSetMergeLedger(paths)).get(candidate.id);
  return record && sameRuntimeDataSetIdentity(record.source, candidate) ? runtimeDataSetMergedConversations(record, target.identity) : [];
}

/** The row plan of a source copy, leaving out what belongs to conversations deleted here since they were merged. */
async function planSource(
  source: Database.Database,
  target: TargetContext,
  merged: readonly string[],
  state: SourceProgress
): Promise<RowPlan> {
  const deleted = merged.length > 0 ? await deletedSinceMerge(source, target.database, merged) : undefined;
  state.skippedConversations = deleted?.count ?? 0;
  return planRows(source, target.database, deleted && skippedRows(source, deleted.conversations));
}

/**
 * Conversations of the source a merge leaves out: inserted into this target by an earlier merge of
 * the source and absent from it now (the user deleted them), with their Subagent descendants in the
 * source, as deleting a conversation takes them (ConversationDeletionControlPlane). Counted per
 * deleted conversation: one whose Subagent parent is left out as well belongs to it.
 */
async function deletedSinceMerge(
  source: Database.Database,
  target: RuntimeDatabase,
  merged: readonly string[]
): Promise<{ conversations: Set<string>; count: number } | undefined> {
  const inSource = new Set(source.prepare('SELECT id FROM conversation').pluck().all() as string[]);
  const candidates = [...new Set(merged)].filter((id) => inSource.has(id));
  const deleted: string[] = [];
  for (let start = 0; start < candidates.length; start += READ_CHUNK) {
    const ids = candidates.slice(start, start + READ_CHUNK);
    const found = (await target.snapshot(ids.map((id) => DOMAIN_REPOSITORIES.domain('Conversation').get(id)))).snapshot;
    ids.forEach((id, index) => { if (found[index] === null) deleted.push(id); });
  }
  if (deleted.length === 0) return undefined;
  // Subagent origins, as the deletion reads them: a ChildExecution's conversation and its source conversation.
  const parents = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const [child, parent] of source.prepare(`
    SELECT origin.conversation_id, origin.source_conversation_id FROM conversation_origin_link AS origin
     WHERE origin.conversation_id IN (SELECT child_conversation_id FROM child_execution)
       AND origin.source_conversation_id IS NOT NULL AND origin.source_conversation_id <> ''
  `).raw().iterate() as IterableIterator<[string, string]>) {
    parents.set(child, parent);
    children.set(parent, [...children.get(parent) ?? [], child]);
  }
  const conversations = new Set(deleted);
  for (const pending = [...deleted]; pending.length > 0;) {
    for (const child of children.get(pending.pop()!) ?? []) {
      if (conversations.has(child)) continue;
      conversations.add(child);
      pending.push(child);
    }
  }
  const count = [...conversations].filter((id) => !conversations.has(parents.get(id) ?? '')).length;
  return { conversations, count };
}

/**
 * Ownership without a foreign key (see skippedRows): a row with one of these columns naming a
 * left-out row (of `owner`, and only for that `kind`) is left out with it. An Operation with its
 * ModelRequest (the worker checks that aggregate); deliveries to a left-out conversation (deleting
 * it settles them); command receipts, context roots and projections, effects, file mutations and
 * processes of left-out conversations, turns, tool calls and attempts.
 */
const SKIPPED_WITH: ReadonlyArray<{ domain: string; column: string; owner: string; kind?: readonly [column: string, value: string] }> = [
  { domain: 'Operation', column: 'owner_id', owner: 'ModelRequest', kind: ['owner_kind', 'model_request'] },
  { domain: 'RuntimeDelivery', column: 'target_conversation_id', owner: 'Conversation' },
  { domain: 'RuntimeDelivery', column: 'target_turn_id', owner: 'Turn' },
  { domain: 'CommandReceipt', column: 'conversation_id', owner: 'Conversation' },
  { domain: 'CommandReceipt', column: 'turn_id', owner: 'Turn' },
  { domain: 'ContextSequenceRoot', column: 'conversation_id', owner: 'Conversation' },
  { domain: 'ModelContextProjection', column: 'owner_id', owner: 'ModelRequest', kind: ['owner_kind', 'model_request'] },
  { domain: 'ModelContextProjection', column: 'owner_id', owner: 'CompressionBlock', kind: ['owner_kind', 'compression_block'] },
  { domain: 'ModelContextProjection', column: 'root_id', owner: 'ContextSequenceRoot' },
  { domain: 'EffectIntent', column: 'attempt_id', owner: 'Attempt' },
  { domain: 'EffectReceipt', column: 'attempt_id', owner: 'Attempt' },
  { domain: 'EffectReceipt', column: 'operation_id', owner: 'Operation' },
  { domain: 'EffectReceipt', column: 'tool_call_id', owner: 'ToolCall' },
  { domain: 'EffectReceipt', column: 'conversation_id', owner: 'Conversation' },
  { domain: 'FileMutationReceipt', column: 'effect_receipt_id', owner: 'EffectReceipt' },
  { domain: 'FileMutationReceipt', column: 'change_set_id', owner: 'FileChangeSet' },
  { domain: 'FileMutationReceiptMember', column: 'member_id', owner: 'FileChangeSetMember' },
  { domain: 'ProcessOriginLink', column: 'tool_call_id', owner: 'ToolCall' },
  { domain: 'ProcessCompletionSourceLink', column: 'conversation_id', owner: 'Conversation' },
  { domain: 'ProcessCompletionSourceLink', column: 'source_turn_id', owner: 'Turn' },
  { domain: 'ProcessCompletionSourceLink', column: 'source_tool_call_id', owner: 'ToolCall' },
  { domain: 'ProcessReceipt', column: 'process_id', owner: 'Process' }
];

/**
 * Rows that reference nothing of their own and exist for their members (rows naming them in these
 * columns): left out once all members are (`all`: messages, processes, context nodes and segments),
 * or once any is where deleting a conversation removes them with it (`any`: the interaction request
 * of a deleted Turn by the schema trigger, board channels and posts by the collaboration deletion).
 */
const SKIPPED_WITH_MEMBERS: ReadonlyArray<{ domain: string; mode: 'all' | 'any'; members: ReadonlyArray<readonly [domain: string, column: string]> }> = [
  { domain: 'Message', mode: 'all', members: [['MessagePartOfConversation', 'message_id'], ['MessageTurnLink', 'message_id']] },
  { domain: 'Process', mode: 'all', members: [['ProcessOriginLink', 'process_id'], ['ProcessCompletionSourceLink', 'process_id']] },
  { domain: 'ContextSequenceNode', mode: 'all', members: [
    ['ContextSequenceRoot', 'root_node_id'], ['ContextSequenceRoot', 'tail_node_id'], ['ContextSequenceNode', 'parent_node_id']
  ] },
  { domain: 'ContextSegment', mode: 'all', members: [['ContextSequenceNode', 'segment_id'], ['CompressionBlockSource', 'segment_id']] },
  { domain: 'InteractionRequest', mode: 'any', members: [['InteractionOwnerLink', 'request_id']] },
  { domain: 'CollaborationBoardChannel', mode: 'any', members: [['CollaborationBoardChannelScopeLink', 'channel_id']] },
  { domain: 'CollaborationBoardPost', mode: 'any', members: [
    ['CollaborationBoardPostSourceLink', 'post_id'], ['CollaborationBoardPostChannelLink', 'post_id'], ['CollaborationBoardReplyLink', 'post_id']
  ] }
];

// Checked when this module loads: the rules name existing domains and columns.
(() => {
  const schemas = new Map(RUNTIME_DOMAIN_SCHEMAS.map((schema) => [schema.key, schema]));
  const column = (domain: string, name: string): void => {
    if (!schemas.get(domain)?.columns.some((item) => item.name === name)) {
      throw new Error(`Historical merge skip rule names an unknown column ${domain}.${name}.`);
    }
  };
  for (const rule of SKIPPED_WITH) {
    column(rule.domain, rule.column);
    if (rule.kind) column(rule.domain, rule.kind[0]);
    if (!schemas.has(rule.owner)) throw new Error(`Historical merge skip rule names an unknown domain ${rule.owner}.`);
  }
  for (const rule of SKIPPED_WITH_MEMBERS) {
    if (!schemas.has(rule.domain)) throw new Error(`Historical merge skip rule names an unknown domain ${rule.domain}.`);
    for (const [domain, name] of rule.members) column(domain, name);
  }
})();

/**
 * Every source row that belongs to the left-out conversations, by domain: the conversations, every
 * row with a foreign key to a left-out row, the ownership of SKIPPED_WITH and the members of
 * SKIPPED_WITH_MEMBERS, to a fixed point. So no row that is inserted references one that is left
 * out. Rows of the four content-derived domains are never left out (inserted only if still absent,
 * as ever). Cross-conversation collaboration history (collaboration messages with their source,
 * target, payload and reply links, inbox items, budgets, requests) and the branch or origin links
 * of other conversations stay, as when a conversation is deleted.
 */
function skippedRows(source: Database.Database, conversations: ReadonlySet<string>): Map<string, Set<string>> {
  const key = (domain: string, id: unknown): string => `${domain}\u0000${String(id)}`;
  const domainOf = new Map(RUNTIME_DOMAIN_SCHEMAS.map((schema) => [schema.table, schema.key]));
  // A row → the rows left out with it; a member row → what it is a member of (and how many members that has).
  const dependents = new Map<string, string[]>();
  const memberOf = new Map<string, Array<{ owner: string; all: boolean }>>();
  const members = new Map<string, number>();
  const append = <T>(map: Map<string, T[]>, at: string, value: T): void => {
    const list = map.get(at);
    if (list) list.push(value);
    else map.set(at, [value]);
  };
  for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
    if (IDENTITY_MERGE_DIFFERENCES.has(schema.key)) continue;
    const references = [
      ...schema.columns.flatMap((column) => {
        const owner = column.references ? domainOf.get(column.references.table) : undefined;
        return owner === undefined || IDENTITY_MERGE_DIFFERENCES.has(owner) ? [] : [{ column: column.name, owner, kind: undefined }];
      }),
      ...SKIPPED_WITH.filter((rule) => rule.domain === schema.key)
    ];
    const memberships = SKIPPED_WITH_MEMBERS.flatMap((rule) => rule.members
      .filter(([domain]) => domain === schema.key).map(([, column]) => ({ column, owner: rule.domain, all: rule.mode === 'all' })));
    if (references.length === 0 && memberships.length === 0) continue;
    const columns = [...new Set(['id', ...references.flatMap((item) => item.kind ? [item.column, item.kind[0]] : [item.column]),
      ...memberships.map((item) => item.column)])];
    const rows = source.prepare(`SELECT ${columns.map((column) => `"${column}"`).join(', ')} FROM "${schema.table}"`);
    for (const row of rows.iterate() as IterableIterator<Record<string, unknown>>) {
      const self = key(schema.key, row.id);
      for (const { column, owner, kind } of references) {
        if (row[column] !== null && (!kind || row[kind[0]] === kind[1])) append(dependents, key(owner, row[column]), self);
      }
      for (const { column, owner, all } of memberships) {
        if (row[column] === null) continue;
        const of = key(owner, row[column]);
        append(memberOf, self, { owner: of, all });
        if (all) members.set(of, (members.get(of) ?? 0) + 1);
      }
    }
  }
  const skipped = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const pending: string[] = [];
  const leftOut = new Map<string, number>();
  const skip = (at: string): void => {
    if (seen.has(at)) return;
    seen.add(at);
    pending.push(at);
    const split = at.indexOf('\u0000');
    const domain = at.slice(0, split);
    let ids = skipped.get(domain);
    if (!ids) skipped.set(domain, ids = new Set());
    ids.add(at.slice(split + 1));
  };
  for (const id of conversations) skip(key('Conversation', id));
  while (pending.length > 0) {
    const at = pending.pop()!;
    for (const dependent of dependents.get(at) ?? []) skip(dependent);
    for (const { owner, all } of memberOf.get(at) ?? []) {
      const count = (leftOut.get(owner) ?? 0) + 1;
      leftOut.set(owner, count);
      if (!all || count === members.get(owner)) skip(owner);
    }
  }
  return skipped;
}

interface RowPlan {
  steps: RepositoryTransactionStep[];
  inserted: Array<[string, string]>;
  reused: number;
  insertedConversations: number;
  conflicts: { count: number; samples: string[] };
}

/**
 * Builds one transaction: every source row is decoded by its domain codec and, when new, written
 * through the domain Repository insert step (historical copies for the terminal model-stream
 * domains). Existing ids are compared on decoded values. The transaction ends by asserting that
 * every source id exists in the receiving data set, so the committed row set is measured, not assumed.
 * Rows in `skipped` (see skippedRows) are left out entirely: not compared, inserted or asserted.
 */
async function planRows(
  source: Database.Database,
  target: RuntimeDatabase,
  skipped?: ReadonlyMap<string, ReadonlySet<string>>
): Promise<RowPlan> {
  const plan: RowPlan = { steps: [], inserted: [], reused: 0, insertedConversations: 0, conflicts: { count: 0, samples: [] } };
  const presence: RepositoryTransactionStep[] = [];
  const sink: RuntimeDataSetMergeChunkSink = {
    steps: plan.steps,
    presence,
    inserted: (domain, id) => {
      plan.inserted.push([domain, id]);
      if (domain === 'Conversation') plan.insertedConversations += 1;
    },
    reused: () => { plan.reused += 1; },
    conflict: (sample) => {
      plan.conflicts.count += 1;
      if (plan.conflicts.samples.length < MAX_REPORTED_CONFLICTS) plan.conflicts.samples.push(sample());
    },
    savepointName: () => `merge_identity_${plan.steps.length}`
  };
  for (const schema of MERGE_DOMAIN_ORDER) {
    const repository = DOMAIN_REPOSITORIES.domain(schema.key);
    const statement = source.prepare(mergeReadSql(schema));
    let chunk: DomainRow[] = [];
    const flush = async (): Promise<void> => {
      if (chunk.length === 0) return;
      const existing = (await target.snapshot(chunk.map((row) => repository.get(String(row.id))))).snapshot as Array<DomainRow | null>;
      planMergeChunk(schema, chunk, existing, sink);
      chunk = [];
      // Decoding stays on the extension thread; yield so a large source never monopolizes it.
      await new Promise((resolve) => setImmediate(resolve));
    };
    const leftOut = skipped?.get(schema.key);
    for (const raw of statement.iterate() as IterableIterator<Record<string, unknown>>) {
      if (leftOut?.has(String(raw.id))) continue;
      chunk.push(sourceRow(schema.key, String(raw.id), () => repository.codec.decode(raw)));
      if (chunk.length >= READ_CHUNK) await flush();
    }
    await flush();
  }
  // A loop, not push(...presence): an argument list of every source row overflows the call stack.
  if (plan.steps.length > 0) for (const step of presence) plan.steps.push(step);
  return plan;
}

/**
 * Where one chunk of planned source rows goes: planRows keeps the whole plan, the streamed merge
 * (runtimeDataSetStreamedMerge.ts) appends every chunk to its maintenance transaction.
 */
export interface RuntimeDataSetMergeChunkSink {
  /** Insert steps in source order (a content identity as a savepoint and its assertion). */
  steps: RepositoryTransactionStep[];
  /** One presence assertion per compared source row, asserted after the inserts they cover. */
  presence: RepositoryTransactionStep[];
  inserted(domain: string, id: string): void;
  reused(): void;
  /** A row that exists in the target with other values; `sample` describes it. */
  conflict(sample: () => string): void;
  /** A savepoint name not used before in this transaction. */
  savepointName(): string;
}

/** Source rows of one domain in merge order: a renumbered column's source order first (the order the transaction allocates it in). */
function mergeReadSql(schema: (typeof RUNTIME_DOMAIN_SCHEMAS)[number], where = ''): string {
  const renumbered = RENUMBERED_COLUMNS.get(schema.key);
  return `SELECT * FROM "${schema.table}"${where} ORDER BY ${renumbered ? `"${renumbered}", ` : ''}rowid`;
}

/**
 * The merge rule of every decoded source row, against the target row with its id (null: absent), the
 * one rule of planRows and the streamed merge: every row is asserted present at the end; an existing
 * id is reused when equal (a content identity may differ in its listed columns), else it conflicts;
 * a new row is inserted through its Repository (renumbered columns allocated in the transaction,
 * started or finished model-stream rows as historical copies, a content identity only while still
 * absent inside the transaction and then compared).
 */
export function planMergeChunk(
  schema: (typeof RUNTIME_DOMAIN_SCHEMAS)[number],
  chunk: readonly DomainRow[],
  existing: ReadonlyArray<DomainRow | null>,
  sink: RuntimeDataSetMergeChunkSink
): void {
  const repository = DOMAIN_REPOSITORIES.domain(schema.key);
  const allowed = IDENTITY_MERGE_DIFFERENCES.get(schema.key);
  const renumbered = RENUMBERED_COLUMNS.get(schema.key);
  const historical = HISTORICAL_COPY_DOMAINS.includes(schema.key);
  // A request that has not started yet is inserted exactly as the Runtime itself creates it
  // (prepared request, pending Operation and Attempt); started or finished ones are historical copies.
  const notStarted = (row: DomainRow): boolean => schema.key === 'ModelRequest' ? row.status === 'prepared'
    : schema.key === 'Operation' ? row.owner_kind === 'model_request' && row.status === 'pending'
      : schema.key === 'Attempt' && row.status === 'pending';
  for (const [index, row] of chunk.entries()) {
    const id = String(row.id);
    const current = existing[index];
    sink.presence.push(repository.assert(id, {}));
    if (current) {
      const differences = schema.columns.map((column) => column.name)
        .filter((column) => column !== renumbered && !isDeepStrictEqual(row[column], current[column]));
      if (differences.length === 0 || (allowed && differences.every((column) => allowed.has(column)))) {
        sink.reused();
      } else {
        sink.conflict(() => `${schema.key}#${id} 字段不同：${differences.join(',')}`);
      }
      continue;
    }
    const insert = sourceRow(schema.key, id, () => renumbered
      ? repository.insertWithNextSequence(withoutColumn(row, renumbered), { column: renumbered, scope: {} })
      : historical && !notStarted(row) ? repository.insertHistoricalCopy(row) : repository.insert(row));
    if (allowed) {
      // Another window may create the same content-derived identity before this commit: inside
      // the transaction it is inserted only when still absent, else compared like above.
      sink.steps.push(savepoint(sink.savepointName(), [insert], {
        kind: 'rollback-and-continue-on-unique',
        constraints: uniqueIdentities(schema).map((columns) => ({ domain: schema.key, columns }))
      }), repository.assert(id, Object.fromEntries(schema.columns
        .filter((column) => column.name !== 'id' && !allowed.has(column.name))
        .map((column) => [column.name, row[column.name]]))));
    } else {
      sink.steps.push(insert);
    }
    sink.inserted(schema.key, id);
  }
}

/** A source row the current codec or insert rules reject is the source's own, lasting problem. */
function sourceRow<T>(domain: string, id: string, read: () => T): T {
  try {
    return read();
  } catch (error) {
    // An engine limit (e.g. the call stack) says nothing about the row.
    if (error instanceof RangeError) throw error;
    throw new Outcome({ kind: 'failed', code: 'runtime-data-set-merge-source-row-invalid', message: `这个历史库里有一行记录不符合当前格式（${domain}#${id}）：${errorMessage(error)}` });
  }
}

/** The id and every declared UNIQUE column set of a domain (any of them can reject a duplicate). */
function uniqueIdentities(schema: (typeof RUNTIME_DOMAIN_SCHEMAS)[number]): string[][] {
  const sets = new Map<string, string[]>([['id', ['id']]]);
  for (const index of schema.indexes) {
    const match = /^(.+?) UNIQUE(?: WHERE .*)?$/.exec(index);
    if (!match) continue;
    const columns = match[1].split(',').map((column) => column.trim());
    sets.set([...columns].sort().join(','), columns);
  }
  return [...sets.values()];
}

function withoutColumn(row: DomainRow, column: string): DomainRow {
  const rest = { ...row };
  delete rest[column];
  return rest;
}

/**
 * Rows of a merge commit's evidence (commits/<id>.json): its inserted conversations all count, the
 * other domains' first and last rows shrink to keep within it (to one each at least).
 */
export const RUNTIME_DATA_SET_MERGE_COMMIT_EVIDENCE_ROWS = 2_000;
const EVIDENCE_PER_END = 50;

/**
 * Evidence of one merge commit, which is one atomic transaction (any row it inserted proves it
 * committed): every inserted Conversation (recorded per target after a crash, see mergedInto) and
 * of every other domain that is no content identity (those may appear in the target on their own)
 * the first and last EVIDENCE_PER_END inserted rows, fewer per domain when that keeps the whole
 * within RUNTIME_DATA_SET_MERGE_COMMIT_EVIDENCE_ROWS (never fewer than the first and the last).
 * Collected row by row in insert order, so a streamed merge holds only this much.
 */
export class RuntimeDataSetMergeEvidence {
  private readonly conversations: string[] = [];
  private readonly domains = new Map<string, { first: string[]; ring: string[]; count: number }>();

  public add(domain: string, id: string): void {
    if (domain === 'Conversation') {
      this.conversations.push(id);
      return;
    }
    if (IDENTITY_MERGE_DIFFERENCES.has(domain)) return;
    let entry = this.domains.get(domain);
    if (!entry) this.domains.set(domain, entry = { first: [], ring: [], count: 0 });
    if (entry.count < EVIDENCE_PER_END) entry.first.push(id);
    entry.ring[entry.count % EVIDENCE_PER_END] = id;
    entry.count += 1;
  }

  /** Every Conversation inserted, in insert order. */
  public get conversationIds(): readonly string[] {
    return this.conversations;
  }

  public rows(): Array<[domain: string, id: string]> {
    const entries = [...this.domains.entries()];
    const size = (perEnd: number): number => entries.reduce((sum, [, entry]) => sum + Math.min(entry.count, 2 * perEnd), 0);
    let perEnd = EVIDENCE_PER_END;
    while (perEnd > 1 && this.conversations.length + size(perEnd) > RUNTIME_DATA_SET_MERGE_COMMIT_EVIDENCE_ROWS) perEnd -= 1;
    const rows: Array<[string, string]> = this.conversations.map((id) => ['Conversation', id]);
    for (const [domain, { first, ring, count }] of entries) {
      // Positions 0..perEnd-1 and count-perEnd..count-1 (all of them when count <= 2 * perEnd).
      for (let position = 0; position < count; position += 1) {
        if (position >= perEnd && position < count - perEnd) {
          position = count - perEnd - 1;
          continue;
        }
        rows.push([domain, position < EVIDENCE_PER_END ? first[position] : ring[position % EVIDENCE_PER_END]]);
      }
    }
    return rows;
  }
}

function mergeCommitEvidence(inserted: ReadonlyArray<readonly [domain: string, id: string]>): Array<[string, string]> {
  const evidence = new RuntimeDataSetMergeEvidence();
  for (const [domain, id] of inserted) evidence.add(domain, id);
  return evidence.rows();
}

/**
 * Presence of a merge's inserted rows in the target, counting only rows that exist nowhere else:
 * a content-derived identity (content, project, attachment, observation) may appear in the target
 * independently at any time (another window opens the same folder or stores the same bytes), so it
 * is no evidence of this commit.
 */
async function insertedRowsPresence(
  inserted: ReadonlyArray<readonly [domain: string, id: string]>,
  database: RuntimeDatabase
): Promise<'all' | 'none' | 'partial'> {
  const evidence = inserted.filter(([domain]) => !IDENTITY_MERGE_DIFFERENCES.has(domain));
  if (evidence.length === 0) return 'none';
  let present = 0;
  for (let start = 0; start < evidence.length; start += READ_CHUNK) {
    const rows = evidence.slice(start, start + READ_CHUNK);
    const found = (await database.snapshot(rows.map(([domain, id]) => DOMAIN_REPOSITORIES.domain(domain).get(id)))).snapshot;
    present += found.filter((row) => row !== null).length;
  }
  return present === 0 ? 'none' : present === evidence.length ? 'all' : 'partial';
}

/**
 * Puts back the record a committing record replaced, unchanged (its time of judgment decides whether
 * a later request retries it); none: the source had no record.
 */
async function restoreLedgerRecord(
  paths: { globalStoragePath: string },
  candidateId: string,
  previous: RuntimeDataSetMergeLedgerRecord | undefined
): Promise<void> {
  if (previous) await restoreRuntimeDataSetMergeLedgerRecord(paths, previous);
  else await removeRuntimeDataSetMergeLedgerRecord(paths, candidateId);
}

async function transferCas(
  sourceConfigurationRootPath: string,
  sourceBinding: HistoricalRootBinding,
  targetConfigurationRootPath: string,
  targetBinding: HistoricalRootBinding,
  source: Database.Database,
  options: Pick<RuntimeDataSetMergeOptions, 'linkFile'> & {
    /** Verify every object (source bytes, existing target bytes) without publishing anything. */
    verifyOnly?: boolean;
    /** Files already verified (this merge, or an earlier pre-copy), by file identity; unchanged ones are not hashed again. */
    verified?: CasVerification;
    /** Stops before the next object; the temporary file of an interrupted copy is removed. */
    signal?: AbortSignal;
  } = {}
): Promise<RuntimeDataSetCasTransfer> {
  const result = { linkedCasObjects: 0, copiedCasObjects: 0, reusedCasObjects: 0 };
  const verified = options.verified ?? new Map<string, string>();
  const sourceCas = path.resolve(sourceBinding.paths.casRootPath);
  const targetCas = path.resolve(targetBinding.paths.casRootPath);
  await assertNoSymbolicPath(sourceConfigurationRootPath, sourceCas);
  await assertNoSymbolicPath(targetConfigurationRootPath, targetCas);
  // Streamed in rowid pages (no GROUP BY sort, no whole result on this thread): a storage key is
  // handled once, and every row of it must name the same length.
  const page = source.prepare(`
    SELECT rowid AS position, storage_key, sha256, byte_length FROM content_object
     WHERE rowid > ? ORDER BY rowid LIMIT ${READ_CHUNK}
  `);
  const lengths = new Map<string, bigint>();
  const touchedDirectories = new Set<string>();
  const temporaryRoot = path.join(targetCas, 'tmp');
  let temporaryUsed = false;
  const link = options.linkFile ?? ((from: string, to: string) => fs.link(from, to));
  try {
    for (let after = 0n; ;) {
      const rows = page.all(after) as Array<{ position: bigint; storage_key: string; sha256: string; byte_length: bigint }>;
      if (rows.length === 0) break;
      after = rows[rows.length - 1].position;
      for (const row of rows) {
        options.signal?.throwIfAborted();
        const known = lengths.get(row.storage_key);
        if (storageKeyForDigest(row.sha256) !== row.storage_key || (known !== undefined && known !== row.byte_length)) {
          throw new Outcome({ kind: 'failed', code: 'runtime-data-set-merge-source-cas-invalid', message: `来源的正文登记不一致：${row.storage_key}。` });
        }
        if (known !== undefined) continue;
        lengths.set(row.storage_key, row.byte_length);
        const sourceFile = casPath(sourceCas, row.storage_key);
        const targetFile = casPath(targetCas, row.storage_key);
        // One synchronous lstat (metadata only, microseconds): an object this copy or an earlier
        // pre-copy verified and that is unchanged since is neither awaited nor hashed again.
        const existing = lstatSync(targetFile, { bigint: true, throwIfNoEntry: false });
        if (existing !== undefined) {
          if (!existing.isFile()) {
            throw new Outcome({ kind: 'blocked', code: 'runtime-data-set-merge-target-cas-damaged', message: `当前历史库里的正文位置不是普通文件：${row.storage_key}。为免覆盖，暂不合并。` });
          }
          // CAS files are never rewritten: an existing object must already be exactly these bytes.
          if (existing.size !== row.byte_length
            || (verified.get(targetFile) !== fileIdentity(existing) && !await hasDigest(targetFile, row.sha256, verified))) {
            throw new Outcome({ kind: 'blocked', code: 'runtime-data-set-merge-target-cas-damaged', message: `当前历史库里的正文文件已损坏：${row.storage_key}。为免覆盖，暂不合并。` });
          }
          result.reusedCasObjects += 1;
          continue;
        }
        // A missing, irregular, short or different source object is the source's own lasting problem.
        const sourceSize = await regularFileSize(sourceFile).catch((error: unknown) => {
          if (error instanceof NotRegularFile) return undefined;
          throw error;
        });
        if (sourceSize !== row.byte_length || !await hasDigest(sourceFile, row.sha256, verified)) {
          throw new Outcome({ kind: 'failed', code: 'runtime-data-set-merge-source-cas-invalid', message: `来源缺少正文文件或内容与摘要不符：${row.storage_key}。` });
        }
        if (options.verifyOnly) continue;
        const prefix = path.dirname(targetFile);
        await ensureDirectory(targetCas, path.join(targetCas, 'sha256'), touchedDirectories);
        await ensureDirectory(path.join(targetCas, 'sha256'), prefix, touchedDirectories);
        let copied = false;
        try {
          // The source object was verified just above; a hard link publishes those same bytes.
          await link(sourceFile, targetFile);
          await rememberLinked(sourceFile, targetFile, verified);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'EEXIST') {
            if (await regularFileSize(targetFile) !== row.byte_length || await sha256File(targetFile) !== row.sha256) throw error;
          } else if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EMLINK') {
            if (!temporaryUsed) {
              await fs.mkdir(temporaryRoot, { recursive: true });
              temporaryUsed = true;
            }
            await copyIntoCas(temporaryRoot, sourceFile, targetFile, row.sha256, verified);
            copied = true;
          } else {
            throw error;
          }
        }
        touchedDirectories.add(prefix);
        if (copied) result.copiedCasObjects += 1;
        else result.linkedCasObjects += 1;
      }
      // Verified objects need no I/O wait at all: yield between pages so the thread stays responsive.
      await new Promise((resolve) => setImmediate(resolve));
    }
    // Every file was fsynced before it was linked; one fsync per touched directory makes the new
    // entries durable before any row that references them is committed.
    for (const directory of touchedDirectories) await syncDirectoryDurably(directory);
  } finally {
    // The temporary files are gone (each copy removes its own); their directory is synced once.
    if (temporaryUsed) await syncDirectoryDurably(temporaryRoot).catch(() => undefined);
  }
  return result;
}

/**
 * Copy, fsync and verify a private temporary file; only verified bytes are linked into the CAS.
 * The temporary directory is synced once by the caller, not per object.
 */
async function copyIntoCas(
  temporaryRoot: string,
  sourceFile: string,
  targetFile: string,
  digest: string,
  verified: CasVerification
): Promise<void> {
  const temporary = path.join(temporaryRoot, `${process.pid}-${randomUUID()}${CAS_COPY_SUFFIX}`);
  let published = false;
  try {
    await fs.copyFile(sourceFile, temporary, constants.COPYFILE_EXCL);
    await fs.chmod(temporary, 0o600);
    const handle = await fs.open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    if (await sha256File(temporary) !== digest) {
      throw new Outcome({ kind: 'failed', code: 'runtime-data-set-merge-source-cas-invalid', message: `复制出的正文文件摘要不符：${path.basename(targetFile)}。` });
    }
    try {
      await fs.link(temporary, targetFile);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await sha256File(targetFile) !== digest) throw error;
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
  // The published inode is the verified private copy; recorded once its temporary name is gone
  // (every link count change moves the ctime).
  if (published) {
    verified.delete(sourceFile);
    verified.set(targetFile, fileIdentity(await fs.lstat(targetFile, { bigint: true })));
  }
}

/**
 * A hard link changes the shared inode's ctime. When the inode is still the one whose bytes were
 * just verified (same device, inode, size and mtime), the published name is recorded with its new
 * identity, so a later pass (the exclusive phase after an online pre-copy) does not hash it again.
 */
async function rememberLinked(sourceFile: string, targetFile: string, verified: CasVerification): Promise<void> {
  const before = verified.get(sourceFile);
  if (before === undefined) return;
  const after = await fs.lstat(targetFile, { bigint: true }).then(fileIdentity, () => undefined);
  if (after === undefined) return;
  // Only the published name is kept: a later pass checks the target object, and the source name
  // is needed again only after the target was discarded (which changes the ctime anyway).
  verified.delete(sourceFile);
  if (sameContentIdentity(before, after)) verified.set(targetFile, after);
}

/** Online Backup API copy of the target, once per batch; failures leave no partial files behind. */
async function ensureTargetBackup(target: TargetContext, options: RuntimeDataSetMergeOptions): Promise<string> {
  if (target.backup.path) return target.backup.path;
  await assertRoomForBackup(target.binding.paths.databasePath, target.controlRoot, '当前历史库', options);
  const backups = path.join(target.controlRoot, RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY);
  const root = path.join(backups, backupDirectoryName());
  const destination = path.join(root, 'limcode.sqlite');
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await writeDurableJson(path.join(root, 'root-binding.json'), target.binding);
    await target.database.backupTo(temporary);
    await fs.chmod(temporary, 0o600);
    const copy = new Database(toSqliteFilePath(temporary), { readonly: true, fileMustExist: true });
    try {
      copy.defaultSafeIntegers(true);
      assertCurrentSchema(copy, target.binding);
    } finally {
      copy.close();
    }
    await removeSqliteSidecars(temporary);
    await fs.rename(temporary, destination);
    await syncDirectoryDurably(root);
    await syncDirectoryDurably(backups);
  } catch (error) {
    await removeSqliteFiles(temporary);
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    await fs.rmdir(backups).catch(() => undefined);
    throw new Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-backup-failed', message: `合并前备份当前历史库失败，稍后重试：${errorMessage(error)}` });
  }
  target.backup.path = root;
  return root;
}

/**
 * End of a batch: a backup that no row transaction used (every source was refused or deferred,
 * or its transaction proven rolled back) is removed again, so retries do not pile up copies of an
 * unchanged target; otherwise older backups are pruned.
 */
async function settleTargetBackup(
  target: TargetContext,
  options: { keepUsed?: boolean; keep?: string } = {}
): Promise<void> {
  const backup = target.backup.path;
  if (!backup) return;
  if (!target.backup.used) {
    target.backup = {};
    await fs.rm(backup, { recursive: true, force: true });
    await syncDirectoryDurably(path.dirname(backup)).catch(() => undefined);
    return;
  }
  if (!options.keepUsed) await pruneTargetBackups(target, [path.basename(backup), ...(options.keep ? [options.keep] : [])]);
}

/**
 * Keeps the newest target backups by creation time, plus `keep` (this batch's own and the newest
 * from before it); the ones removed only ever held pre-merge copies.
 */
async function pruneTargetBackups(target: TargetContext, keep: readonly string[]): Promise<void> {
  const backups = path.join(target.controlRoot, RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY);
  const names = await targetBackupsByAge(backups);
  for (const name of names.slice(0, Math.max(0, names.length - RUNTIME_DATA_SET_MERGE_BACKUP_RETENTION))) {
    if (!keep.includes(name)) await fs.rm(path.join(backups, name), { recursive: true, force: true });
  }
  await syncDirectoryDurably(backups);
}

async function newestTargetBackup(target: TargetContext): Promise<string | undefined> {
  return (await targetBackupsByAge(path.join(target.controlRoot, RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY)).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  })).at(-1);
}

/** Backup directories of this engine, oldest first (millisecond time, then creation order). */
async function targetBackupsByAge(backups: string): Promise<string[]> {
  const parsed = (await fs.readdir(backups)).flatMap((name) => {
    const match = BACKUP_NAME.exec(name);
    return match ? [{ name, time: match[1], sequence: Number(match[2]) }] : [];
  });
  parsed.sort((left, right) => left.time.localeCompare(right.time) || left.sequence - right.sequence
    || left.name.localeCompare(right.name));
  return parsed.map((entry) => entry.name);
}

/** Source backup before finalization, with the offline SQLite Backup API, beside the source. */
async function backupSource(binding: HistoricalRootBinding, options: RuntimeDataSetMergeOptions): Promise<string> {
  await assertRoomForBackup(binding.paths.databasePath, path.dirname(binding.paths.dataRootPath), '这份旧聊天记录', options);
  const backups = path.join(path.dirname(binding.paths.dataRootPath), RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY);
  const root = path.join(backups, backupDirectoryName());
  const destination = path.join(root, 'limcode.sqlite');
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    await writeDurableJson(path.join(root, 'root-binding.json'), binding);
    const live = new Database(toSqliteFilePath(binding.paths.databasePath), { readonly: true, fileMustExist: true });
    try { await live.backup(toSqliteFilePath(temporary), { progress: () => 0x7fffffff }); }
    finally { live.close(); }
    await fs.chmod(temporary, 0o600);
    await removeSqliteSidecars(temporary);
    await fs.rename(temporary, destination);
    await syncDirectoryDurably(root);
    await syncDirectoryDurably(backups);
  } catch (error) {
    await removeSqliteFiles(temporary);
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    await fs.rmdir(backups).catch(() => undefined);
    throw new Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-source-backup-failed', message: `收尾前备份来源失败，稍后重试：${errorMessage(error)}` });
  }
  return root;
}

/** Free space kept beyond a backup on its disk, so a merge never fills it for the windows writing there. */
const BACKUP_FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

/**
 * A full backup of `databasePath` (database and WAL, at most their size) in `directory` needs that
 * much room plus a margin on its disk: without it the merge is deferred before anything is written,
 * so a full disk is never filled again at every startup. Free space the platform cannot tell is
 * not checked (the copy itself then fails cleanly).
 */
async function assertRoomForBackup(
  databasePath: string,
  directory: string,
  what: string,
  options: RuntimeDataSetMergeOptions
): Promise<void> {
  let bytes = BACKUP_FREE_SPACE_MARGIN_BYTES;
  for (const file of [databasePath, `${databasePath}-wal`]) bytes += await fs.stat(file).then((info) => info.size, () => 0);
  const free = await (options.freeSpace ?? freeSpace)(directory).catch(() => undefined);
  if (free === undefined || free >= bytes) return;
  throw new Outcome({
    kind: 'deferred', code: 'runtime-data-set-merge-disk-full',
    message: `磁盘空间不足，需要约 ${Math.ceil(bytes / (1024 * 1024))} MB：合并前要先在 ${directory} 备份${what}`
  });
}

async function freeSpace(directory: string): Promise<number | undefined> {
  const stats = await fs.statfs(directory);
  return Number(stats.bavail) * Number(stats.bsize);
}

function fingerprintDigest(fingerprint: RuntimeDataSetFingerprint): string {
  return createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex').slice(0, 16);
}

async function fault(options: RuntimeDataSetMergeOptions, point: RuntimeDataSetMergeFaultPoint): Promise<void> {
  await options.onFaultPoint?.(point);
}

function casPath(casRoot: string, storageKey: string): string {
  const file = path.resolve(casRoot, ...storageKey.split('/'));
  if (!isPathBelow(casRoot, file)) throw new Error(`CAS path escapes its root: ${storageKey}`);
  return file;
}

class NotRegularFile extends Error {}

async function regularFileSize(file: string): Promise<bigint | undefined> {
  try {
    const info = await fs.lstat(file, { bigint: true });
    if (!info.isFile()) throw new NotRegularFile(`CAS entry is not a regular file: ${file}`);
    return info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function ensureDirectory(parent: string, directory: string, touched: Set<string>): Promise<void> {
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    touched.add(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`CAS path is not a directory: ${directory}`);
  }
}

/** sha256 of a file; one verified before and unchanged since (same device, inode, size, times) is not read again. */
async function hasDigest(file: string, digest: string, verified: CasVerification): Promise<boolean> {
  const identity = fileIdentity(await fs.lstat(file, { bigint: true }));
  if (verified.get(file) === identity) return true;
  if (await sha256File(file) !== digest) return false;
  verified.set(file, identity);
  return true;
}

function fileIdentity(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

/** Same device, inode, size and mtime (the ctime may differ: a link count change). */
function sameContentIdentity(left: string, right: string): boolean {
  return left.slice(0, left.lastIndexOf(':')) === right.slice(0, right.lastIndexOf(':'));
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function removeSqliteSidecars(file: string): Promise<void> {
  await Promise.all(['-wal', '-shm', '-journal'].map((suffix) => fs.rm(`${file}${suffix}`, { force: true })));
}

async function removeSqliteFiles(file: string): Promise<void> {
  await Promise.all(['', '-wal', '-shm', '-journal'].map((suffix) => fs.rm(`${file}${suffix}`, { force: true }).catch(() => undefined)));
}

async function writeDurableJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try { await fs.rename(temporary, file); }
  finally { await fs.rm(temporary, { force: true }); }
}

export const BACKUP_NAME = /^(\d{8}T\d{9}Z)-(\d{6,})-[0-9a-f]{8}$/;
let backupSequence = 0;

/** UTC time to the millisecond, then a per-process sequence: sorts by creation even within one ms. */
function backupDirectoryName(): string {
  backupSequence += 1;
  return `${new Date().toISOString().replace(/[-:.]/g, '')}-${String(backupSequence).padStart(6, '0')}-${randomUUID().slice(0, 8)}`;
}

/**
 * Errors that say nothing about the source itself: I/O, space, permissions, busy or closed
 * databases, anywhere in the cause chain. They are retried later, never recorded as failures.
 */
function isTransientError(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === 'object' && !seen.has(current); current = (current as { cause?: unknown }).cause) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code !== 'string') continue;
    if (TRANSIENT_ERRNO_CODES.has(code) || /^SQLITE_(?:BUSY|LOCKED|IOERR|FULL|NOMEM|CANTOPEN|INTERRUPT|PROTOCOL|READONLY)/.test(code)) return true;
  }
  return false;
}

const TRANSIENT_ERRNO_CODES = new Set([
  'EACCES', 'EAGAIN', 'EBUSY', 'EDQUOT', 'EINTR', 'EIO', 'EMFILE', 'ENFILE', 'ENOMEM', 'ENOSPC', 'EPERM', 'EROFS', 'ETIMEDOUT'
]);

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'runtime-data-set-merge-failed';
}

/** A reason ending in exactly one full stop, whatever punctuation it came with. */
function sentence(text: string): string {
  return `${text.trim().replace(/[。．.！!；;，,\s]+$/u, '')}。`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------------
// Shared with runtimeDataSetBulkCopy (data-root migration into an empty, not yet visible root).
// Same source rules as a migration merge; the rows are written there in several transactions.
// ---------------------------------------------------------------------------------------------

/** Domain keys in the insert order of one copy (see MERGE_DOMAIN_ORDER). */
export const RUNTIME_DATA_SET_INSERT_ORDER: readonly string[] = Object.freeze(MERGE_DOMAIN_ORDER.map((schema) => schema.key));

/** Rows read per source query of a copy (and of the merge plan). */
export const RUNTIME_DATA_SET_READ_CHUNK = READ_CHUNK;

export interface RuntimeDataSetMigrationSource {
  candidate: VscodeRuntimeDataSetCandidate;
  binding: HistoricalRootBinding;
  /** The verified private snapshot (read-only, safe integers); never the source files. */
  database: Database.Database;
  /** Exact SQLite file state of the source the snapshot was taken from. */
  files: string;
  rows: number;
  upgradedFromEpoch?: 3 | 4;
  close(): Promise<void>;
}

/**
 * An offline source resolved exactly as a migration merge resolves it (identity, no Host, no
 * pending recovery, published 3/4 upgraded in place), with its verified snapshot: integrity,
 * fingerprint and carried unfinished work (a streaming request or a running process refuses it).
 */
export async function openRuntimeDataSetMigrationSource(
  paths: { globalStoragePath: string },
  input: { candidateId: string; expectedDataSetId: string; expectedRootInstanceId: string },
  targetIdentity: RuntimeDataSetIdentity
): Promise<RuntimeDataSetMigrationSource> {
  const mode: SourceMode = { finalizeWork: false, requested: true, migration: true };
  const state: SourceProgress = {};
  try {
    const resolved = await resolveVscodeRuntimeDataSet(paths, input.candidateId);
    if (resolved.dataSetId !== input.expectedDataSetId || resolved.rootInstanceId !== input.expectedRootInstanceId) {
      throw new RuntimeDataSetMergeError('runtime-data-set-merge-identity-mismatch', '来源历史库的身份已变化，本次不复制。');
    }
    const { candidate, binding } = await resolveSource(paths, { identity: targetIdentity }, input.candidateId, mode, state);
    const taken = await takeVerifiedSnapshot(candidate, binding, 'carry', state, mode);
    try {
      assertCarriable(taken.audit.carriedWork!);
    } catch (error) {
      await taken.snapshot.close();
      throw error;
    }
    return {
      candidate, binding, database: taken.snapshot.database, files: state.files!, rows: taken.audit.size!.rows,
      ...(state.upgradedFromEpoch !== undefined ? { upgradedFromEpoch: state.upgradedFromEpoch } : {}),
      close: () => taken.snapshot.close()
    };
  } catch (error) {
    throw runtimeDataSetMergeFailure(error, state);
  }
}

/**
 * Under the source's configuration admission and maintenance claim: no Host uses the source and it
 * is still exactly what was copied (identity, root generation, pointer revision, SQLite file state).
 */
export async function isRuntimeDataSetMigrationSourceUnchanged(
  paths: { globalStoragePath: string },
  expected: { candidateId: string; dataSetId: string; rootInstanceId: string; rootGeneration: number; pointerRevision: number; files: string }
): Promise<boolean> {
  try {
    return await withRuntimeDataRootAdmission(paths.globalStoragePath, async () => {
      const candidate = await resolveVscodeRuntimeDataSet(paths, expected.candidateId);
      const binding = candidate.dataSetId ? await requireCompleteRuntimeDataSet(candidate).catch(() => undefined) : undefined;
      if (!binding || candidate.dataSetId !== expected.dataSetId || candidate.rootInstanceId !== expected.rootInstanceId
        || binding.rootGeneration !== expected.rootGeneration || binding.pointerRevision !== expected.pointerRevision) return false;
      return withRuntimeMaintenance(binding.paths, async () => {
        await assertSourceIdle(candidate);
        return await runtimeDataSetFileState(binding.paths.databasePath) === expected.files;
      });
    });
  } catch (error) {
    throw runtimeDataSetMergeFailure(error, {});
  }
}

/** CAS transfer of a migration source into another root (verified before publication, see transferCas). */
export async function transferRuntimeDataSetMigrationCas(
  source: RuntimeDataSetMigrationSource,
  target: { configurationRootPath: string; binding: HistoricalRootBinding },
  options: Pick<RuntimeDataSetMergeOptions, 'linkFile'> & { verified: RuntimeDataSetCasVerification; signal?: AbortSignal }
): Promise<RuntimeDataSetCasTransfer> {
  try {
    return await transferCas(source.candidate.configurationRootPath, source.binding, target.configurationRootPath, target.binding,
      source.database, options);
  } catch (error) {
    throw runtimeDataSetMergeFailure(error, {});
  }
}

/**
 * The Repository insert step of a copied row: a request that has not started yet is inserted exactly
 * as the Runtime itself creates it (prepared request, pending Operation and Attempt); started or
 * finished rows of the model-stream domains are historical copies (still under the worker's rules).
 * The same rule as planRows applies to a merge.
 */
function copyInsertStep(domain: string, row: DomainRow): RepositoryTransactionStep {
  const repository = DOMAIN_REPOSITORIES.domain(domain);
  const notStarted = domain === 'ModelRequest' ? row.status === 'prepared'
    : domain === 'Operation' ? row.owner_kind === 'model_request' && row.status === 'pending'
      : domain === 'Attempt' && row.status === 'pending';
  return HISTORICAL_COPY_DOMAINS.includes(domain) && !notStarted ? repository.insertHistoricalCopy(row) : repository.insert(row);
}

/** A raw source row decoded by its domain codec, and its Repository insert step (see copyInsertStep). */
export function runtimeDataSetCopyRow(domain: string, raw: Record<string, unknown>): { id: string; step: RepositoryTransactionStep } {
  const id = String(raw.id);
  const row = sourceRow(domain, id, () => DOMAIN_REPOSITORIES.domain(domain).codec.decode(raw));
  return { id, step: sourceRow(domain, id, () => copyInsertStep(domain, row)) };
}

/**
 * The error a caller of the copy sees: a source refusal as RuntimeDataSetMergeError (code and
 * user-facing message, with the in-place upgrade noted); a cancellation and anything else unchanged.
 */
export function runtimeDataSetMergeFailure(error: unknown, state: { upgradedFromEpoch?: 3 | 4 }): unknown {
  if (error instanceof RuntimeDataSetMergeError || (error instanceof Error && error.name === 'AbortError')) return error;
  if (!(error instanceof Outcome) && !(error instanceof StopRequested) && !isRuntimeHostsActiveError(error)) return error;
  const outcome = sourceOutcome(error, state);
  return outcome.kind === 'stopped'
    ? new RuntimeDataSetMergeError('runtime-data-set-merge-stopped', '合并已停止。', error)
    : new RuntimeDataSetMergeError(outcome.code, outcome.message, error);
}

// ---------------------------------------------------------------------------------------------
// Shared with runtimeDataSetStreamedMerge (the large-merge session): the same source resolution,
// checks, finalization, CAS, backup, ledger and outcome rules as an online merge; only the plan and
// the transaction are streamed there.
// ---------------------------------------------------------------------------------------------

/** @internal The engine pieces a large-merge session reuses unchanged; no API for anything else. */
export const HISTORICAL_MERGE_ENGINE = Object.freeze({
  MERGE_DOMAIN_ORDER, IDENTITY_MERGE_DIFFERENCES, SKIPPED_WITH, SKIPPED_WITH_MEMBERS, MAX_REPORTED_CONFLICTS, READ_CHUNK,
  BACKUP_FREE_SPACE_MARGIN_BYTES, Outcome, StopRequested, MergedMeanwhile,
  targetContext, pickSources, runSourceAttempt, settledSource, resolveSource, recordedConversations, takeVerifiedSnapshot,
  countFinalized, assertMergeableSize, exceedsOnlineLimits, unfinishedWorkOutcome, conflictRefusal, deletedSinceMerge, transferSourceCas, finalizeSource,
  commitSource, ensureTargetBackup, settleTargetBackup, newestTargetBackup, assertSourceUnchanged, takeFinalized, finalizedResult,
  unchangedResult, currentResult, insertedRowsPresence, restoreLedgerRecord, mergeReadSql, sourceRow, errorCode, errorMessage,
  isTransientError, fault, freeSpace
});
export type {
  PickedSource as HistoricalMergePickedSource, Refusal as HistoricalMergeRefusal, RowPlan as HistoricalMergeRowPlan,
  SourceMode as HistoricalMergeSourceMode, SourceOutcome as HistoricalMergeSourceOutcome,
  SourceProgress as HistoricalMergeSourceProgress, TargetContext as HistoricalMergeTargetContext
};

export { KEPT_MERGE_FINALIZATION_REASON, MERGE_FINALIZATION_REASON };
