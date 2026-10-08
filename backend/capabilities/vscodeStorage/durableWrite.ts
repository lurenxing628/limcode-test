import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  syncDirectoryDurably,
  syncDirectoryDurablySync
} from '../filesystem/durableDirectorySync';

let atomicWriteSequence = 0;

const TRANSIENT_FILE_OPERATION_MAX_ATTEMPTS = 4;
const TRANSIENT_FILE_OPERATION_BASE_DELAY_MS = 10;

export type DurableFileIdentity = Pick<fs.BigIntStats, 'dev' | 'ino' | 'size' | 'mtimeNs' | 'ctimeNs'>;

/**
 * Write a file through a sibling temporary file, flush its contents, publish it
 * with rename, and finally flush the containing directory on POSIX.
 *
 * The target is not replaced until the temporary file has been flushed. A real
 * I/O failure therefore leaves the previous target intact. Ordinary file fsync is strict;
 * only the known Windows limitation for directory handles is tolerated after rename.
 */
export async function writeFileAtomicDurable(
  filePath: string,
  data: Uint8Array | string,
  onPublished?: (identity: DurableFileIdentity) => void
): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = createAtomicTempPath(filePath);
  try {
    const written = await writeFileDurable(tempPath, data, !!onPublished);
    await renameWithRetry(tempPath, filePath);
    if (written && onPublished) {
      // Match the inode we wrote, rather than attributing another writer's replacement to us.
      // Identity collection is optional bookkeeping and cannot turn a committed write into failure.
      const published = await fsp.stat(filePath, { bigint: true }).catch(() => undefined);
      if (published && published.dev === written.dev && published.ino === written.ino
        && published.size === written.size && published.mtimeNs === written.mtimeNs) {
        onPublished(published);
      }
    }
  } finally {
    await removeAtomicTempBestEffort(tempPath);
  }
  await syncDirectoryAfterRename(path.dirname(filePath));
}

/** Synchronous counterpart used by the synchronous JSON record store. */
export function writeFileAtomicDurableSync(filePath: string, data: Uint8Array | string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = createAtomicTempPath(filePath);
  try {
    writeFileDurableSync(tempPath, data);
    renameWithRetrySync(tempPath, filePath);
  } finally {
    removeAtomicTempBestEffortSync(tempPath);
  }
  syncDirectoryAfterRenameSync(path.dirname(filePath));
}

export function isTransientFileBusyError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

export function retryTransientFileOperationSync<T>(
  action: () => T,
  maxRetries = 6,
  retryDelayMs = 15
): T {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return action();
    } catch (error) {
      if (attempt >= maxRetries || !isTransientFileBusyError(error)) throw error;
      sleepSync(retryDelayMs * attempt);
    }
  }
}

export function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, Math.max(1, Math.floor(milliseconds)));
}

async function writeFileDurable(
  filePath: string,
  data: Uint8Array | string,
  captureIdentity = false
): Promise<DurableFileIdentity | undefined> {
  await fsp.writeFile(filePath, data);
  const handle = await retryTransientFileOperation(() => fsp.open(filePath, 'r+'));

  let operationFailed = false;
  try {
    await syncFileHandle(handle, filePath);
    return captureIdentity ? await handle.stat({ bigint: true }).catch(() => undefined) : undefined;
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (!operationFailed) throw error;
    }
  }
}

function writeFileDurableSync(filePath: string, data: Uint8Array | string): void {
  fs.writeFileSync(filePath, data);
  const descriptor = retryTransientFileOperationSync(() => fs.openSync(filePath, 'r+'));

  let operationFailed = false;
  try {
    syncFileDescriptor(descriptor, filePath);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch (error) {
      if (!operationFailed) throw error;
    }
  }
}

async function syncFileHandle(handle: fsp.FileHandle, _filePath: string): Promise<void> {
  await handle.sync();
}

function syncFileDescriptor(descriptor: number, _filePath: string): void {
  fs.fsyncSync(descriptor);
}

async function syncDirectoryAfterRename(directoryPath: string): Promise<void> {
  await syncDirectoryDurably(directoryPath);
}

function syncDirectoryAfterRenameSync(directoryPath: string): void {
  syncDirectoryDurablySync(directoryPath);
}

function createAtomicTempPath(filePath: string): string {
  return `${filePath}.${process.pid}.${Date.now()}.${atomicWriteSequence++}.tmp`;
}

async function renameWithRetry(source: string, target: string): Promise<void> {
  await retryTransientFileOperation(() => fsp.rename(source, target));
}

function renameWithRetrySync(source: string, target: string): void {
  retryTransientFileOperationSync(() => fs.renameSync(source, target));
}

async function retryTransientFileOperation<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (attempt >= TRANSIENT_FILE_OPERATION_MAX_ATTEMPTS || !isTransientFileBusyError(error)) throw error;
      await delay(TRANSIENT_FILE_OPERATION_BASE_DELAY_MS * (2 ** (attempt - 1)));
    }
  }
}

async function removeAtomicTempBestEffort(tempPath: string): Promise<void> {
  await retryTransientFileOperation(() => fsp.rm(tempPath, { force: true })).catch(() => undefined);
}

function removeAtomicTempBestEffortSync(tempPath: string): void {
  try {
    retryTransientFileOperationSync(() => fs.rmSync(tempPath, { force: true }));
  } catch {
    // Cleanup must not replace the write/rename failure that explains why the
    // target was not published.
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
