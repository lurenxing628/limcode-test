import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { RUNTIME_KERNEL_EPOCH, type RootBinding } from './contracts';
import { assertCurrentSchema, assertDatabaseBinding, configureReaderConnection } from './databaseSchema';
import { readRuntimeDataSetSummary, runtimeDataSetContentDigest } from './runtimeDataSetContent';
import type {
  RuntimeDataSetFacts, RuntimeDataSetFactsWorkerData, RuntimeDataSetFactsWorkerResponse
} from './runtimeDataSetFacts';
import { assertPublishedPreviousRuntimeEpochSnapshot } from './runtimeEpochMigration';
import { assertRuntimePhysicalSchemaFingerprint } from './runtimePhysicalSchemaFingerprint';
import { RUNTIME_DOMAIN_SCHEMAS } from './schema/domainManifest';
import { toSqliteFilePath } from './sqliteFilePath';

// Entry point of readRuntimeDataSetFacts's worker; see there for the POSIX lock rule.
const data = workerData as RuntimeDataSetFactsWorkerData;
void read(data).then(
  (facts): RuntimeDataSetFactsWorkerResponse => ({ ok: true, facts }),
  (error: unknown): RuntimeDataSetFactsWorkerResponse => ({
    ok: false,
    error: {
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      ...(typeof (error as { code?: unknown } | null)?.code === 'string' ? { code: (error as { code: string }).code } : {})
    }
  })
).then((response) => parentPort?.postMessage(response));

async function read(input: RuntimeDataSetFactsWorkerData): Promise<Omit<RuntimeDataSetFacts, 'binding'>> {
  const database = new Database(toSqliteFilePath(input.databasePath), { readonly: true, fileMustExist: true });
  try {
    configureReaderConnection(database);
    database.pragma('query_only = ON');
    // This comparison is epoch-agnostic and makes no migration or schema compatibility claim.
    assertDatabaseBinding(database, input.binding as RootBinding);
    if (input.openable) {
      if (input.binding.runtimeKernelEpoch === RUNTIME_KERNEL_EPOCH) {
        assertCurrentSchema(database, input.binding as RootBinding);
        assertRuntimePhysicalSchemaFingerprint(database, RUNTIME_DOMAIN_SCHEMAS);
      } else {
        await assertPublishedPreviousRuntimeEpochSnapshot(database, input.binding);
      }
    }
    return {
      ...(input.contentDigest ? { contentDigest: runtimeDataSetContentDigest(database) } : {}),
      ...(input.summary ? { summary: readRuntimeDataSetSummary(database) } : {})
    };
  } finally {
    database.close();
  }
}
