import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = process.env.LIMCODE_TEST_EXTENSION_ROOT
  ? path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT) : path.resolve('dist/extension');
const kernelFile = (file) => require(path.join(compiled, 'backend/reliableKernel', file));
const kernel = kernelFile('index.js');
const Database = require('better-sqlite3');
const nodeFs = require('node:fs');
const directorySync = require(path.join(compiled, 'backend/capabilities/filesystem/durableDirectorySync.js'));
const { RootAuthority } = kernelFile('rootAuthority.js');
const { projectFolderAssignmentSteps } = kernelFile('conversationProject.js');
const { attachmentObservationLinkId } = kernelFile('attachmentObservations.js');
const { stablePhaseDId } = kernelFile('effectControlPlane.js');
const { precopyRuntimeDataSetCas } = kernelFile('runtimeDataSetMerge.js');
const {
  RUNTIME_DATA_SET_COPY_BATCH_ROWS, copyRuntimeDataSetIntoEmptyRoot, ensureRuntimeDataSetCopyCurrent, isRuntimeDataSetCopyCurrent
} = kernelFile('runtimeDataSetBulkCopy.js');
const {
  resolveVscodeRuntimeDataRoot, resolveVscodeWorkspaceRuntimeScope, resolveVscodeWorkspaceRuntimeScopeRoot, selectVscodeRuntimeDataSet
} = kernelFile('vscodeRootAuthority.js');
const { isRuntimeMaintenanceHeld, listActiveRuntimeHosts, withRuntimeDataRootAdmission } = kernelFile('runtimeHostControl.js');

const NOW = '2026-09-26T00:00:00.000Z';
const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
const SHARED_TEXT = JSON.stringify({ role: 'user', parts: [{ text: '共享正文' }] });
const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);

for (const batchRows of [1, 4, 9]) {
test(`分批整库复制（每批 ${batchRows} 行）：逐领域 id、行数与内容一致；ModelRequest 聚合、子 Agent、协作消息、附件与未完成工作都能复制；目标能正常打开`, async (t) => {
  const fixture = await createFixture(t);
  await seedRich(fixture.current);
  const target = await createTarget(t, 'default');
  const batches = [];
  const receipt = await copy(fixture, fixture.current, target, { batchRows, onBatch: (batch) => batches.push(batch) });

  const tables = sourceTables(fixture.current);
  const total = Object.values(tables).reduce((sum, count) => sum + count, 0);
  assert.equal(receipt.rows, total);
  assert.ok(receipt.rowsByDomain.ModelRequest >= 3 && receipt.rowsByDomain.ModelStreamCheckpoint >= 4);
  assert.equal(receipt.insertedConversations, tables.conversation);
  assert.equal(receipt.batches.count, batches.length);
  assert.ok(batches.length > 10, `分成多批：${batches.length}`);
  for (const batch of batches) {
    assert.ok(batch.rows <= batchRows - 1 + batch.largestUnitRows, `批 ${batch.index} 超过批大小：${batch.rows}`);
    assert.equal(batch.steps, batch.rows, '每行一个插入步骤，没有额外的全量断言');
  }
  assert.ok(receipt.batches.largestUnitRows >= 6, 'ModelRequest 聚合（Operation、Attempt、请求、检查点、栅栏）整体在一个事务里');
  assert.deepEqual(readAll(target.dataSet), readAll(fixture.current), '每张表的每一行（按 id）都与来源相同');

  const reader = new Database(target.dataSet.binding.paths.databasePath);
  try { assert.deepEqual(reader.pragma('foreign_key_check'), []); } finally { reader.close(); }
  const database = await kernel.RuntimeDatabase.open(target.dataSet.authority, { hostBootId: `reopen-${randomUUID()}` });
  try {
    const [request, child, collaboration] = (await database.snapshot([
      repo('ModelRequest').get('rich_parent_request_completed'), repo('ChildExecution').get('child_exec_1'), repo('CollaborationMessage').get('collaboration_1')
    ])).snapshot;
    assert.equal(request?.terminal_state, 'completed');
    assert.equal(child?.child_conversation_id, 'rich_child');
    assert.equal(collaboration?.message_seq, 1n);
  } finally { await database.close(); }
  assert.equal(await fs.readFile(casFile(target.dataSet.binding, messageText('rich_parent', 0)), 'utf8'), messageText('rich_parent', 0));
});
}

test('中途注入失败：目标只在本次准入内部分写入、没有任何 Host，可整体丢弃后重做；前置条件不满足时直接拒绝', async (t) => {
  const fixture = await createFixture(t);
  await seedRich(fixture.current);
  const sourceBefore = await treeSnapshot(fixture.current.scopeRoot);
  const target = await createTarget(t, 'default');
  const input = inputOf(fixture.current);
  const placement = { configurationRootPath: target.root, runtimeDataRootPath: target.runtimeDataRootPath };

  await assert.rejects(copyRuntimeDataSetIntoEmptyRoot(fixture.paths, input, placement),
    { code: 'runtime-data-set-copy-target-visible' }, '不持有目标配置根准入就不写');
  await assert.rejects(withRuntimeDataRootAdmission(fixture.root, () => copyRuntimeDataSetIntoEmptyRoot(fixture.paths, input,
    { configurationRootPath: fixture.root, runtimeDataRootPath: resolveVscodeRuntimeDataRoot(fixture.paths) })),
  { code: 'runtime-data-set-copy-target-invalid' }, '不能复制进来源自己的数据目录');

  await assert.rejects(copy(fixture, fixture.current, target, {
    batchRows: 5,
    onFaultPoint: (point, batch) => { if (point === 'after-batch' && batch === 2) throw new Error('注入：第 3 批之后失败'); }
  }), /注入：第 3 批之后失败/);
  const partial = sourceTables(target.dataSet);
  const written = Object.values(partial).reduce((sum, count) => sum + count, 0);
  assert.ok(written > 0 && written < Object.values(sourceTables(fixture.current)).reduce((sum, count) => sum + count, 0), `部分写入：${written}`);
  assert.deepEqual(await listActiveRuntimeHosts(target.dataSet.binding.paths), [], '失败后目标上没有 Host');
  assert.equal(isRuntimeMaintenanceHeld(target.dataSet.binding.paths), false);
  await assert.rejects(copy(fixture, fixture.current, target), { code: 'runtime-data-set-copy-target-not-empty' }, '部分写入的目标不会被当作空库续写');

  // The whole target root is discarded (as the relocation rollback does) and the copy is redone.
  await target.reset();
  const receipt = await copy(fixture, fixture.current, target, { batchRows: 5 });
  assert.deepEqual(readAll(target.dataSet), readAll(fixture.current));
  assert.equal(receipt.rows, Object.values(sourceTables(fixture.current)).reduce((sum, count) => sum + count, 0));
  assert.deepEqual(await treeSnapshot(fixture.current.scopeRoot), sourceBefore, '来源原样不动');
});

test('超大单元单独一个事务：检查点很多的 ModelRequest 聚合不被拆开，也不和其它行合批', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['big_request']);
  await withRuntime(fixture.current, async (runtime, store) => {
    const recipe = await store.ingest(runtime, '{}', 'application/json');
    const body = await store.ingest(runtime, messageText('big_request', 9), MESSAGE_TYPE);
    await runtime.transaction(modelRequestAggregate('big_request_turn', 'big_request_model', 1n, { recipe: recipe.id, body: body.id, checkpoints: 20 }));
  });
  const target = await createTarget(t, 'default');
  const batches = [];
  await copy(fixture, fixture.current, target, { batchRows: 4, onBatch: (batch) => batches.push(batch) });
  const alone = batches.filter((batch) => batch.rows > 4);
  assert.equal(alone.length, 1);
  assert.equal(alone[0].rows, 1 + 1 + 1 + 20 + 1, 'Operation + Attempt + 请求 + 20 个检查点 + 栅栏');
  assert.equal(alone[0].largestUnitRows, alone[0].rows, '这一批只有这个聚合');
  assert.deepEqual(readAll(target.dataSet), readAll(fixture.current));
});

test('批大小的内存边界：主线程每批只持有一批步骤，边读边写，读取按页进行', async (t) => {
  const fixture = await createFixture(t);
  rawConversations(fixture.current, 'bulk', 3_000);
  const target = await createTarget(t, 'default');
  const batches = [];
  const receipt = await copy(fixture, fixture.current, target, { batchRows: 200, onBatch: (batch) => batches.push({ ...batch }) });
  assert.equal(receipt.rows, 3_000);
  assert.equal(receipt.batches.count, 15);
  assert.equal(receipt.batches.maxSteps, 200, '单批最大步骤数等于批大小');
  assert.ok(batches.every((batch) => batch.steps <= 200));
  assert.ok(batches.reduce((sum, batch) => sum + batch.reads, 0) <= receipt.batches.reads);
  assert.ok(batches[0].reads <= 2, `第一批只读了开头的一两页：${batches[0].reads}`);
  assert.ok(batches.slice(0, -1).every((batch) => batch.reads <= 2), '中间各批每批最多两页（每页 250 行）');
  assert.ok(RUNTIME_DATA_SET_COPY_BATCH_ROWS <= 5_000, '默认批大小有上限');
  assert.equal(sourceTables(target.dataSet).conversation, 3_000);
});

test('D：独占复制只对预复制之后变化或新增的正文重算摘要，元数据一致的不再读取（同盘硬链接与跨盘复制）', async (t) => {
  for (const crossDevice of [false, true]) {
    const fixture = await createFixture(t);
    await seed(fixture.current, ['d_first', 'd_second', 'd_third']);
    const target = await createTarget(t, 'default');
    const linkFile = crossDevice ? async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); } : undefined;
    const hashed = watchHashing(t);
    const precopy = await precopyRuntimeDataSetCas(fixture.paths, inputOf(fixture.current),
      { configurationRootPath: target.root, binding: target.dataSet.binding }, linkFile ? { linkFile } : {});
    const objects = sourceTables(fixture.current).content_object;
    assert.equal(precopy.linkedCasObjects + precopy.copiedCasObjects, objects);
    assert.equal(precopy.verification.size, objects, '每个对象只记录发布后的目标名');

    // After the pre-copy: one new object in the source, one pre-copied target object touched.
    await ingest(fixture.current, messageText('d_new', 0));
    const touched = casFile(target.dataSet.binding, messageText('d_second', 0));
    await fs.utimes(touched, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
    hashed.length = 0;
    const receipt = await copy(fixture, fixture.current, target, {
      casVerification: precopy.verification, ...(linkFile ? { linkFile } : {})
    });
    assert.deepEqual(hashed.sort(), [casFile(fixture.current.binding, messageText('d_new', 0)), touched].sort(),
      `${crossDevice ? '跨盘' : '同盘'}：只重算新增的和元数据变了的`);
    assert.equal(receipt.cas.reusedCasObjects, objects);
    assert.equal(receipt.cas.linkedCasObjects + receipt.cas.copiedCasObjects, 1);
    assert.equal(receipt.casVerification, precopy.verification, '校验记录原地扩充并随回执返回');
  }
});

test('G：跨盘预复制每个目录只 fsync 一次（临时目录不再逐对象 fsync），可取消，取消后不留临时文件与快照', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, ['g_1', 'g_2', 'g_3', 'g_4', 'g_5', 'g_6']);
  const target = await createTarget(t, 'default');
  const synced = [];
  const original = directorySync.syncDirectoryDurably;
  directorySync.syncDirectoryDurably = async (directory) => { synced.push(path.resolve(directory)); return original(directory); };
  t.after(() => { directorySync.syncDirectoryDurably = original; });
  const crossDevice = async () => { throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); };
  const temporaryCas = path.join(target.dataSet.binding.paths.casRootPath, 'tmp');

  const privateTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-bulk-copy-tmpdir-'));
  t.after(() => fs.rm(privateTmp, { recursive: true, force: true }));
  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = privateTmp;
  t.after(() => { if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp; });

  const controller = new AbortController();
  let links = 0;
  await assert.rejects(precopyRuntimeDataSetCas(fixture.paths, inputOf(fixture.current),
    { configurationRootPath: target.root, binding: target.dataSet.binding }, {
      signal: controller.signal,
      linkFile: async () => {
        links += 1;
        if (links === 3) controller.abort();
        throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
      }
    }), { name: 'AbortError' });
  assert.equal(links, 3, '取消后不再处理下一个对象');
  assert.deepEqual((await fs.readdir(temporaryCas).catch(() => [])).filter((name) => name.endsWith('.merge.tmp')), [], '没有残留的临时副本');
  const snapshots = async () => (await fs.readdir(privateTmp)).filter((name) => name.startsWith('limcode-merge-precopy-'));
  assert.deepEqual(await snapshots(), [], '预复制的私有快照目录已删除');

  // A complete cross-device pre-copy into a fresh root: every object is copied.
  const fresh = await createTarget(t, 'default');
  const freshTemporary = path.join(fresh.dataSet.binding.paths.casRootPath, 'tmp');
  synced.length = 0;
  const precopy = await precopyRuntimeDataSetCas(fixture.paths, inputOf(fixture.current),
    { configurationRootPath: fresh.root, binding: fresh.dataSet.binding }, { linkFile: crossDevice });
  assert.equal(precopy.copiedCasObjects, precopySources(fixture.current).length);
  assert.equal(synced.filter((directory) => directory === path.resolve(freshTemporary)).length, 1, '临时目录整轮只 fsync 一次');
  const counts = new Map();
  for (const directory of synced) counts.set(directory, (counts.get(directory) ?? 0) + 1);
  assert.ok([...counts.values()].every((count) => count === 1), '每个目录只 fsync 一次');
  const prefixes = new Set(precopySources(fixture.current).map((digest) => path.join(fresh.dataSet.binding.paths.casRootPath, 'sha256', digest.slice(0, 2))));
  for (const prefix of prefixes) assert.ok(counts.has(path.resolve(prefix)), `新对象所在目录在返回前已持久化：${prefix}`);
  assert.deepEqual((await fs.readdir(freshTemporary)).filter((name) => name.endsWith('.merge.tmp')), []);
  assert.deepEqual(await snapshots(), []);
});

test('E：其它历史库在线整库预复制；独占阶段按文件状态确认没变就保留，变了就丢弃重做', async (t) => {
  const fixture = await createFixture(t, { alpha: true });
  await seed(fixture.alpha, ['alpha_one', 'alpha_two']);
  const target = await createTarget(t, 'alpha');
  // Online: nobody holds the source directory's admission; the alpha data set just has no Host.
  const receipt = await copy(fixture, fixture.alpha, target, { batchRows: 6 });
  assert.equal(receipt.insertedConversations, 2);
  assert.equal(await withRuntimeDataRootAdmission(fixture.root, () => isRuntimeDataSetCopyCurrent(fixture.paths, receipt)), true);
  const kept = await withRuntimeDataRootAdmission(target.root, () => ensureRuntimeDataSetCopyCurrent(fixture.paths, receipt, () => {
    throw new Error('没有变化时不应丢弃目标');
  }));
  assert.equal(kept.recopied, false);

  await seed(fixture.alpha, ['alpha_three']);
  assert.equal(await isRuntimeDataSetCopyCurrent(fixture.paths, receipt), false, '来源之后有写入');
  let resets = 0;
  const redone = await withRuntimeDataRootAdmission(target.root, () => ensureRuntimeDataSetCopyCurrent(fixture.paths, receipt, async () => {
    resets += 1;
    await target.reset();
  }, { batchRows: 6 }));
  assert.equal(resets, 1);
  assert.equal(redone.recopied, true);
  assert.equal(redone.receipt.insertedConversations, 3);
  assert.deepEqual(readAll(target.dataSet), readAll(fixture.alpha));
  assert.equal(await isRuntimeDataSetCopyCurrent(fixture.paths, redone.receipt), true);
});

async function createFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-bulk-copy-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = { globalStoragePath: root };
  const current = await initialize(root, 'default');
  const alpha = options.alpha ? await initializeScope(paths, 'alpha') : undefined;
  await selectVscodeRuntimeDataSet(paths, 'default');
  return { root, paths, current, alpha };
}

async function createTarget(t, kind) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-bulk-copy-target-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const make = () => kind === 'alpha' ? initializeScope({ globalStoragePath: root }, 'alpha') : initialize(root, 'default');
  const target = { root, dataSet: await make() };
  target.runtimeDataRootPath = resolveVscodeRuntimeDataRoot({ globalStoragePath: target.dataSet.scopeRoot });
  target.reset = async () => {
    await fs.rm(path.dirname(target.runtimeDataRootPath), { recursive: true, force: true });
    await fs.mkdir(target.dataSet.scopeRoot, { recursive: true });
    target.dataSet = await make();
  };
  return target;
}

async function initializeScope(paths, name) {
  const scope = resolveVscodeWorkspaceRuntimeScope({ workspaceFolderUris: [`file:///workspace/${name}`] });
  const scopeRoot = resolveVscodeWorkspaceRuntimeScopeRoot(paths, scope);
  await fs.mkdir(scopeRoot, { recursive: true });
  return initialize(scopeRoot, `workspace:${scope.key}`);
}

async function initialize(scopeRoot, id) {
  const authority = new RootAuthority(() => resolveVscodeRuntimeDataRoot({ globalStoragePath: scopeRoot }));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  return { id, scopeRoot, authority, binding };
}

function inputOf(dataSet) {
  return { candidateId: dataSet.id, expectedDataSetId: dataSet.binding.dataSetId, expectedRootInstanceId: dataSet.binding.rootInstanceId };
}

function copy(fixture, dataSet, target, options = {}) {
  return withRuntimeDataRootAdmission(target.root, () => copyRuntimeDataSetIntoEmptyRoot(fixture.paths, inputOf(dataSet), {
    configurationRootPath: target.root, runtimeDataRootPath: target.runtimeDataRootPath
  }, options));
}

async function withRuntime(dataSet, run) {
  const runtime = await kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `seed-${randomUUID()}` });
  try {
    return await run(runtime, new kernel.ContentAddressedStore(dataSet.authority, dataSet.binding));
  } finally { await runtime.close(); }
}

function ingest(dataSet, text, type = MESSAGE_TYPE) {
  return withRuntime(dataSet, (runtime, store) => store.ingest(runtime, text, type));
}

/** One terminated Turn per Conversation, two messages each (an own body and a shared one). */
async function seed(dataSet, conversationIds) {
  await withRuntime(dataSet, async (runtime, store) => {
    const shared = await store.ingest(runtime, SHARED_TEXT, MESSAGE_TYPE);
    for (const id of conversationIds) {
      const own = await store.ingest(runtime, messageText(id, 0), MESSAGE_TYPE);
      const turnId = `${id}_turn`;
      const steps = [
        repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
        ...projectFolderAssignmentSteps({ conversationId: id, folder: { uri: 'file:///workspace/shared', name: 'shared' }, now: NOW }),
        repo('Turn').insert({ id: turnId, conversation_id: id, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
        repo('TurnTermination').insert({ id: `${id}_termination`, turn_id: turnId, terminal_status: 'completed', reason: 'fixture', created_at: NOW })
      ];
      for (const [index, content] of [own, shared].entries()) {
        const messageId = `${id}_message_${index}`;
        steps.push(
          repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
          repo('MessageRevision').insert({ id: `${messageId}_revision`, message_id: messageId, revision_seq: 1n, role: 'user', content_object_id: content.id, created_at: NOW }),
          repo('MessageCurrentRevisionLink').insert({ id: `${messageId}_current`, message_id: messageId, revision_id: `${messageId}_revision`, updated_at: NOW }),
          repo('MessagePartOfConversation').insert({ id: `${messageId}_member`, conversation_id: id, message_id: messageId, message_seq: BigInt(index + 1), created_at: NOW })
        );
      }
      await runtime.transaction(steps);
    }
  });
}

/** A historical ModelRequest aggregate: Operation, Attempt, request, checkpoints and (completed) fence. */
function modelRequestAggregate(turnId, id, seq, { recipe, body, checkpoints, completed = true }) {
  const status = completed ? 'completed' : 'cancelled';
  const steps = [
    repo('Operation').insertHistoricalCopy({
      id: `${id}_operation`, owner_kind: 'model_request', owner_id: id, operation_seq: 1n, tool_call_id: null, status, created_at: NOW, updated_at: NOW
    }),
    repo('Attempt').insertHistoricalCopy({
      id: `${id}_attempt`, operation_id: `${id}_operation`, attempt_seq: 1n, status, created_at: NOW, updated_at: NOW, completed_at: NOW
    }),
    repo('ModelRequest').insertHistoricalCopy({
      id, turn_id: turnId, request_seq: seq, status: 'terminal', terminal_state: completed ? 'completed' : 'turn-interrupt-requested',
      provider_id: 'openai-responses', model_id: 'gpt-test', context_window_tokens: 130_000n, compression_threshold_tokens: 100_000n,
      estimated_context_tokens: 1_000n, authority_snapshot_id: 'authority-copy', settings_snapshot_object_id: null, recipe_object_id: recipe,
      usage_json: null, stream_stats_json: { attemptSeq: '1', socketGeneration: '0', retryReason: null }, created_at: NOW, updated_at: NOW
    })
  ];
  for (let index = 1; index <= checkpoints; index += 1) {
    steps.push(repo('ModelStreamCheckpoint').insertHistoricalCopy({
      id: `${id}_checkpoint_${index}`, model_request_id: id, attempt_seq: 1n, socket_generation: 0n,
      stream_seq: BigInt(index), checkpoint_kind: 'output_delta', content_object_id: body, created_at: NOW
    }));
  }
  if (completed) {
    steps.push(repo('ModelStreamFence').insertHistoricalCopy({
      id: `${id}_fence`, model_request_id: id, attempt_seq: 1n, socket_generation: 0n, terminal_stream_seq: BigInt(checkpoints),
      outcome: 'completed', created_at: NOW
    }));
  }
  return steps;
}

/**
 * Cross-domain references a copy must keep: ModelRequest aggregates (completed with fence and
 * checkpoints, cancelled, and a prepared one with a lease as carried unfinished work), a child
 * Agent (child execution, parent link, child Turn, answer bridge), collaboration messages with
 * inbox items, and an attachment linked to a message revision and a Conversation.
 */
async function seedRich(dataSet) {
  await seed(dataSet, ['rich_parent', 'rich_child', 'rich_other']);
  await withRuntime(dataSet, async (runtime, store) => {
    const recipe = await store.ingest(runtime, '{}', 'application/json');
    const body = await store.ingest(runtime, JSON.stringify({ role: 'model', parts: [{ text: '检查点' }] }), MESSAGE_TYPE);
    await runtime.transaction([
      ...modelRequestAggregate('rich_parent_turn', 'rich_parent_request_completed', 1n, { recipe: recipe.id, body: body.id, checkpoints: 3 }),
      ...modelRequestAggregate('rich_parent_turn', 'rich_parent_request_cancelled', 2n, { recipe: recipe.id, body: body.id, checkpoints: 1, completed: false }),
      ...modelRequestAggregate('rich_other_turn', 'rich_other_request', 1n, { recipe: recipe.id, body: body.id, checkpoints: 2 })
    ]);
    const argumentsObject = await store.ingest(runtime, '{"path":"README.md"}', 'application/vnd.limcode.tool-arguments+json');
    const turnId = 'rich_other_unfinished_turn';
    await runtime.transaction([
      repo('Turn').insert({ id: turnId, conversation_id: 'rich_other', status: 'active', created_at: NOW, updated_at: NOW, terminal_at: null }),
      repo('ExecutionLease').insert({
        id: `${turnId}_lease`, conversation_id: 'rich_other', turn_id: turnId, owner_id: 'old-owner', host_boot_id: 'old-host', generation: 1n, acquired_at: NOW, expires_at: NOW
      }),
      repo('ModelRequest').insert({
        id: `${turnId}_request`, turn_id: turnId, request_seq: 1n, status: 'prepared', terminal_state: null, provider_id: 'openai-responses',
        model_id: 'gpt-test', context_window_tokens: 130_000n, compression_threshold_tokens: 100_000n, estimated_context_tokens: 1_000n,
        authority_snapshot_id: 'authority-copy', settings_snapshot_object_id: null, recipe_object_id: recipe.id, usage_json: null,
        stream_stats_json: { attemptSeq: '1', socketGeneration: '0', retryReason: null }, created_at: NOW, updated_at: NOW
      }),
      repo('Operation').insert({
        id: `${turnId}_operation`, owner_kind: 'model_request', owner_id: `${turnId}_request`, operation_seq: 1n, tool_call_id: null, status: 'pending', created_at: NOW, updated_at: NOW
      }),
      repo('Attempt').insert({ id: `${turnId}_attempt`, operation_id: `${turnId}_operation`, attempt_seq: 1n, status: 'pending', created_at: NOW, updated_at: NOW, completed_at: null }),
      repo('ToolCall').insert({ id: `${turnId}_tool`, turn_id: turnId, call_seq: 1n, tool_name: 'read_file', status: 'pending', arguments_object_id: argumentsObject.id, created_at: NOW, updated_at: NOW })
    ]);
    // An active retry Turn: its commit projection follows the retry intent to the source Message.
    const retry = await store.ingest(runtime, JSON.stringify({
      kind: 'retry', sourceTurnId: 'rich_parent_turn', sourceMessageId: 'rich_parent_message_0', editedMessageRevisionId: 'rich_parent_message_0_revision'
    }), 'application/vnd.limcode.turn-intent+json');
    await runtime.transaction([
      repo('Turn').insert({ id: 'rich_parent_retry_turn', conversation_id: 'rich_parent', status: 'active', created_at: NOW, updated_at: NOW, terminal_at: null }),
      repo('TurnIntent').insert({ id: 'rich_parent_retry_intent', conversation_id: 'rich_parent', turn_id: 'rich_parent_retry_turn', state: 'admitted', created_at: NOW, updated_at: NOW }),
      repo('TurnIntentRevision').insert({ id: 'rich_parent_retry_intent_revision', intent_id: 'rich_parent_retry_intent', revision_seq: 1n, content_object_id: retry.id, created_at: NOW })
    ]);
    for (const [index, id] of ['collaboration_1', 'collaboration_2'].entries()) {
      const payload = await store.ingest(runtime, `hello ${id}`, 'text/vnd.limcode.collaboration-message');
      const inboxItemId = `${id}_inbox`;
      const target = index === 0 ? 'rich_child' : 'rich_parent';
      await runtime.transaction([
        repo('CollaborationMessage').insertWithNextSequence({ id, dedupe_key: `dedupe-${id}`, mode: 'message', created_at: NOW }, { column: 'message_seq', scope: {} }),
        repo('CollaborationMessageSourceLink').insert({
          id: `${id}_source`, message_id: id, conversation_id: index === 0 ? 'rich_parent' : 'rich_child', source_kind: 'tool', source_key: `source-${id}`,
          turn_id: index === 0 ? 'rich_parent_turn' : 'rich_child_turn', tool_call_id: null, board_post_id: null, created_at: NOW
        }),
        repo('RuntimeInboxItem').insert({ id: inboxItemId, dedupe_key: `dedupe-${id}`, source_kind: 'collaboration_message', source_id: id, state: 'routed', created_at: NOW, updated_at: NOW }),
        repo('CollaborationMessageTargetLink').insert({ id: `${id}_target`, message_id: id, conversation_id: target, inbox_item_id: inboxItemId, anchor_turn_id: null, created_at: NOW }),
        repo('CollaborationMessagePayloadLink').insert({ id: `${id}_payload`, message_id: id, content_object_id: payload.id, created_at: NOW }),
        repo('RuntimeInboxPayloadLink').insert({ id: `${id}_inbox_payload`, inbox_item_id: inboxItemId, content_object_id: payload.id, created_at: NOW })
      ]);
    }
    const imageBytes = Buffer.from('screenshot bytes');
    const image = await store.ingest(runtime, imageBytes, 'image/png');
    const observation = await store.ingest(runtime, 'observed text', 'text/plain');
    const imageSha = sha256(imageBytes);
    const attachmentId = stablePhaseDId('attachment', JSON.stringify([imageSha, 'image/png', 'shot.png']));
    const profile = sha256('analysis-profile');
    await runtime.transaction([
      repo('Attachment').insert({
        id: attachmentId, sha256: imageSha, byte_length: String(imageBytes.length), mime_type: 'image/png', name: 'shot.png',
        storage_mode: 'cas', content_object_id: image.id, created_at: NOW
      }),
      repo('AttachmentObservationLink').insert({
        id: attachmentObservationLinkId(attachmentId, profile), attachment_id: attachmentId, analysis_profile_sha256: profile,
        content_object_id: observation.id, created_at: NOW
      }),
      repo('AttachmentLink').insert({ id: 'attachment_link_1', message_revision_id: 'rich_parent_message_0_revision', attachment_id: attachmentId, position: 1n, created_at: NOW }),
      repo('ConversationAttachmentHandleLink').insert({ id: 'attachment_handle_1', conversation_id: 'rich_parent', attachment_id: attachmentId, handle_seq: 1n, created_at: NOW })
    ]);
  });
  // A child Agent of rich_parent working in rich_child, as the Runtime records it.
  const source = new Database(dataSet.binding.paths.databasePath);
  try {
    source.pragma('foreign_keys = ON');
    const childTurn = 'rich_child_task_turn';
    source.exec('BEGIN IMMEDIATE');
    source.prepare('INSERT INTO child_execution VALUES (?, ?, ?, ?, ?)').run('child_exec_1', 'rich_child', 'idle', NOW, NOW);
    source.prepare('INSERT INTO child_execution_parent_link VALUES (?, ?, ?, ?, ?, ?)').run('child_parent_link_1', 'child_exec_1', 'tool_call_spawn_1', null, 'rich_parent_turn', NOW);
    source.prepare('INSERT INTO turn VALUES (?, ?, ?, ?, ?, ?)').run(childTurn, 'rich_child', 'terminated', NOW, NOW, NOW);
    source.prepare('INSERT INTO turn_termination VALUES (?, ?, ?, ?, ?)').run(`${childTurn}_termination`, childTurn, 'completed', 'fixture', NOW);
    source.prepare('INSERT INTO child_execution_turn_link VALUES (?, ?, ?, ?, ?)').run('child_turn_link_1', 'child_exec_1', 1, childTurn, NOW);
    source.prepare('INSERT INTO answer_bridge VALUES (?, ?, ?, ?, ?, ?)').run('bridge_1', 'child_exec_1', null, 'open', NOW, NOW);
    source.exec('COMMIT');
    assert.deepEqual(source.pragma('foreign_key_check'), []);
    source.pragma('wal_checkpoint(TRUNCATE)');
  } finally { source.close(); }
}

/** `count` Conversation rows written straight into an offline data set (no CAS). */
function rawConversations(dataSet, prefix, count) {
  const source = new Database(dataSet.binding.paths.databasePath);
  try {
    const insert = source.prepare("INSERT INTO conversation (id, title, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)");
    source.transaction(() => {
      for (let index = 0; index < count; index += 1) insert.run(`raw_${prefix}_${String(index).padStart(5, '0')}`, `raw ${index}`, NOW, NOW);
    })();
    source.pragma('wal_checkpoint(TRUNCATE)');
  } finally { source.close(); }
}

function sourceTables(dataSet) {
  const reader = new Database(dataSet.binding.paths.databasePath);
  try {
    const counts = {};
    for (const schema of kernel.RUNTIME_DOMAIN_SCHEMAS ?? require(path.join(compiled, 'backend/reliableKernel/schema/domainManifest.js')).RUNTIME_DOMAIN_SCHEMAS) {
      const count = reader.prepare(`SELECT COUNT(*) FROM "${schema.table}"`).pluck().get();
      if (count > 0) counts[schema.table] = count;
    }
    return counts;
  } finally { reader.close(); }
}

/** Every row of every domain table, ordered by id (BLOBs as hex). */
function readAll(dataSet) {
  const reader = new Database(dataSet.binding.paths.databasePath);
  try {
    reader.defaultSafeIntegers(true);
    const all = {};
    const { RUNTIME_DOMAIN_SCHEMAS } = require(path.join(compiled, 'backend/reliableKernel/schema/domainManifest.js'));
    for (const schema of RUNTIME_DOMAIN_SCHEMAS) {
      const rows = reader.prepare(`SELECT * FROM "${schema.table}" ORDER BY id`).all();
      if (rows.length > 0) all[schema.table] = rows.map((row) => JSON.stringify(row, (_, value) => typeof value === 'bigint' ? `${value}n` : value));
    }
    return all;
  } finally { reader.close(); }
}

function precopySources(dataSet) {
  const reader = new Database(dataSet.binding.paths.databasePath);
  try { return reader.prepare('SELECT DISTINCT sha256 FROM content_object').pluck().all(); } finally { reader.close(); }
}

/** Files read for a SHA-256 (the merge engine hashes through fs.createReadStream). */
function watchHashing(t) {
  const hashed = [];
  const original = nodeFs.createReadStream;
  nodeFs.createReadStream = function watched(file, ...rest) {
    if (String(file).includes(`${path.sep}sha256${path.sep}`)) hashed.push(path.resolve(String(file)));
    return original.call(this, file, ...rest);
  };
  t.after(() => { nodeFs.createReadStream = original; });
  return hashed;
}

function messageText(conversationId, index) {
  return JSON.stringify({ role: 'user', parts: [{ text: `${conversationId} 的第 ${index} 条消息` }] });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function casFile(binding, text) {
  const digest = sha256(text);
  return path.join(binding.paths.casRootPath, 'sha256', digest.slice(0, 2), digest);
}

async function treeSnapshot(root) {
  const files = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else {
        const stat = await fs.stat(file);
        files[path.relative(root, file)] = { size: stat.size, mtime: stat.mtimeMs, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') };
      }
    }
  }
  await visit(root);
  return files;
}
