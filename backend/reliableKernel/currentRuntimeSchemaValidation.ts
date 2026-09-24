import Database from 'better-sqlite3';
import type { RootBinding } from './contracts';
import { assertCurrentSchema, configureReaderConnection } from './databaseSchema';
import { RUNTIME_DOMAIN_SCHEMAS } from './schema/domainManifest';
import { assertRuntimePhysicalSchemaFingerprint } from './runtimePhysicalSchemaFingerprint';
import { toSqliteFilePath } from './sqliteFilePath';

/** Current-epoch startup is strictly read-only: unknown drift is never repaired in place. */
export async function validateCurrentRuntimeSchema(binding: RootBinding): Promise<void> {
  const database = new Database(toSqliteFilePath(binding.paths.databasePath), {
    readonly: true,
    fileMustExist: true
  });
  try {
    configureReaderConnection(database);
    database.exec('BEGIN');
    try {
      assertCurrentSchema(database, binding);
      assertRuntimePhysicalSchemaFingerprint(database, RUNTIME_DOMAIN_SCHEMAS);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}
