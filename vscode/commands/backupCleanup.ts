import * as vscode from 'vscode';
import { loadCommittedGlobalStatus } from '../../backend/capabilities/vscodeStorage/globalStatus';
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

/**
 * Deletable copies with messages that are deleted or replaced (edited, retried) where the rest of
 * them is: grouped apart after the kinds that can be proven, never ticked by default, deleted only
 * when ticked knowingly.
 */
const REPLACED_GROUP = {
  title: '含你后来删除或替换的内容',
  purpose: '内容都还在当前库或某个历史库里，但其中一些消息在那里已被你删除、编辑或重试替换，只在这份副本里还能看到；默认不勾选，勾选后才删除，删除后这些消息就再也看不到了'
};

/** Group order of the first panel: the kinds that can be proven first, then the listed ones. */
const KINDS: ReadonlyArray<{ kind: RuntimeBackupKind; title: string; purpose: string }> = [
  { kind: 'epoch-migration', title: '升级前备份', purpose: '旧版本的历史库自动升级到当前格式之前，整份数据库的备份' },
  { kind: 'merge-target', title: '合并前备份', purpose: '把其它历史库合并进来之前，接收合并的库的整份备份' },
  { kind: 'merge-source', title: '合并来源的收尾前备份', purpose: '合并前收尾来源库里没有结束的任务之前，来源库的整份备份' },
  {
    kind: 'foreign-history', title: '外来历史库',
    purpose: '“归档并重置”留下的归档，和迁移数据目录时挪到旁边的拷来目录里的库；只有核验通过、且能证明内容已完整在当前库或某个历史库里的才可以删除（归档整份删除，拷来目录只删其中的库）'
  },
  { kind: 'reset-archive', title: '归档目录里的其它内容（只列出）', purpose: '“归档并重置”的归档目录里不是归档的内容' },
  { kind: 'copied-data-root', title: '拷来目录（只列出）', purpose: '迁移数据目录时挪到旁边的拷来目录本身，其中库以外的设置、规则、技能永远不会被整体删除' },
  { kind: 'legacy-cutover', title: '旧格式备份 backups/（只列出）', purpose: '升级到 SQLite 内核之前的旧格式数据' },
  { kind: 'data-backups', title: '旧版本数据备份 .limcode-data-backups（只列出）', purpose: '旧版本开发数据的重置备份' }
];

/**
 * 清理备份 (settings page, 其他 → 数据目录): checks every backup with a progress notification,
 * lists them grouped by kind in the settings page's ConfirmPanel (the ones whose content is complete
 * elsewhere ticked; the ones with content deleted or replaced there grouped apart, unticked), asks a
 * second, danger confirmation for the ticked ones, then deletes them (runtimeBackupCleanup, which
 * checks each again under the claims). Without a settings page (command palette, 历史与存储管理) it
 * only opens the settings page at that entry.
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
  const previousDataRootPaths = await previousDataRoots(context);
  let plan: RuntimeBackupCleanupPlan;
  try {
    plan = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '正在检查备份…' },
      (progress) => runRuntimeDataSetUpgrade(context, () => {
        const check = () => planRuntimeBackupCleanup(configurationRootPath, current, {
          onProgress: (message) => progress.report({ message }),
          ...(previousDataRootPaths.length > 0 ? { previousDataRootPaths } : {})
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
    description: '只删除能证明完整存在于本地库的副本：副本里的每个对话、消息版本和工具调用、输出、回答等记录都还在当前库或同一数据目录的某个历史库里，正文文件也在，副本里显示的每条消息在那里也显示同一个版本；外来历史库还要先通过核验。含有别处没有的对话或记录的一律保留；其中有消息在那里已被你删除、编辑或重试替换的，单独列出，默认不勾选。',
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
  const replaced = chosen.filter((item) => (item.replacedMessages ?? 0) > 0);
  const second = await ask({
    title: '永久删除所选备份？',
    sections: [
      {
        title: `将删除 ${chosen.length} 项，合计 ${formatBytes(bytes)}（预计释放 ${formatBytes(reclaimable)}）：`,
        lines: chosen.map((item) => `${item.name}（${formatBytes(item.bytes)}）　${item.path}`)
      },
      {
        lines: [
          ...(replaced.length > 0
            ? [`其中 ${replaced.length} 项含你后来删除或替换的内容（共 ${replaced.reduce((total, item) => total + (item.replacedMessages ?? 0), 0)} 条消息），删除后这些消息就再也看不到了。`]
            : []),
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
  const replaced = deletable.filter(isReplaced);
  const sections: DataRootPromptSection[] = [{
    lines: [
      `核对时间：${formatTime(plan.checkedAt)}`,
      deletable.length > 0
        ? `可以删除 ${deletable.length} 项，合计 ${formatBytes(sum(deletable.map((item) => item.bytes)))}（预计释放 ${formatBytes(sum(deletable.map((item) => item.reclaimableBytes)))}）；`
          + (replaced.length > 0
            ? `内容完整的 ${deletable.length - replaced.length} 项默认勾选，含你后来删除或替换的内容的 ${replaced.length} 项默认不勾选。`
            : '默认都勾选，可以取消。')
        : '没有能证明已完整存在于本地库的备份，全部保留。',
      ...(plan.finishedDeletions.length > 0 ? [`已删完上次没有删完的 ${plan.finishedDeletions.length} 项。`] : []),
      ...(plan.restoredDeletions.length > 0
        ? [`上次清理在最后一次核对之前中断：${plan.restoredDeletions.length} 项已改回原名，按这次的核对结果列出。`] : []),
      ...plan.problems
    ]
  }];
  const option = (item: RuntimeBackupCleanupItem, checked: boolean) => ({
    key: item.key,
    label: `${item.name}（${formatBytes(item.bytes)}，预计释放 ${formatBytes(item.reclaimableBytes)}）`,
    detail: `${createdText(item)}　${locationText(item)}　${item.reason}`,
    ...(checked ? { checked: true } : {})
  });
  for (const group of KINDS) {
    const items = plan.items.filter((item) => item.kind === group.kind && !isReplaced(item));
    if (items.length > 0) {
      sections.push({
        title: `${group.title}（${items.length} 项）`,
        lines: [`用途：${group.purpose}`, ...items.filter((item) => !item.deletable).map(keptLine)],
        options: items.filter((item) => item.deletable).map((item) => option(item, true))
      });
    }
    // Right after the kinds that can be proven (foreign history is the last of them).
    if (group.kind === 'foreign-history' && replaced.length > 0) {
      sections.push({
        title: `${REPLACED_GROUP.title}（${replaced.length} 项）`,
        lines: [`用途：${REPLACED_GROUP.purpose}`],
        options: replaced.map((item) => option(item, false))
      });
    }
  }
  if (plan.items.length === 0) sections.push({ lines: ['没有找到任何备份。'] });
  return sections;
}

/** Deletable, but messages visible in it are deleted or replaced where the rest of it is. */
function isReplaced(item: RuntimeBackupCleanupItem): boolean {
  return item.deletable && (item.replacedMessages ?? 0) > 0;
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
  for (const directory of result.copiedDirectoriesWithoutDataSets ?? []) {
    lines.push(`拷来目录 ${directory.name} 里已经没有库；其余内容（设置、规则、技能）保留，可自行处理。位置：${directory.path}`);
  }
  return lines.length > 0 ? lines : ['没有删除任何备份。'];
}

function createdText(item: RuntimeBackupCleanupItem): string {
  return item.createdAt ? `创建于 ${formatTime(item.createdAt)}` : '创建时间未知';
}

/**
 * Whose copy it is only for the kinds that belong to a data set, named as the history management
 * names it (当前库, its project names, 旧工作区历史 or 默认历史库; a data set that could not be read has
 * no name to show); foreign history says where it comes from; the listed-only ones just say where they are.
 */
function locationText(item: RuntimeBackupCleanupItem): string {
  if (item.kind === 'foreign-history') return `来源：${item.origin ?? '外来历史库'}　位置：${item.path}`;
  const owner = item.dataSetName ?? (item.inCurrentDataSet ? '当前库' : undefined);
  if (!DELETABLE_KINDS.has(item.kind) || !owner) return `位置：${item.path}`;
  return `所属：${owner}　位置：${item.path}`;
}

/**
 * The data directories this installation left, as foreign history discovery looks in them
 * (globalStatus previousDataRoots, and lastMigration.fromPath, which is all an installation that
 * relocated before that list existed has): their archives and the directories copied aside beside
 * them are foreign history too.
 */
async function previousDataRoots(context: vscode.ExtensionContext): Promise<string[]> {
  try {
    const status = await loadCommittedGlobalStatus(context);
    const listed = [...(status?.previousDataRoots ?? [])];
    const from = status?.lastMigration?.fromPath;
    return from && !listed.includes(from) ? [...listed, from] : listed;
  } catch (error) {
    console.warn('[LimCode] 清理备份：无法读取以前的数据目录的位置，这次只看当前数据目录。', error);
    return [];
  }
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
