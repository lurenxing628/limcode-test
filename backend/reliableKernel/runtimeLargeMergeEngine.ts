import type { RootBinding } from './contracts';
import type { RuntimeDatabase } from './runtimeDatabase';
import type { RuntimeDataSetMergeBatchResult, RuntimeDataSetMergeResult } from './runtimeDataSetMerge';

/**
 * The large historical merge engine as the large merge session sees it (vscode/commands/
 * largeHistoricalMerge.ts): which sources wait for the session, their online preparation, and the
 * merge itself inside the exclusive phase. This file is the only place that knows the engine's own
 * functions; a change of their names or shapes is adapted here and nowhere else.
 *
 * The session never decides what a source is: the online batch (mergeHistoricalDataSetsOnline)
 * defers a source above the in-memory transaction bound with {@link LARGE_MERGE_AWAITING_CODE}
 * (nothing recorded), the preparation judges and prepares each source online (the engine may keep
 * short claims on them until the preparation runs or is released), and the run merges every
 * prepared source in its own streamed transaction.
 */

/** The online batch's deferral of a source that waits for the large merge session (never recorded). */
export const LARGE_MERGE_AWAITING_CODE = 'runtime-data-set-merge-awaiting-exclusive';

/** How long the exclusive phase of one source (or a whole session) is expected to take. */
export interface LargeMergeDuration {
  /** The engine's estimate. */
  expectedMs: number;
  /** The range the user is told, [0.8×, 1.6×] of the estimate. */
  minMs: number;
  maxMs: number;
}

/** A source waiting for the large merge session, from facts cached when it was judged (nothing is read). */
export interface LargeMergeWaitingSource {
  candidateId: string;
  rows: number;
  duration: LargeMergeDuration;
}

export interface LargeMergePreparedSource {
  candidateId: string;
  /** Where the source is, for the details the user can open (only its id when unknown). */
  runtimeDataRootPath?: string;
  /** Digest of the source content the preparation judged: part of the coordination key. */
  fingerprint: string;
  rows: number;
  /** SQLite database plus WAL. */
  databaseBytes: number;
  duration: LargeMergeDuration;
}

/**
 * Sources the preparation settled without the session, as the online batch reports them: already
 * merged or nothing new (merged), refused, deferred. Told like the batch's outcomes, same dedup.
 */
export type LargeMergeSettledReport = Pick<RuntimeDataSetMergeBatchResult, 'merged' | 'deferred' | 'blocked' | 'failures'>;

/**
 * Disk use still to come once the preparation ended (see planLargeMergeSpace): the prepared
 * sources' databases say how much the target grows and how large one source's WAL gets.
 */
export interface LargeMergeSpaceFacts {
  /** The target's Runtime data root (its database and WAL). */
  targetDirectory: string;
  /** Where private copies of a source are taken, one at a time. */
  temporaryDirectory: string;
  /** Target database plus WAL: an online backup of it is still to be taken when targetBackupPending. */
  targetDatabaseBytes: number;
  targetBackupPending: boolean;
  /**
   * CAS objects still to be written into the target: their logical bytes and, for each of the
   * data-root relocation's CLUSTER_SIZES, the bytes a copy allocates. Linked on the same disk.
   */
  pendingCas?: { sourceDirectory: string; bytes: number; clusterBytes: readonly number[] };
}

export interface LargeMergePreparation {
  sources: LargeMergePreparedSource[];
  report: LargeMergeSettledReport;
  space: LargeMergeSpaceFacts;
  /** Opaque: what the engine needs back in run(). */
  readonly engineState: unknown;
}

export interface LargeMergeRunProgress {
  /** 0-based index of the source being merged, of `total`. */
  index: number;
  total: number;
  candidateId: string;
  /** Rows this session wrote so far, and of all prepared sources. */
  rowsWritten: number;
  rowsTotal: number;
  /** The engine's own estimate from this session's rate, when it has one. */
  remainingMs?: number;
}

export type LargeMergeSourceOutcome =
  | { candidateId: string; state: 'merged'; result: RuntimeDataSetMergeResult }
  /** Rolled back because the session was cancelled while this source ran; a later startup tries it again. */
  | { candidateId: string; state: 'cancelled'; code: string; message: string }
  /** Not started (cancelled before it) or stopped by something other than the source (I/O, space). */
  | { candidateId: string; state: 'deferred'; code: string; message: string }
  | { candidateId: string; state: 'blocked' | 'failed'; code: string; message: string };

export interface LargeMergeEngine {
  waiting(paths: { globalStoragePath: string }): Promise<LargeMergeWaitingSource[]>;
  /** Online, without any claim, while this window keeps working. */
  prepare(input: {
    paths: { globalStoragePath: string };
    target: { configurationRootPath: string; database: RuntimeDatabase };
    candidateIds: readonly string[];
    /** The user asked for this merge (a recorded refusal is judged again). */
    requested: boolean;
    signal?: AbortSignal;
    onProgress?(message: string): void;
  }): Promise<LargeMergePreparation>;
  /**
   * Lets go of a preparation that will not run (a claim the engine kept, a target backup no session
   * used). After run() there is nothing left to let go of; calling it then does nothing.
   */
  release(preparation: LargeMergePreparation): Promise<void>;
  /**
   * Only inside the exclusive phase: the caller holds the configuration admission and the target's
   * maintenance claim, and this process's Runtime of the target is closed. Merges the prepared
   * sources one after another; a cancel rolls back the source that runs, the merged ones stay.
   */
  run(input: {
    paths: { globalStoragePath: string };
    target: { configurationRootPath: string; binding: RootBinding };
    preparation: LargeMergePreparation;
    signal?: AbortSignal;
    onProgress?(progress: LargeMergeRunProgress): void;
  }): Promise<LargeMergeSourceOutcome[]>;
}

/**
 * The engine of this build. The streamed merge (prepareLargeMergeSources / runLargeMergeSession)
 * is not part of it yet: no source waits for a session, so none is offered or prepared.
 */
export function largeMergeEngine(): LargeMergeEngine {
  return UNAVAILABLE_ENGINE;
}

const UNAVAILABLE_ENGINE: LargeMergeEngine = Object.freeze({
  waiting: async () => [],
  prepare: async () => { throw new Error('当前版本还不能合并较大的旧聊天记录。'); },
  release: async () => undefined,
  run: async () => { throw new Error('当前版本还不能合并较大的旧聊天记录。'); }
});
