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

for (const scenario of ['identity-after', 'undo-db-restored@identity-after', 'undo-marked@complete-marker-after']) {
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

test('问题 1 打开目录时（准入内）：发起进程已结束的中断迁移先撤销完再打开，之后写入的内容不再被任何续撤影响', async (t) => {
  const { target, relocationId } = await crashedInto(t, 'identity-after');
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

test('X9 拷来的数据改名挪开之后目录 fsync 失败：准备阶段把拷贝改回原名，如实报告已清理', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const elsewhere = path.join(fixture.base, 'elsewhere');
  await createLimCodeTarget(elsewhere);
  const copied = path.join(fixture.base, 'copied');
  await fs.cp(elsewhere, copied, { recursive: true });
  const before = await treeSnapshot(copied);
  const plan = await planWithRuntime(fixture, copied);
  assert.equal(plan.target.kind, 'copied');
  const sync = durable.syncDirectoryDurably;
  let injected = 0;
  durable.syncDirectoryDurably = async function (directory, ...rest) {
    const renamed = (await fs.readdir(fixture.base)).some((name) => name.includes('.limcode-copied-'));
    if (injected === 0 && renamed && path.resolve(directory) === fixture.base) {
      injected += 1;
      throw Object.assign(new Error('EIO: injected directory fsync failure'), { code: 'EIO' });
    }
    return sync.call(this, directory, ...rest);
  };
  t.after(() => { durable.syncDirectoryDurably = sync; });
  const source = await openRuntime(fixture.current);
  let error;
  try { await stageDataRootRelocation(plan, source).catch((caught) => { error = caught; }); } finally { await source.close(); }
  assert.equal(injected, 1, '前提：注入生效');
  assert.equal(error?.code, 'EIO');
  assert.equal(dataRootRelocationCleanupState(error), 'cleaned');
  assert.deepEqual((await fs.readdir(fixture.base)).filter((name) => name.includes('.limcode-copied-')), []);
  assert.deepEqual(await treeSnapshot(copied), before);
});

test('问题 2 撤销删掉记录后把拷贝改回原名失败：abandon 仍找得到旁边的拷贝，改不回就报错写明位置，能改回时改回', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const elsewhere = path.join(fixture.base, 'elsewhere');
  await createLimCodeTarget(elsewhere);
  const copied = path.join(fixture.base, 'copied');
  await fs.cp(elsewhere, copied, { recursive: true });
  const before = await treeSnapshot(copied);
  const plan = await planWithRuntime(fixture, copied);
  const source = await openRuntime(fixture.current);
  let staged;
  try { staged = await stageDataRootRelocation(plan, source); } finally { await source.close(); }
  const rename = fsp.rename;
  let blocked = true;
  fsp.rename = async function (from, to, ...rest) {
    if (blocked && String(from).includes('.limcode-copied-') && path.resolve(String(to)) === copied) {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return rename.call(this, from, to, ...rest);
  };
  t.after(() => { fsp.rename = rename; });
  let error;
  await completeDataRootRelocation(staged, async () => { throw new Error('指针写入失败'); }, { pointerUnchanged: async () => true }).catch((caught) => { error = caught; });
  assert.equal(dataRootRelocationCleanupState(error), 'not-cleaned');
  await assert.rejects(fs.stat(path.join(copied, relocation.DATA_ROOT_RELOCATION_MARKER_FILE)), { code: 'ENOENT' }, '前提：记录已删');
  const [aside] = (await fs.readdir(fixture.base)).filter((name) => name.includes('.limcode-copied-'));
  assert.ok(aside, '前提：拷贝还在旁边');
  assert.equal(await relocation.findDataRootRelocationCopy(copied, staged.relocationId), path.join(fixture.base, aside));
  await assert.rejects(abandonStagedDataRootRelocation(staged),
    (caught) => caught.code === 'data-root-relocation-copy-aside' && caught.message.includes(path.join(fixture.base, aside)));
  blocked = false;
  await abandonStagedDataRootRelocation(staged);
  assert.equal(await relocation.findDataRootRelocationCopy(copied, staged.relocationId), undefined);
  assert.deepEqual(await treeSnapshot(copied), before);
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

test('在线复制过的其它库在独占阶段丢弃重做时，只清空它自己的目录：与它共用上级目录的另一个库完整迁移', async (t) => {
  const fixture = await createFixture(t);
  const beta = await withBeta(fixture);
  const target = path.join(fixture.base, 'moved');
  const plan = await planWithRuntime(fixture, target);
  const source = await openRuntime(fixture.current);
  let staged;
  try { staged = await stageDataRootRelocation(plan, source); } finally { await source.close(); }
  const others = [fixture.alpha, beta];
  // The one precopied first created the shared parent (.limcode-workspace-runtimes); it is the one redone.
  const first = others.find((dataSet) => others.some((other) => other !== dataSet
    && staged.precopiedOthers[other.id].receipt.target.runtimeDataRootPath.startsWith(`${staged.precopiedOthers[dataSet.id].createdPath}${path.sep}`)));
  const second = others.find((dataSet) => dataSet !== first);
  assert.ok(first && second, '前提：两个库共用第一个库新建的上级目录');
  await seed(first, [{ id: 'conversation_changed_after_stage', project: PROJECT }]);
  const result = await completeDataRootRelocation(staged, async () => undefined);
  assert.deepEqual([...result.others.migrated].sort(), [fixture.alpha.id, beta.id].sort());
  for (const dataSet of others) {
    const moved = await rootAuthority.resolveVscodeRuntimeDataSet({ globalStoragePath: target }, dataSet.id);
    assert.deepEqual(conversationIds(moved.runtimeDataRootPath), conversationIds(dataSet.binding.paths.dataRootPath));
  }
});

test('B3 其它库在独占阶段迁移失败：只删为它新建的目录，它新建的上级目录里先迁好的另一个库完整保留（删错了，之后“删除旧目录”会删掉唯一的一份）', async (t) => {
  const fixture = await createFixture(t);
  const beta = await withBeta(fixture);
  const byId = new Map([[fixture.alpha.id, fixture.alpha], [beta.id, beta]]);
  const target = path.join(fixture.base, 'moved');
  const plan = await planWithRuntime(fixture, target);
  const [first, second] = plan.others.map((other) => other.id);
  assert.deepEqual([first, second].sort(), [...byId.keys()].sort());
  // The first one's pre-copy fails (its directories go), so the second one creates the shared parent.
  const copy = bulk.copyRuntimeDataSetIntoEmptyRoot;
  bulk.copyRuntimeDataSetIntoEmptyRoot = async function (paths, input, ...rest) {
    if (input.candidateId === first) throw Object.assign(new Error('注入：预复制时磁盘已满'), { code: 'ENOSPC' });
    return copy.call(this, paths, input, ...rest);
  };
  t.after(() => { bulk.copyRuntimeDataSetIntoEmptyRoot = copy; });
  const source = await openRuntime(fixture.current);
  let staged;
  try { staged = await stageDataRootRelocation(plan, source); } finally { await source.close(); }
  bulk.copyRuntimeDataSetIntoEmptyRoot = copy;
  const shared = path.join(target, '.limcode-workspace-runtimes');
  assert.equal(staged.precopiedOthers[first], undefined);
  assert.equal(staged.precopiedOthers[second].createdPath, shared, '前提：第二个库新建了共用的上级目录');
  // In the exclusive phase the first one is migrated into the shared parent, then the second one fails.
  const ensure = bulk.ensureRuntimeDataSetCopyCurrent;
  bulk.ensureRuntimeDataSetCopyCurrent = async function (paths, receipt, ...rest) {
    if (receipt === staged.precopiedOthers[second].receipt) throw new Error('注入：核对预复制时读取失败');
    return ensure.call(this, paths, receipt, ...rest);
  };
  t.after(() => { bulk.ensureRuntimeDataSetCopyCurrent = ensure; });
  const result = await completeDataRootRelocation(staged, async () => undefined);
  assert.deepEqual(result.others.migrated, [first]);
  assert.ok(result.others.leftBehind.some((entry) => entry.id === second && /核对预复制时读取失败/.test(entry.reason)));
  const moved = await rootAuthority.resolveVscodeRuntimeDataSet({ globalStoragePath: target }, first);
  assert.deepEqual(conversationIds(moved.runtimeDataRootPath), conversationIds(byId.get(first).binding.paths.dataRootPath), '先迁好的库还在');
  await assert.rejects(rootAuthority.resolveVscodeRuntimeDataSet({ globalStoragePath: target }, second), () => true, '失败的库不留目录');
});

test('B1 其它库在线复制失败：为它新建的目录马上删掉，独占阶段再迁移它', async (t) => {
  const fixture = await createFixture(t);
  const copy = bulk.copyRuntimeDataSetIntoEmptyRoot;
  let failing = true;
  bulk.copyRuntimeDataSetIntoEmptyRoot = async function (paths, input, ...rest) {
    if (failing && input.candidateId === fixture.alpha.id) throw Object.assign(new Error('注入：预复制时磁盘已满'), { code: 'ENOSPC' });
    return copy.call(this, paths, input, ...rest);
  };
  t.after(() => { bulk.copyRuntimeDataSetIntoEmptyRoot = copy; });
  const target = path.join(fixture.base, 'moved');
  const plan = await planWithRuntime(fixture, target);
  const source = await openRuntime(fixture.current);
  let staged;
  try { staged = await stageDataRootRelocation(plan, source); } finally { await source.close(); }
  assert.equal(staged.precopiedOthers[fixture.alpha.id], undefined);
  await assert.rejects(fs.stat(path.join(target, '.limcode-workspace-runtimes')), { code: 'ENOENT' }, '预复制失败的库不留目录');
  failing = false;
  const result = await completeDataRootRelocation(staged, async () => undefined);
  assert.deepEqual(result.others.migrated, [fixture.alpha.id]);
});

test('B6 在线复制其它库时按了取消：准备立即结束（不再复制当前库），新目录里的改动撤销', async (t) => {
  const fixture = await createFixture(t);
  const cancel = new AbortController();
  const copy = bulk.copyRuntimeDataSetIntoEmptyRoot;
  bulk.copyRuntimeDataSetIntoEmptyRoot = async function (paths, input, ...rest) {
    if (input.candidateId === fixture.alpha.id) {
      cancel.abort();
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    }
    return copy.call(this, paths, input, ...rest);
  };
  const precopy = merge.precopyRuntimeDataSetCas;
  let currentPrecopied = false;
  merge.precopyRuntimeDataSetCas = async function (...args) { currentPrecopied = true; return precopy.apply(this, args); };
  t.after(() => { bulk.copyRuntimeDataSetIntoEmptyRoot = copy; merge.precopyRuntimeDataSetCas = precopy; });
  const target = path.join(fixture.base, 'moved');
  const plan = await planWithRuntime(fixture, target);
  const source = await openRuntime(fixture.current);
  let error;
  try { await stageDataRootRelocation(plan, source, { signal: cancel.signal }).catch((caught) => { error = caught; }); } finally { await source.close(); }
  assert.equal(error?.name, 'AbortError');
  assert.equal(currentPrecopied, false, '取消后不再复制当前库');
  assert.equal(dataRootRelocationCleanupState(error), 'cleaned');
  await assert.rejects(fs.stat(target), { code: 'ENOENT' }, '新建的目录撤销掉');
});

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
