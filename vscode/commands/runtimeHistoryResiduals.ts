import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveDataRootUri } from '../../backend/capabilities/vscodeStorage/globalStatus';
import { createVscodeStoragePaths } from '../../backend/capabilities/vscodeStorage/paths';
import { locateLocalRuntimeDataSet, openRuntimeDataSetHistory, type RuntimeDataSetHistory } from '../../backend/reliableKernel/runtimeDataSetHistory';
import { locateForeignRuntimeRoot } from '../../backend/reliableKernel/runtimeForeignHistory';
import { readRuntimeHistoryResidual, writeRuntimeHistoryPending, reconcileRuntimeResetBackups, type RuntimeHistoryResidual } from '../../backend/reliableKernel/runtimeHistoryRegistry';
import { browseRuntimeHistory, formatBytes, showReadOnly } from './runtimeDataSetManagement';

/** The durable registry is the authority; opening this menu never scans the history bodies. */
export async function manageRuntimeHistoryResiduals(context: vscode.ExtensionContext, retry: () => Promise<void>, canRetry: () => Promise<boolean> = async () => true): Promise<void> {
  const paths = createVscodeStoragePaths(resolveDataRootUri(context));
  await reconcileRuntimeResetBackups(paths);
  const records = await readRuntimeHistoryResidual(paths);
  if (!records.size) { await vscode.window.showInformationMessage('没有未能合并的旧数据。'); return; }
  const choice = await vscode.window.showQuickPick([...records.values()].map(record => ({
    label: record.location.kind === 'local' ? record.location.candidateId : record.location.containerName,
    description: `${record.bytes === undefined ? '大小尚未统计' : formatBytes(record.bytes)}${record.excluded?.length ? ` · ${record.excluded.length} 个对话未合并` : ''}`,
    detail: `${locationText(record)} · ${record.message}`, record
  })), { placeHolder: '未能合并的旧数据 · 原数据保留', matchOnDetail: true });
  if (!choice) return;
  const record = choice.record;
  const action = await vscode.window.showQuickPick([
    { label: '只读查看', action: 'read' },
    { label: '查看原因与剔除清单', action: 'details' },
    { label: '打开所在文件夹', action: 'folder' },
    { label: '重新核验并合并', description: '登记待合并；未能合并的内容继续保留', action: 'retry' }
  ], { placeHolder: choice.label });
  if (!action) return;
  if (action.action === 'details') {
    await showReadOnly(context, '未能合并的旧数据', [locationText(record), `[${record.code}] ${record.message}`,
      `最后核验：${record.checkedAt}`, ...(record.excluded ?? []).map(item => `${item.title || item.conversationId} [${item.code}] ${item.count}`)].join('\n'));
  } else if (action.action === 'folder') {
    const folder = record.location.kind === 'local'
      ? (await locateLocalRuntimeDataSet(paths, record.location.candidateId)).located.dataRootPath
      : record.location.containerPath;
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(folder));
  } else if (action.action === 'retry') {
    if (!await canRetry()) return;
    const located = record.location.kind === 'local'
      ? await locateLocalRuntimeDataSet(paths, record.location.candidateId)
      : await locateForeignRuntimeRoot(paths.globalStoragePath, record.location);
    await writeRuntimeHistoryPending(paths, { id: record.id, sourceKind: record.sourceKind, location: record.location,
      identity: { dataSetId: located.recorded.dataSetId, rootInstanceId: located.recorded.rootInstanceId }, reason: '用户在残留列表里选择重新合并', registeredAt: new Date().toISOString() });
    await retry();
  } else {
    await browseRuntimeHistory(context, choice.label, async () => {
      const root = record.location.kind === 'local'
        ? await locateLocalRuntimeDataSet(paths, record.location.candidateId)
        : await locateForeignRuntimeRoot(paths.globalStoragePath, record.location);
      return residualHistory(await openRuntimeDataSetHistory(paths, root), record);
    }, '未能合并的旧数据');
  }
}

function locationText(record: RuntimeHistoryResidual): string {
  return record.location.kind === 'local' ? record.location.candidateId
    : path.join(record.location.containerPath, record.location.dataRootRelativePath);
}

/** Partial sources expose only excluded conversations, retaining the underlying reader's view claim. */
export function residualHistory(history: RuntimeDataSetHistory, record: Pick<RuntimeHistoryResidual, 'excluded'>): RuntimeDataSetHistory {
  if (!record.excluded?.length) return history;
  const included = new Set(record.excluded.map(item => item.conversationId));
  return {
    root: history.root,
    async listConversations(input) {
      let after = input?.after;
      for (;;) {
        const page = await history.listConversations({ ...input, after });
        const items = page.items.filter(item => included.has(item.id));
        if (items.length || !page.next) return { items, next: page.next };
        after = page.next;
      }
    },
    readMessages: (id, input) => {
      if (!included.has(id)) throw new Error('该对话不在未合并清单中。');
      return history.readMessages(id, input);
    },
    readMessageText: (id, messageId, input) => {
      if (!included.has(id)) throw new Error('该对话不在未合并清单中。');
      return history.readMessageText(id, messageId, input);
    },
    close: () => history.close()
  };
}
