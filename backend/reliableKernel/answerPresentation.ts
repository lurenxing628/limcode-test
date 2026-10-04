import type Database from 'better-sqlite3';
import { answerSubmissionClientOutcome } from './answerSubmissionOutcome';
import { CHILD_ANSWER_SOURCE_DELETED_CONTENT_TYPE } from './deliverySettlementSteps';
import { stablePhaseFId, requirePhaseFId } from './phaseFIdentity';
import { prepareCached } from './runtimeStatementCache';
import type { DomainRow } from './repositories';
import type { RuntimeDeliveryModelEnvelope } from './runtimeDeliveryProjection';

/** Small metadata of the exact typed notice already decoded by the accepting executor. */
export interface AcceptedAnswerNotice {
  submissionId: string; childExecutionId: string; answerBridgeId: string; sourceTurnId: string;
  childConversationId: string | null; titlePreview: string | null;
}

export function answerTitlePreview(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let result = '';
  for (const character of value.trim()) {
    if (Buffer.byteLength(result + character, 'utf8') > 240) break;
    result += character;
  }
  return result || null;
}

/** No source lookup or body read is introduced on the feed path. */
export function acceptedNoticeMetadata(bytes: Uint8Array, envelope: RuntimeDeliveryModelEnvelope): AcceptedAnswerNotice {
  const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
  if (value.kind !== 'child_answer_source_deleted' || envelope.kind !== 'child_failure'
    || value.submissionId !== envelope.submissionId || value.childExecutionId !== envelope.childExecutionId
    || value.answerBridgeId !== envelope.answerBridgeId || value.sourceTurnId !== envelope.sourceTurnId) {
    throw new Error('Accepted deletion notice conflicts with its exact model projection.');
  }
  return { submissionId: envelope.submissionId, childExecutionId: envelope.childExecutionId,
    answerBridgeId: envelope.answerBridgeId, sourceTurnId: envelope.sourceTurnId,
    childConversationId: value.childConversationId == null ? null : requirePhaseFId(value.childConversationId, 'notice.childConversationId'),
    titlePreview: answerTitlePreview(value.title) };
}

/** Indexed scalar capture in the writer's acceptance transaction, after exact input fencing. */
export function captureAnswerPresentation(database: Database.Database, receipt: DomainRow,
  effectiveInputContentId: string | undefined, notice?: AcceptedAnswerNotice): DomainRow | null {
  const source = prepareCached(database, `
    SELECT delivery.inbox_item_id, delivery.attempt_seq, inbox.source_kind, inbox.source_id,
      submission.answer_bridge_id, submission.turn_id AS source_turn_id, submission.interrupted,
      bridge.child_execution_id, child.child_conversation_id,
      substr(peer.title, 1, 240) AS peer_title, substr(payload.title, 1, 240) AS answer_title,
      payload.content_object_id AS answer_content_object_id
    FROM runtime_delivery AS delivery JOIN runtime_inbox_item AS inbox ON inbox.id = delivery.inbox_item_id
    LEFT JOIN answer_submission AS submission ON inbox.source_kind = 'answer_submission' AND submission.id = inbox.source_id
    LEFT JOIN answer_bridge AS bridge ON bridge.id = submission.answer_bridge_id
    LEFT JOIN child_execution AS child ON child.id = bridge.child_execution_id
    LEFT JOIN conversation AS peer ON peer.id = child.child_conversation_id
    LEFT JOIN answer_payload AS payload ON payload.submission_id = submission.id
    WHERE delivery.id = ? AND delivery.target_conversation_id = ? AND delivery.state = 'consumed'
  `).get(receipt.delivery_id, receipt.conversation_id) as DomainRow | undefined;
  if (!source) throw new Error('Answer presentation requires its consumed scoped delivery.');
  if (source.source_kind !== 'answer_submission') {
    if (notice) throw new Error('Only an answer delivery can carry a child-deletion notice.');
    return null;
  }
  let body = effectiveInputContentId;
  if (receipt.acceptance_kind === 'notification') {
    if (body || notice) throw new Error('A notification cannot claim a model input.');
    body = (prepareCached(database, 'SELECT content_object_id FROM runtime_inbox_payload_link WHERE inbox_item_id = ?')
      .get(source.inbox_item_id) as { content_object_id: string } | undefined)?.content_object_id;
  }
  if (!body) throw new Error('Accepted answer has no exact effective body.');
  const metadata = prepareCached(database, 'SELECT content_type FROM content_object WHERE id = ?').get(body) as { content_type: string } | undefined;
  if (!metadata) throw new Error('Accepted answer body metadata is missing.');
  const deletedNotice = metadata.content_type === CHILD_ANSWER_SOURCE_DELETED_CONTENT_TYPE;
  if (deletedNotice) {
    if (!notice || notice.submissionId !== source.source_id || receipt.acceptance_kind !== 'input') {
      throw new Error('Accepted deletion notice requires its exact projected identity.');
    }
  } else if (notice || !source.child_execution_id || source.answer_content_object_id !== body) {
    throw new Error('Accepted answer presentation conflicts with its live immutable source.');
  }
  return {
    id: stablePhaseFId('runtime_delivery_answer_presentation', String(receipt.delivery_id)),
    conversation_id: receipt.conversation_id, delivery_id: receipt.delivery_id,
    inbox_item_id: source.inbox_item_id, attempt_seq: source.attempt_seq, submission_id: source.source_id,
    child_execution_id: deletedNotice ? notice!.childExecutionId : source.child_execution_id,
    child_conversation_id: deletedNotice ? notice!.childConversationId : source.child_conversation_id,
    answer_bridge_id: deletedNotice ? notice!.answerBridgeId : source.answer_bridge_id,
    source_turn_id: deletedNotice ? notice!.sourceTurnId : source.source_turn_id,
    outcome: deletedNotice ? 'failed' : answerSubmissionClientOutcome({ id: source.source_id,
      turn_id: source.source_turn_id, interrupted: source.interrupted }, String(source.child_execution_id)),
    peer_title_preview: deletedNotice ? notice!.titlePreview : answerTitlePreview(source.peer_title),
    answer_title_preview: deletedNotice ? null : answerTitlePreview(source.answer_title),
    body_content_object_id: body,
    body_representation: receipt.acceptance_kind === 'input' ? 'effective-input' : 'answer-payload'
  };
}

/** Historical copies retain scalar evidence and never depend on the deleted source entities. */
export function assertAnswerPresentation(database: Database.Database, row: DomainRow): void {
  const scope = prepareCached(database, `SELECT delivery.target_conversation_id, delivery.inbox_item_id,
      delivery.attempt_seq, inbox.source_kind, inbox.source_id
    FROM runtime_delivery AS delivery JOIN runtime_inbox_item AS inbox ON inbox.id = delivery.inbox_item_id
    WHERE delivery.id = ? AND delivery.state = 'consumed'`).get(row.delivery_id) as DomainRow | undefined;
  if (!scope || scope.target_conversation_id !== row.conversation_id || scope.inbox_item_id !== row.inbox_item_id
    || scope.attempt_seq !== row.attempt_seq || scope.source_kind !== 'answer_submission' || scope.source_id !== row.submission_id
    || row.id !== stablePhaseFId('runtime_delivery_answer_presentation', String(row.delivery_id))
    || !['submitted', 'interrupted', 'failed', 'unknown'].includes(String(row.outcome))
    || !['effective-input', 'answer-payload', 'historical-runtime-envelope'].includes(String(row.body_representation))) {
    throw new Error('Retained answer presentation conflicts with its immutable delivery identity.');
  }
  for (const key of ['peer_title_preview', 'answer_title_preview']) {
    if (row[key] !== null && (typeof row[key] !== 'string' || Buffer.byteLength(row[key] as string, 'utf8') > 240)) {
      throw new Error('Retained answer title preview exceeds its bounded contract.');
    }
  }
}

export function projectAnswerPresentation(database: Database.Database, row: DomainRow): DomainRow {
  const metadata = prepareCached(database, 'SELECT content_type FROM content_object WHERE id = ?')
    .get(row.body_content_object_id) as { content_type: string } | undefined;
  if (!metadata) throw new Error('Retained answer lost its referenced body metadata.');
  const peerState = typeof row.child_conversation_id !== 'string' ? 'unknown'
    : prepareCached(database, 'SELECT id FROM conversation WHERE id = ?').get(row.child_conversation_id) ? 'known' : 'deleted';
  return { ...row, peer_state: peerState, body_content_type: metadata.content_type };
}

/** Position proof wins. Without it, attempt order is only a stable display identity policy. */
export function canonicalAnswerPresentations(database: Database.Database, conversationId: string, inboxIds: readonly string[]): DomainRow[] {
  const positioned = prepareCached(database, `SELECT presentation.* FROM (
      SELECT delivery_id FROM runtime_delivery_timeline_link WHERE conversation_id = ? AND inbox_item_id = ?
      ORDER BY exchange_seq LIMIT 1
    ) AS canonical JOIN runtime_delivery_answer_presentation AS presentation ON presentation.delivery_id = canonical.delivery_id`);
  const unpositioned = prepareCached(database, `SELECT * FROM runtime_delivery_answer_presentation
    WHERE conversation_id = ? AND inbox_item_id = ? ORDER BY attempt_seq LIMIT 1`);
  const result: DomainRow[] = [];
  for (const inboxId of new Set(inboxIds)) {
    const row = (positioned.get(conversationId, inboxId) ?? unpositioned.get(conversationId, inboxId)) as DomainRow | undefined;
    if (row) result.push(projectAnswerPresentation(database, row));
  }
  return result;
}
