// Reset archives stay in the old data directory when it is relocated (only data sets move). The
// preflight says so; "delete the old directory" lists them by directory (also those of a scope whose
// data set was deleted, which no data-set enumeration names) and keeps them unless ticked; the old
// directory stays remembered while any archive is left; and the new directory's foreign history lists,
// verifies and reads them in place, never writing into the old directory. Runs against the compiled extension.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import {
  compiled, createFixture, deleteAsConfirmed, initialize, kernelFile, planWithRuntime, relocate, RootAuthority
} from './runtime-data-root-relocation-fixture.mjs';

const require = createRequire(import.meta.url);
const foreign = kernelFile('runtimeForeignHistory.js');
const { openRuntimeDataSetHistory } = kernelFile('runtimeDataSetHistory.js');
const { deleteUnselectedRuntimeDataSet } = kernelFile('runtimeStorageInspection.js');
const { inspectVscodeRuntimeDataSets } = kernelFile('vscodeRootAuthority.js');
const { writeRuntimeDataSetMergeLedgerRecord } = kernelFile('runtimeDataSetMergeLedger.js');
const { archiveCurrentRuntimeRootForReset } = require(path.join(
  compiled, 'backend/application/reliableKernel/VscodeReliableKernelCutoverCoordinator.js'
));

async function archiveAndReset(fixture, dataSet) {
  const authority = new RootAuthority(() => dataSet.binding.paths.dataRootPath, undefined, () => fixture.root);
  const archived = await archiveCurrentRuntimeRootForReset(authority, dataSet.scopeRoot);
  assert.equal(archived.archived, true);
  return { backupPath: archived.backupPath, archived: dataSet.binding, fresh: await initialize(dataSet.scopeRoot, dataSet.id) };
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

async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function readMessages(paths, root, conversationId) {
  const reader = await openRuntimeDataSetHistory(paths, root);
  try { return (await reader.readMessages(conversationId)).items.map((item) => item.text); }
  finally { await reader.close(); }
}

/** The new directory's view of the old one's archive: found beside nothing, in the previous directory itself. */
async function verifiedFromNewDirectory(target, previous, backupPath) {
  const found = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: target, previousDataRootPaths: [previous] });
  const discovered = found.find((entry) => entry.location.containerPath === backupPath);
  assert.ok(discovered, `新目录的外来历史库发现了旧目录里的归档：${JSON.stringify(found.map((entry) => entry.location.containerPath))}`);
  assert.equal(discovered.location.kind, 'archive');
  assert.equal(discovered.location.side, 'previous');
  assert.equal(discovered.location.baseDataRootPath, previous);
  assert.equal(discovered.location.containerName, `${path.basename(previous)}/${path.relative(previous, backupPath).split(path.sep).join('/')}`);
  const report = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: target, previousDataRootPaths: [previous] });
  const entry = report.entries.find((item) => item.location.containerPath === backupPath);
  assert.equal(entry?.status, 'verified', entry?.reason);
  assert.equal(entry.id, discovered.id);
  return entry;
}

test('foreign-archive-only-relocation：删掉本地库、只剩归档的工作区迁移后，预检说明归档留在旧目录，删除旧目录按目录列出并默认保留它，旧目录仍被记住，新目录的外来历史库原位核验并只读查看', async (t) => {
  const fixture = await createFixture(t);
  const alpha = fixture.alpha;
  const { backupPath, fresh } = await archiveAndReset(fixture, alpha);
  await deleteUnselectedRuntimeDataSet(fixture.paths, alpha.id, fresh.binding.dataSetId);
  assert.deepEqual(await fs.readdir(alpha.scopeRoot), ['.limcode-runtime-backups'], '这个工作区只剩它的归档');
  const inspection = await inspectVscodeRuntimeDataSets(fixture.paths);
  assert.deepEqual(inspection.problems, []);
  assert.ok(!inspection.candidates.some((candidate) => candidate.id === alpha.id), '只剩归档的工作区不是历史库');
  const archiveBefore = await treeState(backupPath);

  const target = path.join(fixture.base, 'new-home');
  const plan = await planWithRuntime(fixture, target);
  assert.ok(plan.warnings.some((warning) => /旧目录里有 1 份“归档并重置”留下的归档.*归档不会迁移，留在旧目录.*外来历史库.*删除旧目录时默认保留/.test(warning)),
    `预检说明归档留在旧目录：${JSON.stringify(plan.warnings)}`);
  await relocate(fixture, plan);

  const { plan: deletion, result } = await deleteAsConfirmed({ oldRootPath: fixture.root, currentRootPath: target });
  const item = deletion.items.find((entry) => entry.paths.includes(path.dirname(backupPath)));
  assert.equal(item?.key, `backup:${alpha.id}:.limcode-runtime-backups`, `删除计划按目录列出归档：${JSON.stringify(deletion.items.map((entry) => entry.key))}`);
  assert.equal(item.kind, 'backup');
  assert.equal(item.optional, true, '默认不勾选');
  assert.equal(item.deletable, true);
  assert.ok(item.bytes > 0);
  assert.match(item.label, /“归档并重置”归档/);
  assert.equal(result.remainingDataSets, 0);
  assert.equal(result.remainingArchives, 1, '删除之后旧目录里还留着这份归档');
  assert.deepEqual(await treeState(backupPath), archiveBefore, '归档默认保留，一字节不变');

  const entry = await verifiedFromNewDirectory(target, fixture.root, backupPath);
  assert.equal(entry.scope, alpha.id);
  const root = await foreign.locateForeignRuntimeRoot(target, entry.location);
  assert.deepEqual(await readMessages({ globalStoragePath: target }, root, 'conversation_alpha_1'), ['conversation_alpha_1 的正文']);
  assert.deepEqual(await treeState(backupPath), archiveBefore, '核验与查看不在旧目录里写任何东西');
  assert.ok(await exists(path.join(target, '.limcode-runtime-merges', 'foreign', `${entry.id.replace(/:/g, '-')}.json`)), '核验结果缓存在当前目录');
  assert.equal(await exists(path.join(fixture.root, '.limcode-runtime-merges', 'foreign')), false, '旧目录里不建缓存');
  assert.equal(await exists(path.join(fixture.root, '.limcode-runtime-merges', 'foreign-claims')), false, '旧目录里不建声明');
});

test('foreign-archive-only-relocation：迁走的工作区库带着归档，删除旧目录默认保留归档时剩余库为 0、剩余归档为 1；旧目录合并账本里正在提交的合并挡住核验；勾选归档后才删除，剩余归档为 0', async (t) => {
  const fixture = await createFixture(t);
  const { backupPath, archived } = await archiveAndReset(fixture, fixture.alpha);
  const target = path.join(fixture.base, 'new-home');
  const plan = await planWithRuntime(fixture, target);
  assert.ok(plan.warnings.some((warning) => /旧目录里有 1 份“归档并重置”留下的归档/.test(warning)), JSON.stringify(plan.warnings));
  await relocate(fixture, plan);
  const key = `backup:${fixture.alpha.id}:.limcode-runtime-backups`;
  const { plan: deletion, result } = await deleteAsConfirmed({ oldRootPath: fixture.root, currentRootPath: target });
  assert.equal(deletion.items.filter((entry) => entry.key === key).length, 1, '归档只列一次（由历史库本身列出）');
  assert.equal(result.remainingDataSets, 0);
  assert.equal(result.remainingArchives, 1);
  assert.ok(await exists(backupPath));
  await verifiedFromNewDirectory(target, fixture.root, backupPath);

  // An archive's merges were recorded by the data directory it belongs to: here the previous one.
  await writeRuntimeDataSetMergeLedgerRecord({ globalStoragePath: fixture.root }, {
    candidateId: 'workspace:other', state: 'committing', commitId: 'commit-1',
    target: { dataSetId: archived.dataSetId, rootInstanceId: archived.rootInstanceId },
    source: { dataSetId: 'other', rootInstanceId: 'other', rootGeneration: 1, pointerRevision: 1, contentDigest: 'x' }
  });
  const blocked = (await foreign.inspectForeignRuntimeHistory({ configurationRootPath: target, previousDataRootPaths: [fixture.root] }))
    .entries.find((entry) => entry.location.containerPath === backupPath);
  assert.equal(blocked?.status, 'failed');
  assert.equal(blocked.code, 'foreign-history-unfinished-merge');
  await fs.rm(path.join(fixture.root, '.limcode-runtime-merges'), { recursive: true, force: true });

  const { result: ticked } = await deleteAsConfirmed({ oldRootPath: fixture.root, currentRootPath: target }, [key]);
  assert.ok(ticked.removed.includes(key));
  assert.equal(ticked.remainingArchives, 0, '勾选之后归档才删除');
  assert.equal(await exists(backupPath), false);
});

test('foreign-archive-only-relocation：旧目录里读不了的归档目录（不是目录）也列在删除计划里，不可删除、写明原因，并计入剩余归档', async (t) => {
  const fixture = await createFixture(t);
  const target = path.join(fixture.base, 'new-home');
  await relocate(fixture, await planWithRuntime(fixture, target));
  const scope = path.join(fixture.root, '.limcode-workspace-runtimes', 'scopes', `folder-${'b'.repeat(64)}`);
  await fs.mkdir(scope, { recursive: true });
  await fs.writeFile(path.join(scope, '.limcode-runtime-backups'), 'not a directory');
  const { plan: deletion, result } = await deleteAsConfirmed({ oldRootPath: fixture.root, currentRootPath: target });
  const item = deletion.items.find((entry) => entry.key === `backup:workspace:folder-${'b'.repeat(64)}:.limcode-runtime-backups`);
  assert.equal(item?.deletable, false, JSON.stringify(deletion.items.map((entry) => entry.key)));
  assert.match(item.reason, /无法读取，保留/);
  assert.equal(result.remainingArchives, 1, '读不了的归档目录也算保留的归档');
  assert.ok(await exists(path.join(scope, '.limcode-runtime-backups')));
});

test('最后一轮 #5 连续迁移（A→B→C）之后，A 和 B 里的归档都列在 C 的外来历史库里；里面已经没有归档和拷来目录的旧目录判为可去掉，读不了的、盘没接上的、旁边还有拷来目录的都保留', async (t) => {
  const fixture = await createFixture(t);
  const { backupPath } = await archiveAndReset(fixture, fixture.current);
  const [a, b, c] = [fixture.root, path.join(fixture.base, 'b-home'), path.join(fixture.base, 'c-home')];
  await fs.mkdir(c, { recursive: true });
  // B was a data directory in between and keeps an archive of its own.
  const bArchive = path.join(b, '.limcode-runtime-backups', path.basename(backupPath));
  await fs.mkdir(path.dirname(bArchive), { recursive: true });
  await fs.cp(backupPath, bArchive, { recursive: true });
  const found = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: c, previousDataRootPaths: [b, a] });
  assert.deepEqual(found.filter((entry) => entry.location.side === 'previous').map((entry) => [entry.location.baseDataRootPath, entry.location.containerPath]),
    [[b, bArchive], [a, backupPath]], '两个旧目录里的归档都列出');
  const report = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: c, previousDataRootPaths: [b, a] });
  assert.equal(report.entries.find((entry) => entry.location.containerPath === backupPath)?.status, 'verified');

  const empty = path.join(fixture.base, 'empty-home');
  await fs.mkdir(path.join(empty, '.limcode-runtime-backups'), { recursive: true });
  const gone = path.join(fixture.base, 'gone-home');
  const unmounted = path.join(fixture.base, 'no-such-drive', 'limcode');
  const beside = path.join(fixture.base, 'beside-home');
  await fs.mkdir(`${beside}.limcode-copied-2026-09-02T01-02-03-004Z-12345678`);
  const locked = path.join(fixture.base, 'locked-home');
  await fs.mkdir(locked);
  const privileged = process.getuid?.() === 0;
  if (!privileged) await fs.chmod(locked, 0o000);
  t.after(() => fs.chmod(locked, 0o700).catch(() => undefined));
  const removable = await foreign.previousDataRootsWithoutForeignHistory({
    configurationRootPath: c, previousDataRootPaths: [b, a, empty, gone, unmounted, beside, locked, c]
  });
  assert.deepEqual(removable, privileged ? [empty, gone, locked] : [empty, gone], '只有确实空了的旧目录；当前目录本身不在列表里');
});
