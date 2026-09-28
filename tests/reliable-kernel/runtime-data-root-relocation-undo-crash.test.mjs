// Real SIGKILL at every durable step of a relocation and inside the undo itself (reloc2 review's 72
// points plus the undo's own steps), then what the next startup does: the undo is always finished
// (whatever the first kill or the interrupted undo left), the target is exactly as before, copied
// data renamed aside is back, and the target receives the relocation again (also after a kill between
// the merge's commit and the journal entry of its fingerprint: the rows journaled before the commit
// show that only the relocation wrote there). The old directory is
// never touched. Child: runtime-data-root-relocation-undo-crash-child.mjs; runs against the compiled dist.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  conversationIds, indexIds, kernel, planWithRuntime, relocate, relocation, RootAuthority, rootAuthority, selectedDataSet, treeSnapshot
} from './runtime-data-root-relocation-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const { recoverInterruptedDataRootRelocation, finalizeDataRootRelocation } = relocation;
const ONLY = process.env.RELOCATION_CRASH_ONLY ? new Set(process.env.RELOCATION_CRASH_ONLY.split(',')) : undefined;

function child(base, scenario, kind, phase) {
  const run = spawn(process.execPath, [path.join(here, 'runtime-data-root-relocation-undo-crash-child.mjs'), scenario, base, kind, phase], { stdio: 'inherit' });
  return new Promise((resolve) => run.on('exit', (code, signal) => resolve({ code, signal })));
}

// Left by a killed process like its claims: the liveness record of the merge's session on the
// receiving data set (killed inside the merge transaction, e.g. at its 'merging' journal entry);
// a dead process's record never counts as online.
const noise = (file) => /\.runtime-(maintenance|admission)/.test(file) || file.endsWith('-shm') || /[\\/]cas[\\/]sha256[\\/]/.test(file)
  || /[\\/]host-liveness[\\/]/.test(file);
function diffSnapshots(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)].filter((key) => !noise(key)));
  const diff = [];
  for (const key of [...keys].sort()) {
    if (before[key] !== after[key]) diff.push(`${key}: ${before[key] ? 'changed/removed' : 'added'}`);
  }
  return diff;
}

async function assertOldHomeIntact(root) {
  const inspection = await rootAuthority.inspectVscodeRuntimeDataSets({ globalStoragePath: root });
  assert.deepEqual(inspection.problems, []);
  const selected = inspection.candidates.find((candidate) => candidate.selected);
  assert.equal(selected.id, 'default');
  assert.deepEqual(conversationIds(selected.runtimeDataRootPath), ['conversation_current_1', 'conversation_current_2']);
  assert.equal(await fs.readFile(path.join(root, 'AGENTS.md'), 'utf8'), '# source rules\n');
  assert.deepEqual(await indexIds(path.join(root, 'agents')), ['agent-shared', 'agent-source-only']);
  const reopened = await kernel.RuntimeDatabase.open(new RootAuthority(() => selected.runtimeDataRootPath), { hostBootId: `restart-${Date.now()}` });
  await reopened.close();
  return selected;
}

const scenarios = [];
const push = (kind, ...names) => { for (const name of names) scenarios.push([name, kind]); };
push('empty', 'during-merge', 'pending-written', 'journal-create', 'staging-marker-after', 'selection-after', 'identity-after', 'complete-marker-after', 'publish-after', 'undo-work-removed',
  'undo-marked', 'undo-record-removed', 'notice-after', 'undo-marked@notice-after', 'undo-work-removed@notice-after');
for (let n = 1; n <= 10; n += 1) push('empty', `journal-before:${n}`, `journal-after:${n}`);
push('limcode', 'journal-create', 'staging-marker-after', 'dbbackup-before-rename', 'identity-after', 'complete-marker-after', 'notice-after', 'publish-after',
  'undo-marked@notice-after',
  'undo-db-restored', 'undo-work-removed', 'undo-db-restored@journal-before:13',
  'undo-marked', 'undo-restored', 'undo-record-removed', 'undo-restored@journal-before:12', 'undo-restored@journal-before:5');
for (let n = 1; n <= 16; n += 1) push('limcode', `journal-before:${n}`, `journal-after:${n}`);
push('copied', 'during-merge', 'aside-after', 'staging-marker-after', 'journal-after:1', 'journal-after:9', 'journal-after:10', 'complete-marker-after', 'publish-after', 'undo-work-removed',
  'undo-marked', 'undo-record-removed', 'undo-leftover-moved@during-merge', 'undo-record-removed@during-merge');
for (let n = 2; n <= 10; n += 1) push('copied', `journal-before:${n}`);

for (const [scenario, kind] of scenarios) {
  const name = `${kind} ${scenario}`;
  if (ONLY && !ONLY.has(name) && !ONLY.has(kind)) continue;
  test(`SIGKILL ${name}`, async (t) => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'r2-crash-')));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const undoCrash = scenario.startsWith('undo-');
    const [undoPoint, firstPoint] = scenario.split('@');
    const first = await child(base, undoCrash ? (firstPoint ?? 'complete-marker-after') : scenario, kind, 'relocate');
    const log = () => fs.readFile(path.join(base, 'child.log'), 'utf8').catch(() => '');
    assert.equal(first.signal, 'SIGKILL', await log());
    const { root, target, relocationId } = JSON.parse(await fs.readFile(path.join(base, 'fixture.json'), 'utf8'));
    const beforeTarget = JSON.parse(await fs.readFile(path.join(base, 'before-target.json'), 'utf8'));
    const pointer = JSON.parse(await fs.readFile(path.join(base, 'pointer.json'), 'utf8'));

    const notice = () => relocation.readDataRootMovedNotice(root);
    if (scenario === 'publish-after') {
      assert.equal((await notice())?.relocationId, relocationId, '切换生效：旧目录留着“已迁走”标记');
      assert.equal(pointer.dataRootPath, target);
      const moved = await selectedDataSet(target);
      assert.deepEqual(conversationIds(moved.runtimeDataRootPath).filter((id) => id.startsWith('conversation_current')), ['conversation_current_1', 'conversation_current_2']);
      await relocation.assertDataRootAvailable(target, pointer.dataRootId);
      await finalizeDataRootRelocation(target);
      await assertOldHomeIntact(root);
      return;
    }
    assert.equal(pointer.dataRootPath, root, '指针仍是旧目录');
    assert.equal(pointer.pendingRelocation?.relocationId, relocationId, '进行中记录还在');

    // Written right before the switch (never after it): there once the kill came after it.
    const noticeWritten = (undoCrash ? firstPoint : scenario) === 'notice-after';
    assert.equal((await notice())?.relocationId, noticeWritten ? relocationId : undefined, '“已迁走”标记只在切换之前的最后一步写');
    if (undoCrash) {
      const second = await child(base, undoPoint, kind, 'recover');
      assert.equal(second.signal, 'SIGKILL', `撤销过程中被杀：${await log()}`);
      if (undoPoint === 'undo-marked') assert.equal((await notice())?.relocationId, noticeWritten ? relocationId : undefined, '记下撤销中之后才删标记');
    }
    // Next startup (beforeDataRootOpen): the owner is gone.
    let outcome;
    try {
      outcome = await recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId });
    } catch (error) {
      assert.fail(`下次启动撤销失败：${error?.code ?? ''} ${error?.message}\n${await log()}`);
    }
    t.diagnostic(`recover -> ${outcome}`);
    assert.ok(outcome === 'recovered' || outcome === 'absent', outcome);
    await assertOldHomeIntact(root);
    assert.equal(await notice(), undefined, '撤销（包括续撤）删掉这次迁移写下的“已迁走”标记');

    const asides = (await fs.readdir(base)).filter((entry) => entry.includes('.limcode-copied-'));
    if (beforeTarget === null) {
      const remaining = (await fs.readdir(target).catch(() => [])).filter((entry) => !noise(entry));
      assert.deepEqual(remaining, [], `空目标：本次改动全部撤销（剩下 ${remaining.join(', ')}）`);
    } else {
      const after = await treeSnapshot(target).catch(() => ({}));
      const diff = diffSnapshots(beforeTarget, after);
      assert.deepEqual(diff, [], `目标恢复到迁移之前；copied aside=${asides.join(',')}\n${await log()}`);
      assert.deepEqual(asides, [], '拷来的数据已改回原名');
    }

    // The same target receives the relocation again.
    const selected = await selectedDataSet(root);
    const fixture = { root, paths: { globalStoragePath: root }, current: { authority: new RootAuthority(() => selected.runtimeDataRootPath) } };
    const plan = await planWithRuntime(fixture, target);
    assert.deepEqual(plan.problems, [], `再次迁移的预检：${plan.problems.join('\n')}`);
    assert.equal(plan.target.kind, kind);
    const { result } = await relocate(fixture, plan);
    assert.equal(result.merged.insertedConversations, 2);
  });
}
