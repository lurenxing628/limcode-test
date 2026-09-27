import * as fs from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import * as path from 'node:path';
import { realPath } from './realPath';

/**
 * The extension host process holds SQLite connections: the Runtime database worker thread with its
 * online backups, and the connections that merges, history inspection, data-directory relocation and
 * copy verification open on other databases and on private copies. SQLite's unix VFS keeps its locks
 * as POSIX fcntl locks, which belong to the process and are all dropped when any descriptor of that
 * file in the process is closed. A file tool or entry point that opens a database, its -wal or above
 * all its -shm inside this process silently releases those locks: another process may then write
 * under it (lost writes, SQLITE_PROTOCOL, torn snapshots). Writing, truncating or deleting those
 * files corrupts the database outright on every platform, and deleting a private copy while it is
 * being written or read makes that backup or verification fail.
 *
 * Only the Runtime worker registers its database by identity (registerInProcessSqliteDatabase); every
 * other database this process opens carries one of LimCode's own names below, so they are refused by
 * name wherever they are.
 *
 * Every in-process file entry point (read, write/edit/delete planning and dispatch, transfer, local
 * attachments, exports) asks this guard before touching a local path. The guard itself only uses
 * stat and realpath, which never open a descriptor. Shell commands run in child processes and are
 * not affected, so the refusal points there.
 */
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const;
/**
 * Databases LimCode itself writes: `limcode.sqlite` (every data set, and the private copies merges
 * and inspection make in temporary directories), `limcode.epoch-N.sqlite` (epoch migration backups)
 * and `limcode.sqlite.<pid>.tmp` (merge backup staging), with sidecars.
 */
const LIMCODE_DATABASE_FILE_NAME = /^limcode\.(?:.*\.)?sqlite(?:[.-].*)?$/;
/**
 * Private copies a data set's control root holds while this process uses them, with sidecars: the
 * Backup API copies of the open database behind a merge pre-copy (`merge-precopy-<pid>-<uuid>`), a
 * relocation row count (`relocation-count-<pid>-<uuid>`) and a bulk-copy verification
 * (`copy-verify-<uuid>`).
 */
const LIMCODE_STAGING_DATABASE_FILE_NAME = /^(?:merge-precopy|relocation-count|copy-verify)-.+\.sqlite(?:-wal|-shm|-journal)?$/;

/** Databases whose connection lives in this process right now (the Runtime worker registers its own). */
const inProcessDatabases = new Map<symbol, string>();

export interface SqliteDatabaseFileGuardOptions {
  /** The operation also reaches everything below a directory target (recursive delete). */
  recursive?: boolean;
}

export interface SqliteDatabaseFileRefusal {
  targetPath: string;
  databasePath: string;
  reason: string;
}

export class SqliteDatabaseFileAccessError extends Error {
  public readonly code = 'sqlite_database_file_refused';

  public constructor(public readonly refusal: SqliteDatabaseFileRefusal) {
    super(sqliteDatabaseFileRefusalMessage(refusal));
    this.name = 'SqliteDatabaseFileAccessError';
  }
}

/**
 * Marks a database as opened by a connection in this process until the returned release runs. Its
 * files are then refused under any name that reaches the same inode (hard links, aliases, case or
 * short-name spellings), and a recursive operation on any directory above it is refused as well.
 */
export function registerInProcessSqliteDatabase(databasePath: string): () => void {
  const key = Symbol(databasePath);
  inProcessDatabases.set(key, path.resolve(databasePath));
  return () => {
    inProcessDatabases.delete(key);
  };
}

export async function assertNotSqliteDatabaseFile(
  targetPath: string,
  options: SqliteDatabaseFileGuardOptions = {}
): Promise<void> {
  const refusal = await sqliteDatabaseFileRefusal(targetPath, options);
  if (refusal) throw new SqliteDatabaseFileAccessError(refusal);
}

/**
 * Refused, both under the path as given and under its real path (links resolved):
 * - LimCode's own database names with their `-wal`, `-shm`, `-journal`, anywhere, compared
 *   case-insensitively. Every LimCode data set (the current one, old workspace-scope sets, merge
 *   backups, cutover archives) and every private copy LimCode stages keeps its database under these
 *   names, and no file tool needs those bytes in-process;
 * - any `X-wal`, `X-shm` or `X-journal` whose main database `X` is a file beside it, for SQLite
 *   databases other extensions in this host may hold;
 * - any `X` that has one of those sidecars beside it: a database in use or not cleanly closed;
 * - the same file as a database registered by {@link registerInProcessSqliteDatabase}, by device and
 *   inode, and with `recursive`, a directory that contains one.
 */
export async function sqliteDatabaseFileRefusal(
  targetPath: string,
  options: SqliteDatabaseFileGuardOptions = {}
): Promise<SqliteDatabaseFileRefusal | undefined> {
  const lexical = path.resolve(targetPath);
  const real = await realPathOfNearestExisting(lexical);
  for (const candidate of lexical === real ? [lexical] : [lexical, real]) {
    const byName = await refusalByName(candidate);
    if (byName) return { targetPath: lexical, ...byName };
  }
  const byIdentity = await refusalByInProcessIdentity(real, options.recursive === true);
  return byIdentity ? { targetPath: lexical, ...byIdentity } : undefined;
}

export function sqliteDatabaseFileRefusalMessage(refusal: SqliteDatabaseFileRefusal): string {
  return `拒绝在 LimCode 扩展宿主进程内访问 SQLite 数据库文件：${refusal.targetPath}（${refusal.reason}）。`
    + 'LimCode 在同一进程里持有 SQLite 连接，进程内打开再关闭数据库、-wal 或 -shm 文件会释放 SQLite 的 POSIX 文件锁，'
    + '写入或删除它们会直接损坏数据库。'
    + `需要查看内容时，请改用终端命令在子进程里只读访问，例如 sqlite3 -readonly "${refusal.databasePath}" ".tables"；`
    + `需要副本时用 sqlite3 -readonly "${refusal.databasePath}" ".backup '/path/to/copy.sqlite'"，不要直接复制、读取或改写这些文件。`;
}

async function refusalByName(candidate: string): Promise<Omit<SqliteDatabaseFileRefusal, 'targetPath'> | undefined> {
  const name = path.basename(candidate).toLowerCase();
  const suffix = SQLITE_SIDECAR_SUFFIXES.find((entry) => name.length > entry.length && name.endsWith(entry));
  const mainPath = suffix ? candidate.slice(0, candidate.length - suffix.length) : candidate;
  if (LIMCODE_DATABASE_FILE_NAME.test(name) || LIMCODE_STAGING_DATABASE_FILE_NAME.test(name)) {
    return { databasePath: mainPath, reason: suffix ? `LimCode 数据库的 ${suffix} 伴随文件` : 'LimCode 数据库文件' };
  }
  if (suffix) {
    return await isFile(mainPath)
      ? { databasePath: mainPath, reason: `SQLite 数据库 ${path.basename(mainPath)} 的 ${suffix} 伴随文件` }
      : undefined;
  }
  for (const sidecar of SQLITE_SIDECAR_SUFFIXES) {
    if (await statOrUndefined(`${candidate}${sidecar}`)) {
      return { databasePath: candidate, reason: `旁边存在 ${path.basename(candidate)}${sidecar}，是正在使用或未正常关闭的 SQLite 数据库` };
    }
  }
  return undefined;
}

async function refusalByInProcessIdentity(
  real: string,
  recursive: boolean
): Promise<Omit<SqliteDatabaseFileRefusal, 'targetPath'> | undefined> {
  if (inProcessDatabases.size === 0) return undefined;
  const target = await statOrUndefined(real);
  if (!target) return undefined;
  for (const databasePath of new Set(inProcessDatabases.values())) {
    for (const file of [databasePath, ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${databasePath}${suffix}`)]) {
      if (sameFile(target, await statOrUndefined(file))) {
        return { databasePath, reason: `与本进程正在使用的数据库文件 ${path.basename(file)} 是同一个文件` };
      }
    }
    if (!recursive || !target.isDirectory()) continue;
    let current = path.dirname(await realPathOfNearestExisting(databasePath));
    for (;;) {
      if (sameFile(target, await statOrUndefined(current))) {
        return { databasePath, reason: '目录里包含本进程正在使用的 SQLite 数据库' };
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return undefined;
}

function sameFile(left: BigIntStats, right: BigIntStats | undefined): boolean {
  return !!right && left.dev === right.dev && left.ino === right.ino;
}

async function isFile(target: string): Promise<boolean> {
  return (await statOrUndefined(target))?.isFile() === true;
}

async function statOrUndefined(target: string): Promise<BigIntStats | undefined> {
  try {
    return await fs.stat(target, { bigint: true });
  } catch {
    return undefined;
  }
}

/** Real path of `input`, resolving its nearest existing ancestor when the file itself does not exist. */
async function realPathOfNearestExisting(input: string): Promise<string> {
  let current = input;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await realPath(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return input;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** The databases registered by {@link registerInProcessSqliteDatabase} right now (their main files). */
export function inProcessSqliteDatabasePaths(): string[] {
  return [...new Set(inProcessDatabases.values())];
}
