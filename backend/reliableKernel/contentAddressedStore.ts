import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RootBinding } from './contracts';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import { isPathBelow } from '../capabilities/filesystem/pathContainment';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryInsertMutation
} from './repositories';
import { RootAuthority, sameBindingIdentity } from './rootAuthority';
import { RuntimeDatabase } from './runtimeDatabase';

export interface PublishedContent {
  contentType: string;
  sha256: string;
  byteLength: bigint;
  storageKey: string;
  absolutePath: string;
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

interface IdentifiedContent {
  bytes: Buffer;
  published: PublishedContent;
}

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
  /** Only fully length/digest-verified immutable bytes enter this cache. Callers receive copies. */
  private readonly verifiedReadCache = new Map<string, VerifiedContentReadCacheEntry>();
  private readonly verifiedReadFlights = new Map<string, VerifiedContentReadFlight>();
  private verifiedReadCacheBytes = 0;
  private verifiedReadCacheHits = 0;
  private verifiedReadCacheMisses = 0;
  private verifiedReadCacheEvictions = 0;

  public constructor(
    private readonly authority: RootAuthority,
    public readonly binding: RootBinding,
    private readonly observeMetric?: ContentAddressedStoreMetricObserver
  ) {}

  public identity(content: Uint8Array | string, contentType: string): ContentObjectIdentity {
    const { published } = identifyContent(this.binding, content, contentType);
    return {
      id: contentObjectId(published),
      content_type: published.contentType,
      sha256: published.sha256,
      byte_length: published.byteLength,
      storage_key: published.storageKey
    };
  }

  public async publish(content: Uint8Array | string, contentType: string): Promise<PublishedContent> {
    return await this.publishIdentified(identifyContent(this.binding, content, contentType));
  }

  private async publishIdentified(content: IdentifiedContent): Promise<PublishedContent> {
    await this.authority.validate(this.binding);
    this.recordMetric('publish');
    const { bytes, published } = content;
    const { sha256, absolutePath } = published;
    const casRoot = this.binding.paths.casRootPath;
    const temporaryRoot = path.join(casRoot, 'tmp');
    const digestRoot = path.join(casRoot, 'sha256');
    const digestPrefix = path.dirname(absolutePath);
    const recordDirectoryFsync = () => this.recordMetric('directory-fsync');
    await ensureDurableChildDirectory(casRoot, temporaryRoot, recordDirectoryFsync);
    await ensureDurableChildDirectory(casRoot, digestRoot, recordDirectoryFsync);
    await ensureDurableChildDirectory(digestRoot, digestPrefix, recordDirectoryFsync);
    const temporaryPath = path.join(temporaryRoot, `${process.pid}-${randomUUID()}.tmp`);
    const handle = await fs.open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      this.recordMetric('temp-write');
      await handle.sync();
      this.recordMetric('file-fsync');
    } finally {
      await handle.close();
    }

    try {
      try {
        await fs.link(temporaryPath, absolutePath);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await assertExistingObject(absolutePath, sha256, BigInt(bytes.length));
      }
      // Both the publisher and an EEXIST observer must durably publish the directory entry before
      // either is allowed to commit a SQLite reference.
      await syncDirectory(digestPrefix, recordDirectoryFsync);
    } finally {
      await fs.rm(temporaryPath, { force: true });
      await syncDirectory(temporaryRoot, recordDirectoryFsync);
    }

    return published;
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
    const prepared = await this.prepareBatch(database, [{ content, contentType }]);
    if (!prepared[0]) throw new Error('CAS single prepare lost its input.');
    return prepared[0];
  }

  public async prepareBatch(
    database: RuntimeDatabase,
    inputs: ReadonlyArray<{ content: Uint8Array | string; contentType: string }>
  ): Promise<PreparedContentObject[]> {
    if (inputs.length === 0) return [];
    if (!sameBindingIdentity(database.binding, this.binding)) {
      throw new Error('CAS and RuntimeDatabase must use the same RootBinding.');
    }
    // Copy mutable Uint8Array inputs before the first await so identity and later publish always refer
    // to exactly the same bytes.
    const identified = inputs.map((input) => identifyContent(this.binding, input.content, input.contentType));
    const unique = [...new Map(identified.map((entry) => [contentObjectId(entry.published), entry])).values()];
    const repository = DOMAIN_REPOSITORIES.domain('ContentObject');
    // One snapshot is one worker request even when it carries several unique identity lookups.
    const existing = await database.snapshot(unique.map((entry) =>
      repository.list({ where: contentObjectIdentity(entry.published), limit: 1 })
    ));
    if (existing.snapshot.length !== unique.length) {
      throw new Error('ContentObject batch lookup returned the wrong result count.');
    }

    const preparedById = new Map<string, PreparedContentObject>();
    const missing: IdentifiedContent[] = [];
    let lookupHits = 0;
    unique.forEach((entry, index) => {
      const rows = existing.snapshot[index];
      if (!Array.isArray(rows)) throw new TypeError('ContentObject batch lookup did not return rows.');
      const row = rows[0];
      const id = contentObjectId(entry.published);
      if (row) {
        lookupHits += 1;
        preparedById.set(id, { metadata: requireMatchingContentObject(row, entry.published) });
      } else {
        missing.push(entry);
      }
    });
    this.recordMetric('lookup-hit', lookupHits);
    this.recordMetric('lookup-miss', missing.length);

    const publishedMisses = await Promise.all(missing.map((entry) => this.publishIdentified(entry)));
    for (const published of publishedMisses) {
      const metadata = contentObjectMetadata(published);
      preparedById.set(metadata.id, { metadata, insert: repository.insert(metadata) });
    }

    return identified.map((entry) => {
      const prepared = preparedById.get(contentObjectId(entry.published));
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
    await this.authority.validate(this.binding);
    return Buffer.from(await this.readVerifiedObject(metadata));
  }

  /** Fenced on-demand chunk read; callers still enforce their wire response budget. */
  public async readChunk(
    metadata: ContentObjectMetadata,
    offset: number,
    maxBytes: number
  ): Promise<{ chunk: Buffer; nextOffset?: number; totalBytes: number; hasMore: boolean }> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('CAS chunk offset must be a non-negative integer.');
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('CAS chunk maxBytes must be a positive integer.');
    await this.authority.validate(this.binding);
    const expectedKey = storageKeyForDigest(metadata.sha256);
    if (metadata.storage_key !== expectedKey) throw new Error('ContentObject storage key does not match sha256.');
    const totalBytes = Number(metadata.byte_length);
    if (!Number.isSafeInteger(totalBytes)) throw new RangeError('CAS object is too large for chunk addressing.');
    if (offset > totalBytes) throw new RangeError('CAS chunk offset exceeds object length.');
    const length = Math.min(maxBytes, totalBytes - offset);
    // The first range verifies the complete immutable object. Later ranges reuse those exact
    // verified bytes, rather than reading and hashing the complete file once per 256 KiB page.
    const verified = await this.readVerifiedObject(metadata);
    const chunk = Buffer.from(verified.subarray(offset, offset + length));
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
    return metadata.map((entry) => {
      const bytes = contents.get(entry.id);
      if (!bytes) throw new Error(`CAS batch read lost ContentObject ${entry.id}.`);
      return Buffer.from(bytes);
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
    const promise = readPublishedObject(this.binding, metadata)
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

export function storageKeyForDigest(sha256: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError('CAS digest must be lowercase SHA-256.');
  return `sha256/${sha256.slice(0, 2)}/${sha256}`;
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

function contentObjectMetadata(content: PublishedContent): ContentObjectMetadata {
  return {
    id: contentObjectId(content),
    content_type: content.contentType,
    sha256: content.sha256,
    byte_length: content.byteLength,
    storage_key: content.storageKey,
    created_at: new Date().toISOString()
  };
}

function identifyContent(
  binding: RootBinding,
  content: Uint8Array | string,
  contentType: string
): IdentifiedContent {
  const normalizedType = requireContentType(contentType);
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const storageKey = storageKeyForDigest(sha256);
  return {
    bytes,
    published: {
      contentType: normalizedType,
      sha256,
      byteLength: BigInt(bytes.length),
      storageKey,
      absolutePath: absoluteCasPath(binding, storageKey)
    }
  };
}

function requireMatchingContentObject(row: DomainRow, expected: PublishedContent): ContentObjectMetadata {
  const metadata = asContentObjectMetadata(row);
  if (
    metadata.id !== contentObjectId(expected)
    || metadata.content_type !== expected.contentType
    || metadata.sha256 !== expected.sha256
    || metadata.byte_length !== expected.byteLength
    || metadata.storage_key !== expected.storageKey
  ) {
    throw new Error('Existing ContentObject does not match the requested content identity.');
  }
  return metadata;
}

function absoluteCasPath(binding: RootBinding, storageKey: string): string {
  const root = path.resolve(binding.paths.casRootPath);
  const candidate = path.resolve(root, ...storageKey.split('/'));
  if (!isPathBelow(root, candidate)) throw new Error('CAS storage key escapes its active root.');
  return candidate;
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

function validatePublishedBytes(metadata: ContentObjectMetadata, bytes: Buffer): Buffer {
  if (BigInt(bytes.length) !== metadata.byte_length) throw new Error('CAS object byte length mismatch.');
  if (createHash('sha256').update(bytes).digest('hex') !== metadata.sha256) throw new Error('CAS object digest mismatch.');
  return bytes;
}

async function readPublishedObject(binding: RootBinding, metadata: ContentObjectMetadata): Promise<Buffer> {
  const expectedKey = storageKeyForDigest(metadata.sha256);
  if (metadata.storage_key !== expectedKey) throw new Error('ContentObject storage key does not match sha256.');
  const filePath = absoluteCasPath(binding, expectedKey);
  return validatePublishedBytes(metadata, await fs.readFile(filePath));
}

async function assertExistingObject(filePath: string, digest: string, byteLength: bigint): Promise<void> {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || BigInt(stat.size) !== byteLength) throw new Error('Existing CAS object has the wrong length.');
  const bytes = await fs.readFile(filePath);
  if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Existing CAS object has the wrong digest.');
}

async function ensureDurableChildDirectory(
  parentPath: string,
  childPath: string,
  onFsync: () => void
): Promise<void> {
  if (path.dirname(childPath) !== parentPath) {
    throw new Error(`CAS durable directory ${childPath} is not a direct child of ${parentPath}.`);
  }
  try {
    await fs.mkdir(childPath);
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const stat = await fs.stat(childPath);
    if (!stat.isDirectory()) throw new Error(`CAS path ${childPath} exists but is not a directory.`);
  }
  // Sync both sides even after EEXIST: a competing creator may not yet have synced the parent.
  await syncDirectory(childPath, onFsync);
  await syncDirectory(parentPath, onFsync);
}

async function syncDirectory(directoryPath: string, onFsync: () => void): Promise<void> {
  await syncDirectoryDurably(directoryPath, onFsync);
}

function asContentObjectMetadata(row: DomainRow): ContentObjectMetadata {
  return row as ContentObjectMetadata;
}

function requireContentType(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('CAS contentType must be non-empty.');
  return value.trim();
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'EEXIST';
}
