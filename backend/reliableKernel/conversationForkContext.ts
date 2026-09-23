import { resolveConversationCompressionBlock, selectConversationCompressionBlock } from './compressionBlockOwnership';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

/**
 * The fork command can never succeed, so retrying the same command is pointless and it leaves
 * nothing behind (the application removes settings an earlier attempt copied). Causes: the fork
 * point is gone or changed (missing source Conversation, a Message without a current Revision or of
 * another Conversation, a changed Revision, a deleted fork-point Message, no completed history for
 * fork_conversation); the copy would include history that is not completed (a Turn still running,
 * or a compression made after the fork point, including one whose pre-compression history was
 * rewritten in place); the copy would include a block without its creation projection (a fork made
 * before copied blocks always kept it); or the command is replayed with different source facts.
 */
export class ConversationForkRejectedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConversationForkRejectedError';
  }
}

export interface ForkContextLineage {
  segmentIds: ReadonlySet<string>;
  messageSources: readonly DomainRow[];
  contentObjectIds: ReadonlyMap<string, string>;
  /** The Conversation's own CompressionBlocks over every summary segment in the lineage. */
  compressionBlocks: readonly ForkLineageCompressionBlock[];
}

export interface ForkLineageCompressionBlock {
  summarySegmentId: string;
  block: DomainRow;
  /** The block's ContextSegmentSource row on the summary segment. */
  summarySource: DomainRow;
  /** Ordered CompressionBlockSource rows. */
  blockSources: readonly DomainRow[];
  /** The block's only ModelContextProjection: the root it compressed when it was created. */
  creationProjection: DomainRow;
}

export interface NativeMessageContextRevision {
  revision: DomainRow;
  sources: DomainRow[];
  attachments: DomainRow[];
}

/**
 * The selected immutable prefix includes the sources hidden behind its compression blocks. Summary
 * segments are shared by forks, so their lineage follows the blocks owned by this Conversation.
 */
export async function readForkContextLineage(
  database: RuntimeDatabase,
  rootSegmentIds: readonly string[],
  conversationId: string
): Promise<ForkContextLineage> {
  const segmentIds = new Set<string>();
  const messageSources: DomainRow[] = [];
  const contentObjectIds = new Map<string, string>();
  const childrenBySegment = new Map<string, string[]>();
  const compressionBlocks: ForkLineageCompressionBlock[] = [];
  let frontier = [...new Set(rootSegmentIds)];
  while (frontier.length > 0) {
    const next = new Set<string>();
    for (let offset = 0; offset < frontier.length; offset += 64) {
      const batch = frontier.slice(offset, offset + 64).filter(segmentId => !segmentIds.has(segmentId));
      if (batch.length === 0) continue;
      const snapshot = await database.snapshot([
        ...batch.map(segmentId => DOMAIN_REPOSITORIES.domain('ContextSegment').get(segmentId)),
        ...batch.map(segmentId => DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
          where: { segment_id: segmentId }, limit: 257
        }))
      ]);
      const compressed: Array<{ segmentId: string; blockId: string; summarySource: DomainRow }> = [];
      for (const [index, segmentId] of batch.entries()) {
        const segment = requireRow(snapshot.snapshot[index], `ContextSegment ${segmentId}`);
        const first = requireRows(snapshot.snapshot[batch.length + index], 'ContextSegmentSource');
        const sources = first.length < 257 ? first : await listAllDomainRows(database, 'ContextSegmentSource', {
          segment_id: segmentId
        });
        segmentIds.add(segmentId);
        contentObjectIds.set(segmentId, requireId(segment.content_object_id, 'ContextSegment.content_object_id'));
        for (const source of sources) {
          if (source.source_kind === 'message_revision') messageSources.push(source);
        }
        if (segment.segment_kind === 'compression') {
          const block = await selectConversationCompressionBlock(database, segmentId, conversationId, sources);
          const blockId = requireId(block.id, 'CompressionBlock.id');
          compressed.push({
            segmentId,
            blockId,
            summarySource: sources.find((source) => source.source_id === blockId)!
          });
        }
      }
      if (compressed.length === 0) continue;
      const blocks = await database.snapshot([
        ...compressed.map(({ blockId }) => DOMAIN_REPOSITORIES.domain('CompressionBlock').get(blockId)),
        ...compressed.map(({ blockId }) => DOMAIN_REPOSITORIES.domain('CompressionBlockSource').list({
          where: { compression_block_id: blockId }, limit: 257
        })),
        ...compressed.map(({ blockId }) => DOMAIN_REPOSITORIES.domain('ModelContextProjection').list({
          where: { owner_kind: 'compression_block', owner_id: blockId }, limit: 2
        }))
      ]);
      for (const [index, { segmentId, blockId, summarySource }] of compressed.entries()) {
        const block = requireRow(blocks.snapshot[index], `CompressionBlock ${blockId}`);
        if (block.summary_object_id !== contentObjectIds.get(segmentId)) {
          throw new Error(`Compression segment ${segmentId} does not reference its block summary.`);
        }
        const first = requireRows(blocks.snapshot[compressed.length + index], 'CompressionBlockSource');
        const sources = first.length < 257 ? first : await listAllDomainRows(database, 'CompressionBlockSource', {
          compression_block_id: blockId
        });
        if (sources.length === 0) throw new Error(`CompressionBlock ${blockId} has no registered sources.`);
        const projections = requireRows(blocks.snapshot[compressed.length * 2 + index], 'ModelContextProjection');
        // Only a fork made before copied blocks always kept their creation projection lacks one;
        // forking after such a block can never succeed.
        if (projections.length === 0) {
          throw new ConversationForkRejectedError(
            `CompressionBlock ${blockId} has no creation projection; fork from its pre-compression history.`
          );
        }
        if (projections.length !== 1) throw new Error(`CompressionBlock ${blockId} must have exactly one creation projection.`);
        sources.sort((left, right) => compareIntegers(left.position, right.position));
        const children = sources.map((source, position) => {
          if (source.position !== BigInt(position)) throw new Error(`CompressionBlock ${blockId} source order is invalid.`);
          return requireId(source.segment_id, 'CompressionBlockSource.segment_id');
        });
        childrenBySegment.set(segmentId, children);
        compressionBlocks.push({
          summarySegmentId: segmentId, block, summarySource, blockSources: sources, creationProjection: projections[0]
        });
        for (const child of children) if (!segmentIds.has(child)) next.add(child);
      }
    }
    frontier = [...next];
  }
  const visited = new Set<string>();
  const path = new Set<string>();
  function visit(segmentId: string): void {
    if (path.has(segmentId)) throw new Error(`Compression lineage cycle detected at ${segmentId}.`);
    if (visited.has(segmentId)) return;
    path.add(segmentId);
    for (const child of childrenBySegment.get(segmentId) ?? []) visit(child);
    path.delete(segmentId);
    visited.add(segmentId);
  }
  for (const segmentId of rootSegmentIds) visit(segmentId);
  return { segmentIds, messageSources, contentObjectIds, compressionBlocks };
}

interface CompressionPrecedenceFacts {
  /** Segment ids of the tail the block's pre-compression root kept after its compressed range. */
  creationTail: readonly string[];
}

/**
 * Whether a compressed root may supply a fork prefix. A fork owns completed history only, so the
 * compression must precede the cut: the cut never lies strictly inside the tail that existed when
 * the block was created (its pre-compression projection root), and the Turn that compressed has
 * ended inside the kept history — it owns kept visible transcript, or none at all like a manual
 * compression Turn or a Turn whose transcript was deleted. Otherwise the pre-compression root holds
 * the same prefix uncompressed and the caller forks from it instead. Facts are memoized per summary
 * segment across the caller's candidate roots.
 */
export class ForkCompressionPrecedence {
  private readonly facts = new Map<string, Promise<CompressionPrecedenceFacts | null>>();

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly conversationId: string,
    private readonly boundaryMessageSeq: bigint
  ) {}

  public async precedesCut(records: readonly { node: DomainRow; segment: DomainRow }[], cutIndex: number): Promise<boolean> {
    const summary = records[0]?.segment;
    if (!summary || summary.segment_kind !== 'compression') return true;
    if (!records[cutIndex]) throw new Error('Fork cut is outside the candidate Context root.');
    const resolved = await this.factsFor(requireId(summary.id, 'ContextSegment.id'));
    if (!resolved) return false;
    // Strictly inside: the kept tail up to the cut is still exactly the history the block was
    // created over, and part of that history still follows the cut in this root. Creation history
    // after the cut that a delete or retry discarded is no longer history. Segments, not nodes,
    // identify that history, because a delete or edit rebuilds the nodes of a compressed tail.
    const tail = resolved.creationTail;
    if (cutIndex >= tail.length) return true;
    for (let index = 1; index <= cutIndex; index += 1) {
      if (records[index].segment.id !== tail[index - 1]) return true;
    }
    const later = new Set(records.slice(cutIndex + 1).map((record) => requireId(record.segment.id, 'ContextSegment.id')));
    return !tail.slice(cutIndex).some((segmentId) => later.has(segmentId));
  }

  /**
   * False when no cut can follow this summary's compression (its Turn is not kept, or its creation
   * projection is unusable), so a caller can skip a candidate root without reading it.
   */
  public async mayPrecede(summarySegmentId: string): Promise<boolean> {
    return (await this.factsFor(summarySegmentId)) !== null;
  }

  private factsFor(summarySegmentId: string): Promise<CompressionPrecedenceFacts | null> {
    let facts = this.facts.get(summarySegmentId);
    if (!facts) {
      facts = this.readFacts(summarySegmentId);
      this.facts.set(summarySegmentId, facts);
    }
    return facts;
  }

  private async readFacts(summarySegmentId: string): Promise<CompressionPrecedenceFacts | null> {
    const block = await resolveConversationCompressionBlock(this.database, summarySegmentId, this.conversationId);
    if (!await this.compressingTurnIsKept(block)) return null;
    const blockId = requireId(block.id, 'CompressionBlock.id');
    const [projections, sources] = await Promise.all([
      listAllDomainRows(this.database, 'ModelContextProjection', { owner_kind: 'compression_block', owner_id: blockId }),
      listAllDomainRows(this.database, 'CompressionBlockSource', { compression_block_id: blockId })
    ]);
    if (projections.length !== 1) return null;
    const creation = (await this.database.materializeContext(
      requireId(projections[0].root_id, 'ModelContextProjection.root_id')
    )).snapshot;
    if (creation.root.conversation_id !== this.conversationId) return null;
    sources.sort((left, right) => compareIntegers(left.position, right.position));
    if (sources.length > creation.records.length
      || sources.some((source, index) => source.segment_id !== creation.records[index].segment.id)) {
      throw new Error(`CompressionBlock ${blockId} creation projection does not start with its compressed range.`);
    }
    return {
      creationTail: creation.records.slice(sources.length).map((record) => requireId(record.segment.id, 'ContextSegment.id'))
    };
  }

  private async compressingTurnIsKept(block: DomainRow): Promise<boolean> {
    const authority = await this.database.snapshot([DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').get(
      requireId(block.authority_snapshot_id, 'CompressionBlock.authority_snapshot_id')
    )]);
    const snapshot = optionalRow(authority.snapshot[0], 'AuthoritySnapshot');
    if (!snapshot) return false;
    const turnId = requireId(snapshot.turn_id, 'AuthoritySnapshot.turn_id');
    const [turnRead, visible] = await Promise.all([
      this.database.snapshot([DOMAIN_REPOSITORIES.domain('Turn').get(turnId)]),
      readVisibleTurnMessages(this.database, this.conversationId, turnId)
    ]);
    const turn = optionalRow(turnRead.snapshot[0], 'Turn');
    if (!turn || turn.status !== 'terminated') return false;
    // A Turn without visible transcript (a manual compression, or one whose output a delete or
    // retry discarded) is placed by the creation tail alone.
    return visible.length === 0 || visible.some((message) => message.messageSeq <= this.boundaryMessageSeq);
  }
}

/**
 * The Messages of a Turn that are still visible history of the Conversation. Output a delete, retry
 * or edit soft-deleted keeps its Turn links but no longer belongs to the transcript.
 */
export async function readVisibleTurnMessages(
  database: RuntimeDatabase,
  conversationId: string,
  turnId: string
): Promise<Array<{ messageId: string; messageSeq: bigint }>> {
  const links = await listAllDomainRows(database, 'MessageTurnLink', { turn_id: turnId });
  const messageIds = [...new Set(links.map((link) => requireId(link.message_id, 'MessageTurnLink.message_id')))];
  if (messageIds.length === 0) return [];
  const read = await database.snapshot(messageIds.flatMap((messageId) => [
    DOMAIN_REPOSITORIES.domain('Message').get(messageId),
    DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({
      where: { conversation_id: conversationId, message_id: messageId }, limit: 2
    })
  ]));
  return messageIds.flatMap((messageId, index) => {
    const message = optionalRow(read.snapshot[index * 2], 'Message');
    const [membership] = requireRows(read.snapshot[index * 2 + 1], 'MessagePartOfConversation');
    if (!message || message.deleted_at !== null || !membership) return [];
    if (typeof membership.message_seq !== 'bigint') throw new Error('MessagePartOfConversation.message_seq is invalid.');
    return [{ messageId, messageSeq: membership.message_seq }];
  });
}

/** Native UI aggregates do not own Context; their immutable item revisions do. */
export async function readNativeMessageContextRevisions(
  database: RuntimeDatabase,
  messageId: string
): Promise<NativeMessageContextRevision[]> {
  const revisions = await listAllDomainRows(database, 'MessageRevision', { message_id: messageId });
  const result: NativeMessageContextRevision[] = [];
  for (let offset = 0; offset < revisions.length; offset += 64) {
    const batch = revisions.slice(offset, offset + 64).filter(revision => revision.role === 'model');
    if (batch.length === 0) continue;
    const snapshot = await database.snapshot([
      ...batch.map(revision => DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
        where: { source_kind: 'message_revision', source_id: requireId(revision.id, 'MessageRevision.id') }, limit: 257
      })),
      ...batch.map(revision => DOMAIN_REPOSITORIES.domain('AttachmentLink').list({
        where: { message_revision_id: requireId(revision.id, 'MessageRevision.id') }, limit: 257
      }))
    ]);
    for (const [index, revision] of batch.entries()) {
      const revisionId = requireId(revision.id, 'MessageRevision.id');
      const firstSources = requireRows(snapshot.snapshot[index], 'ContextSegmentSource');
      const sources = firstSources.length < 257 ? firstSources : await listAllDomainRows(database, 'ContextSegmentSource', {
        source_kind: 'message_revision', source_id: revisionId
      });
      if (sources.length === 0) continue;
      for (const source of sources) {
        if (source.source_revision !== revision.revision_seq) {
          throw new Error(`MessageRevision ${revisionId} has a mismatched Context source revision.`);
        }
      }
      const firstAttachments = requireRows(snapshot.snapshot[batch.length + index], 'AttachmentLink');
      const attachments = firstAttachments.length < 257 ? firstAttachments : await listAllDomainRows(database, 'AttachmentLink', {
        message_revision_id: revisionId
      });
      result.push({ revision, sources, attachments });
    }
  }
  return result;
}

/**
 * Request-local negative filter, not a replacement for materialization/suffix validation.
 * The target set is copied once. Each immutable node has one state (depth and distance to
 * the nearest selected segment), independent of root/window length. Thus overlapping
 * compressed tails cost O(distinct physical nodes + candidate roots), not O(sum tail sizes).
 */
export class ForkContextCandidateProbe {
  private readonly targets: ReadonlySet<string>;
  private readonly nodes = new Map<string, DomainRow>();
  private readonly states = new Map<string, { depth: number; nearest: number }>();
  private readonly segmentKinds = new Map<string, string>();
  private windows = 0;

  public constructor(private readonly database: RuntimeDatabase, segmentIds: ReadonlySet<string>) {
    this.targets = new Set(segmentIds);
    if (this.targets.size === 0) throw new Error('Fork candidate target segments are empty.');
  }

  public get metrics(): { nodeReads: number; segmentReads: number; cacheStates: number; windowChecks: number } {
    return { nodeReads: this.nodes.size, segmentReads: this.segmentKinds.size,
      cacheStates: this.states.size, windowChecks: this.windows };
  }

  public async mayContain(root: DomainRow): Promise<boolean> {
    const count = this.count(root.segment_count, 'segment_count');
    const tailCount = this.count(root.tail_segment_count, 'tail_segment_count');
    const rootId = this.pointer(root.root_node_id);
    const tailId = this.pointer(root.tail_node_id);
    if (rootId === null) {
      if (tailId !== null || tailCount !== 0 || count !== 0) throw new Error('Invalid empty Fork candidate root.');
      return false;
    }
    const node = await this.node(rootId);
    const kind = await this.segmentKind(requireId(node.segment_id, 'ContextSequenceNode.segment_id'));
    if (kind === 'compression') {
      if (node.parent_node_id !== null || count !== tailCount + 1 || (tailId === null) !== (tailCount === 0)) {
        throw new Error('Invalid compression Fork candidate window.');
      }
      // A tail can physically point behind the compressed boundary. Only its last tailCount
      // occurrences are visible; matching an older physical ancestor must not admit this root.
      const summaryHit = await this.window(rootId, 1, true);
      const tailHit = tailId === null ? false : await this.window(tailId, tailCount, false);
      return summaryHit || tailHit;
    }
    if (tailId !== null || tailCount !== 0) throw new Error('Invalid ordinary Fork candidate tail.');
    return this.window(rootId, count, true);
  }

  /** The summary segment a compressed candidate root starts with; null for an ordinary root. */
  public async compressionSummary(root: DomainRow): Promise<string | null> {
    const rootId = this.pointer(root.root_node_id);
    if (rootId === null) return null;
    const segmentId = requireId((await this.node(rootId)).segment_id, 'ContextSequenceNode.segment_id');
    return await this.segmentKind(segmentId) === 'compression' ? segmentId : null;
  }

  private async segmentKind(segmentId: string): Promise<string> {
    let kind = this.segmentKinds.get(segmentId);
    if (kind === undefined) {
      const result = await this.database.snapshot([DOMAIN_REPOSITORIES.domain('ContextSegment').get(segmentId)]);
      kind = requireId(requireRow(result.snapshot[0], 'ContextSegment').segment_kind, 'ContextSegment.segment_kind');
      this.segmentKinds.set(segmentId, kind);
    }
    return kind;
  }

  private async window(tip: string, length: number, exactDepth: boolean): Promise<boolean> {
    this.windows += 1;
    const state = await this.state(tip);
    if (length === 0 || state.depth < length || (exactDepth && state.depth !== length)) {
      throw new Error('Fork candidate node chain/count mismatch.');
    }
    return state.nearest < length;
  }

  private async state(tip: string): Promise<{ depth: number; nearest: number }> {
    const path: Array<{ id: string; node: DomainRow }> = [];
    const visiting = new Set<string>();
    let cursor: string | null = tip;
    while (cursor !== null && !this.states.has(cursor)) {
      if (visiting.has(cursor)) throw new Error('Fork candidate node chain cycle.');
      visiting.add(cursor);
      const node = await this.node(cursor);
      path.push({ id: cursor, node });
      cursor = this.pointer(node.parent_node_id);
    }
    let previous = cursor === null ? { depth: 0, nearest: Infinity } : this.states.get(cursor)!;
    for (const { id, node } of path.reverse()) {
      const depth = previous.depth + 1;
      if (!Number.isSafeInteger(depth)) throw new Error('Fork candidate node chain is too deep.');
      previous = { depth, nearest: this.targets.has(requireId(node.segment_id, 'ContextSequenceNode.segment_id'))
        ? 0 : previous.nearest + 1 };
      this.states.set(id, previous);
    }
    return this.states.get(tip)!;
  }

  private async node(id: string): Promise<DomainRow> {
    const cached = this.nodes.get(id);
    if (cached) return cached;
    const result = await this.database.snapshot([DOMAIN_REPOSITORIES.domain('ContextSequenceNode').get(id)]);
    const node = requireRow(result.snapshot[0], `ContextSequenceNode ${id}`);
    this.nodes.set(id, node);
    return node;
  }

  private count(value: unknown, label: string): number {
    if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Invalid Fork candidate ${label}.`);
    }
    return Number(value);
  }

  private pointer(value: unknown): string | null {
    return value === null ? null : requireId(value, 'ContextSequenceNode pointer');
  }
}

function requireRow(value: unknown, label: string): DomainRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is missing.`);
  return value as DomainRow;
}

function optionalRow(value: unknown, label: string): DomainRow | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} snapshot is invalid.`);
  return value as DomainRow;
}

function requireRows(value: unknown, label: string): DomainRow[] {
  if (!Array.isArray(value)) throw new Error(`${label} snapshot is invalid.`);
  return value as DomainRow[];
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is invalid.`);
  return value;
}

function compareIntegers(left: unknown, right: unknown): number {
  if (typeof left !== 'bigint' || typeof right !== 'bigint') throw new Error('Compression source position is invalid.');
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isNativeRequest(request: DomainRow): boolean {
  const stats = request.stream_stats_json;
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return false;
  const capabilities = (stats as Record<string, unknown>).nativeCapabilities;
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) return false;
  const flags = capabilities as Record<string, unknown>;
  return flags.asyncTools === true || flags.steering === true
    || flags.reasoningUpdates === true || flags.multiplexing === true;
}
