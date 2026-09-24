import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readProcessStartFingerprint } from './processProtocol';

export type RecordedProcessState = 'alive' | 'dead' | 'unknown';

const WINDOWS_CLAIM_RENAME_ATTEMPTS = 100;
const WINDOWS_CLAIM_RENAME_DELAY_MS = 10;
const RETRYABLE_WINDOWS_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Classifies a recorded peer process without any timeout-based judgement. Only ESRCH or a
 * verified process-start fingerprint mismatch prove that the recorded identity is dead or reused;
 * every other OS result (including EPERM) leaves the owner unknown so callers fail closed.
 */
export function classifyRecordedProcess(
  processId: number,
  processStartIdentity: string | undefined
): RecordedProcessState {
  return inspectRecordedProcess(processId, processStartIdentity).state;
}

export interface RecordedProcessInspection {
  state: RecordedProcessState;
  /** Why the owner could not be proven alive or dead; present only for 'unknown'. */
  reason?: string;
}

export function inspectRecordedProcess(
  processId: number,
  processStartIdentity: string | undefined
): RecordedProcessInspection {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    return { state: 'unknown', reason: `recorded process id ${String(processId)} is not a valid pid` };
  }
  try {
    process.kill(processId, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === 'ESRCH'
      ? { state: 'dead' }
      : { state: 'unknown', reason: `liveness signal failed with ${code ?? String(error)}` };
  }
  if (processStartIdentity === undefined) return { state: 'alive' };
  let currentIdentity: string;
  try {
    currentIdentity = readProcessStartFingerprint(processId);
  } catch (error) {
    return {
      state: 'unknown',
      reason: `process ${processId} exists but its start time could not be read: ${error instanceof Error ? error.message : String(error)}`
    };
  }
  return { state: currentIdentity === processStartIdentity ? 'alive' : 'dead' };
}

let ownStartIdentity: string | undefined;
let ownStartIdentityComputed = false;

/** This host's verified start identity, spawned platform probes run at most once per process. */
export function ownProcessStartIdentity(): string | undefined {
  if (!ownStartIdentityComputed) {
    ownStartIdentityComputed = true;
    try {
      ownStartIdentity = readProcessStartFingerprint(process.pid);
    } catch {
      ownStartIdentity = undefined;
    }
  }
  return ownStartIdentity;
}

/** Deterministic generation sibling path used for dead-owner tombstones and release staging. */
export function claimGenerationPath(claimPath: string, generation: string): string {
  return `${claimPath}.generation-${generation.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

/**
 * Publishes one claim record atomically: a candidate directory receives the record and is then
 * renamed onto the canonical path. The canonical directory is always non-empty once published,
 * so a POSIX rename may only silently replace a pathological empty (invalid) directory, never a
 * valid claim. Returns false when a canonical claim already exists.
 */
export async function tryPublishClaimRecord(
  claimPath: string,
  recordFileName: string,
  serializedRecord: string
): Promise<boolean> {
  // A pre-existing canonical path — even an empty directory, which a POSIX rename would
  // silently replace — is contention. Returning false routes it through the caller's strict
  // read, which fails closed on any directory without a valid record.
  try {
    await fs.lstat(claimPath);
    return false;
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }
  const candidatePath = `${claimPath}.candidate-${randomUUID()}`;
  await fs.rm(candidatePath, { recursive: true, force: true });
  await fs.mkdir(candidatePath, { mode: 0o700 });
  let published = false;
  try {
    await fs.writeFile(
      `${candidatePath}/${recordFileName}`,
      serializedRecord,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    );
    await publishClaimCandidate(candidatePath, claimPath);
    published = true;
    return true;
  } catch (error) {
    if (await isClaimContention(error, claimPath)) return false;
    throw error;
  } finally {
    if (!published) {
      // The candidate is uniquely named and never authoritative. Cleanup must not replace the
      // publication error or turn ordinary contention into a Runtime-open failure.
      await fs.rm(candidatePath, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/**
 * Reads and strictly parses a claim record. Returns undefined only when the canonical directory
 * genuinely disappeared (a completed release/isolation race). An existing directory whose record
 * is missing, unreadable or malformed fails closed through the caller's invalid-error factory.
 */
export async function readClaimRecord<T>(
  claimPath: string,
  recordFileName: string,
  parse: (value: unknown) => T | undefined,
  invalid: (cause?: unknown) => Error
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(`${claimPath}/${recordFileName}`, 'utf8');
  } catch (error) {
    if (isMissingError(error)) {
      // Only a genuinely missing canonical path is a completed release/isolation race; every
      // other lstat failure surfaces instead of being swallowed as "missing".
      try {
        await fs.lstat(claimPath);
      } catch (statError) {
        if (isMissingError(statError)) return undefined;
        throw statError;
      }
      throw invalid(error);
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw invalid(error);
  }
  const record = parse(value);
  if (record === undefined) throw invalid();
  return record;
}

/**
 * Moves a proven-dead claim to its deterministic non-empty tombstone. The record is re-read
 * immediately before the rename so a contender acting on a stale observation can never rename or
 * remove a newer valid owner; the tombstone is left in place (never deleted) so concurrent stale
 * contenders collide on EEXIST instead of moving a newer claim.
 */
export async function isolateDeadClaimRecord<T extends { ownerToken: string }>(
  claimPath: string,
  recordFileName: string,
  ownerToken: string,
  parse: (value: unknown) => T | undefined,
  invalid: (cause?: unknown) => Error
): Promise<void> {
  const isolatedPath = claimGenerationPath(claimPath, `dead-${ownerToken}`);
  for (let attempt = 1; ; attempt += 1) {
    const current = await readClaimRecord(claimPath, recordFileName, parse, invalid);
    if (!current || current.ownerToken !== ownerToken) return;
    try {
      await fs.rename(claimPath, isolatedPath);
      break;
    } catch (error) {
      if (isMissingError(error) || isAlreadyExistsError(error)) return;
      if (!shouldRetryClaimRename(error, claimPath, isolatedPath, attempt)) throw error;
      await delay(WINDOWS_CLAIM_RENAME_DELAY_MS);
    }
  }
  const moved = await readClaimRecord(isolatedPath, recordFileName, parse, invalid).catch(() => undefined);
  if (!moved || moved.ownerToken !== ownerToken) {
    // The rename moved something other than the observed dead record. That state is impossible
    // while every writer follows this protocol, so it fails closed and loud rather than
    // guessing at a restore or silently continuing.
    throw invalid();
  }
}

/**
 * Exact-token release: the canonical record must still belong to ownerToken before it is moved
 * aside and removed. A missing canonical directory is treated as an already-completed release; a
 * record owned by a different token is never touched and fails closed through mismatch().
 */
export async function releaseClaimRecord<T extends { ownerToken: string }>(
  claimPath: string,
  recordFileName: string,
  ownerToken: string,
  parse: (value: unknown) => T | undefined,
  invalid: (cause?: unknown) => Error,
  mismatch: () => Error
): Promise<void> {
  const releasedPath = claimGenerationPath(claimPath, `released-${ownerToken}`);
  for (let attempt = 1; ; attempt += 1) {
    // Re-read the token before every Windows retry. A transient sharing violation must never let
    // a stale releaser move a replacement owner that appeared between attempts.
    const current = await readClaimRecord(claimPath, recordFileName, parse, invalid);
    if (!current) return;
    if (current.ownerToken !== ownerToken) throw mismatch();
    try {
      await fs.rename(claimPath, releasedPath);
      break;
    } catch (error) {
      if (isMissingError(error)) return;
      if (!shouldRetryClaimRename(error, claimPath, releasedPath, attempt)) throw error;
      await delay(WINDOWS_CLAIM_RENAME_DELAY_MS);
    }
  }
  // Once the owner-fenced rename succeeds, the canonical claim is free and the uniquely named
  // released generation has no authority. Antivirus/indexer interference with its deletion may
  // leave harmless debris, but must not fail the operation that already released the mutex.
  await fs.rm(releasedPath, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: WINDOWS_CLAIM_RENAME_DELAY_MS
  }).catch(() => undefined);
}

async function publishClaimCandidate(candidatePath: string, claimPath: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rename(candidatePath, claimPath);
      return;
    } catch (error) {
      if (!shouldRetryClaimRename(error, candidatePath, claimPath, attempt)) throw error;
      await delay(WINDOWS_CLAIM_RENAME_DELAY_MS);
    }
  }
}

function shouldRetryClaimRename(
  error: unknown,
  sourcePath: string,
  destinationPath: string,
  attempt: number
): boolean {
  if (attempt >= WINDOWS_CLAIM_RENAME_ATTEMPTS || process.platform !== 'win32') return false;
  const candidate = error as NodeJS.ErrnoException & { dest?: unknown };
  return RETRYABLE_WINDOWS_RENAME_CODES.has(String(candidate.code))
    && candidate.syscall === 'rename'
    && typeof candidate.path === 'string'
    && typeof candidate.dest === 'string'
    && sameWindowsPath(candidate.path, sourcePath)
    && sameWindowsPath(candidate.dest, destinationPath);
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function requireNonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

export function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export function isAlreadyExistsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EEXIST' || code === 'ENOTEMPTY';
}

async function isClaimContention(error: unknown, claimPath: string): Promise<boolean> {
  if (isAlreadyExistsError(error)) return true;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES')) return false;
  try {
    return (await fs.stat(claimPath)).isDirectory();
  } catch {
    return false;
  }
}
