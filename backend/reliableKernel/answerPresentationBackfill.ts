import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { AcceptedAnswerTextPages } from './acceptedAnswerTextPages';
import { answerTitlePreview, assertAnswerPresentation, captureAnswerPresentation } from './answerPresentation';
import { type ContentObjectMetadata, storageKeyForDigest } from './contentAddressedStore';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { stablePhaseFId, requirePhaseFId } from './phaseFIdentity';
import { VerifiedContentRanges } from './verifiedContentRanges';

/** Verified bytes `[offset, offset + length)` of one content object (its digest and length are checked). */
export type HistoricalContentRangeReader = (metadata: ContentObjectMetadata, offset: number, length: number) => Promise<Buffer>;

/** The in-place upgrade's own CAS root. */
export function localHistoricalContentRanges(casRoot: string): HistoricalContentRangeReader {
  const root = path.resolve(casRoot);
  const verified = new VerifiedContentRanges();
  return (metadata, offset, length) =>
    verified.read(root, path.resolve(root, metadata.storage_key), metadata.sha256, metadata.byte_length, offset, length);
}

/** Offline-only, bounded CAS capability under the caller's existing maintenance/backup fence. */
function offlineContentReader(readRange: HistoricalContentRangeReader, signal?: AbortSignal) {
  return { async readChunk(metadata: ContentObjectMetadata, offset: number, maximum: number) {
    signal?.throwIfAborted();
    if (metadata.storage_key !== storageKeyForDigest(metadata.sha256)) throw new Error('Historical answer CAS storage key conflicts with its digest.');
    const totalBytes = Number(metadata.byte_length);
    if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes
      || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 1024 * 1024) throw new RangeError('Historical answer range exceeds its bounded contract.');
    const length = Math.min(maximum, totalBytes - offset);
    const chunk = await readRange(metadata, offset, length);
    if (chunk.length !== length) throw new Error('Historical answer CAS range is incomplete.');
    signal?.throwIfAborted();
    await new Promise<void>(resolve => setImmediate(resolve));
    const nextOffset = offset + chunk.length;
    return { chunk, totalBytes, hasMore: nextOffset < totalBytes, ...(nextOffset < totalBytes ? { nextOffset } : {}) };
  } };
}

/** Semantic acceptance and a provable physical timeline position are independent. */
export async function backfillAcceptedAnswerPresentations(
  database: Database.Database, content: string | HistoricalContentRangeReader, signal?: AbortSignal
): Promise<number> {
  const reader = offlineContentReader(typeof content === 'string' ? localHistoricalContentRanges(content) : content, signal);
  const pages = new AcceptedAnswerTextPages(reader);
  const candidate = database.prepare(`SELECT * FROM runtime_delivery
    WHERE (target_conversation_id, created_at, id) > (@conversationId, @createdAt, @id)
    ORDER BY target_conversation_id, created_at, id LIMIT 250`);
  const inboxQuery = database.prepare('SELECT source_kind, source_id FROM runtime_inbox_item WHERE id = ?');
  const ownerQuery = database.prepare('SELECT id FROM conversation WHERE id = ?');
  const occurrenceQuery = database.prepare(`SELECT segment.content_object_id FROM runtime_delivery_input_link AS link
    JOIN context_segment_source AS source ON source.source_kind = 'runtime_context'
      AND source.source_id = link.pending_turn_input_id AND source.source_revision = 0
    JOIN context_segment AS segment ON segment.id = source.segment_id WHERE link.delivery_id = ?`);
  const metadataQuery = database.prepare('SELECT * FROM content_object WHERE id = ?');
  const metadata = (id: unknown): ContentObjectMetadata => {
    const row = metadataQuery.get(id) as ContentObjectMetadata | undefined;
    if (!row) throw new Error('Historical accepted answer lost its body metadata.');
    return row;
  };
  const codec = DOMAIN_REPOSITORIES.codec('RuntimeDeliveryAnswerPresentation');
  const columns = DOMAIN_REPOSITORIES.domain('RuntimeDeliveryAnswerPresentation').schema.columns.map(column => column.name);
  const insert = database.prepare(`INSERT INTO runtime_delivery_answer_presentation (${columns.join(',')}) VALUES (${columns.map(name => '@' + name).join(',')})`);
  let cursor = { conversationId: '', createdAt: '', id: '' };
  let inserted = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const rows = candidate.all(cursor) as DomainRow[];
      if (!rows.length) break;
      for (const delivery of rows) {
        signal?.throwIfAborted();
        if (delivery.state !== 'consumed' || !ownerQuery.get(delivery.target_conversation_id)) continue;
        const inbox = inboxQuery.get(delivery.inbox_item_id) as DomainRow | undefined;
        if (inbox?.source_kind !== 'answer_submission') continue;
        let row: DomainRow;
        if (delivery.phase === 'notify_only') {
          const payload = database.prepare('SELECT content_object_id FROM runtime_inbox_payload_link WHERE inbox_item_id = ?')
            .get(delivery.inbox_item_id) as { content_object_id: string } | undefined;
          if (!payload) throw new Error('Accepted notification lost its exact inbox body.');
          await reader.readChunk(metadata(payload.content_object_id), 0, 1);
          const live = database.prepare('SELECT id FROM answer_submission WHERE id = ?').get(inbox.source_id);
          row = live ? captureAnswerPresentation(database, { delivery_id: delivery.id, conversation_id: delivery.target_conversation_id,
            acceptance_kind: 'notification' }, undefined)! : {
            ...presentationIdentity(delivery, inbox.source_id), child_execution_id: null, child_conversation_id: null,
            answer_bridge_id: null, source_turn_id: null, outcome: 'unknown', peer_title_preview: null,
            answer_title_preview: null, body_content_object_id: payload.content_object_id, body_representation: 'answer-payload'
          };
          if (live) {
            const peer = await historicalSpawnPeer(database, reader, metadata,
              String(row.child_execution_id), String(row.answer_bridge_id), signal);
            if (row.child_conversation_id !== null && peer.conversationId !== null
              && row.child_conversation_id !== peer.conversationId) throw new Error('Historical notification spawn peer conflicts with its live child identity.');
            row.child_conversation_id = row.child_conversation_id ?? peer.conversationId;
            row.peer_title_preview = peer.title;
          }
        } else if (delivery.phase === 'current_turn' || delivery.phase === 'next_turn') {
          const occurrence = occurrenceQuery.get(delivery.id) as { content_object_id: string } | undefined;
          if (!occurrence) continue; // A consumed delivery alone is injection, not model acceptance.
          const body = metadata(occurrence.content_object_id);
          const inspected = await pages.inspect(body, 'historical-runtime-envelope', { signal, expected: {
            deliveryId: String(delivery.id), inboxItemId: String(delivery.inbox_item_id),
            submissionId: String(inbox.source_id), targetTurnId: String(delivery.target_turn_id)
          } });
          const envelope = inspected.metadata;
          const live = database.prepare(`SELECT submission.answer_bridge_id, submission.turn_id, bridge.child_execution_id,
              child.child_conversation_id FROM answer_submission AS submission
            JOIN answer_bridge AS bridge ON bridge.id = submission.answer_bridge_id
            JOIN child_execution AS child ON child.id = bridge.child_execution_id WHERE submission.id = ?`)
            .get(envelope.submissionId) as DomainRow | undefined;
          if (live && (live.answer_bridge_id !== envelope.answerBridgeId || live.turn_id !== envelope.sourceTurnId
            || live.child_execution_id !== envelope.childExecutionId)) throw new Error('Historical answer envelope conflicts with its live immutable lineage.');
          const peer = await historicalSpawnPeer(database, reader, metadata, envelope.childExecutionId, envelope.answerBridgeId, signal);
          if (live && peer.conversationId !== null && live.child_conversation_id !== peer.conversationId) {
            throw new Error('Historical spawn peer conflicts with the surviving child identity.');
          }
          row = { ...presentationIdentity(delivery, inbox.source_id), child_execution_id: envelope.childExecutionId,
            child_conversation_id: live?.child_conversation_id ?? peer.conversationId, answer_bridge_id: envelope.answerBridgeId,
            source_turn_id: envelope.sourceTurnId, outcome: envelope.status,
            peer_title_preview: peer.title, answer_title_preview: answerTitlePreview(envelope.title),
            // An old pending-input body may have changed in the former append/ACK gap. The
            // immutable Context is the exact accepted body, regardless of today's input row.
            body_content_object_id: body.id, body_representation: 'historical-runtime-envelope' };
        } else throw new Error('Historical consumed answer has an unsupported delivery phase.');
        assertAnswerPresentation(database, row);
        insert.run(codec.encodeInsert(row));
        inserted += 1;
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      const last = rows[rows.length - 1];
      cursor = { conversationId: String(last.target_conversation_id), createdAt: String(last.created_at), id: String(last.id) };
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  } finally { pages.clear(); }
  return inserted;
}

function presentationIdentity(delivery: DomainRow, submissionId: unknown): DomainRow {
  return { id: stablePhaseFId('runtime_delivery_answer_presentation', String(delivery.id)),
    conversation_id: delivery.target_conversation_id, delivery_id: delivery.id, inbox_item_id: delivery.inbox_item_id,
    attempt_seq: delivery.attempt_seq, submission_id: submissionId };
}

/** Original spawn metadata is immutable; a renamed current Conversation is not historical proof. */
async function historicalSpawnPeer(database: Database.Database, reader: ReturnType<typeof offlineContentReader>,
  metadata: (id: unknown) => ContentObjectMetadata, childExecutionId: string, answerBridgeId: string,
  signal?: AbortSignal): Promise<{ conversationId: string | null; title: string | null }> {
  const unknown = { conversationId: null, title: null };
  const fact = database.prepare(`SELECT effect.request_object_id, operation.tool_call_id FROM (
      SELECT id, tool_call_id FROM operation WHERE owner_kind = 'child_execution' AND owner_id = ? ORDER BY operation_seq LIMIT 1
    ) AS operation JOIN effect_intent AS effect ON effect.attempt_id = (
      SELECT id FROM attempt WHERE operation_id = operation.id ORDER BY attempt_seq LIMIT 1
    ) AND effect.effect_kind = 'subagent_spawn'`).get(childExecutionId) as DomainRow | undefined;
  if (!fact) return unknown;
  const body = metadata(fact.request_object_id);
  // Optional peer metadata never requires materializing an arbitrarily large original prompt.
  if (body.byte_length > 1024n * 1024n) return unknown;
  if (body.content_type !== 'application/vnd.limcode.subagent-spawn+json') throw new Error('Historical spawn metadata has an unexpected content type.');
  signal?.throwIfAborted();
  const request = JSON.parse((await reader.readChunk(body, 0, 1024 * 1024)).chunk.toString('utf8')) as Record<string, unknown>;
  if (request.childExecutionId !== childExecutionId || request.answerBridgeId !== answerBridgeId
    || (fact.tool_call_id !== null && fact.tool_call_id !== request.sourceToolCallId)) {
    throw new Error('Historical spawn request conflicts with the accepted child answer identity.');
  }
  requirePhaseFId(request.sourceToolCallId, 'historical spawn.sourceToolCallId');
  return { conversationId: requirePhaseFId(request.childConversationId, 'historical spawn.childConversationId'),
    title: answerTitlePreview(request.title) };
}
