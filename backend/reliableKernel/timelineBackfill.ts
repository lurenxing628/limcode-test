import { contextAppendRootId } from './contextSequence';
import type Database from 'better-sqlite3';
import { DOMAIN_REPOSITORIES } from './repositories';
import { stablePhaseFId } from './phaseFIdentity';

/**
 * Offline epoch upgrade only. Reconstruct input positions only inside an exact append chain
 * between two adjacent physical Message memberships. Every Message is committed atomically with
 * its Context occurrence on this path; adjacency rules out an excluded/hidden Message between
 * them. No clock, rowid, request existence or guessed mixed send/receive order is used.
 * Unprovable inputs and sends are deliberately left without position claims.
 */
export function backfillProvenRuntimeInputTimeline(database: Database.Database): number {
  type Root = { id: string; conversation_id: string; root_seq: bigint; node_id: string;
    parent_node_id: string | null; segment_id: string; created_at: string };
  type Input = { delivery_id: string; inbox_item_id: string; pending_turn_input_id: string };
  const roots = database.prepare(`
    SELECT root.id, root.conversation_id, root.root_seq, root.created_at,
           node.id AS node_id, node.parent_node_id, node.segment_id
      FROM context_sequence_root AS root
      JOIN context_sequence_node AS node ON node.id = COALESCE(root.tail_node_id, root.root_node_id)
     WHERE (root.conversation_id, root.root_seq) > (@conversationId, @rootSeq)
     ORDER BY root.conversation_id, root.root_seq LIMIT 250
  `);
  const message = database.prepare(`
    SELECT membership.message_id, membership.message_seq
      FROM context_segment_source AS source
      JOIN message_revision AS revision ON revision.id = source.source_id
      JOIN message_part_of_conversation AS membership ON membership.message_id = revision.message_id
       AND membership.conversation_id = @conversationId
     WHERE source.segment_id = @segmentId AND source.source_kind = 'message_revision'
     LIMIT 2
  `);
  const input = database.prepare(`
    SELECT delivery.id AS delivery_id, delivery.inbox_item_id, link.pending_turn_input_id
      FROM context_segment_source AS source
      JOIN runtime_delivery_input_link AS link ON link.pending_turn_input_id = source.source_id
      JOIN runtime_delivery AS delivery ON delivery.id = link.delivery_id
       AND delivery.target_conversation_id = @conversationId AND delivery.state = 'consumed'
       AND delivery.phase IN ('current_turn', 'next_turn')
     WHERE source.segment_id = @segmentId AND source.source_kind = 'runtime_context' AND source.source_revision = 0
     LIMIT 2
  `);
  database.exec('CREATE TEMP TABLE timeline_backfill_candidates AS SELECT * FROM runtime_delivery_timeline_link WHERE 0');
  const insert = database.prepare(`INSERT INTO timeline_backfill_candidates
    (id, conversation_id, delivery_id, inbox_item_id, acceptance_kind, pending_turn_input_id, context_root_id,
     context_node_id, predecessor_message_id, predecessor_message_seq, exchange_seq, position_basis, created_at)
    VALUES (@id, @conversation_id, @delivery_id, @inbox_item_id, @acceptance_kind, @pending_turn_input_id, @context_root_id,
     @context_node_id, @predecessor_message_id, @predecessor_message_seq, @exchange_seq, @position_basis, @created_at)`);
  let previous: Root | undefined;
  let predecessor: { message_id: string; message_seq: bigint } | undefined;
  // A bounded proof group. Bigger old bursts stay unlocated; all new acceptances have direct links.
  const MAX_PROOF_INPUTS = 4096;
  let pending: Array<{ root: Root; input: Input }> = [];
  let count: number | bigint = 0;
  let cursor = { conversationId: '', rootSeq: 0n };
  try {
  for (;;) {
    // Finish the indexed read before writing TEMP candidates on this connection.
    const page = roots.all(cursor) as Root[];
    if (page.length === 0) break;
    for (const root of page) {
    const continues = previous?.conversation_id === root.conversation_id
      && root.parent_node_id === previous.node_id
      && root.id === contextAppendRootId(root.conversation_id, previous.id, root.node_id);
    if (!continues) { predecessor = undefined; pending = []; }
    const parameters = { conversationId: root.conversation_id, segmentId: root.segment_id };
    const messages = message.all(parameters) as Array<{ message_id: string; message_seq: bigint }>;
    if (messages.length === 1) {
      if (predecessor && pending.length > 0 && messages[0].message_seq === predecessor.message_seq + 1n) {
        for (const accepted of pending) {
          const row = DOMAIN_REPOSITORIES.codec('RuntimeDeliveryTimelineLink').encodeInsert({
            id: stablePhaseFId('runtime_delivery_timeline', accepted.input.delivery_id), conversation_id: root.conversation_id,
            delivery_id: accepted.input.delivery_id, inbox_item_id: accepted.input.inbox_item_id, acceptance_kind: 'input', pending_turn_input_id: accepted.input.pending_turn_input_id,
            context_root_id: accepted.root.id, context_node_id: accepted.root.node_id,
            predecessor_message_id: predecessor.message_id, predecessor_message_seq: predecessor.message_seq,
            exchange_seq: accepted.root.root_seq, position_basis: 'context', created_at: accepted.root.created_at
          });
          insert.run(row);
        }
      }
      predecessor = messages[0]; pending = [];
    } else {
      const inputs = input.all(parameters) as Input[];
      if (messages.length > 1 || inputs.length !== 1 || !predecessor || pending.length >= MAX_PROOF_INPUTS) {
        predecessor = undefined; pending = [];
      } else pending.push({ root, input: inputs[0] });
    }
    previous = root;
    }
    const last = page[page.length - 1];
    cursor = { conversationId: last.conversation_id, rootSeq: last.root_seq };
  }
  // A repeated/ambiguous historical acceptance is not a reason to refuse a valid published
  // database, and never a reason to select one occurrence arbitrarily.
  count = database.prepare(`INSERT INTO runtime_delivery_timeline_link
    SELECT candidate.* FROM timeline_backfill_candidates AS candidate
    JOIN (SELECT delivery_id FROM timeline_backfill_candidates GROUP BY delivery_id HAVING COUNT(*) = 1) AS unique_delivery
      ON unique_delivery.delivery_id = candidate.delivery_id`).run().changes;
  return Number(count);
  } finally { database.exec('DROP TABLE timeline_backfill_candidates'); }
}
