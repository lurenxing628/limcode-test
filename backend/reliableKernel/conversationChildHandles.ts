import { createHash } from 'node:crypto';
import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import { buildModelHandleCatalog, CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION, isCollaborationHandleTool, isPersistentContextHandle, mergeModelHandleCatalogs, normalizeModelHandleCatalog, reconcileHistoricalModelHandleCatalogs, type ModelHandleCatalog, type ModelHandleEntry } from './modelHandleCatalog';
import { canonicalPlainJson, normalizePlainJson, type PlainJsonValue } from './plainJson';
import { ContextHandleReadMemo } from './contextHandleReadMemo';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';
import type { OpenAIResponsesToolOutput } from '../../shared/openAIResponsesNative';
import { projectNativeToolResultOutput } from './modelFacingContextProjection';
import { readForkContextHandleReservationEvidence } from './forkContextHandleReservations';
import { readHistoricalCompressionHandleCatalog } from './historicalCompressionHandleCatalog';
import { readCurrentConversationContextHandleState } from './conversationContextHandleState';
import { readCachedContextHandleState, type ContextHandleRequestEvidence } from './contextHandleEvidenceCache';

/**
 * Frozen recipes and native projections are identity evidence, including requests before a
 * compression in the same Turn. Published window/clock-dependent Context aliases may conflict;
 * reconciliation retires those aliases without changing the immutable history. Current identities
 * and each native request's frozen scope remain strict. Forks read their copied evidence only.
 */
export async function readConversationChildHandles(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  conversationId: string
): Promise<ModelHandleEntry[]> {
  return (await readConversationContextHandleCatalog(database, contentStore, conversationId)).entries;
}

export async function readConversationContextHandleCatalog(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  conversationId: string
): Promise<ModelHandleCatalog> {
  return (await readConversationContextHandleState(database, contentStore, conversationId)).catalog;
}

export async function readConversationContextHandleState(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  conversationId: string
): Promise<{ catalog: ModelHandleCatalog; requiresNativeReset: boolean }> {
  if (!conversationId.trim()) throw new TypeError('conversationId must be non-empty.');
  const state = await readCurrentConversationContextHandleState(database, contentStore, conversationId);
  return { catalog: state.catalog, requiresNativeReset: state.requiresNativeReset };
}

/** Complete historical reader belongs to explicit upgrade/recovery, never ordinary request creation. */
export async function rebuildHistoricalConversationContextHandleState(
  database: RuntimeDatabase, contentStore: ContentAddressedStore, conversationId: string
): Promise<{ catalog: ModelHandleCatalog; requiresNativeReset: boolean }> {
  let memo = new ContextHandleReadMemo();
  return readCachedContextHandleState(database, contentStore, conversationId, {
    beginRead: () => { memo = new ContextHandleReadMemo(); },
    fork: db => readForkContextHandleReservationEvidence(db, contentStore, conversationId),
    request: (db, request, covered) => readRequestContextHandleEvidence(db, contentStore, conversationId, request, covered, memo),
    reconcile: (fork, evidence) => {
      const catalogs = [...(fork ? [fork.catalog] : []), ...evidence.catalogs];
      const catalog = reconcileHistoricalModelHandleCatalogs(catalogs);
      const requiresNativeReset = (catalog.retiredRefs?.length ?? 0) > 0
        && !evidence.hasCurrentOrdinaryCatalog(catalog);
      return { catalog, requiresNativeReset };
    }
  });
}

export async function readRequestContextHandleEvidence(database: RuntimeDatabase, contentStore: ContentAddressedStore,
  conversationId: string, request: DomainRow, covered: boolean, memo: ContextHandleReadMemo): Promise<ContextHandleRequestEvidence> {
  if (typeof request.recipe_object_id !== 'string' || !request.recipe_object_id) {
    throw childHandleError(`ModelRequest ${String(request.id)} has no frozen recipe.`);
  }
  const snapshot = await database.snapshot([DOMAIN_REPOSITORIES.domain('ContentObject').get(request.recipe_object_id)]);
  const row = snapshot.snapshot[0];
  if (!row || Array.isArray(row)) throw childHandleError(`Frozen recipe ContentObject ${request.recipe_object_id} is missing.`);
  const metadata = row as unknown as ContentObjectMetadata;
  let frozen = memo.recipe(metadata);
  let recipe: PlainJsonValue | undefined;
  if (!frozen) {
    const content = await contentStore.read(metadata);
    // JSON.parse establishes syntax/plain objects. Only handle evidence is consumed here;
    // full recipe schema validation belongs to its producer/import and execution boundaries.
    recipe = JSON.parse(content.toString('utf8')) as PlainJsonValue;
    if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
      throw childHandleError(`Frozen recipe ${request.recipe_object_id} is not an object.`);
    }
    frozen = recipe.kind === 'reliable-agent-turn' || recipe.kind === 'reliable-context-compression'
      ? { kind: recipe.kind, catalog: memo.persistent(memo.catalog(recipe.modelHandleCatalog)) } : {};
    // Legacy compression recovery is request/source-specific and still needs the original body.
    // Never retain that graph or mistake another request's recovery for this request's proof.
    if (frozen.kind !== 'reliable-context-compression'
      || frozen.catalog?.identityContractRevision === CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION) {
      memo.rememberRecipe(metadata, frozen);
    }
  }
  const catalogs: ModelHandleCatalog[] = [];
  if (frozen.catalog) {
    catalogs.push(frozen.catalog);
    // A fork's private artifact already covers the named recipes outside its copied window.
    if (!covered && frozen.kind === 'reliable-context-compression'
      && frozen.catalog.identityContractRevision !== CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION) {
      const derived = await readHistoricalCompressionHandleCatalog(database, contentStore, {
        recipe, requestId: String(request.id), conversationId
      });
      if (derived) catalogs.push(derived);
    }
  }
  const nativeCatalogs = await readNativeRequestContextCatalogs(database, contentStore, String(request.id), createFrozenHandleReadCache(memo));
  // Native outputs from one immutable request share exactly its frozen scope. Legacy aliases
  // across requests can be reconciled, but contradictory identities within one scope cannot.
  const requestScope = nativeCatalogs.length > 0
    ? memo.scope([...(frozen.catalog ? [frozen.catalog] : []), ...nativeCatalogs]) : frozen.catalog;
  catalogs.push(...nativeCatalogs);
  return { catalogs, frontierCovered: covered || frozen?.kind !== 'reliable-context-compression'
    || frozen.catalog?.identityContractRevision === CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION, ...(frozen.kind === 'reliable-agent-turn'
    && frozen.catalog?.identityContractRevision === CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION
    ? { currentOrdinaryCatalog: requestScope! } : {}) };
}

/** A fork target keeps exactly one ConversationBranchLink, even after its source is deleted. */
export async function isForkConversation(database: RuntimeDatabase, conversationId: string): Promise<boolean> {
  const snapshot = await database.snapshot([DOMAIN_REPOSITORIES.domain('ConversationBranchLink').list({
    where: { target_conversation_id: conversationId },
    limit: 1
  })]);
  const rows = snapshot.snapshot[0];
  return Array.isArray(rows) && rows.length === 1;
}

/**
 * The Conversations a fork was copied from, nearest first: its branch source, that source's own
 * branch source, and so on. Copied history that speaks of "this conversation" means one of them.
 * A source deleted since keeps its id in the branch link and ends the chain.
 */
export async function forkSourceConversationIds(database: RuntimeDatabase, conversationId: string): Promise<string[]> {
  const sources: string[] = [];
  for (let current = conversationId; sources.length < 64;) {
    const snapshot = await database.snapshot([DOMAIN_REPOSITORIES.domain('ConversationBranchLink').list({
      where: { target_conversation_id: current },
      limit: 1
    })]);
    const rows = snapshot.snapshot[0];
    const source = Array.isArray(rows) && rows[0] ? String(rows[0].source_conversation_id) : '';
    if (!source || source === conversationId || sources.includes(source)) break;
    sources.push(source);
    current = source;
  }
  return sources;
}

/**
 * A fork copies history that mentions its source's children but never their ChildExecution parent
 * relation. In a fork, every child ref of the persistent catalog that is not one of its own child
 * tasks was inherited: it stays addressable in the copied history and is never operable here.
 */
export function forkInheritedChildTargets(
  childHandles: readonly ModelHandleEntry[],
  ownChildTargets: ReadonlySet<string>
): string[] {
  return childHandles
    .filter((entry) => entry.kind === 'child' && !ownChildTargets.has(entry.target))
    .map((entry) => entry.target);
}

export const NATIVE_CHILD_HANDLE_PROJECTION_EVENT = 'native_child_handle_projection';
const NATIVE_CHILD_HANDLE_PROJECTION_CONTENT_TYPE = 'application/vnd.limcode.native-child-handle-projection+json';

interface NativeChildProjection {
  kind: typeof NATIVE_CHILD_HANDLE_PROJECTION_EVENT;
  modelRequestId: string;
  toolCallId: string;
  toolModelResultId: string;
  toolName: string;
  modelHandleCatalog: ModelHandleCatalog;
  output: NonNullable<OpenAIResponsesToolOutput['output']>;
}

interface FrozenHandleReadCache {
  memo?: ContextHandleReadMemo;
  nativeProjections: Map<string, NativeChildProjection>;
}

function createFrozenHandleReadCache(memo?: ContextHandleReadMemo): FrozenHandleReadCache {
  return { nativeProjections: new Map(), memo };
}

function persistentContextCatalog(value: unknown): ModelHandleCatalog {
  const catalog = normalizeModelHandleCatalog(value);
  return { ...catalog, entries: catalog.entries.filter(entry => isPersistentContextHandle(entry.kind)) };
}

/** Immutable pre-send projections also survive a fork through copied ToolCallEvent/Source links. */
export async function readNativeRequestChildHandles(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  modelRequestId: string
): Promise<ModelHandleEntry[]> {
  return (await readNativeRequestContextHandleCatalog(database, contentStore, modelRequestId)).entries;
}

export async function readNativeRequestContextHandleCatalog(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  modelRequestId: string
): Promise<ModelHandleCatalog> {
  const catalogs = await readNativeRequestContextCatalogs(
    database, contentStore, modelRequestId, createFrozenHandleReadCache()
  );
  const merged = mergeModelHandleCatalogs(...catalogs);
  // An in-flight published request still interprets its frozen window-local refs. Its native
  // output must not claim that those addresses have adopted the Conversation-wide contract.
  return catalogs.some(catalog => catalog.identityContractRevision !== undefined)
    ? merged : { entries: merged.entries };
}

async function readNativeRequestContextCatalogs(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  modelRequestId: string,
  cache: FrozenHandleReadCache
): Promise<ModelHandleCatalog[]> {
  const sources = await listAllDomainRows(database, 'ToolCallSourceLink', { model_request_id: modelRequestId });
  const events = (await Promise.all(sources.map(source => listAllDomainRows(database, 'ToolCallEvent', {
    tool_call_id: source.tool_call_id, event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT
  })))).flat();
  if (events.length === 0) return [];
  const uncachedIds = [...new Set(events.map(event => String(event.content_object_id)))]
    .filter(id => !cache.nativeProjections.has(id));
  if (uncachedIds.length > 0) {
    const metadata = await database.snapshot(uncachedIds.map(id => DOMAIN_REPOSITORIES.domain('ContentObject').get(id)));
    const contents = await contentStore.readMany(metadata.snapshot.map((row, index) => {
      if (!row || Array.isArray(row) || row.content_type !== NATIVE_CHILD_HANDLE_PROJECTION_CONTENT_TYPE) {
        throw childHandleError(`Native child projection ${uncachedIds[index]} has no valid CAS content.`);
      }
      return row as unknown as ContentObjectMetadata;
    }));
    if (contents.length !== uncachedIds.length) throw childHandleError('Native child projection CAS batch is incomplete.');
    for (let index = 0; index < contents.length; index += 1) {
      cache.nativeProjections.set(uncachedIds[index], parseNativeChildProjection(contents[index].toString('utf8'), cache.memo));
    }
  }
  return events.map(event => {
    const projection = cache.nativeProjections.get(String(event.content_object_id));
    if (!projection) throw childHandleError(`Native child projection ${String(event.id)} is missing.`);
    return cache.memo?.persistent(projection.modelHandleCatalog) ?? persistentContextCatalog(projection.modelHandleCatalog);
  });
}

/** Freeze before the wire, without changing the original request recipe or claiming delivery ACK. */
export async function freezeNativeChildToolProjection(input: {
  database: RuntimeDatabase;
  contentStore: ContentAddressedStore;
  modelRequestId: string;
  toolCallId: string;
  toolModelResultId: string;
  messageRevisionId: string;
  contentObjectId: string;
  toolName: string;
  raw: string;
  catalog: ModelHandleCatalog;
  now: string;
}): Promise<{ output: NonNullable<OpenAIResponsesToolOutput['output']>; catalog: ModelHandleCatalog }> {
  const eventId = `native_child_projection_${createHash('sha256')
    .update(JSON.stringify([input.modelRequestId, input.toolCallId, input.toolModelResultId])).digest('hex')}`;
  const barrier = await input.database.snapshot([
    DOMAIN_REPOSITORIES.domain('ToolCallEvent').get(eventId),
    DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').list({ where: { tool_call_id: input.toolCallId }, limit: 2 }),
    DOMAIN_REPOSITORIES.domain('ModelRequest').get(input.modelRequestId)
  ]);
  const sourceRows = barrier.snapshot[1];
  const source = Array.isArray(sourceRows) && sourceRows.length === 1 ? sourceRows[0] : undefined;
  const request = barrier.snapshot[2];
  if (!source || source.model_request_id !== input.modelRequestId || !request || Array.isArray(request)) {
    throw childHandleError('Native child projection source does not belong to the carrier ModelRequest.');
  }
  const existing = barrier.snapshot[0];
  if (existing && !Array.isArray(existing)) {
    const metadata = (await input.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ContentObject').get(String(existing.content_object_id))
    ])).snapshot[0];
    if (!metadata || Array.isArray(metadata) || metadata.content_type !== NATIVE_CHILD_HANDLE_PROJECTION_CONTENT_TYPE) {
      throw childHandleError('Frozen native child projection content is missing.');
    }
    const frozen = parseNativeChildProjection((await input.contentStore.read(metadata as unknown as ContentObjectMetadata)).toString('utf8'));
    if (frozen.modelRequestId !== input.modelRequestId || frozen.toolCallId !== input.toolCallId
      || frozen.toolModelResultId !== input.toolModelResultId || frozen.toolName !== input.toolName) {
      throw childHandleError('Frozen native child projection identity conflicts with its result.');
    }
    return { output: frozen.output, catalog: withChildHandles(input.catalog, frozen.modelHandleCatalog) };
  }
  const raw = normalizePlainJson(JSON.parse(input.raw), 'Native child ToolModelResult');
  const discovered = persistentContextCatalog(buildModelHandleCatalog([isCollaborationHandleTool(input.toolName)
    ? { kind: 'agent_collaboration', detail: raw } : raw], input.catalog));
  const catalog = withChildHandles(input.catalog, discovered);
  const output = projectNativeToolResultOutput(input.toolName, raw, catalog);
  const frozen: NativeChildProjection = {
    kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT, modelRequestId: input.modelRequestId,
    toolCallId: input.toolCallId, toolModelResultId: input.toolModelResultId, toolName: input.toolName,
    modelHandleCatalog: catalog, output
  };
  const content = await input.contentStore.prepare(input.database,
    canonicalPlainJson(normalizePlainJson(frozen, 'Native child projection')), NATIVE_CHILD_HANDLE_PROJECTION_CONTENT_TYPE);
  const turn = (await input.database.snapshot([DOMAIN_REPOSITORIES.domain('Turn').get(String(request.turn_id))])).snapshot[0];
  if (!turn || Array.isArray(turn) || typeof turn.conversation_id !== 'string') {
    throw childHandleError('Native child projection carrier has no owning Conversation.');
  }
  await input.database.transaction([
    DOMAIN_REPOSITORIES.domain('Turn').assert(String(turn.id), { conversation_id: turn.conversation_id }),
    DOMAIN_REPOSITORIES.domain('ModelRequest').assert(input.modelRequestId, { turn_id: request.turn_id }),
    DOMAIN_REPOSITORIES.domain('ToolCall').assert(input.toolCallId, {
      turn_id: request.turn_id, tool_name: input.toolName, status: 'terminal'
    }),
    DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').assert(String(source.id), {
      tool_call_id: input.toolCallId, model_request_id: input.modelRequestId
    }),
    DOMAIN_REPOSITORIES.domain('ToolModelResult').assert(input.toolModelResultId, {
      tool_call_id: input.toolCallId, message_revision_id: input.messageRevisionId
    }),
    DOMAIN_REPOSITORIES.domain('MessageRevision').assert(input.messageRevisionId, { content_object_id: input.contentObjectId }),
    DOMAIN_REPOSITORIES.domain('ToolCallEvent').assertNone({ id: eventId }),
    ...preparedContentObjectSteps([content], 'native_child_projection'),
    DOMAIN_REPOSITORIES.domain('ToolCallEvent').insertWithNextSequence({
      id: eventId, tool_call_id: input.toolCallId, event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT,
      content_object_id: content.metadata.id, created_at: input.now
    }, { column: 'event_seq', scope: { tool_call_id: input.toolCallId } })
  ]);
  return { output, catalog };
}

export function withChildHandles(
  catalog: ModelHandleCatalog,
  entries: readonly ModelHandleEntry[] | ModelHandleCatalog
): ModelHandleCatalog {
  const source = normalizeModelHandleCatalog(catalog);
  const additions = Array.isArray(entries)
    ? { entries: entries.filter(entry => isPersistentContextHandle(entry.kind)) }
    : persistentContextCatalog(entries);
  const merged = mergeModelHandleCatalogs(source, additions);
  if (source.identityContractRevision !== undefined) return merged;
  if ((merged.retiredRefs?.length ?? 0) > 0) {
    throw childHandleError('A frozen window-local native request cannot adopt retired Context references.');
  }
  return { entries: merged.entries };
}

function parseNativeChildProjection(text: string, memo?: ContextHandleReadMemo): NativeChildProjection {
  const value = JSON.parse(text) as PlainJsonValue;
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== NATIVE_CHILD_HANDLE_PROJECTION_EVENT
    || !(typeof value.output === 'string' || (Array.isArray(value.output) && value.output.every(block =>
      block !== null && typeof block === 'object' && !Array.isArray(block)
      && ['input_text', 'input_image', 'input_file'].includes(String(block.type)))))) {
    throw childHandleError('Native child projection has an invalid shape.');
  }
  for (const key of ['modelRequestId', 'toolCallId', 'toolModelResultId', 'toolName']) {
    if (typeof value[key] !== 'string' || !value[key]) throw childHandleError(`Native child projection lacks ${key}.`);
  }
  const hasCatalog = Object.prototype.hasOwnProperty.call(value, 'modelHandleCatalog');
  const hasLegacyEntries = Object.prototype.hasOwnProperty.call(value, 'childHandles');
  const allowedKeys = new Set(['kind', 'modelRequestId', 'toolCallId', 'toolModelResultId', 'toolName', 'output',
    hasCatalog ? 'modelHandleCatalog' : 'childHandles']);
  if (hasCatalog === hasLegacyEntries || Object.keys(value).some(key => !allowedKeys.has(key))
    || (!hasCatalog && !Array.isArray(value.childHandles))) {
    throw childHandleError('Native child projection has an invalid catalog shape.');
  }
  const catalogValue = hasCatalog ? value.modelHandleCatalog : { entries: value.childHandles };
  const modelHandleCatalog = memo?.catalog(catalogValue) ?? normalizeModelHandleCatalog(catalogValue);
  if (hasCatalog && (value.modelHandleCatalog === null || typeof value.modelHandleCatalog !== 'object'
    || Array.isArray(value.modelHandleCatalog)
    || !Array.isArray(value.modelHandleCatalog.entries))) {
    throw childHandleError('Native child projection has an invalid Context catalog.');
  }
  if (!hasCatalog && modelHandleCatalog.entries.some(entry => !isPersistentContextHandle(entry.kind))) {
    throw childHandleError('Native tool projection contains identities outside the persistent Context catalog.');
  }
  return { kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT, modelRequestId: value.modelRequestId as string,
    toolCallId: value.toolCallId as string, toolModelResultId: value.toolModelResultId as string,
    toolName: value.toolName as string, modelHandleCatalog,
    output: value.output as NonNullable<OpenAIResponsesToolOutput['output']> };
}

/** A preview can allocate a newly spawned child before its ordinary recipe has been committed. */
export function mergeConversationChildHandles(...groups: readonly (readonly ModelHandleEntry[])[]): ModelHandleEntry[] {
  const byRef = new Map<string, ModelHandleEntry>();
  const byTarget = new Map<string, ModelHandleEntry>();
  for (const entry of groups.flat()) {
    if (!isPersistentContextHandle(entry.kind)) continue;
    const normalized = normalizeModelHandleCatalog({ entries: [entry] }).entries[0];
    const ref = byRef.get(normalized.ref);
    const targetIdentity = `${normalized.kind}\u0000${normalized.target}`;
    const target = byTarget.get(targetIdentity);
    if (ref && ref.target !== normalized.target || target && target.ref !== normalized.ref) {
      throw childHandleError(`Conflicting frozen child reference ${normalized.ref}.`);
    }
    byRef.set(normalized.ref, normalized);
    byTarget.set(targetIdentity, normalized);
  }
  return [...byRef.values()].sort((left, right) => Number(left.ref.slice(1)) - Number(right.ref.slice(1)));
}

function childHandleError(message: string): Error {
  return Object.assign(new Error(message), { code: 'MODEL_CONTEXT_CHILD_HANDLE_CONFLICT' });
}
