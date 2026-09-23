import { createHash } from 'node:crypto';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { conversationProjectLinkInsertStep } from './conversationProject';
import {
  ConversationForkRejectedError,
  ForkCompressionPrecedence,
  readForkContextLineage,
  type ForkContextLineage
} from './conversationForkContext';
export { ConversationForkRejectedError } from './conversationForkContext';
import { prepareConversationForkSnapshot, type ForkContextRootShape } from './conversationForkSnapshot';
import type { ContentAddressedStore } from './contentAddressedStore';
import { estimateContextSegmentTokens, ReliableContextTokenEstimator } from './contextTokenEstimator';
import { ContextSequenceControlPlane, type StructuralContextRecord } from './contextSequence';
import { RuntimeDatabase } from './runtimeDatabase';

export interface ConversationForkCommand {
  /** Stable user/command identity. Replays with a different shape are rejected. */
  idempotencyKey: string;
  reuseKey: string;
  sourceConversationId: string;
  sourceContextRootId: string;
  /** Exact final Context segment retained by the target root; omitted only for whole-root callers. */
  sourceContextEndSegmentId?: string;
  sourceMessageRevisionId?: string;
  /** Optional UI CAS: the selected Message must still point at this exact revision at commit. */
  expectedCurrentMessageRevisionId?: string;
  sourceTurnId?: string;
  targetConversationId?: string;
  /** Initial display title only: the user may rename the target, so it is never fork identity. */
  targetTitle: string;
  targetAgentId: string;
}

export interface ConversationForkResult {
  targetConversationId: string;
  targetRootId: string;
  targetHeadLinkId: string;
  reuseLinkId: string;
  branchLinkId: string;
  originLinkId: string;
  sharedRootNodeId: string | null;
  copiedMessageCount?: number;
  deduplicated: boolean;
  commitSeq?: string;
}

interface ForkIds {
  targetConversationId: string;
  targetRootId: string;
  targetHeadLinkId: string;
  targetAgentLinkId: string;
  reuseLinkId: string;
  branchLinkId: string;
  originLinkId: string;
}

interface ForkRootShape {
  rootNodeId: string | null;
  tailNodeId: string | null;
  tailSegmentCount: bigint;
  segmentCount: bigint;
  estimatedTokens: bigint;
  segmentIds?: string[];
  /** Content-addressed nodes for native results moved behind the cut. */
  nodeSteps: RepositoryTransactionStep[];
  /** The selected source root and the position of its cut, for a fork at a segment boundary. */
  cut?: { records: readonly StructuralContextRecord[]; index: number };
}

/**
 * Phase F Conversation fork writer. It creates the target, its Context head, fork relation domains
 * and optional ProjectContext relationship in one SQLite transaction. Context nodes are immutable
 * and therefore referenced, never copied into the target Conversation.
 */
export class ConversationForkControlPlane {
  private readonly now: () => string;
  private readonly tokenEstimator: ReliableContextTokenEstimator;
  private readonly context: ContextSequenceControlPlane;

  public constructor(
    private readonly database: RuntimeDatabase,
    contentStore: ContentAddressedStore,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.tokenEstimator = new ReliableContextTokenEstimator(database, contentStore);
    this.context = new ContextSequenceControlPlane(database, contentStore, options);
  }

  /**
   * `beforeCommit` runs once every read and check has passed, just before the fork transaction and
   * never for a replay: the caller's own pre-commit writes (Conversation-layer settings) therefore
   * happen only for a fork that is about to commit.
   */
  public async fork(
    commandInput: ConversationForkCommand,
    options: { beforeCommit?: () => Promise<void> } = {}
  ): Promise<ConversationForkResult> {
    let command: ResolvedForkCommand = normalizeForkCommand(commandInput);
    const ids = forkIds(command);
    const replay = await this.findReplay(command, ids);
    if (replay) return replay;

    const sourceProjectSnapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ConversationProjectLink').list({
        where: { conversation_id: command.sourceConversationId },
        limit: 2
      })
    ]);
    const sourceProjectLinks = requireRows(
      sourceProjectSnapshot.snapshot[0],
      'ConversationProjectLink fork source lookup'
    );
    if (sourceProjectLinks.length > 1) {
      throw new Error('Fork source Conversation has multiple ProjectContext relationships.');
    }
    const sourceProjectLink = sourceProjectLinks[0] ?? null;
    if (sourceProjectLink && sourceProjectLink.role !== 'primary') {
      throw new Error('Fork source Conversation has a non-primary ProjectContext relationship.');
    }
    command = {
      ...command,
      ...(sourceProjectLink
        ? { sourceProjectContextId: requireId(
            sourceProjectLink.project_context_id,
            'ConversationProjectLink.project_context_id'
          ) }
        : {})
    };

    const sourceSnapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Conversation').get(command.sourceConversationId),
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').get(command.sourceContextRootId),
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').list({
        where: { conversation_id: command.sourceConversationId },
        limit: 2
      }),
      ...(command.sourceMessageRevisionId
        ? [DOMAIN_REPOSITORIES.domain('MessageRevision').get(command.sourceMessageRevisionId)]
        : []),
      ...(command.sourceTurnId
        ? [DOMAIN_REPOSITORIES.domain('Turn').get(command.sourceTurnId)]
        : []),
      ...(command.sourceProjectContextId
        ? [DOMAIN_REPOSITORIES.domain('ProjectContext').get(command.sourceProjectContextId)]
        : [])
    ]);
    let cursor = 0;
    const sourceConversation = requireRow(sourceSnapshot.snapshot[cursor++], `Conversation ${command.sourceConversationId}`);
    const sourceRoot = requireRow(sourceSnapshot.snapshot[cursor++], `ContextSequenceRoot ${command.sourceContextRootId}`);
    const sourceHeads = requireRows(sourceSnapshot.snapshot[cursor++], 'ConversationContextHeadLink source lookup');
    if (sourceRoot.conversation_id !== sourceConversation.id) {
      throw new Error('Fork source ContextSequenceRoot does not belong to the source Conversation.');
    }
    if (sourceHeads.length !== 1) {
      throw new Error(`Source Conversation ${command.sourceConversationId} must have exactly one Context head.`);
    }

    const sourceRevision = command.sourceMessageRevisionId
      ? requireRow(sourceSnapshot.snapshot[cursor++], `MessageRevision ${command.sourceMessageRevisionId}`)
      : null;
    const sourceTurn = command.sourceTurnId
      ? requireRow(sourceSnapshot.snapshot[cursor++], `Turn ${command.sourceTurnId}`)
      : null;
    const sourceProjectContext = command.sourceProjectContextId
      ? requireRow(sourceSnapshot.snapshot[cursor++], `ProjectContext ${command.sourceProjectContextId}`)
      : null;
    if (sourceTurn && sourceTurn.conversation_id !== command.sourceConversationId) {
      throw new Error('Fork source Turn does not belong to the source Conversation.');
    }

    let currentRevisionLink: DomainRow | null = null;
    if (command.expectedCurrentMessageRevisionId) {
      if (!sourceRevision || command.expectedCurrentMessageRevisionId !== command.sourceMessageRevisionId) {
        throw new Error('Fork current-revision CAS requires the selected source MessageRevision.');
      }
      const currentSnapshot = await this.database.snapshot([
        DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').list({
          where: { message_id: requireId(sourceRevision.message_id, 'MessageRevision.message_id') },
          limit: 2
        })
      ]);
      const currentRows = requireRows(currentSnapshot.snapshot[0], 'MessageCurrentRevisionLink fork source lookup');
      if (
        currentRows.length !== 1
        || currentRows[0].revision_id !== command.expectedCurrentMessageRevisionId
      ) throw new Error('Fork source Message current Revision is stale.');
      currentRevisionLink = currentRows[0];
    }

    let sourceMembership: DomainRow | null = null;
    if (sourceRevision) {
      const messageId = requireId(sourceRevision.message_id, 'MessageRevision.message_id');
      const memberships = await this.database.snapshot([
        DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({
          where: { conversation_id: command.sourceConversationId, message_id: messageId },
          limit: 2
        }),
        DOMAIN_REPOSITORIES.domain('Message').get(messageId)
      ]);
      const rows = requireRows(memberships.snapshot[0], 'MessagePartOfConversation source lookup');
      if (rows.length !== 1) {
        throw new Error('Fork source MessageRevision is not a historical member of the source Conversation.');
      }
      // A deleted fork point is gone from the transcript for good; the commit asserts it is still
      // visible, since the boundary Message is copied with its deletion state.
      if (requireRow(memberships.snapshot[1], `Message ${messageId}`).deleted_at !== null) {
        throw new ConversationForkRejectedError('分支点消息已被删除，无法从这条消息创建分支。');
      }
      sourceMembership = rows[0];
    }

    const sourceAgentSnapshot = await this.database.snapshotAll(
      DOMAIN_REPOSITORIES.domain('AgentConversationLink').list({
        where: { conversation_id: command.sourceConversationId },
        orderBy: { column: 'id', direction: 'asc' },
        limit: 1000
      })
    );
    const sourceAgentLinks = sourceAgentSnapshot.snapshot;
    const defaultAgentLinks = sourceAgentLinks.filter((link) => link.role === 'default');
    if (defaultAgentLinks.length !== 1) {
      throw new Error('Fork source Conversation must have exactly one default Agent relationship.');
    }
    const sourceContextRoots = (await this.database.snapshotAll(
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').list({
        where: { conversation_id: command.sourceConversationId },
        orderBy: { column: 'id', direction: 'asc' },
        limit: 1000
      })
    )).snapshot.sort((left, right) => {
      const leftSeq = requireBigInt(left.root_seq, 'ContextSequenceRoot.root_seq');
      const rightSeq = requireBigInt(right.root_seq, 'ContextSequenceRoot.root_seq');
      return leftSeq < rightSeq ? -1 : leftSeq > rightSeq ? 1 : String(left.id).localeCompare(String(right.id));
    });

    const now = this.timestamp();
    const targetRootShape = await resolveForkRootShape(
      this.database,
      this.tokenEstimator,
      this.context,
      sourceRoot,
      command.sourceContextEndSegmentId
    );
    if (sourceMembership && targetRootShape.cut) {
      // Only a compression that precedes the cut belongs to the forked history, whatever root the
      // caller selected (the application forks from the pre-compression root instead).
      const precedence = new ForkCompressionPrecedence(
        this.database,
        command.sourceConversationId,
        requireBigInt(sourceMembership.message_seq, 'MessagePartOfConversation.message_seq')
      );
      if (!await precedence.precedesCut(targetRootShape.cut.records, targetRootShape.cut.index)) {
        throw new ConversationForkRejectedError(
          'Fork Context keeps a CompressionBlock made after the fork point; fork from its pre-compression history.'
        );
      }
    }
    const sharedRootNodeId = targetRootShape.rootNodeId;
    // root_seq is insertion order, not ancestry: edits/truncation can leave earlier roots with
    // revisions or suffixes absent from this fork. Keep only history reachable from the retained
    // prefix, expanding compression lineage so pre-compression message boundaries remain usable.
    const retainedSegmentIds = targetRootShape.segmentIds ?? (
      await this.context.materializeStructure(command.sourceContextRootId)
    ).records.map((record) => requireId(record.segment.id, 'ContextSegment.id'));
    const retainedLineage = await readForkContextLineage(this.database, retainedSegmentIds, command.sourceConversationId);
    const historicalSourceRoots = await retainedForkHistoryRoots(
      this.database, sourceContextRoots, command.sourceContextRootId, retainedLineage.segmentIds
    );
    const targetHead: ForkContextRootShape = {
      id: ids.targetRootId,
      rootNodeId: targetRootShape.rootNodeId,
      tailNodeId: targetRootShape.tailNodeId,
      tailSegmentCount: targetRootShape.tailSegmentCount,
      segmentCount: targetRootShape.segmentCount
    };
    const creationRoots = await retainedCreationRoots(
      this.database, this.tokenEstimator, ids.targetConversationId, targetHead, historicalSourceRoots, retainedLineage
    );
    const transcript = await prepareConversationForkSnapshot(this.database, {
      sourceConversationId: command.sourceConversationId,
      targetConversationId: ids.targetConversationId,
      ...(sourceMembership
        ? { boundaryMessageSeq: requireBigInt(sourceMembership.message_seq, 'MessagePartOfConversation.message_seq') }
        : {}),
      // Whole-root callers copy no transcript but still receive their own CompressionBlocks.
      contextSegmentIds: targetRootShape.segmentIds ?? retainedSegmentIds,
      targetAgentId: command.targetAgentId,
      contextRoots: {
        head: targetHead,
        history: new Map(historicalSourceRoots.map((root) => {
          const sourceRootId = requireId(root.id, 'ContextSequenceRoot.id');
          return [sourceRootId, forkHistoryRootId(ids.targetConversationId, sourceRootId)];
        })),
        creation: creationRoots.targets
      },
      now
    });
    if (sourceMembership) {
      // A direct caller can select an obsolete root even when the boundary revision is current.
      // Never commit a head whose retained message segments lack the copied target provenance.
      const copiedMessageSegments = new Map<string, number>();
      for (const step of transcript.inserts) {
        if (step.kind !== 'insert' || step.domain !== 'ContextSegmentSource'
          || step.row.source_kind !== 'message_revision') continue;
        const segmentId = requireId(step.row.segment_id, 'ContextSegmentSource.segment_id');
        copiedMessageSegments.set(segmentId, (copiedMessageSegments.get(segmentId) ?? 0) + 1);
      }
      for (const source of retainedLineage.messageSources) {
        if (copiedMessageSegments.get(requireId(source.segment_id, 'ContextSegmentSource.segment_id')) !== 1) {
          throw new Error('Fork Context prefix contains a MessageRevision outside the copied current transcript.');
        }
      }
    }
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('Conversation').assert(command.sourceConversationId, {
        status: sourceConversation.status
      }),
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').assert(command.sourceContextRootId, {
        conversation_id: command.sourceConversationId,
        root_node_id: sourceRoot.root_node_id,
        tail_node_id: sourceRoot.tail_node_id,
        tail_segment_count: sourceRoot.tail_segment_count,
        segment_count: sourceRoot.segment_count
      }),
      ...(sourceRevision
        ? [DOMAIN_REPOSITORIES.domain('MessageRevision').assert(command.sourceMessageRevisionId!, {
            message_id: sourceRevision.message_id,
            revision_seq: sourceRevision.revision_seq
          })]
        : []),
      ...(currentRevisionLink
        ? [DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').assert(
            requireId(currentRevisionLink.id, 'MessageCurrentRevisionLink.id'),
            {
              message_id: sourceRevision!.message_id,
              revision_id: command.expectedCurrentMessageRevisionId
            }
          )]
        : []),
      ...(sourceMembership
        ? [DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').assert(
            requireId(sourceMembership.id, 'MessagePartOfConversation.id'),
            { conversation_id: command.sourceConversationId, message_id: sourceMembership.message_id }
          )]
        : []),
      ...transcript.assertions,
      DOMAIN_REPOSITORIES.domain('AgentConversationLink').assertExactIds(
        { conversation_id: command.sourceConversationId },
        sourceAgentLinks.map((link) => requireId(link.id, 'AgentConversationLink.id'))
      ),
      ...sourceAgentLinks.map((link) => DOMAIN_REPOSITORIES.domain('AgentConversationLink').assert(
        requireId(link.id, 'AgentConversationLink.id'),
        {
          conversation_id: command.sourceConversationId,
          agent_id: link.agent_id,
          role: link.role
        }
      )),
      ...historicalSourceRoots.map((root) => DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').assert(
        requireId(root.id, 'ContextSequenceRoot.id'),
        {
          conversation_id: command.sourceConversationId,
          root_node_id: root.root_node_id,
          tail_node_id: root.tail_node_id,
          tail_segment_count: root.tail_segment_count,
          segment_count: root.segment_count
        }
      )),
      ...(sourceTurn
        ? [DOMAIN_REPOSITORIES.domain('Turn').assert(command.sourceTurnId!, {
            conversation_id: command.sourceConversationId
          })]
        : []),
      ...(sourceProjectLink && sourceProjectContext
        ? [
            DOMAIN_REPOSITORIES.domain('ConversationProjectLink').assert(
              requireId(sourceProjectLink.id, 'ConversationProjectLink.id'),
              {
                conversation_id: command.sourceConversationId,
                project_context_id: command.sourceProjectContextId,
                role: 'primary'
              }
            ),
            DOMAIN_REPOSITORIES.domain('ProjectContext').assert(command.sourceProjectContextId!, {
              kind: sourceProjectContext.kind,
              uri: sourceProjectContext.uri
            })
          ]
        : [DOMAIN_REPOSITORIES.domain('ConversationProjectLink').assertNone({
            conversation_id: command.sourceConversationId
          })]),
      DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: ids.targetConversationId,
        title: command.targetTitle,
        status: 'active',
        created_at: now,
        updated_at: now
      }),
      ...historicalSourceRoots.map((root) => DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
        id: forkHistoryRootId(ids.targetConversationId, requireId(root.id, 'ContextSequenceRoot.id')),
        conversation_id: ids.targetConversationId,
        root_node_id: root.root_node_id,
        tail_node_id: root.tail_node_id,
        tail_segment_count: requireBigInt(root.tail_segment_count, 'ContextSequenceRoot.tail_segment_count'),
        segment_count: requireBigInt(root.segment_count, 'ContextSequenceRoot.segment_count'),
        estimated_tokens: requireBigInt(root.estimated_tokens, 'ContextSequenceRoot.estimated_tokens'),
        created_at: now
      }, {
        column: 'root_seq',
        scope: { conversation_id: ids.targetConversationId }
      })),
      ...creationRoots.owned.map((root) => DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
        id: root.id,
        conversation_id: ids.targetConversationId,
        root_node_id: root.rootNodeId,
        tail_node_id: root.tailNodeId,
        tail_segment_count: root.tailSegmentCount,
        segment_count: root.segmentCount,
        estimated_tokens: root.estimatedTokens,
        created_at: now
      }, {
        column: 'root_seq',
        scope: { conversation_id: ids.targetConversationId }
      })),
      ...transcript.inserts,
      ...targetRootShape.nodeSteps,
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
        id: ids.targetRootId,
        conversation_id: ids.targetConversationId,
        root_node_id: targetRootShape.rootNodeId,
        tail_node_id: targetRootShape.tailNodeId,
        tail_segment_count: targetRootShape.tailSegmentCount,
        segment_count: targetRootShape.segmentCount,
        estimated_tokens: targetRootShape.estimatedTokens,
        created_at: now
      }, {
        column: 'root_seq',
        scope: { conversation_id: ids.targetConversationId }
      }),
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').insert({
        id: ids.targetHeadLinkId,
        conversation_id: ids.targetConversationId,
        root_id: ids.targetRootId,
        updated_at: now
      }),
      ...sourceAgentLinks.map((link) => DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        ...link,
        id: link.role === 'default'
          ? ids.targetAgentLinkId
          : stableId(
              'agent_conversation_link',
              JSON.stringify([ids.targetConversationId, requireId(link.id, 'AgentConversationLink.id')])
            ),
        conversation_id: ids.targetConversationId,
        agent_id: link.role === 'default' ? command.targetAgentId : link.agent_id,
        created_at: now,
        updated_at: now
      })),
      ...(command.sourceProjectContextId
        ? [conversationProjectLinkInsertStep({
            conversationId: ids.targetConversationId,
            projectContextId: command.sourceProjectContextId,
            now
          })]
        : []),
      DOMAIN_REPOSITORIES.domain('ConversationReuseLink').insert({
        id: ids.reuseLinkId,
        reuse_key: command.reuseKey,
        conversation_id: ids.targetConversationId,
        agent_id: command.targetAgentId,
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ConversationBranchLink').insert({
        id: ids.branchLinkId,
        target_conversation_id: ids.targetConversationId,
        source_conversation_id: command.sourceConversationId,
        source_message_revision_id: command.sourceMessageRevisionId ?? null,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ConversationOriginLink').insert({
        id: ids.originLinkId,
        conversation_id: ids.targetConversationId,
        source_conversation_id: command.sourceConversationId,
        source_turn_id: command.sourceTurnId ?? null,
        source_tool_call_id: null,
        source_message_revision_id: command.sourceMessageRevisionId ?? null,
        created_at: now
      })
    ];

    await options.beforeCommit?.();
    try {
      const commit = await this.database.transaction(steps);
      return {
        ...publicIds(ids),
        sharedRootNodeId,
        copiedMessageCount: transcript.copiedVisibleMessageCount,
        deduplicated: false,
        commitSeq: commit.commitSeq
      };
    } catch (error) {
      if (!isExpectedForkIdentityConflict(error)) throw error;
      const raced = await this.findReplay(command, ids);
      if (!raced) throw error;
      return raced;
    }
  }

  private async findReplay(
    command: ResolvedForkCommand,
    ids: ForkIds
  ): Promise<ConversationForkResult | null> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ConversationReuseLink').list({
        where: { reuse_key: command.reuseKey },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('Conversation').get(ids.targetConversationId),
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').get(ids.targetRootId),
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').get(ids.targetHeadLinkId),
      DOMAIN_REPOSITORIES.domain('AgentConversationLink').get(ids.targetAgentLinkId),
      DOMAIN_REPOSITORIES.domain('ConversationBranchLink').get(ids.branchLinkId),
      DOMAIN_REPOSITORIES.domain('ConversationOriginLink').get(ids.originLinkId),
      DOMAIN_REPOSITORIES.domain('ConversationProjectLink').list({
        where: { conversation_id: ids.targetConversationId },
        limit: 2
      })
    ]);
    const reuseRows = requireRows(snapshot.snapshot[0], 'ConversationReuseLink replay lookup');
    if (reuseRows.length === 0) return null;
    if (reuseRows.length !== 1) throw new Error(`Conversation reuse key ${command.reuseKey} is not unique.`);
    const reuse = reuseRows[0];
    const conversation = requireRow(snapshot.snapshot[1], `Conversation ${ids.targetConversationId}`);
    const root = requireRow(snapshot.snapshot[2], `ContextSequenceRoot ${ids.targetRootId}`);
    const head = requireRow(snapshot.snapshot[3], `ConversationContextHeadLink ${ids.targetHeadLinkId}`);
    const agentLink = requireRow(snapshot.snapshot[4], `AgentConversationLink ${ids.targetAgentLinkId}`);
    const branch = requireRow(snapshot.snapshot[5], `ConversationBranchLink ${ids.branchLinkId}`);
    const origin = requireRow(snapshot.snapshot[6], `ConversationOriginLink ${ids.originLinkId}`);
    const targetProjectLinks = requireRows(snapshot.snapshot[7], 'ConversationProjectLink replay lookup');
    if (targetProjectLinks.length > 1) {
      throw new Error(`Fork target Conversation ${ids.targetConversationId} has multiple project links.`);
    }
    if (targetProjectLinks[0] && targetProjectLinks[0].role !== 'primary') {
      throw new Error(`Fork target Conversation ${ids.targetConversationId} has a non-primary project link.`);
    }
    if (
      reuse.id !== ids.reuseLinkId
      || reuse.conversation_id !== ids.targetConversationId
      || reuse.agent_id !== command.targetAgentId
      || conversation.id !== ids.targetConversationId
      || root.conversation_id !== ids.targetConversationId
      || head.conversation_id !== ids.targetConversationId
      || head.root_id !== ids.targetRootId
      || agentLink.conversation_id !== ids.targetConversationId
      || agentLink.agent_id !== command.targetAgentId
      || agentLink.role !== 'default'
      || branch.target_conversation_id !== ids.targetConversationId
      || branch.source_conversation_id !== command.sourceConversationId
      || branch.source_message_revision_id !== (command.sourceMessageRevisionId ?? null)
      || origin.conversation_id !== ids.targetConversationId
      || origin.source_conversation_id !== command.sourceConversationId
      || origin.source_turn_id !== (command.sourceTurnId ?? null)
      || origin.source_tool_call_id !== null
      || origin.source_message_revision_id !== (command.sourceMessageRevisionId ?? null)
    ) {
      throw new Error(`Conversation fork identity ${command.reuseKey} was replayed with different facts.`);
    }
    return {
      ...publicIds(ids),
      sharedRootNodeId: nullableId(root.root_node_id, 'ContextSequenceRoot.root_node_id'),
      deduplicated: true
    };
  }

  private timestamp(): string {
    const value = this.now();
    if (typeof value !== 'string' || value.length === 0) throw new TypeError('Conversation fork clock returned an invalid timestamp.');
    return value;
  }
}

function normalizeForkCommand(command: ConversationForkCommand) {
  const idempotencyKey = requireText(command.idempotencyKey, 'idempotencyKey');
  const reuseKey = requireText(command.reuseKey, 'reuseKey');
  const sourceConversationId = requireId(command.sourceConversationId, 'sourceConversationId');
  const sourceContextRootId = requireId(command.sourceContextRootId, 'sourceContextRootId');
  const sourceContextEndSegmentId = optionalId(command.sourceContextEndSegmentId, 'sourceContextEndSegmentId');
  const sourceMessageRevisionId = optionalId(command.sourceMessageRevisionId, 'sourceMessageRevisionId');
  const expectedCurrentMessageRevisionId = optionalId(
    command.expectedCurrentMessageRevisionId,
    'expectedCurrentMessageRevisionId'
  );
  const sourceTurnId = optionalId(command.sourceTurnId, 'sourceTurnId');
  const targetConversationId = optionalId(command.targetConversationId, 'targetConversationId');
  const targetTitle = requireText(command.targetTitle, 'targetTitle');
  const targetAgentId = requireId(command.targetAgentId, 'targetAgentId');
  if (expectedCurrentMessageRevisionId && expectedCurrentMessageRevisionId !== sourceMessageRevisionId) {
    throw new TypeError('expectedCurrentMessageRevisionId must equal sourceMessageRevisionId.');
  }
  if (sourceMessageRevisionId && !sourceContextEndSegmentId) {
    throw new TypeError('sourceMessageRevisionId requires sourceContextEndSegmentId.');
  }
  return {
    idempotencyKey,
    reuseKey,
    sourceConversationId,
    sourceContextRootId,
    ...(sourceContextEndSegmentId ? { sourceContextEndSegmentId } : {}),
    ...(sourceMessageRevisionId ? { sourceMessageRevisionId } : {}),
    ...(expectedCurrentMessageRevisionId ? { expectedCurrentMessageRevisionId } : {}),
    ...(sourceTurnId ? { sourceTurnId } : {}),
    ...(targetConversationId ? { targetConversationId } : {}),
    targetTitle,
    targetAgentId
  };
}

type ResolvedForkCommand = ReturnType<typeof normalizeForkCommand> & {
  sourceProjectContextId?: string;
};

function forkIds(command: ResolvedForkCommand): ForkIds {
  const scope = JSON.stringify([
    command.idempotencyKey,
    command.reuseKey,
    command.sourceConversationId,
    command.sourceContextRootId,
    command.sourceContextEndSegmentId ?? null,
    command.sourceMessageRevisionId ?? null,
    command.sourceTurnId ?? null,
    command.targetConversationId ?? null,
    command.targetAgentId
  ]);
  const targetConversationId = command.targetConversationId ?? stableId('conversation', scope);
  return {
    targetConversationId,
    targetRootId: stableId('context_root', scope),
    targetHeadLinkId: stableId('context_head_link', scope),
    targetAgentLinkId: stableId('agent_conversation_link', scope),
    reuseLinkId: stableId('conversation_reuse_link', scope),
    branchLinkId: stableId('conversation_branch_link', scope),
    originLinkId: stableId('conversation_origin_link', scope)
  };
}

function publicIds(ids: ForkIds): Omit<ConversationForkResult, 'sharedRootNodeId' | 'deduplicated' | 'commitSeq'> {
  return {
    targetConversationId: ids.targetConversationId,
    targetRootId: ids.targetRootId,
    targetHeadLinkId: ids.targetHeadLinkId,
    reuseLinkId: ids.reuseLinkId,
    branchLinkId: ids.branchLinkId,
    originLinkId: ids.originLinkId
  };
}

function forkHistoryRootId(targetConversationId: string, sourceRootId: string): string {
  return stableId('context_root', JSON.stringify(['fork-history', targetConversationId, sourceRootId]));
}

function forkKeptCreationRootId(targetConversationId: string, shape: Omit<ForkContextRootShape, 'id'>): string {
  return stableId('context_root', JSON.stringify([
    'fork-kept-creation',
    targetConversationId,
    shape.rootNodeId,
    shape.tailNodeId,
    shape.tailSegmentCount.toString(),
    shape.segmentCount.toString()
  ]));
}

function stableId(kind: string, scope: string): string {
  const digest = createHash('sha256')
    .update('limcode-phase-f-conversation-fork\0')
    .update(kind)
    .update('\0')
    .update(scope)
    .digest('hex');
  return `${kind}_${digest}`;
}

function isExpectedForkIdentityConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed: conversation_reuse_link.reuse_key')
    || message.includes('UNIQUE constraint failed: conversation_reuse_link.id')
    || message.includes('UNIQUE constraint failed: conversation.id')
    || message.includes('UNIQUE constraint failed: conversation_branch_link.target_conversation_id')
    || message.includes('UNIQUE constraint failed: conversation_origin_link.conversation_id')
    || message.includes('UNIQUE constraint failed: conversation_project_link.conversation_id')
    || message.includes('UNIQUE constraint failed: conversation_project_link.id');
}

function requireRow(value: unknown, label: string): DomainRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value as DomainRow;
}

function requireRows(value: unknown, label: string): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} did not return rows.`);
  return value as DomainRow[];
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty id.`);
  return value.trim();
}

function optionalId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireId(value, label);
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
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new TypeError(`${label} must be an integer.`);
}

async function retainedForkHistoryRoots(
  database: RuntimeDatabase,
  roots: readonly DomainRow[],
  selectedRootId: string,
  retainedSegmentIds: ReadonlySet<string>
): Promise<DomainRow[]> {
  const candidates = roots.filter((root) => root.id !== selectedRootId);
  const nodes = new Map<string, DomainRow>();
  const tips = [...new Set(candidates.flatMap((root) => [root.root_node_id, root.tail_node_id])
    .filter((id): id is string => id !== null).map((id) => requireId(id, 'ContextSequenceNode.id')))];
  for (let offset = 0; offset < tips.length; offset += 256) {
    const batch = tips.slice(offset, offset + 256);
    const snapshot = await database.snapshot(batch.map((id) => DOMAIN_REPOSITORIES.domain('ContextSequenceNode').get(id)));
    batch.forEach((id, index) => nodes.set(id, requireRow(snapshot.snapshot[index], `ContextSequenceNode ${id}`)));
  }
  // Memoize immutable parent chains, not materialized roots. Appending R segments creates R
  // overlapping roots; expanding every root is quadratic. Repeated segment occurrences remain
  // valid: no comparison between occurrence counts and a set's cardinality is used here.
  const retained = new Map<string | null, boolean>([[null, true]]);
  const chainRetained = async (tip: string | null): Promise<boolean> => {
    let cursor = tip;
    const trail = new Set<string>();
    while (!retained.has(cursor)) {
      const id = requireId(cursor, 'ContextSequenceNode.id');
      if (trail.has(id)) throw new Error(`Fork history Context node cycle at ${id}.`);
      trail.add(id);
      let node = nodes.get(id);
      if (!node) {
        const snapshot = await database.snapshot([DOMAIN_REPOSITORIES.domain('ContextSequenceNode').get(id)]);
        node = requireRow(snapshot.snapshot[0], `ContextSequenceNode ${id}`);
        nodes.set(id, node);
      }
      if (!retainedSegmentIds.has(requireId(node.segment_id, 'ContextSequenceNode.segment_id'))) {
        retained.set(id, false);
        break;
      }
      cursor = nullableId(node.parent_node_id, 'ContextSequenceNode.parent_node_id');
    }
    const compatible = retained.get(cursor)!;
    for (const id of trail) retained.set(id, compatible);
    return compatible;
  };
  const result: DomainRow[] = [];
  for (const root of candidates) {
    if (await chainRetained(nullableId(root.root_node_id, 'ContextSequenceRoot.root_node_id'))
      && await chainRetained(nullableId(root.tail_node_id, 'ContextSequenceRoot.tail_node_id'))) result.push(root);
  }
  return result;
}

interface ForkCreationRoots {
  /** Source pre-compression root of a kept block -> the target root holding exactly its kept part. */
  targets: Map<string, string>;
  /** Kept parts that no copied root holds; the fork inserts its own history root for each. */
  owned: Array<ForkContextRootShape & { estimatedTokens: bigint }>;
}

/**
 * A kept block's pre-compression root can run past the retained history when a delete, retry or
 * truncating edit later discarded its end (for example the transcript of the Turn that compressed).
 * The copied block's creation projection then points at the fork root holding exactly its kept
 * part: the head or a copied history root of that shape, otherwise a history root the fork inserts
 * over the existing immutable nodes. A compression writes its output root in one step, so a later
 * compression over that root finds no source root for part of its tail. A root rewritten before
 * its end while later parts stay history (an in-place edit) has no kept part and is left unmapped.
 */
async function retainedCreationRoots(
  database: RuntimeDatabase,
  tokenEstimator: ReliableContextTokenEstimator,
  targetConversationId: string,
  head: ForkContextRootShape,
  historicalRoots: readonly DomainRow[],
  lineage: ForkContextLineage
): Promise<ForkCreationRoots> {
  const historical = new Set(historicalRoots.map((root) => requireId(root.id, 'ContextSequenceRoot.id')));
  const targets = new Map<string, string>();
  const owned = new Map<string, ForkCreationRoots['owned'][number]>();
  for (const { creationProjection } of lineage.compressionBlocks) {
    const creationRootId = requireId(creationProjection.root_id, 'ModelContextProjection.root_id');
    if (historical.has(creationRootId) || targets.has(creationRootId)) continue;
    const records = (await database.materializeContext(creationRootId)).snapshot.records;
    const retained = (record: StructuralContextRecord) => lineage.segmentIds.has(requireId(record.segment.id, 'ContextSegment.id'));
    const firstDiscarded = records.findIndex((record) => !retained(record));
    const end = firstDiscarded < 0 ? records.length : firstDiscarded;
    if (end === 0 || records.slice(end).some(retained)) continue;
    const compressed = records[0].segment.segment_kind === 'compression';
    const last = requireId(records[end - 1].node.id, 'ContextSequenceNode.id');
    const shape = {
      rootNodeId: compressed ? requireId(records[0].node.id, 'ContextSequenceNode.id') : last,
      tailNodeId: compressed && end > 1 ? last : null,
      tailSegmentCount: compressed ? BigInt(end - 1) : 0n,
      segmentCount: BigInt(end)
    };
    const sameShape = (root: Omit<ForkContextRootShape, 'id'>) => root.rootNodeId === shape.rootNodeId
      && root.tailNodeId === shape.tailNodeId
      && root.tailSegmentCount === shape.tailSegmentCount
      && root.segmentCount === shape.segmentCount;
    if (sameShape(head)) {
      targets.set(creationRootId, head.id);
      continue;
    }
    const copied = historicalRoots.find((root) => sameShape({
      rootNodeId: nullableId(root.root_node_id, 'ContextSequenceRoot.root_node_id'),
      tailNodeId: nullableId(root.tail_node_id, 'ContextSequenceRoot.tail_node_id'),
      tailSegmentCount: requireBigInt(root.tail_segment_count, 'ContextSequenceRoot.tail_segment_count'),
      segmentCount: requireBigInt(root.segment_count, 'ContextSequenceRoot.segment_count')
    }));
    if (copied) {
      targets.set(creationRootId, forkHistoryRootId(targetConversationId, requireId(copied.id, 'ContextSequenceRoot.id')));
      continue;
    }
    const id = forkKeptCreationRootId(targetConversationId, shape);
    if (!owned.has(id)) {
      owned.set(id, {
        id,
        ...shape,
        estimatedTokens: BigInt(await tokenEstimator.estimateRootPrefix(creationRootId, end))
      });
    }
    targets.set(creationRootId, id);
  }
  return { targets, owned: [...owned.values()] };
}

/**
 * The fork's own Context: the source prefix ending at the selected segment, followed by the native
 * results that settled after that cut (appended as new content-addressed nodes), never the later
 * history the cut excludes. Native closure is checked over exactly this segment list.
 */
async function resolveForkRootShape(
  database: RuntimeDatabase,
  tokenEstimator: ReliableContextTokenEstimator,
  context: ContextSequenceControlPlane,
  sourceRoot: DomainRow,
  endSegmentId: string | undefined
): Promise<ForkRootShape> {
  const rootId = requireId(sourceRoot.id, 'ContextSequenceRoot.id');
  const conversationId = requireId(sourceRoot.conversation_id, 'ContextSequenceRoot.conversation_id');
  const materialized = await database.materializeContext(rootId);
  const records = materialized.snapshot.records;
  if (!endSegmentId) {
    await context.assertNativeSegmentsClosed(conversationId, records);
    return {
      rootNodeId: nullableId(sourceRoot.root_node_id, 'ContextSequenceRoot.root_node_id'),
      tailNodeId: nullableId(sourceRoot.tail_node_id, 'ContextSequenceRoot.tail_node_id'),
      tailSegmentCount: requireBigInt(sourceRoot.tail_segment_count, 'ContextSequenceRoot.tail_segment_count'),
      segmentCount: requireBigInt(sourceRoot.segment_count, 'ContextSequenceRoot.segment_count'),
      estimatedTokens: requireBigInt(sourceRoot.estimated_tokens, 'ContextSequenceRoot.estimated_tokens'),
      nodeSteps: []
    };
  }
  const endIndex = records.findIndex((record) => record.segment.id === endSegmentId);
  if (endIndex < 0) throw new Error(`Fork Context boundary segment ${endSegmentId} is not part of source root ${rootId}.`);
  const prefix = records.slice(0, endIndex + 1);
  const first = prefix[0];
  const last = prefix[prefix.length - 1];
  if (!first || !last) throw new Error('Fork Context boundary cannot produce an empty root.');
  const lateSegmentIds = await context.lateNativeResultSegmentIds(conversationId, records, endIndex);
  const late = lateSegmentIds.map((segmentId) => records.find((record) => record.segment.id === segmentId)!);
  const retained = [...prefix, ...late];
  await context.assertNativeSegmentsClosed(conversationId, retained);
  const suffix = context.planSuffixNodes(
    requireId(last.node.id, 'ContextSequenceNode.id'),
    lateSegmentIds,
    'fork_late_native_result_nodes'
  );
  const tailId = suffix.nodeIds.at(-1) ?? requireId(last.node.id, 'ContextSequenceNode.id');
  let estimatedTokens = await tokenEstimator.estimateRootPrefix(rootId, prefix.length);
  if (late.length > 0) {
    const segments = (await context.materialize(rootId)).segments;
    for (const segmentId of lateSegmentIds) {
      estimatedTokens += estimateContextSegmentTokens(segments.find((segment) => segment.segmentId === segmentId)!);
    }
  }
  const compressed = first.segment.segment_kind === 'compression';
  return {
    rootNodeId: requireId(compressed ? first.node.id : tailId, 'ContextSequenceNode.id'),
    tailNodeId: compressed && retained.length > 1 ? tailId : null,
    tailSegmentCount: compressed ? BigInt(retained.length - 1) : 0n,
    segmentCount: BigInt(retained.length),
    segmentIds: retained.map((record) => requireId(record.segment.id, 'ContextSegment.id')),
    estimatedTokens: BigInt(estimatedTokens),
    nodeSteps: suffix.steps,
    cut: { records, index: endIndex }
  };
}
