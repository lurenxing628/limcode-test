import type Database from 'better-sqlite3';
import { stablePhaseFId } from './phaseFIdentity';
import type { DomainRow } from './repositories';
import { RuntimeDataInvariantError } from './runtimeDataInvariant';
import { prepareCached } from './runtimeStatementCache';

const DOMAIN = 'ConversationContextHandleState';
const READY_TYPE = 'application/vnd.limcode.conversation-context-handle-state+json';
const PENDING_TYPE = 'application/vnd.limcode.conversation-context-handle-upgrade+json';
const stateIds = new Map<string, string>();
function stateId(conversationId: string): string {
  let id = stateIds.get(conversationId);
  if (id === undefined) {
    id = stablePhaseFId('conversation_context_handle_state', conversationId); stateIds.set(conversationId, id);
    if (stateIds.size > 256) stateIds.delete(stateIds.keys().next().value!);
  }
  return id;
}

/** A typed current pointer, never an arbitrary JSON slot or a movable ownership alias. */
export function assertConversationContextHandleState(database: Database.Database, row: DomainRow): void {
  const fail = (message: string): never => { throw new RuntimeDataInvariantError(DOMAIN, String(row.id), message); };
  if (typeof row.conversation_id !== 'string' || !row.conversation_id
    || row.id !== stateId(row.conversation_id)
    || typeof row.revision !== 'bigint' || row.revision < 0n
    || typeof row.provenance_revision !== 'bigint' || row.provenance_revision < 0n
    || (typeof row.requires_native_reset !== 'bigint' || row.requires_native_reset < 0n)
    || !['ready', 'pending'].includes(String(row.state))) fail('Context reference state has invalid ownership, revision or status.');
  if (row.context_root_id !== null) assertRootOwner(database, row, fail);
  if (row.content_object_id === null) {
    return;
  }
  const metadata = prepareCached(database, 'SELECT content_type FROM content_object WHERE id = ?')
    .get(row.content_object_id) as { content_type: string } | undefined;
  if (metadata?.content_type !== (row.state === 'ready' ? READY_TYPE : PENDING_TYPE)) {
    fail('Context reference state does not reference its own typed catalog or upgrade checkpoint.');
  }
}

export function assertContextRootHandleCatalog(database: Database.Database, row: DomainRow): void {
  const fail = (message: string): never => { throw new RuntimeDataInvariantError('ContextRootHandleCatalog', String(row.id), message); };
  if (typeof row.conversation_id !== 'string' || typeof row.context_root_id !== 'string'
    || typeof row.provenance_revision !== 'bigint' || row.provenance_revision < 0n
    || row.id !== `context_root_handle_catalog:${row.conversation_id.length}:${row.conversation_id}${row.context_root_id}:${row.provenance_revision}`) {
    fail('Context root catalog identity must include its exact Conversation and root.');
  }
  assertRootOwner(database, row, fail);
  const root = prepareCached(database, 'SELECT root_node_id, tail_node_id, tail_segment_count, segment_count FROM context_sequence_root WHERE id = ?')
    .get(row.context_root_id) as DomainRow;
  if (['root_node_id', 'tail_node_id', 'tail_segment_count', 'segment_count'].some(column => row[column] !== root[column])) {
    fail('Context root catalog structural identity does not match its immutable root.');
  }
  if (row.content_object_id === null) return;
  const metadata = prepareCached(database, 'SELECT content_type FROM content_object WHERE id = ?')
    .get(row.content_object_id) as { content_type: string } | undefined;
  if (metadata?.content_type !== READY_TYPE) fail('Context root catalog must reference a ready typed catalog.');
}

function assertRootOwner(database: Database.Database, row: DomainRow, fail: (message: string) => never): void {
  const root = prepareCached(database, 'SELECT conversation_id FROM context_sequence_root WHERE id = ?')
    .get(row.context_root_id) as { conversation_id: string } | undefined;
  if (!root || root.conversation_id !== row.conversation_id) fail('Context reference scope belongs to another Conversation root.');
}

export function assertConversationContextHandleStateUpdate(database: Database.Database, id: string, patch: DomainRow): void {
  const current = prepareCached(database, 'SELECT * FROM conversation_context_handle_state WHERE id = ?').get(id) as DomainRow | undefined;
  if (!current || typeof patch.revision !== 'bigint' || patch.revision !== BigInt(String(current.revision)) + 1n) {
    throw new RuntimeDataInvariantError(DOMAIN, id, 'Context reference updates must advance exactly one fenced revision.');
  }
  if (patch.provenance_revision !== undefined && (typeof patch.provenance_revision !== 'bigint'
    || patch.provenance_revision < BigInt(String(current.provenance_revision))
    || patch.provenance_revision > BigInt(String(current.provenance_revision)) + 1n)) {
    throw new RuntimeDataInvariantError(DOMAIN, id, 'Context provenance generation must be preserved or advance exactly once.');
  }
  assertConversationContextHandleState(database, { ...current, ...patch });
}
