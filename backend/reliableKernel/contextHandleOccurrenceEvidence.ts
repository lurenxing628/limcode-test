import { resolveFrozenModelHandleCatalog } from './frozenModelHandleCatalog';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import { ContextSequenceControlPlane, type MaterializedContextStructure } from './contextSequence';
import { compressionBlockIdFor } from './contextCompression';
import { ContextHandleReadMemo } from './contextHandleReadMemo';
import { CONTEXT_HANDLE_STATE_DOMAIN, CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN, conversationContextHandleStateId,
  readCatalogForRow } from './conversationContextHandleState';
import { conversationForkSnapshotCopyId } from './conversationForkSnapshot';
import { readForkContextHandleReservationEvidence } from './forkContextHandleReservations';
import { readHistoricalCompressionHandleCatalog } from './historicalCompressionHandleCatalog';
import { buildModelHandleCatalog, CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION,
  isCollaborationHandleTool, isPersistentContextHandle, normalizeModelHandleCatalog,
  mergeModelHandleCatalogs, ModelHandleIdentityConflictError,
  reconcileHistoricalModelHandleCatalogs, type ModelHandleCatalog,
  type ModelHandleEntry, type ModelHandleKind } from './modelHandleCatalog';
import { modelRequestIdFor } from './modelProviderControlPlane';
import { parseNativeToolCallCheckpoint } from './nativeToolFacts';
import type { PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import type { RuntimeDatabase } from './runtimeDatabase';
import { nativeItemRevisionId } from './turnOutput';
import { projectTurnReminder, recipeReinjectedCurrentTurnInput, recipeSentClaudeTurnScopedReminders } from './turnReminderProjection';

/** A producer lookup is private. Only identities used by this immutable occurrence are published. */
export type ContextHandleOccurrenceEvidence =
  | { kind: 'message'; modelRequestId?: string; content: string | Uint8Array; contentType?: string }
  | { kind: 'compression'; modelRequestId?: string; compressionBlockId?: string; content: string | Uint8Array }
  | { kind: 'tool_call'; toolCallId: string }
  | { kind: 'tool_result'; toolCallId: string; toolModelResultId: string };

export type ContextHandleAllocationHighWater = Partial<Record<ModelHandleKind, number>>;
export interface ContextHandleProducerScope {
  conversationId: string; rootId: string | null; provenanceRevision: string; resetFence: string;
}
export interface ContextHandleRootCheckpoint {
  rootId: string;
  nextOccurrence: number;
  /** Selected facts retain their original legacy/current marker until final reconciliation. */
  facts: ModelHandleCatalog[];
  allocationHighWater: ContextHandleAllocationHighWater;
}
export interface ContextHandleRootEvidenceOptions {
  signal?: AbortSignal;
  /** Exact retained prefix/selection, including caller-proved late native results when forking. */
  segmentIds?: readonly string[];
  baseCatalog?: ModelHandleCatalog;
  resume?: ContextHandleRootCheckpoint;
  /** Explicit recovery may reuse a same-generation prefix only behind a producer-free user tail. */
  prefixProvenanceRevision?: bigint;
  onProgress?(progress: { completedRequests: number; totalRequests: number }): void;
  onCheckpoint?(checkpoint: ContextHandleRootCheckpoint): Promise<void>;
}
export interface ContextHandleRootEvidence {
  catalog: ModelHandleCatalog;
  allocationHighWater: ContextHandleAllocationHighWater;
  assertions: RepositoryTransactionStep[];
}

const NATIVE_PROJECTION = 'native_child_handle_projection';
const REF = /\b(?:P|O|A|W|C|M|R|H|T|B)[1-9]\d*\b/g;
const REF_KINDS: Record<string, ModelHandleKind> = { P: 'process', O: 'cursor', A: 'child', W: 'workEnvironment',
  C: 'conversation', M: 'collaborationMessage', R: 'conversationMessage', H: 'boardChannel', T: 'boardThread', B: 'boardPost' };
const empty = (): ModelHandleCatalog => ({ entries: [], retiredRefs: [],
  identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION });
interface RequestEvidence { request: DomainRow; conversationId: string; recipe: Record<string, unknown>; catalog: ModelHandleCatalog;
  reminder?: string; reinjectedContentId?: string; inputBindings?: ModelHandleCatalog; producerScope?: ContextHandleProducerScope }
interface ContextHandleEvidenceOrigin {
  source: 'frozen_recipe' | 'native_projection' | 'native_admission' | 'native_request_scope' | 'upgrade_checkpoint';
  requestId?: string;
  contentObjectId?: string;
  eventId?: string;
  rootId?: string;
  nextOccurrence?: number;
}
interface SegmentEvidence {
  id: string; kind: string; contentId: string;
  occurrences: ContextHandleOccurrenceEvidence[];
  messageRevision?: DomainRow;
  producerIds: string[];
  compressionBlock?: DomainRow;
}

export async function readContextHandleOccurrenceCatalog(database: RuntimeDatabase, store: ContentAddressedStore,
  occurrence: ContextHandleOccurrenceEvidence, baseCatalog: ModelHandleCatalog,
  onProducerScope?: (scope: ContextHandleProducerScope) => void | Promise<void>): Promise<ModelHandleCatalog> {
  const reader = new OccurrenceReader(database, store);
  reader.onProducerScope = onProducerScope;
  reader.reserve(baseCatalog);
  const facts = await reader.occurrence(occurrence, baseCatalog);
  return withFloor(reconcileHistoricalModelHandleCatalogs(facts, { allocationHighWater: reader.highWater }), reader.highWater);
}

/** Exact visible input values select a subset of the already allocated request-private lookup. */
export function selectContextHandleBindings(values: readonly unknown[], catalogInput: ModelHandleCatalog): ModelHandleCatalog {
  const catalog = normalizeModelHandleCatalog(catalogInput);
  const refs = new Set<string>();
  const scan = (value: unknown): void => {
    if (typeof value === 'string') for (const match of value.matchAll(REF)) refs.add(match[0]);
    else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === 'object') Object.values(value).forEach(scan);
  };
  values.forEach(scan);
  const targets = new Set(buildModelHandleCatalog(values).entries.map(entry => `${entry.kind}\0${entry.target}`));
  return { ...empty(), entries: catalog.entries.filter(entry => isPersistentContextHandle(entry.kind)
    && (refs.has(entry.ref) || targets.has(`${entry.kind}\0${entry.target}`))) };
}

/**
 * Walk the selected immutable root, including only its own compression-source prefixes. Neither
 * Turn membership, request timestamps nor a shared input root makes an abandoned output visible.
 * The returned assertions fence every mutable selector read during a resumable bootstrap.
 */
export async function readContextHandleRootEvidence(database: RuntimeDatabase, store: ContentAddressedStore,
  conversationId: string, rootId: string, options: ContextHandleRootEvidenceOptions = {}): Promise<ContextHandleRootEvidence> {
  const reader = new OccurrenceReader(database, store, options.signal);
  await reader.get('Conversation', conversationId);
  const context = new ContextSequenceControlPlane(database, store);
  const structure = await context.materializeStructure(rootId);
  if (structure.root.conversation_id !== conversationId) throw invalid('Context root belongs to another Conversation.');
  await reader.get('ContextSequenceRoot', rootId);
  if (options.segmentIds === undefined) {
    const heads = await reader.list('ConversationContextHeadLink', { conversation_id: conversationId });
    if (heads.length > 1) throw invalid('Conversation has multiple Context heads.');
  }
  if (options.prefixProvenanceRevision !== undefined && !options.resume
    && options.segmentIds === undefined && options.baseCatalog === undefined) {
    const reused = await readUserTailPrefixCatalog(database, store, reader, conversationId, rootId,
      structure, options.prefixProvenanceRevision);
    if (reused) {
      options.onProgress?.({ completedRequests: structure.records.length, totalRequests: structure.records.length });
      return { catalog: reused, allocationHighWater: { ...reused.allocationHighWater }, assertions: reader.assertions };
    }
  }
  const fork = await readForkContextHandleReservationEvidence(database, store, conversationId);
  if (fork) {
    await reader.list('ModelContextProjection', { owner_kind: 'conversation_handle_catalog', owner_id: conversationId });
    await reader.list('ConversationBranchLink', { target_conversation_id: conversationId });
  }
  const base = options.baseCatalog ?? fork?.catalog ?? empty();
  reader.reserve(base);
  const segments: SegmentEvidence[] = [];
  const path = new Set<string>();
  const visited = new Set<string>();
  const visit = async (segmentId: string): Promise<void> => {
    reader.check();
    if (path.has(segmentId)) throw invalid('Context compression source lineage is cyclic.');
    if (visited.has(segmentId)) return;
    path.add(segmentId);
    const segment = await reader.get('ContextSegment', segmentId);
    const sources = await reader.list('ContextSegmentSource', { segment_id: segmentId });
    const unit: SegmentEvidence = { id: segmentId, kind: id(segment.segment_kind), contentId: id(segment.content_object_id),
      occurrences: [], producerIds: [] };
    if (segment.segment_kind === 'compression') {
      const blocks: DomainRow[] = [];
      for (const source of sources) {
        if (source.source_kind !== 'compression_block' || BigInt(String(source.source_revision)) !== 0n) {
          throw invalid('Compression has an invalid immutable source selector.');
        }
        const block = await reader.maybe('CompressionBlock', id(source.source_id));
        if (block) blocks.push(block);
      }
      let owned = blocks.filter(block => block.conversation_id === conversationId);
      if (!owned.length) {
        // Published early forks shared their ancestor's block as well as its summary segment.
        // Prefer the nearest recorded ancestor; unrelated forks sharing this segment are not sources.
        for (const ancestor of (await reader.branchScopes(conversationId)).slice(1)) {
          owned = blocks.filter(block => block.conversation_id === ancestor);
          if (owned.length) break;
        }
      }
      if (owned.length !== 1 || owned[0].summary_object_id !== segment.content_object_id) {
        throw invalid(`Compression segment ${segmentId} has no unique source block for Conversation ${conversationId} or its branch ancestors.`);
      }
      const block = owned[0];
      const children = (await reader.list('CompressionBlockSource', { compression_block_id: block.id }))
        .sort((a, b) => compareInteger(a.position, b.position));
      if (!children.length) throw invalid('Compression source prefix is empty.');
      for (const [position, source] of children.entries()) {
        if (BigInt(String(source.position)) !== BigInt(position)) throw invalid('Compression source order is not contiguous.');
        await visit(id(source.segment_id));
      }
      unit.compressionBlock = block;
    } else {
      for (const source of sources) {
        if (source.source_kind === 'message_revision') {
          const revision = await reader.maybe('MessageRevision', id(source.source_id));
          if (!revision) continue; // A copied segment can outlive its source Conversation.
          const membership = await reader.list('MessagePartOfConversation', {
            conversation_id: conversationId, message_id: revision.message_id
          });
          if (!membership.length) continue;
          if (membership.length !== 1 || revision.revision_seq !== source.source_revision
            || revision.content_object_id !== segment.content_object_id) throw invalid('Message occurrence provenance conflicts with its revision.');
          const requestId = await reader.producerForRevision(revision, conversationId);
          unit.occurrences.push({ kind: 'message', ...(requestId ? { modelRequestId: requestId } : {}),
            content: '' });
          unit.messageRevision = revision;
          if (requestId) unit.producerIds.push(requestId);
        } else if (source.source_kind === 'tool_call' || source.source_kind === 'tool_model_result') {
          const result = source.source_kind === 'tool_model_result'
            ? await reader.maybe('ToolModelResult', id(source.source_id)) : undefined;
          if (source.source_kind === 'tool_model_result' && !result) continue;
          const callId = id(result ? result.tool_call_id : source.source_id);
          const call = await reader.maybe('ToolCall', callId);
          if (!call) continue;
          const turn = await reader.maybe('Turn', id(call.turn_id));
          if (turn?.conversation_id !== conversationId) continue;
          if (call.call_seq !== source.source_revision) throw invalid('Tool occurrence has a different call revision.');
          const sourceLink = await reader.toolSource(callId);
          unit.producerIds.push(id(sourceLink.model_request_id));
          unit.occurrences.push(result ? { kind: 'tool_result', toolCallId: callId, toolModelResultId: id(result.id) }
            : { kind: 'tool_call', toolCallId: callId });
        }
      }
      if (segment.segment_kind === 'message' && unit.occurrences.length !== 1) {
        throw invalid('Message segment has no unique Conversation-owned revision.');
      }
      if (segment.segment_kind === 'tool_pair' && !unit.occurrences.length) {
        throw invalid('Tool segment has no Conversation-owned source.');
      }
    }
    segments.push(unit);
    visited.add(segmentId); path.delete(segmentId);
    await yieldToEventLoop();
  };
  for (const segmentId of options.segmentIds ?? structure.records.map(record => id(record.segment.id))) await visit(segmentId);

  const positions = new Map(segments.map((segment, index) => [segment.id, index]));
  reader.segmentPositions = positions;
  // The first retained output that actually consumed an occurrence proves its original lookup.
  // Discovery retains IDs only; neither every recipe nor every historical root is materialized.
  const lastProducerPositions = new Map<string, number>();
  segments.forEach((segment, index) => {
    // An admitted tool call proves the provider consumed the frozen input even when the native
    // request emitted no text/thinking item. This does not admit the rest of its private catalog.
    for (const requestId of segment.producerIds) lastProducerPositions.set(requestId, index);
  });
  const producerPositions: Array<{ index: number; requestId?: string; compressionBlock?: DomainRow }> = [
    ...[...lastProducerPositions].map(([requestId, index]) => ({ index, requestId })),
    ...segments.flatMap((segment, index) => segment.compressionBlock ? [{ index, compressionBlock: segment.compressionBlock }] : [])
  ]
    .sort((left, right) => left.index - right.index);
  const consumingCatalog = async (segment: SegmentEvidence, index: number): Promise<ModelHandleCatalog[]> => {
    if (segment.kind === 'message' && segment.producerIds.length) return [];
    let low = 0; let high = producerPositions.length;
    while (low < high) { const middle = (low + high) >>> 1;
      if (producerPositions[middle].index < index) low = middle + 1; else high = middle; }
    for (let cursor = low; cursor < producerPositions.length; cursor++) {
      const producer = producerPositions[cursor];
      const requestId = producer.requestId ?? (producer.compressionBlock
        ? (await reader.compressionRequest(producer.compressionBlock, id(producer.compressionBlock.conversation_id)))?.request.id as string | undefined : undefined);
      const producerConversationId = producer.compressionBlock ? id(producer.compressionBlock.conversation_id) : conversationId;
      if (requestId && await reader.requestContainsSegment(requestId, segment.id, producerConversationId)) {
        return [(await reader.request(requestId)).catalog];
      }
      await yieldToEventLoop();
    }
    return [];
  };
  if (options.resume && options.resume.rootId !== rootId) throw invalid('Context reference checkpoint belongs to another root.');
  const start = options.resume?.nextOccurrence ?? 0;
  if (!Number.isSafeInteger(start) || start < 0 || start > segments.length) throw invalid('Context reference checkpoint is outside its source scope.');
  if (options.resume) reader.reserveFloor(options.resume.allocationHighWater);
  const facts = new SelectedFactIndex();
  for (const fact of options.resume?.facts ?? []) facts.add(fact, { source: 'upgrade_checkpoint',
    rootId, nextOccurrence: start });
  if (!options.resume && (base.retiredRefs?.length ?? 0)) facts.add({ ...base, entries: [] });
  reader.selectedFacts = facts;
  let nextCheckpoint = 32;
  while (nextCheckpoint <= start) nextCheckpoint *= 2;
  options.onProgress?.({ completedRequests: start, totalRequests: segments.length });
  for (let index = start; index < segments.length; index++) {
    reader.check();
    const segment = segments[index];
    const lookups = await consumingCatalog(segment, index);
    const content = await reader.content(segment.contentId);
    if (segment.compressionBlock) {
      const compression = await reader.compressionRequest(segment.compressionBlock, id(segment.compressionBlock.conversation_id));
      if (compression) {
        lookups.push(compression.catalog);
        if (compression.catalog.identityContractRevision === undefined) {
          const legacy = await readHistoricalCompressionHandleCatalog(database, store, {
            recipe: compression.recipe, requestId: id(compression.request.id), conversationId: compression.conversationId
          });
          if (legacy) facts.add(legacy);
        }
      }
    }
    if (segment.occurrences.length) {
      for (const planned of segment.occurrences) {
        const occurrence = planned.kind === 'message' ? { ...planned, content: content.text,
          contentType: id(content.metadata.content_type) } : planned;
        for (const fact of await reader.occurrence(occurrence, base, lookups)) facts.add(fact, reader.origins.get(fact));
      }
    } else {
      // Runtime content and compression summaries may contain frozen short refs. A summary never
      // supplies an identity that was absent from its proved producer/source lookup.
      for (const fact of reader.select([content.text], lookups, base)) facts.add(fact, reader.origins.get(fact));
    }
    // Reconciliation is delayed across the selected raw facts: a legacy map is never prematurely
    // promoted to the strict current contract merely because it happened to be read first.
    if (index + 1 >= nextCheckpoint && index + 1 < segments.length) {
      const checkpointFacts = facts.catalogs();
      await options.onCheckpoint?.({ rootId, nextOccurrence: index + 1, facts: checkpointFacts,
        allocationHighWater: { ...reader.highWater } });
      nextCheckpoint *= 2;
    }
    options.onProgress?.({ completedRequests: index + 1, totalRequests: segments.length });
    await yieldToEventLoop();
  }
  try {
    const catalog = withFloor(reconcileHistoricalModelHandleCatalogs(facts.catalogs(),
      { allocationHighWater: reader.highWater }), reader.highWater);
    return { catalog, allocationHighWater: { ...catalog.allocationHighWater }, assertions: reader.assertions };
  } catch (error) {
    facts.annotateConflict(error, conversationId, rootId);
    throw error;
  }
}

/**
 * A ready prefix is final authority, not raw checkpoint evidence. Reconciliation erased which
 * facts were legacy and may have repaired their refs, so a suffix containing any producer must
 * still use the full raw-fact walk. Only user revisions cannot add another frozen identity.
 */
async function readUserTailPrefixCatalog(database: RuntimeDatabase, store: ContentAddressedStore,
  reader: OccurrenceReader, conversationId: string, rootId: string, structure: MaterializedContextStructure,
  provenanceRevision: bigint): Promise<ModelHandleCatalog | undefined> {
  if (typeof provenanceRevision !== 'bigint' || provenanceRevision < 0n) throw invalid('Context prefix generation is invalid.');
  const repository = DOMAIN_REPOSITORIES.domain(CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN);
  const compressed = structure.records[0]?.node.id === structure.root.root_node_id
    && structure.records[0]?.segment.segment_kind === 'compression';
  // Walk only the uncovered suffix, querying the existing exact-shape index at each boundary.
  // Never enumerate root catalogs or inspect the provenance/body of the already proved prefix.
  for (let index = structure.records.length - 1; index >= 0; index--) {
    reader.check();
    const segment = structure.records[index].segment;
    if (segment.segment_kind !== 'message') return undefined;
    const sources = await reader.list('ContextSegmentSource', { segment_id: segment.id });
    let owned = 0;
    for (const source of sources) {
      if (source.source_kind !== 'message_revision') return undefined;
      const revision = await reader.maybe('MessageRevision', id(source.source_id));
      if (!revision) continue; // A shared segment may outlive another Conversation's source.
      const membership = await reader.list('MessagePartOfConversation', {
        conversation_id: conversationId, message_id: revision.message_id
      });
      if (!membership.length) continue;
      if (membership.length !== 1 || revision.revision_seq !== source.source_revision
        || revision.content_object_id !== segment.content_object_id) throw invalid('Message occurrence provenance conflicts with its revision.');
      if (revision.role !== 'user') return undefined;
      owned++;
    }
    if (owned !== 1) return undefined;
    const where: DomainRow = { conversation_id: conversationId, provenance_revision: provenanceRevision,
      root_node_id: compressed ? structure.root.root_node_id : index ? structure.records[index - 1].node.id : null,
      tail_node_id: compressed && index > 1 ? structure.records[index - 1].node.id : null,
      tail_segment_count: BigInt(compressed ? index - 1 : 0), segment_count: BigInt(index) };
    const rows = (await database.snapshot([repository.list({ where, limit: 1 })])).snapshot[0];
    if (!Array.isArray(rows)) throw invalid('Context prefix catalog lookup has invalid shape.');
    const snapshot = rows[0];
    if (!snapshot) { await yieldToEventLoop(); continue; }
    if (!Object.entries(where).every(([key, value]) => snapshot[key] === value)) {
      throw invalid('Context prefix catalog does not match its exact shape and generation.');
    }
    reader.assertions.push(repository.assert(id(snapshot.id), { ...where,
      context_root_id: snapshot.context_root_id, content_object_id: snapshot.content_object_id }),
    DOMAIN_REPOSITORIES.domain(CONTEXT_HANDLE_STATE_DOMAIN).assert(conversationContextHandleStateId(conversationId), {
      conversation_id: conversationId, context_root_id: rootId, state: 'pending', provenance_revision: provenanceRevision
    }));
    const catalog = await readCatalogForRow(database, store, { ...snapshot, state: 'ready', requires_native_reset: 0n });
    reader.reserve(catalog);
    for (let tail = index; tail < structure.records.length; tail++) {
      reader.check();
      const content = await reader.content(id(structure.records[tail].segment.content_object_id));
      // User-written short refs reserve ordinals but cannot mint or rebind an identity. Preserve
      // the prefix's repaired/current bindings and retired refs without feeding them to raw facts.
      reader.select([content.text], [], empty());
      await yieldToEventLoop();
    }
    return withFloor(catalog, reader.highWater);
  }
  return undefined;
}

class OccurrenceReader {
  /** Transient provenance belongs to selected evidence, not to persisted handle identities. */
  public readonly origins = new WeakMap<ModelHandleCatalog, ContextHandleEvidenceOrigin>();
  public readonly assertions: RepositoryTransactionStep[] = [];
  public readonly highWater: ContextHandleAllocationHighWater = {};
  public segmentPositions = new Map<string, number>();
  public selectedFacts?: SelectedFactIndex;
  public onProducerScope?: (scope: ContextHandleProducerScope) => void | Promise<void>;
  private readonly memo = new ContextHandleReadMemo();
  private readonly rows = new Map<string, Promise<DomainRow | null>>();
  private readonly lists = new Map<string, Promise<DomainRow[]>>();
  private readonly contents = new Map<string, Promise<{ text: string; metadata: DomainRow }>>();
  private readonly contentSizes = new Map<string, number>();
  private contentBytes = 0;
  private readonly requests = new Map<string, Promise<RequestEvidence>>();
  private readonly requestSizes = new Map<string, number>();
  private requestBytes = 0;
  private readonly nodeMaximum = new Map<string, number>();
  private nativeScope?: { requestId: string; catalog: Promise<ModelHandleCatalog> };
  private readonly compressionRequestIds = new Map<string, string | null>();
  private readonly compressionIndexes = new Map<string, Map<string, string[]>>();
  private readonly legacyCompressionIndexes = new Set<string>();
  private readonly scopes = new Map<string, Promise<string[]>>();
  public constructor(private readonly database: RuntimeDatabase, private readonly store: ContentAddressedStore,
    private readonly signal?: AbortSignal) {}
  public check(): void { this.signal?.throwIfAborted(); }
  public maybe(domain: string, key: string): Promise<DomainRow | null> {
    const cacheKey = `${domain}\0${key}`;
    let pending = this.rows.get(cacheKey);
    if (!pending) {
      pending = (async () => {
        this.check();
        const value = (await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(key)])).snapshot[0];
        const row = value && !Array.isArray(value) ? value : null;
        if (row) this.assertions.push(DOMAIN_REPOSITORIES.domain(domain).assert(key, assertedFields(domain, row)));
        else this.assertions.push(DOMAIN_REPOSITORIES.domain(domain).assertNone({ id: key }));
        return row;
      })();
      this.rows.set(cacheKey, pending);
    }
    return pending;
  }
  public async get(domain: string, key: string): Promise<DomainRow> {
    const row = await this.maybe(domain, key);
    if (!row) throw invalid(`${domain} ${key} is missing from Context provenance.`);
    return row;
  }
  public list(domain: string, where: DomainRow): Promise<DomainRow[]> {
    const key = `${domain}\0${JSON.stringify(where)}`;
    let pending = this.lists.get(key);
    if (!pending) {
      pending = (async () => {
        this.check();
        const rows = await listAllDomainRows(this.database, domain, where);
        this.assertions.push(DOMAIN_REPOSITORIES.domain(domain).assertExactIds(where, rows.map(row => id(row.id))));
        for (const row of rows) this.assertions.push(DOMAIN_REPOSITORIES.domain(domain).assert(id(row.id), assertedFields(domain, row)));
        return rows;
      })();
      this.lists.set(key, pending);
    }
    return pending;
  }
  public content(key: string): Promise<{ text: string; metadata: DomainRow }> {
    let pending = this.contents.get(key);
    if (!pending) {
      pending = (async () => {
        const metadata = await this.get('ContentObject', key);
        const text = (await this.store.read(metadata as unknown as ContentObjectMetadata)).toString('utf8');
        const bytes = text.length * 2;
        this.contentSizes.set(key, bytes); this.contentBytes += bytes;
        while (this.contentBytes > 8 * 1024 * 1024 || this.contents.size > 64) {
          const oldest = this.contents.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.contentBytes -= this.contentSizes.get(oldest) ?? 0;
          this.contentSizes.delete(oldest); this.contents.delete(oldest);
        }
        return { text, metadata };
      })();
      this.contents.set(key, pending);
    }
    return pending;
  }
  public request(key: string): Promise<RequestEvidence> {
    let pending = this.requests.get(key);
    if (!pending) {
      pending = (async () => {
        const request = await this.get('ModelRequest', key);
        const turn = await this.get('Turn', id(request.turn_id));
        const content = await this.content(id(request.recipe_object_id));
        const parsed = object(JSON.parse(content.text), 'Frozen recipe');
        let producerScope: ContextHandleProducerScope | undefined;
        if (parsed.contextHandleScope !== undefined) {
          const scope = object(parsed.contextHandleScope, 'Frozen Context handle scope');
          if (typeof scope.conversationId !== 'string' || !scope.conversationId
            || !(scope.rootId === null || typeof scope.rootId === 'string' && scope.rootId.length > 0)
            || typeof scope.provenanceRevision !== 'string' || !/^\d+$/.test(scope.provenanceRevision)
            || typeof scope.resetFence !== 'string' || !/^\d+$/.test(scope.resetFence)) throw invalid('Frozen Context handle scope is invalid.');
          producerScope = scope as unknown as ContextHandleProducerScope;
        }
        // The memo can share equal maps across requests. A private shallow wrapper keeps their
        // diagnostic origins distinct without copying the cumulative entries or changing markers.
        const catalog = { ...this.memo.persistent(this.memo.catalog(
          await resolveFrozenModelHandleCatalog(this.database, this.store, parsed) as unknown as PlainJsonValue)) };
        this.origins.set(catalog, { source: 'frozen_recipe', requestId: key, contentObjectId: id(request.recipe_object_id) });
        let inputBindings: ModelHandleCatalog | undefined;
        if (parsed.contextHandleInputBindings !== undefined) {
          inputBindings = normalizeModelHandleCatalog(parsed.contextHandleInputBindings);
          const frozen = new Map(catalog.entries.map(entry => [entry.ref, `${entry.kind}\0${entry.target}`]));
          if (inputBindings.identityContractRevision !== CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION
            || (inputBindings.retiredRefs?.length ?? 0) > 0
            || inputBindings.entries.some(entry => !isPersistentContextHandle(entry.kind)
              || frozen.get(entry.ref) !== `${entry.kind}\0${entry.target}`)) {
            throw invalid('Frozen input bindings are not an exact subset of their producer lookup.');
          }
        }
        const normalized = parsed as { [key: string]: PlainJsonValue };
        const scoped = recipeSentClaudeTurnScopedReminders(normalized);
        const reminder = scoped ? projectTurnReminder(normalized)?.content : undefined;
        const reinjectedContentId = scoped ? recipeReinjectedCurrentTurnInput(normalized)?.contentObjectId : undefined;
        // Only compression's one-time exact legacy source proof needs its full recipe shape.
        const recipe = parsed.kind === 'reliable-context-compression' ? parsed : {
          kind: parsed.kind, round: parsed.round, ...(parsed.nativeResponses ? { nativeResponses: {} } : {})
        };
        this.reserve(catalog);
        const reference = parsed.modelHandleCatalogReference;
        const baseId = reference && typeof reference === 'object' && !Array.isArray(reference)
          ? (reference as Record<string, unknown>).baseContentObjectId : undefined;
        const baseBytes = typeof baseId === 'string' ? Number((await this.get('ContentObject', baseId)).byte_length) : 0;
        const bytes = Number(content.metadata.byte_length) * 2 + baseBytes * 8;
        this.requestSizes.set(key, bytes); this.requestBytes += bytes;
        while (this.requestBytes > 8 * 1024 * 1024 || this.requests.size > 16) {
          const oldest = this.requests.keys().next().value as string | undefined;
          if (oldest === undefined) break;
          this.requestBytes -= this.requestSizes.get(oldest) ?? 0;
          this.requestSizes.delete(oldest); this.requests.delete(oldest);
        }
        return { request, recipe, catalog, conversationId: id(turn.conversation_id),
          ...(reminder === undefined ? {} : { reminder }), ...(reinjectedContentId ? { reinjectedContentId } : {}),
          ...(inputBindings ? { inputBindings } : {}), ...(producerScope ? { producerScope } : {}) };
      })();
      this.requests.set(key, pending);
    }
    return pending;
  }
  public async requestContainsSegment(requestId: string, segmentId: string, conversationId: string): Promise<boolean> {
    const projections = await this.list('ModelContextProjection', { owner_kind: 'model_request', owner_id: requestId });
    if (projections.length > 1) throw invalid('ModelRequest has multiple frozen Context projections.');
    if (!projections.length) return false;
    const root = await this.get('ContextSequenceRoot', id(projections[0].root_id));
    if (root.conversation_id !== conversationId) throw invalid('Selected request projection belongs to another Conversation.');
    const wanted = this.segmentPositions.get(segmentId)!;
    const maximum = async (nodeId: string): Promise<number> => {
      const pending: DomainRow[] = []; let cursor: string | null = nodeId;
      while (cursor && !this.nodeMaximum.has(cursor)) {
        const node = await this.get('ContextSequenceNode', cursor); pending.push(node);
        cursor = node.parent_node_id === null ? null : id(node.parent_node_id);
        if (pending.length % 128 === 0) { this.check(); await yieldToEventLoop(); }
      }
      let result = cursor ? this.nodeMaximum.get(cursor)! : -1;
      for (const node of pending.reverse()) {
        result = Math.max(result, this.segmentPositions.get(id(node.segment_id)) ?? -1);
        this.nodeMaximum.set(id(node.id), result);
      }
      return this.nodeMaximum.get(nodeId)!;
    };
    const contains = async (tip: unknown, limit: bigint): Promise<boolean> => {
      let cursor = tip === null ? null : id(tip); let remaining = limit;
      while (cursor && remaining-- > 0n) {
        if (await maximum(cursor) < wanted) return false;
        const node = await this.get('ContextSequenceNode', cursor);
        if (node.segment_id === segmentId) return true;
        cursor = node.parent_node_id === null ? null : id(node.parent_node_id);
      }
      return false;
    };
    return await contains(root.tail_node_id, BigInt(String(root.tail_segment_count)))
      || await contains(root.root_node_id, BigInt(String(root.segment_count)));
  }
  public async toolSource(toolCallId: string): Promise<DomainRow> {
    const sources = await this.list('ToolCallSourceLink', { tool_call_id: toolCallId });
    if (sources.length !== 1) throw invalid('ToolCall has no unique producing request.');
    return sources[0];
  }
  public reserveFloor(floor: ContextHandleAllocationHighWater): void {
    for (const [kind, value] of Object.entries(floor)) {
      if (!Number.isSafeInteger(value) || value < 0) throw invalid('Context allocation high water is invalid.');
      this.highWater[kind as ModelHandleKind] = Math.max(this.highWater[kind as ModelHandleKind] ?? 0, value);
    }
  }
  public reserve(catalog: ModelHandleCatalog): void {
    this.reserveFloor((catalog as ModelHandleCatalog & { allocationHighWater?: ContextHandleAllocationHighWater }).allocationHighWater ?? {});
    for (const entry of catalog.entries) if (isPersistentContextHandle(entry.kind)) {
      this.highWater[entry.kind] = Math.max(this.highWater[entry.kind] ?? 0, Number(entry.ref.slice(1)));
    }
    for (const ref of catalog.retiredRefs ?? []) if (REF_KINDS[ref[0]]) {
      const kind = REF_KINDS[ref[0]]; this.highWater[kind] = Math.max(this.highWater[kind] ?? 0, Number(ref.slice(1)));
    }
  }
  public select(values: unknown[], catalogs: readonly ModelHandleCatalog[], base: ModelHandleCatalog): ModelHandleCatalog[] {
    const refs = new Set<string>();
    const scan = (value: unknown): void => {
      if (typeof value === 'string') { for (const match of value.matchAll(REF)) refs.add(match[0]); }
      else if (Array.isArray(value)) value.forEach(scan);
      else if (value && typeof value === 'object') Object.values(value).forEach(scan);
    };
    values.forEach(scan);
    // An edited/user-authored visible token with no proved target remains unresolved forever;
    // it still reserves its ordinal, rather than becoming a newly allocated actionable alias.
    for (const ref of refs) {
      const ordinal = Number(ref.slice(1)); const kind = REF_KINDS[ref[0]];
      if (Number.isSafeInteger(ordinal)) this.highWater[kind] = Math.max(this.highWater[kind] ?? 0, ordinal);
    }
    const targets = new Set(buildModelHandleCatalog(values).entries.map(entry => `${entry.kind}\0${entry.target}`));
    const chosen: ModelHandleCatalog[] = [];
    const resolvedRefs = new Set<string>();
    const resolvedTargets = new Set<string>();
    for (const catalog of catalogs) {
      this.reserve(catalog);
      const entries = catalog.entries.filter(entry => isPersistentContextHandle(entry.kind)
        && (refs.has(entry.ref) || targets.has(`${entry.kind}\0${entry.target}`)));
      for (const entry of entries) { resolvedRefs.add(entry.ref); resolvedTargets.add(`${entry.kind}\0${entry.target}`); }
      if (entries.length || catalog.retiredRefs?.length) {
        const selected = { ...catalog, entries };
        const origin = this.origins.get(catalog);
        if (origin) this.origins.set(selected, origin);
        chosen.push(selected);
      }
    }
    this.reserve(base);
    for (const fact of this.selectedFacts?.select(refs, targets, resolvedRefs, resolvedTargets) ?? []) {
      chosen.push(fact);
      for (const entry of fact.entries) { resolvedRefs.add(entry.ref); resolvedTargets.add(`${entry.kind}\0${entry.target}`); }
    }
    const fallback = base.entries.filter(entry => isPersistentContextHandle(entry.kind)
      && ((refs.has(entry.ref) && !resolvedRefs.has(entry.ref))
        || (targets.has(`${entry.kind}\0${entry.target}`) && !resolvedTargets.has(`${entry.kind}\0${entry.target}`))));
    if (fallback.length || base.retiredRefs?.length) chosen.push({ ...base, entries: fallback });
    return chosen;
  }
  public async occurrence(occurrence: ContextHandleOccurrenceEvidence, base: ModelHandleCatalog,
    additional: readonly ModelHandleCatalog[] = []): Promise<ModelHandleCatalog[]> {
    this.check();
    const catalogs = [...additional];
    const values: unknown[] = [];
    const projectedFacts: ModelHandleCatalog[] = [];
    if (occurrence.kind === 'message' || occurrence.kind === 'compression') {
      values.push(typeof occurrence.content === 'string' ? occurrence.content : Buffer.from(occurrence.content).toString('utf8'));
      if (occurrence.modelRequestId) {
        const evidence = await this.request(occurrence.modelRequestId);
        await this.adoptProducerScope(evidence);
        if (!this.selectedFacts && evidence.inputBindings) projectedFacts.push(evidence.inputBindings);
        if (occurrence.kind === 'compression' && (evidence.recipe.kind !== 'reliable-context-compression'
          || (occurrence.compressionBlockId !== undefined && evidence.recipe.blockId !== occurrence.compressionBlockId))) {
          throw invalid('Compression occurrence does not belong to its frozen producer.');
        }
        catalogs.push(evidence.catalog);
        // Native item text can use refs introduced by earlier tool results in this same request.
        // These tables are lookup evidence only: unused parallel entries never enter the result.
        if (this.selectedFacts) catalogs.push(...await this.nativeLookups(evidence));
        if (evidence.reminder) values.push(evidence.reminder);
        if (evidence.reinjectedContentId) values.push((await this.content(evidence.reinjectedContentId)).text);
      }
    } else {
      const call = await this.get('ToolCall', occurrence.toolCallId);
      const source = await this.toolSource(occurrence.toolCallId);
      const evidence = await this.request(id(source.model_request_id));
      await this.adoptProducerScope(evidence);
      if (!this.selectedFacts && evidence.inputBindings) projectedFacts.push(evidence.inputBindings);
      if (call.turn_id !== evidence.request.turn_id) throw invalid('ToolCall source belongs to another Turn.');
      catalogs.push(evidence.catalog);
      if (occurrence.kind === 'tool_call') {
        values.push((await this.content(id(call.arguments_object_id))).text);
        const admissions = await this.list('ToolCallEvent', { tool_call_id: occurrence.toolCallId, event_kind: 'native_admission' });
        for (const admission of admissions) {
          const value = object(JSON.parse((await this.content(id(admission.content_object_id))).text), 'Native admission');
          if (typeof value.checkpointId !== 'string') continue;
          const checkpoint = await this.maybe('ModelStreamCheckpoint', value.checkpointId);
          if (!checkpoint) continue; // Bounded stream proofs may have been pruned after admission.
          const envelope = object(JSON.parse((await this.content(id(checkpoint.content_object_id))).text), 'Native checkpoint');
          const proof = parseNativeToolCallCheckpoint(envelope.content);
          if (proof.providerCallId !== source.provider_call_id || proof.toolName !== call.tool_name) throw invalid('Native call proof conflicts with its source.');
          this.origins.set(proof.modelHandleCatalog, { source: 'native_admission', requestId: id(evidence.request.id),
            contentObjectId: id(checkpoint.content_object_id), eventId: id(admission.id) });
          catalogs.push(proof.modelHandleCatalog); values.push(proof.arguments, proof.resolvedArguments);
        }
        if (this.selectedFacts) catalogs.push(...await this.nativeLookups(evidence));
      } else {
        const result = await this.get('ToolModelResult', occurrence.toolModelResultId);
        if (result.tool_call_id !== occurrence.toolCallId) throw invalid('Tool result belongs to another call.');
        const revision = await this.get('MessageRevision', id(result.message_revision_id));
        const rawText = (await this.content(id(revision.content_object_id))).text;
        const raw: unknown = JSON.parse(rawText);
        values.push(isCollaborationHandleTool(id(call.tool_name)) ? { kind: 'agent_collaboration', detail: raw } : raw);
        const projections = await this.list('ToolCallEvent', { tool_call_id: occurrence.toolCallId, event_kind: NATIVE_PROJECTION });
        if (projections.length > 1) throw invalid('Native result has multiple frozen projections.');
        if (projections.length) {
          const projection = object(JSON.parse((await this.content(id(projections[0].content_object_id))).text), 'Native result projection');
          await this.validateProjection(projection, evidence, occurrence.toolCallId, occurrence.toolModelResultId);
          const catalog = projectionCatalog(projection);
          this.origins.set(catalog, { source: 'native_projection', requestId: id(evidence.request.id),
            contentObjectId: id(projections[0].content_object_id), eventId: id(projections[0].id) });
          catalogs.push(catalog);
          // Projected P# tokens belong to this exact frozen table. Feeding them back through
          // every other lookup would turn an unrelated table's unused P# into false evidence.
          projectedFacts.push(...this.select([projection.output], [catalog], empty()));
        }
        // An ordinary result can introduce canonical targets absent from its producing request.
        // Preserve its raw occurrence; the next consuming recipe allocates and freezes the actual
        // input bindings. Only the exact native result event proves already-projected short refs.
      }
    }
    return [...this.select(values, catalogs, base), ...projectedFacts];
  }
  private async nativeLookups(evidence: RequestEvidence): Promise<ModelHandleCatalog[]> {
    if (!evidence.recipe.nativeResponses) return [];
    const requestId = id(evidence.request.id);
    if (this.nativeScope?.requestId !== requestId) this.nativeScope = { requestId, catalog: (async () => {
      let catalog = evidence.catalog;
      for (const source of await this.list('ToolCallSourceLink', { model_request_id: requestId })) {
        for (const event of await this.list('ToolCallEvent', { tool_call_id: source.tool_call_id, event_kind: NATIVE_PROJECTION })) {
          const projection = object(JSON.parse((await this.content(id(event.content_object_id))).text), 'Native projection');
          await this.validateProjection(projection, evidence, id(source.tool_call_id));
          const incoming = this.memo.persistent(this.memo.catalog((projection.modelHandleCatalog
            ?? { entries: projection.childHandles }) as PlainJsonValue));
          // One native request has one strict private scope, even for published window-local maps.
          const merged = mergeModelHandleCatalogs(catalog, incoming);
          catalog = evidence.catalog.identityContractRevision === undefined && incoming.identityContractRevision === undefined
            ? { entries: merged.entries } : merged;
          this.reserve(incoming);
          await yieldToEventLoop(); this.check();
        }
      }
      if (catalog !== evidence.catalog) this.origins.set(catalog, { source: 'native_request_scope', requestId,
        contentObjectId: id(evidence.request.recipe_object_id) });
      return catalog;
    })() };
    return [await this.nativeScope.catalog];
  }
  private async adoptProducerScope(evidence: RequestEvidence): Promise<void> {
    if (!this.onProducerScope || this.selectedFacts || !evidence.producerScope) return;
    const scope = evidence.producerScope;
    // Fork copies keep original recipe bytes. Their source scope cannot adopt a target reset.
    if (scope.conversationId !== evidence.conversationId) return;
    const projections = await this.list('ModelContextProjection', { owner_kind: 'model_request', owner_id: evidence.request.id });
    if (projections.length !== 1 || projections[0].root_id !== scope.rootId) {
      throw invalid('Frozen Context handle scope differs from its producer input projection.');
    }
    await this.onProducerScope(scope);
  }
  private async validateProjection(projection: Record<string, unknown>, evidence: RequestEvidence,
    toolCallId: string, resultId?: string): Promise<void> {
    if (projection.kind !== NATIVE_PROJECTION
      || !await this.matchesCopy(evidence.conversationId, 'model_request', id(projection.modelRequestId), id(evidence.request.id))
      || !await this.matchesCopy(evidence.conversationId, 'tool_call', id(projection.toolCallId), toolCallId)
      || (resultId !== undefined && !await this.matchesCopy(evidence.conversationId, 'tool_model_result', id(projection.toolModelResultId), resultId))) {
      throw invalid('Native projection does not belong to the selected immutable result.');
    }
  }
  public async producerForRevision(revision: DomainRow, conversationId: string): Promise<string | undefined> {
    if (revision.role !== 'model') return undefined;
    const links = await this.list('ModelRequestMessageLink', { message_id: revision.message_id });
    if (!links.length) throw invalid('Model Message has no producing request provenance.');
    if (links.length !== 1) throw invalid('Model Message has multiple producing requests.');
    const requestId = id(links[0].model_request_id);
    if (BigInt(String(revision.revision_seq)) === 1n) return requestId;
    const parsed = maybeObject(parseJson((await this.content(id(revision.content_object_id))).text));
    const parts = parsed?.parts;
    const item = Array.isArray(parts) && parts.length === 1 ? maybeObject(maybeObject(parts[0])?.outputItem) : undefined;
    if (!item || typeof item.providerResponseId !== 'string' || !Number.isSafeInteger(item.ordinal)) return undefined;
    const evidence = await this.request(requestId);
    const itemKey = `content:${item.providerResponseId}:${String(item.ordinal)}`;
    if (revision.id === nativeItemRevisionId(id(evidence.request.turn_id), requestId, itemKey)) return requestId;
    const authority = await this.get('AuthoritySnapshot', id(evidence.request.authority_snapshot_id));
    const original = object(JSON.parse((await this.content(id(authority.content_object_id))).text), 'Copied authority');
    if (typeof original.turnId !== 'string' || typeof evidence.recipe.round !== 'string') return undefined;
    const originalRequest = modelRequestIdFor(original.turnId, `agent-loop:${original.turnId}:round:${evidence.recipe.round}`);
    if (await this.matchesCopy(conversationId, 'model_request', originalRequest, requestId)
      && await this.matchesCopy(conversationId, 'message_revision', nativeItemRevisionId(original.turnId, originalRequest, itemKey), id(revision.id))) return requestId;
    return undefined; // A later user edit keeps MessageRequestLink but owns no provider recipe.
  }
  public async compressionRequest(block: DomainRow, conversationId: string): Promise<RequestEvidence | undefined> {
    const cached = this.compressionRequestIds.get(id(block.id));
    if (cached !== undefined) return cached === null ? undefined : this.request(cached);
    const authority = await this.get('AuthoritySnapshot', id(block.authority_snapshot_id));
    const turnId = id(authority.turn_id);
    const requests = await this.list('ModelRequest', { turn_id: turnId });
    let index = this.compressionIndexes.get(turnId);
    const add = (blockId: string, requestId: string) => {
      const members = index!.get(blockId) ?? []; if (!members.includes(requestId)) members.push(requestId); index!.set(blockId, members);
    };
    if (!index) {
      index = new Map(); this.compressionIndexes.set(turnId, index);
      for (const request of requests) {
        const purpose = maybeObject(maybeObject(request.stream_stats_json)?.compressionPurpose);
        if (typeof purpose?.blockId === 'string') add(purpose.blockId, id(request.id));
      }
    }
    const candidates = new Set<string>();
    const selectCandidates = async () => {
      for (const [frozenBlock, requestIds] of index!) if (await this.matchesCopy(conversationId, 'compression_block', frozenBlock, id(block.id))) {
        requestIds.forEach(requestId => candidates.add(requestId));
      }
    };
    await selectCandidates();
    if (!candidates.size) {
      // Original published producers have a deterministic block identity. Match that metadata
      // before opening any recipe, so ordinary and abandoned requests are not parsed as catalogs.
      const projections = await this.list('ModelContextProjection', { owner_kind: 'compression_block', owner_id: block.id });
      if (projections.length === 1) for (const request of requests) {
        if (compressionBlockIdFor(conversationId, id(projections[0].root_id), id(request.id)) === block.id) candidates.add(id(request.id));
      }
    }
    if (!candidates.size && !this.legacyCompressionIndexes.has(turnId)
      && (await this.list('ConversationBranchLink', { target_conversation_id: conversationId })).length) {
      // Old copied requests may predate purpose metadata and keep original recipe IDs. One bounded
      // header pass per selected Turn builds a compact index; never one full pass per block.
      this.legacyCompressionIndexes.add(turnId);
      for (const request of requests) {
        const recipe = object(JSON.parse((await this.content(id(request.recipe_object_id))).text), 'Frozen recipe');
        if (recipe.kind === 'reliable-context-compression' && typeof recipe.blockId === 'string') add(recipe.blockId, id(request.id));
        this.check(); await yieldToEventLoop();
      }
      await selectCandidates();
    }
    const matches: RequestEvidence[] = [];
    for (const requestId of candidates) {
      const evidence = await this.request(requestId);
      if (evidence.recipe.kind !== 'reliable-context-compression' || typeof evidence.recipe.blockId !== 'string'
        || !await this.matchesCopy(conversationId, 'compression_block', evidence.recipe.blockId, id(block.id))) {
        throw invalid('Compression metadata conflicts with its frozen recipe.');
      }
      matches.push(evidence);
    }
    if (matches.length > 1) throw invalid('Compression block has multiple producing requests.');
    this.compressionRequestIds.set(id(block.id), matches[0] ? id(matches[0].request.id) : null);
    return matches[0];
  }
  public branchScopes(conversationId: string): Promise<string[]> {
    let scopes = this.scopes.get(conversationId);
    if (!scopes) {
      scopes = (async () => {
        const result: string[] = []; const seen = new Set<string>();
        let current = conversationId;
        while (result.length < 64 && !seen.has(current)) {
          seen.add(current);
          const branches = await this.list('ConversationBranchLink', { target_conversation_id: current });
          if (!branches.length) { if (result.length) result.push(current); break; }
          if (branches.length !== 1) throw invalid('Copied Context has multiple branch sources.');
          const origins = await this.list('ConversationOriginLink', { conversation_id: current });
          if (origins.length > 1 || (origins[0] && origins[0].source_conversation_id !== branches[0].source_conversation_id)) {
            throw invalid('Copied Context branch and origin disagree.');
          }
          result.push(current); current = id(branches[0].source_conversation_id);
        }
        return result;
      })();
      this.scopes.set(conversationId, scopes);
    }
    return scopes;
  }
  private async matchesCopy(conversationId: string, kind: string, frozenId: string, actualId: string): Promise<boolean> {
    if (frozenId === actualId) return true;
    const known = await this.branchScopes(conversationId);
    for (let count = 1; count <= known.length; count++) {
      const copied = known.slice(0, count).reverse().reduce((value, scope) => conversationForkSnapshotCopyId(scope, kind, value), frozenId);
      if (copied === actualId) return true;
    }
    return false;
  }
}

function projectionCatalog(value: Record<string, unknown>): ModelHandleCatalog {
  return normalizeModelHandleCatalog(value.modelHandleCatalog ?? { entries: value.childHandles });
}
/** Compact raw identity facts plus O(1) unambiguous lookup. No cumulative recipe is retained. */
class SelectedFactIndex {
  private readonly facts = new Map<string, { entry: ModelHandleEntry; current: boolean;
    currentOrigin?: ContextHandleEvidenceOrigin; legacyOrigin?: ContextHandleEvidenceOrigin }>();
  private readonly byRef = new Map<string, Set<string>>();
  private readonly byTarget = new Map<string, Set<string>>();
  private readonly retired = new Set<string>();
  public add(catalog: ModelHandleCatalog, origin?: ContextHandleEvidenceOrigin): void {
    for (const ref of catalog.retiredRefs ?? []) this.retired.add(ref);
    const current = catalog.identityContractRevision !== undefined;
    for (const entry of catalog.entries) {
      const target = `${entry.kind}\0${entry.target}`;
      const key = `${entry.ref}\0${target}`;
      const previous = this.facts.get(key);
      const originKey = current ? 'currentOrigin' : 'legacyOrigin';
      if (previous) {
        previous.current ||= current;
        // Repeated cumulative recipes share the first witness. At most two source objects are
        // retained per unique mapping, never a list of every request that repeated that mapping.
        if (origin && !previous[originKey]) previous[originKey] = origin;
        continue;
      }
      this.facts.set(key, { entry, current, ...(origin ? { [originKey]: origin } : {}) });
      for (const [index, identity] of [[this.byRef, entry.ref], [this.byTarget, target]] as const) {
        const members = index.get(identity) ?? new Set<string>(); members.add(key); index.set(identity, members);
      }
    }
  }
  public annotateConflict(error: unknown, conversationId: string, rootId: string): void {
    if (!(error instanceof ModelHandleIdentityConflictError) || !error.conflict) return;
    const wanted = new Set(error.conflict.facts.map(fact => `${fact.ref}\0${fact.target}`));
    const witnesses = [];
    for (const { entry, currentOrigin, legacyOrigin } of this.facts.values()) {
      if (entry.kind !== error.conflict.kind || !wanted.has(`${entry.ref}\0${entry.target}`)) continue;
      witnesses.push({ ref: entry.ref, target: entry.target,
        ...(currentOrigin ? { currentOrigin } : {}), ...(legacyOrigin ? { legacyOrigin } : {}) });
      if (witnesses.length === wanted.size) break;
    }
    Object.assign(error, { contextHandleEvidence: { conversationId, rootId, witnesses } });
  }
  public catalogs(): ModelHandleCatalog[] {
    const current = empty(); const legacy: ModelHandleCatalog = { entries: [] };
    current.retiredRefs = [...this.retired];
    for (const fact of this.facts.values()) (fact.current ? current : legacy).entries.push(fact.entry);
    // Individually conflicting facts cannot be represented as one normalized catalog. Keep each
    // competing identity in its own tiny catalog; reconciliation owns connected ambiguity sets.
    const split = (catalog: ModelHandleCatalog): ModelHandleCatalog[] => {
      const safe: ModelHandleEntry[] = []; const conflicts: ModelHandleCatalog[] = [];
      for (const entry of catalog.entries) {
        if ((this.byRef.get(entry.ref)?.size ?? 0) > 1 || (this.byTarget.get(`${entry.kind}\0${entry.target}`)?.size ?? 0) > 1
          || this.retired.has(entry.ref)) conflicts.push({ ...catalog, entries: [entry],
            ...(catalog.identityContractRevision ? { retiredRefs: [] } : {}) });
        else safe.push(entry);
      }
      return [{ ...catalog, entries: safe }, ...conflicts];
    };
    return [...split(current), ...split(legacy)].filter(catalog => catalog.entries.length || catalog.retiredRefs?.length);
  }
  public select(refs: ReadonlySet<string>, targets: ReadonlySet<string>, resolvedRefs: ReadonlySet<string>,
    resolvedTargets: ReadonlySet<string>): ModelHandleCatalog[] {
    const keys = new Set<string>();
    for (const ref of refs) if (!resolvedRefs.has(ref)) for (const key of this.byRef.get(ref) ?? []) keys.add(key);
    for (const target of targets) if (!resolvedTargets.has(target)) for (const key of this.byTarget.get(target) ?? []) keys.add(key);
    const current = empty(); const legacy: ModelHandleCatalog = { entries: [] };
    for (const key of keys) {
      const fact = this.facts.get(key)!; const entry = fact.entry;
      if (this.retired.has(entry.ref) || this.byRef.get(entry.ref)!.size !== 1
        || this.byTarget.get(`${entry.kind}\0${entry.target}`)!.size !== 1) continue;
      (fact.current ? current : legacy).entries.push(entry);
    }
    return [current, legacy].filter(catalog => catalog.entries.length);
  }
}
function withFloor(catalog: ModelHandleCatalog, allocationHighWater: ContextHandleAllocationHighWater): ModelHandleCatalog {
  const floor = { ...allocationHighWater };
  for (const [kind, ordinal] of Object.entries(catalog.allocationHighWater ?? {})) {
    floor[kind as ModelHandleKind] = Math.max(floor[kind as ModelHandleKind] ?? 0, ordinal);
  }
  // Legacy reconciliation can allocate repaired identities above every source recipe's ordinal.
  // Publish their floor now so the first admitted output does not rewrite an unchanged catalog.
  for (const entry of catalog.entries) if (isPersistentContextHandle(entry.kind)) {
    floor[entry.kind] = Math.max(floor[entry.kind] ?? 0, Number(entry.ref.slice(1)));
  }
  for (const ref of catalog.retiredRefs ?? []) if (REF_KINDS[ref[0]]) {
    const kind = REF_KINDS[ref[0]];
    floor[kind] = Math.max(floor[kind] ?? 0, Number(ref.slice(1)));
  }
  return { ...catalog, allocationHighWater: floor };
}
function assertedFields(domain: string, row: DomainRow): DomainRow {
  if (domain === 'Conversation') return {};
  if (domain === 'ModelRequest') return { turn_id: row.turn_id, recipe_object_id: row.recipe_object_id,
    authority_snapshot_id: row.authority_snapshot_id };
  if (domain === 'Turn') return { conversation_id: row.conversation_id };
  const fields = { ...row };
  delete fields.id; // Repository.assert carries the row identity separately from its predicates.
  return fields;
}
function parseJson(value: string): unknown { try { return JSON.parse(value); } catch { return undefined; } }
function maybeObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function object(value: unknown, label: string): Record<string, unknown> {
  const result = maybeObject(value); if (!result) throw invalid(`${label} is not an object.`); return result;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value) throw invalid('Context provenance has an invalid identity.'); return value;
}
function compareInteger(a: unknown, b: unknown): number {
  const left = BigInt(String(a)); const right = BigInt(String(b)); return left < right ? -1 : left > right ? 1 : 0;
}
function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'MODEL_CONTEXT_HANDLE_STATE_INVALID' });
}
