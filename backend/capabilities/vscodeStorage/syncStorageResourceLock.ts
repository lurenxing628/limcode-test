import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isFileNotFoundError,
  isTransientFileBusyError,
  retryTransientFileOperationSync,
  sleepSync
} from './syncJson';
import {
  isRetryableWindowsLockGenerationRenameError,
  isRetryableWindowsLockPublicationRenameError
} from './lockRenameErrors';

export interface SyncStorageResourceLockFileMetadata {
  ownerToken: string;
  pid: number;
  createdAt: number;
  resource: string;
}

export interface SyncStorageResourceLockOptions {
  waitMs?: number;
  staleMs?: number;
  pollIntervalMs?: number;
  invalidMetadataWaitMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  lockPath?: string | ((resourcePath: string) => string);
}

interface NormalizedSyncStorageResourceLockOptions {
  waitMs: number;
  staleMs: number;
  pollIntervalMs: number;
  invalidMetadataWaitMs: number;
  maxRetries: number;
  retryDelayMs: number;
  lockPath?: string | ((resourcePath: string) => string);
}

interface AcquiredSyncLockDirectory {
  lockPath: string;
  metadata: SyncStorageResourceLockFileMetadata;
}

type LockDirectorySnapshot =
  | { status: 'missing' }
  | { status: 'empty'; stat: Stats }
  | { status: 'invalid'; stat: Stats; raw: string }
  | { status: 'ok'; stat: Stats; raw: string; metadata: SyncStorageResourceLockFileMetadata };

const OWNER_FILE = 'owner.json';
const DEFAULT_WAIT_MS = 2_000;
const DEFAULT_STALE_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 20;
const DEFAULT_INVALID_METADATA_WAIT_MS = 100;
const DEFAULT_MAX_RETRIES = 6;
const DEFAULT_RETRY_DELAY_MS = 10;

/**
 * Synchronous, cross-process resource lock used by child-process callbacks.
 *
 * A lock is a non-empty directory atomically renamed from a private candidate directory. Stale
 * generations are atomically renamed to a generation-specific quarantine path instead of being
 * unlinked. The quarantine directory is intentionally retained for stale generations: a delayed
 * contender or old owner targeting that generation then collides with the existing destination and
 * cannot rename/delete a newer lock that has reused the canonical path.
 */
export function withSyncStorageResourceLock<T>(resourcePath: string, action: () => T, options: SyncStorageResourceLockOptions = {}): T {
  const normalized = normalizeOptions(options);
  const lock = acquireSyncStorageResourceLock(resourcePath, normalized);
  let actionCompleted = false;
  let actionValue: T | undefined;
  let actionError: unknown;

  try {
    actionValue = action();
    actionCompleted = true;
  } catch (error) {
    actionError = error;
  }

  let releaseError: unknown;
  try {
    releaseSyncStorageResourceLock(lock, normalized);
  } catch (error) {
    releaseError = error;
  }

  if (actionError && releaseError) throw combineErrors('Sync storage resource lock action and release both failed.', [actionError, releaseError]);
  if (actionError) throw actionError;
  if (releaseError) throw releaseError;
  if (!actionCompleted) throw new Error('Sync storage resource lock action did not complete.');
  return actionValue as T;
}

function acquireSyncStorageResourceLock(resourcePath: string, options: NormalizedSyncStorageResourceLockOptions): AcquiredSyncLockDirectory {
  const lockPath = resolveLockPath(resourcePath, options);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const ownerToken = randomUUID();
  const resource = path.resolve(resourcePath);
  const deadline = Date.now() + options.waitMs;

  for (;;) {
    const metadata: SyncStorageResourceLockFileMetadata = { ownerToken, pid: process.pid, createdAt: Date.now(), resource };
    try {
      createLockDirectory(lockPath, metadata, options);
      return { lockPath, metadata };
    } catch (error) {
      if (
        !isAlreadyExistsError(error)
        && !isRetryableWindowsLockPublicationRenameError(error, lockPath, process.platform)
      ) throw error;
      if (recoverExistingLockDirectory(lockPath, options) === 'recovered') continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for sync storage resource lock: ${lockPath}`);
      sleepSync(Math.min(options.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }
}

function releaseSyncStorageResourceLock(lock: AcquiredSyncLockDirectory, options: NormalizedSyncStorageResourceLockOptions): void {
  const snapshot = readLockDirectorySnapshot(lock.lockPath, options);
  if (snapshot.status === 'missing') throw new Error(`Sync storage resource lock disappeared before release: ${lock.lockPath}`);
  if (snapshot.status !== 'ok') throw new Error(`Sync storage resource lock metadata is invalid before release: ${lock.lockPath}`);
  if (snapshot.metadata.ownerToken !== lock.metadata.ownerToken) {
    throw new Error(`Sync storage resource lock owner token mismatch; refusing to delete lock owned by another writer: ${lock.lockPath}`);
  }

  const quarantinePath = generationQuarantinePath(lock.lockPath, `owner-${lock.metadata.ownerToken}`);
  try {
    renameLockGenerationSync(lock.lockPath, quarantinePath, options);
  } catch (error) {
    if (isFileNotFoundError(error) || isAlreadyExistsError(error)) {
      throw new Error(`Sync storage resource lock generation changed before release; newer owner is preserved: ${lock.lockPath}`);
    }
    throw error;
  }

  // No valid contender can classify a younger generation as stale. Clean ordinary short-lived
  // release tombstones, but retain stale-generation tombstones as a permanent fencing token.
  if (Math.max(0, Date.now() - lock.metadata.createdAt) < options.staleMs) {
    removeDirectorySync(quarantinePath, false, options);
  }
}

function normalizeOptions(options: SyncStorageResourceLockOptions): NormalizedSyncStorageResourceLockOptions {
  return {
    waitMs: normalizeNonNegativeInteger(options.waitMs, DEFAULT_WAIT_MS),
    staleMs: normalizeNonNegativeInteger(options.staleMs, DEFAULT_STALE_MS),
    pollIntervalMs: Math.max(1, normalizeNonNegativeInteger(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS)),
    invalidMetadataWaitMs: normalizeNonNegativeInteger(options.invalidMetadataWaitMs, DEFAULT_INVALID_METADATA_WAIT_MS),
    maxRetries: Math.max(1, normalizeNonNegativeInteger(options.maxRetries, DEFAULT_MAX_RETRIES)),
    retryDelayMs: normalizeNonNegativeInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS),
    lockPath: options.lockPath
  };
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function resolveLockPath(resourcePath: string, options: NormalizedSyncStorageResourceLockOptions): string {
  const resolvedResourcePath = path.resolve(resourcePath);
  const lockPath = typeof options.lockPath === 'function'
    ? options.lockPath(resolvedResourcePath)
    : options.lockPath ?? `${resolvedResourcePath}.lock`;
  if (!lockPath || !lockPath.trim()) throw new Error(`Sync storage resource lock path is empty: ${resolvedResourcePath}`);
  return path.resolve(lockPath);
}

function createLockDirectory(
  lockPath: string,
  metadata: SyncStorageResourceLockFileMetadata,
  options: NormalizedSyncStorageResourceLockOptions
): void {
  const candidatePath = `${lockPath}.candidate-${metadata.ownerToken}`;
  removeDirectorySync(candidatePath, true, options);
  fs.mkdirSync(candidatePath);
  let acquired = false;
  try {
    fs.writeFileSync(path.join(candidatePath, OWNER_FILE), `${JSON.stringify(metadata)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(candidatePath, lockPath);
    acquired = true;
  } finally {
    if (!acquired) removeDirectorySync(candidatePath, true, options);
  }
}

type ExistingLockRecovery = 'missing' | 'recovered' | 'held';

function recoverExistingLockDirectory(lockPath: string, options: NormalizedSyncStorageResourceLockOptions): ExistingLockRecovery {
  const observedAt = Date.now();
  const snapshot = readLockDirectorySnapshot(lockPath, options);
  if (snapshot.status === 'missing') return 'missing';
  const ageMs = snapshot.status === 'ok'
    ? Math.max(0, observedAt - snapshot.metadata.createdAt)
    : Math.max(0, observedAt - lockGenerationTimestamp(snapshot.stat));
  const staleAfterMs = snapshot.status === 'ok' ? options.staleMs : options.invalidMetadataWaitMs;
  if (ageMs < staleAfterMs) return 'held';
  // A synchronous critical section has no safe heartbeat opportunity. An old timestamp alone must
  // never fence a paused-but-live writer; otherwise it could resume and overwrite the new owner
  // before noticing the generation mismatch at release. Prefer availability loss over corruption.
  if (snapshot.status === 'ok' && isProcessAlive(snapshot.metadata.pid)) return 'held';

  const generation = snapshot.status === 'ok'
    ? `owner-${snapshot.metadata.ownerToken}`
    : invalidGenerationFingerprint(snapshot.stat);
  const quarantinePath = generationQuarantinePath(lockPath, generation);
  try {
    fs.renameSync(lockPath, quarantinePath);
    return 'recovered';
  } catch (error) {
    // Another contender may already have fenced this exact generation. Re-enter acquisition and
    // inspect the canonical path again instead of waiting on a tombstone that cannot change.
    if (isFileNotFoundError(error) || isAlreadyExistsError(error)) return 'recovered';
    if (isTransientFileBusyError(error)) return 'held';
    throw error;
  }
}

function readLockDirectorySnapshot(lockPath: string, options: NormalizedSyncStorageResourceLockOptions): LockDirectorySnapshot {
  let stat: Stats;
  try {
    stat = retryTransientFileOperationSync(() => fs.statSync(lockPath), options.maxRetries, options.retryDelayMs);
  } catch (error) {
    if (isFileNotFoundError(error)) return { status: 'missing' };
    throw error;
  }

  let raw: string;
  try {
    raw = retryTransientFileOperationSync(
      () => fs.readFileSync(path.join(lockPath, OWNER_FILE), 'utf8'),
      options.maxRetries,
      options.retryDelayMs
    );
  } catch (error) {
    if (isFileNotFoundError(error)) return { status: 'missing' };
    throw error;
  }

  if (!raw.trim()) return { status: 'empty', stat };
  try {
    const metadata = JSON.parse(raw) as Partial<SyncStorageResourceLockFileMetadata> | undefined;
    if (!isLockFileMetadata(metadata)) return { status: 'invalid', stat, raw };
    return { status: 'ok', stat, raw, metadata };
  } catch {
    return { status: 'invalid', stat, raw };
  }
}

function invalidGenerationFingerprint(stat: Stats): string {
  return `invalid-${stat.dev}-${stat.ino}-${Math.floor(lockGenerationTimestamp(stat))}-${stat.size}`;
}

function generationQuarantinePath(lockPath: string, generation: string): string {
  return `${lockPath}.generation-${generation.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

function lockGenerationTimestamp(stat: Stats): number {
  if (Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0) return stat.birthtimeMs;
  if (Number.isFinite(stat.ctimeMs) && stat.ctimeMs > 0) return stat.ctimeMs;
  return stat.mtimeMs;
}

function removeDirectorySync(directoryPath: string, ignoreMissing: boolean, options: NormalizedSyncStorageResourceLockOptions): void {
  retryTransientFileOperationSync(() => {
    try {
      fs.rmSync(directoryPath, { recursive: true, force: false });
    } catch (error) {
      if (ignoreMissing && isFileNotFoundError(error)) return;
      throw error;
    }
  }, options.maxRetries, options.retryDelayMs);
}

function isLockFileMetadata(value: unknown): value is SyncStorageResourceLockFileMetadata {
  const metadata = value as Partial<SyncStorageResourceLockFileMetadata> | undefined;
  return !!metadata
    && typeof metadata.ownerToken === 'string'
    && !!metadata.ownerToken.trim()
    && typeof metadata.pid === 'number'
    && Number.isSafeInteger(metadata.pid)
    && metadata.pid > 0
    && typeof metadata.createdAt === 'number'
    && Number.isFinite(metadata.createdAt)
    && metadata.createdAt > 0
    && typeof metadata.resource === 'string'
    && !!metadata.resource.trim();
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM';
  }
}

function renameLockGenerationSync(
  sourcePath: string,
  destinationPath: string,
  options: NormalizedSyncStorageResourceLockOptions
): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (
        attempt >= options.maxRetries
        || !isRetryableWindowsLockGenerationRenameError(
          error,
          sourcePath,
          destinationPath,
          process.platform
        )
      ) throw error;
      sleepSync(options.retryDelayMs);
    }
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'EEXIST' || code === 'ENOTEMPTY';
}

function combineErrors(message: string, errors: readonly unknown[]): Error {
  const present = errors.filter((error) => error !== undefined);
  if (present.length === 1 && present[0] instanceof Error) return present[0];
  const error = new Error(message);
  (error as Error & { errors?: unknown[] }).errors = present;
  return error;
}
