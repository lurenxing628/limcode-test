import * as vscode from 'vscode';
import type { RuntimeClaimWait } from '../backend/reliableKernel/runtimeHostControl';

/** What the opening shell (restored tabs) and the notification say while the Runtime waits to open. */
export interface RuntimeOpeningWaitStatus {
  title: string;
  description: string;
}

export const RUNTIME_OPENING_WAIT_LIMITS = Object.freeze({
  /** Another window opening takes seconds: warn when it takes longer than this. */
  openingWarnMs: 60_000,
  /** A maintenance that keeps its heartbeat may run long (a large migration): warn after this. */
  maintenanceWarnMs: 10 * 60_000,
  /** After “继续等待” the next warning comes no sooner than this. */
  repeatWarnMs: 10 * 60_000
});

export const RUNTIME_OPENING_WAIT_ACTIONS = Object.freeze({ keepWaiting: '继续等待', closeWindow: '关闭窗口' });

/**
 * The wording for one wait on the admission (or maintenance) claim: what the holder does, from its
 * heartbeat marker, or that another window is opening. A warning only offers to keep waiting or to
 * close this window; the Runtime never opens past the lock.
 */
export function describeRuntimeOpeningWait(wait: RuntimeClaimWait): { status: RuntimeOpeningWaitStatus; warning?: string } {
  const activity = wait.activity;
  const keepWaiting = '本窗口会继续等它结束，不会跳过它直接打开；也可以关闭本窗口。';
  if (!activity) {
    return {
      status: {
        title: '正在等待其它窗口',
        description: `正在等待其它窗口完成打开（已等待 ${formatDuration(wait.waitedMs)}），完成后自动打开；未发送的输入已保留。`
      },
      ...(wait.waitedMs >= RUNTIME_OPENING_WAIT_LIMITS.openingWarnMs
        ? { warning: `LimCode 已等待 ${formatDuration(wait.waitedMs)}：另一个窗口一直没有完成打开。${keepWaiting}` }
        : {})
    };
  }
  if (activity.stale) {
    const quiet = formatDuration(activity.heartbeatAgeMs);
    return {
      status: {
        title: '正在等待另一个窗口',
        description: `另一个窗口正在${activity.description}，已经 ${quiet}没有进展（可能卡在网络盘或外置盘上）；完成后自动打开，未发送的输入已保留。`
      },
      warning: `另一个 LimCode 窗口正在${activity.description}，已经 ${quiet}没有进展（可能卡在网络盘或外置盘上）。${keepWaiting}`
    };
  }
  const stage = activity.stage ? `，${activity.stage}` : '';
  return {
    status: {
      title: '正在等待另一个窗口',
      description: `另一个窗口正在${activity.description}（已进行 ${formatDuration(activity.runningMs)}${stage}），完成后自动打开；未发送的输入已保留。`
    },
    ...(wait.waitedMs >= RUNTIME_OPENING_WAIT_LIMITS.maintenanceWarnMs
      ? { warning: `另一个 LimCode 窗口正在${activity.description}，本窗口已等待 ${formatDuration(wait.waitedMs)}。${keepWaiting}` }
      : {})
  };
}

export interface RuntimeOpeningWaitPresenter {
  /** Shown at once, before any wait was measured (e.g. a data-directory move known to be running). */
  announce(description: string): void;
  /** Called on every poll of a long wait (RuntimeClaimWaitOptions.onWait); replaces an announcement. */
  onWait(wait: RuntimeClaimWait): void;
  /** The Runtime opened or failed: the notification closes and the shell status clears. */
  end(): void;
}

/**
 * Shows a long wait while the Runtime opens: a progress notification with the reason (commands
 * wait for the Runtime too), the same text for the opening shell of restored tabs (onStatus), and a
 * warning with “继续等待 / 关闭窗口” when it takes very long or the holder stopped making progress.
 */
export function createRuntimeOpeningWaitPresenter(
  onStatus: (status: RuntimeOpeningWaitStatus | undefined) => void
): RuntimeOpeningWaitPresenter {
  let ended = false;
  let finish: (() => void) | undefined;
  let progress: vscode.Progress<{ message?: string }> | undefined;
  let shown: string | undefined;
  let warningOpen = false;
  let nextWarningAt = 0;
  const present = (status: RuntimeOpeningWaitStatus): void => {
    if (!finish) {
      const done = new Promise<void>((resolve) => { finish = resolve; });
      void vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: `LimCode ${status.title}`, cancellable: false
      }, (reporter) => {
        progress = reporter;
        reporter.report({ message: shown });
        return done;
      });
    }
    if (status.description !== shown) {
      shown = status.description;
      progress?.report({ message: shown });
      onStatus(status);
    }
  };
  return {
    announce(description) {
      if (!ended) present({ title: '正在等待另一个窗口', description });
    },
    onWait(wait) {
      if (ended) return;
      const { status, warning } = describeRuntimeOpeningWait(wait);
      present(status);
      if (!warning || warningOpen || Date.now() < nextWarningAt) return;
      warningOpen = true;
      void Promise.resolve(vscode.window.showWarningMessage(
        warning, RUNTIME_OPENING_WAIT_ACTIONS.keepWaiting, RUNTIME_OPENING_WAIT_ACTIONS.closeWindow
      )).then(async (choice) => {
        warningOpen = false;
        nextWarningAt = Date.now() + RUNTIME_OPENING_WAIT_LIMITS.repeatWarnMs;
        if (choice === RUNTIME_OPENING_WAIT_ACTIONS.closeWindow && !ended) {
          await vscode.commands.executeCommand('workbench.action.closeWindow');
        }
      }, () => { warningOpen = false; });
    },
    end() {
      if (ended) return;
      ended = true;
      finish?.();
      if (shown !== undefined) onStatus(undefined);
    }
  };
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 120 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分钟`;
}
