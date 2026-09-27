import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GlobalSettingsRecord } from '../../../shared/protocol';
import { SettingsRevisionConflictError } from '../settingsRevisionConflict';
import { STORAGE_VERSION } from './constants';
import { readJsonStrict, writeJson } from './json';
import { withRecordStoreTransaction } from './recordStore';
import { createStorageRevision } from './storageRevision';

export const LIMCODE_GLOBAL_STATUS_KEY = 'limcode.globalStatus';
export const LIMCODE_GLOBAL_STATUS_FILE = '.limcode-global-status.json';
export const LIMCODE_GLOBAL_STATUS_LABEL = LIMCODE_GLOBAL_STATUS_FILE;

export interface StorageRootMigrationStatus {
  fromPath: string;
  toPath: string;
  migratedAt: string;
  /**
   * The data-directory relocation that copied the data (its completion record in toPath carries the
   * same id). Absent for a switch without copying ("回到旧目录", "选择其它目录", "使用默认目录"):
   * such a switch never justifies deleting fromPath.
   */
  relocationId?: string;
}

/** A data-directory relocation between its stage and its end; cleared when it ends (see dataRootRelocation). */
export interface PendingDataRootRelocation {
  relocationId: string;
  sourceRootPath: string;
  targetRootPath: string;
  startedAt: string;
  processId: number;
  processStartIdentity?: string;
  /**
   * Set right before the relocation first changes the target: the identities (`<device>:<inode>`)
   * of the directories it found there (see DataRootRelocationTargetAnchor). Absent: the target was
   * never changed, so nothing of the relocation can be there.
   */
  targetAnchor?: { parent: string; target?: string };
}

export interface LimCodeGlobalStatus {
  schemaVersion: typeof STORAGE_VERSION;
  dataRootPath: string;
  proxy: string;
  /** 代理是否同时覆盖 shell 子进程与 MCP 连接；缺省/false 时只作用于 LLM 链路。 */
  proxyShellAndMcp?: boolean;
  updatedAt: string;
  lastMigration?: StorageRootMigrationStatus;
  /** 自定义数据目录的身份（目录里的 .limcode-data-root-identity.json）；启动时不一致即判为不可用。 */
  dataRootId?: string;
  /** 正在进行的数据目录迁移；进程崩溃后由下次启动清理。 */
  pendingRelocation?: PendingDataRootRelocation;
}

/** 切换数据目录时的改动；省略的字段保持原值，null 表示清除。路径改变而没有给出新身份时身份被清除。 */
export interface GlobalStatusDataRootChange {
  dataRootPath?: string;
  dataRootId?: string | null;
  lastMigration?: StorageRootMigrationStatus | null;
  pendingRelocation?: PendingDataRootRelocation | null;
  /**
   * 进行中记录的比较后写入：调用方上次看到的记录 id（null 表示没有）。写入新记录时不一致则抛
   * GlobalStatusPendingRelocationConflictError、什么都不写；清除时不一致则保留别人的记录，其余改动照常。
   */
  expectedPendingRelocationId?: string | null;
  /** 只在指针仍指向这个目录时才提交（不一致时什么都不写）。 */
  expectedDataRootPath?: string;
}

/** 另一个窗口刚刚开始或结束了一次数据目录迁移。 */
export class GlobalStatusPendingRelocationConflictError extends Error {
  public readonly code = 'global-status-pending-relocation-conflict';

  public constructor() {
    super('另一个 LimCode 窗口刚刚开始了数据目录迁移，请等它完成后再试。');
    this.name = 'GlobalStatusPendingRelocationConflictError';
  }
}

const committedStatusByContext = new WeakMap<vscode.ExtensionContext, LimCodeGlobalStatus>();

/** 启动完成后返回当前进程已确认的 canonical 状态。 */
export function loadGlobalStatus(context: vscode.ExtensionContext): LimCodeGlobalStatus {
  return cloneStatus(committedStatusByContext.get(context) ?? statusFromGlobalState(context));
}

/** 每次从 canonical 文件读取，供跨 Extension Host 刷新和设置 revision 使用。 */
export async function loadCommittedGlobalStatus(context: vscode.ExtensionContext): Promise<LimCodeGlobalStatus> {
  const uri = globalStatusFileUri(context);
  const initial = await readJsonStrict<unknown>(uri);
  if (initial.status === 'ok') return remember(context, parseGlobalStatus(uri, initial.value));
  if (initial.status !== 'missing') throw strictStatusReadError(initial);

  return withRecordStoreTransaction(uri, async () => {
    const current = await readJsonStrict<unknown>(uri);
    if (current.status === 'ok') return remember(context, parseGlobalStatus(uri, current.value));
    if (current.status !== 'missing') throw strictStatusReadError(current);
    const bootstrap = statusFromGlobalState(context);
    await writeJson(uri, bootstrap);
    return remember(context, bootstrap);
  });
}

/**
 * 内部迁移路径使用的无条件提交；普通设置保存必须使用 saveGlobalStatusExpected。
 * lastMigration 省略时保留原记录，传 null 时清除（旧目录已删除）。
 */
export async function saveGlobalStatus(
  context: vscode.ExtensionContext,
  dataRootPath: string,
  proxy: string,
  lastMigration?: StorageRootMigrationStatus | null,
  proxyShellAndMcp?: boolean
): Promise<LimCodeGlobalStatus> {
  const uri = globalStatusFileUri(context);
  return withRecordStoreTransaction(uri, async () => {
    const previous = await loadStatusInsideLock(context, uri);
    return commitStatus(context, uri, previous, { dataRootPath, proxy, lastMigration, proxyShellAndMcp });
  });
}

/** 数据目录迁移、回到旧目录、选择其它目录：在同一把跨进程锁内改指针及其附属记录。 */
export async function updateGlobalStatusDataRoot(
  context: vscode.ExtensionContext,
  change: GlobalStatusDataRootChange
): Promise<LimCodeGlobalStatus> {
  const uri = globalStatusFileUri(context);
  return withRecordStoreTransaction(uri, async () => {
    const previous = await loadStatusInsideLock(context, uri);
    if (change.expectedDataRootPath !== undefined
      && !sameFsPath(resolveDataRootUri(context, previous.dataRootPath).fsPath, resolveDataRootUri(context, change.expectedDataRootPath).fsPath)) {
      return cloneStatus(previous);
    }
    let pendingRelocation = change.pendingRelocation;
    if (change.expectedPendingRelocationId !== undefined
      && (previous.pendingRelocation?.relocationId ?? null) !== change.expectedPendingRelocationId) {
      if (pendingRelocation) throw new GlobalStatusPendingRelocationConflictError();
      pendingRelocation = undefined;
    }
    return commitStatus(context, uri, previous, {
      dataRootPath: change.dataRootPath ?? previous.dataRootPath,
      proxy: previous.proxy,
      proxyShellAndMcp: previous.proxyShellAndMcp === true,
      lastMigration: change.lastMigration,
      dataRootId: change.dataRootId,
      pendingRelocation
    });
  });
}

/** 在同一把跨进程锁内比对旧 revision 并提交 common 设置。 */
export async function saveGlobalStatusExpected(
  context: vscode.ExtensionContext,
  dataRootPath: string,
  proxy: string,
  expectedRevision: string,
  proxyShellAndMcp?: boolean
): Promise<{ current: LimCodeGlobalStatus; previous: LimCodeGlobalStatus }> {
  const uri = globalStatusFileUri(context);
  return withRecordStoreTransaction(uri, async () => {
    const previous = await loadStatusInsideLock(context, uri);
    const actualRevision = globalStatusRevision(previous);
    if (actualRevision !== expectedRevision) {
      throw new SettingsRevisionConflictError('common', expectedRevision, actualRevision);
    }
    const current = await commitStatus(context, uri, previous, { dataRootPath, proxy, proxyShellAndMcp });
    return { current, previous };
  });
}

export function globalStatusRevision(status: LimCodeGlobalStatus): string {
  return createStorageRevision({
    schemaVersion: status.schemaVersion,
    dataRootPath: status.dataRootPath,
    proxy: status.proxy,
    proxyShellAndMcp: status.proxyShellAndMcp === true,
    ...(status.lastMigration ? { lastMigration: status.lastMigration } : {})
  });
}

export function globalStatusFileUri(context: vscode.ExtensionContext): vscode.Uri {
  return vscode.Uri.joinPath(context.globalStorageUri, LIMCODE_GLOBAL_STATUS_FILE);
}

export function createGlobalSettingsRecord(
  context: vscode.ExtensionContext,
  status: LimCodeGlobalStatus = loadGlobalStatus(context)
): GlobalSettingsRecord {
  const activeDataRootPath = resolveDataRootUri(context, status.dataRootPath).fsPath;
  const previous = status.lastMigration;
  return {
    dataFilePath: status.dataRootPath,
    proxy: status.proxy,
    proxyShellAndMcp: status.proxyShellAndMcp === true,
    activeDataRootPath,
    defaultDataRootPath: context.globalStorageUri.fsPath,
    previousDataRootPath: previous && sameFsPath(previous.toPath, activeDataRootPath) && !sameFsPath(previous.fromPath, activeDataRootPath)
      ? previous.fromPath : ''
  };
}

export function resolveDataRootUri(
  context: vscode.ExtensionContext,
  dataRootPath = loadGlobalStatus(context).dataRootPath
): vscode.Uri {
  const normalizedDataRootPath = normalizeStatusDataRootPath(context, dataRootPath);
  return normalizedDataRootPath ? vscode.Uri.file(normalizedDataRootPath) : context.globalStorageUri;
}

export function normalizeStatusDataRootPath(context: vscode.ExtensionContext, value: unknown): string {
  const normalized = normalizeDataRootPath(value);
  if (!normalized) return '';
  return sameFsPath(normalized, context.globalStorageUri.fsPath) ? '' : normalized;
}

export function normalizeDataRootPath(value: unknown, options: { fallbackToDefault?: boolean } = {}): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return '';
  if (!path.isAbsolute(trimmed)) {
    if (options.fallbackToDefault) return '';
    throw new Error('数据目录路径必须是绝对路径。');
  }
  return path.resolve(trimmed);
}

export function sameFsPath(a: string, b: string): boolean {
  if (!a || !b) return a === b;
  return comparableFsPath(a) === comparableFsPath(b);
}

export function comparableFsPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function loadStatusInsideLock(
  context: vscode.ExtensionContext,
  uri: vscode.Uri
): Promise<LimCodeGlobalStatus> {
  const result = await readJsonStrict<unknown>(uri);
  if (result.status === 'ok') return parseGlobalStatus(uri, result.value);
  if (result.status !== 'missing') throw strictStatusReadError(result);
  const bootstrap = statusFromGlobalState(context);
  await writeJson(uri, bootstrap);
  return bootstrap;
}

async function commitStatus(
  context: vscode.ExtensionContext,
  uri: vscode.Uri,
  previous: LimCodeGlobalStatus,
  next: {
    dataRootPath: string;
    proxy: string;
    proxyShellAndMcp?: boolean;
    lastMigration?: StorageRootMigrationStatus | null;
    dataRootId?: string | null;
    pendingRelocation?: PendingDataRootRelocation | null;
  }
): Promise<LimCodeGlobalStatus> {
  const dataRootPath = normalizeStatusDataRootPath(context, next.dataRootPath);
  // The identity belongs to the directory: kept only while the path stays the same.
  const dataRootId = next.dataRootId === null ? undefined
    : next.dataRootId ?? (sameFsPath(dataRootPath, previous.dataRootPath) ? previous.dataRootId : undefined);
  const pendingRelocation = next.pendingRelocation === null ? undefined : next.pendingRelocation ?? previous.pendingRelocation;
  const status: LimCodeGlobalStatus = {
    schemaVersion: STORAGE_VERSION,
    dataRootPath,
    proxy: typeof next.proxy === 'string' ? next.proxy.trim() : '',
    proxyShellAndMcp: next.proxyShellAndMcp ?? (previous.proxyShellAndMcp === true),
    updatedAt: new Date().toISOString(),
    ...(next.lastMigration ? { lastMigration: requireMigration(next.lastMigration) }
      : next.lastMigration === undefined && previous.lastMigration ? { lastMigration: { ...previous.lastMigration } } : {}),
    ...(dataRootPath && dataRootId ? { dataRootId: requireDataRootId(dataRootId) } : {}),
    ...(pendingRelocation ? { pendingRelocation: requirePendingRelocation(pendingRelocation) } : {})
  };
  await writeJson(uri, status);
  remember(context, status);
  try {
    await context.globalState.update(LIMCODE_GLOBAL_STATUS_KEY, status);
  } catch (error) {
    console.warn('[LimCode] Canonical global status committed, but globalState projection update failed.', error);
  }
  return cloneStatus(status);
}

function statusFromGlobalState(context: vscode.ExtensionContext): LimCodeGlobalStatus {
  const stored = context.globalState.get<Partial<LimCodeGlobalStatus>>(LIMCODE_GLOBAL_STATUS_KEY);
  const dataRootPath = normalizeDataRootPath(stored?.dataRootPath, { fallbackToDefault: true });
  const lastMigration = normalizeLastMigration(stored?.lastMigration);
  const customRoot = sameFsPath(dataRootPath, context.globalStorageUri.fsPath) ? '' : dataRootPath;
  const dataRootId = normalizeDataRootId(stored?.dataRootId);
  const pendingRelocation = normalizePendingRelocation(stored?.pendingRelocation);
  return {
    schemaVersion: STORAGE_VERSION,
    dataRootPath: customRoot,
    proxy: typeof stored?.proxy === 'string' ? stored.proxy.trim() : '',
    proxyShellAndMcp: stored?.proxyShellAndMcp === true,
    updatedAt: typeof stored?.updatedAt === 'string' && stored.updatedAt.trim()
      ? stored.updatedAt
      : new Date(0).toISOString(),
    ...(lastMigration ? { lastMigration } : {}),
    ...(customRoot && dataRootId ? { dataRootId } : {}),
    ...(pendingRelocation ? { pendingRelocation } : {})
  };
}

function parseGlobalStatus(uri: vscode.Uri, value: unknown): LimCodeGlobalStatus {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
  if (!record || record.schemaVersion !== STORAGE_VERSION) throw new Error(`全局状态文件版本无效：${uri.fsPath}`);
  if (typeof record.dataRootPath !== 'string' || typeof record.proxy !== 'string') {
    throw new Error(`全局状态文件内容损坏：${uri.fsPath}`);
  }
  if (typeof record.updatedAt !== 'string' || !record.updatedAt.trim()) {
    throw new Error(`全局状态文件缺少保存时间：${uri.fsPath}`);
  }
  const lastMigration = record.lastMigration === undefined ? undefined : normalizeLastMigration(record.lastMigration);
  if (record.lastMigration !== undefined && !lastMigration) throw new Error(`全局状态迁移信息损坏：${uri.fsPath}`);
  if (record.proxyShellAndMcp !== undefined && typeof record.proxyShellAndMcp !== 'boolean') {
    throw new Error(`全局状态代理开关损坏：${uri.fsPath}`);
  }
  const dataRootId = record.dataRootId === undefined ? undefined : normalizeDataRootId(record.dataRootId);
  if (record.dataRootId !== undefined && !dataRootId) throw new Error(`全局状态数据目录身份损坏：${uri.fsPath}`);
  const pendingRelocation = record.pendingRelocation === undefined ? undefined : normalizePendingRelocation(record.pendingRelocation);
  if (record.pendingRelocation !== undefined && !pendingRelocation) throw new Error(`全局状态迁移进行记录损坏：${uri.fsPath}`);
  return {
    schemaVersion: STORAGE_VERSION,
    dataRootPath: normalizeDataRootPath(record.dataRootPath),
    proxy: record.proxy.trim(),
    proxyShellAndMcp: record.proxyShellAndMcp === true,
    updatedAt: record.updatedAt,
    ...(lastMigration ? { lastMigration } : {}),
    ...(dataRootId ? { dataRootId } : {}),
    ...(pendingRelocation ? { pendingRelocation } : {})
  };
}

function remember(context: vscode.ExtensionContext, status: LimCodeGlobalStatus): LimCodeGlobalStatus {
  const snapshot = cloneStatus(status);
  committedStatusByContext.set(context, snapshot);
  return cloneStatus(snapshot);
}

function cloneStatus(status: LimCodeGlobalStatus): LimCodeGlobalStatus {
  return {
    ...status,
    ...(status.lastMigration ? { lastMigration: { ...status.lastMigration } } : {}),
    ...(status.pendingRelocation ? { pendingRelocation: { ...status.pendingRelocation } } : {})
  };
}

function requireDataRootId(value: string): string {
  const normalized = normalizeDataRootId(value);
  if (!normalized) throw new TypeError('Data root identity is invalid.');
  return normalized;
}

function normalizeDataRootId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value) ? value : undefined;
}

function requirePendingRelocation(value: PendingDataRootRelocation): PendingDataRootRelocation {
  const normalized = normalizePendingRelocation(value);
  if (!normalized) throw new TypeError('Pending data root relocation is invalid.');
  return normalized;
}

function normalizePendingRelocation(input: unknown): PendingDataRootRelocation | undefined {
  const candidate = input as Partial<PendingDataRootRelocation> | undefined;
  if (typeof candidate?.relocationId !== 'string' || typeof candidate.sourceRootPath !== 'string'
    || typeof candidate.targetRootPath !== 'string' || typeof candidate.startedAt !== 'string'
    || typeof candidate.processId !== 'number' || !Number.isInteger(candidate.processId)
    || (candidate.processStartIdentity !== undefined && typeof candidate.processStartIdentity !== 'string')
    || (candidate.targetAnchor !== undefined && (typeof candidate.targetAnchor?.parent !== 'string'
      || (candidate.targetAnchor.target !== undefined && typeof candidate.targetAnchor.target !== 'string')))) return undefined;
  return {
    relocationId: candidate.relocationId, sourceRootPath: candidate.sourceRootPath, targetRootPath: candidate.targetRootPath,
    startedAt: candidate.startedAt, processId: candidate.processId,
    ...(candidate.processStartIdentity !== undefined ? { processStartIdentity: candidate.processStartIdentity } : {}),
    ...(candidate.targetAnchor !== undefined ? {
      targetAnchor: { parent: candidate.targetAnchor.parent, ...(candidate.targetAnchor.target !== undefined ? { target: candidate.targetAnchor.target } : {}) }
    } : {})
  };
}

function requireMigration(value: StorageRootMigrationStatus): StorageRootMigrationStatus {
  const normalized = normalizeLastMigration(value);
  if (!normalized) throw new TypeError('Storage root migration metadata is invalid.');
  return normalized;
}

function normalizeLastMigration(input: unknown): StorageRootMigrationStatus | undefined {
  const candidate = input as Partial<StorageRootMigrationStatus> | undefined;
  if (typeof candidate?.fromPath !== 'string'
    || typeof candidate.toPath !== 'string'
    || typeof candidate.migratedAt !== 'string'
    || (candidate.relocationId !== undefined && !(typeof candidate.relocationId === 'string' && /^[0-9a-f-]{36}$/.test(candidate.relocationId)))) {
    return undefined;
  }
  return {
    fromPath: candidate.fromPath, toPath: candidate.toPath, migratedAt: candidate.migratedAt,
    ...(candidate.relocationId ? { relocationId: candidate.relocationId } : {})
  };
}

function strictStatusReadError(result: Exclude<Awaited<ReturnType<typeof readJsonStrict<unknown>>>, { status: 'ok' | 'missing' }>): Error {
  const detail = result.error instanceof Error ? result.error.message : String(result.error);
  return new Error(`无法读取全局状态文件（${result.status}）：${result.uri.fsPath}。${detail}`);
}
