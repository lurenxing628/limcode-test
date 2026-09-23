import { createHash } from 'node:crypto';
import type { MessageContent } from '../../shared/protocol';
import { ContentAddressedStore } from './contentAddressedStore';
import {
  ATTACHMENT_OBSERVATION_CONTENT_TYPE,
  attachmentObservationDocumentContent,
  attachmentObservationLinkId,
  compressionBlockObservationLinkId,
  type AttachmentObservationCommit
} from './attachmentObservations';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import {
  ContextSequenceControlPlane,
  contextSequenceNodeId
} from './contextSequence';
import {
  canonicalizeCompressionContents,
  estimateMaterializedContextTokens,
  estimateMessageContentsTokens,
  ReliableContextTokenEstimator,
  type ReliableContextTokenEstimateSource
} from './contextTokenEstimator';
import { MAX_PROVIDER_TOKEN_CALIBRATION_RATIO } from './modelFacingContextProjection';
import {
  DOMAIN_REPOSITORIES,
  savepoint,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';
import {
  frozenContextProfile,
  type FrozenContextProfile
} from './frozenAuthority';
import { readRequestTurnAuthority } from './requestCompressionSettings';

export interface FrozenContextProfileDocument {
  modelProfile: FrozenContextProfile;
}

export interface CompressionDecision {
  rootId: string;
  authoritySnapshotId: string;
  estimatedTokens: number;
  source: ReliableContextTokenEstimateSource;
  thresholdTokens: number;
  shouldCompress: boolean;
}

export interface CreateCompressionCommand {
  conversationId: string;
  headRootId: string;
  authoritySnapshotId: string;
  compressSegmentCount: number;
  title: string;
  /** Provider-native compression remains structured; summary methods may keep Markdown. */
  summary: string | MessageContent[];
  /** Display-only facts frozen beside structured contents; Provider materialization ignores them. */
  summaryMetadata?: {
    trigger: 'auto' | 'manual';
    triggerReason?: 'manual' | 'configured_threshold';
    triggerTokens?: number;
    triggerTokenSource?: ReliableContextTokenEstimateSource;
    configuredThresholdTokens?: number;
    requestBreakdown?: {
      systemTokens: number;
      toolSchemaTokens: number;
      providerFramingTokens: number;
      contextTokens: number;
      currentInputTokens: number;
      runtimeDeliveryTokens: number;
      turnReminderTokens: number;
      mediaTokens: number;
      fixedTokens: number;
      bodyTokens: number;
      fullTokens: number;
    };
    /** Full request (system, tools and context) before; absent for manual compression, which has no request. */
    estimatedTokensBefore?: number;
    /** Context before, in the same estimator unit as estimatedTokensAfter; their difference is the saving. */
    contextTokensBefore?: number;
    estimatedTokensAfter?: number;
    /** Provider/estimator ratio used to size the retained tail, within [1, 4]. */
    providerCalibrationRatio?: number;
    /** estimatedTokensBefore/After re-expressed in Provider tokens by that ratio. */
    calibratedTokensBefore?: number;
    calibratedTokensAfter?: number;
    providerInputTokens?: number;
    providerOutputTokens?: number;
    methodKind: string;
    /** Provider-observed output tokens for the structured compact state. */
    estimatedTokens?: number;
    nativeBinding?: {
      providerConfigId: string;
      provider: string;
      modelId: string;
    };
    /**
     * Native full-context rebase facts frozen for observability when a compression lands on a
     * native history: the connection-local cache/continuation chain resets, transport-only
     * configuration_update items leave the compacted window, and the effective reasoning effort
     * is preserved for the fresh update applied before the next user message.
     */
    nativeRebase?: {
      cacheReset: true;
      droppedConfigurationUpdates: number;
      effectiveEffort?: string;
    };
  };
  /** Provider-aligned estimate for the replacement Context only (summary/native output plus local tail). */
  projectedEstimatedTokens?: number;
  attachmentObservations?: AttachmentObservationCommit[];
  idempotencyKey: string;
}

export interface ReplaceCompressionCommand {
  conversationId: string;
  previousBlockId: string;
  expectedHeadRootId: string;
  title: string;
  summary: string | MessageContent[];
  previousStatus: 'disabled' | 'soft_deleted';
  idempotencyKey: string;
}

interface CompressionReplayExpectation {
  blockId: string;
  summarySegmentId: string;
  rootId: string;
  projectionId: string;
  conversationId: string;
  authoritySnapshotId: string;
  titleObjectId: string;
  summaryObjectId: string;
  projectionRootId: string;
  projectionPurpose: string;
  sourceCount: number;
  expectedSourceSegmentIds?: readonly string[];
  expectedObservations?: readonly { linkId: string; contentObjectId?: string }[];
}

export interface CompressionCommitResult {
  compressionBlockId: string;
  summarySegmentId: string;
  rootId: string;
  rootSeq: string;
  projectionId: string;
  commitSeq?: string;
  sourceCount: number;
  deduplicated: boolean;
}

const CONTENT_TYPE_TITLE = 'text/plain';
const CONTENT_TYPE_SUMMARY = 'text/markdown';
export const CONTENT_TYPE_COMPRESSION_CONTENTS = 'application/vnd.limcode.compression-contents+json';

/** Immutable compression command boundary. Source rows are O(k); sequence attachment is one node. */
export class ContextCompressionControlPlane {
  private readonly context: ContextSequenceControlPlane;
  private readonly tokenEstimator: ReliableContextTokenEstimator;
  private readonly now: () => string;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.context = new ContextSequenceControlPlane(database, contentStore, { now: this.now });
    this.tokenEstimator = new ReliableContextTokenEstimator(database, contentStore);
  }

  public async evaluate(rootIdInput: string, authoritySnapshotIdInput: string, settingsSnapshotContentObjectId?: string): Promise<CompressionDecision> {
    const rootId = requireId(rootIdInput, 'rootId');
    const authoritySnapshotId = requireId(authoritySnapshotIdInput, 'authoritySnapshotId');
    const [frozen, estimate] = await Promise.all([
      this.readFrozenProfile(authoritySnapshotId, settingsSnapshotContentObjectId),
      this.tokenEstimator.estimateRoot(rootId)
    ]);
    if (frozen.conversationId !== estimate.conversationId) {
      throw new Error('AuthoritySnapshot belongs to another Conversation.');
    }
    const profile = frozen.profile;
    const estimatedTokens = estimate.estimatedTokens;
    return {
      rootId,
      authoritySnapshotId,
      estimatedTokens,
      source: estimate.source,
      thresholdTokens: profile.compressionThresholdTokens,
      shouldCompress: estimatedTokens >= profile.compressionThresholdTokens
    };
  }

  public async create(command: CreateCompressionCommand): Promise<CompressionCommitResult> {
    const conversationId = requireId(command.conversationId, 'conversationId');
    const headRootId = requireId(command.headRootId, 'headRootId');
    const authoritySnapshotId = requireId(command.authoritySnapshotId, 'authoritySnapshotId');
    const idempotencyKey = requireText(command.idempotencyKey, 'idempotencyKey');
    const title = requireText(command.title, 'title');
    const summary = normalizeCompressionSummary(command.summary, command.summaryMetadata);
    const requestedSourceCount = requirePositiveCount(command.compressSegmentCount);
    const titleIdentity = this.contentStore.identity(title, CONTENT_TYPE_TITLE);
    const summaryIdentity = this.contentStore.identity(summary.content, summary.contentType);
    const observationPlans = normalizeAttachmentObservationCommits(command.attachmentObservations ?? []).map((observation) => {
      const content = attachmentObservationDocumentContent(observation.document);
      return {
        observation,
        content,
        identity: this.contentStore.identity(content, ATTACHMENT_OBSERVATION_CONTENT_TYPE),
        linkId: attachmentObservationLinkId(observation.attachmentId, observation.analysisProfileSha256)
      };
    });
    const expectedObservations = observationPlans.map((plan) => ({
      linkId: plan.linkId,
      contentObjectId: plan.identity.id
    }));
    const blockId = compressionBlockIdFor(conversationId, headRootId, idempotencyKey);
    const summarySegmentId = compressionSegmentIdFor(blockId);
    const summaryNodeId = contextSequenceNodeId(null, summarySegmentId);
    const rootId = stableId('compression_root', blockId, headRootId);
    const projectionId = stableId('compression_projection', blockId);
    const existing = await this.getOptional('CompressionBlock', blockId);
    if (existing) {
      return this.replay(existing, {
        blockId,
        summarySegmentId,
        rootId,
        projectionId,
        conversationId,
        authoritySnapshotId,
        titleObjectId: titleIdentity.id,
        summaryObjectId: summaryIdentity.id,
        projectionRootId: headRootId,
        projectionPurpose: 'compression-source',
        sourceCount: requestedSourceCount,
        expectedObservations
      });
    }
    const [materialized, semanticMaterialized] = await Promise.all([
      this.context.materializeStructure(headRootId),
      this.context.materialize(headRootId)
    ]);
    if (materialized.root.conversation_id !== conversationId) {
      throw new Error(`ContextSequenceRoot ${headRootId} belongs to another Conversation.`);
    }
    const compressCount = requireRangeCount(requestedSourceCount, materialized.records.length);
    const frozen = await this.readFrozenProfile(authoritySnapshotId);
    if (frozen.conversationId !== conversationId) throw new Error('AuthoritySnapshot belongs to another Conversation.');
    const head = await this.requireHead(conversationId, headRootId);
    const titleContent = await this.contentStore.prepare(this.database, title, CONTENT_TYPE_TITLE);
    const summaryContent = await this.contentStore.prepare(this.database, summary.content, summary.contentType);
    const observationContents = await Promise.all(observationPlans.map((plan) =>
      this.contentStore.prepare(this.database, plan.content, ATTACHMENT_OBSERVATION_CONTENT_TYPE)
    ));
    const sourceSegments = materialized.records.slice(0, compressCount);
    const tail = materialized.records.slice(compressCount);
    const now = this.timestamp();
    const rootEstimatedTokens = command.projectedEstimatedTokens === undefined
      ? estimateCompressionSummaryInput(command.summary, command.summaryMetadata)
        + estimateMaterializedContextTokens(semanticMaterialized.segments.slice(compressCount))
      : requireEstimatedTokens(command.projectedEstimatedTokens, 'projectedEstimatedTokens');
    const steps: RepositoryTransactionStep[] = [
      headAssertion(head, conversationId, headRootId),
      ...preparedContentObjectSteps(
        [titleContent, summaryContent, ...observationContents],
        'compression_content'
      ),
      DOMAIN_REPOSITORIES.domain('CompressionBlock').insert({
        id: blockId,
        conversation_id: conversationId,
        status: 'enabled',
        authority_snapshot_id: authoritySnapshotId,
        title_object_id: titleContent.metadata.id,
        summary_object_id: summaryContent.metadata.id,
        created_at: now,
        updated_at: now
      }),
      ...observationPlans.flatMap((plan, index): RepositoryTransactionStep[] => [
        savepoint(`attachment_observation_${index}`, [
          DOMAIN_REPOSITORIES.domain('AttachmentObservationLink').insert({
            id: plan.linkId,
            attachment_id: plan.observation.attachmentId,
            analysis_profile_sha256: plan.observation.analysisProfileSha256,
            content_object_id: observationContents[index].metadata.id,
            created_at: now
          })
        ], {
          kind: 'rollback-and-continue-on-unique',
          constraints: [
            { domain: 'AttachmentObservationLink', columns: ['id'] },
            { domain: 'AttachmentObservationLink', columns: ['attachment_id', 'analysis_profile_sha256'] }
          ]
        }),
        DOMAIN_REPOSITORIES.domain('AttachmentObservationLink').assert(plan.linkId, {
          attachment_id: plan.observation.attachmentId,
          analysis_profile_sha256: plan.observation.analysisProfileSha256,
          content_object_id: observationContents[index].metadata.id
        }),
        DOMAIN_REPOSITORIES.domain('CompressionBlockObservationLink').insert({
          id: compressionBlockObservationLinkId(blockId, plan.linkId),
          compression_block_id: blockId,
          observation_id: plan.linkId,
          position: BigInt(index),
          created_at: now
        })
      ]),
      ...sourceSegments.map((segment, position) => compressionSourceInsert(
        blockId,
        requireId(segment.segment.id, 'ContextSegment.id'),
        position,
        now
      )),
      DOMAIN_REPOSITORIES.domain('ContextSegment').insert({
        id: summarySegmentId,
        content_object_id: summaryContent.metadata.id,
        segment_kind: 'compression',
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ContextSegmentSource').insert({
        id: stableId('compression_segment_source', blockId),
        segment_id: summarySegmentId,
        source_kind: 'compression_block',
        source_id: blockId,
        source_revision: 0n,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ContextSequenceNode').insert({
        id: summaryNodeId,
        parent_node_id: null,
        segment_id: summarySegmentId,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
        id: rootId,
        conversation_id: conversationId,
        root_node_id: summaryNodeId,
        tail_node_id: tail.length
          ? requireId(tail[tail.length - 1].node.id, 'ContextSequenceNode.id')
          : null,
        tail_segment_count: BigInt(tail.length),
        segment_count: BigInt(1 + tail.length),
        estimated_tokens: BigInt(rootEstimatedTokens),
        created_at: now
      }, { column: 'root_seq', scope: { conversation_id: conversationId } }),
      DOMAIN_REPOSITORIES.domain('ModelContextProjection').insert({
        id: projectionId,
        owner_kind: 'compression_block',
        owner_id: blockId,
        root_id: headRootId,
        purpose: 'compression-source',
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').update(requireId(head.id, 'Context head.id'), {
        root_id: rootId,
        updated_at: now
      })
    ];
    try {
      const commit = await this.database.transaction(steps);
      return {
        compressionBlockId: blockId,
        summarySegmentId,
        rootId,
        rootSeq: allocatedValue(commit.allocatedSequences, rootId),
        projectionId,
        commitSeq: commit.commitSeq,
        sourceCount: sourceSegments.length,
        deduplicated: false
      };
    } catch (error) {
      if (!isRecoverableCompressionRace(error)) throw error;
      const raced = await this.getOptional('CompressionBlock', blockId);
      if (!raced) throw error;
      return this.replay(raced, {
        blockId,
        summarySegmentId,
        rootId,
        projectionId,
        conversationId,
        authoritySnapshotId,
        titleObjectId: titleIdentity.id,
        summaryObjectId: summaryIdentity.id,
        projectionRootId: headRootId,
        projectionPurpose: 'compression-source',
        sourceCount: compressCount,
        expectedObservations
      });
    }
  }

  public async replace(command: ReplaceCompressionCommand): Promise<CompressionCommitResult> {
    const conversationId = requireId(command.conversationId, 'conversationId');
    const previousBlockId = requireId(command.previousBlockId, 'previousBlockId');
    const expectedHeadRootId = requireId(command.expectedHeadRootId, 'expectedHeadRootId');
    const previousStatus = requireReplacementStatus(command.previousStatus);
    const idempotencyKey = requireText(command.idempotencyKey, 'idempotencyKey');
    const title = requireText(command.title, 'title');
    const summary = normalizeCompressionSummary(command.summary);
    const titleIdentity = this.contentStore.identity(title, CONTENT_TYPE_TITLE);
    const summaryIdentity = this.contentStore.identity(summary.content, summary.contentType);
    const blockId = stableId('compression_replacement', previousBlockId, idempotencyKey);
    const summarySegmentId = compressionSegmentIdFor(blockId);
    const summaryNodeId = contextSequenceNodeId(null, summarySegmentId);
    const rootId = stableId('compression_root', blockId, expectedHeadRootId);
    const projectionId = stableId('compression_projection', blockId);
    const projectionPurpose = replacementProjectionPurpose(previousStatus);
    const previousBlock = await this.requireDomain('CompressionBlock', previousBlockId);
    if (previousBlock.conversation_id !== conversationId) throw new Error('CompressionBlock belongs to another Conversation.');
    const projection = await this.findProjection('compression_block', previousBlockId);
    const [sourceRows, observationRows] = await Promise.all([
      this.listAllSources(previousBlockId),
      this.listAllBlockObservations(previousBlockId)
    ]);
    const authoritySnapshotId = requireId(previousBlock.authority_snapshot_id, 'CompressionBlock.authority_snapshot_id');
    const expectedSourceSegmentIds = sourceRows.map((source) =>
      requireId(source.segment_id, 'CompressionBlockSource.segment_id')
    );
    const expectedObservations = observationRows.map((row) => ({
      linkId: requireId(row.observation_id, 'CompressionBlockObservationLink.observation_id')
    }));
    const existing = await this.getOptional('CompressionBlock', blockId);
    if (existing) {
      return this.replay(existing, {
        blockId,
        summarySegmentId,
        rootId,
        projectionId,
        conversationId,
        authoritySnapshotId,
        titleObjectId: titleIdentity.id,
        summaryObjectId: summaryIdentity.id,
        projectionRootId: requireId(projection.root_id, 'ModelContextProjection.root_id'),
        projectionPurpose,
        sourceCount: sourceRows.length,
        expectedSourceSegmentIds,
        expectedObservations
      });
    }
    if (previousBlock.status !== 'enabled') throw new Error('Only an enabled CompressionBlock can be replaced.');
    const [current, semanticCurrent] = await Promise.all([
      this.context.materializeStructure(expectedHeadRootId),
      this.context.materialize(expectedHeadRootId)
    ]);
    if (current.root.conversation_id !== conversationId) throw new Error('Expected Context head belongs to another Conversation.');
    if (current.records[0]?.segment.segment_kind !== 'compression') {
      throw new Error('Current Context root is not a compression root.');
    }
    const previousSummarySource = await this.findCompressionSummarySource(previousBlockId);
    if (previousSummarySource.segment_id !== current.records[0].segment.id) {
      throw new Error('The CompressionBlock is not the summary owner of the expected current head.');
    }
    const frozen = await this.readFrozenProfile(authoritySnapshotId);
    if (frozen.conversationId !== conversationId) throw new Error('AuthoritySnapshot belongs to another Conversation.');
    const head = await this.requireHead(conversationId, expectedHeadRootId);
    const titleContent = await this.contentStore.prepare(this.database, title, CONTENT_TYPE_TITLE);
    const summaryContent = await this.contentStore.prepare(this.database, summary.content, summary.contentType);
    const now = this.timestamp();
    const rootEstimatedTokens = estimateCompressionSummaryInput(command.summary)
      + estimateMaterializedContextTokens(semanticCurrent.segments.slice(1));
    const steps: RepositoryTransactionStep[] = [
      headAssertion(head, conversationId, expectedHeadRootId),
      DOMAIN_REPOSITORIES.domain('CompressionBlock').assert(previousBlockId, { status: 'enabled' }),
      ...preparedContentObjectSteps([titleContent, summaryContent], 'compression_content'),
      DOMAIN_REPOSITORIES.domain('CompressionBlock').insert({
        id: blockId,
        conversation_id: conversationId,
        status: 'enabled',
        authority_snapshot_id: authoritySnapshotId,
        title_object_id: titleContent.metadata.id,
        summary_object_id: summaryContent.metadata.id,
        created_at: now,
        updated_at: now
      }),
      ...observationRows.flatMap((row, position): RepositoryTransactionStep[] => {
        const sourceLinkId = requireId(row.id, 'CompressionBlockObservationLink.id');
        const observationId = requireId(row.observation_id, 'CompressionBlockObservationLink.observation_id');
        return [
          DOMAIN_REPOSITORIES.domain('CompressionBlockObservationLink').assert(sourceLinkId, {
            compression_block_id: previousBlockId,
            observation_id: observationId,
            position: BigInt(position)
          }),
          DOMAIN_REPOSITORIES.domain('CompressionBlockObservationLink').insert({
            id: compressionBlockObservationLinkId(blockId, observationId),
            compression_block_id: blockId,
            observation_id: observationId,
            position: BigInt(position),
            created_at: now
          })
        ];
      }),
      ...sourceRows.map((source, position) => compressionSourceInsert(
        blockId,
        requireId(source.segment_id, 'CompressionBlockSource.segment_id'),
        position,
        now
      )),
      DOMAIN_REPOSITORIES.domain('ContextSegment').insert({
        id: summarySegmentId,
        content_object_id: summaryContent.metadata.id,
        segment_kind: 'compression',
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ContextSegmentSource').insert({
        id: stableId('compression_segment_source', blockId),
        segment_id: summarySegmentId,
        source_kind: 'compression_block',
        source_id: blockId,
        source_revision: 0n,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ContextSequenceNode').insert({
        id: summaryNodeId,
        parent_node_id: null,
        segment_id: summarySegmentId,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
        id: rootId,
        conversation_id: conversationId,
        root_node_id: summaryNodeId,
        tail_node_id: current.root.tail_node_id,
        tail_segment_count: current.root.tail_segment_count,
        segment_count: current.root.segment_count,
        estimated_tokens: BigInt(rootEstimatedTokens),
        created_at: now
      }, { column: 'root_seq', scope: { conversation_id: conversationId } }),
      DOMAIN_REPOSITORIES.domain('ModelContextProjection').insert({
        id: projectionId,
        owner_kind: 'compression_block',
        owner_id: blockId,
        root_id: requireId(projection.root_id, 'ModelContextProjection.root_id'),
        purpose: projectionPurpose,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('CompressionBlock').update(previousBlockId, {
        status: previousStatus,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').update(requireId(head.id, 'Context head.id'), {
        root_id: rootId,
        updated_at: now
      })
    ];
    try {
      const commit = await this.database.transaction(steps);
      return {
        compressionBlockId: blockId,
        summarySegmentId,
        rootId,
        rootSeq: allocatedValue(commit.allocatedSequences, rootId),
        projectionId,
        commitSeq: commit.commitSeq,
        sourceCount: sourceRows.length,
        deduplicated: false
      };
    } catch (error) {
      if (!isRecoverableCompressionRace(error)) throw error;
      const raced = await this.getOptional('CompressionBlock', blockId);
      if (!raced) throw error;
      return this.replay(raced, {
        blockId,
        summarySegmentId,
        rootId,
        projectionId,
        conversationId,
        authoritySnapshotId,
        titleObjectId: titleIdentity.id,
        summaryObjectId: summaryIdentity.id,
        projectionRootId: requireId(projection.root_id, 'ModelContextProjection.root_id'),
        projectionPurpose,
        sourceCount: sourceRows.length,
        expectedSourceSegmentIds,
        expectedObservations
      });
    }
  }

  public async updateStatus(
    compressionBlockIdInput: string,
    status: 'enabled' | 'disabled' | 'soft_deleted'
  ): Promise<string> {
    const compressionBlockId = requireId(compressionBlockIdInput, 'compressionBlockId');
    requireStatus(status);
    const now = this.timestamp();
    const commit = await this.database.transaction([
      DOMAIN_REPOSITORIES.domain('CompressionBlock').update(compressionBlockId, { status, updated_at: now })
    ]);
    return commit.commitSeq;
  }

  private async readFrozenProfile(authoritySnapshotId: string, settingsSnapshotContentObjectId?: string): Promise<{
    profile: FrozenContextProfileDocument['modelProfile'];
    conversationId: string;
  }> {
    const frozen = await readRequestTurnAuthority(
      this.database,
      this.contentStore,
      authoritySnapshotId,
      undefined,
      settingsSnapshotContentObjectId
    );
    return {
      profile: frozenContextProfile(frozen.document),
      conversationId: frozen.conversationId
    };
  }

  private async requireHead(conversationId: string, expectedRootId: string): Promise<DomainRow> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').list({
        where: { conversation_id: conversationId },
        limit: 1
      })
    ]);
    const head = rows(snapshot.snapshot[0])[0];
    if (!head || head.root_id !== expectedRootId) throw staleHeadError(conversationId);
    return head;
  }

  private async findCompressionSummarySource(blockId: string): Promise<DomainRow> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
        where: { source_kind: 'compression_block', source_id: blockId, source_revision: 0n },
        limit: 1
      })
    ]);
    const source = rows(snapshot.snapshot[0])[0];
    if (!source) throw new Error(`CompressionBlock ${blockId} has no summary source occurrence.`);
    return source;
  }

  private async findProjection(ownerKind: string, ownerId: string): Promise<DomainRow> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ModelContextProjection').list({
        where: { owner_kind: ownerKind, owner_id: ownerId },
        limit: 1
      })
    ]);
    const projection = rows(snapshot.snapshot[0])[0];
    if (!projection) throw new Error(`${ownerKind} ${ownerId} has no ModelContextProjection.`);
    return projection;
  }

  private async listAllSources(blockId: string): Promise<DomainRow[]> {
    const barrier = await this.database.snapshotAll(DOMAIN_REPOSITORIES.domain('CompressionBlockSource').list({
      where: { compression_block_id: blockId },
      orderBy: { column: 'id', direction: 'asc' },
      limit: 1000
    }));
    return [...barrier.snapshot].sort((left, right) => {
      const leftPosition = requireBigInt(left.position, 'CompressionBlockSource.position');
      const rightPosition = requireBigInt(right.position, 'CompressionBlockSource.position');
      return leftPosition < rightPosition ? -1 : leftPosition > rightPosition ? 1 : 0;
    });
  }

  private async listAllBlockObservations(blockId: string): Promise<DomainRow[]> {
    const barrier = await this.database.snapshotAll(DOMAIN_REPOSITORIES.domain('CompressionBlockObservationLink').list({
      where: { compression_block_id: blockId },
      orderBy: { column: 'id', direction: 'asc' },
      limit: 1000
    }));
    const rows = [...barrier.snapshot].sort((left, right) => {
      const leftPosition = requireBigInt(left.position, 'CompressionBlockObservationLink.position');
      const rightPosition = requireBigInt(right.position, 'CompressionBlockObservationLink.position');
      return leftPosition < rightPosition ? -1 : leftPosition > rightPosition ? 1 : 0;
    });
    rows.forEach((row, position) => {
      if (requireBigInt(row.position, 'CompressionBlockObservationLink.position') !== BigInt(position)) {
        throw new Error(`CompressionBlock ${blockId} observation positions are not contiguous.`);
      }
    });
    return rows;
  }

  private async requireDomain(domain: string, id: string): Promise<DomainRow> {
    const row = await this.getOptional(domain, id);
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async getOptional(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return (snapshot.snapshot[0] as DomainRow | null) ?? null;
  }

  private async replay(
    block: DomainRow,
    expected: CompressionReplayExpectation
  ): Promise<CompressionCommitResult> {
    if (
      block.id !== expected.blockId
      || block.conversation_id !== expected.conversationId
      || block.authority_snapshot_id !== expected.authoritySnapshotId
      || block.title_object_id !== expected.titleObjectId
      || block.summary_object_id !== expected.summaryObjectId
    ) throw compressionIdempotencyConflict(expected.blockId);
    const [root, projection, summarySegment, summarySource] = await Promise.all([
      this.requireDomain('ContextSequenceRoot', expected.rootId),
      this.findProjection('compression_block', expected.blockId),
      this.requireDomain('ContextSegment', expected.summarySegmentId),
      this.findCompressionSummarySource(expected.blockId)
    ]);
    if (
      root.conversation_id !== expected.conversationId
      || projection.id !== expected.projectionId
      || projection.owner_kind !== 'compression_block'
      || projection.owner_id !== expected.blockId
      || projection.root_id !== expected.projectionRootId
      || projection.purpose !== expected.projectionPurpose
      || summarySegment.content_object_id !== expected.summaryObjectId
      || summarySegment.segment_kind !== 'compression'
      || summarySource.segment_id !== expected.summarySegmentId
    ) throw compressionIdempotencyConflict(expected.blockId);
    const sources = await this.listAllSources(expected.blockId);
    if (sources.length !== expected.sourceCount) throw compressionIdempotencyConflict(expected.blockId);
    if (expected.expectedSourceSegmentIds) {
      const actual = sources.map((source) => requireId(source.segment_id, 'CompressionBlockSource.segment_id'));
      if (
        actual.length !== expected.expectedSourceSegmentIds.length
        || actual.some((segmentId, position) => segmentId !== expected.expectedSourceSegmentIds?.[position])
      ) throw compressionIdempotencyConflict(expected.blockId);
    }
    const observationRows = await this.listAllBlockObservations(expected.blockId);
    const expectedObservations = expected.expectedObservations ?? [];
    if (observationRows.length !== expectedObservations.length) {
      throw compressionIdempotencyConflict(expected.blockId);
    }
    const observationIds = observationRows.map((row) =>
      requireId(row.observation_id, 'CompressionBlockObservationLink.observation_id')
    );
    if (observationIds.some((id, index) => id !== expectedObservations[index]?.linkId)) {
      throw compressionIdempotencyConflict(expected.blockId);
    }
    const contentExpectations = expectedObservations.filter((entry) => entry.contentObjectId !== undefined);
    if (contentExpectations.length > 0) {
      const snapshot = await this.database.snapshot(contentExpectations.map((entry) =>
        DOMAIN_REPOSITORIES.domain('AttachmentObservationLink').get(entry.linkId)
      ));
      contentExpectations.forEach((entry, index) => {
        const link = snapshot.snapshot[index];
        if (!link || Array.isArray(link) || link.content_object_id !== entry.contentObjectId) {
          throw compressionIdempotencyConflict(expected.blockId);
        }
      });
    }
    return {
      compressionBlockId: expected.blockId,
      summarySegmentId: expected.summarySegmentId,
      rootId: expected.rootId,
      rootSeq: requireBigInt(root.root_seq, 'ContextSequenceRoot.root_seq').toString(),
      projectionId: expected.projectionId,
      sourceCount: sources.length,
      deduplicated: true
    };
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

function normalizeAttachmentObservationCommits(
  values: readonly AttachmentObservationCommit[]
): AttachmentObservationCommit[] {
  const seenAttachments = new Set<string>();
  return values.map((value, index) => {
    if (!value || typeof value !== 'object') {
      throw new TypeError(`attachmentObservations[${index}] must be an object.`);
    }
    const attachmentId = requireId(value.attachmentId, `attachmentObservations[${index}].attachmentId`);
    const analysisProfileSha256 = requireSha256(
      value.analysisProfileSha256,
      `attachmentObservations[${index}].analysisProfileSha256`
    );
    if (seenAttachments.has(attachmentId)) {
      throw new Error(`Compression contains duplicate observation for Attachment ${attachmentId}.`);
    }
    seenAttachments.add(attachmentId);
    if (value.document.analysisProfileSha256 !== analysisProfileSha256) {
      throw new Error(`Attachment ${attachmentId} observation document uses another analysis profile.`);
    }
    // Canonical encoding performs the complete document shape/bounds validation.
    attachmentObservationDocumentContent(value.document);
    return { attachmentId, analysisProfileSha256, document: value.document };
  });
}

function requireSha256(value: unknown, label: string): string {
  const text = requireText(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(text)) throw new TypeError(`${label} must be a SHA-256 hex digest.`);
  return text;
}

function replacementProjectionPurpose(status: 'disabled' | 'soft_deleted'): string {
  return `compression-replacement-source:${status}`;
}

function compressionSourceInsert(
  blockId: string,
  segmentId: string,
  position: number,
  now: string
): RepositoryTransactionStep {
  return DOMAIN_REPOSITORIES.domain('CompressionBlockSource').insert({
    id: stableId('compression_source', blockId, segmentId, String(position)),
    compression_block_id: blockId,
    segment_id: segmentId,
    position: BigInt(position),
    created_at: now
  });
}

function headAssertion(head: DomainRow, conversationId: string, rootId: string): RepositoryTransactionStep {
  return DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').assert(
    requireId(head.id, 'ConversationContextHeadLink.id'),
    { conversation_id: conversationId, root_id: rootId }
  );
}

function estimateCompressionSummaryInput(
  input: string | MessageContent[],
  metadata?: CreateCompressionCommand['summaryMetadata']
): number {
  const observed = metadata?.estimatedTokens;
  if (observed !== undefined) return requireEstimatedTokens(observed, 'summaryMetadata.estimatedTokens');
  return typeof input === 'string'
    ? estimateMessageContentsTokens([{ role: 'model', parts: [{ text: input }] }])
    : estimateMessageContentsTokens(input);
}

function requireCalibrationRatio(value: number): number {
  if (!Number.isFinite(value) || value < 1 || value > MAX_PROVIDER_TOKEN_CALIBRATION_RATIO) {
    throw new TypeError(
      `summaryMetadata.providerCalibrationRatio must be within [1, ${MAX_PROVIDER_TOKEN_CALIBRATION_RATIO}].`
    );
  }
  return value;
}

function requireEstimatedTokens(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function allocatedValue(
  allocated: readonly { domain: string; id: string; column: string; value: string }[],
  rootId: string
): string {
  const entry = allocated.find((candidate) =>
    candidate.domain === 'ContextSequenceRoot'
    && candidate.id === rootId
    && candidate.column === 'root_seq'
  );
  if (!entry) throw new Error(`Missing ContextSequenceRoot.root_seq allocation for ${rootId}.`);
  return entry.value;
}

function requirePositiveCount(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError('Compression source count must be a positive safe integer.');
  }
  return value;
}

function requireRangeCount(value: number, total: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > total) {
    throw new RangeError(`Compression source count must be from 1 to ${total}.`);
  }
  return value;
}

function requireReplacementStatus(value: unknown): 'disabled' | 'soft_deleted' {
  if (value !== 'disabled' && value !== 'soft_deleted') {
    throw new TypeError('Replacement previousStatus must be disabled or soft_deleted.');
  }
  return value;
}

function requireStatus(value: unknown): void {
  if (value !== 'enabled' && value !== 'disabled' && value !== 'soft_deleted') {
    throw new TypeError('CompressionBlock.status must be enabled, disabled, or soft_deleted.');
  }
}

function stableId(kind: string, ...parts: string[]): string {
  const digest = createHash('sha256')
    .update('limcode-reliable-kernel-compression\0')
    .update(kind)
    .update('\0')
    .update(parts.join('\0'))
    .digest('hex');
  return `${kind}_${digest}`;
}

export function compressionSegmentIdFor(blockIdInput: string): string {
  return stableId('compression_segment', requireId(blockIdInput, 'compressionBlockId'));
}

export function compressionBlockIdFor(
  conversationIdInput: string,
  headRootIdInput: string,
  idempotencyKeyInput: string
): string {
  return stableId(
    'compression_block',
    requireId(conversationIdInput, 'conversationId'),
    requireId(headRootIdInput, 'headRootId'),
    requireText(idempotencyKeyInput, 'idempotencyKey')
  );
}

function isRecoverableCompressionRace(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE'
    || code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}

function compressionIdempotencyConflict(blockId: string): Error & { code: string } {
  const error = new Error(`Compression command conflicts with committed immutable block ${blockId}.`) as Error & { code: string };
  error.code = 'COMPRESSION_IDEMPOTENCY_CONFLICT';
  return error;
}

function staleHeadError(conversationId: string): Error & { code: string } {
  const error = new Error(`Conversation ${conversationId} Context head changed before compression commit.`) as Error & { code: string };
  error.code = 'CONTEXT_HEAD_STALE';
  return error;
}

function rows(value: unknown): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError('Repository list result must be an array.');
  return value as DomainRow[];
}

function normalizeCompressionSummary(
  input: string | MessageContent[],
  metadata?: CreateCompressionCommand['summaryMetadata']
): {
  content: string;
  contentType: typeof CONTENT_TYPE_SUMMARY | typeof CONTENT_TYPE_COMPRESSION_CONTENTS;
} {
  if (typeof input === 'string') {
    return { content: requireText(input, 'summary'), contentType: CONTENT_TYPE_SUMMARY };
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError('Structured compression summary must contain at least one MessageContent.');
  }
  const contents = canonicalizeCompressionContents(input.map((content, index) => {
    if (!content || (content.role !== 'user' && content.role !== 'model') || !Array.isArray(content.parts)) {
      throw new TypeError(`Structured compression summary item ${index} is invalid.`);
    }
    return content;
  }));
  let encoded: string;
  try {
    encoded = JSON.stringify({
      kind: 'compression_contents',
      version: 1,
      contents,
      ...(metadata ? {
        trigger: requireCompressionTrigger(metadata.trigger),
        ...(metadata.triggerReason ? { triggerReason: requireCompressionTriggerReason(metadata.triggerReason) } : {}),
        ...(metadata.triggerTokens === undefined ? {} : {
          triggerTokens: requireEstimatedTokens(metadata.triggerTokens, 'summaryMetadata.triggerTokens')
        }),
        ...(metadata.triggerTokenSource === undefined ? {} : {
          triggerTokenSource: requireCompressionTokenSource(metadata.triggerTokenSource)
        }),
        ...(metadata.configuredThresholdTokens === undefined ? {} : {
          configuredThresholdTokens: requireEstimatedTokens(metadata.configuredThresholdTokens, 'summaryMetadata.configuredThresholdTokens')
        }),
        ...(metadata.requestBreakdown ? { requestBreakdown: requireRequestBreakdown(metadata.requestBreakdown) } : {}),
        ...(metadata.estimatedTokensBefore === undefined ? {} : {
          estimatedTokensBefore: requireEstimatedTokens(metadata.estimatedTokensBefore, 'summaryMetadata.estimatedTokensBefore')
        }),
        ...(metadata.contextTokensBefore === undefined ? {} : {
          contextTokensBefore: requireEstimatedTokens(metadata.contextTokensBefore, 'summaryMetadata.contextTokensBefore')
        }),
        ...(metadata.estimatedTokensAfter === undefined ? {} : {
          estimatedTokensAfter: requireEstimatedTokens(metadata.estimatedTokensAfter, 'summaryMetadata.estimatedTokensAfter')
        }),
        ...(metadata.providerCalibrationRatio === undefined ? {} : {
          providerCalibrationRatio: requireCalibrationRatio(metadata.providerCalibrationRatio)
        }),
        ...(metadata.calibratedTokensBefore === undefined ? {} : {
          calibratedTokensBefore: requireEstimatedTokens(metadata.calibratedTokensBefore, 'summaryMetadata.calibratedTokensBefore')
        }),
        ...(metadata.calibratedTokensAfter === undefined ? {} : {
          calibratedTokensAfter: requireEstimatedTokens(metadata.calibratedTokensAfter, 'summaryMetadata.calibratedTokensAfter')
        }),
        ...(metadata.providerInputTokens === undefined ? {} : {
          providerInputTokens: requireEstimatedTokens(metadata.providerInputTokens, 'summaryMetadata.providerInputTokens')
        }),
        ...(metadata.providerOutputTokens === undefined ? {} : {
          providerOutputTokens: requireEstimatedTokens(metadata.providerOutputTokens, 'summaryMetadata.providerOutputTokens')
        }),
        methodKind: requireText(metadata.methodKind, 'summaryMetadata.methodKind'),
        ...(metadata.estimatedTokens === undefined ? {} : {
          estimatedTokens: requireEstimatedTokens(metadata.estimatedTokens, 'summaryMetadata.estimatedTokens')
        }),
        ...(metadata.nativeBinding ? {
          nativeBinding: {
            providerConfigId: requireText(
              metadata.nativeBinding.providerConfigId,
              'summaryMetadata.nativeBinding.providerConfigId'
            ),
            provider: requireText(metadata.nativeBinding.provider, 'summaryMetadata.nativeBinding.provider'),
            modelId: requireText(metadata.nativeBinding.modelId, 'summaryMetadata.nativeBinding.modelId')
          }
        } : {}),
        ...(metadata.nativeRebase ? {
          nativeRebase: requireNativeRebaseMetadata(metadata.nativeRebase)
        } : {})
      } : {})
    });
  } catch (error) {
    throw new TypeError(`Structured compression summary is not JSON serializable: ${String(error)}`);
  }
  return { content: encoded, contentType: CONTENT_TYPE_COMPRESSION_CONTENTS };
}

function requireCompressionTriggerReason(
  value: unknown
): 'manual' | 'configured_threshold' {
  if (value !== 'manual' && value !== 'configured_threshold') {
    throw new TypeError('summaryMetadata.triggerReason is invalid.');
  }
  return value;
}

function requireNativeRebaseMetadata(
  value: NonNullable<NonNullable<CreateCompressionCommand['summaryMetadata']>['nativeRebase']>
): NonNullable<NonNullable<CreateCompressionCommand['summaryMetadata']>['nativeRebase']> {
  if (value.cacheReset !== true) {
    throw new TypeError('summaryMetadata.nativeRebase.cacheReset must be true.');
  }
  return {
    cacheReset: true,
    droppedConfigurationUpdates: requireEstimatedTokens(
      value.droppedConfigurationUpdates,
      'summaryMetadata.nativeRebase.droppedConfigurationUpdates'
    ),
    ...(value.effectiveEffort === undefined
      ? {}
      : { effectiveEffort: requireText(value.effectiveEffort, 'summaryMetadata.nativeRebase.effectiveEffort') })
  };
}

function requireCompressionTokenSource(value: unknown): ReliableContextTokenEstimateSource {
  if (value !== 'provider-observed-delta' && value !== 'compression-output' && value !== 'semantic') {
    throw new TypeError('summaryMetadata.triggerTokenSource is invalid.');
  }
  return value;
}

function requireRequestBreakdown(
  value: NonNullable<NonNullable<CreateCompressionCommand['summaryMetadata']>['requestBreakdown']>
): NonNullable<NonNullable<CreateCompressionCommand['summaryMetadata']>['requestBreakdown']> {
  const fields: Array<keyof typeof value> = [
    'systemTokens', 'toolSchemaTokens', 'providerFramingTokens', 'contextTokens',
    'currentInputTokens', 'runtimeDeliveryTokens', 'turnReminderTokens', 'mediaTokens',
    'fixedTokens', 'bodyTokens', 'fullTokens'
  ];
  return Object.fromEntries(fields.map((field) => [
    field,
    requireEstimatedTokens(value[field], `summaryMetadata.requestBreakdown.${field}`)
  ])) as NonNullable<NonNullable<CreateCompressionCommand['summaryMetadata']>['requestBreakdown']>;
}

function requireCompressionTrigger(value: unknown): 'auto' | 'manual' {
  if (value !== 'auto' && value !== 'manual') {
    throw new TypeError('summaryMetadata.trigger must be auto or manual.');
  }
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value.trim();
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError(`${label} must be a non-negative SQLite INTEGER.`);
  return value;
}
