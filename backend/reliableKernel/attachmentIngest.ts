import { createHash } from 'node:crypto';
import { decodeCanonicalBase64 as decodeCanonicalBase64Value } from '../capabilities/canonicalBase64';
import { sqliteDatabaseFileRefusal, sqliteDatabaseFileRefusalMessage } from '../capabilities/filesystem/sqliteDatabaseFileGuard';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  type AttachmentSettingsRecord,
  type InlineDataPart
} from '../../shared/protocol';
import {
  ContentAddressedStore,
  type ContentObjectMetadata,
  type PreparedContentObject
} from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import { stablePhaseDId } from './effectControlPlane';
import {
  DOMAIN_REPOSITORIES,
  savepoint,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';

const MESSAGE_CONTENT_TYPE = 'application/vnd.limcode.message+json';

export interface AttachmentSettingsAuthority {
  loadGlobalSettings(section: 'attachments'): Promise<{
    section: string;
    settings: unknown;
    filePath: string;
  }>;
}

export interface AttachmentIngestResult {
  attachmentId: string;
  attachmentLinkId: string;
  contentObjectId: string;
  byteLength: string;
  position: string;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface PreparedAttachmentReference {
  attachmentId: string;
  position: string;
  mimeType: string;
  name: string;
  sha256: string;
  sizeBytes: number;
}

export interface PreparedAttachmentAdmission<T = unknown> {
  value: T;
  attachments: PreparedAttachmentReference[];
  storageSteps: RepositoryTransactionStep[];
  totalBytes: number;
}

export interface PreparedMessageAttachmentAdmission extends PreparedAttachmentAdmission<string | Uint8Array> {
  contentType: string;
}

interface EmbeddedAttachmentCandidate extends PreparedAttachmentReference {
  bytes: Buffer;
  prepared?: PreparedContentObject;
}

interface AttachmentTransformContext {
  position: number;
  embedded: EmbeddedAttachmentCandidate[];
  references: PreparedAttachmentReference[];
  outputs: InlineDataPart['inlineData'][];
}

/** Reads the existing settings authority; attachment bytes never enter Runtime SQLite. */
export class AttachmentIngestService {
  private readonly now: () => string;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly settingsAuthority: AttachmentSettingsAuthority,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * Externalizes every embedded InlineDataPart before a MessageContent becomes durable. The returned
   * storage steps and link steps are deliberately separate so Turn admission can publish immutable
   * Attachment rows with a queued intent, then link them atomically with the visible MessageRevision.
   */
  public async prepareMessageContent(input: {
    content: string | Uint8Array;
    contentType: string;
  }): Promise<PreparedMessageAttachmentAdmission> {
    if (input.contentType !== MESSAGE_CONTENT_TYPE) {
      return {
        value: input.content,
        contentType: input.contentType,
        attachments: [],
        storageSteps: [],
        totalBytes: 0
      };
    }
    const source = typeof input.content === 'string'
      ? input.content
      : Buffer.from(input.content).toString('utf8');
    const parsed = JSON.parse(source) as unknown;
    const prepared = await this.prepareValueAttachments(parsed, 'MessageContent');
    return {
      ...prepared,
      value: JSON.stringify(prepared.value),
      contentType: input.contentType
    };
  }

  public async prepareFrozenMessageContent(input: {
    content: string | Uint8Array;
    contentType: string;
  }): Promise<PreparedMessageAttachmentAdmission> {
    if (input.contentType !== MESSAGE_CONTENT_TYPE) {
      return {
        value: input.content,
        contentType: input.contentType,
        attachments: [],
        storageSteps: [],
        totalBytes: 0
      };
    }
    const source = typeof input.content === 'string'
      ? input.content
      : Buffer.from(input.content).toString('utf8');
    const parsed = JSON.parse(source) as unknown;
    const prepared = await this.prepareFrozenValueAttachments(parsed, 'Frozen MessageContent');
    return {
      ...prepared,
      value: JSON.stringify(prepared.value),
      contentType: input.contentType
    };
  }

  /** Externalizes attachment-shaped values used by tool result envelopes. */
  public async prepareValueAttachments<T>(value: T, label = 'attachment value'): Promise<PreparedAttachmentAdmission<T>> {
    return this.prepareValueAttachmentsInternal(value, label, true);
  }

  /** Revalidates immutable refs that already passed policy admission without consulting mutable settings. */
  public async prepareFrozenValueAttachments<T>(
    value: T,
    label = 'frozen attachment value'
  ): Promise<PreparedAttachmentAdmission<T>> {
    return this.prepareValueAttachmentsInternal(value, label, false);
  }

  private async prepareValueAttachmentsInternal<T>(
    value: T,
    label: string,
    enforceCurrentSettings: boolean
  ): Promise<PreparedAttachmentAdmission<T>> {
    const hasNewAttachmentMaterial = containsNewAttachmentMaterial(value);
    let maxBytes: bigint | undefined;
    if (enforceCurrentSettings && hasNewAttachmentMaterial) {
      const settings = await this.loadSettings();
      maxBytes = BigInt(settings.maxStoredInlineFileMb) * 1024n * 1024n;
    }
    const materialized = await this.materializeLocalPathAttachments(
      value,
      label,
      maxBytes,
      new Map<string, Buffer>()
    );
    const context: AttachmentTransformContext = { position: 0, embedded: [], references: [], outputs: [] };
    const transformed = this.transformValue(materialized, context, label, maxBytes) as T;
    if (context.references.length === 0) {
      return { value: transformed, attachments: [], storageSteps: [], totalBytes: 0 };
    }

    const existingById = new Map<string, DomainRow>();
    for (const reference of context.references) {
      if (context.embedded.some((candidate) => candidate.attachmentId === reference.attachmentId)) continue;
      const existing = await this.requireExisting('Attachment', reference.attachmentId);
      existingById.set(reference.attachmentId, existing);
      const byteLength = requireBigInt(existing.byte_length, 'Attachment.byte_length');
      reference.sizeBytes = safeByteLength(byteLength, 'Attachment.byte_length');
      reference.mimeType = requireText(existing.mime_type, 'Attachment.mime_type');
      reference.name = requireText(existing.name, 'Attachment.name');
      reference.sha256 = requireText(existing.sha256, 'Attachment.sha256');
    }
    context.references.forEach((reference, index) => {
      Object.assign(context.outputs[index], managedReference(reference));
    });

    let totalBytes = 0n;
    let newlyAdmittedBytes = 0n;
    const embeddedIds = new Set(context.embedded.map((candidate) => candidate.attachmentId));
    for (const reference of context.references) {
      const size = BigInt(reference.sizeBytes);
      if (embeddedIds.has(reference.attachmentId)) {
        if (maxBytes !== undefined && size > maxBytes) {
          throw new AttachmentSizeLimitError(
            `Attachment ${reference.name} is ${size.toString()} bytes; settings allow at most ${maxBytes.toString()} bytes.`
          );
        }
        newlyAdmittedBytes += size;
      }
      totalBytes += size;
    }
    if (maxBytes !== undefined && newlyAdmittedBytes > maxBytes) {
      throw new AttachmentSizeLimitError(
        `New attachments total ${newlyAdmittedBytes.toString()} bytes; one message allows at most ${maxBytes.toString()} bytes.`
      );
    }

    const uniqueEmbedded = [...new Map(context.embedded.map((entry) => [entry.attachmentId, entry])).values()];
    if (uniqueEmbedded.length > 0) {
      const prepared = await this.contentStore.prepareBatch(
        this.database,
        uniqueEmbedded.map((entry) => ({ content: entry.bytes, contentType: entry.mimeType }))
      );
      uniqueEmbedded.forEach((entry, index) => { entry.prepared = prepared[index]; });
    }

    const scope = createHash('sha256')
      .update(context.references.map((entry) => `${entry.attachmentId}:${entry.position}`).join('|'))
      .digest('hex')
      .slice(0, 12);
    const storageSteps: RepositoryTransactionStep[] = [];
    const preparedObjects = uniqueEmbedded.map((entry) => requirePrepared(entry.prepared, entry.attachmentId));
    storageSteps.push(...preparedContentObjectSteps(preparedObjects, `attc_${scope}`));
    uniqueEmbedded.forEach((entry, index) => {
      const prepared = requirePrepared(entry.prepared, entry.attachmentId);
      storageSteps.push(
        savepoint(`atti_${scope}_${index}`, [
          DOMAIN_REPOSITORIES.domain('Attachment').insert({
            id: entry.attachmentId,
            sha256: entry.sha256,
            byte_length: String(entry.sizeBytes),
            mime_type: entry.mimeType,
            name: entry.name,
            storage_mode: 'cas',
            content_object_id: prepared.metadata.id,
            created_at: this.timestamp()
          })
        ], {
          kind: 'rollback-and-continue-on-unique',
          constraints: [{ domain: 'Attachment', columns: ['id'] }]
        }),
        DOMAIN_REPOSITORIES.domain('Attachment').assert(entry.attachmentId, {
          sha256: entry.sha256,
          byte_length: String(entry.sizeBytes),
          mime_type: entry.mimeType,
          name: entry.name,
          storage_mode: 'cas',
          content_object_id: prepared.metadata.id
        })
      );
    });
    for (const [attachmentId, existing] of existingById) {
      storageSteps.push(DOMAIN_REPOSITORIES.domain('Attachment').assert(attachmentId, {
        sha256: requireText(existing.sha256, 'Attachment.sha256'),
        byte_length: requireBigInt(existing.byte_length, 'Attachment.byte_length'),
        storage_mode: 'cas',
        content_object_id: requireId(existing.content_object_id, 'Attachment.content_object_id')
      }));
    }

    return {
      value: transformed,
      attachments: context.references,
      storageSteps,
      totalBytes: safeByteLength(totalBytes, 'attachment total')
    };
  }

  /**
   * Resolves the exact attachment bytes used at a Provider boundary. A local-path reference is
   * admitted into Runtime CAS first, so subsequent retries/compact calls no longer depend on a
   * mutable file path and always carry verified size/digest metadata.
   */
  public async resolveProviderInlineData(input: {
    attachmentId?: string;
    sourcePath?: string;
    mimeType?: string;
    name?: string;
  }): Promise<InlineDataPart> {
    const attachmentId = optionalText(input.attachmentId);
    const sourcePath = optionalText(input.sourcePath);
    if (attachmentId && sourcePath) {
      throw new AttachmentContentError('Provider attachment reference cannot contain both attachmentId and sourcePath.');
    }
    if (attachmentId) return this.resolveInlineData(attachmentId);
    if (!sourcePath) {
      throw new AttachmentMediaSizeUnknownError('Provider attachment is missing attachmentId and sourcePath.');
    }

    const admission = await this.prepareValueAttachments<InlineDataPart>({
      inlineData: {
        mimeType: optionalText(input.mimeType) ?? 'application/octet-stream',
        name: optionalText(input.name) ?? path.basename(sourcePath),
        sourcePath,
        storage: 'localPath',
        status: 'available'
      }
    }, 'Provider attachment');
    if (admission.storageSteps.length === 0) {
      throw new AttachmentMediaSizeUnknownError(`Provider attachment ${sourcePath} was not materialized into Runtime CAS.`);
    }
    await this.database.transaction(admission.storageSteps);
    const managedId = admission.value.inlineData.attachmentId;
    if (!managedId) {
      throw new AttachmentMediaSizeUnknownError(`Provider attachment ${sourcePath} has no managed attachment id.`);
    }
    return this.resolveInlineData(managedId);
  }

  private async materializeLocalPathAttachments(
    value: unknown,
    label: string,
    maxBytes: bigint | undefined,
    cache: Map<string, Buffer>
  ): Promise<unknown> {
    if (Array.isArray(value)) {
      return Promise.all(value.map((entry, index) =>
        this.materializeLocalPathAttachments(entry, `${label}[${index}]`, maxBytes, cache)));
    }
    if (ArrayBuffer.isView(value)) return value;
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    if (isInlineDataWrapper(record)) {
      const raw = record.inlineData;
      const attachmentId = optionalText(raw.attachmentId);
      const sourcePath = optionalText(raw.sourcePath);
      if (attachmentId && sourcePath) {
        throw new AttachmentContentError(`${label}.inlineData cannot contain both attachmentId and sourcePath.`);
      }
      if (typeof raw.data === 'string' || attachmentId) return value;
      if (!sourcePath) {
        if (raw.storage === 'localPath') {
          throw new AttachmentMediaSizeUnknownError(`${label}.inlineData localPath reference has no sourcePath.`);
        }
        return value;
      }
      const absolutePath = requireAbsoluteSourcePath(sourcePath, `${label}.inlineData.sourcePath`);
      let bytes = cache.get(absolutePath);
      if (!bytes) {
        bytes = await readLocalAttachmentBytes(absolutePath, maxBytes, `${label}.inlineData`);
        cache.set(absolutePath, bytes);
      }
      return {
        ...record,
        inlineData: {
          ...raw,
          mimeType: optionalText(raw.mimeType) ?? 'application/octet-stream',
          name: optionalText(raw.name) ?? path.basename(absolutePath),
          sourcePath: absolutePath,
          storage: 'localPath',
          status: 'available',
          sizeBytes: bytes.byteLength,
          data: bytes.toString('base64')
        }
      };
    }
    const entries = await Promise.all(Object.entries(record).map(async ([key, entry]) => [
      key,
      await this.materializeLocalPathAttachments(entry, `${label}.${key}`, maxBytes, cache)
    ] as const));
    return Object.fromEntries(entries);
  }

  /** Creates the immutable AttachmentLink rows in the same transaction as the target revision. */
  public linkSteps(
    admission: Pick<PreparedAttachmentAdmission, 'attachments'>,
    messageRevisionIdInput: string,
    createdAt = this.timestamp()
  ): RepositoryTransactionStep[] {
    const messageRevisionId = requireId(messageRevisionIdInput, 'messageRevisionId');
    return admission.attachments.map((reference) => DOMAIN_REPOSITORIES.domain('AttachmentLink').insert({
      id: stablePhaseDId(
        'attachment_link',
        JSON.stringify([messageRevisionId, reference.attachmentId, reference.position])
      ),
      message_revision_id: messageRevisionId,
      attachment_id: reference.attachmentId,
      position: reference.position,
      created_at: createdAt
    }));
  }

  public async ingest(input: {
    messageRevisionId: string;
    position: string;
    name: string;
    mimeType: string;
    bytes: Uint8Array;
  }): Promise<AttachmentIngestResult> {
    const messageRevisionId = requireId(input.messageRevisionId, 'messageRevisionId');
    const position = requireDecimalString(input.position, 'AttachmentLink.position');
    const name = requireText(input.name, 'attachment name');
    const mimeType = requireText(input.mimeType, 'attachment mimeType');
    const bytes = Buffer.from(input.bytes);
    const settings = await this.loadSettings();
    const maxBytes = BigInt(settings.maxStoredInlineFileMb) * 1024n * 1024n;
    if (BigInt(bytes.byteLength) > maxBytes) {
      throw new AttachmentSizeLimitError(
        `Attachment is ${bytes.byteLength} bytes; settings allow at most ${maxBytes.toString()} bytes.`
      );
    }
    await this.requireExisting('MessageRevision', messageRevisionId);

    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const attachmentId = stablePhaseDId('attachment', JSON.stringify([sha256, mimeType, name]));
    const attachmentLinkId = stablePhaseDId(
      'attachment_link',
      JSON.stringify([messageRevisionId, attachmentId, position])
    );
    const existingLink = await this.maybeGet('AttachmentLink', attachmentLinkId);
    if (existingLink) return this.replay(existingLink, attachmentId, position);

    const prepared = await this.contentStore.prepare(this.database, bytes, mimeType);
    const now = this.timestamp();
    try {
      const committed = await this.database.transaction([
        ...preparedContentObjectSteps([prepared], 'attachment_content'),
        savepoint('attachment_identity', [
          DOMAIN_REPOSITORIES.domain('Attachment').insert({
            id: attachmentId,
            sha256,
            byte_length: String(bytes.byteLength),
            mime_type: mimeType,
            name,
            storage_mode: 'cas',
            content_object_id: prepared.metadata.id,
            created_at: now
          })
        ], {
          kind: 'rollback-and-continue-on-unique',
          constraints: [{ domain: 'Attachment', columns: ['id'] }]
        }),
        DOMAIN_REPOSITORIES.domain('Attachment').assert(attachmentId, {
          sha256,
          byte_length: String(bytes.byteLength),
          mime_type: mimeType,
          name,
          storage_mode: 'cas',
          content_object_id: prepared.metadata.id
        }),
        DOMAIN_REPOSITORIES.domain('AttachmentLink').insert({
          id: attachmentLinkId,
          message_revision_id: messageRevisionId,
          attachment_id: attachmentId,
          position,
          created_at: now
        })
      ]);
      return {
        attachmentId,
        attachmentLinkId,
        contentObjectId: prepared.metadata.id,
        byteLength: String(bytes.byteLength),
        position,
        deduplicated: false,
        commitSeq: committed.commitSeq
      };
    } catch (error) {
      if (!matchesAttachmentLinkUnique(error)) throw error;
      const raced = await this.maybeGet('AttachmentLink', attachmentLinkId);
      if (!raced) throw error;
      return this.replay(raced, attachmentId, position);
    }
  }

  public async read(attachmentIdInput: string): Promise<Buffer> {
    const attachmentId = requireId(attachmentIdInput, 'attachmentId');
    const attachment = await this.requireExisting('Attachment', attachmentId);
    if (attachment.storage_mode !== 'cas') throw new Error(`Attachment ${attachmentId} is not CAS-backed.`);
    const contentObjectId = requireId(attachment.content_object_id, 'Attachment.content_object_id');
    const metadata = await this.requireExisting('ContentObject', contentObjectId) as ContentObjectMetadata;
    const bytes = await this.contentStore.read(metadata);
    if (
      createHash('sha256').update(bytes).digest('hex') !== attachment.sha256
      || BigInt(bytes.byteLength) !== requireBigInt(attachment.byte_length, 'Attachment.byte_length')
    ) throw new Error(`Attachment ${attachmentId} CAS content does not match its immutable metadata.`);
    return bytes;
  }

  public async managedReference(attachmentIdInput: string): Promise<InlineDataPart> {
    const attachmentId = requireId(attachmentIdInput, 'attachmentId');
    const attachment = await this.requireExisting('Attachment', attachmentId);
    if (attachment.storage_mode !== 'cas') throw new Error(`Attachment ${attachmentId} is not CAS-backed.`);
    return {
      inlineData: {
        attachmentId,
        mimeType: requireText(attachment.mime_type, 'Attachment.mime_type'),
        name: requireText(attachment.name, 'Attachment.name'),
        sha256: requireText(attachment.sha256, 'Attachment.sha256'),
        storage: 'managed',
        status: 'available',
        sizeBytes: safeByteLength(
          requireBigInt(attachment.byte_length, 'Attachment.byte_length'),
          'Attachment.byte_length'
        )
      }
    };
  }

  public async resolveInlineData(attachmentIdInput: string): Promise<InlineDataPart> {
    const reference = await this.managedReference(attachmentIdInput);
    const attachmentId = requireId(reference.inlineData.attachmentId, 'InlineDataPart.attachmentId');
    const bytes = await this.read(attachmentId);
    return {
      inlineData: {
        ...reference.inlineData,
        data: bytes.toString('base64')
      }
    };
  }

  private transformValue(
    value: unknown,
    context: AttachmentTransformContext,
    label: string,
    maxBytes: bigint | undefined
  ): unknown {
    if (Array.isArray(value)) {
      return value.map((entry, index) => this.transformValue(entry, context, `${label}[${index}]`, maxBytes));
    }
    if (!value || typeof value !== 'object') return value;
    const record = value as Record<string, unknown>;
    if (isInlineDataWrapper(record)) return this.transformInlineData(record.inlineData, context, label, maxBytes);
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [
      key,
      this.transformValue(entry, context, `${label}.${key}`, maxBytes)
    ]));
  }

  private transformInlineData(
    raw: Record<string, unknown>,
    context: AttachmentTransformContext,
    label: string,
    maxBytes: bigint | undefined
  ): InlineDataPart {
    const position = String(context.position++);
    const mimeType = optionalText(raw.mimeType) ?? 'application/octet-stream';
    const name = optionalText(raw.name) ?? `attachment-${Number(position) + 1}${extensionForMimeType(mimeType)}`;
    if (typeof raw.data === 'string') {
      const bytes = decodeAttachmentBase64(raw.data, `${label}.inlineData.data`, maxBytes);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const attachmentId = stablePhaseDId('attachment', JSON.stringify([sha256, mimeType, name]));
      const reference: EmbeddedAttachmentCandidate = {
        attachmentId,
        position,
        mimeType,
        name,
        sha256,
        sizeBytes: bytes.byteLength,
        bytes
      };
      context.embedded.push(reference);
      context.references.push(reference);
      const output = managedReference(reference);
      context.outputs.push(output);
      return { inlineData: output };
    }

    const attachmentId = optionalText(raw.attachmentId);
    if (attachmentId) {
      const reference: PreparedAttachmentReference = {
        attachmentId,
        position,
        mimeType,
        name,
        sha256: optionalText(raw.sha256) ?? 'pending',
        sizeBytes: optionalNonNegativeInteger(raw.sizeBytes) ?? 0
      };
      context.references.push(reference);
      const output = managedReference(reference);
      context.outputs.push(output);
      return { inlineData: output };
    }

    return { inlineData: { ...raw, mimeType, name } as InlineDataPart['inlineData'] };
  }

  private async loadSettings(): Promise<AttachmentSettingsRecord> {
    const loaded = await this.settingsAuthority.loadGlobalSettings('attachments');
    const settings = loaded.settings as Partial<AttachmentSettingsRecord> | undefined;
    const value = Number(settings?.maxStoredInlineFileMb);
    if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
      throw new Error('Attachment settings authority returned invalid maxStoredInlineFileMb.');
    }
    return { maxStoredInlineFileMb: value };
  }

  private async replay(link: DomainRow, attachmentId: string, position: string): Promise<AttachmentIngestResult> {
    if (link.attachment_id !== attachmentId || requireBigInt(link.position, 'AttachmentLink.position').toString() !== position) {
      throw new Error('AttachmentLink stable identity conflicts with requested attachment.');
    }
    const attachment = await this.requireExisting('Attachment', attachmentId);
    return {
      attachmentId,
      attachmentLinkId: link.id as string,
      contentObjectId: requireId(attachment.content_object_id, 'Attachment.content_object_id'),
      byteLength: requireBigInt(attachment.byte_length, 'Attachment.byte_length').toString(),
      position,
      deduplicated: true
    };
  }

  private async maybeGet(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    if (Array.isArray(row)) throw new TypeError(`${domain} get returned a list.`);
    return row;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const row = await this.maybeGet(domain, id);
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

export class AttachmentAdmissionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AttachmentAdmissionError';
  }
}

export class AttachmentSizeLimitError extends AttachmentAdmissionError {
  public constructor(message: string) {
    super(message);
    this.name = 'AttachmentSizeLimitError';
  }
}

export class AttachmentContentError extends AttachmentAdmissionError {
  public constructor(message: string) {
    super(message);
    this.name = 'AttachmentContentError';
  }
}

/** Stable admission failure used when a local/provider media reference cannot be sized exactly. */
export class AttachmentMediaSizeUnknownError extends AttachmentAdmissionError {
  public readonly code = 'media_size_unknown';

  public constructor(message: string) {
    super(`media_size_unknown: ${message}`);
    this.name = 'AttachmentMediaSizeUnknownError';
  }
}

function managedReference(reference: PreparedAttachmentReference): InlineDataPart['inlineData'] {
  return {
    mimeType: reference.mimeType,
    name: reference.name,
    attachmentId: reference.attachmentId,
    sha256: reference.sha256,
    storage: 'managed',
    status: 'available',
    sizeBytes: reference.sizeBytes
  };
}

function isInlineDataWrapper(value: Record<string, unknown>): value is { inlineData: Record<string, unknown> } {
  return !!value.inlineData && typeof value.inlineData === 'object' && !Array.isArray(value.inlineData);
}

function containsNewAttachmentMaterial(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsNewAttachmentMaterial);
  if (ArrayBuffer.isView(value)) return false;
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (isInlineDataWrapper(record)) {
    return typeof record.inlineData.data === 'string'
      || typeof record.inlineData.sourcePath === 'string';
  }
  return Object.values(record).some(containsNewAttachmentMaterial);
}


function requireAbsoluteSourcePath(value: string, label: string): string {
  if (!path.isAbsolute(value)) {
    throw new AttachmentMediaSizeUnknownError(`${label} must be an absolute path: ${value}`);
  }
  return path.normalize(value);
}

async function readLocalAttachmentBytes(
  sourcePath: string,
  maxBytes: bigint | undefined,
  label: string
): Promise<Buffer> {
  // The bytes are read in the extension host process, which also holds SQLite connections.
  const refusal = await sqliteDatabaseFileRefusal(sourcePath);
  if (refusal) throw new AttachmentContentError(`${label}: ${sqliteDatabaseFileRefusalMessage(refusal)}`);
  let metadata;
  try {
    metadata = await fs.stat(sourcePath, { bigint: true });
  } catch (error) {
    throw new AttachmentMediaSizeUnknownError(`${label} cannot stat ${sourcePath}: ${errorText(error)}`);
  }
  if (!metadata.isFile()) {
    throw new AttachmentMediaSizeUnknownError(`${label} is not a regular file: ${sourcePath}`);
  }
  if (metadata.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AttachmentMediaSizeUnknownError(`${label} exceeds the supported byte range: ${sourcePath}`);
  }
  if (maxBytes !== undefined && metadata.size > maxBytes) {
    throw new AttachmentSizeLimitError(
      `Attachment ${path.basename(sourcePath)} is ${metadata.size.toString()} bytes; settings allow at most ${maxBytes.toString()} bytes.`
    );
  }

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(sourcePath);
  } catch (error) {
    throw new AttachmentMediaSizeUnknownError(`${label} cannot read ${sourcePath}: ${errorText(error)}`);
  }
  if (maxBytes !== undefined && BigInt(bytes.byteLength) > maxBytes) {
    throw new AttachmentSizeLimitError(
      `Attachment ${path.basename(sourcePath)} is ${bytes.byteLength} bytes; settings allow at most ${maxBytes.toString()} bytes.`
    );
  }
  return bytes;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return String(error);
}

function decodeAttachmentBase64(value: string, label: string, maxBytes: bigint | undefined): Buffer {
  const byteLimit = maxBytes === undefined ? undefined : safeByteLength(maxBytes, `${label} limit`);
  try {
    return decodeCanonicalBase64Value(value, byteLimit === undefined ? {} : { maxBytes: byteLimit });
  } catch (error) {
    if (error instanceof RangeError && byteLimit !== undefined) {
      throw new AttachmentSizeLimitError(
        `Attachment data exceeds the configured ${byteLimit} byte limit.`
      );
    }
    throw new AttachmentContentError(`${label} must be canonical base64.`);
  }
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    case 'application/pdf': return '.pdf';
    case 'text/plain': return '.txt';
    case 'application/json': return '.json';
    case 'audio/mpeg': return '.mp3';
    case 'video/mp4': return '.mp4';
    default: return '';
  }
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function requirePrepared(value: PreparedContentObject | undefined, label: string): PreparedContentObject {
  if (!value) throw new Error(`Attachment ${label} lost its prepared CAS object.`);
  return value;
}

function matchesAttachmentLinkUnique(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown };
  if (
    typeof value.code !== 'string'
    || !['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'].includes(value.code)
    || typeof value.message !== 'string'
  ) return false;
  const marker = 'UNIQUE constraint failed:';
  const index = value.message.indexOf(marker);
  if (index < 0) return false;
  const actual = value.message.slice(index + marker.length).split(',').map((entry) => entry.trim()).filter(Boolean).sort();
  const expected = [
    ['attachment_link.id'],
    ['attachment_link.message_revision_id', 'attachment_link.attachment_id', 'attachment_link.position']
  ];
  return expected.some((columns) => {
    const wanted = [...columns].sort();
    return wanted.length === actual.length && wanted.every((column, ordinal) => column === actual[ordinal]);
  });
}

function safeByteLength(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new RangeError(`${label} exceeds the supported byte range.`);
  return number;
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${label} must remain bigint in JavaScript.`);
  return value;
}

function requireDecimalString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string.`);
  }
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value.trim();
}
