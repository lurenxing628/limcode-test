import assert from 'node:assert/strict';
import { load, repo, gate } from './stop-control-fixture.mjs';
const { DEAD_HOST_STOP_REASON } = load('backend/reliableKernel/phaseDRecovery.js');
const { runWithExecutionLeaseFence } = load('backend/reliableKernel/executionLeaseFence.js');

async function controlOnly(f, work) {
  const owners = f.app.database.conversationOwners, original = owners.executionEligibility;
  owners.executionEligibility = async () => 'ineligible';
  try { return await work(); } finally { owners.executionEligibility = original; }
}
async function active(f, label) {
  const conversationId = await f.conversation(label);
  const result = await f.input(conversationId, f.id('input'), label);
  return { conversationId, turnId: result.turnId };
}
async function mcp(f, target) {
  const source = await f.source(target.turnId, 'fixture_hang', {});
  const prepared = await f.app.mcp.prepare({ source: { kind: 'internal', key: f.id('mcp') }, toolCallId: source.toolCallId,
    serverId: 'fixture', toolName: 'hang', arguments: {} });
  return { ...target, source, intentId: prepared.effectIntentId, attemptId: prepared.attemptId };
}
async function succeeded(f, prepared) {
  const recorded = await f.app.runtime.effects.recordEffectReceipt({ source: { kind: 'callback', key: f.id('observed-mcp') },
    attemptId: prepared.attemptId, effectKind: 'mcp_tool_call', outcome: 'succeeded',
    detail: { outcome: 'succeeded', result: { content: [{ type: 'text', text: 'observed result' }] } } });
  await f.app.mcp.reconcileEffectReceipt(recorded.effectReceiptId, 'internal');
}
async function body(f, contentId) {
  return JSON.parse((await f.app.contentStore.read(await f.get('ContentObject', contentId))).toString('utf8'));
}

export async function stopForeignProcess(f) {
  const peer = await f.peer('process', 'foreign-process');
  const { conversationId, processId } = peer.ready;
  const release = f.app.conversationDeletion.markStopping([conversationId]);
  const beforeCalls = f.modelCalls.length;
  try {
    assert.equal((await f.get('Turn', peer.ready.turnId)).status, 'terminated');
    assert.equal((await f.rows('TurnTermination', { turn_id: peer.ready.turnId }))[0].terminal_status, 'completed');
    assert.equal(f.app.database.conversationOwners.owns(conversationId), false);
    const stopped = await f.app.processes.stopOwnedProcess(processId);
    assert.equal(stopped.outcome, 'succeeded');
    const process = await f.get('Process', processId);
    assert.equal(process.status, 'cancelled');
    assert.ok(process.wrapper_nonce);
    assert.ok(process.start_fingerprint);
    assert.ok(process.completed_at);
    const receipts = await f.rows('ProcessReceipt', { process_id: processId });
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].outcome, 'cancelled');
    assert.equal(receipts[0].wrapper_nonce, process.wrapper_nonce);
    assert.equal(receipts[0].start_fingerprint, process.start_fingerprint);
    await peer.close();
    await f.app.processDeliveries.scanNow();
    await f.runner.waitForIdle();
    const deliveries = await f.rows('RuntimeDelivery', { target_conversation_id: conversationId });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].state, 'pending');
    const wakes = await f.rows('RuntimeDeliveryWake', { delivery_id: deliveries[0].id });
    assert.equal(wakes.length, 1);
    assert.ok(['pending', 'claimed'].includes(wakes[0].state));
    assert.equal(f.modelCalls.length, beforeCalls, 'deletion suppresses the completion continuation');
  } finally { release(); await peer.close(); }
}

export async function liveOwnerStops(f) {
  const peer = await f.livePeer();
  const ready = peer.ready;
  let passed = false;
  try {
    await controlOnly(f, async () => {
      const result = await f.runner.interrupt({ commandId: f.id('stop-live'), conversationId: ready.conversationId, turnId: ready.turnId, reason: '用户停止' });
      assert.equal(result.executingWindowAlive, true);
      assert.equal((await f.rows('EffectReceipt', { attempt_id: ready.attemptId })).length, 0);
      assert.equal((await f.get('Turn', ready.turnId)).status, 'active');
      await peer.request('finish');
      await f.until(async () => (await f.get('Turn', ready.turnId)).status === 'terminated', 'live owner did not finish its stop');
      assert.equal((await f.rows('TurnTermination', { turn_id: ready.turnId }))[0].terminal_status, 'interrupted');
      const [receipt] = await f.rows('EffectReceipt', { attempt_id: ready.attemptId });
      assert.equal(receipt.outcome, 'succeeded');
      assert.notEqual((await body(f, receipt.response_object_id)).reason, DEAD_HOST_STOP_REASON);
    });
    passed = true;
  } finally { if (!passed) await peer.close(); }
}

export async function unknownDispatchIdentity(f) {
  const prepared = await mcp(f, await active(f, 'unknown-identity'));
  await f.app.runtime.effects.claimEffectDispatch(prepared.intentId);
  const effects = f.app.runtime.effects, original = effects.readEffectDispatchFence;
  effects.readEffectDispatchFence = async () => undefined;
  try {
    assert.deepEqual(await f.app.phaseDRecovery.deadHostEffectsForTurn(prepared.turnId, f.app.database.hostBootId), { state: 'live', hostBootIds: [] });
    assert.equal((await f.rows('EffectReceipt', { attempt_id: prepared.attemptId })).length, 0);
  } finally { effects.readEffectDispatchFence = original; }
  await succeeded(f, prepared);
  await controlOnly(f, () => f.runner.interrupt({ commandId: f.id('finish-identity'), ...prepared, reason: '用户停止' }));
}

export async function stopAllWaits(f) {
  const target = await active(f, 'all-waits');
  const ask = await f.source(target.turnId, 'ask_user', {}), approval = await f.source(target.turnId, 'fixture_guarded', {});
  const askPause = await f.app.interactions.pauseForAskUser({ source: { kind: 'internal', key: f.id('ask') }, toolCallId: ask.toolCallId,
    prompt: { question: '继续？', options: [{ label: '继续' }] } });
  const approvalPause = await f.app.interactions.pauseForExecutionApproval({ source: { kind: 'internal', key: f.id('approval') }, toolCallId: approval.toolCallId,
    prompt: { command: 'fixture command' } });
  const prepared = await mcp(f, target), entered = gate(), release = gate(), controller = new AbortController();
  const original = f.mcpHandler;
  f.mcpHandler = async () => { entered.resolve(); await release.promise; return { content: [{ type: 'text', text: 'finished' }] }; };
  const dispatched = f.app.mcp.dispatch(prepared.intentId, controller.signal);
  const outcome = dispatched.catch(error => error);
  try {
    await entered.promise;
    await f.app.turns.requestExternalInterrupt(target.conversationId, { source: { kind: 'command', key: f.id('global-stop') }, turnId: target.turnId, reason: '用户停止' });
    controller.abort(new Error('用户停止'));
    await outcome;
    await f.app.toolDispatcher.cancelWaiting({ turnId: target.turnId, sourceKey: f.id('cancel-waits'), reason: '用户停止' });
    await controlOnly(f, () => f.runner.interrupt({ commandId: f.id('finish-all'), ...target, reason: '用户停止' }));
    assert.equal((await f.get('InteractionRequest', askPause.requestId)).status, 'cancelled');
    assert.equal((await f.get('InteractionRequest', approvalPause.requestId)).status, 'cancelled');
    assert.equal((await f.rows('ToolOutcome', { tool_call_id: ask.toolCallId }))[0].status, 'cancelled');
    assert.equal((await f.rows('ToolOutcome', { tool_call_id: approval.toolCallId }))[0].status, 'cancelled');
    assert.equal((await f.rows('TurnTermination', { turn_id: target.turnId }))[0].terminal_status, 'interrupted');
  } finally { release.resolve(); await outcome; f.mcpHandler = original; }
}

export async function userStopsDeadHost(f) {
  const peer = await f.deadPeer('mcp', 'dead-owner'), ready = peer.ready;
  await peer.kill();
  const beforeCalls = f.modelCalls.length;
  await controlOnly(f, async () => {
    const proof = await f.app.phaseDRecovery.deadHostEffectsForTurn(ready.turnId, f.app.database.hostBootId);
    assert.equal(proof.state, 'dead');
    assert.deepEqual(proof.effectIntentIds, [ready.intentId]);
    await f.app.phaseDRecovery.runAll(undefined, ready.conversationId);
    assert.equal((await f.rows('EffectReceipt', { attempt_id: ready.attemptId })).length, 0);
    await f.runner.interrupt({ commandId: f.id('stop-dead'), conversationId: ready.conversationId, turnId: ready.turnId, reason: '用户停止' });
    const [receipt] = await f.rows('EffectReceipt', { attempt_id: ready.attemptId });
    assert.equal(receipt.outcome, 'outcome_unknown');
    assert.equal((await body(f, receipt.response_object_id)).reason, DEAD_HOST_STOP_REASON);
    assert.equal((await f.rows('TurnTermination', { turn_id: ready.turnId }))[0].terminal_status, 'interrupted');
    assert.equal(f.modelCalls.length, beforeCalls);
  });
}

export async function liveDispatchKeepsReceipt(f) {
  const prepared = await mcp(f, await active(f, 'live-dispatch'));
  await f.app.runtime.effects.claimEffectDispatch(prepared.intentId);
  await controlOnly(f, async () => {
    const stop = await f.runner.interrupt({ commandId: f.id('stop-dispatch'), conversationId: prepared.conversationId, turnId: prepared.turnId, reason: '用户停止' });
    assert.equal(stop.executingWindowAlive, true);
    assert.equal((await f.rows('EffectReceipt', { attempt_id: prepared.attemptId })).length, 0);
    assert.equal((await f.get('Turn', prepared.turnId)).status, 'active');
    await succeeded(f, prepared);
    await f.runner.pollExternalWakes();
    await f.runner.recoverStartup(undefined, prepared.conversationId);
    const [receipt] = await f.rows('EffectReceipt', { attempt_id: prepared.attemptId });
    assert.equal(receipt.outcome, 'succeeded');
    assert.equal((await f.rows('TurnTermination', { turn_id: prepared.turnId }))[0].terminal_status, 'interrupted');
  });
}

export async function recoverDispatchedSpawn(f) {
  const peer = await f.deadPeer('spawn', 'dead-spawn'), ready = peer.ready;
  await peer.kill();
  const beforeCalls = f.modelCalls.length;
  await controlOnly(f, async () => {
    assert.deepEqual(await f.app.phaseDRecovery.deadHostEffectsForTurn(ready.turnId, f.app.database.hostBootId), { state: 'unsupported', spawnEffectIntentIds: [ready.intentId] });
    await f.runner.interrupt({ commandId: f.id('stop-spawn'), conversationId: ready.conversationId, turnId: ready.turnId, reason: '用户停止' });
    const [receipt] = await f.rows('EffectReceipt', { attempt_id: ready.attemptId });
    assert.equal(receipt.outcome, 'succeeded');
    assert.equal((await f.rows('ChildExecution', { child_conversation_id: ready.childConversationId })).length, 1);
    assert.equal((await f.rows('TurnTermination', { turn_id: ready.turnId }))[0].terminal_status, 'interrupted');
    await f.coordinator.interruptSubtree({ sourceKey: f.id('stop-child'), childExecutionId: ready.childExecutionId, reason: '用户停止' }, { userStop: true });
    assert.equal((await f.get('Turn', ready.childTurnId)).status, 'terminated');
    assert.equal(f.modelCalls.length, beforeCalls);
  });
}

export async function rejectCancelRace(f) {
  const target = await active(f, 'approval-race');
  const already = await f.source(target.turnId, 'fixture_guarded', {});
  const first = await f.app.interactions.pauseForExecutionApproval({ source: { kind: 'internal', key: f.id('pause-reject') }, toolCallId: already.toolCallId, prompt: { command: 'first' } });
  await f.app.interactions.resolveExecutionApproval({ source: { kind: 'command', key: f.id('reject-first') }, requestId: first.requestId, decision: 'reject', response: { reason: '明确拒绝' } });
  const racing = await f.source(target.turnId, 'fixture_guarded', {});
  const second = await f.app.interactions.pauseForExecutionApproval({ source: { kind: 'internal', key: f.id('pause-race') }, toolCallId: racing.toolCallId, prompt: { command: 'second' } });
  const results = await Promise.all([
    f.app.interactions.resolveExecutionApproval({ source: { kind: 'command', key: f.id('race-reject') }, requestId: second.requestId, decision: 'reject', response: { reason: '明确拒绝' } }),
    f.app.interactions.resolveExecutionApproval({ source: { kind: 'command', key: f.id('race-cancel') }, requestId: second.requestId, decision: 'cancel', response: { reason: '用户停止' } })
  ]);
  assert.equal(results.filter(value => value.won).length, 1);
  assert.equal((await f.rows('InteractionResponse', { request_id: second.requestId })).length, 1);
  await controlOnly(f, () => f.runner.interrupt({ commandId: f.id('stop-approval'), ...target, reason: '用户停止' }));
  assert.equal((await f.get('InteractionRequest', first.requestId)).status, 'rejected');
  assert.equal((await f.rows('ToolOutcome', { tool_call_id: already.toolCallId }))[0].status, 'rejected');
  const state = (await f.get('InteractionRequest', second.requestId)).status;
  assert.ok(state === 'rejected' || state === 'cancelled');
  assert.equal((await f.rows('ToolOutcome', { tool_call_id: racing.toolCallId }))[0].status, state);
}
