import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { before, after, describe, test } from 'node:test';
import {
  Database, kernel, kernelFile, modelRequestAggregate, NOW, repo, readAll, readLedgerRecord,
  ledgerEntries, countRows
} from './fixtures/runtime-merge-fixture.mjs';
import {
  OPTIONS, conversation, createStreamFixture, seedBare, seedRich, seedAggregate, raw,
  runCrashChild, assertMixedBodies
} from './fixtures/ci-storage-merge-streamed.mjs';

const { RUNTIME_DOMAIN_SCHEMAS } = kernelFile('schema/domainManifest.js');
const { scanMergeRows, reinspectLargeMergeKeptWork, RUNTIME_DATA_SET_MERGE_CANCELLED } = kernelFile('runtimeDataSetStreamedMerge.js');
const { createRuntimeDataSetDatabaseSnapshot } = kernelFile('runtimeStorageInspection.js');
const { resolveVscodeRuntimeDataSet } = kernelFile('vscodeRootAuthority.js');
const { auditRuntimeSnapshot } = kernelFile('runtimeSnapshotAudit.js');
const { sweepDataRootRelocationLeftovers } = kernelFile('runtimeDataRootRelocation.js');
const { HistoryPreparationAdmission } = kernelFile('historyPreparationAdmission.js');
const { preparedContentObjectSteps } = kernelFile('contentObjectTransaction.js');
const { savepoint } = kernelFile('repositories.js');
const INVARIANT = 'runtime-data-set-merge-invariant';

function minimalSource() {
  const source = new Database(':memory:');
  source.defaultSafeIntegers(true);
  source.exec("CREATE TABLE root_binding(singleton INTEGER PRIMARY KEY, data_set_id TEXT, root_instance_id TEXT); INSERT INTO root_binding VALUES (1, 'ci-scan-source', 'ci-scan-root')");
  for (const schema of RUNTIME_DOMAIN_SCHEMAS) source.exec(`CREATE TABLE "${schema.table}" (${schema.columns.map(column =>
    `"${column.name}" ${column.type}${column.name === 'id' ? ' PRIMARY KEY' : ''}`).join(',')})`);
  source.exec('CREATE TEMP TABLE limcode_merge_skip (domain TEXT, id TEXT, PRIMARY KEY(domain,id)) WITHOUT ROWID');
  return source;
}

async function snapshotRows(database, domain, ids) {
  return (await database.snapshot(ids.map(id => repo(domain).get(id)))).snapshot;
}

// Savepoint rollback must revoke the writer's transaction-local historical-copy authority. A
// subsequent ordinary insertion with the same id cannot inherit permission to copy a stream fence.
async function assertSavepointAuthority(database, authority) {
  const id = 'savepoint_owner';
  const store = kernel.ContentAddressedStore.forDatabase(authority, database);
  const recipe = await store.prepare(database, JSON.stringify({ kind: 'reliable-agent-turn', conversationId: id,
    turnId: `${id}_turn`, modelHandleCatalog: { entries: [] }, tools: [] }), 'application/json');
  await database.transaction([
    ...preparedContentObjectSteps([recipe], 'savepoint_recipe'),
    repo('Conversation').insert(conversation(id)),
    repo('Turn').insert({ id: `${id}_turn`, conversation_id: id, status: 'active', created_at: NOW, updated_at: NOW, terminal_at: null }),
    repo('AuthoritySnapshot').insert({ id: 'savepoint_authority', turn_id: `${id}_turn`, content_object_id: recipe.metadata.id, created_at: NOW })
  ]);
  const request = 'savepoint_request';
  const historical = modelRequestAggregate(`${id}_turn`, request, 1n,
    { recipe: recipe.metadata.id, body: recipe.metadata.id, checkpoints: 0 });
  historical.find(step => step.domain === 'ModelRequest').row.authority_snapshot_id = 'savepoint_authority';
  const copied = historical.filter(step => step.domain !== 'ModelStreamFence');
  const ordinary = copied.map(step => repo(step.domain).insert({ ...step.row,
    ...(step.domain === 'ModelRequest' ? { status: 'prepared', terminal_state: null } : { status: 'pending' }),
    ...(step.domain === 'Attempt' ? { completed_at: null } : {})
  }));
  await assert.rejects(database.transaction([
    savepoint('rolled_back_copy', [...copied, repo('Conversation').insert(conversation(id))],
      { kind: 'rollback-and-continue-on-unique', constraints: [{ domain: 'Conversation', columns: ['id'] }] }),
    ...ordinary,
    repo('ModelStreamFence').insertHistoricalCopy({ id: `${request}_fence`, model_request_id: request,
      attempt_seq: 1n, socket_generation: 0n, terminal_stream_seq: 0n, outcome: 'completed', created_at: NOW })
  ]), /Historical ModelStreamFence copy requires its ModelRequest to be copied in the same transaction/);
  assert.deepEqual(await snapshotRows(database, 'ModelRequest', [request]), [null]);
  assert.deepEqual(await snapshotRows(database, 'ModelStreamFence', [`${request}_fence`]), [null]);
  await database.transaction([
    repo('Turn').update(`${id}_turn`, { status: 'terminated', terminal_at: NOW, updated_at: NOW }),
    repo('TurnTermination').insert({ id: `${id}_termination`, turn_id: `${id}_turn`, terminal_status: 'completed', reason: 'fixture', created_at: NOW })
  ]);
}

describe('历史合并的流式提交与有界读取', { concurrency: false }, () => {
  let f;
  before(async () => { f = await createStreamFixture(); });
  after(async () => { await f?.dispose(); });

  test('同一流式session保留partial闭包、零新增屏障和丢回复的实际计数', async t => {
    const source = f.alpha;
    const noop = f.beta;
    const reply = await f.source('reply-loss');
    const info = await seedRich(source, 'equivalence', { partial: true });
    raw(source, db => db.prepare('DELETE FROM model_stream_fence WHERE model_request_id = ?').run('equivalence_invalid_request'));
    await seedBare(noop, ['stream_noop']);
    await seedBare(reply, ['reply_shared', 'reply_new']);
    await (await f.writer()).transaction([repo('Conversation').insert({ ...conversation('equivalence_conflict'), title: 'current title' })]);
    const preparation = await f.prepare([source, noop, reply]);
    assert.equal(preparation.sources.length, 3);
    const planned = new Map(preparation.sources.map(row => [row.candidateId, row.insertRows]));
    assert.equal(planned.get(noop.id), 1);
    assert.equal(planned.get(reply.id), 2);
    await (await f.writer()).transaction(['stream_noop', 'reply_shared'].map(id => repo('Conversation').insert(conversation(id))));
    await f.closeCurrent();
    const before = countRows(f.current);
    const checkpoint = kernel.RuntimeDatabase.prototype.durabilityCheckpoint;
    const commit = kernel.RuntimeDatabase.prototype.maintenanceCommit;
    let candidateId, barriers = 0, lost = 0;
    t.mock.method(kernel.RuntimeDatabase.prototype, 'durabilityCheckpoint', async function () {
      if (this.binding.dataSetId === f.current.binding.dataSetId) {
        barriers++;
        assert.equal(candidateId, noop.id);
        assert.equal((await readLedgerRecord(f, noop.id)).state, 'committing');
      }
      return checkpoint.call(this);
    });
    t.mock.method(kernel.RuntimeDatabase.prototype, 'maintenanceCommit', async function (...args) {
      const result = await commit.apply(this, args);
      if (candidateId === reply.id) { lost++; throw new Error('commit reply lost'); }
      return result;
    });
    const result = await f.run(preparation, { onFaultPoint(point, detail) {
      if (point === 'before-source') candidateId = detail.candidateId;
    } });
    assert.equal(barriers, 1);
    assert.equal(lost, 1);
    const actual = new Map(result.results.map(row => [row.candidateId, row]));
    assert.equal(actual.get(source.id).state, 'merged');
    assert.deepEqual([actual.get(noop.id).state, actual.get(noop.id).result.insertedRows, actual.get(noop.id).result.reusedRows],
      ['current', 0, 1]);
    assert.deepEqual([actual.get(reply.id).state, actual.get(reply.id).result.insertedRows, actual.get(reply.id).result.reusedRows],
      ['merged', 1, 1]);
    assert.equal(countRows(f.current) - before, actual.get(source.id).result.insertedRows + 1);
    assert.equal((await readLedgerRecord(f, noop.id)).state, 'merged');
    assert.equal((await readLedgerRecord(f, reply.id)).insertedRows, 1);
    const record = await readLedgerRecord(f, source.id);
    assert.equal(record.state, 'partial');
    assert.deepEqual(record.excluded.map(row => row.conversationId).sort(),
      ['equivalence_child', 'equivalence_conflict', 'equivalence_invalid']);
    assert.deepEqual(record.mergedInto[0].conversationIds.sort(), ['equivalence_healthy', 'equivalence_peer']);
    const database = await f.writer();
    await assertMixedBodies(assert, source, info, database, f.current.authority);
    const [message] = await snapshotRows(database, 'CollaborationMessage', ['equivalence_collaboration']);
    assert.equal(message.message_seq, 1n);
    const [request] = await snapshotRows(database, 'ModelRequest', [info.requestId]);
    assert.deepEqual([request.turn_id, request.status, request.terminal_state], ['equivalence_healthy_turn', 'terminal', 'completed']);
    const checkpoints = await snapshotRows(database, 'ModelStreamCheckpoint', [`${info.requestId}_checkpoint_1`, `${info.requestId}_checkpoint_2`]);
    assert.deepEqual(checkpoints.map(row => [row.model_request_id, row.stream_seq, row.content_object_id]),
      [[info.requestId, 1n, info.bodies[0].id], [info.requestId, 2n, info.bodies[0].id]]);
    const [fence] = await snapshotRows(database, 'ModelStreamFence', [`${info.requestId}_fence`]);
    assert.deepEqual([fence.model_request_id, fence.terminal_stream_seq, fence.outcome], [info.requestId, 2n, 'completed']);
    assert.equal((await snapshotRows(database, 'Conversation', ['equivalence_conflict']))[0].title, 'current title');
    assert.deepEqual(await snapshotRows(database, 'Conversation', ['equivalence_child', 'equivalence_invalid']), [null, null]);
  });

  test('HistoryPreparationPermit取消不创建计划，第二来源取消仅回滚该来源', async () => {
    const sources = [await f.source('cancel-a'), await f.source('cancel-b')];
    await seedBare(sources[0], ['cancel_a']);
    await seedBare(sources[1], ['cancel_b']);
    const admission = new HistoryPreparationAdmission(1);
    let unblock, entered, permit;
    const activeEntered = new Promise(resolve => { entered = resolve; });
    const active = admission.run(async current => {
      permit = current;
      entered();
      await new Promise(resolve => { unblock = resolve; });
      return admission.run(async nested => { assert.equal(nested, current); nested.assertActive(); return f.prepare(sources, { chunkRows: 1 }); }, { permit: current });
    });
    await activeEntered;
    const queuedAbort = new AbortController();
    const reason = new Error('queued preparation cancelled');
    const queued = admission.run(async () => assert.fail('取消的排队准备创建了计划'), { signal: queuedAbort.signal });
    const rejected = assert.rejects(queued, error => error === reason);
    queuedAbort.abort(reason);
    await rejected;
    unblock();
    const preparation = await active;
    await admission.whenIdle();
    assert.throws(() => permit.assertActive(), /no longer active/);
    await assert.rejects(admission.run(async () => {}, { permit }), /stale/);
    assert.equal(preparation.sources.length, 2);
    const [first, second] = preparation.sources;
    const cancelled = new AbortController();
    const result = await f.run(preparation, { chunkRows: 1, onFaultPoint(point, detail) {
      if (point === 'after-chunk' && detail.candidateId === second.candidateId) cancelled.abort();
    } }, cancelled.signal);
    assert.equal(result.cancelled, true);
    assert.deepEqual(result.results.map(row => [row.state, row.issue?.code]), [['merged', undefined], ['deferred', RUNTIME_DATA_SET_MERGE_CANCELLED]]);
    assert.equal((await readLedgerRecord(f, first.candidateId)).state, 'merged');
    assert.equal(await readLedgerRecord(f, second.candidateId), undefined);
    const firstId = sources.find(source => source.id === first.candidateId) === sources[0] ? 'cancel_a' : 'cancel_b';
    const secondId = firstId === 'cancel_a' ? 'cancel_b' : 'cancel_a';
    const [kept, rolledBack] = await snapshotRows(await f.writer(), 'Conversation', [firstId, secondId]);
    assert.equal(kept.id, firstId);
    assert.equal(rolledBack, null);
  });

  test('savepoint撤回历史复制许可，最终writer拒绝preflight之后的非法Attempt', async t => {
    await assertSavepointAuthority(await f.writer(), f.current.authority);
    const source = await f.source('aggregate');
    const info = await seedAggregate(source, 'aggregate');
    await f.closeCurrent();
    const before = readAll(f.current);
    const commit = kernel.RuntimeDatabase.prototype.maintenanceCommit;
    t.mock.method(kernel.RuntimeDatabase.prototype, 'maintenanceCommit', async function (...args) {
      await this.maintenanceAppend([repo('Attempt').insertHistoricalCopy({
        id: 'aggregate_injected_attempt', operation_id: `${info.requestId}_operation`, attempt_seq: 2n,
        status: 'completed', created_at: NOW, updated_at: NOW, completed_at: NOW
      })]);
      return commit.apply(this, args);
    });
    const preparation = await f.prepare([source]);
    assert.equal(preparation.sources.length, 1);
    const result = await f.run(preparation);
    assert.deepEqual(result.results.map(row => [row.state, row.issue?.code]), [['blocked', INVARIANT]]);
    assert.match(result.results[0].issue.message, /current Attempt must be the contiguous tail/);
    assert.deepEqual(readAll(f.current), before);
  });

  test('after-commit一次实杀通过提交标记恢复，重入不重复插入', async t => {
    const source = await f.source('crash');
    await seedBare(source, ['crash_a', 'crash_b']);
    const original = readAll(source);
    await f.closeCurrent();
    const temporary = path.join(f.root, 'crash-private-temp');
    await fs.mkdir(temporary);
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const killed = await runCrashChild(f, source, temporary);
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const committing = await readLedgerRecord(f, source.id);
    assert.equal(committing.state, 'committing');
    await sweepDataRootRelocationLeftovers(f.root);
    const recovered = await f.online(source, { sizeLimits: OPTIONS.sizeLimits });
    assert.deepEqual([recovered.failures, recovered.blocked, recovered.deferred], [[], [], []]);
    assert.equal(recovered.merged.length, 1);
    assert.equal(recovered.merged[0].recoveredCommit, true);
    assert.equal(recovered.merged[0].insertedRows, 2);
    const record = await readLedgerRecord(f, source.id);
    assert.equal(record.state, 'merged');
    assert.deepEqual(record.mergedInto[0].conversationIds.sort(), ['crash_a', 'crash_b']);
    const again = await f.online(source);
    assert.equal(again.merged[0].insertedRows, 0);
    assert.equal(again.merged[0].alreadyMerged, true);
    assert.deepEqual(readAll(source), original);
    assert.deepEqual(await ledgerEntries(f, 'commits'), []);
  });

  test('全跳过501条原始行仍让出并取消，保留协作记录按sequence读', async t => {
    const source = minimalSource();
    t.after(() => source.close());
    const insert = source.prepare('INSERT INTO conversation VALUES (?, ?, ?, ?, ?)');
    const skip = source.prepare("INSERT INTO temp.limcode_merge_skip VALUES ('Conversation', ?)");
    source.transaction(() => {
      for (let index = 0; index < 501; index++) {
        insert.run(`skipped_${index}`, `skipped_${index}`, 'active', NOW, NOW);
        skip.run(`skipped_${index}`);
      }
    })();
    const abort = new AbortController();
    const requested = setImmediate(() => abort.abort());
    t.after(() => clearImmediate(requested));
    let reads = 0;
    await assert.rejects(scanMergeRows(source, { snapshot: async () => { reads++; return { snapshot: [] }; }, mergeModelAggregates: async () => [] },
      { skipping: true, chunkRows: 10_000, signal: abort.signal }), { name: 'AbortError' });
    assert.equal(reads, 0);
    assert.equal(source.inTransaction, false);
    source.exec('DELETE FROM conversation; DELETE FROM temp.limcode_merge_skip;');
    for (const sequence of [40, 10, 30, 20]) source.prepare('INSERT INTO collaboration_message VALUES (?, ?, ?, ?, ?)')
      .run(`m_${sequence}`, `k_${sequence}`, sequence, sequence === 20 ? 'invalid-skipped-mode' : 'message', NOW);
    source.prepare("INSERT INTO temp.limcode_merge_skip VALUES ('CollaborationMessage', 'm_20')").run();
    const visited = [];
    const result = await scanMergeRows(source, { snapshot: async requests => {
      visited.push(...requests.filter(row => row.domain === 'CollaborationMessage').map(row => row.id));
      return { snapshot: requests.map(() => null) };
    }, mergeModelAggregates: async () => [] }, { skipping: true, chunkRows: 1 });
    assert.deepEqual(visited, ['m_10', 'm_30', 'm_40']);
    assert.equal(result.rows, 3);
  });

  test('私有reader交接拒绝忙连接与硬链接，worker失败后重开并有界重检', async t => {
    const source = await f.source('handoff');
    await seedBare(source, ['handoff_kept', 'handoff_removed']);
    const candidate = await resolveVscodeRuntimeDataSet(f.paths, source.id);
    const snapshot = await createRuntimeDataSetDatabaseSnapshot(candidate, source.binding);
    t.after(() => snapshot.close());
    const reader = snapshot.database;
    let entered = false;
    const handoff = async () => { entered = true; };
    reader.exec('BEGIN');
    await assert.rejects(snapshot.withClosedReader(handoff), /idle private read-only snapshot/);
    reader.exec('ROLLBACK');
    const iterator = reader.prepare('SELECT id FROM conversation').iterate();
    iterator.next();
    await assert.rejects(snapshot.withClosedReader(handoff), /busy|iterat/i);
    iterator.return();
    const link = `${reader.name}.link`;
    await fs.link(reader.name, link);
    try { await assert.rejects(snapshot.withClosedReader(handoff), /separate, link-free/); }
    finally { await fs.rm(link); }
    assert.equal(entered, false);
    await assert.rejects(snapshot.withClosedReader(async copy => {
      assert.equal(reader.open, false);
      return auditRuntimeSnapshot(copy, { binding: { ...source.binding, rootInstanceId: 'wrong-root' }, unfinishedWork: 'finalize' });
    }), /RootBinding|root_instance|binding|root instance/i);
    const reopened = snapshot.database;
    assert.notEqual(reopened, reader);
    assert.equal(reopened.readonly, true);
    reopened.pragma('query_only = OFF');
    reopened.exec("CREATE TEMP TABLE limcode_merge_skip (domain TEXT, id TEXT, PRIMARY KEY(domain,id)) WITHOUT ROWID; INSERT INTO temp.limcode_merge_skip VALUES ('Conversation', 'handoff_removed')");
    reopened.pragma('query_only = ON');
    const inspection = await reinspectLargeMergeKeptWork(snapshot);
    assert.deepEqual(inspection, { refused: [], turns: [], intents: [] });
    assert.equal(reopened.open, false);
    assert.notEqual(snapshot.database, reopened);
    assert.equal(snapshot.database.readonly, true);
    assert.equal(snapshot.database.inTransaction, false);
  });
});
