import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { createRuntimeRootPaths, type RootBinding } from './contracts';
import { assertDatabaseBinding, configureReaderConnection } from './databaseSchema';
import { RootAuthority, type HistoricalRootBinding } from './rootAuthority';
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
/** Complete control roots archived by VscodeReliableKernelCutoverCoordinator live beside the active control root. */
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
  for (const tree of await runtimeDataSetTrees(candidate)) {
    await walkRuntimeDataSetFiles(tree, async (filePath, size) => {
      const category = classifyStoragePath(candidate, filePath);
      addSize(categories[category], size);
      addSize(total, size);
    });
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
      const trees = await runtimeDataSetTrees(current);
      const maintenancePath = runtimeMaintenanceClaimPath(binding.paths);
      const deleted: RuntimeStorageSize = { fileCount: 0, bytes: '0' };
      // Validate every tree before deleting any. For default roots, delete backups first so a
      // backup cleanup failure leaves the complete active candidate available for a retry.
      for (const tree of trees) await walkRuntimeDataSetFiles(tree, async (_filePath, size) => addSize(deleted, size), maintenancePath);
      for (const tree of trees) {
        if (path.dirname(maintenancePath) === tree) {
          // The per-scope claim is a sibling of its control root, inside the workspace scope.
          // Keep our claim alive through all deletions; its finally block releases it normally.
          for (const entry of await fs.readdir(tree)) {
            const entryPath = path.join(tree, entry);
            if (entryPath !== maintenancePath) await fs.rm(entryPath, { recursive: true, force: false });
          }
        } else await fs.rm(tree, { recursive: true, force: false });
      }
      return { candidateId, dataSetId: binding.dataSetId, deleted };
    });
    // Claim release may leave its non-authoritative generation directory after a cleanup error.
    // Finish deleting this already-confirmed scope only after release, while configuration
    // admission still excludes new Hosts. Never recursively remove the shared configuration root.
    if (!isSamePath(candidate.runtimeScopeRootPath, configurationRootPath)) {
      await fs.rm(candidate.runtimeScopeRootPath, { recursive: true, force: false, maxRetries: 3, retryDelay: 50 });
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
  binding: HistoricalRootBinding
): Promise<RuntimeDataSetDatabaseSnapshot> {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-runtime-history-'));
  let database: Database.Database | undefined;
  try {
    const snapshotPath = path.join(temporaryRoot, 'limcode.sqlite');
    await fs.copyFile(binding.paths.databasePath, snapshotPath, constants.COPYFILE_FICLONE);
    for (const suffix of ['-wal', '-journal']) {
      const source = `${binding.paths.databasePath}${suffix}`;
      if (!await exists(source)) continue;
      await assertNoSymbolicPath(candidate.configurationRootPath, source);
      const stat = await fs.lstat(source);
      if (!stat.isFile()) throw new Error(`Historical SQLite sidecar is not a regular file: ${suffix}`);
      if (suffix === '-journal' && stat.size > 0) {
        throw new Error('Historical SQLite has a rollback journal; finish its existing offline recovery first.');
      }
      if (suffix === '-wal') await fs.copyFile(source, `${snapshotPath}${suffix}`, constants.COPYFILE_FICLONE);
    }
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
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      }
    };
  } catch (error) {
    database?.close();
    await fs.rm(temporaryRoot, { recursive: true, force: true });
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

async function runtimeDataSetTrees(candidate: VscodeRuntimeDataSetCandidate): Promise<string[]> {
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
  // Workspace scopes already include their sibling backup directory in the one complete tree.
  return scope === configuration && hasBackups ? [backups, tree] : [tree];
}

function classifyStoragePath(candidate: VscodeRuntimeDataSetCandidate, filePath: string): RuntimeStorageCategory {
  const scopeRelative = path.relative(candidate.runtimeScopeRootPath, filePath).split(path.sep);
  if (scopeRelative[0] === RUNTIME_SCOPE_BACKUPS_DIRECTORY) return 'historicalBackups';
  const control = path.join(candidate.runtimeScopeRootPath, VSCODE_RUNTIME_CONTROL_DIRECTORY);
  const controlRelative = path.relative(control, filePath).split(path.sep);
  if (controlRelative[0] === 'backups' || controlRelative[0] === 'epoch-migration-backups') return 'historicalBackups';
  const relative = path.relative(candidate.runtimeDataRootPath, filePath).split(path.sep);
  if (relative.length === 1 && ['limcode.sqlite', 'limcode.sqlite-wal', 'limcode.sqlite-shm', 'limcode.sqlite-journal'].includes(relative[0])) return 'sqlite';
  if (relative[0] === 'cas') return relative[1] === 'tmp' ? 'casTemporary' : 'cas';
  if (relative[0] === 'process-spool') return 'processSpool';
  if (relative[0] === 'diagnostics') return 'diagnostics';
  return 'other';
}

async function walkRuntimeDataSetFiles(
  root: string,
  consume: (filePath: string, bytes: bigint) => Promise<void>,
  excludedRoot?: string
): Promise<void> {
  const queue = [root];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (current === excludedRoot) continue;
    const stat = await fs.lstat(current, { bigint: true });
    if (stat.isSymbolicLink()) throw new Error(`Runtime inspection refuses symbolic links: ${current}`);
    if (stat.isFile()) await consume(current, stat.size);
    else if (stat.isDirectory()) {
      for (const name of await fs.readdir(current)) queue.push(path.join(current, name));
    } else throw new Error(`Runtime inspection refuses unsupported filesystem entries: ${current}`);
  }
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
