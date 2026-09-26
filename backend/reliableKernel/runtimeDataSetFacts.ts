import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { HistoricalRootBinding } from './rootAuthority';
import type { RuntimeDataSetSummary } from './runtimeDataSetContent';
import { copyRuntimeDataSetDatabase, requireCompleteRuntimeDataSet } from './runtimeStorageInspection';
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
}

export interface RuntimeDataSetFacts {
  binding: HistoricalRootBinding;
  contentDigest?: string;
  summary?: RuntimeDataSetSummary;
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
      ...(request.summary ? { summary: true } : {})
    });
    return { binding, ...facts };
  } finally {
    await copy.remove();
  }
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
