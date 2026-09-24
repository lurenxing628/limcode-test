import { createHash } from 'node:crypto';
import type { AttachmentCatalogEntry } from '../../shared/protocol';
import { normalizeAttachmentCatalog } from './attachmentCatalog';
import type { ModelHandleEntry } from './modelHandleCatalog';
import { DOMAIN_REPOSITORIES, savepoint, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

export interface ConversationAttachmentHandleProjection {
  entries: ModelHandleEntry[];
}

/** Stable Conversation-scoped model handles. Canonical Attachment identity never leaves Runtime. */
export class ConversationAttachmentHandleRegistry {
  private readonly now: () => string;

  public constructor(
    private readonly database: RuntimeDatabase,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async ensure(
    conversationIdInput: string,
    catalogInput: readonly AttachmentCatalogEntry[]
  ): Promise<ConversationAttachmentHandleProjection> {
    const conversationId = requireText(conversationIdInput, 'conversationId');
    const catalog = normalizeAttachmentCatalog(catalogInput, 'attachmentCatalog');
    if (catalog.length === 0) return { entries: [] };

    const observed = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Conversation').get(conversationId),
      ...catalog.map((entry) => DOMAIN_REPOSITORIES.domain('Attachment').get(entry.attachmentId))
    ]);
    const conversation = requireRow(observed.snapshot[0], `Conversation ${conversationId}`);
    const attachments = new Map<string, DomainRow>();
    catalog.forEach((entry, index) => {
      const attachment = requireRow(observed.snapshot[index + 1], `Attachment ${entry.attachmentId}`);
      assertAttachmentMetadata(attachment, entry);
      attachments.set(entry.attachmentId, attachment);
    });

    const existing = await this.readConversationLinks(conversationId);
    const existingByAttachment = validateLinks(existing, conversationId);
    const missing = catalog.filter((entry) => !existingByAttachment.has(entry.attachmentId));
    if (missing.length > 0) {
      const createdAt = requireText(this.now(), 'clock result');
      const repository = DOMAIN_REPOSITORIES.domain('ConversationAttachmentHandleLink');
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('Conversation').assert(conversationId, {
          status: requireText(conversation.status, 'Conversation.status')
        }),
        ...missing.flatMap((entry, index) => {
          const attachment = attachments.get(entry.attachmentId)!;
          const id = conversationAttachmentHandleLinkId(conversationId, entry.attachmentId);
          return [
            DOMAIN_REPOSITORIES.domain('Attachment').assert(entry.attachmentId, {
              sha256: attachment.sha256,
              byte_length: attachment.byte_length,
              mime_type: attachment.mime_type,
              name: attachment.name,
              content_object_id: attachment.content_object_id
            }),
            savepoint(`attachment_handle_${index}`, [
              repository.insertWithNextSequence({
                id,
                conversation_id: conversationId,
                attachment_id: entry.attachmentId,
                created_at: createdAt
              }, {
                column: 'handle_seq',
                scope: { conversation_id: conversationId }
              })
            ], {
              kind: 'rollback-and-continue-on-unique',
              constraints: [
                { domain: 'ConversationAttachmentHandleLink', columns: ['id'] },
                { domain: 'ConversationAttachmentHandleLink', columns: ['conversation_id', 'attachment_id'] }
              ]
            }),
            repository.assert(id, {
              conversation_id: conversationId,
              attachment_id: entry.attachmentId
            })
          ];
        })
      ]);
    }

    const links = validateLinks(await this.readConversationLinks(conversationId), conversationId);
    return {
      entries: catalog.map((entry): ModelHandleEntry => {
        const link = links.get(entry.attachmentId);
        if (!link) {
          throw new Error(`Conversation ${conversationId} has no stable handle for Attachment ${entry.attachmentId}.`);
        }
        return {
          kind: 'attachment',
          ref: `F${requirePositiveBigInt(link.handle_seq, 'ConversationAttachmentHandleLink.handle_seq').toString()}`,
          target: entry.attachmentId,
          name: entry.name,
          mimeType: entry.mimeType,
          sizeBytes: entry.sizeBytes
        };
      })
    };
  }

  /**
   * Read-only counterpart of ensure(): existing handles as they are, and the handles ensure() would
   * allocate next for Attachments that have none yet. Nothing is written.
   */
  public async peek(
    conversationIdInput: string,
    catalogInput: readonly AttachmentCatalogEntry[]
  ): Promise<ConversationAttachmentHandleProjection> {
    const conversationId = requireText(conversationIdInput, 'conversationId');
    const catalog = normalizeAttachmentCatalog(catalogInput, 'attachmentCatalog');
    if (catalog.length === 0) return { entries: [] };
    const links = validateLinks(await this.readConversationLinks(conversationId), conversationId);
    let nextSequence = [...links.values()].reduce((highest, link) => {
      const sequence = requirePositiveBigInt(link.handle_seq, 'ConversationAttachmentHandleLink.handle_seq');
      return sequence > highest ? sequence : highest;
    }, 0n);
    return {
      entries: catalog.map((entry): ModelHandleEntry => {
        const link = links.get(entry.attachmentId);
        const sequence = link
          ? requirePositiveBigInt(link.handle_seq, 'ConversationAttachmentHandleLink.handle_seq')
          : (nextSequence += 1n);
        return {
          kind: 'attachment',
          ref: `F${sequence.toString()}`,
          target: entry.attachmentId,
          name: entry.name,
          mimeType: entry.mimeType,
          sizeBytes: entry.sizeBytes
        };
      })
    };
  }

  private readConversationLinks(conversationId: string): Promise<DomainRow[]> {
    return listAllDomainRows(this.database, 'ConversationAttachmentHandleLink', {
      conversation_id: conversationId
    });
  }
}

export function conversationAttachmentHandleLinkId(conversationIdInput: string, attachmentIdInput: string): string {
  const conversationId = requireText(conversationIdInput, 'conversationId');
  const attachmentId = requireText(attachmentIdInput, 'attachmentId');
  const digest = createHash('sha256')
    .update('limcode-conversation-attachment-handle-link\0')
    .update(conversationId)
    .update('\0')
    .update(attachmentId)
    .digest('hex');
  return `conversation_attachment_handle_link_${digest}`;
}

function validateLinks(rows: readonly DomainRow[], conversationId: string): Map<string, DomainRow> {
  const byAttachment = new Map<string, DomainRow>();
  const sequences = new Set<string>();
  for (const row of rows) {
    if (row.conversation_id !== conversationId) {
      throw new Error('ConversationAttachmentHandleLink query returned another Conversation.');
    }
    const attachmentId = requireText(row.attachment_id, 'ConversationAttachmentHandleLink.attachment_id');
    const sequence = requirePositiveBigInt(
      row.handle_seq,
      'ConversationAttachmentHandleLink.handle_seq'
    ).toString();
    if (byAttachment.has(attachmentId)) {
      throw new Error(`Conversation ${conversationId} has duplicate handles for Attachment ${attachmentId}.`);
    }
    if (sequences.has(sequence)) {
      throw new Error(`Conversation ${conversationId} has duplicate attachment handle sequence ${sequence}.`);
    }
    byAttachment.set(attachmentId, row);
    sequences.add(sequence);
  }
  return byAttachment;
}

function assertAttachmentMetadata(row: DomainRow, entry: AttachmentCatalogEntry): void {
  if (
    row.id !== entry.attachmentId
    || row.name !== entry.name
    || row.mime_type !== entry.mimeType
    || requireNonNegativeBigInt(row.byte_length, 'Attachment.byte_length') !== BigInt(entry.sizeBytes)
  ) {
    throw new Error(`Attachment catalog metadata conflicts with immutable Attachment ${entry.attachmentId}.`);
  }
}

function requireRow(value: DomainRow | DomainRow[] | null, label: string): DomainRow {
  if (!value || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value;
}

function requirePositiveBigInt(value: unknown, label: string): bigint {
  const integer = requireNonNegativeBigInt(value, label);
  if (integer <= 0n) throw new TypeError(`${label} must be positive.`);
  return integer;
}

function requireNonNegativeBigInt(value: unknown, label: string): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw new TypeError(`${label} must be a non-negative integer.`);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty text.`);
  return value.trim();
}
