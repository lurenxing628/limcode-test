import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
const { projectFolderAssignmentSteps, projectContextIdForUri } = kernelFile('conversationProject.js');
const { attachmentObservationLinkId } = kernelFile('attachmentObservations.js');
const { stablePhaseDId } = kernelFile('effectControlPlane.js');
const { createConversationRuntimeWorkProbe } = kernelFile('conversationRuntimePendingWork.js');
const {
  KEPT_MERGE_FINALIZATION_REASON, MERGE_FINALIZATION_REASON, RUNTIME_DATA_SET_MERGE_BACKUP_RETENTION, RUNTIME_DATA_SET_MERGE_REQUEST_TTL_MS,
  RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS, RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS, mergeHistoricalDataSetsOnline,
  mergeRuntimeDataSetIntoDatabase, precopyRuntimeDataSetCas, readRuntimeDataSetMergeStates, requestRuntimeDataSetMerge
} = kernelFile('runtimeDataSetMerge.js');
const { deleteUnselectedRuntimeDataSet } = kernelFile('runtimeStorageInspection.js');
const { runExclusiveRuntimeMaintenance } = kernelFile('runtimeExclusiveMaintenance.js');
const {
  resolveVscodeRuntimeDataRoot, resolveVscodeRuntimeMergeLedgerRoot, resolveVscodeWorkspaceRuntimeScope,
  resolveVscodeWorkspaceRuntimeScopeRoot, selectVscodeRuntimeDataSet
} = kernelFile('vscodeRootAuthority.js');
const { ownProcessStartIdentity } = kernelFile('runtimeClaimPrimitives.js');
const {
  isRuntimeDataRootAdmissionHeld, isRuntimeMaintenanceHeld, runtimeDataRootAdmissionClaimPath, runtimeMaintenanceClaimPath,
  withRuntimeMaintenance
} = kernelFile('runtimeHostControl.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = '2026-09-26T00:00:00.000Z';
const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
const SHARED_PROJECT = { uri: 'file:///workspace/shared', name: 'shared' };
const ALPHA_PROJECT = { uri: 'file:///workspace/alpha', name: 'alpha' };
const SHARED_TEXT = JSON.stringify({ role: 'user', parts: [{ text: '各工作区都用过的同一段正文' }] });
const repo = (domain) => kernel.DOMAIN_REPOSITORIES.domain(domain);

test('旧库在当前库打开后在线合并：同项目可见、正文只登记一次、来源原样保留、合并后可继续写', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.current, [{ id: 'conversation_current_1', project: SHARED_PROJECT }]);
  await seed(fixture.alpha, [
    { id: 'conversation_alpha_1', project: SHARED_PROJECT },
    { id: 'conversation_alpha_2', project: { uri: 'file:///workspace/alpha', name: 'alpha' } }
  ]);
  await seed(fixture.beta, [{ id: 'conversation_beta_1', project: SHARED_PROJECT }]);
  const sourcesBefore = { alpha: await treeSnapshot(fixture.alpha.scopeRoot), beta: await treeSnapshot(fixture.beta.scopeRoot) };
  const database = await openTarget(t, fixture.current);

  const report = await merge(fixture, database);
  assert.deepEqual([report.failures, report.blocked, report.deferred], [[], [], []]);
  assert.deepEqual(report.merged.map((item) => item.candidateId).sort(), [fixture.alpha.id, fixture.beta.id].sort());
  assert.equal(report.merged.reduce((sum, item) => sum + item.insertedConversations, 0), 3);
  assert.ok(report.merged.every((item) => item.recoveredCommit === false && item.exclusive === undefined));
  assert.equal(new Set(report.merged.map((item) => item.backupPath)).size, 1, '每批只做一次当前库在线备份');

  // The open Runtime sees the committed rows through its ordinary snapshot path.
  const seen = (await database.snapshot([repo('Conversation').get('conversation_alpha_2')])).snapshot[0];
  assert.equal(seen?.id, 'conversation_alpha_2');
  const target = readDatabase(fixture.current);
  try {
    assert.deepEqual(target.conversationsFor(SHARED_PROJECT.uri),
      ['conversation_alpha_1', 'conversation_beta_1', 'conversation_current_1']);
    assert.deepEqual(target.conversationsFor('file:///workspace/alpha'), ['conversation_alpha_2']);
    assert.equal(target.count('project_context', 'id = ?', projectContextIdForUri(SHARED_PROJECT.uri)), 1);
    assert.equal(target.count('content_object', 'sha256 = ?', sha256(SHARED_TEXT)), 1, '相同正文只登记一次');
    assert.deepEqual(target.database.pragma('foreign_key_check'), []);
    assertNothingResumes(target);
  } finally { target.close(); }

  const alphaText = messageText('conversation_alpha_2', 0);
  assert.equal((await fs.stat(casFile(fixture.current.binding, alphaText))).ino,
    (await fs.stat(casFile(fixture.alpha.binding, alphaText))).ino, '正文以硬链接进入当前库');
  assert.deepEqual(await treeSnapshot(fixture.alpha.scopeRoot), sourcesBefore.alpha);
  assert.deepEqual(await treeSnapshot(fixture.beta.scopeRoot), sourcesBefore.beta);

  const backup = new Database(path.join(report.merged[0].backupPath, 'limcode.sqlite'), { readonly: true });
  try { assert.equal(backup.prepare('SELECT COUNT(*) FROM conversation').pluck().get(), 1); }
  finally { backup.close(); }

  const states = await readRuntimeDataSetMergeStates(fixture.paths);
  assert.deepEqual([states.get(fixture.alpha.id)?.state, states.get(fixture.alpha.id)?.intoCurrent,
    states.get(fixture.alpha.id)?.changedSinceMerge], ['merged', true, false]);
  const again = await merge(fixture, database);
  assert.equal(again.pendingSources, 0);

  await database.transaction([
    repo('Turn').insert({
      id: 'turn_after_merge', conversation_id: 'conversation_alpha_1', status: 'terminated',
      created_at: NOW, updated_at: NOW, terminal_at: NOW
    }),
    repo('Conversation').update('conversation_alpha_1', { updated_at: '2026-09-27T00:00:00.000Z' })
  ]);
});

test('在线合并时另一个窗口（进程）持续写同一当前库：双方都不报错，对方随后能看到合并进来的对话', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_peer', project: SHARED_PROJECT }]);
  const database = await openTarget(t, fixture.current);
  const control = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-merge-peer-'));
  t.after(() => fs.rm(control, { recursive: true, force: true }));
  const stopFile = path.join(control, 'stop');
  const resultFile = path.join(control, 'result.json');
  const peer = runChild(['writer', fixture.root, stopFile, resultFile, 'conversation_alpha_peer']);
  await waitForFile(`${resultFile}.ready`);

  const report = await merge(fixture, database);
  assert.deepEqual([report.failures, report.blocked, report.deferred], [[], [], []]);
  assert.equal(report.merged.length, 1);
  await fs.writeFile(stopFile, '');
  const exit = await peer;
  assert.equal(exit.code, 0, exit.stderr);
  const peerResult = JSON.parse(await fs.readFile(resultFile, 'utf8'));
  assert.deepEqual(peerResult.errors, []);
  assert.ok(peerResult.written >= 1);
  assert.equal(peerResult.sawMerged, true, '另一个窗口通过自己的连接看到了合并进来的对话');
  const target = readDatabase(fixture.current);
  try { assert.equal(target.count('conversation', "id LIKE 'peer\\_conversation\\_%' ESCAPE '\\'"), peerResult.written); }
  finally { target.close(); }
});

test('复审 merge2 #4：接近在线上限的来源合并时，另一个窗口（进程）的每次写入最长等待远低于 busy_timeout', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  const messages = 10;
  // Each conversation is 2 + 5 × messages rows (conversation, project link, message rows, body).
  const conversations = Math.floor((RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS.maxRows - 20) / (2 + 5 * messages));
  await seedBulk(fixture.current, 'current', 200, messages);
  await seedBulk(fixture.alpha, 'alpha', conversations, messages);
  const database = await openTarget(t, fixture.current);
  const control = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-merge-wait-'));
  t.after(() => fs.rm(control, { recursive: true, force: true }));
  const stopFile = path.join(control, 'stop');
  const resultFile = path.join(control, 'result.json');
  const peer = runChild(['writer', fixture.root, stopFile, resultFile, 'bulk_alpha_0']);
  await waitForFile(`${resultFile}.ready`);
  const marks = {};
  const report = await merge(fixture, database, { onFaultPoint(point) { marks[point] = performance.now(); } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await fs.writeFile(stopFile, '');
  const exit = await peer;
  assert.equal(exit.code, 0, exit.stderr);
  assert.deepEqual([report.deferred, report.blocked, report.failures], [[], [], []], '上限以内在线合并');
  assert.ok(report.merged[0].insertedRows > RUNTIME_DATA_SET_ONLINE_MERGE_LIMITS.maxRows * 0.8);
  const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
  const transactionMs = Math.round(marks['after-row-commit'] - marks['before-row-commit']);
  t.diagnostic(`rows=${report.merged[0].insertedRows} transactionMs=${transactionMs} peerMaxMs=${result.maxMs} peerWrites=${result.written}`);
  assert.deepEqual(result.errors, [], '对方没有 SQLITE_BUSY（不依赖任何重试）');
  assert.equal(result.sawMerged, true);
  assert.ok(result.maxMs < 2_000, `对方最长写入等待 ${result.maxMs} ms（合并事务 ${transactionMs} ms）`);
});

test('复审 reloc-perf #13：规划不再按来源行数构造实参列表（小栈子进程合并上万行来源），内部异常不记为来源失败', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_many', project: SHARED_PROJECT }]);
  // With --stack-size=100 an argument list of ~12,000 values overflows (Node 24); the source has
  // more rows, still below the single-transaction limit.
  const rows = Math.min(15_000, RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS - 100);
  rawInsertConversations(fixture.alpha, 'many', rows);
  const child = await runChild(['merge', fixture.root], ['--stack-size=100']);
  assert.equal(child.code, 0, child.stderr);
  const report = JSON.parse(child.stdout);
  assert.deepEqual(report.issues, []);
  assert.ok(report.merged[0] > rows);
});

test('复审 reloc-perf #14：超过单事务硬上限的来源不协调、不备份、不收尾，记为“太大”而非失败，上限不变就不再重试', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_huge', project: SHARED_PROJECT }]);
  await seedUnfinishedWork(fixture.alpha, [{ conversationId: 'conversation_alpha_huge', kind: 'bare' }]);
  rawInsertConversations(fixture.alpha, 'huge', RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS);
  const database = await openTarget(t, fixture.current);
  const sourceBefore = await treeSnapshot(fixture.alpha.scopeRoot);
  const targetBefore = databaseDigest(fixture.current);
  const calls = [];
  const coordinateOversized = async (input, run) => { calls.push(input); await input.withLocks(run); return { state: 'completed' }; };
  const first = await merge(fixture, database, { coordinateOversized });
  assert.deepEqual([first.merged, first.deferred, first.failures], [[], [], []], '不是失败，也不是稍后重试');
  assert.equal(first.blocked[0]?.code, 'runtime-data-set-merge-too-large-for-one-transaction');
  assert.match(first.blocked[0].message, new RegExp(`约有 \\d+ 条记录，超过当前版本一次合并能安全处理的上限（${RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS} 条）`));
  assert.match(first.blocked[0].message, /切换到这个库查看/);
  assert.deepEqual(calls, [], '不请求其它窗口让出');
  assert.deepEqual(await treeSnapshot(fixture.alpha.scopeRoot), sourceBefore, '没有收尾、没有来源备份');
  assert.equal(databaseDigest(fixture.current), targetBefore);
  await assert.rejects(fs.stat(path.join(controlRoot(fixture.current), 'merge-backups')), { code: 'ENOENT' });
  const record = await readLedgerRecord(fixture, fixture.alpha.id);
  assert.deepEqual([record.state, record.maxRows], ['too-large', RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS]);
  assert.ok(record.rows > RUNTIME_DATA_SET_MERGE_MAX_TRANSACTION_ROWS);
  const state = (await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id);
  assert.deepEqual([state?.state, state?.rows], ['too-large', record.rows]);

  const again = await merge(fixture, database, { coordinateOversized });
  assert.deepEqual([again.pendingSources, again.blocked[0]?.newly], [0, false], '上限不变就不再自动重试');
  const explicit = await merge(fixture, database, { coordinateOversized, candidateIds: [fixture.alpha.id], requested: true });
  assert.deepEqual([explicit.blocked[0]?.code, explicit.blocked[0]?.requested], ['runtime-data-set-merge-too-large-for-one-transaction', true]);
  // A version with another limit judges it again.
  const file = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'records', `${fixture.alpha.id.replace(/:/g, '-')}.json`);
  await fs.writeFile(file, JSON.stringify({ ...record, maxRows: record.maxRows - 1 }));
  assert.equal((await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id), undefined);
  const judgedAgain = await merge(fixture, database, { coordinateOversized });
  assert.deepEqual([judgedAgain.pendingSources, judgedAgain.blocked[0]?.newly], [1, true]);
  assert.deepEqual(calls, []);
});

test('未完成工作按中止收尾后合并：先备份来源，合并进来的对话在任何窗口都不会被启动恢复自动执行', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [
    { id: 'conversation_alpha_leased', project: SHARED_PROJECT },
    { id: 'conversation_alpha_bare', project: SHARED_PROJECT },
    { id: 'conversation_alpha_interrupt', project: SHARED_PROJECT },
    { id: 'conversation_alpha_queued', project: SHARED_PROJECT }
  ]);
  await seedUnfinishedWork(fixture.alpha, [
    { conversationId: 'conversation_alpha_leased', kind: 'leased-model-request' },
    { conversationId: 'conversation_alpha_bare', kind: 'bare' },
    { conversationId: 'conversation_alpha_interrupt', kind: 'interrupt-requested' },
    { conversationId: 'conversation_alpha_queued', kind: 'queued-intent' }
  ]);
  const database = await openTarget(t, fixture.current);
  const report = await merge(fixture, database);
  assert.deepEqual([report.failures, report.blocked, report.deferred], [[], [], []]);
  assert.equal(report.merged.length, 1);
  const { finalized } = report.merged[0];
  assert.deepEqual([finalized?.turns, finalized?.intents], [3, 1]);

  const sourceBackup = new Database(path.join(finalized.sourceBackupPath, 'limcode.sqlite'), { readonly: true });
  try {
    assert.equal(sourceBackup.prepare("SELECT COUNT(*) FROM turn WHERE status = 'active'").pluck().get(), 3, '收尾前的来源已备份');
  } finally { sourceBackup.close(); }

  const target = readDatabase(fixture.current);
  try {
    assertNothingResumes(target);
    const terminations = Object.fromEntries(target.database.prepare(`
      SELECT turn.conversation_id, termination.terminal_status || ':' || termination.reason
        FROM turn_termination AS termination JOIN turn ON turn.id = termination.turn_id
       WHERE turn.id LIKE '%_unfinished_turn'`).raw().all());
    assert.deepEqual(terminations, {
      conversation_alpha_leased: `cancelled:${MERGE_FINALIZATION_REASON}`,
      conversation_alpha_bare: `cancelled:${MERGE_FINALIZATION_REASON}`,
      conversation_alpha_interrupt: `interrupted:${MERGE_FINALIZATION_REASON}`
    });
    assert.equal(target.database.prepare('SELECT terminal_state FROM model_request').pluck().get(), 'turn-interrupt-requested');
    assert.equal(target.database.prepare('SELECT status FROM tool_call').pluck().get(), 'terminal');
    assert.notEqual(target.database.prepare('SELECT state FROM turn_intent').pluck().get(), 'queued');
  } finally { target.close(); }
  // The source itself was closed the same way (its backup keeps the state before).
  const source = readDatabase(fixture.alpha);
  try { assertNothingResumes(source); }
  finally { source.close(); }
});

test('无现成终态转换的未完成工作拒绝合并：写明原因与出路，同一状态不重复提示，明确请求后重试', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_asking', project: SHARED_PROJECT }]);
  await seedInteractionRequest(fixture.alpha);
  await seed(fixture.beta, [
    { id: 'conversation_beta_parent', project: SHARED_PROJECT },
    { id: 'conversation_beta_child', project: SHARED_PROJECT }
  ]);
  await seedUndeliveredChildAnswer(fixture.beta, 'conversation_beta_parent', 'conversation_beta_child');
  const before = { alpha: await treeSnapshot(fixture.alpha.scopeRoot), beta: await treeSnapshot(fixture.beta.scopeRoot) };
  const database = await openTarget(t, fixture.current);
  const targetBefore = databaseDigest(fixture.current);

  const first = await merge(fixture, database);
  assert.deepEqual(first.merged, []);
  const blocked = Object.fromEntries(first.blocked.map((item) => [item.candidateId, item]));
  assert.equal(blocked[fixture.alpha.id]?.code, 'runtime-data-set-merge-unfinished-work');
  assert.match(blocked[fixture.alpha.id].message, /等待你回答或批准的请求×1/);
  assert.match(blocked[fixture.alpha.id].message, /切换到这个库.*再切回当前库并选择“合并到当前库”/);
  assert.match(blocked[fixture.alpha.id].message, /这些任务会按那个库的正常恢复继续执行/);
  assert.match(blocked[fixture.beta.id]?.message ?? '', /已提交但尚未送达的子 Agent 答案×1/, '审查 #1(a)');
  assert.ok(first.blocked.every((item) => item.newly === true && item.requested === false));
  assert.equal(databaseDigest(fixture.current), targetBefore);
  assert.deepEqual(await treeSnapshot(fixture.alpha.scopeRoot), before.alpha, '被拒绝的来源不被改动');
  assert.deepEqual(await treeSnapshot(fixture.beta.scopeRoot), before.beta);

  const second = await merge(fixture, database);
  assert.equal(second.pendingSources, 0);
  assert.deepEqual(second.blocked.map((item) => item.newly), [false, false]);
  assert.equal((await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id)?.state, 'blocked');

  await requestMerge(fixture, fixture.alpha);
  assert.equal((await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id)?.state, 'requested');
  // A later startup finds the recorded request: tried again, but as an ordinary pending source.
  const background = await merge(fixture, database);
  const pending = background.blocked.find((item) => item.candidateId === fixture.alpha.id);
  assert.deepEqual([pending?.newly, pending?.requested], [true, false], '复审 coord2 #1：持久请求不算用户明确请求');
  const retried = await merge(fixture, database, { candidateIds: [fixture.alpha.id], requested: true });
  const alpha = retried.blocked.find((item) => item.candidateId === fixture.alpha.id);
  assert.deepEqual([alpha?.newly, alpha?.requested], [true, true], '用户点击的那一次调用：结果总是提示');
});

test('复审 merge2 #5：待收尾的对话若还有内核判忙而命名探针没覆盖的状态，收尾之前就被拒绝，来源原样不动、提示如实', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_mixed', project: SHARED_PROJECT }]);
  await seedUnfinishedWork(fixture.alpha, [{ conversationId: 'conversation_alpha_mixed', kind: 'bare' }]);
  // Same Conversation: an exited process without a ProcessReceipt. The kernel probe keeps the
  // Conversation busy for it; no named refusal probe counts it (constructed state).
  rawSource(fixture.alpha, (source) => insertUnreceiptedProcess(source, 'conversation_alpha_mixed'));
  const before = await treeSnapshot(fixture.alpha.scopeRoot);
  const report = await merge(fixture, await openTarget(t, fixture.current));
  assert.equal(report.blocked[0]?.code, 'runtime-data-set-merge-unfinished-work');
  assert.match(report.blocked[0].message, /其它未结束的对话工作×1/);
  assert.match(report.blocked[0].message, /这个库的对话内容没有改动/);
  assert.deepEqual(await treeSnapshot(fixture.alpha.scopeRoot), before, '没有先收尾再拒绝');
});

test('内核探针终审：没有可收尾工作、只有内核判忙的对话也整份拒绝（去掉终审则会被合并）', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_process', project: SHARED_PROJECT }]);
  rawSource(fixture.alpha, (source) => insertUnreceiptedProcess(source, 'conversation_alpha_process'));
  const database = await openTarget(t, fixture.current);
  const report = await merge(fixture, database);
  assert.deepEqual(report.merged, []);
  assert.match(report.blocked[0]?.message ?? '', /其它未结束的对话工作×1/);
});

for (const [name, spec, label] of [
  ['(b) 子 Agent 任务 Turn 已完成、有最终输出栅栏、答案未提交', { childStatus: 'idle', bridgeStatus: 'open', terminal: 'completed', fence: true }, '已完成但答案尚未提交的子 Agent 任务×1'],
  ['(c) 子 Agent 被中断、取消 Turn 仍欠父任务部分答案', { childStatus: 'interrupted', bridgeStatus: 'interrupted', terminal: 'interrupted', terminationRequest: true }, '被中断、仍需生成部分答案的子 Agent×1']
]) {
  test(`拒绝探针 ${name}：整份拒绝，来源不动（去掉该探针则会被合并）`, async (t) => {
    const fixture = await createFixture(t, { withBeta: false });
    await seed(fixture.alpha, [
      { id: 'conversation_alpha_parent', project: SHARED_PROJECT },
      { id: 'conversation_alpha_child', project: SHARED_PROJECT }
    ]);
    rawSource(fixture.alpha, (source, contentId) => insertChildExecution(source, contentId, spec));
    const before = await treeSnapshot(fixture.alpha.scopeRoot);
    const report = await merge(fixture, await openTarget(t, fixture.current));
    assert.deepEqual(report.merged, []);
    assert.ok((report.blocked[0]?.message ?? '').includes(label), report.blocked[0]?.message);
    assert.deepEqual(await treeSnapshot(fixture.alpha.scopeRoot), before);
  });
}

test('复审 merge2 #7：模型流检查点和栅栏只能随父 ModelRequest 在同一事务里以历史复制写入；ModelRequest 的 Operation、Attempt 历史复制只收终态', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.current, [{ id: 'conversation_history_copy', project: SHARED_PROJECT }]);
  const database = await openTarget(t, fixture.current);
  const store = new kernel.ContentAddressedStore(fixture.current.authority, fixture.current.binding);
  const recipe = await store.ingest(database, '{}', 'application/json');
  const body = await store.ingest(database, JSON.stringify({ role: 'model', parts: [{ text: '检查点' }] }), MESSAGE_TYPE);
  const turnId = 'conversation_history_copy_turn';
  const copy = (id, seq, { operation = 'cancelled', attempt = 'cancelled' } = {}) => [
    repo('ModelRequest').insertHistoricalCopy({
      id, turn_id: turnId, request_seq: seq, status: 'terminal', terminal_state: 'turn-interrupt-requested',
      provider_id: 'openai-responses', model_id: 'gpt-test', context_window_tokens: 130_000n, compression_threshold_tokens: 100_000n,
      estimated_context_tokens: 1_000n, authority_snapshot_id: 'authority-merge', settings_snapshot_object_id: null, recipe_object_id: recipe.id,
      usage_json: null, stream_stats_json: { attemptSeq: '1', socketGeneration: '0', retryReason: null }, created_at: NOW, updated_at: NOW
    }),
    repo('Operation').insertHistoricalCopy({
      id: `${id}_operation`, owner_kind: 'model_request', owner_id: id, operation_seq: 1n, tool_call_id: null, status: operation, created_at: NOW, updated_at: NOW
    }),
    repo('Attempt').insertHistoricalCopy({
      id: `${id}_attempt`, operation_id: `${id}_operation`, attempt_seq: 1n, status: attempt, created_at: NOW, updated_at: NOW, completed_at: NOW
    })
  ];
  const checkpoint = (requestId, streamSeq) => repo('ModelStreamCheckpoint').insertHistoricalCopy({
    id: `${requestId}_checkpoint_${streamSeq}`, model_request_id: requestId, attempt_seq: 1n, socket_generation: 0n,
    stream_seq: streamSeq, checkpoint_kind: 'output_delta', content_object_id: body.id, created_at: NOW
  });
  await database.transaction([...copy('copied_request', 1n), checkpoint('copied_request', 1n)]);
  await assert.rejects(database.transaction([checkpoint('copied_request', 2n)]), /copied in the same transaction/,
    '不能给已有的结束请求追加检查点');
  await assert.rejects(database.transaction([repo('ModelStreamFence').insertHistoricalCopy({
    id: 'appended_fence', model_request_id: 'copied_request', attempt_seq: 1n, socket_generation: 0n, terminal_stream_seq: 1n,
    outcome: 'completed', created_at: NOW
  })]), /copied in the same transaction/);
  await assert.rejects(database.transaction(copy('running_operation', 2n, { operation: 'running' })), /Operation copy must be terminal/);
  await assert.rejects(database.transaction(copy('running_attempt', 3n, { attempt: 'running' })), /Attempt copy must be terminal/);
  const target = readDatabase(fixture.current);
  try {
    assert.equal(target.count('model_stream_checkpoint'), 1);
    assert.equal(target.count('model_request'), 1);
  } finally { target.close(); }
});

test('协作消息 message_seq 在合并事务内接在当前库最大值之后并保持相对顺序；附件观察按内容身份复用', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.current, [{ id: 'conversation_current_seq', project: SHARED_PROJECT }]);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_seq', project: SHARED_PROJECT }]);
  await seedCollaborationMessages(fixture.current, 'conversation_current_seq', ['collaboration_current_1', 'collaboration_current_2']);
  await seedCollaborationMessages(fixture.alpha, 'conversation_alpha_seq', ['collaboration_alpha_1', 'collaboration_alpha_2']);
  await seedAttachmentObservation(fixture.current, '2026-09-01T00:00:00.000Z', 'observation from current');
  await seedAttachmentObservation(fixture.alpha, '2026-09-02T00:00:00.000Z', 'observation from alpha');
  const database = await openTarget(t, fixture.current);
  const report = await merge(fixture, database);
  assert.deepEqual(report.blocked, [], '审查 #2/#3：不再被判为冲突');
  assert.equal(report.merged.length, 1);
  const target = readDatabase(fixture.current);
  try {
    target.database.defaultSafeIntegers(true);
    const sequence = target.database.prepare('SELECT id, message_seq FROM collaboration_message ORDER BY message_seq').raw().all();
    assert.deepEqual(sequence, [
      ['collaboration_current_1', 1n], ['collaboration_current_2', 2n],
      ['collaboration_alpha_1', 3n], ['collaboration_alpha_2', 4n]
    ]);
    const observations = target.database.prepare(`
      SELECT link.id, content.sha256 FROM attachment_observation_link AS link
        JOIN content_object AS content ON content.id = link.content_object_id`).raw().all();
    assert.equal(observations.length, 1);
    assert.equal(observations[0][1], sha256('observation from current'), '当前库已有的观察保留');
    assertNothingResumes(target);
  } finally { target.close(); }
});

test('同一身份内容不同：整份拒绝，当前库不备份、不新增正文，两边都不变', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.current, [{ id: 'conversation_duplicate', project: SHARED_PROJECT, title: '当前库标题' }]);
  await seed(fixture.alpha, [
    { id: 'conversation_duplicate', project: SHARED_PROJECT, title: '旧库标题' },
    { id: 'conversation_alpha_unique', project: SHARED_PROJECT }
  ]);
  const database = await openTarget(t, fixture.current);
  const before = { rows: databaseDigest(fixture.current), cas: await treeSnapshot(fixture.current.binding.paths.casRootPath),
    alpha: await treeSnapshot(fixture.alpha.scopeRoot) };
  const report = await merge(fixture, database);
  assert.equal(report.blocked[0]?.code, 'runtime-data-set-merge-conflict');
  assert.match(report.blocked[0].message, /Conversation#conversation_duplicate 字段不同：title/);
  assert.match(report.blocked[0].message, /两边内容都没有改动/);
  assert.equal(databaseDigest(fixture.current), before.rows);
  assert.deepEqual(await treeSnapshot(fixture.current.binding.paths.casRootPath), before.cas);
  assert.deepEqual(await treeSnapshot(fixture.alpha.scopeRoot), before.alpha);
  await assert.rejects(fs.stat(path.join(controlRoot(fixture.current), 'merge-backups')), { code: 'ENOENT' });
});

test('正文校验：当前库同名正文损坏则拒绝且不覆盖；来源正文与摘要不符记为失败；跨设备时复制校验后发布', async (t) => {
  for (const damage of ['same-length', 'truncated']) {
    const fixture = await createFixture(t, { withBeta: false });
    await seed(fixture.current, [{ id: 'conversation_current_cas', project: SHARED_PROJECT }]);
    await seed(fixture.alpha, [{ id: 'conversation_alpha_cas', project: SHARED_PROJECT }]);
    const targetFile = casFile(fixture.current.binding, SHARED_TEXT);
    await fs.chmod(targetFile, 0o600);
    if (damage === 'truncated') await fs.truncate(targetFile, 3);
    else {
      const bytes = await fs.readFile(targetFile);
      bytes[bytes.length - 3] ^= 0x01;
      await fs.writeFile(targetFile, bytes);
    }
    const damaged = await fs.readFile(targetFile);
    const database = await openTarget(t, fixture.current);
    const report = await merge(fixture, database);
    assert.deepEqual(report.merged, [], damage);
    assert.equal(report.blocked[0]?.code, 'runtime-data-set-merge-target-cas-damaged', `审查 #4 ${damage}`);
    assert.deepEqual(await fs.readFile(targetFile), damaged, '损坏文件不被覆盖（留给用户处理）');
  }

  const source = await createFixture(t, { withBeta: false });
  await seed(source.alpha, [{ id: 'conversation_alpha_bad_source', project: SHARED_PROJECT }]);
  const sourceFile = casFile(source.alpha.binding, messageText('conversation_alpha_bad_source', 0));
  await fs.chmod(sourceFile, 0o600);
  const bytes = await fs.readFile(sourceFile);
  bytes[0] ^= 0x01;
  await fs.writeFile(sourceFile, bytes);
  const sourceTarget = await openTarget(t, source.current);
  const bad = await merge(source, sourceTarget);
  assert.equal(bad.failures[0]?.code, 'runtime-data-set-merge-source-cas-invalid');
  assert.equal(bad.failures[0].newly, true);
  await assert.rejects(fs.stat(casFile(source.current.binding, messageText('conversation_alpha_bad_source', 0))), { code: 'ENOENT' },
    '摘要不符的来源文件不会被链接进当前库');
  assert.equal((await merge(source, sourceTarget)).failures[0]?.newly, false, '同一来源状态不重复提示');

  const copy = await createFixture(t, { withBeta: false });
  await seed(copy.alpha, [{ id: 'conversation_alpha_copy', project: SHARED_PROJECT }]);
  const copyTarget = await openTarget(t, copy.current);
  const copied = await merge(copy, copyTarget, {
    async linkFile() { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); }
  });
  assert.equal(copied.merged.length, 1);
  assert.ok(copied.merged[0].copiedCasObjects > 0);
  assert.equal(copied.merged[0].linkedCasObjects, 0);
  const text = messageText('conversation_alpha_copy', 0);
  assert.notEqual((await fs.stat(casFile(copy.alpha.binding, text))).ino, (await fs.stat(casFile(copy.current.binding, text))).ino);
  assert.equal(await fs.readFile(casFile(copy.current.binding, text), 'utf8'), text);
  assert.deepEqual(await fs.readdir(path.join(copy.current.binding.paths.casRootPath, 'tmp')), []);
});

for (const point of ['after-source-backup', 'after-target-backup', 'after-cas-transfer', 'before-row-commit', 'after-row-commit']) {
  test(`真实 SIGKILL 于 ${point}：当前库一致，下次启动收敛且不重复插入`, async (t) => {
    const fixture = await createFixture(t, { withBeta: false });
    await seed(fixture.current, [{ id: 'conversation_current_kill', project: SHARED_PROJECT }]);
    await seed(fixture.alpha, [{ id: 'conversation_alpha_kill', project: SHARED_PROJECT }]);
    if (point === 'after-source-backup') {
      await seedUnfinishedWork(fixture.alpha, [{ conversationId: 'conversation_alpha_kill', kind: 'bare' }]);
    }
    const before = databaseDigest(fixture.current);
    const killed = await runChild(['kill', fixture.root, point]);
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    const record = await readLedgerRecord(fixture, fixture.alpha.id);
    if (point === 'after-row-commit') {
      assert.equal(record?.state, 'committing');
      assert.notEqual(databaseDigest(fixture.current), before);
    } else {
      assert.equal(databaseDigest(fixture.current), before, '提交前被杀，当前库行不变');
      assert.notEqual(record?.state, 'merged', '审查 #7：committing 不算已合并');
    }
    const database = await openTarget(t, fixture.current);
    const rerun = await merge(fixture, database);
    assert.deepEqual([rerun.failures, rerun.blocked, rerun.deferred], [[], [], []]);
    assert.equal(rerun.merged.length, 1);
    assert.equal(rerun.merged[0].recoveredCommit, point === 'after-row-commit');
    const target = readDatabase(fixture.current);
    try {
      assert.equal(target.count('conversation', 'id = ?', 'conversation_alpha_kill'), 1);
      assert.equal(target.database.pragma('quick_check', { simple: true }), 'ok');
      assert.deepEqual(target.database.pragma('foreign_key_check'), []);
      assertNothingResumes(target);
    } finally { target.close(); }
    assert.deepEqual(await fs.readdir(path.join(fixture.current.binding.paths.casRootPath, 'tmp')).catch(() => []), []);
    assert.deepEqual(await fs.readdir(path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'commits')).catch(() => []), []);
  });
}

test('来源收尾（备份与终态转换）期间在所持的 admission 与来源 maintenance 里发布维护进行中标记，收尾后随锁消失', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.current, [{ id: 'conversation_current_marker', project: SHARED_PROJECT }]);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_marker', project: SHARED_PROJECT }]);
  await seedUnfinishedWork(fixture.alpha, [{ conversationId: 'conversation_alpha_marker', kind: 'bare' }]);
  const database = await openTarget(t, fixture.current);
  const claims = [runtimeDataRootAdmissionClaimPath(fixture.root), runtimeMaintenanceClaimPath(fixture.alpha.binding.paths)];
  const seen = [];
  const report = await merge(fixture, database, {
    async onFaultPoint(point) {
      if (point !== 'after-source-backup') return;
      for (const claim of claims) {
        const owner = JSON.parse(await fs.readFile(path.join(claim, 'owner.json'), 'utf8'));
        const activity = JSON.parse(await fs.readFile(path.join(claim, 'activity.json'), 'utf8'));
        seen.push({ operation: activity.operation, description: activity.description, sameClaim: activity.claimToken === owner.claimToken });
      }
    }
  });
  assert.equal(report.merged.length, 1);
  assert.deepEqual(seen, claims.map(() => ({ operation: 'historical-merge-finalize', description: '备份并收尾要合并的旧聊天记录', sameClaim: true })));
  for (const claim of claims) await assert.rejects(fs.access(path.join(claim, 'activity.json')));
});

test('提交记录与当前库对不上（部分存在）时不猜测，拒绝并提示手动处理；提交前崩溃的来源在切换当前库后仍会合并', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_partial', project: SHARED_PROJECT }]);
  await seed(fixture.beta, [{ id: 'conversation_beta_before_commit', project: SHARED_PROJECT }]);
  const killed = await runChild(['kill', fixture.root, 'after-row-commit', fixture.alpha.id]);
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  const record = await readLedgerRecord(fixture, fixture.alpha.id);
  const commitFile = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'commits', `${record.commitId}.json`);
  const commit = JSON.parse(await fs.readFile(commitFile, 'utf8'));
  await fs.writeFile(commitFile, JSON.stringify({ ...commit, rows: [...commit.rows, ['Conversation', 'conversation_never_inserted']] }));
  const killedBeta = await runChild(['kill', fixture.root, 'before-row-commit', fixture.beta.id]);
  assert.equal(killedBeta.signal, 'SIGKILL', killedBeta.stderr);

  let database = await openTarget(t, fixture.current);
  const report = await merge(fixture, database, { candidateIds: [fixture.alpha.id] });
  assert.equal(report.blocked[0]?.code, 'runtime-data-set-merge-conflict');
  assert.match(report.blocked[0].message, /上次合并在提交时中断/);
  await database.close();

  // R6: beta crashed before its commit, so it never reached any data set; switching must not hide it.
  const gamma = await initializeScope(fixture.paths, 'gamma');
  await selectVscodeRuntimeDataSet(fixture.paths, gamma.id);
  database = await openTarget(t, gamma);
  const switched = await merge(fixture, database);
  assert.ok(switched.merged.some((item) => item.candidateId === fixture.beta.id));
  const target = readDatabase(gamma);
  try { assert.equal(target.count('conversation', 'id = ?', 'conversation_beta_before_commit'), 1); }
  finally { target.close(); }
});

test('审查 #6：提交前当前库少了一行复用行时事务整体回滚并推迟，下次按实测补齐', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.current, [{ id: 'conversation_current_reuse', project: SHARED_PROJECT }]);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_reuse', project: SHARED_PROJECT }]);
  const orphan = 'orphan body present in both data sets';
  await ingest(fixture.current, orphan);
  await ingest(fixture.alpha, orphan);
  const database = await openTarget(t, fixture.current);
  const before = databaseDigest(fixture.current);
  const report = await merge(fixture, database, {
    onFaultPoint(point) {
      if (point !== 'before-row-commit') return;
      const writer = new Database(fixture.current.binding.paths.databasePath);
      try { writer.prepare('DELETE FROM content_object WHERE sha256 = ?').run(sha256(orphan)); }
      finally { writer.close(); }
    }
  });
  assert.deepEqual(report.merged, []);
  assert.equal(report.deferred.length, 1);
  assert.match(report.deferred[0].message, /写入当前库时出错/);
  assert.equal(await readLedgerRecord(fixture, fixture.alpha.id), undefined, '复审 merge2 #1：确定回滚后立即撤掉 committing 记录');
  assert.deepEqual(await fs.readdir(path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'commits')), []);
  const target = readDatabase(fixture.current);
  try {
    assert.equal(target.count('conversation', 'id = ?', 'conversation_alpha_reuse'), 0, '事务整体回滚');
    assert.equal(target.count('content_object', 'sha256 = ?', sha256(orphan)), 0);
  } finally { target.close(); }
  assert.notEqual(databaseDigest(fixture.current), before);

  const retried = await merge(fixture, database);
  assert.equal(retried.merged.length, 1);
  const after = readDatabase(fixture.current);
  try {
    assert.equal(after.count('conversation', 'id = ?', 'conversation_alpha_reuse'), 1);
    assert.equal(after.count('content_object', 'sha256 = ?', sha256(orphan)), 1, '缺的那一行按来源补回');
  } finally { after.close(); }
});

test('复审 merge2 #1：提交前被杀后当前库独立出现同一项目（内容派生身份）不算“已有增删”，下次启动照常合并', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.current, [{ id: 'conversation_current_folder', project: SHARED_PROJECT }]);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_folder', project: ALPHA_PROJECT }]);
  const killed = await runChild(['kill', fixture.root, 'before-row-commit', fixture.alpha.id]);
  assert.equal(killed.signal, 'SIGKILL', killed.stderr);
  assert.equal((await readLedgerRecord(fixture, fixture.alpha.id))?.state, 'committing');
  // Before the next startup the user opens folder alpha in a current window: its ProjectContext
  // (id = hash(uri)) now exists in the target although nothing of the source was committed.
  const database = await openTarget(t, fixture.current);
  await database.transaction([
    repo('Conversation').insert({ id: 'conversation_new_in_alpha_folder', title: 'new', status: 'active', created_at: NOW, updated_at: NOW }),
    ...projectFolderAssignmentSteps({ conversationId: 'conversation_new_in_alpha_folder', folder: ALPHA_PROJECT, now: NOW })
  ]);
  const report = await merge(fixture, database);
  assert.deepEqual([report.failures, report.blocked, report.deferred], [[], [], []]);
  assert.deepEqual(report.merged.map((item) => [item.candidateId, item.recoveredCommit]), [[fixture.alpha.id, false]]);
  const target = readDatabase(fixture.current);
  try {
    assert.deepEqual(target.conversationsFor(ALPHA_PROJECT.uri), ['conversation_alpha_folder', 'conversation_new_in_alpha_folder']);
    assert.equal(target.count('project_context', 'id = ?', projectContextIdForUri(ALPHA_PROJECT.uri)), 1);
  } finally { target.close(); }
});

test('复审 merge2 #1：规划之后另一个窗口提交了同一项目：事务内已有即比对、没有才插入，本次直接合并成功', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.current, [{ id: 'conversation_current_race', project: SHARED_PROJECT }]);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_race', project: ALPHA_PROJECT }]);
  const database = await openTarget(t, fixture.current);
  const report = await merge(fixture, database, {
    async onFaultPoint(point) {
      if (point !== 'before-row-commit') return;
      await database.transaction([
        repo('Conversation').insert({ id: 'conversation_peer_alpha_folder', title: 'peer', status: 'active', created_at: NOW, updated_at: NOW }),
        ...projectFolderAssignmentSteps({ conversationId: 'conversation_peer_alpha_folder', folder: { ...ALPHA_PROJECT, name: 'renamed' }, now: NOW })
      ]);
    }
  });
  assert.deepEqual([report.failures, report.blocked, report.deferred], [[], [], []]);
  assert.equal(report.merged.length, 1);
  assert.equal((await readLedgerRecord(fixture, fixture.alpha.id))?.state, 'merged');
  const target = readDatabase(fixture.current);
  try {
    assert.deepEqual(target.conversationsFor(ALPHA_PROJECT.uri), ['conversation_alpha_race', 'conversation_peer_alpha_folder']);
    assert.equal(target.database.prepare('SELECT name FROM project_context WHERE id = ?').pluck()
      .get(projectContextIdForUri(ALPHA_PROJECT.uri)), 'renamed', '当前库已有的项目行保留（名称是展示信息）');
  } finally { target.close(); }
});

test('复审 merge2 #2：有待收尾任务的来源因冲突受阻或因过大推迟时，收尾之前就被拒绝，来源原样不动、提示如实', async (t) => {
  const conflict = await createFixture(t, { withBeta: false });
  await seed(conflict.current, [{ id: 'conversation_duplicate', project: SHARED_PROJECT, title: '当前库标题' }]);
  await seed(conflict.alpha, [
    { id: 'conversation_duplicate', project: SHARED_PROJECT, title: '旧库标题' },
    { id: 'conversation_alpha_running', project: SHARED_PROJECT }
  ]);
  await seedUnfinishedWork(conflict.alpha, [{ conversationId: 'conversation_alpha_running', kind: 'bare' }]);
  const before = await treeSnapshot(conflict.alpha.scopeRoot);
  const report = await merge(conflict, await openTarget(t, conflict.current));
  assert.equal(report.blocked[0]?.code, 'runtime-data-set-merge-conflict');
  assert.match(report.blocked[0].message, /两边内容都没有改动/);
  assert.doesNotMatch(report.blocked[0].message, /收尾/);
  assert.deepEqual(await treeSnapshot(conflict.alpha.scopeRoot), before, '被拒绝的来源没有被收尾、没有来源备份');
  await assert.rejects(fs.stat(path.join(controlRoot(conflict.alpha), 'merge-source-backups')), { code: 'ENOENT' });

  const large = await createFixture(t, { withBeta: false });
  await seed(large.alpha, [{ id: 'conversation_alpha_big', project: SHARED_PROJECT }]);
  await seedUnfinishedWork(large.alpha, [{ conversationId: 'conversation_alpha_big', kind: 'bare' }]);
  const largeBefore = await treeSnapshot(large.alpha.scopeRoot);
  const database = await openTarget(t, large.current);
  const deferred = await merge(large, database, { limits: { maxRows: 5, maxBytes: 1 << 30 } });
  assert.equal(deferred.deferred[0]?.code, 'runtime-data-set-merge-too-large');
  assert.deepEqual(await treeSnapshot(large.alpha.scopeRoot), largeBefore);
  const retried = await merge(large, database);
  assert.equal(retried.merged[0]?.finalized?.turns, 1, '之后能合并时照常收尾后合并');
});

test('复审 merge2 #3/#9：超限来源在冲突之前从不请求协调；协调时正文与备份已就绪，只包住最后的事务；重活不持有配置根锁', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.current, [{ id: 'conversation_duplicate', project: SHARED_PROJECT, title: '当前库标题' }]);
  await seed(fixture.alpha, [{ id: 'conversation_duplicate', project: SHARED_PROJECT, title: '旧库标题' }]);
  const database = await openTarget(t, fixture.current);
  const calls = [];
  const limits = { maxRows: 5, maxBytes: 1 << 30 };
  const coordinateOversized = async (input, run) => {
    calls.push(input.candidateId);
    await input.withLocks(run);
    return { state: 'completed' };
  };
  const blocked = await merge(fixture, database, { limits, coordinateOversized });
  assert.equal(blocked.blocked[0]?.code, 'runtime-data-set-merge-conflict');
  assert.deepEqual(calls, [], '会被拒绝的来源不打扰其它窗口');

  const clean = await createFixture(t, { withBeta: false });
  await seed(clean.alpha, [{ id: 'conversation_alpha_large', project: SHARED_PROJECT }]);
  const target = await openTarget(t, clean.current);
  const heldAt = {};
  const report = await merge(clean, target, {
    limits,
    onFaultPoint(point) {
      heldAt[point] = [isRuntimeDataRootAdmissionHeld(clean.root), isRuntimeMaintenanceHeld(clean.alpha.binding.paths)];
    },
    async coordinateOversized(input, run) {
      const text = messageText('conversation_alpha_large', 0);
      calls.push({ cas: await fs.readFile(casFile(clean.current.binding, text), 'utf8') === text,
        backups: (await fs.readdir(path.join(controlRoot(clean.current), 'merge-backups'))).length,
        claims: [isRuntimeDataRootAdmissionHeld(clean.root), isRuntimeMaintenanceHeld(input.targetPaths)] });
      await input.withLocks(async () => {
        calls.push({ locked: [isRuntimeDataRootAdmissionHeld(clean.root), isRuntimeMaintenanceHeld(input.targetPaths),
          isRuntimeMaintenanceHeld(clean.alpha.binding.paths)] });
        await run();
      });
      return { state: 'completed' };
    }
  });
  assert.deepEqual(report.merged.map((item) => item.exclusive), [true]);
  assert.deepEqual(calls, [{ cas: true, backups: 1, claims: [false, false] }, { locked: [true, true, false] }],
    '协调在锁外开始（正文已复制、备份已完成），拿锁后才执行；来源锁只在复核与事务那一步');
  assert.deepEqual(heldAt, {
    'after-snapshot-copy': [false, false], 'after-target-backup': [false, false], 'after-cas-transfer': [false, false],
    'before-row-commit': [true, true], 'after-row-commit': [true, true]
  }, '快照、核验、备份、正文复制都不持有配置根锁；复核与事务在锁内');
});

test('复审 merge2 #8：两个窗口同时启动，后处理的窗口在锁内重读账本，已被合并的来源直接跳过，不备份不提示', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_twice', project: SHARED_PROJECT }]);
  // One Runtime per process: the two batches stand for two windows (the ledger is shared state).
  const database = await openTarget(t, fixture.current);
  let inner;
  const outer = await merge(fixture, database, {
    // The second window picked the source, then the first window merged it completely.
    async onSourceStart() { inner ??= await merge(fixture, database); }
  });
  assert.equal(inner.merged.length, 1);
  assert.equal(outer.pendingSources, 1, '第二个窗口选源时来源还未合并');
  assert.deepEqual([outer.merged, outer.deferred, outer.blocked, outer.failures], [[], [], [], []], '不重复合并、不重复提示');
  assert.equal((await fs.readdir(path.join(controlRoot(fixture.current), 'merge-backups'))).length, 1, '第二个窗口不再备份');
  const target = readDatabase(fixture.current);
  try { assert.equal(target.count('conversation', 'id = ?', 'conversation_alpha_twice'), 1); }
  finally { target.close(); }

  // Nothing new to insert (the source files changed, its rows did not): recorded, not backed up, not reported.
  const touched = await createFixture(t, { withBeta: false });
  await seed(touched.alpha, [{ id: 'conversation_alpha_same_rows', project: SHARED_PROJECT }]);
  const touchedTarget = await openTarget(t, touched.current);
  assert.equal((await merge(touched, touchedTarget)).merged.length, 1);
  const backups = await fs.readdir(path.join(controlRoot(touched.current), 'merge-backups'));
  await fs.rm(path.join(resolveVscodeRuntimeMergeLedgerRoot(touched.paths), 'records', `${touched.alpha.id.replace(/:/g, '-')}.json`));
  const again = await merge(touched, touchedTarget);
  assert.deepEqual([again.pendingSources, again.merged, again.deferred], [1, [], []]);
  assert.deepEqual(await fs.readdir(path.join(controlRoot(touched.current), 'merge-backups')), backups);
  assert.equal((await readRuntimeDataSetMergeStates(touched.paths)).get(touched.alpha.id)?.changedSinceMerge, false);
});

test('复审 merge2 #8：规划之后另一个窗口合并了同一来源：提交前在锁内重读账本，直接跳过，不报告，本轮备份删除', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_raced', project: SHARED_PROJECT }]);
  const database = await openTarget(t, fixture.current);
  let inner;
  const outer = await merge(fixture, database, {
    // This window has planned, backed up and copied the bodies; meanwhile another window merges it.
    async onFaultPoint(point) {
      if (point === 'after-cas-transfer' && !inner) inner = await merge(fixture, database);
    }
  });
  assert.equal(inner.merged.length, 1);
  assert.deepEqual([outer.merged, outer.deferred, outer.blocked, outer.failures], [[], [], [], []]);
  const backups = await fs.readdir(path.join(controlRoot(fixture.current), 'merge-backups'));
  assert.deepEqual(backups, [path.basename(inner.merged[0].backupPath)], '后到窗口的本轮备份没有留下');
  const target = readDatabase(fixture.current);
  try { assert.equal(target.count('conversation', 'id = ?', 'conversation_alpha_raced'), 1); }
  finally { target.close(); }
});

test('复审 startup2 #2：合并中当前库被关闭（重载/切库）记为推迟而非失败；停止请求在来源开始前和规划前生效，什么都不记', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_closed', project: SHARED_PROJECT }]);
  const closing = await openTarget(t, fixture.current);
  const report = await merge(fixture, closing, { async onSourceStart() { await closing.close(); } });
  assert.deepEqual([report.merged, report.failures, report.blocked], [[], [], []]);
  assert.equal(report.deferred.length, 1);
  assert.match(report.deferred[0].message, /RuntimeDatabase is closed/);
  assert.equal(await readLedgerRecord(fixture, fixture.alpha.id), undefined, '不记为失败');
  const database = await openTarget(t, fixture.current);
  assert.equal((await merge(fixture, database)).merged.length, 1, '下次启动照常合并');

  const stop = await createFixture(t, { withBeta: false });
  await seed(stop.alpha, [{ id: 'conversation_alpha_stop', project: SHARED_PROJECT }]);
  await seedUnfinishedWork(stop.alpha, [{ conversationId: 'conversation_alpha_stop', kind: 'bare' }]);
  const stopTarget = await openTarget(t, stop.current);
  const sourceBefore = await treeSnapshot(stop.alpha.scopeRoot);
  const targetBefore = databaseDigest(stop.current);
  for (const stopAtCall of [3, 4]) {
    let calls = 0;
    const stopped = await merge(stop, stopTarget, { shouldContinue: () => ++calls < stopAtCall });
    assert.equal(stopped.stopped, true, `第 ${stopAtCall} 次检查时停止`);
    assert.deepEqual([stopped.merged, stopped.deferred, stopped.blocked, stopped.failures], [[], [], [], []]);
  }
  assert.equal(await readLedgerRecord(stop, stop.alpha.id), undefined);
  assert.deepEqual(await treeSnapshot(stop.alpha.scopeRoot), sourceBefore, '停止时来源没有被收尾');
  assert.equal(databaseDigest(stop.current), targetBefore);
  await assert.rejects(fs.stat(path.join(controlRoot(stop.current), 'merge-backups')), { code: 'ENOENT' });
});

test('复审 startup2 #6：持久合并请求有期限，过期后删除，不再让保留的库自动合并', async (t) => {
  const fixture = await createFixture(t, { withBeta: false, selected: 'alpha' });
  await seed(fixture.current, [{ id: 'conversation_default_kept', project: SHARED_PROJECT }]);
  let database = await openTarget(t, fixture.alpha);
  assert.equal((await merge(fixture, database)).merged.length, 1);
  await database.close();
  await selectVscodeRuntimeDataSet(fixture.paths, 'default');
  await seed(fixture.alpha, [{ id: 'conversation_alpha_kept', project: SHARED_PROJECT }]);
  await requestMerge(fixture, fixture.alpha);
  const file = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'requests', `${fixture.alpha.id.replace(/:/g, '-')}.json`);
  const request = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...request, requestedAt: new Date(Date.now() - RUNTIME_DATA_SET_MERGE_REQUEST_TTL_MS - 1000).toISOString() }));
  assert.equal((await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id)?.state, 'kept', '过期请求不再显示为已请求');
  database = await openTarget(t, fixture.current);
  const report = await merge(fixture, database);
  assert.deepEqual([report.pendingSources, report.merged], [0, []]);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' }, '过期请求被删除');
  assert.deepEqual(report.blocked.map((issue) => [issue.candidateId, issue.code, issue.newly]),
    [[fixture.alpha.id, 'runtime-data-set-merge-request-expired', true]], '复审 merge3 #4：过期不悄悄消失，提示一次');
  assert.match(report.blocked[0].message, /请求的合并在 \d+ 天内一直没有完成，已不再自动重试/);
  assert.deepEqual((await merge(fixture, database)).blocked, [], '只提示一次');
});

test('审查 #8：当前库备份失败时不留临时文件与空目录并推迟；成功后只保留最新几份备份', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_backup', project: SHARED_PROJECT }]);
  const database = await openTarget(t, fixture.current);
  const failing = {
    binding: database.binding,
    hostBootId: database.hostBootId,
    snapshot: (reads) => database.snapshot(reads),
    transaction: (steps) => database.transaction(steps),
    async backupTo(destination) {
      await fs.writeFile(destination, 'partial copy');
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
  };
  const report = await mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database: failing });
  assert.equal(report.deferred[0]?.code, 'runtime-data-set-merge-backup-failed');
  await assert.rejects(fs.stat(path.join(controlRoot(fixture.current), 'merge-backups')), { code: 'ENOENT' });

  const backups = path.join(controlRoot(fixture.current), 'merge-backups');
  // Millisecond time, then creation order (复审 merge2 #6: same-second backups sort by real time).
  const old = ['20260101T000000000Z-000009-ffffffff', '20260101T000000001Z-000001-00000000', '20260103T000000000Z-000001-aaaaaaaa'];
  for (const name of old) await fs.mkdir(path.join(backups, name), { recursive: true });
  const merged = await merge(fixture, database);
  assert.equal(merged.merged.length, 1);
  assert.match(path.basename(merged.merged[0].backupPath), /^\d{8}T\d{9}Z-\d{6}-[0-9a-f]{8}$/);
  const kept = (await fs.readdir(backups)).sort();
  assert.equal(kept.length, RUNTIME_DATA_SET_MERGE_BACKUP_RETENTION);
  assert.deepEqual(kept.slice(0, 2), old.slice(1));
  assert.equal(path.join(backups, kept[2]), merged.merged[0].backupPath);
});

test('复审 merge2 #6：备份之后才推迟的合并不留下本轮备份；来源正文位置不是普通文件属于来源自身的问题，记为失败', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.current, [{ id: 'conversation_current_retry', project: SHARED_PROJECT }]);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_retry', project: SHARED_PROJECT }]);
  const database = await openTarget(t, fixture.current);
  const backups = path.join(controlRoot(fixture.current), 'merge-backups');
  const failingLink = async () => { throw Object.assign(new Error('input/output error'), { code: 'EIO' }); };
  for (let startup = 0; startup < 3; startup += 1) {
    const report = await merge(fixture, database, { linkFile: failingLink });
    assert.deepEqual([report.merged.length, report.deferred[0]?.code], [0, 'EIO']);
    assert.deepEqual(await fs.readdir(backups).catch(() => []), [], `第 ${startup + 1} 次推迟后没有累积备份`);
  }

  const own = casFile(fixture.alpha.binding, messageText('conversation_alpha_retry', 0));
  await fs.chmod(path.dirname(own), 0o700);
  await fs.rm(own, { force: true });
  await fs.mkdir(own);
  const irregular = await merge(fixture, database);
  assert.deepEqual([irregular.deferred, irregular.failures.map((item) => item.code)], [[], ['runtime-data-set-merge-source-cas-invalid']]);
  assert.equal((await merge(fixture, database)).failures[0]?.newly, false, '同一来源状态不再重试');
  assert.deepEqual(await fs.readdir(backups).catch(() => []), []);
});

test('复审 merge2 #8：修剪时保留本批开始前最新的那份和本批自己的备份，即使其它窗口同时又做了更新的备份', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_prune', project: SHARED_PROJECT }]);
  const database = await openTarget(t, fixture.current);
  const backups = path.join(controlRoot(fixture.current), 'merge-backups');
  const before = ['20260101T000000000Z-000001-00000001', '20260102T000000000Z-000001-00000002'];
  const others = ['20990101T000000000Z-000001-0000000a', '20990101T000000000Z-000002-0000000b', '20990101T000000000Z-000003-0000000c'];
  for (const name of before) await fs.mkdir(path.join(backups, name), { recursive: true });
  const report = await merge(fixture, database, {
    async onFaultPoint(point) {
      if (point !== 'after-row-commit') return;
      for (const name of others) await fs.mkdir(path.join(backups, name), { recursive: true });
    }
  });
  const own = path.basename(report.merged[0].backupPath);
  assert.deepEqual((await fs.readdir(backups)).sort(), [before[1], own, ...others].sort());
});

test('超过在线事务上限的来源：无协调则推迟；协调成功走独占；协调未成功推迟；拒绝、占用或失败的来源从不触发协调', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_asking', project: SHARED_PROJECT }]);
  await seedInteractionRequest(fixture.alpha);
  await seed(fixture.beta, [{ id: 'conversation_beta_busy', project: SHARED_PROJECT }]);
  await publishHost(fixture.beta.binding, 'old-window');
  const gamma = await initializeScope(fixture.paths, 'gamma');
  await seed(gamma, [{ id: 'conversation_gamma_drift', project: SHARED_PROJECT }]);
  await downgradeToEpoch4(gamma.binding);
  await dropOneIndex(gamma.binding);
  const delta = await initializeScope(fixture.paths, 'delta');
  await seed(delta, [{ id: 'conversation_delta_large', project: SHARED_PROJECT }]);
  const database = await openTarget(t, fixture.current);
  const limits = { maxRows: 5, maxBytes: 1024 * 1024 * 1024 };
  const calls = [];
  const coordinate = (state) => async (input, run) => {
    calls.push(input);
    // A reason as the primitive words it, ending in its own full stop.
    if (state !== 'completed') return { state, reason: '有 1 个窗口正在忙（有任务正在进行）。' };
    await run();
    return { state: 'completed' };
  };

  const plain = await merge(fixture, database, { limits });
  assert.deepEqual(plain.deferred.map((item) => [item.candidateId, item.code]).sort(), [
    [delta.id, 'runtime-data-set-merge-too-large'], [fixture.beta.id, 'runtime-hosts-active']
  ].sort());
  assert.equal(plain.blocked[0]?.candidateId, fixture.alpha.id);
  assert.equal(plain.failures[0]?.candidateId, gamma.id);

  const busy = await merge(fixture, database, { limits, coordinateOversized: coordinate('busy') });
  assert.deepEqual(busy.deferred.map((item) => item.code).sort(), ['runtime-data-set-merge-exclusive-busy', 'runtime-hosts-active']);
  assert.deepEqual(calls.map((input) => input.candidateId), [delta.id], '只有预检确认能合并的来源才请求协调');
  assert.equal(calls[0].requesterHostBootId, database.hostBootId);
  assert.equal(calls[0].targetPaths.databasePath, fixture.current.binding.paths.databasePath);
  assert.match(calls[0].operationKey, new RegExp(`^${delta.id.replace(/[^\w]/g, '.')}@[0-9a-f]{16}$`));
  assert.equal(calls[0].requested, false);
  assert.match(busy.deferred.find((item) => item.candidateId === delta.id).message,
    /需要其它窗口暂时让出才能合并：有 1 个窗口正在忙（有任务正在进行）。以后会自动重试。/);
  assert.doesNotMatch(busy.deferred.find((item) => item.candidateId === delta.id).message, /。。/, 'coord3：原因不重复句号');

  // Through the real two-phase primitive: called outside every claim, it takes the engine's locks
  // once every window is ready; with no other window it runs at once, this window stays open.
  const exclusive = await merge(fixture, database, {
    limits,
    coordinateOversized: (input, run) => {
      calls.push(input);
      return runExclusiveRuntimeMaintenance(input.targetPaths, {
        operation: 'historical-merge', operationKey: input.operationKey, message: '为合并较大的旧聊天记录',
        configurationRootPath: fixture.root, requesterHostBootId: input.requesterHostBootId, ignoreBackoff: false,
        isDeterministicFailure: input.isDeterministicFailure, withLocks: input.withLocks
      }, run);
    }
  });
  assert.deepEqual(exclusive.merged.map((item) => [item.candidateId, item.exclusive]), [[delta.id, true]]);
  assert.deepEqual(calls.map((input) => input.candidateId), [delta.id, delta.id]);
  assert.equal(calls[0].operationKey, calls[1].operationKey, '来源未变则操作键不变（退避按它记）');

  await requestMerge(fixture, fixture.beta);
  await fs.rm(path.join(fixture.beta.binding.paths.dataRootPath, 'host-liveness'), { recursive: true });
  await seed(fixture.beta, [{ id: 'conversation_beta_more', project: SHARED_PROJECT }]);
  const later = await merge(fixture, database, { limits, coordinateOversized: coordinate('busy') });
  assert.equal(calls.at(-1).candidateId, fixture.beta.id);
  assert.equal(calls.at(-1).requested, false, '复审 startup2 #6：之后的启动不按“用户刚请求”协调');
  assert.equal(later.deferred.find((item) => item.candidateId === fixture.beta.id)?.requested, false);
  const requested = await merge(fixture, database, {
    limits, coordinateOversized: coordinate('completed'), candidateIds: [fixture.beta.id], requested: true
  });
  assert.deepEqual(requested.merged.map((item) => item.candidateId), [fixture.beta.id]);
  assert.equal(calls.at(-1).requested, true, '用户点击的那一次合并交给协调方用等待模式');
});

test('用户切走的库记为保留、不自动合并，只能明确请求；旧版本留下的固定根在当前库是工作区库时也自动合并', async (t) => {
  const fixture = await createFixture(t, { selected: 'alpha' });
  await seed(fixture.current, [{ id: 'conversation_default_legacy', project: SHARED_PROJECT }]);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_first', project: SHARED_PROJECT }]);
  await seed(fixture.beta, [{ id: 'conversation_beta_current', project: SHARED_PROJECT }]);
  // Old-version state: no switch history. Merging into alpha takes the fixed root and beta.
  let database = await openTarget(t, fixture.alpha);
  const legacy = await merge(fixture, database);
  assert.deepEqual(legacy.merged.map((item) => item.candidateId).sort(), ['default', fixture.beta.id].sort());
  await database.close();

  // In this version the user switches alpha → beta: alpha is kept apart from then on.
  await selectVscodeRuntimeDataSet(fixture.paths, fixture.beta.id);
  const delta = await initializeScope(fixture.paths, 'delta');
  await seed(delta, [{ id: 'conversation_delta_new', project: SHARED_PROJECT }]);
  database = await openTarget(t, fixture.beta);
  const afterSwitch = await merge(fixture, database);
  assert.deepEqual(afterSwitch.merged.map((item) => item.candidateId), [delta.id], '保留的库与已合并过的库都不自动合并');
  const states = await readRuntimeDataSetMergeStates(fixture.paths);
  assert.equal(states.get(fixture.alpha.id)?.state, 'kept');
  assert.deepEqual([states.get('default')?.state, states.get('default')?.intoCurrent], ['merged', false]);

  await requestMerge(fixture, fixture.alpha);
  const explicit = await merge(fixture, database);
  assert.deepEqual(explicit.merged.map((item) => item.candidateId), [fixture.alpha.id]);
  const target = readDatabase(fixture.beta);
  try { assert.equal(target.count('conversation', 'id = ?', 'conversation_alpha_first'), 1); }
  finally { target.close(); }
});

test('审查 #2：已合并来源之后又有新变化会显示出来，不自动重复合并，可明确重新合并', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_before', project: SHARED_PROJECT }]);
  let database = await openTarget(t, fixture.current);
  assert.equal((await merge(fixture, database, { candidateIds: [fixture.alpha.id] })).merged.length, 1);
  await database.close();

  await selectVscodeRuntimeDataSet(fixture.paths, fixture.alpha.id);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_after_merge', project: SHARED_PROJECT }]);
  await selectVscodeRuntimeDataSet(fixture.paths, 'default');
  const state = (await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id);
  assert.deepEqual([state?.state, state?.intoCurrent, state?.changedSinceMerge], ['merged', true, true]);
  database = await openTarget(t, fixture.current);
  assert.deepEqual((await merge(fixture, database, { candidateIds: [fixture.alpha.id] })).merged, [], '不自动重复合并');
  await requestMerge(fixture, fixture.alpha);
  const again = await merge(fixture, database, { candidateIds: [fixture.alpha.id] });
  assert.equal(again.merged[0]?.insertedConversations, 1, '只插入合并后新增的对话，已有行复用');
  assert.equal((await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id)?.changedSinceMerge, false);
});

test('审查 #11：合并记录放在配置根，删除合并目标后来源不会被再次自动合并', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_once', project: SHARED_PROJECT }]);
  let database = await openTarget(t, fixture.current);
  assert.equal((await merge(fixture, database, { candidateIds: [fixture.alpha.id] })).merged.length, 1);
  await database.close();
  await selectVscodeRuntimeDataSet(fixture.paths, fixture.beta.id);
  await deleteUnselectedRuntimeDataSet(fixture.paths, 'default', fixture.current.binding.dataSetId);
  database = await openTarget(t, fixture.beta);
  const afterDelete = await merge(fixture, database);
  assert.equal(afterDelete.pendingSources, 0);
  assert.deepEqual(afterDelete.merged, []);
  assert.equal((await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id)?.state, 'merged');
});

test('审查 #12：v0.0.10–0.0.20 窗口的 runtime-owner/owner.json 按进程身份判定占用', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_owned', project: SHARED_PROJECT }]);
  const ownerFile = path.join(fixture.alpha.scopeRoot, 'runtime-owner', 'owner.json');
  await fs.mkdir(path.dirname(ownerFile), { recursive: true });
  const owner = { workspaceKey: 'alpha', ownerToken: randomUUID(), pid: process.pid, startedAt: NOW };
  const database = await openTarget(t, fixture.current);

  await fs.writeFile(ownerFile, JSON.stringify({ ...owner, processStartIdentity: ownProcessStartIdentity() }));
  const alive = await merge(fixture, database);
  assert.equal(alive.deferred[0]?.code, 'runtime-legacy-owner-active');
  await fs.writeFile(ownerFile, '{ torn');
  assert.equal((await merge(fixture, database)).deferred[0]?.code, 'runtime-legacy-owner-active', '无法证明已退出就视为占用');

  await fs.writeFile(ownerFile, JSON.stringify({ ...owner, processStartIdentity: 'a-previous-boot' }));
  const reused = await merge(fixture, database);
  assert.deepEqual(reused.merged.map((item) => item.candidateId), [fixture.alpha.id], 'pid 已被复用即视为旧窗口已退出');
});

test('已发布 epoch 4 旧库先备份并就地升级再合并；结构漂移记为失败不重复提示；升级后被拒绝时提示写明已就地升级', async (t) => {
  const fixture = await createFixture(t);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_epoch4', project: SHARED_PROJECT }]);
  await downgradeToEpoch4(fixture.alpha.binding);
  await seed(fixture.beta, [{ id: 'conversation_beta_epoch4_asking', project: SHARED_PROJECT }]);
  await seedInteractionRequest(fixture.beta);
  await downgradeToEpoch4(fixture.beta.binding);
  const gamma = await initializeScope(fixture.paths, 'gamma');
  await seed(gamma, [{ id: 'conversation_gamma_drift', project: SHARED_PROJECT }]);
  await downgradeToEpoch4(gamma.binding);
  await dropOneIndex(gamma.binding);
  const database = await openTarget(t, fixture.current);

  const report = await merge(fixture, database);
  assert.deepEqual(report.merged.map((item) => [item.candidateId, item.upgradedFromEpoch]), [[fixture.alpha.id, 4]]);
  assert.equal(report.blocked[0]?.candidateId, fixture.beta.id);
  assert.match(report.blocked[0].message, /已按已发布的第 4 代格式先备份并就地升级到当前格式/);
  assert.doesNotMatch(report.blocked[0].message, /原数据保持不变/);
  assert.equal(report.failures[0]?.candidateId, gamma.id);
  assert.equal(report.failures[0].newly, true);
  const again = await merge(fixture, database);
  assert.equal(again.pendingSources, 0);
  assert.deepEqual(again.failures.map((item) => [item.candidateId, item.newly]), [[gamma.id, false]]);
});

test('迁移复用：CAS 在线预复制（按 RootAuthority 校验来源身份）到其它目录的全新根，按原样携带未完成工作', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [
    { id: 'conversation_alpha_moved', project: SHARED_PROJECT },
    { id: 'conversation_alpha_running', project: SHARED_PROJECT }
  ]);
  await seedUnfinishedWork(fixture.alpha, [{ conversationId: 'conversation_alpha_running', kind: 'leased-model-request' }]);
  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-dataset-merge-other-'));
  t.after(() => fs.rm(otherRoot, { recursive: true, force: true }));
  const fresh = await initialize(otherRoot, 'default');
  const input = {
    candidateId: fixture.alpha.id,
    expectedDataSetId: fixture.alpha.binding.dataSetId,
    expectedRootInstanceId: fixture.alpha.binding.rootInstanceId
  };
  const crossDevice = async () => { throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' }); };
  const sourceBefore = await treeSnapshot(fixture.alpha.scopeRoot);

  await assert.rejects(precopyRuntimeDataSetCas(fixture.paths, { ...input, expectedDataSetId: 'someone-else' },
    { configurationRootPath: otherRoot, binding: fresh.binding }), { code: 'runtime-data-set-merge-identity-mismatch' });
  const precopy = await precopyRuntimeDataSetCas(fixture.paths, input,
    { configurationRootPath: otherRoot, binding: fresh.binding }, { linkFile: crossDevice });
  assert.ok(precopy.copiedCasObjects >= 3);
  assert.equal(await fs.readFile(casFile(fresh.binding, messageText('conversation_alpha_moved', 0)), 'utf8'),
    messageText('conversation_alpha_moved', 0));

  const database = await openTarget(t, fresh);
  const target = { configurationRootPath: otherRoot, database };
  const result = await mergeRuntimeDataSetIntoDatabase(fixture.paths, input, target, { linkFile: crossDevice, migration: true });
  assert.equal(result.insertedConversations, 2);
  assert.equal(result.copiedCasObjects, 0, '预复制之后不再复制正文');
  assert.equal(result.reusedCasObjects, precopy.copiedCasObjects);
  const moved = readDatabase(fresh);
  try {
    assert.equal(moved.count('turn', "status = 'active'"), 1, '迁移时未完成工作原样带到新根，由新根的恢复处理');
    assert.equal(moved.count('execution_lease'), 1);
    assert.deepEqual(moved.database.pragma('foreign_key_check'), []);
  } finally { moved.close(); }
  assert.deepEqual(await treeSnapshot(fixture.alpha.scopeRoot), sourceBefore);
});

test('迁移遇到正在接收回复的模型请求时明确失败：目标不写入任何行，来源和合并记录原样不动', async (t) => {
  const fixture = await createFixture(t, { withBeta: false, selected: 'alpha' });
  await seed(fixture.alpha, [
    { id: 'conversation_alpha_kept', project: SHARED_PROJECT },
    { id: 'conversation_alpha_streaming', project: SHARED_PROJECT }
  ]);
  await seedUnfinishedWork(fixture.alpha, [{ conversationId: 'conversation_alpha_streaming', kind: 'leased-model-request' }]);
  const streaming = new Database(fixture.alpha.binding.paths.databasePath);
  try {
    streaming.prepare("UPDATE model_request SET status = 'streaming' WHERE id = ?")
      .run('conversation_alpha_streaming_unfinished_turn_request');
  } finally { streaming.close(); }
  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-dataset-merge-streaming-'));
  t.after(() => fs.rm(otherRoot, { recursive: true, force: true }));
  const fresh = await initialize(otherRoot, 'default');
  const database = await openTarget(t, fresh);
  const sourceBefore = await treeSnapshot(fixture.alpha.scopeRoot);
  const ledgerBefore = await treeSnapshot(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths)).catch(() => undefined);

  // The selected data set is the migration source; a historical merge would defer it instead.
  await assert.rejects(mergeRuntimeDataSetIntoDatabase(fixture.paths, {
    candidateId: fixture.alpha.id,
    expectedDataSetId: fixture.alpha.binding.dataSetId,
    expectedRootInstanceId: fixture.alpha.binding.rootInstanceId
  }, { configurationRootPath: otherRoot, database }, { migration: true }), (error) => {
    assert.equal(error.code, 'runtime-data-set-merge-streaming-model-request');
    assert.match(error.message, /1 个正在接收回复的模型请求/);
    return true;
  });
  const moved = readDatabase(fresh);
  try { assert.equal(moved.count('conversation'), 0, '目标库没有写入任何对话'); }
  finally { moved.close(); }
  assert.deepEqual(await treeSnapshot(fixture.alpha.scopeRoot), sourceBefore);
  assert.deepEqual(await treeSnapshot(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths)).catch(() => undefined), ledgerBefore,
    '迁移不写合并记录');
});

test('复审 merge3 #1：规划之后当前库又写入协作消息，message_seq 在合并事务内分配，本次照常合并且顺序保持', async (t) => {
  const fixture = await seqFixture(t);
  const database = await openTarget(t, fixture.current);
  const report = await merge(fixture, database, {
    async onFaultPoint(point) {
      if (point === 'after-cas-transfer') await postCollaborationMessage(fixture.current, database, 'conversation_current_seq', 'collaboration_current_late');
    }
  });
  assert.deepEqual([report.merged.length, report.deferred, report.blocked], [1, [], []]);
  assertCollaborationOrder(fixture.current,
    ['collaboration_current_1', 'collaboration_current_late', 'collaboration_alpha_1', 'collaboration_alpha_2']);
});

test('复审 merge3 #1：超限来源在锁外等待时其它窗口仍在写协作消息，它们让出之后的事务照常提交，不会白重载', async (t) => {
  const fixture = await seqFixture(t);
  const database = await openTarget(t, fixture.current);
  const committed = [];
  const coordinateOversized = async (input, run) => {
    // whenBusy 'wait': a busy window keeps working, without any lock held here, until it is idle.
    await postCollaborationMessage(fixture.current, database, 'conversation_current_seq', 'collaboration_current_while_waiting');
    // Every other window has yielded (reloaded) now: the locks and the one transaction.
    await input.withLocks(run).then(() => committed.push(true), (error) => { committed.push(error.message); throw error; });
    return { state: 'completed' };
  };
  const report = await merge(fixture, database, {
    limits: { maxRows: 1, maxBytes: Number.MAX_SAFE_INTEGER }, coordinateOversized,
    candidateIds: [fixture.alpha.id], requested: true
  });
  assert.deepEqual(committed, [true], '其它窗口让出之后的事务没有失败');
  assert.deepEqual([report.merged.length, report.merged[0]?.exclusive, report.deferred], [1, true, []]);
  assertCollaborationOrder(fixture.current,
    ['collaboration_current_1', 'collaboration_current_while_waiting', 'collaboration_alpha_1', 'collaboration_alpha_2']);
});

test('复审 merge3 #3：选源阶段只读账本和文件状态，已记录来源的内容指纹未命中缓存时在配置根 admission 之外计算', async (t) => {
  const fixture = await conflictFixture(t);
  const database = await openTarget(t, fixture.current);
  assert.equal((await merge(fixture, database)).blocked[0]?.code, 'runtime-data-set-merge-conflict');
  // Same content, other file state (opened and checkpointed elsewhere, copied back, …): not cached.
  const later = new Date(Date.now() + 5_000);
  await fs.utimes(fixture.alpha.binding.paths.databasePath, later, later);
  const facts = kernelFile('runtimeDataSetFacts.js');
  const original = facts.readRuntimeDataSetFacts;
  const reads = [];
  facts.readRuntimeDataSetFacts = (...args) => {
    reads.push(isRuntimeDataRootAdmissionHeld(fixture.root));
    return original(...args);
  };
  let report;
  try { report = await merge(fixture, database); }
  finally { facts.readRuntimeDataSetFacts = original; }
  assert.deepEqual(reads, [false], '整库读取算指纹只在 admission 之外做一次');
  assert.equal(report.pendingSources, 0);
  assert.deepEqual(report.blocked.map((issue) => [issue.code, issue.newly]), [['runtime-data-set-merge-conflict', false]], '内容没变：仍按已记录的冲突处理，不重复提示');
});

test('复审 merge3 #4：事务确定回滚后原样恢复的拒绝记录保留判定时间，之后的持久请求照常重试', async (t) => {
  const fixture = await conflictFixture(t);
  const orphan = 'orphan body present in both data sets';
  await ingest(fixture.current, orphan);
  await ingest(fixture.alpha, orphan);
  const database = await openTarget(t, fixture.current);
  assert.equal((await merge(fixture, database)).blocked[0]?.code, 'runtime-data-set-merge-conflict');
  const judged = await readLedgerRecord(fixture, fixture.alpha.id);
  // The user resolves the conflict on the current side, then asks for the merge again.
  await database.transaction([repo('Conversation').update('conversation_both', { title: 'alpha title' })]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await requestMerge(fixture, fixture.alpha);
  const rolledBack = await merge(fixture, database, {
    onFaultPoint(point) {
      if (point !== 'before-row-commit') return;
      const writer = new Database(fixture.current.binding.paths.databasePath);
      try { writer.prepare('DELETE FROM content_object WHERE sha256 = ?').run(sha256(orphan)); }
      finally { writer.close(); }
    }
  });
  assert.match(rolledBack.deferred[0]?.message ?? '', /写入当前库时出错/);
  assert.deepEqual(await readLedgerRecord(fixture, fixture.alpha.id), judged, '恢复的记录与回滚前完全相同（包括判定时间）');
  assert.equal((await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id)?.state, 'requested');
  const retried = await merge(fixture, database);
  assert.deepEqual([retried.merged.length, retried.blocked], [1, []], '请求晚于判定，照常重试');
});

test('复审 merge3 #4：提交前崩溃留下的 committing 记录确认没有提交时，放回它替换的记录（上次合并不丢）', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_once', project: SHARED_PROJECT }]);
  const database = await openTarget(t, fixture.current);
  assert.equal((await merge(fixture, database)).merged.length, 1);
  const merged = await readLedgerRecord(fixture, fixture.alpha.id);
  // Continued in the source afterwards (now conflicting), and an explicit re-merge crashed before its commit.
  const source = new Database(fixture.alpha.binding.paths.databasePath);
  try {
    source.prepare("UPDATE conversation SET title = 'continued elsewhere' WHERE id = 'conversation_alpha_once'").run();
    source.pragma('wal_checkpoint(TRUNCATE)');
  } finally { source.close(); }
  const ledger = resolveVscodeRuntimeMergeLedgerRoot(fixture.paths);
  await fs.mkdir(path.join(ledger, 'commits'), { recursive: true });
  await fs.writeFile(path.join(ledger, 'commits', 'crashed.json'), JSON.stringify({
    kind: 'limcode-runtime-data-set-merge-commit', commitId: 'crashed', rows: [['Conversation', 'conversation_never_committed']]
  }));
  await fs.writeFile(path.join(ledger, 'records', `${fixture.alpha.id.replace(/:/g, '-')}.json`), JSON.stringify({
    ...merged, state: 'committing', commitId: 'crashed', source: { ...merged.source, contentDigest: 'crashed-attempt' },
    replaced: merged, updatedAt: new Date().toISOString()
  }));
  const report = await merge(fixture, database);
  assert.equal(report.blocked[0]?.code, 'runtime-data-set-merge-conflict');
  const record = await readLedgerRecord(fixture, fixture.alpha.id);
  assert.deepEqual([record.state, record.lastMerged?.mergedAt], ['blocked', merged.mergedAt], '上次合并仍有记录');
  assert.equal((await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id)?.lastMerged?.intoCurrent, true);
});

test('复审 merge3 #5：规划之后来源文件被改写，锁内按文件状态复核后推迟，过期计划不写入，下次合并新内容', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_r5', project: SHARED_PROJECT }]);
  const database = await openTarget(t, fixture.current);
  const report = await merge(fixture, database, {
    onFaultPoint(point) { if (point === 'after-cas-transfer') rawInsertConversations(fixture.alpha, 'late', 1); }
  });
  assert.deepEqual([report.merged.length, report.deferred[0]?.code], [0, 'runtime-data-set-merge-source-changed']);
  assert.equal(await readLedgerRecord(fixture, fixture.alpha.id), undefined, '没有按旧内容记为已合并');
  const midway = readDatabase(fixture.current);
  try { assert.equal(midway.count('conversation'), 0, '过期计划没有写入'); } finally { midway.close(); }
  assert.equal((await merge(fixture, database)).merged.length, 1);
  const after = readDatabase(fixture.current);
  try { assert.equal(after.count('conversation', 'id = ?', 'raw_late_0'), 1); } finally { after.close(); }
});

test('复审 merge3 #5：复制私有快照期间来源被改写就重新复制；一直在变则推迟', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_copy', project: SHARED_PROJECT }]);
  const database = await openTarget(t, fixture.current);
  let copies = 0;
  const report = await merge(fixture, database, {
    onFaultPoint(point) { if (point === 'after-snapshot-copy' && ++copies === 1) rawInsertConversations(fixture.alpha, 'during_copy', 1); }
  });
  assert.equal(copies, 2, '第一份副本作废，重新复制');
  assert.deepEqual([report.merged.length, report.deferred], [1, []]);
  const target = readDatabase(fixture.current);
  try { assert.equal(target.count('conversation', 'id = ?', 'raw_during_copy_0'), 1, '合并的是来源的新内容'); } finally { target.close(); }

  const busy = await createFixture(t, { withBeta: false });
  await seed(busy.alpha, [{ id: 'conversation_alpha_busy', project: SHARED_PROJECT }]);
  const busyTarget = await openTarget(t, busy.current);
  let writes = 0;
  const changing = await merge(busy, busyTarget, {
    onFaultPoint(point) { if (point === 'after-snapshot-copy') rawInsertConversations(busy.alpha, `write_${++writes}`, 1); }
  });
  assert.deepEqual([writes, changing.merged.length, changing.deferred[0]?.code], [3, 0, 'runtime-data-set-merge-source-changed']);
  assert.equal(await readLedgerRecord(busy, busy.alpha.id), undefined);
});

test('复审 merge3 #5：检查通过之后、收尾之前来源被改写，锁内复核后推迟，来源不收尾也不备份', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_finalize', project: SHARED_PROJECT }]);
  await seedUnfinishedWork(fixture.alpha, [{ conversationId: 'conversation_alpha_finalize', kind: 'bare' }]);
  const database = await openTarget(t, fixture.current);
  const report = await merge(fixture, database, {
    onFaultPoint(point) { if (point === 'before-source-finalization') rawInsertConversations(fixture.alpha, 'before_finalize', 1); }
  });
  assert.deepEqual([report.merged.length, report.deferred[0]?.code], [0, 'runtime-data-set-merge-source-changed']);
  const source = readDatabase(fixture.alpha);
  try { assert.equal(source.count('turn', "status = 'active'"), 1, '没有收尾'); } finally { source.close(); }
  await assert.rejects(fs.stat(path.join(controlRoot(fixture.alpha), 'merge-source-backups')), { code: 'ENOENT' });
  const again = await merge(fixture, database);
  assert.deepEqual([again.merged.length, again.merged[0]?.finalized?.turns], [1, 1]);
});

test('复审 merge3 #8：收尾之后收到停止按推迟处理并记下收尾；下次合并成功或被拒时如实说明收尾与备份位置', async (t) => {
  const stopAfterFinalization = async (fixture, database) => {
    let copies = 0;
    let stop = false;
    return merge(fixture, database, {
      shouldContinue: () => !stop,
      // The second copy is the one taken after the source was finalized.
      onFaultPoint(point) { if (point === 'after-snapshot-copy' && ++copies === 2) stop = true; }
    });
  };
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_stop', project: SHARED_PROJECT }]);
  await seedUnfinishedWork(fixture.alpha, [{ conversationId: 'conversation_alpha_stop', kind: 'bare' }]);
  const database = await openTarget(t, fixture.current);
  const stopped = await stopAfterFinalization(fixture, database);
  assert.equal(stopped.stopped, true);
  assert.deepEqual([stopped.merged, stopped.deferred.map((issue) => issue.code)], [[], ['runtime-data-set-merge-stopped']]);
  assert.match(stopped.deferred[0].message, /已把这个库里的1 个中断的任务按“中止”收尾.*收尾前的备份在 /);
  const marker = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'finalizations', `${fixture.alpha.id.replace(/:/g, '-')}.json`);
  const recorded = JSON.parse(await fs.readFile(marker, 'utf8'));
  assert.deepEqual([recorded.turns, recorded.complete], [1, true]);
  const source = readDatabase(fixture.alpha);
  try { assert.equal(source.count('turn', "status = 'active'"), 0, '来源已收尾'); } finally { source.close(); }

  const next = await merge(fixture, database);
  assert.equal(next.merged.length, 1);
  assert.deepEqual(next.merged[0].finalized, { turns: 1, intents: 0, sourceBackupPath: recorded.sourceBackupPath }, '成功提示里有之前的收尾和备份位置');
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' }, '说过之后删除');

  const refused = await createFixture(t, { withBeta: false });
  await seed(refused.alpha, [{ id: 'conversation_alpha_stop', project: SHARED_PROJECT }]);
  await seedUnfinishedWork(refused.alpha, [{ conversationId: 'conversation_alpha_stop', kind: 'bare' }]);
  const refusedTarget = await openTarget(t, refused.current);
  assert.equal((await stopAfterFinalization(refused, refusedTarget)).deferred[0]?.code, 'runtime-data-set-merge-stopped');
  // Before the next startup the same conversation appears in the current data set with other content.
  await refusedTarget.transaction([
    repo('Conversation').insert({ id: 'conversation_alpha_stop', title: 'other', status: 'active', created_at: NOW, updated_at: NOW })
  ]);
  const blocked = await merge(refused, refusedTarget);
  assert.equal(blocked.blocked[0]?.code, 'runtime-data-set-merge-conflict');
  assert.match(blocked.blocked[0].message, /当前库没有改动/);
  assert.doesNotMatch(blocked.blocked[0].message, /两边内容都没有改动/);
  assert.match(blocked.blocked[0].message, /之前一次合并时已把这个库里的1 个中断的任务按“中止”收尾.*收尾前的备份在 /);
});

test('盲审 merge #4：明确请求合并已合并且没有变化的来源，结果里有一条“已合并，没有新内容”', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_r3', project: SHARED_PROJECT }]);
  const database = await openTarget(t, fixture.current);
  assert.equal((await merge(fixture, database)).merged.length, 1);
  await requestMerge(fixture, fixture.alpha);
  const explicit = await merge(fixture, database, { candidateIds: [fixture.alpha.id], requested: true });
  assert.deepEqual([explicit.deferred, explicit.blocked, explicit.failures], [[], [], []]);
  assert.deepEqual(explicit.merged.map((item) => [item.candidateId, item.alreadyMerged, item.insertedRows, item.backupPath]),
    [[fixture.alpha.id, true, 0, undefined]]);
  // A startup with nothing requested stays silent.
  assert.deepEqual((await merge(fixture, database)).merged, []);
});

test('盲审 merge #3/#5：收尾数按收尾后来源里的实际状态统计：上次收尾中途崩溃后再收尾不重复计数，排队消息的取消照样计入', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [
    { id: 'conversation_alpha_queued', project: SHARED_PROJECT },
    { id: 'conversation_alpha_active', project: SHARED_PROJECT }
  ]);
  await seedUnfinishedWork(fixture.alpha, [
    { conversationId: 'conversation_alpha_queued', kind: 'queued-intent' },
    { conversationId: 'conversation_alpha_active', kind: 'bare' }
  ]);
  // An earlier attempt set out to close both, cancelled the queued message and crashed before the Turn:
  // its record still has the numbers it planned and says it did not complete.
  rawSource(fixture.alpha, (source) => {
    source.prepare("UPDATE turn_intent SET state = 'cancelled' WHERE id = ?").run('conversation_alpha_queued_intent');
  });
  const marker = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'finalizations', `${fixture.alpha.id.replace(/:/g, '-')}.json`);
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, JSON.stringify({
    kind: 'limcode-runtime-data-set-merge-finalization', candidateId: fixture.alpha.id,
    source: { dataSetId: fixture.alpha.binding.dataSetId, rootInstanceId: fixture.alpha.binding.rootInstanceId },
    turnIds: ['conversation_alpha_active_unfinished_turn'], intentIds: ['conversation_alpha_queued_intent'],
    turns: 1, intents: 1, sourceBackupPath: '/earlier/source-backup', complete: false, finalizedAt: NOW
  }));
  const database = await openTarget(t, fixture.current);
  const report = await merge(fixture, database);
  assert.deepEqual(report.merged.map((item) => item.finalized), [{ turns: 1, intents: 1, sourceBackupPath: '/earlier/source-backup' }],
    '中断的任务收尾一次就算一次，取消的排队消息也算上');
  const source = readDatabase(fixture.alpha);
  try {
    assert.equal(source.count('turn', "status = 'active'"), 0);
    assert.equal(source.database.prepare('SELECT state FROM turn_intent').pluck().get(), 'cancelled');
  } finally { source.close(); }
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });

  // The source had only a queued message: nothing is counted as an interrupted task.
  const queued = await createFixture(t, { withBeta: false });
  await seed(queued.alpha, [{ id: 'conversation_alpha_r4', project: SHARED_PROJECT }]);
  await seedUnfinishedWork(queued.alpha, [{ conversationId: 'conversation_alpha_r4', kind: 'queued-intent' }]);
  const queuedTarget = await openTarget(t, queued.current);
  const queuedReport = await merge(queued, queuedTarget);
  assert.deepEqual(queuedReport.merged.map((item) => [item.finalized?.turns, item.finalized?.intents]), [[0, 1]]);
});

test('盲审 merge #8：收尾原因区分来源：本版本切走（用户保留）的库写“合并前收尾。”，旧版本留下的库写“旧版本升级时中断，合并前收尾。”', async (t) => {
  const fixture = await createFixture(t, { selected: 'alpha' });
  await selectVscodeRuntimeDataSet(fixture.paths, 'default');
  await seed(fixture.alpha, [{ id: 'conversation_alpha_kept', project: SHARED_PROJECT }]);
  await seed(fixture.beta, [{ id: 'conversation_beta_legacy', project: SHARED_PROJECT }]);
  await seedUnfinishedWork(fixture.alpha, [{ conversationId: 'conversation_alpha_kept', kind: 'bare' }]);
  await seedUnfinishedWork(fixture.beta, [{ conversationId: 'conversation_beta_legacy', kind: 'bare' }]);
  const database = await openTarget(t, fixture.current);
  assert.deepEqual((await merge(fixture, database)).merged.map((item) => item.candidateId), [fixture.beta.id], '保留的库不自动合并');
  await requestMerge(fixture, fixture.alpha);
  assert.deepEqual((await merge(fixture, database, { candidateIds: [fixture.alpha.id], requested: true })).merged.map((item) => item.candidateId),
    [fixture.alpha.id]);
  const target = readDatabase(fixture.current);
  try {
    const reason = (turnId) => target.database.prepare('SELECT reason FROM turn_termination WHERE turn_id = ?').pluck().get(turnId);
    assert.equal(reason('conversation_alpha_kept_unfinished_turn'), KEPT_MERGE_FINALIZATION_REASON);
    assert.equal(reason('conversation_beta_legacy_unfinished_turn'), MERGE_FINALIZATION_REASON);
  } finally { target.close(); }
  assert.equal(KEPT_MERGE_FINALIZATION_REASON, '合并前收尾。');
});

test('盲审 merge #6：“历史与存储管理”读合并状态时，没缓存的内容指纹在该库的 admission 与 maintenance 里读取，缓存命中不取锁', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_state', project: SHARED_PROJECT }]);
  const database = await openTarget(t, fixture.current);
  assert.equal((await merge(fixture, database)).merged.length, 1);
  // Opening the library without writing changes its file state only: its fingerprint is no longer cached.
  const touch = () => fs.utimes(fixture.alpha.binding.paths.databasePath, new Date(), new Date());
  const holdMaintenance = async () => {
    let release;
    let held;
    const acquired = new Promise((resolve) => { held = resolve; });
    const done = withRuntimeMaintenance(fixture.alpha.binding.paths, async () => {
      held();
      await new Promise((resolve) => { release = resolve; });
    });
    await acquired;
    return async () => { release(); await done; };
  };
  await touch();
  let release = await holdMaintenance();
  let settled = false;
  const reading = readRuntimeDataSetMergeStates(fixture.paths).then((states) => { settled = true; return states; });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(settled, false, '要复制这个库时等它的 maintenance');
  await release();
  const states = await reading;
  assert.deepEqual([states.get(fixture.alpha.id)?.state, states.get(fixture.alpha.id)?.changedSinceMerge], ['merged', false]);
  // Now cached for exactly these files: read without taking anything.
  release = await holdMaintenance();
  try {
    assert.equal((await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id)?.changedSinceMerge, false);
  } finally { await release(); }
});

test('盲审 merge #4：合并状态读不出来（私有副本放不下）时显示无法读取，而不是合并后有新变化', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_unreadable', project: SHARED_PROJECT }]);
  const database = await openTarget(t, fixture.current);
  assert.equal((await merge(fixture, database)).merged.length, 1);
  // Opened without writing (its fingerprint is no longer cached), and no room for the private copy.
  await fs.utimes(fixture.alpha.binding.paths.databasePath, new Date(), new Date());
  const temporary = process.env.TMPDIR;
  process.env.TMPDIR = path.join(fixture.root, 'no-such-directory');
  let unreadable;
  try { unreadable = (await readRuntimeDataSetMergeStates(fixture.paths)).get(fixture.alpha.id); }
  finally {
    if (temporary === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = temporary;
  }
  assert.deepEqual([unreadable?.state, unreadable?.changedSinceMerge, unreadable?.sourceUnreadable], ['merged', false, true]);
});

test('跨模块盲审 #7：合并前备份之前核对剩余空间：不够就推迟并写明约需多少 MB，不写备份、不收尾', async (t) => {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.alpha, [{ id: 'conversation_alpha_space', project: SHARED_PROJECT }]);
  const database = await openTarget(t, fixture.current);
  const report = await merge(fixture, database, { freeSpace: async () => 1024 });
  assert.equal(report.deferred[0]?.code, 'runtime-data-set-merge-disk-full');
  assert.match(report.deferred[0].message, /^磁盘空间不足，需要约 \d+ MB：合并前要先在 .+ 备份当前历史库$/);
  await assert.rejects(fs.stat(path.join(controlRoot(fixture.current), 'merge-backups')), { code: 'ENOENT' }, '一个字节都没写');
  assert.deepEqual((await merge(fixture, database, { freeSpace: async () => Number.MAX_SAFE_INTEGER })).merged.length, 1);

  // A source whose work would be closed first: its own backup is checked the same way, before anything is closed.
  const busy = await createFixture(t, { withBeta: false });
  await seed(busy.alpha, [{ id: 'conversation_alpha_space_busy', project: SHARED_PROJECT }]);
  await seedUnfinishedWork(busy.alpha, [{ conversationId: 'conversation_alpha_space_busy', kind: 'bare' }]);
  const busyTarget = await openTarget(t, busy.current);
  const deferred = await merge(busy, busyTarget, { freeSpace: async () => 1024 });
  assert.equal(deferred.deferred[0]?.code, 'runtime-data-set-merge-disk-full');
  assert.match(deferred.deferred[0].message, /备份这份旧聊天记录/);
  const source = readDatabase(busy.alpha);
  try { assert.equal(source.count('turn', "status = 'active'"), 1, '没有收尾'); }
  finally { source.close(); }
  await assert.rejects(fs.stat(path.join(controlRoot(busy.alpha), 'merge-source-backups')), { code: 'ENOENT' });
});

/** Conversations the ledger records as inserted per target: [targetDataSetId, sorted ids][]. */
async function seqFixture(t) {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.current, [{ id: 'conversation_current_seq', project: SHARED_PROJECT }]);
  await seed(fixture.alpha, [{ id: 'conversation_alpha_seq', project: SHARED_PROJECT }]);
  await seedCollaborationMessages(fixture.current, 'conversation_current_seq', ['collaboration_current_1']);
  await seedCollaborationMessages(fixture.alpha, 'conversation_alpha_seq', ['collaboration_alpha_1', 'collaboration_alpha_2']);
  return fixture;
}

/** The same conversation with another title on each side: the merge is blocked by a conflict. */
async function conflictFixture(t) {
  const fixture = await createFixture(t, { withBeta: false });
  await seed(fixture.current, [{ id: 'conversation_both', title: 'current title', project: SHARED_PROJECT }]);
  await seed(fixture.alpha, [
    { id: 'conversation_alpha_only', project: SHARED_PROJECT },
    { id: 'conversation_both', title: 'alpha title', project: SHARED_PROJECT }
  ]);
  return fixture;
}

/** Another window's ordinary collaboration message in the open target (allocated MAX(message_seq) + 1). */
async function postCollaborationMessage(dataSet, runtime, conversationId, id) {
  const store = new kernel.ContentAddressedStore(dataSet.authority, dataSet.binding);
  const payload = await store.ingest(runtime, `hello from ${id}`, 'text/vnd.limcode.collaboration-message');
  const inboxItemId = `${id}_inbox`;
  await runtime.transaction([
    repo('CollaborationMessage').insertWithNextSequence(
      { id, dedupe_key: `dedupe-${id}`, mode: 'message', created_at: NOW },
      { column: 'message_seq', scope: {} }
    ),
    repo('CollaborationMessageSourceLink').insert({
      id: `${id}_source`, message_id: id, conversation_id: conversationId, source_kind: 'tool',
      source_key: `source-${id}`, turn_id: `${conversationId}_turn`, tool_call_id: null, board_post_id: null, created_at: NOW
    }),
    repo('RuntimeInboxItem').insert({
      id: inboxItemId, dedupe_key: `dedupe-${id}`, source_kind: 'collaboration_message', source_id: id,
      state: 'routed', created_at: NOW, updated_at: NOW
    }),
    repo('CollaborationMessageTargetLink').insert({
      id: `${id}_target`, message_id: id, conversation_id: conversationId, inbox_item_id: inboxItemId, anchor_turn_id: null, created_at: NOW
    }),
    repo('CollaborationMessagePayloadLink').insert({ id: `${id}_payload`, message_id: id, content_object_id: payload.id, created_at: NOW }),
    repo('RuntimeInboxPayloadLink').insert({ id: `${id}_inbox_payload`, inbox_item_id: inboxItemId, content_object_id: payload.id, created_at: NOW })
  ]);
}

function assertCollaborationOrder(dataSet, ids) {
  const target = readDatabase(dataSet);
  try {
    target.database.defaultSafeIntegers(true);
    assert.deepEqual(target.database.prepare('SELECT id, message_seq FROM collaboration_message ORDER BY message_seq').raw().all(),
      ids.map((id, index) => [id, BigInt(index + 1)]));
  } finally { target.close(); }
}

async function createFixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-dataset-merge-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const paths = { globalStoragePath: root };
  const current = await initialize(root, 'default');
  const alpha = await initializeScope(paths, 'alpha');
  const beta = options.withBeta === false ? undefined : await initializeScope(paths, 'beta');
  await selectVscodeRuntimeDataSet(paths, options.selected === 'alpha' ? alpha.id : 'default');
  return { root, paths, current, alpha, beta };
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

async function openTarget(t, dataSet) {
  const database = await kernel.RuntimeDatabase.open(dataSet.authority, { hostBootId: `window-${randomUUID()}` });
  t.after(() => database.close());
  return database;
}

function merge(fixture, database, options) {
  return mergeHistoricalDataSetsOnline(fixture.paths, { configurationRootPath: fixture.root, database }, options);
}

function requestMerge(fixture, dataSet) {
  return requestRuntimeDataSetMerge(fixture.paths, {
    candidateId: dataSet.id,
    expectedDataSetId: dataSet.binding.dataSetId,
    expectedRootInstanceId: dataSet.binding.rootInstanceId
  });
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

async function seed(dataSet, conversations) {
  await withRuntime(dataSet, async (runtime, store) => {
    const shared = await store.ingest(runtime, SHARED_TEXT, MESSAGE_TYPE);
    for (const spec of conversations) {
      const own = await store.ingest(runtime, messageText(spec.id, 0), MESSAGE_TYPE);
      const turnId = `${spec.id}_turn`;
      const steps = [
        repo('Conversation').insert({ id: spec.id, title: spec.title ?? spec.id, status: 'active', created_at: NOW, updated_at: NOW }),
        ...projectFolderAssignmentSteps({ conversationId: spec.id, folder: spec.project, now: NOW }),
        repo('Turn').insert({ id: turnId, conversation_id: spec.id, status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
        repo('TurnTermination').insert({ id: `${spec.id}_termination`, turn_id: turnId, terminal_status: 'completed', reason: 'fixture', created_at: NOW })
      ];
      for (const [index, content] of [own, shared].entries()) {
        const messageId = `${spec.id}_message_${index}`;
        steps.push(
          repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
          repo('MessageRevision').insert({
            id: `${messageId}_revision`, message_id: messageId, revision_seq: 1n, role: 'user', content_object_id: content.id, created_at: NOW
          }),
          repo('MessageCurrentRevisionLink').insert({
            id: `${messageId}_current`, message_id: messageId, revision_id: `${messageId}_revision`, updated_at: NOW
          }),
          repo('MessagePartOfConversation').insert({
            id: `${messageId}_member`, conversation_id: spec.id, message_id: messageId, message_seq: BigInt(index + 1), created_at: NOW
          })
        );
      }
      await runtime.transaction(steps);
    }
  });
}

/**
 * Unfinished work an old window left behind, one kind per Conversation:
 * leased-model-request (lease + prepared ModelRequest with pending Operation/Attempt + a pending
 * ToolCall without Operation), bare (active Turn only), interrupt-requested (lease + pending
 * interrupt request), queued-intent (a user message waiting for the next Turn).
 */
/** Writes constructed rows straight into an offline data set (states no public API produces). */
function rawSource(dataSet, write) {
  const source = new Database(dataSet.binding.paths.databasePath);
  try {
    source.pragma('foreign_keys = ON');
    const contentId = source.prepare('SELECT id FROM content_object WHERE sha256 = ?').pluck().get(sha256(SHARED_TEXT));
    source.exec('BEGIN IMMEDIATE');
    write(source, contentId);
    source.exec('COMMIT');
    assert.deepEqual(source.pragma('foreign_key_check'), []);
    source.pragma('wal_checkpoint(TRUNCATE)');
  } finally { source.close(); }
}

/** An exited process linked to the Conversation, without its ProcessReceipt. */
function insertUnreceiptedProcess(source, conversationId) {
  source.prepare(`INSERT INTO process VALUES (?, 'exited', 'nonce', 1, NULL, NULL, 'fp', 'digest', 'spool', 0, 0, 0, 0, ?, ?, ?)`)
    .run(`${conversationId}_process`, NOW, NOW, NOW);
  source.prepare('INSERT INTO process_completion_source_link VALUES (?, ?, ?, ?, ?, ?)')
    .run(`${conversationId}_process_link`, `${conversationId}_process`, conversationId, `${conversationId}_turn`, 'tool_call_x', NOW);
}

/** A child execution of conversation_alpha_parent in conversation_alpha_child, as a crash can leave it. */
function insertChildExecution(source, contentId, spec) {
  const childTurn = 'conversation_alpha_child_task_turn';
  source.prepare('INSERT INTO child_execution VALUES (?, ?, ?, ?, ?)').run('child_exec_1', 'conversation_alpha_child', spec.childStatus, NOW, NOW);
  source.prepare('INSERT INTO child_execution_parent_link VALUES (?, ?, ?, ?, ?, ?)')
    .run('child_parent_link_1', 'child_exec_1', 'tool_call_spawn_1', null, 'conversation_alpha_parent_turn', NOW);
  source.prepare('INSERT INTO turn VALUES (?, ?, ?, ?, ?, ?)').run(childTurn, 'conversation_alpha_child', 'terminated', NOW, NOW, NOW);
  source.prepare('INSERT INTO turn_termination VALUES (?, ?, ?, ?, ?)').run(`${childTurn}_termination`, childTurn, spec.terminal, 'fixture', NOW);
  source.prepare('INSERT INTO child_execution_turn_link VALUES (?, ?, ?, ?, ?)').run('child_turn_link_1', 'child_exec_1', 1, childTurn, NOW);
  if (spec.fence) {
    source.prepare(`INSERT INTO model_request (id, turn_id, request_seq, status, terminal_state, provider_id, model_id,
      context_window_tokens, compression_threshold_tokens, estimated_context_tokens, authority_snapshot_id,
      settings_snapshot_object_id, recipe_object_id, usage_json, stream_stats_json, created_at, updated_at)
      VALUES (?, ?, 1, 'terminal', 'completed', 'p', 'm', 1000, 900, 10, 'authority', NULL, ?, NULL, NULL, ?, ?)`)
      .run(`${childTurn}_request`, childTurn, contentId, NOW, NOW);
    source.prepare('INSERT INTO turn_final_output_fence VALUES (?, ?, ?, ?)').run(`${childTurn}_fence`, childTurn, `${childTurn}_request`, NOW);
  }
  if (spec.terminationRequest) {
    source.prepare('INSERT INTO pending_turn_input VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(`${childTurn}_termination_request`, childTurn, 1, 'termination_request', contentId, 'consumed', NOW, NOW);
  }
  source.prepare('INSERT INTO answer_bridge VALUES (?, ?, ?, ?, ?, ?)').run('bridge_1', 'child_exec_1', null, spec.bridgeStatus, NOW, NOW);
}

/** `count` bare conversation rows written straight into an offline data set (no CAS, one transaction). */
function rawInsertConversations(dataSet, prefix, count) {
  const source = new Database(dataSet.binding.paths.databasePath);
  try {
    const insert = source.prepare("INSERT INTO conversation (id, title, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)");
    source.transaction(() => {
      for (let index = 0; index < count; index += 1) insert.run(`raw_${prefix}_${index}`, `raw ${index}`, NOW, NOW);
    })();
    source.pragma('wal_checkpoint(TRUNCATE)');
  } finally { source.close(); }
}

/** Many small conversations, one project, every message its own body (2 + 5 × messages rows each). */
async function seedBulk(dataSet, prefix, conversations, messages) {
  await withRuntime(dataSet, async (runtime, store) => {
    for (let c = 0; c < conversations; c += 1) {
      const id = `bulk_${prefix}_${c}`;
      const steps = [
        repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
        ...projectFolderAssignmentSteps({ conversationId: id, folder: { uri: `file:///workspace/${prefix}`, name: prefix }, now: NOW })
      ];
      for (let m = 0; m < messages; m += 1) {
        const body = await store.ingest(runtime, JSON.stringify({ role: 'user', parts: [{ text: `${id} ${m} ${'x'.repeat(200)}` }] }), MESSAGE_TYPE);
        const messageId = `${id}_m${m}`;
        steps.push(
          repo('Message').insert({ id: messageId, created_at: NOW, updated_at: NOW, deleted_at: null }),
          repo('MessageRevision').insert({ id: `${messageId}_r`, message_id: messageId, revision_seq: 1n, role: 'user', content_object_id: body.id, created_at: NOW }),
          repo('MessageCurrentRevisionLink').insert({ id: `${messageId}_c`, message_id: messageId, revision_id: `${messageId}_r`, updated_at: NOW }),
          repo('MessagePartOfConversation').insert({ id: `${messageId}_p`, conversation_id: id, message_id: messageId, message_seq: BigInt(m + 1), created_at: NOW })
        );
      }
      await runtime.transaction(steps);
    }
  });
}

async function seedUnfinishedWork(dataSet, specs) {
  await withRuntime(dataSet, async (runtime, store) => {
    for (const { conversationId, kind } of specs) {
      const turnId = `${conversationId}_unfinished_turn`;
      const steps = [];
      if (kind === 'queued-intent') {
        const text = await store.ingest(runtime, JSON.stringify({ role: 'user', parts: [{ text: '排队中的消息' }] }), MESSAGE_TYPE);
        steps.push(
          repo('TurnIntent').insert({ id: `${conversationId}_intent`, conversation_id: conversationId, turn_id: null, state: 'queued', created_at: NOW, updated_at: NOW }),
          repo('TurnIntentRevision').insert({ id: `${conversationId}_intent_revision`, intent_id: `${conversationId}_intent`, revision_seq: 1n, content_object_id: text.id, created_at: NOW })
        );
        await runtime.transaction(steps);
        continue;
      }
      steps.push(repo('Turn').insert({ id: turnId, conversation_id: conversationId, status: 'active', created_at: NOW, updated_at: NOW, terminal_at: null }));
      if (kind !== 'bare') {
        steps.push(repo('ExecutionLease').insert({
          id: `${turnId}_lease`, conversation_id: conversationId, turn_id: turnId, owner_id: 'old-owner',
          host_boot_id: 'old-host', generation: 1n, acquired_at: NOW, expires_at: NOW
        }));
      }
      if (kind === 'leased-model-request') {
        const recipe = await store.ingest(runtime, '{}', 'application/json');
        const argumentsObject = await store.ingest(runtime, '{"path":"README.md"}', 'application/vnd.limcode.tool-arguments+json');
        steps.push(
          repo('ModelRequest').insert({
            id: `${turnId}_request`, turn_id: turnId, request_seq: 1n, status: 'prepared', terminal_state: null,
            provider_id: 'openai-responses', model_id: 'gpt-test', context_window_tokens: 130_000n,
            compression_threshold_tokens: 100_000n, estimated_context_tokens: 1_000n, authority_snapshot_id: 'authority-merge',
            settings_snapshot_object_id: null, recipe_object_id: recipe.id, usage_json: null,
            stream_stats_json: { attemptSeq: '1', socketGeneration: '0', retryReason: null }, created_at: NOW, updated_at: NOW
          }),
          repo('Operation').insert({
            id: `${turnId}_operation`, owner_kind: 'model_request', owner_id: `${turnId}_request`, operation_seq: 1n,
            tool_call_id: null, status: 'pending', created_at: NOW, updated_at: NOW
          }),
          repo('Attempt').insert({
            id: `${turnId}_attempt`, operation_id: `${turnId}_operation`, attempt_seq: 1n, status: 'pending',
            created_at: NOW, updated_at: NOW, completed_at: null
          }),
          repo('ToolCall').insert({
            id: `${turnId}_tool`, turn_id: turnId, call_seq: 1n, tool_name: 'read_file', status: 'pending',
            arguments_object_id: argumentsObject.id, created_at: NOW, updated_at: NOW
          }),
          repo('ToolExecution').insert({
            id: `${turnId}_tool_execution`, tool_call_id: `${turnId}_tool`, status: 'pending',
            wait_deadline_at: null, started_at: NOW, updated_at: NOW, completed_at: null
          })
        );
      }
      if (kind === 'interrupt-requested') {
        const request = await store.ingest(runtime, JSON.stringify({ kind: 'interrupt-request', reason: 'user' }),
          'application/vnd.limcode.turn-interrupt-request+json');
        steps.push(repo('PendingTurnInput').insert({
          id: `${turnId}_interrupt`, turn_id: turnId, position: 1n, input_kind: 'interrupt_request',
          content_object_id: request.id, state: 'pending', created_at: NOW, updated_at: NOW
        }));
      }
      await runtime.transaction(steps);
    }
  });
}

async function seedInteractionRequest(dataSet) {
  await withRuntime(dataSet, async (runtime, store) => {
    const prompt = await store.ingest(runtime, '{"question":"继续吗？"}', 'application/json');
    await runtime.transaction([repo('InteractionRequest').insert({
      id: `interaction_${randomUUID()}`, request_kind: 'ask_user', status: 'pending', prompt_object_id: prompt.id,
      created_at: NOW, updated_at: NOW
    })]);
  });
}

/** Crash window of an old Host: answer submitted (inbox 'available'), delivery never created. */
async function seedUndeliveredChildAnswer(dataSet, parentConversationId, childConversationId) {
  const source = new Database(dataSet.binding.paths.databasePath);
  try {
    source.pragma('foreign_keys = ON');
    const contentId = source.prepare('SELECT id FROM content_object WHERE sha256 = ?').pluck().get(sha256(SHARED_TEXT));
    source.exec('BEGIN IMMEDIATE');
    source.prepare('INSERT INTO child_execution VALUES (?, ?, ?, ?, ?)').run('child_exec_1', childConversationId, 'idle', NOW, NOW);
    source.prepare('INSERT INTO child_execution_parent_link VALUES (?, ?, ?, ?, ?, ?)')
      .run('child_parent_link_1', 'child_exec_1', 'tool_call_spawn_1', null, `${parentConversationId}_turn`, NOW);
    source.prepare('INSERT INTO answer_bridge VALUES (?, ?, ?, ?, ?, ?)').run('bridge_1', 'child_exec_1', 'submission_1', 'submitted', NOW, NOW);
    source.prepare('INSERT INTO answer_submission VALUES (?, ?, ?, ?, ?, ?)').run('submission_1', 'bridge_1', 1, `${childConversationId}_turn`, 0, NOW);
    source.prepare('INSERT INTO answer_payload VALUES (?, ?, ?, ?, ?, ?)').run('payload_1', 'submission_1', null, contentId,
      Buffer.byteLength(SHARED_TEXT), NOW);
    source.prepare('INSERT INTO runtime_inbox_item VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('inbox_1', 'answer:bridge_1:submission_1', 'answer_submission', 'submission_1', 'available', NOW, NOW);
    source.prepare('INSERT INTO runtime_inbox_payload_link VALUES (?, ?, ?, ?)').run('inbox_payload_1', 'inbox_1', contentId, NOW);
    source.exec('COMMIT');
    assert.deepEqual(source.pragma('foreign_key_check'), []);
    assert.equal(createConversationRuntimeWorkProbe(source)(parentConversationId), true);
    source.pragma('wal_checkpoint(TRUNCATE)');
  } finally { source.close(); }
}

async function seedCollaborationMessages(dataSet, conversationId, ids) {
  await withRuntime(dataSet, async (runtime, store) => {
    for (const id of ids) {
      const payload = await store.ingest(runtime, `hello from ${id}`, 'text/vnd.limcode.collaboration-message');
      const inboxItemId = `${id}_inbox`;
      await runtime.transaction([
        repo('CollaborationMessage').insertWithNextSequence(
          { id, dedupe_key: `dedupe-${id}`, mode: 'message', created_at: NOW },
          { column: 'message_seq', scope: {} }
        ),
        repo('CollaborationMessageSourceLink').insert({
          id: `${id}_source`, message_id: id, conversation_id: conversationId, source_kind: 'tool',
          source_key: `source-${id}`, turn_id: `${conversationId}_turn`, tool_call_id: null, board_post_id: null, created_at: NOW
        }),
        repo('RuntimeInboxItem').insert({
          id: inboxItemId, dedupe_key: `dedupe-${id}`, source_kind: 'collaboration_message', source_id: id,
          state: 'routed', created_at: NOW, updated_at: NOW
        }),
        repo('CollaborationMessageTargetLink').insert({
          id: `${id}_target`, message_id: id, conversation_id: conversationId, inbox_item_id: inboxItemId, anchor_turn_id: null, created_at: NOW
        }),
        repo('CollaborationMessagePayloadLink').insert({ id: `${id}_payload`, message_id: id, content_object_id: payload.id, created_at: NOW }),
        repo('RuntimeInboxPayloadLink').insert({ id: `${id}_inbox_payload`, inbox_item_id: inboxItemId, content_object_id: payload.id, created_at: NOW })
      ]);
    }
  });
}

async function seedAttachmentObservation(dataSet, createdAt, observationText) {
  await withRuntime(dataSet, async (runtime, store) => {
    const imageBytes = Buffer.from('same screenshot bytes in both workspaces');
    const image = await store.ingest(runtime, imageBytes, 'image/png');
    const observation = await store.ingest(runtime, observationText, 'text/plain');
    const imageSha = sha256(imageBytes);
    const attachmentId = stablePhaseDId('attachment', JSON.stringify([imageSha, 'image/png', 'shot.png']));
    const profile = sha256('analysis-profile');
    await runtime.transaction([
      repo('Attachment').insert({
        id: attachmentId, sha256: imageSha, byte_length: String(imageBytes.length), mime_type: 'image/png',
        name: 'shot.png', storage_mode: 'cas', content_object_id: image.id, created_at: createdAt
      }),
      repo('AttachmentObservationLink').insert({
        id: attachmentObservationLinkId(attachmentId, profile), attachment_id: attachmentId,
        analysis_profile_sha256: profile, content_object_id: observation.id, created_at: createdAt
      })
    ]);
  });
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

/** Unknown structural drift: one index of the published epoch-4 schema is missing. */
async function dropOneIndex(binding) {
  const database = new Database(kernel.toSqliteFilePath(binding.paths.databasePath));
  try {
    const name = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name LIMIT 1").pluck().get();
    database.exec(`DROP INDEX "${name}"`);
    database.pragma('wal_checkpoint(TRUNCATE)');
  } finally { database.close(); }
}

async function publishHost(binding, hostBootId) {
  const target = path.join(binding.paths.dataRootPath, `host-liveness/${hostBootId}.json`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({ kind: 'limcode-runtime-host-liveness', dataSetId: binding.dataSetId,
    rootInstanceId: binding.rootInstanceId, rootGeneration: binding.rootGeneration, hostBootId, livenessId: `${hostBootId}-liveness`,
    processId: process.pid, processStartIdentity: ownProcessStartIdentity(), startedAt: NOW, heartbeatAt: NOW }));
  return target;
}

/** Nothing a Host's startup recovery, delivery or reconciliation would pick up. */
function assertNothingResumes(reader) {
  assert.equal(reader.count('turn', "status = 'active'"), 0);
  assert.equal(reader.count('execution_lease'), 0);
  assert.equal(reader.count('turn_intent', "state = 'queued'"), 0);
  assert.equal(reader.count('model_request', "status <> 'terminal'"), 0);
  assert.equal(reader.count('operation', "status IN ('pending', 'executing', 'waiting_answer', 'running')"), 0);
  assert.equal(reader.count('pending_turn_input', "state = 'pending'"), 0);
  const busy = createConversationRuntimeWorkProbe(reader.database);
  const conversations = reader.database.prepare('SELECT id FROM conversation ORDER BY id').pluck().all();
  assert.deepEqual(conversations.filter((id) => busy(id)), []);
}

function readDatabase(dataSet) {
  const database = new Database(dataSet.binding.paths.databasePath, { readonly: true });
  return {
    database,
    count(table, where = '1 = 1', ...params) {
      return Number(database.prepare(`SELECT COUNT(*) FROM ${table} WHERE ${where}`).pluck().get(...params));
    },
    conversationsFor(uri) {
      return database.prepare(`
        SELECT link.conversation_id FROM conversation_project_link AS link
          JOIN project_context AS project ON project.id = link.project_context_id
         WHERE project.uri = ? ORDER BY link.conversation_id`).pluck().all(uri);
    },
    close() { database.close(); }
  };
}

function databaseDigest(dataSet) {
  const database = new Database(dataSet.binding.paths.databasePath, { readonly: true });
  try {
    database.defaultSafeIntegers(true);
    const hash = createHash('sha256');
    for (const schema of kernel.RUNTIME_DOMAIN_SCHEMAS) {
      for (const row of database.prepare(`SELECT * FROM ${schema.table} ORDER BY id`).iterate()) {
        hash.update(schema.table).update(JSON.stringify(row, (_key, value) => typeof value === 'bigint' ? `${value}n` : value));
      }
    }
    return hash.digest('hex');
  } finally { database.close(); }
}

async function readLedgerRecord(fixture, candidateId) {
  const file = path.join(resolveVscodeRuntimeMergeLedgerRoot(fixture.paths), 'records', `${candidateId.replace(/:/g, '-')}.json`);
  return fs.readFile(file, 'utf8').then(JSON.parse, () => undefined);
}

function controlRoot(dataSet) {
  return path.dirname(dataSet.binding.paths.dataRootPath);
}

function runChild(args, nodeOptions = []) {
  const script = path.join(HERE, 'runtime-dataset-merge-child.mjs');
  return new Promise((resolve) => {
    execFile(process.execPath, [...nodeOptions, script, ...args],
      { env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ signal: error?.signal ?? null, code: error ? error.code ?? null : 0, stdout, stderr }));
  });
}

async function waitForFile(file, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fs.stat(file).then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${file}`);
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
        files[path.relative(root, file)] = { size: stat.size, mtime: stat.mtimeMs,
          sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex') };
      }
    }
  }
  await visit(root);
  return files;
}
