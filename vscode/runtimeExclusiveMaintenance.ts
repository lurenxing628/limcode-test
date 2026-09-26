import * as vscode from 'vscode';
import type { RuntimeRootPaths } from '../backend/reliableKernel/contracts';
import {
  readExclusiveMaintenanceRequest, registerExclusiveMaintenanceParticipant, requestExclusiveRuntimeMaintenance,
  type RuntimeExclusiveMaintenanceOutcome
} from '../backend/reliableKernel/runtimeExclusiveMaintenance';

export interface ExclusiveMaintenanceParticipantHost {
  exclusiveMaintenanceTarget(): { paths: RuntimeRootPaths; hostBootId: string };
  hasOwnedExecution(): Promise<boolean>;
}

export interface ExclusiveMaintenanceParticipantOptions {
  countdownSeconds?: number;
  pollMs?: number;
  isCurrent?(): boolean;
}

/**
 * This window takes part in cooperative exclusive maintenance on its selected root: when another
 * window asks, it first lets its own running work finish (the requester's wait is bounded), then
 * shows a short non-modal countdown and reloads. The reloaded startup waits on the requester's
 * admission, so it opens only after the maintenance is done. Cancelling keeps this window as is.
 */
export function startExclusiveMaintenanceParticipant(
  host: ExclusiveMaintenanceParticipantHost,
  options: ExclusiveMaintenanceParticipantOptions = {}
): { dispose(): Promise<void>; checkNow(): Promise<void> } {
  const { paths, hostBootId } = host.exclusiveMaintenanceTarget();
  const declined = new Set<string>();
  let disposed = false;
  let checking: Promise<void> | undefined;
  let registration: { unregister(): Promise<void> } | undefined;
  const registered = registerExclusiveMaintenanceParticipant(paths, hostBootId).then(
    result => { registration = result; },
    error => console.warn('[LimCode] 无法登记多窗口维护协作。', error)
  );
  const current = () => !disposed && options.isCurrent?.() !== false;
  const check = async (): Promise<void> => {
    await registered;
    if (!current()) return;
    const request = await readExclusiveMaintenanceRequest(paths);
    if (!request || declined.has(request.requestId) || await host.hasOwnedExecution()) return;
    if (!await countdown(request.message, options.countdownSeconds ?? 5)) {
      declined.add(request.requestId);
      return;
    }
    if (!current()) return;
    const still = await readExclusiveMaintenanceRequest(paths);
    if (still?.requestId !== request.requestId || await host.hasOwnedExecution()) return;
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  };
  const checkNow = (): Promise<void> => {
    checking ??= check().catch(error => console.warn('[LimCode] 多窗口维护协作检查失败。', error))
      .finally(() => { checking = undefined; });
    return checking;
  };
  const timer = setInterval(() => { void checkNow(); }, options.pollMs ?? 1500);
  timer.unref?.();
  return {
    checkNow,
    async dispose() {
      disposed = true;
      clearInterval(timer);
      await registered;
      await registration?.unregister().catch(() => undefined);
    }
  };
}

/**
 * Requester side, called while holding configuration admission and the root maintenance claim.
 * Shows a cancellable progress notification only while it actually waits for other windows.
 */
export async function runWithExclusiveMaintenance<T>(
  paths: RuntimeRootPaths,
  input: { operation: string; message: string; waitingTitle: string; timeoutMs: number; isCurrent(): boolean },
  operation: () => Promise<T>
): Promise<RuntimeExclusiveMaintenanceOutcome<T>> {
  let cancelled = false;
  let finishWait: (() => void) | undefined;
  return requestExclusiveRuntimeMaintenance(paths, {
    operation: input.operation,
    message: input.message,
    timeoutMs: input.timeoutMs,
    isCancelled: () => cancelled || !input.isCurrent(),
    onWaitStart: () => {
      const done = new Promise<void>(resolve => { finishWait = resolve; });
      void vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: input.waitingTitle, cancellable: true
      }, (_progress, token) => {
        token?.onCancellationRequested?.(() => { cancelled = true; });
        return done;
      });
    },
    onWaitEnd: () => finishWait?.()
  }, operation);
}

async function countdown(message: string, seconds: number): Promise<boolean> {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification, title: `${message}，本窗口即将重载`, cancellable: true
  }, async (progress, token) => {
    for (let left = seconds; left > 0; left -= 1) {
      if (token?.isCancellationRequested) return false;
      progress?.report({ message: `${left} 秒后重载；点“取消”保留本窗口`, increment: 100 / seconds });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    return token?.isCancellationRequested !== true;
  });
}
