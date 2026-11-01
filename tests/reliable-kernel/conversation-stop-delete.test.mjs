import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { openStopFixture, load } from './stop-control-fixture.mjs';
import { queueCancellationBeforeStop, pendingAnswerDeletionNotice, consumedAnswerDeletionNotice, backgroundChildDeletion, stopWholeTree,
  timeoutPreservesThenRetry, writerDeletionAtomicRefusal, durableStopRecovery, stopClosesOutputCrashWindow } from './stop-delete-cases.mjs';
import { stopForeignProcess, liveOwnerStops, unknownDispatchIdentity, stopAllWaits, userStopsDeadHost, liveDispatchKeepsReceipt,
  recoverDispatchedSpawn, rejectCancelRace } from './stop-control-cases.mjs';
let f;
before(async () => { f = await openStopFixture(); });
after(async () => { await f?.close(); });
test('queued intent cancellation commits before stop and blocks any admission during deletion', () => queueCancellationBeforeStop(f));
test('deleting a pending child answer substitutes a notification and lets the parent continue', () => pendingAnswerDeletionNotice(f));
test('deleting an accepted but unabsorbed child answer substitutes a notification', () => consumedAnswerDeletionNotice(f));
test('deleting a background child starts no parent continuation and publishes no interrupted answer', () => backgroundChildDeletion(f));
test('another live host stops a background process by durable nonce and identity without owning the conversation', { timeout: 10000 }, () => stopForeignProcess(f));
test('deleting a parent tree cancels all queues before stopping and atomically removes the tree', () => stopWholeTree(f));
test('a live executing host receives a persistent stop and finishes using its actual receipt', { timeout: 10000 }, () => liveOwnerStops(f));
test('a delete deadline preserves unfinished work and succeeds after that work releases', () => timeoutPreservesThenRetry(f));
test('an active child appearing before writer commit rejects the complete deletion atomically', () => writerDeletionAtomicRefusal(f));
test('missing dispatch identity keeps the effect live rather than proving a dead host', () => unknownDispatchIdentity(f));
test('a durable stop recovers after one terminal write failure without another user action', () => durableStopRecovery(f));
test('one global stop closes questions, approval and an in-flight MCP observation', { timeout: 10000 }, () => stopAllWaits(f));
test('only an explicit user stop closes a proven dead host effect as outcome_unknown', { timeout: 10000 }, () => userStopsDeadHost(f));
test('a live dispatch remains active until the actual receipt arrives and is never abandoned', () => liveDispatchKeepsReceipt(f));
test('a dead dispatched spawn recovers its existing child and stops without dispatching twice', { timeout: 10000 }, () => recoverDispatchedSpawn(f));
test('explicit rejection survives a stop and competing responses commit only one approval outcome', () => rejectCancelRace(f));
test('停止补建已经提交输出但尚未建成的调用，并把取消结果进入 Context', () => stopClosesOutputCrashWindow(f, 'output-before-calls'));
test('停止补齐已有终态工具结果的 Context，不再次派发工具', () => stopClosesOutputCrashWindow(f, 'result-before-context'));

async function deleteChild(turnId, answerBridgeId) {
  const args = { operation: 'delete_subtree', answerBridgeId };
  const source = await f.source(turnId, 'run_agent', args);
  const lease = (await f.rows('ExecutionLease', { turn_id: turnId }))[0];
  const { runWithExecutionLeaseFence } = load('backend/reliableKernel/executionLeaseFence.js');
  await runWithExecutionLeaseFence({ id: lease.id, conversationId: lease.conversation_id, turnId,
    ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation) }, async () => {
    try { await f.app.toolDispatcher.dispatch({ ...source, toolName: 'run_agent', arguments: args }); }
    catch (error) {
      await f.app.runtime.effects.settleWithoutEffect({ source: { kind: 'internal', key: `delete-fixture:${source.toolCallId}` },
        toolCallId: source.toolCallId, status: 'failed', detail: { message: error.message } });
      throw error;
    }
  });
  return f.app.runtime.effects.readTerminalResult(source.toolCallId, false);
}

test('Agent 删除开关关闭时不提供删除操作，后续设置不改变已经冻结的授权', async () => {
  f.allowDeleteSubagents = false;
  const parent = await f.conversation('delete-switch-off');
  const turn = await f.input(parent);
  const child = await f.spawn(turn.turnId);
  const definitions = await f.app.toolDispatcher.definitions(turn.turnId);
  assert.ok(!definitions.find(tool => tool.name === 'run_agent').parameters.properties.operation.enum.includes('delete_subtree'));
  f.allowDeleteSubagents = true;
  try {
    await assert.rejects(deleteChild(turn.turnId, child.answerBridgeId), /未开启/);
    assert.ok(await f.get('Conversation', child.childConversationId));
  } finally { f.allowDeleteSubagents = false; }
});

test('Agent 只能删除自己的直属子 Agent，删除先停止整棵子树并保留父任务', async () => {
  f.allowDeleteSubagents = true;
  const model = f.model;
  // 子 Agent 的模型调用一直挂着直到被停止，保证删除时它确实还没交答复。
  f.model = (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  try {
    const parent = await f.conversation('delete-own-child');
    const turn = await f.input(parent);
    const child = await f.spawn(turn.turnId);
    const grandchild = await f.spawn(child.childTurnId);
    const definitions = await f.app.toolDispatcher.definitions(turn.turnId);
    assert.ok(definitions.find(tool => tool.name === 'run_agent').parameters.properties.operation.enum.includes('delete_subtree'));
    const foreignParent = await f.conversation('delete-foreign-child');
    const foreignTurn = await f.input(foreignParent);
    await assert.rejects(deleteChild(foreignTurn.turnId, child.answerBridgeId), /outside.*direct/);
    assert.ok(await f.get('Conversation', child.childConversationId));
    await assert.rejects(deleteChild(turn.turnId, grandchild.answerBridgeId), /outside.*direct/);
    // 还在运行、没交答复的子 Agent 不能直接删，否则答复会丢；先中断再删。
    await assert.rejects(deleteChild(turn.turnId, child.answerBridgeId), /仍在运行.*interrupt_subtree/);
    assert.ok(await f.get('Conversation', child.childConversationId));
    await f.coordinator.interruptSubtree({ sourceKey: f.id('delete-own-child-stop'), childExecutionId: child.childExecutionId,
      reason: '用户停止' }, { userStop: true });
    assert.equal((await deleteChild(turn.turnId, child.answerBridgeId)).status, 'succeeded');
    assert.equal(await f.get('Conversation', child.childConversationId), null);
    assert.equal(await f.get('Conversation', grandchild.childConversationId), null);
    assert.ok(await f.get('Conversation', parent));
    assert.equal((await f.get('Turn', turn.turnId)).status, 'active');
    assert.equal((await deleteChild(turn.turnId, child.answerBridgeId)).status, 'succeeded');
  } finally { f.allowDeleteSubagents = false; f.model = model; }
});

test('Agent 可以删除已经交了答复的子 Agent', async () => {
  f.allowDeleteSubagents = true;
  try {
    const parent = await f.conversation('delete-answered-child');
    const turn = await f.input(parent);
    const child = await f.spawn(turn.turnId);
    assert.equal(f.coordinator.launch(child.childExecutionId, child.childTurnId), true);
    await f.until(async () => (await f.coordinator.dependencies.answers.readCurrent(child.answerBridgeId)).status === 'submitted',
      'child answer submitted');
    assert.equal((await deleteChild(turn.turnId, child.answerBridgeId)).status, 'succeeded');
    assert.equal(await f.get('Conversation', child.childConversationId), null);
  } finally { f.allowDeleteSubagents = false; }
});
