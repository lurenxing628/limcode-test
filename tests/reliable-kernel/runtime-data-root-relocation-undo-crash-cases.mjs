// Real SIGKILL at the retained relocation and undo checkpoints, then what the next startup does:
// with file ownership evidence the undo finishes, the target is exactly as before, copied data
// renamed aside is back, and the target receives the relocation again (also after a kill between
// the merge's commit and the journal entry of its fingerprint: the rows journaled before the commit
// show that only the relocation wrote there). A kill before file after-state evidence is durable
// instead holds the relocation, preserves the target and its backups, and leaves the old directory
// usable. Child: runtime-data-root-relocation-undo-crash-child.mjs; runs against the compiled dist.
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
import { RELOCATION_UNDO_CRASH_SCENARIOS, RELOCATION_UNDO_CRASH_GROUPS } from './runtime-data-root-relocation-undo-crash-scenarios.mjs';

function child(base, scenario, kind, phase) {
  const run = spawn(process.execPath, [path.join(here, 'runtime-data-root-relocation-undo-crash-child.mjs'), scenario, base, kind, phase], { stdio: 'inherit' });
  return new Promise((resolve) => run.on('exit', (code, signal) => resolve({ code, signal })));
}

// Left by a killed process like its claims: the liveness record of the merge's session on the
// receiving data set (killed inside the merge transaction, e.g. at its 'merging' journal entry);
// a dead process's record never counts as online. The receiving CAS is compared too: what the
// relocation added there goes with the undo.
const noise = (file) => /\.runtime-(maintenance|admission)/.test(file) || file.endsWith('-shm') || /[\\/]host-liveness[\\/]/.test(file);
function diffSnapshots(before, after, ignore = noise) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)].filter((key) => !ignore(key)));
  const diff = [];
  for (const key of [...keys].sort()) {
    if (before[key] !== after[key]) diff.push(`${key}: ${before[key] ? 'changed/removed' : 'added'}`);
  }
  return diff;
}

const covers = (parent, file) => {
  const relative = path.relative(parent, file);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};

/** Only a missing file after-state permits held in this matrix; a changed database/file never does. */
async function assertMissingFilesystemEvidence(target, relocationId, marker) {
  const prefixes = [
    '没有记下本次迁移写完后的文件状态，无法安全撤销：',
    '没有记下上次恢复后的文件状态，无法安全继续撤销：',
    '恢复副本已经不在，但没有记下恢复后的文件状态，无法安全继续撤销：'
  ];
  const reason = marker.held?.reason ?? '';
  const prefix = prefixes.find(value => reason.startsWith(value));
  assert.ok(prefix, `只允许明确缺少文件写后/恢复状态的窗口搁置：${reason}`);
  const file = reason.slice(prefix.length);
  assert.ok(covers(target, file) && path.resolve(file) !== path.resolve(target), '缺少证据的路径在目标目录内');
  const work = path.join(target, relocation.DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY, relocationId);
  const entries = (await fs.readFile(path.join(work, 'journal.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const changes = entries.filter(entry => ['entry', 'replace', 'children'].includes(entry.op) && path.join(target, entry.path) === file);
  assert.ok(changes.length > 0, '日志确实记录了该路径的创建、替换或子项修改');
  const applicable = [];
  for (const entry of entries) if (entry.op === 'filesystem' && covers(path.join(target, entry.path), file)) {
    if (!entry.backup || !await fs.stat(path.join(work, entry.backup)).then(() => true, () => false)) applicable.push(entry);
  }
  if (prefix === prefixes[0]) assert.equal(applicable.length, 0, '该路径确实没有已写入的文件状态');
  else {
    assert.equal(applicable.filter(entry => entry.backup).length, 0, '该路径确实没有已恢复的文件状态');
    const replacements = changes.filter(entry => entry.op === 'replace');
    assert.ok(replacements.length > 0, '被替换文件需要恢复证据');
    for (const entry of replacements) await assert.rejects(fs.stat(path.join(work, entry.backup)), { code: 'ENOENT' });
  }
  assert.ok((await fs.stat(work)).isDirectory(), '缺少证据时保留迁移撤销副本目录');
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


export function registerRelocationUndoCrashTests(group) {
  assert.ok(RELOCATION_UNDO_CRASH_GROUPS.includes(group), `Unknown relocation crash group: ${group}`);
  for (const [scenario, kind] of RELOCATION_UNDO_CRASH_SCENARIOS) {
  if (kind !== group) continue;
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
    const beforeRecovery = await treeSnapshot(target).catch(() => ({}));
    const pointerBeforeRecovery = await fs.readFile(path.join(base, 'pointer.json'), 'utf8');
    const noticeBeforeRecovery = await notice();
    const markerBeforeRecovery = await fs.readFile(path.join(target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE), 'utf8')
      .then(text => JSON.parse(text), error => { if (error.code === 'ENOENT') return undefined; throw error; });
    let outcome;
    try {
      outcome = await recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId });
    } catch (error) {
      assert.fail(`下次启动撤销失败：${error?.code ?? ''} ${error?.message}\n${await log()}`);
    }
    t.diagnostic(`recover -> ${outcome}`);
    if (outcome === 'held') {
      const marker = JSON.parse(await fs.readFile(path.join(target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE), 'utf8'));
      assert.equal(marker.state, 'held');
      await assertMissingFilesystemEvidence(target, relocationId, marker);
      const { state: _oldState, held: _oldHeld, ...beforeFields } = markerBeforeRecovery;
      const { state: _heldState, held: _held, ...afterFields } = marker;
      assert.deepEqual(afterFields, beforeFields, 'held 只更新状态和原因');
      const heldNoise = file => file === relocation.DATA_ROOT_RELOCATION_MARKER_FILE || /\.runtime-(maintenance|admission)/.test(file);
      assert.deepEqual(diffSnapshots(beforeRecovery, await treeSnapshot(target), heldNoise), [], '搁置前后目标原样保留，包括所有迁移撤销副本');
      assert.equal(await fs.readFile(path.join(base, 'pointer.json'), 'utf8'), pointerBeforeRecovery, '搁置不改旧目录指针与进行中记录');
      assert.deepEqual(await notice(), noticeBeforeRecovery, '搁置不改旧目录迁走标记');
      await relocation.assertDataRootAvailable(pointer.dataRootPath, pointer.dataRootId);
      await assertOldHomeIntact(root);
      return;
    }
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
}
