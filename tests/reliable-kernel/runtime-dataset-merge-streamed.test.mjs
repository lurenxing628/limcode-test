import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  countRows, createConfigurationRoot, Database, kernel, kernelFile, ledgerEntries, NOW, rawWrite, readAll, readLedgerRecord,
  removeConfigurationRoot, saveState, seedConversations, seedRichSource, treeSnapshot
} from './fixtures/runtime-merge-fixture.mjs';

const {
  mergeHistoricalDataSetsOnline, readRuntimeDataSetMergeStates, requestRuntimeDataSetMerge, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE,
  RUNTIME_DATA_SET_MERGE_COMMIT_EVIDENCE_ROWS, RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS, RUNTIME_DATA_SET_STREAMED_MERGE_MAX_ROWS,
  RuntimeDataSetMergeEvidence
} = kernelFile('runtimeDataSetMerge.js');
const {
  prepareLargeMergeSources, releaseLargeMergePreparation, runLargeMergeSession, RUNTIME_DATA_SET_MERGE_CANCELLED
} = kernelFile('runtimeDataSetStreamedMerge.js');
const { ConversationDeletionControlPlane } = kernelFile('conversationDeletion.js');
const { withRuntimeDataRootAdmission, withRuntimeMaintenance } = kernelFile('runtimeHostControl.js');
const { resolveVscodeRuntimeMergeLedgerRoot } = kernelFile('vscodeRootAuthority.js');

/** Injected bounds: every fixture source is "large" and spans many chunks. */
const SMALL_LIMITS = { sizeLimits: { transactionRows: 50 }, chunkRows: 7 };

async function fixtureFor(t, options) {
  const fixture = await createConfigurationRoot(options);
  t.after(() => removeConfigurationRoot(fixture.root));
  return fixture;
}

function openWindow(fixture) {
  return kernel.RuntimeDatabase.open(fixture.current.authority, { hostBootId: `window-${randomUUID()}` });
}

/** The in-memory path: one ordinary online batch of this window. */
async function mergeOnline(fixture, options = {}) {
  const database = await openWindow(fixture);
  try {
    return await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database }, options);
  } finally { await database.close(); }
}

/**
 * The streamed path as the session's caller runs it: prepare online in the open window, close the
 * window's Runtime, then the session inside the configuration admission and the target maintenance claim.
 */
async function mergeStreamed(fixture, input = {}) {
  const database = await openWindow(fixture);
  let preparation;
  try {
    preparation = await prepareLargeMergeSources({
      paths: fixture.paths, target: { configurationRootPath: fixture.root, database },
      ...(input.candidateIds ? { candidateIds: input.candidateIds, requested: input.requested === true } : {}),
      ...(input.threshold ? { threshold: input.threshold } : {}),
      options: { ...SMALL_LIMITS, ...input.options }
    });
  } finally { await database.close(); }
  if (input.beforeSession) await input.beforeSession(preparation);
  const session = await withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths,
    () => runLargeMergeSession({ paths: fixture.paths, prepared: preparation, ...(input.signal ? { signal: input.signal } : {}), options: input.sessionOptions ?? {} })));
  return { preparation, session };
}

function assertSameRows(actual, expected, message) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${message}：表集合一致`);
  for (const table of Object.keys(expected)) assert.deepEqual(actual[table], expected[table], `${message}：${table} 逐行一致`);
}

async function mergedInto(fixture, candidateId) {
  const record = await readLedgerRecord(fixture, candidateId);
  return (record?.mergedInto ?? []).map((entry) => [entry.target.dataSetId, [...entry.conversationIds].sort()]);
}

test('等价性：同一来源走内存单事务与流式维护事务（阈值 50 行、每块 7 行），逐表逐行结果相同；再次合并时 #1 跳过闭包也相同', async (t) => {
  const fixture = await fixtureFor(t);
  // Shared with the target: a project and a message body (content identities), a collaboration history.
  await seedConversations(fixture.current, [{ id: 'current_conversation' }]);
  await seedConversations(fixture.current, [{ id: 'current_conversation_2' }]);
  const { seedCollaborationMessages, seedAttachmentObservation } = await import('./fixtures/runtime-merge-fixture.mjs');
  await seedCollaborationMessages(fixture.current, 'current_conversation', 'current_conversation_2', ['current_collaboration_1']);
  await seedAttachmentObservation(fixture.current, '2026-09-10T00:00:00.000Z', 'the target observed it first');
  const ids = await seedRichSource(fixture.alpha, 'alpha', 5);
  const rows = countRows(fixture.alpha);
  assert.ok(rows > 50 && rows <= RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS, `来源 ${rows} 行`);

  const before = await saveState(fixture, fixture.current);
  t.after(() => before.remove());
  const online = await mergeOnline(fixture);
  assert.deepEqual([online.merged.length, online.deferred, online.blocked, online.failures], [1, [], [], []]);
  const expected = readAll(fixture.current);
  const expectedInto = await mergedInto(fixture, fixture.alpha.id);
  await before.restore();

  const batch = await mergeOnline(fixture, { sizeLimits: SMALL_LIMITS.sizeLimits });
  assert.deepEqual(batch.deferred.map((issue) => [issue.code, issue.size?.rows]), [[RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE, rows]]);
  assert.equal(await readLedgerRecord(fixture, fixture.alpha.id), undefined, '等待大库会话不写账本');
  const { preparation, session } = await mergeStreamed(fixture, { candidateIds: [fixture.alpha.id] });
  assert.deepEqual(preparation.sources.map((source) => [source.candidateId, source.rows]), [[fixture.alpha.id, rows]]);
  assert.ok(preparation.estimateRangeMs[0] <= preparation.estimateMs && preparation.estimateMs <= preparation.estimateRangeMs[1]);
  assert.deepEqual(session.results.map((result) => [result.state, result.result?.insertedConversations, result.result?.exclusive]), [['merged', 5, true]]);
  assertSameRows(readAll(fixture.current), expected, '首次合并');
  assert.deepEqual(await mergedInto(fixture, fixture.alpha.id), expectedInto, '账本记下同样的对话');
  assert.deepEqual(await ledgerEntries(fixture, 'commits'), [], '提交凭据已删除');
  assert.deepEqual(await ledgerEntries(fixture, 'preparing'), [], '准备记录已释放');

  // #1: the user deletes a merged conversation here, the source goes on; an explicit merge again.
  const database = await openWindow(fixture);
  try { await new ConversationDeletionControlPlane(database).delete(ids[2]); } finally { await database.close(); }
  rawWrite(fixture.alpha, (source, contentId) => {
    const later = `${ids[2]}_later_turn`;
    source.prepare('INSERT INTO turn VALUES (?, ?, ?, ?, ?, ?)').run(later, ids[2], 'terminated', NOW, NOW, NOW);
    source.prepare('INSERT INTO turn_termination VALUES (?, ?, ?, ?, ?)').run(`${later}_termination`, later, 'completed', 'fixture', NOW);
    for (const [message, conversation] of [['gone_later_message', ids[2]], ['kept_linked_message', ids[0]]]) {
      source.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(message, NOW, NOW, null);
      source.prepare('INSERT INTO message_revision VALUES (?, ?, ?, ?, ?, ?)').run(`${message}_revision`, message, 1, 'user', contentId, NOW);
      source.prepare('INSERT INTO message_current_revision_link VALUES (?, ?, ?, ?)').run(`${message}_current`, message, `${message}_revision`, NOW);
      source.prepare('INSERT INTO message_part_of_conversation VALUES (?, ?, ?, ?, ?)').run(`${message}_member`, conversation, message, 10, NOW);
      source.prepare('INSERT INTO message_turn_link VALUES (?, ?, ?, ?, ?)').run(`${message}_turn_link`, later, message, 'user', NOW);
    }
    source.prepare('INSERT INTO interaction_request VALUES (?, ?, ?, ?, ?, ?)').run('gone_later_question', 'ask_user', 'answered', contentId, NOW, NOW);
    source.prepare('INSERT INTO interaction_owner_link VALUES (?, ?, ?, ?)').run('gone_later_question_owner', 'gone_later_question', later, NOW);
    source.prepare('INSERT INTO context_segment VALUES (?, ?, ?, ?)').run('gone_later_segment', contentId, 'message', NOW);
    source.prepare('INSERT INTO context_sequence_node VALUES (?, ?, ?, ?)').run('gone_later_node', null, 'gone_later_segment', NOW);
    source.prepare('INSERT INTO context_sequence_root VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('gone_later_root', ids[2], 1, 'gone_later_node', 'gone_later_node', 1, 1, 10, NOW);
    source.prepare("INSERT INTO conversation (id, title, status, created_at, updated_at) VALUES (?, 'child', 'active', ?, ?)").run('gone_child', NOW, NOW);
    source.prepare('INSERT INTO child_execution VALUES (?, ?, ?, ?, ?)').run('gone_child_execution', 'gone_child', 'idle', NOW, NOW);
    source.prepare('INSERT INTO conversation_origin_link VALUES (?, ?, ?, ?, ?, ?, ?)').run('gone_child_origin', 'gone_child', ids[2], later, null, null, NOW);
  });
  await seedConversations(fixture.alpha, [{ id: 'alpha_conversation_new' }]);
  const deleted = await saveState(fixture, fixture.current);
  t.after(() => deleted.remove());
  await requestRuntimeDataSetMerge(fixture.paths, { candidateId: fixture.alpha.id, expectedDataSetId: fixture.alpha.binding.dataSetId, expectedRootInstanceId: fixture.alpha.binding.rootInstanceId });
  const again = await mergeOnline(fixture, { candidateIds: [fixture.alpha.id], requested: true });
  assert.deepEqual(again.merged.map((item) => [item.insertedConversations, item.skippedConversations]), [[1, 1]]);
  const expectedAgain = readAll(fixture.current);
  const expectedIntoAgain = await mergedInto(fixture, fixture.alpha.id);
  await deleted.restore();
  const streamedAgain = await mergeStreamed(fixture, { candidateIds: [fixture.alpha.id], requested: true });
  assert.deepEqual(streamedAgain.preparation.sources.map((source) => source.skippedConversations), [1], '试算按同一闭包跳过');
  assert.deepEqual(streamedAgain.session.results.map((result) => [result.state, result.result?.insertedConversations, result.result?.skippedConversations]),
    [['merged', 1, 1]]);
  assertSameRows(readAll(fixture.current), expectedAgain, '再次合并');
  assert.deepEqual(await mergedInto(fixture, fixture.alpha.id), expectedIntoAgain);
  const target = new Database(fixture.current.binding.paths.databasePath, { readonly: true });
  try {
    assert.equal(target.prepare('SELECT COUNT(*) FROM conversation WHERE id IN (?, ?)').pluck().get(ids[2], 'gone_child'), 0, '删掉的对话与子对话没有插回');
    assert.deepEqual(target.pragma('foreign_key_check'), []);
  } finally { target.close(); }
});

test('分流：超过内存单事务上限的来源在任何规划、协调、备份、收尾之前推迟为“等待大库会话”，不写账本；4000 行以内照常在线合并', async (t) => {
  const fixture = await fixtureFor(t, { beta: true });
  await seedRichSource(fixture.alpha, 'alpha', 3);
  rawWrite(fixture.alpha, (source) => {
    source.prepare("INSERT INTO turn VALUES ('alpha_conversation_0_active', 'alpha_conversation_0', 'active', ?, ?, NULL)").run(NOW, NOW);
  });
  await seedConversations(fixture.beta, [{ id: 'beta_small' }]);
  const sourceBefore = await treeSnapshot(fixture.alpha.scopeRoot);
  const calls = [];
  const coordinateOversized = async (input, run) => { calls.push(input); await input.withLocks(run); return { state: 'completed' }; };
  const report = await mergeOnline(fixture, { sizeLimits: { transactionRows: 50 }, coordinateOversized });
  assert.deepEqual(report.merged.map((item) => item.candidateId), [fixture.beta.id], '小库照常在线合并');
  assert.deepEqual(report.deferred.map((issue) => [issue.candidateId, issue.code, issue.size?.rows > 50]),
    [[fixture.alpha.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE, true]]);
  assert.match(report.deferred[0].message, /要在所有窗口暂停时一次合并/);
  assert.deepEqual(calls, [], '不请求其它窗口让出');
  assert.equal(await readLedgerRecord(fixture, fixture.alpha.id), undefined);
  assert.deepEqual(await treeSnapshot(fixture.alpha.scopeRoot), sourceBefore, '没有收尾、没有来源备份');
  const states = await readRuntimeDataSetMergeStates(fixture.paths);
  assert.equal(states.get(fixture.alpha.id), undefined, '界面按待合并显示，不是“太大”');
});

test('旧记录：以前按内存上限（maxRows=60000）记下的 too-large 会被重新判定；按当前流式硬上限记下的来源不变就不再重试', async (t) => {
  const fixture = await fixtureFor(t);
  await seedConversations(fixture.alpha, [{ id: 'alpha_once_too_large' }]);
  const first = await mergeOnline(fixture, { sizeLimits: { streamedRows: 5 } });
  assert.deepEqual(first.blocked.map((issue) => issue.code), ['runtime-data-set-merge-too-large-for-one-transaction']);
  assert.match(first.blocked[0].message, /超过当前版本一次合并能安全处理的上限（5 条）/);
  const record = await readLedgerRecord(fixture, fixture.alpha.id);
  assert.deepEqual([record.state, record.maxRows], ['too-large', 5]);
  const again = await mergeOnline(fixture, { sizeLimits: { streamedRows: 5 } });
  assert.deepEqual([again.pendingSources, again.blocked[0]?.newly], [0, false], '上限不变就不再自动重试');
  const file = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'records', `${fixture.alpha.id.replace(/:/g, '-')}.json`);
  await fs.writeFile(file, JSON.stringify({ ...record, maxRows: RUNTIME_DATA_SET_STREAMED_MERGE_MAX_ROWS }));
  assert.deepEqual((await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id)?.state, 'too-large', '按当前硬上限记下的显示为太大');
  const known = await mergeOnline(fixture);
  assert.deepEqual([known.pendingSources, known.blocked[0]?.newly], [0, false]);
  // Written by an older version at the in-memory bound: judged again, and it merges.
  await fs.writeFile(file, JSON.stringify({ ...record, maxRows: 60_000 }));
  assert.equal((await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id), undefined);
  const judgedAgain = await mergeOnline(fixture);
  assert.deepEqual([judgedAgain.pendingSources, judgedAgain.merged.map((item) => item.insertedConversations)], [1, [1]]);
  assert.equal((await readLedgerRecord(fixture, fixture.alpha.id)).state, 'merged');
});

test('剔除等价性：冲突连带子 Agent 与跨对话链接，其余对话在线和流式都合并并记 partial', async (t) => {
  const fixture = await fixtureFor(t);
  await seedConversations(fixture.current, [{ id: 'alpha_conversation_1', title: 'current title' }]);
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const before = await saveState(fixture, fixture.current);
  t.after(() => before.remove());
  const online = await mergeOnline(fixture);
  assert.deepEqual([online.merged.length, online.blocked, online.failures], [1, [], []]);
  const expected = readAll(fixture.current);
  const onlineRecord = await readLedgerRecord(fixture, fixture.alpha.id);
  assert.equal(onlineRecord.state, 'partial');
  assert.deepEqual(onlineRecord.excluded.map(row => row.conversationId).sort(), ['alpha_conversation_0', 'alpha_conversation_1']);
  await before.restore();
  const { preparation, session } = await mergeStreamed(fixture, { candidateIds: [fixture.alpha.id], requested: true });
  assert.equal(preparation.sources.length, 1);
  assert.deepEqual(session.results.map(result => result.state), ['merged']);
  assertSameRows(readAll(fixture.current), expected, '剔除后在线与流式相同');
  const record = await readLedgerRecord(fixture, fixture.alpha.id);
  assert.equal(record.state, 'partial');
  assert.deepEqual(record.excluded, onlineRecord.excluded);
});

test('冲突：准备之后当前库又写入了同一记录的另一份内容，独占阶段整份回滚并记为受阻，当前库没有这份来源的任何行', async (t) => {
  const fixture = await fixtureFor(t);
  await seedRichSource(fixture.alpha, 'alpha', 3);
  let before;
  const { preparation, session } = await mergeStreamed(fixture, {
    candidateIds: [fixture.alpha.id],
    beforeSession: async () => {
      // Another window, before its reload, created the same conversation here with other content.
      await seedConversations(fixture.current, [{ id: 'alpha_conversation_2', title: 'changed here meanwhile' }]);
      before = readAll(fixture.current);
    }
  });
  assert.equal(preparation.sources.length, 1);
  assert.deepEqual(session.results.map((result) => [result.state, result.issue?.code]), [['blocked', 'runtime-data-set-merge-conflict']]);
  assert.match(session.results[0].issue.message, /Conversation#alpha_conversation_2 字段不同：title/);
  assertSameRows(readAll(fixture.current), before, '整份回滚');
  const record = await readLedgerRecord(fixture, fixture.alpha.id);
  assert.deepEqual([record.state, record.code], ['blocked', 'runtime-data-set-merge-conflict']);
  assert.deepEqual(await ledgerEntries(fixture, 'commits'), []);
  assert.deepEqual(await fs.readdir(path.join(path.dirname(fixture.current.binding.paths.dataRootPath), 'merge-backups')), [], '没有事务用上的备份在会话末尾删除');
});

test('准备记录：同一来源同一时间只有一个窗口准备并保留到会话结束，另一个窗口推迟；进程已不在或心跳过期的记录可以接手', async (t) => {
  const fixture = await fixtureFor(t);
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const database = await openWindow(fixture);
  const prepare = () => prepareLargeMergeSources({
    paths: fixture.paths, target: { configurationRootPath: fixture.root, database }, candidateIds: [fixture.alpha.id], options: SMALL_LIMITS
  });
  const preparingFile = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'preparing', `${fixture.alpha.id.replace(/:/g, '-')}.json`);
  try {
    const first = await prepare();
    assert.deepEqual(first.sources.map((source) => source.candidateId), [fixture.alpha.id]);
    const held = JSON.parse(await fs.readFile(preparingFile, 'utf8'));
    assert.equal(held.processId, process.pid);
    const second = await prepare();
    assert.deepEqual([second.sources, second.report.deferred.map((issue) => issue.code)], [[], ['runtime-data-set-merge-preparing-elsewhere']]);
    await releaseLargeMergePreparation(first);
    await assert.rejects(fs.stat(preparingFile), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(path.join(path.dirname(fixture.current.binding.paths.dataRootPath), 'merge-backups')), [], '未用上的备份随释放删除');
    // Another window's record: its process is gone, or its heartbeat stopped long ago.
    for (const record of [
      { processId: 4_194_304 + 4321, heartbeatAt: new Date().toISOString() },
      { processId: process.pid, heartbeatAt: new Date(Date.now() - 5 * 60_000).toISOString() }
    ]) {
      await fs.writeFile(preparingFile, JSON.stringify({
        kind: 'limcode-runtime-data-set-merge-preparation', candidateId: fixture.alpha.id, token: randomUUID(), startedAt: NOW, ...record
      }));
      const taken = await prepare();
      assert.deepEqual(taken.sources.map((source) => source.candidateId), [fixture.alpha.id], `接手 ${JSON.stringify(record)}`);
      assert.notEqual(JSON.parse(await fs.readFile(preparingFile, 'utf8')).token, held.token);
      await releaseLargeMergePreparation(taken);
    }
  } finally { await database.close(); }
});

test('磁盘满与取消：只回滚当前来源并撤掉它的 committing 记录，之前合并完的来源保留；空间预检不够时整批推迟、不写任何东西', async (t) => {
  const fixture = await fixtureFor(t, { beta: true });
  await seedRichSource(fixture.alpha, 'alpha', 3);
  await seedRichSource(fixture.beta, 'beta', 3);
  const initial = await saveState(fixture, fixture.current);
  t.after(() => initial.remove());
  const nothing = readAll(fixture.current);
  const both = await mergeStreamed(fixture, { candidateIds: [fixture.alpha.id, fixture.beta.id] });
  const [first, second] = both.preparation.sources.map((source) => source.candidateId);
  assert.deepEqual(both.session.results.map((result) => result.state), ['merged', 'merged']);
  await initial.restore();
  await mergeStreamed(fixture, { candidateIds: [first] });
  const firstOnly = readAll(fixture.current);
  await initial.restore();

  const small = await mergeStreamed(fixture, {
    candidateIds: [first, second], sessionOptions: { freeSpace: async () => 1024 }
  });
  assert.deepEqual(small.session.results.map((result) => [result.state, result.issue?.code]),
    [['deferred', 'runtime-data-set-merge-disk-full'], ['deferred', 'runtime-data-set-merge-disk-full']]);
  assert.match(small.session.results[0].issue.message, /磁盘空间不足，需要约 \d+ MB/);
  assertSameRows(readAll(fixture.current), nothing, '空间不够时一行不写');
  assert.equal(await readLedgerRecord(fixture, first), undefined);
  await assert.rejects(fs.stat(small.preparation.backupPath), { code: 'ENOENT' }, '没用上的准备备份已删除');
  assert.deepEqual(await ledgerEntries(fixture, 'preparing'), [], '准备记录已释放');
  await initial.restore();

  const full = await mergeStreamed(fixture, {
    candidateIds: [first, second],
    sessionOptions: {
      onFaultPoint: (point, detail) => {
        if (point === 'after-chunk' && detail?.candidateId === second && detail.chunk === 2) {
          throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
        }
      }
    }
  });
  assert.deepEqual(full.session.results.map((result) => [result.state, result.issue?.code]), [['merged', undefined], ['deferred', 'runtime-data-set-merge-disk-full']]);
  assert.match(full.session.results[1].issue.message, /磁盘空间不足，需要约 \d+ MB：合并这份旧聊天记录要在 .* 暂存数据，已撤回这份的写入/);
  assertSameRows(readAll(fixture.current), firstOnly, '只回滚当前来源');
  assert.equal(await readLedgerRecord(fixture, second), undefined, '确定回滚后撤掉 committing 记录');
  assert.equal((await readLedgerRecord(fixture, first)).state, 'merged');
  assert.deepEqual(await ledgerEntries(fixture, 'commits'), []);
  await initial.restore();

  const controller = new AbortController();
  const cancelled = await mergeStreamed(fixture, {
    candidateIds: [first, second], signal: controller.signal,
    sessionOptions: { onFaultPoint: (point, detail) => { if (point === 'after-chunk' && detail?.candidateId === second && detail.chunk === 1) controller.abort(); } }
  });
  assert.equal(cancelled.session.cancelled, true);
  assert.deepEqual(cancelled.session.results.map((result) => [result.state, result.issue?.code]), [['merged', undefined], ['deferred', RUNTIME_DATA_SET_MERGE_CANCELLED]]);
  assertSameRows(readAll(fixture.current), firstOnly, '取消只回滚当前来源');
  assert.equal(await readLedgerRecord(fixture, second), undefined);
});

test('来源变化：准备之后来源历史库又有变化，独占阶段在拷贝之前推迟为“来源有变化”，不写 committing，当前库不变，准备记录释放', async (t) => {
  const fixture = await fixtureFor(t);
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const before = readAll(fixture.current);
  const { preparation, session } = await mergeStreamed(fixture, {
    beforeSession: () => rawWrite(fixture.alpha, (source) => {
      source.prepare("INSERT INTO conversation (id, title, status, created_at, updated_at) VALUES ('alpha_late', 'late', 'active', ?, ?)").run(NOW, NOW);
    })
  });
  assert.deepEqual(preparation.sources.map((source) => source.candidateId), [fixture.alpha.id]);
  assert.deepEqual(session.results.map((result) => [result.state, result.issue?.code]), [['deferred', 'runtime-data-set-merge-source-changed']]);
  assert.deepEqual(readAll(fixture.current), before, '当前库不变');
  assert.equal(await readLedgerRecord(fixture, fixture.alpha.id), undefined, '没有 committing，也没有别的记录');
  assert.deepEqual(await ledgerEntries(fixture, 'commits'), []);
  assert.deepEqual(await ledgerEntries(fixture, 'preparing'), []);
});

test('证据集：全部新增对话，加上每个非内容派生领域的首末各 50 个；超出 2000 条时每端收缩（至少首末各 1 个），内容派生领域不算证据', () => {
  const fill = (conversations, domains, perDomain) => {
    const evidence = new RuntimeDataSetMergeEvidence();
    for (let index = 0; index < conversations; index += 1) evidence.add('Conversation', `c${index}`);
    for (const domain of domains) for (let index = 0; index < perDomain; index += 1) evidence.add(domain, `${domain}_${index}`);
    evidence.add('ContentObject', 'content_0');
    return evidence.rows();
  };
  const ids = (rows, domain) => rows.filter(([name]) => name === domain).map(([, id]) => id);
  const range = (domain, from, length) => Array.from({ length }, (_, index) => `${domain}_${from + index}`);
  const small = fill(30, ['Turn', 'Message', 'MessageRevision'], 500);
  assert.equal(ids(small, 'Conversation').length, 30);
  assert.deepEqual(ids(small, 'Turn'), [...range('Turn', 0, 50), ...range('Turn', 450, 50)], '首末各 50 个');
  assert.deepEqual(ids(small, 'ContentObject'), [], '内容派生领域不是证据');
  assert.deepEqual(ids(fill(0, ['Turn'], 7), 'Turn'), range('Turn', 0, 7), '不足 100 个就全记');
  const crowded = fill(1_900, ['Turn', 'Message', 'MessageRevision'], 500);
  assert.ok(crowded.length <= RUNTIME_DATA_SET_MERGE_COMMIT_EVIDENCE_ROWS, `${crowded.length} 条`);
  assert.equal(ids(crowded, 'Conversation').length, 1_900);
  assert.deepEqual(ids(crowded, 'Message'), [...range('Message', 0, 16), ...range('Message', 484, 16)], '每端收缩到放得下');
  const beyond = fill(2_500, ['Turn', 'Message'], 500);
  assert.deepEqual([ids(beyond, 'Conversation').length, ids(beyond, 'Turn'), ids(beyond, 'Message')],
    [2_500, ['Turn_0', 'Turn_499'], ['Message_0', 'Message_499']], '对话全记，其它领域至少首末各 1 个');
});

test('会话前置条件：不在配置 admission 内、不持有当前库维护声明、准备已经释放，都拒绝开始；释放时撤掉准备记录和没用上的备份', async (t) => {
  const fixture = await fixtureFor(t);
  await seedRichSource(fixture.alpha, 'alpha', 3);
  const database = await openWindow(fixture);
  let preparation;
  try {
    preparation = await prepareLargeMergeSources({ paths: fixture.paths, target: { configurationRootPath: fixture.root, database }, options: SMALL_LIMITS });
  } finally { await database.close(); }
  assert.deepEqual(preparation.sources.map((source) => source.candidateId), [fixture.alpha.id]);
  assert.ok(preparation.backupPath, '准备时做好了当前库备份');
  const session = () => runLargeMergeSession({ paths: fixture.paths, prepared: preparation });
  await assert.rejects(session(), /configuration admission/);
  await assert.rejects(withRuntimeDataRootAdmission(fixture.root, session), /target maintenance claim/);
  assert.equal((await ledgerEntries(fixture, 'preparing')).length, 1, '被拒的会话不动准备记录');
  await releaseLargeMergePreparation(preparation);
  await assert.rejects(withRuntimeDataRootAdmission(fixture.root, () => withRuntimeMaintenance(fixture.current.binding.paths, session)), /released/);
  assert.deepEqual(await ledgerEntries(fixture, 'preparing'), []);
  await assert.rejects(fs.stat(preparation.backupPath), { code: 'ENOENT' }, '没用上的备份已删除');
  assert.equal(await readLedgerRecord(fixture, fixture.alpha.id), undefined);
});

test('批次：有待合并的大库时，自动批次里超过在线上限的中等来源不单独协调，随大库会话等待（排在大库前面也一样），准备时 threshold 为 online 就一起合并；没有大库时照常协调，用户点的那份照常单独协调', async (t) => {
  const fixture = await fixtureFor(t, { beta: true });
  await seedConversations(fixture.alpha, [{ id: 'alpha_medium' }]);
  await seedRichSource(fixture.beta, 'beta', 3);
  const [alphaRows, betaRows] = [countRows(fixture.alpha), countRows(fixture.beta)];
  assert.ok(alphaRows < betaRows, `${alphaRows} < ${betaRows}`);
  // alpha (first in candidate order) is above the online bound only; beta is above the in-memory bound too.
  const limits = { limits: { maxRows: alphaRows - 1, maxBytes: 1024 ** 4 }, sizeLimits: { transactionRows: alphaRows } };
  const coordinated = [];
  const coordinateOversized = async (input, run) => { coordinated.push(input); await input.withLocks(run); return { state: 'completed' }; };
  const initial = await saveState(fixture, fixture.current);
  t.after(() => initial.remove());
  const before = readAll(fixture.current);

  const automatic = await mergeOnline(fixture, { ...limits, coordinateOversized });
  assert.deepEqual(automatic.deferred.map((issue) => [issue.candidateId, issue.code, issue.size?.rows]),
    [[fixture.beta.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE, betaRows], [fixture.alpha.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE, alphaRows]]);
  assert.match(automatic.deferred[1].message, /和更大的旧聊天记录一起在所有窗口暂停时合并/);
  assert.deepEqual([automatic.merged, automatic.blocked, automatic.failures, coordinated], [[], [], [], []], '中等来源不单独协调');
  assert.deepEqual(readAll(fixture.current), before);
  assert.equal(await readLedgerRecord(fixture, fixture.alpha.id), undefined, '不写账本');

  // By default a preparation leaves the medium one to the online merge; with threshold 'online' it is taken along.
  const window = await openWindow(fixture);
  try {
    const byDefault = await prepareLargeMergeSources({
      paths: fixture.paths, target: { configurationRootPath: fixture.root, database: window },
      candidateIds: [fixture.alpha.id, fixture.beta.id], options: { ...SMALL_LIMITS, ...limits }
    });
    assert.deepEqual([byDefault.sources.map((source) => source.candidateId), byDefault.small], [[fixture.beta.id], [fixture.alpha.id]]);
    await releaseLargeMergePreparation(byDefault);
  } finally { await window.close(); }
  const together = await mergeStreamed(fixture, { candidateIds: [fixture.alpha.id, fixture.beta.id], threshold: 'online', options: limits });
  assert.deepEqual(together.preparation.sources.map((source) => source.candidateId), [fixture.alpha.id, fixture.beta.id]);
  for (const source of together.preparation.sources) {
    assert.match(source.fingerprint, /^[0-9a-f]{64}$/, '准备结果带来源内容指纹');
    const dataSet = source.candidateId === fixture.alpha.id ? fixture.alpha : fixture.beta;
    assert.ok(source.runtimeDataRootPath.startsWith(dataSet.scopeRoot), '准备结果带来源位置');
  }
  assert.deepEqual(together.session.results.map((result) => [result.candidateId, result.state]), [[fixture.alpha.id, 'merged'], [fixture.beta.id, 'merged']]);
  assert.deepEqual(coordinated, []);
  await initial.restore();

  // Without a large source in the batch the medium one is merged after the others, coordinated on its own.
  const alone = await mergeOnline(fixture, { ...limits, coordinateOversized, candidateIds: [fixture.alpha.id] });
  assert.deepEqual([alone.merged.map((item) => item.candidateId), alone.deferred, coordinated.length], [[fixture.alpha.id], [], 1]);
  await initial.restore();

  // The one the user clicked is coordinated on its own at once, a large one alongside still waits.
  const clicked = await mergeOnline(fixture, { ...limits, coordinateOversized, candidateIds: [fixture.alpha.id, fixture.beta.id], requested: true });
  assert.deepEqual(clicked.merged.map((item) => item.candidateId), [fixture.alpha.id]);
  assert.deepEqual(clicked.deferred.map((issue) => [issue.candidateId, issue.code]), [[fixture.beta.id, RUNTIME_DATA_SET_MERGE_AWAITING_EXCLUSIVE]]);
  assert.equal(coordinated.length, 2);
});

for (const damage of ['invalid-row', 'missing-body']) test(`剔除等价性：${damage} 只留下对应对话，其余在线和流式一致`, async (t) => {
  const fixture = await fixtureFor(t);
  await seedConversations(fixture.alpha, [{id:'damaged'}, {id:'kept'}]);
  if (damage === 'invalid-row') {
    rawWrite(fixture.alpha, db => {
      db.prepare("UPDATE message_revision SET revision_seq='invalid' WHERE id=?").run('damaged_message_0_revision');
    });
  } else {
    const db = new Database(fixture.alpha.binding.paths.databasePath, {readonly:true});
    let storageKey;
    try { storageKey = db.prepare(`SELECT storage_key FROM content_object WHERE id=(SELECT content_object_id FROM message_revision WHERE id=?)`).pluck().get('damaged_message_0_revision'); }
    finally { db.close(); }
    await fs.rm(path.join(fixture.alpha.binding.paths.casRootPath, storageKey));
  }
  const before = await saveState(fixture, fixture.current);
  t.after(() => before.remove());
  const online = await mergeOnline(fixture);
  assert.deepEqual([online.blocked,online.failures,online.deferred], [[],[],[]]);
  const expected = readAll(fixture.current);
  const onlineRecord = await readLedgerRecord(fixture,fixture.alpha.id);
  assert.equal(onlineRecord.state,'partial');
  assert.deepEqual(onlineRecord.excluded.map(row=>row.conversationId),['damaged']);
  await before.restore();
  const {preparation,session} = await mergeStreamed(fixture,{candidateIds:[fixture.alpha.id], options:{sizeLimits:{transactionRows:1}}});
  assert.equal(preparation.sources.length,1,JSON.stringify(preparation.report));
  assert.deepEqual(session.results.map(result=>result.state),['merged']);
  assertSameRows(readAll(fixture.current),expected,damage);
  assert.deepEqual((await readLedgerRecord(fixture,fixture.alpha.id)).excluded,onlineRecord.excluded);
});
