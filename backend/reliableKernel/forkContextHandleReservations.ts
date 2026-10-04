import { CONTEXT_HANDLE_STATE_DOMAIN, CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN, contextHandleStateAssertion, readCatalogForRow,
  readConversationContextHandleStateRow, prepareReadyConversationContextHandleState,
  type ContextHandleRootShape } from './conversationContextHandleState';
import { createHash } from 'node:crypto';
import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import { CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION, isPersistentContextHandle,
  normalizeModelHandleCatalog, type ModelHandleCatalog } from './modelHandleCatalog';
import { canonicalPlainJson, normalizePlainJson } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';

export const FORK_CONTEXT_HANDLE_RESERVATION_OWNER_KIND = 'conversation_handle_catalog';
export const FORK_CONTEXT_HANDLE_RESERVATION_PURPOSE = 'fork-handle-reservations';
export const FORK_CONTEXT_HANDLE_RESERVATION_CONTENT_TYPE = 'application/vnd.limcode.fork-context-handle-reservations+json';
const PAYLOAD_KIND = 'fork-context-handle-reservations';

interface ForkHandlePayload {
  kind: typeof PAYLOAD_KIND;
  sourceConversationId: string;
  targetConversationId: string;
  modelHandleCatalog: ModelHandleCatalog;
  coveredRecipeObjectIds: string[];
}

/** Reuse only the exact selected shape in the current provenance generation. A whole-head
 * catalog is not evidence for a narrower fork, and old-generation snapshots cannot fill a miss. */
export async function readExactForkContextHandleSnapshot(input: {
  database: RuntimeDatabase; contentStore: ContentAddressedStore; sourceConversationId: string;
  sourceRoot: DomainRow; selectedShape: ContextHandleRootShape;
}): Promise<{ catalog: ModelHandleCatalog; assertions: RepositoryTransactionStep[] } | undefined> {
  const conversationId = requireId(input.sourceConversationId, 'sourceConversationId');
  if (input.sourceRoot.conversation_id !== conversationId) throw reservationError('Fork source root belongs to another Conversation.');
  const current = await readConversationContextHandleStateRow(input.database, conversationId);
  const shape: DomainRow = { root_node_id: input.selectedShape.rootNodeId, tail_node_id: input.selectedShape.tailNodeId,
    tail_segment_count: input.selectedShape.tailSegmentCount, segment_count: input.selectedShape.segmentCount };
  const matches = (row: DomainRow): boolean => Object.entries(shape).every(([key, value]) => row[key] === value);
  const where: DomainRow = { conversation_id: conversationId, provenance_revision: current.provenance_revision, ...shape };
  const repository = DOMAIN_REPOSITORIES.domain(CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN);
  const snapshots = requireRows((await input.database.snapshot([repository.list({ where, limit: 1 })])).snapshot[0],
    'Exact fork Context catalog snapshots');
  const snapshot = snapshots[0];
  if (!snapshot) {
    // An unrelated import can advance the generation while preserving the ready current
    // pointer. With no immutable snapshot in that generation, only the exact pointer is proof.
    if (current.state !== 'ready' || current.context_root_id !== input.sourceRoot.id || !matches(input.sourceRoot)) return undefined;
    return { catalog: await readCatalogForRow(input.database, input.contentStore, current), assertions: [
      contextHandleStateAssertion(current), DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').assert(
        requireId(input.sourceRoot.id, 'Fork source root'), { conversation_id: conversationId, ...shape })
    ] };
  }
  if (!Object.entries(where).every(([key, value]) => snapshot[key] === value)) {
    throw reservationError('Fork Context catalog does not match its selected shape and provenance generation.');
  }
  // The selected snapshot is insert-only and cannot be rebound when a suffix is appended or
  // another head is activated. Only an evidence import changes its provenance generation.
  // Keep the fork's independent selected-root/revision assertions, not an unrelated head fence.
  return { catalog: await readCatalogForRow(input.database, input.contentStore, { ...snapshot, state: 'ready', requires_native_reset: 0n }),
    assertions: [DOMAIN_REPOSITORIES.domain(CONTEXT_HANDLE_STATE_DOMAIN).assert(requireId(current.id, 'Fork source state'), {
      conversation_id: conversationId, provenance_revision: current.provenance_revision
    }), repository.assert(requireId(snapshot.id, 'Fork Context catalog'), {
      ...where, context_root_id: snapshot.context_root_id, content_object_id: snapshot.content_object_id
    })] };
}

/** Frozen address facts live in a registered private root, never in the model-visible head. */
export async function prepareForkContextHandleReservations(input: {
  database: RuntimeDatabase;
  contentStore: ContentAddressedStore;
  sourceConversationId: string;
  targetConversationId: string;
  targetContextRootId?: string;
  rootShape?: ContextHandleRootShape;
  catalog: ModelHandleCatalog;
  coveredRecipeObjectIds: readonly string[];
  now: string;
}): Promise<{ steps: RepositoryTransactionStep[] }> {
  const source = requireId(input.sourceConversationId, 'sourceConversationId');
  const target = requireId(input.targetConversationId, 'targetConversationId');
  const catalog = requireCurrentContextCatalog(input.catalog);
  const ids = reservationIds(target);
  const payload: ForkHandlePayload = { kind: PAYLOAD_KIND, sourceConversationId: source,
    targetConversationId: target, modelHandleCatalog: catalog,
    coveredRecipeObjectIds: requireCoverage(input.coveredRecipeObjectIds) };
  const content = await input.contentStore.prepare(input.database,
    canonicalPlainJson(normalizePlainJson(payload, 'Fork Context handle reservations')),
    FORK_CONTEXT_HANDLE_RESERVATION_CONTENT_TYPE);
  const currentStateSteps = await prepareReadyConversationContextHandleState({ database: input.database,
    contentStore: input.contentStore, conversationId: target, catalog, contextRootId: input.targetContextRootId, rootShape: input.rootShape,
    requiresNativeReset: (catalog.retiredRefs?.length ?? 0) > 0, now: input.now });
  return { steps: [
    ...currentStateSteps,
    ...preparedContentObjectSteps([content], 'fork_handle_reservations'),
    DOMAIN_REPOSITORIES.domain('ContextSegment').insert({ id: ids.segment,
      content_object_id: content.metadata.id, segment_kind: 'runtime_context', created_at: input.now }),
    DOMAIN_REPOSITORIES.domain('ContextSegmentSource').insert({ id: ids.source, segment_id: ids.segment,
      source_kind: 'runtime_context', source_id: ids.projection, source_revision: 0n, created_at: input.now }),
    DOMAIN_REPOSITORIES.domain('ContextSequenceNode').insert({ id: ids.node, parent_node_id: null,
      segment_id: ids.segment, created_at: input.now }),
    DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({ id: ids.root,
      conversation_id: target, root_node_id: ids.node, tail_node_id: null, tail_segment_count: 0n,
      segment_count: 1n, estimated_tokens: 0n, created_at: input.now
    }, { column: 'root_seq', scope: { conversation_id: target } }),
    DOMAIN_REPOSITORIES.domain('ModelContextProjection').insert({ id: ids.projection,
      owner_kind: FORK_CONTEXT_HANDLE_RESERVATION_OWNER_KIND, owner_id: target, root_id: ids.root,
      purpose: FORK_CONTEXT_HANDLE_RESERVATION_PURPOSE, created_at: input.now })
  ] };
}

/** Source deletion is allowed: the target owns all frozen facts, with its branch proving their scope. */
export async function readForkContextHandleReservationCatalog(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  conversationId: string
): Promise<ModelHandleCatalog | undefined> {
  return (await readReservation(database, contentStore, requireId(conversationId, 'conversationId')))?.modelHandleCatalog;
}

/** An idempotent fork may not succeed with a missing or differently bound reservation artifact. */
export async function assertForkContextHandleReservations(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  targetConversationId: string,
  expectedSourceConversationId: string
): Promise<void> {
  const payload = await readReservation(database, contentStore, requireId(targetConversationId, 'targetConversationId'));
  if (!payload || payload.sourceConversationId !== expectedSourceConversationId) {
    throw reservationError('Fork replay has missing or differently bound Context handle reservations.');
  }
}

export async function readForkContextHandleReservationEvidence(database: RuntimeDatabase, contentStore: ContentAddressedStore,
  conversationId: string): Promise<{ catalog: ModelHandleCatalog; coveredRecipeObjectIds: string[] } | undefined> {
  const payload = await readReservation(database, contentStore, requireId(conversationId, 'conversationId'));
  return payload ? { catalog: payload.modelHandleCatalog, coveredRecipeObjectIds: payload.coveredRecipeObjectIds } : undefined;
}

async function readReservation(database: RuntimeDatabase, contentStore: ContentAddressedStore,
  target: string): Promise<ForkHandlePayload | undefined> {
  const ids = reservationIds(target);
  const snapshot = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('ModelContextProjection').list({ where: {
      owner_kind: FORK_CONTEXT_HANDLE_RESERVATION_OWNER_KIND, owner_id: target }, limit: 2 }),
    DOMAIN_REPOSITORIES.domain('ConversationBranchLink').list({ where: { target_conversation_id: target }, limit: 2 }),
    DOMAIN_REPOSITORIES.domain('ChildExecution').list({ where: { child_conversation_id: target }, limit: 2 }),
    DOMAIN_REPOSITORIES.domain('ConversationOriginLink').list({ where: { conversation_id: target }, limit: 2 })
  ]);
  const projections = requireRows(snapshot.snapshot[0], 'Fork reservation projections');
  if (projections.length === 0) {
    const orphan = await database.snapshot([DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').get(ids.root)]);
    if (orphan.snapshot[0]) throw reservationError('Fork reservation root has no correctly scoped projection.');
    return undefined;
  }
  const branches = requireRows(snapshot.snapshot[1], 'Fork reservation branch');
  if (projections.length !== 1 || branches.length !== 1) throw reservationError('Fork reservations must have one projection and branch.');
  const projection = projections[0];
  const branch = branches[0];
  const children = requireRows(snapshot.snapshot[2], 'Fork reservation ChildExecution');
  const origins = requireRows(snapshot.snapshot[3], 'Fork reservation origin');
  if (children.length > 1 || origins.length > 1) throw reservationError('Fork reservation ownership is not unique.');
  if (children.length === 1) {
    const origin = origins[0];
    if (!origin || origin.source_conversation_id !== branch.source_conversation_id
      || typeof origin.source_turn_id !== 'string' || !origin.source_turn_id
      || typeof origin.source_tool_call_id !== 'string' || !origin.source_tool_call_id) {
      throw reservationError('Child fork reservation origin conflicts with its source Conversation.');
    }
    const parents = await database.snapshot([
      DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').list({ where: { child_execution_id: children[0].id }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('Turn').get(origin.source_turn_id),
      DOMAIN_REPOSITORIES.domain('ToolCall').get(origin.source_tool_call_id)
    ]);
    const links = requireRows(parents.snapshot[0], 'Child fork reservation parent');
    const turn = parents.snapshot[1];
    const tool = parents.snapshot[2];
    if (links.length !== 1 || links[0].parent_turn_id !== origin.source_turn_id
      || links[0].source_tool_call_id !== origin.source_tool_call_id
      || (turn && (Array.isArray(turn) || turn.conversation_id !== branch.source_conversation_id))
      || (tool && (Array.isArray(tool) || tool.turn_id !== origin.source_turn_id))) {
      throw reservationError('Child fork reservation parent/Turn/ToolCall identity conflicts with its origin.');
    }
  } else if (origins[0]?.source_tool_call_id !== undefined && origins[0].source_tool_call_id !== null) {
    throw reservationError('Child fork reservations have no owning ChildExecution.');
  }
  if (projection.id !== ids.projection || projection.root_id !== ids.root
    || projection.purpose !== FORK_CONTEXT_HANDLE_RESERVATION_PURPOSE) {
    throw reservationError('Fork reservation projection identity or purpose conflicts with its owner.');
  }
  const structure = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').get(ids.root),
    DOMAIN_REPOSITORIES.domain('ContextSequenceNode').get(ids.node),
    DOMAIN_REPOSITORIES.domain('ContextSegment').get(ids.segment),
    DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({ where: { segment_id: ids.segment }, limit: 2 }),
    DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').list({ where: { conversation_id: target }, limit: 2 })
  ]);
  const root = requireRow(structure.snapshot[0], 'Fork reservation root');
  const node = requireRow(structure.snapshot[1], 'Fork reservation node');
  const segment = requireRow(structure.snapshot[2], 'Fork reservation segment');
  const sources = requireRows(structure.snapshot[3], 'Fork reservation segment sources');
  const heads = requireRows(structure.snapshot[4], 'Fork reservation head');
  if (root.conversation_id !== target || root.root_node_id !== ids.node || root.tail_node_id !== null
    || BigInt(String(root.tail_segment_count)) !== 0n || BigInt(String(root.segment_count)) !== 1n
    || BigInt(String(root.estimated_tokens)) !== 0n || node.parent_node_id !== null || node.segment_id !== ids.segment
    || segment.segment_kind !== 'runtime_context' || sources.length !== 1 || sources[0].id !== ids.source
    || sources[0].source_kind !== 'runtime_context' || sources[0].source_id !== ids.projection
    || BigInt(String(sources[0].source_revision)) !== 0n || heads.length !== 1 || heads[0].root_id === ids.root) {
    throw reservationError('Fork reservation root is not an isolated, correctly scoped immutable artifact.');
  }
  const metadata = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('ContentObject').get(requireId(segment.content_object_id, 'Fork reservation content_object_id'))
  ]);
  const row = requireRow(metadata.snapshot[0], 'Fork reservation CAS metadata');
  if (row.content_type !== FORK_CONTEXT_HANDLE_RESERVATION_CONTENT_TYPE) throw reservationError('Fork reservation CAS type is invalid.');
  const value = normalizePlainJson(JSON.parse((await contentStore.read(row as unknown as ContentObjectMetadata)).toString('utf8')),
    'Fork Context handle reservations');
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== PAYLOAD_KIND
    || value.targetConversationId !== target || value.sourceConversationId !== branch.source_conversation_id) {
    throw reservationError('Fork reservation CAS payload conflicts with its branch or target.');
  }
  return { kind: PAYLOAD_KIND, sourceConversationId: requireId(value.sourceConversationId, 'Fork source Conversation'),
    targetConversationId: target, modelHandleCatalog: requireCurrentContextCatalog(value.modelHandleCatalog),
    coveredRecipeObjectIds: requireCoverage(value.coveredRecipeObjectIds) };
}

function requireCurrentContextCatalog(value: unknown): ModelHandleCatalog {
  const catalog = normalizeModelHandleCatalog(value);
  if (catalog.identityContractRevision !== CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION
    || catalog.entries.some(entry => !isPersistentContextHandle(entry.kind))) {
    throw reservationError('Fork reservations require the complete current persistent Context catalog.');
  }
  return catalog;
}

function reservationIds(target: string) {
  const digest = createHash('sha256').update('limcode-fork-context-handle-reservations\0').update(target).digest('hex');
  return { projection: `fork_handle_projection_${digest}`, root: `fork_handle_root_${digest}`,
    node: `fork_handle_node_${digest}`, segment: `fork_handle_segment_${digest}`, source: `fork_handle_source_${digest}` };
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw reservationError(`${label} is missing.`);
  return value.trim();
}

function requireRow(value: DomainRow | DomainRow[] | null, label: string): DomainRow {
  if (!value || Array.isArray(value)) throw reservationError(`${label} is missing.`);
  return value;
}

function requireRows(value: DomainRow | DomainRow[] | null, label: string): DomainRow[] {
  if (!Array.isArray(value)) throw reservationError(`${label} is invalid.`);
  return value;
}

function reservationError(message: string): Error {
  return Object.assign(new Error(message), { code: 'MODEL_CONTEXT_CHILD_HANDLE_CONFLICT' });
}

function requireCoverage(value: unknown): string[] {
  if (!Array.isArray(value)) throw reservationError('Fork reservation coveredRecipeObjectIds must be an array.');
  const result = new Set<string>();
  for (const candidate of value) {
    const id = requireId(candidate, 'Fork reservation covered recipe');
    if (id !== candidate || result.has(id)) throw reservationError('Fork reservation covered recipe identities must be unique non-empty strings.');
    result.add(id);
  }
  return [...result].sort();
}
