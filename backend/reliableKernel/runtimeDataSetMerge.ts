import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
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
  describeUnfinishedWork, finalizeUnfinishedWork, hasFinalizableWork, MERGE_FINALIZATION_REASON,
  type CarriedWorkRefusals, type UnfinishedWorkInspection
} from './runtimeDataSetMergeWork';
import {
  pruneRuntimeDataSetMergeCommits, readRuntimeDataSetMergeCommit, readRuntimeDataSetMergeLedger,
  readRuntimeDataSetMergeRequests, rememberRuntimeDataSetFingerprint, removeRuntimeDataSetMergeCommit,
  removeRuntimeDataSetMergeLedgerRecord, removeRuntimeDataSetMergeRequest, runtimeDataSetFingerprint, runtimeDataSetLastMerge,
  sameRuntimeDataSetFingerprint, sameRuntimeDataSetIdentity, writeRuntimeDataSetMergeCommit,
  writeRuntimeDataSetMergeLedgerRecord, writeRuntimeDataSetMergeRequest,
  type RuntimeDataSetFingerprint, type RuntimeDataSetIdentity, type RuntimeDataSetMergeLedgerRecord
} from './runtimeDataSetMergeLedger';
import { runtimeDataSetFileState } from './runtimeDataSetFacts';
import { upgradeRuntimeDataSet } from './runtimeDataSetUpgrade';
import {
  assertRuntimeHostsOffline, isRuntimeHostsActiveError, withRuntimeDataRootAdmission, withRuntimeMaintenance
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
 * which wraps that last step alone. The ledger records every outcome by exact source file state.
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
 * retry beyond busy_timeout (5 s). Measured (source rows, one transaction, another process writing
 * every 2 ms): 1,249 rows commit in ~0.2 s on an idle machine and in ~1.5 s with the merge, the
 * other writer and six CPU-bound processes all pinned to one core (the other writer's longest wait
 * ~1.4 s). 1,200 rows keep that worst case well below busy_timeout; larger sources use the
 * exclusive fallback.
 */
export const RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS = Object.freeze({ maxRows: 1_200, maxBytes: 4 * 1024 * 1024 });
/**
 * Hard bound of one historical merge transaction, online or exclusive: the plan and the worker's
 * transaction hold every row in memory (measured ~150 MB + 30 KB per row in the extension host, over
 * 1 GB at ~28,000 rows). A larger source is not merged at all (no coordination, backup or
 * finalization) and is recorded as too large for this limit; a version with another limit judges
 * it again. Data-root migration has no such bound.
 */
export const RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS = 25_000;

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
 * key (allocated as MAX + 1); it is not frozen in any JSON, CAS content or other row. Source rows
 * are shifted past the receiving maximum, which keeps their relative order.
 */
const RENUMBERED_COLUMNS: ReadonlyMap<string, string> = new Map([['CollaborationMessage', 'message_seq']]);

export type RuntimeDataSetMergeFaultPoint =
  | 'after-source-backup'
  | 'after-target-backup'
  | 'after-cas-transfer'
  | 'before-row-commit'
  | 'after-row-commit';

export interface RuntimeDataSetMergeOptions {
  /** Test-only crash injection at durable boundaries. */
  onFaultPoint?(point: RuntimeDataSetMergeFaultPoint): void | Promise<void>;
  /** Defaults to fs.link; a cross-device or unsupported link falls back to a verified copy. */
  linkFile?(source: string, target: string): Promise<void>;
  /** Defaults to {@link RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS}. */
  limits?: { maxRows: number; maxBytes: number };
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
}

export interface RuntimeDataSetCasTransfer {
  linkedCasObjects: number;
  copiedCasObjects: number;
  reusedCasObjects: number;
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
  /** Unfinished work closed before the merge (source backup kept beside the source). */
  finalized?: { turns: number; intents: number; sourceBackupPath: string };
  /** Merged through the exclusive fallback because the source exceeded the online limits. */
  exclusive?: boolean;
}

export interface RuntimeDataSetMergeIssue {
  candidateId?: string;
  code: string;
  message: string;
  /** False when the same unchanged source state was already reported earlier. */
  newly?: boolean;
  /** The user asked for this merge; its outcome is always reported. */
  requested?: boolean;
}

export interface RuntimeDataSetMergeBatchResult {
  targetCandidateId?: string;
  merged: RuntimeDataSetMergeResult[];
  /** Retried at a later startup: source in use, or too large while other windows stay busy. */
  deferred: RuntimeDataSetMergeIssue[];
  /** Unfinished work without a terminal transition, or a conflict with the receiving data set. */
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
  changedSinceMerge: boolean;
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
};

type SourceOutcome =
  | { kind: 'merged'; result: RuntimeDataSetMergeResult }
  /** Every row is already in the target: recorded as merged, nothing new to report. */
  | { kind: 'current' }
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
  const sources = await withRuntimeDataRootAdmission(storagePaths.globalStoragePath, async () => {
    const inspection = await inspectVscodeRuntimeDataSets(storagePaths);
    const selected = inspection.candidates.filter((candidate) => candidate.selected);
    if (selected.length !== 1 || !sameRuntimeDataSetIdentity(target.identity, selected[0])) return [];
    report.targetCandidateId = selected[0].id;
    const ledger = await readRuntimeDataSetMergeLedger(storagePaths);
    const requests = await readRuntimeDataSetMergeRequests(storagePaths);
    const explicit = options.requested === true && options.candidateIds !== undefined;
    const picked: Array<{ candidate: VscodeRuntimeDataSetCandidate; requested: boolean }> = [];
    for (const candidate of inspection.candidates) {
      if (candidate.selected || !candidate.dataSetId || !candidate.rootInstanceId) continue;
      let request = requests.get(candidate.id);
      if (request && !(Date.now() - Date.parse(request.requestedAt) < RUNTIME_DATA_SET_MERGE_REQUEST_TTL_MS)) {
        await removeRuntimeDataSetMergeRequest(storagePaths, candidate.id);
        request = undefined;
      }
      if (options.candidateIds && !options.candidateIds.includes(candidate.id)) continue;
      const requested = explicit;
      // A recorded request only keeps its source pending (see RUNTIME_DATA_SET_MERGE_REQUEST_TTL_MS).
      const pending = request !== undefined && sameRuntimeDataSetIdentity(request.target, target.identity)
        && request.expectedDataSetId === candidate.dataSetId && request.expectedRootInstanceId === candidate.rootInstanceId;
      const recorded = ledger.get(candidate.id);
      const record = recorded && sameRuntimeDataSetIdentity(recorded.source, candidate) ? recorded : undefined;
      const fingerprint = record ? await runtimeDataSetFingerprint(candidate).catch(() => undefined) : undefined;
      const unchanged = record !== undefined && sameRuntimeDataSetFingerprint(record.source, fingerprint);
      if (record?.state === 'merged' && sameRuntimeDataSetIdentity(record.target, target.identity) && unchanged) {
        if (request) await removeRuntimeDataSetMergeRequest(storagePaths, candidate.id);
        continue;
      }
      if (!requested) {
        // Kept by the user, or merged once already (into any data set, also when a later explicit
        // attempt ended otherwise): only on request. An interrupted commit still converges.
        if (!pending && ((record && record.state !== 'committing' && runtimeDataSetLastMerge(record))
          || await isVscodeRuntimeDataSetKept(candidate))) continue;
        // A refusal of this unchanged source is reported again without redoing it, unless the
        // request came after that judgment.
        const known = unchanged && (record?.state === 'failed'
          || (record?.state === 'blocked' && sameRuntimeDataSetIdentity(record.target, target.identity))
          || (record?.state === 'too-large' && record.maxRows === RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS))
          && !(pending && request!.requestedAt > record.updatedAt);
        if (known && (record.state === 'failed' || record.state === 'blocked' || record.state === 'too-large')) {
          (record.state === 'failed' ? report.failures : report.blocked).push({
            candidateId: candidate.id, code: record.code, message: record.message, newly: false
          });
          continue;
        }
      }
      picked.push({ candidate, requested });
    }
    return picked;
  });
  report.pendingSources = sources.length;
  // The newest backup from before this batch is never pruned by it (other windows may add theirs).
  const earlierBackup = sources.length > 0 ? await newestTargetBackup(target).catch(() => undefined) : undefined;
  let started = false;
  for (const [index, source] of sources.entries()) {
    if (!keepGoing()) break;
    if (!started) {
      started = true;
      options.onWorkStart?.(sources.length);
    }
    await options.onSourceStart?.(source.candidate, index, sources.length);
    const outcome = await mergeOneSource(storagePaths, target, source.candidate.id, options,
      { finalizeWork: true, requested: source.requested }, keepGoing);
    if (outcome.kind === 'stopped') break;
    if (outcome.kind === 'merged' || outcome.kind === 'current') {
      if (outcome.kind === 'merged') report.merged.push(outcome.result);
      else if (source.requested) report.merged.push(unchangedResult(source.candidate, target));
      await removeRuntimeDataSetMergeRequest(storagePaths, source.candidate.id).catch(() => undefined);
      continue;
    }
    const issue = { candidateId: source.candidate.id, code: outcome.code, message: outcome.message, newly: true, requested: source.requested };
    if (outcome.kind === 'deferred') report.deferred.push(issue);
    else {
      (outcome.kind === 'blocked' ? report.blocked : report.failures).push(issue);
      await removeRuntimeDataSetMergeRequest(storagePaths, source.candidate.id).catch(() => undefined);
    }
  }
  await settleTargetBackup(target, { keep: earlierBackup }).catch(() => undefined);
  if (sources.length > 0) {
    await withRuntimeDataRootAdmission(storagePaths.globalStoragePath, () => pruneRuntimeDataSetMergeCommits(storagePaths))
      .catch(() => undefined);
  }
  return report;
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
  if (outcome.kind === 'merged' || outcome.kind === 'current') {
    return outcome.kind === 'merged' ? outcome.result : unchangedResult(candidate, target);
  }
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
  options: Pick<RuntimeDataSetMergeOptions, 'linkFile'> & { sourceDatabase?: RuntimeDatabase } = {}
): Promise<RuntimeDataSetCasTransfer> {
  const storagePaths = { globalStoragePath: path.resolve(paths.globalStoragePath) };
  const candidate = await resolveVscodeRuntimeDataSet(storagePaths, input.candidateId);
  if (candidate.dataSetId !== input.expectedDataSetId || candidate.rootInstanceId !== input.expectedRootInstanceId) {
    throw new RuntimeDataSetMergeError('runtime-data-set-merge-identity-mismatch', '来源历史库的身份已变化，本次不预复制。');
  }
  const binding = await requireCompleteRuntimeDataSet(candidate);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-merge-precopy-'));
  try {
    const snapshotPath = path.join(temporaryRoot, 'limcode.sqlite');
    if (options.sourceDatabase) {
      if (!sameRuntimeDataSetIdentity(options.sourceDatabase.binding, candidate)) {
        throw new RuntimeDataSetMergeError('runtime-data-set-merge-identity-mismatch', '传入的数据库与来源历史库不一致。');
      }
      const staged = path.join(path.dirname(binding.paths.dataRootPath), `merge-precopy-${randomUUID()}.sqlite`);
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
    const snapshot = new Database(toSqliteFilePath(snapshotPath), { readonly: true, fileMustExist: true });
    try {
      snapshot.defaultSafeIntegers(true);
      return await transferCas(candidate.configurationRootPath, binding, target.configurationRootPath, target.binding, snapshot, options);
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

/** Merge state of every non-selected data set, relative to the currently selected one. */
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
    const fingerprint = record ? await runtimeDataSetFingerprint(candidate).catch(() => undefined) : undefined;
    const unchanged = record !== undefined && sameRuntimeDataSetFingerprint(record.source, fingerprint);
    const merge = record ? runtimeDataSetLastMerge(record) : undefined;
    const lastMerged: RuntimeDataSetMergedFacts | undefined = merge && {
      mergedAt: merge.mergedAt,
      intoCurrent: sameRuntimeDataSetIdentity(merge.target, current),
      targetMissing: !inspection.candidates.some((dataSet) => sameRuntimeDataSetIdentity(merge.target, dataSet)),
      changedSinceMerge: !sameRuntimeDataSetFingerprint(merge.source, fingerprint)
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
    } else if (unchanged && record?.state === 'too-large' && record.maxRows === RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS) {
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
  const state: SourceProgress = {};
  try {
    return mode.migration
      // A migration keeps the configuration root closed throughout: no Host registers meanwhile.
      ? await withRuntimeDataRootAdmission(paths.globalStoragePath,
        () => mergeSource(paths, target, candidateId, options, mode, state, keepGoing))
      : await mergeSource(paths, target, candidateId, options, mode, state, keepGoing);
  } catch (error) {
    const outcome = sourceOutcome(error, state);
    if ((outcome.kind === 'failed' || outcome.kind === 'blocked') && !state.recorded && !mode.migration) {
      await recordRefusal(paths, target, candidateId, outcome, state).catch(() => undefined);
    }
    return outcome;
  }
}

interface SourceMode {
  /** Close finalizable unfinished work first (every historical merge; never a migration). */
  finalizeWork: boolean;
  requested: boolean;
  /** Data-root migration: the selected source is allowed and the ledger is not written. */
  migration?: boolean;
}

interface SourceProgress {
  /**
   * The judged source: its exact SQLite file state when the checked copy was taken, and the
   * fingerprint (content digest) of that copy. A migration writes no ledger record and computes none.
   */
  files?: string;
  fingerprint?: RuntimeDataSetFingerprint;
  upgradedFromEpoch?: 3 | 4;
  /** Unfinished work was (being) closed in the source; `complete` once every transition succeeded. */
  finalized?: { turns: number; intents: number; sourceBackupPath: string; complete: boolean };
  /** The outcome was already written to the ledger where it was found. */
  recorded?: boolean;
}

function sourceOutcome(error: unknown, state: SourceProgress): Refusal | { kind: 'stopped' } {
  if (error instanceof StopRequested) return { kind: 'stopped' };
  // Only the source's own deterministic problems are failures (thrown as Outcome where found:
  // structure, fingerprint, integrity, rows, content digests). Anything else — a closed target, a
  // window going away, I/O — is retried at a later startup.
  const outcome: Refusal = error instanceof Outcome
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
  return finalized.complete
    ? `（合并前已把这个库里的${work}按“中止”收尾，不会再被继续执行；收尾前的备份在 ${finalized.sourceBackupPath}。）`
    : `（收尾这个库里的${work}时出错，其中一部分可能已按“中止”收尾；收尾前的备份在 ${finalized.sourceBackupPath}。）`;
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
    const settled = await settledSource(paths, target, candidateId, state);
    if (settled) return settled;
  }
  const { candidate, binding } = await resolveSource(paths, target, candidateId, mode, state);
  const unfinishedWork = mode.finalizeWork ? 'finalize' as const : 'carry' as const;
  let taken = await takeVerifiedSnapshot(candidate, binding, unfinishedWork, state, mode);
  try {
    const rows = taken.audit.size!.rows;
    if (!mode.migration && rows > RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS) {
      // Before any plan, coordination, backup or finalization: this version cannot merge it safely.
      throw new Outcome({
        kind: 'blocked', code: 'runtime-data-set-merge-too-large-for-one-transaction',
        tooLarge: { rows, maxRows: RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS },
        message: `这份旧聊天记录约有 ${rows} 条记录，超过当前版本一次合并能安全处理的上限（${RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS} 条），暂不合并，也不会自动重试；这个库的对话内容没有改动。`
          + '可以在“历史与存储管理”里切换到这个库查看或继续使用。'
      });
    }
    let work: UnfinishedWorkInspection | undefined;
    if (!mode.finalizeWork) assertCarriable(taken.audit.carriedWork!);
    else {
      work = taken.audit.unfinishedWork!;
      if (work.refused.length > 0) throw new Outcome(unfinishedWorkOutcome(describeUnfinishedWork(work.refused)));
    }
    const limits = options.limits ?? RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS;
    stopIfAsked();
    let plan = await planRows(taken.snapshot.database, target.database);
    let size = checkPlan(plan, taken.audit.size!, limits, options, state);
    const verified: CasVerification = new Map();
    if (work && hasFinalizableWork(work)) {
      // Everything that can refuse the source was checked on the unfinalized snapshot (unfinished
      // work, conflicts, size); the CAS objects are verified too. Only then is the source backed up
      // and its work closed, and the finalized source is checked again from a new snapshot.
      await transferSourceCas(candidate, binding, target, taken.snapshot.database, options, verified, true);
      stopIfAsked();
      await finalizeSource(paths, candidate, binding, work, state, options, stopIfAsked);
      await taken.snapshot.close();
      taken = await takeVerifiedSnapshot(candidate, binding, unfinishedWork, state, mode);
      const remaining = taken.audit.unfinishedWork!;
      if (remaining.refused.length > 0 || hasFinalizableWork(remaining)) {
        throw new Outcome(unfinishedWorkOutcome(describeUnfinishedWork(remaining.refused) || '收尾后仍有未结束的任务', true));
      }
      stopIfAsked();
      plan = await planRows(taken.snapshot.database, target.database);
      size = checkPlan(plan, taken.audit.size!, limits, options, state);
    }
    if (plan.steps.length === 0) {
      // Nothing new (e.g. a source whose files changed but whose rows all exist here already):
      // recorded as merged, without a target backup and without a report.
      return await commitSource(paths, target, candidate, binding, plan, undefined, state, options, mode, stopIfAsked);
    }
    await ensureTargetBackup(target);
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
      ? { kind: 'current' } : undefined;
  }
  if (recorded?.state !== 'committing' || !sameRuntimeDataSetIdentity(recorded.target, target.identity)) return undefined;
  return withRuntimeDataRootAdmission(paths.globalStoragePath, async (): Promise<SourceOutcome | undefined> => {
    const candidate = await resolveVscodeRuntimeDataSet(paths, candidateId);
    const record = (await readRuntimeDataSetMergeLedger(paths)).get(candidateId);
    if (record?.state !== 'committing' || !sameRuntimeDataSetIdentity(record.target, target.identity)
      || !sameRuntimeDataSetIdentity(record.source, candidate)) return undefined;
    const presence = await commitPresence(paths, record.commitId, target.database);
    if (presence === 'none') {
      // Nothing of it was committed: the source is merged again from scratch.
      await removeRuntimeDataSetMergeLedgerRecord(paths, candidateId);
      await removeRuntimeDataSetMergeCommit(paths, record.commitId).catch(() => undefined);
      return undefined;
    }
    state.fingerprint = record.source;
    if (presence === 'partial') {
      const outcome: Refusal = { kind: 'blocked', code: 'runtime-data-set-merge-conflict', message: '上次合并在提交时中断，之后当前库里这批对话已有增删，无法确认合并状态；请在历史与存储管理中手动合并。' };
      await writeRuntimeDataSetMergeLedgerRecord(paths, {
        candidateId, state: 'blocked', source: record.source, target: target.identity, code: outcome.code, message: outcome.message
      });
      state.recorded = true;
      throw new Outcome(outcome);
    }
    // Recorded for the source state that was committed; later changes show as changed since merge.
    await writeRuntimeDataSetMergeLedgerRecord(paths, {
      candidateId, state: 'merged', source: record.source, target: target.identity,
      mergedAt: new Date().toISOString(), insertedRows: 0, reusedRows: 0, insertedConversations: 0
    });
    await removeRuntimeDataSetMergeCommit(paths, record.commitId).catch(() => undefined);
    return { kind: 'merged', result: { ...unchangedResult(candidate, target), recoveredCommit: true } };
  });
}

/** Identity, idle state, recovery, epoch (a published 3/4 source is upgraded in place first). */
async function resolveSource(
  paths: { globalStoragePath: string },
  target: TargetContext,
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
  if (plan.conflicts.count > 0) {
    throw new Outcome({
      kind: 'blocked',
      code: 'runtime-data-set-merge-conflict',
      message: `这份旧聊天记录与当前历史库有 ${plan.conflicts.count} 处同一条记录但内容不同（例如合并之后又在其中一边改动了同一对话），整体未合并，`
        + `${state.finalized ? '当前库没有改动' : '两边内容都没有改动'}。如需保留两边的改动，可以先切换到这个库查看，再决定删除哪一份。`
        + `\n${plan.conflicts.samples.join('\n')}`
    });
  }
  const oversized = plan.steps.length > 0 && (size.rows > limits.maxRows || size.bytes > limits.maxBytes);
  if (oversized && !options.coordinateOversized) {
    throw new Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-too-large', message: `这份旧聊天记录较大（约 ${size.rows} 行），需要其它窗口暂时让出后才能合并，稍后重试。` });
  }
  return { rows: size.rows, oversized };
}

/** Backs up the source and closes its finalizable work, under its maintenance claim. */
async function finalizeSource(
  paths: { globalStoragePath: string },
  candidate: VscodeRuntimeDataSetCandidate,
  binding: HistoricalRootBinding,
  work: UnfinishedWorkInspection,
  state: SourceProgress,
  options: RuntimeDataSetMergeOptions,
  stopIfAsked: () => void
): Promise<void> {
  await withRuntimeDataRootAdmission(paths.globalStoragePath, () => withRuntimeMaintenance(binding.paths, async () => {
    await assertSourceUnchanged(paths, candidate, binding, state, false);
    stopIfAsked();
    const sourceBackupPath = await backupSource(binding);
    await fault(options, 'after-source-backup');
    state.finalized = { turns: work.turns.length, intents: work.intents.length, sourceBackupPath, complete: false };
    await finalizeUnfinishedWork(createVscodeRootAuthority(candidate), work);
    state.finalized.complete = true;
  }));
}

/** Under the source's claim: no Host, same identity and pointer, and exactly the files that were checked. */
async function assertSourceUnchanged(
  paths: { globalStoragePath: string },
  candidate: VscodeRuntimeDataSetCandidate,
  binding: HistoricalRootBinding,
  state: SourceProgress,
  migration: boolean
): Promise<void> {
  await assertSourceIdle(candidate);
  const current = await resolveVscodeRuntimeDataSet(paths, candidate.id);
  const pointer = await requireCompleteRuntimeDataSet(current).catch(() => undefined);
  if (!sameRuntimeDataSetIdentity(current as RuntimeDataSetIdentity, candidate) || (current.selected && !migration)
    || pointer?.rootGeneration !== binding.rootGeneration || pointer.pointerRevision !== binding.pointerRevision
    || await runtimeDataSetFileState(binding.paths.databasePath) !== state.files) {
    throw new Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-source-changed', message: '来源历史库在核验之后又有变化，稍后重试。' });
  }
}

/**
 * The final step, under configuration admission and the source's maintenance claim: the source is
 * checked again (no Host, the exact files that were verified), the ledger is read again (another
 * window may have merged it meanwhile), then the committing record and ONE row transaction.
 */
async function commitSource(
  paths: { globalStoragePath: string },
  target: TargetContext,
  candidate: VscodeRuntimeDataSetCandidate,
  binding: HistoricalRootBinding,
  plan: RowPlan,
  cas: RuntimeDataSetCasTransfer | undefined,
  state: SourceProgress,
  options: RuntimeDataSetMergeOptions,
  mode: SourceMode,
  stopIfAsked: () => void
): Promise<SourceOutcome> {
  return withRuntimeDataRootAdmission(paths.globalStoragePath, () => withRuntimeMaintenance(binding.paths, async (): Promise<SourceOutcome> => {
    await assertSourceUnchanged(paths, candidate, binding, state, mode.migration === true);
    const previous = mode.migration ? undefined : (await readRuntimeDataSetMergeLedger(paths)).get(candidate.id);
    if ((previous?.state === 'committing' || previous?.state === 'merged') && sameRuntimeDataSetIdentity(previous.target, target.identity)) {
      if (previous.state === 'committing') {
        throw new Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-commit-pending', message: '另一个窗口合并这个库时中断，下次启动时先确认它的结果。' });
      }
      if (previous.state === 'merged' && sameRuntimeDataSetIdentity(previous.source, candidate)
        && sameRuntimeDataSetFingerprint(previous.source, state.fingerprint)) {
        return { kind: 'current' };
      }
    }
    stopIfAsked();
    const result: RuntimeDataSetMergeResult = {
      ...unchangedResult(candidate, target),
      insertedRows: plan.inserted.length,
      reusedRows: plan.reused,
      insertedConversations: plan.insertedConversations,
      ...(cas ?? {}),
      ...(plan.steps.length > 0 && target.backup.path ? { backupPath: target.backup.path } : {}),
      ...(state.upgradedFromEpoch !== undefined ? { upgradedFromEpoch: state.upgradedFromEpoch } : {}),
      ...(state.finalized ? { finalized: {
        turns: state.finalized.turns, intents: state.finalized.intents, sourceBackupPath: state.finalized.sourceBackupPath
      } } : {})
    };
    const merged = (): DistributiveOmit<RuntimeDataSetMergeLedgerRecord, 'kind' | 'updatedAt'> => ({
      candidateId: candidate.id, state: 'merged', source: state.fingerprint!, target: target.identity,
      mergedAt: new Date().toISOString(), insertedRows: plan.inserted.length, reusedRows: plan.reused,
      insertedConversations: plan.insertedConversations
    });
    if (plan.steps.length === 0) {
      if (mode.migration) return { kind: 'merged', result };
      await writeRuntimeDataSetMergeLedgerRecord(paths, merged());
      return { kind: 'current' };
    }
    const commitId = mode.migration ? undefined : await writeRuntimeDataSetMergeCommit(paths, plan.inserted);
    if (commitId !== undefined) {
      await writeRuntimeDataSetMergeLedgerRecord(paths, {
        candidateId: candidate.id, state: 'committing', source: state.fingerprint!, target: target.identity, commitId
      });
    }
    const backupUsed = target.backup.used === true;
    target.backup.used = true;
    await fault(options, 'before-row-commit');
    try {
      await target.database.transaction(plan.steps);
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
    if (commitId !== undefined) {
      await writeRuntimeDataSetMergeLedgerRecord(paths, merged());
      await removeRuntimeDataSetMergeCommit(paths, commitId).catch(() => undefined);
    }
    return { kind: 'merged', result };
  }));
}

/**
 * Oversized source: only now, with everything prepared and checked, the other windows of the
 * target are asked to go offline (waiting without any claim); the locks the coordination takes
 * once they are offline wrap the final commit alone.
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
  const exclusive = await coordinate({
    targetPaths: target.binding.paths,
    requesterHostBootId: target.database.hostBootId,
    candidateId,
    operationKey: `${candidateId}@${fingerprintDigest(state.fingerprint!)}`,
    requested: mode.requested,
    withLocks: (body) => withRuntimeDataRootAdmission(paths.globalStoragePath,
      () => withRuntimeMaintenance(target.binding.paths, body)),
    isDeterministicFailure: (error) => error instanceof Outcome && error.outcome.kind !== 'deferred'
  }, async () => { done.outcome = await commit(); });
  if (exclusive.state !== 'completed' || !done.outcome) {
    const reason = 'reason' in exclusive && exclusive.reason ? exclusive.reason : '其它窗口暂时无法让出';
    throw new Outcome({ kind: 'deferred', code: `runtime-data-set-merge-exclusive-${exclusive.state}`,
      message: `这份旧聊天记录较大（约 ${rows} 行），需要其它窗口暂时让出才能合并：${reason}。以后会自动重试。` });
  }
  return done.outcome.kind === 'merged' ? { kind: 'merged', result: { ...done.outcome.result, exclusive: true } } : done.outcome;
}

function unchangedResult(candidate: VscodeRuntimeDataSetCandidate, target: TargetContext): RuntimeDataSetMergeResult {
  return {
    candidateId: candidate.id, sourceDataSetId: candidate.dataSetId!, targetDataSetId: target.identity.dataSetId,
    insertedRows: 0, reusedRows: 0, insertedConversations: 0,
    linkedCasObjects: 0, copiedCasObjects: 0, reusedCasObjects: 0, recoveredCommit: false
  };
}

function unfinishedWorkOutcome(found: string, afterFinalization = false): Refusal {
  return {
    kind: 'blocked',
    code: 'runtime-data-set-merge-unfinished-work',
    message: (afterFinalization
      ? `收尾之后这份旧聊天记录里仍有无法自动收尾的工作（${found}），为避免在当前库里被自动继续执行，暂不合并。`
      : `这份旧聊天记录里还有无法自动收尾的工作（${found}），为避免在当前库里被自动继续执行，暂不合并；这个库的对话内容没有改动。`)
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
  mode: SourceMode
): Promise<VerifiedSnapshot> {
  for (let attempt = 1; ; attempt += 1) {
    const files = await runtimeDataSetFileState(binding.paths.databasePath);
    let audit: RuntimeSnapshotAudit | undefined;
    try {
      const snapshot = await createRuntimeDataSetDatabaseSnapshot(candidate, binding, {
        beforeOpen: async (snapshotPath) => {
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

type CasVerification = Map<string, string>;

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
 */
async function planRows(source: Database.Database, target: RuntimeDatabase): Promise<RowPlan> {
  const plan: RowPlan = { steps: [], inserted: [], reused: 0, insertedConversations: 0, conflicts: { count: 0, samples: [] } };
  const presence: RepositoryTransactionStep[] = [];
  for (const schema of MERGE_DOMAIN_ORDER) {
    const repository = DOMAIN_REPOSITORIES.domain(schema.key);
    const allowed = IDENTITY_MERGE_DIFFERENCES.get(schema.key);
    const renumbered = RENUMBERED_COLUMNS.get(schema.key);
    const offset = renumbered ? await maximumValue(target, schema.key, renumbered) : 0n;
    const historical = HISTORICAL_COPY_DOMAINS.includes(schema.key);
    // A request that has not started yet is inserted exactly as the Runtime itself creates it
    // (prepared request, pending Operation and Attempt); started or finished ones are historical copies.
    const notStarted = (row: DomainRow): boolean => schema.key === 'ModelRequest' ? row.status === 'prepared'
      : schema.key === 'Operation' ? row.owner_kind === 'model_request' && row.status === 'pending'
        : schema.key === 'Attempt' && row.status === 'pending';
    const statement = source.prepare(`SELECT * FROM "${schema.table}" ORDER BY rowid`);
    let chunk: DomainRow[] = [];
    const flush = async (): Promise<void> => {
      if (chunk.length === 0) return;
      const existing = (await target.snapshot(chunk.map((row) => repository.get(String(row.id))))).snapshot as Array<DomainRow | null>;
      for (const [index, row] of chunk.entries()) {
        const id = String(row.id);
        const current = existing[index];
        presence.push(repository.assert(id, {}));
        if (current) {
          const differences = schema.columns.map((column) => column.name)
            .filter((column) => column !== renumbered && !isDeepStrictEqual(row[column], current[column]));
          if (differences.length === 0 || (allowed && differences.every((column) => allowed.has(column)))) {
            plan.reused += 1;
          } else {
            plan.conflicts.count += 1;
            if (plan.conflicts.samples.length < MAX_REPORTED_CONFLICTS) {
              plan.conflicts.samples.push(`${schema.key}#${id} 字段不同：${differences.join(',')}`);
            }
          }
          continue;
        }
        const inserted = renumbered ? { ...row, [renumbered]: (row[renumbered] as bigint) + offset } : row;
        const insert = sourceRow(schema.key, id, () => historical && !notStarted(row)
          ? repository.insertHistoricalCopy(inserted) : repository.insert(inserted));
        if (allowed) {
          // Another window may create the same content-derived identity before this commit: inside
          // the transaction it is inserted only when still absent, else compared like above.
          plan.steps.push(savepoint(`merge_identity_${plan.steps.length}`, [insert], {
            kind: 'rollback-and-continue-on-unique',
            constraints: uniqueIdentities(schema).map((columns) => ({ domain: schema.key, columns }))
          }), repository.assert(id, Object.fromEntries(schema.columns
            .filter((column) => column.name !== 'id' && !allowed.has(column.name))
            .map((column) => [column.name, inserted[column.name]]))));
        } else {
          plan.steps.push(insert);
        }
        plan.inserted.push([schema.key, id]);
        if (schema.key === 'Conversation') plan.insertedConversations += 1;
      }
      chunk = [];
      // Decoding stays on the extension thread; yield so a large source never monopolizes it.
      await new Promise((resolve) => setImmediate(resolve));
    };
    for (const raw of statement.iterate() as IterableIterator<Record<string, unknown>>) {
      chunk.push(sourceRow(schema.key, String(raw.id), () => repository.codec.decode(raw)));
      if (chunk.length >= READ_CHUNK) await flush();
    }
    await flush();
  }
  // A loop, not push(...presence): an argument list of every source row overflows the call stack.
  if (plan.steps.length > 0) for (const step of presence) plan.steps.push(step);
  return plan;
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

async function maximumValue(database: RuntimeDatabase, domain: string, column: string): Promise<bigint> {
  const rows = (await database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({
    orderBy: { column, direction: 'desc' }, limit: 1
  })])).snapshot[0] as DomainRow[];
  const value = rows[0]?.[column];
  return typeof value === 'bigint' ? value : 0n;
}

/** Exact inserted id set of an interrupted commit: all present, none present, or changed since. */
async function commitPresence(
  paths: { globalStoragePath: string },
  commitId: string,
  database: RuntimeDatabase
): Promise<'all' | 'none' | 'partial'> {
  const commit = await readRuntimeDataSetMergeCommit(paths, commitId);
  return commit ? insertedRowsPresence(commit.rows, database) : 'none';
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

/** Puts back the record a committing record replaced (none: the source had no record). */
async function restoreLedgerRecord(
  paths: { globalStoragePath: string },
  candidateId: string,
  previous: RuntimeDataSetMergeLedgerRecord | undefined
): Promise<void> {
  if (previous) await writeRuntimeDataSetMergeLedgerRecord(paths, previous);
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
    /** Files already verified in this merge, by file identity; unchanged ones are not hashed again. */
    verified?: CasVerification;
  } = {}
): Promise<RuntimeDataSetCasTransfer> {
  const result = { linkedCasObjects: 0, copiedCasObjects: 0, reusedCasObjects: 0 };
  const verified = options.verified ?? new Map<string, string>();
  const sourceCas = path.resolve(sourceBinding.paths.casRootPath);
  const targetCas = path.resolve(targetBinding.paths.casRootPath);
  await assertNoSymbolicPath(sourceConfigurationRootPath, sourceCas);
  await assertNoSymbolicPath(targetConfigurationRootPath, targetCas);
  const rows = source.prepare(`
    SELECT storage_key, sha256, MAX(byte_length) AS byte_length, MIN(byte_length) AS min_length
      FROM content_object GROUP BY storage_key, sha256
  `).all() as Array<{ storage_key: string; sha256: string; byte_length: bigint; min_length: bigint }>;
  const seen = new Set<string>();
  const touchedDirectories = new Set<string>();
  const link = options.linkFile ?? ((from: string, to: string) => fs.link(from, to));
  for (const row of rows) {
    if (row.byte_length !== row.min_length || storageKeyForDigest(row.sha256) !== row.storage_key || seen.has(row.storage_key)) {
      throw new Outcome({ kind: 'failed', code: 'runtime-data-set-merge-source-cas-invalid', message: `来源的正文登记不一致：${row.storage_key}。` });
    }
    seen.add(row.storage_key);
    const sourceFile = casPath(sourceCas, row.storage_key);
    const targetFile = casPath(targetCas, row.storage_key);
    const existing = await regularFileSize(targetFile).catch((error: unknown) => {
      if (error instanceof NotRegularFile) {
        throw new Outcome({ kind: 'blocked', code: 'runtime-data-set-merge-target-cas-damaged', message: `当前历史库里的正文位置不是普通文件：${row.storage_key}。为免覆盖，暂不合并。` });
      }
      throw error;
    });
    if (existing !== undefined) {
      // CAS files are never rewritten: an existing object must already be exactly these bytes.
      if (existing !== row.byte_length || !await hasDigest(targetFile, row.sha256, verified)) {
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
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        if (await regularFileSize(targetFile) !== row.byte_length || await sha256File(targetFile) !== row.sha256) throw error;
      } else if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EMLINK') {
        await copyIntoCas(targetCas, sourceFile, targetFile, row.sha256);
        copied = true;
      } else {
        throw error;
      }
    }
    touchedDirectories.add(prefix);
    if (copied) result.copiedCasObjects += 1;
    else result.linkedCasObjects += 1;
  }
  for (const directory of touchedDirectories) await syncDirectoryDurably(directory);
  return result;
}

/** Copy, fsync and verify a private temporary file; only verified bytes are linked into the CAS. */
async function copyIntoCas(targetCas: string, sourceFile: string, targetFile: string, digest: string): Promise<void> {
  const temporaryRoot = path.join(targetCas, 'tmp');
  await fs.mkdir(temporaryRoot, { recursive: true });
  const temporary = path.join(temporaryRoot, `${process.pid}-${randomUUID()}.merge.tmp`);
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await sha256File(targetFile) !== digest) throw error;
    }
  } finally {
    await fs.rm(temporary, { force: true });
    await syncDirectoryDurably(temporaryRoot);
  }
}

/** Online Backup API copy of the target, once per batch; failures leave no partial files behind. */
async function ensureTargetBackup(target: TargetContext): Promise<string> {
  if (target.backup.path) return target.backup.path;
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
async function backupSource(binding: HistoricalRootBinding): Promise<string> {
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

/** sha256 of a file; one verified in this merge and unchanged since (same inode, size, times) is not read again. */
async function hasDigest(file: string, digest: string, verified: CasVerification): Promise<boolean> {
  const info = await fs.lstat(file, { bigint: true });
  const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  if (verified.get(file) === identity) return true;
  if (await sha256File(file) !== digest) return false;
  verified.set(file, identity);
  return true;
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

const BACKUP_NAME = /^(\d{8}T\d{9}Z)-(\d{6,})-[0-9a-f]{8}$/;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export { MERGE_FINALIZATION_REASON };
