import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { compiled, load, repo, relocation, NOW } from './fixtures/ci-storage-relocation.mjs';
import { createWorkFixture, createChildAnswer, createProcessDispatch, createPendingFollowup, openSettlingRelocatedWork, relocatedWorkBeforeOpen } from './fixtures/ci-storage-work.mjs';
import { restoreVscodeLoader } from './fixtures/ci-storage-vscode.mjs';

let f;
before(async () => { f = await createWorkFixture(); });
after(async () => { restoreVscodeLoader(); if (f) await f.close(); });

test('旧根未同意时在Runtime打开前拒绝，同意后先收尾再释放hold', async () => {
  await f.conversation('consent');
  const input = await f.input('consent', 'consent-input');
  await f.release(input.turnId);
  await f.notice('consent-migration', await f.inventory());
  let opened = 0, released = false;
  const open = async hold => {
    opened++;
    assert.equal(hold, true);
    return { application: f.app, async close() { assert.fail('正常收尾不关闭'); }, releaseRelocatedWorkHold() { released = true; } };
  };
  await assert.rejects(openSettlingRelocatedWork(f.placement, 'ci-installation', open), { reason: 'moved-work' });
  assert.equal(opened, 0);
  assert.equal(await relocation.consentToDataRootMovedWork(f.dataSet.root, 'consent-migration', 'ci-installation'), true);
  await openSettlingRelocatedWork(f.placement, 'ci-installation', open);
  assert.equal(opened, 1);
  assert.equal(released, true);
  assert.equal((await f.get('Turn', input.turnId)).status, 'terminated');
  assert.equal((await relocation.readDataRootMovedNotice(f.dataSet.root)).carriedWork.dataSets[0].settlement.state, 'settled');
  assert.deepEqual(f.calls, { models: 0, tools: 0, mcp: 0 });
});

test('产品hold同时阻断恢复和对话接管，显式释放后两条路径继续', async () => {
  const { VscodeReliableKernelProductRuntime: Product } = load('backend/application/reliableKernel/VscodeReliableKernelProductRuntime.js');
  const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const runtime = Object.assign(Object.create(Product.prototype), {
    closing: false, recoveryController: new AbortController(), conversationRecoveryTasks: new Map(),
    relocatedWorkSettled: gate, releaseRelocatedWork: release,
    externalRuntimeWatcher: { async start() { calls.push('watch'); } }, toolHost: { async initialize() {} },
    initializeConfiguration: async () => {}, ensureCapabilitiesReady: async () => {},
    childAgents: { async recoverStartup(_signal, id) { calls.push(id ? 'takeover-child' : 'startup-child'); } },
    conversations: { async recoverStartup(_signal, id) { calls.push(id ? 'takeover-conversation' : 'startup-conversation'); } },
    application: {
      database: { async snapshotAll() { return { snapshot: [] }; }, conversationOwners: { async run(_id, run) { calls.push('claim'); return run(); } } },
      async recoverConversation() { calls.push('takeover'); }, async recover() { calls.push('recover'); return { phaseD: [], phaseF: [] }; },
      async refreshExternalRuntimeWork() { calls.push('refresh'); }, releaseRuntimeConvergence() { calls.push('release'); }
    }
  });
  const recovery = runtime.startRecovery();
  const takeover = runtime.recoverOwnedConversation('held-conversation');
  await Promise.resolve();
  assert.deepEqual(calls, []);
  runtime.releaseRelocatedWorkHold();
  await Promise.all([recovery, takeover]);
  assert.ok(calls.includes('recover') && calls.includes('takeover'));
  assert.equal(calls[0], 'release');
});

test('收尾落盘失败保持consented并关闭未放行产品，重试后才记settled', async () => {
  await f.conversation('durability');
  const input = await f.input('durability', 'durability-input');
  await f.release(input.turnId);
  await f.notice('durability-migration', await f.inventory(), 'consented');
  const barrier = f.app.database.durabilityCheckpoint;
  const lifecycle = [];
  f.app.database.durabilityCheckpoint = async () => {
    assert.equal((await f.get('Turn', input.turnId)).status, 'terminated');
    assert.equal((await relocation.readDataRootMovedNotice(f.dataSet.root)).carriedWork.dataSets[0].settlement.state, 'consented');
    throw new Error('fixture durability checkpoint failure');
  };
  const open = async hold => {
    assert.equal(hold, true);
    return { application: f.app, async close() { lifecycle.push('close'); }, releaseRelocatedWorkHold() { lifecycle.push('release'); } };
  };
  try { await assert.rejects(openSettlingRelocatedWork(f.placement, 'ci-installation', open), { reason: 'moved-work-unsettled' }); }
  finally { f.app.database.durabilityCheckpoint = barrier; }
  assert.deepEqual(lifecycle, ['close']);
  assert.equal((await relocation.readDataRootMovedNotice(f.dataSet.root)).carriedWork.dataSets[0].settlement.state, 'consented');
  await openSettlingRelocatedWork(f.placement, 'ci-installation', open);
  assert.deepEqual(lifecycle, ['close', 'release']);
  assert.equal((await relocation.readDataRootMovedNotice(f.dataSet.root)).carriedWork.dataSets[0].settlement.state, 'settled');
});

test('损坏的moved notice拒绝打开并保留原文件', async () => {
  const original = await fs.readFile(f.noticeFile, 'utf8');
  await fs.writeFile(f.noticeFile, '{"kind":');
  try {
    await assert.rejects(relocatedWorkBeforeOpen(f.placement), { reason: 'moved-notice-invalid' });
    assert.equal(await fs.readFile(f.noticeFile, 'utf8'), '{"kind":');
  } finally { await fs.writeFile(f.noticeFile, original); }
});

test('收尾先取消排队输入再终止活动Turn，用户消息保留且不准入新Turn', async () => {
  await f.conversation('queued');
  const first = await f.input('queued', 'queued-first', '第一条原始用户输入');
  const second = await f.input('queued', 'queued-second', '等待执行的第二条用户输入');
  assert.equal(first.admitted, true);
  assert.notEqual(second.admitted, true);
  const messages = await f.rows('MessagePartOfConversation', { conversation_id: 'queued' });
  const cancel = f.app.turns.cancelGuidance.bind(f.app.turns);
  const terminate = f.app.agentLoop.terminateRequested.bind(f.app.agentLoop);
  const order = [];
  f.app.turns.cancelGuidance = async input => { order.push('cancel'); return cancel(input); };
  f.app.agentLoop.terminateRequested = async (...args) => {
    assert.equal((await f.get('TurnIntent', second.intentId)).state, 'cancelled');
    order.push('terminate');
    return terminate(...args);
  };
  await f.release(first.turnId);
  let result;
  try { result = await f.settle(); }
  finally { f.app.turns.cancelGuidance = cancel; f.app.agentLoop.terminateRequested = terminate; }
  assert.deepEqual([result.unsettled, result.live], [[], []]);
  assert.deepEqual(order, ['cancel', 'terminate']);
  assert.equal(result.counts.queuedMessagesCancelled, 1);
  assert.equal((await f.get('Turn', first.turnId)).status, 'terminated');
  assert.deepEqual(await f.rows('MessagePartOfConversation', { conversation_id: 'queued' }), messages);
  assert.equal((await f.rows('Turn', { conversation_id: 'queued' })).length, 1);
  const [revision] = await f.rows('TurnIntentRevision', { intent_id: second.intentId });
  const content = await f.get('ContentObject', revision.content_object_id);
  const intent = JSON.parse((await f.app.contentStore.read(content)).toString());
  const messageContent = await f.get('ContentObject', intent.messageContentObjectId);
  assert.equal((await f.app.contentStore.read(messageContent)).toString(), '等待执行的第二条用户输入');
});

test('完成父Turn的后台子任务先停活动Turn，再取消谱系续跑，不发布答复', async () => {
  await f.conversation('background-parent');
  await f.completed('background-parent', 'background-parent-turn');
  await f.conversation('background-child');
  const childTurn = await f.input('background-child', 'background-first');
  const queued = await f.input('background-child', 'background-send');
  await f.release(childTurn.turnId);
  await f.app.database.transaction([
    repo('ChildExecution').insert({ id: 'background-execution', child_conversation_id: 'background-child', status: 'active', created_at: NOW, updated_at: NOW }),
    repo('ChildExecutionParentLink').insert({ id: 'background-parent-link', child_execution_id: 'background-execution', source_tool_call_id: 'background-spawn', parent_child_execution_id: null, parent_turn_id: 'background-parent-turn', created_at: NOW }),
    repo('ChildExecutionTurnLink').insert({ id: 'background-turn-link', child_execution_id: 'background-execution', turn_seq: 1n, turn_id: childTurn.turnId, created_at: NOW }),
    repo('ChildExecutionActiveTurnLink').insert({ id: 'background-active', child_execution_id: 'background-execution', turn_id: childTurn.turnId, updated_at: NOW }),
    repo('ChildExecutionIntentLink').insert({ id: 'background-intent-link', child_execution_id: 'background-execution', intent_seq: 1n, turn_intent_id: queued.intentId, state: 'pending', created_at: NOW, updated_at: NOW }),
    repo('AnswerBridge').insert({ id: 'background-bridge', child_execution_id: 'background-execution', current_submission_id: null, status: 'open', created_at: NOW, updated_at: NOW })
  ]);
  const result = await f.settle();
  assert.deepEqual([result.live, result.unsettled], [[], []]);
  assert.equal(result.counts.childTurnsStopped, 1);
  assert.equal(result.counts.childContinuationsCancelled, 1);
  assert.equal((await f.get('Turn', childTurn.turnId)).status, 'terminated');
  assert.equal((await f.get('TurnIntent', queued.intentId)).state, 'cancelled');
  assert.deepEqual(await f.rows('PendingTurnInput', { turn_id: childTurn.turnId, input_kind: 'termination_request' }), []);
  assert.deepEqual(await f.rows('AnswerSubmission', { answer_bridge_id: 'background-bridge' }), []);
  assert.equal((await f.rows('Turn', { conversation_id: 'background-parent' })).length, 1);
});

test('已完成父Turn的迟到答复被放弃，唤醒死信且不续跑', async () => {
  await f.conversation('late-parent');
  await f.completed('late-parent', 'late-parent-turn');
  const delivery = await createChildAnswer(f, 'late-answer', 'late-parent', 'late-parent-turn');
  const result = await f.settle();
  assert.deepEqual([result.live, result.unsettled], [[], []]);
  assert.equal(result.counts.deliveriesAbandoned, 1);
  assert.deepEqual([(await f.get('RuntimeDelivery', delivery.deliveryId)).state, (await f.get('RuntimeDelivery', delivery.deliveryId)).failure_reason], ['failed', 'data-root-relocated']);
  const wakes = await f.rows('RuntimeDeliveryWake', { delivery_id: delivery.deliveryId });
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].state, 'dead_letter');
  assert.equal((await f.rows('Turn', { conversation_id: 'late-parent' })).length, 1);
});

test('未派发的已结束进程通知进入死信，不再生成投递', async () => {
  await f.conversation('process-parent');
  await f.completed('process-parent', 'process-parent-turn');
  const id = await createProcessDispatch(f, 'completed-process', 'process-parent', 'process-parent-turn');
  const result = await f.settle();
  assert.deepEqual([result.live, result.unsettled], [[], []]);
  assert.equal(result.counts.processCompletionsAbandoned, 1);
  const row = await f.get('ProcessCompletionDispatch', id);
  assert.deepEqual([row.state, row.last_error, row.claim_owner_host_boot_id], ['dead_letter', 'data-root-relocated', null]);
  assert.deepEqual(await f.rows('RuntimeDelivery', { target_conversation_id: 'process-parent' }), []);
  assert.equal((await f.get('ProcessReceipt', 'completed-process-receipt')).exit_code, 0n);
});

test('存活宿主的claim保留投递，宿主被证明结束后原子放弃并取消排队续跑', async t => {
  await f.conversation('claim-parent');
  const completed = await f.input('claim-parent', 'claim-first');
  await f.finish(completed.turnId);
  await f.conversation('claim-requester');
  const requester = await f.input('claim-requester', 'claim-requester-input');
  await f.finish(requester.turnId);
  const running = await f.input('claim-parent', 'claim-active');
  const delivery = await createPendingFollowup(f, 'claimed-followup', 'claim-requester', 'claim-parent', requester.turnId);
  const queued = await f.app.database.conversationOwners.run('claim-parent', () => f.app.turns.runtimeContinuation({
    source: { kind: 'internal', key: `runtime-delivery:${delivery.deliveryId}` }, conversationId: 'claim-parent',
    leaseOwnerId: `ci:${f.app.database.hostBootId}`, hostBootId: f.app.database.hostBootId,
    leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), sourceTurnId: null, deliveryId: delivery.deliveryId
  }));
  const [wake] = await f.rows('RuntimeDeliveryWake', { delivery_id: delivery.deliveryId });
  const expiry = new Date(Date.now() + 600000).toISOString();
  const deadHost = 'finished-fixture-host';
  const live = JSON.parse(await fs.readFile(f.app.database.hostLivenessPath(f.app.database.hostBootId), 'utf8'));
  const child = spawn(process.execPath, ['-e', `const {ownProcessStartIdentity}=require(process.argv[1]);
    process.send({processId:process.pid,processStartIdentity:ownProcessStartIdentity()});
    process.on('message',()=>process.exit(0));`, path.join(compiled, 'backend/reliableKernel/runtimeClaimPrimitives.js')],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const identity = await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`宿主fixture未报告身份便退出：${code}`)));
  });
  live.hostBootId = deadHost;
  live.livenessId = `${deadHost}-liveness`;
  Object.assign(live, identity);
  await fs.writeFile(f.app.database.hostLivenessPath(deadHost), JSON.stringify(live));
  await f.app.database.transaction([repo('RuntimeDeliveryWake').update(wake.id, { state: 'claimed', claim_owner_host_boot_id: deadHost,
    claim_generation: 1n, claim_expires_at: expiry, attempt_count: 1n, next_attempt_at: null, updated_at: NOW })]);
  assert.deepEqual(await f.app.runtime.deliveries.abandonPending({ deliveryId: delivery.deliveryId, reason: 'data-root-relocated' }), { outcome: 'live' });
  assert.equal((await f.get('RuntimeDelivery', delivery.deliveryId)).state, 'pending');
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.send('finish');
  await exited;
  assert.deepEqual(await f.app.runtime.deliveries.abandonPending({ deliveryId: delivery.deliveryId, reason: 'data-root-relocated' }), { outcome: 'abandoned', intentsCancelled: 1 });
  assert.equal((await f.get('TurnIntent', queued.intentId)).state, 'cancelled');
  assert.equal((await f.get('RuntimeDeliveryWake', wake.id)).state, 'dead_letter');
  await f.release(running.turnId);
  const result = await f.settle();
  assert.deepEqual([result.live, result.unsettled], [[], []]);
  const turns = (await f.rows('Turn')).map(row => row.id);
  await f.app.recover();
  const { ReliableConversationRunner } = load('backend/application/reliableKernel/ReliableConversationRunner.js');
  const errors = [];
  const runner = new ReliableConversationRunner(f.app, 'ci-recovered', error => errors.push(error));
  try { await runner.recoverStartup(); await runner.waitForIdle(); }
  finally { runner.dispose(); }
  assert.deepEqual((await f.rows('Turn')).map(row => row.id), turns);
  assert.deepEqual(f.calls, { models: 0, tools: 0, mcp: 0 });
  assert.deepEqual(errors, []);
});
