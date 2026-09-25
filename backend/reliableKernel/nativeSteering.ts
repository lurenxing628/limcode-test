import { createHash } from 'node:crypto';
import type { MessageContent } from '../../shared/protocol';
import {
  NATIVE_STEERING_TRANSITIONS,
  type NativeSteeringReceipt,
  type OpenAIResponsesRequiredInput,
  type OpenAIResponsesSteeringState
} from '../../shared/openAIResponsesNative';

export type { NativeSteeringReceipt };
import type { AttachmentIngestService, PreparedMessageAttachmentAdmission } from './attachmentIngest';
import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import { ContextSequenceControlPlane } from './contextSequence';
import { estimateStoredMessageContentTokens } from './contextTokenEstimator';
import { canonicalPlainJson, normalizePlainJson, type PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

/** PendingTurnInput.input_kind for Astra native steering submissions. */
export const NATIVE_STEER_INPUT_KIND = 'native_steer';
/** MessageTurnLink.role for the visible steering user Message; never a second 'input' link. */
export const NATIVE_STEER_MESSAGE_TURN_ROLE = 'native_steer';

/** States in which the logical native request is still outstanding for this submission. */
export const NATIVE_STEERING_IN_FLIGHT_STATES: readonly OpenAIResponsesSteeringState[] = Object.freeze([
  'queued',
  'sent',
  'accepted',
  'waiting_for_input',
  'continuing'
]);

export function isNativeSteeringInFlightState(state: string): boolean {
  return (NATIVE_STEERING_IN_FLIGHT_STATES as readonly string[]).includes(state);
}

/** failed/delivery_unknown are terminal receipts: visible, never resent, never blocking. */
export function isNativeSteeringTerminalState(state: string): boolean {
  return state === 'completed' || state === 'failed' || state === 'delivery_unknown';
}

/** Broadcast payload after a durable steering commit; Main maps it onto the wire envelope. */
export interface NativeSteeringUpdate {
  conversationId: string;
  receipts: NativeSteeringReceipt[];
  commandId?: string;
  error?: string;
}

interface NativeSteerEnvelope {
  kind: 'native_steer';
  commandId: string;
  conversationId: string;
  turnId: string;
  modelRequestId: string;
  messageId: string;
  messageRevisionId: string;
  content: MessageContent;
  /** Response the steer was originally submitted against. */
  targetResponseId?: string;
  connectionGeneration?: number;
  steerId?: string;
  /** Latest response observed for this submission. */
  responseId?: string;
  /** Automatic successor response created by an accepted steer. */
  successorResponseId?: string;
  requiredInput?: OpenAIResponsesRequiredInput[];
  error?: string;
}

const MESSAGE_CONTENT_TYPE = 'application/vnd.limcode.message+json';

/**
 * Durable steering submissions on PendingTurnInput plus their visible user Messages. The user
 * Message exists from submission (undelivered states stay visible); the model-facing Context
 * occurrence is appended only at the proven continuation boundary via applyToContext.
 */
export class NativeSteeringStore {
  private readonly context: ContextSequenceControlPlane;
  private readonly now: () => string;
  private readonly attachments?: AttachmentIngestService;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    options: { now?: () => string; attachments?: AttachmentIngestService } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.attachments = options.attachments;
    this.context = new ContextSequenceControlPlane(database, contentStore, { now: this.now });
  }

  /**
   * Persists the immutable submission (PendingTurnInput state 'queued' + visible user Message) in
   * one transaction. Idempotent by commandId: a replay returns the existing receipt; only a receipt
   * still in 'queued' state may be (re)sent by the caller.
   */
  public async submit(input: {
    turnId: string;
    conversationId: string;
    modelRequestId: string;
    commandId: string;
    content: MessageContent;
    previousResponseId?: string;
    connectionGeneration?: number;
  }): Promise<NativeSteeringReceipt> {
    const turnId = requireId(input.turnId, 'turnId');
    const conversationId = requireId(input.conversationId, 'conversationId');
    const modelRequestId = requireId(input.modelRequestId, 'modelRequestId');
    const commandId = requireText(input.commandId, 'commandId');
    const ids = nativeSteerIds(turnId, commandId);
    const existing = await this.readEnvelopeRow(ids.pendingInputId);
    if (existing) {
      if (existing.envelope.commandId !== commandId || existing.envelope.turnId !== turnId) {
        throw new Error(`Native steering submission ${ids.pendingInputId} conflicts with its persisted envelope.`);
      }
      return nativeSteeringReceipt(existing.row, existing.envelope);
    }
    const turn = await this.requireExisting('Turn', turnId);
    if (turn.status !== 'active') throw new Error(`Turn ${turnId} is not active.`);
    if (requireId(turn.conversation_id, 'Turn.conversation_id') !== conversationId) {
      throw new Error('Native steering Turn belongs to another Conversation.');
    }
    const content = normalizePlainJson(input.content, 'Native steering MessageContent') as unknown as MessageContent;
    const attachmentAdmission: PreparedMessageAttachmentAdmission = this.attachments
      ? await this.attachments.prepareMessageContent({
          content: canonicalPlainJson(content as unknown as PlainJsonValue, 'Native steering MessageContent'),
          contentType: MESSAGE_CONTENT_TYPE
        })
      : {
          value: canonicalPlainJson(content as unknown as PlainJsonValue, 'Native steering MessageContent'),
          contentType: MESSAGE_CONTENT_TYPE,
          attachments: [],
          storageSteps: [],
          totalBytes: 0
        };
    const messageContent = await this.contentStore.prepare(
      this.database,
      attachmentAdmission.value,
      attachmentAdmission.contentType
    );
    const envelope: NativeSteerEnvelope = {
      kind: 'native_steer',
      commandId,
      conversationId,
      turnId,
      modelRequestId,
      messageId: ids.messageId,
      messageRevisionId: ids.messageRevisionId,
      content: JSON.parse(typeof attachmentAdmission.value === 'string'
        ? attachmentAdmission.value
        : Buffer.from(attachmentAdmission.value.buffer, attachmentAdmission.value.byteOffset, attachmentAdmission.value.byteLength).toString('utf8')) as MessageContent,
      ...(input.previousResponseId ? { targetResponseId: input.previousResponseId } : {}),
      ...(input.connectionGeneration !== undefined ? { connectionGeneration: input.connectionGeneration } : {})
    };
    const envelopeContent = await this.contentStore.prepare(
      this.database,
      canonicalPlainJson(envelope as unknown as PlainJsonValue, 'Native steering envelope'),
      'application/vnd.limcode.native-steer+json'
    );
    const now = this.now();
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: 'active' }),
        ...attachmentAdmission.storageSteps,
        ...preparedContentObjectSteps([messageContent], 'native_steer_message'),
        ...preparedContentObjectSteps([envelopeContent], 'native_steer_envelope'),
        DOMAIN_REPOSITORIES.domain('Message').insert({
          id: ids.messageId,
          created_at: now,
          updated_at: now,
          deleted_at: null
        }),
        DOMAIN_REPOSITORIES.domain('MessageRevision').insertWithNextSequence({
          id: ids.messageRevisionId,
          message_id: ids.messageId,
          role: 'user',
          content_object_id: messageContent.metadata.id,
          created_at: now
        }, {
          column: 'revision_seq',
          scope: { message_id: ids.messageId }
        }),
        DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
          id: ids.currentRevisionLinkId,
          message_id: ids.messageId,
          revision_id: ids.messageRevisionId,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insertWithNextSequence({
          id: ids.membershipId,
          conversation_id: conversationId,
          message_id: ids.messageId,
          created_at: now
        }, {
          column: 'message_seq',
          scope: { conversation_id: conversationId }
        }),
        DOMAIN_REPOSITORIES.domain('MessageTurnLink').insert({
          id: ids.turnLinkId,
          turn_id: turnId,
          message_id: ids.messageId,
          role: NATIVE_STEER_MESSAGE_TURN_ROLE,
          created_at: now
        }),
        ...(this.attachments
          ? this.attachments.linkSteps(attachmentAdmission, ids.messageRevisionId, now)
          : []),
        DOMAIN_REPOSITORIES.domain('PendingTurnInput').insertWithNextPosition({
          id: ids.pendingInputId,
          turn_id: turnId,
          input_kind: NATIVE_STEER_INPUT_KIND,
          content_object_id: envelopeContent.metadata.id,
          state: 'queued',
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
      ]);
    } catch (error) {
      const raced = await this.readEnvelopeRow(ids.pendingInputId);
      if (!raced) throw error;
      return nativeSteeringReceipt(raced.row, raced.envelope);
    }
    const committed = await this.readEnvelopeRow(ids.pendingInputId);
    if (!committed) throw new Error(`Native steering submission ${ids.pendingInputId} lost after commit.`);
    return nativeSteeringReceipt(committed.row, committed.envelope);
  }

  /**
   * Forward-only receipt transition; rewrites the immutable envelope with the new extras and flips
   * PendingTurnInput.state atomically. Same-state writes (with or without extras) are idempotent
   * replays that return the committed receipt unchanged.
   */
  public async transition(input: {
    turnId: string;
    commandId: string;
    from: readonly OpenAIResponsesSteeringState[];
    to: OpenAIResponsesSteeringState;
    extras?: {
      steerId?: string;
      responseId?: string;
      successorResponseId?: string;
      requiredInput?: OpenAIResponsesRequiredInput[];
      error?: string;
    };
  }): Promise<NativeSteeringReceipt> {
    const turnId = requireId(input.turnId, 'turnId');
    const commandId = requireText(input.commandId, 'commandId');
    const ids = nativeSteerIds(turnId, commandId);
    const existing = await this.readEnvelopeRow(ids.pendingInputId);
    if (!existing) throw new Error(`Native steering submission ${commandId} does not exist.`);
    const current = existing.row.state as OpenAIResponsesSteeringState;
    if (current === input.to) {
      // Two observers may report the same outcome (for example a transport-queued steer.failed
      // event and the rejected send promise). The first durable write owns the receipt; a repeated
      // transition to the state it already holds is a replay, never a drift or a second write.
      return nativeSteeringReceipt(existing.row, existing.envelope);
    }
    if (!input.from.includes(current) || !NATIVE_STEERING_TRANSITIONS[current]?.includes(input.to)) {
      throw new Error(`Native steering receipt ${commandId} cannot transition ${current} → ${input.to}.`);
    }
    const nextEnvelope: NativeSteerEnvelope = {
      ...existing.envelope,
      ...(input.extras?.steerId ? { steerId: input.extras.steerId } : {}),
      ...(input.extras?.responseId ? { responseId: input.extras.responseId } : {}),
      ...(input.extras?.requiredInput ? { requiredInput: input.extras.requiredInput } : {}),
      ...(input.extras?.error !== undefined
        ? { error: input.extras.error }
        : input.to === 'failed'
          ? { error: 'Native steering failed.' }
          : {})
    };
    const envelopeContent = await this.contentStore.prepare(
      this.database,
      canonicalPlainJson(nextEnvelope as unknown as PlainJsonValue, 'Native steering envelope'),
      'application/vnd.limcode.native-steer+json'
    );
    const now = this.now();
    await this.database.transaction([
      DOMAIN_REPOSITORIES.domain('PendingTurnInput').assert(ids.pendingInputId, {
        turn_id: turnId,
        input_kind: NATIVE_STEER_INPUT_KIND,
        state: current
      }),
      ...preparedContentObjectSteps([envelopeContent], 'native_steer_envelope'),
      DOMAIN_REPOSITORIES.domain('PendingTurnInput').update(ids.pendingInputId, {
        state: input.to,
        content_object_id: envelopeContent.metadata.id,
        updated_at: now
      })
    ]);
    return nativeSteeringReceipt(
      { ...existing.row, state: input.to, updated_at: now },
      nextEnvelope
    );
  }

  /**
   * Proven continuation boundary: the steering user Message enters model-facing Context exactly
   * once, atomically with the 'continuing' transition. A failed/delivery_unknown receipt never
   * enters Context; its Message stays visible as undelivered.
   */
  public async applyToContext(input: {
    turnId: string;
    commandId: string;
    responseId?: string;
  }): Promise<NativeSteeringReceipt> {
    const turnId = requireId(input.turnId, 'turnId');
    const commandId = requireText(input.commandId, 'commandId');
    const ids = nativeSteerIds(turnId, commandId);
    const existing = await this.readEnvelopeRow(ids.pendingInputId);
    if (!existing) throw new Error(`Native steering submission ${commandId} does not exist.`);
    const current = existing.row.state as OpenAIResponsesSteeringState;
    const conversationId = existing.envelope.conversationId;
    const revisionId = existing.envelope.messageRevisionId;
    const sources = await this.list('ContextSegmentSource', {
      source_kind: 'message_revision',
      source_id: revisionId
    }, 2);
    if (sources.length > 1) {
      throw new Error(`Native steering Message ${existing.envelope.messageId} has multiple Context occurrences.`);
    }
    if (sources.length === 1) {
      // Occurrence already committed by an earlier replay; only the receipt state may lag.
      if (current === 'continuing' || current === 'completed') {
        return nativeSteeringReceipt(existing.row, existing.envelope);
      }
      return this.transition({ turnId, commandId, from: ['accepted', 'waiting_for_input'], to: 'continuing' });
    }
    if (current !== 'accepted' && current !== 'waiting_for_input' && current !== 'continuing') {
      throw new Error(`Native steering receipt ${commandId} cannot enter Context from state ${current}.`);
    }
    const revision = await this.requireExisting('MessageRevision', revisionId);
    const metadata = await this.requireExisting(
      'ContentObject',
      requireId(revision.content_object_id, 'Native steering MessageRevision.content_object_id')
    ) as unknown as ContentObjectMetadata;
    const content = await this.contentStore.read(metadata);
    const nextEnvelope: NativeSteerEnvelope = {
      ...existing.envelope,
      ...(input.responseId
        ? { responseId: input.responseId, successorResponseId: input.responseId }
        : {})
    };
    const envelopeContent = await this.contentStore.prepare(
      this.database,
      canonicalPlainJson(nextEnvelope as unknown as PlainJsonValue, 'Native steering envelope'),
      'application/vnd.limcode.native-steer+json'
    );
    // Application changes the Context relationship, not the immutable user message revision.
    const context = await this.context.prepareMessageAppendMutation({
      conversationId,
      messageRevisionId: revisionId,
      existingRevisionSeq: BigInt(String(revision.revision_seq)),
      contentObjectId: metadata.id,
      contentByteLength: metadata.byte_length,
      contentEstimatedTokens: estimateStoredMessageContentTokens(content, metadata.content_type)
    });
    const now = this.now();
    await this.database.transaction([
      DOMAIN_REPOSITORIES.domain('PendingTurnInput').assert(ids.pendingInputId, {
        turn_id: turnId,
        input_kind: NATIVE_STEER_INPUT_KIND,
        state: current
      }),
      ...preparedContentObjectSteps([envelopeContent], 'native_steer_envelope'),
      ...context.steps,
      DOMAIN_REPOSITORIES.domain('PendingTurnInput').update(ids.pendingInputId, {
        state: 'continuing',
        content_object_id: envelopeContent.metadata.id,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
    ]);
    return nativeSteeringReceipt(
      { ...existing.row, state: 'continuing', updated_at: now },
      nextEnvelope
    );
  }

  public async receiptsForTurn(turnIdInput: string): Promise<NativeSteeringReceipt[]> {
    const turnId = requireId(turnIdInput, 'turnId');
    const rows = await listAllDomainRows(this.database, 'PendingTurnInput', {
      turn_id: turnId,
      input_kind: NATIVE_STEER_INPUT_KIND
    });
    const receipts: NativeSteeringReceipt[] = [];
    for (const row of rows.sort((left, right) =>
      String(left.created_at).localeCompare(String(right.created_at))
      || String(left.id).localeCompare(String(right.id))
    )) {
      receipts.push(nativeSteeringReceipt(row, await this.readEnvelope(row)));
    }
    return receipts;
  }

  public async receiptsForConversation(conversationIdInput: string): Promise<NativeSteeringReceipt[]> {
    const conversationId = requireId(conversationIdInput, 'conversationId');
    const turns = (await listAllDomainRows(this.database, 'Turn', { conversation_id: conversationId }))
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
    const receipts: NativeSteeringReceipt[] = [];
    for (const turn of turns) {
      // Each Turn's receipts are already oldest-first; Turn order preserves conversation chronology.
      receipts.push(...await this.receiptsForTurn(requireId(turn.id, 'Turn.id')));
    }
    return receipts;
  }

  private async readEnvelope(row: DomainRow): Promise<NativeSteerEnvelope> {
    const metadata = await this.requireExisting(
      'ContentObject',
      requireId(row.content_object_id, 'PendingTurnInput.content_object_id')
    ) as unknown as ContentObjectMetadata;
    const value = normalizePlainJson(
      JSON.parse((await this.contentStore.read(metadata)).toString('utf8')),
      'Native steering envelope'
    );
    return parseNativeSteerEnvelope(value);
  }

  private async readEnvelopeRow(pendingInputId: string): Promise<{ row: DomainRow; envelope: NativeSteerEnvelope } | null> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('PendingTurnInput').get(pendingInputId)
    ]);
    const row = snapshot.snapshot[0] as DomainRow | null;
    if (!row || row.input_kind !== NATIVE_STEER_INPUT_KIND) return null;
    return { row, envelope: await this.readEnvelope(row) };
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0] as DomainRow | null;
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })]);
    const rows = snapshot.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} list did not return rows.`);
    return rows;
  }
}

export interface NativeSteeringInFlightEntry {
  pendingInputId: string;
  turnId: string;
  state: OpenAIResponsesSteeringState;
  updatedAt: string;
}

/**
 * In-flight steering reader for the compaction/switch guards. Historical terminal receipts
 * (failed/delivery_unknown/completed) never block; only a live logical request does.
 */
export async function readNativeSteeringInFlight(
  database: RuntimeDatabase,
  conversationIdInput: string
): Promise<NativeSteeringInFlightEntry[]> {
  const conversationId = requireId(conversationIdInput, 'conversationId');
  const turns = await listAllDomainRows(database, 'Turn', { conversation_id: conversationId });
  const entries: NativeSteeringInFlightEntry[] = [];
  for (const turn of turns) {
    const rows = await listAllDomainRows(database, 'PendingTurnInput', {
      turn_id: requireId(turn.id, 'Turn.id'),
      input_kind: NATIVE_STEER_INPUT_KIND
    });
    for (const row of rows) {
      const state = String(row.state) as OpenAIResponsesSteeringState;
      if (!isNativeSteeringInFlightState(state)) continue;
      entries.push({
        pendingInputId: requireId(row.id, 'PendingTurnInput.id'),
        turnId: requireId(row.turn_id, 'PendingTurnInput.turn_id'),
        state,
        updatedAt: String(row.updated_at)
      });
    }
  }
  return entries;
}

function nativeSteeringReceipt(row: DomainRow, envelope: NativeSteerEnvelope): NativeSteeringReceipt {
  const updatedAtMs = Date.parse(String(row.updated_at));
  return {
    submissionId: envelope.commandId,
    conversationId: envelope.conversationId,
    turnId: envelope.turnId,
    modelRequestId: envelope.modelRequestId,
    state: String(row.state) as OpenAIResponsesSteeringState,
    ...(envelope.responseId ? { responseId: envelope.responseId } : {}),
    ...(envelope.targetResponseId ? { targetResponseId: envelope.targetResponseId } : {}),
    ...(envelope.successorResponseId ? { successorResponseId: envelope.successorResponseId } : {}),
    ...(envelope.steerId ? { steerId: envelope.steerId } : {}),
    messageId: envelope.messageId,
    ...(envelope.error !== undefined ? { message: envelope.error } : {}),
    updatedAt: Number.isNaN(updatedAtMs) ? 0 : updatedAtMs
  };
}

function parseNativeSteerEnvelope(value: PlainJsonValue): NativeSteerEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Native steering envelope must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== 'native_steer') throw new TypeError('PendingTurnInput envelope is not a native steer.');
  return {
    kind: 'native_steer',
    commandId: requireText(record.commandId, 'Native steering envelope.commandId'),
    conversationId: requireId(record.conversationId, 'Native steering envelope.conversationId'),
    turnId: requireId(record.turnId, 'Native steering envelope.turnId'),
    modelRequestId: requireId(record.modelRequestId, 'Native steering envelope.modelRequestId'),
    messageId: requireId(record.messageId, 'Native steering envelope.messageId'),
    messageRevisionId: requireId(record.messageRevisionId, 'Native steering envelope.messageRevisionId'),
    content: record.content as MessageContent,
    ...(typeof record.targetResponseId === 'string' ? { targetResponseId: record.targetResponseId } : {}),
    ...(typeof record.connectionGeneration === 'number' ? { connectionGeneration: record.connectionGeneration } : {}),
    ...(typeof record.steerId === 'string' ? { steerId: record.steerId } : {}),
    ...(typeof record.responseId === 'string' ? { responseId: record.responseId } : {}),
    ...(typeof record.successorResponseId === 'string' ? { successorResponseId: record.successorResponseId } : {}),
    ...(Array.isArray(record.requiredInput)
      ? { requiredInput: record.requiredInput as OpenAIResponsesRequiredInput[] }
      : {}),
    ...(typeof record.error === 'string' ? { error: record.error } : {})
  };
}


function nativeSteerIds(turnId: string, commandId: string) {
  const id = (kind: string): string => `rk_${kind}_${createHash('sha256')
    .update(JSON.stringify([turnId, commandId, kind]))
    .digest('hex')
    .slice(0, 32)}`;
  return {
    pendingInputId: id('native_steer_input'),
    messageId: id('native_steer_message'),
    messageRevisionId: id('native_steer_message_revision'),
    currentRevisionLinkId: id('native_steer_message_current_revision'),
    membershipId: id('native_steer_message_membership'),
    turnLinkId: id('native_steer_message_turn_link')
  };
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty id.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}
