import * as path from 'node:path';
import type { RootBinding } from './contracts';
import type { RuntimeDatabase } from './runtimeDatabase';
import {
  RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE, type RuntimeDataSetMergeBatchResult, type RuntimeDataSetMergeResult, type RuntimeDataSetMergeOptions
} from './runtimeDataSetMerge';
import { peekRuntimeDataSetSummary } from './runtimeDataSetPreflight';
import {
  estimateLargeMergeSources, LargeMergePreparationError, prepareLargeMergeSources, releaseLargeMergePreparation, runLargeMergeSession, RUNTIME_DATA_SET_MERGE_CANCELLED,
  type LargeMergeEstimateProgress, type LargeMergePreparation as StreamedMergePreparation, type LargeMergePrepareProgress,
  type LargeMergeSourceResult
} from './runtimeDataSetStreamedMerge';
import { isRuntimeDataRootAdmissionHeld } from './runtimeHostControl';
import { inspectVscodeRuntimeDataSets, type VscodeRuntimeDataSetCandidate } from './vscodeRootAuthority';

/**
 * The large historical merge engine as the large merge session sees it (vscode/commands/
 * largeHistoricalMerge.ts): which sources wait for the session, a read-only estimate of them, their
 * online preparation, and the merge itself inside the exclusive phase. This file is the only place
 * that knows the engine's own functions (runtimeDataSetStreamedMerge.ts); a change of their names or
 * shapes is adapted here and nowhere else.
 *
 * The session never decides what a source is: the online batch (mergeHistoricalDataSetsOnline)
 * defers a source above the in-memory transaction bound, and a source above the online bound in a
 * batch that has one, with RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE (nothing recorded); the
 * estimate judges them read-only before the user agreed (from the audit cached for their exact
 * files, else one private copy each); only after that the preparation judges and prepares each
 * source online (the engine keeps a claim on each prepared source until the preparation runs or is
 * released); the run merges every prepared source in its own streamed maintenance transaction.
 */

/**
 * What prepare() throws when the preparation failed as a whole: its reason as the user is told it,
 * and how many sources' unfinished work it had closed already (their data changed).
 */
export { LargeMergePreparationError };

/** How long a part of the session (preparing, or the exclusive phase) of one source or all of them is expected to take. */
export interface LargeMergeDuration {
  /** The engine's estimate (a preparation estimates the exclusive phase again from its trial of the merge). */
  expectedMs: number;
  /** The range the user is told. */
  minMs: number;
  maxMs: number;
}

/**
 * A source waiting for the large merge session, as the last online batch of this process judged it:
 * its audited size. How long it takes is known once it was estimated (before the prompt or the
 * confirmation), never made up from the size here.
 */
export interface LargeMergeWaitingSource {
  candidateId: string;
  rows: number;
  bytes: number;
}

/**
 * A source the session would take, as the read-only estimate judged it before anything was
 * prepared: nothing of it was finalized, backed up, copied into the target or recorded.
 */
export interface LargeMergeEstimatedSource {
  candidateId: string;
  /** As the preparation's (the project names the candidate list read, else the kind of history, or a foreign history root's name). */
  label?: string;
  runtimeDataRootPath?: string;
  /**
   * The value the preparation gives the same files: the coordination key asked before the countdown
   * is the one the session uses while the source does not change (a preparation that closes the
   * source's unfinished work changes it, and with it the key).
   */
  fingerprint: string;
  rows: number;
  /** SQLite database plus WAL. */
  databaseBytes: number;
  /** Its background preparation while every window stays usable (the one target backup is counted in the total only). */
  preparing: LargeMergeDuration;
  /** Its exclusive phase, every window paused. */
  duration: LargeMergeDuration;
  /** Judged from the audit cached for its exact files: nothing was copied for it now. */
  cached: boolean;
}

export interface LargeMergeEstimate {
  sources: LargeMergeEstimatedSource[];
  /** Sources that need no session, as the online batch reports them; nothing of it is recorded. */
  report: LargeMergeSettledReport;
  /** Free space the preparation and the session would still need (the online target backup and content copied into the target included). */
  space: LargeMergeSpaceFacts;
  /** The background preparation of all sources with the one online target backup. */
  preparing: LargeMergeDuration;
  /** The exclusive phase: how long every window pauses. */
  duration: LargeMergeDuration;
  /** Stopped (its signal) before it was done: nothing is offered. */
  stopped: boolean;
}

export interface LargeMergePreparedSource {
  candidateId: string;
  /** For the user: the project names the candidate list read, else the kind of history, or a foreign history root's name (no id). */
  label?: string;
  /** Where the source is, for the details the user can open. */
  runtimeDataRootPath?: string;
  /** Digest of the source content the preparation judged: part of the coordination key. */
  fingerprint: string;
  rows: number;
  /** SQLite database plus WAL. */
  databaseBytes: number;
  /** Its exclusive phase, measured again while preparing (the trial of the merge). */
  duration: LargeMergeDuration;
}

/**
 * Sources the estimate or the preparation settled without the session, as the online batch reports
 * them: already merged or nothing new (merged), refused, deferred. Told like the batch's outcomes,
 * same dedup.
 */
export type LargeMergeSettledReport = Pick<RuntimeDataSetMergeBatchResult, 'merged' | 'deferred' | 'blocked' | 'failures'>;

/**
 * Free space as the engine computes it: on the target's disk (the sources' databases, the largest
 * one's WAL peak, the target's index pages and a margin; for an estimate also the online target
 * backup and the content objects copied into the target, which the preparation takes before the
 * session), in the temporary directory (one private copy of the largest source at a time) and in
 * SQLite's temporary directory (its temporary files). A preparation's figures are the ones the
 * engine checks at the start of its session.
 */
export interface LargeMergeSpaceFacts {
  targetDirectory: string;
  targetBytes: number;
  temporaryDirectory: string;
  temporaryBytes: number;
  sqliteTemporaryDirectory: string;
  sqliteTemporaryBytes: number;
}

export interface LargeMergePreparation {
  sources: LargeMergePreparedSource[];
  report: LargeMergeSettledReport;
  space: LargeMergeSpaceFacts;
  /** Opaque: what the engine needs back in run() and release(). */
  readonly engineState: unknown;
}

export interface LargeMergeRunProgress {
  /** 0-based index of the source being merged, of `total`. */
  index: number;
  total: number;
  candidateId: string;
  /** What the engine does with it now (copying, merging, committing…), for tests and logs. */
  stage?: string;
  /** Source rows handled so far in this session (compared and written or reused), and of all prepared sources. */
  rowsDone: number;
  rowsTotal: number;
  /** The engine's own estimate from this session's rate, when it has one. */
  remainingMs?: number;
}

/**
 * Why a source was not merged. `label` is a foreign history root's readable name (the engine's, as its
 * issues carry it): the reasons told after the session name it by that, a local source by its id as
 * the online batch does.
 */
interface LargeMergeSourceNotMerged<State extends 'cancelled' | 'deferred' | 'blocked' | 'failed'> {
  candidateId: string;
  state: State;
  code: string;
  message: string;
  label?: string;
}

export type LargeMergeSourceOutcome =
  | { candidateId: string; state: 'merged'; result: RuntimeDataSetMergeResult }
  /** Rolled back because the session was cancelled while this source ran; a later startup tries it again. */
  | LargeMergeSourceNotMerged<'cancelled'>
  /** Not started (cancelled or out of disk space before it) or stopped by something other than the source. */
  | LargeMergeSourceNotMerged<'deferred'>
  | LargeMergeSourceNotMerged<'blocked' | 'failed'>;

export interface LargeMergeEngine {
  /** Sources the last online batch of this process left to the session, with their audited size. */
  waiting(paths: { globalStoragePath: string }): Promise<LargeMergeWaitingSource[]>;
  /** An online batch's outcome: which sources wait for the session now, and which no longer do. */
  noteBatch(paths: { globalStoragePath: string }, report: RuntimeDataSetMergeBatchResult): void;
  /**
   * Read-only, before the user agreed: which of these sources a session would take, how long its
   * background preparation and its exclusive phase would take, and the space. Nothing is finalized,
   * backed up, copied into the target, claimed beyond the read or recorded (only the audit caches
   * are written). Never inside the configuration admission: a foreign history root is claimed before it.
   */
  estimate(input: {
    paths: { globalStoragePath: string };
    target: { configurationRootPath: string; database: RuntimeDatabase };
    candidateIds: readonly string[];
    /** The user asked for this merge (a source merged or kept before counts too). */
    requested: boolean;
    signal?: AbortSignal;
    /** Only while a source is copied and audited (none of its exact files was audited before). */
    onProgress?(message: string): void;
  }): Promise<LargeMergeEstimate>;
  /** Online, while this window keeps working; only after the user agreed (it finalizes, backs up, publishes content, claims). */
  prepare(input: {
    paths: { globalStoragePath: string };
    target: { configurationRootPath: string; database: RuntimeDatabase };
    candidateIds: readonly string[];
    /** The user asked for this merge (a recorded refusal is judged again). */
    requested: boolean;
    signal?: AbortSignal;
    onProgress?(message: string): void;
  } & Pick<RuntimeDataSetMergeOptions, 'confirmSettlement' | 'settleSourceWork'>): Promise<LargeMergePreparation>;
  /**
   * Lets go of a preparation that will not run (the claims the engine keeps, a target backup no
   * session used). After run() there is nothing left to let go of; calling it then does nothing.
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

/** The engine of this build: the streamed merge of runtimeDataSetStreamedMerge.ts. */
export function largeMergeEngine(): LargeMergeEngine {
  return STREAMED_MERGE_ENGINE;
}

/** Per configuration root, from the online batches of this process (the engine keeps no such cache). */
const waitingSources = new Map<string, Map<string, { rows: number; bytes: number }>>();

const STREAMED_MERGE_ENGINE: LargeMergeEngine = Object.freeze<LargeMergeEngine>({
  async waiting(paths: { globalStoragePath: string }): Promise<LargeMergeWaitingSource[]> {
    const known = waitingSources.get(path.resolve(paths.globalStoragePath));
    return known ? [...known].map(([candidateId, size]) => ({ candidateId, ...size })) : [];
  },

  noteBatch(paths: { globalStoragePath: string }, report: RuntimeDataSetMergeBatchResult): void {
    const key = path.resolve(paths.globalStoragePath);
    const known = waitingSources.get(key) ?? new Map<string, { rows: number; bytes: number }>();
    for (const merged of report.merged) known.delete(merged.candidateId);
    for (const issue of [...report.deferred, ...report.blocked, ...report.failures]) {
      if (issue.candidateId === undefined) continue;
      if (issue.code === RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE && issue.size) {
        known.set(issue.candidateId, { rows: issue.size.rows, bytes: issue.size.bytes });
      } else known.delete(issue.candidateId);
    }
    if (known.size > 0) waitingSources.set(key, known);
    else waitingSources.delete(key);
  },

  async estimate(input) {
    // The lock order is a foreign root's claim first, then the configuration admission: an estimate
    // inside the admission could not claim a foreign root (and would wait on itself for others).
    if (isRuntimeDataRootAdmissionHeld(input.paths.globalStoragePath)) {
      throw new Error('The large-merge estimate runs outside the configuration admission, never inside it.');
    }
    const estimated = await estimateLargeMergeSources({
      paths: input.paths,
      target: { configurationRootPath: input.target.configurationRootPath, database: input.target.database },
      candidateIds: input.candidateIds,
      requested: input.requested,
      // As the preparation: every source above the online bound the batch left to the session.
      threshold: 'online',
      ...(input.signal ? { signal: input.signal } : {}),
      onProgress: (progress) => input.onProgress?.(describeEstimate(progress))
    });
    // Settled without a session (merged, refused, or no longer above the online bound): no longer
    // waiting, so the menu and the list stop offering it (a refused one shows its recorded reason).
    if (!estimated.report.stopped) {
      forgetWaiting(input.paths, [
        ...estimated.report.merged.map((result) => result.candidateId),
        ...[...estimated.report.blocked, ...estimated.report.failures].flatMap((issue) => (issue.candidateId !== undefined ? [issue.candidateId] : [])),
        ...estimated.small
      ]);
    }
    const labels = await sourceLabels(input.paths, estimated.sources.map((source) => source.candidateId));
    return {
      sources: estimated.sources.map((source) => ({
        candidateId: source.candidateId,
        ...(labels.has(source.candidateId) ? { label: labels.get(source.candidateId)! } : source.label ? { label: source.label } : {}),
        runtimeDataRootPath: source.runtimeDataRootPath,
        fingerprint: source.fingerprint,
        rows: source.rows,
        databaseBytes: source.databaseBytes,
        preparing: duration(source.prepareEstimateMs, source.prepareEstimateRangeMs),
        duration: duration(source.sessionEstimateMs, source.sessionEstimateRangeMs),
        cached: source.cached
      })),
      report: settledReport(estimated.report, estimated.small, input.requested),
      // Its target figure has the online target backup and the content copied into the target in it.
      space: spaceFacts(estimated.space),
      preparing: duration(estimated.prepareEstimateMs, estimated.prepareEstimateRangeMs),
      duration: duration(estimated.sessionEstimateMs, estimated.sessionEstimateRangeMs),
      stopped: estimated.report.stopped
    };
  },

  async prepare(input) {
    const prepared = await prepareLargeMergeSources({
      paths: input.paths,
      target: { configurationRootPath: input.target.configurationRootPath, database: input.target.database },
      candidateIds: input.candidateIds,
      requested: input.requested,
      options: { confirmSettlement: input.confirmSettlement, settleSourceWork: input.settleSourceWork },
      // The session takes every source above the online bound the batch left to it, not only the largest.
      threshold: 'online',
      ...(input.signal ? { signal: input.signal } : {}),
      onProgress: (progress) => input.onProgress?.(describePreparation(progress))
    });
    const labels = await sourceLabels(input.paths, prepared.sources.map((source) => source.candidateId));
    return {
      sources: prepared.sources.map((source) => ({
        candidateId: source.candidateId,
        // A foreign history root is no local candidate: the engine names it (PreparedLargeMergeSource.label).
        ...(labels.has(source.candidateId) ? { label: labels.get(source.candidateId)! } : source.label ? { label: source.label } : {}),
        runtimeDataRootPath: source.runtimeDataRootPath,
        fingerprint: source.fingerprint,
        rows: source.rows,
        databaseBytes: source.databaseBytes,
        // Measured again while preparing (its trial of the merge).
        duration: duration(source.estimateMs, source.estimateRangeMs)
      })),
      report: settledReport(prepared.report, prepared.small, input.requested),
      space: spaceFacts(prepared.space),
      engineState: prepared
    };
  },

  async release(preparation) {
    await releaseLargeMergePreparation(preparation.engineState as StreamedMergePreparation);
  },

  async run(input) {
    // input.target.binding is not needed: the engine resolves the selected data set again and checks it.
    const session = await runLargeMergeSession({
      paths: input.paths,
      prepared: input.preparation.engineState as StreamedMergePreparation,
      ...(input.signal ? { signal: input.signal } : {}),
      onProgress: (progress) => input.onProgress?.({
        index: progress.index, total: progress.total, candidateId: progress.candidateId, stage: progress.stage,
        rowsDone: progress.sessionRows, rowsTotal: progress.sessionTotalRows, remainingMs: progress.remainingMs
      })
    });
    // A foreign history root's name as the engine prepared it: also for a source that never started (no issue).
    const foreignLabels = new Map((input.preparation.engineState as StreamedMergePreparation).sources
      .flatMap((source) => (source.label ? [[source.candidateId, source.label] as const] : [])));
    return session.results.map((result) => largeMergeSourceOutcome(result, foreignLabels.get(result.candidateId)));
  }
});

function forgetWaiting(paths: { globalStoragePath: string }, candidateIds: readonly string[]): void {
  const key = path.resolve(paths.globalStoragePath);
  const known = waitingSources.get(key);
  if (!known) return;
  for (const candidateId of candidateIds) known.delete(candidateId);
  if (known.size === 0) waitingSources.delete(key);
}

/**
 * One source's result of the engine's session as the session reports it: nothing new counts as
 * merged (alreadyMerged); the source a cancel rolled back is 'cancelled'; a source that never
 * started (after a cancel, or after the disk filled up) is deferred with why. A foreign history
 * root keeps its readable name: the one its issue carries, else `foreignLabel` (the engine's name
 * from the preparation, for a source that never started). Exported for tests.
 */
export function largeMergeSourceOutcome(result: LargeMergeSourceResult, foreignLabel?: string): LargeMergeSourceOutcome {
  const label = ('issue' in result ? result.issue.label : undefined) ?? foreignLabel;
  const named = label ? { label } : {};
  switch (result.state) {
    case 'merged':
      return { candidateId: result.candidateId, state: 'merged', result: result.result };
    case 'current':
      // Nothing new, or merged by another window meanwhile.
      return { candidateId: result.candidateId, state: 'merged', result: { ...result.result, alreadyMerged: true } };
    case 'not-run':
      return result.reason === 'cancelled'
        ? {
          candidateId: result.candidateId, state: 'deferred', code: RUNTIME_DATA_SET_MERGE_CANCELLED,
          message: '合并中途取消了，这一份还没有开始，以后启动时会再合并。', ...named
        }
        : {
          candidateId: result.candidateId, state: 'deferred', code: 'runtime-data-set-merge-disk-full',
          message: '前一份合并时磁盘空间不足，这一份没有开始；腾出空间后会再合并。', ...named
        };
    case 'deferred':
      if (result.issue.code === RUNTIME_DATA_SET_MERGE_CANCELLED) {
        return {
          candidateId: result.candidateId, state: 'cancelled', code: result.issue.code,
          message: '合并时取消了，这一份已撤回，以后启动时会再合并。', ...named
        };
      }
      return { candidateId: result.candidateId, state: 'deferred', code: result.issue.code, message: result.issue.message, ...named };
    default:
      return { candidateId: result.candidateId, state: result.state, code: result.issue.code, message: result.issue.message, ...named };
  }
}

function duration(expectedMs: number, [minMs, maxMs]: readonly [number, number]): LargeMergeDuration {
  return { expectedMs, minMs, maxMs };
}

/** The engine's settled sources as the batch reports them; a source that shrank below the online bound is said to be left to the online merge. */
function settledReport(
  report: Pick<RuntimeDataSetMergeBatchResult, 'merged' | 'deferred' | 'blocked' | 'failures'>,
  small: readonly string[],
  requested: boolean
): LargeMergeSettledReport {
  return {
    merged: [...report.merged],
    // Not above the online bound after all (it shrank): the next online batch merges it.
    deferred: [...report.deferred, ...small.map((candidateId) => ({
      candidateId, code: 'runtime-data-set-merge-large-session-small', newly: true, ...(requested ? { requested: true } : {}),
      message: '这份旧聊天记录不需要所有窗口暂停，下次启动时会在后台直接合并。'
    }))],
    blocked: [...report.blocked],
    failures: [...report.failures]
  };
}

function spaceFacts(space: LargeMergeSpaceFacts): LargeMergeSpaceFacts {
  return {
    targetDirectory: space.targetDirectory, targetBytes: space.targetBytes,
    temporaryDirectory: space.temporaryDirectory, temporaryBytes: space.temporaryBytes,
    sqliteTemporaryDirectory: space.sqliteTemporaryDirectory, sqliteTemporaryBytes: space.sqliteTemporaryBytes
  };
}

const ESTIMATE_STAGES: Record<LargeMergeEstimateProgress['stage'], string> = {
  snapshot: '正在复制一份只读副本',
  audit: '正在核验只读副本'
};

/** “第 1/2 份：正在复制一份只读副本” (only for a source none of whose exact files was audited before). */
function describeEstimate(progress: LargeMergeEstimateProgress): string {
  return `第 ${progress.index + 1}/${progress.total} 份：${ESTIMATE_STAGES[progress.stage] ?? '正在估计'}`;
}

const PREPARE_STAGES: Record<LargeMergePrepareProgress['stage'], string> = {
  snapshot: '正在复制一份只读副本',
  scan: '正在逐条比较',
  finalize: '正在收尾中断的任务',
  cas: '正在复制正文',
  backup: '正在备份当前历史库'
};

/** “第 1/2 份：正在逐条比较（已比较 12000 条）”. */
function describePreparation(progress: LargeMergePrepareProgress): string {
  const rows = progress.rows !== undefined && progress.rows > 0 ? `（已比较 ${progress.rows} 条）` : '';
  return `第 ${progress.index + 1}/${progress.total} 份：${PREPARE_STAGES[progress.stage] ?? '正在准备'}${rows}`;
}

/**
 * The names the candidate list shows for these sources (the project names it already read, never
 * read here), else the kind of history. Only a label: a source it cannot name keeps none.
 */
async function sourceLabels(paths: { globalStoragePath: string }, candidateIds: readonly string[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (candidateIds.length === 0) return labels;
  const candidates = await inspectVscodeRuntimeDataSets(paths).then((inspection) => inspection.candidates, () => [] as VscodeRuntimeDataSetCandidate[]);
  for (const candidateId of candidateIds) {
    const candidate = candidates.find((item) => item.id === candidateId);
    if (!candidate) continue;
    const names = peekRuntimeDataSetSummary(candidate)?.projectNames ?? [];
    labels.set(candidateId, names.length > 0 ? names.join('、') : candidate.source === 'workspace' ? '旧工作区历史' : '默认历史库');
  }
  return labels;
}
