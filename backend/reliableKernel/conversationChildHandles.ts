import { createHash } from 'node:crypto';
import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import { buildModelHandleCatalog, isCollaborationHandleTool, isPersistentAgentHandle, normalizeModelHandleCatalog, projectToolResultForModel, type ModelHandleCatalog, type ModelHandleEntry } from './modelHandleCatalog';
import { canonicalPlainJson, normalizePlainJson } from './plainJson';
import { DOMAIN_REPOSITORIES } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';

/**
 * Child and collaboration references belong to the Conversation's frozen request history, not the current Context
 * prefix. Forks copy retained ModelRequests with their immutable recipes, so the same read also
 * reserves inherited references without granting access to the source Conversation's children.
 * Missing CAS and conflicting identities are errors; neither permits renumbering from a summary.
 */
export async function readConversationChildHandles(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  conversationId: string
): Promise<ModelHandleEntry[]> {
  if (!conversationId.trim()) throw new TypeError('conversationId must be non-empty.');
  const turns = (await listAllDomainRows(database, 'Turn', { conversation_id: conversationId }))
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))
      || String(right.id).localeCompare(String(left.id)));
  const readTurn = async (turn: (typeof turns)[number]): Promise<ModelHandleEntry[] | undefined> => {
    const requests = (await listAllDomainRows(database, 'ModelRequest', { turn_id: turn.id }))
      .sort((left, right) => {
        const a = BigInt(String(left.request_seq)); const b = BigInt(String(right.request_seq));
        return a < b ? 1 : a > b ? -1 : String(right.id).localeCompare(String(left.id));
      });
    for (const request of requests) {
      if (typeof request.recipe_object_id !== 'string' || !request.recipe_object_id) {
        throw childHandleError(`ModelRequest ${String(request.id)} has no frozen recipe.`);
      }
      const snapshot = await database.snapshot([DOMAIN_REPOSITORIES.domain('ContentObject').get(request.recipe_object_id)]);
      const row = snapshot.snapshot[0];
      if (!row || Array.isArray(row)) throw childHandleError(`Frozen recipe ContentObject ${request.recipe_object_id} is missing.`);
      const content = await contentStore.read(row as unknown as ContentObjectMetadata);
      const recipe = normalizePlainJson(JSON.parse(content.toString('utf8')), 'Frozen child handle recipe');
      if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)) {
        throw childHandleError(`Frozen recipe ${request.recipe_object_id} is not an object.`);
      }
      if (recipe.kind !== 'reliable-agent-turn' && recipe.kind !== 'reliable-context-compression') continue;
      const entries = normalizeModelHandleCatalog(recipe.modelHandleCatalog).entries.filter(entry => isPersistentAgentHandle(entry.kind));
      // Every ordinary recipe is cumulative. Compression can be newer than the last ordinary
      // request when a preview allocated a child: use its complete frozen child catalog too.
      // A compression with no child catalog contributes no identity authority.
      if (recipe.kind === 'reliable-context-compression' && entries.length === 0) continue;
      return mergeConversationChildHandles(entries,
        await readNativeRequestChildHandles(database, contentStore, String(request.id)));
    }
    return undefined;
  };
  for (let index = 0; index < turns.length;) {
    const timestamp = turns[index].created_at;
    const group: typeof turns = [];
    while (index < turns.length && turns[index].created_at === timestamp) group.push(turns[index++]);
    // Turn ids are opaque hashes, not clocks. Concurrent/same-millisecond Turns must reconcile
    // their cumulative maps instead of allowing lexical id order to discard a newer reservation.
    const catalogs = (await Promise.all(group.map(readTurn))).filter((entries): entries is ModelHandleEntry[] => entries !== undefined);
    if (catalogs.length > 0) return mergeConversationChildHandles(...catalogs);
  }
  return [];
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
  childHandles: ModelHandleEntry[];
  output: string;
}

/** Immutable pre-send projections also survive a fork through copied ToolCallEvent/Source links. */
export async function readNativeRequestChildHandles(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  modelRequestId: string
): Promise<ModelHandleEntry[]> {
  const sources = await listAllDomainRows(database, 'ToolCallSourceLink', { model_request_id: modelRequestId });
  const events = (await Promise.all(sources.map(source => listAllDomainRows(database, 'ToolCallEvent', {
    tool_call_id: source.tool_call_id, event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT
  })))).flat();
  if (events.length === 0) return [];
  const metadata = await database.snapshot(events.map(event => DOMAIN_REPOSITORIES.domain('ContentObject').get(String(event.content_object_id))));
  const contents = await contentStore.readMany(metadata.snapshot.map((row, index) => {
    if (!row || Array.isArray(row) || row.content_type !== NATIVE_CHILD_HANDLE_PROJECTION_CONTENT_TYPE) {
      throw childHandleError(`Native child projection ${String(events[index].id)} has no valid CAS content.`);
    }
    return row as unknown as ContentObjectMetadata;
  }));
  if (contents.length !== events.length) throw childHandleError('Native child projection CAS batch is incomplete.');
  return mergeConversationChildHandles(...contents.map(content => parseNativeChildProjection(content.toString('utf8')).childHandles));
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
}): Promise<{ output: string; catalog: ModelHandleCatalog }> {
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
    return { output: frozen.output, catalog: withChildHandles(input.catalog, frozen.childHandles) };
  }
  const raw = normalizePlainJson(JSON.parse(input.raw), 'Native child ToolModelResult');
  const discovered = buildModelHandleCatalog([isCollaborationHandleTool(input.toolName)
    ? { kind: 'agent_collaboration', detail: raw } : raw], input.catalog.entries).entries.filter(entry => isPersistentAgentHandle(entry.kind));
  const catalog = withChildHandles(input.catalog, discovered);
  const output = canonicalPlainJson(normalizePlainJson(projectToolResultForModel(input.toolName, raw, catalog), 'Native child model output'));
  const frozen: NativeChildProjection = {
    kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT, modelRequestId: input.modelRequestId,
    toolCallId: input.toolCallId, toolModelResultId: input.toolModelResultId, toolName: input.toolName,
    childHandles: catalog.entries.filter(entry => isPersistentAgentHandle(entry.kind)), output
  };
  const content = await input.contentStore.prepare(input.database,
    canonicalPlainJson(normalizePlainJson(frozen, 'Native child projection')), NATIVE_CHILD_HANDLE_PROJECTION_CONTENT_TYPE);
  await input.database.transaction([
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

export function withChildHandles(catalog: ModelHandleCatalog, entries: readonly ModelHandleEntry[]): ModelHandleCatalog {
  return { entries: [...catalog.entries.filter(entry => !isPersistentAgentHandle(entry.kind)),
    ...mergeConversationChildHandles(catalog.entries, entries)] };
}

function parseNativeChildProjection(text: string): NativeChildProjection {
  const value = normalizePlainJson(JSON.parse(text), 'Native child projection');
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== NATIVE_CHILD_HANDLE_PROJECTION_EVENT
    || !Array.isArray(value.childHandles) || typeof value.output !== 'string') {
    throw childHandleError('Native child projection has an invalid shape.');
  }
  for (const key of ['modelRequestId', 'toolCallId', 'toolModelResultId', 'toolName']) {
    if (typeof value[key] !== 'string' || !value[key]) throw childHandleError(`Native child projection lacks ${key}.`);
  }
  const entries = normalizeModelHandleCatalog({ entries: value.childHandles }).entries;
  if (entries.some(entry => !isPersistentAgentHandle(entry.kind))) throw childHandleError('Native child projection contains non-agent identities.');
  return { ...value, childHandles: entries } as unknown as NativeChildProjection;
}

/** A preview can allocate a newly spawned child before its ordinary recipe has been committed. */
export function mergeConversationChildHandles(...groups: readonly (readonly ModelHandleEntry[])[]): ModelHandleEntry[] {
  const byRef = new Map<string, ModelHandleEntry>();
  const byTarget = new Map<string, ModelHandleEntry>();
  for (const entry of groups.flat()) {
    if (!isPersistentAgentHandle(entry.kind)) continue;
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
