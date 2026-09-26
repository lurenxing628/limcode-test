import * as vscode from 'vscode';
import type { RuntimeRootPaths } from '../backend/reliableKernel/contracts';
import {
  requestExclusiveRuntimeMaintenance, startExclusiveMaintenanceParticipant as startProtocolParticipant,
  type ExclusiveMaintenanceParticipant, type ExclusiveMaintenanceProgress, type RuntimeExclusiveMaintenanceInput,
  type RuntimeExclusiveMaintenanceOutcome
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
}

/**
 * This window's side of cooperative exclusive maintenance on its selected root. It never yields
 * while it runs work or while the user is in it (a focused window answers busy); only when every
 * window is ready does it show the countdown (or, for an operation the user already confirmed
 * elsewhere, a notice) and then reload. Unsent composer input survives the reload (Webview state).
 */
export function startExclusiveMaintenanceParticipant(
  host: ExclusiveMaintenanceParticipantHost,
  options: ExclusiveMaintenanceParticipantOptions = {}
): ExclusiveMaintenanceParticipant {
  const { paths, hostBootId } = host.exclusiveMaintenanceTarget();
  return startProtocolParticipant(paths, hostBootId, {
    busyReason: async () => {
      if (await host.hasOwnedExecution()) return '有任务正在进行';
      if (vscode.window.state?.focused) return '窗口正在使用';
      return undefined;
    },
    confirm: (request) => request.confirmation === 'notice'
      ? announce(request.message)
      : countdown(request.message, options.countdownSeconds ?? 5),
    release: async () => {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    },
    notifyWaiting: (request) => {
      void vscode.window.showInformationMessage(`${request.message}：本窗口的任务结束后会自动重载，未发送的输入会保留。`);
    }
  }, {
    ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    ...(options.isCurrent ? { isCurrent: options.isCurrent } : {}),
    ...(options.processId !== undefined ? { processId: options.processId } : {}),
    onError: (error) => console.warn('[LimCode] 多窗口维护协作检查失败。', error)
  });
}

export type ExclusiveMaintenanceRequestOptions = Omit<
  RuntimeExclusiveMaintenanceInput, 'isCancelled' | 'onWaitStart' | 'onProgress' | 'onWaitEnd'
> & {
  /** Title of the cancellable progress shown while other windows are involved. */
  waitingTitle: string;
  isCurrent(): boolean;
};

/**
 * Requester side, called while holding the root maintenance claim (and configuration admission).
 * Shows a cancellable progress notification only while other windows are actually involved.
 */
export async function runWithExclusiveMaintenance<T>(
  paths: RuntimeRootPaths,
  options: ExclusiveMaintenanceRequestOptions,
  operation: () => Promise<T>
): Promise<RuntimeExclusiveMaintenanceOutcome<T>> {
  const { waitingTitle, isCurrent, ...input } = options;
  let cancelled = false;
  let finishWait: (() => void) | undefined;
  let reporter: vscode.Progress<{ message?: string }> | undefined;
  return requestExclusiveRuntimeMaintenance(paths, {
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
  }, operation);
}

function describeProgress(progress: ExclusiveMaintenanceProgress): string {
  if (progress.stage === 'waiting-busy') return `等待 ${progress.busy.length} 个窗口的任务结束`;
  if (progress.stage === 'confirm') return `其它 ${progress.hosts.length} 个窗口即将重载`;
  if (progress.stage === 'release') return `等待其它 ${progress.hosts.length} 个窗口重载`;
  return `询问其它 ${progress.hosts.length} 个窗口`;
}

async function announce(message: string): Promise<boolean> {
  void vscode.window.showInformationMessage(`${message}，本窗口将重载；未发送的输入会保留。`);
  return true;
}

async function countdown(message: string, seconds: number): Promise<boolean> {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification, title: `${message}，本窗口即将重载`, cancellable: true
  }, async (progress, token) => {
    for (let left = seconds; left > 0; left -= 1) {
      if (token?.isCancellationRequested) return false;
      progress?.report({ message: `${left} 秒后重载，未发送的输入会保留；点“取消”保留本窗口`, increment: 100 / seconds });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return token?.isCancellationRequested !== true;
  });
}
