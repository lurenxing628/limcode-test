import * as vscode from 'vscode';
import type { RuntimeClaimWait } from '../backend/reliableKernel/runtimeHostControl';

/** What the opening shell (restored tabs) says while the Runtime waits to open: no running seconds. */
export interface RuntimeOpeningWaitStatus {
  title: string;
  description: string;
}

export const RUNTIME_OPENING_WAIT_LIMITS = Object.freeze({
  /** A holder without a marker (another window opening) takes seconds: warn when it held this long. */
  openingWarnMs: 60_000,
  /** A maintenance that keeps its heartbeat may run long (a large migration): warn after this. */
  maintenanceWarnMs: 10 * 60_000,
  /** After “继续等待” the next warning comes no sooner than this. */
  repeatWarnMs: 10 * 60_000
});

export const RUNTIME_OPENING_WAIT_ACTIONS = Object.freeze({ keepWaiting: '继续等待', closeWindow: '关闭窗口' });

export interface RuntimeOpeningWaitDescription {
  /** For the opening shell: changes only when the stage does. */
  status: RuntimeOpeningWaitStatus;
  /** For the VS Code notification: with the elapsed time. */
  message: string;
  warning?: string;
}

/**
 * The wording for one wait on the admission (or maintenance) claim: what the holder does, from its
 * heartbeat marker, or neutrally that another window holds the data directory. Long waits are judged
 * by how long the current holder has held it, so a window queued behind others is not warned when
 * the previous holder let go. A warning only offers to keep waiting or to close this window; the
 * Runtime never opens past the lock.
 */
export function describeRuntimeOpeningWait(wait: RuntimeClaimWait): RuntimeOpeningWaitDescription {
  const activity = wait.activity;
  const keepWaiting = '本窗口会继续等它结束，不会跳过它直接打开；也可以关闭本窗口。';
  const kept = '完成后自动打开；未发送的输入已保留。';
  if (!activity) {
    return {
      status: { title: '正在等待其它窗口', description: `正在等待其它 LimCode 窗口释放数据目录，${kept}` },
      message: `正在等待其它 LimCode 窗口释放数据目录（已等待 ${formatDuration(wait.holderWaitedMs)}），${kept}`,
      ...(wait.holderWaitedMs >= RUNTIME_OPENING_WAIT_LIMITS.openingWarnMs
        ? { warning: `另一个 LimCode 窗口已经占用数据目录 ${formatDuration(wait.holderWaitedMs)}。${keepWaiting}` }
        : {})
    };
  }
  const stage = activity.stage ? `（${activity.stage}）` : '';
  if (activity.stale) {
    const quiet = formatDuration(activity.heartbeatAgeMs);
    return {
      status: {
        title: '正在等待另一个窗口',
        description: `另一个窗口正在${activity.description}，但暂时没有进展（可能卡在网络盘或外置盘上）；${kept}`
      },
      message: `另一个窗口正在${activity.description}，已经 ${quiet}没有进展（可能卡在网络盘或外置盘上）；${kept}`,
      warning: `另一个 LimCode 窗口正在${activity.description}，已经 ${quiet}没有进展（可能卡在网络盘或外置盘上）。${keepWaiting}`
    };
  }
  const progress = activity.stage ? `，${activity.stage}` : '';
  return {
    status: { title: '正在等待另一个窗口', description: `另一个窗口正在${activity.description}${stage}，${kept}` },
    message: `另一个窗口正在${activity.description}（已进行 ${formatDuration(activity.runningMs)}${progress}），${kept}`,
    ...(wait.holderWaitedMs >= RUNTIME_OPENING_WAIT_LIMITS.maintenanceWarnMs
      ? { warning: `另一个 LimCode 窗口正在${activity.description}，本窗口已等待 ${formatDuration(wait.holderWaitedMs)}。${keepWaiting}` }
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
 * Shows a long wait while the Runtime opens: a progress notification with the reason and the elapsed
 * time (commands wait for the Runtime too), the reason without seconds for the opening shell of
 * restored tabs (onStatus, only when the stage changes), and a warning with “继续等待 / 关闭窗口” when
 * the holder held it very long or stopped making progress. A warning answered after this window
 * opened says so instead of acting on it.
 */
export function createRuntimeOpeningWaitPresenter(
  onStatus: (status: RuntimeOpeningWaitStatus | undefined) => void
): RuntimeOpeningWaitPresenter {
  let ended = false;
  let finish: (() => void) | undefined;
  let progress: vscode.Progress<{ message?: string }> | undefined;
  let shownStatus: string | undefined;
  let shownMessage: string | undefined;
  let warningOpen = false;
  let nextWarningAt = 0;
  const present = (status: RuntimeOpeningWaitStatus, message: string): void => {
    const changed = message !== shownMessage;
    shownMessage = message;
    if (!finish) {
      const done = new Promise<void>((resolve) => { finish = resolve; });
      // The notification starts with the latest text, whenever VS Code runs this.
      void vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: `LimCode ${status.title}`, cancellable: false
      }, (reporter) => {
        progress = reporter;
        reporter.report({ message: shownMessage });
        return done;
      });
    } else if (changed) {
      progress?.report({ message });
    }
    if (status.description !== shownStatus) {
      shownStatus = status.description;
      onStatus(status);
    }
  };
  return {
    announce(description) {
      if (!ended) present({ title: '正在等待另一个窗口', description }, description);
    },
    onWait(wait) {
      if (ended) return;
      const { status, message, warning } = describeRuntimeOpeningWait(wait);
      present(status, message);
      if (!warning || warningOpen || Date.now() < nextWarningAt) return;
      warningOpen = true;
      void Promise.resolve(vscode.window.showWarningMessage(
        warning, RUNTIME_OPENING_WAIT_ACTIONS.keepWaiting, RUNTIME_OPENING_WAIT_ACTIONS.closeWindow
      )).then(async (choice) => {
        warningOpen = false;
        nextWarningAt = Date.now() + RUNTIME_OPENING_WAIT_LIMITS.repeatWarnMs;
        if (choice === undefined) return;
        if (ended) {
          // The warning outlived the wait: VS Code cannot take it back, so answer it.
          void vscode.window.showInformationMessage('LimCode 已经打开，不需要再等待；本窗口没有关闭。');
          return;
        }
        if (choice === RUNTIME_OPENING_WAIT_ACTIONS.closeWindow) {
          await vscode.commands.executeCommand('workbench.action.closeWindow');
        }
      }, () => { warningOpen = false; });
    },
    end() {
      if (ended) return;
      ended = true;
      finish?.();
      if (shownStatus !== undefined) onStatus(undefined);
    }
  };
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 120 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分钟`;
}
