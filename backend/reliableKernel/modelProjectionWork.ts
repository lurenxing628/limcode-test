import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';

/** Internal projection work only. A yielded value never contains a partially built payload. */
export type ModelProjectionWork<T> = Generator<void, T, void>;
export interface ModelProjectionWorkControls {
  signal?: AbortSignal;
  /** Optional owner/cancellation fence, checked before work and around each real event-loop yield. */
  checkpoint?(): void | Promise<void>;
}

export function completeModelProjection<T>(work: ModelProjectionWork<T>): T {
  for (;;) {
    const step = work.next();
    if (step.done) return step.value;
  }
}

export async function completeModelProjectionCooperatively<T>(
  work: ModelProjectionWork<T>, controls: ModelProjectionWorkControls = {}
): Promise<T> {
  const check = async (): Promise<void> => {
    controls.signal?.throwIfAborted();
    await controls.checkpoint?.();
    controls.signal?.throwIfAborted();
  };
  let finished = false;
  try {
    await check();
    let started = performance.now(), units = 0;
    for (;;) {
      controls.signal?.throwIfAborted();
      const step = work.next();
      if (step.done) { await check(); finished = true; return step.value; }
      if (++units < 32 && performance.now() - started < 8) continue;
      await check(); await yieldToEventLoop(); await check();
      started = performance.now(); units = 0;
    }
  } finally {
    // Closing the generator unwinds nested yield* work and releases the partial graph on abort/error.
    if (!finished) work.return(undefined as T);
  }
}
