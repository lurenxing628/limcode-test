import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

// Merge state as the management UI sees it: merge targets that no longer exist, the last merge
// surviving a later failed attempt, and the user's "kept" decision.
const require = createRequire(import.meta.url);
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = kernelFile('index.js');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { projectFolderAssignmentSteps } = kernelFile('conversationProject.js');
const {
  mergeHistoricalDataSetsOnline, readRuntimeDataSetMergeStates, requestRuntimeDataSetMerge
} = kernelFile('runtimeDataSetMerge.js');
const { deleteUnselectedRuntimeDataSet } = kernelFile('runtimeStorageInspection.js');
const {
  resolveVscodeRuntimeDataRoot, resolveVscodeRuntimeMergeLedgerRoot, resolveVscodeWorkspaceRuntimeScope,
  resolveVscodeWorkspaceRuntimeScopeRoot, selectVscodeRuntimeDataSet
} = kernelFile('vscodeRootAuthority.js');

const NOW = '2026-09-26T00:00:00.000Z';
const LATER = '2026-09-27T00:00:00.000Z';
const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
const SHARED_PROJECT = { uri: 'file:///workspace/shared', name: 'shared' };
const SHARED_TEXT = JSON.stringify({ role: 'user', parts: [{ text: '各工作区都用过的同一段正文' }] });
const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);

test('合并目标被删除后，来源显示目标已不存在，也不会被再次自动合并', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_only_here', project: SHARED_PROJECT }]);
  let database = await openTarget(t, fixture.current);
  assert.equal((await merge(fixture, database, { candidateIds: [fixture.alpha.id] })).merged.length, 1);
  let state = (await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id);
  assert.deepEqual(pick(state), { state: 'merged', intoCurrent: true, targetMissing: false, changedSinceMerge: false });
  await database.close();

  await selectVscodeRuntimeDataSet(fixture.paths, fixture.beta.id);
  state = (await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id);
  assert.deepEqual(pick(state), { state: 'merged', intoCurrent: false, targetMissing: false, changedSinceMerge: false },
    '目标仍存在时照常显示“已合并到其它历史库”');

  await deleteUnselectedRuntimeDataSet(fixture.paths, 'default', fixture.current.binding.dataSetId);
  state = (await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id);
  assert.deepEqual(pick(state), { state: 'merged', intoCurrent: false, targetMissing: true, changedSinceMerge: false });
  database = await openTarget(t, fixture.beta);
  assert.equal((await merge(fixture, database)).pendingSources, 0, '合并过的来源仍只按明确请求合并');

  await requestMerge(fixture, fixture.alpha);
  const again = await merge(fixture, database, { candidateIds: [fixture.alpha.id] });
  assert.deepEqual(again.merged.map((item) => item.insertedConversations), [1], '明确请求后对话重新写入现在的当前库');
  state = (await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id);
  assert.deepEqual(pick(state), { state: 'merged', intoCurrent: true, targetMissing: false, changedSinceMerge: false });
});

test('再次明确合并受阻后仍保留上次合并：状态、删除警告依据与“只按明确请求合并”都不丢', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_before', project: SHARED_PROJECT }]);
  let database = await openTarget(t, fixture.current);
  assert.equal((await merge(fixture, database, { candidateIds: [fixture.alpha.id] })).merged.length, 1);
  await database.close();

  // The user continues the merged conversation in the source: the source side alone changes.
  await selectVscodeRuntimeDataSet(fixture.paths, fixture.alpha.id);
  await continueConversation(fixture.alpha, 'conversation_alpha_before');
  await selectVscodeRuntimeDataSet(fixture.paths, 'default');
  database = await openTarget(t, fixture.current);
  assert.deepEqual(pick((await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id)),
    { state: 'merged', intoCurrent: true, targetMissing: false, changedSinceMerge: true });

  await requestMerge(fixture, fixture.alpha);
  const again = await merge(fixture, database, { candidateIds: [fixture.alpha.id] });
  assert.equal(again.merged.length, 0);
  assert.equal(again.blocked[0]?.code, 'runtime-data-set-merge-conflict', '在已合并的对话里继续过，再次合并整体不合并');
  const state = (await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id);
  assert.equal(state.state, 'blocked');
  assert.deepEqual(pick(state.lastMerged), { intoCurrent: true, targetMissing: false, changedSinceMerge: true },
    '受阻记录携带上次合并，删除确认据此警告合并后的改动会丢失');
  const record = await readLedgerRecord(fixture, fixture.alpha.id);
  assert.equal(record.state, 'blocked');
  assert.deepEqual(record.lastMerged.target, { dataSetId: fixture.current.binding.dataSetId, rootInstanceId: fixture.current.binding.rootInstanceId });

  // Later automatic batches still treat the source as merged once: explicit request only.
  const automatic = await merge(fixture, database);
  assert.equal(automatic.pendingSources, 0);
  assert.equal(automatic.merged.length + automatic.blocked.length + automatic.deferred.length, 0);
});

test('合并后只在来源里新建对话：再次明确合并只写入新对话', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_first', project: SHARED_PROJECT }]);
  let database = await openTarget(t, fixture.current);
  assert.equal((await merge(fixture, database, { candidateIds: [fixture.alpha.id] })).merged.length, 1);
  await database.close();
  await selectVscodeRuntimeDataSet(fixture.paths, fixture.alpha.id);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_new', project: SHARED_PROJECT, at: LATER }]);
  await selectVscodeRuntimeDataSet(fixture.paths, 'default');
  database = await openTarget(t, fixture.current);
  await requestMerge(fixture, fixture.alpha);
  const again = await merge(fixture, database, { candidateIds: [fixture.alpha.id] });
  assert.deepEqual(again.blocked, []);
  assert.deepEqual(again.merged.map((item) => item.insertedConversations), [1]);
  const seen = (await database.snapshot([repo('Conversation').get('conversation_alpha_new')])).snapshot[0];
  assert.equal(seen?.id, 'conversation_alpha_new');
});

function pick(state) {
  if (!state) return state;
  const { mergedAt, lastMerged, code, message, requestedAt, ...rest } = state;
  return rest;
}

async function createFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-dataset-merge-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
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
  return requestRuntimeDataSetMerge(fixture.paths, {
    candidateId: dataSet.id,
    expectedDataSetId: dataSet.binding.dataSetId,
    expectedRootInstanceId: dataSet.binding.rootInstanceId
  });
}

async function withRuntime(dataSet, run) {
  const runtime = await kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `seed-${randomUUID()}` });
  try {
    return await run(runtime, new kernel.ContentAddressedStore(dataSet.authority, dataSet.binding));
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

function messageText(conversationId, index) {
  return JSON.stringify({ role: 'user', parts: [{ text: `${conversationId} 的第 ${index} 条消息` }] });
}
