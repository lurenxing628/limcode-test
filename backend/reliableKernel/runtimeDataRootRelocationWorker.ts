import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { runtimeDataSetContentDigest } from './runtimeDataSetContent';
import { RUNTIME_DOMAIN_SCHEMA_BY_KEY } from './schema/domainManifest';
import { toSqliteFilePath } from './sqliteFilePath';

/** Input of the worker: a private copy of a receiving database and the rows a relocation inserted. */
export interface RelocationDigestWorkerData {
  databasePath: string;
  inserted: Array<[domain: string, id: string]>;
}

export type RelocationDigestWorkerResponse = { ok: true; digest: string } | { ok: false; message: string };

// Entry point of the relocation's "only its own rows" check (runtimeDataRootRelocation): on the
// private copy only (never a database any Host has open), the inserted rows are removed without
// triggers or foreign-key actions, then the content digest is taken as for a fingerprint.
const data = workerData as RelocationDigestWorkerData;
let response: RelocationDigestWorkerResponse;
try {
  const database = new Database(toSqliteFilePath(data.databasePath), { fileMustExist: true });
  try {
    database.pragma('foreign_keys = OFF');
    const triggers = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").pluck().all() as string[];
    for (const name of triggers) database.exec(`DROP TRIGGER "${name.replace(/"/g, '""')}"`);
    database.transaction(() => {
      for (const [domain, id] of data.inserted) {
        const schema = RUNTIME_DOMAIN_SCHEMA_BY_KEY.get(domain);
        if (!schema) throw new Error(`迁移日志里有未知的领域：${domain}`);
        database.prepare(`DELETE FROM "${schema.table.replace(/"/g, '""')}" WHERE id = ?`).run(id);
      }
    })();
    response = { ok: true, digest: runtimeDataSetContentDigest(database) };
  } finally {
    database.close();
  }
} catch (error) {
  response = { ok: false, message: error instanceof Error ? error.message : String(error) };
}
parentPort?.postMessage(response);
