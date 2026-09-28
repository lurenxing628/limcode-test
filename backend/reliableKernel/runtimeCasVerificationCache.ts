import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { toSqliteFilePath } from './sqliteFilePath';
import { resolveVscodeRuntimeMergeLedgerRoot } from './vscodeRootAuthority';

/**
 * What a CAS transfer needs of its record of verified files (see transferCas): the SHA-256 of the file
 * at an absolute path was verified while it had this identity (`dev:ino:size:mtimeNs:ctimeNs`). A Map
 * serves one merge; historical merges use {@link openRuntimeCasVerificationCache}.
 */
export interface RuntimeCasVerifier {
  get(file: string): string | undefined;
  set(file: string, identity: string): unknown;
  delete(file: string): unknown;
}

export interface RuntimeCasVerificationCache extends RuntimeCasVerifier {
  /** Writes what is still pending and lets go of the shared connection (idempotent). */
  close(): void;
  /**
   * How many verified identities this cache did not keep, since it was opened by anyone: its file
   * could not be used and the ones kept in memory instead reached their bound (MEMORY_ENTRIES), or a
   * write of pending entries failed (another window held the file longer than BUSY_MS, no room).
   * What is still pending is written first, so the count is final for everything set so far. Such
   * objects are hashed again wherever they are checked next.
   */
  unrecorded(): number;
}

/**
 * The verified CAS files of one configuration root, kept on disk so that a large-merge preparation
 * that did not run, a later preparation and the session hash each unchanged object only once
 * (`.limcode-runtime-merges/limcode.cas-verified.sqlite`). Not authoritative: an identity that
 * differs in anything (any rewrite, copy or restore changes it) hashes the file in full, and a cache
 * that cannot be opened, read or written only costs hashing again. A damaged file is replaced; a
 * file that cannot be used at all keeps at most {@link MEMORY_ENTRIES} entries in memory, the rest
 * is counted (unrecorded) so that a caller relying on them can say so, as are the entries of a batched
 * write that failed. Writes are batched; entries
 * not refreshed for {@link MAX_AGE_MS} are dropped.
 *
 * POSIX lock rule (see sqliteDatabaseFileGuard): the file carries one of LimCode's own database names,
 * so no in-process file tool opens it, and this process keeps at most one connection to it, shared by
 * every caller on this thread and closed with the last one.
 */
export async function openRuntimeCasVerificationCache(configurationRootPath: string): Promise<RuntimeCasVerificationCache> {
  const root = path.resolve(configurationRootPath);
  const directory = resolveVscodeRuntimeMergeLedgerRoot({ globalStoragePath: root });
  const file = path.join(directory, CACHE_FILE);
  let shared = OPEN.get(file);
  if (!shared) {
    const created: SharedCache = { refs: 0, pending: new Map(), opened: Promise.resolve(), unrecorded: 0 };
    created.opened = openDatabase(root, directory, file).then((database) => {
      created.database = database;
      created.statements = {
        read: database.prepare('SELECT identity FROM verified_file WHERE path = ?').pluck(),
        write: database.prepare('INSERT OR REPLACE INTO verified_file (path, identity, verified_at) VALUES (?, ?, ?)'),
        remove: database.prepare('DELETE FROM verified_file WHERE path = ?')
      };
    }, () => undefined);
    OPEN.set(file, created);
    shared = created;
  }
  shared.refs += 1;
  await shared.opened;
  return cacheHandle(file, shared);
}

/** LimCode's own database name (sqliteDatabaseFileGuard refuses it to in-process file tools). */
const CACHE_FILE = 'limcode.cas-verified.sqlite';
/** Pending writes flushed in one transaction. */
const FLUSH_AT = 256;
/** A write lock of another window is waited for this long at most (this thread must not block). */
const BUSY_MS = 50;
/** Entries of objects no merge confirmed for this long (e.g. of deleted data sets) are dropped. */
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Entries kept in memory at most while the file cannot be used (about 4 MB); more are not kept. */
const MEMORY_ENTRIES = 10_000;

interface SharedCache {
  database?: Database.Database;
  statements?: { read: Database.Statement; write: Database.Statement; remove: Database.Statement };
  refs: number;
  /** Written or removed (null) since the last flush; the record (bounded) while the file cannot be used. */
  pending: Map<string, string | null>;
  opened: Promise<void>;
  /** Identities not kept: the file could not be used and MEMORY_ENTRIES were kept already, or their write failed. */
  unrecorded: number;
}

const OPEN = new Map<string, SharedCache>();

function cacheHandle(file: string, shared: SharedCache): RuntimeCasVerificationCache {
  let closed = false;
  return {
    get(target) {
      const pending = shared.pending.get(target);
      if (pending !== undefined) return pending ?? undefined;
      if (!shared.statements) return undefined;
      try {
        const identity = shared.statements.read.get(target) as unknown;
        return typeof identity === 'string' ? identity : undefined;
      } catch {
        return undefined;
      }
    },
    set(target, identity) {
      if (!keep(shared, target)) return;
      shared.pending.set(target, identity);
      if (shared.pending.size >= FLUSH_AT) flush(shared);
    },
    delete(target) {
      if (!shared.statements) {
        shared.pending.delete(target);
        return;
      }
      shared.pending.set(target, null);
      if (shared.pending.size >= FLUSH_AT) flush(shared);
    },
    unrecorded() {
      flush(shared);
      return shared.unrecorded;
    },
    close() {
      if (closed) return;
      closed = true;
      flush(shared);
      shared.refs -= 1;
      if (shared.refs > 0) return;
      OPEN.delete(file);
      try { shared.database?.close(); } catch { /* A cache only. */ }
    }
  };
}

/** Without the file the pending entries are the whole record: bounded, what does not fit is counted. */
function keep(shared: SharedCache, target: string): boolean {
  if (shared.statements || shared.pending.has(target) || shared.pending.size < MEMORY_ENTRIES) return true;
  shared.unrecorded += 1;
  return false;
}

function flush(shared: SharedCache): void {
  const { database, statements } = shared;
  // Without the file the pending entries are this process's whole record (as a Map would be).
  if (!database || !statements || shared.pending.size === 0) return;
  const now = Date.now();
  try {
    database.transaction(() => {
      for (const [target, identity] of shared.pending) {
        if (identity === null) statements.remove.run(target);
        else statements.write.run(target, identity, now);
      }
    })();
  } catch {
    // Busy (another window writes) or no room: these entries are verified again next time, and counted.
    for (const identity of shared.pending.values()) if (identity !== null) shared.unrecorded += 1;
  }
  shared.pending.clear();
}

async function openDatabase(root: string, directory: string, file: string): Promise<Database.Database> {
  await assertNoSymbolicPrefix(root, directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    return await openFile(file);
  } catch (error) {
    // A damaged or foreign file is only a cache: replaced once (another process may still use the old one).
    if (!isDamaged(error)) throw error;
    for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${file}${suffix}`, { force: true });
    return openFile(file);
  }
}

async function openFile(file: string): Promise<Database.Database> {
  const database = new Database(toSqliteFilePath(file));
  try {
    database.pragma(`busy_timeout = ${BUSY_MS}`);
    database.pragma('journal_mode = WAL');
    database.pragma('synchronous = NORMAL');
    database.exec(`CREATE TABLE IF NOT EXISTS verified_file (
      path TEXT PRIMARY KEY, identity TEXT NOT NULL, verified_at INTEGER NOT NULL
    ) WITHOUT ROWID`);
    // Pruning waits for no other window: busy now, done at a later opening.
    try { database.prepare('DELETE FROM verified_file WHERE verified_at < ?').run(Date.now() - MAX_AGE_MS); }
    catch (error) { if (!isBusy(error)) throw error; }
    await fs.chmod(file, 0o600).catch(() => undefined);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function isDamaged(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && (code.startsWith('SQLITE_CORRUPT') || code.startsWith('SQLITE_NOTADB'));
}

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED'));
}

async function assertNoSymbolicPrefix(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('CAS verification cache escapes its configuration root.');
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
    if (info.isSymbolicLink()) throw new Error(`CAS verification cache path is a symbolic link: ${current}`);
  }
}
