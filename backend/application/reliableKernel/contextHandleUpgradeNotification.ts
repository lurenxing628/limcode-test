import * as vscode from 'vscode';
import type { ReliableKernelApplication } from '../../reliableKernel/runtimeApplication';
import { readConversationContextHandleStateRow } from '../../reliableKernel/conversationContextHandleState';
import { listPendingContextHandleUpgrades, upgradePendingConversationContextHandles, upgradeConversationContextHandles,
  type ContextHandleUpgradeFailure } from '../../reliableKernel/conversationContextHandleUpgrade';

interface UpgradeNotifications {
  running: Map<string, Promise<void>>;
  failed: Map<string, ContextHandleUpgradeFailure>;
}
const notifications = new WeakMap<ReliableKernelApplication, UpgradeNotifications>();

/** A failed conversation does not reopen progress on every unrelated commit. Explicit retry stays available. */
export function upgradeContextHandlesWithProgress(application: ReliableKernelApplication,
  signal?: AbortSignal, conversationId?: string): Promise<void> {
  let state = notifications.get(application);
  if (!state) { state = { running: new Map(), failed: new Map() }; notifications.set(application, state); }
  const notification = state;
  const key = conversationId ?? '*';
  const existing = notification.running.get(key);
  if (existing) return existing;
  const job = (async () => {
    const skipped = new Set<string>();
    if (conversationId) {
      if ((await readConversationContextHandleStateRow(application.database, conversationId)).state === 'ready') return;
      notification.failed.delete(conversationId);
    } else {
      const pending = await listPendingContextHandleUpgrades(application.database);
      const ids = new Set(pending.map(row => String(row.conversation_id)));
      for (const id of notification.failed.keys()) if (!ids.has(id)) notification.failed.delete(id);
      for (const row of pending) {
        const previous = notification.failed.get(String(row.conversation_id));
        if (previous && previous.contextRootId === row.context_root_id && previous.provenanceRevision === String(row.provenance_revision)) {
          skipped.add(String(row.conversation_id));
        }
      }
      if (pending.every(row => skipped.has(String(row.conversation_id)))) return;
    }
    const failures = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: 'LimCode：升级对话引用目录（可取消后继续）', cancellable: true }, async (progress, token) => {
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason ?? Object.assign(
        new Error('对话引用目录升级已取消，下次可继续。'), { name: 'AbortError' }));
      const cancellation = token.onCancellationRequested(abort);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted || token.isCancellationRequested) abort();
      let reportedAt = 0;
      const options = {
        signal: controller.signal,
        onProgress: (value: { conversationIndex: number; conversationCount: number; completedRequests: number; totalRequests: number }) => {
          const now = Date.now();
          if (now - reportedAt < 100 && value.completedRequests !== value.totalRequests) return;
          reportedAt = now;
          progress.report({ message: `对话 ${value.conversationIndex}/${value.conversationCount}，已核对 ${value.completedRequests}/${value.totalRequests} 份历史请求` });
        }
      };
      try {
        if (conversationId) {
          await upgradeConversationContextHandles(application.database, application.contentStore, conversationId, options);
          return [];
        }
        return await upgradePendingConversationContextHandles(application.database, application.contentStore,
          { ...options, skipConversationIds: skipped });
      } finally { cancellation.dispose(); signal?.removeEventListener('abort', abort); }
    });
    if (!failures.length) return;
    for (const failure of failures) {
      notification.failed.set(failure.conversationId, failure);
      console.error(`[LimCode] 对话 ${failure.conversationId} 的引用目录升级暂停。`, failure.error);
    }
    void vscode.window.showWarningMessage(
      `${failures.length} 个对话的引用目录暂未升级，其余对话已继续处理。原历史保留，详细原因见日志。`, '重试升级'
    ).then(async action => {
      if (action !== '重试升级' || signal?.aborted) return;
      await job;
      notification.failed.clear();
      await upgradeContextHandlesWithProgress(application, signal);
    }).then(undefined, error => console.error('[LimCode] 对话引用目录重试暂停。', error));
  })();
  notification.running.set(key, job);
  void job.finally(() => {
    if (notification.running.get(key) === job) notification.running.delete(key);
  }).catch(() => undefined);
  return job;
}
