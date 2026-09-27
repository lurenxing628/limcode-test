import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = kernelFile('index.js');
const Database = require('better-sqlite3');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { projectFolderAssignmentSteps } = kernelFile('conversationProject.js');
const { mergeHistoricalDataSetsOnline } = kernelFile('runtimeDataSetMerge.js');
const { writeRuntimeDataSetMergeFinalization } = kernelFile('runtimeDataSetMergeLedger.js');
const { migratePreviousRuntimeEpochIfRequired } = kernelFile('runtimeEpochMigration.js');
const { deleteRuntimeBackups, planRuntimeBackupCleanup } = kernelFile('runtimeBackupCleanup.js');
const {
  resolveVscodeRuntimeDataRoot, resolveVscodeRuntimeMergeLedgerRoot, resolveVscodeWorkspaceRuntimeScope,
  resolveVscodeWorkspaceRuntimeScopeRoot, selectVscodeRuntimeDataSet
} = kernelFile('vscodeRootAuthority.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = '2026-09-26T00:00:00.000Z';
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
const PROJECT = { uri: 'file:///workspace/shared', name: 'shared' };
const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);

test('合并前备份：内容全在当前库的旧备份可删、最新一份保留；删除先改名再删，当前库只经它自己的读取线程查询', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one', 'conversation_two']);
  const database = await openCurrent(t, fixture);
  const older = await targetBackup(fixture.current, database, 180);
  const newest = await targetBackup(fixture.current, database, 120);
  const reader = countingReader(database);

  const plan = await planRuntimeBackupCleanup(fixture.root, reader);
  const olderItem = itemAt(plan, older);
  assert.equal(olderItem.kind, 'merge-target');
  assert.equal(olderItem.deletable, true, olderItem.reason);
  assert.deepEqual([olderItem.conversations, olderItem.revisions, olderItem.missingConversations, olderItem.missingRevisions], [2, 4, 0, 0]);
  assert.match(olderItem.reason, /^可以删除：其中 2 个对话、4 条消息都完整存在于当前库$/);
  assert.equal(olderItem.inCurrentDataSet, true);
  assert.equal(olderItem.dataSetCandidateId, 'default');
  assert.ok(BigInt(olderItem.bytes) > 0n);
  assert.equal(olderItem.reclaimableBytes, olderItem.bytes);
  assert.ok(olderItem.createdAt, '创建时间取自目录名');
  const newestItem = itemAt(plan, newest);
  assert.equal(newestItem.deletable, false);
  assert.match(newestItem.reason, /最新的一份合并前备份/);
  assert.ok(reader.calls > 0, '当前库经它自己的读取线程查询');
  assert.ok(reader.maxBatch <= 250, '每次最多查 250 个 id');

  const renames = [];
  const result = await deleteRuntimeBackups(plan, reader, [olderItem.key, newestItem.key], {
    onFaultPoint(point) { renames.push(point); }
  });
  assert.deepEqual(result.deleted.map((item) => item.path), [older]);
  assert.deepEqual(result.kept.map((item) => [item.path, item.reason]), [[newest, '不在可以删除的清单里']]);
  assert.deepEqual(renames, ['before-rename', 'after-rename']);
  await assert.rejects(fs.lstat(older), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.dirname(older)), [path.basename(newest)], '没有留下 .deleting- 目录');
  const again = await planRuntimeBackupCleanup(fixture.root, reader);
  assert.equal(again.items.some((item) => item.path === older), false);
});

test('合并前备份的保护：不满 1 小时的、目录里有 .tmp 的都保留（与最新一份分别判断）', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const database = await openCurrent(t, fixture);
  const old = await targetBackup(fixture.current, database, 240);
  const writing = await targetBackup(fixture.current, database, 180);
  await fs.writeFile(path.join(writing, `limcode.sqlite.${process.pid}.tmp`), 'partial');
  await backdate(writing, 180);
  const young = await targetBackup(fixture.current, database, 30);
  const newest = await targetBackup(fixture.current, database, 10);

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(plan, old).deletable, true, itemAt(plan, old).reason);
  assert.deepEqual([itemAt(plan, writing).deletable, itemAt(plan, writing).reason], [false, '备份还没有写完（目录里有临时文件），保留']);
  assert.deepEqual([itemAt(plan, young).deletable, itemAt(plan, young).reason], [false, '创建不满 1 小时，可能正被合并使用，保留']);
  assert.match(itemAt(plan, newest).reason, /最新的一份合并前备份/);
  // An hour later the young one is an ordinary older backup.
  const later = await planRuntimeBackupCleanup(fixture.root, database, { now: () => Date.now() + 61 * MINUTE });
  assert.equal(itemAt(later, young).deletable, true, itemAt(later, young).reason);
});

test('覆盖核对：当前库删掉一个对话后，对应副本变为不可删；列出之后才删掉的对话也在锁内挡住删除', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_kept', 'conversation_deleted']);
  const database = await openCurrent(t, fixture);
  const backup = await targetBackup(fixture.current, database, 180);
  await targetBackup(fixture.current, database, 120);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(plan, backup).deletable, true);

  await database.transaction([repo('Conversation').delete('conversation_deleted')]);
  const result = await deleteRuntimeBackups(plan, database, [itemAt(plan, backup).key]);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.kept.map((item) => item.reason),
    ['含 1 个当前库没有的对话（可能是你删掉的），按历史保留；这一项没有删除']);
  assert.ok((await fs.lstat(backup)).isDirectory());

  const next = await planRuntimeBackupCleanup(fixture.root, database);
  const item = itemAt(next, backup);
  assert.deepEqual([item.deletable, item.missingConversations, item.reason],
    [false, 1, '含 1 个当前库没有的对话（可能是你删掉的），按历史保留']);
});

test('列出之后、删除之前备份内容变了：那一项不删', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const database = await openCurrent(t, fixture);
  const touched = await targetBackup(fixture.current, database, 240);
  const replaced = await targetBackup(fixture.current, database, 180);
  await targetBackup(fixture.current, database, 120);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(plan, touched).deletable, true);
  assert.equal(itemAt(plan, replaced).deletable, true);

  await fs.writeFile(path.join(touched, 'note.txt'), '列出之后放进来的文件');
  const copy = path.join(replaced, 'limcode.sqlite.copy');
  await fs.copyFile(path.join(replaced, 'limcode.sqlite'), copy);
  await fs.rename(copy, path.join(replaced, 'limcode.sqlite'));
  const result = await deleteRuntimeBackups(plan, database, [itemAt(plan, touched).key, itemAt(plan, replaced).key]);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.kept.map((item) => item.reason), [
    '列出之后这份备份有变化，请重新检查；这一项没有删除',
    '列出之后这份备份有变化，请重新检查；这一项没有删除'
  ]);
  assert.ok((await fs.lstat(touched)).isDirectory());
  assert.ok((await fs.lstat(replaced)).isDirectory());
});

test('升级前备份：升级完成满 7 天才可删；控制根里有进行中的升级日志或正在提交的合并时保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_before_upgrade', 'conversation_other']);
  await downgradeToEpoch4(fixture.current.binding);
  const upgraded = await migratePreviousRuntimeEpochIfRequired(fixture.current.authority);
  assert.equal(upgraded.migrated, true);
  fixture.current.binding = upgraded.binding;
  const backup = upgraded.backupPath;
  const database = await openCurrent(t, fixture);

  const fresh = await planRuntimeBackupCleanup(fixture.root, database);
  const freshItem = itemAt(fresh, backup);
  assert.equal(freshItem.kind, 'epoch-migration');
  assert.match(freshItem.reason, /^升级完成不满 7 天，.+ 之后才可以删除$/);
  const eightDays = { now: () => Date.now() + 8 * DAY };
  const later = await planRuntimeBackupCleanup(fixture.root, database, eightDays);
  assert.equal(itemAt(later, backup).deletable, true, itemAt(later, backup).reason);
  assert.match(itemAt(later, backup).reason, /2 个对话、4 条消息都完整存在于当前库/);

  const journal = path.join(controlRoot(fixture.current), 'epoch-to-5-migration.json');
  await fs.writeFile(journal, '{}');
  const journaled = await planRuntimeBackupCleanup(fixture.root, database, eightDays);
  assert.equal(itemAt(journaled, backup).reason, '有进行中的操作（epoch-to-5-migration.json），完成之后再清理');
  const result = await deleteRuntimeBackups(later, database, [itemAt(later, backup).key], eightDays);
  assert.deepEqual(result.kept.map((item) => item.reason), ['有进行中的操作（epoch-to-5-migration.json），完成之后再清理；这一项没有删除'],
    '锁内复核：列出之后出现的日志也挡住删除');
  await fs.rm(journal);

  const records = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'records');
  await fs.mkdir(records, { recursive: true });
  const record = path.join(records, `${fixture.alpha.id.replace(/:/g, '-')}.json`);
  await fs.writeFile(record, JSON.stringify({
    kind: 'limcode-runtime-data-set-merge', candidateId: fixture.alpha.id, state: 'committing', commitId: 'commit-1', updatedAt: NOW,
    source: { dataSetId: fixture.alpha.binding.dataSetId, rootInstanceId: fixture.alpha.binding.rootInstanceId, rootGeneration: 1, pointerRevision: 1, contentDigest: 'x' },
    target: { dataSetId: upgraded.binding.dataSetId, rootInstanceId: upgraded.binding.rootInstanceId }
  }));
  const committing = await planRuntimeBackupCleanup(fixture.root, database, eightDays);
  assert.equal(itemAt(committing, backup).reason, '有进行中的操作（正在提交的合并），完成之后再清理');
  await fs.rm(record);

  const final = await planRuntimeBackupCleanup(fixture.root, database, eightDays);
  const deleted = await deleteRuntimeBackups(final, database, [itemAt(final, backup).key], eightDays);
  assert.deepEqual(deleted.deleted.map((item) => item.path), [backup]);
  await assert.rejects(fs.lstat(backup), { code: 'ENOENT' });
});

test('合并来源的收尾前备份：真实收尾留下的可删；被未报告的收尾记录引用时保留；来源里删掉对话或少一条消息后保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_current']);
  await seed(fixture.alpha, ['conversation_alpha_one', 'conversation_alpha_two']);
  await seedActiveTurn(fixture.alpha, 'conversation_alpha_one');
  const database = await openCurrent(t, fixture);
  const report = await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database });
  assert.deepEqual([report.failures, report.blocked, report.deferred], [[], [], []]);
  const sourceBackup = report.merged[0].finalized.sourceBackupPath;
  assert.equal(path.basename(path.dirname(sourceBackup)), 'merge-source-backups');

  const reader = countingReader(database);
  const plan = await planRuntimeBackupCleanup(fixture.root, reader);
  const item = itemAt(plan, sourceBackup);
  assert.equal(item.kind, 'merge-source');
  assert.equal(item.deletable, true, item.reason);
  assert.equal(item.inCurrentDataSet, false);
  assert.equal(item.reason, `可以删除：其中 2 个对话、4 条消息都完整存在于这个历史库（${fixture.alpha.id}）`);

  await writeRuntimeDataSetMergeFinalization(fixture.paths, {
    candidateId: fixture.alpha.id,
    source: { dataSetId: fixture.alpha.binding.dataSetId, rootInstanceId: fixture.alpha.binding.rootInstanceId },
    turns: 1, intents: 0, sourceBackupPath: sourceBackup, complete: true
  });
  const referenced = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(referenced, sourceBackup).reason, '被尚未报告的合并收尾记录引用，保留');
  const refused = await deleteRuntimeBackups(plan, database, [item.key]);
  assert.deepEqual(refused.kept.map((entry) => entry.reason), ['被尚未报告的合并收尾记录引用，保留；这一项没有删除']);
  await fs.rm(path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'finalizations', `${fixture.alpha.id.replace(/:/g, '-')}.json`));

  rawEdit(fixture.alpha, (source) => {
    source.pragma('foreign_keys = OFF');
    source.prepare('DELETE FROM message_current_revision_link WHERE revision_id = ?').run('conversation_alpha_two_message_1_revision');
    source.prepare('DELETE FROM message_revision WHERE id = ?').run('conversation_alpha_two_message_1_revision');
  });
  const revision = itemAt(await planRuntimeBackupCleanup(fixture.root, database), sourceBackup);
  assert.deepEqual([revision.deletable, revision.missingConversations, revision.missingRevisions, revision.reason],
    [false, 0, 1, `含 1 条这个历史库（${fixture.alpha.id}）没有的消息，按历史保留`]);

  rawEdit(fixture.alpha, (source) => source.prepare('DELETE FROM conversation WHERE id = ?').run('conversation_alpha_one'));
  const conversation = itemAt(await planRuntimeBackupCleanup(fixture.root, database), sourceBackup);
  assert.deepEqual([conversation.deletable, conversation.missingConversations],
    [false, 1]);
  assert.equal(conversation.reason, `含 1 个这个历史库（${fixture.alpha.id}）没有的对话（可能是你删掉的），按历史保留`);
});

test('来源库在列出之后有改动：锁内按文件状态复核，那一项不删', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_current']);
  await seed(fixture.alpha, ['conversation_alpha']);
  const database = await openCurrent(t, fixture);
  const backup = await sourceBackup(fixture.alpha);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(plan, backup).deletable, true, itemAt(plan, backup).reason);
  await seed(fixture.alpha, ['conversation_alpha_later']);
  const result = await deleteRuntimeBackups(plan, database, [itemAt(plan, backup).key]);
  assert.deepEqual(result.kept.map((item) => item.reason), ['暂时无法核对（所在历史库在检查之后有改动）；这一项没有删除']);
  assert.ok((await fs.lstat(backup)).isDirectory());
});

test('不是所在历史库的备份（身份不一致）与比所在历史库更新（代数更高）的备份都保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_current']);
  await seed(fixture.alpha, ['conversation_alpha']);
  const database = await openCurrent(t, fixture);
  const foreignSource = await sourceBackup(fixture.alpha);
  const foreign = path.join(controlRoot(fixture.current), 'merge-backups', backupName(300));
  await fs.mkdir(path.dirname(foreign), { recursive: true });
  await fs.rename(foreignSource, foreign);
  await backdate(foreign, 300);
  const ahead = await targetBackup(fixture.current, database, 240);
  rawEditFile(path.join(ahead, 'limcode.sqlite'), (backup) => backup.prepare('UPDATE root_binding SET root_generation = root_generation + 1').run());
  const binding = JSON.parse(await fs.readFile(path.join(ahead, 'root-binding.json'), 'utf8'));
  await fs.writeFile(path.join(ahead, 'root-binding.json'), JSON.stringify({ ...binding, rootGeneration: binding.rootGeneration + 1 }));
  await backdate(ahead, 240);
  await targetBackup(fixture.current, database, 120);

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual([itemAt(plan, foreign).deletable, itemAt(plan, foreign).reason], [false, '不是所在历史库的备份（身份不一致），按历史保留']);
  assert.deepEqual([itemAt(plan, ahead).deletable, itemAt(plan, ahead).reason], [false, '所在历史库比这份备份更旧（代数更低），按历史保留']);
});

test('改名之后崩溃（子进程 SIGKILL）：留下的 .deleting- 目录由下次清理删完', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const database = await openCurrent(t, fixture);
  const doomed = await targetBackup(fixture.current, database, 180);
  const kept = await targetBackup(fixture.current, database, 120);
  const key = itemAt(await planRuntimeBackupCleanup(fixture.root, database), doomed).key;

  const child = await runChild(['delete-then-crash', fixture.root, key]);
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const names = await fs.readdir(path.dirname(doomed));
  const leftover = names.find((name) => name.startsWith(`${path.basename(doomed)}.deleting-`));
  assert.ok(leftover, names.join(','));
  assert.match(leftover, /\.deleting-[0-9a-f]{16}$/);
  assert.equal(names.includes(path.basename(doomed)), false, '改名已经持久');

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual(plan.finishedDeletions, [path.join(path.dirname(doomed), leftover)]);
  assert.deepEqual(await fs.readdir(path.dirname(doomed)), [path.basename(kept)]);
  assert.equal(plan.items.some((item) => item.path.includes('.deleting-')), false);
  assert.equal(itemAt(plan, kept).deletable, false, '剩下的是最新一份');
});

test('符号链接不跟随：链接本身、目录里的链接、链接的备份目录都不删，链接指向的内容不变', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const database = await openCurrent(t, fixture);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-backup-cleanup-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const real = await targetBackup(fixture.current, database, 300);
  const target = path.join(outside, 'real-backup');
  await fs.rename(real, target);
  const linked = path.join(path.dirname(real), backupName(290));
  await fs.symlink(target, linked, 'dir');
  const withLink = await targetBackup(fixture.current, database, 240);
  const secret = path.join(outside, 'secret.txt');
  await fs.writeFile(secret, 'outside');
  await fs.symlink(secret, path.join(withLink, 'link.txt'));
  await backdate(withLink, 240);
  await targetBackup(fixture.current, database, 120);
  const alphaTarget = path.join(outside, 'alpha-source-backups');
  await fs.mkdir(alphaTarget);
  await fs.rename(await sourceBackup(fixture.alpha), path.join(alphaTarget, backupName(200)));
  const sourceBackups = path.join(controlRoot(fixture.alpha), 'merge-source-backups');
  await fs.rm(sourceBackups, { recursive: true, force: true });
  await fs.symlink(alphaTarget, sourceBackups, 'dir');
  const before = await treeSnapshot(outside);

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual([itemAt(plan, linked).deletable, itemAt(plan, linked).reason], [false, '是符号链接，不跟随也不删除']);
  assert.deepEqual([itemAt(plan, withLink).deletable, itemAt(plan, withLink).reason], [false, '目录里有符号链接，不跟随也不删除']);
  assert.deepEqual([itemAt(plan, sourceBackups).deletable, itemAt(plan, sourceBackups).reason], [false, '目录路径里有符号链接，不跟随也不删除']);
  const result = await deleteRuntimeBackups(plan, database, plan.items.map((item) => item.key));
  assert.deepEqual(result.deleted, []);
  assert.ok((await fs.lstat(linked)).isSymbolicLink());
  assert.ok((await fs.lstat(path.join(withLink, 'link.txt'))).isSymbolicLink());
  assert.deepEqual(await treeSnapshot(outside), before, '链接指向的内容没有被读改');
});

test('只列出的备份：归档、拷来的目录、旧格式 backups/ 与 .limcode-data-backups 写明名称、位置、大小和原因，不能删除', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const database = await openCurrent(t, fixture);
  const archive = path.join(fixture.root, '.limcode-runtime-backups', '20260901-010203-004-abcdef12');
  const copied = `${fixture.root}.limcode-copied-2026-09-02T01-02-03-004Z-12345678`;
  t.after(() => fs.rm(copied, { recursive: true, force: true }));
  const legacy = path.join(controlRoot(fixture.alpha), 'backups');
  const dataBackups = path.join(fixture.root, '.limcode-data-backups');
  for (const [directory, bytes] of [[archive, 11], [copied, 22], [legacy, 33], [dataBackups, 44]]) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'data.bin'), Buffer.alloc(bytes, 1));
  }
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  const listed = [archive, copied, legacy, dataBackups].map((directory) => itemAt(plan, directory));
  assert.deepEqual(listed.map((item) => [item.kind, item.deletable, item.bytes, item.name]), [
    ['reset-archive', false, '11', path.basename(archive)],
    ['copied-data-root', false, '22', path.basename(copied)],
    ['legacy-cutover', false, '33', 'backups'],
    ['data-backups', false, '44', '.limcode-data-backups']
  ]);
  assert.match(listed[0].reason, /含当时的对话；以后的版本会支持查看和合并，本版本只列出，不删除/);
  assert.match(listed[1].reason, /含对话；以后的版本会支持查看和合并，本版本只列出，不删除/);
  assert.equal(listed[0].createdAt, '2026-09-01T01:02:03.004Z');
  assert.equal(listed[1].createdAt, '2026-09-02T01:02:03.004Z');
  const result = await deleteRuntimeBackups(plan, database, listed.map((item) => item.key));
  assert.deepEqual(result.kept.map((item) => item.reason), Array(4).fill('不在可以删除的清单里'));
  for (const directory of [archive, copied, legacy, dataBackups]) assert.ok((await fs.lstat(directory)).isDirectory());
});

test('预计释放不计入还有其它硬链接的文件', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const database = await openCurrent(t, fixture);
  const backup = await targetBackup(fixture.current, database, 180);
  await targetBackup(fixture.current, database, 120);
  const sqlite = path.join(backup, 'limcode.sqlite');
  await fs.link(sqlite, path.join(controlRoot(fixture.current), 'shared-link.sqlite'));
  await backdate(backup, 180);
  const item = itemAt(await planRuntimeBackupCleanup(fixture.root, database), backup);
  const size = BigInt((await fs.stat(sqlite)).size);
  assert.equal(item.deletable, true, item.reason);
  assert.equal(BigInt(item.bytes) - BigInt(item.reclaimableBytes), size);
});

test('读不出的记录按保护处理：收尾记录无法读取时来源备份保留，合并记录无法读取时全部保留；没有升级完成记录的升级备份保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_current']);
  await seed(fixture.alpha, ['conversation_alpha']);
  const database = await openCurrent(t, fixture);
  const source = await sourceBackup(fixture.alpha);
  const target = await targetBackup(fixture.current, database, 180);
  await targetBackup(fixture.current, database, 120);
  const upgrade = path.join(controlRoot(fixture.current), 'epoch-migration-backups', '20260101T000000Z-abcdef12');
  await fs.mkdir(upgrade, { recursive: true });
  await fs.copyFile(path.join(target, 'limcode.sqlite'), path.join(upgrade, 'limcode.epoch-4.sqlite'));
  await fs.writeFile(path.join(upgrade, 'root-binding.epoch-4.json'), JSON.stringify({ ...fixture.current.binding, runtimeKernelEpoch: 4 }));
  const ledger = resolveVscodeRuntimeMergeLedgerRoot(fixture.paths);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(plan, source).deletable, true, itemAt(plan, source).reason);
  assert.equal(itemAt(plan, target).deletable, true, itemAt(plan, target).reason);
  assert.deepEqual([itemAt(plan, upgrade).deletable, itemAt(plan, upgrade).reason],
    [false, '没有升级完成记录（可能是旧版本或没有完成的升级留下的），按历史保留']);

  await fs.mkdir(path.join(ledger, 'finalizations'), { recursive: true });
  await fs.writeFile(path.join(ledger, 'finalizations', 'torn.json'), '{"kind":');
  const torn = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(torn, source).reason, '合并收尾记录无法读取，不能确认它没有被引用，保留');
  assert.equal(itemAt(torn, target).deletable, true, '收尾记录只关系到来源备份');
  await fs.rm(path.join(ledger, 'finalizations'), { recursive: true });

  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-backup-cleanup-records-'));
  t.after(() => fs.rm(elsewhere, { recursive: true, force: true }));
  await fs.rm(path.join(ledger, 'records'), { recursive: true, force: true });
  await fs.symlink(elsewhere, path.join(ledger, 'records'), 'dir');
  const unreadable = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(unreadable, source).reason, '有进行中的操作（合并记录无法读取），完成之后再清理');
  assert.equal(itemAt(unreadable, target).reason, '有进行中的操作（合并记录无法读取），完成之后再清理');
});

test('所在历史库在列出之后换了代数：锁内复核身份与代数，那一项不删', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_current']);
  await seed(fixture.alpha, ['conversation_alpha']);
  const database = await openCurrent(t, fixture);
  const backup = await sourceBackup(fixture.alpha);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(plan, backup).deletable, true, itemAt(plan, backup).reason);
  const { paths } = fixture.alpha.binding;
  const pointer = JSON.parse(await fs.readFile(paths.rootPointerPath, 'utf8'));
  await fs.writeFile(paths.rootPointerPath, JSON.stringify({ ...pointer, rootGeneration: pointer.rootGeneration + 1, pointerRevision: pointer.pointerRevision + 1 }));
  const epoch = JSON.parse(await fs.readFile(paths.runtimeEpochPath, 'utf8'));
  await fs.writeFile(paths.runtimeEpochPath, JSON.stringify({ ...epoch, rootGeneration: epoch.rootGeneration + 1 }));
  rawEdit(fixture.alpha, (source) => source.prepare('UPDATE root_binding SET root_generation = root_generation + 1, pointer_revision = pointer_revision + 1').run());
  const result = await deleteRuntimeBackups(plan, database, [itemAt(plan, backup).key]);
  assert.deepEqual(result.kept.map((item) => item.reason), ['所在历史库在检查之后发生了变化，请重新检查；这一项没有删除']);
  assert.ok((await fs.lstat(backup)).isDirectory());
  const next = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(next, backup).deletable, true, '代数更高的同一历史库仍然覆盖这份备份');
});

// ---------------------------------------------------------------------------------------------

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-backup-cleanup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = { globalStoragePath: root };
  const current = await initialize(root, 'default');
  const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: ['file:///workspace/alpha'] });
  const scopeRoot = resolveVscodeWorkspaceRuntimeScopeRoot(paths, scope);
  await fs.mkdir(scopeRoot, { recursive: true });
  const alpha = await initialize(scopeRoot, `workspace:${scope.key}`);
  await selectVscodeRuntimeDataSet(paths, 'default');
  return { root, paths, current, alpha };
}

async function initialize(scopeRoot, id) {
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  return { id, scopeRoot, authority, binding };
}

async function openCurrent(t, fixture) {
  const database = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `window-${randomUUID()}` });
  t.after(() => database.close());
  return database;
}

function countingReader(database) {
  const reader = {
    calls: 0,
    maxBatch: 0,
    binding: database.binding,
    async snapshot(reads) {
      reader.calls += 1;
      reader.maxBatch = Math.max(reader.maxBatch, reads.length);
      return database.snapshot(reads);
    }
  };
  return reader;
}

async function seed(dataSet, conversationIds) {
  const runtime = await kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `seed-${randomUUID()}` });
  try {
    const store = new kernel.ContentAddressedStore(dataSet.authority, dataSet.binding);
    for (const id of conversationIds) {
      const turnId = `${id}_turn`;
      const steps = [
        repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
        ...projectFolderAssignmentSteps({ conversationId: id, folder: PROJECT, now: NOW }),
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
  } finally { await runtime.close(); }
}

/** An active Turn left by an old window: the merge closes it after backing the source up. */
async function seedActiveTurn(dataSet, conversationId) {
  const runtime = await kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `seed-${randomUUID()}` });
  try {
    await runtime.transaction([repo('Turn').insert({
      id: `${conversationId}_unfinished_turn`, conversation_id: conversationId, status: 'active', created_at: NOW, updated_at: NOW, terminal_at: null
    })]);
  } finally { await runtime.close(); }
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

/** The merge engine's source backup (backupSource): an offline data set's Backup API copy. */
async function sourceBackup(dataSet) {
  const directory = path.join(controlRoot(dataSet), 'merge-source-backups', backupName(400));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(directory, 'root-binding.json'), `${JSON.stringify(dataSet.binding, null, 2)}\n`);
  const live = new Database(dataSet.binding.paths.databasePath, { readonly: true, fileMustExist: true });
  try { await live.backup(path.join(directory, 'limcode.sqlite')); }
  finally { live.close(); }
  return directory;
}

async function backdate(directory, minutesAgo) {
  const time = new Date(Date.now() - minutesAgo * MINUTE);
  await fs.utimes(directory, time, time);
}

function rawEdit(dataSet, write) {
  rawEditFile(dataSet.binding.paths.databasePath, write);
}

function rawEditFile(file, write) {
  const database = new Database(file);
  try {
    write(database);
    database.pragma('wal_checkpoint(TRUNCATE)');
  } finally { database.close(); }
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
    const dropManifest = database.prepare('DELETE FROM schema_manifest WHERE domain_key = ?');
    for (const schema of added) dropManifest.run(schema.key);
    database.prepare('UPDATE schema_manifest SET runtime_kernel_epoch = 4').run();
    database.prepare('UPDATE root_binding SET runtime_kernel_epoch = 4 WHERE singleton = 1').run();
    database.exec('COMMIT');
    database.pragma('wal_checkpoint(TRUNCATE)');
  } finally { database.close(); }
  const epoch = JSON.parse(await fs.readFile(binding.paths.runtimeEpochPath, 'utf8'));
  await fs.writeFile(binding.paths.runtimeEpochPath, `${JSON.stringify({ ...epoch, runtimeKernelEpoch: 4 }, null, 2)}\n`);
  await fs.writeFile(binding.paths.rootPointerPath, `${JSON.stringify({ ...binding, runtimeKernelEpoch: 4 }, null, 2)}\n`);
}

function controlRoot(dataSet) {
  return path.dirname(dataSet.binding.paths.dataRootPath);
}

function itemAt(plan, directory) {
  const item = plan.items.find((entry) => entry.path === directory);
  assert.ok(item, `没有列出 ${directory}：${plan.items.map((entry) => entry.path).join(', ')}`);
  return item;
}

function runChild(args) {
  const script = path.join(HERE, 'runtime-backup-cleanup-child.mjs');
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled } },
      (error, stdout, stderr) => resolve({ signal: error?.signal ?? null, code: error ? error.code ?? null : 0, stdout, stderr }));
  });
}

async function treeSnapshot(root) {
  const files = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else {
        const stat = await fs.lstat(file);
        files[path.relative(root, file)] = { size: stat.size, mtime: stat.mtimeMs,
          sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') };
      }
    }
  }
  await visit(root);
  return files;
}
