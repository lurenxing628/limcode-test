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
const { keepLargeMergeResult, largeMergeBatchResult, largeMergeDetails, largeMergeOperationKey, takeLargeMergeResult } = kernelFile('runtimeLargeMergeSession.js');
const { largeMergeEngine } = kernelFile('runtimeLargeMergeEngine.js');
const { withRuntimeDataRootAdmission, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const { openRuntimeDataSetHistory } = kernelFile('runtimeDataSetHistory.js');
const { deleteRuntimeBackups, planRuntimeBackupCleanup } = kernelFile('runtimeBackupCleanup.js');
const { ConversationDeletionControlPlane } = kernelFile('conversationDeletion.js');
const { RootAuthority } = kernelFile('rootAuthority.js');
const { resolveVscodeRuntimeMergeLedgerRoot } = kernelFile('vscodeRootAuthority.js');
const { archiveCurrentRuntimeRootForReset } = require(path.join(
  compiled, 'backend/application/reliableKernel/VscodeReliableKernelCutoverCoordinator.js'
));

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
  await foreignMerge.requestForeignRuntimeHistoryMerge(fixture.paths, {
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
  assert.ok(probe.seen.some((call) => call.name === 'copyFile' && call.index === 0 && call.path === source.databasePath), '快照复制自 located 数据库');
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
  assert.deepEqual(await ledgerEntries(fixture, 'requests'), [], '请求在合并后移除');
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
  const [detail] = largeMergeDetails(preparation.sources, session.results);
  assert.ok(detail.startsWith(`${largeSource.label}（${largeSource.root.located.dataRootPath}，`), `会话详情用可读名称：${detail}`);
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

test('大库会话的真实接线（largeMergeEngine 适配层）合并外来大库：先只读估计（只经它的声明读、估计完就释放，不写账本、不碰外来目录，正文按全部复制计空间，用可读名称），同意之后再准备（指纹与估计相同，操作键一致）；准备结果与详情用可读名称，会话合并成功、正文只复制，外来目录不变、声明释放', { timeout: 300_000 }, async (t) => {
  const fixture = await home(t);
  // Above the online bound: the adapter takes it into the session (its threshold is the online bound).
  const big = await copiedDirectory(fixture, (source) => generateSyntheticSource(source.current, { rows: 4_200, prefix: 'wired' }));
  const source = await found(fixture, big.container);
  const before = await treeState(big.container);
  await request(fixture, source);
  const adapter = largeMergeEngine();
  const claims = () => fs.readdir(path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'foreign-claims')).catch(() => []);
  const database = await openWindow(fixture);
  let estimated;
  let preparation;
  try {
    // Read-only first, as the session asks before the prompt or the confirmation.
    estimated = await adapter.estimate({
      paths: fixture.paths, target: { configurationRootPath: fixture.root, database }, candidateIds: [source.id], requested: true
    });
    assert.deepEqual(estimated.sources.map((item) => [item.candidateId, item.label]), [[source.id, source.label]], '估计也用可读名称');
    assert.ok(estimated.preparing.expectedMs > 0 && estimated.duration.expectedMs > 0);
    assert.deepEqual(await claims(), [], '估计完就释放声明');
    assert.deepEqual(await treeState(big.container), before, '估计不碰外来目录');
    assert.equal(await readLedgerRecord(fixture, source.id), undefined, '估计不写账本');
    assert.deepEqual(await ledgerEntries(fixture, 'preparing'), []);
    // Agreed: prepared now (under its claim until the session or the release).
    preparation = await adapter.prepare({
      paths: fixture.paths, target: { configurationRootPath: fixture.root, database }, candidateIds: estimated.sources.map((item) => item.candidateId), requested: true
    });
  } finally { await database.close(); }
  // A foreign root is never finalized: the same fingerprint, the same coordination key before the countdown and in the session.
  assert.deepEqual(preparation.sources.map((item) => item.fingerprint), estimated.sources.map((item) => item.fingerprint));
  assert.equal(largeMergeOperationKey(fixture.current.binding, estimated.sources), largeMergeOperationKey(fixture.current.binding, preparation.sources));
  // Its content objects are counted as copied into the target (never linked): the estimate's figure has them, the online backup too.
  assert.ok(estimated.space.targetBytes > preparation.space.targetBytes, JSON.stringify([estimated.space, preparation.space]));
  assert.deepEqual(preparation.sources.map((item) => [item.candidateId, item.label]), [[source.id, source.label]], '外来来源的名称透传到会话');
  assert.ok(largeMergeDetails(preparation.sources, [])[0].startsWith(`${source.label}（`));
  const outcomes = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => adapter.run({ paths: fixture.paths, target: { configurationRootPath: fixture.root, binding: fixture.current.binding }, preparation })));
  assert.deepEqual(outcomes.map((item) => [item.candidateId, item.state, item.result?.linkedCasObjects, item.result?.label]), [[source.id, 'merged', 0, source.label]],
    '会话的结果也带可读名称（合并通知据此附上清理备份的提示）');
  assert.equal(query(fixture.current.binding.paths.databasePath, "SELECT COUNT(*) FROM conversation WHERE id LIKE 'wired_%'")[0], 67);
  assert.equal((await readLedgerRecord(fixture, source.id)).state, 'merged');
  assert.deepEqual(await treeState(big.container), before, '外来目录一字节不变');
  assert.deepEqual(await fs.readdir(path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'foreign-claims')).catch(() => []), [], '声明已释放');
});

test('大库会话的真实接线：外来大库在会话里才受阻（准备之后当前库另写了它的一条记录）：会话结果、批结果与重载后保留的结果都带可读名称，原因列表不写 id；当前库只有另写的那一条', { timeout: 300_000 }, async (t) => {
  const fixture = await home(t);
  const big = await copiedDirectory(fixture, (source) => generateSyntheticSource(source.current, { rows: 4_200, prefix: 'clash' }));
  const source = await found(fixture, big.container);
  await request(fixture, source);
  const adapter = largeMergeEngine();
  const database = await openWindow(fixture);
  let preparation;
  try {
    preparation = await adapter.prepare({
      paths: fixture.paths, target: { configurationRootPath: fixture.root, database }, candidateIds: [source.id], requested: true
    });
    // After the preparation compared it: this window writes a different version of one of its conversations.
    await database.transaction([repo('Conversation').insert({ id: 'clash_0000000', title: '在当前库另写的', status: 'active', created_at: NOW, updated_at: NOW })]);
  } finally { await database.close(); }
  assert.deepEqual(preparation.sources.map((item) => item.candidateId), [source.id]);
  const outcomes = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => adapter.run({ paths: fixture.paths, target: { configurationRootPath: fixture.root, binding: fixture.current.binding }, preparation })));
  assert.deepEqual(outcomes.map((item) => [item.candidateId, item.state, item.code, item.label]),
    [[source.id, 'blocked', 'runtime-data-set-merge-conflict', source.label]], '会话结果带外来来源的可读名称');
  // As the session tells it after the reload (runtimeDataSetManagement's reasons list names an issue by its label).
  const report = largeMergeBatchResult(outcomes, true);
  assert.deepEqual(report.blocked.map((issue) => [issue.candidateId, issue.label, issue.requested]), [[source.id, source.label, true]]);
  const values = new Map();
  const state = { get: (key) => values.get(key), update: async (key, value) => { values.set(key, value); } };
  await keepLargeMergeResult(state, { configurationRootPath: fixture.root, requested: true, report, details: largeMergeDetails(preparation.sources, outcomes) });
  const kept = takeLargeMergeResult(state, Date.now());
  assert.deepEqual(kept.report.blocked.map((issue) => `${issue.label ?? issue.candidateId}\n[${issue.code}]`), [`${source.label}\n[runtime-data-set-merge-conflict]`]);
  assert.ok(kept.details[0].startsWith(`${source.label}（`));
  assert.deepEqual(query(fixture.current.binding.paths.databasePath, "SELECT title FROM conversation WHERE id LIKE 'clash_%'"), ['在当前库另写的'], '整份回滚');

  // A source that never started (the session was cancelled before it) has no issue: named by its preparation.
  const other = await found(fixture, (await copiedDirectory(fixture, (copy) => generateSyntheticSource(copy.current, { rows: 4_200, prefix: 'later' }))).container);
  await request(fixture, other);
  const window = await openWindow(fixture);
  let second;
  try {
    second = await adapter.prepare({ paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window }, candidateIds: [other.id], requested: true });
  } finally { await window.close(); }
  const cancelled = new AbortController();
  cancelled.abort();
  const notRun = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => adapter.run({ paths: fixture.paths, target: { configurationRootPath: fixture.root, binding: fixture.current.binding }, preparation: second, signal: cancelled.signal })));
  assert.deepEqual(notRun.map((item) => [item.candidateId, item.state, item.code, item.label]),
    [[other.id, 'deferred', 'runtime-data-set-merge-cancelled', other.label]]);
  assert.deepEqual(largeMergeBatchResult(notRun, true).deferred.map((issue) => issue.label), [other.label]);
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

test('身份：与本地库身份相同的旧拷贝拒绝并写明原因；两份同身份的外来库先合并的成功、没分叉的没有新内容、已分叉的按冲突拒绝；在当前库删掉的对话不会被另一份拷贝插回', async (t) => {
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
  assert.match(blocked.get(oldAlpha.id).message, new RegExp(`这个外来历史库是历史库 ${fixture.alpha.id}的旧拷贝`));
  assert.match(blocked.get(oldAlpha.id).message, /可以在“清理备份”里按覆盖核对后删除/);
  assert.equal(blocked.get(oldAlpha.id).label, oldAlpha.label);
  assert.deepEqual(conversations(fixture), ['current_1']);
  assert.equal((await readLedgerRecord(fixture, oldAlpha.id)).state, 'blocked', '拒绝按确切状态记在当前配置根');

  // Four copies of one data set made elsewhere: three identical, the fourth taken after a change there.
  const { elsewhere, container: first } = await copiedDirectory(fixture, (source) => seedConversations(source.current, [{ id: 'far_1' }, { id: 'far_2' }]));
  const identical = (await copiedDirectory(fixture, undefined, { from: elsewhere })).container;
  const later = (await copiedDirectory(fixture, undefined, { from: elsewhere })).container;
  await withRuntime(elsewhere.current, (runtime) => runtime.transaction([repo('Conversation').update('far_1', { title: '在别处改过', updated_at: '2026-09-27T00:00:00.000Z' })]));
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
  assert.deepEqual([conflict.merged, conflict.blocked.map((issue) => [issue.candidateId, issue.code])],
    [[], [[f4.id, 'runtime-data-set-merge-conflict']]], '已分叉的后一份按冲突拒绝');
  assert.match(conflict.blocked[0].message, /同一个库的另一份拷贝先合并进来之后，这一份又有了不同的改动/);
  assert.deepEqual(query(fixture.current.binding.paths.databasePath, "SELECT title FROM conversation WHERE id = 'far_1'"), ['far_1'], '当前库没有改动');

  // The user deletes a conversation the first copy brought in; the third copy never merged leaves it out.
  const database = await openWindow(fixture);
  try { await new ConversationDeletionControlPlane(database).delete('far_2'); } finally { await database.close(); }
  const afterDelete = await merge(fixture, [f3]);
  assert.deepEqual(afterDelete.merged.map((item) => [item.candidateId, item.skippedConversations, item.alreadyMerged]), [[f3.id, 1, true]]);
  assert.deepEqual(conversations(fixture), ['current_1', 'far_1'], '删掉的对话没有被同一个库的另一份拷贝插回');
});

test('有中断任务或排队消息的外来库：记为 blocked 并写明原因，不收尾、不备份、不写入它，仍可只读查看；列表显示原因', async (t) => {
  const fixture = await home(t);
  const { container } = await copiedDirectory(fixture, async (source) => {
    await seedConversations(source.current, [{ id: 'busy_1' }]);
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
  assert.deepEqual([report.merged, report.deferred, report.failures], [[], [], []]);
  assert.deepEqual(report.blocked.map((issue) => [issue.candidateId, issue.code]), [[source.id, 'runtime-data-set-merge-foreign-unfinished-work']]);
  assert.match(report.blocked[0].message, /1 个中断的任务、1 条排队未发送的消息/);
  assert.match(report.blocked[0].message, /当前版本不在它的目录里收尾/);
  assert.match(report.blocked[0].message, /只读查看/);
  assert.deepEqual(conversations(fixture), []);
  assert.deepEqual(await treeState(container), before, '没有收尾、没有备份，外来目录不变');
  assert.equal((await readLedgerRecord(fixture, source.id)).state, 'blocked');
  assert.deepEqual(await readForeign(fixture, source), ['busy_1'], '仍可只读查看');
  const { entries } = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root });
  const state = (await foreignMerge.readForeignRuntimeHistoryMergeStates(fixture.paths, entries)).get(source.id);
  assert.deepEqual([state?.state, state?.code], ['blocked', 'runtime-data-set-merge-foreign-unfinished-work']);
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
  assert.equal((await ledgerEntries(fixture, 'requests')).length, 1, '请求保留，以后再试');
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

test('与清理备份并发（真实的清理流程，同一个外来声明）：合并持有时清理不等待、保留这一份并说明原因；清理先持有并删掉它时合并等它结束、说明已不在、什么也不写；合并之后清理能按覆盖核对删除它', async (t) => {
  const fixture = await home(t);
  const { elsewhere, container: first } = await copiedDirectory(fixture, (source) => seedConversations(source.current, [{ id: 'kept_1' }, { id: 'kept_2' }]));
  const second = (await copiedDirectory(fixture, undefined, { from: elsewhere })).container;
  const third = (await copiedDirectory(fixture, undefined, { from: elsewhere })).container;
  const [f1, f2, f3] = await Promise.all([first, second, third].map((container) => found(fixture, container)));
  assert.deepEqual((await merge(fixture, [f1])).merged.map((item) => [item.candidateId, item.insertedConversations]), [[f1.id, 2]]);
  const unit = (container) => path.join(container, '.limcode-runtime');
  const database = await openWindow(fixture);
  t.after(() => database.close().catch(() => undefined));
  const itemAt = (plan, directory) => {
    const item = plan.items.find((entry) => entry.path === directory);
    assert.ok(item, `没有列出 ${directory}：${plan.items.map((entry) => entry.path).join(', ')}`);
    return item;
  };

  // The merge of the second copy holds its claim (paused right after its private snapshot was copied).
  const plan = await planRuntimeBackupCleanup(fixture.root, database);
  const covered = itemAt(plan, unit(second));
  assert.equal(covered.deletable, true, covered.reason);
  let resume;
  const paused = new Promise((resolve) => { resume = resolve; });
  let reached;
  const atSnapshot = new Promise((resolve) => { reached = resolve; });
  // One window merges and cleans up (its Runtime is the cleanup's current data set).
  const merging = merge(fixture, [f2], { async onFaultPoint(point) { if (point === 'after-snapshot-copy') { reached(); await paused; } } }, database);
  await atSnapshot;
  try {
    const started = Date.now();
    const kept = await deleteRuntimeBackups(plan, database, [covered.key]);
    assert.ok(Date.now() - started < 5_000, '清理不等待合并');
    assert.deepEqual([kept.deleted, kept.kept.map((entry) => entry.reason)], [[], ['正在被另一个窗口或操作使用（只读查看、核验、合并或清理备份），这一项没有删除']]);
    assert.equal(itemAt(await planRuntimeBackupCleanup(fixture.root, database), unit(second)).deletable, false, '合并期间检查也不给删');
    assert.ok(await exists(unit(second)), '正在合并的来源没有被删');
  } finally { resume(); }
  const report = await merging;
  assert.deepEqual(report.merged.map((item) => [item.candidateId, item.alreadyMerged]), [[f2.id, true]], '同一个库的另一份：没有新内容');

  // The cleanup holds the third copy's claim (paused right before its rename): the merge waits, then finds it gone.
  const plan2 = await planRuntimeBackupCleanup(fixture.root, database);
  const doomed = itemAt(plan2, unit(third));
  assert.equal(doomed.deletable, true, doomed.reason);
  let proceed;
  const go = new Promise((resolve) => { proceed = resolve; });
  let holding;
  const holds = new Promise((resolve) => { holding = resolve; });
  const deleting = deleteRuntimeBackups(plan2, database, [doomed.key], {
    async onFaultPoint(point) { if (point === 'before-rename') { holding(); await go; } }
  });
  await holds;
  let settled = false;
  const waiting = merge(fixture, [f3], {}, database).finally(() => { settled = true; });
  try {
    await sleep(600);
    assert.equal(settled, false, '清理持有时，合并等待');
  } finally { proceed(); }
  assert.deepEqual((await deleting).deleted.map((entry) => entry.path), [unit(third)]);
  const refused = await waiting;
  assert.deepEqual([refused.merged, refused.blocked, refused.deferred.map((issue) => [issue.candidateId, issue.code])],
    [[], [], [[f3.id, 'foreign-history-gone']]]);
  assert.equal(await readLedgerRecord(fixture, f3.id), undefined, '什么也没记');
  assert.deepEqual(conversations(fixture), ['kept_1', 'kept_2']);

  // Once merged, the archive or copied root is proven by coverage and backup cleanup deletes it.
  const plan3 = await planRuntimeBackupCleanup(fixture.root, database);
  const merged = [itemAt(plan3, unit(first)), itemAt(plan3, unit(second))];
  assert.deepEqual(merged.map((item) => item.deletable), [true, true], merged.map((item) => item.reason).join(' | '));
  const removed = await deleteRuntimeBackups(plan3, database, merged.map((item) => item.key));
  assert.deepEqual(removed.deleted.map((entry) => entry.path).sort(), [unit(first), unit(second)].sort());
  assert.deepEqual(conversations(fixture), ['kept_1', 'kept_2'], '当前库的对话都在');
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

test('外来库正文目录里的符号链接不跟随：来源缺正文记为失败，链接指向的目录从不被读取，外来目录不变', async (t) => {
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
  assert.deepEqual([report.merged, report.deferred], [[], []]);
  assert.deepEqual(report.failures.map((issue) => [issue.candidateId, issue.code]), [[source.id, 'runtime-data-set-merge-source-cas-invalid']]);
  assert.deepEqual(conversations(fixture), []);
  assert.deepEqual(await treeState(container), before);
  assert.deepEqual(await treeState(moved), movedBefore);
});

test('合并请求：只收核验通过、身份与所见一致的外来库；缺位置、位置畸形或 id 不像外来库的请求记录不算请求', async (t) => {
  const fixture = await home(t);
  const { elsewhere, container } = await copiedDirectory(fixture, (source) => seedConversations(source.current, [{ id: 'asked_1' }]));
  const source = await found(fixture, container);
  await assert.rejects(foreignMerge.requestForeignRuntimeHistoryMerge(fixture.paths, {
    id: source.id, location: source.location, label: source.label, expectedDataSetId: 'another', expectedRootInstanceId: source.root.recorded.rootInstanceId
  }), { code: 'runtime-data-set-merge-identity-mismatch' });
  const pointer = source.root.located.rootPointerPath;
  const saved = await fs.readFile(pointer);
  await fs.writeFile(pointer, '{ not json');
  await assert.rejects(request(fixture, source), { code: 'foreign-history-pointer-invalid' });
  await fs.writeFile(pointer, saved);
  assert.deepEqual(await ledgerEntries(fixture, 'requests'), [], '拒绝的请求不落盘');

  const requests = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'requests');
  await fs.mkdir(requests, { recursive: true });
  const target = { dataSetId: fixture.current.binding.dataSetId, rootInstanceId: fixture.current.binding.rootInstanceId };
  const base = {
    kind: 'limcode-runtime-data-set-merge-request', expectedDataSetId: source.root.recorded.dataSetId,
    expectedRootInstanceId: source.root.recorded.rootInstanceId, target, requestedAt: new Date().toISOString()
  };
  await fs.writeFile(path.join(requests, `${source.id.replace(/:/g, '-')}.json`), JSON.stringify({ ...base, candidateId: source.id }));
  await fs.writeFile(path.join(requests, 'workspace-folder-x.json'), JSON.stringify({
    ...base, candidateId: 'workspace:folder-x', foreign: { location: source.location, label: 'x' }
  }));
  const malformed = 'foreign:copied:0123456789abcdef';
  await fs.writeFile(path.join(requests, `${malformed.replace(/:/g, '-')}.json`), JSON.stringify({
    ...base, candidateId: malformed, foreign: { location: { ...source.location, containerPath: 5 }, label: 'x' }
  }));
  const database = await openWindow(fixture);
  let report;
  try {
    report = await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database },
      { candidateIds: [source.id, 'workspace:folder-x', malformed], requested: true });
  } finally { await database.close(); }
  assert.deepEqual([report.merged, report.deferred, report.blocked, report.failures, report.pendingSources], [[], [], [], [], 0]);
  assert.deepEqual(conversations(fixture), []);
  void elsewhere;
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
