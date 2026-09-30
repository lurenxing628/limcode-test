import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';
const require = createRequire(import.meta.url);
const root = process.cwd();
const { buildFileDiffRecordAsync } = require(path.join(root, 'dist/extension/backend/capabilities/fileDiffAsync.js'));
const { buildFileDiffRecord } = require(path.join(root, 'dist/extension/backend/capabilities/fileDiff.js'));
const { ClientDetailReader } = require(path.join(root, 'dist/extension/backend/reliableKernel/clientFeed.js'));
const { FileDiffPreviewBusyError, FileDiffPreviewTooLargeError } = require(path.join(root, 'dist/extension/backend/capabilities/fileDiffAsync.js'));
const { ReliableKernelWebviewFeedBridge } = require(path.join(root, 'dist/extension/backend/reliableKernel/webviewFeedBridge.js'));

async function detailError(error, requestId = 'request') {
  const posted = [];
  const bridge = new ReliableKernelWebviewFeedBridge({}, { async read() { throw error; } });
  bridge.post = (_client, message) => posted.push(message);
  const client = { closed: false, ready: true, visible: true, navigationGeneration: 1,
    meta: { conversationId: 'conversation' }, detailRequests: new Set() };
  await bridge.readDetail(client, { sessionId: 'session' }, {
    requestId, kind: 'file-change-diff', recordId: 'member', offset: 0, maxBytes: 65536
  });
  assert.equal(client.detailRequests.size, 0);
  return posted[0];
}

test('file diff detail errors retain permanent and temporary classification across the bridge', async () => {
  for (const error of [new FileDiffPreviewTooLargeError(), new FileDiffPreviewBusyError()]) {
    const message = await detailError(error);
    assert.equal(message.code, error.code);
    assert.equal(message.retryable, error.retryable);
    assert.equal(message.message, error.message);
  }
});

test('permanent file diff errors stop automatic and manual retries while busy previews retry', async t => {
  const oldWindow = globalThis.window;
  const posted = [];
  globalThis.window = { setTimeout, clearTimeout, atob, requestAnimationFrame() {},
    addEventListener() {}, removeEventListener() {},
    acquireVsCodeApi: () => ({ postMessage: message => posted.push(message), getState() {}, setState() {} }) };
  const server = await createWebviewSsrServer();
  t.after(async () => { await server.close(); globalThis.window = oldWindow; });
  const pinia = await import('pinia');
  const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sendError = async (store, error) => {
    const requestId = Object.keys(store.pendingDetails)[0];
    assert.ok(requestId);
    store.observeDetailError(await detailError(error, requestId));
  };
  for (const permanent of [true, false]) {
    pinia.setActivePinia(pinia.createPinia());
    const store = useReliableKernelClientFeedStore();
    Object.assign(store, { sessionId: 'session', hostBootId: 'host' });
    posted.length = 0;
    const key = store.requestDetail('file-change-diff', 'member');
    const error = permanent ? new FileDiffPreviewTooLargeError() : new FileDiffPreviewBusyError();
    await sendError(store, error);
    const requests = () => posted.filter(message => message.type === 'reliable-kernel.detail-request').length;
    if (permanent) {
      assert.equal(store.details[key].terminalError, true);
      assert.equal(store.details[key].nextRetryAt, undefined);
      t.mock.timers.tick(5000);
      store.retryDetail('file-change-diff', 'member');
      assert.equal(requests(), 1, 'the same permanent preview never sends another request');
    } else {
      assert.notEqual(store.details[key].terminalError, true);
      t.mock.timers.tick(250);
      assert.equal(requests(), 2, 'busy preview retries after the existing backoff');
      await sendError(store, new FileDiffPreviewTooLargeError());
      assert.equal(store.details[key].terminalError, true);
      t.mock.timers.tick(5000);
      assert.equal(requests(), 2, 'a later permanent failure cancels further retries');
    }
    store.$dispose();
  }
  t.mock.timers.reset();
});

function fixture(before = 'old\n', after = 'new\n') {
  const state = { reads: 0, deleted: false, fail: false, overrideSize: undefined, target: 'target' };
  const db = { async snapshot(reads) { return { snapshot: reads.map((r) => r.domain === 'FileChangeSetMember'
    ? state.deleted ? null : { id: r.id, operation: 'replace_file', target_path: 'unicode.txt', base_content_object_id: 'base', target_content_object_id: state.target }
    : { id: r.id, byte_length: BigInt(state.overrideSize ?? Buffer.byteLength(r.id === 'base' ? before : after)) }) }; } };
  const store = { async read(metadata) { state.reads += 1; if (state.fail) throw new Error('CAS unavailable'); return Buffer.from(metadata.id === 'base' ? before : after); } };
  const reader = new ClientDetailReader(db, store);
  const read = (recordId = 'member', offset = 0) => reader.read({ kind: 'file-change-diff', recordId, offset, maxBytes: 65536 });
  return { state, reader, read };
}

test('large async diff uses the packaged worker, allows event-loop progress and preserves exact output', async () => {
  const before = Array.from({ length: 10_000 }, (_, i) => `old${i}`).join('\n');
  const after = Array.from({ length: 10_000 }, (_, i) => `new${i}`).join('\n');
  let yielded = false;
  setImmediate(() => { yielded = true; });
  const actual = await buildFileDiffRecordAsync('generated.txt', before, after, true);
  assert.equal(yielded, true);
  assert.deepEqual(actual, buildFileDiffRecord('generated.txt', before, after, true));
});

test('worker admission bounds both queue count and retained text, then admits later work', async () => {
  const before = 'old\n'.repeat(9_000);
  const after = 'new\n'.repeat(9_000);
  const admitted = Array.from({ length: 9 }, () => buildFileDiffRecordAsync('file', before, after, true));
  await assert.rejects(buildFileDiffRecordAsync('overflow', before, after, true), { code: 'file-diff-preview-busy', retryable: true });
  await Promise.all(admitted);
  await assert.rejects(buildFileDiffRecordAsync('huge', 'x'.repeat(16 * 1024 * 1024 + 1), '', true), { code: 'file-diff-preview-too-large', retryable: false });
  const result = await buildFileDiffRecordAsync('later', before, after, true);
  assert.equal(result.added, 9000);
});

test('Unicode continuation pages and concurrent initial pages reuse one diff materialization', async () => {
  const { state, read } = fixture('旧😀'.repeat(40_000), '新😀'.repeat(40_000));
  const [first, same] = await Promise.all([read(), read()]);
  assert.deepEqual(first, same);
  assert.equal(state.reads, 2);
  assert.equal(first.hasMore, true);
  const chunks = [Buffer.from(first.chunk, 'base64')];
  let chunk = first;
  while (chunk.hasMore) {
    chunk = await read('member', chunk.nextOffset);
    chunks.push(Buffer.from(chunk.chunk, 'base64'));
  }
  const bytes = Buffer.concat(chunks);
  assert.equal(bytes.length, first.totalBytes);
  const record = JSON.parse(bytes.toString('utf8'));
  assert.equal(record.diff.truncated, true);
  assert.equal(record.diff.text.isWellFormed(), true);
  assert.equal(state.reads, 2, 'continuation must not reread/recompute immutable CAS bodies');
  state.deleted = true;
  await assert.rejects(read(), /FileChangeSetMember/);
});

test('cache bounds, identity changes and failed reads cannot retain stale or failed materializations', async () => {
  const { state, read } = fixture();
  for (let i = 0; i < 17; i++) await read(`member${i}`);
  assert.equal(state.reads, 34);
  await read('member0');
  assert.equal(state.reads, 36, 'oldest entry is evicted');
  state.target = 'another-target';
  await read('member0');
  assert.equal(state.reads, 38, 'a different content identity is not served from cache');
  state.fail = true;
  await assert.rejects(read('failed'), /CAS unavailable/);
  state.fail = false;
  await read('failed');
});

test('oversize CAS metadata is rejected before allocating file bodies', async () => {
  const { state, read } = fixture();
  state.overrideSize = 20 * 1024 * 1024;
  await assert.rejects(read(), { code: 'file-diff-preview-too-large', retryable: false });
  assert.equal(state.reads, 0);
  state.overrideSize = undefined;
  await read();
  assert.equal(state.reads, 2);
});

test('worker error, premature exit, construction failure and timeout release their admission slots', async (t) => {
  const Module = require('node:module');
  const { EventEmitter } = require('node:events');
  const modulePath = path.join(root, 'dist/extension/backend/capabilities/fileDiffAsync.js');
  const workers = [];
  let failConstruction = false;
  class FakeWorker extends EventEmitter {
    constructor(_path, options) { super(); if (failConstruction) throw new Error('spawn failed'); this.options = options; workers.push(this); }
    async terminate() { this.terminated = true; return 0; }
  }
  const originalLoad = Module._load;
  const originalCached = require.cache[modulePath];
  delete require.cache[modulePath];
  let run;
  try {
    Module._load = function (id, ...args) { return id === 'node:worker_threads' ? { Worker: FakeWorker } : originalLoad.call(this, id, ...args); };
    run = require(modulePath).buildFileDiffRecordAsync;
  } finally {
    Module._load = originalLoad;
    require.cache[modulePath] = originalCached;
  }
  const begin = () => run('large', 'x'.repeat(40_000), 'y'.repeat(40_000), true);
  let pending = begin();
  assert.deepEqual(workers.at(-1).options.resourceLimits, { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 });
  workers.at(-1).emit('error', new Error('worker failed'));
  await assert.rejects(pending, /worker failed/);
  assert.equal(workers.at(-1).terminated, true);
  pending = begin();
  workers.at(-1).emit('exit', 1);
  await assert.rejects(pending, /exited before/);
  failConstruction = true;
  await assert.rejects(begin(), /spawn failed/);
  failConstruction = false;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  pending = begin();
  t.mock.timers.tick(30_000);
  await assert.rejects(pending, /timed out/);
  t.mock.timers.reset();
  pending = begin();
  workers.at(-1).emit('message', { ok: true, result: undefined });
  assert.equal(await pending, undefined, 'a later request still starts and completes');
  assert.equal(workers.at(-1).terminated, true);
});

test('the original 70k-line file-change-diff detail regression succeeds end to end', async () => {
  const before = Array.from({ length: 70_000 }, (_, i) => `old${i}`).join('\n');
  const after = Array.from({ length: 70_000 }, (_, i) => `new${i}`).join('\n');
  const { state, read } = fixture(before, after);
  let chunk = await read();
  const pieces = [Buffer.from(chunk.chunk, 'base64')];
  while (chunk.hasMore) {
    chunk = await read('member', chunk.nextOffset);
    pieces.push(Buffer.from(chunk.chunk, 'base64'));
  }
  const result = JSON.parse(Buffer.concat(pieces).toString('utf8'));
  assert.equal(result.diff.added, 70_000);
  assert.equal(result.diff.removed, 70_000);
  assert.equal(result.diff.truncated, true);
  assert.equal(state.reads, 2);
});
