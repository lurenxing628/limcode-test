import * as fs from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createCachedProcessClassifier, delay, isolateDeadClaimRecord, ownProcessStartIdentity, readClaimRecord, releaseClaimRecord, tryPublishClaimRecord } from './runtimeClaimPrimitives';
import { isCanonicalPathInside, isSamePath } from '../capabilities/filesystem/pathContainment';
import { realPath } from '../capabilities/filesystem/realPath';

/** Immutable planning evidence carried in proposal/effect CAS, never in a mutable environment row. */
export interface FilePlanningRoot {
  canonicalPath: string;
  device: string;
  inode: string;
}

export class FilePathConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'FilePathConflictError';
  }
}

/** Separates lock admission failures from already-started filesystem mutation uncertainty. */
export class FileMutationNotStartedError extends Error {
  public constructor(public readonly cause: unknown) {
    super('File mutation did not acquire its target claim.');
    this.name = 'FileMutationNotStartedError';
  }
}

export async function captureFilePlanningRoot(rootPath: string): Promise<FilePlanningRoot> {
  const canonicalPath = await realPath(path.resolve(rootPath));
  const stat = await fs.lstat(canonicalPath, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new FilePathConflictError('WorkEnvironment root is not a real directory.');
  return { canonicalPath, device: stat.dev.toString(), inode: stat.ino.toString() };
}

export function normalizeFilePlanningRoot(value: unknown): FilePlanningRoot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('File proposal requires planningRoot identity.');
  const root = value as Record<string, unknown>;
  if (typeof root.canonicalPath !== 'string' || !path.isAbsolute(root.canonicalPath)
    || path.resolve(root.canonicalPath) !== root.canonicalPath
    || typeof root.device !== 'string' || !/^\d+$/.test(root.device)
    || typeof root.inode !== 'string' || !/^\d+$/.test(root.inode)) {
    throw new TypeError('Invalid file planningRoot identity.');
  }
  return { canonicalPath: root.canonicalPath, device: root.device, inode: root.inode };
}

export async function assertFilePlanningRoot(rootPath: string, expected: FilePlanningRoot): Promise<void> {
  let current: FilePlanningRoot;
  try { current = await captureFilePlanningRoot(rootPath); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
      throw new FilePathConflictError('WorkEnvironment root identity is no longer available after file planning.');
    }
    throw error;
  }
  if (current.canonicalPath !== expected.canonicalPath || current.device !== expected.device || current.inode !== expected.inode) {
    throw new FilePathConflictError('WorkEnvironment root identity changed after file planning.');
  }
}

/** Root aliases are supported. Descendant links are rejected before any content read or mutation. */
export async function resolveFileTarget(
  root: FilePlanningRoot,
  targetPath: string,
  allowMissingParents = false
): Promise<string> {
  const target = path.resolve(root.canonicalPath, targetPath);
  if (target === root.canonicalPath || !isCanonicalPathInside(root.canonicalPath, target)) {
    throw new FilePathConflictError('File target escapes the registered WorkEnvironment boundary.');
  }
  const components = path.relative(root.canonicalPath, target).split(path.sep);
  let current = root.canonicalPath;
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new FilePathConflictError(`Symbolic-link file path components are not allowed: ${current}`);
      if (index < components.length - 1 && !stat.isDirectory()) throw new FilePathConflictError('File target parent is not a directory.');
      const canonical = await realPath(current);
      if (!isSamePath(canonical, current) || !isCanonicalPathInside(root.canonicalPath, canonical)) {
        throw new FilePathConflictError('File target no longer resolves inside its planned boundary.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      if (!allowMissingParents && index !== components.length - 1) throw new FilePathConflictError('File target parent does not exist.');
      break;
    }
  }
  return target;
}

/**
 * Planning may follow directory aliases only while every canonical ancestor stays in the root.
 * Freeze their physical relative target in the proposal; later dispatch never resolves that alias
 * again. Final-component links remain forbidden, including links to another in-root file.
 */
export async function resolvePlanningFileTarget(root: FilePlanningRoot, targetPath: string): Promise<string> {
  const lexical = path.resolve(root.canonicalPath, targetPath);
  if (lexical === root.canonicalPath || !isCanonicalPathInside(root.canonicalPath, lexical)) {
    throw new FilePathConflictError('File target escapes the registered WorkEnvironment boundary.');
  }
  const components = path.relative(root.canonicalPath, lexical).split(path.sep);
  let current = root.canonicalPath;
  for (let index = 0; index < components.length; index += 1) {
    const candidate = path.join(current, components[index]);
    let stat;
    try { stat = await fs.lstat(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      return path.join(candidate, ...components.slice(index + 1));
    }
    const final = index === components.length - 1;
    if (final && stat.isSymbolicLink()) throw new FilePathConflictError('Symbolic-link file targets are not allowed.');
    if (!final && !stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new FilePathConflictError('File target parent is not a directory.');
    }
    const canonical = await realPath(candidate);
    if (!isCanonicalPathInside(root.canonicalPath, canonical)) {
      throw new FilePathConflictError('Symbolic-link file path components are not allowed outside the WorkEnvironment boundary.');
    }
    if (!final && !(await fs.lstat(canonical)).isDirectory()) throw new FilePathConflictError('File target parent is not a directory.');
    current = canonical;
  }
  return current;
}

export function fileStateIdentity(stat: BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

/** Compare a pathname snapshot with a descriptor, without reducing same-interface fences. */
export function fileDescriptorMatchesPathState(
  expected: BigIntStats | undefined,
  opened: BigIntStats,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (!expected?.isFile() || !opened.isFile()) return false;
  // Older Windows libuv returns a 64-bit volume serial from GetFileInformationByName,
  // but only its low 32 bits from NtQueryVolumeInformationFile for an open handle.
  // https://github.com/libuv/libuv/commit/82cdfb75f
  const sameDevice = expected.dev === opened.dev || (platform === 'win32'
    && expected.dev > 0xffff_ffffn && opened.dev >= 0n && opened.dev <= 0xffff_ffffn
    && BigInt.asUintN(32, expected.dev) === opened.dev);
  return sameDevice && expected.ino === opened.ino && expected.mode === opened.mode
    && expected.size === opened.size && expected.mtimeNs === opened.mtimeNs && expected.ctimeNs === opened.ctimeNs;
}

/**
 * A verified pathname is not a descriptor. Open without following the final link/nonblocking
 * where supported, then reject a different identity or non-regular descriptor before any read.
 * Boundaries and both descriptor/path state are rechecked; external writes after a fence still
 * cannot be excluded atomically by portable Node APIs.
 */
export async function readFileWithIdentityFence(
  target: string,
  expected: BigIntStats,
  checkBoundary: () => Promise<unknown>,
  signal?: AbortSignal
): Promise<Buffer> {
  signal?.throwIfAborted();
  await checkBoundary();
  let handle: fs.FileHandle;
  try { handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    if (['ELOOP', 'ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
      throw new FilePathConflictError('File target changed before its read descriptor opened.');
    }
    throw error;
  }
  try {
    const identity = fileStateIdentity(expected);
    const opened = await handle.stat({ bigint: true });
    if (!fileDescriptorMatchesPathState(expected, opened)) {
      throw new FilePathConflictError('Opened file target identity or type changed before reading.');
    }
    const descriptorIdentity = fileStateIdentity(opened);
    await checkBoundary();
    signal?.throwIfAborted();
    const bytes = await handle.readFile({ signal });
    if (fileStateIdentity(await handle.stat({ bigint: true })) !== descriptorIdentity) {
      throw new FilePathConflictError('File target changed while its descriptor was read.');
    }
    await checkBoundary();
    if (fileStateIdentity(await fs.lstat(target, { bigint: true })) !== identity) {
      throw new FilePathConflictError('File target path identity changed while reading.');
    }
    return bytes;
  } finally { await handle.close(); }
}

/**
 * Serialize overlapping mutations across dispatcher instances in this host. No portable Node
 * primitive offers atomic content CAS against external writers. The active root-claim registry
 * below also serializes cooperating window processes with equal or nested workspace roots.
 * Final identity/content fences detect observed external changes but cannot exclude their races.
 */
const pendingTargets: Array<{ targets: string[]; completed: Promise<void> }> = [];
export async function withFileMutationTargets<T>(
  inputs: Array<{ root: FilePlanningRoot; target: string }>,
  run: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const targets = inputs.map(input => input.target);
  const overlaps = (left: string, right: string) => isCanonicalPathInside(left, right) || isCanonicalPathInside(right, left);
  const prior = pendingTargets.filter(entry => entry.targets.some(left => targets.some(right => overlaps(left, right))));
  let release!: () => void;
  const entry = { targets, completed: new Promise<void>(resolve => { release = resolve; }) };
  pendingTargets.push(entry);
  let started = false;
  try {
    await waitForPendingTargets(Promise.all(prior.map(item => item.completed)), signal);
    const roots = [...new Map(inputs.map(input => [JSON.stringify(input.root), input.root])).values()]
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    return await withWorkspaceMutationClaim(roots, () => { started = true; return run(); }, signal);
  } catch (error) {
    if (!started) throw new FileMutationNotStartedError(error);
    throw error;
  } finally {
    pendingTargets.splice(pendingTargets.indexOf(entry), 1);
    release();
  }
}

async function waitForPendingTargets(pending: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) { await pending; return; }
  let abort!: () => void;
  try {
    await Promise.race([pending, new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason ?? new Error('File mutation cancelled while waiting for a target.'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { signal.removeEventListener('abort', abort); }
}

interface FileMutationClaim {
  kind: 'file-mutation-admission' | 'file-mutation-active';
  ownerToken: string;
  processId: number;
  processStartIdentity?: string;
  roots: FilePlanningRoot[];
}

function parseFileMutationClaim(value: unknown): FileMutationClaim | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as FileMutationClaim;
  try {
    if (!['file-mutation-admission', 'file-mutation-active'].includes(record.kind)
      || typeof record.ownerToken !== 'string' || !record.ownerToken
      || !Number.isSafeInteger(record.processId) || record.processId <= 0
      || (record.processStartIdentity !== undefined && (typeof record.processStartIdentity !== 'string' || !record.processStartIdentity))
      || !Array.isArray(record.roots)
      || (record.kind === 'file-mutation-active' && record.roots.length === 0)
      || (record.kind === 'file-mutation-admission' && record.roots.length !== 0)) return undefined;
    return { ...record, roots: record.roots.map(normalizeFilePlanningRoot) };
  } catch { return undefined; }
}

async function withWorkspaceMutationClaim<T>(roots: FilePlanningRoot[], run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  // Coordination artifacts are ephemeral and never modify an approved workspace or Runtime schema.
  const namespace = path.join(os.tmpdir(), `limcode-file-mutations-${process.getuid?.() ?? 'user'}`);
  const activeDirectory = path.join(namespace, 'active');
  await fs.mkdir(activeDirectory, { recursive: true, mode: 0o700 });
  const ownerToken = randomUUID();
  const claimPath = path.join(activeDirectory, ownerToken);
  const metadata = mutationClaim('file-mutation-active', roots, ownerToken);
  const invalid = () => new FilePathConflictError('File mutation lock owner cannot be verified; refusing lock admission.');
  const classify = createCachedProcessClassifier();
  const deadline = Date.now() + 30_000;
  for (;;) {
    signal?.throwIfAborted();
    let published = false;
    let admitted: boolean;
    try {
    admitted = await withMutationAdmission(namespace, deadline, signal, async () => {
      const names = await fs.readdir(activeDirectory);
      for (const name of names) {
        // Candidates and fenced generation tombstones are never authoritative active claims.
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)) continue;
        const otherPath = path.join(activeDirectory, name);
        const other = await readClaimRecord(otherPath, 'owner.json', parseFileMutationClaim, invalid);
        if (!other) continue;
        if (other.kind !== 'file-mutation-active' || other.ownerToken !== name) throw invalid();
        const overlap = other.roots.some(left => roots.some(right =>
          isCanonicalPathInside(left.canonicalPath, right.canonicalPath)
          || isCanonicalPathInside(right.canonicalPath, left.canonicalPath)));
        if (!overlap) continue;
        const state = classify(other.processId, other.processStartIdentity);
        if (state === 'unknown') throw invalid();
        if (state === 'alive') return false;
        await isolateDeadClaimRecord(otherPath, 'owner.json', other.ownerToken, parseFileMutationClaim, invalid);
      }
      if (!await tryPublishClaimRecord(claimPath, 'owner.json', JSON.stringify(metadata))) throw invalid();
      published = true;
      return true;
    });
    } catch (error) {
      // No workspace operation has started. Remove only our exact token if registry admission
      // release failed after publication; never leave a live active owner that no callback owns.
      if (published) await releaseClaimRecord(claimPath, 'owner.json', metadata.ownerToken, parseFileMutationClaim, invalid, invalid)
        .catch(() => undefined);
      throw error;
    }
    if (admitted) break;
    if (Date.now() >= deadline) throw new FilePathConflictError('Timed out waiting for an overlapping workspace file mutation.');
    await delay(25);
  }
  try { return await run(); }
  finally {
    // Cleanup does not inherit cancellation: a live owner must release its exact active claim.
    await withMutationAdmission(namespace, Date.now() + 30_000, undefined, () =>
      releaseClaimRecord(claimPath, 'owner.json', metadata.ownerToken, parseFileMutationClaim, invalid, invalid));
  }
}

function mutationClaim(kind: FileMutationClaim['kind'], roots: FilePlanningRoot[], ownerToken = randomUUID()): FileMutationClaim {
  return { kind, ownerToken, processId: process.pid, roots,
    ...(ownProcessStartIdentity() ? { processStartIdentity: ownProcessStartIdentity() } : {}) };
}

/** Only registry admission/release holds this global claim; workspace reads and writes never do. */
async function withMutationAdmission<T>(namespace: string, deadline: number, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  const claimPath = path.join(namespace, 'admission');
  const metadata = mutationClaim('file-mutation-admission', []);
  const invalid = () => new FilePathConflictError('File mutation admission owner cannot be verified.');
  const classify = createCachedProcessClassifier();
  for (;;) {
    signal?.throwIfAborted();
    if (await tryPublishClaimRecord(claimPath, 'owner.json', JSON.stringify(metadata))) break;
    const owner = await readClaimRecord(claimPath, 'owner.json', parseFileMutationClaim, invalid);
    if (!owner) continue;
    if (owner.kind !== 'file-mutation-admission') throw invalid();
    const state = classify(owner.processId, owner.processStartIdentity);
    if (state === 'unknown') throw invalid();
    if (state === 'dead') {
      await isolateDeadClaimRecord(claimPath, 'owner.json', owner.ownerToken, parseFileMutationClaim, invalid);
      continue;
    }
    if (Date.now() >= deadline) throw new FilePathConflictError('Timed out waiting for file mutation admission.');
    await delay(25);
  }
  try { return await run(); }
  finally { await releaseClaimRecord(claimPath, 'owner.json', metadata.ownerToken, parseFileMutationClaim, invalid, invalid); }
}
