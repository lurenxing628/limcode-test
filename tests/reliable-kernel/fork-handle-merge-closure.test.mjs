import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  createConfigurationRoot, Database, kernel, kernelFile, MESSAGE_TYPE, modelRequestAggregate, NOW,
  readAll, removeConfigurationRoot, repo, seedConversations, withRuntime
} from './fixtures/runtime-merge-fixture.mjs';

const {
  HISTORICAL_MERGE_ENGINE, mergeHistoricalDataSetsOnline, requestRuntimeDataSetMerge
} = kernelFile('runtimeDataSetMerge.js');
const { ConversationDeletionControlPlane } = kernelFile('conversationDeletion.js');
const {
  FORK_CONTEXT_HANDLE_RESERVATION_OWNER_KIND, readForkContextHandleReservationCatalog
} = kernelFile('forkContextHandleReservations.js');
const { CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION } = kernelFile('modelHandleCatalog.js');

const SOURCE = 'fork_merge_source';
const FORK = 'fork_merge_deleted_branch';
const NEW = 'fork_merge_new_history';
const CATALOG = {
  identityContractRevision: CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION,
  entries: [{ kind: 'process', ref: 'P1', target: 'process_before_fork' }],
  retiredRefs: ['P9']
};

async function row(database, domain, id) {
  return (await database.snapshot([repo(domain).get(id)])).snapshot[0];
}

async function list(database, domain, where) {
  return (await database.snapshotAll(repo(domain).list({
    where, orderBy: { column: 'id', direction: 'asc' }, limit: 100
  }))).snapshot;
}

/** The actual fork writer owns the private artifact, including addresses outside its empty head. */
async function seedFork(dataSet) {
  await seedConversations(dataSet, [{ id: SOURCE }]);
  return withRuntime(dataSet, async (database, store) => {
    const recipe = await store.ingest(database, JSON.stringify({
      kind: 'reliable-agent-turn', modelHandleCatalog: CATALOG
    }), 'application/json');
    const body = await store.ingest(database,
      JSON.stringify({ role: 'model', parts: [{ text: 'The source once displayed process P1.' }] }), MESSAGE_TYPE);
    await database.transaction([
      repo('AgentConversationLink').insert({ id: `${SOURCE}_agent`, conversation_id: SOURCE,
        agent_id: 'fork-merge-agent', role: 'default', created_at: NOW, updated_at: NOW }),
      repo('ContextSequenceRoot').insert({ id: `${SOURCE}_empty_root`, conversation_id: SOURCE,
        root_seq: 1n, root_node_id: null, tail_node_id: null, tail_segment_count: 0n,
        segment_count: 0n, estimated_tokens: 0n, created_at: NOW }),
      repo('ConversationContextHeadLink').insert({ id: `${SOURCE}_head`, conversation_id: SOURCE,
        root_id: `${SOURCE}_empty_root`, updated_at: NOW }),
      ...modelRequestAggregate(`${SOURCE}_turn`, `${SOURCE}_request`, 1n,
        { recipe: recipe.id, body: body.id, checkpoints: 1 })
    ]);
    const fork = await new kernel.ConversationForkControlPlane(database, store, { now: () => NOW }).fork({
      idempotencyKey: 'fork-merge-reservations', reuseKey: 'fork-merge-reservations',
      sourceConversationId: SOURCE, sourceContextRootId: `${SOURCE}_empty_root`,
      targetConversationId: FORK, targetTitle: 'Branch deleted after the first merge',
      targetAgentId: 'fork-merge-agent'
    });
    assert.equal(fork.targetConversationId, FORK);
    assert.deepEqual(await readForkContextHandleReservationCatalog(database, store, FORK), CATALOG);
    const [projection] = await list(database, 'ModelContextProjection', {
      owner_kind: FORK_CONTEXT_HANDLE_RESERVATION_OWNER_KIND, owner_id: FORK
    });
    assert.ok(projection);
    const root = await row(database, 'ContextSequenceRoot', projection.root_id);
    const node = await row(database, 'ContextSequenceNode', root.root_node_id);
    const segment = await row(database, 'ContextSegment', node.segment_id);
    const [source] = await list(database, 'ContextSegmentSource', { segment_id: segment.id });
    assert.ok(source);
    assert.notEqual(projection.root_id, fork.targetRootId, 'the numbered evidence lives outside the model-visible head');
    return { projection, root, node, segment, source };
  });
}

async function artifactRows(database, artifact) {
  return Promise.all([
    row(database, 'ModelContextProjection', artifact.projection.id),
    row(database, 'ContextSequenceRoot', artifact.root.id),
    row(database, 'ContextSequenceNode', artifact.node.id),
    row(database, 'ContextSegment', artifact.segment.id),
    row(database, 'ContextSegmentSource', artifact.source.id)
  ]);
}

test('再次合并已删除的分支时，完整私有句柄证据属于删除闭包，不复活对话或重新导入编号', async (t) => {
  const fixture = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(fixture.root));
  const artifact = await seedFork(fixture.alpha);
  const database = await kernel.RuntimeDatabase.open(fixture.current.authority,
    { hostBootId: `fork-merge-target-${randomUUID()}` });
  t.after(() => database.close());
  const merge = () => mergeHistoricalDataSetsOnline(fixture.paths,
    { configurationRootPath: fixture.root, database }, { candidateIds: [fixture.alpha.id], requested: true });

  const first = await merge();
  assert.deepEqual([first.failures, first.blocked, first.deferred], [[], [], []]);
  assert.deepEqual(first.merged.map(item => item.insertedConversations), [2]);
  const targetStore = new kernel.ContentAddressedStore(fixture.current.authority, database.binding);
  assert.deepEqual(await readForkContextHandleReservationCatalog(database, targetStore, FORK), CATALOG,
    'the first real merge copies the complete fork-owned address facts and CAS');

  const deleted = await new ConversationDeletionControlPlane(database).delete(FORK);
  assert.deepEqual(deleted?.deletedConversationIds, [FORK]);
  assert.equal(await row(database, 'Conversation', FORK), null);
  // Immutable Context is retained by dataset-reset-only policy. Its mere presence cannot prove
  // that a second merge skipped it, so inspect the closure in the real source SQLite as well.
  const afterDeletion = await artifactRows(database, artifact);
  const source = new Database(fixture.alpha.binding.paths.databasePath, { readonly: true });
  try {
    const skipped = HISTORICAL_MERGE_ENGINE.skippedRows(source, new Set([FORK]));
    for (const [domain, id] of [
      ['ModelContextProjection', artifact.projection.id], ['ContextSequenceRoot', artifact.root.id],
      ['ContextSequenceNode', artifact.node.id], ['ContextSegment', artifact.segment.id],
      ['ContextSegmentSource', artifact.source.id]
    ]) assert.equal(skipped.get(domain)?.has(id), true, `${domain} ${id} follows the deleted fork`);
    assert.equal(skipped.get('Conversation')?.has(SOURCE), false, 'the branch source remains independent');
    assert.equal(skipped.get('ContextSequenceRoot')?.has(`${SOURCE}_empty_root`), false);
  } finally { source.close(); }

  await seedConversations(fixture.alpha, [{ id: NEW }]);
  const sourceBefore = readAll(fixture.alpha);
  await requestRuntimeDataSetMerge(fixture.paths, { candidateId: fixture.alpha.id,
    expectedDataSetId: fixture.alpha.binding.dataSetId, expectedRootInstanceId: fixture.alpha.binding.rootInstanceId });
  const second = await merge();
  assert.deepEqual([second.failures, second.blocked, second.deferred], [[], [], []]);
  assert.deepEqual(second.merged.map(item => [item.insertedConversations, item.skippedConversations]), [[1, 1]]);
  assert.equal(await row(database, 'Conversation', FORK), null, 'the deleted fork is not reinserted');
  assert.ok(await row(database, 'Conversation', SOURCE));
  assert.ok(await row(database, 'Conversation', NEW), 'unrelated new history still merges');
  assert.deepEqual(await list(database, 'ConversationBranchLink', { target_conversation_id: FORK }), []);
  assert.deepEqual(await list(database, 'AgentConversationLink', { conversation_id: FORK }), []);
  assert.deepEqual(await list(database, 'ConversationContextHeadLink', { conversation_id: FORK }), []);
  assert.deepEqual(await artifactRows(database, artifact), afterDeletion,
    'the second merge does not change the retained private artifact or its address evidence');
  assert.deepEqual(readAll(fixture.alpha), sourceBefore, 'the source history and reservations remain unchanged');
  const target = new Database(fixture.current.binding.paths.databasePath, { readonly: true });
  try {
    assert.deepEqual(target.pragma('foreign_key_check'), []);
    assert.equal(target.pragma('quick_check', { simple: true }), 'ok');
  } finally { target.close(); }
});
