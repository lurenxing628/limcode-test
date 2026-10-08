import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  createConfigurationRoot, removeConfigurationRoot, seedConversations, seedCollaborationMessages,
  withRuntime, repo, kernelFile, Database, NOW
} from './fixtures/runtime-merge-fixture.mjs';

const { TurnControlPlane } = kernelFile('turnControlPlane.js');
const { emptyConversationContextHandleStateStep } = kernelFile('conversationContextHandleState.js');
const { createReliableKernelRuntimeServices } = kernelFile('runtimeServices.js');
const { inspectUnfinishedWork } = kernelFile('runtimeDataSetMergeProbes.js');
const { mergeHistoricalDataSetsOnline, MERGE_FINALIZATION_REASON } = kernelFile('runtimeDataSetMerge.js');
const authorityCompiler = {
  async compile(request) {
    return {
      turnId: request.turnId, executorAgentId: request.executorAgentId,
      executionPreset: { content: JSON.stringify({ providerConfigId: 'test', modelId: 'test' }) },
      authoritySnapshot: { content: JSON.stringify({
        kind: 'effective-turn-authority', turnId: request.turnId, executorAgentId: request.executorAgentId,
        modelProfile: { compressionThresholdTokens: 100000, contextWindowTokens: 128000,
          tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
        model: { providerConfigId: 'test', modelId: 'test' },
        policies: { toolPolicyId: 'test', systemPromptId: 'test' }
      }) }
    };
  }
};
const lease = database => ({ leaseOwnerId: 'fixture', hostBootId: database.hostBootId,
  leaseExpiresAt: new Date(Date.now() + 300000).toISOString(), executorAgentId: 'test' });

function read(dataSet, run) {
  const database = new Database(dataSet.binding.paths.databasePath, { readonly: true });
  database.defaultSafeIntegers(true);
  try { return run(database); } finally { database.close(); }
}

for (const kind of ['input', 'continuation', 'runtime_continuation']) {
  test(`merge cancels a public-API queued ${kind} before closing its active Turn`, async () => {
    const fixture = await createConfigurationRoot();
    try {
      const conversationId = `queued_${kind}`;
      await seedConversations(fixture.alpha, [{ id: conversationId }, { id: 'sender' }]);
      if (kind === 'runtime_continuation') {
        // An ordinary collaboration message may wait for the next Turn without a wake. A pending
        // automatic result or wake is deliberately a separate refusal case below.
        await seedCollaborationMessages(fixture.alpha, 'sender', conversationId, ['message']);
      }
      const { active, queued } = await withRuntime(fixture.alpha, async (database, store) => {
        await database.transaction([emptyConversationContextHandleStateStep(conversationId, NOW)]);
        const runtime = createReliableKernelRuntimeServices(database, store, { authorityCompiler });
        const turns = new TurnControlPlane(database, store, { authorityCompiler,
          prepareRuntimeContinuationSteps: id => runtime.collaboration.prepareWakeContinuationSteps(id) });
        const command = { conversationId, ...lease(database) };
        const active = await turns.input({ ...command, source: { kind: 'command', key: 'active' }, content: 'hello' });
        let queued;
        if (kind === 'runtime_continuation') {
          const delivery = await runtime.deliveries.create({ inboxItemId: 'message_inbox', targetConversationId: conversationId, phase: 'next_turn' });
          queued = await turns.runtimeContinuation({ ...command, source: { kind: 'internal', key: 'queued' },
            sourceTurnId: null, deliveryId: delivery.delivery.id });
        } else {
          queued = await turns[kind]({ ...command, source: { kind: 'command', key: 'queued' },
            sourceTurnId: active.turnId, content: 'wait for this reply' });
        }
        assert.equal(active.admitted, true);
        assert.equal(queued.admitted, false);
        return { active, queued };
      });
      const inspection = read(fixture.alpha, inspectUnfinishedWork);
      assert.deepEqual(inspection.refused, []);
      assert.deepEqual(inspection.intents.map(intent => intent.intentId), [queued.intentId]);
      await withRuntime(fixture.current, async (database, store) => {
        const report = await mergeHistoricalDataSetsOnline(fixture.paths,
          { configurationRootPath: fixture.root, database }, { candidateIds: [fixture.alpha.id], requested: true, confirmSettlement: async () => true });
        assert.deepEqual([report.failures, report.blocked, report.deferred], [[], [], []]);
        assert.equal(report.merged.length, 1);
        const { finalized } = report.merged[0];
        assert.deepEqual([finalized?.turns, finalized?.intents], [1, 1]);
        const backup = new Database(path.join(finalized.sourceBackupPath, 'limcode.sqlite'), { readonly: true });
        try {
          assert.equal(backup.prepare('SELECT state FROM turn_intent WHERE id = ?').pluck().get(queued.intentId), 'queued');
          assert.equal(backup.prepare('SELECT status FROM turn WHERE id = ?').pluck().get(active.turnId), 'active');
        } finally { backup.close(); }
        const targetTurns = new TurnControlPlane(database, store, {
          authorityCompiler: { async compile() { assert.fail('Merged history must not start another Turn'); } }
        });
        assert.equal(await targetTurns.admitNextQueued({ conversationId, ...lease(database) }), null);
        const [intent] = (await database.snapshot([repo('TurnIntent').get(queued.intentId)])).snapshot;
        assert.equal(intent.state, 'cancelled');
      });
      for (const dataSet of [fixture.alpha, fixture.current]) read(dataSet, database => {
        assert.equal(database.prepare('SELECT state FROM turn_intent WHERE id = ?').pluck().get(queued.intentId), 'cancelled');
        assert.deepEqual(database.prepare('SELECT terminal_status, reason FROM turn_termination WHERE turn_id = ?').get(active.turnId),
          { terminal_status: 'cancelled', reason: MERGE_FINALIZATION_REASON });
        assert.equal(database.prepare("SELECT COUNT(*) FROM turn WHERE status = 'active'").pluck().get(), 0n);
        assert.equal(database.prepare('SELECT COUNT(*) FROM turn').pluck().get(), 3n, 'no queued intent starts a Turn');
        for (const table of ['model_request', 'tool_call', 'operation', 'effect_intent']) {
          assert.equal(database.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0n, `merge never starts ${table}`);
        }
        assert.deepEqual(inspectUnfinishedWork(database), { refused: [], turns: [], intents: [] });
      });
    } finally { await removeConfigurationRoot(fixture.root); }
  });
}

test('a pending delivery excludes its conversation and retains its queued continuations', async () => {
  const fixture = await createConfigurationRoot();
  try {
    const conversationId = 'blocked_delivery';
    await seedConversations(fixture.alpha, [{ id: conversationId }, { id: 'sender' }]);
    await seedCollaborationMessages(fixture.alpha, 'sender', conversationId, ['pending']);
    const { active, queued, delivery } = await withRuntime(fixture.alpha, async (database, store) => {
      await database.transaction([emptyConversationContextHandleStateStep(conversationId, NOW)]);
      const runtime = createReliableKernelRuntimeServices(database, store, { authorityCompiler });
      const turns = new TurnControlPlane(database, store, { authorityCompiler });
      const command = { conversationId, ...lease(database) };
      const active = await turns.input({ ...command, source: { kind: 'command', key: 'active' }, content: 'hello' });
      const queued = await turns.continuation({ ...command, source: { kind: 'command', key: 'queued' },
        sourceTurnId: active.turnId, content: 'continue later' });
      const delivery = await runtime.deliveries.create({ inboxItemId: 'pending_inbox',
        targetConversationId: conversationId, targetTurnId: active.turnId, phase: 'current_turn' });
      return { active, queued, delivery: delivery.delivery };
    });
    const inspection = read(fixture.alpha, inspectUnfinishedWork);
    assert.ok(inspection.refused.some(item => item.label === '待投递的消息或唤醒'));
    await withRuntime(fixture.current, async database => {
      const report = await mergeHistoricalDataSetsOnline(fixture.paths,
        { configurationRootPath: fixture.root, database }, { candidateIds: [fixture.alpha.id], requested: true, confirmSettlement: async () => true });
      assert.equal(report.merged.length, 1);
      assert.equal(report.blocked.length, 0);
      assert.ok(report.merged[0].excluded.some(item => item.conversationId === conversationId));
      assert.deepEqual([report.failures, report.deferred], [[], []]);
      assert.equal((await database.snapshot([repo('Conversation').get(conversationId)])).snapshot[0], null);
    });
    read(fixture.alpha, database => {
      assert.equal(database.prepare('SELECT status FROM turn WHERE id = ?').pluck().get(active.turnId), 'active');
      assert.equal(database.prepare('SELECT state FROM turn_intent WHERE id = ?').pluck().get(queued.intentId), 'queued');
      assert.equal(database.prepare('SELECT state FROM runtime_delivery WHERE id = ?').pluck().get(delivery.id), 'pending');
      assert.equal(database.prepare('SELECT COUNT(*) FROM model_request').pluck().get(), 0n);
      assert.equal(database.prepare('SELECT COUNT(*) FROM tool_call').pluck().get(), 0n);
    });
  } finally { await removeConfigurationRoot(fixture.root); }
});
