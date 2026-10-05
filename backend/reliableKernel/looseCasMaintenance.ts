import type { Dirent, Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isPathInside } from '../capabilities/filesystem/pathContainment';
import type { RuntimeRootPaths } from './contracts';
import { PACKED_CAS_FILE } from './packedCasWorkerProtocol';

/**
 * Physical maintenance adapter for mixed CAS. These operations describe allocation and immutable
 * loose leaves, not logical ContentObjects. Relocation owns admission/offline/undo fences.
 * Packed SQLite files are always copied through their owner and are never rolled back as leaves.
 */

/** Allocation units used by the relocation plan, including FAT/exFAT's largest clusters. */
export const LOOSE_CAS_COPY_CLUSTER_SIZES: readonly number[] = [4096, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576];
const NO_HARD_LINK_FILESYSTEMS: ReadonlySet<number> = new Set([0x4d44, 0x2011bab0]);

export interface LooseCasStorageSize {
  casBytes: number;
  casAllocatedBytes: number;
  casClusterBytes?: number[];
  /** Mutable packed SQLite, WAL/SHM and rollback journal, already included in the totals above. */
  packedCasBytes?: number;
  packedCasAllocatedBytes?: number;
  packedCasClusterBytes?: number[];
}

/** One existing physical walk; no ContentObject queries, digest reads or extra CAS scans. */
export async function measureLooseCasRuntimeStorage(
  paths: Pick<RuntimeRootPaths, 'dataRootPath' | 'databasePath' | 'casRootPath'>
): Promise<LooseCasStorageSize & { databaseBytes: number; casClusterBytes: number[] }> {
  const database = path.resolve(paths.databasePath);
  const databaseFiles = new Set([database, `${database}-wal`]);
  const cas = path.resolve(paths.casRootPath);
  const result = {
    databaseBytes: 0, casBytes: 0, casAllocatedBytes: 0, casClusterBytes: LOOSE_CAS_COPY_CLUSTER_SIZES.map(() => 0),
    packedCasBytes: 0, packedCasAllocatedBytes: 0, packedCasClusterBytes: LOOSE_CAS_COPY_CLUSTER_SIZES.map(() => 0)
  };
  const walk = async (entry: string): Promise<void> => {
    let info: Stats;
    try { info = await fs.lstat(entry); }
    catch (error) { if (isMissing(error)) return; throw error; }
    // Relocation's existing policy: omit links, including a linked root, instead of following them.
    if (info.isSymbolicLink()) return;
    if (info.isFile()) {
      if (databaseFiles.has(entry)) result.databaseBytes += info.size;
      else if (isPathInside(cas, entry)) {
        result.casBytes += info.size;
        const allocated = typeof info.blocks === 'number' && info.blocks > 0
          ? info.blocks * 512 : Math.ceil(info.size / 4096) * 4096;
        const packed = isPackedCasPhysicalEntry(path.relative(cas, entry));
        result.casAllocatedBytes += allocated;
        if (packed) { result.packedCasBytes += info.size; result.packedCasAllocatedBytes += allocated; }
        LOOSE_CAS_COPY_CLUSTER_SIZES.forEach((cluster, index) => {
          const bytes = Math.ceil(info.size / cluster) * cluster;
          result.casClusterBytes[index] += bytes;
          if (packed) result.packedCasClusterBytes[index] += bytes;
        });
      }
    } else if (info.isDirectory()) {
      for (const name of await fs.readdir(entry).catch(() => [] as string[])) await walk(path.join(entry, name));
    }
  };
  await walk(path.resolve(paths.dataRootPath));
  return result;
}

/** Same-device loose files can be linked, except the known Linux FAT/exFAT filesystems. */
export function canHardLinkLooseCas(
  sameDevice: boolean,
  targetFilesystemType?: number,
  platform: NodeJS.Platform = process.platform
): boolean {
  return sameDevice && !(platform === 'linux' && targetFilesystemType !== undefined && NO_HARD_LINK_FILESYSTEMS.has(targetFilesystemType));
}

/** Physical CAS allocation in the target. The caller separately reserves database/staging space. */
export function estimateLooseCasCopyBytes(size: LooseCasStorageSize, hardLinks: boolean, targetAllocationUnit?: number): number {
  if (hardLinks) return estimatePackedCasCopyBytes(size, targetAllocationUnit);
  if (targetAllocationUnit === undefined) return size.casAllocatedBytes;
  const index = LOOSE_CAS_COPY_CLUSTER_SIZES.findIndex((cluster) => cluster >= targetAllocationUnit);
  return Math.max(size.casAllocatedBytes, size.casClusterBytes?.[index === -1 ? LOOSE_CAS_COPY_CLUSTER_SIZES.length - 1 : index] ?? 0);
}

/** Packed SQLite allocation is never reduced to zero by same-device loose hard links. */
export function estimatePackedCasCopyBytes(size: LooseCasStorageSize, targetAllocationUnit?: number): number {
  const allocated = size.packedCasAllocatedBytes ?? 0;
  if (targetAllocationUnit === undefined) return allocated;
  const index = LOOSE_CAS_COPY_CLUSTER_SIZES.findIndex((cluster) => cluster >= targetAllocationUnit);
  return Math.max(allocated, size.packedCasClusterBytes?.[index === -1 ? LOOSE_CAS_COPY_CLUSTER_SIZES.length - 1 : index] ?? 0);
}

/** Exact fixed container files only, relative to the CAS root; no loose leaf is classified here. */
export function isPackedCasPhysicalEntry(relative: string): boolean {
  const name = process.platform === 'win32' || process.platform === 'darwin' ? relative.toLowerCase() : relative;
  return ['', '-wal', '-shm', '-journal'].some(suffix => name === `${PACKED_CAS_FILE}${suffix}`);
}

/**
 * Physical loose-store listing for the existing relocation journal: sorted '/'-separated names
 * of all non-directory entries, without following discovered links. The caller admits the root
 * through relocation's existing no-symbolic-path checks. A missing tree contributes no names.
 * This retains the journal's existing representation, including temporary files. Fixed packed
 * database files are excluded: appended immutable rows survive a metadata undo as safe orphans.
 */
export async function listLooseCasPhysicalEntries(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); }
    catch (error) { if (isMissing(error)) return; throw error; }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (isPackedCasPhysicalEntry(relative)) continue;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative);
      else files.push(relative);
    }
  };
  await visit(root, '');
  return files.sort();
}

/**
 * Loose-only undo, after Runtime metadata has been restored and target writers are closed/fenced.
 * Keep every previously listed file; remove only added leaves, leaving the directory layout alone.
 * The packed database and its WAL/SHM are excluded even when first created by this relocation.
 * Removing an entirely fresh target root is a separate operation after every owner closes.
 */
export async function removeAddedLooseCasPhysicalEntries(root: string, before: ReadonlySet<string>): Promise<void> {
  for (const file of await listLooseCasPhysicalEntries(root)) {
    if (!before.has(file)) await fs.rm(path.join(root, ...file.split('/')), { force: true });
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
