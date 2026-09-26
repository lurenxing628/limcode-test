// Real SIGKILL at each phase of a data-root relocation (child: runtime-data-root-relocation-crash-child.mjs),
// then what the next startup does: the pointer names the old or the fully written new directory, the
// in-progress record undoes the target's changes, abandoned private copies are swept, and the same
// target can receive the relocation again.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  conversationIds, indexIds, kernel, planWithRuntime, relocate, relocation, RootAuthority, rootAuthority, selectedDataSet
} from './runtime-data-root-relocation-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { recoverInterruptedDataRootRelocation, sweepDataRootRelocationLeftovers, finalizeDataRootRelocation } = relocation;

async function runChild(t, scenario, kind) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `limcode-relocation-crash-${scenario}-`)));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const child = spawn(process.execPath, [path.join(here, 'runtime-data-root-relocation-crash-child.mjs'), scenario, base, kind], { stdio: 'inherit' });
  const signal = await new Promise((resolve) => child.on('exit', (_code, exitSignal) => resolve(exitSignal)));
  const log = await fs.readFile(path.join(base, 'child.log'), 'utf8').catch(() => '');
  const fixture = JSON.parse(await fs.readFile(path.join(base, 'fixture.json'), 'utf8'));
  const pointer = JSON.parse(await fs.readFile(path.join(base, 'pointer.json'), 'utf8'));
  return { base, signal, log, fixture, pointer };
}

async function assertOldHomeIntact(root) {
  const inspection = await rootAuthority.inspectVscodeRuntimeDataSets({ globalStoragePath: root });
  assert.deepEqual(inspection.problems, []);
  const selected = inspection.candidates.find((candidate) => candidate.selected);
  assert.equal(selected.id, 'default');
  assert.deepEqual(conversationIds(selected.runtimeDataRootPath), ['conversation_current_1', 'conversation_current_2']);
  const reopened = await kernel.RuntimeDatabase.open(new RootAuthority(() => selected.runtimeDataRootPath), { hostBootId: `restart-${Date.now()}` });
  await reopened.close();
  return selected;
}

for (const [scenario, kind] of [
  ['stage-precopy', 'empty'],
  ['precopy-backup', 'empty'],
  ['during-merge', 'empty'],
  ['before-complete-marker', 'empty'],
  ['before-publish', 'empty'],
  ['config-index', 'limcode'],
  ['during-merge', 'limcode'],
  ['before-complete-marker', 'limcode'],
  ['before-publish', 'limcode']
]) {
  test(`SIGKILL ${scenario}（${kind === 'empty' ? '空目标' : '已有 LimCode 目标'}）：指针不动，下次启动按进行中记录撤销新目录里的改动、清理临时副本，之后可以再次迁移`, async (t) => {
    const run = await runChild(t, scenario, kind);
    assert.equal(run.signal, 'SIGKILL', run.log);
    const { root, target, relocationId, pid } = run.fixture;
    assert.equal(run.pointer.dataRootPath, root, '指针仍是旧目录');
    assert.equal(run.pointer.pendingRelocation?.relocationId, relocationId);

    // Next startup: the owner is gone, its changes in the target are undone, its copies swept.
    assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId }), 'recovered');
    await sweepDataRootRelocationLeftovers(root);
    const selected = await assertOldHomeIntact(root);
    const controlRoot = path.dirname(selected.runtimeDataRootPath);
    assert.deepEqual((await fs.readdir(controlRoot)).filter((name) => name.includes(`-${pid}-`)), [], '旧目录控制根里没有预复制暂存');
    assert.deepEqual((await fs.readdir(os.tmpdir())).filter((name) => name.startsWith('limcode-') && name.includes(`-${pid}-`)), [], '临时目录里没有私有副本');
    if (kind === 'empty') {
      // A maintenance claim held by the killed process stays (the claim protocol never deletes a dead
      // claim or its tombstone); nothing else of the attempt does.
      const remaining = (await fs.readdir(target).catch(() => [])).filter((name) => !/\.runtime-maintenance(\.generation-.+)?$/.test(name));
      assert.deepEqual(remaining, [], '本次在新目录里做的改动全部撤销');
    } else {
      const existing = await selectedDataSet(target);
      assert.deepEqual(conversationIds(existing.runtimeDataRootPath), ['conversation_existing_1'], '目标库恢复到迁移之前');
      assert.deepEqual(await indexIds(path.join(target, 'agents')), ['agent-shared', 'agent-target-only'], '目标的设置索引完整');
      const shared = JSON.parse(await fs.readFile(path.join(target, 'agents', 'records', 'agent-shared.json'), 'utf8'));
      assert.equal(shared.agent.name, 'target version', '被替换的设置已放回');
      await assert.rejects(fs.stat(path.join(target, '.limcode-relocation-backups')), { code: 'ENOENT' });
      await assert.rejects(fs.stat(path.join(target, '.limcode-data-root-relocation.json')), { code: 'ENOENT' });
    }

    // The same target receives the relocation again.
    const current = { authority: new RootAuthority(() => selected.runtimeDataRootPath) };
    const fixture = { root, paths: { globalStoragePath: root }, current };
    const plan = await planWithRuntime(fixture, target);
    assert.deepEqual(plan.problems, []);
    assert.equal(plan.target.kind, kind);
    const { result } = await relocate(fixture, plan);
    assert.equal(result.merged.insertedConversations, 2);
    if (kind === 'limcode') {
      assert.deepEqual(await indexIds(path.join(target, 'agents')), ['agent-shared', 'agent-source-only', 'agent-target-only']);
    }
  });
}

test('SIGKILL 在切换指针之后：指针指向完整写好的新目录，打开后收尾删除日志；旧目录完整', async (t) => {
  const run = await runChild(t, 'after-publish', 'empty');
  assert.equal(run.signal, 'SIGKILL', run.log);
  const { root, target } = run.fixture;
  assert.equal(run.pointer.dataRootPath, target);
  assert.equal(run.pointer.pendingRelocation, undefined, '进行中记录随指针一起清除');
  const moved = await selectedDataSet(target);
  assert.deepEqual(conversationIds(moved.runtimeDataRootPath), ['conversation_current_1', 'conversation_current_2']);
  await finalizeDataRootRelocation(target);
  await assert.rejects(fs.stat(path.join(target, '.limcode-relocation-backups')), { code: 'ENOENT' }, '空目标没有被替换的设置：备份目录收尾后不留');
  await assertOldHomeIntact(root);
});

test('SIGKILL 在完成记录之后、切换指针之前，用户继续用旧目录改了对话：下次启动撤销那次迁移，再迁移到同一目录不冲突', async (t) => {
  const run = await runChild(t, 'before-publish', 'empty');
  assert.equal(run.signal, 'SIGKILL', run.log);
  const { root, target } = run.fixture;
  const selected = await assertOldHomeIntact(root);
  const current = { authority: new RootAuthority(() => selected.runtimeDataRootPath) };
  const { renameConversation } = await import('./runtime-data-root-relocation-fixture.mjs');
  await renameConversation(current, 'conversation_current_1', '重启后改名');
  // Even without the in-progress record (e.g. cleared by hand), the next relocation undoes that attempt first.
  const fixture = { root, paths: { globalStoragePath: root }, current };
  const plan = await planWithRuntime(fixture, target);
  assert.equal(plan.undoesEarlierAttempt, true);
  const { result } = await relocate(fixture, plan);
  assert.equal(result.merged.insertedConversations, 2);
});
