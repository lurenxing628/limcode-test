import { parentPort, workerData } from 'node:worker_threads';
import { PackedCasStore } from './packedCasStore';
import {
  PACKED_CAS_MAX_QUEUED_BYTES, PACKED_CAS_MAX_QUEUED_REQUESTS, packedCasRequestCharge,
  type PackedCasWorkerData, type PackedCasWorkerError, type PackedCasWorkerRequest, type PackedCasWorkerResponse
} from './packedCasWorkerProtocol';

const port = parentPort;
if (!port) throw new Error('Packed CAS must run in a worker.');
const input = workerData as PackedCasWorkerData;
let store: PackedCasStore | undefined;
let queuedBytes = 0;
let queuedRequests = 0;
let closed = false;
let queue = Promise.resolve();

try {
  store = new PackedCasStore(input.binding, input.options);
  port.on('message', (request: PackedCasWorkerRequest) => {
    const charge = packedCasRequestCharge(request);
    if (closed || (request.kind !== 'close' && (queuedRequests >= PACKED_CAS_MAX_QUEUED_REQUESTS
      || charge > PACKED_CAS_MAX_QUEUED_BYTES - queuedBytes))) {
      post({ type: 'response', id: request.id, ok: false, error: serializeError(Object.assign(
        new Error(closed ? 'Packed CAS owner is closed.' : 'Packed CAS worker queue is full.'),
        { code: closed ? 'EXECUTION_HANDOFF' : 'SQLITE_BUSY_CAS_QUEUE' }
      )) });
      return;
    }
    queuedBytes += charge;
    queuedRequests += 1;
    queue = queue.then(async () => {
      try {
        const owned = store!;
        let result: unknown;
        switch (request.kind) {
          case 'readBytes': result = owned.readBytes(request.object); break;
          case 'inspectByteLength': result = owned.inspectByteLength(request.object); break;
          case 'publishBatch': result = owned.publishBatch(request.entries); break;
          case 'snapshot': result = await owned.snapshot(request.destination); break;
          case 'close':
            owned.close();
            closed = true;
            break;
          default: throw new Error('Unknown packed CAS worker operation.');
        }
        post({ type: 'response', id: request.id, ok: true, result });
        if (closed) port.close();
      } catch (error) {
        post({ type: 'response', id: request.id, ok: false, error: serializeError(error) });
      } finally {
        queuedBytes -= charge;
        queuedRequests -= 1;
      }
    });
  });
  post({ type: 'ready' });
} catch (error) {
  try { store?.close(); } finally {
    post({ type: 'fatal', error: serializeError(error) });
    process.exitCode = 1;
    port.close();
  }
}

function post(response: PackedCasWorkerResponse): void { port!.postMessage(response); }

function serializeError(error: unknown): PackedCasWorkerError {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...(typeof code === 'string' ? { code } : {})
  };
}
