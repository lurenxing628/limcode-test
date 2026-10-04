// 清理备份（runtimeBackupCleanup）最后一轮盲审的修复：#3 本地备份改名前最后一步与改名之后比较目录（换成符号链接、
// 改名后写入都不删），删除时不跟随链接；#4/F6 大库合并准备登记的目标备份不删、也不当“最新一份满 1 小时”的锚点；
// #5 读不了的目录记进 problems、按历史保留，检查照常完成；#6 “升级完成不满 7 天”的时间按本地时间显示；#7 覆盖缓存
// 压缩、拷贝只记正文 id；F2 迁移数据目录之后认出本安装以前的数据目录写的已核对标记，删到一半的不改回原名、按标记删完。
// Runs against the compiled extension.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = kernelFile('index.js');
const Database = require('better-sqlite3');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { projectFolderAssignmentSteps } = kernelFile('conversationProject.js');
const { deleteRuntimeBackups, formatLocalTime, planRuntimeBackupCleanup } = kernelFile('runtimeBackupCleanup.js');
const { writeRuntimeLargeMergeTargetBackup } = kernelFile('runtimeDataSetMergeLedger.js');
const { migratePreviousRuntimeEpochIfRequired } = kernelFile('runtimeEpochMigration.js');
const {
  resolveVscodeRuntimeDataRoot, resolveVscodeRuntimeMergeLedgerRoot, resolveVscodeWorkspaceRuntimeScope, resolveVscodeWorkspaceRuntimeScopeRoot,
  selectVscodeRuntimeDataSet
} = kernelFile('vscodeRootAuthority.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = '2026-09-26T00:00:00.000Z';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
const PROJECT = { uri: 'file:///workspace/shared', name: 'shared' };
const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);

test('#3 本地备份：改名前最后一步目录被换成符号链接时不改名、链接指向的内容不删；改名之后目录里多了内容时改回原名保留；标记之后目录被换成链接时不跟随，报没有删完', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const database = await openCurrent(t, fixture);
  const swapped = await targetBackup(fixture.current, database, 300);
  const written = await targetBackup(fixture.current, database, 240);
  const linked = await targetBackup(fixture.current, database, 180);
  await targetBackup(fixture.current, database, 120);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  for (const directory of [swapped, written, linked]) assert.equal(itemAt(plan, directory).deletable, true, itemAt(plan, directory).reason);
  const victim = path.join(fixture.base, 'victim');
  await fs.mkdir(victim);
  await fs.writeFile(path.join(victim, 'precious.txt'), '别处的重要文件');
  const movedAway = path.join(fixture.base, 'moved-away');
  const movedLater = path.join(fixture.base, 'moved-later');
  const result = await deleteRuntimeBackups(plan, database, [swapped, written, linked].map((directory) => itemAt(plan, directory).key), {
    async onFaultPoint(point, key) {
      if (point === 'before-rename' && key === itemAt(plan, swapped).key) {
        // After the coverage was read again, before the rename: the backup is moved away and a link put in its place.
        await fs.rename(swapped, movedAway);
        await fs.symlink(victim, swapped);
      }
      if (point === 'after-rename' && key === itemAt(plan, written).key) {
        const renamed = (await fs.readdir(path.dirname(written))).find((name) => name.startsWith(`${path.basename(written)}.deleting-`));
        await fs.writeFile(path.join(path.dirname(written), renamed, 'notes-written-later.txt'), '改名之后写进来的');
      }
      if (point === 'after-verify' && key === itemAt(plan, linked).key) {
        // Marked verified; before the removal the renamed directory is swapped for a link.
        const renamed = (await fs.readdir(path.dirname(linked))).find((name) => name.startsWith(`${path.basename(linked)}.deleting-`));
        await fs.rename(path.join(path.dirname(linked), renamed), movedLater);
        await fs.symlink(victim, path.join(path.dirname(linked), renamed));
      }
    }
  });
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.kept.map((item) => [item.path, item.reason]), [
    [swapped, '列出之后这份备份有变化，请重新检查；这一项没有删除'],
    [written, '改名前后这份备份有变化，请重新检查，已改回原名，保留']
  ]);
  assert.deepEqual(result.unfinished.map((item) => item.path), [linked]);
  assert.match(result.unfinished[0].reason, /^已核对并改名为 .+\.deleting-[0-9a-f]{16}，但没有删完；下次清理备份时会删完$/);
  assert.equal(await fs.readFile(path.join(victim, 'precious.txt'), 'utf8'), '别处的重要文件', '链接指向的内容一个字节也没有删');
  assert.ok((await fs.lstat(swapped)).isSymbolicLink(), '改名前被换上的链接没有被改名或删除');
  assert.ok((await fs.lstat(path.join(movedAway, 'limcode.sqlite'))).isFile());
  assert.ok((await fs.lstat(path.join(written, 'notes-written-later.txt'))).isFile(), '改回原名，改名后写进来的内容还在');
  assert.ok((await fs.lstat(path.join(movedLater, 'limcode.sqlite'))).isFile());

  // The next cleanup does not follow the link left under the verified name either.
  const next = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual([next.finishedDeletions, next.restoredDeletions], [[], []]);
  assert.ok(next.problems.some((line) => /^上次没有删完的 .+\.deleting-[0-9a-f]{16} 不是普通目录，没有处理。$/.test(line)), next.problems.join('\n'));
  assert.equal(await fs.readFile(path.join(victim, 'precious.txt'), 'utf8'), '别处的重要文件');
});

test('#4/F6 大库合并准备登记的目标备份：登记有效或还没被用上的都保留，也不当“最新一份满 1 小时”的锚点；已用上、窗口已不在的按原规则；登记读不懂或读不了时保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const database = await openCurrent(t, fixture);
  const oldest = await targetBackup(fixture.current, database, 300);
  const middle = await targetBackup(fixture.current, database, 240);
  const prepared = await targetBackup(fixture.current, database, 180);
  const register = (directory, overrides = {}) => writeRuntimeLargeMergeTargetBackup(fixture.paths, {
    name: path.basename(directory), backupPath: directory, processId: process.pid,
    startedAt: new Date(Date.now() - 200 * MINUTE).toISOString(), heartbeatAt: new Date().toISOString(), used: false, ...overrides
  });
  const reasons = async () => {
    const plan = await planRuntimeBackupCleanup(fixture.root, database);
    return [oldest, middle, prepared].map((directory) => itemAt(plan, directory).reason.replace(/^可以删除：.*$/, '可以删除'));
  };
  const LIVE = '大库合并的准备正在使用它（准备登记仍然有效），保留';
  const UNUSED = '大库合并准备时做的，还没有被合并用上（由合并自己清理），保留';
  const ANCHOR = '这是这个库最新的一份满 1 小时的完整合并前备份，保留';
  assert.deepEqual(await reasons(), ['可以删除', '可以删除', ANCHOR], '没有登记时：最新一份满 1 小时的是锚点');

  // A preparation of this (live) process registered the newest one: kept, and the anchor is the one before it.
  await register(prepared);
  assert.deepEqual(await reasons(), ['可以删除', ANCHOR, LIVE]);
  // A window that went away left a registration no session used: its merge removes that backup itself.
  await register(middle, { processId: await exitedProcessId() });
  assert.deepEqual(await reasons(), [ANCHOR, UNUSED, LIVE]);
  // Used by a session whose window is gone: any merge's pre-merge backup now (only the registration is left).
  await register(prepared, { processId: await exitedProcessId(), used: true });
  assert.deepEqual(await reasons(), ['可以删除', UNUSED, ANCHOR]);

  // A registration this version cannot read keeps the backup it is named after.
  const registrations = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'preparing-backups');
  await fs.writeFile(path.join(registrations, `${path.basename(oldest)}.json`), '{"kind":"something-else"}\n');
  assert.deepEqual(await reasons(), [UNUSED, UNUSED, ANCHOR]);
  await fs.rm(path.join(registrations, `${path.basename(oldest)}.json`));
  await fs.rm(path.join(registrations, `${path.basename(middle)}.json`));

  // Registered after the listing: the deletion checks again under its claims.
  const listed = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(listed, middle).deletable, true, itemAt(listed, middle).reason);
  await register(middle);
  const result = await deleteRuntimeBackups(listed, database, [itemAt(listed, oldest).key, itemAt(listed, middle).key]);
  assert.deepEqual(result.deleted.map((item) => item.path), [oldest]);
  assert.deepEqual(result.kept.map((item) => item.reason), [`${LIVE}；这一项没有删除`]);

  // The registrations cannot be read: none of the pre-merge backups can be told apart, all stay.
  await fs.chmod(registrations, 0o000);
  try {
    const unreadable = await planRuntimeBackupCleanup(fixture.root, database);
    for (const directory of [middle, prepared]) {
      assert.equal(itemAt(unreadable, directory).reason, '大库合并准备的备份登记无法读取，不能确认它没有被使用，保留');
    }
  } finally {
    await fs.chmod(registrations, 0o700);
  }
});

test('#5 读不了的目录：工作区历史库的目录、一个控制根里的备份目录或控制根本身读不了时，写进 problems（技术原因只进 details），这些备份按历史保留，检查照常完成', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const database = await openCurrent(t, fixture);
  const deletable = await targetBackup(fixture.current, database, 300);
  await targetBackup(fixture.current, database, 120);
  const scopes = path.join(fixture.root, '.limcode-workspace-runtimes', 'scopes');
  const backups = path.dirname(deletable);
  const restore = [];
  const deny = async (file, mode = 0o000) => { restore.push([file, (await fs.stat(file)).mode & 0o777]); await fs.chmod(file, mode); };
  const noRawText = (plan) => assert.doesNotMatch(JSON.stringify([plan.problems, plan.items.map((item) => item.reason)]), /EACCES|permission denied|scandir/);
  try {
    assert.equal(itemAt(await planRuntimeBackupCleanup(fixture.root, database), deletable).deletable, true);
    await deny(scopes);
    const plan = await planRuntimeBackupCleanup(fixture.root, database);
    assert.ok(plan.problems.includes('工作区历史库所在的目录无法读取，其中的备份没有列出，都按历史保留。'), plan.problems.join('\n'));
    assert.ok(itemAt(plan, deletable), '当前数据目录的备份照常列出');
    assert.ok(plan.details.some((line) => line.includes('EACCES')), plan.details.join('\n'));
    noRawText(plan);

    await deny(backups);
    const unreadable = await planRuntimeBackupCleanup(fixture.root, database);
    assert.ok(unreadable.problems.includes(`${controlRoot(fixture.current)} 里上次没有删完的备份没有全部找到，下次检查时再试。`), unreadable.problems.join('\n'));
    assert.ok(unreadable.problems.includes(`${controlRoot(fixture.current)} 里的备份没有全部列出。`), unreadable.problems.join('\n'));
    assert.equal(unreadable.items.some((item) => item.deletable), false);
    noRawText(unreadable);
    await fs.chmod(backups, 0o700);

    // The control root itself cannot be searched: whether an operation is in progress there cannot be told.
    await deny(controlRoot(fixture.current), 0o600);
    const blind = await planRuntimeBackupCleanup(fixture.root, database);
    assert.equal(blind.items.some((item) => item.deletable), false);
    noRawText(blind);
  } finally {
    for (const [file, mode] of restore.reverse()) await fs.chmod(file, mode).catch(() => undefined);
  }
  assert.equal(itemAt(await planRuntimeBackupCleanup(fixture.root, database), deletable).deletable, true, '读得到之后照常核对');

  // Settling what an earlier cleanup left behind fails as a whole (the maintenance claim of the data
  // set it is in holds a record that is no claim): the check goes on, the leftover waits for the next one.
  const claim = `${controlRoot(fixture.alpha)}.runtime-maintenance`;
  await fs.mkdir(claim, { recursive: true });
  await fs.writeFile(path.join(claim, 'owner.json'), '{"kind":"not a claim"}\n');
  const leftover = path.join(controlRoot(fixture.alpha), 'merge-backups', `${backupName(300)}.deleting-0123456789abcdef`);
  await fs.mkdir(leftover, { recursive: true });
  const settling = await planRuntimeBackupCleanup(fixture.root, database);
  assert.ok(settling.problems.includes('上次没有删完的备份这次没有收尾，下次检查时再试。'), settling.problems.join('\n'));
  assert.equal(itemAt(settling, deletable).deletable, true, '别处的备份照常核对');
  assert.ok((await fs.lstat(leftover)).isDirectory(), '残留原样留着');
  noRawText(settling);
});

test('#6 “升级完成不满 7 天，…之后才可以删除”按本地时间写到分钟（与面板上的创建时间一样），不写 UTC', async (t) => {
  const zone = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  t.after(() => { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; });
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_before_upgrade']);
  await downgradeToEpoch4(fixture.current.binding);
  const upgraded = await migratePreviousRuntimeEpochIfRequired(fixture.current.authority);
  assert.equal(upgraded.migrated, true);
  fixture.current.binding = upgraded.binding;
  const database = await openCurrent(t, fixture);
  const item = itemAt(await planRuntimeBackupCleanup(fixture.root, database), upgraded.backupPath);
  const match = /^升级完成不满 7 天，(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d) 之后才可以删除$/.exec(item.reason);
  assert.ok(match, item.reason);
  // Written in UTC+8: read back as that local time it is about seven days from now.
  const [, year, month, date, hours, minutes] = match.map(Number);
  const shown = Date.UTC(year, month - 1, date, hours, minutes) - 8 * 60 * MINUTE;
  assert.ok(Math.abs(shown - (Date.now() + 7 * DAY)) < 3 * MINUTE, `${item.reason}（按 UTC+8 读是 ${new Date(shown).toISOString()}）`);
  assert.equal(formatLocalTime('2026-09-27T16:05:00.000Z'), '2026-09-28 00:05');
});

test('#7 覆盖缓存：gzip 压缩；拷贝只记正文 id（正文在证明它的库里按那个库自己的记录核对），本地库另记正文位置与项目名', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one', 'conversation_two']);
  await seed(fixture.alpha, ['conversation_alpha']);
  const database = await openCurrent(t, fixture);
  const backup = await targetBackup(fixture.current, database, 300);
  await targetBackup(fixture.current, database, 120);
  const alphaBackup = await closedTargetBackup(fixture.alpha, 300);
  await closedTargetBackup(fixture.alpha, 120);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(plan, backup).deletable, true, itemAt(plan, backup).reason);
  assert.equal(itemAt(plan, alphaBackup).deletable, true, itemAt(plan, alphaBackup).reason);

  const directory = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'coverage');
  const entries = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    const bytes = await fs.readFile(path.join(directory, name));
    assert.match(name, /^[0-9a-f]{32}\.json\.gz$/);
    assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b], 'gzip');
    entries.push(JSON.parse(gunzipSync(bytes).toString('utf8')));
  }
  const copies = entries.filter((entry) => entry.subject.startsWith('backup:'));
  const localSets = entries.filter((entry) => entry.subject.startsWith('data-set:'));
  // The two deletable copies were read (the newest ones kept as anchors are not).
  assert.equal(copies.length, 2);
  assert.deepEqual(localSets.map((entry) => entry.subject), [`data-set:${fixture.alpha.id}`]);
  for (const entry of copies) {
    assert.equal(entry.kind, 'limcode-runtime-backup-coverage-history-3');
    assert.equal(entry.bodies, undefined, '拷贝不记正文位置');
    assert.ok(entry.ids.contents.length > 0 && entry.ids.contents.every((id) => typeof id === 'string' && !id.includes('sha256/')), JSON.stringify(entry.ids.contents));
  }
  const [alpha] = localSets;
  assert.deepEqual(alpha.projectNames, ['shared']);
  assert.equal(alpha.bodies.length, alpha.ids.contents.length);
  assert.ok(alpha.bodies.every(([id, key, length]) => alpha.ids.contents.includes(id) && /^sha256\/[0-9a-f]{2}\/[0-9a-f]{64}$/.test(key) && /^\d+$/.test(length)));

  // Read from the cache the next time: the same conclusions.
  const again = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual(again.items.map((item) => [item.path, item.deletable, item.reason]), plan.items.map((item) => [item.path, item.deletable, item.reason]));
  // A body missing in alpha's CAS is still found missing through the cached locations.
  const [, key] = alpha.bodies[0];
  await fs.rm(path.join(fixture.alpha.binding.paths.casRootPath, ...key.split('/')));
  const missing = await planRuntimeBackupCleanup(fixture.root, database);
  assert.match(itemAt(missing, alphaBackup).reason, /^历史库“shared”里缺 1 个它引用的正文文件/);
});

test('F2 迁移数据目录之后：以前的数据目录里删到一半的外来库（本安装在那里写的已核对标记）按标记删完，不改回原名；那里的身份记录已随最后一个库删掉时同样删完；身份不同的改回原名重新核对；标记暂时读不了时这次不动它', async (t) => {
  // The old data directory A: its current data set and a reset archive of it (covered: deletable).
  const oldHome = await createFixture(t);
  await seed(oldHome.current, ['conversation_one']);
  const newHome = await createFixture(t);
  await seed(newHome.current, ['conversation_one']);
  const newDatabase = await openCurrent(t, newHome);
  const identityFile = path.join(resolveVscodeRuntimeMergeLedgerRoot(oldHome.paths), 'backup-cleanup-identity.json');
  const interrupted = async (index) => {
    const archived = await copyAsArchive(oldHome.current, oldHome.root, archiveName(index));
    const plan = await withDataSet(oldHome.current, (database) => planRuntimeBackupCleanup(oldHome.root, database));
    const item = itemAt(plan, archived);
    assert.equal(item.deletable, true, item.reason);
    // The window deleting it went away after the mark was durable (reloaded for a data-directory move, closed).
    const crashed = await runChild(['delete-then-crash', oldHome.root, item.key, 'before-removal']);
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
    const name = (await fs.readdir(path.dirname(archived))).find((entry) => entry.startsWith(`${path.basename(archived)}.deleting-`));
    assert.ok(name);
    const leftover = path.join(path.dirname(archived), name);
    // Removed halfway (entry by entry, the mark last): its pointer is gone already.
    await fs.rm(path.join(leftover, 'root-binding.json'));
    return { archived, leftover };
  };
  const settle = () => planRuntimeBackupCleanup(newHome.root, newDatabase, { previousDataRootPaths: [oldHome.root] });

  // Moved to B: B's cleanup finishes what A's confirmed deletion began.
  const first = await interrupted(1);
  const moved = await settle();
  assert.deepEqual([moved.finishedDeletions, moved.restoredDeletions], [[first.leftover], []]);
  assert.equal(await exists(first.leftover), false);
  assert.equal(await exists(first.archived), false);
  assert.equal(moved.items.some((item) => item.path === first.archived), false);

  // A's bookkeeping went with its last data set (删除旧目录): the mark still counts there.
  const second = await interrupted(2);
  await fs.rm(identityFile);
  const withoutRecord = await settle();
  assert.deepEqual([withoutRecord.finishedDeletions, withoutRecord.restoredDeletions], [[second.leftover], []]);

  // A has another cleanup identity now (another installation or machine at that path): it proves nothing.
  const third = await interrupted(3);
  const token = JSON.parse(await fs.readFile(identityFile, 'utf8'));
  await fs.writeFile(identityFile, `${JSON.stringify({ ...token, token: randomUUID() })}\n`);
  const foreignMark = await settle();
  assert.deepEqual([foreignMark.finishedDeletions, foreignMark.restoredDeletions], [[], [third.archived]]);
  assert.ok((await fs.lstat(third.archived)).isDirectory());
  await fs.rm(third.archived, { recursive: true });

  // The mark cannot be read right now: neither given its name back half removed nor removed; next time.
  await fs.rm(identityFile);
  const fourth = await interrupted(4);
  const mark = path.join(fourth.leftover, '.limcode-backup-cleanup-verified');
  await fs.chmod(mark, 0o000);
  let undecided;
  try {
    undecided = await settle();
  } finally {
    await fs.chmod(mark, 0o600);
  }
  assert.deepEqual([undecided.finishedDeletions, undecided.restoredDeletions], [[], []]);
  assert.ok(undecided.problems.includes(`上次没有删完的 ${path.basename(fourth.leftover)} 这次没有处理完，保留，下次检查时再试。`), undecided.problems.join('\n'));
  assert.ok((await fs.lstat(fourth.leftover)).isDirectory());
  assert.deepEqual((await settle()).finishedDeletions, [fourth.leftover]);
});

async function createFixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-backup-cleanup-blind-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'LimCode');
  await fs.mkdir(root);
  const paths = { globalStoragePath: root };
  const current = await initialize(root, 'default');
  const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///workspace/alpha'] });
  const scopeRoot = resolveVscodeWorkspaceRuntimeScopeRoot(paths, scope);
  await fs.mkdir(scopeRoot, { recursive: true });
  const alpha = await initialize(scopeRoot, `workspace:${scope.key}`);
  await selectVscodeRuntimeDataSet(paths, 'default');
  return { base, root, paths, current, alpha };
}

async function initialize(scopeRoot, id) {
  await fs.mkdir(scopeRoot, { recursive: true });
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  return { id, scopeRoot, authority, binding };
}

async function openCurrent(t, fixture) {
  const database = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `window-${randomUUID()}` });
  t.after(() => database.close().catch(() => undefined));
  return database;
}

async function withDataSet(dataSet, operation) {
  const runtime = await kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `edit-${randomUUID()}` });
  try { return await operation(runtime); }
  finally { await runtime.close(); }
}

/** Conversations with two messages each; ids are fixed, so seeding the same id elsewhere gives the same history ids. */
async function seed(dataSet, conversationIds, project = PROJECT) {
  await withDataSet(dataSet, async (runtime) => {
    const store = new kernel.ContentAddressedStore(dataSet.authority, runtime.binding);
    for (const id of conversationIds) {
      const turnId = `${id}_turn`;
      const steps = [
        repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
        ...projectFolderAssignmentSteps({ conversationId: id, folder: project, now: NOW }),
        repo('Turn').insert({ id: turnId, conversation_id: id, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
        repo('TurnTermination').insert({ id: `${id}_termination`, turn_id: turnId, terminal_status: 'completed', reason: 'fixture', created_at: NOW })
      ];
      for (const index of [0, 1]) {
        const content = await store.ingest(runtime, JSON.stringify({ role: 'user', parts: [{ text: `${id} 的第 ${index} 条消息` }] }), MESSAGE_TYPE);
        const messageId = `${id}_message_${index}`;
        steps.push(
          repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
          repo('MessageRevision').insert({
            id: `${messageId}_revision`, message_id: messageId, revision_seq: 1n, role: 'user', content_object_id: content.id, created_at: NOW
          }),
          repo('MessageCurrentRevisionLink').insert({ id: `${messageId}_current`, message_id: messageId, revision_id: `${messageId}_revision`, updated_at: NOW }),
          repo('MessagePartOfConversation').insert({
            id: `${messageId}_member`, conversation_id: id, message_id: messageId, message_seq: BigInt(index + 1), created_at: NOW
          })
        );
      }
      await runtime.transaction(steps);
    }
  });
}

/** A closed data set's whole control root copied into the archives directory of `scopeRoot` (as if restored by hand). */
async function copyAsArchive(dataSet, scopeRoot, name) {
  const target = path.join(scopeRoot, '.limcode-runtime-backups', name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(controlRoot(dataSet), target, { recursive: true });
  return target;
}

let backupSequence = 0;
function backupName(minutesAgo) {
  backupSequence += 1;
  const time = new Date(Date.now() - minutesAgo * MINUTE).toISOString().replace(/[-:.]/g, '');
  return `${time}-${String(backupSequence).padStart(6, '0')}-${randomUUID().slice(0, 8)}`;
}

/** The merge engine's target backup (ensureTargetBackup): binding beside an online Backup API copy. */
async function targetBackup(dataSet, database, minutesAgo) {
  const directory = path.join(controlRoot(dataSet), 'merge-backups', backupName(minutesAgo));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, 'root-binding.json'), `${JSON.stringify(database.binding, null, 2)}\n`);
  const temporary = path.join(directory, `limcode.sqlite.${process.pid}.tmp`);
  await database.backupTo(temporary);
  await Promise.all(['-wal', '-shm'].map((suffix) => fs.rm(`${temporary}${suffix}`, { force: true })));
  await fs.rename(temporary, path.join(directory, 'limcode.sqlite'));
  await backdate(directory, minutesAgo);
  return directory;
}

/** The same for a data set nobody has open (Backup API copy of its file). */
async function closedTargetBackup(dataSet, minutesAgo) {
  const directory = path.join(controlRoot(dataSet), 'merge-backups', backupName(minutesAgo));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, 'root-binding.json'), `${JSON.stringify(dataSet.binding, null, 2)}\n`);
  const live = new Database(dataSet.binding.paths.databasePath, { readonly: true, fileMustExist: true });
  try { await live.backup(path.join(directory, 'limcode.sqlite')); }
  finally { live.close(); }
  await backdate(directory, minutesAgo);
  return directory;
}

async function backdate(directory, minutesAgo) {
  const time = new Date(Date.now() - minutesAgo * MINUTE);
  await fs.utimes(directory, time, time);
}

async function downgradeToEpoch4(binding) {
  const oldKeys = new Set(kernel.EPOCH_4_RUNTIME_DOMAIN_SCHEMAS.map((schema) => schema.key));
  const added = kernel.RUNTIME_DOMAIN_SCHEMAS.filter((schema) => !oldKeys.has(schema.key));
  const database = new Database(kernel.toSqliteFilePath(binding.paths.databasePath));
  try {
    database.defaultSafeIntegers(true);
    database.pragma('foreign_keys = OFF');
    database.exec('BEGIN IMMEDIATE');
    for (const schema of [...added].reverse()) database.exec(`DROP TABLE ${schema.table}`);
    // Retained tables also gained indexes in epoch 6. Rebuild the exact published epoch-4
    // indexes and manifest, as the preservation fixtures do, rather than relabeling current DDL.
    const indexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL");
    for (const schema of kernel.EPOCH_4_RUNTIME_DOMAIN_SCHEMAS) {
      for (const { name } of indexes.all(schema.table)) database.exec(`DROP INDEX "${name.replaceAll('"', '""')}"`);
      schema.indexes.forEach((index, ordinal) => database.exec(kernel.createRuntimeDomainIndexSql(schema, index, ordinal)));
    }
    database.exec('DELETE FROM schema_manifest');
    const manifestRow = database.prepare('INSERT INTO schema_manifest VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const schema of kernel.EPOCH_4_RUNTIME_DOMAIN_SCHEMAS) manifestRow.run(schema.key, schema.table, schema.schemaOwner, schema.repository, schema.codec,
      JSON.stringify(schema.mutations), schema.client, schema.deletePolicy, schema.resetPolicy,
      JSON.stringify(schema.indexes), kernel.domainSchemaDigest(schema), 4n);
    database.prepare('UPDATE root_binding SET runtime_kernel_epoch = 4 WHERE singleton = 1').run();
    database.exec('COMMIT');
    database.pragma('wal_checkpoint(TRUNCATE)');
  } finally { database.close(); }
  const epoch = JSON.parse(await fs.readFile(binding.paths.runtimeEpochPath, 'utf8'));
  await fs.writeFile(binding.paths.runtimeEpochPath, `${JSON.stringify({ ...epoch, runtimeKernelEpoch: 4 }, null, 2)}\n`);
  await fs.writeFile(binding.paths.rootPointerPath, `${JSON.stringify({ ...binding, runtimeKernelEpoch: 4 }, null, 2)}\n`);
}

function archiveName(index) {
  return `2026090${index}-010203-004-abcdef1${index}`;
}

function controlRoot(dataSet) {
  return path.dirname(dataSet.binding.paths.dataRootPath);
}

function itemAt(plan, directory) {
  const item = plan.items.find((entry) => entry.path === directory);
  assert.ok(item, `没有列出 ${directory}：${plan.items.map((entry) => entry.path).join(', ')}`);
  return item;
}

async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** The pid of a process that has exited. */
async function exitedProcessId() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid;
}

function runChild(args) {
  const script = path.join(HERE, 'runtime-backup-cleanup-child.mjs');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    // A child that hangs is ended with SIGTERM, never mistaken for the SIGKILL of its crash point.
    const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
