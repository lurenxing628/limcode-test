import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  GlobalStatusPendingRelocationConflictError, LIMCODE_GLOBAL_STATUS_FILE, loadCommittedGlobalStatus, resolveDataRootUri, sameFsPath,
  updateGlobalStatusDataRoot, type LimCodeGlobalStatus, type PendingDataRootRelocation
} from '../../backend/capabilities/vscodeStorage/globalStatus';
import type { RuntimeRootPaths } from '../../backend/reliableKernel/contracts';
import { ownProcessStartIdentity } from '../../backend/reliableKernel/runtimeClaimPrimitives';
import {
  abandonStagedDataRootRelocation, assertDataRootAvailable, clearDataRootMovedNotice, completeDataRootRelocation, DATA_ROOT_RELOCATION_MARKER_FILE,
  dataRootRelocationCleanupState, dataRootRelocationOwnerState, DataRootRelocationError, deleteOldDataRoot, ensureDataRootIdentity,
  finalizeDataRootRelocation, findDataRootRelocationCopy, formatBytes, inspectDataRootForReturn, invalidateDataRootRelocationRecord,
  isDataRootRelocationTargetInvisible, undoUnpublishedDataRootRelocation,
  planDataRootRelocation, planOldDataRootDeletion, readDataRootMovedNotice, readDataRootRelocationHold, recoverInterruptedDataRootRelocation,
  stageDataRootRelocation, inspectDataRootMovedNotice, DATA_ROOT_MOVED_NOTICE_FILE,
  sweepDataRootRelocationLeftovers, type DataRootCarriedWorkLeftItem, type DataRootMovedNotice, type DataRootRelocationPlan, type DataRootRelocationPublication,
  type DataRootRelocationResult, type DataRootUnavailableReason, type StagedDataRootRelocation,
  carryDeletionRecordsBack, consentToDataRootMovedWork, describeEarlierMovedWork,
} from '../../backend/reliableKernel/runtimeDataRootRelocation';
import { settleEarlierMovedWorkOffline } from '../../backend/application/reliableKernel/relocatedWorkOpening';
import type { RuntimeDatabase } from '../../backend/reliableKernel/runtimeDatabase';
import {
  clearExclusiveMaintenanceKey, type ExclusiveMaintenanceBusy, type RuntimeExclusiveMaintenanceOutcome
} from '../../backend/reliableKernel/runtimeExclusiveMaintenance';
import { withRuntimeDataRootAdmission } from '../../backend/reliableKernel/runtimeHostControl';
import { assertConfigurationRootRuntimesOffline } from '../../backend/reliableKernel/vscodeRootAuthority';
import { EXTENSION_BRAND, EXTENSION_COMMAND_IDS } from '../../shared/extensionIdentity';
import type { BridgeClientId, DataRootPromptSection, ExtensionToWebviewMessage } from '../../shared/protocol';
import type { ApplicationStartup } from '../ApplicationStartup';
import { askInSettingsPage, type DataRootPrompt, type DataRootPromptAnswer } from '../dataRootPrompts';
import { requesterWorkBusy, runWithExclusiveMaintenance, type ExclusiveMaintenanceWindowState } from '../runtimeExclusiveMaintenance';

/** What the data-directory commands need of the open Runtime (the reliable-kernel Facade). */
export interface DataRootRelocationHost {
  product: { application: { database: RuntimeDatabase } };
  hasOwnedExecution(): Promise<boolean>;
  exclusiveMaintenanceTarget(): { paths: RuntimeRootPaths; hostBootId: string };
  dataRootPath(): string;
  withDataRootLocks<R>(body: () => Promise<R>): Promise<R>;
  /**
   * Stops this window from taking up new work and refuses its write commands (“正在<activity>，完成后再
   * 操作。”) until the returned undo; only work from before counts as busy meanwhile.
   */
  freezeNewWork(activity: string): () => void;
  closeRuntime(): Promise<void>;
  postToWebview(clientId: BridgeClientId, message: ExtensionToWebviewMessage): boolean;
}

/** Shown once after the reload that follows a relocation. */
const RELOCATION_NOTICE_KEY = 'limcode.dataRootRelocationNotice';
/** Relocation ids of other installations' moved notices the user chose not to be reminded of. */
const MOVED_NOTICE_DISMISSED_KEY = 'limcode.dataRootMovedNoticeDismissed';
/** Relocation ids of held undos (someone wrote into their target since) the user chose not to be reminded of. */
const HELD_NOTICE_DISMISSED_KEY = 'limcode.dataRootHeldRelocationDismissed';
/** A relocation of this window is running (its in-progress record is this process's, but not left over). */
let relocationRunning = false;
const CANCEL = { key: 'cancel', label: '取消', variant: 'secondary' as const };
const UNDO_UNPUBLISHED = '撤销那次未完成的迁移并打开';
const OK = { key: 'cancel', label: '知道了', variant: 'secondary' as const };

type Ask = (prompt: DataRootPrompt) => Promise<DataRootPromptAnswer>;

/**
 * 迁移数据目录: native folder picker, read-only checks, confirmation in the settings page, then the
 * move (runtimeDataRootRelocation) with every window of the old directory reloading once. From the
 * command palette the command opens the settings page, where the button starts it.
 */
export async function relocateDataRoot(context: vscode.ExtensionContext, startup: ApplicationStartup, request?: unknown): Promise<void> {
  const clientId = requestClientId(request);
  if (!clientId) {
    await openSettingsPage('迁移数据目录');
    return;
  }
  const host = await readyHost(startup);
  if (!host) {
    await vscode.window.showErrorMessage('运行时没有打开，不能迁移数据目录。如果当前数据目录不可用，可以在提示里选择“回到旧目录”或“选择其它目录”。');
    return;
  }
  const ask: Ask = (prompt) => askInSettingsPage(host, clientId, prompt);
  const status = await loadCommittedGlobalStatus(context);
  if (status.pendingRelocation && ownerOf(status.pendingRelocation) !== 'dead') {
    if (!isOwnPending(status.pendingRelocation) || relocationRunning) {
      // Another window's relocation that failed and whose undo did not finish moves nothing: say so.
      if (!relocationRunning && await relocationPhase(status.pendingRelocation) === 'unfinished') {
        await tell(ask, '上次的迁移没有成功，还没有撤销完', [
          `${unfinishedElsewhere(status.pendingRelocation)}等它撤销完之后才能开始新的迁移；如果撤销停下了，在那个窗口里再点一次“迁移数据目录”，或关闭、重载那个窗口后会自动处理。`
        ]);
        return;
      }
      await tell(ask, '已有迁移正在进行', [relocationRunning
        ? '本窗口正在迁移数据目录，请等它完成。'
        : '另一个 LimCode 窗口正在迁移数据目录，请等它完成后再试。']);
      return;
    }
    // This window's own earlier relocation whose undo could not finish: it is tried again now.
    if (!await settleOwnRelocation(context, status.pendingRelocation, ask)) return;
  }
  // A crashed relocation is undone first; its record is kept until that succeeded.
  if (status.pendingRelocation && !await settleInterruptedRelocation(context, status.pendingRelocation, ask)) return;
  const sourceRootPath = host.dataRootPath();
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
    openLabel: '迁移到这里', title: '选择新的 LimCode 数据目录（建议选择空文件夹）'
  });
  if (!picked?.[0]) return;
  const sourceDatabase = host.product.application.database;
  const installation = installationOf(context).id;
  let plan = await checking(() => planDataRootRelocation({ sourceRootPath, targetRootPath: picked[0].fsPath, sourceDatabase, installation }));
  if (plan.target.kind === 'occupied') {
    const nested = plan.target.suggestedPath;
    const answer = await ask({
      title: '所选文件夹里已有其它文件',
      description: `LimCode 不会把数据放进已有其它文件的文件夹，只能放在其中新建的专用子文件夹里：${nested}`,
      sections: [{ title: `所选文件夹里已有 ${plan.target.entries.length} 项（都不会被改动）：`, lines: plan.target.entries }],
      actions: [CANCEL, { key: 'nested', label: '使用这个子文件夹' }]
    });
    if (answer.choice !== 'nested') return;
    plan = await checking(() => planDataRootRelocation({ sourceRootPath, targetRootPath: nested, sourceDatabase, installation }));
  }
  if (plan.problems.length > 0) {
    await tell(ask, '不能迁移到这个目录', plan.problems);
    return;
  }
  if (await host.hasOwnedExecution()) {
    await tell(ask, '本窗口有任务正在进行', ['请等任务结束（或停止任务）后再迁移数据目录。']);
    return;
  }
  // Work an earlier relocation carried away from here and not settled here would move again and run
  // twice: the relocation goes ahead only when the user has it settled first (that choice is the consent).
  const earlier = plan.earlierMovedWork;
  const confirmed = await ask({
    title: '迁移数据目录并重载所有 LimCode 窗口？',
    sections: [
      ...(earlier ? [{ title: '上一次迁走、这里还没收尾的任务：', lines: [
        ...describeEarlierMovedWork(earlier).slice(0, -1),
        '选“先把这些任务按中止收尾，再迁移”：所有窗口让出之后、复制任何内容之前，这些历史库在这里按中止收尾（不执行任何工作），它们在上一次的新目录里不受影响；收尾不了（例如另一个窗口正占着）就不迁移，并逐条说明。'
      ] }] : []),
      ...describePlan(plan)
    ],
    actions: [CANCEL, earlier ? { key: 'settle-and-relocate', label: '先把这些任务按中止收尾，再迁移' } : { key: 'relocate', label: '迁移并重载' }]
  });
  if (confirmed.choice !== (earlier ? 'settle-and-relocate' : 'relocate')) return;
  await runRelocation(context, host, plan, ask);
}

async function runRelocation(context: vscode.ExtensionContext, host: DataRootRelocationHost, plan: DataRootRelocationPlan, ask: Ask): Promise<void> {
  const relocationId = randomUUID();
  const identity = ownProcessStartIdentity();
  const installation = installationOf(context);
  const pending: PendingDataRootRelocation = {
    relocationId, sourceRootPath: plan.sourceRootPath, targetRootPath: plan.targetRootPath, startedAt: new Date().toISOString(),
    processId: process.pid, ...(identity ? { processStartIdentity: identity } : {})
  };
  try {
    // Only when no other relocation of this installation started meanwhile.
    await updateGlobalStatusDataRoot(context, { pendingRelocation: pending, expectedPendingRelocationId: null });
  } catch (error) {
    if (!(error instanceof GlobalStatusPendingRelocationConflictError)) throw error;
    await tell(ask, '已有迁移正在进行', [error.message]);
    return;
  }
  let result: DataRootRelocationResult | undefined;
  let failure: unknown;
  let runtimeClosed = false;
  let cleaned = true;
  /** Why the undo after a failure could not finish (or was held), for the message. */
  let cleanupProblem: string | undefined;
  /** The pointer switched to the target although a later step failed: the relocation took effect. */
  let tookEffect = false;
  /** The pointer could not be read after the failure: nothing was undone. */
  let pointerUnknown = false;
  let staged: StagedDataRootRelocation | undefined;
  relocationRunning = true;
  try {
    // Preparation can be cancelled: "Cancel" stops the online pre-copy. Once every window is asked
    // to go offline it is too late, so the rest runs under a notification without a cancel button.
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在迁移数据目录：准备中（可以取消）', cancellable: true }, async (progress, token) => {
      const onProgress = (message: string): void => progress?.report({ message });
      const cancel = new AbortController();
      const cancellation = token?.onCancellationRequested(() => cancel.abort());
      try {
        onProgress('正在准备新目录');
        staged = await stageDataRootRelocation(plan, host.product.application.database, {
          onProgress, relocationId, signal: cancel.signal, installation: installation.id,
          // Where the target was found, recorded before anything there changes (a later attempt then
          // tells "undone" from "not visible right now").
          beforeTargetChange: async (targetAnchor) => {
            await updateGlobalStatusDataRoot(context, { pendingRelocation: { ...pending, targetAnchor }, expectedPendingRelocationId: relocationId });
          }
        });
      } catch (error) {
        failure = error;
        cleaned = dataRootRelocationCleanupState(error) !== 'not-cleaned';
      } finally {
        cancellation?.dispose();
      }
    });
    const prepared = staged;
    if (prepared) {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在迁移数据目录（已不能取消）', cancellable: false }, async (progress) => {
        const onProgress = (message: string): void => progress?.report({ message });
        onProgress('等待所有 LimCode 窗口空闲');
        try {
          const outcome = await exclusively(host, {
            operation: 'data-root-relocation',
            operationKey: `data-root-relocation:${plan.targetRootPath}#${relocationId}`,
            message: '为迁移数据目录',
            waitingTitle: '迁移数据目录：正在等待 LimCode 窗口空闲',
            configurationRootPath: plan.sourceRootPath,
            windowState: context.workspaceState
          }, async (stage) => {
            runtimeClosed = true;
            stage('正在关闭本窗口的运行时');
            await host.closeRuntime();
            // Windows waiting to open the old directory show the same stages (copy with batches, others, checks, undo).
            const report = (message: string): void => { onProgress(message); stage(message); };
            // Kept even when a later step (e.g. releasing the locks) fails: the relocation took effect.
            result = await completeDataRootRelocation(prepared, (publication) => {
              report('正在切换到新数据目录');
              return publishRelocation(context, plan, relocationId, publication);
            }, {
              onProgress: report, movedBy: installation, installation: installation.id,
              // Chosen when confirming (see relocateDataRoot); settled offline as at an open of each data set.
              ...(plan.earlierMovedWork ? {
                settleEarlierMovedWork: (dataSet: { id: string }) => settleEarlierMovedWorkOffline(plan.sourceRootPath, dataSet.id, installation.id)
              } : {}),
              // A failed switch is undone right there only when the pointer is read again and did not switch.
              pointerUnchanged: async () => await pointerSwitchedTo(context, plan.targetRootPath, relocationId) === false
            });
            return result;
          });
          if (outcome.state === 'completed') {
            result = outcome.result;
            return;
          }
          failure = new Error(outcome.reason);
        } catch (error) {
          failure = error;
        }
        // Whatever failed, the pointer is read again first: once it names this relocation, the
        // relocation took effect and is never undone (only the finishing step failed).
        const switched = await pointerSwitchedTo(context, plan.targetRootPath, relocationId);
        if (switched !== false) {
          tookEffect = switched === true;
          pointerUnknown = !tookEffect;
          // Nothing was undone: the in-progress record stays for the next startup to judge.
          if (pointerUnknown) cleaned = false;
          return;
        }
        result = undefined;
        if (dataRootRelocationCleanupState(failure) !== 'cleaned') {
          onProgress('正在撤销本次迁移在新目录里的改动');
          cleaned = await abandonStagedDataRootRelocation(prepared, { pointerUnchanged: true }).then(() => true, (error: unknown) => {
            console.warn('[LimCode] 撤销未完成的迁移失败，下次启动时再试。', error);
            cleanupProblem = describeError(error);
            // Held (someone wrote into the target since): never undone automatically, nothing is left to retry.
            return isUndoHeld(error);
          });
        }
      });
    }
  } finally {
    relocationRunning = false;
  }
  if (result && !failure) {
    await context.globalState.update(RELOCATION_NOTICE_KEY, describeResult(result));
    await reloadWindow();
    return;
  }
  if (tookEffect) {
    // The relocation took effect; only a finishing step failed (e.g. releasing the old directory).
    console.error('[LimCode] 数据目录迁移已完成，收尾时出错。', failure);
    await context.globalState.update(RELOCATION_NOTICE_KEY, result ? describeResult(result) : `数据目录已迁移到 ${plan.targetRootPath}。`);
    await vscode.window.showErrorMessage('数据目录迁移已完成', {
      modal: true, detail: `迁移已完成，收尾时出错：${describeError(failure)}\n\n数据目录已切换到 ${plan.targetRootPath}，旧目录没有改动。窗口将重载以打开新目录。`
    });
    await reloadWindow();
    return;
  }
  // An undo removes its record right before the copied data comes back: when that last step failed,
  // the copy is still beside the target and the relocation is not undone.
  const copy = await findDataRootRelocationCopy(plan.targetRootPath, relocationId).catch(() => undefined);
  if (copy) {
    cleaned = false;
    cleanupProblem = `从别处拷来的 LimCode 数据现在在 ${copy}，还没有改回原来的名字 ${plan.targetRootPath}。`;
  }
  // Undone: nothing is in progress any more. Otherwise the record stays, and the next startup
  // (a new process: this one then counts as ended) undoes the rest.
  if (cleaned) await updateGlobalStatusDataRoot(context, { pendingRelocation: null, expectedPendingRelocationId: relocationId }).catch(() => undefined);
  // What settling the earlier relocation's work left, item by item (see settleEarlierMovedWork).
  const left = leftOf(failure);
  const message = [describeError(failure), ...(left?.length ? describeCarriedWorkLeft(left).slice(0, -1) : [])].join('\n');
  console.error('[LimCode] 数据目录迁移失败。', failure);
  if (pointerUnknown) {
    await vscode.window.showErrorMessage('无法确认数据目录迁移的结果', {
      modal: true, detail: `${message}\n\n读不出数据目录指针，无法确认是否已经切换到新目录，所以新目录里的改动没有撤销；下次启动 LimCode 时会按指针打开并再判断。窗口将重载。`
    });
    await reloadWindow();
    return;
  }
  const detail = (cleaned
    ? cleanupProblem ?? '数据目录没有切换，旧目录没有改动；新目录里本次做的改动已撤销。'
    : `数据目录没有切换，旧目录没有改动；新目录里本次做的改动没能全部撤销，下次启动 LimCode 时会再撤销一次。${cleanupProblem ?? ''}`);
  if (runtimeClosed) {
    // This window's Runtime (and its settings page) is closed: only a native message is left.
    await vscode.window.showErrorMessage('数据目录迁移失败，仍然使用原目录', { modal: true, detail: `${message}\n\n${detail}窗口将重载以重新打开原目录。` });
    await reloadWindow();
    return;
  }
  await tell(ask, '数据目录迁移没有进行，仍然使用原目录', [message, detail]);
}

/** Whether the data-root pointer names this relocation (undefined: it cannot be read now). */
async function pointerSwitchedTo(context: vscode.ExtensionContext, targetRootPath: string, relocationId: string): Promise<boolean | undefined> {
  try {
    const status = await loadCommittedGlobalStatus(context);
    return sameFsPath(resolveDataRootUri(context, status.dataRootPath).fsPath, targetRootPath) && status.lastMigration?.relocationId === relocationId;
  } catch (error) {
    console.warn('[LimCode] 读取数据目录指针失败。', error);
    return undefined;
  }
}

/**
 * The one coordinated call of the data-directory commands: waits (outside the locks, up to the
 * primitive's limit) for other windows and for this window's own work, freezes this window before
 * any other window is told to go (beforeGo: until the operation ended no new work is taken up and
 * every write command is refused at its entry; still busy sends the call back outside the locks,
 * where it keeps waiting within the same limit), asks the other windows to reload with a countdown they cannot veto (the user
 * confirmed here), then runs `operation` under the configuration admission and the selected root's
 * maintenance claim. `operation` reports its stages to windows waiting to open. The key carries the
 * attempt's own id: every call is an explicit user action, and a new attempt after fixing a cause
 * is never held back by an earlier failure. The cooldown after other windows yielded is by operation,
 * whatever the key: only this window's retry passes it, with the operation's token that the layer
 * keeps in this window's workspaceState across the reload after a failure.
 */
async function exclusively<T>(
  host: DataRootRelocationHost,
  input: {
    operation: string; operationKey: string; message: string; waitingTitle: string; configurationRootPath: string;
    windowState: ExclusiveMaintenanceWindowState | undefined;
  },
  operation: (stage: (text: string) => void) => Promise<T>
): Promise<RuntimeExclusiveMaintenanceOutcome<T>> {
  // Read while the Runtime is open (the operation closes it).
  const { paths } = host.exclusiveMaintenanceTarget();
  try {
    return await coordinateExclusively(host, input, operation);
  } finally {
    // The key names this attempt only: its ledger entry is of no use once the attempt ended.
    await clearExclusiveMaintenanceKey(paths, input.operation, input.operationKey)
      .catch((error: unknown) => console.warn('[LimCode] 清理本次协调的记录失败。', error));
  }
}

async function coordinateExclusively<T>(
  host: DataRootRelocationHost,
  input: Parameters<typeof exclusively>[1],
  operation: (stage: (text: string) => void) => Promise<T>
): Promise<RuntimeExclusiveMaintenanceOutcome<T>> {
  const { paths, hostBootId } = host.exclusiveMaintenanceTarget();
  const ownWork = requesterWorkBusy(host);
  let announced = false;
  const requesterBusy = async (): Promise<ExclusiveMaintenanceBusy | undefined> => {
    const busy = await ownWork();
    if (busy && !announced) {
      announced = true;
      void vscode.window.showInformationMessage(`${EXTENSION_BRAND}：本窗口有任务正在进行，${input.message.replace(/^为/, '')}会等它结束后再进行（最多等 10 分钟）；在此之前请不要开始新的任务。`);
    }
    return busy;
  };
  return runWithExclusiveMaintenance(paths, {
    ...input,
    requesterHostBootId: hostBootId,
    requesterBusy,
    beforeGo: async () => {
      // What may throw runs before the freeze and only what cannot after it: the thaw always
      // reaches the primitive (a lost one would leave this window frozen).
      const busy = await ownWork();
      if (busy) return { busy: { ...busy, reason: '本窗口在确认之后开始了新的任务' } };
      // From here until the operation ended this window refuses every write command at its entry.
      const thaw = host.freezeNewWork(input.message.replace(/^为/, ''));
      // Work taken up between the check and the freeze; a check that fails counts as busy.
      const late = await ownWork().then(
        (found) => found && { ...found, reason: '本窗口在确认之后开始了新的任务' },
        (): ExclusiveMaintenanceBusy => ({ kind: 'work', reason: '无法确认本窗口是否空闲' })
      );
      return late ? { busy: late, thaw } : { thaw };
    },
    participantConfirmation: 'final-countdown',
    whenBusy: 'wait',
    ignoreBackoff: true,
    // Confirmed in the settings page and coordinating now: nothing to cancel (reloads may have begun).
    cancellable: false,
    isCurrent: () => true,
    withLocks: (body) => host.withDataRootLocks(body)
  }, async ({ reportStage }) => {
    if (await host.hasOwnedExecution()) {
      throw new DataRootRelocationError('data-root-requester-busy', '本窗口在最后一刻开始了新的任务，本次没有进行；任务结束后可以再试。');
    }
    return operation((text) => reportStage(text));
  });
}

async function publishRelocation(
  context: vscode.ExtensionContext,
  plan: DataRootRelocationPlan,
  relocationId: string,
  publication: DataRootRelocationPublication
): Promise<void> {
  await updateGlobalStatusDataRoot(context, {
    dataRootPath: plan.targetRootPath,
    dataRootId: publication.dataRootId,
    // The relocation id: only this relocation's completion record justifies deleting the old directory.
    lastMigration: { fromPath: plan.sourceRootPath, toPath: plan.targetRootPath, migratedAt: new Date().toISOString(), relocationId },
    pendingRelocation: null,
    expectedPendingRelocationId: relocationId
  });
}

/**
 * 回到迁移前的旧目录: switches the pointer back without copying; data written in the current
 * directory since the move stays there, and its completion record no longer justifies deleting the
 * old directory. Also offered when the current directory is unavailable (then without a Runtime).
 */
export async function returnToPreviousDataRoot(context: vscode.ExtensionContext, startup: ApplicationStartup, request?: unknown): Promise<void> {
  const status = await loadCommittedGlobalStatus(context);
  const current = resolveDataRootUri(context, status.dataRootPath).fsPath;
  const previous = previousDataRoot(status, current);
  const clientId = requestClientId(request);
  const host = await pendingHost(startup);
  const ask: Ask | undefined = host && clientId ? (prompt) => askInSettingsPage(host, clientId, prompt) : undefined;
  if (!previous) {
    await notify(ask, '没有旧数据目录', ['没有记录迁移前的旧数据目录。']);
    return;
  }
  const check = await inspectDataRootForReturn(previous);
  if (!check.usable) {
    await notify(ask, '旧数据目录现在无法打开', [check.message ?? previous]);
    return;
  }
  // The work this installation's relocation carried away: confirming the return settles it there first.
  // That relocation wrote its moved notice there before switching: not finding it, or not
  // understanding it, is never taken for "nothing moved" (its work would run there a second time).
  const relocationId = status.lastMigration?.relocationId;
  let moved: DataRootMovedNotice | undefined;
  if (relocationId) {
    const noticePath = path.join(previous, DATA_ROOT_MOVED_NOTICE_FILE);
    let read: Awaited<ReturnType<typeof inspectDataRootMovedNotice>>;
    try {
      read = await inspectDataRootMovedNotice(previous);
    } catch (error) {
      await notify(ask, '现在不能回到旧目录', [`读不出旧目录里的“数据已迁走”标记（${noticePath}：${describeError(error)}），无法确认迁走的任务在那里不会再执行一次。请稍后再试。`]);
      return;
    }
    const own = 'notice' in read && read.notice.installation.id === installationOf(context).id;
    if ('invalid' in read || !('notice' in read) || (own && read.notice.relocationId !== relocationId)) {
      await notify(ask, '现在不能回到旧目录', [
        'invalid' in read
          ? `旧目录里的“数据已迁走”标记读不懂（${noticePath}：${read.invalid}），`
          : `旧目录里找不到这次迁移留下的“数据已迁走”标记（${noticePath}），`,
        '无法确认迁走的任务在旧目录里不会再执行一次，所以没有切换，仍使用当前目录。'
      ]);
      return;
    }
    // Another installation's notice (it moved that directory on since): it governs opening it there.
    moved = read.notice;
  }
  const carried = moved?.carriedWork && moved.installation.id === installationOf(context).id && moved.relocationId === relocationId ? moved : undefined;
  const lines = [
    `旧目录：${previous}`,
    `当前目录：${current}`,
    '只切换数据目录，不复制也不合并：迁移之后在当前目录里新增或修改的对话不会带到旧目录，仍保存在当前目录；以后可以再迁移回来（会合并）。',
    ...(carried ? describeMovedWork(carried) : []),
    ...(relocationId && await isAvailable(current, status)
      ? ['在当前目录里删掉的、迁移时带过来的对话会记到旧目录的删除记录里：以后在旧目录里合并时不会把它们加回来；旧目录里原本就有的对话不会被删除。']
      : []),
    '当前目录的迁移记录会失效：之后要删除旧目录，需要再迁移一次。',
    '所有 LimCode 窗口会重载一次；有任务的窗口会等任务结束，未发送的输入会保留。'
  ];
  const confirmed = ask
    ? (await ask({ title: '回到迁移前的旧数据目录？', sections: [{ lines }], actions: [CANCEL, { key: 'return', label: '回到旧目录' }] })).choice === 'return'
    : await nativeConfirm('回到迁移前的旧数据目录？', lines, '回到旧目录');
  if (!confirmed) return;
  if (carried) {
    try {
      await consentToDataRootMovedWork(previous, carried.relocationId, installationOf(context).id);
    } catch (error) {
      await notify(ask, '没有回到旧目录', [`没能在旧目录里记下“迁走的任务按中止收尾”（${describeError(error)}），所以没有切换；可以稍后再试。`]);
      return;
    }
  }
  const switchPointer = async (): Promise<void> => {
    if (await isAvailable(current, status)) {
      // Deletions made here stay deletions there (for merges there; see carryDeletionRecordsBack).
      if (relocationId) {
        await carryDeletionRecordsBack({ currentRootPath: current, previousRootPath: previous, relocationId }).catch((error: unknown) => {
          throw new Error(`没能把在当前目录里记下的删除一并记到旧目录（${describeError(error)}），所以没有切换`);
        });
      }
      await invalidateDataRootRelocationRecord(current).catch((error: unknown) => console.warn('[LimCode] 当前目录的迁移记录没能标记为失效。', error));
    }
    await pointTo(context, previous, current);
  };
  const reachable = await isAvailable(current, status);
  if (host && reachable) {
    let runtimeClosed = false;
    let failure: unknown;
    try {
      const outcome = await exclusively(host, {
        operation: 'data-root-return', operationKey: `data-root-return:${previous}#${randomUUID()}`, message: '为切换回旧数据目录',
        waitingTitle: '回到旧目录：正在等待 LimCode 窗口空闲', configurationRootPath: host.dataRootPath(),
        windowState: context.workspaceState
      }, async (stage) => {
        runtimeClosed = true;
        stage('正在关闭本窗口的运行时');
        await host.closeRuntime();
        await assertConfigurationRootRuntimesOffline(host.dataRootPath());
        stage('正在切换回旧数据目录');
        await switchPointer();
      });
      if (outcome.state === 'completed') {
        await reloadWindow();
        return;
      }
      failure = new Error(outcome.reason);
    } catch (error) {
      failure = error;
    }
    if (runtimeClosed) {
      await vscode.window.showErrorMessage('没有切换数据目录', { modal: true, detail: `${describeError(failure)}\n\n窗口将重载以重新打开当前目录。` });
      await reloadWindow();
      return;
    }
    await notify(ask, '没有切换数据目录', [describeError(failure)]);
    return;
  }
  // No Runtime in this window, or one on a directory that became unreachable (closed here: it can no
  // longer work). A reachable current directory must have no other window on it; an unreachable one
  // cannot be coordinated through, and a window still running on it refuses configuration and asks
  // to reload once it sees the pointer change (pinnedDataRootPaths).
  if (host) await host.closeRuntime().catch((error: unknown) => console.warn('[LimCode] 关闭不可用目录上的运行时失败。', error));
  try {
    if (reachable) {
      await withRuntimeDataRootAdmission(current, async () => {
        await assertConfigurationRootRuntimesOffline(current);
        await switchPointer();
      });
    } else {
      await switchPointer();
    }
  } catch (error) {
    await vscode.window.showErrorMessage(`没有切换数据目录：${describeError(error)}。请关闭其它 LimCode 窗口后再试。`);
    return;
  }
  await reloadWindow();
}

/**
 * 删除旧目录: only what the current directory's completion record proves was carried over unchanged
 * (planOldDataRootDeletion); backups and archives only when ticked. The complete list is shown.
 */
export async function deletePreviousDataRoot(context: vscode.ExtensionContext, startup: ApplicationStartup, request?: unknown): Promise<void> {
  const clientId = requestClientId(request);
  if (!clientId) {
    await openSettingsPage('删除旧目录');
    return;
  }
  const host = await readyHost(startup);
  if (!host) {
    await vscode.window.showErrorMessage('运行时没有打开，不能删除旧数据目录。');
    return;
  }
  const ask: Ask = (prompt) => askInSettingsPage(host, clientId, prompt);
  const status = await loadCommittedGlobalStatus(context);
  const current = host.dataRootPath();
  const previous = previousDataRoot(status, current);
  if (!previous) {
    await tell(ask, '没有旧数据目录', ['没有记录迁移前的旧数据目录。']);
    return;
  }
  // VS Code's own storage directory also holds this extension's data-root pointer: it stays.
  const keepEntries = sameFsPath(previous, context.globalStorageUri.fsPath) ? [LIMCODE_GLOBAL_STATUS_FILE] : [];
  const relocationId = status.lastMigration?.relocationId;
  const input = { oldRootPath: previous, currentRootPath: current, keepEntries, ...(relocationId ? { relocationId } : {}) };
  const plan = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在核对旧目录…' },
    () => planOldDataRootDeletion(input));
  if (plan.problems.length > 0) {
    await tell(ask, '不能删除这个旧目录', plan.problems);
    return;
  }
  const required = plan.items.filter((item) => item.deletable && !item.optional);
  const optional = plan.items.filter((item) => item.deletable && item.optional);
  const keptItems = plan.items.filter((item) => !item.deletable);
  const keptLines = [
    ...keptItems.map((item) => `${item.label}：${item.reason ?? '保留'}`),
    ...plan.kept.map((entry) => `${entry.name}：${entry.reason}`)
  ];
  if (required.length === 0 && optional.length === 0) {
    await tell(ask, '旧目录里没有可以删除的 LimCode 数据', keptLines.length ? keptLines : ['旧目录里已经没有 LimCode 的数据。']);
    // A kept data set or archive is still listed from here (foreign history reads the old directory's archives).
    if (!keptItems.some((item) => item.kind === 'data-set' || item.kind === 'backup')) await forgetPreviousDataRoot(context);
    return;
  }
  const sections: DataRootPromptSection[] = [
    { lines: [`旧目录：${previous}`] },
    {
      title: `将删除（约 ${formatBytes(required.reduce((sum, item) => sum + item.bytes, 0))}）：`,
      lines: required.length ? required.map((item) => `${item.label}（${formatBytes(item.bytes)}）`) : ['（没有，只删除下面勾选的备份）']
    },
    ...(keptLines.length ? [{ title: '保留，不删除：', lines: keptLines }] : []),
    {
      lines: [
        '只删除确认迁移到当前目录、且迁移之后没有改动的内容；备份和归档默认保留，需要一起删除的请勾选。',
        '迁移时同一磁盘上的正文以硬链接共享，实际释放的空间可能少于上面的数字。此操作不能撤销。'
      ]
    }
  ];
  const answer = await ask({
    title: '永久删除旧数据目录中的 LimCode 数据？',
    sections,
    options: optional.map((item) => ({ key: item.key, label: `也删除：${item.label}（${formatBytes(item.bytes)}）` })),
    actions: [CANCEL, { key: 'delete', label: '永久删除', variant: 'danger' }],
    danger: true
  });
  if (answer.choice !== 'delete') return;
  const include = optional.filter((item) => answer.include.includes(item.key)).map((item) => item.key);
  let removed: { removed: string[]; remainingDataSets: number; remainingArchives?: number };
  try {
    removed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在删除旧数据目录中的 LimCode 数据…' },
      () => deleteOldDataRoot({ ...input, include, confirmedKeys: [...required.map((item) => item.key), ...include] }));
  } catch (error) {
    await tell(ask, '旧数据目录没有删除', [describeError(error)]);
    return;
  }
  // Archives kept in the old directory stay visible (外来历史库) only while it is remembered.
  if (removed.remainingDataSets === 0 && !removed.remainingArchives) await forgetPreviousDataRoot(context);
  await tell(ask, '已删除', [
    `已删除 ${removed.removed.length} 项。`,
    ...(removed.remainingDataSets > 0 ? [`旧目录里还保留 ${removed.remainingDataSets} 个历史库，设置页仍会显示这个旧目录。`] : []),
    ...(removed.remainingArchives
      ? [`旧目录里还保留 ${removed.remainingArchives} 份“归档并重置”留下的归档，列在“历史与存储管理 → 外来历史库”里${removed.remainingDataSets > 0 ? '' : '，设置页仍会显示这个旧目录'}。`] : [])
  ]);
}

/**
 * Startup could not open the configured directory: retry, go back to the old one, choose another
 * LimCode directory, or start over in the default directory. A directory that merely could not be
 * read right now (a network drive that hiccups) is only retried: it proves nothing about the data.
 * No Runtime (and no settings page) exists here, so these are native messages.
 */
export async function offerDataRootRecovery(
  context: vscode.ExtensionContext,
  startup: ApplicationStartup,
  message: string,
  reason?: DataRootUnavailableReason,
  error?: unknown
): Promise<void> {
  if (reason === 'unreadable' || reason === 'relocating' || reason === 'relocation-undoing') {
    // Temporary: the drive answers slowly, or a relocation into this directory is running or being undone.
    const note = reason === 'relocating' ? '迁移完成或撤销之后就能打开，请稍后重试。'
      : reason === 'relocation-undoing' ? '撤销完成之后就能打开，请稍后重试。' : '这通常是暂时的（网络盘或外置盘响应慢），请稍后重试。';
    const retry = await vscode.window.showErrorMessage(`${message}\n\n${note}`, '重试');
    if (retry === '重试') await reloadWindow();
    return;
  }
  const status = await loadCommittedGlobalStatus(context);
  const current = resolveDataRootUri(context, status.dataRootPath).fsPath;
  if (reason === 'unpublished') {
    const choice = await vscode.window.showErrorMessage(message, UNDO_UNPUBLISHED, '暂不打开');
    if (choice !== UNDO_UNPUBLISHED) return;
    try {
      const { held } = await undoUnpublishedDataRootRelocation(current);
      if (held) await vscode.window.showWarningMessage('那次迁移没有撤销', { modal: true, detail: `${held}\n\n这个目录会照常打开。` });
    } catch (error) {
      await vscode.window.showErrorMessage('没能撤销那次迁移', { modal: true, detail: describeError(error) });
      return;
    }
    await reloadWindow();
    return;
  }
  if (reason === 'moved-work-unsettled') {
    // Not all of it could be settled at this open: it stays consented and nothing ran; the next open settles again.
    const moved = await readDataRootMovedNotice(current).catch(() => undefined);
    const choice = await vscode.window.showErrorMessage(message, {
      modal: true, detail: describeCarriedWorkLeft(leftOf(error) ?? latestLeft(moved)).join('\n')
    }, '重试', ...(moved ? ['改用新目录'] : []));
    if (choice === '重试') await reloadWindow();
    else if (choice === '改用新目录' && moved) await switchToMovedDataRoot(context, undefined, current, moved.targetRootPath);
    return;
  }
  if (reason === 'moved-work') {
    const moved = await readDataRootMovedNotice(current).catch(() => undefined);
    if (!moved?.carriedWork) {
      await reloadWindow();
      return;
    }
    const choice = await vscode.window.showErrorMessage(message, {
      modal: true,
      detail: [
        `这个目录的数据已在 ${moved.movedAt.slice(0, 16).replace('T', ' ')} 由 ${moved.installation.label} 迁移到 ${moved.targetRootPath}。`,
        ...describeMovedWork(moved)
      ].join('\n')
    }, CONTINUE_HERE, '改用新目录', '暂不打开');
    if (choice === CONTINUE_HERE) {
      await consentToDataRootMovedWork(current, moved.relocationId, installationOf(context).id);
      await reloadWindow();
    } else if (choice === '改用新目录') {
      // Only the pointer moves: nothing runs here.
      await switchToMovedDataRoot(context, undefined, current, moved.targetRootPath);
    }
    return;
  }
  const previous = previousDataRoot(status, current);
  const canReturn = previous !== undefined && (await inspectDataRootForReturn(previous)).usable;
  // Its data was moved away (the old directory keeps the notice, also after its data was deleted);
  // a notice that cannot be understood ('moved-notice-invalid') still names where, when it can be read that far.
  const read = await inspectDataRootMovedNotice(current).catch(() => undefined);
  const moved = read && 'notice' in read ? read.notice : undefined;
  const movedTo = moved?.targetRootPath ?? (read && 'invalid' in read ? read.targetRootPath : undefined);
  const follow = movedTo && (await inspectDataRootForReturn(movedTo)).usable ? movedTo : undefined;
  const text = follow && moved
    ? `${message}\n\n这个目录的数据已在 ${moved.movedAt.slice(0, 16).replace('T', ' ')} 由 ${moved.installation.label} 迁移到 ${moved.targetRootPath}。`
    : follow ? `${message}\n\n标记里写的新目录：${follow}。` : message;
  const choice = await vscode.window.showErrorMessage(text, ...[
    '重试', ...(follow ? ['改用迁移后的目录'] : []), ...(canReturn ? ['回到旧目录'] : []), '选择其它目录…', '使用默认目录…'
  ]);
  if (choice === '重试') await reloadWindow();
  else if (choice === '改用迁移后的目录' && follow) await switchToMovedDataRoot(context, undefined, current, follow);
  else if (choice === '回到旧目录') await returnToPreviousDataRoot(context, startup);
  else if (choice === '选择其它目录…') await chooseOtherDataRoot(context, current);
  else if (choice === '使用默认目录…') await useDefaultDataRoot(context, startup, current);
}

async function chooseOtherDataRoot(context: vscode.ExtensionContext, current: string): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
    openLabel: '使用这个目录', title: '选择一个已有的 LimCode 数据目录'
  });
  if (!picked?.[0]) return;
  const chosen = picked[0].fsPath;
  const check = await inspectDataRootForReturn(chosen);
  if (!check.usable) {
    await vscode.window.showErrorMessage('不能使用这个目录', { modal: true, detail: `${check.message ?? chosen}\n\n只能选择一个已有 LimCode 数据的目录；要从头开始，请选择“使用默认目录”。` });
    return;
  }
  const confirmed = await nativeConfirm('切换到这个数据目录？', [
    `新数据目录：${chosen}`,
    `原来的目录：${current}`,
    '只切换数据目录，不复制也不合并；原来的目录不会被修改，它恢复可用后可以在设置页“回到旧目录”。',
    '这样切换过去的目录不能用来“删除旧目录”：没有复制，删除的依据只有迁移。'
  ], '切换并重载');
  if (!confirmed) return;
  await pointTo(context, chosen, current);
  await reloadWindow();
}

async function useDefaultDataRoot(context: vscode.ExtensionContext, startup: ApplicationStartup, current: string): Promise<void> {
  const defaultRoot = context.globalStorageUri.fsPath;
  const status = await loadCommittedGlobalStatus(context);
  if (status.lastMigration && sameFsPath(status.lastMigration.fromPath, defaultRoot) && sameFsPath(status.lastMigration.toPath, current)) {
    // The data came from there: going back is "回到旧目录" (it also invalidates the move's record).
    const choice = await vscode.window.showWarningMessage('默认目录就是迁移前的旧目录', {
      modal: true,
      detail: '请用“回到旧目录”切换回去：它同时让当前目录的迁移记录失效，避免以后按那份记录删除旧目录；两份历史也不会被混在一起。'
    }, '回到旧目录');
    if (choice === '回到旧目录') await returnToPreviousDataRoot(context, startup);
    return;
  }
  const existing = (await inspectDataRootForReturn(defaultRoot)).usable;
  const confirmed = await nativeConfirm('改用默认数据目录？', [
    `默认数据目录：${defaultRoot}`,
    `原来的目录：${current}`,
    existing
      ? '默认目录里已经有 LimCode 数据：那是以前留在那里的旧历史，不是原来目录里的数据。改用之后看到的是那份旧历史，原来目录里的对话不会带过去；以后把原来的目录迁移过来时，两边都改过的同一个对话会让合并整体取消。'
      : '默认目录里还没有 LimCode 数据，会在那里新建一份空的历史。',
    '原来的目录不会被修改；它恢复可用后可以在设置页“回到旧目录”，或把它迁移过来（会合并）。'
  ], '改用默认目录并重载');
  if (!confirmed) return;
  await pointTo(context, '', current);
  await reloadWindow();
}

/**
 * Switches the pointer without copying (回到旧目录, 选择其它目录, 使用默认目录, 改用迁移后的目录):
 * the record carries no relocation id, so it never justifies deleting the directory left behind.
 * This installation's own moved notice in the directory it goes to is cleared.
 */
async function pointTo(context: vscode.ExtensionContext, next: string, current: string): Promise<void> {
  const nextRoot = next || context.globalStorageUri.fsPath;
  const dataRootId = next ? await ensureDataRootIdentity(next) : null;
  await updateGlobalStatusDataRoot(context, {
    dataRootPath: next, dataRootId, lastMigration: { fromPath: current, toPath: nextRoot, migratedAt: new Date().toISOString() }
  });
  await clearDataRootMovedNotice(nextRoot, installationOf(context).id)
    .catch((error: unknown) => console.warn('[LimCode] 清除“数据已迁走”标记失败。', error));
}

/** This installation, as named in a moved notice: its own storage directory holds its data-root pointer. */
function installationOf(context: vscode.ExtensionContext): DataRootMovedNotice['installation'] {
  return { id: context.globalStorageUri.fsPath, label: `${vscode.env?.appName ?? 'VS Code'}（${os.hostname()}）` };
}

/**
 * A relocation recorded as in progress whose process is gone: its changes in the target are undone
 * and the record cleared. False (with the reason shown) while that is not possible yet; a target
 * that stays unreachable can be given up (see offerForgetRelocation).
 */
async function settleInterruptedRelocation(context: vscode.ExtensionContext, pending: PendingDataRootRelocation, ask?: Ask): Promise<boolean> {
  let problem: string | undefined;
  let unreachable = false;
  // Told once below: a relocation interrupted while it still moved data (not one whose failure and
  // unfinished undo were already told, which is only finished here).
  const interrupted = !ask && await relocationPhase(pending).catch(() => 'unknown' as const) === 'running';
  try {
    const outcome = await recoverInterruptedDataRootRelocation({
      targetRootPath: pending.targetRootPath, relocationId: pending.relocationId, ...(pending.targetAnchor ? { anchor: pending.targetAnchor } : {})
    });
    if (outcome === 'recovered' || outcome === 'absent') {
      await updateGlobalStatusDataRoot(context, { pendingRelocation: null, expectedPendingRelocationId: pending.relocationId });
      // At startup (its process is gone: the window closed or reloaded meanwhile): told once, since
      // the record is gone now. The user's own retry (ask) goes on without it.
      if (interrupted) {
        void vscode.window.showInformationMessage(`${EXTENSION_BRAND}：上次的数据目录迁移没有完成就中断了（进行迁移的窗口被关闭或重载），没有生效：`
          + `数据目录没有切换，原来的目录照常使用；${outcome === 'recovered' ? '它在新目录里留下的内容已撤销' : '新目录里没有留下它的内容'}。需要时可以重新迁移。`);
      }
      return true;
    }
    if (outcome === 'held' || outcome === 'orphaned') {
      // Never undone automatically (someone wrote there since, or what the undo needs is gone): nothing is left to retry.
      await updateGlobalStatusDataRoot(context, { pendingRelocation: null, expectedPendingRelocationId: pending.relocationId });
      const hold = outcome === 'held' ? await readDataRootRelocationHold(pending.targetRootPath).catch(() => undefined) : undefined;
      const lines = outcome === 'held'
        ? ['上次中断的数据目录迁移没有撤销。', hold?.message ?? '']
        : [`上次中断的数据目录迁移没有生效（数据目录没有切换，旧目录没有改动），但新目录 ${pending.targetRootPath} 里已经有那次迁移复制过去的数据；`
          + '撤销所需的记录已经不在了（可能已被另一个 LimCode 安装收尾），无法自动撤销，需要时请自行处理那里的数据。'];
      if (ask) await tell(ask, '上次的迁移没有撤销', lines);
      else void vscode.window.showWarningMessage(`${EXTENSION_BRAND}：${lines.join('')}`);
      return true;
    }
    unreachable = outcome === 'unreachable';
    problem = outcome === 'running' ? '那次迁移的进程可能还在运行。'
      : outcome === 'blocked' ? `新数据目录正被其它 LimCode 窗口使用（${pending.targetRootPath}），关闭它们后才能撤销。`
        : outcome === 'unreadable' ? `新数据目录里的当前历史库暂时读不出来（${pending.targetRootPath}），无法确认迁移之后没有别人写入；下次会再试。`
          : `新数据目录现在看不到（${pending.targetRootPath}；例如所在的盘没有接上、网络盘断开或盘符变了），接上后会自动撤销。`;
  } catch (error) {
    console.warn('[LimCode] 撤销中断的数据目录迁移失败，下次启动时再试。', error);
    problem = describeError(error);
  }
  const lines = ['上次中断的数据目录迁移还没有撤销完，下次启动 LimCode 时会再试；在此之前不能开始新的迁移。', problem];
  if (unreachable) return offerForgetRelocation(context, pending, lines, ask);
  if (ask) await tell(ask, '上次的迁移还没有撤销完', lines);
  else void vscode.window.showWarningMessage(`${EXTENSION_BRAND}：${lines.join('')}`);
  return false;
}

const CONTINUE_HERE = '在这里继续（已迁走的任务按中止收尾）';

/** What an item of carried work is (its inventory list, see relocatedWorkSettlement's RelocatedWorkItemList), for people. */
const WORK_ITEM_LABELS: Readonly<Record<string, string>> = {
  activeTurnIds: '进行中的回合',
  queuedIntentIds: '排队的消息或续跑',
  unfinishedModelRequestIds: '没完成的模型请求',
  pendingInteractionIds: '等待回答的提问或审批',
  childExecutionIds: '子 Agent',
  pendingDeliveryIds: '待投递的结果或消息',
  pendingProcessCompletionIds: '后台进程的完成通知',
  undeliveredAnswerIds: '子 Agent 的答复',
  unreceiptedEffectIds: '工具操作',
  otherRuntimeWork: '其它没完成的工作'
};

/**
 * The unfinished work a relocation carried away that is not settled yet: how much, and what
 * continuing here means (all of it is settled before anything runs; while any of it cannot be, the
 * directory does not open here).
 */
function describeMovedWork(notice: DataRootMovedNotice): string[] {
  const conversations = (notice.carriedWork?.dataSets ?? []).filter((item) => item.settlement.state !== 'settled')
    .flatMap((item) => item.inventory.conversations);
  if (conversations.length === 0) return [];
  const titles = conversations.slice(0, 5).map((conversation) => `“${conversation.title || conversation.conversationId}”`).join('、');
  return [
    `迁走时有 ${conversations.length} 个对话还有没完成的任务（${titles}${conversations.length > 5 ? ' 等' : ''}）。它们已随数据迁到新目录，可能已在那里执行过。`
      + '在这里继续使用时，打开时先把它们全部按中止收尾，收尾完之前这里不执行任何工作；'
      + '有收尾不了的（例如另一个窗口正占着它，或需要人工处理），这次就不打开，并逐条说明是哪一项、为什么、该怎么做。'
  ];
}

/** What a refused settlement left, from its error's causes (see RelocatedWorkLeftError). */
function leftOf(error: unknown): readonly DataRootCarriedWorkLeftItem[] | undefined {
  for (let cause = error, depth = 0; cause && depth < 4; cause = (cause as { cause?: unknown }).cause, depth += 1) {
    const items = (cause as { items?: unknown }).items;
    if (Array.isArray(items)) return items as DataRootCarriedWorkLeftItem[];
  }
  return undefined;
}

function latestLeft(notice: DataRootMovedNotice | undefined): readonly DataRootCarriedWorkLeftItem[] {
  const recorded = (notice?.carriedWork?.dataSets ?? []).flatMap((item) =>
    item.settlement.state === 'consented' && item.settlement.left ? [item.settlement.left] : []);
  return recorded.sort((a, b) => b.at.localeCompare(a.at))[0]?.items ?? [];
}

/**
 * What an open of the old directory could not settle, item by item: what it is, in which
 * Conversation, why, and what to do. Nothing of it ran; the next open settles the whole data set again.
 */
export function describeCarriedWorkLeft(items: readonly DataRootCarriedWorkLeftItem[]): string[] {
  const where = (item: DataRootCarriedWorkLeftItem): string => item.conversationId
    ? `对话“${item.title || item.conversationId}”里的${WORK_ITEM_LABELS[item.list] ?? item.list}（${item.id}）`
    : item.list === 'round' ? (/^round-\d+$/.test(item.id) ? `第 ${item.id.slice('round-'.length)} 轮收尾` : '收尾过程')
      : `${WORK_ITEM_LABELS[item.list] ?? item.list}（${item.id}）`;
  const why = (item: DataRootCarriedWorkLeftItem): string => item.why === 'live'
    ? '另一个 LimCode 窗口正在执行或占着它，这里收尾不了。关闭或重载那个窗口（或等它结束）之后重试。'
    : item.why === 'failed' ? `收尾时出错（${item.detail}）。可以重试；一直出错时可以改用新目录。`
      : item.why === 'needs_human' ? `停止流程收不掉它（${item.detail}）。可以稍后重试（它可能自己结束），或改用新目录，在那里处理这个对话。`
        : `收尾几轮之后仍不断出现新的工作（${item.detail}）。重试时会接着收尾；一直这样时可以改用新目录。`;
  return [
    ...(items.length > 0 ? ['还没收尾的项：', ...items.map((item) => `· ${where(item)}：${why(item)}`)] : []),
    '在全部收尾之前，这个目录不会在这里打开，里面的任何工作都不会执行；重试时会先把迁走的任务整库再收尾一次。'
  ];
}

const FORGET_RELOCATION = '放弃这次迁移的记录';
const FORGET_RELOCATION_NOTE = '放弃之后不会再尝试撤销：旧目录没有改动；新目录那边（如果以后又能访问）可能留有这次迁移的半截数据，需要时请自行删除。';

/**
 * A relocation whose target stays unreachable (a broken drive, a changed drive letter) would block
 * every later relocation: the user may give its record up after confirming what that means.
 */
async function offerForgetRelocation(context: vscode.ExtensionContext, pending: PendingDataRootRelocation, lines: Array<string | undefined>, ask?: Ask): Promise<boolean> {
  const text = lines.filter((line): line is string => !!line);
  let forget: boolean;
  if (ask) {
    const answer = await ask({
      title: '上次的迁移还没有撤销完', sections: [{ lines: [...text, FORGET_RELOCATION_NOTE] }],
      actions: [OK, { key: 'forget', label: FORGET_RELOCATION, variant: 'danger' }]
    });
    forget = answer.choice === 'forget';
  } else {
    forget = await vscode.window.showWarningMessage(`${EXTENSION_BRAND}：${text.join('')}`, `${FORGET_RELOCATION}…`) === `${FORGET_RELOCATION}…`
      && await nativeConfirm(`${FORGET_RELOCATION}？`, [`新数据目录：${pending.targetRootPath}`, FORGET_RELOCATION_NOTE], FORGET_RELOCATION);
  }
  if (!forget) return false;
  await updateGlobalStatusDataRoot(context, { pendingRelocation: null, expectedPendingRelocationId: pending.relocationId });
  return true;
}

/**
 * "迁移数据目录" again in the window whose earlier relocation could not be fully undone (its record
 * is this process's): the undo is tried once more now instead of waiting for the next startup.
 */
async function settleOwnRelocation(context: vscode.ExtensionContext, pending: PendingDataRootRelocation, ask: Ask): Promise<boolean> {
  let problem: string;
  try {
    // The record is still there, so the pointer never switched to this relocation.
    await abandonStagedDataRootRelocation({
      plan: { targetRootPath: pending.targetRootPath }, relocationId: pending.relocationId, ...(pending.targetAnchor ? { anchor: pending.targetAnchor } : {})
    }, { pointerUnchanged: true });
    const copy = await findDataRootRelocationCopy(pending.targetRootPath, pending.relocationId);
    if (!copy) {
      await updateGlobalStatusDataRoot(context, { pendingRelocation: null, expectedPendingRelocationId: pending.relocationId });
      return true;
    }
    problem = `从别处拷来的 LimCode 数据现在在 ${copy}，还没有改回原来的名字 ${pending.targetRootPath}。`;
  } catch (error) {
    if (isUndoHeld(error)) {
      await updateGlobalStatusDataRoot(context, { pendingRelocation: null, expectedPendingRelocationId: pending.relocationId });
      await tell(ask, '本窗口上次的迁移没有撤销', [describeError(error)]);
      return false;
    }
    if (isDataRootRelocationTargetInvisible(error)) {
      return offerForgetRelocation(context, pending, ['本窗口上次迁移时在新目录里做的改动还没有撤销。', describeError(error)], ask);
    }
    problem = describeError(error);
  }
  await tell(ask, '本窗口上次的迁移还没有撤销完', [
    '本窗口上次迁移时在新目录里做的改动还没有全部撤销，刚才又试了一次，仍没有成功；下次启动 LimCode 时会再试，在此之前不能开始新的迁移。',
    problem
  ]);
  return false;
}

function isOwnPending(pending: PendingDataRootRelocation): boolean {
  const identity = ownProcessStartIdentity();
  return pending.processId === process.pid && (!pending.processStartIdentity || !identity || pending.processStartIdentity === identity);
}

function isUndoHeld(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === 'data-root-relocation-undo-held';
}

/**
 * Before the Runtime opens: a relocation recorded as in progress whose process is gone is undone
 * (its changes in the target); one still moving data in a live process returns the text of a
 * progress notification for a window that reloaded for it and now waits on the old directory's
 * admission. One that failed in a live process and whose undo did not finish only gets a warning.
 */
export async function beforeDataRootOpen(context: vscode.ExtensionContext): Promise<string | undefined> {
  const status = await loadCommittedGlobalStatus(context);
  const pending = status.pendingRelocation;
  if (!pending) return undefined;
  const owner = ownerOf(pending);
  if (owner === 'dead') {
    await settleInterruptedRelocation(context, pending);
    return undefined;
  }
  const phase = await relocationPhase(pending);
  if (owner === 'alive' && phase === 'running') return '正在迁移数据目录，完成后自动打开';
  if (phase === 'unfinished') {
    void vscode.window.showWarningMessage(`${EXTENSION_BRAND}：${unfinishedElsewhere(pending)}这里照常打开原来的数据目录；如果那个窗口的撤销停下了，关闭或重载那个窗口后会自动处理。`);
  }
  return undefined;
}

/**
 * A relocation recorded as in progress (by a live or unknown process): still moving data
 * ('running'; also before its record in the target was written), or failed and being undone or
 * with its undo not finished ('unfinished': its record in the target says 'undoing' (written when an
 * undo starts) or 'held', or the copied data it renamed aside is still beside the target).
 * 'unknown' when the target's record cannot be read.
 */
async function relocationPhase(pending: PendingDataRootRelocation): Promise<'running' | 'unfinished' | 'unknown'> {
  let marker: { relocationId?: unknown; state?: unknown } | undefined;
  try {
    marker = JSON.parse(await fs.readFile(path.join(pending.targetRootPath, DATA_ROOT_RELOCATION_MARKER_FILE), 'utf8'));
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return 'unknown';
  }
  if (marker?.relocationId === pending.relocationId) {
    return marker.state === 'undoing' || marker.state === 'held' ? 'unfinished' : 'running';
  }
  // No record of it: not written yet, or an undo removed it right before the copy renamed aside comes back.
  const copy = await findDataRootRelocationCopy(pending.targetRootPath, pending.relocationId).catch(() => undefined);
  return copy ? 'unfinished' : 'running';
}

function unfinishedElsewhere(pending: PendingDataRootRelocation): string {
  return `另一个 LimCode 窗口迁移数据目录没有成功，它在新目录（${pending.targetRootPath}）里的改动正在撤销或还没有撤销完；`;
}

/**
 * After the Runtime opened: a relocation into this directory took effect (its journal goes),
 * abandoned private copies of crashed processes are removed, the result of a relocation that
 * reloaded this window is shown once, and a directory whose data another installation moved away
 * says so (without blocking).
 */
export async function afterDataRootOpened(context: vscode.ExtensionContext, dataRootPath: string, startup?: ApplicationStartup): Promise<void> {
  // Only this installation's own relocation into this directory, once its pointer names it.
  const opened = await loadCommittedGlobalStatus(context).catch(() => undefined);
  const publishedRelocationId = opened?.lastMigration && sameFsPath(opened.lastMigration.toPath, dataRootPath) ? opened.lastMigration.relocationId : undefined;
  await finalizeDataRootRelocation(dataRootPath, { installation: installationOf(context).id, ...(publishedRelocationId ? { publishedRelocationId } : {}) })
    .catch((error: unknown) => console.warn('[LimCode] 迁移收尾失败。', error));
  await sweepDataRootRelocationLeftovers(dataRootPath).catch((error: unknown) => console.warn('[LimCode] 清理中断操作留下的临时副本失败。', error));
  const notice = context.globalState.get<string>(RELOCATION_NOTICE_KEY);
  if (typeof notice === 'string' && notice) {
    await context.globalState.update(RELOCATION_NOTICE_KEY, undefined);
    void vscode.window.showInformationMessage(notice);
  }
  const hold = await readDataRootRelocationHold(dataRootPath).catch(() => undefined);
  if (hold && !(context.globalState.get<string[]>(HELD_NOTICE_DISMISSED_KEY) ?? []).includes(hold.relocationId)) {
    void vscode.window.showWarningMessage(`${EXTENSION_BRAND}：这个数据目录里有一次没有撤销的迁移。${hold.message}`, '不再提醒').then(async (choice) => {
      if (choice !== '不再提醒') return;
      const dismissed = context.globalState.get<string[]>(HELD_NOTICE_DISMISSED_KEY) ?? [];
      await context.globalState.update(HELD_NOTICE_DISMISSED_KEY, [...dismissed.filter((id) => id !== hold.relocationId), hold.relocationId]);
    });
  }
  const moved = await readDataRootMovedNotice(dataRootPath).catch(() => undefined);
  if (!moved) return;
  if (moved.installation.id === installationOf(context).id) {
    // This installation uses the directory again: its own notice is outdated.
    await clearDataRootMovedNotice(dataRootPath, moved.installation.id).catch(() => undefined);
    return;
  }
  const dismissed = context.globalState.get<string[]>(MOVED_NOTICE_DISMISSED_KEY) ?? [];
  if (dismissed.includes(moved.relocationId)) return;
  void warnMovedDataRoot(context, startup, dataRootPath, moved);
}

async function warnMovedDataRoot(context: vscode.ExtensionContext, startup: ApplicationStartup | undefined, current: string, moved: DataRootMovedNotice): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `${EXTENSION_BRAND}：这个数据目录的数据已在 ${moved.movedAt.slice(0, 16).replace('T', ' ')} 由另一个 LimCode 安装（${moved.installation.label}）`
      + `迁移到 ${moved.targetRootPath}。继续在这里使用，两边的历史会分叉（之后合并时，两边都改过的同一个对话会让合并整体取消）。`,
    '改用新目录', '不再提醒'
  );
  if (choice === '不再提醒') {
    const dismissed = context.globalState.get<string[]>(MOVED_NOTICE_DISMISSED_KEY) ?? [];
    await context.globalState.update(MOVED_NOTICE_DISMISSED_KEY, [...dismissed.filter((id) => id !== moved.relocationId), moved.relocationId]);
  } else if (choice === '改用新目录') {
    await switchToMovedDataRoot(context, startup, current, moved.targetRootPath);
  }
}

/** "改用新目录": this installation follows the data another installation moved (pointer only, like 选择其它目录). */
async function switchToMovedDataRoot(context: vscode.ExtensionContext, startup: ApplicationStartup | undefined, current: string, next: string): Promise<void> {
  const check = await inspectDataRootForReturn(next);
  if (!check.usable) {
    await vscode.window.showErrorMessage('不能改用这个目录', { modal: true, detail: `${next}\n\n${check.message ?? ''}` });
    return;
  }
  const confirmed = await nativeConfirm('改用迁移后的数据目录？', [
    `新数据目录：${next}`,
    `现在的目录：${current}`,
    '只切换本安装的数据目录，不复制也不合并；在现在的目录里新写的对话仍留在那里，以后可以把它迁移过去（会合并）。',
    '本安装的所有 LimCode 窗口会重载一次；有任务的窗口会等任务结束。'
  ], '改用并重载');
  if (!confirmed) return;
  const host = startup ? await pendingHost(startup) : undefined;
  let runtimeClosed = false;
  try {
    if (host) {
      const outcome = await exclusively(host, {
        operation: 'data-root-follow', operationKey: `data-root-follow:${next}#${randomUUID()}`, message: '为改用迁移后的数据目录',
        waitingTitle: '改用新目录：正在等待 LimCode 窗口空闲', configurationRootPath: host.dataRootPath(),
        windowState: context.workspaceState
      }, async (stage) => {
        runtimeClosed = true;
        stage('正在关闭本窗口的运行时');
        await host.closeRuntime();
        await assertConfigurationRootRuntimesOffline(host.dataRootPath());
        stage('正在切换数据目录');
        await pointTo(context, next, current);
      });
      if (outcome.state !== 'completed') throw new Error(outcome.reason);
    } else {
      await pointTo(context, next, current);
    }
  } catch (error) {
    await vscode.window.showErrorMessage(`没有切换数据目录：${describeError(error)}`);
    if (!runtimeClosed) return;
  }
  await reloadWindow();
}

async function forgetPreviousDataRoot(context: vscode.ExtensionContext): Promise<void> {
  await updateGlobalStatusDataRoot(context, { lastMigration: null });
}

function previousDataRoot(status: LimCodeGlobalStatus, current: string): string | undefined {
  const previous = status.lastMigration;
  return previous && sameFsPath(previous.toPath, current) && !sameFsPath(previous.fromPath, current) ? previous.fromPath : undefined;
}

function ownerOf(pending: PendingDataRootRelocation): 'alive' | 'dead' | 'unknown' {
  return dataRootRelocationOwnerState({
    processId: pending.processId, ...(pending.processStartIdentity ? { processStartIdentity: pending.processStartIdentity } : {})
  });
}

async function isAvailable(root: string, status: LimCodeGlobalStatus): Promise<boolean> {
  const expected = status.dataRootPath && sameFsPath(status.dataRootPath, root) ? status.dataRootId : undefined;
  return assertDataRootAvailable(root, expected).then(() => true, () => false);
}

function describePlan(plan: DataRootRelocationPlan): DataRootPromptSection[] {
  const moving = plan.others.filter((other) => !other.leaveBehind);
  const staying = plan.others.filter((other) => other.leaveBehind);
  const what = [
    `当前历史库：${plan.current.rows !== undefined ? `约 ${plan.current.rows} 行记录，` : ''}数据库 ${formatBytes(plan.current.databaseBytes)}，正文 ${formatBytes(plan.current.casBytes)}`
      + (plan.hardLinks ? '（同一磁盘上以硬链接共享，不重复占用）' : ''),
    ...(moving.length ? [`其它 ${moving.length} 个历史库（成为新目录里单独保留的库；已合并进当前库且之后没改动的不再单独复制）`] : []),
    `设置约 ${formatBytes(plan.configurationBytes)}`
      + (plan.configurationEntries.some((name) => ['AGENTS.md', 'CLAUDE.md', 'skills'].includes(name)) ? '，含全局规则和技能' : ''),
    ...staying.map((other) => `不迁移、留在旧目录：${other.id}（${other.leaveBehind}）`)
  ];
  return [
    { lines: [`当前目录：${plan.sourceRootPath}`, `新目录：${plan.targetRootPath}`] },
    { title: '要迁移：', lines: what },
    {
      title: '磁盘空间：',
      lines: plan.space.map((space) => `${space.label}：大约需要 ${formatBytes(space.requiredBytes)}`
        + (space.freeBytes !== undefined ? `，剩余 ${formatBytes(space.freeBytes)}` : ''))
    },
    {
      title: '过程：',
      lines: [
        '先在后台预先复制正文；然后等所有 LimCode 窗口（包括本窗口）的任务结束（最多 10 分钟，这期间开始新的任务会让迁移继续等），其它窗口倒计时后自动重载（已在这里确认，不能取消；未发送的输入会保留）。',
        '从其它窗口开始重载到迁移结束，本窗口不接受新消息、重试、压缩、改名、删除等修改（会提示“正在迁移数据目录，完成后再操作。”）；查看不受影响，输入框里的内容会保留。',
        '本窗口停止运行时，把历史库、设置、全局规则和技能写入新目录并逐项核对；全部成功后才切换到新目录，所有窗口重载一次。',
        '任何一步失败都不会切换，新目录里本次做的改动会被撤销。',
        '旧目录的数据不会被修改；之后可以在设置页“删除旧目录”（只删除确认迁移过去、且之后没有改动的内容，备份默认保留），或“回到旧目录”。'
      ]
    },
    ...(plan.warnings.length ? [{ title: '注意：', lines: plan.warnings }] : [])
  ];
}

function describeResult(result: DataRootRelocationResult): string {
  const parts = [`${EXTENSION_BRAND} 数据目录已迁移到 ${result.targetRootPath}`];
  if (result.others.migrated.length) parts.push(`${result.others.migrated.length} 个其它历史库已迁移为单独保留的库`);
  if (result.others.covered.length) parts.push(`${result.others.covered.length} 个已合并进当前库的历史库不再单独复制`);
  if (result.others.leftBehind.length) parts.push(`${result.others.leftBehind.length} 个历史库留在旧目录（见设置页）`);
  if (result.configuration.replacedFiles) parts.push(`被替换的旧设置版本在 ${result.configuration.backupPath}`);
  if (result.copiedDataMovedTo) parts.push(`新目录里原来那份拷贝过来的数据已改名保留在 ${result.copiedDataMovedTo}`);
  return `${parts.join('；')}。`;
}

async function tell(ask: Ask, title: string, lines: string[]): Promise<void> {
  await ask({ title, sections: [{ lines }], actions: [OK] });
}

async function notify(ask: Ask | undefined, title: string, lines: string[]): Promise<void> {
  if (ask) await tell(ask, title, lines);
  else await vscode.window.showErrorMessage(title, { modal: true, detail: lines.join('\n') });
}

async function nativeConfirm(title: string, lines: string[], action: string): Promise<boolean> {
  return (await vscode.window.showWarningMessage(title, { modal: true, detail: lines.join('\n\n') }, action)) === action;
}

async function readyHost(startup: ApplicationStartup): Promise<DataRootRelocationHost | undefined> {
  const host = await startup.wait().catch(() => undefined) as Partial<DataRootRelocationHost> | undefined;
  return isHost(host) ? host : undefined;
}

async function pendingHost(startup: ApplicationStartup): Promise<DataRootRelocationHost | undefined> {
  const host = await (startup.pending() ?? Promise.resolve(undefined)).catch(() => undefined) as Partial<DataRootRelocationHost> | undefined;
  return isHost(host) ? host : undefined;
}

function isHost(host: Partial<DataRootRelocationHost> | undefined): host is DataRootRelocationHost {
  return typeof host?.withDataRootLocks === 'function' && typeof host.closeRuntime === 'function' && typeof host.postToWebview === 'function'
    && typeof host.freezeNewWork === 'function'
    && typeof host.hasOwnedExecution === 'function' && typeof host.exclusiveMaintenanceTarget === 'function' && !!host.product;
}

function requestClientId(request: unknown): BridgeClientId | undefined {
  const clientId = (request as { clientId?: unknown } | null | undefined)?.clientId;
  return typeof clientId === 'string' && clientId ? clientId : undefined;
}

async function openSettingsPage(action: string): Promise<void> {
  await vscode.commands.executeCommand(EXTENSION_COMMAND_IDS.openPanel, { kind: 'globalSettings', reuse: true });
  void vscode.window.showInformationMessage(`请在设置页的数据目录一栏点“${action}…”。`);
}

async function checking<T>(run: () => Promise<T>): Promise<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在检查新数据目录…' }, run);
}

async function reloadWindow(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

function describeError(error: unknown): string {
  // A cancellation (the progress notification's "Cancel"): DOMException or Error named AbortError.
  if ((error as { name?: unknown } | undefined)?.name === 'AbortError') return '迁移已取消。';
  return error instanceof Error ? error.message : String(error ?? '未知原因');
}
