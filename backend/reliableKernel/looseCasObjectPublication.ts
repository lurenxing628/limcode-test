import { randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import type { CasObjectIdentity } from './casObjectAccess';
import { fileDescriptorMatchesPathState, fileStateIdentity } from './fileTargetBoundary';
import { looseCasObjectLocation, type LooseCasObjectLocation } from './looseCasObjectAccess';

type PublicationMetric = 'temp-write' | 'file-fsync' | 'directory-fsync';
interface LoosePublicationInput { object: CasObjectIdentity; bytes: Buffer }
const COMPARISON_CHUNK_BYTES = 1024 * 1024;

/**
 * Publishes one caller-identified batch. RootBinding admission belongs to the caller; bytes have
 * already been copied and identified there. Every file is synced before linking, then each shared
 * directory is synced once, child before parent, before the batch can acquire database references.
 */
export async function publishLooseCasBatch(
  casRoot: string,
  inputs: readonly LoosePublicationInput[],
  recordMetric: (metric: PublicationMetric) => void
): Promise<LooseCasObjectLocation[]> {
  const root = path.resolve(casRoot);
  const temporaryRoot = path.join(root, 'tmp');
  const digestRoot = path.join(root, 'sha256');
  const locations = inputs.map(({ object, bytes }) => {
    if (object.byte_length !== BigInt(bytes.length)) throw new Error('CAS publication length mismatch.');
    return looseCasObjectLocation(root, object);
  });
  const unique = new Map<string, { input: LoosePublicationInput; location: LooseCasObjectLocation }>();
  inputs.forEach((input, index) => {
    const location = locations[index];
    const previous = unique.get(location.absolutePath);
    if (previous && !previous.input.bytes.equals(input.bytes)) {
      throw new Error('CAS publication batch contains conflicting bytes for one object.');
    }
    if (!previous) unique.set(location.absolutePath, { input, location });
  });
  const directories = new Set<string>();
  const ensured = new Set<string>();
  const recordDirectoryFsync = () => recordMetric('directory-fsync');
  const ensureDirectory = async (parent: string, child: string) => {
    if (ensured.has(child)) return;
    await ensureChildDirectory(parent, child);
    ensured.add(child);
    directories.add(child);
    directories.add(parent);
  };
  try {
    for (const { input, location } of unique.values()) {
      const { absolutePath } = location;
      const digestPrefix = path.dirname(absolutePath);
      if (!await existingObjectMatches(absolutePath, input.bytes)) {
        await ensureDirectory(root, temporaryRoot);
        await ensureDirectory(root, digestRoot);
        await ensureDirectory(digestRoot, digestPrefix);
        const temporaryPath = path.join(temporaryRoot, `${process.pid}-${randomUUID()}.tmp`);
        const handle = await fs.open(temporaryPath, 'wx', 0o600);
        try {
          try {
            await handle.writeFile(input.bytes);
            recordMetric('temp-write');
            await handle.sync();
            recordMetric('file-fsync');
          } finally { await handle.close(); }
          try {
            await fs.link(temporaryPath, absolutePath);
          } catch (error) {
            if (!isAlreadyExists(error)) throw error;
            if (!await existingObjectMatches(absolutePath, input.bytes)) {
              throw new Error('Existing CAS object disappeared during publication.');
            }
          }
        } finally { await fs.rm(temporaryPath, { force: true }); }
      }
      // A reused entry may belong to a publisher which has linked it but not synced its ancestors.
      directories.add(digestPrefix);
      directories.add(digestRoot);
      directories.add(root);
    }
  } finally {
    // The temporary entries have also been removed before this single batch metadata barrier.
    const ordered = [...directories].sort((left, right) => right.split(path.sep).length - left.split(path.sep).length);
    for (const directory of ordered) await syncDirectoryDurably(directory, recordDirectoryFsync);
  }
  return locations;
}

async function existingObjectMatches(filePath: string, expected: Buffer): Promise<boolean> {
  let canonical: string;
  try { canonical = await fs.realpath(filePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
  // Local CAS paths may be symbolic. Pin their canonical file and retain both pathname and
  // descriptor identities, including the existing Windows volume-serial bridge.
  const initial = await fs.lstat(canonical, { bigint: true });
  if (!initial.isFile() || initial.size !== BigInt(expected.length)) throw new Error('Existing CAS object has the wrong length.');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const info = attempt === 0 ? initial : await fs.lstat(canonical, { bigint: true });
    if (attempt !== 0 && !isHardLinkCleanup(initial, info)) throw new Error('Existing CAS object changed during publication.');
    const pathnameIdentity = fileStateIdentity(info);
    const handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      if (await fs.realpath(filePath) !== canonical) throw new Error('Existing CAS object changed during publication.');
      if (!fileDescriptorMatchesPathState(info, opened)) {
        if (attempt === 0 && isHardLinkCleanup(info, opened, true)) continue;
        throw new Error('Existing CAS object changed during publication.');
      }
      const descriptorIdentity = fileStateIdentity(opened);
      const bytes = Buffer.alloc(Math.min(COMPARISON_CHUNK_BYTES, expected.length));
      let offset = 0;
      while (offset < expected.length) {
        const count = Math.min(bytes.length, expected.length - offset);
        const { bytesRead } = await handle.read(bytes, 0, count, offset);
        if (bytesRead === 0 || !bytes.subarray(0, bytesRead).equals(expected.subarray(offset, offset + bytesRead))) {
          throw new Error('Existing CAS object does not match its published bytes.');
        }
        offset += bytesRead;
      }
      const afterRead = await handle.stat({ bigint: true });
      const current = await fs.lstat(canonical, { bigint: true });
      if (await fs.realpath(filePath) !== canonical) throw new Error('Existing CAS object changed during publication.');
      const descriptorStable = afterRead.isFile() && fileStateIdentity(afterRead) === descriptorIdentity;
      const pathnameStable = current.isFile() && fileStateIdentity(current) === pathnameIdentity;
      if (descriptorStable && pathnameStable) return true;
      // Removing a hard link changes ctime while the shared CAS body stays immutable. Dataset
      // copies may already share this inode, so only a one-link decrease may restart the full
      // exact read once. The new snapshot retains the original inode and the second read still
      // requires stable ctime.
      if (attempt === 0 && (descriptorStable || isHardLinkCleanup(opened, afterRead))
        && (pathnameStable || isHardLinkCleanup(info, current))) continue;
      throw new Error('Existing CAS object changed during publication.');
    } finally { await handle.close(); }
  }
  throw new Error('Existing CAS object changed during publication.');
}

function isHardLinkCleanup(before: BigIntStats, after: BigIntStats, pathnameToDescriptor = false): boolean {
  if (!before.isFile() || !after.isFile() || before.nlink < 2n || after.nlink !== before.nlink - 1n || before.ctimeNs === after.ctimeNs) return false;
  const originalCtime = { ...after, ctimeNs: before.ctimeNs, isFile: () => after.isFile() } as BigIntStats;
  return pathnameToDescriptor ? fileDescriptorMatchesPathState(before, originalCtime)
    : fileStateIdentity(before) === fileStateIdentity(originalCtime);
}

async function ensureChildDirectory(parentPath: string, childPath: string): Promise<void> {
  if (path.dirname(childPath) !== parentPath) {
    throw new Error(`CAS durable directory ${childPath} is not a direct child of ${parentPath}.`);
  }
  try { await fs.mkdir(childPath); }
  catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const stat = await fs.stat(childPath);
    if (!stat.isDirectory()) throw new Error(`CAS path ${childPath} exists but is not a directory.`);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}
