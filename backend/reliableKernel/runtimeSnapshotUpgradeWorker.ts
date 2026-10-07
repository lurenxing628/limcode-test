import { parentPort, workerData } from 'node:worker_threads';
import { publishCasFile } from './runtimeDeliveryIntentLinkMigration';
import { upgradePublishedRuntimeSnapshot } from './runtimeEpochMigration';
import type {
  RuntimeSnapshotUpgradeReadResult, RuntimeSnapshotUpgradeWorkerData, RuntimeSnapshotUpgradeWorkerMessage
} from './runtimeSnapshotUpgrade';

// Entry point of upgradeRuntimeSnapshotInWorker's worker; see there for the POSIX lock rule.
const data = workerData as RuntimeSnapshotUpgradeWorkerData;
const port = parentPort!;
const pending = new Map<number, { resolve(bytes: Buffer): void; reject(error: Error): void }>();
let nextId = 1;

port.on('message', (message: RuntimeSnapshotUpgradeReadResult) => {
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.ok) waiter.resolve(Buffer.from(message.bytes.buffer, message.bytes.byteOffset, message.bytes.byteLength));
  else waiter.reject(new Error(message.message));
});

function read(sha256: string, byteLength: bigint, storageKey: string, offset: number, length: number): Promise<Buffer> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const request: RuntimeSnapshotUpgradeWorkerMessage = {
      kind: 'read', id, sha256, byteLength: byteLength.toString(), storageKey, offset, length
    };
    port.postMessage(request);
  });
}

void (async () => {
  let message: RuntimeSnapshotUpgradeWorkerMessage;
  try {
    const binding = await upgradePublishedRuntimeSnapshot(data.databasePath, data.previous, {
      ranges: (metadata, offset, length) => read(metadata.sha256, metadata.byte_length, metadata.storage_key, offset, length),
      childContinuations: {
        read: (storageKey, sha256, byteLength) => {
          if (byteLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Historical continuation body is too large.');
          return read(sha256, byteLength, storageKey, 0, Number(byteLength));
        },
        publish: async (storageKey, bytes, sha256) => {
          if (!data.overlayCasRoot) throw new Error('This snapshot has no private overlay for converted Child continuations.');
          await publishCasFile(data.overlayCasRoot, storageKey, bytes, sha256);
        }
      }
    });
    message = { kind: 'done', ok: true, binding: JSON.parse(JSON.stringify(binding)) };
  } catch (error) {
    message = {
      kind: 'done',
      ok: false,
      error: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        ...(typeof (error as { code?: unknown } | null)?.code === 'string' ? { code: (error as { code: string }).code } : {})
      }
    };
  }
  port.postMessage(message);
  port.close();
})();
