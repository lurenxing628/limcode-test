import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));

async function within(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function gatedJournal(t, { failedRequest } = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-diagnostic-progress-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  const requests = [];
  const operations = [];
  let gated = true;
  const journal = new kernel.ReliableDiagnosticJournal({
    async validate(candidate) {
      const request = requests.length + 1;
      if (gated) {
        await new Promise((resolve) => requests.push(resolve));
      }
      await authority.validate(candidate);
      if (request === failedRequest) {
        throw Object.assign(new Error('controlled diagnostic write failure'), { code: 'EACCES' });
      }
    }
  }, binding);
  t.after(async () => {
    gated = false;
    for (const release of requests) release();
    await journal.close();
    await Promise.allSettled(operations);
    await fs.rm(parent, { recursive: true, force: true });
  });
  return {
    journal,
    binding,
    inspect(input) {
      const inspection = journal.inspect(input);
      operations.push(inspection);
      return inspection;
    },
    close() {
      const closing = journal.close();
      operations.push(closing);
      return closing;
    },
    async waitForRequests(count) {
      const deadline = Date.now() + 5_000;
      while (requests.length < count) {
        assert.ok(Date.now() < deadline, `timed out waiting for validation request ${count}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    release(index) {
      assert.ok(requests[index], `validation request ${index + 1} exists`);
      requests[index]();
    }
  };
}

function observe(journal, scopeId, count) {
  for (let index = 0; index < count; index += 1) {
    journal.observe({
      eventKind: 'agent.lifecycle',
      scopeKind: 'turn',
      scopeId,
      correlationId: `${scopeId}-${index}`,
      metadata: { stage: 'tool_dispatch_completed', messageSeq: index }
    });
  }
}

async function persistedEvents(binding) {
  const text = await fs.readFile(path.join(binding.paths.dataRootPath, 'diagnostics', 'events.jsonl'), 'utf8');
  return text.trim().split('\n').map((line) => JSON.parse(line));
}

test('诊断 inspect 在持续新事件中返回，并包含调用前的在途事件、排队事件和汇总', async (t) => {
  const fixture = await gatedJournal(t);
  const { journal } = fixture;
  observe(journal, 'before-inspect', 129);
  journal.aggregate({
    eventKind: 'feed.transient.flushed',
    scopeKind: 'turn',
    scopeId: 'before-inspect',
    counters: { rawEventCount: 3 }
  });
  await fixture.waitForRequests(1);
  const inspection = fixture.inspect({ scopeId: 'before-inspect', limit: 200 });
  observe(journal, 'future-first-batch', 140);
  fixture.release(0);
  await fixture.waitForRequests(2);
  observe(journal, 'future-second-batch', 140);
  fixture.release(1);
  await fixture.waitForRequests(3);
  observe(journal, 'future-while-reading', 140);
  fixture.release(2);

  const result = await within(inspection, 'inspection while future writes remain blocked');
  assert.equal(result.events.filter((event) => event.eventKind === 'agent.lifecycle').length, 129);
  assert.equal(result.events.find((event) => event.eventKind === 'feed.transient.flushed.summary')?.metadata.rawEventCount, 3);
  assert.equal(result.state.persistedEvents, 256);
  assert.ok(result.state.pendingEvents > 0, 'future events do not have to drain before inspect returns');
  const events = await persistedEvents(fixture.binding);
  assert.equal(events.filter((event) => event.scopeId === 'before-inspect').length, 130);
});

test('并发诊断 inspect 共享刷新，但各自在调用时的事件边界完成', async (t) => {
  const fixture = await gatedJournal(t);
  const { journal } = fixture;
  observe(journal, 'first-inspect', 129);
  await fixture.waitForRequests(1);
  const first = fixture.inspect({ scopeId: 'first-inspect', limit: 200 });
  observe(journal, 'second-inspect', 140);
  let secondSettled = false;
  const second = fixture.inspect({ scopeId: 'second-inspect', limit: 200 }).then((result) => {
    secondSettled = true;
    return result;
  });
  fixture.release(0);
  await fixture.waitForRequests(2);
  observe(journal, 'future-after-both', 140);
  fixture.release(1);
  await fixture.waitForRequests(4);
  // The earlier inspector reads while the shared writer starts the later inspector's last batch.
  fixture.release(2);
  assert.equal((await within(first, 'earlier inspection')).events.length, 129);
  assert.equal(secondSettled, false);
  fixture.release(3);
  await fixture.waitForRequests(5);
  observe(journal, 'future-while-second-reads', 140);
  fixture.release(4);
  assert.equal((await within(second, 'later inspection')).events.length, 140);
});

test('失败批和溢出丢弃会结算诊断 inspect 的旧事件，不等待纯未来批或重试失败批', async (t) => {
  const fixture = await gatedJournal(t, { failedRequest: 1 });
  const { journal } = fixture;
  observe(journal, 'before-failure', 129);
  await fixture.waitForRequests(1);
  const inspection = fixture.inspect({ scopeId: 'before-failure', limit: 200 });
  // The in-flight 128 old events fail, and the remaining old event is evicted from the 512 queue.
  observe(journal, 'future-overflow', 600);
  fixture.release(0);
  await fixture.waitForRequests(2);
  observe(journal, 'future-overflow-again', 600);
  fixture.release(1);

  const result = await within(inspection, 'inspection after failed and evicted old events');
  assert.deepEqual(result.events, []);
  assert.equal(result.state.persistedEvents, 0);
  assert.ok(result.state.droppedEvents >= 129);
  assert.equal(result.state.pendingEvents, result.bounds.maxPendingEvents);
});

test('诊断 close 停止接收新事件和汇总，并完整写完在途与多批排队事件', async (t) => {
  const fixture = await gatedJournal(t);
  const { journal } = fixture;
  observe(journal, 'before-close', 300);
  journal.aggregate({ eventKind: 'feed.transient.flushed', counters: { rawEventCount: 7 } });
  await fixture.waitForRequests(1);
  const closing = fixture.close();
  observe(journal, 'after-close', 600);
  journal.aggregate({ eventKind: 'feed.transient.flushed', counters: { rawEventCount: 9 } });
  fixture.release(0);
  await fixture.waitForRequests(2);
  fixture.release(1);
  await fixture.waitForRequests(3);
  fixture.release(2);
  await within(closing, 'complete close flush');

  const events = await persistedEvents(fixture.binding);
  assert.equal(events.filter((event) => event.scopeId === 'before-close').length, 300);
  assert.ok(events.every((event) => event.scopeId !== 'after-close'));
  assert.equal(events.find((event) => event.eventKind === 'feed.transient.flushed.summary')?.metadata.rawEventCount, 7);
  assert.equal(events.length, 301);
});
