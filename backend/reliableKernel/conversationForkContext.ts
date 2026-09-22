import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

/**
 * The selected fork point is permanently unusable for this command: it copies a turn that has not
 * terminated. A fork only owns completed history, so retrying the same command cannot succeed.
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
}

export interface NativeMessageContextRevision {
  revision: DomainRow;
  sources: DomainRow[];
  attachments: DomainRow[];
}

/** The selected immutable prefix includes the sources hidden behind its compression blocks. */
export async function readForkContextLineage(
  database: RuntimeDatabase,
  rootSegmentIds: readonly string[]
): Promise<ForkContextLineage> {
  const segmentIds = new Set<string>();
  const messageSources: DomainRow[] = [];
  const contentObjectIds = new Map<string, string>();
  const childrenBySegment = new Map<string, string[]>();
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
      const compressed: Array<{ segmentId: string; blockId: string }> = [];
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
          if (sources.length !== 1 || sources[0].source_kind !== 'compression_block') {
            throw new Error(`Compression segment ${segmentId} lacks its unique block source.`);
          }
          compressed.push({ segmentId, blockId: requireId(sources[0].source_id, 'ContextSegmentSource.source_id') });
        }
      }
      if (compressed.length === 0) continue;
      const blocks = await database.snapshot([
        ...compressed.map(({ blockId }) => DOMAIN_REPOSITORIES.domain('CompressionBlock').get(blockId)),
        ...compressed.map(({ blockId }) => DOMAIN_REPOSITORIES.domain('CompressionBlockSource').list({
          where: { compression_block_id: blockId }, limit: 257
        }))
      ]);
      for (const [index, { segmentId, blockId }] of compressed.entries()) {
        const block = requireRow(blocks.snapshot[index], `CompressionBlock ${blockId}`);
        if (block.summary_object_id !== contentObjectIds.get(segmentId)) {
          throw new Error(`Compression segment ${segmentId} does not reference its block summary.`);
        }
        const first = requireRows(blocks.snapshot[compressed.length + index], 'CompressionBlockSource');
        const sources = first.length < 257 ? first : await listAllDomainRows(database, 'CompressionBlockSource', {
          compression_block_id: blockId
        });
        if (sources.length === 0) throw new Error(`CompressionBlock ${blockId} has no registered sources.`);
        sources.sort((left, right) => compareIntegers(left.position, right.position));
        const children = sources.map((source, position) => {
          if (source.position !== BigInt(position)) throw new Error(`CompressionBlock ${blockId} source order is invalid.`);
          return requireId(source.segment_id, 'CompressionBlockSource.segment_id');
        });
        childrenBySegment.set(segmentId, children);
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
  return { segmentIds, messageSources, contentObjectIds };
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
    const segmentId = requireId(node.segment_id, 'ContextSequenceNode.segment_id');
    let kind = this.segmentKinds.get(segmentId);
    if (kind === undefined) {
      const result = await this.database.snapshot([DOMAIN_REPOSITORIES.domain('ContextSegment').get(segmentId)]);
      kind = requireId(requireRow(result.snapshot[0], 'ContextSegment').segment_kind, 'ContextSegment.segment_kind');
      this.segmentKinds.set(segmentId, kind);
    }
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
