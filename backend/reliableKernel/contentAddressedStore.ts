import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { RootBinding } from './contracts';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryInsertMutation
} from './repositories';
import { RootAuthority, RootAuthorityError, sameBindingIdentity } from './rootAuthority';
import { isExecutionHandoffError } from './executionLeaseFence';
import { RuntimeDatabase } from './runtimeDatabase';
import { storageKeyForDigest } from './casObjectAccess';
import { LooseCasStoreAccess, type CasStoreAccess, type CasPublicationLocation } from './runtimeCasAccess';

export { storageKeyForDigest } from './casObjectAccess';

export interface PublishedContent {
  contentType: string;
  sha256: string;
  byteLength: bigint;
  storageKey: string;
  /** Present only when publication resolved to an independent immutable loose file. */
  absolutePath?: string;
  location?: CasPublicationLocation;
}

export interface ContentObjectMetadata extends DomainRow {
  id: string;
  content_type: string;
  sha256: string;
  byte_length: bigint;
  storage_key: string;
  created_at: string;
}

export interface ContentObjectIdentity {
  id: string;
  content_type: string;
  sha256: string;
  byte_length: bigint;
  storage_key: string;
}

export interface PreparedContentObject {
  metadata: ContentObjectMetadata;
  insert?: RepositoryInsertMutation;
}

export type ContentAddressedStoreMetric =
  | 'lookup-hit'
  | 'lookup-miss'
  | 'publish'
  | 'temp-write'
  | 'file-fsync'
  | 'directory-fsync';

export interface ContentAddressedStoreMetricEvent {
  metric: ContentAddressedStoreMetric;
  count: number;
}

/** Optional development-only observer. Events contain counts only, never content or paths. */
export type ContentAddressedStoreMetricObserver = (event: ContentAddressedStoreMetricEvent) => void;

/** Opaque, immutable identity; the copied publication bytes stay private to this module. */
export interface IdentifiedContent {
  readonly identity: Readonly<ContentObjectIdentity>;
}

interface IdentifiedContentBytes {
  bytes: Buffer;
  published: PublishedContent;
  id: string;
}

const identifiedContentBytes = new WeakMap<IdentifiedContent, IdentifiedContentBytes>();

interface VerifiedContentReadCacheEntry {
  id: string;
  sha256: string;
  byteLength: bigint;
  storageKey: string;
  bytes: Buffer;
}

interface VerifiedContentReadFlight {
  identity: Omit<VerifiedContentReadCacheEntry, 'bytes'>;
  promise: Promise<Buffer>;
}

export interface ContentAddressedStoreReadCacheInspection {
  entries: number;
  bytes: number;
  inflight: number;
  hits: number;
  misses: number;
  evictions: number;
  maxEntries: number;
  maxBytes: number;
}

const VERIFIED_READ_CACHE_MAX_ENTRIES = 128;
const VERIFIED_READ_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const VERIFIED_READ_CACHE_MAX_SINGLE_BYTES = 64 * 1024 * 1024;

export class ContentAddressedStore {
  public inspectRangeReadCache(): ReturnType<CasStoreAccess['inspectRanges']> {
    return this.byteAccess.inspectRanges();
  }

  /** Only fully length/digest-verified immutable bytes enter this cache. Callers receive copies. */
  private readonly verifiedReadCache = new Map<string, VerifiedContentReadCacheEntry>();
  private readonly verifiedReadFlights = new Map<string, VerifiedContentReadFlight>();
  private verifiedReadCacheBytes = 0;
  private verifiedReadCacheHits = 0;
  private verifiedReadCacheMisses = 0;
  private verifiedReadCacheEvictions = 0;

  private constructor(
    private readonly authority: RootAuthority,
    public readonly binding: RootBinding,
    private readonly byteAccess: CasStoreAccess,
    private readonly observeMetric?: ContentAddressedStoreMetricObserver
  ) {
    if (!byteAccess) throw new TypeError('ContentAddressedStore must borrow RuntimeDatabase access, or explicitly select the loose fixture adapter.');
  }

  public static forDatabase(authority: RootAuthority, database: RuntimeDatabase,
    observeMetric?: ContentAddressedStoreMetricObserver): ContentAddressedStore {
    return new ContentAddressedStore(authority, database.binding, database.casAccess, observeMetric);
  }

  /** Explicit loose-format fixture adapter. Production stores borrow the Runtime-owned access. */
  public static loose(authority: RootAuthority, binding: RootBinding,
    observeMetric?: ContentAddressedStoreMetricObserver): ContentAddressedStore {
    return new ContentAddressedStore(authority, binding, new LooseCasStoreAccess(binding.paths.casRootPath), observeMetric);
  }

  public identity(content: Uint8Array | string, contentType: string): ContentObjectIdentity {
    return identifiedContentIdentity(identifyContent(content, contentType));
  }

  /** Copies and identifies once, before any await; callers can share this result across identities. */
  public identify(content: Uint8Array | string, contentType: string): IdentifiedContent {
    const identified = identifyContent(content, contentType);
    const handle = Object.freeze({ identity: Object.freeze(identifiedContentIdentity(identified)) });
    identifiedContentBytes.set(handle, identified);
    return handle;
  }

  public async publish(content: Uint8Array | string, contentType: string): Promise<PublishedContent> {
    return await this.publishIdentified(identifyContent(content, contentType));
  }

  private async publishIdentified(
    content: IdentifiedContentBytes,
  ): Promise<PublishedContent> {
    const published = await this.publishIdentifiedBatch([content]);
    if (!published[0]) throw new Error('CAS publication lost its input.');
    return published[0];
  }

  private async publishIdentifiedBatch(contents: readonly IdentifiedContentBytes[], metrics?: {
    tempWrites: number; fileFsyncs: number; directoryFsyncs: number;
  }): Promise<PublishedContent[]> {
    if (contents.length === 0) return [];
    this.byteAccess.assertUsable();
    await this.authority.validate(this.binding);
    this.recordMetric('publish', contents.length);
    const locations = await this.byteAccess.publishBatch(contents.map(({ bytes, published }) => ({ bytes, object: {
      sha256: published.sha256, byte_length: published.byteLength, storage_key: published.storageKey
    } })), (metric) => {
      this.recordMetric(metric);
      if (metrics) {
        if (metric === 'directory-fsync') metrics.directoryFsyncs += 1;
        else if (metric === 'file-fsync') metrics.fileFsyncs += 1;
        else metrics.tempWrites += 1;
      }
    });
    this.byteAccess.assertUsable();
    await this.authority.validate(this.binding);
    return contents.map(({ published }, index) => {
      const location = locations[index];
      return { ...published, location, ...(location.kind === 'loose' ? { absolutePath: location.absolutePath } : {}) };
    });
  }

  /**
   * Looks up committed metadata first, then publishes only a miss before preparing the uncommitted
   * ContentObject mutation. A domain command can still commit its receipt, reference and transition
   * atomically after the CAS bytes are durable.
   */
  public async prepare(
    database: RuntimeDatabase,
    content: Uint8Array | string,
    contentType: string
  ): Promise<PreparedContentObject> {
    const prepared = await this.prepareContent(database, () => [identifyContent(content, contentType)], 'prepare');
    if (!prepared[0]) throw new Error('CAS single prepare lost its input.');
    return prepared[0];
  }

  public async prepareBatch(
    database: RuntimeDatabase,
    inputs: ReadonlyArray<{ content: Uint8Array | string; contentType: string }>
  ): Promise<PreparedContentObject[]> {
    return this.prepareContent(database, () => inputs.map(input => identifyContent(input.content, input.contentType)), 'prepare_batch');
  }

  public async prepareIdentified(database: RuntimeDatabase, content: IdentifiedContent): Promise<PreparedContentObject> {
    const prepared = await this.prepareContent(database, () => [requireIdentifiedContentBytes(content)], 'prepare');
    if (!prepared[0]) throw new Error('CAS single prepare lost its input.');
    return prepared[0];
  }

  public async prepareIdentifiedBatch(database: RuntimeDatabase, contents: readonly IdentifiedContent[]): Promise<PreparedContentObject[]> {
    return this.prepareContent(database, () => contents.map(requireIdentifiedContentBytes), 'prepare_batch');
  }

  private async prepareContent(
    database: RuntimeDatabase,
    identify: () => readonly IdentifiedContentBytes[],
    operation: 'prepare' | 'prepare_batch'
  ): Promise<PreparedContentObject[]> {
    this.byteAccess.assertUsable();
    const startedAtMs = database.performanceMetrics ? performance.now() : undefined;
    if (!sameBindingIdentity(database.binding, this.binding)) {
      throw new Error('CAS and RuntimeDatabase must use the same RootBinding.');
    }
    const identified = identify();
    if (identified.length === 0) return [];
    const unique = [...new Map(identified.map((entry) => [entry.id, entry])).values()];
    const repository = DOMAIN_REPOSITORIES.domain('ContentObject');
    // One snapshot is one worker request even when it carries several unique identity lookups.
    const existing = await database.snapshot(unique.map((entry) =>
      repository.list({ where: contentObjectIdentity(entry.published), limit: 1 })
    ));
    if (existing.snapshot.length !== unique.length) {
      throw new Error('ContentObject batch lookup returned the wrong result count.');
    }

    const preparedById = new Map<string, PreparedContentObject>();
    const missing: IdentifiedContentBytes[] = [];
    let lookupHits = 0;
    unique.forEach((entry, index) => {
      const rows = existing.snapshot[index];
      if (!Array.isArray(rows)) throw new TypeError('ContentObject batch lookup did not return rows.');
      const row = rows[0];
      const id = entry.id;
      if (row) {
        lookupHits += 1;
        preparedById.set(id, { metadata: requireMatchingContentObject(row, entry) });
      } else {
        missing.push(entry);
      }
    });
    this.recordMetric('lookup-hit', lookupHits);
    this.recordMetric('lookup-miss', missing.length);

    const publicationMetrics = { tempWrites: 0, fileFsyncs: 0, directoryFsyncs: 0 };
    const publishedMisses = await this.publishIdentifiedBatch(missing, publicationMetrics);
    for (let index = 0; index < publishedMisses.length; index += 1) {
      const metadata = contentObjectMetadata(publishedMisses[index], missing[index].id);
      preparedById.set(metadata.id, { metadata, insert: repository.insert(metadata) });
    }
    if (startedAtMs !== undefined) {
      // Lookup plus durable publish of every miss, i.e. what a command waits for before its commit.
      database.recordPerformanceMetric({
        kind: 'cas.prepare',
        operation,
        lookupHits,
        lookupMisses: missing.length,
        publishes: missing.length,
        ...publicationMetrics,
        durationMs: performance.now() - startedAtMs
      });
    }

    return identified.map((entry) => {
      const prepared = preparedById.get(entry.id);
      if (!prepared) throw new Error('ContentObject batch prepare lost an identified input.');
      return prepared;
    });
  }

  /** CAS publish completes before the ContentObject Repository transaction starts. */
  public async ingest(
    database: RuntimeDatabase,
    content: Uint8Array | string,
    contentType: string
  ): Promise<ContentObjectMetadata> {
    const prepared = await this.prepare(database, content, contentType);
    if (!prepared.insert) return prepared.metadata;
    try {
      await database.transaction([prepared.insert]);
      return prepared.metadata;
    } catch (error) {
      const repository = DOMAIN_REPOSITORIES.domain('ContentObject');
      const raced = await database.snapshot([repository.list({
        where: contentObjectIdentityFromMetadata(prepared.metadata),
        limit: 1
      })]);
      const racedRow = (raced.snapshot[0] as DomainRow[])[0];
      if (racedRow) return asContentObjectMetadata(racedRow);
      throw error;
    }
  }

  public async read(metadata: ContentObjectMetadata): Promise<Buffer> {
    this.byteAccess.assertUsable();
    await this.authority.validate(this.binding);
    const bytes = await this.readVerifiedObject(metadata);
    this.byteAccess.assertUsable();
    return Buffer.from(bytes);
  }

  /** Fenced on-demand chunk read; callers still enforce their wire response budget. */
  public async readChunk(
    metadata: ContentObjectMetadata,
    offset: number,
    maxBytes: number
  ): Promise<{ chunk: Buffer; nextOffset?: number; totalBytes: number; hasMore: boolean }> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('CAS chunk offset must be a non-negative integer.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('CAS chunk maxBytes must be a positive integer.');
    this.byteAccess.assertUsable();
    await this.authority.validate(this.binding);
    const expectedKey = storageKeyForDigest(metadata.sha256);
    if (metadata.storage_key !== expectedKey) throw new Error('ContentObject storage key does not match sha256.');
    const totalBytes = Number(metadata.byte_length);
    if (!Number.isSafeInteger(totalBytes)) throw new RangeError('CAS object is too large for chunk addressing.');
    if (offset > totalBytes) throw new RangeError('CAS chunk offset exceeds object length.');
    const length = Math.min(maxBytes, totalBytes - offset);
    // Stream-verify once per unchanged file identity, then read only the requested range. This
    // remains bounded for oversized objects and interleaved readers that exceed the byte cache.
    const chunk = await this.byteAccess.readRange(metadata, offset, length);
    this.byteAccess.assertUsable();
    await this.authority.validate(this.binding);
    const nextOffset = offset + length;
    const hasMore = nextOffset < totalBytes;
    return {
      chunk,
      ...(hasMore ? { nextOffset } : {}),
      totalBytes,
      hasMore
    };
  }

  /** One fenced async operation; duplicate ContentObjects are read and verified once, then fanned out. */
  public async readMany(metadata: readonly ContentObjectMetadata[]): Promise<Buffer[]> {
    this.byteAccess.assertUsable();
    await this.authority.validate(this.binding);
    const unique = [...new Map(metadata.map((entry) => [entry.id, entry])).values()];
    const contents = new Map<string, Buffer>();
    const concurrency = Math.min(32, Math.max(1, unique.length));
    let nextIndex = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= unique.length) return;
        const entry = unique[index];
        contents.set(entry.id, await this.readVerifiedObject(entry));
      }
    }));
    this.byteAccess.assertUsable();
    return metadata.map((entry) => {
      const bytes = contents.get(entry.id);
      if (!bytes) throw new Error(`CAS batch read lost ContentObject ${entry.id}.`);
      return Buffer.from(bytes);
    });
  }

  /**
   * Optional derived-data lookup only. Unavailable/corrupt immutable objects cannot prove a fact;
   * required recipe reads continue to use read/readMany and retain their fail-closed behavior.
   * Root fences are mandatory and deliberately outside the per-object failure boundary.
   */
  public async readOptionalMany(metadata: readonly ContentObjectMetadata[]): Promise<Array<Buffer | undefined>> {
    this.byteAccess.assertUsable();
    await this.authority.validate(this.binding);
    const unique = [...new Map(metadata.map(entry => [entry.id, entry])).values()];
    const contents = new Map<string, Buffer | undefined>();
    let nextIndex = 0;
    await Promise.all(Array.from({ length: Math.min(32, Math.max(1, unique.length)) }, async () => {
      for (;;) {
        const index = nextIndex++;
        if (index >= unique.length) return;
        const entry = unique[index];
        let bytes: Buffer;
        try {
          // This method performs only immutable CAS object/cache identity and byte verification.
          // Keep control-plane failures distinct even if a future reader propagates one here.
          bytes = await this.readVerifiedObject(entry);
        } catch (error) {
          if (error instanceof RootAuthorityError || isExecutionHandoffError(error)
            || (error && typeof error === 'object' && 'name' in error && error.name === 'AbortError')) throw error;
          contents.set(entry.id, undefined);
          continue;
        }
        contents.set(entry.id, bytes);
      }
    }));
    this.byteAccess.assertUsable();
    await this.authority.validate(this.binding);
    return metadata.map(entry => {
      const bytes = contents.get(entry.id);
      return bytes === undefined ? undefined : Buffer.from(bytes);
    });
  }

  /** Metadata-only diagnostics used by focused tests and development inspection. */
  public inspectReadCache(): ContentAddressedStoreReadCacheInspection {
    return {
      entries: this.verifiedReadCache.size,
      bytes: this.verifiedReadCacheBytes,
      inflight: this.verifiedReadFlights.size,
      hits: this.verifiedReadCacheHits,
      misses: this.verifiedReadCacheMisses,
      evictions: this.verifiedReadCacheEvictions,
      maxEntries: VERIFIED_READ_CACHE_MAX_ENTRIES,
      maxBytes: VERIFIED_READ_CACHE_MAX_BYTES
    };
  }

  private async readVerifiedObject(metadata: ContentObjectMetadata): Promise<Buffer> {
    const cached = this.verifiedReadCache.get(metadata.id);
    if (cached) {
      assertSameVerifiedContentIdentity(cached, metadata);
      this.verifiedReadCache.delete(metadata.id);
      this.verifiedReadCache.set(metadata.id, cached);
      this.verifiedReadCacheHits += 1;
      return cached.bytes;
    }
    const active = this.verifiedReadFlights.get(metadata.id);
    if (active) {
      assertSameVerifiedContentIdentity(active.identity, metadata);
      this.verifiedReadCacheHits += 1;
      return active.promise;
    }

    this.verifiedReadCacheMisses += 1;
    const identity = verifiedContentIdentity(metadata);
    const promise = this.byteAccess.readBytes(metadata)
      .then((bytes) => {
        this.rememberVerifiedRead({ ...identity, bytes });
        return bytes;
      })
      .finally(() => {
        if (this.verifiedReadFlights.get(metadata.id)?.promise === promise) {
          this.verifiedReadFlights.delete(metadata.id);
        }
      });
    this.verifiedReadFlights.set(metadata.id, { identity, promise });
    return promise;
  }

  private rememberVerifiedRead(entry: VerifiedContentReadCacheEntry): void {
    if (entry.bytes.byteLength > VERIFIED_READ_CACHE_MAX_SINGLE_BYTES) return;
    const existing = this.verifiedReadCache.get(entry.id);
    if (existing) {
      assertSameVerifiedContentIdentity(existing, entry);
      this.verifiedReadCacheBytes -= existing.bytes.byteLength;
      this.verifiedReadCache.delete(entry.id);
    }
    this.verifiedReadCache.set(entry.id, entry);
    this.verifiedReadCacheBytes += entry.bytes.byteLength;
    while (
      this.verifiedReadCache.size > VERIFIED_READ_CACHE_MAX_ENTRIES
      || this.verifiedReadCacheBytes > VERIFIED_READ_CACHE_MAX_BYTES
    ) {
      // Retain one newly verified oversized object so its continuation pages do not regress to an
      // O(page-count * object-size) read/hash loop. The next different object can evict it.
      if (this.verifiedReadCache.size <= 1) break;
      const oldestId = this.verifiedReadCache.keys().next().value as string | undefined;
      if (!oldestId) break;
      const oldest = this.verifiedReadCache.get(oldestId);
      this.verifiedReadCache.delete(oldestId);
      if (oldest) this.verifiedReadCacheBytes -= oldest.bytes.byteLength;
      this.verifiedReadCacheEvictions += 1;
    }
  }

  private recordMetric(metric: ContentAddressedStoreMetric, count = 1): void {
    if (!this.observeMetric || count === 0) return;
    try {
      this.observeMetric({ metric, count });
    } catch {
      // Development metrics must never alter CAS correctness or availability.
    }
  }
}

function contentObjectId(content: PublishedContent): string {
  const digest = createHash('sha256')
    .update('limcode-content-object\0')
    .update(content.contentType)
    .update('\0')
    .update(content.sha256)
    .update('\0')
    .update(content.byteLength.toString())
    .digest('hex');
  return `content_${digest}`;
}

function contentObjectIdentity(content: PublishedContent): DomainRow {
  return {
    content_type: content.contentType,
    sha256: content.sha256,
    byte_length: content.byteLength
  };
}

function contentObjectIdentityFromMetadata(metadata: ContentObjectMetadata): DomainRow {
  return {
    content_type: metadata.content_type,
    sha256: metadata.sha256,
    byte_length: metadata.byte_length
  };
}

function contentObjectMetadata(content: PublishedContent, id: string): ContentObjectMetadata {
  return {
    id,
    content_type: content.contentType,
    sha256: content.sha256,
    byte_length: content.byteLength,
    storage_key: content.storageKey,
    created_at: new Date().toISOString()
  };
}

function identifyContent(
  content: Uint8Array | string,
  contentType: string
): IdentifiedContentBytes {
  const normalizedType = requireContentType(contentType);
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const storageKey = storageKeyForDigest(sha256);
  const published: PublishedContent = {
    contentType: normalizedType,
    sha256,
    byteLength: BigInt(bytes.length),
    storageKey
  };
  return { bytes, published, id: contentObjectId(published) };
}

function identifiedContentIdentity(content: IdentifiedContentBytes): ContentObjectIdentity {
  return { id: content.id, content_type: content.published.contentType, sha256: content.published.sha256,
    byte_length: content.published.byteLength, storage_key: content.published.storageKey };
}

function requireIdentifiedContentBytes(content: IdentifiedContent): IdentifiedContentBytes {
  const identified = identifiedContentBytes.get(content);
  if (!identified) throw new TypeError('CAS preparation requires a contentStore.identify result.');
  return identified;
}

function requireMatchingContentObject(row: DomainRow, expected: IdentifiedContentBytes): ContentObjectMetadata {
  const metadata = asContentObjectMetadata(row);
  if (
    metadata.id !== expected.id
    || metadata.content_type !== expected.published.contentType
    || metadata.sha256 !== expected.published.sha256
    || metadata.byte_length !== expected.published.byteLength
    || metadata.storage_key !== expected.published.storageKey
  ) {
    throw new Error('Existing ContentObject does not match the requested content identity.');
  }
  return metadata;
}

function verifiedContentIdentity(
  metadata: ContentObjectMetadata
): Omit<VerifiedContentReadCacheEntry, 'bytes'> {
  return {
    id: metadata.id,
    sha256: metadata.sha256,
    byteLength: metadata.byte_length,
    storageKey: metadata.storage_key
  };
}

function assertSameVerifiedContentIdentity(
  cached: Omit<VerifiedContentReadCacheEntry, 'bytes'>,
  metadata: ContentObjectMetadata | Omit<VerifiedContentReadCacheEntry, 'bytes'>
): void {
  const byteLength = 'byte_length' in metadata ? metadata.byte_length : metadata.byteLength;
  const storageKey = 'storage_key' in metadata ? metadata.storage_key : metadata.storageKey;
  if (
    cached.id !== metadata.id
    || cached.sha256 !== metadata.sha256
    || cached.byteLength !== byteLength
    || cached.storageKey !== storageKey
  ) {
    throw new Error(`Verified CAS cache identity mismatch for ContentObject ${metadata.id}.`);
  }
}

function asContentObjectMetadata(row: DomainRow): ContentObjectMetadata {
  return row as ContentObjectMetadata;
}

function requireContentType(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('CAS contentType must be non-empty.');
  return value.trim();
}
