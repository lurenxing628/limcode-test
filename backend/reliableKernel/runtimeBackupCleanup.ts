import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import { DATA_ROOT_BACKUPS_DIR } from '../capabilities/vscodeStorage/constants';
import { createRuntimeRootPaths, ROOT_BINDING_POINTER_FILE, ROOT_BINDING_PENDING_FILE, type RuntimeRootPaths } from './contracts';
import { CUTOVER_BACKUPS_DIRECTORY, CUTOVER_JOURNAL_FILE, CUTOVER_REQUEST_FILE } from './physicalCutover';
import type { RepositoryGetRead } from './repositories';
import { parseHistoricalRootBinding, type HistoricalRootBinding } from './rootAuthority';
import type { RuntimeDatabase } from './runtimeDatabase';
import { comparable } from './runtimeDataSetBulkCopy';
import {
  readRuntimeBackupFacts, readRuntimeDataSetFacts, runtimeDataSetFileState, type RuntimeDataSetHistoryIds
} from './runtimeDataSetFacts';
import {
  BACKUP_NAME as MERGE_BACKUP_NAME, RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY, RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY
} from './runtimeDataSetMerge';
import { readRuntimeDataSetMergeLedger } from './runtimeDataSetMergeLedger';
import {
  MIGRATION_COMPLETION_KIND, RETIRED_EPOCH_3_TO_4_JOURNAL_FILE, RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY,
  RUNTIME_EPOCH_MIGRATION_COMPLETION_FILE, RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE
} from './runtimeEpochMigration';
import { withRuntimeDataRootAdmission, withRuntimeMaintenance, withRuntimeMaintenanceActivity } from './runtimeHostControl';
import { assertNoSymbolicPath, requireCompleteRuntimeDataSet } from './runtimeStorageInspection';
import {
  inspectVscodeRuntimeDataSets, resolveVscodeRuntimeMergeLedgerRoot, VSCODE_RUNTIME_ACTIVE_DIRECTORY,
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
 * Three kinds can be deleted: upgrade backups (epoch-migration-backups/), pre-merge backups of the
 * target (merge-backups/) and source backups before finalization (merge-source-backups/). Archives
 * of 归档并重置, directories copied aside by a data-root relocation, the old-format backups/ of a
 * control root and .limcode-data-backups are only listed. Planning reads the copies without claims
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
  | 'epoch-migration' | 'merge-target' | 'merge-source'
  | 'reset-archive' | 'copied-data-root' | 'legacy-cutover' | 'data-backups';

/** Kinds whose copies can be proven and deleted; every other kind is listed only. */
export const RUNTIME_BACKUP_DELETABLE_KINDS: readonly RuntimeBackupKind[] = Object.freeze(['epoch-migration', 'merge-target', 'merge-source']);

export interface RuntimeBackupCleanupItem {
  /** Stable for one plan: kind and path relative to the configuration root (or its parent). */
  key: string;
  kind: RuntimeBackupKind;
  name: string;
  path: string;
  /** The data set whose control root holds the copy. */
  dataSetCandidateId?: string;
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
}

export interface RuntimeBackupCleanupResult {
  deleted: Array<{ key: string; name: string; path: string; bytes: string; reclaimableBytes: string }>;
  kept: Array<{ key: string; name: string; path: string; reason: string; detail?: string }>;
  /** Verified and renamed for deletion, but not removed completely; the next cleanup finishes them. */
  unfinished: Array<{ key: string; name: string; path: string; reason: string; detail?: string }>;
}

/** The data set open in this window: its binding and its worker reader. */
export type RuntimeBackupCleanupCurrent = Pick<RuntimeDatabase, 'binding' | 'snapshot'>;

export type RuntimeBackupCleanupFaultPoint = 'before-rename' | 'after-rename' | 'after-verify';

export interface RuntimeBackupCleanupOptions {
  onProgress?(message: string): void;
  /** The clock of the age rules (tests). */
  now?(): number;
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

const PROOFS = new WeakMap<RuntimeBackupCleanupPlan, ReadonlyMap<string, BackupProof>>();

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
  const leftovers = await settleInterruptedDeletions(configurationRootPath, roots, problem);
  if (leftovers.restored.length > 0) ({ roots, databaseFiles } = await listControlRoots(configurationRootPath, current, () => undefined));
  const ledger = await readLedgerFacts(configurationRootPath);
  const items: RuntimeBackupCleanupItem[] = [];
  const proofs = new Map<string, BackupProof>();
  const cache = new CoverageCache(configurationRootPath);
  for (const root of roots) {
    try {
      for (const kind of RUNTIME_BACKUP_DELETABLE_KINDS as DeletableKind[]) {
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
      items.push(...await listKeptBackups(configurationRootPath, root));
    } catch (error) {
      problem(`${root.controlRootPath} 里的备份没有全部列出。`, error);
    }
  }
  try {
    items.push(...await listConfigurationLevelBackups(configurationRootPath));
  } catch (error) {
    problem('数据目录里和旁边的旧备份没有全部列出。', error);
  }
  await cache.prune();
  const plan: RuntimeBackupCleanupPlan = {
    configurationRootPath, checkedAt: new Date(now()).toISOString(), items,
    finishedDeletions: leftovers.finished, restoredDeletions: leftovers.restored, problems, details
  };
  PROOFS.set(plan, proofs);
  return plan;
}

/**
 * Deletes the confirmed copies of a plan of this process. Each one is verified again under the
 * configuration admission and its control root's maintenance (published as 清理备份 to waiting
 * windows): the copy is exactly as listed and is not a hard link of a local database, the local
 * data set has the same identity and generation, no operation is in progress, the newest pre-merge
 * backup stays, and its history is still covered. After the rename the coverage is checked once
 * more; a copy that is no longer covered gets its name back. Anything else keeps the copy.
 */
export async function deleteRuntimeBackups(
  plan: RuntimeBackupCleanupPlan,
  current: RuntimeBackupCleanupCurrent,
  keys: readonly string[],
  options: RuntimeBackupDeletionOptions = {}
): Promise<RuntimeBackupCleanupResult> {
  const proofs = PROOFS.get(plan);
  if (!proofs) throw new Error('这份备份清单不是本窗口刚才核对的结果，请重新检查。');
  const configurationRootPath = plan.configurationRootPath;
  const now = options.now ?? Date.now;
  const result: RuntimeBackupCleanupResult = { deleted: [], kept: [], unfinished: [] };
  const selected: BackupProof[] = [];
  for (const key of new Set(keys)) {
    const proof = proofs.get(key);
    const item = plan.items.find((entry) => entry.key === key);
    if (!proof || !item?.deletable) {
      if (item) result.kept.push({ key, name: item.name, path: item.path, reason: '不在可以删除的清单里' });
      continue;
    }
    selected.push(proof);
  }
  if (selected.length === 0) return result;
  const byRoot = new Map<string, BackupProof[]>();
  for (const proof of selected) {
    const group = byRoot.get(comparable(proof.controlRootPath)) ?? [];
    group.push(proof);
    byRoot.set(comparable(proof.controlRootPath), group);
  }
  const total = selected.length;
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

async function readUpgradeCompletion(directory: string): Promise<UpgradeCompletion | string> {
  const file = path.join(directory, RUNTIME_EPOCH_MIGRATION_COMPLETION_FILE);
  const info = await lstatOrUndefined(file);
  if (!info) return '没有升级完成记录（可能是旧版本或没有完成的升级留下的），按历史保留';
  if (!info.isFile()) return '升级完成记录不是普通文件，不处理';
  let record: Record<string, unknown>;
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
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
  const saved = await readBindingFile(path.join(directory, `root-binding.epoch-${record.fromEpoch}.json`));
  if (typeof saved === 'string' || !sameBinding(saved, previousBinding) || previousBinding.runtimeKernelEpoch !== record.fromEpoch
    || nextBinding.runtimeKernelEpoch !== 5 || !sameDataSet(previousBinding, nextBinding)) {
    return '升级完成记录与备份里的身份记录不一致，按历史保留';
  }
  return {
    fromEpoch: record.fromEpoch, previousBinding, nextBinding, completedAt,
    recordedAt: Math.max(info.mtimeMs, info.ctimeMs)
  };
}

async function readBindingFile(file: string): Promise<HistoricalRootBinding | string> {
  const info = await lstatOrUndefined(file);
  if (!info?.isFile()) return '备份里没有身份记录（root-binding），不处理';
  try {
    return parseHistoricalRootBinding(JSON.parse(await fs.readFile(file, 'utf8')) as unknown);
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

async function listKeptBackups(configurationRootPath: string, root: ControlRoot): Promise<RuntimeBackupCleanupItem[]> {
  const items: RuntimeBackupCleanupItem[] = [];
  const legacy = path.join(root.controlRootPath, CUTOVER_BACKUPS_DIRECTORY);
  if (await lstatOrUndefined(legacy)) {
    items.push(await keptItem(configurationRootPath, configurationRootPath, 'legacy-cutover', legacy, root.candidateId,
      '旧格式备份（升级到 SQLite 内核之前的数据），从未导入；本版本只列出，不删除'));
  }
  const archives = path.join(root.scopeRootPath, RESET_ARCHIVES_DIRECTORY);
  const info = await lstatOrUndefined(archives);
  if (info?.isDirectory() && await noSymbolicPath(configurationRootPath, archives)) {
    for (const name of (await readDirectoryNames(archives)).sort()) {
      items.push(await keptItem(configurationRootPath, configurationRootPath, 'reset-archive', path.join(archives, name), root.candidateId,
        '“归档并重置”时整份保留的历史库，含当时的对话；以后的版本会支持查看和合并，本版本只列出，不删除'));
    }
  } else if (info) {
    items.push(await keptItem(configurationRootPath, configurationRootPath, 'reset-archive', archives, root.candidateId,
      '“归档并重置”的归档，含对话；本版本只列出，不删除'));
  }
  return items;
}

async function listConfigurationLevelBackups(configurationRootPath: string): Promise<RuntimeBackupCleanupItem[]> {
  const items: RuntimeBackupCleanupItem[] = [];
  const dataBackups = path.join(configurationRootPath, DATA_ROOT_BACKUPS_DIR);
  if (await lstatOrUndefined(dataBackups)) {
    items.push(await keptItem(configurationRootPath, configurationRootPath, 'data-backups', dataBackups, undefined,
      '旧版本开发数据的重置备份；本版本只列出，不删除'));
  }
  const parent = path.dirname(configurationRootPath);
  const prefix = `${path.basename(configurationRootPath)}${COPIED_ASIDE_MARKER}`;
  for (const name of (await readDirectoryNames(parent)).filter((entry) => entry.startsWith(prefix)).sort()) {
    // Only the entry itself is checked for a link: the data directory's parent is not LimCode's.
    items.push(await keptItem(configurationRootPath, path.join(parent, name), 'copied-data-root', path.join(parent, name), undefined,
      '迁移数据目录时从别处拷来、挪到旁边保留的 LimCode 数据，含对话；以后的版本会支持查看和合并，本版本只列出，不删除'));
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
  reason: string
): Promise<RuntimeBackupCleanupItem> {
  const linkFree = await noSymbolicPath(containerRoot, itemPath);
  const tree = linkFree ? await describeTree(itemPath).catch(() => undefined) : undefined;
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
    else await writeVerifiedMark(deleting);
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
async function writeVerifiedMark(directory: string): Promise<void> {
  const file = path.join(directory, VERIFIED_MARKER_FILE);
  // A stale mark (or anything else of that name, never followed) goes first; the new one is created exclusively.
  await fs.rm(file, { force: true });
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify({ kind: VERIFIED_MARKER_KIND, name: path.basename(directory) })}\n`, 'utf8');
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
  const file = path.join(directory, VERIFIED_MARKER_FILE);
  if (!(await lstatOrUndefined(file))?.isFile()) return false;
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as { kind?: unknown; name?: unknown } | null;
    return value?.kind === VERIFIED_MARKER_KIND && value.name === path.basename(directory);
  } catch {
    return false;
  }
}

/**
 * `.deleting-*` leftovers of an interrupted cleanup, under the same claims as a deletion: a verified
 * one is removed; one interrupted before its last check gets its name back and is checked again.
 */
async function settleInterruptedDeletions(
  configurationRootPath: string,
  roots: readonly ControlRoot[],
  problem: (text: string, error?: unknown) => void
): Promise<{ finished: string[]; restored: string[] }> {
  const finished: string[] = [];
  const restored: string[] = [];
  const pending: Array<{ root: ControlRoot; leftovers: Array<{ path: string; original: string }> }> = [];
  for (const root of roots) {
    const leftovers: Array<{ path: string; original: string }> = [];
    for (const kind of RUNTIME_BACKUP_DELETABLE_KINDS as DeletableKind[]) {
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
  if (pending.length === 0) return { finished, restored };
  await withRuntimeDataRootAdmission(configurationRootPath, () => withRuntimeMaintenanceActivity({
    ...ACTIVITY, stage: '正在收尾上次没有删完的备份'
  }, async () => {
    for (const { root, leftovers } of pending) {
      await withRuntimeMaintenance(root.paths, () => withRuntimeMaintenanceActivity({
        ...ACTIVITY, stage: '正在收尾上次没有删完的备份'
      }, async () => {
        for (const leftover of leftovers) {
          const name = path.basename(leftover.path);
          try {
            const info = await lstatOrUndefined(leftover.path);
            if (!info) continue;
            if (!info.isDirectory() || !await noSymbolicPath(configurationRootPath, leftover.path)) {
              problem(`上次没有删完的 ${name} 不是普通目录，没有处理。`);
              continue;
            }
            if (await hasVerifiedMark(leftover.path)) {
              await removeVerifiedDirectory(leftover.path);
              await syncDirectoryDurably(path.dirname(leftover.path)).catch(() => undefined);
              finished.push(leftover.path);
              continue;
            }
            if (await lstatOrUndefined(leftover.original)) {
              problem(`上次没有删完的 ${name} 没有核对完，原来的名字已被占用，没有改回，也没有删除。`);
              continue;
            }
            await fs.rm(path.join(leftover.path, VERIFIED_MARKER_FILE), { force: true });
            await fs.rename(leftover.path, leftover.original);
            await syncDirectoryDurably(path.dirname(leftover.path)).catch(() => undefined);
            restored.push(leftover.original);
          } catch (error) {
            problem(`上次没有删完的 ${name} 这次没有处理完，保留，下次检查时再试。`, error);
          }
        }
      }));
    }
  }));
  return { finished, restored };
}

// ---------------------------------------------------------------------------------------------
// Filesystem helpers (never follow symbolic links)

async function describeTree(root: string): Promise<TreeFacts> {
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
      for (const name of await fs.readdir(current)) queue.push(path.join(current, name));
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
