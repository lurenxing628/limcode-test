import type {
  ContentAddressedStore,
  ContentObjectMetadata
} from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import {
  initialGuidancePosition,
  inputTurnIntentEnvelope,
  parseInputTurnIntentEnvelope,
  reorderedGuidancePosition,
  TURN_INTENT_ENVELOPE_CONTENT_TYPE
} from './guidanceIntent';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import type { RuntimeDatabase } from './runtimeDatabase';
import {
  allocatedValue,
  assertReceiptIdentity,
  commandEntityId,
  isTransactionAssertionError,
  normalizeInitiatingSource,
  requireBigInt,
  requireDecimalIntegerString,
  requireId,
  requireText,
  requireTimestamp,
  sourceOperationMismatch,
  TURN_INTENT_STATE_CANCELLED,
  TURN_INTENT_STATE_QUEUED,
  type CommandCommit,
  type TurnCommandCommitOptions
} from './turnCommandWire';
import type {
  TurnCommandResult,
  TurnCommandSource,
  TurnGuidanceCancelCommand,
  TurnGuidanceEditCommand,
  TurnGuidanceHoldCommand,
  TurnGuidanceReorderCommand
} from './turnControlPlane';

/** A queue control raced admission or another control and must be retried from the refreshed Feed. */
export class GuidanceControlConflictError extends Error {
  public readonly code = 'GUIDANCE_CONTROL_CONFLICT';

  public constructor(
    public readonly conversationId: string,
    public readonly intentId?: string
  ) {
    super(intentId
      ? `引导消息 ${intentId} 已发生变化，请刷新后重试。`
      : `引导消息队列已发生变化，请刷新后重试。`);
    this.name = 'GuidanceControlConflictError';
  }
}

export function isGuidanceControlConflictError(error: unknown): error is GuidanceControlConflictError {
  return (error as { code?: unknown })?.code === 'GUIDANCE_CONTROL_CONFLICT';
}

export interface CurrentGuidanceIntent {
  intent: DomainRow;
  revisions: DomainRow[];
  currentRevision: DomainRow;
  currentRevisionSeq: string;
  messageContent: ContentObjectMetadata;
  position: string;
  hold: 'none' | 'paused';
}

export interface TurnGuidanceQueueOperationsDeps {
  database: RuntimeDatabase;
  contentStore: ContentAddressedStore;
  now: () => string;
  findReceipt: (source: TurnCommandSource) => Promise<DomainRow | undefined>;
  commitWithReceipt: (options: TurnCommandCommitOptions) => Promise<CommandCommit>;
  requireExisting: (domain: string, id: string) => Promise<DomainRow>;
  listRows: (domain: string, where: DomainRow, limit: number) => Promise<DomainRow[]>;
  readContentObject: (id: string) => Promise<ContentObjectMetadata>;
}

/**
 * Ordinary queued guidance controls: text revision, cancel, hold and reorder. Every mutation
 * fences the exact TurnIntentRevision set it read inside the same writer transaction, so a raced
 * admission or queue edit rolls back as GuidanceControlConflictError instead of writing stale
 * content. Receipt identity and stable command-entity ids stay on the shared turn command wire.
 */
export class TurnGuidanceQueueOperations {
  public constructor(private readonly deps: TurnGuidanceQueueOperationsDeps) {}

  public async reviseGuidanceText(command: TurnGuidanceEditCommand): Promise<TurnCommandResult> {
    const source = normalizeInitiatingSource(command.source, 'guidance');
    const conversationId = requireId(command.conversationId, 'conversationId');
    const intentId = requireId(command.intentId, 'intentId');
    const expectedRevisionSeq = requireDecimalIntegerString(command.expectedRevisionSeq, 'expectedRevisionSeq');
    const text = typeof command.text === 'string' ? command.text.trim() : '';
    const commandScope = JSON.stringify(['edit', conversationId, intentId, expectedRevisionSeq, text]);
    const receiptId = commandEntityId(source, 'guidance', 'command_receipt', commandScope);
    const duplicate = await this.deps.findReceipt(source);
    if (duplicate) return guidanceDuplicateResult(duplicate, receiptId, conversationId, intentId);

    const current = await this.currentGuidanceIntent(conversationId, intentId);
    this.requireExpectedGuidanceRevision(current, expectedRevisionSeq);
    const messageBytes = await this.deps.contentStore.read(current.messageContent);
    const editedMessage = await this.deps.contentStore.prepare(
      this.deps.database,
      editGuidanceMessageContent(messageBytes, current.messageContent.content_type, text),
      current.messageContent.content_type
    );
    const now = this.timestamp();
    const envelopeContent = await this.deps.contentStore.prepare(
      this.deps.database,
      JSON.stringify(inputTurnIntentEnvelope({
        messageContentObjectId: editedMessage.metadata.id,
        position: current.position,
        hold: current.hold
      })),
      TURN_INTENT_ENVELOPE_CONTENT_TYPE
    );
    const revisionId = commandEntityId(source, 'guidance', 'turn_intent_revision', commandScope);
    try {
      const commit = await this.deps.commitWithReceipt({
        source,
        receiptId,
        conversationId,
        turnId: null,
        steps: [
          ...preparedContentObjectSteps([editedMessage, envelopeContent], 'guidance_edit_content'),
          ...this.guidanceRevisionFenceSteps(current),
          DOMAIN_REPOSITORIES.domain('TurnIntentRevision').insertWithNextSequence({
            id: revisionId,
            intent_id: intentId,
            content_object_id: envelopeContent.metadata.id,
            created_at: now
          }, { column: 'revision_seq', scope: { intent_id: intentId } }),
          DOMAIN_REPOSITORIES.domain('TurnIntent').update(intentId, { updated_at: now }),
          DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
        ]
      });
      if (commit.deduplicated) return guidanceDuplicateResult(commit.receipt, receiptId, conversationId, intentId);
      return {
        receiptId,
        deduplicated: false,
        commitSeq: commit.commitSeq,
        conversationId,
        intentId,
        intentRevisionSeq: allocatedValue(commit, 'TurnIntentRevision', revisionId, 'revision_seq')
      };
    } catch (error) {
      if (isTransactionAssertionError(error)) throw new GuidanceControlConflictError(conversationId, intentId);
      throw error;
    }
  }

  public async cancelQueuedGuidance(command: TurnGuidanceCancelCommand): Promise<TurnCommandResult> {
    const source = normalizeInitiatingSource(command.source, 'guidance');
    const conversationId = requireId(command.conversationId, 'conversationId');
    const intentId = requireId(command.intentId, 'intentId');
    const expectedRevisionSeq = requireDecimalIntegerString(command.expectedRevisionSeq, 'expectedRevisionSeq');
    const commandScope = JSON.stringify(['cancel', conversationId, intentId, expectedRevisionSeq]);
    const receiptId = commandEntityId(source, 'guidance', 'command_receipt', commandScope);
    const duplicate = await this.deps.findReceipt(source);
    if (duplicate) return guidanceDuplicateResult(duplicate, receiptId, conversationId, intentId);
    const current = await this.currentGuidanceIntent(conversationId, intentId);
    this.requireExpectedGuidanceRevision(current, expectedRevisionSeq);
    const now = this.timestamp();
    try {
      const commit = await this.deps.commitWithReceipt({
        source,
        receiptId,
        conversationId,
        turnId: null,
        steps: [
          ...this.guidanceRevisionFenceSteps(current),
          DOMAIN_REPOSITORIES.domain('TurnIntent').update(intentId, {
            state: TURN_INTENT_STATE_CANCELLED,
            updated_at: now
          }),
          DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
        ]
      });
      if (commit.deduplicated) return guidanceDuplicateResult(commit.receipt, receiptId, conversationId, intentId);
      return {
        receiptId,
        deduplicated: false,
        commitSeq: commit.commitSeq,
        conversationId,
        intentId
      };
    } catch (error) {
      if (isTransactionAssertionError(error)) throw new GuidanceControlConflictError(conversationId, intentId);
      throw error;
    }
  }

  /**
   * Cancels a queued TurnIntent that is not an ordinary guidance message (a continuation, a runtime
   * continuation, a retry), as a data-root relocation settles the work it carried away. A child continuation
   * stays with its lineage: only the subtree interruption cancels it. Same fence and receipt as
   * cancelQueuedGuidance; the intent never starts a Turn afterwards.
   */
  public async cancelQueuedIntent(command: TurnGuidanceCancelCommand): Promise<TurnCommandResult> {
    const source = normalizeInitiatingSource(command.source, 'guidance');
    const conversationId = requireId(command.conversationId, 'conversationId');
    const intentId = requireId(command.intentId, 'intentId');
    const expectedRevisionSeq = requireDecimalIntegerString(command.expectedRevisionSeq, 'expectedRevisionSeq');
    const commandScope = JSON.stringify(['cancel-intent', conversationId, intentId, expectedRevisionSeq]);
    const receiptId = commandEntityId(source, 'guidance', 'command_receipt', commandScope);
    const duplicate = await this.deps.findReceipt(source);
    if (duplicate) return guidanceDuplicateResult(duplicate, receiptId, conversationId, intentId);
    const intent = await this.deps.requireExisting('TurnIntent', intentId);
    if (intent.conversation_id !== conversationId || intent.state !== TURN_INTENT_STATE_QUEUED || intent.turn_id !== null) {
      throw new GuidanceControlConflictError(conversationId, intentId);
    }
    if ((await this.deps.listRows('ChildExecutionIntentLink', { turn_intent_id: intentId }, 1)).length > 0) {
      throw new Error(`TurnIntent ${intentId} continues a child Agent: its lineage interruption cancels it.`);
    }
    const revisions = await listAllDomainRows(this.deps.database, 'TurnIntentRevision', { intent_id: intentId });
    const currentRevisionSeq = revisions.reduce((maximum, revision) => {
      const seq = requireBigInt(revision.revision_seq, 'TurnIntentRevision.revision_seq');
      return seq > maximum ? seq : maximum;
    }, 0n).toString();
    if (currentRevisionSeq !== expectedRevisionSeq) throw new GuidanceControlConflictError(conversationId, intentId);
    const now = this.timestamp();
    try {
      const commit = await this.deps.commitWithReceipt({
        source,
        receiptId,
        conversationId,
        turnId: null,
        steps: [
          DOMAIN_REPOSITORIES.domain('TurnIntent').assert(intentId, {
            conversation_id: conversationId,
            state: TURN_INTENT_STATE_QUEUED,
            turn_id: null
          }),
          DOMAIN_REPOSITORIES.domain('TurnIntentRevision').assertExactIds(
            { intent_id: intentId },
            revisions.map((revision) => requireId(revision.id, 'TurnIntentRevision.id'))
          ),
          DOMAIN_REPOSITORIES.domain('TurnIntent').update(intentId, {
            state: TURN_INTENT_STATE_CANCELLED,
            updated_at: now
          }),
          DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
        ]
      });
      if (commit.deduplicated) return guidanceDuplicateResult(commit.receipt, receiptId, conversationId, intentId);
      return { receiptId, deduplicated: false, commitSeq: commit.commitSeq, conversationId, intentId };
    } catch (error) {
      if (isTransactionAssertionError(error)) throw new GuidanceControlConflictError(conversationId, intentId);
      throw error;
    }
  }

  public async reviseGuidanceHold(command: TurnGuidanceHoldCommand): Promise<TurnCommandResult> {
    const source = normalizeInitiatingSource(command.source, 'guidance');
    const conversationId = requireId(command.conversationId, 'conversationId');
    const intentId = requireId(command.intentId, 'intentId');
    const expectedRevisionSeq = requireDecimalIntegerString(command.expectedRevisionSeq, 'expectedRevisionSeq');
    const hold = command.hold === 'none' || command.hold === 'paused'
      ? command.hold
      : (() => { throw new TypeError('Guidance hold must be none or paused.'); })();
    const commandScope = JSON.stringify(['hold', conversationId, intentId, expectedRevisionSeq, hold]);
    const receiptId = commandEntityId(source, 'guidance', 'command_receipt', commandScope);
    const duplicate = await this.deps.findReceipt(source);
    if (duplicate) return guidanceDuplicateResult(duplicate, receiptId, conversationId, intentId);
    const current = await this.currentGuidanceIntent(conversationId, intentId);
    this.requireExpectedGuidanceRevision(current, expectedRevisionSeq);
    const now = this.timestamp();
    const envelopeContent = await this.deps.contentStore.prepare(
      this.deps.database,
      JSON.stringify(inputTurnIntentEnvelope({
        messageContentObjectId: current.messageContent.id,
        position: current.position,
        hold
      })),
      TURN_INTENT_ENVELOPE_CONTENT_TYPE
    );
    const revisionId = commandEntityId(source, 'guidance', 'turn_intent_revision', commandScope);
    try {
      const commit = await this.deps.commitWithReceipt({
        source,
        receiptId,
        conversationId,
        turnId: null,
        steps: [
          ...preparedContentObjectSteps([envelopeContent], 'guidance_hold_content'),
          ...this.guidanceRevisionFenceSteps(current),
          DOMAIN_REPOSITORIES.domain('TurnIntentRevision').insertWithNextSequence({
            id: revisionId,
            intent_id: intentId,
            content_object_id: envelopeContent.metadata.id,
            created_at: now
          }, { column: 'revision_seq', scope: { intent_id: intentId } }),
          DOMAIN_REPOSITORIES.domain('TurnIntent').update(intentId, { updated_at: now }),
          DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
        ]
      });
      if (commit.deduplicated) return guidanceDuplicateResult(commit.receipt, receiptId, conversationId, intentId);
      return {
        receiptId,
        deduplicated: false,
        commitSeq: commit.commitSeq,
        conversationId,
        intentId,
        intentRevisionSeq: allocatedValue(commit, 'TurnIntentRevision', revisionId, 'revision_seq')
      };
    } catch (error) {
      if (isTransactionAssertionError(error)) throw new GuidanceControlConflictError(conversationId, intentId);
      throw error;
    }
  }

  public async reorderQueuedGuidance(command: TurnGuidanceReorderCommand): Promise<TurnCommandResult> {
    const source = normalizeInitiatingSource(command.source, 'guidance');
    const conversationId = requireId(command.conversationId, 'conversationId');
    if (!Array.isArray(command.items) || command.items.length === 0) {
      throw new TypeError('Guidance reorder requires at least one item.');
    }
    const items = command.items.map((item) => ({
      intentId: requireId(item.intentId, 'items.intentId'),
      expectedRevisionSeq: requireDecimalIntegerString(item.expectedRevisionSeq, 'items.expectedRevisionSeq')
    }));
    if (new Set(items.map((item) => item.intentId)).size !== items.length) {
      throw new TypeError('Guidance reorder contains duplicate intents.');
    }
    const commandScope = JSON.stringify(['reorder', conversationId, items]);
    const receiptId = commandEntityId(source, 'guidance', 'command_receipt', commandScope);
    const duplicate = await this.deps.findReceipt(source);
    if (duplicate) return guidanceDuplicateResult(duplicate, receiptId, conversationId);

    const [queuedIntents, pendingChildLinks] = await Promise.all([
      listAllDomainRows(this.deps.database, 'TurnIntent', {
        conversation_id: conversationId,
        state: TURN_INTENT_STATE_QUEUED,
        turn_id: null
      }),
      listAllDomainRows(this.deps.database, 'ChildExecutionIntentLink', { state: 'pending' })
    ]);
    const childIds = new Set(pendingChildLinks.map((link) => requireId(
      link.turn_intent_id,
      'ChildExecutionIntentLink.turn_intent_id'
    )));
    const currentItems: CurrentGuidanceIntent[] = [];
    for (const intent of queuedIntents) {
      const intentId = requireId(intent.id, 'TurnIntent.id');
      if (childIds.has(intentId)) continue;
      const current = await this.maybeCurrentGuidanceIntent(conversationId, intentId);
      if (current) currentItems.push(current);
    }
    const currentIds = new Set(currentItems.map((current) => requireId(current.intent.id, 'TurnIntent.id')));
    if (items.length !== currentIds.size || items.some((item) => !currentIds.has(item.intentId))) {
      throw new GuidanceControlConflictError(conversationId);
    }
    const byId = new Map(currentItems.map((current) => [requireId(current.intent.id, 'TurnIntent.id'), current]));
    for (const item of items) this.requireExpectedGuidanceRevision(byId.get(item.intentId)!, item.expectedRevisionSeq);

    const now = this.timestamp();
    const prepared = await Promise.all(items.map(async (item, index) => {
      const current = byId.get(item.intentId)!;
      const envelopeContent = await this.deps.contentStore.prepare(
        this.deps.database,
        JSON.stringify(inputTurnIntentEnvelope({
          messageContentObjectId: current.messageContent.id,
          position: reorderedGuidancePosition(index),
          hold: current.hold
        })),
        TURN_INTENT_ENVELOPE_CONTENT_TYPE
      );
      return {
        current,
        envelopeContent,
        revisionId: commandEntityId(source, 'guidance', 'turn_intent_revision', `${commandScope}:${item.intentId}`)
      };
    }));
    try {
      const commit = await this.deps.commitWithReceipt({
        source,
        receiptId,
        conversationId,
        turnId: null,
        steps: [
          ...preparedContentObjectSteps(prepared.map((entry) => entry.envelopeContent), 'guidance_reorder_content'),
          DOMAIN_REPOSITORIES.domain('TurnIntent').assertExactIds(
            { conversation_id: conversationId, state: TURN_INTENT_STATE_QUEUED, turn_id: null },
            queuedIntents.map((intent) => requireId(intent.id, 'TurnIntent.id'))
          ),
          ...prepared.flatMap((entry) => [
            ...this.guidanceRevisionFenceSteps(entry.current),
            DOMAIN_REPOSITORIES.domain('TurnIntentRevision').insertWithNextSequence({
              id: entry.revisionId,
              intent_id: requireId(entry.current.intent.id, 'TurnIntent.id'),
              content_object_id: entry.envelopeContent.metadata.id,
              created_at: now
            }, {
              column: 'revision_seq',
              scope: { intent_id: requireId(entry.current.intent.id, 'TurnIntent.id') }
            }),
            DOMAIN_REPOSITORIES.domain('TurnIntent').update(
              requireId(entry.current.intent.id, 'TurnIntent.id'),
              { updated_at: now }
            )
          ]),
          DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
        ]
      });
      if (commit.deduplicated) return guidanceDuplicateResult(commit.receipt, receiptId, conversationId);
      return {
        receiptId,
        deduplicated: false,
        commitSeq: commit.commitSeq,
        conversationId
      };
    } catch (error) {
      if (isTransactionAssertionError(error)) throw new GuidanceControlConflictError(conversationId);
      throw error;
    }
  }

  public async maybeCurrentGuidanceIntent(
    conversationId: string,
    intentId: string
  ): Promise<CurrentGuidanceIntent | null> {
    const intent = await this.deps.requireExisting('TurnIntent', intentId);
    if (
      intent.conversation_id !== conversationId
      || intent.state !== TURN_INTENT_STATE_QUEUED
      || intent.turn_id !== null
    ) return null;
    const childLinks = await this.deps.listRows('ChildExecutionIntentLink', { turn_intent_id: intentId }, 1);
    if (childLinks.length > 0) return null;
    const revisions = await listAllDomainRows(this.deps.database, 'TurnIntentRevision', { intent_id: intentId });
    if (revisions.length === 0) throw new Error(`TurnIntent ${intentId} has no content revision.`);
    const currentRevision = [...revisions].sort((left, right) => {
      const leftSeq = requireBigInt(left.revision_seq, 'TurnIntentRevision.revision_seq');
      const rightSeq = requireBigInt(right.revision_seq, 'TurnIntentRevision.revision_seq');
      return leftSeq < rightSeq ? 1 : leftSeq > rightSeq ? -1 : 0;
    })[0]!;
    const intentContent = await this.deps.readContentObject(
      requireId(currentRevision.content_object_id, 'TurnIntentRevision.content_object_id')
    );
    let messageContent = intentContent;
    let position = initialGuidancePosition(requireTimestamp(intent.created_at, 'TurnIntent.created_at'));
    let hold: 'none' | 'paused' = 'none';
    if (intentContent.content_type === TURN_INTENT_ENVELOPE_CONTENT_TYPE) {
      const value = JSON.parse((await this.deps.contentStore.read(intentContent)).toString('utf8')) as unknown;
      const envelope = parseInputTurnIntentEnvelope(value);
      if (!envelope) return null;
      messageContent = await this.deps.readContentObject(envelope.messageContentObjectId);
      position = envelope.guidance.position;
      hold = envelope.guidance.hold;
    }
    return {
      intent,
      revisions,
      currentRevision,
      currentRevisionSeq: requireBigInt(
        currentRevision.revision_seq,
        'TurnIntentRevision.revision_seq'
      ).toString(),
      messageContent,
      position,
      hold
    };
  }

  private async currentGuidanceIntent(conversationId: string, intentId: string): Promise<CurrentGuidanceIntent> {
    const current = await this.maybeCurrentGuidanceIntent(conversationId, intentId);
    if (!current) throw new Error(`TurnIntent ${intentId} is not an ordinary queued guidance message.`);
    return current;
  }

  private requireExpectedGuidanceRevision(current: CurrentGuidanceIntent, expectedRevisionSeq: string): void {
    if (current.currentRevisionSeq !== expectedRevisionSeq) {
      throw new GuidanceControlConflictError(
        requireId(current.intent.conversation_id, 'TurnIntent.conversation_id'),
        requireId(current.intent.id, 'TurnIntent.id')
      );
    }
  }

  private guidanceRevisionFenceSteps(current: CurrentGuidanceIntent): RepositoryTransactionStep[] {
    const intentId = requireId(current.intent.id, 'TurnIntent.id');
    return [
      DOMAIN_REPOSITORIES.domain('TurnIntent').assert(intentId, {
        conversation_id: requireId(current.intent.conversation_id, 'TurnIntent.conversation_id'),
        state: TURN_INTENT_STATE_QUEUED,
        turn_id: null
      }),
      DOMAIN_REPOSITORIES.domain('TurnIntentRevision').assertExactIds(
        { intent_id: intentId },
        current.revisions.map((revision) => requireId(revision.id, 'TurnIntentRevision.id'))
      )
    ];
  }

  private timestamp(): string {
    return requireText(this.deps.now(), 'clock result');
  }
}

function guidanceDuplicateResult(
  receipt: DomainRow,
  expectedReceiptId: string,
  conversationId: string,
  intentId?: string
): TurnCommandResult {
  assertReceiptIdentity(receipt, expectedReceiptId, 'guidance');
  if (receipt.conversation_id !== conversationId || receipt.turn_id !== null) {
    throw sourceOperationMismatch(receipt, 'guidance');
  }
  return {
    receiptId: requireId(receipt.id, 'CommandReceipt.id'),
    deduplicated: true,
    conversationId,
    ...(intentId ? { intentId } : {})
  };
}

function editGuidanceMessageContent(
  bytes: Uint8Array,
  contentType: string,
  text: string
): string {
  if (contentType !== 'application/vnd.limcode.message+json') {
    if (!text) throw new TypeError('没有附件的引导消息不能为空。');
    return text;
  }
  const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as { role?: unknown; parts?: unknown };
  if (!Array.isArray(parsed.parts)) throw new TypeError('引导消息内容格式无效。');
  let replaced = false;
  const parts: Record<string, unknown>[] = [];
  for (const value of parsed.parts) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('引导消息包含无效内容片段。');
    }
    const part = value as Record<string, unknown>;
    if (typeof part.text === 'string' && part.thought !== true) {
      if (!replaced && text) {
        parts.push({ ...part, text });
        replaced = true;
      }
      continue;
    }
    parts.push(part);
  }
  if (!replaced && text) parts.unshift({ text });
  if (parts.length === 0) throw new TypeError('没有附件的引导消息不能为空。');
  return JSON.stringify({ role: 'user', parts });
}
