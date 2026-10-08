import Database from 'better-sqlite3';
import type { RootBinding } from './contracts';
import { RUNTIME_KERNEL_EPOCH } from './contracts';
import {
  METADATA_TABLES,
  RUNTIME_DOMAIN_SCHEMAS,
  RUNTIME_SCHEMA_DIGEST,
  RUNTIME_SCHEMA_TRIGGERS,
  createRuntimeSchemaSql,
  domainSchemaDigest
} from './schema/domainManifest';
import { sameBindingIdentity } from './rootAuthority';
import { prepareCached } from './runtimeStatementCache';

export interface DatabaseFoundationInspection {
  sqliteVersion: string;
  journalMode: string;
  synchronous: bigint;
  foreignKeys: bigint;
  busyTimeoutMs: bigint;
  tables: string[];
  indexes: string[];
  triggers: string[];
  manifestDomainCount: number;
  schemaDigest: string;
  foreignKeyViolationCount: number;
}

export interface DatabaseIntegrityAudit {
  quickCheck: 'ok';
  foreignKeyViolationCount: 0;
}

export function configureWriterConnection(database: Database.Database): void {
  database.defaultSafeIntegers(true);
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = NORMAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
}

export function configureReaderConnection(database: Database.Database): void {
  database.defaultSafeIntegers(true);
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
}

export function initializeCurrentSchema(database: Database.Database, binding: RootBinding): void {
  const existingTables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: string }>;
  if (existingTables.length > 0) {
    throw new Error('Runtime database is not empty; incremental schema migration is not supported.');
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    for (const statement of createRuntimeSchemaSql()) database.exec(statement);
    insertRootBinding(database, binding);
    const manifestInsert = database.prepare(`
      INSERT INTO schema_manifest (
        domain_key, table_name, schema_owner, repository_name, codec_name,
        mutations_json, client_mapping, delete_policy, reset_policy, indexes_json,
        schema_digest, runtime_kernel_epoch
      ) VALUES (
        @domainKey, @tableName, @schemaOwner, @repositoryName, @codecName,
        @mutationsJson, @clientMapping, @deletePolicy, @resetPolicy, @indexesJson,
        @schemaDigest, @runtimeKernelEpoch
      )
    `);
    for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
      manifestInsert.run({
        domainKey: schema.key,
        tableName: schema.table,
        schemaOwner: schema.schemaOwner,
        repositoryName: schema.repository,
        codecName: schema.codec,
        mutationsJson: JSON.stringify(schema.mutations),
        clientMapping: schema.client,
        deletePolicy: schema.deletePolicy,
        resetPolicy: schema.resetPolicy,
        indexesJson: JSON.stringify(schema.indexes),
        schemaDigest: domainSchemaDigest(schema),
        runtimeKernelEpoch: BigInt(RUNTIME_KERNEL_EPOCH)
      });
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  database.pragma('wal_checkpoint(TRUNCATE)');
  assertCurrentSchema(database, binding);
}

export function assertCurrentSchema(database: Database.Database, binding: RootBinding): void {
  assertDatabaseBinding(database, binding);
  const expectedTables = new Set<string>([
    ...METADATA_TABLES,
    ...RUNTIME_DOMAIN_SCHEMAS.map((schema) => schema.table)
  ]);
  const actualTables = new Set((database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>).map((entry) => entry.name));
  if (!sameSet(expectedTables, actualTables)) {
    throw new Error(`Runtime schema table exact set mismatch: expected ${expectedTables.size}, found ${actualTables.size}.`);
  }

  const expectedTriggers = new Set(RUNTIME_SCHEMA_TRIGGERS.map((trigger) => trigger.name));
  const actualTriggers = new Set((database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
    .all() as Array<{ name: string }>).map((entry) => entry.name));
  if (!sameSet(expectedTriggers, actualTriggers)) {
    throw new Error(`Runtime schema trigger exact set mismatch: expected ${expectedTriggers.size}, found ${actualTriggers.size}.`);
  }

  const manifest = database.prepare(`
    SELECT domain_key, table_name, schema_owner, repository_name, codec_name,
           mutations_json, client_mapping, delete_policy, reset_policy, indexes_json,
           schema_digest, runtime_kernel_epoch
      FROM schema_manifest
     ORDER BY domain_key
  `).all() as Array<Record<string, unknown>>;
  if (manifest.length !== RUNTIME_DOMAIN_SCHEMAS.length) {
    throw new Error(`schema_manifest must contain ${RUNTIME_DOMAIN_SCHEMAS.length} domains.`);
  }
  const byKey = new Map(RUNTIME_DOMAIN_SCHEMAS.map((schema) => [schema.key, schema]));
  for (const row of manifest) {
    const key = requireText(row.domain_key, 'schema_manifest.domain_key');
    const schema = byKey.get(key);
    if (!schema) throw new Error(`schema_manifest contains unknown domain ${key}.`);
    const actual = {
      table: row.table_name,
      schemaOwner: row.schema_owner,
      repository: row.repository_name,
      codec: row.codec_name,
      mutations: parseJsonText(row.mutations_json),
      client: row.client_mapping,
      deletePolicy: row.delete_policy,
      resetPolicy: row.reset_policy,
      indexes: parseJsonText(row.indexes_json),
      digest: row.schema_digest,
      epoch: row.runtime_kernel_epoch
    };
    if (
      actual.table !== schema.table
      || actual.schemaOwner !== schema.schemaOwner
      || actual.repository !== schema.repository
      || actual.codec !== schema.codec
      || JSON.stringify(actual.mutations) !== JSON.stringify(schema.mutations)
      || actual.client !== schema.client
      || actual.deletePolicy !== schema.deletePolicy
      || actual.resetPolicy !== schema.resetPolicy
      || JSON.stringify(actual.indexes) !== JSON.stringify(schema.indexes)
      || actual.digest !== domainSchemaDigest(schema)
      || actual.epoch !== BigInt(RUNTIME_KERNEL_EPOCH)
    ) throw new Error(`schema_manifest mismatch for ${schema.key}.`);
  }
}

/**
 * Full-file integrity work is intentionally separate from the startup schema contract check.
 * Callers use this at explicit audit/migration boundaries; ordinary reader startup must not scan
 * the complete database again after the writer has already accepted the current contract.
 */
export function auditDatabaseIntegrity(database: Database.Database): DatabaseIntegrityAudit {
  const quickCheck = database.pragma('quick_check') as Array<{ quick_check: string }>;
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok') {
    throw new Error('Runtime database quick_check failed.');
  }
  const violations = database.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(`Runtime database has ${violations.length} foreign key violations.`);
  }
  return { quickCheck: 'ok', foreignKeyViolationCount: 0 };
}

export function assertDatabaseBinding(database: Database.Database, binding: RootBinding): void {
  const row = prepareCached(database, 'SELECT * FROM root_binding WHERE singleton = 1').get() as Record<string, unknown> | undefined;
  if (!row) throw new Error('Runtime database root_binding row is missing.');
  const stored: RootBinding = {
    paths: {
      dataRootPath: requireText(row.data_root_path, 'root_binding.data_root_path'),
      databasePath: requireText(row.database_path, 'root_binding.database_path'),
      casRootPath: requireText(row.cas_root_path, 'root_binding.cas_root_path'),
      rootPointerPath: requireText(row.root_pointer_path, 'root_binding.root_pointer_path'),
      rootPendingPath: requireText(row.root_pending_path, 'root_binding.root_pending_path'),
      runtimeEpochPath: requireText(row.runtime_epoch_path, 'root_binding.runtime_epoch_path')
    },
    dataSetId: requireText(row.data_set_id, 'root_binding.data_set_id'),
    rootInstanceId: requireText(row.root_instance_id, 'root_binding.root_instance_id'),
    rootGeneration: toSafeNumber(row.root_generation, 'root_binding.root_generation'),
    pointerRevision: toSafeNumber(row.pointer_revision, 'root_binding.pointer_revision'),
    runtimeKernelEpoch: toSafeNumber(row.runtime_kernel_epoch, 'root_binding.runtime_kernel_epoch') as typeof RUNTIME_KERNEL_EPOCH
  };
  if (!sameBindingIdentity(stored, binding)) throw new Error('Runtime database RootBinding fence mismatch.');
}

export function inspectDatabaseFoundation(database: Database.Database): DatabaseFoundationInspection {
  const sqliteVersion = (database.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version;
  const tables = (database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as Array<{ name: string }>).map((entry) => entry.name);
  const indexes = (database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as Array<{ name: string }>).map((entry) => entry.name);
  const triggers = (database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name"
  ).all() as Array<{ name: string }>).map((entry) => entry.name);
  return {
    sqliteVersion,
    journalMode: String(database.pragma('journal_mode', { simple: true })),
    synchronous: BigInt(database.pragma('synchronous', { simple: true }) as number | bigint),
    foreignKeys: BigInt(database.pragma('foreign_keys', { simple: true }) as number | bigint),
    busyTimeoutMs: BigInt(database.pragma('busy_timeout', { simple: true }) as number | bigint),
    tables,
    indexes,
    triggers,
    manifestDomainCount: Number((database.prepare('SELECT COUNT(*) AS count FROM schema_manifest').get() as { count: bigint }).count),
    schemaDigest: RUNTIME_SCHEMA_DIGEST,
    foreignKeyViolationCount: (database.pragma('foreign_key_check') as unknown[]).length
  };
}

function insertRootBinding(database: Database.Database, binding: RootBinding): void {
  database.prepare(`
    INSERT INTO root_binding (
      singleton, data_root_path, database_path, cas_root_path, root_pointer_path,
      root_pending_path, runtime_epoch_path, data_set_id, root_instance_id,
      root_generation, pointer_revision, runtime_kernel_epoch
    ) VALUES (
      1, @dataRootPath, @databasePath, @casRootPath, @rootPointerPath,
      @rootPendingPath, @runtimeEpochPath, @dataSetId, @rootInstanceId,
      @rootGeneration, @pointerRevision, @runtimeKernelEpoch
    )
  `).run({
    dataRootPath: binding.paths.dataRootPath,
    databasePath: binding.paths.databasePath,
    casRootPath: binding.paths.casRootPath,
    rootPointerPath: binding.paths.rootPointerPath,
    rootPendingPath: binding.paths.rootPendingPath,
    runtimeEpochPath: binding.paths.runtimeEpochPath,
    dataSetId: binding.dataSetId,
    rootInstanceId: binding.rootInstanceId,
    rootGeneration: BigInt(binding.rootGeneration),
    pointerRevision: BigInt(binding.pointerRevision),
    runtimeKernelEpoch: BigInt(binding.runtimeKernelEpoch)
  });
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

function parseJsonText(value: unknown): unknown {
  return JSON.parse(requireText(value, 'schema_manifest JSON field'));
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be text.`);
  return value;
}

function toSafeNumber(value: unknown, label: string): number {
  if (typeof value !== 'bigint' || value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${label} must be a positive safe SQLite INTEGER.`);
  }
  return Number(value);
}
