import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createRequire } from 'node:module';
import { load, kernel, repo, gate, policy, openChildFixture, taskToolsFixture } from './child-execution-fixture.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { boundChildToolPolicy, boundChildSkillPolicy, frozenToolPolicyDocument, inheritedToolPolicyChain } = load('backend/reliableKernel/childExecutionBoundary.js');
const { toolAllowedByPolicy } = load('shared/toolPolicyResolution.js');
const { isSkillEnabledByPolicy } = load('backend/world/modules/skill/policy.js');
const { ReliableToolDispatcher } = load('backend/reliableKernel/toolDispatcher.js');
const { splitPreloadedSkills } = load('backend/reliableKernel/childSkillPreload.js');
const { prepareCollaborationCapacity } = load('backend/reliableKernel/collaborationCapacity.js');
const { executeConversationChildTaskSnapshot } = load('backend/reliableKernel/childTaskFactsSnapshot.js');
const { preparedContentObjectSteps } = load('backend/reliableKernel/contentObjectTransaction.js');
const { readConversationChildTaskRuntimeStatus } = load('backend/reliableKernel/conversationChildTaskProjection.js');
let f;
before(async () => { f = await openChildFixture(); });
after(async () => { await f?.close(); });

test('子 Agent 的删除权限受派出方约束，删除使用单个短引用且强制串行', () => {
  const enabled = policy({ toolConfigs: { run_agent: { config: { allowDeleteSubagents: true } } } });
  const disabled = policy({ toolConfigs: { run_agent: { config: { allowDeleteSubagents: false } } } });
  assert.equal(boundChildToolPolicy(enabled, disabled).toolConfigs.run_agent.config.allowDeleteSubagents, false);
  assert.equal(boundChildToolPolicy(enabled, policy()).toolConfigs.run_agent.config.allowDeleteSubagents, undefined);
  assert.equal(boundChildToolPolicy(enabled, enabled).toolConfigs.run_agent.config.allowDeleteSubagents, true);
  const { resolveModelToolArguments } = load('backend/reliableKernel/modelHandleCatalog.js');
  const args = resolveModelToolArguments('run_agent', { operation: 'delete_subtree', childRef: 'A1', childRefs: ['ignored'] },
    { entries: [{ kind: 'child', ref: 'A1', target: 'child-bridge' }] });
  assert.equal(args.answerBridgeId, 'child-bridge');
  const { runAgentTool } = load('backend/world/modules/tools/definitions/runAgent/index.js');
  assert.equal(runAgentTool.scheduling({ operation: 'delete_subtree', scheduling: 'parallel' }).mode, 'serial');
});

async function startedChildForQueuedWait(parentTurnId, fixture = f) {
  const child = await fixture.app.runtime.children.spawn(fixture.command(await fixture.source(parentTurnId)));
  await fixture.app.runtime.children.claimSpawnDispatch(child.effectIntentId);
  const receipt = await fixture.app.runtime.children.recordSpawnReceipt({ sourceKey: `${child.childExecutionId}-spawned`,
    attemptId: child.attemptId, outcome: 'succeeded', detail: { adapter: 'fixture' } });
  const reconciled = await fixture.app.runtime.children.reconcileSpawnReceipt(receipt.effectReceiptId);
  // The earlier spawn ToolCall must finish before a later send can materialize in call_seq order.
  assert.equal(reconciled.terminalToolResult, true);
  return child;
}

async function withWaitOwner(t, child, ownerKind, action, fixture = f) {
  if (ownerKind === kernel.CHILD_INTENT_ANSWER_WAIT_OWNER_KIND) return action();
  const transaction = fixture.app.database.transaction.bind(fixture.app.database);
  // Reproduce exactly the published writers at insertion; Operation ownership is immutable.
  const writer = t.mock.method(fixture.app.database, 'transaction', (steps, ...args) => transaction(
    steps.map(step => {
      if (step.kind !== 'insert' || step.domain !== 'Operation'
        || step.row.owner_kind !== kernel.CHILD_INTENT_ANSWER_WAIT_OWNER_KIND) return step;
      const ownerId = ownerKind === kernel.CHILD_TURN_ANSWER_WAIT_OWNER_KIND
        ? kernel.childContinuationTurnId(child.childExecutionId, step.row.owner_id) : child.answerBridgeId;
      return repo('Operation').insertWithNextSequence({ ...step.row, owner_kind: ownerKind, owner_id: ownerId },
        { column: 'operation_seq', scope: { owner_kind: ownerKind, owner_id: ownerId } });
    }), ...args));
  try { return await action(); } finally { writer.mock.restore(); }
}

test('未准入前台续聊按确切代际超时，并在子树取消时收尾剩余等待', async (t) => {
  for (const ownerKind of [kernel.CHILD_INTENT_ANSWER_WAIT_OWNER_KIND, kernel.CHILD_TURN_ANSWER_WAIT_OWNER_KIND, 'answer_bridge_wait']) {
    const parent = await f.parent(`unadmitted-wait-${ownerKind}`);
    const turn = await f.app.turns.input(parent.input('delegate'));
    const child = await startedChildForQueuedWait(turn.turnId);
    const deadline = new Date(Date.parse(f.now()) + 60_000).toISOString();
    const sends = [];
    for (let index = 0; index < 2; index++) {
      const toolCallId = await f.source(turn.turnId);
      const sent = await withWaitOwner(t, child, ownerKind, () => f.app.runtime.children.send({ sourceKey: `${parent.id}-send-${index}`,
          sourceToolCallId: toolCallId, childExecutionId: child.childExecutionId, mode: 'queue_next_turn',
          content: `queued ${index}`, completionPolicy: 'wait_for_answer', waitDeadlineAt: deadline }));
      const [operation] = await f.rows('Operation', { tool_call_id: toolCallId });
      sends.push({ ...sent, toolCallId, operationId: operation.id });
    }
    const sourceTurnId = kernel.childContinuationTurnId(child.childExecutionId, sends[0].turnIntentId);
    assert.equal((await f.rows('ChildExecutionTurnLink', { turn_id: sourceTurnId })).length, 0);
    const waitIdentity = ownerKind === kernel.CHILD_INTENT_ANSWER_WAIT_OWNER_KIND
      ? { turnIntentId: sends[0].turnIntentId } : { sourceTurnId };
    const settled = await f.app.runtime.children.settleContinuationWaits({ answerBridgeId: child.answerBridgeId,
      ...waitIdentity, toolCallId: sends[0].toolCallId, detail: { timeout: true },
      sourceIdentity: `${parent.id}-timeout`, observedAt: new Date(Date.parse(deadline) + 1).toISOString() });
    assert.equal(settled.length, 1);
    assert.equal((await f.rows('Operation', { id: sends[0].operationId }))[0].status, 'succeeded');
    assert.equal((await f.rows('ToolCall', { id: sends[0].toolCallId }))[0].status, 'terminal');
    assert.equal((await f.rows('Operation', { id: sends[1].operationId }))[0].status, 'waiting_answer');
    assert.equal((await f.rows('TurnIntent', { id: sends[0].turnIntentId }))[0].state, 'queued');
    const cancelled = await f.app.runtime.children.interruptSubtree({ sourceKey: `${parent.id}-stop`,
      childExecutionId: child.childExecutionId, reason: '用户停止' });
    assert.equal(cancelled.intentsCancelled, 2);
    assert.equal(cancelled.waitsSettled, 1);
    assert.equal((await f.rows('Operation', { id: sends[1].operationId }))[0].status, 'cancelled');
    assert.equal((await f.rows('ToolCall', { id: sends[1].toolCallId }))[0].status, 'terminal');
    assert.equal((await f.rows('ToolExecution', { tool_call_id: sends[1].toolCallId }))[0].status, 'completed');
    assert.equal((await f.rows('ToolOutcome', { tool_call_id: sends[1].toolCallId }))[0].status, 'cancelled');
    assert.equal((await f.rows('TurnIntent', { id: sends[1].turnIntentId }))[0].state, 'cancelled');
    assert.deepEqual(await f.app.runtime.children.settleContinuationWaits({ answerBridgeId: child.answerBridgeId,
      turnIntentId: sends[1].turnIntentId, toolCallId: sends[1].toolCallId, detail: { timeout: true },
      sourceIdentity: `${parent.id}-late-timeout`, observedAt: new Date(Date.parse(deadline) + 2).toISOString() }), []);
    assert.equal((await f.rows('ToolModelResult', { tool_call_id: sends[1].toolCallId })).length, 1);
  }
});

test('取消后的未准入前台续聊等待可恢复收尾，重复恢复不重复提交结果', async (t) => {
  const parent = await f.parent('cancel-unadmitted-wait-recovery');
  const turn = await f.app.turns.input(parent.input('delegate'));
  const child = await startedChildForQueuedWait(turn.turnId);
  const toolCallId = await f.source(turn.turnId);
  const sent = await f.app.runtime.children.send({ sourceKey: `${parent.id}-send`, sourceToolCallId: toolCallId,
    childExecutionId: child.childExecutionId, mode: 'queue_next_turn', content: 'queued followup',
    completionPolicy: 'wait_for_answer', waitDeadlineAt: new Date(Date.parse(f.now()) + 60_000).toISOString() });
  const [operation] = await f.rows('Operation', { tool_call_id: toolCallId });
  const blocked = t.mock.method(f.app.runtime.children, 'settleCancelledExecutionWaits', async () => {
    throw new Error('fixture stopped after cancellation commit');
  });
  try {
    await assert.rejects(f.app.runtime.children.interruptSubtree({ sourceKey: `${parent.id}-stop`,
      childExecutionId: child.childExecutionId, reason: '用户停止' }), /fixture stopped after cancellation commit/);
  } finally { blocked.mock.restore(); }
  assert.equal((await f.rows('TurnIntent', { id: sent.turnIntentId }))[0].state, 'cancelled');
  assert.equal((await f.rows('Operation', { id: operation.id }))[0].status, 'waiting_answer');
  const recovery = { childExecutionId: child.childExecutionId, reason: '用户停止', sourceIdentity: `${parent.id}-recover` };
  assert.equal((await f.app.runtime.children.settleCancelledExecutionWaits(recovery)).continuationSettlements, 1);
  assert.equal((await f.rows('Operation', { id: operation.id }))[0].status, 'cancelled');
  assert.equal((await f.rows('ToolCall', { id: toolCallId }))[0].status, 'terminal');
  assert.equal((await f.rows('ToolExecution', { tool_call_id: toolCallId }))[0].status, 'completed');
  assert.equal((await f.rows('ToolOutcome', { tool_call_id: toolCallId }))[0].status, 'cancelled');
  assert.equal((await f.app.runtime.children.settleCancelledExecutionWaits(recovery)).continuationSettlements, 0);
  assert.equal((await f.rows('OperationResolution', { pause_id: (await f.rows('OutcomePause', { operation_id: operation.id }))[0].id })).length, 1);
});

test('已物化的未准入取消历史不增加等待选择的逐条SQL', async (t) => {
  const fixture = await openChildFixture({ holdRuntimeConvergence: true });
  try {
    const parent = await fixture.parent('cancelled-wait-query-scope');
    const turn = await fixture.app.turns.input(parent.input('delegate'));
    const child = await startedChildForQueuedWait(turn.turnId, fixture);
    // Pin this fixture's sole owner so its 50ms idle sweep cannot add unrelated reader queries.
    const select = () => fixture.app.database.conversationOwners.run(parent.id, async () => {
      const before = (await fixture.app.database.inspect()).statementCache.reader;
      const result = await fixture.app.database.childContinuationWaitFacts({
        childExecutionId: child.childExecutionId, status: 'waiting_answer'
      });
      const after = (await fixture.app.database.inspect()).statementCache.reader;
      assert.equal(result.snapshot.operations.length, 0);
      return after.hits + after.misses + after.busyBypasses - before.hits - before.misses - before.busyBypasses;
    });
    await select();
    const withoutHistory = await select();
    const sends = [];
    const owners = [kernel.CHILD_INTENT_ANSWER_WAIT_OWNER_KIND, kernel.CHILD_INTENT_ANSWER_WAIT_OWNER_KIND,
      kernel.CHILD_TURN_ANSWER_WAIT_OWNER_KIND, 'answer_bridge_wait'];
    for (let index = 0; index < 4; index++) {
      const toolCallId = await fixture.source(turn.turnId);
      const sent = await withWaitOwner(t, child, owners[index], () => fixture.app.runtime.children.send({ sourceKey: `${parent.id}-send-${index}`,
        sourceToolCallId: toolCallId, childExecutionId: child.childExecutionId, mode: 'queue_next_turn',
        content: `queued ${index}`, completionPolicy: 'wait_for_answer',
        waitDeadlineAt: new Date(Date.parse(fixture.now()) + 60_000).toISOString() }), fixture);
      sends.push({ ...sent, toolCallId });
    }
    const cancelled = await fixture.app.runtime.children.interruptSubtree({ sourceKey: `${parent.id}-stop`,
      childExecutionId: child.childExecutionId, reason: '用户停止' });
    assert.equal(cancelled.waitsSettled, 4);
    for (const sent of sends) {
      assert.equal((await fixture.rows('TurnIntent', { id: sent.turnIntentId }))[0].state, 'cancelled');
      assert.equal((await fixture.rows('ToolModelResult', { tool_call_id: sent.toolCallId })).length, 1);
    }
    await select();
    assert.equal(await select(), withoutHistory, 'settled cancellation history must not drive per-Intent queries');
  } finally { await fixture.close(); }
});

test('新旧等待在取消结算已提交而结果未物化时均可恢复', async (t) => {
  for (const ownerKind of [kernel.CHILD_INTENT_ANSWER_WAIT_OWNER_KIND, kernel.CHILD_TURN_ANSWER_WAIT_OWNER_KIND, 'answer_bridge_wait']) {
    const parent = await f.parent(`unmaterialized-cancel-${ownerKind}`);
    const turn = await f.app.turns.input(parent.input('delegate'));
    const child = await startedChildForQueuedWait(turn.turnId);
    const toolCallId = await f.source(turn.turnId);
    await withWaitOwner(t, child, ownerKind, () => f.app.runtime.children.send({ sourceKey: `${parent.id}-send`,
      sourceToolCallId: toolCallId, childExecutionId: child.childExecutionId, mode: 'queue_next_turn',
      content: 'queued followup', completionPolicy: 'wait_for_answer',
      waitDeadlineAt: new Date(Date.parse(f.now()) + 60_000).toISOString() }));
    const finalize = f.app.runtime.children.finalizeWaitSettlement.bind(f.app.runtime.children);
    const crashed = t.mock.method(f.app.runtime.children, 'finalizeWaitSettlement', id => {
      if (id === toolCallId) throw new Error('fixture stopped after settlement commit');
      return finalize(id);
    });
    try {
      await assert.rejects(f.app.runtime.children.interruptSubtree({ sourceKey: `${parent.id}-stop`,
        childExecutionId: child.childExecutionId, reason: '用户停止' }), /fixture stopped after settlement commit/);
    } finally { crashed.mock.restore(); }
    const [operation] = await f.rows('Operation', { tool_call_id: toolCallId });
    assert.equal(operation.status, 'cancelled');
    assert.equal((await f.rows('ToolResultArtifact', { tool_call_id: toolCallId, role: 'no_effect_result' })).length, 1);
    assert.equal((await f.rows('ToolModelResult', { tool_call_id: toolCallId })).length, 0);
    const recovery = { childExecutionId: child.childExecutionId, reason: '用户停止', sourceIdentity: `${parent.id}-recover` };
    assert.equal((await f.app.runtime.children.settleCancelledExecutionWaits(recovery)).continuationSettlements, 1);
    assert.equal((await f.rows('ToolModelResult', { tool_call_id: toolCallId })).length, 1);
    assert.equal((await f.rows('OperationResolution', {
      pause_id: (await f.rows('OutcomePause', { operation_id: operation.id }))[0].id
    })).length, 1);
    assert.equal((await f.app.runtime.children.settleCancelledExecutionWaits(recovery)).continuationSettlements, 0);
  }
});

test('删除提交会拒绝快照后新增且尚未收尾的已取消Intent等待', async (t) => {
  const parent = await f.parent('cancelled-wait-delete-race');
  const turn = await f.app.turns.input(parent.input('delegate'));
  const child = await startedChildForQueuedWait(turn.turnId);
  await f.app.runtime.children.interruptSubtree({ sourceKey: `${parent.id}-initial-stop`,
    childExecutionId: child.childExecutionId, reason: '用户停止' });
  await f.app.turns.terminal({ source: { kind: 'internal', key: `${parent.id}-initial-interrupted` },
    turnId: child.childTurnId, terminalStatus: 'interrupted', reason: '用户停止' });
  await f.app.runtime.children.observeTurnTerminal(child.childExecutionId, child.childTurnId);
  assert.deepEqual((await f.app.conversationDeletion.inspect(child.childConversationId)).work, []);
  const [beforeChild] = await f.rows('ChildExecution', { id: child.childExecutionId });
  const [beforeConversation] = await f.rows('Conversation', { id: child.childConversationId });
  const toolCallId = await f.source(turn.turnId);
  let intentId;
  await assert.rejects(f.app.conversationDeletion.delete(child.childConversationId, { beforeCommit: async () => {
    const sent = await f.app.runtime.children.send({ sourceKey: `${parent.id}-raced-send`, sourceToolCallId: toolCallId,
      childExecutionId: child.childExecutionId, mode: 'queue_next_turn', content: 'queued followup',
      completionPolicy: 'wait_for_answer', waitDeadlineAt: new Date(Date.parse(f.now()) + 60_000).toISOString() });
    intentId = sent.turnIntentId;
    const crashed = t.mock.method(f.app.runtime.children, 'settleCancelledExecutionWaits', async () => {
      throw new Error('fixture stopped after cancellation commit');
    });
    try {
      await assert.rejects(f.app.runtime.children.interruptSubtree({ sourceKey: `${parent.id}-raced-stop`,
        childExecutionId: child.childExecutionId, reason: '用户停止' }), /fixture stopped after cancellation commit/);
    } finally { crashed.mock.restore(); }
    const [currentChild] = await f.rows('ChildExecution', { id: child.childExecutionId });
    const [currentConversation] = await f.rows('Conversation', { id: child.childConversationId });
    assert.equal(currentChild.status, beforeChild.status);
    assert.equal(currentChild.updated_at, beforeChild.updated_at);
    assert.equal(currentConversation.updated_at, beforeConversation.updated_at);
    assert.equal((await f.rows('ChildExecutionActiveTurnLink', { child_execution_id: child.childExecutionId })).length, 0);
    assert.equal((await f.rows('ChildExecutionIntentLink', { child_execution_id: child.childExecutionId, state: 'pending' })).length, 0);
  } }), kernel.isConversationDeletionBlockedError);
  assert.equal((await f.rows('TurnIntent', { id: intentId }))[0].state, 'cancelled');
  assert.equal((await f.rows('Operation', { tool_call_id: toolCallId }))[0].status, 'waiting_answer');
  assert.equal((await f.rows('Conversation', { id: child.childConversationId })).length, 1);
  assert.equal((await f.rows('ToolModelResult', { tool_call_id: toolCallId })).length, 0);
  // The unique-key writer path reaches the same final relationship guard.
  await assert.rejects(f.app.database.transaction([repo('Conversation').deleteByUnique({ id: child.childConversationId })]),
    kernel.isConversationDeletionBlockedError);
  assert.equal((await f.app.runtime.children.settleCancelledExecutionWaits({ childExecutionId: child.childExecutionId,
    reason: '用户停止', sourceIdentity: `${parent.id}-recover` })).continuationSettlements, 1);
  assert.deepEqual((await f.app.conversationDeletion.delete(child.childConversationId)).deletedConversationIds, [child.childConversationId]);
  assert.equal((await f.rows('ToolModelResult', { tool_call_id: toolCallId })).length, 1);
});

test('取消子任务续跑同时收尾投递，旧 cancelled + ACK 残留也能收敛', async () => {
  for (const legacy of [false, true]) {
    const parent = await f.parent(`cancel-delivery-${legacy}`);
    const turn = await f.app.turns.input(parent.input('delegate'));
    const child = await f.app.runtime.children.spawn(f.command(await f.source(turn.turnId)));
    await f.app.turns.terminal({ source: { kind: 'internal', key: `${child.childTurnId}-done` },
      turnId: child.childTurnId, terminalStatus: 'completed', reason: 'fixture' });
    await f.app.runtime.children.observeTurnTerminal(child.childExecutionId, child.childTurnId);
    const id = `${child.childExecutionId}-result`;
    await f.app.database.transaction([
      repo('RuntimeInboxItem').insert({ id, dedupe_key: id, source_kind: 'process_receipt', source_id: `${id}-receipt`,
        state: 'available', created_at: f.now(), updated_at: f.now() }),
      repo('RuntimeDelivery').insert({ id, inbox_item_id: id, target_conversation_id: child.childConversationId,
        target_turn_id: null, phase: 'next_turn', attempt_seq: 1n, retry_of_delivery_id: null, state: 'pending', failure_reason: null,
        created_at: f.now(), updated_at: f.now() }),
      repo('RuntimeDeliveryWake').insert({ id, delivery_id: id, state: 'acknowledged', claim_owner_host_boot_id: null,
        claim_generation: 0n, claim_expires_at: null, attempt_count: 1n, failure_count: 0n, next_attempt_at: null,
        last_error: null, acknowledged_at: f.now(), created_at: f.now(), updated_at: f.now() })
    ]);
    const queued = await f.app.runtime.children.queueRuntimeDeliveryContinuation({ deliveryId: id,
      childExecutionId: child.childExecutionId, sourceTurnId: child.childTurnId });
    assert.ok(queued);
    if (legacy) {
      const [link] = await f.rows('ChildExecutionIntentLink', { turn_intent_id: queued.turnIntentId });
      await f.app.database.transaction([
        repo('TurnIntent').update(queued.turnIntentId, { state: 'cancelled', updated_at: f.now() }),
        repo('ChildExecutionIntentLink').update(link.id, { state: 'cancelled', updated_at: f.now() }),
        repo('ChildExecution').update(child.childExecutionId, { status: 'interrupted', updated_at: f.now() })
      ]);
      const [delivery] = await f.rows('RuntimeDelivery', { id });
      const { ConversationOwnershipGate } = load('backend/reliableKernel/conversationOwnershipGate.js');
      const gate = new ConversationOwnershipGate(f.app.database, 'claim');
      try { assert.equal(await f.app.processDeliveries.settleCancelledChildDelivery(delivery, gate), true); }
      finally { await gate.releaseClaimed(); }
    } else {
      await f.app.runtime.children.interruptSubtree({ sourceKey: `${id}-stop`, childExecutionId: child.childExecutionId, reason: '用户停止' });
    }
    assert.equal((await f.rows('RuntimeDelivery', { id }))[0].state, 'failed');
    assert.equal((await f.rows('TurnIntent', { id: queued.turnIntentId }))[0].state, 'cancelled');
    assert.equal((await f.rows('RuntimeDeliveryWake', { id }))[0].state, 'acknowledged');
  }
});

test('无正文的子任务最终结果提交一次可读答案', async () => {
  const parent = await f.parent('empty-final');
  const turn = await f.app.turns.input(parent.input('delegate'));
  const child = await f.app.runtime.children.spawn(f.command(await f.source(turn.turnId)));
  const coordinator = f.coordinator();
  await f.app.runtime.children.claimSpawnDispatch(child.effectIntentId);
  const receipt = await f.app.runtime.children.recordSpawnReceipt({ sourceKey: `${child.childExecutionId}-spawned`,
    attemptId: child.attemptId, outcome: 'succeeded', detail: { adapter: 'fixture' } });
  await f.app.runtime.children.reconcileSpawnReceipt(receipt.effectReceiptId);
  coordinator.triggerRecoveryPass = () => {};
  try {
    const input = { turnId: child.childTurnId, modelRequestId: 'empty-final-model', finalText: '' };
    await coordinator.submitTurnFinalAnswer(input);
    await coordinator.submitTurnFinalAnswer(input);
    const answers = await f.rows('AnswerSubmission', { answer_bridge_id: child.answerBridgeId });
    assert.equal(answers.length, 1);
    const [payload] = await f.rows('AnswerPayload', { submission_id: answers[0].id });
    const [metadata] = await f.rows('ContentObject', { id: payload.content_object_id });
    assert.match((await f.app.contentStore.read(metadata)).toString('utf8'), /没有输出文字/);
  } finally { await coordinator.dispose(); }
});

async function completedThoughtChild(t, label) {
  const parent = await f.parent(label);
  const turn = await f.app.turns.input(parent.input('delegate'));
  const child = await f.app.runtime.children.spawn(f.command(await f.source(turn.turnId)));
  await f.app.runtime.children.claimSpawnDispatch(child.effectIntentId);
  const receipt = await f.app.runtime.children.recordSpawnReceipt({ sourceKey: `${child.childExecutionId}-spawned`,
    attemptId: child.attemptId, outcome: 'succeeded', detail: { adapter: 'fixture' } });
  await f.app.runtime.children.reconcileSpawnReceipt(receipt.effectReceiptId);
  t.mock.method(f.app.providers, 'resolve', providerId => ({ providerId, async sendFullRequest(_request, controls) {
    await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: '只有思考', thought: true }] } });
  } }));
  await f.app.database.conversationOwners.run(child.childConversationId, () => f.app.agentLoop.drive(child.childTurnId));
  await f.app.runtime.children.observeTurnTerminal(child.childExecutionId, child.childTurnId);
  assert.equal((await f.rows('ChildExecution', { id: child.childExecutionId }))[0].status, 'idle');
  assert.equal((await f.rows('AnswerSubmission', { answer_bridge_id: child.answerBridgeId })).length, 0);
  const inventory = await f.app.database.relocatedWorkInventory();
  assert.ok(inventory.conversations.find(row => row.conversationId === parent.id)?.childExecutionIds.includes(child.childExecutionId));
  return { parent, parentTurnId: turn.turnId, child, inventory };
}

test('纯思考已完成但缺答案的任务进入收尾盘点，恢复只补交一次答案', async t => {
  const { child } = await completedThoughtChild(t, 'recover-empty-final');
  const coordinator = f.coordinator();
  coordinator.triggerRecoveryPass = () => {};
  coordinator.dependencies.agentLoop.readFinalOutput = f.app.agentLoop.readFinalOutput.bind(f.app.agentLoop);
  const { ConversationOwnershipGate } = load('backend/reliableKernel/conversationOwnershipGate.js');
  const owner = new ConversationOwnershipGate(f.app.database, 'claim');
  try {
    await coordinator.reconcileCompletedTaskAnswers(id => id === child.childExecutionId, undefined, owner);
    await coordinator.reconcileCompletedTaskAnswers(id => id === child.childExecutionId, undefined, owner);
    const answers = await f.rows('AnswerSubmission', { answer_bridge_id: child.answerBridgeId });
    assert.equal(answers.length, 1);
    const [payload] = await f.rows('AnswerPayload', { submission_id: answers[0].id });
    const [metadata] = await f.rows('ContentObject', { id: payload.content_object_id });
    assert.match((await f.app.contentStore.read(metadata)).toString('utf8'), /没有输出文字/);
  } finally { await owner.releaseClaimed(); await coordinator.dispose(); }
});

test('历史合并收尾包含 idle 缺答案子任务，保留全部消息', async t => {
  const { parent, parentTurnId, child, inventory } = await completedThoughtChild(t, 'settle-empty-final');
  const fence = await f.app.turns.heldExecutionLeaseFence({ turnId: parentTurnId,
    leaseOwnerId: `${parent.id}-owner`, hostBootId: f.app.database.hostBootId });
  assert.ok(fence);
  await f.app.turns.releaseExecutionLease(fence);
  const { settleHistoricalMergeWork } = load('backend/application/reliableKernel/relocatedWorkSettlement.js');
  const messages = await f.rows('MessagePartOfConversation', { conversation_id: child.childConversationId });
  const excludedConversationIds = new Set((await f.rows('Conversation')).map(row => row.id)
    .filter(id => id !== parent.id && id !== child.childConversationId));
  const result = await settleHistoricalMergeWork({ application: f.app, inventory, excludedConversationIds });
  assert.deepEqual(result.unsettled, []);
  assert.deepEqual(result.live, []);
  assert.equal((await f.rows('ChildExecution', { id: child.childExecutionId }))[0].status, 'interrupted');
  assert.equal((await f.rows('AnswerBridge', { id: child.answerBridgeId }))[0].status, 'interrupted');
  assert.deepEqual(await f.rows('MessagePartOfConversation', { conversation_id: child.childConversationId }), messages);
});

// One immutable authority graph, rather than a matrix over spawn/send/edit/provider entry points.
test('child permissions and approval respect the complete frozen ancestor chain', async () => {
  const top = policy({ id: 'top', allowedTools: ['read', 'write'], sourceConfigs: { exa: { enabled: true, enabledTools: ['search'] } },
    toolConfigs: { write: { config: {}, autoApproveExecution: false, autoApplyChange: false } } });
  const middle = boundChildToolPolicy(policy({ id: 'middle', allowedTools: ['read', 'write', 'skills'], sourceConfigs: { exa: { enabled: true } } }), top);
  const leaf = boundChildToolPolicy(policy({ id: 'leaf', preset: 'yolo', sourceConfigs: { exa: { enabled: true }, other: { enabled: true } } }), frozenToolPolicyDocument({ toolPolicy: middle }));
  assert.deepEqual(leaf.allowedTools, ['read', 'write']);
  assert.deepEqual(inheritedToolPolicyChain(leaf).map(layer => layer.preset), ['custom', 'custom']);
  assert.equal(toolAllowedByPolicy(leaf, { name: 'other_search', source: { kind: 'mcp', sourceId: 'other', originalToolName: 'search' } }), false);
  const dispatcher = { authorityCache: new Map([['turn', Promise.resolve({ snapshotId: 'authority', document: { toolPolicy: leaf } })]]) };
  const authority = await ReliableToolDispatcher.prototype.readAuthority.call(dispatcher, 'turn', { name: 'write' });
  const decision = ReliableToolDispatcher.prototype.freezeDecision.call({}, { turnId: 'turn', modelRequestId: 'request', toolCallId: 'call',
    toolName: 'write', arguments: { path: 'a.txt', content: 'x' }, definition: { name: 'write', description: 'write', parameters: {}, metadata: {} } }, undefined, authority);
  assert.equal(decision.executionGate, 'approval_required');
  assert.equal(decision.changeApplyMode, 'manual');
  const skills = boundChildSkillPolicy({ id: 'child', sourceConfigs: { claude: { enabled: false } } }, { id: 'parent', sourceConfigs: { agents: { enabled: true, disabledSkills: ['deploy'] } } });
  assert.equal(isSkillEnabledByPolicy(skills, { id: 'deploy', source: 'agents' }), false);
  assert.equal(isSkillEnabledByPolicy(skills, { id: 'lint', source: 'claude' }), false);
});

test('an externally approved Plan uses executor tools and skills while inheriting the planner environment', async () => {
  const parent = await f.parent('approved-plan', policy({ allowedTools: ['read', 'submit_plan'] }));
  const turn = await f.app.turns.input(parent.input('plan'));
  const source = await f.source(turn.turnId, 'submit_plan');
  const [execution] = await f.rows('ToolExecution', { tool_call_id: source });
  await f.app.database.transaction([
    repo('ToolCall').update(source, { status: 'waiting_answer' }),
    repo('ToolExecution').update(execution.id, { status: 'waiting_answer' })
  ]);
  const child = await f.app.runtime.children.spawn({ ...f.command(source), sourceSettlement: 'external', authorityBound: 'executor_agent' });
  const compiled = f.compileRequests.find(request => request.turnId === child.childTurnId);
  assert.equal(compiled.inheritedToolPolicy, undefined);
  assert.equal(compiled.inheritedSkillPolicy, undefined);
  assert.deepEqual(compiled.inheritedWorkEnvironmentPolicy, {
    enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null
  });
  const [snapshot] = await f.rows('AuthoritySnapshot', { turn_id: child.childTurnId });
  const [metadata] = await f.rows('ContentObject', { id: snapshot.content_object_id });
  const document = JSON.parse((await f.app.contentStore.read(metadata)).toString('utf8'));
  assert.ok(document.toolPolicy.allowedTools.includes('write'));
  assert.equal(document.toolPolicy.inherited, undefined);
  assert.equal(document.skillPolicy.inherited, undefined);
});

test('a child lease begins after preparation and a durable replay does not grant a second generation', async () => {
  const parent = await f.parent('lease', policy({ allowedTools: ['read', 'run_agent'] }));
  const turn = await f.app.turns.input(parent.input('delegate'));
  const command = f.command(await f.source(turn.turnId));
  const before = Date.parse(f.now());
  f.preparation(31000);
  let child;
  try { child = await f.app.runtime.children.spawn(command); } finally { f.preparation(0); }
  const [lease] = await f.rows('ExecutionLease', { turn_id: child.childTurnId });
  assert.ok(Date.parse(lease.acquired_at) >= before + 31000);
  assert.equal(Date.parse(lease.expires_at) - Date.parse(lease.acquired_at), 30000);
  assert.equal(child.initialExecutionFence.id, lease.id);
  assert.equal(child.initialExecutionFence.generation, 1n);
  const [snapshot] = await f.rows('AuthoritySnapshot', { turn_id: child.childTurnId });
  const [metadata] = await f.rows('ContentObject', { id: snapshot.content_object_id });
  const frozen = JSON.parse((await f.app.contentStore.read(metadata)).toString('utf8'));
  assert.deepEqual(frozen.toolPolicy.allowedTools, ['read', 'run_agent']);
  assert.deepEqual(frozen.toolPolicy.inherited.allowedTools, ['read', 'run_agent']);
  const replay = await f.app.runtime.children.spawn(command);
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.initialExecutionFence, undefined);
  assert.deepEqual((await f.rows('ExecutionLease', { id: lease.id }))[0], lease);
});

test('disposal drains an admitted child startup and releases renewal before any child drive', async () => {
  const parent = await f.parent('startup-dispose');
  const turn = await f.app.turns.input(parent.input('delegate'));
  const source = await f.source(turn.turnId);
  const entered = gate(), release = gate();
  const coordinator = f.coordinator({ profile: async () => { entered.resolve(); await release.promise; } });
  const started = coordinator.spawnChild({ toolCallId: source, turnId: turn.turnId, toolName: 'run_agent' },
    { taskName: 'Inspect' }, 'Inspect', 0, { document: f.authority({ turnId: turn.turnId, conversationId: parent.id, executorAgentId: 'parent-agent' }) });
  const settled = started.catch(error => error);
  try {
    await entered.promise;
    assert.equal(coordinator.childLeaseRenewals.size, 1);
    let disposed = false;
    const closing = coordinator.dispose().then(() => { disposed = true; });
    await Promise.resolve();
    assert.equal(disposed, false);
    release.resolve();
    await closing;
    assert.ok((await settled) instanceof Error);
    assert.equal(coordinator.childLeaseRenewals.size, 0);
    assert.equal(coordinator.startupOperations.size, 0);
    assert.equal(coordinator.activeTurns.size, 0);
  } finally { release.resolve(); await settled; await coordinator.dispose(); }
});

test('preloaded skills use the frozen child policy and replay the committed first input without a reload', async () => {
  const parent = await f.parent('skill-preload');
  const turn = await f.app.turns.input(parent.input('delegate'));
  const source = await f.source(turn.turnId);
  let loads = 0, selectedPolicy;
  const skill = '<skill name="review" source=".agents">\nReview code\n</skill>';
  const command = { ...f.command(source), preloadSkills: { names: ['review'], async load(names, authority) {
    loads++; selectedPolicy = authority;
    assert.deepEqual(names, ['review']);
    return [skill];
  } } };
  const child = await f.app.runtime.children.spawn(command);
  assert.equal(isSkillEnabledByPolicy(selectedPolicy, { id: 'deploy', source: 'agents' }), false);
  const [input] = await f.rows('MessageTurnLink', { turn_id: child.childTurnId, role: 'input' });
  const [current] = await f.rows('MessageCurrentRevisionLink', { message_id: input.message_id });
  const [revision] = await f.rows('MessageRevision', { id: current.revision_id });
  const [metadata] = await f.rows('ContentObject', { id: revision.content_object_id });
  const body = (await f.app.contentStore.read(metadata)).toString('utf8');
  assert.deepEqual(splitPreloadedSkills(body), { skills: [{ name: 'review', text: skill }], prompt: command.prompt });
  const replay = await f.app.runtime.children.spawn({ ...command, preloadSkills: { names: ['review'], async load() { assert.fail('replay reloaded skill'); } } });
  assert.equal(replay.childExecutionId, child.childExecutionId);
  assert.equal(loads, 1);
});

function snapshotRead(database, request) {
  const repository = repo(request.domain);
  if (request.kind === 'get') { const row = database.prepare(`SELECT * FROM "${repository.schema.table}" WHERE id=?`).get(request.id); return row ? repository.codec.decode(row) : null; }
  const parameters = repository.codec.encodeWhere(request.where ?? {});
  const predicates = Object.entries(parameters).map(([key, value]) => value === null ? `"${key}" IS NULL` : `"${key}"=@${key}`);
  for (const [key, value] of Object.entries(parameters)) if (value === null) delete parameters[key];
  if (request.afterId) { predicates.push('id>@after'); parameters.after = request.afterId; }
  parameters.limit = BigInt(request.limit);
  return database.prepare(`SELECT * FROM "${repository.schema.table}"${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''} ORDER BY id ASC LIMIT @limit`)
    .all(parameters).map(row => repository.codec.decode(row));
}

test('a concurrent connection commit cannot tear one child task fact snapshot', async () => {
  const parent = await f.parent('snapshot');
  const turn = await f.app.turns.input(parent.input('delegate'));
  const child = await f.app.runtime.children.spawn(f.command(await f.source(turn.turnId)));
  const file = kernel.toSqliteFilePath(f.app.database.binding.paths.databasePath);
  const reader = new Database(file, { readonly: true }), writer = new Database(file);
  reader.defaultSafeIntegers(true); writer.defaultSafeIntegers(true);
  const snapshot = read => executeConversationChildTaskSnapshot(reader, parent.id, 0n, read ?? snapshotRead, () => { assert.fail('no queued envelope in this task'); });
  try {
    const before = snapshot();
    let changed = false;
    const during = snapshot((database, request) => {
      const values = snapshotRead(database, request);
      if (!changed && request.domain === 'Conversation') {
        changed = true;
        writer.transaction(() => {
          writer.prepare('UPDATE child_execution SET status=? WHERE id=?').run('active', child.childExecutionId);
          writer.prepare('UPDATE conversation SET title=? WHERE id=?').run('Changed child', child.childConversationId);
        })();
      }
      return values;
    });
    const after = snapshot();
    assert.equal(changed, true);
    assert.deepEqual(during.snapshot, before.snapshot);
    assert.equal(after.snapshot.childExecutions[0].status, 'active');
    assert.equal(after.snapshot.conversations[0].title, 'Changed child');
    assert.equal(after.snapshotCommitSeq, before.snapshotCommitSeq);
    assert.equal(reader.inTransaction, false);
  } finally { reader.close(); writer.close(); }
});

test('current child work preserves first input, old answer and continuation origin across 42 Turns while history pages every source', async () => {
  const parent = await f.parent('long-child');
  const parentTurn = await f.app.turns.input(parent.input('delegate'));
  const child = await f.app.runtime.children.spawn(f.command(await f.source(parentTurn.turnId)));
  await f.app.turns.terminal({ source: { kind: 'internal', key: `${child.childTurnId}-done` },
    turnId: child.childTurnId, terminalStatus: 'completed', reason: 'fixture' });
  await f.app.runtime.children.observeTurnTerminal(child.childExecutionId, child.childTurnId);
  const at = sequence => new Date(Date.parse(f.now()) + sequence * 1000).toISOString();
  const turnId = sequence => sequence === 1 ? child.childTurnId : `${child.childExecutionId}-turn-${sequence}`;
  const sourceText = '续跑真实来源🙂'.repeat(700);
  const prepared = await Promise.all([
    f.app.contentStore.prepare(f.app.database, 'Historical task', 'text/plain'),
    f.app.contentStore.prepare(f.app.database, sourceText, 'text/plain'),
    f.app.contentStore.prepare(f.app.database, JSON.stringify({ version: 1, kind: 'runtime_continuation', sourceTurnId: turnId(5) }), 'application/vnd.limcode.turn-intent+json'),
    f.app.contentStore.prepare(f.app.database, 'Queued next task', 'text/plain'),
    f.app.contentStore.prepare(f.app.database, 'Older answer still awaiting the parent', 'text/plain'),
    f.app.contentStore.prepare(f.app.database, 'Current answer from Turn 8', 'text/plain')
  ]);
  const steps = preparedContentObjectSteps(prepared, 'long_child');
  for (let sequence = 2; sequence <= 42; sequence++) {
    const id = turnId(sequence), active = sequence === 42, messageId = `${id}-input`;
    steps.push(repo('Turn').insert({ id, conversation_id: child.childConversationId, status: active ? 'active' : 'terminated',
      created_at: at(sequence), updated_at: at(sequence), terminal_at: active ? null : at(sequence) }),
    repo('ChildExecutionTurnLink').insertWithNextSequence({ id: `${id}-member`, child_execution_id: child.childExecutionId,
      turn_id: id, created_at: at(sequence) }, { column: 'turn_seq', scope: { child_execution_id: child.childExecutionId } }));
    if (!active) steps.push(repo('TurnTermination').insert({ id: `${id}-done`, turn_id: id, terminal_status: 'completed', reason: 'fixture', created_at: at(sequence) }),
      repo('Message').insert({ id: messageId, created_at: at(sequence), updated_at: at(sequence), deleted_at: null }),
      repo('MessageRevision').insert({ id: `${messageId}-revision`, message_id: messageId, revision_seq: 1n, role: 'user',
        content_object_id: prepared[sequence === 5 ? 1 : 0].metadata.id, created_at: at(sequence) }),
      repo('MessageCurrentRevisionLink').insert({ id: `${messageId}-current`, message_id: messageId, revision_id: `${messageId}-revision`, updated_at: at(sequence) }),
      repo('MessagePartOfConversation').insertWithNextSequence({ id: `${messageId}-member`, conversation_id: child.childConversationId, message_id: messageId,
        created_at: at(sequence) }, { column: 'message_seq', scope: { conversation_id: child.childConversationId } }),
      repo('MessageTurnLink').insert({ id: `${messageId}-turn`, turn_id: id, message_id: messageId, role: 'input', created_at: at(sequence) }));
  }
  const continuationId = `${child.childExecutionId}-continuation`, queuedId = `${child.childExecutionId}-queued`;
  steps.push(repo('ChildExecution').update(child.childExecutionId, { status: 'active', updated_at: at(42) }),
    repo('ChildExecutionActiveTurnLink').insert({ id: `${child.childExecutionId}-active`, child_execution_id: child.childExecutionId, turn_id: turnId(42), updated_at: at(42) }),
    repo('TurnIntent').insert({ id: continuationId, conversation_id: child.childConversationId, turn_id: turnId(42), state: 'admitted', created_at: at(42), updated_at: at(42) }),
    repo('TurnIntentRevision').insert({ id: `${continuationId}-revision`, intent_id: continuationId, revision_seq: 1n, content_object_id: prepared[2].metadata.id, created_at: at(42) }),
    repo('TurnIntent').insert({ id: queuedId, conversation_id: child.childConversationId, turn_id: null, state: 'queued', created_at: at(43), updated_at: at(43) }),
    repo('TurnIntentRevision').insert({ id: `${queuedId}-revision`, intent_id: queuedId, revision_seq: 1n, content_object_id: prepared[3].metadata.id, created_at: at(43) }));
  for (const [index, sequence] of [3, 8].entries()) {
    const id = `${child.childExecutionId}-answer-${sequence}`, payload = prepared[index + 4];
    steps.push(repo('AnswerSubmission').insert({ id, answer_bridge_id: child.answerBridgeId, submission_seq: BigInt(index + 1), turn_id: turnId(sequence), interrupted: 0n, created_at: at(sequence) }),
      repo('AnswerPayload').insert({ id: `${id}-payload`, submission_id: id, title: null, content_object_id: payload.metadata.id, byte_length: payload.metadata.byte_length, created_at: at(sequence) }),
      repo('RuntimeInboxItem').insert({ id: `${id}-inbox`, dedupe_key: id, source_kind: 'answer_submission', source_id: id, state: 'available', created_at: at(sequence), updated_at: at(sequence) }),
      repo('RuntimeInboxPayloadLink').insert({ id: `${id}-body`, inbox_item_id: `${id}-inbox`, content_object_id: payload.metadata.id, created_at: at(sequence) }));
    if (sequence === 3) steps.push(repo('RuntimeDelivery').insert({ id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: parent.id,
      target_turn_id: parentTurn.turnId, phase: 'current_turn', attempt_seq: 1n, retry_of_delivery_id: null, state: 'pending', failure_reason: null,
      created_at: at(sequence), updated_at: at(sequence) }));
  }
  steps.push(repo('AnswerBridge').update(child.answerBridgeId, { current_submission_id: `${child.childExecutionId}-answer-8`, status: 'submitted', updated_at: at(8) }));
  await f.app.database.transaction(steps);
  const execution = await f.app.runtime.children.readExecutionSnapshot(child.childExecutionId);
  assert.equal(execution.turnCount, 42n);
  assert.deepEqual(execution.turnLinks.map(link => link.turn_seq), [1n, 8n, 42n]);
  const current = await f.app.database.conversationChildTaskSnapshot(parent.id, { kind: 'runtime', limit: 32 });
  assert.deepEqual(new Set(current.snapshot.turns.map(row => row.id)), new Set([1, 3, 5, 8, 42].map(turnId)));
  assert.equal(current.snapshot.taskStates[0].queuedInputCount, 1);
  assert.equal(current.snapshot.taskStates[0].awaitingHandling, true);
  const status = await readConversationChildTaskRuntimeStatus(f.app.database, f.app.contentStore, parent.id, 32);
  assert.equal(status.children[0].initialTask, 'Inspect');
  assert.ok(status.children[0].task.startsWith('续跑真实来源🙂'));
  assert.equal(status.children[0].answerAvailable, true);
  assert.equal(status.queuedInputCount, 1);
  assert.equal(status.awaitingHandlingCount, 1);
  const pageOptions = { childExecutionId: child.childExecutionId, limit: 4 };
  let page = await f.app.runtime.children.readConversationTaskHistory(parent.id, pageOptions);
  const firstPage = page, chunks = [...page.timelineSources], cursors = new Set();
  assert.equal(page.sourceCounts.total, 45);
  while (page.nextCursor) {
    assert.ok(!cursors.has(page.nextCursor), 'history cursor must progress through every source and text chunk');
    cursors.add(page.nextCursor);
    page = await f.app.runtime.children.readConversationTaskHistory(parent.id, { ...pageOptions, cursor: page.nextCursor });
    chunks.push(...page.timelineSources);
  }
  assert.equal(page.sourceCounts.omitted, 0);
  assert.equal(new Set(chunks.map(source => source.id)).size, 45);
  assert.equal(chunks.filter(source => source.turnId === turnId(5) && source.kind === 'message_revision').map(source => source.text).join(''), sourceText);
  const reread = await f.app.runtime.children.readConversationTaskHistory(parent.id, { ...pageOptions, cursor: firstPage.rereadCursor });
  assert.deepEqual(reread.timelineSources, firstPage.timelineSources);
});

test('32 task cards retain every direct task and descendant handle while hydrating only selected children', async () => {
  const parent = await f.parent('many-children');
  const parentTurn = await f.app.turns.input(parent.input('delegate'));
  const steps = [], childIds = [];
  for (let index = 0; index < 36; index++) {
    const id = `${parent.id}-child-${String(index).padStart(2, '0')}`, descendant = index === 35;
    childIds.push(id);
    if (descendant) {
      await f.app.database.transaction(steps.splice(0));
    }
    const source = await f.source(parentTurn.turnId);
    const relationSource = descendant ? `${id}-source` : source;
    if (descendant) {
      const [template] = await f.rows('ToolCall', { id: source });
      steps.push(repo('ToolCall').insert({ ...template, id: relationSource, turn_id: `${childIds[0]}-turn` }));
    }
    steps.push(repo('Conversation').insert({ id, title: id, status: 'active', created_at: f.now(), updated_at: f.now() }),
      repo('ChildExecution').insert({ id, child_conversation_id: id, status: 'closed', created_at: f.now(), updated_at: f.now() }),
      repo('ChildExecutionParentLink').insert({ id: `${id}-parent`, child_execution_id: id, parent_turn_id: descendant ? `${childIds[0]}-turn` : parentTurn.turnId,
        parent_child_execution_id: descendant ? childIds[0] : null, source_tool_call_id: relationSource, created_at: f.now() }),
      repo('Turn').insert({ id: `${id}-turn`, conversation_id: id, status: 'terminated', terminal_at: f.now(), created_at: f.now(), updated_at: f.now() }),
      repo('ChildExecutionTurnLink').insert({ id: `${id}-member`, child_execution_id: id, turn_id: `${id}-turn`, turn_seq: 1n, created_at: f.now() }),
      repo('AnswerBridge').insert({ id: `${id}-bridge`, child_execution_id: id, current_submission_id: null, status: 'closed', created_at: f.now(), updated_at: f.now() }));
  }
  await f.app.database.transaction(steps);
  const facts = await f.app.database.conversationChildTaskSnapshot(parent.id, { kind: 'runtime', limit: 32 });
  assert.equal(facts.snapshot.childExecutions.length, 36);
  assert.equal(facts.snapshot.selectedChildIds.length, 32);
  assert.equal(facts.snapshot.turns.length, 32);
  const status = await readConversationChildTaskRuntimeStatus(f.app.database, f.app.contentStore, parent.id, 32);
  assert.equal(status.totalChildCount, 35);
  assert.equal(status.descendantCount, 1);
  assert.equal(status.children.length, 32);
  assert.equal(status.childHandleTargets.length, 36);
  assert.ok(status.childHandleTargets.some(target => target.answerBridgeId === `${childIds[35]}-bridge`));
  const subtree = await f.app.database.childExecutionSubtreeSnapshot(childIds[0]);
  assert.deepEqual(new Set(subtree.snapshot.lineages.map(child => child.id)), new Set([childIds[0], childIds[35]]));
});

test('forkTurns=1 atomically inherits only the latest completed exchange and replays that exact copy', async () => {
  const parent = await f.parent('fork');
  await f.app.agentLoop.runInput(parent.input('first-completed'));
  await f.app.agentLoop.runInput(parent.input('second-completed'));
  const current = await f.app.turns.input(parent.input('still-incomplete'));
  const command = { ...f.command(await f.source(current.turnId)), forkTurns: '1' };
  const child = await f.app.runtime.children.spawn(command);
  const context = await f.app.context.materialize(await f.app.context.currentHeadRootId(child.childConversationId));
  const text = context.segments.map(segment => segment.content).join('\n');
  assert.ok(text.includes('second-completed'));
  assert.equal(text.includes('first-completed'), false);
  assert.equal(text.includes('still-incomplete'), false);
  const turns = await f.rows('Turn', { conversation_id: child.childConversationId });
  assert.equal(turns.length, 2);
  const copied = turns.find(value => value.id !== child.childTurnId);
  const [authority] = await f.rows('AuthoritySnapshot', { turn_id: copied.id });
  assert.ok(authority);
  assert.equal((await f.rows('ExecutionLease', { turn_id: copied.id })).length, 0);
  const before = await f.rows('MessagePartOfConversation', { conversation_id: child.childConversationId });
  assert.equal((await f.app.runtime.children.spawn(command)).deduplicated, true);
  assert.deepEqual(await f.rows('MessagePartOfConversation', { conversation_id: child.childConversationId }), before);
});

test('readonly child list ignores assignment arguments without spawning or sending work', async () => {
  const value = taskToolsFixture();
  const result = await value.call({ operation: 'list', prompt: 'unused assignment' });
  assert.equal(result.detail.operation, 'list');
  assert.equal(result.detail.tasks[0].answerBridgeId, 'bridge');
  assert.deepEqual(value.events, { spawns: [], sends: [], interrupts: [] });
  assert.equal(value.listeners.size, 0);
});

test('parent abort cleans its child wait subscription while the child remains active', async () => {
  const value = taskToolsFixture(), controller = new AbortController();
  const pending = value.call({ operation: 'wait', answerBridgeId: 'bridge', timeoutMs: 5000 }, controller.signal);
  const rejected = assert.rejects(pending, /parent stopped waiting/);
  await value.observed.promise;
  controller.abort(new Error('parent stopped waiting'));
  await rejected;
  assert.equal(value.task.status, 'active');
  assert.equal(value.listeners.size, 0);
  assert.deepEqual(value.events, { spawns: [], sends: [], interrupts: [] });
});

test('two child reservations compete for one frozen capacity slot and only one transaction commits', async () => {
  const parent = await f.parent('capacity');
  const turn = await f.app.turns.input(parent.input('delegate'));
  const reserve = () => prepareCollaborationCapacity(f.app.database, f.app.contentStore, parent.id, turn.turnId);
  const [left, right] = await Promise.all([reserve(), reserve()]);
  const child = id => [repo('Conversation').insert({ id, title: id, status: 'active', created_at: f.now(), updated_at: f.now() }),
    repo('ChildExecution').insert({ id: `${id}-execution`, child_conversation_id: id, status: 'starting', created_at: f.now(), updated_at: f.now() }),
    repo('ChildExecutionParentLink').insert({ id: `${id}-parent`, child_execution_id: `${id}-execution`, parent_turn_id: turn.turnId,
      parent_child_execution_id: null, source_tool_call_id: `${id}-source`, created_at: f.now() }),
    repo('Turn').insert({ id: `${id}-turn`, conversation_id: id, status: 'active', created_at: f.now(), updated_at: f.now(), terminal_at: null })];
  const results = await Promise.allSettled([
    f.app.database.transaction([...left, ...child(`${parent.id}-left`)]),
    f.app.database.transaction([...right, ...child(`${parent.id}-right`)])
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await f.rows('ChildExecutionParentLink', { parent_turn_id: turn.turnId })).length, 1);
  await assert.rejects(reserve(), /capacity/i);
});
