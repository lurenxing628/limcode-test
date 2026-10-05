import type { ReliableAgentToolDefinition } from './agentLoop';
import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import { normalizePlainJson, type PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';
import { sameBindingIdentity } from './rootAuthority';

export const FROZEN_TOOL_DEFINITIONS_CONTENT_TYPE = 'application/vnd.limcode.frozen-tool-definitions+json';
export const FROZEN_TOOL_DEFINITIONS_CACHE_LIMITS = Object.freeze({ entries: 16, bytes: 8 * 1024 * 1024 });
export interface FrozenToolDefinitionsReference { contentObjectId: string }

interface PreparedDefinitions { bytes: string; byteLength: number }
const preparedDefinitions = new WeakMap<readonly ReliableAgentToolDefinition[], PreparedDefinitions>();

/** Own every nested value before publishing an identity that can be reused without walking it. */
export function prepareFrozenToolDefinitions(value: unknown): readonly ReliableAgentToolDefinition[] {
  if (Array.isArray(value) && preparedDefinitions.has(value)) return value;
  const tools = normalizePlainJson(value, 'Frozen tool definitions');
  if (!Array.isArray(tools)) throw invalid('Frozen tool definitions must be an array.');
  for (const [index, tool] of tools.entries()) {
    const entry = record(tool, `Frozen tool definition ${index}`);
    if (typeof entry.name !== 'string' || !entry.name.trim()
      || typeof entry.description !== 'string' || !('parameters' in entry)) {
      throw invalid(`Frozen tool definition ${index} is incomplete.`);
    }
  }
  freezeDeep(tools);
  const definitions = tools as unknown as readonly ReliableAgentToolDefinition[];
  // normalizePlainJson already established canonical key order. Serialize once; CAS owns hashing.
  const bytes = JSON.stringify({ kind: 'frozen-tool-definitions', tools });
  preparedDefinitions.set(definitions, { bytes, byteLength: Buffer.byteLength(bytes, 'utf8') });
  return definitions;
}

/** Already-computed size, suitable for bounding effective-projection caches without retained walks. */
export function frozenToolDefinitionsByteLength(tools: readonly ReliableAgentToolDefinition[]): number {
  const prepared = preparedDefinitions.get(tools);
  if (!prepared) throw invalid('Tool definitions have no immutable preparation identity.');
  return prepared.byteLength;
}

interface CacheEntry { metadata: ContentObjectMetadata; tools: readonly ReliableAgentToolDefinition[]; charge: number }
interface StoreCache {
  entries: Map<string, CacheEntry>;
  bytes: number;
  writes: WeakMap<readonly ReliableAgentToolDefinition[], Promise<ContentObjectMetadata>>;
}
const caches = new WeakMap<RuntimeDatabase, WeakMap<ContentAddressedStore, StoreCache>>();
function cacheFor(database: RuntimeDatabase, store: ContentAddressedStore): StoreCache {
  if (!sameBindingIdentity(database.binding, store.binding)) throw invalid('Frozen tools require the same database and CAS RootBinding.');
  let stores = caches.get(database);
  if (!stores) { stores = new WeakMap(); caches.set(database, stores); }
  let cache = stores.get(store);
  if (!cache) { cache = { entries: new Map(), bytes: 0, writes: new WeakMap() }; stores.set(store, cache); }
  return cache;
}

/**
 * A toolset is a strong CAS edge, independent of its producer Turn/Conversation. ContentObject
 * registrations survive Conversation deletion; fork retains the original recipe; whole-dataset
 * export/import and both merge paths copy every registration. Future reachability GC must follow
 * recipe.toolsReference.contentObjectId before collecting these bodies.
 */
export async function freezeToolDefinitions(database: RuntimeDatabase, store: ContentAddressedStore,
  value: readonly ReliableAgentToolDefinition[]): Promise<FrozenToolDefinitionsReference> {
  const tools = prepareFrozenToolDefinitions(value);
  const cache = cacheFor(database, store);
  let pending = cache.writes.get(tools);
  if (!pending) {
    pending = (async () => {
      const metadata = await store.ingest(database, preparedDefinitions.get(tools)!.bytes, FROZEN_TOOL_DEFINITIONS_CONTENT_TYPE);
      // A flight is reusable only after registration is fully checked, including concurrent callers.
      return registeredMetadata(database, metadata.id, metadata);
    })();
    cache.writes.set(tools, pending);
  }
  let metadata: ContentObjectMetadata;
  try { metadata = await pending; }
  catch (error) { if (cache.writes.get(tools) === pending) cache.writes.delete(tools); throw error; }
  // Registrations are immutable until dataset reset. Reuse verified metadata under the live fence.
  await assertCachedOwner(database, metadata);
  remember(cache, metadata, tools);
  return { contentObjectId: metadata.id };
}

export function frozenToolDefinitionsReference(recipeValue: unknown): FrozenToolDefinitionsReference | undefined {
  const recipe = record(recipeValue, 'Frozen recipe');
  if (!('toolsReference' in recipe)) return undefined;
  if ('tools' in recipe) throw invalid('Frozen recipe cannot contain both inline tools and a tool reference.');
  const reference = record(recipe.toolsReference, 'Frozen tool definitions reference');
  if (Object.keys(reference).length !== 1 || typeof reference.contentObjectId !== 'string' || !reference.contentObjectId) {
    throw invalid('Frozen tool definitions reference must contain exactly one CAS identity.');
  }
  return { contentObjectId: reference.contentObjectId };
}

/** Read the original snapshot only. Published inline recipes retain their original bytes. */
export async function resolveFrozenToolDefinitions(database: RuntimeDatabase, store: ContentAddressedStore,
  recipeValue: unknown): Promise<readonly ReliableAgentToolDefinition[]> {
  const reference = frozenToolDefinitionsReference(recipeValue);
  if (!reference) return inlineTools(recipeValue);
  const cache = cacheFor(database, store);
  const cached = cache.entries.get(reference.contentObjectId);
  if (cached) {
    await assertCachedOwner(database, cached.metadata);
    // Validation can yield while another request evicts/replaces this entry. Do not resurrect it
    // without its byte charge; the already-held immutable value remains safe for this caller.
    if (cache.entries.get(reference.contentObjectId) === cached) {
      cache.entries.delete(reference.contentObjectId); cache.entries.set(reference.contentObjectId, cached);
    }
    return cached.tools;
  }
  const metadata = await registeredMetadata(database, reference.contentObjectId);
  const body = record(JSON.parse((await store.read(metadata)).toString('utf8')), 'Frozen tool definitions body');
  if (body.kind !== 'frozen-tool-definitions' || Object.keys(body).some(key => !['kind', 'tools'].includes(key))) {
    throw invalid('Frozen tool definitions body has an invalid kind or shape.');
  }
  const tools = prepareFrozenToolDefinitions(body.tools);
  remember(cache, metadata, tools);
  return tools;
}

/** Projection must resolve references before entering its synchronous provider/estimator code. */
export function providerRequestToolDefinitions(request: { recipe: unknown; resolvedTools?: readonly ReliableAgentToolDefinition[] }): readonly ReliableAgentToolDefinition[] {
  if (request.resolvedTools !== undefined) return request.resolvedTools;
  if (frozenToolDefinitionsReference(request.recipe)) throw invalid('Provider request has not resolved its frozen tool definitions.');
  return inlineTools(request.recipe);
}

function inlineTools(recipeValue: unknown): readonly ReliableAgentToolDefinition[] {
  const recipe = record(recipeValue, 'Frozen recipe');
  // Legacy summary recipes have no tools; keep that published reader behavior.
  if (recipe.tools === undefined) return [];
  if (!Array.isArray(recipe.tools)) throw invalid('Frozen recipe.tools must be an array.');
  return recipe.tools as unknown as readonly ReliableAgentToolDefinition[];
}
async function assertCachedOwner(database: RuntimeDatabase, metadata: ContentObjectMetadata): Promise<void> {
  // Custom/test database adapters predating the no-SQL fence retain their validated read path.
  const validate = (database as Partial<RuntimeDatabase>).assertUsableBinding;
  if (typeof validate === 'function') await validate.call(database);
  else await registeredMetadata(database, metadata.id, metadata);
}

async function registeredMetadata(database: RuntimeDatabase, id: string, expected?: ContentObjectMetadata): Promise<ContentObjectMetadata> {
  const row = (await database.snapshot([DOMAIN_REPOSITORIES.domain('ContentObject').get(id)])).snapshot[0];
  if (!row || Array.isArray(row) || row.id !== id || row.content_type !== FROZEN_TOOL_DEFINITIONS_CONTENT_TYPE
    || typeof row.byte_length !== 'bigint' || row.byte_length < 0n) {
    throw invalid('Frozen tool definitions have no correctly typed registered CAS body.');
  }
  const metadata = row as ContentObjectMetadata;
  if (expected) assertMetadata(metadata, expected);
  return metadata;
}
function assertMetadata(actual: ContentObjectMetadata, expected: ContentObjectMetadata): void {
  for (const key of ['content_type', 'sha256', 'byte_length', 'storage_key'] as const) {
    if (actual[key] !== expected[key]) throw invalid('Frozen tool definitions CAS metadata changed.');
  }
}
function remember(cache: StoreCache, metadata: ContentObjectMetadata, tools: readonly ReliableAgentToolDefinition[]): void {
  // Compression/retry reuses the original registered identity, without hashing resolved bodies again.
  cache.writes.set(tools, Promise.resolve(metadata));
  const charge = 512 + metadata.id.length * 2 + Number(metadata.byte_length) * 8;
  const old = cache.entries.get(metadata.id);
  if (old) { cache.entries.delete(metadata.id); cache.bytes -= old.charge; }
  if (!Number.isSafeInteger(charge) || charge > FROZEN_TOOL_DEFINITIONS_CACHE_LIMITS.bytes) return;
  cache.entries.set(metadata.id, { metadata: { ...metadata }, tools, charge }); cache.bytes += charge;
  while (cache.entries.size > FROZEN_TOOL_DEFINITIONS_CACHE_LIMITS.entries || cache.bytes > FROZEN_TOOL_DEFINITIONS_CACHE_LIMITS.bytes) {
    const id = cache.entries.keys().next().value!;
    cache.bytes -= cache.entries.get(id)!.charge; cache.entries.delete(id);
  }
}
function freezeDeep(value: PlainJsonValue): void {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function invalid(message: string): Error { return Object.assign(new Error(message), { code: 'MODEL_FROZEN_TOOL_DEFINITIONS_INVALID' }); }
