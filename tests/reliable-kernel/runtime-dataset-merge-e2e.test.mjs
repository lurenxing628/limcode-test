// End to end: a source left by a crashed old window is finalized and
// merged online into a live, fully composed target Runtime; no Provider call may follow.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { openFullRuntime, kernel } from './runtime-dataset-merge-full-runtime.mjs';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const Database = require('better-sqlite3');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { mergeHistoricalDataSetsOnline, MERGE_FINALIZATION_REASON } = kernelFile('runtimeDataSetMerge.js');
const { createConversationRuntimeWorkProbe } = kernelFile('conversationRuntimePendingWork.js');
const {
  resolveVscodeRuntimeDataRoot, resolveVscodeWorkspaceRuntimeScope, resolveVscodeWorkspaceRuntimeScopeRoot, selectVscodeRuntimeDataSet
} = kernelFile('vscodeRootAuthority.js');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function crashedFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-merge-e2e-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = { globalStoragePath: root };
  const settingsRoot = path.join(root, '..', `${path.basename(root)}-settings`);
  t.after(() => fs.rm(settingsRoot, { recursive: true, force: true }));
  const target = await initialize(root, 'default');
  const source = await initializeScope(paths, 'alpha');
  await selectVscodeRuntimeDataSet(paths, 'default');
  const readyFile = path.join(root, '..', `${path.basename(root)}-ready.json`);
  t.after(() => fs.rm(readyFile, { force: true }));
  const child = execFile(process.execPath, [path.join(HERE, 'runtime-dataset-merge-crash-child.mjs'), source.scopeRoot, settingsRoot, readyFile],
    { env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled } });
  let childStderr = '';
  child.stderr.on('data', (chunk) => { childStderr += chunk; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 90_000;
  while (!(await fs.stat(readyFile).then(() => true, () => false))) {
    if (Date.now() > deadline || child.exitCode !== null) assert.fail(`crash child never became ready: ${childStderr}`);
    await sleep(50);
  }
  child.kill('SIGKILL');
  assert.equal((await exited).signal, 'SIGKILL');
  return { root, paths, settingsRoot, target, source };
}

test('对照：不合并、直接打开崩溃留下的来源库，启动恢复会继续 Turn 并调用 Provider（证明本夹具能观察到自动执行）', { timeout: 180_000 }, async (t) => {
  const { settingsRoot, source } = await crashedFixture(t);
  const opened = await openFullRuntime({ authority: source.authority, settingsRoot, hostLabel: 'source', async send(_request, controls) {
    await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: 'resumed' }] } });
  } });
  try {
    await opened.startupRecovery();
    const deadline = Date.now() + 20_000;
    while (opened.calls.length === 0 && Date.now() < deadline) await sleep(50);
    t.diagnostic(`control provider calls: ${opened.calls.length}`);
    assert.ok(opened.calls.length >= 1, 'startup recovery resumes the crashed Turn');
  } finally { await opened.close(); }
});

test('E2E 崩溃旧窗口留下的进行中 Turn（流式到一半）+ 排队消息：收尾后在线并入正在运行的当前库，Provider 调用始终为 0', { timeout: 180_000 }, async (t) => {
  const { root, paths, settingsRoot, target, source } = await crashedFixture(t);
  const before = inspect(source.binding.paths.databasePath);
  t.diagnostic(`source after crash: ${JSON.stringify(before)}`);
  assert.equal(before.activeTurns, 1);
  assert.equal(before.leases, 1);
  assert.equal(before.queuedIntents, 1);
  assert.ok(before.nonTerminalRequests >= 1);
  assert.equal(before.busy, true, 'the kernel itself sees the crashed conversation as busy');

  // 2. The current library runs in a fully composed window.
  const live = await openFullRuntime({ authority: target.authority, settingsRoot, hostLabel: 'current', async send() {
    throw new Error('no model call may happen after a merge');
  } });
  try {
    await live.startupRecovery();
    const report = await mergeHistoricalDataSetsOnline(paths, { configurationRootPath: root, database: live.app.database });
    t.diagnostic(`merge report: ${JSON.stringify({ merged: report.merged.map((item) => ({ finalized: item.finalized, inserted: item.insertedRows })),
      blocked: report.blocked, failures: report.failures, deferred: report.deferred })}`);
    assert.deepEqual([report.failures, report.blocked, report.deferred], [[], [], []]);
    assert.equal(report.merged.length, 1);
    assert.deepEqual([report.merged[0].finalized?.turns, report.merged[0].finalized?.intents], [1, 1]);
    // External-commit convergence, a rescan and a view takeover of the merged conversation.
    await live.app.refreshExternalRuntimeWork();
    await live.runner.recoverStartup();
    await live.coordinator.recoverStartup();
    await sleep(3_000);
    await live.runner.waitForIdle();
    assert.deepEqual(live.calls, [], 'no Provider call in the live window');
  } finally {
    await live.close();
  }
  // 3. Reopen the current library as a fresh Host: full startup recovery.
  const reopened = await openFullRuntime({ authority: target.authority, settingsRoot, hostLabel: 'reopened', async send() {
    throw new Error('no model call may happen after a merge');
  } });
  try {
    const recovery = await reopened.startupRecovery();
    await sleep(3_000);
    await reopened.runner.waitForIdle();
    assert.deepEqual(reopened.calls, [], 'no Provider call after reopening');
    assert.deepEqual(recovery.runnerReport.resumedTurnIds, []);
    assert.deepEqual(recovery.runnerReport.queuedConversationIds, []);
  } finally {
    await reopened.close();
  }
  const after = inspect(target.binding.paths.databasePath);
  t.diagnostic(`target after merge: ${JSON.stringify(after)}`);
  assert.deepEqual([after.activeTurns, after.leases, after.queuedIntents, after.nonTerminalRequests, after.busy], [0, 0, 0, 0, false]);
  // The finalized request's retained stream checkpoints came along as historical copies with it.
  const merged = inspect(source.binding.paths.databasePath);
  assert.ok(merged.checkpoints > 0, 'the source keeps stream checkpoints of the finalized request');
  assert.equal(after.checkpoints, merged.checkpoints);
  assert.ok(after.reasons.includes(MERGE_FINALIZATION_REASON));
});

function inspect(databasePath) {
  const database = new Database(databasePath, { readonly: true });
  try {
    database.defaultSafeIntegers(false);
    const count = (sql) => database.prepare(sql).pluck().get();
    return {
      activeTurns: count("SELECT COUNT(*) FROM turn WHERE status = 'active'"),
      leases: count('SELECT COUNT(*) FROM execution_lease'),
      queuedIntents: count("SELECT COUNT(*) FROM turn_intent WHERE state = 'queued'"),
      nonTerminalRequests: count("SELECT COUNT(*) FROM model_request WHERE status <> 'terminal'"),
      requestStates: database.prepare('SELECT status, terminal_state FROM model_request ORDER BY request_seq').raw().all(),
      checkpoints: count('SELECT COUNT(*) FROM model_stream_checkpoint'),
      reasons: database.prepare('SELECT terminal_status || \':\' || reason FROM turn_termination').pluck().all().join(' | '),
      busy: createConversationRuntimeWorkProbe(database)('crash_conversation')
    };
  } finally { database.close(); }
}

async function initializeScope(paths, name) {
  const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: [`file:///workspace/${name}`] });
  const scopeRoot = resolveVscodeWorkspaceRuntimeScopeRoot(paths, scope);
  await fs.mkdir(scopeRoot, { recursive: true });
  return initialize(scopeRoot, `workspace:${scope.key}`);
}

async function initialize(scopeRoot, id) {
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  return { id, scopeRoot, authority, binding };
}
