import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import { storageKeyForDigest } from './contentAddressedStore';
import {
  runtimeContinuationTurnIntentEnvelope
} from './guidanceIntent';
import { canonicalPlainJson } from './plainJson';
import {
  CHILD_RUNTIME_DELIVERY_CONTINUATION_CONTENT_TYPE,
  TURN_EXECUTION_PRESET_CONTENT_TYPE,
  childRuntimeDeliveryContinuationIds
} from './runtimeDeliveryContinuationIdentity';

const LEGACY_CHILD_RUNTIME_CONTINUATION_KIND = 'child-runtime-delivery-continuation';
const CURRENT_RUNTIME_CONTINUATION_KIND = 'runtime_continuation';
const RECEIPT_SOURCE_PREFIX = 'runtime-delivery-child:';

interface ChildContinuationCandidate extends Record<string, unknown> {
  turn_intent_id: string;
  conversation_id: string;
  intent_created_at: string;
  revision_id: string;
  revision_seq: bigint;
  content_object_id: string;
  child_intent_link_id: string;
  child_execution_id: string;
  child_conversation_id: string;
  child_link_created_at: string;
  content_id: string;
  content_type: string;
  content_sha256: string;
  content_byte_length: bigint;
  content_storage_key: string;
}

interface ContentMetadata {
  id: string;
  contentType: string;
  sha256: string;
  byteLength: bigint;
  storageKey: string;
  createdAt: string;
}

interface ResolvedContinuationIdentity {
  deliveryId: string;
  childExecutionId: string;
  sourceTurnId: string;
  ids: ReturnType<typeof childRuntimeDeliveryContinuationIds>;
}

interface ParsedContinuationEnvelope {
  format: 'legacy' | 'current';
  sourceTurnId: string;
  deliveryId?: string;
}

/**
 * Converts the one exact pre-Link Child Runtime continuation representation while the migration
 * writer transaction is fenced. CAS publication precedes the SQLite references, so a failed
 * transaction can leave only harmless immutable orphans and never a dangling ContentObject row.
 */
export async function migrateChildRuntimeDeliveryIntentLinks(
  database: Database.Database,
  casRootPathInput: string
): Promise<number> {
  const casRootPath = normalizedAbsolutePath(casRootPathInput, 'Runtime CAS root');
  const candidates = database.prepare(`
    SELECT intent.id AS turn_intent_id,
           intent.conversation_id AS conversation_id,
           intent.created_at AS intent_created_at,
           revision.id AS revision_id,
           revision.revision_seq AS revision_seq,
           revision.content_object_id AS content_object_id,
           child_link.id AS child_intent_link_id,
           child_link.child_execution_id AS child_execution_id,
           child_link.created_at AS child_link_created_at,
           child.child_conversation_id AS child_conversation_id,
           content.id AS content_id,
           content.content_type AS content_type,
           content.sha256 AS content_sha256,
           content.byte_length AS content_byte_length,
           content.storage_key AS content_storage_key
      FROM child_execution_intent_link child_link
      JOIN child_execution child
        ON child.id = child_link.child_execution_id
      JOIN turn_intent intent
        ON intent.id = child_link.turn_intent_id
      JOIN turn_intent_revision revision
        ON revision.intent_id = intent.id
      JOIN content_object content
        ON content.id = revision.content_object_id
     WHERE content.content_type = @contentType
     ORDER BY intent.id, revision.revision_seq
  `).all({
    contentType: CHILD_RUNTIME_DELIVERY_CONTINUATION_CONTENT_TYPE
  }) as ChildContinuationCandidate[];

  const seenIntentIds = new Set<string>();
  let migrated = 0;
  for (const candidate of candidates) {
    const intentId = requireText(candidate.turn_intent_id, 'TurnIntent.id');
    if (seenIntentIds.has(intentId)) {
      throw new Error(`Child Runtime continuation TurnIntent ${intentId} has multiple revisions.`);
    }
    seenIntentIds.add(intentId);
    requireIntegerOne(candidate.revision_seq, 'TurnIntentRevision.revision_seq');

    const intentContent = await readVerifiedContent(casRootPath, contentMetadata(candidate, 'content'));
    const envelope = parseContinuationEnvelope(intentContent);
    const identity = resolveContinuationIdentity(database, candidate, envelope);
    assertCandidateIdentity(candidate, identity);

    const preset = requireSingleRow(database.prepare(`
      SELECT revision.id AS revision_id,
             revision.revision_seq AS revision_seq,
             revision.preset_object_id AS content_object_id,
             content.id AS content_id,
             content.content_type AS content_type,
             content.sha256 AS content_sha256,
             content.byte_length AS content_byte_length,
             content.storage_key AS content_storage_key
        FROM turn_execution_preset_revision revision
        JOIN content_object content
          ON content.id = revision.preset_object_id
       WHERE revision.intent_id = @intentId
       ORDER BY revision.revision_seq
    `).all({ intentId }) as Array<Record<string, unknown>>, `TurnExecutionPresetRevision for ${intentId}`);
    if (requireText(preset.revision_id, 'TurnExecutionPresetRevision.id') !== identity.ids.presetRevisionId) {
      throw new Error(`Child Runtime continuation ${intentId} has an unexpected preset revision identity.`);
    }
    requireIntegerOne(preset.revision_seq, 'TurnExecutionPresetRevision.revision_seq');
    const presetMetadata = contentMetadata(preset, 'content');
    if (presetMetadata.contentType !== TURN_EXECUTION_PRESET_CONTENT_TYPE) {
      throw new Error(`Child Runtime continuation ${intentId} has an unexpected preset content type.`);
    }
    const presetContent = await readVerifiedContent(casRootPath, presetMetadata);

    if (envelope.format === 'legacy') {
      assertExactJson(
        presetContent,
        { kind: LEGACY_CHILD_RUNTIME_CONTINUATION_KIND },
        `legacy Child Runtime continuation preset ${intentId}`
      );
      const createdAt = requireText(candidate.intent_created_at, 'TurnIntent.created_at');
      const currentIntent = await publishMigrationContent(
        casRootPath,
        canonicalPlainJson(runtimeContinuationTurnIntentEnvelope({
          sourceTurnId: identity.sourceTurnId
        })),
        CHILD_RUNTIME_DELIVERY_CONTINUATION_CONTENT_TYPE,
        createdAt
      );
      const currentPreset = await publishMigrationContent(
        casRootPath,
        canonicalPlainJson({ kind: CURRENT_RUNTIME_CONTINUATION_KIND }),
        TURN_EXECUTION_PRESET_CONTENT_TYPE,
        createdAt
      );
      ensureContentObject(database, currentIntent);
      ensureContentObject(database, currentPreset);
      const intentUpdate = database.prepare(`
        UPDATE turn_intent_revision
           SET content_object_id = @contentObjectId
         WHERE id = @revisionId
           AND intent_id = @intentId
           AND revision_seq = 1
           AND content_object_id = @previousContentObjectId
      `).run({
        contentObjectId: currentIntent.id,
        revisionId: identity.ids.turnIntentRevisionId,
        intentId,
        previousContentObjectId: candidate.content_object_id
      });
      if (intentUpdate.changes !== 1) {
        throw new Error(`Child Runtime continuation ${intentId} intent revision changed during migration.`);
      }
      const presetUpdate = database.prepare(`
        UPDATE turn_execution_preset_revision
           SET preset_object_id = @contentObjectId
         WHERE id = @revisionId
           AND intent_id = @intentId
           AND revision_seq = 1
           AND preset_object_id = @previousContentObjectId
      `).run({
        contentObjectId: currentPreset.id,
        revisionId: identity.ids.presetRevisionId,
        intentId,
        previousContentObjectId: preset.content_object_id
      });
      if (presetUpdate.changes !== 1) {
        throw new Error(`Child Runtime continuation ${intentId} preset revision changed during migration.`);
      }
    } else {
      assertExactJson(
        presetContent,
        { kind: CURRENT_RUNTIME_CONTINUATION_KIND },
        `Child Runtime continuation preset ${intentId}`
      );
    }

    database.prepare(`
      INSERT INTO runtime_delivery_intent_link (
        id, delivery_id, turn_intent_id, created_at
      ) VALUES (
        @id, @deliveryId, @turnIntentId, @createdAt
      )
    `).run({
      id: identity.ids.deliveryIntentLinkId,
      deliveryId: identity.deliveryId,
      turnIntentId: intentId,
      createdAt: requireText(candidate.child_link_created_at, 'ChildExecutionIntentLink.created_at')
    });
    migrated += 1;
  }
  return migrated;
}

function resolveContinuationIdentity(
  database: Database.Database,
  candidate: ChildContinuationCandidate,
  envelope: ParsedContinuationEnvelope
): ResolvedContinuationIdentity {
  const childExecutionId = requireText(candidate.child_execution_id, 'ChildExecutionIntentLink.child_execution_id');
  const conversationId = requireText(candidate.conversation_id, 'TurnIntent.conversation_id');
  const receipts = database.prepare(`
    SELECT id, source_kind, source_key, conversation_id, turn_id
      FROM command_receipt
     WHERE source_kind = 'internal'
       AND conversation_id = @conversationId
       AND turn_id = @sourceTurnId
       AND source_key LIKE @sourcePrefix
     ORDER BY id
  `).all({
    conversationId,
    sourceTurnId: envelope.sourceTurnId,
    sourcePrefix: `${RECEIPT_SOURCE_PREFIX}%`
  }) as Array<Record<string, unknown>>;
  const matches = receipts.flatMap((receipt): ResolvedContinuationIdentity[] => {
    const sourceKey = requireText(receipt.source_key, 'CommandReceipt.source_key');
    if (!sourceKey.startsWith(RECEIPT_SOURCE_PREFIX)) return [];
    const deliveryId = sourceKey.slice(RECEIPT_SOURCE_PREFIX.length);
    if (!deliveryId || (envelope.deliveryId && envelope.deliveryId !== deliveryId)) return [];
    const ids = childRuntimeDeliveryContinuationIds({
      deliveryId,
      childExecutionId,
      sourceTurnId: envelope.sourceTurnId
    });
    if (
      ids.turnIntentId !== candidate.turn_intent_id
      || ids.commandReceiptId !== receipt.id
      || ids.sourceKey !== sourceKey
    ) return [];
    return [{
      deliveryId,
      childExecutionId,
      sourceTurnId: envelope.sourceTurnId,
      ids
    }];
  });
  if (matches.length !== 1) {
    throw new Error(
      `Child Runtime continuation ${String(candidate.turn_intent_id)} must match exactly one durable command identity.`
    );
  }
  const identity = matches[0]!;
  const delivery = database.prepare(`
    SELECT id, target_conversation_id, phase
      FROM runtime_delivery
     WHERE id = @deliveryId
  `).get({ deliveryId: identity.deliveryId }) as Record<string, unknown> | undefined;
  if (
    !delivery
    || delivery.id !== identity.deliveryId
    || delivery.target_conversation_id !== conversationId
    || delivery.phase !== 'next_turn'
  ) {
    throw new Error(`Child Runtime continuation ${String(candidate.turn_intent_id)} has no matching next-turn RuntimeDelivery.`);
  }
  return identity;
}

function assertCandidateIdentity(
  candidate: ChildContinuationCandidate,
  identity: ResolvedContinuationIdentity
): void {
  if (
    candidate.turn_intent_id !== identity.ids.turnIntentId
    || candidate.revision_id !== identity.ids.turnIntentRevisionId
    || candidate.child_intent_link_id !== identity.ids.intentLinkId
    || candidate.child_execution_id !== identity.childExecutionId
    || candidate.conversation_id !== candidate.child_conversation_id
    || candidate.content_object_id !== candidate.content_id
  ) {
    throw new Error(`Child Runtime continuation ${String(candidate.turn_intent_id)} identity is not the exact supported predecessor.`);
  }
}

function parseContinuationEnvelope(bytes: Buffer): ParsedContinuationEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    const failure = new Error('Child Runtime continuation CAS envelope is not valid JSON.');
    (failure as Error & { cause?: unknown }).cause = error;
    throw failure;
  }
  const record = requireRecord(value, 'Child Runtime continuation envelope');
  if (record.kind === LEGACY_CHILD_RUNTIME_CONTINUATION_KIND) {
    assertExactKeys(record, ['deliveryId', 'kind', 'sourceTurnId']);
    const deliveryId = requireText(record.deliveryId, 'legacy continuation.deliveryId');
    const sourceTurnId = requireText(record.sourceTurnId, 'legacy continuation.sourceTurnId');
    assertExactJson(bytes, {
      kind: LEGACY_CHILD_RUNTIME_CONTINUATION_KIND,
      deliveryId,
      sourceTurnId
    }, 'legacy Child Runtime continuation envelope');
    return { format: 'legacy', deliveryId, sourceTurnId };
  }
  if (record.kind === CURRENT_RUNTIME_CONTINUATION_KIND) {
    assertExactKeys(record, ['kind', 'sourceTurnId', 'version']);
    if (record.version !== 1) throw new Error('Child Runtime continuation envelope version is unsupported.');
    const sourceTurnId = requireText(record.sourceTurnId, 'continuation.sourceTurnId');
    assertExactJson(bytes, runtimeContinuationTurnIntentEnvelope({ sourceTurnId }), 'Child Runtime continuation envelope');
    return { format: 'current', sourceTurnId };
  }
  throw new Error(`Unsupported Child Runtime continuation envelope kind: ${String(record.kind)}.`);
}

function contentMetadata(row: Record<string, unknown>, prefix: string): ContentMetadata {
  return {
    id: requireText(row[`${prefix}_id`], 'ContentObject.id'),
    contentType: requireText(row[`${prefix}_type`], 'ContentObject.content_type'),
    sha256: requireSha256(row[`${prefix}_sha256`], 'ContentObject.sha256'),
    byteLength: requireNonNegativeBigInt(row[`${prefix}_byte_length`], 'ContentObject.byte_length'),
    storageKey: requireText(row[`${prefix}_storage_key`], 'ContentObject.storage_key'),
    createdAt: typeof row.created_at === 'string' ? row.created_at : new Date(0).toISOString()
  };
}

async function readVerifiedContent(casRootPath: string, metadata: ContentMetadata): Promise<Buffer> {
  const expectedStorageKey = storageKeyForDigest(metadata.sha256);
  if (
    metadata.storageKey !== expectedStorageKey
    || metadata.id !== migrationContentObjectId(metadata.contentType, metadata.sha256, metadata.byteLength)
  ) {
    throw new Error(`ContentObject ${metadata.id} identity does not match its CAS metadata.`);
  }
  const filePath = safeCasPath(casRootPath, expectedStorageKey);
  const bytes = await fs.readFile(filePath);
  if (
    BigInt(bytes.byteLength) !== metadata.byteLength
    || createHash('sha256').update(bytes).digest('hex') !== metadata.sha256
  ) {
    throw new Error(`ContentObject ${metadata.id} CAS bytes do not match SQLite metadata.`);
  }
  return bytes;
}

async function publishMigrationContent(
  casRootPath: string,
  content: string,
  contentType: string,
  createdAt: string
): Promise<ContentMetadata> {
  const bytes = Buffer.from(content, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const storageKey = storageKeyForDigest(sha256);
  const byteLength = BigInt(bytes.byteLength);
  const metadata: ContentMetadata = {
    id: migrationContentObjectId(contentType, sha256, byteLength),
    contentType,
    sha256,
    byteLength,
    storageKey,
    createdAt
  };
  const targetPath = safeCasPath(casRootPath, storageKey);
  const digestRoot = path.join(casRootPath, 'sha256');
  const digestPrefix = path.dirname(targetPath);
  const temporaryRoot = path.join(casRootPath, 'tmp');
  await fs.mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
  await fs.mkdir(digestPrefix, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(temporaryRoot, `${process.pid}-${randomUUID()}.migration.tmp`);
  const handle = await fs.open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await fs.link(temporaryPath, targetPath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await fs.readFile(targetPath);
      if (
        existing.byteLength !== bytes.byteLength
        || createHash('sha256').update(existing).digest('hex') !== sha256
      ) throw new Error(`Existing migration CAS object ${sha256} has conflicting bytes.`);
    }
    await syncDirectoryDurably(digestPrefix);
    await syncDirectoryDurably(digestRoot);
  } finally {
    await fs.rm(temporaryPath, { force: true });
    await syncDirectoryDurably(temporaryRoot);
    await syncDirectoryDurably(casRootPath);
  }
  return metadata;
}

function ensureContentObject(database: Database.Database, metadata: ContentMetadata): void {
  database.prepare(`
    INSERT OR IGNORE INTO content_object (
      id, content_type, sha256, byte_length, storage_key, created_at
    ) VALUES (
      @id, @contentType, @sha256, @byteLength, @storageKey, @createdAt
    )
  `).run(metadata);
  const existing = database.prepare(`
    SELECT id, content_type, sha256, byte_length, storage_key
      FROM content_object
     WHERE id = @id
  `).get({ id: metadata.id }) as Record<string, unknown> | undefined;
  if (
    !existing
    || existing.id !== metadata.id
    || existing.content_type !== metadata.contentType
    || existing.sha256 !== metadata.sha256
    || existing.byte_length !== metadata.byteLength
    || existing.storage_key !== metadata.storageKey
  ) throw new Error(`ContentObject ${metadata.id} conflicts with migration content identity.`);
}

function migrationContentObjectId(contentType: string, sha256: string, byteLength: bigint): string {
  const digest = createHash('sha256')
    .update('limcode-content-object\0')
    .update(contentType)
    .update('\0')
    .update(sha256)
    .update('\0')
    .update(byteLength.toString())
    .digest('hex');
  return `content_${digest}`;
}

function assertExactJson(bytes: Buffer, value: unknown, label: string): void {
  if (bytes.toString('utf8') !== canonicalPlainJson(value, label)) {
    throw new Error(`${label} is not the exact supported canonical payload.`);
  }
}

function safeCasPath(casRootPath: string, storageKey: string): string {
  const root = path.resolve(casRootPath);
  const candidate = path.resolve(root, ...storageKey.split('/'));
  if (!candidate.startsWith(`${root}${path.sep}`)) throw new Error('CAS storage key escapes the Runtime root.');
  return candidate;
}

function requireSingleRow(rows: Array<Record<string, unknown>>, label: string): Record<string, unknown> {
  if (rows.length !== 1) throw new Error(`${label} must contain exactly one row.`);
  return rows[0]!;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error('Child Runtime continuation envelope contains unsupported fields.');
  }
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty text.`);
  return value.trim();
}

function requireSha256(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!/^[a-f0-9]{64}$/.test(text)) throw new TypeError(`${label} must be lowercase SHA-256.`);
  return text;
}

function requireNonNegativeBigInt(value: unknown, label: string): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new TypeError(`${label} must be a non-negative SQLite integer.`);
}

function requireIntegerOne(value: unknown, label: string): void {
  if (requireNonNegativeBigInt(value, label) !== 1n) throw new Error(`${label} must equal 1.`);
}

function normalizedAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) throw new TypeError(`${label} must be a normalized absolute path.`);
  return value;
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}
