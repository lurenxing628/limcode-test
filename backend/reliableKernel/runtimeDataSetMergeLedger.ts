import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import { readRuntimeDataSetFacts, runtimeDataSetFileState } from './runtimeDataSetFacts';
import { requireCompleteRuntimeDataSet } from './runtimeStorageInspection';
import { resolveVscodeRuntimeMergeLedgerRoot, type VscodeRuntimeDataSetCandidate } from './vscodeRootAuthority';

/**
 * Durable per-source merge state of one configuration root. It is kept beside the data sets (see
 * VSCODE_RUNTIME_MERGE_LEDGER_DIRECTORY), never inside a target, so deleting or resetting a target
 * does not make its sources look unmerged. Every record names the exact source files it judged.
 */
const RECORD_KIND = 'limcode-runtime-data-set-merge';
const REQUEST_KIND = 'limcode-runtime-data-set-merge-request';
const COMMIT_KIND = 'limcode-runtime-data-set-merge-commit';
const FINGERPRINT_KIND = 'limcode-runtime-data-set-fingerprint';
const RECORDS = 'records';
const REQUESTS = 'requests';
const COMMITS = 'commits';
/** Cache only: the content digest last computed for an exact file state. Never a merge fact. */
const FINGERPRINTS = 'fingerprints';

type StoragePaths = { globalStoragePath: string };

/**
 * Identity plus logical content; a changed source is judged again. The digest covers every row
 * (runtimeDataSetContentDigest), so checkpointing a WAL, copying or restoring the files, or opening
 * the data set without writing leaves it unchanged, while any written row changes it.
 */
export interface RuntimeDataSetFingerprint {
  dataSetId: string;
  rootInstanceId: string;
  rootGeneration: number;
  pointerRevision: number;
  contentDigest: string;
}

export interface RuntimeDataSetIdentity {
  dataSetId: string;
  rootInstanceId: string;
}

/** The last successful merge of this source incarnation, and the source state it merged. */
export interface RuntimeDataSetLastMerge {
  target: RuntimeDataSetIdentity;
  mergedAt: string;
  source: RuntimeDataSetFingerprint;
}

export type RuntimeDataSetMergeLedgerRecord = {
  kind: typeof RECORD_KIND;
  candidateId: string;
  source: RuntimeDataSetFingerprint;
  updatedAt: string;
  /**
   * Kept on a non-merged record that replaced a merged one of the same source incarnation (a later
   * explicit attempt that was blocked, failed or interrupted): the earlier merge still happened.
   */
  lastMerged?: RuntimeDataSetLastMerge;
} & (
  /** Written before the row transaction; `commitId` names the exact inserted id set. */
  | { state: 'committing'; target: RuntimeDataSetIdentity; commitId: string }
  | {
    state: 'merged';
    target: RuntimeDataSetIdentity;
    mergedAt: string;
    insertedRows: number;
    reusedRows: number;
    insertedConversations: number;
  }
  /** Unfinished work that has no terminal transition, or a conflict with this target. */
  | { state: 'blocked'; target: RuntimeDataSetIdentity; code: string; message: string }
  /** The source itself cannot be merged (unsupported format, integrity, drift); any target. */
  | { state: 'failed'; code: string; message: string }
);

export interface RuntimeDataSetMergeLedgerRequest {
  kind: typeof REQUEST_KIND;
  candidateId: string;
  expectedDataSetId: string;
  expectedRootInstanceId: string;
  target: RuntimeDataSetIdentity;
  requestedAt: string;
}

/** Exact rows a committing transaction inserts, for convergence after a crash. */
export interface RuntimeDataSetMergeCommit {
  kind: typeof COMMIT_KIND;
  commitId: string;
  rows: Array<[domain: string, id: string]>;
}

/**
 * Reads the data set through a private copy in a worker (see runtimeDataSetFacts), except when the
 * SQLite files are exactly as they were when the cached digest was computed. Same caller contract
 * as the copy: never for a database this process has open.
 */
export async function runtimeDataSetFingerprint(candidate: VscodeRuntimeDataSetCandidate): Promise<RuntimeDataSetFingerprint> {
  const paths = { globalStoragePath: candidate.configurationRootPath };
  const binding = await requireCompleteRuntimeDataSet(candidate);
  const identity = fingerprintIdentity(binding);
  const files = await runtimeDataSetFileState(binding.paths.databasePath);
  const cached = await readFingerprintCache(paths, candidate.id).catch(() => undefined);
  if (cached?.files === files && sameFingerprintIdentity(cached.fingerprint, identity)) return cached.fingerprint;
  let facts: Awaited<ReturnType<typeof readRuntimeDataSetFacts>>;
  try { facts = await readRuntimeDataSetFacts(candidate, { contentDigest: true }); }
  catch {
    // Content that cannot be read (a damaged file, an unknown format, no room for the copy) is
    // judged by its exact file state, never cached: the merge's own checks report the cause.
    return { ...identity, contentDigest: `unreadable:${files}` };
  }
  const fingerprint: RuntimeDataSetFingerprint = { ...fingerprintIdentity(facts.binding), contentDigest: facts.contentDigest! };
  // Cached only when nothing moved while the copy was taken.
  if (sameFingerprintIdentity(fingerprint, identity)
    && await runtimeDataSetFileState(binding.paths.databasePath).catch(() => undefined) === files) {
    await writeLedgerJson(paths, FINGERPRINTS, candidate.id, { kind: FINGERPRINT_KIND, candidateId: candidate.id, files, fingerprint })
      .catch(() => undefined);
  }
  return fingerprint;
}

export function sameRuntimeDataSetFingerprint(left: RuntimeDataSetFingerprint, right: RuntimeDataSetFingerprint | undefined): boolean {
  return right !== undefined && sameFingerprintIdentity(left, right)
    && typeof left.contentDigest === 'string' && left.contentDigest === right.contentDigest;
}

type FingerprintIdentity = Omit<RuntimeDataSetFingerprint, 'contentDigest'>;

function fingerprintIdentity(binding: FingerprintIdentity): FingerprintIdentity {
  return {
    dataSetId: binding.dataSetId,
    rootInstanceId: binding.rootInstanceId,
    rootGeneration: binding.rootGeneration,
    pointerRevision: binding.pointerRevision
  };
}

function sameFingerprintIdentity(left: FingerprintIdentity, right: FingerprintIdentity): boolean {
  return left.dataSetId === right.dataSetId && left.rootInstanceId === right.rootInstanceId
    && left.rootGeneration === right.rootGeneration && left.pointerRevision === right.pointerRevision;
}

async function readFingerprintCache(
  paths: StoragePaths,
  candidateId: string
): Promise<{ files: string; fingerprint: RuntimeDataSetFingerprint } | undefined> {
  const file = await ledgerFile(paths, FINGERPRINTS, candidateId);
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown; }
  catch { return undefined; }
  const entry = value as { kind?: unknown; candidateId?: unknown; files?: unknown; fingerprint?: Partial<RuntimeDataSetFingerprint> } | null;
  const fingerprint = entry?.fingerprint;
  if (entry?.kind !== FINGERPRINT_KIND || entry.candidateId !== candidateId || typeof entry.files !== 'string' || !fingerprint
    || typeof fingerprint.dataSetId !== 'string' || typeof fingerprint.rootInstanceId !== 'string'
    || typeof fingerprint.rootGeneration !== 'number' || typeof fingerprint.pointerRevision !== 'number'
    || typeof fingerprint.contentDigest !== 'string') return undefined;
  return { files: entry.files, fingerprint: fingerprint as RuntimeDataSetFingerprint };
}

export function sameRuntimeDataSetIdentity(
  left: RuntimeDataSetIdentity | undefined,
  right: { dataSetId?: string; rootInstanceId?: string } | undefined
): boolean {
  return left !== undefined && right !== undefined
    && left.dataSetId === right.dataSetId && left.rootInstanceId === right.rootInstanceId;
}

export async function readRuntimeDataSetMergeLedger(paths: StoragePaths): Promise<Map<string, RuntimeDataSetMergeLedgerRecord>> {
  const result = new Map<string, RuntimeDataSetMergeLedgerRecord>();
  for (const [name, value] of await readDirectoryJson(paths, RECORDS)) {
    if (isLedgerRecord(value, name)) result.set(value.candidateId, value);
  }
  return result;
}

function isLedgerRecord(value: unknown, name: string): value is RuntimeDataSetMergeLedgerRecord {
  const record = value as Partial<RuntimeDataSetMergeLedgerRecord> | null;
  return record?.kind === RECORD_KIND && typeof record.candidateId === 'string' && fileName(record.candidateId) === name
    && !!record.source && typeof record.source.dataSetId === 'string'
    && ['committing', 'merged', 'blocked', 'failed'].includes(String(record.state));
}

/**
 * Writes the record of one source. A record other than 'merged' carries the last merge of the same
 * source incarnation forward, so a later failed attempt never hides that the content was merged.
 */
export async function writeRuntimeDataSetMergeLedgerRecord(
  paths: StoragePaths,
  record: DistributiveOmit<RuntimeDataSetMergeLedgerRecord, 'kind' | 'updatedAt' | 'lastMerged'>
): Promise<void> {
  let lastMerged: RuntimeDataSetLastMerge | undefined;
  if (record.state !== 'merged') {
    const previous = await readRuntimeDataSetMergeLedgerRecord(paths, record.candidateId);
    if (previous && sameRuntimeDataSetIdentity(previous.source, record.source)) lastMerged = runtimeDataSetLastMerge(previous);
  }
  await writeLedgerJson(paths, RECORDS, record.candidateId, {
    kind: RECORD_KIND, ...record, ...(lastMerged ? { lastMerged } : {}), updatedAt: new Date().toISOString()
  });
}

/** The merge a record proves happened: its own, or the one it carried forward. */
export function runtimeDataSetLastMerge(record: RuntimeDataSetMergeLedgerRecord): RuntimeDataSetLastMerge | undefined {
  return record.state === 'merged'
    ? { target: record.target, mergedAt: record.mergedAt, source: record.source }
    : record.lastMerged;
}

async function readRuntimeDataSetMergeLedgerRecord(
  paths: StoragePaths,
  candidateId: string
): Promise<RuntimeDataSetMergeLedgerRecord | undefined> {
  const file = await ledgerFile(paths, RECORDS, candidateId);
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // An unreadable previous record carries nothing forward; a torn file is not a record.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  return isLedgerRecord(value, path.basename(file)) ? value : undefined;
}

/** Drops a record, e.g. a committing record whose transaction is proven rolled back. */
export async function removeRuntimeDataSetMergeLedgerRecord(paths: StoragePaths, candidateId: string): Promise<void> {
  await removeLedgerJson(paths, RECORDS, candidateId);
}

/** A recorded, still applicable failure of this exact source state (for startup data-set choice). */
export async function readRecordedRuntimeDataSetFailure(
  paths: StoragePaths,
  candidate: VscodeRuntimeDataSetCandidate
): Promise<{ code: string; message: string } | undefined> {
  const record = (await readRuntimeDataSetMergeLedger(paths).catch(() => undefined))?.get(candidate.id);
  if (record?.state !== 'failed') return undefined;
  const fingerprint = await runtimeDataSetFingerprint(candidate).catch(() => undefined);
  return fingerprint && sameRuntimeDataSetFingerprint(record.source, fingerprint)
    ? { code: record.code, message: record.message }
    : undefined;
}

export async function readRuntimeDataSetMergeRequests(paths: StoragePaths): Promise<Map<string, RuntimeDataSetMergeLedgerRequest>> {
  const result = new Map<string, RuntimeDataSetMergeLedgerRequest>();
  for (const [name, value] of await readDirectoryJson(paths, REQUESTS)) {
    const request = value as Partial<RuntimeDataSetMergeLedgerRequest>;
    if (request?.kind !== REQUEST_KIND || typeof request.candidateId !== 'string' || fileName(request.candidateId) !== name
      || typeof request.expectedDataSetId !== 'string' || typeof request.expectedRootInstanceId !== 'string'
      || !request.target) continue;
    result.set(request.candidateId, request as RuntimeDataSetMergeLedgerRequest);
  }
  return result;
}

export async function writeRuntimeDataSetMergeRequest(
  paths: StoragePaths,
  request: Omit<RuntimeDataSetMergeLedgerRequest, 'kind' | 'requestedAt'>
): Promise<void> {
  await writeLedgerJson(paths, REQUESTS, request.candidateId, { kind: REQUEST_KIND, ...request, requestedAt: new Date().toISOString() });
}

export async function removeRuntimeDataSetMergeRequest(paths: StoragePaths, candidateId: string): Promise<void> {
  await removeLedgerJson(paths, REQUESTS, candidateId);
}

export async function writeRuntimeDataSetMergeCommit(paths: StoragePaths, rows: Array<[string, string]>): Promise<string> {
  const commitId = randomUUID();
  await writeLedgerJson(paths, COMMITS, commitId, { kind: COMMIT_KIND, commitId, rows });
  return commitId;
}

export async function readRuntimeDataSetMergeCommit(paths: StoragePaths, commitId: string): Promise<RuntimeDataSetMergeCommit | undefined> {
  const file = await ledgerFile(paths, COMMITS, commitId);
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const commit = value as Partial<RuntimeDataSetMergeCommit>;
  if (commit?.kind !== COMMIT_KIND || commit.commitId !== commitId || !Array.isArray(commit.rows)) return undefined;
  return commit as RuntimeDataSetMergeCommit;
}

export async function removeRuntimeDataSetMergeCommit(paths: StoragePaths, commitId: string): Promise<void> {
  await removeLedgerJson(paths, COMMITS, commitId);
}

/**
 * Removes commit id sets no committing record refers to any more (the record moved on to merged,
 * blocked, failed or a newer commit). Call inside configuration admission, which also covers every
 * commit-then-record write, so a commit is never removed before its record names it.
 */
export async function pruneRuntimeDataSetMergeCommits(paths: StoragePaths): Promise<void> {
  const referenced = new Set<string>();
  for (const record of (await readRuntimeDataSetMergeLedger(paths)).values()) {
    if (record.state === 'committing') referenced.add(fileName(record.commitId));
  }
  for (const [name] of await readDirectoryJson(paths, COMMITS)) {
    if (!referenced.has(name)) await removeLedgerFile(paths, COMMITS, name);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Like the storage path check, but a not-yet-created tail is allowed (the ledger is created lazily). */
async function assertNoSymbolicPrefix(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Merge ledger escapes its configuration root.');
  }
  let current = root;
  for (const segment of ['', ...relative.split(path.sep).filter(Boolean)]) {
    current = path.join(current, segment);
    let info;
    try { info = await fs.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Merge ledger path is a symbolic link: ${current}`);
  }
}

function fileName(id: string): string {
  return `${id.replace(/:/g, '-')}.json`;
}

async function ledgerFile(paths: StoragePaths, section: string, id: string): Promise<string> {
  const root = resolveVscodeRuntimeMergeLedgerRoot(paths);
  const file = path.join(root, section, fileName(id));
  if (path.dirname(file) !== path.join(root, section)) throw new TypeError('Merge ledger id is not a plain name.');
  await assertNoSymbolicPrefix(path.resolve(paths.globalStoragePath), path.dirname(file));
  return file;
}

async function readDirectoryJson(paths: StoragePaths, section: string): Promise<Array<[string, unknown]>> {
  const directory = path.join(resolveVscodeRuntimeMergeLedgerRoot(paths), section);
  await assertNoSymbolicPrefix(path.resolve(paths.globalStoragePath), directory);
  let names: string[];
  try { names = (await fs.readdir(directory)).sort(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const result: Array<[string, unknown]> = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try { result.push([name, JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')) as unknown]); }
    catch { /* A torn or foreign file is not a record. */ }
  }
  return result;
}

async function writeLedgerJson(paths: StoragePaths, section: string, id: string, value: unknown): Promise<void> {
  const file = await ledgerFile(paths, section, id);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
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
  } finally {
    await fs.rm(temporary, { force: true });
  }
  await syncDirectoryDurably(path.dirname(file));
}

async function removeLedgerJson(paths: StoragePaths, section: string, id: string): Promise<void> {
  const file = await ledgerFile(paths, section, id);
  await fs.rm(file, { force: true });
  await syncDirectoryDurably(path.dirname(file)).catch(() => undefined);
}

async function removeLedgerFile(paths: StoragePaths, section: string, name: string): Promise<void> {
  const directory = path.join(resolveVscodeRuntimeMergeLedgerRoot(paths), section);
  const file = path.join(directory, name);
  if (path.dirname(file) !== directory) throw new TypeError('Merge ledger file is not a plain name.');
  await fs.rm(file, { force: true });
  await syncDirectoryDurably(directory).catch(() => undefined);
}
