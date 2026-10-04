import type { ContentObjectMetadata } from './contentAddressedStore';
import { CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION, isPersistentContextHandle, mergeModelHandleCatalogs,
  normalizeModelHandleCatalog, type ModelHandleCatalog, type ModelHandleEntry } from './modelHandleCatalog';
import type { PlainJsonValue } from './plainJson';

export interface FrozenContextHandleRecipe {
  kind?: 'reliable-agent-turn' | 'reliable-context-compression';
  catalog?: ModelHandleCatalog;
}
interface RecipeReference { kind?: FrozenContextHandleRecipe['kind']; catalogId?: number }
interface EntryFact { key: string; entry: ModelHandleEntry; owners: number; bytes: number }
interface CatalogFact { id: number; bucket: string; catalog: ModelHandleCatalog; bytes: number }

/** Short-lived read working sets, never persistent identity authority or complete recipe graphs. */
const immutableCatalogs = new WeakSet<ModelHandleCatalog>();
export function isImmutableContextHandleCatalog(catalog: ModelHandleCatalog): boolean {
  return immutableCatalogs.has(catalog);
}

const READ_MEMO_LIMITS = { entries: 256, bytes: 8 * 1024 * 1024 };
class BoundedReadMemo<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  public get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  public set(key: string, value: T): void {
    const bytes = key.length * 2 + 192;
    if (bytes > READ_MEMO_LIMITS.bytes) return;
    const prior = this.entries.get(key);
    if (prior) { this.entries.delete(key); this.bytes -= prior.bytes; }
    this.entries.set(key, { value, bytes }); this.bytes += bytes;
    while (this.entries.size > READ_MEMO_LIMITS.entries || this.bytes > READ_MEMO_LIMITS.bytes) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest);
    }
  }
}

/**
 * One fenced attempt owns this memo. Compare only consumed catalog fields against an already
 * validated catalog; do not rebuild historical recipe bodies or stringify/hash cumulative maps.
 * Catalog arrays share normalized entry facts. Capacity charges each shared entry once, so
 * interleaved cumulative catalogs do not evict one another merely by repeating the same entries.
 * Recipe/scope slots hold IDs, never unaccounted references to evicted catalogs or raw bodies.
 */
export class ContextHandleReadMemo {
  private readonly recipes = new BoundedReadMemo<RecipeReference>();
  private readonly scopes = new BoundedReadMemo<number>();
  private readonly catalogs = new Map<number, CatalogFact>();
  private readonly buckets = new Map<string, Set<number>>();
  private readonly entries = new Map<string, EntryFact>();
  private readonly entryFacts = new WeakMap<ModelHandleEntry, EntryFact>();
  private readonly persistentCatalogs = new WeakMap<ModelHandleCatalog, number>();
  private readonly catalogIds = new WeakMap<ModelHandleCatalog, number>();
  private nextCatalogId = 0;
  private bytes = 0;

  public recipe(metadata: ContentObjectMetadata): FrozenContextHandleRecipe | undefined {
    const reference = this.recipes.get(recipeIdentity(metadata));
    if (!reference) return undefined;
    if (reference.catalogId === undefined) return {};
    const catalog = this.getCatalog(reference.catalogId);
    return catalog ? { kind: reference.kind, catalog } : undefined;
  }
  public rememberRecipe(metadata: ContentObjectMetadata, value: FrozenContextHandleRecipe): void {
    const catalogId = value.catalog ? this.catalogIds.get(value.catalog) : undefined;
    if (value.catalog && (catalogId === undefined || !this.catalogs.has(catalogId))) return;
    this.recipes.set(recipeIdentity(metadata), { kind: value.kind, catalogId });
  }
  public catalog(value: PlainJsonValue | undefined): ModelHandleCatalog {
    const prior = this.findCatalog(value);
    if (prior) return prior;
    return this.rememberCatalog(normalizeModelHandleCatalog(value));
  }
  public persistent(catalog: ModelHandleCatalog): ModelHandleCatalog {
    const id = this.persistentCatalogs.get(catalog);
    const prior = id === undefined ? undefined : this.getCatalog(id);
    if (prior) return prior;
    const persistent = catalog.entries.every(entry => isPersistentContextHandle(entry.kind)) ? catalog
      : this.rememberCatalog({ ...catalog, entries: catalog.entries.filter(entry => isPersistentContextHandle(entry.kind)) });
    this.persistentCatalogs.set(catalog, this.id(persistent));
    return persistent;
  }
  public scope(catalogs: readonly ModelHandleCatalog[]): ModelHandleCatalog {
    const key = JSON.stringify(catalogs.map(catalog => this.id(catalog)));
    const id = this.scopes.get(key);
    const prior = id === undefined ? undefined : this.getCatalog(id);
    if (prior) return prior;
    const catalog = this.rememberCatalog(mergeModelHandleCatalogs(...catalogs));
    this.scopes.set(key, this.id(catalog));
    return catalog;
  }

  private id(catalog: ModelHandleCatalog): number {
    let id = this.catalogIds.get(catalog);
    if (id === undefined) { id = this.nextCatalogId++; this.catalogIds.set(catalog, id); }
    return id;
  }
  private getCatalog(id: number): ModelHandleCatalog | undefined {
    const fact = this.catalogs.get(id);
    if (!fact) return undefined;
    this.catalogs.delete(id); this.catalogs.set(id, fact);
    return fact.catalog;
  }
  private findCatalog(value: unknown): ModelHandleCatalog | undefined {
    const bucket = catalogBucket(value);
    if (bucket === undefined) return undefined;
    for (const id of this.buckets.get(bucket) ?? []) {
      const fact = this.catalogs.get(id)!;
      if (sameCatalogFields(value, fact.catalog)) return this.getCatalog(id);
    }
    return undefined;
  }
  private rememberCatalog(input: ModelHandleCatalog): ModelHandleCatalog {
    const prior = this.findCatalog(input);
    if (prior) return prior;
    const catalog: ModelHandleCatalog = { ...input, entries: input.entries.map(entry => this.acquireEntry(entry)),
      ...(input.allocationHighWater ? { allocationHighWater: { ...input.allocationHighWater } } : {}),
      ...(input.retiredRefs ? { retiredRefs: [...input.retiredRefs] } : {}) };
    Object.freeze(catalog.entries);
    if (catalog.retiredRefs) Object.freeze(catalog.retiredRefs);
    if (catalog.allocationHighWater) Object.freeze(catalog.allocationHighWater);
    Object.freeze(catalog); immutableCatalogs.add(catalog);
    const id = this.id(catalog);
    const bucket = catalogBucket(catalog)!;
    const bytes = 256 + catalog.entries.length * 8
      + (catalog.retiredRefs ?? []).reduce((sum, ref) => sum + 32 + ref.length * 2, 0);
    this.catalogs.set(id, { id, catalog, bucket, bytes }); this.bytes += bytes;
    let ids = this.buckets.get(bucket);
    if (!ids) this.buckets.set(bucket, ids = new Set());
    ids.add(id);
    while (this.catalogs.size > READ_MEMO_LIMITS.entries || this.bytes > READ_MEMO_LIMITS.bytes) {
      this.releaseCatalog(this.catalogs.values().next().value!);
    }
    return catalog;
  }
  private acquireEntry(entry: ModelHandleEntry): ModelHandleEntry {
    // Only a genuinely new catalog reaches this path. Ordinary repeated scopes compare fields
    // directly and allocate no full-catalog strings or per-entry keys.
    const key = JSON.stringify(entry);
    let fact = this.entries.get(key);
    if (!fact) {
      const shared = Object.freeze({ ...entry });
      const bytes = 192 + key.length * 2 + 2 * (entry.kind.length + entry.ref.length + entry.target.length
        + (entry.name?.length ?? 0) + (entry.mimeType?.length ?? 0));
      fact = { key, entry: shared, owners: 0, bytes };
      this.entries.set(key, fact); this.entryFacts.set(shared, fact); this.bytes += bytes;
    }
    fact.owners++;
    return fact.entry;
  }
  private releaseCatalog(fact: CatalogFact): void {
    this.catalogs.delete(fact.id); this.bytes -= fact.bytes;
    const ids = this.buckets.get(fact.bucket)!;
    ids.delete(fact.id); if (ids.size === 0) this.buckets.delete(fact.bucket);
    for (const entry of fact.catalog.entries) {
      const shared = this.entryFacts.get(entry)!;
      if (--shared.owners === 0) { this.entries.delete(shared.key); this.bytes -= shared.bytes; }
    }
  }
}

function recipeIdentity(metadata: ContentObjectMetadata): string {
  return JSON.stringify([metadata.id, metadata.content_type, metadata.sha256,
    String(metadata.byte_length), metadata.storage_key, metadata.created_at]);
}

/** A cheap candidate selector, never an equality or validity proof. */
function catalogBucket(value: unknown): string | undefined {
  if (value === undefined) return 'legacy/0/0';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const catalog = value as Record<string, unknown>;
  if (!Array.isArray(catalog.entries)) return undefined;
  if (!('identityContractRevision' in catalog)) {
    return 'retiredRefs' in catalog || 'allocationHighWater' in catalog ? undefined : `legacy/${catalog.entries.length}/0`;
  }
  return catalog.identityContractRevision === CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION
    && Array.isArray(catalog.retiredRefs) ? `current/${catalog.entries.length}/${catalog.retiredRefs.length}` : undefined;
}

/** Exact consumed-field comparison. Anything not already in normalized form takes validation;
 * matching a validated complete array also proves uniqueness, ordinals and retirement conflicts. */
function sameCatalogFields(value: unknown, catalog: ModelHandleCatalog): boolean {
  if (value === undefined) return catalog.identityContractRevision === undefined && catalog.entries.length === 0;
  const input = value as Record<string, unknown>;
  const floor = input.allocationHighWater;
  if (floor !== undefined && (!floor || typeof floor !== 'object' || Array.isArray(floor))) return false;
  const floorKeys = Object.keys(floor ?? {});
  const expectedFloor = catalog.allocationHighWater ?? {};
  if (floorKeys.length !== Object.keys(expectedFloor).length || floorKeys.some(key =>
    (floor as Record<string, unknown>)[key] !== (expectedFloor as Record<string, number>)[key])) return false;
  const entries = input.entries as unknown[];
  for (let index = 0; index < entries.length; index++) {
    const candidate = entries[index];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const entry = candidate as Record<string, unknown>;
    const prior = catalog.entries[index];
    if (entry.kind !== prior.kind || entry.ref !== prior.ref || entry.target !== prior.target
      || entry.name !== prior.name || entry.mimeType !== prior.mimeType || entry.sizeBytes !== prior.sizeBytes) return false;
  }
  const retired = input.retiredRefs as string[] | undefined;
  if (retired) for (let index = 0; index < retired.length; index++) {
    if (retired[index] !== catalog.retiredRefs![index]) return false;
  }
  return true;
}
