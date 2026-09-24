import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { RECORDS_DIR, STORAGE_VERSION } from './constants';
import { SettingsRevisionConflictError } from '../settingsRevisionConflict';
import { readJson, readJsonStrict, writeJson } from './json';
import { sortableName } from './naming';
import { createMissingStorageRevision, createStorageRevision } from './storageRevision';
import { isRetryableWindowsLockPublicationRenameError } from './lockRenameErrors';
import { isNodeFsStorageUri, nodeFsStoragePath } from './localStorageUri';

interface RecordsIndexFile {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
  records: RecordIndexRecord[];
}

interface RecordIndexRecord {
  id: string;
  file: string;
  updatedAt: string;
}

export interface RecordStoreDiagnosticsResult<TRecord> {
  records: TRecord[];
  indexCount: number;
  recordFileCount: number;
  indexedIds: string[];
  orphanIds: string[];
}

type RecordFile<TKey extends string, TRecord> = {
  schemaVersion: typeof STORAGE_VERSION;
  savedAt: string;
} & Record<TKey, TRecord>;

export interface SaveRecordStoreOptions {
  pruneMissing?: boolean;
}

export interface RecordStoreSnapshot<TRecord> {
  records: TRecord[];
  revision: string;
}

export interface RecordStoreCommitResult<TRecord> extends RecordStoreSnapshot<TRecord> {
  previousRecords: TRecord[];
}

export interface CommitRecordStoreSnapshotOptions extends SaveRecordStoreOptions {
  expectedRevision: string;
  section: string;
}

export interface UpsertRecordOptions {
  /** 记录的显示名称，用于生成可读文件名。 */
  labelForRecord: (record: { id: string }) => string;
  /** 保存时预期当前 revision；若不匹配则拒绝写入。 */
  expectedRevision: string;
  /** 冲突时报错用的 section 名称。 */
  section: string;
}

const LOAD_RECORD_BATCH_SIZE = 32;
const RECORD_STORE_LOCK_STALE_MS = 30_000;
// A full-store generation save can legitimately exceed a couple of seconds on remote or busy
// filesystems. Keep the wait bounded for UI feedback, but do not misclassify an ordinary live
// writer as a failed configuration mutation merely because its atomic save is still in flight.
const RECORD_STORE_LOCK_WAIT_MS = 30_000;
const RECORD_STORE_LOCK_INVALID_WAIT_MS = 100;
const RECORD_STORE_LOCK_OWNER_FILE = 'owner.json';
const RECORD_STORE_LOCK_FS_ATTEMPTS = 100;
const RECORD_STORE_LOCK_FS_DELAY_MS = 10;
const recordStoreMutationQueues = new Map<string, Promise<void>>();
// Only actions that have settled can enter this map. The next queued operation may finish
// releasing that exact owner; a live PID or an old timestamp alone never grants this right.
const recordStorePendingReleases = new Map<string, RecordStoreLockMetadata>();

interface RecordStoreLockMetadata {
  ownerToken: string;
  pid: number;
  createdAt: number;
  indexPath: string;
}

export async function loadRecordStore<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  recordKey: TKey
): Promise<TRecord[] | undefined> {
  const index = await loadRecordsIndex(indexUri, true);
  if (!index) return undefined;

  const files = await loadRecordFilesInBatches<TRecord, TKey>(root, index.records, recordKey, true);
  const records: TRecord[] = [];
  for (const record of files) {
    if (record) records.push(record);
  }
  return records;
}

export async function loadRecordStoreWithDiagnostics<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  recordKey: TKey
): Promise<RecordStoreDiagnosticsResult<TRecord>> {
  const index = await loadRecordsIndex(indexUri, false);
  const indexRecords = index?.records ?? [];
  const indexedIds = indexRecords.map((record) => record.id);
  const indexedFiles = new Set(indexRecords.map((record) => record.file));
  const indexed = await loadRecordFilesInBatches<TRecord, TKey>(root, indexRecords, recordKey);
  const records: TRecord[] = [];
  const seenIds = new Set<string>();
  for (const record of indexed) {
    if (!record || seenIds.has(record.id)) continue;
    records.push(record);
    seenIds.add(record.id);
  }

  const recordFiles = await listRecordFiles(root);
  const orphanIds: string[] = [];
  for (const file of recordFiles) {
    if (indexedFiles.has(file)) continue;
    const loaded = await loadRecordFile<TRecord, TKey>(root, file, recordKey);
    if (!loaded || seenIds.has(loaded.id)) continue;
    records.push(loaded);
    seenIds.add(loaded.id);
    orphanIds.push(loaded.id);
  }

  return {
    records,
    indexCount: indexRecords.length,
    recordFileCount: recordFiles.length,
    indexedIds,
    orphanIds
  };
}

export async function loadRecordStoreByIds<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  recordKey: TKey,
  ids: Iterable<string>
): Promise<TRecord[]> {
  const index = await loadRecordsIndex(indexUri, true);
  if (!index) return [];

  const wanted = new Set(ids);
  if (wanted.size === 0) return [];
  const indexById = new Map(index.records.map((record) => [record.id, record]));
  const wantedRecords = [...wanted].map((id) => indexById.get(id)).filter((record): record is RecordIndexRecord => record !== undefined);
  const files = await loadRecordFilesInBatches<TRecord, TKey>(root, wantedRecords, recordKey, true);
  const records: TRecord[] = [];
  for (const record of files) {
    if (record) records.push(record);
  }
  return records;
}


export async function withRecordStoreTransaction<T>(lockUri: vscode.Uri, action: () => Promise<T>): Promise<T> {
  return withRecordStoreMutationLock(lockUri, action);
}

/** 在同一把资源锁中读取完整记录集合及其内容指纹。 */
export async function loadRecordStoreSnapshot<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  recordKey: TKey
): Promise<RecordStoreSnapshot<TRecord> | undefined> {
  return withRecordStoreMutationLock(
    indexUri,
    () => loadRecordStoreSnapshotUnlocked<TRecord, TKey>(root, indexUri, recordKey)
  );
}

export function missingRecordStoreRevision(indexUri: vscode.Uri): string {
  return createMissingStorageRevision(`record-store:${indexUri.toString()}`);
}

/**
 * 在同一把锁内完成“读取当前版本、拒绝旧版本、发布新索引”，避免多窗口静默覆盖。
 */
export async function commitRecordStoreSnapshot<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  records: TRecord[],
  recordKey: TKey,
  labelForRecord: (record: TRecord) => string,
  options: CommitRecordStoreSnapshotOptions
): Promise<RecordStoreCommitResult<TRecord>> {
  return withRecordStoreMutationLock(indexUri, async () => {
    const current = await loadRecordStoreSnapshotUnlocked<TRecord, TKey>(root, indexUri, recordKey);
    const actualRevision = current?.revision ?? missingRecordStoreRevision(indexUri);
    if (actualRevision !== options.expectedRevision) {
      throw new SettingsRevisionConflictError(options.section, options.expectedRevision, actualRevision);
    }

    await saveRecordStoreUnlocked(root, indexUri, records, recordKey, labelForRecord, options);
    return {
      records: [...records],
      revision: createStorageRevision(records),
      previousRecords: current?.records ?? []
    };
  });
}

/**
 * 增量更新单条记录：只写变更的 record 文件，更新 index 中的 updatedAt，递增 revision。
 *
 * 使用场景：用户在设置页修改单个 model-profile，不需要全量重写 847 条记录。
 */
export async function upsertRecord<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  record: TRecord,
  recordKey: TKey,
  options: UpsertRecordOptions
): Promise<RecordStoreSnapshot<TRecord>> {
  return withRecordStoreMutationLock(indexUri, async () => {
    const current = await loadRecordStoreSnapshotUnlocked<TRecord, TKey>(root, indexUri, recordKey);
    const actualRevision = current?.revision ?? missingRecordStoreRevision(indexUri);
    if (actualRevision !== options.expectedRevision) {
      throw new SettingsRevisionConflictError(options.section, options.expectedRevision, actualRevision);
    }

    const savedAt = new Date().toISOString();
    const previousIndex = await loadRecordsIndex(indexUri, false);
    const previousRecords = previousIndex?.records ?? [];
    const previousById = new Map(previousRecords.map((r) => [r.id, r]));

    // 只写这一条记录的文件
    const file = previousById.get(record.id)?.file ?? 
      `${RECORDS_DIR}/${sortableName(record.id, options.labelForRecord(record))}.json`;
    
    const recordsRoot = vscode.Uri.joinPath(root, RECORDS_DIR);
    await vscode.workspace.fs.createDirectory(recordsRoot);
    await writeJson(vscode.Uri.joinPath(root, ...file.split('/')), {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      [recordKey]: record
    } as RecordFile<TKey, TRecord>);

    // 更新 index：替换或新增该记录的 updatedAt
    const nextIndexRecords = previousRecords
      .filter((r) => r.id !== record.id)
      .concat([{ id: record.id, file, updatedAt: savedAt }]);

    await writeJson(indexUri, {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      records: nextIndexRecords
    } satisfies RecordsIndexFile);

    // 返回新的 snapshot（必须重新读取才能生成正确的 revision）
    const updated = await loadRecordStoreSnapshotUnlocked<TRecord, TKey>(root, indexUri, recordKey);
    if (!updated) {
      throw new Error(`Failed to reload record store after upsert: ${indexUri.fsPath}`);
    }
    return updated;
  });
}

async function loadRecordStoreSnapshotUnlocked<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  recordKey: TKey
): Promise<RecordStoreSnapshot<TRecord> | undefined> {
  const index = await loadRecordsIndex(indexUri, true);
  if (!index) {
    const orphanFiles = await listRecordFiles(root);
    if (orphanFiles.length > 0) {
      throw new Error(`Record store index is missing while record files still exist: ${indexUri.fsPath}`);
    }
    return undefined;
  }

  const files = await loadRecordFilesInBatches<TRecord, TKey>(root, index.records, recordKey, true);
  const records = files.filter((record): record is TRecord => record !== undefined);
  return { records, revision: createStorageRevision(records) };
}

export async function saveRecordStore<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  records: TRecord[],
  recordKey: TKey,
  labelForRecord: (record: TRecord) => string = (record) => record.id,
  options: SaveRecordStoreOptions = {}
): Promise<void> {
  return withRecordStoreMutationLock(indexUri, () => saveRecordStoreUnlocked(root, indexUri, records, recordKey, labelForRecord, options));
}

async function saveRecordStoreUnlocked<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  records: TRecord[],
  recordKey: TKey,
  labelForRecord: (record: TRecord) => string,
  options: SaveRecordStoreOptions
): Promise<void> {
  const savedAt = new Date().toISOString();
  const recordsRoot = vscode.Uri.joinPath(root, RECORDS_DIR);
  await vscode.workspace.fs.createDirectory(recordsRoot);
  // Compare stored content, not just ids or timestamps. Existing callers may submit a full
  // catalog; unchanged files and index entries must not generate writes or watcher events.
  // Missing/invalid files still get rebuilt by this explicit full-catalog save.
  const previousIndex = await loadRecordsIndex(indexUri, false);
  const previousRecords = previousIndex?.records ?? [];
  const previousById = new Map(previousRecords.map((record) => [record.id, record]));
  const unchanged = new Set<string>();
  for (let offset = 0; offset < records.length; offset += LOAD_RECORD_BATCH_SIZE) {
    await Promise.all(records.slice(offset, offset + LOAD_RECORD_BATCH_SIZE).map(async record => {
      const previous = previousById.get(record.id);
      if (!previous) return;
      const stored = await readJsonStrict<RecordFile<TKey, TRecord>>(vscode.Uri.joinPath(root, ...previous.file.split('/')));
      if (stored.status === 'ioError') throw stored.error;
      if (stored.status === 'ok' && stored.value?.schemaVersion === STORAGE_VERSION && stored.value?.[recordKey]
        && createStorageRevision(stored.value[recordKey]) === createStorageRevision(record)) unchanged.add(record.id);
    }));
  }

  const nextIndexRecords: RecordIndexRecord[] = [];
  for (const record of records) {
    if (unchanged.has(record.id)) {
      nextIndexRecords.push(previousById.get(record.id)!);
      continue;
    }
    const file = previousById.get(record.id)?.file ?? `${RECORDS_DIR}/${sortableName(record.id, labelForRecord(record))}.json`;
    await writeJson(vscode.Uri.joinPath(root, ...file.split('/')), {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      [recordKey]: record
    } as RecordFile<TKey, TRecord>);
    nextIndexRecords.push({ id: record.id, file, updatedAt: savedAt });
  }

  // 先发布新索引，再清理旧文件；并发读取者只会看到“旧索引 + 完整旧文件”或新索引。
  if (!previousIndex || createStorageRevision(previousRecords) !== createStorageRevision(nextIndexRecords)) {
    await writeJson(indexUri, {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      records: nextIndexRecords
    } satisfies RecordsIndexFile);
  }

  if (options.pruneMissing) {
    const nextFiles = new Set(nextIndexRecords.map((record) => record.file));
    const existingFiles = await listRecordFiles(root);
    await Promise.all(existingFiles
      .filter((file) => !nextFiles.has(file))
      .map((file) => deleteRecordFile(root, file)));
  }
}


export async function removeRecordStoreRecord(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  id: string,
  recordKey: string
): Promise<void> {
  return withRecordStoreMutationLock(indexUri, () => removeRecordStoreRecordUnlocked(root, indexUri, id, recordKey));
}

async function removeRecordStoreRecordUnlocked(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  id: string,
  recordKey: string
): Promise<void> {
  const savedAt = new Date().toISOString();
  const previousIndex = await loadRecordsIndex(indexUri, false);
  const readableRecords = previousIndex
    ? await readableIndexRecords(root, previousIndex.records, recordKey)
    : [];

  const removed = readableRecords.find((record) => record.id === id);
  const nextRecords = readableRecords.filter((record) => record.id !== id);
  if (previousIndex && (removed || nextRecords.length !== previousIndex.records.length)) {
    // 删除也先提交索引，避免旧索引在短窗口内指向已删除文件。
    await writeJson(indexUri, {
      schemaVersion: STORAGE_VERSION,
      savedAt,
      records: nextRecords
    } satisfies RecordsIndexFile);
  }

  // 全量骨架保存可能已经先从 index 移除了记录，但未 prune 对应文件；按 id
  // 扫描并清理这些 orphan，保证显式删除不会留下可被直接读取的记录文件。
  const filesToDelete = new Set<string>();
  if (removed) filesToDelete.add(removed.file);
  for (const file of await listRecordFiles(root)) {
    if (filesToDelete.has(file)) continue;
    const record = await loadRecordFile<{ id: string }, string>(root, file, recordKey);
    if (record?.id === id) filesToDelete.add(file);
  }
  await Promise.all([...filesToDelete].map((file) => deleteRecordFile(root, file)));
}

async function loadRecordFilesInBatches<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  records: RecordIndexRecord[],
  recordKey: TKey,
  strict = false
): Promise<Array<TRecord | undefined>> {
  const result: Array<TRecord | undefined> = [];
  for (let index = 0; index < records.length; index += LOAD_RECORD_BATCH_SIZE) {
    const batch = records.slice(index, index + LOAD_RECORD_BATCH_SIZE);
    const files = await Promise.all(batch.map(async (record) => {
      return loadRecordFile<TRecord, TKey>(root, record.file, recordKey, strict, record.id);
    }));
    result.push(...files);
    if (index + batch.length < records.length) {
      await yieldToExtensionHost();
    }
  }
  return result;
}

async function loadRecordFile<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  file: string,
  recordKey: TKey,
  strict = false,
  expectedId?: string
): Promise<TRecord | undefined> {
  const fileUri = vscode.Uri.joinPath(root, ...file.split('/'));
  const recordFile = await readJson<RecordFile<TKey, TRecord>>(fileUri, { throwOnError: strict });
  const candidate = recordFile?.schemaVersion === STORAGE_VERSION ? recordFile[recordKey] : undefined;
  const record = isStoreRecord(candidate) ? candidate : undefined;
  if (strict && (!record || expectedId !== undefined && record.id !== expectedId)) {
    throw new Error(`Indexed record file is missing or invalid: ${fileUri.fsPath}`);
  }
  return record;
}

async function listRecordFiles(root: vscode.Uri): Promise<string[]> {
  const recordsRoot = vscode.Uri.joinPath(root, RECORDS_DIR);
  try {
    if (isNodeFsStorageUri(recordsRoot)) {
      const entries = await fs.readdir(nodeFsStoragePath(recordsRoot), { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => `${RECORDS_DIR}/${entry.name}`)
        .filter((file) => file.toLowerCase().endsWith('.json'))
        .sort();
    }
    const entries = await vscode.workspace.fs.readDirectory(recordsRoot);
    return entries
      .filter(([, type]) => type === vscode.FileType.File)
      .map(([name]) => `${RECORDS_DIR}/${name}`)
      .filter((file) => file.toLowerCase().endsWith('.json'))
      .sort();
  } catch (error) {
    if (isFileNotFound(error)) return [];
    throw error;
  }
}

async function deleteRecordFile(root: vscode.Uri, file: string): Promise<void> {
  try {
    const uri = vscode.Uri.joinPath(root, ...file.split('/'));
    if (isNodeFsStorageUri(uri)) await fs.rm(nodeFsStoragePath(uri), { force: true });
    else await vscode.workspace.fs.delete(uri);
  } catch (error) {
    if (!isFileNotFound(error)) console.warn(`[LimCode] Failed to prune record file: ${file}`, error);
  }
}


async function withRecordStoreMutationLock<T>(indexUri: vscode.Uri, action: () => Promise<T>): Promise<T> {
  const key = indexUri.toString(true);
  const previous = recordStoreMutationQueues.get(key) ?? Promise.resolve();
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolve) => { releaseTurn = resolve; });
  const queue = previous.catch(() => undefined).then(() => turn);
  recordStoreMutationQueues.set(key, queue);

  await previous.catch(() => undefined);
  try {
    return await withCrossProcessRecordStoreLock(indexUri, action);
  } finally {
    releaseTurn();
    if (recordStoreMutationQueues.get(key) === queue) recordStoreMutationQueues.delete(key);
  }
}

async function withCrossProcessRecordStoreLock<T>(indexUri: vscode.Uri, action: () => Promise<T>): Promise<T> {
  if (!isNodeFsStorageUri(indexUri)) return action();

  const indexPath = nodeFsStoragePath(indexUri);
  const lockPath = `${indexPath}.lock`;
  const pendingRelease = recordStorePendingReleases.get(lockPath);
  if (pendingRelease) {
    await releaseRecordStoreLock(lockPath, pendingRelease, true);
    recordStorePendingReleases.delete(lockPath);
  }
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + RECORD_STORE_LOCK_WAIT_MS;
  const metadata: RecordStoreLockMetadata = {
    ownerToken: randomUUID(),
    pid: process.pid,
    createdAt: Date.now(),
    indexPath: path.resolve(indexPath)
  };

  let filesystemFailures = 0;
  for (;;) {
    try {
      await createRecordStoreLockDirectory(lockPath, metadata);
      break;
    } catch (error) {
      if (!isRecordStoreLockPublicationError(error, lockPath)) {
        throw recordStoreLockFsError('create', lockPath, error);
      }
      let recovery: ExistingRecordStoreLockRecovery;
      try {
        recovery = await recoverExistingRecordStoreLock(lockPath, metadata.indexPath);
      } catch (recoveryError) {
        if (++filesystemFailures >= RECORD_STORE_LOCK_FS_ATTEMPTS || !isRetryableRecordStoreLockFsError(recoveryError)) {
          throw recordStoreLockFsError('inspect or recover', lockPath, recoveryError);
        }
        await delay(RECORD_STORE_LOCK_FS_DELAY_MS);
        continue;
      }
      if (recovery === 'recovered') continue;
      if (recovery === 'missing') {
        // Windows can reject publication even with no canonical owner. That is a bounded
        // filesystem retry, not evidence of contention with a writer for the full wait period.
        if (++filesystemFailures >= RECORD_STORE_LOCK_FS_ATTEMPTS) {
          throw recordStoreLockFsError('publish without an existing owner', lockPath, error);
        }
        await delay(RECORD_STORE_LOCK_FS_DELAY_MS);
        continue;
      }
      filesystemFailures = 0;
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`Timed out waiting for record store lock: ${indexPath}`), { cause: error });
      }
      await delay(25);
    }
  }

  let result: T;
  try {
    result = await action();
  } catch (error) {
    try {
      await releaseCompletedRecordStoreLock(lockPath, metadata);
    } catch (releaseError) {
      throw Object.assign(
        new Error(`Record store action and lock release both failed: ${lockPath}`),
        { cause: error, actionError: error, releaseError }
      );
    }
    throw error;
  }
  await releaseCompletedRecordStoreLock(lockPath, metadata);
  return result;
}

type ExistingRecordStoreLockRecovery = 'missing' | 'recovered' | 'held';

async function recoverExistingRecordStoreLock(
  lockPath: string,
  expectedIndexPath: string
): Promise<ExistingRecordStoreLockRecovery> {
  const observedAt = Date.now();
  try {
    const stat = await fs.stat(lockPath);
    const raw = await fs.readFile(
      stat.isDirectory() ? path.join(lockPath, RECORD_STORE_LOCK_OWNER_FILE) : lockPath,
      'utf8'
    );
    const parsed = parseRecordStoreLockMetadata(raw);
    const metadata = parsed && path.resolve(parsed.indexPath) === expectedIndexPath ? parsed : undefined;
    const legacy = metadata ? undefined : parseLegacyRecordStoreLockMetadata(raw, expectedIndexPath);
    const ageMs = Math.max(0, observedAt - (metadata?.createdAt ?? legacy?.createdAt ?? stat.mtimeMs));
    const staleAfterMs = metadata || legacy ? RECORD_STORE_LOCK_STALE_MS : RECORD_STORE_LOCK_INVALID_WAIT_MS;
    if (ageMs < staleAfterMs) return 'held';
    if ((metadata || legacy) && processIsAlive((metadata ?? legacy)!.pid)) return 'held';
    const generation = metadata ? `owner-${metadata.ownerToken}`
      : legacy ? `legacy-${legacy.pid}-${legacy.createdAt}`
      : `invalid-${stat.dev}-${stat.ino}-${Math.floor(stat.birthtimeMs || stat.ctimeMs)}-${stat.size}`;
    const quarantinePath = recordStoreLockQuarantinePath(lockPath, generation);
    await fs.rename(lockPath, quarantinePath);
    return 'recovered';
  } catch (error) {
    if (isFileNotFound(error)) return 'missing';
    if (isAlreadyExistsError(error)) return 'recovered';
    throw error;
  }
}

async function createRecordStoreLockDirectory(
  lockPath: string,
  metadata: RecordStoreLockMetadata
): Promise<void> {
  const candidatePath = `${lockPath}.candidate-${metadata.ownerToken}`;
  await fs.rm(candidatePath, { recursive: true, force: true });
  await fs.mkdir(candidatePath);
  let acquired = false;
  try {
    await fs.writeFile(
      path.join(candidatePath, RECORD_STORE_LOCK_OWNER_FILE),
      `${JSON.stringify(metadata)}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    );
    await fs.rename(candidatePath, lockPath);
    acquired = true;
  } finally {
    if (!acquired) await fs.rm(candidatePath, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function releaseCompletedRecordStoreLock(lockPath: string, expected: RecordStoreLockMetadata): Promise<void> {
  recordStorePendingReleases.set(lockPath, expected);
  await releaseRecordStoreLock(lockPath, expected);
  recordStorePendingReleases.delete(lockPath);
}

async function releaseRecordStoreLock(
  lockPath: string,
  expected: RecordStoreLockMetadata,
  retryCompletedRelease = false
): Promise<void> {
  const quarantinePath = recordStoreLockQuarantinePath(lockPath, `owner-${expected.ownerToken}`);
  for (let attempt = 1; ; attempt += 1) {
    try {
      const raw = await fs.readFile(path.join(lockPath, RECORD_STORE_LOCK_OWNER_FILE), 'utf8');
      const actual = parseRecordStoreLockMetadata(raw);
      if (
        !actual
        || actual.ownerToken !== expected.ownerToken
        || actual.pid !== expected.pid
        || actual.createdAt !== expected.createdAt
        || path.resolve(actual.indexPath) !== expected.indexPath
      ) {
        if (retryCompletedRelease) return;
        throw new Error(`Record store lock owner changed; refusing to delete another writer's generation: ${lockPath}`);
      }
      // Re-read the owner on every retry; a failed rename does not authorize moving a replacement.
      await fs.rename(lockPath, quarantinePath);
      break;
    } catch (error) {
      if (retryCompletedRelease && isFileNotFound(error)) return;
      if (attempt >= RECORD_STORE_LOCK_FS_ATTEMPTS || !isRetryableRecordStoreLockFsError(error)) {
        throw recordStoreLockFsError('release', lockPath, error);
      }
      await delay(RECORD_STORE_LOCK_FS_DELAY_MS);
    }
  }
  if (Math.max(0, Date.now() - expected.createdAt) < RECORD_STORE_LOCK_STALE_MS) {
    try {
      await fs.rm(quarantinePath, { recursive: true, force: false });
    } catch (error) {
      // The owner-fenced rename already released the canonical lock. Residue cannot turn a
      // completed configuration write into a failure and provoke an unnecessary business retry.
      console.warn(`[LimCode] Released record store lock; failed to clean generation: ${quarantinePath}`, error);
    }
  }
}

function recordStoreLockQuarantinePath(lockPath: string, generation: string): string {
  return `${lockPath}.generation-${generation.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

function parseRecordStoreLockMetadata(raw: string): RecordStoreLockMetadata | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<RecordStoreLockMetadata>;
    if (
      typeof value.ownerToken !== 'string' || !value.ownerToken.trim()
      || typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt <= 0
      || typeof value.indexPath !== 'string' || !value.indexPath.trim()
    ) return undefined;
    return value as RecordStoreLockMetadata;
  } catch {
    return undefined;
  }
}

function parseLegacyRecordStoreLockMetadata(
  raw: string,
  expectedIndexPath: string
): Pick<RecordStoreLockMetadata, 'pid' | 'createdAt' | 'indexPath'> | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<RecordStoreLockMetadata>;
    if (
      typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt) || value.createdAt <= 0
      || typeof value.indexPath !== 'string'
      || path.resolve(value.indexPath) !== expectedIndexPath
    ) return undefined;
    return { pid: value.pid, createdAt: value.createdAt, indexPath: value.indexPath };
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === 'EPERM';
  }
}

function isAlreadyExistsError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'EEXIST' || code === 'ENOTEMPTY';
}

function isRecordStoreLockPublicationError(error: unknown, lockPath: string): boolean {
  const candidate = error as { syscall?: unknown; dest?: unknown };
  return (isAlreadyExistsError(error) && candidate.syscall === 'rename' && candidate.dest === lockPath)
    || isRetryableWindowsLockPublicationRenameError(error, lockPath, process.platform);
}

function isRetryableRecordStoreLockFsError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EBUSY';
}

function recordStoreLockFsError(operation: string, lockPath: string, cause: unknown): Error {
  return Object.assign(new Error(`Failed to ${operation} record store lock: ${lockPath}`), { cause });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readableIndexRecords<TRecord extends { id: string }, TKey extends string>(
  root: vscode.Uri,
  records: RecordIndexRecord[],
  recordKey: TKey
): Promise<RecordIndexRecord[]> {
  if (records.length === 0) return [];
  const loaded = await loadRecordFilesInBatches<TRecord, TKey>(root, records, recordKey);
  return records.filter((record, index) => loaded[index]?.id === record.id);
}

async function loadRecordsIndex(indexUri: vscode.Uri, strict: boolean): Promise<RecordsIndexFile | undefined> {
  const index = await readJson<RecordsIndexFile>(indexUri, { throwOnError: strict });
  if (index === undefined) return undefined;
  const normalized = normalizeRecordsIndexFile(index);
  if (normalized) {
    if (normalized.repaired) await writeJson(indexUri, normalized.index);
    return normalized.index;
  }
  if (strict) throw new Error(`Record store index is invalid: ${indexUri.fsPath}`);
  return undefined;
}

function yieldToExtensionHost(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') {
      setImmediate(resolve);
      return;
    }
    setTimeout(resolve, 0);
  });
}

interface NormalizedRecordsIndexResult {
  index: RecordsIndexFile;
  repaired: boolean;
}

function normalizeRecordsIndexFile(value: unknown): NormalizedRecordsIndexResult | undefined {
  const candidate = value as Partial<RecordsIndexFile> | undefined;
  if (!candidate || candidate.schemaVersion !== STORAGE_VERSION || typeof candidate.savedAt !== 'string' || !Array.isArray(candidate.records)) return undefined;

  const validRecords: RecordIndexRecord[] = [];
  for (const record of candidate.records) {
    if (isRecordIndexRecord(record)) validRecords.push({ id: record.id, file: record.file, updatedAt: record.updatedAt });
  }

  const byId = new Map<string, RecordIndexRecord>();
  for (const record of validRecords) {
    if (byId.has(record.id)) byId.delete(record.id);
    byId.set(record.id, record);
  }

  const byFile = new Map<string, RecordIndexRecord>();
  for (const record of byId.values()) {
    if (byFile.has(record.file)) byFile.delete(record.file);
    byFile.set(record.file, record);
  }

  const records = [...byFile.values()];
  return {
    index: { schemaVersion: STORAGE_VERSION, savedAt: candidate.savedAt, records },
    repaired: records.length !== candidate.records.length
  };
}

function isRecordIndexRecord(value: unknown): value is RecordIndexRecord {
  const record = value as Partial<RecordIndexRecord> | undefined;
  return !!record
    && typeof record.id === 'string'
    && !!record.id.trim()
    && typeof record.file === 'string'
    && isRecordFilePath(record.file)
    && typeof record.updatedAt === 'string'
    && !!record.updatedAt;
}

function isRecordFilePath(file: string): boolean {
  const parts = file.split('/');
  return parts.length === 2
    && parts[0] === RECORDS_DIR
    && !!parts[1]
    && parts[1].toLowerCase().endsWith('.json')
    && !parts[1].includes('\\');
}

function isStoreRecord(value: unknown): value is { id: string } {
  return !!value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string' && !!(value as { id: string }).id.trim();
}

function isFileNotFound(error: unknown): boolean {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown; stack?: unknown };
  const text = [candidate.name, candidate.code, candidate.message, candidate.stack, String(error)]
    .filter((part): part is string => typeof part === 'string').join('\n');
  return /FileNotFound|EntryNotFound|ENOENT|ENOTDIR|not found|no such file|不存在|无法解析不存在的文件/i.test(text);
}
