import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';

/**
 * Disk space of a large-merge session on the target's disk, shared by the estimate, the preparation,
 * the session and the batch that decides whether sources wait for a session.
 *
 * The WAL of one streamed source holds, until its TRUNCATE checkpoint, the source's new pages and the
 * target's own pages its inserts rewrite. Ids are random, so inserts spread over every leaf page of
 * each index of a table they go into: a large target with a small source needs several times the
 * source's size (measured: a source of 3.8 MB into a target of 46.8 MB wrote 19.8 MB of WAL).
 */

/** New pages of one source in the target's WAL, relative to the source database (its SQLite files). */
export const LARGE_MERGE_WAL_PEAK_FACTOR = 1.5;

/**
 * Index pages of a database relative to its SQLite files, where they are not measured (the estimate,
 * the batch; the preparation measures them on its backup of the target): the whole of every index of
 * the target is counted as rewritten.
 */
export const LARGE_MERGE_TARGET_INDEX_SHARE = 0.65;

/**
 * Bytes the session needs on the target's disk: the sources' databases (the target grows by about as
 * much), the largest WAL of one source — its new pages, the target's index pages (`targetIndexBytes`)
 * and the index pages the other sources of the session add before it — and `marginBytes`.
 */
export function largeMergeTargetBytes(
  sources: ReadonlyArray<{ databaseBytes: number }>,
  targetIndexBytes: number,
  marginBytes: number
): number {
  if (sources.length === 0) return 0;
  const total = sources.reduce((sum, source) => sum + source.databaseBytes, 0);
  const largest = sources.reduce((max, source) => Math.max(max, source.databaseBytes), 0);
  const indexes = targetIndexBytes + (total - largest) * LARGE_MERGE_TARGET_INDEX_SHARE;
  return Math.ceil(total + largest * LARGE_MERGE_WAL_PEAK_FACTOR + indexes + marginBytes);
}

/** Index pages of a target not measured, from the size of its SQLite files. */
export function estimatedTargetIndexBytes(targetDatabaseBytes: number): number {
  return Math.ceil(targetDatabaseBytes * LARGE_MERGE_TARGET_INDEX_SHARE);
}

/**
 * Index pages of a database (dbstat), on a connection of a file no RuntimeDatabase of this process
 * has open: the preparation's private backup of the target, read in auditRuntimeSnapshot's worker
 * (a multi-GB target's index pages are read in full; never on the extension host's main thread).
 */
export function measuredIndexBytes(database: Database.Database): number {
  return Number(database.prepare(`
    SELECT COALESCE(SUM(page.pgsize), 0) FROM dbstat AS page
      JOIN sqlite_schema AS entry ON entry.name = page.name
     WHERE entry.type = 'index'
  `).pluck().get());
}

/**
 * SQLite's temporary files during a session, relative to the largest source's SQLite files: the
 * TEMP tables of the private maintenance worker (the ids its commit asserts), of the source's private
 * copy (the left-out rows, the content keys handled) and SQLite's own sorts and statement journals
 * spill into its temporary directory once they outgrow their page caches.
 */
export const LARGE_MERGE_SQLITE_TEMPORARY_SHARE = 0.25;

/** SQLite's temporary files of a session whose largest source has `largestDatabaseBytes`. */
export function largeMergeSqliteTemporaryBytes(largestDatabaseBytes: number): number {
  return Math.ceil(Math.max(0, largestDatabaseBytes) * LARGE_MERGE_SQLITE_TEMPORARY_SHARE);
}

/**
 * Where this process's SQLite puts its temporary files, as its VFS picks it: on Windows the system's
 * temporary directory (GetTempPath: TMP, TEMP, USERPROFILE), elsewhere the first of SQLITE_TMPDIR,
 * TMPDIR, /var/tmp, /usr/tmp, /tmp and "." that is a directory this process may write to.
 */
export async function sqliteTemporaryDirectory(): Promise<string> {
  if (process.platform === 'win32') {
    const chosen = process.env.TMP || process.env.TEMP || process.env.USERPROFILE;
    return path.resolve(chosen ?? os.tmpdir());
  }
  for (const directory of [process.env.SQLITE_TMPDIR, process.env.TMPDIR, '/var/tmp', '/usr/tmp', '/tmp', '.']) {
    if (!directory) continue;
    const info = await fs.stat(directory).catch(() => undefined);
    if (!info?.isDirectory()) continue;
    if (await fs.access(directory, constants.W_OK | constants.X_OK).then(() => true, () => false)) return path.resolve(directory);
  }
  return path.resolve('.');
}

/** A session's disk space: on the target's disk, for the private source copies, for SQLite's temporary files. */
export interface LargeMergeSessionSpaceFacts {
  targetDirectory: string;
  targetBytes: number;
  /** os.tmpdir(): one private copy of the largest source at a time. */
  temporaryDirectory: string;
  temporaryBytes: number;
  /** sqliteTemporaryDirectory(): largeMergeSqliteTemporaryBytes of the largest source. */
  sqliteTemporaryDirectory: string;
  sqliteTemporaryBytes: number;
}

/**
 * The space of a session before its preparation measured and backed up the target (the estimate,
 * and the batch that decides whether sources wait for a session, with the same figures): on the
 * target's disk its model (largeMergeTargetBytes, the target's index pages at their share of its
 * files), plus the preparation's backup of the target (its SQLite files) and the content the
 * preparation copies into the target (a source's objects not on the target's disk, a foreign
 * root's always); the largest private copy; SQLite's temporary files.
 */
export function largeMergeSessionSpace(input: {
  targetDirectory: string;
  /** The target's SQLite files (database and WAL): the backup the preparation takes. */
  targetFilesBytes: number;
  sources: ReadonlyArray<{ databaseBytes: number; casCopyBytes: number }>;
  marginBytes: number;
  temporaryDirectory: string;
  sqliteTemporaryDirectory: string;
}): LargeMergeSessionSpaceFacts {
  const { sources } = input;
  const largest = sources.reduce((max, source) => Math.max(max, source.databaseBytes), 0);
  const copied = sources.reduce((sum, source) => sum + source.casCopyBytes, 0);
  return {
    targetDirectory: input.targetDirectory,
    targetBytes: sources.length === 0 ? 0
      : largeMergeTargetBytes(sources, estimatedTargetIndexBytes(input.targetFilesBytes), input.marginBytes) + input.targetFilesBytes + copied,
    temporaryDirectory: input.temporaryDirectory,
    temporaryBytes: largest,
    sqliteTemporaryDirectory: input.sqliteTemporaryDirectory,
    sqliteTemporaryBytes: sources.length === 0 ? 0 : largeMergeSqliteTemporaryBytes(largest)
  };
}

/** What one directory's disk is and has free; unknown parts are left out. */
export interface LargeMergeDiskProbe {
  device?: number;
  freeBytes?: number;
}

/** Zero is an unavailable volume identity, never proof that two directories share a disk. */
export function knownDiskDevice(device: number | undefined): number | undefined {
  return device === 0 ? undefined : device;
}

export interface LargeMergeDiskNeed {
  /** User-facing, e.g. 当前历史库所在的盘. */
  label: string;
  path: string;
  requiredBytes: number;
  /** Absent when the free space cannot be read there (the write itself then fails cleanly). */
  freeBytes?: number;
  missingBytes: number;
}

export interface DiskSpaceUse extends LargeMergeDiskProbe {
  label: string;
  path: string;
  bytes: number;
  /** This use's figure already includes the disk's safety margin. */
  includesMargin?: boolean;
}

/**
 * Known different devices have separate budgets. An unknown device could share any known disk,
 * and all unknown directories could share it together. Check each capacity against the largest
 * compatible sum; never borrow another directory's free space. A repeated path is one probe group.
 */
export function diskSpaceNeeds(uses: ReadonlyArray<DiskSpaceUse>, marginBytes: number): LargeMergeDiskNeed[] {
  const knownPaths = new Map<string, number>();
  for (const use of uses) {
    const device = knownDiskDevice(use.device);
    if (device !== undefined) knownPaths.set(path.resolve(use.path), device);
  }
  const grouped = new Map<string, LargeMergeDiskNeed & { device?: number; includesMargin: boolean }>();
  for (const use of uses) {
    const resolvedPath = path.resolve(use.path);
    const device = knownDiskDevice(use.device) ?? knownPaths.get(resolvedPath);
    const key = device === undefined ? `path:${resolvedPath}` : `device:${device}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.requiredBytes += Math.max(0, use.bytes);
      if (!existing.label.split('、').includes(use.label)) existing.label = `${existing.label}、${use.label}`;
      existing.includesMargin ||= use.includesMargin === true;
      if (use.freeBytes !== undefined) existing.freeBytes = Math.min(existing.freeBytes ?? use.freeBytes, use.freeBytes);
      continue;
    }
    grouped.set(key, {
      label: use.label, path: use.path, requiredBytes: Math.max(0, use.bytes), device,
      includesMargin: use.includesMargin === true,
      ...(use.freeBytes !== undefined ? { freeBytes: use.freeBytes } : {}), missingBytes: 0
    });
  }
  const disks = [...grouped.values()];
  const unknown = disks.filter(disk => disk.device === undefined);
  const known = disks.filter(disk => disk.device !== undefined);
  const combinedBytes = (members: typeof disks): number => members.reduce((sum, disk) => sum + disk.requiredBytes, 0)
    + (members.some(disk => disk.includesMargin) ? 0 : marginBytes);
  return disks.map(({ device, includesMargin: _includesMargin, ...disk }) => {
    const candidates = device === undefined
      ? [unknown, ...known.map(other => [other, ...unknown])]
      : [[disks.find(other => other.device === device)!, ...unknown]];
    const requiredBytes = Math.max(...candidates.map(combinedBytes));
    return { ...disk, requiredBytes, missingBytes: disk.freeBytes === undefined ? 0 : Math.max(0, requiredBytes - disk.freeBytes) };
  });
}

/**
 * Space per disk: the target's disk needs targetBytes (its margin included); the temporary directory
 * and SQLite's temporary directory their bytes, plus `marginBytes` once on a disk the target's is not.
 * Unknown identities reserve the largest possible shared-disk sum while checking their own capacity.
 */
export function largeMergeDiskNeeds(
  facts: LargeMergeSessionSpaceFacts,
  probes: { target: LargeMergeDiskProbe; temporary: LargeMergeDiskProbe; sqliteTemporary: LargeMergeDiskProbe },
  marginBytes: number
): LargeMergeDiskNeed[] {
  return diskSpaceNeeds([
    { ...probes.target, label: '当前历史库所在的盘', path: facts.targetDirectory, bytes: facts.targetBytes, includesMargin: true },
    { ...probes.temporary, label: '临时目录', path: facts.temporaryDirectory, bytes: facts.temporaryBytes },
    {
      ...probes.sqliteTemporary, label: '数据库临时文件目录', path: facts.sqliteTemporaryDirectory,
      bytes: facts.sqliteTemporaryBytes
    }
  ], marginBytes);
}

/** fs.stat of the directory, or of its nearest existing ancestor: its device. */
export async function largeMergeDiskDevice(directory: string): Promise<number | undefined> {
  let current = path.resolve(directory);
  for (;;) {
    const info = await fs.stat(current).catch(() => undefined);
    if (info) return knownDiskDevice(info.dev);
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
