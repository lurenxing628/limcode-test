// Second review of the data-root relocation (reloc2): its findings F1–F6 asserting the correct behaviour
// (F5, the repeated database restore, is in runtime-data-root-relocation-undo-crash.test.mjs), guards
// the reviewer's mutations M7b M9 M10 M11 M13 M14 went through unnoticed, the moved notice, the space
// estimate on FAT/exFAT and LimCode's own lock directories. Runs against the compiled extension
// (LIMCODE_TEST_EXTENSION_ROOT or dist).
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
  compiled, conversationIds, createFixture, createLimCodeTarget, deleteAsConfirmed, kernel, kernelFile, markStagingOwnerDead, NOW, openRuntime,
  planWithRuntime, relocate, relocation, relocationIdIn, repo, RootAuthority, rootAuthority, selectedDataSet, treeSnapshot, writeRecordStore
} from './runtime-data-root-relocation-fixture.mjs';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const hostControl = kernelFile('runtimeHostControl.js');
const { createRuntimeRootPaths } = kernelFile('contracts.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const {
  assertDataRootAvailable, clearDataRootMovedNotice, completeDataRootRelocation, dataRootRelocationCleanupState, inspectDataRootForReturn,
  planOldDataRootDeletion, readDataRootMovedNotice, readDataRootRelocationRecord, recoverInterruptedDataRootRelocation, stageDataRootRelocation
} = relocation;

function child(base, scenario, kind, phase) {
  const run = spawn(process.execPath, [path.join(here, 'runtime-data-root-relocation-undo-crash-child.mjs'), scenario, base, kind, phase], { stdio: 'inherit' });
  return new Promise((resolve) => run.on('exit', (code, signal) => resolve({ code, signal })));
}

async function crashBase(t, name) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `limcode-relocation-${name}-`)));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return base;
}

/** Renames that put a replaced configuration file back fail with EPERM while `failing.on` (Windows sharing violations). */
function failConfigurationRestores(t) {
  const failing = { on: false, count: 0 };
  const rename = fsp.rename;
  fsp.rename = async function (from, to, ...rest) {
    if (failing.on && String(from).includes(`${path.sep}configuration${path.sep}`) && !String(to).includes('.limcode-relocation-backups')) {
      failing.count += 1;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return rename.call(this, from, to, ...rest);
  };
  t.after(() => { fsp.rename = rename; });
  return failing;
}

test('F1 切指针前崩溃、下次启动的撤销在放回数据库后又被中断：再下次启动接着撤销完（记录已是 undoing），目标恢复原样，删除旧目录没有依据', async (t) => {
  const base = await crashBase(t, 'f1');
  assert.equal((await child(base, 'complete-marker-after', 'limcode', 'relocate')).signal, 'SIGKILL');
  assert.equal((await child(base, 'undo-db-restored', 'limcode', 'recover')).signal, 'SIGKILL');
  const { root, target, relocationId } = JSON.parse(await fs.readFile(path.join(base, 'fixture.json'), 'utf8'));
  assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId }), 'recovered');
  assert.equal(await fs.readFile(path.join(target, 'settings', 'llm.json'), 'utf8'), '{"activeProviderConfigId":"target"}\n', '目标的设置放回原样');
  assert.equal(await readDataRootRelocationRecord(target), undefined, '没有留下看似有效的完成记录');
  assert.ok(!conversationIds((await selectedDataSet(target)).runtimeDataRootPath).includes('conversation_current_1'));
  // "选择其它目录…" to the target never records a relocation id; with the undone relocation's id there is no record either.
  for (const relocationIdGiven of [undefined, relocationId]) {
    const plan = await planOldDataRootDeletion({ oldRootPath: root, currentRootPath: target, ...(relocationIdGiven ? { relocationId: relocationIdGiven } : {}) });
    assert.ok(plan.problems.length > 0, '目标并没有收到旧目录的对话，不能删除旧目录');
  }
});

test('F1b 撤销在还原数据库之后遇到 rename 失败：清理状态如实为没撤销完；下次启动（进程已不在）继续撤销到底', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'existing');
  await createLimCodeTarget(target);
  await fs.mkdir(path.join(target, 'settings'), { recursive: true });
  await fs.writeFile(path.join(target, 'settings', 'llm.json'), '{"activeProviderConfigId":"target"}\n');
  const plan = await planWithRuntime(fixture, target);
  assert.equal(plan.target.kind, 'limcode');
  const relocationId = randomUUID();
  const failing = failConfigurationRestores(t);
  let error;
  try {
    await relocate(fixture, plan, { relocationId, publish: async () => { failing.on = true; throw new Error('指针写入失败'); } });
  } catch (caught) { error = caught; }
  failing.on = false;
  assert.match(error?.message ?? '', /指针写入失败/);
  assert.equal(dataRootRelocationCleanupState(error), 'not-cleaned');
  assert.equal(JSON.parse(await fs.readFile(path.join(target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE), 'utf8')).state, 'undoing');
  await markStagingOwnerDead(target);
  assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId }), 'recovered');
  assert.equal(await fs.readFile(path.join(target, 'settings', 'llm.json'), 'utf8'), '{"activeProviderConfigId":"target"}\n');
  assert.equal(await readDataRootRelocationRecord(target), undefined);
});

test('F2 拷来的 LimCode 数据和用户自己的文件在同一个文件夹：只能用新建的子文件夹，不把整个用户文件夹改名挪走', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const elsewhere = path.join(fixture.base, 'elsewhere');
  await createLimCodeTarget(elsewhere);
  const docs = path.join(fixture.base, 'Documents');
  await fs.cp(elsewhere, docs, { recursive: true });
  await fs.writeFile(path.join(docs, 'thesis.docx'), 'user document');
  const plan = await planWithRuntime(fixture, docs);
  assert.equal(plan.target.kind, 'occupied');
  assert.equal(plan.target.suggestedPath, path.join(docs, 'LimCode'));
  assert.ok(plan.target.entries.includes('thesis.docx'));
  assert.match(plan.problems.join('\n'), /只能放在其中新建的子文件夹里/);
});

test('F2b 拷来的目录在预检之后被某个窗口打开（例如另一个安装）：准备阶段在改名前拒绝，拷贝原地不动', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const elsewhere = path.join(fixture.base, 'elsewhere');
  await createLimCodeTarget(elsewhere);
  const copied = path.join(fixture.base, 'copied');
  await fs.cp(elsewhere, copied, { recursive: true });
  const plan = await planWithRuntime(fixture, copied);
  assert.equal(plan.target.kind, 'copied');
  assert.deepEqual(plan.problems, []);
  // A Host liveness record not proven dead appears in the copy's default Runtime root.
  const liveness = hostControl.runtimeHostLivenessDirectory(createRuntimeRootPaths(rootAuthority.resolveVscodeRuntimeDataRoot({ globalStoragePath: copied })));
  await fs.mkdir(liveness, { recursive: true });
  await fs.writeFile(path.join(liveness, 'window.json'), '{');
  const source = await openRuntime(fixture.current);
  try {
    await assert.rejects(stageDataRootRelocation(plan, source), { code: 'data-root-relocation-target-busy' });
  } finally { await source.close(); }
  assert.deepEqual((await fs.readdir(fixture.base)).filter((name) => name.includes('.limcode-copied-')), [], '没有改名');
  assert.ok(await fs.stat(path.join(copied, '.limcode-runtime-selection.json')));
});

test('#4 拷来的数据改名挪开后中断，原位置又有了别的内容：不覆盖、不报已恢复，错误写明拷贝在哪；清掉之后再恢复就改回原名', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const elsewhere = path.join(fixture.base, 'elsewhere');
  await createLimCodeTarget(elsewhere);
  const copied = path.join(fixture.base, 'copied');
  await fs.cp(elsewhere, copied, { recursive: true });
  const before = await treeSnapshot(copied);
  const plan = await planWithRuntime(fixture, copied);
  assert.equal(plan.target.kind, 'copied');
  const source = await openRuntime(fixture.current);
  let staged;
  try { staged = await stageDataRootRelocation(plan, source); } finally { await source.close(); }
  // The process is gone before completing; meanwhile something else was written where the copy was.
  await markStagingOwnerDead(copied);
  await fs.writeFile(path.join(copied, 'notes.txt'), 'written later');
  const [aside] = (await fs.readdir(fixture.base)).filter((name) => name.startsWith('copied.limcode-copied-'));
  assert.ok(aside?.endsWith(staged.relocationId.slice(0, 8)), '挪开的名字带迁移 id');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(recoverInterruptedDataRootRelocation({ targetRootPath: copied, relocationId: staged.relocationId }),
      (error) => error.code === 'data-root-relocation-copy-aside' && error.message.includes(path.join(fixture.base, aside)));
  }
  assert.equal(await fs.readFile(path.join(copied, 'notes.txt'), 'utf8'), 'written later');
  await fs.rm(path.join(copied, 'notes.txt'));
  assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: copied, relocationId: staged.relocationId }), 'recovered');
  assert.deepEqual(await treeSnapshot(copied), before);
});

test('F3 旧版本设置的自定义目录（没有记录身份）：只有设置记录存储时不算可用的数据目录', async (t) => {
  const base = await crashBase(t, 'f3');
  const dataRoot = path.join(base, 'mnt', 'usb', 'LimCode');
  await fs.mkdir(path.dirname(dataRoot), { recursive: true });
  const { writeFileAtomicDurable } = await import(path.join(compiled, 'backend/capabilities/vscodeStorage/durableWrite.js'));
  await writeFileAtomicDurable(path.join(dataRoot, 'settings', 'llm-provider-configs', 'records', 'p.json'), '{"schemaVersion":1,"config":{"id":"p"}}\n');
  await writeFileAtomicDurable(path.join(dataRoot, 'settings', 'llm-provider-configs', 'index.json'), '{"schemaVersion":1,"records":[{"id":"p","file":"records/p.json","updatedAt":"x"}]}\n');
  await assert.rejects(assertDataRootAvailable(dataRoot), { reason: 'empty' });
});

test('F4 旧目录里无法读取的历史库记进完成记录的“留在旧目录”，设置页说明能怎么处理', async (t) => {
  const fixture = await createFixture(t);
  const scopes = path.join(fixture.root, '.limcode-workspace-runtimes', 'scopes');
  const [alphaKey] = await fs.readdir(scopes);
  await fs.cp(path.join(scopes, alphaKey), path.join(scopes, 'copied-scope-key'), { recursive: true });
  const inspection = await rootAuthority.inspectVscodeRuntimeDataSets(fixture.paths);
  assert.equal(inspection.problems.length, 1, '前提：旧目录里有一个无法读取的库');
  const target = path.join(fixture.base, 'moved');
  const plan = await planWithRuntime(fixture, target);
  assert.deepEqual(plan.unreadable.map((item) => item.id), [inspection.problems[0].id]);
  await relocate(fixture, plan);
  const record = await readDataRootRelocationRecord(target);
  const unreadable = record.leftBehind.find((item) => item.id === inspection.problems[0].id);
  assert.match(unreadable?.reason ?? '', /^无法读取/);
  assert.match(unreadable.hint, /回到旧目录打开一次/);
});

test('F6 迁回 VS Code 默认目录：只剩扩展自己的指针文件及其锁时算空目录，不强制子文件夹', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const defaultDir = path.join(fixture.base, 'vscode-global-storage');
  await fs.mkdir(defaultDir);
  await fs.writeFile(path.join(defaultDir, '.limcode-global-status.json'), '{}\n');
  await fs.mkdir(path.join(defaultDir, '.limcode-global-status.json.lock'));
  const plan = await planWithRuntime(fixture, defaultDir);
  assert.equal(plan.target.kind, 'empty');
  assert.deepEqual(plan.problems, []);
  await relocate(fixture, plan);
  assert.equal(await fs.readFile(path.join(defaultDir, '.limcode-global-status.json'), 'utf8'), '{}\n', '指针文件原样保留');
});

test('M7b 迁移之后才在旧目录出现的已登记设置目录：不是迁移复制过去的，删除旧目录时保留', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'moved');
  await relocate(fixture, await planWithRuntime(fixture, target));
  await writeRecordStore(fixture.root, 'workflows', 'workflow', [{ id: 'written-after-move', name: 'later' }]);
  const plan = await planOldDataRootDeletion({ oldRootPath: fixture.root, currentRootPath: target, relocationId: await relocationIdIn(target) });
  assert.equal(plan.items.find((item) => item.key === 'configuration:workflows'), undefined, '不作为可删除的设置项');
  assert.deepEqual(plan.kept.find((entry) => entry.name === 'workflows')?.reason, '不是本次迁移复制过去的内容（可能是你自己的文件），保留');
  await deleteAsConfirmed({ oldRootPath: fixture.root, currentRootPath: target });
  assert.ok(await fs.stat(path.join(fixture.root, 'workflows', 'index.json')));
});

test('M9 随目录拷来的完成记录不作数：把新目录整个拷到别处后，拷贝里的记录不能用来删除旧目录', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'moved');
  await relocate(fixture, await planWithRuntime(fixture, target));
  const relocationId = await relocationIdIn(target);
  const copy = path.join(fixture.base, 'copy-of-moved');
  await fs.cp(target, copy, { recursive: true });
  const plan = await planOldDataRootDeletion({ oldRootPath: fixture.root, currentRootPath: copy, relocationId });
  assert.match(plan.problems.join('\n'), /找不到从这个目录迁移完成的记录/);
  assert.equal(await readDataRootRelocationRecord(copy), undefined);
});

test('M10 完成但没切换指针的迁移，之后接收库又有了改动：不再整体撤销重做', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'moved');
  // The switch fails and its process ends before it could tell whether the pointer switched: the record stays 'complete'.
  const plan = await planWithRuntime(fixture, target);
  const source = await openRuntime(fixture.current);
  let staged;
  try { staged = await stageDataRootRelocation(plan, source); } finally { await source.close(); }
  await completeDataRootRelocation(staged, async () => { throw new Error('指针写入失败'); }).catch(() => undefined);
  await markStagingOwnerDead(target);
  const again = await planWithRuntime(fixture, target);
  assert.equal(again.undoesEarlierAttempt, true, '前提：没有改动时会撤销重做');
  const receiving = await selectedDataSet(target);
  const runtime = await kernel.RuntimeDatabase.open(new RootAuthority(() => receiving.runtimeDataRootPath), { hostBootId: `window-${randomUUID()}` });
  try {
    await runtime.transaction([repo('Conversation').update('conversation_current_1', { title: '在新目录里改过', updated_at: '2026-09-27T00:00:00.000Z' })]);
  } finally { await runtime.close(); }
  const changed = await planWithRuntime(fixture, target);
  assert.equal(changed.undoesEarlierAttempt, false, '接收库变了：那次迁移不再是可以撤销的半成品');
  assert.equal(changed.target.kind, 'limcode');
});

test('M11 恢复时迁移进程还在：什么都不撤销，返回 running', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'moved');
  const plan = await planWithRuntime(fixture, target);
  const source = await openRuntime(fixture.current);
  let staged;
  try { staged = await stageDataRootRelocation(plan, source); } finally { await source.close(); }
  assert.equal(await recoverInterruptedDataRootRelocation({ targetRootPath: target, relocationId: staged.relocationId }), 'running');
  assert.equal(JSON.parse(await fs.readFile(path.join(target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE), 'utf8')).state, 'staging');
  await completeDataRootRelocation(staged, async () => undefined);
  assert.deepEqual(conversationIds((await selectedDataSet(target)).runtimeDataRootPath), ['conversation_current_1', 'conversation_current_2'], '准备照常完成');
});

test('M13 完成阶段目标又被窗口打开：拒绝并撤销本次改动', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'existing');
  const existing = await createLimCodeTarget(target);
  const plan = await planWithRuntime(fixture, target);
  assert.equal(plan.target.kind, 'limcode');
  const source = await openRuntime(fixture.current);
  let staged;
  try { staged = await stageDataRootRelocation(plan, source); } finally { await source.close(); }
  const window = await openRuntime(existing);
  try {
    let error;
    await completeDataRootRelocation(staged, async () => undefined).catch((caught) => { error = caught; });
    assert.equal(error?.code, 'data-root-relocation-target-busy');
  } finally { await window.close(); }
  assert.deepEqual(conversationIds((await selectedDataSet(target)).runtimeDataRootPath), ['conversation_existing_1']);
});

test('M14 删除旧目录时旧目录又被窗口打开：拒绝，什么都不删', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'moved');
  await relocate(fixture, await planWithRuntime(fixture, target));
  const before = await treeSnapshot(path.join(fixture.root, 'agents'));
  const window = await openRuntime(fixture.current);
  try {
    await assert.rejects(deleteAsConfirmed({ oldRootPath: fixture.root, currentRootPath: target }), { name: 'RuntimeHostsActiveError' });
  } finally { await window.close(); }
  assert.deepEqual(await treeSnapshot(path.join(fixture.root, 'agents')), before);
  assert.equal(await fs.readFile(path.join(fixture.root, 'settings', 'llm.json'), 'utf8'), '{"activeProviderConfigId":"source"}\n');
  assert.deepEqual(conversationIds(fixture.current.binding.paths.dataRootPath), ['conversation_current_1', 'conversation_current_2']);
});

test('#7 迁移完成时在旧目录留下“已迁到新目录”标记（切换指针之前就写好，见 relocated-work-opening 决定二）；目标里过时的标记（从它迁走过）在切换后去掉；只清得掉本安装自己的标记', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'existing');
  await createLimCodeTarget(target);
  const stale = { kind: 'limcode-data-root-moved', targetRootPath: fixture.root, relocationId: randomUUID(), movedAt: NOW, installation: { id: '/installation/a', label: 'VS Code（a）' } };
  await fs.writeFile(path.join(target, relocation.DATA_ROOT_MOVED_NOTICE_FILE), `${JSON.stringify(stale)}\n`);
  assert.equal((await readDataRootMovedNotice(target))?.targetRootPath, fixture.root);
  const installation = { id: '/installation/a/global-storage', label: 'VS Code（a）' };
  const plan = await planWithRuntime(fixture, target);
  assert.equal(plan.target.kind, 'limcode');
  const source = await openRuntime(fixture.current);
  let staged;
  try { staged = await stageDataRootRelocation(plan, source); } finally { await source.close(); }
  let noticeAtPublish;
  await completeDataRootRelocation(staged, async () => { noticeAtPublish = await readDataRootMovedNotice(fixture.root); }, { movedBy: installation });
  assert.equal(noticeAtPublish?.relocationId, staged.relocationId, '指针切换之前旧目录里已经有这次迁移的标记');
  const notice = await readDataRootMovedNotice(fixture.root);
  assert.deepEqual([notice.targetRootPath, notice.relocationId, notice.installation], [target, staged.relocationId, installation]);
  assert.equal(await readDataRootMovedNotice(target), undefined, '新目录里过时的标记已去掉');
  assert.equal(await clearDataRootMovedNotice(fixture.root, '/installation/b/global-storage'), false, '别的安装的标记不清');
  assert.ok(await readDataRootMovedNotice(fixture.root));
  assert.equal(await clearDataRootMovedNotice(fixture.root, installation.id), true);
  assert.equal(await readDataRootMovedNotice(fixture.root), undefined);
});

test('#12 目标在 FAT/exFAT 上（没有硬链接、簇很大）：正文按复制计，并按目标的簇大小估算占用', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const target = path.join(fixture.base, 'usb', 'LimCode');
  await fs.mkdir(path.dirname(target), { recursive: true });
  const linked = await planWithRuntime(fixture, target);
  const statfs = fsp.statfs;
  fsp.statfs = async function (file, ...rest) {
    const stats = await statfs.call(this, file, ...rest);
    return path.resolve(String(file)) === path.dirname(target) ? { ...stats, type: 0x2011bab0, bsize: 131072 } : stats;
  };
  t.after(() => { fsp.statfs = statfs; });
  const exfat = await planWithRuntime(fixture, target);
  if (process.platform === 'linux' && linked.sameDevice) {
    assert.equal(linked.hardLinks, true);
    assert.equal(exfat.hardLinks, false, 'exFAT 没有硬链接：正文要复制');
  }
  const need = (plan) => plan.space.find((space) => space.label.includes('新数据目录')).requiredBytes;
  if (linked.hardLinks) assert.ok(need(exfat) - need(linked) >= 2 * 131072, '两个对话的正文对象各占至少一个 128 KiB 簇');
});

test('#13 LimCode 自己的锁目录（<文件>.lock，内有 owner.json）不当设置复制；身份文件暂时读不到（EIO）时判为“暂时无法读取”、没有权限时判为“无法访问”，都不是“不是原来那份”', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  await fs.mkdir(path.join(fixture.root, 'settings', 'llm.json.lock'), { recursive: true });
  await fs.writeFile(path.join(fixture.root, 'settings', 'llm.json.lock', 'owner.json'), '{"pid":1}\n');
  const target = path.join(fixture.base, 'moved');
  await relocate(fixture, await planWithRuntime(fixture, target));
  await assert.rejects(fs.stat(path.join(target, 'settings', 'llm.json.lock')), { code: 'ENOENT' });
  const record = JSON.parse(await fs.readFile(path.join(target, relocation.DATA_ROOT_RELOCATION_MARKER_FILE), 'utf8'));
  assert.ok(record.configuration.some((item) => item.entry === 'settings'));

  const rootId = await relocation.ensureDataRootIdentity(target);
  const identity = path.join(target, relocation.DATA_ROOT_IDENTITY_FILE);
  // A read error that usually passes (a network drive that hiccups): only retrying makes sense (reloc3 #4).
  const readFile = fsp.readFile;
  fsp.readFile = async function (file, ...rest) {
    if (path.resolve(String(file)) === identity) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
    return readFile.call(this, file, ...rest);
  };
  try {
    await assert.rejects(assertDataRootAvailable(target, rootId), { reason: 'unreadable' });
  } finally { fsp.readFile = readFile; }
  await assertDataRootAvailable(target, rootId);
  assert.equal((await inspectDataRootForReturn(target)).usable, true);
  if (process.getuid?.() === 0) return; // root reads anything
  // No permission: retrying does not help, so it is not "unreadable" (the prompt offers other ways out).
  await fs.chmod(identity, 0o000);
  t.after(() => fs.chmod(identity, 0o600).catch(() => undefined));
  await assert.rejects(assertDataRootAvailable(target, rootId), { reason: 'inaccessible' });
  await fs.chmod(identity, 0o600);
  await assertDataRootAvailable(target, rootId);
});
