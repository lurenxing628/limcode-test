import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { isDeepStrictEqual } from 'node:util';
import { runtimeDataSetContentDigest } from './runtimeDataSetContent';
import { RUNTIME_DOMAIN_SCHEMA_BY_KEY } from './schema/domainManifest';
import { toSqliteFilePath } from './sqliteFilePath';

/** Complete fixed-domain row images; INTEGERs are decimal strings so the journal is lossless JSON. */
export interface RelocationHandleStateUpdate {
  before: Record<string, string | null>;
  after: Record<string, string | null>;
}

/** Input of the worker: a private copy of a receiving database and the rows a relocation inserted. */
export interface RelocationDigestWorkerData {
  databasePath: string;
  inserted: Array<[domain: string, id: string]>;
  updated?: RelocationHandleStateUpdate[];
}

export type RelocationDigestWorkerResponse = { ok: true; digest: string | null } | { ok: false; message: string };

// Entry point of the relocation's "only its own rows" check (runtimeDataRootRelocation): on the
// private copy only (never a database any Host has open), the inserted rows are removed without
// triggers or foreign-key actions. Updated handle rows must still equal their exact after images
// before restoring their before images. The whole database digest must then equal the old one;
// no derived table or unjournaled target row is ignored. null means a proven later target edit.
const data = workerData as RelocationDigestWorkerData;
let response: RelocationDigestWorkerResponse;
try {
  const database = new Database(toSqliteFilePath(data.databasePath), { fileMustExist: true });
  try {
    database.pragma('foreign_keys = OFF');
    const triggers = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").pluck().all() as string[];
    for (const name of triggers) database.exec(`DROP TRIGGER "${name.replace(/"/g, '""')}"`);
    const restored = database.transaction(() => {
      const updates = data.updated === undefined ? [] : data.updated;
      if (!Array.isArray(updates)) throw new Error('迁移日志里的上下文目录更新列表无效。');
      if (updates.length > 0) {
        const schema = RUNTIME_DOMAIN_SCHEMA_BY_KEY.get('ConversationContextHandleState')!;
        const columns = schema.columns.map(column => column.name);
        const quoted = columns.map(name => `"${name}"`).join(', ');
        const read = database.prepare(`SELECT ${quoted} FROM "${schema.table}" WHERE id = ?`).raw(true).safeIntegers(true);
        const restore = database.prepare(`INSERT OR REPLACE INTO "${schema.table}" (${quoted}) VALUES (${columns.map(() => '?').join(', ')})`);
        const decode = (row: Record<string, string | null>): Array<string | bigint | null> => {
          if (Object.keys(row).length !== columns.length || columns.some(name => !Object.prototype.hasOwnProperty.call(row, name))) {
            throw new Error('迁移日志里的上下文目录行不完整。');
          }
          return schema.columns.map(column => {
            const value = row[column.name];
            if (value === null && column.nullable) return null;
            if (typeof value !== 'string') throw new Error('迁移日志里的上下文目录字段无效。');
            if (column.type === 'INTEGER' && /^(0|-?[1-9][0-9]*)$/.test(value)) return BigInt(value);
            if (column.type === 'TEXT') return value;
            throw new Error('迁移日志里的上下文目录字段类型无效。');
          });
        };
        for (const update of updates) {
          const before = decode(update.before);
          const after = decode(update.after);
          if (update.before.id !== update.after.id) throw new Error('迁移日志里的上下文目录身份不一致。');
          if (!isDeepStrictEqual(read.get(update.after.id), after)) return false;
          restore.run(...before);
        }
      }
      for (const [domain, id] of data.inserted) {
        const schema = RUNTIME_DOMAIN_SCHEMA_BY_KEY.get(domain);
        if (!schema) throw new Error(`迁移日志里有未知的领域：${domain}`);
        database.prepare(`DELETE FROM "${schema.table.replace(/"/g, '""')}" WHERE id = ?`).run(id);
      }
      return true;
    })();
    response = { ok: true, digest: restored ? runtimeDataSetContentDigest(database) : null };
  } finally {
    database.close();
  }
} catch (error) {
  response = { ok: false, message: error instanceof Error ? error.message : String(error) };
}
parentPort?.postMessage(response);
