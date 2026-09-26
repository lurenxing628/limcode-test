import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { loadCommittedGlobalStatus, resolveDataRootUri } from '../../backend/capabilities/vscodeStorage/globalStatus';
import { createVscodeStoragePaths } from '../../backend/capabilities/vscodeStorage/paths';
import {
  inspectVscodeRuntimeDataSets, resolveVscodeRuntimeDataSet, selectVscodeRuntimeDataSet, VscodeRuntimeDataSetSelectionRequiredError,
  type VscodeRuntimeDataSetCandidate, type VscodeRuntimeDataSetProblem
} from '../../backend/reliableKernel/vscodeRootAuthority';
import { openRuntimeDataSetHistory } from '../../backend/reliableKernel/runtimeDataSetHistory';
import { upgradeDiscoveredRuntimeDataSets, upgradeRuntimeDataSet } from '../../backend/reliableKernel/runtimeDataSetUpgrade';
import { inspectRuntimeDataSetStorage, deleteUnselectedRuntimeDataSet } from '../../backend/reliableKernel/runtimeStorageInspection';
import type { ApplicationStartup } from '../ApplicationStartup';
import { canStartRuntimeDataSetUpgrade, runRuntimeDataSetUpgrade } from '../runtimeDataSetUpgradeLifetime';
import { EXTENSION_COMMAND_IDS } from '../../shared/extensionIdentity';

const pathsFor = (context: vscode.ExtensionContext) => createVscodeStoragePaths(resolveDataRootUri(context));

/** Startup has released admission before awaiting this native picker. It also works without a Webview. */
export async function openWithRuntimeDataSetSelection<T>(context: vscode.ExtensionContext, open: () => Promise<T>): Promise<T> {
  try { return await open(); }
  catch (error) {
    if (!(error instanceof VscodeRuntimeDataSetSelectionRequiredError)) throw error;
    const candidate = await chooseDataSet(error.candidates, '选择当前历史库；以后增减项目不会切换历史', error.problems);
    if (!candidate) throw new Error('尚未选择历史库。可从“历史与存储管理”选择后重载窗口。');
    await selectVscodeRuntimeDataSet(pathsFor(context), candidate.id);
    return open();
  }
}

function dataSetLabel(candidate: VscodeRuntimeDataSetCandidate): string {
  const version = isPublishedOldDataSet(candidate) ? ` · 旧格式（版本 ${candidate.runtimeKernelEpoch}）` : '';
  return `${candidate.selected ? '当前历史库' : '其他历史库'} · ${candidate.dataSetId ?? candidate.id}${version}`;
}

function isPublishedOldDataSet(candidate: VscodeRuntimeDataSetCandidate): boolean {
  return candidate.runtimeKernelEpoch === 3 || candidate.runtimeKernelEpoch === 4;
}

async function chooseDataSet(
  candidates: readonly VscodeRuntimeDataSetCandidate[],
  placeHolder: string,
  problems: readonly VscodeRuntimeDataSetProblem[] = []
) {
  const items: Array<vscode.QuickPickItem & { candidate?: VscodeRuntimeDataSetCandidate; problem?: VscodeRuntimeDataSetProblem }> = [
    ...candidates.map(candidate => ({
      label: dataSetLabel(candidate), description: candidate.runtimeDataRootPath, candidate
    })),
    ...problems.map(problem => ({
      label: '暂时无法打开的历史库', description: problem.runtimeScopeRootPath,
      detail: problem.message, problem
    }))
  ];
  for (;;) {
    const item = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true });
    if (!item) return undefined;
    if (item.problem) {
      await vscode.window.showErrorMessage(`${item.problem.message} 原数据未被修改；可以选择列表中的其他历史库。`);
      continue;
    }
    return item.candidate;
  }
}

/** User-invoked history/storage commands intentionally do not require a running database. */
export async function manageRuntimeDataSets(context: vscode.ExtensionContext, startup: ApplicationStartup): Promise<void> {
  if (!canStartRuntimeDataSetUpgrade(context)) return;
  await loadCommittedGlobalStatus(context);
  if (!canStartRuntimeDataSetUpgrade(context)) return;
  const action = await vscode.window.showQuickPick([
    { label: '其他历史库', description: '查看旧聊天；旧格式会先自动备份升级', action: 'history' },
    { label: '查看存储占用', description: '按需统计正文、数据库、临时文件与备份', action: 'storage' },
    { label: '切换当前历史库', description: '保留完整原库，切换后重载窗口', action: 'select' },
    { label: '删除其他历史库', description: '仅删除明确选定的非当前完整历史库', action: 'delete' },
    { label: '归档并重置当前历史库', description: '保留备份并创建空库；归档本身不释放磁盘', action: 'reset' }
  ], { placeHolder: '历史与存储管理' });
  if (!action || !canStartRuntimeDataSetUpgrade(context)) return;
  if (action.action === 'reset') {
    await vscode.commands.executeCommand(EXTENSION_COMMAND_IDS.resetDevelopmentData);
    return;
  }
  const { candidates, problems } = await inspectVscodeRuntimeDataSets(pathsFor(context));
  if (!canStartRuntimeDataSetUpgrade(context)) return;
  const eligible = action.action === 'history' || action.action === 'delete'
    ? candidates.filter(candidate => !candidate.selected) : candidates;
  if (!eligible.length) {
    if (problems.length) {
      await chooseDataSet([], '这些历史库暂时无法打开；选择一项查看原因', problems);
    } else {
      await vscode.window.showInformationMessage(candidates.length ? '没有其他历史库。当前库的对话可在侧栏查看。' : '尚无历史库，打开对话后会创建。');
    }
    return;
  }
  const candidate = await chooseDataSet(eligible, action.label, problems);
  if (!candidate || !canStartRuntimeDataSetUpgrade(context)) return;
  if (action.action === 'storage') { await showRuntimeStorage(context, candidate); return; }
  if (action.action === 'history') {
    const readable = isPublishedOldDataSet(candidate) ? await upgradeHistoryBeforeRead(context, candidate) : candidate;
    if (readable && canStartRuntimeDataSetUpgrade(context)) await browseHistory(context, readable);
    return;
  }
  if (action.action === 'delete') {
    // Native VS Code command: no settings Webview exists here, so use the shell's modal confirmation.
    const confirmed = await vscode.window.showWarningMessage('永久删除这个历史库及其备份？', {
      modal: true, detail: `${dataSetLabel(candidate)}\n${candidate.runtimeDataRootPath}\n\n此操作不能撤销，不会删除当前历史库或共享设置。`
    }, '永久删除');
    if (confirmed !== '永久删除') return;
    if (!candidate.dataSetId) throw new Error('历史库尚未完整初始化，不能删除。');
    await deleteUnselectedRuntimeDataSet(pathsFor(context), candidate.id, candidate.dataSetId);
    await vscode.window.showInformationMessage('所选历史库已删除。');
    return;
  }
  await switchHistory(context, startup, candidate);
}

async function switchHistory(context: vscode.ExtensionContext, startup: ApplicationStartup, candidate: VscodeRuntimeDataSetCandidate): Promise<void> {
  if (candidate.selected) { await vscode.window.showInformationMessage('已经在使用这个历史库。'); return; }
  const confirmed = await vscode.window.showWarningMessage('切换当前历史库并重载窗口？', {
    modal: true, detail: `目标：${candidate.runtimeDataRootPath}\n\n当前窗口的运行会停止。请先关闭其它使用同一数据目录的 VS Code 窗口。所有原历史保留，不合并、不搬移。`
  }, '切换并重载');
  if (confirmed !== '切换并重载') return;
  const application = startup.current();
  try {
    if (application) await application.selectRuntimeDataSet(candidate.id);
    else await selectVscodeRuntimeDataSet(pathsFor(context), candidate.id);
  } catch (error) {
    if (application) {
      const message = error instanceof Error ? error.message : String(error);
      await vscode.window.showErrorMessage(`切换未完成：${message}。将重载窗口恢复连接。`);
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
      return;
    }
    throw error;
  }
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}

async function upgradeHistoryBeforeRead(
  context: vscode.ExtensionContext,
  candidate: VscodeRuntimeDataSetCandidate
): Promise<VscodeRuntimeDataSetCandidate | undefined> {
  if (!canStartRuntimeDataSetUpgrade(context)) return;
  if (!candidate.dataSetId || !candidate.rootInstanceId) throw new Error('旧历史库身份不完整，无法升级；原数据保持不变。');
  let result: Awaited<ReturnType<typeof upgradeRuntimeDataSet>>;
  try {
    result = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification, title: '正在备份并升级旧聊天记录…'
    }, () => runRuntimeDataSetUpgrade(context, () => upgradeRuntimeDataSet(pathsFor(context), {
      candidateId: candidate.id,
      expectedDataSetId: candidate.dataSetId!,
      expectedRootInstanceId: candidate.rootInstanceId!
    })));
  } catch (error) {
    if (!canStartRuntimeDataSetUpgrade(context)) return;
    const message = describeError(error);
    await vscode.window.showErrorMessage(`旧聊天记录自动升级未完成：${message}。没有自动重置数据；请保留原库和升级备份，问题排除后再次打开时会自动重试。`);
    return;
  }
  if (!canStartRuntimeDataSetUpgrade(context)) return;
  let upgraded: VscodeRuntimeDataSetCandidate;
  try {
    upgraded = await resolveVscodeRuntimeDataSet(pathsFor(context), result.candidateId);
    if (upgraded.dataSetId !== result.binding.dataSetId || upgraded.rootInstanceId !== result.binding.rootInstanceId) {
      throw new Error('当前数据目录或历史库身份已变化，请重新打开历史与存储管理。');
    }
  } catch (error) {
    if (!canStartRuntimeDataSetUpgrade(context)) return;
    await vscode.window.showErrorMessage(`升级已经完成，但暂时无法打开这份历史：${describeError(error)}。升级前备份：${result.backupPath ?? '请在所选历史库中查看'}。`);
    return;
  }
  if (!canStartRuntimeDataSetUpgrade(context)) return;
  if (result.backupPath) {
    console.info(`[LimCode] 旧聊天记录已自动升级；升级前备份：${result.backupPath}`);
  }
  return upgraded;
}

/** Runs after current Runtime startup. Historical upgrades never register or recover old tasks. */
export async function upgradeHistoricalDataSetsOnStartup(
  context: vscode.ExtensionContext,
  shouldContinue: () => boolean = () => true
): Promise<void> {
  if (!shouldContinue() || !canStartRuntimeDataSetUpgrade(context)) return;
  const paths = pathsFor(context);
  const stillCurrent = () => canStartRuntimeDataSetUpgrade(context)
    && shouldContinue() && pathsFor(context).globalStoragePath === paths.globalStoragePath;
  try {
    const report = await runRuntimeDataSetUpgrade(context,
      () => upgradeDiscoveredRuntimeDataSets(paths, { excludeSelected: true, shouldContinue: stillCurrent }));
    for (const result of report.results) {
      if (result.backupPath) console.info(`[LimCode] 旧聊天记录已自动升级；升级前备份：${result.backupPath}`);
    }
    if (!report.failures.length) return;
    console.warn('[LimCode] 部分旧聊天记录未能自动升级。', report.failures);
    if (!stillCurrent()) return;
    // The upgrade itself requires no response. Details are offered only for sources that need
    // attention, and dismissing this notification cannot block current Runtime startup.
    void vscode.window.showWarningMessage('部分旧聊天记录暂时无法自动升级，原数据未被重置，已生成的备份会保留。', '查看原因')
      .then(async choice => {
        if (choice !== '查看原因' || !stillCurrent()) return;
        await showReadOnly(context, '旧聊天记录升级结果', report.failures.map(failure =>
          `${failure.candidateId ?? '历史库列表'}\n[${failure.code}] ${failure.message}`
        ).join('\n\n'));
      }).then(undefined, error => console.warn('[LimCode] 无法显示旧聊天记录升级详情。', error));
  } catch (error) {
    console.error('[LimCode] 无法自动检查旧聊天记录。', error);
    if (stillCurrent()) void vscode.window.showErrorMessage(`无法自动检查旧聊天记录：${describeError(error)}。原数据未被重置。`);
  }
}

function describeError(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current) && messages.length < 4) {
    seen.add(current);
    if (typeof current !== 'object' || !('message' in current) || typeof current.message !== 'string') {
      messages.push(String(current));
      break;
    }
    const code = (current as { code?: unknown }).code;
    const message = typeof code === 'string' ? `[${code}] ${current.message}` : current.message;
    if (!messages.includes(message)) messages.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return messages.join('；') || String(error);
}

export async function showRuntimeStorage(context: vscode.ExtensionContext, candidate?: VscodeRuntimeDataSetCandidate): Promise<void> {
  await loadCommittedGlobalStatus(context);
  candidate ??= (await inspectVscodeRuntimeDataSets(pathsFor(context))).candidates.find(item => item.selected);
  if (!candidate) throw new Error('请先选择当前历史库。');
  const id = candidate.id;
  const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在统计历史库占用…' },
    () => inspectRuntimeDataSetStorage(pathsFor(context), id));
  const labels = { sqlite: 'SQLite 数据库', cas: '历史正文与附件（CAS）', casTemporary: 'CAS 临时残留', processSpool: '进程输出暂存', diagnostics: '诊断日志', other: '其它运行文件', historicalBackups: '完整历史备份' };
  const lines = Object.entries(report.categories).map(([key, size]) =>
    `${labels[key as keyof typeof labels]}：${size.fileCount} 个文件，${formatBytes(size.bytes)}`);
  await showReadOnly(context, '历史库占用', [
    dataSetLabel(candidate), candidate.runtimeDataRootPath, '', ...lines,
    '', `合计：${report.total.fileCount} 个文件，${formatBytes(report.total.bytes)}`,
    '这里统计文件逻辑大小，运行中的库可能继续变化。历史正文不是可随意清除的缓存；保留归档不会释放其磁盘占用。'
  ].join('\n'));
}

async function browseHistory(context: vscode.ExtensionContext, candidate: VscodeRuntimeDataSetCandidate): Promise<void> {
  const history = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在打开只读历史…' },
    () => openRuntimeDataSetHistory(pathsFor(context), candidate.id));
  try {
    let after: { updatedAt: string; id: string } | undefined;
    for (;;) {
      const page = await history.listConversations({ limit: 50, after });
      const choices: Array<vscode.QuickPickItem & { id?: string; next?: boolean }> = page.items.map(item => ({
        label: item.title || item.id, description: item.updatedAt, detail: item.id, id: item.id
      }));
      if (page.next) choices.push({ label: '下一页会话', next: true });
      if (!choices.length) { await vscode.window.showInformationMessage('这个历史库没有会话。'); return; }
      const choice = await vscode.window.showQuickPick(choices, { placeHolder: `${dataSetLabel(candidate)} · 只读历史`, matchOnDetail: true });
      if (!choice) return;
      if (choice.next) { after = page.next; continue; }
      if (choice.id) await browseMessages(context, history, choice.id, choice.label);
    }
  } finally { await history.close(); }
}

async function browseMessages(context: vscode.ExtensionContext, history: Awaited<ReturnType<typeof openRuntimeDataSetHistory>>, conversationId: string, title: string) {
  let after: string | undefined;
  for (;;) {
    const page = await history.readMessages(conversationId, { limit: 50, after });
    await showReadOnly(context, title, [title, '其它历史库 · 只读，不会恢复执行', '', ...page.items.map(item =>
      `[${item.role}] ${item.createdAt}\n${item.text}${item.hasMoreText ? '\n（此消息还有后续正文，可在菜单继续阅读）' : ''}\n`)].join('\n'));
    const choices = [
      ...(page.next ? [{ label: '后 50 条消息', action: 'next' }] : []),
      ...page.items.filter(item => item.hasMoreText).map(item => ({ label: `继续阅读长消息 ${item.messageSeq}`, action: item.id })),
      { label: '返回会话列表', action: 'back' }
    ];
    const choice = await vscode.window.showQuickPick(choices, { placeHolder: '只读历史分页' });
    if (!choice || choice.action === 'back') return;
    if (choice.action === 'next') { after = page.next; continue; }
    const message = page.items.find(item => item.id === choice.action);
    if (!message) return;
    let offset = message.nextTextOffset;
    while (offset !== undefined) {
      const part = await history.readMessageText(conversationId, message.id, { offset });
      await showReadOnly(context, title, `${title}\n[${message.role}] 从第 ${offset + 1} 个字符继续\n\n${part.text}`);
      if (!part.hasMore || await vscode.window.showQuickPick(['继续本条消息', '返回消息页']) !== '继续本条消息') break;
      offset = part.nextOffset;
    }
  }
}

const readers = new WeakMap<vscode.ExtensionContext, { show(title: string, text: string): Promise<void> }>();
async function showReadOnly(context: vscode.ExtensionContext, title: string, text: string): Promise<void> {
  let reader = readers.get(context);
  if (!reader) {
    const contents = new Map<string, string>();
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('limcode-history', {
      provideTextDocumentContent: uri => contents.get(uri.toString()) ?? ''
    }), vscode.workspace.onDidCloseTextDocument(document => contents.delete(document.uri.toString())));
    reader = { async show(label, body) {
      const uri = vscode.Uri.from({ scheme: 'limcode-history', path: `/${label.replace(/[\\/]/g, '-')}.txt`, query: randomUUID() });
      contents.set(uri.toString(), body);
      try { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true }); }
      catch (error) { contents.delete(uri.toString()); throw error; }
    } };
    readers.set(context, reader);
  }
  await reader.show(title, text);
}

function formatBytes(value: string): string {
  const bytes = BigInt(value);
  if (bytes < 1024n) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let divisor = 1024n;
  for (const unit of units) {
    if (bytes < divisor * 1024n || unit === 'TiB') return `${Number(bytes * 10n / divisor) / 10} ${unit}`;
    divisor *= 1024n;
  }
  return `${bytes} B`;
}
