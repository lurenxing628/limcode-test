import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { WorkEnvironmentRecord } from '../../shared/protocol';
import {
  isLocalFolderWorkEnvironment,
  isRemoteServerWorkEnvironment,
  workEnvironmentDisplayName
} from '../../shared/workEnvironmentCatalog';
import type {
  CommandRunObserver,
  WorkEnvironmentRuntimeCapability,
  WorkEnvironmentTransferContext,
  WorkEnvironmentTransferItem,
  WorkEnvironmentTransferResult,
  WorkEnvironmentTransferVerifyMode
} from './types';
import {
  executeRemoteServerScript,
  openRemoteServerReadStream,
  openRemoteServerWriteStream,
  remoteHomeFor,
  remoteProjectRootPath,
  resolveRemotePath,
  shQuote,
  spawnRemoteServerScript
} from './workEnvironmentProvider';
import { isPathInside } from './filesystem/pathContainment';
import { realPath } from './filesystem/realPath';

const STREAM_HIGH_WATER_MARK = 1024 * 1024;
const PROGRESS_THROTTLE_MS = 1000;

type TransferKind = 'auto' | 'file' | 'directory';
type ResolvedKind = 'file' | 'directory';

interface StatInfo {
  type: ResolvedKind;
  size: number;
}

interface DirEntry {
  name: string;
  type: ResolvedKind;
  size?: number;
}

interface StreamHandle {
  stream: Readable | Writable;
  done?: () => Promise<void>;
}

interface Endpoint {
  environment: WorkEnvironmentRecord;
  resolvePath(input: string): Promise<string>;
  normalize(p: string): string;
  dirname(p: string): string;
  basename(p: string): string;
  join(dir: string, child: string): string;
  stat(p: string): Promise<StatInfo>;
  exists(p: string): Promise<boolean>;
  mkdirp(p: string): Promise<void>;
  readdir(p: string): Promise<DirEntry[]>;
  unlink(p: string): Promise<void>;
  rename(src: string, dst: string, overwrite: boolean): Promise<void>;
  openRead(p: string): Promise<StreamHandle & { stream: Readable }>;
  openWrite(p: string, overwrite: boolean): Promise<StreamHandle & { stream: Writable }>;
}

interface TransferPathPolicy {
  allowOutsideProjectPaths: boolean;
}

type TransferPathIntent = 'read' | 'write';


interface TransferProgressTracker {
  observer?: CommandRunObserver;
  startedAt: number;
  prevReportTs: number;
  prevReportBytes: number;
  lastSpeed: number;
  totalBytes: number;
  totalFiles: number;
  totalKnown: boolean;
  transferredBytes: number;
  completedFiles: number;
  currentSourcePath?: string;
  currentTargetPath?: string;
  lastReportTs: number;
}

interface NormalizedTransferItem extends WorkEnvironmentTransferItem {
  type: TransferKind;
  overwrite: boolean;
  createDirs: boolean;
}

export function createWorkEnvironmentRuntimeCapability(): WorkEnvironmentRuntimeCapability {
  return {
    transferFiles(args, observer, context) {
      return transferFiles(args, observer, context ?? {});
    }
  };
}

async function transferFiles(
  args: { transfers?: WorkEnvironmentTransferItem[]; verify?: WorkEnvironmentTransferVerifyMode },
  observer: CommandRunObserver | undefined,
  context: WorkEnvironmentTransferContext
): Promise<WorkEnvironmentTransferResult> {
  context.signal?.throwIfAborted();
  const items = normalizeTransfers(args);
  if (items.length === 0) throw new Error('transfer: 请提供 transfers 数组，且每项包含 fromEnvironment/fromPath/toEnvironment/toPath。');
  const verify: WorkEnvironmentTransferVerifyMode = args.verify === 'none' ? 'none' : 'size';
  const results: WorkEnvironmentTransferResult['results'] = [];
  let successCount = 0;
  let failCount = 0;

  for (let index = 0; index < items.length; index += 1) {
    context.signal?.throwIfAborted();
    const item = items[index];
    const started = Date.now();
    try {
      const result = await runTransfer(item, verify, observer, context, index);
      results.push({ ...result, durationMs: Date.now() - started });
      successCount += 1;
    } catch (error) {
      if (context.signal?.aborted) throw context.signal.reason ?? error;
      results.push({
        success: false,
        index,
        type: item.type,
        from: { environment: item.fromEnvironment, path: item.fromPath },
        to: { environment: item.toEnvironment, path: item.toPath },
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started
      });
      failCount += 1;
    }
  }

  return { results, successCount, failCount, totalCount: items.length };
}

function normalizeTransfers(args: { transfers?: WorkEnvironmentTransferItem[] }): NormalizedTransferItem[] {
  const rawList = Array.isArray(args.transfers) ? args.transfers : [];
  const result: NormalizedTransferItem[] = [];
  for (const raw of rawList) {
    if (!raw || typeof raw !== 'object') continue;
    const fromEnvironment = normalizeString(raw.fromEnvironment);
    const fromPath = normalizeString(raw.fromPath);
    const toEnvironment = normalizeString(raw.toEnvironment);
    const toPath = normalizeString(raw.toPath);
    if (!fromEnvironment || !fromPath || !toEnvironment || !toPath) continue;
    const type = raw.type === 'file' || raw.type === 'directory' ? raw.type : 'auto';
    result.push({
      fromEnvironment,
      fromPath,
      toEnvironment,
      toPath,
      type,
      overwrite: raw.overwrite === true,
      createDirs: raw.createDirs !== false
    });
  }
  return result;
}

async function runTransfer(
  item: NormalizedTransferItem,
  verify: WorkEnvironmentTransferVerifyMode,
  observer: CommandRunObserver | undefined,
  context: WorkEnvironmentTransferContext,
  index: number
): Promise<WorkEnvironmentTransferResult['results'][number]> {
  context.signal?.throwIfAborted();
  const pathPolicy: TransferPathPolicy = { allowOutsideProjectPaths: context.allowOutsideProjectPaths !== false };
  const from = createEndpoint(resolveEnvironment(item.fromEnvironment, context), context.signal, pathPolicy);
  const to = createEndpoint(resolveEnvironment(item.toEnvironment, context), context.signal, pathPolicy);

  const sourcePath = await from.resolvePath(item.fromPath);
  let targetPath = await to.resolvePath(item.toPath);
  const sourceStat = await from.stat(sourcePath);
  const kind: ResolvedKind = item.type === 'auto'
    ? (hasTrailingSlash(item.fromPath) ? 'directory' : sourceStat.type)
    : item.type;

  if (kind === 'file' && hasTrailingSlash(item.toPath)) targetPath = to.join(targetPath, from.basename(sourcePath));

  if (kind === 'file') {
    const tracker = createTransferTracker(observer, { files: 1, bytes: sourceStat.size }, true);
    reportTransferProgress(tracker, false, true);
    const copied = await copyFile({ from, to, sourcePath, targetPath, overwrite: item.overwrite, createDirs: item.createDirs, verify, tracker, knownSize: sourceStat.size, signal: context.signal });
    reportTransferProgress(tracker, true, true);
    return {
      success: true,
      index,
      type: 'file',
      from: { environment: item.fromEnvironment, path: item.fromPath },
      to: { environment: item.toEnvironment, path: item.toPath },
      files: 1,
      dirs: 0,
      bytes: copied.bytes,
      verify: { mode: verify, ok: copied.verifyOk },
      durationMs: 0
    };
  }

  const tracker = createTransferTracker(observer, { files: 0, bytes: 0 }, false);
  reportTransferProgress(tracker, false, true);
  const copied = await copyDirectory({ from, to, sourceDir: sourcePath, targetDir: targetPath, overwrite: item.overwrite, createDirs: item.createDirs, verify, tracker, mkdirCache: new Set<string>(), signal: context.signal });
  reportTransferProgress(tracker, true, true);
  return {
    success: true,
    index,
    type: 'directory',
    from: { environment: item.fromEnvironment, path: item.fromPath },
    to: { environment: item.toEnvironment, path: item.toPath },
    files: copied.files,
    dirs: copied.dirs,
    bytes: copied.bytes,
    verify: { mode: verify, ok: copied.verifyOk },
    durationMs: 0
  };
}

/**
 * The model boundary resolves W# to a work environment ID and passes `current` through; those are
 * the only selectors. Names are not identities and are never matched.
 */
function resolveEnvironment(selector: string, context: WorkEnvironmentTransferContext): WorkEnvironmentRecord {
  if (selector === 'current') {
    if (!context.activeWorkEnvironment) throw new Error('当前没有 active 工作环境。');
    return context.activeWorkEnvironment;
  }
  const candidates = context.availableWorkEnvironments ?? [];
  const found = candidates.find((environment) => environment.id === selector);
  if (!found) throw new Error(`未知或当前策略不允许使用工作环境：${selector}`);
  return found;
}

function createEndpoint(environment: WorkEnvironmentRecord, signal: AbortSignal | undefined, policy: TransferPathPolicy): Endpoint {
  if (isLocalFolderWorkEnvironment(environment)) return new LocalEndpoint(environment, signal, policy);
  if (isRemoteServerWorkEnvironment(environment)) return new RemoteCommandEndpoint(environment, signal, policy);
  throw new Error(`工作环境 ${workEnvironmentDisplayName(environment)} (${environment.kind}) 暂未接入文件传输 provider。`);
}

async function copyDirectory(input: {
  from: Endpoint;
  to: Endpoint;
  sourceDir: string;
  targetDir: string;
  overwrite: boolean;
  createDirs: boolean;
  verify: WorkEnvironmentTransferVerifyMode;
  tracker: TransferProgressTracker;
  mkdirCache: Set<string>;
  signal?: AbortSignal;
}): Promise<{ files: number; dirs: number; bytes: number; verifyOk: boolean }> {
  const { from, to, sourceDir, targetDir, overwrite, createDirs, verify, tracker, mkdirCache, signal } = input;
  signal?.throwIfAborted();
  if (createDirs) await mkdirpCached(to, targetDir, mkdirCache);
  const entries = await from.readdir(sourceDir);
  let files = 0;
  let dirs = 1;
  let bytes = 0;
  let verifyOk = true;

  for (const entry of entries) {
    signal?.throwIfAborted();
    const childSource = from.join(sourceDir, entry.name);
    const childTarget = to.join(targetDir, entry.name);
    if (entry.type === 'directory') {
      const nested = await copyDirectory({ from, to, sourceDir: childSource, targetDir: childTarget, overwrite, createDirs, verify, tracker, mkdirCache, signal });
      files += nested.files;
      dirs += nested.dirs;
      bytes += nested.bytes;
      verifyOk = verifyOk && nested.verifyOk;
    } else {
      const copied = await copyFile({ from, to, sourcePath: childSource, targetPath: childTarget, overwrite, createDirs, verify, tracker, knownSize: entry.size, mkdirCache, signal });
      files += 1;
      bytes += copied.bytes;
      verifyOk = verifyOk && copied.verifyOk;
    }
  }
  return { files, dirs, bytes, verifyOk };
}

async function copyFile(input: {
  from: Endpoint;
  to: Endpoint;
  sourcePath: string;
  targetPath: string;
  overwrite: boolean;
  createDirs: boolean;
  verify: WorkEnvironmentTransferVerifyMode;
  tracker: TransferProgressTracker;
  knownSize?: number;
  mkdirCache?: Set<string>;
  signal?: AbortSignal;
}): Promise<{ bytes: number; verifyOk: boolean }> {
  const { from, to, sourcePath, targetPath, overwrite, createDirs, verify, tracker, knownSize, mkdirCache, signal } = input;
  signal?.throwIfAborted();
  const sourceSize = knownSize !== undefined ? knownSize : (await from.stat(sourcePath)).size;
  if (!overwrite && await to.exists(targetPath)) throw new Error(`目标已存在: ${targetPath}`);
  if (createDirs) {
    const dir = to.dirname(targetPath);
    if (mkdirCache) await mkdirpCached(to, dir, mkdirCache);
    else await to.mkdirp(dir);
  }
  const tempPath = makeTempPath(to, targetPath);
  tracker.currentSourcePath = sourcePath;
  tracker.currentTargetPath = targetPath;
  try {
    await copyFileViaStream(from, to, sourcePath, tempPath, tracker, signal);
    signal?.throwIfAborted();
    let verifyOk = true;
    if (verify === 'size') {
      const tempStat = await to.stat(tempPath);
      verifyOk = tempStat.type === 'file' && tempStat.size === sourceSize;
      if (!verifyOk) throw new Error(`size 校验失败: source=${sourceSize}, temp=${tempStat.size}`);
    }
    signal?.throwIfAborted();
    await to.rename(tempPath, targetPath, overwrite);
    tracker.completedFiles += 1;
    reportTransferProgress(tracker, false, false);
    return { bytes: sourceSize, verifyOk };
  } catch (error) {
    await safeUnlink(to, tempPath);
    throw error;
  }
}

async function copyFileViaStream(
  from: Endpoint,
  to: Endpoint,
  sourcePath: string,
  tempPath: string,
  tracker: TransferProgressTracker,
  signal?: AbortSignal
): Promise<void> {
  const progress = new Transform({
    highWaterMark: STREAM_HIGH_WATER_MARK,
    transform(chunk, _encoding, callback) {
      const size = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      tracker.transferredBytes += size;
      callback(null, chunk);
    }
  });
  const reader = await from.openRead(sourcePath);
  const writer = await to.openWrite(tempPath, false);
  const timer = setInterval(() => reportTransferProgress(tracker, false, false), PROGRESS_THROTTLE_MS);
  try {
    await pipeline(reader.stream, progress, writer.stream, { signal });
    if (reader.done) await reader.done();
    if (writer.done) await writer.done();
  } finally {
    clearInterval(timer);
  }
}

function createTransferTracker(observer: CommandRunObserver | undefined, stats: { files: number; bytes: number }, totalKnown: boolean): TransferProgressTracker {
  const now = Date.now();
  return {
    observer,
    startedAt: now,
    prevReportTs: now,
    prevReportBytes: 0,
    lastSpeed: 0,
    totalBytes: stats.bytes,
    totalFiles: stats.files,
    totalKnown,
    transferredBytes: 0,
    completedFiles: 0,
    lastReportTs: 0
  };
}

function reportTransferProgress(tracker: TransferProgressTracker, final: boolean, force: boolean): void {
  const now = Date.now();
  if (!force && now - tracker.lastReportTs < PROGRESS_THROTTLE_MS) return;
  tracker.lastReportTs = now;
  const elapsedMs = Math.max(1, now - tracker.startedAt);
  const dt = now - tracker.prevReportTs;
  const db = tracker.transferredBytes - tracker.prevReportBytes;
  let speedBytesPerSec = tracker.lastSpeed;
  if (final) speedBytesPerSec = tracker.transferredBytes / (elapsedMs / 1000);
  else if (dt >= 500 && db > 0) {
    speedBytesPerSec = db / (dt / 1000);
    tracker.lastSpeed = speedBytesPerSec;
    tracker.prevReportTs = now;
    tracker.prevReportBytes = tracker.transferredBytes;
  }
  const percent = final
    ? 100
    : tracker.totalKnown && tracker.totalBytes > 0
      ? Math.min(99, Math.round((tracker.transferredBytes / tracker.totalBytes) * 100))
      : -1;
  tracker.observer?.onEvent?.({
    kind: 'progress',
    payload: {
      kind: 'transfer',
      sourcePath: tracker.currentSourcePath,
      targetPath: tracker.currentTargetPath,
      bytesTransferred: tracker.transferredBytes,
      totalBytes: tracker.totalKnown ? tracker.totalBytes : undefined,
      percent,
      speedBytesPerSec,
      elapsedMs,
      filesTransferred: tracker.completedFiles,
      totalFiles: tracker.totalKnown ? tracker.totalFiles : undefined
    }
  });
}

async function mkdirpCached(endpoint: Endpoint, p: string, cache: Set<string>): Promise<void> {
  const normalized = endpoint.normalize(p);
  if (cache.has(normalized)) return;
  await endpoint.mkdirp(normalized);
  let current = normalized;
  while (current && current !== '/' && current !== '.' && !cache.has(current)) {
    cache.add(current);
    const parent = endpoint.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function makeTempPath(endpoint: Endpoint, targetPath: string): string {
  const dir = endpoint.dirname(targetPath);
  const base = endpoint.basename(targetPath) || 'target';
  const suffix = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
  return endpoint.join(dir, `.${base}.work-env-tmp-${suffix}`);
}

async function safeUnlink(endpoint: Endpoint, p: string): Promise<void> {
  try { await endpoint.unlink(p); } catch { /* ignore cleanup errors */ }
}

function hasTrailingSlash(p: string): boolean {
  return /[\\/]$/.test(p);
}

function trimTrailingSeparators(p: string, isRemote: boolean): string {
  const root = isRemote ? '/' : path.parse(p).root;
  let out = p;
  while (out.length > root.length && /[\\/]$/.test(out)) out = out.slice(0, -1);
  return out;
}

function localProjectRootPath(environment: WorkEnvironmentRecord): string | undefined {
  const rootPath = normalizeString(environment.rootPath);
  if (rootPath) return path.resolve(rootPath);
  const uri = normalizeString(environment.uri);
  if (!uri) return undefined;
  if (uri.startsWith('file:')) {
    try { return path.resolve(fileURLToPath(uri)); }
    catch { return undefined; }
  }
  return path.resolve(uri);
}

function isAbsoluteLocalPath(input: string): boolean {
  return path.isAbsolute(input) || path.win32.isAbsolute(input) || path.posix.isAbsolute(input);
}

function relativeLocalPath(input: string): string {
  return input.replace(/[\\/]+/g, path.sep);
}

function canonicalLocalPath(input: string): string {
  const normalized = path.resolve(input);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isLocalPathInsideRoot(candidate: string, root: string): boolean {
  return isPathInside(canonicalLocalPath(root), canonicalLocalPath(candidate));
}

function assertLocalPathInsideRoot(candidate: string, root: string): void {
  if (isLocalPathInsideRoot(candidate, root)) return;
  throw new Error(`路径超出当前本地工作环境根目录：${candidate}（root=${root}）`);
}

function isNotFoundError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function realpathNearestExistingLocal(candidate: string): Promise<string> {
  const tail: string[] = [];
  let current = candidate;
  for (;;) {
    try {
      let resolved = await realPath(current);
      for (let index = tail.length - 1; index >= 0; index -= 1) resolved = path.join(resolved, tail[index]);
      return resolved;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}


class LocalEndpoint implements Endpoint {
  private realRootPromise?: Promise<string>;

  public constructor(
    public environment: WorkEnvironmentRecord,
    private readonly signal: AbortSignal | undefined,
    private readonly policy: TransferPathPolicy
  ) {}
  async resolvePath(input: string): Promise<string> {
    const text = normalizeString(input);
    if (!text) throw new Error('本地路径不能为空。');
    const root = localProjectRootPath(this.environment);
    const resolved = isAbsoluteLocalPath(text)
      ? this.normalize(text)
      : root
        ? path.resolve(root, relativeLocalPath(text))
        : undefined;
    if (!resolved) throw new Error(`本地工作环境缺少 rootPath，无法解析相对路径: ${text}`);
    const normalized = this.normalize(resolved);
    if (!this.policy.allowOutsideProjectPaths) {
      if (!root) throw new Error(`本地工作环境缺少 rootPath，无法限制项目外路径：${workEnvironmentDisplayName(this.environment)}`);
      if (!isLocalPathInsideRoot(normalized, root)) {
        // 根目录是符号链接/junction 时，模型可能给出它的真实路径：只换根前缀，不解析目标自身，guardPath 照常复核。
        this.realRootPromise ??= realPath(root);
        const realRoot = await this.realRootPromise;
        if (isLocalPathInsideRoot(normalized, realRoot)) return path.join(root, path.relative(realRoot, normalized));
      }
      assertLocalPathInsideRoot(normalized, root);
    }
    return normalized;
  }
  // allowOutsideProjectPaths=false 时词法检查不足以阻止符号链接逃逸（如 root/link -> 外部目录），
  // 每个 IO 操作都按 fileEffects 的 realpath/lstat 思路复核真实路径：根目录先 realpath（覆盖 root 自身是
  // symlink 的情况），候选路径解析最近现存祖先的真实路径，写操作额外拒绝最终组件是符号链接的目标；
  // 仅当输入路径就是声明的 root 本身时豁免（如 root 是 symlink 时的 mkdirp(root)），root 内其他指向
  // root 的 symlink 不误豁免。
  private async guardPath(p: string, intent: TransferPathIntent): Promise<void> {
    if (this.policy.allowOutsideProjectPaths) return;
    const root = localProjectRootPath(this.environment);
    if (!root) throw new Error(`本地工作环境缺少 rootPath，无法限制项目外路径：${workEnvironmentDisplayName(this.environment)}`);
    assertLocalPathInsideRoot(p, root);
    if (!this.realRootPromise) this.realRootPromise = realPath(root);
    const realRoot = await this.realRootPromise;
    const resolved = await realpathNearestExistingLocal(p);
    if (!isLocalPathInsideRoot(resolved, realRoot)) {
      throw new Error(`路径经符号链接解析后超出当前本地工作环境根目录：${p} -> ${resolved}（root=${realRoot}）`);
    }
    if (intent !== 'write') return;
    if (canonicalLocalPath(p) === canonicalLocalPath(root)) return;
    let stat: fs.Stats | undefined;
    try {
      stat = await fsp.lstat(p);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }
    if (stat?.isSymbolicLink()) throw new Error(`拒绝通过符号链接写入：${p}`);
  }
  normalize(p: string): string { return path.normalize(trimTrailingSeparators(p, false)); }
  dirname(p: string): string { return path.dirname(p); }
  basename(p: string): string { return path.basename(p); }
  join(dir: string, child: string): string { return path.join(dir, child); }
  async stat(p: string): Promise<StatInfo> {
    this.signal?.throwIfAborted();
    await this.guardPath(p, 'read');
    const st = await fsp.stat(p);
    if (st.isDirectory()) return { type: 'directory', size: 0 };
    if (st.isFile()) return { type: 'file', size: st.size };
    throw new Error(`不支持的本地路径类型: ${p}`);
  }
  async exists(p: string): Promise<boolean> {
    this.signal?.throwIfAborted();
    // false 模式下探测本身也受边界约束：guard 在 try/catch 之前抛出策略错误，避免被吞成 false。
    await this.guardPath(p, 'read');
    try { await fsp.stat(p); return true; } catch { return false; }
  }
  async mkdirp(p: string): Promise<void> { this.signal?.throwIfAborted(); await this.guardPath(p, 'write'); await fsp.mkdir(p, { recursive: true }); }
  async readdir(p: string): Promise<DirEntry[]> {
    this.signal?.throwIfAborted();
    await this.guardPath(p, 'read');
    const entries = await fsp.readdir(p, { withFileTypes: true });
    const out: DirEntry[] = [];
    for (const entry of entries) {
      this.signal?.throwIfAborted();
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) out.push({ name: entry.name, type: 'directory' });
      else if (entry.isFile()) out.push({ name: entry.name, type: 'file', size: (await fsp.stat(full)).size });
    }
    return out;
  }
  async unlink(p: string): Promise<void> { await this.guardPath(p, 'write'); await fsp.rm(p, { force: true }); }
  async rename(src: string, dst: string, overwrite: boolean): Promise<void> {
    this.signal?.throwIfAborted();
    await this.guardPath(dst, 'write');
    if (overwrite) await fsp.rm(dst, { force: true });
    await fsp.rename(src, dst);
  }
  async openRead(p: string): Promise<StreamHandle & { stream: Readable }> {
    await this.guardPath(p, 'read');
    return { stream: fs.createReadStream(p, { highWaterMark: STREAM_HIGH_WATER_MARK, signal: this.signal }) };
  }
  async openWrite(p: string, overwrite: boolean): Promise<StreamHandle & { stream: Writable }> {
    await this.guardPath(p, 'write');
    return { stream: fs.createWriteStream(p, { flags: overwrite ? 'w' : 'wx', highWaterMark: STREAM_HIGH_WATER_MARK, signal: this.signal }) };
  }
}

class RemoteCommandEndpoint implements Endpoint {
  /** Login user's home once `~` appears in workdir/rootPath or a path; every path below is absolute after it. */
  private home?: string;
  public constructor(
    public environment: WorkEnvironmentRecord,
    private readonly signal: AbortSignal | undefined,
    private readonly policy: TransferPathPolicy
  ) {}
  async resolvePath(input: string): Promise<string> {
    const text = normalizeString(input);
    if (!text) throw new Error('远端路径不能为空。');
    this.home ??= await remoteHomeFor(this.environment, [text], this.signal);
    const slashed = text.replace(/\\/g, '/');
    const isAbsolute = slashed.startsWith('/') || slashed === '~' || slashed.startsWith('~/');
    const root = remoteProjectRootPath(this.environment, this.home);
    if (!isAbsolute && !root) throw new Error(`远程工作环境缺少 workdir/rootPath，无法解析相对路径: ${text}`);
    return this.normalize(resolveRemotePath(text, this.environment, undefined, {
      allowOutsideProjectPaths: this.policy.allowOutsideProjectPaths,
      home: this.home
    }));
  }
  // allowOutsideProjectPaths=false 时 resolveRemotePath 的词法限制可被符号链接绕过（root/link -> 外部目录），
  // 因此在同一条远程脚本内先用 bash 内建把源、目标父目录链、目标自身解析成真实路径并复核仍在物理根目录内，
  // 再执行原操作；写操作额外拒绝最终组件是符号链接的目标，仅当输入路径就是声明的 root 本身时豁免
  // （覆盖 root 自身是 symlink 时的 mkdirp(root)，root 内其他指向 root 的 symlink 不误豁免）。
  // 路径字节精确性：命令替换会剥尾随换行，pwd -P 用 `&& printf .` 哨兵捕获后只剥哨兵与单个换行（pwd
  // 在 GNU/BSD 都追加换行）；readlink 统一加 -n（GNU 默认追加换行、BSD 不追加，-n 使两边都不追加），
  // 捕获只剥哨兵点，避免误删目标名自带的尾随换行；dirname/basename 用参数展开实现；不存在尾段拼回后由
  // __we_normalize 纯参数展开消除 ./..，避免相对 symlink 目标（如 sub/../../outside）在尾段留下可绕过
  // 前缀比较的 ..。契约：远端为 bash + GNU/BusyBox userland（既有脚本已依赖 `cat --`、`base64`、`wc -c`），
  // 校验与操作在同一脚本内相邻执行，属 time-of-check；root 为 / 时不存在根外路径，词法策略已完备，直接放行。
  private withGuard(body: string, checks: Array<{ path: string; intent: TransferPathIntent }>): string {
    if (this.policy.allowOutsideProjectPaths || checks.length === 0) return body;
    const root = remoteProjectRootPath(this.environment, this.home);
    if (!root || !path.posix.isAbsolute(root)) {
      throw new Error(`当前远程工作环境缺少绝对 workdir/rootPath，无法限制项目外路径：${workEnvironmentDisplayName(this.environment)}`);
    }
    if (root === '/') return body;
    const lines = checks.map((check) => `__we_check ${shQuote(check.path)} ${check.intent}`);
    return `__we_root=${shQuote(root)}
__we_physroot=$(cd -- "$__we_root" 2>/dev/null && pwd -P && printf .) || { echo "transfer: 无法解析远程工作环境根目录: $__we_root" >&2; exit 46; }
__we_physroot=\${__we_physroot%.}
__we_physroot=\${__we_physroot%\$'\\n'}
__we_normalize() {
  local input=$1 out= comp=
  while [ -n "$input" ]; do
    case $input in
      */*) comp=\${input%%/*}; input=\${input#*/} ;;
      *) comp=$input; input= ;;
    esac
    case $comp in
      ""|.) ;;
      ..) out=\${out%/*} ;;
      *) out=$out/$comp ;;
    esac
  done
  __we_normalized=\${out:-/}
}
__we_resolve() {
  local t=$1 rest= l= n=0 dir=
  while :; do
    while [ ! -e "$t" ] && [ ! -L "$t" ]; do
      rest=/\${t##*/}$rest
      t=\${t%/*}
      if [ -z "$t" ]; then t=/; fi
    done
    if [ ! -L "$t" ]; then break; fi
    n=$((n + 1))
    if [ "$n" -gt 40 ]; then return 1; fi
    l=$(readlink -n -- "$t" && printf .) || return 1
    l=\${l%.}
    case $l in
      /*) t=$l ;;
      *) t=\${t%/*}; if [ -z "$t" ]; then t=/; fi; t=\${t%/}/$l ;;
    esac
  done
  if [ -d "$t" ]; then
    __we_resolved=$(cd -- "$t" 2>/dev/null && pwd -P && printf .) || return 1
  else
    dir=\${t%/*}
    if [ -z "$dir" ]; then dir=/; fi
    __we_resolved=$(cd -- "$dir" 2>/dev/null && pwd -P && printf .) || return 1
    rest=/\${t##*/}$rest
  fi
  __we_resolved=\${__we_resolved%.}
  __we_resolved=\${__we_resolved%\$'\\n'}
  __we_normalize "$__we_resolved$rest"
  __we_resolved=$__we_normalized
}
__we_check() {
  local p=$1
  case $p in
    "$__we_root"|"$__we_root"/*) ;;
    *) echo "transfer: 路径超出当前远程工作环境根目录: $p (root=$__we_root)" >&2; exit 45 ;;
  esac
  __we_resolve "$p" || { echo "transfer: 无法解析路径: $p" >&2; exit 46; }
  case $__we_resolved in
    "$__we_physroot"|"$__we_physroot"/*) ;;
    *) echo "transfer: 路径经符号链接解析后超出当前远程工作环境根目录: $p (root=$__we_physroot)" >&2; exit 45 ;;
  esac
  if [ "$2" = "write" ] && [ "$p" != "$__we_root" ] && [ -L "$p" ]; then
    echo "transfer: 拒绝通过符号链接写入: $p" >&2
    exit 45
  fi
}
${lines.join('\n')}
${body}`;
  }
  normalize(p: string): string { return path.posix.normalize(trimTrailingSeparators(p.replace(/\\/g, '/'), true)); }
  dirname(p: string): string { return path.posix.dirname(p); }
  basename(p: string): string { return path.posix.basename(p); }
  join(dir: string, child: string): string { return path.posix.join(dir, child); }
  async stat(p: string): Promise<StatInfo> {
    const script = this.withGuard(`if [ -d ${shQuote(p)} ]; then printf 'directory\t0'; elif [ -f ${shQuote(p)} ]; then printf 'file\t%s' "$(wc -c < ${shQuote(p)})"; else echo 'path not found' >&2; exit 44; fi`, [{ path: p, intent: 'read' }]);
    const result = await executeRemoteServerScript(this.environment, script, { timeout: 30_000, displayCommand: `stat ${p}`, signal: this.signal });
    assertExecOk(result, `stat ${p}`);
    const [type, size] = result.stdout.trim().split('\t');
    if (type === 'directory') return { type: 'directory', size: 0 };
    if (type === 'file') return { type: 'file', size: Number.parseInt(size, 10) || 0 };
    throw new Error(`无法识别远端路径类型: ${p}`);
  }
  async exists(p: string): Promise<boolean> {
    const script = this.withGuard(`[ -e ${shQuote(p)} ]`, [{ path: p, intent: 'read' }]);
    const result = await executeRemoteServerScript(this.environment, script, { timeout: 30_000, displayCommand: `exists ${p}`, signal: this.signal });
    this.signal?.throwIfAborted();
    // 45/46 是 guard 的策略拒绝/解析失败，必须上抛而不是当成“不存在”；其余维持原探测语义。
    if (result.exitCode === 45 || result.exitCode === 46) {
      throw new Error(`exists ${p} 被工作环境边界拒绝: exitCode=${result.exitCode} stderr=${result.stderr}`);
    }
    return result.exitCode === 0;
  }
  async mkdirp(p: string): Promise<void> {
    const script = this.withGuard(`mkdir -p -- ${shQuote(p)}`, [{ path: p, intent: 'write' }]);
    const result = await executeRemoteServerScript(this.environment, script, { timeout: 30_000, displayCommand: `mkdir -p ${p}`, signal: this.signal });
    assertExecOk(result, `mkdir -p ${p}`);
  }
  async readdir(p: string): Promise<DirEntry[]> {
    const script = this.withGuard(`cd -- ${shQuote(p)} && for x in ./* ./.??* ./.?*; do [ -e "$x" ] || continue; name="\${x#./}"; if [ -d "$x" ]; then printf 'd\t%s\t0\0' "$name"; elif [ -f "$x" ]; then size="$(wc -c < "$x" 2>/dev/null || printf '0')"; printf 'f\t%s\t%s\0' "$name" "$size"; fi; done | base64 | tr -d '\n\r'`, [{ path: p, intent: 'read' }]);
    const result = await executeRemoteServerScript(this.environment, script, { timeout: 30_000, displayCommand: `readdir ${p}`, signal: this.signal });
    assertExecOk(result, `readdir ${p}`);
    return decodeNulListFromBase64(result.stdout).map((record) => {
      const [type, name, size] = record.split('\t');
      if (!name) return undefined;
      return { name, type: type === 'd' ? 'directory' : 'file', ...(type === 'f' ? { size: Number.parseInt(size ?? '0', 10) || 0 } : {}) } as DirEntry;
    }).filter((entry): entry is DirEntry => !!entry);
  }
  async unlink(p: string): Promise<void> {
    const script = this.withGuard(`rm -f -- ${shQuote(p)}`, [{ path: p, intent: 'write' }]);
    const result = await executeRemoteServerScript(this.environment, script, { timeout: 30_000, displayCommand: `rm ${p}` });
    assertExecOk(result, `rm -f ${p}`);
  }
  async rename(src: string, dst: string, overwrite: boolean): Promise<void> {
    const script = this.withGuard(overwrite
      ? `mv -f -- ${shQuote(src)} ${shQuote(dst)}`
      : `if [ -e ${shQuote(dst)} ]; then echo 'target exists' >&2; exit 17; fi; mv -- ${shQuote(src)} ${shQuote(dst)}`, [{ path: dst, intent: 'write' }]);
    const result = await executeRemoteServerScript(this.environment, script, { timeout: 30_000, displayCommand: `rename ${src}`, signal: this.signal });
    assertExecOk(result, `rename ${src} -> ${dst}`);
  }
  async openRead(p: string): Promise<StreamHandle & { stream: Readable }> {
    if (this.policy.allowOutsideProjectPaths) {
      const handle = openRemoteServerReadStream(this.environment, p, this.signal);
      return { stream: handle.stdout, done: async () => assertExecOk(await handle.done, `cat ${p}`) };
    }
    const handle = spawnRemoteServerScript(this.environment, this.withGuard(`exec cat -- ${shQuote(p)}`, [{ path: p, intent: 'read' }]), {
      timeout: 0,
      displayCommand: `cat ${p}`,
      captureStdout: false,
      signal: this.signal
    });
    return { stream: handle.stdout, done: async () => assertExecOk(await handle.done, `cat ${p}`) };
  }
  async openWrite(p: string, _overwrite: boolean): Promise<StreamHandle & { stream: Writable }> {
    if (this.policy.allowOutsideProjectPaths) {
      const handle = openRemoteServerWriteStream(this.environment, p, this.signal);
      return { stream: handle.stdin, done: async () => assertExecOk(await handle.done, `write ${p}`) };
    }
    const handle = spawnRemoteServerScript(this.environment, this.withGuard(`exec cat > ${shQuote(p)}`, [{ path: p, intent: 'write' }]), {
      timeout: 0,
      displayCommand: `write ${p}`,
      captureStdout: false,
      closeStdin: false,
      signal: this.signal
    });
    return { stream: handle.stdin, done: async () => assertExecOk(await handle.done, `write ${p}`) };
  }
}

function assertExecOk(result: { exitCode: number | null; killed: boolean; stderr: string }, op: string): void {
  if (result.exitCode === null) throw new Error(`${op} 未进入终态，无法判定执行结果。`);
  if (result.exitCode !== 0 || result.killed) throw new Error(`${op} 失败: exitCode=${result.exitCode} stderr=${result.stderr}`);
}

function decodeNulListFromBase64(stdout: string): string[] {
  const text = Buffer.from(stdout.replace(/\s+/g, ''), 'base64').toString('utf8');
  return text.split('\0').filter(Boolean);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
