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
const { RuntimeDiagnosticMetrics, SLOW_WRITE_LOCK_MS } = require(path.join(compiled, 'backend/reliableKernel/runtimeDiagnosticMetrics.js'));
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

test('写锁等待、持锁、SQLITE_BUSY、外部提交快照与 WAL 积压都进入诊断且不含正文', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-runtime-diagnostic-metrics-'));
  const root = await kernel.resetCandidateRuntimeRoot(directory);
  const journal = new kernel.ReliableDiagnosticJournal(root.authority, root.binding);
  const metrics = new RuntimeDiagnosticMetrics(journal, root.binding);
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

    // Holding it past busy_timeout=5000 surfaces SQLITE_BUSY at BEGIN IMMEDIATE.
    holder.exec('BEGIN IMMEDIATE');
    await assert.rejects(database.transaction([conversation('diag-busy', SECRET)]), (error) => {
      assert.match(`${error.code ?? ''} ${error.message}`, /SQLITE_BUSY|database is locked/);
      return true;
    });
    holder.exec('ROLLBACK');

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

    // WAL-index counters match SQLite's own checkpoint report (no other writer is left).
    const before = await metrics.sampleWal();
    assert.ok(before.walBytes > 0);
    assert.ok(before.walFrames > 0);
    const [checkpoint] = holder.pragma('wal_checkpoint(PASSIVE)');
    assert.equal(before.walFrames, checkpoint.log);
    const after = await metrics.sampleWal();
    assert.equal(after.checkpointedFrames, checkpoint.checkpointed);
    assert.equal(after.pendingFrames, checkpoint.log - checkpoint.checkpointed);

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
    assert.equal(wal.length, 1, 'WAL samples are reported at most every five minutes unless checkpoints lag');
    assert.ok(wal[0].metadata.walBytes > 0);

    // The shipped summary script reads the same journal.
    const report = JSON.parse(childProcess.execFileSync(process.execPath, [SUMMARY_SCRIPT, '--json', root.binding.paths.dataRootPath], { encoding: 'utf8' }));
    assert.equal(report.feedSnapshots.total.count, 3);
    assert.equal(report.feedSnapshots.externalCommitCountSharePercent, 33.33);
    assert.equal(report.writeLockWaitMs.transaction.count, waitCount);
    assert.ok(report.writeLockWaitMs.transaction.maxMs >= 4_500);
    assert.equal(report.busy.total, 1);
    assert.ok(report.slowWriteLocks.persisted >= 1);
    assert.equal(report.wal.samples, 1);
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
