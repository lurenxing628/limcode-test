import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { settleHistoricalMergeSourceOffline } from '../../backend/application/reliableKernel/historicalMergeSettlement';
import type { RuntimeWriteGate } from '../../backend/application/reliableKernel/runtimeWriteGate';
import { loadCommittedGlobalStatus,resolveDataRootUri } from '../../backend/capabilities/vscodeStorage/globalStatus';
import { createVscodeStoragePaths } from '../../backend/capabilities/vscodeStorage/paths';
import { describeCurrentRuntimeContentUsage } from '../../backend/reliableKernel/runtimeContentUsage';
import {
type RuntimeDataSetHistory
} from '../../backend/reliableKernel/runtimeDataSetHistory';
import {
mergeHistoricalDataSetsOnline,
RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE,
type RuntimeDataSetExclusiveOutcome,type RuntimeDataSetMergeBatchResult,
type RuntimeDataSetMergeIssue,type RuntimeDataSetMergeResult,
type RuntimeDataSetOversizedMerge
} from '../../backend/reliableKernel/runtimeDataSetMerge';
import { upgradeDiscoveredRuntimeDataSets } from '../../backend/reliableKernel/runtimeDataSetUpgrade';
import type { RuntimeDatabase } from '../../backend/reliableKernel/runtimeDatabase';
import { registerRuntimeHistoryConvergence } from '../../backend/reliableKernel/runtimeHistoryConvergence';
import { readRuntimeHistoryPending } from '../../backend/reliableKernel/runtimeHistoryRegistry';
import { inspectRuntimeHistoryRepair,repairRuntimeHistory } from '../../backend/reliableKernel/runtimeHistoryRepair';
import { historyRepairCount } from '../../backend/reliableKernel/runtimeHistoryRepairInspection';
import { inspectRuntimeDataSetStorage } from '../../backend/reliableKernel/runtimeStorageInspection';
import {
inspectVscodeRuntimeDataSets,
type VscodeRuntimeDataSetCandidate
} from '../../backend/reliableKernel/vscodeRootAuthority';
import { EXTENSION_COMMAND_IDS } from '../../shared/extensionIdentity';
import type { ApplicationStartup } from '../ApplicationStartup';
import { canStartRuntimeDataSetUpgrade,runRuntimeDataSetUpgrade } from '../runtimeDataSetUpgradeLifetime';
import { requesterWorkBusy,runWithExclusiveMaintenance } from '../runtimeExclusiveMaintenance';
import { convergeRuntimeHistory,isHistoryConvergenceHost } from './runtimeHistoryConvergence';
import { manageRuntimeHistoryResiduals } from './runtimeHistoryResiduals';
import { confirmRuntimeHistorySettlement } from './runtimeHistorySettlement';

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
export async function openWithRuntimeDataSetSelection<T>(_context: vscode.ExtensionContext, open: () => Promise<T>): Promise<T> {
  return open();
}

/** User-invoked history/storage commands intentionally do not require a running database. */
export async function manageRuntimeDataSets(context: vscode.ExtensionContext, startup: ApplicationStartup): Promise<void> {
  if (!canStartRuntimeDataSetUpgrade(context)) return;
  await loadCommittedGlobalStatus(context);
  const pending = await readRuntimeHistoryPending(pathsFor(context));
  const action = await vscode.window.showQuickPick([
    { label: '未能合并的旧数据', action: 'residual' },
    { label: '立即合并全部', action: 'mergeAll' },
    { label: '查看存储占用', action: 'storage' },
    { label: '检查并修复当前历史', action: 'repair' },
    { label: '迁移数据目录', action: 'relocate' },
    { label: '清理备份', action: 'cleanupBackups' },
    { label: '归档并重置当前历史', action: 'reset' }
  ], { placeHolder: '历史与存储管理' + (pending.size ? ' · 还有 ' + pending.size + ' 份没合并' : '') });
  if (!action || !canStartRuntimeDataSetUpgrade(context)) return;
  if (action.action === 'residual') return manageRuntimeHistoryResiduals(context,
    () => mergeAllRuntimeHistory(context, startup), async () => !await refusedWhileFrozen(startup, '重新合并旧数据'));
  if (action.action === 'mergeAll') return mergeAllRuntimeHistory(context, startup);
  if (action.action === 'storage') return showRuntimeStorage(context, undefined, startup);
  const command = action.action === 'reset' ? EXTENSION_COMMAND_IDS.resetDevelopmentData
    : action.action === 'relocate' ? EXTENSION_COMMAND_IDS.relocateDataRoot
    : action.action === 'cleanupBackups' ? EXTENSION_COMMAND_IDS.cleanupBackups : undefined;
  if (command) { await vscode.commands.executeCommand(command); return; }
  if (await refusedWhileFrozen(startup, '检查并修复当前历史')) return;
  const current = (await inspectVscodeRuntimeDataSets(pathsFor(context))).candidates.find(item => item.selected);
  if (!current) { void vscode.window.showInformationMessage('当前历史尚未初始化。'); return; }
  await repairHistory(context, startup, current);
}

/** The fixed current library is repaired under the same window coordination used for migration. */
async function repairHistory(
  context: vscode.ExtensionContext, startup: ApplicationStartup, candidate: VscodeRuntimeDataSetCandidate
): Promise<void> {
  if (!candidate.selected) return repairHistoryNow(context, startup, candidate);
  const host = startup.current();
  if (!host) return repairHistoryNow(context, startup, candidate);
  if (!isHistoryConvergenceHost(host)) throw new Error('当前运行时无法进入独占维护，请重载窗口后重试。');
  const confirmed = await vscode.window.showWarningMessage('让当前历史离线并检查历史残留？', {
    modal: true, detail: '会等待各窗口任务结束、暂停当前库并重载相关窗口。检查结果显示后，仍需确认才会备份并修复；当前历史不会切换。'
  }, '离线检查');
  if (confirmed !== '离线检查' || await refusedWhileFrozen(startup, '检查历史残留')) return;
  const { paths, hostBootId } = host.exclusiveMaintenanceTarget();
  const configurationRootPath = host.dataRootPath();
  const busy = requesterWorkBusy(host);
  let closed = false;
  try {
    const outcome = await runWithExclusiveMaintenance(paths, {
      operation: 'historical-repair', operationKey: `history-repair:${candidate.dataSetId}:${candidate.rootInstanceId}`,
      message: '为检查并修复当前历史残留', waitingTitle: '正在等待其它窗口空闲后检查历史残留',
      configurationRootPath, requesterHostBootId: hostBootId, requesterBusy: busy,
      participantConfirmation: 'notice', whenBusy: 'wait', ignoreBackoff: true,
      isCurrent: () => canStartRuntimeDataSetUpgrade(context) && host.dataRootPath() === configurationRootPath,
      beforeGo: async () => {
        const active = await busy();
        if (active) return { busy: active };
        const thaw = host.freezeNewWork('检查并修复历史残留');
        try { const late = await busy(); return late ? { busy: late, thaw } : { thaw }; }
        catch (error) { thaw(); throw error; }
      },
      withLocks: body => host.withDataRootLocks(body)
    }, async () => {
      closed = true;
      await host.closeRuntime();
      await repairHistoryNow(context, startup, candidate, true);
    });
    if (outcome.state !== 'completed') await vscode.window.showInformationMessage(`历史残留检查未开始：${outcome.reason}`);
  } finally {
    if (closed) await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/** Explicit, independently backed-up repair, never a hidden fallback of a failed merge. */
async function repairHistoryNow(
  context: vscode.ExtensionContext, startup: ApplicationStartup, candidate: VscodeRuntimeDataSetCandidate, exclusive = false
): Promise<void> {
  if (!candidate.dataSetId || !candidate.rootInstanceId) throw new Error('历史库身份不完整，不能修复。');
  const paths = pathsFor(context);
  const stillCurrent = () => canStartRuntimeDataSetUpgrade(context)
    && pathsFor(context).globalStoragePath === paths.globalStoragePath;
  const gate = exclusive ? undefined : (startup.current() as { writeGate?: Pick<RuntimeWriteGate, 'run'> } | undefined)?.writeGate;
  const run = <T>(body: () => Promise<T>): Promise<T> => runRuntimeDataSetUpgrade(context, () => gate ? gate.run(body) : body());
  try {
    const plan = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在只读检查历史残留…' },
      () => run(() => inspectRuntimeHistoryRepair(paths, {
        candidateId: candidate.id, expectedDataSetId: candidate.dataSetId!, expectedRootInstanceId: candidate.rootInstanceId!
      })));
    if (!stillCurrent()) return;
    const facts = plan.expected;
    const previous = plan.previous.map((entry) => `之前的修复：${entry.committed ? '已提交（已按库内标记核实）' : '未提交'}；备份：${entry.backupPath}`).join('\n');
    const detail = `${'当前历史'}\n${candidate.runtimeDataRootPath}\n\n`
      + `父模型请求已缺失的终态操作：${facts.orphanOperations} 条；关联尝试：${facts.orphanAttempts} 条。\n`
      + `与未知结果回执矛盾、可恢复状态的进程：${facts.restoredUnknownProcesses} 条。\n`
      + `不能自动处理的问题：${facts.refused} 处。\n`
      + facts.samples.map((entry) => `${entry.domain} ${entry.id}：${entry.reason}`).join('\n')
      + (previous ? `\n\n${previous}` : '');
    if (facts.refused > 0) {
      await showReadOnly(context, '历史残留检查：需要人工处理，未修复', detail);
      await vscode.window.showWarningMessage('有非终态记录或保留依赖，不能安全自动修复。已显示检查结果；没有修改历史库。');
      return;
    }
    if (historyRepairCount(facts) === 0) {
      await vscode.window.showInformationMessage('没有属于此修复规则的历史残留。已经收尾的未知结果进程无需改成 exited；可以重新检查合并，其它错误仍需按合库详情处理。');
      if (previous) await showReadOnly(context, '历史修复记录', previous);
      return;
    }
    const confirmed = await vscode.window.showWarningMessage('先备份，再修复这些历史残留？', {
      modal: true, detail: detail + '\n\n先通过 SQLite 备份接口保存完整数据库，再在单个事务里修复。'
        + '只清理父记录缺失且无保留依赖的终态执行元数据；只按已有回执将误改为 exited 的状态恢复为 outcome_unknown。'
        + '不删除或重建对话，不虚构退出结果，不启动模型或进程，不清除合库账本；正文和附件不变。'
        + '修复备份保留在该库的 history-repair-backups 中，不自动清理。' + (candidate.selected ? '完成后重载当前库。' : '修复后仍需另行选择“合并到当前库”。')
    }, '备份并修复');
    if (confirmed !== '备份并修复' || !stillCurrent() || (!exclusive && await refusedWhileFrozen(startup, '修复历史残留'))) return;
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在备份并修复历史残留…' },
      () => run(() => repairRuntimeHistory(paths, plan)));
    if (!stillCurrent()) return;
    const text = result.result
      ? `历史残留已修复：清理 ${result.result.removedOperations} 条终态操作和 ${result.result.removedAttempts} 条尝试，恢复 ${result.result.restoredUnknownProcesses} 个进程的未知结果状态。备份：${result.backupPath}。${candidate.selected ? '完成后重载当前库。' : '请重新选择“合并到当前库”。'}`
      : '没有需要修复的历史残留。';
    if (result.warnings.length) await vscode.window.showWarningMessage(`${text}\n${result.warnings.join('\n')}`);
    else await vscode.window.showInformationMessage(text);
  } catch (error) {
    if (!stillCurrent()) return;
    await vscode.window.showErrorMessage(`历史残留检查或修复没有完成：${describeError(error)}`);
  }
}

/** The open Runtime of this window that receives historical merges. */
export interface HistoricalMergeHost {
  hasOwnedExecution?(): Promise<boolean>;
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
  candidateIds?: readonly string[],
  manualAll = false
): Promise<RuntimeDataSetMergeBatchResult | undefined> {
  if (!shouldContinue() || !canStartRuntimeDataSetUpgrade(context)) return undefined;
  const paths = pathsFor(context);
  const stillCurrent = () => canStartRuntimeDataSetUpgrade(context)
    && shouldContinue() && pathsFor(context).globalStoragePath === paths.globalStoragePath;
  let finishProgress: (() => void) | undefined;
  let progress: vscode.Progress<{ message?: string }> | undefined;
  let report: RuntimeDataSetMergeBatchResult;
  try {
    const status = await loadCommittedGlobalStatus(context);
    const previous = [...(status?.previousDataRoots ?? []), ...(status?.lastMigration?.fromPath ? [status.lastMigration.fromPath] : [])];
    const fresh = await registerRuntimeHistoryConvergence(paths, previous);
    if (fresh && stillCurrent()) void vscode.window.showInformationMessage(`发现 ${fresh} 份旧数据，正在后台并入当前历史。你在本版本里删掉的对话不会回来；更早版本里删掉、而旧数据里还有的对话会被加回来，合并后可以再删。原库保留作为备份，可以在“清理备份”里删除。`);
    report = await runRuntimeDataSetUpgrade(context, () => oneMergeBatchAtATime(() => mergeHistoricalDataSetsOnline(paths, {
      configurationRootPath: paths.globalStoragePath,
      database: host.product.application.database
    }, {
      shouldContinue: stillCurrent,
      isRuntimeIdle: async () => manualAll || !await host.hasOwnedExecution?.(),
      settleSourceWork: settleHistoricalMergeSourceOffline,
      confirmSettlement: input => confirmRuntimeHistorySettlement(input, stillCurrent),
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
      ...(candidateIds ? { coordinateOversized: (input: RuntimeDataSetOversizedMerge, merge: () => Promise<void>) => requestOtherWindowsToYield(paths, input, merge, stillCurrent) } : {})
    })));
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

  await reportHistoricalMerge(context, paths.globalStoragePath, report, stillCurrent, candidateIds !== undefined || manualAll);
  const waiting = largeMergeSessionSources(report);
  if (waiting.length && stillCurrent() && !manualAll) {
    void vscode.window.showInformationMessage('还有 ' + waiting.length + ' 份旧数据待合并，可选择“立即合并全部”。');
  }
  return report;
}

/**
 * Merge batches of this process run one after another (the startup batch, 合并到当前库, a foreign
 * root's merge, the answer to the question below): two at once would judge, close and copy the same
 * sources side by side, and one could copy a data set the other has open (its SQLite locks released).
 */
let mergeBatches: Promise<unknown> = Promise.resolve();

function oneMergeBatchAtATime<T>(run: () => Promise<T>): Promise<T> {
  const next = mergeBatches.then(run, run);
  mergeBatches = next.catch(() => undefined);
  return next;
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
    const text = `已把 ${merged.length} 份${details ? '较大的' : ''}旧聊天记录合并到当前历史（新增 ${conversations} 个对话），可直接在侧栏继续。`
      + mergedNotes(merged) + '原库和合并前备份都已保留。' + foreignMergedNote(merged);
    if (!details?.length) void vscode.window.showInformationMessage(text);
    else {
      // The large merge session: how many conversations each source added (or why not), on request.
      void Promise.resolve(vscode.window.showInformationMessage(text, '查看详情')).then(async choice => {
        if (choice !== '查看详情' || !stillCurrent()) return;
        await showReadOnly(context, '较大的旧聊天记录合并结果', details.join('\n\n'));
      }).then(undefined, error => console.warn('[LimCode] 无法显示较大的旧聊天记录合并详情。', error));
    }
  }
  // Merged by another window after this batch picked it: that window told what was new.
  const byAnotherWindow = report.merged.filter(item => item.alreadyMerged && item.mergedByAnotherWindow);
  if (byAnotherWindow.length) {
    void vscode.window.showInformationMessage(
      `${requested ? '旧数据' : `${byAnotherWindow.length} 份旧聊天记录`}已由另一个窗口合并到当前历史。${mergedNotes(byAnotherWindow)}${foreignMergedNote(byAnotherWindow)}`
    );
  }
  const current = report.merged.filter(item => item.alreadyMerged && !item.mergedByAnotherWindow);
  if (current.length) {
    void vscode.window.showInformationMessage(
      `${requested ? '旧数据' : `${current.length} 份旧聊天记录`}已合并到当前历史，没有新内容。${mergedNotes(current)}${foreignMergedNote(current)}`
    );
  }
  // The user's click always hears back, also when the engine found nothing to do for it.
  if (requested && !report.stopped && !report.merged.length && !issues.length) {
    void vscode.window.showInformationMessage('这次没有需要合并的旧数据。');
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
      `${problem.label ?? problem.candidateId ?? '历史库列表'}\n[${problem.code}] ${problem.message}`
    ).join('\n\n'));
  }).then(undefined, error => console.warn('[LimCode] 无法显示旧聊天记录合并详情。', error));
}

/** One log line per merged source, with everything its notice summarizes. */
function mergedLog(merged: RuntimeDataSetMergeResult): string {
  const name = merged.label ? `${merged.label}（${merged.candidateId}）` : merged.candidateId;
  return (merged.alreadyMerged
    ? `旧聊天记录 ${name} ${merged.mergedByAnotherWindow ? '已由另一个窗口合并到当前历史' : '已合并到当前历史，没有新内容'}`
    : `已合并旧聊天记录 ${name}：新增 ${merged.insertedRows} 行；合并前备份：${merged.backupPath ?? '（确认上次已提交的合并）'}`)
    + (merged.finalized ? `；收尾 ${merged.finalized.turns} 个中断任务，另有 ${merged.finalized.intents} 条排队未发送的消息已取消，`
      + `收尾前来源备份：${merged.finalized.sourceBackupPath}` : '')
    + (merged.skippedConversations ? `；${merged.skippedConversations} 个你删除过的对话没有再合并` : '');
}

/**
 * Foreign history roots (archives, copied directories) are only read by a merge: once their content is
 * in the current data set, backup cleanup can prove it by coverage and delete them.
 */
function foreignMergedNote(results: readonly RuntimeDataSetMergeResult[]): string {
  const foreign = results.filter(result => result.label);
  if (!foreign.length) return '';
  const kept = foreign.filter(result => result.skippedConversations);
  const covered = foreign.filter(result => !result.skippedConversations);
  return (covered.length ? `${covered.map(result => result.label).join('、')}原样保留；确认不再需要时，可以在“清理备份”里按覆盖核对后删除。` : '')
    + kept.map(result => `${result.label}${keptForSkippedTip(result.skippedConversations!)}`).join('');
}

/**
 * Instead of the cleanup tip for a foreign copy whose merge left out conversations the user had
 * deleted in the current data set: backup cleanup keeps it (it holds conversations found nowhere else).
 */
export function keptForSkippedTip(skipped: number): string {
  return `合并时跳过了 ${skipped} 个你删除过的对话，它们只在这份里还有，所以“清理备份”会保留这份；确实不再需要时请手动删除。`;
}

/** What merged sources also did: work closed before merging, and conversations deliberately left out. */
function mergedNotes(results: readonly RuntimeDataSetMergeResult[]): string {
  const total = (count: (result: RuntimeDataSetMergeResult) => number): number => results.reduce((sum, result) => sum + count(result), 0);
  const turns = total(result => result.finalized?.turns ?? 0);
  const intents = total(result => result.finalized?.intents ?? 0);
  const skipped = total(result => result.skippedConversations ?? 0);
  const excluded = total(result => result.excluded?.length ?? 0);
  return (turns ? `其中 ${turns} 个中断的任务已按“中止”收尾，不会被继续执行。` : '')
    + (intents ? `另有 ${intents} 条排队未发送的消息已取消。` : '')
    + (skipped ? `有 ${skipped} 个对话你删除过，这次没有合并回来。` : '')
    + (excluded ? `另有 ${excluded} 个对话未能合并，原数据保留，详情见“未能合并的旧数据”。` : '');
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
/**
 * These entries write (the current library, or another one in place): refused at once while this
 * window is frozen for a data-directory operation (“正在迁移数据目录，完成后再操作。”), like any
 * other write command, before anything is asked or changed.
 */
async function refusedWhileFrozen(startup: ApplicationStartup, what: string): Promise<boolean> {
  return refusedWhileWriteFrozen(startup.current(), what);
}

/** refusedWhileFrozen, for the application at hand (the host a background merge runs for). */
async function refusedWhileWriteFrozen(application: unknown, what: string): Promise<boolean> {
  const gate = (application as { writeGate?: { admit(): void } } | undefined)?.writeGate;
  try {
    gate?.admit();
    return false;
  } catch (error) {
    await vscode.window.showWarningMessage(`现在不能${what}：${describeError(error)}。没有做任何改动。`);
    return true;
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
  if (!candidate) throw new Error('当前历史尚未初始化。');
  const id = candidate.id;
  const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在统计当前历史占用…' },
    () => inspectRuntimeDataSetStorage(pathsFor(context), id));
  // Per content type only for the selected data set, read through this window's own open worker.
  const contentUsage = await describeCurrentRuntimeContentUsage({ ...candidate, selected: report.selected },
    (startup?.current() as Partial<HistoricalMergeHost> | undefined)?.product?.application.database, formatBytes);
  const labels = { sqlite: 'SQLite 数据库', cas: '历史正文与附件（CAS）', casTemporary: 'CAS 临时残留', processSpool: '进程输出暂存', diagnostics: '诊断日志', other: '其它运行文件', historicalBackups: '完整历史备份' };
  const lines = Object.entries(report.categories).map(([key, size]) =>
    `${labels[key as keyof typeof labels]}：${size.fileCount} 个文件，${formatBytes(size.bytes)}`);
  await showReadOnly(context, '当前历史占用', [
    '当前历史', candidate.runtimeDataRootPath, '', ...lines,
    '', `合计：${report.total.fileCount} 个文件，${formatBytes(report.total.bytes)}`,
    '这里统计文件逻辑大小，运行中的库可能继续变化。历史正文不是可随意清除的缓存；保留归档不会释放其磁盘占用。',
    ...contentUsage
  ].join('\n'));
}

/** Read-only paging of one history source: an unselected local data set or a verified foreign history root. */
export async function browseRuntimeHistory(
  context: vscode.ExtensionContext,
  label: string,
  open: () => Promise<RuntimeDataSetHistory>,
  source = '未能合并的旧数据'
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

/** Explicit action is the sole entry to exclusive convergence. */
export async function mergeAllRuntimeHistory(context: vscode.ExtensionContext, startup: ApplicationStartup): Promise<void> {
  if (await refusedWhileFrozen(startup, '合并全部旧数据')) return;
  const host = startup.current();
  if (!isHistoryConvergenceHost(host)) { void vscode.window.showErrorMessage('运行时没有打开，不能合并旧数据。'); return; }
  const batch = await mergeHistoricalDataSetsInBackground(context, host, () => canStartRuntimeDataSetUpgrade(context), undefined, true);
  if (!batch || !canStartRuntimeDataSetUpgrade(context)) return;
  const waiting = largeMergeSessionSources(batch);
  if (waiting.length) await convergeRuntimeHistory(context, host, waiting,
    result => reportHistoricalMerge(context, host.dataRootPath(), result, () => canStartRuntimeDataSetUpgrade(context), true));
}
