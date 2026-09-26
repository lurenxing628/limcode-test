import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import { isPathBelow } from '../capabilities/filesystem/pathContainment';
import { storageKeyForDigest } from './contentAddressedStore';
import { RUNTIME_KERNEL_EPOCH, type RootBinding, type RuntimeRootPaths } from './contracts';
import { assertCurrentSchema, auditDatabaseIntegrity, configureWriterConnection } from './databaseSchema';
import { type HistoricalRootBinding } from './rootAuthority';
import { upgradeRuntimeDataSet } from './runtimeDataSetUpgrade';
import {
  assertRuntimeHostsOffline, isRuntimeHostsActiveError, withRuntimeDataRootAdmission, withRuntimeMaintenance,
  type RuntimeHostActiveDescriptor
} from './runtimeHostControl';
import type { RuntimeExclusiveMaintenanceOutcome } from './runtimeExclusiveMaintenance';
import { assertRuntimePhysicalSchemaFingerprint } from './runtimePhysicalSchemaFingerprint';
import {
  assertNoSymbolicPath, createRuntimeDataSetDatabaseSnapshot, requireCompleteRuntimeDataSet
} from './runtimeStorageInspection';
import { RUNTIME_DOMAIN_SCHEMAS } from './schema/domainManifest';
import { toSqliteFilePath } from './sqliteFilePath';
import {
  inspectVscodeRuntimeDataSets, resolveVscodeRuntimeDataSet, type VscodeRuntimeDataSetCandidate
} from './vscodeRootAuthority';

/** Per-source durable state, kept in the selected target's control root beside its active root. */
export const RUNTIME_DATA_SET_MERGE_RECORDS_DIRECTORY = 'merged-sources';
/** Explicit user requests to merge a non-workspace data set on the next exclusive startup. */
export const RUNTIME_DATA_SET_MERGE_REQUESTS_DIRECTORY = 'merge-requests';
/** One verified SQLite Backup API copy of the target per startup batch that changes it. */
export const RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY = 'merge-backups';

const MERGE_RECORD_KIND = 'limcode-runtime-data-set-merge';
const MERGE_REQUEST_KIND = 'limcode-runtime-data-set-merge-request';
const MAX_REPORTED_CONFLICTS = 20;

/**
 * Domains whose id is derived from content identity. The same id in two data sets is the same
 * content/project; only these presentation or creation-time columns may differ, and the
 * selected target keeps its row. Every other domain must match exactly or the source is refused.
 */
const IDENTITY_MERGE_DIFFERENCES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // id = hash(content_type, sha256, byte_length); storage_key derives from sha256.
  ['ContentObject', new Set(['created_at'])],
  // id = hash(uri); kind/uri must match, name and timestamps are mutable presentation facts.
  ['ProjectContext', new Set(['name', 'created_at', 'updated_at'])],
  // id = hash(sha256, mime type, name); storage and content object follow from the same bytes.
  ['Attachment', new Set(['created_at'])]
]);

/**
 * Work that the current Runtime would resume, reconcile, deliver or ask about after a merge.
 * A source containing any of it is not merged: finalizing it offline would invent semantics
 * that the kernel only defines for a live Runner (resume judgment, effect reconciliation).
 */
const UNFINISHED_WORK_PROBES: ReadonlyArray<readonly [label: string, sql: string]> = Object.freeze([
  ['Turn(active)', "SELECT COUNT(*) FROM turn WHERE status = 'active'"],
  ['ExecutionLease', 'SELECT COUNT(*) FROM execution_lease'],
  ['TurnIntent(queued)', "SELECT COUNT(*) FROM turn_intent WHERE state = 'queued'"],
  ['PendingTurnInput(pending)', "SELECT COUNT(*) FROM pending_turn_input WHERE state = 'pending'"],
  ['ToolCall(unfinished)', "SELECT COUNT(*) FROM tool_call WHERE status IN ('pending', 'executing', 'waiting_approval', 'waiting_answer')"],
  ['Operation(unfinished)', "SELECT COUNT(*) FROM operation WHERE status IN ('pending', 'executing', 'waiting_answer')"],
  ['EffectIntent(unreceipted)', "SELECT COUNT(*) FROM effect_intent WHERE dispatch_state IN ('pending', 'dispatched')"],
  ['ModelRequest(unfinished)', "SELECT COUNT(*) FROM model_request WHERE status <> 'terminal'"],
  ['InteractionRequest(pending)', "SELECT COUNT(*) FROM interaction_request WHERE status = 'pending'"],
  ['ChildExecution(active)', "SELECT COUNT(*) FROM child_execution WHERE status IN ('starting', 'active', 'interrupting')"],
  ['ChildExecutionActiveTurnLink', 'SELECT COUNT(*) FROM child_execution_active_turn_link'],
  ['ChildExecutionIntentLink(pending)', "SELECT COUNT(*) FROM child_execution_intent_link WHERE state = 'pending'"],
  ['RuntimeDelivery(pending)', "SELECT COUNT(*) FROM runtime_delivery WHERE state = 'pending'"],
  ['RuntimeDeliveryWake(pending)', "SELECT COUNT(*) FROM runtime_delivery_wake WHERE state IN ('pending', 'claimed')"],
  ['CollaborationRequest(pending)', "SELECT COUNT(*) FROM collaboration_request WHERE state = 'pending'"],
  ['Process(running)', "SELECT COUNT(*) FROM process WHERE status NOT IN ('exited', 'cancelled', 'timed_out', 'output_limit_exceeded')"],
  ['ProcessCompletionDispatch(pending)', "SELECT COUNT(*) FROM process_completion_dispatch WHERE state IN ('pending', 'claimed')"],
  // Terminal output that is not fully registered would be re-read from the source-local spool.
  ['ProcessOutputChunk(unregistered)', `
    SELECT COUNT(*) FROM (
      SELECT process.id
        FROM process
        LEFT JOIN process_output_chunk AS chunk ON chunk.process_id = process.id
       GROUP BY process.id, process.retained_chunks, process.retained_bytes
      HAVING COUNT(chunk.id) <> process.retained_chunks
          OR COALESCE(SUM(chunk.byte_length), 0) <> process.retained_bytes
          OR (process.retained_chunks > 0 AND MIN(chunk.chunk_seq) <> 1)
          OR (process.retained_chunks > 0 AND MAX(chunk.chunk_seq) <> process.retained_chunks)
    )`]
]);

export type RuntimeDataSetMergeFaultPoint =
  | 'after-target-backup'
  | 'after-cas-transfer'
  | 'before-row-commit'
  | 'after-row-commit';

export interface RuntimeDataSetMergeOptions {
  /** Test-only crash injection at durable boundaries. */
  onFaultPoint?(point: RuntimeDataSetMergeFaultPoint): void | Promise<void>;
  /** Defaults to fs.link; a cross-device or unsupported link falls back to a verified copy. */
  linkFile?(source: string, target: string): Promise<void>;
}

/** A complete Runtime root addressed directly, e.g. a fresh root under another data directory. */
export interface RuntimeDataSetMergeEndpoint {
  configurationRootPath: string;
  binding: HistoricalRootBinding;
}

export interface RuntimeDataSetMergeIntoTargetOptions extends RuntimeDataSetMergeOptions {
  /**
   * Only for moving a whole data set into a root that becomes the selected root for the same
   * work (data-root migration): unfinished work is carried and recovered there as after a crash.
   * Historical merges never set this.
   */
  allowUnfinishedWork?: boolean;
}

export interface RuntimeDataSetCasTransfer {
  linkedCasObjects: number;
  copiedCasObjects: number;
  reusedCasObjects: number;
}

export interface RuntimeDataSetMergeResult {
  candidateId: string;
  sourceDataSetId: string;
  targetDataSetId: string;
  insertedRows: number;
  reusedRows: number;
  insertedConversations: number;
  linkedCasObjects: number;
  copiedCasObjects: number;
  reusedCasObjects: number;
  backupPath: string;
  /** A previous commit was found through its committing record; rows were not merged again. */
  recoveredCommit: boolean;
  /** The source was upgraded from a published predecessor immediately before merging. */
  upgradedFromEpoch?: 3 | 4;
}

export interface RuntimeDataSetMergeIssue {
  candidateId?: string;
  code: string;
  message: string;
}

export interface RuntimeDataSetMergeBlocked extends RuntimeDataSetMergeIssue {
  candidateId: string;
  /** False when the same unchanged source was already reported on an earlier startup. */
  newlyBlocked: boolean;
}

export interface RuntimeDataSetMergeBatchOptions extends RuntimeDataSetMergeOptions {
  /** Stop before the next source when activation ends or its configuration root changes. */
  shouldContinue?(): boolean;
  /** Called once, only when at least one source actually needs work. */
  onWorkStart?(total: number): void;
  onSourceStart?(candidate: VscodeRuntimeDataSetCandidate, index: number, total: number): void;
  /**
   * Called under the batch's configuration admission and target maintenance claim when other Hosts
   * use the target. Typically {@link requestExclusiveRuntimeMaintenance} with `operationKey`, which
   * identifies the pending sources so backoff never delays a different set: every other window
   * first answers, and only when all can yield do they reload and `merge` runs. Without it such a
   * batch is only reported.
   */
  coordinateTargetHosts?(
    targetPaths: RuntimeRootPaths,
    merge: () => Promise<void>,
    operationKey: string
  ): Promise<RuntimeExclusiveMaintenanceOutcome<void>>;
}

export interface RuntimeDataSetMergeBatchResult {
  targetCandidateId?: string;
  /** Selected target root, for callers that coordinate exclusivity on it. */
  targetRuntimeDataRootPath?: string;
  merged: RuntimeDataSetMergeResult[];
  /** Sources still used by a live or unverifiable Host (typically an older window). */
  deferred: RuntimeDataSetMergeIssue[];
  blocked: RuntimeDataSetMergeBlocked[];
  failures: RuntimeDataSetMergeIssue[];
  /** Non-empty when other Hosts still use the selected target; nothing was merged. */
  targetHostsActive: RuntimeHostActiveDescriptor[];
  /** Number of sources that would be processed once the target is exclusive. */
  pendingSources: number;
  stopped: boolean;
}

export type RuntimeDataSetMergeState =
  | { state: 'merged'; mergedAt: string }
  | { state: 'blocked'; code: string; message: string }
  | { state: 'requested'; requestedAt: string };

export class RuntimeDataSetMergeBlockedError extends Error {
  public constructor(
    public readonly code:
      | 'runtime-data-set-merge-unfinished-work'
      | 'runtime-data-set-merge-conflict'
      | 'runtime-data-set-merge-source-cas-invalid',
    message: string
  ) {
    super(message);
    this.name = 'RuntimeDataSetMergeBlockedError';
  }
}

export class RuntimeDataSetMergeError extends Error {
  public constructor(public readonly code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'RuntimeDataSetMergeError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

interface SourceFingerprint {
  dataSetId: string;
  rootInstanceId: string;
  rootGeneration: number;
  pointerRevision: number;
  databaseSize: number;
  databaseMtimeMs: number;
  walSize: number;
  walMtimeMs: number;
}

interface TargetIdentity {
  dataSetId: string;
  rootInstanceId: string;
}

type MergeRecord = {
  kind: typeof MERGE_RECORD_KIND;
  candidateId: string;
  target: TargetIdentity;
  source: SourceFingerprint;
  updatedAt: string;
} & (
  | { state: 'committing'; backupDirectoryName: string }
  | {
    state: 'merged';
    mergedAt: string;
    backupDirectoryName: string;
    insertedRows: number;
    reusedRows: number;
    insertedConversations: number;
  }
  | { state: 'blocked'; code: string; message: string }
);

interface MergeRequest {
  kind: typeof MERGE_REQUEST_KIND;
  candidateId: string;
  expectedDataSetId: string;
  expectedRootInstanceId: string;
  target: TargetIdentity;
  requestedAt: string;
}

interface SelectedTarget {
  candidate: VscodeRuntimeDataSetCandidate;
  binding: HistoricalRootBinding;
  controlRoot: string;
  identity: TargetIdentity;
}

interface BatchBackup {
  directoryName?: string;
}

/**
 * Merges every unmerged historical workspace scope, plus explicitly requested data sets, into the
 * selected data set. Call before the selected Runtime registers its Host (startup) — the whole
 * batch holds configuration admission and target maintenance, and the target must have no other
 * live or unverifiable Host. Sources are handled one at a time; a source failure never blocks the
 * others. Sources and their CAS stay unchanged, selection is not switched, and no source work is
 * resumed: sources with unfinished work are refused.
 */
export async function mergeRuntimeDataSetsIntoSelected(
  paths: { globalStoragePath: string },
  options: RuntimeDataSetMergeBatchOptions = {}
): Promise<RuntimeDataSetMergeBatchResult> {
  const storagePaths = { globalStoragePath: path.resolve(paths.globalStoragePath) };
  const report: RuntimeDataSetMergeBatchResult = {
    merged: [], deferred: [], blocked: [], failures: [], targetHostsActive: [], pendingSources: 0, stopped: false
  };
  const keepGoing = (): boolean => {
    if (options.shouldContinue?.() !== false) return true;
    report.stopped = true;
    return false;
  };
  if (!keepGoing()) return report;
  return withRuntimeDataRootAdmission(storagePaths.globalStoragePath, async () => {
    let inspection;
    try { inspection = await inspectVscodeRuntimeDataSets(storagePaths); }
    catch (error) {
      report.failures.push(mergeIssue(error));
      return report;
    }
    const selected = inspection.candidates.filter((candidate) => candidate.selected);
    if (selected.length !== 1 || !selected[0].dataSetId || selected[0].requiresRecovery) return report;
    let target: SelectedTarget;
    try { target = await requireSelectedTarget(selected[0]); }
    catch (error) {
      report.failures.push(mergeIssue(error));
      return report;
    }
    report.targetCandidateId = target.candidate.id;
    report.targetRuntimeDataRootPath = target.binding.paths.dataRootPath;
    const records = await readMergeRecords(target);
    const history = await readAutomaticMergeHistory(inspection.candidates);
    const requests = await readMergeRequests(target);
    const sources: VscodeRuntimeDataSetCandidate[] = [];
    for (const candidate of inspection.candidates) {
      if (candidate.selected || !candidate.dataSetId || !candidate.rootInstanceId) continue;
      const request = requests.get(candidate.id);
      const requested = request !== undefined
        && request.expectedDataSetId === candidate.dataSetId
        && request.expectedRootInstanceId === candidate.rootInstanceId;
      if (candidate.source !== 'workspace' && !requested) continue;
      if (!requested && (history.targets.has(candidate.id)
        || history.mergedElsewhere.has(sourceKey(candidate.id, candidate.dataSetId, candidate.rootInstanceId)))) continue;
      const record = records.get(candidate.id);
      if (record && record.source.dataSetId === candidate.dataSetId
        && record.source.rootInstanceId === candidate.rootInstanceId) {
        if (record.state === 'merged') {
          if (requested) await removeMergeRequest(target, candidate.id);
          continue;
        }
        if (record.state === 'blocked' && !requested
          && sameFingerprint(record.source, await sourceFingerprint(candidate).catch(() => undefined))) {
          report.blocked.push({ candidateId: candidate.id, code: record.code, message: record.message, newlyBlocked: false });
          continue;
        }
      }
      sources.push(candidate);
    }
    report.pendingSources = sources.length;
    if (sources.length === 0) return report;
    return withRuntimeMaintenance(target.binding.paths, async () => {
      try {
        await assertRuntimeHostsOffline(target.binding.paths);
      } catch (error) {
        if (!isRuntimeHostsActiveError(error)) throw error;
        const hosts = [...(error as { hosts: RuntimeHostActiveDescriptor[] }).hosts];
        if (!options.coordinateTargetHosts) {
          report.targetHostsActive = hosts;
          return report;
        }
        const operationKey = sources
          .map((source) => `${source.id}@${source.dataSetId ?? ''}/${source.rootInstanceId ?? ''}`)
          .sort().join('|');
        const outcome = await options.coordinateTargetHosts(target.binding.paths, () => mergeSources(), operationKey);
        if (outcome.state !== 'completed') report.targetHostsActive = outcome.hosts;
        return report;
      }
      await mergeSources();
      return report;
    });

    async function mergeSources(): Promise<void> {
      // The pointer may have been recovered by another admission holder; recheck under maintenance.
      const current = await requireSelectedTarget(await resolveVscodeRuntimeDataSet(storagePaths, target.candidate.id));
      if (current.identity.dataSetId !== target.identity.dataSetId
        || current.identity.rootInstanceId !== target.identity.rootInstanceId) {
        throw new RuntimeDataSetMergeError('runtime-data-set-merge-target-changed', '当前历史库在合并前发生了变化，本次不合并。');
      }
      options.onWorkStart?.(sources.length);
      const backup: BatchBackup = {};
      for (const [index, source] of sources.entries()) {
        if (!keepGoing()) break;
        options.onSourceStart?.(source, index, sources.length);
        try {
          report.merged.push(await mergeOneSource(storagePaths, current, source, backup, records.get(source.id), options));
          await removeMergeRequest(current, source.id);
        } catch (error) {
          if (isRuntimeHostsActiveError(error)) {
            report.deferred.push({ candidateId: source.id, code: 'runtime-hosts-active', message: errorMessage(error) });
          } else if (error instanceof RuntimeDataSetMergeBlockedError) {
            const fingerprint = await sourceFingerprint(
              await resolveVscodeRuntimeDataSet(storagePaths, source.id)
            ).catch(() => undefined);
            if (fingerprint) {
              await writeMergeRecord(current, source.id, {
                state: 'blocked', source: fingerprint, code: error.code, message: error.message
              }).catch(() => undefined);
            }
            await removeMergeRequest(current, source.id).catch(() => undefined);
            report.blocked.push({ candidateId: source.id, code: error.code, message: error.message, newlyBlocked: true });
          } else {
            report.failures.push(mergeIssue(error, source.id));
          }
        }
      }
    }
  });
}

/**
 * Merges one complete data set of this configuration root into an explicitly addressed target root
 * (which may live under another data directory or filesystem). The caller must already hold the
 * target's configuration admission when it differs from `paths`; this function takes `paths`
 * admission and the target maintenance claim, and requires both roots to have no live Host.
 * Pre-copy CAS with {@link precopyRuntimeDataSetCas} first to keep the exclusive window short.
 */
export async function mergeRuntimeDataSetIntoTarget(
  paths: { globalStoragePath: string },
  input: { candidateId: string; expectedDataSetId: string; expectedRootInstanceId: string },
  targetEndpoint: RuntimeDataSetMergeEndpoint,
  options: RuntimeDataSetMergeIntoTargetOptions = {}
): Promise<RuntimeDataSetMergeResult> {
  const storagePaths = { globalStoragePath: path.resolve(paths.globalStoragePath) };
  return withRuntimeDataRootAdmission(storagePaths.globalStoragePath, () =>
    withRuntimeMaintenance(targetEndpoint.binding.paths, async () => {
      await assertRuntimeHostsOffline(targetEndpoint.binding.paths);
      const target = await requireTargetEndpoint(targetEndpoint);
      const candidate = await resolveVscodeRuntimeDataSet(storagePaths, input.candidateId);
      if (candidate.dataSetId !== input.expectedDataSetId || candidate.rootInstanceId !== input.expectedRootInstanceId) {
        throw new RuntimeDataSetMergeError('runtime-data-set-merge-identity-mismatch', '来源历史库的身份已变化，本次不合并。');
      }
      const records = await readMergeRecords(target);
      return mergeOneSource(storagePaths, target, candidate, {}, records.get(candidate.id), options);
    }));
}

/**
 * Online CAS pre-copy for a later exclusive merge. Safe while the source Runtime is running: the
 * referenced objects come from a snapshot (SQLite Backup API while a WAL exists, otherwise a plain
 * copy, so an offline source gets no new sidecar files) and CAS files are immutable and verified.
 * The merge later transfers only what is still missing; unreferenced target blobs are harmless.
 */
export async function precopyRuntimeDataSetCas(
  source: RuntimeDataSetMergeEndpoint,
  target: RuntimeDataSetMergeEndpoint,
  options: Pick<RuntimeDataSetMergeOptions, 'linkFile'> = {}
): Promise<RuntimeDataSetCasTransfer> {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-merge-precopy-'));
  try {
    const snapshotPath = path.join(temporaryRoot, 'limcode.sqlite');
    const databasePath = source.binding.paths.databasePath;
    await assertNoSymbolicPath(source.configurationRootPath, databasePath);
    if (await fs.stat(`${databasePath}-wal`).then(() => true, () => false)) {
      const live = new Database(toSqliteFilePath(databasePath), { readonly: true, fileMustExist: true });
      try { await live.backup(toSqliteFilePath(snapshotPath)); }
      finally { live.close(); }
    } else {
      await fs.copyFile(databasePath, snapshotPath, constants.COPYFILE_FICLONE);
    }
    const snapshot = new Database(toSqliteFilePath(snapshotPath), { readonly: true, fileMustExist: true });
    try {
      snapshot.defaultSafeIntegers(true);
      return await transferCas(source, target, snapshot, options);
    } finally { snapshot.close(); }
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
}

/** Records an explicit merge of a complete non-selected data set for the next exclusive startup. */
export async function requestRuntimeDataSetMerge(
  paths: { globalStoragePath: string },
  input: { candidateId: string; expectedDataSetId: string; expectedRootInstanceId: string }
): Promise<void> {
  const storagePaths = { globalStoragePath: path.resolve(paths.globalStoragePath) };
  await withRuntimeDataRootAdmission(storagePaths.globalStoragePath, async () => {
    const selected = (await inspectVscodeRuntimeDataSets(storagePaths)).candidates.filter((candidate) => candidate.selected);
    if (selected.length !== 1 || !selected[0].dataSetId) {
      throw new RuntimeDataSetMergeError('runtime-data-set-merge-target-missing', '请先选定当前历史库，再合并其它历史库。');
    }
    const target = await requireSelectedTarget(selected[0]);
    const candidate = await resolveVscodeRuntimeDataSet(storagePaths, input.candidateId);
    if (candidate.selected) {
      throw new RuntimeDataSetMergeError('runtime-data-set-merge-source-selected', '不能把当前历史库合并到自身。');
    }
    if (candidate.dataSetId !== input.expectedDataSetId || candidate.rootInstanceId !== input.expectedRootInstanceId) {
      throw new RuntimeDataSetMergeError('runtime-data-set-merge-identity-mismatch', '所选历史库的身份已变化，请重新打开历史与存储管理。');
    }
    const request: MergeRequest = {
      kind: MERGE_REQUEST_KIND,
      candidateId: candidate.id,
      expectedDataSetId: input.expectedDataSetId,
      expectedRootInstanceId: input.expectedRootInstanceId,
      target: target.identity,
      requestedAt: new Date().toISOString()
    };
    await writeDurableJson(path.join(target.controlRoot, RUNTIME_DATA_SET_MERGE_REQUESTS_DIRECTORY, recordFileName(candidate.id)), request);
  });
}

/** Read-only merge state of each non-selected candidate relative to the selected data set. */
export async function readRuntimeDataSetMergeStates(
  paths: { globalStoragePath: string }
): Promise<Map<string, RuntimeDataSetMergeState>> {
  const result = new Map<string, RuntimeDataSetMergeState>();
  const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: path.resolve(paths.globalStoragePath) });
  const selected = inspection.candidates.filter((candidate) => candidate.selected);
  if (selected.length !== 1 || !selected[0].dataSetId) return result;
  let target: SelectedTarget;
  try { target = await requireSelectedTarget(selected[0]); } catch { return result; }
  const records = await readMergeRecords(target);
  const requests = await readMergeRequests(target);
  for (const candidate of inspection.candidates) {
    if (candidate.selected) continue;
    const record = records.get(candidate.id);
    const current = record && record.source.dataSetId === candidate.dataSetId
      && record.source.rootInstanceId === candidate.rootInstanceId ? record : undefined;
    const request = requests.get(candidate.id);
    if (current?.state === 'merged') result.set(candidate.id, { state: 'merged', mergedAt: current.mergedAt });
    else if (request && request.expectedDataSetId === candidate.dataSetId
      && request.expectedRootInstanceId === candidate.rootInstanceId) {
      result.set(candidate.id, { state: 'requested', requestedAt: request.requestedAt });
    } else if (current?.state === 'blocked') {
      result.set(candidate.id, { state: 'blocked', code: current.code, message: current.message });
    }
  }
  return result;
}

async function mergeOneSource(
  paths: { globalStoragePath: string },
  target: SelectedTarget,
  initial: VscodeRuntimeDataSetCandidate,
  backup: BatchBackup,
  previousRecord: MergeRecord | undefined,
  options: RuntimeDataSetMergeIntoTargetOptions
): Promise<RuntimeDataSetMergeResult> {
  let candidate = initial;
  let upgradedFromEpoch: 3 | 4 | undefined;
  if (candidate.runtimeKernelEpoch === 3 || candidate.runtimeKernelEpoch === 4) {
    // Published predecessors go through the exact P2 upgrade first; it requires the source offline.
    const upgrade = await upgradeRuntimeDataSet(paths, {
      candidateId: candidate.id,
      expectedDataSetId: candidate.dataSetId!,
      expectedRootInstanceId: candidate.rootInstanceId!
    });
    upgradedFromEpoch = upgrade.previousEpoch;
    candidate = await resolveVscodeRuntimeDataSet(paths, candidate.id);
  }
  if (candidate.runtimeKernelEpoch !== RUNTIME_KERNEL_EPOCH || candidate.requiresRecovery) {
    throw new RuntimeDataSetMergeError(
      'runtime-data-set-merge-source-unsupported',
      `第 ${candidate.runtimeKernelEpoch ?? '?'} 代或待恢复的历史库不能合并；原数据保持不变。`
    );
  }
  const sourceIdentity = { dataSetId: candidate.dataSetId!, rootInstanceId: candidate.rootInstanceId! };
  if (sourceIdentity.dataSetId === target.identity.dataSetId) {
    throw new RuntimeDataSetMergeError('runtime-data-set-merge-same-identity', '来源与当前历史库是同一个数据集，不能合并。');
  }
  const sourceBinding = await requireCompleteRuntimeDataSet(candidate);
  return withRuntimeMaintenance(sourceBinding.paths, async () => {
    try {
      await assertNoSymbolicPath(candidate.configurationRootPath, path.join(sourceBinding.paths.dataRootPath, 'host-liveness'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await assertRuntimeHostsOffline(sourceBinding.paths);
    const current = await resolveVscodeRuntimeDataSet(paths, candidate.id);
    if (current.dataSetId !== sourceIdentity.dataSetId || current.rootInstanceId !== sourceIdentity.rootInstanceId) {
      throw new RuntimeDataSetMergeError('runtime-data-set-merge-identity-mismatch', '来源历史库在合并前发生了变化，本次不合并。');
    }
    const binding = await requireCompleteRuntimeDataSet(current);
    const fingerprint = await sourceFingerprint(current);
    const snapshot = await createRuntimeDataSetDatabaseSnapshot(current, binding);
    try {
      const source = snapshot.database;
      assertCurrentSchema(source, binding as RootBinding);
      assertRuntimePhysicalSchemaFingerprint(source, RUNTIME_DOMAIN_SCHEMAS);
      auditDatabaseIntegrity(source);

      if (previousRecord?.state === 'committing'
        && previousRecord.source.dataSetId === sourceIdentity.dataSetId
        && previousRecord.source.rootInstanceId === sourceIdentity.rootInstanceId) {
        const presence = sourceRowPresence(target, source);
        if (presence.present > 0 && presence.present < presence.total) {
          throw new RuntimeDataSetMergeBlockedError(
            'runtime-data-set-merge-conflict',
            '上次合并在提交前后中断，且当前历史库只包含这份旧记录的一部分，无法确认合并状态；原数据保持不变。'
          );
        }
        if (presence.total > 0 && presence.present === presence.total) {
          // The row transaction committed before its record was finalized. Rows may have changed
          // since (the Runtime could have opened); never re-merge them, only finish the record.
          const counts = countSourceRows(source);
          await writeMergeRecord(target, current.id, {
            state: 'merged', source: fingerprint, mergedAt: new Date().toISOString(),
            backupDirectoryName: previousRecord.backupDirectoryName,
            insertedRows: 0, reusedRows: counts.rows, insertedConversations: 0
          });
          return {
            candidateId: current.id, sourceDataSetId: sourceIdentity.dataSetId, targetDataSetId: target.identity.dataSetId,
            insertedRows: 0, reusedRows: counts.rows, insertedConversations: 0,
            linkedCasObjects: 0, copiedCasObjects: 0, reusedCasObjects: 0,
            backupPath: backupRootPath(target, previousRecord.backupDirectoryName), recoveredCommit: true,
            ...(upgradedFromEpoch !== undefined ? { upgradedFromEpoch } : {})
          };
        }
      }

      if (!options.allowUnfinishedWork) assertSourceQuiescent(source);
      const backupDirectoryName = await ensureTargetBackup(target, backup);
      await fault(options, 'after-target-backup');
      const cas = await transferCas(
        { configurationRootPath: current.configurationRootPath, binding },
        { configurationRootPath: target.candidate.configurationRootPath, binding: target.binding },
        source, options
      );
      await fault(options, 'after-cas-transfer');
      const rows = await mergeRows(target, source, async () => {
        await writeMergeRecord(target, current.id, { state: 'committing', source: fingerprint, backupDirectoryName });
        await fault(options, 'before-row-commit');
      });
      await fault(options, 'after-row-commit');
      await writeMergeRecord(target, current.id, {
        state: 'merged', source: fingerprint, mergedAt: new Date().toISOString(), backupDirectoryName,
        insertedRows: rows.insertedRows, reusedRows: rows.reusedRows, insertedConversations: rows.insertedConversations
      });
      return {
        candidateId: current.id,
        sourceDataSetId: sourceIdentity.dataSetId,
        targetDataSetId: target.identity.dataSetId,
        ...rows,
        ...cas,
        backupPath: backupRootPath(target, backupDirectoryName),
        recoveredCommit: false,
        ...(upgradedFromEpoch !== undefined ? { upgradedFromEpoch } : {})
      };
    } finally {
      await snapshot.close();
    }
  });
}

function assertSourceQuiescent(source: Database.Database): void {
  const found: string[] = [];
  for (const [label, sql] of UNFINISHED_WORK_PROBES) {
    const count = Number(source.prepare(sql).pluck().get() as bigint | number);
    if (count > 0) found.push(`${label}×${count}`);
  }
  if (found.length > 0) {
    throw new RuntimeDataSetMergeBlockedError(
      'runtime-data-set-merge-unfinished-work',
      `这份旧聊天记录里还有未结束的任务（${found.join('、')}），为避免在当前库里被自动继续执行，暂不合并；原数据保持不变。`
    );
  }
}

async function transferCas(
  sourceEndpoint: RuntimeDataSetMergeEndpoint,
  targetEndpoint: RuntimeDataSetMergeEndpoint,
  source: Database.Database,
  options: Pick<RuntimeDataSetMergeOptions, 'linkFile'>
): Promise<RuntimeDataSetCasTransfer> {
  const result = { linkedCasObjects: 0, copiedCasObjects: 0, reusedCasObjects: 0 };
  const sourceCas = path.resolve(sourceEndpoint.binding.paths.casRootPath);
  const targetCas = path.resolve(targetEndpoint.binding.paths.casRootPath);
  await assertNoSymbolicPath(sourceEndpoint.configurationRootPath, sourceCas);
  await assertNoSymbolicPath(targetEndpoint.configurationRootPath, targetCas);
  const rows = source.prepare(`
    SELECT storage_key, sha256, MAX(byte_length) AS byte_length, MIN(byte_length) AS min_length
      FROM content_object GROUP BY storage_key, sha256
  `).all() as Array<{ storage_key: string; sha256: string; byte_length: bigint; min_length: bigint }>;
  const seen = new Set<string>();
  const touchedDirectories = new Set<string>();
  const link = options.linkFile ?? ((from: string, to: string) => fs.link(from, to));
  for (const row of rows) {
    if (row.byte_length !== row.min_length || storageKeyForDigest(row.sha256) !== row.storage_key || seen.has(row.storage_key)) {
      throw new RuntimeDataSetMergeBlockedError(
        'runtime-data-set-merge-source-cas-invalid', `来源的正文登记不一致：${row.storage_key}。原数据保持不变。`
      );
    }
    seen.add(row.storage_key);
    const byteLength = row.byte_length;
    const sourceFile = casPath(sourceCas, row.storage_key);
    const targetFile = casPath(targetCas, row.storage_key);
    if (await regularFileSize(targetFile) !== undefined) {
      if (await regularFileSize(targetFile) !== byteLength) {
        throw new RuntimeDataSetMergeBlockedError(
          'runtime-data-set-merge-conflict', `当前历史库已有同名但长度不同的正文文件：${row.storage_key}。`
        );
      }
      result.reusedCasObjects += 1;
      continue;
    }
    const sourceSize = await regularFileSize(sourceFile);
    if (sourceSize !== byteLength) {
      throw new RuntimeDataSetMergeBlockedError(
        'runtime-data-set-merge-source-cas-invalid', `来源缺少正文文件或长度不符：${row.storage_key}。原数据保持不变。`
      );
    }
    const prefix = path.dirname(targetFile);
    await ensureDirectory(targetCas, path.join(targetCas, 'sha256'), touchedDirectories);
    await ensureDirectory(path.join(targetCas, 'sha256'), prefix, touchedDirectories);
    let copied = false;
    try {
      await link(sourceFile, targetFile);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        if (await regularFileSize(targetFile) !== byteLength) throw error;
      } else if (code === 'EXDEV' || code === 'EPERM' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'EMLINK') {
        await copyIntoCas(targetCas, sourceFile, targetFile);
        copied = true;
      } else {
        throw error;
      }
    }
    touchedDirectories.add(prefix);
    if (await sha256File(targetFile) !== row.sha256) {
      await fs.rm(targetFile, { force: true });
      throw new RuntimeDataSetMergeBlockedError(
        'runtime-data-set-merge-source-cas-invalid', `来源正文文件摘要不符：${row.storage_key}。原数据保持不变。`
      );
    }
    if (copied) result.copiedCasObjects += 1;
    else result.linkedCasObjects += 1;
  }
  for (const directory of touchedDirectories) await syncDirectoryDurably(directory);
  return result;
}

async function copyIntoCas(targetCas: string, sourceFile: string, targetFile: string): Promise<void> {
  const temporaryRoot = path.join(targetCas, 'tmp');
  await fs.mkdir(temporaryRoot, { recursive: true });
  const temporary = path.join(temporaryRoot, `${process.pid}-${randomUUID()}.merge.tmp`);
  try {
    await fs.copyFile(sourceFile, temporary, constants.COPYFILE_EXCL);
    await fs.chmod(temporary, 0o600);
    const handle = await fs.open(temporary, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
    try {
      await fs.link(temporary, targetFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  } finally {
    await fs.rm(temporary, { force: true });
    await syncDirectoryDurably(temporaryRoot);
  }
}

async function mergeRows(
  target: SelectedTarget,
  source: Database.Database,
  beforeCommit: () => Promise<void>
): Promise<{ insertedRows: number; reusedRows: number; insertedConversations: number }> {
  const database = new Database(toSqliteFilePath(target.binding.paths.databasePath), { fileMustExist: true });
  try {
    configureWriterConnection(database);
    assertCurrentSchema(database, target.binding as RootBinding);
    assertRuntimePhysicalSchemaFingerprint(database, RUNTIME_DOMAIN_SCHEMAS);
    const conflicts: string[] = [];
    let conflictCount = 0;
    let insertedRows = 0;
    let reusedRows = 0;
    let insertedConversations = 0;
    database.pragma('foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    try {
      for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
        const columns = schema.columns.map((column) => column.name);
        const list = columns.map((column) => `"${column}"`).join(', ');
        const select = source.prepare(`SELECT ${list} FROM "${schema.table}" ORDER BY id`);
        const find = database.prepare(`SELECT ${list} FROM "${schema.table}" WHERE id = ?`);
        const insert = database.prepare(
          `INSERT INTO "${schema.table}" (${list}) VALUES (${columns.map(() => '?').join(', ')})`
        );
        const allowed = IDENTITY_MERGE_DIFFERENCES.get(schema.key);
        let sourceRows = 0;
        let domainPresent = 0;
        for (const row of select.iterate() as IterableIterator<Record<string, unknown>>) {
          sourceRows += 1;
          const existing = find.get(row.id) as Record<string, unknown> | undefined;
          if (existing) {
            const differences = columns.filter((column) => !sameSqliteValue(row[column], existing[column]));
            if (differences.length === 0 || (allowed && differences.every((column) => allowed.has(column)))) {
              reusedRows += 1;
              domainPresent += 1;
              continue;
            }
            conflictCount += 1;
            if (conflicts.length < MAX_REPORTED_CONFLICTS) {
              conflicts.push(`${schema.key}#${String(row.id)} 字段不同：${differences.join(',')}`);
            }
            continue;
          }
          try {
            insert.run(columns.map((column) => row[column]));
          } catch (error) {
            if (!String((error as { code?: unknown }).code ?? '').startsWith('SQLITE_CONSTRAINT')) throw error;
            conflictCount += 1;
            if (conflicts.length < MAX_REPORTED_CONFLICTS) {
              conflicts.push(`${schema.key}#${String(row.id)} 违反唯一约束：${errorMessage(error)}`);
            }
            continue;
          }
          insertedRows += 1;
          domainPresent += 1;
          if (schema.key === 'Conversation') insertedConversations += 1;
        }
        if (conflictCount === 0 && domainPresent !== sourceRows) {
          throw new RuntimeDataSetMergeError('runtime-data-set-merge-integrity', `${schema.key} 行数核对失败。`);
        }
      }
      if (conflictCount > 0) {
        throw new RuntimeDataSetMergeBlockedError(
          'runtime-data-set-merge-conflict',
          `这份旧聊天记录与当前历史库有 ${conflictCount} 处同一身份但内容不同的数据，整体未合并；原数据保持不变。`
            + `\n${conflicts.join('\n')}`
        );
      }
      const violations = database.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) {
        throw new RuntimeDataSetMergeError(
          'runtime-data-set-merge-integrity', `合并结果有 ${violations.length} 处外键不完整，已回滚。`
        );
      }
      const quickCheck = database.pragma('quick_check') as Array<{ quick_check: string }>;
      if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok') {
        throw new RuntimeDataSetMergeError('runtime-data-set-merge-integrity', '合并结果 quick_check 未通过，已回滚。');
      }
      await beforeCommit();
      database.exec('COMMIT');
    } catch (error) {
      if (database.inTransaction) database.exec('ROLLBACK');
      throw error;
    } finally {
      database.pragma('foreign_keys = ON');
    }
    database.pragma('wal_checkpoint(TRUNCATE)');
    return { insertedRows, reusedRows, insertedConversations };
  } finally {
    database.close();
  }
}

/**
 * Source ids are random or derived from source-only ids, so after an interrupted commit either
 * none or all of them are present. Shared content identities are excluded: they may predate it.
 */
function sourceRowPresence(target: SelectedTarget, source: Database.Database): { present: number; total: number } {
  const database = new Database(toSqliteFilePath(target.binding.paths.databasePath), { readonly: true, fileMustExist: true });
  try {
    database.defaultSafeIntegers(true);
    let present = 0;
    let total = 0;
    for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
      if (IDENTITY_MERGE_DIFFERENCES.has(schema.key)) continue;
      const find = database.prepare(`SELECT 1 FROM "${schema.table}" WHERE id = ?`).pluck();
      for (const id of source.prepare(`SELECT id FROM "${schema.table}"`).pluck().iterate()) {
        total += 1;
        if (find.get(id) !== undefined) present += 1;
      }
    }
    return { present, total };
  } finally {
    database.close();
  }
}

function countSourceRows(source: Database.Database): { rows: number } {
  let rows = 0;
  for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
    rows += Number(source.prepare(`SELECT COUNT(*) FROM "${schema.table}"`).pluck().get() as bigint);
  }
  return { rows };
}

async function ensureTargetBackup(target: SelectedTarget, backup: BatchBackup): Promise<string> {
  if (backup.directoryName) return backup.directoryName;
  const directoryName = `${timestampSlug()}-${randomUUID().slice(0, 8)}`;
  const root = backupRootPath(target, directoryName);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await writeDurableJson(path.join(root, 'root-binding.json'), target.binding);
  const destination = path.join(root, 'limcode.sqlite');
  const temporary = `${destination}.${process.pid}.tmp`;
  const database = new Database(toSqliteFilePath(target.binding.paths.databasePath), { readonly: true, fileMustExist: true });
  try {
    await database.backup(toSqliteFilePath(temporary));
  } catch (error) {
    throw new RuntimeDataSetMergeError('runtime-data-set-merge-backup-failed', '合并前备份当前历史库失败，本次不合并。', error);
  } finally {
    database.close();
  }
  await fs.chmod(temporary, 0o600);
  const copy = new Database(toSqliteFilePath(temporary), { readonly: true, fileMustExist: true });
  try {
    copy.defaultSafeIntegers(true);
    assertCurrentSchema(copy, target.binding as RootBinding);
  } finally {
    copy.close();
    await removeSqliteSidecars(temporary);
  }
  await fs.rename(temporary, destination);
  await syncDirectoryDurably(root);
  await syncDirectoryDurably(path.dirname(root));
  backup.directoryName = directoryName;
  return directoryName;
}

async function requireSelectedTarget(candidate: VscodeRuntimeDataSetCandidate): Promise<SelectedTarget> {
  const binding = await requireCompleteRuntimeDataSet(candidate);
  if (binding.runtimeKernelEpoch !== RUNTIME_KERNEL_EPOCH) {
    throw new RuntimeDataSetMergeError('runtime-data-set-merge-target-unsupported', '当前历史库还不是当前格式，不能接收合并。');
  }
  const controlRoot = path.dirname(path.resolve(binding.paths.dataRootPath));
  if (!isPathBelow(path.resolve(candidate.configurationRootPath), controlRoot)) {
    throw new RuntimeDataSetMergeError('runtime-data-set-merge-target-invalid', '当前历史库路径越出配置根。');
  }
  return {
    candidate,
    binding,
    controlRoot,
    identity: { dataSetId: binding.dataSetId, rootInstanceId: binding.rootInstanceId }
  };
}

async function requireTargetEndpoint(endpoint: RuntimeDataSetMergeEndpoint): Promise<SelectedTarget> {
  const dataRoot = path.resolve(endpoint.binding.paths.dataRootPath);
  return requireSelectedTarget({
    id: 'default',
    configurationRootPath: path.resolve(endpoint.configurationRootPath),
    runtimeScopeRootPath: path.dirname(path.dirname(dataRoot)),
    runtimeDataRootPath: dataRoot,
    dataSetId: endpoint.binding.dataSetId,
    rootInstanceId: endpoint.binding.rootInstanceId,
    runtimeKernelEpoch: endpoint.binding.runtimeKernelEpoch,
    selected: false,
    source: 'fixed'
  });
}

async function sourceFingerprint(candidate: VscodeRuntimeDataSetCandidate): Promise<SourceFingerprint> {
  const binding = await requireCompleteRuntimeDataSet(candidate);
  const database = await fs.stat(binding.paths.databasePath);
  let wal: { size: number; mtimeMs: number } = { size: 0, mtimeMs: 0 };
  try { wal = await fs.stat(`${binding.paths.databasePath}-wal`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return {
    dataSetId: binding.dataSetId,
    rootInstanceId: binding.rootInstanceId,
    rootGeneration: binding.rootGeneration,
    pointerRevision: binding.pointerRevision,
    databaseSize: database.size,
    databaseMtimeMs: database.mtimeMs,
    walSize: wal.size,
    walMtimeMs: wal.mtimeMs
  };
}

function sameFingerprint(left: SourceFingerprint, right: SourceFingerprint | undefined): boolean {
  return right !== undefined && (Object.keys(left) as (keyof SourceFingerprint)[]).every((key) => left[key] === right[key]);
}

async function readMergeRecords(target: SelectedTarget): Promise<Map<string, MergeRecord>> {
  const result = new Map<string, MergeRecord>();
  for (const value of await readAllMergeRecords(target.controlRoot)) {
    if (value.target.dataSetId !== target.identity.dataSetId
      || value.target.rootInstanceId !== target.identity.rootInstanceId) continue;
    result.set(value.candidateId, value);
  }
  return result;
}

interface AutomaticMergeHistory {
  /** Sources already merged elsewhere: into a since deselected data set or before a reset. */
  mergedElsewhere: Set<string>;
  /** Data sets whose current incarnation received merges; never merged away automatically. */
  targets: Set<string>;
}

/**
 * Automatic merge happens at most once per source within one configuration root. After the user
 * switches the current data set or archives and resets it, earlier merges are not repeated (and a
 * former target is not merged away); only an explicit request merges such a data set again.
 */
async function readAutomaticMergeHistory(
  candidates: readonly VscodeRuntimeDataSetCandidate[]
): Promise<AutomaticMergeHistory> {
  const history: AutomaticMergeHistory = { mergedElsewhere: new Set(), targets: new Set() };
  for (const candidate of candidates) {
    if (!candidate.dataSetId) continue;
    const records = await readAllMergeRecords(path.dirname(path.resolve(candidate.runtimeDataRootPath)))
      .catch(() => [] as MergeRecord[]);
    for (const record of records) {
      if (record.state === 'blocked') continue;
      const intoCurrentIncarnation = record.target.dataSetId === candidate.dataSetId
        && record.target.rootInstanceId === candidate.rootInstanceId;
      if (intoCurrentIncarnation) history.targets.add(candidate.id);
      if (candidate.selected && intoCurrentIncarnation) continue;
      history.mergedElsewhere.add(sourceKey(record.candidateId, record.source.dataSetId, record.source.rootInstanceId));
    }
  }
  return history;
}

function sourceKey(candidateId: string, dataSetId: string | undefined, rootInstanceId: string | undefined): string {
  return `${candidateId}\u0000${dataSetId ?? ''}\u0000${rootInstanceId ?? ''}`;
}

async function readAllMergeRecords(controlRoot: string): Promise<MergeRecord[]> {
  const result: MergeRecord[] = [];
  const directory = path.join(controlRoot, RUNTIME_DATA_SET_MERGE_RECORDS_DIRECTORY);
  for (const name of await directoryEntries(directory)) {
    if (!name.endsWith('.json')) continue;
    const value = await readJson(path.join(directory, name)).catch(() => undefined) as MergeRecord | undefined;
    if (!value || value.kind !== MERGE_RECORD_KIND || typeof value.candidateId !== 'string'
      || recordFileName(value.candidateId) !== name || !value.target || !value.source
      || !['committing', 'merged', 'blocked'].includes(value.state)) continue;
    result.push(value);
  }
  return result;
}

async function readMergeRequests(target: SelectedTarget): Promise<Map<string, MergeRequest>> {
  const result = new Map<string, MergeRequest>();
  const directory = path.join(target.controlRoot, RUNTIME_DATA_SET_MERGE_REQUESTS_DIRECTORY);
  for (const name of await directoryEntries(directory)) {
    if (!name.endsWith('.json')) continue;
    const value = await readJson(path.join(directory, name)).catch(() => undefined) as MergeRequest | undefined;
    if (!value || value.kind !== MERGE_REQUEST_KIND || typeof value.candidateId !== 'string'
      || recordFileName(value.candidateId) !== name
      || value.target?.dataSetId !== target.identity.dataSetId
      || value.target?.rootInstanceId !== target.identity.rootInstanceId) continue;
    result.set(value.candidateId, value);
  }
  return result;
}

type MergeRecordBody =
  | { state: 'committing'; source: SourceFingerprint; backupDirectoryName: string }
  | {
    state: 'merged'; source: SourceFingerprint; mergedAt: string; backupDirectoryName: string;
    insertedRows: number; reusedRows: number; insertedConversations: number;
  }
  | { state: 'blocked'; source: SourceFingerprint; code: string; message: string };

async function writeMergeRecord(target: SelectedTarget, candidateId: string, body: MergeRecordBody): Promise<void> {
  const record = {
    kind: MERGE_RECORD_KIND,
    candidateId,
    target: target.identity,
    updatedAt: new Date().toISOString(),
    ...body
  } as MergeRecord;
  await writeDurableJson(
    path.join(target.controlRoot, RUNTIME_DATA_SET_MERGE_RECORDS_DIRECTORY, recordFileName(candidateId)),
    record
  );
}

async function removeMergeRequest(target: SelectedTarget, candidateId: string): Promise<void> {
  const directory = path.join(target.controlRoot, RUNTIME_DATA_SET_MERGE_REQUESTS_DIRECTORY);
  const file = path.join(directory, recordFileName(candidateId));
  try { await fs.rm(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await syncDirectoryDurably(directory);
}

function recordFileName(candidateId: string): string {
  if (!/^(default|workspace:(workspace-file|folder|folder-set|empty)-[a-f0-9]{64})$/.test(candidateId)) {
    throw new RuntimeDataSetMergeError('runtime-data-set-merge-candidate-invalid', `历史库标识无效：${candidateId}`);
  }
  return `${candidateId.replace(':', '-')}.json`;
}

function backupRootPath(target: SelectedTarget, directoryName: string): string {
  return path.join(target.controlRoot, RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY, directoryName);
}

function casPath(casRoot: string, storageKey: string): string {
  const candidate = path.resolve(casRoot, ...storageKey.split('/'));
  if (!isPathBelow(casRoot, candidate)) throw new Error('CAS storage key escapes its root.');
  return candidate;
}

async function ensureDirectory(parent: string, child: string, touched: Set<string>): Promise<void> {
  try {
    await fs.mkdir(child);
    touched.add(parent);
    touched.add(child);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = await fs.lstat(child);
    if (!stat.isDirectory()) throw new Error(`CAS path is not a directory: ${child}`);
  }
}

async function regularFileSize(file: string): Promise<bigint | undefined> {
  let stat;
  try { stat = await fs.lstat(file, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!stat.isFile()) throw new RuntimeDataSetMergeBlockedError('runtime-data-set-merge-source-cas-invalid', `正文路径不是普通文件：${file}`);
  return stat.size;
}

function sameSqliteValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Buffer.isBuffer(left) && Buffer.isBuffer(right)) return left.equals(right);
  return false;
}

async function writeDurableJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  await syncDirectoryDurably(path.dirname(file));
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

async function directoryEntries(directory: string): Promise<string[]> {
  try { return (await fs.readdir(directory)).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function removeSqliteSidecars(file: string): Promise<void> {
  await Promise.all([fs.rm(`${file}-wal`, { force: true }), fs.rm(`${file}-shm`, { force: true })]);
}

async function fault(options: RuntimeDataSetMergeOptions, point: RuntimeDataSetMergeFaultPoint): Promise<void> {
  await options.onFaultPoint?.(point);
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeIssue(error: unknown, candidateId?: string): RuntimeDataSetMergeIssue {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  let code: string | undefined;
  for (let depth = 0; current !== undefined && !seen.has(current) && depth < 8; depth += 1) {
    seen.add(current);
    const record = current && typeof current === 'object' ? current as Record<string, unknown> : undefined;
    if (!code && typeof record?.code === 'string') code = record.code;
    const message = typeof record?.message === 'string' ? record.message : String(current);
    if (messages[messages.length - 1] !== message) messages.push(message);
    current = record?.cause;
  }
  return {
    ...(candidateId !== undefined ? { candidateId } : {}),
    code: code ?? 'runtime-data-set-merge-failed',
    message: messages.join(' → ') || '旧聊天记录合并失败，未获得具体错误信息。'
  };
}
