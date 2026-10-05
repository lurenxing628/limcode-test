import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import type { CasObjectIdentity } from './casObjectAccess';
import { looseCasObjectLocation } from './looseCasObjectAccess';

type PublicationMetric = 'temp-write' | 'file-fsync' | 'directory-fsync';

/** Durable loose publication. The caller validates its RootBinding before entering this adapter. */
export async function publishLooseCasObject(
  casRoot: string,
  bytes: Buffer,
  object: CasObjectIdentity,
  recordMetric: (metric: PublicationMetric) => void
): Promise<void> {
  const { absolutePath } = looseCasObjectLocation(casRoot, object);
  const temporaryRoot = path.join(casRoot, 'tmp');
  const digestRoot = path.join(casRoot, 'sha256');
  const digestPrefix = path.dirname(absolutePath);
  const recordDirectoryFsync = () => recordMetric('directory-fsync');
  await ensureDurableChildDirectory(casRoot, temporaryRoot, recordDirectoryFsync);
  await ensureDurableChildDirectory(casRoot, digestRoot, recordDirectoryFsync);
  await ensureDurableChildDirectory(digestRoot, digestPrefix, recordDirectoryFsync);
  const temporaryPath = path.join(temporaryRoot, `${process.pid}-${randomUUID()}.tmp`);
  const handle = await fs.open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    recordMetric('temp-write');
    await handle.sync();
    recordMetric('file-fsync');
  } finally {
    await handle.close();
  }
  try {
    try {
      await fs.link(temporaryPath, absolutePath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      await assertExistingObject(absolutePath, object.sha256, BigInt(bytes.length));
    }
    // An EEXIST observer also syncs: the competing publisher may not have synced this entry yet.
    await syncDirectoryDurably(digestPrefix, recordDirectoryFsync);
  } finally {
    await fs.rm(temporaryPath, { force: true });
    await syncDirectoryDurably(temporaryRoot, recordDirectoryFsync);
  }
}

async function assertExistingObject(filePath: string, digest: string, byteLength: bigint): Promise<void> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || BigInt(stat.size) !== byteLength) throw new Error('Existing CAS object has the wrong length.');
  const bytes = await fs.readFile(filePath);
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Existing CAS object has the wrong digest.');
}

async function ensureDurableChildDirectory(parentPath: string, childPath: string, onFsync: () => void): Promise<void> {
  if (path.dirname(childPath) !== parentPath) {
    throw new Error(`CAS durable directory ${childPath} is not a direct child of ${parentPath}.`);
  }
  try {
    await fs.mkdir(childPath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const stat = await fs.stat(childPath);
    if (!stat.isDirectory()) throw new Error(`CAS path ${childPath} exists but is not a directory.`);
  }
  // Sync both sides even after EEXIST: a competing creator may not yet have synced the parent.
  await syncDirectoryDurably(childPath, onFsync);
  await syncDirectoryDurably(parentPath, onFsync);
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}
