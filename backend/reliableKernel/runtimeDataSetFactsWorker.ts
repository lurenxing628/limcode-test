import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { RUNTIME_KERNEL_EPOCH, type RootBinding } from './contracts';
import { assertCurrentSchema, assertDatabaseBinding, configureReaderConnection } from './databaseSchema';
import { readRuntimeDataSetSummary, runtimeDataSetContentDigest } from './runtimeDataSetContent';
import { inventoryRelocatedWork } from './relocatedWorkInventory';
import {
  RUNTIME_HISTORY_RECORD_DOMAINS, type RuntimeDataSetFacts, type RuntimeDataSetFactsWorkerData, type RuntimeDataSetFactsWorkerResponse,
  type RuntimeDataSetHistoryIds
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
      ...(input.summary ? { summary: readRuntimeDataSetSummary(database) } : {}),
      ...(input.historyIds ? { historyIds: readHistoryIds(database) } : {}),
      ...(input.relocatedWork ? { relocatedWork: inventoryRelocatedWork(database) } : {})
    };
  } finally {
    database.close();
  }
}

/**
 * Epoch-agnostic: an upgrade to epoch 5 only added tables, so every table read here exists unchanged
 * in the published epochs 3 and 4, except the ones added later (read as empty). Every table is read
 * by itself (NOT INDEXED), never through an index, and joined here: a copy whose index lost entries
 * must not look as if it held less history, or fewer visible messages, than it does.
 */
function readHistoryIds(database: Database.Database): RuntimeDataSetHistoryIds {
  const present = new Set(database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").pluck().all() as string[]);
  const rows = (table: string, columns: readonly string[]): string[][] => {
    if (!present.has(table)) {
      if (table === 'conversation' || table.startsWith('message')) throw new Error(`Historical table ${table} is missing.`);
      return [];
    }
    const values = database.prepare(`SELECT ${columns.map((column) => `"${column}"`).join(', ')} FROM "${table}" NOT INDEXED`).raw().all() as unknown[][];
    return values.map((row) => row.map((value, index) => {
      if (typeof value === 'string' && value.length > 0) return value;
      // A byte length is an integer column: kept as decimal text.
      if (typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value))) return String(value);
      throw new Error(`Historical ${table}.${columns[index]} is not non-empty text.`);
    }));
  };
  const ids = (table: string): string[] => rows(table, ['id']).map(([id]) => id);
  const records: Record<string, string[]> = {};
  for (const domain of RUNTIME_HISTORY_RECORD_DOMAINS) records[domain.key] = ids(domain.table);
  // Visible: not deleted, with a current revision (what every reader of the history shows).
  const deleted = new Set<string>();
  for (const [id, deletedAt] of rawRows(database, 'message', ['id', 'deleted_at'])) if (deletedAt !== null) deleted.add(String(id));
  const visibleMessages: Array<[string, string, string]> = [];
  for (const [linkId, messageId, revisionId] of rows('message_current_revision_link', ['id', 'message_id', 'revision_id'])) {
    if (!deleted.has(messageId)) visibleMessages.push([messageId, linkId, revisionId]);
  }
  return {
    conversations: ids('conversation'),
    messageRevisions: ids('message_revision'),
    records,
    visibleMessages,
    contents: rows('content_object', ['id', 'storage_key', 'byte_length']).map(([id, key, length]) => [id, key, length])
  };
}

/** Rows as they are (a nullable column stays null), from the table itself. */
function rawRows(database: Database.Database, table: string, columns: readonly string[]): unknown[][] {
  return database.prepare(`SELECT ${columns.map((column) => `"${column}"`).join(', ')} FROM "${table}" NOT INDEXED`).raw().all() as unknown[][];
}
