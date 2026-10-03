import type Database from 'better-sqlite3';
import {
  CONTEXT_SEQUENCE_NODE_BATCH_LIMIT,
  DOMAIN_REPOSITORIES,
  type EncodedRow,
  type RepositoryEnsureContextSequenceNodesStep
} from './repositories';
import { requireEncodedId } from './runtimeSqlRows';
import { prepareCached } from './runtimeStatementCache';

// One fixed statement shape, including the final short batch. No per-id SQL or cache entries.
const EXISTING_NODES_SQL = `SELECT id, parent_node_id, segment_id FROM context_sequence_node
  WHERE id IN (${Array(CONTEXT_SEQUENCE_NODE_BATCH_LIMIT).fill('?').join(', ')})`;
const INSERT_NODE_SQL = `INSERT INTO context_sequence_node (id, parent_node_id, segment_id, created_at)
  VALUES (@id, @parent_node_id, @segment_id, @created_at)`;
const ASSERT_NODE_SQL = `SELECT 1 FROM context_sequence_node
  WHERE id = ? AND parent_node_id IS ? AND segment_id = ? LIMIT 1`;
const NODE_UNIQUE_COLUMNS: readonly (readonly string[])[] = [
  ['context_sequence_node.id'],
  ['context_sequence_node.parent_node_id', 'context_sequence_node.segment_id'],
  ['context_sequence_node.segment_id']
];

interface NodeIdentity { id: string; parent_node_id: string | null; segment_id: string }

/**
 * Called only by executeSteps, inside its existing fenced writer transaction/savepoint. The lookup
 * and its small identity map never escape this batch. No outside snapshot can authorize a reuse.
 */
export function executeContextSequenceNodeBatch(
  database: Database.Database,
  step: RepositoryEnsureContextSequenceNodesStep
): void {
  if (step.domain !== 'ContextSequenceNode' || Object.keys(step).some((key) =>
    key !== 'kind' && key !== 'domain' && key !== 'nodes')) {
    throw new TypeError('Invalid immutable Context node batch.');
  }
  if (!Array.isArray(step.nodes) || step.nodes.length < 1 || step.nodes.length > CONTEXT_SEQUENCE_NODE_BATCH_LIMIT) {
    throw new RangeError(`Context node batches require 1 through ${CONTEXT_SEQUENCE_NODE_BATCH_LIMIT} rows.`);
  }
  const repository = DOMAIN_REPOSITORIES.domain('ContextSequenceNode');
  if (!repository.schema.mutations.includes('insert')) throw new Error(`${repository.name} does not allow insert.`);

  const encoded: EncodedRow[] = [];
  let invalid: { error: unknown } | undefined;
  // Defer a later malformed row's error until earlier rows have executed. For example, an earlier
  // missing FK must still win over a later codec error, exactly like the original ordered steps.
  for (const tuple of step.nodes) {
    try {
      if (!Array.isArray(tuple) || tuple.length !== 4) throw new TypeError('Context node tuple requires exactly four fields.');
      const row = repository.codec.encodeInsert({ id: tuple[0], parent_node_id: tuple[1],
        segment_id: tuple[2], created_at: tuple[3] });
      requireEncodedId(row.id, repository.codec.name);
      encoded.push(row);
    } catch (error) {
      invalid = { error };
      break;
    }
  }
  const current = new Map<string, NodeIdentity>();
  if (encoded.length > 0) {
    const ids: Array<string | null> = encoded.map((row) => row.id as string);
    while (ids.length < CONTEXT_SEQUENCE_NODE_BATCH_LIMIT) ids.push(null);
    for (const row of prepareCached(database, EXISTING_NODES_SQL).all(...ids) as NodeIdentity[]) current.set(row.id, row);
  }
  for (const row of encoded) {
    const id = row.id as string;
    const existing = current.get(id);
    if (existing) {
      if (existing.parent_node_id !== row.parent_node_id || existing.segment_id !== row.segment_id) {
        assertNodeIdentity(database, row);
      }
      continue;
    }
    try {
      prepareCached(database, INSERT_NODE_SQL).run(row);
    } catch (error) {
      // Preserve the old savepoint's exact UNIQUE allowlist, then its exact requested-id assertion.
      // Ordinary INSERT uses SQLite ABORT: a failed statement leaves no partial node/trigger writes.
      // Every other failure propagates to the caller's existing savepoint/transaction rollback.
      if (!isNodeIdentityUniqueError(error)) throw error;
      assertNodeIdentity(database, row);
    }
    // A later occurrence in this batch must see the first insertion, including a conflicting
    // duplicate id. created_at deliberately never participates in immutable identity equality.
    current.set(id, { id, parent_node_id: row.parent_node_id as string | null, segment_id: row.segment_id as string });
  }
  if (invalid) throw invalid.error;
}

function assertNodeIdentity(database: Database.Database, row: EncodedRow): void {
  // Keep SQL equality for rare mismatches, including text normalized by SQLite's UTF-8 boundary.
  if (prepareCached(database, ASSERT_NODE_SQL).get(row.id, row.parent_node_id, row.segment_id)) return;
  throw Object.assign(new Error(`ContextSequenceNodeRepository transaction assertion failed for ${String(row.id)}.`),
    { code: 'RUNTIME_TRANSACTION_ASSERTION_FAILED' });
}

function isNodeIdentityUniqueError(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown };
  if (!value || typeof value.code !== 'string'
    || !['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'].includes(value.code)
    || typeof value.message !== 'string') return false;
  const marker = 'UNIQUE constraint failed:';
  const index = value.message.indexOf(marker);
  if (index < 0) return false;
  const columns = value.message.slice(index + marker.length).split(',').map((column) => column.trim()).filter(Boolean).sort();
  return NODE_UNIQUE_COLUMNS.some((expected) => expected.length === columns.length
    && expected.every((column, position) => column === columns[position]));
}
