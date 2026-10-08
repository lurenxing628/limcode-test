import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createRuntimeRootPaths,type RootBinding } from './contracts';
import type { HistoricalRootBinding } from './rootAuthority';
import { runtimeDataSetFileState } from './runtimeDataSetFacts';
import {
HISTORICAL_MERGE_ENGINE as engine,
RUNTIME_DATA_SET_STREAMED_MERGE_MAX_ROWS,RuntimeDataSetMergeError,
type ForeignHistoricalMergeCandidate,type ForeignHistoricalMergeHold,type HistoricalMergeSourceObjects
} from './runtimeDataSetMerge';
import {
cachedRuntimeRootFingerprint,readRuntimeDataSetMergeLedger,
rememberRuntimeRootFingerprint,
runtimeDataSetLastMerge,sameRuntimeDataSetIdentity,
type RuntimeDataSetFingerprint,type RuntimeDataSetIdentity,
type RuntimeDataSetMergeExcludedConversation,
type RuntimeDataSetMergeForeignSource
} from './runtimeDataSetMergeLedger';
import {
copyLocatedRuntimeDatabase,
foreignFileState,
ForeignRuntimeHistoryRejection,
heldDatabaseFiles,holdForeignRuntimeRootClaim,
isForeignRuntimeHistoryId,
locatedCasTransferSource,locatedSnapshotCacheFiles,
locateForeignRuntimeRoot,
type ForeignRuntimeHistoryEntry,type ForeignRuntimeRootClaimHold,type HeldDatabaseFiles,type LocatedCasAccess
} from './runtimeForeignHistory';
import { readRuntimeHistoryPending } from './runtimeHistoryRegistry';
import { sameLocatedRuntimeRoot,type ForeignRuntimeRootLocation,type LocatedRuntimeRoot } from './runtimeLocatedRoot';
import { reusableRuntimeMergeRefusal } from './runtimeMergeValidation';
import { auditRuntimeSnapshot } from './runtimeSnapshotAudit';
import { createLocatedRuntimeDatabaseSnapshot,type RuntimeDataSetDatabaseSnapshot } from './runtimeStorageInspection';
import { inspectVscodeRuntimeDataSets } from './vscodeRootAuthority';

/**
 * Takes a foreign root's claim for one merge (waiting as its fence waits) and returns the hold every
 * engine step reads the root through. Never inside the configuration admission; release it when done.
 */
export async function holdForeignHistoricalMergeSource(
  paths: { globalStoragePath: string },
  id: string,
  source: RuntimeDataSetMergeForeignSource,
  options: { signal?: AbortSignal } = {}
): Promise<ForeignHistoricalMergeHold> {
  const configurationRoot = path.resolve(paths.globalStoragePath);
  options.signal?.throwIfAborted();
  const location = source.location;
  let locatedId = id;
  if (!isForeignRuntimeHistoryId(id)) {
    const registered = (await readRuntimeHistoryPending(paths)).get(id);
    if (!registered || registered.location.kind === 'local' || !isDeepStrictEqual(registered.location, location)) {
      throw new TypeError(`Not a registered located history source: ${id}`);
    }
    const root = await locateForeignRuntimeRoot(configurationRoot, location);
    if (registered.identity && !sameRuntimeDataSetIdentity(registered.identity, root.recorded)) {
      throw new RuntimeDataSetMergeError('runtime-data-set-merge-identity-mismatch', '登记的旧历史已变化，请重新核验。');
    }
    locatedId = root.id;
  }
  // Claims share the physical located root's id with read-only views and foreign cleanup.
  const claim = await holdForeignRuntimeRootClaim({ globalStoragePath: configurationRoot }, locatedId, pointerOf(location), { refuseWhenHeld: !!options.signal });
  return new ForeignMergeHold(configurationRoot, id, source.label, location, claim, locatedId, options.signal);
}

/** The fingerprint of a requested foreign root, read under its claim for this read only (outside the admission). */
export async function foreignHistoricalMergeFingerprint(
  paths: { globalStoragePath: string },
  id: string,
  source: RuntimeDataSetMergeForeignSource
): Promise<RuntimeDataSetFingerprint> {
  const hold = await holdForeignHistoricalMergeSource(paths, id, source);
  try {
    return await hold.fingerprint(await hold.locate());
  } finally {
    await hold.release();
  }
}

export type ForeignRuntimeHistoryMergeState =
  /** The last merge of this root (its identity) into a data set, and whether the root changed since (by its verified content digest). */
  | ({ state: 'merged' } & ForeignRuntimeHistoryLastMerge)
  | ({ state: 'partial'; excluded: RuntimeDataSetMergeExcludedConversation[] } & ForeignRuntimeHistoryLastMerge)

  | { state: 'blocked' | 'failed'; code: string; message: string; lastMerged?: ForeignRuntimeHistoryLastMerge }
  | { state: 'too-large'; rows: number; maxRows: number; message: string; lastMerged?: ForeignRuntimeHistoryLastMerge };

export interface ForeignRuntimeHistoryLastMerge {
  mergedAt: string;
  intoCurrent: boolean;
  changedSinceMerge: boolean;
  /** That merge left out conversations the user had deleted there: backup cleanup keeps this root. */
  skippedConversations?: number;
  excluded?: RuntimeDataSetMergeExcludedConversation[];
}

/**
 * Merge state of verified foreign roots relative to the selected data set, from this configuration
 * root's ledger and each entry's verified content digest (nothing of a root is read here). A record is
 * kept under the id the root had when it was merged; a data-root relocation renames the containers of
 * the directory it leaves (an archive of the current directory becomes one of a previous directory),
 * which changes the id. Without a record of its own id, a record of another foreign id with the same
 * identity and exactly this content digest is the same root: its state is shown.
 */
export async function readForeignRuntimeHistoryMergeStates(
  paths: { globalStoragePath: string },
  entries: readonly ForeignRuntimeHistoryEntry[]
): Promise<Map<string, ForeignRuntimeHistoryMergeState>> {
  const storagePaths = { globalStoragePath: path.resolve(paths.globalStoragePath) };
  const result = new Map<string, ForeignRuntimeHistoryMergeState>();
  const selected = (await inspectVscodeRuntimeDataSets(storagePaths)).candidates.find((candidate) => candidate.selected);
  const current: RuntimeDataSetIdentity | undefined = selected?.dataSetId && selected.rootInstanceId
    ? { dataSetId: selected.dataSetId, rootInstanceId: selected.rootInstanceId } : undefined;
  const ledger = await readRuntimeDataSetMergeLedger(storagePaths);
  for (const entry of entries) {
    if (entry.status !== 'verified' || !entry.dataSetId || !entry.rootInstanceId) continue;
    const found = ledger.get(entry.id) ?? (entry.contentDigest === undefined ? undefined : [...ledger.values()].find((other) =>
      isForeignRuntimeHistoryId(other.candidateId) && !entries.some((listed) => listed.id === other.candidateId)
      && sameRuntimeDataSetIdentity(other.source, entry) && other.source.contentDigest === entry.contentDigest));
    const record = found && sameRuntimeDataSetIdentity(found.source, entry) ? found : undefined;
    const unchanged = record !== undefined && record.source.contentDigest === entry.contentDigest;
    const merge = record ? runtimeDataSetLastMerge(record) : undefined;
    const lastMerged: ForeignRuntimeHistoryLastMerge | undefined = merge && {
      mergedAt: merge.mergedAt, intoCurrent: sameRuntimeDataSetIdentity(merge.target, current), changedSinceMerge: merge.source.contentDigest !== entry.contentDigest,
      ...(merge.skippedConversations ? { skippedConversations: merge.skippedConversations } : {}),
      ...(merge.excluded?.length ? { excluded: merge.excluded } : {})
    };
    const carried = lastMerged ? { lastMerged } : {};
    if (unchanged && reusableRuntimeMergeRefusal(record) && (record.state === 'failed' || (record.state === 'blocked' && sameRuntimeDataSetIdentity(record.target, current)))) {
      result.set(entry.id, { state: record.state, code: record.code, message: record.message, ...carried });
    } else if (unchanged && record.state === 'too-large' && record.maxRows === RUNTIME_DATA_SET_STREAMED_MERGE_MAX_ROWS) {
      result.set(entry.id, { state: 'too-large', rows: record.rows, maxRows: record.maxRows, message: record.message, ...carried });
    } else if (lastMerged) {
      result.set(entry.id, lastMerged.excluded?.length
        ? { ...lastMerged, state: 'partial', excluded: lastMerged.excluded }
        : { ...lastMerged, state: 'merged' });
    }
  }
  return result;
}

/** A foreign rejection as a merge refusal: a lasting problem of the root fails it, anything of the moment defers. */
/** Its pointer as its location places it (the name of what its claim guards). */
function pointerOf(location: ForeignRuntimeRootLocation): string {
  return createRuntimeRootPaths(path.join(location.containerPath, ...location.dataRootRelativePath.split('/'))).rootPointerPath;
}

/**
 * A data set of a copied directory that backup cleanup deleted leaves the directory: its control
 * root is gone, not incomplete ("incomplete" stays for a root that is partly there).
 */
async function goneWhenRemoved(error: unknown, location: ForeignRuntimeRootLocation): Promise<unknown> {
  if (!(error instanceof ForeignRuntimeHistoryRejection) || error.code !== 'foreign-history-incomplete') return error;
  try {
    await fs.lstat(path.dirname(pointerOf(location)));
    return error;
  } catch (missing) {
    return isMissing(missing)
      ? new ForeignRuntimeHistoryRejection('unavailable', 'foreign-history-gone', '它已经被移走或删除（可能已在“清理备份”里删除），所在位置找不到了。')
      : error;
  }
}

function refusal(error: unknown): unknown {
  if (!(error instanceof ForeignRuntimeHistoryRejection)) return error;
  return new engine.Outcome({
    kind: error.status === 'failed' ? 'failed' : 'deferred',
    code: error.code,
    message: error.status === 'failed'
      ? `这个外来历史库没有通过核验，不合并：${error.message}`
      : `这个外来历史库暂时无法核验，稍后重试：${error.message}`
  });
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

class ForeignMergeHold implements ForeignHistoricalMergeHold {
  /** Each located candidate's exact pointer, manifest, record and database state when it was located. */
  private readonly located = new WeakMap<ForeignHistoricalMergeCandidate, string>();
  private lastVerified: ForeignHistoricalMergeCandidate | undefined;
  private readonly sourceObjects = new Map<ForeignHistoricalMergeCandidate, LocatedCasAccess>();
  private readonly casOwners = new Set<LocatedCasAccess>();
  private closing = false;

  public constructor(
    private readonly configurationRoot: string,
    public readonly id: string,
    public readonly label: string,
    private readonly location: ForeignRuntimeRootLocation,
    private readonly claim: ForeignRuntimeRootClaimHold,
    private readonly locatedId: string,
    public readonly signal?: AbortSignal
  ) {}

  public get held(): boolean {
    return !this.closing && this.claim.held;
  }

  public get verified(): ForeignHistoricalMergeCandidate | undefined {
    return this.lastVerified;
  }

  public async locate(): Promise<ForeignHistoricalMergeCandidate> {
    this.assertHeld();
    let root: LocatedRuntimeRoot;
    try {
      root = await locateForeignRuntimeRoot(this.configurationRoot, this.location, await this.heldFiles());
    } catch (error) {
      throw refusal(await goneWhenRemoved(error, this.location));
    }
    if (root.id !== this.locatedId) {
      throw new engine.Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-source-changed', message: '外来历史库所在位置现在是另一个库，本次不合并。' });
    }
    const candidate: ForeignHistoricalMergeCandidate = Object.freeze({
      kind: 'foreign' as const, id: this.id, label: this.label,
      dataSetId: root.recorded.dataSetId, rootInstanceId: root.recorded.rootInstanceId,
      runtimeDataRootPath: root.located.dataRootPath, root, hold: this
    });
    this.located.set(candidate, await foreignFileState(root));
    return candidate;
  }

  public async unchanged(candidate: ForeignHistoricalMergeCandidate, files: string | undefined): Promise<boolean> {
    const found = this.located.get(candidate);
    if (!this.held || candidate.hold !== this || files === undefined || found === undefined) return false;
    let current: LocatedRuntimeRoot;
    try {
      current = await locateForeignRuntimeRoot(this.configurationRoot, this.location, await this.heldFiles());
    } catch (error) {
      if (error instanceof ForeignRuntimeHistoryRejection) return false;
      throw error;
    }
    return sameLocatedRuntimeRoot(current, candidate.root)
      && await foreignFileState(current) === found
      && await runtimeDataSetFileState(current.located.databasePath) === files;
  }

  public async fence<T>(operation: () => Promise<T>): Promise<T> {
    this.assertHeld();
    return operation();
  }

  public async snapshot(
    candidate: ForeignHistoricalMergeCandidate,
    options: { beforeOpen?(snapshotPath: string): Promise<void> } = {}
  ): Promise<RuntimeDataSetDatabaseSnapshot> {
    this.assertHeld();
    let snapshot: RuntimeDataSetDatabaseSnapshot;
    try {
      snapshot = await createLocatedRuntimeDatabaseSnapshot(candidate.root, {
        ...(options.beforeOpen ? { beforeOpen: options.beforeOpen } : {}),
        copy: async (root) => copyLocatedRuntimeDatabase(root, await this.heldFiles(), this.signal)
      });
    } catch (error) {
      throw refusal(error);
    }
    let objects: LocatedCasAccess;
    try {
      // The Runtime snapshot precedes the append-only packed CAS copy. All source SQLite opens
      // remain confined to private copies, including the sidecar reader.
      objects = await locatedCasTransferSource(candidate.root, () => this.heldFiles(), this.signal);
    } catch (error) {
      await snapshot.close();
      throw refusal(error);
    }
    this.sourceObjects.set(candidate, objects);
    this.casOwners.add(objects);
    this.lastVerified = candidate;
    return {
      binding: snapshot.binding,
      get database() { return snapshot.database; },
      withClosedReader: (run) => snapshot.withClosedReader(run),
      close: async () => {
        try { await objects.close(); }
        finally { await snapshot.close(); }
        this.casOwners.delete(objects);
        if (this.sourceObjects.get(candidate) === objects) this.sourceObjects.delete(candidate);
      }
    };
  }

  public async fingerprint(candidate: ForeignHistoricalMergeCandidate): Promise<RuntimeDataSetFingerprint> {
    this.assertHeld();
    const { recorded, located } = candidate.root;
    const identity = {
      dataSetId: recorded.dataSetId, rootInstanceId: recorded.rootInstanceId,
      rootGeneration: recorded.rootGeneration, pointerRevision: recorded.pointerRevision
    };
    const files = await runtimeDataSetFileState(located.databasePath);
    const cached = await cachedRuntimeRootFingerprint({ globalStoragePath: this.configurationRoot }, this.id,
      locatedSnapshotCacheFiles(candidate.root, files), identity);
    if (cached) return cached;
    let copy: { databasePath: string; binding: HistoricalRootBinding; remove(): Promise<void> };
    try { copy = await copyLocatedRuntimeDatabase(candidate.root, await this.heldFiles(), this.signal); }
    catch (error) { throw refusal(error); }
    try {
      const audit = await auditRuntimeSnapshot(copy.databasePath, { binding: copy.binding as RootBinding, contentDigest: true, integrity: false }, { signal: this.signal });
      const fingerprint: RuntimeDataSetFingerprint = { ...identity, contentDigest: audit.contentDigest! };
      if (await runtimeDataSetFileState(located.databasePath).catch(() => undefined) === files) {
        await this.rememberFingerprint(candidate, files, fingerprint).catch(() => undefined);
      }
      return fingerprint;
    } finally {
      await copy.remove();
    }
  }

  public async rememberFingerprint(candidate: ForeignHistoricalMergeCandidate, files: string, fingerprint: RuntimeDataSetFingerprint): Promise<void> {
    await rememberRuntimeRootFingerprint({ globalStoragePath: this.configurationRoot }, this.id,
      locatedSnapshotCacheFiles(candidate.root, files), fingerprint);
  }

  public objects(candidate: ForeignHistoricalMergeCandidate): HistoricalMergeSourceObjects {
    const objects = this.sourceObjects.get(candidate);
    if (!objects) throw new Error('Foreign CAS access requires its open Runtime snapshot.');
    return {
      readPackedBytes: async (object) => {
        this.assertHeld();
        try { return await objects.readPackedBytes!(object); }
        catch (error) { throw refusal(error); }
      },
      size: async (object) => {
        this.assertHeld();
        return objects.size(object);
      },
      open: async (object) => {
        this.assertHeld();
        try { return await objects.open(object); }
        catch (error) { throw refusal(error); }
      }
    };
  }

  public async release(): Promise<void> {
    this.closing = true;
    for (const owner of this.casOwners) {
      await owner.close();
      this.casOwners.delete(owner);
    }
    this.sourceObjects.clear();
    await this.claim.release();
  }

  private assertHeld(): void {
    this.signal?.throwIfAborted();
    if (!this.held) {
      throw new engine.Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-source-changed', message: '合并这个外来历史库时它的声明已不在，本次不合并。' });
    }
  }

  private heldFiles(): Promise<HeldDatabaseFiles> {
    return heldDatabaseFiles(this.configurationRoot);
  }
}
