import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  LIMCODE_GLOBAL_STATUS_FILE, loadCommittedGlobalStatus, resolveDataRootUri, sameFsPath, saveGlobalStatus,
  type LimCodeGlobalStatus
} from '../../backend/capabilities/vscodeStorage/globalStatus';
import type { RuntimeRootPaths } from '../../backend/reliableKernel/contracts';
import {
  abandonStagedDataRootRelocation, assertDataRootAvailable, completeDataRootRelocation, deleteOldDataRoot, formatBytes,
  inspectDataRootForReturn, planDataRootRelocation, planOldDataRootDeletion, stageDataRootRelocation,
  type DataRootRelocationPlan, type DataRootRelocationResult, type StagedDataRootRelocation
} from '../../backend/reliableKernel/runtimeDataRootRelocation';
import type { RuntimeDatabase } from '../../backend/reliableKernel/runtimeDatabase';
import type { RuntimeExclusiveMaintenanceOutcome } from '../../backend/reliableKernel/runtimeExclusiveMaintenance';
import { withRuntimeDataRootAdmission } from '../../backend/reliableKernel/runtimeHostControl';
import { assertConfigurationRootRuntimesOffline } from '../../backend/reliableKernel/vscodeRootAuthority';
import type { ApplicationStartup } from '../ApplicationStartup';
import { runWithExclusiveMaintenance } from '../runtimeExclusiveMaintenance';

/** What the data-directory commands need of the open Runtime (the reliable-kernel Facade). */
export interface DataRootRelocationHost {
  product: { application: { database: RuntimeDatabase } };
  hasOwnedExecution(): Promise<boolean>;
  runWithDataRootOffline<T>(
    coordinate: Coordinate<T>,
    operation: () => Promise<T>
  ): Promise<{ outcome: RuntimeExclusiveMaintenanceOutcome<T> | { state: 'failed'; error: unknown }; runtimeClosed: boolean }>;
}

type Coordinate<T> = (
  paths: RuntimeRootPaths, requesterHostBootId: string, operation: () => Promise<T>
) => Promise<RuntimeExclusiveMaintenanceOutcome<T>>;

/**
 * 迁移数据目录: native folder picker, read-only checks, one modal confirmation, then the move
 * (runtimeDataRootRelocation) with every window of the old directory reloading once. Native
 * dialogs rather than Webview panels: the picker, the modal and the reload all belong to VS Code,
 * and the command also works from the command palette without a settings page.
 */
export async function relocateDataRoot(context: vscode.ExtensionContext, startup: ApplicationStartup): Promise<void> {
  const host = await startup.wait().catch(() => undefined) as Partial<DataRootRelocationHost> | undefined;
  if (!host?.runWithDataRootOffline || !host.product || !host.hasOwnedExecution) {
    await vscode.window.showErrorMessage('运行时没有打开，不能迁移数据目录。如果当前数据目录不可用，可以选择“回到迁移前的旧数据目录”。');
    return;
  }
  const status = await loadCommittedGlobalStatus(context);
  const sourceRootPath = resolveDataRootUri(context, status.dataRootPath).fsPath;
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
    openLabel: '迁移到这里', title: '选择新的 LimCode 数据目录（建议选择空文件夹）'
  });
  if (!picked?.[0]) return;
  let targetRootPath = picked[0].fsPath;
  let plan = await checking(() => planDataRootRelocation({ sourceRootPath, targetRootPath }));
  if (plan.problems.length === 0 && plan.target.kind === 'empty' && plan.target.unrelatedEntries > 0) {
    const nested = path.join(targetRootPath, 'LimCode');
    const choice = await vscode.window.showWarningMessage('所选文件夹里已经有其它文件', {
      modal: true,
      detail: `推荐在其中新建一个专用子文件夹：\n${nested}\n\n也可以直接使用所选文件夹；LimCode 会在其中新建自己的若干目录，其它文件不受影响。`
    }, '新建子文件夹', '直接使用所选文件夹');
    if (!choice) return;
    if (choice === '新建子文件夹') {
      targetRootPath = nested;
      plan = await checking(() => planDataRootRelocation({ sourceRootPath, targetRootPath }));
    }
  }
  if (plan.problems.length > 0) {
    await vscode.window.showErrorMessage('不能迁移到这个目录', { modal: true, detail: plan.problems.join('\n') });
    return;
  }
  if (await host.hasOwnedExecution()) {
    await vscode.window.showWarningMessage('本窗口有任务正在进行，请等任务结束（或停止任务）后再迁移数据目录。');
    return;
  }
  const confirmed = await vscode.window.showWarningMessage('迁移数据目录并重载所有 LimCode 窗口？', {
    modal: true, detail: describePlan(plan)
  }, '迁移并重载');
  if (confirmed !== '迁移并重载') return;
  await runRelocation(context, host as DataRootRelocationHost, plan);
}

async function runRelocation(context: vscode.ExtensionContext, host: DataRootRelocationHost, plan: DataRootRelocationPlan): Promise<void> {
  let result: DataRootRelocationResult | undefined;
  let failure: unknown;
  let runtimeClosed = false;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在迁移数据目录' }, async (progress) => {
    const onProgress = (message: string): void => progress?.report({ message });
    let staged: StagedDataRootRelocation;
    try {
      onProgress('正在准备新目录');
      staged = await stageDataRootRelocation(plan, host.product.application.database, { onProgress });
    } catch (error) {
      failure = error;
      return;
    }
    onProgress('等待其它窗口空闲后重载');
    const run = await host.runWithDataRootOffline(
      coordinate<DataRootRelocationResult>('data-root-relocation', `data-root-relocation:${plan.targetRootPath}`, '为迁移数据目录', plan.sourceRootPath),
      () => completeDataRootRelocation(staged, () => publishDataRoot(context, plan.sourceRootPath, plan.targetRootPath), { onProgress })
    );
    runtimeClosed = run.runtimeClosed;
    if (run.outcome.state === 'completed') {
      result = run.outcome.result;
      return;
    }
    // Once this Runtime closed, the completion ran and cleaned the target itself.
    if (!runtimeClosed) {
      await abandonStagedDataRootRelocation(staged).catch((error: unknown) => console.warn('[LimCode] 清理未完成迁移的新目录失败。', error));
    }
    failure = run.outcome.state === 'failed' ? run.outcome.error : new Error(run.outcome.reason);
  });
  if (result) {
    await vscode.window.showInformationMessage('数据目录已迁移', { modal: true, detail: describeResult(plan, result) });
    await reloadWindow();
    return;
  }
  const message = describeError(failure);
  console.error('[LimCode] 数据目录迁移失败。', failure);
  if (runtimeClosed) {
    await vscode.window.showErrorMessage('数据目录迁移失败，仍然使用原目录', {
      modal: true,
      detail: `${message}\n\n数据目录没有切换，原目录没有改动；新目录里本次创建的内容已清理。窗口将重载以重新打开原目录。`
    });
    await reloadWindow();
    return;
  }
  await vscode.window.showErrorMessage(`数据目录迁移没有进行，仍然使用原目录：${message}`);
}

/**
 * 回到迁移前的旧目录: switches the pointer back without copying; data written in the current
 * directory since the move stays there. Also offered when the current directory is unavailable.
 */
export async function returnToPreviousDataRoot(context: vscode.ExtensionContext, startup: ApplicationStartup): Promise<void> {
  const status = await loadCommittedGlobalStatus(context);
  const current = resolveDataRootUri(context, status.dataRootPath).fsPath;
  const previous = previousDataRoot(status, current);
  if (!previous) {
    await vscode.window.showInformationMessage('没有记录迁移前的旧数据目录。');
    return;
  }
  const check = await inspectDataRootForReturn(previous);
  if (!check.usable) {
    await vscode.window.showErrorMessage(`旧数据目录现在无法打开：${check.message ?? previous}`);
    return;
  }
  const confirmed = await vscode.window.showWarningMessage('回到迁移前的旧数据目录并重载所有 LimCode 窗口？', {
    modal: true,
    detail: `旧目录：${previous}\n当前目录：${current}\n\n只切换数据目录，不复制也不合并：迁移之后在当前目录里新增或修改的对话不会带到旧目录，仍保存在当前目录；以后可以再迁移回来（会合并）。`
  }, '回到旧目录');
  if (confirmed !== '回到旧目录') return;
  const publish = (): Promise<void> => publishDataRoot(context, current, previous);
  const host = await (startup.pending() ?? Promise.resolve(undefined)).catch(() => undefined) as Partial<DataRootRelocationHost> | undefined;
  if (!host?.runWithDataRootOffline) {
    // No Runtime in this window. When the current directory is reachable, other windows on it must
    // be closed first; when it is not (the usual reason to come here), none can be using it.
    const reachable = await assertDataRootAvailable(current).then(() => true, () => false);
    try {
      if (reachable) {
        await withRuntimeDataRootAdmission(current, async () => {
          await assertConfigurationRootRuntimesOffline(current);
          await publish();
        });
      } else {
        await publish();
      }
    } catch (error) {
      await vscode.window.showErrorMessage(`没有切换数据目录：${describeError(error)}。请关闭其它 LimCode 窗口后再试。`);
      return;
    }
    await reloadWindow();
    return;
  }
  const run = await host.runWithDataRootOffline(
    coordinate<void>('data-root-return', `data-root-return:${previous}`, '为切换回旧数据目录', current),
    publish
  );
  if (run.outcome.state === 'completed') {
    await reloadWindow();
    return;
  }
  const message = run.outcome.state === 'failed' ? describeError(run.outcome.error) : run.outcome.reason;
  if (run.runtimeClosed) {
    await vscode.window.showErrorMessage('没有切换数据目录', { modal: true, detail: `${message}\n\n窗口将重载以重新打开当前目录。` });
    await reloadWindow();
    return;
  }
  await vscode.window.showErrorMessage(`没有切换数据目录：${message}`);
}

/** 删除旧目录: only LimCode's own entries of the directory the data was moved away from. */
export async function deletePreviousDataRoot(context: vscode.ExtensionContext): Promise<void> {
  const status = await loadCommittedGlobalStatus(context);
  const current = resolveDataRootUri(context, status.dataRootPath).fsPath;
  const previous = previousDataRoot(status, current);
  if (!previous) {
    await vscode.window.showInformationMessage('没有记录迁移前的旧数据目录。');
    return;
  }
  // VS Code's own storage directory also holds this extension's data-root pointer: it stays.
  const keepEntries = sameFsPath(previous, context.globalStorageUri.fsPath) ? [LIMCODE_GLOBAL_STATUS_FILE] : [];
  const input = { oldRootPath: previous, currentRootPath: current, keepEntries };
  const plan = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在统计旧目录占用…' },
    () => planOldDataRootDeletion(input));
  if (plan.problems.length > 0) {
    await vscode.window.showErrorMessage('不能删除这个旧目录', { modal: true, detail: plan.problems.join('\n') });
    return;
  }
  if (plan.entries.length === 0) {
    await forgetPreviousDataRoot(context);
    await vscode.window.showInformationMessage('旧目录里已经没有 LimCode 的数据。');
    return;
  }
  const unmigrated = plan.unmigrated.length > 0
    ? `\n\n注意：旧目录里有 ${plan.unmigrated.length} 个历史库没有迁移到当前目录（${plan.unmigrated.join('、')}），删除后会永久丢失。` : '';
  const listed = plan.entries.slice(0, 12).join('\n') + (plan.entries.length > 12 ? `\n…等共 ${plan.entries.length} 项` : '');
  const confirmed = await vscode.window.showWarningMessage('永久删除旧数据目录中的 LimCode 数据？', {
    modal: true,
    detail: `旧目录：${previous}\n占用约 ${formatBytes(plan.bytes)}，将删除：\n${listed}${unmigrated}\n\n`
      + '只删除 LimCode 自己的目录和文件，目录里的其它文件保留。迁移时同一磁盘上的正文以硬链接共享，实际释放的空间可能少于上面的数字。此操作不能撤销。'
  }, '永久删除');
  if (confirmed !== '永久删除') return;
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在删除旧数据目录…' },
      () => deleteOldDataRoot(input));
  } catch (error) {
    await vscode.window.showErrorMessage(`旧数据目录没有删除：${describeError(error)}`);
    return;
  }
  await forgetPreviousDataRoot(context);
  await vscode.window.showInformationMessage('旧数据目录中的 LimCode 数据已删除。');
}

/** Startup could not open the configured directory: offer retry and, when possible, the old one. */
export async function offerDataRootRecovery(context: vscode.ExtensionContext, startup: ApplicationStartup, message: string): Promise<void> {
  const status = await loadCommittedGlobalStatus(context);
  const current = resolveDataRootUri(context, status.dataRootPath).fsPath;
  const previous = previousDataRoot(status, current);
  const canReturn = previous !== undefined && (await inspectDataRootForReturn(previous)).usable;
  const choice = await vscode.window.showErrorMessage(message, ...(canReturn ? ['重试', '回到旧目录'] : ['重试']));
  if (choice === '重试') await reloadWindow();
  else if (choice === '回到旧目录') await returnToPreviousDataRoot(context, startup);
}

function coordinate<T>(operation: string, operationKey: string, message: string, configurationRootPath: string): Coordinate<T> {
  return (paths, requesterHostBootId, run) => runWithExclusiveMaintenance(paths, {
    operation,
    operationKey,
    message,
    waitingTitle: '正在等待其它 LimCode 窗口空闲后重载',
    configurationRootPath,
    requesterHostBootId,
    // The user confirmed here; other windows only see a notice and reload once their work ends.
    participantConfirmation: 'notice',
    whenBusy: 'wait',
    ignoreBackoff: true,
    isCurrent: () => true
  }, run);
}

async function publishDataRoot(context: vscode.ExtensionContext, fromPath: string, toPath: string): Promise<void> {
  const status = await loadCommittedGlobalStatus(context);
  await saveGlobalStatus(context, toPath, status.proxy, { fromPath, toPath, migratedAt: new Date().toISOString() }, status.proxyShellAndMcp === true);
}

async function forgetPreviousDataRoot(context: vscode.ExtensionContext): Promise<void> {
  const status = await loadCommittedGlobalStatus(context);
  await saveGlobalStatus(context, status.dataRootPath, status.proxy, null, status.proxyShellAndMcp === true);
}

function previousDataRoot(status: LimCodeGlobalStatus, current: string): string | undefined {
  const previous = status.lastMigration;
  return previous && sameFsPath(previous.toPath, current) && !sameFsPath(previous.fromPath, current) ? previous.fromPath : undefined;
}

function describePlan(plan: DataRootRelocationPlan): string {
  const othersBytes = plan.others.reduce((sum, item) => sum + item.bytes, 0);
  const lines = [
    `当前目录：${plan.sourceRootPath}`,
    `新目录：${plan.targetRootPath}`,
    '',
    `要迁移：当前历史库约 ${formatBytes(plan.current.bytes)}（其中正文 ${formatBytes(plan.current.casBytes)}${plan.sameDevice ? '，同一磁盘上以硬链接共享，不重复占用' : ''}）`
      + (plan.others.length ? `、其它 ${plan.others.length} 个历史库约 ${formatBytes(othersBytes)}` : '')
      + `、设置约 ${formatBytes(plan.configurationBytes)}。`,
    plan.freeBytes !== undefined ? `新目录所在磁盘剩余 ${formatBytes(plan.freeBytes)}，预计需要 ${formatBytes(plan.requiredBytes)}。` : '',
    '',
    '过程：先在后台预先复制正文，期间可以继续使用；然后请其它 LimCode 窗口在任务结束后重载（未发送的输入会保留），'
      + '本窗口停止运行时，把历史库和设置写入新目录并逐项核对；全部成功后才切换到新目录，所有窗口重载一次。'
      + '任何一步失败都不会切换，新目录里本次创建的内容会被清理。',
    '旧目录原样保留；之后可以在设置页“删除旧目录”，或在新目录不可用时“回到旧目录”。',
    ...(plan.warnings.length ? ['', ...plan.warnings] : [])
  ];
  return lines.filter((line, index, all) => line !== '' || (index > 0 && all[index - 1] !== '')).join('\n');
}

function describeResult(plan: DataRootRelocationPlan, result: DataRootRelocationResult): string {
  const lines = [
    `新目录：${result.targetRootPath}`,
    `当前历史库：新增 ${result.merged.insertedConversations} 个对话（${result.merged.insertedRows} 行记录），正文 ${result.merged.linkedCasObjects + result.merged.copiedCasObjects + result.merged.reusedCasObjects} 个文件已核对。`,
    `设置：复制 ${result.configuration.copiedFiles} 个文件`
      + (result.configuration.replacedFiles ? `，${result.configuration.replacedFiles} 个被替换的旧版本放在 ${result.configuration.backupPath}` : '') + '。',
    ...(result.others.migrated.length ? [`其它历史库：${result.others.migrated.length} 个已迁移为独立的历史库（不会自动合并）。`] : []),
    ...(result.others.leftBehind.length
      ? [`以下历史库没有迁移，仍在旧目录：\n${result.others.leftBehind.map((item) => `${item.id}：${item.reason}`).join('\n')}`] : []),
    `旧目录保留在：${plan.sourceRootPath}`,
    '',
    '窗口将重载。'
  ];
  return lines.join('\n');
}

async function checking<T>(run: () => Promise<T>): Promise<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在检查新数据目录…' }, run);
}

async function reloadWindow(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '未知原因');
}
