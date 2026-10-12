import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test, { before, after } from 'node:test';
import { openFullRuntime } from './runtime-dataset-merge-full-runtime.mjs';
import {
  compiled, load, kernel, Database, NOW, MESSAGE_TYPE, repo, schemas, conversation, terminatedTurn,
  identity, loosePath, createHome, read, raw, insert, insertMessage, content, seed, packedMessage,
  pending, ledgerRoot, ledger, ledgerFile, merge, bareTurn, child, collaboration, aggregate,
  target, copy, domainRows, startChild, waitForFile, deletionFacade
} from './fixtures/ci-storage-merge-core.mjs';

const { largeMergeDiskNeeds } = load('runtimeDataSetLargeMergeSpace.js');
const histories = load('runtimeHistoryRegistry.js');
const mergeLedger = load('runtimeDataSetMergeLedger.js');
const tombstones = load('runtimeMergeTombstones.js');
const { ConversationDeletionControlPlane } = load('conversationDeletion.js');
const { TurnControlPlane } = load('turnControlPlane.js');
const { emptyConversationContextHandleStateStep, emptyContextHandleCatalog,
  prepareReadyConversationContextHandleState, pendingConversationContextHandleStateSteps,
  readCurrentConversationContextHandleState, readConversationContextHandleStateRow } = load('conversationContextHandleState.js');
const { prepareLargeMergeSources, releaseLargeMergePreparation } = load('runtimeDataSetStreamedMerge.js');
const { withRuntimeDataRootAdmission, listActiveRuntimeHosts } = load('runtimeHostControl.js');
const { projectFolderAssignmentSteps, projectContextIdForUri, conversationProjectLinkInsertStep } = load('conversationProject.js');
const { stopAndDeleteConversation } = await import(path.join(compiled, 'backend/application/reliableKernel/conversationDeleteCommand.js'));
const clean = report => assert.deepEqual([report.blocked, report.deferred, report.failures], [[], [], []], JSON.stringify(report));
const get = async (domain, id) => (await home.database.snapshot([repo(domain).get(id)])).snapshot[0];
const rows = async (domain, where = {}) => (await home.database.snapshotAll(repo(domain).list({ where,
  orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;
const MiB = 1024 * 1024;
const margin = 64 * MiB;
const diskSpace = { targetDirectory: path.resolve('ci-target'), targetBytes: 128 * MiB,
  temporaryDirectory: path.resolve('ci-copies'), temporaryBytes: 100 * MiB,
  sqliteTemporaryDirectory: path.resolve('ci-sqlite'), sqliteTemporaryBytes: 25 * MiB };
let home;
let rich;
let richCatalog;
let richBodies;

before(async () => { home = await createHome(); });
after(async () => { await home?.close(); });

test('未知设备按可能同盘总需求逐目录核对，容量不相借', () => {
  const disks = largeMergeDiskNeeds(diskSpace, { target: { device: 7, freeBytes: 220 * MiB },
    temporary: { device: 0, freeBytes: 230 * MiB }, sqliteTemporary: { device: 8, freeBytes: 200 * MiB } }, margin);
  assert.deepEqual(disks.map(disk => [disk.requiredBytes, disk.missingBytes]),
    [[228 * MiB, 8 * MiB], [228 * MiB, 0], [189 * MiB, 0]]);
});

test('已知共享盘合并需求，另一盘保持独立预算', () => {
  const disks = largeMergeDiskNeeds(diskSpace, { target: { device: 7, freeBytes: 1024 * MiB },
    temporary: { device: 7, freeBytes: 1024 * MiB }, sqliteTemporary: { device: 8, freeBytes: MiB } }, margin);
  assert.equal(disks.length, 2);
  assert.deepEqual(disks.map(disk => [disk.requiredBytes, disk.missingBytes]), [[228 * MiB, 0], [89 * MiB, 88 * MiB]]);
});

async function currentCollaboration(id, conversationId) {
  const payload = await home.store.ingest(home.database, `payload ${id}`, 'text/vnd.limcode.collaboration-message');
  await home.database.transaction([
    repo('CollaborationMessage').insertWithNextSequence({ id, dedupe_key: id, mode: 'message', created_at: NOW }, { column: 'message_seq', scope: {} }),
    repo('CollaborationMessageSourceLink').insert({ id: `${id}_source`, message_id: id, conversation_id: conversationId,
      source_kind: 'tool', source_key: id, turn_id: `${conversationId}_turn`, tool_call_id: null, board_post_id: null, created_at: NOW }),
    repo('RuntimeInboxItem').insert({ id: `${id}_inbox`, dedupe_key: id, source_kind: 'collaboration_message', source_id: id, state: 'routed', created_at: NOW, updated_at: NOW }),
    repo('CollaborationMessageTargetLink').insert({ id: `${id}_target`, message_id: id, conversation_id: conversationId, inbox_item_id: `${id}_inbox`, anchor_turn_id: null, created_at: NOW }),
    repo('CollaborationMessagePayloadLink').insert({ id: `${id}_payload`, message_id: id, content_object_id: payload.id, created_at: NOW }),
    repo('RuntimeInboxPayloadLink').insert({ id: `${id}_inbox_payload`, inbox_item_id: `${id}_inbox`, content_object_id: payload.id, created_at: NOW })
  ]);
}

test('多来源合并读回mixed packed/loose正文，协作顺序、增量和重复明确合并保持一致', async () => {
  const alpha = await home.source('happy-alpha');
  const beta = await home.source('happy-beta');
  const loose = await seed(alpha, [{ id: 'happy_alpha' }], { messages: true });
  await seed(beta, [{ id: 'happy_beta' }]);
  const packed = await packedMessage(alpha, 'happy_alpha', 'packed history');
  const duplicate = await content(beta, JSON.stringify({ role: 'user', parts: [{ text: 'body happy_alpha' }] }));
  raw(beta, database => insertMessage(database, 'happy_beta', duplicate));
  const project = { uri: 'file:///ci-merge/shared', name: 'shared' };
  const projectId = projectContextIdForUri(project.uri);
  for (const source of [alpha, beta]) raw(source, database => {
    insert(database, 'ProjectContext', { id: projectId, kind: 'folder', uri: project.uri, name: project.name, created_at: NOW, updated_at: NOW });
    insert(database, 'ConversationProjectLink', conversationProjectLinkInsertStep({ conversationId: source === alpha ? 'happy_alpha' : 'happy_beta', projectContextId: projectId, now: NOW }).row);
  });
  await collaboration(alpha, 'happy_alpha', 'happy_alpha', 'happy_source_1');
  await collaboration(alpha, 'happy_alpha', 'happy_alpha', 'happy_source_2');
  await home.database.transaction([repo('Conversation').insert(conversation('happy_current')),
    repo('Turn').insert(terminatedTurn('happy_current_turn', 'happy_current')),
    repo('TurnTermination').insert({ id: 'happy_current_terminal', turn_id: 'happy_current_turn', terminal_status: 'completed', reason: 'fixture', created_at: NOW }),
    ...projectFolderAssignmentSteps({ conversationId: 'happy_current', folder: project, now: NOW })]);
  await currentCollaboration('happy_current_1', 'happy_current');
  await pending(home, alpha, '2000-01-01T00:00:00.000Z');
  const sourceBytes = await fs.readFile(loosePath(alpha.binding, loose));
  let late = false;
  const report = await merge(home, [alpha, beta], { async onFaultPoint(point) {
    if (point === 'after-cas-transfer' && !late) { late = true; await currentCollaboration('happy_current_late', 'happy_current'); }
  } });
  clean(report);
  assert.equal(report.merged.reduce((n, result) => n + result.insertedConversations, 0), 2);
  assert.equal(new Set(report.merged.map(result => result.backupPath)).size, 1, 'one target backup per batch');
  const ordered = (await rows('CollaborationMessage')).sort((a, b) => Number(a.message_seq - b.message_seq));
  assert.deepEqual(ordered.map(row => row.id), ['happy_current_1', 'happy_current_late', 'happy_source_1', 'happy_source_2']);
  assert.equal((await rows('ProjectContext', { id: projectId })).length, 1);
  assert.equal((await rows('ContentObject', { sha256: loose.sha256 })).length, 1);
  assert.deepEqual(await home.store.read(await get('ContentObject', loose.id)), sourceBytes);
  assert.equal(JSON.parse((await home.store.read(await get('ContentObject', packed.id))).toString()).parts[0].text, 'packed history');
  assert.deepEqual(await fs.readFile(loosePath(alpha.binding, loose)), sourceBytes);
  assert.equal((await histories.readRuntimeHistoryPending(home.paths)).has(alpha.id), false);
  const noNew = await merge(home, [alpha]);
  clean(noNew);
  assert.deepEqual([noNew.merged[0].alreadyMerged, noNew.merged[0].insertedRows, noNew.merged[0].backupPath], [true, 0, undefined]);
  await seed(alpha, [{ id: 'happy_increment' }]);
  const increment = await merge(home, [alpha]);
  clean(increment);
  assert.equal(increment.merged[0].insertedConversations, 1);
  await home.database.transaction([repo('Conversation').update('happy_increment', { title: 'usable after merge' })]);
  assert.equal((await get('Conversation', 'happy_increment')).title, 'usable after merge');
});

test('真实另一个进程持续写入同一当前库并看见在线合并结果', async t => {
  const source = await home.source('peer');
  await seed(source, [{ id: 'peer_imported' }]);
  const resultFile = path.join(home.base, 'peer-result.json');
  const stopFile = path.join(home.base, 'peer-stop');
  const process = startChild('runtime-dataset-merge-child.mjs', ['writer', home.root, stopFile, resultFile, 'peer_imported']);
  t.after(() => process.child.kill());
  await waitForFile(`${resultFile}.ready`, process);
  clean(await merge(home, [source]));
  await fs.writeFile(stopFile, '');
  const exited = await process.exited;
  assert.equal(exited.code, 0, exited.stderr);
  const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
  assert.deepEqual(result.errors, []);
  assert.ok(result.written >= 1);
  assert.equal(result.sawMerged, true);
  const peers = (await rows('Conversation')).filter(row => row.id.startsWith('peer_conversation_'));
  assert.equal(peers.length, result.written);
});

test('冲突、待投递与有归属工作局部剔除，无归属工作整份拒绝，安全部分登记partial', async () => {
  const source = await home.source('partial');
  const unowned = await home.source('unowned');
  await seed(source, [{ id: 'partial_conflict', title: 'source title' }, { id: 'partial_safe' }, { id: 'owned_asking' }]);
  await seed(unowned, [{ id: 'unowned_history' }]);
  const unownedPrompt = await content(unowned, '{"question":"continue"}', 'application/json');
  raw(unowned, database => insert(database, 'InteractionRequest', { id: 'unowned_question', request_kind: 'ask_user', status: 'pending',
    prompt_object_id: unownedPrompt.id, created_at: NOW, updated_at: NOW }));
  const turnId = await bareTurn(source, 'owned_asking');
  const prompt = await content(source, '{"question":"answer me"}', 'application/json');
  raw(source, database => {
    insert(database, 'InteractionRequest', { id: 'owned_question', request_kind: 'ask_user', status: 'pending', prompt_object_id: prompt.id, created_at: NOW, updated_at: NOW });
    insert(database, 'InteractionOwnerLink', { id: 'owned_question_owner', request_id: 'owned_question', turn_id: turnId, created_at: NOW });
  });
  const { id: deliveryId, active, queued, pendingDelivery } = await queuedSource('delivery', true, source);
  const inspected = read(source, load('runtimeDataSetMergeProbes.js').inspectUnfinishedWork);
  assert.ok(inspected.refused.some(item => item.label === '待投递的消息或唤醒'));
  await home.database.transaction([repo('Conversation').insert(conversation('partial_conflict', 'current title'))]);
  const tools = await content(source, JSON.stringify({ kind: 'frozen-tool-definitions', tools: [] }), 'application/json');
  await aggregate(source, 'partial_conflict', 'partial_request', { toolsReference: { contentObjectId: tools.id }, checkpoints: 1 });
  await fs.chmod(path.dirname(loosePath(source.binding, tools)), 0o700);
  await fs.rm(loosePath(source.binding, tools));
  const report = await merge(home, [source, unowned], { settleSourceWork: undefined,
    async confirmSettlement() { assert.fail('Excluded work must not be finalized.'); } });
  assert.deepEqual([report.deferred, report.failures], [[], []], JSON.stringify(report));
  assert.deepEqual(report.blocked.map(row => [row.candidateId, row.code]), [[unowned.id, 'runtime-data-set-merge-unattributed']]);
  assert.equal(report.merged.length, 1);
  assert.equal(report.merged[0].candidateId, source.id);
  assert.deepEqual(report.merged[0].excluded.map(row => row.conversationId).sort(),
    [deliveryId, 'delivery_sender', 'owned_asking', 'partial_conflict'].sort());
  assert.ok(report.merged[0].excluded.some(row => row.conversationId === 'owned_asking'
    && row.code === 'runtime-data-set-merge-unfinished-work'));
  assert.ok(report.merged[0].excluded.some(row => row.conversationId === 'partial_conflict'
    && row.code === 'runtime-data-set-merge-conflict'));
  assert.equal(report.merged[0].insertedConversations, 1);
  assert.equal((await get('Conversation', 'partial_conflict')).title, 'current title');
  assert.ok(await get('Conversation', 'partial_safe'));
  assert.equal(await get('Conversation', 'owned_asking'), null);
  assert.equal(await get('Conversation', 'unowned_history'), null);
  assert.equal(await get('Conversation', deliveryId), null);
  read(source, database => {
    assert.equal(database.prepare('SELECT status FROM turn WHERE id=?').pluck().get(turnId), 'active');
    assert.equal(database.prepare('SELECT status FROM interaction_request WHERE id=?').pluck().get('owned_question'), 'pending');
    assert.equal(database.prepare('SELECT status FROM turn WHERE id=?').pluck().get(active.turnId), 'active');
    assert.equal(database.prepare('SELECT state FROM turn_intent WHERE id=?').pluck().get(queued.intentId), 'queued');
    assert.equal(database.prepare('SELECT state FROM runtime_delivery WHERE id=?').pluck().get(pendingDelivery.id), 'pending');
    assert.equal(database.prepare('SELECT COUNT(*) FROM model_request WHERE turn_id=?').pluck().get(active.turnId), 0n);
  });
  assert.equal(await get('ContentObject', tools.id), null);
  const record = await ledger(home, source);
  assert.equal(record.state, 'partial');
  assert.deepEqual((await histories.readRuntimeHistoryResidual(home.paths)).get(source.id).excluded, record.excluded);
  const automatic = await merge(home, [source], { requested: false });
  assert.equal(automatic.merged.length, 0);
  assert.equal((await ledger(home, source)).updatedAt, record.updatedAt);
});

test('来源坏正文局部剔除，目标已有坏正文保持原字节', async () => {
  const source = await home.source('cas-source');
  const good = await seed(source, [{ id: 'cas_good' }], { messages: true });
  await seed(source, [{ id: 'cas_bad' }]);
  const bad = await content(source, JSON.stringify({ role: 'user', parts: [{ text: 'bad body' }] }));
  raw(source, database => insertMessage(database, 'cas_bad', bad));
  const badFile = loosePath(source.binding, bad);
  const damaged = await fs.readFile(badFile);
  damaged[damaged.length - 3] ^= 1;
  await fs.chmod(badFile, 0o600);
  await fs.writeFile(badFile, damaged);
  const report = await merge(home, [source]);
  clean(report);
  assert.deepEqual(report.merged[0].excluded.map(row => [row.conversationId, row.code]), [['cas_bad', 'runtime-data-set-merge-source-cas-invalid']]);
  assert.ok(await get('Conversation', 'cas_good'));
  assert.equal(await get('Conversation', 'cas_bad'), null);
  await assert.rejects(fs.stat(loosePath(home.current.binding, bad)), { code: 'ENOENT' });
  const targetFile = loosePath(home.current.binding, good);
  const valid = await fs.readFile(targetFile);
  const wrong = Buffer.from(valid); wrong[wrong.length - 3] ^= 1;
  await fs.chmod(path.dirname(targetFile), 0o700);
  await fs.rm(targetFile); // Break a source hard link before damaging the target.
  await fs.writeFile(targetFile, wrong);
  const later = await home.source('cas-target');
  await seed(later, [{ id: 'cas_target_new' }]);
  const same = await content(later, valid);
  raw(later, database => insertMessage(database, 'cas_target_new', same));
  try {
    const refused = await merge(home, [later]);
    assert.equal(refused.blocked[0]?.code, 'runtime-data-set-merge-target-cas-damaged');
    assert.equal(await get('Conversation', 'cas_target_new'), null);
    assert.deepEqual(await fs.readFile(targetFile), wrong);
  } finally { await fs.writeFile(targetFile, valid); }
});

test('规划后来源改变使过期计划推迟，下次导入新的内容', async () => {
  const source = await home.source('source-fence');
  await seed(source, [{ id: 'fence_original' }]);
  let changed = false;
  const first = await merge(home, [source], { onFaultPoint(point) {
    if (point === 'after-cas-transfer' && !changed) {
      changed = true;
      raw(source, database => insert(database, 'Conversation', conversation('fence_late')));
    }
  } });
  assert.deepEqual(first.deferred.map(row => row.code), ['runtime-data-set-merge-source-changed']);
  assert.equal(await get('Conversation', 'fence_original'), null);
  assert.equal(await ledger(home, source), undefined);
  const retried = await merge(home, [source]);
  clean(retried);
  assert.ok(await get('Conversation', 'fence_late'));
});

test('锁内发现其它目标的committing记录时推迟并保留原记录', async () => {
  const source = await home.source('elsewhere');
  await seed(source, [{ id: 'elsewhere_history' }]);
  const record = JSON.stringify({ kind: 'limcode-runtime-data-set-merge', candidateId: source.id, state: 'committing',
    source: { ...identity(source.binding), rootGeneration: 1, pointerRevision: 1, contentDigest: 'interrupted' },
    target: { dataSetId: randomUUID(), rootInstanceId: randomUUID() }, commitId: 'another-target', updatedAt: NOW });
  const report = await merge(home, [source], { async onFaultPoint(point) {
    if (point !== 'after-cas-transfer') return;
    await fs.mkdir(path.dirname(ledgerFile(home, source)), { recursive: true });
    await fs.writeFile(ledgerFile(home, source), record);
  } });
  assert.deepEqual(report.deferred.map(row => row.code), ['runtime-data-set-merge-commit-elsewhere']);
  assert.equal(await fs.readFile(ledgerFile(home, source), 'utf8'), record);
  assert.equal(await get('Conversation', 'elsewhere_history'), null);
});

test('损坏账本自动暂停，明确重新核验可以合并，未知新状态原样保留', async () => {
  const source = await home.source('ledger');
  await seed(source, [{ id: 'ledger_history' }]);
  await pending(home, source);
  const file = ledgerFile(home, source);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{"kind":');
  const automatic = await merge(home, [source], { requested: false });
  assert.deepEqual(automatic.blocked.map(row => row.code), ['runtime-data-set-merge-record-damaged']);
  assert.equal(await fs.readFile(file, 'utf8'), '{"kind":');
  assert.equal(await get('Conversation', 'ledger_history'), null);
  clean(await merge(home, [source]));
  assert.equal((await ledger(home, source)).state, 'merged');
  const newer = JSON.stringify({ kind: 'limcode-runtime-data-set-merge', candidateId: source.id,
    state: 'future-state', source: identity(source.binding), updatedAt: NOW });
  await fs.writeFile(file, newer);
  await assert.rejects(mergeLedger.writeRuntimeDataSetMergeLedgerRecord(home.paths, { candidateId: source.id,
    state: 'failed', source: identity(source.binding), code: 'fixture', message: 'fixture' }), { code: 'runtime-data-set-merge-record-newer' });
  assert.equal(await fs.readFile(file, 'utf8'), newer);
});

test('空间不足在来源备份与中止收尾前推迟，Turn和目标保持原状态', async () => {
  const source = await home.source('space');
  await seed(source, [{ id: 'space_history' }]);
  const turnId = await bareTurn(source, 'space_history');
  const report = await merge(home, [source], { freeSpace: async directory => path.resolve(directory) === path.resolve(os.tmpdir()) ? Number.MAX_SAFE_INTEGER : 1 });
  assert.deepEqual(report.deferred.map(row => row.code), ['runtime-data-set-merge-disk-full']);
  assert.equal(read(source, database => database.prepare('SELECT status FROM turn WHERE id=?').pluck().get(turnId)), 'active');
  assert.equal(await get('Conversation', 'space_history'), null);
  assert.equal(await ledger(home, source), undefined);
  await assert.rejects(fs.stat(path.join(path.dirname(source.binding.paths.dataRootPath), 'merge-source-backups')), { code: 'ENOENT' });
});

test('准备记录心跳与释放交错时不复活已释放记录，也不删除其他token', async () => {
  const source = await home.source('heartbeat');
  await seed(source, [{ id: 'heartbeat_history' }]);
  let armed = false;
  let reached, resume;
  const beat = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { resume = resolve; });
  const options = { sizeLimits: { transactionRows: 0 }, chunkRows: 7, heartbeatMs: 5,
    async onFaultPoint(point) { if (point === 'preparation-heartbeat' && armed) { armed = false; reached(); await gate; } } };
  const prepare = () => prepareLargeMergeSources({ paths: home.paths, target: { configurationRootPath: home.root, database: home.database },
    candidateIds: [source.id], requested: true, options });
  const first = await prepare();
  assert.equal(first.sources.length, 1);
  armed = true;
  await beat;
  let released = false;
  const release = releaseLargeMergePreparation(first).then(() => { released = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, false, 'release waits for the heartbeat admission');
  resume();
  await release;
  assert.equal(await mergeLedger.readRuntimeDataSetMergePreparation(home.paths, source.id), undefined);
  const second = await prepare();
  const theirs = { candidateId: source.id, token: 'other-window', processId: process.pid,
    startedAt: NOW, heartbeatAt: NOW };
  await withRuntimeDataRootAdmission(home.root, () => mergeLedger.writeRuntimeDataSetMergePreparation(home.paths, theirs));
  await releaseLargeMergePreparation(second);
  assert.equal((await mergeLedger.readRuntimeDataSetMergePreparation(home.paths, source.id)).token, theirs.token);
  await withRuntimeDataRootAdmission(home.root, () => mergeLedger.removeRuntimeDataSetMergePreparation(home.paths, source.id));
});

test('小rich库按7行分批复制，聚合、关系、ready/pending句柄与mixed正文保持原样', async t => {
  rich = await home.source('bulk-rich');
  const loose = await seed(rich, [{ id: 'bulk_ready' }, { id: 'bulk_pending' }], { messages: true });
  await aggregate(rich, 'bulk_ready', 'bulk_request', { checkpoints: 5 });
  raw(rich, database => child(database, 'bulk_ready', 'bulk_child'));
  richCatalog = { ...emptyContextHandleCatalog(), entries: [{ kind: 'process', ref: 'P4', target: 'reserved_process' }], retiredRefs: ['P2'] };
  const packed = await packedMessage(rich, 'bulk_ready', 'bulk packed body', async (database, store) => {
    await database.transaction([
      ...await prepareReadyConversationContextHandleState({ database, contentStore: store, conversationId: 'bulk_ready', catalog: richCatalog, requiresNativeReset: true, now: NOW }),
      ...pendingConversationContextHandleStateSteps('bulk_pending', NOW)
    ]);
  });
  richBodies = { loose, packed };
  const destination = await target(home, 'bulk-copy-success');
  const checkpoint = kernel.RuntimeDatabase.prototype.durabilityCheckpoint;
  let proof;
  t.mock.method(kernel.RuntimeDatabase.prototype, 'durabilityCheckpoint', async function (...args) {
    const result = await checkpoint.apply(this, args);
    if (this.binding.dataSetId === destination.dataSet.binding.dataSetId) {
      const file = path.join(destination.root, 'main-file-proof.sqlite');
      await fs.copyFile(this.binding.paths.databasePath, file);
      const disk = new Database(file, { readonly: true });
      try { proof = disk.prepare('SELECT COUNT(*) FROM model_stream_checkpoint WHERE model_request_id=?').pluck().get('bulk_request'); }
      finally { disk.close(); }
      // Reuse the copy's actual target writer at its completed durability boundary.
      const store = kernel.ContentAddressedStore.forDatabase(destination.dataSet.authority, this);
      const state = await readCurrentConversationContextHandleState(this, store, 'bulk_ready');
      assert.deepEqual(state.catalog, richCatalog);
      assert.equal(state.requiresNativeReset, true);
      assert.equal((await readConversationContextHandleStateRow(this, 'bulk_pending')).state, 'pending');
      assert.equal(JSON.parse((await store.read(packed)).toString()).parts[0].text, 'bulk packed body');
      assert.equal(JSON.parse((await store.read(loose)).toString()).parts[0].text, 'body bulk_ready');
    }
    return result;
  });
  const batches = [];
  const receipt = await copy(home, rich, destination, { batchRows: 7, onBatch: batch => batches.push(batch) });
  assert.equal(Number(proof), 5, 'checkpoint main-file proof existed before the receipt');
  assert.ok(batches.length > 1);
  const unit = batches.find(batch => batch.rows > 7);
  assert.equal(unit.rows, 9, 'Operation + Attempt + request + five checkpoints + fence');
  assert.equal(unit.largestUnitRows, 9);
  for (const batch of batches) assert.ok(batch.rows <= 6 + batch.largestUnitRows);
  assert.deepEqual(domainRows(destination.dataSet), domainRows(rich));
  assert.equal(receipt.rowsByDomain.ModelRequest, 1);
});

test('复制中断的部分目标无Host与成功收据，后续复制拒绝把它当空库复用', async () => {
  const destination = await target(home, 'bulk-copy-failure');
  let receipt;
  await assert.rejects(copy(home, rich, destination, { batchRows: 7,
    onFaultPoint(point) { if (point === 'after-batch') throw new Error('injected partial copy'); }
  }).then(result => { receipt = result; }), /injected partial copy/);
  assert.equal(receipt, undefined);
  const copied = Object.values(domainRows(destination.dataSet)).reduce((n, values) => n + values.length, 0);
  const source = Object.values(domainRows(rich)).reduce((n, values) => n + values.length, 0);
  assert.ok(copied > 0 && copied < source);
  assert.deepEqual(await listActiveRuntimeHosts(destination.dataSet.binding.paths), []);
  await assert.rejects(copy(home, rich, destination, { batchRows: 7 }), { code: 'runtime-data-set-copy-target-not-empty' });
});

test('复制期间来源新增写入时不给成功收据', async () => {
  const destination = await target(home, 'bulk-copy-source-race');
  let changed = false;
  await assert.rejects(copy(home, rich, destination, { batchRows: 7, onFaultPoint(point) {
    if (point === 'after-batch' && !changed) {
      changed = true;
      raw(rich, database => insert(database, 'Conversation', conversation('bulk_late')));
    }
  } }), { code: 'runtime-data-set-merge-source-changed' });
  assert.equal(changed, true);
});

test('外部编辑使mixed合并回滚，修复后全复用按断言、checkpoint、成功账本顺序完成', async t => {
  const source = await home.source('target-race');
  raw(source, database => {
    insert(database, 'Conversation', conversation('race_shared'));
    insert(database, 'Conversation', conversation('race_new'));
  });
  await home.database.transaction([repo('Conversation').insert(conversation('race_shared'))]);
  const snapshot = home.database.snapshot.bind(home.database);
  let changed = false;
  t.mock.method(home.database, 'snapshot', async (...args) => {
    const result = await snapshot(...args);
    if (!changed && result.snapshot.some(row => row?.id === 'race_shared')) {
      changed = true;
      execFileSync(process.execPath, ['-e',
        "const D=require('better-sqlite3');const d=new D(process.argv[1]);try{d.prepare('UPDATE conversation SET title=? WHERE id=?').run('external edit','race_shared')}finally{d.close()}",
        home.database.binding.paths.databasePath], { cwd: process.cwd() });
    }
    return result;
  });
  const report = await merge(home, [source]);
  assert.equal(changed, true);
  assert.deepEqual([report.merged, report.blocked, report.failures], [[], [], []]);
  assert.equal(report.deferred[0].code, 'RUNTIME_TRANSACTION_ASSERTION_FAILED');
  assert.equal(await ledger(home, source), undefined);
  assert.equal((await get('Conversation', 'race_shared')).title, 'external edit');
  assert.equal(await get('Conversation', 'race_new'), null);
  await home.database.transaction([repo('Conversation').update('race_shared', { title: 'race_shared' }),
    repo('Conversation').insert(conversation('race_new'))]);
  const events = [];
  const transaction = home.database.transaction.bind(home.database);
  t.mock.method(home.database, 'transaction', async (steps, ...args) => {
    events.push('assert');
    assert.ok(steps.length > 0 && steps.every(step => step.kind === 'assert'));
    const reused = steps.filter(step => step.domain === 'Conversation');
    assert.deepEqual(reused.map(step => step.where.title).sort(), ['race_new', 'race_shared']);
    return transaction(steps, ...args);
  });
  const checkpoint = home.database.durabilityCheckpoint.bind(home.database);
  t.mock.method(home.database, 'durabilityCheckpoint', async () => {
    events.push('checkpoint');
    assert.equal(await ledger(home, source), undefined);
    await checkpoint();
    const file = path.join(home.base, 'reuse-main-proof.sqlite');
    await fs.copyFile(home.database.binding.paths.databasePath, file);
    const disk = new Database(file, { readonly: true });
    try {
      assert.deepEqual(disk.prepare("SELECT title FROM conversation WHERE id IN ('race_shared','race_new') ORDER BY title").pluck().all(),
        ['race_new', 'race_shared']);
    } finally { disk.close(); }
  });
  const retried = await merge(home, [source]);
  clean(retried);
  assert.deepEqual(events, ['assert', 'checkpoint']);
  assert.deepEqual([retried.merged[0].alreadyMerged, retried.merged[0].insertedRows, retried.merged[0].backupPath], [true, 0, undefined]);
  assert.equal((await ledger(home, source)).state, 'merged');
});

test('共享消息、子树和确切关系边传播归属，健康无关对话保持可用', async () => {
  const database = new Database(':memory:');
  const domains = ['Conversation', 'Turn', 'ToolCall', 'Message', 'MessagePartOfConversation', 'MessageTurnLink',
    'ConversationOriginLink', 'ConversationBranchLink', 'ChildExecution', 'ChildExecutionParentLink'];
  const graph = [];
  try {
    for (const name of domains) {
      const schema = schemas.find(schema => schema.key === name);
      database.exec(`CREATE TABLE "${schema.table}" (${schema.columns.map(column => `"${column.name}" ${column.type}`).join(',')})`);
    }
    const add = (domain, row) => {
      const schema = schemas.find(schema => schema.key === domain);
      const fields = Object.keys(row);
      database.prepare(`INSERT INTO "${schema.table}" (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...Object.values(row));
      graph.push([domain, row]);
    };
    for (const id of ['parent', 'one', 'two', 'unrelated']) add('Conversation', { id, title: id });
    add('Turn', { id: 'parent_turn', conversation_id: 'parent' });
    for (const id of ['one', 'two']) {
      add('ChildExecution', { id: `${id}_child`, child_conversation_id: id });
      add('ChildExecutionParentLink', { id: `${id}_parent`, child_execution_id: `${id}_child`, parent_turn_id: 'parent_turn' });
    }
    add('Message', { id: 'shared_message' });
    for (const id of ['parent', 'one']) add('MessagePartOfConversation', { id: `${id}_member`, conversation_id: id, message_id: 'shared_message' });
    const resolver = load('runtimeMergeConversationOwnership.js').createRuntimeMergeConversationOwnership(database);
    assert.deepEqual([...resolver.resolve('Message', { id: 'shared_message' })].sort(), ['one', 'parent']);
    assert.deepEqual([...resolver.resolve('MessagePartOfConversation', { id: 'one_member', conversation_id: 'one', message_id: 'shared_message' })], ['one']);
    assert.deepEqual([...resolver.expandChildTrees(new Set(['one']))].sort(), ['one', 'parent', 'two']);
    const exclusions = new (load('runtimeMergeConversationExclusions.js').RuntimeMergeConversationExclusions)(database);
    try {
      for (const [domain, row] of graph) exclusions.observe(domain, row);
      exclusions.exclude('Conversation', { id: 'parent' }, 'runtime-data-set-merge-unfinished-work');
      await exclusions.finish(7);
      exclusions.exclude('Conversation', { id: 'one' }, 'runtime-data-set-merge-conflict');
      await exclusions.finish(7);
      assert.deepEqual(exclusions.excluded().map(row => [row.conversationId, row.code]),
        [['one', 'runtime-data-set-merge-conflict'], ['parent', 'runtime-data-set-merge-conflict'], ['two', 'runtime-data-set-merge-conflict']]);
      assert.equal(exclusions.includes('Conversation', 'unrelated'), false);
    } finally { exclusions.close(); }
  } finally { database.close(); }
});

async function deleteCommand(conversationId, recordDeleted) {
  const nothingRuns = async () => { throw new Error('No work is running in this fixture.'); };
  return stopAndDeleteConversation({ application: { database: home.database,
    conversationDeletion: new ConversationDeletionControlPlane(home.database) },
    conversations: { interrupt: nothingRuns }, childAgents: { interruptSubtree: nothingRuns, interruptFromConversation: nothingRuns },
    recordDeleted: recordDeleted ?? (ids => tombstones.recordRuntimeDeletedConversations(home.root, home.database.binding, ids))
  }, { conversationId, requestId: `ci-delete-${conversationId}` });
}

test('删除提交前把整子树持久记录到当前配置根和当前库身份', async () => {
  await home.database.transaction([
    repo('Conversation').insert(conversation('delete_parent')),
    repo('Turn').insert(terminatedTurn('delete_parent_turn', 'delete_parent')),
    repo('TurnTermination').insert({ id: 'delete_parent_terminal', turn_id: 'delete_parent_turn', terminal_status: 'completed', reason: 'fixture', created_at: NOW }),
    repo('Conversation').insert(conversation('delete_child')),
    repo('ChildExecution').insert({ id: 'delete_child_execution', child_conversation_id: 'delete_child', status: 'idle', created_at: NOW, updated_at: NOW }),
    repo('ConversationOriginLink').insert({ id: 'delete_child_origin', conversation_id: 'delete_child', source_conversation_id: 'delete_parent', source_turn_id: 'delete_parent_turn',
      source_tool_call_id: null, source_message_revision_id: null, created_at: NOW })
  ]);
  let beforeCommit;
  const result = await deleteCommand('delete_parent', async ids => {
    beforeCommit = [...ids].sort();
    assert.deepEqual(beforeCommit, ['delete_child', 'delete_parent']);
    for (const id of ids) assert.ok(await get('Conversation', id), 'the row still exists before deletion commit');
    const receipt = await tombstones.recordRuntimeDeletedConversations(home.root, home.database.binding, ids);
    const registered = await tombstones.readRuntimeDeletedConversations(home.root, [identity(home.current.binding)]);
    for (const id of ids) assert.equal(registered.has(id), true);
    return receipt;
  });
  assert.deepEqual([...result.deletedConversationIds].sort(), beforeCommit);
  assert.equal(result.deletionRecordError, undefined);
  for (const id of beforeCommit) assert.equal(await get('Conversation', id), null);
});

test('删除记录写失败仍提交删除，窗口提示以后合并旧拷贝可能复活的风险', async () => {
  await home.database.transaction([repo('Conversation').insert(conversation('delete_warning'))]);
  const directory = path.join(ledgerRoot(home), 'deleted-conversations');
  const saved = `${directory}-saved`;
  await fs.rename(directory, saved);
  await fs.writeFile(directory, 'occupied by a file');
  const { facade, warnings } = await deletionFacade(home);
  try {
    assert.deepEqual(await facade.deleteConversation('delete_warning'), ['delete_warning']);
    assert.equal(await get('Conversation', 'delete_warning'), null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /对话已删除，但没能记下删除记录，以后合并旧拷贝时这些对话可能会回来/);
    assert.match(warnings[0], /不是目录/);
  } finally {
    await facade.dispose();
    await fs.rm(directory);
    await fs.rename(saved, directory);
  }
});

test('旧身份删除记录与formerMergedInto闭包挡住子树复活，健康增量可合并', async () => {
  const source = await home.source('old-identity');
  await seed(source, [{ id: 'old_parent' }, { id: 'old_former_only' }, { id: 'old_safe' }]);
  raw(source, database => child(database, 'old_parent', 'old_child'));
  clean(await merge(home, [source]));
  await deleteCommand('old_parent');
  // This older deletion deliberately has no tombstone: only the former source closure proves it.
  await new ConversationDeletionControlPlane(home.database).delete('old_former_only');
  await seed(source, [{ id: 'old_increment' }, { id: 'old_alias_only' }]);
  const earlier = { dataSetId: randomUUID(), rootInstanceId: randomUUID() };
  const current = identity(home.current.binding);
  const aliasDirectory = path.join(ledgerRoot(home), 'aliases');
  await fs.mkdir(aliasDirectory, { recursive: true });
  const aliasFile = path.join(aliasDirectory, `${current.dataSetId}.${current.rootInstanceId}.json`);
  await fs.writeFile(aliasFile, JSON.stringify({ version: 1, continues: [{ ...earlier, relocationId: 'ci-relocation', at: NOW }] }));
  await tombstones.recordRuntimeDeletedConversations(home.root, earlier, ['old_alias_only']);
  // A real new incarnation occupies the same candidate path; the original stays in its archive.
  const archivePath = path.join(source.scopeRoot, '.limcode-runtime-backups', '20261013-000000-000-1badcafe');
  await fs.mkdir(path.dirname(archivePath), { recursive: true });
  await fs.rename(path.dirname(source.binding.paths.rootPointerPath), archivePath);
  const fresh = await home.source('old-identity');
  assert.equal(fresh.id, source.id);
  assert.notEqual(fresh.binding.dataSetId, source.binding.dataSetId);
  await seed(fresh, [{ id: 'old_fresh' }]);
  clean(await merge(home, [fresh]));
  const record = await ledger(home, fresh);
  assert.deepEqual(record.formerMergedInto.map(entry => [entry.source, entry.target, [...entry.conversationIds].sort()]),
    [[identity(source.binding), current, ['old_child', 'old_former_only', 'old_parent', 'old_safe']]]);
  const foreign = load('runtimeForeignHistory.js');
  const entry = (await foreign.discoverForeignRuntimeHistory({ configurationRootPath: home.root }))
    .find(entry => entry.location.containerPath === archivePath);
  assert.ok(entry, 'the exact archived original is discovered');
  const located = await foreign.locateForeignRuntimeRoot(home.root, entry.location);
  assert.deepEqual(identity(located.recorded), identity(source.binding));
  await histories.writeRuntimeHistoryPending(home.paths, { id: entry.id, sourceKind: entry.location.kind,
    location: entry.location, identity: identity(located.recorded), reason: 'recheck original incarnation', registeredAt: NOW });
  const report = await merge(home, [entry]);
  clean(report);
  assert.equal(report.merged[0].insertedConversations, 1);
  assert.equal(report.merged[0].skippedConversations, 3, 'the deleted child counts with its parent');
  assert.equal(await get('Conversation', 'old_parent'), null);
  assert.equal(await get('Conversation', 'old_child'), null);
  assert.equal(await get('Conversation', 'old_former_only'), null, 'the former closure alone prevents resurrection');
  assert.equal(await get('Conversation', 'old_alias_only'), null, 'the continued identity tombstone alone prevents resurrection');
  assert.ok(await get('Conversation', 'old_safe'));
  assert.ok(await get('Conversation', 'old_increment'));
  assert.ok(await get('Conversation', 'old_fresh'));
  assert.deepEqual((await ledger(home, fresh)).formerMergedInto, record.formerMergedInto);
});

test('坏删除记录或身份延续登记使合并推迟，修复后才写入', async () => {
  const source = await home.source('bad-registry');
  await seed(source, [{ id: 'registry_safe' }]);
  const current = identity(home.current.binding);
  const directory = path.join(ledgerRoot(home), 'deleted-conversations', `${current.dataSetId}.${current.rootInstanceId}`);
  await fs.mkdir(directory, { recursive: true });
  const bad = path.join(directory, '20261013T000000000Z-0000abcd.json');
  await fs.writeFile(bad, '{"version":1');
  const rejected = await merge(home, [source]);
  assert.deepEqual(rejected.deferred.map(row => row.code), ['runtime-merge-records-unreadable']);
  assert.equal(await get('Conversation', 'registry_safe'), null);
  assert.equal(await ledger(home, source), undefined);
  await fs.rm(bad);
  const aliasFile = path.join(ledgerRoot(home), 'aliases', `${current.dataSetId}.${current.rootInstanceId}.json`);
  const alias = await fs.readFile(aliasFile);
  await fs.writeFile(aliasFile, '{"version":1');
  try {
    const aliasesRejected = await merge(home, [source]);
    assert.deepEqual(aliasesRejected.deferred.map(row => row.code), ['runtime-merge-records-unreadable']);
    assert.equal(await ledger(home, source), undefined);
  } finally { await fs.writeFile(aliasFile, alias); }
  clean(await merge(home, [source]));
  assert.ok(await get('Conversation', 'registry_safe'));
});

const authorityCompiler = { async compile(request) {
  return { turnId: request.turnId, executorAgentId: request.executorAgentId,
    executionPreset: { content: JSON.stringify({ providerConfigId: 'fixture', modelId: 'fixture' }) },
    authoritySnapshot: { content: JSON.stringify({ kind: 'effective-turn-authority', turnId: request.turnId, executorAgentId: request.executorAgentId,
      modelProfile: { compressionThresholdTokens: 100000, contextWindowTokens: 128000, tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
      model: { providerConfigId: 'fixture', modelId: 'fixture' }, policies: { toolPolicyId: 'fixture', systemPromptId: 'fixture' } }) } };
} };
const lease = database => ({ leaseOwnerId: 'fixture', hostBootId: database.hostBootId,
  leaseExpiresAt: new Date(Date.now() + 300000).toISOString(), executorAgentId: 'fixture' });

async function queuedSource(name, delivery = false, existingSource) {
  const source = existingSource ?? await home.source(name);
  const id = `${name}_conversation`;
  await seed(source, [{ id }, ...(!existingSource ? [{ id: `${name}_safe` }] : []),
    ...(delivery ? [{ id: `${name}_sender` }] : [])]);
  if (delivery) await collaboration(source, `${name}_sender`, id, `${name}_message`);
  const database = await kernel.RuntimeDatabase.open(source.authority, { hostBootId: `${name}-old-host` });
  let result;
  try {
    const store = kernel.ContentAddressedStore.forDatabase(source.authority, database);
    await database.transaction([emptyConversationContextHandleStateStep(id, NOW)]);
    const turns = new TurnControlPlane(database, store, { authorityCompiler });
    const command = { conversationId: id, ...lease(database) };
    const active = await turns.input({ ...command, source: { kind: 'command', key: `${name}-active` }, content: 'active user input' });
    const queued = await turns.input({ ...command, source: { kind: 'command', key: `${name}-queued` }, content: 'queued user input' });
    assert.equal(active.admitted, true);
    assert.equal(queued.admitted, false);
    let pendingDelivery;
    if (delivery) {
      const runtime = load('runtimeServices.js').createReliableKernelRuntimeServices(database, store, { authorityCompiler });
      pendingDelivery = (await runtime.deliveries.create({ inboxItemId: `${name}_message_inbox`, targetConversationId: id,
        targetTurnId: active.turnId, phase: 'current_turn' })).delivery;
    }
    result = { source, id, active, queued, pendingDelivery };
  } finally { await database.close(); }
  return result;
}

test('public队列先于SIGKILL遗留Turn收尾取消，重扫和重开完整Runtime均不调用Provider', async t => {
  const source = await home.source('crash-source');
  const second = await home.source('crash-second');
  await seed(second, [{ id: 'crash_second_history' }]);
  await bareTurn(second, 'crash_second_history');
  const ready = path.join(home.base, 'crash-ready.json');
  const process = startChild('runtime-dataset-merge-crash-child.mjs', [source.scopeRoot, home.settingsRoot, ready]);
  t.after(() => process.child.kill());
  await waitForFile(ready, process);
  process.child.kill('SIGKILL');
  assert.equal((await process.exited).signal, 'SIGKILL');
  const { queued } = JSON.parse(await fs.readFile(ready, 'utf8'));
  const activeTurnId = read(source, database => database.prepare("SELECT id FROM turn WHERE status='active'").pluck().get());
  read(source, database => {
    assert.equal(database.prepare("SELECT COUNT(*) FROM turn WHERE status='active'").pluck().get(), 1n);
    assert.equal(database.prepare('SELECT COUNT(*) FROM execution_lease').pluck().get(), 1n);
    assert.equal(database.prepare("SELECT COUNT(*) FROM turn_intent WHERE state='queued'").pluck().get(), 1n);
    assert.ok(database.prepare("SELECT COUNT(*) FROM model_request WHERE status<>'terminal'").pluck().get() > 0n);
  });
  const interrupt = TurnControlPlane.prototype.requestExternalInterrupt;
  let queueWasCancelled = false;
  t.mock.method(TurnControlPlane.prototype, 'requestExternalInterrupt', async function (conversationId, ...args) {
    if (conversationId === 'crash_conversation') {
      const [intent] = (await this.database.snapshot([repo('TurnIntent').get(queued.intentId)])).snapshot;
      queueWasCancelled = intent.state === 'cancelled';
      assert.equal(queueWasCancelled, true, 'the public queued input is durable-cancelled before the Turn stop request');
    }
    return interrupt.call(this, conversationId, ...args);
  });
  let confirmations = 0;
  let backups = 0;
  const report = await merge(home, [source, second], { async confirmSettlement(input) {
    confirmations++;
    assert.deepEqual(input.sources.map(row => row.candidateId).sort(), [source.id, second.id].sort());
    return true;
  }, async onFaultPoint(point) {
    if (point !== 'after-source-backup') return;
    backups++;
    for (const item of [source, second]) assert.equal(await load('runtimeHistoryConvergence.js').readRuntimeHistorySettlementConsent(home.paths,
      { candidateId: item.id, ...identity(item.binding), turns: 1, intents: item === source ? 1 : 0 }), true);
  } });
  clean(report);
  assert.equal(confirmations, 1);
  assert.equal(backups, 2);
  assert.equal(report.merged.reduce((n, item) => n + item.finalized.turns, 0), 2);
  assert.equal(queueWasCancelled, true);
  assert.equal((await get('TurnIntent', queued.intentId)).state, 'cancelled');
  assert.equal((await get('Turn', activeTurnId)).status, 'terminated');
  const targetTurns = new TurnControlPlane(home.database, home.store, { authorityCompiler: {
    async compile() { assert.fail('Merged public queue must not admit another Turn.'); }
  } });
  assert.equal(await targetTurns.admitNextQueued({ conversationId: 'crash_conversation', ...lease(home.database) }), null);
  const original = report.merged.find(item => item.candidateId === source.id);
  const backup = new Database(path.join(original.finalized.sourceBackupPath, 'limcode.sqlite'), { readonly: true });
  try {
    assert.equal(backup.prepare('SELECT state FROM turn_intent WHERE id=?').pluck().get(queued.intentId), 'queued');
    assert.equal(backup.prepare('SELECT status FROM turn WHERE id=?').pluck().get(activeTurnId), 'active');
  } finally { backup.close(); }
  await home.live.app.refreshExternalRuntimeWork();
  await home.live.runner.recoverStartup();
  await home.live.coordinator.recoverStartup();
  await home.live.runner.waitForIdle();
  await home.live.coordinator.waitForIdle();
  assert.deepEqual(home.live.calls, []);
  const originalCheckpoints = read(source, database => database.prepare('SELECT id FROM model_stream_checkpoint ORDER BY id').pluck().all());
  assert.ok(originalCheckpoints.length > 0);
  for (const id of originalCheckpoints) assert.ok(await get('ModelStreamCheckpoint', id));
  await home.live.close();
  const reopened = await openFullRuntime({ authority: home.current.authority, settingsRoot: home.settingsRoot, hostLabel: 'ci-core-reopened',
    async send() { assert.fail('No model call after reopening merged history.'); } });
  try {
    const recovered = await reopened.startupRecovery();
    await reopened.runner.waitForIdle();
    await reopened.coordinator.waitForIdle();
    assert.deepEqual(reopened.calls, []);
    assert.deepEqual(recovered.runnerReport.resumedTurnIds, []);
    assert.deepEqual(recovered.runnerReport.queuedConversationIds, []);
  } finally { await reopened.close(); }
});
