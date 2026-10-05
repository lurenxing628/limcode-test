import { RUNTIME_MERGE_VALIDATION_REVISION } from './runtimeMergeValidation';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isSamePath } from '../capabilities/filesystem/pathContainment';
import { inProcessSqliteDatabasePaths } from '../capabilities/filesystem/sqliteDatabaseFileGuard';
import { createRuntimeRootPaths, ROOT_BINDING_PENDING_FILE, RUNTIME_KERNEL_EPOCH, type RootBinding } from './contracts';
import { requireCasObjectIdentity, type CasObjectIdentity } from './casObjectAccess';
import { looseCasObjectLocation, verifyCasObjectBytes } from './looseCasObjectAccess';
import type { CasTransferSource } from './runtimeCasTransfer';
import { CUTOVER_JOURNAL_FILE, CUTOVER_REQUEST_FILE } from './physicalCutover';
import { parseHistoricalRootBinding, type HistoricalRootBinding } from './rootAuthority';
import type { RuntimeDataSetSummary } from './runtimeDataSetContent';
import { runtimeDataSetFileState } from './runtimeDataSetFacts';
import { runtimeDataSetReadableName } from './runtimeDataSetPreflight';
import { DATA_ROOT_RELOCATION_MARKER_FILE } from './runtimeDataRootRelocation';
import { RETIRED_EPOCH_3_TO_4_JOURNAL_FILE, RETIRED_EPOCH_TO_5_JOURNAL_FILE, RETIRED_EPOCH_TO_6_JOURNAL_FILE,
  RETIRED_EPOCH_TO_7_JOURNAL_FILE, RETIRED_EPOCH_TO_8_JOURNAL_FILE, RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE } from './runtimeEpochMigration';
import {
  isRuntimeDataRootAdmissionHeld, judgeRuntimeHostLivenessRecords, RuntimeClaimHeldError, runtimeHostLivenessDirectory,
  RuntimeMaintenanceBusyError, withRuntimeClaimAtPath, withRuntimeMaintenance, type RuntimeMaintenanceMetadata
} from './runtimeHostControl';
import {
  locateLocalRuntimeDataSet, sameLocatedRuntimeRoot, type ForeignRuntimeRootLocation, type LocatedRuntimeRoot
} from './runtimeLocatedRoot';
import { findRuntimeIdentityOwner } from './runtimeMergeTombstones';
import { auditRuntimeSnapshot, RuntimeSnapshotAuditError } from './runtimeSnapshotAudit';
import {
  assertNoSymbolicPath, inspectLocatedRuntimeStorage, type RuntimeDataSetStorageInspection
} from './runtimeStorageInspection';
import {
  inspectVscodeRuntimeDataSets, listVscodeRuntimeArchiveDirectories, resolveVscodeRuntimeMergeLedgerRoot,
  VSCODE_RUNTIME_ACTIVE_DIRECTORY, VSCODE_RUNTIME_ARCHIVE_NAME_PATTERN, VSCODE_RUNTIME_ARCHIVES_DIRECTORY,
  VSCODE_RUNTIME_CONTROL_DIRECTORY, VSCODE_WORKSPACE_RUNTIME_SCOPES_DIRECTORY, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY,
  type VscodeRuntimeDataSetCandidate
} from './vscodeRootAuthority';

/**
 * Foreign history: complete Runtime roots this configuration root does not enumerate as data sets,
 * registered in place and read only. Found by listing directories and reading small JSON files:
 * - reset archives `<scope>/.limcode-runtime-backups/<time>[-epoch-<N>-to-<M>]-<id8>` (or the 17 digits
 *   of released 0.0.10–0.0.20, a published older format listed as not verified) of every scope
 *   of the current data directory and of the data directories this installation left (globalStatus
 *   previousDataRoots and lastMigration.fromPath, see ForeignRuntimeHistoryInput), also of scopes
 *   that keep nothing else (the data root is `<archive>/active`);
 * - copied data directories `<data directory name>.limcode-copied-<time>-<id8>` beside the current
 *   one and beside those left, and inside each its default root, its workspace scopes and their
 *   archives.
 *
 * Location comes only from these rules (getPaths plus fixed and strictly matched names); identity
 * only from the root's own records, which must agree exactly. Verification is as strict as for a
 * local candidate, except that "the recorded paths equal the expected paths" becomes "the recorded
 * paths are self-consistent": every read goes to the located paths and a recorded path is never
 * handed to any I/O (the original may still be there, or a newer root occupies it). Nothing is ever
 * created inside a foreign directory: SQLite opens only private copies (worker thread first), the
 * cached results and the claim live under the current configuration root.
 *
 * Every file of a foreign root is read as a small regular file: lstat first, opened with O_NOFOLLOW
 * and O_NONBLOCK, checked again on the descriptor. Never through a link, never a FIFO or a device,
 * and never a file that is the same inode as a file of a database this process may hold SQLite
 * (POSIX fcntl) locks on: closing any descriptor of such a file drops those locks.
 *
 * A foreign root is like a data set the user kept: merged into the current data set only when the
 * user asks for it (runtimeForeignHistoryMerge, which holds this root's claim from preparation to
 * commit and writes its ledger under the current configuration root), never selectable, never
 * finalized or upgraded. Roots that fail are listed with name, location, size and reason and kept as
 * they are; a full disk, a failed copy or a root that keeps changing is "not verifiable now".
 */

export type ForeignRuntimeHistoryStatus = 'verified' | 'failed' | 'unavailable';

export interface DiscoveredForeignRuntimeRoot {
  id: string;
  location: ForeignRuntimeRootLocation;
  /** Archive name, or copied directory name. */
  name: string;
  /** Scope inside the container: 'default' or `workspace:<key>` ('' for the container itself). */
  scope: string;
  /** A root kept in an archive inside a copied directory. */
  archiveName?: string;
  /** The relocation that renamed this copied directory aside (its completion record here). */
  movedAsideBy?: string;
}

export interface ForeignRuntimeHistoryEntry extends DiscoveredForeignRuntimeRoot {
  status: ForeignRuntimeHistoryStatus;
  /** Located data root (where it is); a container-level entry names the container. */
  locatedPath: string;
  code?: string;
  reason?: string;
  /** Where its records say it was ("原位置"): text only, never probed or accessed. */
  recordedDataRootPath?: string;
  dataSetId?: string;
  rootInstanceId?: string;
  runtimeKernelEpoch?: number;
  size?: { bytes: string; fileCount: number };
  summary?: RuntimeDataSetSummary;
  rows?: number;
  contentDigest?: string;
  /** Interrupted work a later merge would first have to finish; reading is unaffected. */
  unfinishedWork?: { finalizable: number; refused: number };
  /**
   * Same data set incarnation as a local data set, or as one a local data set (the current one or
   * another) continues (`continued`, see runtimeMergeTombstones): an old copy of it. `name`: its readable name.
   */
  sameAsLocal?: { candidateId: string; selected: boolean; name?: string; continued?: true };
  /** An exactly identical copy (same identity and content digest) of this other foreign entry. */
  duplicateOf?: string;
}

export interface ForeignRuntimeHistoryReport {
  configurationRootPath: string;
  checkedAt: string;
  entries: ForeignRuntimeHistoryEntry[];
}

export interface ForeignRuntimeHistoryInput {
  /** getPaths().globalStoragePath: the current configuration (data) root. */
  configurationRootPath: string;
  /**
   * The data directories this installation left, most recent first: globalStatus previousDataRoots,
   * and lastMigration.fromPath (all an installation that relocated before that list existed has).
   */
  previousDataRootPaths?: readonly string[];
}

export class ForeignRuntimeHistoryRejection extends Error {
  public constructor(
    public readonly status: Exclude<ForeignRuntimeHistoryStatus, 'verified'>,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ForeignRuntimeHistoryRejection';
  }
}

/** `dev:ino` of the files of databases this process may hold SQLite locks on (empty on Windows). */
export type HeldDatabaseFiles = ReadonlySet<string>;

const ARCHIVE_NAME = new RegExp(`^${VSCODE_RUNTIME_ARCHIVE_NAME_PATTERN}$`);
/** A root renamed aside by backup cleanup before its removal (`<name>.deleting-<16 hex>`, runtimeBackupCleanup). */
const DELETING_LEFTOVER = /^(.+)\.deleting-[0-9a-f]{16}$/;
const COPIED_SUFFIX = String.raw`\.limcode-copied-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}`;
const WORKSPACE_SCOPE_KEY = /^(workspace-file|folder|folder-set|empty)-[a-f0-9]{64}$/;
const SCOPE_PREFIX = String.raw`(?:\.limcode-workspace-runtimes/scopes/(?:workspace-file|folder|folder-set|empty)-[a-f0-9]{64}/)?`;
const ARCHIVE_CONTAINER_NAME = new RegExp(`^${SCOPE_PREFIX}\\.limcode-runtime-backups(?:/${VSCODE_RUNTIME_ARCHIVE_NAME_PATTERN})?$`);
const COPIED_DATA_ROOT = new RegExp(
  `^(?:${SCOPE_PREFIX}(?:\\.limcode-runtime/active|\\.limcode-runtime-backups/${VSCODE_RUNTIME_ARCHIVE_NAME_PATTERN}/active|\\.limcode-runtime-backups))?$`
);
const FOREIGN_ID = /^foreign:(archive|copied):[0-9a-f]{16}$/;
const MAX_SMALL_JSON_BYTES = 4 * 1024 * 1024;
const MAX_HOST_RECORD_BYTES = 64 * 1024;
const COPY_ATTEMPTS = 3;
const CACHE_DIRECTORY = 'foreign';
const CLAIMS_DIRECTORY = 'foreign-claims';
const CACHE_KIND = 'limcode-foreign-runtime-history-audit';
const SIZE_CACHE_KIND = 'limcode-foreign-runtime-history-size';
const RELOCATION_MARKER_KIND = 'limcode-data-root-relocation';
/** The record kind and section of runtimeDataSetMergeLedger, read here file by file as small regular files. */
const MERGE_LEDGER_RECORD_KIND = 'limcode-runtime-data-set-merge';
const MERGE_LEDGER_RECORDS = 'records';
/** A control root with any of these is in the middle of a transition, upgrade or cutover. */
const IN_PROGRESS_FILES: readonly string[] = Object.freeze([
  ROOT_BINDING_PENDING_FILE, RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE,
  RETIRED_EPOCH_3_TO_4_JOURNAL_FILE, RETIRED_EPOCH_TO_5_JOURNAL_FILE, RETIRED_EPOCH_TO_6_JOURNAL_FILE,
  RETIRED_EPOCH_TO_7_JOURNAL_FILE, RETIRED_EPOCH_TO_8_JOURNAL_FILE, CUTOVER_REQUEST_FILE, CUTOVER_JOURNAL_FILE
]);
/** Errors of the moment (space, I/O, permissions, busy): "not verifiable now", never "failed". */
const TRANSIENT_CODES = new Set(['ENOSPC', 'EDQUOT', 'EIO', 'EAGAIN', 'EBUSY', 'ETIMEDOUT', 'EMFILE', 'ENFILE', 'EACCES', 'EPERM', 'ENOMEM']);
/** SQLite result codes of the moment. Every other audit failure (CORRUPT, NOTADB, a schema or binding drift) is the root's own. */
const TRANSIENT_SQLITE_CODE = /^SQLITE_(IOERR|FULL|NOMEM|BUSY|CANTOPEN)(_|$)/;
/** Refusals of a file that is no record LimCode wrote (a merge ledger skips it, as its own reader does). */
const NOT_A_RECORD = new Set(['foreign-history-special-file', 'foreign-history-open-database', 'foreign-history-file-too-large']);
const OPEN_READ_ONLY = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
/**
 * A descriptor that turned out, after a race, to be a file of a database this process holds: kept
 * open for the life of the process, because closing it would drop that database's locks.
 */
const RETAINED_HANDLES: fs.FileHandle[] = [];

/** `foreign:<archive|copied>:` + the first 16 hex of sha256(container name, data root path, dataSetId, rootInstanceId). */
export function foreignRuntimeHistoryId(
  location: Pick<ForeignRuntimeRootLocation, 'kind' | 'containerName' | 'dataRootRelativePath'>,
  identity?: { dataSetId?: string; rootInstanceId?: string }
): string {
  // Windows names are case-insensitive: the same directory always yields the same id.
  const fold = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value;
  const digest = createHash('sha256').update([
    fold(location.containerName), fold(location.dataRootRelativePath), identity?.dataSetId ?? '', identity?.rootInstanceId ?? ''
  ].join('\0')).digest('hex');
  return `foreign:${location.kind}:${digest.slice(0, 16)}`;
}

/** Whether `id` names a foreign history root (see foreignRuntimeHistoryId), never a local data set. */
export function isForeignRuntimeHistoryId(id: string): boolean {
  return FOREIGN_ID.test(id);
}

/**
 * `dev:ino` of every file of every database this process may hold SQLite (POSIX fcntl) locks on: the
 * databases registered in this process (the Runtime worker's) and the database of every scope of the
 * configuration root (a merge or an upgrade opens local data sets directly), each with its -wal, -shm
 * and -journal. The scopes' databases are named from the directory layout alone (no record of theirs
 * is read) and only stat is used: no descriptor of any of them is opened. `except` leaves out the one
 * database a caller copies under that data set's own maintenance claim. Windows has no such locks.
 */
export async function heldDatabaseFiles(configurationRootPath: string, options: { except?: string } = {}): Promise<HeldDatabaseFiles> {
  if (process.platform === 'win32') return new Set();
  const configurationRoot = path.resolve(configurationRootPath);
  const databases = new Set(inProcessSqliteDatabasePaths().map((file) => path.resolve(file)));
  const scopes = [configurationRoot];
  const scopesRoot = path.join(configurationRoot, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, VSCODE_WORKSPACE_RUNTIME_SCOPES_DIRECTORY);
  // Every entry, as local data-set enumeration takes them; stat of a path that is no database finds nothing.
  for (const key of await fs.readdir(scopesRoot).catch(() => [] as string[])) scopes.push(path.join(scopesRoot, key));
  for (const scope of scopes) {
    const database = createRuntimeRootPaths(path.join(scope, VSCODE_RUNTIME_CONTROL_DIRECTORY, VSCODE_RUNTIME_ACTIVE_DIRECTORY)).databasePath;
    if (!options.except || !isSamePath(database, path.resolve(options.except))) databases.add(database);
  }
  const held = new Set<string>();
  for (const database of databases) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const stat = await fs.stat(`${database}${suffix}`, { bigint: true }).catch(() => undefined);
      if (stat) held.add(`${stat.dev}:${stat.ino}`);
    }
  }
  return held;
}

/** Only list directories and read small JSON files: safe at any time, done once in the background at startup. */
export async function discoverForeignRuntimeHistory(input: ForeignRuntimeHistoryInput): Promise<DiscoveredForeignRuntimeRoot[]> {
  const configurationRoot = path.resolve(input.configurationRootPath);
  return discoverWith(configurationRoot, input.previousDataRootPaths, await heldDatabaseFiles(configurationRoot));
}

async function discoverWith(
  configurationRoot: string,
  previousDataRootPaths: readonly string[] | undefined,
  held: HeldDatabaseFiles
): Promise<DiscoveredForeignRuntimeRoot[]> {
  const bases = [configurationRoot, ...previousDataRoots(configurationRoot, previousDataRootPaths)];
  const found: DiscoveredForeignRuntimeRoot[] = [];
  for (const base of bases) {
    // A previous data directory's archives stay there after a relocation (only its data sets move).
    const common = base === configurationRoot ? { kind: 'archive' as const } : { kind: 'archive' as const, side: 'previous' as const, baseDataRootPath: base };
    const prefix = base === configurationRoot ? '' : `${path.basename(base)}/`;
    for (const directory of await listVscodeRuntimeArchiveDirectories(base).catch(() => [])) {
      const name = `${prefix}${path.relative(base, directory.path).split(path.sep).join('/')}`;
      if (directory.unreadable) {
        // A link, a file, or unreadable: listed as the archives directory, whose verification names why.
        found.push(await discovered({ ...common, containerPath: directory.path, containerName: name, dataRootRelativePath: '' },
          VSCODE_RUNTIME_ARCHIVES_DIRECTORY, directory.scope, held));
        continue;
      }
      for (const archive of directory.names) {
        found.push(await discovered({
          ...common, containerPath: path.join(directory.path, archive), containerName: `${name}/${archive}`, dataRootRelativePath: VSCODE_RUNTIME_ACTIVE_DIRECTORY
        }, archive, directory.scope, held));
      }
    }
  }
  const movedAside = await copiedAsideByRelocation(configurationRoot, held);
  for (const base of bases) {
    const side = base === configurationRoot ? 'current' as const : 'previous' as const;
    const pattern = copiedNamePattern(base);
    let names: string[];
    // Only names are read here; a parent that cannot be listed hides nothing it could show.
    try { names = await fs.readdir(path.dirname(base)); }
    catch { continue; }
    for (const name of names.filter((entry) => pattern.test(entry)).sort()) {
      const container = { kind: 'copied' as const, side, baseDataRootPath: base, containerPath: path.join(path.dirname(base), name), containerName: name };
      const relocationId = side === 'current' ? movedAside.get(name) : undefined;
      found.push(...(await copiedRoots(container, held)).map((entry) => relocationId ? { ...entry, movedAsideBy: relocationId } : entry));
    }
  }
  return found;
}

/**
 * Control roots of foreign history renamed aside in place (a cleanup of foreign history interrupted
 * between its rename and its removal), each with the location discovery gives that root once it is
 * back under its name: in the archives directories of the current and the previous data directories
 * (an archive), and in every copied directory beside any of them, in its default root, its workspace
 * scopes and their archives directories (`.limcode-runtime` or an archive). `renamed` matches such an
 * entry's name and captures the original name in group 1; only names discovery takes count. Lists
 * directories only, never through a link.
 */
export async function listRenamedForeignRuntimeRoots(
  input: ForeignRuntimeHistoryInput,
  renamed: RegExp
): Promise<Array<{ path: string; originalPath: string; location: ForeignRuntimeRootLocation }>> {
  const configurationRoot = path.resolve(input.configurationRootPath);
  const bases = [configurationRoot, ...previousDataRoots(configurationRoot, input.previousDataRootPaths)];
  const found: Array<{ path: string; originalPath: string; location: ForeignRuntimeRootLocation }> = [];
  const originalOf = (entry: string): string | undefined => renamed.exec(entry)?.[1];
  for (const base of bases) {
    const common = base === configurationRoot ? { kind: 'archive' as const } : { kind: 'archive' as const, side: 'previous' as const, baseDataRootPath: base };
    const prefix = base === configurationRoot ? '' : `${path.basename(base)}/`;
    for (const directory of await listVscodeRuntimeArchiveDirectories(base).catch(() => [])) {
      if (directory.unreadable) continue;
      const name = `${prefix}${path.relative(base, directory.path).split(path.sep).join('/')}`;
      for (const entry of (await fs.readdir(directory.path).catch(() => [] as string[])).sort()) {
        const original = originalOf(entry);
        if (!original || !ARCHIVE_NAME.test(original)) continue;
        const containerPath = path.join(directory.path, original);
        found.push({
          path: path.join(directory.path, entry), originalPath: containerPath,
          location: Object.freeze({ ...common, containerPath, containerName: `${name}/${original}`, dataRootRelativePath: VSCODE_RUNTIME_ACTIVE_DIRECTORY })
        });
      }
    }
  }
  for (const base of bases) {
    const side = base === configurationRoot ? 'current' as const : 'previous' as const;
    const pattern = copiedNamePattern(base);
    let names: string[];
    try { names = await fs.readdir(path.dirname(base)); }
    catch { continue; }
    for (const containerName of names.filter((entry) => pattern.test(entry)).sort()) {
      const containerPath = path.join(path.dirname(base), containerName);
      if (!(await fs.lstat(containerPath).catch(() => undefined))?.isDirectory()) continue;
      const container = { kind: 'copied' as const, side, baseDataRootPath: base, containerPath, containerName };
      const namesIn = async (directory: string): Promise<string[]> => {
        if (directory === containerPath) return fs.readdir(containerPath).catch(() => [] as string[]);
        const listed = await listContainerDirectory(containerPath, directory).catch(() => 'invalid' as const);
        return listed === 'invalid' ? [] : listed;
      };
      let scopes: Array<{ label: string; relative: string[] }>;
      try { scopes = await containerScopes(containerPath); }
      catch { continue; }
      for (const scope of scopes) {
        const scopeDirectory = path.join(containerPath, ...scope.relative);
        for (const entry of (await namesIn(scopeDirectory)).sort()) {
          if (originalOf(entry) !== VSCODE_RUNTIME_CONTROL_DIRECTORY) continue;
          found.push({
            path: path.join(scopeDirectory, entry), originalPath: path.join(scopeDirectory, VSCODE_RUNTIME_CONTROL_DIRECTORY),
            location: Object.freeze({
              ...container, dataRootRelativePath: [...scope.relative, VSCODE_RUNTIME_CONTROL_DIRECTORY, VSCODE_RUNTIME_ACTIVE_DIRECTORY].join('/')
            })
          });
        }
        const archives = path.join(scopeDirectory, VSCODE_RUNTIME_ARCHIVES_DIRECTORY);
        for (const entry of (await namesIn(archives)).sort()) {
          const original = originalOf(entry);
          if (!original || !ARCHIVE_NAME.test(original)) continue;
          found.push({
            path: path.join(archives, entry), originalPath: path.join(archives, original),
            location: Object.freeze({
              ...container, dataRootRelativePath: [...scope.relative, VSCODE_RUNTIME_ARCHIVES_DIRECTORY, original, VSCODE_RUNTIME_ACTIVE_DIRECTORY].join('/')
            })
          });
        }
      }
    }
  }
  return found;
}

/** The previous data directories to look in: absolute, not the current one, each once, in order. */
function previousDataRoots(configurationRoot: string, previous: readonly string[] | undefined): string[] {
  const roots: string[] = [];
  for (const entry of previous ?? []) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const resolved = path.resolve(entry);
    if (isSamePath(resolved, configurationRoot) || roots.some((root) => isSamePath(root, resolved))) continue;
    roots.push(resolved);
  }
  return roots;
}

/**
 * The previous data directories that provably hold nothing foreign history would list: the directory
 * is there and readable, no reset archive in any scope (any name VSCODE_RUNTIME_ARCHIVE_NAME_PATTERN
 * knows) and no `.deleting-` leftover of an interrupted backup cleanup there (it is settled only while
 * its directory is remembered, see listRenamedForeignRuntimeRoots), and no copied directory beside it.
 * A directory that is gone is kept (it may sit on a drive not mounted now, its mount point still
 * listable); so is anything that cannot be read: its archives must not disappear from the list for good.
 */
export async function previousDataRootsWithoutForeignHistory(input: ForeignRuntimeHistoryInput): Promise<string[]> {
  const configurationRoot = path.resolve(input.configurationRootPath);
  const empty: string[] = [];
  for (const base of previousDataRoots(configurationRoot, input.previousDataRootPaths)) {
    try {
      const siblings = await fs.readdir(path.dirname(base));
      if (siblings.some((name) => copiedNamePattern(base).test(name))) continue;
      const info = await fs.lstat(base);
      if (!info.isDirectory()) continue;
      await fs.readdir(base);
      const scopes = path.join(base, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, VSCODE_WORKSPACE_RUNTIME_SCOPES_DIRECTORY);
      // Scopes that cannot be listed may hide archives.
      await fs.readdir(scopes).catch((error: unknown) => { if (!isMissing(error)) throw error; });
      const archives = await listVscodeRuntimeArchiveDirectories(base);
      if (archives.some((directory) => directory.unreadable || directory.names.length > 0)) continue;
      let leftover = false;
      for (const directory of archives) {
        leftover ||= (await fs.readdir(directory.path)).some((name) => ARCHIVE_NAME.test(DELETING_LEFTOVER.exec(name)?.[1] ?? ''));
      }
      if (leftover) continue;
      empty.push(base);
    } catch {
      // Gone, or not readable now: kept.
    }
  }
  return empty;
}

/** Every root inside one copied data directory (or the directory itself when none is recognizable). */
async function copiedRoots(
  container: Omit<ForeignRuntimeRootLocation, 'dataRootRelativePath'>,
  held: HeldDatabaseFiles
): Promise<DiscoveredForeignRuntimeRoot[]> {
  const whole = (): Promise<DiscoveredForeignRuntimeRoot> => discovered({ ...container, dataRootRelativePath: '' }, container.containerName, '', held);
  let info;
  try { info = await fs.lstat(container.containerPath); }
  catch (error) { if (isMissing(error)) return []; throw error; }
  if (info.isSymbolicLink() || !info.isDirectory()) return [await whole()];
  const roots: DiscoveredForeignRuntimeRoot[] = [];
  try {
    for (const scope of await containerScopes(container.containerPath)) {
      const control = path.join(container.containerPath, ...scope.relative, VSCODE_RUNTIME_CONTROL_DIRECTORY);
      const controlEntries = await listContainerDirectory(container.containerPath, control);
      if (controlEntries === 'invalid' || await hasRuntimeEntries(control, controlEntries)) {
        roots.push(await discovered({
          ...container, dataRootRelativePath: [...scope.relative, VSCODE_RUNTIME_CONTROL_DIRECTORY, VSCODE_RUNTIME_ACTIVE_DIRECTORY].join('/')
        }, container.containerName, scope.label, held));
      }
      const archives = path.join(container.containerPath, ...scope.relative, VSCODE_RUNTIME_ARCHIVES_DIRECTORY);
      const listed = await listContainerDirectory(container.containerPath, archives);
      if (listed === 'invalid') {
        roots.push(await discovered({ ...container, dataRootRelativePath: [...scope.relative, VSCODE_RUNTIME_ARCHIVES_DIRECTORY].join('/') },
          container.containerName, scope.label, held));
        continue;
      }
      for (const name of listed.filter((entry) => ARCHIVE_NAME.test(entry)).sort()) {
        roots.push({
          ...await discovered({
            ...container, dataRootRelativePath: [...scope.relative, VSCODE_RUNTIME_ARCHIVES_DIRECTORY, name, VSCODE_RUNTIME_ACTIVE_DIRECTORY].join('/')
          }, container.containerName, scope.label, held),
          archiveName: name
        });
      }
    }
  } catch {
    // Unreadable inside: listed as the directory itself, whose verification names the reason.
    return [await whole()];
  }
  return roots.length > 0 ? roots : [await whole()];
}

async function discovered(
  location: ForeignRuntimeRootLocation,
  name: string,
  scope: string,
  held: HeldDatabaseFiles
): Promise<DiscoveredForeignRuntimeRoot> {
  const frozen = Object.freeze({ ...location });
  return { id: foreignRuntimeHistoryId(frozen, await readPointerIdentity(frozen, held)), location: frozen, name, scope };
}

/** Identity for the id only (read as a small regular file); verification parses the pointer strictly again. */
async function readPointerIdentity(
  location: ForeignRuntimeRootLocation,
  held: HeldDatabaseFiles
): Promise<{ dataSetId: string; rootInstanceId: string } | undefined> {
  if (!hasDataRoot(location)) return undefined;
  const pointer = locatedPaths(location).rootPointerPath;
  try {
    await assertNoSymbolicPath(location.containerPath, pointer);
    const value = JSON.parse(await readForeignFile(pointer, held)) as { dataSetId?: unknown; rootInstanceId?: unknown } | null;
    return typeof value?.dataSetId === 'string' && typeof value.rootInstanceId === 'string'
      ? { dataSetId: value.dataSetId, rootInstanceId: value.rootInstanceId } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The identity a discovered root's pointer names (read as a small regular file, not verified): what
 * discovery took for its id. Undefined when there is no readable pointer.
 */
export async function readForeignRuntimePointerIdentity(
  location: ForeignRuntimeRootLocation,
  held: HeldDatabaseFiles
): Promise<{ dataSetId: string; rootInstanceId: string } | undefined> {
  return readPointerIdentity(location, held);
}

/**
 * The exact checks of one foreign root (all but the private-snapshot audit), read only from its
 * located paths: no symbolic link from the container down; a strictly valid pointer, no pending
 * pointer, rollback journal, transition, upgrade, relocation or merge in progress; recorded paths
 * self-consistent and ending in `.limcode-runtime/active`; an exact current-epoch manifest; every
 * Host proven gone; none of its database files a file of a database this process holds. Throws
 * ForeignRuntimeHistoryRejection.
 */
export async function locateForeignRuntimeRoot(
  configurationRootPath: string,
  location: ForeignRuntimeRootLocation,
  heldFiles?: HeldDatabaseFiles
): Promise<LocatedRuntimeRoot> {
  const configurationRoot = path.resolve(configurationRootPath);
  requireStrictLocation(configurationRoot, location);
  const held = heldFiles ?? await heldDatabaseFiles(configurationRoot);
  const container = location.containerPath;
  let containerInfo;
  try {
    if (location.kind === 'archive') await assertNoSymbolicPath(archiveBase(configurationRoot, location), container);
    containerInfo = await fs.lstat(container);
  } catch (error) {
    throw fileProblem(error, 'foreign-history-link', '所在位置有符号链接，不跟随链接读取。');
  }
  if (containerInfo.isSymbolicLink() || !containerInfo.isDirectory()) {
    throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-link', '所在位置是符号链接或不是目录，不跟随链接读取。');
  }
  if (!hasDataRoot(location)) await rejectContainerWithoutRoot(location);
  const located = locatedPaths(location);
  const control = path.dirname(located.rootPointerPath);
  const liveness = runtimeHostLivenessDirectory(located);
  for (const target of [control, located.rootPointerPath, located.dataRootPath, located.databasePath, located.casRootPath, located.runtimeEpochPath, liveness]) {
    try { await assertNoSymbolicPath(container, target); }
    catch (error) {
      if (isMissing(error)) continue;
      throw fileProblem(error, 'foreign-history-link', '历史库的目录或文件是符号链接，不跟随链接读取。');
    }
  }
  for (const [target, kind] of [[located.rootPointerPath, 'file'], [located.databasePath, 'file'], [located.casRootPath, 'directory'], [located.runtimeEpochPath, 'file']] as const) {
    let info;
    try { info = await fs.lstat(target); }
    catch (error) { throw await readProblem(error, container, 'foreign-history-incomplete', '历史库的文件无法读取。'); }
    if (kind === 'file' ? !info.isFile() : !info.isDirectory()) {
      throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-incomplete', `历史库不完整：${path.basename(target)} 不是${kind === 'file' ? '普通文件' : '目录'}。`);
    }
  }
  await assertNotHeldDatabase(located.databasePath, held);
  let pointer: unknown;
  try { pointer = JSON.parse(await readForeignFile(located.rootPointerPath, held)); }
  catch (error) {
    if (error instanceof SyntaxError) throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-pointer-invalid', 'RootBinding 指针不是有效的 JSON。');
    throw await readProblem(error, container, 'foreign-history-pointer-invalid', 'RootBinding 指针无法读取。');
  }
  const pointerEpoch = (pointer as { runtimeKernelEpoch?: unknown } | null)?.runtimeKernelEpoch;
  if (typeof pointerEpoch === 'number' && pointerEpoch > RUNTIME_KERNEL_EPOCH) {
    throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-epoch-newer',
      `它由更新版本的 LimCode 写入（第 ${pointerEpoch} 代格式），当前版本不能读取；更新扩展后可以再看。它原样保留，不会被删除。`);
  }
  let recorded: HistoricalRootBinding;
  try { recorded = parseHistoricalRootBinding(pointer); }
  catch (error) {
    throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-pointer-invalid',
      `RootBinding 指针无法严格解析：${error instanceof Error ? error.message : String(error)}`);
  }
  for (const name of IN_PROGRESS_FILES) {
    if (await present(path.join(control, name))) {
      throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-unfinished-operation',
        `有未完成的根切换、升级或迁移（${name}），只有写下它的那个 LimCode 能收尾；原样保留。`);
    }
  }
  const journal = await lstatIfPresent(`${located.databasePath}-journal`);
  if (journal && (!journal.isFile() || journal.size > 0)) {
    throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-rollback-journal', 'SQLite 有未完成的回滚日志（-journal），原样保留。');
  }
  const expectedRecorded = createRuntimeRootPaths(recorded.paths.dataRootPath);
  const tail = recorded.paths.dataRootPath.split(path.sep).slice(-2).join('/');
  if (JSON.stringify(recorded.paths) !== JSON.stringify(expectedRecorded) || tail !== `${VSCODE_RUNTIME_CONTROL_DIRECTORY}/${VSCODE_RUNTIME_ACTIVE_DIRECTORY}`) {
    throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-recorded-paths', 'RootBinding 记录的路径彼此不一致，不是 LimCode 写下的完整历史库。');
  }
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(await readForeignFile(located.runtimeEpochPath, held)) as Record<string, unknown>; }
  catch (error) {
    if (error instanceof SyntaxError) throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-epoch-manifest', 'epoch 清单不是有效的 JSON。');
    throw await readProblem(error, container, 'foreign-history-epoch-manifest', 'epoch 清单无法读取。');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || Object.keys(manifest).sort().join(',') !== 'dataSetId,initializedAt,kind,rootGeneration,rootInstanceId,runtimeKernelEpoch'
    || manifest.kind !== 'limcode-runtime-kernel-epoch' || typeof manifest.initializedAt !== 'string' || manifest.initializedAt.length === 0
    || manifest.runtimeKernelEpoch !== recorded.runtimeKernelEpoch || manifest.dataSetId !== recorded.dataSetId
    || manifest.rootInstanceId !== recorded.rootInstanceId || manifest.rootGeneration !== recorded.rootGeneration) {
    throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-epoch-manifest', 'epoch 清单与 RootBinding 不一致。');
  }
  if (recorded.runtimeKernelEpoch !== RUNTIME_KERNEL_EPOCH) {
    throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-epoch-not-current', oldFormatReason(location, recorded.runtimeKernelEpoch));
  }
  await assertNoUnfinishedRelocationOrMerge(configurationRoot, location, recorded, held);
  await assertForeignHostsGone(liveness, container, held);
  return Object.freeze({
    id: foreignRuntimeHistoryId(location, recorded),
    origin: Object.freeze({ kind: 'foreign' as const, location: Object.freeze({ ...location }) }),
    containerRoot: container,
    located: Object.freeze(located),
    recorded
  });
}

/** Located again from where it was found (local candidate id, or foreign location): never from its records. */
export async function relocateRuntimeRoot(
  paths: { globalStoragePath: string },
  root: LocatedRuntimeRoot,
  held?: HeldDatabaseFiles
): Promise<LocatedRuntimeRoot> {
  return root.origin.kind === 'local'
    ? locateLocalRuntimeDataSet(paths, root.origin.candidateId)
    : locateForeignRuntimeRoot(paths.globalStoragePath, root.origin.location, held);
}

/**
 * Mutual exclusion for reading a located root: a local data set's own maintenance claim; for a
 * foreign root a claim under the current configuration root, never inside the foreign directory.
 */
export async function withLocatedRuntimeRootFence<T>(
  paths: { globalStoragePath: string },
  root: LocatedRuntimeRoot,
  operation: () => Promise<T>
): Promise<T> {
  if (root.origin.kind === 'local') return withRuntimeMaintenance(root.located, operation);
  return withRuntimeClaimAtPath(await foreignRuntimeHistoryFile(paths.globalStoragePath, CLAIMS_DIRECTORY, root.id, ''),
    root.located.rootPointerPath, operation);
}

/**
 * The foreign root's claim ({@link withLocatedRuntimeRootFence}) by id, without waiting: a live
 * holder (a read-only view opening it, its verification, a merge; in another window or in another
 * async scope of this one) or one whose state is unknown means `acquired: false`, and the operation
 * does not run. Joins a claim this scope already holds.
 */
export async function tryWithForeignRuntimeRootClaim<T>(
  configurationRootPath: string,
  id: string,
  rootPointerPath: string,
  operation: () => Promise<T>
): Promise<{ acquired: true; value: T } | { acquired: false; holder: RuntimeMaintenanceMetadata }> {
  const claimPath = await foreignRuntimeHistoryFile(configurationRootPath, CLAIMS_DIRECTORY, id, '');
  let started = false;
  try {
    const value = await withRuntimeClaimAtPath(claimPath, rootPointerPath, () => {
      started = true;
      return operation();
    }, { refuseWhenHeld: true });
    return { acquired: true, value };
  } catch (error) {
    if (!started && (error instanceof RuntimeClaimHeldError || error instanceof RuntimeMaintenanceBusyError)) {
      return { acquired: false, holder: error.owner };
    }
    throw error;
  }
}

/**
 * The private copy of a located root's database and WAL, taken under its fence (see
 * {@link copyForeignRuntimeSqliteFiles}). Shared by verification and by the read-only view.
 */
export async function copyLocatedRuntimeDatabase(
  root: LocatedRuntimeRoot,
  held: HeldDatabaseFiles
): Promise<{ databasePath: string; files: string; remove(): Promise<void> }> {
  return copyForeignRuntimeSqliteFiles(root.containerRoot, root.located.databasePath, held);
}

/**
 * The private copy of one SQLite database below a foreign container (a root's own, or a backup its
 * control root keeps), reached without links from `containerRoot`: it counts only when the database
 * and its WAL kept their exact state while it was taken (at most 3 attempts; a WAL removed between
 * the two copies changes the state), and none of its files (main, -wal, -shm, -journal) may be a
 * file of a database this process holds (checked again right before each copy). `files` is that
 * state (runtimeDataSetFileState). Throws ForeignRuntimeHistoryRejection; a copy that fails is "not
 * verifiable now".
 */
export async function copyForeignRuntimeSqliteFiles(
  containerRoot: string,
  databasePath: string,
  held: HeldDatabaseFiles
): Promise<{ databasePath: string; files: string; remove(): Promise<void> }> {
  for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt += 1) {
    await assertNotHeldDatabase(databasePath, held);
    let before: string;
    let copy: { databasePath: string; remove(): Promise<void> };
    try {
      before = await runtimeDataSetFileState(databasePath);
      copy = await copyForeignSqliteByDescriptor(containerRoot, databasePath, held);
    } catch (error) {
      // A file that turned out to be a link, a FIFO or a device, or one of a database this process holds.
      if (error instanceof ForeignRuntimeHistoryRejection) throw error;
      if (isMissing(error) && !await present(containerRoot).catch(() => true)) throw gone();
      throw new ForeignRuntimeHistoryRejection('unavailable', 'foreign-history-copy-failed',
        `复制数据库到私有临时目录失败（${error instanceof Error ? error.message : String(error)}），稍后再试。`);
    }
    let kept = false;
    try {
      if (await runtimeDataSetFileState(databasePath).catch(() => undefined) !== before) continue;
      kept = true;
      return { databasePath: copy.databasePath, files: before, remove: () => copy.remove() };
    } finally {
      if (!kept) await copy.remove();
    }
  }
  throw new ForeignRuntimeHistoryRejection('unavailable', 'foreign-history-changing', '数据库文件在复制期间一直在变化，稍后再试。');
}

/**
 * The database and its WAL (never -shm; a non-empty -journal refuses) copied into a fresh private
 * temporary directory from descriptors opened as openLocatedRuntimeFile opens them: nothing is opened
 * through a link or as a FIFO, and a file that turns out to be one of a database this process holds is
 * kept open, never closed (its POSIX locks stay). Named with this process id, like every private copy.
 */
async function copyForeignSqliteByDescriptor(
  containerRoot: string,
  databasePath: string,
  held: HeldDatabaseFiles
): Promise<{ databasePath: string; remove(): Promise<void> }> {
  await assertNoSymbolicPath(containerRoot, databasePath);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-runtime-history-${process.pid}-`));
  const remove = () => fs.rm(temporaryRoot, { recursive: true, force: true });
  try {
    const copied = path.join(temporaryRoot, 'limcode.sqlite');
    await copyFromDescriptor(await openLocatedRuntimeFile(databasePath, held), copied);
    const journal = await lstatIfPresent(`${databasePath}-journal`);
    if (journal && (!journal.isFile() || journal.size > 0)) {
      throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-rollback-journal', 'SQLite 有未完成的回滚日志（-journal），原样保留。');
    }
    const wal = `${databasePath}-wal`;
    if (await lstatIfPresent(wal)) {
      await assertNoSymbolicPath(containerRoot, wal);
      await copyFromDescriptor(await openLocatedRuntimeFile(wal, held), `${copied}-wal`);
    }
    return { databasePath: copied, remove };
  } catch (error) {
    await remove();
    throw error;
  }
}

/** Copies what an open descriptor reads into a new private file (made durable), then closes the descriptor. */
async function copyFromDescriptor(source: fs.FileHandle, target: string): Promise<void> {
  try {
    const out = await fs.open(target, 'wx', 0o600);
    try {
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      for (let position = 0; ;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        await out.write(buffer, 0, bytesRead);
        position += bytesRead;
      }
      await out.sync();
    } finally {
      await out.close();
    }
  } finally {
    await source.close();
  }
}

/**
 * A regular file of a located root, up to `maxBytes`: lstat first (a link, a FIFO, a device or a file
 * of a database this process holds is refused before any descriptor exists), opened with O_NOFOLLOW
 * and O_NONBLOCK, and read only while the descriptor is that same regular file within the limit.
 */
export async function readLocatedRuntimeFile(file: string, held: HeldDatabaseFiles, maxBytes: number): Promise<Buffer> {
  const handle = await openLocatedRuntimeFile(file, held, maxBytes);
  try { return await handle.readFile(); }
  finally { await handle.close(); }
}

/**
 * Logical history bytes under the located reader policy: no symbolic components and no descriptor
 * of a database held by this process. The history owner supplies its freshly checked held set.
 */
export async function readLocatedCasObject(
  root: LocatedRuntimeRoot,
  object: CasObjectIdentity,
  held: HeldDatabaseFiles
): Promise<Buffer> {
  const identity = requireCasObjectIdentity(object);
  if (identity.byte_length > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Historical CAS object is too large to read.');
  const location = looseCasObjectLocation(root.located.casRootPath, identity);
  await assertNoSymbolicPath(root.containerRoot, location.absolutePath);
  return verifyCasObjectBytes(identity, await readLocatedRuntimeFile(location.absolutePath, held, Number(identity.byte_length)));
}

/**
 * A claim-scoped, copy-only logical source. Physical path resolution and strict foreign-file safety
 * are confined here; the transfer engine receives identities and sequential bytes, never filenames.
 */
export function locatedCasTransferSource(
  root: LocatedRuntimeRoot,
  heldFiles: () => Promise<HeldDatabaseFiles>
): CasTransferSource {
  // Validated loose identities have only 256 prefix directories; preserve the per-transfer checks.
  const checked = new Set<string>();
  let held: Promise<HeldDatabaseFiles> | undefined;
  const reachable = async (object: CasObjectIdentity): Promise<string> => {
    const { absolutePath } = looseCasObjectLocation(root.located.casRootPath, object);
    const directory = path.dirname(absolutePath);
    if (!checked.has(directory)) {
      await assertNoSymbolicPath(root.containerRoot, directory);
      checked.add(directory);
    }
    return absolutePath;
  };
  return {
    size: async (object) => {
      try {
        const file = await reachable(object);
        const info = await fs.lstat(file, { bigint: true });
        return info.isFile() ? info.size : undefined;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR' || (error instanceof Error && /symbolic link/.test(error.message))) return undefined;
        throw error;
      }
    },
    open: async (object) => openLocatedRuntimeFile(await reachable(object), await (held ??= heldFiles()))
  };
}

/**
 * Whether the descriptor opened the file `lstat` found. Windows pathname stat may omit the volume
 * serial or report 64 bits where fstat reports 32; known mismatches must still refuse the read.
 */
export function sameOpenedFile(found: BigIntStats, opened: BigIntStats, platform: NodeJS.Platform = process.platform): boolean {
  const sameDevice = found.dev === opened.dev || (platform === 'win32'
    && opened.dev > 0n && opened.dev <= 0xffff_ffffn
    && (found.dev === 0n || (found.dev > 0xffff_ffffn && BigInt.asUintN(32, found.dev) === opened.dev)));
  return opened.ino === found.ino && sameDevice;
}

/**
 * The descriptor of a regular file of a located root, opened exactly as readLocatedRuntimeFile opens
 * it (lstat first, O_NOFOLLOW and O_NONBLOCK, the descriptor checked to be that same regular file,
 * never a file of a database this process holds). The caller reads it and closes it. `maxBytes` bounds
 * a record; a content object passes none.
 */
export async function openLocatedRuntimeFile(file: string, held: HeldDatabaseFiles, maxBytes?: number): Promise<fs.FileHandle> {
  const info = await fs.lstat(file, { bigint: true });
  if (!info.isFile()) {
    throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-special-file',
      `${path.basename(file)} 不是普通文件（符号链接、管道或设备），不跟随链接、也不打开它。`);
  }
  if (held.has(`${info.dev}:${info.ino}`)) throw openDatabase(file);
  if (maxBytes !== undefined && info.size > BigInt(maxBytes)) {
    throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-file-too-large', `${path.basename(file)} 超过 ${maxBytes} 字节，不是 LimCode 写下的记录。`);
  }
  const handle = await fs.open(file, OPEN_READ_ONLY);
  let kept = false;
  try {
    const opened = await handle.stat({ bigint: true });
    if (held.has(`${opened.dev}:${opened.ino}`)) {
      RETAINED_HANDLES.push(handle);
      kept = true;
      throw openDatabase(file);
    }
    if (!opened.isFile() || !sameOpenedFile(info, opened) || (maxBytes !== undefined && opened.size > BigInt(maxBytes))) {
      throw new ForeignRuntimeHistoryRejection('unavailable', 'foreign-history-changed', `${path.basename(file)} 在读取时被替换了，稍后再试。`);
    }
    kept = true;
    return handle;
  } finally {
    if (!kept) await handle.close();
  }
}

/** Every foreign root, verified (cached per exact file state, never authoritative) and related to the local data sets. */
export async function inspectForeignRuntimeHistory(
  input: ForeignRuntimeHistoryInput & { onProgress?(done: number, total: number): void }
): Promise<ForeignRuntimeHistoryReport> {
  const configurationRoot = path.resolve(input.configurationRootPath);
  const held = await heldDatabaseFiles(configurationRoot);
  const found = await discoverWith(configurationRoot, input.previousDataRootPaths, held);
  const { candidates } = await inspectVscodeRuntimeDataSets({ globalStoragePath: configurationRoot });
  const entries: ForeignRuntimeHistoryEntry[] = [];
  for (const entry of found) {
    // A root whose claim is held (a merge from preparation to commit, a read-only view opening it) is
    // not waited for: its cached result when there is one, else "being used, verified later".
    entries.push((await inspectOne(configurationRoot, entry, held, false)).entry);
    input.onProgress?.(entries.length, found.length);
  }
  await relate(configurationRoot, entries, candidates);
  return { configurationRootPath: configurationRoot, checkedAt: new Date().toISOString(), entries };
}

/** Storage of a verified foreign root: its located tree, walked once; its identity must hold throughout. */
export async function inspectForeignRuntimeStorage(
  paths: { globalStoragePath: string },
  root: LocatedRuntimeRoot
): Promise<RuntimeDataSetStorageInspection> {
  const held = await heldDatabaseFiles(paths.globalStoragePath);
  const report = await inspectLocatedRuntimeStorage(await relocateRuntimeRoot(paths, root, held));
  if (!sameLocatedRuntimeRoot(await relocateRuntimeRoot(paths, root, held), root)) {
    throw new Error('这个外来历史库在统计期间发生了变化，请重试。');
  }
  return report;
}

/**
 * One discovered root verified exactly as {@link inspectForeignRuntimeHistory} verifies it (not
 * related to the local data sets), with its located root when it was located at all: for a caller
 * that acts on a verified root under its claim (the audit joins a claim this scope holds).
 */
export async function inspectForeignRuntimeRoot(
  configurationRootPath: string,
  found: DiscoveredForeignRuntimeRoot,
  heldFiles?: HeldDatabaseFiles
): Promise<{ entry: ForeignRuntimeHistoryEntry; root?: LocatedRuntimeRoot }> {
  const configurationRoot = path.resolve(configurationRootPath);
  return inspectOne(configurationRoot, found, heldFiles ?? await heldDatabaseFiles(configurationRoot));
}

async function inspectOne(
  configurationRoot: string,
  found: DiscoveredForeignRuntimeRoot,
  held: HeldDatabaseFiles,
  waitForClaim = true
): Promise<{ entry: ForeignRuntimeHistoryEntry; root?: LocatedRuntimeRoot }> {
  const locatedPath = hasDataRoot(found.location) ? locatedPaths(found.location).dataRootPath : found.location.containerPath;
  const base: ForeignRuntimeHistoryEntry = { ...found, status: 'unavailable', locatedPath };
  // A failed root does not change by itself: its size is walked once per exact state and kept.
  const sized = async (outcome: Pick<ForeignRuntimeHistoryEntry, 'status' | 'code' | 'reason'>, id: string) => ({
    ...outcome,
    size: outcome.status === 'failed' ? await cachedTreeSize(configurationRoot, id, found.location) : await measureTree(measuredPath(found.location))
  });
  let root: LocatedRuntimeRoot;
  try {
    root = await locateForeignRuntimeRoot(configurationRoot, found.location, held);
  } catch (error) {
    return { entry: { ...base, ...await sized(rejected(error), found.id) } };
  }
  const identity = {
    id: root.id, recordedDataRootPath: root.recorded.paths.dataRootPath, dataSetId: root.recorded.dataSetId,
    rootInstanceId: root.recorded.rootInstanceId, runtimeKernelEpoch: root.recorded.runtimeKernelEpoch
  };
  try {
    const result = await auditForeignRuntimeRoot(configurationRoot, root, held, waitForClaim);
    if (result.outcome === 'failed') {
      return { entry: { ...base, ...identity, status: 'failed', code: result.code, reason: result.reason, size: result.size }, root };
    }
    return { entry: { ...base, ...identity, status: 'verified', ...result.audit, size: result.size }, root };
  } catch (error) {
    return { entry: { ...base, ...identity, ...await sized(rejected(error), root.id) }, root };
  }
}

interface ForeignAudit {
  summary?: RuntimeDataSetSummary;
  rows?: number;
  contentDigest?: string;
  unfinishedWork?: { finalizable: number; refused: number };
}

type AuditResult =
  | { outcome: 'verified'; audit: ForeignAudit; size?: { bytes: string; fileCount: number } }
  | { outcome: 'failed'; code: string; reason: string; size?: { bytes: string; fileCount: number } };

/**
 * The private-snapshot audit (worker), kept per exact file state: a result cached for the root's exact
 * files is returned without its claim; anything else is read under the claim, waited for or, without
 * `waitForClaim`, refused while another holds it ("being used, verified later").
 */
async function auditForeignRuntimeRoot(
  configurationRoot: string,
  root: LocatedRuntimeRoot,
  held: HeldDatabaseFiles,
  waitForClaim: boolean
): Promise<AuditResult> {
  const early = await foreignFileState(root).then((files) => readAuditCache(configurationRoot, root.id, files), () => undefined);
  if (early) return early;
  if (!waitForClaim) {
    if (root.origin.kind !== 'foreign') throw new TypeError('Not a foreign root.');
    const claimed = await tryWithForeignRuntimeRootClaim(configurationRoot, root.id, root.located.rootPointerPath,
      () => auditUnderClaim(configurationRoot, root, held));
    if (!claimed.acquired) {
      throw new ForeignRuntimeHistoryRejection('unavailable', 'foreign-history-busy', '它正在被合并或查看（占用它的是另一个窗口或操作），稍后再核验。');
    }
    return claimed.value;
  }
  return withLocatedRuntimeRootFence({ globalStoragePath: configurationRoot }, root, () => auditUnderClaim(configurationRoot, root, held));
}

/** Under the foreign claim: located again, then the cached result or the audit of a private copy. */
async function auditUnderClaim(configurationRoot: string, root: LocatedRuntimeRoot, held: HeldDatabaseFiles): Promise<AuditResult> {
  if (root.origin.kind !== 'foreign') throw new TypeError('Not a foreign root.');
  const current = await locateForeignRuntimeRoot(configurationRoot, root.origin.location, held);
  if (!sameLocatedRuntimeRoot(current, root)) {
    throw new ForeignRuntimeHistoryRejection('unavailable', 'foreign-history-changed', '核验期间它发生了变化，稍后再试。');
  }
  const files = await foreignFileState(current);
  const cached = await readAuditCache(configurationRoot, current.id, files);
  if (cached) return cached;
  const copy = await copyLocatedRuntimeDatabase(current, held);
  let result: AuditResult;
  try { result = await auditCopy(copy.databasePath, current); }
  finally { await copy.remove(); }
  const size = await measureTree(path.dirname(current.located.rootPointerPath));
  const complete: AuditResult = size ? { ...result, size } : result;
  await writeAuditCache(configurationRoot, current.id, files, complete).catch(() => undefined);
  return complete;
}

async function auditCopy(databasePath: string, root: LocatedRuntimeRoot): Promise<AuditResult> {
  try {
    const audit = await auditRuntimeSnapshot(databasePath, {
      binding: root.recorded as RootBinding, contentDigest: true, measure: true, summary: true, unfinishedWork: 'finalize'
    });
    const unfinished = audit.unfinishedWork;
    const finalizable = (unfinished?.turns.length ?? 0) + (unfinished?.intents.length ?? 0);
    const refused = unfinished?.refused.reduce((sum, item) => sum + item.count, 0) ?? 0;
    return {
      outcome: 'verified',
      audit: {
        ...(audit.summary ? { summary: audit.summary } : {}),
        ...(audit.size ? { rows: audit.size.rows } : {}),
        ...(audit.contentDigest ? { contentDigest: audit.contentDigest } : {}),
        ...(finalizable + refused > 0 ? { unfinishedWork: { finalizable, refused } } : {})
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Judged by the result code, never by the message: a corrupt page ("database disk image is
    // malformed", SQLITE_CORRUPT) or a file that is no database (SQLITE_NOTADB) is the root's own.
    if (error instanceof RuntimeSnapshotAuditError && !isTransientAuditCode(error.code)) {
      return { outcome: 'failed', code: 'foreign-history-audit-failed', reason: `结构或完整性核验未通过：${message}` };
    }
    throw new ForeignRuntimeHistoryRejection('unavailable', 'foreign-history-audit-unavailable', `暂时无法核验：核验线程没能完成（${message}）。`);
  }
}

function isTransientAuditCode(code: string | undefined): boolean {
  return code !== undefined && (TRANSIENT_SQLITE_CODE.test(code) || TRANSIENT_CODES.has(code));
}

/**
 * Old copy of a local data set: of its own identity or of one it continues, the current data set taking
 * precedence (findRuntimeIdentityOwner); identical foreign copies shown once. Continuations that cannot be
 * read only leave the relation unshown: a merge reads them again and waits.
 */
async function relate(
  configurationRoot: string,
  entries: ForeignRuntimeHistoryEntry[],
  candidates: readonly VscodeRuntimeDataSetCandidate[]
): Promise<void> {
  const primary = new Map<string, ForeignRuntimeHistoryEntry>();
  const locals = [...candidates].sort((left, right) => Number(right.selected) - Number(left.selected));
  for (const entry of entries) {
    if (entry.status !== 'verified') continue;
    const found = entry.dataSetId && entry.rootInstanceId
      ? await findRuntimeIdentityOwner(configurationRoot, locals, { dataSetId: entry.dataSetId, rootInstanceId: entry.rootInstanceId }, { unreadable: () => undefined })
        .catch(() => undefined)
      : undefined;
    if (found) {
      const { owner, continued } = found;
      entry.sameAsLocal = {
        candidateId: owner.id, selected: owner.selected, name: owner.selected ? '当前历史库' : runtimeDataSetReadableName(owner),
        ...(continued ? { continued: true as const } : {})
      };
    }
    const key = `${entry.dataSetId}\0${entry.rootInstanceId}\0${entry.contentDigest}`;
    const first = primary.get(key);
    if (first) entry.duplicateOf = first.id;
    else primary.set(key, entry);
  }
}

function requireStrictLocation(configurationRoot: string, location: ForeignRuntimeRootLocation): void {
  const invalid = (): never => { throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-location', '位置不符合外来历史库的发现规则。'); };
  const base = location.baseDataRootPath;
  const normalizedBase = !!base && path.isAbsolute(base) && path.resolve(base) === base;
  if (location.kind === 'archive') {
    // An archive of the current data directory, or of the previous one (named from its parent).
    const previous = location.side === 'previous';
    if (previous ? !normalizedBase || isSamePath(base!, configurationRoot) : location.side !== undefined || base !== undefined) invalid();
    const prefix = previous ? `${path.basename(base!)}/` : '';
    const relative = location.containerName.startsWith(prefix) ? location.containerName.slice(prefix.length) : '';
    if (!ARCHIVE_CONTAINER_NAME.test(relative)
      || location.containerPath !== path.join(previous ? path.dirname(base!) : configurationRoot, ...location.containerName.split('/'))
      || location.dataRootRelativePath !== (relative.endsWith(VSCODE_RUNTIME_ARCHIVES_DIRECTORY) ? '' : VSCODE_RUNTIME_ACTIVE_DIRECTORY)) invalid();
    return;
  }
  if (location.kind !== 'copied' || !normalizedBase
    || (location.side === 'current') !== isSamePath(base!, configurationRoot) || (location.side !== 'current' && location.side !== 'previous')
    || !copiedNamePattern(base!).test(location.containerName)
    || location.containerPath !== path.join(path.dirname(base!), location.containerName)
    || !COPIED_DATA_ROOT.test(location.dataRootRelativePath)) invalid();
}

/** The data directory an archive belongs to: the current one, or the previous one it was found in. */
function archiveBase(configurationRoot: string, location: ForeignRuntimeRootLocation): string {
  return location.side === 'previous' && location.baseDataRootPath ? location.baseDataRootPath : configurationRoot;
}

function hasDataRoot(location: Pick<ForeignRuntimeRootLocation, 'dataRootRelativePath'>): boolean {
  return location.dataRootRelativePath === VSCODE_RUNTIME_ACTIVE_DIRECTORY
    || location.dataRootRelativePath.endsWith(`/${VSCODE_RUNTIME_ACTIVE_DIRECTORY}`);
}

/** A container-level entry: says why its directory cannot be listed, or that nothing in it is a LimCode root. */
async function rejectContainerWithoutRoot(location: ForeignRuntimeRootLocation): Promise<never> {
  const directory = path.join(location.containerPath, ...location.dataRootRelativePath.split('/').filter(Boolean));
  const notADirectory = new ForeignRuntimeHistoryRejection('failed', 'foreign-history-no-runtime', '归档目录是符号链接或不是目录，不跟随链接读取。');
  try {
    await assertNoSymbolicPath(location.containerPath, directory);
    if (!(await fs.lstat(directory)).isDirectory()) throw notADirectory;
    await fs.readdir(directory);
  } catch (error) {
    // A link found on the way carries no errno; a directory that cannot be listed says why.
    if (error === notADirectory || !(error as NodeJS.ErrnoException | undefined)?.code) throw notADirectory;
    throw fileProblem(error, 'foreign-history-no-runtime', '归档目录无法读取。');
  }
  throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-no-runtime', '里面没有可识别的 LimCode 历史库。');
}

function locatedPaths(location: ForeignRuntimeRootLocation) {
  return createRuntimeRootPaths(path.join(location.containerPath, ...location.dataRootRelativePath.split('/')));
}

/** The tree whose size is shown: the located control root, or the whole container. */
function measuredPath(location: ForeignRuntimeRootLocation): string {
  return hasDataRoot(location)
    ? path.dirname(locatedPaths(location).rootPointerPath)
    : path.join(location.containerPath, ...location.dataRootRelativePath.split('/').filter(Boolean));
}

function copiedNamePattern(base: string): RegExp {
  const name = path.basename(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${name}${COPIED_SUFFIX}$`, process.platform === 'win32' ? 'i' : '');
}

/** Why an older format is not opened here, saying only what is true of this root. */
function oldFormatReason(location: ForeignRuntimeRootLocation, epoch: number): string {
  if (epoch !== 3 && epoch !== 4 && epoch !== 5 && epoch !== 6 && epoch !== 7 && epoch !== 8) {
    return `它是不受支持的旧格式（第 ${epoch} 代），当前版本不能读取，也不能升级它。它原样保留，不会被删除。`;
  }
  if (location.kind === 'archive' || location.dataRootRelativePath.includes(`${VSCODE_RUNTIME_ARCHIVES_DIRECTORY}/`)) {
    return `它是已发布旧格式（第 ${epoch} 代）的归档。旧格式只能在历史库原来的位置上先备份再升级，而这个位置在归档时已经交给了新建的库，`
      + '所以当前版本不能打开它。它原样保留，不会被删除。';
  }
  return `它是已发布的旧格式（第 ${epoch} 代）。当前版本只在数据目录自己的历史库上先备份再升级旧格式，不升级从别处拷来的目录，`
    + '所以不能在这里打开它。它原样保留，不会被删除。';
}

async function containerScopes(containerPath: string): Promise<Array<{ label: string; relative: string[] }>> {
  const scopes: Array<{ label: string; relative: string[] }> = [{ label: 'default', relative: [] }];
  const scopesRoot = path.join(containerPath, VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, VSCODE_WORKSPACE_RUNTIME_SCOPES_DIRECTORY);
  const keys = await listContainerDirectory(containerPath, scopesRoot);
  if (keys === 'invalid') return scopes;
  for (const key of keys.filter((entry) => WORKSPACE_SCOPE_KEY.test(entry)).sort()) {
    scopes.push({ label: `workspace:${key}`, relative: [VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, VSCODE_WORKSPACE_RUNTIME_SCOPES_DIRECTORY, key] });
  }
  return scopes;
}

/** Names in a directory reached without links; [] when absent, 'invalid' for a link or a non-directory. */
async function listContainerDirectory(containerPath: string, directory: string): Promise<string[] | 'invalid'> {
  try {
    await assertNoSymbolicPath(containerPath, path.dirname(directory));
    const info = await fs.lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) return 'invalid';
    return await fs.readdir(directory);
  } catch (error) {
    if (isMissing(error)) return [];
    if (error instanceof Error && /symbolic link/.test(error.message)) return 'invalid';
    throw error;
  }
}

/** Same rule as local candidates: an empty control or active directory is no data set. */
async function hasRuntimeEntries(control: string, entries: readonly string[]): Promise<boolean> {
  for (const entry of entries) {
    if (entry !== VSCODE_RUNTIME_ACTIVE_DIRECTORY) return true;
    const active = await fs.lstat(path.join(control, entry));
    if (!active.isDirectory() || (await fs.readdir(path.join(control, entry))).length > 0) return true;
  }
  return false;
}

/** Copied directories this directory's relocation renamed aside, by name, from its completion record. */
async function copiedAsideByRelocation(configurationRoot: string, held: HeldDatabaseFiles): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    const marker = JSON.parse(await readForeignFile(path.join(configurationRoot, DATA_ROOT_RELOCATION_MARKER_FILE), held)) as {
      kind?: unknown; relocationId?: unknown; targetRootPath?: unknown; targetState?: { kind?: unknown }; movedAside?: unknown;
    } | null;
    if (marker?.kind === RELOCATION_MARKER_KIND && marker.targetState?.kind === 'copied' && typeof marker.movedAside === 'string'
      && typeof marker.relocationId === 'string' && typeof marker.targetRootPath === 'string'
      && isSamePath(path.resolve(marker.targetRootPath), configurationRoot)
      && isSamePath(path.dirname(path.resolve(marker.movedAside)), path.dirname(configurationRoot))) {
      result.set(path.basename(marker.movedAside), marker.relocationId);
    }
  } catch { /* No record, or not readable: only the label is missing. */ }
  return result;
}

/**
 * A copied data directory in the middle of a relocation into it (its own record, staging or undoing)
 * holds half-written data; a merge ledger entry still committing into or out of this root means its
 * last transaction's outcome is unsettled. Both are left to the LimCode that owns them. An archive's
 * merges were recorded by the data directory it belongs to, a copied root's by the copied directory.
 */
async function assertNoUnfinishedRelocationOrMerge(
  configurationRoot: string,
  location: ForeignRuntimeRootLocation,
  recorded: HistoricalRootBinding,
  held: HeldDatabaseFiles
): Promise<void> {
  const ledgerRoot = location.kind === 'archive' ? archiveBase(configurationRoot, location) : location.containerPath;
  if (location.kind === 'copied') {
    const markerPath = path.join(location.containerPath, DATA_ROOT_RELOCATION_MARKER_FILE);
    if (await present(markerPath)) {
      let state: unknown;
      try { state = (JSON.parse(await readForeignFile(markerPath, held)) as { state?: unknown } | null)?.state; }
      catch (error) {
        if (error instanceof SyntaxError) {
          throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-relocation-record', '迁移记录不是有效的 JSON，无法确认拷贝时没有迁移在进行。');
        }
        throw await readProblem(error, location.containerPath, 'foreign-history-relocation-record', '迁移记录无法读取。');
      }
      if (state === 'staging' || state === 'undoing') {
        throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-unfinished-relocation',
          '拷贝时这个目录正处在一次没有完成的数据目录迁移中，内容可能不完整；原样保留。');
      }
    }
  }
  const directory = path.join(resolveVscodeRuntimeMergeLedgerRoot({ globalStoragePath: ledgerRoot }), MERGE_LEDGER_RECORDS);
  let names: string[];
  try {
    await assertNoSymbolicPath(ledgerRoot, directory);
    if (!(await fs.lstat(directory)).isDirectory()) throw new Error('not a directory');
    names = (await fs.readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (isMissing(error)) return;
    throw await readProblem(error, ledgerRoot, 'foreign-history-merge-ledger', '合并记录目录无法读取（符号链接或不是目录）。');
  }
  for (const name of names) {
    let record: {
      kind?: unknown; state?: unknown; candidateId?: unknown;
      source?: { dataSetId?: unknown; rootInstanceId?: unknown }; target?: { dataSetId?: unknown; rootInstanceId?: unknown };
    } | null;
    try { record = JSON.parse(await readForeignFile(path.join(directory, name), held)) as typeof record; }
    catch (error) {
      // A torn, special or foreign file is no record (the ledger's own reader skips it too); a special one is never opened.
      if (error instanceof SyntaxError || isMissing(error)) continue;
      if (error instanceof ForeignRuntimeHistoryRejection && NOT_A_RECORD.has(error.code)) continue;
      throw await readProblem(error, ledgerRoot, 'foreign-history-merge-ledger', '合并记录无法读取。');
    }
    if (record?.kind !== MERGE_LEDGER_RECORD_KIND || record.state !== 'committing') continue;
    // A merge out of a foreign root (keyed by its foreign id) only ever read that root: its unsettled
    // outcome concerns the data set it merged into, never the content of a root with its identity.
    const merged = typeof record.candidateId === 'string' && FOREIGN_ID.test(record.candidateId) ? [record.target] : [record.source, record.target];
    if (merged.some((identity) =>
      identity?.dataSetId === recorded.dataSetId && identity.rootInstanceId === recorded.rootInstanceId)) {
      throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-unfinished-merge',
        '它参与的一次合并还没有确认是否写入完成；只能由原来的 LimCode 收尾，原样保留。');
    }
  }
}

/**
 * Every Host that published liveness here must be proven gone. Each record is read as a small regular
 * file. A record that is no regular file or cannot be parsed never proves its writer gone and never
 * gets better by itself: failed. A live process, or one whose state is unknown: not verifiable now.
 */
async function assertForeignHostsGone(directory: string, container: string, held: HeldDatabaseFiles): Promise<void> {
  let names: string[];
  try {
    if (!(await fs.lstat(directory)).isDirectory()) {
      throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-host-record', 'host-liveness 不是普通目录，无法证明使用它的进程已经结束；原样保留。');
    }
    names = (await fs.readdir(directory)).filter((name) => name.endsWith('.json')).sort();
  } catch (error) {
    if (isMissing(error)) return;
    throw await readProblem(error, container, 'foreign-history-hosts-unreadable', '无法确认没有 LimCode 窗口在使用它。');
  }
  const records: Array<{ name: string; text: string }> = [];
  for (const name of names) {
    try { records.push({ name, text: await readForeignFile(path.join(directory, name), held, MAX_HOST_RECORD_BYTES) }); }
    catch (error) {
      if (isMissing(error)) continue; // Removed by its exiting Host meanwhile.
      if (error instanceof ForeignRuntimeHistoryRejection && error.code === 'foreign-history-special-file') {
        throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-host-record',
          `host-liveness 里的 ${name} 不是普通文件（符号链接、管道或设备），不打开它，也就无法证明使用它的进程已经结束；原样保留。`);
      }
      throw await readProblem(error, container, 'foreign-history-hosts-unreadable', '无法确认没有 LimCode 窗口在使用它。');
    }
  }
  const active = judgeRuntimeHostLivenessRecords(records);
  const malformed = active.filter((host) => host.state === 'malformed');
  if (malformed.length > 0) {
    throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-host-record',
      `host-liveness 里有 ${malformed.length} 条记录格式无效（${malformed.map((host) => host.hostBootId).join('、')}），无法证明写它的进程已经结束；原样保留。`);
  }
  if (active.length > 0) {
    throw new ForeignRuntimeHistoryRejection('unavailable', 'foreign-history-hosts-active',
      `有 ${active.length} 个 LimCode 窗口可能正在使用它（进程 ${active.map((host) => host.processId).join('、')}）；这些窗口关闭后再核验。`);
  }
}

async function readForeignFile(file: string, held: HeldDatabaseFiles, maxBytes = MAX_SMALL_JSON_BYTES): Promise<string> {
  return (await readLocatedRuntimeFile(file, held, maxBytes)).toString('utf8');
}

/** None of a database's files (main, -wal, -shm, -journal) may be a file of a database this process holds. */
async function assertNotHeldDatabase(databasePath: string, held: HeldDatabaseFiles): Promise<void> {
  if (held.size === 0) return;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const info = await fs.lstat(`${databasePath}${suffix}`, { bigint: true }).catch(() => undefined);
    if (info && held.has(`${info.dev}:${info.ino}`)) throw openDatabase(`${databasePath}${suffix}`);
  }
}

function openDatabase(file: string): ForeignRuntimeHistoryRejection {
  return new ForeignRuntimeHistoryRejection('failed', 'foreign-history-open-database',
    `${path.basename(file)} 和本窗口可能正在使用的数据库是同一个文件（硬链接）；为了不破坏那个库的锁，不读取它。`);
}

function gone(): ForeignRuntimeHistoryRejection {
  return new ForeignRuntimeHistoryRejection('unavailable', 'foreign-history-gone', '它已经被移走或删除，所在位置找不到了。');
}

/** Refusals pass through; a file missing while its container is still there means the root is incomplete. */
async function readProblem(error: unknown, container: string, code: string, label: string): Promise<ForeignRuntimeHistoryRejection> {
  if (error instanceof ForeignRuntimeHistoryRejection) return error;
  if (isMissing(error)) {
    if (!await present(container).catch(() => true)) return gone();
    return new ForeignRuntimeHistoryRejection('failed', 'foreign-history-incomplete', '历史库不完整：缺少 RootBinding 指针、数据库、正文目录或 epoch 清单。');
  }
  return fileProblem(error, code, label);
}

/**
 * A deterministic problem is "failed"; space, I/O and permission errors of the moment are
 * "unavailable"; a container that went away is "gone".
 */
function fileProblem(error: unknown, code: string, label: string): ForeignRuntimeHistoryRejection {
  if (error instanceof ForeignRuntimeHistoryRejection) return error;
  if (isMissing(error)) return gone();
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  const detail = error instanceof Error ? error.message : String(error);
  if (errno && TRANSIENT_CODES.has(errno)) {
    return new ForeignRuntimeHistoryRejection('unavailable', code, `暂时无法核验：${label.replace(/。$/, '')}（${detail}）。`);
  }
  return new ForeignRuntimeHistoryRejection('failed', code, errno ? `${label.replace(/。$/, '')}（${errno}）。` : label);
}

async function readAuditCache(configurationRoot: string, id: string, files: string): Promise<AuditResult | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(await foreignRuntimeHistoryFile(configurationRoot, CACHE_DIRECTORY, id, '.json'), 'utf8')) as {
      kind?: unknown; id?: unknown; files?: unknown; validationRevision?: unknown; result?: AuditResult;
    } | null;
    if (value?.kind !== CACHE_KIND || value.validationRevision !== RUNTIME_MERGE_VALIDATION_REVISION || value.id !== id || value.files !== files || !value.result) return undefined;
    const result = value.result;
    if (result.outcome === 'verified' && result.audit && typeof result.audit === 'object') return result;
    if (result.outcome === 'failed' && typeof result.code === 'string' && typeof result.reason === 'string') return result;
    return undefined;
  } catch {
    return undefined;
  }
}

async function writeAuditCache(configurationRoot: string, id: string, files: string, result: AuditResult): Promise<void> {
  await writeCacheFile(await foreignRuntimeHistoryFile(configurationRoot, CACHE_DIRECTORY, id, '.json'),
    { kind: CACHE_KIND, validationRevision: RUNTIME_MERGE_VALIDATION_REVISION, id, files, checkedAt: new Date().toISOString(), result });
}

async function writeCacheFile(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Size of a root that failed verification, walked once and kept per exact state of what makes up
 * most of it (the measured tree itself, and when located its data root, database, WAL, pointer and
 * content directory). Only shown, never authoritative.
 */
async function cachedTreeSize(
  configurationRoot: string,
  id: string,
  location: ForeignRuntimeRootLocation
): Promise<{ bytes: string; fileCount: number } | undefined> {
  const tree = measuredPath(location);
  const located = hasDataRoot(location) ? locatedPaths(location) : undefined;
  const watched = [tree, ...(located
    ? [located.dataRootPath, located.databasePath, `${located.databasePath}-wal`, located.rootPointerPath, located.casRootPath] : [])];
  let state: string;
  try {
    const parts: string[] = [];
    for (const file of watched) {
      const stat = await fs.lstat(file, { bigint: true }).catch((error: unknown) => { if (isMissing(error)) return undefined; throw error; });
      parts.push(stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : 'absent');
    }
    state = parts.join(';');
  } catch {
    return measureTree(tree);
  }
  const file = await foreignRuntimeHistoryFile(configurationRoot, CACHE_DIRECTORY, id, '.size.json').catch(() => undefined);
  if (!file) return measureTree(tree);
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as {
      kind?: unknown; id?: unknown; state?: unknown; size?: { bytes?: unknown; fileCount?: unknown };
    } | null;
    if (value?.kind === SIZE_CACHE_KIND && value.id === id && value.state === state
      && typeof value.size?.bytes === 'string' && typeof value.size.fileCount === 'number') {
      return { bytes: value.size.bytes, fileCount: value.size.fileCount };
    }
  } catch { /* Not measured yet. */ }
  const size = await measureTree(tree);
  if (size) await writeCacheFile(file, { kind: SIZE_CACHE_KIND, id, state, size }).catch(() => undefined);
  return size;
}

/** One foreign root's claim (the one withLocatedRuntimeRootFence takes), held until released. */
export interface ForeignRuntimeRootClaimHold {
  /** True from acquisition until release. */
  readonly held: boolean;
  release(): Promise<void>;
}

/**
 * Takes a foreign root's claim and keeps it across calls and async scopes until released: a merge
 * holds it from its (large-merge) preparation to its commit, so verification, viewing and backup
 * cleanup of the same root wait for it or refuse meanwhile. Waits as the fence does (a live holder is
 * awaited, a dead one's claim isolated). Never taken inside this configuration root's admission (its
 * holder takes the admission after it); code running under a hold never takes the same root's fence
 * again, which from another async scope would wait for the hold itself.
 */
export async function holdForeignRuntimeRootClaim(
  paths: { globalStoragePath: string },
  id: string,
  targetPath: string
): Promise<ForeignRuntimeRootClaimHold> {
  const configurationRoot = path.resolve(paths.globalStoragePath);
  if (isRuntimeDataRootAdmissionHeld(configurationRoot)) {
    throw new Error('A foreign history root is claimed before the configuration admission, never inside it.');
  }
  const claimPath = await foreignRuntimeHistoryFile(configurationRoot, CLAIMS_DIRECTORY, id, '');
  let acquired!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { acquired = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const state = { held: false };
  const holder = withRuntimeClaimAtPath(claimPath, targetPath, async () => {
    state.held = true;
    acquired();
    await released;
  }).finally(() => { state.held = false; });
  await Promise.race([started, holder]);
  return {
    get held() { return state.held; },
    async release() {
      release();
      await holder.catch((error: unknown) => console.warn('[LimCode] 释放外来历史库的声明失败。', error));
    }
  };
}

/** `.limcode-runtime-merges/<section>/<id with ':' → '-'><suffix>` under the current configuration root only. */
async function foreignRuntimeHistoryFile(configurationRootPath: string, section: string, id: string, suffix: string): Promise<string> {
  if (!FOREIGN_ID.test(id)) throw new TypeError(`Not a foreign history id: ${id}`);
  const configurationRoot = path.resolve(configurationRootPath);
  const directory = path.join(resolveVscodeRuntimeMergeLedgerRoot({ globalStoragePath: configurationRoot }), section);
  await assertNoSymbolicPath(configurationRoot, directory).catch((error: unknown) => { if (!isMissing(error)) throw error; });
  return path.join(directory, `${id.replace(/:/g, '-')}${suffix}`);
}

/** Exact state of what the audit read: database and WAL, pointer and manifest, and the records themselves. */
export async function foreignFileState(root: LocatedRuntimeRoot): Promise<string> {
  const describe = async (file: string): Promise<string> => {
    const stat: BigIntStats = await fs.stat(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  };
  return [
    await runtimeDataSetFileState(root.located.databasePath),
    `pointer=${await describe(root.located.rootPointerPath)}`,
    `epoch=${await describe(root.located.runtimeEpochPath)}`,
    `recorded=${createHash('sha256').update(JSON.stringify(root.recorded)).digest('hex')}`
  ].join(';');
}

/** Logical size without following links; undefined when the tree cannot be walked. */
async function measureTree(root: string): Promise<{ bytes: string; fileCount: number } | undefined> {
  try {
    let bytes = 0n;
    let fileCount = 0;
    const queue = [root];
    while (queue.length > 0) {
      const current = queue.pop()!;
      const stat = await fs.lstat(current, { bigint: true });
      if (stat.isSymbolicLink()) continue;
      if (stat.isFile()) { bytes += stat.size; fileCount += 1; }
      else if (stat.isDirectory()) for (const name of await fs.readdir(current)) queue.push(path.join(current, name));
    }
    return { bytes: bytes.toString(), fileCount };
  } catch {
    return undefined;
  }
}

async function present(file: string): Promise<boolean> {
  return (await lstatIfPresent(file)) !== undefined;
}

async function lstatIfPresent(file: string) {
  try { return await fs.lstat(file); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}

function rejected(error: unknown): Pick<ForeignRuntimeHistoryEntry, 'status' | 'code' | 'reason'> {
  if (error instanceof ForeignRuntimeHistoryRejection) return { status: error.status, code: error.code, reason: error.message };
  // Nothing proves the root itself wrong: never report "failed" without a determinate reason.
  return { status: 'unavailable', code: 'foreign-history-unavailable', reason: `暂时无法核验：${error instanceof Error ? error.message : String(error)}` };
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
