import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import test, { before, after } from 'node:test';
import {
  createConfigurationRoot, Database, kernel, kernelFile, compiled, MESSAGE_TYPE,
  modelRequestAggregate, NOW, removeConfigurationRoot, repo, SHARED_PROJECT, SHARED_TEXT,
  messageText, withRuntime
} from './fixtures/runtime-merge-fixture.mjs';
import * as memory from './fixtures/ci-context-handle-memory.mjs';
import { registerContextHandleBoundaryTests } from './fixtures/ci-context-handle-boundaries.mjs';

const require = createRequire(import.meta.url);
const load = file => require(path.join(compiled, file));
const state = kernelFile('conversationContextHandleState.js');
const { readConversationContextHandleState } = kernelFile('conversationChildHandles.js');
const { upgradePendingConversationContextHandles } = kernelFile('conversationContextHandleUpgrade.js');
const { mergeHistoricalDataSetsOnline } = kernelFile('runtimeDataSetMerge.js');
const { RUNTIME_DOMAIN_SCHEMAS } = kernelFile('schema/domainManifest.js');
const { CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION: contract } = kernelFile('modelHandleCatalog.js');
const { projectFolderAssignmentSteps } = kernelFile('conversationProject.js');
const CONVERSATION = 'ci_handle_import_owner';
const INACTIVE_CONVERSATION = 'ci_handle_inactive_owner';
const IMPORT_CATALOG = { identityContractRevision: contract,
  entries: [{ kind: 'process', ref: 'P1', target: 'frozen_process' }], retiredRefs: [] };
let configuration, database, store;
async function openRuntime() {
  database = await kernel.RuntimeDatabase.open(configuration.current.authority);
  store = kernel.ContentAddressedStore.forDatabase(configuration.current.authority, database);
}
before(async () => {
  configuration = await createConfigurationRoot();
  await withRuntime(configuration.alpha, async (sourceDatabase, sourceStore) => {
    await seedHandleConversations(sourceDatabase, sourceStore);
    await sourceDatabase.transaction([
      ...state.pendingConversationContextHandleStateSteps(CONVERSATION, NOW),
      ...state.pendingConversationContextHandleStateSteps(INACTIVE_CONVERSATION, NOW)
    ]);
    await seedHandleRequest(sourceDatabase, sourceStore, 'selected_handle_request', 1n, true);
    await seedHandleRequest(sourceDatabase, sourceStore, 'other_selected_request', 1n, true, INACTIVE_CONVERSATION);
    await seedHandleRequest(sourceDatabase, sourceStore, 'inactive_handle_request', 2n, false, INACTIVE_CONVERSATION);
  });
  await openRuntime();
  await seedHandleConversations(database, store);
  await database.transaction([
    state.emptyConversationContextHandleStateStep(CONVERSATION, NOW),
    state.emptyConversationContextHandleStateStep(INACTIVE_CONVERSATION, NOW)
  ]);
  await seedHandleRequest(database, store, 'other_selected_request', 1n, true, INACTIVE_CONVERSATION);
  const current = await state.readConversationContextHandleStateRow(database, INACTIVE_CONVERSATION);
  await database.transaction(await state.prepareReadyConversationContextHandleState({ database, contentStore: store,
    conversationId: INACTIVE_CONVERSATION, current, contextRootId: 'other_selected_request_root',
    catalog: IMPORT_CATALOG, requiresNativeReset: false, now: NOW }));
});
after(async () => {
  await database?.close();
  if (configuration) await removeConfigurationRoot(configuration.root);
});
async function rows(domain, where = {}) {
  return (await database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))).snapshot;
}
async function createTurn(id) {
  const conversationId = id + '_conversation';
  await database.transaction([
    repo('Conversation').insert({ id: conversationId, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
    repo('Turn').insert({ id, conversation_id: conversationId, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
    repo('TurnTermination').insert({ id: id + '_termination', turn_id: id, terminal_status: 'completed', reason: 'fixture', created_at: NOW }),
    state.emptyConversationContextHandleStateStep(conversationId, NOW)
  ]);
  return { conversationId, turnId: id };
}
async function directory(name) {
  const result = path.join(configuration.root, name);
  await fs.mkdir(result, { recursive: true });
  return result;
}
async function reopen() {
  await database.close();
  await openRuntime();
}
async function seedHandleConversations(target, contentStore) {
  const shared = await contentStore.ingest(target, SHARED_TEXT, MESSAGE_TYPE);
  for (const conversationId of [CONVERSATION, INACTIVE_CONVERSATION]) {
    const own = await contentStore.ingest(target, messageText(conversationId, 0), MESSAGE_TYPE);
    const turnId = conversationId + '_turn';
    const steps = [
      repo('Conversation').insert({ id: conversationId, title: conversationId, status: 'active', created_at: NOW, updated_at: NOW }),
      ...projectFolderAssignmentSteps({ conversationId, folder: SHARED_PROJECT, now: NOW }),
      repo('Turn').insert({ id: turnId, conversation_id: conversationId, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
      repo('TurnTermination').insert({ id: conversationId + '_termination', turn_id: turnId, terminal_status: 'completed', reason: 'fixture', created_at: NOW })
    ];
    for (const [index, contentId] of [own.id, shared.id].entries()) {
      const messageId = conversationId + '_message_' + index;
      steps.push(
        repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
        repo('MessageRevision').insert({ id: messageId + '_revision', message_id: messageId, revision_seq: 1n, role: 'user', content_object_id: contentId, created_at: NOW }),
        repo('MessageCurrentRevisionLink').insert({ id: messageId + '_current', message_id: messageId, revision_id: messageId + '_revision', updated_at: NOW }),
        repo('MessagePartOfConversation').insert({ id: messageId + '_member', conversation_id: conversationId, message_id: messageId, message_seq: BigInt(index + 1), created_at: NOW })
      );
    }
    await target.transaction(steps);
  }
}
async function seedHandleRequest(target, contentStore, id, sequence, represented, conversationId = CONVERSATION) {
  const recipe = await contentStore.ingest(target, JSON.stringify({
    kind: 'reliable-agent-turn', modelHandleCatalog: IMPORT_CATALOG
  }), 'application/json');
  const body = await contentStore.ingest(target, JSON.stringify({ role: 'model', parts: [{ text: 'P1' }] }), MESSAGE_TYPE);
  const steps = modelRequestAggregate(conversationId + '_turn', id, sequence,
    { recipe: recipe.id, body: body.id, checkpoints: 1 });
  steps.push(
    repo('Message').insert({ id: id + '_message', created_at: NOW, updated_at: NOW, deleted_at: null }),
    repo('MessageRevision').insert({ id: id + '_revision', message_id: id + '_message', revision_seq: 1n,
      role: 'model', content_object_id: body.id, created_at: NOW }),
    repo('MessageCurrentRevisionLink').insert({ id: id + '_current', message_id: id + '_message', revision_id: id + '_revision', updated_at: NOW }),
    repo('MessagePartOfConversation').insert({ id: id + '_member', conversation_id: conversationId,
      message_id: id + '_message', message_seq: sequence + 2n, created_at: NOW }),
    repo('ModelRequestMessageLink').insert({ id: id + '_output', model_request_id: id, message_id: id + '_message', created_at: NOW }),
    repo('ContextSegment').insert({ id: id + '_segment', content_object_id: body.id, segment_kind: 'message', created_at: NOW }),
    repo('ContextSegmentSource').insert({ id: id + '_source', segment_id: id + '_segment', source_kind: 'message_revision',
      source_id: id + '_revision', source_revision: 1n, created_at: NOW }),
    repo('ContextSequenceNode').insert({ id: id + '_node', parent_node_id: null, segment_id: id + '_segment', created_at: NOW }),
    repo('ContextSequenceRoot').insert({ id: id + '_root', conversation_id: conversationId, root_seq: sequence,
      root_node_id: id + '_node', tail_node_id: null, tail_segment_count: 0n, segment_count: 1n, estimated_tokens: 1n, created_at: NOW })
  );
  if (represented) {
    steps.push(repo('ConversationContextHeadLink').insert({ id: id + '_head', conversation_id: conversationId,
      root_id: id + '_root', updated_at: NOW }));
    const current = await state.readConversationContextHandleStateRow(target, conversationId);
    steps.push(...state.pendingConversationContextHandleStateSteps(conversationId, NOW, current, id + '_root'));
  }
  await target.transaction(steps);
}
async function mergeSource() {
  const report = await mergeHistoricalDataSetsOnline(configuration.paths,
    { configurationRootPath: configuration.root, database }, { candidateIds: [configuration.alpha.id], requested: true });
  assert.deepEqual(report.deferred, []);
  assert.deepEqual(report.blocked, []);
  assert.deepEqual(report.failures, []);
  assert.equal(report.merged.length, 1);
  return report;
}

test('H1 only admitted bindings publish; private allocations reserve ordinals and stale head plans roll back', async () => {
  const seeded = memory.fixture();
  await memory.seedReady(seeded, memory.catalog(memory.processHandle(1)));
  const f = memory.fixture(seeded.shared);
  assert.deepEqual((await readConversationContextHandleState(f.database, f.store, 'conversation')).catalog.entries,
    [memory.processHandle(1)]);
  assert.equal(f.metrics.reads.length, 1);
  assert.ok(f.metrics.queries.every(read =>
    [state.CONTEXT_HANDLE_STATE_DOMAIN, 'ConversationContextHeadLink', 'ContentObject'].includes(read.domain)));
  const frozen = structuredClone(f.table(state.CONTEXT_HANDLE_STATE_DOMAIN)[0]);
  const privateSteps = await memory.prepare(f, memory.catalog(memory.processHandle(1), memory.processHandle(50)), 'native');
  assert.equal(privateSteps.length, 1);
  assert.equal(privateSteps[0].kind, 'assert');
  await f.database.transaction(privateSteps);
  assert.deepEqual(f.table(state.CONTEXT_HANDLE_STATE_DOMAIN)[0], frozen);
  assert.equal(f.metrics.reads.length, 1);
  assert.equal(f.metrics.prepares, 0);
  const second = memory.addModelOccurrence(f, 'second', memory.catalog(memory.processHandle(1), memory.processHandle(2), memory.processHandle(99)), null, 'P2');
  const third = memory.addModelOccurrence(f, 'third', memory.catalog(memory.processHandle(1), memory.processHandle(3)), null, 'P3');
  const root2 = memory.addRoot(f, 'root-2', second.nodeId, 1n);
  const root3 = memory.addRoot(f, 'root-3', third.nodeId, 1n);
  const admitted = await memory.transition(f, 'root-2', 'append', { rootShape: root2, occurrence: second.occurrence });
  const stale = await memory.transition(f, 'root-3', 'append', { rootShape: root3, occurrence: third.occurrence });
  await memory.commitTransition(f, admitted);
  await assert.rejects(memory.commitTransition(f, stale), { code: 'RUNTIME_TRANSACTION_ASSERTION_FAILED' });
  const current = await state.readCurrentConversationContextHandleState(f.database, f.store, 'conversation');
  assert.deepEqual(current.catalog.entries, [memory.processHandle(1), memory.processHandle(2)]);
  assert.equal(current.catalog.allocationHighWater.process, 99);
  assert.equal(f.table('ContextRootHandleCatalog').some(row => row.context_root_id === 'root-3'), false);
  assert.equal(f.metrics.historicalFrontiers, 0);
});

test('H2 retry branches bind the same process ref independently and reactivate exact immutable catalogs', async () => {
  const f = memory.fixture();
  await memory.seedReady(f, memory.catalog());
  const a = { kind: 'process', ref: 'P3520', target: 'branch-A' };
  const b = { kind: 'process', ref: 'P3520', target: 'branch-B' };
  const occurrenceA = memory.addModelOccurrence(f, 'branch-A', memory.catalog(a));
  const shapeA = memory.addRoot(f, 'root-A', occurrenceA.nodeId, 1n);
  await memory.commitTransition(f, await memory.transition(f, 'root-A', 'append', { rootShape: shapeA, occurrence: occurrenceA.occurrence }));
  const snapshotA = structuredClone(f.table('ContextRootHandleCatalog').find(row => row.context_root_id === 'root-A'));
  const bytesA = Buffer.from(f.shared.contents.get(snapshotA.content_object_id));
  const prefix = memory.addRoot(f, 'retry-prefix');
  await memory.commitTransition(f, await memory.transition(f, 'retry-prefix', 'rewrite', { rootShape: prefix }));
  const occurrenceB = memory.addModelOccurrence(f, 'branch-B', memory.catalog(b));
  const shapeB = memory.addRoot(f, 'root-B', occurrenceB.nodeId, 1n);
  await memory.commitTransition(f, await memory.transition(f, 'root-B', 'append', { rootShape: shapeB, occurrence: occurrenceB.occurrence }));
  assert.deepEqual((await readConversationContextHandleState(f.database, f.store, 'conversation')).catalog.entries, [b]);
  await memory.commitTransition(f, await memory.transition(f, 'root-A', 'activate'));
  const restored = await readConversationContextHandleState(f.database, f.store, 'conversation');
  assert.deepEqual(restored.catalog.entries, [a]);
  assert.equal(restored.requiresNativeReset, true);
  assert.deepEqual(f.table('ContextRootHandleCatalog').find(row => row.context_root_id === 'root-A'), snapshotA);
  assert.deepEqual(f.shared.contents.get(snapshotA.content_object_id), bytesA);
  assert.deepEqual(restored.catalog.retiredRefs, []);
});

test('H3 selected-root upgrade resumes 65 occurrences across 32 and 64 checkpoints without replaying discarded history', async () => {
  const f = memory.fixture();
  await assert.rejects(readConversationContextHandleState(f.database, f.store, 'conversation'),
    { code: 'MODEL_CONTEXT_HANDLE_STATE_INVALID' });
  assert.equal(f.metrics.reads.length, 0);
  f.table('Conversation').push({ id: 'conversation', title: 'checkpoint', status: 'active', created_at: NOW, updated_at: NOW });
  let parent = null;
  for (let index = 0; index < 65; index++) {
    const legacy = { entries: [{ kind: 'process', ref: 'P1', target: index === 64 ? 'old-b' : 'old-a' }] };
    parent = memory.addModelOccurrence(f, 'checkpoint-' + index, legacy, parent, index === 40 ? 'P1 P9000' : 'P1').nodeId;
  }
  memory.addRoot(f, 'legacy-root', parent, 65n);
  memory.selectHead(f, 'legacy-root');
  memory.addModelOccurrence(f, 'discarded', memory.catalog({ kind: 'process', ref: 'P1', target: 'discarded-process' }));
  await f.database.transaction(state.pendingConversationContextHandleStateSteps('conversation', NOW, undefined, 'legacy-root'));
  await assert.rejects(readConversationContextHandleState(f.database, f.store, 'conversation'), { code: 'MODEL_CONTEXT_HANDLE_UPGRADE_PENDING' });
  const abort = new AbortController();
  let ticked = false;
  const tick = new Promise(resolve => setImmediate(() => { ticked = true; resolve(); }));
  await assert.rejects(upgradePendingConversationContextHandles(f.database, f.store, {
    signal: abort.signal, onProgress(value) {
      if (value.completedRequests === 33) { assert.equal(ticked, true); abort.abort(); }
    }
  }), { name: 'AbortError' });
  await tick;
  const pending = f.table(state.CONTEXT_HANDLE_STATE_DOMAIN)[0];
  const checkpoint = JSON.parse(f.shared.contents.get(pending.content_object_id));
  assert.equal(pending.state, 'pending');
  assert.equal(checkpoint.nextOccurrence, 32);
  assert.equal(checkpoint.facts.reduce((count, value) => count + value.entries.length, 0), 1);
  assert.ok(JSON.stringify(checkpoint).length < 1_000);
  const reopened = memory.fixture(f.shared), progress = [];
  assert.deepEqual(await upgradePendingConversationContextHandles(reopened.database, reopened.store,
    { onProgress: value => progress.push(value.completedRequests) }), []);
  assert.equal(progress[0], 32);
  assert.equal(reopened.metrics.reads.filter(id => id.startsWith('recipe-checkpoint-')).length, 33);
  assert.ok(reopened.metrics.prepares <= 2);
  assert.equal(reopened.metrics.reads.includes('recipe-discarded'), false);
  const ready = await readConversationContextHandleState(reopened.database, reopened.store, 'conversation');
  assert.deepEqual(ready.catalog.entries.map(entry => entry.ref), ['P9001', 'P9002']);
  assert.deepEqual(ready.catalog.retiredRefs, ['P1']);
  assert.equal(ready.requiresNativeReset, true);
  assert.equal(reopened.metrics.historicalFrontiers, 0);
});

test('H4 one real merge invalidates selected evidence and preserves the inactive ready branch until explicit activation', async () => {
  const rootId = 'selected_handle_request_root';
  const empty = await state.readConversationContextHandleStateRow(database, CONVERSATION);
  await store.ingest(database, JSON.stringify({ role: 'model', parts: [{ text: 'P1' }] }), MESSAGE_TYPE);
  const source = new Database(configuration.alpha.binding.paths.databasePath, { readonly: true });
  source.defaultSafeIntegers(true);
  try {
    const steps = [];
    for (const domain of ['Message', 'MessageRevision', 'MessageCurrentRevisionLink', 'MessagePartOfConversation',
      'ContextSegment', 'ContextSegmentSource', 'ContextSequenceNode', 'ContextSequenceRoot', 'ConversationContextHeadLink']) {
      const schema = RUNTIME_DOMAIN_SCHEMAS.find(item => item.key === domain);
      for (const raw of source.prepare('SELECT * FROM ' + schema.table + " WHERE id LIKE 'selected_handle_request_%'").all()) {
        steps.push(repo(domain).insert(repo(domain).codec.decode(raw)));
      }
    }
    await database.transaction([...steps,
      ...state.pendingConversationContextHandleStateSteps(CONVERSATION, NOW, empty, rootId)]);
  } finally { source.close(); }
  const initial = await state.readConversationContextHandleStateRow(database, CONVERSATION);
  await database.transaction(await state.prepareReadyConversationContextHandleState({ database, contentStore: store,
    conversationId: CONVERSATION, current: initial, contextRootId: rootId,
    catalog: { ...IMPORT_CATALOG, entries: [{ kind: 'process', ref: 'P1', target: 'stale-derived-process' }] },
    requiresNativeReset: false, now: NOW }));
  const before = await state.readConversationContextHandleStateRow(database, CONVERSATION);
  const inactiveBefore = await state.readConversationContextHandleStateRow(database, INACTIVE_CONVERSATION);
  const [metadata] = await rows('ContentObject', { id: before.content_object_id });
  const oldBytes = await store.read(metadata);
  await mergeSource();
  const inactiveImported = await state.readConversationContextHandleStateRow(database, INACTIVE_CONVERSATION);
  assert.equal(inactiveImported.state, 'ready');
  assert.equal(inactiveImported.context_root_id, inactiveBefore.context_root_id);
  assert.equal(inactiveImported.content_object_id, inactiveBefore.content_object_id);
  assert.equal(inactiveImported.requires_native_reset, inactiveBefore.requires_native_reset);
  assert.equal(inactiveImported.provenance_revision, inactiveBefore.provenance_revision + 1n);
  const pending = await state.readConversationContextHandleStateRow(database, CONVERSATION);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.context_root_id, rootId);
  assert.equal(pending.provenance_revision, before.provenance_revision + 1n);
  assert.deepEqual(await upgradePendingConversationContextHandles(database, store), []);
  const ready = await state.readCurrentConversationContextHandleState(database, store, CONVERSATION);
  assert.deepEqual(ready.catalog.entries, IMPORT_CATALOG.entries);
  assert.equal(ready.row.context_root_id, rootId);
  assert.equal(ready.requiresNativeReset, true);
  const [oldScope] = await rows(state.CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN, {
    id: state.contextRootHandleCatalogId(CONVERSATION, rootId, before.provenance_revision)
  });
  assert.equal(oldScope.content_object_id, before.content_object_id);
  assert.deepEqual(await store.read(metadata), oldBytes);
  const switchPlan = await state.prepareContextHandleHeadTransition({ database, contentStore: store,
    conversationId: INACTIVE_CONVERSATION, previousRootId: inactiveImported.context_root_id,
    nextRootId: 'inactive_handle_request_root', mode: 'activate', now: NOW });
  await database.transaction([...switchPlan.steps, repo('ConversationContextHeadLink').update('other_selected_request_head',
    { root_id: 'inactive_handle_request_root', updated_at: NOW })]);
  assert.equal((await state.readConversationContextHandleStateRow(database, INACTIVE_CONVERSATION)).state, 'pending');
  assert.deepEqual(await upgradePendingConversationContextHandles(database, store), []);
  const selected = await state.readCurrentConversationContextHandleState(database, store, INACTIVE_CONVERSATION);
  assert.deepEqual(selected.catalog.entries, IMPORT_CATALOG.entries);
  assert.equal(selected.row.context_root_id, 'inactive_handle_request_root');
});

registerContextHandleBoundaryTests({
  kernel, kernelFile, load, compiled, require, Database, repo, NOW, modelRequestAggregate,
  temporary: () => configuration.root, database: () => database, store: () => store,
  authority: () => configuration.current.authority, binding: () => database.binding,
  createTurn, directory, rows, reopen
});
