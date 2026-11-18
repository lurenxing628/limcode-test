import { CONTEXT_HANDLE_STATE_CONTENT_TYPE, readFrozenContextHandleCatalogBase,
  rememberFrozenContextHandleCatalogBase } from './frozenModelHandleCatalog';
export { CONTEXT_HANDLE_STATE_CONTENT_TYPE } from './frozenModelHandleCatalog';
import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { prepareStoredHandleCatalog, storedHandleCatalog, type StoredHandleCatalog } from './contextHandleCatalogStorage';
import { CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION, isPersistentContextHandle,
  mergeModelHandleCatalogs, normalizeModelHandleCatalog, type ModelHandleCatalog } from './modelHandleCatalog';
import { normalizePlainJson } from './plainJson';
import { stablePhaseFId, isTransactionAssertionFailure } from './phaseFIdentity';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';
import { readContextHandleOccurrenceCatalog, type ContextHandleOccurrenceEvidence } from './contextHandleOccurrenceEvidence';
import { compressionRootIdFor } from './contextCompression';
import { selectConversationCompressionBlock } from './compressionBlockOwnership';
import { listAllDomainRows } from './repositoryPagination';

export const CONTEXT_HANDLE_STATE_DOMAIN = 'ConversationContextHandleState';
export const CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN = 'ContextRootHandleCatalog';

export interface CurrentContextHandleState {
  row: DomainRow;
  catalog: ModelHandleCatalog;
  requiresNativeReset: boolean;
}

const stateIds = new Map<string, string>();
export function conversationContextHandleStateId(conversationId: string): string {
  let id = stateIds.get(conversationId);
  if (id === undefined) {
    id = stablePhaseFId('conversation_context_handle_state', conversationId);
    stateIds.set(conversationId, id);
    if (stateIds.size > 256) stateIds.delete(stateIds.keys().next().value!);
  }
  return id;
}

/** New conversations are explicitly empty. Absence never means empty historical evidence. */
export function emptyConversationContextHandleStateStep(conversationId: string, now: string): RepositoryTransactionStep {
  return DOMAIN_REPOSITORIES.domain(CONTEXT_HANDLE_STATE_DOMAIN).insert({
    id: conversationContextHandleStateId(conversationId), conversation_id: conversationId,
    context_root_id: null, state: 'ready', revision: 0n, provenance_revision: 0n, content_object_id: null,
    requires_native_reset: 0n, created_at: now, updated_at: now
  });
}

/** Import/migration owns this transition; ordinary reads never silently rebuild history. */
export function pendingConversationContextHandleStateSteps(conversationId: string, now: string,
  current?: DomainRow, contextRootId?: string | null): RepositoryTransactionStep[] {
  const repository = DOMAIN_REPOSITORIES.domain(CONTEXT_HANDLE_STATE_DOMAIN);
  const id = conversationContextHandleStateId(conversationId);
  if (!current) return [repository.assertNone({ conversation_id: conversationId }), repository.insert({
    id, conversation_id: conversationId, context_root_id: contextRootId ?? null,
    state: 'pending', revision: 0n, provenance_revision: 0n, content_object_id: null, requires_native_reset: 1n,
    created_at: now, updated_at: now
  })];
  assertRow(current, conversationId);
  return [contextHandleStateAssertion(current), repository.update(id, {
    context_root_id: contextRootId === undefined ? current.context_root_id : contextRootId,
    state: 'pending', revision: revision(current) + 1n, provenance_revision: BigInt(String(current.provenance_revision)) + 1n, content_object_id: null,
    requires_native_reset: revision(current) + 1n, updated_at: now
  })];
}

export function contextHandleStateAssertion(row: DomainRow): RepositoryTransactionStep {
  return DOMAIN_REPOSITORIES.domain(CONTEXT_HANDLE_STATE_DOMAIN).assert(String(row.id), {
    conversation_id: row.conversation_id, state: row.state, revision: row.revision, provenance_revision: row.provenance_revision,
    context_root_id: row.context_root_id, content_object_id: row.content_object_id,
    requires_native_reset: row.requires_native_reset
  });
}

export interface ContextHandleRootShape {
  rootNodeId: string | null; tailNodeId: string | null; tailSegmentCount: bigint; segmentCount: bigint;
}

export interface ContextHandleHeadTransitionPlan {
  steps: RepositoryTransactionStep[];
  /** Planned state for a subsequent append in the same writer transaction. */
  state: DomainRow;
}

export function contextRootHandleCatalogId(conversationId: string, contextRootId: string, provenanceRevision = 0n): string {
  // Both identifiers are canonical strings. Length-delimiting avoids hashing immutable IDs again.
  return `context_root_handle_catalog:${conversationId.length}:${conversationId}${contextRootId}:${provenanceRevision}`;
}

export async function readContextRootHandleCatalogRow(database: RuntimeDatabase, conversationId: string,
  contextRootId: string, provenanceRevision = 0n): Promise<DomainRow | undefined> {
  const value = (await database.snapshot([DOMAIN_REPOSITORIES.domain(CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN)
    .get(contextRootHandleCatalogId(conversationId, contextRootId, provenanceRevision))])).snapshot[0];
  if (!value) return undefined;
  if (Array.isArray(value) || value.conversation_id !== conversationId || value.context_root_id !== contextRootId || value.provenance_revision !== provenanceRevision) {
    throw stateError('Context root catalog snapshot has invalid ownership.');
  }
  return value;
}

async function contextRootCatalogSnapshotSteps(database: RuntimeDatabase, conversationId: string,
  contextRootId: string, contentObjectId: string | null, now: string, provenanceRevision = 0n,
  rootShape?: ContextHandleRootShape, knownNewRoot = false): Promise<RepositoryTransactionStep[]> {
  const repository = DOMAIN_REPOSITORIES.domain(CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN);
  if (!knownNewRoot) {
    const existing = await readContextRootHandleCatalogRow(database, conversationId, contextRootId, provenanceRevision);
    if (existing) {
      if (existing.content_object_id !== contentObjectId) throw stateError('An immutable Context root catalog cannot be rebound.');
      return [repository.assert(String(existing.id), { conversation_id: conversationId,
        context_root_id: contextRootId, provenance_revision: provenanceRevision, content_object_id: contentObjectId })];
    }
  }
  const shape = rootShape ?? await readRootShape(database, conversationId, contextRootId);
  return [repository.assertNone({ conversation_id: conversationId, context_root_id: contextRootId, provenance_revision: provenanceRevision }),
    repository.insert({ id: contextRootHandleCatalogId(conversationId, contextRootId, provenanceRevision), conversation_id: conversationId,
      context_root_id: contextRootId, provenance_revision: provenanceRevision, ...shapeRow(shape),
      content_object_id: contentObjectId, created_at: now })];
}

/** The caller inserts the new root and commits these steps with the exact Context head change. */
export async function prepareContextHandleHeadTransition(input: {
  database: RuntimeDatabase; contentStore: ContentAddressedStore; conversationId: string;
  previousRootId: string | null; nextRootId: string; mode: 'append' | 'rewrite' | 'activate'; now: string;
  baseRootId?: string | null; activate?: boolean;
  rootShape?: ContextHandleRootShape;
  /** The caller proved that only a final user occurrence is deleted or replaced. */
  reuseCurrentCatalog?: boolean;
  /** Retained original chain, excluding an edited user occurrence appended after truncation. */
  compressedPrefix?: { nodeId: string | null; tailSegmentCount: bigint };
  occurrence?: ContextHandleOccurrenceEvidence; occurrences?: readonly ContextHandleOccurrenceEvidence[];
  /** Roots planned by one atomic append batch are known absent until its commit. */
  knownNewRootIds?: ReadonlySet<string>;
  current?: DomainRow;
}): Promise<ContextHandleHeadTransitionPlan> {
  const current = input.current ?? await readConversationContextHandleStateRow(input.database, input.conversationId);
  assertRow(current, input.conversationId);
  const provenanceRevision = BigInt(String(current.provenance_revision));
  const activate = input.activate !== false;
  if (activate && current.context_root_id !== input.previousRootId) throw frontierChanged();
  const repository = DOMAIN_REPOSITORIES.domain(CONTEXT_HANDLE_STATE_DOMAIN);
  if (input.mode !== 'append') {
    let snapshot = await readContextRootHandleCatalogRow(input.database, input.conversationId, input.nextRootId, provenanceRevision);
    const aliasSteps: RepositoryTransactionStep[] = [];
    if (!snapshot && input.reuseCurrentCatalog && current.state === 'ready'
      && typeof current.context_root_id === 'string' && input.rootShape) {
      snapshot = await readContextRootHandleCatalogRow(input.database, input.conversationId, current.context_root_id, provenanceRevision);
      if (snapshot) aliasSteps.push(...await contextRootCatalogSnapshotSteps(input.database, input.conversationId,
        input.nextRootId, snapshot.content_object_id as string | null, input.now, provenanceRevision, input.rootShape));
    }
    if (!snapshot && input.rootShape) {
      const where = { conversation_id: input.conversationId, provenance_revision: provenanceRevision, ...shapeRow(input.rootShape) };
      const found = (await input.database.snapshot([DOMAIN_REPOSITORIES.domain(CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN)
        .list({ where, limit: 1 })])).snapshot[0];
      if (!Array.isArray(found)) throw stateError('Context root alias lookup has invalid shape.');
      snapshot = found[0];
      if (snapshot) {
        aliasSteps.push(DOMAIN_REPOSITORIES.domain(CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN).assert(String(snapshot.id), {
          ...where, context_root_id: snapshot.context_root_id, content_object_id: snapshot.content_object_id
        }), ...await contextRootCatalogSnapshotSteps(input.database, input.conversationId,
          input.nextRootId, snapshot.content_object_id as string | null, input.now, provenanceRevision, input.rootShape));
      }
    }
    const restored = !snapshot && current.state === 'ready' && input.rootShape
      && input.compressedPrefix !== undefined
      ? await prepareCompressedPrefixCatalog(input.database, input.contentStore, input.conversationId,
        input.nextRootId, input.rootShape, input.compressedPrefix, provenanceRevision, input.now)
      : undefined;
    if (restored) aliasSteps.push(...restored.steps);
    if (!activate) return { state: current, steps: aliasSteps };
    const state = { ...current, context_root_id: input.nextRootId, revision: revision(current) + 1n,
      state: snapshot || restored ? 'ready' : 'pending',
      content_object_id: restored ? restored.contentObjectId : snapshot?.content_object_id ?? null,
      requires_native_reset: revision(current) + 1n, updated_at: input.now };
    return { state, steps: [contextHandleStateAssertion(current), ...aliasSteps, ...(snapshot
      ? [DOMAIN_REPOSITORIES.domain(CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN).assert(String(snapshot.id), {
          conversation_id: input.conversationId, context_root_id: snapshot.context_root_id,
          content_object_id: snapshot.content_object_id })] : []),
      repository.update(String(current.id), statePatch(state))] };
  }
  const baseRootId = input.baseRootId === undefined ? input.previousRootId : input.baseRootId;
  const baseSnapshot = baseRootId !== current.context_root_id && baseRootId !== null
    ? await readContextRootHandleCatalogRow(input.database, input.conversationId, baseRootId, provenanceRevision) : undefined;
  const baseReady = baseRootId === null || (baseRootId === current.context_root_id
    ? current.state === 'ready' : baseSnapshot !== undefined);
  let contentObjectId = baseRootId === null ? null : (baseSnapshot?.content_object_id ??
    (baseRootId === current.context_root_id && baseReady ? current.content_object_id : null)) as string | null;
  const steps: RepositoryTransactionStep[] = activate ? [contextHandleStateAssertion(current)] : [];
  if (baseSnapshot) steps.push(DOMAIN_REPOSITORIES.domain(CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN).assert(String(baseSnapshot.id), {
    conversation_id: input.conversationId, context_root_id: baseRootId, content_object_id: baseSnapshot.content_object_id
  }));
  const occurrences = input.occurrences ?? (input.occurrence ? [input.occurrence] : []);
  let adoptedReset = false;
  if (baseReady && occurrences.length > 0) {
    const original = await readCatalogForRow(input.database, input.contentStore,
      { ...current, state: 'ready', context_root_id: baseRootId, content_object_id: contentObjectId });
    let catalog = original;
    for (const occurrence of occurrences) {
      const additions = await readContextHandleOccurrenceCatalog(input.database, input.contentStore, occurrence, catalog,
        BigInt(String(current.requires_native_reset)) > 0n ? scope => {
          if (scope.conversationId === input.conversationId
            && scope.provenanceRevision === String(current.provenance_revision)
            && scope.resetFence === String(current.requires_native_reset)) adoptedReset = true;
        } : undefined);
      catalog = mergeModelHandleCatalogs(catalog, additions);
    }
    if (!sameCatalog(original, catalog)) {
      const prepared = await prepareCatalogContent(input.database, input.contentStore, input.conversationId, catalog,
        storedHandleCatalog(input.database, input.contentStore, original));
      contentObjectId = prepared.contentObjectId;
      steps.push(...prepared.steps);
    }
  }
  if (baseReady) steps.push(...await contextRootCatalogSnapshotSteps(input.database, input.conversationId,
    input.nextRootId, contentObjectId, input.now, provenanceRevision, input.rootShape,
    input.knownNewRootIds?.has(input.nextRootId) === true));
  if (!activate) return { state: current, steps };
  const state = { ...current, context_root_id: input.nextRootId, revision: revision(current) + 1n,
    state: baseReady ? 'ready' : 'pending', content_object_id: baseReady ? contentObjectId : null,
    requires_native_reset: baseRootId !== input.previousRootId || !baseReady ? revision(current) + 1n
      : adoptedReset ? 0n : current.requires_native_reset,
    updated_at: input.now };
  steps.push(repository.update(String(current.id), statePatch(state)));
  return { state, steps };
}

/** Restore the exact pre-compression prefix, adding only bindings used by the retained summary. */
async function prepareCompressedPrefixCatalog(database: RuntimeDatabase, store: ContentAddressedStore,
  conversationId: string, nextRootId: string, shape: ContextHandleRootShape,
  retainedPrefix: { nodeId: string | null; tailSegmentCount: bigint },
  provenanceRevision: bigint, now: string): Promise<{ contentObjectId: string | null; steps: RepositoryTransactionStep[] } | undefined> {
  const get = async (domain: string, id: string): Promise<DomainRow | undefined> =>
    (await database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)])).snapshot[0] as DomainRow | undefined;
  if (!shape.rootNodeId) return undefined;
  const summaryNode = await get('ContextSequenceNode', shape.rootNodeId);
  const summary = summaryNode && await get('ContextSegment', String(summaryNode.segment_id));
  if (summary?.segment_kind !== 'compression') return undefined;
  const sources = await listAllDomainRows(database, 'ContextSegmentSource', { segment_id: summary.id });
  if (!sources.length) return undefined;
  const block = await selectConversationCompressionBlock(database, String(summary.id), conversationId, sources);
  const projections = (await database.snapshot([DOMAIN_REPOSITORIES.domain('ModelContextProjection')
    .list({ where: { owner_kind: 'compression_block', owner_id: block.id }, limit: 1 })])).snapshot[0] as DomainRow[];
  const projection = projections[0];
  if (!projection || projection.purpose !== 'compression-source') return undefined;
  const original = await get('ContextSequenceRoot', String(projection.root_id));
  const compressedRootId = compressionRootIdFor(String(block.id), String(projection.root_id));
  const compressed = await get('ContextSequenceRoot', compressedRootId);
  if (!original || original.conversation_id !== conversationId || !compressed
    || compressed.conversation_id !== conversationId || compressed.root_node_id !== shape.rootNodeId
    || retainedPrefix.tailSegmentCount > BigInt(String(compressed.tail_segment_count))) return undefined;
  const compressedCatalog = await readContextRootHandleCatalogRow(database, conversationId, compressedRootId, provenanceRevision);
  if (!compressedCatalog) return undefined;
  const originalNode = await get('ContextSequenceNode', String(original.root_node_id));
  const originalSegment = originalNode && await get('ContextSegment', String(originalNode.segment_id));
  const originalCompressed = originalSegment?.segment_kind === 'compression';
  const segmentCount = BigInt(String(original.segment_count)) - BigInt(String(compressed.tail_segment_count)) + retainedPrefix.tailSegmentCount;
  const originalShape: ContextHandleRootShape = { rootNodeId: originalCompressed ? original.root_node_id as string : retainedPrefix.nodeId,
    tailNodeId: originalCompressed && segmentCount > 1n ? retainedPrefix.nodeId : null,
    tailSegmentCount: originalCompressed ? segmentCount - 1n : 0n, segmentCount };
  const where = { conversation_id: conversationId, provenance_revision: provenanceRevision, ...shapeRow(originalShape) };
  const found = (await database.snapshot([DOMAIN_REPOSITORIES.domain(CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN)
    .list({ where, limit: 1 })])).snapshot[0] as DomainRow[];
  const prefix = found[0];
  if (!prefix) return undefined;
  const base = await readCatalogForRow(database, store, { ...prefix, state: 'ready', requires_native_reset: 0n });
  const lookup = await readCatalogForRow(database, store, { ...compressedCatalog, state: 'ready', requires_native_reset: 0n });
  const metadata = await get('ContentObject', String(summary.content_object_id));
  const additions = await readContextHandleOccurrenceCatalog(database, store,
    { kind: 'compression', content: await store.read(metadata as unknown as ContentObjectMetadata) }, lookup);
  const catalog = mergeModelHandleCatalogs(base, additions);
  const content = sameCatalog(base, catalog) ? { contentObjectId: prefix.content_object_id as string | null, steps: [] }
    : await prepareCatalogContent(database, store, conversationId, catalog, storedHandleCatalog(database, store, base));
  return { contentObjectId: content.contentObjectId, steps: [
    ...[prefix, compressedCatalog].map(row => DOMAIN_REPOSITORIES.domain(CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN)
      .assert(String(row.id), { conversation_id: conversationId, provenance_revision: provenanceRevision,
        context_root_id: row.context_root_id, content_object_id: row.content_object_id })),
    ...content.steps, ...await contextRootCatalogSnapshotSteps(database, conversationId, nextRootId,
      content.contentObjectId, now, provenanceRevision, shape)
  ] };
}

/** Fresh Conversation creators already own the explicit planned state in their transaction. */
export function prepareEmptyContextHandleRootTransition(conversationId: string, contextRootId: string, now: string,
  current?: DomainRow, rootShape?: ContextHandleRootShape): ContextHandleHeadTransitionPlan {
  const planned = current ?? (emptyConversationContextHandleStateStep(conversationId, now) as { row: DomainRow }).row;
  assertRow(planned, conversationId);
  if (planned.context_root_id !== null) throw stateError('Initial Context root requires an unbound fresh Conversation state.');
  if (!rootShape) throw stateError('Initial Context root catalog requires its exact planned structure.');
  const state = { ...planned, context_root_id: contextRootId, revision: revision(planned) + 1n, updated_at: now };
  return { state, steps: [contextHandleStateAssertion(planned), ...(planned.state === 'ready' ? [
    DOMAIN_REPOSITORIES.domain(CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN).insert({
      id: contextRootHandleCatalogId(conversationId, contextRootId, BigInt(String(planned.provenance_revision))), conversation_id: conversationId,
      context_root_id: contextRootId, provenance_revision: planned.provenance_revision, ...shapeRow(rootShape), content_object_id: planned.content_object_id, created_at: now
    })] : []), DOMAIN_REPOSITORIES.domain(CONTEXT_HANDLE_STATE_DOMAIN).update(String(planned.id), statePatch(state))] };
}

function shapeRow(shape: ContextHandleRootShape): DomainRow {
  return { root_node_id: shape.rootNodeId, tail_node_id: shape.tailNodeId,
    tail_segment_count: shape.tailSegmentCount, segment_count: shape.segmentCount };
}

async function readRootShape(database: RuntimeDatabase, conversationId: string, rootId: string): Promise<ContextHandleRootShape> {
  const row = (await database.snapshot([DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').get(rootId)])).snapshot[0];
  if (!row || Array.isArray(row) || row.conversation_id !== conversationId) throw stateError('Context catalog root has invalid ownership.');
  return { rootNodeId: row.root_node_id as string | null, tailNodeId: row.tail_node_id as string | null,
    tailSegmentCount: BigInt(String(row.tail_segment_count)), segmentCount: BigInt(String(row.segment_count)) };
}

/** Imported evidence advances a typed source generation without evicting an unaffected ready head. */
export function importConversationContextHandleStateSteps(conversationId: string, now: string,
  current: DomainRow | undefined, contextRootId: string | null, affectsCurrent: boolean): RepositoryTransactionStep[] {
  if (!current || affectsCurrent || current.state === 'pending') {
    return pendingConversationContextHandleStateSteps(conversationId, now, current, contextRootId);
  }
  assertRow(current, conversationId);
  if (current.context_root_id !== contextRootId) throw frontierChanged();
  return [contextHandleStateAssertion(current), DOMAIN_REPOSITORIES.domain(CONTEXT_HANDLE_STATE_DOMAIN).update(String(current.id), {
    revision: revision(current) + 1n, provenance_revision: BigInt(String(current.provenance_revision)) + 1n, updated_at: now
  })];
}

function statePatch(row: DomainRow): DomainRow {
  return { context_root_id: row.context_root_id, state: row.state, revision: row.revision, provenance_revision: row.provenance_revision,
    content_object_id: row.content_object_id, requires_native_reset: row.requires_native_reset, updated_at: row.updated_at };
}

function frontierChanged(): Error {
  return Object.assign(new Error('Context handle scope changed before commit; rebuild from the current root.'),
    { code: 'MODEL_CONTEXT_HANDLE_FRONTIER_CHANGED' });
}

export async function readConversationContextHandleStateRow(database: RuntimeDatabase,
  conversationId: string): Promise<DomainRow> {
  const result = await database.snapshot([
    DOMAIN_REPOSITORIES.domain(CONTEXT_HANDLE_STATE_DOMAIN).get(conversationContextHandleStateId(conversationId)),
    DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').list({ where: { conversation_id: conversationId }, limit: 2 })
  ]);
  const row = result.snapshot[0];
  if (!row || Array.isArray(row)) throw stateError('Conversation Context reference state has not been initialized.');
  assertRow(row, conversationId);
  const heads = result.snapshot[1];
  if (!Array.isArray(heads) || heads.length > 1 || (heads[0]?.root_id ?? null) !== row.context_root_id) {
    throw stateError('Current Context handle pointer does not match the selected Conversation head.');
  }
  return row;
}

/** Cold/restarted ordinary execution reads exactly the current catalog, never historical recipes. */
export async function readCurrentConversationContextHandleState(database: RuntimeDatabase,
  store: ContentAddressedStore, conversationId: string): Promise<CurrentContextHandleState> {
  const row = await readConversationContextHandleStateRow(database, conversationId);
  return readReadyStateRow(database, store, row);
}

/** Caller supplies a fenced ready current pointer or an exact owned immutable root snapshot. */
export async function readCatalogForRow(database: RuntimeDatabase, store: ContentAddressedStore,
  row: DomainRow): Promise<ModelHandleCatalog> {
  return (await readReadyStateRow(database, store, row)).catalog;
}

async function readReadyStateRow(database: RuntimeDatabase, store: ContentAddressedStore,
  row: DomainRow): Promise<CurrentContextHandleState> {
  const conversationId = String(row.conversation_id);
  if (row.state !== 'ready') throw Object.assign(
    new Error('此对话的引用目录正在整理。请在整理完成后继续；已保存的历史不会被删除。'),
    { code: 'MODEL_CONTEXT_HANDLE_UPGRADE_PENDING', conversationId });
  if (row.content_object_id === null) {
    return { row, catalog: emptyContextHandleCatalog(), requiresNativeReset: BigInt(String(row.requires_native_reset)) > 0n };
  }
  const catalog = await readFrozenContextHandleCatalogBase(database, store, String(row.content_object_id), conversationId);
  return { row, catalog, requiresNativeReset: BigInt(String(row.requires_native_reset)) > 0n };
}

export async function readContextHandleStateContent(database: RuntimeDatabase, store: ContentAddressedStore,
  row: DomainRow, contentType: string): Promise<ReturnType<typeof normalizePlainJson>> {
  const metadata = (await database.snapshot([
    DOMAIN_REPOSITORIES.domain('ContentObject').get(String(row.content_object_id))
  ])).snapshot[0];
  if (!metadata || Array.isArray(metadata) || metadata.content_type !== contentType) {
    throw stateError('Context reference state has no correctly typed CAS content.');
  }
  return normalizePlainJson(JSON.parse((await store.read(metadata as unknown as ContentObjectMetadata)).toString('utf8')),
    'Conversation Context reference state');
}

/** A frozen request owns its private allocations; only Context admission publishes bindings. */
export async function prepareConversationContextHandleUpdate(input: {
  database: RuntimeDatabase; contentStore: ContentAddressedStore; conversationId: string;
  catalog: unknown; source: 'ordinary' | 'compression' | 'native'; now: string;
  contextRootId?: string;
  baseContentObjectId?: unknown;
  scope?: unknown;
  current?: CurrentContextHandleState;
}): Promise<RepositoryTransactionStep[]> {
  const current = input.current ?? await readCurrentConversationContextHandleState(input.database, input.contentStore, input.conversationId);
  const incoming = persistentContextHandleCatalog(input.catalog);
  if (input.baseContentObjectId !== undefined && input.baseContentObjectId !== current.row.content_object_id) {
    throw frontierChanged();
  }
  if (input.scope !== undefined) {
    const scope = input.scope as Record<string, unknown>;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)
      || scope.conversationId !== input.conversationId || scope.rootId !== current.row.context_root_id
      || scope.provenanceRevision !== String(current.row.provenance_revision)
      || scope.resetFence !== String(current.row.requires_native_reset)) throw frontierChanged();
  }
  if (input.contextRootId !== undefined && current.row.context_root_id !== input.contextRootId) {
    throw frontierChanged();
  }
  // A prepared request must have allocated against the exact current authority. Merging a later
  // state only into storage would leave the provider's frozen recipe unaware of those addresses.
  if (input.source !== 'native' && (incoming.identityContractRevision !== CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION
    || !containsIdentity(incoming, current.catalog))) {
    throw Object.assign(new Error('Context references changed during request preparation; rebuild from current state.'),
      { code: 'MODEL_CONTEXT_HANDLE_FRONTIER_CHANGED' });
  }
  return [contextHandleStateAssertion(current.row)];
}

/** Fork and migration are explicit seeds; neither changes the immutable fork-reservation artifact. */
export async function prepareReadyConversationContextHandleState(input: {
  database: RuntimeDatabase; contentStore: ContentAddressedStore; conversationId: string;
  catalog: ModelHandleCatalog; requiresNativeReset: boolean; now: string; current?: DomainRow;
  contextRootId?: string | null;
  rootShape?: ContextHandleRootShape;
}): Promise<RepositoryTransactionStep[]> {
  const catalog = requireCurrentPersistentCatalog(input.catalog);
  if (input.current) assertRow(input.current, input.conversationId);
  const contextRootId = input.contextRootId === undefined ? input.current?.context_root_id ?? null : input.contextRootId;
  if (contextRootId !== null && typeof contextRootId !== 'string') throw stateError('Current Context root is invalid.');
  const resetFence = !input.requiresNativeReset ? 0n
    : input.current && BigInt(String(input.current.requires_native_reset)) > 0n
      ? BigInt(String(input.current.requires_native_reset)) : input.current ? revision(input.current) + 1n : 1n;
  const content = await prepareCatalogContent(input.database, input.contentStore, input.conversationId, catalog);
  const repository = DOMAIN_REPOSITORIES.domain(CONTEXT_HANDLE_STATE_DOMAIN);
  const id = conversationContextHandleStateId(input.conversationId);
  return [
    ...(input.current ? [contextHandleStateAssertion(input.current)]
      : [repository.assertNone({ conversation_id: input.conversationId })]),
    ...content.steps,
    ...(contextRootId ? await contextRootCatalogSnapshotSteps(input.database, input.conversationId,
      contextRootId, content.contentObjectId, input.now, BigInt(String(input.current?.provenance_revision ?? 0n)), input.rootShape) : []),
    ...(input.current ? [repository.update(id, { context_root_id: contextRootId,
      state: 'ready', revision: revision(input.current) + 1n,
      content_object_id: content.contentObjectId, requires_native_reset: resetFence, updated_at: input.now })]
      : [repository.insert({ id, conversation_id: input.conversationId, state: 'ready', revision: 1n, provenance_revision: 0n,
        context_root_id: contextRootId, content_object_id: content.contentObjectId,
        requires_native_reset: resetFence, created_at: input.now, updated_at: input.now })])
  ];
}

async function prepareCatalogContent(database: RuntimeDatabase, contentStore: ContentAddressedStore,
  conversationId: string, catalog: ModelHandleCatalog, base?: StoredHandleCatalog): Promise<{ contentObjectId: string; steps: RepositoryTransactionStep[] }> {
  const content = await prepareStoredHandleCatalog({ database, contentStore, conversationId, catalog, base, kind: 'context' });
  rememberFrozenContextHandleCatalogBase(database, contentStore, content.stored.metadata, conversationId, content.stored.catalog);
  return { contentObjectId: content.stored.metadata.id, steps: content.steps };
}

export function persistentContextHandleCatalog(value: unknown): ModelHandleCatalog {
  const catalog = normalizeModelHandleCatalog(value);
  if (catalog.entries.every(entry => isPersistentContextHandle(entry.kind))) return catalog;
  return { ...catalog, entries: catalog.entries.filter(entry => isPersistentContextHandle(entry.kind)) };
}

export function emptyContextHandleCatalog(): ModelHandleCatalog {
  return normalizeModelHandleCatalog({ entries: [], retiredRefs: [],
    identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION });
}

function requireCurrentPersistentCatalog(value: unknown): ModelHandleCatalog {
  const catalog = normalizeModelHandleCatalog(value);
  if (catalog.identityContractRevision !== CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION
    || catalog.entries.some(entry => !isPersistentContextHandle(entry.kind))) {
    throw stateError('Current Context state requires a complete current persistent catalog.');
  }
  return catalog;
}

function containsIdentity(candidate: ModelHandleCatalog, expected: ModelHandleCatalog): boolean {
  const identities = new Map(candidate.entries.map(entry => [entry.ref, `${entry.kind}\0${entry.target}`]));
  const retired = new Set(candidate.retiredRefs ?? []);
  return expected.entries.every(entry => identities.get(entry.ref) === `${entry.kind}\0${entry.target}`)
    && (expected.retiredRefs ?? []).every(ref => retired.has(ref))
    && Object.entries(expected.allocationHighWater ?? {}).every(([kind, floor]) =>
      ((candidate.allocationHighWater as Record<string, number> | undefined)?.[kind] ?? 0) >= floor);
}

function assertRow(row: DomainRow, conversationId: string): void {
  if (row.id !== conversationContextHandleStateId(conversationId) || row.conversation_id !== conversationId
    || !['ready', 'pending'].includes(String(row.state)) || revision(row) < 0n
    || typeof row.provenance_revision !== 'bigint' || row.provenance_revision < 0n
    || (row.context_root_id !== null && (typeof row.context_root_id !== 'string' || !row.context_root_id))
    || typeof row.requires_native_reset !== 'bigint' || row.requires_native_reset < 0n
    || (row.content_object_id !== null && (typeof row.content_object_id !== 'string' || !row.content_object_id))) {
    throw stateError('Conversation Context state has invalid identity, revision or status.');
  }
}

function revision(row: DomainRow): bigint { return BigInt(String(row.revision)); }
function stateError(message: string): Error {
  return Object.assign(new Error(message), { code: 'MODEL_CONTEXT_HANDLE_STATE_INVALID' });
}


/** Already-normalized catalogs have stable ref order; unchanged rounds need no JSON or digest. */
function sameCatalog(left: ModelHandleCatalog, right: ModelHandleCatalog): boolean {
  if (left.identityContractRevision !== right.identityContractRevision || left.entries.length !== right.entries.length
    || (left.retiredRefs?.length ?? 0) !== (right.retiredRefs?.length ?? 0)) return false;
  const leftFloor = left.allocationHighWater ?? {};
  const rightFloor = right.allocationHighWater ?? {};
  if (Object.keys(leftFloor).length !== Object.keys(rightFloor).length || Object.entries(leftFloor).some(([kind, ordinal]) =>
    ordinal !== (rightFloor as Record<string, number>)[kind])) return false;
  const fields = ['kind', 'ref', 'target', 'name', 'mimeType', 'sizeBytes'] as const;
  return left.entries.every((entry, index) => fields.every(key => entry[key] === right.entries[index][key]))
    && (left.retiredRefs ?? []).every((ref, index) => ref === right.retiredRefs![index]);
}


/** Only a proved optimistic-pointer race is retried; unrelated invariant failures stay visible. */
export async function rethrowContextHandleStateRace(database: RuntimeDatabase, steps: readonly RepositoryTransactionStep[], error: unknown): Promise<never> {
  if (isTransactionAssertionFailure(error)) {
    const assertion = steps.find(step => step.kind === 'assert' && step.domain === CONTEXT_HANDLE_STATE_DOMAIN);
    if (assertion?.kind === 'assert') {
      const row = (await database.snapshot([DOMAIN_REPOSITORIES.domain(CONTEXT_HANDLE_STATE_DOMAIN).get(assertion.id)])).snapshot[0];
      if (row && !Array.isArray(row) && Object.entries(assertion.where).some(([key, expected]) => row[key] !== expected)) {
        throw Object.assign(new Error('Context reference authority changed before the producer committed; rebuild from current state.'),
          { code: row.state === 'pending' ? 'MODEL_CONTEXT_HANDLE_UPGRADE_PENDING' : 'MODEL_CONTEXT_HANDLE_FRONTIER_CHANGED' });
      }
    }
  }
  throw error;
}
