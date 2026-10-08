import { registerPendingHistory } from './fixtures/runtime-merge-fixture.mjs';
import { publishInitialRuntimeSelection } from './fixtures/runtime-selection.mjs';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { removeConfigurationRoot } from './fixtures/runtime-merge-fixture.mjs';

// Merge state as the management UI sees it: merge targets that no longer exist, the last merge
// retaining inserted provenance after partial merges, and convergence of old kept sources.
const require = createRequire(import.meta.url);
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
// Counts SQLite connections opened on this (the extension host's) thread; worker threads load their own copy.
const sqlite = require.resolve('better-sqlite3');
const RealDatabase = require(sqlite);
let mainThreadOpens = 0;
function CountingDatabase(...args) {
  mainThreadOpens += 1;
  return new RealDatabase(...args);
}
Object.setPrototypeOf(CountingDatabase, RealDatabase);
CountingDatabase.prototype = RealDatabase.prototype;
require.cache[sqlite].exports = CountingDatabase;
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = kernelFile('index.js');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { projectFolderAssignmentSteps } = kernelFile('conversationProject.js');
const {
  mergeHistoricalDataSetsOnline, readRuntimeDataSetMergeStates
} = kernelFile('runtimeDataSetMerge.js');
const { runtimeDataSetFingerprint } = kernelFile('runtimeDataSetMergeLedger.js');
const { preflightRuntimeDataSet, summarizeRuntimeDataSet } = kernelFile('runtimeDataSetPreflight.js');
const {
  resolveVscodeRuntimeDataRoot, resolveVscodeRuntimeDataSet, resolveVscodeRuntimeMergeLedgerRoot, resolveVscodeWorkspaceRuntimeScope,
  resolveVscodeWorkspaceRuntimeScopeRoot, resolveVscodeRuntimeSelectionPath, selectVscodeRuntimeDataSet
} = kernelFile('vscodeRootAuthority.js');

const NOW = '2026-09-26T00:00:00.000Z';
const LATER = '2026-09-27T00:00:00.000Z';
const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
const SHARED_PROJECT = { uri: 'file:///workspace/shared', name: 'shared' };
const SHARED_TEXT = JSON.stringify({ role: 'user', parts: [{ text: '各工作区都用过的同一段正文' }] });
const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);

test('合并后有无改动按内容判断：旧窗口崩溃留下的 WAL 被打开一次、文件被原样恢复都不算改动，写入一行才算', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_wal', project: SHARED_PROJECT }]);
  // An old window writes, then dies without checkpointing: the source carries a non-empty WAL.
  const script = `
    const Database = require(${JSON.stringify(require.resolve('better-sqlite3'))});
    const db = new Database(${JSON.stringify(fixture.alpha.binding.paths.databasePath)});
    db.pragma('wal_autocheckpoint = 0');
    db.prepare("UPDATE conversation SET title = 'renamed by old window' WHERE id = 'conversation_alpha_wal'").run();
    process.kill(process.pid, 'SIGKILL');`;
  await new Promise((resolve) => execFile(process.execPath, ['-e', script], () => resolve()));
  assert.ok((await fs.stat(`${fixture.alpha.binding.paths.databasePath}-wal`)).size > 0, '来源带着非空 WAL');
  const database = await openTarget(t, fixture.current);
  assert.equal((await merge(fixture, database, { candidateIds: [fixture.alpha.id] })).merged.length, 1);
  const changed = async () => (await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id).changedSinceMerge;
  assert.equal(await changed(), false);

  // Opened once (switched to and back): the WAL is checkpointed into the database, nothing is written.
  const databaseBefore = await fs.stat(fixture.alpha.binding.paths.databasePath);
  const opened = await kernel.RuntimeDatabase.open(fixture.alpha.authority, { hostBootId: `view-${randomUUID()}` });
  const row = (await opened.snapshot([repo('Conversation').get('conversation_alpha_wal')])).snapshot[0];
  assert.equal(row.title, 'renamed by old window');
  await opened.close();
  const databaseAfter = await fs.stat(fixture.alpha.binding.paths.databasePath);
  assert.notDeepEqual([databaseAfter.size, databaseAfter.mtimeMs], [databaseBefore.size, databaseBefore.mtimeMs], '文件确实被改写过');
  assert.equal(await changed(), false, '只是检查点合并，不算合并后有改动');

  // The files are restored in place from a copy (another inode, another modification time).
  const copy = path.join(fixture.root, 'restored.sqlite');
  await fs.copyFile(fixture.alpha.binding.paths.databasePath, copy);
  await fs.rm(fixture.alpha.binding.paths.databasePath);
  await fs.rename(copy, fixture.alpha.binding.paths.databasePath);
  assert.equal(await changed(), false, '原样恢复不算改动');

  await continueConversation(fixture.alpha, 'conversation_alpha_wal');
  assert.equal(await changed(), true, '写入一行就算合并后有改动');
});

test('内容指纹按确切文件状态缓存：文件没动时不再复制读取，文件一动就重新计算', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_cached', project: SHARED_PROJECT }]);
  const candidate = await resolveVscodeRuntimeDataSet(fixture.paths, fixture.alpha.id);
  const first = await runtimeDataSetFingerprint(candidate);
  assert.match(first.contentDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(first).sort(), ['contentDigest', 'dataSetId', 'pointerRevision', 'rootGeneration', 'rootInstanceId']);
  const cacheFile = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'fingerprints', `${fixture.alpha.id.replace(/:/g, '-')}.json`);
  const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  assert.deepEqual(cache.fingerprint, first);
  // A marked cache entry proves the next read used it instead of copying the database again.
  await fs.writeFile(cacheFile, JSON.stringify({ ...cache, fingerprint: { ...first, contentDigest: 'from-cache' } }));
  assert.equal((await runtimeDataSetFingerprint(candidate)).contentDigest, 'from-cache');
  const now = new Date();
  await fs.utimes(fixture.alpha.binding.paths.databasePath, now, now);
  assert.equal((await runtimeDataSetFingerprint(candidate)).contentDigest, first.contentDigest, '文件状态变了就重新计算，内容相同摘要相同');
});

test('选库预检、界面摘要和内容指纹在 worker 中读私有副本：主线程不打开任何数据库，摘要按文件状态复用', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_summary', project: SHARED_PROJECT }]);
  const candidate = await resolveVscodeRuntimeDataSet(fixture.paths, fixture.alpha.id);
  const opensBefore = mainThreadOpens;
  assert.equal(await preflightRuntimeDataSet(candidate), undefined);
  const summary = await summarizeRuntimeDataSet(candidate);
  assert.deepEqual(summary, { projectNames: ['shared'], conversationCount: 1, lastActivityAt: NOW });
  await runtimeDataSetFingerprint(candidate);
  assert.equal(mainThreadOpens, opensBefore, '主线程没有打开任何 SQLite 连接');

  // The same file state is answered from memory: nothing is copied (no temporary directory works now).
  const temporary = process.env.TMPDIR;
  process.env.TMPDIR = path.join(fixture.root, 'no-such-temporary-directory');
  t.after(() => { if (temporary === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = temporary; });
  assert.deepEqual(await summarizeRuntimeDataSet(candidate), summary);
  // Another file state is read again; a failed read rejects instead of looking like an empty data set.
  const later = new Date(Date.now() + 1000);
  await fs.utimes(fixture.alpha.binding.paths.databasePath, later, later);
  await assert.rejects(summarizeRuntimeDataSet(candidate), { code: 'ENOENT' });
  assert.match((await preflightRuntimeDataSet(candidate))?.message ?? '', /结构或完整性核验未通过/);
  if (temporary === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = temporary;
  assert.deepEqual(await summarizeRuntimeDataSet(candidate), summary);
});

test('预检在 worker 中照常拒绝结构漂移的库', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_drift', project: SHARED_PROJECT }]);
  const drift = new RealDatabase(fixture.alpha.binding.paths.databasePath);
  try {
    const index = drift.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name LIMIT 1").pluck().get();
    drift.exec(`DROP INDEX "${index}"`);
  } finally { drift.close(); }
  const candidate = await resolveVscodeRuntimeDataSet(fixture.paths, fixture.alpha.id);
  const problem = await preflightRuntimeDataSet(candidate);
  assert.match(problem?.message ?? '', /结构或完整性核验未通过：.*index/i, '漂移的库被拒绝并写明原因');
});

function pick(state) {
  if (!state) return state;
  const { mergedAt, lastMerged, code, message, requestedAt, ...rest } = state;
  return rest;
}

async function createFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-dataset-merge-state-'));
  t.after(() => removeConfigurationRoot(root));
  const paths = { globalStoragePath: root };
  const current = await initialize(root, 'default');
  const alpha = await initializeScope(paths, 'alpha');
  const beta = options.withBeta === false ? undefined : await initializeScope(paths, 'beta');
  await selectVscodeRuntimeDataSet(paths, options.selected === 'alpha' ? alpha.id : 'default');
  return { root, paths, current, alpha, beta };
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

async function openTarget(t, dataSet) {
  const database = await kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `window-${randomUUID()}` });
  t.after(() => database.close());
  return database;
}

function merge(fixture, database, options) {
  return mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database }, options);
}

function requestMerge(fixture, dataSet) {
  return registerPendingHistory(fixture.paths, {
    candidateId: dataSet.id,
    expectedDataSetId: dataSet.binding.dataSetId,
    expectedRootInstanceId: dataSet.binding.rootInstanceId
  });
}

async function withRuntime(dataSet, run) {
  const runtime = await kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `seed-${randomUUID()}` });
  try {
    return await run(runtime, kernel.ContentAddressedStore.loose(dataSet.authority, dataSet.binding));
  } finally { await runtime.close(); }
}

async function seed(dataSet, conversations) {
  await withRuntime(dataSet, async (runtime, store) => {
    const shared = await store.ingest(runtime, SHARED_TEXT, MESSAGE_TYPE);
    for (const spec of conversations) {
      const at = spec.at ?? NOW;
      const own = await store.ingest(runtime, messageText(spec.id, 0), MESSAGE_TYPE);
      const turnId = `${spec.id}_turn`;
      const steps = [
        repo('Conversation').insert({ id: spec.id, title: spec.id, status: 'active', created_at: at, updated_at: at }),
        ...projectFolderAssignmentSteps({ conversationId: spec.id, folder: spec.project, now: at }),
        repo('Turn').insert({ id: turnId, conversation_id: spec.id, status: 'terminated', created_at: at, updated_at: at, terminal_at: at }),
        repo('TurnTermination').insert({ id: `${spec.id}_termination`, turn_id: turnId, terminal_status: 'completed', reason: 'fixture', created_at: at })
      ];
      for (const [index, content] of [own, shared].entries()) steps.push(...messageSteps(spec.id, `${spec.id}_message_${index}`, index + 1, content.id, at));
      await runtime.transaction(steps);
    }
  });
}

async function continueConversation(dataSet, conversationId) {
  await withRuntime(dataSet, async (runtime, store) => {
    const text = await store.ingest(runtime, JSON.stringify({ role: 'user', parts: [{ text: '合并后继续聊' }] }), MESSAGE_TYPE);
    await runtime.transaction([
      repo('Conversation').update(conversationId, { updated_at: LATER }),
      ...messageSteps(conversationId, `${conversationId}_message_after`, 3, text.id, LATER)
    ]);
  });
}

function messageSteps(conversationId, messageId, seq, contentObjectId, at) {
  return [
    repo('Message').insert({ id: messageId, created_at: at, updated_at: at, deleted_at: null }),
    repo('MessageRevision').insert({
      id: `${messageId}_revision`, message_id: messageId, revision_seq: 1n, role: 'user', content_object_id: contentObjectId, created_at: at
    }),
    repo('MessageCurrentRevisionLink').insert({ id: `${messageId}_current`, message_id: messageId, revision_id: `${messageId}_revision`, updated_at: at }),
    repo('MessagePartOfConversation').insert({
      id: `${messageId}_member`, conversation_id: conversationId, message_id: messageId, message_seq: BigInt(seq), created_at: at
    })
  ];
}

async function readLedgerRecord(fixture, candidateId) {
  const file = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'records', `${candidateId.replace(/:/g, '-')}.json`);
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function controlRoot(dataSet) {
  return path.dirname(dataSet.binding.paths.dataRootPath);
}

function messageText(conversationId, index) {
  return JSON.stringify({ role: 'user', parts: [{ text: `${conversationId} 的第 ${index} 条消息` }] });
}
