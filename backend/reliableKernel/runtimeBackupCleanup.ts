import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import { DATA_ROOT_BACKUPS_DIR } from '../capabilities/vscodeStorage/constants';
import {
  createRuntimeRootPaths, ROOT_BINDING_POINTER_FILE, ROOT_BINDING_PENDING_FILE, RUNTIME_CAS_DIRECTORY, RUNTIME_DATABASE_FILE,
  RUNTIME_EPOCH_FILE, type RuntimeRootPaths
} from './contracts';
import { PROCESS_SPOOL_DIRECTORY } from './processProtocol';
import { CUTOVER_BACKUPS_DIRECTORY, CUTOVER_JOURNAL_FILE, CUTOVER_REQUEST_FILE } from './physicalCutover';
import type { RepositoryGetRead } from './repositories';
import { parseHistoricalRootBinding, type HistoricalRootBinding } from './rootAuthority';
import type { RuntimeDatabase } from './runtimeDatabase';
import { comparable } from './runtimeDataSetBulkCopy';
import {
  readRuntimeBackupFacts, readRuntimeCopyFacts, readRuntimeDataSetFacts, runtimeDataSetFileState, type RuntimeDataSetHistoryIds
} from './runtimeDataSetFacts';
import {
  BACKUP_NAME as MERGE_BACKUP_NAME, RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY, RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY
} from './runtimeDataSetMerge';
import { isReadableRuntimeDataSetFingerprint, readRuntimeDataSetMergeLedger, runtimeDataSetFingerprint } from './runtimeDataSetMergeLedger';
import {
  MIGRATION_COMPLETION_KIND, RETIRED_EPOCH_3_TO_4_JOURNAL_FILE, RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY,
  RUNTIME_EPOCH_MIGRATION_COMPLETION_FILE, RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE
} from './runtimeEpochMigration';
import {
  copyForeignRuntimeSqliteFiles, discoverForeignRuntimeHistory, foreignRuntimeHistoryId, ForeignRuntimeHistoryRejection,
  heldDatabaseFiles, inspectForeignRuntimeRoot, listRenamedForeignRuntimeRoots, readForeignRuntimePointerIdentity,
  readLocatedRuntimeFile, tryWithForeignRuntimeRootClaim, type DiscoveredForeignRuntimeRoot, type ForeignRuntimeHistoryEntry,
  type HeldDatabaseFiles
} from './runtimeForeignHistory';
import {
  RUNTIME_HOST_LIVENESS_DIRECTORY, withRuntimeDataRootAdmission, withRuntimeMaintenance, withRuntimeMaintenanceActivity
} from './runtimeHostControl';
import { sameLocatedRuntimeRoot, type LocatedRuntimeRoot } from './runtimeLocatedRoot';
import { assertNoSymbolicPath, requireCompleteRuntimeDataSet } from './runtimeStorageInspection';
import {
  inspectVscodeRuntimeDataSets, resolveVscodeRuntimeMergeLedgerRoot, VSCODE_RUNTIME_ACTIVE_DIRECTORY, VSCODE_RUNTIME_ARCHIVE_NAME_PATTERN,
  VSCODE_RUNTIME_CONTROL_DIRECTORY, VSCODE_WORKSPACE_RUNTIME_SCOPES_DIRECTORY, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY,
  type VscodeRuntimeDataSetCandidate
} from './vscodeRootAuthority';

/**
 * 清理备份 (migration.json#backupCleanup). Deletes only copies whose readable history is proven to
 * exist completely in the local data set of the same control root: every Conversation id and
 * every MessageRevision id of the copy is present there (a revision references its content, and
 * content is never deleted, so its bodies are there too). Conversations are hard-deleted
 * (with their messages); a copy holding one the local data set no longer has is kept as history.
 *
 * Three kinds of backups can be deleted: upgrade backups (epoch-migration-backups/), pre-merge
 * backups of the target (merge-backups/) and source backups before finalization
 * (merge-source-backups/); and foreign history (see "Foreign history" below): verified archives of
 * 归档并重置 and data sets in directories copied aside by a data-root relocation. A copied directory
 * as a whole (its settings, rules and skills), the old-format backups/ of a control root and
 * .limcode-data-backups are only listed. Planning reads the copies without claims
 * (settling leftovers and copying another data set take theirs; the window runs it as a write
 * command, like the deletion); deletion re-verifies everything by the same rules under configuration
 * admission and the control root's maintenance (publishing 清理备份 to waiting windows), renames
 * the copy to `<name>.deleting-<id>`, checks the coverage once more (deleting a Conversation takes
 * no claim) and only then marks it verified and removes it. A leftover of a crash is removed by the
 * next cleanup only when it was verified; otherwise it gets its name back and is checked again.
 * Symbolic links are never followed.
 *
 * POSIX lock rule: the current data set is read only through its own worker reader (`snapshot`);
 * its files are never opened or closed by this process, and neither is any copy or other data set
 * whose database or WAL is the same inode (a hard link) as a local data set's database files (dev:ino
 * compared by stat before anything is copied). Other data sets and the copies are read in the facts
 * worker from private copies (runtimeDataSetFacts), their ids straight from the tables.
 *
 * Foreign history (runtimeForeignHistory): only roots that pass its verification, each deleted as
 * its located control root (a whole archive; in a copied directory only the data set, never the
 * directory with its settings, rules and skills). One is proven when a local data set other than the
 * open one has its identity and exactly its content digest (the open one has no safe digest: its
 * files are not copied), or when every Conversation and MessageRevision id of it and of every backup
 * its control root keeps is in one local data set of this configuration root. Anything else in it
 * (old-format backups/, debug captures, output of a process, an unknown entry, unfinished tasks when
 * proven by coverage) keeps it whole. Its claim (.limcode-runtime-merges/foreign-claims/<id>) is
 * taken without waiting: held by a read-only view that is opening it, its verification or a merge,
 * it is kept. Inside the claim it is located and verified again, and the only writes in a foreign
 * directory are the rename, the verified mark and the removal of the deleted root itself; SQLite
 * files of it are copied only through the foreign copy (dev:ino checks, state before and after).
 */

/** An upgrade backup can be deleted only this long after its upgrade completed. */
export const RUNTIME_BACKUP_CLEANUP_UPGRADE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * A pre-merge backup younger than this may belong to a merge batch still running in another window,
 * which removes it again when no transaction used it; it neither can be deleted nor count as the
 * newest backup that is kept.
 */
export const RUNTIME_BACKUP_CLEANUP_MERGE_BACKUP_MIN_AGE_MS = 60 * 60 * 1000;
/** Ids per read of the current data set's worker reader. */
export const RUNTIME_BACKUP_CLEANUP_READ_BATCH = 250;

export type RuntimeBackupKind =
  | 'epoch-migration' | 'merge-target' | 'merge-source' | 'foreign-history'
  | 'reset-archive' | 'copied-data-root' | 'legacy-cutover' | 'data-backups';

/** Kinds whose copies can be proven and deleted; every other kind is listed only. */
export const RUNTIME_BACKUP_DELETABLE_KINDS: readonly RuntimeBackupKind[] = Object.freeze(['epoch-migration', 'merge-target', 'merge-source', 'foreign-history']);

export interface RuntimeBackupCleanupItem {
  /** Stable for one plan: kind and path relative to the configuration root (or its parent). */
  key: string;
  kind: RuntimeBackupKind;
  name: string;
  path: string;
  /** The data set whose control root holds the copy (the three backup kinds). */
  dataSetCandidateId?: string;
  /** Foreign history: where it comes from, in words (归档, 拷来目录里的库, …). */
  origin?: string;
  /** That data set is the one open in this window (never set for the kinds that are only listed). */
  inCurrentDataSet: boolean;
  /** Logical bytes of every regular file (decimal text). */
  bytes: string;
  /** Without files that have other hard links: deleting those frees nothing. */
  reclaimableBytes: string;
  fileCount: number;
  createdAt?: string;
  deletable: boolean;
  /** Deletable: what proves it; otherwise why it is kept. Never a raw error text. */
  reason: string;
  /** The technical cause behind a reason (for the log), when there is one. */
  detail?: string;
  conversations?: number;
  /** Message versions (MessageRevision rows): an edited message has several. */
  revisions?: number;
  missingConversations?: number;
  missingRevisions?: number;
}

export interface RuntimeBackupCleanupPlan {
  configurationRootPath: string;
  checkedAt: string;
  items: RuntimeBackupCleanupItem[];
  /** Verified `.deleting-*` leftovers of an interrupted cleanup, removed before listing. */
  finishedDeletions: string[];
  /** Leftovers interrupted before their last check: back under their own names, checked again. */
  restoredDeletions: string[];
  /** What could not be listed or settled, in words. */
  problems: string[];
  /** The technical causes behind the problems (for the log). */
  details: string[];
  /** The data directories this installation left, looked in for foreign history (see ForeignRuntimeHistoryInput). */
  previousDataRootPaths?: readonly string[];
}

export interface RuntimeBackupCleanupResult {
  deleted: Array<{ key: string; name: string; path: string; bytes: string; reclaimableBytes: string }>;
  kept: Array<{ key: string; name: string; path: string; reason: string; detail?: string }>;
  /** Verified and renamed for deletion, but not removed completely; the next cleanup finishes them. */
  unfinished: Array<{ key: string; name: string; path: string; reason: string; detail?: string }>;
  /** Copied data directories that hold no data set any more after this deletion; the rest of them stays. */
  copiedDirectoriesWithoutDataSets: Array<{ name: string; path: string }>;
}

/** The data set open in this window: its binding and its worker reader. */
export type RuntimeBackupCleanupCurrent = Pick<RuntimeDatabase, 'binding' | 'snapshot'>;

export type RuntimeBackupCleanupFaultPoint = 'before-rename' | 'after-rename' | 'after-verify';

export interface RuntimeBackupCleanupOptions {
  onProgress?(message: string): void;
  /** The clock of the age rules (tests). */
  now?(): number;
  /** The data directories this installation left (see ForeignRuntimeHistoryInput): their archives and the directories copied aside beside them are foreign history too. */
  previousDataRootPaths?: readonly string[];
}

export interface RuntimeBackupDeletionOptions extends RuntimeBackupCleanupOptions {
  onFaultPoint?(point: RuntimeBackupCleanupFaultPoint, key: string): Promise<void> | void;
}

type StoragePaths = { globalStoragePath: string };

const RESET_ARCHIVES_DIRECTORY = '.limcode-runtime-backups';
const COPIED_ASIDE_MARKER = '.limcode-copied-';
const DELETING_MARKER = '.deleting-';
const DELETING_NAME = /^(.+)\.deleting-[0-9a-f]{16}$/;
/** Written into a renamed copy once its coverage was checked again after the rename. */
const VERIFIED_MARKER_FILE = '.limcode-backup-cleanup-verified';
const VERIFIED_MARKER_KIND = 'limcode-backup-cleanup-verified';
const EPOCH_BACKUP_NAME = /^[0-9TZ-]+-[a-f0-9]{8}$/;
const COVERAGE_DIRECTORY = 'coverage';
const COVERAGE_KIND = 'limcode-runtime-backup-coverage-ids';
const FINALIZATIONS_DIRECTORY = 'finalizations';
const CURRENT_LABEL = '当前库';
/** Files whose presence in a control root means an operation on it has not finished, and what it is. */
const IN_PROGRESS_FILES: ReadonlyArray<readonly [file: string, operation: string]> = Object.freeze([
  [ROOT_BINDING_PENDING_FILE, '未完成的历史库切换'],
  [RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE, '未完成的升级'],
  [RETIRED_EPOCH_3_TO_4_JOURNAL_FILE, '旧版本未完成的 3→4 升级'],
  [CUTOVER_REQUEST_FILE, '未完成的旧格式数据切换'],
  [CUTOVER_JOURNAL_FILE, '未完成的旧格式数据切换']
] as const);
const DELETABLE_DIRECTORIES: Readonly<Record<'epoch-migration' | 'merge-target' | 'merge-source', string>> = Object.freeze({
  'epoch-migration': RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY,
  'merge-target': RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY,
  'merge-source': RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY
});
type DeletableKind = keyof typeof DELETABLE_DIRECTORIES;
const ACTIVITY = { operation: 'backup-cleanup', description: '清理备份' } as const;
/** The backup directories of a control root, in the order they are listed. */
const LOCAL_BACKUP_KINDS: readonly DeletableKind[] = Object.freeze(['epoch-migration', 'merge-target', 'merge-source']);
const BACKUP_LABELS: Readonly<Record<DeletableKind, string>> = Object.freeze({
  'epoch-migration': '升级前备份', 'merge-target': '合并前备份', 'merge-source': '合并来源的收尾前备份'
});
const ARCHIVE_NAME = new RegExp(`^${VSCODE_RUNTIME_ARCHIVE_NAME_PATTERN}$`);
const FOREIGN_KEY_PREFIX = 'foreign-history:';
const COPIED_REST = '其余内容（设置、规则、技能）保留，可自行处理';
const FOREIGN_BUSY = '正在被只读查看、核验或合并（另一个窗口或操作正在用它）';
/** A foreign root's own small records read here (completion records, saved bindings). */
const MAX_FOREIGN_RECORD_BYTES = 4 * 1024 * 1024;
/** Files LimCode keeps in a control root beside the pointer (bookkeeping deleted with the data set). */
const FOREIGN_CONTROL_ROOT_FILES: ReadonlySet<string> = new Set([
  ROOT_BINDING_POINTER_FILE, 'owner.json', 'kept-by-user.json', 'cutover-completion.json'
]);
/**
 * The data set itself and LimCode's own runtime files in its data root: database, content, epoch
 * manifest, Host liveness, conversation owners (ConversationRuntimeOwnerManager), exclusive
 * maintenance requests (runtimeExclusiveMaintenance) and the diagnostic journal. An empty process
 * spool too; debug captures are not (a person made them).
 */
const FOREIGN_DATA_ROOT_ENTRIES: ReadonlySet<string> = new Set([
  RUNTIME_DATABASE_FILE, `${RUNTIME_DATABASE_FILE}-wal`, `${RUNTIME_DATABASE_FILE}-shm`, `${RUNTIME_DATABASE_FILE}-journal`,
  RUNTIME_CAS_DIRECTORY, RUNTIME_EPOCH_FILE, RUNTIME_HOST_LIVENESS_DIRECTORY, 'conversation-owners', 'exclusive-maintenance', 'diagnostics'
]);
const DEBUG_CAPTURES_PATH: readonly string[] = ['diagnostics', 'debug-captures'];

interface TreeFacts {
  /** Every entry's name, type and exact file state: any change of the copy changes it. */
  digest: string;
  bytes: bigint;
  reclaimableBytes: bigint;
  fileCount: number;
  symbolicLink: boolean;
  unsupported: boolean;
  temporary: boolean;
  /** Last modification of the directory itself (an entry added, renamed or removed). */
  modifiedAt: number;
}

interface LocalIds {
  files: string;
  conversations: ReadonlySet<string>;
  messageRevisions: ReadonlySet<string>;
}

interface LocalDataSet {
  candidate: VscodeRuntimeDataSetCandidate;
  binding: HistoricalRootBinding;
  current: boolean;
  ids?: LocalIds;
  /** Its content digest for exactly these files (runtimeDataSetFingerprint); never for the open one. */
  digest?: { files: string; digest: string };
}

interface ControlRoot {
  scopeRootPath: string;
  controlRootPath: string;
  paths: RuntimeRootPaths;
  candidateId?: string;
  local?: LocalDataSet;
  /** Why nothing here can be proven (no readable local data set, a hard link of the current one, …). */
  unavailable?: string;
  unavailableDetail?: string;
  /** Unfinished operations in this control root (their files), in words. */
  inProgress: string[];
}

/**
 * dev:ino of the database, WAL and shared memory of the current data set and of every local data set,
 * and whose files they are ('当前库' or '历史库（id）'). Taken with stat only: no descriptor is opened.
 */
type DatabaseFiles = ReadonlyMap<string, string>;

interface ControlRoots {
  roots: ControlRoot[];
  databaseFiles: DatabaseFiles;
}

/** A reason already in words for the user (anything else thrown is described, never shown raw). */
class CleanupRefusal extends Error {}

interface LedgerFacts {
  /** Data sets (dataSetId:rootInstanceId) with a merge transaction in flight, as source or target. */
  committing: ReadonlySet<string>;
  /** The merge records could not be read: a merge in flight cannot be ruled out. */
  recordsUnreadable: boolean;
  finalizationBackups: ReadonlySet<string>;
  finalizationsUnreadable: boolean;
}

/** Everything a deletion re-verifies; kept in this process only, never shown or serialized. */
interface BackupProof {
  item: RuntimeBackupCleanupItem;
  kind: DeletableKind;
  controlRootPath: string;
  candidateId: string;
  tree: string;
  binding: HistoricalRootBinding;
  current: boolean;
  backupIds: RuntimeDataSetHistoryIds;
  local?: LocalIds;
}

interface Evaluation {
  item: RuntimeBackupCleanupItem;
  proof?: BackupProof;
}

type RemovalOutcome =
  | { state: 'deleted' }
  | { state: 'kept'; reason: string; detail?: string }
  | { state: 'unfinished'; reason: string; detail?: string };

/** Everything a deletion of a foreign root re-verifies; kept in this process only. */
interface ForeignProof {
  item: RuntimeBackupCleanupItem;
  found: DiscoveredForeignRuntimeRoot;
  root: LocatedRuntimeRoot;
  /** The located control root: the directory that is deleted. */
  unit: string;
  tree: string;
  method: 'identical' | 'coverage';
  contentDigest?: string;
  /** The local data set it is proven against, and its files as they were read (not the open one's). */
  by: { candidateId: string; binding: HistoricalRootBinding; current: boolean; files?: string };
  /** Every id that must stay covered: its own (coverage) and those of the backups it keeps. */
  ids: RuntimeDataSetHistoryIds;
  /** A data set of a copied directory: that directory (told when no data set is left in it). */
  copiedDirectory?: string;
}

const PROOFS = new WeakMap<RuntimeBackupCleanupPlan, ReadonlyMap<string, BackupProof>>();
const FOREIGN_PROOFS = new WeakMap<RuntimeBackupCleanupPlan, ReadonlyMap<string, ForeignProof>>();

/**
 * Lists every backup of the configuration root with its size and conclusion. Nothing is deleted
 * except `.deleting-*` leftovers verified by an earlier, already confirmed deletion.
 */
export async function planRuntimeBackupCleanup(
  configurationRootPathInput: string,
  current: RuntimeBackupCleanupCurrent,
  options: RuntimeBackupCleanupOptions = {}
): Promise<RuntimeBackupCleanupPlan> {
  const configurationRootPath = path.resolve(configurationRootPathInput);
  const previousDataRootPaths = options.previousDataRootPaths?.length ? [...options.previousDataRootPaths] : undefined;
  const now = options.now ?? Date.now;
  const report = options.onProgress ?? (() => undefined);
  const problems: string[] = [];
  const details: string[] = [];
  const problem = (text: string, error?: unknown) => {
    problems.push(text);
    if (error !== undefined) details.push(`${text} ${errorMessage(error)}`);
  };
  report('正在列出历史库…');
  let { roots, databaseFiles } = await listControlRoots(configurationRootPath, current, problem);
  report('正在收尾上次没有删完的备份…');
  const leftovers = await settleInterruptedDeletions(configurationRootPath, roots, problem, { previousDataRootPaths, databaseFiles });
  if (leftovers.restored.length > 0) ({ roots, databaseFiles } = await listControlRoots(configurationRootPath, current, () => undefined));
  const ledger = await readLedgerFacts(configurationRootPath);
  const items: RuntimeBackupCleanupItem[] = [];
  const proofs = new Map<string, BackupProof>();
  const foreignProofs = new Map<string, ForeignProof>();
  const cache = new CoverageCache(configurationRootPath);
  report('正在列出外来历史库…');
  let found: DiscoveredForeignRuntimeRoot[] = [];
  try {
    found = await discoverForeignRuntimeHistory({ configurationRootPath, ...(previousDataRootPaths ? { previousDataRootPaths } : {}) });
  } catch (error) {
    problem('外来历史库（归档、拷来目录里的库）没有全部列出，没有列出的都保留。', error);
  }
  // Listed as foreign history (each with its own conclusion), never again as a listed-only entry.
  const handled = new Set(found.map((entry) => comparable(foreignListedPath(entry.location))));
  const copiedDirectories = new Set(found.filter((entry) => entry.location.kind === 'copied').map((entry) => comparable(entry.location.containerPath)));
  for (const root of roots) {
    try {
      for (const kind of LOCAL_BACKUP_KINDS) {
        for (const entry of await listBackupEntries(configurationRootPath, root, kind)) {
          report(`正在核对 ${entry.name}…`);
          const evaluation = await evaluateBackup({
            configurationRootPath, root, kind, entry, ledger, current, cache, databaseFiles, now: now()
          });
          items.push(evaluation.item);
          if (evaluation.proof) proofs.set(evaluation.item.key, evaluation.proof);
        }
      }
      report('正在统计只列出的备份…');
      items.push(...await listKeptBackups(configurationRootPath, root, handled));
    } catch (error) {
      problem(`${root.controlRootPath} 里的备份没有全部列出。`, error);
    }
  }
  try {
    items.push(...await planForeignHistory({ configurationRootPath, current, roots, databaseFiles, cache, now: now(), report }, found, foreignProofs));
  } catch (error) {
    problem('外来历史库（归档、拷来目录里的库）没有全部核对，没有核对的都保留。', error);
  }
  try {
    items.push(...await listConfigurationLevelBackups(configurationRootPath, copiedDirectories));
  } catch (error) {
    problem('数据目录里和旁边的旧备份没有全部列出。', error);
  }
  await cache.prune();
  const plan: RuntimeBackupCleanupPlan = {
    configurationRootPath, checkedAt: new Date(now()).toISOString(), items,
    finishedDeletions: leftovers.finished, restoredDeletions: leftovers.restored, problems, details,
    ...(previousDataRootPaths ? { previousDataRootPaths } : {})
  };
  PROOFS.set(plan, proofs);
  FOREIGN_PROOFS.set(plan, foreignProofs);
  return plan;
}

/**
 * Deletes the confirmed copies of a plan of this process. Each one is verified again under the
 * configuration admission and its control root's maintenance (published as 清理备份 to waiting
 * windows): the copy is exactly as listed and is not a hard link of a local database, the local
 * data set has the same identity and generation, no operation is in progress, the newest pre-merge
 * backup stays, and its history is still covered. After the rename the coverage is checked once
 * more; a copy that is no longer covered gets its name back. Anything else keeps the copy. A
 * foreign root is deleted under the admission and its own foreign claim, taken without waiting
 * (see deleteForeignRoot).
 */
export async function deleteRuntimeBackups(
  plan: RuntimeBackupCleanupPlan,
  current: RuntimeBackupCleanupCurrent,
  keys: readonly string[],
  options: RuntimeBackupDeletionOptions = {}
): Promise<RuntimeBackupCleanupResult> {
  const proofs = PROOFS.get(plan);
  const foreignProofs = FOREIGN_PROOFS.get(plan);
  if (!proofs || !foreignProofs) throw new Error('这份备份清单不是本窗口刚才核对的结果，请重新检查。');
  const configurationRootPath = plan.configurationRootPath;
  const now = options.now ?? Date.now;
  const result: RuntimeBackupCleanupResult = { deleted: [], kept: [], unfinished: [], copiedDirectoriesWithoutDataSets: [] };
  const selected: BackupProof[] = [];
  const selectedForeign: ForeignProof[] = [];
  for (const key of new Set(keys)) {
    const proof = proofs.get(key);
    const foreign = foreignProofs.get(key);
    const item = plan.items.find((entry) => entry.key === key);
    if ((!proof && !foreign) || !item?.deletable) {
      if (item) result.kept.push({ key, name: item.name, path: item.path, reason: '不在可以删除的清单里' });
      continue;
    }
    if (proof) selected.push(proof);
    else selectedForeign.push(foreign!);
  }
  if (selected.length + selectedForeign.length === 0) return result;
  const byRoot = new Map<string, BackupProof[]>();
  for (const proof of selected) {
    const group = byRoot.get(comparable(proof.controlRootPath)) ?? [];
    group.push(proof);
    byRoot.set(comparable(proof.controlRootPath), group);
  }
  const total = selected.length + selectedForeign.length;
  let started = 0;
  const stage = () => `正在删除第 ${Math.max(started, 1)}/${total} 份备份`;
  // Published in the admission as well as in each maintenance claim: a window waiting to open sees
  // why (清理备份) for as long as the deletion holds either.
  await withRuntimeDataRootAdmission(configurationRootPath, () => withRuntimeMaintenanceActivity({
    ...ACTIVITY, stage: stage()
  }, async (admission) => {
    const cache = new CoverageCache(configurationRootPath);
    for (const group of byRoot.values()) {
      const controlRootPath = group[0].controlRootPath;
      const paths = createRuntimeRootPaths(path.join(controlRootPath, VSCODE_RUNTIME_ACTIVE_DIRECTORY));
      await withRuntimeMaintenance(paths, () => withRuntimeMaintenanceActivity({ ...ACTIVITY, stage: stage() }, async (activity) => {
        const { roots, databaseFiles } = await listControlRoots(configurationRootPath, current, () => undefined);
        const root = roots.find((entry) => comparable(entry.controlRootPath) === comparable(controlRootPath));
        const ledger = await readLedgerFacts(configurationRootPath);
        for (const proof of group) {
          started += 1;
          activity.report(stage());
          const keep = (reason: string, detail?: string) => result.kept.push({
            key: proof.item.key, name: proof.item.name, path: proof.item.path, reason, ...(detail ? { detail } : {})
          });
          if (!root) { keep('所在历史库已不在原处，这一项没有删除'); continue; }
          const entry = await backupEntry(configurationRootPath, root, proof.kind, proof.item.name);
          if (!entry) { keep('已经不在原处（可能已被其它操作删除）'); continue; }
          const evaluation = await evaluateBackup({
            configurationRootPath, root, kind: proof.kind, entry, ledger, current, cache, databaseFiles, now: now(), known: proof
          });
          if (!evaluation.proof) { keep(`${evaluation.item.reason}；这一项没有删除`, evaluation.item.detail); continue; }
          try {
            await options.onFaultPoint?.('before-rename', proof.item.key);
          } catch (error) {
            keep('没有删除', errorMessage(error));
            continue;
          }
          const outcome = await removeBackupDirectory(entry.path, {
            afterRename: () => options.onFaultPoint?.('after-rename', proof.item.key),
            afterVerify: () => options.onFaultPoint?.('after-verify', proof.item.key),
            stillCovered: () => stillCovered(root, proof, current)
          });
          if (outcome.state === 'deleted') {
            result.deleted.push({
              key: proof.item.key, name: proof.item.name, path: proof.item.path,
              bytes: proof.item.bytes, reclaimableBytes: proof.item.reclaimableBytes
            });
            await cache.remove(backupSubject(configurationRootPath, entry.path));
          } else if (outcome.state === 'unfinished') {
            result.unfinished.push({
              key: proof.item.key, name: proof.item.name, path: proof.item.path, reason: outcome.reason,
              ...(outcome.detail ? { detail: outcome.detail } : {})
            });
          } else {
            keep(outcome.reason, outcome.detail);
          }
        }
      }));
      // Leaving the maintenance claim also took the marker out of the admission: publish it again.
      admission.report(`已处理 ${started}/${total} 份备份`);
    }
    const emptied = new Map<string, string>();
    for (const proof of selectedForeign) {
      started += 1;
      admission.report(stage());
      const keep = (reason: string, detail?: string) => result.kept.push({
        key: proof.item.key, name: proof.item.name, path: proof.item.path, reason, ...(detail ? { detail } : {})
      });
      let outcome: RemovalOutcome;
      try {
        // Never waited for: a read-only view that is opening it, its verification or a merge keeps it.
        const claimed = await tryWithForeignRuntimeRootClaim(configurationRootPath, proof.root.id, proof.root.located.rootPointerPath,
          () => withRuntimeMaintenanceActivity({ ...ACTIVITY, stage: stage() },
            () => deleteForeignRoot(proof, { configurationRootPath, current, options })));
        outcome = claimed.acquired ? claimed.value : { state: 'kept', reason: `${FOREIGN_BUSY}，这一项没有删除` };
      } catch (error) {
        outcome = { state: 'kept', reason: '没有删除：再次核对时出错', detail: errorMessage(error) };
      }
      if (outcome.state === 'deleted') {
        result.deleted.push({
          key: proof.item.key, name: proof.item.name, path: proof.item.path,
          bytes: proof.item.bytes, reclaimableBytes: proof.item.reclaimableBytes
        });
        await cache.remove(foreignSubject(proof.root.id));
        if (proof.copiedDirectory) emptied.set(comparable(proof.copiedDirectory), proof.copiedDirectory);
      } else if (outcome.state === 'unfinished') {
        result.unfinished.push({
          key: proof.item.key, name: proof.item.name, path: proof.item.path, reason: outcome.reason,
          ...(outcome.detail ? { detail: outcome.detail } : {})
        });
      } else {
        keep(outcome.reason, outcome.detail);
      }
      admission.report(`已处理 ${started}/${total} 份备份`);
    }
    if (emptied.size > 0) {
      // A copied directory is never deleted as a whole: once no data set is left, the rest is the user's.
      const remaining = await discoverForeignRuntimeHistory({
        configurationRootPath, ...(plan.previousDataRootPaths?.length ? { previousDataRootPaths: plan.previousDataRootPaths } : {})
      }).catch(() => undefined);
      for (const [key, directory] of emptied) {
        if (remaining && !remaining.some((entry) => comparable(entry.location.containerPath) === key && hasDataRoot(entry.location))) {
          result.copiedDirectoriesWithoutDataSets.push({ name: path.basename(directory), path: directory });
        }
      }
    }
  }));
  return result;
}

// ---------------------------------------------------------------------------------------------
// Control roots and their local data sets

async function listControlRoots(
  configurationRootPath: string,
  current: RuntimeBackupCleanupCurrent,
  problem: (text: string, error?: unknown) => void
): Promise<ControlRoots> {
  const roots = new Map<string, ControlRoot>();
  const add = (scopeRootPath: string): ControlRoot => {
    const controlRootPath = path.join(scopeRootPath, VSCODE_RUNTIME_CONTROL_DIRECTORY);
    const key = comparable(controlRootPath);
    let root = roots.get(key);
    if (!root) {
      root = {
        scopeRootPath, controlRootPath, inProgress: [],
        paths: createRuntimeRootPaths(path.join(controlRootPath, VSCODE_RUNTIME_ACTIVE_DIRECTORY))
      };
      roots.set(key, root);
    }
    return root;
  };
  add(configurationRootPath);
  const scopes = path.join(configurationRootPath, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, VSCODE_WORKSPACE_RUNTIME_SCOPES_DIRECTORY);
  for (const name of await readDirectoryNames(scopes)) {
    const scope = path.join(scopes, name);
    const info = await lstatOrUndefined(scope);
    if (info?.isDirectory()) add(scope);
  }
  let inspection: Awaited<ReturnType<typeof inspectVscodeRuntimeDataSets>> | undefined;
  try {
    inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: configurationRootPath });
  } catch (error) {
    problem('历史库列表无法读取，所有备份都按历史保留。', error);
  }
  for (const entry of inspection?.problems ?? []) {
    const root = add(entry.runtimeScopeRootPath);
    root.candidateId = entry.id;
    root.unavailable = '所在历史库无法读取，无法核对，按历史保留';
    root.unavailableDetail = entry.message;
  }
  // Whose database files are which inodes, before anything is copied: a hard link of a database
  // this process may hold open (the current one, or another one a merge of this window holds) is
  // never opened or closed by this process.
  const databaseFiles = new Map<string, string>();
  for (const identity of await fileIdentities(current.binding.paths.databasePath)) databaseFiles.set(identity, CURRENT_LABEL);
  const candidateFiles = new Map<string, Set<string>>();
  for (const candidate of inspection?.candidates ?? []) {
    if (!candidate.dataSetId) continue;
    const identities = await fileIdentities(createRuntimeRootPaths(candidate.runtimeDataRootPath).databasePath);
    candidateFiles.set(candidate.id, identities);
    for (const identity of identities) if (!databaseFiles.has(identity)) databaseFiles.set(identity, `历史库（${candidate.id}）`);
  }
  const currentFiles = new Set([...databaseFiles].filter(([, owner]) => owner === CURRENT_LABEL).map(([identity]) => identity));
  for (const candidate of inspection?.candidates ?? []) {
    const root = add(candidate.runtimeScopeRootPath);
    root.candidateId = candidate.id;
    if (comparable(path.dirname(candidate.runtimeDataRootPath)) !== comparable(root.controlRootPath)) {
      root.unavailable = '历史库的位置与目录不一致，按历史保留';
    } else if (candidate.requiresRecovery) {
      root.unavailable = '所在历史库有未完成的切换，打开它完成恢复之后再清理';
    } else if (!candidate.dataSetId) {
      root.unavailable = '所在位置没有已初始化的历史库，无法核对';
    } else {
      try {
        const binding = await requireCompleteRuntimeDataSet(candidate);
        const samePlace = comparable(binding.paths.databasePath) === comparable(current.binding.paths.databasePath);
        const own = [...candidateFiles.get(candidate.id) ?? []];
        const linkedTo = samePlace ? undefined
          : own.some((identity) => currentFiles.has(identity)) ? CURRENT_LABEL
            : [...candidateFiles].find(([id, files]) => id !== candidate.id && own.some((identity) => files.has(identity)))?.[0];
        if (samePlace && !sameBinding(binding, current.binding)) {
          root.unavailable = '这个库与本窗口打开的当前库记录不一致，暂不清理';
        } else if (linkedTo === CURRENT_LABEL) {
          root.unavailable = '所在历史库和当前库是同一个文件（硬链接）；为了不破坏当前库的锁，不读取它，按历史保留';
        } else if (linkedTo) {
          root.unavailable = `所在历史库和另一个历史库（${linkedTo}）是同一个文件（硬链接），不读取它，按历史保留`;
        } else {
          root.local = { candidate, binding, current: samePlace };
        }
      } catch (error) {
        root.unavailable = '所在历史库无法读取，无法核对，按历史保留';
        root.unavailableDetail = errorMessage(error);
      }
    }
  }
  for (const root of roots.values()) {
    if (!root.local && !root.unavailable) root.unavailable = '所在位置没有可以核对的历史库';
    for (const [file, operation] of IN_PROGRESS_FILES) {
      if (await lstatOrUndefined(path.join(root.controlRootPath, file)) && !root.inProgress.includes(operation)) root.inProgress.push(operation);
    }
  }
  return { roots: [...roots.values()], databaseFiles };
}

/** dev:ino of a database, its WAL and shared memory (stat only: no descriptor is opened). */
async function fileIdentities(databasePath: string, suffixes: readonly string[] = ['', '-wal', '-shm']): Promise<Set<string>> {
  const result = new Set<string>();
  for (const suffix of suffixes) {
    const stat = await fs.stat(`${databasePath}${suffix}`, { bigint: true }).catch(() => undefined);
    if (stat) result.add(`${stat.dev}:${stat.ino}`);
  }
  return result;
}

/** Whose database a copy's SQLite file or WAL (what a private copy would read) is a hard link of, if anyone's. */
async function hardLinkedDatabase(databasePath: string, files: DatabaseFiles): Promise<string | undefined> {
  for (const identity of await fileIdentities(databasePath, ['', '-wal'])) {
    const owner = files.get(identity);
    if (owner) return owner;
  }
  return undefined;
}

function inProgressOperations(root: ControlRoot, ledger: LedgerFacts): string[] {
  const found = [...root.inProgress];
  if (ledger.recordsUnreadable) found.push('合并记录无法读取');
  else if (root.local && ledger.committing.has(identityKey(root.local.binding))) found.push('正在提交的合并');
  return found;
}

async function readLedgerFacts(configurationRootPath: string): Promise<LedgerFacts> {
  const paths: StoragePaths = { globalStoragePath: configurationRootPath };
  const committing = new Set<string>();
  let recordsUnreadable = false;
  try {
    for (const record of (await readRuntimeDataSetMergeLedger(paths)).values()) {
      if (record.state !== 'committing') continue;
      committing.add(identityKey(record.source));
      committing.add(identityKey(record.target));
    }
  } catch {
    recordsUnreadable = true;
  }
  const finalizationBackups = new Set<string>();
  let finalizationsUnreadable = false;
  const directory = path.join(resolveVscodeRuntimeMergeLedgerRoot(paths), FINALIZATIONS_DIRECTORY);
  try {
    await assertNoSymbolicPrefix(configurationRootPath, directory);
    for (const name of await readDirectoryNames(directory)) {
      if (!name.endsWith('.json')) continue;
      try {
        const value = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')) as { sourceBackupPath?: unknown } | null;
        if (typeof value?.sourceBackupPath === 'string') finalizationBackups.add(comparable(value.sourceBackupPath));
        else finalizationsUnreadable = true;
      } catch {
        finalizationsUnreadable = true;
      }
    }
  } catch {
    finalizationsUnreadable = true;
  }
  return { committing, recordsUnreadable, finalizationBackups, finalizationsUnreadable };
}

// ---------------------------------------------------------------------------------------------
// The three kinds that can be proven

interface BackupEntry {
  name: string;
  path: string;
  /** Why it is not a copy of this kind at all (a link, a file, an unknown name). */
  foreign?: string;
}

async function listBackupEntries(configurationRootPath: string, root: ControlRoot, kind: DeletableKind): Promise<BackupEntry[]> {
  const directory = path.join(root.controlRootPath, DELETABLE_DIRECTORIES[kind]);
  const info = await lstatOrUndefined(directory);
  if (!info) return [];
  try {
    await assertNoSymbolicPath(configurationRootPath, directory);
  } catch {
    return [{ name: DELETABLE_DIRECTORIES[kind], path: directory, foreign: '目录路径里有符号链接，不跟随也不删除' }];
  }
  if (!info.isDirectory()) return [{ name: DELETABLE_DIRECTORIES[kind], path: directory, foreign: '不是目录，不处理' }];
  const entries: BackupEntry[] = [];
  for (const name of (await readDirectoryNames(directory)).sort()) {
    if (DELETING_NAME.test(name)) continue;
    const entry = await backupEntry(configurationRootPath, root, kind, name);
    if (entry) entries.push(entry);
  }
  return entries;
}

async function backupEntry(configurationRootPath: string, root: ControlRoot, kind: DeletableKind, name: string): Promise<BackupEntry | undefined> {
  const entryPath = path.join(root.controlRootPath, DELETABLE_DIRECTORIES[kind], name);
  const info = await lstatOrUndefined(entryPath);
  if (!info) return undefined;
  if (info.isSymbolicLink()) return { name, path: entryPath, foreign: '是符号链接，不跟随也不删除' };
  try {
    await assertNoSymbolicPath(configurationRootPath, entryPath);
  } catch {
    return { name, path: entryPath, foreign: '路径里有符号链接，不跟随也不删除' };
  }
  if (!info.isDirectory()) return { name, path: entryPath, foreign: '不是备份目录，不处理' };
  const known = kind === 'epoch-migration' ? EPOCH_BACKUP_NAME.test(name) : MERGE_BACKUP_NAME.test(name);
  if (!known) return { name, path: entryPath, foreign: '不认识的目录名，不处理' };
  return { name, path: entryPath };
}

interface EvaluationInput {
  configurationRootPath: string;
  root: ControlRoot;
  kind: DeletableKind;
  entry: BackupEntry;
  ledger: LedgerFacts;
  current: RuntimeBackupCleanupCurrent;
  cache: CoverageCache;
  databaseFiles: DatabaseFiles;
  now: number;
  /** The proof of the listing, when re-verifying for deletion. */
  known?: BackupProof;
}

async function evaluateBackup(input: EvaluationInput): Promise<Evaluation> {
  const { configurationRootPath, root, kind, entry, now } = input;
  const tree = entry.foreign ? undefined : await describeTree(entry.path).catch(() => undefined);
  const item: RuntimeBackupCleanupItem = {
    key: itemKey(kind, configurationRootPath, entry.path),
    kind, name: entry.name, path: entry.path,
    ...(root.candidateId ? { dataSetCandidateId: root.candidateId } : {}),
    inCurrentDataSet: root.local?.current === true,
    bytes: (tree?.bytes ?? 0n).toString(),
    reclaimableBytes: (tree?.reclaimableBytes ?? 0n).toString(),
    fileCount: tree?.fileCount ?? 0,
    deletable: false,
    reason: ''
  };
  const createdAt = backupCreatedAt(kind, entry.name);
  if (createdAt !== undefined) item.createdAt = new Date(createdAt).toISOString();
  const keep = (reason: string, detail?: string): Evaluation => ({ item: { ...item, reason, ...(detail ? { detail } : {}) } });
  if (entry.foreign) return keep(entry.foreign);
  if (!tree) return keep('无法读取这个目录，按历史保留');
  if (input.known && tree.digest !== input.known.tree) return keep('列出之后这份备份有变化，请重新检查');
  if (tree.symbolicLink) return keep('目录里有符号链接，不跟随也不删除');
  if (tree.unsupported) return keep('目录里有无法识别的文件类型，不处理');
  const operations = inProgressOperations(root, input.ledger);
  if (operations.length > 0) return keep(`有进行中的操作（${operations.join('、')}），完成之后再清理`);
  const local = root.local;
  if (!local) return keep(root.unavailable ?? '所在位置没有可以核对的历史库', root.unavailableDetail);
  if (input.known && (!sameBinding(local.binding, input.known.binding) || local.current !== input.known.current)) {
    return keep('所在历史库在检查之后发生了变化，请重新检查');
  }

  let recorded: HistoricalRootBinding;
  let databasePath: string;
  let backupBinding: HistoricalRootBinding;
  if (kind === 'epoch-migration') {
    const completion = await readUpgradeCompletion(entry.path);
    if (typeof completion === 'string') return keep(completion);
    // The latest of every time the upgrade left behind (its record, the directory name, the record
    // file's mtime and ctime): a clock that was behind then, or is ahead now, gains nothing.
    const completedAt = Math.max(completion.completedAt, createdAt ?? 0, completion.recordedAt);
    if (completedAt > now) return keep('升级完成的时间晚于现在，时间不可信，按历史保留');
    if (now - completedAt < RUNTIME_BACKUP_CLEANUP_UPGRADE_GRACE_MS) {
      const after = new Date(completedAt + RUNTIME_BACKUP_CLEANUP_UPGRADE_GRACE_MS).toISOString();
      return keep(`升级完成不满 7 天，${after} 之后才可以删除`);
    }
    recorded = completion.nextBinding;
    backupBinding = completion.previousBinding;
    databasePath = path.join(entry.path, `limcode.epoch-${completion.fromEpoch}.sqlite`);
  } else {
    if (tree.temporary) return keep('备份还没有写完（目录里有临时文件），保留');
    if (kind === 'merge-target') {
      if (now - backupTime(createdAt, tree.modifiedAt, now) < RUNTIME_BACKUP_CLEANUP_MERGE_BACKUP_MIN_AGE_MS) {
        return keep('创建不满 1 小时，可能正被合并使用，保留');
      }
      const protection = await newestMergeBackupProtection(root, entry.name, now);
      if (protection) return keep(protection);
    } else {
      if (input.ledger.finalizationsUnreadable) return keep('合并收尾记录无法读取，不能确认它没有被引用，保留');
      if (input.ledger.finalizationBackups.has(comparable(entry.path))) return keep('被尚未报告的合并收尾记录引用，保留');
    }
    const saved = await readBindingFile(path.join(entry.path, ROOT_BINDING_POINTER_FILE));
    if (typeof saved === 'string') return keep(saved);
    recorded = saved;
    backupBinding = saved;
    databasePath = path.join(entry.path, 'limcode.sqlite');
  }
  const database = await lstatOrUndefined(databasePath);
  if (!database?.isFile()) return keep('备份里没有数据库文件，不处理');
  if (!sameDataSet(recorded, local.binding)) return keep('不是所在历史库的备份（身份不一致），按历史保留');
  if (local.binding.rootGeneration < recorded.rootGeneration) return keep('所在历史库比这份备份更旧（代数更低），按历史保留');
  // Copying it would open and close that database's inode in this process (POSIX locks).
  const linked = await hardLinkedDatabase(databasePath, input.databaseFiles);
  if (linked) return keep(`它和${linked}是同一个文件（硬链接）；为了不破坏${linked}的锁，不读取它，按历史保留`);

  let backupIds: RuntimeDataSetHistoryIds;
  try {
    backupIds = input.known ? input.known.backupIds : await input.cache.backupIds(databasePath, backupBinding);
  } catch (error) {
    return keep(error instanceof CleanupRefusal ? error.message : unreadableReason(error, '这份备份'), errorMessage(error));
  }
  const where = local.current ? CURRENT_LABEL : `这个历史库（${local.candidate.id}）`;
  let missing: { conversations: number; revisions: number };
  let localIds: LocalIds | undefined;
  try {
    if (local.current) {
      missing = await missingInCurrent(input.current, backupIds);
    } else {
      localIds = await localDataSetIds(local, input.cache, input.databaseFiles, input.known);
      missing = missingIn(localIds, backupIds);
    }
  } catch (error) {
    return keep(error instanceof CleanupRefusal ? error.message : unreadableReason(error, local.current ? CURRENT_LABEL : '所在历史库'), errorMessage(error));
  }
  const counts = {
    conversations: backupIds.conversations.length, revisions: backupIds.messageRevisions.length,
    missingConversations: missing.conversations, missingRevisions: missing.revisions
  };
  if (missing.conversations > 0) {
    return { item: { ...item, ...counts, reason: `含 ${missing.conversations} 个${where}没有的对话（可能是你删掉的），按历史保留` } };
  }
  if (missing.revisions > 0) {
    return { item: { ...item, ...counts, reason: `含 ${missing.revisions} 个${where}没有的消息版本，按历史保留` } };
  }
  const proven: RuntimeBackupCleanupItem = {
    ...item, ...counts, deletable: true,
    reason: `可以删除：其中 ${counts.conversations} 个对话、${counts.revisions} 个消息版本都完整存在于${where}`
  };
  return {
    item: proven,
    proof: {
      item: proven, kind, controlRootPath: root.controlRootPath, candidateId: local.candidate.id, tree: tree.digest,
      binding: local.binding, current: local.current, backupIds, ...(localIds ? { local: localIds } : {})
    }
  };
}

/** When a pre-merge backup was made: its name, or the directory's last change when that is later. */
function backupTime(createdAt: number | undefined, modifiedAt: number, now: number): number {
  return Math.max(createdAt ?? now, modifiedAt);
}

/**
 * The newest complete pre-merge backup at least an hour old anchors the protection: it and every
 * newer one stay. A younger one may still be removed by the merge batch that wrote it (when no
 * transaction used it), so it never takes the anchor's place.
 */
async function newestMergeBackupProtection(root: ControlRoot, name: string, now: number): Promise<string | undefined> {
  const directory = path.join(root.controlRootPath, RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY);
  const names = (await readDirectoryNames(directory)).flatMap((entry) => {
    const match = MERGE_BACKUP_NAME.exec(entry);
    return match ? [{ name: entry, time: match[1], sequence: Number(match[2]) }] : [];
  }).sort((left, right) => left.time.localeCompare(right.time) || left.sequence - right.sequence
    || left.name.localeCompare(right.name)).map((entry) => entry.name);
  let anchor = -1;
  for (let index = names.length - 1; index >= 0; index -= 1) {
    const backup = path.join(directory, names[index]);
    const info = await lstatOrUndefined(backup);
    const database = await lstatOrUndefined(path.join(backup, 'limcode.sqlite'));
    const temporary = (await readDirectoryNames(backup)).some((entry) => entry.endsWith('.tmp'));
    const made = backupTime(backupCreatedAt('merge-target', names[index]), info ? info.mtimeMs : now, now);
    if (info?.isDirectory() && database?.isFile() && !temporary && now - made >= RUNTIME_BACKUP_CLEANUP_MERGE_BACKUP_MIN_AGE_MS) {
      anchor = index;
      break;
    }
  }
  const position = names.indexOf(name);
  if (anchor < 0) return '这个库还没有满 1 小时的完整合并前备份，全部保留';
  if (position === anchor) return '这是这个库最新的一份满 1 小时的完整合并前备份，保留';
  if (position > anchor) return '比这个库最新的一份满 1 小时的完整合并前备份还新，保留';
  return undefined;
}

interface UpgradeCompletion {
  fromEpoch: 3 | 4;
  previousBinding: HistoricalRootBinding;
  nextBinding: HistoricalRootBinding;
  completedAt: number;
  /** When the completion record was last written (the later of its mtime and ctime). */
  recordedAt: number;
}

/** Reads a small record as text: the local file, or a foreign root's through readLocatedRuntimeFile. */
type TextReader = (file: string) => Promise<string>;
const readLocalText: TextReader = (file) => fs.readFile(file, 'utf8');

async function readUpgradeCompletion(directory: string, read: TextReader = readLocalText): Promise<UpgradeCompletion | string> {
  const file = path.join(directory, RUNTIME_EPOCH_MIGRATION_COMPLETION_FILE);
  const info = await lstatOrUndefined(file);
  if (!info) return '没有升级完成记录（可能是旧版本或没有完成的升级留下的），按历史保留';
  if (!info.isFile()) return '升级完成记录不是普通文件，不处理';
  let record: Record<string, unknown>;
  try {
    const value = JSON.parse(await read(file)) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    record = value as Record<string, unknown>;
  } catch {
    return '升级完成记录无法读取，按历史保留';
  }
  // v0.0.15–0.0.21 wrote the same kind for their 3→4 upgrade into the same directory.
  if (record.kind === MIGRATION_COMPLETION_KIND && record.toEpoch === 4) return '旧版本 3→4 升级留下的备份，一律保留';
  const completedAt = typeof record.completedAt === 'string' ? Date.parse(record.completedAt) : Number.NaN;
  if (record.kind !== MIGRATION_COMPLETION_KIND || (record.fromEpoch !== 3 && record.fromEpoch !== 4) || record.toEpoch !== 5
    || !Number.isFinite(completedAt)) {
    return '升级完成记录无法识别，按历史保留';
  }
  let previousBinding: HistoricalRootBinding;
  let nextBinding: HistoricalRootBinding;
  try {
    previousBinding = parseHistoricalRootBinding(record.previousBinding);
    nextBinding = parseHistoricalRootBinding(record.nextBinding);
  } catch {
    return '升级完成记录里的身份无法识别，按历史保留';
  }
  const saved = await readBindingFile(path.join(directory, `root-binding.epoch-${record.fromEpoch}.json`), read);
  if (typeof saved === 'string' || !sameBinding(saved, previousBinding) || previousBinding.runtimeKernelEpoch !== record.fromEpoch
    || nextBinding.runtimeKernelEpoch !== 5 || !sameDataSet(previousBinding, nextBinding)) {
    return '升级完成记录与备份里的身份记录不一致，按历史保留';
  }
  return {
    fromEpoch: record.fromEpoch, previousBinding, nextBinding, completedAt,
    recordedAt: Math.max(info.mtimeMs, info.ctimeMs)
  };
}

async function readBindingFile(file: string, read: TextReader = readLocalText): Promise<HistoricalRootBinding | string> {
  const info = await lstatOrUndefined(file);
  if (!info?.isFile()) return '备份里没有身份记录（root-binding），不处理';
  try {
    return parseHistoricalRootBinding(JSON.parse(await read(file)) as unknown);
  } catch {
    return '备份里的身份记录无法识别，不处理';
  }
}

function backupCreatedAt(kind: RuntimeBackupKind, name: string): number | undefined {
  if (kind === 'merge-target' || kind === 'merge-source') {
    const match = MERGE_BACKUP_NAME.exec(name)?.[1];
    return match ? utcSlugTime(match) : undefined;
  }
  return utcSlugTime(name);
}

/**
 * `YYYYMMDDTHHMMSS[mmm]Z` (merge engine, epoch migration), `YYYYMMDD-HHMMSS-mmm` (归档) or
 * `YYYY-MM-DDTHH-MM-SS-mmmZ` (directories a relocation copied aside).
 */
function utcSlugTime(value: string): number | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})[T-](\d{2})(\d{2})(\d{2})-?(\d{3})?Z?/.exec(value)
    ?? /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(value);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second, millisecond] = match;
  const time = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(millisecond ?? 0));
  return Number.isFinite(time) ? time : undefined;
}

/**
 * A reason in words for a copy or data set that could not be read: a state that stays (a damaged
 * or foreign database) keeps the copy as history, one that may pass says so. The error text itself
 * only goes to `detail`.
 */
function unreadableReason(error: unknown, subject: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = errorMessage(error);
  if (code === 'ENOSPC' || /ENOSPC|no space/i.test(message)) return '暂时无法核对：磁盘空间不足，腾出空间后再试';
  if (code === 'runtime-backup-changed-while-reading') return `暂时无法核对：${subject}在读取期间有变化，稍后再试`;
  if (subject === CURRENT_LABEL) return '暂时无法读取当前库，这次不删除，稍后再试';
  if (/RootBinding|root_binding/.test(message)) return `${subject}里的数据库与它的身份记录不一致，按历史保留`;
  if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || /malformed|not a database/i.test(message)) {
    return `${subject}的数据库已损坏，无法核对，按历史保留`;
  }
  if (/rollback journal/i.test(message)) return `${subject}有未完成的回滚日志，无法核对，按历史保留`;
  return `${subject}无法读取，无法核对，按历史保留`;
}

// ---------------------------------------------------------------------------------------------
// Coverage: every id of the copy exists in the local data set

async function missingInCurrent(
  current: RuntimeBackupCleanupCurrent,
  ids: RuntimeDataSetHistoryIds
): Promise<{ conversations: number; revisions: number }> {
  const conversations = await countMissingInCurrent(current, 'Conversation', ids.conversations);
  // A revision is deleted only with its Conversation; the revisions are still read for a copy
  // whose Conversations are all present, so a later merge of an older copy cannot hide one.
  const revisions = conversations > 0 ? 0 : await countMissingInCurrent(current, 'MessageRevision', ids.messageRevisions);
  return { conversations, revisions };
}

async function countMissingInCurrent(current: RuntimeBackupCleanupCurrent, domain: string, ids: readonly string[]): Promise<number> {
  let missing = 0;
  for (let offset = 0; offset < ids.length; offset += RUNTIME_BACKUP_CLEANUP_READ_BATCH) {
    const batch = ids.slice(offset, offset + RUNTIME_BACKUP_CLEANUP_READ_BATCH);
    const reads: RepositoryGetRead[] = batch.map((id) => ({ kind: 'get', domain, id }));
    const rows = (await current.snapshot(reads)).snapshot;
    if (rows.length !== batch.length) throw new Error('当前库的读取结果数量不对');
    for (const row of rows) if (row === null || row === undefined) missing += 1;
  }
  return missing;
}

function missingIn(local: LocalIds, ids: RuntimeDataSetHistoryIds): { conversations: number; revisions: number } {
  return {
    conversations: ids.conversations.filter((id) => !local.conversations.has(id)).length,
    revisions: ids.messageRevisions.filter((id) => !local.messageRevisions.has(id)).length
  };
}

/**
 * After the rename, under the same claims: merges, upgrades and resets are excluded by them, but
 * deleting a Conversation takes no claim. Its revisions go only with it, so the Conversations of the
 * current data set are enough; another data set must still be exactly the files that were read.
 * Undefined when still covered, else why not.
 */
async function stillCovered(root: ControlRoot, proof: BackupProof, current: RuntimeBackupCleanupCurrent): Promise<string | undefined> {
  const local = root.local;
  if (!local || !sameBinding(local.binding, proof.binding)) return '所在历史库在检查之后发生了变化';
  if (local.current) {
    const missing = await countMissingInCurrent(current, 'Conversation', proof.backupIds.conversations);
    return missing > 0 ? `当前库刚刚少了 ${missing} 个这份备份里有的对话` : undefined;
  }
  return await runtimeDataSetFileState(local.binding.paths.databasePath) === proof.local?.files
    ? undefined : '所在历史库在检查之后有改动';
}

/**
 * Ids of a data set this window does not have open, from a private copy in the facts worker, taken
 * under its control root's maintenance: a merge of this process that holds that data set open
 * (source backup, finalization) holds the same claim, so its SQLite locks are never released by
 * this copy. The ids count only while the files are exactly as they were read.
 */
async function localDataSetIds(
  local: LocalDataSet,
  cache: CoverageCache,
  databaseFiles: DatabaseFiles,
  known?: BackupProof
): Promise<LocalIds> {
  if (local.current || await hardLinkedDatabase(local.binding.paths.databasePath, databaseFiles) === CURRENT_LABEL) {
    // A second fence: listControlRoots already keeps such a data set out.
    throw new CleanupRefusal('当前库只经它自己的读取线程查询，不复制它的文件，按历史保留');
  }
  const files = await runtimeDataSetFileState(local.binding.paths.databasePath);
  if (known) {
    if (!known.local || known.local.files !== files) throw new CleanupRefusal('所在历史库在检查之后有改动，请重新检查');
    return known.local;
  }
  if (local.ids?.files === files) return local.ids;
  const cached = await cache.read(dataSetSubject(local.candidate.id), files, local.binding);
  const ids = cached ?? await withRuntimeMaintenance(local.binding.paths, () => withRuntimeMaintenanceActivity({
    ...ACTIVITY, stage: `正在核对历史库 ${local.candidate.id}`
  }, async () => {
    const facts = await readRuntimeDataSetFacts(local.candidate, { historyIds: true });
    if (!facts.historyIds || !sameBinding(facts.binding, local.binding)
      || await runtimeDataSetFileState(local.binding.paths.databasePath) !== files) {
      throw new CleanupRefusal('暂时无法核对：所在历史库在读取期间有变化，稍后再试');
    }
    return facts.historyIds;
  }));
  if (!cached) await cache.write(dataSetSubject(local.candidate.id), files, local.binding, ids);
  local.ids = { files, conversations: new Set(ids.conversations), messageRevisions: new Set(ids.messageRevisions) };
  return local.ids;
}

/**
 * Non-authoritative id lists by exact file state in `.limcode-runtime-merges/coverage/`; a changed
 * file (any rewrite, copy or restore changes its state) is simply read again.
 */
class CoverageCache {
  private readonly directory: string;
  private readonly used = new Set<string>();

  public constructor(private readonly configurationRootPath: string) {
    this.directory = path.join(resolveVscodeRuntimeMergeLedgerRoot({ globalStoragePath: configurationRootPath }), COVERAGE_DIRECTORY);
  }

  public async backupIds(databasePath: string, binding: HistoricalRootBinding): Promise<RuntimeDataSetHistoryIds> {
    const subject = backupSubject(this.configurationRootPath, path.dirname(databasePath));
    const files = await runtimeDataSetFileState(databasePath);
    const cached = await this.read(subject, files, binding);
    if (cached) return cached;
    const read = await readRuntimeBackupFacts({ configurationRootPath: this.configurationRootPath, databasePath, binding }, { historyIds: true });
    if (!read.facts.historyIds) throw new Error('备份的对话清单没有读出来');
    if (read.files === files) await this.write(subject, files, binding, read.facts.historyIds);
    return read.facts.historyIds;
  }

  public async read(subject: string, files: string, binding: HistoricalRootBinding): Promise<RuntimeDataSetHistoryIds | undefined> {
    this.used.add(this.fileName(subject));
    try {
      await assertNoSymbolicPrefix(this.configurationRootPath, this.directory);
      const value = JSON.parse(await fs.readFile(path.join(this.directory, this.fileName(subject)), 'utf8')) as Record<string, unknown> | null;
      if (value?.kind !== COVERAGE_KIND || value.subject !== subject || value.files !== files
        || value.identity !== identityWithGeneration(binding)) return undefined;
      const conversations = value.conversations;
      const messageRevisions = value.messageRevisions;
      if (!isTextArray(conversations) || !isTextArray(messageRevisions)) return undefined;
      return { conversations, messageRevisions };
    } catch {
      return undefined;
    }
  }

  public async write(subject: string, files: string, binding: HistoricalRootBinding, ids: RuntimeDataSetHistoryIds): Promise<void> {
    const file = path.join(this.directory, this.fileName(subject));
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await assertNoSymbolicPrefix(this.configurationRootPath, this.directory);
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const handle = await fs.open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({
          kind: COVERAGE_KIND, subject, files, identity: identityWithGeneration(binding),
          conversations: ids.conversations, messageRevisions: ids.messageRevisions
        })}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, file);
      await syncDirectoryDurably(this.directory);
    } catch {
      // Only a cache: the next check reads the copy again.
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  public async remove(subject: string): Promise<void> {
    await fs.rm(path.join(this.directory, this.fileName(subject)), { force: true }).catch(() => undefined);
  }

  /** After a complete listing: entries of copies and data sets that were not looked at are gone. */
  public async prune(): Promise<void> {
    try {
      await assertNoSymbolicPrefix(this.configurationRootPath, this.directory);
      for (const name of await readDirectoryNames(this.directory)) {
        if (name.endsWith('.json') && !this.used.has(name)) await fs.rm(path.join(this.directory, name), { force: true });
      }
    } catch {
      // Only a cache.
    }
  }

  private fileName(subject: string): string {
    return `${createHash('sha256').update(subject).digest('hex').slice(0, 32)}.json`;
  }
}

// ---------------------------------------------------------------------------------------------
// Listed only

/**
 * The old-format backups/ of a control root, and what the archives directory of its scope holds
 * that is not foreign history (`handled`: a name no archive has, or a directory that cannot be read).
 */
async function listKeptBackups(configurationRootPath: string, root: ControlRoot, handled: ReadonlySet<string>): Promise<RuntimeBackupCleanupItem[]> {
  const items: RuntimeBackupCleanupItem[] = [];
  const legacy = path.join(root.controlRootPath, CUTOVER_BACKUPS_DIRECTORY);
  if (await lstatOrUndefined(legacy)) {
    items.push(await keptItem(configurationRootPath, configurationRootPath, 'legacy-cutover', legacy, root.candidateId,
      '旧格式备份（升级到 SQLite 内核之前的数据），从未导入；本版本只列出，不删除'));
  }
  const archives = path.join(root.scopeRootPath, RESET_ARCHIVES_DIRECTORY);
  if (handled.has(comparable(archives))) return items;
  const info = await lstatOrUndefined(archives);
  if (info?.isDirectory() && await noSymbolicPath(configurationRootPath, archives)) {
    for (const name of (await readDirectoryNames(archives)).sort()) {
      const entry = path.join(archives, name);
      // A leftover of an interrupted cleanup is settled, not listed; an archive is foreign history.
      const base = DELETING_NAME.exec(name)?.[1];
      if (handled.has(comparable(entry)) || (base && ARCHIVE_NAME.test(base))) continue;
      items.push(await keptItem(configurationRootPath, configurationRootPath, 'reset-archive', entry, root.candidateId, ARCHIVE_NAME.test(name)
        ? '“归档并重置”的归档，这次没能作为外来历史库核对，保留'
        : '归档目录里不是“归档并重置”留下的归档（名字不认识）；只列出，不删除'));
    }
  } else if (info) {
    items.push(await keptItem(configurationRootPath, configurationRootPath, 'reset-archive', archives, root.candidateId,
      '“归档并重置”的归档目录是符号链接或不是目录，不跟随；只列出，不删除'));
  }
  return items;
}

/** .limcode-data-backups, and the directories beside the data directory that are no copied directory of foreign history. */
async function listConfigurationLevelBackups(configurationRootPath: string, copiedDirectories: ReadonlySet<string>): Promise<RuntimeBackupCleanupItem[]> {
  const items: RuntimeBackupCleanupItem[] = [];
  const dataBackups = path.join(configurationRootPath, DATA_ROOT_BACKUPS_DIR);
  if (await lstatOrUndefined(dataBackups)) {
    items.push(await keptItem(configurationRootPath, configurationRootPath, 'data-backups', dataBackups, undefined,
      '旧版本开发数据的重置备份；本版本只列出，不删除'));
  }
  const parent = path.dirname(configurationRootPath);
  const prefix = `${path.basename(configurationRootPath)}${COPIED_ASIDE_MARKER}`;
  for (const name of (await readDirectoryNames(parent)).filter((entry) => entry.startsWith(prefix)).sort()) {
    if (copiedDirectories.has(comparable(path.join(parent, name)))) continue;
    // Only the entry itself is checked for a link: the data directory's parent is not LimCode's.
    items.push(await keptItem(configurationRootPath, path.join(parent, name), 'copied-data-root', path.join(parent, name), undefined,
      '名字像迁移时挪到旁边的拷来目录，但不完全符合它的命名规则，不当作外来历史库；只列出，不删除'));
  }
  return items;
}

/**
 * A listed-only item; nothing is read through a symbolic link on its path from `containerRoot` on
 * (such an item is not measured).
 */
async function keptItem(
  configurationRootPath: string,
  containerRoot: string,
  kind: RuntimeBackupKind,
  itemPath: string,
  candidateId: string | undefined,
  reason: string,
  /** Parts listed as items of their own: not measured here. */
  exclude: readonly string[] = []
): Promise<RuntimeBackupCleanupItem> {
  const linkFree = await noSymbolicPath(containerRoot, itemPath);
  const tree = linkFree ? await describeTree(itemPath, exclude).catch(() => undefined) : undefined;
  const createdAt = utcSlugTime(path.basename(itemPath).split(COPIED_ASIDE_MARKER).pop() ?? '');
  return {
    key: itemKey(kind, configurationRootPath, itemPath), kind, name: path.basename(itemPath), path: itemPath,
    ...(candidateId ? { dataSetCandidateId: candidateId } : {}), inCurrentDataSet: false,
    bytes: (tree?.bytes ?? 0n).toString(), reclaimableBytes: (tree?.reclaimableBytes ?? 0n).toString(),
    fileCount: tree?.fileCount ?? 0,
    ...(createdAt !== undefined ? { createdAt: new Date(createdAt).toISOString() } : {}),
    deletable: false,
    reason: !linkFree ? `${reason}（路径里有符号链接，没有跟随，也没有统计大小）`
      : tree?.symbolicLink ? `${reason}（其中有符号链接，没有跟随）` : reason
  };
}

// ---------------------------------------------------------------------------------------------
// Deleting

/**
 * The rename hides the copy. Its coverage is then checked once more (deleting a Conversation takes
 * no claim); only a copy still covered is marked verified (a file inside it naming the renamed
 * directory) and removed. A copy no longer covered, or one whose check or mark failed, gets its name
 * back and is reported kept; when even that fails it keeps the `.deleting-` name without a valid
 * mark, and the next cleanup gives it its name back instead of deleting it. A failure after the mark
 * reports the copy as not removed completely (the next cleanup finishes it), never as kept.
 */
async function removeBackupDirectory(directory: string, hooks: {
  afterRename(): Promise<void> | void;
  afterVerify(): Promise<void> | void;
  stillCovered(): Promise<string | undefined>;
  /** More for the verified mark (a foreign root's id: the claim its leftover is settled under). */
  mark?: Readonly<Record<string, string>>;
}): Promise<RemovalOutcome> {
  const parent = path.dirname(directory);
  const deleting = `${directory}${DELETING_MARKER}${randomBytes(8).toString('hex')}`;
  try {
    await fs.rename(directory, deleting);
  } catch (error) {
    return { state: 'kept', reason: '没有删除：改名失败', detail: errorMessage(error) };
  }
  let refusal: { reason: string; detail?: string } | undefined;
  try {
    // Not final yet whether the rename is durable: nothing is deleted before the mark is.
    await syncDirectoryDurably(parent).catch(() => undefined);
    await hooks.afterRename();
    const uncovered = await hooks.stillCovered();
    if (uncovered) refusal = { reason: uncovered };
    else await writeVerifiedMark(deleting, hooks.mark);
  } catch (error) {
    refusal = { reason: '改名之后没能再次核对', detail: errorMessage(error) };
  }
  if (refusal) {
    await fs.rm(path.join(deleting, VERIFIED_MARKER_FILE), { force: true }).catch(() => undefined);
    try {
      await fs.rename(deleting, directory);
    } catch (error) {
      return {
        state: 'kept',
        reason: `${refusal.reason}；没能改回原名，现在名为 ${path.basename(deleting)}，下次检查时会改回原名，不会删除`,
        detail: [refusal.detail, errorMessage(error)].filter(Boolean).join('; ')
      };
    }
    await syncDirectoryDurably(parent).catch(() => undefined);
    return { state: 'kept', reason: `${refusal.reason}，已改回原名，保留`, ...(refusal.detail ? { detail: refusal.detail } : {}) };
  }
  try {
    await hooks.afterVerify();
    await removeVerifiedDirectory(deleting);
  } catch (error) {
    return {
      state: 'unfinished',
      reason: `已核对并改名为 ${path.basename(deleting)}，但没有删完；下次清理备份时会删完`,
      detail: errorMessage(error)
    };
  }
  // Gone; were the removal lost to a crash, the verified leftover is removed by the next cleanup.
  await syncDirectoryDurably(parent).catch(() => undefined);
  return { state: 'deleted' };
}

/** The mark names the renamed directory: a mark left inside a copy that got its name back never counts. */
async function writeVerifiedMark(directory: string, extra: Readonly<Record<string, string>> = {}): Promise<void> {
  const file = path.join(directory, VERIFIED_MARKER_FILE);
  // A stale mark (or anything else of that name, never followed) goes first; the new one is created exclusively.
  await fs.rm(file, { force: true });
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ ...extra, kind: VERIFIED_MARKER_KIND, name: path.basename(directory) })}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectoryDurably(directory);
}

/** The mark goes last: a removal that fails halfway stays a verified leftover, finished by the next cleanup. */
async function removeVerifiedDirectory(directory: string): Promise<void> {
  for (const name of await fs.readdir(directory)) {
    if (name === VERIFIED_MARKER_FILE) continue;
    await fs.rm(path.join(directory, name), { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
  }
  await fs.rm(path.join(directory, VERIFIED_MARKER_FILE), { force: true });
  await fs.rmdir(directory);
}

async function hasVerifiedMark(directory: string): Promise<boolean> {
  return (await readVerifiedMark(directory)) !== undefined;
}

/** The mark of this very directory (it names it), with what it records beside the name. */
async function readVerifiedMark(directory: string, read: TextReader = readLocalText): Promise<{ foreignId?: string } | undefined> {
  const file = path.join(directory, VERIFIED_MARKER_FILE);
  if (!(await lstatOrUndefined(file))?.isFile()) return undefined;
  try {
    const value = JSON.parse(await read(file)) as { kind?: unknown; name?: unknown; foreignId?: unknown } | null;
    if (value?.kind !== VERIFIED_MARKER_KIND || value.name !== path.basename(directory)) return undefined;
    return typeof value.foreignId === 'string' ? { foreignId: value.foreignId } : {};
  } catch {
    return undefined;
  }
}

/**
 * `.deleting-*` leftovers of an interrupted cleanup, under the same claims as a deletion: a verified
 * one is removed; one interrupted before its last check gets its name back and is checked again.
 * A foreign root's leftover is found where discovery would find the root under its name, and settled
 * under the admission and that root's foreign claim (the id its mark records, else the one discovery
 * gives it from its pointer), taken without waiting.
 */
async function settleInterruptedDeletions(
  configurationRootPath: string,
  roots: readonly ControlRoot[],
  problem: (text: string, error?: unknown) => void,
  context: { previousDataRootPaths?: readonly string[]; databaseFiles: DatabaseFiles }
): Promise<{ finished: string[]; restored: string[] }> {
  const finished: string[] = [];
  const restored: string[] = [];
  const pending: Array<{ root: ControlRoot; leftovers: Array<{ path: string; original: string }> }> = [];
  for (const root of roots) {
    const leftovers: Array<{ path: string; original: string }> = [];
    for (const kind of LOCAL_BACKUP_KINDS) {
      const directory = path.join(root.controlRootPath, DELETABLE_DIRECTORIES[kind]);
      for (const name of await readDirectoryNames(directory)) {
        const base = DELETING_NAME.exec(name)?.[1];
        if (base && (kind === 'epoch-migration' ? EPOCH_BACKUP_NAME.test(base) : MERGE_BACKUP_NAME.test(base))) {
          leftovers.push({ path: path.join(directory, name), original: path.join(directory, base) });
        }
      }
    }
    if (leftovers.length > 0) pending.push({ root, leftovers });
  }
  let foreign: Awaited<ReturnType<typeof listRenamedForeignRuntimeRoots>> = [];
  try {
    foreign = await listRenamedForeignRuntimeRoots({
      configurationRootPath, ...(context.previousDataRootPaths?.length ? { previousDataRootPaths: context.previousDataRootPaths } : {})
    }, DELETING_NAME);
  } catch (error) {
    problem('外来历史库里上次没有删完的目录没有全部找到，下次检查时再试。', error);
  }
  if (pending.length === 0 && foreign.length === 0) return { finished, restored };
  const record = (outcome: 'finished' | 'restored' | undefined, leftover: { path: string; original: string }) => {
    if (outcome === 'finished') finished.push(leftover.path);
    else if (outcome === 'restored') restored.push(leftover.original);
  };
  const stage = '正在收尾上次没有删完的备份';
  await withRuntimeDataRootAdmission(configurationRootPath, () => withRuntimeMaintenanceActivity({ ...ACTIVITY, stage }, async (admission) => {
    for (const { root, leftovers } of pending) {
      await withRuntimeMaintenance(root.paths, () => withRuntimeMaintenanceActivity({ ...ACTIVITY, stage }, async () => {
        for (const leftover of leftovers) {
          record(await settleLeftover(leftover, configurationRootPath, readLocalText, problem), leftover);
        }
      }));
      // Leaving a claim also took the marker out of the admission: publish it again.
      admission.report(`${stage}（${path.basename(root.controlRootPath)}）`);
    }
    if (foreign.length === 0) return;
    const held = await heldFiles(configurationRootPath, context.databaseFiles);
    const read: TextReader = async (file) => (await readLocatedRuntimeFile(file, held, MAX_FOREIGN_RECORD_BYTES)).toString('utf8');
    for (const leftover of foreign) {
      const name = path.basename(leftover.path);
      try {
        if (!(await lstatOrUndefined(leftover.path))?.isDirectory()) {
          if (await lstatOrUndefined(leftover.path)) problem(`上次没有删完的 ${name} 不是普通目录，没有处理。`);
          continue;
        }
        const id = (await readVerifiedMark(leftover.path, read))?.foreignId
          ?? foreignRuntimeHistoryId(leftover.location, await leftoverIdentity(leftover.path, read));
        const settled = await tryWithForeignRuntimeRootClaim(configurationRootPath, id,
          path.join(leftover.originalPath, ROOT_BINDING_POINTER_FILE), () => withRuntimeMaintenanceActivity({
            ...ACTIVITY, stage: '正在收尾上次没有删完的外来历史库'
          }, () => settleLeftover({ path: leftover.path, original: leftover.originalPath }, path.dirname(leftover.path), read, problem)));
        admission.report(`${stage}（${name}）`);
        if (!settled.acquired) {
          problem(`上次没有删完的 ${name} ${FOREIGN_BUSY}，这次没有处理，下次检查时再试。`);
          continue;
        }
        record(settled.value, { path: leftover.path, original: leftover.originalPath });
      } catch (error) {
        problem(`上次没有删完的 ${name} 这次没有处理完，保留，下次检查时再试。`, error);
      }
    }
  }));
  return { finished, restored };
}

/** One leftover (reached without links from `root`): verified ones are removed, others get their name back. */
async function settleLeftover(
  leftover: { path: string; original: string },
  root: string,
  read: TextReader,
  problem: (text: string, error?: unknown) => void
): Promise<'finished' | 'restored' | undefined> {
  const name = path.basename(leftover.path);
  try {
    const info = await lstatOrUndefined(leftover.path);
    if (!info) return undefined;
    if (!info.isDirectory() || !await noSymbolicPath(root, leftover.path)) {
      problem(`上次没有删完的 ${name} 不是普通目录，没有处理。`);
      return undefined;
    }
    if (await readVerifiedMark(leftover.path, read)) {
      await removeVerifiedDirectory(leftover.path);
      await syncDirectoryDurably(path.dirname(leftover.path)).catch(() => undefined);
      return 'finished';
    }
    if (await lstatOrUndefined(leftover.original)) {
      problem(`上次没有删完的 ${name} 没有核对完，原来的名字已被占用，没有改回，也没有删除。`);
      return undefined;
    }
    await fs.rm(path.join(leftover.path, VERIFIED_MARKER_FILE), { force: true });
    await fs.rename(leftover.path, leftover.original);
    await syncDirectoryDurably(path.dirname(leftover.path)).catch(() => undefined);
    return 'restored';
  } catch (error) {
    problem(`上次没有删完的 ${name} 这次没有处理完，保留，下次检查时再试。`, error);
    return undefined;
  }
}

/** The identity a renamed foreign control root's pointer names, as discovery reads it for the id. */
async function leftoverIdentity(directory: string, read: TextReader): Promise<{ dataSetId: string; rootInstanceId: string } | undefined> {
  try {
    const value = JSON.parse(await read(path.join(directory, ROOT_BINDING_POINTER_FILE))) as { dataSetId?: unknown; rootInstanceId?: unknown } | null;
    return typeof value?.dataSetId === 'string' && typeof value.rootInstanceId === 'string'
      ? { dataSetId: value.dataSetId, rootInstanceId: value.rootInstanceId } : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Foreign history: archives and the data sets of copied directories (runtimeForeignHistory)

interface ForeignPlanning {
  configurationRootPath: string;
  current: RuntimeBackupCleanupCurrent;
  roots: readonly ControlRoot[];
  databaseFiles: DatabaseFiles;
  cache: CoverageCache;
  now: number;
  report(message: string): void;
}

/** A backup a foreign root's control root keeps: proven together with the root, or the root stays whole. */
interface ForeignCopy {
  label: string;
  name: string;
  /** Below the control root, '/' separated (its coverage cache subject). */
  relative: string;
  databasePath: string;
  binding: HistoricalRootBinding;
}

type ForeignRead =
  | { refusal: string; detail?: string; tree?: TreeFacts }
  | {
    entry: ForeignRuntimeHistoryEntry;
    root: LocatedRuntimeRoot;
    tree: TreeFacts;
    copies: number;
    /** Ids of the backups it keeps. */
    nested: RuntimeDataSetHistoryIds;
    /** A local data set other than the open one with its identity and exactly its content digest. */
    identical?: LocalDataSet;
    /** Its own ids: read only when it is not identical to a local data set. */
    own?: RuntimeDataSetHistoryIds;
  };

/**
 * One item per discovered foreign root (its conclusion), and per copied directory one listed-only
 * item for everything in it that is no data set (never deleted as a whole).
 */
async function planForeignHistory(
  input: ForeignPlanning,
  found: readonly DiscoveredForeignRuntimeRoot[],
  proofs: Map<string, ForeignProof>
): Promise<RuntimeBackupCleanupItem[]> {
  if (found.length === 0) return [];
  const held = await heldFiles(input.configurationRootPath, input.databaseFiles);
  const items: RuntimeBackupCleanupItem[] = [];
  const copied = new Map<string, { path: string; units: string[]; whole?: ForeignRuntimeHistoryEntry }>();
  for (const entry of found) {
    input.report(`正在核对外来历史库 ${foreignName(entry)}…`);
    const container = entry.location.kind === 'copied' ? copiedContainer(copied, entry.location.containerPath) : undefined;
    if (!hasDataRoot(entry.location)) {
      // A directory that cannot be listed, or holds nothing recognizable: its verification says why.
      const { entry: checked } = await inspectForeignRuntimeRoot(input.configurationRootPath, entry, held);
      if (container && entry.location.dataRootRelativePath === '') {
        container.whole = checked;
        continue;
      }
      const listed = foreignListedPath(entry.location);
      container?.units.push(listed);
      items.push(foreignItem(entry, listed, await linkFreeTree(entry.location.containerPath, listed), foreignRefusal(checked)));
      continue;
    }
    const unit = foreignUnit(entry.location);
    container?.units.push(unit);
    const evaluation = await evaluateForeign(input, entry, unit, held);
    items.push(evaluation.item);
    if (evaluation.proof) proofs.set(evaluation.item.key, evaluation.proof);
  }
  for (const container of copied.values()) {
    const reason = container.units.length > 0
      ? '迁移数据目录时挪到旁边的拷来目录。其中的库在“外来历史库”一组里逐个核对，只删能证明内容已完整在本地库里的库；目录本身和其余内容（设置、规则、技能）不删除'
      : !container.whole || container.whole.code === 'foreign-history-no-runtime'
        ? `拷来目录里已经没有库；${COPIED_REST}`
        : `${bare(container.whole.reason ?? '无法读取')}；${COPIED_REST}`;
    items.push(await keptItem(input.configurationRootPath, container.path, 'copied-data-root', container.path, undefined, reason, container.units));
  }
  return items;
}

function copiedContainer(
  containers: Map<string, { path: string; units: string[]; whole?: ForeignRuntimeHistoryEntry }>,
  containerPath: string
): { path: string; units: string[]; whole?: ForeignRuntimeHistoryEntry } {
  const key = comparable(containerPath);
  let container = containers.get(key);
  if (!container) {
    container = { path: containerPath, units: [] };
    containers.set(key, container);
  }
  return container;
}

/**
 * Proof 1: a local data set other than the open one with its identity and exactly its content
 * digest (the digest of the open one is never computed: its files are not copied), and every id of
 * the backups it keeps in that data set. Proof 2: every Conversation and MessageRevision id of it
 * and of those backups in one local data set (the ones with its identity first, then the open one,
 * then the others). Its files are read under its claim, taken without waiting; a local data set's
 * digest and ids under that data set's own maintenance, never inside the foreign claim.
 */
async function evaluateForeign(
  input: ForeignPlanning,
  found: DiscoveredForeignRuntimeRoot,
  unit: string,
  held: HeldDatabaseFiles
): Promise<{ item: RuntimeBackupCleanupItem; proof?: ForeignProof }> {
  const listed = (reason: string, detail?: string, tree?: TreeFacts) => ({ item: foreignItem(found, unit, tree, reason, detail) });
  const locals = input.roots.flatMap((root) => root.local ? [root.local] : []);
  const hint = await readForeignRuntimePointerIdentity(found.location, held).catch(() => undefined);
  const twins = hint ? locals.filter((local) => sameIdentity(local.binding, hint)) : [];
  for (const twin of twins) await localDigest(twin, input.databaseFiles);
  let claimed: { acquired: true; value: ForeignRead } | { acquired: false };
  try {
    claimed = await tryWithForeignRuntimeRootClaim(input.configurationRootPath, found.id, foreignPointer(found.location),
      () => readForeignUnderClaim(input, found, unit, held, twins));
  } catch (error) {
    return listed('暂时无法核对它，这次不能删除，稍后再检查', errorMessage(error), await linkFreeTree(found.location.containerPath, unit));
  }
  if (!claimed.acquired) return listed(`${FOREIGN_BUSY}，这次不能删除，稍后再检查`, undefined, await linkFreeTree(found.location.containerPath, unit));
  const read = claimed.value;
  if ('refusal' in read) return listed(read.refusal, read.detail, read.tree);
  const ids = unionIds(read.nested, read.own);
  const counted = (item: RuntimeBackupCleanupItem, missing: { conversations: number; revisions: number }): RuntimeBackupCleanupItem => ({
    ...item, conversations: ids.conversations.length, revisions: ids.messageRevisions.length,
    missingConversations: missing.conversations, missingRevisions: missing.revisions
  });
  let proven: { method: 'identical' | 'coverage'; local: LocalDataSet; files?: string } | undefined;
  let closest: { local: LocalDataSet; missing: { conversations: number; revisions: number } } | undefined;
  let failure: { reason: string; detail: string } | undefined;
  let checked = 0;
  const candidates = read.identical ? [read.identical] : [...new Set([...twins, ...locals.filter((local) => local.current), ...locals])];
  if (read.identical?.digest && ids.conversations.length === 0 && ids.messageRevisions.length === 0) {
    // Identical and keeping no backup: nothing else to read.
    proven = { method: 'identical', local: read.identical, files: read.identical.digest.files };
    candidates.length = 0;
  }
  for (const local of candidates) {
    try {
      let missing: { conversations: number; revisions: number };
      let files: string | undefined;
      if (local.current) {
        missing = await missingInCurrent(input.current, ids);
      } else {
        const localIds = await localDataSetIds(local, input.cache, input.databaseFiles);
        if (read.identical && localIds.files !== local.digest?.files) {
          throw new CleanupRefusal('暂时无法核对：所在历史库在读取期间有变化，稍后再试');
        }
        missing = missingIn(localIds, ids);
        files = localIds.files;
      }
      checked += 1;
      if (missing.conversations === 0 && missing.revisions === 0) {
        proven = { method: read.identical ? 'identical' : 'coverage', local, ...(files ? { files } : {}) };
        break;
      }
      if (!closest || missing.conversations < closest.missing.conversations
        || (missing.conversations === closest.missing.conversations && missing.revisions < closest.missing.revisions)) {
        closest = { local, missing };
      }
    } catch (error) {
      failure ??= {
        reason: error instanceof CleanupRefusal ? error.message : unreadableReason(error, local.current ? CURRENT_LABEL : '所在历史库'),
        detail: errorMessage(error)
      };
    }
  }
  if (!proven) {
    if (closest) {
      const where = localLabel(closest.local);
      const others = checked > 1 ? '，也没有别的本地库完整包含它' : '';
      return {
        item: counted(foreignItem(found, unit, read.tree, closest.missing.conversations > 0
          ? `含 ${closest.missing.conversations} 个${where}没有的对话（可能是你删掉的）${others}，按历史保留`
          : `含 ${closest.missing.revisions} 个${where}没有的消息版本${others}，按历史保留`), closest.missing)
      };
    }
    if (failure) return listed(failure.reason, failure.detail, read.tree);
    return listed('没有可以核对的本地库，按历史保留', undefined, read.tree);
  }
  const where = localLabel(proven.local);
  const reason = proven.method === 'identical'
    ? `可以删除：内容已完整在${where}里（与它身份相同、内容完全相同${read.copies > 0 ? `；它保留的 ${read.copies} 份备份也都在那里` : ''}）`
    : `可以删除：内容已完整在${where}里（其中 ${ids.conversations.length} 个对话、${ids.messageRevisions.length} 个消息版本都在${read.copies > 0 ? `，包括它保留的 ${read.copies} 份备份` : ''}）`;
  const item: RuntimeBackupCleanupItem = { ...counted(foreignItem(found, unit, read.tree, reason), { conversations: 0, revisions: 0 }), deletable: true };
  return {
    item,
    proof: {
      item, found, root: read.root, unit, tree: read.tree.digest, method: proven.method,
      ...(read.entry.contentDigest ? { contentDigest: read.entry.contentDigest } : {}),
      by: {
        candidateId: proven.local.candidate.id, binding: proven.local.binding, current: proven.local.current,
        ...(proven.files ? { files: proven.files } : {})
      },
      ids,
      ...(found.location.kind === 'copied' ? { copiedDirectory: found.location.containerPath } : {})
    }
  };
}

/** Under the foreign claim: verified again, its directory described, the backups it keeps and (when needed) itself read. */
async function readForeignUnderClaim(
  input: ForeignPlanning,
  found: DiscoveredForeignRuntimeRoot,
  unit: string,
  held: HeldDatabaseFiles,
  twins: readonly LocalDataSet[]
): Promise<ForeignRead> {
  const { entry, root } = await inspectForeignRuntimeRoot(input.configurationRootPath, found, held);
  if (entry.status !== 'verified' || !root) {
    return { refusal: foreignRefusal(entry), tree: await linkFreeTree(found.location.containerPath, unit) };
  }
  if (root.id !== found.id || comparable(path.dirname(root.located.rootPointerPath)) !== comparable(unit)) {
    return { refusal: '核对期间它发生了变化，这次不能删除，稍后再检查' };
  }
  let tree: TreeFacts;
  try {
    tree = await describeTree(unit);
  } catch (error) {
    return { refusal: '无法读取它的目录，按历史保留', detail: errorMessage(error) };
  }
  if (tree.symbolicLink) return { refusal: '目录里有符号链接，不跟随也不删除，整份保留', tree };
  if (tree.unsupported) return { refusal: '目录里有无法识别的文件类型，整份保留', tree };
  let content: { copies: ForeignCopy[] } | { refusal: string };
  try {
    content = await foreignUnitContent(unit, held, input.now);
  } catch (error) {
    return { refusal: '无法读取它的目录，按历史保留', detail: errorMessage(error), tree };
  }
  if ('refusal' in content) return { refusal: content.refusal, tree };
  const nested: RuntimeDataSetHistoryIds = { conversations: [], messageRevisions: [] };
  for (const copy of content.copies) {
    try {
      const ids = await foreignIds(input.cache, foreignSubject(root.id, copy.relative), root.containerRoot, copy.databasePath, copy.binding, held);
      nested.conversations.push(...ids.conversations);
      nested.messageRevisions.push(...ids.messageRevisions);
    } catch (error) {
      return { refusal: `它保留的${copy.label} ${copy.name}：${foreignReadProblem(error, '这份备份')}，整份保留`, detail: errorMessage(error), tree };
    }
  }
  const identical = entry.contentDigest === undefined ? undefined : twins.find((twin) =>
    !twin.current && twin.digest?.digest === entry.contentDigest && sameIdentity(twin.binding, root.recorded));
  if (identical) return { entry, root, tree, copies: content.copies.length, nested, identical };
  if (entry.unfinishedWork) {
    const count = entry.unfinishedWork.finalizable + entry.unfinishedWork.refused;
    return { refusal: `有 ${count} 项未结束的任务（旧窗口中断时留下），覆盖核对不包括它们，按历史保留`, tree };
  }
  try {
    const own = await foreignIds(input.cache, foreignSubject(root.id), root.containerRoot, root.located.databasePath, root.recorded, held);
    return { entry, root, tree, copies: content.copies.length, nested, own };
  } catch (error) {
    return { refusal: `${foreignReadProblem(error, '这个外来库')}，按历史保留`, detail: errorMessage(error), tree };
  }
}

/**
 * What a foreign root's control root holds besides the data set itself: the backups it keeps (each
 * proven with it), or why it stays whole (old-format backups/, debug captures, output of a process,
 * anything unknown).
 */
async function foreignUnitContent(unit: string, held: HeldDatabaseFiles, now: number): Promise<{ copies: ForeignCopy[] } | { refusal: string }> {
  const copies: ForeignCopy[] = [];
  const unknown: string[] = [];
  let legacy = false;
  for (const name of (await fs.readdir(unit)).sort()) {
    const entry = path.join(unit, name);
    const info = await fs.lstat(entry);
    if (name === VSCODE_RUNTIME_ACTIVE_DIRECTORY && info.isDirectory()) {
      const problem = await foreignDataRootProblem(entry);
      if (problem) return { refusal: problem };
      continue;
    }
    if ((info.isFile() && (FOREIGN_CONTROL_ROOT_FILES.has(name) || isLimCodeTransient(name))) || isClaimName(name)) continue;
    const kind = LOCAL_BACKUP_KINDS.find((candidate) => DELETABLE_DIRECTORIES[candidate] === name);
    if (kind && info.isDirectory()) {
      for (const backup of (await fs.readdir(entry)).sort()) {
        const copy = await foreignBackupCopy(unit, kind, path.join(entry, backup), held, now);
        if (typeof copy === 'string') return { refusal: copy };
        copies.push(copy);
      }
      continue;
    }
    if (name === CUTOVER_BACKUPS_DIRECTORY) legacy = true;
    else unknown.push(name);
  }
  if (legacy) return { refusal: '里面有旧格式备份 backups/（升级到 SQLite 内核之前的数据，从未导入），整份保留，可自行处理' };
  if (unknown.length > 0) {
    return { refusal: `里面有不认识的内容（${unknown.slice(0, 5).join('、')}${unknown.length > 5 ? ' 等' : ''}），整份保留，可自行处理` };
  }
  return { copies };
}

/** Why a foreign data root keeps its root whole, if anything in it is more than the data set and LimCode's runtime files. */
async function foreignDataRootProblem(dataRoot: string): Promise<string | undefined> {
  const unknown: string[] = [];
  for (const name of (await fs.readdir(dataRoot)).sort()) {
    if (FOREIGN_DATA_ROOT_ENTRIES.has(name) || isLimCodeTransient(name) || isClaimName(name)) continue;
    if (name === PROCESS_SPOOL_DIRECTORY) {
      if ((await fs.readdir(path.join(dataRoot, name))).length > 0) return '里面的进程输出暂存（process-spool）还有内容，整份保留，可自行处理';
      continue;
    }
    unknown.push(name);
  }
  if ((await readDirectoryNames(path.join(dataRoot, ...DEBUG_CAPTURES_PATH))).length > 0) {
    return '里面有调试取证（diagnostics/debug-captures），整份保留，可自行处理';
  }
  if (unknown.length > 0) {
    return `数据目录里有不认识的内容（${unknown.slice(0, 5).join('、')}${unknown.length > 5 ? ' 等' : ''}），整份保留，可自行处理`;
  }
  return undefined;
}

/**
 * One backup a foreign control root keeps, by the rules of its kind: an upgrade backup needs its
 * completion record to epoch 5 (published 3→4 ones are kept) and 7 days since the latest of its
 * times; a pre-merge or source backup its saved binding and no temporary file. Records are read as
 * small regular files of the foreign root. A string says why the root stays whole.
 */
async function foreignBackupCopy(
  unit: string,
  kind: DeletableKind,
  directory: string,
  held: HeldDatabaseFiles,
  now: number
): Promise<ForeignCopy | string> {
  const name = path.basename(directory);
  const label = BACKUP_LABELS[kind];
  const refuse = (problem: string) => `它保留的${label} ${name}${problem}，整份保留`;
  const base = DELETING_NAME.exec(name)?.[1] ?? name;
  const info = await fs.lstat(directory);
  if (!info.isDirectory()) return refuse(' 不是目录');
  if (!(kind === 'epoch-migration' ? EPOCH_BACKUP_NAME.test(base) : MERGE_BACKUP_NAME.test(base))) return refuse(' 的名字不认识');
  const read: TextReader = async (file) => (await readLocatedRuntimeFile(file, held, MAX_FOREIGN_RECORD_BYTES)).toString('utf8');
  let databasePath: string;
  let binding: HistoricalRootBinding;
  if (kind === 'epoch-migration') {
    const completion = await readUpgradeCompletion(directory, read);
    if (typeof completion === 'string') return refuse(`：${bare(completion)}`);
    const completedAt = Math.max(completion.completedAt, backupCreatedAt(kind, base) ?? 0, completion.recordedAt);
    if (completedAt > now) return refuse('：升级完成的时间晚于现在，时间不可信');
    if (now - completedAt < RUNTIME_BACKUP_CLEANUP_UPGRADE_GRACE_MS) {
      return refuse(`：升级完成不满 7 天，${new Date(completedAt + RUNTIME_BACKUP_CLEANUP_UPGRADE_GRACE_MS).toISOString()} 之后才可以删除`);
    }
    databasePath = path.join(directory, `limcode.epoch-${completion.fromEpoch}.sqlite`);
    binding = completion.previousBinding;
  } else {
    if ((await readDirectoryNames(directory)).some((entry) => entry.endsWith('.tmp'))) return refuse(' 还没有写完（目录里有临时文件）');
    const saved = await readBindingFile(path.join(directory, ROOT_BINDING_POINTER_FILE), read);
    if (typeof saved === 'string') return refuse(`：${bare(saved)}`);
    databasePath = path.join(directory, RUNTIME_DATABASE_FILE);
    binding = saved;
  }
  if (!(await lstatOrUndefined(databasePath))?.isFile()) return refuse(' 里没有数据库文件');
  return { label, name, relative: path.relative(unit, directory).split(path.sep).join('/'), databasePath, binding };
}

/**
 * Ids of a SQLite database below a foreign container: never one whose files are a file of a
 * database this process holds (stat only), copied only by the foreign copy (dev:ino checked again,
 * state before and after) and read in the facts worker; cached by exact file state.
 */
async function foreignIds(
  cache: CoverageCache,
  subject: string,
  containerRoot: string,
  databasePath: string,
  binding: HistoricalRootBinding,
  held: HeldDatabaseFiles
): Promise<RuntimeDataSetHistoryIds> {
  if (await isHeldDatabase(databasePath, held)) {
    throw new CleanupRefusal('它和本窗口可能正在使用的数据库是同一个文件（硬链接）；为了不破坏那个库的锁，不读取它');
  }
  const files = await runtimeDataSetFileState(databasePath);
  const cached = await cache.read(subject, files, binding);
  if (cached) return cached;
  const copy = await copyForeignRuntimeSqliteFiles(containerRoot, databasePath, held);
  try {
    const facts = await readRuntimeCopyFacts(copy.databasePath, binding, { historyIds: true });
    if (!facts.historyIds) throw new Error('对话清单没有读出来');
    if (copy.files === files) await cache.write(subject, files, binding, facts.historyIds);
    return facts.historyIds;
  } finally {
    await copy.remove();
  }
}

/**
 * The content digest of a local data set other than the open one, for exactly its files as they were
 * (runtimeDataSetFingerprint, shared with merges), read under its maintenance; nothing on any doubt.
 */
async function localDigest(local: LocalDataSet, databaseFiles: DatabaseFiles): Promise<void> {
  if (local.current || await hardLinkedDatabase(local.binding.paths.databasePath, databaseFiles) === CURRENT_LABEL) return;
  try {
    if (local.digest && local.digest.files === await runtimeDataSetFileState(local.binding.paths.databasePath)) return;
    await withRuntimeMaintenance(local.binding.paths, () => withRuntimeMaintenanceActivity({
      ...ACTIVITY, stage: `正在核对历史库 ${local.candidate.id}`
    }, async () => {
      const files = await runtimeDataSetFileState(local.binding.paths.databasePath);
      const fingerprint = await runtimeDataSetFingerprint(local.candidate);
      if (!isReadableRuntimeDataSetFingerprint(fingerprint) || fingerprint.dataSetId !== local.binding.dataSetId
        || fingerprint.rootInstanceId !== local.binding.rootInstanceId || fingerprint.rootGeneration !== local.binding.rootGeneration
        || fingerprint.pointerRevision !== local.binding.pointerRevision
        || await runtimeDataSetFileState(local.binding.paths.databasePath) !== files) return;
      local.digest = { files, digest: fingerprint.contentDigest };
    }));
  } catch {
    // No digest: the identity proof is not available, coverage still is.
  }
}

/**
 * Under the admission and the foreign claim: located and verified again from where it was found
 * (the audit joins the claim), exactly as listed (tree), the proving data set with the same identity
 * and generation, and still covered (the open one by its ids through its reader, another one by its
 * file state); then renamed, checked once more, marked (with its id) and removed.
 */
async function deleteForeignRoot(
  proof: ForeignProof,
  context: { configurationRootPath: string; current: RuntimeBackupCleanupCurrent; options: RuntimeBackupDeletionOptions }
): Promise<RemovalOutcome> {
  const { configurationRootPath, current, options } = context;
  const kept = (reason: string, detail?: string): RemovalOutcome => ({ state: 'kept', reason: `${reason}；这一项没有删除`, ...(detail ? { detail } : {}) });
  const { roots, databaseFiles } = await listControlRoots(configurationRootPath, current, () => undefined);
  const held = await heldFiles(configurationRootPath, databaseFiles);
  const { entry, root } = await inspectForeignRuntimeRoot(configurationRootPath, proof.found, held);
  if (entry.status !== 'verified' || !root) return kept(foreignRefusal(entry));
  if (!sameLocatedRuntimeRoot(root, proof.root)) return kept('检查之后它发生了变化，请重新检查');
  if (proof.method === 'identical' ? entry.contentDigest !== proof.contentDigest : entry.unfinishedWork !== undefined) {
    return kept('检查之后它的内容有变化，请重新检查');
  }
  const tree = await describeTree(proof.unit).catch(() => undefined);
  if (!tree || tree.digest !== proof.tree) return kept('列出之后它有变化，请重新检查');
  const local = roots.find((candidate) => candidate.local?.candidate.id === proof.by.candidateId)?.local;
  if (!local || !sameBinding(local.binding, proof.by.binding) || local.current !== proof.by.current) {
    return kept('证明它的本地库在检查之后发生了变化，请重新检查');
  }
  let uncovered: string | undefined;
  try {
    uncovered = await foreignStillCovered(local, proof, current, true);
  } catch (error) {
    return kept(local.current ? '暂时无法读取当前库，稍后再试' : '暂时无法核对证明它的历史库，稍后再试', errorMessage(error));
  }
  if (uncovered) return kept(uncovered);
  try {
    await options.onFaultPoint?.('before-rename', proof.item.key);
  } catch (error) {
    return { state: 'kept', reason: '没有删除', detail: errorMessage(error) };
  }
  return removeBackupDirectory(proof.unit, {
    afterRename: () => options.onFaultPoint?.('after-rename', proof.item.key),
    afterVerify: () => options.onFaultPoint?.('after-verify', proof.item.key),
    stillCovered: () => foreignStillCovered(local, proof, current, false),
    mark: { foreignId: proof.root.id }
  });
}

/**
 * Still proven: the open data set by its ids through its reader (before the rename every id; after
 * it the Conversations, the only thing deleted without a claim), another one by its file state.
 */
async function foreignStillCovered(
  local: LocalDataSet,
  proof: ForeignProof,
  current: RuntimeBackupCleanupCurrent,
  beforeRename: boolean
): Promise<string | undefined> {
  if (local.current) {
    if (!beforeRename) {
      const missing = await countMissingInCurrent(current, 'Conversation', proof.ids.conversations);
      return missing > 0 ? `当前库刚刚少了 ${missing} 个它有的对话` : undefined;
    }
    const missing = await missingInCurrent(current, proof.ids);
    if (missing.conversations > 0) return `含 ${missing.conversations} 个当前库没有的对话（可能是你删掉的），按历史保留`;
    return missing.revisions > 0 ? `含 ${missing.revisions} 个当前库没有的消息版本，按历史保留` : undefined;
  }
  return await runtimeDataSetFileState(local.binding.paths.databasePath) === proof.by.files
    ? undefined : `证明它的历史库（${local.candidate.id}）在检查之后有改动，请重新检查`;
}

function foreignItem(
  found: DiscoveredForeignRuntimeRoot,
  itemPath: string,
  tree: TreeFacts | undefined,
  reason: string,
  detail?: string
): RuntimeBackupCleanupItem {
  const createdAt = foreignCreatedAt(found);
  return {
    key: `${FOREIGN_KEY_PREFIX}${found.id}`, kind: 'foreign-history', name: foreignName(found), path: itemPath,
    origin: foreignOrigin(found), inCurrentDataSet: false,
    bytes: (tree?.bytes ?? 0n).toString(), reclaimableBytes: (tree?.reclaimableBytes ?? 0n).toString(), fileCount: tree?.fileCount ?? 0,
    ...(createdAt !== undefined ? { createdAt: new Date(createdAt).toISOString() } : {}),
    deletable: false, reason, ...(detail ? { detail } : {})
  };
}

function foreignName(found: DiscoveredForeignRuntimeRoot): string {
  const key = found.scope.startsWith('workspace:') ? found.scope.slice('workspace:'.length).replace(/-([a-f0-9]{8})[a-f0-9]{56}$/, '-$1') : '';
  const scope = key ? ` · 工作区库 ${key}` : '';
  if (found.location.kind === 'archive') return `${found.name}${scope}`;
  return `${found.name}${scope}${found.archiveName ? ` · 归档 ${found.archiveName}` : ''}`;
}

function foreignOrigin(found: DiscoveredForeignRuntimeRoot): string {
  const workspace = found.scope.startsWith('workspace:') ? '（工作区库）' : '';
  if (found.location.kind === 'archive') {
    return found.location.side === 'previous' ? `以前的数据目录里的归档${workspace}` : `“归档并重置”的归档${workspace}`;
  }
  const beside = found.location.side === 'previous' ? '以前的数据目录旁的' : '';
  return `${beside}拷来目录里的${found.archiveName ? '归档' : '库'}${workspace}`;
}

function foreignCreatedAt(found: DiscoveredForeignRuntimeRoot): number | undefined {
  if (found.location.kind === 'archive') return utcSlugTime(found.name);
  if (found.archiveName) return utcSlugTime(found.archiveName);
  return utcSlugTime(found.location.containerName.split(COPIED_ASIDE_MARKER).pop() ?? '');
}

/** Why a foreign root that did not pass verification is kept, in its own words. */
function foreignRefusal(entry: ForeignRuntimeHistoryEntry): string {
  const reason = bare(entry.reason ?? '原因未知');
  if (entry.status === 'failed') return `未通过核验：${reason}，原样保留`;
  return reason.startsWith('暂时无法核验') ? `${reason}，这次不能删除` : `暂时无法核验：${reason}，这次不能删除`;
}

/** A reason in words (without its closing verdict) for a database of a foreign root that could not be read. */
function foreignReadProblem(error: unknown, subject: string): string {
  if (error instanceof CleanupRefusal) return bare(error.message);
  if (error instanceof ForeignRuntimeHistoryRejection) {
    const text = bare(error.message);
    return error.status === 'unavailable' && !text.startsWith('暂时无法') ? `暂时无法核对：${text}` : text;
  }
  return bare(unreadableReason(error, subject));
}

/** A reason without its closing punctuation and verdict, to be completed by the caller's. */
function bare(text: string): string {
  let result = text.trim();
  for (;;) {
    const next = result.replace(/[。.，,；;\s]+$/u, '').replace(/(?:它原样保留，不会被删除|原样保留|按历史保留|一律保留|不处理)$/u, '');
    if (next === result) return result;
    result = next;
  }
}

function hasDataRoot(location: { dataRootRelativePath: string }): boolean {
  return location.dataRootRelativePath === VSCODE_RUNTIME_ACTIVE_DIRECTORY
    || location.dataRootRelativePath.endsWith(`/${VSCODE_RUNTIME_ACTIVE_DIRECTORY}`);
}

/** The located control root of a foreign root: `<archive>`, or `.limcode-runtime`/an archive inside a copied directory. */
function foreignUnit(location: { containerPath: string; dataRootRelativePath: string }): string {
  return path.dirname(path.join(location.containerPath, ...location.dataRootRelativePath.split('/')));
}

function foreignPointer(location: { containerPath: string; dataRootRelativePath: string }): string {
  return path.join(foreignUnit(location), ROOT_BINDING_POINTER_FILE);
}

/** Where a discovered entry is listed: its control root, or the directory itself when it has no data root. */
function foreignListedPath(location: { containerPath: string; dataRootRelativePath: string }): string {
  return hasDataRoot(location)
    ? foreignUnit(location)
    : path.join(location.containerPath, ...location.dataRootRelativePath.split('/').filter(Boolean));
}

function foreignSubject(id: string, relative?: string): string {
  return `foreign:${id}${relative ? `:${relative}` : ''}`;
}

/** Files of databases this process may hold SQLite locks on (runtimeForeignHistory) and of every local data set. */
async function heldFiles(configurationRootPath: string, databaseFiles: DatabaseFiles): Promise<HeldDatabaseFiles> {
  return new Set([...await heldDatabaseFiles(configurationRootPath), ...databaseFiles.keys()]);
}

/** Whether any file of a database (main, -wal, -shm, -journal) is one of `held` (lstat only). */
async function isHeldDatabase(databasePath: string, held: HeldDatabaseFiles): Promise<boolean> {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const info = await fs.lstat(`${databasePath}${suffix}`, { bigint: true }).catch(() => undefined);
    if (info && held.has(`${info.dev}:${info.ino}`)) return true;
  }
  return false;
}

/** Measured only when reached without a link from its container. */
async function linkFreeTree(containerPath: string, target: string): Promise<TreeFacts | undefined> {
  return await noSymbolicPath(containerPath, target) ? describeTree(target).catch(() => undefined) : undefined;
}

/** LimCode's atomic-write temporaries. */
function isLimCodeTransient(name: string): boolean {
  return name.endsWith('.tmp');
}

/** Claims (maintenance, admission and their quarantined generations) LimCode may have left. */
function isClaimName(name: string): boolean {
  return name.endsWith('.runtime-maintenance') || name.includes('.runtime-maintenance.generation-')
    || name.endsWith('.runtime-admission') || name.includes('.runtime-admission.generation-');
}

function unionIds(...parts: Array<RuntimeDataSetHistoryIds | undefined>): RuntimeDataSetHistoryIds {
  const conversations = new Set<string>();
  const messageRevisions = new Set<string>();
  for (const part of parts) {
    for (const id of part?.conversations ?? []) conversations.add(id);
    for (const id of part?.messageRevisions ?? []) messageRevisions.add(id);
  }
  return { conversations: [...conversations], messageRevisions: [...messageRevisions] };
}

function sameIdentity(left: { dataSetId: string; rootInstanceId: string }, right: { dataSetId: string; rootInstanceId: string }): boolean {
  return left.dataSetId === right.dataSetId && left.rootInstanceId === right.rootInstanceId;
}

function localLabel(local: LocalDataSet): string {
  return local.current ? CURRENT_LABEL : `历史库（${local.candidate.id}）`;
}

// ---------------------------------------------------------------------------------------------
// Filesystem helpers (never follow symbolic links)

async function describeTree(root: string, exclude: readonly string[] = []): Promise<TreeFacts> {
  const skipped = new Set(exclude.map(comparable));
  const lines: string[] = [];
  let bytes = 0n;
  let reclaimableBytes = 0n;
  let fileCount = 0;
  let symbolicLink = false;
  let unsupported = false;
  let temporary = false;
  const rootInfo = await fs.lstat(root, { bigint: true });
  const queue: string[] = [root];
  while (queue.length > 0) {
    const current = queue.pop()!;
    const info = current === root ? rootInfo : await fs.lstat(current, { bigint: true });
    const relative = path.relative(root, current).split(path.sep).join('/');
    const state = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.nlink}`;
    if (info.isSymbolicLink()) {
      symbolicLink = true;
      lines.push(`l ${relative} ${state}`);
    } else if (info.isFile()) {
      fileCount += 1;
      bytes += info.size;
      if (info.nlink <= 1n) reclaimableBytes += info.size;
      if (path.basename(current).endsWith('.tmp')) temporary = true;
      lines.push(`f ${relative} ${state}`);
    } else if (info.isDirectory()) {
      lines.push(`d ${relative} ${state}`);
      for (const name of await fs.readdir(current)) {
        const child = path.join(current, name);
        if (!skipped.has(comparable(child))) queue.push(child);
      }
    } else {
      unsupported = true;
      lines.push(`o ${relative} ${state}`);
    }
  }
  lines.sort();
  return {
    digest: createHash('sha256').update(lines.join('\n')).digest('hex'),
    bytes, reclaimableBytes, fileCount, symbolicLink, unsupported, temporary,
    modifiedAt: Number(rootInfo.mtimeMs)
  };
}

async function noSymbolicPath(root: string, target: string): Promise<boolean> {
  try { await assertNoSymbolicPath(root, target); return true; }
  catch { return false; }
}

/** Like assertNoSymbolicPath, but a not-yet-created tail is allowed. */
async function assertNoSymbolicPrefix(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Backup cleanup path escapes its configuration root.');
  }
  let current = root;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, segment);
    const info = await lstatOrUndefined(current);
    if (!info) return;
    if (info.isSymbolicLink()) throw new Error(`Backup cleanup path is a symbolic link: ${current}`);
  }
}

async function lstatOrUndefined(file: string) {
  try { return await fs.lstat(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    throw error;
  }
}

async function readDirectoryNames(directory: string): Promise<string[]> {
  try { return await fs.readdir(directory); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Identities and keys

function itemKey(kind: RuntimeBackupKind, configurationRootPath: string, itemPath: string): string {
  const base = kind === 'copied-data-root' ? path.dirname(configurationRootPath) : configurationRootPath;
  return `${kind}:${path.relative(base, itemPath).split(path.sep).join('/')}`;
}

function backupSubject(configurationRootPath: string, backupDirectory: string): string {
  return `backup:${comparable(path.relative(configurationRootPath, backupDirectory)).split(path.sep).join('/')}`;
}

function dataSetSubject(candidateId: string): string {
  return `data-set:${candidateId}`;
}

function identityKey(identity: { dataSetId: string; rootInstanceId: string }): string {
  return `${identity.dataSetId}:${identity.rootInstanceId}`;
}

function identityWithGeneration(binding: HistoricalRootBinding): string {
  return `${binding.dataSetId}:${binding.rootInstanceId}:${binding.rootGeneration}:${binding.pointerRevision}:${binding.runtimeKernelEpoch}`;
}

/** Same data set at the same place: identity and every path (platform path comparison). */
function sameDataSet(left: HistoricalRootBinding, right: HistoricalRootBinding): boolean {
  return left.dataSetId === right.dataSetId && left.rootInstanceId === right.rootInstanceId
    && (Object.keys(right.paths) as Array<keyof RuntimeRootPaths>).every((key) => comparable(left.paths[key]) === comparable(right.paths[key]))
    && Object.keys(left.paths).length === Object.keys(right.paths).length;
}

/** Same data set, generation, pointer revision and epoch. */
function sameBinding(left: HistoricalRootBinding, right: HistoricalRootBinding): boolean {
  return sameDataSet(left, right) && left.rootGeneration === right.rootGeneration
    && left.pointerRevision === right.pointerRevision && left.runtimeKernelEpoch === right.runtimeKernelEpoch;
}

function isTextArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
