import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ForeignRuntimeRootLocation } from './runtimeLocatedRoot';
import {
  ledgerFile, writeLedgerJson, removeLedgerJson,
  readRuntimeDataSetMergeLedger, sameRuntimeDataSetIdentity,
  type RuntimeDataSetIdentity, type RuntimeDataSetMergeExcludedConversation
} from './runtimeDataSetMergeLedger';
import { inspectVscodeRuntimeDataSets, resolveVscodeRuntimeMergeLedgerRoot } from './vscodeRootAuthority';
import { withRuntimeDataRootAdmission } from './runtimeHostControl';

export type RuntimeHistoryLocation = { kind: 'local'; candidateId: string } | ForeignRuntimeRootLocation;
export type RuntimeHistorySourceKind = 'local' | 'migration' | 'archive' | 'copied' | 'reset';
type Paths = { globalStoragePath: string };
interface RuntimeHistorySource {
  id: string;
  label?: string;
  sourceKind: RuntimeHistorySourceKind;
  location: RuntimeHistoryLocation;
  identity?: RuntimeDataSetIdentity;
}
/** Durable work, with no request expiry. */
export interface RuntimeHistoryPending extends RuntimeHistorySource {
  reason: string;
  registeredAt: string;
}
/** Authoritative retained history, never a disposable inspection cache. */
export interface RuntimeHistoryResidual extends RuntimeHistorySource {
  code: string;
  message: string;
  bytes?: string;
  excluded?: RuntimeDataSetMergeExcludedConversation[];
  checkedAt: string;
}
export const RUNTIME_RESET_BACKUPS_DIRECTORY = '.limcode-runtime-reset-backups';
export const runtimeHistoryRegistryFile = (paths: Paths, section: 'pending' | 'residual', id: string): Promise<string> => ledgerFile(paths, section, id);
export const writeRuntimeHistoryPending = (paths: Paths, record: RuntimeHistoryPending): Promise<void> => writeLedgerJson(paths, 'pending', record.id, record);
export const writeRuntimeHistoryResidual = (paths: Paths, record: RuntimeHistoryResidual): Promise<void> => writeLedgerJson(paths, 'residual', record.id, record);
export const removeRuntimeHistoryPending = (paths: Paths, id: string): Promise<void> => removeLedgerJson(paths, 'pending', id);
export const removeRuntimeHistoryResidual = (paths: Paths, id: string): Promise<void> => removeLedgerJson(paths, 'residual', id);
export const readRuntimeHistoryPending = (paths: Paths): Promise<Map<string, RuntimeHistoryPending>> => readRegistry(paths, 'pending');
export const readRuntimeHistoryResidual = (paths: Paths): Promise<Map<string, RuntimeHistoryResidual>> => readRegistry(paths, 'residual');
export const readRuntimeHistoryPendingRecord = (paths: Paths, id: string): Promise<RuntimeHistoryPending | undefined> => readOne(paths, 'pending', id);
export const readRuntimeHistoryResidualRecord = (paths: Paths, id: string): Promise<RuntimeHistoryResidual | undefined> => readOne(paths, 'residual', id);

/** A retry publishes the currently located source; old merge provenance remains in the ledger. */
export async function requeueRuntimeHistoryResidual(paths: Paths, previousId: string, pending: RuntimeHistoryPending): Promise<void> {
  await withRuntimeDataRootAdmission(paths.globalStoragePath, async () => {
    await writeRuntimeHistoryPending(paths, pending);
    if (previousId !== pending.id) {
      await removeRuntimeHistoryPending(paths, previousId);
      await removeRuntimeHistoryResidual(paths, previousId);
    }
  });
}

async function readRegistry<T extends RuntimeHistoryPending | RuntimeHistoryResidual>(paths: Paths, section: 'pending' | 'residual'): Promise<Map<string, T>> {
  // The common path resolver checks the directory before any read.
  await ledgerFile(paths, section, 'probe');
  const directory = path.join(resolveVscodeRuntimeMergeLedgerRoot(paths), section);
  let names: string[];
  try { names = await fs.readdir(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map(); throw error; }
  const result = new Map<string, T>();
  for (const name of names.filter(name => name.endsWith('.json')).sort()) {
    const file = path.join(directory, name);
    try {
      const record = await readRecordFile<T>(paths, section, file);
      result.set(record.id, record);
    } catch (error) {
      // Another window may finish this source after the directory was enumerated.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return result;
}

async function readOne<T extends RuntimeHistoryPending | RuntimeHistoryResidual>(paths: Paths, section: 'pending' | 'residual', id: string): Promise<T | undefined> {
  const file = await ledgerFile(paths, section, id);
  try { return await readRecordFile<T>(paths, section, file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function readRecordFile<T extends RuntimeHistoryPending | RuntimeHistoryResidual>(paths: Paths, section: 'pending' | 'residual', file: string): Promise<T> {
  if (!(await fs.lstat(file)).isFile()) throw new Error(`历史登记不是普通文件：${file}`);
  const record = JSON.parse(await fs.readFile(file, 'utf8')) as T;
  if (!record || typeof record.id !== 'string' || !record.location
    || !['local', 'migration', 'archive', 'copied', 'reset'].includes(record.sourceKind)
    || path.basename(await ledgerFile(paths, section, record.id)) !== path.basename(file)
    || (section === 'pending' ? typeof (record as RuntimeHistoryPending).registeredAt !== 'string'
      : typeof (record as RuntimeHistoryResidual).checkedAt !== 'string')) {
    throw new Error(`历史登记无法读取：${file}`);
  }
  return record;
}

/** Called in the reset's admission after rename; retry uses the same path-derived id. */
export async function registerRuntimeResetBackup(paths: Paths, backupPath: string): Promise<void> {
  await registerMissingResetBackups(paths, [backupPath]);
}

function resetBackupLocation(paths: Paths, backupPath: string): Pick<RuntimeHistoryResidual, 'id' | 'sourceKind' | 'location'> {
  const relative = path.relative(path.resolve(paths.globalStoragePath), path.resolve(backupPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)
    || path.basename(path.dirname(backupPath)) !== RUNTIME_RESET_BACKUPS_DIRECTORY) throw new Error('重置备份位置不正确。');
  const id = `reset:${encodeURIComponent(relative.split(path.sep).join('/'))}`;
  return {
    id, sourceKind: 'reset', location: { kind: 'archive', containerPath: path.resolve(backupPath),
      containerName: relative.split(path.sep).join('/'), dataRootRelativePath: 'active' }
  };
}

async function registerMissingResetBackups(paths: Paths, backups: readonly string[]): Promise<void> {
  if (!backups.length) return;
  const sources = backups.map(backup => resetBackupLocation(paths, backup));
  await withRuntimeDataRootAdmission(paths.globalStoragePath, async () => {
    const residual = await readRuntimeHistoryResidual(paths);
    const pending = await readRuntimeHistoryPending(paths);
    const ledger = await readRuntimeDataSetMergeLedger(paths);
    const current = sources.some(source => ledger.get(source.id)?.state === 'merged')
      ? (await inspectVscodeRuntimeDataSets(paths)).candidates.find(candidate => candidate.selected) : undefined;
    for (const source of sources) {
      if (residual.has(source.id) || pending.has(source.id)) continue;
      const completed = ledger.get(source.id);
      if (completed?.state === 'merged' && sameRuntimeDataSetIdentity(completed.target, current)) continue;
      await writeRuntimeHistoryResidual(paths, { ...source, code: 'runtime-history-reset-backup',
        message: '归档并重置挪走的库', checkedAt: new Date().toISOString() });
    }
  });
}

/** Only directory names are inspected; reset bodies are never scanned at startup. */
export async function reconcileRuntimeResetBackups(paths: Paths): Promise<void> {
  const root = path.resolve(paths.globalStoragePath);
  const scopes = [root];
  const backups: string[] = [];
  const scopesRoot = path.join(root, '.limcode-workspace-runtimes', 'scopes');
  try {
    for (const entry of await fs.readdir(scopesRoot, { withFileTypes: true })) if (entry.isDirectory()) scopes.push(path.join(scopesRoot, entry.name));
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const scope of scopes) {
    const directory = path.join(scope, RUNTIME_RESET_BACKUPS_DIRECTORY);
    let entries;
    try {
      if (!(await fs.lstat(directory)).isDirectory()) continue;
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const entry of entries) if (entry.isDirectory()) backups.push(path.join(directory, entry.name));
  }
  await registerMissingResetBackups(paths, backups);
}
