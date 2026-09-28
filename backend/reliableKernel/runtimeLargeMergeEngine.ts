import * as path from 'node:path';
import type { RootBinding } from './contracts';
import type { RuntimeDatabase } from './runtimeDatabase';
import {
  RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE, type RuntimeDataSetMergeBatchResult, type RuntimeDataSetMergeResult
} from './runtimeDataSetMerge';
import { peekRuntimeDataSetSummary } from './runtimeDataSetPreflight';
import {
  prepareLargeMergeSources, releaseLargeMergePreparation, runLargeMergeSession, RUNTIME_DATA_SET_MERGE_CANCELLED,
  type LargeMergePreparation as StreamedMergePreparation, type LargeMergePrepareProgress, type LargeMergeSourceResult
} from './runtimeDataSetStreamedMerge';
import { inspectVscodeRuntimeDataSets, type VscodeRuntimeDataSetCandidate } from './vscodeRootAuthority';

/**
 * The large historical merge engine as the large merge session sees it (vscode/commands/
 * largeHistoricalMerge.ts): which sources wait for the session, their online preparation, and the
 * merge itself inside the exclusive phase. This file is the only place that knows the engine's own
 * functions (runtimeDataSetStreamedMerge.ts); a change of their names or shapes is adapted here and
 * nowhere else.
 *
 * The session never decides what a source is: the online batch (mergeHistoricalDataSetsOnline)
 * defers a source above the in-memory transaction bound, and a source above the online bound in a
 * batch that has one, with RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE (nothing recorded); the
 * preparation judges and prepares each source online (the engine keeps a claim on each prepared
 * source until the preparation runs or is released); the run merges every prepared source in its
 * own streamed maintenance transaction.
 */

/** How long the exclusive phase of one source (or a whole session) is expected to take. */
export interface LargeMergeDuration {
  /** The engine's estimate, measured while preparing. */
  expectedMs: number;
  /** The range the user is told. */
  minMs: number;
  maxMs: number;
}

/**
 * A source waiting for the large merge session, as the last online batch of this process judged it:
 * its audited size. How long it takes is known only once it was prepared.
 */
export interface LargeMergeWaitingSource {
  candidateId: string;
  rows: number;
  bytes: number;
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
  duration: LargeMergeDuration;
}

/**
 * Sources the preparation settled without the session, as the online batch reports them: already
 * merged or nothing new (merged), refused, deferred. Told like the batch's outcomes, same dedup.
 */
export type LargeMergeSettledReport = Pick<RuntimeDataSetMergeBatchResult, 'merged' | 'deferred' | 'blocked' | 'failures'>;

/**
 * Free space the session needs, as the engine's own check at its start computes it: on the target's
 * disk (the sources' databases, the largest one's WAL peak and a margin), and in the temporary
 * directory (one private copy of the largest source at a time).
 */
export interface LargeMergeSpaceFacts {
  targetDirectory: string;
  targetBytes: number;
  temporaryDirectory: string;
  temporaryBytes: number;
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

export type LargeMergeSourceOutcome =
  | { candidateId: string; state: 'merged'; result: RuntimeDataSetMergeResult }
  /** Rolled back because the session was cancelled while this source ran; a later startup tries it again. */
  | { candidateId: string; state: 'cancelled'; code: string; message: string }
  /** Not started (cancelled or out of disk space before it) or stopped by something other than the source. */
  | { candidateId: string; state: 'deferred'; code: string; message: string }
  | { candidateId: string; state: 'blocked' | 'failed'; code: string; message: string };

export interface LargeMergeEngine {
  /** Sources the last online batch of this process left to the session, with their audited size. */
  waiting(paths: { globalStoragePath: string }): Promise<LargeMergeWaitingSource[]>;
  /** An online batch's outcome: which sources wait for the session now, and which no longer do. */
  noteBatch(paths: { globalStoragePath: string }, report: RuntimeDataSetMergeBatchResult): void;
  /** Online, while this window keeps working. */
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

  async prepare(input) {
    const prepared = await prepareLargeMergeSources({
      paths: input.paths,
      target: { configurationRootPath: input.target.configurationRootPath, database: input.target.database },
      candidateIds: input.candidateIds,
      requested: input.requested,
      // The session takes every source above the online bound the batch left to it, not only the largest.
      threshold: 'online',
      ...(input.signal ? { signal: input.signal } : {}),
      onProgress: (progress) => input.onProgress?.(describePreparation(progress))
    });
    const labels = await sourceLabels(input.paths, prepared.sources.map((source) => source.candidateId));
    const { merged, deferred, blocked, failures } = prepared.report;
    return {
      sources: prepared.sources.map((source) => ({
        candidateId: source.candidateId,
        // A foreign history root is no local candidate: the engine names it (PreparedLargeMergeSource.label).
        ...(labels.has(source.candidateId) ? { label: labels.get(source.candidateId)! } : source.label ? { label: source.label } : {}),
        runtimeDataRootPath: source.runtimeDataRootPath,
        fingerprint: source.fingerprint,
        rows: source.rows,
        databaseBytes: source.databaseBytes,
        duration: { expectedMs: source.estimateMs, minMs: source.estimateRangeMs[0], maxMs: source.estimateRangeMs[1] }
      })),
      report: {
        merged: [...merged],
        // Not above the online bound after all (it shrank): the next online batch merges it.
        deferred: [...deferred, ...prepared.small.map((candidateId) => ({
          candidateId, code: 'runtime-data-set-merge-large-session-small', newly: true, ...(input.requested ? { requested: true } : {}),
          message: '这份旧聊天记录不需要所有窗口暂停，下次启动时会在后台直接合并。'
        }))],
        blocked: [...blocked],
        failures: [...failures]
      },
      space: {
        targetDirectory: prepared.space.targetDirectory, targetBytes: prepared.space.targetBytes,
        temporaryDirectory: prepared.space.temporaryDirectory, temporaryBytes: prepared.space.temporaryBytes
      },
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
    return session.results.map(largeMergeSourceOutcome);
  }
});

/**
 * One source's result of the engine's session as the session reports it: nothing new counts as
 * merged (alreadyMerged); the source a cancel rolled back is 'cancelled'; a source that never
 * started (after a cancel, or after the disk filled up) is deferred with why. Exported for tests.
 */
export function largeMergeSourceOutcome(result: LargeMergeSourceResult): LargeMergeSourceOutcome {
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
          message: '合并中途取消了，这一份还没有开始，以后启动时会再合并。'
        }
        : {
          candidateId: result.candidateId, state: 'deferred', code: 'runtime-data-set-merge-disk-full',
          message: '前一份合并时磁盘空间不足，这一份没有开始；腾出空间后会再合并。'
        };
    case 'deferred':
      if (result.issue.code === RUNTIME_DATA_SET_MERGE_CANCELLED) {
        return {
          candidateId: result.candidateId, state: 'cancelled', code: result.issue.code,
          message: '合并时取消了，这一份已撤回，以后启动时会再合并。'
        };
      }
      return { candidateId: result.candidateId, state: 'deferred', code: result.issue.code, message: result.issue.message };
    default:
      return { candidateId: result.candidateId, state: result.state, code: result.issue.code, message: result.issue.message };
  }
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
