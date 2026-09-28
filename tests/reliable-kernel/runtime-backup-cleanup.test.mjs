import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
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
const { runtimeDataRootAdmissionClaimPath, runtimeMaintenanceClaimPath, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const durableDirectorySync = require(path.join(compiled, 'backend/capabilities/filesystem/durableDirectorySync.js'));
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
  assert.equal(olderItem.reason, '可以删除：内容已完整在当前库里（其中 2 个对话、4 个消息版本都在，显示的消息相同，正文文件也都在）');
  assert.equal(olderItem.inCurrentDataSet, true);
  assert.equal(olderItem.dataSetName, '当前库');
  assert.equal(olderItem.dataSetCandidateId, 'default');
  assert.ok(BigInt(olderItem.bytes) > 0n);
  assert.equal(olderItem.reclaimableBytes, olderItem.bytes);
  assert.ok(olderItem.createdAt, '创建时间取自目录名');
  const newestItem = itemAt(plan, newest);
  assert.equal(newestItem.deletable, false);
  assert.equal(newestItem.reason, '这是这个库最新的一份满 1 小时的完整合并前备份，保留');
  assert.ok(reader.calls > 0, '当前库经它自己的读取线程查询');
  assert.ok(reader.maxBatch <= 250, '每次最多查 250 个 id');

  const renames = [];
  const result = await deleteRuntimeBackups(plan, reader, [olderItem.key, newestItem.key], {
    onFaultPoint(point) { renames.push(point); }
  });
  assert.deepEqual(result.deleted.map((item) => item.path), [older]);
  assert.deepEqual(result.kept.map((item) => [item.path, item.reason]), [[newest, '不在可以删除的清单里']]);
  assert.deepEqual(renames, ['before-rename', 'after-rename', 'after-verify']);
  await assert.rejects(fs.lstat(older), { code: 'ENOENT' });
  assert.deepEqual(await fs.readdir(path.dirname(older)), [path.basename(newest)], '没有留下 .deleting- 目录');
  const again = await planRuntimeBackupCleanup(fixture.root, reader);
  assert.equal(again.items.some((item) => item.path === older), false);
});

test('合并前备份的保护：最新一份只认满 1 小时的完整备份，它和比它新的都保留；不满 1 小时（名字时间与目录修改时间取较晚的）、有 .tmp 的保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const database = await openCurrent(t, fixture);
  const oldest = await targetBackup(fixture.current, database, 300);
  const anchor = await targetBackup(fixture.current, database, 240);
  const writing = await targetBackup(fixture.current, database, 200);
  await fs.writeFile(path.join(writing, `limcode.sqlite.${process.pid}.tmp`), 'partial');
  await backdate(writing, 200);
  // Newer than the anchor and an hour old, but without a database: never the anchor, kept as newer.
  const incomplete = path.join(controlRoot(fixture.current), 'merge-backups', backupName(150));
  await fs.mkdir(incomplete);
  await fs.writeFile(path.join(incomplete, 'root-binding.json'), JSON.stringify(database.binding));
  await backdate(incomplete, 150);
  // Named 2 hours ago, but its directory changed 20 minutes ago: counted from the later time.
  const touched = await targetBackup(fixture.current, database, 120);
  await backdate(touched, 20);
  const young = await targetBackup(fixture.current, database, 30);
  const newest = await targetBackup(fixture.current, database, 10);

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  const reasons = (checked) => Object.fromEntries([oldest, anchor, writing, incomplete, touched, young, newest]
    .map((directory, index) => [['oldest', 'anchor', 'writing', 'incomplete', 'touched', 'young', 'newest'][index], itemAt(checked, directory).reason]));
  assert.equal(itemAt(plan, oldest).deletable, true, itemAt(plan, oldest).reason);
  assert.deepEqual(reasons(plan), {
    oldest: itemAt(plan, oldest).reason,
    anchor: '这是这个库最新的一份满 1 小时的完整合并前备份，保留',
    writing: '备份还没有写完（目录里有临时文件），保留',
    incomplete: '比这个库最新的一份满 1 小时的完整合并前备份还新，保留',
    touched: '创建不满 1 小时，可能正被合并使用，保留',
    young: '创建不满 1 小时，可能正被合并使用，保留',
    newest: '创建不满 1 小时，可能正被合并使用，保留'
  });
  // An hour later the newest complete one anchors the protection, and the ones before it are older backups.
  const later = await planRuntimeBackupCleanup(fixture.root, database, { now: () => Date.now() + 61 * MINUTE });
  for (const directory of [oldest, anchor, touched, young]) assert.equal(itemAt(later, directory).deletable, true, itemAt(later, directory).reason);
  assert.equal(itemAt(later, newest).reason, '这是这个库最新的一份满 1 小时的完整合并前备份，保留');
  assert.equal(itemAt(later, incomplete).reason, '备份里没有数据库文件，不处理');

  // Without any complete backup an hour old, every one stays.
  await fs.rm(oldest, { recursive: true });
  await fs.rm(anchor, { recursive: true });
  const none = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(none, incomplete).reason, '这个库还没有满 1 小时的完整合并前备份，全部保留');
});

test('锁内复核按同一口径找最新一份：列出之后原来的最新一份不见了、只多了不满 1 小时的，那一项不删', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const database = await openCurrent(t, fixture);
  const older = await targetBackup(fixture.current, database, 240);
  const anchor = await targetBackup(fixture.current, database, 180);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(plan, older).deletable, true, itemAt(plan, older).reason);
  // Meanwhile another window's merge batch pruned the anchor and wrote a backup it may still discard.
  await fs.rm(anchor, { recursive: true });
  await targetBackup(fixture.current, database, 5);
  const result = await deleteRuntimeBackups(plan, database, [itemAt(plan, older).key]);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.kept.map((item) => item.reason), ['这是这个库最新的一份满 1 小时的完整合并前备份，保留；这一项没有删除']);
  assert.ok((await fs.lstat(older)).isDirectory());
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
  assert.match(freshItem.reason, /^升级完成不满 7 天，\d{4}-\d\d-\d\d \d\d:\d\d 之后才可以删除$/);
  const eightDays = { now: () => Date.now() + 8 * DAY };
  const later = await planRuntimeBackupCleanup(fixture.root, database, eightDays);
  assert.equal(itemAt(later, backup).deletable, true, itemAt(later, backup).reason);
  assert.match(itemAt(later, backup).reason, /^可以删除：内容已完整在当前库里（其中 2 个对话、4 个消息版本都在/);

  const journal = path.join(controlRoot(fixture.current), 'epoch-to-5-migration.json');
  await fs.writeFile(journal, '{}');
  const journaled = await planRuntimeBackupCleanup(fixture.root, database, eightDays);
  assert.equal(itemAt(journaled, backup).reason, '有进行中的操作（未完成的升级），完成之后再清理');
  const result = await deleteRuntimeBackups(later, database, [itemAt(later, backup).key], eightDays);
  assert.deepEqual(result.kept.map((item) => item.reason), ['有进行中的操作（未完成的升级），完成之后再清理；这一项没有删除'],
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
  assert.equal(item.reason, '可以删除：内容已完整在历史库“shared”里（其中 2 个对话、4 个消息版本都在，显示的消息相同，正文文件也都在）');
  assert.equal(item.dataSetName, '历史库“shared”', '与“历史与存储管理”同样用项目名称呼它');

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
    [false, 0, 1, '含 1 个历史库“shared”没有的消息版本，按历史保留']);

  rawEdit(fixture.alpha, (source) => source.prepare('DELETE FROM conversation WHERE id = ?').run('conversation_alpha_one'));
  const conversation = itemAt(await planRuntimeBackupCleanup(fixture.root, database), sourceBackup);
  assert.deepEqual([conversation.deletable, conversation.missingConversations],
    [false, 1]);
  assert.equal(conversation.reason, '含 1 个历史库“shared”没有的对话（可能是你删掉的），按历史保留');
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
  assert.deepEqual(result.kept.map((item) => item.reason), ['所在历史库在检查之后有改动，请重新检查；这一项没有删除']);
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
  // Same data set and root instance ids, but recorded at another place (paths are compared too).
  const elsewhere = await targetBackup(fixture.current, database, 200);
  const recorded = JSON.parse(await fs.readFile(path.join(elsewhere, 'root-binding.json'), 'utf8'));
  await fs.writeFile(path.join(elsewhere, 'root-binding.json'), JSON.stringify({
    ...recorded, paths: { ...recorded.paths, casRootPath: path.join(path.dirname(recorded.paths.casRootPath), 'elsewhere-cas') }
  }));
  await backdate(elsewhere, 200);
  await targetBackup(fixture.current, database, 120);

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual([itemAt(plan, foreign).deletable, itemAt(plan, foreign).reason], [false, '不是所在历史库的备份（身份不一致），按历史保留']);
  assert.deepEqual([itemAt(plan, ahead).deletable, itemAt(plan, ahead).reason], [false, '所在历史库比这份备份更旧（代数更低），按历史保留']);
  assert.deepEqual([itemAt(plan, elsewhere).deletable, itemAt(plan, elsewhere).reason], [false, '不是所在历史库的备份（身份不一致），按历史保留']);
});

test('删除中崩溃（子进程 SIGKILL）：改名后、再次核对前崩溃的改回原名重新核对；核对并标记之后崩溃的由下次清理删完', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const database = await openCurrent(t, fixture);
  const doomed = await targetBackup(fixture.current, database, 180);
  const kept = await targetBackup(fixture.current, database, 120);
  const parent = path.dirname(doomed);
  const key = itemAt(await planRuntimeBackupCleanup(fixture.root, database), doomed).key;

  const early = await runChild(['delete-then-crash', fixture.root, key, 'after-rename']);
  assert.equal(early.signal, 'SIGKILL', early.stderr);
  let names = await fs.readdir(parent);
  const unverified = names.find((name) => name.startsWith(`${path.basename(doomed)}.deleting-`));
  assert.ok(unverified, names.join(','));
  assert.match(unverified, /\.deleting-[0-9a-f]{16}$/);
  assert.equal(names.includes(path.basename(doomed)), false, '改名已经持久');
  assert.deepEqual(await fs.readdir(path.join(parent, unverified)).then((entries) => entries.includes('.limcode-backup-cleanup-verified')), false);
  // A mark left from an earlier attempt names another directory: it never counts, and goes with the restore.
  await fs.writeFile(path.join(parent, unverified, '.limcode-backup-cleanup-verified'), JSON.stringify({
    kind: 'limcode-backup-cleanup-verified', name: `${path.basename(doomed)}.deleting-0123456789abcdef`
  }));

  const restored = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual([restored.finishedDeletions, restored.restoredDeletions], [[], [doomed]], '没有核对完的不删，改回原名');
  assert.deepEqual((await fs.readdir(parent)).sort(), [path.basename(doomed), path.basename(kept)].sort());
  assert.equal((await fs.readdir(doomed)).includes('.limcode-backup-cleanup-verified'), false, '改回原名时去掉不属于它的标记');
  assert.equal(restored.items.some((item) => item.path.includes('.deleting-')), false);
  // Taking the stale mark out touched the directory (young for an hour); as an older backup it is listed as checked.
  await backdate(doomed, 180);
  assert.equal(itemAt(await planRuntimeBackupCleanup(fixture.root, database), doomed).deletable, true, '改回原名后按这次的核对结果列出');

  const late = await runChild(['delete-then-crash', fixture.root, key, 'after-verify']);
  assert.equal(late.signal, 'SIGKILL', late.stderr);
  names = await fs.readdir(parent);
  const verified = names.find((name) => name.startsWith(`${path.basename(doomed)}.deleting-`));
  assert.ok(verified, names.join(','));
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual([plan.finishedDeletions, plan.restoredDeletions], [[path.join(parent, verified)], []]);
  assert.deepEqual(await fs.readdir(parent), [path.basename(kept)]);
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

test('只列出的备份：归档目录里不认识的条目、没有库的拷来目录、旧格式 backups/ 与 .limcode-data-backups 写明名称、位置、大小和原因，不能删除；认不出的归档是未通过核验的外来历史库', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const database = await openCurrent(t, fixture);
  const archive = path.join(fixture.root, '.limcode-runtime-backups', '20260901-010203-004-abcdef12');
  const unknown = path.join(fixture.root, '.limcode-runtime-backups', 'notes');
  const copied = `${fixture.root}.limcode-copied-2026-09-02T01-02-03-004Z-12345678`;
  t.after(() => fs.rm(copied, { recursive: true, force: true }));
  const legacy = path.join(controlRoot(fixture.alpha), 'backups');
  const dataBackups = path.join(fixture.root, '.limcode-data-backups');
  for (const [directory, bytes] of [[archive, 11], [unknown, 5], [copied, 22], [legacy, 33], [dataBackups, 44]]) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'data.bin'), Buffer.alloc(bytes, 1));
  }
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  for (const directory of [archive, unknown, copied, legacy, dataBackups]) {
    assert.equal(plan.items.filter((item) => item.path === directory).length, 1, `${directory} 只列出一次`);
  }
  const listed = [archive, unknown, copied, legacy, dataBackups].map((directory) => itemAt(plan, directory));
  assert.deepEqual(listed.map((item) => [item.kind, item.deletable, item.bytes, item.name]), [
    ['foreign-history', false, '11', path.basename(archive)],
    ['reset-archive', false, '5', 'notes'],
    ['copied-data-root', false, '22', path.basename(copied)],
    ['legacy-cutover', false, '33', 'backups'],
    ['data-backups', false, '44', '.limcode-data-backups']
  ]);
  assert.deepEqual(listed.map((item) => item.inCurrentDataSet), [false, false, false, false, false], '只列出的都不是当前库的一部分（归档就在当前库的目录下也一样）');
  assert.match(listed[0].reason, /^未通过核验：历史库不完整.*，原样保留$/);
  assert.equal(listed[0].origin, '“归档并重置”的归档');
  assert.equal(listed[1].reason, '归档目录里不是“归档并重置”留下的归档（名字不认识）；只列出，不删除');
  assert.equal(listed[2].reason, '拷来目录里已经没有库；其余内容（设置、规则、技能）保留，可自行处理');
  assert.equal(listed[0].createdAt, '2026-09-01T01:02:03.004Z');
  assert.equal(listed[2].createdAt, '2026-09-02T01:02:03.004Z');
  const result = await deleteRuntimeBackups(plan, database, listed.map((item) => item.key));
  assert.deepEqual(result.kept.map((item) => item.reason), Array(5).fill('不在可以删除的清单里'));
  for (const directory of [archive, unknown, copied, legacy, dataBackups]) assert.ok((await fs.lstat(directory)).isDirectory());
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

test('备份库是打开中的当前库或另一个本地历史库的硬链接：检查不复制它，本进程对当前库的 POSIX 锁不丢，写明原因并保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  await seed(fixture.alpha, ['conversation_alpha']);
  const database = await openCurrent(t, fixture);
  const databasePath = database.binding.paths.databasePath;
  await database.snapshot([{ kind: 'get', domain: 'Conversation', id: 'conversation_one' }]);
  const heldBefore = probeSharedLock(databasePath);
  if (heldBefore !== undefined) assert.equal(heldBefore, 'held', '打开的当前库持有数据库文件的 SHARED 锁');

  // Restored with `ln`/`cp -al`, or linked by a dedup tool: the same inode as a live database.
  const linkedCurrent = await linkedBackup(fixture, database.binding, databasePath, 300);
  const linkedAlpha = await linkedBackup(fixture, database.binding, fixture.alpha.binding.paths.databasePath, 280);
  await targetBackup(fixture.current, database, 120);

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual([itemAt(plan, linkedCurrent).deletable, itemAt(plan, linkedCurrent).reason],
    [false, '它和当前库是同一个文件（硬链接）；为了不破坏当前库的锁，不读取它，按历史保留']);
  assert.deepEqual([itemAt(plan, linkedAlpha).deletable, itemAt(plan, linkedAlpha).reason],
    [false, '它和另一个历史库是同一个文件（硬链接）；为了不破坏那个库的锁，不读取它，按历史保留']);
  if (heldBefore !== undefined) assert.equal(probeSharedLock(databasePath), 'held', '检查备份不能释放本进程对当前库的 POSIX 锁');
  const result = await deleteRuntimeBackups(plan, database, [itemAt(plan, linkedCurrent).key, itemAt(plan, linkedAlpha).key]);
  assert.deepEqual(result.kept.map((item) => item.reason), ['不在可以删除的清单里', '不在可以删除的清单里']);
  assert.equal((await fs.stat(databasePath)).nlink, 2);
  assert.equal((await database.snapshot([{ kind: 'get', domain: 'Conversation', id: 'conversation_one' }])).snapshot[0]?.id, 'conversation_one');
});

test('另一个本地历史库的库文件是当前库的硬链接：不复制那个库，它那里的备份写明原因并保留，当前库的锁不丢', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  await seed(fixture.alpha, ['conversation_alpha']);
  const backup = await sourceBackup(fixture.alpha);
  const database = await openCurrent(t, fixture);
  const databasePath = database.binding.paths.databasePath;
  const alphaPath = fixture.alpha.binding.paths.databasePath;
  for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${alphaPath}${suffix}`, { force: true });
  await fs.link(databasePath, alphaPath);
  await database.snapshot([{ kind: 'get', domain: 'Conversation', id: 'conversation_one' }]);
  const heldBefore = probeSharedLock(databasePath);
  if (heldBefore !== undefined) assert.equal(heldBefore, 'held');

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual([itemAt(plan, backup).deletable, itemAt(plan, backup).reason],
    [false, '所在历史库和当前库是同一个文件（硬链接）；为了不破坏当前库的锁，不读取它，按历史保留']);
  if (heldBefore !== undefined) assert.equal(probeSharedLock(databasePath), 'held', '不复制与当前库同一个文件的历史库');
});

test('与真实合并并发：另一个窗口的合并刚写好、之后因推迟又删掉的备份不算最新一份，原来最新的一份保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_current']);
  await seed(fixture.alpha, ['conversation_alpha']);
  const database = await openCurrent(t, fixture);
  const previousNewest = await targetBackup(fixture.current, database, 180);
  const backups = path.dirname(previousNewest);

  // The cleanup runs in another async context (as in another window), free of the merge's claims.
  let startCleanup;
  const cleanupStarted = new Promise((resolve) => { startCleanup = resolve; });
  const cleanupDone = cleanupStarted.then(async () => {
    const plan = await planRuntimeBackupCleanup(fixture.root, database);
    const result = await deleteRuntimeBackups(plan, database, plan.items.filter((item) => item.deletable).map((item) => item.key));
    return { plan, result };
  });
  const report = await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database }, {
    async onFaultPoint(point) {
      if (point !== 'after-target-backup') return;
      startCleanup();
      await cleanupDone;
      // As when the source is deferred after its target backup exists (changed before the commit,
      // oversized coordination abandoned, …): the batch removes its unused backup again.
      throw new Error('模拟：来源在提交前推迟');
    }
  });
  const { plan, result } = await cleanupDone;
  assert.equal(report.deferred.length, 1, '这次合并推迟、没有用上它的备份');
  const young = plan.items.filter((item) => item.kind === 'merge-target' && item.path !== previousNewest);
  assert.deepEqual(young.map((item) => item.reason), ['创建不满 1 小时，可能正被合并使用，保留']);
  assert.equal(itemAt(plan, previousNewest).reason, '这是这个库最新的一份满 1 小时的完整合并前备份，保留');
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(await fs.readdir(backups), [path.basename(previousNewest)], '两边结束后仍有一份完整的合并前备份');
});

test('改名之后的失败：再次核对或写标记失败时改回原名并报保留；同步父目录失败不改变结论；标记之后删除失败报“没有删完”，下次清理删完', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_kept', 'conversation_later_deleted']);
  const database = await openCurrent(t, fixture);
  const first = await targetBackup(fixture.current, database, 300);
  const second = await targetBackup(fixture.current, database, 240);
  const third = await targetBackup(fixture.current, database, 200);
  await targetBackup(fixture.current, database, 120);
  const parent = path.dirname(first);
  const original = durableDirectorySync.syncDirectoryDurably;
  t.after(() => { durableDirectorySync.syncDirectoryDurably = original; });
  const failing = (matches) => async (directory, ...rest) => {
    if (matches(directory)) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' });
    return original(directory, ...rest);
  };

  // The verified mark cannot be made durable (the renamed directory's fsync fails): name back, kept.
  let plan = await planRuntimeBackupCleanup(fixture.root, database);
  durableDirectorySync.syncDirectoryDurably = failing((directory) => path.basename(directory).startsWith(`${path.basename(first)}.deleting-`));
  let result = await deleteRuntimeBackups(plan, database, [itemAt(plan, first).key]);
  durableDirectorySync.syncDirectoryDurably = original;
  assert.deepEqual([result.deleted, result.unfinished], [[], []]);
  assert.deepEqual(result.kept.map((item) => [item.path, item.reason, item.detail]),
    [[first, '改名之后没能再次核对，已改回原名，保留', 'EIO: i/o error, fsync']]);
  assert.equal((await fs.readdir(parent)).some((name) => name.includes('.deleting-')), false);
  assert.equal((await fs.readdir(first)).includes('.limcode-backup-cleanup-verified'), false, '改回原名的备份里没有已核对标记');

  // The parent's fsync right after the rename fails: the check and the durable mark still decide.
  plan = await planRuntimeBackupCleanup(fixture.root, database);
  let failures = 0;
  durableDirectorySync.syncDirectoryDurably = failing((directory) => directory === parent && ++failures === 1);
  result = await deleteRuntimeBackups(plan, database, [itemAt(plan, third).key]);
  durableDirectorySync.syncDirectoryDurably = original;
  assert.ok(failures >= 1);
  assert.deepEqual([result.deleted.map((item) => item.path), result.kept, result.unfinished], [[third], [], []]);

  // The removal fails after the mark: not removed completely (never "kept"); the next cleanup finishes it.
  if (process.getuid?.() !== 0) {
    // Wherever the copy is by then, it is writable again before the fixture goes.
    const unlock = async () => {
      for (const name of await fs.readdir(parent)) {
        if (name.startsWith(path.basename(second))) await fs.chmod(path.join(parent, name), 0o700).catch(() => undefined);
      }
    };
    try {
      plan = await planRuntimeBackupCleanup(fixture.root, database);
      assert.equal(itemAt(plan, second).deletable, true, itemAt(plan, second).reason);
      result = await deleteRuntimeBackups(plan, database, [itemAt(plan, second).key], {
        async onFaultPoint(point) {
          // Marked durably; then nothing in it can be removed any more (its permissions changed meanwhile).
          if (point !== 'after-verify') return;
          const renamed = (await fs.readdir(parent)).find((name) => name.startsWith(`${path.basename(second)}.deleting-`));
          await fs.chmod(path.join(parent, renamed), 0o500);
        }
      });
      assert.deepEqual([result.deleted, result.kept], [[], []]);
      assert.equal(result.unfinished.length, 1);
      assert.match(result.unfinished[0].reason, /^已核对并改名为 .+\.deleting-[0-9a-f]{16}，但没有删完；下次清理备份时会删完$/);
      assert.match(result.unfinished[0].detail, /EACCES|EPERM/);
      const leftover = (await fs.readdir(parent)).find((name) => name.startsWith(`${path.basename(second)}.deleting-`));
      assert.ok(leftover);
      assert.ok((await fs.readdir(path.join(parent, leftover))).includes('.limcode-backup-cleanup-verified'), '标记最后才删');
      await unlock();
      const next = await planRuntimeBackupCleanup(fixture.root, database);
      assert.deepEqual(next.finishedDeletions, [path.join(parent, leftover)]);
    } finally {
      await unlock();
    }
  }

  // The copy reported kept stays kept: a conversation deleted afterwards makes it history, never deleted silently.
  await database.transaction([repo('Conversation').delete('conversation_later_deleted')]);
  await backdate(first, 300); // Its mark came and went: the directory itself changed a moment ago.
  const later = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual(later.finishedDeletions, []);
  assert.deepEqual([itemAt(later, first).deletable, itemAt(later, first).reason], [false, '含 1 个当前库没有的对话（可能是你删掉的），按历史保留']);
});

test('改名之后再核一次覆盖：改名与删除之间当前库删掉了备份里的对话（删除对话不取锁）、其它历史库有了改动，改回原名并保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_kept', 'conversation_deleted']);
  await seed(fixture.alpha, ['conversation_alpha']);
  const database = await openCurrent(t, fixture);
  const backup = await targetBackup(fixture.current, database, 180);
  await targetBackup(fixture.current, database, 120);
  const source = await sourceBackup(fixture.alpha);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(plan, backup).deletable, true, itemAt(plan, backup).reason);
  assert.equal(itemAt(plan, source).deletable, true, itemAt(plan, source).reason);

  const result = await deleteRuntimeBackups(plan, database, [itemAt(plan, backup).key, itemAt(plan, source).key], {
    async onFaultPoint(point, key) {
      if (point !== 'after-rename') return;
      if (key === itemAt(plan, backup).key) await database.transaction([repo('Conversation').delete('conversation_deleted')]);
      else rawEdit(fixture.alpha, (alpha) => alpha.prepare('UPDATE conversation SET title = ? WHERE id = ?').run('改过的标题', 'conversation_alpha'));
    }
  });
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.kept.map((item) => [item.path, item.reason]).sort(), [
    [backup, '当前库刚刚少了 1 个这份备份里有的对话，已改回原名，保留'],
    [source, '所在历史库在检查之后有改动，已改回原名，保留']
  ].sort());
  for (const directory of [backup, source]) {
    assert.ok((await fs.lstat(directory)).isDirectory());
    assert.equal((await fs.readdir(path.dirname(directory))).some((name) => name.includes('.deleting-')), false);
  }
  const next = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(next, backup).reason, '含 1 个当前库没有的对话（可能是你删掉的），按历史保留');
});

test('0.0.15–0.0.21 的 3→4 升级备份（完成记录 toEpoch 4、nextBinding 为 epoch 4）满 7 天、内容全在当前库也一律保留；完成记录与身份不符的也保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const database = await openCurrent(t, fixture);
  const binding = database.binding;
  const previousBinding = { ...binding, runtimeKernelEpoch: 3 };
  const directory = path.join(controlRoot(fixture.current), 'epoch-migration-backups', '20260101T000000Z-abcdef12');
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'limcode.epoch-3.sqlite');
  await database.backupTo(file);
  for (const suffix of ['-wal', '-shm']) await fs.rm(`${file}${suffix}`, { force: true });
  rawEditFile(file, (old) => old.prepare('UPDATE root_binding SET runtime_kernel_epoch = 3 WHERE singleton = 1').run());
  await fs.writeFile(path.join(directory, 'root-binding.epoch-3.json'), JSON.stringify(previousBinding, null, 2));
  const record = {
    kind: 'limcode-runtime-epoch-migration-completion', attemptId: randomUUID(), fromEpoch: 3, toEpoch: 4,
    previousBinding, nextBinding: { ...binding, runtimeKernelEpoch: 4 }, databaseBackupSha256: '0'.repeat(64),
    completedAt: new Date(Date.now() - 30 * DAY).toISOString()
  };
  const writeRecord = (value) => fs.writeFile(path.join(directory, 'epoch-migration-completion.json'), JSON.stringify(value, null, 2));
  const later = { now: () => Date.now() + 30 * DAY };
  await writeRecord(record);
  const plan = await planRuntimeBackupCleanup(fixture.root, database, later);
  assert.deepEqual([itemAt(plan, directory).deletable, itemAt(plan, directory).reason], [false, '旧版本 3→4 升级留下的备份，一律保留']);
  const result = await deleteRuntimeBackups(plan, database, [itemAt(plan, directory).key], later);
  assert.deepEqual(result.kept.map((item) => item.reason), ['不在可以删除的清单里']);
  assert.ok((await fs.lstat(file)).isFile());

  // A record claiming 3→5 whose next binding is still epoch 4, and a record of an unknown upgrade.
  await writeRecord({ ...record, toEpoch: 5 });
  assert.equal(itemAt(await planRuntimeBackupCleanup(fixture.root, database, later), directory).reason, '升级完成记录与备份里的身份记录不一致，按历史保留');
  await writeRecord({ ...record, toEpoch: 6 });
  assert.equal(itemAt(await planRuntimeBackupCleanup(fixture.root, database, later), directory).reason, '升级完成记录无法识别，按历史保留');
});

test('升级前备份的 7 天按最晚的时间算：完成记录里的时间、目录名的时间、完成记录文件的修改时间取最晚的；晚于现在按时间不可信保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  await downgradeToEpoch4(fixture.current.binding);
  const upgraded = await migratePreviousRuntimeEpochIfRequired(fixture.current.authority);
  fixture.current.binding = upgraded.binding;
  const database = await openCurrent(t, fixture);
  const parent = path.dirname(upgraded.backupPath);
  const suffix = path.basename(upgraded.backupPath).split('-').at(-1);
  const recordName = 'epoch-migration-completion.json';
  const record = JSON.parse(await fs.readFile(path.join(upgraded.backupPath, recordName), 'utf8'));
  const slug = (time) => new Date(time).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  let directory = upgraded.backupPath;
  // Renames the backup after `nameTime` and rewrites its completion record (the file's times become now).
  const arrange = async (nameTime, completedAt) => {
    const next = path.join(parent, `${slug(nameTime)}-${suffix}`);
    if (next !== directory) await fs.rename(directory, next);
    directory = next;
    await fs.writeFile(path.join(directory, recordName), JSON.stringify({ ...record, completedAt: new Date(completedAt).toISOString() }, null, 2));
  };
  const now = Date.now();
  // The clock of a check, `ahead` of the real one.
  const reason = async (ahead) => itemAt(await planRuntimeBackupCleanup(fixture.root, database, { now: () => Date.now() + ahead }), directory).reason;
  const waiting = /^升级完成不满 7 天，.+ 之后才可以删除$/;

  // Only the record file is recent (the clock was behind during the upgrade).
  await arrange(now - 30 * DAY, now - 30 * DAY);
  assert.match(await reason(0), waiting);
  assert.match(await reason(8 * DAY), /^可以删除：/);
  // Only the directory name is recent.
  await arrange(now + 5 * DAY, now - 30 * DAY);
  assert.match(await reason(8 * DAY), waiting);
  // Only the completion time is recent.
  await arrange(now - 30 * DAY, now + 5 * DAY);
  assert.match(await reason(8 * DAY), waiting);
  assert.match(await reason(13 * DAY), /^可以删除：/);
  // Later than now: the clock (then or now) cannot be trusted.
  await arrange(now - 30 * DAY, now + DAY);
  assert.equal(await reason(0), '升级完成的时间晚于现在，时间不可信，按历史保留');
});

test('控制根里有其它进行中的操作（挂起的切换指针、旧版本的 3→4 升级日志、旧格式切换的请求或日志）时保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const database = await openCurrent(t, fixture);
  const backup = await targetBackup(fixture.current, database, 180);
  await targetBackup(fixture.current, database, 120);
  const control = controlRoot(fixture.current);
  for (const [file, operation] of [
    ['root-binding.pending.json', '未完成的历史库切换'],
    ['epoch-3-to-4-migration.json', '旧版本未完成的 3→4 升级'],
    ['cutover-request.json', '未完成的旧格式数据切换'],
    ['cutover-journal.json', '未完成的旧格式数据切换']
  ]) {
    await fs.writeFile(path.join(control, file), '{}');
    const plan = await planRuntimeBackupCleanup(fixture.root, database);
    assert.deepEqual([itemAt(plan, backup).deletable, itemAt(plan, backup).reason], [false, `有进行中的操作（${operation}），完成之后再清理`], file);
    await fs.rm(path.join(control, file));
  }
  assert.equal(itemAt(await planRuntimeBackupCleanup(fixture.root, database), backup).deletable, true);
});

test('删除期间在所持的 admission 与控制根 maintenance 里发布“清理备份”的维护进行中标记，等下一个控制根的锁时 admission 里仍有，结束后随锁消失', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  await seed(fixture.alpha, ['conversation_alpha']);
  const database = await openCurrent(t, fixture);
  const backup = await targetBackup(fixture.current, database, 180);
  await targetBackup(fixture.current, database, 120);
  const source = await sourceBackup(fixture.alpha);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  const admission = runtimeDataRootAdmissionClaimPath(fixture.root);
  const maintenance = runtimeMaintenanceClaimPath(fixture.current.binding.paths);
  const readActivity = async (claim) => {
    const owner = JSON.parse(await fs.readFile(path.join(claim, 'owner.json'), 'utf8'));
    const activity = JSON.parse(await fs.readFile(path.join(claim, 'activity.json'), 'utf8'));
    return { operation: activity.operation, description: activity.description, stage: activity.stage, sameClaim: activity.claimToken === owner.claimToken };
  };
  const seen = [];
  // Another window holds the alpha control root's maintenance: the deletion waits for it holding the admission.
  let release;
  let held;
  const holding = new Promise((resolve) => { held = resolve; });
  const holder = withRuntimeMaintenance(fixture.alpha.binding.paths, () => new Promise((resolve) => { release = resolve; held(); }));
  await holding;
  const deletion = deleteRuntimeBackups(plan, database, [itemAt(plan, backup).key, itemAt(plan, source).key], {
    async onFaultPoint(point, key) {
      if (point === 'before-rename' && key === itemAt(plan, backup).key) seen.push(await readActivity(admission), await readActivity(maintenance));
    }
  });
  let waiting;
  for (let attempt = 0; attempt < 100 && waiting?.stage !== '已处理 1/2 份备份'; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    waiting = await readActivity(admission).catch(() => undefined);
  }
  release();
  await holder;
  const result = await deletion;
  assert.deepEqual(result.deleted.map((item) => item.path), [backup, source]);
  assert.deepEqual(seen, [admission, maintenance].map(() => ({ operation: 'backup-cleanup', description: '清理备份', stage: '正在删除第 1/2 份备份', sameClaim: true })));
  assert.deepEqual(waiting, { operation: 'backup-cleanup', description: '清理备份', stage: '已处理 1/2 份备份', sameClaim: true });
  for (const claim of [admission, maintenance]) await assert.rejects(fs.access(path.join(claim, 'activity.json')));
});

test('两个其它历史库的库文件是同一个文件（硬链接）：两个都不复制，那里的备份写明原因并保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  await seed(fixture.alpha, ['conversation_alpha']);
  const beta = await addWorkspaceDataSet(fixture, 'file:///workspace/beta');
  const backup = await sourceBackup(fixture.alpha);
  const database = await openCurrent(t, fixture);
  const betaPath = beta.binding.paths.databasePath;
  for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${betaPath}${suffix}`, { force: true });
  await fs.link(fixture.alpha.binding.paths.databasePath, betaPath);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual([itemAt(plan, backup).deletable, itemAt(plan, backup).reason],
    [false, '所在历史库和另一个历史库是同一个文件（硬链接），两个都不读取，按历史保留']);
});

test('副本的 id 直接从表里读、不经主键索引：索引里少了一个对话的副本照样看出它有当前库没有的对话', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const database = await openCurrent(t, fixture);
  const backup = await targetBackup(fixture.current, database, 180);
  await targetBackup(fixture.current, database, 120);
  hideFromPrimaryKeyIndex(path.join(backup, 'limcode.sqlite'), 'conversation', 'conversation_one', 'conversation_hidden');
  await backdate(backup, 180);
  const item = itemAt(await planRuntimeBackupCleanup(fixture.root, database), backup);
  assert.deepEqual([item.deletable, item.missingConversations, item.reason], [false, 1, '含 1 个当前库没有的对话（可能是你删掉的），按历史保留']);
});

test('读不了的副本：原因用中文写明是损坏还是与身份记录不符，按历史保留，不写“暂时”；技术原因只放在 detail', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const database = await openCurrent(t, fixture);
  const damaged = await targetBackup(fixture.current, database, 300);
  const mismatched = await targetBackup(fixture.current, database, 240);
  await targetBackup(fixture.current, database, 120);
  await fs.writeFile(path.join(damaged, 'limcode.sqlite'), Buffer.alloc(8192, 7));
  await backdate(damaged, 300);
  rawEditFile(path.join(mismatched, 'limcode.sqlite'), (copy) => copy.prepare('UPDATE root_binding SET root_instance_id = ?').run(randomUUID()));
  await backdate(mismatched, 240);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual([itemAt(plan, damaged).deletable, itemAt(plan, damaged).reason], [false, '这份备份的数据库已损坏，无法核对，按历史保留']);
  assert.match(itemAt(plan, damaged).detail, /not a database|malformed/i);
  assert.deepEqual([itemAt(plan, mismatched).deletable, itemAt(plan, mismatched).reason], [false, '这份备份里的数据库与它的身份记录不一致，按历史保留']);
  assert.match(itemAt(plan, mismatched).detail, /RootBinding/);
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

/** Another workspace data set (initialized, not selected) beside alpha. */
async function addWorkspaceDataSet(fixture, folder) {
  const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: [folder] });
  const scopeRoot = resolveVscodeWorkspaceRuntimeScopeRoot(fixture.paths, scope);
  await fs.mkdir(scopeRoot, { recursive: true });
  return initialize(scopeRoot, `workspace:${scope.key}`);
}

/**
 * A copy whose primary key index misses one row of `table` (only integrity_check would tell): the
 * row is inserted while the table is declared without its primary key, then the declaration and the
 * old index come back.
 */
function hideFromPrimaryKeyIndex(file, table, templateId, hiddenId) {
  const edit = (write) => {
    const database = new Database(file);
    try {
      database.unsafeMode(true);
      write(database);
      database.pragma('wal_checkpoint(TRUNCATE)');
    } finally { database.close(); }
  };
  let saved;
  edit((database) => {
    saved = {
      table: database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").pluck().get(table),
      index: database.prepare("SELECT * FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND name LIKE 'sqlite_autoindex_%'").get(table)
    };
    assert.ok(saved.table.includes('"id" TEXT PRIMARY KEY') && saved.index, saved.table);
    database.pragma('writable_schema = ON');
    database.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = ?").run(saved.table.replace('"id" TEXT PRIMARY KEY', '"id" TEXT'), table);
    database.prepare('DELETE FROM sqlite_master WHERE name = ?').run(saved.index.name);
  });
  edit((database) => {
    // The other tables' references to it are not valid while it has no primary key.
    database.pragma('foreign_keys = OFF');
    const columns = database.prepare(`PRAGMA table_info("${table}")`).all().map((column) => `"${column.name}"`);
    database.prepare(`INSERT INTO "${table}" (${columns.join(', ')}) SELECT ${columns.map((column) => column === '"id"' ? '?' : column).join(', ')} FROM "${table}" WHERE id = ?`)
      .run(hiddenId, templateId);
  });
  edit((database) => {
    database.pragma('writable_schema = ON');
    database.prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = ?").run(saved.table, table);
    database.prepare('INSERT INTO sqlite_master (type, name, tbl_name, rootpage, sql) VALUES (?, ?, ?, ?, ?)')
      .run(saved.index.type, saved.index.name, saved.index.tbl_name, saved.index.rootpage, saved.index.sql);
  });
  const check = new Database(file, { readonly: true });
  try {
    assert.notEqual(check.pragma('quick_check', { simple: true }), 'ok', '索引确实缺了这一行');
    assert.deepEqual(check.prepare(`SELECT id FROM "${table}" WHERE id = ?`).pluck().all(hiddenId), [], '经索引查不到');
  } finally { check.close(); }
}

/** A pre-merge backup of the current data set whose database file is a hard link of `databasePath`. */
async function linkedBackup(fixture, binding, databasePath, minutesAgo) {
  const directory = path.join(controlRoot(fixture.current), 'merge-backups', backupName(minutesAgo));
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'root-binding.json'), `${JSON.stringify(binding, null, 2)}\n`);
  await fs.link(databasePath, path.join(directory, 'limcode.sqlite'));
  await backdate(directory, minutesAgo);
  return directory;
}

/**
 * Another process asks for a write lock on SQLite's SHARED range of a database file: 'held' while
 * this process holds its read lock there; undefined without python3 (the probe is then skipped).
 */
function probeSharedLock(databasePath) {
  try {
    return execFileSync('python3', ['-c', `
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
try:
    fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB, 510, 0x40000002, 0)
    print('free')
    fcntl.lockf(fd, fcntl.LOCK_UN, 510, 0x40000002, 0)
except OSError:
    print('held')
finally:
    os.close(fd)
`, databasePath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
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
    // A child that hangs is ended with SIGTERM, never mistaken for the SIGKILL of its crash point.
    execFile(process.execPath, [script, ...args], { env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled }, timeout: 60_000, killSignal: 'SIGTERM' },
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
