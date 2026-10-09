import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import type { RelocatedWorkSettlementCounts } from './historicalWorkSettlement';
import { classifyRecordedProcess } from './runtimeClaimPrimitives';
import { readRuntimeDataSetFacts,runtimeDataSetFileState } from './runtimeDataSetFacts';
import type { ForeignRuntimeRootLocation } from './runtimeLocatedRoot';
import { RUNTIME_MERGE_VALIDATION_REVISION,revisionedRuntimeMergeRefusal } from './runtimeMergeValidation';
import { requireCompleteRuntimeDataSet } from './runtimeStorageInspection';
import { resolveVscodeRuntimeMergeLedgerRoot,type VscodeRuntimeDataSetCandidate } from './vscodeRootAuthority';

/**
 * Durable per-source merge state of one configuration root. It is kept beside the data sets (see
 * VSCODE_RUNTIME_MERGE_LEDGER_DIRECTORY), never inside a target, so deleting or resetting a target
 * does not make its sources look unmerged. Every record names the exact source files it judged.
 */
const RECORD_KIND = 'limcode-runtime-data-set-merge';
const COMMIT_KIND = 'limcode-runtime-data-set-merge-commit';
const FINGERPRINT_KIND = 'limcode-runtime-data-set-fingerprint';
const FINALIZATION_KIND = 'limcode-runtime-data-set-merge-finalization';
const PREPARATION_KIND = 'limcode-runtime-data-set-merge-preparation';
const AUDIT_KIND = 'limcode-runtime-data-set-audit';
const TARGET_BACKUP_KIND = 'limcode-runtime-large-merge-target-backup';
const RECORDS = 'records';
const COMMITS = 'commits';
/** Cache only: the content digest last computed for an exact file state. Never a merge fact. */
const FINGERPRINTS = 'fingerprints';
/** Cache only: what the audit of an exact file state found (see RuntimeDataSetAuditFacts). Never a merge fact. */
const AUDITS = 'audits';
const FINALIZATIONS = 'finalizations';
/** Advisory: the window preparing a large-merge session for a source (see RuntimeDataSetMergePreparation). */
const PREPARATIONS = 'preparing';
/** The online target backup of a large-merge preparation, until settled (see RuntimeLargeMergeTargetBackup). */
const TARGET_BACKUPS = 'preparing-backups';
/** Content digest prefix of a data set whose content could not be read (see runtimeDataSetFingerprint). */
const UNREADABLE_DIGEST = 'unreadable:';
/** The id of a foreign history root (runtimeForeignHistory.foreignRuntimeHistoryId). */
const FOREIGN_ID = /^foreign:(archive|copied):[0-9a-f]{16}$/;

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
export interface RuntimeDataSetMergeExcludedConversation {
  conversationId: string;
  title: string;
  code: string;
  count: number;
}

export interface RuntimeDataSetLastMerge {
  excluded?: RuntimeDataSetMergeExcludedConversation[];
  target: RuntimeDataSetIdentity;
  mergedAt: string;
  source: RuntimeDataSetFingerprint;
  /** Conversations that merge left out because the user had deleted them there (see mergeSource). */
  skippedConversations?: number;
}

/**
 * Conversations that merges of this source incarnation actually inserted into one data set (not
 * the ones that were there already), accumulated over every merge into it.
 */
export interface RuntimeDataSetMergedConversations {
  target: RuntimeDataSetIdentity;
  conversationIds: string[];
}

/**
 * What merges of an earlier incarnation under the same candidate id (another source identity, e.g.
 * before its scope was archived and reset) inserted into one data set: kept on every later record, so
 * merging a copy of that incarnation (its archive, as foreign history) still leaves out what the user
 * deleted since.
 */
export interface RuntimeDataSetFormerMergedConversations extends RuntimeDataSetMergedConversations {
  source: RuntimeDataSetIdentity;
}

export type RuntimeDataSetMergeLedgerRecord = {
  kind: typeof RECORD_KIND;
  candidateId: string;
  source: RuntimeDataSetFingerprint;
  updatedAt: string;
  /** A format-only upgrade of an already merged source; no new content identity is invented. */
  formatUpgrade?: { rootGeneration: number; pointerRevision: number; files: string };
  /** Revision of a derived refusal only, never part of content identity or commit proof. */
  validationRevision?: string;
  /**
   * Kept on a non-merged record that replaced a merged one of the same source incarnation (a later
   * explicit attempt that was blocked, failed or interrupted): the earlier merge still happened.
   */
  lastMerged?: RuntimeDataSetLastMerge;
  /**
   * Per receiving data set, kept on every later record of the same source incarnation: a later merge
   * into that data set leaves out the ones the user deleted there since (see mergeSource).
   */
  mergedInto?: RuntimeDataSetMergedConversations[];
  /** Per earlier source incarnation of this candidate id and receiving data set (never dropped). */
  formerMergedInto?: RuntimeDataSetFormerMergedConversations[];
} & (
  /**
   * Written before the row transaction; `commitId` names the exact inserted id set. `replaced` is the
   * record it replaced, put back unchanged when the transaction is proven not to have committed.
   */
  | {
    state: 'committing'; excluded?: RuntimeDataSetMergeExcludedConversation[]; target: RuntimeDataSetIdentity; commitId: string; replaced?: RuntimeDataSetMergeLedgerRecord;
    /** The plan's left-out conversations, for the merged record a crash converges to. */
    skippedConversations?: number;
  }
  | (({ state: 'merged'; excluded?: never } | { state: 'partial'; excluded: RuntimeDataSetMergeExcludedConversation[] }) & {
    target: RuntimeDataSetIdentity;
    mergedAt: string;
    insertedRows: number;
    reusedRows: number;
    insertedConversations: number;
    /** Conversations left out because the user had deleted them in the target (a copy then keeps them). */
    skippedConversations?: number;
  })
  /** Unfinished work that has no terminal transition, or a conflict with this target. */
  | { state: 'blocked'; target: RuntimeDataSetIdentity; code: string; message: string }
  /** The source itself cannot be merged (unsupported format, integrity, drift); any target. */
  | { state: 'failed'; code: string; message: string }
  /**
   * Too many rows for one merge transaction at the limit `maxRows` of the version that judged it;
   * not a failure of the source, judged again only when that limit (or the source) changes.
   */
  | { state: 'too-large'; code: string; message: string; rows: number; maxRows: number }
);

/** Where a requested foreign history root was found (runtimeForeignHistory discovery), and its name. */
export interface RuntimeDataSetMergeForeignSource {
  location: ForeignRuntimeRootLocation;
  label: string;
}

/**
 * Unfinished work a merge attempt closed in a source (after backing it up) while that attempt ended
 * without a reported outcome (stopped or deferred afterwards). The next reported outcome of the
 * source says so, then this is removed.
 */
export interface RuntimeDataSetMergeFinalization {
  kind: typeof FINALIZATION_KIND;
  candidateId: string;
  source: RuntimeDataSetIdentity;
  /** Every Turn and queued TurnIntent the merge set out to close, over all its attempts. */
  turnIds: string[];
  intentIds: string[];
  /** How many of them were closed when last counted in the source (not how many were planned). */
  turns: number;
  intents: number;
  sourceBackupPath: string;
  /** Complete counts returned by the offline settlement control plane. */
  settlement?: RelocatedWorkSettlementCounts;
  /** False when closing failed partway (some of the work may be closed). */
  complete: boolean;
  finalizedAt: string;
}

/**
 * Evidence of a committing transaction's inserted rows, for convergence after a crash: every inserted
 * Conversation (recorded as merged into the target) and a bounded sample of the other rows (see
 * RuntimeDataSetMergeEvidence), and how many rows it inserts and reuses (what a converged merge
 * reports). Whether it committed is read off its marker row in the target, keyed by `commitId`. A
 * streamed transaction's evidence is written empty with its committing record and completed right
 * before its commit.
 */
export interface RuntimeDataSetMergeCommit {
  kind: typeof COMMIT_KIND;
  commitId: string;
  rows: Array<[domain: string, id: string]>;
  insertedRows: number;
  reusedRows: number;
}

/**
 * One window preparing a large-merge session for a source, and holding it until that session ran:
 * other windows leave the source alone while the heartbeat is fresh and the process alive, and
 * take it over otherwise. Advisory only; the session checks everything again under its claims.
 */
export interface RuntimeDataSetMergePreparation {
  kind: typeof PREPARATION_KIND;
  candidateId: string;
  token: string;
  processId: number;
  /** The process's start identity where it can be read (ownProcessStartIdentity): a reused pid is not this process. */
  processStartIdentity?: string;
  startedAt: string;
  heartbeatAt: string;
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
    return { ...identity, contentDigest: `${UNREADABLE_DIGEST}${files}` };
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

/** False for a fingerprint that names only the file state, because the content could not be read. */
export function isReadableRuntimeDataSetFingerprint(fingerprint: RuntimeDataSetFingerprint): boolean {
  return !fingerprint.contentDigest.startsWith(UNREADABLE_DIGEST);
}

/**
 * The cached fingerprint, only when the SQLite files are exactly as they were when it was computed;
 * never reads the data set itself (cheap enough under a claim). Undefined: not known without a read.
 */
export async function cachedRuntimeDataSetFingerprint(candidate: VscodeRuntimeDataSetCandidate): Promise<RuntimeDataSetFingerprint | undefined> {
  const binding = await requireCompleteRuntimeDataSet(candidate);
  const files = await runtimeDataSetFileState(binding.paths.databasePath);
  const cached = await readFingerprintCache({ globalStoragePath: candidate.configurationRootPath }, candidate.id).catch(() => undefined);
  return cached?.files === files && sameFingerprintIdentity(cached.fingerprint, fingerprintIdentity(binding)) ? cached.fingerprint : undefined;
}

/** Reuse an existing merge proof, including a source changed only by our offline format upgrade. */
export async function runtimeDataSetMergeSourceUnchanged(
  candidate: VscodeRuntimeDataSetCandidate,
  record: RuntimeDataSetMergeLedgerRecord,
  fingerprint?: RuntimeDataSetFingerprint
): Promise<boolean> {
  if (!sameRuntimeDataSetIdentity(record.source, candidate)) return false;
  if (sameRuntimeDataSetFingerprint(record.source, fingerprint ?? await cachedRuntimeDataSetFingerprint(candidate))) return true;
  const upgrade = record.state === 'merged' ? record.formatUpgrade : undefined;
  if (!upgrade) return false;
  const binding = await requireCompleteRuntimeDataSet(candidate);
  return upgrade.rootGeneration === binding.rootGeneration && upgrade.pointerRevision === binding.pointerRevision
    && upgrade.files === await runtimeDataSetFileState(binding.paths.databasePath);
}

/** Called within the existing offline upgrade admission, after its database has closed. */
export async function rememberMergedSourceFormatUpgrade(
  candidate: VscodeRuntimeDataSetCandidate,
  record: RuntimeDataSetMergeLedgerRecord
): Promise<void> {
  const binding = await requireCompleteRuntimeDataSet(candidate);
  await writeRuntimeDataSetMergeLedgerRecord({ globalStoragePath: candidate.configurationRootPath }, {
    ...record, formatUpgrade: { rootGeneration: binding.rootGeneration, pointerRevision: binding.pointerRevision,
      files: await runtimeDataSetFileState(binding.paths.databasePath) }
  });
}

/**
 * Caches a fingerprint whose content digest the caller computed on a private copy of exactly these
 * files (`files` from runtimeDataSetFileState before the copy, unchanged after it).
 */
export async function rememberRuntimeDataSetFingerprint(
  candidate: VscodeRuntimeDataSetCandidate,
  files: string,
  fingerprint: RuntimeDataSetFingerprint
): Promise<void> {
  await writeLedgerJson({ globalStoragePath: candidate.configurationRootPath }, FINGERPRINTS, candidate.id,
    { kind: FINGERPRINT_KIND, candidateId: candidate.id, files, fingerprint });
}

/**
 * The fingerprint cached under this configuration root for a root read in place (a foreign history
 * root, by its id): only for exactly these database files and this identity. Never reads the root.
 */
export async function cachedRuntimeRootFingerprint(
  paths: StoragePaths,
  id: string,
  files: string,
  identity: Omit<RuntimeDataSetFingerprint, 'contentDigest'>
): Promise<RuntimeDataSetFingerprint | undefined> {
  const cached = await readFingerprintCache(paths, id).catch(() => undefined);
  return cached?.files === files && sameFingerprintIdentity(cached.fingerprint, fingerprintIdentity(identity)) ? cached.fingerprint : undefined;
}

/** Caches, under this configuration root, a fingerprint computed on a private copy of exactly `files` of a root read in place. */
export async function rememberRuntimeRootFingerprint(
  paths: StoragePaths,
  id: string,
  files: string,
  fingerprint: RuntimeDataSetFingerprint
): Promise<void> {
  await writeLedgerJson(paths, FINGERPRINTS, id, { kind: FINGERPRINT_KIND, candidateId: id, files, fingerprint });
}

/**
 * What the worker audit of a private copy found for one exact source file state (runtimeSnapshotAudit):
 * how large it is and which unfinished work a merge would refuse or close first. Cached so that a
 * source that waits for a large-merge session is not copied and audited again at every startup while
 * its files stay exactly as they were: the online batch's size judgment and the large-merge estimate
 * use it. Not authoritative: a preparation copies and audits the source itself, and the session
 * checks the source unchanged against its fingerprint under its claims.
 */
export interface RuntimeDataSetAuditFacts {
  /** Rows of every Runtime table and the database's page bytes (the audit's size). */
  rows: number;
  bytes: number;
  /** The SQLite database plus its WAL in this state. */
  databaseBytes: number;
  /** content_object rows and the sum of their byte_length. */
  casObjects: number;
  casBytes: number;
  /** Unfinished work the merge refuses (with counts), and how much it would close first. */
  refusedWork: Array<{ label: string; count: number }>;
  finalizableTurns: number;
  finalizableIntents: number;
}

export interface RuntimeDataSetAuditCacheEntry extends RuntimeDataSetAuditFacts {
  validationRevision: string;
  /** The exact file state audited (runtimeDataSetFileState), and its fingerprint. */
  files: string;
  fingerprint: RuntimeDataSetFingerprint;
  auditedAt: string;
}

/**
 * The cached audit of a source, only when its SQLite files are exactly as they were when it was
 * audited and its identity (data set, root instance, generation, pointer revision) is the same;
 * never reads the data set itself. Undefined: not known without copying and auditing it.
 */
export async function readCachedRuntimeDataSetAudit(candidate: VscodeRuntimeDataSetCandidate): Promise<RuntimeDataSetAuditCacheEntry | undefined> {
  const binding = await requireCompleteRuntimeDataSet(candidate);
  const files = await runtimeDataSetFileState(binding.paths.databasePath);
  return readAuditCache({ globalStoragePath: candidate.configurationRootPath }, candidate.id, files, binding);
}

/**
 * The same for a root read in place (a foreign history root, by its id), cached under this
 * configuration root: only for exactly these database files and this identity. Never reads the root.
 */
export async function readCachedRuntimeRootAudit(
  paths: StoragePaths,
  id: string,
  files: string,
  identity: Omit<RuntimeDataSetFingerprint, 'contentDigest'>
): Promise<RuntimeDataSetAuditCacheEntry | undefined> {
  return readAuditCache(paths, id, files, identity);
}

/**
 * Caches what the audit of a private copy of exactly these files found (`files` from
 * runtimeDataSetFileState before the copy, unchanged after it; `fingerprint` computed on that copy).
 */
export async function rememberRuntimeDataSetAudit(
  candidate: VscodeRuntimeDataSetCandidate,
  files: string,
  fingerprint: RuntimeDataSetFingerprint,
  facts: RuntimeDataSetAuditFacts
): Promise<void> {
  await writeAuditCache({ globalStoragePath: candidate.configurationRootPath }, candidate.id, files, fingerprint, facts);
}

/** Caches, under this configuration root, the audit of a private copy of exactly `files` of a root read in place. */
export async function rememberRuntimeRootAudit(
  paths: StoragePaths,
  id: string,
  files: string,
  fingerprint: RuntimeDataSetFingerprint,
  facts: RuntimeDataSetAuditFacts
): Promise<void> {
  await writeAuditCache(paths, id, files, fingerprint, facts);
}

async function readAuditCache(
  paths: StoragePaths,
  id: string,
  files: string,
  identity: FingerprintIdentity
): Promise<RuntimeDataSetAuditCacheEntry | undefined> {
  const file = await ledgerFile(paths, AUDITS, id);
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown; }
  catch { return undefined; }
  const entry = value as Partial<RuntimeDataSetAuditCacheEntry> & { kind?: unknown; candidateId?: unknown } | null;
  const fingerprint = entry?.fingerprint;
  const count = (item: unknown): item is number => Number.isSafeInteger(item) && (item as number) >= 0;
  if (entry?.kind !== AUDIT_KIND || entry.validationRevision !== RUNTIME_MERGE_VALIDATION_REVISION || entry.candidateId !== id || entry.files !== files || !fingerprint
    || typeof fingerprint.contentDigest !== 'string' || !isReadableRuntimeDataSetFingerprint(fingerprint)
    || !sameFingerprintIdentity(fingerprint as RuntimeDataSetFingerprint, fingerprintIdentity(identity))
    || !count(entry.rows) || !count(entry.bytes) || !count(entry.databaseBytes) || !count(entry.casObjects) || !count(entry.casBytes)
    || !count(entry.finalizableTurns) || !count(entry.finalizableIntents) || typeof entry.auditedAt !== 'string'
    || !Array.isArray(entry.refusedWork)
    || !entry.refusedWork.every((item: { label?: unknown; count?: unknown } | null) => typeof item?.label === 'string' && count(item.count))) {
    return undefined;
  }
  return {
    validationRevision: RUNTIME_MERGE_VALIDATION_REVISION,
    files, fingerprint: fingerprint as RuntimeDataSetFingerprint, auditedAt: entry.auditedAt,
    rows: entry.rows, bytes: entry.bytes, databaseBytes: entry.databaseBytes, casObjects: entry.casObjects, casBytes: entry.casBytes,
    refusedWork: entry.refusedWork.map((item) => ({ label: item.label, count: item.count })),
    finalizableTurns: entry.finalizableTurns, finalizableIntents: entry.finalizableIntents
  };
}

async function writeAuditCache(
  paths: StoragePaths,
  id: string,
  files: string,
  fingerprint: RuntimeDataSetFingerprint,
  facts: RuntimeDataSetAuditFacts
): Promise<void> {
  if (!isReadableRuntimeDataSetFingerprint(fingerprint)) return;
  await writeLedgerJson(paths, AUDITS, id, {
    kind: AUDIT_KIND, validationRevision: RUNTIME_MERGE_VALIDATION_REVISION, candidateId: id, files, fingerprint,
    rows: facts.rows, bytes: facts.bytes, databaseBytes: facts.databaseBytes, casObjects: facts.casObjects, casBytes: facts.casBytes,
    refusedWork: facts.refusedWork.map((item) => ({ label: item.label, count: item.count })),
    finalizableTurns: facts.finalizableTurns, finalizableIntents: facts.finalizableIntents, auditedAt: new Date().toISOString()
  });
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

/** Whether a ledger id names a foreign history root (runtimeForeignHistory.foreignRuntimeHistoryId), not a data set. */
export function isForeignRuntimeHistoryId(id: string): boolean {
  return FOREIGN_ID.test(id);
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

const RECORD_STATES: ReadonlySet<string> = new Set(['committing', 'merged', 'partial', 'blocked', 'failed', 'too-large']);

function isLedgerRecord(value: unknown, name: string): value is RuntimeDataSetMergeLedgerRecord {
  const record = value as Partial<RuntimeDataSetMergeLedgerRecord> | null;
  return record?.kind === RECORD_KIND && typeof record.candidateId === 'string' && fileName(record.candidateId) === name
    && !!record.source && typeof record.source.dataSetId === 'string' && RECORD_STATES.has(String(record.state))
    && (record.state !== 'partial' || (Array.isArray(record.excluded) && record.excluded.length > 0
      && record.excluded.every((item) => !!item && typeof item.conversationId === 'string' && typeof item.title === 'string'
        && typeof item.code === 'string' && Number.isSafeInteger(item.count) && item.count >= 0)));
}

/**
 * A record file this version cannot use: `newer`, a record in a state it does not know (written by a
 * newer LimCode sharing the data directory), never overwritten; `damaged`, anything else that is no
 * record (torn, foreign, malformed). Neither is "no record": the source is not merged automatically.
 */
export type RuntimeDataSetMergeRecordDamage = 'newer' | 'damaged';

/** Record files that are no usable record, by the name a candidate id gives (runtimeDataSetMergeRecordName). */
export async function readRuntimeDataSetMergeRecordDamage(paths: StoragePaths): Promise<Map<string, RuntimeDataSetMergeRecordDamage>> {
  const result = new Map<string, RuntimeDataSetMergeRecordDamage>();
  for (const [name, value] of await readDirectoryJson(paths, RECORDS, true)) {
    const damage = recordDamage(value, name);
    if (damage) result.set(name, damage);
  }
  return result;
}

/** The record file name of a candidate id (runtimeDataSetMergeRecordDamage is keyed by it). */
export function runtimeDataSetMergeRecordName(candidateId: string): string {
  return fileName(candidateId);
}

function recordDamage(value: unknown, name: string): RuntimeDataSetMergeRecordDamage | undefined {
  if (value !== UNPARSABLE && isLedgerRecord(value, name)) return undefined;
  const record = value as Partial<RuntimeDataSetMergeLedgerRecord> | null;
  return value !== UNPARSABLE && record?.kind === RECORD_KIND && !RECORD_STATES.has(String(record.state)) ? 'newer' : 'damaged';
}

/** A record in a state this version does not know is a newer version's: never overwritten here. */
export class RuntimeDataSetMergeRecordNewerError extends Error {
  public readonly code = 'runtime-data-set-merge-record-newer';

  public constructor(candidateId: string) {
    super(`合并账本里 ${candidateId} 的记录来自更新版本的 LimCode，这个版本不改动它。`);
    this.name = 'RuntimeDataSetMergeRecordNewerError';
  }
}

/**
 * Writes the record of one source. A record other than 'merged' carries the last merge of the same
 * source incarnation forward, so a later failed attempt never hides that the content was merged;
 * every record carries its conversations merged per target forward, adding
 * `insertedConversationIds` (proven inserted into `record.target`) to them, and keeps those of an
 * earlier incarnation under the same candidate id per source identity (`formerMergedInto`).
 */
export async function writeRuntimeDataSetMergeLedgerRecord(
  paths: StoragePaths,
  input: DistributiveOmit<RuntimeDataSetMergeLedgerRecord, 'kind' | 'updatedAt' | 'lastMerged' | 'mergedInto' | 'formerMergedInto'>
    & { insertedConversationIds?: readonly string[] }
): Promise<void> {
  const { insertedConversationIds, ...record } = input;
  if (record.state === 'partial' && (!Array.isArray(record.excluded) || !record.excluded.length || record.excluded.some(item =>
    !item || typeof item.conversationId !== 'string' || !item.conversationId || typeof item.title !== 'string'
    || typeof item.code !== 'string' || !Number.isSafeInteger(item.count) || item.count < 0))) {
    throw new TypeError('Partial merge requires its excluded conversations.');
  }
  const previous = await readRuntimeDataSetMergeLedgerRecord(paths, record.candidateId, true);
  const same = previous !== undefined && sameRuntimeDataSetIdentity(previous.source, record.source);
  const lastMerged = same && record.state !== 'merged' && record.state !== 'partial' ? runtimeDataSetLastMerge(previous) : undefined;
  const { mergedInto, formerMergedInto } = carriedConversations(previous, record.source);
  if (insertedConversationIds?.length && 'target' in record) {
    let entry = mergedInto.find((item) => sameRuntimeDataSetIdentity(item.target, record.target));
    if (!entry) mergedInto.push(entry = { target: identityOf(record.target), conversationIds: [] });
    entry.conversationIds = [...new Set([...entry.conversationIds, ...insertedConversationIds])];
  }
  await writeLedgerJson(paths, RECORDS, record.candidateId, {
    kind: RECORD_KIND, ...record,
    ...(revisionedRuntimeMergeRefusal(record) ? { validationRevision: RUNTIME_MERGE_VALIDATION_REVISION } : {}),
    ...(lastMerged ? { lastMerged } : {}), ...(mergedInto.length > 0 ? { mergedInto } : {}),
    ...(formerMergedInto.length > 0 ? { formerMergedInto } : {}),
    updatedAt: new Date().toISOString()
  });
}

/**
 * `kept` with every closure `carried` keeps as well, per source identity: those of `kept`'s source
 * incarnation join its own, the others are kept as an earlier incarnation's; nothing of either is
 * dropped and nothing else of `carried` counts (e.g. a data-root relocation into an existing LimCode
 * directory, whose ledger has a record under the same candidate id as the old directory's).
 */
export function withRuntimeDataSetMergeClosures(
  kept: RuntimeDataSetMergeLedgerRecord,
  carried: RuntimeDataSetMergeLedgerRecord
): RuntimeDataSetMergeLedgerRecord {
  const { mergedInto, formerMergedInto } = carriedConversations(kept, kept.source, carried);
  const { mergedInto: _mergedInto, formerMergedInto: _formerMergedInto, ...rest } = kept;
  return {
    ...rest, ...(mergedInto.length > 0 ? { mergedInto } : {}), ...(formerMergedInto.length > 0 ? { formerMergedInto } : {})
  } as RuntimeDataSetMergeLedgerRecord;
}

/**
 * The conversations a previous record carried, as the record of `source` carries them: its own per
 * target, or kept per source identity when they belong to another incarnation (none are dropped).
 * `also`: another record whose closures are carried the same way.
 */
function carriedConversations(
  previous: RuntimeDataSetMergeLedgerRecord | undefined,
  source: RuntimeDataSetIdentity,
  also?: RuntimeDataSetMergeLedgerRecord
): { mergedInto: RuntimeDataSetMergedConversations[]; formerMergedInto: RuntimeDataSetFormerMergedConversations[] } {
  const mergedInto: RuntimeDataSetMergedConversations[] = [];
  const formerMergedInto: RuntimeDataSetFormerMergedConversations[] = [];
  const add = (from: RuntimeDataSetIdentity, target: RuntimeDataSetIdentity, ids: readonly string[]): void => {
    if (ids.length === 0) return;
    const own = sameRuntimeDataSetIdentity(from, source);
    const list: RuntimeDataSetMergedConversations[] = own ? mergedInto : formerMergedInto;
    let entry = list.find((item) => sameRuntimeDataSetIdentity(item.target, target)
      && (own || sameRuntimeDataSetIdentity((item as RuntimeDataSetFormerMergedConversations).source, from)));
    if (!entry) list.push(entry = own ? { target: identityOf(target), conversationIds: [] } : { source: identityOf(from), target: identityOf(target), conversationIds: [] } as RuntimeDataSetFormerMergedConversations);
    entry.conversationIds = [...new Set([...entry.conversationIds, ...ids])];
  };
  for (const record of [previous, also]) {
    if (!record) continue;
    for (const entry of mergedEntries(record.mergedInto)) add(record.source, entry.target, entry.conversationIds);
    for (const entry of mergedEntries(record.formerMergedInto)) if (entry.source) add(entry.source, entry.target, entry.conversationIds);
  }
  return { mergedInto, formerMergedInto };
}

/** Every closure a record keeps, with the source incarnation it belongs to (well-formed entries only). */
export function runtimeDataSetMergeClosures(
  record: RuntimeDataSetMergeLedgerRecord
): Array<{ source: RuntimeDataSetIdentity; target: RuntimeDataSetIdentity; conversationIds: string[] }> {
  return [
    ...mergedEntries(record.mergedInto).map((entry) => ({ source: identityOf(record.source), target: entry.target, conversationIds: entry.conversationIds })),
    ...mergedEntries(record.formerMergedInto).flatMap((entry) => entry.source ? [{ source: entry.source, target: entry.target, conversationIds: entry.conversationIds }] : [])
  ];
}

/** Well-formed entries only: a malformed one names nothing. */
function mergedEntries(entries: unknown): Array<{ target: RuntimeDataSetIdentity; source?: RuntimeDataSetIdentity; conversationIds: string[] }> {
  if (!Array.isArray(entries)) return [];
  const isIdentity = (value: unknown): value is RuntimeDataSetIdentity => typeof (value as RuntimeDataSetIdentity | null)?.dataSetId === 'string'
    && typeof (value as RuntimeDataSetIdentity).rootInstanceId === 'string';
  return entries.flatMap((entry: Partial<RuntimeDataSetFormerMergedConversations> | null) => isIdentity(entry?.target) && Array.isArray(entry.conversationIds)
    ? [{
      target: entry.target, ...(isIdentity(entry.source) ? { source: entry.source } : {}),
      conversationIds: entry.conversationIds.filter((id): id is string => typeof id === 'string')
    }]
    : []);
}

function identityOf(identity: RuntimeDataSetIdentity): RuntimeDataSetIdentity {
  return { dataSetId: identity.dataSetId, rootInstanceId: identity.rootInstanceId };
}

/**
 * Conversations merges of this record's source incarnation inserted into `target` so far (none
 * when nothing was recorded for it). A malformed entry names none.
 */
export function runtimeDataSetMergedConversations(
  record: RuntimeDataSetMergeLedgerRecord | undefined,
  target: RuntimeDataSetIdentity
): string[] {
  return record ? runtimeDataSetConversationsMergedFrom(record, record.source, [target]) : [];
}

/**
 * Conversations merges of the source incarnation `source` inserted into any of `targets`, as this
 * record keeps them: its own entries when it is that incarnation's record, and the ones it keeps of an
 * earlier incarnation under the same candidate id. A malformed entry names none.
 */
export function runtimeDataSetConversationsMergedFrom(
  record: RuntimeDataSetMergeLedgerRecord,
  source: RuntimeDataSetIdentity,
  targets: readonly RuntimeDataSetIdentity[]
): string[] {
  const into = (target: RuntimeDataSetIdentity): boolean => targets.some((item) => sameRuntimeDataSetIdentity(item, target));
  return [
    ...sameRuntimeDataSetIdentity(record.source, source) ? mergedEntries(record.mergedInto) : [],
    ...mergedEntries(record.formerMergedInto).filter((entry) => entry.source && sameRuntimeDataSetIdentity(entry.source, source))
  ].flatMap((entry) => into(entry.target) ? entry.conversationIds : []);
}

/** The merge a record proves happened: its own, or the one it carried forward. */
export function runtimeDataSetLastMerge(record: RuntimeDataSetMergeLedgerRecord): RuntimeDataSetLastMerge | undefined {
  return record.state === 'merged' || record.state === 'partial'
    ? {
      target: record.target, mergedAt: record.mergedAt, source: record.source,
      ...(record.excluded?.length ? { excluded: record.excluded } : {}),
      ...(record.skippedConversations ? { skippedConversations: record.skippedConversations } : {})
    }
    : record.lastMerged;
}

/** `forWrite`: a newer version's record is refused (RuntimeDataSetMergeRecordNewerError), never replaced. */
export async function readRuntimeDataSetMergeLedgerRecord(
  paths: StoragePaths,
  candidateId: string,
  forWrite = false
): Promise<RuntimeDataSetMergeLedgerRecord | undefined> {
  const file = await ledgerFile(paths, RECORDS, candidateId);
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // A damaged previous record carries nothing forward (only an explicit request replaces one).
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  if (forWrite && recordDamage(value, path.basename(file)) === 'newer') throw new RuntimeDataSetMergeRecordNewerError(candidateId);
  return isLedgerRecord(value, path.basename(file)) ? value : undefined;
}

/** The file of one source's record (never through a symbolic link), e.g. to copy the record as it is. */
export function runtimeDataSetMergeLedgerRecordFile(paths: StoragePaths, candidateId: string): Promise<string> {
  return ledgerFile(paths, RECORDS, candidateId);
}

/** Puts a record back exactly as it was, its time of judgment included (e.g. after a proven rollback). */
export async function restoreRuntimeDataSetMergeLedgerRecord(paths: StoragePaths, record: RuntimeDataSetMergeLedgerRecord): Promise<void> {
  await writeLedgerJson(paths, RECORDS, record.candidateId, record);
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

export async function readRuntimeDataSetMergeFinalization(
  paths: StoragePaths,
  candidate: { id: string; dataSetId?: string; rootInstanceId?: string }
): Promise<RuntimeDataSetMergeFinalization | undefined> {
  const file = await ledgerFile(paths, FINALIZATIONS, candidate.id);
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
  const entry = finalizationOf(value, candidate.id);
  return entry && sameRuntimeDataSetIdentity(entry.source, candidate) ? entry : undefined;
}

/** Every finalization note of this configuration root, whatever identity it names (a data-root relocation carries them). */
export async function readRuntimeDataSetMergeFinalizations(paths: StoragePaths): Promise<RuntimeDataSetMergeFinalization[]> {
  return (await readDirectoryJson(paths, FINALIZATIONS)).flatMap(([name, value]) => {
    const candidateId = (value as { candidateId?: unknown } | null)?.candidateId;
    const entry = typeof candidateId === 'string' && fileName(candidateId) === name ? finalizationOf(value, candidateId) : undefined;
    return entry ? [entry] : [];
  });
}

/** The file of the finalization note for `candidateId`. */
export function runtimeDataSetMergeFinalizationFile(paths: StoragePaths, candidateId: string): Promise<string> {
  return ledgerFile(paths, FINALIZATIONS, candidateId);
}

const SETTLEMENT_COUNT_KEYS: readonly (keyof RelocatedWorkSettlementCounts)[] = [
  'turnsStopped', 'childTurnsStopped', 'childExecutionsInterrupted', 'backgroundChildrenStopped',
  'queuedMessagesCancelled', 'childContinuationsCancelled', 'interactionsCancelled', 'modelRequestsClosed',
  'effectsCancelled', 'effectsClosedAsUnknown', 'deliveriesTakenIn', 'queuedIntentsCancelled',
  'deliveriesAbandoned', 'answersAbandoned', 'processCompletionsAbandoned'
];

function finalizationOf(value: unknown, candidateId: string): RuntimeDataSetMergeFinalization | undefined {
  const entry = value as Partial<RuntimeDataSetMergeFinalization> | null;
  const ids = (list: unknown): list is string[] => Array.isArray(list) && list.every((id) => typeof id === 'string');
  if (entry?.kind !== FINALIZATION_KIND || entry.candidateId !== candidateId || !entry.source
    || typeof entry.source.dataSetId !== 'string' || typeof entry.source.rootInstanceId !== 'string'
    || !ids(entry.turnIds) || !ids(entry.intentIds)
    || typeof entry.turns !== 'number' || typeof entry.intents !== 'number' || typeof entry.sourceBackupPath !== 'string'
    || typeof entry.complete !== 'boolean' || typeof entry.finalizedAt !== 'string') return undefined;
  if (entry.settlement !== undefined && (!entry.settlement || typeof entry.settlement !== 'object'
    || SETTLEMENT_COUNT_KEYS.some(key => !Number.isSafeInteger(entry.settlement![key]) || entry.settlement![key] < 0))) return undefined;
  return entry as RuntimeDataSetMergeFinalization;
}

export async function writeRuntimeDataSetMergeFinalization(
  paths: StoragePaths,
  finalization: Omit<RuntimeDataSetMergeFinalization, 'kind' | 'finalizedAt'>
): Promise<void> {
  const record = { kind: FINALIZATION_KIND, ...finalization, finalizedAt: new Date().toISOString() };
  if (!finalizationOf(record, finalization.candidateId)) throw new TypeError('Invalid merge finalization counts.');
  await writeLedgerJson(paths, FINALIZATIONS, finalization.candidateId, record);
}

export async function removeRuntimeDataSetMergeFinalization(paths: StoragePaths, candidateId: string): Promise<void> {
  await removeLedgerJson(paths, FINALIZATIONS, candidateId);
}

/** Writes (or, with `commitId`, rewrites) the evidence of a committing transaction. */
export async function writeRuntimeDataSetMergeCommit(
  paths: StoragePaths,
  rows: Array<[string, string]>,
  counts: { insertedRows: number; reusedRows: number },
  commitId: string = randomUUID()
): Promise<string> {
  await writeLedgerJson(paths, COMMITS, commitId,
    { kind: COMMIT_KIND, commitId, rows, insertedRows: counts.insertedRows, reusedRows: counts.reusedRows });
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
  if (commit?.kind !== COMMIT_KIND || commit.commitId !== commitId || !Array.isArray(commit.rows)
    || !isCount(commit.insertedRows) || !isCount(commit.reusedRows)) return undefined;
  return commit as RuntimeDataSetMergeCommit;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
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

export async function readRuntimeDataSetMergePreparation(
  paths: StoragePaths,
  candidateId: string
): Promise<RuntimeDataSetMergePreparation | undefined> {
  const file = await ledgerFile(paths, PREPARATIONS, candidateId);
  let value: unknown;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')) as unknown; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
  const entry = value as Partial<RuntimeDataSetMergePreparation> | null;
  if (entry?.kind !== PREPARATION_KIND || entry.candidateId !== candidateId || typeof entry.token !== 'string'
    || !Number.isSafeInteger(entry.processId) || !optionalText(entry.processStartIdentity)
    || typeof entry.startedAt !== 'string' || typeof entry.heartbeatAt !== 'string') return undefined;
  return entry as RuntimeDataSetMergePreparation;
}

export async function writeRuntimeDataSetMergePreparation(
  paths: StoragePaths,
  preparation: Omit<RuntimeDataSetMergePreparation, 'kind'>
): Promise<void> {
  await writeLedgerJson(paths, PREPARATIONS, preparation.candidateId, { kind: PREPARATION_KIND, ...preparation });
}

export async function removeRuntimeDataSetMergePreparation(paths: StoragePaths, candidateId: string): Promise<void> {
  await removeLedgerJson(paths, PREPARATIONS, candidateId);
}

/** A preparation not refreshed for this long, or whose process is gone, may be taken over or removed. */
export const RUNTIME_DATA_SET_MERGE_PREPARATION_STALE_MS = 60_000;

/**
 * Whether a preparation's holder may still be working on it: a fresh heartbeat, and its process not
 * proven gone (classifyRecordedProcess: no such pid, or a pid now used by another process as its
 * start identity shows). A process whose state cannot be verified counts as there.
 */
export function isRuntimeDataSetMergePreparationLive(preparation: RuntimeDataSetMergePreparation, now = Date.now()): boolean {
  if (!(now - Date.parse(preparation.heartbeatAt) < RUNTIME_DATA_SET_MERGE_PREPARATION_STALE_MS)) return false;
  return classifyRecordedProcess(preparation.processId, preparation.processStartIdentity) !== 'dead';
}

/** Removes preparations whose holder is gone (a crashed or closed window). Call inside configuration admission. */
export async function pruneRuntimeDataSetMergePreparations(paths: StoragePaths): Promise<void> {
  for (const [name, value] of await readDirectoryJson(paths, PREPARATIONS)) {
    const candidateId = (value as { candidateId?: unknown } | null)?.candidateId;
    const preparation = typeof candidateId === 'string' && fileName(candidateId) === name
      ? await readRuntimeDataSetMergePreparation(paths, candidateId).catch(() => undefined) : undefined;
    if (!preparation || !isRuntimeDataSetMergePreparationLive(preparation)) await removeLedgerFile(paths, PREPARATIONS, name);
  }
}

/**
 * The online backup of the target that a large-merge preparation takes (merge-backups/<name> of the
 * target's control root), registered before its first byte is written and refreshed with the
 * preparation's heartbeat until a session settled it or the preparation was released. A window that
 * goes away (closed, reloaded, crashed) at any point in between leaves only this registration: the
 * next pruning of preparations removes the backup with it, unless a session started on it (`used`,
 * written before the session's first source), which keeps it as any merge's pre-merge backup.
 */
export interface RuntimeLargeMergeTargetBackup {
  kind: typeof TARGET_BACKUP_KIND;
  /** The backup directory's name (the engine's backup name, see BACKUP_NAME). */
  name: string;
  /** The backup directory, …/merge-backups/<name>. */
  backupPath: string;
  processId: number;
  /** As a preparation's (RuntimeDataSetMergePreparation.processStartIdentity). */
  processStartIdentity?: string;
  startedAt: string;
  heartbeatAt: string;
  /** A session started on it: kept as a pre-merge backup whatever happens to its window. */
  used: boolean;
}

/**
 * A registration whose process is present counts as held this long after its last heartbeat (a
 * suspended machine or a busy window is no reason to delete a backup a session may still use); a
 * process that is gone releases it at once.
 */
export const RUNTIME_LARGE_MERGE_TARGET_BACKUP_STALE_MS = 24 * 60 * 60 * 1000;

export async function writeRuntimeLargeMergeTargetBackup(
  paths: StoragePaths,
  backup: Omit<RuntimeLargeMergeTargetBackup, 'kind'>
): Promise<void> {
  await writeLedgerJson(paths, TARGET_BACKUPS, backup.name, { kind: TARGET_BACKUP_KIND, ...backup });
}

export async function removeRuntimeLargeMergeTargetBackup(paths: StoragePaths, name: string): Promise<void> {
  await removeLedgerJson(paths, TARGET_BACKUPS, name);
}

/** Every registration file; `backup` is absent for a torn or unknown one (removed when pruned). */
export async function readRuntimeLargeMergeTargetBackups(
  paths: StoragePaths
): Promise<Array<{ file: string; backup?: RuntimeLargeMergeTargetBackup }>> {
  return (await readDirectoryJson(paths, TARGET_BACKUPS)).map(([file, value]) => {
    const entry = value as Partial<RuntimeLargeMergeTargetBackup> | null;
    const valid = entry?.kind === TARGET_BACKUP_KIND && typeof entry.name === 'string' && fileName(entry.name) === file
      && typeof entry.backupPath === 'string' && path.isAbsolute(entry.backupPath) && Number.isSafeInteger(entry.processId)
      && optionalText(entry.processStartIdentity)
      && typeof entry.startedAt === 'string' && typeof entry.heartbeatAt === 'string' && typeof entry.used === 'boolean';
    return valid ? { file, backup: entry as RuntimeLargeMergeTargetBackup } : { file };
  });
}

export async function removeRuntimeLargeMergeTargetBackupFile(paths: StoragePaths, file: string): Promise<void> {
  await removeLedgerFile(paths, TARGET_BACKUPS, file);
}

/**
 * Whether the window that registered a target backup may still use it: heard from within a day, and
 * its process not proven gone (as isRuntimeDataSetMergePreparationLive).
 */
export function isRuntimeLargeMergeTargetBackupLive(backup: RuntimeLargeMergeTargetBackup, now = Date.now()): boolean {
  if (!(now - Date.parse(backup.heartbeatAt) < RUNTIME_LARGE_MERGE_TARGET_BACKUP_STALE_MS)) return false;
  return classifyRecordedProcess(backup.processId, backup.processStartIdentity) !== 'dead';
}

/** Absent, or a non-empty text. */
function optionalText(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length > 0);
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

export async function ledgerFile(paths: StoragePaths, section: string, id: string): Promise<string> {
  const root = resolveVscodeRuntimeMergeLedgerRoot(paths);
  const file = path.join(root, section, fileName(id));
  if (path.dirname(file) !== path.join(root, section)) throw new TypeError('Merge ledger id is not a plain name.');
  await assertNoSymbolicPrefix(path.resolve(paths.globalStoragePath), path.dirname(file));
  return file;
}

/** What readDirectoryJson gives for a file that is no JSON at all, when asked to (`unparsable`). */
const UNPARSABLE = Symbol('unparsable');

async function readDirectoryJson(paths: StoragePaths, section: string, unparsable = false): Promise<Array<[string, unknown]>> {
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
    catch { if (unparsable) result.push([name, UNPARSABLE]); /* Else a torn or foreign file is not a record. */ }
  }
  return result;
}

export async function writeLedgerJson(paths: StoragePaths, section: string, id: string, value: unknown): Promise<void> {
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

export async function removeLedgerJson(paths: StoragePaths, section: string, id: string): Promise<void> {
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
