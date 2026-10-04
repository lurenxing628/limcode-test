import type Database from 'better-sqlite3';
import { stablePhaseFId } from './phaseFIdentity';
import { prepareCached } from './runtimeStatementCache';
import { RuntimeDataInvariantError } from './runtimeDataInvariant';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryInsertMutation, type RepositoryTransactionStep } from './repositories';

export const TIMELINE_LINK_DOMAINS = new Set(['RuntimeDeliveryTimelineLink', 'CollaborationSendTimelineLink']);

/** Called only inside the SQLite writer transaction which accepts the exchange. */
export function allocateTimelinePosition(database: Database.Database, mutation: RepositoryInsertMutation): DomainRow {
  if (!mutation.allocateTimelinePosition) return mutation.row;
  if (!TIMELINE_LINK_DOMAINS.has(mutation.domain) || mutation.allocateSequence || mutation.historicalCopy) {
    throw new TypeError('Timeline allocation is restricted to ordinary typed acceptance inserts.');
  }
  for (const name of ['predecessor_message_id', 'predecessor_message_seq', 'exchange_seq', 'position_basis']) {
    if (name in mutation.row) throw new TypeError(`Timeline ${name} was supplied and allocated.`);
  }
  const conversationId = mutation.row.conversation_id;
  if (typeof conversationId !== 'string' || !conversationId) throw new TypeError('Timeline requires its Conversation.');
  // Message and membership are insert-only/soft-delete while this Conversation survives. Include
  // hidden/tool/soft-deleted memberships so truncation cannot move a later acceptance backwards.
  const previous = prepareCached(database, `
    SELECT message_id, message_seq FROM message_part_of_conversation
     WHERE conversation_id = ? ORDER BY message_seq DESC LIMIT 1
  `).get(conversationId) as { message_id: string; message_seq: bigint } | undefined;
  // Both relations are retained until their owning Conversation is deleted. Source child, Turn,
  // input and anchor deletion cannot lower either high-water mark or reuse an observed sequence.
  const nextSequence = allocateSharedExchangeSequence(database, conversationId);
  const delivery = mutation.domain === 'RuntimeDeliveryTimelineLink'
    ? prepareCached(database, 'SELECT inbox_item_id FROM runtime_delivery WHERE id = ? AND target_conversation_id = ?').get(mutation.row.delivery_id, conversationId) as { inbox_item_id: string } | undefined
    : undefined;
  if (mutation.domain === 'RuntimeDeliveryTimelineLink' && !delivery) throw new Error('Timeline delivery has no scoped inbox.');
  return { ...mutation.row, ...(delivery ? { inbox_item_id: delivery.inbox_item_id } : {}), predecessor_message_id: previous?.message_id ?? null,
    predecessor_message_seq: previous?.message_seq ?? 0n, exchange_seq: nextSequence, position_basis: 'committed' };
}

/** Scope and immutable evidence are checked for both ordinary acceptance and historical copy. */
export function assertTimelinePosition(database: Database.Database, domain: string, row: DomainRow): void {
  if (!TIMELINE_LINK_DOMAINS.has(domain)) return;
  function fail(message: string): never { throw new RuntimeDataInvariantError(domain, String(row.id), message); }
  if (typeof row.exchange_seq !== 'bigint' || row.exchange_seq < 1n
    || typeof row.predecessor_message_seq !== 'bigint' || row.predecessor_message_seq < 0n
    || !['committed', 'context'].includes(String(row.position_basis))) fail('Invalid immutable timeline coordinate.');
  if ((row.predecessor_message_seq === 0n) !== (row.predecessor_message_id === null)) fail('Timeline start requires the empty transcript cut.');
  if (row.predecessor_message_id !== null) {
    const membership = prepareCached(database, `SELECT conversation_id, message_seq FROM message_part_of_conversation WHERE message_id = ?`)
      .get(row.predecessor_message_id) as { conversation_id: unknown; message_seq: unknown } | undefined;
    // A deleted anchor is retained as evidence; an existing one may never name another scope.
    if (membership && (membership.conversation_id !== row.conversation_id || membership.message_seq !== row.predecessor_message_seq)) {
      fail('Timeline predecessor conflicts with its Message membership.');
    }
  }
  const otherTable = domain === 'RuntimeDeliveryTimelineLink' ? 'collaboration_send_timeline_link' : 'runtime_delivery_timeline_link';
  if (prepareCached(database, `SELECT id FROM ${otherTable} WHERE conversation_id = ? AND exchange_seq = ? LIMIT 1`)
    .get(row.conversation_id, row.exchange_seq)) fail('Send and receive timeline coordinates must share one sequence.');
  if (domain === 'CollaborationSendTimelineLink') {
    const source = prepareCached(database, 'SELECT conversation_id FROM collaboration_message_source_link WHERE message_id = ?')
      .get(row.message_id) as { conversation_id?: unknown } | undefined;
    if (!source || source.conversation_id !== row.conversation_id) fail('Send timeline requires its exact source Conversation.');
    if (row.position_basis !== 'committed') fail('Historical sends have no reconstructed acceptance order.');
    return;
  }
  const delivery = prepareCached(database, 'SELECT inbox_item_id, target_conversation_id, target_turn_id, phase, state FROM runtime_delivery WHERE id = ?')
    .get(row.delivery_id) as { inbox_item_id: unknown; target_conversation_id: unknown; target_turn_id: unknown; phase: unknown; state: unknown } | undefined;
  if (!delivery || delivery.target_conversation_id !== row.conversation_id || delivery.inbox_item_id !== row.inbox_item_id || delivery.state !== 'consumed') fail('Receive timeline requires its consumed delivery.');
  if (row.acceptance_kind === 'notification') {
    if (delivery.phase !== 'notify_only' || row.pending_turn_input_id !== null || row.context_root_id !== null || row.context_node_id !== null
      || row.position_basis !== 'committed') fail('Notification timeline cannot claim a Context acceptance.');
    return;
  }
  if (row.acceptance_kind !== 'input' || delivery.phase === 'notify_only'
    || typeof row.pending_turn_input_id !== 'string' || typeof row.context_root_id !== 'string' || typeof row.context_node_id !== 'string') {
    fail('Input timeline requires its immutable Context occurrence.');
  }
  const proof = prepareCached(database, `
    SELECT root.conversation_id, input.turn_id, input.input_kind
      FROM runtime_delivery_input_link AS link
      LEFT JOIN pending_turn_input AS input ON input.id = link.pending_turn_input_id
      JOIN context_segment_source AS source ON source.source_kind = 'runtime_context'
       AND source.source_id = link.pending_turn_input_id AND source.source_revision = 0
      JOIN context_sequence_node AS node ON node.id = @nodeId AND node.segment_id = source.segment_id
      JOIN context_sequence_root AS root ON root.id = @rootId
       AND COALESCE(root.tail_node_id, root.root_node_id) = node.id
     WHERE link.delivery_id = @deliveryId AND link.pending_turn_input_id = @inputId
  `).get({ nodeId: row.context_node_id, rootId: row.context_root_id, deliveryId: row.delivery_id, inputId: row.pending_turn_input_id }) as {
    conversation_id: unknown; turn_id: unknown; input_kind: unknown;
  } | undefined;
  if (!proof || proof.conversation_id !== row.conversation_id || (proof.turn_id !== null && (proof.turn_id !== delivery.target_turn_id || proof.input_kind !== 'runtime_delivery'))) {
    fail('Input timeline does not match its accepted Context/source scope.');
  }
}

export function allocateSharedExchangeSequence(database: Database.Database, conversationId: string): bigint {
  const maxima = prepareCached(database, `
    SELECT MAX(value) + 1 AS next_value FROM (
      SELECT COALESCE(MAX(exchange_seq), 0) AS value FROM runtime_delivery_timeline_link WHERE conversation_id = @conversationId
      UNION ALL
      SELECT COALESCE(MAX(exchange_seq), 0) AS value FROM collaboration_send_timeline_link WHERE conversation_id = @conversationId
    )
  `).get({ conversationId }) as { next_value: bigint };
  if (typeof maxima.next_value !== 'bigint' || maxima.next_value < 1n) throw new Error('Timeline sequence allocation failed.');
  return maxima.next_value;
}

export function allocateHistoricalTimelineImport(database: Database.Database, mutation: RepositoryInsertMutation): DomainRow {
  const source = mutation.allocateImportedTimelineSequence;
  if (!source) return mutation.row;
  if (!TIMELINE_LINK_DOMAINS.has(mutation.domain) || mutation.historicalCopy !== true
    || mutation.allocateTimelinePosition || mutation.allocateSequence || 'exchange_seq' in mutation.row
    || typeof source.sourceExchangeSeq !== 'bigint' || source.sourceExchangeSeq < 1n) {
    throw new TypeError('Historical timeline import requires its verified source and shared allocator.');
  }
  return { ...mutation.row, exchange_seq: allocateSharedExchangeSequence(database, String(mutation.row.conversation_id)) };
}

export function timelineImportProvenanceRow(mutation: RepositoryInsertMutation): DomainRow | undefined {
  const source = mutation.allocateImportedTimelineSequence;
  if (!source) return undefined;
  const linkId = String(mutation.row.id);
  return {
    id: stablePhaseFId('timeline_import_provenance', mutation.domain, linkId,
      source.sourceDataSetId, source.sourceRootInstanceId, source.sourceExchangeSeq.toString()),
    receive_timeline_link_id: mutation.domain === 'RuntimeDeliveryTimelineLink' ? linkId : null,
    send_timeline_link_id: mutation.domain === 'CollaborationSendTimelineLink' ? linkId : null,
    source_data_set_id: source.sourceDataSetId, source_root_instance_id: source.sourceRootInstanceId,
    source_exchange_seq: source.sourceExchangeSeq
  };
}

/** The receipt of model-visible acceptance closes its pending input in the very same commit. */
export function timelineInputAcknowledgementSteps(
  database: Database.Database, row: DomainRow, expectedContentObjectId: string | undefined
): RepositoryTransactionStep[] {
  if (row.acceptance_kind !== 'input') return [];
  const fact = prepareCached(database, `
    SELECT link.id AS link_id, link.handled_at, input.state, input.content_object_id, head.root_id
      FROM runtime_delivery_input_link AS link
      JOIN pending_turn_input AS input ON input.id = link.pending_turn_input_id
      JOIN conversation_context_head_link AS head ON head.conversation_id = @conversationId
     WHERE link.delivery_id = @deliveryId AND link.pending_turn_input_id = @inputId
  `).get({ conversationId: row.conversation_id, deliveryId: row.delivery_id, inputId: row.pending_turn_input_id }) as {
    link_id: string; handled_at: unknown; state: unknown; content_object_id: unknown; root_id: unknown;
  } | undefined;
  if (!expectedContentObjectId || !fact || fact.content_object_id !== expectedContentObjectId
    || fact.state !== 'pending' || fact.handled_at !== null || fact.root_id !== row.context_root_id) {
    throw Object.assign(new Error('Runtime input changed before its Context acceptance.'), { code: 'RUNTIME_TRANSACTION_ASSERTION_FAILED' });
  }
  return [
    DOMAIN_REPOSITORIES.domain('PendingTurnInput').update(String(row.pending_turn_input_id), { state: 'consumed', updated_at: row.created_at }),
    DOMAIN_REPOSITORIES.domain('RuntimeDeliveryInputLink').update(fact.link_id, { handled_at: row.created_at, updated_at: row.created_at })
  ];
}
