import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  LIMCODE_GLOBAL_STATUS_FILE, loadCommittedGlobalStatus, resolveDataRootUri, sameFsPath, updateGlobalStatusDataRoot,
  type LimCodeGlobalStatus, type PendingDataRootRelocation
} from '../../backend/capabilities/vscodeStorage/globalStatus';
import type { RuntimeRootPaths } from '../../backend/reliableKernel/contracts';
import { ownProcessStartIdentity } from '../../backend/reliableKernel/runtimeClaimPrimitives';
import {
  abandonStagedDataRootRelocation, assertDataRootAvailable, completeDataRootRelocation, dataRootRelocationCleanupState,
  dataRootRelocationOwnerState, DataRootRelocationError, deleteOldDataRoot, ensureDataRootIdentity, finalizeDataRootRelocation,
  formatBytes, inspectDataRootForReturn, invalidateDataRootRelocationRecord, planDataRootRelocation, planOldDataRootDeletion,
  recoverInterruptedDataRootRelocation, stageDataRootRelocation, sweepDataRootRelocationLeftovers,
  type DataRootRelocationPlan, type DataRootRelocationPublication, type DataRootRelocationResult, type StagedDataRootRelocation
} from '../../backend/reliableKernel/runtimeDataRootRelocation';
import type { RuntimeDatabase } from '../../backend/reliableKernel/runtimeDatabase';
import type { ExclusiveMaintenanceBusy, RuntimeExclusiveMaintenanceOutcome } from '../../backend/reliableKernel/runtimeExclusiveMaintenance';
import { withRuntimeDataRootAdmission } from '../../backend/reliableKernel/runtimeHostControl';
import { assertConfigurationRootRuntimesOffline } from '../../backend/reliableKernel/vscodeRootAuthority';
import { EXTENSION_BRAND, EXTENSION_COMMAND_IDS } from '../../shared/extensionIdentity';
import type { BridgeClientId, DataRootPromptSection, ExtensionToWebviewMessage } from '../../shared/protocol';
import type { ApplicationStartup } from '../ApplicationStartup';
import { askInSettingsPage, type DataRootPrompt, type DataRootPromptAnswer } from '../dataRootPrompts';
import { requesterWorkBusy, runWithExclusiveMaintenance } from '../runtimeExclusiveMaintenance';

/** What the data-directory commands need of the open Runtime (the reliable-kernel Facade). */
export interface DataRootRelocationHost {
  product: { application: { database: RuntimeDatabase } };
  hasOwnedExecution(): Promise<boolean>;
  exclusiveMaintenanceTarget(): { paths: RuntimeRootPaths; hostBootId: string };
  dataRootPath(): string;
  withDataRootLocks<R>(body: () => Promise<R>): Promise<R>;
  closeRuntime(): Promise<void>;
  postToWebview(clientId: BridgeClientId, message: ExtensionToWebviewMessage): boolean;
}

/** Shown once after the reload that follows a relocation. */
const RELOCATION_NOTICE_KEY = 'limcode.dataRootRelocationNotice';
const CANCEL = { key: 'cancel', label: '取消', variant: 'secondary' as const };
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
    await tell(ask, '已有迁移正在进行', ['另一个 LimCode 窗口正在迁移数据目录，请等它完成后再试。']);
    return;
  }
  const sourceRootPath = host.dataRootPath();
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
    openLabel: '迁移到这里', title: '选择新的 LimCode 数据目录（建议选择空文件夹）'
  });
  if (!picked?.[0]) return;
  const sourceDatabase = host.product.application.database;
  let plan = await checking(() => planDataRootRelocation({ sourceRootPath, targetRootPath: picked[0].fsPath, sourceDatabase }));
  if (plan.target.kind === 'occupied') {
    const nested = plan.target.suggestedPath;
    const answer = await ask({
      title: '所选文件夹里已有其它文件',
      description: `LimCode 不会把数据放进已有其它文件的文件夹，只能放在其中新建的专用子文件夹里：${nested}`,
      sections: [{ title: `所选文件夹里已有 ${plan.target.entries.length} 项（都不会被改动）：`, lines: plan.target.entries }],
      actions: [CANCEL, { key: 'nested', label: '使用这个子文件夹' }]
    });
    if (answer.choice !== 'nested') return;
    plan = await checking(() => planDataRootRelocation({ sourceRootPath, targetRootPath: nested, sourceDatabase }));
  }
  if (plan.problems.length > 0) {
    await tell(ask, '不能迁移到这个目录', plan.problems);
    return;
  }
  if (await host.hasOwnedExecution()) {
    await tell(ask, '本窗口有任务正在进行', ['请等任务结束（或停止任务）后再迁移数据目录。']);
    return;
  }
  const confirmed = await ask({
    title: '迁移数据目录并重载所有 LimCode 窗口？',
    sections: describePlan(plan),
    actions: [CANCEL, { key: 'relocate', label: '迁移并重载' }]
  });
  if (confirmed.choice !== 'relocate') return;
  await runRelocation(context, host, plan, ask);
}

async function runRelocation(context: vscode.ExtensionContext, host: DataRootRelocationHost, plan: DataRootRelocationPlan, ask: Ask): Promise<void> {
  const relocationId = randomUUID();
  const identity = ownProcessStartIdentity();
  await updateGlobalStatusDataRoot(context, {
    pendingRelocation: {
      relocationId, sourceRootPath: plan.sourceRootPath, targetRootPath: plan.targetRootPath, startedAt: new Date().toISOString(),
      processId: process.pid, ...(identity ? { processStartIdentity: identity } : {})
    }
  });
  let result: DataRootRelocationResult | undefined;
  let failure: unknown;
  let runtimeClosed = false;
  let cleaned = true;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在迁移数据目录', cancellable: true }, async (progress, token) => {
    const onProgress = (message: string): void => progress?.report({ message });
    let staged: StagedDataRootRelocation;
    // "Cancel" stops the online pre-copy; once every window is asked to go offline it is too late.
    const cancel = new AbortController();
    const cancellation = token?.onCancellationRequested(() => cancel.abort());
    try {
      onProgress('正在准备新目录');
      staged = await stageDataRootRelocation(plan, host.product.application.database, { onProgress, relocationId, signal: cancel.signal });
    } catch (error) {
      failure = error;
      return;
    } finally {
      cancellation?.dispose();
    }
    onProgress('等待所有 LimCode 窗口空闲');
    try {
      const outcome = await exclusively(host, {
        operation: 'data-root-relocation',
        operationKey: `data-root-relocation:${plan.targetRootPath}`,
        message: '为迁移数据目录',
        waitingTitle: '迁移数据目录：正在等待 LimCode 窗口空闲',
        configurationRootPath: plan.sourceRootPath
      }, async () => {
        runtimeClosed = true;
        await host.closeRuntime();
        return completeDataRootRelocation(staged, (publication) => publishRelocation(context, plan, publication), { onProgress });
      });
      if (outcome.state === 'completed') {
        result = outcome.result;
        return;
      }
      failure = new Error(outcome.reason);
    } catch (error) {
      failure = error;
    }
    if (dataRootRelocationCleanupState(failure) !== 'cleaned') {
      cleaned = await abandonStagedDataRootRelocation(staged).then(() => true, (error: unknown) => {
        console.warn('[LimCode] 撤销未完成的迁移失败，下次启动时再试。', error);
        return false;
      });
    }
  });
  if (result) {
    await context.globalState.update(RELOCATION_NOTICE_KEY, describeResult(result));
    await reloadWindow();
    return;
  }
  // Undone: nothing is in progress any more. Otherwise the record stays, and the next startup
  // (a new process: this one then counts as ended) undoes the rest.
  if (cleaned) await updateGlobalStatusDataRoot(context, { pendingRelocation: null }).catch(() => undefined);
  const message = describeError(failure);
  console.error('[LimCode] 数据目录迁移失败。', failure);
  const detail = cleaned
    ? '数据目录没有切换，旧目录没有改动；新目录里本次做的改动已撤销。'
    : '数据目录没有切换，旧目录没有改动；新目录里本次做的改动没能全部撤销，下次启动 LimCode 时会再撤销一次。';
  if (runtimeClosed) {
    // This window's Runtime (and its settings page) is closed: only a native message is left.
    await vscode.window.showErrorMessage('数据目录迁移失败，仍然使用原目录', { modal: true, detail: `${message}\n\n${detail}窗口将重载以重新打开原目录。` });
    await reloadWindow();
    return;
  }
  await tell(ask, '数据目录迁移没有进行，仍然使用原目录', [message, detail]);
}

/**
 * The one coordinated call of the data-directory commands: waits (outside the locks, up to the
 * primitive's limit) for other windows and for this window's own work, asks the other windows to
 * reload with a countdown they cannot veto (the user confirmed here), then runs `operation` under
 * the configuration admission and the selected root's maintenance claim. This window's own work
 * is checked once more right before `operation` closes its Runtime; a new task started after the
 * confirmation is announced once (the move waits for it).
 */
async function exclusively<T>(
  host: DataRootRelocationHost,
  input: { operation: string; operationKey: string; message: string; waitingTitle: string; configurationRootPath: string },
  operation: () => Promise<T>
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
    participantConfirmation: 'final-countdown',
    whenBusy: 'wait',
    ignoreBackoff: true,
    isCurrent: () => true,
    withLocks: (body) => host.withDataRootLocks(body)
  }, async () => {
    if (await host.hasOwnedExecution()) {
      throw new DataRootRelocationError('data-root-requester-busy', '本窗口在最后一刻开始了新的任务，本次没有进行；任务结束后可以再试。');
    }
    return operation();
  });
}

async function publishRelocation(context: vscode.ExtensionContext, plan: DataRootRelocationPlan, publication: DataRootRelocationPublication): Promise<void> {
  await updateGlobalStatusDataRoot(context, {
    dataRootPath: plan.targetRootPath,
    dataRootId: publication.dataRootId,
    lastMigration: { fromPath: plan.sourceRootPath, toPath: plan.targetRootPath, migratedAt: new Date().toISOString() },
    pendingRelocation: null
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
  const lines = [
    `旧目录：${previous}`,
    `当前目录：${current}`,
    '只切换数据目录，不复制也不合并：迁移之后在当前目录里新增或修改的对话不会带到旧目录，仍保存在当前目录；以后可以再迁移回来（会合并）。',
    '当前目录的迁移记录会失效：之后要删除旧目录，需要再迁移一次。',
    '所有 LimCode 窗口会重载一次；有任务的窗口会等任务结束，未发送的输入会保留。'
  ];
  const confirmed = ask
    ? (await ask({ title: '回到迁移前的旧数据目录？', sections: [{ lines }], actions: [CANCEL, { key: 'return', label: '回到旧目录' }] })).choice === 'return'
    : await nativeConfirm('回到迁移前的旧数据目录？', lines, '回到旧目录');
  if (!confirmed) return;
  const switchPointer = async (): Promise<void> => {
    if (await isAvailable(current, status)) {
      await invalidateDataRootRelocationRecord(current).catch((error: unknown) => console.warn('[LimCode] 当前目录的迁移记录没能标记为失效。', error));
    }
    const dataRootId = await ensureDataRootIdentity(previous);
    await updateGlobalStatusDataRoot(context, {
      dataRootPath: previous, dataRootId, lastMigration: { fromPath: current, toPath: previous, migratedAt: new Date().toISOString() }
    });
  };
  const reachable = await isAvailable(current, status);
  if (host && reachable) {
    let runtimeClosed = false;
    let failure: unknown;
    try {
      const outcome = await exclusively(host, {
        operation: 'data-root-return', operationKey: `data-root-return:${previous}`, message: '为切换回旧数据目录',
        waitingTitle: '回到旧目录：正在等待 LimCode 窗口空闲', configurationRootPath: host.dataRootPath()
      }, async () => {
        runtimeClosed = true;
        await host.closeRuntime();
        await assertConfigurationRootRuntimesOffline(host.dataRootPath());
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
  const input = { oldRootPath: previous, currentRootPath: current, keepEntries };
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
    if (!keptItems.some((item) => item.kind === 'data-set')) await forgetPreviousDataRoot(context);
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
  let removed: { removed: string[]; remainingDataSets: number };
  try {
    removed = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在删除旧数据目录中的 LimCode 数据…' },
      () => deleteOldDataRoot({ ...input, include, confirmedKeys: [...required.map((item) => item.key), ...include] }));
  } catch (error) {
    await tell(ask, '旧数据目录没有删除', [describeError(error)]);
    return;
  }
  if (removed.remainingDataSets === 0) await forgetPreviousDataRoot(context);
  await tell(ask, '已删除', [
    `已删除 ${removed.removed.length} 项。`,
    ...(removed.remainingDataSets > 0 ? [`旧目录里还保留 ${removed.remainingDataSets} 个历史库，设置页仍会显示这个旧目录。`] : [])
  ]);
}

/**
 * Startup could not open the configured directory: retry, go back to the old one, choose another
 * LimCode directory, or start over in the default directory. No Runtime (and no settings page)
 * exists here, so these are native messages.
 */
export async function offerDataRootRecovery(context: vscode.ExtensionContext, startup: ApplicationStartup, message: string): Promise<void> {
  const status = await loadCommittedGlobalStatus(context);
  const current = resolveDataRootUri(context, status.dataRootPath).fsPath;
  const previous = previousDataRoot(status, current);
  const canReturn = previous !== undefined && (await inspectDataRootForReturn(previous)).usable;
  const choice = await vscode.window.showErrorMessage(message, ...[
    '重试', ...(canReturn ? ['回到旧目录'] : []), '选择其它目录…', '使用默认目录…'
  ]);
  if (choice === '重试') await reloadWindow();
  else if (choice === '回到旧目录') await returnToPreviousDataRoot(context, startup);
  else if (choice === '选择其它目录…') await chooseOtherDataRoot(context, current);
  else if (choice === '使用默认目录…') await useDefaultDataRoot(context, current);
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
    '只切换数据目录，不复制也不合并；原来的目录不会被修改，它恢复可用后可以在设置页“回到旧目录”。'
  ], '切换并重载');
  if (!confirmed) return;
  const dataRootId = await ensureDataRootIdentity(chosen);
  await updateGlobalStatusDataRoot(context, {
    dataRootPath: chosen, dataRootId, lastMigration: { fromPath: current, toPath: chosen, migratedAt: new Date().toISOString() }
  });
  await reloadWindow();
}

async function useDefaultDataRoot(context: vscode.ExtensionContext, current: string): Promise<void> {
  const defaultRoot = context.globalStorageUri.fsPath;
  const confirmed = await nativeConfirm('改用默认数据目录？', [
    `默认数据目录：${defaultRoot}`,
    `原来的目录：${current}`,
    '如果默认目录里还没有 LimCode 数据，会在那里新建一份空的历史。',
    '原来的目录不会被修改；它恢复可用后可以在设置页“回到旧目录”，或把它迁移过来（会合并）。'
  ], '改用默认目录并重载');
  if (!confirmed) return;
  await updateGlobalStatusDataRoot(context, {
    dataRootPath: '', dataRootId: null, lastMigration: { fromPath: current, toPath: defaultRoot, migratedAt: new Date().toISOString() }
  });
  await reloadWindow();
}

/**
 * Before the Runtime opens: a relocation recorded as in progress whose process is gone is undone
 * (its changes in the target); one still running returns the text of a progress notification for
 * a window that reloaded for it and now waits on the old directory's admission.
 */
export async function beforeDataRootOpen(context: vscode.ExtensionContext): Promise<string | undefined> {
  const status = await loadCommittedGlobalStatus(context);
  const pending = status.pendingRelocation;
  if (!pending) return undefined;
  if (ownerOf(pending) !== 'dead') return '正在迁移数据目录，完成后自动打开';
  const outcome = await recoverInterruptedDataRootRelocation({ targetRootPath: pending.targetRootPath, relocationId: pending.relocationId })
    .catch((error: unknown) => {
      console.warn('[LimCode] 撤销中断的数据目录迁移失败，下次启动时再试。', error);
      return 'failed' as const;
    });
  if (outcome === 'recovered' || outcome === 'absent') {
    const latest = await loadCommittedGlobalStatus(context);
    if (latest.pendingRelocation?.relocationId === pending.relocationId) await updateGlobalStatusDataRoot(context, { pendingRelocation: null });
  }
  return undefined;
}

/**
 * After the Runtime opened: a relocation into this directory took effect (its journal goes),
 * abandoned private copies of crashed processes are removed, and the result of a relocation that
 * reloaded this window is shown once.
 */
export async function afterDataRootOpened(context: vscode.ExtensionContext, dataRootPath: string): Promise<void> {
  await finalizeDataRootRelocation(dataRootPath).catch((error: unknown) => console.warn('[LimCode] 迁移收尾失败。', error));
  await sweepDataRootRelocationLeftovers(dataRootPath).catch((error: unknown) => console.warn('[LimCode] 清理中断操作留下的临时副本失败。', error));
  const notice = context.globalState.get<string>(RELOCATION_NOTICE_KEY);
  if (typeof notice === 'string' && notice) {
    await context.globalState.update(RELOCATION_NOTICE_KEY, undefined);
    void vscode.window.showInformationMessage(notice);
  }
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
    `当前历史库：约 ${plan.current.rows} 行记录，数据库 ${formatBytes(plan.current.databaseBytes)}，正文 ${formatBytes(plan.current.casBytes)}`
      + (plan.sameDevice ? '（同一磁盘上以硬链接共享，不重复占用）' : ''),
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
        '先在后台预先复制正文；然后等所有 LimCode 窗口（包括本窗口）的任务结束，其它窗口倒计时后自动重载（已在这里确认，不能取消；未发送的输入会保留）。这期间开始新的任务会让迁移继续等待（最多 10 分钟）。',
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
