import type { DomainRow } from './repositories';

/** Complete owner evidence for one source. A missing tool owner can be a deleted fork alias. */
export interface AttachmentSourceOwnerEvidence {
  messageRevision?: DomainRow;
  memberships?: DomainRow[];
  toolResult?: DomainRow;
  toolCall?: DomainRow;
  turn?: DomainRow;
  compressionBlock?: DomainRow;
}

/** Shared by the read-side projection and its SQLite bulk reader; never infer ownership from ids. */
export function attachmentSourceBelongsToConversation(
  source: DomainRow,
  conversationId: string,
  owner: AttachmentSourceOwnerEvidence
): boolean {
  const kind = attachmentProjectionId(source.source_kind, 'ContextSegmentSource.source_kind');
  const sourceId = attachmentProjectionId(source.source_id, 'ContextSegmentSource.source_id');
  if (kind === 'message_revision') {
    if (!owner.messageRevision) throw new Error(`MessageRevision ${sourceId} cache was not primed.`);
    const messageId = attachmentProjectionId(owner.messageRevision.message_id, `MessageRevision ${sourceId}.message_id`);
    if (!owner.memberships) throw new Error(`MessagePartOfConversation cache was not primed for ${messageId}.`);
    if (owner.memberships.length > 1) throw new Error(`Message ${messageId} belongs to multiple Conversations.`);
    return owner.memberships.length === 1 && owner.memberships[0].conversation_id === conversationId;
  }
  if (kind === 'tool_model_result') {
    if (!owner.toolResult) return false;
    attachmentProjectionId(owner.toolResult.tool_call_id, `ToolModelResult ${sourceId}.tool_call_id`);
  }
  if (kind === 'tool_call' || kind === 'tool_model_result') {
    if (!owner.toolCall) return false;
    attachmentProjectionId(owner.toolCall.turn_id, `ToolCall ${owner.toolCall.id}.turn_id`);
    return owner.turn?.conversation_id === conversationId;
  }
  if (kind === 'compression_block') return owner.compressionBlock?.conversation_id === conversationId;
  // Shared system/runtime sources and unknown kinds reach the structural validator unchanged.
  return true;
}

export function compareAttachmentSegmentSource(left: DomainRow, right: DomainRow): number {
  const leftRevision = revision(left.source_revision);
  const rightRevision = revision(right.source_revision);
  if (leftRevision !== rightRevision) return leftRevision < rightRevision ? -1 : 1;
  const kind = attachmentProjectionId(left.source_kind, 'ContextSegmentSource.source_kind')
    .localeCompare(attachmentProjectionId(right.source_kind, 'ContextSegmentSource.source_kind'));
  return kind || attachmentProjectionId(left.id, 'ContextSegmentSource.id')
    .localeCompare(attachmentProjectionId(right.id, 'ContextSegmentSource.id'));
}

export function attachmentProjectionId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty text.`);
  return value.trim();
}

function revision(value: unknown): bigint {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new TypeError('ContextSegmentSource.source_revision must be a non-negative SQLite INTEGER.');
  }
  return value;
}
