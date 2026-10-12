import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = (file) => require(path.join(compiled, file));
const kernel = load('backend/reliableKernel/index.js');
const { emptyConversationContextHandleStateStep } = load('backend/reliableKernel/conversationContextHandleState.js');
const { runWithExecutionLeaseFence } = load('backend/reliableKernel/executionLeaseFence.js');
const { CHILD_CONVERSATION_DELETED_NOTICE } = load('backend/reliableKernel/deliverySettlementSteps.js');
const { stopAndDeleteConversation } = load('backend/application/reliableKernel/conversationDeleteCommand.js');
const repo = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);
const insert = (name, value) => repo(name).insert(value);
const timestamp = (f) => f.now?.() ?? new Date().toISOString();
const get = async (f, name, id) => (await f.app.database.snapshot([repo(name).get(id)])).snapshot[0];
const rows = async (f, name, where) => (await f.app.database.snapshotAll(repo(name).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;

async function createConversation(f, id) {
  const now = timestamp(f);
  await f.app.database.transaction([
    insert('Conversation', { id, title: id, status: 'active', created_at: now, updated_at: now }),
    emptyConversationContextHandleStateStep(id, now),
    insert('AgentConversationLink', { id: `${id}-agent`, conversation_id: id, agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now })
  ]);
}

function inputCommand(f, conversationId, key) {
  return { source: { kind: 'command', key }, conversationId, content: key,
    leaseOwnerId: f.runner.leaseOwnerId, hostBootId: f.app.database.hostBootId,
    leaseExpiresAt: new Date(Date.parse(timestamp(f)) + 60_000).toISOString() };
}

async function admit(f, conversationId, key = `${conversationId}-input`) {
  return f.app.turns.input(inputCommand(f, conversationId, key));
}

async function admitChild(f, conversationId, key = `${conversationId}-input`) {
  return f.app.turns.input({ ...inputCommand(f, conversationId, key), leaseOwnerId: f.coordinator.childLeaseOwnerId });
}

async function fenced(f, turnId, work) {
  const lease = (await rows(f, 'ExecutionLease', { turn_id: turnId }))[0];
  assert.ok(lease, `missing execution lease for ${turnId}`);
  return runWithExecutionLeaseFence({ id: lease.id, conversationId: lease.conversation_id, turnId,
    ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation) }, work);
}

function command(f, conversationId, requestId, options = {}) {
  return stopAndDeleteConversation({ application: f.app, conversations: f.runner, childAgents: f.coordinator,
    pollMs: 0, timeoutMs: 2000, ...options }, { conversationId, requestId });
}

async function controlOnly(f, work) {
  const owners = f.app.database.conversationOwners;
  const eligibility = owners.executionEligibility;
  owners.executionEligibility = async () => 'ineligible';
  try { return await work(); }
  finally { owners.executionEligibility = eligibility; }
}

function childRows(f, { id, conversationId, turnId, parentConversationId, parentTurnId, parentChildExecutionId = null, active = false }) {
  const now = timestamp(f);
  return [
    insert('ConversationOriginLink', { id: `${id}-origin`, conversation_id: conversationId, source_conversation_id: parentConversationId,
      source_turn_id: parentTurnId, source_tool_call_id: `${id}-spawn`, source_message_revision_id: null, created_at: now }),
    insert('ChildExecution', { id, child_conversation_id: conversationId, status: active ? 'active' : 'idle', created_at: now, updated_at: now }),
    insert('ChildExecutionParentLink', { id: `${id}-parent`, child_execution_id: id, parent_turn_id: parentTurnId,
      parent_child_execution_id: parentChildExecutionId, source_tool_call_id: `${id}-spawn`, created_at: now }),
    insert('ChildExecutionTurnLink', { id: `${id}-turn`, child_execution_id: id, turn_id: turnId, turn_seq: 1n, created_at: now }),
    insert('AnswerBridge', { id: `${id}-bridge`, child_execution_id: id, current_submission_id: null, status: 'open', created_at: now, updated_at: now }),
    ...(active ? [insert('ChildExecutionActiveTurnLink', { id: `${id}-active`, child_execution_id: id, turn_id: turnId, updated_at: now })] : [])
  ];
}

async function stoppedChild(f, prefix, parentConversationId, parentTurnId) {
  const conversationId = `${prefix}-child`;
  const turnId = `${prefix}-child-turn`;
  const id = `${prefix}-execution`;
  const now = timestamp(f);
  await createConversation(f, conversationId);
  await f.app.database.transaction([
    insert('Turn', { id: turnId, conversation_id: conversationId, status: 'terminated', created_at: now, updated_at: now, terminal_at: now }),
    ...childRows(f, { id, conversationId, turnId, parentConversationId, parentTurnId })
  ]);
  return { id, conversationId, turnId, answerBridgeId: `${id}-bridge` };
}

async function answerDelivery(f, prefix) {
  const parentConversationId = `${prefix}-parent`;
  await createConversation(f, parentConversationId);
  const parent = await admit(f, parentConversationId);
  const child = await stoppedChild(f, prefix, parentConversationId, parent.turnId);
  const now = timestamp(f);
  const body = await f.app.contentStore.ingest(f.app.database, `${prefix}-SECRET_CHILD_ANSWER`, 'text/plain');
  const submissionId = `${prefix}-submission`;
  const inboxItemId = `${prefix}-inbox`;
  const deliveryId = `${prefix}-delivery`;
  await f.app.database.transaction([
    insert('AnswerSubmission', { id: submissionId, answer_bridge_id: child.answerBridgeId, submission_seq: 1n, turn_id: child.turnId, interrupted: 0n, created_at: now }),
    insert('AnswerPayload', { id: `${prefix}-payload`, submission_id: submissionId, title: 'SECRET_CHILD_ANSWER_TITLE', content_object_id: body.id,
      byte_length: BigInt(body.byte_length), created_at: now }),
    repo('AnswerBridge').update(child.answerBridgeId, { current_submission_id: submissionId, updated_at: now }),
    insert('RuntimeInboxItem', { id: inboxItemId, dedupe_key: inboxItemId, source_kind: 'answer_submission', source_id: submissionId, state: 'available', created_at: now, updated_at: now }),
    insert('RuntimeInboxPayloadLink', { id: `${prefix}-inbox-payload`, inbox_item_id: inboxItemId, content_object_id: body.id, created_at: now }),
    insert('RuntimeDelivery', { id: deliveryId, inbox_item_id: inboxItemId, target_conversation_id: parentConversationId, target_turn_id: parent.turnId,
      phase: 'current_turn', attempt_seq: 1n, retry_of_delivery_id: null, state: 'pending', failure_reason: null, created_at: now, updated_at: now })
  ]);
  return { parent, parentConversationId, child, submissionId, deliveryId };
}

async function verifyNoticeAndContinue(f, setup, inputId) {
  const input = await get(f, 'PendingTurnInput', inputId);
  const metadata = await get(f, 'ContentObject', input.content_object_id);
  const bytes = await f.app.contentStore.read(metadata);
  const projection = await f.app.runtime.deliveries.projectInputForModel({ pendingTurnInputId: input.id,
    contentObjectId: metadata.id, contentType: metadata.content_type, content: bytes });
  assert.equal(projection.envelope.kind, 'child_failure');
  assert.equal(projection.envelope.content, CHILD_CONVERSATION_DELETED_NOTICE);
  assert.equal(projection.envelope.title, setup.child.conversationId);
  assert.equal(projection.content.includes('SECRET_CHILD_ANSWER'), false);
  assert.equal((await get(f, 'Turn', setup.parent.turnId)).status, 'active');
  const drive = await fenced(f, setup.parent.turnId, () => f.app.agentLoop.drive(setup.parent.turnId));
  assert.equal(drive.terminalStatus, 'completed');
  assert.equal((await get(f, 'Turn', setup.parent.turnId)).status, 'terminated');
  assert.equal((await get(f, 'PendingTurnInput', inputId)).state, 'consumed');
  const sources = await rows(f, 'ContextSegmentSource', { source_kind: 'runtime_context', source_id: inputId });
  assert.equal(sources.length, 1);
  const segment = await get(f, 'ContextSegment', sources[0].segment_id);
  const context = (await f.app.contentStore.read(await get(f, 'ContentObject', segment.content_object_id))).toString();
  assert.ok(context.includes(CHILD_CONVERSATION_DELETED_NOTICE));
  assert.equal(context.includes('SECRET_CHILD_ANSWER'), false);
}

export async function queueCancellationBeforeStop(f) {
  const id = 'delete-queue-order';
  await createConversation(f, id);
  const first = await admit(f, id);
  const queued = await admit(f, id, `${id}-second-input`);
  assert.equal((await get(f, 'TurnIntent', queued.intentId)).state, 'queued');
  const turns = f.app.turns;
  const cancel = turns.cancelGuidanceForDeletion;
  const request = turns.requestExternalInterrupt;
  const admission = turns.admitNextQueued;
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const permit = new Promise((resolve) => { release = resolve; });
  const order = [];
  let admissionReads = 0;
  turns.cancelGuidanceForDeletion = async (...args) => { enter(); await permit; const result = await cancel.apply(turns, args); order.push('cancel-committed'); return result; };
  turns.requestExternalInterrupt = async (...args) => { order.push('stop-request'); return request.apply(turns, args); };
  turns.admitNextQueued = async (...args) => { admissionReads += 1; return admission.apply(turns, args); };
  try {
    await controlOnly(f, async () => {
      const deleting = command(f, id, `${id}-delete`);
      await entered;
      assert.equal(f.app.conversationDeletion.isStopping(id), true);
      await f.runner.runOwnedAdmissionSlot({ conversationId: id, requestedGeneration: 1n, completedGeneration: 0n });
      assert.equal(admissionReads, 0, 'deletion blocks queued admission before any worker attempt');
      assert.deepEqual(order, [], 'nothing stops before cancellation commits');
      assert.equal((await get(f, 'Turn', first.turnId)).status, 'active');
      release();
      assert.deepEqual((await deleting).deletedConversationIds, [id]);
      assert.equal(order[0], 'cancel-committed');
      assert.ok(order.includes('stop-request'));
      assert.equal(await get(f, 'TurnIntent', queued.intentId), null);
    });
  } finally {
    release();
    turns.cancelGuidanceForDeletion = cancel;
    turns.requestExternalInterrupt = request;
    turns.admitNextQueued = admission;
    f.runner.clearAdmissionRetry(id);
  }
}

export async function pendingAnswerDeletionNotice(f) {
  const setup = await answerDelivery(f, 'delete-pending-answer');
  assert.equal((await get(f, 'RuntimeDelivery', setup.deliveryId)).state, 'pending');
  assert.deepEqual((await command(f, setup.child.conversationId, 'delete-pending-answer-command')).deletedConversationIds, [setup.child.conversationId]);
  assert.equal((await get(f, 'RuntimeDelivery', setup.deliveryId)).state, 'consumed');
  assert.equal(await get(f, 'AnswerSubmission', setup.submissionId), null);
  const links = await rows(f, 'RuntimeDeliveryInputLink', { delivery_id: setup.deliveryId });
  assert.equal(links.length, 1);
  await verifyNoticeAndContinue(f, setup, links[0].pending_turn_input_id);
}

export async function consumedAnswerDeletionNotice(f) {
  const setup = await answerDelivery(f, 'delete-consumed-answer');
  await f.app.runtime.deliveries.advance(setup.deliveryId, { boundaryTurnId: setup.parent.turnId });
  const [link] = await rows(f, 'RuntimeDeliveryInputLink', { delivery_id: setup.deliveryId });
  assert.ok(link);
  const before = await get(f, 'PendingTurnInput', link.pending_turn_input_id);
  assert.equal(before.state, 'pending');
  assert.equal((await get(f, 'RuntimeDelivery', setup.deliveryId)).state, 'consumed');
  await command(f, setup.child.conversationId, 'delete-consumed-answer-command');
  const after = await get(f, 'PendingTurnInput', before.id);
  assert.equal(after.state, 'pending');
  assert.notEqual(after.content_object_id, before.content_object_id);
  assert.equal(await get(f, 'AnswerSubmission', setup.submissionId), null);
  await verifyNoticeAndContinue(f, setup, before.id);
}

export async function backgroundChildDeletion(f) {
  const parentId = 'delete-background-parent';
  const childId = 'delete-background-child';
  await createConversation(f, parentId);
  await createConversation(f, childId);
  const now = timestamp(f);
  const parentTurn = 'delete-background-parent-turn';
  await f.app.database.transaction([
    insert('Turn', { id: parentTurn, conversation_id: parentId, status: 'terminated', created_at: now, updated_at: now, terminal_at: now }),
    insert('TurnTermination', { id: `${parentTurn}-termination`, turn_id: parentTurn, terminal_status: 'completed', reason: 'parent finished', created_at: now })
  ]);
  const child = await admitChild(f, childId);
  const executionId = 'delete-background-execution';
  await f.app.database.transaction(childRows(f, { id: executionId, conversationId: childId, turnId: child.turnId,
    parentConversationId: parentId, parentTurnId: parentTurn, active: true }));
  const inventory = await f.app.conversationDeletion.inspect(childId);
  assert.equal(inventory.rootChildDetached, true);
  let panelStops = 0, subtreeStops = 0;
  const panel = f.coordinator.interruptFromConversation;
  const subtree = f.coordinator.interruptSubtree;
  f.coordinator.interruptFromConversation = async function (...args) { panelStops += 1; return panel.apply(this, args); };
  f.coordinator.interruptSubtree = async function (...args) { subtreeStops += 1; return subtree.apply(this, args); };
  try {
    await controlOnly(f, async () => {
      assert.deepEqual((await command(f, childId, 'delete-background-command')).deletedConversationIds, [childId]);
    });
  } finally { f.coordinator.interruptFromConversation = panel; f.coordinator.interruptSubtree = subtree; }
  assert.equal(panelStops, 1);
  assert.equal(subtreeStops, 0, 'the detached task uses its own panel stop');
  assert.deepEqual((await rows(f, 'Turn', { conversation_id: parentId })).map((value) => value.id), [parentTurn]);
  assert.deepEqual(await rows(f, 'TurnIntent', { conversation_id: parentId, state: 'queued' }), []);
  assert.deepEqual(await rows(f, 'RuntimeDelivery', { target_conversation_id: parentId, state: 'pending' }), []);
}

export async function stopWholeTree(f) {
  const parentId = 'delete-tree-parent', childId = 'delete-tree-child', grandchildId = 'delete-tree-grandchild';
  await createConversation(f, parentId);
  await createConversation(f, childId);
  await createConversation(f, grandchildId);
  const parent = await admit(f, parentId);
  const child = await admitChild(f, childId);
  const grandchild = await admitChild(f, grandchildId);
  await f.app.database.transaction([
    ...childRows(f, { id: 'delete-tree-child-execution', conversationId: childId, turnId: child.turnId, parentConversationId: parentId, parentTurnId: parent.turnId, active: true }),
    ...childRows(f, { id: 'delete-tree-grandchild-execution', conversationId: grandchildId, turnId: grandchild.turnId, parentConversationId: childId,
      parentTurnId: child.turnId, parentChildExecutionId: 'delete-tree-child-execution', active: true })
  ]);
  const queued = await admitChild(f, grandchildId, 'delete-tree-grandchild-queued');
  const events = [];
  const request = f.app.turns.requestExternalInterrupt;
  const cancel = f.app.turns.cancelGuidanceForDeletion;
  const subtree = f.coordinator.interruptSubtree;
  const interrupt = f.runner.interrupt;
  f.app.turns.cancelGuidanceForDeletion = async function (...args) { const result = await cancel.apply(this, args); events.push('queue-cancelled'); return result; };
  f.app.turns.requestExternalInterrupt = async function (...args) { const result = await request.apply(this, args); events.push(`request:${args[1].turnId}`); return result; };
  f.coordinator.interruptSubtree = async function (...args) { events.push('child-subtree'); return subtree.apply(this, args); };
  f.runner.interrupt = async function (...args) { events.push('parent-stop'); return interrupt.apply(this, args); };
  try {
    await controlOnly(f, async () => {
      assert.deepEqual((await command(f, parentId, 'delete-tree-command')).deletedConversationIds, [grandchildId, childId, parentId]);
    });
  } finally {
    f.app.turns.requestExternalInterrupt = request;
    f.app.turns.cancelGuidanceForDeletion = cancel;
    f.coordinator.interruptSubtree = subtree;
    f.runner.interrupt = interrupt;
  }
  assert.equal(events[0], 'queue-cancelled');
  assert.ok(events.indexOf(`request:${parent.turnId}`) < events.indexOf('child-subtree'));
  assert.ok(events.indexOf('child-subtree') < events.indexOf('parent-stop'));
  assert.equal(events.filter((value) => value === 'child-subtree').length, 1, 'only the outermost subtree is stopped');
  assert.equal(await get(f, 'TurnIntent', queued.intentId), null);
  assert.equal(await get(f, 'ChildExecution', 'delete-tree-child-execution'), null);
  assert.equal(await get(f, 'ChildExecution', 'delete-tree-grandchild-execution'), null);
}

export async function timeoutPreservesThenRetry(f) {
  const id = 'delete-timeout';
  await createConversation(f, id);
  const started = await admit(f, id);
  const stopped = await command(f, id, 'delete-timeout-first', { timeoutMs: 0,
    conversations: { async interrupt() {} } }).then(() => null, (error) => error);
  assert.equal(stopped.code, 'conversation-delete-incomplete');
  assert.ok(stopped.remaining.some((value) => value.kind === 'turn' && value.id === started.turnId && value.stopRequested));
  assert.equal((await get(f, 'Turn', started.turnId)).status, 'active');
  assert.ok(await get(f, 'Conversation', id));
  assert.equal(f.app.conversationDeletion.isStopping(id), false, 'timeout releases the in-memory admission mark');
  assert.equal((await rows(f, 'PendingTurnInput', { turn_id: started.turnId, input_kind: 'interrupt_request', state: 'pending' })).length, 1);
  await fenced(f, started.turnId, () => f.app.agentLoop.terminateRequested(started.turnId));
  assert.deepEqual((await command(f, id, 'delete-timeout-retry')).deletedConversationIds, [id]);
  assert.equal(await get(f, 'Conversation', id), null);
}

export async function writerDeletionAtomicRefusal(f) {
  const parentId = 'delete-atomic-parent';
  await createConversation(f, parentId);
  const now = timestamp(f);
  const parentTurn = 'delete-atomic-parent-turn';
  await f.app.database.transaction([insert('Turn', { id: parentTurn, conversation_id: parentId, status: 'terminated', created_at: now, updated_at: now, terminal_at: now })]);
  const child = await stoppedChild(f, 'delete-atomic', parentId, parentTurn);
  const forkId = 'delete-atomic-fork';
  await createConversation(f, forkId);
  await f.app.database.transaction([insert('ConversationOriginLink', { id: 'delete-atomic-fork-origin', conversation_id: forkId,
    source_conversation_id: parentId, source_turn_id: null, source_tool_call_id: null, source_message_revision_id: null, created_at: now })]);
  const deletion = f.app.conversationDeletion;
  const notice = deletion.parentNoticeSteps;
  deletion.parentNoticeSteps = async function (...args) {
    await f.app.database.transaction([insert('Turn', { id: 'delete-atomic-raced-turn', conversation_id: child.conversationId,
      status: 'active', created_at: now, updated_at: now, terminal_at: null })]);
    return notice.apply(this, args);
  };
  try {
    await assert.rejects(deletion.delete(parentId), /assertNone|transaction assert/);
  } finally { deletion.parentNoticeSteps = notice; }
  assert.ok(await get(f, 'Conversation', parentId));
  assert.ok(await get(f, 'Conversation', child.conversationId));
  assert.ok(await get(f, 'Conversation', forkId));
  assert.ok(await get(f, 'ChildExecution', child.id));
  await f.app.database.transaction([repo('Turn').update('delete-atomic-raced-turn', { status: 'terminated', terminal_at: now, updated_at: now })]);
  assert.deepEqual((await deletion.delete(parentId)).deletedConversationIds, [child.conversationId, parentId]);
  assert.ok(await get(f, 'Conversation', forkId), 'ordinary forks stay outside the child tree');
}

export async function durableStopRecovery(f) {
  const id = 'delete-stop-recovery';
  await createConversation(f, id);
  const started = await admit(f, id);
  const terminate = f.app.agentLoop.terminateRequested;
  const previousErrors = f.errors.length;
  let attempts = 0;
  f.app.agentLoop.terminateRequested = async function (...args) {
    attempts += 1;
    if (attempts === 1) throw new Error('stop fixture terminal I/O failed once');
    return terminate.apply(this, args);
  };
  try {
    await controlOnly(f, async () => {
      const result = await f.runner.interrupt({ commandId: 'delete-stop-recovery-request', conversationId: id, turnId: started.turnId, reason: '用户停止' });
      assert.equal(result.turnId, started.turnId);
      assert.equal(attempts, 1);
      assert.equal((await get(f, 'Turn', started.turnId)).status, 'active');
      assert.equal((await rows(f, 'PendingTurnInput', { turn_id: started.turnId, input_kind: 'interrupt_request', state: 'pending' })).length, 1);
      const pending = f.runner.deferredRecovery.get(started.turnId);
      assert.ok(pending, 'the durable stop retains a recovery candidate after the terminal write failed');
      // Advance the scheduled candidate directly; the production polling path performs the retry.
      pending.nextAttemptAt = 0;
      await f.runner.pollExternalWakes();
      await f.runner.waitForIdle();
      assert.equal((await get(f, 'Turn', started.turnId)).status, 'terminated');
      assert.equal((await rows(f, 'TurnTermination', { turn_id: started.turnId }))[0].terminal_status, 'interrupted');
      assert.equal(attempts, 2);
      assert.deepEqual(await rows(f, 'PendingTurnInput', { turn_id: started.turnId, input_kind: 'interrupt_request', state: 'pending' }), []);
      assert.deepEqual(f.errors.slice(previousErrors).map((error) => error.message), ['stop fixture terminal I/O failed once']);
      f.errors.splice(previousErrors, 1);
    });
  } finally { f.app.agentLoop.terminateRequested = terminate; }
}
