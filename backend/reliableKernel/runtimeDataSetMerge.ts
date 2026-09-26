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
import { assertCurrentSchema, auditDatabaseIntegrity } from './databaseSchema';
import { DOMAIN_REPOSITORIES, HISTORICAL_COPY_DOMAINS, type DomainRow, type RepositoryTransactionStep } from './repositories';
import type { HistoricalRootBinding } from './rootAuthority';
import type { RuntimeDatabase } from './runtimeDatabase';
import {
  describeUnfinishedWork, finalizeUnfinishedWork, hasFinalizableWork, inspectUnfinishedWork, MERGE_FINALIZATION_REASON
} from './runtimeDataSetMergeWork';
import {
  pruneRuntimeDataSetMergeCommits, readRuntimeDataSetMergeCommit, readRuntimeDataSetMergeLedger,
  readRuntimeDataSetMergeRequests, removeRuntimeDataSetMergeCommit, removeRuntimeDataSetMergeRequest, runtimeDataSetFingerprint,
  sameRuntimeDataSetFingerprint, sameRuntimeDataSetIdentity, writeRuntimeDataSetMergeCommit,
  writeRuntimeDataSetMergeLedgerRecord, writeRuntimeDataSetMergeRequest,
  type RuntimeDataSetFingerprint, type RuntimeDataSetIdentity, type RuntimeDataSetMergeLedgerRecord
} from './runtimeDataSetMergeLedger';
import { upgradeRuntimeDataSet } from './runtimeDataSetUpgrade';
import {
  assertRuntimeHostsOffline, isRuntimeHostsActiveError, withRuntimeDataRootAdmission, withRuntimeMaintenance
} from './runtimeHostControl';
import { assertRuntimePhysicalSchemaFingerprint } from './runtimePhysicalSchemaFingerprint';
import {
  assertNoSymbolicPath, createRuntimeDataSetDatabaseSnapshot, requireCompleteRuntimeDataSet,
  type RuntimeDataSetDatabaseSnapshot
} from './runtimeStorageInspection';
import { RUNTIME_DOMAIN_SCHEMAS } from './schema/domainManifest';
import { toSqliteFilePath } from './sqliteFilePath';
import {
  createVscodeRootAuthority, inspectVscodeRuntimeDataSets, isVscodeRuntimeDataSetKept, legacyWorkspaceRuntimeOwnerState,
  resolveVscodeRuntimeDataSet, type VscodeRuntimeDataSetCandidate
} from './vscodeRootAuthority';

/**
 * Historical data-set merge, online. The selected Runtime is already open; a source (another data
 * set of this configuration root) must be offline. Per source, inside configuration admission and
 * the source's maintenance claim: exact published 3/4 upgrade, unfinished-work finalization (after
 * a source backup), integrity checks, verified CAS pre-copy, then ONE ordinary RuntimeDatabase
 * write transaction of Repository insert steps (codec-validated, worker insert invariants apply,
 * other Hosts keep running and see it as an external commit). Sources above the online size limit
 * need the exclusive fallback. The ledger records every outcome by exact source file state.
 */

/** One verified online Backup API copy of the target per batch that changes it (target control root). */
export const RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY = 'merge-backups';
/** Backup of a source taken before its unfinished work is finalized (source control root). */
export const RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY = 'merge-source-backups';
/** Target backups kept per control root; older ones are removed after a successful batch. */
export const RUNTIME_DATA_SET_MERGE_BACKUP_RETENTION = 3;
/**
 * Online transaction bound: the merge transaction blocks other Hosts' writes (busy_timeout 5 s).
 * Measured on this machine (see the merge report): ~6,000 rows commit in about one second.
 */
export const RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS = Object.freeze({ maxRows: 6_000, maxBytes: 16 * 1024 * 1024 });

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
}

export interface RuntimeDataSetMergeBatchOptions extends RuntimeDataSetMergeOptions {
  /** Stop before the next source when activation ends or its configuration root changes. */
  shouldContinue?(): boolean;
  /** Called once, only when at least one source actually needs work. */
  onWorkStart?(total: number): void;
  onSourceStart?(candidate: VscodeRuntimeDataSetCandidate, index: number, total: number): void;
  /** Restricts the batch, e.g. to a source the user just asked to merge. */
  candidateIds?: readonly string[];
  /**
   * Exclusive fallback for one source above the online limits, called only after the source was
   * prepared and checked and is known to merge now, inside configuration admission and the
   * target's maintenance claim: ask the other windows of the target to go offline (the two-phase
   * exclusive maintenance primitive), then run `merge` (the same transaction, now uncontended).
   */
  coordinateOversized?(input: RuntimeDataSetOversizedMerge, merge: () => Promise<void>): Promise<RuntimeDataSetExclusiveOutcome>;
}

export interface RuntimeDataSetIntoDatabaseOptions extends RuntimeDataSetMergeOptions {
  /**
   * Only for moving a whole data set into a fresh root that then becomes the selected root
   * (data-root migration): unfinished work is carried unchanged and recovered there as after a
   * crash. Historical merges never set this.
   */
  allowUnfinishedWork?: boolean;
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

export type RuntimeDataSetMergeState =
  | { state: 'merged'; mergedAt: string; intoCurrent: boolean; changedSinceMerge: boolean }
  | { state: 'blocked' | 'failed'; code: string; message: string }
  | { state: 'requested'; requestedAt: string }
  | { state: 'kept' };

export class RuntimeDataSetMergeError extends Error {
  public constructor(public readonly code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'RuntimeDataSetMergeError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

type SourceOutcome =
  | { kind: 'merged'; result: RuntimeDataSetMergeResult }
  | { kind: 'deferred' | 'blocked' | 'failed'; code: string; message: string };

interface TargetContext {
  configurationRootPath: string;
  database: RuntimeDatabase;
  binding: RootBinding;
  identity: RuntimeDataSetIdentity;
  controlRoot: string;
  backup: { path?: string };
}

class Outcome extends Error {
  public constructor(public readonly outcome: Exclude<SourceOutcome, { kind: 'merged' }>) {
    super(outcome.message);
  }
}

/**
 * Merges pending historical data sets of this configuration root into the open selected Runtime.
 * From before this version: every other data set (workspace scopes and the fixed root) is merged
 * once. Data sets the user switched away from in this version, and sources already merged once,
 * merge only on explicit request. Never throws for a single source; each outcome is recorded.
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
    const picked: Array<{ candidate: VscodeRuntimeDataSetCandidate; requested: boolean; record?: RuntimeDataSetMergeLedgerRecord }> = [];
    for (const candidate of inspection.candidates) {
      if (candidate.selected || !candidate.dataSetId || !candidate.rootInstanceId) continue;
      if (options.candidateIds && !options.candidateIds.includes(candidate.id)) continue;
      const request = requests.get(candidate.id);
      const requested = request !== undefined && sameRuntimeDataSetIdentity(request.target, target.identity)
        && request.expectedDataSetId === candidate.dataSetId && request.expectedRootInstanceId === candidate.rootInstanceId;
      const recorded = ledger.get(candidate.id);
      const record = recorded && sameRuntimeDataSetIdentity(recorded.source, candidate) ? recorded : undefined;
      const fingerprint = record ? await runtimeDataSetFingerprint(candidate).catch(() => undefined) : undefined;
      const unchanged = record !== undefined && sameRuntimeDataSetFingerprint(record.source, fingerprint);
      if (record?.state === 'merged' && sameRuntimeDataSetIdentity(record.target, target.identity) && unchanged) {
        if (requested) await removeRuntimeDataSetMergeRequest(storagePaths, candidate.id);
        continue;
      }
      if (!requested) {
        // Kept by the user, or merged once already (into any data set): explicit request only.
        if (record?.state === 'merged' || await isVscodeRuntimeDataSetKept(candidate)) continue;
        const known = unchanged && (record?.state === 'failed'
          || (record?.state === 'blocked' && sameRuntimeDataSetIdentity(record.target, target.identity)));
        if (known && (record.state === 'failed' || record.state === 'blocked')) {
          (record.state === 'failed' ? report.failures : report.blocked).push({
            candidateId: candidate.id, code: record.code, message: record.message, newly: false
          });
          continue;
        }
      }
      picked.push({ candidate, requested, ...(record ? { record } : {}) });
    }
    return picked;
  });
  report.pendingSources = sources.length;
  let started = false;
  for (const [index, source] of sources.entries()) {
    if (!keepGoing()) break;
    if (!started) {
      started = true;
      options.onWorkStart?.(sources.length);
    }
    options.onSourceStart?.(source.candidate, index, sources.length);
    const outcome = await mergeOneSource(storagePaths, target, source.candidate.id, source.record, options,
      { finalizeWork: true, requested: source.requested })
      .catch((error: unknown): SourceOutcome => ({ kind: 'deferred', code: errorCode(error), message: errorMessage(error) }));
    if (outcome.kind === 'merged') {
      report.merged.push(outcome.result);
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
  if (report.merged.some((result) => result.backupPath)) await pruneTargetBackups(target).catch(() => undefined);
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
  const ledger = await readRuntimeDataSetMergeLedger(storagePaths);
  // A fresh migration target has no other Host, so the online transaction bound does not apply.
  const outcome = await mergeOneSource(storagePaths, target, candidate.id, ledger.get(candidate.id),
    { limits: { maxRows: Infinity, maxBytes: Infinity }, ...options },
    { finalizeWork: !options.allowUnfinishedWork, requested: true });
  if (outcome.kind === 'merged') return outcome.result;
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
    const request = requests.get(candidate.id);
    if (request && current && sameRuntimeDataSetIdentity(request.target, current)
      && request.expectedDataSetId === candidate.dataSetId && request.expectedRootInstanceId === candidate.rootInstanceId) {
      result.set(candidate.id, { state: 'requested', requestedAt: request.requestedAt });
      continue;
    }
    const record = ledger.get(candidate.id);
    const applies = record !== undefined && sameRuntimeDataSetIdentity(record.source, candidate);
    const fingerprint = applies ? await runtimeDataSetFingerprint(candidate).catch(() => undefined) : undefined;
    const unchanged = applies && sameRuntimeDataSetFingerprint(record.source, fingerprint);
    if (applies && record.state === 'merged') {
      result.set(candidate.id, {
        state: 'merged', mergedAt: record.mergedAt,
        intoCurrent: sameRuntimeDataSetIdentity(record.target, current), changedSinceMerge: !unchanged
      });
    } else if (applies && unchanged && (record.state === 'failed'
      || (record.state === 'blocked' && sameRuntimeDataSetIdentity(record.target, current)))) {
      result.set(candidate.id, { state: record.state, code: record.code, message: record.message });
    } else if (await isVscodeRuntimeDataSetKept(candidate).catch(() => false)) {
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
  previousRecord: RuntimeDataSetMergeLedgerRecord | undefined,
  options: RuntimeDataSetMergeBatchOptions & RuntimeDataSetIntoDatabaseOptions,
  mode: SourceMode
): Promise<SourceOutcome> {
  const state: SourceProgress = {};
  try {
    return await withRuntimeDataRootAdmission(paths.globalStoragePath, async () => {
      try {
        return await mergeAdmittedSource(paths, target, candidateId, previousRecord, options, mode, state);
      } catch (error) {
        const outcome = sourceOutcome(error, state);
        if (outcome.kind !== 'deferred' && state.fingerprint) {
          // Judged against the source files as they are now, still inside admission: a failed
          // upgrade attempt may itself have touched them, and an unchanged source is not retried.
          const current = await resolveVscodeRuntimeDataSet(paths, candidateId)
            .then((candidate) => runtimeDataSetFingerprint(candidate)).catch(() => state.fingerprint!);
          await writeRuntimeDataSetMergeLedgerRecord(paths, outcome.kind === 'failed'
            ? { candidateId, state: 'failed', source: current, code: outcome.code, message: outcome.message }
            : { candidateId, state: 'blocked', source: current, target: target.identity, code: outcome.code, message: outcome.message }
          ).catch(() => undefined);
        }
        return outcome;
      }
    });
  } catch (error) {
    return sourceOutcome(error, state);
  }
}

interface SourceMode {
  /** Close finalizable unfinished work first (every historical merge; never a migration). */
  finalizeWork: boolean;
  requested: boolean;
}

interface SourceProgress {
  fingerprint?: RuntimeDataSetFingerprint;
  upgradedFromEpoch?: 3 | 4;
}

function sourceOutcome(error: unknown, state: SourceProgress): Exclude<SourceOutcome, { kind: 'merged' }> {
  const outcome = error instanceof Outcome
    ? { ...error.outcome }
    : isRuntimeHostsActiveError(error)
      ? { kind: 'deferred' as const, code: 'runtime-hosts-active', message: '这个历史库正被其它窗口使用，关闭那个窗口后会自动合并。' }
      : { kind: 'failed' as const, code: errorCode(error), message: `合并前核验未通过：${errorMessage(error)}` };
  if (state.upgradedFromEpoch !== undefined) {
    // The published predecessor was backed up and upgraded in place before this outcome.
    outcome.message += `（这个库已按已发布的第 ${state.upgradedFromEpoch} 代格式先备份并就地升级到当前格式，对话内容未改动。）`;
  }
  return outcome;
}

async function mergeAdmittedSource(
  paths: { globalStoragePath: string },
  target: TargetContext,
  candidateId: string,
  previousRecord: RuntimeDataSetMergeLedgerRecord | undefined,
  options: RuntimeDataSetMergeBatchOptions & RuntimeDataSetIntoDatabaseOptions,
  mode: SourceMode,
  state: SourceProgress
): Promise<SourceOutcome> {
  let candidate = await resolveVscodeRuntimeDataSet(paths, candidateId);
  if (candidate.selected || !candidate.dataSetId || !candidate.rootInstanceId) {
    throw new Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-source-changed', message: '来源已成为当前库或已被清空，本次不合并。' });
  }
  if (sameRuntimeDataSetIdentity(target.identity, candidate)) {
    throw new Outcome({ kind: 'failed', code: 'runtime-data-set-merge-same-identity', message: '来源与当前历史库是同一个数据集，不能合并。' });
  }
  await assertSourceIdle(candidate);
  state.fingerprint = await runtimeDataSetFingerprint(candidate);
  if (candidate.requiresRecovery) {
    throw new Outcome({ kind: 'failed', code: 'runtime-data-set-merge-recovery-required', message: '这个历史库有一次未完成的归档或切换，需要先切换到它完成恢复，才能合并。' });
  }
  const epoch = candidate.runtimeKernelEpoch;
  if (epoch === 3 || epoch === 4) {
    const upgrade = await upgradeRuntimeDataSet(paths, {
      candidateId, expectedDataSetId: candidate.dataSetId, expectedRootInstanceId: candidate.rootInstanceId
    }).catch((error: unknown) => {
      if (isRuntimeHostsActiveError(error)) throw new Outcome({ kind: 'deferred', code: 'runtime-hosts-active', message: '这个历史库正被旧版本窗口使用，关闭那个窗口后会自动合并。' });
      throw new Outcome({ kind: 'failed', code: errorCode(error), message: `这份已发布的旧格式无法自动升级：${errorMessage(error)}` });
    });
    state.upgradedFromEpoch = upgrade.previousEpoch;
    candidate = await resolveVscodeRuntimeDataSet(paths, candidateId);
    state.fingerprint = await runtimeDataSetFingerprint(candidate);
  } else if (epoch !== RUNTIME_KERNEL_EPOCH) {
    throw new Outcome({ kind: 'failed', code: 'runtime-data-set-merge-epoch-unsupported', message: `第 ${epoch ?? '?'} 代格式的历史库不能合并。` });
  }
  const binding = await requireCompleteRuntimeDataSet(candidate);
  return withRuntimeMaintenance(binding.paths, async () => {
    await assertSourceIdle(candidate);
    const current = await resolveVscodeRuntimeDataSet(paths, candidateId);
    if (!sameRuntimeDataSetIdentity(current as RuntimeDataSetIdentity, candidate)) {
      throw new Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-source-changed', message: '来源历史库在合并前发生了变化，稍后重试。' });
    }
    if (previousRecord?.state === 'committing' && sameRuntimeDataSetIdentity(previousRecord.target, target.identity)
      && sameRuntimeDataSetIdentity(previousRecord.source, candidate)) {
      const presence = await commitPresence(paths, previousRecord.commitId, target.database);
      if (presence === 'all') {
        await writeRuntimeDataSetMergeLedgerRecord(paths, {
          candidateId, state: 'merged', source: state.fingerprint!, target: target.identity,
          mergedAt: new Date().toISOString(), insertedRows: 0, reusedRows: 0, insertedConversations: 0
        });
        await removeRuntimeDataSetMergeCommit(paths, previousRecord.commitId).catch(() => undefined);
        return { kind: 'merged', result: {
          candidateId, sourceDataSetId: candidate.dataSetId!, targetDataSetId: target.identity.dataSetId,
          insertedRows: 0, reusedRows: 0, insertedConversations: 0,
          linkedCasObjects: 0, copiedCasObjects: 0, reusedCasObjects: 0, recoveredCommit: true,
          ...(state.upgradedFromEpoch !== undefined ? { upgradedFromEpoch: state.upgradedFromEpoch } : {})
        } };
      }
      if (presence === 'partial') {
        throw new Outcome({ kind: 'blocked', code: 'runtime-data-set-merge-conflict', message: '上次合并在提交时中断，之后当前库里这批对话已有增删，无法确认合并状态；请在历史与存储管理中手动合并。' });
      }
    }
    let snapshot = await openVerifiedSnapshot(current, binding);
    try {
      let finalized: RuntimeDataSetMergeResult['finalized'];
      if (!mode.finalizeWork) {
        // Carried unfinished work must be expressible as ordinary Repository rows: a request that
        // was receiving a reply has no such form (the source's own recovery closes it first).
        const streaming = Number(snapshot.database.prepare(
          "SELECT COUNT(*) FROM model_request WHERE status NOT IN ('prepared', 'terminal')"
        ).pluck().get() as bigint);
        if (streaming > 0) {
          throw new Outcome({ kind: 'failed', code: 'runtime-data-set-merge-streaming-model-request', message: `这个历史库里有 ${streaming} 个正在接收回复的模型请求，需要先打开它完成恢复后再迁移。` });
        }
      } else {
        let work = inspectUnfinishedWork(snapshot.database);
        if (work.refused.length > 0) throw new Outcome(unfinishedWorkOutcome(describeUnfinishedWork(work.refused)));
        if (hasFinalizableWork(work)) {
          const sourceBackupPath = await backupSource(binding);
          await fault(options, 'after-source-backup');
          await finalizeUnfinishedWork(createVscodeRootAuthority(current), work);
          await snapshot.close();
          snapshot = await openVerifiedSnapshot(current, binding);
          const counts = { turns: work.turns.length, intents: work.intents.length };
          work = inspectUnfinishedWork(snapshot.database);
          if (work.refused.length > 0 || hasFinalizableWork(work)) {
            throw new Outcome(unfinishedWorkOutcome(describeUnfinishedWork(work.refused) || '收尾后仍有未结束的任务'));
          }
          finalized = { ...counts, sourceBackupPath };
          state.fingerprint = await runtimeDataSetFingerprint(current);
        }
      }
      const size = measureSource(snapshot.database);
      const limits = options.limits ?? RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS;
      const run = (): Promise<RuntimeDataSetMergeResult> => mergePreparedSource(paths, target, current, binding, snapshot.database, state.fingerprint!, options);
      if (size.rows <= limits.maxRows && size.bytes <= limits.maxBytes) {
        const result = await run();
        return { kind: 'merged', result: { ...result, ...(state.upgradedFromEpoch !== undefined ? { upgradedFromEpoch: state.upgradedFromEpoch } : {}), ...(finalized ? { finalized } : {}) } };
      }
      if (!options.coordinateOversized) {
        throw new Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-too-large', message: `这份旧聊天记录较大（约 ${size.rows} 行），需要其它窗口暂时让出后才能合并，稍后重试。` });
      }
      let result: RuntimeDataSetMergeResult | undefined;
      const coordinate = options.coordinateOversized;
      const exclusive = await withRuntimeMaintenance(target.binding.paths, () => coordinate({
        targetPaths: target.binding.paths,
        requesterHostBootId: target.database.hostBootId,
        candidateId,
        operationKey: `${candidateId}@${fingerprintDigest(state.fingerprint!)}`,
        requested: mode.requested
      }, async () => { result = await run(); }));
      if (exclusive.state !== 'completed' || !result) {
        const reason = 'reason' in exclusive && exclusive.reason ? exclusive.reason : '其它窗口暂时无法让出';
        throw new Outcome({ kind: 'deferred', code: `runtime-data-set-merge-exclusive-${exclusive.state}`,
          message: `这份旧聊天记录较大（约 ${size.rows} 行），需要其它窗口暂时让出才能合并：${reason}。以后会自动重试。` });
      }
      return { kind: 'merged', result: { ...(result as RuntimeDataSetMergeResult), exclusive: true, ...(state.upgradedFromEpoch !== undefined ? { upgradedFromEpoch: state.upgradedFromEpoch } : {}), ...(finalized ? { finalized } : {}) } };
    } finally {
      await snapshot.close();
    }
  });
}

function unfinishedWorkOutcome(found: string): Exclude<SourceOutcome, { kind: 'merged' }> {
  return {
    kind: 'blocked',
    code: 'runtime-data-set-merge-unfinished-work',
    message: `这份旧聊天记录里还有无法自动收尾的工作（${found}），为避免在当前库里被自动继续执行，暂不合并；这个库的对话内容没有改动。`
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

async function openVerifiedSnapshot(
  candidate: VscodeRuntimeDataSetCandidate,
  binding: HistoricalRootBinding
): Promise<RuntimeDataSetDatabaseSnapshot> {
  const snapshot = await createRuntimeDataSetDatabaseSnapshot(candidate, binding);
  try {
    assertCurrentSchema(snapshot.database, binding as RootBinding);
    assertRuntimePhysicalSchemaFingerprint(snapshot.database, RUNTIME_DOMAIN_SCHEMAS);
    auditDatabaseIntegrity(snapshot.database);
    return snapshot;
  } catch (error) {
    await snapshot.close();
    throw new Outcome({ kind: 'failed', code: errorCode(error), message: `这个历史库的结构或完整性核验未通过：${errorMessage(error)}` });
  }
}

function measureSource(source: Database.Database): { rows: number; bytes: number } {
  let rows = 0;
  for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
    rows += Number(source.prepare(`SELECT COUNT(*) FROM "${schema.table}"`).pluck().get() as bigint);
  }
  const pageSize = Number(source.pragma('page_size', { simple: true }) as bigint | number);
  const pageCount = Number(source.pragma('page_count', { simple: true }) as bigint | number);
  return { rows, bytes: pageSize * pageCount };
}

async function mergePreparedSource(
  paths: { globalStoragePath: string },
  target: TargetContext,
  candidate: VscodeRuntimeDataSetCandidate,
  binding: HistoricalRootBinding,
  source: Database.Database,
  fingerprint: RuntimeDataSetFingerprint,
  options: RuntimeDataSetMergeOptions
): Promise<RuntimeDataSetMergeResult> {
  // Conflicts are found before anything touches the target (no backup, no CAS object).
  const plan = await planRows(source, target.database);
  if (plan.conflicts.count > 0) {
    throw new Outcome({
      kind: 'blocked',
      code: 'runtime-data-set-merge-conflict',
      message: `这份旧聊天记录与当前历史库有 ${plan.conflicts.count} 处同一条记录但内容不同（通常是合并后两边又各自改动了同一对话），整体未合并，两边内容都没有改动。`
        + '如需保留两边的改动，可以先切换到这个库查看，再决定删除哪一份。'
        + `\n${plan.conflicts.samples.join('\n')}`
    });
  }
  const backupPath = await ensureTargetBackup(target);
  await fault(options, 'after-target-backup');
  const cas = await transferCas(candidate.configurationRootPath, binding, target.configurationRootPath, target.binding, source, options)
    .catch((error: unknown) => {
      if (error instanceof Outcome) throw error;
      throw new Outcome({ kind: 'deferred', code: errorCode(error), message: `复制正文文件时出错，稍后重试：${errorMessage(error)}` });
    });
  await fault(options, 'after-cas-transfer');
  const commitId = await writeRuntimeDataSetMergeCommit(paths, plan.inserted);
  await writeRuntimeDataSetMergeLedgerRecord(paths, {
    candidateId: candidate.id, state: 'committing', source: fingerprint, target: target.identity, commitId
  });
  await fault(options, 'before-row-commit');
  if (plan.steps.length > 0) {
    try {
      await target.database.transaction(plan.steps);
    } catch (error) {
      // Nothing was committed (one transaction); the committing record converges next time.
      throw new Outcome({ kind: 'deferred', code: errorCode(error), message: `写入当前库时出错，稍后重试：${errorMessage(error)}` });
    }
  }
  await fault(options, 'after-row-commit');
  await writeRuntimeDataSetMergeLedgerRecord(paths, {
    candidateId: candidate.id, state: 'merged', source: fingerprint, target: target.identity,
    mergedAt: new Date().toISOString(), insertedRows: plan.inserted.length, reusedRows: plan.reused,
    insertedConversations: plan.insertedConversations
  });
  await removeRuntimeDataSetMergeCommit(paths, commitId).catch(() => undefined);
  return {
    candidateId: candidate.id,
    sourceDataSetId: candidate.dataSetId!,
    targetDataSetId: target.identity.dataSetId,
    insertedRows: plan.inserted.length,
    reusedRows: plan.reused,
    insertedConversations: plan.insertedConversations,
    ...cas,
    backupPath,
    recoveredCommit: false
  };
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
        plan.steps.push(historical && !notStarted(row) ? repository.insertHistoricalCopy(inserted) : repository.insert(inserted));
        plan.inserted.push([schema.key, id]);
        if (schema.key === 'Conversation') plan.insertedConversations += 1;
      }
      chunk = [];
      // Decoding stays on the extension thread; yield so a large source never monopolizes it.
      await new Promise((resolve) => setImmediate(resolve));
    };
    for (const raw of statement.iterate() as IterableIterator<Record<string, unknown>>) {
      chunk.push(repository.codec.decode(raw));
      if (chunk.length >= READ_CHUNK) await flush();
    }
    await flush();
  }
  if (plan.steps.length > 0) plan.steps.push(...presence);
  return plan;
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
  if (!commit || commit.rows.length === 0) return 'none';
  let present = 0;
  for (let start = 0; start < commit.rows.length; start += READ_CHUNK) {
    const rows = commit.rows.slice(start, start + READ_CHUNK);
    const found = (await database.snapshot(rows.map(([domain, id]) => DOMAIN_REPOSITORIES.domain(domain).get(id)))).snapshot;
    present += found.filter((row) => row !== null).length;
  }
  return present === 0 ? 'none' : present === commit.rows.length ? 'all' : 'partial';
}

async function transferCas(
  sourceConfigurationRootPath: string,
  sourceBinding: HistoricalRootBinding,
  targetConfigurationRootPath: string,
  targetBinding: HistoricalRootBinding,
  source: Database.Database,
  options: Pick<RuntimeDataSetMergeOptions, 'linkFile'>
): Promise<RuntimeDataSetCasTransfer> {
  const result = { linkedCasObjects: 0, copiedCasObjects: 0, reusedCasObjects: 0 };
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
      throw new Outcome({ kind: 'failed', code: 'runtime-data-set-merge-source-cas-invalid', message: `来源的正文登记不一致：${row.storage_key}。原数据保持不变。` });
    }
    seen.add(row.storage_key);
    const sourceFile = casPath(sourceCas, row.storage_key);
    const targetFile = casPath(targetCas, row.storage_key);
    const existing = await regularFileSize(targetFile);
    if (existing !== undefined) {
      // CAS files are never rewritten: an existing object must already be exactly these bytes.
      if (existing !== row.byte_length || await sha256File(targetFile) !== row.sha256) {
        throw new Outcome({ kind: 'blocked', code: 'runtime-data-set-merge-target-cas-damaged', message: `当前历史库里的正文文件已损坏：${row.storage_key}。为免覆盖，暂不合并。` });
      }
      result.reusedCasObjects += 1;
      continue;
    }
    if (await regularFileSize(sourceFile) !== row.byte_length || await sha256File(sourceFile) !== row.sha256) {
      throw new Outcome({ kind: 'failed', code: 'runtime-data-set-merge-source-cas-invalid', message: `来源缺少正文文件或内容与摘要不符：${row.storage_key}。原数据保持不变。` });
    }
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
  const root = path.join(backups, `${timestampSlug()}-${randomUUID().slice(0, 8)}`);
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

/** Keeps the newest target backups; the ones removed only ever held pre-merge copies. */
async function pruneTargetBackups(target: TargetContext): Promise<void> {
  const backups = path.join(target.controlRoot, RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY);
  const names = (await fs.readdir(backups)).filter((name) => /^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(name)).sort();
  for (const name of names.slice(0, Math.max(0, names.length - RUNTIME_DATA_SET_MERGE_BACKUP_RETENTION))) {
    await fs.rm(path.join(backups, name), { recursive: true, force: true });
  }
  await syncDirectoryDurably(backups);
}

/** Source backup before finalization, with the offline SQLite Backup API, beside the source. */
async function backupSource(binding: HistoricalRootBinding): Promise<string> {
  const backups = path.join(path.dirname(binding.paths.dataRootPath), RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY);
  const root = path.join(backups, `${timestampSlug()}-${randomUUID().slice(0, 8)}`);
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

async function regularFileSize(file: string): Promise<bigint | undefined> {
  try {
    const info = await fs.lstat(file, { bigint: true });
    if (!info.isFile()) throw new Error(`CAS entry is not a regular file: ${file}`);
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

function timestampSlug(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && code.length > 0 ? code : 'runtime-data-set-merge-failed';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { MERGE_FINALIZATION_REASON };
