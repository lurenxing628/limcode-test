import * as vscode from 'vscode';
import { loadCommittedGlobalStatus, resolveDataRootUri } from '../../backend/capabilities/vscodeStorage/globalStatus';
import { createVscodeStoragePaths } from '../../backend/capabilities/vscodeStorage/paths';
import { openRuntimeDataSetHistory } from '../../backend/reliableKernel/runtimeDataSetHistory';
import {
  discoverForeignRuntimeHistory, inspectForeignRuntimeHistory, inspectForeignRuntimeStorage, locateForeignRuntimeRoot,
  type ForeignRuntimeHistoryEntry, type ForeignRuntimeHistoryInput
} from '../../backend/reliableKernel/runtimeForeignHistory';
import { browseRuntimeHistory, formatBytes, showReadOnly } from './runtimeDataSetManagement';

/**
 * 历史与存储管理 → 外来历史库: reset archives and copied data directories this data directory does
 * not use, registered in place and read only. Verified ones can be read and measured; merging them
 * is for a later version. Ones that fail keep name, location, size and reason and are never deleted.
 */
const ANNOUNCED_KEY = 'limcode.foreignRuntimeHistoryAnnounced';
const ANNOUNCED_LIMIT = 500;
const MERGE_LATER = '只读；以后的版本支持合并';

async function foreignInput(context: vscode.ExtensionContext): Promise<ForeignRuntimeHistoryInput & { paths: { globalStoragePath: string } }> {
  const status = await loadCommittedGlobalStatus(context);
  const paths = createVscodeStoragePaths(resolveDataRootUri(context));
  return {
    paths, configurationRootPath: paths.globalStoragePath,
    ...(status?.lastMigration?.fromPath ? { previousDataRootPath: status.lastMigration.fromPath } : {})
  };
}

/** Once after startup, in the background: only lists directories and reads small JSON files; new entries are announced once. */
export async function announceForeignRuntimeHistoryOnStartup(
  context: vscode.ExtensionContext,
  isCurrent: () => boolean = () => true
): Promise<void> {
  const input = await foreignInput(context);
  const found = await discoverForeignRuntimeHistory(input);
  if (!isCurrent() || found.length === 0) return;
  const fresh = await rememberAnnounced(context, input.configurationRootPath, found.map((entry) => entry.id));
  if (fresh === 0) return;
  void Promise.resolve(vscode.window.showInformationMessage(
    `发现 ${fresh} 个外来历史库（归档并重置留下的归档，或从别处拷来的数据目录）。可以在“历史与存储管理 → 外来历史库”里核验，核验通过的可以只读查看；以后的版本支持合并。原数据保持原样。`,
    '查看'
  )).then((pick) => {
    if (pick === '查看') return manageForeignRuntimeHistory(context);
    return undefined;
  }).catch((error: unknown) => {
    void vscode.window.showErrorMessage(`外来历史库打开失败：${error instanceof Error ? error.message : String(error)}`);
  });
}

/** Returns how many of `ids` were not announced before, and records them (bounded). */
async function rememberAnnounced(context: vscode.ExtensionContext, configurationRootPath: string, ids: readonly string[]): Promise<number> {
  const state = (context as Partial<vscode.ExtensionContext>).globalState;
  if (!state) return ids.length;
  const ledger = state.get<Record<string, string[]>>(ANNOUNCED_KEY) ?? {};
  const seen = ledger[configurationRootPath] ?? [];
  const fresh = ids.filter((id) => !seen.includes(id));
  if (fresh.length === 0) return 0;
  const next = { ...ledger, [configurationRootPath]: [...seen, ...fresh].slice(-ANNOUNCED_LIMIT) };
  await Promise.resolve(state.update(ANNOUNCED_KEY, next))
    .catch((error: unknown) => console.warn('[LimCode] 无法记录已提示的外来历史库。', error));
  return fresh.length;
}

export async function manageForeignRuntimeHistory(context: vscode.ExtensionContext): Promise<void> {
  const input = await foreignInput(context);
  const report = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: '正在核验外来历史库（只读，不改动它们）…' },
    (progress) => inspectForeignRuntimeHistory({
      ...input, onProgress: (done, total) => progress.report({ message: `${done}/${total}` })
    })
  );
  await rememberAnnounced(context, report.configurationRootPath, report.entries.map((entry) => entry.id));
  if (report.entries.length === 0) {
    await vscode.window.showInformationMessage('没有发现外来历史库。归档并重置留下的归档、迁移数据目录时挪到旁边的拷来目录会列在这里。');
    return;
  }
  const shown = report.entries.filter((entry) => !entry.duplicateOf);
  for (;;) {
    const choice = await vscode.window.showQuickPick(shown.map((entry) => ({
      label: entryLabel(entry),
      description: entryFacts(entry),
      detail: entryDetail(entry, report.entries.filter((other) => other.duplicateOf === entry.id).length),
      entry
    })), { placeHolder: `外来历史库 · ${MERGE_LATER}`, matchOnDescription: true, matchOnDetail: true });
    if (!choice) return;
    await actOn(context, input.paths, choice.entry);
  }
}

async function actOn(context: vscode.ExtensionContext, paths: { globalStoragePath: string }, entry: ForeignRuntimeHistoryEntry): Promise<void> {
  if (entry.status !== 'verified') {
    const title = entry.status === 'failed' ? '这个外来历史库没有通过核验' : '这个外来历史库暂时无法核验';
    const pick = await vscode.window.showWarningMessage(
      `${title}：${entry.reason ?? '原因未知'} 它原样保留，不会被自动删除。位置：${entry.locatedPath}`, '打开所在文件夹'
    );
    if (pick === '打开所在文件夹') await reveal(entry);
    return;
  }
  const action = await vscode.window.showQuickPick([
    { label: '只读查看', description: '打开私有副本查看对话，不改动原目录', action: 'read' },
    { label: '查看存储占用', description: '统计它所在目录的文件大小', action: 'storage' },
    { label: '打开所在文件夹', description: entry.location.containerPath, action: 'reveal' }
  ], { placeHolder: `${entryLabel(entry)} · ${MERGE_LATER}` });
  if (!action) return;
  if (action.action === 'reveal') { await reveal(entry); return; }
  const locate = () => locateForeignRuntimeRoot(paths.globalStoragePath, entry.location);
  if (action.action === 'read') {
    await browseRuntimeHistory(context, entryLabel(entry), async () => openRuntimeDataSetHistory(paths, await locate()), '外来历史库');
    return;
  }
  const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在统计外来历史库占用…' },
    async () => inspectForeignRuntimeStorage(paths, await locate()));
  const labels: Record<string, string> = {
    sqlite: 'SQLite 数据库', cas: '历史正文与附件（CAS）', casTemporary: 'CAS 临时残留', processSpool: '进程输出暂存',
    diagnostics: '诊断日志', other: '其它运行文件', historicalBackups: '它自己的升级与合并备份'
  };
  await showReadOnly(context, '外来历史库占用', [
    entryLabel(entry), `位置：${entry.locatedPath}`, ...(entry.recordedDataRootPath ? [`原位置（只作记录，不会访问）：${entry.recordedDataRootPath}`] : []), '',
    ...Object.entries(report.categories).map(([key, size]) => `${labels[key] ?? key}：${size.fileCount} 个文件，${formatBytes(size.bytes)}`),
    '', `合计：${report.total.fileCount} 个文件，${formatBytes(report.total.bytes)}`,
    '这里统计文件逻辑大小。外来历史库不会被自动删除。'
  ].join('\n'));
}

async function reveal(entry: ForeignRuntimeHistoryEntry): Promise<void> {
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(entry.location.containerPath));
}

function entryLabel(entry: ForeignRuntimeHistoryEntry): string {
  const source = entry.location.kind === 'archive' ? entry.location.side === 'previous' ? '归档（上一个数据目录里）' : '归档'
    : entry.archiveName ? '拷来目录里的归档' : entry.location.side === 'previous' ? '从别处拷来（上一个数据目录旁）' : '从别处拷来';
  const scope = entry.scope && entry.scope !== 'default' ? ' · 工作区库' : '';
  const state = entry.status === 'failed' ? '未通过核验 · ' : entry.status === 'unavailable' ? '暂时无法核验 · ' : '';
  const copyOf = entry.sameAsLocal ? entry.sameAsLocal.selected ? '（当前库的旧拷贝）' : `（历史库 ${entry.sameAsLocal.candidateId} 的旧拷贝）` : '';
  return `${state}${source} · ${entry.archiveName ?? entry.name}${scope}${copyOf}`;
}

function entryFacts(entry: ForeignRuntimeHistoryEntry): string {
  const size = entry.size ? `${formatBytes(entry.size.bytes)}（${entry.size.fileCount} 个文件）` : '大小未知';
  if (entry.status !== 'verified') return size;
  const summary = entry.summary;
  return [
    summary ? `${summary.conversationCount} 个对话` : '',
    summary?.lastActivityAt ? `最后活动 ${summary.lastActivityAt.replace('T', ' ').slice(0, 16)}` : '',
    summary?.projectNames.length ? summary.projectNames.slice(0, 3).join('、') : '',
    size
  ].filter(Boolean).join(' · ');
}

function entryDetail(entry: ForeignRuntimeHistoryEntry, identicalCopies: number): string {
  return [
    `位置：${entry.locatedPath}`,
    ...(entry.recordedDataRootPath ? [`原位置：${entry.recordedDataRootPath}`] : []),
    ...(entry.status === 'verified' ? [MERGE_LATER] : [`原因：${entry.reason ?? '原因未知'}`, '原样保留，不会自动删除']),
    ...(entry.unfinishedWork ? [`有 ${entry.unfinishedWork.finalizable + entry.unfinishedWork.refused} 项未结束的任务（旧窗口中断时留下），以后合并前需要收尾；现在可以只读查看`] : []),
    ...(identicalCopies > 0 ? [`另有 ${identicalCopies} 份完全相同的拷贝`] : []),
    ...(entry.movedAsideBy ? [`迁移数据目录时挪到旁边（迁移 ${entry.movedAsideBy.slice(0, 8)}）`] : [])
  ].join(' · ');
}
