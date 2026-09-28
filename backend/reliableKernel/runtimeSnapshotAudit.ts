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
export function auditRuntimeSnapshot(databasePath: string, request: RuntimeSnapshotAuditRequest): Promise<RuntimeSnapshotAudit> {
  const data: RuntimeSnapshotAuditWorkerData = {
    databasePath: path.resolve(databasePath),
    binding: JSON.parse(JSON.stringify(request.binding)) as RootBinding,
    ...(request.unfinishedWork ? { unfinishedWork: request.unfinishedWork } : {}),
    ...(request.measure ? { measureTables: RUNTIME_DOMAIN_SCHEMAS.map((schema) => schema.table) } : {}),
    ...(request.contentDigest ? { contentDigest: true } : {}),
    ...(request.integrity === false ? { skipIntegrity: true as const } : {}),
    ...(request.summary ? { summary: true as const } : {}),
    ...(request.indexBytes ? { indexBytes: true as const } : {})
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(path.join(__dirname, 'runtimeSnapshotAuditWorker.js'), { workerData: data });
    worker.once('message', (message: RuntimeSnapshotAuditWorkerResponse) => {
      settled = true;
      if (message.ok) resolve(message.audit);
      else reject(new RuntimeSnapshotAuditError(message.error.message, message.error.code));
    });
    worker.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      reject(new Error(`快照核验线程异常退出（退出码 ${code}）。`));
    });
  });
}
