import { confirmRuntimeHistorySettlement } from './runtimeHistorySettlement';
import { settleHistoricalMergeSourceOffline } from '../../backend/application/reliableKernel/historicalMergeSettlement';
import * as vscode from 'vscode';
import type { RuntimeWriteGate } from '../../backend/application/reliableKernel/runtimeWriteGate';
import type { RootBinding, RuntimeRootPaths } from '../../backend/reliableKernel/contracts';
import type { RuntimeDatabase } from '../../backend/reliableKernel/runtimeDatabase';
import type { RuntimeDataSetMergeBatchResult, RuntimeDataSetMergeIssue } from '../../backend/reliableKernel/runtimeDataSetMerge';
import {
  EXCLUSIVE_MAINTENANCE_DEFAULTS, type ExclusiveMaintenanceBusy, type RuntimeExclusiveMaintenanceOutcome
} from '../../backend/reliableKernel/runtimeExclusiveMaintenance';
import {
  largeMergeEngine, LargeMergePreparationError, type LargeMergeEngine, type LargeMergeEstimate, type LargeMergePreparation, type LargeMergeRunProgress,
  type LargeMergeSettledReport, type LargeMergeSourceOutcome
} from '../../backend/reliableKernel/runtimeLargeMergeEngine';
import {
  claimLargeMergePrompt, createLargeMergeThrottle, describeLargeMergeSpaceShortage, estimateLargeMergeRemainingMs, formatLargeMergeAbout,
  formatLargeMergeRange, formatLargeMergeRowsWithUnit, keepLargeMergeResult, LARGE_MERGE_SESSION, largeMergeBatchResult, largeMergeCountdownText,
  largeMergeDetails, largeMergeOperationKey, largeMergeProgressMessage, largeMergeStage, planLargeMergeSpace, sumLargeMergeDurations,
  type LargeMergeDiskProber, type LargeMergeSpacePlan
} from '../../backend/reliableKernel/runtimeLargeMergeSession';
import { EXTENSION_BRAND } from '../../shared/extensionIdentity';
import type { BridgeClientId, ExtensionToWebviewMessage } from '../../shared/protocol';
import { MainPanel } from '../panels/MainPanel';
import { canStartRuntimeDataSetUpgrade, runRuntimeDataSetUpgrade } from '../runtimeDataSetUpgradeLifetime';
import {
  exclusiveMaintenanceRefusal, holdOwnExclusiveMaintenanceWork, requesterWorkBusy, runWithExclusiveMaintenance, type ExclusiveMaintenanceWindowState
} from '../runtimeExclusiveMaintenance';

/**
 * 大库会话: the sources above the online merge limit that the online batch left to it (those above
 * the in-memory transaction bound, and with them every other one above the online limit), merged
 * with one coordination and one reload of every window.
 *
 * Nothing is prepared before the user agreed: the engine's read-only estimate (outside every lock)
 * says which sources the session takes, how long their background preparation and the pause of every
 * window take, the space, and each source's fingerprint (the coordination key).
 * Automatic, after the startup batch: one window of the configuration root (prompt record by
 * vscode.env.sessionId) estimates in the background, checks the disk space and whether the
 * coordination of exactly this work would be refused before asking anyone (cooldown, its backoff, a
 * key blocked for automatic calls: then it says when it can be tried again instead), then counts down
 * 60 seconds in a cancellable notification (“取消” only moves it to the next startup: nothing is
 * prepared or recorded). Only when the countdown ran out it prepares (a cancellable notification;
 * the window stays usable). Manual, from 历史与存储管理: the cooldown checked, estimated, and a modal
 * confirmation with both durations before it prepares. Then both ask every window to yield
 * (runWithExclusiveMaintenance, historical-merge, keyed by the target and the sources' fingerprints;
 * waiting for busy windows outside the locks as a migration does), and in the exclusive phase this
 * window closes its Runtime, merges source after source (a cancel rolls back only the source that
 * runs) and reloads; the outcomes are told once it opened again.
 */

const ACTIVITY = '合并较大的旧聊天记录';
const OPERATION = 'historical-merge';
/** The engine's code of a session stopped by too little disk space (at its start, or part way). */
const DISK_FULL = 'runtime-data-set-merge-disk-full';
/** After asking the Webviews to save unsent input, closing the Runtime waits this long for the writes to land. */
const DRAFT_SAVE_SETTLE_MS = 250;
/** Startup-notice cause of the session as a whole (disk space, a coordination that did not happen). */
export const LARGE_MERGE_SESSION_CAUSE = 'large-merge-session';

/** What the session needs of the open Runtime (the reliable-kernel Facade), as the data-directory commands do. */
export interface LargeHistoricalMergeHost {
  product: { application: { database: RuntimeDatabase } };
  hasOwnedExecution(): Promise<boolean>;
  exclusiveMaintenanceTarget(): { paths: RuntimeRootPaths; hostBootId: string };
  /** The configuration root (data directory) of this window. */
  dataRootPath(): string;
  withDataRootLocks<R>(body: () => Promise<R>): Promise<R>;
  /** From beforeGo until the session ended this window refuses write commands (“正在合并较大的旧聊天记录，完成后再操作。”). */
  freezeNewWork(activity: string): () => void;
  closeRuntime(): Promise<void>;
  postToWebview?(clientId: BridgeClientId, message: ExtensionToWebviewMessage): boolean;
  /** Starting the session is a write: refused while this window is frozen for another exclusive operation. */
  writeGate?: Pick<RuntimeWriteGate, 'admit' | 'frozen'>;
}

export function isLargeHistoricalMergeHost(value: unknown): value is LargeHistoricalMergeHost {
  const host = value as Partial<LargeHistoricalMergeHost> | undefined;
  return typeof host?.withDataRootLocks === 'function' && typeof host.closeRuntime === 'function'
    && typeof host.freezeNewWork === 'function' && typeof host.hasOwnedExecution === 'function'
    && typeof host.exclusiveMaintenanceTarget === 'function' && typeof host.dataRootPath === 'function'
    && host.product?.application?.database !== undefined;
}

export interface LargeHistoricalMergeOptions {
  /** Per-source outcomes, told like the online batch's (runtimeDataSetManagement.reportHistoricalMerge, same dedup). */
  report(batch: RuntimeDataSetMergeBatchResult, requested: boolean, details?: readonly string[]): Promise<void>;
  /** Startup-notice dedup of a cause of the whole session; without it every cause is told. */
  freshCause?(code: string, message: string): Promise<boolean>;
  /** False once the activation ended or the data directory changed. */
  isCurrent?(): boolean;
  engine?: LargeMergeEngine;
  /** This window's workspaceState: the coordination's requester token and the result kept across the reload. */
  windowState?: ExclusiveMaintenanceWindowState;
  /** Asks this window's Webviews to write unsent input at once; returns how many were asked. */
  saveDrafts?(): number;
  /** Defaults to vscode.env.sessionId. */
  sessionId?: string;
  probeDisk?: LargeMergeDiskProber;
  /** Defaults to LARGE_MERGE_SESSION.countdownSeconds. */
  countdownSeconds?: number;
  /** Tests: the coordination's bounds and poll interval. */
  coordination?: {
    pollMs?: number; prepareTimeoutMs?: number; busyWaitTimeoutMs?: number; confirmTimeoutMs?: number; releaseTimeoutMs?: number;
  };
}

/** One session per window: the startup prompt and the manual entry never run side by side. */
let sessionRunning = false;

/**
 * After the startup batch: offers the session for these sources in one window. Never throws; a
 * cause of the whole session (estimate, disk space, preparation, coordination) is told once per cause.
 */
export async function offerLargeHistoricalMerge(
  context: vscode.ExtensionContext,
  host: LargeHistoricalMergeHost,
  candidateIds: readonly string[],
  options: LargeHistoricalMergeOptions
): Promise<void> {
  const stillCurrent = currentCheck(context, options);
  // A window frozen for another exclusive operation (a migration) reloads afterwards: next startup.
  if (candidateIds.length === 0 || sessionRunning || !stillCurrent() || host.writeGate?.frozen) return;
  sessionRunning = true;
  const engine = options.engine ?? largeMergeEngine();
  let preparation: LargeMergePreparation | undefined;
  let releaseHold: (() => void) | undefined;
  try {
    const paths = { globalStoragePath: host.dataRootPath() };
    const { hostBootId } = host.exclusiveMaintenanceTarget();
    // Only one window of this configuration root estimates and prompts, once per VS Code session.
    if (!await claimLargeMergePrompt(paths, { sessionId: options.sessionId ?? vscode.env.sessionId, hostBootId })) return;
    // Held off by the cooldown after another coordination: not even estimated now.
    if (await refusedBeforeAsking(host, options, stillCurrent)) return;
    let estimated: LargeMergeEstimate | undefined;
    try {
      estimated = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `正在估计${ACTIVITY}需要多久` },
        (progress) => estimate(context, host, engine, candidateIds, false, stillCurrent, (message) => progress?.report({ message })));
    } catch (error) {
      console.error(`[LimCode] ${ACTIVITY}的估计没有完成。`, error);
      const message = `${ACTIVITY}暂时无法估计：${describeError(error)}。已有数据未被修改，下次启动时会再试。`;
      if (await fresh(options, 'runtime-data-set-merge-large-session-estimate', message) && stillCurrent()) void vscode.window.showWarningMessage(message);
      return;
    }
    if (!estimated || !stillCurrent()) return;
    await tellSettled(options, estimated.report, false, estimated.sources.length);
    if (estimated.sources.length === 0) return;
    // Not enough room for the preparation and the session: no prompt, only how much is missing.
    const space = await planLargeMergeSpace(estimated.space, options.probeDisk);
    if (!space.ok) {
      const message = shortageText(estimated.sources.length, space);
      if (await fresh(options, 'runtime-data-set-merge-large-session-disk-full', message) && stillCurrent()) {
        void vscode.window.showWarningMessage(`${message}腾出空间后，下次启动时会再提示；也可以在“历史与存储管理”里手动开始。`);
      }
      return;
    }
    // The coordination of exactly this work would be refused before asking anyone (cooldown, its
    // backoff, a key blocked for automatic calls): no countdown that ends in “没有合并”; when it can
    // be tried again is said instead. The estimate's fingerprints are the preparation's: its key.
    const operationKey = largeMergeOperationKey(host.product.application.database.binding, estimated.sources);
    if (await refusedBeforeAsking(host, options, stillCurrent, operationKey)) return;
    const answer = await countdown(estimated, options.countdownSeconds ?? LARGE_MERGE_SESSION.countdownSeconds, stillCurrent);
    if (answer === 'cancelled') {
      // Only moved to the next startup: nothing prepared or recorded, and there is no “never”.
      postponed();
      return;
    }
    if (answer !== 'go' || !stillCurrent() || host.writeGate?.frozen) return;
    // Agreed: from here until the session ended no other window's maintenance reloads this one.
    releaseHold = holdOwnExclusiveMaintenanceWork(host, { operation: OPERATION, activity: ACTIVITY });
    // Only now is anything prepared (unfinished work closed, target backed up, content published, claims kept).
    const sources = estimated.sources.map((source) => source.candidateId);
    try {
      preparation = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: `正在准备${ACTIVITY}（窗口照常可用）`, cancellable: true
      }, (progress, token) => prepare(context, host, engine, sources, false, stillCurrent, (message) => progress?.report({ message }), token));
    } catch (error) {
      console.error(`[LimCode] ${ACTIVITY}的准备没有完成。`, error);
      const message = `${ACTIVITY}暂时无法准备：${describeError(error)}。${preparationDataNote(error)}，下次启动时会再试。`;
      if (await fresh(options, 'runtime-data-set-merge-large-session-prepare', message) && stillCurrent()) void vscode.window.showWarningMessage(message);
      return;
    }
    if (!preparation) {
      // “取消” while preparing (what was prepared is let go of): moved to the next startup as the countdown's.
      if (stillCurrent()) postponed();
      return;
    }
    if (!stillCurrent()) return;
    await tellSettled(options, preparation.report, false, preparation.sources.length);
    if (preparation.sources.length === 0) return;
    await runSession(context, host, engine, preparation, { requested: false, options, stillCurrent });
  } catch (error) {
    console.error(`[LimCode] ${ACTIVITY}失败。`, error);
  } finally {
    // Whatever did not run lets go of what the engine kept for it (nothing after a run).
    if (preparation) await release(engine, preparation);
    releaseHold?.();
    sessionRunning = false;
  }
}

/**
 * 历史与存储管理 → 合并较大的旧聊天记录 (also after the user asked to merge one such source):
 * estimated read-only (a cancellable notification), confirmed in a modal with the estimate's size and
 * both durations, only then prepared (a cancellable notification), then coordinated as the user's
 * explicit call (ignoreBackoff; other windows only see a notice). A write: refused while this window
 * is frozen for another exclusive operation.
 */
export async function startLargeHistoricalMerge(
  context: vscode.ExtensionContext,
  host: LargeHistoricalMergeHost,
  options: LargeHistoricalMergeOptions & { candidateIds?: readonly string[] }
): Promise<void> {
  try { host.writeGate?.admit(); }
  catch (error) {
    await vscode.window.showWarningMessage(`${describeError(error)}。没有开始${ACTIVITY}。`);
    return;
  }
  if (sessionRunning) {
    await vscode.window.showInformationMessage(`本窗口已经在准备或进行${ACTIVITY}，请等它结束。`);
    return;
  }
  const stillCurrent = currentCheck(context, options);
  const engine = options.engine ?? largeMergeEngine();
  const paths = { globalStoragePath: host.dataRootPath() };
  sessionRunning = true;
  let preparation: LargeMergePreparation | undefined;
  let releaseHold: (() => void) | undefined;
  try {
    // Held off by the cooldown after another window's coordination: said now, before anything is estimated, asked or prepared.
    const { paths: targetPaths, hostBootId } = host.exclusiveMaintenanceTarget();
    const windowState = options.windowState ?? (context as Partial<vscode.ExtensionContext>).workspaceState;
    const refusal = await exclusiveMaintenanceRefusal(targetPaths, {
      operation: OPERATION, ignoreBackoff: true, requesterHostBootId: hostBootId, ...(windowState ? { windowState } : {})
    }).catch(() => undefined);
    if (refusal) {
      await vscode.window.showWarningMessage(`现在不能${ACTIVITY}：${withoutFullStop(refusal.reason)}。已有数据未被修改。`);
      return;
    }
    const waiting = await engine.waiting(paths).catch(() => []);
    const candidateIds = options.candidateIds ?? waiting.map((source) => source.candidateId);
    if (candidateIds.length === 0) {
      await vscode.window.showInformationMessage(`现在没有等待合并的较大的旧聊天记录。`);
      return;
    }
    // Read-only first (nothing prepared before the user agreed): the size, how long preparing and the pause take, the space.
    let estimated: LargeMergeEstimate | undefined;
    try {
      estimated = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: `正在估计${ACTIVITY}需要多久（只读，窗口照常可用）`, cancellable: true
      }, (progress, token) => estimate(context, host, engine, candidateIds, true, stillCurrent,
        (message) => progress?.report({ message }), token));
    } catch (error) {
      console.error(`[LimCode] ${ACTIVITY}的估计没有完成。`, error);
      await vscode.window.showErrorMessage(`${ACTIVITY}没有开始：估计时出错（${describeError(error)}）。已有数据未被修改。`);
      return;
    }
    if (!estimated || !stillCurrent()) return;
    await tellSettled(options, estimated.report, true, estimated.sources.length);
    if (estimated.sources.length === 0) return;
    const space = await planLargeMergeSpace(estimated.space, options.probeDisk);
    if (!space.ok) {
      await vscode.window.showErrorMessage(`${ACTIVITY}没有开始`, {
        modal: true, detail: `${shortageText(estimated.sources.length, space)}腾出空间后可以再试；已有数据未被修改。`
      });
      return;
    }
    if (!await confirm(estimated)) return;
    // Confirmed: from here until the session ended no other window's maintenance reloads this one.
    releaseHold = holdOwnExclusiveMaintenanceWork(host, { operation: OPERATION, activity: ACTIVITY });
    const sources = estimated.sources.map((source) => source.candidateId);
    try {
      preparation = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: `正在准备${ACTIVITY}（窗口照常可用）`, cancellable: true
      }, (progress, token) => prepare(context, host, engine, sources, true, stillCurrent,
        (message) => progress?.report({ message }), token));
    } catch (error) {
      console.error(`[LimCode] ${ACTIVITY}的准备没有完成。`, error);
      await vscode.window.showErrorMessage(`${ACTIVITY}没有开始：准备时出错（${describeError(error)}）。${preparationDataNote(error)}。`);
      return;
    }
    if (!preparation || !stillCurrent()) return;
    await tellSettled(options, preparation.report, true, preparation.sources.length);
    if (preparation.sources.length === 0) return;
    // Frozen meanwhile (another exclusive operation of this window started): refused like any other write.
    try { host.writeGate?.admit(); }
    catch (error) {
      await vscode.window.showWarningMessage(`${describeError(error)}。没有开始${ACTIVITY}。`);
      return;
    }
    await runSession(context, host, engine, preparation, { requested: true, options, stillCurrent });
  } catch (error) {
    console.error(`[LimCode] ${ACTIVITY}失败。`, error);
    await vscode.window.showErrorMessage(`${ACTIVITY}失败：${describeError(error)}。`);
  } finally {
    if (preparation) await release(engine, preparation);
    releaseHold?.();
    sessionRunning = false;
  }
}

/** Explicit convergence uses the existing exclusive coordinator without the retired estimate/countdown flow. */
export async function mergeAllHistoricalSources(
  context: vscode.ExtensionContext, host: LargeHistoricalMergeHost,
  options: LargeHistoricalMergeOptions & { candidateIds: readonly string[] }
): Promise<void> {
  if (sessionRunning) { await vscode.window.showInformationMessage('本窗口已在合并旧数据。'); return; }
  host.writeGate?.admit();
  const stillCurrent = currentCheck(context, options);
  const engine = options.engine ?? largeMergeEngine();
  sessionRunning = true;
  const releaseHold = holdOwnExclusiveMaintenanceWork(host, { operation: OPERATION, activity: '合并全部旧数据' });
  let preparation: LargeMergePreparation | undefined;
  try {
    preparation = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: '正在准备合并全部旧数据', cancellable: true
    }, (progress, token) => prepare(context, host, engine, options.candidateIds, true, stillCurrent,
      message => progress?.report({ message }), token));
    if (!preparation || !stillCurrent()) return;
    await tellSettled(options, preparation.report, true, preparation.sources.length);
    if (!preparation.sources.length) return;
    host.writeGate?.admit();
    await runSession(context, host, engine, preparation, { requested: true, options, stillCurrent });
  } finally {
    if (preparation) await release(engine, preparation);
    releaseHold();
    sessionRunning = false;
  }
}

/**
 * What a failed preparation left of the data: unchanged, unless it had closed some source's
 * unfinished work already (LargeMergePreparationError.finalizedSources).
 */
function preparationDataNote(error: unknown): string {
  const finalized = error instanceof LargeMergePreparationError ? error.finalizedSources : 0;
  return finalized > 0
    ? `准备时已有 ${finalized} 份旧聊天记录里中断的任务按“中止”收尾、排队未发送的消息被取消（都不会在当前库继续执行），其余数据未被修改`
    : '已有数据未被修改';
}

function currentCheck(context: vscode.ExtensionContext, options: LargeHistoricalMergeOptions): () => boolean {
  return () => canStartRuntimeDataSetUpgrade(context) && options.isCurrent?.() !== false;
}

async function fresh(options: LargeHistoricalMergeOptions, code: string, message: string): Promise<boolean> {
  if (!options.freshCause) return true;
  return options.freshCause(code, message).catch(() => true);
}

/**
 * Read-only and outside every lock (a foreign root's claim is taken for the read only); stopped when
 * the window closes (or the user cancels a manual one). Nothing to let go of afterwards.
 */
async function estimate(
  context: vscode.ExtensionContext,
  host: LargeHistoricalMergeHost,
  engine: LargeMergeEngine,
  candidateIds: readonly string[],
  requested: boolean,
  stillCurrent: () => boolean,
  onProgress: (message: string) => void,
  token?: vscode.CancellationToken
): Promise<LargeMergeEstimate | undefined> {
  const abort = new AbortController();
  const cancellation = token?.onCancellationRequested?.(() => abort.abort());
  const watch = setInterval(() => { if (!stillCurrent()) abort.abort(); }, LARGE_MERGE_SESSION.progressIntervalMs);
  try {
    const estimated = await runRuntimeDataSetUpgrade(context, () => engine.estimate({
      paths: { globalStoragePath: host.dataRootPath() },
      target: { configurationRootPath: host.dataRootPath(), database: host.product.application.database },
      candidateIds, requested, signal: abort.signal, onProgress
    }));
    // Stopped part way: nothing of it is offered.
    return abort.signal.aborted || estimated.stopped ? undefined : estimated;
  } catch (error) {
    if (abort.signal.aborted) return undefined;
    throw error;
  } finally {
    clearInterval(watch);
    cancellation?.dispose?.();
  }
}

/** Online and without claims; stopped when the window closes (or the user cancels a manual one). */
async function prepare(
  context: vscode.ExtensionContext,
  host: LargeHistoricalMergeHost,
  engine: LargeMergeEngine,
  candidateIds: readonly string[],
  requested: boolean,
  stillCurrent: () => boolean,
  onProgress: (message: string) => void,
  token?: vscode.CancellationToken
): Promise<LargeMergePreparation | undefined> {
  const abort = new AbortController();
  const cancellation = token?.onCancellationRequested?.(() => abort.abort());
  const watch = setInterval(() => { if (!stillCurrent()) abort.abort(); }, LARGE_MERGE_SESSION.progressIntervalMs);
  try {
    const prepared = await runRuntimeDataSetUpgrade(context, () => engine.prepare({
      paths: { globalStoragePath: host.dataRootPath() },
      target: { configurationRootPath: host.dataRootPath(), database: host.product.application.database },
      settleSourceWork: settleHistoricalMergeSourceOffline,
      confirmSettlement: input => confirmRuntimeHistorySettlement(input, stillCurrent),
      candidateIds, requested, signal: abort.signal, onProgress
    }));
    // Stopped part way (“取消”, or the window closing): what was prepared so far is let go of.
    if (abort.signal.aborted) {
      await release(engine, prepared);
      return undefined;
    }
    return prepared;
  } catch (error) {
    if (abort.signal.aborted) return undefined;
    throw error;
  } finally {
    clearInterval(watch);
    cancellation?.dispose?.();
  }
}

/**
 * What the estimate or the preparation settled without the session, told like the online batch's
 * outcomes. Nothing settled while sources go on to the session: nothing to tell yet (the batch would
 * answer the user's click with “这次没有合并”); nothing settled and nothing left: the click hears that.
 */
async function tellSettled(
  options: LargeHistoricalMergeOptions,
  report: LargeMergeSettledReport,
  requested: boolean,
  sourcesLeft: number
): Promise<void> {
  const mark = (issues: readonly RuntimeDataSetMergeIssue[]): RuntimeDataSetMergeIssue[] =>
    issues.map((issue) => (requested ? { ...issue, requested: true } : { ...issue }));
  const { merged, deferred, blocked, failures } = report;
  if (sourcesLeft > 0 && merged.length + deferred.length + blocked.length + failures.length === 0) return;
  await options.report({
    merged: [...merged], deferred: mark(deferred), blocked: mark(blocked), failures: mark(failures), pendingSources: 0, stopped: false
  }, requested);
}

/**
 * The automatic session: would its coordination be refused before any window is asked (the cooldown
 * after another coordination, asked before estimating; with the key the estimate's fingerprints make,
 * asked before the countdown, also this work's backoff or a key blocked for automatic calls)? Then
 * it is told once per cause, with when it can be tried again, and nothing goes on.
 */
async function refusedBeforeAsking(
  host: LargeHistoricalMergeHost,
  options: LargeHistoricalMergeOptions,
  stillCurrent: () => boolean,
  operationKey?: string
): Promise<boolean> {
  const { paths, hostBootId } = host.exclusiveMaintenanceTarget();
  const refusal = await exclusiveMaintenanceRefusal(paths, {
    operation: OPERATION, ...(operationKey !== undefined ? { operationKey } : {}), ignoreBackoff: false, requesterHostBootId: hostBootId
  }).catch(() => undefined);
  if (!refusal) return false;
  await tellNotRun(options, false, stillCurrent, refusal.state, refusal.reason);
  return true;
}

async function release(engine: LargeMergeEngine, preparation: LargeMergePreparation): Promise<void> {
  try { await engine.release(preparation); }
  catch (error) { console.warn(`[LimCode] 无法释放${ACTIVITY}的准备。`, error); }
}

function shortageText(sources: number, space: LargeMergeSpacePlan): string {
  return `有 ${sources} 份较大的旧聊天记录等待合并，但${describeLargeMergeSpaceShortage(space)}。`;
}

/** The startup prompt or its preparation was cancelled: only moved to the next startup (nothing recorded, no “never”). */
function postponed(): void {
  void vscode.window.showInformationMessage(`已改到下次启动时再${ACTIVITY}；也可以在“历史与存储管理”里手动开始。`);
}

/**
 * The startup prompt with the estimate's size and both durations: “取消” (or the window closing) ends
 * it; otherwise the session is prepared and starts.
 */
async function countdown(
  estimated: LargeMergeEstimate,
  seconds: number,
  stillCurrent: () => boolean
): Promise<'go' | 'cancelled' | 'stopped'> {
  const rows = estimated.sources.reduce((sum, source) => sum + source.rows, 0);
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true }, async (progress, token) => {
    const cancelled = (): boolean => token?.isCancellationRequested === true;
    for (let left = seconds; left > 0; left -= 1) {
      if (cancelled()) return 'cancelled';
      if (!stillCurrent()) return 'stopped';
      progress?.report({
        message: largeMergeCountdownText({
          seconds: left, sources: estimated.sources.length, rows, preparing: estimated.preparing, duration: estimated.duration
        }),
        increment: 100 / seconds
      });
      for (let tick = 0; tick < 4; tick += 1) {
        await delay(250);
        if (cancelled()) return 'cancelled';
      }
    }
    return cancelled() ? 'cancelled' : stillCurrent() ? 'go' : 'stopped';
  });
}

/** Before anything is prepared: the estimate's size, how long preparing takes and how long every window pauses. */
async function confirm(estimated: LargeMergeEstimate): Promise<boolean> {
  const busyMinutes = Math.round(EXCLUSIVE_MAINTENANCE_DEFAULTS.busyWaitTimeoutMs / 60_000);
  const rows = estimated.sources.reduce((sum, source) => sum + source.rows, 0);
  const choice = await vscode.window.showWarningMessage(
    `${ACTIVITY}（${estimated.sources.length} 份，约 ${formatLargeMergeRowsWithUnit(rows)}记录）？`, {
      modal: true,
      detail: `先在后台准备${formatLargeMergeAbout(estimated.preparing)}（窗口照常可用，可以取消），`
        + `再等本窗口和其它 LimCode 窗口的任务结束（最多约 ${busyMinutes} 分钟），`
        + `然后所有 LimCode 窗口重载一次，暂停${formatLargeMergeAbout(estimated.duration)}：`
        + '其它窗口重载并显示进度，本窗口显示合并进度、完成后重载，全部自动恢复，未发送的输入会保留。'
        + '合并时可以点“取消”：只撤回正在合并的那一份，已经合并完的保留，其余的以后启动时再合并。'
        + '\n\n原库保留；原库里中断的任务按“中止”收尾、排队未发送的消息会被取消，都不会在当前库被继续执行；'
        + '在当前库删除过的对话（包括以前合并进来之后删掉的）不会再合并回来。无法自动收尾的工作或数据冲突时那一份整体不合并，并说明原因。'
    }, '开始合并');
  return choice === '开始合并';
}

interface SessionInput {
  requested: boolean;
  options: LargeHistoricalMergeOptions;
  stillCurrent(): boolean;
}

/**
 * The coordinated part, as the data-directory migration does it: wait (outside the locks, at most
 * the busy-wait bound) for this window's and the other windows' work, freeze this window in beforeGo
 * (check first, then only what cannot fail), then run the exclusive phase inside `withLocks`. After
 * go a cancel is ignored; nothing to cancel is shown while windows are asked. This window reloads
 * only when its Runtime was closed.
 */
async function runSession(
  context: vscode.ExtensionContext,
  host: LargeHistoricalMergeHost,
  engine: LargeMergeEngine,
  preparation: LargeMergePreparation,
  input: SessionInput
): Promise<void> {
  const { options, requested, stillCurrent } = input;
  const configurationRootPath = host.dataRootPath();
  const { paths: targetPaths, hostBootId } = host.exclusiveMaintenanceTarget();
  // Read while the Runtime is open (the exclusive phase closes it).
  const binding = host.product.application.database.binding;
  const windowState = options.windowState ?? (context as Partial<vscode.ExtensionContext>).workspaceState;
  const space = await planLargeMergeSpace(preparation.space, options.probeDisk);
  if (!space.ok) {
    await tellNotRun(options, requested, stillCurrent, 'disk-full', shortageText(preparation.sources.length, space));
    return;
  }
  const duration = sumLargeMergeDurations(preparation.sources.map((source) => source.duration));
  const ownWork = requesterWorkBusy(host);
  let announced = false;
  const busyMinutes = Math.round((options.coordination?.busyWaitTimeoutMs ?? EXCLUSIVE_MAINTENANCE_DEFAULTS.busyWaitTimeoutMs) / 60_000);
  const requesterBusy = async (): Promise<ExclusiveMaintenanceBusy | undefined> => {
    const busy = await ownWork();
    if (busy && !announced) {
      announced = true;
      void vscode.window.showInformationMessage(`${EXTENSION_BRAND}：本窗口有任务正在进行，${ACTIVITY}会等它结束后再进行（最多等 ${busyMinutes} 分钟）；在此之前请不要开始新的任务。`);
    }
    return busy;
  };
  const session = { runtimeClosed: false, spaceShort: false };
  let outcome: RuntimeExclusiveMaintenanceOutcome<LargeMergeSourceOutcome[]>;
  try {
    outcome = await runWithExclusiveMaintenance(targetPaths, {
      operation: OPERATION,
      operationKey: largeMergeOperationKey(binding, preparation.sources),
      message: `为${ACTIVITY}`,
      // Prepared by now: how long the merge itself is expected to take.
      waitingTitle: `正在等待 LimCode 窗口空闲后${ACTIVITY}（预计 ${formatLargeMergeRange(duration)}）`,
      configurationRootPath,
      requesterHostBootId: hostBootId,
      requesterBusy,
      beforeGo: async () => {
        // What may throw runs before the freeze and only what cannot after it: the thaw always
        // reaches the primitive (a lost one would leave this window frozen).
        const busy = await ownWork();
        if (busy) return { busy: { ...busy, reason: '本窗口在确认之后开始了新的任务' } };
        // From here until the session ended this window refuses every write command at its entry.
        const thaw = host.freezeNewWork(ACTIVITY);
        const late = await ownWork().then(
          (found) => found && { ...found, reason: '本窗口在确认之后开始了新的任务' },
          (): ExclusiveMaintenanceBusy => ({ kind: 'work', reason: '无法确认本窗口是否空闲' })
        );
        return late ? { busy: late, thaw } : { thaw };
      },
      // The user confirmed here: other windows only see a notice. The startup prompt counted down
      // here: other windows count down without a cancel button (they cannot veto it).
      participantConfirmation: requested ? 'notice' : 'final-countdown',
      whenBusy: 'wait',
      ignoreBackoff: requested,
      // Coordinating: nothing to cancel any more (once go is published other windows reload).
      cancellable: false,
      isCurrent: stillCurrent,
      ...(windowState ? { windowState } : {}),
      ...(options.coordination ?? {}),
      withLocks: (body) => host.withDataRootLocks(body)
    }, ({ reportStage, reportExpectedEnd }) => exclusivePhase(context, host, engine, preparation, {
      configurationRootPath, binding, options, session, reportStage, reportExpectedEnd
    }));
  } catch (error) {
    console.error(`[LimCode] ${ACTIVITY}没有完成。`, error);
    if (!session.runtimeClosed) {
      // Nothing was merged and this window's Runtime is still open (e.g. the disk filled up meanwhile).
      await tellNotRun(options, requested, stillCurrent, session.spaceShort ? 'disk-full' : 'failed', describeError(error));
      return;
    }
    // This window's Runtime is closed: only a reload opens it again; told once it did.
    await keep(windowState, {
      configurationRootPath, requested, details: [],
      error: `${describeError(error)}。已经合并完的会保留，其余的以后启动时会再合并`
    });
    await reloadWindow();
    return;
  }
  if (outcome.state === 'completed') {
    for (const item of outcome.result) console.info(`[LimCode] ${ACTIVITY}：${item.candidateId} ${item.state}`);
    // Too little disk space before anything was merged (the engine's own check, or the first
    // source rolled back): said as such once this window opened again, not as one failure per source.
    const short = outcome.result.every((item) => item.state === 'deferred' && item.code === DISK_FULL) ? outcome.result[0] : undefined;
    if (short && short.state === 'deferred') {
      await keep(windowState, { configurationRootPath, requested, details: [], notStarted: withoutFullStop(short.message) });
      await reloadWindow();
      return;
    }
    await keep(windowState, {
      configurationRootPath, requested,
      report: largeMergeBatchResult(outcome.result, requested),
      details: largeMergeDetails(preparation.sources, outcome.result)
    });
    await reloadWindow();
    return;
  }
  // Another window asked for exactly this work earlier and does it.
  if (outcome.state === 'superseded') {
    if (requested) void vscode.window.showInformationMessage(outcome.reason);
    return;
  }
  await tellNotRun(options, requested, stillCurrent, outcome.state, outcome.reason);
}

interface ExclusivePhaseInput {
  configurationRootPath: string;
  binding: RootBinding;
  options: LargeHistoricalMergeOptions;
  /** runtimeClosed: only a reload opens this window again; spaceShort: the last space check failed. */
  session: { runtimeClosed: boolean; spaceShort: boolean };
  reportStage(stage: string | undefined): void;
  reportExpectedEnd(at: string | undefined): void;
}

/**
 * Inside the locks, every other window offline: space checked once more (fs.statfs), unsent input
 * saved, this window's Runtime closed, then the engine merges source after source. Windows waiting
 * to open see the stage (source and progress in steps of stageStepPercent) and the expected end;
 * this window a progress notification (at most every progressIntervalMs) whose “取消” rolls back
 * only the source that runs.
 */
async function exclusivePhase(
  context: vscode.ExtensionContext,
  host: LargeHistoricalMergeHost,
  engine: LargeMergeEngine,
  preparation: LargeMergePreparation,
  input: ExclusivePhaseInput
): Promise<LargeMergeSourceOutcome[]> {
  const { options, session } = input;
  // The disk may have filled up while windows were asked: checked once more, before anything is closed.
  const space = await planLargeMergeSpace(preparation.space, options.probeDisk);
  if (!space.ok) {
    session.spaceShort = true;
    throw new Error(shortageText(preparation.sources.length, space));
  }
  const saveDrafts = options.saveDrafts ?? (() => MainPanel.saveComposerDrafts((clientId, message) => host.postToWebview?.(clientId, message) ?? false));
  let asked = 0;
  try { asked = saveDrafts(); }
  catch (error) { console.warn('[LimCode] 无法通知面板保存未发送的输入。', error); }
  if (asked > 0) await delay(DRAFT_SAVE_SETTLE_MS);
  input.reportStage('正在关闭发起合并的窗口的运行时');
  session.runtimeClosed = true;
  await host.closeRuntime();
  const duration = sumLargeMergeDurations(preparation.sources.map((source) => source.duration));
  const rowsTotal = preparation.sources.reduce((sum, source) => sum + source.rows, 0);
  const startedAt = Date.now();
  // Windows waiting to open say by when it should be done, and warn only well past that.
  input.reportExpectedEnd(new Date(startedAt + duration.maxMs).toISOString());
  const first: LargeMergeRunProgress = {
    index: 0, total: preparation.sources.length, candidateId: preparation.sources[0]?.candidateId ?? '', rowsDone: 0, rowsTotal
  };
  let stage = largeMergeStage(first);
  input.reportStage(stage);
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true }, async (progress, token) => {
    const abort = new AbortController();
    // “取消”, or this window closing: the source that runs rolls back; merged ones stay.
    const cancellation = token?.onCancellationRequested?.(() => abort.abort());
    const watch = setInterval(() => { if (!canStartRuntimeDataSetUpgrade(context)) abort.abort(); }, LARGE_MERGE_SESSION.progressIntervalMs);
    const notify = createLargeMergeThrottle<string>((message) => progress?.report({ message }));
    notify.push(largeMergeProgressMessage(first, duration.expectedMs));
    try {
      return await runRuntimeDataSetUpgrade(context, () => engine.run({
        paths: { globalStoragePath: input.configurationRootPath },
        target: { configurationRootPath: input.configurationRootPath, binding: input.binding },
        preparation,
        signal: abort.signal,
        onProgress: (current) => {
          const next = largeMergeStage(current);
          if (next !== stage) {
            stage = next;
            input.reportStage(next);
          }
          // The engine's own estimate (the streamed engine's rate counts only the time its rows stream), when it gives one.
          notify.push(largeMergeProgressMessage(current, current.remainingMs ?? estimateLargeMergeRemainingMs({
            elapsedMs: Date.now() - startedAt, rowsDone: current.rowsDone, rowsTotal: current.rowsTotal, expectedMs: duration.expectedMs
          })));
        }
      }));
    } finally {
      clearInterval(watch);
      notify.stop();
      cancellation?.dispose?.();
    }
  });
}

/** The session did not run (this window stays as it was): the user's click always hears why, a startup once per cause. */
async function tellNotRun(
  options: LargeHistoricalMergeOptions,
  requested: boolean,
  stillCurrent: () => boolean,
  state: string,
  reason: string
): Promise<void> {
  const message = `较大的旧聊天记录这次没有合并：${withoutFullStop(reason)}。`;
  if (requested) {
    void vscode.window.showWarningMessage(`${message}已有数据未被修改，可以稍后在“历史与存储管理”里再试。`);
    return;
  }
  if (await fresh(options, `runtime-data-set-merge-large-session-${state}`, message) && stillCurrent()) {
    void vscode.window.showInformationMessage(`${message}下次启动时会再提示；也可以在“历史与存储管理”里手动开始。`);
  }
}

async function keep(
  state: ExclusiveMaintenanceWindowState | undefined,
  result: Parameters<typeof keepLargeMergeResult>[1]
): Promise<void> {
  if (!state) return;
  try { await keepLargeMergeResult(state, result); }
  catch (error) { console.warn(`[LimCode] 无法保留${ACTIVITY}的结果，重载后不会提示。`, error); }
}

async function reloadWindow(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

/** For text the caller follows with its own punctuation (no “。。”). */
function withoutFullStop(text: string): string {
  return text.trim().replace(/[。．.]+$/u, '');
}

function describeError(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return withoutFullStop(typeof message === 'string' ? message : String(error));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
