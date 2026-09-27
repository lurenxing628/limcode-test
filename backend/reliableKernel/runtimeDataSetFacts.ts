import type { BigIntStats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { HistoricalRootBinding } from './rootAuthority';
import type { RuntimeDataSetSummary } from './runtimeDataSetContent';
import { copyRuntimeDataSetDatabase, copyRuntimeSqliteFiles, requireCompleteRuntimeDataSet } from './runtimeStorageInspection';
import type { VscodeRuntimeDataSetCandidate } from './vscodeRootAuthority';

/**
 * Read-only facts of one data set from a private copy of its SQLite files, computed in a
 * short-lived worker thread so the extension host's main thread never copies into or scans a
 * database. Same POSIX lock rule as runtimeSnapshotAudit: only the private copy is ever opened, and
 * only by the worker. Never call this for a database this process has open: copying its files
 * opens and closes them, which releases this process's SQLite locks on them.
 */
export interface RuntimeDataSetFactsRequest {
  /** The checks opening it (or the exact published 3/4 upgrade) would perform; a failure rejects. */
  openable?: boolean;
  contentDigest?: boolean;
  summary?: boolean;
  /** Every Conversation and MessageRevision id (the readable history), each sorted. */
  historyIds?: boolean;
}

/** Ids of the readable history of one database; revisions reference their content, which is never deleted. */
export interface RuntimeDataSetHistoryIds {
  conversations: string[];
  messageRevisions: string[];
}

export interface RuntimeDataSetFacts {
  binding: HistoricalRootBinding;
  contentDigest?: string;
  summary?: RuntimeDataSetSummary;
  historyIds?: RuntimeDataSetHistoryIds;
}

/** @internal Worker protocol; plain data only. */
export interface RuntimeDataSetFactsWorkerData extends RuntimeDataSetFactsRequest {
  databasePath: string;
  binding: HistoricalRootBinding;
}

/** @internal */
export type RuntimeDataSetFactsWorkerResponse =
  | { ok: true; facts: Omit<RuntimeDataSetFacts, 'binding'> }
  | { ok: false; error: { name: string; message: string; code?: string } };

export class RuntimeDataSetFactsError extends Error {
  public constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'RuntimeDataSetFactsError';
  }
}

export async function readRuntimeDataSetFacts(
  candidate: VscodeRuntimeDataSetCandidate,
  request: RuntimeDataSetFactsRequest
): Promise<RuntimeDataSetFacts> {
  const binding = await requireCompleteRuntimeDataSet(candidate);
  const copy = await copyRuntimeDataSetDatabase(candidate, binding);
  try {
    const facts = await runWorker({
      databasePath: copy.databasePath,
      binding: JSON.parse(JSON.stringify(binding)) as HistoricalRootBinding,
      ...(request.openable ? { openable: true } : {}),
      ...(request.contentDigest ? { contentDigest: true } : {}),
      ...(request.summary ? { summary: true } : {}),
      ...(request.historyIds ? { historyIds: true } : {})
    });
    return { binding, ...facts };
  } finally {
    await copy.remove();
  }
}

/**
 * The same read-only facts of one SQLite backup file (not a data set) of a configuration root, whose
 * root_binding row must equal `binding` (the binding saved beside it). The copy counts only when the
 * file state (runtimeDataSetFileState) is the same before and after it; `files` is that state.
 */
export async function readRuntimeBackupFacts(
  input: { configurationRootPath: string; databasePath: string; binding: HistoricalRootBinding },
  request: RuntimeDataSetFactsRequest
): Promise<{ files: string; facts: Omit<RuntimeDataSetFacts, 'binding'> }> {
  const files = await runtimeDataSetFileState(input.databasePath);
  const copy = await copyRuntimeSqliteFiles(input.configurationRootPath, input.databasePath);
  try {
    const facts = await runWorker({
      databasePath: copy.databasePath,
      binding: JSON.parse(JSON.stringify(input.binding)) as HistoricalRootBinding,
      ...(request.openable ? { openable: true } : {}),
      ...(request.contentDigest ? { contentDigest: true } : {}),
      ...(request.summary ? { summary: true } : {}),
      ...(request.historyIds ? { historyIds: true } : {})
    });
    if (await runtimeDataSetFileState(input.databasePath) !== files) {
      throw new RuntimeDataSetFactsError('备份文件在读取期间发生了变化。', 'runtime-backup-changed-while-reading');
    }
    return { files, facts };
  } finally {
    await copy.remove();
  }
}

/** Exact state of a database and its WAL file: any rewrite, copy or restore changes it. */
export async function runtimeDataSetFileState(databasePath: string): Promise<string> {
  const describe = (stat: BigIntStats): string => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const database = describe(await fs.stat(databasePath, { bigint: true }));
  let wal = 'absent';
  try { wal = describe(await fs.stat(`${databasePath}-wal`, { bigint: true })); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return `db=${database};wal=${wal}`;
}

function runWorker(data: RuntimeDataSetFactsWorkerData): Promise<Omit<RuntimeDataSetFacts, 'binding'>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(path.join(__dirname, 'runtimeDataSetFactsWorker.js'), { workerData: data });
    worker.once('message', (message: RuntimeDataSetFactsWorkerResponse) => {
      settled = true;
      if (message.ok) resolve(message.facts);
      else reject(new RuntimeDataSetFactsError(message.error.message, message.error.code));
    });
    worker.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`历史库读取线程异常退出（退出码 ${code}）。`));
    });
  });
}
