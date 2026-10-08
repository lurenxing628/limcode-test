import { publishInitialRuntimeSelection } from './fixtures/runtime-selection.mjs';
// 清理备份（runtimeBackupCleanup）C 项第二部分的审查修复：H1 显示一致（拷贝里显示的消息在证明它的库里被删除、
// 编辑或重试替换时单列、默认不勾选，删除时替换的不能比列出时多）、L5 其它历史记录与正文文件、M1 已核对标记落盘后
// 放开 admission、L1 只读查看的登记、L2 备份目录逐项核对、L3 已核对标记绑定配置根、L4 历史库的名字、L6 外来库里的
// 临时文件、声明目录与诊断目录、L7 改名前最后一步与改名之后的目录比较、L9 读孪生库的摘要与读它的 id 之间的变化。
// Runs against the compiled extension.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
const { deleteRuntimeBackups, planRuntimeBackupCleanup } = kernelFile('runtimeBackupCleanup.js');
const foreign = kernelFile('runtimeForeignHistory.js');
const { openRuntimeDataSetHistory } = kernelFile('runtimeDataSetHistory.js');
const {
  resolveVscodeRuntimeDataRoot, resolveVscodeWorkspaceRuntimeScope, resolveVscodeWorkspaceRuntimeScopeRoot, selectVscodeRuntimeDataSet
} = kernelFile('vscodeRootAuthority.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = '2026-09-26T00:00:00.000Z';
const LATER = '2026-09-27T00:00:00.000Z';
const MINUTE = 60_000;
const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
const PROJECT = { uri: 'file:///workspace/shared', name: 'shared' };
const BUSY = '正在被另一个窗口或操作使用（只读查看、核验、合并或清理备份）';
const COMPLETE = '显示的消息相同，正文文件也都在';
const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);

test('H1 当前库里被删除、编辑或重试替换的消息只在拷贝里还能看到：单列为可删、写明条数（replacedMessages），显示一致的拷贝才写“内容已完整”；删除时替换的消息不能比列出时多，改名之前和之后都复核', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one', 'conversation_two']);
  const before = await copyAsArchive(fixture.current, fixture.root, archiveName(1));
  let database = await openCurrent(t, fixture);
  // Deleting or retrying a message soft-deletes it; editing one makes a new revision current.
  await database.transaction(softDeleteSteps('conversation_one_message_1'));
  await editMessage(fixture.current, database, 'conversation_one_message_0');
  await database.close();
  const after = await copyAsArchive(fixture.current, fixture.root, archiveName(2));
  database = await openCurrent(t, fixture);

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  const replaced = itemAt(plan, before);
  assert.deepEqual([replaced.deletable, replaced.replacedMessages, replaced.conversations, replaced.revisions, replaced.reason],
    [true, 2, 2, 4, '其中 2 条消息在当前库里已被你删除、编辑或重试替换，删除这份后它们就再也看不到了']);
  const complete = itemAt(plan, after);
  assert.deepEqual([complete.deletable, complete.replacedMessages, complete.reason],
    [true, undefined, `可以删除：内容已完整在当前库里（其中 2 个对话、5 个消息版本都在，${COMPLETE}）`]);

  // One more message goes between the rename and the last check (deleting one takes no claim): name back.
  const late = await deleteRuntimeBackups(plan, database, [replaced.key], {
    async onFaultPoint(point) { if (point === 'after-rename') await database.transaction(softDeleteSteps('conversation_two_message_1')); }
  });
  assert.deepEqual(late.kept.map((entry) => entry.reason), ['当前库里刚刚又有 1 条它有的消息被删除、编辑或重试替换，已改回原名，保留']);
  assert.ok((await fs.lstat(before)).isDirectory());
  // Already replaced when the deletion begins: refused before any rename; the complete copy too.
  const points = [];
  const early = await deleteRuntimeBackups(plan, database, [replaced.key, complete.key], { onFaultPoint(point) { points.push(point); } });
  assert.deepEqual(points, []);
  assert.deepEqual(early.kept.map((entry) => entry.reason), [
    '列出之后当前库里又有 1 条它有的消息被删除、编辑或重试替换，请重新检查；这一项没有删除',
    '列出之后当前库里又有 1 条它有的消息被删除、编辑或重试替换，请重新检查；这一项没有删除'
  ]);
  // Checked again: ticked knowingly, both are deleted.
  const again = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual([itemAt(again, before).replacedMessages, itemAt(again, after).replacedMessages], [3, 1]);
  const done = await deleteRuntimeBackups(again, database, [itemAt(again, before).key, itemAt(again, after).key]);
  assert.deepEqual(done.deleted.map((entry) => entry.path).sort(), [before, after].sort(), JSON.stringify(done));
});

test('H1 其它历史库（读取线程给出的显示集合）与本地备份（C1）同样：那个库里删掉的消息让它的备份单列、写明它的名字；当前库的合并前备份在删除时复核，列出之后又删的消息挡住删除', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  await seed(fixture.alpha, ['conversation_alpha']);
  const alphaBackup = await sourceBackup(fixture.alpha);
  // A window of that project deleted a message afterwards: only the backup still shows it.
  await withDataSet(fixture.alpha, (runtime) => runtime.transaction(softDeleteSteps('conversation_alpha_message_1')));
  const database = await openCurrent(t, fixture);
  const older = await targetBackup(fixture.current, database, 180);
  await targetBackup(fixture.current, database, 120);
  await editMessage(fixture.current, database, 'conversation_one_message_0');

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  const ofAlpha = itemAt(plan, alphaBackup);
  assert.deepEqual([ofAlpha.deletable, ofAlpha.replacedMessages, ofAlpha.dataSetName, ofAlpha.reason],
    [true, 1, '历史库“shared”', '其中 1 条消息在历史库“shared”里已被你删除、编辑或重试替换，删除这份后它们就再也看不到了']);
  const ofCurrent = itemAt(plan, older);
  assert.deepEqual([ofCurrent.deletable, ofCurrent.replacedMessages, ofCurrent.dataSetName, ofCurrent.reason],
    [true, 1, '当前库', '其中 1 条消息在当前库里已被你删除、编辑或重试替换，删除这份后它们就再也看不到了']);

  await database.transaction(softDeleteSteps('conversation_one_message_1'));
  const refused = await deleteRuntimeBackups(plan, database, [ofCurrent.key, ofAlpha.key]);
  assert.deepEqual(refused.kept.map((entry) => entry.reason),
    ['列出之后当前库里又有 1 条这份备份里有的消息被删除、编辑或重试替换，请重新检查；这一项没有删除']);
  assert.deepEqual(refused.deleted.map((entry) => entry.path), [alphaBackup], '勾选的替换项照常删除');
  const again = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(again, older).replacedMessages, 2);
  const done = await deleteRuntimeBackups(again, database, [itemAt(again, older).key]);
  assert.deepEqual(done.deleted.map((entry) => entry.path), [older]);
});

test('H1 几个本地库都能覆盖时取显示一致的那个：当前库里删了消息、另一个历史库还显示它，就写“内容已完整在”那个历史库里', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_shared']);
  await seed(fixture.alpha, ['conversation_shared']);
  const archived = await copyAsArchive(fixture.current, fixture.root, archiveName(1));
  const database = await openCurrent(t, fixture);
  await database.transaction(softDeleteSteps('conversation_shared_message_1'));
  const item = itemAt(await planRuntimeBackupCleanup(fixture.root, database), archived);
  assert.deepEqual([item.deletable, item.replacedMessages, item.reason],
    [true, undefined, `可以删除：内容已完整在历史库“shared”里（其中 1 个对话、2 个消息版本都在，${COMPLETE}）`]);
});

test('L5 覆盖不只看对话和消息版本：拷贝里有当前库没有的工具调用、交互与回答、进程与输出时保留并写明；当前库都有之后可删；它引用的正文在当前库的正文库里缺失或大小不对时保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  // The same conversation with more history, in a data set of another installation.
  const other = await initialize(path.join(fixture.base, 'elsewhere'), 'elsewhere');
  await seed(other, ['conversation_one']);
  const records = await addRecords(other, 'conversation_one');
  const archived = await copyAsArchive(other, fixture.root, archiveName(1));
  let database = await openCurrent(t, fixture);

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  const item = itemAt(plan, archived);
  assert.deepEqual([item.deletable, item.missingConversations, item.missingRevisions, item.reason], [false, 0, 0,
    '含当前库没有的记录（工具调用 1 条、交给模型的工具结果 1 条、交互请求 1 条 等），也没有别的本地库完整包含它，按历史保留']);

  await database.close();
  await addRecords(fixture.current, 'conversation_one');
  database = await openCurrent(t, fixture);
  const covered = itemAt(await planRuntimeBackupCleanup(fixture.root, database), archived);
  assert.equal(covered.reason, `可以删除：内容已完整在当前库里（其中 1 个对话、2 个消息版本都在，${COMPLETE}）`);

  // The body of the process output is gone from the current data set's content store, then the wrong size.
  const [row] = (await database.snapshot([{ kind: 'get', domain: 'ContentObject', id: records.outputContentId }])).snapshot;
  const body = path.join(database.binding.paths.casRootPath, ...row.storage_key.split('/'));
  const saved = await fs.readFile(body);
  await fs.rm(body);
  const missing = itemAt(await planRuntimeBackupCleanup(fixture.root, database), archived);
  assert.deepEqual([missing.deletable, missing.reason],
    [false, '当前库里缺 1 个它引用的正文文件（可能已损坏或丢失），也没有别的本地库完整包含它，按历史保留']);
  await fs.writeFile(body, Buffer.concat([saved, Buffer.from('x')]));
  assert.equal(itemAt(await planRuntimeBackupCleanup(fixture.root, database), archived).deletable, false, '大小不对也不算');
  await fs.rm(body);
  await fs.writeFile(body, saved);
  const restored = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(restored, archived).deletable, true, itemAt(restored, archived).reason);
  const result = await deleteRuntimeBackups(restored, database, [itemAt(restored, archived).key]);
  assert.deepEqual(result.deleted.map((entry) => entry.path), [archived]);
});

test('L5 其它历史库（读取线程给出的记录与正文）同样：缺记录的写明那个库的名字；都有之后可删；它的正文库里缺正文时保留；身份相同的拷贝也要孪生库的正文都在', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_current']);
  await seed(fixture.alpha, ['conversation_one']);
  const other = await initialize(path.join(fixture.base, 'elsewhere'), 'elsewhere');
  await seed(other, ['conversation_one']);
  const records = await addRecords(other, 'conversation_one');
  const archived = await copyAsArchive(other, fixture.root, archiveName(1));
  const database = await openCurrent(t, fixture);

  const item = itemAt(await planRuntimeBackupCleanup(fixture.root, database), archived);
  assert.deepEqual([item.deletable, item.reason], [false,
    '含历史库“shared”没有的记录（工具调用 1 条、交给模型的工具结果 1 条、交互请求 1 条 等），也没有别的本地库完整包含它，按历史保留']);
  await addRecords(fixture.alpha, 'conversation_one');
  const covered = itemAt(await planRuntimeBackupCleanup(fixture.root, database), archived);
  assert.equal(covered.reason, `可以删除：内容已完整在历史库“shared”里（其中 1 个对话、2 个消息版本都在，${COMPLETE}）`);

  // The body of the process output is gone from alpha's content store.
  const alphaBody = path.join(fixture.alpha.binding.paths.casRootPath, ...await storageKey(fixture.alpha, records.outputContentId));
  const saved = await fs.readFile(alphaBody);
  await fs.rm(alphaBody);
  const missing = itemAt(await planRuntimeBackupCleanup(fixture.root, database), archived);
  assert.deepEqual([missing.deletable, missing.reason],
    [false, '历史库“shared”里缺 1 个它引用的正文文件（可能已损坏或丢失），也没有别的本地库完整包含它，按历史保留']);
  // An exact copy of alpha: identical, but its bodies are alpha's own, and one is missing.
  const twin = await copyAsArchive(fixture.alpha, fixture.alpha.scopeRoot, archiveName(2));
  const identical = itemAt(await planRuntimeBackupCleanup(fixture.root, database), twin);
  assert.deepEqual([identical.deletable, identical.reason],
    [false, '历史库“shared”里缺 1 个它引用的正文文件（可能已损坏或丢失），按历史保留']);
  await fs.writeFile(alphaBody, saved);
  const whole = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(whole, twin).reason, '可以删除：内容已完整在历史库“shared”里（与它身份相同、内容完全相同，正文文件也都在）');
});

test('L1 只读查看打开着的外来库：检查与删除都按“正在被使用”保留；关闭后可删；登记在当前配置根、外来目录里不写任何东西；进程已结束的登记不算并被清掉，读不懂的登记按还在用处理', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const archived = await copyAsArchive(fixture.current, fixture.root, archiveName(1));
  const database = await openCurrent(t, fixture);
  const found = (await foreign.discoverForeignRuntimeHistory({ configurationRootPath: fixture.root }))
    .find((entry) => entry.location.containerPath === archived);
  const { root } = await foreign.inspectForeignRuntimeRoot(fixture.root, found);
  const views = path.join(fixture.root, '.limcode-runtime-merges', 'foreign-views', found.id.replace(/:/g, '-'));
  const untouched = await treeState(archived);

  const view = await openRuntimeDataSetHistory(fixture.paths, root);
  let closed = false;
  t.after(() => closed ? undefined : view.close().catch(() => undefined));
  assert.equal((await fs.readdir(views)).filter((name) => name.endsWith('.json')).length, 1, '查看登记写在当前配置根');
  const busy = itemAt(await planRuntimeBackupCleanup(fixture.root, database), archived);
  assert.deepEqual([busy.deletable, busy.reason], [false, `${BUSY}，这次不能删除，稍后再检查`]);
  assert.ok((await view.readMessages('conversation_one')).items.some((entry) => entry.text.includes('第 1 条消息')), '查看照常读正文');
  await view.close();
  closed = true;
  assert.equal(await exists(views), false, '关闭时撤销登记');

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  const key = itemAt(plan, archived).key;
  assert.equal(itemAt(plan, archived).deletable, true, itemAt(plan, archived).reason);
  // Opened after the listing: the deletion keeps it.
  const late = await openRuntimeDataSetHistory(fixture.paths, root);
  let kept;
  try { kept = await deleteRuntimeBackups(plan, database, [key]); }
  finally { await late.close(); }
  assert.deepEqual(kept.kept.map((entry) => entry.reason), [`${BUSY}，这一项没有删除`]);
  assert.deepEqual(await treeState(archived), untouched, '查看、检查与没删成的删除都不写外来目录');

  // A record of a process that is gone does not count (and goes); one that cannot be read counts.
  await fs.mkdir(views, { recursive: true });
  const token = randomUUID();
  const stale = path.join(views, `${token}.json`);
  await fs.writeFile(stale, JSON.stringify({
    kind: 'limcode-foreign-history-view', foreignId: found.id, token, processId: await exitedProcessId(), openedAt: NOW
  }));
  const unreadable = path.join(views, `${randomUUID()}.json`);
  await fs.writeFile(unreadable, '{');
  assert.equal(itemAt(await planRuntimeBackupCleanup(fixture.root, database), archived).reason, `${BUSY}，这次不能删除，稍后再检查`);
  assert.equal(await exists(stale), false, '进程已结束的登记被清掉');
  await fs.rm(unreadable);
  const done = await deleteRuntimeBackups(plan, database, [key]);
  assert.deepEqual(done.deleted.map((entry) => entry.path), [archived], JSON.stringify(done));
});

test('M1 删除外来库：已核对标记落盘之前 admission 与外来声明都持有；落盘之后放开 admission，递归删除只在声明内进行（另一个进程能进 admission、拿不到声明）；这时崩溃由下次清理凭标记删完', { timeout: 120_000 }, async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const archived = await copyAsArchive(fixture.current, fixture.root, archiveName(1));
  const crashed = await copyAsArchive(fixture.current, fixture.root, archiveName(2));
  const database = await openCurrent(t, fixture);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  const item = itemAt(plan, archived);
  const id = item.key.slice('foreign-history:'.length);
  const pointer = path.join(archived, 'root-binding.json');
  const seen = {};
  const result = await deleteRuntimeBackups(plan, database, [item.key], {
    async onFaultPoint(point) {
      if (point === 'after-verify' || point === 'before-removal') seen[point] = await probe(fixture.root, id, pointer);
    }
  });
  assert.deepEqual(result.deleted.map((entry) => entry.path), [archived], JSON.stringify(result));
  assert.deepEqual(seen, {
    'after-verify': { admission: 'held', claim: 'held' },
    'before-removal': { admission: 'free', claim: 'held' }
  });

  const killed = await runChild(['delete-then-crash', fixture.root, itemAt(plan, crashed).key, 'before-removal']);
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const parent = path.dirname(crashed);
  const leftover = (await fs.readdir(parent)).find((name) => name.startsWith(`${path.basename(crashed)}.deleting-`));
  assert.ok(leftover, (await fs.readdir(parent)).join(','));
  const next = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual([next.finishedDeletions, next.restoredDeletions], [[path.join(parent, leftover)], []]);
  assert.deepEqual(await fs.readdir(parent), [], '两份都删完');
});

test('L2 备份目录按种类逐项核对：本地备份（C1）或外来库保留的备份里有它的种类不会写的内容（另一份数据库、说明文件、子目录、名为 .tmp 的目录）时整份保留；只有 .tmp 普通文件时算没写完', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  await seed(fixture.alpha, ['conversation_only_in_alpha']);
  const nestedCase = await copyAsArchive(fixture.current, fixture.root, archiveName(1));
  const nestedName = backupNameAt(1);
  const nested = await backupInto(nestedCase, fixture.current, nestedName);
  await fs.copyFile(fixture.alpha.binding.paths.databasePath, path.join(nested, 'limcode-before-restore.sqlite'));
  const database = await openCurrent(t, fixture);
  const cases = {};
  const local = async (name, minutesAgo, prepare) => {
    const directory = await targetBackup(fixture.current, database, minutesAgo);
    await prepare?.(directory);
    await backdate(directory, minutesAgo);
    cases[name] = directory;
  };
  await local('otherDatabase', 300, (directory) => fs.copyFile(fixture.alpha.binding.paths.databasePath, path.join(directory, 'limcode-before-restore.sqlite')));
  await local('note', 280, (directory) => fs.writeFile(path.join(directory, 'README.txt'), 'mine'));
  await local('subdirectory', 260, (directory) => fs.mkdir(path.join(directory, 'extra')));
  await local('temporaryDirectory', 240, (directory) => fs.mkdir(path.join(directory, 'limcode.sqlite.1.tmp')));
  await local('writing', 220, (directory) => fs.writeFile(path.join(directory, 'limcode.sqlite.1.tmp'), 'partial'));
  await local('clean', 200);
  await targetBackup(fixture.current, database, 120);

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual(Object.fromEntries(Object.entries(cases).map(([name, directory]) => [name, itemAt(plan, directory).reason])), {
    otherDatabase: '备份目录里有不认识的内容（limcode-before-restore.sqlite），保留',
    note: '备份目录里有不认识的内容（README.txt），保留',
    subdirectory: '备份目录里有不认识的内容（extra），保留',
    temporaryDirectory: '备份目录里有不认识的内容（limcode.sqlite.1.tmp），保留',
    writing: '备份还没有写完（目录里有临时文件），保留',
    clean: `可以删除：内容已完整在当前库里（其中 1 个对话、2 个消息版本都在，${COMPLETE}）`
  });
  assert.deepEqual([itemAt(plan, nestedCase).deletable, itemAt(plan, nestedCase).reason], [false,
    `它保留的合并前备份 ${nestedName}：备份目录里有不认识的内容（limcode-before-restore.sqlite），整份保留`]);
});

test('L3 已核对标记绑定配置根：别处写的标记（没有身份、身份不同、配置根不同）不算，改回原名重新核对，含本地库没有的对话就保留；本配置根写的照常删完', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const other = await initialize(path.join(fixture.base, 'elsewhere'), 'elsewhere');
  await seed(other, ['conversation_only_there']);
  const archives = path.join(copiedDirectory(fixture, 1), '.limcode-runtime-backups');
  await fs.mkdir(archives, { recursive: true });
  const token = randomUUID();
  const identityFile = path.join(fixture.root, '.limcode-runtime-merges', 'backup-cleanup-identity.json');
  await fs.mkdir(path.dirname(identityFile), { recursive: true });
  await fs.writeFile(identityFile, JSON.stringify({ kind: 'limcode-backup-cleanup-identity', token }));
  const marks = {
    // Written before this check existed, or by another installation or machine.
    legacy: {},
    otherIdentity: { configurationRoot: fixture.root, cleanupIdentity: randomUUID() },
    // This configuration root copied elsewhere carries the token, not the path.
    otherRoot: { configurationRoot: path.join(fixture.base, 'Elsewhere'), cleanupIdentity: token },
    ours: { configurationRoot: fixture.root, cleanupIdentity: token }
  };
  const leftovers = {};
  for (const [index, [name, bound]] of Object.entries(marks).entries()) {
    const original = path.join(archives, archiveName(index + 1));
    const leftover = `${original}.deleting-0123456789abcdef`;
    await fs.cp(controlRoot(other), leftover, { recursive: true });
    await fs.writeFile(path.join(leftover, '.limcode-backup-cleanup-verified'), JSON.stringify({
      foreignId: 'foreign:archive:0000000000000000', kind: 'limcode-backup-cleanup-verified', name: path.basename(leftover), ...bound
    }));
    leftovers[name] = { original, leftover };
  }
  const database = await openCurrent(t, fixture);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual(plan.finishedDeletions, [leftovers.ours.leftover]);
  assert.deepEqual([...plan.restoredDeletions].sort(), [leftovers.legacy.original, leftovers.otherIdentity.original, leftovers.otherRoot.original].sort());
  for (const name of ['legacy', 'otherIdentity', 'otherRoot']) {
    const item = itemAt(plan, leftovers[name].original);
    assert.equal(item.deletable, false, name);
    assert.match(item.reason, /^含 1 个当前库没有的对话（可能是你删掉的）/, name);
    assert.equal(await exists(path.join(leftovers[name].original, '.limcode-backup-cleanup-verified')), false, '改回原名时去掉不属于它的标记');
  }
  assert.equal(await exists(leftovers.ours.leftover), false);
});

test('L4 历史库的名字与“历史与存储管理”一致：当前库、项目名（最多三个）、没有项目的工作区库写“旧工作区历史”、没有项目的默认库写“默认历史库”；原因与名字都不写 id', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, ['conversation_alpha']);
  const beta = await addWorkspaceDataSet(fixture, 'file:///workspace/beta');
  await seed(beta, ['conversation_beta'], { uri: 'file:///workspace/beta', name: 'beta' });
  await seed(beta, ['conversation_gamma'], { uri: 'file:///workspace/gamma', name: 'gamma' });
  const empty = await addWorkspaceDataSet(fixture, 'file:///workspace/empty');
  const backups = {
    default: await sourceBackup(fixture.current),
    beta: await sourceBackup(beta),
    empty: await sourceBackup(empty)
  };
  // Alpha is the one open in this window.
  await publishInitialRuntimeSelection(fixture.paths, fixture.alpha.id);
  const database = await kernel.RuntimeDatabase.open(fixture.alpha.authority, { hostBootId: `window-${randomUUID()}` });
  t.after(() => database.close().catch(() => undefined));
  backups.current = await targetBackup(fixture.alpha, database, 180);
  await targetBackup(fixture.alpha, database, 120);

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual(Object.fromEntries(Object.entries(backups).map(([name, directory]) => [name, itemAt(plan, directory).dataSetName])), {
    default: '历史库“默认历史库”', beta: '历史库“beta、gamma”', empty: '历史库“旧工作区历史”', current: '当前库'
  });
  assert.equal(itemAt(plan, backups.beta).reason, `可以删除：内容已完整在历史库“beta、gamma”里（其中 2 个对话、4 个消息版本都在，${COMPLETE}）`);
  assert.doesNotMatch(JSON.stringify(plan.items.map((item) => [item.reason, item.dataSetName])), /workspace:|default|（workspace/);
});

test('L6 外来库里逐项核对：名为 .tmp 的目录、名字像声明但格式不对或装着别的东西的目录、诊断目录里日志以外的内容都让它整份保留；只有日志和空的调试取证目录、或一个真正的声明目录时照常可删', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const cases = {};
  let index = 0;
  const make = async (name, prepare) => {
    index += 1;
    const unit = await copyAsArchive(fixture.current, fixture.root, archiveName(index));
    await prepare(unit);
    cases[name] = unit;
  };
  const claim = async (directory, files) => {
    await fs.mkdir(directory, { recursive: true });
    for (const [file, content] of Object.entries(files)) await fs.writeFile(path.join(directory, file), content);
  };
  const owner = JSON.stringify({ processId: 1, hostBootId: 'gone' });
  await make('temporaryDirectoryInData', (unit) => fs.mkdir(path.join(unit, 'active', 'limcode.sqlite.1.tmp')));
  await make('temporaryDirectoryInControl', (unit) => fs.mkdir(path.join(unit, 'root-binding.json.1.tmp')));
  await make('forgedClaimName', (unit) => claim(path.join(unit, 'notes.runtime-maintenance-old'), { 'owner.json': owner }));
  await make('claimWithMore', (unit) => claim(path.join(unit, 'active', 'limcode.sqlite.runtime-maintenance'), { 'owner.json': owner, 'notes.txt': 'mine' }));
  await make('diagnosticsOther', (unit) => claim(path.join(unit, 'active', 'diagnostics'), { 'events.jsonl': '{}\n', 'notes.txt': 'mine' }));
  await make('diagnosticsJournalDirectory', (unit) => fs.mkdir(path.join(unit, 'active', 'diagnostics', 'events.1.jsonl'), { recursive: true }));
  await make('onlyJournal', async (unit) => {
    await claim(path.join(unit, 'active', 'diagnostics'), { 'events.jsonl': '{}\n', 'events.1.jsonl': '{}\n', 'events.3.jsonl': '{}\n' });
    await fs.mkdir(path.join(unit, 'active', 'diagnostics', 'debug-captures'));
  });
  await make('leftClaim', (unit) => claim(path.join(unit, 'active', 'limcode.sqlite.runtime-maintenance'), { 'owner.json': owner }));
  const database = await openCurrent(t, fixture);

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  const full = `可以删除：内容已完整在当前库里（其中 1 个对话、2 个消息版本都在，${COMPLETE}）`;
  assert.deepEqual(Object.fromEntries(Object.entries(cases).map(([name, unit]) => [name, itemAt(plan, unit).reason])), {
    temporaryDirectoryInData: '数据目录里有不认识的内容（limcode.sqlite.1.tmp），整份保留，可自行处理',
    temporaryDirectoryInControl: '里面有不认识的内容（root-binding.json.1.tmp），整份保留，可自行处理',
    forgedClaimName: '里面有不认识的内容（notes.runtime-maintenance-old），整份保留，可自行处理',
    claimWithMore: '数据目录里有不认识的内容（limcode.sqlite.runtime-maintenance），整份保留，可自行处理',
    diagnosticsOther: '诊断目录里有不认识的内容（diagnostics/notes.txt），整份保留，可自行处理',
    diagnosticsJournalDirectory: '诊断目录里有不认识的内容（diagnostics/events.1.jsonl），整份保留，可自行处理',
    onlyJournal: full,
    leftClaim: full
  });
});

test('L7 改名前的最后一步与改名之后都再比较一次目录：改名前写进去的不改名、保留；改名之后才写进去的改回原名；正文库里新添的文件同样看得出', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const beforeRename = await copyAsArchive(fixture.current, fixture.root, archiveName(1));
  const afterRename = await copyAsArchive(fixture.current, fixture.root, archiveName(2));
  const storeAdded = await copyAsArchive(fixture.current, fixture.root, archiveName(3));
  const rewritten = await copyAsArchive(fixture.current, fixture.root, archiveName(4));
  const database = await openCurrent(t, fixture);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  const parent = path.dirname(beforeRename);

  const points = [];
  const first = await deleteRuntimeBackups(plan, database, [itemAt(plan, beforeRename).key], {
    async onFaultPoint(point) {
      points.push(point);
      // After its coverage was read again, right before the rename.
      if (point === 'before-rename') await fs.writeFile(path.join(beforeRename, 'active', 'written-late.txt'), 'x');
    }
  });
  assert.deepEqual(points, ['before-rename'], '没有改名');
  assert.deepEqual(first.kept.map((entry) => entry.reason), ['列出之后它有变化，请重新检查；这一项没有删除']);
  assert.ok(await exists(path.join(beforeRename, 'active', 'written-late.txt')));

  const second = await deleteRuntimeBackups(plan, database, [itemAt(plan, afterRename).key], {
    async onFaultPoint(point) {
      if (point !== 'after-rename') return;
      const renamed = (await fs.readdir(parent)).find((name) => name.startsWith(`${path.basename(afterRename)}.deleting-`));
      await fs.writeFile(path.join(parent, renamed, 'active', 'written-late.txt'), 'x');
    }
  });
  assert.deepEqual(second.kept.map((entry) => entry.reason), ['改名前后它有变化，请重新检查，已改回原名，保留']);
  assert.ok(await exists(path.join(afterRename, 'active', 'written-late.txt')));

  // A content object that appeared in its store after the listing (objects are compared by name only).
  const objects = path.join(storeAdded, 'active', 'cas', 'sha256');
  const bucket = (await fs.readdir(objects)).sort()[0];
  await fs.writeFile(path.join(objects, bucket, `${bucket}${'0'.repeat(62)}`), 'x');
  const third = await deleteRuntimeBackups(plan, database, [itemAt(plan, storeAdded).key]);
  assert.deepEqual(third.kept.map((entry) => entry.reason), ['列出之后它有变化，请重新检查；这一项没有删除']);
  // An existing file outside the content store written again (the same bytes): its state changed.
  const epochFile = path.join(rewritten, 'active', 'runtime-kernel-epoch.json');
  const fourth = await deleteRuntimeBackups(plan, database, [itemAt(plan, rewritten).key], {
    async onFaultPoint(point) { if (point === 'before-rename') await fs.writeFile(epochFile, await fs.readFile(epochFile)); }
  });
  assert.deepEqual(fourth.kept.map((entry) => entry.reason), ['列出之后它有变化，请重新检查；这一项没有删除']);
  assert.deepEqual((await fs.readdir(parent)).filter((name) => name.includes('.deleting-')), []);
});

test('L9 身份相同证明：外来拷贝保留的备份里有孪生库已删掉的对话时，不能按“内容完全相同”删除', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_current']);
  await seed(fixture.alpha, ['conversation_kept', 'conversation_deleted_later']);
  // A backup taken while alpha still had both conversations, kept aside; then an exact copy of alpha as it is now, keeping it.
  const name = backupNameAt(1);
  const backup = await backupInto(path.join(fixture.base, 'aside'), fixture.alpha, name);
  await deleteConversation(fixture.alpha, 'conversation_deleted_later');
  const copy = await copyAsArchive(fixture.alpha, fixture.alpha.scopeRoot, archiveName(1));
  await fs.mkdir(path.join(copy, 'merge-backups'), { recursive: true });
  await fs.rename(backup, path.join(copy, 'merge-backups', name));
  const database = await openCurrent(t, fixture);
  const item = itemAt(await planRuntimeBackupCleanup(fixture.root, database), copy);
  // Identical: only the twin is compared (its own rows were never read).
  assert.deepEqual([item.deletable, item.reason], [false, '含 1 个历史库“shared”没有的对话（可能是你删掉的），按历史保留']);
});

test('L9 读孪生库的摘要与读它的 id 之间它又变了（故障注入）：不按身份相同删除，写明暂时无法核对；再检查时按覆盖核对，写明缺的对话', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_current']);
  await seed(fixture.alpha, ['conversation_alpha_one', 'conversation_alpha_two']);
  const twin = await copyAsArchive(fixture.alpha, fixture.alpha.scopeRoot, archiveName(1));
  const database = await openCurrent(t, fixture);
  let injected = 0;
  const plan = await planRuntimeBackupCleanup(fixture.root, database, {
    async onPlanningPoint(point, candidateId) {
      if (point !== 'after-local-digest' || candidateId !== fixture.alpha.id || injected++ > 0) return;
      await deleteConversation(fixture.alpha, 'conversation_alpha_two');
    }
  });
  assert.equal(injected, 1);
  const item = itemAt(plan, twin);
  assert.deepEqual([item.deletable, item.reason], [false, '暂时无法核对：所在历史库在读取期间有变化，稍后再试']);
  const next = itemAt(await planRuntimeBackupCleanup(fixture.root, database), twin);
  assert.deepEqual([next.deletable, next.reason],
    [false, '含 1 个历史库“shared”没有的对话（可能是你删掉的），也没有别的本地库完整包含它，按历史保留']);
});

// ---------------------------------------------------------------------------------------------
// Fixtures

async function createFixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-backup-cleanup-review-')));
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

async function addWorkspaceDataSet(fixture, folder) {
  const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: [folder] });
  return initialize(resolveVscodeWorkspaceRuntimeScopeRoot(fixture.paths, scope), `workspace:${scope.key}`);
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
    const store = kernel.ContentAddressedStore.loose(dataSet.authority, runtime.binding);
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

/** What deleting or retrying a message does to it (turnControlPlane softDeleteEntrySteps). */
function softDeleteSteps(messageId) {
  return [
    repo('Message').assert(messageId, { deleted_at: null }),
    repo('Message').update(messageId, { deleted_at: LATER, updated_at: LATER })
  ];
}

/** What editing a message does to it: a new revision becomes the current one. */
async function editMessage(dataSet, runtime, messageId) {
  const store = kernel.ContentAddressedStore.loose(dataSet.authority, runtime.binding);
  const content = await store.ingest(runtime, JSON.stringify({ role: 'user', parts: [{ text: `${messageId} 改过之后` }] }), MESSAGE_TYPE);
  const revisionId = `${messageId}_revision_2`;
  await runtime.transaction([
    repo('Message').assert(messageId, { deleted_at: null }),
    repo('MessageCurrentRevisionLink').assert(`${messageId}_current`, { revision_id: `${messageId}_revision` }),
    repo('MessageRevision').insert({ id: revisionId, message_id: messageId, revision_seq: 2n, role: 'user', content_object_id: content.id, created_at: LATER }),
    repo('MessageCurrentRevisionLink').update(`${messageId}_current`, { revision_id: revisionId, updated_at: LATER })
  ]);
}

/**
 * A finished tool call (with the result given to the model, as the second message), a question with
 * its answer and a process with its output in a conversation's turn (fixed ids).
 */
async function addRecords(dataSet, conversationId) {
  return withDataSet(dataSet, async (runtime) => {
    const store = kernel.ContentAddressedStore.loose(dataSet.authority, runtime.binding);
    const body = async (text) => (await store.ingest(runtime, JSON.stringify({ text }), 'application/json')).id;
    const [argumentsId, promptId, answerId, outputId] = [
      await body('read_file README.md'), await body('继续吗？'), await body('继续'), await body('hello\n')
    ];
    const turnId = `${conversationId}_turn`;
    await runtime.transaction([
      repo('ToolCall').insert({
        id: `${conversationId}_tool`, turn_id: turnId, call_seq: 1n, tool_name: 'read_file', status: 'terminal',
        arguments_object_id: argumentsId, created_at: NOW, updated_at: NOW
      }),
      repo('ToolModelResult').insert({
        id: `${conversationId}_tool_result`, tool_call_id: `${conversationId}_tool`, message_revision_id: `${conversationId}_message_1_revision`, created_at: NOW
      }),
      repo('InteractionRequest').insert({
        id: `${conversationId}_question`, request_kind: 'question', status: 'answered', prompt_object_id: promptId, created_at: NOW, updated_at: NOW
      }),
      repo('InteractionResponse').insert({ id: `${conversationId}_answer`, request_id: `${conversationId}_question`, content_object_id: answerId, created_at: NOW }),
      repo('Process').insert({
        id: `${conversationId}_process`, status: 'exited', wrapper_nonce: 'nonce', wrapper_pid: 1n, child_pid: null, process_group_id: null,
        start_fingerprint: 'fingerprint', command_digest: 'digest', spool_locator: 'spool', retained_bytes: 6n, retained_chunks: 1n,
        dropped_bytes: 0n, truncated: 0n, started_at: NOW, updated_at: NOW, completed_at: NOW
      }),
      repo('ProcessReceipt').insert({
        id: `${conversationId}_process_receipt`, process_id: `${conversationId}_process`, outcome: 'succeeded',
        exit_code: 0n, exit_signal: null, wrapper_nonce: 'nonce', start_fingerprint: 'fingerprint', received_at: NOW
      }),
      repo('ProcessOutputChunk').insert({
        id: `${conversationId}_output`, process_id: `${conversationId}_process`, chunk_seq: 1n, stream_kind: 'stdout',
        content_object_id: outputId, byte_length: 6n, created_at: NOW
      })
    ]);
    return { outputContentId: outputId };
  });
}

/** Where a body of a data set is kept below its CAS (its content object's storage key, split). */
async function storageKey(dataSet, contentId) {
  return withDataSet(dataSet, async (runtime) => {
    const [row] = (await runtime.snapshot([{ kind: 'get', domain: 'ContentObject', id: contentId }])).snapshot;
    return row.storage_key.split('/');
  });
}

async function deleteConversation(dataSet, conversationId) {
  await withDataSet(dataSet, (runtime) => runtime.transaction([repo('Conversation').delete(conversationId)]));
}

/** A closed data set's whole control root copied into the archives directory of `scopeRoot` (as if restored by hand). */
async function copyAsArchive(dataSet, scopeRoot, name) {
  const target = path.join(scopeRoot, '.limcode-runtime-backups', name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(controlRoot(dataSet), target, { recursive: true });
  return target;
}

/** A pre-merge backup of a closed data set (Backup API copy beside its binding) inside a control root. */
async function backupInto(unit, dataSet, name) {
  const directory = path.join(unit, 'merge-backups', name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'root-binding.json'), `${JSON.stringify(dataSet.binding, null, 2)}\n`);
  const live = new Database(dataSet.binding.paths.databasePath, { readonly: true, fileMustExist: true });
  try { await live.backup(path.join(directory, 'limcode.sqlite')); }
  finally { live.close(); }
  return directory;
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

function archiveName(index) {
  return `2026090${index}-010203-004-abcdef1${index}`;
}

function backupNameAt(index) {
  return `20260901T01020${index}000Z-00000${index}-${randomUUID().slice(0, 8)}`;
}

function copiedDirectory(fixture, index) {
  return `${fixture.root}.limcode-copied-2026-09-0${index}T01-02-03-004Z-1234567${index}`;
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

/** Every entry below `root`: type, size, times and content. */
async function treeState(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      const stat = await fs.lstat(file, { bigint: true });
      const key = path.relative(root, file);
      if (entry.isDirectory()) { result[key] = `dir:${stat.ino}:${stat.mtimeNs}`; await visit(file); }
      else result[key] = `file:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`;
    }
  }
  await visit(root);
  return result;
}

/** The pid of a process that has exited. */
async function exitedProcessId() {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid;
}

/** Whether another process can take the configuration admission and the foreign root's claim right now. */
async function probe(root, id, pointer) {
  const result = await runChild(['probe', root, id, pointer]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
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
