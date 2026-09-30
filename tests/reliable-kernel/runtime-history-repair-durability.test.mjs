import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  createConfigurationRoot, removeConfigurationRoot, seedConversations, withRuntime,
  modelRequestAggregate, kernelFile, compiled, rawWrite, readAll, Database
} from './fixtures/runtime-merge-fixture.mjs';

const require = createRequire(import.meta.url);
const directorySync = require(path.join(compiled, 'backend/capabilities/filesystem/durableDirectorySync.js'));
const { inspectRuntimeHistoryRepair, repairRuntimeHistory, HISTORY_REPAIR_BACKUPS } = kernelFile('runtimeHistoryRepair.js');
const { historyRepairWasCommitted } = kernelFile('runtimeHistoryRepairTransaction.js');
const { runtimeDataSetContentDigest } = kernelFile('runtimeDataSetContent.js');

// Fail actual publication barriers after the prepared journal becomes visible, rather than an
// onFaultPoint after a fully durable backup. Each retry uses the same real SQLite backup and plan.
for (const boundary of ['backup-directory', 'backup-parent', 'control-root']) {
  test(`修复备份目录 fsync 失败后重试仍不修改源库，持久化成功后仅提交一次：${boundary}`, async (t) => {
    const f = await createConfigurationRoot();
    t.after(() => removeConfigurationRoot(f.root));
    await seedConversations(f.alpha, [{ id: 'kept' }, { id: 'removed' }]);
    await withRuntime(f.alpha, async (db, store) => {
      const content = await store.ingest(db, '{}', 'application/json');
      await db.transaction(modelRequestAggregate('removed_turn', 'orphan', 1n, {
        recipe: content.id, body: content.id, checkpoints: 0, completed: false
      }));
    });
    rawWrite(f.alpha, (db) => db.prepare("DELETE FROM conversation WHERE id = 'removed'").run());
    const target = {
      candidateId: f.alpha.id, expectedDataSetId: f.alpha.binding.dataSetId,
      expectedRootInstanceId: f.alpha.binding.rootInstanceId
    };
    const plan = await inspectRuntimeHistoryRepair(f.paths, target);
    assert.equal(plan.expected.orphanOperations, 1);
    const before = readAll(f.alpha);
    const controlRoot = path.dirname(f.alpha.binding.paths.dataRootPath);
    const backupParent = path.join(controlRoot, HISTORY_REPAIR_BACKUPS);
    let backupPath;
    let failing = true;
    let failures = 0;
    let transactions = 0;
    const synced = [];
    const originalSync = directorySync.syncDirectoryDurably;
    t.mock.method(directorySync, 'syncDirectoryDurably', async (directory, ...args) => {
      if (path.dirname(directory) === backupParent) backupPath = directory;
      const failedDirectory = boundary === 'backup-directory' ? backupPath
        : boundary === 'backup-parent' ? backupParent : controlRoot;
      // The first backup-directory sync publishes RootBinding; fail the later journal publish.
      const prepared = backupPath && await fs.access(path.join(backupPath, 'repair.json')).then(() => true, () => false);
      if (failing && prepared && directory === failedDirectory) {
        failures++;
        throw Object.assign(new Error('injected repair backup directory fsync failure'), { code: 'EIO' });
      }
      const result = await originalSync(directory, ...args);
      synced.push(directory);
      return result;
    });
    const options = { onFaultPoint(point) {
      if (point !== 'before-transaction') return;
      transactions++;
      if (!failing) assert.deepEqual(synced.filter((directory) => [backupPath, backupParent, controlRoot].includes(directory)).slice(-3),
        [backupPath, backupParent, controlRoot], 'all backup directories must be synced before the transaction');
    } };
    let savedBackup;
    for (let attempt = 1; attempt <= 2; attempt++) {
      await assert.rejects(repairRuntimeHistory(f.paths, plan, options), /injected repair backup directory fsync failure/);
      assert.equal(failures, attempt, 'retry must reach the previously failed barrier again');
      assert.equal(transactions, 0);
      assert.deepEqual(readAll(f.alpha), before, 'failure must preserve all source records');
      assert.equal((await fs.readdir(backupParent)).length, 1, 'reuse the prepared backup');
      assert.equal(JSON.parse(await fs.readFile(path.join(backupPath, 'repair.json'), 'utf8')).state, 'prepared');
      const inspection = await inspectRuntimeHistoryRepair(f.paths, target);
      assert.equal(inspection.previous.length, 1);
      assert.equal(inspection.previous[0].committed, false);
      const bytes = await fs.readFile(path.join(backupPath, 'limcode.sqlite'));
      if (savedBackup) assert.deepEqual(bytes, savedBackup);
      savedBackup = bytes;
    }
    failing = false;
    synced.length = 0;
    const repaired = await repairRuntimeHistory(f.paths, plan, options);
    assert.deepEqual(repaired.warnings, []);
    assert.equal(repaired.backupPath, backupPath);
    assert.equal(repaired.result.removedOperations, 1);
    assert.equal(repaired.result.alreadyApplied, false);
    assert.equal(transactions, 1);
    const after = readAll(f.alpha);
    const again = await repairRuntimeHistory(f.paths, plan, options);
    assert.equal(again.result.alreadyApplied, true);
    assert.equal(transactions, 1, 'committed repair is not repeated');
    assert.deepEqual(readAll(f.alpha), after);
    assert.equal((await fs.readdir(backupParent)).length, 1);
    assert.deepEqual(await fs.readFile(path.join(backupPath, 'limcode.sqlite')), savedBackup);
    const backup = new Database(path.join(backupPath, 'limcode.sqlite'), { readonly: true });
    try {
      backup.defaultSafeIntegers(true);
      assert.equal(runtimeDataSetContentDigest(backup), plan.expected.contentDigest);
      assert.equal(historyRepairWasCommitted(backup, plan), false);
    } finally { backup.close(); }
    assert.equal((await inspectRuntimeHistoryRepair(f.paths, target)).previous[0].committed, true);
  });
}
