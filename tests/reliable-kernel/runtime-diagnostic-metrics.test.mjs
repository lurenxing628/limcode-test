import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));
const { RuntimeDiagnosticMetrics, SLOW_WRITE_LOCK_MS, WAL_GROWTH_ALERT_BYTES } = require(path.join(compiled, 'backend/reliableKernel/runtimeDiagnosticMetrics.js'));
const Database = require('better-sqlite3');
const SUMMARY_SCRIPT = path.resolve('scripts/reliable-kernel/summarize-runtime-diagnostics.mjs');
const repo = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
const SECRET = '禁止持久化的正文';

async function journalEvents(dataRootPath) {
  const directory = path.join(dataRootPath, 'diagnostics');
  const events = [];
  for (const name of ['events.3.jsonl', 'events.2.jsonl', 'events.1.jsonl', 'events.jsonl']) {
    let text;
    try { text = await fs.readFile(path.join(directory, name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) if (line) events.push(JSON.parse(line));
  }
  return events;
}

function conversation(id, title = id) {
  const now = new Date().toISOString();
  return repo('Conversation').insert({ id, title, status: 'active', created_at: now, updated_at: now });
}

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('高频诊断按窗口汇总：事件数有界、计数守恒、重要事件与脱敏规则不变', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-diagnostic-rollup-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  const journal = new kernel.ReliableDiagnosticJournal(authority, binding);
  try {
    for (let index = 0; index < 20_000; index += 1) {
      const session = `session-${index % 3}`;
      journal.aggregate({
        eventKind: 'feed.transient.flushed',
        scopeKind: 'feed_session',
        scopeId: session,
        dimensions: { conversationId: `conversation-${index % 2}` },
        counters: { rawEventCount: 3, emittedEventCount: 2, toolDeltaEventCount: index % 2 }
      });
      journal.aggregate({
        eventKind: 'feed.transient.acked',
        scopeKind: 'feed_session',
        scopeId: session,
        dimensions: { deliveryKind: 'batch' },
        durationMs: Math.floor(index / 3) % 100,
        counters: { headCount: 1 }
      });
      if (index % 5_000 === 0) {
        journal.observe({ eventKind: 'feed.transient.ack_timeout', scopeKind: 'feed_session', scopeId: session, metadata: { elapsedMs: 5_000 } });
      }
    }
    // Content-like keys are rejected instead of silently persisted.
    journal.aggregate({ eventKind: 'feed.transient.flushed', dimensions: { prompt: SECRET } });
    journal.aggregate({ eventKind: 'feed.transient.flushed', counters: { output: 1 } });
    journal.aggregate({ eventKind: 'feed.transient.acked', durationMs: -1 });

    const inspection = await journal.inspect({ limit: 200 });
    assert.equal(inspection.state.rollupKeys, 0, 'inspect persists the open window');
    assert.equal(inspection.state.rolledUpSamples, 40_000);
    assert.equal(inspection.state.droppedEvents, 3);
    assert.equal(inspection.bounds.maxRollupKeys, 256);
    assert.equal(inspection.bounds.rollupWindowMs, 5 * 60 * 1_000);

    const events = await journalEvents(binding.paths.dataRootPath);
    assert.ok(events.length <= 6 + 3 + 4, `40k samples persist as a handful of summaries, got ${events.length}`);
    assert.equal(events.filter((event) => event.eventKind === 'feed.transient.ack_timeout').length, 4, 'rare events stay individual');
    const flushed = events.filter((event) => event.eventKind === 'feed.transient.flushed.summary');
    assert.equal(flushed.length, 6, 'one rollup per session/conversation pair');
    assert.equal(flushed.reduce((sum, event) => sum + event.metadata.sampleCount, 0), 20_000);
    assert.equal(flushed.reduce((sum, event) => sum + event.metadata.rawEventCount, 0), 60_000);
    assert.equal(flushed.reduce((sum, event) => sum + event.metadata.toolDeltaEventCount, 0), 10_000);
    const acked = events.filter((event) => event.eventKind === 'feed.transient.acked.summary');
    assert.equal(acked.length, 3);
    for (const event of acked) {
      assert.equal(event.scopeKind, 'feed_session');
      assert.equal(event.metadata.deliveryKind, 'batch');
      assert.ok(event.metadata.sampleCount > 6_000);
      assert.equal(event.metadata.maxMs, 99);
      assert.equal(event.metadata.p50Ms, 50, 'p50 reports its bucket upper bound');
      assert.equal(event.metadata.p95Ms, 99, 'quantiles never exceed the exact maximum');
      const histogramTotal = event.metadata.histogramMs.split(',').reduce((sum, part) => sum + Number(part.split(':')[1]), 0);
      assert.equal(histogramTotal, event.metadata.sampleCount);
      assert.ok(Object.keys(event.metadata).length <= 16);
    }
    assert.doesNotMatch(JSON.stringify(events), new RegExp(SECRET));

    // A burst of distinct identities closes the window early; memory never holds more than 256 rollups.
    for (let index = 0; index < 1_000; index += 1) {
      journal.aggregate({ eventKind: 'feed.transient.flushed', scopeKind: 'feed_session', scopeId: `burst-${index}`, counters: { rawEventCount: 1 } });
      if (index % 100 === 99) await journal.flush();
    }
    for (let round = 0; round < 10; round += 1) await journal.flush();
    const early = (await journalEvents(binding.paths.dataRootPath)).filter((event) => event.metadata.sampleCount === 1 && event.scopeId?.startsWith('burst-'));
    assert.equal(early.length, 768, 'three full windows were persisted before inspect');
    await journal.inspect();
    const burst = (await journalEvents(binding.paths.dataRootPath)).filter((event) => event.scopeId?.startsWith('burst-'));
    assert.equal(burst.length, 1_000, 'no sample is lost when the key bound is reached');
  } finally {
    await journal.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('写锁等待、持锁、SQLITE_BUSY、CAS 发布、外部提交快照与 WAL 大小都按 Host 进入诊断且不含正文', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-runtime-diagnostic-metrics-'));
  const root = await kernel.resetCandidateRuntimeRoot(directory);
  const journal = new kernel.ReliableDiagnosticJournal(root.authority, root.binding);
  const metrics = new RuntimeDiagnosticMetrics(journal, root.binding, 'diagnostic-metrics');
  let database;
  let holder;
  let feed;
  try {
    database = await kernel.RuntimeDatabase.open(root.authority, { hostBootId: 'diagnostic-metrics', performanceMetrics: metrics });
    await database.transaction([conversation('diag-active', SECRET)]);

    // Another connection (another Extension Host in production) holds the writer lock briefly.
    holder = new Database(root.binding.paths.databasePath);
    holder.pragma('busy_timeout = 5000');
    holder.exec('BEGIN IMMEDIATE');
    const waiting = database.transaction([conversation('diag-waited', SECRET)]);
    await new Promise((resolve) => setTimeout(resolve, SLOW_WRITE_LOCK_MS + 150));
    holder.exec('COMMIT');
    await waiting;
    // The slow writer lock is an anomaly: the open rollup window is persisted right away rather
    // than after five minutes, so a crash soon after cannot lose the surrounding context.
    for (let round = 0; round < 5; round += 1) await journal.flush();
    const early = await journalEvents(root.binding.paths.dataRootPath);
    assert.ok(early.some((event) => event.eventKind === 'database.request.summary'
      && event.metadata.hostBootId === 'diagnostic-metrics'), 'anomaly persisted the open window');

    // Holding it past busy_timeout=5000 surfaces SQLITE_BUSY at BEGIN IMMEDIATE.
    holder.exec('BEGIN IMMEDIATE');
    await assert.rejects(database.transaction([conversation('diag-busy', SECRET)]), (error) => {
      assert.match(`${error.code ?? ''} ${error.message}`, /SQLITE_BUSY|database is locked/);
      return true;
    });
    holder.exec('ROLLBACK');

    // CAS: a miss publishes durably (temp write + file fsync + directory fsyncs), a repeat is a hit.
    const cas = new kernel.ContentAddressedStore(root.authority, root.binding);
    await cas.ingest(database, SECRET, 'text/plain');
    await cas.ingest(database, SECRET, 'text/plain');

    // Client Feed: initial snapshot, then a commit from the other connection forces a full snapshot.
    feed = new kernel.BoundedClientFeed(database);
    const received = [];
    const connection = await feed.connect({ activeConversationId: 'diag-active', send: (message) => received.push(message) });
    const ack = () => feed.acknowledge({ sessionId: connection.sessionId, hostBootId: connection.hostBootId, messageSeq: received.at(-1).messageSeq });
    ack();
    const now = new Date().toISOString();
    holder.prepare('INSERT INTO conversation (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('other-project', SECRET, 'active', now, now);
    await waitFor(() => received.length >= 2, 'external commit snapshot');
    ack();
    feed.requestSnapshot(connection.sessionId, 'diag-active');
    await waitFor(() => received.length >= 3, 'client requested snapshot');
    ack();
    feed.close();
    feed = undefined;
    await database.close();
    database = undefined;

    // WAL sampling only stat()s the -wal file.
    const sample = await metrics.sampleWal();
    assert.deepEqual(Object.keys(sample), ['walBytes']);
    assert.ok(sample.walBytes > 0);

    holder.close();
    holder = undefined;
    await metrics.close();
    await journal.close();

    const events = await journalEvents(root.binding.paths.dataRootPath);
    const raw = JSON.stringify(events);
    assert.doesNotMatch(raw, new RegExp(SECRET), 'diagnostics never carry titles or bodies');
    assert.equal(raw.includes(directory), false, 'diagnostics never carry paths');

    const slow = events.filter((event) => event.eventKind === 'database.write_lock.slow');
    assert.ok(slow.some((event) => event.metadata.requestKind === 'transaction'
      && event.metadata.domain === 'Conversation'
      && event.metadata.status === 'ok'
      && event.metadata.lockWaitMs >= SLOW_WRITE_LOCK_MS), JSON.stringify(slow));
    const busy = events.filter((event) => event.eventKind === 'database.busy');
    assert.equal(busy.length, 1);
    assert.equal(busy[0].metadata.requestKind, 'transaction');
    assert.equal(busy[0].metadata.stage, 'begin', 'the failure happened while waiting for the writer lock');
    assert.equal(busy[0].metadata.domain, 'Conversation');
    assert.match(busy[0].metadata.reasonCode, /^SQLITE_BUSY/);
    assert.ok(busy[0].metadata.lockWaitMs >= 4_500);
    const busySummary = events.filter((event) => event.eventKind === 'database.busy.summary');
    assert.equal(busySummary.reduce((sum, event) => sum + event.metadata.sampleCount, 0), 1);

    const waits = events.filter((event) => event.eventKind === 'database.write_lock_wait.summary' && event.metadata.requestKind === 'transaction');
    const waitCount = waits.reduce((sum, event) => sum + event.metadata.sampleCount, 0);
    assert.ok(waitCount >= 3);
    assert.ok(waits.some((event) => event.metadata.maxMs >= 4_500));
    const holds = events.filter((event) => event.eventKind === 'database.write_lock_hold.summary' && event.metadata.requestKind === 'transaction');
    assert.equal(holds.reduce((sum, event) => sum + event.metadata.sampleCount, 0), waitCount - 1, 'a lock never acquired has no hold time');
    assert.ok(events.some((event) => event.eventKind === 'database.request.summary'
      && event.metadata.requestKind === 'transaction' && event.metadata.status === 'error'));
    assert.ok(events.some((event) => event.eventKind === 'database.queue_wait.summary'));

    const snapshots = Object.fromEntries(events.filter((event) => event.eventKind === 'feed.snapshot.summary')
      .map((event) => [event.metadata.reasonCode, event.metadata]));
    for (const reason of ['initial', 'external_commit', 'client_request']) {
      assert.equal(snapshots[reason]?.sampleCount, 1, `snapshot reason ${reason}`);
      assert.ok(snapshots[reason].bytes > 0);
    }
    const changes = events.filter((event) => event.eventKind === 'feed.external_change.summary');
    assert.ok(changes.reduce((sum, event) => sum + event.metadata.sampleCount, 0) >= 1);
    assert.equal(changes[0].metadata.sessionCount, 1);
    const wal = events.filter((event) => event.eventKind === 'database.wal');
    assert.equal(wal.length, 1, 'WAL samples are reported at most every five minutes unless the log keeps growing');
    assert.ok(wal[0].metadata.walBytes > 0);
    const casSummary = events.filter((event) => event.eventKind === 'cas.prepare.summary');
    const casTotal = (field) => casSummary.reduce((sum, event) => sum + (event.metadata[field] ?? 0), 0);
    assert.equal(casTotal('sampleCount'), 2);
    assert.equal(casTotal('lookupMisses'), 1);
    assert.equal(casTotal('lookupHits'), 1);
    assert.equal(casTotal('publishes'), 1);
    assert.equal(casTotal('fileFsyncs'), 1);
    assert.ok(casTotal('directoryFsyncs') >= 1);
    assert.equal(casSummary[0].metadata.operation, 'prepare');
    // Several Hosts append to one journal: every Runtime rollup and anomaly names its Host.
    const runtimeEvents = events.filter((event) => /^(database|cas|feed\.snapshot|feed\.external_change)\./.test(event.eventKind));
    assert.ok(runtimeEvents.length > 10);
    for (const event of runtimeEvents) assert.equal(event.metadata.hostBootId, 'diagnostic-metrics', event.eventKind);

    // The shipped summary script reads the same journal.
    const report = JSON.parse(childProcess.execFileSync(process.execPath, [SUMMARY_SCRIPT, '--json', root.binding.paths.dataRootPath], { encoding: 'utf8' }));
    assert.equal(report.feedSnapshots.total.count, 3);
    assert.equal(report.feedSnapshots.externalCommitCountSharePercent, 33.33);
    assert.equal(report.writeLockWaitMs.transaction.count, waitCount);
    assert.ok(report.writeLockWaitMs.transaction.maxMs >= 4_500);
    assert.equal(report.busy.total, 1);
    assert.ok(report.slowWriteLocks.persisted >= 1);
    assert.equal(report.wal.samples, 1);
    assert.equal(report.casPrepare.prepare.publishes, 1);
    assert.ok(report.databaseRequestMs.clientProjectionSnapshot.count >= 2, 'read requests are listed per requestKind');
    assert.equal(report.databaseRequestErrors.transaction, 1);
    assert.equal(report.hosts['diagnostic-metrics'].feedSnapshots.total.count, 3);
    assert.equal(report.hosts['diagnostic-metrics'].busy.total, 1);
  } finally {
    feed?.close();
    holder?.close();
    await database?.close();
    await metrics.close();
    await journal.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('只有支持汇总的诊断观察者才会为产品 Runtime 打开计量', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-runtime-diagnostic-wiring-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  const dependencies = (diagnosticObserver) => ({
    authorityCompiler: { async compile() { throw new Error('no Turn in this fixture'); } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('unexpected MCP call'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
    providers: { resolve() { throw new Error('no provider request in this fixture'); } },
    toolDispatcher: { definitions() { return []; }, async dispatch() { throw new Error('no tools in this fixture'); } },
    diagnosticObserver
  });
  let app;
  try {
    app = await kernel.ReliableKernelApplication.open(authority, dependencies({ observe() {} }));
    assert.equal(app.database.performanceMetrics, undefined, 'an observe-only observer keeps the hot path uninstrumented');
    await app.close();
    app = undefined;

    const journal = new kernel.ReliableDiagnosticJournal(authority, binding);
    app = await kernel.ReliableKernelApplication.open(authority, dependencies(journal));
    assert.notEqual(app.database.performanceMetrics, undefined);
    await app.database.transaction([conversation('wired', SECRET)]);
    await app.close();
    app = undefined;
    await journal.close();
    const events = await journalEvents(binding.paths.dataRootPath);
    assert.ok(events.some((event) => event.eventKind === 'database.request.summary'
      && event.metadata.requestKind === 'transaction' && event.metadata.status === 'ok'));
    assert.ok(events.some((event) => event.eventKind === 'database.write_lock_wait.summary'));
    assert.doesNotMatch(JSON.stringify(events), new RegExp(SECRET));
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('WAL 采样只 stat 文件大小：五分钟一报，超过上限且仍在增长时立即告警并按分钟限速写出汇总窗口', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-diagnostic-wal-'));
  const databasePath = path.join(directory, 'limcode.sqlite');
  const walPath = `${databasePath}-wal`;
  await fs.writeFile(walPath, Buffer.alloc(1_024));
  const observed = [];
  let emitted = 0;
  let nowMs = 0;
  const metrics = new RuntimeDiagnosticMetrics(
    { observe: (event) => observed.push(event), aggregate() {}, emitAggregates: () => { emitted += 1; } },
    { paths: { databasePath } },
    'wal-host',
    () => nowMs
  );
  try {
    assert.deepEqual(await metrics.sampleWal(), { walBytes: 1_024 });
    assert.deepEqual(observed.map((event) => [event.eventKind, event.metadata]), [['database.wal', { hostBootId: 'wal-host', walBytes: 1_024 }]]);
    const grow = async (atMs, bytes) => { nowMs = atMs; await fs.truncate(walPath, bytes); return metrics.sampleWal(); };
    await grow(60_000, WAL_GROWTH_ALERT_BYTES + 1);
    assert.equal(observed.at(-1).eventKind, 'database.wal.growing');
    assert.equal(emitted, 1, 'a growing WAL persists the open rollup window');
    await grow(80_000, WAL_GROWTH_ALERT_BYTES + 1);
    assert.equal(observed.length, 2, 'a large but stable high-water mark is not re-alerted');
    await grow(100_000, WAL_GROWTH_ALERT_BYTES + 2);
    assert.equal(observed.at(-1).eventKind, 'database.wal.growing');
    assert.equal(emitted, 1, 'early rollup persistence is limited to once a minute');
    await grow(200_000, WAL_GROWTH_ALERT_BYTES + 3);
    assert.equal(emitted, 2);
    nowMs = 600_000;
    await metrics.sampleWal();
    assert.equal(observed.at(-1).eventKind, 'database.wal', 'the periodic report resumes after five minutes');
    await assert.rejects(fs.stat(`${databasePath}-shm`), { code: 'ENOENT' });
  } finally {
    await metrics.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('Feed 全量快照记录七种原因，读取期间到来的请求原因留给下一次快照', async () => {
  // A real projection shape, then a scripted database so each reason is triggered exactly once.
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-feed-snapshot-reasons-'));
  const root = await kernel.resetCandidateRuntimeRoot(directory);
  const real = await kernel.RuntimeDatabase.open(root.authority, { hostBootId: 'feed-reasons' });
  await real.transaction([conversation('diag-active')]);
  const { snapshot } = await real.clientProjectionSnapshot('diag-active');
  await real.close();
  await fs.rm(directory, { recursive: true, force: true });

  const recorded = [];
  let version = '1';
  let commit;
  let pendingRead;
  const database = {
    hostBootId: 'feed-reasons',
    performanceMetrics: { record() {} },
    recordPerformanceMetric: (event) => recorded.push(event),
    async externalDataVersion() { return version; },
    async clientProjectionSnapshotAndSubscribe(_conversationId, listener) {
      commit = listener;
      return { barrier: { snapshotCommitSeq: '1', snapshot }, unsubscribe() {} };
    },
    async clientProjectionSnapshot() {
      if (pendingRead) await pendingRead.promise;
      return { snapshotCommitSeq: '1', snapshot };
    },
    // Task-card probe for a tool call outside the loaded window.
    async snapshot(reads) {
      return {
        snapshotCommitSeq: '1',
        snapshot: reads.map((read) => read.domain === 'ToolCall'
          ? { id: read.id, tool_name: 'update_task_list', turn_id: 'turn-task' }
          : read.domain === 'Turn' ? { id: read.id, conversation_id: 'diag-active' } : null)
      };
    }
  };
  const feed = new kernel.BoundedClientFeed(database);
  const received = [];
  const reasons = () => recorded.filter((event) => event.kind === 'client_feed.snapshot').map((event) => event.reason);
  const removals = (prefix, count) => Array.from({ length: count }, (_value, index) => ({ domain: 'Conversation', kind: 'remove', id: `${prefix}-${index}` }));
  let commitSeq = 1;
  const push = (changes) => commit({ commitSeq: String(++commitSeq), changes, allocatedSequences: [] });
  try {
    const connection = await feed.connect({ activeConversationId: 'diag-active', send: (message) => received.push(message) });
    const ack = () => feed.acknowledge({ sessionId: connection.sessionId, hostBootId: connection.hostBootId, messageSeq: received.at(-1).messageSeq });
    assert.deepEqual(reasons(), ['initial']);

    // The initial frame is still unacknowledged: batches that cannot be compacted overflow the queue.
    for (let index = 0; index < 9; index += 1) push(removals(`queued-${index}`, 400));
    ack();
    await waitFor(() => reasons().length === 2, 'queue_limit snapshot');
    ack();
    push(removals('batch', 501));
    await waitFor(() => reasons().length === 3, 'change_batch_limit snapshot');
    ack();
    push([{ domain: 'Message', kind: 'remove', id: 'message-removed' }]);
    await waitFor(() => reasons().length === 4, 'commit_scope snapshot');
    ack();
    push([{ domain: 'Operation', kind: 'upsert', id: 'operation-task', record: { id: 'operation-task', tool_call_id: 'call-task', status: 'succeeded' } }]);
    await waitFor(() => reasons().length === 5, 'task_candidate snapshot');
    ack();
    feed.requestSnapshot(connection.sessionId, 'diag-active');
    await waitFor(() => reasons().length === 6, 'client_request snapshot');
    ack();

    // An external commit discovered while a snapshot is being read is kept for the next snapshot.
    let release;
    pendingRead = { promise: new Promise((resolve) => { release = resolve; }) };
    feed.requestSnapshot(connection.sessionId, 'diag-active');
    version = '2';
    await waitFor(() => recorded.some((event) => event.kind === 'client_feed.external_change'), 'external change detection', 3_000);
    pendingRead = undefined;
    release();
    await waitFor(() => reasons().length === 7, 'snapshot requested before the external commit');
    ack();
    await waitFor(() => reasons().length === 8, 'snapshot for the external commit');
    ack();

    assert.deepEqual(reasons(), [
      'initial', 'queue_limit', 'change_batch_limit', 'commit_scope', 'task_candidate', 'client_request', 'client_request', 'external_commit'
    ]);
    for (const event of recorded.filter((entry) => entry.kind === 'client_feed.snapshot')) {
      assert.ok(event.bytes > 0);
      assert.ok(event.durationMs >= 0);
    }
    assert.deepEqual(recorded.filter((event) => event.kind === 'client_feed.external_change').map((event) => event.sessionCount), [1]);
  } finally {
    feed.close();
  }
});

test('快照读取期间到来、需要全量快照的本 Host 提交，下一次快照记为提交超出增量范围', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-feed-buffered-reason-'));
  const root = await kernel.resetCandidateRuntimeRoot(directory);
  const real = await kernel.RuntimeDatabase.open(root.authority, { hostBootId: 'feed-buffered' });
  await real.transaction([conversation('diag-active')]);
  const { snapshot } = await real.clientProjectionSnapshot('diag-active');
  await real.close();
  await fs.rm(directory, { recursive: true, force: true });

  const recorded = [];
  let commit;
  let pendingRead;
  let readStarted = false;
  const database = {
    hostBootId: 'feed-buffered',
    performanceMetrics: { record() {} },
    recordPerformanceMetric: (event) => recorded.push(event),
    async externalDataVersion() { return '1'; },
    async clientProjectionSnapshotAndSubscribe(_conversationId, listener) {
      commit = listener;
      return { barrier: { snapshotCommitSeq: '1', snapshot }, unsubscribe() {} };
    },
    async clientProjectionSnapshot() {
      readStarted = true;
      if (pendingRead) await pendingRead.promise;
      return { snapshotCommitSeq: '1', snapshot };
    },
    async snapshot(reads) { return { snapshotCommitSeq: '1', snapshot: reads.map(() => null) }; }
  };
  const feed = new kernel.BoundedClientFeed(database);
  const received = [];
  const reasons = () => recorded.filter((event) => event.kind === 'client_feed.snapshot').map((event) => event.reason);
  try {
    const connection = await feed.connect({ activeConversationId: 'diag-active', send: (message) => received.push(message) });
    const ack = () => feed.acknowledge({ sessionId: connection.sessionId, hostBootId: connection.hostBootId, messageSeq: received.at(-1).messageSeq });
    ack();
    let release;
    pendingRead = { promise: new Promise((resolve) => { release = resolve; }) };
    feed.requestSnapshot(connection.sessionId, 'diag-active');
    await waitFor(() => readStarted, 'snapshot read in progress');
    // Deleting a message cannot be sent as changes; it lands while the requested snapshot is read.
    commit({ commitSeq: '2', changes: [{ domain: 'Message', kind: 'remove', id: 'message-removed' }], allocatedSequences: [] });
    pendingRead = undefined;
    release();
    await waitFor(() => reasons().length === 2, 'requested snapshot');
    ack();
    await waitFor(() => reasons().length === 3, 'snapshot for the commit replayed after the read');
    ack();
    assert.deepEqual(reasons(), ['initial', 'client_request', 'commit_scope']);
  } finally {
    feed.close();
  }
});

test('本 Host 自己的提交只走增量，不会被记成外部提交', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-feed-local-commits-'));
  const root = await kernel.resetCandidateRuntimeRoot(directory);
  const recorded = [];
  const database = await kernel.RuntimeDatabase.open(root.authority, { hostBootId: 'feed-local', performanceMetrics: { record: (event) => recorded.push(event) } });
  let feed;
  let holder;
  try {
    await database.transaction([conversation('diag-active')]);
    feed = new kernel.BoundedClientFeed(database);
    const received = [];
    const connection = await feed.connect({ activeConversationId: 'diag-active', send: (message) => received.push(message) });
    const ack = () => feed.acknowledge({ sessionId: connection.sessionId, hostBootId: connection.hostBootId, messageSeq: received.at(-1).messageSeq });
    ack();
    for (let index = 0; index < 3; index += 1) {
      await database.transaction([conversation(`local-${index}`)]);
      await waitFor(() => received.length === index + 2, `local changes ${index}`);
      ack();
    }
    // Longer than the one-second external poll.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal(recorded.filter((event) => event.kind === 'client_feed.external_change').length, 0);
    assert.deepEqual(recorded.filter((event) => event.kind === 'client_feed.snapshot').map((event) => event.reason), ['initial']);

    // Positive control: a commit through another connection is external.
    holder = new Database(root.binding.paths.databasePath);
    const now = new Date().toISOString();
    holder.prepare('INSERT INTO conversation (id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('other-host', 'other', 'active', now, now);
    await waitFor(() => recorded.some((event) => event.kind === 'client_feed.snapshot' && event.reason === 'external_commit'), 'external commit snapshot', 3_000);
    assert.equal(recorded.filter((event) => event.kind === 'client_feed.external_change').length, 1);
  } finally {
    feed?.close();
    holder?.close();
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('汇总窗口到期后由定时器落盘，不依赖 inspect 或关闭', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-diagnostic-rollup-timer-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  const journal = new kernel.ReliableDiagnosticJournal(authority, binding, undefined, { rollupWindowMs: 200 });
  try {
    journal.aggregate({ eventKind: 'database.request', scopeKind: 'runtime', dimensions: { hostBootId: 'timer-host', requestKind: 'transaction' }, durationMs: 3 });
    const deadline = Date.now() + 5_000;
    let persisted = [];
    while (Date.now() < deadline) {
      persisted = (await journalEvents(binding.paths.dataRootPath)).filter((event) => event.eventKind === 'database.request.summary');
      if (persisted.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(persisted.length, 1, 'the window timer plus the 750ms flush persisted the rollup');
    assert.equal(persisted[0].metadata.sampleCount, 1);
    assert.equal(persisted[0].metadata.hostBootId, 'timer-host');
  } finally {
    await journal.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('计量开启时畸形事务步骤只让该请求失败，不会让数据库 worker 崩溃', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-diagnostic-malformed-step-'));
  const root = await kernel.resetCandidateRuntimeRoot(directory);
  const database = await kernel.RuntimeDatabase.open(root.authority, { hostBootId: 'malformed', performanceMetrics: { record() {} } });
  try {
    for (const steps of [[null], [{ kind: 7 }], [{ kind: 'savepoint', steps: [null, { kind: null }, 'text'] }], [{}]]) {
      await assert.rejects(database.transaction(steps));
      await database.inspect();
    }
    await database.transaction([conversation('still-writable')]);
  } finally {
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('汇总脚本跳过坏行与缺 metadata 的行，默认只统计 7 天保留期', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-diagnostic-summary-script-'));
  const line = (observedAt, eventKind, metadata) => JSON.stringify({
    schema: 'limcode-reliable-diagnostic', id: `diagnostic-${eventKind}-${observedAt}`, eventKind, observedAt,
    ...(metadata === undefined ? {} : { metadata })
  });
  const recent = new Date().toISOString();
  const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString();
  await fs.writeFile(path.join(directory, 'events.jsonl'), [
    '{"torn":',
    line(recent, 'database.busy'),
    line(recent, 'feed.snapshot.summary', null),
    line(recent, 'feed.snapshot.summary', { hostBootId: 'host-a', reasonCode: 'external_commit', sampleCount: 2, bytes: 10 }),
    line(stale, 'feed.snapshot.summary', { hostBootId: 'host-b', reasonCode: 'initial', sampleCount: 5, bytes: 50 }),
    line('not-a-date', 'database.wal', { walBytes: 1 })
  ].join('\n') + '\n');
  try {
    const run = (...flags) => JSON.parse(childProcess.execFileSync(process.execPath, [SUMMARY_SCRIPT, '--json', ...flags, directory], { encoding: 'utf8' }));
    const current = run();
    assert.equal(current.coverage.skippedLines, 2);
    assert.equal(current.coverage.events, 3);
    assert.equal(current.feedSnapshots.total.count, 2);
    assert.equal(current.feedSnapshots.externalCommitCountSharePercent, 100);
    assert.equal(current.busy.samples.length, 1);
    assert.deepEqual(Object.keys(current.hosts), ['host-a']);
    const everything = run('--all');
    assert.equal(everything.feedSnapshots.total.count, 7);
    assert.deepEqual(Object.keys(everything.hosts), ['host-a', 'host-b']);
    assert.equal(everything.hosts['host-b'].feedSnapshots.byReason.initial.count, 5);
    // The human-readable report must not crash on the same input.
    const text = childProcess.execFileSync(process.execPath, [SUMMARY_SCRIPT, directory], { encoding: 'utf8' });
    assert.match(text, /外部提交引起/);
    assert.match(text, /ExternalDataVersionWatcher/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
