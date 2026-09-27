import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createConfigurationRoot, kernel, kernelFile, modelRequestAggregate, NOW, repo, seedConversations, withRuntime } from './fixtures/runtime-merge-fixture.mjs';

// The worker's maintenance transaction (RuntimeDatabase.open(authority, { maintenance: true })): one
// write transaction over several requests of a private offline instance, as a large-merge session
// streams one historical source into it (runtimeDataSetStreamedMerge.ts).
const { withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');

async function fixtureFor(t, options) {
  const fixture = await createConfigurationRoot(options);
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  return fixture;
}

function openWindow(fixture) {
  return kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `window-${randomUUID()}` });
}

test('维护事务：只在持有维护声明的维护实例上可用，打开期间拒绝其它写，追加失败整笔回滚，跨块缺 Operation 在提交时被抓到，跨块的历史复制与序号分配照常成立，提交后回到 NORMAL 并可截断预写日志', async (t) => {
  const fixture = await fixtureFor(t);
  await seedConversations(fixture.current, [{ id: 'conversation_seed' }]);
  const recipe = await withRuntime(fixture.current, (runtime, store) => store.ingest(runtime, '{}', 'application/json'));
  const normal = await openWindow(fixture);
  try {
    await assert.rejects(normal.maintenanceBegin(), /opened for maintenance/, '普通实例在宿主侧被拒');
    await assert.rejects(normal.sendRequest({ kind: 'maintenanceBegin' }), /opened for maintenance/, '普通实例在 worker 侧同样被拒');
  } finally { await normal.close(); }
  await assert.rejects(kernel.RuntimeDatabase.open(fixture.current.authority, { maintenance: true }), /maintenance claim/, '不持有维护声明不能打开维护实例');
  const online = await openWindow(fixture);
  try {
    await withRuntimeMaintenance(fixture.current.binding.paths, () => assert.rejects(
      kernel.RuntimeDatabase.open(fixture.current.authority, { maintenance: true }), { code: 'runtime-hosts-active' }, '有窗口在线时不能打开维护实例'));
  } finally { await online.close(); }
  await withRuntimeMaintenance(fixture.current.binding.paths, async () => {
    const database = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `historical-merge-${randomUUID()}`, maintenance: true });
    try {
      assert.throws(() => database.onCommit(() => {}), /no commit listeners/);
      await assert.rejects(database.snapshotAndSubscribe([], () => {}), /no commit listeners/);
      const conversation = (id) => repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW });
      const turn = (conversationId) => repo('Turn').insert({
        id: `${conversationId}_turn`, conversation_id: conversationId, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW
      });
      const aggregate = (id) => modelRequestAggregate('conversation_seed_turn', id, 9n, { recipe: recipe.id, body: recipe.id, checkpoints: 2 });
      const message = (id) => repo('CollaborationMessage').insertWithNextSequence({ id, dedupe_key: `dedupe-${id}`, mode: 'message', created_at: NOW }, { column: 'message_seq', scope: {} });
      const present = async (domain, id) => (await database.snapshot([repo(domain).get(id)])).snapshot[0] !== null;

      // Across chunks the aggregate is asserted once, at the commit: a request whose Operation never came.
      await database.maintenanceBegin();
      assert.equal((await database.inspect()).synchronous, 2n, '事务期间 synchronous = FULL，提交即落盘');
      await assert.rejects(database.transaction([conversation('conversation_refused')]), /maintenance transaction is open/);
      await assert.rejects(database.maintenanceBegin(), /maintenance transaction is open/);
      const [operation, attempt, request, ...stream] = aggregate('request_without_operation');
      await database.maintenanceAppend([request]);
      await database.maintenanceAppend([conversation('conversation_in_failed_transaction')]);
      await assert.rejects(database.maintenanceCommit(), /must own exactly one Operation/);
      assert.equal(await present('ModelRequest', 'request_without_operation'), false);
      assert.equal(await present('Conversation', 'conversation_in_failed_transaction'), false, '提交失败整笔回滚');
      assert.deepEqual(await database.maintenanceRollback(), { rolledBack: false });

      // The same aggregate spread over four chunks commits: request, then Operation and Attempt, then its
      // stream facts (copies of a request the same transaction copied three chunks earlier). Sequences
      // are allocated across chunks as in one transaction, and only counted in the result.
      const [operation2, attempt2, request2, ...stream2] = aggregate('request_across_chunks');
      await database.maintenanceBegin();
      await database.maintenanceAppend([conversation('conversation_across'), turn('conversation_across'), message('message_across_1')]);
      await database.maintenanceAppend([request2, message('message_across_2')]);
      await database.maintenanceAppend([operation2, attempt2]);
      await database.maintenanceAppend(stream2);
      assert.equal(await present('ModelRequest', 'request_across_chunks'), false, '提交前读连接只看到已提交状态');
      const committed = await database.maintenanceCommit();
      assert.deepEqual([committed.snapshotRequired, committed.allocatedSequences, committed.changes], [true, 2, undefined], '不回传 changes，分配记录只给计数');
      assert.equal(await present('ModelRequest', 'request_across_chunks'), true);
      const sequences = (await database.snapshot(['message_across_1', 'message_across_2'].map((id) => repo('CollaborationMessage').get(id)))).snapshot;
      assert.deepEqual(sequences.map((row) => row.message_seq), [1n, 2n], '跨块分配的序号连续');
      const inspected = await database.inspect();
      assert.deepEqual([inspected.synchronous, inspected.durableCommitCount], [1n, 1], '提交落盘后回到 NORMAL');
      const checkpoint = await database.maintenanceCheckpoint();
      assert.equal(checkpoint.busy, 0);
      assert.equal((await fs.stat(`${fixture.current.binding.paths.databasePath}-wal`)).size, 0, 'TRUNCATE 收回预写日志');
      void operation; void attempt; void stream;

      // A copied stream fact needs its request copied by the same transaction: a committed one is not.
      await database.maintenanceBegin();
      await assert.rejects(database.maintenanceAppend([repo('ModelStreamCheckpoint').insertHistoricalCopy({
        id: 'request_across_chunks_checkpoint_9', model_request_id: 'request_across_chunks', attempt_seq: 1n, socket_generation: 0n,
        stream_seq: 9n, checkpoint_kind: 'output_delta', content_object_id: recipe.id, created_at: NOW
      })]), /copied in the same transaction/);
      await assert.rejects(database.maintenanceCommit(), /No maintenance transaction is open/, '追加失败已整笔回滚');

      // A failed chunk ends the whole transaction.
      await database.maintenanceBegin();
      await database.maintenanceAppend([conversation('conversation_rolled_back')]);
      await assert.rejects(database.maintenanceAppend([conversation('conversation_rolled_back')]), /UNIQUE/);
      await assert.rejects(database.maintenanceCommit(), /No maintenance transaction is open/);
      assert.equal(await present('Conversation', 'conversation_rolled_back'), false);
      assert.equal((await database.inspect()).synchronous, 1n);
      // Other writes work again once it ended.
      await database.transaction([conversation('conversation_after')]);
      assert.equal(await present('Conversation', 'conversation_after'), true);
    } finally { await database.close(); }
  });
});
