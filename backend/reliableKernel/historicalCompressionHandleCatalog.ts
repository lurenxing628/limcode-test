import { createHash } from 'node:crypto';
import { readProviderRequestFailure } from '../../shared/compressionExecution';
import { normalizeAttachmentCatalogState } from './attachmentCatalog';
import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import { COMPRESSION_SOURCE_REPLAY_LIMITS, expandTextCompressionSources } from './compressionSourceReplay';
import { ContextSequenceControlPlane, type StructuralContextRecord } from './contextSequence';
import { conversationForkSnapshotCopyId } from './conversationForkSnapshot';
import { buildModelHandleCatalog, CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION,
  isPersistentContextHandle, normalizeModelHandleCatalog, type ModelHandleCatalog } from './modelHandleCatalog';
import type { FullProviderContextItem } from './modelProviderControlPlane';
import { canonicalPlainJson, normalizePlainJson } from './plainJson';
import { stablePhaseFId } from './phaseFIdentity';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import type { RuntimeDatabase } from './runtimeDatabase';

/**
 * Published compression adapters could allocate references while projecting frozen source bytes
 * without storing those new identities in their recipe. We can prove which addresses were at risk,
 * not what a generated summary meant by one. Return retirement evidence only; never bind a derived
 * address to a historical target or inspect summary short-reference prose to guess an identity.
 */
export async function readHistoricalCompressionHandleCatalog(
  database: RuntimeDatabase,
  store: ContentAddressedStore,
  input: { recipe: unknown; requestId: string; conversationId: string }
): Promise<ModelHandleCatalog | undefined> {
  const recipe = object(input.recipe, 'Historical recipe');
  if (recipe.kind !== 'reliable-context-compression') return undefined;
  const frozenCatalog = normalizeModelHandleCatalog(recipe.modelHandleCatalog);
  if (frozenCatalog.identityContractRevision !== undefined) return undefined;
  // The published pre-short-reference recipe (including 0.0.10) had none of these fields.
  // A process id in its Context is not evidence that an adapter ever showed a P address.
  if (!Object.prototype.hasOwnProperty.call(recipe, 'attachmentCatalogState')) {
    if (recipe.modelHandleCatalog !== undefined || recipe.sourceReplay !== undefined) {
      throw invalid('Historical compression has no proved short-reference projection format.');
    }
    return undefined;
  }
  const attachmentState = normalizeAttachmentCatalogState(recipe.attachmentCatalogState,
    'Historical compression attachmentCatalogState');
  for (const attachment of attachmentState.catalog) {
    if (!frozenCatalog.entries.some(entry => entry.kind === 'attachment' && entry.target === attachment.attachmentId)) {
      throw invalid('Historical compression attachment has no frozen registry reference.');
    }
  }
  const method = recipe.compressionMethodKind;
  if (method !== 'provider_native' && method !== 'openai_responses_compact' && method !== 'llm_summary' && method !== 'segmented_summary'
    && method !== 'deterministic_summary' && method !== 'manual_summary') {
    throw invalid('Historical compression method is not executable.');
  }
  if (recipe.sourceReplay !== undefined && recipe.sourceReplay !== 'immutable_provenance') {
    throw invalid('Historical compression has an unknown source selector.');
  }
  // Published attachment-era recipes used openai_responses_compact before provider-native
  // execution plans and explicit sourceReplay existed. This exact spelling proves raw/full input;
  // it is not a negotiation flag and cannot be combined with a later producer's selector.
  if (method === 'openai_responses_compact' && recipe.sourceReplay !== undefined) {
    throw invalid('Published OpenAI compaction has no immutable source replay selector.');
  }
  const nativeMethod = method === 'provider_native' || method === 'openai_responses_compact';
  const sourceReplay = recipe.sourceReplay === 'immutable_provenance';
  if (sourceReplay && recipe.trigger !== 'manual') {
    throw invalid('Historical immutable source replay is not a manual compression request.');
  }
  const requestId = text(input.requestId, 'Historical ModelRequest id');
  const conversationId = text(input.conversationId, 'Historical Conversation id');
  const request = await get(database, 'ModelRequest', requestId);
  const turn = await get(database, 'Turn', text(request.turn_id, 'Historical ModelRequest Turn'));
  if (turn.conversation_id !== conversationId) throw invalid('Historical compression request belongs to another Conversation.');
  const recipeMetadata = await get(database, 'ContentObject', text(request.recipe_object_id, 'Historical frozen recipe id'));
  const storedRecipe = JSON.parse(decode(await store.read(recipeMetadata as unknown as ContentObjectMetadata),
    'Historical frozen recipe'));
  if (canonicalPlainJson(storedRecipe) !== canonicalPlainJson(recipe)) {
    throw invalid('Historical compression recipe differs from its frozen ModelRequest content.');
  }
  const projections = await listAllDomainRows(database, 'ModelContextProjection', {
    owner_kind: 'model_request', owner_id: requestId
  });
  if (projections.length > 1 || projections.length === 1 && projections[0].purpose !== 'provider-request') {
    throw invalid('Historical compression has no unique frozen provider Context projection.');
  }
  const sourceRootId = text(recipe.sourceRootId, 'Historical frozen source root');
  let sourceConversationId = conversationId;
  let structure: { root: DomainRow; records: StructuralContextRecord[] };
  if (projections.length === 0) {
    const copied = await readPublishedProjectionlessCopy(database, store, request, turn, conversationId, sourceRootId);
    structure = copied.structure;
    sourceConversationId = copied.sourceConversationId;
  } else {
    const rootId = text(projections[0].root_id, 'Historical projected Context root');
    structure = await new ContextSequenceControlPlane(database, store).materializeStructure(rootId);
    if (structure.root.id !== rootId || structure.root.conversation_id !== conversationId) {
      throw invalid('Historical compression Context root belongs to another Conversation.');
    }
    if (sourceRootId !== rootId) {
      await assertCopiedProjection(database, store, conversationId, sourceRootId, structure);
    }
  }
  const count = recipe.sourceSegmentCount;
  if (!Number.isSafeInteger(count) || (count as number) <= 0 || (count as number) > structure.records.length) {
    throw invalid('Historical compression source count is outside its frozen Context projection.');
  }
  const rejectedPartialNative = nativeMethod && !sourceReplay && count !== structure.records.length
    && await isRejectedPartialNativeRequest(database, request, recipe);
  if ((nativeMethod || sourceReplay) && count !== structure.records.length && !rejectedPartialNative) {
    throw invalid('Historical full-window compression selected a partial Context projection.');
  }
  if (structure.records[count as number]?.segment.segment_kind === 'tool_pair') {
    throw invalid('Historical compression source splits a tool exchange.');
  }
  const prefix = structure.records.slice(0, count as number);
  const hash = createHash('sha256').update(JSON.stringify(prefix.map(record => ({
    segmentId: record.segment.id, contentObjectId: record.segment.content_object_id,
    segmentKind: record.segment.segment_kind
  })))).digest('hex');
  if (recipe.sourceHash !== hash) throw invalid('Historical compression source identity does not match its frozen hash.');
  const context = await readSourcePrefix(store, prefix);
  // The published adapter rejected this exact attempt before producing a provider body. Keep its
  // frozen catalog as evidence, but it never exposed any newly derived source addresses. Ownership,
  // prefix boundary/hash and source CAS were still checked above; a failed status alone is no proof.
  if (rejectedPartialNative) return undefined;
  let possibleSources: readonly (readonly FullProviderContextItem[])[];
  if (sourceReplay) {
    possibleSources = [await expandTextCompressionSources(database, store, sourceConversationId, context,
      { sourceReplay: 'immutable_provenance' })];
  } else if (nativeMethod) {
    possibleSources = [context];
  } else {
    const expanded = await expandTextCompressionSources(database, store, sourceConversationId, context);
    // A published unmarked producer did not say whether it expanded native state before text
    // projection. The union only withdraws possible addresses. It never chooses one producer's
    // targets or constructs an actionable mapping from generated summary text.
    possibleSources = [context, expanded];
  }
  const frozenRefs = new Set(frozenCatalog.entries.map(entry => entry.ref));
  const retiredRefs = new Set<string>();
  for (const source of possibleSources) {
    const values = source.map(item => item.content);
    if (method === 'openai_responses_compact') {
      for (const ref of publishedOpenAiDerivedRefs(values, frozenCatalog)) retiredRefs.add(ref);
    } else {
      // Reproduce possible pure collectors over frozen bytes, never P1/A1 prose. Their canonical
      // targets are discarded: only addresses absent from the frozen recipe can be withdrawn.
      const derived = buildModelHandleCatalog(values, frozenCatalog.entries);
      for (const entry of derived.entries) {
        if (isPersistentContextHandle(entry.kind) && !frozenRefs.has(entry.ref)) retiredRefs.add(entry.ref);
      }
    }
  }
  if (retiredRefs.size === 0) return undefined;
  return normalizeModelHandleCatalog({ entries: [], retiredRefs: [...retiredRefs],
    identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION });
}

/** Exact published local preparation guards, before native input could reach a provider. */
const PARTIAL_NATIVE_PREPARATION_FAILURES = new Set([
  'Provider-native compression must freeze the complete model-visible Context projection.',
  'Provider-native compression requires the complete frozen model-visible window.'
]);

/** A retained local preparation failure is not evidence of an unsafe native provider send. */
async function isRejectedPartialNativeRequest(database: RuntimeDatabase, request: DomainRow,
  recipe: Record<string, unknown>): Promise<boolean> {
  if (recipe.compressionMethodKind !== 'provider_native' || request.status !== 'terminal'
    || request.terminal_state !== 'provider_failed') return false;
  const stats = request.stream_stats_json;
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return false;
  const record = stats as Record<string, unknown>;
  if (record.failure === undefined) return false;
  const failure = readProviderRequestFailure(record.failure);
  if (failure.category !== 'permanent' || !PARTIAL_NATIVE_PREPARATION_FAILURES.has(failure.message)
    || failure.code !== undefined || failure.status !== undefined || failure.reason !== undefined
    || failure.endpointKind !== undefined || request.usage_json !== null
    || record.lastStreamSeq !== undefined || record.firstOutputAt !== undefined
    || record.nativeLatestResponseUsage !== undefined || record.nativeResponseMetrics !== undefined) return false;
  // The producer always named the prospective block. Missing that identity must not turn the
  // absence check into a wildcard acceptance of arbitrary failed records.
  const blockId = text(recipe.blockId, 'Historical rejected native compression block');
  // The guard runs before any wire output. A successful output/fence or applied block contradicts
  // this producer and must not be hidden by the retained failure message.
  const evidence = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('ModelStreamCheckpoint').list({ where: { model_request_id: request.id }, limit: 1 }),
    DOMAIN_REPOSITORIES.domain('ModelStreamFence').list({ where: { model_request_id: request.id }, limit: 1 }),
    DOMAIN_REPOSITORIES.domain('CompressionBlock').get(blockId)
  ]);
  return Array.isArray(evidence.snapshot[0]) && evidence.snapshot[0].length === 0
    && Array.isArray(evidence.snapshot[1]) && evidence.snapshot[1].length === 0
    && evidence.snapshot[2] === null;
}

/** Exact published attachment-era OpenAI collector, before collaboration and plural child ids. */
function publishedOpenAiDerivedRefs(values: readonly unknown[], frozen: ModelHandleCatalog): string[] {
  type Kind = 'process' | 'cursor' | 'child' | 'workEnvironment';
  const prefixes: Record<Kind, string> = { process: 'P', cursor: 'O', child: 'A', workEnvironment: 'W' };
  const counters: Record<Kind, number> = { process: 0, cursor: 0, child: 0, workEnvironment: 0 };
  const targets = new Set<string>();
  for (const entry of frozen.entries) {
    if (entry.kind === 'attachment') continue;
    if (!(entry.kind in prefixes)) throw invalid('Published OpenAI compaction contains an unsupported frozen handle kind.');
    const kind = entry.kind as Kind;
    counters[kind] = Math.max(counters[kind], Number(entry.ref.slice(1)));
    targets.add(`${kind}\u0000${entry.target}`);
  }
  const refs: string[] = [];
  const optionalText = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const add = (kind: Kind, value: unknown) => {
    const target = optionalText(value);
    if (!target || targets.has(`${kind}\u0000${target}`)) return;
    targets.add(`${kind}\u0000${target}`);
    if (!Number.isSafeInteger(++counters[kind])) throw invalid('Historical derived handle ordinal exceeds its safe range.');
    refs.push(`${prefixes[kind]}${counters[kind]}`);
  };
  const seen = new Set<object>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length <= 16 * 1024 * 1024 && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
        let parsed: unknown;
        try { parsed = JSON.parse(trimmed); } catch { /* Ordinary text has no nested canonical fields. */ }
        if (parsed !== undefined) collect(parsed);
      }
      for (const match of value.matchAll(/\bwork-env-[a-zA-Z0-9._-]+\b/g)) add('workEnvironment', match[0]);
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const child of value) collect(child);
      return;
    }
    const record = value as Record<string, unknown>;
    add('process', record.processId);
    add('child', record.answerBridgeId);
    add('workEnvironment', record.workEnvironmentId);
    for (const key of ['nextOutputHandle', 'outputHandle']) {
      const cursor = optionalText(record[key]);
      if (cursor?.startsWith('rk-process-output:')) add('cursor', cursor);
    }
    for (const key of ['fromEnvironment', 'toEnvironment']) {
      const environment = optionalText(record[key]);
      if (environment?.startsWith('work-env-')) add('workEnvironment', environment);
    }
    for (const child of Object.values(record)) collect(child);
  };
  for (const value of values) collect(value);
  return refs;
}

/** Older child snapshots copied complete request aggregates and CAS, but omitted projections. */
async function readPublishedProjectionlessCopy(database: RuntimeDatabase, store: ContentAddressedStore,
  request: DomainRow, turn: DomainRow, target: string, sourceRootId: string): Promise<{
    structure: { root: DomainRow; records: StructuralContextRecord[] }; sourceConversationId: string
  }> {
  if (request.status !== 'terminal' || turn.status !== 'terminated') {
    throw invalid('Historical projectionless request is not a completed fork copy.');
  }
  await get(database, 'ContextSequenceRoot', sourceRootId);
  const structure = await new ContextSequenceControlPlane(database, store).materializeStructure(sourceRootId);
  const source = text(structure.root.conversation_id, 'Historical original root Conversation');
  if (structure.root.id !== sourceRootId || source === target) {
    throw invalid('Historical projectionless request has no original fork source root.');
  }
  const scopes: string[] = [];
  const visited = new Set<string>();
  let cursor = target;
  while (cursor !== source) {
    if (visited.has(cursor) || visited.size >= COMPRESSION_SOURCE_REPLAY_LIMITS.depth) {
      throw invalid('Historical fork-copy chain is cyclic or exceeds its proof limit.');
    }
    visited.add(cursor);
    const branches = await listAllDomainRows(database, 'ConversationBranchLink', { target_conversation_id: cursor });
    if (branches.length === 0 && scopes.length > 0) {
      // The immediate source id is already frozen by the proved target branch. Its Conversation
      // may have been deleted; a retained Context root proves that this named scope existed.
      // Apply that one named copy hop only. Unknown deeper ids are never searched for or guessed.
      const retained = (await database.snapshot([DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').list({
        where: { conversation_id: cursor }, limit: 1
      })])).snapshot[0];
      if (!Array.isArray(retained) || retained.length === 0) {
        throw invalid('Historical deleted fork scope has no retained Context root.');
      }
      scopes.push(cursor);
      break;
    }
    if (branches.length !== 1) throw invalid('Historical projectionless copy has no unique fork branch.');
    const branch = branches[0];
    const next = text(branch.source_conversation_id, 'Historical fork source');
    const origins = await listAllDomainRows(database, 'ConversationOriginLink', { conversation_id: cursor });
    const children = await listAllDomainRows(database, 'ChildExecution', { child_conversation_id: cursor });
    if (origins.length !== 1 || origins[0].source_conversation_id !== next || children.length > 1) {
      throw invalid('Historical fork copy origin does not match its branch.');
    }
    const childBranchId = stablePhaseFId('conversation_branch_link', 'child-context-fork', cursor);
    if (branch.id === childBranchId || children.length === 1) {
      const toolId = text(origins[0].source_tool_call_id, 'Historical child fork tool');
      const parentTurn = text(origins[0].source_turn_id, 'Historical child fork parent Turn');
      if (branch.id !== childBranchId || children.length !== 1
        || children[0].id !== stablePhaseFId('child_execution', toolId)
        || origins[0].id !== stablePhaseFId('conversation_origin_link', 'child', toolId)) {
        throw invalid('Historical child fork identity does not match the published copy contract.');
      }
      const parents = await listAllDomainRows(database, 'ChildExecutionParentLink', { child_execution_id: children[0].id });
      if (parents.length !== 1 || parents[0].id !== stablePhaseFId('child_execution_parent_link', toolId)
        || parents[0].source_tool_call_id !== toolId || parents[0].parent_turn_id !== parentTurn) {
        throw invalid('Historical child fork parent binding is missing or conflicting.');
      }
    } else if (origins[0].source_tool_call_id !== null
      || origins[0].source_message_revision_id !== branch.source_message_revision_id) {
      throw invalid('Historical human fork origin does not match its published branch.');
    }
    scopes.push(cursor);
    cursor = next;
  }
  if (scopes.length === 0) throw invalid('Historical projectionless request has no proved copy chain.');
  const authority = await get(database, 'AuthoritySnapshot', text(request.authority_snapshot_id, 'Historical copied authority'));
  if (authority.turn_id !== request.turn_id) throw invalid('Historical copied authority belongs to another Turn.');
  const metadata = await get(database, 'ContentObject', text(authority.content_object_id, 'Historical copied authority content'));
  const document = object(JSON.parse(decode(await store.read(metadata as unknown as ContentObjectMetadata),
    'Historical copied authority')), 'Historical copied authority');
  if (document.kind !== 'effective-turn-authority' || document.conversationId !== source) {
    throw invalid('Historical copied authority does not prove the original source Conversation.');
  }
  const applyCopies = (kind: string, id: string) => scopes.slice().reverse().reduce((previous, scope) =>
    conversationForkSnapshotCopyId(scope, kind, previous), id);
  if (applyCopies('turn', text(document.turnId, 'Historical original authority Turn')) !== request.turn_id) {
    throw invalid('Historical copied Turn does not match its frozen original authority.');
  }
  const originals = await listAllDomainRows(database, 'ModelContextProjection', { owner_kind: 'model_request', root_id: sourceRootId });
  const matches = originals.filter(projection => projection.purpose === 'provider-request'
    && applyCopies('model_request', text(projection.owner_id, 'Historical original projected request')) === request.id);
  if (matches.length !== 1) {
    throw invalid('Historical copied request has no exact retained original projection and copy-id chain.');
  }
  // The old aggregate copier kept the original recipe CAS, original authority CAS and source root.
  // Only addresses are withdrawn. Native/text expansion still requires intact original provenance.
  return { structure, sourceConversationId: source };
}

async function assertCopiedProjection(database: RuntimeDatabase, store: ContentAddressedStore,
  conversationId: string, originalRootId: string,
  target: { root: DomainRow; records: StructuralContextRecord[] }): Promise<void> {
  const branches = await listAllDomainRows(database, 'ConversationBranchLink', { target_conversation_id: conversationId });
  if (branches.length !== 1 || !text(branches[0].source_conversation_id, 'Historical fork source Conversation')) {
    throw invalid('Historical compression source root differs from its frozen Context projection.');
  }
  // Published forks created every copied root and the target branch in the same transaction,
  // over the exact immutable source node/tail shape. A branch alone is not a copy proof.
  const createdAt = text(target.root.created_at, 'Historical fork root creation time');
  if (createdAt !== text(branches[0].created_at, 'Historical fork branch creation time')) {
    throw invalid('Historical compression projection is not a fork-created root.');
  }
  await get(database, 'ContextSequenceRoot', originalRootId);
  const original = await new ContextSequenceControlPlane(database, store).materializeStructure(originalRootId);
  if (original.root.id !== originalRootId || original.root.conversation_id === conversationId
    || canonicalPlainJson(rootShape(original.root)) !== canonicalPlainJson(rootShape(target.root))
    || canonicalPlainJson(recordIdentities(original.records)) !== canonicalPlainJson(recordIdentities(target.records))) {
    throw invalid('Historical compression fork projection does not preserve its immutable original source.');
  }
  // The original root is dataset-retained immutable data. No live source Conversation, current
  // authority or target map is read, so nested forks still work after their sources are deleted.
}

function rootShape(root: DomainRow): Record<string, string | null> {
  const pointer = (value: unknown, label: string) => value === null ? null : text(value, label);
  const count = (value: unknown, label: string): string => {
    if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^\d+$/.test(value))) throw invalid(`${label} is invalid.`);
    const result = BigInt(value);
    if (result < 0n) throw invalid(`${label} is invalid.`);
    return result.toString();
  };
  return { rootNodeId: pointer(root.root_node_id, 'Historical root node'),
    tailNodeId: pointer(root.tail_node_id, 'Historical root tail'),
    tailSegmentCount: count(root.tail_segment_count, 'Historical root tail count'),
    segmentCount: count(root.segment_count, 'Historical root segment count') };
}

function recordIdentities(records: readonly StructuralContextRecord[]): Array<Record<string, string | null>> {
  return records.map(record => ({ nodeId: text(record.node.id, 'Historical source node'),
    parentNodeId: record.node.parent_node_id === null ? null : text(record.node.parent_node_id, 'Historical parent node'),
    segmentId: text(record.segment.id, 'Historical source segment'),
    contentObjectId: text(record.segment.content_object_id, 'Historical source content'),
    segmentKind: text(record.segment.segment_kind, 'Historical source kind') }));
}

async function readSourcePrefix(store: ContentAddressedStore,
  records: readonly StructuralContextRecord[]): Promise<FullProviderContextItem[]> {
  if (records.length > COMPRESSION_SOURCE_REPLAY_LIMITS.segments) throw invalid('Historical compression source exceeds its replay limit.');
  let bytes = 0;
  const output: FullProviderContextItem[] = [];
  const cached = new Map<string, string>();
  for (const record of records) {
    const metadata = record.contentObject;
    const contentId = text(record.segment.content_object_id, 'Historical segment content id');
    if (metadata.id !== contentId) throw invalid('Historical segment content identity is inconsistent.');
    let content = cached.get(contentId);
    if (content === undefined) {
      if (Number(metadata.byte_length) > COMPRESSION_SOURCE_REPLAY_LIMITS.bytes - bytes) {
        throw invalid('Historical compression source exceeds its replay byte limit.');
      }
      content = decode(await store.read(metadata as unknown as ContentObjectMetadata), 'Historical compression source');
      cached.set(contentId, content);
    }
    bytes += Buffer.byteLength(content, 'utf8');
    if (bytes > COMPRESSION_SOURCE_REPLAY_LIMITS.bytes) throw invalid('Historical compression source exceeds its replay byte limit.');
    const contentType = text(metadata.content_type, 'Historical source content type');
    let role: string | null = null;
    if (contentType === 'application/json' || contentType.endsWith('+json')) {
      const document = normalizePlainJson(JSON.parse(content), 'Historical compression source JSON');
      if (document && typeof document === 'object' && !Array.isArray(document)
        && (document.role === 'user' || document.role === 'model')) role = document.role;
    }
    output.push({ segmentId: text(record.segment.id, 'Historical segment id'),
      segmentKind: text(record.segment.segment_kind, 'Historical segment kind'), messageRole: role,
      contentType, content });
  }
  return output;
}

async function get(database: RuntimeDatabase, domain: string, id: string): Promise<DomainRow> {
  const row = (await database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)])).snapshot[0];
  if (!row || Array.isArray(row)) throw invalid(`${domain} historical compression evidence is missing.`);
  return row;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} is not an object.`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`${label} is missing.`);
  return value;
}
function decode(bytes: Buffer, label: string): string {
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) throw invalid(`${label} is not valid UTF-8.`);
  return content;
}
function invalid(message: string): Error {
  return Object.assign(new Error(message), { code: 'MODEL_CONTEXT_CHILD_HANDLE_CONFLICT' });
}
