import type { ContentAddressedStore, ContentObjectMetadata } from './contentAddressedStore';
import { CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION, handleKindOfRef, isPersistentContextHandle,
  normalizeModelHandleCatalog, prepareModelHandleCatalog, type ModelHandleCatalog,
  type ModelHandleEntry, type PreparedModelHandleCatalog } from './modelHandleCatalog';
import { DOMAIN_REPOSITORIES } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';

export const CONTEXT_HANDLE_STATE_CONTENT_TYPE = 'application/vnd.limcode.conversation-context-handle-state+json';
export const FROZEN_MODEL_HANDLE_BASE_CACHE_LIMITS = Object.freeze({ entries: 8, bytes: 8 * 1024 * 1024 });

/** Only request-local facts are embedded; the base is an immutable CAS identity, never a pointer. */
export interface FrozenModelHandleCatalogReference {
  baseContentObjectId: string | null;
  attachmentEntries: ModelHandleEntry[];
  addedEntries: ModelHandleEntry[];
  metadataExtensions: ModelHandleEntry[];
}

interface BaseEntry {
  metadata: ContentObjectMetadata;
  conversationId: string;
  catalog: PreparedModelHandleCatalog;
  bytes: number;
}
interface BaseCache { entries: Map<string, BaseEntry>; bytes: number }
const bases = new WeakMap<RuntimeDatabase, WeakMap<ContentAddressedStore, BaseCache>>();
const emptyBase = prepareModelHandleCatalog({ entries: [], retiredRefs: [],
  identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION });

function cacheFor(database: RuntimeDatabase, store: ContentAddressedStore): BaseCache {
  let stores = bases.get(database);
  if (!stores) { stores = new WeakMap(); bases.set(database, stores); }
  let cache = stores.get(store);
  if (!cache) { cache = { entries: new Map(), bytes: 0 }; stores.set(store, cache); }
  return cache;
}

/** Charged from already-known immutable byte_length; never walk/stringify/hash a warm catalog. */
export function rememberFrozenContextHandleCatalogBase(database: RuntimeDatabase, store: ContentAddressedStore,
  metadata: ContentObjectMetadata, conversationId: string, catalog: ModelHandleCatalog): PreparedModelHandleCatalog {
  const prepared = prepareModelHandleCatalog(catalog);
  const bytes = 512 + metadata.id.length * 2 + conversationId.length * 2 + Number(metadata.byte_length) * 8;
  const cache = cacheFor(database, store);
  const old = cache.entries.get(metadata.id);
  if (old) { cache.entries.delete(metadata.id); cache.bytes -= old.bytes; }
  if (!Number.isSafeInteger(bytes) || bytes > FROZEN_MODEL_HANDLE_BASE_CACHE_LIMITS.bytes) return prepared;
  cache.entries.set(metadata.id, { metadata: { ...metadata }, conversationId, catalog: prepared, bytes });
  cache.bytes += bytes;
  while (cache.entries.size > FROZEN_MODEL_HANDLE_BASE_CACHE_LIMITS.entries
    || cache.bytes > FROZEN_MODEL_HANDLE_BASE_CACHE_LIMITS.bytes) {
    const oldest = cache.entries.keys().next().value!;
    cache.bytes -= cache.entries.get(oldest)!.bytes; cache.entries.delete(oldest);
  }
  return prepared;
}

/**
 * ContentObject registrations and CAS bytes are retained until explicit dataset reset. Conversation
 * deletion removes neither; online/streamed merge and whole-dataset copy transfer every registered
 * ContentObject, including this base after its producer is deleted. A future reachability GC MUST
 * follow recipe.modelHandleCatalogReference.baseContentObjectId as a strong CAS edge before it may
 * collect bases. No current Conversation/ContextRoot row is required to replay a copied recipe.
 */
export async function readFrozenContextHandleCatalogBase(database: RuntimeDatabase, store: ContentAddressedStore,
  contentObjectId: string | null, conversationId: string): Promise<PreparedModelHandleCatalog> {
  if (contentObjectId === null) return emptyBase;
  // This read also fences the live database/root and verifies registration on cache hits.
  const metadata = (await database.snapshot([DOMAIN_REPOSITORIES.domain('ContentObject').get(contentObjectId)])).snapshot[0];
  if (!metadata || Array.isArray(metadata) || metadata.id !== contentObjectId
    || metadata.content_type !== CONTEXT_HANDLE_STATE_CONTENT_TYPE
    || typeof metadata.byte_length !== 'bigint' || metadata.byte_length < 0n) {
    throw invalid('Frozen Context catalog has no correctly typed registered CAS base.');
  }
  const cache = cacheFor(database, store);
  const cached = cache.entries.get(contentObjectId);
  if (cached) {
    if (cached.conversationId !== conversationId) throw invalid('Frozen catalog belongs to another producer Conversation.');
    for (const field of ['content_type', 'sha256', 'byte_length', 'storage_key'] as const) {
      if (cached.metadata[field] !== metadata[field]) throw invalid('Frozen catalog CAS metadata changed.');
    }
    cache.entries.delete(contentObjectId); cache.entries.set(contentObjectId, cached);
    return cached.catalog;
  }
  const value = record(JSON.parse((await store.read(metadata as ContentObjectMetadata)).toString('utf8')), 'Frozen Context catalog');
  if (value.kind !== 'conversation-context-handle-state' || value.conversationId !== conversationId
    || Object.keys(value).some(key => !['kind', 'conversationId', 'catalog'].includes(key))) {
    throw invalid('Frozen Context catalog has invalid ownership or shape.');
  }
  const catalog = normalizeModelHandleCatalog(value.catalog);
  if (catalog.identityContractRevision !== CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION
    || catalog.entries.some(entry => !isPersistentContextHandle(entry.kind))) {
    throw invalid('Frozen Context catalog requires current persistent identities.');
  }
  return rememberFrozenContextHandleCatalogBase(database, store, metadata as ContentObjectMetadata, conversationId, catalog);
}

/** Published inline recipes retain their original bytes; no replay substitutes the current state. */
export async function resolveFrozenModelHandleCatalog(database: RuntimeDatabase, store: ContentAddressedStore,
  recipeValue: unknown): Promise<ModelHandleCatalog> {
  const recipe = record(recipeValue, 'Frozen recipe');
  if (!('modelHandleCatalogReference' in recipe)) return normalizeModelHandleCatalog(recipe.modelHandleCatalog);
  const reference = readReference(recipe);
  const scope = record(recipe.contextHandleScope, 'Frozen Context handle scope');
  if (typeof scope.conversationId !== 'string' || !scope.conversationId
    || !(scope.rootId === null || typeof scope.rootId === 'string' && scope.rootId.length > 0)
    || typeof scope.provenanceRevision !== 'string' || !/^(0|[1-9]\d*)$/.test(scope.provenanceRevision)
    || typeof scope.resetFence !== 'string' || !/^(0|[1-9]\d*)$/.test(scope.resetFence)) {
    throw invalid('Frozen catalog reference requires its exact producer scope.');
  }
  const base = await readFrozenContextHandleCatalogBase(database, store, reference.baseContentObjectId, scope.conversationId);
  const byRef = new Map(base.entries.map(entry => [entry.ref, entry]));
  const floors = { ...base.allocationHighWater };
  for (const entry of base.entries) floors[entry.kind] = Math.max(floors[entry.kind] ?? 0, Number(entry.ref.slice(1)));
  for (const ref of base.retiredRefs ?? []) {
    // Every retired ordinal participates in allocation even when it has no active target.
    const kind = handleKindOfRef(ref)!;
    floors[kind] = Math.max(floors[kind] ?? 0, Number(ref.slice(1)));
  }
  for (const entry of reference.addedEntries) {
    const ordinal = Number(entry.ref.slice(1));
    if (ordinal !== (floors[entry.kind] ?? 0) + 1) throw invalid('Frozen catalog addition does not follow the reserved allocation frontier.');
    floors[entry.kind] = ordinal;
  }
  const replacements = new Map<string, ModelHandleEntry>();
  for (const entry of reference.metadataExtensions) {
    const previous = byRef.get(entry.ref);
    if (!previous || previous.kind !== entry.kind || previous.target !== entry.target) {
      throw invalid('Frozen catalog metadata extension must identify an existing base entry.');
    }
    for (const key of ['name', 'mimeType', 'sizeBytes'] as const) {
      if (previous[key] !== undefined && previous[key] !== entry[key]) {
        throw invalid('Frozen catalog metadata extension cannot replace established metadata.');
      }
    }
    replacements.set(entry.ref, entry);
  }
  return normalizeModelHandleCatalog({ ...base, entries: [
    // Match builder seed ordering: attachments precede the persistent base and local additions.
    ...reference.attachmentEntries,
    ...base.entries.map(entry => replacements.get(entry.ref) ?? entry),
    ...reference.addedEntries
  ] });
}

/** Synchronous projection consumes a resolved catalog, or an unchanged published inline recipe. */
export function providerRequestModelHandleCatalog(request: { recipe: unknown; resolvedModelHandleCatalog?: ModelHandleCatalog }): ModelHandleCatalog {
  if (request.resolvedModelHandleCatalog !== undefined) return request.resolvedModelHandleCatalog;
  const recipe = record(request.recipe, 'Provider recipe');
  if ('modelHandleCatalogReference' in recipe) throw invalid('Provider request has not resolved its frozen catalog reference.');
  return normalizeModelHandleCatalog(recipe.modelHandleCatalog);
}

/** Attachment-only historical reminders need no cumulative persistent base or current registry. */
export function frozenRecipeAttachmentHandles(recipeValue: unknown): ModelHandleCatalog {
  const recipe = record(recipeValue, 'Frozen recipe');
  if (!('modelHandleCatalogReference' in recipe)) return normalizeModelHandleCatalog(recipe.modelHandleCatalog);
  return normalizeModelHandleCatalog({ entries: readReference(recipe).attachmentEntries });
}

function readReference(recipe: Record<string, unknown>): FrozenModelHandleCatalogReference {
  if (recipe.kind !== 'reliable-agent-turn' || 'modelHandleCatalog' in recipe) {
    throw invalid('Frozen catalog reference requires an ordinary recipe with no inline catalog.');
  }
  const reference = record(recipe.modelHandleCatalogReference, 'Frozen model handle catalog reference');
  if (Object.keys(reference).some(key => !['baseContentObjectId', 'attachmentEntries', 'addedEntries', 'metadataExtensions'].includes(key))
    || !(reference.baseContentObjectId === null || typeof reference.baseContentObjectId === 'string' && reference.baseContentObjectId.length > 0)) {
    throw invalid('Frozen catalog reference has an invalid base or shape.');
  }
  const entries = (key: string, attachment: boolean): ModelHandleEntry[] => {
    if (!Array.isArray(reference[key])) throw invalid(`Frozen catalog reference requires ${key}.`);
    const catalog = normalizeModelHandleCatalog({ entries: reference[key] });
    if (catalog.entries.some(entry => (entry.kind === 'attachment') !== attachment)) {
      throw invalid(`Frozen catalog ${key} has an invalid handle kind.`);
    }
    return catalog.entries;
  };
  return { baseContentObjectId: reference.baseContentObjectId as string | null,
    attachmentEntries: entries('attachmentEntries', true), addedEntries: entries('addedEntries', false),
    metadataExtensions: entries('metadataExtensions', false) };
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}
function invalid(message: string): Error { return Object.assign(new Error(message), { code: 'MODEL_CONTEXT_HANDLE_STATE_INVALID' }); }
