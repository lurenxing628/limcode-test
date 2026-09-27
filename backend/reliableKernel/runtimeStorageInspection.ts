import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { createRuntimeRootPaths, type RootBinding } from './contracts';
import { assertDatabaseBinding, configureReaderConnection } from './databaseSchema';
import { RootAuthority, type HistoricalRootBinding } from './rootAuthority';
import type { LocatedRuntimeRoot } from './runtimeLocatedRoot';
import {
  assertRuntimeHostsOffline, runtimeMaintenanceClaimPath, withRuntimeDataRootAdmission, withRuntimeMaintenance
} from './runtimeHostControl';
import { toSqliteFilePath } from './sqliteFilePath';
import { isPathBelow, isSamePath } from '../capabilities/filesystem/pathContainment';
import {
  listVscodeRuntimeDataSets,
  resolveVscodeRuntimeDataSet,
  VSCODE_RUNTIME_CONTROL_DIRECTORY,
  type VscodeRuntimeDataSetCandidate
} from './vscodeRootAuthority';

export type RuntimeStorageCategory =
  | 'sqlite' | 'cas' | 'casTemporary' | 'processSpool' | 'diagnostics' | 'other' | 'historicalBackups';

export interface RuntimeStorageSize {
  fileCount: number;
  /** Logical file bytes, not allocated filesystem blocks; decimal text remains JSON-safe. */
  bytes: string;
}

export interface RuntimeDataSetStorageInspection {
  candidateId: string;
  dataSetId: string;
  observedAt: string;
  /** A live root may change while this explicitly requested filesystem walk runs. */
  selected: boolean;
  categories: Record<RuntimeStorageCategory, RuntimeStorageSize>;
  total: RuntimeStorageSize;
  archiveReclaimsBytes: false;
}

type StoragePaths = { globalStoragePath: string };
const CATEGORIES: readonly RuntimeStorageCategory[] = [
  'sqlite', 'cas', 'casTemporary', 'processSpool', 'diagnostics', 'other', 'historicalBackups'
];
/**
 * Complete control roots archived by VscodeReliableKernelCutoverCoordinator live beside the active
 * control root. They are not part of the scope's data set: its storage inspection does not count them
 * and deleting it keeps them; each is listed as foreign history of its own (runtimeForeignHistory).
 */
const RUNTIME_SCOPE_BACKUPS_DIRECTORY = '.limcode-runtime-backups';

/** Explicit command only. Walk actual files once, never sum duplicate ContentObject metadata. */
export async function inspectRuntimeDataSetStorage(
  paths: StoragePaths,
  candidateId: string
): Promise<RuntimeDataSetStorageInspection> {
  const candidate = await resolveVscodeRuntimeDataSet(paths, candidateId);
  const binding = await requireCompleteRuntimeDataSet(candidate);
  const categories = Object.fromEntries(CATEGORIES.map((key) => [key, { fileCount: 0, bytes: '0' }])) as
    Record<RuntimeStorageCategory, RuntimeStorageSize>;
  const total: RuntimeStorageSize = { fileCount: 0, bytes: '0' };
  const { trees, excluded } = await runtimeDataSetTrees(candidate);
  for (const tree of trees) {
    await walkRuntimeDataSetFiles(tree, async (filePath, size) => {
      const category = classifyStoragePath(candidate, filePath);
      addSize(categories[category], size);
      addSize(total, size);
    }, excluded);
  }
  // Do not present a scan of a replaced/deleted root as this candidate's current usage.
  const current = await resolveVscodeRuntimeDataSet(paths, candidateId);
  const currentBinding = await requireCompleteRuntimeDataSet(current);
  if (JSON.stringify(currentBinding) !== JSON.stringify(binding)) {
    throw new Error('Runtime data-set identity changed during storage inspection; retry the command.');
  }
  return {
    candidateId, dataSetId: binding.dataSetId, observedAt: new Date().toISOString(),
    selected: current.selected, categories, total, archiveReclaimsBytes: false
  };
}

/**
 * The UI must obtain explicit permanent-delete confirmation for this complete candidate first.
 * Admission and offline checks are repeated here; no per-CAS-object deletion exists.
 */
export async function deleteUnselectedRuntimeDataSet(
  paths: StoragePaths,
  candidateId: string,
  expectedDataSetId: string
): Promise<{ candidateId: string; dataSetId: string; deleted: RuntimeStorageSize }> {
  const configurationRootPath = path.resolve(paths.globalStoragePath);
  return withRuntimeDataRootAdmission(configurationRootPath, async () => {
    const selected = (await listVscodeRuntimeDataSets(paths)).filter((entry) => entry.selected);
    if (selected.length !== 1 || !selected[0].dataSetId) {
      throw new Error('Select a fixed current Runtime data set before permanently deleting another data set.');
    }
    const candidate = await resolveVscodeRuntimeDataSet(paths, candidateId);
    if (candidate.selected) throw new Error('The selected Runtime data set cannot be deleted.');
    const binding = await requireCompleteRuntimeDataSet(candidate);
    if (!expectedDataSetId || binding.dataSetId !== expectedDataSetId) {
      throw new Error('The confirmed Runtime data-set identity changed before deletion.');
    }
    const result = await withRuntimeMaintenance(binding.paths, async () => {
      await assertRuntimeHostsOffline(binding.paths);
      const current = await resolveVscodeRuntimeDataSet(paths, candidateId);
      if (current.selected) throw new Error('The selected Runtime data set cannot be deleted.');
      const currentBinding = await requireCompleteRuntimeDataSet(current);
      if (JSON.stringify(currentBinding) !== JSON.stringify(binding)) {
        throw new Error('Runtime data-set identity changed before deletion.');
      }
      // Identity must also be present in the actual SQLite file, not only in adjacent JSON files.
      const snapshot = await createRuntimeDataSetDatabaseSnapshot(current, currentBinding);
      await snapshot.close();
      const { trees, excluded } = await runtimeDataSetTrees(current);
      const maintenancePath = runtimeMaintenanceClaimPath(binding.paths);
      const deleted: RuntimeStorageSize = { fileCount: 0, bytes: '0' };
      // Validate every tree before deleting any. Reset archives of the scope are never part of it:
      // they stay, and are listed as foreign history afterwards.
      for (const tree of trees) {
        await walkRuntimeDataSetFiles(tree, async (_filePath, size) => addSize(deleted, size), [maintenancePath, ...excluded]);
      }
      for (const tree of trees) {
        if (path.dirname(maintenancePath) === tree) {
          // The per-scope claim is a sibling of its control root, inside the workspace scope.
          // Keep our claim alive through all deletions; its finally block releases it normally.
          for (const entry of await fs.readdir(tree)) {
            const entryPath = path.join(tree, entry);
            if (entryPath !== maintenancePath && !excluded.includes(entryPath)) await fs.rm(entryPath, { recursive: true, force: false });
          }
        } else await fs.rm(tree, { recursive: true, force: false });
      }
      return { candidateId, dataSetId: binding.dataSetId, deleted };
    });
    // Claim release may leave its non-authoritative generation directory after a cleanup error.
    // Finish deleting this already-confirmed scope only after release, while configuration
    // admission still excludes new Hosts. Never recursively remove the shared configuration root.
    if (!isSamePath(candidate.runtimeScopeRootPath, configurationRootPath)) {
      const archives = path.join(candidate.runtimeScopeRootPath, RUNTIME_SCOPE_BACKUPS_DIRECTORY);
      if (!await exists(archives)) {
        await fs.rm(candidate.runtimeScopeRootPath, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
      } else {
        // The scope keeps only its reset archives; enumeration no longer counts it as a data set.
        for (const entry of await fs.readdir(candidate.runtimeScopeRootPath)) {
          if (entry === RUNTIME_SCOPE_BACKUPS_DIRECTORY) continue;
          await fs.rm(path.join(candidate.runtimeScopeRootPath, entry), { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
        }
      }
    }
    return result;
  });
}

export interface RuntimeDataSetDatabaseSnapshot {
  database: Database.Database;
  close(): Promise<void>;
}

/**
 * Call only under configuration admission + target maintenance after its Hosts are offline.
 * Even SQLite readonly creates WAL sidecars, so it must open a temporary copy, never the source.
 * COPYFILE_FICLONE requests an efficient filesystem clone where supported; normal copy semantics
 * elsewhere preserve the same read-only-source contract. This is only an explicit command path.
 */
export async function createRuntimeDataSetDatabaseSnapshot(
  candidate: VscodeRuntimeDataSetCandidate,
  binding: HistoricalRootBinding,
  options: {
    /**
     * Runs on the finished private copy before this thread opens it (e.g. a worker audit). The
     * copy is then closed by every other connection of this process; see runtimeSnapshotAudit.
     */
    beforeOpen?(snapshotPath: string): Promise<void>;
  } = {}
): Promise<RuntimeDataSetDatabaseSnapshot> {
  return openRuntimeDatabaseSnapshotCopy(await copyRuntimeDataSetDatabase(candidate, binding), binding, options);
}

/**
 * The same private snapshot of a located root: copied from its located database only (checked
 * link-free below its container), fenced by the recorded binding. Callers hold the root's fence
 * (maintenance for a local data set, the foreign claim for a foreign root) with its Hosts offline.
 */
export async function createLocatedRuntimeDatabaseSnapshot(
  root: LocatedRuntimeRoot,
  options: {
    beforeOpen?(snapshotPath: string): Promise<void>;
    /** Takes the private copy instead, e.g. one that counts only when the files kept their state while copied. */
    copy?(root: LocatedRuntimeRoot): Promise<{ databasePath: string; remove(): Promise<void> }>;
  } = {}
): Promise<RuntimeDataSetDatabaseSnapshot> {
  const copy = options.copy ? await options.copy(root) : await copyRuntimeSqliteFiles(root.containerRoot, root.located.databasePath);
  return openRuntimeDatabaseSnapshotCopy(copy, root.recorded, options);
}

async function openRuntimeDatabaseSnapshotCopy(
  copy: { databasePath: string; remove(): Promise<void> },
  binding: HistoricalRootBinding,
  options: { beforeOpen?(snapshotPath: string): Promise<void> }
): Promise<RuntimeDataSetDatabaseSnapshot> {
  let database: Database.Database | undefined;
  try {
    const snapshotPath = copy.databasePath;
    await options.beforeOpen?.(snapshotPath);
    database = new Database(toSqliteFilePath(snapshotPath), { readonly: true, fileMustExist: true });
    configureReaderConnection(database);
    database.pragma('query_only = ON');
    // This comparison is epoch-agnostic and makes no migration or schema compatibility claim.
    assertDatabaseBinding(database, binding as RootBinding);
    let closed = false;
    return {
      database,
      async close() {
        if (closed) return;
        closed = true;
        database!.close();
        await copy.remove();
      }
    };
  } catch (error) {
    database?.close();
    await copy.remove();
    throw error;
  }
}

/**
 * Private copy of a data set's SQLite database and WAL (never its -shm) in a fresh temporary
 * directory; nothing of the source is opened. Same caller contract as the snapshot above.
 */
export async function copyRuntimeDataSetDatabase(
  candidate: VscodeRuntimeDataSetCandidate,
  binding: HistoricalRootBinding
): Promise<{ databasePath: string; remove(): Promise<void> }> {
  return copyRuntimeSqliteFiles(candidate.configurationRootPath, binding.paths.databasePath);
}

/**
 * Private copy of one SQLite file of a configuration root (a data set's database or a backup) and
 * its WAL, never its -shm, in a fresh temporary directory; the source is only copied, never opened
 * by SQLite. Same caller contract: never a database this process has open.
 */
export async function copyRuntimeSqliteFiles(
  configurationRootPath: string,
  sourceDatabasePath: string
): Promise<{ databasePath: string; remove(): Promise<void> }> {
  await assertNoSymbolicPath(configurationRootPath, sourceDatabasePath);
  if (!(await fs.lstat(sourceDatabasePath)).isFile()) throw new Error('Historical SQLite database is not a regular file.');
  // Named with this process id: a crashed process's copies are found and removed (sweepDataRootRelocationLeftovers).
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-runtime-history-${process.pid}-`));
  const remove = () => fs.rm(temporaryRoot, { recursive: true, force: true });
  try {
    const databasePath = path.join(temporaryRoot, 'limcode.sqlite');
    await fs.copyFile(sourceDatabasePath, databasePath, constants.COPYFILE_FICLONE);
    for (const suffix of ['-wal', '-journal']) {
      const source = `${sourceDatabasePath}${suffix}`;
      if (!await exists(source)) continue;
      await assertNoSymbolicPath(configurationRootPath, source);
      const stat = await fs.lstat(source);
      if (!stat.isFile()) throw new Error(`Historical SQLite sidecar is not a regular file: ${suffix}`);
      if (suffix === '-journal' && stat.size > 0) {
        throw new Error('Historical SQLite has a rollback journal; finish its existing offline recovery first.');
      }
      if (suffix === '-wal') await fs.copyFile(source, `${databasePath}${suffix}`, constants.COPYFILE_FICLONE);
    }
    return { databasePath, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

/** Read-only pointer access: current() is deliberately avoided because it can recover pending state. */
export async function requireCompleteRuntimeDataSet(
  candidate: VscodeRuntimeDataSetCandidate
): Promise<HistoricalRootBinding> {
  if (!candidate.dataSetId) throw new Error('Runtime data set is not initialized and has no history to inspect.');
  const expected = createRuntimeRootPaths(candidate.runtimeDataRootPath);
  await assertNoSymbolicPath(candidate.configurationRootPath, path.dirname(expected.rootPointerPath));
  await assertNoSymbolicPath(candidate.configurationRootPath, expected.dataRootPath);
  if (await exists(expected.rootPendingPath)) {
    throw new Error('Runtime has a pending root transition; complete its existing offline recovery before inspection.');
  }
  const authority = new RootAuthority(() => candidate.runtimeDataRootPath);
  const binding = await authority.readHistoricalPointerForCutover();
  if (!binding || binding.dataSetId !== candidate.dataSetId
    || JSON.stringify(binding.paths) !== JSON.stringify(expected)) {
    throw new Error('Runtime candidate and RootBinding identity/path mismatch.');
  }
  await assertNoSymbolicPath(candidate.configurationRootPath, expected.rootPointerPath);
  await assertNoSymbolicPath(candidate.configurationRootPath, expected.databasePath);
  await assertNoSymbolicPath(candidate.configurationRootPath, expected.casRootPath);
  await assertNoSymbolicPath(candidate.configurationRootPath, expected.runtimeEpochPath);
  if (!(await fs.lstat(expected.databasePath)).isFile() || !(await fs.lstat(expected.casRootPath)).isDirectory()) {
    throw new Error('Runtime candidate is incomplete: expected a SQLite file and CAS directory.');
  }
  const epoch: unknown = JSON.parse(await fs.readFile(expected.runtimeEpochPath, 'utf8'));
  const record = epoch && typeof epoch === 'object' && !Array.isArray(epoch)
    ? epoch as Record<string, unknown> : {};
  const keys = ['kind', 'runtimeKernelEpoch', 'dataSetId', 'rootInstanceId', 'rootGeneration', 'initializedAt'];
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
    || record.kind !== 'limcode-runtime-kernel-epoch'
    || record.runtimeKernelEpoch !== binding.runtimeKernelEpoch
    || record.dataSetId !== binding.dataSetId || record.rootInstanceId !== binding.rootInstanceId
    || record.rootGeneration !== binding.rootGeneration
    || typeof record.initializedAt !== 'string' || record.initializedAt.length === 0) {
    throw new Error('Runtime epoch manifest does not match the historical RootBinding.');
  }
  return binding;
}

async function runtimeDataSetTrees(candidate: VscodeRuntimeDataSetCandidate): Promise<{ trees: string[]; excluded: string[] }> {
  const configuration = path.resolve(candidate.configurationRootPath);
  const scope = path.resolve(candidate.runtimeScopeRootPath);
  // A default/legacy scope shares the configuration root. Never delete or count that whole root.
  const tree = scope === configuration ? path.join(scope, VSCODE_RUNTIME_CONTROL_DIRECTORY) : scope;
  if (!isPathBelow(configuration, tree)) {
    throw new Error('Runtime data-set tree escapes its configuration root.');
  }
  const backups = path.join(scope, RUNTIME_SCOPE_BACKUPS_DIRECTORY);
  const hasBackups = await exists(backups);
  if (hasBackups) {
    await assertNoSymbolicPath(configuration, backups);
    if (!(await fs.lstat(backups)).isDirectory()) throw new Error('Runtime scope backups must be a directory.');
  }
  // A workspace scope is one tree that also holds the archives directory; it is walked around.
  return { trees: [tree], excluded: scope === configuration || !hasBackups ? [] : [backups] };
}

function classifyStoragePath(candidate: VscodeRuntimeDataSetCandidate, filePath: string): RuntimeStorageCategory {
  const control = path.join(candidate.runtimeScopeRootPath, VSCODE_RUNTIME_CONTROL_DIRECTORY);
  return classifyControlRootPath(control, candidate.runtimeDataRootPath, filePath);
}

function classifyControlRootPath(control: string, dataRootPath: string, filePath: string): RuntimeStorageCategory {
  const controlRelative = path.relative(control, filePath).split(path.sep);
  if (controlRelative[0] === 'backups' || controlRelative[0] === 'epoch-migration-backups'
    || controlRelative[0] === 'merge-backups' || controlRelative[0] === 'merge-source-backups') return 'historicalBackups';
  const relative = path.relative(dataRootPath, filePath).split(path.sep);
  if (relative.length === 1 && ['limcode.sqlite', 'limcode.sqlite-wal', 'limcode.sqlite-shm', 'limcode.sqlite-journal'].includes(relative[0])) return 'sqlite';
  if (relative[0] === 'cas') return relative[1] === 'tmp' ? 'casTemporary' : 'cas';
  if (relative[0] === 'process-spool') return 'processSpool';
  if (relative[0] === 'diagnostics') return 'diagnostics';
  return 'other';
}

async function walkRuntimeDataSetFiles(
  root: string,
  consume: (filePath: string, bytes: bigint) => Promise<void>,
  excludedRoots: readonly string[] = []
): Promise<void> {
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (excludedRoots.includes(current)) continue;
    const stat = await fs.lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error(`Runtime inspection refuses symbolic links: ${current}`);
    if (stat.isFile()) await consume(current, stat.size);
    else if (stat.isDirectory()) {
      for (const name of await fs.readdir(current)) queue.push(path.join(current, name));
    } else throw new Error(`Runtime inspection refuses unsupported filesystem entries: ${current}`);
  }
}

/**
 * Storage of a located root: its located control tree (the archive directory, or a copied scope's
 * `.limcode-runtime`) walked once without following links. Never reads a recorded path.
 */
export async function inspectLocatedRuntimeStorage(root: LocatedRuntimeRoot): Promise<RuntimeDataSetStorageInspection> {
  const control = path.dirname(root.located.rootPointerPath);
  await assertNoSymbolicPath(root.containerRoot, control);
  const categories = Object.fromEntries(CATEGORIES.map((key) => [key, { fileCount: 0, bytes: '0' }])) as
    Record<RuntimeStorageCategory, RuntimeStorageSize>;
  const total: RuntimeStorageSize = { fileCount: 0, bytes: '0' };
  await walkRuntimeDataSetFiles(control, async (filePath, size) => {
    addSize(categories[classifyControlRootPath(control, root.located.dataRootPath, filePath)], size);
    addSize(total, size);
  });
  return {
    candidateId: root.id, dataSetId: root.recorded.dataSetId, observedAt: new Date().toISOString(),
    selected: false, categories, total, archiveReclaimsBytes: false
  };
}

export async function assertNoSymbolicPath(root: string, target: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, path.resolve(target));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Runtime file escapes its configuration root.');
  }
  let current = resolvedRoot;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Runtime path is a symbolic link: ${current}`);
  }
}

function addSize(target: RuntimeStorageSize, bytes: bigint): void {
  target.fileCount += 1;
  target.bytes = (BigInt(target.bytes) + bytes).toString();
}

async function exists(filePath: string): Promise<boolean> {
  try { await fs.lstat(filePath); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
