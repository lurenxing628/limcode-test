import type Database from 'better-sqlite3';
import type { DomainRow } from './repositories';
import { requireRuntimeId } from './runtimeSqlRows';
import { prepareCached } from './runtimeStatementCache';

/** Identity-only source inventory. This is a read projection, never another handle authority. */
export interface ContextHandleEvidenceFrontier {
  turns: DomainRow[];
  requests: DomainRow[];
  sources: DomainRow[];
  events: DomainRow[];
  contentObjects: DomainRow[];
}

const REQUEST_SCOPE = `FROM turn AS owner
  JOIN model_request AS request ON request.turn_id = owner.id
  WHERE owner.conversation_id = @conversationId`;
const SOURCE_SCOPE = `FROM turn AS owner
  JOIN model_request AS request ON request.turn_id = owner.id
  JOIN tool_call_source_link AS source ON source.model_request_id = request.id
  WHERE owner.conversation_id = @conversationId`;
const EVENT_SCOPE = `FROM turn AS owner
  JOIN model_request AS request ON request.turn_id = owner.id
  JOIN tool_call_source_link AS source ON source.model_request_id = request.id
  JOIN tool_call_event AS event ON event.tool_call_id = source.tool_call_id
  WHERE owner.conversation_id = @conversationId
    AND event.event_kind = 'native_child_handle_projection'`;

/**
 * The caller holds one fenced reader transaction. Existing ownership/sequence indexes service
 * these fixed joins; cold reads never send a ModelRequest list request for each historical Turn.
 * External commits can compare these identities without reading, parsing or hashing CAS bodies.
 * Legacy compression/fork proofs have additional dependencies and are not certified by this view.
 */
export function readContextHandleEvidenceFrontier(
  database: Database.Database,
  conversationIdInput: string
): ContextHandleEvidenceFrontier {
  const parameters = { conversationId: requireRuntimeId(conversationIdInput) };
  const rows = (sql: string): DomainRow[] => prepareCached(database, sql).all(parameters) as DomainRow[];
  return {
    turns: rows('SELECT id, conversation_id, status FROM turn WHERE conversation_id = @conversationId ORDER BY id'),
    requests: rows(`SELECT request.id, request.turn_id, request.recipe_object_id,
      request.status, request.terminal_state ${REQUEST_SCOPE} ORDER BY request.id`),
    sources: rows(`SELECT source.id, source.model_request_id, source.tool_call_id
      ${SOURCE_SCOPE} ORDER BY source.id`),
    events: rows(`SELECT event.id, event.tool_call_id, event.event_seq, event.event_kind,
      event.content_object_id ${EVENT_SCOPE} ORDER BY event.id`),
    contentObjects: rows(`SELECT id, content_type, sha256, byte_length, storage_key, created_at
      FROM content_object WHERE id IN (
        SELECT request.recipe_object_id ${REQUEST_SCOPE}
        UNION SELECT event.content_object_id ${EVENT_SCOPE}
      ) ORDER BY id`)
  };
}
