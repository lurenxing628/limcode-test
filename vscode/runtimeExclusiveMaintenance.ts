import * as vscode from 'vscode';
import type { RuntimeRootPaths } from '../backend/reliableKernel/contracts';
import {
  requestExclusiveRuntimeMaintenance, runExclusiveRuntimeMaintenance,
  startExclusiveMaintenanceParticipant as startProtocolParticipant,
  type ExclusiveMaintenanceBusy, type ExclusiveMaintenanceOperation, type ExclusiveMaintenanceParticipant, type ExclusiveMaintenanceProgress,
  type RuntimeExclusiveMaintenanceInput, type RuntimeExclusiveMaintenanceOutcome,
  type RuntimeExclusiveMaintenanceRunInput, type RuntimeExclusiveMaintenanceRequest
} from '../backend/reliableKernel/runtimeExclusiveMaintenance';

export interface ExclusiveMaintenanceParticipantHost {
  exclusiveMaintenanceTarget(): { paths: RuntimeRootPaths; hostBootId: string };
  /** True while this window has work that a reload would interrupt (see the Facade). */
  hasOwnedExecution(): Promise<boolean>;
}

export interface ExclusiveMaintenanceParticipantOptions {
  countdownSeconds?: number;
  pollMs?: number;
  isCurrent?(): boolean;
  /** Tests that run several windows in one process give each its own identity. */
  processId?: number;
  /**
   * Keeps a text across the reload that yielding causes (e.g. in workspaceState); the window shows
   * it once it opened again. Used for this window's own request that ended shortly before.
   */
  rememberAcrossReload?(text: string): PromiseLike<void> | void;
}

/** How long before a reload this window's own unfinished request is carried across it. */
const REMEMBER_BEFORE_RELOAD_MS = 5 * 60_000;
/** The last request of this window that did not complete, and when it ended. */
let unfinishedRequest: { text: string; at: number } | undefined;

/**
 * This window's side of cooperative exclusive maintenance on its selected root. It never yields
 * while it runs work (busy: work) or while the user is in it (busy: focus); only when every window
 * is ready does it show the countdown (a notice, or a countdown without cancel, when the user
 * already confirmed the operation elsewhere) and then reload. Unsent composer input survives the
 * reload (Webview state). While this window's own request runs it never yields (the primitive
 * answers busy for it), and when it yields shortly after its own request ended without completing,
 * the outcome is kept across the reload (rememberAcrossReload).
 */
export function startExclusiveMaintenanceParticipant(
  host: ExclusiveMaintenanceParticipantHost,
  options: ExclusiveMaintenanceParticipantOptions = {}
): ExclusiveMaintenanceParticipant {
  const { paths, hostBootId } = host.exclusiveMaintenanceTarget();
  const seconds = options.countdownSeconds ?? 5;
  return startProtocolParticipant(paths, hostBootId, {
    busyReason: async () => {
      if (await host.hasOwnedExecution()) return { kind: 'work', reason: '有任务正在进行' };
      if (vscode.window.state?.focused) return { kind: 'focus', reason: '窗口正在使用' };
      return undefined;
    },
    confirm: (request) => request.confirmation === 'notice'
      ? announce(request.message)
      : countdown(request, seconds),
    release: async () => {
      const unfinished = unfinishedRequest;
      if (unfinished && Date.now() - unfinished.at < REMEMBER_BEFORE_RELOAD_MS && options.rememberAcrossReload) {
        try { await options.rememberAcrossReload(unfinished.text); }
        catch (error) { console.warn('[LimCode] 无法保留重载前的维护结果。', error); }
      }
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    },
    notifyWaiting: (request, busy) => {
      void vscode.window.showInformationMessage(busy.kind === 'focus'
        ? `${request.message}：你正在使用本窗口，切换到其它窗口后本窗口会自动重载，未发送的输入会保留。`
        : `${request.message}：本窗口的任务结束后会自动重载，未发送的输入会保留。`);
    }
  }, {
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    ...(options.isCurrent ? { isCurrent: options.isCurrent } : {}),
    ...(options.processId !== undefined ? { processId: options.processId } : {}),
    onError: (error) => console.warn('[LimCode] 多窗口维护协作检查失败。', error)
  });
}

/**
 * The requester's own window as `requesterBusy`: only its work counts (the user is naturally in the
 * window where the operation was started, so focus does not).
 */
export function requesterWorkBusy(host: Pick<ExclusiveMaintenanceParticipantHost, 'hasOwnedExecution'>): () => Promise<ExclusiveMaintenanceBusy | undefined> {
  return async () => (await host.hasOwnedExecution()) ? { kind: 'work', reason: '本窗口有任务正在进行' } : undefined;
}

export type ExclusiveMaintenanceRequestOptions = Omit<
  RuntimeExclusiveMaintenanceInput, 'isCancelled' | 'onWaitStart' | 'onProgress' | 'onWaitEnd'
> & {
  /** Title of the cancellable progress shown while other windows are involved. */
  waitingTitle: string;
  isCurrent(): boolean;
  /**
   * Given: called outside the locks; waiting for busy windows happens without locks and withLocks
   * takes admission and maintenance only for the short locked round. Omitted: the caller already
   * holds the locks, and a busy window abandons at once.
   */
  withLocks?: RuntimeExclusiveMaintenanceRunInput['withLocks'];
};

/**
 * Requester side. Shows a cancellable progress notification only while other windows (or this
 * window's own work) are actually involved. An outcome that did not complete is remembered, so a
 * reload of this window soon after (another window's maintenance) keeps it (rememberAcrossReload).
 */
export async function runWithExclusiveMaintenance<T>(
  paths: RuntimeRootPaths,
  options: ExclusiveMaintenanceRequestOptions,
  operation: ExclusiveMaintenanceOperation<T>
): Promise<RuntimeExclusiveMaintenanceOutcome<T>> {
  const { waitingTitle, isCurrent, withLocks, ...input } = options;
  let cancelled = false;
  let finishWait: (() => void) | undefined;
  let reporter: vscode.Progress<{ message?: string }> | undefined;
  const coordinated: RuntimeExclusiveMaintenanceInput = {
    ...input,
    isCancelled: () => cancelled || !isCurrent(),
    onWaitStart: () => {
      const done = new Promise<void>((resolve) => { finishWait = resolve; });
      void vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: waitingTitle, cancellable: true
      }, (progress, token) => {
        reporter = progress;
        token?.onCancellationRequested?.(() => { cancelled = true; });
        return done;
      });
    },
    onProgress: (progress) => reporter?.report({ message: describeProgress(progress) }),
    onWaitEnd: () => finishWait?.()
  };
  const activity = input.activity ?? input.message.replace(/^为/, '');
  try {
    const outcome = await (withLocks
      ? runExclusiveRuntimeMaintenance(paths, { ...coordinated, withLocks }, operation)
      : requestExclusiveRuntimeMaintenance(paths, coordinated, operation));
    unfinishedRequest = outcome.state === 'completed' || outcome.state === 'cancelled'
      ? undefined : { text: `${activity}没有进行：${outcome.reason}`, at: Date.now() };
    return outcome;
  } catch (error) {
    unfinishedRequest = { text: `${activity}没有完成：${error instanceof Error ? error.message : String(error)}`, at: Date.now() };
    throw error;
  }
}

export function describeProgress(progress: ExclusiveMaintenanceProgress): string {
  if (progress.stage === 'waiting-busy') {
    const parts: string[] = [];
    if (progress.requesterBusy) parts.push('本窗口的任务结束');
    const working = progress.busy.filter((item) => item.kind === 'work').length;
    const focused = progress.busy.filter((item) => item.kind === 'focus').length;
    if (working > 0) parts.push(`${working} 个其它窗口的任务结束`);
    if (focused > 0) parts.push(`${focused} 个正在使用的窗口被切走`);
    return `等待${parts.join('、')}`;
  }
  if (progress.stage === 'confirm') return `其它 ${progress.hosts.length} 个窗口即将重载`;
  if (progress.stage === 'release') return `等待其它 ${progress.hosts.length} 个窗口重载`;
  return `询问其它 ${progress.hosts.length} 个窗口`;
}

async function announce(message: string): Promise<boolean> {
  void vscode.window.showInformationMessage(`${message}，本窗口将重载；未发送的输入会保留。`);
  return true;
}

async function countdown(request: RuntimeExclusiveMaintenanceRequest, seconds: number): Promise<boolean> {
  // final-countdown: the user already confirmed the operation elsewhere; this window cannot veto it.
  const cancellable = request.confirmation === 'countdown';
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification, title: `${request.message}，本窗口即将重载`, cancellable
  }, async (progress, token) => {
    const cancelledNow = () => cancellable && token?.isCancellationRequested === true;
    for (let left = seconds; left > 0; left -= 1) {
      if (cancelledNow()) return false;
      progress?.report({
        message: cancellable
          ? `${left} 秒后重载，未发送的输入会保留；点“取消”保留本窗口`
          : `${left} 秒后重载（已在其它窗口确认），未发送的输入会保留`,
        increment: 100 / seconds
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return !cancelledNow();
  });
}
