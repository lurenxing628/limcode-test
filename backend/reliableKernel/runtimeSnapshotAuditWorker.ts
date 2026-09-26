import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { assertCurrentSchema, auditDatabaseIntegrity, configureReaderConnection } from './databaseSchema';
import { runtimeDataSetContentDigest } from './runtimeDataSetContent';
import { inspectCarriedWork, inspectUnfinishedWork } from './runtimeDataSetMergeProbes';
import { assertRuntimePhysicalSchemaFingerprint } from './runtimePhysicalSchemaFingerprint';
import type {
  RuntimeSnapshotAudit, RuntimeSnapshotAuditWorkerData, RuntimeSnapshotAuditWorkerResponse
} from './runtimeSnapshotAudit';
import { RUNTIME_DOMAIN_SCHEMAS } from './schema/domainManifest';
import { toSqliteFilePath } from './sqliteFilePath';

// Entry point of auditRuntimeSnapshot's worker; see there for the POSIX lock rule.
const data = workerData as RuntimeSnapshotAuditWorkerData;
let response: RuntimeSnapshotAuditWorkerResponse;
try {
  response = { ok: true, audit: audit(data) };
} catch (error) {
  response = {
    ok: false,
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      ...(typeof (error as { code?: unknown } | null)?.code === 'string' ? { code: (error as { code: string }).code } : {})
    }
  };
}
parentPort?.postMessage(response);

function audit(input: RuntimeSnapshotAuditWorkerData): RuntimeSnapshotAudit {
  const database = new Database(toSqliteFilePath(input.databasePath), { readonly: true, fileMustExist: true });
  try {
    configureReaderConnection(database);
    database.pragma('query_only = ON');
    assertCurrentSchema(database, input.binding);
    assertRuntimePhysicalSchemaFingerprint(database, RUNTIME_DOMAIN_SCHEMAS);
    if (!input.skipIntegrity) auditDatabaseIntegrity(database);
    const result: RuntimeSnapshotAudit = {};
    if (input.contentDigest) result.contentDigest = runtimeDataSetContentDigest(database);
    if (input.unfinishedWork === 'finalize') result.unfinishedWork = inspectUnfinishedWork(database);
    if (input.unfinishedWork === 'carry') result.carriedWork = inspectCarriedWork(database);
    if (input.measureTables) {
      let rows = 0;
      for (const table of input.measureTables) {
        rows += Number(database.prepare(`SELECT COUNT(*) FROM "${table.replace(/"/g, '""')}"`).pluck().get() as bigint);
      }
      const pageSize = Number(database.pragma('page_size', { simple: true }) as bigint | number);
      const pageCount = Number(database.pragma('page_count', { simple: true }) as bigint | number);
      result.size = { rows, bytes: pageSize * pageCount };
    }
    return result;
  } finally {
    database.close();
  }
}
