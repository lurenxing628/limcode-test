import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { openDeliveryFixture, load, kernel, repo, gate, answer } from './collaboration-delivery-fixture.mjs';
import { localRootTransfer, overwriteSymlinkRefusal, directorySelfRefusal, remoteBashEscapeRefusal } from './collaboration-transfer-cases.mjs';
const { CollaborationControlPlane, COLLABORATION_MESSAGE_MAX_TEXT_BYTES } = load('backend/reliableKernel/collaborationControlPlane.js');
const { RuntimeDeliveryControlPlane } = load('backend/reliableKernel/answerDelivery.js');
const { ProcessCompletionDeliveryControlPlane } = load('backend/reliableKernel/processCompletionDelivery.js');
const { CollaborationToolDispatcher } = load('backend/reliableKernel/collaborationToolDispatcher.js');
const { crossConversationToolPermitted } = load('shared/toolPolicyResolution.js');
const { runtimeDeliverySourceTurn } = load('backend/reliableKernel/childTaskTurn.js');
const { ReliableToolDispatcher } = load('backend/reliableKernel/toolDispatcher.js');
const { crossConversationToolModules } = load('backend/world/modules/tools/definitions/crossConversation/index.js');
const { deriveCommittedParentHandling } = load('backend/reliableKernel/clientProjection.js');
const { CORRUPTED_CONSUMED_DELIVERY_REASON } = load('backend/reliableKernel/runtimeDeliveryAggregate.js');
import Database from 'better-sqlite3';
let f;
before(async () => { f = await openDeliveryFixture(); });
after(async () => { await f?.close(); });
const driveChild = async child => {
  assert.equal(f.coordinator.launch(child.childExecutionId, child.childTurnId), true);
  return f.coordinator.activeTurns.get(child.childTurnId);
};
const replies = async (conversationId, messageId) => (await f.app.runtime.collaboration.listMessages({ conversationId })).messages.filter(row => row.replyToMessageId === messageId);

// Runner integrations use the production wake handler with synthetic provider responses.
test('a child result arriving during the parent final output preserves that output and enters one continuation', { timeout: 8000 }, async () => {
  const parent = await f.parentTurn('final-fence'), child = await f.spawn(parent);
  await f.app.turns.terminal({ source: { kind: 'internal', key: f.id('parent-completed') }, turnId: parent.turnId, terminalStatus: 'completed', reason: 'Parent delegated its task' });
  const entered = gate(), release = gate();
  let originalTurn, continuationTurn, parentCalls = 0;
  f.model = async (request, start) => {
    if (request.conversationId === child.childConversationId) return answer('CHILD_FINAL_RESULT');
    if (request.conversationId === parent.conversationId && !originalTurn) {
      originalTurn = request.turnId; parentCalls++; entered.resolve(); await f.until(() => release.settled, 'parent final output gate was not released'); return answer('PARENT_ORIGINAL_FINAL');
    }
    if (request.conversationId === parent.conversationId && JSON.stringify(start.contents).includes('CHILD_FINAL_RESULT')) continuationTurn = request.turnId;
    return answer('Parent consumed the result.');
  };
  try {
    const runner = f.activateRunner();
    const input = await runner.input({ commandId: f.id('parent-next'), conversationId: parent.conversationId, text: 'Finish current work' });
    assert.equal(input.admitted, true, JSON.stringify(input));
    await f.until(() => entered.settled, 'the parent Runner did not reach its provider');
    await driveChild(child);
    const [routed] = await f.rows('RuntimeDelivery', { target_conversation_id: parent.conversationId });
    assert.equal(routed.target_turn_id, input.turnId);
    release.resolve();
    await runner.waitForIdle();
    await f.app.processDeliveries.scanNow();
    await f.until(() => continuationTurn, 'the child answer did not start its continuation');
    await runner.waitForIdle();
    assert.equal(parentCalls, 1);
    assert.equal((await f.rows('ModelRequest', { turn_id: input.turnId })).length, 1);
    assert.equal((await f.rows('MessageTurnLink', { turn_id: input.turnId, role: 'model' })).length, 1);
    const delivered = await f.get('RuntimeDelivery', routed.id);
    assert.equal(delivered.state, 'consumed');
    assert.equal(delivered.target_turn_id, continuationTurn);
    assert.notEqual(continuationTurn, input.turnId);
  } finally { release.resolve(); f.model = async request => answer(`completed ${request.conversationId}`); }
});

test('two parent messages automatically wake one idle child Turn with non-user provenance', { timeout: 8000 }, async () => {
  const f = await openDeliveryFixture(), ready = gate();
  const parent = await f.parentTurn('coalesced'), child = await f.spawn(parent);
  await f.endTurn(child.childTurnId);
  await f.app.runtime.children.observeTurnTerminal(child.childExecutionId, child.childTurnId);
  const calls = [];
  f.model = async (request, start) => {
    if (request.conversationId === child.childConversationId) {
      calls.push(request.turnId);
      const wire = JSON.stringify(start.contents);
      assert.match(wire, /FIRST_TEAM_NOTE/); assert.match(wire, /SECOND_TEAM_NOTE/);
      assert.match(wire, /not from this conversation's user/);
    }
    return answer('Read both team notes.');
  };
  try {
    f.activateRunner({ ready: () => ready.promise });
    await f.app.processDeliveries.start();
    const send = async text => f.app.runtime.collaboration.send({ source: await f.source(parent.conversationId, parent.turnId),
      targetConversationId: child.childConversationId, mode: 'message', text });
    const first = await send('FIRST_TEAM_NOTE'), second = await send('SECOND_TEAM_NOTE');
    assert.equal(first.targetDelivery, 'wakes_target');
    assert.equal(second.targetDelivery, 'wakes_target');
    ready.resolve();
    await f.until(() => calls.length === 1, 'the message-woken child did not reach its provider');
    await f.coordinator.waitForIdle();
    assert.equal(new Set(calls).size, 1);
    const target = (await f.get('RuntimeDelivery', first.deliveryId)).target_turn_id;
    assert.equal((await f.get('RuntimeDelivery', second.deliveryId)).target_turn_id, target);
    assert.equal((await f.get('RuntimeDelivery', first.deliveryId)).state, 'consumed');
    assert.equal((await f.rows('MessageTurnLink', { turn_id: target, role: 'user' })).length, 0);
    assert.equal((await f.rows('Turn', { conversation_id: child.childConversationId })).length, 2);
    assert.equal((await f.rows('CollaborationBudget', { origin_kind: 'delivery_wake' })).length, 1);
    assert.equal((await f.rows('AnswerSubmission')).length, 0, 'reading a message is not a new task answer');
  } finally { ready.resolve(); await f.close(); }
});

test('child messages automatically wake the idle parent before its answer and keep the origin budget', { timeout: 10000 }, async () => {
  const f = await openDeliveryFixture(), ready = gate(), entered = gate(), release = gate();
  const parent = await f.parentTurn('child-note', { toolConfigs: { run_agent: { config: { maxAutomaticFollowups: 1 } } } });
  const child = await f.spawn(parent), calls = [];
  await f.endTurn(parent.turnId);
  f.model = async (request, start) => {
    if (request.conversationId === child.childConversationId) return answer('CHILD_EVENTUAL_ANSWER');
    calls.push({ turnId: request.turnId, wire: JSON.stringify(start.contents) });
    if (calls.length === 1) { entered.resolve(); await release.promise; }
    return answer('Read the child update.');
  };
  try {
    f.activateRunner({ ready: () => ready.promise });
    await f.app.processDeliveries.start();
    const sendFrom = async (from, targetConversationId, text) => {
      const source = await f.source(from.conversationId, from.turnId);
      const sent = await f.app.runtime.collaboration.send({ source, targetConversationId, mode: 'message', text });
      await f.app.runtime.effects.settleWithoutEffect({ source: { kind: 'internal', key: `sent:${source.toolCallId}` },
        toolCallId: source.toolCallId, status: 'succeeded', detail: sent });
      return sent;
    };
    const sender = { conversationId: child.childConversationId, turnId: child.childTurnId };
    const first = await sendFrom(sender, parent.conversationId, 'FIRST_CHILD_NOTE');
    const second = await sendFrom(sender, parent.conversationId, 'SECOND_CHILD_NOTE');
    assert.equal(first.targetDelivery, 'wakes_target');
    assert.equal(second.targetDelivery, 'wakes_target');
    ready.resolve();
    await f.until(() => entered.settled, 'the child message did not automatically start the parent');
    assert.match(calls[0].wire, /FIRST_CHILD_NOTE/); assert.match(calls[0].wire, /SECOND_CHILD_NOTE/);
    assert.equal((await f.get('Turn', child.childTurnId)).status, 'active');
    assert.equal((await f.rows('AnswerSubmission')).length, 0, 'the parent starts before the task answers');
    const wakingTurn = calls[0].turnId;
    for (const sent of [first, second]) {
      assert.equal((await f.get('RuntimeDelivery', sent.deliveryId)).target_turn_id, wakingTurn);
      assert.equal((await f.get('RuntimeDelivery', sent.deliveryId)).state, 'consumed');
    }
    assert.equal(f.coordinator.launch(child.childExecutionId, child.childTurnId), true);
    await f.coordinator.activeTurns.get(child.childTurnId);
    const back = await sendFrom({ conversationId: parent.conversationId, turnId: wakingTurn }, child.childConversationId, 'NO_REPLY_LOOP');
    assert.equal(back.targetDelivery, 'waits_budget_exhausted', 'the parent continuation cannot reset the child message budget');
    release.resolve();
    await f.until(() => calls.length === 2, 'the eventual child answer was not delivered');
    await f.runner.waitForIdle();
    await f.until(async () => (await f.rows('RuntimeDeliveryWake', { delivery_id: back.deliveryId }))[0]?.state === 'acknowledged', 'the spent message wake did not settle');
    await f.app.processDeliveries.scanNow();
    assert.equal(calls.length, 2, 'one message Turn and one later answer Turn, without replay');
    assert.match(calls[1].wire, /CHILD_EVENTUAL_ANSWER/);
    assert.equal((await f.rows('Turn', { conversation_id: child.childConversationId })).length, 1);
    assert.equal((await f.get('RuntimeDelivery', back.deliveryId)).state, 'pending');
    const charges = await f.rows('CollaborationBudget', { origin_kind: 'delivery_wake' });
    assert.equal(charges.length, 1); assert.equal(charges[0].authority_turn_id, parent.turnId);
    for (const sent of [first, second]) assert.equal((await f.get('RuntimeDelivery', sent.deliveryId)).target_turn_id, wakingTurn);
  } finally { ready.resolve(); release.resolve(); await f.close(); }
});

test('startup recovers child messages missing a wake without reopening settled wakes or a zero budget', { timeout: 10000 }, async t => {
  const f = await openDeliveryFixture(), calls = [];
  t.after(() => f.close());
  const parent = await f.parentTurn('old-child-note'), child = await f.spawn(parent);
  await f.endTurn(parent.turnId);
  const send = async text => f.app.runtime.collaboration.send({ source: await f.source(child.childConversationId, child.childTurnId),
    targetConversationId: parent.conversationId, mode: 'message', text });
  const plane = f.app.runtime.collaboration, targetDelivery = plane.targetDelivery;
  let missed;
  // Replay the former producer: a child message committed without a wake outbox row.
  plane.targetDelivery = async () => 'waits_for_next_turn';
  try { missed = await send('RECOVER_CHILD_NOTE'); } finally { plane.targetDelivery = targetDelivery; }
  assert.equal((await f.rows('RuntimeDeliveryWake', { delivery_id: missed.deliveryId })).length, 0);
  const acknowledged = await send('ALREADY_ACKNOWLEDGED'), dead = await send('ALREADY_DEAD');
  const wakes = await Promise.all([acknowledged, dead].map(async sent => (await f.rows('RuntimeDeliveryWake', { delivery_id: sent.deliveryId }))[0]));
  await f.app.database.transaction([
    repo('RuntimeDeliveryWake').update(wakes[0].id, { state: 'claimed', claim_owner_host_boot_id: f.app.database.hostBootId,
      claim_generation: 1n, attempt_count: 1n, claim_expires_at: new Date(Date.now() + 60000).toISOString() }),
    repo('RuntimeDeliveryWake').update(wakes[0].id, { state: 'acknowledged', acknowledged_at: f.now(), claim_owner_host_boot_id: null, claim_expires_at: null }),
    repo('RuntimeDeliveryWake').update(wakes[1].id, { state: 'dead_letter', last_error: 'fixture-settled' })
  ]);
  const settled = await Promise.all(wakes.map(wake => f.get('RuntimeDeliveryWake', wake.id)));
  const zeroParent = await f.parentTurn('zero-budget', { toolConfigs: { run_agent: { config: { maxAutomaticFollowups: 0 } } } });
  const zeroChild = await f.spawn(zeroParent);
  await f.endTurn(zeroParent.turnId);
  const zero = await f.app.runtime.collaboration.send({ source: await f.source(zeroChild.childConversationId, zeroChild.childTurnId),
    targetConversationId: zeroParent.conversationId, mode: 'message', text: 'WAIT_FOR_USER' });
  assert.equal(zero.targetDelivery, 'waits_budget_exhausted');
  f.model = async (request, start) => { calls.push(request.conversationId); assert.match(JSON.stringify(start.contents), /RECOVER_CHILD_NOTE/); return answer('Recovered the child update.'); };
  f.activateRunner();
  await f.app.processDeliveries.start();
  await f.until(() => calls.length === 1, 'startup did not recover the pending child message');
  await f.runner.waitForIdle();
  await f.until(async () => (await f.rows('RuntimeDeliveryWake', { delivery_id: zero.deliveryId }))[0]?.state === 'acknowledged', 'zero-budget wake did not settle');
  await f.app.processDeliveries.scanNow();
  assert.deepEqual(calls, [parent.conversationId]);
  assert.equal((await f.get('RuntimeDelivery', missed.deliveryId)).state, 'consumed');
  assert.equal((await f.get('RuntimeDeliveryWake', kernel.stablePhaseFId('runtime_delivery_wake', missed.deliveryId))).state, 'acknowledged');
  assert.deepEqual(await Promise.all(wakes.map(wake => f.get('RuntimeDeliveryWake', wake.id))), settled);
  assert.equal((await f.get('RuntimeDelivery', zero.deliveryId)).state, 'pending');
  assert.equal((await f.rows('Turn', { conversation_id: zeroParent.conversationId })).length, 1);
});

test('a task final answer is durable before Turn completion and a failed delivery handoff recovers once', async () => {
  const parent = await f.parentTurn('handoff'), child = await f.spawn(parent);
  const deliveries = f.app.runtime.deliveries, originalCreate = deliveries.createAutomatic;
  const turns = f.app.agentLoop.turns, originalTerminal = turns.terminal;
  let refused = false, answerBeforeCompletion = false;
  deliveries.createAutomatic = async function(input) {
    const inbox = await f.get('RuntimeInboxItem', input.inboxItemId);
    if (!refused && inbox?.source_kind === 'answer_submission') { refused = true; throw Object.assign(new Error('delivery CAS lost'), { code: 'RUNTIME_TRANSACTION_ASSERTION_FAILED' }); }
    return originalCreate.call(this, input);
  };
  turns.terminal = async function(command) {
    if (command.turnId === child.childTurnId) answerBeforeCompletion = (await f.rows('AnswerSubmission', { turn_id: child.childTurnId })).length === 1;
    return originalTerminal.call(this, command);
  };
  f.model = async () => answer('HANDOFF_DURABLE_ANSWER');
  try {
    await driveChild(child);
    assert.equal(refused, true);
    assert.equal(answerBeforeCompletion, true);
    assert.equal((await f.rows('TurnTermination', { turn_id: child.childTurnId }))[0].terminal_status, 'completed');
    await f.coordinator.recoverStartup(undefined, child.childConversationId);
    const [submission] = await f.rows('AnswerSubmission', { turn_id: child.childTurnId });
    const [inbox] = await f.rows('RuntimeInboxItem', { source_id: submission.id });
    await f.until(async () => (await f.rows('RuntimeDelivery', { inbox_item_id: inbox.id })).length === 1, 'the durable answer was not handed on');
    assert.equal((await f.rows('AnswerSubmission', { answer_bridge_id: child.answerBridgeId })).length, 1);
    assert.equal((await f.rows('Turn', { conversation_id: child.childConversationId })).length, 1);
  } finally { deliveries.createAutomatic = originalCreate; turns.terminal = originalTerminal; f.model = async request => answer(`completed ${request.conversationId}`); await f.coordinator.dispose(); }
});

test('a user-owned Turn in a child conversation cannot replace the parent task answer', async () => {
  const parent = await f.parentTurn('user-child'), child = await f.spawn(parent);
  const submitted = await f.app.runtime.answers.submit({ answerBridgeId: child.answerBridgeId, submissionId: f.id('answer'),
    sourceTurnId: child.childTurnId, content: 'ORIGINAL_TASK_ANSWER', contentType: 'text/plain' });
  await f.endTurn(child.childTurnId);
  await f.app.runtime.children.observeTurnTerminal(child.childExecutionId, child.childTurnId);
  const typed = await f.app.turns.input({ ...turnInput(child.childConversationId, 'user question'),
    membership: { kind: 'child_execution', childExecutionId: child.childExecutionId } });
  const userTurn = typed.turnId;
  assert.equal(await f.app.runtime.answers.isChildTaskTurn(userTurn), false);
  await f.coordinator.submitTurnFinalAnswer({ turnId: userTurn, modelRequestId: 'unused-request', finalText: 'USER_ONLY_ANSWER' });
  assert.equal((await f.rows('AnswerSubmission', { answer_bridge_id: child.answerBridgeId })).length, 1);
  assert.equal((await f.app.runtime.answers.readCurrent(child.answerBridgeId)).submissionId, submitted.submissionId);
  assert.equal((await f.app.runtime.answers.readCurrent(child.answerBridgeId)).content, 'ORIGINAL_TASK_ANSWER');
});

test('a delayed nested answer for an older parent generation becomes notify-only', async () => {
  const root = await f.parentTurn('nested-old'), parent = await f.spawn(root);
  const child = await f.spawn({ conversationId: parent.childConversationId, turnId: parent.childTurnId });
  const submitted = await f.app.runtime.answers.submit({ answerBridgeId: child.answerBridgeId, submissionId: f.id('nested-answer'),
    sourceTurnId: child.childTurnId, content: 'OLD_GENERATION_RESULT', contentType: 'text/plain' });
  await f.endTurn(parent.childTurnId);
  const newer = f.id('new-parent-generation'), active = (await f.rows('ChildExecutionActiveTurnLink', { child_execution_id: parent.childExecutionId }))[0];
  await f.app.database.transaction([
    repo('Turn').insert({ id: newer, conversation_id: parent.childConversationId, status: 'active', created_at: f.now(), updated_at: f.now(), terminal_at: null }),
    repo('ChildExecutionTurnLink').insert({ id: `${newer}-member`, child_execution_id: parent.childExecutionId, turn_id: newer, turn_seq: 2n, created_at: f.now() }),
    repo('ChildExecutionActiveTurnLink').update(active.id, { turn_id: newer, updated_at: f.now() })
  ]);
  const delivered = await f.app.runtime.deliveries.createAutomatic({ inboxItemId: submitted.inboxItemId,
    targetConversationId: parent.childConversationId, sourceTurnId: parent.childTurnId });
  assert.equal(delivered.delivery.phase, 'notify_only');
  assert.equal((await f.rows('RuntimeDeliveryInputLink', { delivery_id: delivered.delivery.id })).length, 0);
  assert.equal(await runtimeDeliverySourceTurn(f.app.database, f.app.contentStore, submitted.inboxItemId), parent.childTurnId);
  assert.notEqual(parent.childTurnId, newer);
});

test('one task-tree board thread preserves tool provenance and rejects another tree', async () => {
  const s = await f.scenario('board'), board = f.app.runtime.collaborationBoard;
  const call = async (who, args, source) => board.execute({ conversationId: s[who], turnId: s.turn(who),
    toolCallId: (source ?? await s.source(who, 'agent_board', args)).toolCallId }, args);
  const { channel } = await call('root', { operation: 'create_channel', name: 'investigation' });
  const args = { operation: 'post', channelId: channel.id, text: 'Shared 中文 evidence' }, source = await s.source('left', 'agent_board', args);
  const posted = await call('left', args, source), replay = await call('left', args, source);
  assert.equal(posted.postId, replay.postId);
  const reply = await call('root', { operation: 'post', threadId: posted.threadId, text: 'One reply' });
  assert.ok(reply.postId);
  const read = await call('root', { operation: 'read_thread', threadId: posted.threadId });
  assert.equal(read.root.authorConversationId, s.left);
  assert.equal(read.replies.length, 1);
  assert.equal((await call('root', { operation: 'read_post', postId: posted.postId })).text, args.text);
  await assert.rejects(call('outsider', { operation: 'read_post', postId: posted.postId }), /task tree/);
  await assert.rejects(call('left', { ...args, text: 'rewritten' }, source), /reused/);
});

function frozenDispatcher(toolName = 'send_agent_message', args = { targetConversationId: 'peer', text: 'committed text' }) {
  const document = { toolPolicy: { allowedTools: [toolName, 'run_agent'], toolConfigs: { run_agent: { config: { crossConversationCollaboration: true } } } } };
  const records = { AuthoritySnapshot: { id: 'authority', turn_id: 'turn', content_object_id: 'authority-body' },
    Turn: { id: 'turn', conversation_id: 'caller', status: 'active' }, ToolCall: { id: 'call', turn_id: 'turn', tool_name: toolName, arguments_object_id: 'arguments', status: 'pending' },
    ModelRequest: { id: 'request', turn_id: 'turn', authority_snapshot_id: 'authority' }, ToolCallSourceLink: [{ id: 'source', tool_call_id: 'call', model_request_id: 'request' }] };
  const calls = [], settlements = [];
  const dispatcher = new CollaborationToolDispatcher({
    database: { async snapshot(reads) { return { snapshot: reads.map(read => read.domain === 'ContentObject' ? { id: read.id } : records[read.domain]) }; } },
    contentStore: { async read(row) { return Buffer.from(JSON.stringify(row.id === 'authority-body' ? document : args)); } },
    collaboration: { async send(input) { calls.push(input); return { accepted: true }; } },
    effects: { async settleWithoutEffect(input) { settlements.push(input); return input; } }
  });
  return { dispatcher, calls, settlements, document, input: { turnId: 'turn', modelRequestId: 'request', toolCallId: 'call', toolName, arguments: args },
    authority: { snapshotId: 'authority', document } };
}

test('changed committed ToolCall arguments are rejected before collaboration or settlement', async () => {
  const value = frozenDispatcher();
  value.input.arguments = { targetConversationId: 'peer', text: 'changed after commit' };
  await assert.rejects(value.dispatcher.dispatch(value.input, undefined, value.authority));
  assert.deepEqual(value.calls, []); assert.deepEqual(value.settlements, []);
});

test('the tools view preserves opaque activity cursors through the real dispatcher', async () => {
  const args = { view: 'tools', targetConversationId: 'peer', cursor: 'agent-tools:detail' };
  const value = frozenDispatcher('read_agent_messages', args);
  value.dispatcher.dependencies.collaboration.readToolActivity = async input => {
    assert.equal(input.cursor, args.cursor);
    assert.equal(input.targetConversationId, 'peer');
    return { view: 'tools', text: 'shell output', nextCursor: 'agent-tools:next', rereadCursor: args.cursor };
  };
  await value.dispatcher.dispatch(value.input, undefined, value.authority);
  const detail = value.settlements[0].detail;
  assert.equal(detail.nextCursor, 'agent-tools:next');
  assert.equal(detail.nextAfterMessageId, undefined);
});

test('one followup commits once, is attributed as non-user input and returns one durable completion reply', async () => {
  const s = await f.scenario('followup'), source = await s.source();
  const input = { source, targetConversationId: s.root, text: 'review the evidence', mode: 'followup' };
  const sent = await Promise.all([f.app.runtime.collaboration.send(input), f.app.runtime.collaboration.send(input)]);
  assert.equal(sent[0].messageId, sent[1].messageId);
  assert.equal(sent.filter(row => row.deduplicated).length, 1);
  await f.app.runtime.deliveries.advance(sent[0].deliveryId);
  const [pending] = await f.rows('PendingTurnInput', { turn_id: s.turn('root') });
  const metadata = await f.get('ContentObject', pending.content_object_id);
  const projected = await f.app.runtime.deliveries.projectInputForModel({ pendingTurnInputId: pending.id, contentObjectId: metadata.id,
    contentType: metadata.content_type, content: await f.app.contentStore.read(metadata) });
  assert.equal(projected.envelope.sourceKind, 'tool');
  assert.match(projected.envelope.note, /not a new user instruction/);
  assert.equal((await f.app.runtime.collaboration.readMessage({ conversationId: s.root, messageId: sent[0].messageId })).handled, false);
  await f.app.runtime.deliveries.markInputHandled(pending.id);
  await f.endTurn(s.turn('root'));
  await f.app.runtime.collaboration.completeRequestsForTurn({ turnId: s.turn('root'), text: 'EXPLICIT_REVIEW_RESULT' });
  await f.app.runtime.collaboration.reconcile();
  const [reply] = await replies(s.left, sent[0].messageId);
  assert.equal(reply.sourceKind, 'completion');
  assert.equal((await f.app.runtime.collaboration.readMessage({ conversationId: s.left, messageId: reply.messageId })).text, 'EXPLICIT_REVIEW_RESULT');
  await f.reopen();
  assert.equal((await f.app.runtime.collaboration.readMessage({ conversationId: s.left, messageId: reply.messageId })).text, 'EXPLICIT_REVIEW_RESULT');

});

test('queued peer tasks stay out of a racing user Turn and start in their committed order', async () => {
  const s = await f.scenario('peer-order'), at = s.at;
  const plane = new CollaborationControlPlane(f.app.database, f.app.contentStore, f.app.runtime.deliveries, { now: () => at });
  const send = async text => plane.send({ source: await s.source('root', 'send_conversation_message'), targetConversationId: s.outsider,
    mode: 'followup', text, crossConversation: true, queueBehindActiveTurn: true });
  const one = await send('first peer task'), two = await send('second peer task');
  await f.endTurn(s.turn('outsider'));
  const user = f.id('peer-user');
  await f.admit(s, s.outsider, user);
  assert.equal((await f.get('RuntimeDelivery', one.deliveryId)).state, 'pending');
  assert.equal((await f.get('RuntimeDelivery', two.deliveryId)).state, 'pending');
  const started = [], failures = [];
  const scanner = new ProcessCompletionDeliveryControlPlane(f.app.database, f.app.contentStore, {}, f.app.runtime.deliveries, {
    onError: value => { if (value.id === one.deliveryId || value.id === two.deliveryId) failures.push(value.error); },
    wakeHandler: async request => {
      if (request.conversationId !== s.outsider || request.action !== 'start_continuation') return { acknowledged: false };
      const turnId = f.id('peer-started');
      await f.continuation(s, s.outsider, turnId, request.deliveryId);
      started.push({ turnId, deliveryId: request.deliveryId });
      return { acknowledged: true };
    }
  });
  try {
    await scanner.scanNow();
    assert.deepEqual(started, [], 'the queued tasks do not enter the user Turn');
    await f.endTurn(user);
    await scanner.scanNow();
    assert.deepEqual(started.map(row => row.deliveryId), [one.deliveryId]);
    assert.equal((await f.get('RuntimeDelivery', two.deliveryId)).state, 'pending');
    await f.endTurn(started[0].turnId);
    await scanner.scanNow();
    assert.deepEqual(started.map(row => row.deliveryId), [one.deliveryId, two.deliveryId]);
    assert.equal((await f.get('RuntimeDelivery', one.deliveryId)).target_turn_id, started[0].turnId);
    assert.equal((await f.get('RuntimeDelivery', two.deliveryId)).target_turn_id, started[1].turnId);
    assert.deepEqual(failures, []);
  } finally { await scanner.dispose(); }
  assert.equal((await f.get('CollaborationMessage', one.messageId)).created_at, (await f.get('CollaborationMessage', two.messageId)).created_at);
  assert.ok((await f.get('CollaborationMessage', one.messageId)).message_seq < (await f.get('CollaborationMessage', two.messageId)).message_seq);
});

test('two concurrent sends compete for the last automatic followup budget without partial writes', async () => {
  const s = await f.scenario('last-budget', 1);
  const results = await Promise.allSettled([s.send('left', 'right', 'followup', 'one'), s.send('left', 'root', 'followup', 'two')]);
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
  assert.equal(results.filter(row => row.status === 'rejected').length, 1);
  const messages = (await f.rows('CollaborationMessageSourceLink')).filter(row => row.conversation_id === s.left);
  assert.equal(messages.length, 1);
  assert.equal((await f.rows('CollaborationRequest', { message_id: messages[0].message_id })).length, 1);
});

test('sixteen unread peer inputs fill the target while a completion reply keeps its reserved place', async () => {
  const s = await f.scenario('unread-cap');
  const request = await s.send('outsider', 'root', 'followup', 'please reply', { crossConversation: true, queueBehindActiveTurn: true });
  await f.endTurn(s.turn('root'));
  const answering = f.id('cap-answering'); await f.continuation(s, s.root, answering, request.deliveryId); await f.endTurn(answering);
  await f.app.runtime.collaboration.completeRequestsForTurn({ turnId: answering, text: 'owed completion' });
  // Sixteen naturally unread inputs are one capacity state, not sixteen test configurations.
  const payload = await f.app.contentStore.ingest(f.app.database, 'queued peer note', 'text/vnd.limcode.collaboration-message');
  const at = f.now();
  await f.app.database.transaction(Array.from({ length: 16 }, (_, index) => {
    const id = `${s.prefix}-full-${index}`;
    return [repo('CollaborationMessage').insertWithNextSequence({ id, dedupe_key: id, mode: 'message', created_at: at }, { column: 'message_seq', scope: {} }),
      repo('CollaborationMessageSourceLink').insert({ id: `${id}-source`, message_id: id, conversation_id: s.root, source_kind: 'tool', source_key: id, turn_id: null, tool_call_id: null, created_at: at }),
      repo('RuntimeInboxItem').insert({ id: `${id}-inbox`, dedupe_key: id, source_kind: 'collaboration_message', source_id: id, state: 'available', created_at: at, updated_at: at }),
      repo('CollaborationMessageTargetLink').insert({ id: `${id}-target`, message_id: id, conversation_id: s.outsider, inbox_item_id: `${id}-inbox`, anchor_turn_id: s.turn('outsider'), created_at: at }),
      repo('CollaborationMessagePayloadLink').insert({ id: `${id}-payload`, message_id: id, content_object_id: payload.id, created_at: at }),
      repo('RuntimeInboxPayloadLink').insert({ id: `${id}-inbox-payload`, inbox_item_id: `${id}-inbox`, content_object_id: payload.id, created_at: at }),
      repo('RuntimeDelivery').insert({ id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: s.outsider, target_turn_id: null,
        phase: 'next_turn', attempt_seq: 1n, retry_of_delivery_id: null, state: 'pending', failure_reason: null, created_at: at, updated_at: at })];
  }).flat());
  assert.equal((await f.rows('RuntimeDelivery', { target_conversation_id: s.outsider, state: 'pending' })).length, 17);
  const before = (await f.rows('CollaborationMessage')).length;
  // s.left is a child; root's new active answering Turn is the top-level sender of the overflow.
  const sendingTurn = f.id('cap-sender'); await f.admit(s, s.root, sendingTurn);
  const overflow = await f.source(s.root, sendingTurn, 'send_conversation_message');
  await assert.rejects(f.app.runtime.collaboration.send({ source: overflow, targetConversationId: s.outsider, mode: 'message', text: 'overflow', crossConversation: true, queueBehindActiveTurn: true }), /16 unread collaboration messages/);
  assert.equal((await f.rows('CollaborationMessage')).length, before);
  await f.endTurn(s.turn('outsider'));
  await f.admit(s, s.outsider, f.id('cap-drained'));
  const again = await f.app.runtime.collaboration.send({ source: await f.source(s.root, sendingTurn, 'send_conversation_message'), targetConversationId: s.outsider, mode: 'message', text: 'after drain', crossConversation: true, queueBehindActiveTurn: true });
  assert.equal(again.accepted, true);
});

test('UTF-8 message capacity is exact and paged Unicode content is lossless', async () => {
  const s = await f.scenario('byte-cap'), cap = COLLABORATION_MESSAGE_MAX_TEXT_BYTES;
  const mixed = '界😀'.repeat(Math.floor(cap / 7)), atCap = mixed + 'x'.repeat(cap - Buffer.byteLength(mixed));
  assert.equal(Buffer.byteLength(atCap), cap);
  await assert.rejects(s.send('left', 'right', 'message', `${atCap}x`), /UTF-8 bytes/);
  assert.equal((await f.rows('CollaborationMessageSourceLink')).filter(row => row.conversation_id === s.left).length, 0);
  const sent = await s.send('left', 'right', 'message', atCap), pages = [];
  for (let offset = 0; offset !== null;) {
    const page = await f.app.runtime.collaboration.readMessage({ conversationId: s.right, messageId: sent.messageId, offset });
    assert.ok(!/^[\udc00-\udfff]/.test(page.text) && !/[\ud800-\udbff]$/.test(page.text));
    pages.push(page.text); offset = page.nextOffset;
  }
  assert.equal(pages.join(''), atCap);
});

test('deterministic competing reconciliation sends one failure reply and settles one request', async () => {
  const s = await f.scenario('reconcile'), sent = await s.send('root', 'outsider', 'followup', 'unstartable peer task', { crossConversation: true, queueBehindActiveTurn: true });
  await f.app.database.transaction([repo('RuntimeDelivery').update(sent.deliveryId, { state: 'failed', failure_reason: 'wake-dead-letter:fixture', updated_at: f.now() })]);
  const plane = f.app.runtime.collaboration, existing = plane.existing;
  const [targetRequest] = await f.rows('CollaborationRequest', { message_id: sent.messageId });
  let fired = false, count = 0;
  plane.existing = async function(domain, id) {
    if (!fired && domain === 'CollaborationRequest' && id === targetRequest.id && ++count === 2) { fired = true; await plane.reconcile(); }
    return existing.call(this, domain, id);
  };
  try { await plane.reconcile(); } finally { plane.existing = existing; }
  assert.equal(fired, true);
  assert.equal((await replies(s.root, sent.messageId)).length, 1);
  const [request] = await f.rows('CollaborationRequest', { message_id: sent.messageId });
  assert.equal(request.state, 'failed');
});

test('deleting a pending peer task closes its wake and sends a single deleted-target notice', async () => {
  const s = await f.scenario('deleted-target');
  const sent = await s.send('root', 'outsider', 'followup', 'queued peer task', { crossConversation: true, queueBehindActiveTurn: true });
  const unrelated = await s.send('left', 'right', 'message', 'keep this other delivery');
  await f.endTurn(s.turn('outsider'));
  await new kernel.ConversationDeletionControlPlane(f.app.database).delete(s.outsider);
  assert.equal((await f.get('RuntimeDelivery', sent.deliveryId)).failure_reason, 'target-gone');
  assert.equal((await f.rows('RuntimeDeliveryWake', { delivery_id: sent.deliveryId }))[0].state, 'dead_letter');
  await f.app.runtime.collaboration.reconcile();
  const [reply] = await replies(s.root, sent.messageId);
  assert.match((await f.app.runtime.collaboration.readMessage({ conversationId: s.root, messageId: reply.messageId })).text, /target conversation was deleted/);
  assert.equal((await f.get('RuntimeDelivery', unrelated.deliveryId)).state, 'pending');
});

function turnInput(conversationId, text) {
  return { source: { kind: 'command', key: f.id('cross-input') }, conversationId, content: text,
    leaseOwnerId: 'fixture-owner', hostBootId: f.app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 600000).toISOString() };
}

test('cross tools use the Turn frozen switch and admit only reads when run_agent is absent', async () => {
  const saved = { allowedTools: ['read'], toolConfigs: { run_agent: { config: { crossConversationCollaboration: true, maxAutomaticFollowups: 2 } } } };
  const parent = await f.parentTurn('frozen-switch', saved);
  const dispatcher = new ReliableToolDispatcher({ database: f.app.database, contentStore: f.app.contentStore, effects: f.app.runtime.effects,
    host: { definitions: () => crossConversationToolModules.map(module => ({ execution: 'backend', ...module.create({}) })) } });
  const offered = (await dispatcher.definitions(parent.turnId)).map(row => row.name);
  assert.ok(offered.includes('list_conversations')); assert.ok(offered.includes('read_conversation'));
  assert.equal(offered.includes('send_conversation_message'), false);
  const source = await f.source(parent.conversationId, parent.turnId, 'send_conversation_message', { targetConversationId: 'unused', text: 'x', mode: 'message' });
  const refusal = await dispatcher.dispatch({ turnId: parent.turnId, modelRequestId: 'unused', toolCallId: source.toolCallId,
    toolName: 'send_conversation_message', arguments: { targetConversationId: 'unused', text: 'x', mode: 'message' } });
  assert.equal(refusal.status, 'rejected');
  assert.equal(crossConversationToolPermitted(saved.allowedTools, 'send_conversation_message'), false);
  assert.equal(crossConversationToolPermitted(saved.allowedTools, 'read_conversation'), true);
  f.configs.set(parent.conversationId, { ...saved, toolConfigs: { run_agent: { config: { crossConversationCollaboration: false, maxAutomaticFollowups: 2 } } } });
  assert.ok((await dispatcher.definitions(parent.turnId)).some(row => row.name === 'list_conversations'), 'saved changes do not rewrite an existing Turn');
  await f.endTurn(parent.turnId);
  const next = await f.app.turns.input(turnInput(parent.conversationId, 'Read the new switch'));
  assert.equal((await dispatcher.definitions(next.turnId)).some(row => row.name === 'list_conversations'), false);
  await assert.rejects(f.app.runtime.collaboration.listConversations({ turnId: next.turnId }), /not enabled/);
  await dispatcher.dispose();
});

test('same-project peer listing excludes the caller task tree and retained targets cannot bypass project scope', async () => {
  const s = await f.scenario('project-scope');
  const other = await f.addConversation('other-project', { uri: `file://${f.directory}/other-project`, name: 'other-project' });
  const listed = await f.app.runtime.collaboration.listConversations({ turnId: s.turn('root') });
  assert.deepEqual(listed.conversations.map(row => row.conversationId), [s.outsider]);
  await assert.rejects(f.app.runtime.collaboration.readConversation({ conversationId: s.root, targetConversationId: other,
    crossConversationTurnId: s.turn('root') }), /different project/);
  await assert.rejects(f.app.runtime.collaboration.readConversation({ conversationId: s.root, targetConversationId: s.left,
    crossConversationTurnId: s.turn('root') }), /child task/);
  assert.equal((await f.rows('Turn', { conversation_id: other })).length, 0);
});

async function seedTranscript(conversationId, text) {
  const id = f.id('transcript'), body = await f.app.contentStore.ingest(f.app.database,
    JSON.stringify({ role: 'model', parts: [{ text }] }), 'application/vnd.limcode.message+json');
  await f.app.database.transaction([
    repo('Message').insert({ id, created_at: f.now(), updated_at: f.now(), deleted_at: null }),
    repo('MessageRevision').insert({ id: `${id}-revision`, message_id: id, revision_seq: 1n, role: 'model', content_object_id: body.id, created_at: f.now() }),
    repo('MessageCurrentRevisionLink').insert({ id: `${id}-current`, message_id: id, revision_id: `${id}-revision`, updated_at: f.now() }),
    repo('MessagePartOfConversation').insert({ id: `${id}-member`, conversation_id: conversationId, message_id: id, message_seq: 1n, created_at: f.now() })
  ]);
  return id;
}

test('a bounded peer transcript preview names a paged read that reconstructs long Chinese text', async () => {
  const s = await f.scenario('transcript-pages'), text = '中文正文😀'.repeat(6000);
  const messageId = await seedTranscript(s.outsider, text);
  const scope = { conversationId: s.root, targetConversationId: s.outsider, crossConversationTurnId: s.turn('root') };
  const preview = await f.app.runtime.collaboration.readConversation({ ...scope, limit: 1 });
  assert.equal(preview.messages[0].conversationMessageId ?? preview.messages[0].messageId, messageId);
  assert.ok(preview.messages[0].text.length < text.length);
  const chunks = [];
  for (let offset = 0; offset !== null;) {
    const page = await f.app.runtime.collaboration.readConversationMessage({ ...scope, messageId, offset });
    assert.equal(page.offset, offset);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 98304);
    chunks.push(page.text); offset = page.nextOffset;
  }
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), text);
});

test('a committed create_conversation retains its external settings after ACK loss and replay creates nothing new', async () => {
  const parent = await f.parentTurn('create-ack');
  const source = await f.source(parent.conversationId, parent.turnId, 'create_conversation', { prompt: 'Create one peer task', title: 'Created peer' });
  const command = { turnId: parent.turnId, toolCallId: source.toolCallId, sourceConversationId: parent.conversationId, prompt: 'Create one peer task', title: 'Created peer' };
  const plane = f.app.runtime.collaboration, original = plane.send;
  plane.send = async function(input) { await original.call(this, input); throw new Error('ACK lost after commit'); };
  try { await assert.rejects(f.lifecycle.createForCollaboration(command), /ACK lost/); } finally { plane.send = original; }
  const id = kernel.stablePhaseFId('conversation', 'cross-create', source.toolCallId);
  assert.ok(await f.get('Conversation', id));
  const copied = structuredClone(f.modelProfiles.get(id));
  assert.ok(copied);
  const replay = await f.lifecycle.createForCollaboration(command);
  assert.equal(replay.conversationId, id); assert.equal(replay.deduplicated, true);
  assert.equal((await f.rows('Conversation', { id })).length, 1);
  assert.deepEqual(f.modelProfiles.get(id), copied);
});

test('a peer followup chain inherits one origin budget and stops instead of opening another Turn', async () => {
  const s = await f.scenario('chain-budget', 2);
  const first = await s.send('root', 'outsider', 'followup', 'A asks B', { crossConversation: true, queueBehindActiveTurn: true });
  await f.endTurn(s.turn('outsider')); await f.endTurn(s.turn('root'));
  const bTurn = f.id('chain-b'); await f.continuation(s, s.outsider, bTurn, first.deliveryId);
  const back = await f.app.runtime.collaboration.send({ source: await f.source(s.outsider, bTurn, 'send_conversation_message'),
    targetConversationId: s.root, text: 'B asks A', mode: 'followup', crossConversation: true, queueBehindActiveTurn: true });
  await f.endTurn(bTurn);
  const aTurn = f.id('chain-a'); await f.continuation(s, s.root, aTurn, back.deliveryId);
  await assert.rejects(f.app.runtime.collaboration.send({ source: await f.source(s.root, aTurn, 'send_conversation_message'),
    targetConversationId: s.outsider, text: 'A cannot ask B again', mode: 'followup', crossConversation: true, queueBehindActiveTurn: true }), /budget exhausted \(2\)/);
  const requests = await Promise.all([first.messageId, back.messageId].map(async message_id => (await f.rows('CollaborationRequest', { message_id }))[0]));
  assert.equal(requests[0].budget_id, requests[1].budget_id);
  assert.equal((await f.get('CollaborationBudget', requests[0].budget_id)).origin_key, s.turn('root'));
});

test('root-contained local transfer succeeds while an outside symlink read is refused', localRootTransfer);
test('overwriting a symlink target preserves the external destination', overwriteSymlinkRefusal);
test('copying a directory into its own descendant is refused without partial changes', directorySelfRefusal);
test('the production remote bash guard refuses a relative symlink escape', remoteBashEscapeRefusal);

test('the writer rejects invalid RuntimeDelivery and RuntimeDeliveryWake state combinations at commit', async () => {
  const s = await f.scenario('delivery-invariants', 4);
  const queued = await s.send('root', 'outsider', 'followup', 'Queued peer task', {
    crossConversation: true,
    queueBehindActiveTurn: true
  });

  await assert.rejects(
    f.app.database.transaction([
      repo('RuntimeDelivery').update(queued.deliveryId, { state: 'consumed', updated_at: f.now() })
    ]),
    /requires target_turn_id and exactly one RuntimeDeliveryInputLink/
  );
  await assert.rejects(
    f.app.database.transaction([
      repo('RuntimeDelivery').update(queued.deliveryId, {
        state: 'consumed',
        target_turn_id: s.turn('outsider'),
        updated_at: f.now()
      })
    ]),
    /requires target_turn_id and exactly one RuntimeDeliveryInputLink/
  );
  await assert.rejects(
    f.app.database.transaction([
      repo('RuntimeDelivery').update(queued.deliveryId, { state: 'failed', failure_reason: null, updated_at: f.now() })
    ]),
    /requires failure_reason/
  );

  const [wake] = await f.rows('RuntimeDeliveryWake', { delivery_id: queued.deliveryId });
  assert.ok(wake);
  await assert.rejects(
    f.app.database.transaction([
      repo('RuntimeDeliveryWake').insert({
        ...wake,
        id: f.id('invalid-wake-insert'),
        delivery_id: f.id('nonexistent-delivery'),
        state: 'acknowledged',
        acknowledged_at: null
      })
    ]),
    /requires acknowledged_at/
  );
  await f.app.database.transaction([
    repo('RuntimeDeliveryWake').update(wake.id, {
      state: 'claimed',
      claim_owner_host_boot_id: f.app.database.hostBootId,
      claim_generation: 1n,
      claim_expires_at: new Date(Date.now() + 60000).toISOString(),
      attempt_count: 1n,
      updated_at: f.now()
    })
  ]);
  await assert.rejects(
    f.app.database.transaction([
      repo('RuntimeDeliveryWake').update(wake.id, {
        state: 'acknowledged',
        claim_owner_host_boot_id: null,
        claim_expires_at: null,
        acknowledged_at: null,
        updated_at: f.now()
      })
    ]),
    /requires acknowledged_at/
  );

  const intact = await f.get('RuntimeDelivery', queued.deliveryId);
  assert.equal(intact.state, 'pending');
  assert.equal(intact.phase, 'next_turn');
  assert.equal(intact.target_turn_id, null);
});

test('startup deterministically repairs externally corrupted consumed next_turn deliveries without masking projection errors', async () => {
  assert.throws(
    () => deriveCommittedParentHandling({ id: 'corrupted-row', state: 'consumed', phase: 'next_turn' }, undefined),
    /invalid InputLink combination/
  );

  const local = await openDeliveryFixture();
  try {
    const s = await local.scenario('external-sql-corruption', 4);
    const corrupted = await s.send('root', 'outsider', 'followup', 'Corrupted while queued', {
      crossConversation: true,
      queueBehindActiveTurn: true
    });
    const injected = await s.send('root', 'outsider', 'followup', 'Backed by real input link', {
      crossConversation: true,
      queueBehindActiveTurn: true
    });
    await local.endTurn(s.turn('outsider'));
    const nextTurn = local.id('outsider-admitted');
    await local.continuation(s, s.outsider, nextTurn, injected.deliveryId);

    const binding = await local.root.current();
    await local.deactivateRunner();
    await local.coordinator.dispose();
    await local.app.close();

    const rawDb = new Database(binding.paths.databasePath);
    try {
      rawDb.prepare("UPDATE runtime_delivery SET state = 'consumed' WHERE id = ? AND state = 'pending'").run(corrupted.deliveryId);
      rawDb.prepare("UPDATE runtime_delivery_wake SET state = 'acknowledged' WHERE delivery_id = ? AND state != 'acknowledged'").run(corrupted.deliveryId);
      rawDb.prepare('UPDATE runtime_delivery SET target_turn_id = NULL WHERE id = ?').run(injected.deliveryId);
    } finally {
      rawDb.close();
    }

    await local.reopen();
    await local.app.runtime.collaboration.reconcile();

    const repairedFailed = await local.get('RuntimeDelivery', corrupted.deliveryId);
    assert.equal(repairedFailed.state, 'failed');
    assert.equal(repairedFailed.target_turn_id, null);
    assert.equal(repairedFailed.failure_reason, CORRUPTED_CONSUMED_DELIVERY_REASON);

    const [repairedWake] = await local.rows('RuntimeDeliveryWake', { delivery_id: corrupted.deliveryId });
    assert.equal(repairedWake.state, 'dead_letter');
    assert.equal(repairedWake.acknowledged_at, null);
    assert.equal(repairedWake.last_error, CORRUPTED_CONSUMED_DELIVERY_REASON);

    const [failedRequest] = await local.rows('CollaborationRequest', { message_id: corrupted.messageId });
    assert.equal(failedRequest.state, 'failed');

    const repairedInjected = await local.get('RuntimeDelivery', injected.deliveryId);
    assert.equal(repairedInjected.state, 'consumed');
    assert.equal(repairedInjected.target_turn_id, nextTurn);

    const outsiderSnapshot = await local.app.database.clientProjectionSnapshot(s.outsider);
    const rootSnapshot = await local.app.database.clientProjectionSnapshot(s.root);
    const stringify = value => JSON.stringify(value, (_k, v) => typeof v === 'bigint' ? v.toString() : v);
    assert.ok(stringify(outsiderSnapshot).includes(corrupted.deliveryId));
    assert.ok(stringify(outsiderSnapshot).includes(injected.deliveryId));
    assert.ok(stringify(rootSnapshot).includes(s.root));

    const updatedStamp = repairedFailed.updated_at;
    await local.reopen();
    assert.equal((await local.get('RuntimeDelivery', corrupted.deliveryId)).updated_at, updatedStamp);
  } finally {
    await local.close();
  }
});
