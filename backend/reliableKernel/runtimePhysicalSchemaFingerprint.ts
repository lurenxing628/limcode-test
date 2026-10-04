import Database from 'better-sqlite3';
import {
  RUNTIME_SCHEMA_TRIGGERS,
  createRootBindingTableSql,
  createRuntimeDomainIndexSql,
  createRuntimeDomainTableSql,
  createSchemaManifestTableSql
} from './schema/domainManifest';
import type { RuntimeDomainSchema } from './schema/types';

export interface RuntimePhysicalSchemaFingerprintOptions {
  label?: string;
  /** Exact shipped metadata/trigger contract, used only by the bounded epoch migrator. */
  historicalContract?: {
    metadataSql: readonly string[];
    triggers: readonly { name: string; sql: string }[];
  };
}

/** Exact sqlite_master DDL contract used only at bounded migration boundaries. */
export function assertRuntimePhysicalSchemaFingerprint(
  database: Database.Database,
  schemas: readonly RuntimeDomainSchema[],
  options: RuntimePhysicalSchemaFingerprintOptions = {}
): void {
  const label = options.label ?? 'Runtime physical';
  const metadata = options.historicalContract?.metadataSql ?? [createRootBindingTableSql(), createSchemaManifestTableSql()];
  const expectedTables = new Map<string, string>([
    ['root_binding', normalizeSql(metadata[0])],
    ['schema_manifest', normalizeSql(metadata[1])],
    ...schemas.map((schema): [string, string] => [
      schema.table,
      normalizeSql(createRuntimeDomainTableSql(schema))
    ])
  ]);
  const expectedIndexes = new Map<string, string>();
  for (const schema of schemas) {
    schema.indexes.forEach((index, ordinal) => {
      const name = runtimeIndexName(schema, index, ordinal);
      expectedIndexes.set(name, normalizeSql(createRuntimeDomainIndexSql(schema, index, ordinal)));
    });
  }
  const expectedTriggers = new Map(
    (options.historicalContract?.triggers ?? RUNTIME_SCHEMA_TRIGGERS).map((trigger): [string, string] => [trigger.name, normalizeSql(trigger.sql)])
  );

  assertSqlObjects(database, 'table', expectedTables, label);
  assertSqlObjects(database, 'index', expectedIndexes, label);
  assertSqlObjects(database, 'trigger', expectedTriggers, label);
}

function assertSqlObjects(
  database: Database.Database,
  type: 'table' | 'index' | 'trigger',
  expected: ReadonlyMap<string, string>,
  label: string
): void {
  const rows = database.prepare(`
    SELECT name, sql
      FROM sqlite_master
     WHERE type = @type
       AND name NOT LIKE 'sqlite_%'
     ORDER BY name
  `).all({ type }) as Array<{ name: string; sql: string | null }>;
  const actual = new Map(rows.map((row) => [row.name, row.sql === null ? null : normalizeSql(row.sql)]));
  const missing = [...expected.keys()].filter((name) => !actual.has(name));
  const unexpected = [...actual.keys()].filter((name) => !expected.has(name));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error([
      `${label} ${type} drift is unsupported`,
      ...(missing.length > 0 ? [`missing ${missing.join(', ')}`] : []),
      ...(unexpected.length > 0 ? [`unexpected ${unexpected.join(', ')}`] : [])
    ].join(': '));
  }
  for (const [name, expectedSql] of expected) {
    const actualSql = actual.get(name);
    if (actualSql !== expectedSql) {
      throw new Error(`${label} ${type} DDL drift is unsupported for ${name}.`);
    }
  }
}

function runtimeIndexName(
  schema: RuntimeDomainSchema,
  authorityIndex: string,
  ordinal: number
): string {
  const unique = authorityIndex.includes(' UNIQUE');
  return `${unique ? 'ux' : 'ix'}_${schema.table}_${String(ordinal + 1).padStart(2, '0')}`;
}

function normalizeSql(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/;$/, '');
}
