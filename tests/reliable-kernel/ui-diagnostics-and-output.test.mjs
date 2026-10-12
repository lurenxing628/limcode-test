import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { kernel, RuntimeDiagnosticMetrics, DebugCaptureService, DebugHttpObservation, createTerminalValidatedFetch,
  createDiagnosticsFixture, sqlitePeers, createDetailStoreFixture, buildFileDiffRecordAsync, FileDiffPreviewTooLargeError, loadBuiltEntry,
  diffWorkers, built, repo, deferred } from './ui-diagnostics-and-output-fixture.mjs';

let h;
before(async () => { h = await createDiagnosticsFixture(); });
after(async () => { await h?.close(); });
const SECRET = '禁止持久化的正文或凭证';

test('真实中文工具流录制后封存并重开，入口字节和可靠前缀一致，模型输出保持原样', async () => {
  const source = { extensionVersion: 'test', sourceCommit: 'test', hostBootId: 'capture-host', buildId: 'actual-build' };
  const context = { conversationId: 'capture-conversation', modelRequestId: 'capture-request', attemptSeq: 1, socketGeneration: 1 };
  const service = new DebugCaptureService(h.authority, h.binding, source);
  const unified = await import('unified-llm-provider');
  const events = [
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'item-a', call_id: 'call-a', name: 'echo', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'item-a', delta: '{"text":"中文😀"}' },
    { type: 'response.function_call_arguments.done', item_id: 'item-a', arguments: '{"text":"中文😀"}' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'item-a', call_id: 'call-a', name: 'echo', arguments: '{"text":"中文😀"}' } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'reasoning', delta: '实际思考' },
    { type: 'response.completed', response: { id: 'response-a', status: 'completed', output: [] } }
  ];
  const raw = Buffer.from(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
  async function run(recorder) {
    const provider = unified.createLLMFromConfig({ provider: 'openai-responses', model: 'test', apiKey: 'offline', baseUrl: 'https://example.invalid/v1',
      fetch: createTerminalValidatedFetch(async () => new Response(new ReadableStream({ start(controller) {
        for (let offset = 0; offset < raw.length; offset += 17) controller.enqueue(raw.subarray(offset, offset + 17)); controller.close();
      } }), { headers: { 'content-type': 'text/event-stream' } }), 'openai-responses',
      { createObservation: recorder ? () => new DebugHttpObservation(recorder, context, unified.attachLlmResponseObserver) : undefined })
    }, unified.createBootstrapExtensionRegistry().llmProviders);
    const output = [];
    for await (const chunk of provider.chatStream({ contents: [{ role: 'user', parts: [{ text: '实际输入' }] }] },
      { inputFormat: 'unified', outputFormat: 'unified' })) output.push(chunk);
    return output;
  }
  let runId;
  try {
    await service.start({ commandId: 'record-stream', conversationId: context.conversationId, settings: { scope: 'conversation', maxMiB: 8, maxMinutes: 5 } });
    runId = service.active(context); assert.ok(runId);
    assert.deepEqual(await run(service), await run(undefined));
    await service.stop(runId);
    const manifest = await service.files.readManifest(runId), report = await service.analyze(runId);
    assert.equal(manifest.status, 'sealed'); assert.equal(manifest.durableSeq, manifest.lastAcceptedSeq);
    assert.equal(report.events, manifest.durableSeq); assert.deepEqual(report.integrity, []);
    assert.deepEqual(report.tools.map(tool => [tool.callId, tool.completed, tool.characters]), [['call-a', true, '{"text":"中文😀"}'.length]]);
    const directory = service.files.runPath(runId), payloads = await fs.readFile(path.join(directory, 'payloads.bin'));
    const index = (await fs.readFile(path.join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const received = index.filter(event => event.stage === 'transport.receive' && event.metadata.transport === 'http');
    let byteEnd = 0;
    const chunks = received.map(event => { assert.equal(event.metadata.byteStart, byteEnd); byteEnd = event.metadata.byteEnd;
      assert.equal(event.payload.length, event.metadata.byteEnd - event.metadata.byteStart);
      return payloads.subarray(event.payload.offset, event.payload.offset + event.payload.length); });
    assert.equal(byteEnd, raw.length); assert.deepEqual(Buffer.concat(chunks), raw);
    await service.close();
    const reopened = new DebugCaptureService(h.authority, h.binding, source);
    try { assert.equal(reopened.active(context), undefined); assert.deepEqual(await reopened.analyze(runId), report); }
    finally { await reopened.close(); }
  } finally { await service.close(); }
});

test('journal 只持久脱敏 metadata，并发 inspect 共享写入且 close 排完调用前队列', { timeout: 5_000 }, async () => {
  const gates = [], waiters = []; let gated = true;
  const journal = new kernel.ReliableDiagnosticJournal({ async validate(binding) {
    if (gated) { const gate = deferred(); gates.push(gate); for (const waiter of [...waiters]) if (gates.length >= waiter.count) waiter.resolve(); await gate.promise; }
    await h.authority.validate(binding);
  } }, h.binding);
  const waitFor = count => gates.length >= count ? Promise.resolve() : new Promise(resolve => waiters.push({ count, resolve }));
  const observe = (scope, count) => { for (let index = 0; index < count; index++) journal.observe({
    eventKind: 'agent.lifecycle', scopeKind: 'turn', scopeId: scope, correlationId: `${scope}-${index}`,
    metadata: { stage: 'tool_dispatch_completed', messageSeq: index, prompt: SECRET, output: SECRET, headers: { authorization: SECRET } }
  }); };
  try {
    observe('journal-before', 129); await waitFor(1);
    const first = journal.inspect({ scopeId: 'journal-before', limit: 200 }), second = journal.inspect({ scopeId: 'journal-before', limit: 200 });
    observe('journal-future-one', 140); assert.equal(gates.length, 1);
    gates[0].resolve(); await waitFor(2); observe('journal-future-two', 140);
    gates[1].resolve(); await waitFor(4); gates[2].resolve(); gates[3].resolve();
    const results = await Promise.all([first, second]);
    assert.ok(results.every(result => result.events.length === 129));
    assert.ok(results.every(result => result.state.persistedEvents === 256 && result.state.pendingEvents > 0));
    assert.ok(results.every(result => !JSON.stringify(result).includes(SECRET)));
    const closing = journal.close(); observe('journal-after-close', 3);
    journal.aggregate({ eventKind: 'feed.transient.flushed', counters: { rawEventCount: 9 } });
    gated = false; for (const gate of gates) gate.resolve(); await closing;
    const events = await h.events();
    assert.equal(events.filter(event => event.scopeId === 'journal-before').length, 129);
    assert.equal(events.filter(event => event.scopeId?.startsWith('journal-future')).length, 280);
    assert.equal(events.some(event => event.scopeId === 'journal-after-close'), false);
    assert.equal(JSON.stringify(events).includes(SECRET), false);
  } finally { gated = false; for (const gate of gates) gate.resolve(); await journal.close(); }
});

test('WAL 采样后真实 writer 锁与读事务快照保持，竞争窗口无法越过锁', { timeout: 5_000 }, async () => {
  const peers = await sqlitePeers(h.directory);
  const metrics = new RuntimeDiagnosticMetrics({ observe() {}, aggregate() {} }, { paths: { databasePath: peers.file } }, 'lock-host');
  try {
    await peers.inProcess('begin-write'); assert.match(await peers.otherProcess('write'), /^err SQLITE_BUSY/);
    assert.ok((await metrics.sampleWal()).walBytes > 0); assert.match(await peers.otherProcess('write'), /^err SQLITE_BUSY/);
    await peers.inProcess('commit'); assert.equal(await peers.otherProcess('write'), 'ok');
    assert.equal(await peers.inProcess('begin-read', 1), 'v1'); await metrics.sampleWal();
    assert.equal(await peers.otherProcess('set v2'), 'ok');
    assert.equal(JSON.parse(await peers.otherProcess('checkpoint')).busy, 1);
    assert.equal(await peers.otherProcess('set v3'), 'ok'); assert.equal(await peers.inProcess('read', 3), 'v1');
    await peers.inProcess('commit'); assert.equal(await peers.inProcess('read', 3), 'v3');
    await peers.inProcess('close');
    assert.deepEqual(peers.setup.prepare("SELECT v FROM t WHERE v IN ('A','B') ORDER BY id").all().map(row => row.v), ['A', 'B']);
  } finally { await metrics.close(); await peers.close(); }
});

test('关闭诊断时 hotpath 无计量，开启后窗口计数守恒且受控时钟自动脱敏落盘', async t => {
  const dependencies = diagnosticObserver => ({ diagnosticObserver,
    authorityCompiler: { async compile() { throw new Error('No model Turn in diagnostic wiring'); } }, resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('Unexpected MCP'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 20 }, filePath: 'unused' }; } },
    providers: { resolve() { throw new Error('Unexpected model'); } }, toolDispatcher: { definitions() { return []; }, async dispatch() { throw new Error('Unexpected tool'); } }
  });
  let app, journal, clock = Date.now();
  const conversation = id => repo('Conversation').insert({ id, title: SECRET, status: 'active', created_at: new Date(clock).toISOString(), updated_at: new Date(clock).toISOString() });
  try {
    app = await kernel.ReliableKernelApplication.open(h.authority, dependencies({ observe() {} }));
    assert.equal(app.database.performanceMetrics, undefined); await app.database.transaction([conversation('metrics-off')]);
    await app.close(); app = undefined;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    journal = new kernel.ReliableDiagnosticJournal(h.authority, h.binding, () => new Date(clock), { rollupWindowMs: 200 });
    app = await kernel.ReliableKernelApplication.open(h.authority, dependencies(journal));
    assert.ok(app.database.performanceMetrics); await app.database.transaction([conversation('metrics-on')]);
    for (let index = 0; index < 6; index++) journal.aggregate({ eventKind: 'feed.transient.flushed', scopeKind: 'feed_session', scopeId: 'metrics-session',
      dimensions: { conversationId: 'metrics-on' }, counters: { rawEventCount: 2, emittedEventCount: 1 }, durationMs: 3 });
    journal.aggregate({ eventKind: 'feed.transient.flushed', dimensions: { prompt: SECRET } });
    await app.close(); app = undefined;
    clock += 200; t.mock.timers.tick(200); clock += 750; t.mock.timers.tick(750);
    assert.ok(journal.flushPromise, 'the window and flush timers started persistence without inspect'); await journal.flushPromise;
    const events = await h.events(), summary = events.find(event => event.eventKind === 'feed.transient.flushed.summary' && event.scopeId === 'metrics-session');
    assert.ok(summary); assert.equal(summary.metadata.sampleCount, 6); assert.equal(summary.metadata.rawEventCount, 12);
    assert.equal(summary.metadata.emittedEventCount, 6); assert.equal(summary.metadata.totalMs, 18);
    assert.equal(summary.metadata.histogramMs.split(',').reduce((sum, bucket) => sum + Number(bucket.split(':')[1]), 0), 6);
    assert.ok(events.some(event => event.eventKind === 'database.request.summary' && event.metadata.requestKind === 'transaction'));
    assert.equal(JSON.stringify(events).includes(SECRET), false); assert.equal(JSON.stringify(events).includes(h.directory), false);
  } finally { await app?.close(); await journal?.close(); t.mock.timers.reset(); }
});

test('70k 行 Unicode diff 经实际 worker 物化，stats/hunk 准确且分页复用并让事件循环推进', async t => {
  const before = Array.from({ length: 70_000 }, (_, i) => `旧😀${i}`).join('\n'), after = Array.from({ length: 70_000 }, (_, i) => `新🚀${i}`).join('\n');
  const { store, base, target, reader } = await h.seedDiff(before, after), originalRead = store.read.bind(store);
  let reads = 0, progressed = false;
  t.mock.method(store, 'read', metadata => { if (metadata.id === base.id || metadata.id === target.id) reads += 1; return originalRead(metadata); });
  const read = offset => reader.read({ kind: 'file-change-diff', recordId: 'diff-member', offset, maxBytes: 65536 });
  const workersBefore = diffWorkers.length; setImmediate(() => { progressed = true; });
  const [first, concurrent] = await Promise.all([read(0), read(0)]);
  assert.deepEqual(concurrent, first); assert.equal(progressed, true); assert.equal(diffWorkers.length, workersBefore + 1);
  const chunks = [Buffer.from(first.chunk, 'base64')]; let detail = first;
  while (detail.hasMore) { detail = await read(detail.nextOffset); chunks.push(Buffer.from(detail.chunk, 'base64')); }
  const bytes = Buffer.concat(chunks); assert.equal(bytes.length, first.totalBytes);
  const result = JSON.parse(bytes.toString('utf8'));
  assert.equal(result.diff.added, 70_000); assert.equal(result.diff.removed, 70_000); assert.equal(result.diff.truncated, true);
  assert.match(result.diff.text, /@@ -1,70000 \+1,70000 @@/); assert.equal(result.diff.text.isWellFormed(), true);
  assert.equal(reads, 2); assert.equal(diffWorkers.length, workersBefore + 1);
});

test('永久过大与临时繁忙分类不同，实际 worker 失败回收准入后可继续预览', async () => {
  const pending = buildFileDiffRecordAsync('held.txt', 'x'.repeat(16 * 1024 * 1024 - 100), '', true);
  const rejected = assert.rejects(pending, /worker exited before returning/);
  await assert.rejects(buildFileDiffRecordAsync('busy.txt', 'x'.repeat(40_000), 'y', true), { code: 'file-diff-preview-busy', retryable: true });
  await assert.rejects(buildFileDiffRecordAsync('too-large.txt', 'x'.repeat(16 * 1024 * 1024 + 1), '', true), { code: 'file-diff-preview-too-large', retryable: false });
  await diffWorkers.at(-1).worker.terminate(); await rejected;
  const prefix = 'unchanged\n'.repeat(2500);
  const later = await buildFileDiffRecordAsync('later.txt', `${prefix}before\n`, `${prefix}after\n`, true);
  assert.equal(later.added, 1); assert.equal(later.removed, 1); assert.match(later.text, /-before\n\+after/);
  const posted = [], bridge = new kernel.ReliableKernelWebviewFeedBridge({}, { async read() { throw new FileDiffPreviewTooLargeError(); } });
  bridge.post = (_client, message) => posted.push(message);
  const client = { closed: false, ready: true, visible: true, navigationGeneration: 1, meta: { conversationId: 'diff-conversation' }, detailRequests: new Set() };
  await bridge.readDetail(client, { sessionId: 'session' }, { requestId: 'request', kind: 'file-change-diff', recordId: 'diff-member', offset: 0, maxBytes: 65536 });
  assert.equal(posted[0].code, 'file-diff-preview-too-large'); assert.equal(posted[0].retryable, false); assert.equal(client.detailRequests.size, 0);
});

test('运行输出分块刷新保留完整前缀，旧 session 迟到结果丢弃，失败后显式重试继续', async t => {
  const f = await createDetailStoreFixture(), { store } = f, kind = 'process-stdout', processId = 'mutable-process', key = `${kind}:${processId}`;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const prefix = '已完成🚀\n', frozen = `${prefix}first\nsecond\n`;
  try {
    store.details[key] = { status: 'ready', text: prefix, totalBytes: Buffer.byteLength(prefix) };
    store.refreshDetail(kind, processId, { priority: 'expanded' }); store.refreshDetail(kind, processId);
    const first = f.latest(); assert.equal(f.requests().length, 1); assert.equal(first.offset, Buffer.byteLength(prefix));
    f.reply(first, 'first\n', { totalBytes: Buffer.byteLength(frozen), hasMore: true });
    const continuation = f.latest(); assert.equal(continuation.requestId, first.requestId); assert.equal(continuation.expectedTotalBytes, Buffer.byteLength(frozen));
    assert.equal(store.details[key].text, prefix);
    f.reply(continuation, 'second\n', { totalBytes: Buffer.byteLength(frozen) });
    const trailing = f.latest(); assert.equal(f.requests().length, 3); assert.equal(store.details[key].text, frozen);
    f.replaceSession(); const replacement = f.latest(); assert.notEqual(replacement.sessionId, trailing.sessionId);
    f.reply(trailing, 'late old output\n'); assert.equal(store.details[key].text, frozen);
    f.fail(replacement, 'refresh unavailable'); assert.equal(store.details[key].status, 'ready'); assert.equal(store.details[key].text, frozen);
    assert.equal(store.details[key].refreshError, 'refresh unavailable');
    const requestsBefore = f.requests().length; store.refreshDetail(kind, processId); assert.equal(f.requests().length, requestsBefore);
    store.retryDetail(kind, processId, { priority: 'expanded' }); const retry = f.latest(); assert.equal(retry.offset, Buffer.byteLength(frozen));
    f.reply(retry, 'recovered✅\n'); assert.equal(store.details[key].text, `${frozen}recovered✅\n`);
    assert.equal(store.details[key].refreshError, undefined); assert.equal(Object.keys(store.pendingDetails).length, 0);
  } finally { store.$dispose(); t.mock.timers.reset(); await f.close(); }
});

test('实际 built extension 入口与 file-diff worker 的运行依赖可加载', async () => {
  const entry = loadBuiltEntry(); assert.equal(typeof entry.activate, 'function'); assert.equal(typeof entry.deactivate, 'function');
  const count = diffWorkers.length, prefix = `${'x'.repeat(17_000)}\n`;
  const result = await buildFileDiffRecordAsync('built-smoke.txt', `${prefix}before\n`, `${prefix}after\n`, true);
  assert.equal(diffWorkers.length, count + 1);
  assert.equal(diffWorkers.at(-1).filename, path.join(built, 'backend/capabilities/fileDiffWorker.js'));
  assert.equal(result.added, 1); assert.equal(result.removed, 1); assert.match(result.text, /-before\n\+after/);
});
