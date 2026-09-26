import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

/**
 * Pure reads of one data-set database (a private copy), for the data-set facts worker. Kept free of
 * RuntimeDatabase, RootAuthority and the control planes so the worker loads little.
 */

/** Human-facing facts of one data set, for choosing between data sets without reading UUIDs. */
export interface RuntimeDataSetSummary {
  /** Project folder names recorded in the data set, most conversations first. */
  projectNames: string[];
  conversationCount: number;
  /** Latest Conversation.updated_at, when any conversation exists. */
  lastActivityAt?: string;
}

const DIGEST_DOMAIN = 'limcode-runtime-data-set-content\0';

/**
 * SHA-256 over every row of every table, in table-name and primary-key order, with the column
 * names and declared types; SQLite's own tables are excluded. Equal for the same logical content
 * however the file was produced: a WAL that was checkpointed, a copied or restored file, another
 * page layout. Any epoch: it reads the schema from the file itself.
 */
export function runtimeDataSetContentDigest(database: Database.Database): string {
  const hash = createHash('sha256').update(DIGEST_DOMAIN);
  const tables = database.prepare(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name"
  ).pluck().all() as string[];
  for (const table of tables) {
    const columns = (database.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string; type: string; pk: number | bigint }>)
      .map((column) => ({ name: column.name, type: column.type, pk: Number(column.pk) }));
    update(hash, 'table', table);
    for (const column of columns) update(hash, 'column', `${column.name} ${column.type}`);
    const key = columns.filter((column) => column.pk > 0).sort((left, right) => left.pk - right.pk);
    const order = (key.length > 0 ? key : columns).map((column) => quote(column.name)).join(', ');
    const statement = database.prepare(`SELECT ${columns.map((column) => quote(column.name)).join(', ')} FROM ${quote(table)} ORDER BY ${order}`);
    statement.raw(true).safeIntegers(true);
    for (const row of statement.iterate() as IterableIterator<unknown[]>) {
      hash.update('r');
      for (const value of row) updateValue(hash, value);
    }
  }
  return hash.digest('hex');
}

/** Names, conversation count and last activity; older formats without project links report counts. */
export function readRuntimeDataSetSummary(database: Database.Database): RuntimeDataSetSummary {
  const conversations = database.prepare(
    'SELECT COUNT(*) AS count, MAX(updated_at) AS last FROM conversation'
  ).get() as { count: bigint | number; last: string | null };
  let projectNames: string[] = [];
  if (hasTable(database, 'project_context') && hasTable(database, 'conversation_project_link')) {
    projectNames = (database.prepare(`
      SELECT project.name AS name, COUNT(link.id) AS uses
        FROM project_context AS project
        LEFT JOIN conversation_project_link AS link ON link.project_context_id = project.id
       GROUP BY project.id
       ORDER BY uses DESC, project.name ASC
       LIMIT 3
    `).all() as Array<{ name: string }>).map((row) => row.name).filter((name) => typeof name === 'string' && name.length > 0);
  }
  return {
    projectNames,
    conversationCount: Number(conversations.count),
    ...(conversations.last ? { lastActivityAt: conversations.last } : {})
  };
}

function hasTable(database: Database.Database, table: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function quote(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function update(hash: ReturnType<typeof createHash>, tag: string, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  hash.update(`${tag}:${bytes.length}:`).update(bytes);
}

function updateValue(hash: ReturnType<typeof createHash>, value: unknown): void {
  if (value === null) hash.update('n');
  else if (typeof value === 'bigint') hash.update(`i${value};`);
  else if (typeof value === 'number') {
    const bytes = Buffer.alloc(8);
    bytes.writeDoubleBE(value);
    hash.update('f').update(bytes);
  } else if (typeof value === 'string') update(hash, 's', value);
  else if (Buffer.isBuffer(value)) {
    hash.update(`b:${value.length}:`).update(value);
  } else throw new TypeError(`Unexpected SQLite value in content digest: ${typeof value}`);
}
