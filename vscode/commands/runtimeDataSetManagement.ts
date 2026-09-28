import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { loadCommittedGlobalStatus, resolveDataRootUri } from '../../backend/capabilities/vscodeStorage/globalStatus';
import { createVscodeStoragePaths } from '../../backend/capabilities/vscodeStorage/paths';
import {
  inspectVscodeRuntimeDataSets, resolveVscodeRuntimeDataSet, selectVscodeRuntimeDataSet, VscodeRuntimeDataSetSelectionRequiredError,
  type VscodeRuntimeDataSetCandidate, type VscodeRuntimeDataSetProblem
} from '../../backend/reliableKernel/vscodeRootAuthority';
import {
  locateLocalRuntimeDataSet, openRuntimeDataSetHistory, type RuntimeDataSetHistory
} from '../../backend/reliableKernel/runtimeDataSetHistory';
import { upgradeDiscoveredRuntimeDataSets, upgradeRuntimeDataSet } from '../../backend/reliableKernel/runtimeDataSetUpgrade';
import {
  mergeHistoricalDataSetsOnline, readRuntimeDataSetMergeStates, requestRuntimeDataSetMerge, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE,
  RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS, RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS, RUNTIME_DATA_SET_STREAMED_MERGE_MAX_ROWS,
  withRuntimeDataSetReadClaims,
  type RuntimeDataSetExclusiveOutcome, type RuntimeDataSetMergeBatchResult, type RuntimeDataSetMergedFacts,
  type RuntimeDataSetMergeIssue, type RuntimeDataSetMergeResult, type RuntimeDataSetMergeState, type RuntimeDataSetOversizedMerge
} from '../../backend/reliableKernel/runtimeDataSetMerge';
import { summarizeRuntimeDataSet, type RuntimeDataSetSummary } from '../../backend/reliableKernel/runtimeDataSetPreflight';
import type { RuntimeDatabase } from '../../backend/reliableKernel/runtimeDatabase';
import { EXCLUSIVE_MAINTENANCE_DEFAULTS } from '../../backend/reliableKernel/runtimeExclusiveMaintenance';
import { inspectRuntimeDataSetStorage, deleteUnselectedRuntimeDataSet } from '../../backend/reliableKernel/runtimeStorageInspection';
import { describeCurrentRuntimeContentUsage } from '../../backend/reliableKernel/runtimeContentUsage';
import { largeMergeEngine, type LargeMergeWaitingSource } from '../../backend/reliableKernel/runtimeLargeMergeEngine';
import {
  formatLargeMergeRowsWithUnit, largeMergeWaitingText, takeLargeMergeResult
} from '../../backend/reliableKernel/runtimeLargeMergeSession';
import type { ApplicationStartup } from '../ApplicationStartup';
import { canStartRuntimeDataSetUpgrade, runRuntimeDataSetUpgrade } from '../runtimeDataSetUpgradeLifetime';
import { runWithExclusiveMaintenance } from '../runtimeExclusiveMaintenance';
import { EXTENSION_COMMAND_IDS } from '../../shared/extensionIdentity';
import { manageForeignRuntimeHistory } from './foreignRuntimeHistory';
import {
  isLargeHistoricalMergeHost, LARGE_MERGE_SESSION_CAUSE, offerLargeHistoricalMerge, startLargeHistoricalMerge,
  type LargeHistoricalMergeOptions
} from './largeHistoricalMerge';

export { announceForeignRuntimeHistoryOnStartup } from './foreignRuntimeHistory';

const pathsFor = (context: vscode.ExtensionContext) => createVscodeStoragePaths(resolveDataRootUri(context));
const STARTUP_NOTICE_LEDGER_KEY = 'limcode.runtimeDataSetStartupNotices';

/**
 * Startup notices about old data sets appear once per distinct cause and configuration root, so a
 * source that keeps failing does not interrupt every window start. Causes accumulate: only a data
 * set evaluated again in this run can drop its old causes, so an unevaluated cause is never
 * forgotten and re-announced. Details stay in the log and in 历史与存储管理.
 */
async function freshStartupNotices(
  context: vscode.ExtensionContext,
  configurationRootPath: string,
  topic: 'upgrade' | 'merge',
  causes: ReadonlyArray<{ candidateId?: string; code?: string; message: string }>,
  evaluated: ReadonlySet<string>
): Promise<Set<string>> {
  const keys = causes.map(noticeCause);
  const state = (context as Partial<vscode.ExtensionContext>).globalState;
  if (!state) return new Set(keys);
  type Ledger = Record<string, Partial<Record<'upgrade' | 'merge', string[]>>>;
  const ledger = state.get<Ledger>(STARTUP_NOTICE_LEDGER_KEY) ?? {};
  const seen = ledger[configurationRootPath]?.[topic] ?? [];
  const fresh = new Set(keys.filter(key => !seen.includes(key)));
  const retained = seen.filter(key => !evaluated.has(key.split('\u0000')[0]) || keys.includes(key));
  const next: Ledger = {
    ...ledger,
    [configurationRootPath]: { ...ledger[configurationRootPath], [topic]: [...new Set([...retained, ...keys])] }
  };
  await Promise.resolve(state.update(STARTUP_NOTICE_LEDGER_KEY, next))
    .catch(error => console.warn('[LimCode] 无法记录已显示的旧聊天记录提示。', error));
  return fresh;
}

function noticeCause(issue: { candidateId?: string; code?: string; message: string }): string {
  return `${issue.candidateId ?? ''}\u0000${issue.code ?? issue.message}`;
}

/** Startup has released admission before awaiting this native picker. It also works without a Webview. */
export async function openWithRuntimeDataSetSelection<T>(context: vscode.ExtensionContext, open: () => Promise<T>): Promise<T> {
  try { return await open(); }
  catch (error) {
    if (!(error instanceof VscodeRuntimeDataSetSelectionRequiredError)) throw error;
    const candidate = await chooseDataSet(error.candidates, '选择当前历史库；其它历史库会在打开后自动合并进来', error.problems,
      new Map(), { summarizeSelected: true, startup: true });
    if (!candidate) throw new Error('尚未选择历史库。可从“历史与存储管理”选择后重载窗口。');
    await selectVscodeRuntimeDataSet(pathsFor(context), candidate.id);
    return open();
  }
}

/** At startup no library is current yet: only the chosen one becomes current, so none is "other". */
function dataSetLabel(
  candidate: VscodeRuntimeDataSetCandidate,
  merge?: RuntimeDataSetMergeState,
  summary?: RuntimeDataSetSummary,
  startup = false,
  waiting?: LargeMergeWaitingSource
): string {
  const name = summary?.projectNames.length
    ? summary.projectNames.join('、')
    : candidate.source === 'workspace' ? '旧工作区历史' : '默认历史库';
  const role = candidate.selected ? '当前历史库 · ' : startup ? '' : '其他历史库 · ';
  // Waiting for the large merge session (大库会话): the size the last batch measured, whatever the ledger said before.
  const state = waiting ? ` · 较大，等待合并（${largeMergeWaitingText(waiting.rows)}）` : mergeStateSuffix(merge);
  return `${role}${name}${state}`;
}

function mergeStateSuffix(merge?: RuntimeDataSetMergeState): string {
  if (!merge) return '';
  if (merge.state === 'merged') {
    if (merge.targetMissing) return ' · 曾合并到的库已不存在或无法读取';
    if (merge.sourceUnreadable) return ' · 已合并，现在无法读取（不能判断合并后有没有变化）';
    if (merge.changedSinceMerge) return ' · 已合并，但合并后有新变化';
    return merge.intoCurrent ? ' · 已合并到当前库' : ' · 已合并到其它历史库';
  }
  if (merge.state === 'blocked' || merge.state === 'failed') return merge.lastMerged ? ' · 之前合并过，再次合并未成功' : ' · 未能合并';
  if (merge.state === 'requested') return ' · 等待合并';
  if (merge.state === 'too-large') return ` · 约 ${formatLargeMergeRowsWithUnit(merge.rows)}记录，超过当前版本能安全合并的规模`;
  return ' · 你保留的库（不自动合并）';
}

/** The last merge of this data set, whatever happened to later attempts. */
function lastMergeOf(merge?: RuntimeDataSetMergeState): RuntimeDataSetMergedFacts | undefined {
  return merge?.state === 'merged' ? merge : merge?.lastMerged;
}

function dataSetFacts(candidate: VscodeRuntimeDataSetCandidate, summary?: RuntimeDataSetSummary): string {
  const version = isPublishedOldDataSet(candidate) ? `旧格式（版本 ${candidate.runtimeKernelEpoch}）` : undefined;
  return [
    ...(summary ? [`${summary.conversationCount} 个对话`] : []),
    ...(summary?.lastActivityAt ? [`最后活动 ${formatActivity(summary.lastActivityAt)}`] : []),
    ...(version ? [version] : [])
  ].join(' · ');
}

function formatActivity(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function isPublishedOldDataSet(candidate: VscodeRuntimeDataSetCandidate): boolean {
  return candidate.runtimeKernelEpoch === 3 || candidate.runtimeKernelEpoch === 4;
}

/**
 * Names, counts and last activity come from a private snapshot of each data set, taken under that
 * data set's claims (as every opener of it in this process holds them). The selected data set is
 * skipped while this window has it open: copying its files would release this process's SQLite
 * locks on them.
 */
async function chooseDataSet(
  candidates: readonly VscodeRuntimeDataSetCandidate[],
  placeHolder: string,
  problems: readonly VscodeRuntimeDataSetProblem[] = [],
  mergeStates: ReadonlyMap<string, RuntimeDataSetMergeState> = new Map(),
  options: { summarizeSelected?: boolean; startup?: boolean; waiting?: readonly LargeMergeWaitingSource[] } = {}
) {
  // Read in a worker from private copies, one data set at a time, kept per file state.
  const summaries = new Map<string, RuntimeDataSetSummary | 'unreadable'>();
  for (const candidate of candidates) {
    // A library without data has nothing to read (and no maintenance claim of its own).
    if ((candidate.selected && !options.summarizeSelected) || !candidate.dataSetId) continue;
    const summary = await withRuntimeDataSetReadClaims({ globalStoragePath: candidate.configurationRootPath }, candidate,
      () => summarizeRuntimeDataSet(candidate)).catch(() => 'unreadable' as const);
    if (summary) summaries.set(candidate.id, summary);
  }
  // A startup preflight rejection names a candidate: shown on that candidate, still choosable.
  const candidateProblems = new Map(problems.filter(problem => candidates.some(candidate => candidate.id === problem.id))
    .map(problem => [problem.id, problem]));
  const items: Array<vscode.QuickPickItem & { candidate?: VscodeRuntimeDataSetCandidate; problem?: VscodeRuntimeDataSetProblem }> = [
    ...candidates.map(candidate => {
      const merge = mergeStates.get(candidate.id);
      const read = summaries.get(candidate.id);
      const summary = read === 'unreadable' ? undefined : read;
      const rejected = candidateProblems.get(candidate.id);
      const message = rejected ? `\n打开前检查未通过：${rejected.message}`
        : merge?.state === 'blocked' || merge?.state === 'failed' || merge?.state === 'too-large' ? `\n${merge.message}` : '';
      return {
        label: dataSetLabel(candidate, merge, summary, options.startup, options.waiting?.find((item) => item.candidateId === candidate.id)),
        description: [
          rejected ? '暂时无法自动打开' : '',
          read === 'unreadable' ? '对话数和最后活动读取失败（只是没读到，库没有被改动）' : '',
          dataSetFacts(candidate, summary)
        ].filter(Boolean).join(' · '),
        detail: `${candidate.runtimeDataRootPath}${message}`, candidate
      };
    }),
    ...problems.filter(problem => !candidateProblems.has(problem.id)).map(problem => ({
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

function alreadyMergedHere(merge?: RuntimeDataSetMergeState): boolean {
  return merge?.state === 'merged' && merge.intoCurrent && !merge.changedSinceMerge && !merge.sourceUnreadable;
}

/** User-invoked history/storage commands intentionally do not require a running database. */
export async function manageRuntimeDataSets(context: vscode.ExtensionContext, startup: ApplicationStartup): Promise<void> {
  if (!canStartRuntimeDataSetUpgrade(context)) return;
  await loadCommittedGlobalStatus(context);
  if (!canStartRuntimeDataSetUpgrade(context)) return;
  // Sources waiting for the large merge session, as this window's last batch measured them (nothing is read here).
  const waiting = await largeMergeEngine().waiting(pathsFor(context)).catch(() => [] as LargeMergeWaitingSource[]);
  const waitingRows = waiting.reduce((sum, item) => sum + item.rows, 0);
  const action = await vscode.window.showQuickPick([
    { label: '其他历史库', description: '查看旧聊天；旧格式会先自动备份升级', action: 'history' },
    { label: '外来历史库', description: '归档与从别处拷来的目录里的旧聊天；只读查看，以后的版本支持合并', action: 'foreign' },
    { label: '查看存储占用', description: '按需统计正文、数据库、临时文件与备份', action: 'storage' },
    { label: '合并到当前库', description: '把其他历史库的对话并入当前库；在后台进行，原库保留', action: 'merge' },
    ...(waiting.length > 0 ? [{
      label: `合并较大的旧聊天记录（${waiting.length} 份，${largeMergeWaitingText(waitingRows)}）`,
      description: '先在后台准备；合并期间所有 LimCode 窗口暂停并显示进度，完成后自动恢复', action: 'largeMerge'
    }] : []),
    { label: '切换当前历史库', description: '保留完整原库，切换后重载窗口', action: 'select' },
    { label: '删除其他历史库', description: '仅删除明确选定的非当前完整历史库', action: 'delete' },
    { label: '迁移数据目录', description: '把全部历史和设置复制到新目录并核对后切换；旧目录保留', action: 'relocate' },
    { label: '清理备份', description: '在设置页核对并删除已完整存在于本地库的备份', action: 'cleanupBackups' },
    { label: '归档并重置当前历史库', description: '保留备份并创建空库；归档本身不释放磁盘', action: 'reset' }
  ], { placeHolder: '历史与存储管理' });
  if (!action || !canStartRuntimeDataSetUpgrade(context)) return;
  if (action.action === 'reset') {
    await vscode.commands.executeCommand(EXTENSION_COMMAND_IDS.resetDevelopmentData);
    return;
  }
  if (action.action === 'relocate') {
    await vscode.commands.executeCommand(EXTENSION_COMMAND_IDS.relocateDataRoot);
    return;
  }
  if (action.action === 'foreign') {
    await manageForeignRuntimeHistory(context);
    return;
  }
  if (action.action === 'cleanupBackups') {
    // Only opens the settings page at 其他 → 数据目录; the cleanup runs from its button.
    await vscode.commands.executeCommand(EXTENSION_COMMAND_IDS.cleanupBackups);
    return;
  }
  if (action.action === 'largeMerge') {
    const host = startup.current();
    if (!isLargeHistoricalMergeHost(host)) {
      await vscode.window.showErrorMessage('运行时没有打开，不能合并较大的旧聊天记录。');
      return;
    }
    await startLargeHistoricalMerge(context, host, largeMergeOptions(context, host.dataRootPath(), () => canStartRuntimeDataSetUpgrade(context)));
    return;
  }
  const { candidates, problems } = await inspectVscodeRuntimeDataSets(pathsFor(context));
  if (!canStartRuntimeDataSetUpgrade(context)) return;
  const mergeStates = await readRuntimeDataSetMergeStates(pathsFor(context)).catch(() => new Map<string, RuntimeDataSetMergeState>());
  const eligible = action.action === 'merge'
    ? candidates.filter(candidate => !candidate.selected && candidate.dataSetId && !alreadyMergedHere(mergeStates.get(candidate.id)))
    : action.action === 'history' || action.action === 'delete'
      ? candidates.filter(candidate => !candidate.selected) : candidates;
  if (!eligible.length) {
    if (problems.length) {
      await chooseDataSet([], '这些历史库暂时无法打开；选择一项查看原因', problems);
    } else {
      await vscode.window.showInformationMessage(action.action === 'merge' && candidates.some(candidate => !candidate.selected)
        ? '其他历史库都已合并到当前库。'
        : candidates.length ? '没有其他历史库。当前库的对话可在侧栏查看。' : '尚无历史库，打开对话后会创建。');
    }
    return;
  }
  const candidate = await chooseDataSet(eligible, action.label, problems, mergeStates, { waiting });
  if (!candidate || !canStartRuntimeDataSetUpgrade(context)) return;
  if (action.action === 'merge') { await mergeNow(context, startup, candidate, mergeStates.get(candidate.id)); return; }
  if (action.action === 'storage') { await showRuntimeStorage(context, candidate, startup); return; }
  if (action.action === 'history') {
    const readable = isPublishedOldDataSet(candidate) ? await upgradeHistoryBeforeRead(context, candidate) : candidate;
    if (readable && canStartRuntimeDataSetUpgrade(context)) await browseHistory(context, readable);
    return;
  }
  if (action.action === 'delete') {
    // Native VS Code command: no settings Webview exists here, so use the shell's modal confirmation.
    const confirmed = await vscode.window.showWarningMessage('永久删除这个历史库及其备份？', {
      modal: true, detail: `${dataSetLabel(candidate, mergeStates.get(candidate.id))}\n${candidate.runtimeDataRootPath}\n\n此操作不能撤销，不会删除当前历史库或共享设置。`
        + '它的归档（归档并重置留下的 .limcode-runtime-backups）会保留，之后作为外来历史库出现在“历史与存储管理 → 外来历史库”里，核验通过的可以只读查看。'
        + deletionNote(candidate, mergeStates.get(candidate.id))
    }, '永久删除');
    if (confirmed !== '永久删除') return;
    if (!candidate.dataSetId) throw new Error('历史库尚未完整初始化，不能删除。');
    await deleteUnselectedRuntimeDataSet(pathsFor(context), candidate.id, candidate.dataSetId);
    await vscode.window.showInformationMessage('所选历史库已删除。');
    return;
  }
  await switchHistory(context, startup, candidate, mergeStates.get(candidate.id));
}

function deletionNote(candidate: VscodeRuntimeDataSetCandidate, merge?: RuntimeDataSetMergeState): string {
  // No state: never merged and not recorded (e.g. only deferred so far), so pending an automatic merge.
  if (!merge) {
    return candidate.dataSetId
      ? '\n\n注意：这个库还没有合并到当前库（它会在之后的启动中自动合并），删除后其中的对话会永久丢失；需要保留时请先选择“合并到当前库”。'
      : '';
  }
  const merged = lastMergeOf(merge);
  if (!merged) return '\n\n注意：这个库的对话还没有合并到任何库，删除后会永久丢失。';
  if (merged.targetMissing) {
    return '\n\n注意：这个库曾合并到的库已被删除、重置或暂时无法读取，这里的对话可能已不在任何现存的库里，删除会永久丢失；'
      + '需要保留时请先选择“合并到当前库”。';
  }
  if (merged.sourceUnreadable) {
    return '\n\n注意：现在无法读取这个库，不能确认它在上次合并之后有没有改动；如果有，删除后这些改动会永久丢失。';
  }
  if (merged.changedSinceMerge) {
    return '\n\n注意：这个库在上次合并之后又有改动（例如在这里继续过对话），这些改动没有合并进任何库，删除会永久丢失。'
      + '只是新建过对话时，可以先选择“合并到当前库”；在已合并的对话里继续过时，再次合并会整体不合并，请保留这个库。';
  }
  return merged.intoCurrent ? '已合并到当前库的对话和正文不受影响。' : '这个库的对话已合并到另一个现存的历史库，删除后只能在那个库里看到。';
}

/** What an explicit merge of a data set merged before is expected to do. */
function remergeNote(merged?: RuntimeDataSetMergedFacts): string {
  if (!merged) return '';
  if (merged.targetMissing) return '\n\n这个库曾合并到的库已不存在或无法读取；这次会把它的对话写入当前库。';
  if (!merged.intoCurrent) return '';
  if (merged.sourceUnreadable) return '\n\n现在无法读取这个库，不能确认它在上次合并之后有没有改动；合并时会重新核验，读不出来会说明原因。';
  if (!merged.changedSinceMerge) return '';
  return '\n\n这个库在上次合并到当前库之后又有改动：只新建过对话时，新对话会合并进来；'
    + '在已合并、当前库里也还在的对话里继续过时，那些对话与当前库里的那份不同，会整体不合并并说明原因，这时请保留这个库。';
}

/**
 * What an explicit merge of a source above the online limit does, by the engine's two size bounds:
 * up to the in-memory transaction bound other windows yield for its one transaction; above it, up
 * to the streamed bound, it goes to the large merge session (大库会话); only above that it is too large.
 */
function oversizedMergeNote(): string {
  const { maxRows, maxBytes } = RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS;
  const minutes = Math.round(EXCLUSIVE_MAINTENANCE_DEFAULTS.busyWaitTimeoutMs / 60_000);
  const streamed = formatLargeMergeRowsWithUnit(RUNTIME_DATA_SET_STREAMED_MERGE_MAX_ROWS);
  return `超过 ${maxRows} 条记录或 ${Math.round(maxBytes / (1024 * 1024))} MiB 的库需要其它窗口暂时让出：`
    + `会在后台等其它窗口的任务结束、正在使用的窗口被切走（最多约 ${minutes} 分钟，可取消），然后其它窗口会重载一次（未发送的输入会保留）；`
    + '等不到时这次先不合并，之后启动时会再试。'
    + `超过 ${formatLargeMergeRowsWithUnit(RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS)}、不到 ${streamed}记录的库在“大库会话”里合并：`
    + '先在后台准备（窗口照常可用），再单独确认一次，然后所有 LimCode 窗口暂停并显示进度，完成后自动恢复；'
    + `超过 ${streamed}记录的库当前版本不能安全合并，会说明原因。`;
}

/**
 * Explicit merge of one data set, online: no window reload. The request is recorded first, so a
 * closed window or a busy source is retried by a later startup.
 */
async function mergeNow(
  context: vscode.ExtensionContext,
  startup: ApplicationStartup,
  candidate: VscodeRuntimeDataSetCandidate,
  merge?: RuntimeDataSetMergeState
): Promise<void> {
  const changed = remergeNote(lastMergeOf(merge));
  const confirmed = await vscode.window.showWarningMessage('把这个历史库合并到当前库？', {
    modal: true, detail: `来源：${candidate.runtimeDataRootPath}\n\n在后台合并，不需要重载窗口：先备份当前库，再把对话写入当前库。`
      + '原库保留（已发布的旧格式会先备份并就地升级）；原库里中断的任务按“中止”收尾、排队未发送的消息会被取消，都不会在当前库被继续执行。'
      + '以前从这个库合并进当前库、之后你在当前库删除了的对话不会再合并回来（连同它们的子 Agent 对话，在这个库里继续过的也一样）。'
      + '无法自动收尾的工作或数据冲突时整体不合并，并说明原因。' + oversizedMergeNote() + changed
  }, '合并');
  if (confirmed !== '合并' || !candidate.dataSetId || !candidate.rootInstanceId) return;
  await requestRuntimeDataSetMerge(pathsFor(context), {
    candidateId: candidate.id, expectedDataSetId: candidate.dataSetId, expectedRootInstanceId: candidate.rootInstanceId
  });
  const host = startup.current() as Partial<HistoricalMergeHost> | undefined;
  if (!host?.product) {
    await vscode.window.showInformationMessage('已记录合并请求，当前历史库打开后会自动合并。');
    return;
  }
  await mergeHistoricalDataSetsInBackground(context, host as HistoricalMergeHost, () => true, [candidate.id]);
}

async function switchHistory(
  context: vscode.ExtensionContext,
  startup: ApplicationStartup,
  candidate: VscodeRuntimeDataSetCandidate,
  merge?: RuntimeDataSetMergeState
): Promise<void> {
  if (candidate.selected) { await vscode.window.showInformationMessage('已经在使用这个历史库。'); return; }
  const merged = lastMergeOf(merge);
  const mergedHere = merged?.intoCurrent
    ? (!merged.changedSinceMerge && !merged.sourceUnreadable
      ? '\n\n这个库的对话已合并到当前库。切换过去后如果在已合并的对话里继续聊天，这个库以后就不能再合并回当前库（会整体不合并）；'
        + '只新建对话、不动已合并的对话时，新对话以后仍可合并回来。'
      : '')
      + '\n\n从这个库合并进当前库、之后在当前库删除了的对话，以后再合并时不会被插回（在这个库里继续过也一样）。'
    : '';
  const confirmed = await vscode.window.showWarningMessage('切换当前历史库并重载窗口？', {
    modal: true, detail: `目标：${candidate.runtimeDataRootPath}\n\n当前窗口的运行会停止。请先关闭其它使用同一数据目录的 VS Code 窗口。`
      + '切换本身不合并、不搬移任何数据，所有原历史保留。'
      + '\n\n切换后，现在的当前库会记为“你保留的库”，以后只在你选择“合并到当前库”时才合并；'
      + '其它还没合并过、也不是你保留的旧库，会在下次打开时自动合并进新的当前库。' + mergedHere
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

/** The open Runtime of this window that receives historical merges. */
export interface HistoricalMergeHost {
  product: { application: { database: RuntimeDatabase } };
}

/**
 * Runs after the current Runtime is ready, in the background, like the historical upgrades:
 * pending data sets are merged online, one source per short write transaction, while this and
 * other windows keep working. It never throws and never asks anything: every outcome is a
 * notification, each cause at most once unless the user explicitly asked for that merge.
 * Sources left to the large merge session (大库会话) go on there: offered in one window after a
 * startup, confirmed right away after the user's click.
 */
export async function mergeHistoricalDataSetsInBackground(
  context: vscode.ExtensionContext,
  host: HistoricalMergeHost,
  shouldContinue: () => boolean = () => true,
  candidateIds?: readonly string[]
): Promise<RuntimeDataSetMergeBatchResult | undefined> {
  if (!shouldContinue() || !canStartRuntimeDataSetUpgrade(context)) return undefined;
  const paths = pathsFor(context);
  const stillCurrent = () => canStartRuntimeDataSetUpgrade(context)
    && shouldContinue() && pathsFor(context).globalStoragePath === paths.globalStoragePath;
  let finishProgress: (() => void) | undefined;
  let progress: vscode.Progress<{ message?: string }> | undefined;
  let report: RuntimeDataSetMergeBatchResult;
  try {
    report = await runRuntimeDataSetUpgrade(context, () => mergeHistoricalDataSetsOnline(paths, {
      configurationRootPath: paths.globalStoragePath,
      database: host.product.application.database
    }, {
      shouldContinue: stillCurrent,
      // Only the call made for the user's click is an explicit request (the engine never infers it).
      ...(candidateIds ? { candidateIds, requested: true } : {}),
      onWorkStart: () => {
        const done = new Promise<void>(resolve => { finishProgress = resolve; });
        void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在合并旧聊天记录' },
          reporter => { progress = reporter; return done; });
      },
      onSourceStart: (_candidate, index, total) => progress?.report({ message: `${index + 1}/${total}` }),
      // An automatic source above the online limit goes along with a large merge session of the same
      // batch (the engine then leaves it awaiting); only without one is it coordinated on its own.
      coordinateOversized: (input, merge) => requestOtherWindowsToYield(paths, input, merge, stillCurrent)
    }));
  } catch (error) {
    console.error('[LimCode] 旧聊天记录合并检查失败。', error);
    const fresh = await freshStartupNotices(context, paths.globalStoragePath, 'merge',
      [{ code: 'batch', message: describeError(error) }], new Set(['']));
    if ((fresh.size > 0 || candidateIds) && stillCurrent()) {
      void vscode.window.showWarningMessage(`旧聊天记录暂时无法合并：${describeError(error)}。已有数据未被修改，稍后会自动重试。`);
    }
    return undefined;
  } finally {
    finishProgress?.();
  }
  // Which sources wait for the large merge session now (the management menu and list show them).
  largeMergeEngine().noteBatch(paths, report);
  await reportHistoricalMerge(context, paths.globalStoragePath, report, stillCurrent, candidateIds !== undefined);
  const session = largeMergeSessionSources(report);
  if (session.length > 0 && isLargeHistoricalMergeHost(host) && stillCurrent()) {
    const options = largeMergeOptions(context, paths.globalStoragePath, stillCurrent);
    if (candidateIds) await startLargeHistoricalMerge(context, host, { ...options, candidateIds: session });
    // Not awaited: the prompt counts down and the session may wait for other windows; the startup goes on.
    else void offerLargeHistoricalMerge(context, host, session, options)
      .catch(error => console.error('[LimCode] 合并较大的旧聊天记录失败。', error));
  }
  return report;
}

/**
 * Sources the batch left to the large merge session: above the in-memory bound, and with one of them
 * every other source above the online bound (the engine defers them alike).
 */
function largeMergeSessionSources(report: RuntimeDataSetMergeBatchResult): string[] {
  return report.deferred.filter((issue) => issue.candidateId !== undefined && isLargeMergeSessionIssue(issue))
    .map((issue) => issue.candidateId!);
}

function isLargeMergeSessionIssue(issue: RuntimeDataSetMergeIssue): boolean {
  return issue.code === RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE;
}

/** How the large merge session tells its outcomes: like this module's, with the same startup-notice dedup. */
function largeMergeOptions(
  context: vscode.ExtensionContext,
  configurationRootPath: string,
  stillCurrent: () => boolean
): LargeHistoricalMergeOptions {
  const state = (context as Partial<vscode.ExtensionContext>).workspaceState;
  return {
    report: (batch, requested, details) => reportHistoricalMerge(context, configurationRootPath, batch, stillCurrent, requested, details),
    freshCause: async (code, message) => (await freshStartupNotices(context, configurationRootPath, 'merge',
      [{ candidateId: LARGE_MERGE_SESSION_CAUSE, code, message }], new Set([LARGE_MERGE_SESSION_CAUSE]))).size > 0,
    isCurrent: stillCurrent,
    ...(state ? { windowState: state } : {})
  };
}

/**
 * Once after this window opened again following its large merge session (the result it kept
 * before reloading, see largeHistoricalMerge.ts): each source's outcome, told like the online
 * batch's. `openedAt` is when the extension started activating.
 */
export async function reportLargeHistoricalMergeKeptAcrossReload(
  context: vscode.ExtensionContext,
  shouldContinue: () => boolean = () => true,
  openedAt: number = Date.now()
): Promise<void> {
  const state = (context as Partial<vscode.ExtensionContext>).workspaceState;
  if (!state) return;
  const kept = takeLargeMergeResult(state, openedAt);
  if (!kept) return;
  const stillCurrent = () => canStartRuntimeDataSetUpgrade(context) && shouldContinue();
  if (kept.error && stillCurrent()) void vscode.window.showWarningMessage(`合并较大的旧聊天记录时出错：${kept.error}。`);
  if (kept.notStarted && stillCurrent()) {
    void vscode.window.showWarningMessage(`合并较大的旧聊天记录没有进行：${kept.notStarted}。当前历史库没有改动；`
      + '腾出空间后，下次启动时会再提示，也可以在“历史与存储管理”里手动开始。');
  }
  if (kept.report) await reportHistoricalMerge(context, kept.configurationRootPath, kept.report, stillCurrent, kept.requested, kept.details);
}

/**
 * The only place that asks other windows to yield, for one source above the online merge limit
 * that the engine already prepared and checked. The two-phase primitive decides how windows are
 * asked (backoff per source state; a busy or older window withdraws the request). The engine calls
 * it outside its locks and hands over `withLocks`, which the primitive takes only once every window
 * is ready. A merge the user explicitly asked for waits, bounded and without any lock, for busy
 * windows and skips the per-source backoff (never the cooldown); other windows then only see a
 * notice, because the user already confirmed here.
 */
async function requestOtherWindowsToYield(
  paths: { globalStoragePath: string },
  input: RuntimeDataSetOversizedMerge,
  merge: () => Promise<void>,
  isCurrent: () => boolean
): Promise<RuntimeDataSetExclusiveOutcome> {
  const outcome = await runWithExclusiveMaintenance(input.targetPaths, {
    operation: 'historical-merge',
    operationKey: input.operationKey,
    message: '为合并较大的旧聊天记录',
    waitingTitle: '正在等待其它窗口空闲后合并较大的旧聊天记录',
    configurationRootPath: paths.globalStoragePath,
    requesterHostBootId: input.requesterHostBootId,
    ignoreBackoff: input.requested,
    ...(input.requested ? { whenBusy: 'wait' as const, participantConfirmation: 'notice' as const } : {}),
    isDeterministicFailure: input.isDeterministicFailure,
    withLocks: input.withLocks,
    isCurrent
  }, merge);
  return outcome.state === 'completed' ? { state: 'completed' } : { state: outcome.state, reason: outcome.reason };
}

async function reportHistoricalMerge(
  context: vscode.ExtensionContext,
  configurationRootPath: string,
  report: RuntimeDataSetMergeBatchResult,
  stillCurrent: () => boolean,
  requested: boolean,
  details?: readonly string[]
): Promise<void> {
  for (const merged of report.merged) console.info(`[LimCode] ${mergedLog(merged)}`);
  const issues = [...report.deferred, ...report.blocked, ...report.failures];
  if (issues.length) console.warn('[LimCode] 部分旧聊天记录暂未合并。', issues);
  const evaluated = new Set([...report.merged.map(item => item.candidateId), ...issues.map(item => item.candidateId ?? '')]);
  const fresh = await freshStartupNotices(context, configurationRootPath, 'merge',
    issues.filter(issue => issue.newly !== false), evaluated);
  if (!stillCurrent()) return;
  const merged = report.merged.filter(item => !item.alreadyMerged);
  if (merged.length) {
    const conversations = merged.reduce((sum, item) => sum + item.insertedConversations, 0);
    const text = `已把 ${merged.length} 份${details ? '较大的' : ''}旧聊天记录合并到当前历史库（新增 ${conversations} 个对话），可直接在侧栏继续。`
      + mergedNotes(merged) + '原库和合并前备份都已保留。';
    if (!details?.length) void vscode.window.showInformationMessage(text);
    else {
      // The large merge session: how many conversations each source added (or why not), on request.
      void Promise.resolve(vscode.window.showInformationMessage(text, '查看详情')).then(async choice => {
        if (choice !== '查看详情' || !stillCurrent()) return;
        await showReadOnly(context, '较大的旧聊天记录合并结果', details.join('\n\n'));
      }).then(undefined, error => console.warn('[LimCode] 无法显示较大的旧聊天记录合并详情。', error));
    }
  }
  const current = report.merged.filter(item => item.alreadyMerged);
  if (current.length) {
    void vscode.window.showInformationMessage(
      `${requested ? '所选历史库' : `${current.length} 份旧聊天记录`}已合并到当前历史库，没有新内容。${mergedNotes(current)}`
    );
  }
  // The user's click always hears back, also when the engine found nothing to do for it.
  if (requested && !report.stopped && !report.merged.length && !issues.length) {
    void vscode.window.showInformationMessage('这次没有合并：所选历史库已不在，或者当前历史库已经切换。可以重新打开“历史与存储管理”查看。');
  }
  // Another window's request merges the same source right now (superseded): nothing to tell here.
  // A source left to the large merge session is told by that session (its prompt, confirmation or result).
  const announce = (issue: RuntimeDataSetMergeIssue) => !isLargeMergeSessionIssue(issue) && (issue.requested
    || (issue.code !== 'runtime-data-set-merge-exclusive-superseded' && fresh.has(noticeCause(issue))));
  const deferred = report.deferred.filter(announce);
  if (deferred.length) {
    void vscode.window.showInformationMessage(
      `有 ${deferred.length} 份旧聊天记录暂时无法合并（${deferred.map(issue => withoutFullStop(issue.message)).join('；')}），以后启动时会自动重试。`
    );
  }
  const problems = [...report.blocked, ...report.failures].filter(announce);
  if (!problems.length) return;
  void vscode.window.showWarningMessage(
    '部分旧聊天记录未能合并到当前库，当前库的对话没有改动；各库的情况（例如已发布的旧格式先备份并就地升级、中断的任务已收尾）见原因。', '查看原因'
  ).then(async choice => {
    if (choice !== '查看原因' || !stillCurrent()) return;
    await showReadOnly(context, '旧聊天记录合并结果', problems.map(problem =>
      `${problem.candidateId ?? '历史库列表'}\n[${problem.code}] ${problem.message}`
    ).join('\n\n'));
  }).then(undefined, error => console.warn('[LimCode] 无法显示旧聊天记录合并详情。', error));
}

/** One log line per merged source, with everything its notice summarizes. */
function mergedLog(merged: RuntimeDataSetMergeResult): string {
  return (merged.alreadyMerged
    ? `旧聊天记录 ${merged.candidateId} 已合并到当前历史库，没有新内容`
    : `已合并旧聊天记录 ${merged.candidateId}：新增 ${merged.insertedRows} 行；合并前备份：${merged.backupPath ?? '（确认上次已提交的合并）'}`)
    + (merged.finalized ? `；收尾 ${merged.finalized.turns} 个中断任务，另有 ${merged.finalized.intents} 条排队未发送的消息已取消，`
      + `收尾前来源备份：${merged.finalized.sourceBackupPath}` : '')
    + (merged.skippedConversations ? `；${merged.skippedConversations} 个之前合并进来、之后在当前库删除的对话没有再合并` : '');
}

/** What merged sources also did: work closed before merging, and conversations deliberately left out. */
function mergedNotes(results: readonly RuntimeDataSetMergeResult[]): string {
  const total = (count: (result: RuntimeDataSetMergeResult) => number): number => results.reduce((sum, result) => sum + count(result), 0);
  const turns = total(result => result.finalized?.turns ?? 0);
  const intents = total(result => result.finalized?.intents ?? 0);
  const skipped = total(result => result.skippedConversations ?? 0);
  return (turns ? `其中 ${turns} 个中断的任务已按“中止”收尾，不会被继续执行。` : '')
    + (intents ? `另有 ${intents} 条排队未发送的消息已取消。` : '')
    + (skipped ? `有 ${skipped} 个对话以前合并进来、之后你在当前库删除了，这次没有再合并回来。` : '');
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
    const evaluated = new Set([...report.results.map(result => result.candidateId), ...report.failures.map(failure => failure.candidateId ?? '')]);
    const fresh = await freshStartupNotices(context, paths.globalStoragePath, 'upgrade', report.failures, evaluated);
    if (!report.failures.length) return;
    console.warn('[LimCode] 部分旧聊天记录未能自动升级。', report.failures);
    if (fresh.size === 0 || !stillCurrent()) return;
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
    const fresh = await freshStartupNotices(context, paths.globalStoragePath, 'upgrade',
      [{ code: 'batch', message: describeError(error) }], new Set(['']));
    if (fresh.size > 0 && stillCurrent()) void vscode.window.showErrorMessage(`无法自动检查旧聊天记录：${describeError(error)}。原数据未被重置。`);
  }
}

/** For text the caller follows with its own punctuation (no “。。”). */
function withoutFullStop(text: string): string {
  return text.trim().replace(/[。．.]+$/u, '');
}

/** Callers add their own full stop. */
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
    const message = withoutFullStop(typeof code === 'string' ? `[${code}] ${current.message}` : current.message);
    if (!messages.includes(message)) messages.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return messages.join('；') || String(error);
}

export async function showRuntimeStorage(
  context: vscode.ExtensionContext,
  candidate?: VscodeRuntimeDataSetCandidate,
  startup?: ApplicationStartup
): Promise<void> {
  await loadCommittedGlobalStatus(context);
  candidate ??= (await inspectVscodeRuntimeDataSets(pathsFor(context))).candidates.find(item => item.selected);
  if (!candidate) throw new Error('请先选择当前历史库。');
  const id = candidate.id;
  const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在统计历史库占用…' },
    () => inspectRuntimeDataSetStorage(pathsFor(context), id));
  // Per content type only for the selected data set, read through this window's own open worker.
  const contentUsage = await describeCurrentRuntimeContentUsage({ ...candidate, selected: report.selected },
    (startup?.current() as Partial<HistoricalMergeHost> | undefined)?.product?.application.database, formatBytes);
  const labels = { sqlite: 'SQLite 数据库', cas: '历史正文与附件（CAS）', casTemporary: 'CAS 临时残留', processSpool: '进程输出暂存', diagnostics: '诊断日志', other: '其它运行文件', historicalBackups: '完整历史备份' };
  const lines = Object.entries(report.categories).map(([key, size]) =>
    `${labels[key as keyof typeof labels]}：${size.fileCount} 个文件，${formatBytes(size.bytes)}`);
  await showReadOnly(context, '历史库占用', [
    dataSetLabel(candidate), candidate.runtimeDataRootPath, '', ...lines,
    '', `合计：${report.total.fileCount} 个文件，${formatBytes(report.total.bytes)}`,
    '这里统计文件逻辑大小，运行中的库可能继续变化。历史正文不是可随意清除的缓存；保留归档不会释放其磁盘占用。',
    ...contentUsage
  ].join('\n'));
}

async function browseHistory(context: vscode.ExtensionContext, candidate: VscodeRuntimeDataSetCandidate): Promise<void> {
  const paths = pathsFor(context);
  await browseRuntimeHistory(context, dataSetLabel(candidate),
    async () => openRuntimeDataSetHistory(paths, await locateLocalRuntimeDataSet(paths, candidate.id)));
}

/** Read-only paging of one history source: an unselected local data set or a verified foreign history root. */
export async function browseRuntimeHistory(
  context: vscode.ExtensionContext,
  label: string,
  open: () => Promise<RuntimeDataSetHistory>,
  source = '其它历史库'
): Promise<void> {
  const history = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在打开只读历史…' }, open);
  try {
    let after: { updatedAt: string; id: string } | undefined;
    for (;;) {
      const page = await history.listConversations({ limit: 50, after });
      const choices: Array<vscode.QuickPickItem & { id?: string; next?: boolean }> = page.items.map(item => ({
        label: item.title || item.id, description: item.updatedAt, detail: item.id, id: item.id
      }));
      if (page.next) choices.push({ label: '下一页会话', next: true });
      if (!choices.length) { await vscode.window.showInformationMessage('这个历史库没有会话。'); return; }
      const choice = await vscode.window.showQuickPick(choices, { placeHolder: `${label} · 只读历史`, matchOnDetail: true });
      if (!choice) return;
      if (choice.next) { after = page.next; continue; }
      if (choice.id) await browseMessages(context, history, choice.id, choice.label, source);
    }
  } finally { await history.close(); }
}

async function browseMessages(context: vscode.ExtensionContext, history: RuntimeDataSetHistory, conversationId: string, title: string, source: string) {
  let after: string | undefined;
  for (;;) {
    const page = await history.readMessages(conversationId, { limit: 50, after });
    await showReadOnly(context, title, [title, `${source} · 只读，不会恢复执行`, '', ...page.items.map(item =>
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
export async function showReadOnly(context: vscode.ExtensionContext, title: string, text: string): Promise<void> {
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

export function formatBytes(value: string): string {
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
