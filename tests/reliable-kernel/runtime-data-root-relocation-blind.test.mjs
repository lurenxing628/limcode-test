// Blind review of the data-root relocation: nothing that took effect is ever undone, an unfinished
// relocation is never taken for undone while its target cannot be seen, an undo frees space on a
// full disk and never decides on a receiving database it cannot read, what did not move is never
// deleted with the old directory, and only the installation that started a relocation confirms or
// finalizes it. Runs against the compiled extension (LIMCODE_TEST_EXTENSION_ROOT or dist); the
// crash cases use the relocation children.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import {
  conversationIds, createFixture, createLimCodeTarget, deleteAsConfirmed, kernel, markStagingOwnerDead, NOW, openRuntime,
  planWithRuntime, relocate, relocation, repo, RootAuthority, selectedDataSet
} from './runtime-data-root-relocation-fixture.mjs';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  abandonStagedDataRootRelocation, completeDataRootRelocation, dataRootRelocationCleanupState, DATA_ROOT_RELOCATION_MARKER_FILE,
  findDataRootRelocationCopy, finalizeDataRootRelocation, planDataRootRelocation, planOldDataRootDeletion, readDataRootMovedNotice,
  recoverInterruptedDataRootRelocation, settleDataRootMovedWork, settleDataRootRelocationBeforeOpen, stageDataRootRelocation,
  undoUnpublishedDataRootRelocation
} = relocation;
const markerOf = async (target) => JSON.parse(await fs.readFile(path.join(target, DATA_ROOT_RELOCATION_MARKER_FILE), 'utf8'));
const exists = (file) => fs.lstat(file).then(() => true, () => false);
const workOf = (target, relocationId) => path.join(target, relocation.DATA_ROOT_RELOCATION_BACKUPS_DIRECTORY, relocationId);
const privileged = typeof process.getuid === 'function' && process.getuid() === 0;

/** Plans and stages as the command does (this window's Runtime open while staging). */
async function stage(fixture, target, options = {}) {
  const plan = await planWithRuntime(fixture, target);
  assert.deepEqual(plan.problems, []);
  const source = await openRuntime(fixture.current);
  try { return await stageDataRootRelocation(plan, source, options); } finally { await source.close(); }
}

/** The pointer switch fails and whether it switched cannot be proven: the record stays 'complete', nothing is undone. */
async function unconfirmedCompletion(staged, options = {}) {
  const failure = await completeDataRootRelocation(staged, async () => { throw new Error('指针写入失败'); }, { ...options, pointerUnchanged: async () => false })
    .then(() => assert.fail('完成阶段应当失败'), (error) => error);
  assert.equal(dataRootRelocationCleanupState(failure), 'not-cleaned');
  assert.equal((await markerOf(staged.plan.targetRootPath)).state, 'complete');
  return failure;
}

function child(script, args) {
  const run = spawn(process.execPath, [path.join(here, script), ...args], { stdio: 'inherit' });
  return new Promise((resolve) => run.on('exit', (code, signal) => resolve({ code, signal })));
}

/** A relocation into an existing LimCode directory killed at `point` (see the undo-crash child); its process is gone. */
async function killedInto(t, point, script = 'runtime-data-root-relocation-undo-crash-child.mjs') {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-relocation-blind-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const args = script.includes('undo-crash') ? [point, base, 'limcode', 'relocate'] : [point, base, 'limcode'];
  assert.equal((await child(script, args)).signal, 'SIGKILL');
  return { base, ...JSON.parse(await fs.readFile(path.join(base, 'fixture.json'), 'utf8')) };
}

/** A window of another installation with the target's current data set open (a real Runtime, its Host online). */
async function openTargetWindow(target) {
  const selected = await selectedDataSet(target);
  const runtime = await kernel.RuntimeDatabase.open(new RootAuthority(() => selected.runtimeDataRootPath), { hostBootId: `target-window-${randomUUID()}` });
  return { runtime, dataRoot: selected.runtimeDataRootPath, databasePath: path.join(selected.runtimeDataRootPath, 'limcode.sqlite') };
}

/**
 * The next start is another process: the admission claim whose release failed while the drive was
 * away came back with it, and belongs to a process that is gone by then.
 */
async function markLeftClaimsDead(directory) {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  for (const name of await fs.readdir(directory)) {
    const owner = path.join(directory, name, 'owner.json');
    if (!await exists(owner)) continue;
    const record = JSON.parse(await fs.readFile(owner, 'utf8'));
    await fs.writeFile(owner, JSON.stringify({ ...record, processId: dead, processStartIdentity: `linux-proc:${dead}:0` }));
  }
}

/** A drive holding `mount`: unplugging leaves an empty mount point, plugging back restores its content. */
function drive(base) {
  const mount = path.join(base, 'usb');
  const unplugged = path.join(base, 'usb-unplugged');
  return {
    mount,
    async unplug() { await fs.rename(mount, unplugged); await fs.mkdir(mount); },
    async plug() { await fs.rm(mount, { recursive: true, force: true }); await fs.rename(unplugged, mount); }
  };
}

test('盲审 1（exp1）切换指针之后迁移已生效：放弃（不论是否声明指针没变）一律拒绝，新目录完好可用', async (t) => {
  const fixture = await createFixture(t);
  const target = path.join(fixture.base, 'new-home');
  let dataRootId;
  const { staged } = await relocate(fixture, await planWithRuntime(fixture, target), { publish: async (publication) => { dataRootId = publication.dataRootId; } });
  assert.equal((await markerOf(target)).state, 'published');
  for (const options of [{}, { pointerUnchanged: true }]) {
    await assert.rejects(abandonStagedDataRootRelocation(staged, options), { code: 'data-root-relocation-published' });
  }
  await relocation.assertDataRootAvailable(target, dataRootId);
  assert.deepEqual(conversationIds((await selectedDataSet(target)).runtimeDataRootPath), ['conversation_current_1', 'conversation_current_2']);
  assert.equal((await markerOf(target)).state, 'published');
});

test('盲审 1 完成记录已写、指针是否切换无法确认：打开者按进行中拒绝，放弃要调用方证明指针没变才撤销', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'new-home');
  const staged = await stage(fixture, target);
  await unconfirmedCompletion(staged);
  await assert.rejects(settleDataRootRelocationBeforeOpen(target), (error) => error.reason === 'relocating', '发起进程还在：打开者不能打开这个目录');
  assert.equal((await relocation.inspectDataRootForReturn(target)).usable, false);
  await assert.rejects(abandonStagedDataRootRelocation(staged), { code: 'data-root-relocation-unconfirmed' });
  assert.equal((await markerOf(target)).state, 'complete', '没有证明时什么都不动');
  await abandonStagedDataRootRelocation(staged, { pointerUnchanged: true });
  assert.equal(await exists(target), false, '证明指针没变之后撤销完（新建的目录也删掉）');
});

test('盲审 1（exp9）切换指针失败后的就地撤销：新目录已被别的窗口打开就不撤销（不换掉它在用的库），对方写入保留，之后续撤被搁置', { timeout: 120_000 }, async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'other-installation-home');
  await createLimCodeTarget(target);
  const staged = await stage(fixture, target);
  let window;
  const failure = await completeDataRootRelocation(staged, async () => {
    window = await openTargetWindow(target);
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  }, { pointerUnchanged: async () => true }).then(() => assert.fail('应当失败'), (error) => error);
  let databaseIno;
  try {
    assert.equal(dataRootRelocationCleanupState(failure), 'not-cleaned', '有在线窗口：没有撤销，如实报告');
    databaseIno = (await fs.stat(window.databasePath, { bigint: true })).ino;
    await window.runtime.transaction([repo('Conversation').insert({ id: 'conversation_written_by_other', title: 'x', status: 'active', created_at: NOW, updated_at: NOW })]);
  } finally { await window.runtime.close(); }
  assert.equal((await fs.stat(window.databasePath, { bigint: true })).ino, databaseIno, '数据库文件没有被迁移前的副本换掉');
  assert.deepEqual(conversationIds(window.dataRoot).sort(), ['conversation_current_1', 'conversation_current_2', 'conversation_existing_1', 'conversation_written_by_other']);
  await markStagingOwnerDead(target);
  assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId: staged.relocationId }), 'held', '之后有人写过：不再撤销');
  assert.ok(conversationIds(window.dataRoot).includes('conversation_written_by_other'));
});

for (const [kind, when] of [['empty', 'publish'], ['copied', 'publish'], ['empty', 'copy']]) {
  test(`盲审 2（exp3 ${kind}，${when === 'copy' ? '写完成记录之前' : '切换指针时'}）新目录所在的盘在完成阶段掉线：找不到记录不当作已撤销（放弃报看不到、续撤报 unreachable），接上后照常撤销${kind === 'copied' ? '并把拷来的数据改回原名' : ''}`, async (t) => {
    const fixture = await createFixture(t, { withAlpha: false });
    const usb = drive(fixture.base);
    await fs.mkdir(usb.mount);
    const target = path.join(usb.mount, 'LimCode');
    if (kind === 'copied') {
      const elsewhere = path.join(fixture.base, 'elsewhere');
      await createLimCodeTarget(elsewhere);
      await fs.cp(elsewhere, target, { recursive: true });
    }
    const staged = await stage(fixture, target);
    assert.equal(staged.plan.target.kind, kind);
    assert.ok(staged.anchor?.parent, '准备阶段记下了目标所在位置的身份');
    const eio = () => Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    const failure = await completeDataRootRelocation(staged, async () => {
      await usb.unplug();
      throw eio();
    }, {
      pointerUnchanged: async () => true,
      // 'copy': the drive goes away while the data is being written (the record still says staging).
      onProgress(message) {
        if (when !== 'copy' || message !== '正在核对新目录') return;
        fsSync.renameSync(usb.mount, `${usb.mount}-unplugged`);
        fsSync.mkdirSync(usb.mount);
        throw eio();
      }
    }).then(() => assert.fail('应当失败'), (error) => error);
    assert.equal(dataRootRelocationCleanupState(failure), 'not-cleaned', '看不到新目录：没有撤销，也不说已撤销');
    await assert.rejects(abandonStagedDataRootRelocation(staged, { pointerUnchanged: true }), (error) => relocation.isDataRootRelocationTargetInvisible(error)
      && /看不到/.test(error.message));
    assert.equal(await findDataRootRelocationCopy(target, staged.relocationId), undefined);
    const input = { targetRootPath: target, relocationId: staged.relocationId, anchor: staged.anchor };
    assert.equal(await recoverInterruptedDataRootRelocation(input), 'unreachable', '进行中记录保留');
    assert.deepEqual(await fs.readdir(usb.mount), [], '掉线期间挂载点上什么都没留下');
    await usb.plug();
    assert.equal((await markerOf(target)).relocationId, staged.relocationId, '接上后半截迁移还在');
    await markLeftClaimsDead(usb.mount);
    await markStagingOwnerDead(target);
    assert.equal(await recoverInterruptedDataRootRelocation(input), 'recovered');
    if (kind === 'copied') {
      assert.deepEqual((await fs.readdir(target)).sort(), (await fs.readdir(path.join(fixture.base, 'elsewhere'))).sort(), '拷来的数据改回原名');
    } else assert.equal(await exists(target), false);
    assert.deepEqual((await fs.readdir(usb.mount)).filter((name) => name.includes('.limcode-copied-')), []);
  });
}

test('盲审 2 读记录和“已迁走”标记只把不存在当作没有：没有权限时报错，不当作没有迁移', { skip: privileged && '以 root 运行时权限不起作用' }, async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'new-home');
  const staged = await stage(fixture, target, { movedBy: { id: '/installations/a', label: 'A' } });
  const { relocationId } = staged;
  await completeDataRootRelocation(staged, async () => undefined, { movedBy: { id: '/installations/a', label: 'A' } });
  const marker = path.join(target, DATA_ROOT_RELOCATION_MARKER_FILE);
  const notice = path.join(fixture.root, relocation.DATA_ROOT_MOVED_NOTICE_FILE);
  assert.equal((await readDataRootMovedNotice(fixture.root))?.relocationId, relocationId);
  await fs.chmod(marker, 0o000);
  await fs.chmod(notice, 0o000);
  t.after(async () => { await fs.chmod(marker, 0o600).catch(() => undefined); await fs.chmod(notice, 0o600).catch(() => undefined); });
  await assert.rejects(recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId }), { code: 'EACCES' });
  await assert.rejects(readDataRootMovedNotice(fixture.root), { code: 'EACCES' });
});

test('盲审 3（exp5）新目录所在的盘写满：完成记录写不进去时就地撤销只删不写，腾出空间；完成记录已在时放弃也不因写不了“撤销中”而停下', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'full-disk');
  // Armed: the disk fills up at the next record write (the completion record) and stays full.
  const full = { armed: false, on: false };
  const open = fsp.open;
  fsp.open = async function (file, flags, ...rest) {
    if (typeof file === 'string' && file.startsWith(target) && typeof flags === 'string' && /[wa]/.test(flags)) {
      if (full.armed && path.basename(file).startsWith(`${DATA_ROOT_RELOCATION_MARKER_FILE}.`)) full.on = true;
      if (full.on) throw Object.assign(new Error(`ENOSPC: no space left on device, open '${file}'`), { code: 'ENOSPC' });
    }
    return open.call(this, file, flags, ...rest);
  };
  t.after(() => { fsp.open = open; });
  let staged = await stage(fixture, target);
  full.armed = true;
  const failure = await completeDataRootRelocation(staged, async () => undefined, { pointerUnchanged: async () => true })
    .then(() => assert.fail('应当失败'), (error) => error);
  assert.ok(full.on, '前提：完成记录写不进去');
  Object.assign(full, { armed: false, on: false });
  assert.equal(dataRootRelocationCleanupState(failure), 'cleaned');
  assert.equal(await exists(target), false, '半截数据删掉了，空间腾出来了');

  staged = await stage(fixture, target);
  await unconfirmedCompletion(staged);
  full.on = true;
  await abandonStagedDataRootRelocation(staged, { pointerUnchanged: true });
  full.on = false;
  assert.equal(await exists(target), false);
});

test('盲审 3 撤销的最后一步（写回迁移前的记录）遇到磁盘满：说明新建的内容已删掉、只差写回记录，腾出空间后再放弃即可完成', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'new-home');
  await relocate(fixture, await planWithRuntime(fixture, target));
  await finalizeDataRootRelocation(target);
  const earlier = await markerOf(target);
  assert.equal(earlier.state, 'finalized');
  const staged = await stage(fixture, target);
  const open = fsp.open;
  let full = true;
  fsp.open = async function (file, flags, ...rest) {
    if (full && typeof file === 'string' && file.startsWith(target) && typeof flags === 'string' && /[wa]/.test(flags)) {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    return open.call(this, file, flags, ...rest);
  };
  t.after(() => { fsp.open = open; });
  await assert.rejects(abandonStagedDataRootRelocation(staged), (error) => error.code === 'data-root-relocation-disk-full'
    && /磁盘已满/.test(error.message) && /只差写回迁移前的记录/.test(error.message));
  assert.equal((await markerOf(target)).relocationId, staged.relocationId, '记录还在，下次再试');
  full = false;
  await abandonStagedDataRootRelocation(staged);
  assert.deepEqual(await markerOf(target), earlier, '迁移前的记录写回');
});

test('盲审 4（exp6）续撤时接收库一时读不出来：这次不撤销、记录不变（不搁置），下次读得出来就照常撤销', async (t) => {
  const copyFile = fsp.copyFile;
  let failures = 0;
  fsp.copyFile = async function (from, to, ...rest) {
    if (failures > 0 && typeof to === 'string' && to.startsWith(os.tmpdir()) && path.basename(path.dirname(to)).startsWith('limcode-runtime-history-')) {
      failures -= 1;
      throw Object.assign(new Error('EIO: i/o error, copyfile'), { code: 'EIO' });
    }
    return copyFile.call(this, from, to, ...rest);
  };
  t.after(() => { fsp.copyFile = copyFile; });
  // An interrupted staging record (merged, database backup journaled): opening the directory settles it.
  const staging = await killedInto(t, 'identity-after');
  failures = 1;
  await assert.rejects(settleDataRootRelocationBeforeOpen(staging.target), (error) => error.reason === 'unreadable' && /读不出来/.test(error.message));
  assert.equal(failures, 0, '前提：核对时确实读了接收库');
  const record = await markerOf(staging.target);
  assert.equal(record.state, 'staging', '记录不变');
  assert.equal(record.held, undefined, '读不出来不是“有人写过”');
  assert.deepEqual(await settleDataRootRelocationBeforeOpen(staging.target), { undone: true });
  assert.deepEqual(conversationIds((await selectedDataSet(staging.target)).runtimeDataRootPath), ['conversation_existing_1']);
  // A completion never switched to: the relocating installation's next start undoes it.
  const complete = await killedInto(t, 'complete-marker-after');
  failures = 1;
  const input = { targetRootPath: complete.target, relocationId: complete.relocationId };
  assert.equal(await recoverInterruptedDataRootRelocation(input), 'unreadable');
  assert.equal((await markerOf(complete.target)).state, 'complete');
  assert.equal(await recoverInterruptedDataRootRelocation(input), 'recovered');
  assert.deepEqual(conversationIds((await selectedDataSet(complete.target)).runtimeDataRootPath), ['conversation_existing_1']);
});

for (const include of [false, true]) {
  test(`盲审 5（exp4）调试取证随迁移复制；删除旧目录只删确实迁移过去的部分，其余单列为“未迁移、保留”${include ? '，勾选后才删' : ''}`, async (t) => {
    const fixture = await createFixture(t);
    const oldDataRoot = (await selectedDataSet(fixture.root)).runtimeDataRootPath;
    const run = '20260926-120000-000-model-stream-abcdef12';
    const captured = path.join(oldDataRoot, 'diagnostics', 'debug-captures', run);
    await fs.mkdir(captured, { recursive: true });
    await fs.writeFile(path.join(captured, 'manifest.json'), JSON.stringify({ runId: run, status: 'sealed' }));
    await fs.writeFile(path.join(captured, 'events.jsonl'), '{"seq":1}\n');
    await fs.writeFile(path.join(oldDataRoot, 'diagnostics', 'other-diagnostic.log'), 'not moved\n');
    await fs.mkdir(path.join(oldDataRoot, 'stray'));
    await fs.writeFile(path.join(oldDataRoot, 'stray', 'file.txt'), 'not moved\n');
    const target = path.join(fixture.base, 'new-home');
    await relocate(fixture, await planWithRuntime(fixture, target));
    const moved = path.join((await selectedDataSet(target)).runtimeDataRootPath, 'diagnostics', 'debug-captures', run);
    assert.equal(await fs.readFile(path.join(moved, 'events.jsonl'), 'utf8'), '{"seq":1}\n', '调试取证复制到新目录');
    const relocationId = (await markerOf(target)).relocationId;
    const plan = await planOldDataRootDeletion({ oldRootPath: fixture.root, currentRootPath: target, relocationId });
    const unmigrated = plan.items.find((item) => item.key === 'unmigrated:default');
    assert.ok(unmigrated && unmigrated.optional && unmigrated.deletable, '没迁移的内容单列，需要勾选');
    assert.match(unmigrated.label, /other-diagnostic\.log/);
    assert.match(unmigrated.label, /stray/);
    assert.ok(!unmigrated.paths.some((entry) => entry.includes('debug-captures')), '迁移过去的调试取证不在“未迁移”里');
    await deleteAsConfirmed({ oldRootPath: fixture.root, currentRootPath: target, relocationId }, include ? ['unmigrated:default'] : []);
    assert.equal(await exists(captured), false, '已迁移的调试取证随旧库删除');
    assert.equal(await exists(path.join(oldDataRoot, 'diagnostics', 'other-diagnostic.log')), !include);
    assert.equal(await exists(path.join(oldDataRoot, 'stray', 'file.txt')), !include);
    assert.equal(await exists(path.join(oldDataRoot, 'limcode.sqlite')), false, '迁移过去的数据库照常删除');
  });
}

test('盲审 6（exp7）顶层的规则与技能是符号链接：预检列入，迁移时按链接复制（与目录内部的链接一样）', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const dotfiles = path.join(fixture.base, 'dotfiles');
  await fs.mkdir(path.join(dotfiles, 'skills', 'my-skill'), { recursive: true });
  await fs.writeFile(path.join(dotfiles, 'AGENTS.md'), '# my global rules\n');
  await fs.writeFile(path.join(dotfiles, 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---\n');
  await fs.symlink(path.join(dotfiles, 'AGENTS.md'), path.join(fixture.root, 'AGENTS.md'));
  await fs.symlink(path.join(dotfiles, 'skills'), path.join(fixture.root, 'skills'));
  const target = path.join(fixture.base, 'new-home');
  const plan = await planWithRuntime(fixture, target);
  assert.ok(plan.configurationEntries.includes('AGENTS.md') && plan.configurationEntries.includes('skills'));
  await relocate(fixture, plan);
  for (const name of ['AGENTS.md', 'skills']) {
    assert.ok((await fs.lstat(path.join(target, name))).isSymbolicLink(), `${name} 按链接复制`);
    assert.equal(await fs.readlink(path.join(target, name)), path.join(dotfiles, name));
  }
  assert.equal(await fs.readFile(path.join(target, 'skills', 'my-skill', 'SKILL.md'), 'utf8'), '---\nname: my-skill\n---\n');
});

for (const caller of ['abandon', 'recover', 'settle']) {
  test(`盲审 8 ${caller}：新目录的库开着真实 Runtime（在线窗口）时不还原数据库：拒绝，数据库文件没有被替换；窗口关闭后照常撤销`, async (t) => {
    const { target, relocationId } = await killedInto(t, 'identity-after');
    const attempt = () => caller === 'abandon' ? abandonStagedDataRootRelocation({ plan: { targetRootPath: target }, relocationId })
      : caller === 'recover' ? recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId })
        : settleDataRootRelocationBeforeOpen(target);
    const window = await openTargetWindow(target);
    try {
      const before = await fs.stat(window.databasePath, { bigint: true });
      if (caller === 'recover') assert.equal(await attempt(), 'blocked');
      else if (caller === 'abandon') await assert.rejects(attempt(), { code: 'data-root-relocation-target-busy' });
      else await assert.rejects(attempt(), (error) => error.reason === 'relocating' && /要等它们关闭后才能撤销/.test(error.message));
      assert.equal((await fs.stat(window.databasePath, { bigint: true })).ino, before.ino, '数据库文件没有被迁移前的副本替换');
      assert.ok(conversationIds(window.dataRoot).includes('conversation_current_1'), '合并进来的对话还在');
      assert.equal((await markerOf(target)).state, 'staging', '记录不变');
    } finally { await window.runtime.close(); }
    await attempt();
    assert.equal(await exists(path.join(target, DATA_ROOT_RELOCATION_MARKER_FILE)), false, '窗口关闭后撤销完');
    assert.deepEqual(conversationIds((await selectedDataSet(target)).runtimeDataRootPath), ['conversation_existing_1']);
  });
}

test('盲审 11 / 跨模块 A：完成记录写明发起安装；只有它（且指针指明这次迁移）才确认与收尾，其它安装打开时发起进程在就拒绝、已结束就交给用户', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'new-home');
  const [a, b] = [path.join(fixture.base, 'installation-a'), path.join(fixture.base, 'installation-b')];
  const staged = await stage(fixture, target, { installation: a });
  const { relocationId } = staged;
  await unconfirmedCompletion(staged);
  assert.equal((await markerOf(target)).installation, a);
  for (const input of [{}, { installation: b, publishedRelocationId: relocationId }, { installation: a }]) {
    await finalizeDataRootRelocation(target, input);
    assert.equal((await markerOf(target)).state, 'complete', `不收尾：${JSON.stringify(input)}`);
    assert.ok(await exists(workOf(target, relocationId)), '撤销日志还在');
  }
  await assert.rejects(settleDataRootRelocationBeforeOpen(target, { installation: b }), (error) => error.reason === 'relocating');
  await markStagingOwnerDead(target);
  await assert.rejects(settleDataRootRelocationBeforeOpen(target, { installation: b }), (error) => error.reason === 'unpublished'
    && /撤销那次迁移后打开/.test(error.message));
  const source = await openRuntime(fixture.current);
  try {
    const foreign = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target, sourceDatabase: source, installation: b });
    assert.equal(foreign.target.kind, 'invalid', '别的安装不能拿它当自己的半成品撤销重做');
    assert.equal(foreign.undoesEarlierAttempt, false);
    const own = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target, sourceDatabase: source, installation: a });
    assert.equal(own.undoesEarlierAttempt, true, '发起安装自己的半成品：撤销重做');
  } finally { await source.close(); }
  assert.deepEqual(await settleDataRootRelocationBeforeOpen(target, { installation: a, publishedRelocationId: relocationId }), { undone: false });
  assert.equal((await markerOf(target)).state, 'published', '发起安装的指针指明这次迁移：补写已生效');
  await finalizeDataRootRelocation(target, { installation: b, publishedRelocationId: relocationId });
  assert.equal((await markerOf(target)).state, 'published');
  await finalizeDataRootRelocation(target, { installation: a, publishedRelocationId: relocationId });
  assert.equal((await markerOf(target)).state, 'finalized');
  assert.equal(await exists(workOf(target, relocationId)), false);
});

test('跨模块 A（finalize-by-other）切换指针前被杀：另一个安装打开新目录不收尾、不打开，用户可选撤销；发起安装重启照常撤销；日志不在时如实说明', async (t) => {
  const first = await killedInto(t, 'before-publish', 'runtime-data-root-relocation-crash-child.mjs');
  const other = path.join(first.base, 'other-installation');
  await finalizeDataRootRelocation(first.target, { installation: other });
  assert.ok(await exists(path.join(workOf(first.target, first.relocationId), 'journal.jsonl')) || (await fs.readdir(workOf(first.target, first.relocationId))).length > 0, '另一个安装不收尾');
  await assert.rejects(settleDataRootRelocationBeforeOpen(first.target, { installation: other }), (error) => error.reason === 'unpublished');
  assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: first.target, relocationId: first.relocationId }), 'recovered');
  assert.deepEqual(conversationIds((await selectedDataSet(first.target)).runtimeDataRootPath), ['conversation_existing_1']);

  const second = await killedInto(t, 'before-publish', 'runtime-data-root-relocation-crash-child.mjs');
  assert.deepEqual(await undoUnpublishedDataRootRelocation(second.target), {}, '用户选择撤销那次未完成的迁移并打开');
  assert.deepEqual(await settleDataRootRelocationBeforeOpen(second.target, { installation: path.join(second.base, 'other-installation') }), { undone: false });
  assert.deepEqual(conversationIds((await selectedDataSet(second.target)).runtimeDataRootPath), ['conversation_existing_1']);

  const third = await killedInto(t, 'before-publish', 'runtime-data-root-relocation-crash-child.mjs');
  await fs.rm(workOf(third.target, third.relocationId), { recursive: true, force: true });
  assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: third.target, relocationId: third.relocationId }), 'orphaned', '完成但日志不在：不当作没有');
  await assert.rejects(undoUnpublishedDataRootRelocation(third.target), (error) => error.code === 'data-root-relocation-orphaned' && /无法自动撤销/.test(error.message));
});

test('跨模块 B（other-host）旧目录里另一个库被在线 Host 占用：预检与迁移都把它留在旧目录并说明原因，迁移本身照常完成，删除旧目录时保留它', { timeout: 120_000 }, async (t) => {
  const fixture = await createFixture(t);
  const ready = path.join(fixture.base, 'child-ready');
  const finish = path.join(fixture.base, 'child-finish');
  const holder = spawn(process.execPath, [path.join(here, 'runtime-data-root-relocation-hold-child.mjs'), fixture.alpha.scopeRoot, ready, finish], { stdio: 'inherit' });
  const exited = new Promise((resolve) => holder.once('exit', resolve));
  try {
    for (let index = 0; index < 300 && !await exists(ready); index += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(await exists(ready), '子进程已在 alpha 库上打开 Runtime');
    const target = path.join(fixture.base, 'new-home');
    const plan = await planWithRuntime(fixture, target);
    assert.deepEqual(plan.problems, []);
    const alpha = plan.others.find((other) => other.id === fixture.alpha.id);
    assert.match(alpha.leaveBehind ?? '', /正被其它 LimCode 窗口使用.*留在旧目录/);
    assert.doesNotMatch(alpha.leaveBehind, /自动合并/, '不用合并引擎的文案');
    const { result } = await relocate(fixture, plan);
    assert.deepEqual(result.others.migrated, []);
    assert.deepEqual(result.others.leftBehind.map((item) => item.id ?? item), [fixture.alpha.id]);
    assert.deepEqual(conversationIds((await selectedDataSet(target)).runtimeDataRootPath), ['conversation_current_1', 'conversation_current_2']);
    const deletion = await planOldDataRootDeletion({ oldRootPath: fixture.root, currentRootPath: target, relocationId: (await markerOf(target)).relocationId });
    const kept = deletion.items.find((item) => item.key === `data-set:${fixture.alpha.id}`);
    assert.equal(kept?.deletable, false, '没迁移的库保留');
  } finally {
    await fs.writeFile(finish, '').catch(() => undefined);
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    holder.kill('SIGKILL');
  }
});

test('跨模块 D 预检先按文件大小核对空间：不够就直接拒绝，不再统计行数；够了才在当前窗口的读连接上计数（不复制数据库）', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'existing');
  await createLimCodeTarget(target);
  const statfs = fsp.statfs;
  let short = true;
  fsp.statfs = async function (file, ...rest) {
    const stats = await statfs.call(this, file, ...rest);
    return short && String(file).startsWith(fixture.base) ? { ...stats, bavail: typeof stats.bavail === 'bigint' ? 1n : 1 } : stats;
  };
  t.after(() => { fsp.statfs = statfs; });
  const source = await openRuntime(fixture.current);
  try {
    let counted = 0;
    const count = source.countDomainRows.bind(source);
    source.countDomainRows = async () => { counted += 1; return count(); };
    const refused = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target, sourceDatabase: source });
    assert.match(refused.problems.join('\n'), /所在磁盘剩余/);
    assert.equal(counted, 0, '空间不够：不统计行数');
    short = false;
    const planned = await planDataRootRelocation({ sourceRootPath: fixture.root, targetRootPath: target, sourceDatabase: source });
    assert.deepEqual(planned.problems, []);
    assert.equal(counted, 1);
    assert.ok(planned.current.rows > 0);
  } finally { await source.close(); }
});

test('跨模块 E“已迁走”标记带上迁走的未完成任务及其收尾状态；只有同一次迁移的标记能记为已收尾，且只记一次', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'new-home');
  const options = {
    movedBy: { id: '/installations/a', label: 'A' },
    carriedWork: [{ conversationId: 'conversation_current_1', turnId: 'turn_1', label: '正在进行的回合' }]
  };
  const staged = await stage(fixture, target, options);
  await completeDataRootRelocation(staged, async () => undefined, options);
  const notice = await readDataRootMovedNotice(fixture.root);
  assert.deepEqual(notice.carriedWork, { items: options.carriedWork, settlement: { state: 'pending' } });
  assert.equal(await settleDataRootMovedWork(fixture.root, randomUUID(), '/installations/b'), false, '别的迁移的标记不动');
  assert.equal(await settleDataRootMovedWork(fixture.root, staged.relocationId, '/installations/b'), true);
  const settled = (await readDataRootMovedNotice(fixture.root)).carriedWork;
  assert.equal(settled.settlement.state, 'settled');
  assert.equal(settled.settlement.by, '/installations/b');
  assert.equal(await settleDataRootMovedWork(fixture.root, staged.relocationId, '/installations/c'), false, '只记一次');
});

/** backend/capabilities/vscodeStorage/localStorageUri.ts with a fake vscode module. */
function loadLocalStorageUri(vscode) {
  const ts = require('typescript');
  const filename = path.resolve(here, '../../backend/capabilities/vscodeStorage/localStorageUri.ts');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fsSync.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, { module, exports: module.exports, process, require: (name) => (name === 'vscode' ? vscode : require(name)) }, { filename });
  return module.exports;
}

test('盲审 9 设置目录是否存在只把“不存在”当作不存在：没有权限、读写错误都报出来，不当作空目录', { skip: privileged && '以 root 运行时权限不起作用' }, async (t) => {
  const failures = [];
  const vscode = {
    FileType: { File: 1, Directory: 2 },
    workspace: { fs: { async stat() { const failure = failures.shift(); if (failure) throw failure; return { type: 2 }; } } }
  };
  const { storageDirectoryExists } = loadLocalStorageUri(vscode);
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-storage-exists-')));
  t.after(async () => { await fs.chmod(path.join(base, 'locked'), 0o700).catch(() => undefined); await fs.rm(base, { recursive: true, force: true }); });
  const file = (fsPath) => ({ scheme: 'file', fsPath });
  await fs.mkdir(path.join(base, 'locked', 'settings'), { recursive: true });
  await fs.writeFile(path.join(base, 'plain'), '');
  assert.equal(await storageDirectoryExists(file(path.join(base, 'locked', 'settings'))), true);
  assert.equal(await storageDirectoryExists(file(path.join(base, 'missing'))), false);
  assert.equal(await storageDirectoryExists(file(path.join(base, 'plain'))), false);
  assert.equal(await storageDirectoryExists(file(path.join(base, 'plain', 'below'))), false, 'ENOTDIR 当作不存在');
  await fs.chmod(path.join(base, 'locked'), 0o000);
  await assert.rejects(storageDirectoryExists(file(path.join(base, 'locked', 'settings'))), { code: 'EACCES' });
  const remote = { scheme: 'vscode-remote', fsPath: '/remote/settings' };
  failures.push(Object.assign(new Error('not found'), { code: 'FileNotFound' }));
  assert.equal(await storageDirectoryExists(remote), false);
  failures.push(Object.assign(new Error('no permissions'), { code: 'NoPermissions' }));
  await assert.rejects(storageDirectoryExists(remote), { code: 'NoPermissions' });
  assert.equal(await storageDirectoryExists(remote), true);
});
