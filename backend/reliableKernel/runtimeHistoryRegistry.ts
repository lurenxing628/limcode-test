import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ForeignRuntimeRootLocation } from './runtimeLocatedRoot';
import {
  ledgerFile, writeLedgerJson, removeLedgerJson,
  type RuntimeDataSetIdentity, type RuntimeDataSetMergeExcludedConversation
} from './runtimeDataSetMergeLedger';
import { resolveVscodeRuntimeMergeLedgerRoot } from './vscodeRootAuthority';

export type RuntimeHistoryLocation = { kind: 'local'; candidateId: string } | ForeignRuntimeRootLocation;
export type RuntimeHistorySourceKind = 'local' | 'migration' | 'archive' | 'copied' | 'reset';
type Paths = { globalStoragePath: string };
interface RuntimeHistorySource {
  id: string;
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
    if (!(await fs.lstat(file)).isFile()) throw new Error(`历史登记不是普通文件：${file}`);
    const record = JSON.parse(await fs.readFile(file, 'utf8')) as T;
    if (!record || typeof record.id !== 'string' || !record.location
      || !['local', 'migration', 'archive', 'copied', 'reset'].includes(record.sourceKind)
      || path.basename(await ledgerFile(paths, section, record.id)) !== name
      || (section === 'pending' ? typeof (record as RuntimeHistoryPending).registeredAt !== 'string'
        : typeof (record as RuntimeHistoryResidual).checkedAt !== 'string')) {
      throw new Error(`历史登记无法读取：${file}`);
    }
    result.set(record.id, record);
  }
  return result;
}

/** Called in the reset's admission after rename; retry uses the same path-derived id. */
export async function registerRuntimeResetBackup(paths: Paths, backupPath: string): Promise<void> {
  const relative = path.relative(path.resolve(paths.globalStoragePath), path.resolve(backupPath));
  if (relative.startsWith('..') || path.isAbsolute(relative)
    || path.basename(path.dirname(backupPath)) !== RUNTIME_RESET_BACKUPS_DIRECTORY) throw new Error('重置备份位置不正确。');
  const id = `reset:${encodeURIComponent(relative.split(path.sep).join('/'))}`;
  const records = await readRuntimeHistoryResidual(paths);
  if (records.has(id)) return;
  await writeRuntimeHistoryResidual(paths, {
    id, sourceKind: 'reset', location: { kind: 'archive', containerPath: path.resolve(backupPath),
      containerName: relative.split(path.sep).join('/'), dataRootRelativePath: 'active' },
    code: 'runtime-history-reset-backup', message: '归档并重置挪走的库', checkedAt: new Date().toISOString()
  });
}

/** Only directory names are inspected; reset bodies are never scanned at startup. */
export async function reconcileRuntimeResetBackups(paths: Paths): Promise<void> {
  const root = path.resolve(paths.globalStoragePath);
  const scopes = [root];
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
    for (const entry of entries) if (entry.isDirectory()) await registerRuntimeResetBackup(paths, path.join(directory, entry.name));
  }
}
