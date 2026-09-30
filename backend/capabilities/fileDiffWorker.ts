import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { buildFileDiffRecord } from './fileDiff';
import type { FsFileDiffRecord } from './types';

export interface FileDiffWorkerInput {
  filePath: string;
  before: string;
  after: string;
  existed: boolean;
}

export type FileDiffWorkerResult =
  | { ok: true; result: FsFileDiffRecord | undefined }
  | { ok: false; error: string };

// A one-shot worker has no message listener or persistent resources. The caller
// also terminates it on completion, timeout and failure before admitting more work.
if (!isMainThread && parentPort) {
  const input = workerData as FileDiffWorkerInput;
  let response: FileDiffWorkerResult;
  try {
    response = { ok: true, result: buildFileDiffRecord(input.filePath, input.before, input.after, input.existed) };
  } catch (error) {
    response = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  parentPort.postMessage(response);
}
