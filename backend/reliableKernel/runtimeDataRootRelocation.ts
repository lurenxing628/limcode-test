import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, type Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import { isPathInside, isSamePath } from '../capabilities/filesystem/pathContainment';
import {
  DATA_ROOT_BACKUPS_DIR, DATA_ROOT_RESET_PENDING_FILE, INDEX_FILE, RECORDS_DIR,
  REGISTERED_STORAGE_ROOT_DIRS, REGISTERED_STORAGE_ROOT_FILES
} from '../capabilities/vscodeStorage/constants';
import { ROOT_BINDING_POINTER_FILE, RUNTIME_KERNEL_EPOCH, type RootBinding } from './contracts';
import type { HistoricalRootBinding } from './rootAuthority';
import { classifyRecordedProcess, ownProcessStartIdentity } from './runtimeClaimPrimitives';
import { initializeEmptyRuntimeRoot, RuntimeDatabase } from './runtimeDatabase';
import {
  mergeRuntimeDataSetIntoDatabase, precopyRuntimeDataSetCas, RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY,
  RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY, type RuntimeDataSetMergeOptions, type RuntimeDataSetMergeResult
} from './runtimeDataSetMerge';
import { readRuntimeDataSetFacts } from './runtimeDataSetFacts';
import {
  readRuntimeDataSetMergeLedger, runtimeDataSetLastMerge, sameRuntimeDataSetFingerprint, sameRuntimeDataSetIdentity,
  type RuntimeDataSetFingerprint
} from './runtimeDataSetMergeLedger';
import { RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY } from './runtimeEpochMigration';
import { withRuntimeDataRootAdmission, withRuntimeMaintenance } from './runtimeHostControl';
import { auditRuntimeSnapshot } from './runtimeSnapshotAudit';
import { copyRuntimeDataSetDatabase, requireCompleteRuntimeDataSet } from './runtimeStorageInspection';
import {
  assertConfigurationRootRuntimesOffline, createVscodeRootAuthority, inspectVscodeRuntimeDataSets, markVscodeRuntimeDataSetKept,
  resolveVscodeRuntimeDataRoot, resolveVscodeRuntimeDataSet, resolveVscodeRuntimeDataSetScopeRoot, selectVscodeRuntimeDataSet,
  VSCODE_RUNTIME_CONTROL_DIRECTORY, VSCODE_RUNTIME_MERGE_LEDGER_DIRECTORY, VSCODE_RUNTIME_SELECTION_FILE,
  VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, type VscodeRuntimeDataSetCandidate
} from './vscodeRootAuthority';

/**
 * Data-root relocation: moves this installation's LimCode data directory (configuration root) to
 * another directory. A RootBinding stores absolute paths and is checked field by field, so the
 * directory is never copied as a whole: the target gets its own fresh Runtime root, the selected
 * data set is merged into it by the historical-merge engine in migration mode (every row through
 * ordinary Repository inserts, CAS objects verified), the configuration entries are copied (or
 * merged into an existing LimCode directory), and only then is the data-root pointer switched.
 *
 * Phases (the caller orchestrates windows and the pointer):
 * 1. plan: read-only checks, sizes per disk, row counts;
 * 2. stage (online): the staging record and the receiving root in the target, then the CAS
 *    pre-copy while every window keeps working;
 * 3. complete (exclusive, every Host of both directories offline): configuration, merge, other data
 *    sets, selection, completion record, then the caller's pointer switch.
 *
 * Every change in the target is written to a durable journal before it is made. A failure (or a
 * crash, found later through the staging record of a dead owner) is undone from that journal: the
 * entries this relocation created are removed, replaced configuration files and an existing
 * receiving database are put back from the relocation's own backups. The old directory's data is
 * never modified by the move; deleting it later is a separate, explicitly confirmed step that only
 * removes what the completion record proves was carried over unchanged.
 */

/** Relocation state kept in the target directory (never in the old one). */
export const DATA_ROOT_RELOCATION_MARKER_FILE = '.limcode-data-root-relocation.json';
/** Identity of a LimCode data directory; the data-root pointer records it (see assertDataRootAvailable). */
export const DATA_ROOT_IDENTITY_FILE = '.limcode-data-root-identity.json';
/** Replaced configuration versions, the journal and database backups of each relocation. */
export const DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY = '.limcode-relocation-backups';
/**
 * The move is one SQLite transaction whose memory grows with the rows of the data set; until it
 * is written in batches, larger data sets are refused before any window is involved.
 */
export const DATA_ROOT_RELOCATION_MAX_ROWS = 25_000;
/** A folder that already holds other files receives LimCode data only in its own sub-folder. */
export const DATA_ROOT_RELOCATION_SUBFOLDER = 'LimCode';
/** Global rules and skills live directly in the data directory (rulesCatalog, skillCatalog). */
export const DATA_ROOT_GLOBAL_ENTRIES: readonly string[] = ['AGENTS.md', 'CLAUDE.md', 'skills'];

const MARKER_KIND = 'limcode-data-root-relocation';
const IDENTITY_KIND = 'limcode-data-root-identity';
const JOURNAL_FILE = 'journal.jsonl';
const CONFIGURATION_BACKUP_DIRECTORY = 'configuration';
const DATABASE_BACKUP_PREFIX = 'database-';
/** Archives of "归档并重置" (VscodeReliableKernelCutoverCoordinator), one per scope root. */
const RESET_ARCHIVES_DIRECTORY = '.limcode-runtime-backups';
const CONTROL_ROOT_BACKUP_DIRECTORIES: readonly string[] = [
  RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY, RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY, RUNTIME_EPOCH_MIGRATION_BACKUPS_DIRECTORY
];
const RUNTIME_ENTRY_NAMES: readonly string[] = [
  VSCODE_RUNTIME_CONTROL_DIRECTORY, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, VSCODE_RUNTIME_SELECTION_FILE
];
const CONFIGURATION_ENTRIES: readonly string[] = [...REGISTERED_STORAGE_ROOT_DIRS, ...REGISTERED_STORAGE_ROOT_FILES, ...DATA_ROOT_GLOBAL_ENTRIES];
/** LimCode's own bookkeeping at the top of a data directory; removed only with its last data set. */
const METADATA_ENTRIES: readonly string[] = [
  VSCODE_RUNTIME_SELECTION_FILE, VSCODE_RUNTIME_MERGE_LEDGER_DIRECTORY, DATA_ROOT_IDENTITY_FILE,
  DATA_ROOT_RELOCATION_MARKER_FILE, DATA_ROOT_RESET_PENDING_FILE
];
/** Files operating systems drop into any directory; they do not make a directory "used". */
const IGNORABLE_ENTRY_NAMES: ReadonlySet<string> = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', '.localized']);
const CLOUD_SYNC_SEGMENT = /^(onedrive.*|dropbox|icloud ?drive|iclouddrive|mobile documents|cloudstorage|google ?drive|googledrive|my drive|box|box sync|pcloud ?drive|nutstore|坚果云|百度网盘|baidunetdisk|baidusyncdisk|seafile|nextcloud|owncloud|synologydrive|mega|yandex\.disk)$/i;
/** Free space kept beyond the estimate on every disk involved. */
const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Temporary copies named with their owner's process id (see sweepDataRootRelocationLeftovers). */
const OWNED_TEMPORARY_DIRECTORY = /^limcode-(?:runtime-history|merge-precopy|relocation-count)-(\d+)-/;
const OWNED_STAGING_FILE = /^(?:merge-precopy|relocation-count)-(\d+)-[0-9a-f-]{36}\.sqlite(?:-wal|-shm|-journal)?$/;
/** Names of earlier builds without an owner: removed only once clearly abandoned. */
const UNOWNED_TEMPORARY_DIRECTORY = /^limcode-(?:runtime-history|merge-precopy)-[A-Za-z0-9]{6}$/;
const UNOWNED_STAGING_FILE = new RegExp(`^merge-precopy-${UUID_PATTERN}\\.sqlite(?:-wal|-shm|-journal)?$`);
const UNOWNED_LEFTOVER_AGE_MS = 24 * 60 * 60_000;

export class DataRootRelocationError extends Error {
  public constructor(public readonly code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'DataRootRelocationError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export type DataRootUnavailableReason = 'missing' | 'not-directory' | 'empty' | 'mismatch' | 'unreadable';

/** A configured data directory that is missing, empty or another one (an unmounted drive, a lost share). */
export class DataRootUnavailableError extends Error {
  public readonly code = 'data-root-unavailable';

  public constructor(public readonly dataRootPath: string, public readonly reason: DataRootUnavailableReason, cause?: unknown) {
    super(dataRootUnavailableMessage(dataRootPath, reason));
    this.name = 'DataRootUnavailableError';
    if (cause !== undefined) (this as Error & { cause?: unknown }).cause = cause;
  }
}

export type DataRootRelocationTarget =
  /** Missing or empty: a fresh root under the current data set's id. */
  | { kind: 'empty' }
  /** Other files of the user: only a sub-folder of it can receive the data. */
  | { kind: 'occupied'; entries: string[]; suggestedPath: string }
  /** LimCode data created at this very path: the selected data set there receives the merge. */
  | { kind: 'limcode'; receivingId: string; dataSetIds: string[] }
  /**
   * LimCode data copied here from elsewhere (its RootBindings name another path): renamed aside
   * as a whole (`<name>.limcode-copied-<time>`, never deleted or merged), then a fresh root.
   * `sameDataSet`: an older copy of the current data set itself.
   */
  | { kind: 'copied'; sameDataSet: boolean; message: string }
  /** Not usable as a data directory at all. */
  | { kind: 'invalid'; message: string };

export interface DataRootRelocationDataSet {
  id: string;
  dataSetId: string;
  rootInstanceId: string;
  /** SQLite database and WAL. */
  databaseBytes: number;
  casBytes: number;
  /** CAS bytes as allocated on disk (blocks), for a copy to another disk. */
  casAllocatedBytes: number;
  /** Rows over every Runtime domain; undefined when the data set could not be read. */
  rows?: number;
}

export interface DataRootRelocationSpace {
  /** User-facing description of what is written there. */
  label: string;
  path: string;
  requiredBytes: number;
  freeBytes?: number;
}

export interface DataRootRelocationPlan {
  sourceRootPath: string;
  targetRootPath: string;
  target: DataRootRelocationTarget;
  current: DataRootRelocationDataSet & { rows: number };
  /** Other data sets of the old directory; `leaveBehind` names why one stays there. */
  others: Array<DataRootRelocationDataSet & { leaveBehind?: string }>;
  configurationBytes: number;
  /** Configuration entries of the old directory that are copied (registered, rules, skills). */
  configurationEntries: string[];
  /** Estimated bytes per disk (a disk used for several purposes appears once). */
  space: DataRootRelocationSpace[];
  sameDevice: boolean;
  /**
   * The target holds an unfinished relocation (a crashed one, or one from this same directory that
   * completed without switching the pointer and is unchanged since): it is undone first.
   */
  undoesEarlierAttempt: boolean;
  /** The relocation cannot start; each entry is a user-facing Chinese sentence. */
  problems: string[];
  /** Shown before confirmation; the relocation may still proceed. */
  warnings: string[];
}

export interface StagedDataRootRelocation {
  plan: DataRootRelocationPlan;
  relocationId: string;
  startedAt: string;
  receiving: { id: string; runtimeDataRootPath: string; binding: HistoricalRootBinding };
  precopied: { copiedCasObjects: number; linkedCasObjects: number; reusedCasObjects: number };
}

export interface DataRootRelocationResult {
  targetRootPath: string;
  /** Where LimCode data copied into the target from elsewhere was kept (renamed aside). */
  copiedDataMovedTo?: string;
  merged: RuntimeDataSetMergeResult;
  configuration: { copiedFiles: number; replacedFiles: number; backupPath?: string };
  others: {
    migrated: string[];
    /** Already merged into the current data set and unchanged since: carried by it. */
    covered: string[];
    leftBehind: Array<{ id: string; reason: string }>;
  };
}

export interface DataRootRelocationOptions extends Pick<RuntimeDataSetMergeOptions, 'linkFile'> {
  onProgress?(message: string): void;
}

/** What the pointer switch records: the identity of the new data directory. */
export interface DataRootRelocationPublication {
  dataRootId: string;
}

interface RelocationOwner {
  processId: number;
  processStartIdentity?: string;
}

type TargetState =
  | { kind: 'empty' }
  | { kind: 'copied'; sameDataSet: boolean }
  | { kind: 'limcode'; receivingId: string; dataSetIds: string[] };

interface MigratedDataSet {
  id: string;
  dataSetId: string;
  rootInstanceId: string;
  /** Content of the old directory's data set when it was carried over. */
  fingerprint: RuntimeDataSetFingerprint;
  /** Carried by this data set of the target (merged into the current one earlier). */
  mergedInto?: string;
}

interface CopiedConfiguration {
  entry: string;
  /** Tree digest of the old directory's entry when it was copied. */
  digest: string;
}

interface RelocationMarker {
  kind: typeof MARKER_KIND;
  state: 'staging' | 'complete';
  relocationId: string;
  sourceRootPath: string;
  /** The directory this record describes; a record copied along with a directory describes another one and is ignored. */
  targetRootPath: string;
  startedAt: string;
  owner: RelocationOwner;
  /** Top-level entries of the target before the relocation touched it (never removed by an undo). */
  preexisting: string[];
  createdDirectory: boolean;
  /** The target as the plan found it; a later attempt after an undo classifies it the same way. */
  targetState: TargetState;
  receivingId: string;
  /** Completion record of an earlier relocation into this directory, put back by an undo. */
  previous?: RelocationMarker;
  /** Copied LimCode data that was in the target, renamed aside here (renamed back by an undo). */
  movedAside?: string;
  completedAt?: string;
  migrated?: MigratedDataSet[];
  configuration?: CopiedConfiguration[];
  leftBehind?: Array<{ id: string; reason: string }>;
  /** The receiving data set right after completion: an unswitched relocation is redone only while unchanged. */
  receivingFingerprint?: RuntimeDataSetFingerprint;
  /** The user went back to the old directory afterwards: this record no longer proves anything about it. */
  invalidatedAt?: string;
}

type JournalEntry =
  /** Created by this relocation (the topmost new path); an undo removes it. */
  | { op: 'entry'; path: string }
  /** An existing file or link; its previous version is at `backup` (relative to the work directory). */
  | { op: 'replace'; path: string; backup: string }
  /** The existing receiving database; its offline copy is at `backup`. */
  | { op: 'database'; path: string; backup: string };

const cleanupStates = new WeakMap<object, boolean>();

/** Whether a failed completion already undid its changes in the target (undefined: not a completion failure). */
export function dataRootRelocationCleanupState(error: unknown): 'cleaned' | 'not-cleaned' | undefined {
  if (!error || typeof error !== 'object' || !cleanupStates.has(error)) return undefined;
  return cleanupStates.get(error) ? 'cleaned' : 'not-cleaned';
}

// ---------------------------------------------------------------------------------------------
// Availability and identity

/**
 * Startup guard. A configured data directory must exist and be the one the pointer recorded: with
 * `expectedRootId` its identity file must carry that id, otherwise it must at least hold LimCode's
 * own structure. An empty or missing directory is an unmounted drive or a lost share far more often
 * than a new directory, and opening it would silently create an empty history there. Nothing is
 * created or written.
 */
export async function assertDataRootAvailable(dataRootPath: string, expectedRootId?: string): Promise<void> {
  const root = path.resolve(dataRootPath);
  let info;
  try {
    info = await fs.stat(root);
  } catch (error) {
    throw new DataRootUnavailableError(root, isMissing(error) ? 'missing' : 'unreadable', error);
  }
  if (!info.isDirectory()) throw new DataRootUnavailableError(root, 'not-directory');
  let structure: boolean;
  try {
    structure = await hasLimCodeStructure(root);
  } catch (error) {
    throw new DataRootUnavailableError(root, 'unreadable', error);
  }
  if (expectedRootId !== undefined) {
    const identity = await readDataRootIdentity(root);
    if (identity === expectedRootId) return;
    throw new DataRootUnavailableError(root, identity !== undefined || structure ? 'mismatch' : 'empty');
  }
  if (!structure) throw new DataRootUnavailableError(root, 'empty');
}

/** The identity recorded in a data directory, if it has a valid one. */
export async function readDataRootIdentity(root: string): Promise<string | undefined> {
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(path.join(path.resolve(root), DATA_ROOT_IDENTITY_FILE), 'utf8')); }
  catch { return undefined; }
  const record = value as { kind?: unknown; rootId?: unknown } | null;
  return record?.kind === IDENTITY_KIND && typeof record.rootId === 'string' && /^[0-9a-f-]{36}$/.test(record.rootId)
    ? record.rootId : undefined;
}

/**
 * The identity of a LimCode data directory the pointer is about to name; written once, only into a
 * directory that already holds LimCode's structure.
 */
export async function ensureDataRootIdentity(root: string): Promise<string> {
  const resolved = path.resolve(root);
  const existing = await readDataRootIdentity(resolved);
  if (existing) return existing;
  if (!await hasLimCodeStructure(resolved)) {
    throw new DataRootRelocationError('data-root-not-limcode', `这个目录里没有 LimCode 数据：${resolved}`);
  }
  const rootId = randomUUID();
  await writeJsonDurably(path.join(resolved, DATA_ROOT_IDENTITY_FILE), { kind: IDENTITY_KIND, rootId, createdAt: new Date().toISOString() });
  return rootId;
}

/**
 * LimCode's own structure, never a bare name: the Runtime selection file, a Runtime directory, or a
 * record store (index.json with records/) in a registered directory or one level below it. An
 * empty folder that merely has a registered name (created by a write on an unmounted drive's mount
 * point) does not count.
 */
async function hasLimCodeStructure(root: string): Promise<boolean> {
  if ((await lstatOrUndefined(path.join(root, VSCODE_RUNTIME_SELECTION_FILE)))?.isFile()) return true;
  for (const name of [VSCODE_RUNTIME_CONTROL_DIRECTORY, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY]) {
    if ((await lstatOrUndefined(path.join(root, name)))?.isDirectory()) return true;
  }
  if (await readDataRootIdentity(root)) return true;
  for (const name of REGISTERED_STORAGE_ROOT_DIRS) {
    const directory = path.join(root, name);
    if (!(await lstatOrUndefined(directory))?.isDirectory()) continue;
    if (await isRecordStoreStructure(directory)) return true;
    for (const child of await fs.readdir(directory, { withFileTypes: true })) {
      if (child.isDirectory() && await isRecordStoreStructure(path.join(directory, child.name))) return true;
    }
  }
  return false;
}

async function isRecordStoreStructure(directory: string): Promise<boolean> {
  return (await lstatOrUndefined(path.join(directory, INDEX_FILE)))?.isFile() === true
    && (await lstatOrUndefined(path.join(directory, RECORDS_DIR)))?.isDirectory() === true;
}

/** The directory is one LimCode can open (used before offering to go back or switch to it). */
export async function inspectDataRootForReturn(dataRootPath: string): Promise<{ usable: boolean; message?: string }> {
  try {
    await assertDataRootAvailable(dataRootPath);
    const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: dataRootPath });
    if (inspection.problems.some((problem) => problem.message.includes('RootBinding 不一致'))) {
      return { usable: false, message: '这个目录里的 LimCode 数据是从别的位置拷贝过来的，不能直接打开。' };
    }
    const selected = inspection.candidates.find((candidate) => candidate.selected);
    if (!selected?.dataSetId) return { usable: false, message: '这个目录里没有可以打开的当前历史库。' };
    return { usable: true };
  } catch (error) {
    return { usable: false, message: errorMessage(error) };
  }
}

// ---------------------------------------------------------------------------------------------
// Plan

/**
 * Read-only relocation plan. `sourceDatabase` is this window's open Runtime of the current data set
 * (its rows are counted through a Backup API copy); without it the data set must be closed in this
 * process. Checked again (without measuring) when staging.
 */
export async function planDataRootRelocation(input: {
  sourceRootPath: string;
  targetRootPath: string;
  sourceDatabase?: RuntimeDatabase;
}): Promise<DataRootRelocationPlan> {
  const sourceRootPath = path.resolve(input.sourceRootPath);
  const targetRootPath = path.resolve(input.targetRootPath);
  const problems: string[] = [];
  const warnings: string[] = [];
  const placement = await placementProblems(input.targetRootPath, sourceRootPath, targetRootPath);
  problems.push(...placement);
  const cloud = targetRootPath.split(/[\\/]+/).find((segment) => CLOUD_SYNC_SEGMENT.test(segment));
  if (cloud) {
    warnings.push(`新数据目录看起来在云同步目录里（${cloud}）。同步软件在 LimCode 写入时复制数据库文件可能导致数据损坏，建议选择不同步的本地目录。`);
  }

  const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: sourceRootPath });
  const currentCandidate = requireCurrentCandidate(inspection.candidates);
  const currentBinding = await requireCompleteRuntimeDataSet(currentCandidate);
  const currentSize = await measureDataSet(currentBinding);
  const currentRows = await countRows(currentCandidate, currentBinding, input.sourceDatabase);
  const current = { ...identityOf(currentCandidate), ...currentSize, rows: currentRows };
  if (currentRows > DATA_ROOT_RELOCATION_MAX_ROWS) {
    problems.push(`当前历史库数据较多（约 ${currentRows} 行记录，当前版本最多迁移 ${DATA_ROOT_RELOCATION_MAX_ROWS} 行），当前版本暂不能迁移；旧目录不受影响，可以继续使用。`);
  }
  const others: DataRootRelocationPlan['others'] = [];
  for (const candidate of inspection.candidates) {
    if (candidate.selected || !candidate.dataSetId || !candidate.rootInstanceId) continue;
    let binding: HistoricalRootBinding;
    try { binding = await requireCompleteRuntimeDataSet(candidate); }
    catch (error) {
      others.push({ ...identityOf(candidate), databaseBytes: 0, casBytes: 0, casAllocatedBytes: 0, leaveBehind: `无法读取：${errorMessage(error)}` });
      continue;
    }
    const size = await measureDataSet(binding);
    const rows = await countRows(candidate, binding).catch(() => undefined);
    const leaveBehind = rows === undefined ? '无法读取这个历史库（可能需要先在旧目录里打开一次完成升级）'
      : rows > DATA_ROOT_RELOCATION_MAX_ROWS ? `数据较多（约 ${rows} 行记录），当前版本暂不能迁移` : undefined;
    others.push({ ...identityOf(candidate), ...size, ...(rows !== undefined ? { rows } : {}), ...(leaveBehind ? { leaveBehind } : {}) });
  }
  for (const problem of inspection.problems) {
    warnings.push(`旧目录里有一个无法读取的历史库不会被迁移，仍留在旧目录：${problem.message}`);
  }
  const configurationEntries: string[] = [];
  let configurationBytes = 0;
  let configurationAllocated = 0;
  for (const name of CONFIGURATION_ENTRIES) {
    const measured = await measureTree(path.join(sourceRootPath, name));
    if (measured.files === 0 && !await pathExists(path.join(sourceRootPath, name))) continue;
    configurationEntries.push(name);
    configurationBytes += measured.bytes;
    configurationAllocated += measured.allocated;
  }

  // A target that is the old directory itself (or inside or above it) is not inspected at all.
  const classified = placement.length > 0
    ? { target: { kind: 'invalid' as const, message: placement[0] }, undoes: false }
    : await classifyTarget(targetRootPath, sourceRootPath, currentCandidate.dataSetId);
  const target: DataRootRelocationTarget = classified.target;
  if (target.kind === 'invalid' && placement.length === 0) problems.push(target.message);
  if (target.kind === 'copied') warnings.push(target.message);
  if (target.kind === 'occupied') {
    problems.push(`所选文件夹里已有其它文件（${target.entries.length} 项），LimCode 只能放在其中新建的子文件夹里：${target.suggestedPath}`);
  }
  if (target.kind === 'limcode') {
    warnings.push('新数据目录里已有 LimCode 数据：当前历史会合并进去（同一条记录内容不同时整体取消，两边都不改）；设置按记录合并，同一项以当前在用的为准，被替换的旧版本放进新目录的备份文件夹。');
    const taken = new Set(target.dataSetIds);
    for (const other of others) {
      if (!other.leaveBehind && taken.has(other.id)) other.leaveBehind = '新数据目录里已有同名历史库';
    }
    const offline = await targetOfflineProblem(targetRootPath);
    if (offline) problems.push(offline);
  }
  if (classified.undoes) warnings.push('新数据目录里有上次没有完成的迁移，开始前会先把它撤销。');
  for (const other of others) {
    if (other.leaveBehind) warnings.push(`旧目录里的历史库 ${other.id} 不会迁移，仍留在旧目录：${other.leaveBehind}。`);
  }
  const globals = configurationEntries.filter((name) => DATA_ROOT_GLOBAL_ENTRIES.includes(name));
  if (globals.length > 0) warnings.push(`全局规则和技能（${globals.join('、')}）会一起复制到新目录。`);

  const writable = await writableProblem(targetRootPath);
  if (writable) problems.push(writable);
  const spaceEstimate = await estimateSpace({
    sourceRootPath, targetRootPath, currentBinding, current, others, configurationAllocated, target
  });
  for (const space of spaceEstimate.space) {
    if (space.freeBytes !== undefined && space.freeBytes < space.requiredBytes) {
      problems.push(`${space.label}所在磁盘剩余 ${formatBytes(space.freeBytes)}，迁移过程中大约需要 ${formatBytes(space.requiredBytes)}（${space.path}）。`);
    }
  }
  return {
    sourceRootPath, targetRootPath, target, current, others, configurationBytes, configurationEntries,
    space: spaceEstimate.space, sameDevice: spaceEstimate.sameDevice, undoesEarlierAttempt: classified.undoes, problems, warnings
  };
}

async function placementProblems(rawTarget: string, sourceRootPath: string, targetRootPath: string): Promise<string[]> {
  const problems: string[] = [];
  if (!path.isAbsolute(rawTarget.trim())) problems.push('新数据目录必须是绝对路径。');
  const sourceReal = await realPathOfNearestExisting(sourceRootPath);
  const targetReal = await realPathOfNearestExisting(targetRootPath);
  if (isSamePath(sourceRootPath, targetRootPath) || isSamePath(sourceReal, targetReal)) {
    problems.push('新数据目录就是当前数据目录。');
  } else if (isPathInside(sourceRootPath, targetRootPath) || isPathInside(sourceReal, targetReal)) {
    problems.push('新数据目录不能放在当前数据目录里面。');
  } else if (isPathInside(targetRootPath, sourceRootPath) || isPathInside(targetReal, sourceReal)) {
    problems.push('新数据目录不能是当前数据目录的上级目录。');
  }
  return problems;
}

function requireCurrentCandidate(candidates: readonly VscodeRuntimeDataSetCandidate[]): VscodeRuntimeDataSetCandidate {
  const selected = candidates.filter((candidate) => candidate.selected);
  if (selected.length !== 1 || !selected[0].dataSetId || !selected[0].rootInstanceId) {
    throw new DataRootRelocationError('data-root-relocation-no-current', '当前数据目录没有选定的历史库，无法迁移。');
  }
  return selected[0];
}

function identityOf(candidate: VscodeRuntimeDataSetCandidate): { id: string; dataSetId: string; rootInstanceId: string } {
  return { id: candidate.id, dataSetId: candidate.dataSetId!, rootInstanceId: candidate.rootInstanceId! };
}

/** One walk of the data set's Runtime directory: database, CAS (logical and allocated). */
async function measureDataSet(binding: HistoricalRootBinding): Promise<Pick<DataRootRelocationDataSet, 'databaseBytes' | 'casBytes' | 'casAllocatedBytes'>> {
  const database = path.resolve(binding.paths.databasePath);
  const databaseFiles = new Set([database, `${database}-wal`]);
  const cas = path.resolve(binding.paths.casRootPath);
  const result = { databaseBytes: 0, casBytes: 0, casAllocatedBytes: 0 };
  await walkSizes(path.resolve(binding.paths.dataRootPath), (file, info) => {
    if (databaseFiles.has(file)) result.databaseBytes += info.size;
    else if (isPathInside(cas, file)) {
      result.casBytes += info.size;
      result.casAllocatedBytes += allocatedBytes(info);
    }
  });
  return result;
}

/**
 * Rows over every Runtime domain, counted in a worker on a private copy: the open database of this
 * window through its Backup API (a staging file in its control root, named with this process id),
 * any other one through a copy of its files.
 */
async function countRows(candidate: VscodeRuntimeDataSetCandidate, binding: HistoricalRootBinding, sourceDatabase?: RuntimeDatabase): Promise<number> {
  const request = { binding: binding as unknown as RootBinding, measure: true, integrity: false } as const;
  if (sourceDatabase) {
    const staged = path.join(path.dirname(path.resolve(binding.paths.dataRootPath)), `relocation-count-${process.pid}-${randomUUID()}.sqlite`);
    try {
      await sourceDatabase.backupTo(staged);
      return (await auditRuntimeSnapshot(staged, request)).size!.rows;
    } finally {
      await removeSqliteFiles(staged);
    }
  }
  const copy = await copyRuntimeDataSetDatabase(candidate, binding);
  try {
    return (await auditRuntimeSnapshot(copy.databasePath, request)).size!.rows;
  } finally {
    await copy.remove();
  }
}

/**
 * Space per disk (a disk used for several purposes is checked once for their sum):
 * - target: the new database twice (database and WAL while writing), CAS as allocated when copied
 *   across disks (hard links on the same disk), configuration; an existing receiving database is
 *   backed up twice (the relocation's own undo copy and the merge backup);
 * - temporary directory: one private database copy at a time (audits, fingerprints);
 * - old directory: the Backup API staging copy of the current database during the CAS pre-copy.
 */
async function estimateSpace(input: {
  sourceRootPath: string;
  targetRootPath: string;
  currentBinding: HistoricalRootBinding;
  current: DataRootRelocationDataSet;
  others: DataRootRelocationPlan['others'];
  configurationAllocated: number;
  target: DataRootRelocationTarget;
}): Promise<{ space: DataRootRelocationSpace[]; sameDevice: boolean }> {
  const targetProbe = await nearestExisting(input.targetRootPath);
  const sourceProbe = path.dirname(path.resolve(input.currentBinding.paths.dataRootPath));
  const temporaryProbe = os.tmpdir();
  const deviceOf = async (probe: string | undefined): Promise<number | undefined> => {
    if (!probe) return undefined;
    try { return (await fs.stat(probe)).dev; } catch { return undefined; }
  };
  const targetDevice = await deviceOf(targetProbe);
  const sourceDevice = await deviceOf(sourceProbe);
  const temporaryDevice = await deviceOf(temporaryProbe);
  const sameDevice = targetDevice !== undefined && targetDevice === sourceDevice;
  const moving = [input.current, ...input.others.filter((other) => !other.leaveBehind)];
  let targetBytes = input.configurationAllocated;
  for (const dataSet of moving) targetBytes += 2 * dataSet.databaseBytes + (sameDevice ? 0 : dataSet.casAllocatedBytes);
  if (input.target.kind === 'limcode') {
    const receiving = await resolveVscodeRuntimeDataSet({ globalStoragePath: input.targetRootPath }, input.target.receivingId).catch(() => undefined);
    if (receiving) targetBytes += 2 * await databaseBytesOf(receiving.runtimeDataRootPath);
  }
  const largestDatabase = Math.max(0, ...moving.map((dataSet) => dataSet.databaseBytes));
  const needs: Array<{ device: number | undefined; label: string; path: string; bytes: number }> = [
    { device: targetDevice, label: '新数据目录', path: targetProbe ?? input.targetRootPath, bytes: targetBytes },
    { device: temporaryDevice, label: '临时目录', path: temporaryProbe, bytes: largestDatabase },
    { device: sourceDevice, label: '旧数据目录', path: sourceProbe, bytes: input.current.databaseBytes }
  ];
  const grouped = new Map<string, DataRootRelocationSpace>();
  for (const need of needs) {
    const key = need.device === undefined ? `path:${need.path}` : `device:${need.device}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.requiredBytes += need.bytes;
      existing.label = `${existing.label}、${need.label}`;
      continue;
    }
    let freeBytes: number | undefined;
    try {
      const stats = await fs.statfs(need.path);
      freeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch { /* free space unknown on this filesystem: the copy itself fails cleanly */ }
    grouped.set(key, {
      label: need.label, path: need.path, requiredBytes: need.bytes + FREE_SPACE_MARGIN_BYTES,
      ...(freeBytes !== undefined ? { freeBytes } : {})
    });
  }
  return { space: [...grouped.values()], sameDevice };
}

async function databaseBytesOf(runtimeDataRootPath: string): Promise<number> {
  let bytes = 0;
  for (const suffix of ['', '-wal']) {
    bytes += (await lstatOrUndefined(path.join(runtimeDataRootPath, `limcode.sqlite${suffix}`)))?.size ?? 0;
  }
  return bytes;
}

async function classifyTarget(
  targetRootPath: string,
  sourceRootPath: string,
  currentDataSetId: string | undefined
): Promise<{ target: DataRootRelocationTarget; undoes: boolean }> {
  let info;
  try {
    info = await fs.lstat(targetRootPath);
  } catch (error) {
    if (isMissing(error)) return { target: { kind: 'empty' }, undoes: false };
    return { target: { kind: 'invalid', message: `无法读取新数据目录：${errorMessage(error)}` }, undoes: false };
  }
  if (info.isSymbolicLink()) return { target: { kind: 'invalid', message: '新数据目录不能是符号链接，请直接选择它指向的目录。' }, undoes: false };
  if (!info.isDirectory()) return { target: { kind: 'invalid', message: '新数据目录的位置上已经有一个文件。' }, undoes: false };
  const marker = await readMarker(targetRootPath);
  const leftover = marker ? await unfinishedRelocation(targetRootPath, marker, sourceRootPath) : 'none';
  if (leftover === 'running') {
    return { target: { kind: 'invalid', message: '另一个 LimCode 窗口正在向这个目录迁移数据（或无法确认上次迁移的进程已经结束），请稍后再试。' }, undoes: false };
  }
  if (leftover === 'undo' && marker) {
    // Classified as it was before that attempt; staging undoes the attempt first.
    const state = marker.targetState;
    return {
      target: state.kind === 'limcode' ? { ...state }
        : state.kind === 'copied' ? { kind: 'copied', sameDataSet: state.sameDataSet, message: copiedMessage(targetRootPath, state.sameDataSet) }
          : { kind: 'empty' },
      undoes: true
    };
  }
  const names = (await fs.readdir(targetRootPath)).filter((name) => !IGNORABLE_ENTRY_NAMES.has(name) && !isClaimName(name));
  if (names.length === 0) return { target: { kind: 'empty' }, undoes: false };
  if (!names.some((name) => RUNTIME_ENTRY_NAMES.includes(name))) {
    return { target: { kind: 'occupied', entries: names.sort(), suggestedPath: await suggestSubfolder(targetRootPath) }, undoes: false };
  }
  const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: targetRootPath });
  if (inspection.problems.some((problem) => problem.message.includes('RootBinding 不一致'))) {
    const sameDataSet = currentDataSetId !== undefined && (await copiedDataSetIds(targetRootPath)).includes(currentDataSetId);
    return { target: { kind: 'copied', sameDataSet, message: copiedMessage(targetRootPath, sameDataSet) }, undoes: false };
  }
  if (inspection.problems.length > 0) {
    return { target: { kind: 'invalid', message: `新数据目录里的 LimCode 历史库无法读取：${inspection.problems[0].message}` }, undoes: false };
  }
  const selected = inspection.candidates.filter((candidate) => candidate.selected);
  if (selected.length !== 1 || !selected[0].dataSetId) {
    return { target: { kind: 'invalid', message: '新数据目录里有 LimCode 历史库，但没有选定当前库；请先在那里打开一次 LimCode，或换一个空目录。' }, undoes: false };
  }
  // Only a current-epoch root receives rows through the current Repository codecs.
  if (selected[0].requiresRecovery || selected[0].runtimeKernelEpoch !== RUNTIME_KERNEL_EPOCH) {
    return { target: { kind: 'invalid', message: '新数据目录里的当前历史库需要先在那里打开一次完成升级或恢复，才能接收迁移。' }, undoes: false };
  }
  return {
    target: { kind: 'limcode', receivingId: selected[0].id, dataSetIds: inspection.candidates.filter((item) => item.dataSetId).map((item) => item.id) },
    undoes: false
  };
}

/**
 * An earlier relocation in the target that must be undone before this one: a staging record whose
 * owner is gone, or a completion from this same directory whose pointer switch never happened (its
 * journal is still there) and whose receiving data set is unchanged since.
 */
async function unfinishedRelocation(
  target: string,
  marker: RelocationMarker,
  sourceRootPath: string
): Promise<'none' | 'running' | 'undo'> {
  if (marker.state === 'staging') return ownerState(marker.owner) === 'dead' ? 'undo' : 'running';
  if (marker.invalidatedAt || !isSamePath(path.resolve(marker.sourceRootPath), sourceRootPath)) return 'none';
  if (!await pathExists(journalPath(target, marker.relocationId)) || !marker.receivingFingerprint) return 'none';
  try {
    const receiving = await resolveVscodeRuntimeDataSet({ globalStoragePath: target }, marker.receivingId);
    return sameRuntimeDataSetFingerprint(marker.receivingFingerprint, await dataSetFingerprint(receiving)) ? 'undo' : 'none';
  } catch {
    return 'none';
  }
}

function copiedMessage(targetRootPath: string, sameDataSet: boolean): string {
  const aside = `${path.basename(targetRootPath)}.limcode-copied-<时间>`;
  return sameDataSet
    ? `新数据目录里是当前历史的一份旧拷贝（从别处复制过来的）。迁移时它会整体改名为“${aside}”保留在旁边，不合并、不删除；当前历史照常迁入。`
    : `新数据目录里是从别处拷贝过来的另一份 LimCode 数据。迁移时它会整体改名为“${aside}”保留在旁边，不合并、不删除；当前版本还不能直接导入它，需要时可以把它放回原来的位置后在那里打开。`;
}

/** Data-set ids named by the RootBindings of a copied data directory (read as plain JSON). */
async function copiedDataSetIds(root: string): Promise<string[]> {
  const pointers = [path.join(root, VSCODE_RUNTIME_CONTROL_DIRECTORY, ROOT_BINDING_POINTER_FILE)];
  const scopes = path.join(root, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, 'scopes');
  for (const key of await fs.readdir(scopes).catch(() => [] as string[])) {
    pointers.push(path.join(scopes, key, VSCODE_RUNTIME_CONTROL_DIRECTORY, ROOT_BINDING_POINTER_FILE));
  }
  const ids: string[] = [];
  for (const pointer of pointers) {
    try {
      const value = JSON.parse(await fs.readFile(pointer, 'utf8')) as { dataSetId?: unknown };
      if (typeof value.dataSetId === 'string') ids.push(value.dataSetId);
    } catch { /* not a readable binding */ }
  }
  return ids;
}

/** Renames the whole copied directory to a sibling; it is never deleted (an undo renames it back). */
async function moveCopiedDataAside(target: string): Promise<string> {
  const aside = `${target}.limcode-copied-${timestampSlug()}`;
  await fs.rename(target, aside);
  await syncDirectoryDurably(path.dirname(target));
  return aside;
}

async function suggestSubfolder(targetRootPath: string): Promise<string> {
  for (let index = 1; index < 10; index += 1) {
    const candidate = path.join(targetRootPath, index === 1 ? DATA_ROOT_RELOCATION_SUBFOLDER : `${DATA_ROOT_RELOCATION_SUBFOLDER}-${index}`);
    const info = await lstatOrUndefined(candidate);
    if (!info) return candidate;
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const names = (await fs.readdir(candidate).catch(() => ['?'])).filter((name) => !IGNORABLE_ENTRY_NAMES.has(name));
    if (names.length === 0 || names.some((name) => RUNTIME_ENTRY_NAMES.includes(name))) return candidate;
  }
  return path.join(targetRootPath, `${DATA_ROOT_RELOCATION_SUBFOLDER}-${timestampSlug()}`);
}

async function targetOfflineProblem(targetRootPath: string): Promise<string | undefined> {
  try {
    await assertConfigurationRootRuntimesOffline(targetRootPath);
    return undefined;
  } catch {
    return '新数据目录正被其它 LimCode 窗口使用（可能是另一个 VS Code 或 code-server），请先关闭它们再迁移。';
  }
}

// ---------------------------------------------------------------------------------------------
// Stage

/**
 * Online phase: the staging record, the journal and the receiving root in the target (under the
 * target's admission), then the CAS pre-copy of the current data set without any lock while every
 * window keeps working (anything written meanwhile is transferred again inside the exclusive merge).
 * `sourceDatabase` is this window's open Runtime of the current data set; the source is read
 * through its SQLite Backup API, never by copying its files.
 */
export async function stageDataRootRelocation(
  planned: DataRootRelocationPlan,
  sourceDatabase: RuntimeDatabase | undefined,
  options: DataRootRelocationOptions & {
    /** The id the caller recorded as in progress (the data-root pointer's record), so a crash can be undone. */
    relocationId?: string;
  } = {}
): Promise<StagedDataRootRelocation> {
  const target = planned.targetRootPath;
  const relocationId = options.relocationId ?? randomUUID();
  const startedAt = new Date().toISOString();
  const { plan, receiving } = await withRuntimeDataRootAdmission(target, async () => {
    const plan = await revalidatePlan(planned);
    const earlier = await readMarker(target);
    if (earlier && await unfinishedRelocation(target, earlier, plan.sourceRootPath) === 'undo') {
      const blocked = await targetOfflineProblem(target);
      if (blocked) throw new DataRootRelocationError('data-root-relocation-target-busy', blocked);
      options.onProgress?.('正在撤销上次没有完成的迁移');
      await undoRelocation(target, earlier);
    }
    const previous = plan.target.kind === 'copied' ? undefined : await readMarker(target);
    if (previous?.state === 'staging') {
      throw new DataRootRelocationError('data-root-relocation-concurrent', '另一个 LimCode 窗口正在向这个目录迁移数据，请稍后再试。');
    }
    const movedAside = plan.target.kind === 'copied' ? await moveCopiedDataAside(target) : undefined;
    const createdDirectory = !await pathExists(target);
    await fs.mkdir(target, { recursive: true });
    const preexisting = (await fs.readdir(target)).sort();
    const targetState: TargetState = plan.target.kind === 'limcode'
      ? { kind: 'limcode', receivingId: plan.target.receivingId, dataSetIds: [...plan.target.dataSetIds] }
      : plan.target.kind === 'copied' ? { kind: 'copied', sameDataSet: plan.target.sameDataSet } : { kind: 'empty' };
    const marker: RelocationMarker = {
      kind: MARKER_KIND, state: 'staging', relocationId, sourceRootPath: plan.sourceRootPath, targetRootPath: target, startedAt, owner: currentOwner(),
      preexisting, createdDirectory, targetState,
      receivingId: plan.target.kind === 'limcode' ? plan.target.receivingId : plan.current.id,
      ...(previous ? { previous: withoutPrevious(previous) } : {}),
      ...(movedAside ? { movedAside } : {})
    };
    await writeMarker(target, marker);
    const journal = await RelocationJournal.create(target, relocationId);
    try {
      return { plan, receiving: await prepareReceivingRoot(plan, journal) };
    } catch (error) {
      await undoRelocation(target, marker).catch((undoError: unknown) => console.error('[LimCode] 撤销迁移准备失败。', undoError));
      throw error;
    }
  });
  try {
    options.onProgress?.('正在预先复制正文文件');
    const precopied = await precopyRuntimeDataSetCas({ globalStoragePath: plan.sourceRootPath }, {
      candidateId: plan.current.id, expectedDataSetId: plan.current.dataSetId, expectedRootInstanceId: plan.current.rootInstanceId
    }, { configurationRootPath: target, binding: receiving.binding }, {
      ...(options.linkFile ? { linkFile: options.linkFile } : {}),
      ...(sourceDatabase ? { sourceDatabase } : {})
    });
    return { plan, relocationId, startedAt, receiving, precopied };
  } catch (error) {
    await abandonStagedDataRootRelocation({ plan, relocationId }).catch((undoError: unknown) => {
      console.error('[LimCode] 撤销迁移准备失败。', undoError);
    });
    throw error;
  }
}

/** The plan still holds (same current data set, same kind of target); nothing is measured again. */
async function revalidatePlan(planned: DataRootRelocationPlan): Promise<DataRootRelocationPlan> {
  const problems = await placementProblems(planned.targetRootPath, planned.sourceRootPath, planned.targetRootPath);
  const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: planned.sourceRootPath });
  const current = requireCurrentCandidate(inspection.candidates);
  const { target } = await classifyTarget(planned.targetRootPath, planned.sourceRootPath, current.dataSetId);
  if (target.kind === 'limcode') {
    const offline = await targetOfflineProblem(planned.targetRootPath);
    if (offline) problems.push(offline);
  }
  if (target.kind === 'invalid') problems.push(target.message);
  if (problems.length > 0) throw new DataRootRelocationError('data-root-relocation-precondition', problems.join('\n'));
  if (current.id !== planned.current.id || current.dataSetId !== planned.current.dataSetId
    || current.rootInstanceId !== planned.current.rootInstanceId || !isDeepStrictEqual(target, planned.target)) {
    throw new DataRootRelocationError('data-root-relocation-changed', '确认之后当前历史库或新数据目录发生了变化，请重新开始迁移。');
  }
  return planned;
}

async function prepareReceivingRoot(plan: DataRootRelocationPlan, journal: RelocationJournal): Promise<StagedDataRootRelocation['receiving']> {
  const target = plan.targetRootPath;
  if (plan.target.kind === 'limcode') {
    const candidate = await resolveVscodeRuntimeDataSet({ globalStoragePath: target }, plan.target.receivingId);
    return { id: candidate.id, runtimeDataRootPath: candidate.runtimeDataRootPath, binding: await requireCompleteRuntimeDataSet(candidate) };
  }
  // A fresh root under the same id the current data set has in the old directory.
  const runtimeDataRootPath = await createDataSetRoot(target, plan.current.id, journal);
  const authority = createVscodeRootAuthority({ runtimeDataRootPath, configurationRootPath: target });
  const binding = await withRuntimeMaintenance(authority.expectedPaths(), () => initializeEmptyRuntimeRoot(authority));
  return { id: plan.current.id, runtimeDataRootPath, binding };
}

/** Journals the new data set's directories (the topmost one that does not exist yet). */
async function createDataSetRoot(target: string, id: string, journal: RelocationJournal): Promise<string> {
  const scopeRoot = resolveVscodeRuntimeDataSetScopeRoot(target, id);
  const runtimeDataRootPath = resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot });
  await journal.recordCreation(path.relative(target, path.dirname(runtimeDataRootPath)));
  return runtimeDataRootPath;
}

/** Undoes what an abandoned stage created (e.g. the windows could not be closed); only while it is still ours. */
export async function abandonStagedDataRootRelocation(staged: Pick<StagedDataRootRelocation, 'plan' | 'relocationId'>): Promise<void> {
  const target = staged.plan.targetRootPath;
  await withRuntimeDataRootAdmission(target, async () => {
    const marker = await readMarker(target);
    if (!marker || marker.relocationId !== staged.relocationId) return;
    if (marker.targetState.kind === 'limcode' && await hasDatabaseRestore(target, marker)) {
      const blocked = await targetOfflineProblem(target);
      if (blocked) throw new DataRootRelocationError('data-root-relocation-target-busy', blocked);
    }
    await undoRelocation(target, marker);
  });
}

// ---------------------------------------------------------------------------------------------
// Complete

/**
 * Exclusive phase. Call while holding the old directory's configuration admission after every
 * Host of it went offline (this window's own Runtime included). `publish` switches the data-root
 * pointer; it runs last, after the completion record. Any failure before it returns undoes the
 * relocation in the target from its journal; `dataRootRelocationCleanupState(error)` tells whether
 * that undo succeeded.
 */
export async function completeDataRootRelocation(
  staged: StagedDataRootRelocation,
  publish: (publication: DataRootRelocationPublication) => Promise<void>,
  options: DataRootRelocationOptions = {}
): Promise<DataRootRelocationResult> {
  const { plan } = staged;
  const source = plan.sourceRootPath;
  const target = plan.targetRootPath;
  const sourcePaths = { globalStoragePath: source };
  // Set once the staging record is confirmed ours: from then on a failure undoes the target's changes.
  const owned: { marker?: RelocationMarker } = {};
  try {
    return await withRuntimeDataRootAdmission(source, () => withRuntimeDataRootAdmission(target, async () => {
      const staging = await readMarker(target);
      if (staging?.state !== 'staging' || staging.relocationId !== staged.relocationId) {
        throw new DataRootRelocationError('data-root-relocation-lost', '新数据目录里的迁移准备记录不见了（可能已被另一个窗口清理），本次不迁移。');
      }
      owned.marker = staging;
      const journal = RelocationJournal.open(target, staged.relocationId);
      await assertConfigurationRootRuntimesOffline(source);
      const busyTarget = await targetOfflineProblem(target);
      if (busyTarget) throw new DataRootRelocationError('data-root-relocation-target-busy', busyTarget);
      const current = await resolveVscodeRuntimeDataSet(sourcePaths, plan.current.id);
      if (!current.selected || current.dataSetId !== plan.current.dataSetId || current.rootInstanceId !== plan.current.rootInstanceId) {
        throw new DataRootRelocationError('data-root-relocation-changed', '迁移期间当前历史库发生了变化，本次不迁移。');
      }
      options.onProgress?.('正在核对当前历史库');
      const currentFingerprint = await dataSetFingerprint(current);
      options.onProgress?.('正在复制设置、全局规则和技能');
      const configuration = await transferConfiguration(source, target, journal);
      options.onProgress?.('正在迁移当前历史库');
      if (plan.target.kind === 'limcode') await backupReceivingDatabase(target, staged.receiving, journal);
      const merged = await mergeInto(sourcePaths, target, plan.current, staged.receiving.runtimeDataRootPath, options, plan.target.kind !== 'limcode');
      if (plan.target.kind === 'limcode' && merged.backupPath) await journal.append({ op: 'entry', path: path.relative(target, merged.backupPath) });
      const others = await migrateOthers(staged, current, journal, options);
      if (plan.target.kind !== 'limcode') {
        await journal.recordCreation(VSCODE_RUNTIME_SELECTION_FILE);
        await selectVscodeRuntimeDataSet({ globalStoragePath: target }, staged.receiving.id);
      }
      await journal.recordCreation(DATA_ROOT_IDENTITY_FILE);
      const dataRootId = await ensureDataRootIdentity(target);
      options.onProgress?.('正在核对新目录');
      const receivingFingerprint = await dataSetFingerprint(await resolveVscodeRuntimeDataSet({ globalStoragePath: target }, staged.receiving.id));
      await writeMarker(target, {
        ...staging, state: 'complete', completedAt: new Date().toISOString(),
        migrated: [{ ...identityOf(current), fingerprint: currentFingerprint }, ...others.migrated],
        configuration: configuration.copied,
        leftBehind: others.result.leftBehind,
        receivingFingerprint
      });
      await publish({ dataRootId });
      return {
        targetRootPath: target,
        ...(staging.movedAside ? { copiedDataMovedTo: staging.movedAside } : {}),
        merged,
        configuration: {
          copiedFiles: configuration.copiedFiles, replacedFiles: configuration.replacedFiles,
          ...(configuration.replacedFiles > 0 ? { backupPath: journal.configurationBackupPath } : {})
        },
        others: others.result
      };
    }));
  } catch (error) {
    // Only a staging record confirmed ours is undone here; otherwise the caller abandons the stage
    // (which again undoes only a record that is still ours).
    if (owned.marker) {
      const staging = owned.marker;
      const cleaned = await withRuntimeDataRootAdmission(target, () => undoRelocation(target, staging)).then(() => true, (undoError: unknown) => {
        console.error('[LimCode] 迁移失败后撤销新数据目录里的改动时出错。', undoError);
        return false;
      });
      if (error && typeof error === 'object') cleanupStates.set(error, cleaned);
    }
    throw error;
  }
}

/**
 * `freshRoot`: the receiving root was created by this relocation, so the merge's own pre-merge
 * backup only holds an empty database and is removed again.
 */
async function mergeInto(
  sourcePaths: { globalStoragePath: string },
  target: string,
  dataSet: { id: string; dataSetId: string; rootInstanceId: string },
  runtimeDataRootPath: string,
  options: DataRootRelocationOptions,
  freshRoot: boolean
): Promise<RuntimeDataSetMergeResult> {
  const authority = createVscodeRootAuthority({ runtimeDataRootPath, configurationRootPath: target });
  const merged = await withRuntimeMaintenance(authority.expectedPaths(), async () => {
    const database = await RuntimeDatabase.open(authority, { hostBootId: `data-root-relocation-${randomUUID()}` });
    try {
      return await mergeRuntimeDataSetIntoDatabase(sourcePaths, {
        candidateId: dataSet.id, expectedDataSetId: dataSet.dataSetId, expectedRootInstanceId: dataSet.rootInstanceId
      }, { configurationRootPath: target, database }, { migration: true, ...(options.linkFile ? { linkFile: options.linkFile } : {}) });
    } finally {
      await database.close();
    }
  });
  if (freshRoot && merged.backupPath) {
    await fs.rm(merged.backupPath, { recursive: true, force: true });
    await fs.rmdir(path.dirname(merged.backupPath)).catch(() => undefined);
    const { backupPath: _discarded, ...result } = merged;
    return result;
  }
  return merged;
}

/**
 * An offline copy of an existing receiving database (every Host of the target is offline and this
 * process has it closed), journaled before the merge: an undo puts it back.
 */
async function backupReceivingDatabase(target: string, receiving: StagedDataRootRelocation['receiving'], journal: RelocationJournal): Promise<void> {
  const databasePath = path.resolve(receiving.binding.paths.databasePath);
  const journalFile = await lstatOrUndefined(`${databasePath}-journal`);
  if (journalFile && journalFile.size > 0) {
    throw new DataRootRelocationError('data-root-relocation-target-recovery', '新数据目录里的当前历史库有未完成的恢复，请先在那里打开一次 LimCode。');
  }
  const name = `${DATABASE_BACKUP_PREFIX}${createHash('sha256').update(receiving.id).digest('hex').slice(0, 16)}`;
  const destination = path.join(journal.workDirectory, name);
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(temporary, { recursive: true });
  try {
    for (const suffix of ['', '-wal']) {
      const from = `${databasePath}${suffix}`;
      if (!await pathExists(from)) continue;
      await copyDurably(from, path.join(temporary, `limcode.sqlite${suffix}`));
    }
    await syncDirectoryDurably(temporary);
    await fs.rename(temporary, destination);
    await syncDirectoryDurably(journal.workDirectory);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  await journal.append({ op: 'database', path: path.relative(target, databasePath), backup: name });
}

/**
 * Every other data set of the old directory becomes its own data set under the same id in the
 * target, recorded as kept so it is never merged automatically there. One merged into the current
 * data set earlier and unchanged since is carried by it and not copied again. One that cannot move
 * (too large, unreadable, in use by an old window, an id already taken) stays in the old directory.
 */
async function migrateOthers(
  staged: StagedDataRootRelocation,
  current: VscodeRuntimeDataSetCandidate,
  journal: RelocationJournal,
  options: DataRootRelocationOptions
): Promise<{ result: DataRootRelocationResult['others']; migrated: MigratedDataSet[] }> {
  const { plan } = staged;
  const target = plan.targetRootPath;
  const sourcePaths = { globalStoragePath: plan.sourceRootPath };
  const result: DataRootRelocationResult['others'] = { migrated: [], covered: [], leftBehind: [] };
  const migrated: MigratedDataSet[] = [];
  const taken = new Set(plan.target.kind === 'limcode' ? plan.target.dataSetIds : []);
  taken.add(staged.receiving.id);
  const ledger = await readRuntimeDataSetMergeLedger(sourcePaths).catch(() => new Map());
  for (const [index, other] of plan.others.entries()) {
    if (other.leaveBehind || taken.has(other.id)) {
      result.leftBehind.push({ id: other.id, reason: other.leaveBehind ?? '新数据目录里已有同名历史库' });
      continue;
    }
    options.onProgress?.(`正在迁移其它历史库（${index + 1}/${plan.others.length}）`);
    let created: string | undefined;
    try {
      const candidate = await resolveVscodeRuntimeDataSet(sourcePaths, other.id);
      if (candidate.dataSetId !== other.dataSetId || candidate.rootInstanceId !== other.rootInstanceId) {
        throw new Error('确认之后这个历史库发生了变化');
      }
      const fingerprint = await dataSetFingerprint(candidate);
      const record = ledger.get(other.id);
      const lastMerge = record ? runtimeDataSetLastMerge(record) : undefined;
      if (lastMerge && sameRuntimeDataSetIdentity(lastMerge.target, current) && sameRuntimeDataSetFingerprint(lastMerge.source, fingerprint)) {
        migrated.push({ ...identityOf(candidate), fingerprint, mergedInto: current.id });
        result.covered.push(other.id);
        continue;
      }
      const scopeRoot = resolveVscodeRuntimeDataSetScopeRoot(target, other.id);
      const runtimeDataRootPath = resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot });
      if (await pathExists(path.dirname(runtimeDataRootPath))) throw new Error('新数据目录里已有这个历史库的目录');
      created = await firstMissingAncestor(target, path.dirname(runtimeDataRootPath));
      await createDataSetRoot(target, other.id, journal);
      const authority = createVscodeRootAuthority({ runtimeDataRootPath, configurationRootPath: target });
      await withRuntimeMaintenance(authority.expectedPaths(), () => initializeEmptyRuntimeRoot(authority));
      await mergeInto(sourcePaths, target, other, runtimeDataRootPath, options, true);
      await markVscodeRuntimeDataSetKept(await resolveVscodeRuntimeDataSet({ globalStoragePath: target }, other.id));
      migrated.push({ ...identityOf(candidate), fingerprint });
      result.migrated.push(other.id);
    } catch (error) {
      result.leftBehind.push({ id: other.id, reason: errorMessage(error) });
      if (created) await fs.rm(created, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return { result, migrated };
}

async function firstMissingAncestor(root: string, target: string): Promise<string | undefined> {
  const relative = path.relative(root, target).split(path.sep);
  for (let index = 1; index <= relative.length; index += 1) {
    const candidate = path.join(root, ...relative.slice(0, index));
    if (!await pathExists(candidate)) return candidate;
  }
  return undefined;
}

/** Content identity of a data set, read from a private copy in a worker; nothing is written anywhere. */
async function dataSetFingerprint(candidate: VscodeRuntimeDataSetCandidate): Promise<RuntimeDataSetFingerprint> {
  const facts = await readRuntimeDataSetFacts(candidate, { contentDigest: true });
  return {
    dataSetId: facts.binding.dataSetId,
    rootInstanceId: facts.binding.rootInstanceId,
    rootGeneration: facts.binding.rootGeneration,
    pointerRevision: facts.binding.pointerRevision,
    contentDigest: facts.contentDigest!
  };
}

// ---------------------------------------------------------------------------------------------
// Configuration

interface ConfigurationTransfer {
  copied: CopiedConfiguration[];
  copiedFiles: number;
  replacedFiles: number;
}

/**
 * Registered configuration entries, the data-root marker, global rules and skills (a custom data
 * directory may hold other files of the user; those stay). A missing target entry is copied; an
 * existing LimCode target keeps its own records: record stores at any depth are merged by record id,
 * a file present on both sides with different content takes the current version and the replaced
 * one is kept in the relocation's backup directory. Every copied file is verified by SHA-256 and
 * made durable; every change is journaled first.
 */
async function transferConfiguration(sourceRoot: string, targetRoot: string, journal: RelocationJournal): Promise<ConfigurationTransfer> {
  const state: TransferState = { journal, targetRoot, copiedFiles: 0, replacedFiles: 0, hashes: new Map() };
  const copied: CopiedConfiguration[] = [];
  for (const name of CONFIGURATION_ENTRIES) {
    const source = path.join(sourceRoot, name);
    const info = await lstatOrUndefined(source);
    if (!info || !(info.isDirectory() || info.isFile())) continue;
    await transferEntry(source, path.join(targetRoot, name), name, state);
    copied.push({ entry: name, digest: await treeDigest(source, state.hashes) });
  }
  return { copied, copiedFiles: state.copiedFiles, replacedFiles: state.replacedFiles };
}

interface TransferState {
  journal: RelocationJournal;
  targetRoot: string;
  copiedFiles: number;
  replacedFiles: number;
  /** SHA-256 of every source file read, for the tree digest. */
  hashes: Map<string, string>;
}

async function transferEntry(from: string, to: string, relative: string, state: TransferState): Promise<void> {
  const info = await fs.lstat(from);
  const existing = await lstatOrUndefined(to);
  if (info.isDirectory()) {
    if (!existing) {
      await state.journal.append({ op: 'entry', path: relative });
      await copyTree(from, to, state);
      return;
    }
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      await moveAside(to, relative, state);
      await state.journal.append({ op: 'entry', path: relative });
      await copyTree(from, to, state);
      return;
    }
    if (await isRecordStore(from) && await isRecordStore(to)) {
      await mergeRecordStore(from, to, relative, state);
      return;
    }
    for (const name of (await fs.readdir(from)).sort()) {
      if (isTransientName(name)) continue;
      await transferEntry(path.join(from, name), path.join(to, name), path.join(relative, name), state);
    }
    await syncDirectoryDurably(to);
    return;
  }
  if (info.isFile()) {
    const digest = await hashSource(from, state);
    if (existing?.isFile() && existing.size === info.size && await sha256File(to) === digest) return;
    if (existing?.isFile()) {
      await replaceFile(from, to, relative, digest, state);
    } else {
      if (existing) await moveAside(to, relative, state);
      else await state.journal.append({ op: 'entry', path: relative });
      await copyVerified(from, to, digest);
      state.copiedFiles += 1;
    }
    await syncDirectoryDurably(path.dirname(to));
    return;
  }
  if (info.isSymbolicLink()) {
    const link = await fs.readlink(from);
    if (existing?.isSymbolicLink() && await fs.readlink(to) === link) return;
    if (existing) await moveAside(to, relative, state);
    else await state.journal.append({ op: 'entry', path: relative });
    await fs.symlink(link, to);
    await syncDirectoryDurably(path.dirname(to));
  }
}

/** A tree created by this relocation (its top is already journaled). */
async function copyTree(from: string, to: string, state: TransferState): Promise<void> {
  await fs.mkdir(to);
  for (const entry of (await fs.readdir(from, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    if (isTransientName(entry.name)) continue;
    const source = path.join(from, entry.name);
    const destination = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, destination, state);
    else if (entry.isFile()) {
      await copyVerified(source, destination, await hashSource(source, state));
      state.copiedFiles += 1;
    } else if (entry.isSymbolicLink()) await fs.symlink(await fs.readlink(source), destination);
  }
  await syncDirectoryDurably(to);
}

/** The existing file is copied into the backups first; the new content then replaces it atomically. */
async function replaceFile(from: string, to: string, relative: string, digest: string, state: TransferState): Promise<void> {
  const backup = path.join(CONFIGURATION_BACKUP_DIRECTORY, relative);
  await state.journal.append({ op: 'replace', path: relative, backup });
  await copyIntoBackup(to, path.join(state.journal.workDirectory, backup));
  await copyVerified(from, to, digest);
  state.copiedFiles += 1;
  state.replacedFiles += 1;
}

/** A directory, link or file in the way of a different kind of entry is moved into the backups. */
async function moveAside(to: string, relative: string, state: TransferState): Promise<void> {
  const backup = path.join(CONFIGURATION_BACKUP_DIRECTORY, relative);
  const destination = path.join(state.journal.workDirectory, backup);
  await state.journal.append({ op: 'replace', path: relative, backup });
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.rename(to, destination);
  await syncDirectoryDurably(path.dirname(destination));
  state.replacedFiles += 1;
}

async function copyIntoBackup(file: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyDurably(file, temporary);
    await fs.rename(temporary, destination);
    await syncDirectoryDurably(path.dirname(destination));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function hashSource(file: string, state: TransferState): Promise<string> {
  const known = state.hashes.get(file);
  if (known) return known;
  const digest = await sha256File(file);
  state.hashes.set(file, digest);
  return digest;
}

interface RecordIndexEntry { id: string; file: string; updatedAt: string }

async function isRecordStore(directory: string): Promise<boolean> {
  return (await lstatOrUndefined(path.join(directory, INDEX_FILE)))?.isFile() === true;
}

/**
 * Union by record id (see transferConfiguration). The target index is replaced atomically after
 * its previous version was copied into the backups, so it is never missing.
 */
async function mergeRecordStore(source: string, target: string, relative: string, state: TransferState): Promise<void> {
  const sourceIndex = await readRecordIndex(path.join(source, INDEX_FILE));
  const targetIndex = await readRecordIndex(path.join(target, INDEX_FILE));
  await hashSource(path.join(source, INDEX_FILE), state);
  const entries = targetIndex.records.map((entry) => ({ ...entry }));
  const byId = new Map(entries.map((entry, index) => [entry.id, index] as const));
  const fileOwners = new Map(entries.map((entry) => [entry.file, entry.id] as const));
  let changed = false;
  const recordsDirectory = path.join(target, RECORDS_DIR);
  if (!await pathExists(recordsDirectory)) {
    await state.journal.append({ op: 'entry', path: path.join(relative, RECORDS_DIR) });
    await fs.mkdir(recordsDirectory);
  }
  for (const entry of sourceIndex.records) {
    const from = path.join(source, ...entry.file.split('/'));
    await hashSource(from, state);
    const existingIndex = byId.get(entry.id);
    const existing = existingIndex === undefined ? undefined : entries[existingIndex];
    if (existing && isDeepStrictEqual(await readRecordBody(from), await readRecordBody(path.join(target, ...existing.file.split('/'))).catch(() => undefined))) {
      continue;
    }
    const owner = fileOwners.get(entry.file);
    if (owner !== undefined && owner !== entry.id) {
      throw new DataRootRelocationError('data-root-relocation-configuration-conflict',
        `新数据目录的设置里有同名文件属于另一条记录（${relative}/${entry.file}），整体取消迁移。`);
    }
    await transferEntry(from, path.join(target, ...entry.file.split('/')), path.join(relative, ...entry.file.split('/')), state);
    if (existing && existing.file !== entry.file) fileOwners.delete(existing.file);
    if (existingIndex === undefined) {
      byId.set(entry.id, entries.length);
      entries.push({ ...entry });
    } else {
      entries[existingIndex] = { ...entry };
    }
    fileOwners.set(entry.file, entry.id);
    changed = true;
  }
  await syncDirectoryDurably(recordsDirectory);
  if (!changed) return;
  const indexPath = path.join(target, INDEX_FILE);
  const indexRelative = path.join(relative, INDEX_FILE);
  const backup = path.join(CONFIGURATION_BACKUP_DIRECTORY, indexRelative);
  await state.journal.append({ op: 'replace', path: indexRelative, backup });
  await copyIntoBackup(indexPath, path.join(state.journal.workDirectory, backup));
  await writeJsonDurably(indexPath, { ...targetIndex.raw, savedAt: new Date().toISOString(), records: entries });
  state.replacedFiles += 1;
}

async function readRecordIndex(file: string): Promise<{ raw: Record<string, unknown>; records: RecordIndexEntry[] }> {
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    throw new DataRootRelocationError('data-root-relocation-configuration-unreadable', `设置索引无法读取，整体取消迁移：${file}（${errorMessage(error)}）`);
  }
  const index = value as { records?: unknown } | null;
  if (!index || typeof index !== 'object' || Array.isArray(index) || !Array.isArray(index.records)) {
    throw new DataRootRelocationError('data-root-relocation-configuration-unreadable', `设置索引格式无效，整体取消迁移：${file}`);
  }
  const records = index.records as unknown[];
  if (!records.every((entry) => {
    const record = entry as Partial<RecordIndexEntry> | null;
    return !!record && typeof record.id === 'string' && typeof record.file === 'string' && typeof record.updatedAt === 'string'
      && /^records\/[^/\\]+\.json$/i.test(record.file);
  })) {
    throw new DataRootRelocationError('data-root-relocation-configuration-unreadable', `设置索引里有无效的记录项，整体取消迁移：${file}`);
  }
  return { raw: index as Record<string, unknown>, records: records as RecordIndexEntry[] };
}

/** A record file without its save timestamp: two saves of the same record compare equal. */
async function readRecordBody(file: string): Promise<unknown> {
  const body = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
  delete body.savedAt;
  return body;
}

/**
 * Digest of a configuration entry: kinds, relative paths, file contents and link targets in order,
 * without LimCode's own lock and temporary files.
 */
async function treeDigest(root: string, hashes?: ReadonlyMap<string, string>): Promise<string> {
  const hash = createHash('sha256');
  const visit = async (absolute: string, relative: string): Promise<void> => {
    const info = await fs.lstat(absolute);
    if (info.isDirectory()) {
      hash.update(`d\0${relative}\n`);
      for (const name of (await fs.readdir(absolute)).sort()) {
        if (isTransientName(name)) continue;
        await visit(path.join(absolute, name), relative ? `${relative}/${name}` : name);
      }
    } else if (info.isFile()) {
      hash.update(`f\0${relative}\0${hashes?.get(absolute) ?? await sha256File(absolute)}\n`);
    } else if (info.isSymbolicLink()) {
      hash.update(`l\0${relative}\0${await fs.readlink(absolute)}\n`);
    }
  };
  await visit(root, '');
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// Journal and undo

class RelocationJournal {
  private constructor(public readonly target: string, public readonly workDirectory: string) {}

  public static async create(target: string, relocationId: string): Promise<RelocationJournal> {
    const backups = path.join(target, DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY);
    await fs.mkdir(backups, { recursive: true });
    const journal = new RelocationJournal(target, workDirectory(target, relocationId));
    await fs.mkdir(journal.workDirectory);
    const handle = await fs.open(journal.file, 'wx', 0o600);
    try { await handle.sync(); } finally { await handle.close(); }
    await syncDirectoryDurably(journal.workDirectory);
    await syncDirectoryDurably(backups);
    await syncDirectoryDurably(target);
    return journal;
  }

  public static open(target: string, relocationId: string): RelocationJournal {
    return new RelocationJournal(target, workDirectory(target, relocationId));
  }

  public get file(): string {
    return path.join(this.workDirectory, JOURNAL_FILE);
  }

  public get configurationBackupPath(): string {
    return path.join(this.workDirectory, CONFIGURATION_BACKUP_DIRECTORY);
  }

  public async append(entry: JournalEntry): Promise<void> {
    requireRelative(entry.path);
    const handle = await fs.open(this.file, 'a', 0o600);
    try {
      await handle.appendFile(`${JSON.stringify(entry)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  /** Journals the topmost path of `relative` that does not exist yet (nothing when all exist). */
  public async recordCreation(relative: string): Promise<void> {
    const missing = await firstMissingAncestor(this.target, path.join(this.target, relative));
    if (missing) await this.append({ op: 'entry', path: path.relative(this.target, missing) });
  }
}

function workDirectory(target: string, relocationId: string): string {
  return path.join(target, DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY, relocationId);
}

function journalPath(target: string, relocationId: string): string {
  return path.join(workDirectory(target, relocationId), JOURNAL_FILE);
}

async function readJournal(target: string, relocationId: string): Promise<JournalEntry[]> {
  let text: string;
  try { text = await fs.readFile(journalPath(target, relocationId), 'utf8'); }
  catch (error) { if (isMissing(error)) return []; throw error; }
  const entries: JournalEntry[] = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); }
    catch (error) {
      // Only the last line can be torn by a crash; it was never acted on.
      if (index >= lines.length - 2) break;
      throw new DataRootRelocationError('data-root-relocation-journal', `迁移日志损坏，无法撤销：${journalPath(target, relocationId)}`, error);
    }
    const entry = value as Partial<JournalEntry> & { backup?: unknown } | null;
    if (!entry || typeof entry.path !== 'string'
      || (entry.op !== 'entry' && ((entry.op !== 'replace' && entry.op !== 'database') || typeof entry.backup !== 'string'))) {
      throw new DataRootRelocationError('data-root-relocation-journal', `迁移日志里有无法识别的记录：${line}`);
    }
    requireRelative(entry.path);
    if (typeof entry.backup === 'string') requireRelative(entry.backup);
    entries.push(entry as JournalEntry);
  }
  return entries;
}

async function hasDatabaseRestore(target: string, marker: RelocationMarker): Promise<boolean> {
  return (await readJournal(target, marker.relocationId)).some((entry) => entry.op === 'database');
}

/**
 * Undoes a relocation in the target from its journal, newest change first: an existing receiving
 * database and replaced files are put back, created entries removed. Stops at the first failure and
 * keeps the journal for the next attempt. Callers hold the target's admission; a database restore
 * needs every Host of the target offline.
 */
async function undoRelocation(target: string, marker: RelocationMarker): Promise<void> {
  const work = workDirectory(target, marker.relocationId);
  for (const entry of (await readJournal(target, marker.relocationId)).reverse()) {
    const destination = path.join(target, entry.path);
    if (entry.op === 'entry') {
      await removeWithTemporaries(destination);
      continue;
    }
    const backup = path.join(work, entry.backup);
    if (entry.op === 'replace') {
      if (!await pathExists(backup)) continue;
      const previous = await fs.lstat(backup);
      const current = await lstatOrUndefined(destination);
      if (current && (current.isDirectory() || !previous.isFile())) await fs.rm(destination, { recursive: true, force: true });
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(backup, destination);
      await syncDirectoryDurably(path.dirname(destination));
      continue;
    }
    if (!await pathExists(backup)) continue;
    for (const suffix of ['-shm', '-wal', '-journal']) await fs.rm(`${destination}${suffix}`, { force: true });
    await fs.rename(path.join(backup, 'limcode.sqlite'), destination);
    if (await pathExists(path.join(backup, 'limcode.sqlite-wal'))) await fs.rename(path.join(backup, 'limcode.sqlite-wal'), `${destination}-wal`);
    await syncDirectoryDurably(path.dirname(destination));
    await fs.rm(backup, { recursive: true, force: true });
  }
  await fs.rm(work, { recursive: true, force: true });
  const backups = path.join(target, DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY);
  if (!marker.preexisting.includes(DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY)) await fs.rmdir(backups).catch(() => undefined);
  if (marker.previous) await writeMarker(target, marker.previous);
  else await fs.rm(path.join(target, DATA_ROOT_RELOCATION_MARKER_FILE), { force: true });
  await syncDirectoryDurably(target).catch(() => undefined);
  if (marker.createdDirectory) await fs.rmdir(target).catch(() => undefined);
  // The copied data that was renamed aside goes back to its place (only into an empty spot).
  if (marker.movedAside && await pathExists(marker.movedAside) && !await pathExists(target)) {
    await fs.rename(marker.movedAside, target);
    await syncDirectoryDurably(path.dirname(target)).catch(() => undefined);
  }
}

/** A created file together with this process family's temporaries beside it (`<name>.<pid>.<uuid>.tmp`). */
async function removeWithTemporaries(file: string): Promise<void> {
  await fs.rm(file, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  const base = path.basename(file);
  const siblings = await fs.readdir(path.dirname(file)).catch(() => [] as string[]);
  for (const name of siblings) {
    if (name.startsWith(`${base}.`) && isTransientName(name) && name.slice(base.length + 1).match(new RegExp(`^\\d+\\.${UUID_PATTERN}\\.tmp$`))) {
      await fs.rm(path.join(path.dirname(file), name), { recursive: true, force: true });
    }
  }
}

function requireRelative(relative: string): void {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]+/).includes('..')) {
    throw new DataRootRelocationError('data-root-relocation-journal', `迁移日志里的路径无效：${relative}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Records, recovery and leftovers

async function readMarker(root: string): Promise<RelocationMarker | undefined> {
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(path.join(root, DATA_ROOT_RELOCATION_MARKER_FILE), 'utf8')); }
  catch { return undefined; }
  return isMarker(value) && isSamePath(path.resolve(value.targetRootPath), path.resolve(root)) ? value : undefined;
}

function isMarker(value: unknown): value is RelocationMarker {
  const marker = value as Partial<RelocationMarker> | null;
  const strings = (items: unknown): boolean => Array.isArray(items) && items.every((item) => typeof item === 'string');
  const targetState = marker?.targetState as Partial<TargetState & { receivingId: unknown; dataSetIds: unknown }> | undefined;
  return !!marker && marker.kind === MARKER_KIND && (marker.state === 'staging' || marker.state === 'complete')
    && typeof marker.relocationId === 'string' && /^[0-9a-f-]{36}$/.test(marker.relocationId)
    && typeof marker.sourceRootPath === 'string' && typeof marker.targetRootPath === 'string'
    && typeof marker.startedAt === 'string' && typeof marker.receivingId === 'string'
    && typeof marker.createdDirectory === 'boolean' && strings(marker.preexisting)
    && !!marker.owner && typeof marker.owner.processId === 'number'
    && !!targetState && (targetState.kind === 'empty'
      || (targetState.kind === 'copied' && typeof (targetState as { sameDataSet?: unknown }).sameDataSet === 'boolean')
      || (targetState.kind === 'limcode' && typeof targetState.receivingId === 'string' && strings(targetState.dataSetIds)))
    && (marker.movedAside === undefined || typeof marker.movedAside === 'string')
    && (marker.previous === undefined || isMarker(marker.previous))
    && (marker.migrated === undefined || (Array.isArray(marker.migrated) && marker.migrated.every((item) =>
      !!item && typeof item.id === 'string' && typeof item.dataSetId === 'string' && typeof item.rootInstanceId === 'string'
      && !!item.fingerprint && typeof item.fingerprint.contentDigest === 'string')))
    && (marker.configuration === undefined || (Array.isArray(marker.configuration) && marker.configuration.every((item) =>
      !!item && typeof item.entry === 'string' && typeof item.digest === 'string')))
    && (marker.leftBehind === undefined || (Array.isArray(marker.leftBehind) && marker.leftBehind.every((item) =>
      !!item && typeof item.id === 'string' && typeof item.reason === 'string')));
}

async function writeMarker(root: string, marker: RelocationMarker): Promise<void> {
  await writeJsonDurably(path.join(root, DATA_ROOT_RELOCATION_MARKER_FILE), marker);
}

/** Only the latest earlier record is kept (the one an undo puts back). */
function withoutPrevious(marker: RelocationMarker): RelocationMarker {
  const { previous: _older, ...rest } = marker;
  return rest;
}

function currentOwner(): RelocationOwner {
  const identity = ownProcessStartIdentity();
  return { processId: process.pid, ...(identity ? { processStartIdentity: identity } : {}) };
}

function ownerState(owner: RelocationOwner): 'alive' | 'dead' | 'unknown' {
  return classifyRecordedProcess(owner.processId, owner.processStartIdentity);
}

/** Migration evidence of a directory, e.g. for the settings view. */
export async function readDataRootRelocationRecord(root: string): Promise<{
  sourceRootPath: string;
  completedAt?: string;
  invalidated: boolean;
  leftBehind: Array<{ id: string; reason: string }>;
} | undefined> {
  const marker = await readMarker(path.resolve(root));
  if (marker?.state !== 'complete') return undefined;
  return {
    sourceRootPath: marker.sourceRootPath,
    ...(marker.completedAt ? { completedAt: marker.completedAt } : {}),
    invalidated: marker.invalidatedAt !== undefined,
    leftBehind: [...(marker.leftBehind ?? [])]
  };
}

/**
 * "回到旧目录": the completion record of the directory being left no longer describes the old one
 * (data may be written there again), so it can never justify deleting it. Also ends any redo.
 */
export async function invalidateDataRootRelocationRecord(currentRootPath: string): Promise<void> {
  const root = path.resolve(currentRootPath);
  await withRuntimeDataRootAdmission(root, async () => {
    const marker = await readMarker(root);
    if (marker?.state !== 'complete' || marker.invalidatedAt) return;
    await writeMarker(root, { ...marker, invalidatedAt: new Date().toISOString() });
    await finalizeRelocation(root, marker);
  });
}

/**
 * The relocation into this directory took effect (it is the current data directory): its journal
 * and the undo copy of a receiving database are no longer needed. Replaced configuration versions
 * stay for the user.
 */
export async function finalizeDataRootRelocation(currentRootPath: string): Promise<void> {
  const root = path.resolve(currentRootPath);
  const marker = await readMarker(root);
  if (marker?.state !== 'complete' || !await pathExists(journalPath(root, marker.relocationId))) return;
  await withRuntimeDataRootAdmission(root, () => finalizeRelocation(root, marker));
}

async function finalizeRelocation(root: string, marker: RelocationMarker): Promise<void> {
  const work = workDirectory(root, marker.relocationId);
  for (const name of await fs.readdir(work).catch(() => [] as string[])) {
    if (name === JOURNAL_FILE || name.startsWith(DATABASE_BACKUP_PREFIX)) await fs.rm(path.join(work, name), { recursive: true, force: true });
  }
  await fs.rmdir(work).catch(() => undefined);
  await fs.rmdir(path.join(root, DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY)).catch(() => undefined);
}

/**
 * A relocation recorded as in progress (see the data-root pointer) whose process is gone: what it
 * did in the target is undone — its staging, or a completion whose pointer switch never happened
 * (the pointer's record is cleared together with the switch) while the receiving data set is
 * unchanged. 'running' while the owner lives (or cannot be judged), 'blocked' while the target is
 * in use and a database restore would be needed.
 */
export async function recoverInterruptedDataRootRelocation(input: {
  targetRootPath: string;
  relocationId: string;
}): Promise<'recovered' | 'absent' | 'unreachable' | 'running' | 'blocked'> {
  const target = path.resolve(input.targetRootPath);
  // Never takes a claim beside a directory that is not there (an unmounted drive's mount point).
  if (!(await lstatOrUndefined(target).catch(() => undefined))?.isDirectory()) {
    // Nothing was left there when its parent is reachable; otherwise try again another time.
    return (await lstatOrUndefined(path.dirname(target)).catch(() => undefined))?.isDirectory() ? 'absent' : 'unreachable';
  }
  return withRuntimeDataRootAdmission(target, async () => {
    const marker = await readMarker(target);
    if (!marker || marker.relocationId !== input.relocationId) return 'absent';
    if (ownerState(marker.owner) !== 'dead') return 'running';
    if (marker.state === 'complete' && await unfinishedRelocation(target, marker, path.resolve(marker.sourceRootPath)) !== 'undo') return 'absent';
    if (await hasDatabaseRestore(target, marker) && await targetOfflineProblem(target)) return 'blocked';
    await undoRelocation(target, marker);
    return 'recovered';
  });
}

/** State of a recorded relocation's process (for the pointer's in-progress record). */
export function dataRootRelocationOwnerState(owner: RelocationOwner): 'alive' | 'dead' | 'unknown' {
  return ownerState(owner);
}

/**
 * Removes private copies abandoned by crashed processes: the temporary directories of snapshots,
 * pre-copies and row counts (named with their process id) and the Backup API staging files in the
 * control roots of this data directory. Files of earlier builds without an owner go once they are a
 * day old.
 */
export async function sweepDataRootRelocationLeftovers(dataRootPath: string): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const now = Date.now();
  const abandoned = async (name: string, owned: RegExp, unowned: RegExp, file: string): Promise<boolean> => {
    const match = owned.exec(name);
    if (match) return Number(match[1]) !== process.pid && classifyRecordedProcess(Number(match[1]), undefined) === 'dead';
    if (!unowned.test(name)) return false;
    const info = await lstatOrUndefined(file);
    return !!info && now - info.mtimeMs > UNOWNED_LEFTOVER_AGE_MS;
  };
  const temporary = os.tmpdir();
  for (const name of await fs.readdir(temporary).catch(() => [] as string[])) {
    const file = path.join(temporary, name);
    if (await abandoned(name, OWNED_TEMPORARY_DIRECTORY, UNOWNED_TEMPORARY_DIRECTORY, file)) {
      await fs.rm(file, { recursive: true, force: true }).then(() => removed.push(file), () => undefined);
    }
  }
  const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: dataRootPath }).catch(() => undefined);
  for (const candidate of inspection?.candidates ?? []) {
    const controlRoot = path.dirname(candidate.runtimeDataRootPath);
    for (const name of await fs.readdir(controlRoot).catch(() => [] as string[])) {
      const file = path.join(controlRoot, name);
      if (await abandoned(name, OWNED_STAGING_FILE, UNOWNED_STAGING_FILE, file)) {
        await fs.rm(file, { force: true }).then(() => removed.push(file), () => undefined);
      }
    }
  }
  return { removed };
}

// ---------------------------------------------------------------------------------------------
// Deleting the old directory

export interface OldDataRootDeletionItem {
  key: string;
  kind: 'data-set' | 'configuration' | 'backup' | 'metadata';
  /** User-facing description. */
  label: string;
  paths: string[];
  bytes: number;
  /** Deleted only when the user ticks it (backups and archives). */
  optional: boolean;
  deletable: boolean;
  /** Why it stays (when not deletable). */
  reason?: string;
}

export interface OldDataRootDeletionPlan {
  oldRootPath: string;
  problems: string[];
  items: OldDataRootDeletionItem[];
  /** Top-level entries that stay in any case, each with the reason. */
  kept: Array<{ name: string; reason: string }>;
}

/**
 * What "delete the old directory" may remove: only what the current directory's completion record
 * proves was carried over from it and is unchanged since — data sets by content fingerprint,
 * configuration entries by tree digest — plus LimCode's bookkeeping once no data set is left.
 * Backups and archives are listed with their sizes and removed only when ticked. Everything else
 * (files of the user, data written after the move) stays, and so does the directory itself.
 */
export async function planOldDataRootDeletion(input: {
  oldRootPath: string;
  currentRootPath: string;
  /** VS Code's own storage directory keeps the pointer file and is never removed itself. */
  keepEntries?: readonly string[];
}): Promise<OldDataRootDeletionPlan> {
  const oldRoot = path.resolve(input.oldRootPath);
  const currentRoot = path.resolve(input.currentRootPath);
  const problems: string[] = [];
  if (isSamePath(oldRoot, currentRoot)) problems.push('旧目录就是当前数据目录。');
  const marker = await readMarker(currentRoot);
  if (marker?.state !== 'complete' || !isSamePath(path.resolve(marker.sourceRootPath), oldRoot)) {
    problems.push('找不到从这个目录迁移完成的记录，为避免误删，不能在这里删除它。');
  } else if (marker.invalidatedAt) {
    problems.push('迁移之后回到过这个旧目录，它可能有新的数据；迁移记录不再作为删除依据。需要时请再迁移一次（会合并），之后才能删除。');
  }
  if (problems.length > 0 || !marker) return { oldRootPath: oldRoot, problems, items: [], kept: [] };
  const items: OldDataRootDeletionItem[] = [];
  const covered = new Set<string>();
  const cover = (absolute: string): void => { covered.add(path.relative(oldRoot, absolute).split(path.sep)[0]); };

  const inspection = await inspectVscodeRuntimeDataSets({ globalStoragePath: oldRoot });
  let everyDataSetGoes = inspection.problems.length === 0;
  for (const candidate of inspection.candidates) {
    const controlRoot = path.dirname(candidate.runtimeDataRootPath);
    const scopeRoot = candidate.runtimeScopeRootPath;
    for (const name of CONTROL_ROOT_BACKUP_DIRECTORIES) {
      const backup = path.join(controlRoot, name);
      if (!await pathExists(backup)) continue;
      items.push({
        key: `backup:${candidate.id}:${name}`, kind: 'backup', label: `历史库 ${candidate.id} 的${backupLabel(name)}`,
        paths: [backup], bytes: (await measureTree(backup)).bytes, optional: true, deletable: true
      });
    }
    const archives = path.join(scopeRoot, RESET_ARCHIVES_DIRECTORY);
    if (await pathExists(archives)) {
      items.push({
        key: `backup:${candidate.id}:${RESET_ARCHIVES_DIRECTORY}`, kind: 'backup',
        label: `历史库 ${candidate.id} 的“归档并重置”归档（含当时的对话）`,
        paths: [archives], bytes: (await measureTree(archives)).bytes, optional: true, deletable: true
      });
      cover(archives);
    }
    if (!candidate.dataSetId) continue;
    const paths = (await fs.readdir(controlRoot).catch(() => [] as string[]))
      .filter((name) => !CONTROL_ROOT_BACKUP_DIRECTORIES.includes(name)).map((name) => path.join(controlRoot, name));
    let bytes = 0;
    for (const entry of paths) bytes += (await measureTree(entry)).bytes;
    cover(controlRoot);
    const migrated = marker.migrated?.find((item) => item.id === candidate.id
      && item.dataSetId === candidate.dataSetId && item.rootInstanceId === candidate.rootInstanceId);
    let reason: string | undefined;
    if (!migrated) reason = '没有迁移到当前目录';
    else {
      const now = await dataSetFingerprint(candidate).catch(() => undefined);
      if (!now) reason = '无法读取，无法确认迁移之后没有改动';
      else if (!sameRuntimeDataSetFingerprint(migrated.fingerprint, now)) reason = '迁移之后这个历史库有新的改动';
    }
    if (reason) everyDataSetGoes = false;
    items.push({
      key: `data-set:${candidate.id}`, kind: 'data-set',
      label: `历史库 ${candidate.id}${candidate.selected ? '（旧目录的当前库）' : ''}${migrated?.mergedInto ? '（已合并进当前库）' : ''}`,
      paths, bytes, optional: false, deletable: !reason, ...(reason ? { reason } : {})
    });
  }
  for (const problem of inspection.problems) {
    const relative = path.relative(oldRoot, problem.runtimeScopeRootPath).split(path.sep)[0];
    if (relative && relative !== '..') covered.add(relative);
    items.push({
      key: `data-set:${problem.id}`, kind: 'data-set', label: `历史库 ${problem.id}`, paths: [], bytes: 0,
      optional: false, deletable: false, reason: `无法读取，保留：${problem.message}`
    });
  }

  for (const copied of marker.configuration ?? []) {
    const entry = path.join(oldRoot, copied.entry);
    if (!await pathExists(entry)) continue;
    cover(entry);
    const unchanged = await treeDigest(entry).then((digest) => digest === copied.digest, () => false);
    items.push({
      key: `configuration:${copied.entry}`, kind: 'configuration', label: configurationLabel(copied.entry), paths: [entry],
      bytes: (await measureTree(entry)).bytes, optional: false, deletable: unchanged,
      ...(unchanged ? {} : { reason: '迁移之后有改动' })
    });
  }
  for (const name of [DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY, DATA_ROOT_BACKUPS_DIR]) {
    const backup = path.join(oldRoot, name);
    if (!await pathExists(backup)) continue;
    cover(backup);
    items.push({
      key: `backup:${name}`, kind: 'backup',
      label: name === DATA_ROOT_BACKUPS_DIR ? '旧版本开发数据的重置备份' : '更早一次迁移时被替换的设置版本',
      paths: [backup], bytes: (await measureTree(backup)).bytes, optional: true, deletable: true
    });
  }
  const metadata: string[] = [];
  for (const name of METADATA_ENTRIES) {
    if (await pathExists(path.join(oldRoot, name))) metadata.push(path.join(oldRoot, name));
  }
  if (metadata.length > 0) {
    for (const entry of metadata) cover(entry);
    let bytes = 0;
    for (const entry of metadata) bytes += (await measureTree(entry)).bytes;
    items.push({
      key: 'metadata', kind: 'metadata', label: 'LimCode 的目录记录（当前库选择、合并记录、目录标识）', paths: metadata, bytes,
      optional: false, deletable: everyDataSetGoes, ...(everyDataSetGoes ? {} : { reason: '旧目录里还有保留的历史库，需要这些记录' })
    });
  }
  if (await pathExists(path.join(oldRoot, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY))) covered.add(VSCODE_WORKSPACE_RUNTIMES_DIRECTORY);
  if (await pathExists(path.join(oldRoot, VSCODE_RUNTIME_CONTROL_DIRECTORY))) covered.add(VSCODE_RUNTIME_CONTROL_DIRECTORY);

  const keep = input.keepEntries ?? [];
  const kept: OldDataRootDeletionPlan['kept'] = [];
  for (const name of (await fs.readdir(oldRoot).catch(() => [] as string[])).sort()) {
    if (covered.has(name) || isClaimName(name) || keep.some((entry) => name === entry || name.startsWith(`${entry}.`))) continue;
    kept.push({
      name,
      reason: CONFIGURATION_ENTRIES.includes(name) ? '不是本次迁移复制过去的内容（可能是你自己的文件），保留' : '不是 LimCode 迁移的数据，保留'
    });
  }
  return { oldRootPath: oldRoot, problems, items, kept };
}

/**
 * Deletes what the user confirmed: every deletable item that is not optional, and the optional ones
 * in `include`. The plan is computed again under the old directory's admission with every Host of
 * it offline; when it no longer matches what was confirmed, nothing is deleted.
 */
export async function deleteOldDataRoot(input: {
  oldRootPath: string;
  currentRootPath: string;
  keepEntries?: readonly string[];
  include?: readonly string[];
  /** Keys of the items the confirmation listed for deletion. */
  confirmedKeys: readonly string[];
}): Promise<{ removed: string[]; remainingDataSets: number }> {
  const oldRoot = path.resolve(input.oldRootPath);
  return withRuntimeDataRootAdmission(oldRoot, async () => {
    await assertConfigurationRootRuntimesOffline(oldRoot);
    const plan = await planOldDataRootDeletion(input);
    if (plan.problems.length > 0) throw new DataRootRelocationError('data-root-old-delete-refused', plan.problems.join('\n'));
    const include = new Set(input.include ?? []);
    const selected = plan.items.filter((item) => item.deletable && (!item.optional || include.has(item.key)));
    const keys = selected.map((item) => item.key).sort();
    if (!isDeepStrictEqual(keys, [...input.confirmedKeys].sort())) {
      throw new DataRootRelocationError('data-root-old-delete-changed', '确认之后旧目录发生了变化，没有删除任何内容；请重新查看后再删除。');
    }
    const order: Array<OldDataRootDeletionItem['kind']> = ['data-set', 'backup', 'configuration', 'metadata'];
    for (const kind of order) {
      for (const item of selected.filter((entry) => entry.kind === kind)) {
        for (const entry of item.paths) await fs.rm(entry, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      }
    }
    await removeEmptyDirectories(oldRoot);
    const after = await inspectVscodeRuntimeDataSets({ globalStoragePath: oldRoot }).catch(() => undefined);
    const remainingDataSets = after ? after.candidates.filter((candidate) => candidate.dataSetId).length + after.problems.length : 0;
    return { removed: keys, remainingDataSets };
  });
}

/** Control roots, scope roots and the workspace-runtimes container left empty by a deletion. */
async function removeEmptyDirectories(oldRoot: string): Promise<void> {
  const scopes = path.join(oldRoot, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, 'scopes');
  for (const key of await fs.readdir(scopes).catch(() => [] as string[])) {
    const scope = path.join(scopes, key);
    await fs.rmdir(path.join(scope, VSCODE_RUNTIME_CONTROL_DIRECTORY)).catch(() => undefined);
    await fs.rmdir(scope).catch(() => undefined);
  }
  await fs.rmdir(scopes).catch(() => undefined);
  await fs.rmdir(path.join(oldRoot, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY)).catch(() => undefined);
  await fs.rmdir(path.join(oldRoot, VSCODE_RUNTIME_CONTROL_DIRECTORY)).catch(() => undefined);
}

function backupLabel(name: string): string {
  return name === RUNTIME_DATA_SET_MERGE_BACKUPS_DIRECTORY ? '合并前备份'
    : name === RUNTIME_DATA_SET_MERGE_SOURCE_BACKUPS_DIRECTORY ? '合并来源备份' : '升级前备份';
}

function configurationLabel(entry: string): string {
  if (entry === 'AGENTS.md' || entry === 'CLAUDE.md') return `全局规则 ${entry}`;
  if (entry === 'skills') return '全局技能 skills/';
  return `设置 ${entry}`;
}

// ---------------------------------------------------------------------------------------------
// Files

function isClaimName(name: string): boolean {
  return name.endsWith('.runtime-maintenance') || name.includes('.runtime-maintenance.generation-')
    || name.endsWith('.runtime-admission') || name.includes('.runtime-admission.generation-');
}

/**
 * LimCode's own record-store locks and atomic-write temporaries, by their exact shapes; a user file
 * that merely ends in .lock or .tmp (e.g. in a checkpoint worktree) is configuration like any other.
 */
function isTransientName(name: string): boolean {
  return name === `${INDEX_FILE}.lock` || name.startsWith(`${INDEX_FILE}.lock.generation-`)
    || /\.\d+\.\d+\.\d+\.tmp$/.test(name)
    || new RegExp(`\\.\\d+\\.${UUID_PATTERN}\\.tmp$`).test(name);
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

async function walkSizes(root: string, visit: (file: string, info: Stats) => void): Promise<void> {
  const walk = async (entry: string): Promise<void> => {
    const info = await lstatOrUndefined(entry);
    if (!info || info.isSymbolicLink()) return;
    if (info.isFile()) visit(entry, info);
    else if (info.isDirectory()) {
      for (const name of await fs.readdir(entry).catch(() => [] as string[])) await walk(path.join(entry, name));
    }
  };
  await walk(root);
}

async function measureTree(root: string): Promise<{ files: number; bytes: number; allocated: number }> {
  const result = { files: 0, bytes: 0, allocated: 0 };
  await walkSizes(root, (_file, info) => {
    result.files += 1;
    result.bytes += info.size;
    result.allocated += allocatedBytes(info);
  });
  return result;
}

function allocatedBytes(info: Stats): number {
  // POSIX reports 512-byte blocks; elsewhere round up to a common 4 KiB cluster.
  return typeof info.blocks === 'number' && info.blocks > 0 ? info.blocks * 512 : Math.ceil(info.size / 4096) * 4096;
}

async function lstatOrUndefined(target: string): Promise<Stats | undefined> {
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

/** Copy, fsync, verify, rename into place; the caller syncs the directory. */
async function copyVerified(from: string, to: string, digest: string): Promise<void> {
  const temporary = `${to}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await copyDurably(from, temporary);
    if (await sha256File(temporary) !== digest) {
      throw new DataRootRelocationError('data-root-relocation-copy-mismatch', `复制后的文件与原文件不一致：${from}`);
    }
    await fs.rename(temporary, to);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function copyDurably(from: string, to: string): Promise<void> {
  await fs.copyFile(from, to, constants.COPYFILE_EXCL);
  const handle = await fs.open(to, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeJsonDurably(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    await syncDirectoryDurably(path.dirname(file));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function removeSqliteFiles(file: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm', '-journal']) await fs.rm(`${file}${suffix}`, { force: true });
}

function dataRootUnavailableMessage(root: string, reason: DataRootUnavailableReason): string {
  const detail = reason === 'missing' ? '目录不存在'
    : reason === 'not-directory' ? '这个位置不是文件夹'
      : reason === 'empty' ? '目录里没有 LimCode 数据'
        : reason === 'mismatch' ? '目录里不是原来那份 LimCode 数据' : '目录无法读取';
  return `数据目录不可用（${detail}）：${root}。可能是外置盘没有接上或网络盘断开；为避免在这里新建一份空的历史，本窗口没有打开运行时。`;
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
