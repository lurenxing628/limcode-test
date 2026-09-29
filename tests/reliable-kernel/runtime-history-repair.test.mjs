import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  createConfigurationRoot, removeConfigurationRoot, seedConversations, withRuntime, modelRequestAggregate,
  Database, kernelFile, rawWrite, readAll, NOW, repo
} from './fixtures/runtime-merge-fixture.mjs';

const { inspectRuntimeHistoryRepair, repairRuntimeHistory, HISTORY_REPAIR_BACKUPS } = kernelFile('runtimeHistoryRepair.js');
const { inspectHistoryRepair, historyRepairPreservedDigest } = kernelFile('runtimeHistoryRepairInspection.js');
const { historyRepairMarker } = kernelFile('runtimeHistoryRepairTransaction.js');
const { mergeHistoricalDataSetsOnline } = kernelFile('runtimeDataSetMerge.js');
const { runtimeDataSetFileState } = kernelFile('runtimeDataSetFacts.js');
const { runtimeDataSetContentDigest } = kernelFile('runtimeDataSetContent.js');
const { withRuntimeMaintenance, withRuntimeDataRootAdmission } = kernelFile('runtimeHostControl.js');
const { RuntimeDatabase } = kernelFile('runtimeDatabase.js');

function sql(dataSet, read) {
  const db = new Database(dataSet.binding.paths.databasePath, { readonly: true });
  db.defaultSafeIntegers(true);
  try { return read(db); } finally { db.close(); }
}
async function seed(t) {
  const f = await createConfigurationRoot();
  t.after(() => removeConfigurationRoot(f.root));
  await seedConversations(f.alpha, [{ id: 'kept' }, { id: 'removed' }]);
  await withRuntime(f.alpha, async (db, store) => {
    const content = await store.ingest(db, '{}', 'application/json');
    await db.transaction([
      ...modelRequestAggregate('removed_turn', 'request_one', 1n, { recipe: content.id, body: content.id, checkpoints: 1 }),
      ...modelRequestAggregate('removed_turn', 'request_two', 2n, { recipe: content.id, body: content.id, checkpoints: 0, completed: false })
    ]);
  });
  rawWrite(f.alpha, (db) => {
    db.prepare("DELETE FROM conversation WHERE id = 'removed'").run();
    db.prepare(`INSERT INTO process VALUES ('process_unknown', 'exited', 'nonce', 2147483647, NULL, NULL,
      'fingerprint', 'digest', 'old-spool', 0, 0, 0, 0, ?, ?, ?)`).run(NOW, NOW, NOW);
    db.prepare(`INSERT INTO process_receipt VALUES
      ('receipt_unknown', 'process_unknown', 'outcome_unknown', NULL, NULL, 'nonce', 'fingerprint', ?)`).run(NOW);
  });
  f.target = { candidateId: f.alpha.id, expectedDataSetId: f.alpha.binding.dataSetId, expectedRootInstanceId: f.alpha.binding.rootInstanceId };
  return f;
}
async function backups(f) {
  return fs.readdir(path.join(path.dirname(f.alpha.binding.paths.dataRootPath), HISTORY_REPAIR_BACKUPS)).catch((e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
}
async function casDigest(f) {
  const hash = createHash('sha256');
  async function walk(root) {
    for (const name of (await fs.readdir(root)).sort()) {
      const file = path.join(root, name);
      if ((await fs.lstat(file)).isDirectory()) await walk(file);
      else hash.update(path.relative(f.alpha.binding.paths.casRootPath, file)).update(await fs.readFile(file));
    }
  }
  await walk(f.alpha.binding.paths.casRootPath);
  return hash.digest('hex');
}

test('只读盘点、完整备份、精确修复、保护所有非修复记录和 CAS、幂等重入，之后正常合并', async (t) => {
  const f = await seed(t);
  const before = readAll(f.alpha);
  const fileState = await runtimeDataSetFileState(f.alpha.binding.paths.databasePath);
  const cas = await casDigest(f);
  const plan = await inspectRuntimeHistoryRepair(f.paths, f.target);
  assert.deepEqual([plan.expected.orphanOperations, plan.expected.orphanAttempts, plan.expected.restoredUnknownProcesses, plan.expected.refused], [2, 2, 1, 0]);
  assert.deepEqual(readAll(f.alpha), before);
  assert.equal(await runtimeDataSetFileState(f.alpha.binding.paths.databasePath), fileState);
  assert.deepEqual(await backups(f), []);
  const result = await repairRuntimeHistory(f.paths, plan);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.result.removedOperations, 2);
  const backup = new Database(path.join(result.backupPath, 'limcode.sqlite'), { readonly: true });
  try {
    backup.defaultSafeIntegers(true);
    assert.equal(runtimeDataSetContentDigest(backup), plan.expected.contentDigest);
  } finally { backup.close(); }
  sql(f.alpha, (db) => {
    assert.equal(historyRepairPreservedDigest(db, historyRepairMarker(plan).key), plan.expected.preservedDigest);
    assert.equal(db.prepare('SELECT COUNT(*) FROM operation').pluck().get(), 0n);
    assert.equal(db.prepare('SELECT COUNT(*) FROM attempt').pluck().get(), 0n);
    assert.equal(db.prepare("SELECT status FROM process WHERE id = 'process_unknown'").pluck().get(), 'outcome_unknown');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
  });
  assert.equal(await casDigest(f), cas);
  const after = readAll(f.alpha);
  const again = await repairRuntimeHistory(f.paths, plan);
  assert.equal(again.result.alreadyApplied, true);
  assert.deepEqual(readAll(f.alpha), after);
  assert.equal((await backups(f)).length, 1);
  const checked = await inspectRuntimeHistoryRepair(f.paths, f.target);
  assert.equal(checked.previous[0].committed, true);
  assert.equal(checked.expected.orphanOperations, 0);
  await withRuntime(f.current, async (db) => {
    const report = await mergeHistoricalDataSetsOnline(f.paths, { configurationRootPath: f.root, database: db }, { candidateIds: [f.alpha.id], requested: true });
    assert.equal(report.merged.length, 1, JSON.stringify(report));
    assert.equal((await db.snapshot([repo('Conversation').get('removed')])).snapshot[0], null);
  });
});

for (const mutation of ['active', 'pause', 'effect', 'receipt-owner']) test(`非终态或保留依赖整份拒绝、不删除其他可修复项：${mutation}`, async (t) => {
  const f = await seed(t);
  rawWrite(f.alpha, (db) => {
    if (mutation === 'active') db.prepare("UPDATE operation SET status = 'running' WHERE id = 'request_one_operation'").run();
    if (mutation === 'pause') db.prepare("INSERT INTO outcome_pause VALUES ('pause', 'request_one_operation', 'open', 'reason', ?, ?)").run(NOW, NOW);
    if (mutation === 'effect') db.prepare(`INSERT INTO effect_intent VALUES ('intent', 'request_one_attempt', 'mcp_tool_call', 'dispatched',
      (SELECT id FROM content_object LIMIT 1), ?, ?)`).run(NOW, NOW);
    if (mutation === 'receipt-owner') db.prepare(`INSERT INTO effect_receipt VALUES ('receipt', 'other_attempt', 'mcp_tool_call', 'succeeded', NULL,
      NULL, NULL, 'request_one_operation', ?)`).run(NOW);
  });
  const before = readAll(f.alpha);
  const plan = await inspectRuntimeHistoryRepair(f.paths, f.target);
  assert.ok(plan.expected.refused > 0);
  await assert.rejects(repairRuntimeHistory(f.paths, plan), /不能自动清理/);
  assert.deepEqual(readAll(f.alpha), before);
  assert.deepEqual(await backups(f), []);
});

for (const completedAt of [null, '']) test(`未知回执不能补造缺失的完成时间，拒绝修复：${completedAt === null ? 'NULL' : '空字符串'}`, async (t) => {
  const f = await seed(t);
  rawWrite(f.alpha, (db) => db.prepare("UPDATE process SET completed_at = ? WHERE id = 'process_unknown'").run(completedAt));
  const before = readAll(f.alpha);
  const plan = await inspectRuntimeHistoryRepair(f.paths, f.target);
  assert.equal(plan.expected.restoredUnknownProcesses, 0);
  assert.equal(plan.expected.refused, 1);
  await assert.rejects(repairRuntimeHistory(f.paths, plan), /不能自动清理/);
  assert.deepEqual(readAll(f.alpha), before);
  assert.deepEqual(await backups(f), []);
});

test('确认前后发生任何数据库变化均拒绝，不能使用过时计划', async (t) => {
  const f = await seed(t);
  const plan = await inspectRuntimeHistoryRepair(f.paths, f.target);
  rawWrite(f.alpha, (db) => db.prepare("UPDATE conversation SET title = 'changed' WHERE id = 'kept'").run());
  const changed = readAll(f.alpha);
  await assert.rejects(repairRuntimeHistory(f.paths, plan), /发生了变化/);
  assert.deepEqual(readAll(f.alpha), changed);
  assert.deepEqual(await backups(f), []);
});

test('空间不足和备份后取消都不修改源库，保留备份后同一计划可安全重入', async (t) => {
  const f = await seed(t);
  const plan = await inspectRuntimeHistoryRepair(f.paths, f.target);
  const before = readAll(f.alpha);
  await assert.rejects(repairRuntimeHistory(f.paths, plan, { freeSpace: async () => 0 }), /磁盘空间不足/);
  assert.deepEqual(await backups(f), []);
  const controller = new AbortController();
  await assert.rejects(repairRuntimeHistory(f.paths, plan, {
    signal: controller.signal, onFaultPoint: (point) => { if (point === 'after-backup') controller.abort(); }
  }));
  assert.deepEqual(readAll(f.alpha), before);
  assert.equal((await backups(f)).length, 1);
  const inspected = await inspectRuntimeHistoryRepair(f.paths, f.target);
  assert.equal(inspected.previous[0].committed, false);
  const result = await repairRuntimeHistory(f.paths, plan);
  assert.equal(result.result.removedOperations, 2);
  assert.equal((await backups(f)).length, 1);
});

test('事务已经提交但结果日志失败，不把成功改报失败；库内标记恢复后不重复清理', async (t) => {
  const f = await seed(t);
  const plan = await inspectRuntimeHistoryRepair(f.paths, f.target);
  const result = await repairRuntimeHistory(f.paths, plan, {
    onFaultPoint: (point) => { if (point === 'before-completion') throw Object.assign(new Error('disk full at journal'), { code: 'ENOSPC' }); }
  });
  assert.equal(result.result.removedOperations, 2);
  assert.ok(result.warnings.length > 0);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.backupPath, 'repair.json'), 'utf8')).state, 'prepared');
  assert.equal((await inspectRuntimeHistoryRepair(f.paths, f.target)).previous[0].committed, true);
  assert.equal((await repairRuntimeHistory(f.paths, plan)).result.alreadyApplied, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.backupPath, 'repair.json'), 'utf8')).state, 'completed');
});

test('writer 在源变化时原子拒绝；真实运行时或已有维护事务不能调用修复', async (t) => {
  const f = await seed(t);
  const plan = await inspectRuntimeHistoryRepair(f.paths, f.target);
  await withRuntime(f.alpha, async (db) => {
    await assert.rejects(db.maintenanceRepairHistory(plan), /maintenance/);
    await assert.rejects(inspectRuntimeHistoryRepair(f.paths, f.target));
  });
  await withRuntimeDataRootAdmission(f.root, () => withRuntimeMaintenance(f.alpha.binding.paths, async () => {
    const db = await RuntimeDatabase.open(f.alpha.authority, { maintenance: true, hostBootId: 'repair-worker-fence' });
    try {
      await db.maintenanceBegin();
      await assert.rejects(db.maintenanceRepairHistory(plan), /maintenance transaction is open/);
      await db.maintenanceRollback();
      await db.transaction([repo('Conversation').update('kept', { title: 'later' })]);
      await assert.rejects(db.maintenanceRepairHistory(plan), /发生了变化/);
    } finally { await db.close(); }
  }));
  assert.equal(sql(f.alpha, (db) => inspectHistoryRepair(db).orphanOperations), 2);
});

test('当前库、硬链接和损坏的历史修复日志一律不修复', async (t) => {
  const f = await seed(t);
  await assert.rejects(inspectRuntimeHistoryRepair(f.paths, {
    candidateId: f.current.id, expectedDataSetId: f.current.binding.dataSetId, expectedRootInstanceId: f.current.binding.rootInstanceId
  }), /当前库/);
  const link = `${f.alpha.binding.paths.databasePath}.hardlink`;
  await fs.link(f.alpha.binding.paths.databasePath, link);
  await assert.rejects(inspectRuntimeHistoryRepair(f.paths, f.target), /独立的普通文件/);
  await fs.unlink(link);
  const plan = await inspectRuntimeHistoryRepair(f.paths, f.target);
  const result = await repairRuntimeHistory(f.paths, plan);
  await fs.writeFile(path.join(result.backupPath, 'repair.json'), '{broken');
  await assert.rejects(inspectRuntimeHistoryRepair(f.paths, f.target));
});

for (const point of ['after-backup', 'after-transaction']) test(`真实子进程被杀死后的恢复：${point}`, { timeout: 90_000 }, async (t) => {
  const f = await seed(t);
  const plan = await inspectRuntimeHistoryRepair(f.paths, f.target);
  const input = path.join(f.root, 'repair-test-plan.json');
  await fs.writeFile(input, JSON.stringify({ paths: f.paths, plan, point }));
  const child = spawn(process.execPath, ['tests/reliable-kernel/runtime-history-repair-child.mjs', input], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (bytes) => { stderr += bytes.toString(); });
  const outcome = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  assert.equal(outcome.signal, 'SIGKILL', stderr);
  const next = await inspectRuntimeHistoryRepair(f.paths, f.target);
  assert.equal(next.previous[0].committed, point === 'after-transaction');
  const repaired = await repairRuntimeHistory(f.paths, plan);
  assert.equal(repaired.result.alreadyApplied, point === 'after-transaction');
  assert.equal(sql(f.alpha, (db) => inspectHistoryRepair(db).orphanOperations), 0);
  assert.equal((await backups(f)).length, 1);
});
