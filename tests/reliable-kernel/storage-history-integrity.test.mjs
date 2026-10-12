import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import test, { before, after } from 'node:test';
import {
  compiled, createHistoryFixture, openRuntime, openStore, seedConversation, modelAggregate,
  kernelFile, repo, readSql, rawSql, insertOrphan, insertUnknownProcess, captureFiles, Database, NOW
} from './fixtures/ci-storage-history.mjs';

const require = createRequire(import.meta.url);
const registry = kernelFile('runtimeHistoryRegistry.js');
const ledger = kernelFile('runtimeDataSetMergeLedger.js');
const { registerRuntimeHistoryConvergence } = kernelFile('runtimeHistoryConvergence.js');
const { resolveVscodeRuntimeDataSet, resolveVscodeRuntimeMergeLedgerRoot } = kernelFile('vscodeRootAuthority.js');
const facts = kernelFile('runtimeDataSetFacts.js');
const { ConversationDeletionControlPlane } = kernelFile('conversationDeletion.js');
const { inspectUnfinishedWork, inspectCarriedWork } = kernelFile('runtimeDataSetMergeProbes.js');
const { mergeHistoricalDataSetsOnline } = kernelFile('runtimeDataSetMerge.js');
const { inspectRuntimeHistoryRepair, repairRuntimeHistory, HISTORY_REPAIR_BACKUPS } = kernelFile('runtimeHistoryRepair.js');
const directorySync = require(path.join(compiled, 'backend/capabilities/filesystem/durableDirectorySync.js'));
let f, current, keptContent, repairTarget;

before(async () => {
  f = await createHistoryFixture();
  const source = await openRuntime(f.alpha);
  try {
    const store = openStore(f.alpha, source);
    keptContent = await seedConversation(source, store, 'kept', '完整保留的正文'.repeat(1500));
    await seedConversation(source, store, 'deleted');
    const recipe = await store.ingest(source, '{}', 'application/json');
    await source.transaction(modelAggregate('deleted_turn', 'deleted_request', recipe.id));
  } finally { await source.close(); }
  current = await openRuntime(f.current);
  repairTarget = { candidateId: f.alpha.id, expectedDataSetId: f.alpha.binding.dataSetId,
    expectedRootInstanceId: f.alpha.binding.rootInstanceId };
});
after(async () => { await current?.close(); if (f) await fs.rm(f.base, { recursive: true, force: true }); });
const backupRoot = () => path.join(path.dirname(f.alpha.binding.paths.dataRootPath), HISTORY_REPAIR_BACKUPS);
const backupNames = () => fs.readdir(backupRoot()).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
const orphanCount = () => readSql(f.alpha, db => db.prepare("SELECT COUNT(*) FROM operation WHERE owner_kind='model_request'").pluck().get());
const repairPlan = () => inspectRuntimeHistoryRepair(f.paths, repairTarget);

test('新来源只登记一次，残留须明确重试，通知记录跨重入保留', async () => {
  assert.equal(await registerRuntimeHistoryConvergence(f.paths), 1);
  assert.deepEqual([...(await registry.readRuntimeHistoryPending(f.paths)).keys()], [f.alpha.id]);
  await registry.removeRuntimeHistoryPending(f.paths, f.alpha.id);
  assert.equal(await registerRuntimeHistoryConvergence(f.paths), 0);
  await registry.writeRuntimeHistoryResidual(f.paths, { id: f.alpha.id, sourceKind: 'local',
    location: { kind: 'local', candidateId: f.alpha.id }, code: 'manual-retry', message: '保留', checkedAt: NOW });
  await registerRuntimeHistoryConvergence(f.paths);
  assert.equal((await registry.readRuntimeHistoryPending(f.paths)).has(f.alpha.id), false);
  await registry.requeueRuntimeHistoryResidual(f.paths, f.alpha.id, { id: f.alpha.id, sourceKind: 'local',
    location: { kind: 'local', candidateId: f.alpha.id }, reason: '用户重新核验', registeredAt: NOW });
  assert.equal((await registry.readRuntimeHistoryPending(f.paths)).get(f.alpha.id).reason, '用户重新核验');
  const notice = JSON.parse(await fs.readFile(path.join(resolveVscodeRuntimeMergeLedgerRoot(f.paths), 'notices/convergence.json'), 'utf8'));
  assert.deepEqual(notice.sourceIds, [f.alpha.id]);
  await registry.removeRuntimeHistoryPending(f.paths, f.alpha.id);
});

test('未变文件复用worker事实，文件状态改变后重新读取', async t => {
  const candidate = await resolveVscodeRuntimeDataSet(f.paths, f.alpha.id);
  const original = facts.readRuntimeDataSetFacts;
  let reads = 0;
  t.mock.method(facts, 'readRuntimeDataSetFacts', async (...args) => { reads++; return original(...args); });
  const first = await ledger.runtimeDataSetFingerprint(candidate);
  assert.deepEqual(await ledger.runtimeDataSetFingerprint(candidate), first);
  assert.equal(reads, 1);
  const later = new Date(Date.now() + 1000);
  await fs.utimes(f.alpha.binding.paths.databasePath, later, later);
  assert.deepEqual(await ledger.runtimeDataSetFingerprint(candidate), first);
  assert.equal(reads, 2);
});

test('删除终态请求对话精确清理模型Operation/Attempt，保留其它对话', async () => {
  const source = await openRuntime(f.alpha);
  try { await new ConversationDeletionControlPlane(source).delete('deleted'); }
  finally { await source.close(); }
  readSql(f.alpha, db => {
    assert.equal(db.prepare('SELECT COUNT(*) FROM operation').pluck().get(), 0n);
    assert.equal(db.prepare('SELECT COUNT(*) FROM attempt').pluck().get(), 0n);
    assert.equal(db.prepare('SELECT id FROM conversation').pluck().get(), 'kept');
  });
});

test('未知结果的匹配持久回执可合并为历史，仍不准迁移执行', async () => {
  insertUnknownProcess(f.alpha);
  readSql(f.alpha, db => {
    assert.deepEqual(inspectUnfinishedWork(db).refused, []);
    assert.equal(inspectCarriedWork(db).runningProcesses, 1);
  });
  const result = await mergeHistoricalDataSetsOnline(f.paths, { configurationRootPath: f.root, database: current },
    { candidateIds: [f.alpha.id], requested: true });
  assert.equal(result.merged.length, 1, JSON.stringify(result));
  const [process, receipt] = (await current.snapshot([
    repo('Process').get('history_unknown'), repo('ProcessReceipt').get('history_unknown_receipt')
  ])).snapshot;
  assert.equal(process.status, 'outcome_unknown');
  assert.equal(receipt.exit_code, null);
  assert.equal(receipt.exit_signal, null);
});

test('partial后的失败保留实际插入的对话来源和剔除清单', async () => {
  const source = { dataSetId: 'history-source', rootInstanceId: 'history-root', rootGeneration: 1,
    pointerRevision: 1, contentDigest: 'fixture' };
  const target = { dataSetId: f.current.binding.dataSetId, rootInstanceId: f.current.binding.rootInstanceId };
  const excluded = [{ conversationId: 'excluded', title: '剔除', code: 'conflict', count: 1 }];
  await ledger.writeRuntimeDataSetMergeLedgerRecord(f.paths, { candidateId: 'history-ledger', source, target,
    state: 'partial', mergedAt: NOW, insertedRows: 1, reusedRows: 0, insertedConversations: 1,
    insertedConversationIds: ['inserted'], excluded });
  await ledger.writeRuntimeDataSetMergeLedgerRecord(f.paths, { candidateId: 'history-ledger', source,
    state: 'failed', code: 'unreadable', message: '读取失败' });
  const record = (await ledger.readRuntimeDataSetMergeLedger(f.paths)).get('history-ledger');
  assert.deepEqual(record.mergedInto[0].conversationIds, ['inserted']);
  assert.deepEqual(record.lastMerged.excluded, excluded);
});

test('reset只补登residual，不自动排队，完整合并后不重复补登', async () => {
  const backup = path.join(f.root, registry.RUNTIME_RESET_BACKUPS_DIRECTORY, '2026-reset');
  await fs.mkdir(backup, { recursive: true });
  await registry.reconcileRuntimeResetBackups(f.paths);
  const residual = [...(await registry.readRuntimeHistoryResidual(f.paths)).values()].find(item => item.sourceKind === 'reset');
  assert.equal(residual.location.containerPath, backup);
  assert.equal((await registry.readRuntimeHistoryPending(f.paths)).has(residual.id), false);
  await ledger.writeRuntimeDataSetMergeLedgerRecord(f.paths, { candidateId: residual.id, state: 'merged',
    source: { dataSetId: 'reset-source', rootInstanceId: 'reset-root', rootGeneration: 1, pointerRevision: 1, contentDigest: 'fixture' },
    target: { dataSetId: f.current.binding.dataSetId, rootInstanceId: f.current.binding.rootInstanceId },
    mergedAt: NOW, insertedRows: 0, reusedRows: 0, insertedConversations: 0, insertedConversationIds: [] });
  await registry.removeRuntimeHistoryResidual(f.paths, residual.id);
  await registry.reconcileRuntimeResetBackups(f.paths);
  assert.equal((await registry.readRuntimeHistoryResidual(f.paths)).has(residual.id), false);
  assert.ok((await fs.stat(backup)).isDirectory());
});

test('修复先核对备份fsync，日志失败后按提交凭据重入，消息和正文保留', async t => {
  insertOrphan(f.alpha, 'exact');
  rawSql(f.alpha, db => db.prepare("UPDATE process SET status='exited' WHERE id='history_unknown'").run());
  const bodyFile = path.join(f.alpha.binding.paths.casRootPath, ...keptContent.storage_key.split('/'));
  const before = await captureFiles([bodyFile]);
  const kept = readSql(f.alpha, db => db.prepare("SELECT * FROM conversation WHERE id='kept'").get());
  const plan = await repairPlan();
  assert.deepEqual([plan.expected.orphanOperations, plan.expected.orphanAttempts, plan.expected.restoredUnknownProcesses], [1, 1, 1]);
  const parent = backupRoot();
  let backupPath, fail = true, transactions = 0;
  const original = directorySync.syncDirectoryDurably;
  t.mock.method(directorySync, 'syncDirectoryDurably', async (directory, ...args) => {
    if (path.dirname(directory) === parent) backupPath = directory;
    if (fail && directory === parent && backupPath
      && await fs.access(path.join(backupPath, 'repair.json')).then(() => true, () => false)) {
      throw Object.assign(new Error('injected backup-parent fsync'), { code: 'EIO' });
    }
    return original(directory, ...args);
  });
  const options = { onFaultPoint(point) {
    if (point === 'before-transaction') transactions++;
    if (point === 'before-completion') throw Object.assign(new Error('injected journal failure'), { code: 'ENOSPC' });
  } };
  await assert.rejects(repairRuntimeHistory(f.paths, plan, options), /injected backup-parent fsync/);
  assert.equal(transactions, 0);
  assert.equal(orphanCount(), 1n);
  assert.equal(readSql(f.alpha, db => db.prepare("SELECT status FROM process WHERE id='history_unknown'").pluck().get()), 'exited');
  fail = false;
  const result = await repairRuntimeHistory(f.paths, plan, options);
  assert.equal(result.backupPath, backupPath);
  assert.equal(transactions, 1);
  assert.equal(result.result.removedOperations, 1);
  assert.equal(result.result.restoredUnknownProcesses, 1);
  assert.ok(result.warnings.length > 0);
  assert.equal(orphanCount(), 0n);
  readSql(f.alpha, db => {
    assert.deepEqual(db.prepare("SELECT * FROM conversation WHERE id='kept'").get(), kept);
    assert.equal(db.prepare("SELECT status FROM process WHERE id='history_unknown'").pluck().get(), 'outcome_unknown');
  });
  const backup = new Database(path.join(result.backupPath, 'limcode.sqlite'), { readonly: true });
  try { assert.equal(backup.prepare("SELECT id FROM operation WHERE id='exact_operation'").pluck().get(), 'exact_operation'); }
  finally { backup.close(); }
  assert.deepEqual(await captureFiles([bodyFile]), before);
  const journal = path.join(result.backupPath, 'repair.json');
  assert.equal(JSON.parse(await fs.readFile(journal, 'utf8')).state, 'prepared');
  const again = await repairRuntimeHistory(f.paths, plan);
  assert.equal(again.result.alreadyApplied, true);
  assert.equal(JSON.parse(await fs.readFile(journal, 'utf8')).state, 'completed');
  assert.equal((await backupNames()).length, 1);
});

test('保留Effect依赖使整份修复拒绝，另一可清理孤儿也保留', async () => {
  insertOrphan(f.alpha, 'unsafe');
  insertOrphan(f.alpha, 'safe');
  rawSql(f.alpha, db => db.prepare(`INSERT INTO effect_intent VALUES ('unsafe_effect', 'unsafe_attempt',
    'mcp_tool_call', 'dispatched', ?, ?, ?)`).run(keptContent.id, NOW, NOW));
  try {
    const plan = await repairPlan();
    assert.ok(plan.expected.refused > 0);
    await assert.rejects(repairRuntimeHistory(f.paths, plan), /不能自动清理/);
    assert.equal(orphanCount(), 2n);
    assert.equal((await backupNames()).length, 1);
  } finally {
    rawSql(f.alpha, db => {
      db.prepare("DELETE FROM effect_intent WHERE id='unsafe_effect'").run();
      db.prepare("DELETE FROM operation WHERE id IN ('unsafe_operation','safe_operation')").run();
    });
  }
});

test('确认后的内容变化拒绝旧修复计划，不生成备份', async () => {
  insertOrphan(f.alpha, 'stale');
  try {
    const plan = await repairPlan();
    rawSql(f.alpha, db => db.prepare("UPDATE conversation SET title='确认后改名' WHERE id='kept'").run());
    await assert.rejects(repairRuntimeHistory(f.paths, plan), /发生了变化/);
    assert.equal(orphanCount(), 1n);
    assert.equal((await backupNames()).length, 1);
  } finally { rawSql(f.alpha, db => db.prepare("DELETE FROM operation WHERE id='stale_operation'").run()); }
});
