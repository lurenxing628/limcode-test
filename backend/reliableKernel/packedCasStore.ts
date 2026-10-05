import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isMainThread } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { syncDirectoryDurablySync } from '../capabilities/filesystem/durableDirectorySync';
import { requireCasObjectIdentity, type CasObjectIdentity } from './casObjectAccess';
import { freezeRootBinding, RUNTIME_KERNEL_EPOCH, type RootBinding } from './contracts';
import { looseCasObjectLocation, verifyCasObjectBytes } from './looseCasObjectAccess';
import {
  PACKED_CAS_FILE, PACKED_CAS_MAX_BODY_BYTES, PACKED_CAS_MAX_QUEUED_BYTES,
  packedCasRequestCharge, type PackedCasOpenOptions, type PackedCasPlacement, type PackedCasPublication
} from './packedCasWorkerProtocol';
import { toSqliteFilePath } from './sqliteFilePath';

const METADATA_SQL = 'CREATE TABLE cas_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), data_set_id TEXT NOT NULL, root_instance_id TEXT NOT NULL, root_generation INTEGER NOT NULL CHECK (root_generation > 0))';
const BODY_SQL = `CREATE TABLE cas_body (digest BLOB NOT NULL CHECK (typeof(digest) = 'blob' AND length(digest) = 32), body BLOB NOT NULL CHECK (typeof(body) = 'blob' AND length(body) <= ${PACKED_CAS_MAX_BODY_BYTES}))`;
const INDEX_SQL = 'CREATE UNIQUE INDEX cas_body_digest ON cas_body (digest)';
// A corrupt oversized value must be rejected before SQLite materializes it into a JS Buffer.
const READ_BODY_SQL = `SELECT CASE WHEN typeof(body) = 'blob' AND length(body) <= ${PACKED_CAS_MAX_BODY_BYTES} THEN body ELSE NULL END AS body FROM cas_body WHERE digest = ?`;
const EXPECTED_SCHEMA = [
  ['index', 'cas_body_digest', 'cas_body', INDEX_SQL],
  ['table', 'cas_body', 'cas_body', BODY_SQL],
  ['table', 'cas_metadata', 'cas_metadata', METADATA_SQL]
];
const BUSY_DELAYS_MS = [10, 25, 50];
const WAL_PUBLICATION_PAUSE_BYTES = 32 * 1024 * 1024;
const busyWait = new Int32Array(new SharedArrayBuffer(4));

/**
 * The physical small-body backend. Every SQLite call runs in a worker. The owner supplies the
 * authoritative root fence; snapshots use their recorded source identity with private paths.
 * Opening an old loose-only root is read-only with respect to its filesystem.
 */
export class PackedCasStore {
  public readonly databasePath: string;
  private readonly binding: RootBinding;
  private readonly readOnly: boolean;
  private database?: Database.Database;
  private identity?: fs.BigIntStats;
  private rootIdentity?: fs.BigIntStats;
  private closed = false;

  public constructor(binding: RootBinding, options: PackedCasOpenOptions = {}) {
    if (isMainThread) throw new Error('Packed CAS SQLite connections belong to worker threads.');
    if (binding.runtimeKernelEpoch !== RUNTIME_KERNEL_EPOCH) throw corrupt('Packed CAS requires current Runtime reader admission.');
    this.binding = freezeRootBinding(binding);
    this.readOnly = options.readOnly === true;
    this.databasePath = path.join(binding.paths.casRootPath, PACKED_CAS_FILE);
    this.withBusyRetry(() => this.openExisting());
  }

  public readBytes(object: CasObjectIdentity): Buffer | undefined {
    const identity = requireCasObjectIdentity(object);
    return this.withBusyRetry(() => {
      const database = this.openExisting();
      if (!database) return undefined;
      const row = database.prepare(READ_BODY_SQL).get(Buffer.from(identity.sha256, 'hex')) as { body: unknown } | undefined;
      this.assertFileIdentity();
      if (!row) return undefined;
      if (!Buffer.isBuffer(row.body) || row.body.length > PACKED_CAS_MAX_BODY_BYTES) throw corrupt('Invalid packed CAS body.');
      // Per-key proof only. This never hashes another body or the mutable SQLite file.
      return Buffer.from(verifyCasObjectBytes(identity, row.body));
    });
  }

  /** Presence/length only, preserving Runtime admission and backup coverage proof strength. */
  public inspectByteLength(object: CasObjectIdentity): bigint | undefined {
    const identity = requireCasObjectIdentity(object);
    return this.withBusyRetry(() => {
      const database = this.openExisting();
      if (!database) return undefined;
      const row = database.prepare('SELECT typeof(body) AS body_type, length(body) AS byte_length FROM cas_body WHERE digest = ?')
        .get(Buffer.from(identity.sha256, 'hex')) as { body_type: unknown; byte_length: unknown } | undefined;
      this.assertFileIdentity();
      if (!row) return undefined;
      if (row.body_type !== 'blob' || typeof row.byte_length !== 'number' || !Number.isSafeInteger(row.byte_length)
        || row.byte_length < 0 || row.byte_length > PACKED_CAS_MAX_BODY_BYTES) throw corrupt('Invalid packed CAS body length.');
      return BigInt(row.byte_length);
    });
  }

  public publishBatch(entries: readonly PackedCasPublication[]): PackedCasPlacement[] {
    this.assertOpen();
    if (this.readOnly) throw new Error('A read-only packed CAS owner cannot publish.');
    if (packedCasRequestCharge({ kind: 'publishBatch', entries: [...entries] }) > PACKED_CAS_MAX_QUEUED_BYTES) {
      throw new RangeError('Packed CAS publication batch exceeds its byte budget.');
    }
    const inputs = entries.map(entry => {
      const object = requireCasObjectIdentity(entry.object);
      const bytes = Buffer.from(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
      if (bytes.length > PACKED_CAS_MAX_BODY_BYTES || BigInt(bytes.length) !== object.byte_length) {
        throw new RangeError('Packed CAS publication requires an exact body of at most 8192 bytes.');
      }
      return { object, bytes, digest: Buffer.from(object.sha256, 'hex') };
    });
    if (!inputs.length) return [];
    return this.withBusyRetry(() => {
      // Validate a present store even when every requested key is still stored loose.
      let database = this.openExisting();
      const loose = inputs.map(entry => {
        if (database?.prepare('SELECT 1 FROM cas_body WHERE digest = ?').get(entry.digest)) return false;
        return existingLooseMatches(this.binding.paths.casRootPath, entry.object, entry.bytes);
      });
      if (!database && loose.every(Boolean)) {
        syncReusedLooseDirectories(this.binding.paths.casRootPath, inputs.map(entry => entry.object));
        return loose.map(() => 'loose');
      }
      database ??= this.createAndOpen();
      this.assertWalBudget(database);
      const select = database.prepare(READ_BODY_SQL);
      const insert = database.prepare('INSERT INTO cas_body (digest, body) VALUES (?, ?)');
      const publish = database.transaction(() => {
        return inputs.map((entry, index): PackedCasPlacement => {
          const row = select.get(entry.digest) as { body: unknown } | undefined;
          if (row) {
            if (!Buffer.isBuffer(row.body) || row.body.length > PACKED_CAS_MAX_BODY_BYTES || !row.body.equals(entry.bytes)) {
              throw corrupt('Existing packed CAS object does not match its published bytes.');
            }
            return 'packed';
          }
          // A committed packed row wins. Existing loose digests are reused without moving bytes.
          if (loose[index] || existingLooseMatches(this.binding.paths.casRootPath, entry.object, entry.bytes)) return 'loose';
          insert.run(entry.digest, entry.bytes);
          return 'packed';
        });
      });
      const result = publish.immediate();
      this.assertFileIdentity();
      syncReusedLooseDirectories(this.binding.paths.casRootPath,
        inputs.filter((_entry, index) => result[index] === 'loose').map(entry => entry.object));
      // FULL commits precede this acknowledgement and every Runtime ContentObject transaction.
      return result;
    });
  }

  /** The caller snapshots Runtime metadata first; later immutable/orphan body rows are harmless. */
  public async snapshot(destination: string): Promise<boolean> {
    const database = this.withBusyRetry(() => this.openExisting());
    if (!database) return false;
    const target = path.resolve(destination);
    if (target === path.resolve(this.databasePath)) throw new Error('Packed CAS snapshot must have an independent destination.');
    // Exclusive reservation avoids overwriting an existing mutable container or backup.
    const descriptor = fs.openSync(target, 'wx', 0o600);
    fs.closeSync(descriptor);
    try {
      let remaining: number | undefined;
      let stalls = 0;
      let restarts = 0;
      await database.backup(toSqliteFilePath(target), { progress: progress => {
        if (remaining !== undefined && progress.remainingPages >= remaining) {
          if (progress.remainingPages > remaining) restarts += 1;
          else stalls += 1;
          if (stalls > BUSY_DELAYS_MS.length || restarts > BUSY_DELAYS_MS.length) {
            throw Object.assign(new Error('Packed CAS snapshot could not make bounded progress; retry the same snapshot.'), { code: 'SQLITE_BUSY' });
          }
          Atomics.wait(busyWait, 0, 0, BUSY_DELAYS_MS[Math.min(stalls, BUSY_DELAYS_MS.length) - 1] ?? BUSY_DELAYS_MS[0]);
        } else stalls = 0;
        remaining = progress.remainingPages;
        return 256;
      } });
      this.assertFileIdentity();
      const destinationDatabase = new Database(toSqliteFilePath(target), { fileMustExist: true, timeout: 50 });
      try {
        configure(destinationDatabase, false, true);
        assertSchemaAndBinding(destinationDatabase, this.binding);
        const checkpoint = destinationDatabase.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number; log: number; checkpointed: number }>;
        if (checkpoint[0]?.busy !== 0 || checkpoint[0].log !== checkpoint[0].checkpointed) {
          throw new Error('Packed CAS snapshot checkpoint did not finish.');
        }
      } finally { destinationDatabase.close(); }
      // backup() has closed its destination connection. Only this newly reserved copy is opened
      // for fsync, never a live source database/WAL/SHM descriptor in the process.
      const copy = fs.openSync(target, 'r');
      try { fs.fsyncSync(copy); } finally { fs.closeSync(copy); }
      syncDirectoryDurablySync(path.dirname(target));
      return true;
    } catch (error) {
      // The Backup API has settled and owns no destination handle here.
      for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${target}${suffix}`, { force: true });
      syncDirectoryDurablySync(path.dirname(target));
      throw error;
    }
  }

  public close(): void {
    if (this.closed) return;
    // Leave the owner fenced and retryable if SQLite refuses to close an outstanding handle.
    this.database?.close();
    this.database = undefined;
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Packed CAS owner is closed.');
  }

  private assertFileIdentity(): void {
    const root = statOrUndefined(this.binding.paths.casRootPath, false);
    if (this.rootIdentity && (!root?.isDirectory() || !sameFile(root, this.rootIdentity))) {
      throw corrupt('Packed CAS root changed while its owner was open.');
    }
    if (!root?.isDirectory()) throw corrupt('Packed CAS root is missing or is not a directory.');
    const current = statOrUndefined(this.databasePath, true);
    if (!current?.isFile() || (this.identity && !sameFile(current, this.identity))) {
      throw corrupt('Packed CAS database changed while its owner was open.');
    }
    this.assertCompanionFiles();
  }

  private assertCompanionFiles(): void {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const info = statOrUndefined(`${this.databasePath}${suffix}`, true);
      if (info && !info.isFile()) throw corrupt('Packed CAS companion must be a regular file.');
    }
  }

  private openExisting(): Database.Database | undefined {
    this.assertOpen();
    if (this.database) {
      this.assertFileIdentity();
      return this.database;
    }
    let info = statOrUndefined(this.databasePath, true);
    if (!info) {
      const companion = ['-wal', '-shm', '-journal'].some(suffix => statOrUndefined(`${this.databasePath}${suffix}`, true));
      if (!companion) return undefined;
      // A competing creator publishes the initialized main before opening its WAL. Recheck the
      // main after observing a companion so that legitimate first-publication race is admitted.
      info = statOrUndefined(this.databasePath, true);
      if (!info) throw corrupt('Packed CAS companion exists without its database.');
    }
    if (!info.isFile()) throw corrupt('Packed CAS database must be a regular file.');
    this.assertCompanionFiles();
    const root = fs.statSync(this.binding.paths.casRootPath, { bigint: true });
    if (!root.isDirectory()) throw corrupt('Packed CAS root must be a directory.');
    const database = new Database(toSqliteFilePath(this.databasePath), {
      readonly: this.readOnly, fileMustExist: true, timeout: 50
    });
    try {
      configure(database, this.readOnly);
      assertSchemaAndBinding(database, this.binding);
      this.identity = info;
      this.rootIdentity = root;
      this.assertFileIdentity();
      this.database = database;
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private createAndOpen(): Database.Database {
    const root = this.binding.paths.casRootPath;
    try { fs.mkdirSync(root); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!fs.statSync(root).isDirectory()) throw corrupt('Packed CAS root is not a directory.');
    }
    syncDirectoryDurablySync(root);
    syncDirectoryDurablySync(path.dirname(root));
    const temporary = path.join(root, `limcode.cas-small.${process.pid}.${randomUUID()}.sqlite`);
    let staging: Database.Database | undefined;
    try {
      staging = new Database(toSqliteFilePath(temporary), { timeout: 50 });
      configure(staging, false, true);
      const initialize = staging.transaction(() => {
        staging!.exec(`${METADATA_SQL}; ${BODY_SQL}; ${INDEX_SQL};`);
        staging!.prepare('INSERT INTO cas_metadata (singleton, data_set_id, root_instance_id, root_generation) VALUES (1, ?, ?, ?)')
          .run(this.binding.dataSetId, this.binding.rootInstanceId, this.binding.rootGeneration);
      });
      initialize.immediate();
      assertSchemaAndBinding(staging, this.binding);
      const checkpoint = staging.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number; log: number; checkpointed: number }>;
      if (checkpoint[0]?.busy !== 0 || checkpoint[0].log !== checkpoint[0].checkpointed) throw new Error('Packed CAS initialization checkpoint did not finish.');
      staging.close();
      staging = undefined;
      // Only the closed, checkpointed file is published. Competing creators never see an empty
      // or partly initialized store, and an existing unknown/corrupt store is never replaced.
      try { fs.linkSync(temporary, this.databasePath); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      syncDirectoryDurablySync(root);
    } finally {
      staging?.close();
      for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(`${temporary}${suffix}`, { force: true });
      syncDirectoryDurablySync(root);
    }
    const database = this.openExisting();
    if (!database) throw corrupt('Packed CAS database disappeared during publication.');
    return database;
  }

  private withBusyRetry<T>(operation: () => T): T {
    for (let attempt = 0; ; attempt += 1) {
      try { return operation(); } catch (error) {
        const code = (error as { code?: unknown })?.code;
        if ((code !== 'SQLITE_BUSY' && code !== 'SQLITE_LOCKED') || attempt >= BUSY_DELAYS_MS.length) throw error;
        Atomics.wait(busyWait, 0, 0, BUSY_DELAYS_MS[attempt]);
      }
    }
  }

  private assertWalBudget(database: Database.Database): void {
    const wal = statOrUndefined(`${this.databasePath}-wal`, true);
    if (!wal || wal.size < BigInt(WAL_PUBLICATION_PAUSE_BYTES)) return;
    const checkpoint = database.pragma('wal_checkpoint(PASSIVE)') as Array<{ busy: number; log: number; checkpointed: number }>;
    if (checkpoint[0]?.busy !== 0 || checkpoint[0].log !== checkpoint[0].checkpointed) {
      // Autocheckpoint is not a size cap. Stop append growth while another reader pins WAL frames.
      // The threshold may be exceeded by one bounded caller batch; no exact byte cap is claimed.
      throw Object.assign(new Error('Packed CAS WAL is pinned by a reader; retry the same publication after it closes.'), { code: 'SQLITE_BUSY' });
    }
  }
}

function configure(database: Database.Database, readOnly: boolean, creating = false): void {
  database.pragma('busy_timeout = 50');
  database.pragma('cache_size = -2048');
  database.pragma('mmap_size = 0');
  if (creating) database.pragma('journal_mode = WAL');
  if (database.pragma('journal_mode', { simple: true }) !== 'wal') throw corrupt('Packed CAS database is not in WAL mode.');
  if (readOnly) database.pragma('query_only = ON');
  else {
    database.pragma('synchronous = FULL');
    if (database.pragma('synchronous', { simple: true }) !== 2) throw new Error('Packed CAS requires synchronous=FULL.');
    database.pragma('wal_autocheckpoint = 256');
    database.pragma('journal_size_limit = 8388608');
  }
}

function assertSchemaAndBinding(database: Database.Database, binding: RootBinding): void {
  const schema = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .raw().all() as unknown[][];
  if (JSON.stringify(schema) !== JSON.stringify(EXPECTED_SCHEMA)) throw corrupt('Packed CAS schema does not match its exact physical contract.');
  assertBinding(database, binding);
}

function assertBinding(database: Database.Database, binding: RootBinding): void {
  const rows = database.prepare('SELECT singleton, data_set_id, root_instance_id, root_generation FROM cas_metadata LIMIT 2').all() as Array<Record<string, unknown>>;
  const row = rows[0];
  if (rows.length !== 1 || row.singleton !== 1 || row.data_set_id !== binding.dataSetId
    || row.root_instance_id !== binding.rootInstanceId || row.root_generation !== binding.rootGeneration) {
    throw corrupt('Packed CAS identity does not match the authoritative RootBinding.');
  }
}

function existingLooseMatches(root: string, object: CasObjectIdentity, expected: Buffer): boolean {
  const file = looseCasObjectLocation(root, object).absolutePath;
  const info = statOrUndefined(file, false);
  if (!info) return false;
  if (!info.isFile() || info.size !== object.byte_length) throw corrupt('Existing loose CAS object has the wrong length.');
  const descriptor = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!sameOpenedFile(info, opened) || !opened.isFile() || opened.size !== object.byte_length) throw corrupt('Existing loose CAS object changed during publication.');
    const bytes = Buffer.alloc(expected.length + 1);
    let read = 0;
    while (read < bytes.length) {
      const count = fs.readSync(descriptor, bytes, read, bytes.length - read, read);
      if (count === 0) break;
      read += count;
    }
    if (read !== expected.length || !bytes.subarray(0, read).equals(expected)) throw corrupt('Existing loose CAS object does not match its published bytes.');
    const afterRead = fs.fstatSync(descriptor, { bigint: true });
    const current = statOrUndefined(file, false);
    if (!sameFile(opened, afterRead) || !afterRead.isFile() || afterRead.size !== object.byte_length
      || !current?.isFile() || !sameFile(info, current) || current.size !== object.byte_length) {
      throw corrupt('Existing loose CAS object changed during publication.');
    }
    return true;
  } finally { fs.closeSync(descriptor); }
}

/** A competing merge may have linked the body before syncing its new ancestor directories. */
function syncReusedLooseDirectories(root: string, objects: readonly CasObjectIdentity[]): void {
  if (!objects.length) return;
  const prefixes = new Set(objects.map(object => path.dirname(looseCasObjectLocation(root, object).absolutePath)));
  for (const prefix of prefixes) syncDirectoryDurablySync(prefix);
  syncDirectoryDurablySync(path.join(root, 'sha256'));
  syncDirectoryDurablySync(root);
}

function statOrUndefined(file: string, noFollow: boolean): fs.BigIntStats | undefined {
  try { return noFollow ? fs.lstatSync(file, { bigint: true }) : fs.statSync(file, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function sameFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameOpenedFile(pathInfo: fs.BigIntStats, descriptorInfo: fs.BigIntStats): boolean {
  // Older libuv Windows path stats expose the 64-bit volume serial, while fstat exposes its
  // low 32 bits. Normalize only this cross-API comparison; same-API fences stay full-width.
  return pathInfo.ino === descriptorInfo.ino && (pathInfo.dev === descriptorInfo.dev
    || (process.platform === 'win32' && BigInt.asUintN(32, pathInfo.dev) === descriptorInfo.dev));
}

function corrupt(message: string): Error {
  return Object.assign(new Error(message), { code: 'packed-cas-corrupt' });
}
