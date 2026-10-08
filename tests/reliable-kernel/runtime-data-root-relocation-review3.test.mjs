// Third review of the data-root relocation (reloc3): an undo never overwrites what someone wrote into
// the target after the relocation (it is held instead), opening a directory settles an unfinished
// relocation into it first, copied data left beside the target is never forgotten, and the guards
// the reviewer's mutations X2 X3 X9 B1 B3 B6 went through unnoticed. Runs against the compiled
// extension (LIMCODE_TEST_EXTENSION_ROOT or dist); the crash cases use the undo-crash child.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  compiled, conversationIds, createFixture, createLimCodeTarget, deleteAsConfirmed, initialize, kernel, kernelFile, markStagingOwnerDead, NOW, openRuntime,
  planWithRuntime, PROJECT, relocate, relocation, repo, RootAuthority, rootAuthority, seed, selectedDataSet, treeSnapshot
} from './runtime-data-root-relocation-fixture.mjs';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const here = path.dirname(fileURLToPath(import.meta.url));
const bulk = kernelFile('runtimeDataSetBulkCopy.js');
const merge = kernelFile('runtimeDataSetMerge.js');
const durable = require(path.join(compiled, 'backend/capabilities/filesystem/durableDirectorySync.js'));
const {
  abandonStagedDataRootRelocation, completeDataRootRelocation, dataRootRelocationCleanupState, inspectDataRootForReturn,
  readDataRootMovedNotice, readDataRootRelocationHold, recoverInterruptedDataRootRelocation, settleDataRootRelocationBeforeOpen,
  stageDataRootRelocation
} = relocation;

function child(base, scenario, kind, phase) {
  const run = spawn(process.execPath, [path.join(here, 'runtime-data-root-relocation-undo-crash-child.mjs'), scenario, base, kind, phase], { stdio: 'inherit' });
  return new Promise((resolve) => run.on('exit', (code, signal) => resolve({ code, signal })));
}

/** A relocation into an existing LimCode directory killed at `scenario` ("<undo point>@<first point>" also kills the next undo). */
async function crashedInto(t, scenario) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-relocation-r3-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const [undoPoint, firstPoint] = scenario.includes('@') ? scenario.split('@') : [undefined, scenario];
  assert.equal((await child(base, firstPoint, 'limcode', 'relocate')).signal, 'SIGKILL');
  if (undoPoint) assert.equal((await child(base, undoPoint, 'limcode', 'recover')).signal, 'SIGKILL');
  return { base, ...JSON.parse(await fs.readFile(path.join(base, 'fixture.json'), 'utf8')) };
}

/** Another installation whose current directory is `target` opens it without looking at relocation records, and writes. */
async function writeMeanwhile(target) {
  const selected = await selectedDataSet(target);
  const runtime = await kernel.RuntimeDatabase.open(new RootAuthority(() => selected.runtimeDataRootPath), { hostBootId: `other-installation-${randomUUID()}` });
  try {
    await runtime.transaction([repo('Conversation').insert({ id: 'conversation_written_meanwhile', title: 'written after the crash', status: 'active', created_at: NOW, updated_at: NOW })]);
  } finally { await runtime.close(); }
  return selected.runtimeDataRootPath;
}

const markerOf = async (target) => JSON.parse(await fs.readFile(path.join(target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE), 'utf8'));

for (const scenario of ['identity-after', 'undo-db-restored@filesystem-ready', 'undo-marked@complete-marker-after']) {
  test(`问题 1 ${scenario}：迁移中断后另一个安装在撤销之前打开新目录写了对话，之后的续撤不覆盖它：撤销被搁置、什么都不动，并写明迁移前备份在哪`, async (t) => {
    const { target, relocationId } = await crashedInto(t, scenario);
    const settingsBefore = await fs.readFile(path.join(target, 'settings', 'llm.json'), 'utf8');
    const receiving = await writeMeanwhile(target);
    assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId }), 'held');
    assert.ok(conversationIds(receiving).includes('conversation_written_meanwhile'), '续撤没有抹掉迁移之后写入的对话');
    if (scenario.startsWith('undo-db-restored')) {
      // The interrupted undo had already put the database back (its WAL not yet): what was written into it since stays.
      assert.deepEqual(conversationIds(receiving).sort(), ['conversation_existing_1', 'conversation_written_meanwhile'], '还原到一半之后写入的内容保留');
    } else {
      assert.ok(conversationIds(receiving).includes('conversation_current_1'), '接收库没有被迁移前的副本覆盖');
    }
    assert.equal(await fs.readFile(path.join(target, 'settings', 'llm.json'), 'utf8'), settingsBefore, '搁置时什么都不动');
    const marker = await markerOf(target);
    assert.equal(marker.state, 'held');
    const work = path.join(target, relocation.DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY, relocationId);
    const hold = await readDataRootRelocationHold(target);
    assert.equal(hold.relocationId, relocationId);
    assert.ok(hold.message.includes(work), '说明迁移前的备份在哪');
    assert.ok((await fs.readdir(work)).some((name) => name.startsWith('database-')), '迁移前的数据库副本还在');
    // Never undone automatically again, by nobody; also not reported as waiting for the directory to
    // be closed while the other installation keeps it open (nothing is left to undo).
    assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId }), 'held');
    const inUse = await kernel.RuntimeDatabase.open(new RootAuthority(() => receiving), { hostBootId: `other-installation-${randomUUID()}` });
    try {
      assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId }), 'held');
    } finally { await inUse.close(); }
    assert.deepEqual(await settleDataRootRelocationBeforeOpen(target), { undone: false });
    await assert.rejects(abandonStagedDataRootRelocation({ plan: { targetRootPath: target }, relocationId }), { code: 'data-root-relocation-undo-held' });
    assert.ok(conversationIds(receiving).includes('conversation_written_meanwhile'));
    assert.equal((await inspectDataRootForReturn(target)).usable, true, '搁置的目录照常可以打开');
  });
}

for (const change of [
  { label: '已替换的全局规则被修改', relative: ['AGENTS.md'], content: '# user rules after the crash\n' },
  { label: '新建技能子树的深层文件被修改', relative: ['skills', 'source-only', 'references', 'nested', 'details.md'], content: 'user nested skill reference after the crash\n' },
  { label: '新建技能目录里增加用户文件', relative: ['skills', 'source-only', 'references', 'nested', 'user-note.txt'], content: 'user file created after the crash\n' }
]) {
  test(`P1 文件撤销保护：${change.label}，真实 SIGKILL 后恢复应搁置并保留全部内容`, async (t) => {
    const { base, root, target, relocationId } = await crashedInto(t, 'filesystem-before-publish');
    assert.equal((await markerOf(target)).state, 'complete', '完成记录已落地，指针还没发布');
    const pointer = JSON.parse(await fs.readFile(path.join(base, 'pointer.json'), 'utf8'));
    assert.equal(pointer.dataRootPath, root);
    assert.equal(pointer.pendingRelocation.relocationId, relocationId);
    assert.equal(relocation.dataRootRelocationOwnerState((await markerOf(target)).owner), 'dead', '真实被杀的进程已退出');
    const selected = await selectedDataSet(target);
    const conversationsBefore = conversationIds(selected.runtimeDataRootPath);
    const changed = path.join(target, ...change.relative);
    await fs.writeFile(changed, change.content);
    const tracked = [
      path.join(target, 'AGENTS.md'),
      path.join(target, 'settings', 'llm.json'),
      path.join(target, 'skills', 'shared', 'SKILL.md'),
      path.join(target, 'skills', 'source-only', 'references', 'nested', 'details.md'),
      changed
    ];
    const expected = new Map(await Promise.all(tracked.map(async file => [file, await fs.readFile(file, 'utf8')])));

    assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId }), 'held');
    assert.equal((await markerOf(target)).state, 'held');
    assert.deepEqual(conversationIds(selected.runtimeDataRootPath), conversationsBefore, '文件变化拒绝整次撤销，接收库也不能还原');
    for (const [file, content] of expected) assert.equal(await fs.readFile(file, 'utf8'), content, `搁置时保留 ${path.relative(target, file)}`);
    assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId }), 'held', '下一次启动也不再撤销');
    assert.equal(await fs.readFile(changed, 'utf8'), change.content);
    assert.equal((await readDataRootRelocationHold(target)).relocationId, relocationId);
  });
}

test('P1 文件撤销保护：一次恢复已耗尽配置备份后再次中断，用户改了已恢复文件，续撤不能跳过核对', async (t) => {
  const { target, relocationId } = await crashedInto(t, 'undo-restored@filesystem-before-publish');
  const work = path.join(target, relocation.DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY, relocationId);
  const entries = (await fs.readFile(path.join(work, 'journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  let restored;
  for (const entry of entries) {
    if (entry.op === 'filesystem' && entry.backup && !await fs.stat(path.join(work, entry.backup)).then(() => true, () => false)) restored = entry;
  }
  assert.ok(restored, '真实恢复已消耗了一份配置备份');
  const file = path.join(target, restored.path);
  const edited = 'user changed the restored file after the second crash\n';
  await fs.writeFile(file, edited);
  const selected = await selectedDataSet(target);
  const conversationsBefore = conversationIds(selected.runtimeDataRootPath);
  assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId }), 'held');
  assert.equal(await fs.readFile(file, 'utf8'), edited);
  assert.deepEqual(conversationIds(selected.runtimeDataRootPath), conversationsBefore);
});

test('P1 文件撤销保护：数据库已恢复但配置还未恢复时再次中断，用户删除配置不能被当成自身撤销', async (t) => {
  const { target, relocationId } = await crashedInto(t, 'undo-db-restored@filesystem-before-publish');
  const file = path.join(target, 'AGENTS.md');
  await fs.rm(file);
  assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId }), 'held');
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('问题 1 打开目录时（准入内）：发起进程已结束的中断迁移先撤销完再打开，之后写入的内容不再被任何续撤影响', async (t) => {
  const { target, relocationId } = await crashedInto(t, 'filesystem-ready');
  assert.equal((await markerOf(target)).state, 'staging', '写后状态已落盘，完成记录还没发布');
  assert.equal((await inspectDataRootForReturn(target)).usable, true, '进程已结束：打开时会先撤销，可以切换过去');
  assert.deepEqual(await settleDataRootRelocationBeforeOpen(target), { undone: true });
  await assert.rejects(fs.stat(path.join(target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE)), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(target, 'settings', 'llm.json'), 'utf8'), '{"activeProviderConfigId":"target"}\n');
  const receiving = await writeMeanwhile(target);
  assert.deepEqual(conversationIds(receiving), ['conversation_existing_1', 'conversation_written_meanwhile']);
  // The relocating installation's next startup finds nothing left to undo.
  assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId }), 'absent');
  assert.deepEqual(conversationIds(receiving), ['conversation_existing_1', 'conversation_written_meanwhile']);
});

test('问题 1 打开目录时：发起迁移的进程还在（或无法确认）就拒绝打开并说明原因，回到/选择这个目录判为不可用', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'existing');
  await createLimCodeTarget(target);
  const plan = await planWithRuntime(fixture, target);
  const source = await openRuntime(fixture.current);
  let staged;
  try { staged = await stageDataRootRelocation(plan, source); } finally { await source.close(); }
  await assert.rejects(settleDataRootRelocationBeforeOpen(target), (error) => error.reason === 'relocating' && /还没完成的数据迁移/.test(error.message));
  const check = await inspectDataRootForReturn(target);
  assert.equal(check.usable, false);
  assert.match(check.message, /还没完成的数据迁移/);
  await abandonStagedDataRootRelocation(staged);
  assert.deepEqual(await settleDataRootRelocationBeforeOpen(target), { undone: false });
  assert.equal((await inspectDataRootForReturn(target)).usable, true);
});

test('问题 1 进程内：完成阶段失败后立即撤销（目标一直在准入内离线）照常进行，并向等待的窗口报“正在撤销”', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'existing');
  const existing = await createLimCodeTarget(target);
  const plan = await planWithRuntime(fixture, target);
  const source = await openRuntime(fixture.current);
  let staged;
  try { staged = await stageDataRootRelocation(plan, source); } finally { await source.close(); }
  const stages = [];
  let error;
  await completeDataRootRelocation(staged, async () => { throw new Error('指针写入失败'); }, { onProgress: (text) => stages.push(text), pointerUnchanged: async () => true })
    .catch((caught) => { error = caught; });
  assert.match(error?.message ?? '', /指针写入失败/);
  assert.equal(dataRootRelocationCleanupState(error), 'cleaned');
  assert.equal(stages.at(-1), '正在撤销本次迁移在新目录里的改动');
  assert.deepEqual(conversationIds(existing.binding.paths.dataRootPath), ['conversation_existing_1']);
});

/** Renames that put a replaced configuration file back fail with EPERM while `failing.on`. */
function failConfigurationRestores(t) {
  const failing = { on: false };
  const rename = fsp.rename;
  fsp.rename = async function (from, to, ...rest) {
    if (failing.on && String(from).includes(`${path.sep}configuration${path.sep}`) && !String(to).includes('.limcode-relocation-backups')) {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return rename.call(this, from, to, ...rest);
  };
  t.after(() => { fsp.rename = rename; });
  return failing;
}

/** A relocation into an existing directory whose pointer switch failed and whose undo stopped halfway (record 'undoing', owner this process). */
async function undoingInto(t) {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'existing');
  const existing = await createLimCodeTarget(target);
  await fs.mkdir(path.join(target, 'settings'), { recursive: true });
  await fs.writeFile(path.join(target, 'settings', 'llm.json'), '{"activeProviderConfigId":"target"}\n');
  const plan = await planWithRuntime(fixture, target);
  const failing = failConfigurationRestores(t);
  await relocate(fixture, plan, { publish: async () => { failing.on = true; throw new Error('指针写入失败'); } }).catch(() => undefined);
  failing.on = false;
  assert.equal((await markerOf(target)).state, 'undoing');
  return { fixture, target, existing };
}

test('撤销还原接收库做到一半（库文件已放回、WAL 还在副本里）：续撤不把这当成别人写入，接着放回 WAL，内容回到迁移之前', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'existing');
  await createLimCodeTarget(target);
  const selected = await selectedDataSet(target);
  const database = path.join(selected.runtimeDataRootPath, 'limcode.sqlite');
  // The receiving database's last transaction is only in its WAL (as after its Runtime was killed).
  const saved = path.join(fixture.base, 'killed');
  await fs.mkdir(saved);
  const killed = await kernel.RuntimeDatabase.open(new RootAuthority(() => selected.runtimeDataRootPath), { hostBootId: `killed-${randomUUID()}` });
  try {
    await killed.transaction([repo('Conversation').insert({ id: 'conversation_only_in_wal', title: 'only in the WAL', status: 'active', created_at: NOW, updated_at: NOW })]);
    for (const suffix of ['', '-wal']) await fs.copyFile(`${database}${suffix}`, path.join(saved, `limcode.sqlite${suffix}`));
  } finally { await killed.close(); }
  for (const suffix of ['-wal', '-shm']) await fs.rm(`${database}${suffix}`, { force: true });
  for (const suffix of ['', '-wal']) await fs.copyFile(path.join(saved, `limcode.sqlite${suffix}`), `${database}${suffix}`);
  assert.ok((await fs.stat(`${database}-wal`)).size > 0, '前提：最后的事务只在 WAL 里');
  const plan = await planWithRuntime(fixture, target);
  const source = await openRuntime(fixture.current);
  let staged;
  try { staged = await stageDataRootRelocation(plan, source); } finally { await source.close(); }
  // The undo right after the failed switch stops once the database file is back, before its WAL.
  const rename = fsp.rename;
  let failWal = true;
  fsp.rename = async function (from, to, ...rest) {
    if (failWal && String(from).includes(relocation.DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY) && String(from).endsWith('limcode.sqlite-wal')) {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return rename.call(this, from, to, ...rest);
  };
  t.after(() => { fsp.rename = rename; });
  let error;
  await completeDataRootRelocation(staged, async () => { throw new Error('指针写入失败'); }, { pointerUnchanged: async () => true }).catch((caught) => { error = caught; });
  assert.equal(dataRootRelocationCleanupState(error), 'not-cleaned');
  const work = path.join(target, relocation.DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY, staged.relocationId);
  const [backup] = (await fs.readdir(work)).filter((name) => name.startsWith('database-'));
  assert.deepEqual(await fs.readdir(path.join(work, backup)), ['limcode.sqlite-wal'], '前提：库文件已放回，WAL 还在副本里');
  failWal = false;
  await markStagingOwnerDead(target);
  assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId: staged.relocationId }), 'recovered');
  assert.deepEqual(conversationIds(selected.runtimeDataRootPath).sort(), ['conversation_existing_1', 'conversation_only_in_wal']);
});

test('X3 撤销到一半（undoing）而发起进程还在：下一次迁移不去接着撤销，按并发拒绝，什么都不动', async (t) => {
  const { fixture, target } = await undoingInto(t);
  const settings = await fs.readFile(path.join(target, 'settings', 'llm.json'), 'utf8');
  assert.notEqual(settings, '{"activeProviderConfigId":"target"}\n', '前提：设置还没放回');
  const plan = await planWithRuntime(fixture, target);
  assert.equal(plan.undoesEarlierAttempt, false);
  assert.equal(plan.target.kind, 'invalid');
  // Not "migrating into it": that relocation failed and its live process undoes it (or its undo stopped).
  assert.match(plan.target.message, /迁移没有成功，正在撤销它在这里的改动（或撤销停下了、还没做完）/);
  const source = await openRuntime(fixture.current);
  try {
    await assert.rejects(stageDataRootRelocation(plan, source), (error) => error?.code === 'data-root-relocation-precondition' && /迁移没有成功，正在撤销/.test(error.message));
  } finally { await source.close(); }
  assert.equal((await markerOf(target)).state, 'undoing');
  assert.equal(await fs.readFile(path.join(target, 'settings', 'llm.json'), 'utf8'), settings);
});

test('X2 撤销到一半（undoing）而发起进程已结束：下一次迁移先接着撤销完，再照常迁移', async (t) => {
  const { fixture, target, existing } = await undoingInto(t);
  await markStagingOwnerDead(target);
  const plan = await planWithRuntime(fixture, target);
  assert.equal(plan.undoesEarlierAttempt, true);
  await relocate(fixture, plan);
  assert.deepEqual(conversationIds(existing.binding.paths.dataRootPath), ['conversation_current_1', 'conversation_current_2', 'conversation_existing_1']);
  assert.equal((await markerOf(target)).state, 'published', '切换指针之后记下已生效');
});

/** The old directory's alpha plus a second workspace data set beta. */
async function withBeta(fixture) {
  const { resolveVscodeWorkspaceRuntimeScope, resolveVscodeWorkspaceRuntimeScopeRoot } = rootAuthority;
  const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///workspace/beta'] });
  const scopeRoot = resolveVscodeWorkspaceRuntimeScopeRoot(fixture.paths, scope);
  await fs.mkdir(scopeRoot, { recursive: true });
  const beta = await initialize(scopeRoot, `workspace:${scope.key}`);
  await seed(beta, [{ id: 'conversation_beta_1', project: PROJECT }]);
  return beta;
}

test('#6 删除旧目录时保留“已迁走”标记（只留这个小文件），其它安装之后仍知道数据去了哪里', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'moved');
  const plan = await planWithRuntime(fixture, target);
  const source = await openRuntime(fixture.current);
  let staged;
  try { staged = await stageDataRootRelocation(plan, source); } finally { await source.close(); }
  await completeDataRootRelocation(staged, async () => undefined, { movedBy: { id: '/installation/a', label: 'VS Code（a）' } });
  await fs.rm(path.join(fixture.root, 'notes.txt'));
  const { plan: deletion } = await deleteAsConfirmed({ oldRootPath: fixture.root, currentRootPath: target });
  assert.ok(!deletion.kept.some((entry) => entry.name === relocation.DATA_ROOT_MOVED_NOTICE_FILE), '标记不当用户文件列出');
  assert.deepEqual(await fs.readdir(fixture.root), [relocation.DATA_ROOT_MOVED_NOTICE_FILE]);
  assert.equal((await readDataRootMovedNotice(fixture.root))?.targetRootPath, target);
});
