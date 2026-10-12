import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after, before } from 'node:test';
import vm from 'node:vm';
import {
  compiled, createConfigurationRoot, kernel, kernelFile, MESSAGE_TYPE, NOW,
  registerPendingHistory, removeConfigurationRoot, repo, seedConversations
} from './fixtures/runtime-merge-fixture.mjs';
import { archiveLegacyRuntimeRoot } from './runtime-data-root-relocation-fixture.mjs';

const cleanup = kernelFile('runtimeBackupCleanup.js');
const { deleteRuntimeBackups, planRuntimeBackupCleanup } = cleanup;
const foreign = kernelFile('runtimeForeignHistory.js');
const { registerForeignRuntimeHistoryView } = kernelFile('runtimeForeignHistoryViews.js');
const { mergeHistoricalDataSetsOnline } = kernelFile('runtimeDataSetMerge.js');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MARK = '.limcode-backup-cleanup-verified';
let fixture, database, reader, plan, directories, clock;

// One current Runtime and one initial coverage scan serve the independent cleanup boundaries.
before(async () => {
  fixture = await createConfigurationRoot();
  database = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: 'storage-cleanup' });
  reader = {
    binding: database.binding, casAccess: database.casAccess, calls: 0, maxBatch: 0,
    snapshot(reads) {
      this.calls += 1;
      this.maxBatch = Math.max(this.maxBatch, reads.length);
      return database.snapshot(reads);
    }
  };
  clock = Date.now() + MINUTE;
  await insertConversation('cleanup_kept');
  directories = {
    covered: await targetBackup(400),
    marked: await targetBackup(360),
    linked: await targetBackup(320),
    unknown: await targetBackup(280),
    newest: await targetBackup(120)
  };
  await fs.writeFile(path.join(directories.unknown, 'README.txt'), '用户自己的说明');
  await backdate(directories.unknown, 280);
  await insertConversation('cleanup_race');
  directories.race = await targetBackup(240);
  directories.upgrade = await upgradeCompletion();
  plan = await planRuntimeBackupCleanup(fixture.root, reader, { now: () => clock });
});

after(async () => {
  await database?.close();
  if (fixture) await removeConfigurationRoot(fixture.root);
});

test('清理确认仅删除可删且选中的项，替换消息默认不勾选', async () => {
  const command = commandFixture([
    { choice: 'next', include: ['safe', 'replaced', 'blocked', 'unknown-key'] },
    { choice: 'delete', include: [] }
  ]);
  await command.run();
  const options = command.prompts[0].sections.flatMap(section => section.options ?? []);
  assert.equal(options.find(option => option.key === 'safe').checked, true);
  assert.equal(Boolean(options.find(option => option.key === 'replaced').checked), false);
  assert.equal(options.some(option => option.key === 'blocked'), false);
  assert.equal(command.prompts[1].danger, true);
  assert.deepEqual(command.deleted, [['safe', 'replaced']]);
});

test('最终删除确认取消时不调用删除', async () => {
  const command = commandFixture([
    { choice: 'next', include: ['safe'] },
    { choice: 'cancel', include: [] }
  ]);
  await command.run();
  assert.equal(command.prompts[1].danger, true);
  assert.deepEqual(command.deleted, []);
});

test('当前读取线程证明旧备份完整覆盖，删除旧备份并保留最新完整备份', async () => {
  const older = itemAt(plan, directories.covered);
  const newest = itemAt(plan, directories.newest);
  assert.equal(older.deletable, true, older.reason);
  assert.equal(newest.deletable, false, newest.reason);
  assert.ok(reader.calls > 0);
  assert.ok(reader.maxBatch <= 250);
  const result = await deleteRuntimeBackups(plan, reader, [older.key, newest.key], { now: () => clock });
  assert.deepEqual(result.deleted.map(item => item.path), [directories.covered]);
  assert.deepEqual(result.kept.map(item => item.path), [directories.newest]);
  await assert.rejects(fs.lstat(directories.covered), { code: 'ENOENT' });
  assert.ok((await fs.lstat(directories.newest)).isDirectory());
});

test('改名后当前库删除了备份对话，清理恢复原名并保留历史', async t => {
  t.after(() => fs.rm(directories.race, { recursive: true, force: true }));
  const item = itemAt(plan, directories.race);
  assert.equal(item.deletable, true, item.reason);
  const result = await deleteRuntimeBackups(plan, reader, [item.key], {
    now: () => clock,
    async onFaultPoint(point) {
      if (point === 'after-rename') await database.transaction([repo('Conversation').delete('cleanup_race')]);
    }
  });
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.kept.map(item => item.path), [directories.race]);
  assert.equal(result.unfinished.length, 0);
  assert.ok((await fs.lstat(directories.race)).isDirectory());
  assert.equal((await fs.readdir(directories.race)).includes(MARK), false);
  assert.equal((await fs.readdir(path.dirname(directories.race))).some(name => name.startsWith(`${path.basename(directories.race)}.deleting-`)), false);
});

test('核对标记持久化后中断删除，下次盘点完成删除', async () => {
  const item = itemAt(plan, directories.marked);
  assert.equal(item.deletable, true, item.reason);
  const result = await deleteRuntimeBackups(plan, reader, [item.key], {
    now: () => clock,
    onFaultPoint(point) { if (point === 'after-verify') throw new Error('injected removal interruption'); }
  });
  assert.deepEqual(result.deleted, []);
  assert.equal(result.unfinished.length, 1);
  const renamed = await deletingPath(directories.marked);
  assert.ok((await fs.lstat(path.join(renamed, MARK))).isFile());
  const recovered = await planRuntimeBackupCleanup(fixture.root, reader, { now: () => clock });
  assert.deepEqual(recovered.finishedDeletions, [renamed]);
  await assert.rejects(fs.lstat(renamed), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(directories.marked), { code: 'ENOENT' });
});

test('合法升级完成记录未满七天，备份仍在宽限期内保留', async t => {
  t.after(() => fs.rm(directories.upgrade, { recursive: true, force: true }));
  const item = itemAt(plan, directories.upgrade);
  assert.equal(item.kind, 'epoch-migration');
  assert.equal(item.deletable, false);
  assert.match(item.reason, /^升级完成不满 7 天/);
  const result = await deleteRuntimeBackups(plan, reader, [item.key], { now: () => clock });
  assert.deepEqual(result.deleted, []);
  assert.ok((await fs.lstat(directories.upgrade)).isDirectory());
});

test('已核对目录被换成符号链接时，删除及恢复均保留链接目标', async t => {
  const victim = path.join(fixture.root, 'cleanup-link-victim');
  const moved = path.join(fixture.root, 'cleanup-link-original');
  await fs.mkdir(victim);
  await fs.writeFile(path.join(victim, 'precious.txt'), '别处的重要文件');
  t.after(async () => {
    const renamed = await deletingPath(directories.linked);
    await fs.unlink(renamed);
    await fs.rm(moved, { recursive: true, force: true });
    await fs.rm(victim, { recursive: true, force: true });
  });
  const item = itemAt(plan, directories.linked);
  assert.equal(item.deletable, true, item.reason);
  const result = await deleteRuntimeBackups(plan, reader, [item.key], {
    now: () => clock,
    async onFaultPoint(point) {
      if (point !== 'after-verify') return;
      const renamed = await deletingPath(directories.linked);
      await fs.rename(renamed, moved);
      await fs.symlink(victim, renamed, 'dir');
    }
  });
  assert.deepEqual(result.deleted, []);
  assert.equal(result.unfinished.length, 1);
  assert.equal(await fs.readFile(path.join(victim, 'precious.txt'), 'utf8'), '别处的重要文件');
  const recovered = await planRuntimeBackupCleanup(fixture.root, reader, { now: () => clock });
  assert.equal(recovered.finishedDeletions.length, 0);
  assert.equal(recovered.restoredDeletions.length, 0);
  assert.ok((await fs.lstat(await deletingPath(directories.linked))).isSymbolicLink());
  assert.equal(await fs.readFile(path.join(victim, 'precious.txt'), 'utf8'), '别处的重要文件');
});

test('备份里有用户 README 时整份保留', async t => {
  t.after(() => fs.rm(directories.unknown, { recursive: true, force: true }));
  const item = itemAt(plan, directories.unknown);
  assert.equal(item.deletable, false);
  assert.match(item.reason, /README\.txt/);
  const result = await deleteRuntimeBackups(plan, reader, [item.key], { now: () => clock });
  assert.deepEqual(result.deleted, []);
  assert.equal(await fs.readFile(path.join(directories.unknown, 'README.txt'), 'utf8'), '用户自己的说明');
});

test('完整合并的外来来源在只读查看期间保留，释放后可删除', async () => {
  await seedConversations(fixture.alpha, [{ id: 'cleanup_foreign' }]);
  const { backupPath } = await archiveLegacyRuntimeRoot(fixture.alpha.authority, fixture.alpha.scopeRoot);
  await kernel.initializeEmptyRuntimeRoot(fixture.alpha.authority);
  const source = (await foreign.discoverForeignRuntimeHistory({ configurationRootPath: fixture.root }))
    .find(source => source.location.containerPath === backupPath);
  assert.ok(source);
  const located = await foreign.locateForeignRuntimeRoot(fixture.root, source.location);
  await registerPendingHistory(fixture.paths, {
    id: source.id, location: source.location,
    expectedDataSetId: located.recorded.dataSetId, expectedRootInstanceId: located.recorded.rootInstanceId
  });
  const merged = await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database }, {
    candidateIds: [source.id], requested: true
  });
  assert.equal(merged.merged.length, 1, JSON.stringify(merged));
  const foreignPlan = await planRuntimeBackupCleanup(fixture.root, reader);
  const item = itemAt(foreignPlan, backupPath);
  assert.equal(item.deletable, true, item.reason);
  const view = await registerForeignRuntimeHistoryView(fixture.root, source.id);
  try {
    const held = await deleteRuntimeBackups(foreignPlan, reader, [item.key]);
    assert.equal(held.deleted.length, 0);
    assert.ok((await fs.lstat(backupPath)).isDirectory());
  } finally { await view.release(); }
  const removed = await deleteRuntimeBackups(foreignPlan, reader, [item.key]);
  assert.deepEqual(removed.deleted.map(item => item.path), [backupPath]);
  assert.equal(removed.kept.length, 0);
  await assert.rejects(fs.lstat(backupPath), { code: 'ENOENT' });
});

async function insertConversation(id) {
  const store = kernel.ContentAddressedStore.loose(fixture.current.authority, database.binding);
  const body = await store.ingest(database, JSON.stringify({ role: 'user', parts: [{ text: id }] }), MESSAGE_TYPE);
  await database.transaction([
    repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
    repo('Message').insert({ id: `${id}_message`, created_at: NOW, updated_at: NOW, deleted_at: null }),
    repo('MessageRevision').insert({ id: `${id}_revision`, message_id: `${id}_message`, revision_seq: 1n,
      role: 'user', content_object_id: body.id, created_at: NOW }),
    repo('MessageCurrentRevisionLink').insert({ id: `${id}_current`, message_id: `${id}_message`, revision_id: `${id}_revision`, updated_at: NOW }),
    repo('MessagePartOfConversation').insert({ id: `${id}_member`, conversation_id: id, message_id: `${id}_message`, message_seq: 1n, created_at: NOW })
  ]);
}

let backupSequence = 0;
async function targetBackup(minutesAgo) {
  const time = new Date(clock - minutesAgo * MINUTE).toISOString().replace(/[-:.]/g, '');
  const name = `${time}-${String(++backupSequence).padStart(6, '0')}-${randomUUID().slice(0, 8)}`;
  const directory = path.join(path.dirname(database.binding.paths.rootPointerPath), 'merge-backups', name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'root-binding.json'), JSON.stringify(database.binding));
  await database.backupTo(path.join(directory, 'limcode.sqlite'));
  await backdate(directory, minutesAgo);
  return directory;
}

async function backdate(directory, minutesAgo) {
  const time = new Date(clock - minutesAgo * MINUTE);
  await fs.utimes(directory, time, time);
}

async function upgradeCompletion() {
  const time = new Date(clock - DAY).toISOString().replace(/[-:.]/g, '').replace(/\d{3}Z$/, 'Z');
  const directory = path.join(path.dirname(database.binding.paths.rootPointerPath), 'epoch-migration-backups', `${time}-abcdef12`);
  await fs.mkdir(directory, { recursive: true });
  const previousBinding = { ...database.binding, runtimeKernelEpoch: 5 };
  await fs.writeFile(path.join(directory, 'root-binding.epoch-5.json'), JSON.stringify(previousBinding));
  // The age gate reads only the completed journal and bindings, before opening historical SQLite.
  await fs.writeFile(path.join(directory, kernel.RUNTIME_EPOCH_MIGRATION_COMPLETION_FILE), JSON.stringify({
    kind: 'limcode-runtime-epoch-migration-completion', attemptId: 'cleanup-grace', fromEpoch: 5, toEpoch: 6,
    previousBinding, nextBinding: database.binding, completedAt: new Date(clock - DAY).toISOString()
  }));
  return directory;
}

function itemAt(checked, directory) {
  const item = checked.items.find(item => item.path === directory);
  assert.ok(item, `missing cleanup item: ${directory}`);
  return item;
}

async function deletingPath(original) {
  const parent = path.dirname(original);
  const renamed = (await fs.readdir(parent)).find(name => name.startsWith(`${path.basename(original)}.deleting-`));
  assert.ok(renamed, 'deleting directory exists');
  return path.join(parent, renamed);
}

function commandFixture(answers) {
  const root = '/cleanup-command';
  const entry = (key, extra = {}) => ({ key, kind: 'merge-target', name: key, path: `${root}/${key}`,
    bytes: '1', reclaimableBytes: '1', fileCount: 1, inCurrentDataSet: true, deletable: true, reason: 'covered', ...extra });
  const commandPlan = { configurationRootPath: root, checkedAt: NOW, finishedDeletions: [], restoredDeletions: [],
    problems: [], details: [], items: [entry('safe'), entry('replaced', { replacedMessages: 1 }),
      entry('unselected'), entry('blocked', { deletable: false })] };
  const prompts = [], deleted = [];
  const filename = path.join(compiled, 'vscode/commands/backupCleanup.js');
  const nativeRequire = createRequire(filename);
  const module = { exports: {} };
  const dependencies = {
    vscode: { ProgressLocation: { Notification: 15 }, window: {
      withProgress: (_options, operation) => operation({ report() {} }),
      showErrorMessage: message => { throw new Error(message); }
    } },
    '../../backend/capabilities/vscodeStorage/globalStatus': { loadCommittedGlobalStatus: async () => ({ dataRootPath: root }) },
    '../../backend/reliableKernel/runtimeBackupCleanup': { ...cleanup,
      planRuntimeBackupCleanup: async () => commandPlan,
      deleteRuntimeBackups: async (_plan, _current, keys) => {
        deleted.push([...keys]);
        return { deleted: keys.map(key => entry(key)), kept: [], unfinished: [], copiedDirectoriesWithoutDataSets: [] };
      }
    },
    '../dataRootPrompts': { askInSettingsPage: async (_host, _clientId, prompt) => {
      prompts.push(prompt);
      return answers.shift() ?? { choice: 'cancel', include: [] };
    } },
    '../runtimeDataSetUpgradeLifetime': { canStartRuntimeDataSetUpgrade: () => true,
      runRuntimeDataSetUpgrade: (_context, operation) => operation() }
  };
  vm.runInNewContext(readFileSync(filename, 'utf8'), {
    module, exports: module.exports, console, process,
    require: name => dependencies[name] ?? nativeRequire(name)
  }, { filename });
  return { prompts, deleted, run: () => module.exports.cleanupBackups({}, {
    wait: async () => ({ product: { application: { database } }, dataRootPath: () => root, postToWebview: () => true })
  }, { clientId: 'cleanup-client' }) };
}
