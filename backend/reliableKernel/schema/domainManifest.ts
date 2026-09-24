import { createHash } from 'node:crypto';
import { CONTEXT_DOMAIN_SCHEMAS } from './domainsContext';
import { CORE_DOMAIN_SCHEMAS } from './domainsCore';
import { COLLABORATION_DOMAIN_SCHEMAS } from './domainsCollaboration';
import { COLLABORATION_BOARD_DOMAIN_SCHEMAS } from './domainsCollaborationBoard';
import { EXECUTION_DOMAIN_SCHEMAS } from './domainsExecution';
import type { RuntimeDomainSchema } from './types';

export const RUNTIME_DOMAIN_SCHEMAS: readonly RuntimeDomainSchema[] = Object.freeze([
  ...CORE_DOMAIN_SCHEMAS,
  ...EXECUTION_DOMAIN_SCHEMAS,
  ...CONTEXT_DOMAIN_SCHEMAS,
  ...COLLABORATION_DOMAIN_SCHEMAS,
  ...COLLABORATION_BOARD_DOMAIN_SCHEMAS
]);

export const RUNTIME_DOMAIN_SCHEMA_BY_KEY: ReadonlyMap<string, RuntimeDomainSchema> = new Map(
  RUNTIME_DOMAIN_SCHEMAS.map((entry) => [entry.key, entry])
);

export const RUNTIME_DOMAIN_SCHEMA_BY_TABLE: ReadonlyMap<string, RuntimeDomainSchema> = new Map(
  RUNTIME_DOMAIN_SCHEMAS.map((entry) => [entry.table, entry])
);

export const RUNTIME_SCHEMA_TRIGGERS = Object.freeze([
  Object.freeze({
    name: 'delete_interaction_request_with_turn',
    sql: `CREATE TRIGGER delete_interaction_request_with_turn
BEFORE DELETE ON turn
BEGIN
  DELETE FROM interaction_request
   WHERE id IN (
     SELECT request_id
       FROM interaction_owner_link
      WHERE turn_id = OLD.id
   );
END`
  }),
  Object.freeze({
    name: 'prevent_runtime_delivery_after_final_output_fence',
    sql: `CREATE TRIGGER prevent_runtime_delivery_after_final_output_fence
BEFORE INSERT ON pending_turn_input
WHEN NEW.input_kind = 'runtime_delivery'
 AND EXISTS (
   SELECT 1
     FROM turn_final_output_fence
    WHERE turn_id = NEW.turn_id
 )
BEGIN
  SELECT RAISE(ABORT, 'runtime delivery crossed final-output fence');
END`
  })
] as const);

export const RUNTIME_SCHEMA_DIGEST = createHash('sha256')
  .update(JSON.stringify({ domains: RUNTIME_DOMAIN_SCHEMAS, triggers: RUNTIME_SCHEMA_TRIGGERS }))
  .digest('hex');

export const METADATA_TABLES = Object.freeze(['root_binding', 'schema_manifest'] as const);

validateDomainManifest();

export function createRuntimeSchemaSql(): string[] {
  const statements = [
    createRootBindingTableSql(),
    createSchemaManifestTableSql(),
    ...RUNTIME_DOMAIN_SCHEMAS.map((schema) => createRuntimeDomainTableSql(schema))
  ];
  for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
    schema.indexes.forEach((index, ordinal) => statements.push(createRuntimeDomainIndexSql(schema, index, ordinal)));
  }
  statements.push(...RUNTIME_SCHEMA_TRIGGERS.map((trigger) => trigger.sql));
  return statements;
}

export function domainSchemaDigest(schema: RuntimeDomainSchema): string {
  return createHash('sha256').update(JSON.stringify(schema)).digest('hex');
}

export function createRootBindingTableSql(): string {
  return `CREATE TABLE root_binding (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    data_root_path TEXT NOT NULL,
    database_path TEXT NOT NULL,
    cas_root_path TEXT NOT NULL,
    root_pointer_path TEXT NOT NULL,
    root_pending_path TEXT NOT NULL,
    runtime_epoch_path TEXT NOT NULL,
    data_set_id TEXT NOT NULL,
    root_instance_id TEXT NOT NULL,
    root_generation INTEGER NOT NULL CHECK (root_generation > 0),
    pointer_revision INTEGER NOT NULL CHECK (pointer_revision > 0),
    runtime_kernel_epoch INTEGER NOT NULL CHECK (runtime_kernel_epoch > 0)
  )`;
}

export function createSchemaManifestTableSql(): string {
  return `CREATE TABLE schema_manifest (
    domain_key TEXT PRIMARY KEY,
    table_name TEXT NOT NULL UNIQUE,
    schema_owner TEXT NOT NULL,
    repository_name TEXT NOT NULL UNIQUE,
    codec_name TEXT NOT NULL UNIQUE,
    mutations_json TEXT NOT NULL,
    client_mapping TEXT NOT NULL,
    delete_policy TEXT NOT NULL,
    reset_policy TEXT NOT NULL,
    indexes_json TEXT NOT NULL,
    schema_digest TEXT NOT NULL,
    runtime_kernel_epoch INTEGER NOT NULL
  )`;
}

export function createRuntimeDomainTableSql(
  schema: RuntimeDomainSchema,
  tableName = schema.table
): string {
  const columns = schema.columns.map((column) => {
    const fragments = [quote(column.name), column.type];
    if (column.name === 'id') fragments.push('PRIMARY KEY');
    else if (!column.nullable) fragments.push('NOT NULL');
    if (column.defaultSql !== undefined) fragments.push(`DEFAULT ${column.defaultSql}`);
    if (column.references) {
      fragments.push(`REFERENCES ${quote(column.references.table)} (${quote(column.references.column ?? 'id')})`);
      fragments.push(`ON DELETE ${column.references.onDelete ?? 'NO ACTION'}`);
    }
    return `  ${fragments.join(' ')}`;
  });
  return `CREATE TABLE ${quote(tableName)} (\n${columns.join(',\n')}\n)`;
}

export function createRuntimeDomainIndexSql(
  schema: RuntimeDomainSchema,
  authorityIndex: string,
  ordinal: number
): string {
  const partialMarker = ' UNIQUE WHERE ';
  let columns = authorityIndex;
  let unique = false;
  let where = '';
  if (authorityIndex.includes(partialMarker)) {
    const parts = authorityIndex.split(partialMarker);
    if (parts.length !== 2) throw new Error(`Invalid partial index definition: ${schema.table}.${authorityIndex}`);
    [columns, where] = parts;
    unique = true;
  } else if (authorityIndex.endsWith(' UNIQUE')) {
    columns = authorityIndex.slice(0, -' UNIQUE'.length);
    unique = true;
  }
  const indexName = `${unique ? 'ux' : 'ix'}_${schema.table}_${String(ordinal + 1).padStart(2, '0')}`;
  return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${quote(indexName)} ON ${quote(schema.table)} (${columns})${where ? ` WHERE ${where}` : ''}`;
}

function validateDomainManifest(): void {
  if (RUNTIME_DOMAIN_SCHEMAS.length !== 107) {
    throw new Error(`Runtime domain schema exact set must contain 107 entries, found ${RUNTIME_DOMAIN_SCHEMAS.length}.`);
  }
  for (const field of ['key', 'table', 'repository', 'codec'] as const) {
    const values = RUNTIME_DOMAIN_SCHEMAS.map((entry) => entry[field]);
    if (new Set(values).size !== values.length) throw new Error(`Duplicate Runtime domain ${field}.`);
  }
  const forbidden = new Set([
    'child_turn_link',
    'provider_continuation',
    'client_change_log',
    'ask_user',
    'task_list',
    'mcp',
    'runtime_record',
    'domain_json'
  ]);
  for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
    if (forbidden.has(schema.table)) throw new Error(`Forbidden Runtime table: ${schema.table}`);
    if (schema.columns[0]?.name !== 'id' || schema.columns[0]?.type !== 'TEXT') {
      throw new Error(`Runtime domain table requires a TEXT id primary key: ${schema.table}`);
    }
    const columnNames = new Set(schema.columns.map((entry) => entry.name));
    for (const genericJsonColumn of ['payload_json', 'record_json', 'data_json']) {
      if (columnNames.has(genericJsonColumn)) throw new Error(`Forbidden generic JSON column: ${schema.table}.${genericJsonColumn}`);
    }
    for (const index of schema.indexes) {
      const columnList = index
        .replace(/ UNIQUE(?: WHERE .*)?$/, '')
        .split(',')
        .map((entry) => entry.trim());
      for (const column of columnList) {
        if (!columnNames.has(column)) throw new Error(`Index references missing column: ${schema.table}.${column}`);
      }
    }
  }
}

function quote(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) throw new Error(`Unsafe SQLite identifier: ${identifier}`);
  return `"${identifier}"`;
}
