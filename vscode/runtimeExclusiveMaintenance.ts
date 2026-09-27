import * as vscode from 'vscode';
import type { RuntimeRootPaths } from '../backend/reliableKernel/contracts';
import {
  requestExclusiveRuntimeMaintenance, runExclusiveRuntimeMaintenance,
  startExclusiveMaintenanceParticipant as startProtocolParticipant,
  type ExclusiveMaintenanceBusy, type ExclusiveMaintenanceOperation, type ExclusiveMaintenanceParticipant, type ExclusiveMaintenanceProgress,
  type ExclusiveMaintenanceConfirmContext, type RuntimeExclusiveMaintenanceInput, type RuntimeExclusiveMaintenanceOutcome,
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
   * This window's state that survives its reload (VS Code workspaceState). It carries the token of
   * the user's operation (so the user can retry it right after a failure reloaded the window) and
   * the reason why the user's operation gave way to the request this window then yielded to.
   */
  windowState?: ExclusiveMaintenanceWindowState;
}

/** The part of VS Code's Memento this layer uses. */
export interface ExclusiveMaintenanceWindowState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

const NOTICE_KEY = 'limcode.exclusiveMaintenance.noticeAfterReload';
const REQUESTER_KEY = 'limcode.exclusiveMaintenance.requester';
/**
 * A kept notice is dropped unread when the window opened again more than this after it was kept
 * (not a reload for that maintenance). Waiting for the maintenance to end does not count.
 */
const NOTICE_TTL_MS = 10 * 60_000;
/** Set when this window's participant starts. */
let windowState: ExclusiveMaintenanceWindowState | undefined;
/** The user's last operation in this window that gave way to an earlier request (its requestId). */
let gaveWay: { text: string; requestId: string } | undefined;

/**
 * This window's side of cooperative exclusive maintenance on its selected root. It never yields
 * while it runs work (busy: work) or while the user is in it (busy: focus); only when every window
 * is ready does it show the countdown (a notice, or a countdown without cancel, when the user
 * already confirmed the operation elsewhere) and then reload. Unsent composer input survives the
 * reload (Webview state). While this window's own request runs it never yields (the primitive
 * answers busy for it); when the user's operation gave way to an earlier request and this window
 * then yields to exactly that request, the reason is kept across the reload (windowState).
 */
export function startExclusiveMaintenanceParticipant(
  host: ExclusiveMaintenanceParticipantHost,
  options: ExclusiveMaintenanceParticipantOptions = {}
): ExclusiveMaintenanceParticipant {
  const { paths, hostBootId } = host.exclusiveMaintenanceTarget();
  const seconds = options.countdownSeconds ?? 5;
  if (options.windowState) windowState = options.windowState;
  return startProtocolParticipant(paths, hostBootId, {
    busyReason: async () => {
      if (await host.hasOwnedExecution()) return { kind: 'work', reason: '有任务正在进行' };
      if (vscode.window.state?.focused) return { kind: 'focus', reason: '窗口正在使用' };
      return undefined;
    },
    confirm: (request, context) => request.confirmation === 'notice'
      ? announce(request.message)
      : countdown(request, seconds, context),
    release: async (request) => {
      const kept = gaveWay;
      if (kept && kept.requestId === request.requestId && windowState) {
        try { await windowState.update(NOTICE_KEY, { text: kept.text, at: Date.now() }); }
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
  /** Title of the progress shown while other windows are involved. */
  waitingTitle: string;
  /**
   * Whether the user can cancel while other windows are involved (default true). An operation the
   * user already confirmed that cannot be taken back once it coordinates (the data-directory
   * commands) passes false: its progress has no cancel button. After go nothing cancels any more.
   */
  cancellable?: boolean;
  isCurrent(): boolean;
  /**
   * This window's workspaceState, where an explicit call keeps its operation's requester token
   * across a reload; defaults to the one the participant of this window was started with.
   */
  windowState?: ExclusiveMaintenanceWindowState;
  /**
   * Given: called outside the locks; waiting for busy windows happens without locks and withLocks
   * takes admission and maintenance only for the short locked round. Omitted: the caller already
   * holds the locks, and a busy window abandons at once.
   */
  withLocks?: RuntimeExclusiveMaintenanceRunInput['withLocks'];
};

/**
 * Once after the window opened again: why the user's operation did not run before another window's
 * maintenance reloaded this one. Read and cleared. `openedAt` is when this window started opening
 * again (the extension's activation): the reopened window may wait long for that maintenance to end.
 */
export function takeNoticeKeptAcrossReload(
  state: ExclusiveMaintenanceWindowState,
  openedAt: number = Date.now()
): string | undefined {
  const kept = state.get<{ text?: unknown; at?: unknown }>(NOTICE_KEY);
  if (!kept) return undefined;
  void Promise.resolve(state.update(NOTICE_KEY, undefined)).catch(() => undefined);
  return typeof kept.text === 'string' && typeof kept.at === 'number' && openedAt - kept.at <= NOTICE_TTL_MS
    ? kept.text
    : undefined;
}

/**
 * Requester side. Shows a progress notification (cancellable unless `cancellable: false`) only
 * while other windows (or this window's own work) are actually involved. For the user's explicit call it passes the requester
 * token of the operation (by its name, whatever the key), kept in windowState until the operation
 * completed: the user can retry right after a failure reloaded this window, past the cooldown that
 * failure started, while other windows and automatic calls cannot. When the user's operation gives
 * way to an earlier request, the reason is kept for a reload for that request.
 */
export async function runWithExclusiveMaintenance<T>(
  paths: RuntimeRootPaths,
  options: ExclusiveMaintenanceRequestOptions,
  operation: ExclusiveMaintenanceOperation<T>
): Promise<RuntimeExclusiveMaintenanceOutcome<T>> {
  const { waitingTitle, isCurrent, withLocks, windowState: givenState, cancellable = true, ...input } = options;
  const state = givenState ?? windowState;
  let cancelled = false;
  let finishWait: (() => void) | undefined;
  let reporter: vscode.Progress<{ message?: string }> | undefined;
  const coordinated: RuntimeExclusiveMaintenanceInput = {
    ...input,
    isCancelled: () => cancelled || !isCurrent(),
    onWaitStart: () => {
      const done = new Promise<void>((resolve) => { finishWait = resolve; });
      void vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: waitingTitle, cancellable
      }, (progress, token) => {
        reporter = progress;
        if (cancellable) token?.onCancellationRequested?.(() => { cancelled = true; });
        return done;
      });
    },
    onProgress: (progress) => reporter?.report({ message: describeProgress(progress) }),
    onWaitEnd: () => finishWait?.()
  };
  const activity = input.activity ?? input.message.replace(/^为/, '');
  const requesterToken = input.ignoreBackoff && state ? await userOperationToken(state, input.operation) : undefined;
  const request = { ...coordinated, ...(requesterToken !== undefined ? { requesterToken } : {}) };
  const outcome = await (withLocks
    ? runExclusiveRuntimeMaintenance(paths, { ...request, withLocks }, operation)
    : requestExclusiveRuntimeMaintenance(paths, request, operation));
  if (outcome.state === 'completed' && requesterToken !== undefined && state) {
    const { [input.operation]: _done, ...others } = requesterTokens(state);
    await Promise.resolve(state.update(REQUESTER_KEY, Object.keys(others).length > 0 ? others : undefined)).catch(() => undefined);
  }
  if (input.ignoreBackoff && outcome.state !== 'completed' && outcome.gaveWayTo !== undefined) {
    gaveWay = { text: `${activity}没有进行：${outcome.reason}`, requestId: outcome.gaveWayTo };
  }
  return outcome;
}

/**
 * The token of the user's operation in this window, by operation name: the one kept (across
 * reloads) until that operation completed, else a new one, kept before anything is published.
 */
async function userOperationToken(state: ExclusiveMaintenanceWindowState, operation: string): Promise<string | undefined> {
  const kept = requesterTokens(state);
  if (kept[operation]) return kept[operation];
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  try { await state.update(REQUESTER_KEY, { ...kept, [operation]: token }); }
  catch (error) {
    console.warn('[LimCode] 无法记录本次维护操作的标识。', error);
    return undefined;
  }
  return token;
}

function requesterTokens(state: ExclusiveMaintenanceWindowState): Record<string, string> {
  const kept = state.get<Record<string, unknown>>(REQUESTER_KEY);
  if (!kept || typeof kept !== 'object' || Array.isArray(kept)) return {};
  return Object.fromEntries(Object.entries(kept).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

export function describeProgress(progress: ExclusiveMaintenanceProgress): string {
  const closing = progress.leaving?.length ?? 0;
  if (progress.stage === 'waiting-busy' || (progress.stage === 'prepare' && closing > 0)) {
    const parts: string[] = [];
    if (progress.requesterBusy) parts.push('本窗口的任务结束');
    const maintaining = progress.busy.filter((item) => item.maintenance).length;
    const working = progress.busy.filter((item) => item.kind === 'work' && !item.maintenance).length;
    const focused = progress.busy.filter((item) => item.kind === 'focus').length;
    if (maintaining > 0) parts.push(`${maintaining} 个其它窗口的维护结束`);
    if (working > 0) parts.push(`${working} 个其它窗口的任务结束`);
    if (focused > 0) parts.push(`${focused} 个正在使用的窗口被切走`);
    if (closing > 0) parts.push(`${closing} 个正在关闭或重载的窗口关完`);
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

/** Ticks per second of the countdown: each checks the request is still waiting for this answer. */
const COUNTDOWN_TICKS_PER_SECOND = 4;

async function countdown(
  request: RuntimeExclusiveMaintenanceRequest,
  seconds: number,
  context: ExclusiveMaintenanceConfirmContext
): Promise<boolean> {
  // final-countdown: the user already confirmed the operation elsewhere; this window cannot veto it.
  const cancellable = request.confirmation === 'countdown';
  let withdrawn = false;
  const confirmed = await vscode.window.withProgress({
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
      for (let tick = 0; tick < COUNTDOWN_TICKS_PER_SECOND; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000 / COUNTDOWN_TICKS_PER_SECOND));
        // Withdrawn meanwhile (another window declined or stayed busy, a timeout): no reload follows.
        if (!await context.isCurrent().catch(() => true)) {
          withdrawn = true;
          return false;
        }
      }
    }
    return !cancelledNow();
  });
  if (withdrawn) void vscode.window.showInformationMessage(`其它窗口的${request.activity}这次没有进行，本窗口不重载。`);
  return confirmed;
}
