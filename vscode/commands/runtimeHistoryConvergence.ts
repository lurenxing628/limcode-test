import * as vscode from 'vscode';
import { settleHistoricalMergeSourceOffline } from '../../backend/application/reliableKernel/historicalMergeSettlement';
import type { RuntimeWriteGate } from '../../backend/application/reliableKernel/runtimeWriteGate';
import type { RuntimeRootPaths } from '../../backend/reliableKernel/contracts';
import type { RuntimeDatabase } from '../../backend/reliableKernel/runtimeDatabase';
import type { RuntimeDataSetMergeBatchResult } from '../../backend/reliableKernel/runtimeDataSetMerge';
import {
prepareLargeMergeSources,releaseLargeMergePreparation,runLargeMergeSession,
type LargeMergePreparation,type LargeMergeSessionResult
} from '../../backend/reliableKernel/runtimeDataSetStreamedMerge';
import type { BridgeClientId,ExtensionToWebviewMessage } from '../../shared/protocol';
import { MainPanel } from '../panels/MainPanel';
import { canStartRuntimeDataSetUpgrade,runRuntimeDataSetUpgrade } from '../runtimeDataSetUpgradeLifetime';
import { holdOwnExclusiveMaintenanceWork,requesterWorkBusy,runWithExclusiveMaintenance } from '../runtimeExclusiveMaintenance';
import { confirmRuntimeHistorySettlement } from './runtimeHistorySettlement';

export interface HistoryConvergenceHost {
  product: { application: { database: RuntimeDatabase } };
  hasOwnedExecution(): Promise<boolean>;
  exclusiveMaintenanceTarget(): { paths: RuntimeRootPaths; hostBootId: string };
  dataRootPath(): string;
  withDataRootLocks<R>(body: () => Promise<R>): Promise<R>;
  freezeNewWork(activity: string): () => void;
  closeRuntime(): Promise<void>;
  postToWebview?(clientId: BridgeClientId, message: ExtensionToWebviewMessage): boolean;
  writeGate?: Pick<RuntimeWriteGate, 'admit' | 'frozen'>;
}

export function isHistoryConvergenceHost(value: unknown): value is HistoryConvergenceHost {
  const host = value as Partial<HistoryConvergenceHost> | undefined;
  return typeof host?.withDataRootLocks === 'function' && typeof host.closeRuntime === 'function'
    && typeof host.freezeNewWork === 'function' && typeof host.hasOwnedExecution === 'function'
    && typeof host.exclusiveMaintenanceTarget === 'function' && typeof host.dataRootPath === 'function'
    && host.product?.application?.database !== undefined;
}

let running = false;

/** The sole explicit convergence command: prepare once, coordinate once, then reload. */
export async function convergeRuntimeHistory(
  context: vscode.ExtensionContext, host: HistoryConvergenceHost, candidateIds: readonly string[],
  report: (batch: RuntimeDataSetMergeBatchResult) => Promise<void>
): Promise<void> {
  if (!candidateIds.length) return;
  if (running) { void vscode.window.showInformationMessage('本窗口已在合并旧数据。'); return; }
  host.writeGate?.admit();
  running = true;
  const root = host.dataRootPath();
  const paths = { globalStoragePath: root };
  const current = () => canStartRuntimeDataSetUpgrade(context) && host.dataRootPath() === root;
  const releaseHold = holdOwnExclusiveMaintenanceWork(host, { operation: 'historical-merge', activity: '合并全部旧数据' });
  let prepared: LargeMergePreparation | undefined;
  let runtimeClosed = false;
  try {
    prepared = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: '正在准备合并全部旧数据', cancellable: true }, async (progress, token) => {
      const abort = new AbortController();
      const cancellation = token.onCancellationRequested(() => abort.abort());
      const watch = setInterval(() => { if (!current()) abort.abort(); }, 200);
      try {
        return await runRuntimeDataSetUpgrade(context, () => prepareLargeMergeSources({
          paths, target: { configurationRootPath: root, database: host.product.application.database },
          candidateIds, requested: true, threshold: 'online', signal: abort.signal,
          options: { settleSourceWork: settleHistoricalMergeSourceOffline,
            confirmSettlement: input => confirmRuntimeHistorySettlement(input, current) },
          onProgress: item => progress.report({ message: `${item.index + 1}/${item.total} · ${item.stage}` })
        }));
      } finally { clearInterval(watch); cancellation.dispose(); }
    });
    await report({ ...prepared.report, pendingSources: 0 });
    if (!prepared.sources.length || !current() || prepared.report.stopped) return;
    host.writeGate?.admit();
    const ready = prepared;
    const { paths: targetPaths, hostBootId } = host.exclusiveMaintenanceTarget();
    const busy = requesterWorkBusy(host);
    const outcome = await runWithExclusiveMaintenance(targetPaths, {
      operation: 'historical-merge', operationKey: `history-convergence:${ready.target.dataSetId}/${ready.target.rootInstanceId}`,
      message: '为合并全部旧数据', waitingTitle: '正在等待其它窗口空闲后合并旧数据',
      configurationRootPath: root, requesterHostBootId: hostBootId, requesterBusy: busy,
      beforeGo: async () => {
        const before = await busy();
        if (before) return { busy: before };
        const thaw = host.freezeNewWork('合并全部旧数据');
        const after = await busy().catch(() => ({ kind: 'work' as const, reason: '无法确认本窗口是否空闲' }));
        return after ? { busy: after, thaw } : { thaw };
      },
      participantConfirmation: 'notice', whenBusy: 'wait', ignoreBackoff: true, cancellable: false,
      isCurrent: current, windowState: context.workspaceState, withLocks: body => host.withDataRootLocks(body)
    }, async ({ reportStage }) => {
      const saved = MainPanel.saveComposerDrafts((id, message) => host.postToWebview?.(id, message) ?? false);
      if (saved > 0) await new Promise(resolve => setTimeout(resolve, 250));
      reportStage('正在关闭运行时并合并旧数据');
      runtimeClosed = true;
      await host.closeRuntime();
      return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: '正在合并旧数据', cancellable: true }, async (progress, token) => {
        const abort = new AbortController();
        const cancellation = token.onCancellationRequested(() => abort.abort());
        const watch = setInterval(() => { if (!current()) abort.abort(); }, 200);
        try {
          return await runRuntimeDataSetUpgrade(context, () => runLargeMergeSession({ paths, prepared: ready,
            signal: abort.signal, onProgress: item => {
              const message = `${item.index + 1}/${item.total} · ${item.stage} · ${item.sessionRows}/${item.sessionTotalRows}`;
              reportStage(message); progress.report({ message });
            } }));
        } finally { clearInterval(watch); cancellation.dispose(); }
      });
    });
    if (outcome.state === 'completed') await report(convergenceResult(outcome.result));
    else void vscode.window.showWarningMessage(`旧数据这次未合并：${outcome.reason}`);
  } finally {
    try { if (prepared) await releaseLargeMergePreparation(prepared); }
    finally {
      releaseHold(); running = false;
      if (runtimeClosed) await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }
}

function convergenceResult(session: LargeMergeSessionResult): RuntimeDataSetMergeBatchResult {
  const batch: RuntimeDataSetMergeBatchResult = { merged: [], deferred: [], blocked: [], failures: [], pendingSources: 0, stopped: session.cancelled };
  for (const item of session.results) {
    if (item.state === 'merged' || item.state === 'current') batch.merged.push(item.result);
    else if (item.state === 'not-run') batch.deferred.push({ candidateId: item.candidateId, requested: true,
      code: `runtime-data-set-merge-${item.reason}`, message: item.reason === 'cancelled' ? '合并已取消，这份旧数据原样保留。' : '磁盘空间不足，这份旧数据原样保留。' });
    else (item.state === 'blocked' ? batch.blocked : item.state === 'failed' ? batch.failures : batch.deferred).push({ ...item.issue, requested: true });
  }
  return batch;
}
