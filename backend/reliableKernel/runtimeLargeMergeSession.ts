import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { syncDirectoryDurably } from '../capabilities/filesystem/durableDirectorySync';
import { classifyRecordedProcess, ownProcessStartIdentity, type RecordedProcessClassifier } from './runtimeClaimPrimitives';
import type { RuntimeDataSetMergeBatchResult, RuntimeDataSetMergeIssue } from './runtimeDataSetMerge';
import { withRuntimeDataRootAdmission } from './runtimeHostControl';
import type {
  LargeMergeDuration, LargeMergeEstimatedSource, LargeMergePreparedSource, LargeMergeRunProgress, LargeMergeSourceOutcome,
  LargeMergeSpaceFacts
} from './runtimeLargeMergeEngine';
import { largeMergeDiskNeeds, type LargeMergeDiskNeed, type LargeMergeDiskProbe } from './runtimeDataSetLargeMergeSpace';
import { resolveVscodeRuntimeMergeLedgerRoot } from './vscodeRootAuthority';

/**
 * The large merge session (vscode/commands/largeHistoricalMerge.ts) apart from VS Code: its bounds,
 * the coordination key, the disk space it needs, the one-window prompt record, the progress
 * throttle and wording, and the result a window keeps across its reload.
 */
export const LARGE_MERGE_SESSION = Object.freeze({
  /** The startup prompt counts down this long; its “取消” moves the session to the next startup. */
  countdownSeconds: 60,
  /** The requesting window's progress notification changes at most this often. */
  progressIntervalMs: 500,
  /** Windows waiting to open repaint only when the source changes or the progress grew by this much. */
  stageStepPercent: 5,
  /**
   * Free space kept beyond the private copy on a temporary directory of its own disk (the engine's
   * figure for the target's disk has the same margin in it).
   */
  freeSpaceMarginBytes: 64 * 1024 * 1024,
  /** A result kept across the requesting window's reload is shown when the window opened again within this. */
  resultTtlMs: 10 * 60_000
});

// ---------------------------------------------------------------------------------------------
// Coordination key
// ---------------------------------------------------------------------------------------------

/**
 * The work of one session: the target's identity and each source's content fingerprint. The same
 * sources asked for by two windows are the same work (the later request gives way at once); a
 * changed source is new work, never held back by the backoff of the earlier state. The estimate
 * gives the fingerprint the preparation gives the same files: the key asked before the countdown is
 * the one the coordination uses unless the preparation changed a source (closed its unfinished work).
 */
export function largeMergeOperationKey(
  target: { dataSetId: string; rootInstanceId: string },
  sources: ReadonlyArray<Pick<LargeMergePreparedSource | LargeMergeEstimatedSource, 'candidateId' | 'fingerprint'>>
): string {
  const parts = sources.map((source) => `${source.candidateId}@${source.fingerprint}`).sort();
  const digest = createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
  return `large-merge:${target.dataSetId}/${target.rootInstanceId}#${digest}`;
}

// ---------------------------------------------------------------------------------------------
// Disk space
// ---------------------------------------------------------------------------------------------

export type { LargeMergeDiskNeed, LargeMergeDiskProbe } from './runtimeDataSetLargeMergeSpace';

export type LargeMergeDiskProber = (directory: string) => Promise<LargeMergeDiskProbe>;

export interface LargeMergeSpacePlan {
  ok: boolean;
  disks: LargeMergeDiskNeed[];
}

/**
 * Space per disk for the session, checked before the prompt or the confirmation with the estimate's
 * figures (the preparation's target backup and copied content included), before the coordination
 * and again (fs.statfs) right before the exclusive phase closes this window's Runtime with the
 * figures the engine's own check at the session's start uses (the preparation's). The grouping is
 * the engine's (largeMergeDiskNeeds, also what a batch checks before sources wait for a session):
 * the target's disk needs targetBytes (its margin included), the temporary directory one private
 * copy of the largest source and SQLite's temporary directory its temporary files, plus
 * LARGE_MERGE_SESSION.freeSpaceMarginBytes once on a disk the target's is not. A disk used for
 * several is checked once for their sum.
 */
export async function planLargeMergeSpace(
  facts: LargeMergeSpaceFacts,
  probe: LargeMergeDiskProber = probeLargeMergeDisk
): Promise<LargeMergeSpacePlan> {
  const disks = largeMergeDiskNeeds(facts, {
    target: await probe(facts.targetDirectory),
    temporary: await probe(facts.temporaryDirectory),
    sqliteTemporary: await probe(facts.sqliteTemporaryDirectory)
  }, LARGE_MERGE_SESSION.freeSpaceMarginBytes);
  return { ok: disks.every((disk) => disk.missingBytes === 0), disks };
}

/** “当前历史库所在的盘（…）剩余空间不足：需要约 3.5 GB，现在可用 2.1 GB，还差约 1.4 GB”, per short disk. */
export function describeLargeMergeSpaceShortage(plan: LargeMergeSpacePlan): string {
  return plan.disks.filter((disk) => disk.missingBytes > 0).map((disk) =>
    `${disk.label}（${disk.path}）剩余空间不足：需要约 ${formatLargeMergeBytes(disk.requiredBytes)}，`
    + `现在可用 ${formatLargeMergeBytes(disk.freeBytes ?? 0)}，还差约 ${formatLargeMergeBytes(disk.missingBytes)}`).join('；');
}

/** fs.stat and fs.statfs of the directory, or of its nearest existing ancestor. */
export async function probeLargeMergeDisk(directory: string): Promise<LargeMergeDiskProbe> {
  let current = path.resolve(directory);
  for (;;) {
    const info = await fs.stat(current).catch(() => undefined);
    if (info) {
      const stats = await fs.statfs(current).catch(() => undefined);
      return { device: info.dev, ...(stats ? { freeBytes: Number(stats.bavail) * Number(stats.bsize) } : {}) };
    }
    const parent = path.dirname(current);
    if (parent === current) return {};
    current = parent;
  }
}

export function formatLargeMergeBytes(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GB`;
  return `${Math.max(1, Math.ceil(mib))} MB`;
}

// ---------------------------------------------------------------------------------------------
// One prompt per configuration root and session
// ---------------------------------------------------------------------------------------------

const PROMPT_KIND = 'limcode-large-merge-session-prompt';
const PROMPTS_DIRECTORY = 'prompts';
const PROMPT_FILE = 'large-merge-session.json';

interface LargeMergePromptRecord {
  kind: typeof PROMPT_KIND;
  sessionId: string;
  processId: number;
  processStartIdentity?: string;
  hostBootId?: string;
  claimedAt: string;
}

/**
 * The prompt record: which window (process) of which VS Code session offers the large merge
 * session. It lives in the configuration root beside the merge ledger, is advisory only and is
 * never a merge fact (a cancel writes nothing to the ledger).
 */
export function largeMergePromptPath(paths: { globalStoragePath: string }): string {
  return path.join(resolveVscodeRuntimeMergeLedgerRoot(paths), PROMPTS_DIRECTORY, PROMPT_FILE);
}

/**
 * Whether this window offers the session now. Under the configuration admission: not when this
 * VS Code session (vscode.env.sessionId) already offered it, nor while another window whose process
 * is alive holds the record (it estimates, prompts, prepares or was told “取消” and keeps that until
 * the next startup); otherwise this window takes the record. Several windows starting together
 * therefore estimate and prompt once.
 */
export async function claimLargeMergePrompt(
  paths: { globalStoragePath: string },
  input: { sessionId: string; hostBootId?: string; processId?: number; classify?: RecordedProcessClassifier }
): Promise<boolean> {
  const processId = input.processId ?? process.pid;
  const identity = processId === process.pid ? ownProcessStartIdentity() : undefined;
  const sessionId = input.sessionId || input.hostBootId || `process-${processId}`;
  return withRuntimeDataRootAdmission(paths.globalStoragePath, async () => {
    const file = largeMergePromptPath(paths);
    const record = await readPromptRecord(file);
    if (record) {
      if (record.sessionId === sessionId) return false;
      const own = record.processId === processId && (record.processStartIdentity ?? '') === (identity ?? '');
      if (!own && (input.classify ?? classifyRecordedProcess)(record.processId, record.processStartIdentity) !== 'dead') return false;
    }
    const next: LargeMergePromptRecord = {
      kind: PROMPT_KIND, sessionId, processId,
      ...(identity !== undefined ? { processStartIdentity: identity } : {}),
      ...(input.hostBootId !== undefined ? { hostBootId: input.hostBootId } : {}),
      claimedAt: new Date().toISOString()
    };
    await writeJsonDurably(file, next);
    return true;
  });
}

async function readPromptRecord(file: string): Promise<LargeMergePromptRecord | undefined> {
  let value: Partial<LargeMergePromptRecord>;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<LargeMergePromptRecord>; }
  catch { return undefined; }
  if (value.kind !== PROMPT_KIND || typeof value.sessionId !== 'string' || !Number.isSafeInteger(value.processId)
    || (value.processStartIdentity !== undefined && typeof value.processStartIdentity !== 'string')) return undefined;
  return value as LargeMergePromptRecord;
}

async function writeJsonDurably(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  await syncDirectoryDurably(path.dirname(file));
}

// ---------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------

export interface LargeMergeThrottleClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_CLOCK: LargeMergeThrottleClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export interface LargeMergeThrottle<T> {
  /** Shown at once when the last one is older than the interval, else the latest is shown when it is up. */
  push(value: T): void;
  /** Stops: a value still waiting is dropped. */
  stop(): void;
}

/** At most one emit per interval, always ending with the latest value. */
export function createLargeMergeThrottle<T>(
  emit: (value: T) => void,
  intervalMs: number = LARGE_MERGE_SESSION.progressIntervalMs,
  clock: LargeMergeThrottleClock = SYSTEM_CLOCK
): LargeMergeThrottle<T> {
  let last = Number.NEGATIVE_INFINITY;
  let pending: { value: T } | undefined;
  let timer: unknown;
  let stopped = false;
  const fire = (): void => {
    timer = undefined;
    if (stopped || !pending) return;
    const { value } = pending;
    pending = undefined;
    last = clock.now();
    emit(value);
  };
  return {
    push(value) {
      if (stopped) return;
      pending = { value };
      if (timer !== undefined) return;
      const wait = last + intervalMs - clock.now();
      if (wait <= 0) fire();
      else timer = clock.setTimeout(fire, wait);
    },
    stop() {
      stopped = true;
      pending = undefined;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    }
  };
}

/**
 * The stage windows waiting to open show (reportStage), “第 2/4 份，已完成 35%”: the percentage of
 * all rows, in steps of stageStepPercent, so their opening shell repaints only when the source
 * changes or the progress grew by a step.
 */
export function largeMergeStage(progress: LargeMergeRunProgress, stepPercent: number = LARGE_MERGE_SESSION.stageStepPercent): string {
  const share = progress.rowsTotal > 0 ? Math.min(1, Math.max(0, progress.rowsDone / progress.rowsTotal)) : 0;
  const percent = Math.floor((share * 100) / stepPercent) * stepPercent;
  return `第 ${progress.index + 1}/${progress.total} 份，已完成 ${percent}%`;
}

/**
 * How long the rest takes when an engine did not say: the preparation's estimate while few rows
 * were handled (under 5% or in the first 10 seconds), then by the rate so far. The streamed engine
 * always says (LargeMergeSessionClock: the preparation's estimates until its rows streamed for a
 * second, then the rate of streaming alone, so its fixed parts do not inflate the rest).
 */
export function estimateLargeMergeRemainingMs(input: {
  elapsedMs: number; rowsDone: number; rowsTotal: number; expectedMs: number;
}): number {
  const { elapsedMs, rowsDone, rowsTotal, expectedMs } = input;
  const left = Math.max(0, rowsTotal - rowsDone);
  if (rowsDone <= 0 || rowsDone < rowsTotal * 0.05 || elapsedMs < 10_000) return Math.max(0, expectedMs - elapsedMs);
  return (elapsedMs * left) / rowsDone;
}

/**
 * “正在合并较大的旧聊天记录 2/4（已处理 12 万 / 38 万条，约还需 3 分钟）”: rows the engine compared
 * and wrote or found present already, not only the ones written.
 */
export function largeMergeProgressMessage(progress: LargeMergeRunProgress, remainingMs: number): string {
  return `正在合并较大的旧聊天记录 ${progress.index + 1}/${progress.total}`
    + `（已处理 ${formatLargeMergeRows(progress.rowsDone)} / ${formatLargeMergeRowsWithUnit(progress.rowsTotal)}，约还需${remainingMs < 60_000 ? '' : ' '}${formatLargeMergeRemaining(remainingMs)}）`;
}

/** A source (or several) waiting for the session, before it was estimated: its size, never a made-up duration. */
export function largeMergeWaitingText(rows: number): string {
  return `约 ${formatLargeMergeRowsWithUnit(rows)}记录，开始前给出预计时长`;
}

/** “12 万”, “8000”. */
export function formatLargeMergeRows(rows: number): string {
  if (rows < 10_000) return String(Math.max(0, Math.round(rows)));
  const tenThousands = rows / 10_000;
  return `${tenThousands < 100 ? Number(tenThousands.toFixed(1)) : Math.round(tenThousands)} 万`;
}

/** “38 万条”, “8000 条”. */
export function formatLargeMergeRowsWithUnit(rows: number): string {
  const text = formatLargeMergeRows(rows);
  return text.endsWith('万') ? `${text}条` : `${text} 条`;
}

export function formatLargeMergeRemaining(ms: number): string {
  return ms < 60_000 ? '不到 1 分钟' : `${Math.ceil(ms / 60_000)} 分钟`;
}

export function sumLargeMergeDurations(durations: readonly LargeMergeDuration[]): LargeMergeDuration {
  return durations.reduce((sum, item) => ({
    expectedMs: sum.expectedMs + item.expectedMs, minMs: sum.minMs + item.minMs, maxMs: sum.maxMs + item.maxMs
  }), { expectedMs: 0, minMs: 0, maxMs: 0 });
}

/** “3–6 分钟”, or “约 3 分钟” when both ends round alike. */
export function formatLargeMergeRange(duration: Pick<LargeMergeDuration, 'minMs' | 'maxMs'>): string {
  const low = Math.max(1, Math.floor(duration.minMs / 60_000));
  const high = Math.max(low, Math.ceil(duration.maxMs / 60_000));
  return low === high ? `约 ${low} 分钟` : `${low}–${high} 分钟`;
}

/** “约 3–6 分钟”, “约 3 分钟” when both ends round alike, “不到 1 分钟” when even the longest is shorter. */
export function formatLargeMergeAbout(duration: Pick<LargeMergeDuration, 'minMs' | 'maxMs'>): string {
  if (duration.maxMs < 60_000) return '不到 1 分钟';
  const range = formatLargeMergeRange(duration);
  return range.startsWith('约 ') ? range : `约 ${range}`;
}

/** The whole minutes of an estimate, at least 1 (“约 N 分钟”). */
export function largeMergeMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/**
 * The startup prompt, with the seconds left: the size, how long the background preparation after
 * the countdown takes (every window stays usable), and how long every window then pauses.
 */
export function largeMergeCountdownText(input: {
  seconds: number; sources: number; rows: number; preparing: LargeMergeDuration; duration: LargeMergeDuration;
}): string {
  return `将在 ${input.seconds} 秒后合并 ${input.sources} 份较大的旧聊天记录（约 ${formatLargeMergeRowsWithUnit(input.rows)}）。`
    + `倒计时结束后先在后台准备${formatLargeMergeAbout(input.preparing)}（期间照常可用），准备好后所有 LimCode 窗口重载一次，`
    + `暂停${formatLargeMergeAbout(input.duration)}（显示进度，完成后自动恢复，未发送的输入会保留）。点“取消”改到下次启动。`;
}

// ---------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------

/**
 * The session's per-source outcomes as an online batch reports them, so they are told with the
 * same wording and startup-notice dedup. A cancel the user just pressed is always told.
 */
export function largeMergeBatchResult(outcomes: readonly LargeMergeSourceOutcome[], requested: boolean): RuntimeDataSetMergeBatchResult {
  const report: RuntimeDataSetMergeBatchResult = {
    merged: [], deferred: [], blocked: [], failures: [], pendingSources: outcomes.length, stopped: false
  };
  for (const outcome of outcomes) {
    if (outcome.state === 'merged') {
      report.merged.push({ ...outcome.result, exclusive: true });
      continue;
    }
    const issue: RuntimeDataSetMergeIssue = {
      candidateId: outcome.candidateId, code: outcome.code, message: outcome.message, newly: true,
      ...(requested || outcome.state === 'cancelled' ? { requested: true } : {}),
      // A foreign history root is named by its readable name in the reasons, not by its id.
      ...(outcome.label ? { label: outcome.label } : {})
    };
    (outcome.state === 'blocked' ? report.blocked : outcome.state === 'failed' ? report.failures : report.deferred).push(issue);
  }
  return report;
}

/**
 * One line per prepared source for “查看详情”: how many conversations it added, or why not. Named as
 * the candidate list names it (label), with where it is and its size; the id only when unnamed.
 */
export function largeMergeDetails(
  sources: ReadonlyArray<Pick<LargeMergePreparedSource, 'candidateId' | 'label' | 'runtimeDataRootPath' | 'rows'>>,
  outcomes: readonly LargeMergeSourceOutcome[]
): string[] {
  return sources.map((source) => {
    const outcome = outcomes.find((item) => item.candidateId === source.candidateId);
    const where = source.runtimeDataRootPath ? `${source.runtimeDataRootPath}，` : '';
    const name = `${source.label ?? source.candidateId}（${where}约 ${formatLargeMergeRowsWithUnit(source.rows)}记录）`;
    if (!outcome) return `${name}：这次没有合并，以后启动时会再合并。`;
    if (outcome.state === 'merged' && outcome.result.alreadyMerged) return `${name}：已合并到当前历史库，没有新内容。`;
    if (outcome.state === 'merged') {
      const { insertedConversations, skippedConversations } = outcome.result;
      return `${name}：新增 ${insertedConversations} 个对话`
        + (skippedConversations ? `，另有 ${skippedConversations} 个在当前库删除过的对话没有再合并` : '') + '。';
    }
    return `${name}：没有合并，${outcome.message.replace(/[。．.]+$/u, '')}。`;
  });
}

/** The part of VS Code's Memento a kept result uses (the requesting window's workspaceState). */
export interface LargeMergeResultState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

const RESULT_KEY = 'limcode.largeHistoricalMerge.result';
const RESULT_KIND = 'limcode-large-merge-session-result';

/** What the requesting window tells once it opened again after the session's reload. */
export interface LargeMergeKeptResult {
  configurationRootPath: string;
  requested: boolean;
  report?: RuntimeDataSetMergeBatchResult;
  details: string[];
  /** The session ended with an unexpected error after this window's Runtime closed. */
  error?: string;
  /** Nothing was merged because the engine's check at the session's start found too little disk space. */
  notStarted?: string;
}

export async function keepLargeMergeResult(state: LargeMergeResultState, result: LargeMergeKeptResult, now: number = Date.now()): Promise<void> {
  await state.update(RESULT_KEY, { kind: RESULT_KIND, at: now, ...JSON.parse(JSON.stringify(result)) as LargeMergeKeptResult });
}

/**
 * Read and cleared once after the window opened again. Valid when the window started opening again
 * (`openedAt`, the extension's activation) within resultTtlMs of keeping it: waiting for other
 * windows to open meanwhile does not count.
 */
export function takeLargeMergeResult(state: LargeMergeResultState, openedAt: number = Date.now()): LargeMergeKeptResult | undefined {
  const kept = state.get<Partial<LargeMergeKeptResult> & { kind?: unknown; at?: unknown }>(RESULT_KEY);
  if (!kept) return undefined;
  void Promise.resolve(state.update(RESULT_KEY, undefined)).catch(() => undefined);
  if (kept.kind !== RESULT_KIND || typeof kept.at !== 'number' || openedAt - kept.at > LARGE_MERGE_SESSION.resultTtlMs
    || typeof kept.configurationRootPath !== 'string' || typeof kept.requested !== 'boolean' || !Array.isArray(kept.details)) return undefined;
  return {
    configurationRootPath: kept.configurationRootPath, requested: kept.requested, details: kept.details.filter((line) => typeof line === 'string'),
    ...(kept.report ? { report: kept.report } : {}),
    ...(typeof kept.error === 'string' ? { error: kept.error } : {}),
    ...(typeof kept.notStarted === 'string' ? { notStarted: kept.notStarted } : {})
  };
}
