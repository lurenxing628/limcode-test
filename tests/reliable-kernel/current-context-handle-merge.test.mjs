import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  createConfigurationRoot, Database, kernel, kernelFile, MESSAGE_TYPE, modelRequestAggregate, NOW,
  readAll, removeConfigurationRoot, repo, seedConversations, withRuntime
} from './fixtures/runtime-merge-fixture.mjs';

const { HISTORICAL_MERGE_ENGINE, mergeHistoricalDataSetsOnline } = kernelFile('runtimeDataSetMerge.js');
const { prepareLargeMergeSources, runLargeMergeSession } = kernelFile('runtimeDataSetStreamedMerge.js');
const { withRuntimeDataRootAdmission, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const { RUNTIME_DOMAIN_SCHEMAS } = kernelFile('schema/domainManifest.js');
const { ConversationDeletionControlPlane } = kernelFile('conversationDeletion.js');
const {
  CONTEXT_HANDLE_STATE_DOMAIN, CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN, contextRootHandleCatalogId, conversationContextHandleStateId, emptyConversationContextHandleStateStep,
  pendingConversationContextHandleStateSteps, readConversationContextHandleStateRow,
  prepareReadyConversationContextHandleState, prepareContextHandleHeadTransition, emptyContextHandleCatalog, readCurrentConversationContextHandleState
} = kernelFile('conversationContextHandleState.js');
const { upgradePendingConversationContextHandles } = kernelFile('conversationContextHandleUpgrade.js');
const { CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION } = kernelFile('modelHandleCatalog.js');

const CONVERSATION = 'handle_merge_owner';
const CATALOG = { identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION,
  entries: [{ kind: 'process', ref: 'P1', target: 'frozen_process' }], retiredRefs: [] };

async function fixtureFor(t) {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  for (const dataSet of [fixture.current, fixture.alpha]) {
    await seedConversations(dataSet, [{ id: CONVERSATION }]);
    await withRuntime(dataSet, database => database.transaction(dataSet === fixture.current
      ? [emptyConversationContextHandleStateStep(CONVERSATION, NOW)]
      : pendingConversationContextHandleStateSteps(CONVERSATION, NOW)));
  }
  return fixture;
}

async function request(dataSet, id = 'imported_handle_request', seq = 1n, represented = true) {
  await withRuntime(dataSet, async (database, store) => {
    const recipe = await store.ingest(database, JSON.stringify({
      kind: 'reliable-agent-turn', modelHandleCatalog: CATALOG
    }), 'application/json');
    const body = await store.ingest(database, JSON.stringify({ role: 'model', parts: [{ text: 'P1' }] }), MESSAGE_TYPE);
    const steps = modelRequestAggregate(`${CONVERSATION}_turn`, id, seq,
      { recipe: recipe.id, body: body.id, checkpoints: 1 });
    if (represented) steps.push(
      repo('Message').insert({ id: `${id}_message`, created_at: NOW, updated_at: NOW, deleted_at: null }),
      repo('MessageRevision').insert({ id: `${id}_revision`, message_id: `${id}_message`, revision_seq: 1n,
        role: 'model', content_object_id: body.id, created_at: NOW }),
      repo('MessageCurrentRevisionLink').insert({ id: `${id}_current`, message_id: `${id}_message`, revision_id: `${id}_revision`, updated_at: NOW }),
      repo('MessagePartOfConversation').insert({ id: `${id}_member`, conversation_id: CONVERSATION,
        message_id: `${id}_message`, message_seq: seq + 2n, created_at: NOW }),
      repo('ModelRequestMessageLink').insert({ id: `${id}_output`, model_request_id: id, message_id: `${id}_message`, created_at: NOW }),
      repo('ContextSegment').insert({ id: `${id}_segment`, content_object_id: body.id, segment_kind: 'message', created_at: NOW }),
      repo('ContextSegmentSource').insert({ id: `${id}_source`, segment_id: `${id}_segment`, source_kind: 'message_revision',
        source_id: `${id}_revision`, source_revision: 1n, created_at: NOW }),
      repo('ContextSequenceNode').insert({ id: `${id}_node`, parent_node_id: null, segment_id: `${id}_segment`, created_at: NOW }),
      repo('ContextSequenceRoot').insert({ id: `${id}_root`, conversation_id: CONVERSATION, root_seq: seq,
        root_node_id: `${id}_node`, tail_node_id: null, tail_segment_count: 0n, segment_count: 1n, estimated_tokens: 1n, created_at: NOW }),
      ...(represented === 'inactive' ? [] : [repo('ConversationContextHeadLink').insert({ id: `${id}_head`,
        conversation_id: CONVERSATION, root_id: `${id}_root`, updated_at: NOW })])
    );
    if (represented && represented !== 'inactive') {
      const current = await readConversationContextHandleStateRow(database, CONVERSATION);
      steps.push(...pendingConversationContextHandleStateSteps(CONVERSATION, NOW, current, `${id}_root`));
    }
    await database.transaction(steps);
  });
}

function assertMergeReportSucceeded(report) {
  assert.deepEqual(report.deferred, [], 'merge unexpectedly deferred');
  assert.deepEqual(report.blocked, [], 'merge unexpectedly blocked');
  assert.deepEqual(report.failures, [], 'merge unexpectedly failed');
  assert.equal(report.stopped, false, 'merge unexpectedly stopped');
}

async function merge(fixture, mode, { fault, signal } = {}) {
  const expectSuccess = !fault && !signal;
  const database = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: randomUUID() });
  if (mode === 'online') {
    try {
      const result = await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database }, {
        candidateIds: [fixture.alpha.id], requested: true,
        ...(fault ? { onFaultPoint: point => fault(point, database) } : {}), ...(signal ? { signal } : {})
      });
      if (expectSuccess) { assertMergeReportSucceeded(result); assert.equal(result.merged.length, 1); }
      return result;
    } finally { await database.close(); }
  }
  let preparation;
  try {
    preparation = await prepareLargeMergeSources({ paths: fixture.paths,
      target: { configurationRootPath: fixture.root, database }, candidateIds: [fixture.alpha.id], requested: true,
      options: { sizeLimits: { transactionRows: 1 }, chunkRows: 1 } });
  } finally { await database.close(); }
  if (expectSuccess) assertMergeReportSucceeded(preparation.report);
  // No-op sources are already settled and their preparation capability is released by the engine.
  if (preparation.sources.length === 0) {
    if (expectSuccess) assert.equal(preparation.report.merged.length, 1);
    return { preparation, session: undefined };
  }
  const session = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => runLargeMergeSession({ paths: fixture.paths, prepared: preparation, ...(signal ? { signal } : {}),
      options: { ...(fault ? { onFaultPoint: fault } : {}) } })));
  if (expectSuccess) {
    assert.equal(session.cancelled, false);
    assert.equal(session.results.length, 1);
    assert.deepEqual(session.results.filter(result => !['merged', 'current'].includes(result.state)), [],
      'streamed source did not merge');
  }
  return { preparation, session };
}

async function state(dataSet) {
  return withRuntime(dataSet, database => readConversationContextHandleStateRow(database, CONVERSATION));
}

for (const mode of ['online', 'streamed']) {
  test(`${mode}: derived differences are ignored, inserted evidence becomes pending, rebuild and replay preserve ready`, async t => {
    const fixture = await fixtureFor(t);
    const before = await state(fixture.current);
    await merge(fixture, mode);
    assert.deepEqual(await state(fixture.current), before, 'source pending must not overwrite target ready without new evidence');
    await request(fixture.alpha);
    await merge(fixture, mode);
    const pending = await state(fixture.current);
    assert.equal(pending.state, 'pending');
    assert.equal(pending.revision, before.revision + 1n);
    assert.equal(pending.content_object_id, null);
    assert.equal(pending.context_root_id, 'imported_handle_request_root');
    assert.equal(pending.requires_native_reset, 1n);
    await withRuntime(fixture.current, async (database, store) => {
      await assert.rejects(readCurrentConversationContextHandleState(database, store, CONVERSATION),
        { code: 'MODEL_CONTEXT_HANDLE_UPGRADE_PENDING' });
      await upgradePendingConversationContextHandles(database, store);
      const rebuilt = (await readCurrentConversationContextHandleState(database, store, CONVERSATION)).catalog;
      assert.deepEqual(rebuilt.entries, CATALOG.entries);
      assert.deepEqual(rebuilt.retiredRefs, CATALOG.retiredRefs);
    });
    const ready = await state(fixture.current);
    await merge(fixture, mode);
    assert.deepEqual(await state(fixture.current), ready, 'identical evidence replay leaves current CAS and revision untouched');
    const source = new Database(fixture.alpha.binding.paths.databasePath, { readonly: true });
    try {
      assert.equal(HISTORICAL_MERGE_ENGINE.skippedRows(source, new Set([CONVERSATION]))
        .get(CONTEXT_HANDLE_STATE_DOMAIN)?.has(conversationContextHandleStateId(CONVERSATION)), true,
      'the typed Conversation FK includes the authority in the deleted-source closure');
    } finally { source.close(); }
    await withRuntime(fixture.current, async database => {
      await new ConversationDeletionControlPlane(database).delete(CONVERSATION);
      assert.equal((await database.snapshot([repo(CONTEXT_HANDLE_STATE_DOMAIN)
        .get(conversationContextHandleStateId(CONVERSATION))])).snapshot[0], null);
    });
  });

  test(`${mode}: import failure does not leave a pending authority or partial request`, async t => {
    const fixture = await fixtureFor(t);
    await request(fixture.alpha);
    const before = readAll(fixture.current);
    await merge(fixture, mode, { fault(point) {
      if (point === (mode === 'online' ? 'before-row-commit' : 'before-commit')) throw new Error('injected handle import failure');
    } });
    assert.deepEqual(readAll(fixture.current), before, 'evidence and authority are one atomic import');
    await merge(fixture, mode);
    assert.equal((await state(fixture.current)).state, 'pending', 'a fresh retry can complete');
  });
}

test('online import fences a ready-state race and retries without overwriting the newer authority', async t => {
  const fixture = await fixtureFor(t);
  await request(fixture.alpha);
  let raced;
  const result = await merge(fixture, 'online', { async fault(point, database) {
    if (point !== 'before-row-commit') return;
    const contentStore = kernel.ContentAddressedStore.forDatabase(fixture.current.authority, database);
    const current = await readConversationContextHandleStateRow(database, CONVERSATION);
    await database.transaction(await prepareReadyConversationContextHandleState({ database, contentStore,
      conversationId: CONVERSATION, current, catalog: emptyContextHandleCatalog(), requiresNativeReset: false, now: NOW }));
    raced = await readConversationContextHandleStateRow(database, CONVERSATION);
  } });
  assert.equal(result.deferred.length, 1);
  assert.deepEqual(await state(fixture.current), raced);
  await withRuntime(fixture.current, async database => {
    assert.equal((await database.snapshot([repo('ModelRequest').get('imported_handle_request')])).snapshot[0], null);
  });
  await merge(fixture, 'online');
  const pending = await state(fixture.current);
  assert.equal(pending.state, 'pending');
  assert.equal(pending.revision, raced.revision + 1n);
});

for (const mode of ['online', 'streamed']) {
  test(`${mode}: an imported abandoned request cannot invalidate a selected branch or checkpoint`, async t => {
    const fixture = await fixtureFor(t);
    await request(fixture.alpha, 'abandoned_request', 1n, false);
    const before = await state(fixture.current);
    await merge(fixture, mode);
    assert.deepEqual(await state(fixture.current), before);
    await withRuntime(fixture.current, async database => {
      assert.ok((await database.snapshot([repo('ModelRequest').get('abandoned_request')])).snapshot[0],
        'the discarded request is preserved as historical data');
    });
  });
}

test('scoped import reconstructs a new provenance generation, preserving the old immutable snapshot', async t => {
  const fixture = await fixtureFor(t);
  await request(fixture.alpha);
  const rootId = 'imported_handle_request_root';
  const source = new Database(fixture.alpha.binding.paths.databasePath, { readonly: true });
  source.defaultSafeIntegers(true);
  try {
    await withRuntime(fixture.current, async (database, store) => {
      await store.ingest(database, JSON.stringify({ role: 'model', parts: [{ text: 'P1' }] }), MESSAGE_TYPE);
      const current = await readConversationContextHandleStateRow(database, CONVERSATION);
      const steps = [];
      for (const domain of ['Message', 'MessageRevision', 'MessageCurrentRevisionLink', 'MessagePartOfConversation',
        'ContextSegment', 'ContextSegmentSource', 'ContextSequenceNode', 'ContextSequenceRoot', 'ConversationContextHeadLink']) {
        const schema = RUNTIME_DOMAIN_SCHEMAS.find(item => item.key === domain);
        for (const raw of source.prepare(`SELECT * FROM ${schema.table} WHERE id LIKE 'imported_handle_request_%'`).all()) {
          steps.push(repo(domain).insert(repo(domain).codec.decode(raw)));
        }
      }
      await database.transaction(steps);
      await database.transaction(await prepareReadyConversationContextHandleState({ database, contentStore: store,
        conversationId: CONVERSATION, current, contextRootId: rootId,
        catalog: { ...CATALOG, entries: [{ kind: 'process', ref: 'P1', target: 'stale-derived-process' }] },
        requiresNativeReset: false, now: NOW }));
    });
  } finally { source.close(); }
  const before = await state(fixture.current);
  await merge(fixture, 'online');
  assert.equal((await state(fixture.current)).state, 'pending');
  await withRuntime(fixture.current, async (database, store) => {
    await upgradePendingConversationContextHandles(database, store);
    const ready = await readCurrentConversationContextHandleState(database, store, CONVERSATION);
    assert.equal(ready.row.context_root_id, rootId);
    assert.equal(ready.row.provenance_revision, before.provenance_revision + 1n);
    assert.deepEqual(ready.catalog.entries, CATALOG.entries);
    assert.equal(ready.requiresNativeReset, true);
    const [old, reconstructed, oldCatalog, heads] = (await database.snapshot([
      repo('ContextSequenceRoot').get(rootId), repo('ContextSequenceRoot').get(ready.row.context_root_id),
      repo(CONTEXT_ROOT_HANDLE_CATALOG_DOMAIN).get(contextRootHandleCatalogId(CONVERSATION, rootId, before.provenance_revision)),
      repo('ConversationContextHeadLink').list({ where: { conversation_id: CONVERSATION }, limit: 2 })
    ])).snapshot;
    for (const key of ['root_node_id', 'tail_node_id', 'tail_segment_count', 'segment_count']) assert.equal(reconstructed[key], old[key]);
    assert.equal(oldCatalog.content_object_id, before.content_object_id);
    assert.equal(heads[0].root_id, ready.row.context_root_id);
  });
});

test('inactive imported occurrences advance provenance while the unrelated selected head stays ready', async t => {
  const fixture = await fixtureFor(t);
  for (const dataSet of [fixture.current, fixture.alpha]) await request(dataSet);
  await withRuntime(fixture.current, async (database, store) => {
    const current = await readConversationContextHandleStateRow(database, CONVERSATION);
    await database.transaction(await prepareReadyConversationContextHandleState({ database, contentStore: store,
      conversationId: CONVERSATION, current, contextRootId: 'imported_handle_request_root',
      catalog: CATALOG, requiresNativeReset: false, now: NOW }));
  });
  await request(fixture.alpha, 'inactive_branch_request', 2n, 'inactive');
  const before = await state(fixture.current);
  await merge(fixture, 'online');
  const after = await state(fixture.current);
  assert.equal(after.state, 'ready');
  assert.equal(after.context_root_id, before.context_root_id);
  assert.equal(after.content_object_id, before.content_object_id);
  assert.equal(after.requires_native_reset, before.requires_native_reset);
  assert.equal(after.provenance_revision, before.provenance_revision + 1n);
  await withRuntime(fixture.current, async (database, store) => {
    const switched = await prepareContextHandleHeadTransition({ database, contentStore: store,
      conversationId: CONVERSATION, previousRootId: after.context_root_id,
      nextRootId: 'inactive_branch_request_root', mode: 'activate', now: NOW });
    await database.transaction([...switched.steps, repo('ConversationContextHeadLink').update('imported_handle_request_head',
      { root_id: 'inactive_branch_request_root', updated_at: NOW })]);
    assert.equal((await readConversationContextHandleStateRow(database, CONVERSATION)).state, 'pending');
    await upgradePendingConversationContextHandles(database, store);
    assert.deepEqual((await readCurrentConversationContextHandleState(database, store, CONVERSATION)).catalog.entries, CATALOG.entries);
  });
});
