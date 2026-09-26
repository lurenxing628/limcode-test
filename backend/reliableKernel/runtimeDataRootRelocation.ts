import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import { isPathInside, isSamePath } from '../capabilities/filesystem/pathContainment';
import { INDEX_FILE, RECORDS_DIR, REGISTERED_STORAGE_ROOT_DIRS } from '../capabilities/vscodeStorage/constants';
import { RUNTIME_KERNEL_EPOCH } from './contracts';
import type { HistoricalRootBinding } from './rootAuthority';
import { initializeEmptyRuntimeRoot, RuntimeDatabase } from './runtimeDatabase';
import {
  mergeRuntimeDataSetIntoDatabase, precopyRuntimeDataSetCas, type RuntimeDataSetMergeOptions, type RuntimeDataSetMergeResult
} from './runtimeDataSetMerge';
import { withRuntimeDataRootAdmission, withRuntimeMaintenance } from './runtimeHostControl';
import { requireCompleteRuntimeDataSet } from './runtimeStorageInspection';
import {
  assertConfigurationRootRuntimesOffline, createVscodeRootAuthority, inspectVscodeRuntimeDataSets, markVscodeRuntimeDataSetKept,
  resolveVscodeRuntimeDataRoot, resolveVscodeRuntimeDataSet, resolveVscodeRuntimeDataSetScopeRoot, selectVscodeRuntimeDataSet,
  VSCODE_RUNTIME_CONTROL_DIRECTORY, VSCODE_RUNTIME_SELECTION_FILE, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY
} from './vscodeRootAuthority';

/**
 * Data-root relocation: moves this installation's LimCode data directory (configuration root) to
 * another directory. A RootBinding stores absolute paths and is checked field by field, so the
 * directory is never copied as a whole: the target gets its own fresh Runtime root, the selected
 * data set is merged into it by the historical-merge engine in migration mode (every row through
 * ordinary Repository inserts, CAS objects verified), the registered configuration entries are
 * copied (or merged into an existing LimCode directory), and only then is the data-root pointer
 * switched. The old directory is never modified or deleted by the move itself.
 *
 * Phases (the caller orchestrates windows and the pointer):
 * 1. plan: read-only checks and sizes;
 * 2. stage (online): initialize the target root and pre-copy CAS while windows keep working;
 * 3. complete (exclusive, every Host of the old directory offline): merge, configuration,
 *    selection, completion marker, then the caller's pointer switch. Any failure before the
 *    switch removes what the relocation created in the target; the old directory stays current.
 */

/** Relocation state kept in the target directory (never in the old one). */
export const DATA_ROOT_RELOCATION_MARKER_FILE = '.limcode-data-root-relocation.json';
const MARKER_KIND = 'limcode-data-root-relocation';
/** Configuration versions replaced in an existing LimCode target are kept here. */
export const DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY = '.limcode-relocation-backups';
/** Names that prove a directory holds LimCode data (see assertDataRootAvailable). */
const RUNTIME_ENTRY_NAMES: readonly string[] = [
  VSCODE_RUNTIME_CONTROL_DIRECTORY, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, VSCODE_RUNTIME_SELECTION_FILE
];
const REGISTERED_DIRECTORIES: ReadonlySet<string> = new Set(REGISTERED_STORAGE_ROOT_DIRS);
/** Files operating systems drop into any directory; they do not make a directory "used". */
const IGNORABLE_ENTRY_NAMES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);
const CLOUD_SYNC_SEGMENT = /^(onedrive.*|dropbox|icloud ?drive|iclouddrive|mobile documents|cloudstorage|google ?drive|googledrive|my drive|box|box sync|pcloud ?drive|nutstore|坚果云|百度网盘|baidunetdisk|baidusyncdisk|seafile|nextcloud|owncloud|synologydrive|mega|yandex\.disk)$/i;
/** Free space kept beyond the estimate (SQLite journal, CAS temporary files). */
const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

export class DataRootRelocationError extends Error {
  public constructor(public readonly code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'DataRootRelocationError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

/** A configured data directory that is missing or empty (an unmounted drive, a lost share). */
export class DataRootUnavailableError extends Error {
  public readonly code = 'data-root-unavailable';

  public constructor(public readonly dataRootPath: string, public readonly reason: 'missing' | 'not-directory' | 'empty' | 'unreadable', cause?: unknown) {
    super(dataRootUnavailableMessage(dataRootPath, reason));
    this.name = 'DataRootUnavailableError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export type DataRootRelocationTarget =
  /** Missing, empty, or only unrelated files (then `unrelatedEntries` > 0); may hold LimCode configuration only. */
  | { kind: 'empty'; unrelatedEntries: number; hasConfiguration: boolean }
  /** LimCode data created at this very path: the selected data set there receives the merge. */
  | { kind: 'limcode'; receivingId: string; dataSetIds: string[] }
  /** LimCode data copied here from elsewhere (its RootBindings name another path). */
  | { kind: 'copied'; message: string }
  /** Not usable as a data directory at all. */
  | { kind: 'invalid'; message: string };

export interface DataRootRelocationDataSet {
  id: string;
  dataSetId: string;
  rootInstanceId: string;
  bytes: number;
}

export interface DataRootRelocationPlan {
  sourceRootPath: string;
  targetRootPath: string;
  target: DataRootRelocationTarget;
  current: DataRootRelocationDataSet & { casBytes: number };
  /** Other data sets of the old directory; each becomes its own (kept) data set in the target. */
  others: DataRootRelocationDataSet[];
  configurationBytes: number;
  /** Estimated bytes written to the target (content shared by hard links is not counted). */
  requiredBytes: number;
  freeBytes?: number;
  sameDevice: boolean;
  /** The relocation cannot start; each entry is a user-facing Chinese sentence. */
  problems: string[];
  /** Shown before confirmation; the relocation may still proceed. */
  warnings: string[];
}

export interface StagedDataRootRelocation {
  plan: DataRootRelocationPlan;
  relocationId: string;
  startedAt: string;
  /** Top-level entry names of the target before the relocation touched it. */
  preexisting: string[];
  /** The target directory itself was created by this relocation. */
  createdDirectory: boolean;
  /** Completion record of an earlier move into this LimCode directory, put back on rollback. */
  previousMarker?: RelocationMarker;
  receiving: { id: string; runtimeDataRootPath: string; binding: HistoricalRootBinding };
  precopied: { copiedCasObjects: number; linkedCasObjects: number; reusedCasObjects: number };
}

export interface DataRootRelocationResult {
  targetRootPath: string;
  merged: RuntimeDataSetMergeResult;
  configuration: { copiedFiles: number; replacedFiles: number; backupPath?: string };
  others: { migrated: string[]; leftBehind: Array<{ id: string; reason: string }> };
}

export interface DataRootRelocationOptions extends Pick<RuntimeDataSetMergeOptions, 'linkFile'> {
  onProgress?(message: string): void;
}

interface RelocationMarker {
  kind: typeof MARKER_KIND;
  state: 'staging' | 'complete';
  relocationId: string;
  sourceRootPath: string;
  /** Entries that existed before; a leftover staging only ever removes LimCode names not listed. */
  preexisting: string[];
  createdDirectory: boolean;
  startedAt: string;
  completedAt?: string;
  /** Complete only: data-set ids of the old directory that now live here (the current one included). */
  migrated?: string[];
}

interface ConfigurationJournal {
  /** Relative paths of files this relocation created inside directories that already existed. */
  added: string[];
  /** Relative paths whose previous target version was moved to the backup directory. */
  replaced: string[];
  backupRoot: string;
  copiedFiles: number;
}

/**
 * Startup guard. A configured data directory must exist and contain LimCode entries: an empty or
 * missing one is an unmounted drive or a lost share far more often than a new directory, and
 * opening it would silently create an empty history there. Nothing is created or written.
 */
export async function assertDataRootAvailable(dataRootPath: string): Promise<void> {
  const root = path.resolve(dataRootPath);
  let info;
  try {
    info = await fs.stat(root);
  } catch (error) {
    throw new DataRootUnavailableError(root, isMissing(error) ? 'missing' : 'unreadable', error);
  }
  if (!info.isDirectory()) throw new DataRootUnavailableError(root, 'not-directory');
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (error) {
    throw new DataRootUnavailableError(root, 'unreadable', error);
  }
  if (!entries.some(isLimCodeEntryName)) throw new DataRootUnavailableError(root, 'empty');
}

/** The directory is one LimCode can open (used before offering to go back to it). */
export async function inspectDataRootForReturn(dataRootPath: string): Promise<{ usable: boolean; message?: string }> {
  try {
    await assertDataRootAvailable(dataRootPath);
    const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: dataRootPath });
    const selected = inspection.candidates.find((candidate) => candidate.selected);
    if (!selected?.dataSetId) return { usable: false, message: '这个目录里没有可以打开的当前历史库。' };
    return { usable: true };
  } catch (error) {
    return { usable: false, message: errorMessage(error) };
  }
}

/** Read-only relocation plan; call again right before staging. */
export async function planDataRootRelocation(input: { sourceRootPath: string; targetRootPath: string }): Promise<DataRootRelocationPlan> {
  const sourceRootPath = path.resolve(input.sourceRootPath);
  const targetRootPath = path.resolve(input.targetRootPath);
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!path.isAbsolute(input.targetRootPath.trim())) problems.push('新数据目录必须是绝对路径。');
  const sourceReal = await realPathOfNearestExisting(sourceRootPath);
  const targetReal = await realPathOfNearestExisting(targetRootPath);
  if (isSamePath(sourceRootPath, targetRootPath) || isSamePath(sourceReal, targetReal)) {
    problems.push('新数据目录就是当前数据目录。');
  } else if (isPathInside(sourceRootPath, targetRootPath) || isPathInside(sourceReal, targetReal)) {
    problems.push('新数据目录不能放在当前数据目录里面。');
  } else if (isPathInside(targetRootPath, sourceRootPath) || isPathInside(targetReal, sourceReal)) {
    problems.push('新数据目录不能是当前数据目录的上级目录。');
  }
  const cloud = targetRootPath.split(/[\\/]+/).find((segment) => CLOUD_SYNC_SEGMENT.test(segment));
  if (cloud) {
    warnings.push(`新数据目录看起来在云同步目录里（${cloud}）。同步软件在 LimCode 写入时复制数据库文件可能导致数据损坏，建议选择不同步的本地目录。`);
  }

  const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: sourceRootPath });
  const selected = inspection.candidates.filter((candidate) => candidate.selected);
  if (selected.length !== 1 || !selected[0].dataSetId || !selected[0].rootInstanceId) {
    throw new DataRootRelocationError('data-root-relocation-no-current', '当前数据目录没有选定的历史库，无法迁移。');
  }
  const currentCandidate = selected[0];
  const currentBinding = await requireCompleteRuntimeDataSet(currentCandidate);
  const currentSize = await measureTree(currentCandidate.runtimeDataRootPath);
  const casSize = await measureTree(currentBinding.paths.casRootPath);
  const current = {
    id: currentCandidate.id, dataSetId: currentCandidate.dataSetId!, rootInstanceId: currentCandidate.rootInstanceId!,
    bytes: currentSize.bytes, casBytes: casSize.bytes
  };
  const others: DataRootRelocationDataSet[] = [];
  for (const candidate of inspection.candidates) {
    if (candidate.selected || !candidate.dataSetId || !candidate.rootInstanceId) continue;
    others.push({
      id: candidate.id, dataSetId: candidate.dataSetId, rootInstanceId: candidate.rootInstanceId,
      bytes: (await measureTree(candidate.runtimeDataRootPath)).bytes
    });
  }
  for (const problem of inspection.problems) {
    warnings.push(`旧目录里有一个无法读取的历史库不会被迁移，仍留在旧目录：${problem.message}`);
  }
  let configurationBytes = 0;
  for (const name of REGISTERED_STORAGE_ROOT_DIRS) {
    configurationBytes += (await measureTree(path.join(sourceRootPath, name))).bytes;
  }

  const target = problems.length > 0
    ? { kind: 'invalid' as const, message: problems[0] }
    : await classifyTarget(targetRootPath);
  if (target.kind === 'invalid' && problems.length === 0) problems.push(target.message);
  if (target.kind === 'copied') problems.push(target.message);
  if (target.kind === 'empty' && target.unrelatedEntries > 0) {
    warnings.push(`新数据目录里已有 ${target.unrelatedEntries} 个其它文件或文件夹，LimCode 会在旁边新建自己的目录；建议使用专用的空目录。`);
  }
  if (target.kind === 'limcode') {
    warnings.push('新数据目录里已有 LimCode 数据：当前历史会合并进去（同一条记录内容不同时整体取消，两边都不改）；设置按记录合并，同一项以当前在用的为准，被替换的旧版本放进新目录的备份文件夹。');
    const taken = new Set(target.dataSetIds);
    for (const other of others) {
      if (taken.has(other.id)) warnings.push(`旧目录里的历史库 ${other.id} 与新目录里已有的同名历史库冲突，不会迁移，仍留在旧目录。`);
    }
  }

  const writable = await writableProblem(targetRootPath);
  if (writable) problems.push(writable);
  const probe = await nearestExisting(targetRootPath);
  const sameDevice = probe !== undefined && (await fs.stat(probe)).dev === (await fs.stat(sourceRootPath)).dev;
  const othersBytes = others.reduce((sum, item) => sum + item.bytes, 0);
  // Same filesystem: CAS objects become hard links. The merged SQLite is written anew either way.
  const requiredBytes = current.bytes + othersBytes + configurationBytes - (sameDevice ? current.casBytes : 0);
  let freeBytes: number | undefined;
  if (probe) {
    try {
      const stats = await fs.statfs(probe);
      freeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch { /* free space unknown on this filesystem: the copy itself will fail cleanly */ }
  }
  if (freeBytes !== undefined && freeBytes < requiredBytes + FREE_SPACE_MARGIN_BYTES) {
    problems.push(`新数据目录所在磁盘剩余 ${formatBytes(freeBytes)}，迁移大约需要 ${formatBytes(requiredBytes + FREE_SPACE_MARGIN_BYTES)}。`);
  }
  return {
    sourceRootPath, targetRootPath, target, current, others, configurationBytes,
    requiredBytes, ...(freeBytes !== undefined ? { freeBytes } : {}), sameDevice, problems, warnings
  };
}

/**
 * Online phase: prepares the receiving root in the target and pre-copies the current data set's
 * CAS objects while every window keeps working (anything written meanwhile is transferred again
 * inside the exclusive merge). `sourceDatabase` is this window's open Runtime of the current data
 * set; the source is read through its SQLite Backup API, never by copying its files.
 */
export async function stageDataRootRelocation(
  planned: DataRootRelocationPlan,
  sourceDatabase: RuntimeDatabase | undefined,
  options: DataRootRelocationOptions = {}
): Promise<StagedDataRootRelocation> {
  const plan = await planDataRootRelocation({ sourceRootPath: planned.sourceRootPath, targetRootPath: planned.targetRootPath });
  if (plan.problems.length > 0) throw new DataRootRelocationError('data-root-relocation-precondition', plan.problems.join('\n'));
  if (plan.current.dataSetId !== planned.current.dataSetId || plan.target.kind !== planned.target.kind) {
    throw new DataRootRelocationError('data-root-relocation-changed', '确认之后当前历史库或新数据目录发生了变化，请重新开始迁移。');
  }
  const target = plan.targetRootPath;
  const relocationId = randomUUID();
  return withRuntimeDataRootAdmission(target, async () => {
    await removeLeftoverStaging(target);
    const previousMarker = await readMarker(target);
    const createdDirectory = !await pathExists(target);
    await fs.mkdir(target, { recursive: true });
    const preexisting = (await fs.readdir(target)).sort();
    const startedAt = new Date().toISOString();
    await writeMarker(target, {
      kind: MARKER_KIND, state: 'staging', relocationId, sourceRootPath: plan.sourceRootPath, preexisting, createdDirectory, startedAt
    });
    try {
      const receiving = await prepareReceivingRoot(plan);
      options.onProgress?.('正在预先复制正文文件');
      const precopied = await precopyRuntimeDataSetCas({ globalStoragePath: plan.sourceRootPath }, {
        candidateId: plan.current.id, expectedDataSetId: plan.current.dataSetId, expectedRootInstanceId: plan.current.rootInstanceId
      }, { configurationRootPath: target, binding: receiving.binding }, {
        ...(options.linkFile ? { linkFile: options.linkFile } : {}),
        ...(sourceDatabase ? { sourceDatabase } : {})
      });
      return {
        plan, relocationId, startedAt, preexisting, createdDirectory, receiving, precopied,
        ...(previousMarker ? { previousMarker } : {})
      };
    } catch (error) {
      await removeCreatedEntries(target, preexisting, createdDirectory, previousMarker).catch(() => undefined);
      throw error;
    }
  });
}

/** Removes what an abandoned stage created (e.g. the other windows could not be closed). */
export async function abandonStagedDataRootRelocation(staged: StagedDataRootRelocation): Promise<void> {
  await withRuntimeDataRootAdmission(staged.plan.targetRootPath,
    () => removeCreatedEntries(staged.plan.targetRootPath, staged.preexisting, staged.createdDirectory, staged.previousMarker));
}

/**
 * Exclusive phase. Call while holding the old directory's configuration admission after every
 * Host of it went offline (this window's own Runtime included). `publish` switches the data-root
 * pointer; it runs last, after the completion marker. Before it, any failure removes what this
 * relocation created in the target (an existing LimCode target gets its replaced configuration
 * back; rows merged into an existing data set there cannot be taken out again, see the report).
 */
export async function completeDataRootRelocation(
  staged: StagedDataRootRelocation,
  publish: () => Promise<void>,
  options: DataRootRelocationOptions = {}
): Promise<DataRootRelocationResult> {
  const { plan } = staged;
  const sourcePaths = { globalStoragePath: plan.sourceRootPath };
  const target = plan.targetRootPath;
  return withRuntimeDataRootAdmission(plan.sourceRootPath, () => withRuntimeDataRootAdmission(target, async () => {
    await assertConfigurationRootRuntimesOffline(plan.sourceRootPath);
    const journal: ConfigurationJournal = {
      added: [], replaced: [], copiedFiles: 0,
      backupRoot: path.join(target, DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY, `${timestampSlug()}-${staged.relocationId.slice(0, 8)}`)
    };
    try {
      const current = await resolveVscodeRuntimeDataSet(sourcePaths, plan.current.id);
      if (!current.selected || current.dataSetId !== plan.current.dataSetId || current.rootInstanceId !== plan.current.rootInstanceId) {
        throw new DataRootRelocationError('data-root-relocation-changed', '迁移期间当前历史库发生了变化，本次不迁移。');
      }
      options.onProgress?.('正在复制设置');
      await transferConfiguration(plan.sourceRootPath, target, journal);
      options.onProgress?.('正在迁移当前历史库');
      const merged = await mergeInto(sourcePaths, target, plan.current, staged.receiving.runtimeDataRootPath, options);
      const others = await migrateOthers(staged, options);
      if (plan.target.kind === 'empty') await selectVscodeRuntimeDataSet({ globalStoragePath: target }, staged.receiving.id);
      await writeMarker(target, {
        kind: MARKER_KIND, state: 'complete', relocationId: staged.relocationId, sourceRootPath: plan.sourceRootPath,
        preexisting: staged.preexisting, createdDirectory: staged.createdDirectory, startedAt: staged.startedAt,
        completedAt: new Date().toISOString(), migrated: [plan.current.id, ...others.migrated]
      });
      await publish();
      return {
        targetRootPath: target,
        merged,
        configuration: {
          copiedFiles: journal.copiedFiles, replacedFiles: journal.replaced.length,
          ...(journal.replaced.length > 0 ? { backupPath: journal.backupRoot } : {})
        },
        others
      };
    } catch (error) {
      await rollbackTarget(staged, journal).catch((rollbackError: unknown) => {
        console.error('[LimCode] 迁移失败后清理新数据目录时出错。', rollbackError);
      });
      throw error;
    }
  }));
}

/**
 * What "delete the old directory" removes: only LimCode's own entries of a directory this
 * installation moved away from. The directory itself, and anything else in it, stays.
 */
export async function planOldDataRootDeletion(input: {
  oldRootPath: string;
  currentRootPath: string;
  /** VS Code's own storage directory keeps the pointer file and is never removed itself. */
  keepEntries?: readonly string[];
}): Promise<{ entries: string[]; bytes: number; problems: string[]; unmigrated: string[] }> {
  const oldRoot = path.resolve(input.oldRootPath);
  const problems: string[] = [];
  if (isSamePath(oldRoot, path.resolve(input.currentRootPath))) problems.push('旧目录就是当前数据目录。');
  const marker = await readMarker(path.resolve(input.currentRootPath));
  if (marker?.state !== 'complete' || !isSamePath(path.resolve(marker.sourceRootPath), oldRoot)) {
    problems.push('找不到从这个目录迁移完成的记录，为避免误删，不能在这里删除它。');
  }
  const keep = input.keepEntries ?? [];
  let names: string[] = [];
  try { names = await fs.readdir(oldRoot); }
  catch (error) { if (!isMissing(error)) throw error; }
  // A kept file keeps its lock and temporaries (`<name>.lock`, …) as well.
  const kept = (name: string): boolean => keep.some((entry) => name === entry || name.startsWith(`${entry}.`));
  const entries = names.filter((name) => isLimCodeEntryName(name) && !kept(name)).sort();
  let bytes = 0;
  for (const name of entries) bytes += (await measureTree(path.join(oldRoot, name))).bytes;
  // Data sets of the old directory the completed move did not carry (left behind, or created
  // there afterwards) are named before they are deleted.
  const unmigrated: string[] = [];
  const migrated = new Set(marker?.migrated ?? []);
  try {
    const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: oldRoot });
    for (const candidate of inspection.candidates) {
      if (candidate.dataSetId && !migrated.has(candidate.id)) unmigrated.push(candidate.id);
    }
    for (const problem of inspection.problems) unmigrated.push(problem.id);
  } catch { /* nothing readable there */ }
  return { entries, bytes, problems, unmigrated };
}

/** Deletes the planned LimCode entries; every data set of the old directory must be offline. */
export async function deleteOldDataRoot(input: {
  oldRootPath: string;
  currentRootPath: string;
  keepEntries?: readonly string[];
}): Promise<{ removed: string[] }> {
  const oldRoot = path.resolve(input.oldRootPath);
  return withRuntimeDataRootAdmission(oldRoot, async () => {
    const plan = await planOldDataRootDeletion(input);
    if (plan.problems.length > 0) throw new DataRootRelocationError('data-root-old-delete-refused', plan.problems.join('\n'));
    await assertConfigurationRootRuntimesOffline(oldRoot);
    for (const name of plan.entries) {
      await fs.rm(path.join(oldRoot, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
    return { removed: plan.entries };
  });
}

async function classifyTarget(targetRootPath: string): Promise<DataRootRelocationTarget> {
  let info;
  try {
    info = await fs.lstat(targetRootPath);
  } catch (error) {
    if (isMissing(error)) return { kind: 'empty', unrelatedEntries: 0, hasConfiguration: false };
    return { kind: 'invalid', message: `无法读取新数据目录：${errorMessage(error)}` };
  }
  if (info.isSymbolicLink()) return { kind: 'invalid', message: '新数据目录不能是符号链接，请直接选择它指向的目录。' };
  if (!info.isDirectory()) return { kind: 'invalid', message: '新数据目录的位置上已经有一个文件。' };
  const leftover = await leftoverEntries(targetRootPath);
  const names = (await fs.readdir(targetRootPath)).filter((name) => !IGNORABLE_ENTRY_NAMES.has(name) && !leftover.has(name));
  const unrelatedEntries = names.filter((name) => !isLimCodeEntryName(name)).length;
  if (!names.some((name) => RUNTIME_ENTRY_NAMES.includes(name))) {
    return { kind: 'empty', unrelatedEntries, hasConfiguration: names.some((name) => REGISTERED_DIRECTORIES.has(name)) };
  }
  const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: targetRootPath });
  if (inspection.problems.some((problem) => problem.message.includes('RootBinding 不一致'))) {
    return {
      kind: 'copied',
      message: '新数据目录里的 LimCode 历史库是从别的位置拷贝过来的（记录的路径不是这里），目前还不能直接导入。请换一个空目录，或者先把那份数据放回原来的位置。'
    };
  }
  if (inspection.problems.length > 0) {
    return { kind: 'invalid', message: `新数据目录里的 LimCode 历史库无法读取：${inspection.problems[0].message}` };
  }
  const selected = inspection.candidates.filter((candidate) => candidate.selected);
  if (selected.length !== 1 || !selected[0].dataSetId) {
    return { kind: 'invalid', message: '新数据目录里有 LimCode 历史库，但没有选定当前库；请先在那里打开一次 LimCode，或换一个空目录。' };
  }
  // Only a current-epoch root receives rows through the current Repository codecs.
  if (selected[0].requiresRecovery || selected[0].runtimeKernelEpoch !== RUNTIME_KERNEL_EPOCH) {
    return { kind: 'invalid', message: '新数据目录里的当前历史库需要先在那里打开一次完成升级或恢复，才能接收迁移。' };
  }
  return { kind: 'limcode', receivingId: selected[0].id, dataSetIds: inspection.candidates.filter((item) => item.dataSetId).map((item) => item.id) };
}

async function prepareReceivingRoot(plan: DataRootRelocationPlan): Promise<StagedDataRootRelocation['receiving']> {
  const target = plan.targetRootPath;
  if (plan.target.kind === 'limcode') {
    const candidate = await resolveVscodeRuntimeDataSet({ globalStoragePath: target }, plan.target.receivingId);
    return { id: candidate.id, runtimeDataRootPath: candidate.runtimeDataRootPath, binding: await requireCompleteRuntimeDataSet(candidate) };
  }
  // A fresh root under the same id the current data set has in the old directory.
  const scopeRoot = resolveVscodeRuntimeDataSetScopeRoot(target, plan.current.id);
  const runtimeDataRootPath = resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot });
  const authority = createVscodeRootAuthority({ runtimeDataRootPath, configurationRootPath: target });
  const binding = await withRuntimeMaintenance(authority.expectedPaths(), () => initializeEmptyRuntimeRoot(authority));
  return { id: plan.current.id, runtimeDataRootPath, binding };
}

async function mergeInto(
  sourcePaths: { globalStoragePath: string },
  target: string,
  dataSet: DataRootRelocationDataSet,
  runtimeDataRootPath: string,
  options: DataRootRelocationOptions
): Promise<RuntimeDataSetMergeResult> {
  const authority = createVscodeRootAuthority({ runtimeDataRootPath, configurationRootPath: target });
  return withRuntimeMaintenance(authority.expectedPaths(), async () => {
    const database = await RuntimeDatabase.open(authority, { hostBootId: `data-root-relocation-${randomUUID()}` });
    try {
      return await mergeRuntimeDataSetIntoDatabase(sourcePaths, {
        candidateId: dataSet.id, expectedDataSetId: dataSet.dataSetId, expectedRootInstanceId: dataSet.rootInstanceId
      }, { configurationRootPath: target, database }, { migration: true, ...(options.linkFile ? { linkFile: options.linkFile } : {}) });
    } finally {
      await database.close();
    }
  });
}

/**
 * Every other data set of the old directory becomes its own data set under the same id in the
 * target, recorded as kept so it is never merged automatically there. One that cannot move (in use
 * by an old window, unfinished streaming, format, an id already taken) stays in the old directory.
 */
async function migrateOthers(
  staged: StagedDataRootRelocation,
  options: DataRootRelocationOptions
): Promise<DataRootRelocationResult['others']> {
  const { plan } = staged;
  const target = plan.targetRootPath;
  const result: DataRootRelocationResult['others'] = { migrated: [], leftBehind: [] };
  const taken = new Set(plan.target.kind === 'limcode' ? plan.target.dataSetIds : []);
  taken.add(staged.receiving.id);
  for (const [index, other] of plan.others.entries()) {
    if (taken.has(other.id)) {
      result.leftBehind.push({ id: other.id, reason: '新数据目录里已有同名历史库' });
      continue;
    }
    options.onProgress?.(`正在迁移其它历史库（${index + 1}/${plan.others.length}）`);
    const scopeRoot = resolveVscodeRuntimeDataSetScopeRoot(target, other.id);
    const existed = await pathExists(scopeRoot);
    const runtimeDataRootPath = resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot });
    try {
      if (existed && other.id !== 'default') throw new Error('新数据目录里已有这个历史库的目录');
      const authority = createVscodeRootAuthority({ runtimeDataRootPath, configurationRootPath: target });
      await withRuntimeMaintenance(authority.expectedPaths(), () => initializeEmptyRuntimeRoot(authority));
      await mergeInto({ globalStoragePath: plan.sourceRootPath }, target, other, runtimeDataRootPath, options);
      await markVscodeRuntimeDataSetKept(await resolveVscodeRuntimeDataSet({ globalStoragePath: target }, other.id));
      result.migrated.push(other.id);
    } catch (error) {
      result.leftBehind.push({ id: other.id, reason: errorMessage(error) });
      if (other.id === 'default') {
        await fs.rm(path.join(target, VSCODE_RUNTIME_CONTROL_DIRECTORY), { recursive: true, force: true }).catch(() => undefined);
      } else if (!existed) {
        await fs.rm(scopeRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
  return result;
}

/**
 * Registered configuration entries only (a custom data directory may hold other files of the
 * user). Missing target entries are copied; an existing LimCode target keeps its own records, a
 * record or file present on both sides with different content takes the current version and the
 * replaced one goes to the backup directory. Every copied file is verified by SHA-256.
 */
async function transferConfiguration(sourceRoot: string, targetRoot: string, journal: ConfigurationJournal): Promise<void> {
  for (const name of REGISTERED_STORAGE_ROOT_DIRS) {
    const source = path.join(sourceRoot, name);
    const info = await lstatOrUndefined(source);
    if (!info?.isDirectory()) continue;
    const target = path.join(targetRoot, name);
    if (await isRecordStore(source) && await pathExists(path.join(target, INDEX_FILE))) {
      await mergeRecordStore(source, target, name, journal);
    } else {
      await mergeTree(source, target, name, journal);
    }
  }
}

async function mergeTree(source: string, target: string, relative: string, journal: ConfigurationJournal): Promise<void> {
  const created = !await pathExists(target);
  if (created) await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (isTransientName(entry.name)) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const rel = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      await mergeTree(from, to, rel, journal);
    } else if (entry.isFile()) {
      await placeFile(from, to, rel, journal);
    } else if (entry.isSymbolicLink()) {
      const link = await fs.readlink(from);
      const existing = await lstatOrUndefined(to);
      if (existing?.isSymbolicLink() && await fs.readlink(to) === link) continue;
      if (existing) await backupEntry(to, rel, journal);
      else journal.added.push(rel);
      await fs.symlink(link, to);
    }
  }
}

async function placeFile(from: string, to: string, rel: string, journal: ConfigurationJournal): Promise<void> {
  const existing = await lstatOrUndefined(to);
  if (existing?.isFile() && existing.size === (await fs.stat(from)).size && await sha256File(to) === await sha256File(from)) return;
  if (existing) await backupEntry(to, rel, journal);
  else journal.added.push(rel);
  await copyVerified(from, to);
  journal.copiedFiles += 1;
}

async function copyVerified(from: string, to: string): Promise<void> {
  const temporary = `${to}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.copyFile(from, temporary, constants.COPYFILE_EXCL);
    if (await sha256File(temporary) !== await sha256File(from)) {
      throw new DataRootRelocationError('data-root-relocation-copy-mismatch', `复制后的文件与原文件不一致：${from}`);
    }
    await fs.rename(temporary, to);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function backupEntry(file: string, rel: string, journal: ConfigurationJournal): Promise<void> {
  const destination = path.join(journal.backupRoot, rel);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(file, destination);
  journal.replaced.push(rel);
}

interface RecordIndexEntry { id: string; file: string; updatedAt: string }

async function isRecordStore(directory: string): Promise<boolean> {
  return pathExists(path.join(directory, INDEX_FILE));
}

/** Union by record id; see transferConfiguration. */
async function mergeRecordStore(source: string, target: string, relative: string, journal: ConfigurationJournal): Promise<void> {
  const sourceIndex = await readRecordIndex(path.join(source, INDEX_FILE));
  const targetIndex = await readRecordIndex(path.join(target, INDEX_FILE));
  const merged = new Map(targetIndex.records.map((entry) => [entry.id, entry] as const));
  const fileOwners = new Map(targetIndex.records.map((entry) => [entry.file, entry.id] as const));
  let changed = false;
  await fs.mkdir(path.join(target, RECORDS_DIR), { recursive: true });
  for (const entry of sourceIndex.records) {
    const from = path.join(source, ...entry.file.split('/'));
    const existing = merged.get(entry.id);
    if (existing && isDeepStrictEqual(await readRecordBody(from), await readRecordBody(path.join(target, ...existing.file.split('/'))).catch(() => undefined))) {
      continue;
    }
    const owner = fileOwners.get(entry.file);
    if (owner !== undefined && owner !== entry.id) {
      throw new DataRootRelocationError('data-root-relocation-configuration-conflict',
        `新数据目录的设置里有同名文件属于另一条记录（${relative}/${entry.file}），整体取消迁移，两边都不改。`);
    }
    if (existing && existing.file !== entry.file) {
      await backupEntry(path.join(target, ...existing.file.split('/')), path.join(relative, ...existing.file.split('/')), journal);
      fileOwners.delete(existing.file);
    }
    await placeFile(from, path.join(target, ...entry.file.split('/')), path.join(relative, ...entry.file.split('/')), journal);
    merged.set(entry.id, entry);
    fileOwners.set(entry.file, entry.id);
    changed = true;
  }
  if (!changed) return;
  const indexPath = path.join(target, INDEX_FILE);
  await backupEntry(indexPath, path.join(relative, INDEX_FILE), journal);
  const temporary = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify({
      schemaVersion: sourceIndex.schemaVersion, savedAt: new Date().toISOString(), records: [...merged.values()]
    }, null, 2)}\n`, { flag: 'wx' });
    await fs.rename(temporary, indexPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function readRecordIndex(file: string): Promise<{ schemaVersion: unknown; records: RecordIndexEntry[] }> {
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    throw new DataRootRelocationError('data-root-relocation-configuration-unreadable', `设置索引无法读取，整体取消迁移：${file}（${errorMessage(error)}）`);
  }
  const index = value as { schemaVersion?: unknown; records?: unknown };
  if (!index || !Array.isArray(index.records)) {
    throw new DataRootRelocationError('data-root-relocation-configuration-unreadable', `设置索引格式无效，整体取消迁移：${file}`);
  }
  const records = (index.records as unknown[]).filter((entry): entry is RecordIndexEntry => {
    const record = entry as Partial<RecordIndexEntry> | null;
    return !!record && typeof record.id === 'string' && typeof record.file === 'string' && typeof record.updatedAt === 'string'
      && /^records\/[^/\\]+\.json$/i.test(record.file);
  });
  return { schemaVersion: index.schemaVersion, records };
}

/** A record file without its save timestamp: two saves of the same record compare equal. */
async function readRecordBody(file: string): Promise<unknown> {
  const body = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  delete body.savedAt;
  return body;
}

async function rollbackTarget(staged: StagedDataRootRelocation, journal: ConfigurationJournal): Promise<void> {
  const target = staged.plan.targetRootPath;
  for (const rel of [...journal.added].reverse()) {
    await fs.rm(path.join(target, rel), { recursive: true, force: true });
  }
  for (const rel of [...journal.replaced].reverse()) {
    const backup = path.join(journal.backupRoot, rel);
    const destination = path.join(target, rel);
    await fs.rm(destination, { recursive: true, force: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(backup, destination);
  }
  await removeCreatedEntries(target, staged.preexisting, staged.createdDirectory, staged.previousMarker);
}

/**
 * Removes LimCode entries that were not in the target before, and the directory if it created it.
 * An earlier completion record of this directory is written back instead of being removed.
 */
async function removeCreatedEntries(
  target: string,
  preexisting: readonly string[],
  createdDirectory: boolean,
  previousMarker?: RelocationMarker
): Promise<void> {
  const keep = new Set(preexisting);
  let names: string[];
  try { names = await fs.readdir(target); }
  catch (error) { if (isMissing(error)) return; throw error; }
  for (const name of names) {
    if (keep.has(name) || name === DATA_ROOT_RELOCATION_MARKER_FILE || isClaimName(name) || !isLimCodeEntryName(name)) continue;
    await fs.rm(path.join(target, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  if (previousMarker) await writeMarker(target, previousMarker);
  else await fs.rm(path.join(target, DATA_ROOT_RELOCATION_MARKER_FILE), { force: true });
  if (createdDirectory) await fs.rmdir(target).catch(() => undefined);
}

/** A staging marker left by an interrupted relocation: what it created is removed first. */
async function removeLeftoverStaging(target: string): Promise<void> {
  const marker = await readMarker(target);
  if (marker?.state === 'staging') await removeCreatedEntries(target, marker.preexisting, marker.createdDirectory);
}

async function leftoverEntries(target: string): Promise<Set<string>> {
  const marker = await readMarker(target);
  if (marker?.state !== 'staging') return new Set(marker ? [DATA_ROOT_RELOCATION_MARKER_FILE] : []);
  const keep = new Set(marker.preexisting);
  const names = await fs.readdir(target).catch(() => [] as string[]);
  return new Set(names.filter((name) => !keep.has(name) && isLimCodeEntryName(name)).concat(DATA_ROOT_RELOCATION_MARKER_FILE));
}

async function readMarker(root: string): Promise<RelocationMarker | undefined> {
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(path.join(root, DATA_ROOT_RELOCATION_MARKER_FILE), 'utf8')); }
  catch { return undefined; }
  const marker = value as Partial<RelocationMarker> | null;
  if (!marker || marker.kind !== MARKER_KIND || (marker.state !== 'staging' && marker.state !== 'complete')
    || typeof marker.sourceRootPath !== 'string' || typeof marker.createdDirectory !== 'boolean' || !Array.isArray(marker.preexisting)
    || !marker.preexisting.every((name) => typeof name === 'string')
    || (marker.migrated !== undefined && (!Array.isArray(marker.migrated) || !marker.migrated.every((id) => typeof id === 'string')))) {
    return undefined;
  }
  return marker as RelocationMarker;
}

/** Migration evidence of the current directory, e.g. for the settings view. */
export async function readDataRootRelocationRecord(root: string): Promise<{ sourceRootPath: string; completedAt?: string } | undefined> {
  const marker = await readMarker(path.resolve(root));
  return marker?.state === 'complete'
    ? { sourceRootPath: marker.sourceRootPath, ...(marker.completedAt ? { completedAt: marker.completedAt } : {}) }
    : undefined;
}

async function writeMarker(root: string, marker: RelocationMarker): Promise<void> {
  const file = path.join(root, DATA_ROOT_RELOCATION_MARKER_FILE);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    await syncDirectoryDurably(root);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function isLimCodeEntryName(name: string): boolean {
  return name.startsWith('.limcode-') || REGISTERED_DIRECTORIES.has(name);
}

/** Claim directories are owned by the claim primitives, even while being cleaned up. */
function isClaimName(name: string): boolean {
  return name.endsWith('.runtime-maintenance') || name.endsWith('.runtime-admission');
}

/** Record-store locks and atomic-write temporaries are never configuration. */
function isTransientName(name: string): boolean {
  return name.endsWith('.lock') || name.includes('.lock.generation-') || name.endsWith('.tmp');
}

async function writableProblem(targetRootPath: string): Promise<string | undefined> {
  // The admission claim lives beside the target, so its parent must be writable as well.
  for (const directory of [path.dirname(targetRootPath), targetRootPath]) {
    const existing = await nearestExisting(directory);
    if (!existing) return '新数据目录所在的磁盘或位置不存在。';
    const info = await fs.stat(existing);
    if (!info.isDirectory()) return `新数据目录的上级位置不是文件夹：${existing}`;
    try { await fs.access(existing, constants.W_OK); }
    catch { return `没有权限写入：${existing}`; }
  }
  return undefined;
}

async function nearestExisting(target: string): Promise<string | undefined> {
  let current = path.resolve(target);
  for (;;) {
    if (await lstatOrUndefined(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function realPathOfNearestExisting(target: string): Promise<string> {
  const existing = await nearestExisting(target);
  if (!existing) return path.resolve(target);
  const real = await fs.realpath(existing).catch(() => existing);
  return path.join(real, path.relative(existing, path.resolve(target)));
}

async function measureTree(root: string): Promise<{ files: number; bytes: number }> {
  const result = { files: 0, bytes: 0 };
  const visit = async (entry: string): Promise<void> => {
    const info = await lstatOrUndefined(entry);
    if (!info || info.isSymbolicLink()) return;
    if (info.isFile()) {
      result.files += 1;
      result.bytes += info.size;
    } else if (info.isDirectory()) {
      for (const name of await fs.readdir(entry).catch(() => [] as string[])) await visit(path.join(entry, name));
    }
  };
  await visit(root);
  return result;
}

async function lstatOrUndefined(target: string): Promise<import('node:fs').Stats | undefined> {
  try { return await fs.lstat(target); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}

async function pathExists(target: string): Promise<boolean> {
  return (await lstatOrUndefined(target)) !== undefined;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function dataRootUnavailableMessage(root: string, reason: DataRootUnavailableError['reason']): string {
  const detail = reason === 'missing' ? '目录不存在'
    : reason === 'not-directory' ? '这个位置不是文件夹'
      : reason === 'empty' ? '目录是空的，没有 LimCode 数据' : '目录无法读取';
  return `数据目录不可用（${detail}）：${root}。可能是外置盘没有接上或网络盘断开；为避免在空目录里新建一份空的历史，本窗口没有打开运行时。`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
