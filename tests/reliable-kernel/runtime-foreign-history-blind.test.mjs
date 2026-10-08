import { registerPendingHistory } from './fixtures/runtime-merge-fixture.mjs';
// Foreign history, the last blind review: archives of the manual reset of released 0.0.10–0.0.20
// (`<scope>/.limcode-runtime-backups/<17 digits>`) are found and listed as a published older format; a
// previous data directory is forgotten only when it is provably there and empty (not when it is gone,
// not while a `.deleting-` leftover waits there); what the user deleted from the source itself stays out
// of a merge of an earlier copy of it, and a deletion record whose deletion never committed is withdrawn;
// the list does not wait for a claim held elsewhere (its cached result, else "being used"); the foreign
// database is copied from descriptors; merge state survives the rename of a relocation; backup cleanup
// keeps a root whose merge the user asked for. Runs against the compiled extension.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compiled, createConfigurationRoot, Database, kernel, kernelFile, seedConversations
} from './fixtures/runtime-merge-fixture.mjs';
import * as moving from './runtime-data-root-relocation-fixture.mjs';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const foreign = kernelFile('runtimeForeignHistory.js');
const foreignMerge = kernelFile('runtimeForeignHistoryMerge.js');
const records = kernelFile('runtimeMergeTombstones.js');
const ledger = kernelFile('runtimeDataSetMergeLedger.js');
const { mergeHistoricalDataSetsOnline } = kernelFile('runtimeDataSetMerge.js');
const { deleteRuntimeBackups, planRuntimeBackupCleanup } = kernelFile('runtimeBackupCleanup.js');
const { ConversationDeletionControlPlane } = kernelFile('conversationDeletion.js');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { resolveVscodeRuntimeMergeLedgerRoot } = kernelFile('vscodeRootAuthority.js');
const { stopAndDeleteConversation } = require(path.join(compiled, 'backend/application/reliableKernel/conversationDeleteCommand.js'));
import { archiveLegacyRuntimeRoot as archiveCurrentRuntimeRootForReset } from './runtime-data-root-relocation-fixture.mjs';

const POSIX = process.platform !== 'win32';
const PYTHON = POSIX && spawnSync('python3', ['-c', 'import fcntl'], { stdio: 'ignore' }).status === 0;
const LEGACY_NAME = '20250101123045123';
const LEFTOVER = '.deleting-0123456789abcdef';

async function home(t, options = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-foreign-blind-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { ...await createConfigurationRoot({ tmp: base, ...options }), base };
}

async function archive(fixture, dataSet) {
  const authority = new RootAuthority(() => dataSet.binding.paths.dataRootPath, undefined, () => fixture.root);
  const archived = await archiveCurrentRuntimeRootForReset(authority, dataSet.scopeRoot);
  assert.equal(archived.archived, true);
  return archived.backupPath;
}

/** An archive as a published older format wrote it: the RootBinding pointer and the epoch manifest name `epoch`. */
async function setArchiveEpoch(archivePath, epoch) {
  for (const file of [path.join(archivePath, 'root-binding.json'), path.join(archivePath, 'active', 'runtime-kernel-epoch.json')]) {
    await fs.writeFile(file, JSON.stringify({ ...JSON.parse(await fs.readFile(file, 'utf8')), runtimeKernelEpoch: epoch }));
  }
}

function query(databasePath, sql) {
  const database = new Database(databasePath, { readonly: true });
  try { return database.prepare(sql).pluck().all(); } finally { database.close(); }
}
const conversations = (fixture) => query(fixture.current.binding.paths.databasePath, 'SELECT id FROM conversation ORDER BY id');
const openWindow = (fixture) => kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `window-${randomUUID()}` });

async function batch(fixture, options = {}) {
  const database = await openWindow(fixture);
  try {
    return await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database }, options);
  } finally { await database.close(); }
}
const explicit = (...ids) => ({ candidateIds: ids, requested: true });
const brief = (report) => ({
  merged: report.merged.map((item) => [item.candidateId, item.insertedConversations, item.skippedConversations ?? 0]),
  blocked: report.blocked.map((item) => [item.candidateId, item.code]),
  deferred: report.deferred.map((item) => [item.candidateId, item.code]),
  failures: report.failures.map((item) => [item.candidateId, item.code])
});

/** The deletion command as the window runs it (nothing runs in these conversations), recording under `root`. */
async function deleteWithCommand(authority, root, conversationId, deletion) {
  const database = await kernel.RuntimeDatabase.open(authority, { hostBootId: `delete-${randomUUID()}` });
  try {
    const nothingRuns = async () => { throw new Error('nothing runs in this conversation'); };
    return await stopAndDeleteConversation({
      application: { database, conversationDeletion: deletion ? deletion(new ConversationDeletionControlPlane(database)) : new ConversationDeletionControlPlane(database) },
      conversations: { interrupt: nothingRuns }, childAgents: { interruptSubtree: nothingRuns }, pollMs: 20, timeoutMs: 2000,
      recordDeleted: (ids) => records.recordRuntimeDeletedConversations(root, database.binding, ids)
    }, { conversationId, requestId: `delete-${randomUUID()}` });
  } finally { await database.close(); }
}

async function requestMerge(root, entry) {
  const located = await foreign.locateForeignRuntimeRoot(root, entry.location);
  await registerPendingHistory({ globalStoragePath: root }, {
    id: entry.id, location: entry.location, label: `外来历史库（${entry.name}）`,
    expectedDataSetId: located.recorded.dataSetId, expectedRootInstanceId: located.recorded.rootInstanceId
  });
}

const entryAt = (report, containerPath) => report.entries.find((entry) => entry.location.containerPath === containerPath && !entry.archiveName);

async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// --- #2: the archives of the manual reset of released 0.0.10–0.0.20 ------------------------------------

test('盲审 #2：v0.0.10–v0.0.20 手动“归档并重置”的归档（<17 位数字>）被发现；结构与已发布格式不符时如实列为未通过（位置、大小、原因）；只剩它的旧目录不被忘掉；清理备份不删它', async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.alpha, [{ id: 'old_1' }]);
  const backupPath = await archive(fixture, fixture.alpha);
  const legacyPath = path.join(path.dirname(backupPath), LEGACY_NAME);
  await fs.rename(backupPath, legacyPath);
  await setArchiveEpoch(legacyPath, 4);

  const found = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: fixture.root });
  assert.deepEqual(found.map((entry) => [entry.location.kind, entry.location.containerPath, entry.name]), [['archive', legacyPath, LEGACY_NAME]]);
  const entry = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root }), legacyPath);
  assert.equal(entry?.status, 'failed');
  assert.equal(entry.code, 'foreign-history-upgrade-failed');
  assert.match(entry.reason, /已发布旧格式（第 4 代），在私有副本上升级时核验未通过/);
  assert.equal(entry.locatedPath, path.join(legacyPath, 'active'));
  assert.ok(Number(entry.size?.bytes) > 0, '列出大小');

  // As a previous data directory holding only this archive: remembered, not "empty".
  const other = await fs.realpath(await fs.mkdtemp(path.join(fixture.base, 'current-')));
  assert.deepEqual(await foreign.previousDataRootsWithoutForeignHistory({ configurationRootPath: other, previousDataRootPaths: [fixture.root] }), []);
  const fromOther = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: other, previousDataRootPaths: [fixture.root] });
  assert.ok(fromOther.some((item) => item.location.containerPath === legacyPath && item.location.side === 'previous'), '也作为旧目录的归档列出');

  // Backup cleanup lists it as foreign history and keeps it (not verified: never deletable).
  const database = await openWindow(fixture);
  try {
    const item = (await planRuntimeBackupCleanup(fixture.root, database)).items.find((candidate) => candidate.path === legacyPath);
    assert.equal(item?.kind, 'foreign-history', JSON.stringify(item));
    assert.equal(item.deletable, false);
    assert.match(item.reason, /未通过核验/);
  } finally { await database.close(); }
  assert.ok(await exists(path.join(legacyPath, 'active', 'limcode.sqlite')));
});

test('盲审 #2：迁移之后删除旧目录，默认保留的归档按新旧两种命名都计数，只剩 <17 位数字> 的归档与清理残留时旧目录仍被记住', async (t) => {
  const fixture = await moving.createFixture(t);
  const authority = new RootAuthority(() => fixture.alpha.binding.paths.dataRootPath, undefined, () => fixture.root);
  const first = await archiveCurrentRuntimeRootForReset(authority, fixture.alpha.scopeRoot);
  const legacyPath = path.join(path.dirname(first.backupPath), LEGACY_NAME);
  await fs.rename(first.backupPath, legacyPath);
  await setArchiveEpoch(legacyPath, 4);
  const fresh = await moving.initialize(fixture.alpha.scopeRoot, fixture.alpha.id);
  const second = await archiveCurrentRuntimeRootForReset(new RootAuthority(() => fresh.binding.paths.dataRootPath, undefined, () => fixture.root), fixture.alpha.scopeRoot);
  await fs.rename(second.backupPath, `${second.backupPath}${LEFTOVER}`);
  await moving.initialize(fixture.alpha.scopeRoot, fixture.alpha.id);

  const target = path.join(fixture.base, 'new-home');
  const plan = await moving.planWithRuntime(fixture, target);
  await moving.relocate(fixture, plan);
  const { result } = await moving.deleteAsConfirmed({ oldRootPath: fixture.root, currentRootPath: target });
  assert.equal(result.remainingDataSets, 0);
  assert.equal(result.remainingArchives, 2, '17 位数字名的归档与清理中断留下的残留都算保留的归档');
  assert.ok(await exists(legacyPath));
  assert.ok(await exists(`${second.backupPath}${LEFTOVER}`));
});

// --- #3: when a previous data directory is "empty" -------------------------------------------------------

test('盲审 #3(a)：旧目录不在了（例如放在挂载点下、盘没接上，挂载点目录还在）不算已空、不被忘掉；在而且确实空的才忘掉', async (t) => {
  const fixture = await home(t);
  const mountPoint = path.join(fixture.base, 'mnt-disk');
  await fs.mkdir(mountPoint);
  const gone = path.join(mountPoint, 'limcode-data');
  const empty = path.join(fixture.base, 'emptied');
  await fs.mkdir(empty);
  assert.deepEqual(await foreign.previousDataRootsWithoutForeignHistory({
    configurationRootPath: fixture.root, previousDataRootPaths: [gone, empty]
  }), [empty]);
});

test('盲审 #3(b)：旧目录里只剩清理备份中断留下的 <归档>.deleting-<16hex>，不算已空；清理仍能在它里面找到这份残留', async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.alpha, [{ id: 'old_1' }]);
  const backupPath = await archive(fixture, fixture.alpha);
  await fs.rename(backupPath, `${backupPath}${LEFTOVER}`);
  const other = await fs.realpath(await fs.mkdtemp(path.join(fixture.base, 'current-')));
  const input = { configurationRootPath: other, previousDataRootPaths: [fixture.root] };
  assert.deepEqual((await foreign.listRenamedForeignRuntimeRoots(input, /^(.+)\.deleting-[0-9a-f]{16}$/)).map((item) => item.path), [`${backupPath}${LEFTOVER}`]);
  assert.deepEqual(await foreign.previousDataRootsWithoutForeignHistory(input), [], '有残留的旧目录不被忘掉');
});

// --- #1: what the user deleted from the source itself -------------------------------------------------

test('盲审 #1：本版本在来源库里删掉的对话（删除记录记在它的身份下）不会经它的较早拷贝回到当前库；来源延续的身份下记的删除同样生效', async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.current, [{ id: 'own_1' }]);
  await seedConversations(fixture.alpha, [{ id: 'a_1' }, { id: 'a_2' }]);
  // An earlier copy of alpha (e.g. a copied directory renamed aside by a relocation) holds a_1 and a_2.
  const container = path.join(fixture.base, `${path.basename(fixture.root)}.limcode-copied-2026-09-28T01-02-03-004Z-0000abcd`);
  await fs.cp(fixture.root, container, { recursive: true });
  // a_1 deleted in alpha while it was the current data set: recorded under alpha's identity.
  await deleteWithCommand(fixture.alpha.authority, fixture.root, 'a_1');
  assert.deepEqual(brief(await batch(fixture, explicit(fixture.alpha.id))).merged, [[fixture.alpha.id, 1, 0]]);
  await fs.rm(path.dirname(fixture.alpha.binding.paths.dataRootPath), {recursive:true});

  const report = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root });
  const copy = report.entries.find((entry) => entry.location.containerPath === container && entry.scope === fixture.alpha.id);
  assert.equal(copy?.status, 'verified', copy?.reason);
  assert.equal(copy.sameAsLocal, undefined, 'alpha 删掉之后它不再是谁的旧拷贝');
  await requestMerge(fixture.root, copy);
  assert.deepEqual(brief(await batch(fixture, explicit(copy.id))).merged, [[copy.id, 0, 1]], '按 alpha 身份下的删除记录跳过 a_1');
  assert.deepEqual(conversations(fixture), ['a_2', 'own_1'], '本版本删掉的 a_1 没有回来');

  // A deletion recorded under an identity alpha continues (a relocation carried it into alpha) counts too.
  const second = await home(t);
  await seedConversations(second.alpha, [{ id: 'b_1' }, { id: 'b_2' }]);
  const copied = path.join(second.base, `${path.basename(second.root)}.limcode-copied-2026-09-28T01-02-03-004Z-0000abcd`);
  await fs.cp(second.root, copied, { recursive: true });
  // Model a source no longer in this configuration root. The product now refuses deleting an unmerged library.
  await fs.rename(second.alpha.scopeRoot, path.join(second.base, 'source-moved-away'));
  const earlier = { dataSetId: randomUUID(), rootInstanceId: randomUUID() };
  const aliases = path.join(resolveVscodeRuntimeMergeLedgerRoot({ globalStoragePath: second.root }), 'aliases');
  await fs.mkdir(aliases, { recursive: true });
  await fs.writeFile(path.join(aliases, `${second.alpha.binding.dataSetId}.${second.alpha.binding.rootInstanceId}.json`),
    JSON.stringify({ version: 1, continues: [{ ...earlier, relocationId: randomUUID(), at: new Date().toISOString() }] }));
  await records.recordRuntimeDeletedConversations(second.root, earlier, ['b_2']);
  const other = (await foreign.inspectForeignRuntimeHistory({ configurationRootPath: second.root })).entries
    .find((entry) => entry.location.containerPath === copied && entry.scope === second.alpha.id);
  await requestMerge(second.root, other);
  assert.deepEqual(brief(await batch(second, explicit(other.id))).merged, [[other.id, 1, 1]]);
  assert.deepEqual(conversations(second), ['b_1']);
});

test('盲审 #1 配套：删除命令失败、对话还在（删除没有提交）时撤回它写下的删除记录，以后合并不会把这个没删掉的对话跳过', async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.current, [{ id: 'keep_1' }]);
  const failing = (real) => ({
    inspect: (id) => real.inspect(id),
    markStopping: (ids) => real.markStopping(ids),
    delete: async (id, options) => {
      await options.beforeCommit(['keep_1']);
      throw new Error('模拟：删除事务失败');
    }
  });
  await assert.rejects(deleteWithCommand(fixture.current.authority, fixture.root, 'keep_1', failing), /模拟：删除事务失败/);
  assert.deepEqual(conversations(fixture), ['keep_1'], '对话还在');
  assert.deepEqual([...await records.readRuntimeDeletedConversations(fixture.root, [fixture.current.binding])], [], '删除记录已撤回');
  const directory = path.join(resolveVscodeRuntimeMergeLedgerRoot({ globalStoragePath: fixture.root }), 'deleted-conversations',
    `${fixture.current.binding.dataSetId}.${fixture.current.binding.rootInstanceId}`);
  assert.deepEqual(await fs.readdir(directory), [], '文件删掉了');

  // A command failing after its deletion committed (the conversation is gone) keeps the record.
  await seedConversations(fixture.current, [{ id: 'gone_1' }]);
  const late = (real) => ({
    inspect: (id) => real.inspect(id),
    markStopping: (ids) => real.markStopping(ids),
    delete: async (id, options) => {
      await real.delete(id, options);
      throw new Error('模拟：提交之后出错');
    }
  });
  await assert.rejects(deleteWithCommand(fixture.current.authority, fixture.root, 'gone_1', late), /模拟：提交之后出错/);
  assert.deepEqual(conversations(fixture), ['keep_1'], 'gone_1 已删除');
  assert.deepEqual([...await records.readRuntimeDeletedConversations(fixture.root, [fixture.current.binding])], ['gone_1'], '提交了的删除保留记录');

  // A deletion that did commit keeps its record.
  const deleted = await deleteWithCommand(fixture.current.authority, fixture.root, 'keep_1');
  assert.deepEqual(deleted.deletedConversationIds, ['keep_1']);
  assert.deepEqual([...await records.readRuntimeDeletedConversations(fixture.root, [fixture.current.binding])].sort(), ['gone_1', 'keep_1']);
});

// --- #4: the list never waits for a claim held elsewhere --------------------------------------------------

test('盲审 #4：一个外来库的声明被长时间持有时，列表不等它：结果已缓存的照常列出，没缓存的写明“正在被合并或查看，稍后再核验”（暂时无法核验，不入缓存），其余的照常核验', { timeout: 60000 }, async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.alpha, [{ id: 'x_1' }]);
  const cachedPath = await archive(fixture, fixture.alpha);
  const cached = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root }), cachedPath);
  assert.equal(cached?.status, 'verified', cached?.reason);
  const alpha = await moving.initialize(fixture.alpha.scopeRoot, fixture.alpha.id);
  await seedConversations(alpha, [{ id: 'y_1' }]);
  const busyPath = await archive(fixture, alpha);
  const freeAlpha = await moving.initialize(fixture.alpha.scopeRoot, fixture.alpha.id);
  await seedConversations(freeAlpha, [{ id: 'z_1' }]);
  const freePath = await archive(fixture, freeAlpha);
  const busy = (await foreign.discoverForeignRuntimeHistory({ configurationRootPath: fixture.root })).find((entry) => entry.location.containerPath === busyPath);
  const holds = [];
  for (const entry of [cached, busy]) {
    const root = await foreign.locateForeignRuntimeRoot(fixture.root, entry.location);
    holds.push(await foreign.holdForeignRuntimeRootClaim(fixture.paths, entry.id, root.located.rootPointerPath));
  }
  try {
    const started = Date.now();
    const report = await Promise.race([
      foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root }),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 15000))
    ]);
    assert.notEqual(report, 'timeout', '列表没有等被占的声明');
    assert.ok(Date.now() - started < 15000);
    assert.equal(entryAt(report, cachedPath)?.status, 'verified', '已缓存的照常列出');
    const held = entryAt(report, busyPath);
    assert.deepEqual([held?.status, held?.code], ['unavailable', 'foreign-history-busy']);
    assert.equal(held.reason, '它正在被合并或查看（占用它的是另一个窗口或操作），稍后再核验。');
    assert.equal(entryAt(report, freePath)?.status, 'verified', '其余的照常核验');
    assert.equal(await exists(path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'foreign', `${busy.id.replace(/:/g, '-')}.json`)), false, '不入缓存');
  } finally {
    for (const hold of holds) await hold.release();
  }
  assert.equal(entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root }), busyPath)?.status, 'verified', '放开之后照常核验');
});

// --- #5: the foreign database is copied from descriptors ------------------------------------------------

function sharedLock(file) {
  return execFileSync('python3', ['-c', `
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
try:
    fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB, 510, 0x40000002, 0)
    fcntl.lockf(fd, fcntl.LOCK_UN, 510, 0x40000002, 0)
    print('free')
except OSError:
    print('held')
`, file], { encoding: 'utf8' }).trim();
}

test('盲审 #5：复制外来数据库按描述符打开：检查之后、打开之前被换成当前库数据库的硬链接，打开后按描述符认出是持锁文件，不复制、描述符不关，锁仍然持有', { skip: !PYTHON }, async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.alpha, [{ id: 'x_1' }]);
  const archivePath = await archive(fixture, fixture.alpha);
  const window = await openWindow(fixture);
  t.after(() => window.close().catch(() => undefined));
  const liveDb = fixture.current.binding.paths.databasePath;
  assert.equal(sharedLock(liveDb), 'held', '本进程打开的当前库持有 SHARED 锁');
  const held = await foreign.heldDatabaseFiles(fixture.root);
  const entry = (await foreign.discoverForeignRuntimeHistory({ configurationRootPath: fixture.root })).find((item) => item.location.containerPath === archivePath);
  const root = await foreign.locateForeignRuntimeRoot(fixture.root, entry.location, held);
  const database = root.located.databasePath;
  const open = fsp.open;
  let swapped = false;
  fsp.open = async function (target, ...rest) {
    if (!swapped && path.resolve(String(target)) === database) {
      swapped = true;
      await fs.rm(database);
      await fs.link(liveDb, database);
    }
    return open.call(this, target, ...rest);
  };
  try {
    await assert.rejects(foreign.copyLocatedRuntimeDatabase(root, held), (error) => error.code === 'foreign-history-open-database');
  } finally { fsp.open = open; }
  assert.equal(swapped, true, '复制经描述符打开数据库');
  assert.equal(sharedLock(liveDb), 'held', '锁仍然持有');
});

// --- #7: merge state after a relocation renamed the container ---------------------------------------------

test('盲审 #7：外来 id 变了（迁移后归档成了旧目录的归档）时，按身份与内容摘要找回合并记录，列表仍显示“已合并”与跳过数；内容不同或那条记录属于列表里另一项时不借用', async (t) => {
  const fixture = await home(t);
  const current = { dataSetId: fixture.current.binding.dataSetId, rootInstanceId: fixture.current.binding.rootInstanceId };
  const source = { dataSetId: randomUUID(), rootInstanceId: randomUUID() };
  const oldId = 'foreign:archive:0123456789abcdef';
  await ledger.writeRuntimeDataSetMergeLedgerRecord(fixture.paths, {
    candidateId: oldId, state: 'merged', source: { ...source, contentDigest: 'digest-a', rows: 3 }, target: current,
    mergedAt: '2026-09-27T08:09:10.000Z', insertedRows: 3, reusedRows: 0, insertedConversations: 1, insertedConversationIds: ['c_1'],
    skippedConversations: 2
  });
  const listed = (id, contentDigest) => ({ id, status: 'verified', ...source, contentDigest });
  const renamed = listed('foreign:archive:fedcba9876543210', 'digest-a');
  const states = await foreignMerge.readForeignRuntimeHistoryMergeStates(fixture.paths, [renamed]);
  assert.deepEqual(states.get(renamed.id), { state: 'merged', mergedAt: '2026-09-27T08:09:10.000Z', intoCurrent: true, changedSinceMerge: false, skippedConversations: 2 });
  const changed = listed('foreign:archive:fedcba9876543210', 'digest-b');
  assert.equal((await foreignMerge.readForeignRuntimeHistoryMergeStates(fixture.paths, [changed])).get(changed.id), undefined, '内容不同不借用');
  const both = await foreignMerge.readForeignRuntimeHistoryMergeStates(fixture.paths, [listed(oldId, 'digest-a'), renamed]);
  assert.equal(both.get(oldId)?.state, 'merged');
  assert.equal(both.get(renamed.id), undefined, '记录属于列表里的另一项');
});

// --- #8 and the old-copy tip: backup cleanup ---------------------------------------------------------------

test('盲审 #8：外来库有等待中的合并请求时清理备份不判可删、删除前复核也保留；请求结束之后才可删', async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.alpha, [{ id: 'x_1' }]);
  assert.deepEqual(brief(await batch(fixture)).merged, [[fixture.alpha.id, 1, 0]]);
  const archivePath = await archive(fixture, fixture.alpha);
  const entry = entryAt(await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root }), archivePath);
  const itemOf = (plan) => plan.items.find((item) => item.path === archivePath);
  let database = await openWindow(fixture);
  try {
    const plan = await planRuntimeBackupCleanup(fixture.root, database);
    assert.equal(itemOf(plan)?.deletable, true, '内容都在当前库里：可删');
    // The user asks for its merge after the plan was shown: the deletion checks again and keeps it.
    await requestMerge(fixture.root, entry);
    const result = await deleteRuntimeBackups(plan, database, [itemOf(plan).key]);
    assert.deepEqual(result.deleted, []);
    assert.match(result.kept.map((kept) => kept.reason).join('\n'), /你已请求把它合并进当前库，合并还没完成；合并完成或请求过期之后再清理；这一项没有删除/);
    assert.ok(await exists(archivePath), '来源保留');
  } finally { await database.close(); }

  database = await openWindow(fixture);
  try {
    const item = itemOf(await planRuntimeBackupCleanup(fixture.root, database));
    assert.deepEqual([item?.deletable, item?.reason], [false, '你已请求把它合并进当前库，合并还没完成；合并完成或请求过期之后再清理']);
  } finally { await database.close(); }
  await ledger.removeRuntimeDataSetMergeRequest(fixture.paths, entry.id);
  database = await openWindow(fixture);
  try { assert.equal(itemOf(await planRuntimeBackupCleanup(fixture.root, database))?.deletable, true, '请求结束之后可删'); }
  finally { await database.close(); }
});

test('Windows 上按路径的 stat 不带卷序列号（dev）时，打开的描述符仍认作 lstat 找到的那个文件；文件 id 不同照样判为被替换', () => {
  // Node on Windows: lstat leaves dev unset (0) while the descriptor's stat reports the volume serial.
  const found = { dev: 0n, ino: 281474976710701n };
  const opened = { dev: 2717616129n, ino: 281474976710701n };
  assert.equal(foreign.sameOpenedFile(found, opened, 'win32'), true);
  assert.equal(foreign.sameOpenedFile(found, { ...opened, ino: 281474976710702n }, 'win32'), false);
  assert.equal(foreign.sameOpenedFile(found, opened, 'linux'), false, '其它平台 dev 不同就是另一个文件');
  assert.equal(foreign.sameOpenedFile({ dev: 7n, ino: 9n }, { dev: 7n, ino: 9n }, 'darwin'), true);
});
