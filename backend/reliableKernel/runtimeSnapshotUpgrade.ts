import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { RootBinding } from './contracts';
import type { HistoricalRootBinding } from './rootAuthority';

/**
 * The exact published epoch-3/4/5 upgrade of a private snapshot copy (upgradePublishedRuntimeSnapshot),
 * run in a short-lived worker thread so the extension host's main thread never blocks on it.
 *
 * POSIX lock rule (see runtimeSnapshotAudit): the worker opens only the private copy, and the caller
 * opens that copy again only after the worker has exited. Historical bodies are never opened by the
 * worker: it asks this thread for them, and `readObject` reads them as the caller's root requires
 * (a foreign root's checked descriptors). Bodies the upgrade converts go only to `overlayCasRoot`.
 */
export interface RuntimeSnapshotUpgradeOptions {
  /** The verified bytes of one content object of the snapshot's root. */
  readObject(object: RuntimeSnapshotUpgradeObject): Promise<Buffer>;
  /** Private content-addressed directory for converted old Child continuations; without it they refuse. */
  overlayCasRoot?: string;
  signal?: AbortSignal;
}

export interface RuntimeSnapshotUpgradeObject {
  sha256: string;
  byte_length: bigint;
  storage_key: string;
}

/** @internal Worker protocol; plain data only. */
export interface RuntimeSnapshotUpgradeWorkerData {
  databasePath: string;
  previous: HistoricalRootBinding;
  overlayCasRoot?: string;
}

/** @internal */
export type RuntimeSnapshotUpgradeWorkerMessage =
  | { kind: 'read'; id: number; sha256: string; byteLength: string; storageKey: string; offset: number; length: number }
  | { kind: 'done'; ok: true; binding: RootBinding }
  | { kind: 'done'; ok: false; error: { name: string; message: string; code?: string } };

/** @internal */
export type RuntimeSnapshotUpgradeReadResult =
  | { kind: 'read-result'; id: number; ok: true; bytes: Uint8Array }
  | { kind: 'read-result'; id: number; ok: false; message: string };

export class RuntimeSnapshotUpgradeError extends Error {
  public constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'RuntimeSnapshotUpgradeError';
  }
}

/** Upgrades the snapshot copy at `databasePath` in place; the caller must not have it open meanwhile. */
export function upgradeRuntimeSnapshotInWorker(
  databasePath: string,
  previous: HistoricalRootBinding,
  options: RuntimeSnapshotUpgradeOptions
): Promise<RootBinding> {
  options.signal?.throwIfAborted();
  const data: RuntimeSnapshotUpgradeWorkerData = {
    databasePath: path.resolve(databasePath),
    previous: JSON.parse(JSON.stringify(previous)) as HistoricalRootBinding,
    ...(options.overlayCasRoot ? { overlayCasRoot: path.resolve(options.overlayCasRoot) } : {})
  };
  return new Promise((resolve, reject) => {
    let done: Extract<RuntimeSnapshotUpgradeWorkerMessage, { kind: 'done' }> | undefined;
    let workerError: Error | undefined;
    // The first body this thread could not read decides the outcome (a refused foreign file stays that refusal).
    let readError: unknown;
    let aborted = false;
    const reads = new Set<Promise<void>>();
    // Sequential range reads of one body read it once.
    let cached: { key: string; bytes: Buffer } | undefined;
    const worker = new Worker(path.join(__dirname, 'runtimeSnapshotUpgradeWorker.js'), { workerData: data });
    const abort = (): void => {
      aborted = true;
      void worker.terminate();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    worker.on('message', (message: RuntimeSnapshotUpgradeWorkerMessage) => {
      if (message.kind === 'done') {
        done = message;
        return;
      }
      if (aborted) return;
      const reading = (async () => {
        let reply: RuntimeSnapshotUpgradeReadResult;
        try {
          const object = { sha256: message.sha256, byte_length: BigInt(message.byteLength), storage_key: message.storageKey };
          const key = `${object.storage_key}:${message.byteLength}`;
          if (cached?.key !== key) cached = { key, bytes: await options.readObject(object) };
          const end = message.offset + message.length;
          if (!Number.isSafeInteger(message.offset) || message.offset < 0 || !Number.isSafeInteger(end) || end > cached.bytes.length) {
            throw new RangeError('Historical body range is outside its content object.');
          }
          reply = { kind: 'read-result', id: message.id, ok: true, bytes: cached.bytes.subarray(message.offset, end) };
        } catch (error) {
          readError ??= error;
          reply = { kind: 'read-result', id: message.id, ok: false, message: error instanceof Error ? error.message : String(error) };
        }
        if (!aborted) worker.postMessage(reply);
      })();
      reads.add(reading);
      void reading.finally(() => reads.delete(reading)).catch(() => undefined);
    });
    worker.once('error', (error) => {
      workerError = error;
    });
    worker.once('exit', async (code) => {
      // Body reads run on this thread; worker exit alone does not finish their descriptors.
      await Promise.allSettled(reads);
      options.signal?.removeEventListener('abort', abort);
      // Settle only after the worker exited, so the caller never reopens a copy it still holds.
      if (aborted) reject(options.signal?.reason ?? new Error('Snapshot upgrade aborted.'));
      else if (done?.ok) resolve(done.binding);
      else if (readError !== undefined) reject(readError);
      else if (workerError) reject(workerError);
      else if (done && !done.ok) reject(new RuntimeSnapshotUpgradeError(done.error.message, done.error.code));
      else reject(new Error(`快照升级线程异常退出（退出码 ${code}）。`));
    });
  });
}
