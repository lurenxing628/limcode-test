import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { loadCommittedGlobalStatus, resolveDataRootUri } from '../../backend/capabilities/vscodeStorage/globalStatus';
import { createVscodeStoragePaths } from '../../backend/capabilities/vscodeStorage/paths';
import {
  listVscodeRuntimeDataSets, selectVscodeRuntimeDataSet, VscodeRuntimeDataSetSelectionRequiredError,
  type VscodeRuntimeDataSetCandidate
} from '../../backend/reliableKernel/vscodeRootAuthority';
import { openRuntimeDataSetHistory } from '../../backend/reliableKernel/runtimeDataSetHistory';
import { inspectRuntimeDataSetStorage, deleteUnselectedRuntimeDataSet } from '../../backend/reliableKernel/runtimeStorageInspection';
import type { ApplicationStartup } from '../ApplicationStartup';
import { EXTENSION_COMMAND_IDS } from '../../shared/extensionIdentity';

const pathsFor = (context: vscode.ExtensionContext) => createVscodeStoragePaths(resolveDataRootUri(context));

/** Startup has released admission before awaiting this native picker. It also works without a Webview. */
export async function openWithRuntimeDataSetSelection<T>(context: vscode.ExtensionContext, open: () => Promise<T>): Promise<T> {
  try { return await open(); }
  catch (error) {
    if (!(error instanceof VscodeRuntimeDataSetSelectionRequiredError)) throw error;
    const candidate = await chooseDataSet(error.candidates, '选择当前历史库；以后增减项目不会切换历史');
    if (!candidate) throw new Error('尚未选择历史库。可从“历史与存储管理”选择后重载窗口。');
    await selectVscodeRuntimeDataSet(pathsFor(context), candidate.id);
    return open();
  }
}

function dataSetLabel(candidate: VscodeRuntimeDataSetCandidate): string {
  return `${candidate.selected ? '当前历史库' : '其他历史库'} · ${candidate.dataSetId ?? candidate.id}`;
}

async function chooseDataSet(candidates: readonly VscodeRuntimeDataSetCandidate[], placeHolder: string) {
  const item = await vscode.window.showQuickPick(candidates.map(candidate => ({
    label: dataSetLabel(candidate), description: candidate.runtimeDataRootPath, candidate
  })), { placeHolder, matchOnDescription: true });
  return item?.candidate;
}

/** User-invoked history/storage commands intentionally do not require a running database. */
export async function manageRuntimeDataSets(context: vscode.ExtensionContext, startup: ApplicationStartup): Promise<void> {
  await loadCommittedGlobalStatus(context);
  const action = await vscode.window.showQuickPick([
    { label: '其他历史库', description: '只读分页查看，原库不会被修改', action: 'history' },
    { label: '查看存储占用', description: '按需统计正文、数据库、临时文件与备份', action: 'storage' },
    { label: '切换当前历史库', description: '保留完整原库，切换后重载窗口', action: 'select' },
    { label: '删除其他历史库', description: '仅删除明确选定的非当前完整历史库', action: 'delete' },
    { label: '归档并重置当前历史库', description: '保留备份并创建空库；归档本身不释放磁盘', action: 'reset' }
  ], { placeHolder: '历史与存储管理' });
  if (!action) return;
  if (action.action === 'reset') {
    await vscode.commands.executeCommand(EXTENSION_COMMAND_IDS.resetDevelopmentData);
    return;
  }
  const candidates = await listVscodeRuntimeDataSets(pathsFor(context));
  const eligible = action.action === 'history' || action.action === 'delete'
    ? candidates.filter(candidate => !candidate.selected) : candidates;
  if (!eligible.length) {
    await vscode.window.showInformationMessage(candidates.length ? '没有其他历史库。当前库的对话可在侧栏查看。' : '尚无历史库，打开对话后会创建。');
    return;
  }
  const candidate = await chooseDataSet(eligible, action.label);
  if (!candidate) return;
  if (action.action === 'storage') { await showRuntimeStorage(context, candidate); return; }
  if (action.action === 'history') { await browseHistory(context, candidate); return; }
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

export async function showRuntimeStorage(context: vscode.ExtensionContext, candidate?: VscodeRuntimeDataSetCandidate): Promise<void> {
  await loadCommittedGlobalStatus(context);
  candidate ??= (await listVscodeRuntimeDataSets(pathsFor(context))).find(item => item.selected);
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
