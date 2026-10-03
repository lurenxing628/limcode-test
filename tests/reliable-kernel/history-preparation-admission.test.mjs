import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { HistoryPreparationAdmission, MAX_CONCURRENT_HISTORY_PREPARATIONS } = require(path.join(compiled,
  'backend/reliableKernel/historyPreparationAdmission.js'));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('history preparation defaults to two and bounds lightweight FIFO admission at capacities one and two', async () => {
  assert.equal(MAX_CONCURRENT_HISTORY_PREPARATIONS, 2);
  for (const capacity of [1, 2]) {
    const admission = new HistoryPreparationAdmission(capacity), blocks = Array.from({ length: 6 }, deferred);
    const started = []; let activePlans = 0, highWater = 0;
    const tasks = blocks.map((block, index) => admission.run(async permit => {
      permit.assertActive();
      started.push(index); activePlans++; highWater = Math.max(highWater, activePlans);
      try { await block.promise; } finally { activePlans--; }
    }));
    await tick();
    assert.deepEqual(started, Array.from({ length: capacity }, (_, i) => i));
    assert.equal(admission.waiters.size, 6 - capacity);
    for (const waiter of admission.waiters) {
      assert.deepEqual(Object.keys(waiter).sort(), ['onAbort', 'reject', 'resolve', 'signal']);
    }
    for (let index = 0; index < blocks.length; index++) { blocks[index].resolve(); await tick(); }
    await Promise.all(tasks);
    assert.deepEqual(started, [0, 1, 2, 3, 4, 5]);
    assert.equal(highWater, capacity);
    await admission.whenIdle();
  }
});

test('explicit nested permit avoids capacity-one deadlock and rejects parallel, stale and foreign reuse', async () => {
  const admission = new HistoryPreparationAdmission(1), foreign = new HistoryPreparationAdmission(1);
  const nested = deferred(); let saved;
  await admission.run(async permit => {
    saved = permit;
    const first = admission.run(async reused => { assert.equal(reused, permit); await nested.promise; }, { permit });
    await assert.rejects(admission.run(async () => {}, { permit }), /already in use/);
    await assert.rejects(foreign.run(async () => {}, { permit }), /foreign/);
    nested.resolve(); await first;
    await admission.run(async reused => reused.assertActive(), { permit });
  });
  assert.throws(() => saved.assertActive(), /no longer active/);
  await assert.rejects(admission.run(async () => {}, { permit: saved }), /stale/);
});

test('queued cancellation, shutdown and preparation exceptions settle without leaked grants', async () => {
  const admission = new HistoryPreparationAdmission(1), block = deferred(), entered = deferred();
  const active = admission.run(async permit => { entered.resolve(); await block.promise; permit.assertActive(); });
  const activeResult = active.catch(error => error);
  await entered.promise;
  const controller = new AbortController(), abort = new Error('cancel queued');
  const queued = admission.run(async () => assert.fail('cancelled callback ran'), { signal: controller.signal });
  const cancelled = assert.rejects(queued, error => error === abort);
  controller.abort(abort); await cancelled;
  assert.equal(admission.waiters.size, 0);
  const closed = new Error('runtime handoff');
  const queuedAtClose = admission.run(async () => assert.fail('closed callback ran'));
  const rejected = assert.rejects(queuedAtClose, error => error === closed);
  admission.close(closed); await rejected;
  let idle = false; const drained = admission.whenIdle().then(() => { idle = true; });
  await tick(); assert.equal(idle, false);
  block.resolve(); assert.equal(await activeResult, closed); await drained;
  await assert.rejects(admission.run(async () => {}), error => error === closed);
  const retry = new HistoryPreparationAdmission(1);
  await assert.rejects(retry.run(async () => { throw new Error('preparation failed'); }), /preparation failed/);
  assert.equal(await retry.run(async () => 'released'), 'released');
});

test('abort after grant but before callback begins never creates a plan', async () => {
  const admission = new HistoryPreparationAdmission(1), controller = new AbortController();
  const task = admission.run(async () => assert.fail('aborted grant entered'), { signal: controller.signal });
  controller.abort(new Error('abort at grant'));
  await assert.rejects(task, /abort at grant/);
  assert.equal(await admission.run(async () => 'next'), 'next');
});
