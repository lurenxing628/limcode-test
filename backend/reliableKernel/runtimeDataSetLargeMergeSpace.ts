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
