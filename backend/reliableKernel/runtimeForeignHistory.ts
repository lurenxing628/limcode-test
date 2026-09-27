import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isSamePath } from '../capabilities/filesystem/pathContainment';
import { createRuntimeRootPaths, ROOT_BINDING_PENDING_FILE, RUNTIME_KERNEL_EPOCH, type RootBinding } from './contracts';
import { CUTOVER_JOURNAL_FILE, CUTOVER_REQUEST_FILE } from './physicalCutover';
import { parseHistoricalRootBinding, type HistoricalRootBinding } from './rootAuthority';
import type { RuntimeDataSetSummary } from './runtimeDataSetContent';
import { runtimeDataSetFileState } from './runtimeDataSetFacts';
import { readRuntimeDataSetMergeLedger } from './runtimeDataSetMergeLedger';
import { DATA_ROOT_RELOCATION_MARKER_FILE } from './runtimeDataRootRelocation';
import { RETIRED_EPOCH_3_TO_4_JOURNAL_FILE, RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE } from './runtimeEpochMigration';
import { listActiveRuntimeHosts, withRuntimeClaimAtPath, withRuntimeMaintenance } from './runtimeHostControl';
import {
  locateLocalRuntimeDataSet, sameLocatedRuntimeRoot, type ForeignRuntimeRootLocation, type LocatedRuntimeRoot
} from './runtimeLocatedRoot';
import { auditRuntimeSnapshot, RuntimeSnapshotAuditError } from './runtimeSnapshotAudit';
import {
  assertNoSymbolicPath, copyRuntimeSqliteFiles, inspectLocatedRuntimeStorage, type RuntimeDataSetStorageInspection
} from './runtimeStorageInspection';
import {
  inspectVscodeRuntimeDataSets, resolveVscodeRuntimeMergeLedgerRoot, VSCODE_RUNTIME_ACTIVE_DIRECTORY,
  VSCODE_RUNTIME_ARCHIVES_DIRECTORY, VSCODE_RUNTIME_CONTROL_DIRECTORY, VSCODE_WORKSPACE_RUNTIME_SCOPES_DIRECTORY,
  VSCODE_WORKSPACE_RUNTIMES_DIRECTORY, type VscodeRuntimeDataSetCandidate
} from './vscodeRootAuthority';

/**
 * Foreign history: complete Runtime roots this configuration root does not enumerate as data sets,
 * registered in place and read only. Found by listing directories and reading small JSON files:
 * - reset archives `<scope>/.limcode-runtime-backups/<time>-<id8>` of every scope (the data root is
 *   `<archive>/active`), also of scopes that keep nothing else;
 * - copied data directories `<data directory name>.limcode-copied-<time>-<id8>` beside the current
 *   data directory and beside the previous one (globalStatus lastMigration.fromPath), and inside each
 *   its default root, its workspace scopes and their archives.
 *
 * Location comes only from these rules (getPaths plus fixed and strictly matched names); identity
 * only from the root's own records, which must agree exactly. Verification is as strict as for a
 * local candidate, except that "the recorded paths equal the expected paths" becomes "the recorded
 * paths are self-consistent": every read goes to the located paths and a recorded path is never
 * handed to any I/O (the original may still be there, or a newer root occupies it). Nothing is ever
 * created inside a foreign directory: SQLite opens only private copies (worker thread first), the
 * cached results and the claim live under the current configuration root. A foreign root is like a
 * data set the user kept: never merged automatically (merging is for a later version), never
 * selectable, never finalized or upgraded. Roots that fail are listed with name, location, size and
 * reason and kept as they are; a disk that is full or a copy that fails is "not verifiable now".
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
  /** Same data set incarnation as a local data set: an old copy of it. */
  sameAsLocal?: { candidateId: string; selected: boolean };
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
  /** globalStatus lastMigration.fromPath, when a relocation left an old data directory. */
  previousDataRootPath?: string;
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

const ARCHIVE_NAME = /^\d{8}-\d{6}-\d{3}-[0-9a-f]{8}$/;
const COPIED_SUFFIX = String.raw`\.limcode-copied-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}`;
const WORKSPACE_SCOPE_KEY = /^(workspace-file|folder|folder-set|empty)-[a-f0-9]{64}$/;
const SCOPE_PREFIX = String.raw`(?:\.limcode-workspace-runtimes/scopes/(?:workspace-file|folder|folder-set|empty)-[a-f0-9]{64}/)?`;
const ARCHIVE_CONTAINER_NAME = new RegExp(String.raw`^${SCOPE_PREFIX}\.limcode-runtime-backups(?:/\d{8}-\d{6}-\d{3}-[0-9a-f]{8})?$`);
const COPIED_DATA_ROOT = new RegExp(
  String.raw`^(?:${SCOPE_PREFIX}(?:\.limcode-runtime/active|\.limcode-runtime-backups/\d{8}-\d{6}-\d{3}-[0-9a-f]{8}/active|\.limcode-runtime-backups))?$`
);
const FOREIGN_ID = /^foreign:(archive|copied):[0-9a-f]{16}$/;
const MAX_SMALL_JSON_BYTES = 4 * 1024 * 1024;
const COPY_ATTEMPTS = 3;
const CACHE_DIRECTORY = 'foreign';
const CLAIMS_DIRECTORY = 'foreign-claims';
const CACHE_KIND = 'limcode-foreign-runtime-history-audit';
const RELOCATION_MARKER_KIND = 'limcode-data-root-relocation';
/** A control root with any of these is in the middle of a transition, upgrade or cutover. */
const IN_PROGRESS_FILES: readonly string[] = Object.freeze([
  ROOT_BINDING_PENDING_FILE, RUNTIME_EPOCH_MIGRATION_JOURNAL_FILE,
  RETIRED_EPOCH_3_TO_4_JOURNAL_FILE, CUTOVER_REQUEST_FILE, CUTOVER_JOURNAL_FILE
]);
/** Errors of the moment (space, I/O, permissions, busy): "not verifiable now", never "failed". */
const TRANSIENT_CODES = new Set(['ENOSPC', 'EDQUOT', 'EIO', 'EAGAIN', 'EBUSY', 'ETIMEDOUT', 'EMFILE', 'ENFILE', 'EACCES', 'EPERM', 'ENOMEM']);

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

/** Only list directories and read small JSON files: safe at any time, done once in the background at startup. */
export async function discoverForeignRuntimeHistory(input: ForeignRuntimeHistoryInput): Promise<DiscoveredForeignRuntimeRoot[]> {
  const configurationRoot = path.resolve(input.configurationRootPath);
  const found: DiscoveredForeignRuntimeRoot[] = [];
  for (const scope of await containerScopes(configurationRoot).catch(() => [{ label: 'default', relative: [] as string[] }])) {
    const archives = path.join(configurationRoot, ...scope.relative, VSCODE_RUNTIME_ARCHIVES_DIRECTORY);
    const listed = await listContainerDirectory(configurationRoot, archives).catch(() => 'invalid' as const);
    const archivesName = [...scope.relative, VSCODE_RUNTIME_ARCHIVES_DIRECTORY].join('/');
    if (listed === 'invalid') {
      // A link, a file, or unreadable: listed as the archives directory, whose verification names why.
      found.push(await discovered({ kind: 'archive', containerPath: archives, containerName: archivesName, dataRootRelativePath: '' },
        VSCODE_RUNTIME_ARCHIVES_DIRECTORY, scope.label));
      continue;
    }
    for (const name of listed.filter((entry) => ARCHIVE_NAME.test(entry)).sort()) {
      found.push(await discovered({
        kind: 'archive', containerPath: path.join(archives, name), containerName: `${archivesName}/${name}`, dataRootRelativePath: VSCODE_RUNTIME_ACTIVE_DIRECTORY
      }, name, scope.label));
    }
  }
  const movedAside = await copiedAsideByRelocation(configurationRoot);
  const sides: Array<{ side: 'current' | 'previous'; base: string }> = [{ side: 'current', base: configurationRoot }];
  const previous = input.previousDataRootPath;
  if (previous && path.isAbsolute(previous) && !isSamePath(path.resolve(previous), configurationRoot)) {
    sides.push({ side: 'previous', base: path.resolve(previous) });
  }
  for (const { side, base } of sides) {
    const pattern = copiedNamePattern(base);
    let names: string[];
    // Only names are read here; a parent that cannot be listed hides nothing it could show.
    try { names = await fs.readdir(path.dirname(base)); }
    catch { continue; }
    for (const name of names.filter((entry) => pattern.test(entry)).sort()) {
      const container = { kind: 'copied' as const, side, baseDataRootPath: base, containerPath: path.join(path.dirname(base), name), containerName: name };
      const relocationId = side === 'current' ? movedAside.get(name) : undefined;
      found.push(...(await copiedRoots(container)).map((entry) => relocationId ? { ...entry, movedAsideBy: relocationId } : entry));
    }
  }
  return found;
}

/** Every root inside one copied data directory (or the directory itself when none is recognizable). */
async function copiedRoots(
  container: Omit<ForeignRuntimeRootLocation, 'dataRootRelativePath'>
): Promise<DiscoveredForeignRuntimeRoot[]> {
  const whole = (): Promise<DiscoveredForeignRuntimeRoot> => discovered({ ...container, dataRootRelativePath: '' }, container.containerName, '');
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
        }, container.containerName, scope.label));
      }
      const archives = path.join(container.containerPath, ...scope.relative, VSCODE_RUNTIME_ARCHIVES_DIRECTORY);
      const listed = await listContainerDirectory(container.containerPath, archives);
      if (listed === 'invalid') {
        roots.push(await discovered({ ...container, dataRootRelativePath: [...scope.relative, VSCODE_RUNTIME_ARCHIVES_DIRECTORY].join('/') },
          container.containerName, scope.label));
        continue;
      }
      for (const name of listed.filter((entry) => ARCHIVE_NAME.test(entry)).sort()) {
        roots.push({
          ...await discovered({
            ...container, dataRootRelativePath: [...scope.relative, VSCODE_RUNTIME_ARCHIVES_DIRECTORY, name, VSCODE_RUNTIME_ACTIVE_DIRECTORY].join('/')
          }, container.containerName, scope.label),
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

async function discovered(location: ForeignRuntimeRootLocation, name: string, scope: string): Promise<DiscoveredForeignRuntimeRoot> {
  const frozen = Object.freeze({ ...location });
  return { id: foreignRuntimeHistoryId(frozen, await readPointerIdentity(frozen)), location: frozen, name, scope };
}

/** Identity for the id only (plain small JSON); verification parses the pointer strictly again. */
async function readPointerIdentity(location: ForeignRuntimeRootLocation): Promise<{ dataSetId: string; rootInstanceId: string } | undefined> {
  if (!location.dataRootRelativePath.endsWith(`/${VSCODE_RUNTIME_ACTIVE_DIRECTORY}`) && location.dataRootRelativePath !== VSCODE_RUNTIME_ACTIVE_DIRECTORY) return undefined;
  const pointer = locatedPaths(location).rootPointerPath;
  try {
    await assertNoSymbolicPath(location.containerPath, pointer);
    const info = await fs.lstat(pointer);
    if (!info.isFile() || info.size > MAX_SMALL_JSON_BYTES) return undefined;
    const value = JSON.parse(await fs.readFile(pointer, 'utf8')) as { dataSetId?: unknown; rootInstanceId?: unknown } | null;
    return typeof value?.dataSetId === 'string' && typeof value.rootInstanceId === 'string'
      ? { dataSetId: value.dataSetId, rootInstanceId: value.rootInstanceId } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The exact checks of one foreign root (all but the private-snapshot audit), read only from its
 * located paths: no symbolic link from the container down; a strictly valid pointer, no pending
 * pointer, rollback journal, transition, upgrade, relocation or merge in progress; recorded paths
 * self-consistent and ending in `.limcode-runtime/active`; an exact current-epoch manifest; every
 * Host proven gone. Throws ForeignRuntimeHistoryRejection.
 */
export async function locateForeignRuntimeRoot(
  configurationRootPath: string,
  location: ForeignRuntimeRootLocation
): Promise<LocatedRuntimeRoot> {
  const configurationRoot = path.resolve(configurationRootPath);
  requireStrictLocation(configurationRoot, location);
  const container = location.containerPath;
  await guard('failed', 'foreign-history-link', '所在位置有符号链接或不是目录，不跟随链接读取。', async () => {
    if (location.kind === 'archive') await assertNoSymbolicPath(configurationRoot, container);
    const info = await fs.lstat(container);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('not a directory');
  });
  if (!location.dataRootRelativePath.endsWith(VSCODE_RUNTIME_ACTIVE_DIRECTORY)) {
    throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-no-runtime',
      location.dataRootRelativePath ? '归档目录是符号链接或不是目录，不跟随链接读取。' : '里面没有可识别的 LimCode 历史库。');
  }
  const located = locatedPaths(location);
  const control = path.dirname(located.rootPointerPath);
  await guard('failed', 'foreign-history-link', '历史库的目录或文件是符号链接，不跟随链接读取。', async () => {
    for (const target of [control, located.rootPointerPath, located.dataRootPath, located.databasePath, located.casRootPath, located.runtimeEpochPath]) {
      await assertNoSymbolicPath(container, target).catch((error: unknown) => { if (!isMissing(error)) throw error; });
    }
  });
  await guard('failed', 'foreign-history-incomplete', '历史库不完整：缺少 RootBinding 指针、数据库、正文目录或 epoch 清单。', async () => {
    for (const [target, kind] of [[located.rootPointerPath, 'file'], [located.databasePath, 'file'], [located.casRootPath, 'directory'], [located.runtimeEpochPath, 'file']] as const) {
      const info = await fs.lstat(target);
      if (kind === 'file' ? !info.isFile() : !info.isDirectory()) throw new Error(`${target} is not a ${kind}`);
    }
  });
  let recorded: HistoricalRootBinding;
  try { recorded = parseHistoricalRootBinding(JSON.parse(await readSmallFile(located.rootPointerPath))); }
  catch (error) { throw classified(error, 'foreign-history-pointer-invalid', 'RootBinding 指针无法严格解析'); }
  for (const name of IN_PROGRESS_FILES) {
    if (await present(path.join(control, name))) {
      throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-unfinished-operation',
        `有未完成的根切换、升级或迁移（${name}），它只能在原位置由原来的 LimCode 收尾；原样保留。`);
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
  try { manifest = JSON.parse(await readSmallFile(located.runtimeEpochPath)) as Record<string, unknown>; }
  catch (error) { throw classified(error, 'foreign-history-epoch-manifest', 'epoch 清单无法读取'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || Object.keys(manifest).sort().join(',') !== 'dataSetId,initializedAt,kind,rootGeneration,rootInstanceId,runtimeKernelEpoch'
    || manifest.kind !== 'limcode-runtime-kernel-epoch' || typeof manifest.initializedAt !== 'string' || manifest.initializedAt.length === 0
    || manifest.runtimeKernelEpoch !== recorded.runtimeKernelEpoch || manifest.dataSetId !== recorded.dataSetId
    || manifest.rootInstanceId !== recorded.rootInstanceId || manifest.rootGeneration !== recorded.rootGeneration) {
    throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-epoch-manifest', 'epoch 清单与 RootBinding 不一致。');
  }
  if (recorded.runtimeKernelEpoch !== RUNTIME_KERNEL_EPOCH) {
    throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-epoch-not-current',
      `它是已发布的旧格式（第 ${recorded.runtimeKernelEpoch} 代），只能在原位置由 LimCode 备份后升级；当前版本不在别处升级它，原样保留。`);
  }
  await assertNoUnfinishedRelocationOrMerge(configurationRoot, location, recorded);
  let hosts;
  try { hosts = await listActiveRuntimeHosts(located); }
  catch (error) { throw classified(error, 'foreign-history-hosts-unreadable', '无法确认没有 LimCode 窗口在使用它'); }
  if (hosts.length > 0) {
    throw new ForeignRuntimeHistoryRejection('unavailable', 'foreign-history-hosts-active',
      `有 ${hosts.length} 个 LimCode 窗口可能正在使用它（进程 ${hosts.map((host) => host.processId).join('、')}）；这些窗口关闭后再核验。`);
  }
  return Object.freeze({
    id: foreignRuntimeHistoryId(location, recorded),
    origin: Object.freeze({ kind: 'foreign' as const, location: Object.freeze({ ...location }) }),
    containerRoot: container,
    located: Object.freeze(located),
    recorded
  });
}

/** Located again from where it was found (local candidate id, or foreign location): never from its records. */
export async function relocateRuntimeRoot(paths: { globalStoragePath: string }, root: LocatedRuntimeRoot): Promise<LocatedRuntimeRoot> {
  return root.origin.kind === 'local'
    ? locateLocalRuntimeDataSet(paths, root.origin.candidateId)
    : locateForeignRuntimeRoot(paths.globalStoragePath, root.origin.location);
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

/** Every foreign root, verified (cached per exact file state, never authoritative) and related to the local data sets. */
export async function inspectForeignRuntimeHistory(
  input: ForeignRuntimeHistoryInput & { onProgress?(done: number, total: number): void }
): Promise<ForeignRuntimeHistoryReport> {
  const configurationRoot = path.resolve(input.configurationRootPath);
  const found = await discoverForeignRuntimeHistory(input);
  const { candidates } = await inspectVscodeRuntimeDataSets({ globalStoragePath: configurationRoot });
  const selected = candidates.find((candidate) => candidate.selected);
  // This process holds SQLite locks on the selected database: never copy a hard link of it.
  const openFiles = selected ? await fileIdentities(createRuntimeRootPaths(selected.runtimeDataRootPath).databasePath) : [];
  const entries: ForeignRuntimeHistoryEntry[] = [];
  for (const entry of found) {
    entries.push(await inspectOne(configurationRoot, entry, openFiles));
    input.onProgress?.(entries.length, found.length);
  }
  relate(entries, candidates);
  return { configurationRootPath: configurationRoot, checkedAt: new Date().toISOString(), entries };
}

/** Storage of a verified foreign root: its located tree, walked once; its identity must hold throughout. */
export async function inspectForeignRuntimeStorage(
  paths: { globalStoragePath: string },
  root: LocatedRuntimeRoot
): Promise<RuntimeDataSetStorageInspection> {
  const report = await inspectLocatedRuntimeStorage(await relocateRuntimeRoot(paths, root));
  if (!sameLocatedRuntimeRoot(await relocateRuntimeRoot(paths, root), root)) {
    throw new Error('这个外来历史库在统计期间发生了变化，请重试。');
  }
  return report;
}

async function inspectOne(
  configurationRoot: string,
  found: DiscoveredForeignRuntimeRoot,
  openFiles: readonly string[]
): Promise<ForeignRuntimeHistoryEntry> {
  const locatedPath = found.location.dataRootRelativePath.endsWith(VSCODE_RUNTIME_ACTIVE_DIRECTORY)
    ? locatedPaths(found.location).dataRootPath : found.location.containerPath;
  const base: ForeignRuntimeHistoryEntry = { ...found, status: 'unavailable', locatedPath };
  let root: LocatedRuntimeRoot;
  try {
    root = await locateForeignRuntimeRoot(configurationRoot, found.location);
  } catch (error) {
    return { ...base, ...rejected(error), size: await measureTree(measuredPath(found.location)) };
  }
  const identity = {
    id: root.id, recordedDataRootPath: root.recorded.paths.dataRootPath, dataSetId: root.recorded.dataSetId,
    rootInstanceId: root.recorded.rootInstanceId, runtimeKernelEpoch: root.recorded.runtimeKernelEpoch
  };
  try {
    const result = await auditForeignRuntimeRoot(configurationRoot, root, openFiles);
    if (result.outcome === 'failed') return { ...base, ...identity, status: 'failed', code: result.code, reason: result.reason, size: result.size };
    return { ...base, ...identity, status: 'verified', ...result.audit, size: result.size };
  } catch (error) {
    return { ...base, ...identity, ...rejected(error), size: await measureTree(measuredPath(found.location)) };
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

/** Under the foreign claim: the private-snapshot audit (worker), kept per exact file state. */
async function auditForeignRuntimeRoot(
  configurationRoot: string,
  root: LocatedRuntimeRoot,
  openFiles: readonly string[]
): Promise<AuditResult> {
  return withLocatedRuntimeRootFence({ globalStoragePath: configurationRoot }, root, async () => {
    if (root.origin.kind !== 'foreign') throw new TypeError('Not a foreign root.');
    const current = await locateForeignRuntimeRoot(configurationRoot, root.origin.location);
    if (!sameLocatedRuntimeRoot(current, root)) {
      throw new ForeignRuntimeHistoryRejection('unavailable', 'foreign-history-changed', '核验期间它发生了变化，稍后再试。');
    }
    const identities = await fileIdentities(current.located.databasePath);
    if (identities.some((identity) => openFiles.includes(identity))) {
      throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-open-database',
        '它的数据库和当前库是同一个文件（硬链接）；为了不破坏当前库的锁，不读取它。');
    }
    const files = await foreignFileState(current);
    const cached = await readAuditCache(configurationRoot, current.id, files);
    if (cached) return cached;
    const result = await auditSnapshot(current);
    const size = await measureTree(path.dirname(current.located.rootPointerPath));
    const complete: AuditResult = size ? { ...result, size } : result;
    await writeAuditCache(configurationRoot, current.id, files, complete).catch(() => undefined);
    return complete;
  });
}

async function auditSnapshot(root: LocatedRuntimeRoot): Promise<AuditResult> {
  for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt += 1) {
    const before = await runtimeDataSetFileState(root.located.databasePath);
    let copy: { databasePath: string; remove(): Promise<void> };
    try { copy = await copyRuntimeSqliteFiles(root.containerRoot, root.located.databasePath); }
    catch (error) { throw classified(error, 'foreign-history-copy-failed', '复制数据库到私有临时目录失败'); }
    try {
      // The copy counts only when the files did not change while it was taken.
      if (await runtimeDataSetFileState(root.located.databasePath) !== before) continue;
      try {
        const audit = await auditRuntimeSnapshot(copy.databasePath, {
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
        if (error instanceof RuntimeSnapshotAuditError && !/SQLITE_(IOERR|FULL|NOMEM|BUSY|CANTOPEN)|disk/i.test(`${error.code ?? ''} ${message}`)) {
          return { outcome: 'failed', code: 'foreign-history-audit-failed', reason: `结构或完整性核验未通过：${message}` };
        }
        throw new ForeignRuntimeHistoryRejection('unavailable', 'foreign-history-audit-unavailable', `核验线程没能完成：${message}`);
      }
    } finally {
      await copy.remove();
    }
  }
  throw new ForeignRuntimeHistoryRejection('unavailable', 'foreign-history-changing', '数据库文件在复制期间一直在变化，暂时无法核验。');
}

/** Old copy of a local data set; identical foreign copies shown once. */
function relate(entries: ForeignRuntimeHistoryEntry[], candidates: readonly VscodeRuntimeDataSetCandidate[]): void {
  const primary = new Map<string, ForeignRuntimeHistoryEntry>();
  for (const entry of entries) {
    if (entry.status !== 'verified') continue;
    const local = candidates.find((candidate) => candidate.dataSetId === entry.dataSetId && candidate.rootInstanceId === entry.rootInstanceId);
    if (local) entry.sameAsLocal = { candidateId: local.id, selected: local.selected };
    const key = `${entry.dataSetId}\0${entry.rootInstanceId}\0${entry.contentDigest}`;
    const first = primary.get(key);
    if (first) entry.duplicateOf = first.id;
    else primary.set(key, entry);
  }
}

function requireStrictLocation(configurationRoot: string, location: ForeignRuntimeRootLocation): void {
  const invalid = (): never => { throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-location', '位置不符合外来历史库的发现规则。'); };
  if (location.kind === 'archive') {
    if (!ARCHIVE_CONTAINER_NAME.test(location.containerName) || location.side !== undefined || location.baseDataRootPath !== undefined
      || location.containerPath !== path.join(configurationRoot, ...location.containerName.split('/'))
      || location.dataRootRelativePath !== (location.containerName.endsWith(VSCODE_RUNTIME_ARCHIVES_DIRECTORY) ? '' : VSCODE_RUNTIME_ACTIVE_DIRECTORY)) invalid();
    return;
  }
  const base = location.baseDataRootPath;
  if (location.kind !== 'copied' || !base || !path.isAbsolute(base) || path.resolve(base) !== base
    || (location.side === 'current') !== isSamePath(base, configurationRoot) || (location.side !== 'current' && location.side !== 'previous')
    || !copiedNamePattern(base).test(location.containerName)
    || location.containerPath !== path.join(path.dirname(base), location.containerName)
    || !COPIED_DATA_ROOT.test(location.dataRootRelativePath)) invalid();
}

function locatedPaths(location: ForeignRuntimeRootLocation) {
  return createRuntimeRootPaths(path.join(location.containerPath, ...location.dataRootRelativePath.split('/')));
}

/** The tree whose size is shown: the located control root, or the whole container. */
function measuredPath(location: ForeignRuntimeRootLocation): string {
  return location.dataRootRelativePath.endsWith(VSCODE_RUNTIME_ACTIVE_DIRECTORY)
    ? path.dirname(locatedPaths(location).rootPointerPath)
    : path.join(location.containerPath, ...location.dataRootRelativePath.split('/').filter(Boolean));
}

function copiedNamePattern(base: string): RegExp {
  const name = path.basename(base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${name}${COPIED_SUFFIX}$`, process.platform === 'win32' ? 'i' : '');
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
async function copiedAsideByRelocation(configurationRoot: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  try {
    const marker = JSON.parse(await readSmallFile(path.join(configurationRoot, DATA_ROOT_RELOCATION_MARKER_FILE))) as {
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
 * last transaction's outcome is unsettled. Both are left to the LimCode that owns them.
 */
async function assertNoUnfinishedRelocationOrMerge(
  configurationRoot: string,
  location: ForeignRuntimeRootLocation,
  recorded: HistoricalRootBinding
): Promise<void> {
  const ledgerRoot = location.kind === 'archive' ? configurationRoot : location.containerPath;
  if (location.kind === 'copied') {
    const markerPath = path.join(location.containerPath, DATA_ROOT_RELOCATION_MARKER_FILE);
    if (await present(markerPath)) {
      let state: unknown;
      try { state = (JSON.parse(await readSmallFile(markerPath)) as { kind?: unknown; state?: unknown } | null)?.state; }
      catch (error) { throw classified(error, 'foreign-history-relocation-record', '迁移记录无法读取'); }
      if (state === 'staging' || state === 'undoing') {
        throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-unfinished-relocation',
          '拷贝时这个目录正处在一次没有完成的数据目录迁移中，内容可能不完整；原样保留。');
      }
    }
  }
  let records;
  try {
    await assertNoSymbolicPath(ledgerRoot, resolveVscodeRuntimeMergeLedgerRoot({ globalStoragePath: ledgerRoot }))
      .catch((error: unknown) => { if (!isMissing(error)) throw error; });
    records = await readRuntimeDataSetMergeLedger({ globalStoragePath: ledgerRoot });
  } catch (error) {
    throw classified(error, 'foreign-history-merge-ledger', '合并记录无法读取');
  }
  for (const record of records.values()) {
    if (record.state !== 'committing') continue;
    const names = [record.source, record.target].some((identity) =>
      identity.dataSetId === recorded.dataSetId && identity.rootInstanceId === recorded.rootInstanceId);
    if (names) {
      throw new ForeignRuntimeHistoryRejection('failed', 'foreign-history-unfinished-merge',
        '它参与的一次合并还没有确认是否写入完成；只能由原来的 LimCode 收尾，原样保留。');
    }
  }
}

async function readAuditCache(configurationRoot: string, id: string, files: string): Promise<AuditResult | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(await foreignRuntimeHistoryFile(configurationRoot, CACHE_DIRECTORY, id, '.json'), 'utf8')) as {
      kind?: unknown; id?: unknown; files?: unknown; result?: AuditResult;
    } | null;
    if (value?.kind !== CACHE_KIND || value.id !== id || value.files !== files || !value.result) return undefined;
    const result = value.result;
    if (result.outcome === 'verified' && result.audit && typeof result.audit === 'object') return result;
    if (result.outcome === 'failed' && typeof result.code === 'string' && typeof result.reason === 'string') return result;
    return undefined;
  } catch {
    return undefined;
  }
}

async function writeAuditCache(configurationRoot: string, id: string, files: string, result: AuditResult): Promise<void> {
  const file = await foreignRuntimeHistoryFile(configurationRoot, CACHE_DIRECTORY, id, '.json');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify({ kind: CACHE_KIND, id, files, checkedAt: new Date().toISOString(), result })}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
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
async function foreignFileState(root: LocatedRuntimeRoot): Promise<string> {
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

/** dev:ino of a database and its WAL (stat only: no descriptor is opened). */
async function fileIdentities(databasePath: string): Promise<string[]> {
  const result: string[] = [];
  for (const file of [databasePath, `${databasePath}-wal`]) {
    const stat = await fs.stat(file, { bigint: true }).catch(() => undefined);
    if (stat) result.push(`${stat.dev}:${stat.ino}`);
  }
  return result;
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

async function readSmallFile(file: string): Promise<string> {
  const info = await fs.lstat(file);
  if (!info.isFile()) throw new Error(`${file} is not a regular file.`);
  if (info.size > MAX_SMALL_JSON_BYTES) throw new Error(`${file} is too large.`);
  return fs.readFile(file, 'utf8');
}

async function present(file: string): Promise<boolean> {
  return (await lstatIfPresent(file)) !== undefined;
}

async function lstatIfPresent(file: string) {
  try { return await fs.lstat(file); }
  catch (error) { if (isMissing(error)) return undefined; throw error; }
}

async function guard(
  status: 'failed' | 'unavailable',
  code: string,
  message: string,
  check: () => Promise<void>
): Promise<void> {
  try { await check(); }
  catch (error) {
    const errno = (error as NodeJS.ErrnoException | undefined)?.code;
    if (errno && TRANSIENT_CODES.has(errno)) throw classified(error, code, message.replace(/。$/, ''));
    throw new ForeignRuntimeHistoryRejection(status, code, message);
  }
}

/** A deterministic problem is "failed"; space, I/O and permission errors of the moment are "unavailable". */
function classified(error: unknown, code: string, label: string): ForeignRuntimeHistoryRejection {
  if (error instanceof ForeignRuntimeHistoryRejection) return error;
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  const detail = error instanceof Error ? error.message : String(error);
  if (errno && TRANSIENT_CODES.has(errno)) {
    return new ForeignRuntimeHistoryRejection('unavailable', code, `暂时无法核验：${label}（${detail}）。`);
  }
  return new ForeignRuntimeHistoryRejection('failed', code, `${label}：${detail}`);
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
