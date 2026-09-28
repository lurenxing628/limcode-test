import * as vscode from 'vscode';
import { loadCommittedGlobalStatus, resolveDataRootUri, updateGlobalStatusDataRoot, type LimCodeGlobalStatus } from '../../backend/capabilities/vscodeStorage/globalStatus';
import { createVscodeStoragePaths } from '../../backend/capabilities/vscodeStorage/paths';
import { openRuntimeDataSetHistory } from '../../backend/reliableKernel/runtimeDataSetHistory';
import {
  discoverForeignRuntimeHistory, inspectForeignRuntimeHistory, inspectForeignRuntimeStorage, locateForeignRuntimeRoot,
  previousDataRootsWithoutForeignHistory,
  type ForeignRuntimeHistoryEntry, type ForeignRuntimeHistoryInput
} from '../../backend/reliableKernel/runtimeForeignHistory';
import {
  readForeignRuntimeHistoryMergeStates, requestForeignRuntimeHistoryMerge, type ForeignRuntimeHistoryMergeState
} from '../../backend/reliableKernel/runtimeForeignHistoryMerge';
import type { ApplicationStartup } from '../ApplicationStartup';
import { formatTime } from './backupCleanup';
import {
  browseRuntimeHistory, formatBytes, keptForSkippedTip, mergeHistoricalDataSetsInBackground, oversizedMergeNote, showReadOnly,
  type HistoricalMergeHost
} from './runtimeDataSetManagement';

/**
 * 历史与存储管理 → 外来历史库: reset archives and copied data directories this data directory does
 * not use, registered in place and read only. Verified ones can be read and measured, and merged into
 * the current data set when the user asks (never automatically; nothing is written into them). Ones
 * that fail keep name, location, size and reason and are never deleted.
 */
const ANNOUNCED_KEY = 'limcode.foreignRuntimeHistoryAnnounced';
const ANNOUNCED_LIMIT = 500;
const CLEANUP_TIP = '这份归档或拷来的库原样保留；确认不再需要时，可以在“清理备份”里按覆盖核对后删除。';

async function foreignInput(
  context: vscode.ExtensionContext,
  known?: LimCodeGlobalStatus
): Promise<ForeignRuntimeHistoryInput & { paths: { globalStoragePath: string } }> {
  const status = known ?? await loadCommittedGlobalStatus(context);
  const paths = createVscodeStoragePaths(resolveDataRootUri(context));
  const previous = leftDataRoots(status);
  return {
    paths, configurationRootPath: paths.globalStoragePath,
    ...(previous.length > 0 ? { previousDataRootPaths: previous } : {})
  };
}

/**
 * The data directories this installation left, to look in: the list in globalStatus
 * (previousDataRoots), and the last relocation's source (lastMigration.fromPath), which is all an
 * installation that relocated before the list existed has. Discovery takes each directory once.
 */
function leftDataRoots(status: LimCodeGlobalStatus | undefined): string[] {
  const listed = [...(status?.previousDataRoots ?? [])];
  const from = status?.lastMigration?.fromPath;
  return from && !listed.includes(from) ? [...listed, from] : listed;
}

/** Once after startup, in the background: only lists directories and reads small JSON files; new entries are announced once. */
export async function announceForeignRuntimeHistoryOnStartup(
  context: vscode.ExtensionContext,
  isCurrent: () => boolean = () => true,
  startup?: ApplicationStartup
): Promise<void> {
  const status = await loadCommittedGlobalStatus(context);
  const input = await foreignInput(context, status);
  const found = await discoverForeignRuntimeHistory(input);
  // Data directories on the list that hold no archive and no copied directory any more are no longer
  // looked in (the last relocation's source is looked in anyway: not on the list, nothing to take off).
  const listed = status?.previousDataRoots ?? [];
  const empty = (await previousDataRootsWithoutForeignHistory(input).catch(() => [] as string[])).filter((root) => listed.includes(root));
  if (empty.length > 0) await updateGlobalStatusDataRoot(context, { forgetPreviousDataRoots: empty }).catch((error: unknown) =>
    console.warn('[LimCode] 更新旧数据目录列表失败。', error));
  if (!isCurrent() || found.length === 0) return;
  const fresh = await rememberAnnounced(context, input.configurationRootPath, found.map((entry) => entry.id));
  if (fresh === 0) return;
  void Promise.resolve(vscode.window.showInformationMessage(
    `发现 ${fresh} 个外来历史库（归档并重置留下的归档，或从别处拷来的数据目录）。可以在“历史与存储管理 → 外来历史库”里核验，`
      + '核验通过的可以只读查看，也可以选择合并进当前库（不会自动合并）。原数据保持原样。',
    '查看'
  )).then((pick) => {
    if (pick === '查看') return manageForeignRuntimeHistory(context, startup);
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

export async function manageForeignRuntimeHistory(context: vscode.ExtensionContext, startup?: ApplicationStartup): Promise<void> {
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
    // From this configuration root's merge ledger and each entry's verified content: nothing of a root is read.
    const states = await readForeignRuntimeHistoryMergeStates(input.paths, report.entries)
      .catch(() => new Map<string, ForeignRuntimeHistoryMergeState>());
    const choice = await vscode.window.showQuickPick(shown.map((entry) => ({
      label: entryLabel(entry),
      description: entryFacts(entry, states.get(entry.id)),
      detail: entryDetail(entry, report.entries.filter((other) => other.duplicateOf === entry.id).length, states.get(entry.id)),
      entry
    })), { placeHolder: '外来历史库 · 原样保留；核验通过的可以只读查看，也可以合并进当前库', matchOnDescription: true, matchOnDetail: true });
    if (!choice) return;
    if (await actOn(context, input.paths, choice.entry, states.get(choice.entry.id), startup) === 'merged') return;
  }
}

async function actOn(
  context: vscode.ExtensionContext,
  paths: { globalStoragePath: string },
  entry: ForeignRuntimeHistoryEntry,
  merge: ForeignRuntimeHistoryMergeState | undefined,
  startup: ApplicationStartup | undefined
): Promise<'merged' | void> {
  if (entry.status !== 'verified') {
    const title = entry.status === 'failed' ? '这个外来历史库没有通过核验' : '这个外来历史库暂时无法核验';
    const pick = await vscode.window.showWarningMessage(
      `${title}：${entry.reason ?? '原因未知'} 它原样保留，不会被自动删除。位置：${entry.locatedPath}`, '打开所在文件夹'
    );
    if (pick === '打开所在文件夹') await reveal(entry);
    return;
  }
  const copyOf = oldCopyOf(entry);
  const unfinished = unfinishedCount(entry);
  const state = mergeStateText(merge);
  const action = await vscode.window.showQuickPick([
    { label: '只读查看', description: '打开私有副本查看对话，不改动原目录', action: 'read' },
    copyOf
      ? { label: '合并进当前库', description: `不能合并：它是${copyOf}的旧拷贝`, action: 'old-copy' }
      : unfinished > 0
        ? { label: '合并进当前库', description: `暂不能合并：有 ${unfinished} 项未结束的任务`, action: 'unfinished' }
        : { label: '合并进当前库', description: state ? `${state}；在后台合并，原目录不改动` : '在后台合并，原目录不改动', action: 'merge' },
    { label: '查看存储占用', description: '统计它所在目录的文件大小', action: 'storage' },
    { label: '打开所在文件夹', description: entry.location.containerPath, action: 'reveal' }
  ], { placeHolder: `${entryLabel(entry)}${state ? ` · ${state}` : ''}` });
  if (!action) return;
  if (action.action === 'reveal') { await reveal(entry); return; }
  if (action.action === 'old-copy') {
    await vscode.window.showInformationMessage(`这个外来历史库是${copyOf}的旧拷贝（同一个库的另一份），不合并：同一个库的两份不能都并进当前库。`
      + '它的对话如果都已在那个库里，可以在“清理备份”里按覆盖核对后删除；需要时可以只读查看它。');
    return;
  }
  if (action.action === 'unfinished') {
    await vscode.window.showInformationMessage(`这个外来历史库里有 ${unfinished} 项未结束的任务（旧窗口中断时留下），合并前要先收尾；`
      + '外来历史库只读，当前版本不在它的目录里收尾，所以暂不合并，两边都不改动。可以只读查看它。');
    return;
  }
  if (action.action === 'merge') return mergeIntoCurrent(context, paths, entry, merge, startup);
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

/**
 * The user's explicit merge of one verified foreign root: recorded as a request first (a closed
 * window or a busy moment is retried by a later startup), then merged online in the background.
 */
async function mergeIntoCurrent(
  context: vscode.ExtensionContext,
  paths: { globalStoragePath: string },
  entry: ForeignRuntimeHistoryEntry,
  merge: ForeignRuntimeHistoryMergeState | undefined,
  startup: ApplicationStartup | undefined
): Promise<'merged' | void> {
  if (!entry.dataSetId || !entry.rootInstanceId) return;
  const again = merge?.state === 'merged' && merge.intoCurrent
    ? merge.changedSinceMerge
      ? '\n\n它在上次合并之后又有变化：新增的对话会合并进来；已合并的对话如果内容不同，会整体不合并并说明原因。'
      : '\n\n它上次合并之后没有变化，这次会提示没有新内容。'
    : '';
  const confirmed = await vscode.window.showWarningMessage('把这个外来历史库合并进当前库？', {
    modal: true,
    detail: `来源：${entry.locatedPath}\n\n在后台合并，不需要重载窗口：先备份当前库，再把对话写入当前库。`
      + '外来历史库只读：合并不在它的目录里写任何东西，它原样保留；它的正文文件会复制进当前库（不共用文件），需要相应的磁盘空间。'
      + '它里面如果还有中断的任务或排队未发送的消息，这次不合并并说明原因（当前版本不在外来目录里收尾），仍可只读查看。'
      + '你在本版本里删掉的对话不会回来；更早版本里删掉、而这份库里还有的对话会被加回来，合并后可以再删。'
      + '与当前库有数据冲突时整体不合并，并说明原因。' + oversizedMergeNote() + again
      + `\n\n合并完成后，${CLEANUP_TIP}`
  }, '合并');
  if (confirmed !== '合并') return;
  try {
    await requestForeignRuntimeHistoryMerge(paths, {
      id: entry.id, location: entry.location, label: foreignSourceLabel(entry),
      expectedDataSetId: entry.dataSetId, expectedRootInstanceId: entry.rootInstanceId
    });
  } catch (error) {
    await vscode.window.showErrorMessage(`没有合并：${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const host = startup?.current() as Partial<HistoricalMergeHost> | undefined;
  if (!host?.product) {
    await vscode.window.showInformationMessage('已记录合并请求，当前历史库打开后会自动合并。');
    return 'merged';
  }
  await mergeHistoricalDataSetsInBackground(context, host as HistoricalMergeHost, () => true, [entry.id]);
  return 'merged';
}

/**
 * Whose old copy a verified entry is (same data set incarnation as a local data set, or one the current
 * data set continues), by a readable name, if it is one.
 */
function oldCopyOf(entry: ForeignRuntimeHistoryEntry): string | undefined {
  const local = entry.sameAsLocal;
  if (!local) return undefined;
  return local.selected ? `当前历史库${local.continued ? '（迁移数据目录之前的那一份）' : ''}` : `历史库“${local.name ?? '另一个本地库'}”`;
}

/** Interrupted work a merge would first have to finish (never finished in a foreign directory). */
function unfinishedCount(entry: ForeignRuntimeHistoryEntry): number {
  return entry.unfinishedWork ? entry.unfinishedWork.finalizable + entry.unfinishedWork.refused : 0;
}

/** "已合并（时间）" of its last merge, then what is pending or refused now. */
function mergeStateText(merge: ForeignRuntimeHistoryMergeState | undefined): string {
  if (!merge) return '';
  const time = (iso: string): string => formatTime(iso);
  const last = merge.state === 'merged' ? merge : merge.lastMerged;
  const merged = !last ? '' : last.intoCurrent
    ? `已合并（${time(last.mergedAt)}）${merge.state === 'merged' && last.changedSinceMerge ? '，之后有变化' : ''}`
    : `已合并到另一个历史库（${time(last.mergedAt)}）`;
  const now = merge.state === 'merged' ? ''
    : merge.state === 'requested' ? `已请求合并（${time(merge.requestedAt)}），还没有完成`
      : merge.state === 'too-large' ? '太大，暂不能合并' : '暂不能合并';
  return [merged, now].filter(Boolean).join('；');
}

async function reveal(entry: ForeignRuntimeHistoryEntry): Promise<void> {
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(entry.location.containerPath));
}

function entryLabel(entry: ForeignRuntimeHistoryEntry): string {
  const state = entry.status === 'failed' ? '未通过核验 · ' : entry.status === 'unavailable' ? '暂时无法核验 · ' : '';
  const copyOf = oldCopyOf(entry);
  return `${state}${entryName(entry)}${copyOf ? `（${copyOf}的旧拷贝）` : ''}`;
}

/** Where it came from and its name: what a merge notice and the large-merge session call it. */
function entryName(entry: ForeignRuntimeHistoryEntry): string {
  const source = entry.location.kind === 'archive' ? entry.location.side === 'previous' ? '归档（以前的数据目录里）' : '归档'
    : entry.archiveName ? '拷来目录里的归档' : entry.location.side === 'previous' ? '从别处拷来（以前的数据目录旁）' : '从别处拷来';
  const scope = entry.scope && entry.scope !== 'default' ? ' · 工作区库' : '';
  return `${source} · ${entry.archiveName ?? entry.name}${scope}`;
}

/** The readable name a merge of this entry is reported by. */
export function foreignSourceLabel(entry: ForeignRuntimeHistoryEntry): string {
  return `外来历史库（${entryName(entry)}）`;
}

/** What a verified entry offers now, and what its last merge means for it. */
function mergeDetail(entry: ForeignRuntimeHistoryEntry, merge?: ForeignRuntimeHistoryMergeState): string[] {
  const copyOf = oldCopyOf(entry);
  if (copyOf) return [`只读；它是${copyOf}的旧拷贝，不合并`];
  if (merge?.state === 'merged' && merge.intoCurrent && !merge.changedSinceMerge) {
    return ['只读；已合并进当前库', merge.skippedConversations ? keptForSkippedTip(merge.skippedConversations) : CLEANUP_TIP];
  }
  // The line on its unfinished work says why it is not merged now.
  if (unfinishedCount(entry) > 0) return ['只读'];
  if (merge?.state === 'blocked' || merge?.state === 'failed' || merge?.state === 'too-large') {
    return [`只读；没有合并：${merge.message.split('\n')[0]}`];
  }
  return ['只读；可以合并进当前库'];
}

function entryFacts(entry: ForeignRuntimeHistoryEntry, merge?: ForeignRuntimeHistoryMergeState): string {
  const size = entry.size ? `${formatBytes(entry.size.bytes)}（${entry.size.fileCount} 个文件）` : '大小未知';
  if (entry.status !== 'verified') return size;
  const summary = entry.summary;
  return [
    mergeStateText(merge),
    summary ? `${summary.conversationCount} 个对话` : '',
    summary?.lastActivityAt ? `最后活动 ${formatTime(summary.lastActivityAt)}` : '',
    summary?.projectNames.length ? summary.projectNames.slice(0, 3).join('、') : '',
    size
  ].filter(Boolean).join(' · ');
}

function entryDetail(entry: ForeignRuntimeHistoryEntry, identicalCopies: number, merge?: ForeignRuntimeHistoryMergeState): string {
  return [
    `位置：${entry.locatedPath}`,
    ...(entry.recordedDataRootPath ? [`原位置：${entry.recordedDataRootPath}`] : []),
    ...(entry.status === 'verified' ? mergeDetail(entry, merge) : [`原因：${entry.reason ?? '原因未知'}`, '原样保留，不会自动删除']),
    ...(unfinishedCount(entry) > 0 ? [`有 ${unfinishedCount(entry)} 项未结束的任务（旧窗口中断时留下），合并前需要收尾，当前版本不在外来目录里收尾，所以暂不合并；可以只读查看`] : []),
    ...(identicalCopies > 0 ? [`另有 ${identicalCopies} 份完全相同的拷贝`] : []),
    ...(entry.movedAsideBy ? [`迁移数据目录时挪到旁边（迁移 ${entry.movedAsideBy.slice(0, 8)}）`] : [])
  ].join(' · ');
}
