import type { RuntimeHistoryRepairInspection } from './runtimeHistoryRepairInspection';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { RootBinding } from './contracts';
import type { RuntimeDataSetSummary } from './runtimeDataSetContent';
import type { CarriedWorkRefusals, UnfinishedWorkInspection } from './runtimeDataSetMergeProbes';
import { RUNTIME_DOMAIN_SCHEMAS } from './schema/domainManifest';

/**
 * Full-file checks of a private data-set snapshot copy, run in a short-lived worker thread so the
 * extension host's main thread never blocks on them: current schema and physical fingerprint,
 * quick_check, foreign_key_check, then the requested read-only probes.
 *
 * POSIX lock rule (see sqliteDatabaseFileGuard): SQLite's fcntl locks belong to the process, and
 * closing any descriptor of a database file drops all of this process's locks on it. The worker
 * only ever opens the private copy (a fresh file in its own temporary directory, never the source
 * database, its -wal/-shm, or any database the Runtime worker holds), and the caller opens that copy
 * on its own thread only after the worker has closed it and exited. No two connections of this
 * process overlap on the copy, and nothing of the live database is opened at all.
 */
export interface RuntimeSnapshotAuditRequest {
  binding: RootBinding;
  /** 'finalize' classifies work a historical merge closes first; 'carry' what a migration refuses. */
  unfinishedWork?: 'finalize' | 'carry';
  /** Row count over every Runtime domain and file size in bytes, and the content objects' count and bytes. */
  measure?: boolean;
  /** runtimeDataSetContentDigest of the copy (the content part of a merge fingerprint). */
  contentDigest?: boolean;
  /** false: only the schema checks and the requested measures (quick_check and foreign_key_check skipped). */
  integrity?: boolean;
  /** Project names, conversation count and last activity (readRuntimeDataSetSummary). */
  summary?: boolean;
  /** Bytes of the copy's index pages (dbstat): a large-merge preparation's measure of its target backup. */
  indexBytes?: boolean;
  /** Explicit history repair planning; reads only, and never starts old work. */
  historyRepair?: boolean;
  /** Private SQLite index of skipped domain/id keys, used only by the unfinished-work recheck. */
  skippedRowsPath?: string;
}

export interface RuntimeSnapshotAudit {
  unfinishedWork?: UnfinishedWorkInspection;
  carriedWork?: CarriedWorkRefusals;
  size?: { rows: number; bytes: number };
  /** With `measure`: content_object rows and the sum of their byte_length (a storage key shared by rows counts per row). */
  content?: { objects: number; bytes: number };
  contentDigest?: string;
  summary?: RuntimeDataSetSummary;
  indexBytes?: number;
  historyRepair?: RuntimeHistoryRepairInspection;
}

/** @internal Worker protocol; plain data only. */
export interface RuntimeSnapshotAuditWorkerData {
  databasePath: string;
  binding: RootBinding;
  unfinishedWork?: 'finalize' | 'carry';
  measureTables?: string[];
  contentDigest?: boolean;
  skipIntegrity?: true;
  summary?: true;
  indexBytes?: true;
  historyRepair?: true;
  skippedRowsPath?: string;
}

/** @internal */
export type RuntimeSnapshotAuditWorkerResponse =
  | { ok: true; audit: RuntimeSnapshotAudit }
  | { ok: false; error: { name: string; message: string; code?: string } };

export class RuntimeSnapshotAuditError extends Error {
  public constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'RuntimeSnapshotAuditError';
  }
}

/** Audits the snapshot copy at `databasePath`; the caller must not have it open meanwhile. */
export function auditRuntimeSnapshot(databasePath: string, request: RuntimeSnapshotAuditRequest, options: { signal?: AbortSignal } = {}): Promise<RuntimeSnapshotAudit> {
  options.signal?.throwIfAborted();
  if (request.skippedRowsPath && request.unfinishedWork !== 'finalize') {
    throw new TypeError('A skipped-row index is only used by a historical unfinished-work audit.');
  }
  const data: RuntimeSnapshotAuditWorkerData = {
    databasePath: path.resolve(databasePath),
    binding: JSON.parse(JSON.stringify(request.binding)) as RootBinding,
    ...(request.unfinishedWork ? { unfinishedWork: request.unfinishedWork } : {}),
    ...(request.measure ? { measureTables: RUNTIME_DOMAIN_SCHEMAS.map((schema) => schema.table) } : {}),
    ...(request.contentDigest ? { contentDigest: true } : {}),
    ...(request.integrity === false ? { skipIntegrity: true as const } : {}),
    ...(request.summary ? { summary: true as const } : {}),
    ...(request.indexBytes ? { indexBytes: true as const } : {}),
    ...(request.historyRepair ? { historyRepair: true as const } : {}),
    ...(request.skippedRowsPath ? { skippedRowsPath: path.resolve(request.skippedRowsPath) } : {})
  };
  return new Promise((resolve, reject) => {
    let response: RuntimeSnapshotAuditWorkerResponse | undefined;
    let workerError: Error | undefined;
    const worker = new Worker(path.join(__dirname, 'runtimeSnapshotAuditWorker.js'), { workerData: data });
    let aborted = false;
    const abort = (): void => { aborted = true; void worker.terminate(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    worker.once('message', (message: RuntimeSnapshotAuditWorkerResponse) => {
      response = message;
    });
    worker.once('error', (error) => {
      workerError = error;
    });
    worker.once('exit', (code) => {
      // Resolve only after the worker exited. A suspended snapshot reader may be reopened next;
      // even an error response must never let that overlap a worker still closing its descriptors.
      options.signal?.removeEventListener('abort', abort);
      if (aborted) reject(options.signal?.reason ?? new Error('Snapshot audit aborted.'));
      else if (workerError) reject(workerError);
      else if (code !== 0 || !response) reject(new Error(`快照核验线程异常退出（退出码 ${code}）。`));
      else if (response.ok) resolve(response.audit);
      else reject(new RuntimeSnapshotAuditError(response.error.message, response.error.code));
    });
  });
}
