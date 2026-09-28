import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isPathBelow } from '../capabilities/filesystem/pathContainment';
import { createRuntimeRootPaths, type RootBinding } from './contracts';
import {
  HISTORICAL_MERGE_ENGINE as engine, RUNTIME_DATA_SET_MERGE_REQUEST_TTL_MS, RUNTIME_DATA_SET_STREAMED_MERGE_MAX_ROWS, RuntimeDataSetMergeError,
  type ForeignHistoricalMergeCandidate, type ForeignHistoricalMergeHold, type HistoricalMergeSourceObjects
} from './runtimeDataSetMerge';
import { runtimeDataSetFileState } from './runtimeDataSetFacts';
import {
  cachedRuntimeRootFingerprint, readRuntimeDataSetMergeLedger, readRuntimeDataSetMergeRequests, rememberRuntimeRootFingerprint,
  runtimeDataSetLastMerge, sameRuntimeDataSetIdentity, writeRuntimeDataSetMergeRequest,
  type RuntimeDataSetFingerprint, type RuntimeDataSetIdentity, type RuntimeDataSetMergeForeignSource
} from './runtimeDataSetMergeLedger';
import {
  copyLocatedRuntimeDatabase, ForeignRuntimeHistoryRejection, foreignFileState, heldDatabaseFiles, holdForeignRuntimeRootClaim,
  isForeignRuntimeHistoryId, locateForeignRuntimeRoot, openLocatedRuntimeFile,
  type ForeignRuntimeHistoryEntry, type ForeignRuntimeRootClaimHold, type HeldDatabaseFiles
} from './runtimeForeignHistory';
import { withRuntimeDataRootAdmission } from './runtimeHostControl';
import { sameLocatedRuntimeRoot, type ForeignRuntimeRootLocation, type LocatedRuntimeRoot } from './runtimeLocatedRoot';
import { auditRuntimeSnapshot } from './runtimeSnapshotAudit';
import { assertNoSymbolicPath, createLocatedRuntimeDatabaseSnapshot, type RuntimeDataSetDatabaseSnapshot } from './runtimeStorageInspection';
import { inspectVscodeRuntimeDataSets } from './vscodeRootAuthority';

/**
 * Merging a verified foreign history root (runtimeForeignHistory) into the current data set, only on
 * the user's request (as a data set the user kept). The engines (runtimeDataSetMerge online and
 * runtimeDataSetStreamedMerge for a large-merge session) run their usual steps; this module gives
 * them the source:
 * - the request, recorded in this configuration root's merge ledger by the root's foreign id with
 *   where the root was found (its located paths come only from there, never from its records);
 * - the hold: the root's claim (`.limcode-runtime-merges/foreign-claims/<id>` under this
 *   configuration root, the one verification, viewing and backup cleanup take), held from the start
 *   of a merge (or its large-merge preparation) to its commit, and every read of the root the
 *   engines make under it: strict locating again (pointer, epoch manifest, current epoch, every Host
 *   proven gone, nothing unfinished), the exact-state check before the commit, private snapshot
 *   copies (never a file of a database this process holds), its fingerprint cached under this
 *   configuration root, and its content objects opened only as the regular files they are, below
 *   the container without any link.
 * Nothing is ever written into a foreign directory: no claim, ledger, backup, finalization, upgrade,
 * or SQLite sidecar (SQLite only opens private copies).
 */

/** Records the user's request to merge a verified foreign root into the selected data set. */
export async function requestForeignRuntimeHistoryMerge(
  paths: { globalStoragePath: string },
  input: {
    id: string;
    location: ForeignRuntimeRootLocation;
    /** Readable name for notices and the large-merge session. */
    label: string;
    expectedDataSetId: string;
    expectedRootInstanceId: string;
  }
): Promise<void> {
  const storagePaths = { globalStoragePath: path.resolve(paths.globalStoragePath) };
  if (!isForeignRuntimeHistoryId(input.id)) throw new TypeError(`Not a foreign history id: ${input.id}`);
  // Located strictly first, outside the admission: nothing of the root is read under it.
  let root: LocatedRuntimeRoot;
  try {
    root = await locateForeignRuntimeRoot(storagePaths.globalStoragePath, input.location);
  } catch (error) {
    if (!(error instanceof ForeignRuntimeHistoryRejection)) throw error;
    throw new RuntimeDataSetMergeError(error.code, `这个外来历史库现在不能合并：${error.message}`);
  }
  if (root.id !== input.id || root.recorded.dataSetId !== input.expectedDataSetId || root.recorded.rootInstanceId !== input.expectedRootInstanceId) {
    throw new RuntimeDataSetMergeError('runtime-data-set-merge-identity-mismatch', '所选外来历史库已变化，请重新打开外来历史库。');
  }
  await withRuntimeDataRootAdmission(storagePaths.globalStoragePath, async () => {
    const selected = (await inspectVscodeRuntimeDataSets(storagePaths)).candidates.filter((candidate) => candidate.selected);
    if (selected.length !== 1 || !selected[0].dataSetId || !selected[0].rootInstanceId) {
      throw new RuntimeDataSetMergeError('runtime-data-set-merge-target-missing', '请先选定当前历史库，再合并外来历史库。');
    }
    await writeRuntimeDataSetMergeRequest(storagePaths, {
      candidateId: input.id,
      expectedDataSetId: input.expectedDataSetId,
      expectedRootInstanceId: input.expectedRootInstanceId,
      target: { dataSetId: selected[0].dataSetId, rootInstanceId: selected[0].rootInstanceId },
      foreign: { location: input.location, label: input.label }
    });
  });
}

/**
 * Takes a foreign root's claim for one merge (waiting as its fence waits) and returns the hold every
 * engine step reads the root through. Never inside the configuration admission; release it when done.
 */
export async function holdForeignHistoricalMergeSource(
  paths: { globalStoragePath: string },
  id: string,
  source: RuntimeDataSetMergeForeignSource
): Promise<ForeignHistoricalMergeHold> {
  const configurationRoot = path.resolve(paths.globalStoragePath);
  if (!isForeignRuntimeHistoryId(id)) throw new TypeError(`Not a foreign history id: ${id}`);
  const location = source.location;
  // Only recorded as text in the claim (what it guards); nothing there is touched.
  const claim = await holdForeignRuntimeRootClaim({ globalStoragePath: configurationRoot }, id, pointerOf(location));
  return new ForeignMergeHold(configurationRoot, id, source.label, location, claim);
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
  | { state: 'merged'; mergedAt: string; intoCurrent: boolean; changedSinceMerge: boolean; skippedConversations?: number }
  | { state: 'requested'; requestedAt: string; lastMerged?: ForeignRuntimeHistoryLastMerge }
  | { state: 'blocked' | 'failed'; code: string; message: string; lastMerged?: ForeignRuntimeHistoryLastMerge }
  | { state: 'too-large'; rows: number; maxRows: number; message: string; lastMerged?: ForeignRuntimeHistoryLastMerge };

export interface ForeignRuntimeHistoryLastMerge {
  mergedAt: string;
  intoCurrent: boolean;
  changedSinceMerge: boolean;
  /** That merge left out conversations the user had deleted there: backup cleanup keeps this root. */
  skippedConversations?: number;
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
  const requests = await readRuntimeDataSetMergeRequests(storagePaths);
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
      ...(merge.skippedConversations ? { skippedConversations: merge.skippedConversations } : {})
    };
    const carried = lastMerged ? { lastMerged } : {};
    const request = requests.get(entry.id);
    if (request?.foreign && current && sameRuntimeDataSetIdentity(request.target, current)
      && Date.now() - Date.parse(request.requestedAt) < RUNTIME_DATA_SET_MERGE_REQUEST_TTL_MS
      && request.expectedDataSetId === entry.dataSetId && request.expectedRootInstanceId === entry.rootInstanceId) {
      result.set(entry.id, { state: 'requested', requestedAt: request.requestedAt, ...carried });
    } else if (unchanged && (record.state === 'failed' || (record.state === 'blocked' && sameRuntimeDataSetIdentity(record.target, current)))) {
      result.set(entry.id, { state: record.state, code: record.code, message: record.message, ...carried });
    } else if (unchanged && record.state === 'too-large' && record.maxRows === RUNTIME_DATA_SET_STREAMED_MERGE_MAX_ROWS) {
      result.set(entry.id, { state: 'too-large', rows: record.rows, maxRows: record.maxRows, message: record.message, ...carried });
    } else if (lastMerged) {
      result.set(entry.id, { state: 'merged', ...lastMerged });
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

  public constructor(
    private readonly configurationRoot: string,
    public readonly id: string,
    public readonly label: string,
    private readonly location: ForeignRuntimeRootLocation,
    private readonly claim: ForeignRuntimeRootClaimHold
  ) {}

  public get held(): boolean {
    return this.claim.held;
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
    if (root.id !== this.id) {
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
        copy: async (root) => copyLocatedRuntimeDatabase(root, await this.heldFiles())
      });
    } catch (error) {
      throw refusal(error);
    }
    this.lastVerified = candidate;
    return snapshot;
  }

  public async fingerprint(candidate: ForeignHistoricalMergeCandidate): Promise<RuntimeDataSetFingerprint> {
    this.assertHeld();
    const { recorded, located } = candidate.root;
    const identity = {
      dataSetId: recorded.dataSetId, rootInstanceId: recorded.rootInstanceId,
      rootGeneration: recorded.rootGeneration, pointerRevision: recorded.pointerRevision
    };
    const files = await runtimeDataSetFileState(located.databasePath);
    const cached = await cachedRuntimeRootFingerprint({ globalStoragePath: this.configurationRoot }, this.id, files, identity);
    if (cached) return cached;
    let copy: { databasePath: string; remove(): Promise<void> };
    try { copy = await copyLocatedRuntimeDatabase(candidate.root, await this.heldFiles()); }
    catch (error) { throw refusal(error); }
    try {
      const audit = await auditRuntimeSnapshot(copy.databasePath, { binding: recorded as RootBinding, contentDigest: true, integrity: false });
      const fingerprint: RuntimeDataSetFingerprint = { ...identity, contentDigest: audit.contentDigest! };
      if (await runtimeDataSetFileState(located.databasePath).catch(() => undefined) === files) {
        await this.rememberFingerprint(candidate, files, fingerprint).catch(() => undefined);
      }
      return fingerprint;
    } finally {
      await copy.remove();
    }
  }

  public async rememberFingerprint(_candidate: ForeignHistoricalMergeCandidate, files: string, fingerprint: RuntimeDataSetFingerprint): Promise<void> {
    await rememberRuntimeRootFingerprint({ globalStoragePath: this.configurationRoot }, this.id, files, fingerprint);
  }

  public objects(candidate: ForeignHistoricalMergeCandidate): HistoricalMergeSourceObjects {
    const casRoot = candidate.root.located.casRootPath;
    // Each directory of an object is checked for links once per transfer; the held files once as well.
    const checked = new Set<string>();
    let held: Promise<HeldDatabaseFiles> | undefined;
    const reachable = async (file: string): Promise<void> => {
      if (!isPathBelow(casRoot, file)) throw new Error(`Content object escapes its root: ${file}`);
      const directory = path.dirname(file);
      if (checked.has(directory)) return;
      await assertNoSymbolicPath(candidate.root.containerRoot, directory);
      checked.add(directory);
    };
    return {
      size: async (file) => {
        this.assertHeld();
        try {
          await reachable(file);
          const info = await fs.lstat(file, { bigint: true });
          return info.isFile() ? info.size : undefined;
        } catch (error) {
          // Missing, or reached through a link: the source lacks it (its own lasting problem).
          if (isMissing(error) || (error instanceof Error && /symbolic link/.test(error.message))) return undefined;
          throw error;
        }
      },
      open: async (file) => {
        this.assertHeld();
        await reachable(file);
        try {
          return await openLocatedRuntimeFile(file, await (held ??= this.heldFiles()));
        } catch (error) {
          throw refusal(error);
        }
      }
    };
  }

  public async release(): Promise<void> {
    await this.claim.release();
  }

  private assertHeld(): void {
    if (!this.claim.held) {
      throw new engine.Outcome({ kind: 'deferred', code: 'runtime-data-set-merge-source-changed', message: '合并这个外来历史库时它的声明已不在，本次不合并。' });
    }
  }

  private heldFiles(): Promise<HeldDatabaseFiles> {
    return heldDatabaseFiles(this.configurationRoot);
  }
}
