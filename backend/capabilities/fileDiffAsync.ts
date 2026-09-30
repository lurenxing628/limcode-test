import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { buildFileDiffRecord } from './fileDiff';
import type { FsFileDiffRecord } from './types';
// Besides the protocol, this import keeps the worker in the TypeScript build graph.
import type { FileDiffWorkerInput, FileDiffWorkerResult } from './fileDiffWorker';

const MAX_FOREGROUND_CHARS = 32_768;
const MAX_FOREGROUND_LINE_CELLS = 100_000;
const MAX_QUEUED_JOBS = 8;
const MAX_ADMITTED_TEXT_BYTES = 32 * 1024 * 1024;
const WORKER_TIMEOUT_MS = 30_000;

interface Job {
  input: FileDiffWorkerInput;
  bytes: number;
  resolve(result: FsFileDiffRecord | undefined): void;
  reject(error: Error): void;
}

const queue: Job[] = [];
let active = false;
let admittedBytes = 0;

export class FileDiffPreviewBusyError extends Error {
  public readonly code = 'file-diff-preview-busy';
  public readonly retryable = true;
  public constructor() {
    super('File diff previews are busy. Try again after the current previews finish.');
    this.name = 'FileDiffPreviewBusyError';
  }
}

export class FileDiffPreviewTooLargeError extends Error {
  public readonly code = 'file-diff-preview-too-large';
  public readonly retryable = false;
  public constructor() {
    super('This file diff exceeds the preview memory limit. Open it in the diff editor instead.');
    this.name = 'FileDiffPreviewTooLargeError';
  }
}

/** Preserve exact synchronous diff semantics without running large searches on the Extension Host. */
export function buildFileDiffRecordAsync(
  filePath: string, before: string, after: string, existed: boolean
): Promise<FsFileDiffRecord | undefined> {
  if (before === after) return Promise.resolve(undefined);
  if (fitsForegroundBudget(before, after)) {
    return Promise.resolve(buildFileDiffRecord(filePath, before, after, existed));
  }
  // Conservatively account for UTF-16 strings, including the path. Count and bytes
  // cover active + queued text; no unbounded list of waiting closures holds files.
  const bytes = (filePath.length + before.length + after.length) * 2;
  if (bytes > MAX_ADMITTED_TEXT_BYTES) return Promise.reject(new FileDiffPreviewTooLargeError());
  if (queue.length >= MAX_QUEUED_JOBS || bytes > MAX_ADMITTED_TEXT_BYTES - admittedBytes) {
    return Promise.reject(new FileDiffPreviewBusyError());
  }
  return new Promise((resolve, reject) => {
    admittedBytes += bytes;
    queue.push({ input: { filePath, before, after, existed }, bytes, resolve, reject });
    startNext();
  });
}

function fitsForegroundBudget(before: string, after: string): boolean {
  if (before.length + after.length > MAX_FOREGROUND_CHARS) return false;
  const lineCount = (text: string) => (text.match(/\r\n|\r|\n/g)?.length ?? 0) + 1;
  return lineCount(before) * lineCount(after) <= MAX_FOREGROUND_LINE_CELLS;
}

function startNext(): void {
  if (active) return;
  const job = queue.shift();
  if (!job) return;
  active = true;
  let worker: Worker;
  try {
    worker = new Worker(path.join(__dirname, 'fileDiffWorker.js'), {
      workerData: job.input,
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 }
    });
  } catch (error) {
    release(job);
    job.reject(error instanceof Error ? error : new Error(String(error)));
    return;
  }
  let settled = false;
  const finish = (result: FileDiffWorkerResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // Release the slot only once the worker is gone, including timeout/error cases.
    void worker.terminate().then(() => {
      release(job);
      if (result.ok) job.resolve(result.result);
      else job.reject(new Error(result.error));
    }, (error: unknown) => {
      release(job);
      job.reject(error instanceof Error ? error : new Error(String(error)));
    });
  };
  const timer = setTimeout(() => finish({ ok: false, error: 'File diff preview timed out. Try again, or open it in the diff editor.' }), WORKER_TIMEOUT_MS);
  worker.once('message', (result: FileDiffWorkerResult) => finish(result));
  worker.once('error', (error) => finish({ ok: false, error: error.message }));
  worker.once('exit', (code) => finish({ ok: false, error: `File diff preview worker exited before returning a result (${code}).` }));
}

function release(job: Job): void {
  admittedBytes -= job.bytes;
  active = false;
  startNext();
}
