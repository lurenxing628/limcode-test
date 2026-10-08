import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  createConfigurationRoot, removeConfigurationRoot, seedConversations, withRuntime,
  modelRequestAggregate, repo, kernel, kernelFile, Database, NOW, readAll, rawWrite
} from './fixtures/runtime-merge-fixture.mjs';

const { ConversationDeletionControlPlane } = kernelFile('conversationDeletion.js');
const { inspectUnfinishedWork, inspectCarriedWork } = kernelFile('runtimeDataSetMergeProbes.js');
const { createConversationRuntimeWorkProbe } = kernelFile('conversationRuntimePendingWork.js');
const { scanMergeRows } = kernelFile('runtimeDataSetStreamedMerge.js');
const { mergeHistoricalDataSetsOnline } = kernelFile('runtimeDataSetMerge.js');
const { inspectHistoryRepair } = kernelFile('runtimeHistoryRepairInspection.js');

async function fixture(t) {
  const value = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(value.root));
  await seedConversations(value.alpha, [{ id: 'kept' }, { id: 'deleted' }]);
  await withRuntime(value.alpha, async (db, store) => {
    const recipe = await store.ingest(db, '{}', 'application/json');
    await db.transaction([
      ...modelRequestAggregate('deleted_turn', 'gone_completed', 1n, { recipe: recipe.id, body: recipe.id, checkpoints: 1 }),
      ...modelRequestAggregate('deleted_turn', 'gone_cancelled', 2n, { recipe: recipe.id, body: recipe.id, checkpoints: 0, completed: false })
    ]);
  });
  return value;
}

function read(dataSet, body) {
  const db = new Database(dataSet.binding.paths.databasePath, { readonly: true });
  db.defaultSafeIntegers(true);
  try { return body(db); } finally { db.close(); }
}

function unknownProcess(db, { status = 'outcome_unknown', receipt = true, linked = true } = {}) {
  db.prepare(`INSERT INTO process VALUES ('old_process', ?, 'nonce', 2147483647, NULL, NULL,
    'fingerprint', 'digest', 'old-spool', 0, 0, 0, 0, ?, ?, ?)`).run(status, NOW, NOW, NOW);
  if (receipt) db.prepare(`INSERT INTO process_receipt VALUES
    ('old_receipt', 'old_process', 'outcome_unknown', NULL, NULL, 'nonce', 'fingerprint', ?)`).run(NOW);
  if (linked) db.prepare(`INSERT INTO process_completion_source_link VALUES
    ('old_process_source', 'old_process', 'kept', 'kept_turn', 'former_tool', ?)`).run(NOW);
}

test('正常删除已终态 ModelRequest 的对话，在同一事务内级联清理 Operation 和 Attempt', async (t) => {
  const f = await fixture(t);
  await withRuntime(f.alpha, async (db) => {
    const deletion = new ConversationDeletionControlPlane(db);
    assert.deepEqual((await deletion.delete('deleted')).deletedConversationIds, ['deleted']);
    assert.equal(await deletion.delete('deleted'), null);
  });
  read(f.alpha, (db) => {
    assert.equal(db.prepare('SELECT COUNT(*) FROM model_request').pluck().get(), 0n);
    assert.equal(db.prepare("SELECT COUNT(*) FROM operation WHERE owner_kind = 'model_request'").pluck().get(), 0n);
    assert.equal(db.prepare('SELECT COUNT(*) FROM attempt').pluck().get(), 0n);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.prepare("SELECT COUNT(*) FROM conversation WHERE id = 'kept'").pluck().get(), 1n);
  });
  await withRuntime(f.current, async (db) => {
    const report = await mergeHistoricalDataSetsOnline(f.paths, { configurationRootPath: f.root, database: db }, {
      candidateIds: [f.alpha.id], requested: true
    });
    assert.equal(report.merged.length, 1, JSON.stringify(report));
  });
});

test('删除事务后续断言失败时，ModelRequest、Operation、Attempt 与对话一起回滚', async (t) => {
  const f = await fixture(t);
  const before = readAll(f.alpha);
  await withRuntime(f.alpha, async (db) => {
    await assert.rejects(db.transaction([
      repo('Conversation').delete('deleted'), repo('Conversation').assert('intentionally_missing', {})
    ]));
  });
  assert.deepEqual(readAll(f.alpha), before);
});

test('按唯一键删除对话也清理模型执行记录，只影响该对话，保留其它请求和进程历史', async (t) => {
  const f = await fixture(t);
  await withRuntime(f.alpha, async (db, store) => {
    const recipe = await store.ingest(db, '{}', 'application/json');
    await db.transaction([
      ...modelRequestAggregate('kept_turn', 'retained_request', 1n, { recipe: recipe.id, body: recipe.id, checkpoints: 1 }),
      repo('Operation').insert({ id: 'retained_process_operation', owner_kind: 'process', owner_id: 'retained_process',
        operation_seq: 1n, tool_call_id: null, status: 'completed', created_at: NOW, updated_at: NOW }),
      repo('Attempt').insert({ id: 'retained_process_attempt', operation_id: 'retained_process_operation', attempt_seq: 1n,
        status: 'completed', created_at: NOW, updated_at: NOW, completed_at: NOW })
    ]);
    await db.transaction([repo('Conversation').deleteByUnique({ id: 'deleted' })]);
    const retained = (await db.snapshot([
      repo('ModelRequest').get('retained_request'), repo('Operation').get('retained_request_operation'),
      repo('Attempt').get('retained_request_attempt'), repo('Operation').get('retained_process_operation'),
      repo('Attempt').get('retained_process_attempt')
    ])).snapshot;
    assert.ok(retained.every((row) => row !== null));
  });
  read(f.alpha, (db) => {
    assert.equal(db.prepare("SELECT COUNT(*) FROM model_request WHERE id LIKE 'gone_%'").pluck().get(), 0n);
    assert.equal(db.prepare("SELECT COUNT(*) FROM operation WHERE owner_id LIKE 'gone_%'").pluck().get(), 0n);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  });
});

test('已收尾的未知结果进程可作为历史合并，保持未知结果，不放宽迁移的进程限制', async (t) => {
  const f = await fixture(t);
  rawWrite(f.alpha, (db) => unknownProcess(db));
  read(f.alpha, (db) => {
    assert.equal(createConversationRuntimeWorkProbe(db)('kept'), false);
    assert.deepEqual(inspectUnfinishedWork(db).refused, []);
    assert.equal(inspectCarriedWork(db).runningProcesses, 1);
  });
  await withRuntime(f.current, async (db) => {
    const result = await mergeHistoricalDataSetsOnline(f.paths, { configurationRootPath: f.root, database: db }, {
      candidateIds: [f.alpha.id], requested: true
    });
    assert.equal(result.merged.length, 1, JSON.stringify(result));
    const [process, receipt] = (await db.snapshot([repo('Process').get('old_process'), repo('ProcessReceipt').get('old_receipt')])).snapshot;
    assert.equal(process.status, 'outcome_unknown');
    assert.equal(receipt.outcome, 'outcome_unknown');
    assert.equal(receipt.exit_code, null);
    assert.equal(await db.hasConversationRuntimeWork('kept'), false);
  });
});

test('终态进程同时核对结果和退出元组：有效历史放行，矛盾证据在忙碌、合库与修复检查中均拒绝', async (t) => {
  const f = await fixture(t);
  const cases = [
    { name: '正常退出', outcome: 'succeeded', code: 0, signal: null, valid: true },
    { name: '非零退出', outcome: 'failed', code: 1, signal: null, valid: true },
    { name: '信号退出', outcome: 'failed', code: null, signal: 'SIGTERM', valid: true },
    { name: '手动停止后正常退出', status: 'cancelled', outcome: 'cancelled', code: 0, signal: null, valid: true },
    { name: '超时停止', status: 'timed_out', outcome: 'timed_out', code: null, signal: 'SIGTERM', valid: true },
    { name: '输出超限停止', status: 'output_limit_exceeded', outcome: 'output_limit_exceeded', code: 1, signal: null, valid: true },
    { name: '非零退出却说成功', outcome: 'succeeded', code: 1, signal: null, valid: false },
    { name: '信号退出却说成功', outcome: 'succeeded', code: null, signal: 'SIGTERM', valid: false },
    { name: '零退出却说失败', outcome: 'failed', code: 0, signal: null, valid: false },
    { name: '退出码与信号都有', outcome: 'succeeded', code: 0, signal: 'SIGTERM', valid: false },
    { name: '退出码与信号都没有', outcome: 'failed', code: null, signal: null, valid: false },
    { name: '信号为空', outcome: 'failed', code: null, signal: '', valid: false },
    { name: '状态与回执不匹配', outcome: 'cancelled', code: 1, signal: null, valid: false },
    { name: '缺少完成时间', outcome: 'succeeded', code: 0, signal: null, completed: false, valid: false }
  ];
  for (const spec of cases) {
    rawWrite(f.alpha, (db) => {
      db.prepare("DELETE FROM process_receipt WHERE process_id = 'old_process'").run();
      db.prepare("DELETE FROM process WHERE id = 'old_process'").run();
      db.prepare(`INSERT INTO process VALUES ('old_process', ?, 'nonce', 2147483647, 1, 1,
        'fingerprint', 'digest', 'old-spool', 0, 0, 0, 0, ?, ?, ?)`).run(spec.status ?? 'exited', NOW, NOW, spec.completed === false ? null : NOW);
      db.prepare(`INSERT INTO process_receipt VALUES
        ('old_receipt', 'old_process', ?, ?, ?, 'nonce', 'fingerprint', ?)`).run(spec.outcome, spec.code, spec.signal, NOW);
      db.prepare(`INSERT INTO process_completion_source_link VALUES
        ('old_process_source', 'old_process', 'kept', 'kept_turn', 'former_tool', ?)`).run(NOW);
    });
    read(f.alpha, (db) => {
      assert.equal(createConversationRuntimeWorkProbe(db)('kept'), !spec.valid, spec.name);
      assert.equal(inspectUnfinishedWork(db).refused.length === 0, spec.valid, spec.name);
      assert.equal(inspectHistoryRepair(db).refused === 0, spec.valid, spec.name);
    });
  }
});

test('矛盾退出结果只剔除所属对话，其余历史合并且来源不被猜测修复', async (t) => {
  const f = await fixture(t);
  rawWrite(f.alpha, (db) => {
    unknownProcess(db, { status: 'exited' });
    db.prepare("UPDATE process_receipt SET outcome = 'succeeded', exit_code = 1 WHERE id = 'old_receipt'").run();
  });
  const before = readAll(f.alpha);
  await withRuntime(f.current, async (db) => {
    const report = await mergeHistoricalDataSetsOnline(f.paths, { configurationRootPath: f.root, database: db }, {
      candidateIds: [f.alpha.id], requested: true
    });
    assert.deepEqual([report.blocked, report.failures, report.deferred], [[], [], []]);
    assert.equal(report.merged.length, 1);
    assert.deepEqual(report.merged[0].excluded.map(item => item.conversationId), ['kept']);
    assert.equal(report.merged[0].insertedConversations, 1);
  });
  assert.deepEqual(readAll(f.alpha), before);
  read(f.current, db => {
    assert.equal(db.prepare("SELECT COUNT(*) FROM conversation WHERE id='kept'").pluck().get(), 0n);
    assert.equal(db.prepare("SELECT COUNT(*) FROM conversation WHERE id='deleted'").pluck().get(), 1n);
    assert.equal(db.prepare('SELECT COUNT(*) FROM process').pluck().get(), 0n);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  });
  const record = (await kernelFile('runtimeDataSetMergeLedger.js').readRuntimeDataSetMergeLedger(f.paths)).get(f.alpha.id);
  assert.equal(record.state, 'partial');
});

test('进程观察不能把矛盾回执当作退出，单个及批量 spool 清理均保留结束证据', async (t) => {
  const f = await fixture(t);
  rawWrite(f.alpha, (db) => {
    unknownProcess(db, { status: 'exited' });
    db.prepare("UPDATE process SET child_pid = 1, process_group_id = 1, command_digest = ? WHERE id = 'old_process'").run('a'.repeat(64));
    db.prepare("UPDATE process_receipt SET outcome = 'succeeded', exit_code = 1 WHERE id = 'old_receipt'").run();
  });
  const spool = kernel.processSpoolPath(f.alpha.binding, 'old-spool');
  await fs.mkdir(spool, { recursive: true });
  const evidence = path.join(spool, 'evidence.txt');
  await fs.writeFile(evidence, 'preserved process evidence');
  await withRuntime(f.alpha, async (db, store) => {
    const effects = new kernel.EffectControlPlane(db, store);
    const processes = new kernel.ProcessControlPlane(db, store, effects, f.alpha.authority, f.alpha.binding);
    try {
      const observed = await processes.wait('old_process', 0);
      assert.equal(observed.state, 'outcome_unknown');
      assert.match(observed.reason, /outcome\/exit tuple mismatch/);
      assert.equal(await processes.cleanupArchivedSpool('old_process'), 'retained');
      assert.deepEqual(await processes.cleanupArchivedSpools(), { scanned: 1, removed: 0, alreadyAbsent: 0, retained: 1, failed: 0 });
      assert.equal(await fs.readFile(evidence, 'utf8'), 'preserved process evidence');
    } finally { await processes.dispose(); }
  });
});

for (const spec of [
  { name: '仍在运行', status: 'running', completedAt: null },
  { name: '终态缺少完成时间', status: 'exited', completedAt: null },
  { name: '终态完成时间为空', status: 'exited', completedAt: '' }
]) test(`有效退出元组也不能代替 Process 终态证据：${spec.name}`, async (t) => {
  const f = await fixture(t);
  rawWrite(f.alpha, (db) => {
    unknownProcess(db, { status: spec.status });
    db.prepare("UPDATE process SET child_pid = 1, process_group_id = 1, command_digest = ?, completed_at = ? WHERE id = 'old_process'")
      .run('a'.repeat(64), spec.completedAt);
    db.prepare("UPDATE process_receipt SET outcome = 'succeeded', exit_code = 0 WHERE id = 'old_receipt'").run();
  });
  const spool = kernel.processSpoolPath(f.alpha.binding, 'old-spool');
  await fs.mkdir(spool, { recursive: true });
  const evidence = path.join(spool, 'evidence.txt');
  await fs.writeFile(evidence, 'preserved terminal evidence');
  await withRuntime(f.alpha, async (db, store) => {
    const processes = new kernel.ProcessControlPlane(db, store, new kernel.EffectControlPlane(db, store), f.alpha.authority, f.alpha.binding);
    try {
      const observed = await processes.wait('old_process', 0);
      assert.equal(observed.state, 'outcome_unknown');
      assert.match(observed.reason, /terminal state\/time/);
      assert.equal(await processes.cleanupArchivedSpool('old_process'), 'retained');
      assert.equal(await fs.readFile(evidence, 'utf8'), 'preserved terminal evidence');
    } finally { await processes.dispose(); }
  });
});

for (const spec of [
  { name: '缺回执（即使没有对话链接）', options: { receipt: false, linked: false } },
  { name: '手动改成 exited 而回执仍为未知', options: { status: 'exited' } }
]) test(`未知结果的历史不能被错误放行：${spec.name}`, async (t) => {
  const f = await fixture(t);
  rawWrite(f.alpha, (db) => unknownProcess(db, spec.options));
  read(f.alpha, (db) => assert.ok(inspectUnfinishedWork(db).refused.length > 0));
});

test('双向预检：只剩 Operation/Attempt、父 ModelRequest 不存在时，在准备阶段拒绝', async (t) => {
  const f = await fixture(t);
  // Reproduce the released deletion bug without relying on the now-fixed public deletion API.
  rawWrite(f.alpha, (db) => db.prepare("DELETE FROM conversation WHERE id = 'deleted'").run());
  await withRuntime(f.current, async (target) => {
    const source = new Database(f.alpha.binding.paths.databasePath, { readonly: true });
    source.defaultSafeIntegers(true);
    try {
      const scan = await scanMergeRows(source, target, { chunkRows: 1 });
      assert.match(scan.refusedAggregate ?? '', /ModelRequest gone_.* does not exist/);
    } finally { source.close(); }
    const report = await mergeHistoricalDataSetsOnline(f.paths, { configurationRootPath: f.root, database: target }, {
      candidateIds: [f.alpha.id], requested: true
    });
    assert.equal(report.blocked[0]?.code, 'runtime-data-set-merge-invariant', JSON.stringify(report));
    assert.deepEqual(report.deferred, []);
  });
});

export { fixture, read, unknownProcess };

for (const variant of ['pending-notice', 'output-gap', 'wrong-identity', 'operation-pending', 'running']) {
  test(`未知结果仍有未收尾工作或证据矛盾时拒绝合并：${variant}`, async (t) => {
    const f = await fixture(t);
    rawWrite(f.alpha, (db) => {
      unknownProcess(db);
      if (variant === 'pending-notice') db.prepare(`INSERT INTO process_completion_dispatch
        (id, process_receipt_id, state, created_at, updated_at) VALUES ('dispatch', 'old_receipt', 'pending', ?, ?)`).run(NOW, NOW);
      if (variant === 'output-gap') db.prepare("UPDATE process SET retained_chunks = 1, retained_bytes = 2 WHERE id = 'old_process'").run();
      if (variant === 'wrong-identity') db.prepare("UPDATE process_receipt SET wrapper_nonce = 'other' WHERE id = 'old_receipt'").run();
      if (variant === 'operation-pending') db.prepare(`INSERT INTO operation VALUES
        ('pending_exit', 'process', 'old_process', 1, NULL, 'executing', ?, ?)`).run(NOW, NOW);
      if (variant === 'running') db.prepare("UPDATE process SET status = 'running', completed_at = NULL WHERE id = 'old_process'").run();
    });
    read(f.alpha, (db) => assert.ok(inspectUnfinishedWork(db).refused.length > 0));
  });
}

test('非终态模型请求不能借删除对话被悄悄清掉', async (t) => {
  const f = await fixture(t);
  rawWrite(f.alpha, (db) => db.prepare("UPDATE model_request SET status = 'streaming', terminal_state = NULL WHERE id = 'gone_completed'").run());
  const before = readAll(f.alpha);
  await withRuntime(f.alpha, async (db) => {
    await assert.rejects(db.transaction([repo('Conversation').delete('deleted')]), (error) => {
      assert.equal(error.code, 'RUNTIME_DATA_INVARIANT');
      assert.equal(error.domain, 'ModelRequest');
      assert.equal(error.recordId, 'gone_completed');
      return true;
    });
  });
  assert.deepEqual(readAll(f.alpha), before);
});

test('规则变化只使派生拒绝和审计缓存失效，不清除内容指纹、提交事实或删除闭包', async (t) => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const f = await fixture(t);
  rawWrite(f.alpha, (db) => unknownProcess(db));
  const { resolveVscodeRuntimeDataSet, resolveVscodeRuntimeMergeLedgerRoot } = kernelFile('vscodeRootAuthority.js');
  const ledger = kernelFile('runtimeDataSetMergeLedger.js');
  const { RUNTIME_MERGE_VALIDATION_REVISION, reusableRuntimeMergeRefusal } = kernelFile('runtimeMergeValidation.js');
  const candidate = await resolveVscodeRuntimeDataSet(f.paths, f.alpha.id);
  const fingerprint = await ledger.runtimeDataSetFingerprint(candidate);
  const target = { dataSetId: f.current.binding.dataSetId, rootInstanceId: f.current.binding.rootInstanceId };
  await ledger.writeRuntimeDataSetMergeLedgerRecord(f.paths, {
    candidateId: f.alpha.id, state: 'blocked', source: fingerprint, target,
    code: 'runtime-data-set-merge-unfinished-work', message: '旧探针把结果未知当作仍在运行'
  });
  const recordPath = path.join(resolveVscodeRuntimeMergeLedgerRoot(f.paths), 'records', `${f.alpha.id.replaceAll(':', '-')}.json`);
  const record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
  assert.equal(record.validationRevision, RUNTIME_MERGE_VALIDATION_REVISION);
  assert.equal(reusableRuntimeMergeRefusal(record), true);
  delete record.validationRevision;
  assert.equal(reusableRuntimeMergeRefusal(record), false);
  assert.equal(reusableRuntimeMergeRefusal({ ...record, code: 'runtime-data-set-merge-conflict' }), true);
  assert.equal(reusableRuntimeMergeRefusal({ ...record, state: 'committing' }), true);
  assert.equal(reusableRuntimeMergeRefusal({ ...record, state: 'merged' }), true);
  await fs.writeFile(recordPath, JSON.stringify(record));
  const { runtimeDataSetFileState } = kernelFile('runtimeDataSetFacts.js');
  await ledger.rememberRuntimeDataSetAudit(candidate, await runtimeDataSetFileState(f.alpha.binding.paths.databasePath), fingerprint, {
    rows: 100, bytes: 1000, databaseBytes: 1000, casObjects: 1, casBytes: 1,
    refusedWork: [{ label: '旧规则未知进程', count: 1 }], finalizableTurns: 0, finalizableIntents: 0
  });
  assert.ok(await ledger.readCachedRuntimeDataSetAudit(candidate));
  const auditPath = path.join(resolveVscodeRuntimeMergeLedgerRoot(f.paths), 'audits', `${f.alpha.id.replaceAll(':', '-')}.json`);
  const audit = JSON.parse(await fs.readFile(auditPath, 'utf8'));
  delete audit.validationRevision;
  await fs.writeFile(auditPath, JSON.stringify(audit));
  assert.equal(await ledger.readCachedRuntimeDataSetAudit(candidate), undefined);
  assert.deepEqual(await ledger.runtimeDataSetFingerprint(candidate), fingerprint);
  await withRuntime(f.current, async (db) => {
    const report = await mergeHistoricalDataSetsOnline(f.paths, { configurationRootPath: f.root, database: db });
    assert.equal(report.merged.length, 1, JSON.stringify(report));
  });
  assert.equal(JSON.parse(await fs.readFile(recordPath, 'utf8')).state, 'merged');
});

test('新规则下确定性数据错误只报告一次判断，未变化的来源不反复准备', async (t) => {
  const f = await fixture(t);
  rawWrite(f.alpha, (db) => db.prepare("DELETE FROM conversation WHERE id = 'deleted'").run());
  await withRuntime(f.current, async (db) => {
    const target = { configurationRootPath: f.root, database: db };
    const first = await mergeHistoricalDataSetsOnline(f.paths, target);
    assert.equal(first.blocked[0]?.code, 'runtime-data-set-merge-invariant');
    const second = await mergeHistoricalDataSetsOnline(f.paths, target);
    assert.equal(second.blocked[0]?.code, 'runtime-data-set-merge-invariant');
    assert.equal(second.blocked[0]?.newly, false);
    assert.equal(second.pendingSources, 0);
  });
});
