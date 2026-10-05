import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { registerInProcessSqliteDatabase } from '../capabilities/filesystem/sqliteDatabaseFileGuard';
import { requireCasObjectIdentity, type CasObjectIdentity } from './casObjectAccess';
import { freezeRootBinding, type RootBinding } from './contracts';
import { ExecutionHandoffError } from './executionLeaseFence';
import {
  PACKED_CAS_FILE, PACKED_CAS_MAX_BODY_BYTES, PACKED_CAS_MAX_QUEUED_BYTES,
  PACKED_CAS_MAX_QUEUED_REQUESTS, packedCasRequestCharge,
  type PackedCasOpenOptions, type PackedCasOperation, type PackedCasPlacement,
  type PackedCasWorkerData, type PackedCasWorkerError, type PackedCasWorkerResponse
} from './packedCasWorkerProtocol';

interface PendingRequest {
  charge: number;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

/** One root-owned publisher; borrowed stores never open SQLite on the extension host. */
export class PackedCasWorkerClient {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private readonly exited: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private exitResolve!: () => void;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly snapshotGuards = new Map<number, () => void>();
  private readonly failureListeners = new Set<(error: Error) => void>();
  private queuedBytes = 0;
  private nextId = 1;
  private failure?: Error;
  private fenceError?: Error;
  private didExit = false;
  private closePromise?: Promise<void>;

  private constructor(binding: RootBinding, options: PackedCasOpenOptions) {
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    this.exited = new Promise(resolve => { this.exitResolve = resolve; });
    const release = registerInProcessSqliteDatabase(path.join(binding.paths.casRootPath, PACKED_CAS_FILE));
    try {
      const data: PackedCasWorkerData = { binding: freezeRootBinding(binding), options: { ...options } };
      this.worker = new Worker(path.join(__dirname, 'packedCasWorker.js'), {
        workerData: data, resourceLimits: { maxOldGenerationSizeMb: 64, stackSizeMb: 4 }
      });
    } catch (error) {
      release();
      // No asynchronous startup promise is exposed when Worker construction itself failed.
      this.readyResolve();
      throw error;
    }
    this.worker.on('message', (message: PackedCasWorkerResponse) => this.onMessage(message));
    this.worker.once('error', (error) => this.fail(error));
    this.worker.once('exit', code => {
      this.didExit = true;
      release();
      for (const releaseSnapshot of this.snapshotGuards.values()) releaseSnapshot();
      this.snapshotGuards.clear();
      if (!this.closePromise || this.pending.size > 0) this.fail(new Error(`Packed CAS worker exited with code ${code}.`));
      this.exitResolve();
    });
  }

  public static async open(binding: RootBinding, options: PackedCasOpenOptions = {}): Promise<PackedCasWorkerClient> {
    const client = new PackedCasWorkerClient(binding, options);
    try {
      await client.ready;
      return client;
    } catch (error) {
      // A rejected open must not leave a live, unowned publisher behind.
      if (!client.didExit) await client.worker.terminate();
      await client.exited;
      throw error;
    }
  }

  public async readBytes(object: CasObjectIdentity): Promise<Buffer | undefined> {
    const result = await this.request({ kind: 'readBytes', object: requireCasObjectIdentity(object) });
    return result === undefined ? undefined : Buffer.from(result as Uint8Array);
  }

  public async inspectByteLength(object: CasObjectIdentity): Promise<bigint | undefined> {
    return await this.request({ kind: 'inspectByteLength', object: requireCasObjectIdentity(object) }) as bigint | undefined;
  }

  public async publishBatch(entries: readonly { object: CasObjectIdentity; bytes: Buffer }[]): Promise<PackedCasPlacement[]> {
    this.assertAccepting();
    const operation: PackedCasOperation = { kind: 'publishBatch', entries: entries.map(entry => ({
      object: requireCasObjectIdentity(entry.object), bytes: entry.bytes
    })) };
    this.assertCapacity(operation);
    for (const entry of operation.entries) {
      if (entry.bytes.byteLength > PACKED_CAS_MAX_BODY_BYTES || BigInt(entry.bytes.byteLength) !== entry.object.byte_length) {
        throw new RangeError('Packed CAS publication requires an exact body of at most 8192 bytes.');
      }
      // Copy synchronously, before the first yield. Caller mutation cannot change queued input.
      entry.bytes = Buffer.from(entry.bytes);
    }
    return await this.request(operation) as PackedCasPlacement[];
  }

  public async snapshot(destination: string): Promise<boolean> {
    return await this.request({ kind: 'snapshot', destination: path.resolve(destination) }) as boolean;
  }

  /** Includes unexpected worker failure, including when a facade can satisfy a cached read. */
  public assertUsable(): void { this.assertAccepting(); }

  public onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener);
    if (this.failure) listener(this.failure);
    return () => { this.failureListeners.delete(listener); };
  }

  /** Refuse new work synchronously; already submitted operations retain FIFO/drain semantics. */
  public fence(error: Error = handoffError()): void { this.fenceError ??= error; }

  public close(): Promise<void> {
    this.fence();
    if (this.didExit) return Promise.resolve();
    if (this.closePromise) return this.closePromise;
    const closing = (async () => {
      try {
        if (this.failure) {
          // Errors do not release the file guard; confirmed worker exit does.
          await this.worker.terminate();
        } else {
          await this.request({ kind: 'close' }, true);
        }
        await this.exited;
      } catch (error) {
        // Scoped history owners must never release a source claim with a live SQLite reader.
        // Retain the failure for Runtime's retryable ownership cleanup, after terminal teardown.
        if (!this.didExit) await this.worker.terminate();
        await this.exited;
        throw error;
      }
    })();
    this.closePromise = closing;
    void closing.catch(() => { if (this.closePromise === closing) this.closePromise = undefined; });
    return closing;
  }

  private request(operation: PackedCasOperation, closing = false): Promise<unknown> {
    if (!closing) this.assertAccepting();
    else if (this.didExit) return Promise.resolve(undefined);
    if (this.failure) return Promise.reject(this.failure);
    if (!closing) this.assertCapacity(operation);
    const id = this.nextId++;
    const charge = packedCasRequestCharge(operation);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { charge, resolve, reject });
      this.queuedBytes += charge;
      if (operation.kind === 'snapshot') this.snapshotGuards.set(id, registerInProcessSqliteDatabase(operation.destination));
      try { this.worker.postMessage({ ...operation, id }); }
      catch (error) {
        this.pending.delete(id);
        this.queuedBytes -= charge;
        this.snapshotGuards.get(id)?.();
        this.snapshotGuards.delete(id);
        reject(error);
      }
    });
  }

  private assertAccepting(): void {
    if (this.fenceError) throw this.fenceError;
    if (this.failure) throw this.failure;
    if (this.didExit) throw handoffError();
  }

  private assertCapacity(operation: PackedCasOperation): void {
    if (packedCasRequestCharge(operation) > PACKED_CAS_MAX_QUEUED_BYTES) {
      throw new RangeError('Packed CAS request exceeds the bounded worker byte budget.');
    }
    if (this.pending.size >= PACKED_CAS_MAX_QUEUED_REQUESTS
      || packedCasRequestCharge(operation) > PACKED_CAS_MAX_QUEUED_BYTES - this.queuedBytes) {
      throw Object.assign(new Error('Packed CAS worker queue is full; retry the same publication after pending work drains.'), {
        code: 'SQLITE_BUSY_CAS_QUEUE'
      });
    }
  }

  private onMessage(message: PackedCasWorkerResponse): void {
    if (message.type === 'ready') { this.readyResolve(); return; }
    if (message.type === 'fatal') { this.fail(workerError(message.error)); return; }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    this.queuedBytes -= pending.charge;
    // A response arrives only after the Backup API destination connection has closed.
    this.snapshotGuards.get(message.id)?.();
    this.snapshotGuards.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(workerError(message.error));
  }

  private fail(error: Error): void {
    const firstFailure = this.failure === undefined;
    this.failure ??= error;
    this.fence(this.failure);
    this.readyReject(this.failure);
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
    this.queuedBytes = 0;
    if (firstFailure) {
      for (const listener of this.failureListeners) {
        try { listener(this.failure); } catch { /* The owner callback cannot undo the fence. */ }
      }
    }
  }
}

function workerError(error: PackedCasWorkerError): Error {
  return Object.assign(new Error(error.message), { name: error.name, ...(error.code ? { code: error.code } : {}) });
}

function handoffError(): Error {
  return new ExecutionHandoffError('Packed CAS root is closing or changing ownership.');
}
