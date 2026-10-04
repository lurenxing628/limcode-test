import { createHash } from 'node:crypto';
import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import { ContextSequenceControlPlane } from './contextSequence';
import { canonicalPlainJson, normalizePlainJson, type PlainJsonValue } from './plainJson';
import { listAllDomainRows } from './repositoryPagination';
import {
  estimateStoredMessageContentTokens,
  providerPromptTokens,
  providerTotalTokens
} from './contextTokenEstimator';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';

export interface AssistantMessageCommit {
  messageId: string;
  messageRevisionId: string;
  contentObjectId: string;
  contextRootId: string;
  deduplicated: boolean;
  commitSeq?: string;
}

/** 将一次模型输出原子提交为 Message aggregate 与新的 ContextSequence head。 */
export class TurnOutputControlPlane {
  private readonly context: ContextSequenceControlPlane;
  private readonly now: () => string;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.context = new ContextSequenceControlPlane(database, contentStore, options);
  }

  public async appendAssistantMessage(input: {
    turnId: string;
    modelRequestId: string;
    sourceKey: string;
    content: string | Uint8Array;
    contentType?: string;
    /** Failed partial output remains transcript data but must never become model-facing Context. */
    contextDisposition?: 'append' | 'exclude';
  }): Promise<AssistantMessageCommit> {
    const turnId = requireId(input.turnId, 'turnId');
    const modelRequestId = requireId(input.modelRequestId, 'modelRequestId');
    const sourceKey = requireText(input.sourceKey, 'sourceKey');
    const contentType = requireText(input.contentType ?? 'application/vnd.limcode.message+json', 'contentType');
    const contextDisposition = input.contextDisposition ?? 'append';
    if (contextDisposition !== 'append' && contextDisposition !== 'exclude') {
      throw new TypeError(`Unsupported assistant output Context disposition: ${String(contextDisposition)}`);
    }
    // Freeze mutable caller bytes before reads; replay and publication must prove the same content.
    const outputContent = typeof input.content === 'string' ? input.content : new Uint8Array(input.content);
    const ids = outputIds(turnId, sourceKey);
    const modelRequest = await this.requireExisting('ModelRequest', modelRequestId);
    if (modelRequest.turn_id !== turnId) throw new Error('ModelRequest belongs to another Turn.');
    const existing = await this.maybeGet('Message', ids.messageId);
    if (existing) {
      return this.replay(ids, this.contentStore.identity(outputContent, contentType).id, modelRequestId);
    }

    const turn = await this.requireExisting('Turn', turnId);
    if (turn.status !== 'active') throw new Error(`Turn ${turnId} is not active.`);
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    const leaseRows = await this.list('ExecutionLease', { turn_id: turnId }, 2);
    if (leaseRows.length !== 1) throw new Error(`Active Turn ${turnId} must have exactly one ExecutionLease.`);
    const content = await this.contentStore.prepare(this.database, outputContent, contentType);
    const currentHeadRootId = await this.context.currentHeadRootId(conversationId);
    if (!currentHeadRootId) throw new Error(`Conversation ${conversationId} has no Context head before assistant output commit.`);
    let contextSteps: RepositoryTransactionStep[] = [];
    if (contextDisposition === 'append') {
      const contentEstimatedTokens = estimateStoredMessageContentTokens(outputContent, contentType);
      const projections = await this.list('ModelContextProjection', {
        owner_kind: 'model_request', owner_id: modelRequestId
      }, 2);
      const providerAligned = projections.length === 1
        && projections[0].root_id === currentHeadRootId;
      const observedInputTokens = providerAligned ? providerPromptTokens(modelRequest.usage_json) : undefined;
      const observedTotalTokens = providerAligned ? providerTotalTokens(modelRequest.usage_json) : undefined;
      const resultingEstimatedTokens = observedTotalTokens
        ?? (observedInputTokens === undefined ? undefined : observedInputTokens + contentEstimatedTokens);
      const context = await this.context.prepareMessageAppendMutation({
        conversationId,
        messageRevisionId: ids.revisionId,
        contentObjectId: content.metadata.id,
        contentByteLength: content.metadata.byte_length,
        contentEstimatedTokens,
        handleOccurrence: { kind: 'message', modelRequestId, content: input.content, contentType },
        ...(resultingEstimatedTokens === undefined ? {} : { resultingEstimatedTokens })
      });
      contextSteps = context.steps;
    }
    const now = requireText(this.now(), 'clock result');

    try {
      const committed = await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(requireId(leaseRows[0].id, 'ExecutionLease.id'), {
          conversation_id: conversationId,
          turn_id: turnId
        }),
        ...preparedContentObjectSteps([content], 'assistant_output'),
        DOMAIN_REPOSITORIES.domain('Message').insert({
          id: ids.messageId,
          created_at: now,
          updated_at: now,
          deleted_at: null
        }),
        DOMAIN_REPOSITORIES.domain('MessageRevision').insertWithNextSequence({
          id: ids.revisionId,
          message_id: ids.messageId,
          role: 'model',
          content_object_id: content.metadata.id,
          created_at: now
        }, {
          column: 'revision_seq',
          scope: { message_id: ids.messageId }
        }),
        DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
          id: ids.currentRevisionLinkId,
          message_id: ids.messageId,
          revision_id: ids.revisionId,
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
          role: 'model',
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ModelRequestMessageLink').insert({
          id: ids.modelRequestLinkId,
          model_request_id: modelRequestId,
          message_id: ids.messageId,
          created_at: now
        }),
        ...contextSteps,
        DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
      ]);
      const contextRootId = await this.context.currentHeadRootId(conversationId);
      if (!contextRootId) throw new Error(`Conversation ${conversationId} has no Context head after assistant output commit.`);
      return {
        messageId: ids.messageId,
        messageRevisionId: ids.revisionId,
        contentObjectId: content.metadata.id,
        contextRootId,
        deduplicated: false,
        commitSeq: committed.commitSeq
      };
    } catch (error) {
      if (!isUniqueOrAssertionFailure(error) || !await this.maybeGet('Message', ids.messageId)) throw error;
      return this.replay(ids, content.metadata.id, modelRequestId);
    }
  }

  /**
   * Astra native streaming: one immutable item-only MessageRevision per completed output item.
   * The first item creates the aggregate's Message/relations (one Message per ModelRequest, link
   * stays 1:1); later items append revisions and advance the current pointer. Call items persist
   * the proving revision with contextDisposition 'exclude' — their Context occurrence is owned by
   * the native tool pair append, so a call never enters Context twice.
   */
  public async appendNativeAssistantItem(input: {
    turnId: string;
    modelRequestId: string;
    /** Stable response/item key; replay of the same immutable item deduplicates. */
    itemKey: string;
    content: string | Uint8Array;
    /**
     * Whole-chain-so-far aggregate content for the durable current projection. The item-only
     * revision stays the Context source; the cumulative revision is the current pointer target so
     * a mid-stream reload never shows only one item. The final chain aggregate replaces it.
     */
    cumulativeContent: string | Uint8Array;
    contentType?: string;
    contextDisposition?: 'append' | 'exclude';
  }, options: { beforeSubmit?: () => void } = {}): Promise<AssistantMessageCommit> {
    options.beforeSubmit?.();
    const turnId = requireId(input.turnId, 'turnId');
    const modelRequestId = requireId(input.modelRequestId, 'modelRequestId');
    const itemKey = requireText(input.itemKey, 'itemKey');
    const contentType = requireText(input.contentType ?? 'application/vnd.limcode.message+json', 'contentType');
    const contextDisposition = input.contextDisposition ?? 'append';
    if (contextDisposition !== 'append' && contextDisposition !== 'exclude') {
      throw new TypeError(`Unsupported assistant output Context disposition: ${String(contextDisposition)}`);
    }
    // Freeze mutable caller bytes before reads; replay and publication must prove the same content.
    const outputContent = typeof input.content === 'string' ? input.content : new Uint8Array(input.content);
    const cumulativeOutputContent = typeof input.cumulativeContent === 'string'
      ? input.cumulativeContent : new Uint8Array(input.cumulativeContent);
    const ids = outputIds(turnId, modelRequestId);
    const revisionId = nativeItemRevisionId(turnId, modelRequestId, itemKey);
    const cumulativeRevisionId = nativeCumulativeRevisionId(turnId, modelRequestId, itemKey);
    const existingRevision = await this.maybeGet('MessageRevision', revisionId);
    if (existingRevision) {
      return this.replayNativeAssistantItem(
        ids,
        revisionId,
        cumulativeRevisionId,
        this.contentStore.identity(outputContent, contentType).id,
        this.contentStore.identity(cumulativeOutputContent, contentType).id,
        itemKey
      );
    }
    const modelRequest = await this.requireExisting('ModelRequest', modelRequestId);
    if (modelRequest.turn_id !== turnId) throw new Error('ModelRequest belongs to another Turn.');
    const turn = await this.requireExisting('Turn', turnId);
    if (turn.status !== 'active') throw new Error(`Turn ${turnId} is not active.`);
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    const leaseRows = await this.list('ExecutionLease', { turn_id: turnId }, 2);
    if (leaseRows.length !== 1) throw new Error(`Active Turn ${turnId} must have exactly one ExecutionLease.`);
    const content = await this.contentStore.prepare(this.database, outputContent, contentType);
    const cumulativeContent = await this.contentStore.prepare(this.database, cumulativeOutputContent, contentType);
    const existingMessage = await this.maybeGet('Message', ids.messageId);
    let contextSteps: RepositoryTransactionStep[] = [];
    if (contextDisposition === 'append') {
      const contentEstimatedTokens = estimateStoredMessageContentTokens(outputContent, contentType);
      const context = await this.context.prepareMessageAppendMutation({
        conversationId,
        messageRevisionId: revisionId,
        contentObjectId: content.metadata.id,
        contentByteLength: content.metadata.byte_length,
        contentEstimatedTokens,
        handleOccurrence: { kind: 'message', modelRequestId, content: input.content, contentType }
      });
      contextSteps = context.steps;
    }
    const now = requireText(this.now(), 'clock result');
    const revisionSteps: RepositoryTransactionStep[] = existingMessage
      ? [
          DOMAIN_REPOSITORIES.domain('Message').assert(ids.messageId, { deleted_at: null }),
          DOMAIN_REPOSITORIES.domain('MessageRevision').insertWithNextSequence({
            id: revisionId,
            message_id: ids.messageId,
            role: 'model',
            content_object_id: content.metadata.id,
            created_at: now
          }, {
            column: 'revision_seq',
            scope: { message_id: ids.messageId }
          }),
          DOMAIN_REPOSITORIES.domain('MessageRevision').insertWithNextSequence({
            id: cumulativeRevisionId,
            message_id: ids.messageId,
            role: 'model',
            content_object_id: cumulativeContent.metadata.id,
            created_at: now
          }, {
            column: 'revision_seq',
            scope: { message_id: ids.messageId }
          }),
          DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').assert(ids.currentRevisionLinkId, {
            message_id: ids.messageId
          }),
          DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').update(ids.currentRevisionLinkId, {
            revision_id: cumulativeRevisionId,
            updated_at: now
          }),
          DOMAIN_REPOSITORIES.domain('Message').update(ids.messageId, { updated_at: now })
        ]
      : [
          DOMAIN_REPOSITORIES.domain('Message').insert({
            id: ids.messageId,
            created_at: now,
            updated_at: now,
            deleted_at: null
          }),
          DOMAIN_REPOSITORIES.domain('MessageRevision').insertWithNextSequence({
            id: revisionId,
            message_id: ids.messageId,
            role: 'model',
            content_object_id: content.metadata.id,
            created_at: now
          }, {
            column: 'revision_seq',
            scope: { message_id: ids.messageId }
          }),
          DOMAIN_REPOSITORIES.domain('MessageRevision').insertWithNextSequence({
            id: cumulativeRevisionId,
            message_id: ids.messageId,
            role: 'model',
            content_object_id: cumulativeContent.metadata.id,
            created_at: now
          }, {
            column: 'revision_seq',
            scope: { message_id: ids.messageId }
          }),
          DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
            id: ids.currentRevisionLinkId,
            message_id: ids.messageId,
            revision_id: cumulativeRevisionId,
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
            role: 'model',
            created_at: now
          }),
          DOMAIN_REPOSITORIES.domain('ModelRequestMessageLink').insert({
            id: ids.modelRequestLinkId,
            model_request_id: modelRequestId,
            message_id: ids.messageId,
            created_at: now
          })
        ];
    try {
      options.beforeSubmit?.();
      const committed = await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(requireId(leaseRows[0].id, 'ExecutionLease.id'), {
          conversation_id: conversationId,
          turn_id: turnId
        }),
        ...preparedContentObjectSteps([content, cumulativeContent], 'assistant_output'),
        ...revisionSteps,
        ...contextSteps,
        DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
      ], options);
      const contextRootId = await this.context.currentHeadRootId(conversationId);
      if (!contextRootId) throw new Error(`Conversation ${conversationId} has no Context head after assistant output commit.`);
      return {
        messageId: ids.messageId,
        messageRevisionId: revisionId,
        contentObjectId: content.metadata.id,
        contextRootId,
        deduplicated: false,
        commitSeq: committed.commitSeq
      };
    } catch (error) {
      if (!isUniqueOrAssertionFailure(error) || !await this.maybeGet('MessageRevision', revisionId)) throw error;
      return this.replayNativeAssistantItem(
        ids,
        revisionId,
        cumulativeRevisionId,
        content.metadata.id,
        cumulativeContent.metadata.id,
        itemKey
      );
    }
  }

  /** Mid-stream-safe replay: proves the persisted item + cumulative pair without the final aggregate. */
  private async replayNativeAssistantItem(
    ids: ReturnType<typeof outputIds>,
    itemRevisionId: string,
    cumulativeRevisionId: string,
    expectedContentObjectId: string,
    expectedCumulativeObjectId: string,
    itemKey: string
  ): Promise<AssistantMessageCommit> {
    const revision = await this.requireExisting('MessageRevision', itemRevisionId);
    if (revision.content_object_id !== expectedContentObjectId || revision.role !== 'model') {
      throw new Error(`Native assistant item ${itemKey} was replayed with different facts.`);
    }
    const cumulative = await this.requireExisting('MessageRevision', cumulativeRevisionId);
    if (cumulative.content_object_id !== expectedCumulativeObjectId || cumulative.role !== 'model') {
      throw new Error(`Native assistant cumulative ${itemKey} was replayed with different facts.`);
    }
    const membership = (await this.list('MessagePartOfConversation', { message_id: ids.messageId }, 2))[0];
    if (!membership) throw new Error(`Assistant output ${ids.messageId} lacks Conversation membership.`);
    const heads = await this.list('ConversationContextHeadLink', {
      conversation_id: requireId(membership.conversation_id, 'MessagePartOfConversation.conversation_id')
    }, 2);
    if (heads.length !== 1) throw new Error('Conversation must have exactly one Context head.');
    return {
      messageId: ids.messageId,
      messageRevisionId: itemRevisionId,
      contentObjectId: expectedContentObjectId,
      contextRootId: requireId(heads[0].root_id, 'ConversationContextHeadLink.root_id'),
      deduplicated: true
    };
  }

  /**
   * Final whole-chain aggregate revision of a native logical request. When item revisions already
   * carried every completed item into Context, the aggregate is the UI projection only and never
   * re-enters Context (no duplicate native calls/text). Without item revisions it degrades to the
   * ordinary single-revision commit.
   */
  public async appendNativeAssistantAggregate(input: {
    turnId: string;
    modelRequestId: string;
    content: string | Uint8Array;
    contentType?: string;
  }): Promise<AssistantMessageCommit> {
    const turnId = requireId(input.turnId, 'turnId');
    const modelRequestId = requireId(input.modelRequestId, 'modelRequestId');
    // Freeze mutable caller bytes before reads; replay and publication must prove the same content.
    const outputContent = typeof input.content === 'string' ? input.content : new Uint8Array(input.content);
    const ids = outputIds(turnId, modelRequestId);
    const existingMessage = await this.maybeGet('Message', ids.messageId);
    if (!existingMessage) {
      return this.appendAssistantMessage({
        turnId,
        modelRequestId,
        sourceKey: modelRequestId,
        content: outputContent,
        ...(input.contentType ? { contentType: input.contentType } : {})
      });
    }
    const contentType = requireText(input.contentType ?? 'application/vnd.limcode.message+json', 'contentType');
    const existingRevision = await this.maybeGet('MessageRevision', ids.revisionId);
    if (existingRevision) {
      return this.replay(ids, this.contentStore.identity(outputContent, contentType).id, modelRequestId);
    }
    await this.assertNativeAggregateItemsEnteredContext(turnId, modelRequestId, ids.messageId, outputContent);
    const turn = await this.requireExisting('Turn', turnId);
    if (turn.status !== 'active') throw new Error(`Turn ${turnId} is not active.`);
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    const leaseRows = await this.list('ExecutionLease', { turn_id: turnId }, 2);
    if (leaseRows.length !== 1) throw new Error(`Active Turn ${turnId} must have exactly one ExecutionLease.`);
    const content = await this.contentStore.prepare(this.database, outputContent, contentType);
    const now = requireText(this.now(), 'clock result');
    try {
      const committed = await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(requireId(leaseRows[0].id, 'ExecutionLease.id'), {
          conversation_id: conversationId,
          turn_id: turnId
        }),
        ...preparedContentObjectSteps([content], 'assistant_output'),
        DOMAIN_REPOSITORIES.domain('Message').assert(ids.messageId, { deleted_at: null }),
        DOMAIN_REPOSITORIES.domain('ModelRequestMessageLink').assert(ids.modelRequestLinkId, {
          model_request_id: modelRequestId,
          message_id: ids.messageId
        }),
        DOMAIN_REPOSITORIES.domain('MessageRevision').insertWithNextSequence({
          id: ids.revisionId,
          message_id: ids.messageId,
          role: 'model',
          content_object_id: content.metadata.id,
          created_at: now
        }, {
          column: 'revision_seq',
          scope: { message_id: ids.messageId }
        }),
        DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').assert(ids.currentRevisionLinkId, {
          message_id: ids.messageId
        }),
        DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').update(ids.currentRevisionLinkId, {
          revision_id: ids.revisionId,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Message').update(ids.messageId, { updated_at: now }),
        DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
      ]);
      const contextRootId = await this.context.currentHeadRootId(conversationId);
      if (!contextRootId) throw new Error(`Conversation ${conversationId} has no Context head after assistant output commit.`);
      return {
        messageId: ids.messageId,
        messageRevisionId: ids.revisionId,
        contentObjectId: content.metadata.id,
        contextRootId,
        deduplicated: false,
        commitSeq: committed.commitSeq
      };
    } catch (error) {
      if (!isUniqueOrAssertionFailure(error) || !await this.maybeGet('MessageRevision', ids.revisionId)) throw error;
      return this.replay(ids, content.metadata.id, modelRequestId);
    }
  }

  /** Failed partial output updates the request's one Message; unclosed output never enters Context. */
  public async appendNativeAssistantPartialAggregate(input: {
    turnId: string;
    modelRequestId: string;
    sourceKey: string;
    content: string | Uint8Array;
    contentType?: string;
  }): Promise<AssistantMessageCommit> {
    return this.appendNativeAssistantItem({
      ...input,
      itemKey: `failed-partial:${requireText(input.sourceKey, 'sourceKey')}`,
      cumulativeContent: input.content,
      contextDisposition: 'exclude'
    });
  }

  /** Message existence proves only some item was stored. Every final item needs its own proof. */
  private async assertNativeAggregateItemsEnteredContext(
    turnId: string,
    modelRequestId: string,
    messageId: string,
    content: string | Uint8Array
  ): Promise<void> {
    const aggregate = nativeAssistantMessageParts(JSON.parse(typeof content === 'string'
      ? content : Buffer.from(content).toString('utf8')));
    const revisions = (await listAllDomainRows(this.database, 'MessageRevision', { message_id: messageId }))
      .sort((left, right) => Number(BigInt(String(left.revision_seq)) - BigInt(String(right.revision_seq))));
    const projectionIds = new Set([assistantMessageRevisionIdFor(turnId, modelRequestId)]);
    const callCounts = new Map<string, number>();
    const proofs = new Map<string, { revision: DomainRow; part: Record<string, PlainJsonValue> }>();
    for (const revision of revisions) {
      if (projectionIds.has(String(revision.id))) continue;
      const metadata = await this.requireExisting('ContentObject', requireId(revision.content_object_id, 'MessageRevision.content_object_id'));
      const itemParts = nativeAssistantMessageParts(JSON.parse((await this.contentStore.read(metadata as unknown as ContentObjectMetadata)).toString('utf8')));
      if (itemParts.length !== 1) continue;
      const part = itemParts[0]!;
      if (!nativeRecord(part.outputItem)?.providerResponseId) continue;
      const reference = nativeAssistantOutputReference(part);
      const call = nativeRecord(part.functionCall);
      const callIndex = callCounts.get(reference.providerResponseId) ?? 0;
      const itemKey = call ? `call:${reference.providerResponseId}:${callIndex}`
        : `content:${reference.providerResponseId}:${reference.ordinal}`;
      if (revision.id !== nativeItemRevisionId(turnId, modelRequestId, itemKey)) continue;
      if (call) callCounts.set(reference.providerResponseId, callIndex + 1);
      projectionIds.add(nativeCumulativeRevisionId(turnId, modelRequestId, itemKey));
      const key = nativeAssistantPartIdentity(part);
      if (proofs.has(key)) throw new Error(`Native output item ${reference.id} has duplicate immutable proofs.`);
      proofs.set(key, { revision, part });
    }
    const sources = await listAllDomainRows(this.database, 'ToolCallSourceLink', { model_request_id: modelRequestId });
    const identifiedAggregate = aggregate.map(part => {
      if (nativeRecord(part.outputItem)?.providerResponseId) return part;
      // Some frozen aggregate projections omit item metadata. Exact agreement with one immutable
      // proof can establish their identity; missing/ambiguous bodies never qualify.
      const matches = [...proofs.values()].filter(proof => nativeAssistantSemanticPart(proof.part) === nativeAssistantSemanticPart(part));
      if (matches.length !== 1) throw new Error('Native completed output without metadata has no unique immutable item proof.');
      return { ...part, outputItem: matches[0]!.part.outputItem! };
    });
    for (const parts of nativeAssistantPartGroups(identifiedAggregate)) {
      const part = normalizeNativeAssistantCompletedItem({ role: 'model', parts });
      if (!part) continue;
      const reference = nativeAssistantOutputReference(part);
      const proof = proofs.get(nativeAssistantPartIdentity(part));
      if (!proof || nativeAssistantComparablePart(proof.part) !== nativeAssistantComparablePart(part)) {
        throw new Error(`Native completed output item ${reference.id} has no matching immutable item proof.`);
      }
      const source = nativeRecord(part.functionCall)
        ? sources.find(row => row.provider_call_id === part.id)
        : undefined;
      const contextSources = await listAllDomainRows(this.database, 'ContextSegmentSource', source
        ? { source_kind: 'tool_call', source_id: source.tool_call_id }
        : { source_kind: 'message_revision', source_id: proof.revision.id });
      if (contextSources.length === 0) {
        throw new Error(`Native completed output item ${reference.id} has not entered Context.`);
      }
    }
  }

  private async replay(
    ids: ReturnType<typeof outputIds>,
    expectedContentObjectId: string,
    expectedModelRequestId: string
  ): Promise<AssistantMessageCommit> {
    const revision = await this.requireExisting('MessageRevision', ids.revisionId);
    if (revision.message_id !== ids.messageId || revision.content_object_id !== expectedContentObjectId || revision.role !== 'model') {
      throw new Error(`Assistant output ${ids.messageId} was replayed with different facts.`);
    }
    const membership = (await this.list('MessagePartOfConversation', { message_id: ids.messageId }, 2))[0];
    if (!membership) throw new Error(`Assistant output ${ids.messageId} lacks Conversation membership.`);
    const requestLink = await this.requireExisting('ModelRequestMessageLink', ids.modelRequestLinkId);
    if (
      requestLink.model_request_id !== expectedModelRequestId
      || requestLink.message_id !== ids.messageId
    ) throw new Error(`Assistant output ${ids.messageId} has a conflicting ModelRequest link.`);
    const heads = await this.list('ConversationContextHeadLink', {
      conversation_id: requireId(membership.conversation_id, 'MessagePartOfConversation.conversation_id')
    }, 2);
    if (heads.length !== 1) throw new Error('Conversation must have exactly one Context head.');
    return {
      messageId: ids.messageId,
      messageRevisionId: ids.revisionId,
      contentObjectId: expectedContentObjectId,
      contextRootId: requireId(heads[0].root_id, 'ConversationContextHeadLink.root_id'),
      deduplicated: true
    };
  }

  private async maybeGet(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return snapshot.snapshot[0] as DomainRow | null;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const row = await this.maybeGet(domain, id);
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

export function assistantMessageIdFor(turnId: string, sourceKey: string): string {
  return outputIds(requireId(turnId, 'turnId'), requireText(sourceKey, 'sourceKey')).messageId;
}

/** Stable response/item identity; response-local fallback ids are never shared by two responses. */
export function nativeAssistantPartIdentity(part: Record<string, unknown>): string {
  const reference = nativeAssistantOutputReference(part);
  return JSON.stringify([reference.providerResponseId, reference.id, nativeRecord(part.functionCall) ? 'call' : 'content']);
}

/** A raw item's multiple text/summary blocks have one immutable semantic body. */
export function normalizeNativeAssistantCompletedItem(value: unknown): Record<string, PlainJsonValue> | undefined {
  const parts = nativeAssistantMessageParts(value);
  if (parts.length === 0) return undefined;
  const first = parts[0]!;
  const identity = nativeAssistantPartIdentity(first);
  if (parts.some(part => nativeAssistantPartIdentity(part) !== identity)) {
    throw new Error('Native completed item contains more than one output identity.');
  }
  if (parts.every(part => typeof part.text === 'string')) {
    const thought = first.thought === true;
    if (parts.some(part => (part.thought === true) !== thought)) throw new Error('Native item mixes visible text and reasoning.');
    const signatures = [...new Set(parts.flatMap(part => typeof part.thoughtSignature === 'string' ? [part.thoughtSignature] : []))];
    if (signatures.length > 1) throw new Error('Native item has conflicting reasoning signatures.');
    return normalizePlainJson({ text: parts.map(part => part.text).join(''),
      ...(thought ? { thought: true } : {}),
      ...(signatures[0] ? { thoughtSignature: signatures[0] } : {}),
      outputItem: first.outputItem
    }, 'Native completed text item') as Record<string, PlainJsonValue>;
  }
  if (parts.length !== 1) throw new Error('Native completed non-text item contains multiple parts.');
  return first;
}

function nativeAssistantMessageParts(value: unknown): Array<Record<string, PlainJsonValue>> {
  const record = nativeRecord(value);
  if (!record || record.role !== 'model' || !Array.isArray(record.parts)) throw new TypeError('Native assistant content is not a model MessageContent.');
  return record.parts.map(part => {
    if (!nativeRecord(part)) throw new TypeError('Native assistant part must be an object.');
    return normalizePlainJson(part, 'Native assistant part') as Record<string, PlainJsonValue>;
  });
}

function nativeAssistantPartGroups(parts: Array<Record<string, PlainJsonValue>>): Array<Array<Record<string, PlainJsonValue>>> {
  const groups = new Map<string, Array<Record<string, PlainJsonValue>>>();
  for (const part of parts) {
    const key = nativeAssistantPartIdentity(part);
    const group = groups.get(key) ?? [];
    group.push(part);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function nativeAssistantComparablePart(part: Record<string, PlainJsonValue>): string {
  // WS stream ordinals were lifted across responses while terminal ordinals remained local.
  // Response + item id owns identity; keep frozen ordinals but do not reinterpret them as ids.
  const reference = nativeRecord(part.outputItem)!;
  const { ordinal: _ordinal, ...identity } = reference;
  const { thoughtDurationMs: _thoughtDurationMs, ...semantic } = part;
  return canonicalPlainJson({ ...semantic, outputItem: identity }, 'Native immutable item comparison');
}

function nativeAssistantSemanticPart(part: Record<string, PlainJsonValue>): string {
  const { outputItem: _outputItem, thoughtDurationMs: _thoughtDurationMs, ...semantic } = part;
  return canonicalPlainJson(semantic, 'Native semantic item comparison');
}

function nativeAssistantOutputReference(part: Record<string, unknown>): { id: string; ordinal: number; providerResponseId: string } {
  const reference = nativeRecord(part.outputItem);
  if (!reference || typeof reference.ordinal !== 'number' || !Number.isSafeInteger(reference.ordinal) || reference.ordinal < 0) {
    throw new TypeError('Native output part requires a stable ordinal.');
  }
  return { id: requireId(reference.id, 'Native output item id'), ordinal: reference.ordinal,
    providerResponseId: requireId(reference.providerResponseId, 'Native output response id') };
}

function nativeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** Deterministic per-item revision identity of the one aggregate assistant Message of a ModelRequest. */
export function nativeItemRevisionId(turnId: string, modelRequestId: string, itemKey: string): string {
  return `rk_message_revision_${createHash('sha256')
    .update(JSON.stringify([requireId(turnId, 'turnId'), requireId(modelRequestId, 'modelRequestId'), 'native_item', requireText(itemKey, 'itemKey')]))
    .digest('hex')
    .slice(0, 32)}`;
}

/** Deterministic per-item CUMULATIVE revision identity (the durable current projection target). */
export function nativeCumulativeRevisionId(turnId: string, modelRequestId: string, itemKey: string): string {
  return `rk_message_revision_${createHash('sha256')
    .update(JSON.stringify([requireId(turnId, 'turnId'), requireId(modelRequestId, 'modelRequestId'), 'native_cumulative', requireText(itemKey, 'itemKey')]))
    .digest('hex')
    .slice(0, 32)}`;
}

/** The standard (final aggregate) revision identity of one assistant output Message. */
export function assistantMessageRevisionIdFor(turnId: string, sourceKey: string): string {
  return outputIds(requireId(turnId, 'turnId'), requireText(sourceKey, 'sourceKey')).revisionId;
}

function outputIds(turnId: string, sourceKey: string) {
  const id = (kind: string): string => `rk_${kind}_${createHash('sha256')
    .update(JSON.stringify([turnId, sourceKey, kind]))
    .digest('hex')
    .slice(0, 32)}`;
  return {
    messageId: id('message'),
    revisionId: id('message_revision'),
    currentRevisionLinkId: id('message_current_revision'),
    membershipId: id('message_membership'),
    turnLinkId: id('message_turn_link'),
    modelRequestLinkId: id('model_request_message_link')
  };
}

function isUniqueOrAssertionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed') || message.includes('assertion failed');
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty id.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}
