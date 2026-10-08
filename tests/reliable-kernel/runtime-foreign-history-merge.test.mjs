import { registerPendingHistory } from './fixtures/runtime-merge-fixture.mjs';
// Merging verified foreign history roots (runtimeForeignHistoryMerge) into the current data set, only on
// the user's request: copied data directories and reset archives, small (online), medium (exclusive
// coordination) and large (streamed large-merge session). The foreign root is only read (fs probe, byte
// for byte tree state, never a hard link), identity rules, unfinished work, changes during the merge,
// its claim against a concurrent cleanup, an interrupted commit, disk space and links inside its CAS.
// Runs against the compiled extension.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compiled, createConfigurationRoot, Database, generateSyntheticSource, kernel, kernelFile, ledgerEntries, MESSAGE_TYPE, NOW,
  readLedgerRecord, repo, seedConversations, seedRichSource, withRuntime
} from './fixtures/runtime-merge-fixture.mjs';
import { openFullRuntime } from './runtime-dataset-merge-full-runtime.mjs';

const require = createRequire(import.meta.url);
const fsp = require('node:fs/promises');
const fsSync = require('node:fs');
const foreign = kernelFile('runtimeForeignHistory.js');
const foreignMerge = kernelFile('runtimeForeignHistoryMerge.js');
const { HISTORICAL_MERGE_ENGINE: engine, mergeHistoricalDataSetsOnline, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE } = kernelFile('runtimeDataSetMerge.js');
const { prepareLargeMergeSources, runLargeMergeSession } = kernelFile('runtimeDataSetStreamedMerge.js');
const { withRuntimeDataRootAdmission, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const { openRuntimeDataSetHistory } = kernelFile('runtimeDataSetHistory.js');
const { deleteRuntimeBackups, planRuntimeBackupCleanup } = kernelFile('runtimeBackupCleanup.js');
const { ConversationDeletionControlPlane } = kernelFile('conversationDeletion.js');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { resolveVscodeRuntimeMergeLedgerRoot } = kernelFile('vscodeRootAuthority.js');
import { archiveLegacyRuntimeRoot as archiveCurrentRuntimeRootForReset, createFixture, initialize } from './runtime-data-root-relocation-fixture.mjs';

/** Injected bounds: the large source is above the in-memory bound and spans many chunks. */
const SMALL_LIMITS = { sizeLimits: { transactionRows: 50 }, chunkRows: 7 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TWO_PATH_CALLS = new Set(['copyFile', 'rename', 'link', 'symlink', 'cp', 'copyFileSync', 'renameSync', 'linkSync', 'symlinkSync', 'cpSync']);
const WRITES_FIRST = new Set(['mkdir', 'mkdtemp', 'writeFile', 'appendFile', 'rm', 'rmdir', 'unlink', 'truncate', 'utimes', 'lutimes', 'chmod', 'lchmod', 'chown', 'lchown', 'rename']);
const WRITES_SECOND = new Set(['copyFile', 'cp', 'link', 'symlink', 'rename']);
/** A call that creates, changes or removes something at `call.path`. */
const writes = (call) => {
  const name = call.name.replace(/Sync$/, '');
  return (call.index === 0 && WRITES_FIRST.has(name)) || (call.index === 1 && WRITES_SECOND.has(name))
    || (name === 'open' && call.index === 0 && /[wa+]/.test(String(call.flags ?? 'r')));
};

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

const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

/** Every entry below `root`: type, inode, size, times and content; any new file, sidecar or rewrite changes it. */
async function treeState(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      const stat = await fs.lstat(file, { bigint: true });
      const key = path.relative(root, file);
      if (entry.isDirectory()) { result[key] = `dir:${stat.ino}:${stat.mtimeNs}`; await visit(file); }
      else if (entry.isSymbolicLink()) result[key] = `link:${stat.ino}:${await fs.readlink(file)}`;
      else result[key] = `file:${stat.ino}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`;
    }
  }
  await visit(root);
  return result;
}

/** A directory holding the current configuration root (the fixed root selected, workspace data set alpha). */
async function home(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-foreign-merge-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { ...await createConfigurationRoot({ tmp: base }), base };
}

let copies = 0;
/**
 * A LimCode data directory made elsewhere (its records name that place; `from` reuses one), copied
 * beside the current configuration root under the name a data-root relocation gives a copied directory.
 */
async function copiedDirectory(fixture, seed, { from } = {}) {
  const elsewhere = from ?? await createConfigurationRoot({ tmp: fixture.base });
  if (!from) await seed?.(elsewhere);
  copies += 1;
  const container = path.join(fixture.base,
    `${path.basename(fixture.root)}.limcode-copied-2026-09-28T01-02-03-004Z-${copies.toString(16).padStart(8, '0')}`);
  await fs.cp(elsewhere.root, container, { recursive: true });
  return { elsewhere, container };
}

/** The foreign entry discovery finds in `containerPath` (a copied directory's `scope`; null: any, as for an archive) with its located root. */
async function found(fixture, containerPath, scope = 'default') {
  const entries = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: fixture.root });
  const entry = entries.find((item) => item.location.containerPath === containerPath && (scope === null || item.scope === scope) && !item.archiveName);
  assert.ok(entry, `发现 ${containerPath}：${JSON.stringify(entries.map((item) => [item.location.containerPath, item.scope]))}`);
  const root = await foreign.locateForeignRuntimeRoot(fixture.root, entry.location);
  return { ...entry, root, databasePath: root.located.databasePath, label: `外来历史库（${entry.name}）` };
}

/** A reset archive of a data set of the current configuration root (its scope gets a fresh root). */
async function archive(fixture, dataSet) {
  const authority = new RootAuthority(() => dataSet.binding.paths.dataRootPath, undefined, () => fixture.root);
  const archived = await archiveCurrentRuntimeRootForReset(authority, dataSet.scopeRoot);
  assert.equal(archived.archived, true);
  return archived.backupPath;
}

async function request(fixture, source) {
  await registerPendingHistory(fixture.paths, {
    id: source.id, location: source.location, label: source.label,
    expectedDataSetId: source.root.recorded.dataSetId, expectedRootInstanceId: source.root.recorded.rootInstanceId
  });
}

function openWindow(fixture) {
  return kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `window-${randomUUID()}` });
}

/**
 * The user's merge of `sources` in a window (`open`: this window's Runtime, else one opened for it),
 * each request recorded first (none named: a startup batch).
 */
async function merge(fixture, sources, options = {}, open) {
  for (const source of sources ?? []) await request(fixture, source);
  const database = open ?? await openWindow(fixture);
  try {
    return await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database }, {
      ...(sources ? { candidateIds: sources.map((source) => source.id), requested: true } : {}), ...options
    });
  } finally { if (!open) await database.close(); }
}

/** The large-merge session as its caller runs it: prepared online, then run with the window's Runtime closed. */
async function mergeStreamed(fixture, candidateIds, { beforeSession } = {}) {
  const database = await openWindow(fixture);
  let preparation;
  try {
    preparation = await prepareLargeMergeSources({
      paths: fixture.paths, target: { configurationRootPath: fixture.root, database }, candidateIds, requested: true, options: SMALL_LIMITS
    });
  } finally { await database.close(); }
  await beforeSession?.(preparation);
  const session = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => runLargeMergeSession({ paths: fixture.paths, prepared: preparation })));
  return { preparation, session };
}

function query(databasePath, sql, ...parameters) {
  const database = new Database(databasePath, { readonly: true });
  try { return database.prepare(sql).pluck().all(...parameters); } finally { database.close(); }
}

const conversations = (fixture) => query(fixture.current.binding.paths.databasePath, 'SELECT id FROM conversation ORDER BY id');
const ledgerPath = (fixture, section, id) => path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), section, `${id.replace(/:/g, '-')}${section === 'foreign-claims' ? '' : '.json'}`);

async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** The foreign root's files as readable history (a private copy under its claim), never the root itself. */
async function readForeign(fixture, source) {
  const reader = await openRuntimeDataSetHistory(fixture.paths, await foreign.locateForeignRuntimeRoot(fixture.root, source.location));
  try { return (await reader.listConversations()).items.map((item) => item.id).sort(); } finally { await reader.close(); }
}

test('拷来目录里的外来库在线合并进当前库：只经 located 读、原位置从不访问，正文只复制不硬链接，外来目录一字节不变，账本与声明只在当前配置根；再合并提示没有新内容', async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.current, [{ id: 'current_1' }]);
  const { elsewhere, container } = await copiedDirectory(fixture, (source) => seedRichSource(source.current, 'far', 3));
  const source = await found(fixture, container);
  assert.notEqual(source.root.recorded.paths.dataRootPath, source.root.located.dataRootPath, 'recorded 与 located 不同');
  const before = await treeState(container);
  const original = await treeState(elsewhere.root);

  const probe = probeFilesystem();
  let report;
  try { report = await merge(fixture, [source]); } finally { probe.stop(); }
  assert.deepEqual([report.deferred, report.blocked, report.failures], [[], [], []]);
  assert.deepEqual(report.merged.map((item) => [item.candidateId, item.label, item.insertedConversations, item.linkedCasObjects, item.alreadyMerged]),
    [[source.id, source.label, 3, 0, undefined]]);
  assert.ok(report.merged[0].copiedCasObjects > 0, '正文文件复制进当前库');
  assert.deepEqual(conversations(fixture), ['current_1', 'far_conversation_0', 'far_conversation_1', 'far_conversation_2']);

  assert.deepEqual(probe.seen.filter((call) => inside(elsewhere.root, call.path)), [], '原件所在的 recorded 位置从不被访问');
  assert.deepEqual(probe.seen.filter((call) => writes(call) && inside(container, call.path)), [], '外来目录里不新建、不改写、不删除任何东西');
  assert.deepEqual(probe.seen.filter((call) => call.name.startsWith('link') && inside(container, call.path)), [], '从不硬链接外来目录里的文件');
  assert.ok(probe.seen.some((call) => call.name === 'open' && call.index === 0 && call.path === source.databasePath && typeof call.flags === 'number'),
    '快照从 located 数据库的描述符读出（按描述符打开）');
  assert.deepEqual(await treeState(container), before, '外来目录逐字节、逐 inode 不变（链接数与 ctime 也不变）');
  assert.deepEqual(await treeState(elsewhere.root), original);
  const object = query(fixture.current.binding.paths.databasePath, 'SELECT storage_key FROM content_object ORDER BY id')
    .find((key) => fsSync.existsSync(path.join(source.root.located.casRootPath, ...key.split('/'))));
  const [targetObject, foreignObject] = await Promise.all([
    fs.stat(path.join(fixture.current.binding.paths.casRootPath, ...object.split('/'))),
    fs.stat(path.join(source.root.located.casRootPath, ...object.split('/')))
  ]);
  assert.notEqual(targetObject.ino, foreignObject.ino, '当前库里的正文是独立的文件');

  const record = await readLedgerRecord(fixture, source.id);
  assert.deepEqual([record.state, record.candidateId, record.source.dataSetId, record.target.dataSetId],
    ['merged', source.id, source.root.recorded.dataSetId, fixture.current.binding.dataSetId]);
  assert.ok(await exists(ledgerPath(fixture, 'fingerprints', source.id)), '指纹缓存记在当前配置根');
  assert.deepEqual(await ledgerEntries(fixture, 'pending'), [], '请求在合并后移除');
  assert.deepEqual(await fs.readdir(path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'foreign-claims')).catch(() => []), [], '声明用完即释放');

  const { entries } = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root });
  const states = await foreignMerge.readForeignRuntimeHistoryMergeStates(fixture.paths, entries);
  const state = states.get(source.id);
  assert.deepEqual([state?.state, state?.intoCurrent, state?.changedSinceMerge], ['merged', true, false], '列表显示已合并');
  assert.ok(Date.parse(state.mergedAt) > 0);

  const again = await merge(fixture, [source]);
  assert.deepEqual(again.merged.map((item) => [item.candidateId, item.alreadyMerged, item.label, item.insertedRows]), [[source.id, true, source.label, 0]],
    '合并过、之后没变化：提示没有新内容');
  assert.deepEqual(await treeState(container), before);
});

test('小、中、大三种规模的外来库各合并一次：小的在线，中等的经独占协调，大的进入大库会话（会话里显示可读名称）；合并后两次打开当前库，Provider 调用都为 0', { timeout: 300_000 }, async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.current, [{ id: 'current_1' }]);
  const small = await copiedDirectory(fixture, (source) => seedConversations(source.current, [{ id: 'small_1' }, { id: 'small_2' }]));
  const smallSource = await found(fixture, small.container);
  await seedRichSource(fixture.alpha, 'medium', 3);
  const archivePath = await archive(fixture, fixture.alpha);
  const mediumSource = await found(fixture, archivePath, null);
  assert.equal(mediumSource.location.kind, 'archive');
  const large = await copiedDirectory(fixture, (source) => generateSyntheticSource(source.current, { rows: 300, prefix: 'large' }));
  const largeSource = await found(fixture, large.container);
  const trees = [await treeState(small.container), await treeState(archivePath), await treeState(large.container)];

  const smallReport = await merge(fixture, [smallSource]);
  assert.deepEqual(smallReport.merged.map((item) => [item.candidateId, item.insertedConversations, item.exclusive]), [[smallSource.id, 2, undefined]]);

  const coordinated = [];
  const mediumReport = await merge(fixture, [mediumSource], {
    limits: { maxRows: 10, maxBytes: 1024 * 1024 * 1024 },
    async coordinateOversized(input, run) { coordinated.push(input.candidateId); await input.withLocks(run); return { state: 'completed' }; }
  });
  assert.deepEqual(coordinated, [mediumSource.id], '超过在线上限的外来库走现有独占协调');
  assert.deepEqual(mediumReport.merged.map((item) => [item.candidateId, item.insertedConversations, item.exclusive, item.label]),
    [[mediumSource.id, 3, true, mediumSource.label]]);

  const largeReport = await merge(fixture, [largeSource], { sizeLimits: SMALL_LIMITS.sizeLimits });
  assert.deepEqual(largeReport.deferred.map((issue) => [issue.candidateId, issue.code, issue.label]),
    [[largeSource.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE, largeSource.label]]);
  assert.equal(await readLedgerRecord(fixture, largeSource.id), undefined, '等待大库会话不写账本');
  const { preparation, session } = await mergeStreamed(fixture, [largeSource.id]);
  assert.deepEqual(preparation.sources.map((item) => [item.candidateId, item.label, item.runtimeDataRootPath]),
    [[largeSource.id, largeSource.label, largeSource.root.located.dataRootPath]]);
  assert.deepEqual(session.results.map((result) => [result.candidateId, result.state, result.result?.exclusive, result.result?.linkedCasObjects]),
    [[largeSource.id, 'merged', true, 0]]);
  assert.equal((await readLedgerRecord(fixture, largeSource.id)).state, 'merged');
  assert.equal(query(fixture.current.binding.paths.databasePath, "SELECT COUNT(*) FROM conversation WHERE id LIKE 'large_%'")[0], 5);
  assert.deepEqual([await treeState(small.container), await treeState(archivePath), await treeState(large.container)], trees, '三份外来库都一字节不变');
  assert.deepEqual(await fs.readdir(path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'foreign-claims')).catch(() => []), []);

  // Opened twice as a fully composed window: nothing merged from a foreign root runs again.
  const settingsRoot = path.join(fixture.base, 'settings');
  for (const round of ['first', 'second']) {
    const opened = await openFullRuntime({ authority: fixture.current.authority, settingsRoot, hostLabel: `foreign-${round}`, async send() {
      throw new Error('no model call may happen after a merge');
    } });
    try {
      const recovery = await opened.startupRecovery();
      await sleep(1_500);
      await opened.runner.waitForIdle();
      assert.deepEqual(opened.calls, [], `${round} 次打开没有 Provider 调用`);
      assert.deepEqual(recovery.runnerReport.resumedTurnIds, []);
    } finally { await opened.close(); }
  }
  assert.deepEqual(query(fixture.current.binding.paths.databasePath, "SELECT COUNT(*) FROM turn WHERE status = 'active'"), [0]);
});

test('以前的数据目录里的归档（迁移后留在旧目录，globalStatus 记下的历次旧目录）同样可以合并：严格定位 side=previous 的位置，旧目录一字节不变', async (t) => {
  const fixture = await home(t);
  const older = await createConfigurationRoot({ tmp: fixture.base });
  await seedConversations(older.alpha, [{ id: 'older_1' }, { id: 'older_2' }]);
  const archivePath = await archive(older, older.alpha);
  const before = await treeState(older.root);
  const entries = await foreign.discoverForeignRuntimeHistory({ configurationRootPath: fixture.root, previousDataRootPaths: [older.root] });
  const entry = entries.find((item) => item.location.containerPath === archivePath);
  assert.deepEqual([entry?.location.kind, entry?.location.side, entry?.location.baseDataRootPath], ['archive', 'previous', older.root]);
  const root = await foreign.locateForeignRuntimeRoot(fixture.root, entry.location);
  const source = { ...entry, root, databasePath: root.located.databasePath, label: `外来历史库（归档（以前的数据目录里） · ${entry.name}）` };
  const report = await merge(fixture, [source]);
  assert.deepEqual(report.merged.map((item) => [item.candidateId, item.insertedConversations, item.label]), [[source.id, 2, source.label]]);
  assert.deepEqual(conversations(fixture), ['older_1', 'older_2']);
  assert.deepEqual(await treeState(older.root), before, '旧目录一字节不变');
});

test('身份：与本地库身份相同的旧拷贝拒绝并写明原因；两份同身份的外来库先合并的成功、没分叉的没有新内容、已分叉的只剔除冲突对话；在当前库删掉的对话不会被另一份拷贝插回', async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.current, [{ id: 'current_1' }]);
  await seedConversations(fixture.alpha, [{ id: 'alpha_1' }]);
  // The current data directory copied beside itself: an old copy of the current data set and of alpha.
  const self = await copiedDirectory(fixture, undefined, { from: fixture });
  const oldCurrent = await found(fixture, self.container);
  const oldAlpha = await found(fixture, self.container, fixture.alpha.id);
  const refused = await merge(fixture, [oldCurrent, oldAlpha]);
  assert.deepEqual([refused.merged, refused.deferred, refused.failures], [[], [], []]);
  const blocked = new Map(refused.blocked.map((issue) => [issue.candidateId, issue]));
  assert.deepEqual([...blocked.values()].map((issue) => issue.code), ['runtime-data-set-merge-foreign-old-copy', 'runtime-data-set-merge-foreign-old-copy']);
  assert.match(blocked.get(oldCurrent.id).message, /这个外来历史库是当前历史库的旧拷贝/);
  // By a readable name (the project names a picker read, else the kind of history), never its internal id.
  assert.match(blocked.get(oldAlpha.id).message, /这个外来历史库是历史库“旧工作区历史”的旧拷贝/);
  assert.ok(!blocked.get(oldAlpha.id).message.includes(fixture.alpha.id), '原因里不写内部 id');
  assert.match(blocked.get(oldAlpha.id).message, /已保留在“未能合并的旧数据”中，不会自动删除，可以只读查看/);
  assert.equal(blocked.get(oldAlpha.id).label, oldAlpha.label);
  assert.deepEqual(conversations(fixture), ['current_1']);
  assert.equal((await readLedgerRecord(fixture, oldAlpha.id)).state, 'blocked', '拒绝按确切状态记在当前配置根');

  // Four copies of one data set made elsewhere: three identical, the fourth taken after a change there.
  const { elsewhere, container: first } = await copiedDirectory(fixture, (source) => seedConversations(source.current, [{ id: 'far_1' }, { id: 'far_2' }]));
  const identical = (await copiedDirectory(fixture, undefined, { from: elsewhere })).container;
  const later = (await copiedDirectory(fixture, undefined, { from: elsewhere })).container;
  await withRuntime(elsewhere.current, (runtime) => runtime.transaction([repo('Conversation').update('far_1', { title: '在别处改过', updated_at: '2026-09-27T00:00:00.000Z' })]));
  await seedConversations(elsewhere.current, [{ id: 'far_3' }]);
  const diverged = (await copiedDirectory(fixture, undefined, { from: elsewhere })).container;
  const [f1, f2, f3, f4] = await Promise.all([first, identical, later, diverged].map((container) => found(fixture, container)));
  assert.ok(new Set([f1, f2, f3, f4].map((source) => source.id)).size === 4, '四份各有自己的 id');
  assert.ok([f2, f3, f4].every((source) => source.root.recorded.dataSetId === f1.root.recorded.dataSetId
    && source.root.recorded.rootInstanceId === f1.root.recorded.rootInstanceId), '身份相同');

  const firstMerge = await merge(fixture, [f1]);
  assert.deepEqual(firstMerge.merged.map((item) => [item.candidateId, item.insertedConversations]), [[f1.id, 2]]);
  const nothingNew = await merge(fixture, [f2]);
  assert.deepEqual(nothingNew.merged.map((item) => [item.candidateId, item.alreadyMerged, item.insertedRows]), [[f2.id, true, 0]], '没分叉的另一份：没有新内容');
  const conflict = await merge(fixture, [f4]);
  assert.deepEqual([conflict.blocked, conflict.deferred, conflict.failures], [[], [], []]);
  assert.deepEqual(conflict.merged.map(item => [item.candidateId, item.insertedConversations]), [[f4.id, 1]], '非冲突的新对话正常合并');
  const partial = await readLedgerRecord(fixture, f4.id);
  assert.equal(partial.state, 'partial');
  assert.deepEqual(partial.excluded.map(item => [item.conversationId, item.code]), [['far_1', 'runtime-data-set-merge-conflict']]);
  assert.deepEqual(conflict.merged[0].excluded, partial.excluded);
  assert.deepEqual(query(fixture.current.binding.paths.databasePath, "SELECT title FROM conversation WHERE id = 'far_1'"), ['far_1'], '当前库没有改动');

  // The user deletes a conversation the first copy brought in; the third copy never merged leaves it out.
  const database = await openWindow(fixture);
  try { await new ConversationDeletionControlPlane(database).delete('far_2'); } finally { await database.close(); }
  const afterDelete = await merge(fixture, [f3]);
  assert.deepEqual(afterDelete.merged.map((item) => [item.candidateId, item.skippedConversations, item.alreadyMerged]), [[f3.id, 1, true]]);
  assert.deepEqual(conversations(fixture), ['current_1', 'far_1', 'far_3'], '删掉的对话没有被同一个库的另一份拷贝插回');
});

test('有中断任务或排队消息的外来库：剔除忙碌对话并合并正常对话，来源不收尾不改写，账本与列表保留部分合并清单', async (t) => {
  const fixture = await home(t);
  const { container } = await copiedDirectory(fixture, async (source) => {
    await seedConversations(source.current, [{ id: 'busy_1' }, { id: 'ready_1' }]);
    await withRuntime(source.current, async (runtime, store) => {
      const text = await store.ingest(runtime, JSON.stringify({ role: 'user', parts: [{ text: '排队中的消息' }] }), MESSAGE_TYPE);
      await runtime.transaction([
        repo('Turn').insert({ id: 'busy_1_open_turn', conversation_id: 'busy_1', status: 'active', created_at: NOW, updated_at: NOW, terminal_at: null }),
        repo('TurnIntent').insert({ id: 'busy_1_intent', conversation_id: 'busy_1', turn_id: null, state: 'queued', created_at: NOW, updated_at: NOW }),
        repo('TurnIntentRevision').insert({ id: 'busy_1_intent_revision', intent_id: 'busy_1_intent', revision_seq: 1n, content_object_id: text.id, created_at: NOW })
      ]);
    });
  });
  const source = await found(fixture, container);
  const before = await treeState(container);
  const report = await merge(fixture, [source]);
  assert.deepEqual([report.blocked, report.deferred, report.failures], [[], [], []]);
  assert.deepEqual(report.merged.map(item => [item.candidateId, item.insertedConversations]), [[source.id, 1]]);
  const partial = await readLedgerRecord(fixture, source.id);
  assert.equal(partial.state, 'partial');
  assert.deepEqual(partial.excluded.map(item => [item.conversationId, item.code]), [['busy_1', 'runtime-data-set-merge-unfinished-work']]);
  assert.deepEqual(report.merged[0].excluded, partial.excluded);
  assert.equal(report.merged[0].finalized, undefined, '外来来源不收尾');
  assert.deepEqual(conversations(fixture), ['ready_1']);
  assert.deepEqual(query(fixture.current.binding.paths.databasePath, "SELECT id FROM turn_intent"), [], '忙碌对话的排队消息不导入');
  assert.deepEqual(await treeState(container), before, '没有收尾、没有来源备份，外来目录不变');
  assert.deepEqual(await readForeign(fixture, source), ['busy_1', 'ready_1'], '原库仍可只读查看');
  const { entries } = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root });
  const state = (await foreignMerge.readForeignRuntimeHistoryMergeStates(fixture.paths, entries)).get(source.id);
  assert.equal(state?.state, 'partial');
  assert.deepEqual(state?.excluded, partial.excluded);
});

test('合并期间外来库被改动：提交前在声明内复核发现文件状态变化就推迟，不写 committing、当前库不变；没变化后再合并成功；大库会话同样', async (t) => {
  const fixture = await home(t);
  const { container } = await copiedDirectory(fixture, (source) => seedConversations(source.current, [{ id: 'moving_1' }]));
  const source = await found(fixture, container);
  const touch = (at) => fs.utimes(source.databasePath, at, at);
  let points = [];
  const changed = await merge(fixture, [source], {
    async onFaultPoint(point) {
      points.push(point);
      if (point === 'after-target-backup') await touch(new Date('2026-09-27T12:00:00Z'));
    }
  });
  assert.ok(points.includes('after-cas-transfer') && !points.includes('before-row-commit'), `复核在提交之前：${points}`);
  assert.deepEqual(changed.deferred.map((issue) => [issue.candidateId, issue.code, issue.label]),
    [[source.id, 'runtime-data-set-merge-source-changed', source.label]]);
  assert.match(changed.deferred[0].message, /外来历史库在核验之后又有变化/);
  assert.equal(await readLedgerRecord(fixture, source.id), undefined, '没有写 committing，也没有记录');
  assert.deepEqual(await ledgerEntries(fixture, 'commits'), []);
  assert.deepEqual(conversations(fixture), []);
  assert.equal((await ledgerEntries(fixture, 'pending')).length, 1, '请求保留，以后再试');
  const settled = await merge(fixture, [source]);
  assert.deepEqual(settled.merged.map((item) => [item.candidateId, item.insertedConversations]), [[source.id, 1]]);

  // Its pointer's exact state is part of what was verified, even when the identity it names stays the same.
  const pointerMoved = await copiedDirectory(fixture, (other) => seedConversations(other.current, [{ id: 'pointer_1' }]));
  const pointerSource = await found(fixture, pointerMoved.container);
  const byPointer = await merge(fixture, [pointerSource], {
    async onFaultPoint(point) {
      if (point === 'after-target-backup') {
        await fs.utimes(pointerSource.root.located.rootPointerPath, new Date('2026-09-27T12:30:00Z'), new Date('2026-09-27T12:30:00Z'));
      }
    }
  });
  assert.deepEqual(byPointer.deferred.map((issue) => [issue.candidateId, issue.code]), [[pointerSource.id, 'runtime-data-set-merge-source-changed']],
    '指针文件的确切状态变了同样推迟');
  assert.equal(await readLedgerRecord(fixture, pointerSource.id), undefined);

  const large = await copiedDirectory(fixture, (big) => generateSyntheticSource(big.current, { rows: 200, prefix: 'moving' }));
  const largeSource = await found(fixture, large.container);
  await merge(fixture, [largeSource], { sizeLimits: SMALL_LIMITS.sizeLimits });
  const { session } = await mergeStreamed(fixture, [largeSource.id], {
    beforeSession: () => fs.utimes(largeSource.databasePath, new Date('2026-09-27T13:00:00Z'), new Date('2026-09-27T13:00:00Z'))
  });
  assert.deepEqual(session.results.map((result) => [result.state, result.issue?.code, result.issue?.label]),
    [['deferred', 'runtime-data-set-merge-source-changed', largeSource.label]]);
  assert.equal(await readLedgerRecord(fixture, largeSource.id), undefined, '会话里同样不写 committing');
  assert.equal(query(fixture.current.binding.paths.databasePath, "SELECT COUNT(*) FROM conversation WHERE id LIKE 'moving_0%'")[0], 0);
});

test('外来已合并来源：没有本来源成功账本不删，声明被占保留，释放后才能删除', async t=>{
  const fixture=await home(t);
  const {elsewhere,container:first}=await copiedDirectory(fixture,source=>seedConversations(source.current,[{id:'kept_1'}]));
  const second=(await copiedDirectory(fixture,undefined,{from:elsewhere})).container;
  const source=await found(fixture,first);
  await merge(fixture,[source]);
  const database=await openWindow(fixture);t.after(()=>database.close());
  const plan=await planRuntimeBackupCleanup(fixture.root,database);
  const item=plan.items.find(i=>i.path===path.join(first,'.limcode-runtime'));
  assert.equal(item.deletable,true,item.reason);
  assert.equal(plan.items.find(i=>i.path===path.join(second,'.limcode-runtime')).deletable,false,'同内容的另一份未合并来源不能仅凭覆盖删除');
  const root=await foreign.locateForeignRuntimeRoot(fixture.root,source.location);
  let release,entered;const ready=new Promise(r=>entered=r),hold=new Promise(r=>release=r);
  const holding=foreign.tryWithForeignRuntimeRootClaim(fixture.root,source.id,root.located.rootPointerPath,async()=>{entered();await hold;});
  await ready;
  try{const kept=await deleteRuntimeBackups(plan,database,[item.key]);assert.equal(kept.deleted.length,0);assert.ok(await exists(root.located.databasePath));}
  finally{release();await holding;}
  const deleted=await deleteRuntimeBackups(plan,database,[item.key]);assert.equal(deleted.deleted.length,1,JSON.stringify(deleted));
  assert.deepEqual(conversations(fixture),['kept_1']);
});

test('提交后中断：committing 记在当前配置根、以外来 id 为键，不影响这份归档的核验；下次合并按实测收敛为已合并', async (t) => {
  const fixture = await home(t);
  await seedConversations(fixture.alpha, [{ id: 'crash_1' }, { id: 'crash_2' }]);
  const archivePath = await archive(fixture, fixture.alpha);
  const source = await found(fixture, archivePath, null);
  const before = await treeState(archivePath);
  const crashed = await merge(fixture, [source], {
    onFaultPoint(point) { if (point === 'after-row-commit') throw Object.assign(new Error('simulated crash after the commit'), { code: 'EIO' }); }
  });
  assert.deepEqual(crashed.deferred.map((issue) => [issue.candidateId, issue.code]), [[source.id, 'EIO']]);
  const committing = await readLedgerRecord(fixture, source.id);
  assert.deepEqual([committing.state, committing.candidateId], ['committing', source.id]);
  assert.deepEqual(conversations(fixture), ['crash_1', 'crash_2'], '事务已提交');
  // The archive belongs to this data directory, so its own ledger is this one: a committing merge out of a
  // foreign root only ever read it and does not make it unverifiable.
  const { entries } = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root });
  const entry = entries.find((item) => item.id === source.id);
  assert.equal(entry?.status, 'verified', entry?.reason);
  const converged = await merge(fixture, [source]);
  assert.deepEqual(converged.merged.map((item) => [item.candidateId, item.recoveredCommit, item.insertedConversations]), [[source.id, true, 2]]);
  assert.equal((await readLedgerRecord(fixture, source.id)).state, 'merged');
  assert.deepEqual(await ledgerEntries(fixture, 'commits'), []);
  assert.deepEqual(conversations(fixture), ['crash_1', 'crash_2']);
  assert.deepEqual(await treeState(archivePath), before);
});

test('正文复制前先查空间：当前库所在的盘放不下外来库缺的正文时推迟，一个文件也不复制、不提交', async (t) => {
  const fixture = await home(t);
  const { container } = await copiedDirectory(fixture, (source) => seedRichSource(source.current, 'roomy', 2));
  const source = await found(fixture, container);
  const targetCas = fixture.current.binding.paths.casRootPath;
  const casBefore = await treeState(targetCas);
  const asked = [];
  const report = await merge(fixture, [source], {
    async freeSpace(directory) { asked.push(directory); return directory === targetCas ? 1024 : undefined; }
  });
  assert.ok(asked.includes(targetCas));
  assert.deepEqual(report.deferred.map((issue) => [issue.candidateId, issue.code]), [[source.id, 'runtime-data-set-merge-disk-full']]);
  assert.match(report.deferred[0].message, /磁盘空间不足，需要约 \d+ MB：外来历史库的正文文件要复制进当前库/);
  assert.deepEqual(await treeState(targetCas), casBefore, '一个正文文件也没有复制');
  assert.deepEqual(conversations(fixture), []);
  assert.equal(await readLedgerRecord(fixture, source.id), undefined);
});

test('外来库正文目录里的符号链接不跟随：缺正文对话剔除并保留残留，链接目标与外来目录不变', async (t) => {
  const fixture = await home(t);
  const { container } = await copiedDirectory(fixture, (source) => seedConversations(source.current, [{ id: 'linked_1' }]));
  const source = await found(fixture, container);
  const sha256Root = path.join(source.root.located.casRootPath, 'sha256');
  const [prefix] = (await fs.readdir(sha256Root)).sort();
  const moved = path.join(fixture.base, 'objects-elsewhere');
  await fs.rename(path.join(sha256Root, prefix), moved);
  await fs.symlink(moved, path.join(sha256Root, prefix), 'dir');
  const before = await treeState(container);
  const movedBefore = await treeState(moved);
  const report = await merge(fixture, [source]);
  assert.deepEqual([report.blocked, report.deferred, report.failures], [[], [], []]);
  assert.deepEqual(report.merged.map(item => [item.candidateId, item.insertedConversations, item.copiedCasObjects]), [[source.id, 0, 0]]);
  const partial = await readLedgerRecord(fixture, source.id);
  assert.equal(partial.state, 'partial');
  assert.deepEqual(partial.excluded.map(item => [item.conversationId, item.code]), [['linked_1', 'runtime-data-set-merge-source-cas-invalid']]);
  const { readRuntimeHistoryResidual } = kernelFile('runtimeHistoryRegistry.js');
  assert.deepEqual((await readRuntimeHistoryResidual(fixture.paths)).get(source.id)?.excluded, partial.excluded);
  assert.deepEqual(conversations(fixture), []);
  assert.deepEqual(await treeState(container), before);
  assert.deepEqual(await treeState(moved), movedBefore);
});

test('纵深防护：在配置准入内取外来库的声明直接拒绝（锁序是外来声明在前）；外来来源从不收尾，审计只按收尾口径查未结束的工作', async (t) => {
  const fixture = await home(t);
  const { container } = await copiedDirectory(fixture, (source) => seedConversations(source.current, [{ id: 'guarded_1' }]));
  const source = await found(fixture, container);
  await assert.rejects(withRuntimeDataRootAdmission(fixture.root,
    () => foreign.holdForeignRuntimeRootClaim(fixture.paths, source.id, source.root.located.rootPointerPath)),
  /claimed before the configuration admission, never inside it/);
  const hold = await foreign.holdForeignRuntimeRootClaim(fixture.paths, source.id, source.root.located.rootPointerPath);
  assert.equal(hold.held, true);
  await hold.release();
  assert.equal(hold.held, false);
  const candidate = { kind: 'foreign', id: source.id, label: source.label, root: source.root };
  await assert.rejects(engine.finalizeSource(fixture.paths, {}, candidate, {}, {}, {}, {}, {}), /A foreign history root is never finalized\./);
  await assert.rejects(engine.takeVerifiedSnapshot(candidate, {}, 'carry', {}, {}), /A foreign history root is audited for unfinished work\./);
});


test('新重置备份仅在残留明确重试后按登记位置合并', async (t) => {
  const fixture = await createFixture(t, { withAlpha: false });
  const reset = require(path.join(compiled, 'backend/application/reliableKernel/VscodeReliableKernelCutoverCoordinator.js'));
  const result = await reset.archiveCurrentRuntimeRootForReset(fixture.current.authority, fixture.root);
  fixture.current = await initialize(fixture.root, 'default');
  assert.deepEqual(await foreign.discoverForeignRuntimeHistory({ configurationRootPath: fixture.root }), []);
  const registry = kernelFile('runtimeHistoryRegistry.js');
  const residual = [...(await registry.readRuntimeHistoryResidual(fixture.paths)).values()].find(item => item.location.containerPath === result.backupPath);
  const located = await foreign.locateForeignRuntimeRoot(fixture.root, residual.location);
  await registry.writeRuntimeHistoryPending(fixture.paths, { id: residual.id, sourceKind: 'reset', location: residual.location,
    identity: { dataSetId: located.recorded.dataSetId, rootInstanceId: located.recorded.rootInstanceId },
    registeredAt: NOW, reason: '用户在残留列表里选择重新合并' });
  const report = await merge(fixture, undefined, { candidateIds: [residual.id] });
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.blocked, []);
  assert.equal(report.merged[0]?.candidateId, residual.id, JSON.stringify(report));
});

test('后台外来核验取消等待worker退出并清理私有副本之后释放声明', async (t) => {
  const fixture = await createFixture(t);
  const backup = await archive(fixture, fixture.alpha);
  const source = await found(fixture, backup, fixture.alpha.id);
  const controller = new AbortController();
  const reason = new Error('后台核验达到本次时限');
  const hold = await foreignMerge.holdForeignHistoricalMergeSource(fixture.paths, source.id,
    { location: source.location, label: source.label }, { signal: controller.signal });
  const candidate = await hold.locate();
  let snapshotPath;
  try {
    await assert.rejects(hold.snapshot(candidate, { beforeOpen: async (file) => {
      snapshotPath = file;
      const audit = kernelFile('runtimeSnapshotAudit.js').auditRuntimeSnapshot(file,
        { binding: candidate.root.recorded }, { signal: controller.signal });
      controller.abort(reason);
      await audit;
    } }), error => error === reason);
    assert.equal(hold.held, true, '核验结束后仍由调用方负责释放声明');
    await assert.rejects(fs.stat(snapshotPath), { code: 'ENOENT' }, 'worker退出后私有副本已清理');
  } finally { await hold.release(); }
  assert.equal(hold.held, false);
});
