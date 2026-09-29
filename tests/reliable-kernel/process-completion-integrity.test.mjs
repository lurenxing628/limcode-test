import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createConfigurationRoot, removeConfigurationRoot, seedConversations, withRuntime,
  repo, kernel, kernelFile, rawWrite, NOW
} from './fixtures/runtime-merge-fixture.mjs';

const { ProcessCompletionDeliveryControlPlane } = kernelFile('processCompletionDelivery.js');
const COMPLETED_AT = '2026-09-25T23:59:59.000Z';
const RECEIVED_AT = NOW;
const SCAN_AT = '2026-09-30T00:00:00.000Z';

async function fixture(t, spec) {
  const value = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(value.root));
  await seedConversations(value.alpha, [{ id: 'kept' }]);
  rawWrite(value.alpha, (db) => {
    const objectId = db.prepare('SELECT id FROM content_object LIMIT 1').pluck().get();
    if (!spec.missingProcess) {
      db.prepare(`INSERT INTO process VALUES ('process', ?, 'nonce', 2147483647, 1, 1,
        'fingerprint', ?, 'missing-spool', 0, 0, 0, 0, ?, ?, ?)`)
        .run(spec.status ?? 'exited', 'a'.repeat(64), NOW, NOW, spec.completedAt === null ? null : COMPLETED_AT);
      db.prepare(`INSERT INTO process_completion_source_link VALUES
        ('source', 'process', 'kept', 'kept_turn', 'former_tool', ?)`)
        .run(NOW);
    }
    db.prepare(`INSERT INTO process_receipt VALUES
      ('receipt', 'process', ?, ?, ?, ?, 'fingerprint', ?)`)
      .run(spec.outcome, spec.code, spec.signal, spec.receiptNonce ?? 'nonce', RECEIVED_AT);
    db.prepare(`INSERT INTO operation VALUES
      ('exit_operation', 'process', 'process', 1, NULL, 'completed', ?, ?)`)
      .run(NOW, NOW);
    db.prepare(`INSERT INTO attempt VALUES
      ('exit_attempt', 'exit_operation', 1, 'completed', ?, ?, ?)`)
      .run(NOW, NOW, NOW);
    db.prepare(`INSERT INTO effect_intent VALUES
      ('exit_intent', 'exit_attempt', 'process_exit', 'receipt_written', ?, ?, ?)`)
      .run(objectId, NOW, NOW);
    db.prepare(`INSERT INTO process_completion_dispatch VALUES
      ('dispatch', 'receipt', 'pending', NULL, 0, NULL, 0, 0, NULL, NULL, NULL, ?, ?)`)
      .run(NOW, NOW);
  });
  return value;
}

async function scan(value, body) {
  return withRuntime(value.alpha, async (database, store) => {
    const effects = new kernel.EffectControlPlane(database, store);
    const processes = new kernel.ProcessControlPlane(database, store, effects, value.alpha.authority, value.alpha.binding);
    const deliveries = new kernel.RuntimeDeliveryControlPlane(database, store);
    const errors = [];
    const dispatcher = new ProcessCompletionDeliveryControlPlane(database, store, processes, deliveries, {
      now: () => SCAN_AT, onError: (detail) => errors.push(detail)
    });
    try {
      return await body({ database, store, processes, dispatcher, errors });
    } finally {
      await dispatcher.dispose();
      await processes.dispose();
    }
  });
}

const INVALID = [
  { name: '非零退出却声称成功', outcome: 'succeeded', code: 1, signal: null },
  { name: '零退出却声称失败', outcome: 'failed', code: 0, signal: null },
  { name: '退出码和信号同时存在', outcome: 'succeeded', code: 0, signal: 'SIGTERM' },
  { name: '回执已经成功但 Process 仍在运行', status: 'running', outcome: 'succeeded', code: 0, signal: null },
  { name: '缺少完成时间', outcome: 'succeeded', code: 0, signal: null, completedAt: null },
  { name: 'Process 状态与取消回执不匹配', outcome: 'cancelled', code: 0, signal: null },
  { name: '未知结果被误改为 exited', outcome: 'outcome_unknown', code: null, signal: null },
  { name: '结束回执身份不匹配', outcome: 'succeeded', code: 0, signal: null, receiptNonce: 'wrong-nonce' },
  { name: 'Process 已经缺失', outcome: 'succeeded', code: 0, signal: null, missingProcess: true }
];

for (const spec of INVALID) test(`完成通知拒绝矛盾或缺失的结束证据：${spec.name}`, async (t) => {
  const value = await fixture(t, spec);
  await scan(value, async ({ database, dispatcher, errors }) => {
    const before = (await database.snapshot([repo('ContentObject').list({ limit: 100 })])).snapshot[0];
    const report = await dispatcher.scanNow();
    assert.equal(report.receiptsScanned, 1);
    assert.equal(report.failures, 1);
    assert.equal(report.completionsCreated, 0);
    assert.equal(report.deliveriesCreated, 0);
    assert.equal(report.wakesCreated, 0);
    const [dispatch, inboxes, payloads, deliveries, wakes, objects] = (await database.snapshot([
      repo('ProcessCompletionDispatch').get('dispatch'),
      repo('RuntimeInboxItem').list({ limit: 100 }),
      repo('RuntimeInboxPayloadLink').list({ limit: 100 }),
      repo('RuntimeDelivery').list({ limit: 100 }),
      repo('RuntimeDeliveryWake').list({ limit: 100 }),
      repo('ContentObject').list({ limit: 100 })
    ])).snapshot;
    assert.equal(dispatch.state, 'pending');
    assert.equal(dispatch.failure_count, 1n);
    assert.equal(dispatch.completed_at, null);
    assert.deepEqual([inboxes, payloads, deliveries, wakes], [[], [], [], []]);
    assert.deepEqual(objects, before, '不能为无效证据发布完成通知正文');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].error.code, 'RUNTIME_DATA_INVARIANT');
    assert.match(errors[0].error.message, /inconsistent terminal receipt evidence/);
  });
});

const VALID = [
  { name: '自然成功退出', outcome: 'succeeded', code: 0, signal: null },
  { name: '自然非零退出', outcome: 'failed', code: 1, signal: null },
  { name: '信号退出', outcome: 'failed', code: null, signal: 'SIGTERM' },
  { name: '用户停止', status: 'cancelled', outcome: 'cancelled', code: 0, signal: null },
  { name: '超时停止', status: 'timed_out', outcome: 'timed_out', code: null, signal: 'SIGTERM' },
  { name: '输出超限停止', status: 'output_limit_exceeded', outcome: 'output_limit_exceeded', code: 1, signal: null },
  { name: '已结束观测但结果未知', status: 'outcome_unknown', outcome: 'outcome_unknown', code: null, signal: null }
];

for (const spec of VALID) test(`匹配的持久结束证据正常发送完成通知：${spec.name}`, async (t) => {
  const value = await fixture(t, spec);
  await scan(value, async ({ database, store, dispatcher, errors }) => {
    const report = await dispatcher.scanNow();
    assert.equal(report.failures, 0);
    assert.equal(report.completionsCreated, 1);
    assert.equal(report.deliveriesCreated, 1);
    assert.equal(report.wakesCreated, 1);
    const [process, receipt, links, dispatch] = (await database.snapshot([
      repo('Process').get('process'), repo('ProcessReceipt').get('receipt'),
      repo('RuntimeInboxPayloadLink').list({ limit: 100 }), repo('ProcessCompletionDispatch').get('dispatch')
    ])).snapshot;
    const [content] = (await database.snapshot([repo('ContentObject').get(links[0].content_object_id)])).snapshot;
    const payload = JSON.parse((await store.read(content)).toString('utf8'));
    assert.equal(payload.outcome, spec.outcome);
    assert.equal(payload.exitCode, spec.code === null ? null : String(spec.code));
    assert.equal(payload.signal, spec.signal);
    assert.equal(payload.completedAt, COMPLETED_AT, '使用核实的完成时间，不能用收到回执时间替代');
    assert.notEqual(payload.completedAt, RECEIVED_AT);
    assert.equal(process.status, spec.status ?? 'exited');
    assert.equal(receipt.outcome, spec.outcome);
    assert.equal(dispatch.state, 'completed');
    assert.deepEqual(errors, []);
    const repeated = await dispatcher.scanNow();
    assert.equal(repeated.completionsCreated, 0);
    assert.equal(repeated.deliveriesCreated, 0);
  });
});

test('创建完成通知前结束证据发生变化时，提交断言拒绝，不能留下可投递通知', async (t) => {
  const value = await fixture(t, { outcome: 'succeeded', code: 0, signal: null });
  await scan(value, async ({ database, processes, dispatcher }) => {
    const reconcileOutput = processes.reconcileOutput.bind(processes);
    processes.reconcileOutput = async (processId) => {
      // Reproduce a change after the coherent read, before the notification transaction.
      await database.transaction([repo('Process').update(processId, { status: 'running', completed_at: null })]);
      return reconcileOutput(processId);
    };
    const report = await dispatcher.scanNow();
    assert.equal(report.failures, 1);
    assert.equal(report.completionsCreated, 0);
    assert.equal(report.deliveriesCreated, 0);
    const [inboxes, deliveries] = (await database.snapshot([
      repo('RuntimeInboxItem').list({ limit: 100 }), repo('RuntimeDelivery').list({ limit: 100 })
    ])).snapshot;
    assert.deepEqual(inboxes, []);
    assert.deepEqual(deliveries, []);
  });
});
