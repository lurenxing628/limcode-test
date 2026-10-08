import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import {
  countRows, createConfigurationRoot, Database, generateSyntheticSource, kernel, kernelFile, ledgerEntries, MESSAGE_TYPE,
  modelRequestAggregate, NOW, rawWrite, readAll, readLedgerRecord, removeConfigurationRoot, repo, seedConversations, seedRichSource,
  treeSnapshot, withRuntime
} from './fixtures/runtime-merge-fixture.mjs';

const require = createRequire(import.meta.url);
const nodeFs = require('node:fs');
const nodeFsPromises = require('node:fs/promises');
const foreign = kernelFile('runtimeForeignHistory.js');
const foreignMerge = kernelFile('runtimeForeignHistoryMerge.js');
const { mergeHistoricalDataSetsOnline, requestRuntimeDataSetMerge, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE } = kernelFile('runtimeDataSetMerge.js');
const {
  estimateLargeMergeSources, prepareLargeMergeSources, releaseLargeMergePreparation, runLargeMergeSession,
  RUNTIME_DATA_SET_LARGE_MERGE_MEASURED_RATE_BOUNDS, RUNTIME_DATA_SET_LARGE_MERGE_UNMEASURED_RANGE
} = kernelFile('runtimeDataSetStreamedMerge.js');
const { largeMergeOperationKey } = kernelFile('runtimeLargeMergeSession.js');
const { withRuntimeDataRootAdmission, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const { markVscodeRuntimeDataSetKept, resolveVscodeRuntimeDataSet, resolveVscodeRuntimeMergeLedgerRoot } = kernelFile('vscodeRootAuthority.js');
const { writeRuntimeDataSetMergeLedgerRecord } = kernelFile('runtimeDataSetMergeLedger.js');
const { requireCompleteRuntimeDataSet } = kernelFile('runtimeStorageInspection.js');

/** Injected bounds: every fixture source is "large" and spans many chunks. */
const SMALL_LIMITS = { sizeLimits: { transactionRows: 50 }, chunkRows: 7 };
const LEDGER_SECTIONS = ['records', 'requests', 'preparing', 'finalizations', 'commits', 'rates'];

async function fixtureFor(t, options) {
  const fixture = await createConfigurationRoot(options);
  t.after(() => removeConfigurationRoot(fixture.root));
  return fixture;
}

function openWindow(fixture) {
  return kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `window-${randomUUID()}` });
}

async function withWindow(fixture, run) {
  const database = await openWindow(fixture);
  try { return await run(database); } finally { await database.close(); }
}

function estimate(fixture, database, input = {}) {
  return estimateLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database }, ...input, options: { ...SMALL_LIMITS, ...input.options }
  });
}

function prepare(fixture, database, input = {}) {
  return prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database }, ...input, options: { ...SMALL_LIMITS, ...input.options }
  });
}

/** Private copies taken for an audit, by label (the copy's fault point). */
function copyCounter(copies, label) {
  return { onFaultPoint: (point) => { if (point === 'after-snapshot-copy') copies.push(label); } };
}

function unmeasuredRange(ms) {
  return [Math.round(ms * RUNTIME_DATA_SET_LARGE_MERGE_UNMEASURED_RANGE.low), Math.round(ms * RUNTIME_DATA_SET_LARGE_MERGE_UNMEASURED_RANGE.high)];
}

function runSession(fixture, preparation) {
  return withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => runLargeMergeSession({ paths: fixture.paths, prepared: preparation })));
}

const rateFile = (fixture) => path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'rates', 'large-merge-session.json');

/**
 * `conversations` conversations of 63 rows each (as generateSyntheticSource writes them), every
 * message with its own content object and every conversation its own recipe: 11 objects per conversation.
 */
async function contentHeavySource(dataSet, conversations, prefix) {
  await withRuntime(dataSet, async (runtime, store) => {
    let steps = [];
    for (let c = 0; c < conversations; c += 1) {
      const id = `${prefix}_${String(c).padStart(6, '0')}`;
      const turnId = `${id}_turn`;
      const objects = await store.prepareBatch(runtime, [
        ...Array.from({ length: 10 }, (_, m) => ({ content: JSON.stringify({ role: 'user', parts: [{ text: `${id} 第 ${m} 条：${'正文'.repeat(200)}` }] }), contentType: MESSAGE_TYPE })),
        { content: JSON.stringify({ recipe: id, padding: 'r'.repeat(4000) }), contentType: 'application/json' }
      ]);
      for (const object of objects) if (object.insert) steps.push(object.insert);
      const ids = objects.map((object) => object.metadata.id);
      steps.push(
        repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
        repo('Turn').insert({ id: turnId, conversation_id: id, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
        repo('TurnTermination').insert({ id: `${id}_termination`, turn_id: turnId, terminal_status: 'completed', reason: 'fixture', created_at: NOW })
      );
      for (let m = 0; m < 10; m += 1) {
        const messageId = `${id}_m${m}`;
        steps.push(
          repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
          repo('MessageRevision').insert({ id: `${messageId}_r`, message_id: messageId, revision_seq: 1n, role: 'user', content_object_id: ids[m], created_at: NOW }),
          repo('MessageCurrentRevisionLink').insert({ id: `${messageId}_c`, message_id: messageId, revision_id: `${messageId}_r`, updated_at: NOW }),
          repo('MessagePartOfConversation').insert({ id: `${messageId}_p`, conversation_id: id, message_id: messageId, message_seq: BigInt(m + 1), created_at: NOW })
        );
      }
      for (let r = 0; r < 4; r += 1) steps.push(...modelRequestAggregate(turnId, `${id}_q${r}`, BigInt(r + 1), { recipe: ids[10], body: ids[r], checkpoints: 1, completed: true }));
      if (steps.length >= 2_000 || c === conversations - 1) {
        await runtime.transaction(steps);
        steps = [];
      }
    }
  });
}

function mergeBackups(fixture) {
  return fs.readdir(path.join(path.dirname(fixture.current.binding.paths.dataRootPath), 'merge-backups')).catch(() => []);
}

async function ledgerFacts(fixture) {
  const facts = {};
  for (const section of LEDGER_SECTIONS) facts[section] = await ledgerEntries(fixture, section);
  return facts;
}

/** Content files read (hashed) below `roots` while `run` runs: node:fs.createReadStream is what sha256File uses. */
async function hashedFiles(roots, run) {
  const original = nodeFs.createReadStream;
  const read = [];
  nodeFs.createReadStream = function patched(file, ...rest) {
    if (roots.some((root) => String(file).startsWith(root + path.sep))) read.push(String(file));
    return original.call(this, file, ...rest);
  };
  try {
    await run();
  } finally {
    nodeFs.createReadStream = original;
  }
  return read;
}

/** Every entry below `root`: type, inode, size, times and content; any new file, sidecar or rewrite changes it. */
async function treeState(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      const stat = await fs.lstat(file, { bigint: true });
      const key = path.relative(root, file);
      if (entry.isDirectory()) { result[key] = `dir:${stat.ino}:${stat.mtimeNs}`; await visit(file); }
      else result[key] = `file:${stat.ino}:${stat.nlink}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`;
    }
  }
  await visit(root);
  return result;
}

const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const WRITING_CALLS = new Set(['mkdir', 'mkdtemp', 'writeFile', 'appendFile', 'rm', 'rmdir', 'unlink', 'truncate', 'utimes', 'chmod', 'chown', 'rename', 'copyFile', 'cp', 'link', 'symlink']);

/** Every path handed to node:fs (promises and sync) until stopped, and whether the call writes there. */
function probeFilesystem() {
  const seen = [];
  const restore = [];
  const wrap = (module, name) => {
    const original = module[name];
    const base = name.replace(/Sync$/, '');
    const pathArguments = ['copyFile', 'rename', 'link', 'symlink', 'cp'].includes(base) ? 2 : 1;
    module[name] = function (...args) {
      for (const [index, arg] of args.slice(0, pathArguments).entries()) {
        if (typeof arg !== 'string' && !(arg instanceof URL)) continue;
        // The second path of a copy, link or rename is where it writes; the first of any other writing call.
        const writes = ['copyFile', 'cp', 'link', 'symlink', 'rename'].includes(base) ? index === 1 || base === 'rename'
          : WRITING_CALLS.has(base) || (base === 'open' && /[wa+]/.test(String(args[1] ?? 'r')));
        seen.push({ name, path: path.resolve(arg instanceof URL ? arg.pathname : arg), writes });
      }
      return original.apply(this, args);
    };
    restore.push(() => { module[name] = original; });
  };
  for (const name of Object.keys(nodeFsPromises)) if (typeof nodeFsPromises[name] === 'function') wrap(nodeFsPromises, name);
  for (const name of Object.keys(nodeFs)) if (typeof nodeFs[name] === 'function' && /^[a-z]/.test(name) && name !== 'promises') wrap(nodeFs, name);
  return { seen, stop() { for (const undo of restore.reverse()) undo(); } };
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

test('估计只读：不收尾、不备份、不传正文、不写账本、不占准备记录；复制核验一次后按确切文件状态缓存，之后不再复制', async (t) => {
  const fixture = await fixtureFor(t);
  await seedRichSource(fixture.alpha, 'alpha', 3);
  // Work a preparation would close first (an active Turn without a lease): the estimate leaves it alone.
  rawWrite(fixture.alpha, (source) => {
    source.prepare("INSERT INTO turn VALUES ('alpha_conversation_0_active', 'alpha_conversation_0', 'active', ?, ?, NULL)").run(NOW, NOW);
  });
  // Counted first: a read-only SQLite connection leaves its -wal and -shm behind (a new file state).
  const rows = countRows(fixture.alpha);
  const sourceBefore = await treeSnapshot(fixture.alpha.scopeRoot);
  const targetBefore = readAll(fixture.current);
  const targetCasBefore = await treeSnapshot(fixture.current.binding.paths.casRootPath);
  const copies = [];
  const [first, second] = await withWindow(fixture, async (database) => [
    await estimate(fixture, database, { options: copyCounter(copies, 'first') }),
    await estimate(fixture, database, { options: copyCounter(copies, 'second') })
  ]);
  assert.deepEqual(copies, ['first'], '只在第一次复制核验');
  for (const [result, cached] of [[first, false], [second, true]]) {
    assert.deepEqual(result.sources.map((source) => [source.candidateId, source.rows, source.cached]), [[fixture.alpha.id, rows, cached]]);
    const [source] = result.sources;
    assert.ok(source.bytes > 0 && source.databaseBytes > 0 && source.casObjects > 0, JSON.stringify(source));
    assert.equal(source.sourceDataSetId, fixture.alpha.binding.dataSetId);
    assert.ok(!path.relative(fixture.alpha.scopeRoot, source.runtimeDataRootPath).startsWith('..'), source.runtimeDataRootPath);
    assert.match(source.fingerprint, /^[0-9a-f]{64}$/);
    // The background preparation and the exclusive phase apart; the exclusive phase is also estimateMs.
    assert.ok(source.prepareEstimateMs > 0 && source.sessionEstimateMs > 0, JSON.stringify(source));
    assert.deepEqual(source.prepareEstimateRangeMs, unmeasuredRange(source.prepareEstimateMs));
    assert.deepEqual(source.sessionEstimateRangeMs, unmeasuredRange(source.sessionEstimateMs));
    assert.deepEqual([source.estimateMs, source.estimateRangeMs], [source.sessionEstimateMs, source.sessionEstimateRangeMs]);
    assert.deepEqual([result.sessionEstimateMs, result.sessionEstimateRangeMs], [source.sessionEstimateMs, source.sessionEstimateRangeMs]);
    assert.deepEqual([result.estimateMs, result.estimateRangeMs], [result.sessionEstimateMs, result.sessionEstimateRangeMs]);
    // The one online target backup of the preparation comes on top of the source's (at 200 MB/s).
    const backupMs = Math.round(result.space.targetBackupBytes / ((200 * 1024 * 1024) / 1000));
    assert.ok(backupMs > 0);
    assert.equal(result.prepareEstimateMs, source.prepareEstimateMs + backupMs);
    assert.deepEqual(result.prepareEstimateRangeMs, unmeasuredRange(result.prepareEstimateMs));
    assert.equal(result.sessionRate, undefined, '没有实测速率');
    assert.deepEqual(result.small, []);
    assert.equal(result.report.stopped, false);
    assert.deepEqual([result.report.deferred, result.report.blocked, result.report.failures], [[], [], []]);
    // The preparation's backup is still to come (target database and WAL), linked content needs no room.
    const target = fixture.current.binding.paths.databasePath;
    const targetFiles = (await fs.stat(target)).size + await fs.stat(`${target}-wal`).then((info) => info.size, () => 0);
    assert.equal(result.space.targetBackupBytes, targetFiles);
    assert.equal(result.space.casCopyBytes, 0);
    // The session's own need (every source, the largest one's WAL peak with the target's index pages it
    // rewrites, not measured before the preparation's backup: 0.65 of the target's files; a margin), plus the backup still to come.
    assert.equal(result.space.targetIndexBytes, Math.ceil(targetFiles * 0.65), JSON.stringify(result.space));
    assert.equal(result.space.targetBytes, Math.ceil(source.databaseBytes * 2.5 + result.space.targetIndexBytes + 64 * 1024 * 1024) + targetFiles,
      JSON.stringify(result.space));
    assert.equal(result.space.temporaryBytes, source.databaseBytes);
  }
  assert.deepEqual(first.sources.map(({ cached: _c, ...rest }) => rest), second.sources.map(({ cached: _c, ...rest }) => rest));
  assert.deepEqual(await treeSnapshot(fixture.alpha.scopeRoot), sourceBefore, '来源一字节不变：没有收尾、没有来源备份');
  assert.deepEqual(readAll(fixture.current), targetBefore, '当前库不变');
  assert.deepEqual(await treeSnapshot(fixture.current.binding.paths.casRootPath), targetCasBefore, '没有传正文');
  assert.deepEqual(await mergeBackups(fixture), [], '没有目标备份');
  assert.deepEqual(await ledgerFacts(fixture), Object.fromEntries(LEDGER_SECTIONS.map((section) => [section, []])), '账本与准备记录一条不写');
  assert.deepEqual(await ledgerEntries(fixture, 'audits'), [`${fixture.alpha.id.replace(/:/g, '-')}.json`], '只写审计缓存');
});

test('等待大库会话的来源：审计结果按确切文件状态缓存，之后每次启动的批次与估计都不再复制核验（随会话等待的中等来源也一样）；来源一变就重新核验', async (t) => {
  const fixture = await fixtureFor(t, { beta: true });
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await seedConversations(fixture.beta, [{ id: 'beta_medium' }]);
  const copies = [];
  // Counted before each startup: reading the source with SQLite changes its file state.
  let rows = countRows(fixture.alpha);
  const betaRows = countRows(fixture.beta);
  const startup = (label) => withWindow(fixture, async (database) => {
    // beta is above the online bound (5 rows here) and below the in-memory bound: it goes along with alpha.
    const batch = await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database }, {
      sizeLimits: SMALL_LIMITS.sizeLimits, limits: { maxRows: 5, maxBytes: 1 << 30 },
      coordinateOversized: async () => assert.fail('中等来源随大库会话等待，不单独协调'), ...copyCounter(copies, `batch-${label}`)
    });
    assert.deepEqual(batch.deferred.map((issue) => [issue.candidateId, issue.code, issue.size?.rows]).sort(), [
      [fixture.alpha.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE, rows], [fixture.beta.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE, betaRows]
    ].sort());
    const result = await estimate(fixture, database, { options: copyCounter(copies, `estimate-${label}`) });
    assert.deepEqual([result.sources.map((source) => source.candidateId), result.small], [[fixture.alpha.id], [fixture.beta.id]]);
    return result;
  });
  for (const label of [1, 2, 3]) await startup(label);
  assert.deepEqual(copies, ['batch-1', 'batch-1'], '只有第一次启动的批次各复制核验了一次');
  assert.equal(await readLedgerRecord(fixture, fixture.alpha.id), undefined, '仍然不入账');
  await seedConversations(fixture.alpha, [{ id: 'alpha_later' }]);
  rows = countRows(fixture.alpha);
  const changed = await startup(4);
  assert.deepEqual(copies, ['batch-1', 'batch-1', 'batch-4'], '文件状态变了就重新核验（只有变了的那份）');
  assert.equal(changed.sources[0].cached, true, '批次刚按新状态核验过');
  assert.equal(changed.sources[0].rows, rows);
});

test('估计的结论：阈值与分流同准备；太大、另一个窗口在准备、旧格式待升级、已合并的不算进会话，未结束工作留给准备按对话判断，也都不入账；取消时不给来源', async (t) => {
  const fixture = await fixtureFor(t, { beta: true });
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await seedConversations(fixture.beta, [{ id: 'beta_small' }]);
  const betaRows = countRows(fixture.beta);
  assert.ok(betaRows < 50 && betaRows > 5, `beta ${betaRows} 行`);
  await withWindow(fixture, async (database) => {
    const inMemory = await estimate(fixture, database);
    assert.deepEqual([inMemory.sources.map((source) => source.candidateId), inMemory.small], [[fixture.alpha.id], [fixture.beta.id]]);
    const online = await estimate(fixture, database, { threshold: 'online', options: { limits: { maxRows: 5, maxBytes: 1 << 30 } } });
    assert.deepEqual(online.sources.map((source) => source.candidateId).sort(), [fixture.alpha.id, fixture.beta.id].sort());
    assert.deepEqual(online.small, []);
    assert.equal(online.space.temporaryBytes,online.sources.reduce((sum,source)=>sum+source.databaseBytes,0),'一次确认前可能同时保留全部来源快照');
    assert.equal(online.estimateMs, online.sources.reduce((sum, source) => sum + source.estimateMs, 0));

    const tooLarge = await estimate(fixture, database, {
      candidateIds: [fixture.alpha.id], options: { sizeLimits: { transactionRows: 20, streamedRows: 40 } }
    });
    assert.deepEqual(tooLarge.sources, []);
    assert.deepEqual(tooLarge.report.blocked.map((issue) => [issue.candidateId, issue.code, issue.newly]),
      [[fixture.alpha.id, 'runtime-data-set-merge-too-large-for-one-transaction', true]]);

    const controller = new AbortController();
    controller.abort();
    const stopped = await estimate(fixture, database, { signal: controller.signal });
    assert.deepEqual([stopped.report.stopped, stopped.sources, stopped.small, stopped.estimateMs, stopped.prepareEstimateMs], [true, [], [], 0, 0]);
  });

  // Another window prepares alpha right now (a live record of a live process).
  const preparingFile = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'preparing', `${fixture.alpha.id.replace(/:/g, '-')}.json`);
  await fs.mkdir(path.dirname(preparingFile), { recursive: true });
  await fs.writeFile(preparingFile, JSON.stringify({
    kind: 'limcode-runtime-data-set-merge-preparation', candidateId: fixture.alpha.id, token: randomUUID(), processId: process.pid,
    startedAt: NOW, heartbeatAt: new Date().toISOString()
  }));
  const elsewhere = await withWindow(fixture, (database) => estimate(fixture, database));
  assert.deepEqual([elsewhere.sources, elsewhere.report.deferred.map((issue) => issue.code)], [[], ['runtime-data-set-merge-preparing-elsewhere']]);
  await fs.rm(preparingFile);

  // An interrupted commit into this target: the next startup converges it first, the estimate only says so.
  const recordFile = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'records', `${fixture.alpha.id.replace(/:/g, '-')}.json`);
  const committing = {
    kind: 'limcode-runtime-data-set-merge', candidateId: fixture.alpha.id, state: 'committing', commitId: randomUUID(), updatedAt: NOW,
    source: {
      dataSetId: fixture.alpha.binding.dataSetId, rootInstanceId: fixture.alpha.binding.rootInstanceId,
      rootGeneration: fixture.alpha.binding.rootGeneration, pointerRevision: fixture.alpha.binding.pointerRevision, contentDigest: 'interrupted'
    },
    target: { dataSetId: fixture.current.binding.dataSetId, rootInstanceId: fixture.current.binding.rootInstanceId }
  };
  await fs.mkdir(path.dirname(recordFile), { recursive: true });
  await fs.writeFile(recordFile, JSON.stringify(committing));
  const interrupted = await withWindow(fixture, (database) => estimate(fixture, database));
  assert.deepEqual([interrupted.sources, interrupted.report.deferred.map((issue) => issue.code)], [[], ['runtime-data-set-merge-commit-pending']]);
  assert.deepEqual(JSON.parse(await fs.readFile(recordFile, 'utf8')), committing, '记录原样保留');
  await fs.rm(recordFile);

  // Work that may need exclusion is judged in preparation; estimate does not reject its whole source.
  rawWrite(fixture.alpha, (source) => {
    source.prepare(`INSERT INTO process VALUES (?, 'running', 'nonce', 1, NULL, NULL, 'fp', 'digest', 'spool', 0, 0, 0, 0, ?, ?, ?)`)
      .run('alpha_running_process', NOW, NOW, NOW);
  });
  const refused = await withWindow(fixture, (database) => estimate(fixture, database));
  assert.deepEqual(refused.sources.map(source=>source.candidateId), [fixture.alpha.id]);
  assert.deepEqual(refused.report.blocked, []);

  // A published epoch-4 data set is not upgraded by an estimate.
  await downgradeToEpoch4(fixture.beta.binding);
  const epochBefore = await fs.readFile(fixture.beta.binding.paths.runtimeEpochPath, 'utf8');
  const published = await withWindow(fixture, (database) => estimate(fixture, database, { threshold: 'online', options: { limits: { maxRows: 5, maxBytes: 1 << 30 } } }));
  assert.deepEqual(published.report.deferred.map((issue) => [issue.candidateId, issue.code]), [[fixture.beta.id, 'runtime-data-set-merge-upgrade-pending']]);
  assert.equal(await fs.readFile(fixture.beta.binding.paths.runtimeEpochPath, 'utf8'), epochBefore, '没有就地升级');
  assert.deepEqual(await ledgerFacts(fixture), Object.fromEntries(LEDGER_SECTIONS.map((section) => [section, []])), '所有结论都不入账');
  assert.deepEqual(await mergeBackups(fixture), []);
});

test('已合并且没有变化的来源不算进会话；用户点的那份如实说“已合并，没有新内容”', async (t) => {
  const fixture = await fixtureFor(t);
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const database = await openWindow(fixture);
  let preparation;
  try { preparation = await prepare(fixture, database); } finally { await database.close(); }
  const session = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => runLargeMergeSession({ paths: fixture.paths, prepared: preparation })));
  assert.deepEqual(session.results.map((result) => result.state), ['merged']);
  assert.deepEqual(await ledgerEntries(fixture, 'rates'), [], '这么短的会话不记速率（固定开销占大头）');
  // A merge request of the merged source: a batch removes it, an estimate leaves it.
  await requestRuntimeDataSetMerge(fixture.paths, {
    candidateId: fixture.alpha.id, expectedDataSetId: fixture.alpha.binding.dataSetId, expectedRootInstanceId: fixture.alpha.binding.rootInstanceId
  });
  const requests = await ledgerEntries(fixture, 'requests');
  assert.equal(requests.length, 1);
  await withWindow(fixture, async (window) => {
    const automatic = await estimate(fixture, window);
    assert.deepEqual([automatic.sources, automatic.report.merged], [[], []]);
    assert.deepEqual(await ledgerEntries(fixture, 'requests'), requests, '估计不删合并请求');
    const asked = await estimate(fixture, window, { candidateIds: [fixture.alpha.id], requested: true });
    assert.deepEqual(asked.sources, []);
    assert.deepEqual(asked.report.merged.map((item) => [item.candidateId, item.alreadyMerged]), [[fixture.alpha.id, true]]);
  });
});

test('正文核验按文件身份持久缓存：准备交还后再准备不再哈希任何正文，会话也只看文件身份', async (t) => {
  const fixture = await fixtureFor(t);
  await seedRichSource(fixture.alpha, 'alpha', 3);
  rawWrite(fixture.alpha, (source) => {
    source.prepare("INSERT INTO turn VALUES ('alpha_conversation_0_active', 'alpha_conversation_0', 'active', ?, ?, NULL)").run(NOW, NOW);
  });
  const roots = [fixture.alpha.binding.paths.casRootPath, fixture.current.binding.paths.casRootPath].map((root) => path.resolve(root));
  const database = await openWindow(fixture);
  let preparation;
  try {
    const firstHashes = await hashedFiles(roots, async () => {
      const first = await prepare(fixture, database);
      assert.deepEqual(first.sources.map((source) => source.candidateId), [fixture.alpha.id]);
      await releaseLargeMergePreparation(first);
    });
    assert.ok(firstHashes.length > 0, '第一次准备核验了正文');
    const secondHashes = await hashedFiles(roots, async () => { preparation = await prepare(fixture, database); });
    assert.deepEqual(secondHashes, [], '交还之后再准备：没有变化的正文一个都不再哈希');
  } finally { await database.close(); }
  const sessionHashes = await hashedFiles(roots, async () => {
    const session = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
      () => runLargeMergeSession({ paths: fixture.paths, prepared: preparation })));
    assert.deepEqual(session.results.map((result) => result.state), ['merged']);
  });
  assert.deepEqual(sessionHashes, [], '会话只看文件身份');
  const cache = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'limcode.cas-verified.sqlite');
  const reader = new Database(cache, { readonly: true });
  try {
    const entries = reader.prepare('SELECT path FROM verified_file').pluck().all();
    assert.ok(entries.length > 0 && entries.every((entry) => entry.startsWith(roots[1] + path.sep)), '记下的是已发布到当前库的正文');
  } finally { reader.close(); }
});

test('准备中途取消：已准备好的来源也交还，准备记录和没用上的备份都撤掉，report.stopped 为真、不给来源', async (t) => {
  const fixture = await fixtureFor(t, { beta: true });
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await seedRichSource(fixture.beta, 'beta', 3);
  const controller = new AbortController();
  const preparation = await withWindow(fixture, (database) => {
    let firstId;
    return prepare(fixture, database, {
      signal: controller.signal,
      onProgress: (progress) => {
        firstId ??= progress.candidateId;
        if (progress.candidateId !== firstId) controller.abort();
      }
    });
  });
  assert.equal(controller.signal.aborted, true, '在第二份来源处取消');
  assert.deepEqual([preparation.report.stopped, preparation.sources, preparation.small], [true, [], []]);
  assert.deepEqual(await ledgerEntries(fixture, 'preparing'), [], '准备记录都已撤掉');
  if (preparation.backupPath) await assert.rejects(fs.stat(preparation.backupPath), { code: 'ENOENT' });
  assert.deepEqual(await mergeBackups(fixture), [], '没用上的目标备份已删除');
  await assert.rejects(runLargeMergeSession({ paths: fixture.paths, prepared: preparation }), /released/, '取消的准备不能再运行');
});

test('准备先看审计缓存：不进会话的小来源不再复制，按缓存就太大的来源照常记为太大', async (t) => {
  const fixture = await fixtureFor(t, { beta: true });
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await seedConversations(fixture.beta, [{ id: 'beta_small' }]);
  await withWindow(fixture, async (database) => {
    const estimated = await estimate(fixture, database);
    assert.deepEqual([estimated.sources.map((source) => source.candidateId), estimated.small], [[fixture.alpha.id], [fixture.beta.id]]);
    const copies = [];
    const small = await prepare(fixture, database, { candidateIds: [fixture.beta.id], options: copyCounter(copies, 'small') });
    assert.deepEqual([small.sources, small.small], [[], [fixture.beta.id]]);
    const tooLarge = await prepare(fixture, database, {
      candidateIds: [fixture.alpha.id], options: { sizeLimits: { transactionRows: 20, streamedRows: 40 }, ...copyCounter(copies, 'too-large') }
    });
    assert.deepEqual(tooLarge.report.blocked.map((issue) => [issue.candidateId, issue.code]),
      [[fixture.alpha.id, 'runtime-data-set-merge-too-large-for-one-transaction']]);
    assert.deepEqual(copies, [], '两份都按缓存判断，没有复制');
  });
  const record = await readLedgerRecord(fixture, fixture.alpha.id);
  assert.deepEqual([record?.state, record?.maxRows], ['too-large', 40], '按缓存判断的太大照常入账（缓存与指纹同一文件状态）');
  assert.deepEqual(await mergeBackups(fixture), []);
});

test('在线合并也把核验过的正文记在盘上：提交前出错之后再合并，已发布的正文不再哈希', async (t) => {
  const fixture = await fixtureFor(t);
  await seedRichSource(fixture.alpha, 'alpha', 2);
  const roots = [fixture.alpha.binding.paths.casRootPath, fixture.current.binding.paths.casRootPath].map((root) => path.resolve(root));
  const first = await hashedFiles(roots, () => withWindow(fixture, async (database) => {
    const report = await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database }, {
      onFaultPoint: (point) => { if (point === 'after-cas-transfer') throw Object.assign(new Error('I/O error'), { code: 'EIO' }); }
    });
    assert.deepEqual(report.deferred.map((issue) => [issue.candidateId, issue.code]), [[fixture.alpha.id, 'EIO']]);
  }));
  assert.ok(first.length > 0, '第一次核验了正文');
  const second = await hashedFiles(roots, () => withWindow(fixture, async (database) => {
    const report = await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database });
    assert.deepEqual(report.merged.map((item) => item.candidateId), [fixture.alpha.id]);
  }));
  assert.deepEqual(second, [], '再合并时已发布且没变的正文只看文件身份');
});

test('估计不删也不报过期的合并请求：批次才处理它们', async (t) => {
  const fixture = await fixtureFor(t, { beta: true });
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await seedConversations(fixture.beta, [{ id: 'beta_kept' }]);
  await markVscodeRuntimeDataSetKept(await resolveVscodeRuntimeDataSet(fixture.paths, fixture.beta.id));
  const requestFile = (dataSet) => path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'requests', `${dataSet.id.replace(/:/g, '-')}.json`);
  for (const dataSet of [fixture.alpha, fixture.beta]) {
    await fs.mkdir(path.dirname(requestFile(dataSet)), { recursive: true });
    await fs.writeFile(requestFile(dataSet), JSON.stringify({
      kind: 'limcode-runtime-data-set-merge-request', candidateId: dataSet.id, expectedDataSetId: dataSet.binding.dataSetId,
      expectedRootInstanceId: dataSet.binding.rootInstanceId,
      target: { dataSetId: fixture.current.binding.dataSetId, rootInstanceId: fixture.current.binding.rootInstanceId },
      requestedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    }));
  }
  const requests = await ledgerEntries(fixture, 'requests');
  assert.equal(requests.length, 2);
  await withWindow(fixture, async (database) => {
    // beta is left out by candidateIds, then kept by the user: a batch would remove its expired request and say so.
    const only = await estimate(fixture, database, { candidateIds: [fixture.alpha.id] });
    assert.deepEqual(only.sources.map((source) => source.candidateId), [fixture.alpha.id]);
    const all = await estimate(fixture, database);
    assert.deepEqual(all.sources.map((source) => source.candidateId), [fixture.alpha.id]);
    for (const result of [only, all]) assert.deepEqual(result.report.blocked, [], '不报请求过期');
  });
  assert.deepEqual(await ledgerEntries(fixture, 'requests'), requests, '请求原样保留');
});

test('估计中途取消：正在复制的那份不再核验、不写缓存，已估计的也不给', async (t) => {
  const fixture = await fixtureFor(t, { beta: true });
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await seedRichSource(fixture.beta, 'beta', 3);
  const controller = new AbortController();
  const stages = [];
  const result = await withWindow(fixture, (database) => estimate(fixture, database, {
    signal: controller.signal,
    onProgress: (progress) => {
      stages.push([progress.index, progress.stage]);
      if (progress.index === 1 && progress.stage === 'snapshot') controller.abort();
    }
  }));
  assert.deepEqual(stages, [[0, 'snapshot'], [0, 'audit'], [1, 'snapshot']], '第二份复制之后没有核验');
  assert.deepEqual([result.report.stopped, result.sources, result.small, result.estimateMs, result.space.targetBytes], [true, [], [], 0, 0]);
  assert.equal((await ledgerEntries(fixture, 'audits')).length, 1, '只有第一份写了审计缓存');
});

test('估时覆盖实测：只读估计的准备与独占时长、准备后按试算给的独占时长，上限都不低于实际耗时；会话把实测速率记在账本，之后的估计按它换算', { timeout: 240_000 }, async (t) => {
  const fixture = await fixtureFor(t, { beta: true });
  // alpha: many content objects (the preparation hashes and links each); beta: many rows (the session streams each).
  await contentHeavySource(fixture.alpha, 400, 'alpha');
  await generateSyntheticSource(fixture.beta, { rows: 60_000, prefix: 'beta' });
  const options = { sizeLimits: { transactionRows: 1000 } };
  const target = (database) => ({ paths: fixture.paths, target: { configurationRootPath: fixture.root, database }, options });
  const estimateOf = (dataSet) => withWindow(fixture, (database) => estimateLargeMergeSources({ ...target(database), candidateIds: [dataSet.id] }));
  const [alpha0, beta0] = [await estimateOf(fixture.alpha), await estimateOf(fixture.beta)];
  assert.ok(alpha0.sources[0].casObjects >= 4000 && beta0.sources[0].rows >= 60_000, JSON.stringify([alpha0.sources, beta0.sources]));
  const measure = async (dataSet) => {
    let started = performance.now();
    const preparation = await withWindow(fixture, (database) => prepareLargeMergeSources({ ...target(database), candidateIds: [dataSet.id] }));
    const prepareMs = performance.now() - started;
    assert.deepEqual(preparation.sources.map((source) => source.candidateId), [dataSet.id]);
    started = performance.now();
    const session = await runSession(fixture, preparation);
    const sessionMs = performance.now() - started;
    assert.deepEqual(session.results.map((result) => result.state), ['merged']);
    return { preparation, prepareMs, sessionMs };
  };
  const within = (label, actual, range) => {
    t.diagnostic(`${label}：实际 ${Math.round(actual)} ms，范围 ${range[0]}–${range[1]} ms`);
    assert.ok(actual <= range[1], `${label}：实际 ${Math.round(actual)} ms 超过了给出的上限 ${range[1]} ms`);
  };

  const beta = await measure(fixture.beta);
  within('beta 准备（只读估计）', beta.prepareMs, beta0.prepareEstimateRangeMs);
  within('beta 独占（只读估计）', beta.sessionMs, beta0.sessionEstimateRangeMs);
  within('beta 独占（准备后的试算）', beta.sessionMs, beta.preparation.estimateRangeMs);
  // Measured: this session's merged source against the size model the estimate used, for later estimates.
  const rate = JSON.parse(await fs.readFile(rateFile(fixture), 'utf8'));
  assert.deepEqual([rate.kind, rate.sources, rate.rows, rate.modelMs], [
    'limcode-runtime-large-merge-session-rate', 1, beta0.sources[0].rows, beta0.sources[0].sessionEstimateMs
  ]);
  assert.ok(rate.sessionMs > 0 && rate.sessionMs <= beta.sessionMs, JSON.stringify(rate));
  const { low, high } = RUNTIME_DATA_SET_LARGE_MERGE_MEASURED_RATE_BOUNDS;
  const factor = Math.min(high, Math.max(low, rate.sessionMs / rate.modelMs));
  t.diagnostic(`实测速率：模型的 ${factor.toFixed(2)} 倍`);

  // The next estimate: the exclusive phase at the measured rate, the preparation as before (the target grew by beta).
  const alpha1 = await estimateOf(fixture.alpha);
  assert.deepEqual(alpha1.sessionRate, { measuredAt: rate.measuredAt, factor });
  assert.ok(Math.abs(alpha1.sources[0].sessionEstimateMs - alpha0.sources[0].sessionEstimateMs * factor) <= 1, JSON.stringify([alpha0.sources, alpha1.sources]));
  assert.equal(alpha1.sources[0].prepareEstimateMs, alpha0.sources[0].prepareEstimateMs, '准备阶段不按会话速率换算');
  assert.equal(alpha1.sources[0].fingerprint, alpha0.sources[0].fingerprint);
  const alpha = await measure(fixture.alpha);
  within('alpha 准备（只读估计）', alpha.prepareMs, alpha1.prepareEstimateRangeMs);
  within('alpha 独占（按实测速率的估计）', alpha.sessionMs, alpha1.sessionEstimateRangeMs);
  within('alpha 独占（没有实测时的估计）', alpha.sessionMs, alpha0.sessionEstimateRangeMs);
  within('alpha 独占（准备后的试算）', alpha.sessionMs, alpha.preparation.estimateRangeMs);
  const replaced = JSON.parse(await fs.readFile(rateFile(fixture), 'utf8'));
  assert.deepEqual([replaced.rows, replaced.modelMs], [alpha0.sources[0].rows, alpha0.sources[0].sessionEstimateMs], '换成最近一次会话的实测');
});

test('实测速率只按上下限换算独占阶段；读不懂的记录当作没有', async (t) => {
  const fixture = await fixtureFor(t);
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const file = rateFile(fixture);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const write = (value) => fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  const rate = (sessionMs, modelMs) => ({
    kind: 'limcode-runtime-large-merge-session-rate', measuredAt: NOW, sources: 1, rows: 60_000, sessionMs, modelMs
  });
  await withWindow(fixture, async (database) => {
    const plain = await estimate(fixture, database);
    assert.equal(plain.sessionRate, undefined);
    const [source] = plain.sources;
    const { low, high } = RUNTIME_DATA_SET_LARGE_MERGE_MEASURED_RATE_BOUNDS;
    for (const [sessionMs, modelMs, factor] of [[3000, 1000, 3], [800, 1000, 0.8], [10_000, 1000, high], [100, 1000, low]]) {
      await write(rate(sessionMs, modelMs));
      const scaled = await estimate(fixture, database);
      assert.deepEqual(scaled.sessionRate, { measuredAt: NOW, factor });
      // Each estimate rounds once after scaling the raw model. The rounded baseline has
      // up to half a millisecond of error, which is itself multiplied by the rate.
      assert.ok(Math.abs(scaled.sources[0].sessionEstimateMs - source.sessionEstimateMs * factor) <= (factor + 1) / 2,
        `${factor}: ${scaled.sources[0].sessionEstimateMs}`);
      assert.deepEqual(scaled.sources[0].sessionEstimateRangeMs, unmeasuredRange(scaled.sources[0].sessionEstimateMs));
      assert.deepEqual([scaled.estimateMs, scaled.sessionEstimateMs], [scaled.sources[0].sessionEstimateMs, scaled.sources[0].sessionEstimateMs]);
      assert.deepEqual([scaled.sources[0].prepareEstimateMs, scaled.prepareEstimateMs], [source.prepareEstimateMs, plain.prepareEstimateMs], '准备阶段不换算');
    }
    for (const unreadable of ['{', JSON.stringify({ ...rate(3000, 1000), kind: 'other' }), JSON.stringify(rate(3000, 0)), JSON.stringify(rate(-1, 1000)),
      JSON.stringify({ ...rate(3000, 1000), rows: 0 })]) {
      await write(unreadable);
      const ignored = await estimate(fixture, database);
      assert.deepEqual([ignored.sessionRate, ignored.sources[0].sessionEstimateMs], [undefined, source.sessionEstimateMs], unreadable);
    }
  });
});

test('来源指纹与准备一致：没变就不变（可作操作键），来源一变就变；准备收尾之后，下一次估计给的就是收尾后的指纹', async (t) => {
  const fixture = await fixtureFor(t, { beta: true });
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await seedRichSource(fixture.beta, 'beta', 3);
  // beta has work the preparation closes first (an active Turn without a lease): that changes it.
  rawWrite(fixture.beta, (source) => {
    source.prepare("INSERT INTO turn VALUES ('beta_conversation_0_active', 'beta_conversation_0', 'active', ?, ?, NULL)").run(NOW, NOW);
  });
  const binding = fixture.current.binding;
  const fingerprints = (result) => Object.fromEntries(result.sources.map((source) => [source.candidateId, source.fingerprint]));
  let estimated;
  await withWindow(fixture, async (database) => {
    const first = await estimate(fixture, database);
    const again = await estimate(fixture, database);
    assert.equal(first.sources.length, 2);
    assert.deepEqual(again.sources.map((source) => source.cached), [true, true]);
    assert.deepEqual(fingerprints(again), fingerprints(first), '没变就不变');
    estimated = fingerprints(first);
    // Work to close first: the preparation backs beta up, then copies, audits and compares it again.
    const [alphaFirst, betaFirst] = [fixture.alpha, fixture.beta].map((dataSet) => first.sources.find((source) => source.candidateId === dataSet.id));
    assert.ok(betaFirst.prepareEstimateMs - alphaFirst.prepareEstimateMs >= 300, JSON.stringify(first.sources));
    const preparation = await prepare(fixture, database);
    await releaseLargeMergePreparation(preparation);
    const prepared = fingerprints(preparation);
    assert.deepEqual(Object.keys(prepared).sort(), Object.keys(estimated).sort());
    assert.equal(prepared[fixture.alpha.id], estimated[fixture.alpha.id], '与准备给的指纹相同');
    assert.notEqual(prepared[fixture.beta.id], estimated[fixture.beta.id], '收尾改了来源');
    const after = await estimate(fixture, database);
    assert.deepEqual(after.sources.map((source) => source.cached), [true, true], '准备核验过收尾后的文件');
    assert.deepEqual(fingerprints(after), prepared, '收尾之后的估计给收尾后的指纹');
    assert.equal(largeMergeOperationKey(binding, after.sources), largeMergeOperationKey(binding, preparation.sources), '两段的操作键一致');
  });
  await seedConversations(fixture.alpha, [{ id: 'alpha_later' }]);
  const changed = await withWindow(fixture, (database) => estimate(fixture, database, { candidateIds: [fixture.alpha.id] }));
  assert.equal(changed.sources[0].cached, false);
  assert.notEqual(changed.sources[0].fingerprint, estimated[fixture.alpha.id], '来源一变就变');
});

test('实测速率只算真正合并了的来源：会话里已被别的窗口合并（没有新内容）的来源不计入', async (t) => {
  const fixture = await fixtureFor(t, { beta: true });
  await generateSyntheticSource(fixture.alpha, { rows: 15_000, prefix: 'alpha' });
  await seedRichSource(fixture.beta, 'beta', 3);
  const options = { sizeLimits: { transactionRows: 50 } };
  const target = (database) => ({ paths: fixture.paths, target: { configurationRootPath: fixture.root, database }, options });
  const [estimated, preparation] = await withWindow(fixture, async (database) => [
    await estimateLargeMergeSources({ ...target(database), candidateIds: [fixture.alpha.id] }),
    await prepareLargeMergeSources(target(database))
  ]);
  assert.equal(preparation.sources.length, 2);
  const beta = preparation.sources.find((source) => source.candidateId === fixture.beta.id);
  const betaBinding = await requireCompleteRuntimeDataSet(await resolveVscodeRuntimeDataSet(fixture.paths, fixture.beta.id));
  const session = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => runLargeMergeSession({
      paths: fixture.paths, prepared: preparation,
      options: {
        // Another window merged beta meanwhile (the same content): the session finds it merged and skips it.
        onFaultPoint: async (point, detail) => {
          if (point !== 'before-source' || detail?.candidateId !== fixture.beta.id) return;
          await writeRuntimeDataSetMergeLedgerRecord(fixture.paths, {
            candidateId: fixture.beta.id, state: 'merged',
            source: {
              dataSetId: betaBinding.dataSetId, rootInstanceId: betaBinding.rootInstanceId, rootGeneration: betaBinding.rootGeneration,
              pointerRevision: betaBinding.pointerRevision, contentDigest: beta.fingerprint
            },
            target: { dataSetId: fixture.current.binding.dataSetId, rootInstanceId: fixture.current.binding.rootInstanceId },
            mergedAt: NOW, insertedRows: 0, reusedRows: 0, insertedConversations: 0
          });
        }
      }
    })));
  assert.deepEqual(Object.fromEntries(session.results.map((result) => [result.candidateId, result.state])),
    { [fixture.alpha.id]: 'merged', [fixture.beta.id]: 'current' });
  const rate = JSON.parse(await fs.readFile(rateFile(fixture), 'utf8'));
  assert.deepEqual([rate.sources, rate.rows, rate.modelMs], [1, estimated.sources[0].rows, estimated.sources[0].sessionEstimateMs]);
});

test('外来大库的估计：只经它的声明读（声明记在当前配置根、用完释放），不碰它记录的原位置，外来目录一字节不变；审计与指纹缓存在当前配置根，第二次不再复制；正文按全部复制计空间', async (t) => {
  // The current configuration root, and a LimCode data directory made elsewhere and copied beside it
  // under the name a data-root relocation gives a copied directory.
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-estimate-foreign-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const fixture = await createConfigurationRoot({ tmp: base });
  const elsewhere = await createConfigurationRoot({ tmp: base });
  await seedRichSource(elsewhere.current, 'far', 3);
  const container = path.join(base, `${path.basename(fixture.root)}.limcode-copied-2026-09-28T01-02-03-004Z-00000001`);
  await fs.cp(elsewhere.root, container, { recursive: true });
  const { entries } = await foreign.inspectForeignRuntimeHistory({ configurationRootPath: fixture.root });
  const entry = entries.find((item) => item.location.containerPath === container && item.scope === 'default' && !item.archiveName);
  assert.equal(entry?.status, 'verified', JSON.stringify(entries.map((item) => [item.location.containerPath, item.scope, item.status])));
  const root = await foreign.locateForeignRuntimeRoot(fixture.root, entry.location);
  const label = `外来历史库（${entry.name}）`;
  await foreignMerge.requestForeignRuntimeHistoryMerge(fixture.paths, {
    id: entry.id, location: entry.location, label, expectedDataSetId: root.recorded.dataSetId, expectedRootInstanceId: root.recorded.rootInstanceId
  });
  const before = await treeState(container);
  const original = await treeState(elsewhere.root);
  const requests = await ledgerEntries(fixture, 'requests');
  const targetBefore = readAll(fixture.current);
  const copies = [];
  const claims = () => fs.readdir(path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'foreign-claims')).catch(() => []);
  const probe = probeFilesystem();
  let first;
  let second;
  try {
    await withWindow(fixture, async (database) => {
      first = await estimate(fixture, database, { candidateIds: [entry.id], requested: true, options: copyCounter(copies, 'first') });
      // Released at once: the next estimate, a preparation or a cleanup takes it again.
      assert.deepEqual(await claims(), [], '声明用完即释放');
      second = await estimate(fixture, database, { candidateIds: [entry.id], requested: true, options: copyCounter(copies, 'second') });
    });
  } finally { probe.stop(); }
  assert.deepEqual(copies, ['first'], '只在第一次复制核验，第二次按缓存');
  for (const [result, cached] of [[first, false], [second, true]]) {
    assert.deepEqual([result.report.deferred, result.report.blocked, result.report.failures], [[], [], []]);
    assert.deepEqual(result.sources.map((source) => [source.candidateId, source.label, source.runtimeDataRootPath, source.cached]),
      [[entry.id, label, root.located.dataRootPath, cached]]);
    assert.equal(result.sources[0].fingerprint, entry.contentDigest, '指纹就是核验时的内容摘要');
  }
  // Its objects are only ever copied: the space counts every one of them.
  const audit = JSON.parse(await fs.readFile(path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'audits', `${entry.id.replace(/:/g, '-')}.json`), 'utf8'));
  assert.ok(audit.casBytes > 0 && audit.casObjects === first.sources[0].casObjects, JSON.stringify(audit));
  assert.equal(first.space.casCopyBytes, audit.casBytes, '外来库的正文全部复制');
  assert.equal(first.space.targetIndexBytes, Math.ceil(first.space.targetBackupBytes * 0.65));
  assert.equal(first.space.targetBytes,
    Math.ceil(first.sources[0].databaseBytes * 2.5 + first.space.targetIndexBytes + 64 * 1024 * 1024) + first.space.targetBackupBytes + audit.casBytes);

  assert.deepEqual(probe.seen.filter((call) => inside(elsewhere.root, call.path)), [], '它记录的原位置从不被访问');
  assert.deepEqual(probe.seen.filter((call) => call.writes && inside(container, call.path)), [], '外来目录里不新建、不改写、不删除任何东西');
  assert.deepEqual(await treeState(container), before, '外来目录逐字节、逐 inode 不变');
  assert.deepEqual(await treeState(elsewhere.root), original);
  assert.deepEqual(readAll(fixture.current), targetBefore, '当前库不变');
  assert.deepEqual(await ledgerFacts(fixture), { ...Object.fromEntries(LEDGER_SECTIONS.map((section) => [section, []])), requests }, '只读：不入账，请求原样保留');
  assert.deepEqual(await claims(), [], '声明用完即释放');
  assert.deepEqual(await mergeBackups(fixture), []);
  assert.ok((await ledgerEntries(fixture, 'fingerprints')).includes(`${entry.id.replace(/:/g, '-')}.json`), '指纹缓存在当前配置根');

  // Its request ran out: a batch would remove it with a notice, an estimate leaves it (named or not).
  const requestFile = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'requests', requests[0]);
  const expired = { ...JSON.parse(await fs.readFile(requestFile, 'utf8')), requestedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() };
  await fs.writeFile(requestFile, JSON.stringify(expired));
  await withWindow(fixture, async (database) => {
    for (const input of [{ candidateIds: [fixture.alpha.id] }, {}]) {
      const result = await estimate(fixture, database, input);
      assert.deepEqual([result.sources, result.report.blocked], [[], []], JSON.stringify(input));
    }
  });
  assert.deepEqual(JSON.parse(await fs.readFile(requestFile, 'utf8')), expired, '过期的请求原样保留');
  assert.deepEqual(await treeState(container), before);
});
