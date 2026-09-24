import { createHash } from 'node:crypto';
import {
  ContentAddressedStore,
  type ContentObjectMetadata,
  type PreparedContentObject
} from './contentAddressedStore';
import { resolveConversationCompressionBlock } from './compressionBlockOwnership';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import {
  DOMAIN_REPOSITORIES,
  savepoint,
  type DomainRow,
  type RepositoryRead,
  type RepositoryTransactionStep
} from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';
import type { ContextModelSource } from './databaseWorkerProtocol';
import { projectStoredModelFacingWindow } from './modelFacingContextProjection';
import { currentExecutionLeaseFence } from './executionLeaseFence';
import {
  NativeAsyncWorkPendingError,
  parseNativeAdmissionContent,
  TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION,
  type NativePendingWorkRef
} from './nativeToolFacts';

export type ContextSegmentKind = 'system' | 'message' | 'tool_pair' | 'compression' | 'runtime_context';
export type ContextSourceKind =
  | 'message_revision'
  | 'tool_call'
  | 'tool_model_result'
  | 'compression_block'
  | 'system'
  | 'runtime_context';

export interface ContextSourceOccurrence {
  sourceKind: ContextSourceKind;
  sourceId: string;
  sourceRevision: string | bigint;
}

export interface ContextAppendCommand {
  conversationId: string;
  segmentKind: Exclude<ContextSegmentKind, 'message' | 'tool_pair' | 'compression'>;
  source: ContextSourceOccurrence;
  content: string | Uint8Array;
  contentType: string;
  baseRootId?: string | null;
  expectedHeadRootId?: string | null;
  activate?: boolean;
}

export interface ContextToolPairAppendCommand {
  conversationId: string;
  toolCallId: string;
  toolModelResultId: string;
  providerCallId?: string;
  baseRootId?: string | null;
  expectedHeadRootId?: string | null;
  activate?: boolean;
}

export interface ContextToolPairBatchAppendCommand {
  conversationId: string;
  pairs: ReadonlyArray<{
    toolCallId: string;
    toolModelResultId: string;
    providerCallId?: string;
  }>;
}

export interface ContextToolPairBatchAppendResult {
  segmentIds: string[];
  rootId: string | null;
  commitSeq?: string;
  appendedCount: number;
  deduplicatedCount: number;
  transactionCount: 0 | 1;
}

export type ContextSequenceMetricsEvent =
  | {
      kind: 'materialize';
      mode: 'structure' | 'content';
      count: 1;
      observedAt: string;
    }
  | {
      kind: 'transaction';
      operation: 'append' | 'activate' | 'repair' | 'tool_pair_batch';
      count: 1;
      toolPairCount?: number;
      observedAt: string;
    };

type ContextSequenceMetricsEventInput =
  | Omit<Extract<ContextSequenceMetricsEvent, { kind: 'materialize' }>, 'observedAt'>
  | Omit<Extract<ContextSequenceMetricsEvent, { kind: 'transaction' }>, 'observedAt'>;

export interface ContextSequenceMetricsObserver {
  observe(event: ContextSequenceMetricsEvent): void;
}

export interface ContextAppendResult {
  segmentId: string;
  nodeId: string;
  rootId: string;
  rootSeq: string;
  commitSeq?: string;
  deduplicated: boolean;
}

export interface MaterializedContextSegment {
  nodeId: string;
  parentNodeId: string | null;
  segmentId: string;
  segmentKind: ContextSegmentKind;
  messageRole: string | null;
  modelSource?: ContextModelSource;
  /** Frozen recipe ContentObject of the ModelRequest whose output this model message segment is. */
  sourceRecipeObjectId?: string;
  /** Claude 保留思考处理：产生这条模型输出的请求发出时这个对话已选定的处理。 */
  sourceClaudeThinkingBinding?: 'drop_block' | 'strip_thinking';
  contentObject: ContentObjectMetadata;
  content: Buffer;
}

export interface ContextMutationPlan {
  steps: RepositoryTransactionStep[];
}

export interface FreshConversationMessageContextPlan extends ContextMutationPlan {
  rootId: string;
  headLinkId: string;
}

export interface FreshConversationMessageContextPlanInput {
  conversationId: string;
  messageRevisionId: string;
  contentObjectId: string;
  contentByteLength: bigint;
  /** Provider-semantic estimate for this Message; defaults to the legacy byte fallback. */
  contentEstimatedTokens?: number;
  /** Immutable occurrences whose independent target provenance is written in the same transaction. */
  inheritedSegments?: readonly { segmentId: string; estimatedTokens: number }[];
}

export interface MessageContextAppendPlanInput {
  conversationId: string;
  messageRevisionId: string;
  /** Already committed immutable revision; omitted when the caller allocates it in this transaction. */
  existingRevisionSeq?: bigint;
  contentObjectId: string;
  contentByteLength: bigint;
  /** Provider-semantic estimate for the appended Message. */
  contentEstimatedTokens?: number;
  /** Provider-observed estimate for the complete resulting root (for example input + model output). */
  resultingEstimatedTokens?: number;
}

export interface MessageContextEditPlanInput {
  conversationId: string;
  previousMessageRevisionId: string;
  nextMessageRevisionId: string;
  contentObjectId: string;
  contentByteLength: bigint;
}

export interface MessageContextDeletePlanInput {
  conversationId: string;
  messageRevisionId: string;
  idempotencyKey: string;
}

export interface MessageContextTruncateReplacement {
  messageRevisionId: string;
  contentObjectId: string;
  contentByteLength: bigint;
  contentEstimatedTokens: number;
}

export interface MessageContextTruncatePlanInput extends MessageContextDeletePlanInput {
  replacement?: MessageContextTruncateReplacement;
}

export interface MaterializedContext {
  root: DomainRow;
  segments: MaterializedContextSegment[];
  snapshotCommitSeq: string;
}

export interface ContextOrphanToolPairRepairReport {
  conversationsScanned: number;
  conversationsRepaired: number;
  removedToolPairs: number;
}

interface AppendOccurrencePlan {
  conversationId: string;
  segmentKind: ContextSegmentKind;
  sources: ContextSourceOccurrence[];
  content: PreparedContentObject;
  baseRootId?: string | null;
  expectedHeadRootId?: string | null;
  activate?: boolean;
  /**
   * Authorized native partial tool_pair construction (single declared source). Only the native
   * append methods set this after proving the durable native admission; generic append paths can
   * never produce the partial shape.
   */
  nativePartialPair?: 'tool_call' | 'tool_model_result';
  /** Atomic execution fence asserted in every committing transaction of the native append. */
  executionFence?: { callTurnId: string };
}

interface BaseShape {
  root: DomainRow | null;
  rootId: string | null;
  rootNodeId: string | null;
  tailNodeId: string | null;
  tailSegmentCount: bigint;
  segmentCount: bigint;
  estimatedTokens: bigint;
  compression: boolean;
}

interface ToolPairBatchFact {
  toolCallId: string;
  toolModelResultId: string;
  providerCallId?: string;
  toolCall: DomainRow;
  modelResult: DomainRow;
  turnId: string;
  resultRevisionId: string;
  argumentObjectId: string;
  callSeq: bigint;
  sources: [ContextSourceOccurrence, ContextSourceOccurrence];
  segmentId: string;
  existing: boolean;
  argumentMetadata?: ContentObjectMetadata;
  resultContentId?: string;
  resultMetadata?: ContentObjectMetadata;
}

const CONTENT_TYPE_TOOL_PAIR = 'application/vnd.limcode.context-tool-pair+json';
const EXPECTED_OCCURRENCE_CONSTRAINTS = [
  { domain: 'ContextSegment', columns: ['id'] },
  { domain: 'ContextSegmentSource', columns: ['source_kind', 'source_id', 'source_revision'] }
];
const EXPECTED_NODE_CONSTRAINTS = [
  { domain: 'ContextSequenceNode', columns: ['id'] },
  { domain: 'ContextSequenceNode', columns: ['parent_node_id', 'segment_id'] },
  { domain: 'ContextSequenceNode', columns: ['segment_id'] }
];

/** Stage E Context authority. It never reads current Message state while materializing a frozen root. */
export class ContextSequenceControlPlane {
  private readonly now: () => string;
  private readonly metricsObserver: ContextSequenceMetricsObserver | undefined;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    options: { now?: () => string; metricsObserver?: ContextSequenceMetricsObserver } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.metricsObserver = options.metricsObserver;
  }

  public async appendContent(command: ContextAppendCommand): Promise<ContextAppendResult> {
    const conversationId = requireId(command.conversationId, 'conversationId');
    const segmentKind = requireSegmentKind(command.segmentKind);
    if (segmentKind === 'message' || segmentKind === 'tool_pair' || segmentKind === 'compression') {
      throw new TypeError(`appendContent cannot create ${segmentKind} segments.`);
    }
    const sources = [normalizeSource(command.source)];
    validateNewContextSegmentSources(segmentKind, sources);
    await this.preflightAppendTarget(
      conversationId, command.baseRootId, command.expectedHeadRootId, command.activate !== false
    );
    const content = await this.contentStore.prepare(
      this.database,
      command.content,
      requireText(command.contentType, 'contentType')
    );
    return this.appendOccurrence({
      conversationId,
      segmentKind,
      sources,
      content,
      baseRootId: command.baseRootId,
      expectedHeadRootId: command.expectedHeadRootId,
      activate: command.activate
    });
  }

  public async appendToolPair(command: ContextToolPairAppendCommand): Promise<ContextAppendResult> {
    const conversationId = requireId(command.conversationId, 'conversationId');
    const toolCallId = requireId(command.toolCallId, 'toolCallId');
    const toolModelResultId = requireId(command.toolModelResultId, 'toolModelResultId');
    const providerCallId = command.providerCallId === undefined
      ? undefined
      : requireId(command.providerCallId, 'providerCallId');
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ToolCall').get(toolCallId),
      DOMAIN_REPOSITORIES.domain('ToolModelResult').get(toolModelResultId)
    ]);
    const toolCall = requireRow(snapshot.snapshot[0], `ToolCall ${toolCallId}`);
    const modelResult = requireRow(snapshot.snapshot[1], `ToolModelResult ${toolModelResultId}`);
    if (modelResult.tool_call_id !== toolCallId) throw new Error('ToolModelResult does not belong to ToolCall.');
    const turnId = requireId(toolCall.turn_id, 'ToolCall.turn_id');
    const resultRevisionId = requireId(modelResult.message_revision_id, 'ToolModelResult.message_revision_id');
    const related = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Turn').get(turnId),
      DOMAIN_REPOSITORIES.domain('MessageRevision').get(resultRevisionId),
      DOMAIN_REPOSITORIES.domain('ContentObject').get(requireId(toolCall.arguments_object_id, 'ToolCall.arguments_object_id'))
    ]);
    const turn = requireRow(related.snapshot[0], `Turn ${turnId}`);
    if (turn.conversation_id !== conversationId) throw new Error('ToolCall belongs to another Conversation.');
    const resultRevision = requireRow(related.snapshot[1], `MessageRevision ${resultRevisionId}`);
    const resultContentId = requireId(resultRevision.content_object_id, 'MessageRevision.content_object_id');
    const resultContentSnapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ContentObject').get(resultContentId)
    ]);
    const argumentMetadata = asContentObjectMetadata(requireRow(
      related.snapshot[2],
      `ContentObject ${String(toolCall.arguments_object_id)}`
    ));
    const resultMetadata = asContentObjectMetadata(requireRow(
      resultContentSnapshot.snapshot[0],
      `ContentObject ${resultContentId}`
    ));
    await this.preflightAppendTarget(
      conversationId, command.baseRootId, command.expectedHeadRootId, command.activate !== false
    );
    const [argumentsBytes, resultBytes] = await this.contentStore.readMany([argumentMetadata, resultMetadata]);
    const callSeq = requireBigInt(toolCall.call_seq, 'ToolCall.call_seq');
    const pair = await this.contentStore.prepare(this.database, JSON.stringify({
      kind: 'tool_pair',
      toolCall: {
        id: toolCallId,
        ...(providerCallId ? { providerCallId } : {}),
        callSeq: callSeq.toString(),
        toolName: requireText(toolCall.tool_name, 'ToolCall.tool_name'),
        argumentsContentType: argumentMetadata.content_type,
        arguments: argumentsBytes.toString('utf8')
      },
      toolModelResult: {
        id: toolModelResultId,
        messageRevisionId: resultRevisionId,
        resultContentType: resultMetadata.content_type,
        result: resultBytes.toString('utf8')
      }
    }), CONTENT_TYPE_TOOL_PAIR);
    return this.appendOccurrence({
      conversationId,
      segmentKind: 'tool_pair',
      sources: [
        { sourceKind: 'tool_call', sourceId: toolCallId, sourceRevision: callSeq },
        { sourceKind: 'tool_model_result', sourceId: toolModelResultId, sourceRevision: callSeq }
      ],
      content: pair,
      baseRootId: command.baseRootId,
      expectedHeadRootId: command.expectedHeadRootId,
      activate: command.activate
    });
  }

  /**
   * Appends one provider-ordered terminal prefix with a constant number of compound reads and one
   * writer transaction. Existing occurrences must form a prefix; accepting a later occurrence
   * across a missing earlier pair would make the model-visible call/result order ambiguous.
   */
  public async appendToolPairsInOrderBatch(
    command: ContextToolPairBatchAppendCommand
  ): Promise<ContextToolPairBatchAppendResult> {
    const conversationId = requireId(command.conversationId, 'conversationId');
    const pairs = command.pairs.map((pair, index) => ({
      toolCallId: requireId(pair.toolCallId, `pairs[${index}].toolCallId`),
      toolModelResultId: requireId(pair.toolModelResultId, `pairs[${index}].toolModelResultId`),
      ...(pair.providerCallId === undefined
        ? {}
        : { providerCallId: requireId(pair.providerCallId, `pairs[${index}].providerCallId`) })
    }));
    if (pairs.length === 0) {
      return {
        segmentIds: [],
        rootId: null,
        appendedCount: 0,
        deduplicatedCount: 0,
        transactionCount: 0
      };
    }
    if (new Set(pairs.map((pair) => pair.toolCallId)).size !== pairs.length) {
      throw new Error('Context tool-pair batch contains duplicate ToolCall identities.');
    }
    if (new Set(pairs.map((pair) => pair.toolModelResultId)).size !== pairs.length) {
      throw new Error('Context tool-pair batch contains duplicate ToolModelResult identities.');
    }

    const factReads = pairs.flatMap((pair): RepositoryRead[] => [
      DOMAIN_REPOSITORIES.domain('ToolCall').get(pair.toolCallId),
      DOMAIN_REPOSITORIES.domain('ToolModelResult').get(pair.toolModelResultId),
      DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
        where: { source_kind: 'tool_call', source_id: pair.toolCallId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
        where: { source_kind: 'tool_model_result', source_id: pair.toolModelResultId },
        limit: 2
      })
    ]);
    const factSnapshot = await this.database.snapshot(factReads);
    const facts: ToolPairBatchFact[] = [];
    let sawMissingOccurrence = false;
    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[index];
      const offset = index * 4;
      const toolCall = requireRow(factSnapshot.snapshot[offset], `ToolCall ${pair.toolCallId}`);
      const modelResult = requireRow(
        factSnapshot.snapshot[offset + 1],
        `ToolModelResult ${pair.toolModelResultId}`
      );
      if (modelResult.tool_call_id !== pair.toolCallId) {
        throw new Error(`ToolModelResult ${pair.toolModelResultId} does not belong to ToolCall ${pair.toolCallId}.`);
      }
      const callSeq = requireBigInt(toolCall.call_seq, 'ToolCall.call_seq');
      const sources: [ContextSourceOccurrence, ContextSourceOccurrence] = [
        { sourceKind: 'tool_call', sourceId: pair.toolCallId, sourceRevision: callSeq },
        { sourceKind: 'tool_model_result', sourceId: pair.toolModelResultId, sourceRevision: callSeq }
      ];
      const callSources = rows(factSnapshot.snapshot[offset + 2]);
      const resultSources = rows(factSnapshot.snapshot[offset + 3]);
      if (callSources.length > 1) {
        throw new Error(`ToolCall ${pair.toolCallId} has multiple Context occurrences.`);
      }
      if (resultSources.length > 1) {
        throw new Error(`ToolModelResult ${pair.toolModelResultId} has multiple Context occurrences.`);
      }
      const existing = callSources.length === 1 && resultSources.length === 1;
      if ((callSources.length === 1) !== (resultSources.length === 1)) {
        throw new Error(`Context tool pair ${pair.toolCallId}/${pair.toolModelResultId} is partially registered.`);
      }
      const segmentId = stableSegmentId(sources);
      if (existing) {
        if (sawMissingOccurrence) {
          throw new Error('Existing Context tool-pair occurrences must form a provider-ordered prefix.');
        }
        const callSource = callSources[0];
        const resultSource = resultSources[0];
        if (
          requireBigInt(callSource.source_revision, 'ContextSegmentSource.source_revision') !== callSeq
          || requireBigInt(resultSource.source_revision, 'ContextSegmentSource.source_revision') !== callSeq
          || callSource.segment_id !== resultSource.segment_id
          || callSource.segment_id !== segmentId
        ) {
          throw new Error(`Context tool pair ${pair.toolCallId}/${pair.toolModelResultId} has conflicting source identity.`);
        }
      } else {
        sawMissingOccurrence = true;
      }
      facts.push({
        ...pair,
        toolCall,
        modelResult,
        turnId: requireId(toolCall.turn_id, 'ToolCall.turn_id'),
        resultRevisionId: requireId(modelResult.message_revision_id, 'ToolModelResult.message_revision_id'),
        argumentObjectId: requireId(toolCall.arguments_object_id, 'ToolCall.arguments_object_id'),
        callSeq,
        sources,
        segmentId,
        existing
      });
    }
    for (let index = 1; index < facts.length; index += 1) {
      if (facts[index].turnId !== facts[0].turnId) {
        throw new Error('Context tool-pair batch must belong to one Turn.');
      }
      if (facts[index].callSeq <= facts[index - 1].callSeq) {
        throw new Error('Context tool-pair batch is not in provider call order.');
      }
    }

    const relatedReads: RepositoryRead[] = [];
    const relatedIndexes = new Map<string, number>();
    const addRelatedRead = (key: string, read: RepositoryRead): void => {
      if (relatedIndexes.has(key)) return;
      relatedIndexes.set(key, relatedReads.length);
      relatedReads.push(read);
    };
    addRelatedRead('conversation', DOMAIN_REPOSITORIES.domain('Conversation').get(conversationId));
    addRelatedRead('head', DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').list({
      where: { conversation_id: conversationId },
      limit: 2
    }));
    for (const fact of facts) {
      addRelatedRead(`turn:${fact.turnId}`, DOMAIN_REPOSITORIES.domain('Turn').get(fact.turnId));
      if (fact.existing) {
        addRelatedRead(`segment:${fact.segmentId}`, DOMAIN_REPOSITORIES.domain('ContextSegment').get(fact.segmentId));
      } else {
        addRelatedRead(
          `revision:${fact.resultRevisionId}`,
          DOMAIN_REPOSITORIES.domain('MessageRevision').get(fact.resultRevisionId)
        );
        addRelatedRead(
          `content:${fact.argumentObjectId}`,
          DOMAIN_REPOSITORIES.domain('ContentObject').get(fact.argumentObjectId)
        );
      }
    }
    const relatedSnapshot = await this.database.snapshot(relatedReads);
    const related = (key: string): unknown => {
      const index = relatedIndexes.get(key);
      if (index === undefined) throw new Error(`Missing Context batch read ${key}.`);
      return relatedSnapshot.snapshot[index];
    };
    requireRow(related('conversation'), `Conversation ${conversationId}`);
    const headRows = rows(related('head'));
    if (headRows.length > 1) throw new Error(`Conversation ${conversationId} has multiple Context heads.`);
    const head = headRows[0] ?? null;
    const currentHeadRootId = head
      ? requireId(head.root_id, 'ConversationContextHeadLink.root_id')
      : null;
    const expectedHeadRootId = currentHeadRootId;
    const baseRootId = currentHeadRootId;
    for (const fact of facts) {
      const turn = requireRow(related(`turn:${fact.turnId}`), `Turn ${fact.turnId}`);
      if (turn.conversation_id !== conversationId) {
        throw new Error(`ToolCall ${fact.toolCallId} belongs to another Conversation.`);
      }
      if (fact.existing) {
        const segment = requireRow(
          related(`segment:${fact.segmentId}`),
          `ContextSegment ${fact.segmentId}`
        );
        if (segment.id !== fact.segmentId || segment.segment_kind !== 'tool_pair') {
          throw new Error(`Context tool pair ${fact.toolCallId}/${fact.toolModelResultId} points to a conflicting segment.`);
        }
        continue;
      }
      const resultRevision = requireRow(
        related(`revision:${fact.resultRevisionId}`),
        `MessageRevision ${fact.resultRevisionId}`
      );
      const resultContentId = requireId(
        resultRevision.content_object_id,
        'MessageRevision.content_object_id'
      );
      fact.argumentMetadata = asContentObjectMetadata(requireRow(
        related(`content:${fact.argumentObjectId}`),
        `ContentObject ${fact.argumentObjectId}`
      ));
      fact.resultContentId = resultContentId;
    }

    const missingFacts = facts.filter((fact) => !fact.existing);
    if (missingFacts.length === 0) {
      return {
        segmentIds: facts.map((fact) => fact.segmentId),
        rootId: currentHeadRootId,
        appendedCount: 0,
        deduplicatedCount: facts.length,
        transactionCount: 0
      };
    }
    const finalReads: RepositoryRead[] = missingFacts.map((fact) => DOMAIN_REPOSITORIES.domain('ContentObject').get(
      requireId(fact.resultContentId, 'ToolModelResult ContentObject.id')
    ));
    if (baseRootId) finalReads.push(DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').get(baseRootId));
    const finalSnapshot = await this.database.snapshot(finalReads);
    for (let index = 0; index < missingFacts.length; index += 1) {
      const fact = missingFacts[index];
      fact.resultMetadata = asContentObjectMetadata(requireRow(
        finalSnapshot.snapshot[index],
        `ContentObject ${String(fact.resultContentId)}`
      ));
    }
    const baseRoot = baseRootId
      ? requireRow(finalSnapshot.snapshot[missingFacts.length], `ContextSequenceRoot ${baseRootId}`)
      : null;
    if (baseRoot && baseRoot.conversation_id !== conversationId) {
      throw new Error(`ContextSequenceRoot ${baseRootId} belongs to another Conversation.`);
    }

    let compression = false;
    const baseRootNodeId = baseRoot
      ? nullableId(baseRoot.root_node_id, 'ContextSequenceRoot.root_node_id')
      : null;
    if (baseRootNodeId) {
      const nodeSnapshot = await this.database.snapshot([
        DOMAIN_REPOSITORIES.domain('ContextSequenceNode').get(baseRootNodeId)
      ]);
      const node = requireRow(nodeSnapshot.snapshot[0], `ContextSequenceNode ${baseRootNodeId}`);
      const segmentId = requireId(node.segment_id, 'ContextSequenceNode.segment_id');
      const segmentSnapshot = await this.database.snapshot([
        DOMAIN_REPOSITORIES.domain('ContextSegment').get(segmentId)
      ]);
      const segment = requireRow(segmentSnapshot.snapshot[0], `ContextSegment ${segmentId}`);
      compression = segment.segment_kind === 'compression';
    }

    const metadataToRead = missingFacts.flatMap((fact) => [
      requireContentMetadata(fact.argumentMetadata, `ToolCall ${fact.toolCallId} arguments`),
      requireContentMetadata(fact.resultMetadata, `ToolModelResult ${fact.toolModelResultId} result`)
    ]);
    const content = await this.contentStore.readMany(metadataToRead);
    const pairBodies = missingFacts.map((fact, index) => toolPairContent(
      fact,
      content[index * 2],
      content[index * 2 + 1]
    ));
    const prepared = await this.contentStore.prepareBatch(
      this.database,
      pairBodies.map((body) => ({ content: body, contentType: CONTENT_TYPE_TOOL_PAIR }))
    );
    if (prepared.length !== missingFacts.length) {
      throw new Error('CAS tool-pair batch result length does not match the terminal prefix.');
    }

    const now = this.timestamp();
    let parentNodeId = baseRoot
      ? compression
        ? nullableId(baseRoot.tail_node_id, 'ContextSequenceRoot.tail_node_id')
        : baseRootNodeId
      : null;
    let previousRootId = baseRootId;
    let segmentCount = baseRoot
      ? requireBigInt(baseRoot.segment_count, 'ContextSequenceRoot.segment_count')
      : 0n;
    let estimatedTokens = baseRoot
      ? requireBigInt(baseRoot.estimated_tokens, 'ContextSequenceRoot.estimated_tokens')
      : 0n;
    let tailSegmentCount = baseRoot
      ? requireBigInt(baseRoot.tail_segment_count, 'ContextSequenceRoot.tail_segment_count')
      : 0n;
    const plans = missingFacts.map((fact, index) => {
      const nodeId = contextSequenceNodeId(parentNodeId, fact.segmentId);
      const rootId = stableId('context_root_append', conversationId, previousRootId ?? '<null>', nodeId);
      segmentCount += 1n;
      estimatedTokens += estimateTokens(prepared[index].metadata.byte_length);
      if (compression) tailSegmentCount += 1n;
      const plan = {
        fact,
        content: prepared[index],
        nodeId,
        parentNodeId,
        rootId,
        previousRootId,
        segmentCount,
        estimatedTokens,
        tailSegmentCount
      };
      parentNodeId = nodeId;
      previousRootId = rootId;
      return plan;
    });
    const finalRootId = plans[plans.length - 1].rootId;
    const steps: RepositoryTransactionStep[] = [
      ...headAssertionSteps(conversationId, head, expectedHeadRootId),
      ...preparedContentObjectSteps(prepared, 'context_tool_pair_content'),
      ...plans.flatMap((plan, index): RepositoryTransactionStep[] => [
        ...occurrenceInsertSteps({
          segmentId: plan.fact.segmentId,
          segmentKind: 'tool_pair',
          contentObjectId: plan.content.metadata.id,
          sources: plan.fact.sources,
          now
        }),
        ...nodeInsertSteps([{
          id: plan.nodeId,
          parentNodeId: plan.parentNodeId,
          segmentId: plan.fact.segmentId,
          now
        }], `context_tool_pair_node_${index}`),
        DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
          id: plan.rootId,
          conversation_id: conversationId,
          root_node_id: compression ? baseRootNodeId : plan.nodeId,
          tail_node_id: compression ? plan.nodeId : null,
          tail_segment_count: compression ? plan.tailSegmentCount : 0n,
          segment_count: plan.segmentCount,
          estimated_tokens: plan.estimatedTokens,
          created_at: now
        }, { column: 'root_seq', scope: { conversation_id: conversationId } })
      ]),
      ...headMutationSteps(conversationId, head, finalRootId, now)
    ];
    try {
      const commit = await this.database.transaction(steps);
      this.observeMetrics({
        kind: 'transaction',
        operation: 'tool_pair_batch',
        count: 1,
        toolPairCount: missingFacts.length
      });
      return {
        segmentIds: facts.map((fact) => fact.segmentId),
        rootId: finalRootId,
        commitSeq: commit.commitSeq,
        appendedCount: missingFacts.length,
        deduplicatedCount: facts.length - missingFacts.length,
        transactionCount: 1
      };
    } catch (error) {
      if (!isRecoverableAppendRace(error)) throw error;
      const raced = await this.database.snapshot(missingFacts.flatMap((fact): RepositoryRead[] => [
        DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
          where: { source_kind: 'tool_call', source_id: fact.toolCallId },
          limit: 1
        }),
        DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
          where: { source_kind: 'tool_model_result', source_id: fact.toolModelResultId },
          limit: 1
        })
      ]));
      const anyRacedOccurrence = raced.snapshot.some((value) => rows(value).length > 0);
      if (!anyRacedOccurrence) throw error;
      return this.appendToolPairsInOrderBatch(command);
    }
  }

  /**
   * Appends the chronological CALL occurrence of one durably admitted native ToolCall. The segment
   * is a native partial tool_pair (single tool_call source, native:true body); the matching result
   * occurrence is appended later by appendNativeToolResult, never by rewriting this segment.
   * Fencing follows the ambient AsyncLocalStorage convention: callers wrap live work in
   * runWithExecutionLeaseFence(captured) and the writer transaction asserts that full tuple
   * atomically (a newer replacement lease is never adopted). Without an ambient fence the append
   * runs the no-lease terminal closure branch: it asserts NO ExecutionLease for the Conversation
   * and a terminated originating Turn in the same transaction.
   */
  public async appendNativeToolCall(command: {
    conversationId: string;
    toolCallId: string;
    providerCallId?: string;
    baseRootId?: string | null;
    expectedHeadRootId?: string | null;
    activate?: boolean;
  }): Promise<ContextAppendResult> {
    const conversationId = requireId(command.conversationId, 'conversationId');
    const toolCallId = requireId(command.toolCallId, 'toolCallId');
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ToolCall').get(toolCallId),
      DOMAIN_REPOSITORIES.domain('ToolCallEvent').list({
        where: { tool_call_id: toolCallId, event_kind: TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').list({
        where: { tool_call_id: toolCallId },
        limit: 2
      })
    ]);
    const toolCall = requireRow(snapshot.snapshot[0], `ToolCall ${toolCallId}`);
    const admissionEvent = requireNativeAdmissionEvent(toolCallId, rows(snapshot.snapshot[1]));
    const sourceLinks = rows(snapshot.snapshot[2]);
    if (sourceLinks.length !== 1) {
      throw new Error(`Native ToolCall ${toolCallId} lacks its unique ToolCallSourceLink.`);
    }
    const turnId = requireId(toolCall.turn_id, 'ToolCall.turn_id');
    const related = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Turn').get(turnId),
      DOMAIN_REPOSITORIES.domain('ContentObject').get(
        requireId(toolCall.arguments_object_id, 'ToolCall.arguments_object_id')
      )
    ]);
    const turn = requireRow(related.snapshot[0], `Turn ${turnId}`);
    if (turn.conversation_id !== conversationId) throw new Error('ToolCall belongs to another Conversation.');
    const argumentMetadata = asContentObjectMetadata(requireRow(
      related.snapshot[1],
      `ContentObject ${String(toolCall.arguments_object_id)}`
    ));
    const admission = parseNativeAdmissionContent(
      JSON.parse((await this.contentStore.read(await this.eventContentMetadata(admissionEvent))).toString('utf8'))
    );
    if (command.providerCallId !== undefined && command.providerCallId !== admission.providerCallId) {
      throw new Error(`Native ToolCall ${toolCallId} provider call id conflicts with its durable admission.`);
    }
    await this.preflightAppendTarget(
      conversationId, command.baseRootId, command.expectedHeadRootId, command.activate !== false
    );
    const [argumentsBytes] = await this.contentStore.readMany([argumentMetadata]);
    const callSeq = requireBigInt(toolCall.call_seq, 'ToolCall.call_seq');
    const content = await this.contentStore.prepare(this.database, JSON.stringify({
      kind: 'tool_pair',
      native: true,
      toolCall: {
        id: toolCallId,
        providerCallId: admission.providerCallId,
        responseId: admission.responseId,
        async: admission.declaredAsync,
        callSeq: callSeq.toString(),
        toolName: requireText(toolCall.tool_name, 'ToolCall.tool_name'),
        argumentsContentType: argumentMetadata.content_type,
        arguments: argumentsBytes.toString('utf8'),
        ...(sourceLinks[0].thought_signature === null || sourceLinks[0].thought_signature === undefined
          ? {}
          : { thoughtSignature: requireText(sourceLinks[0].thought_signature, 'ToolCallSourceLink.thought_signature') }),
        ...(admission.outputItem ? { outputItem: admission.outputItem } : {})
      }
    }), CONTENT_TYPE_TOOL_PAIR);
    return this.appendOccurrence({
      conversationId,
      segmentKind: 'tool_pair',
      sources: [{ sourceKind: 'tool_call', sourceId: toolCallId, sourceRevision: callSeq }],
      content,
      baseRootId: command.baseRootId,
      expectedHeadRootId: command.expectedHeadRootId,
      activate: command.activate,
      nativePartialPair: 'tool_call',
      executionFence: { callTurnId: turnId }
    });
  }

  /**
   * Appends the chronological RESULT occurrence of one settled native ToolCall. Trigger contract:
   * (a) the Kernel delivery pump, on the checkpointed response.created that admits the matched
   * explicit result create (before the carrier's own output commits, never waiting on the network
   * inside onEvent) — so any intervening automatic successor output precedes the result; or (b)
   * the explicit switch/cancel/fork closure path for old-provider undelivered settlements. Never
   * the in-stream settlement path. Requires the call occurrence to exist already.
   * Fencing is the appendNativeToolCall ambient convention: an ambient captured lease fence is
   * asserted atomically (a fresh-Turn owner may close old settled facts with its own fence);
   * without one, the no-lease terminal closure branch applies.
   */
  public async appendNativeToolResult(command: {
    conversationId: string;
    toolCallId: string;
    toolModelResultId: string;
    baseRootId?: string | null;
    expectedHeadRootId?: string | null;
    activate?: boolean;
  }): Promise<ContextAppendResult> {
    const conversationId = requireId(command.conversationId, 'conversationId');
    const toolCallId = requireId(command.toolCallId, 'toolCallId');
    const toolModelResultId = requireId(command.toolModelResultId, 'toolModelResultId');
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ToolCall').get(toolCallId),
      DOMAIN_REPOSITORIES.domain('ToolModelResult').get(toolModelResultId),
      DOMAIN_REPOSITORIES.domain('ToolCallEvent').list({
        where: { tool_call_id: toolCallId, event_kind: TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
        where: { source_kind: 'tool_call', source_id: toolCallId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').list({
        where: { tool_call_id: toolCallId },
        limit: 2
      })
    ]);
    const toolCall = requireRow(snapshot.snapshot[0], `ToolCall ${toolCallId}`);
    const modelResult = requireRow(snapshot.snapshot[1], `ToolModelResult ${toolModelResultId}`);
    if (modelResult.tool_call_id !== toolCallId) throw new Error('ToolModelResult does not belong to ToolCall.');
    const admissionEvent = requireNativeAdmissionEvent(toolCallId, rows(snapshot.snapshot[2]));
    const callSources = rows(snapshot.snapshot[3]);
    if (callSources.length !== 1) {
      throw new Error(`Native ToolCall ${toolCallId} result occurrence requires its call occurrence first.`);
    }
    const sourceLinks = rows(snapshot.snapshot[4]);
    if (sourceLinks.length !== 1) {
      throw new Error(`Native ToolCall ${toolCallId} lacks its unique ToolCallSourceLink.`);
    }
    const callSeq = requireBigInt(toolCall.call_seq, 'ToolCall.call_seq');
    if (requireBigInt(callSources[0].source_revision, 'ContextSegmentSource.source_revision') !== callSeq) {
      throw new Error(`Native ToolCall ${toolCallId} call occurrence conflicts with its call_seq.`);
    }
    const turnId = requireId(toolCall.turn_id, 'ToolCall.turn_id');
    const resultRevisionId = requireId(modelResult.message_revision_id, 'ToolModelResult.message_revision_id');
    const related = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Turn').get(turnId),
      DOMAIN_REPOSITORIES.domain('MessageRevision').get(resultRevisionId),
      DOMAIN_REPOSITORIES.domain('ContentObject').get(
        requireId(toolCall.arguments_object_id, 'ToolCall.arguments_object_id')
      )
    ]);
    const turn = requireRow(related.snapshot[0], `Turn ${turnId}`);
    if (turn.conversation_id !== conversationId) throw new Error('ToolCall belongs to another Conversation.');
    const resultRevision = requireRow(related.snapshot[1], `MessageRevision ${resultRevisionId}`);
    const resultContentId = requireId(resultRevision.content_object_id, 'MessageRevision.content_object_id');
    const argumentMetadata = asContentObjectMetadata(requireRow(
      related.snapshot[2],
      `ContentObject ${String(toolCall.arguments_object_id)}`
    ));
    const resultMetadata = asContentObjectMetadata(
      await this.requireContentObjectMetadata(resultContentId)
    );
    const admission = parseNativeAdmissionContent(
      JSON.parse((await this.contentStore.read(await this.eventContentMetadata(admissionEvent))).toString('utf8'))
    );
    await this.preflightAppendTarget(
      conversationId, command.baseRootId, command.expectedHeadRootId, command.activate !== false
    );
    const [argumentsBytes, resultBytes] = await this.contentStore.readMany([argumentMetadata, resultMetadata]);
    const content = await this.contentStore.prepare(this.database, JSON.stringify({
      kind: 'tool_pair',
      native: true,
      toolCall: {
        id: toolCallId,
        providerCallId: admission.providerCallId,
        responseId: admission.responseId,
        async: admission.declaredAsync,
        callSeq: callSeq.toString(),
        toolName: requireText(toolCall.tool_name, 'ToolCall.tool_name'),
        argumentsContentType: argumentMetadata.content_type,
        arguments: argumentsBytes.toString('utf8'),
        ...(sourceLinks[0].thought_signature === null || sourceLinks[0].thought_signature === undefined
          ? {}
          : { thoughtSignature: requireText(sourceLinks[0].thought_signature, 'ToolCallSourceLink.thought_signature') }),
        ...(admission.outputItem ? { outputItem: admission.outputItem } : {})
      },
      toolModelResult: {
        id: toolModelResultId,
        messageRevisionId: resultRevisionId,
        resultContentType: resultMetadata.content_type,
        result: resultBytes.toString('utf8')
      }
    }), CONTENT_TYPE_TOOL_PAIR);
    return this.appendOccurrence({
      conversationId,
      segmentKind: 'tool_pair',
      sources: [{ sourceKind: 'tool_model_result', sourceId: toolModelResultId, sourceRevision: callSeq }],
      content,
      baseRootId: command.baseRootId,
      expectedHeadRootId: command.expectedHeadRootId,
      activate: command.activate,
      nativePartialPair: 'tool_model_result',
      executionFence: { callTurnId: turnId }
    });
  }

  /**
   * Read-only guard for an immutable Context prefix (fork/historical cut): every native call
   * occurrence inside the prefix must have its result occurrence inside the SAME prefix. Ordinary
   * atomic pairs are closed by construction. Throws NativeAsyncWorkPendingError naming the open
   * calls; never writes.
   */
  public async assertNativeContextClosed(rootIdInput: string, endSegmentIdInput?: string): Promise<void> {
    const rootId = requireId(rootIdInput, 'rootId');
    const endSegmentId = endSegmentIdInput === undefined ? undefined : requireId(endSegmentIdInput, 'endSegmentId');
    const structure = await this.materializeStructure(rootId);
    const prefixRecords: StructuralContextRecord[] = [];
    if (endSegmentId === undefined) {
      prefixRecords.push(...structure.records);
    } else {
      let found = false;
      for (const record of structure.records) {
        prefixRecords.push(record);
        if (record.segment.id === endSegmentId) {
          found = true;
          break;
        }
      }
      if (!found) throw new Error(`Context root ${rootId} does not contain end segment ${endSegmentId}.`);
    }
    await this.assertNativeSegmentsClosed(
      requireId(structure.root.conversation_id, 'ContextSequenceRoot.conversation_id'),
      prefixRecords
    );
  }

  /**
   * The same closure guard over an explicit segment list owned by one Conversation, such as a fork
   * prefix plus the late native results moved behind its cut. Calls outside the list (for example
   * a caller's still running Turn after the cut) are not part of the checked history.
   */
  public async assertNativeSegmentsClosed(
    conversationIdInput: string,
    records: readonly StructuralContextRecord[]
  ): Promise<void> {
    const conversationId = requireId(conversationIdInput, 'conversationId');
    const { openCalls, resultSources } = await this.scanNativePairs(conversationId, records);
    if (openCalls.size === 0 && resultSources.length === 0) return;
    const resultSnapshot = await this.database.snapshot(resultSources.map((source) =>
      DOMAIN_REPOSITORIES.domain('ToolModelResult').get(source.sourceId)
    ));
    for (const [index, source] of resultSources.entries()) {
      const result = requireRow(resultSnapshot.snapshot[index], `ToolModelResult ${source.sourceId}`);
      const ownerCallId = requireId(result.tool_call_id, 'ToolModelResult.tool_call_id');
      if (!openCalls.delete(ownerCallId)) {
        throw new Error(`Native ToolModelResult ${source.sourceId} has no call occurrence in this Context prefix.`);
      }
    }
    if (openCalls.size === 0) return;
    const pending: NativePendingWorkRef[] = [...openCalls.entries()].map(([toolCallId, segmentId]) => ({
      toolCallId,
      reason: `result occurrence missing in Context prefix (call segment ${segmentId})`
    }));
    throw new NativeAsyncWorkPendingError(
      pending,
      'Append the native result occurrences before cutting this Context prefix.'
    );
  }

  /**
   * Native results that settled after a fork cut: result occurrences, later in the same root, of
   * native calls whose call occurrence lies in the retained prefix `records[0..endIndex]`. A fork
   * moves them directly behind its cut instead of extending the cut over later history.
   */
  public async lateNativeResultSegmentIds(
    conversationIdInput: string,
    records: readonly StructuralContextRecord[],
    endIndex: number
  ): Promise<string[]> {
    const conversationId = requireId(conversationIdInput, 'conversationId');
    const prefix = records.slice(0, endIndex + 1);
    const { openCalls, resultSources } = await this.scanNativePairs(conversationId, prefix);
    if (openCalls.size === 0) return [];
    const closedInPrefix = new Set<string>();
    if (resultSources.length > 0) {
      const snapshot = await this.database.snapshot(resultSources.map((source) =>
        DOMAIN_REPOSITORIES.domain('ToolModelResult').get(source.sourceId)
      ));
      for (const [index, source] of resultSources.entries()) {
        closedInPrefix.add(requireId(
          requireRow(snapshot.snapshot[index], `ToolModelResult ${source.sourceId}`).tool_call_id,
          'ToolModelResult.tool_call_id'
        ));
      }
    }
    const later = new Map(records.slice(endIndex + 1).map((record, offset) => [
      requireId(record.segment.id, 'ContextSegment.id'), endIndex + 1 + offset
    ]));
    const moved: Array<{ segmentId: string; index: number }> = [];
    for (const toolCallId of openCalls.keys()) {
      if (closedInPrefix.has(toolCallId)) continue;
      const results = await listAllDomainRows(this.database, 'ToolModelResult', { tool_call_id: toolCallId });
      if (results.length !== 1) continue;
      const occurrences = await listAllDomainRows(this.database, 'ContextSegmentSource', {
        source_kind: 'tool_model_result',
        source_id: requireId(results[0].id, 'ToolModelResult.id')
      });
      if (occurrences.length !== 1) continue;
      const segmentId = requireId(occurrences[0].segment_id, 'ContextSegmentSource.segment_id');
      const index = later.get(segmentId);
      if (index !== undefined) moved.push({ segmentId, index });
    }
    return moved.sort((left, right) => left.index - right.index).map((entry) => entry.segmentId);
  }

  /** Content-addressed nodes that continue an immutable chain from `parentNodeId`. */
  public planSuffixNodes(
    parentNodeId: string,
    segmentIds: readonly string[],
    savepointName: string
  ): { nodeIds: string[]; steps: RepositoryTransactionStep[] } {
    const now = this.timestamp();
    const nodes: PlannedNode[] = [];
    let parent: string = requireId(parentNodeId, 'parentNodeId');
    for (const segmentId of segmentIds) {
      const id = contextSequenceNodeId(parent, segmentId);
      nodes.push({ id, parentNodeId: parent, segmentId: requireId(segmentId, 'segmentId'), now });
      parent = id;
    }
    return { nodeIds: nodes.map((node) => node.id), steps: nodeInsertSteps(nodes, savepointName) };
  }

  private async scanNativePairs(
    conversationId: string,
    records: readonly StructuralContextRecord[]
  ): Promise<{ openCalls: Map<string, string>; resultSources: ContextSourceOccurrence[] }> {
    const pairRecords = records.filter((record) => record.segment.segment_kind === 'tool_pair');
    if (pairRecords.length === 0) return { openCalls: new Map(), resultSources: [] };
    const sourceSnapshot = await this.database.snapshot(pairRecords.map((record) =>
      DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
        where: { segment_id: requireId(record.segment.id, 'ContextSegment.id') },
        orderBy: { column: 'id', direction: 'asc' },
        limit: 1000
      })
    ));
    const sourceGroups: DomainRow[][] = [];
    for (const [index, record] of pairRecords.entries()) {
      const first = rows(sourceSnapshot.snapshot[index]);
      sourceGroups.push(first.length < 1000 ? first : await listAllDomainRows(
        this.database, 'ContextSegmentSource', { segment_id: requireId(record.segment.id, 'ContextSegment.id') }
      ));
    }
    // Missing rows are expected: a deleted Conversation cascades its ToolCall/ToolModelResult/Turn
    // rows while the dataset-lifetime segment keeps that Conversation's source provenance.
    const readExistingByIds = async (domain: string, ids: string[]): Promise<Map<string, DomainRow>> => {
      const result = new Map<string, DomainRow>();
      const unique = [...new Set(ids)];
      for (let offset = 0; offset < unique.length; offset += 256) {
        const batch = unique.slice(offset, offset + 256);
        const snapshot = await this.database.snapshot(batch.map((id) => DOMAIN_REPOSITORIES.domain(domain).get(id)));
        batch.forEach((id, index) => {
          if (snapshot.snapshot[index] !== null) result.set(id, requireRow(snapshot.snapshot[index], `${domain} ${id}`));
        });
      }
      return result;
    };
    const allSources = sourceGroups.flat();
    const results = await readExistingByIds('ToolModelResult', allSources.filter((source) => source.source_kind === 'tool_model_result')
      .map((source) => requireId(source.source_id, 'ContextSegmentSource.source_id')));
    const calls = await readExistingByIds('ToolCall', [
      ...allSources.filter((source) => source.source_kind === 'tool_call')
        .map((source) => requireId(source.source_id, 'ContextSegmentSource.source_id')),
      ...[...results.values()].map((result) => requireId(result.tool_call_id, 'ToolModelResult.tool_call_id'))
    ]);
    const turns = await readExistingByIds('Turn', [...calls.values()].map((call) => requireId(call.turn_id, 'ToolCall.turn_id')));
    /** undefined: not a tool source kind; null: the owning Conversation was deleted. */
    const callForSource = (source: DomainRow): DomainRow | null | undefined => {
      if (source.source_kind === 'tool_call') return calls.get(requireId(source.source_id, 'ContextSegmentSource.source_id')) ?? null;
      if (source.source_kind === 'tool_model_result') {
        const result = results.get(requireId(source.source_id, 'ContextSegmentSource.source_id'));
        return result ? calls.get(requireId(result.tool_call_id, 'ToolModelResult.tool_call_id')) ?? null : null;
      }
      return undefined;
    };
    const openCalls = new Map<string, string>();
    const resultSources: ContextSourceOccurrence[] = [];
    for (const [index, record] of pairRecords.entries()) {
      // Forks add independent provenance to immutable shared segments. Scope through Call→Turn,
      // never choose an arbitrary pair or treat another Conversation's sources as duplicates.
      const scoped = sourceGroups[index].filter((source) => {
        const call = callForSource(source);
        if (call === undefined) return true; // Unknown kinds must still fail the shape check.
        if (call === null) return false;
        const turn = turns.get(requireId(call.turn_id, 'ToolCall.turn_id'));
        return turn !== undefined && turn.conversation_id === conversationId;
      });
      for (const source of scoped) {
        const call = callForSource(source);
        if (call !== undefined && call !== null && requireBigInt(call.call_seq, 'ToolCall.call_seq')
          !== requireBigInt(source.source_revision, 'ContextSegmentSource.source_revision')) {
          throw new Error('Context tool source revision does not match its ToolCall call_seq.');
        }
      }
      const shape = classifyToolPairSources(scoped.map(contextSourceOccurrence).sort((left, right) =>
        left.sourceKind.localeCompare(right.sourceKind)
      ));
      if (shape.kind === 'atomic') {
        if (results.get(shape.result.sourceId)!.tool_call_id !== shape.call.sourceId) {
          throw new Error('Context tool result does not belong to its paired ToolCall.');
        }
        continue;
      }
      if (shape.kind === 'native_call') {
        openCalls.set(shape.call.sourceId, requireId(record.segment.id, 'ContextSegment.id'));
      } else {
        resultSources.push(shape.result);
      }
    }
    return { openCalls, resultSources };
  }

  public async materializeStructure(rootId: string): Promise<MaterializedContextStructure> {
    const barrier = await this.database.materializeContext(requireId(rootId, 'rootId'));
    this.observeMetrics({ kind: 'materialize', mode: 'structure', count: 1 });
    return {
      root: barrier.snapshot.root,
      records: barrier.snapshot.records,
      snapshotCommitSeq: barrier.snapshotCommitSeq
    };
  }

  public async materialize(rootId: string): Promise<MaterializedContext> {
    const barrier = await this.database.materializeContextContent(requireId(rootId, 'rootId'));
    this.observeMetrics({ kind: 'materialize', mode: 'content', count: 1 });
    return {
      root: barrier.snapshot.root,
      segments: barrier.snapshot.records.map((record) => ({
        nodeId: requireId(record.node.id, 'ContextSequenceNode.id'),
        parentNodeId: nullableId(record.node.parent_node_id, 'ContextSequenceNode.parent_node_id'),
        segmentId: requireId(record.segment.id, 'ContextSegment.id'),
        segmentKind: requireSegmentKind(record.segment.segment_kind),
        messageRole: nullableText(record.messageRole, 'Context message role'),
        ...(record.modelSource ? { modelSource: record.modelSource } : {}),
        ...(record.sourceRecipeObjectId ? { sourceRecipeObjectId: record.sourceRecipeObjectId } : {}),
        ...(record.sourceClaudeThinkingBinding ? { sourceClaudeThinkingBinding: record.sourceClaudeThinkingBinding } : {}),
        contentObject: asContentObjectMetadata(record.contentObject),
        content: bufferView(record.content)
      })),
      snapshotCommitSeq: barrier.snapshotCommitSeq
    };
  }

  public async currentHeadRootId(conversationId: string): Promise<string | null> {
    const head = await this.getHead(requireId(conversationId, 'conversationId'));
    return head ? requireId(head.root_id, 'ConversationContextHeadLink.root_id') : null;
  }

  /**
   * Builds the first Message Context root for a Conversation that is created in the same writer
   * transaction. No database read is performed, so ChildExecution can atomically establish its
   * Conversation, first Turn, input Message, frozen Authority and Context head.
   */
  public prepareFreshConversationMessageMutation(
    input: FreshConversationMessageContextPlanInput
  ): FreshConversationMessageContextPlan {
    const conversationId = requireId(input.conversationId, 'conversationId');
    const revisionId = requireId(input.messageRevisionId, 'messageRevisionId');
    const contentObjectId = requireId(input.contentObjectId, 'contentObjectId');
    const contentByteLength = requireBigInt(input.contentByteLength, 'contentByteLength');
    if (contentByteLength < 0n) throw new TypeError('contentByteLength must be non-negative.');
    const contentEstimatedTokens = optionalEstimatedTokens(input.contentEstimatedTokens)
      ?? estimateTokens(contentByteLength);
    const segmentId = stableSegmentId([{
      sourceKind: 'message_revision', sourceId: revisionId, sourceRevision: 0n
    }]);
    const now = this.timestamp();
    const inheritedNodes: PlannedNode[] = [];
    let parentNodeId: string | null = null;
    let inheritedTokens = 0n;
    for (const inherited of input.inheritedSegments ?? []) {
      const inheritedId = requireId(inherited.segmentId, 'inheritedSegment.segmentId');
      inheritedTokens += optionalEstimatedTokens(inherited.estimatedTokens)!;
      const inheritedNodeId = contextSequenceNodeId(parentNodeId, inheritedId);
      inheritedNodes.push({ id: inheritedNodeId, parentNodeId, segmentId: inheritedId, now });
      parentNodeId = inheritedNodeId;
    }
    const nodeId = contextSequenceNodeId(parentNodeId, segmentId);
    const rootId = stableId('context_root_append', conversationId, '<null>', nodeId);
    const headLinkId = stableId('conversation_context_head', conversationId);
    return {
      rootId,
      headLinkId,
      steps: [
        DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').assertNone({ conversation_id: conversationId }),
        ...messageOccurrenceWithAllocatedRevisionSteps({
          segmentId,
          revisionId,
          contentObjectId,
          now
        }),
        ...nodeInsertSteps([...inheritedNodes, { id: nodeId, parentNodeId, segmentId, now }], 'fresh_message_context_node'),
        DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
          id: rootId,
          conversation_id: conversationId,
          root_node_id: nodeId,
          tail_node_id: null,
          tail_segment_count: 0n,
          segment_count: BigInt(inheritedNodes.length) + 1n,
          estimated_tokens: inheritedTokens + contentEstimatedTokens,
          created_at: now
        }, { column: 'root_seq', scope: { conversation_id: conversationId } }),
        DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').insert({
          id: headLinkId,
          conversation_id: conversationId,
          root_id: rootId,
          updated_at: now
        })
      ]
    };
  }

  /** Prepared steps attach a new or already committed MessageRevision atomically with caller state. */
  public async prepareMessageAppendMutation(input: MessageContextAppendPlanInput): Promise<ContextMutationPlan> {
    const conversationId = requireId(input.conversationId, 'conversationId');
    const revisionId = requireId(input.messageRevisionId, 'messageRevisionId');
    const contentObjectId = requireId(input.contentObjectId, 'contentObjectId');
    const existingRevisionSeq = input.existingRevisionSeq === undefined
      ? undefined
      : requireBigInt(input.existingRevisionSeq, 'existingRevisionSeq');
    if (existingRevisionSeq !== undefined && existingRevisionSeq < 1n) {
      throw new TypeError('existingRevisionSeq must be positive.');
    }
    const contentByteLength = requireBigInt(input.contentByteLength, 'contentByteLength');
    if (contentByteLength < 0n) throw new TypeError('contentByteLength must be non-negative.');
    const contentEstimatedTokens = optionalEstimatedTokens(input.contentEstimatedTokens)
      ?? estimateTokens(contentByteLength);
    const resultingEstimatedTokens = optionalEstimatedTokens(input.resultingEstimatedTokens);
    const head = await this.getHead(conversationId);
    const baseRootId = head ? requireId(head.root_id, 'ConversationContextHeadLink.root_id') : null;
    const base = await this.readBaseShape(conversationId, baseRootId);
    const segmentId = stableSegmentId([{
      sourceKind: 'message_revision', sourceId: revisionId, sourceRevision: 0n
    }]);
    const parentNodeId = base.compression ? base.tailNodeId : base.rootNodeId;
    const nodeId = contextSequenceNodeId(parentNodeId, segmentId);
    const rootId = stableId('context_root_append', conversationId, baseRootId ?? '<null>', nodeId);
    const now = this.timestamp();
    return {
      steps: [
        ...headAssertionSteps(conversationId, head, baseRootId),
        ...(existingRevisionSeq === undefined ? [] : [
          DOMAIN_REPOSITORIES.domain('MessageRevision').assert(revisionId, {
            revision_seq: existingRevisionSeq,
            content_object_id: contentObjectId
          })
        ]),
        ...messageOccurrenceWithAllocatedRevisionSteps({
          segmentId,
          revisionId,
          existingRevisionSeq,
          contentObjectId,
          now
        }),
        ...nodeInsertSteps([{ id: nodeId, parentNodeId, segmentId, now }], 'message_append_nodes'),
        DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
          id: rootId,
          conversation_id: conversationId,
          root_node_id: base.compression ? base.rootNodeId : nodeId,
          tail_node_id: base.compression ? nodeId : null,
          tail_segment_count: base.compression ? base.tailSegmentCount + 1n : 0n,
          segment_count: base.segmentCount + 1n,
          estimated_tokens: resultingEstimatedTokens ?? (base.estimatedTokens + contentEstimatedTokens),
          created_at: now
        }, { column: 'root_seq', scope: { conversation_id: conversationId } }),
        ...headMutationSteps(conversationId, head, rootId, now)
      ]
    };
  }

  /** Shares the immutable prefix and rebuilds only the suffix after the edited occurrence. */
  public async prepareMessageEditMutation(input: MessageContextEditPlanInput): Promise<ContextMutationPlan> {
    const conversationId = requireId(input.conversationId, 'conversationId');
    const previousRevisionId = requireId(input.previousMessageRevisionId, 'previousMessageRevisionId');
    const nextRevisionId = requireId(input.nextMessageRevisionId, 'nextMessageRevisionId');
    const contentObjectId = requireId(input.contentObjectId, 'contentObjectId');
    const state = await this.currentStructuralState(conversationId);
    const sourceRow = await this.findMessageSource(previousRevisionId);
    if (!sourceRow) {
      throw new Error(`MessageRevision ${previousRevisionId} has no Context occurrence.`);
    }
    const sourceSegmentId = requireId(sourceRow.segment_id, 'ContextSegmentSource.segment_id');
    const targetIndex = state.records.findIndex((record) => record.segment.id === sourceSegmentId);
    if (targetIndex < 0) {
      const expanded = await this.expandCurrentCompressionForTarget(state, sourceSegmentId);
      if (expanded) {
        return this.prepareExpandedCompressionMessageMutation({
          kind: 'edit',
          conversationId,
          state,
          expanded,
          targetSegmentId: sourceSegmentId,
          rootId: stableId('context_root_edit', conversationId, state.rootId, previousRevisionId, nextRevisionId),
          nextRevisionId,
          contentObjectId,
          contentByteLength: input.contentByteLength
        });
      }
      throw new Error(`MessageRevision ${previousRevisionId} is not part of the current Context head.`);
    }
    const source: ContextSourceOccurrence = {
      sourceKind: 'message_revision', sourceId: nextRevisionId, sourceRevision: 0n
    };
    const segmentId = stableSegmentId([source]);
    const now = this.timestamp();
    const rebuilt = rebuildSuffix(state.records, targetIndex, { replacementSegmentId: segmentId, now });
    const rootId = stableId('context_root_edit', conversationId, state.rootId, previousRevisionId, nextRevisionId);
    const compression = state.records[0]?.segment.segment_kind === 'compression';
    return {
      steps: [
        ...headAssertionSteps(conversationId, state.head, state.rootId),
        ...messageOccurrenceWithAllocatedRevisionSteps({
          segmentId,
          revisionId: nextRevisionId,
          contentObjectId,
          now
        }),
        ...nodeInsertSteps(rebuilt.nodes, 'message_edit_nodes'),
        DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
          id: rootId,
          conversation_id: conversationId,
          root_node_id: compression ? requireId(state.root.root_node_id, 'ContextSequenceRoot.root_node_id') : rebuilt.lastNodeId,
          tail_node_id: compression ? rebuilt.lastNodeId : null,
          tail_segment_count: compression
            ? requireBigInt(state.root.tail_segment_count, 'ContextSequenceRoot.tail_segment_count')
            : 0n,
          segment_count: requireBigInt(state.root.segment_count, 'ContextSequenceRoot.segment_count'),
          estimated_tokens: requireBigInt(state.root.estimated_tokens, 'ContextSequenceRoot.estimated_tokens'),
          created_at: now
        }, { column: 'root_seq', scope: { conversation_id: conversationId } }),
        ...headMutationSteps(conversationId, state.head, rootId, now)
      ]
    };
  }

  /**
   * Truncates the current Context at one Message occurrence. The target and every structural
   * segment after it (including tool pairs and runtime context) disappear from the new head.
   * An optional replacement is appended at the exact boundary for edit-and-rerun.
   */
  public async prepareMessageTruncateMutation(input: MessageContextTruncatePlanInput): Promise<ContextMutationPlan> {
    const conversationId = requireId(input.conversationId, 'conversationId');
    const revisionId = requireId(input.messageRevisionId, 'messageRevisionId');
    const idempotencyKey = requireText(input.idempotencyKey, 'idempotencyKey');
    const replacement = input.replacement
      ? {
          messageRevisionId: requireId(input.replacement.messageRevisionId, 'replacement.messageRevisionId'),
          contentObjectId: requireId(input.replacement.contentObjectId, 'replacement.contentObjectId'),
          contentByteLength: requireBigInt(
            input.replacement.contentByteLength,
            'replacement.contentByteLength'
          ),
          contentEstimatedTokens: optionalEstimatedTokens(
            input.replacement.contentEstimatedTokens
          )!
        }
      : null;
    if (replacement && replacement.contentByteLength < 0n) {
      throw new TypeError('replacement.contentByteLength must be non-negative.');
    }
    const state = await this.currentStructuralState(conversationId);
    const sourceRow = await this.findMessageSource(revisionId);
    if (!sourceRow) {
      throw new Error(`MessageRevision ${revisionId} has no Context occurrence.`);
    }
    const sourceSegmentId = requireId(sourceRow.segment_id, 'ContextSegmentSource.segment_id');
    const targetIndex = state.records.findIndex((record) => record.segment.id === sourceSegmentId);
    let prefix: EditableContextSegment[];
    let blocks: DomainRow[] = [];
    if (targetIndex >= 0) {
      prefix = state.records.slice(0, targetIndex).map((record) => ({
        segment: record.segment,
        contentObject: record.contentObject
      }));
    } else {
      const expanded = await this.expandCurrentCompressionForTarget(state, sourceSegmentId);
      if (!expanded) {
        throw new Error(`MessageRevision ${revisionId} is not part of the current Context head.`);
      }
      const expandedTargetIndex = expanded.segments.findIndex((record) =>
        record.segment.id === sourceSegmentId
      );
      if (expandedTargetIndex < 0) {
        throw new Error('Expanded compression lineage does not contain the truncation target.');
      }
      prefix = expanded.segments.slice(0, expandedTargetIndex);
      blocks = expanded.blocks;
    }

    let estimatedTokens = await this.estimateEditableContextTokens(prefix);
    const now = this.timestamp();
    let replacementSegmentId: string | null = null;
    const occurrenceSteps: RepositoryTransactionStep[] = [];
    if (replacement) {
      replacementSegmentId = stableSegmentId([{
        sourceKind: 'message_revision',
        sourceId: replacement.messageRevisionId,
        sourceRevision: 0n
      }]);
      occurrenceSteps.push(...messageOccurrenceWithAllocatedRevisionSteps({
        segmentId: replacementSegmentId,
        revisionId: replacement.messageRevisionId,
        contentObjectId: replacement.contentObjectId,
        now
      }));
      prefix.push({
        segment: { id: replacementSegmentId, segment_kind: 'message' },
        contentObject: { byte_length: replacement.contentByteLength }
      });
      estimatedTokens += replacement.contentEstimatedTokens;
    }

    const retainedSummary = prefix[0]?.segment.segment_kind === 'compression' ? prefix[0] : null;
    const tailSegments = retainedSummary ? prefix.slice(1) : prefix;
    const nodes = buildSequenceNodes(
      tailSegments.map((record) => requireId(record.segment.id, 'ContextSegment.id')),
      now
    );
    const summaryNodeId = retainedSummary
      ? contextSequenceNodeId(null, requireId(retainedSummary.segment.id, 'retained compression segment id'))
      : null;
    const blockSteps = uniqueRows(blocks).flatMap((block) => {
      if (block.status !== 'enabled') return [];
      const blockId = requireId(block.id, 'CompressionBlock.id');
      return [
        DOMAIN_REPOSITORIES.domain('CompressionBlock').assert(blockId, { status: 'enabled' }),
        DOMAIN_REPOSITORIES.domain('CompressionBlock').update(blockId, {
          status: 'disabled', updated_at: now
        })
      ];
    });
    const rootId = stableId(
      'context_root_truncate',
      conversationId,
      state.rootId,
      revisionId,
      replacement?.messageRevisionId ?? '<delete>',
      idempotencyKey
    );
    return {
      steps: [
        ...headAssertionSteps(conversationId, state.head, state.rootId),
        ...occurrenceSteps,
        ...nodeInsertSteps(nodes, 'message_truncate_nodes'),
        ...(retainedSummary ? [DOMAIN_REPOSITORIES.domain('ContextSequenceNode').assert(
          requireId(summaryNodeId, 'retained compression node id'),
          {
            parent_node_id: null,
            segment_id: requireId(retainedSummary.segment.id, 'retained compression segment id')
          }
        )] : []),
        ...blockSteps,
        DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
          id: rootId,
          conversation_id: conversationId,
          root_node_id: retainedSummary
            ? summaryNodeId
            : nodes.length ? nodes[nodes.length - 1].id : null,
          tail_node_id: retainedSummary && nodes.length ? nodes[nodes.length - 1].id : null,
          tail_segment_count: retainedSummary ? BigInt(nodes.length) : 0n,
          segment_count: BigInt(prefix.length),
          estimated_tokens: estimatedTokens,
          created_at: now
        }, { column: 'root_seq', scope: { conversation_id: conversationId } }),
        ...headMutationSteps(conversationId, state.head, rootId, now)
      ]
    };
  }

  /** Deletion is a semantic delete-from operation, not removal of one projected Message row. */
  public async prepareMessageDeleteMutation(input: MessageContextDeletePlanInput): Promise<ContextMutationPlan> {
    return this.prepareMessageTruncateMutation(input);
  }

  /**
   * Startup integrity maintenance for roots produced by the former per-Message delete loop.
   * It removes only explicit tool-pair segments whose source model Message is soft-deleted,
   * preserving every later valid segment. Active Conversations are left untouched.
   */
  public async repairOrphanToolPairs(signal?: AbortSignal): Promise<ContextOrphanToolPairRepairReport> {
    signal?.throwIfAborted();
    const heads = await listAllDomainRows(this.database, 'ConversationContextHeadLink');
    let conversationsRepaired = 0;
    let removedToolPairs = 0;
    for (const observedHead of heads) {
      signal?.throwIfAborted();
      const conversationId = requireId(observedHead.conversation_id, 'ConversationContextHeadLink.conversation_id');
      const activity = await this.database.snapshot([
        DOMAIN_REPOSITORIES.domain('ExecutionLease').list({
          where: { conversation_id: conversationId },
          limit: 1
        }),
        DOMAIN_REPOSITORIES.domain('Turn').list({
          where: { conversation_id: conversationId, status: 'active' },
          limit: 1
        })
      ]);
      if (rows(activity.snapshot[0]).length > 0 || rows(activity.snapshot[1]).length > 0) continue;
      const state = await this.currentStructuralState(conversationId);
      const removedSegmentIds = new Set<string>();
      const ownerAssertions: RepositoryTransactionStep[] = [];
      for (const record of state.records) {
        signal?.throwIfAborted();
        if (record.segment.segment_kind !== 'tool_pair') continue;
        const segmentId = requireId(record.segment.id, 'ContextSegment.id');
        const sourceSnapshot = await this.database.snapshotAll(
          DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
            where: { segment_id: segmentId },
            orderBy: { column: 'id', direction: 'asc' },
            limit: 1000
          })
        );
        // Atomic pairs and native partial occurrences share one owner rule: the assistant Message
        // that produced the call. A native result-only segment resolves its owner through the
        // persisted ToolModelResult instead of a call source on the same segment.
        const shape = classifyToolPairSources(sourceSnapshot.snapshot.map(contextSourceOccurrence));
        const ownerCallIds: string[] = [];
        if (shape.kind === 'native_result') {
          const resultSnapshot = await this.database.snapshot([
            DOMAIN_REPOSITORIES.domain('ToolModelResult').get(shape.result.sourceId)
          ]);
          const result = resultSnapshot.snapshot[0] as DomainRow | null;
          if (!result) {
            removedSegmentIds.add(segmentId);
            continue;
          }
          ownerCallIds.push(requireId(result.tool_call_id, 'ToolModelResult.tool_call_id'));
        } else {
          ownerCallIds.push(shape.call.sourceId);
        }
        let hasLiveOwner = false;
        const deletedOwners: Array<{ id: string; deletedAt: string }> = [];
        for (const toolCallId of ownerCallIds) {
          const linkSnapshot = await this.database.snapshot([
            DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').list({
              where: { tool_call_id: toolCallId },
              limit: 2
            })
          ]);
          const links = rows(linkSnapshot.snapshot[0]);
          if (links.length !== 1) continue;
          const ownerMessageId = requireId(links[0].message_id, 'ToolCallSourceLink.message_id');
          const ownerSnapshot = await this.database.snapshot([
            DOMAIN_REPOSITORIES.domain('Message').get(ownerMessageId)
          ]);
          const owner = ownerSnapshot.snapshot[0] as DomainRow | null;
          if (owner?.deleted_at === null) {
            hasLiveOwner = true;
            break;
          }
          if (owner?.deleted_at) {
            deletedOwners.push({
              id: ownerMessageId,
              deletedAt: requireText(owner.deleted_at, 'Message.deleted_at')
            });
          }
        }
        if (hasLiveOwner) continue;
        removedSegmentIds.add(segmentId);
        ownerAssertions.push(...deletedOwners.map((owner) =>
          DOMAIN_REPOSITORIES.domain('Message').assert(owner.id, { deleted_at: owner.deletedAt })
        ));
      }
      if (removedSegmentIds.size === 0) continue;

      const retained = state.records.filter((record) =>
        !removedSegmentIds.has(requireId(record.segment.id, 'ContextSegment.id'))
      );
      const retainedSummary = retained[0]?.segment.segment_kind === 'compression' ? retained[0] : null;
      const tailRecords = retainedSummary ? retained.slice(1) : retained;
      const now = this.timestamp();
      const nodes = buildSequenceNodes(
        tailRecords.map((record) => requireId(record.segment.id, 'ContextSegment.id')),
        now
      );
      const summaryNodeId = retainedSummary
        ? contextSequenceNodeId(null, requireId(retainedSummary.segment.id, 'retained compression segment id'))
        : null;
      const rootId = stableId(
        'context_root_repair_orphan_tool_pairs',
        conversationId,
        state.rootId,
        ...[...removedSegmentIds].sort()
      );
      const estimatedTokens = retained.reduce((total, record) =>
        total + estimateTokens(requireBigInt(record.contentObject.byte_length, 'ContentObject.byte_length')),
      0n);
      try {
        await this.database.transaction([
          DOMAIN_REPOSITORIES.domain('ExecutionLease').assertNone({ conversation_id: conversationId }),
          DOMAIN_REPOSITORIES.domain('Turn').assertNone({
            conversation_id: conversationId,
            status: 'active'
          }),
          ...headAssertionSteps(conversationId, state.head, state.rootId),
          ...ownerAssertions,
          ...nodeInsertSteps(nodes, 'repair_orphan_tool_pair_nodes'),
          ...(retainedSummary ? [DOMAIN_REPOSITORIES.domain('ContextSequenceNode').assert(
            requireId(summaryNodeId, 'retained compression node id'),
            {
              parent_node_id: null,
              segment_id: requireId(retainedSummary.segment.id, 'retained compression segment id')
            }
          )] : []),
          DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
            id: rootId,
            conversation_id: conversationId,
            root_node_id: retainedSummary
              ? summaryNodeId
              : nodes.length ? nodes[nodes.length - 1].id : null,
            tail_node_id: retainedSummary && nodes.length ? nodes[nodes.length - 1].id : null,
            tail_segment_count: retainedSummary ? BigInt(nodes.length) : 0n,
            segment_count: BigInt(retained.length),
            estimated_tokens: estimatedTokens,
            created_at: now
          }, { column: 'root_seq', scope: { conversation_id: conversationId } }),
          ...headMutationSteps(conversationId, state.head, rootId, now),
          DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
        ]);
        this.observeMetrics({ kind: 'transaction', operation: 'repair', count: 1 });
      } catch (error) {
        // Background startup maintenance may race a real user Turn after the VS Code surface is
        // already usable. The exact head/activity assertions are the authority: losing that CAS
        // means this observed root is stale and must be left to the live mutation or next scan.
        if (!isRecoverableAppendRace(error)) throw error;
        continue;
      }
      conversationsRepaired += 1;
      removedToolPairs += removedSegmentIds.size;
    }
    return {
      conversationsScanned: heads.length,
      conversationsRepaired,
      removedToolPairs
    };
  }

  private async prepareExpandedCompressionMessageMutation(input: {
    kind: 'edit' | 'delete';
    conversationId: string;
    state: Awaited<ReturnType<ContextSequenceControlPlane['currentStructuralState']>>;
    expanded: ExpandedCompressionContext;
    targetSegmentId: string;
    rootId: string;
    nextRevisionId?: string;
    contentObjectId?: string;
    contentByteLength?: bigint;
  }): Promise<ContextMutationPlan> {
    const targetIndex = input.expanded.segments.findIndex((record) =>
      record.segment.id === input.targetSegmentId
    );
    if (targetIndex < 0) throw new Error('Expanded compression lineage does not contain the target segment.');
    const now = this.timestamp();
    let replacementSegmentId: string | null = null;
    const occurrenceSteps: RepositoryTransactionStep[] = [];
    if (input.kind === 'edit') {
      const nextRevisionId = requireId(input.nextRevisionId, 'nextRevisionId');
      const contentObjectId = requireId(input.contentObjectId, 'contentObjectId');
      replacementSegmentId = stableSegmentId([{
        sourceKind: 'message_revision', sourceId: nextRevisionId, sourceRevision: 0n
      }]);
      occurrenceSteps.push(...messageOccurrenceWithAllocatedRevisionSteps({
        segmentId: replacementSegmentId,
        revisionId: nextRevisionId,
        contentObjectId,
        now
      }));
    }
    const finalSegments: EditableContextSegment[] = [
      ...input.expanded.segments.slice(0, targetIndex),
      ...(replacementSegmentId ? [{
        segment: { id: replacementSegmentId, segment_kind: 'message' },
        contentObject: {
          byte_length: requireBigInt(input.contentByteLength, 'contentByteLength')
        }
      }] : []),
      ...input.expanded.segments.slice(targetIndex + 1)
    ];
    const retainedSummary = finalSegments[0]?.segment.segment_kind === 'compression'
      ? finalSegments[0]
      : null;
    const tailSegments = retainedSummary ? finalSegments.slice(1) : finalSegments;
    const nodes = buildSequenceNodes(
      tailSegments.map((record) => requireId(record.segment.id, 'ContextSegment.id')),
      now
    );
    const summaryNodeId = retainedSummary
      ? contextSequenceNodeId(null, requireId(retainedSummary.segment.id, 'retained compression segment id'))
      : null;
    const estimatedTokens = finalSegments.reduce((total, record) =>
      total + estimateTokens(requireBigInt(record.contentObject.byte_length, 'ContentObject.byte_length')),
    0n);
    const blockSteps = uniqueRows(input.expanded.blocks).flatMap((block) => {
      if (block.status !== 'enabled') return [];
      const blockId = requireId(block.id, 'CompressionBlock.id');
      return [
        DOMAIN_REPOSITORIES.domain('CompressionBlock').assert(blockId, { status: 'enabled' }),
        DOMAIN_REPOSITORIES.domain('CompressionBlock').update(blockId, {
          status: 'disabled', updated_at: now
        })
      ];
    });
    return {
      steps: [
        ...headAssertionSteps(input.conversationId, input.state.head, input.state.rootId),
        ...occurrenceSteps,
        ...nodeInsertSteps(nodes, `compressed_message_${input.kind}_nodes`),
        ...(retainedSummary ? [DOMAIN_REPOSITORIES.domain('ContextSequenceNode').assert(
          requireId(summaryNodeId, 'retained compression node id'),
          {
            parent_node_id: null,
            segment_id: requireId(retainedSummary.segment.id, 'retained compression segment id')
          }
        )] : []),
        ...blockSteps,
        DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
          id: input.rootId,
          conversation_id: input.conversationId,
          root_node_id: retainedSummary
            ? summaryNodeId
            : nodes.length ? nodes[nodes.length - 1].id : null,
          tail_node_id: retainedSummary && nodes.length ? nodes[nodes.length - 1].id : null,
          tail_segment_count: retainedSummary ? BigInt(nodes.length) : 0n,
          segment_count: BigInt(finalSegments.length),
          estimated_tokens: estimatedTokens,
          created_at: now
        }, { column: 'root_seq', scope: { conversation_id: input.conversationId } }),
        ...headMutationSteps(input.conversationId, input.state.head, input.rootId, now)
      ]
    };
  }

  private async expandCurrentCompressionForTarget(
    state: Awaited<ReturnType<ContextSequenceControlPlane['currentStructuralState']>>,
    targetSegmentId: string
  ): Promise<ExpandedCompressionContext | null> {
    const summary = state.records[0];
    if (!summary || summary.segment.segment_kind !== 'compression') return null;
    const expanded = await this.expandCompressionSegmentForTarget(
      requireId(summary.segment.id, 'ContextSegment.id'),
      targetSegmentId,
      requireId(state.root.conversation_id, 'ContextSequenceRoot.conversation_id'),
      new Set()
    );
    if (!expanded.containsTarget) return null;
    return {
      segments: [
        ...expanded.segments,
        ...state.records.slice(1).map((record) => ({
          segment: record.segment,
          contentObject: record.contentObject
        }))
      ],
      blocks: expanded.blocks
    };
  }

  private async expandCompressionSegmentForTarget(
    segmentId: string,
    targetSegmentId: string,
    conversationId: string,
    path: ReadonlySet<string>
  ): Promise<CompressionExpansion> {
    const current = await this.readEditableSegment(segmentId);
    if (segmentId === targetSegmentId) {
      return { containsTarget: true, segments: [current], blocks: [] };
    }
    if (current.segment.segment_kind !== 'compression') {
      return { containsTarget: false, segments: [current], blocks: [] };
    }
    if (path.has(segmentId)) throw new Error(`Compression lineage cycle detected at ${segmentId}.`);
    // Edits inside a compressed range disable only this Conversation's own block over the
    // shared summary segment, never the source's or another fork's block.
    const block = await resolveConversationCompressionBlock(this.database, segmentId, conversationId);
    const blockId = requireId(block.id, 'CompressionBlock.id');
    const sourceRows = await this.database.snapshotAll(
      DOMAIN_REPOSITORIES.domain('CompressionBlockSource').list({
        where: { compression_block_id: blockId },
        orderBy: { column: 'id', direction: 'asc' },
        limit: 1000
      })
    );
    const ordered = [...sourceRows.snapshot].sort(compareCompressionSourcePosition);
    ordered.forEach((row, position) => {
      if (requireBigInt(row.position, 'CompressionBlockSource.position') !== BigInt(position)) {
        throw new Error(`CompressionBlock ${blockId} source positions are not contiguous.`);
      }
    });
    if (!ordered.length) throw new Error(`CompressionBlock ${blockId} has no registered sources.`);
    const nextPath = new Set(path);
    nextPath.add(segmentId);
    const children = await Promise.all(ordered.map((row) => this.expandCompressionSegmentForTarget(
      requireId(row.segment_id, 'CompressionBlockSource.segment_id'),
      targetSegmentId,
      conversationId,
      nextPath
    )));
    if (!children.some((child) => child.containsTarget)) {
      return { containsTarget: false, segments: [current], blocks: [] };
    }
    return {
      containsTarget: true,
      segments: children.flatMap((child) => child.segments),
      blocks: [block, ...children.flatMap((child) => child.blocks)]
    };
  }

  private async estimateEditableContextTokens(records: readonly EditableContextSegment[]): Promise<bigint> {
    if (records.length === 0) return 0n;
    const metadata = records.map((record) => asContentObjectMetadata(record.contentObject));
    const content = await this.contentStore.readMany(metadata);
    return BigInt(projectStoredModelFacingWindow(records.map((record, index) => ({
      segmentKind: requireSegmentKind(record.segment.segment_kind),
      messageRole: null,
      contentType: metadata[index].content_type,
      content: content[index].toString('utf8')
    }))).tokenCount);
  }

  private async readEditableSegment(segmentId: string): Promise<EditableContextSegment> {
    const segment = await this.getOptional('ContextSegment', segmentId);
    if (!segment) throw new Error(`ContextSegment ${segmentId} does not exist.`);
    const contentObjectId = requireId(segment.content_object_id, 'ContextSegment.content_object_id');
    const contentObject = await this.getOptional('ContentObject', contentObjectId);
    if (!contentObject) throw new Error(`ContentObject ${contentObjectId} does not exist.`);
    return { segment, contentObject };
  }

  private async currentStructuralState(conversationId: string): Promise<{
    head: DomainRow;
    rootId: string;
    root: DomainRow;
    records: StructuralContextRecord[];
  }> {
    const head = await this.getHead(conversationId);
    if (!head) throw new Error(`Conversation ${conversationId} has no Context head.`);
    const rootId = requireId(head.root_id, 'ConversationContextHeadLink.root_id');
    const materialized = await this.materializeStructure(rootId);
    if (materialized.root.conversation_id !== conversationId) {
      throw new Error(`Context head ${rootId} belongs to another Conversation.`);
    }
    return { head, rootId, root: materialized.root, records: materialized.records };
  }

  private async findMessageSource(revisionId: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
        where: { source_kind: 'message_revision', source_id: revisionId },
        limit: 1
      })
    ]);
    return rows(snapshot.snapshot[0])[0] ?? null;
  }

  private async preflightAppendTarget(
    conversationId: string,
    baseRootIdInput: string | null | undefined,
    expectedHeadRootIdInput: string | null | undefined,
    activate: boolean
  ): Promise<void> {
    const head = await this.getHead(conversationId);
    const currentHeadRootId = head ? requireId(head.root_id, 'ConversationContextHeadLink.root_id') : null;
    const expectedHeadRootId = expectedHeadRootIdInput === undefined
      ? currentHeadRootId
      : nullableId(expectedHeadRootIdInput, 'expectedHeadRootId');
    if (activate && currentHeadRootId !== expectedHeadRootId) throw staleHeadError(conversationId);
    const baseRootId = baseRootIdInput === undefined
      ? expectedHeadRootId
      : nullableId(baseRootIdInput, 'baseRootId');
    await this.readBaseShape(conversationId, baseRootId);
  }

  private async appendOccurrence(planInput: AppendOccurrencePlan): Promise<ContextAppendResult> {
    const conversationId = requireId(planInput.conversationId, 'conversationId');
    const sources = normalizeSources(planInput.sources);
    const segmentKind = requireSegmentKind(planInput.segmentKind);
    if (planInput.nativePartialPair === undefined) {
      validateNewContextSegmentSources(segmentKind, sources);
    } else if (
      segmentKind !== 'tool_pair'
      || sources.length !== 1
      || sources[0].sourceKind !== planInput.nativePartialPair
    ) {
      throw new Error('Native partial tool_pair construction requires its single declared source.');
    }
    const fenceSteps = nativeExecutionFenceSteps(planInput.executionFence, conversationId);
    const activate = planInput.activate !== false;
    const head = await this.getHead(conversationId);
    const currentHeadRootId = head ? requireId(head.root_id, 'ConversationContextHeadLink.root_id') : null;
    const expectedHeadRootId = planInput.expectedHeadRootId === undefined
      ? currentHeadRootId
      : nullableId(planInput.expectedHeadRootId, 'expectedHeadRootId');
    const baseRootId = planInput.baseRootId === undefined
      ? expectedHeadRootId
      : nullableId(planInput.baseRootId, 'baseRootId');
    const base = await this.readBaseShape(conversationId, baseRootId);
    const segmentId = stableSegmentId(sources);
    const parentNodeId = base.compression ? base.tailNodeId : base.rootNodeId;
    const nodeId = contextSequenceNodeId(parentNodeId, segmentId);
    const rootId = stableId('context_root_append', conversationId, baseRootId ?? '<null>', nodeId);
    const existingOccurrence = await this.readOccurrence(sources);
    if (existingOccurrence) {
      assertExistingSegment(existingOccurrence, segmentId, segmentKind, planInput.content.metadata.id);
      const existingNode = await this.getOptional('ContextSequenceNode', nodeId);
      const existingRoot = await this.getOptional('ContextSequenceRoot', rootId);
      if (existingNode && existingRoot) {
        return this.replayOrActivateAppend({
          conversationId, expectedHeadRootId, activate, root: existingRoot, segmentId, nodeId, rootId, fenceSteps
        });
      }
      const tipNodeId = base.compression ? base.tailNodeId : base.rootNodeId;
      if (base.root && base.rootId && tipNodeId) {
        const tip = await this.getOptional('ContextSequenceNode', tipNodeId);
        if (tip?.segment_id === segmentId) {
          return this.replayOrActivateAppend({
            conversationId,
            expectedHeadRootId,
            activate,
            root: base.root,
            segmentId,
            nodeId: tipNodeId,
            rootId: base.rootId,
            fenceSteps
          });
        }
      }
      throw sourceParentConflictError(sources, baseRootId);
    }
    // An identical concurrent append may have advanced the head to this command's deterministic
    // root while its CAS prepare was still in flight. Let the replay path above recognize that
    // committed result before rejecting genuinely stale, different work.
    if (activate && currentHeadRootId !== expectedHeadRootId) throw staleHeadError(conversationId);
    const now = this.timestamp();
    const estimated = estimateTokens(planInput.content.metadata.byte_length);
    const rootShape = base.compression
      ? {
          rootNodeId: base.rootNodeId,
          tailNodeId: nodeId,
          tailSegmentCount: base.tailSegmentCount + 1n
        }
      : {
          rootNodeId: nodeId,
          tailNodeId: null,
          tailSegmentCount: 0n
        };
    const steps: RepositoryTransactionStep[] = [
      ...(activate ? headAssertionSteps(conversationId, head, expectedHeadRootId) : []),
      ...fenceSteps,
      ...preparedContentObjectSteps([planInput.content], 'context_content'),
      ...occurrenceInsertSteps({
        segmentId,
        segmentKind,
        contentObjectId: planInput.content.metadata.id,
        sources,
        now
      }),
      ...nodeInsertSteps([{ id: nodeId, parentNodeId, segmentId, now }], 'context_node_append'),
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
        id: rootId,
        conversation_id: conversationId,
        root_node_id: rootShape.rootNodeId,
        tail_node_id: rootShape.tailNodeId,
        tail_segment_count: rootShape.tailSegmentCount,
        segment_count: base.segmentCount + 1n,
        estimated_tokens: base.estimatedTokens + estimated,
        created_at: now
      }, { column: 'root_seq', scope: { conversation_id: conversationId } }),
      ...(activate ? headMutationSteps(conversationId, head, rootId, now) : [])
    ];
    try {
      const commit = await this.database.transaction(steps);
      this.observeMetrics({ kind: 'transaction', operation: 'append', count: 1 });
      return {
        segmentId,
        nodeId,
        rootId,
        rootSeq: allocatedValue(commit.allocatedSequences, 'ContextSequenceRoot', rootId, 'root_seq'),
        commitSeq: commit.commitSeq,
        deduplicated: false
      };
    } catch (error) {
      if (!isRecoverableAppendRace(error)) throw error;
      const racedOccurrence = await this.readOccurrence(sources);
      if (!racedOccurrence) throw error;
      assertExistingSegment(racedOccurrence, segmentId, segmentKind, planInput.content.metadata.id);
      const racedNode = await this.getOptional('ContextSequenceNode', nodeId);
      const racedRoot = await this.getOptional('ContextSequenceRoot', rootId);
      if (!racedNode || !racedRoot) throw sourceParentConflictError(sources, baseRootId);
      return this.replayOrActivateAppend({
        conversationId, expectedHeadRootId, activate, root: racedRoot, segmentId, nodeId, rootId, fenceSteps
      });
    }
  }

  private async replayOrActivateAppend(input: {
    conversationId: string;
    expectedHeadRootId: string | null;
    activate: boolean;
    root: DomainRow;
    segmentId: string;
    nodeId: string;
    rootId: string;
    fenceSteps?: RepositoryTransactionStep[];
  }): Promise<ContextAppendResult> {
    if (!input.activate) return this.replayAppend(input.root, input.segmentId, input.nodeId, input.rootId);
    const latestHead = await this.getHead(input.conversationId);
    const latestHeadRootId = latestHead ? requireId(latestHead.root_id, 'ConversationContextHeadLink.root_id') : null;
    if (latestHeadRootId === input.rootId) {
      return this.replayAppend(input.root, input.segmentId, input.nodeId, input.rootId);
    }
    if (latestHeadRootId !== input.expectedHeadRootId) throw staleHeadError(input.conversationId);
    const commit = await this.database.transaction([
      ...headAssertionSteps(input.conversationId, latestHead, input.expectedHeadRootId),
      ...(input.fenceSteps ?? []),
      ...headMutationSteps(input.conversationId, latestHead, input.rootId, this.timestamp())
    ]);
    this.observeMetrics({ kind: 'transaction', operation: 'activate', count: 1 });
    return {
      ...this.replayAppend(input.root, input.segmentId, input.nodeId, input.rootId),
      commitSeq: commit.commitSeq
    };
  }

  private async readBaseShape(conversationId: string, rootId: string | null): Promise<BaseShape> {
    const conversation = await this.getOptional('Conversation', conversationId);
    if (!conversation) throw new Error(`Conversation ${conversationId} does not exist.`);
    if (rootId === null) {
      return {
        root: null,
        rootId: null,
        rootNodeId: null,
        tailNodeId: null,
        tailSegmentCount: 0n,
        segmentCount: 0n,
        estimatedTokens: 0n,
        compression: false
      };
    }
    const root = await this.getOptional('ContextSequenceRoot', rootId);
    if (!root) throw new Error(`ContextSequenceRoot ${rootId} does not exist.`);
    if (root.conversation_id !== conversationId) throw new Error(`ContextSequenceRoot ${rootId} belongs to another Conversation.`);
    const rootNodeId = nullableId(root.root_node_id, 'ContextSequenceRoot.root_node_id');
    let compression = false;
    if (rootNodeId) {
      const node = await this.getOptional('ContextSequenceNode', rootNodeId);
      if (!node) throw new Error(`ContextSequenceRoot ${rootId} has a missing root node.`);
      const segment = await this.getOptional('ContextSegment', requireId(node.segment_id, 'ContextSequenceNode.segment_id'));
      if (!segment) throw new Error(`ContextSequenceRoot ${rootId} has a missing root segment.`);
      compression = segment.segment_kind === 'compression';
    }
    return {
      root,
      rootId,
      rootNodeId,
      tailNodeId: nullableId(root.tail_node_id, 'ContextSequenceRoot.tail_node_id'),
      tailSegmentCount: requireBigInt(root.tail_segment_count, 'ContextSequenceRoot.tail_segment_count'),
      segmentCount: requireBigInt(root.segment_count, 'ContextSequenceRoot.segment_count'),
      estimatedTokens: requireBigInt(root.estimated_tokens, 'ContextSequenceRoot.estimated_tokens'),
      compression
    };
  }

  private async readOccurrence(sources: readonly ContextSourceOccurrence[]): Promise<DomainRow | null> {
    const reads = sources.map((source) => DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
      where: {
        source_kind: source.sourceKind,
        source_id: source.sourceId,
        source_revision: source.sourceRevision
      },
      limit: 1
    }));
    const snapshot = await this.database.snapshot(reads);
    const sourceRows = snapshot.snapshot.map((value) => rows(value)[0] ?? null);
    if (sourceRows.every((row) => row === null)) return null;
    if (sourceRows.some((row) => row === null)) throw new Error('Context source occurrence is partially registered.');
    const normalizedRows = sourceRows as DomainRow[];
    const segmentIds = new Set(normalizedRows.map((row) => requireId(row.segment_id, 'ContextSegmentSource.segment_id')));
    if (segmentIds.size !== 1) throw new Error('Context source occurrence rows point to different segments.');
    const segmentId = [...segmentIds][0];
    const segment = await this.getOptional('ContextSegment', segmentId);
    if (!segment) throw new Error(`Context source occurrence points to missing segment ${segmentId}.`);
    return segment;
  }

  private async getHead(conversationId: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').list({
        where: { conversation_id: conversationId },
        limit: 1
      })
    ]);
    return rows(snapshot.snapshot[0])[0] ?? null;
  }

  private async getOptional(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return (snapshot.snapshot[0] as DomainRow | null) ?? null;
  }

  private async requireContentObjectMetadata(id: string): Promise<ContentObjectMetadata> {
    const row = await this.getOptional('ContentObject', id);
    if (!row) throw new Error(`ContentObject ${id} does not exist.`);
    return asContentObjectMetadata(row);
  }

  private async eventContentMetadata(event: DomainRow): Promise<ContentObjectMetadata> {
    return this.requireContentObjectMetadata(requireId(event.content_object_id, 'ToolCallEvent.content_object_id'));
  }

  private replayAppend(root: DomainRow, segmentId: string, nodeId: string, rootId: string): ContextAppendResult {
    return {
      segmentId,
      nodeId,
      rootId,
      rootSeq: requireBigInt(root.root_seq, 'ContextSequenceRoot.root_seq').toString(),
      deduplicated: true
    };
  }

  private observeMetrics(event: ContextSequenceMetricsEventInput): void {
    if (!this.metricsObserver) return;
    try {
      this.metricsObserver.observe({ ...event, observedAt: this.timestamp() } as ContextSequenceMetricsEvent);
    } catch {
      // Development diagnostics must never become a Context mutation control path.
    }
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

export interface StructuralContextRecord {
  node: DomainRow;
  segment: DomainRow;
  contentObject: DomainRow;
}

export interface MaterializedContextStructure {
  root: DomainRow;
  records: StructuralContextRecord[];
  snapshotCommitSeq: string;
}

interface EditableContextSegment {
  segment: DomainRow;
  contentObject: DomainRow;
}

interface ExpandedCompressionContext {
  segments: EditableContextSegment[];
  blocks: DomainRow[];
}

interface CompressionExpansion extends ExpandedCompressionContext {
  containsTarget: boolean;
}

interface PlannedNode {
  id: string;
  parentNodeId: string | null;
  segmentId: string;
  now: string;
}

function messageOccurrenceWithAllocatedRevisionSteps(input: {
  segmentId: string;
  revisionId: string;
  existingRevisionSeq?: bigint;
  contentObjectId: string;
  now: string;
}): RepositoryTransactionStep[] {
  const source = {
    id: stableId('context_segment_source', 'message_revision', input.revisionId),
    segment_id: input.segmentId,
    source_kind: 'message_revision',
    source_id: input.revisionId,
    created_at: input.now
  };
  const sourceRepository = DOMAIN_REPOSITORIES.domain('ContextSegmentSource');
  return [savepoint('edited_message_context_occurrence', [
    DOMAIN_REPOSITORIES.domain('ContextSegment').insert({
      id: input.segmentId,
      content_object_id: input.contentObjectId,
      segment_kind: 'message',
      created_at: input.now
    }),
    input.existingRevisionSeq === undefined
      ? sourceRepository.insertMessageContextSourceForRevision(source, input.revisionId)
      : sourceRepository.insert({ ...source, source_revision: input.existingRevisionSeq })
  ], {
    kind: 'rollback-and-continue-on-unique',
    constraints: EXPECTED_OCCURRENCE_CONSTRAINTS
  })];
}

function nodeInsertSteps(nodes: readonly PlannedNode[], savepointName: string): RepositoryTransactionStep[] {
  return nodes.flatMap((node, index) => [
    savepoint(`${savepointName}_${index}`, [
      DOMAIN_REPOSITORIES.domain('ContextSequenceNode').insert({
        id: node.id,
        parent_node_id: node.parentNodeId,
        segment_id: node.segmentId,
        created_at: node.now
      })
    ], {
      kind: 'rollback-and-continue-on-unique',
      constraints: EXPECTED_NODE_CONSTRAINTS
    }),
    DOMAIN_REPOSITORIES.domain('ContextSequenceNode').assert(node.id, {
      parent_node_id: node.parentNodeId,
      segment_id: node.segmentId
    })
  ]);
}

function buildSequenceNodes(segmentIds: readonly string[], now: string): PlannedNode[] {
  const nodes: PlannedNode[] = [];
  let parentNodeId: string | null = null;
  for (const segmentId of segmentIds) {
    const id = contextSequenceNodeId(parentNodeId, segmentId);
    nodes.push({ id, parentNodeId, segmentId, now });
    parentNodeId = id;
  }
  return nodes;
}

function uniqueRows(rowsInput: readonly DomainRow[]): DomainRow[] {
  const rowsById = new Map<string, DomainRow>();
  for (const row of rowsInput) rowsById.set(requireId(row.id, 'row.id'), row);
  return [...rowsById.values()];
}

function compareCompressionSourcePosition(left: DomainRow, right: DomainRow): number {
  const leftPosition = requireBigInt(left.position, 'CompressionBlockSource.position');
  const rightPosition = requireBigInt(right.position, 'CompressionBlockSource.position');
  return leftPosition < rightPosition ? -1 : leftPosition > rightPosition ? 1 : 0;
}

function rebuildSuffix(
  recordsInput: readonly StructuralContextRecord[],
  targetIndex: number,
  options: { replacementSegmentId: string | null; now: string }
): { nodes: PlannedNode[]; lastNodeId: string | null } {
  const records = [...recordsInput];
  if (targetIndex < 0 || targetIndex >= records.length) throw new RangeError('Context replacement target is outside the root.');
  const compression = records[0]?.segment.segment_kind === 'compression';
  if (compression && targetIndex === 0) throw new Error('A compression summary cannot be edited as a Message occurrence.');
  let parentNodeId: string | null;
  if (compression && targetIndex === 1) {
    parentNodeId = nullableId(records[targetIndex].node.parent_node_id, 'ContextSequenceNode.parent_node_id');
  } else if (targetIndex > 0) {
    parentNodeId = requireId(records[targetIndex - 1].node.id, 'ContextSequenceNode.id');
  } else {
    parentNodeId = null;
  }
  const segmentIds = [
    ...(options.replacementSegmentId ? [options.replacementSegmentId] : []),
    ...records.slice(targetIndex + 1).map((record) => requireId(record.segment.id, 'ContextSegment.id'))
  ];
  const nodes: PlannedNode[] = [];
  for (const segmentId of segmentIds) {
    const id = contextSequenceNodeId(parentNodeId, segmentId);
    nodes.push({ id, parentNodeId, segmentId, now: options.now });
    parentNodeId = id;
  }
  if (nodes.length > 0) return { nodes, lastNodeId: nodes[nodes.length - 1].id };
  if (compression) {
    return {
      nodes,
      lastNodeId: targetIndex > 1
        ? requireId(records[targetIndex - 1].node.id, 'ContextSequenceNode.id')
        : null
    };
  }
  return {
    nodes,
    lastNodeId: targetIndex > 0
      ? requireId(records[targetIndex - 1].node.id, 'ContextSequenceNode.id')
      : null
  };
}

function occurrenceInsertSteps(
  input: {
    segmentId: string;
    segmentKind: ContextSegmentKind;
    contentObjectId: string;
    sources: readonly ContextSourceOccurrence[];
    now: string;
  }
): RepositoryTransactionStep[] {
  return [
    DOMAIN_REPOSITORIES.domain('ContextSegment').insert({
      id: input.segmentId,
      content_object_id: input.contentObjectId,
      segment_kind: input.segmentKind,
      created_at: input.now
    }),
    ...input.sources.map((source) => DOMAIN_REPOSITORIES.domain('ContextSegmentSource').insert({
      id: stableSourceRowId(source),
      segment_id: input.segmentId,
      source_kind: source.sourceKind,
      source_id: source.sourceId,
      source_revision: source.sourceRevision,
      created_at: input.now
    }))
  ];
}

function headAssertionSteps(
  conversationId: string,
  head: DomainRow | null,
  expectedRootId: string | null
): RepositoryTransactionStep[] {
  if (expectedRootId === null) {
    return [DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').assertNone({ conversation_id: conversationId })];
  }
  if (!head) throw staleHeadError(conversationId);
  return [DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').assert(
    requireId(head.id, 'ConversationContextHeadLink.id'),
    { conversation_id: conversationId, root_id: expectedRootId }
  )];
}

function headMutationSteps(
  conversationId: string,
  head: DomainRow | null,
  rootId: string,
  now: string
): RepositoryTransactionStep[] {
  if (head) {
    return [DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').update(
      requireId(head.id, 'ConversationContextHeadLink.id'),
      { root_id: rootId, updated_at: now }
    )];
  }
  return [DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').insert({
    id: stableId('conversation_context_head', conversationId),
    conversation_id: conversationId,
    root_id: rootId,
    updated_at: now
  })];
}

export function validateNewContextSegmentSources(
  kind: ContextSegmentKind,
  sources: readonly ContextSourceOccurrence[]
): void {
  validateContextSegmentSourceShape(kind, sources);
}

/** Existing shared segments must be scoped to one Conversation before this shape check runs. */
export function validateScopedContextSegmentSources(
  kind: ContextSegmentKind,
  sources: readonly ContextSourceOccurrence[]
): void {
  validateContextSegmentSourceShape(kind, sources);
}

/** Classified source shape of one persisted tool_pair segment. */
export type ContextToolPairSourceShape =
  | { kind: 'atomic'; call: ContextSourceOccurrence; result: ContextSourceOccurrence }
  | { kind: 'native_call'; call: ContextSourceOccurrence }
  | { kind: 'native_result'; result: ContextSourceOccurrence };

/**
 * Classifies the sources of a persisted tool_pair segment. Atomic pairs keep the exact legacy
 * rule; native partial occurrences carry exactly one source and are only ever committed through
 * the admission-proving native append path, so readers may trust a persisted partial shape.
 */
export function classifyToolPairSources(
  sources: readonly ContextSourceOccurrence[]
): ContextToolPairSourceShape {
  if (
    sources.length === 2
    && sources[0].sourceKind === 'tool_call'
    && sources[1].sourceKind === 'tool_model_result'
  ) {
    if (sources[0].sourceRevision !== sources[1].sourceRevision) {
      throw new Error('tool_pair source rows must share call_seq source_revision.');
    }
    return { kind: 'atomic', call: sources[0], result: sources[1] };
  }
  if (sources.length === 1 && sources[0].sourceKind === 'tool_call') {
    return { kind: 'native_call', call: sources[0] };
  }
  if (sources.length === 1 && sources[0].sourceKind === 'tool_model_result') {
    return { kind: 'native_result', result: sources[0] };
  }
  throw new Error('tool_pair requires tool_call and tool_model_result source rows, or one native partial source row.');
}

/** Maps one persisted ContextSegmentSource row to its occurrence identity. */
function contextSourceOccurrence(row: DomainRow): ContextSourceOccurrence {
  return {
    sourceKind: requireSourceKind(row.source_kind),
    sourceId: requireId(row.source_id, 'ContextSegmentSource.source_id'),
    sourceRevision: requireBigInt(row.source_revision, 'ContextSegmentSource.source_revision')
  };
}

/** Requires exactly one durable native admission event for a native ToolCall fact. */
function requireNativeAdmissionEvent(toolCallId: string, events: readonly DomainRow[]): DomainRow {
  if (events.length !== 1) {
    throw new Error(
      `ToolCall ${toolCallId} has ${events.length === 0 ? 'no' : 'multiple'} durable native admission event(s); native Context occurrences require exactly one.`
    );
  }
  return events[0];
}

/**
 * Atomic execution-fence steps of a native append. An ambient captured lease fence needs no extra
 * step here: RuntimeDatabase.transaction already prepends its full immutable tuple assertion in
 * this ALS scope (only the Conversation attribution is prechecked for a clear error). The unfenced
 * terminal closure branch asserts the absence of any Conversation ExecutionLease plus a terminated
 * originating Turn.
 */
function nativeExecutionFenceSteps(
  executionFence: AppendOccurrencePlan['executionFence'],
  conversationId: string
): RepositoryTransactionStep[] {
  if (!executionFence) return [];
  const fence = currentExecutionLeaseFence();
  if (fence) {
    if (fence.conversationId !== conversationId) {
      throw new Error('Native Context append fence belongs to another Conversation.');
    }
    return [];
  }
  return [
    DOMAIN_REPOSITORIES.domain('ExecutionLease').assertNone({ conversation_id: conversationId }),
    DOMAIN_REPOSITORIES.domain('Turn').assert(executionFence.callTurnId, { status: 'terminated' })
  ];
}

function validateContextSegmentSourceShape(
  kind: ContextSegmentKind,
  sources: readonly ContextSourceOccurrence[]
): void {
  if (kind === 'tool_pair') {
    if (sources.length !== 2 || sources[0].sourceKind !== 'tool_call' || sources[1].sourceKind !== 'tool_model_result') {
      throw new Error('tool_pair requires tool_call and tool_model_result source rows.');
    }
    if (sources[0].sourceRevision !== sources[1].sourceRevision) {
      throw new Error('tool_pair source rows must share call_seq source_revision.');
    }
    return;
  }
  if (sources.length !== 1) throw new Error(`${kind} segment requires exactly one source occurrence.`);
  const expected: Partial<Record<ContextSegmentKind, ContextSourceKind>> = {
    message: 'message_revision',
    compression: 'compression_block',
    system: 'system',
    runtime_context: 'runtime_context'
  };
  if (expected[kind] && sources[0].sourceKind !== expected[kind]) {
    throw new Error(`${kind} segment requires ${expected[kind]} source kind.`);
  }
  if (
    (sources[0].sourceKind === 'compression_block'
      || sources[0].sourceKind === 'system'
      || sources[0].sourceKind === 'runtime_context')
    && sources[0].sourceRevision !== 0n
  ) {
    throw new Error(`${sources[0].sourceKind} source_revision must be 0.`);
  }
}

function normalizeSources(sources: readonly ContextSourceOccurrence[]): ContextSourceOccurrence[] {
  if (!Array.isArray(sources) || sources.length === 0) throw new TypeError('Context sources must not be empty.');
  return sources.map(normalizeSource);
}

function normalizeSource(source: ContextSourceOccurrence): ContextSourceOccurrence {
  const sourceKind = requireSourceKind(source?.sourceKind);
  const sourceId = requireId(source?.sourceId, 'Context sourceId');
  const sourceRevision = typeof source?.sourceRevision === 'bigint'
    ? source.sourceRevision
    : decimalBigInt(source?.sourceRevision, 'Context sourceRevision');
  if (sourceRevision < 0n) throw new TypeError('Context sourceRevision must be non-negative.');
  return { sourceKind, sourceId, sourceRevision };
}

function toolPairContent(fact: ToolPairBatchFact, argumentsBytes: Buffer, resultBytes: Buffer): string {
  const argumentMetadata = requireContentMetadata(
    fact.argumentMetadata,
    `ToolCall ${fact.toolCallId} arguments`
  );
  const resultMetadata = requireContentMetadata(
    fact.resultMetadata,
    `ToolModelResult ${fact.toolModelResultId} result`
  );
  return JSON.stringify({
    kind: 'tool_pair',
    toolCall: {
      id: fact.toolCallId,
      ...(fact.providerCallId ? { providerCallId: fact.providerCallId } : {}),
      callSeq: fact.callSeq.toString(),
      toolName: requireText(fact.toolCall.tool_name, 'ToolCall.tool_name'),
      argumentsContentType: argumentMetadata.content_type,
      arguments: argumentsBytes.toString('utf8')
    },
    toolModelResult: {
      id: fact.toolModelResultId,
      messageRevisionId: fact.resultRevisionId,
      resultContentType: resultMetadata.content_type,
      result: resultBytes.toString('utf8')
    }
  });
}

function requireContentMetadata(
  value: ContentObjectMetadata | undefined,
  label: string
): ContentObjectMetadata {
  if (!value) throw new Error(`${label} metadata does not exist.`);
  return value;
}

function stableSegmentId(sources: readonly ContextSourceOccurrence[]): string {
  return stableId(
    'context_segment',
    ...sources.flatMap((source) => source.sourceKind === 'message_revision'
      ? [source.sourceKind, source.sourceId]
      : [source.sourceKind, source.sourceId, source.sourceRevision.toString()])
  );
}

function stableSourceRowId(source: ContextSourceOccurrence): string {
  return source.sourceKind === 'message_revision'
    ? stableId('context_segment_source', source.sourceKind, source.sourceId)
    : stableId('context_segment_source', source.sourceKind, source.sourceId, source.sourceRevision.toString());
}

export function contextSequenceNodeId(parentNodeId: string | null, segmentId: string): string {
  return stableId('context_node', parentNodeId ?? '<null>', requireId(segmentId, 'ContextSegment.id'));
}

function stableId(kind: string, ...parts: string[]): string {
  const digest = createHash('sha256')
    .update('limcode-reliable-kernel-context\0')
    .update(kind)
    .update('\0')
    .update(parts.join('\0'))
    .digest('hex');
  return `${kind}_${digest}`;
}

function assertExistingSegment(
  segment: DomainRow,
  expectedId: string,
  expectedKind: ContextSegmentKind,
  expectedContentObjectId: string
): void {
  if (
    segment.id !== expectedId
    || segment.segment_kind !== expectedKind
    || segment.content_object_id !== expectedContentObjectId
  ) throw new Error('Stable Context source occurrence conflicts with immutable segment content.');
}

function isRecoverableAppendRace(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE'
    || code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}

function sourceParentConflictError(
  sources: readonly ContextSourceOccurrence[],
  baseRootId: string | null
): Error & { code: string } {
  const identity = sources.map((source) =>
    `${source.sourceKind}:${source.sourceId}:${source.sourceRevision.toString()}`
  ).join(',');
  const error = new Error(
    `Context source occurrence ${identity} is already attached to another sequence position; base=${baseRootId ?? '<empty>'}.`
  ) as Error & { code: string };
  error.code = 'CONTEXT_SOURCE_PARENT_CONFLICT';
  return error;
}

function allocatedValue(
  allocated: readonly { domain: string; id: string; column: string; value: string }[],
  domain: string,
  id: string,
  column: string
): string {
  const entry = allocated.find((candidate) =>
    candidate.domain === domain && candidate.id === id && candidate.column === column
  );
  if (!entry) throw new Error(`Missing writer allocation ${domain}.${column} for ${id}.`);
  return entry.value;
}

function optionalEstimatedTokens(value: number | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('estimated token count must be a non-negative safe integer.');
  }
  return BigInt(value);
}

function estimateTokens(byteLength: bigint): bigint {
  return (byteLength + 3n) / 4n;
}

function staleHeadError(conversationId: string): Error & { code: string } {
  const error = new Error(`Conversation ${conversationId} Context head changed before commit.`) as Error & { code: string };
  error.code = 'CONTEXT_HEAD_STALE';
  return error;
}

function asContentObjectMetadata(row: DomainRow): ContentObjectMetadata {
  return row as ContentObjectMetadata;
}

function requireSegmentKind(value: unknown): ContextSegmentKind {
  if (!['system', 'message', 'tool_pair', 'compression', 'runtime_context'].includes(String(value))) {
    throw new TypeError(`Unsupported Context segment kind: ${String(value)}`);
  }
  return value as ContextSegmentKind;
}

function requireSourceKind(value: unknown): ContextSourceKind {
  if (!['message_revision', 'tool_call', 'tool_model_result', 'compression_block', 'system', 'runtime_context'].includes(String(value))) {
    throw new TypeError(`Unsupported Context source kind: ${String(value)}`);
  }
  return value as ContextSourceKind;
}

function bufferView(content: Uint8Array): Buffer {
  return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
}

function requireRow(value: unknown, label: string): DomainRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value as DomainRow;
}

function rows(value: unknown): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError('Repository list result must be an array.');
  return value as DomainRow[];
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function nullableText(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireText(value, label);
}

function nullableId(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireId(value, label);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value.trim();
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError(`${label} must be a non-negative SQLite INTEGER.`);
  return value;
}

function decimalBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string or bigint.`);
  }
  return BigInt(value);
}
