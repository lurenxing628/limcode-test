import * as vscode from 'vscode';
import {
  deleteRuntimeBackups, planRuntimeBackupCleanup,
  type RuntimeBackupCleanupCurrent, type RuntimeBackupCleanupItem, type RuntimeBackupCleanupPlan,
  type RuntimeBackupCleanupResult, type RuntimeBackupKind
} from '../../backend/reliableKernel/runtimeBackupCleanup';
import { EXTENSION_COMMAND_IDS } from '../../shared/extensionIdentity';
import type { RuntimeWriteGate } from '../../backend/application/reliableKernel/runtimeWriteGate';
import type { BridgeClientId, DataRootPromptSection, ExtensionToWebviewMessage } from '../../shared/protocol';
import type { ApplicationStartup } from '../ApplicationStartup';
import { askInSettingsPage, type DataRootPrompt, type DataRootPromptAnswer } from '../dataRootPrompts';
import { canStartRuntimeDataSetUpgrade, runRuntimeDataSetUpgrade } from '../runtimeDataSetUpgradeLifetime';

/** What 清理备份 needs of the open Runtime (the reliable-kernel Facade). */
export interface BackupCleanupHost {
  product: { application: { database: RuntimeBackupCleanupCurrent } };
  /** The configuration root (data directory) of this window. */
  dataRootPath(): string;
  postToWebview(clientId: BridgeClientId, message: ExtensionToWebviewMessage): boolean;
  /**
   * The window's entry-level write freeze (an exclusive data-directory operation is under way):
   * deleting backups is a write, refused while frozen ("正在迁移数据目录，完成后再操作。").
   */
  writeGate?: Pick<RuntimeWriteGate, 'admit' | 'run'>;
}

type Ask = (prompt: DataRootPrompt) => Promise<DataRootPromptAnswer>;

const CANCEL = { key: 'cancel', label: '取消', variant: 'secondary' as const };
const OK = { key: 'cancel', label: '知道了', variant: 'secondary' as const };
const SETTINGS_LOCATION = '其他 → 数据目录';
const DELETABLE_KINDS: ReadonlySet<RuntimeBackupKind> = new Set(['epoch-migration', 'merge-target', 'merge-source']);

/** Group order of the first panel: the three kinds that can be proven first, then the listed ones. */
const KINDS: ReadonlyArray<{ kind: RuntimeBackupKind; title: string; purpose: string }> = [
  { kind: 'epoch-migration', title: '升级前备份', purpose: '旧版本的历史库自动升级到当前格式之前，整份数据库的备份' },
  { kind: 'merge-target', title: '合并前备份', purpose: '把其它历史库合并进来之前，接收合并的库的整份备份' },
  { kind: 'merge-source', title: '合并来源的收尾前备份', purpose: '合并前收尾来源库里没有结束的任务之前，来源库的整份备份' },
  { kind: 'reset-archive', title: '“归档并重置”的归档（只列出）', purpose: '“归档并重置”时整份保留的历史库' },
  { kind: 'copied-data-root', title: '迁移时从别处拷来的目录（只列出）', purpose: '迁移数据目录时在新目录里发现、挪到旁边保留的 LimCode 数据' },
  { kind: 'legacy-cutover', title: '旧格式备份 backups/（只列出）', purpose: '升级到 SQLite 内核之前的旧格式数据' },
  { kind: 'data-backups', title: '旧版本数据备份 .limcode-data-backups（只列出）', purpose: '旧版本开发数据的重置备份' }
];

/**
 * 清理备份 (settings page, 其他 → 数据目录): checks every backup with a progress notification,
 * lists them grouped by kind in the settings page's ConfirmPanel (nothing ticked), asks a second,
 * danger confirmation for the ticked ones, then deletes them (runtimeBackupCleanup, which checks each
 * again under the claims). Without a settings page (command palette, 历史与存储管理) it only opens the
 * settings page at that entry.
 */
export async function cleanupBackups(context: vscode.ExtensionContext, startup: ApplicationStartup, request?: unknown): Promise<void> {
  const clientId = requestClientId(request);
  if (!clientId) {
    await vscode.commands.executeCommand(EXTENSION_COMMAND_IDS.openPanel, { kind: 'globalSettings', reuse: true });
    void vscode.window.showInformationMessage(`请在设置页“${SETTINGS_LOCATION}”一栏点“清理备份…”。`);
    return;
  }
  const host = await readyHost(startup);
  if (!host) {
    await vscode.window.showErrorMessage('运行时没有打开，不能清理备份。');
    return;
  }
  if (!canStartRuntimeDataSetUpgrade(context)) return;
  const ask: Ask = (prompt) => askInSettingsPage(host, clientId, prompt);
  // Deleting backups is a write: refused at once while this window is frozen for a data-directory operation.
  try {
    host.writeGate?.admit();
  } catch (error) {
    await tell(ask, '现在不能清理备份', [describeError(error), '没有删除任何内容。']);
    return;
  }
  const current = host.product.application.database;
  const configurationRootPath = host.dataRootPath();
  let plan: RuntimeBackupCleanupPlan;
  try {
    plan = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在检查备份…' },
      (progress) => runRuntimeDataSetUpgrade(context, () => {
        const check = () => planRuntimeBackupCleanup(configurationRootPath, current, {
          onProgress: (message) => progress.report({ message })
        });
        // The check writes too (it settles leftovers of an interrupted cleanup, copies other data
        // sets under their maintenance and writes the id cache): a write command for the freeze.
        return host.writeGate ? host.writeGate.run(check) : check();
      }));
  } catch (error) {
    await tell(ask, '备份检查没有完成', [describeError(error), '没有删除任何内容。']);
    return;
  }
  logDetails(plan.details, plan.items);
  const deletable = plan.items.filter((item) => item.deletable);
  const first = await ask({
    title: deletable.length > 0 ? '清理备份：勾选要删除的备份' : '清理备份：没有可以删除的备份',
    description: '只删除能证明完整存在于本地库的副本：副本里的每个对话、每个消息版本（包括编辑前的版本）都还在同一位置的历史库里。含有别处没有的对话的备份一律保留。',
    sections: firstPanelSections(plan),
    actions: deletable.length > 0 ? [CANCEL, { key: 'next', label: '下一步', variant: 'default' }] : [OK]
  });
  if (deletable.length === 0 || first.choice !== 'next') return;
  const chosen = deletable.filter((item) => first.include.includes(item.key));
  if (chosen.length === 0) {
    await tell(ask, '没有选择要删除的备份', ['没有勾选任何一项，什么也没有删除。']);
    return;
  }
  const bytes = sum(chosen.map((item) => item.bytes));
  const reclaimable = sum(chosen.map((item) => item.reclaimableBytes));
  const second = await ask({
    title: '永久删除所选备份？',
    sections: [
      {
        title: `将删除 ${chosen.length} 项，合计 ${formatBytes(bytes)}（预计释放 ${formatBytes(reclaimable)}）：`,
        lines: chosen.map((item) => `${item.name}（${formatBytes(item.bytes)}）　${item.path}`)
      },
      {
        lines: [
          `核对时间：${formatTime(plan.checkedAt)}。删除前会在锁内再核对一遍，内容、所在历史库或进行中的操作有变化的项不会删除。`,
          '与其它文件共用（硬链接）的部分不计入预计释放。',
          '删除后不能恢复，此操作不能撤销。'
        ]
      }
    ],
    actions: [CANCEL, { key: 'delete', label: '永久删除', variant: 'danger' }],
    danger: true
  });
  if (second.choice !== 'delete') return;
  let result: RuntimeBackupCleanupResult;
  try {
    result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在删除备份…' },
      () => runRuntimeDataSetUpgrade(context, () => {
        const deletion = () => deleteRuntimeBackups(plan, current, chosen.map((item) => item.key));
        // Frozen meanwhile (the user took a while to confirm): refused like any other write.
        return host.writeGate ? host.writeGate.run(deletion) : deletion();
      }));
  } catch (error) {
    await tell(ask, '备份没有删除', [describeError(error)]);
    return;
  }
  logDetails([], [...result.kept, ...result.unfinished]);
  await tell(ask, result.deleted.length > 0 ? '备份已删除' : '没有删除任何备份', resultLines(result));
}

/** The technical causes behind the reasons shown, for the log only. */
function logDetails(details: readonly string[], items: ReadonlyArray<{ name: string; reason: string; detail?: string }>): void {
  for (const detail of details) console.warn('[LimCode] 清理备份：', detail);
  for (const item of items) {
    if (item.detail) console.warn(`[LimCode] 清理备份：${item.name}（${item.reason}）`, item.detail);
  }
}

function firstPanelSections(plan: RuntimeBackupCleanupPlan): DataRootPromptSection[] {
  const deletable = plan.items.filter((item) => item.deletable);
  const sections: DataRootPromptSection[] = [{
    lines: [
      `核对时间：${formatTime(plan.checkedAt)}`,
      deletable.length > 0
        ? `可以删除 ${deletable.length} 项，合计 ${formatBytes(sum(deletable.map((item) => item.bytes)))}（预计释放 ${formatBytes(sum(deletable.map((item) => item.reclaimableBytes)))}）；默认都不勾选。`
        : '没有能证明已完整存在于本地库的备份，全部保留。',
      ...(plan.finishedDeletions.length > 0 ? [`已删完上次没有删完的 ${plan.finishedDeletions.length} 项。`] : []),
      ...(plan.restoredDeletions.length > 0
        ? [`上次清理在最后一次核对之前中断：${plan.restoredDeletions.length} 项已改回原名，按这次的核对结果列出。`] : []),
      ...plan.problems
    ]
  }];
  for (const group of KINDS) {
    const items = plan.items.filter((item) => item.kind === group.kind);
    if (items.length === 0) continue;
    sections.push({
      title: `${group.title}（${items.length} 项）`,
      lines: [`用途：${group.purpose}`, ...items.filter((item) => !item.deletable).map(keptLine)],
      options: items.filter((item) => item.deletable).map((item) => ({
        key: item.key,
        label: `${item.name}（${formatBytes(item.bytes)}，预计释放 ${formatBytes(item.reclaimableBytes)}）`,
        detail: `${createdText(item)}　${locationText(item)}　${item.reason}`
      }))
    });
  }
  if (plan.items.length === 0) sections.push({ lines: ['没有找到任何备份。'] });
  return sections;
}

function keptLine(item: RuntimeBackupCleanupItem): string {
  return `${item.name}（${formatBytes(item.bytes)}）　${createdText(item)}　${locationText(item)}　不删除：${item.reason}`;
}

function resultLines(result: RuntimeBackupCleanupResult): string[] {
  const lines: string[] = [];
  if (result.deleted.length > 0) {
    lines.push(`已删除 ${result.deleted.length} 项，合计 ${formatBytes(sum(result.deleted.map((item) => item.bytes)))}`
      + `（预计释放 ${formatBytes(sum(result.deleted.map((item) => item.reclaimableBytes)))}）。`);
  }
  for (const item of result.unfinished) lines.push(`${item.name}：${item.reason}`);
  for (const item of result.kept) lines.push(`${item.name} 保留：${item.reason}`);
  return lines.length > 0 ? lines : ['没有删除任何备份。'];
}

function createdText(item: RuntimeBackupCleanupItem): string {
  return item.createdAt ? `创建于 ${formatTime(item.createdAt)}` : '创建时间未知';
}

/** Whose copy it is only for the kinds that belong to a data set; the listed-only ones just say where they are. */
function locationText(item: RuntimeBackupCleanupItem): string {
  if (!DELETABLE_KINDS.has(item.kind)) return `位置：${item.path}`;
  const owner = item.inCurrentDataSet ? '当前库' : item.dataSetCandidateId ? `历史库 ${item.dataSetCandidateId}` : '未知的历史库';
  return `所属：${owner}　位置：${item.path}`;
}

async function tell(ask: Ask, title: string, lines: string[]): Promise<void> {
  await ask({ title, sections: [{ lines }], actions: [OK] });
}

async function readyHost(startup: ApplicationStartup): Promise<BackupCleanupHost | undefined> {
  const host = await startup.wait().catch(() => undefined) as Partial<BackupCleanupHost> | undefined;
  return typeof host?.postToWebview === 'function' && typeof host.dataRootPath === 'function'
    && typeof host.product?.application?.database?.snapshot === 'function' ? host as BackupCleanupHost : undefined;
}

function requestClientId(request: unknown): BridgeClientId | undefined {
  const clientId = (request as { clientId?: unknown } | null | undefined)?.clientId;
  return typeof clientId === 'string' && clientId ? clientId : undefined;
}

function sum(values: readonly string[]): string {
  return values.reduce((total, value) => total + BigInt(value), 0n).toString();
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

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describeError(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message ? message : String(error);
}
