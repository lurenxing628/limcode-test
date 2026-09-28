// 清理备份里的外来历史库（runtimeBackupCleanup + runtimeForeignHistory）：“归档并重置”的归档、上一个数据
// 目录里的归档和拷来目录里的库。只处理核验通过的；与某个非当前本地库身份相同且内容摘要相同，或全部对话与消息
// 版本（连同它保留的备份）都在某个本地库里才可删；删除在 admission 与不等待的外来声明内重新核验再改名、再核、
// 写标记、删除，外来目录里只动被删的那一份。Runs against the compiled extension.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const fsSync = require('node:fs');
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = kernelFile('index.js');
const Database = require('better-sqlite3');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { projectFolderAssignmentSteps } = kernelFile('conversationProject.js');
const { deleteRuntimeBackups, planRuntimeBackupCleanup } = kernelFile('runtimeBackupCleanup.js');
const foreign = kernelFile('runtimeForeignHistory.js');
const { writeRuntimeDataSetMergeLedgerRecord } = kernelFile('runtimeDataSetMergeLedger.js');
const { migratePreviousRuntimeEpochIfRequired, RUNTIME_EPOCH_MIGRATION_COMPLETION_FILE } = kernelFile('runtimeEpochMigration.js');
const { withRuntimeClaimAtPath } = kernelFile('runtimeHostControl.js');
const {
  resolveVscodeRuntimeDataRoot, resolveVscodeWorkspaceRuntimeScope, resolveVscodeWorkspaceRuntimeScopeRoot, selectVscodeRuntimeDataSet
} = kernelFile('vscodeRootAuthority.js');
const { archiveCurrentRuntimeRootForReset } = require(path.join(
  compiled, 'backend/application/reliableKernel/VscodeReliableKernelCutoverCoordinator.js'
));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = '2026-09-26T00:00:00.000Z';
const DAY = 24 * 60 * 60_000;
const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
const PROJECT = { uri: 'file:///workspace/shared', name: 'shared' };
const BUSY = '正在被只读查看、核验或合并（另一个窗口或操作正在用它）';
const REST = '其余内容（设置、规则、技能）保留，可自行处理';
const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);

test('覆盖证明：“归档并重置”留下的真实归档，它的对话和消息版本都在当前库里时可删，整份归档目录删掉；当前库少了其中的对话时写明缺几个并保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one', 'conversation_two']);
  const archived = await archive(fixture, fixture.current);
  await seed(fixture.current, ['conversation_one']);
  let database = await openCurrent(t, fixture);
  const first = itemAt(await planRuntimeBackupCleanup(fixture.root, database), archived);
  assert.deepEqual([first.kind, first.origin, first.deletable, first.inCurrentDataSet], ['foreign-history', '“归档并重置”的归档', false, false]);
  assert.equal(first.reason, '含 1 个当前库没有的对话（可能是你删掉的），也没有别的本地库完整包含它，按历史保留');
  assert.deepEqual([first.conversations, first.revisions, first.missingConversations], [2, 4, 1]);
  assert.ok(BigInt(first.bytes) > 0n);
  assert.match(first.key, /^foreign-history:foreign:archive:[0-9a-f]{16}$/);

  // The missing conversation is back (merged again, say): every id of the archive is in the current data set.
  await database.close();
  await seed(fixture.current, ['conversation_two']);
  database = await openCurrent(t, fixture);
  const reader = countingReader(database);
  const plan = await planRuntimeBackupCleanup(fixture.root, reader);
  const item = itemAt(plan, archived);
  assert.equal(item.deletable, true, item.reason);
  assert.equal(item.reason, '可以删除：内容已完整在当前库里（其中 2 个对话、4 个消息版本都在）');
  assert.ok(reader.calls > 0 && reader.maxBatch <= 250, '当前库只经它自己的读取线程查询');
  const parent = path.dirname(archived);
  const others = (await fs.readdir(parent)).filter((name) => name !== path.basename(archived));
  const result = await deleteRuntimeBackups(plan, reader, [item.key]);
  assert.deepEqual(result.deleted.map((entry) => entry.path), [archived], JSON.stringify(result));
  assert.deepEqual(result.copiedDirectoriesWithoutDataSets, []);
  await assert.rejects(fs.lstat(archived), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(parent)).sort(), others.sort(), '整份归档目录删掉，没有留下 .deleting-，也没有新建别的');
  assert.equal((await planRuntimeBackupCleanup(fixture.root, database)).items.some((entry) => entry.path === archived), false);
});

test('身份相同证明：与某个历史库身份相同、内容摘要相同的拷贝可删；摘要不同但对话都在时按覆盖可删；那个库删掉对话后两种都不成立；与当前库身份相同的拷贝只按覆盖核对', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_current']);
  await seed(fixture.alpha, ['conversation_alpha_one', 'conversation_alpha_two']);
  const twin = await copyAsArchive(fixture.alpha, fixture.alpha.scopeRoot, archiveName(1));
  const twinToKeep = await copyAsArchive(fixture.alpha, fixture.alpha.scopeRoot, archiveName(2));
  const currentCopy = await copyAsArchive(fixture.current, fixture.root, archiveName(3));
  const database = await openCurrent(t, fixture);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  const identical = itemAt(plan, twin);
  assert.equal(identical.deletable, true, identical.reason);
  assert.equal(identical.reason, `可以删除：内容已完整在历史库（${fixture.alpha.id}）里（与它身份相同、内容完全相同）`);
  assert.equal(identical.origin, '“归档并重置”的归档（工作区库）');
  const ofCurrent = itemAt(plan, currentCopy);
  assert.equal(ofCurrent.reason, '可以删除：内容已完整在当前库里（其中 1 个对话、2 个消息版本都在）', '当前库没有安全的摘要途径，只按覆盖核对');
  const alphaBefore = await fileStates(controlRoot(fixture.alpha));
  const result = await deleteRuntimeBackups(plan, database, [identical.key]);
  assert.deepEqual(result.deleted.map((entry) => entry.path), [twin], JSON.stringify(result));
  await assert.rejects(fs.lstat(twin), { code: 'ENOENT' });
  assert.deepEqual(await fileStates(controlRoot(fixture.alpha)), alphaBefore, '证明它的历史库不受影响');

  // Alpha has one more conversation: no longer the same content, still every id of the copy.
  await seed(fixture.alpha, ['conversation_alpha_three']);
  const grown = itemAt(await planRuntimeBackupCleanup(fixture.root, database), twinToKeep);
  assert.equal(grown.reason, `可以删除：内容已完整在历史库（${fixture.alpha.id}）里（其中 2 个对话、4 个消息版本都在）`);
  // Alpha lost one of the copy's conversations: neither proof holds.
  await deleteConversation(fixture.alpha, 'conversation_alpha_two');
  const shrunk = itemAt(await planRuntimeBackupCleanup(fixture.root, database), twinToKeep);
  assert.deepEqual([shrunk.deletable, shrunk.reason],
    [false, `含 1 个历史库（${fixture.alpha.id}）没有的对话（可能是你删掉的），也没有别的本地库完整包含它，按历史保留`]);
});

test('没有通过核验的外来库只列出、写明原因；列出之后才出现涉及它的正在提交的合并、或路径上换成了符号链接，锁内重新核验不通过，不删', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const broken = await copyAsArchive(fixture.current, fixture.root, archiveName(1));
  await fs.writeFile(path.join(broken, 'root-binding.json'), '{');
  const merging = await copyAsArchive(fixture.current, fixture.root, archiveName(2));
  // Located fine, but its audit fails (an index is missing); its ids alone would still be readable.
  const drifted = await copyAsArchive(fixture.current, fixture.root, archiveName(3));
  rawEditFile(path.join(drifted, 'active', 'limcode.sqlite'), (edit) => {
    const index = edit.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name LIMIT 1").pluck().get();
    edit.exec(`DROP INDEX "${index}"`);
  });
  const database = await openCurrent(t, fixture);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  const failed = itemAt(plan, broken);
  assert.deepEqual([failed.kind, failed.deletable], ['foreign-history', false]);
  assert.equal(failed.reason, '未通过核验：RootBinding 指针不是有效的 JSON，原样保留');
  assert.ok(BigInt(failed.bytes) > 0n, '未通过核验的也写明大小');
  const audit = itemAt(plan, drifted);
  assert.equal(audit.deletable, false);
  assert.match(audit.reason, /^未通过核验：结构或完整性核验未通过.*，原样保留$/);
  assert.equal(itemAt(plan, merging).deletable, true, itemAt(plan, merging).reason);
  const forged = await deleteRuntimeBackups(plan, database, [failed.key]);
  assert.deepEqual(forged.kept.map((entry) => entry.reason), ['不在可以删除的清单里']);

  // Another window started committing a merge that involves it (its identity is the current data set's).
  await writeRuntimeDataSetMergeLedgerRecord(fixture.paths, {
    candidateId: 'workspace:other', state: 'committing', commitId: 'commit-1',
    target: { dataSetId: database.binding.dataSetId, rootInstanceId: database.binding.rootInstanceId },
    source: { dataSetId: 'other', rootInstanceId: 'other', rootGeneration: 1, pointerRevision: 1, contentDigest: 'x' }
  });
  const refused = await deleteRuntimeBackups(plan, database, [itemAt(plan, merging).key]);
  assert.deepEqual(refused.deleted, []);
  assert.match(refused.kept[0].reason, /^未通过核验：它参与的一次合并还没有确认是否写入完成.*；这一项没有删除$/);
  assert.ok((await fs.lstat(merging)).isDirectory());
  await fs.rm(path.join(fixture.root, '.limcode-runtime-merges', 'records'), { recursive: true, force: true });

  // Same files, but the archives directory is now a link to where they went: the tree is unchanged, the location is not.
  const again = await planRuntimeBackupCleanup(fixture.root, database);
  const key = itemAt(again, merging).key;
  assert.equal(itemAt(again, merging).deletable, true, itemAt(again, merging).reason);
  const archives = path.dirname(merging);
  const moved = path.join(fixture.base, 'moved-archives');
  await fs.rename(archives, moved);
  await fs.symlink(moved, archives, 'dir');
  const linked = await deleteRuntimeBackups(again, database, [key]);
  assert.deepEqual(linked.deleted, []);
  assert.match(linked.kept[0].reason, /^未通过核验：所在位置有符号链接.*；这一项没有删除$/);
  assert.ok((await fs.lstat(path.join(moved, path.basename(merging)))).isDirectory(), '链接指向的内容不删');
});

test('拷来目录只删被证明的库（它的控制根），设置、规则、技能和拷来目录本身不动；库都删掉之后结果写明其余内容保留，再检查时只列出拷来目录', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one', 'conversation_two']);
  const copied = copiedDirectory(fixture, 1);
  const defaultRoot = path.join(copied, '.limcode-runtime');
  const scopeRoot = path.join(copied, '.limcode-workspace-runtimes', 'scopes', path.basename(fixture.alpha.scopeRoot), '.limcode-runtime');
  await fs.cp(controlRoot(fixture.current), defaultRoot, { recursive: true });
  await fs.cp(controlRoot(fixture.current), scopeRoot, { recursive: true });
  await writeUserContent(copied);
  const database = await openCurrent(t, fixture);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  const [ofDefault, ofScope] = [itemAt(plan, defaultRoot), itemAt(plan, scopeRoot)];
  assert.deepEqual([ofDefault.kind, ofDefault.deletable, ofDefault.origin], ['foreign-history', true, '拷来目录里的库'], ofDefault.reason);
  assert.deepEqual([ofScope.deletable, ofScope.origin], [true, '拷来目录里的库（工作区库）'], ofScope.reason);
  assert.equal(ofDefault.name, path.basename(copied));
  assert.match(ofScope.name, / · 工作区库 folder-[0-9a-f]{8}$/);
  const rest = itemAt(plan, copied);
  assert.deepEqual([rest.kind, rest.deletable], ['copied-data-root', false]);
  assert.match(rest.reason, /其中的库在“外来历史库”一组里逐个核对.*目录本身和其余内容（设置、规则、技能）不删除$/);
  assert.equal(rest.bytes, String(USER_CONTENT_BYTES), '拷来目录只统计库以外的内容');
  const userBefore = await treeState(copied, [defaultRoot, scopeRoot]);

  const first = await deleteRuntimeBackups(plan, database, [ofDefault.key, rest.key]);
  assert.deepEqual(first.deleted.map((entry) => entry.path), [defaultRoot]);
  assert.deepEqual(first.kept.map((entry) => entry.reason), ['不在可以删除的清单里'], '拷来目录整体不能删');
  assert.deepEqual(first.copiedDirectoriesWithoutDataSets, [], '还有库：不提示');
  await assert.rejects(fs.lstat(defaultRoot), { code: 'ENOENT' });
  assert.ok((await fs.lstat(scopeRoot)).isDirectory());
  assert.deepEqual(await treeState(copied, [defaultRoot, scopeRoot]), userBefore, '其余内容一字节不变');

  const second = await planRuntimeBackupCleanup(fixture.root, database);
  const last = await deleteRuntimeBackups(second, database, [itemAt(second, scopeRoot).key]);
  assert.deepEqual(last.deleted.map((entry) => entry.path), [scopeRoot]);
  assert.deepEqual(last.copiedDirectoriesWithoutDataSets, [{ name: path.basename(copied), path: copied }]);
  assert.deepEqual(await treeState(copied, [defaultRoot, scopeRoot]), userBefore, '拷来目录本身和其余内容都在');

  const after = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(after.items.filter((entry) => entry.kind === 'foreign-history').length, 0);
  assert.equal(itemAt(after, copied).reason, `拷来目录里已经没有库；${REST}`);
});

test('外来库的声明被占（只读查看正在打开它、核验或合并）：检查写明正在使用、不能删；确认之后才被占的，删除不等待、原样保留；另一个进程持有时同样；释放之后照常删除', { timeout: 120_000 }, async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const archived = await copyAsArchive(fixture.current, fixture.root, archiveName(1));
  const database = await openCurrent(t, fixture);
  const found = (await foreign.discoverForeignRuntimeHistory({ configurationRootPath: fixture.root }))
    .find((entry) => entry.location.containerPath === archived);
  const located = await foreign.locateForeignRuntimeRoot(fixture.root, found.location);
  // The fence of the read-only view and of verification (withLocatedRuntimeRootFence), held in another
  // async scope; given up after 10 s at the latest, so a deletion that waited for it would delete.
  const holdFence = () => {
    let release;
    let acquired;
    const ready = new Promise((resolve) => { acquired = resolve; });
    const done = foreign.withLocatedRuntimeRootFence(fixture.paths, located, () => new Promise((resolve) => {
      acquired();
      const timer = setTimeout(resolve, 10_000);
      release = () => { clearTimeout(timer); resolve(); };
    }));
    return ready.then(() => async () => { release(); await done; });
  };

  let release = await holdFence();
  const busy = itemAt(await planRuntimeBackupCleanup(fixture.root, database), archived);
  await release();
  assert.deepEqual([busy.deletable, busy.reason], [false, `${BUSY}，这次不能删除，稍后再检查`]);
  assert.ok(BigInt(busy.bytes) > 0n);

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  const key = itemAt(plan, archived).key;
  assert.equal(itemAt(plan, archived).deletable, true, itemAt(plan, archived).reason);
  release = await holdFence();
  const started = Date.now();
  const kept = await deleteRuntimeBackups(plan, database, [key]);
  const waited = Date.now() - started;
  await release();
  assert.deepEqual(kept.kept.map((entry) => entry.reason), [`${BUSY}，这一项没有删除`]);
  assert.ok(waited < 10_000, `没有等待持有者（${waited} ms）`);
  assert.ok((await fs.lstat(archived)).isDirectory());

  // Held by another process.
  const holder = await holdInChild(claimPath(fixture.root, found.id), located.located.rootPointerPath);
  try {
    const other = await deleteRuntimeBackups(plan, database, [key]);
    assert.deepEqual(other.kept.map((entry) => entry.reason), [`${BUSY}，这一项没有删除`]);
    assert.equal(itemAt(await planRuntimeBackupCleanup(fixture.root, database), archived).reason, `${BUSY}，这次不能删除，稍后再检查`);
  } finally {
    await holder.stop();
  }
  const done = await deleteRuntimeBackups(plan, database, [key]);
  assert.deepEqual(done.deleted.map((entry) => entry.path), [archived], JSON.stringify(done));
});

test('删除中崩溃（子进程 SIGKILL）：改名之后、再核之前崩溃的归档改回原名重新核对；拷来目录里的库写下已核对标记之后崩溃的由下次清理删完；收尾取同一个外来声明，删到一半也一样', { timeout: 180_000 }, async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const archived = await copyAsArchive(fixture.current, fixture.root, archiveName(1));
  const copied = copiedDirectory(fixture, 1);
  const copiedRoot = path.join(copied, '.limcode-runtime');
  await fs.cp(controlRoot(fixture.current), copiedRoot, { recursive: true });
  await writeUserContent(copied);
  // Names that only look like leftovers: no control root discovery would take was renamed there.
  const decoys = [path.join(fixture.root, '.limcode-runtime-backups', 'notes.deleting-0123456789abcdef'), path.join(copied, 'rules.deleting-0123456789abcdef')];
  for (const decoy of decoys) await fs.mkdir(decoy, { recursive: true });
  // A leftover whose own name is taken again: neither restored nor removed, and not listed.
  const occupied = path.join(fixture.root, '.limcode-runtime-backups', archiveName(7));
  const blocked = `${occupied}.deleting-fedcba9876543210`;
  await fs.cp(controlRoot(fixture.current), blocked, { recursive: true });
  await fs.mkdir(occupied);
  const userBefore = await treeState(copied, [copiedRoot]);
  const database = await openCurrent(t, fixture);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(itemAt(plan, decoys[0]).kind, 'reset-archive', '不是改名的归档：只列出');
  const archiveKey = itemAt(plan, archived).key;
  const copiedKey = itemAt(plan, copiedRoot).key;
  const copiedId = copiedKey.slice('foreign-history:'.length);

  const early = await runChild(['delete-then-crash', fixture.root, archiveKey, 'after-rename']);
  assert.equal(early.signal, 'SIGKILL', early.stderr);
  const renamed = (await fs.readdir(path.dirname(archived))).find((name) => name.startsWith(`${path.basename(archived)}.deleting-`));
  assert.match(renamed ?? '', /\.deleting-[0-9a-f]{16}$/);
  assert.equal(await exists(path.join(path.dirname(archived), renamed, '.limcode-backup-cleanup-verified')), false);
  const restored = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual([restored.finishedDeletions, restored.restoredDeletions], [[], [archived]], '没有核对完的归档改回原名');
  assert.equal(itemAt(restored, archived).deletable, true, '改回原名之后按这次的核对结果列出');
  assert.equal(restored.items.some((entry) => entry.path === blocked), false, '收尾不了的残留不当作一项列出');
  assert.ok(restored.problems.some((line) => line.includes(path.basename(blocked)) && line.includes('原来的名字已被占用')), restored.problems.join('\n'));
  assert.ok(await exists(blocked));

  const late = await runChild(['delete-then-crash', fixture.root, copiedKey, 'after-verify']);
  assert.equal(late.signal, 'SIGKILL', late.stderr);
  const leftover = (await fs.readdir(copied)).find((name) => name.startsWith('.limcode-runtime.deleting-'));
  assert.ok(leftover, (await fs.readdir(copied)).join(','));
  const mark = JSON.parse(await fs.readFile(path.join(copied, leftover, '.limcode-backup-cleanup-verified'), 'utf8'));
  assert.deepEqual(mark, { foreignId: copiedId, kind: 'limcode-backup-cleanup-verified', name: leftover });
  // Removed halfway: its pointer is already gone, the mark still names the claim.
  await fs.rm(path.join(copied, leftover, 'root-binding.json'));

  // A read-only view or a merge holds the copied root's claim: its leftover waits for the next cleanup.
  // Given up after 10 s at the latest, so a cleanup that waited for it would settle the leftover.
  let release;
  let acquired;
  const ready = new Promise((resolve) => { acquired = resolve; });
  const holder = withRuntimeClaimAtPath(claimPath(fixture.root, copiedId), path.join(copiedRoot, 'root-binding.json'),
    () => new Promise((resolve) => { acquired(); release = resolve; setTimeout(resolve, 10_000).unref(); }));
  await ready;
  let busy;
  try {
    busy = await planRuntimeBackupCleanup(fixture.root, database);
  } finally {
    release();
    await holder;
  }
  assert.deepEqual([busy.finishedDeletions, busy.restoredDeletions], [[], []]);
  assert.ok(busy.problems.some((line) => line.includes(leftover) && line.includes(BUSY)), busy.problems.join('\n'));
  assert.ok(await exists(path.join(copied, leftover)), '声明被占时不收尾');

  const settled = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual([settled.finishedDeletions, settled.restoredDeletions], [[path.join(copied, leftover)], []]);
  assert.equal(await exists(path.join(copied, leftover)), false);
  assert.deepEqual(await treeState(copied, [copiedRoot]), userBefore, '拷来目录的其余内容不动');
  assert.equal(itemAt(settled, copied).reason, `拷来目录里已经没有库；${REST}`);
  for (const decoy of decoys) assert.ok((await fs.lstat(decoy)).isDirectory(), `${decoy} 没有被当作残留`);
});

test('fs 探针：检查不在外来目录里写任何东西；删除只改名、标记、删除被删的那一份，归档目录里的其它归档与拷来目录的其余内容一字节不变', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const doomed = await copyAsArchive(fixture.current, fixture.root, archiveName(1));
  const neighbour = await copyAsArchive(fixture.current, fixture.root, archiveName(2));
  const copied = copiedDirectory(fixture, 1);
  const copiedRoot = path.join(copied, '.limcode-runtime');
  await fs.cp(controlRoot(fixture.current), copiedRoot, { recursive: true });
  await writeUserContent(copied);
  const database = await openCurrent(t, fixture);
  const archives = path.dirname(doomed);
  const foreignPlaces = [archives, copied];
  const neighbourBefore = await treeState(neighbour);
  const userBefore = await treeState(copied, [copiedRoot]);

  let probe = probeFilesystem();
  let plan;
  try { plan = await planRuntimeBackupCleanup(fixture.root, database); }
  finally { probe.stop(); }
  const planWrites = probe.seen.filter((call) => writes(call) && foreignPlaces.some((place) => inside(place, call.path)));
  assert.deepEqual(planWrites, [], '检查不写外来目录');
  assert.ok(probe.seen.some((call) => inside(copiedRoot, call.path)), '探针确实看到了对外来目录的读取');

  probe = probeFilesystem();
  let result;
  try { result = await deleteRuntimeBackups(plan, database, [itemAt(plan, doomed).key, itemAt(plan, copiedRoot).key]); }
  finally { probe.stop(); }
  assert.deepEqual(result.deleted.map((entry) => entry.path).sort(), [doomed, copiedRoot].sort(), JSON.stringify(result));
  const deleteWrites = probe.seen.filter((call) => writes(call) && foreignPlaces.some((place) => inside(place, call.path)));
  assert.ok(deleteWrites.length > 0);
  const own = (unit, file) => inside(unit, file) || file.startsWith(`${unit}.deleting-`);
  assert.deepEqual(deleteWrites.filter((call) => !own(doomed, call.path) && !own(copiedRoot, call.path)), [], '只动被删的那一份');
  assert.deepEqual((await fs.readdir(archives)).sort(), [path.basename(neighbour)], '归档目录里没有新建别的');
  assert.deepEqual(await treeState(neighbour), neighbourBefore);
  assert.deepEqual(await treeState(copied, [copiedRoot]), userBefore);
});

test('硬链接：外来库的数据库、或它保留的备份与当前库是同一个文件时不读取它（本进程对当前库的 POSIX 锁不丢），写明原因、整份保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const linkedRoot = await copyAsArchive(fixture.current, fixture.root, archiveName(1));
  const linkedBackup = await copyAsArchive(fixture.current, fixture.root, archiveName(2));
  const database = await openCurrent(t, fixture);
  const databasePath = database.binding.paths.databasePath;
  await database.snapshot([{ kind: 'get', domain: 'Conversation', id: 'conversation_one' }]);
  const heldBefore = probeSharedLock(databasePath);
  if (heldBefore !== undefined) assert.equal(heldBefore, 'held', '打开的当前库持有数据库文件的 SHARED 锁');
  const rootDatabase = path.join(linkedRoot, 'active', 'limcode.sqlite');
  await fs.rm(rootDatabase);
  await fs.link(databasePath, rootDatabase);
  const backupName = `20260901T010203000Z-000001-${randomUUID().slice(0, 8)}`;
  const backup = path.join(linkedBackup, 'merge-backups', backupName);
  await fs.mkdir(backup, { recursive: true });
  await fs.writeFile(path.join(backup, 'root-binding.json'), JSON.stringify(database.binding));
  await fs.link(databasePath, path.join(backup, 'limcode.sqlite'));

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  assert.deepEqual([itemAt(plan, linkedRoot).deletable, itemAt(plan, linkedRoot).reason], [false,
    '未通过核验：limcode.sqlite 和本窗口可能正在使用的数据库是同一个文件（硬链接）；为了不破坏那个库的锁，不读取它，原样保留']);
  assert.deepEqual([itemAt(plan, linkedBackup).deletable, itemAt(plan, linkedBackup).reason], [false,
    `它保留的合并前备份 ${backupName}：它和本窗口可能正在使用的数据库是同一个文件（硬链接）；为了不破坏那个库的锁，不读取它，整份保留`]);
  if (heldBefore !== undefined) assert.equal(probeSharedLock(databasePath), 'held', '检查不能释放本进程对当前库的 POSIX 锁');
  assert.equal((await fs.stat(databasePath)).nlink, 3);
  assert.equal((await database.snapshot([{ kind: 'get', domain: 'Conversation', id: 'conversation_one' }])).snapshot[0]?.id, 'conversation_one');
});

test('外来库保留的备份逐份核对：都在当前库里时连同它一起删；其中一份有当前库没有的对话、有旧格式 backups/、调试取证、进程输出、不认识的内容或未结束的任务时整份保留', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one', 'conversation_two']);
  await seed(fixture.alpha, ['conversation_extra']);
  const withBackup = await copyAsArchive(fixture.current, fixture.root, archiveName(1));
  await backupInto(withBackup, fixture.current, backupNameAt(1));
  const uncoveredBackup = await copyAsArchive(fixture.current, fixture.root, archiveName(2));
  const extraName = backupNameAt(2);
  await backupInto(uncoveredBackup, fixture.alpha, extraName);
  const legacy = await copyAsArchive(fixture.current, fixture.root, archiveName(3));
  await fs.mkdir(path.join(legacy, 'backups'));
  await fs.writeFile(path.join(legacy, 'backups', 'conversations.json'), '[]');
  const captures = await copyAsArchive(fixture.current, fixture.root, archiveName(4));
  await fs.mkdir(path.join(captures, 'active', 'diagnostics', 'debug-captures', 'run-1'), { recursive: true });
  await fs.writeFile(path.join(captures, 'active', 'diagnostics', 'debug-captures', 'run-1', 'request.json'), '{}');
  const spool = await copyAsArchive(fixture.current, fixture.root, archiveName(5));
  await fs.mkdir(path.join(spool, 'active', 'process-spool', 'process-1'), { recursive: true });
  const unknown = await copyAsArchive(fixture.current, fixture.root, archiveName(6));
  await fs.writeFile(path.join(unknown, 'notes.txt'), 'mine');
  const journal = await copyAsArchive(fixture.current, fixture.root, archiveName(7));
  await fs.mkdir(path.join(journal, 'active', 'diagnostics'), { recursive: true });
  await fs.writeFile(path.join(journal, 'active', 'diagnostics', 'events.jsonl'), '{}\n');
  await fs.mkdir(path.join(journal, 'active', 'process-spool'), { recursive: true });
  const unknownData = await copyAsArchive(fixture.current, fixture.root, '20260909-010203-004-abcdef19');
  await fs.writeFile(path.join(unknownData, 'active', 'notes.txt'), 'mine');
  const linked = await copyAsArchive(fixture.current, fixture.root, '20260910-010203-004-abcdef20');
  await fs.symlink(fixture.base, path.join(linked, 'active', 'outside'), 'dir');
  const writing = await copyAsArchive(fixture.current, fixture.root, '20260911-010203-004-abcdef21');
  const writingName = backupNameAt(3);
  await backupInto(writing, fixture.current, writingName);
  await fs.writeFile(path.join(writing, 'merge-backups', writingName, `limcode.sqlite.${process.pid}.tmp`), 'partial');
  const strange = await copyAsArchive(fixture.current, fixture.root, '20260912-010203-004-abcdef22');
  await fs.mkdir(path.join(strange, 'merge-backups', 'my-copy'), { recursive: true });
  const empty = await copyAsArchive(fixture.current, fixture.root, '20260913-010203-004-abcdef23');
  const emptyName = backupNameAt(4);
  await fs.mkdir(path.join(empty, 'merge-backups', emptyName), { recursive: true });
  await fs.writeFile(path.join(empty, 'merge-backups', emptyName, 'root-binding.json'), JSON.stringify(fixture.current.binding));
  // An edited message: one more version of a message whose conversation the current data set has.
  const edited = await copyAsArchive(fixture.current, fixture.root, '20260914-010203-004-abcdef24');
  rawEditFile(path.join(edited, 'active', 'limcode.sqlite'), (edit) => edit.prepare(`
    INSERT INTO message_revision (id, message_id, revision_seq, role, content_object_id, created_at)
    SELECT 'conversation_one_message_0_revision_2', message_id, 2, role, content_object_id, created_at FROM message_revision WHERE id = ?
  `).run('conversation_one_message_0_revision'));
  const fifo = process.platform === 'win32' ? undefined : await copyAsArchive(fixture.current, fixture.root, '20260915-010203-004-abcdef25');
  if (fifo) execFileSync('mkfifo', [path.join(fifo, 'active', 'pipe')]);
  await seedActiveTurn(fixture.current, 'conversation_one');
  const unfinished = await copyAsArchive(fixture.current, fixture.root, archiveName(8));
  const database = await openCurrent(t, fixture);

  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  const reasons = Object.fromEntries(Object.entries({
    withBackup, uncoveredBackup, legacy, captures, spool, unknown, journal, unfinished, unknownData, linked, writing, strange, empty, edited
  }).map(([name, directory]) => [name, itemAt(plan, directory).reason]));
  assert.deepEqual(reasons, {
    withBackup: '可以删除：内容已完整在当前库里（其中 2 个对话、4 个消息版本都在，包括它保留的 1 份备份）',
    uncoveredBackup: '含 1 个当前库没有的对话（可能是你删掉的），也没有别的本地库完整包含它，按历史保留',
    legacy: '里面有旧格式备份 backups/（升级到 SQLite 内核之前的数据，从未导入），整份保留，可自行处理',
    captures: '里面有调试取证（diagnostics/debug-captures），整份保留，可自行处理',
    spool: '里面的进程输出暂存（process-spool）还有内容，整份保留，可自行处理',
    unknown: '里面有不认识的内容（notes.txt），整份保留，可自行处理',
    journal: '可以删除：内容已完整在当前库里（其中 2 个对话、4 个消息版本都在）',
    unfinished: '有 1 项未结束的任务（旧窗口中断时留下），覆盖核对不包括它们，按历史保留',
    unknownData: '数据目录里有不认识的内容（notes.txt），整份保留，可自行处理',
    linked: '目录里有符号链接，不跟随也不删除，整份保留',
    writing: `它保留的合并前备份 ${writingName} 还没有写完（目录里有临时文件），整份保留`,
    strange: '它保留的合并前备份 my-copy 的名字不认识，整份保留',
    empty: `它保留的合并前备份 ${emptyName} 里没有数据库文件，整份保留`,
    edited: '含 1 个当前库没有的消息版本，也没有别的本地库完整包含它，按历史保留'
  });
  if (fifo) assert.equal(itemAt(plan, fifo).reason, '目录里有无法识别的文件类型，整份保留');
  const result = await deleteRuntimeBackups(plan, database, [itemAt(plan, withBackup).key, itemAt(plan, journal).key]);
  assert.deepEqual(result.deleted.map((entry) => entry.path).sort(), [withBackup, journal].sort());
  for (const kept of [uncoveredBackup, legacy, captures, spool, unknown, unfinished]) assert.ok((await fs.lstat(kept)).isDirectory());
});

test('外来库保留的升级前备份按同样的规则：升级完成满 7 天（取最晚的时间）才可以连同它一起删；3→4 的旧备份一律保留它', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_current']);
  await seed(fixture.alpha, ['conversation_before_upgrade']);
  await downgradeToEpoch4(fixture.alpha.binding);
  const upgraded = await migratePreviousRuntimeEpochIfRequired(fixture.alpha.authority);
  assert.equal(upgraded.migrated, true);
  fixture.alpha.binding = upgraded.binding;
  // An exact copy of alpha kept in its scope's archives: identical, and it keeps alpha's upgrade backup.
  const twin = await copyAsArchive(fixture.alpha, fixture.alpha.scopeRoot, archiveName(1));
  const retired = await copyAsArchive(fixture.alpha, fixture.alpha.scopeRoot, archiveName(2));
  const retiredBackup = path.join(retired, 'epoch-migration-backups', path.basename(upgraded.backupPath));
  const completionFile = path.join(retiredBackup, RUNTIME_EPOCH_MIGRATION_COMPLETION_FILE);
  const completion = JSON.parse(await fs.readFile(completionFile, 'utf8'));
  await fs.writeFile(completionFile, JSON.stringify({ ...completion, toEpoch: 4 }));
  const database = await openCurrent(t, fixture);
  const backupName = path.basename(upgraded.backupPath);

  const fresh = itemAt(await planRuntimeBackupCleanup(fixture.root, database), twin);
  assert.deepEqual([fresh.deletable, fresh.reason.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/, 'T')], [false,
    `它保留的升级前备份 ${backupName}：升级完成不满 7 天，T 之后才可以删除，整份保留`]);
  // A clock that went back: the completion lies ahead of now, so no time of it is trusted.
  const skewed = itemAt(await planRuntimeBackupCleanup(fixture.root, database, { now: () => Date.now() - DAY }), twin);
  assert.deepEqual([skewed.deletable, skewed.reason], [false, `它保留的升级前备份 ${backupName}：升级完成的时间晚于现在，时间不可信，整份保留`]);
  const later = await planRuntimeBackupCleanup(fixture.root, database, { now: () => Date.now() + 8 * DAY });
  assert.equal(itemAt(later, twin).reason,
    `可以删除：内容已完整在历史库（${fixture.alpha.id}）里（与它身份相同、内容完全相同；它保留的 1 份备份也都在那里）`);
  assert.equal(itemAt(later, retired).reason, `它保留的升级前备份 ${backupName}：旧版本 3→4 升级留下的备份，整份保留`);
  const result = await deleteRuntimeBackups(later, database, [itemAt(later, twin).key], { now: () => Date.now() + 8 * DAY });
  assert.deepEqual(result.deleted.map((entry) => entry.path), [twin], JSON.stringify(result));
});

test('上一个数据目录里的归档与旁边的拷来目录：给出上一个数据目录时一起核对，内容都在当前库里时可删；旧目录里的其它内容不动', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  const previous = path.join(fixture.base, 'OldLimCode');
  await fs.mkdir(previous);
  await fs.writeFile(path.join(previous, 'settings.json'), '{"theme":"dark"}');
  const archived = await copyAsArchive(fixture.current, previous, archiveName(1));
  const copiedBeside = `${previous}.limcode-copied-2026-09-03T01-02-03-004Z-abcdef01`;
  await fs.cp(controlRoot(fixture.current), path.join(copiedBeside, '.limcode-runtime'), { recursive: true });
  const database = await openCurrent(t, fixture);
  const without = await planRuntimeBackupCleanup(fixture.root, database);
  assert.equal(without.items.some((entry) => entry.path === archived), false, '没有给出上一个数据目录时不看它');
  const plan = await planRuntimeBackupCleanup(fixture.root, database, { previousDataRootPath: previous });
  assert.equal(plan.previousDataRootPath, previous);
  const item = itemAt(plan, archived);
  const besideItem = itemAt(plan, path.join(copiedBeside, '.limcode-runtime'));
  assert.deepEqual([item.origin, item.deletable], ['上一个数据目录里的归档', true], item.reason);
  assert.deepEqual([besideItem.origin, besideItem.deletable], ['上一个数据目录旁的拷来目录里的库', true], besideItem.reason);
  const before = await treeState(previous, [archived]);
  const result = await deleteRuntimeBackups(plan, database, [item.key, besideItem.key]);
  assert.deepEqual(result.deleted.map((entry) => entry.path).sort(), [archived, path.join(copiedBeside, '.limcode-runtime')].sort());
  assert.deepEqual(result.copiedDirectoriesWithoutDataSets, [{ name: path.basename(copiedBeside), path: copiedBeside }]);
  assert.deepEqual(await treeState(previous, [archived]), before);
  assert.ok((await fs.lstat(copiedBeside)).isDirectory(), '拷来目录本身不删');
});

test('锁内复核：列出之后外来库有变化、证明它的历史库有改动、当前库删掉了其中的对话时都不删；改名之后才删掉的对话让它改回原名', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one', 'conversation_two']);
  await seed(fixture.alpha, ['conversation_alpha']);
  const touched = await copyAsArchive(fixture.current, fixture.root, archiveName(1));
  const renamedBack = await copyAsArchive(fixture.current, fixture.root, archiveName(2));
  const refusedFirst = await copyAsArchive(fixture.current, fixture.root, archiveName(3));
  const twin = await copyAsArchive(fixture.alpha, fixture.alpha.scopeRoot, archiveName(4));
  const twinChangedLate = await copyAsArchive(fixture.alpha, fixture.alpha.scopeRoot, archiveName(5));
  const twinOfReset = await copyAsArchive(fixture.alpha, fixture.alpha.scopeRoot, archiveName(6));
  const database = await openCurrent(t, fixture);
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  for (const directory of [touched, renamedBack, refusedFirst, twin, twinChangedLate, twinOfReset]) {
    assert.equal(itemAt(plan, directory).deletable, true, itemAt(plan, directory).reason);
  }

  // Alpha changes between the rename and the last check (a write of another window takes no claim).
  const alphaDatabase = fixture.alpha.binding.paths.databasePath;
  const lateChange = await deleteRuntimeBackups(plan, database, [itemAt(plan, twinChangedLate).key], {
    onFaultPoint(point) {
      if (point === 'after-rename') rawEditFile(alphaDatabase, (edit) => edit.prepare("UPDATE conversation SET title = 'renamed' WHERE id = ?").run('conversation_alpha'));
    }
  });
  assert.deepEqual(lateChange.kept.map((entry) => entry.reason), [`证明它的历史库（${fixture.alpha.id}）在检查之后有改动，请重新检查，已改回原名，保留`]);
  assert.ok((await fs.lstat(twinChangedLate)).isDirectory());

  await fs.writeFile(path.join(touched, 'active', 'diagnostics.tmp'), 'written after the check');
  await seed(fixture.alpha, ['conversation_alpha_later']);
  const changed = await deleteRuntimeBackups(plan, database, [itemAt(plan, touched).key, itemAt(plan, twin).key]);
  assert.deepEqual(changed.deleted, []);
  assert.deepEqual(changed.kept.map((entry) => entry.reason), [
    '列出之后它有变化，请重新检查；这一项没有删除',
    `证明它的历史库（${fixture.alpha.id}）在检查之后有改动，请重新检查；这一项没有删除`
  ]);

  // Alpha was archived and reset meanwhile: the proving data set is another one now.
  await archive(fixture, fixture.alpha);
  const reset = await deleteRuntimeBackups(plan, database, [itemAt(plan, twinOfReset).key]);
  assert.deepEqual(reset.kept.map((entry) => entry.reason), ['证明它的本地库在检查之后发生了变化，请重新检查；这一项没有删除']);
  assert.ok((await fs.lstat(twinOfReset)).isDirectory());

  // The conversation goes between the rename and the last check (deleting one takes no claim).
  const late = await deleteRuntimeBackups(plan, database, [itemAt(plan, renamedBack).key], {
    async onFaultPoint(point) {
      if (point === 'after-rename') await database.transaction([repo('Conversation').delete('conversation_two')]);
    }
  });
  assert.deepEqual(late.kept.map((entry) => entry.reason), ['当前库刚刚少了 1 个它有的对话，已改回原名，保留']);
  assert.ok((await fs.lstat(renamedBack)).isDirectory());
  assert.equal((await fs.readdir(path.dirname(renamedBack))).some((name) => name.includes('.deleting-')), false);

  // Already gone when the deletion begins: refused before any rename.
  const early = await deleteRuntimeBackups(plan, database, [itemAt(plan, refusedFirst).key], {
    onFaultPoint(point) { assert.notEqual(point, 'after-rename', '没有改名'); }
  });
  assert.deepEqual(early.kept.map((entry) => entry.reason), ['含 1 个当前库没有的对话（可能是你删掉的），按历史保留；这一项没有删除']);
  assert.ok((await fs.lstat(refusedFirst)).isDirectory());
});

test('核对期间它被换成了另一个库（身份变了）：已取的声明不是它的，这次不删', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['conversation_one']);
  await seed(fixture.alpha, ['conversation_one']);
  const archived = await copyAsArchive(fixture.current, fixture.root, archiveName(1));
  const replacement = path.join(fixture.base, 'replacement');
  await fs.cp(controlRoot(fixture.alpha), replacement, { recursive: true });
  const database = await openCurrent(t, fixture);
  let swapped = false;
  const plan = await planRuntimeBackupCleanup(fixture.root, database, {
    onProgress(message) {
      // Discovery named it with its old identity; the swap happens right before it is checked.
      if (!swapped && message.includes(path.basename(archived))) {
        swapped = true;
        fsSync.renameSync(archived, `${replacement}-old`);
        fsSync.renameSync(replacement, archived);
      }
    }
  });
  assert.equal(swapped, true);
  const item = itemAt(plan, archived);
  assert.deepEqual([item.deletable, item.reason], [false, '核对期间它发生了变化，这次不能删除，稍后再检查']);
});

// ---------------------------------------------------------------------------------------------
// Fixtures

async function createFixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-backup-cleanup-foreign-')));
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
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  return { id, scopeRoot, authority, binding };
}

async function openCurrent(t, fixture) {
  const database = await kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `window-${randomUUID()}` });
  t.after(() => database.close().catch(() => undefined));
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

/** Conversations with two messages each; ids are fixed, so seeding the same id elsewhere gives the same history ids. */
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

async function deleteConversation(dataSet, conversationId) {
  const runtime = await kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `delete-${randomUUID()}` });
  try { await runtime.transaction([repo('Conversation').delete(conversationId)]); }
  finally { await runtime.close(); }
}

/** An active Turn left by a window that went away: unfinished work of whatever copy is taken now. */
async function seedActiveTurn(dataSet, conversationId) {
  const runtime = await kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `seed-${randomUUID()}` });
  try {
    await runtime.transaction([repo('Turn').insert({
      id: `${conversationId}_unfinished_turn`, conversation_id: conversationId, status: 'active', created_at: NOW, updated_at: NOW, terminal_at: null
    })]);
  } finally { await runtime.close(); }
}

/** A real reset archive (archiveCurrentRuntimeRootForReset); the scope gets a fresh empty data set. */
async function archive(fixture, dataSet) {
  const authority = new RootAuthority(() => dataSet.binding.paths.dataRootPath, undefined, () => fixture.root);
  const archived = await archiveCurrentRuntimeRootForReset(authority, dataSet.scopeRoot);
  assert.equal(archived.archived, true);
  Object.assign(dataSet, await initialize(dataSet.scopeRoot, dataSet.id));
  return archived.backupPath;
}

/** A closed data set's whole control root copied into the archives directory of `scopeRoot` (as if restored by hand). */
async function copyAsArchive(dataSet, scopeRoot, name) {
  const target = path.join(scopeRoot, '.limcode-runtime-backups', name);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(controlRoot(dataSet), target, { recursive: true });
  return target;
}

/** A pre-merge backup of a closed data set (Backup API copy beside its binding) inside a copied control root. */
async function backupInto(unit, dataSet, name) {
  const directory = path.join(unit, 'merge-backups', name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'root-binding.json'), `${JSON.stringify(dataSet.binding, null, 2)}\n`);
  const live = new Database(dataSet.binding.paths.databasePath, { readonly: true, fileMustExist: true });
  try { await live.backup(path.join(directory, 'limcode.sqlite')); }
  finally { live.close(); }
  return directory;
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

const USER_CONTENT_BYTES = 3 + 8 + 7;
/** What a copied data directory keeps besides its data sets: settings, global rules and skills. */
async function writeUserContent(directory) {
  await fs.mkdir(path.join(directory, 'settings'), { recursive: true });
  await fs.writeFile(path.join(directory, 'settings', 'settings.json'), '{} ');
  await fs.writeFile(path.join(directory, 'AGENTS.md'), '# 规则');
  await fs.mkdir(path.join(directory, 'skills', 'demo'), { recursive: true });
  await fs.writeFile(path.join(directory, 'skills', 'demo', 'SKILL.md'), '# skill');
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

function claimPath(root, id) {
  return path.join(root, '.limcode-runtime-merges', 'foreign-claims', id.replace(/:/g, '-'));
}

function itemAt(plan, directory) {
  const item = plan.items.find((entry) => entry.path === directory);
  assert.ok(item, `没有列出 ${directory}：${plan.items.map((entry) => entry.path).join(', ')}`);
  return item;
}

async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Every entry below `root` but the excluded ones: type, size, times and content. */
async function treeState(root, exclude = []) {
  const skipped = new Set(exclude.map((entry) => path.resolve(entry)));
  const result = {};
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (skipped.has(file)) continue;
      const stat = await fs.lstat(file, { bigint: true });
      const key = path.relative(root, file);
      if (entry.isDirectory()) { result[key] = `dir:${stat.ino}`; await visit(file); }
      else result[key] = `file:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`;
    }
  }
  await visit(root);
  return result;
}

async function fileStates(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const stat = await fs.lstat(file, { bigint: true });
      result[path.relative(root, file)] = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
      if (entry.isDirectory()) await visit(file);
    }
  }
  await visit(root);
  return result;
}

const TWO_PATH_CALLS = new Set(['copyFile', 'rename', 'link', 'symlink', 'cp', 'copyFileSync', 'renameSync', 'linkSync', 'symlinkSync', 'cpSync']);
const WRITES_FIRST = new Set(['mkdir', 'mkdtemp', 'writeFile', 'appendFile', 'rm', 'rmdir', 'unlink', 'truncate', 'utimes', 'lutimes', 'chmod', 'lchmod', 'chown', 'lchown', 'rename']);
const WRITES_SECOND = new Set(['copyFile', 'cp', 'link', 'symlink', 'rename']);
/** A call that creates, changes or removes something at `call.path`. */
function writes(call) {
  const name = call.name.replace(/Sync$/, '');
  return (call.index === 0 && WRITES_FIRST.has(name)) || (call.index === 1 && WRITES_SECOND.has(name))
    || (name === 'open' && call.index === 0 && /[wa+]/.test(String(call.flags ?? 'r')));
}

/** Records every path handed to node:fs (promises and sync) until stopped. */
function probeFilesystem() {
  const seen = [];
  const restore = [];
  const wrap = (module, name) => {
    const original = module[name];
    module[name] = function (...args) {
      for (const [index, arg] of args.slice(0, TWO_PATH_CALLS.has(name) ? 2 : 1).entries()) {
        if (typeof arg === 'string' || arg instanceof URL) {
          seen.push({ name, index, path: path.resolve(arg instanceof URL ? arg.pathname : arg), ...(name.startsWith('open') ? { flags: args[1] } : {}) });
        }
      }
      return original.apply(this, args);
    };
    restore.push(() => { module[name] = original; });
  };
  for (const name of Object.keys(fsp)) if (typeof fsp[name] === 'function') wrap(fsp, name);
  for (const name of Object.keys(fsSync)) {
    if (typeof fsSync[name] === 'function' && /^[a-z]/.test(name) && name !== 'promises') wrap(fsSync, name);
  }
  return { seen, stop() { for (const undo of restore.reverse()) undo(); } };
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

/** Another process holding a claim until stopped. */
async function holdInChild(claim, target) {
  const script = path.join(HERE, 'runtime-backup-cleanup-child.mjs');
  const child = spawn(process.execPath, [script, 'hold-claim', claim, target], {
    env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled }, stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`holder did not start: ${stderr}`)); }, 30_000);
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('held')) { clearTimeout(timer); resolve(); } });
    child.on('exit', () => { clearTimeout(timer); reject(new Error(`holder exited: ${stderr}`)); });
  });
  return {
    async stop() {
      child.stdin.end('release\n');
      const timer = setTimeout(() => child.kill('SIGTERM'), 10_000);
      await exited;
      clearTimeout(timer);
    }
  };
}
