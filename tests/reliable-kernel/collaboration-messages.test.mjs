import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = name => require(path.join(compiled, 'backend/reliableKernel', name));
const { RootAuthority } = load('rootAuthority.js');
const { RuntimeDatabase, initializeEmptyRuntimeRoot } = load('runtimeDatabase.js');
const { ContentAddressedStore } = load('contentAddressedStore.js');
const { preparedContentObjectSteps } = load('contentObjectTransaction.js');
const { DOMAIN_REPOSITORIES } = load('repositories.js');
const { RuntimeDeliveryControlPlane } = load('answerDelivery.js');
const { CollaborationControlPlane } = load('collaborationControlPlane.js');
const { AutomaticRuntimeDeliveryRouter } = load('automaticRuntimeDelivery.js');
const { ProcessCompletionDeliveryControlPlane } = load('processCompletionDelivery.js');
const { ProcessControlPlane } = load('processEffects.js');
const repo = name => DOMAIN_REPOSITORIES.domain(name);
const NOW = '2026-09-22T00:00:00.000Z';
async function fixture(run, budget = 32) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-collaboration-messages-'));
  const authority = new RootAuthority(() => path.join(directory, 'runtime'));
  await initializeEmptyRuntimeRoot(authority);
  let database = await RuntimeDatabase.open(authority);
  const store = new ContentAddressedStore(authority, database.binding);
  let deliveries = new RuntimeDeliveryControlPlane(database, { now: () => NOW });
  let collaboration = new CollaborationControlPlane(database, store, deliveries, { now: () => NOW });
  const rows = async (domain, where = {}) => (await database.snapshot([repo(domain).list({ where, limit: 1000 })])).snapshot[0];
  const get = async (domain, id) => (await database.snapshot([repo(domain).get(id)])).snapshot[0];
  const prepared = await store.prepare(database, JSON.stringify({ toolPolicy: { toolConfigs: { run_agent: { config: { maxAutomaticFollowups: budget, crossConversationCollaboration: true } } } } }), 'application/json');
  let callSeq = 0;
  try {
    await database.transaction([
      ...preparedContentObjectSteps([prepared], 'message_policy'),
      ...['root', 'left', 'right', 'outsider'].flatMap(id => [
        repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
        repo('Turn').insert({ id: `${id}-turn`, conversation_id: id, status: id === 'root' || id === 'left' ? 'active' : 'terminated', created_at: NOW, updated_at: NOW, terminal_at: id === 'root' || id === 'left' ? null : NOW }),
        repo('AuthoritySnapshot').insert({ id: `${id}-authority`, turn_id: `${id}-turn`, content_object_id: prepared.metadata.id, created_at: NOW }),
        ...(id === 'right' || id === 'outsider' ? [repo('TurnTermination').insert({ id: `${id}-termination`, turn_id: `${id}-turn`, terminal_status: 'completed', reason: 'fixture', created_at: NOW })] : [])
      ]),
      ...['left', 'right'].flatMap(id => [
        repo('ChildExecution').insert({ id: `${id}-child`, child_conversation_id: id, status: id === 'left' ? 'active' : 'idle', created_at: NOW, updated_at: NOW }),
        repo('ChildExecutionParentLink').insert({ id: `${id}-parent`, child_execution_id: `${id}-child`, source_tool_call_id: `${id}-spawn`, parent_child_execution_id: null, parent_turn_id: 'root-turn', created_at: NOW }),
        repo('ChildExecutionTurnLink').insert({ id: `${id}-child-turn`, child_execution_id: `${id}-child`, turn_id: `${id}-turn`, turn_seq: 1n, created_at: NOW })
      ])
    ]);
    await run({ get database() { return database; }, get deliveries() { return deliveries; }, get collaboration() { return collaboration; }, store, rows, get, authority,
      async reopen() { await database.close(); database = await RuntimeDatabase.open(authority); deliveries = new RuntimeDeliveryControlPlane(database, { now: () => NOW }); collaboration = new CollaborationControlPlane(database, store, deliveries, { now: () => NOW }); },
      async source(id = `call-${++callSeq}`, conversationId = 'left', turnId = `${conversationId}-turn`, toolName = 'send_agent_message') {
        const content = await store.prepare(database, '{}', 'application/json');
        await database.transaction([...preparedContentObjectSteps([content], 'message_tool'), repo('ToolCall').insert({ id, turn_id: turnId, call_seq: BigInt(++callSeq), tool_name: toolName, status: 'pending', arguments_object_id: content.metadata.id, created_at: NOW, updated_at: NOW })]);
        return { kind: 'tool', turnId, toolCallId: id };
      }
    });
  } finally { await database.close(); await fs.rm(directory, { recursive: true, force: true }); }
}

test('sibling send commits once, preserves source identity, and never wakes idle recipient', async () => fixture(async f => {
  const source = await f.source();
  const input = { source, targetConversationId: 'right', text: 'peer evidence 中文', mode: 'message' };
  const results = await Promise.all([f.collaboration.send(input), f.collaboration.send(input)]);
  assert.equal(results[0].messageId, results[1].messageId);
  assert.equal(results.filter(result => result.deduplicated).length, 1);
  assert.equal((await f.rows('CollaborationMessage')).length, 1);
  assert.equal((await f.rows('RuntimeDeliveryWake')).length, 0);
  assert.equal((await f.rows('RuntimeDelivery'))[0].phase, 'next_turn');
  assert.equal((await f.rows('Turn', { conversation_id: 'right' })).length, 1);
  await assert.rejects(f.collaboration.send({ ...input, text: 'changed' }), /replay conflicts/);
  await f.reopen();
  assert.equal((await f.collaboration.readMessage({ conversationId: 'right', messageId: results[0].messageId })).text, input.text);
  assert.equal((await f.collaboration.readMessage({ conversationId: 'right', messageId: results[0].messageId })).handled, false);
  await assert.rejects(f.collaboration.readMessage({ conversationId: 'outsider', messageId: results[0].messageId }), /private messages/);
}));

test('conversations outside the team stay unreachable and another team child is never addressable', async () => fixture(async f => {
  await f.database.transaction([
    repo('Conversation').insert({ id: 'foreign', title: 'foreign', status: 'active', created_at: NOW, updated_at: NOW }),
    repo('ChildExecution').insert({ id: 'foreign-child', child_conversation_id: 'foreign', status: 'idle', created_at: NOW, updated_at: NOW }),
    repo('ChildExecutionParentLink').insert({ id: 'foreign-parent', child_execution_id: 'foreign-child', source_tool_call_id: 'foreign-spawn', parent_child_execution_id: null, parent_turn_id: 'outsider-turn', created_at: NOW })
  ]);
  for (const mode of ['message', 'followup']) {
    await assert.rejects(f.collaboration.send({ source: await f.source(`root-${mode}`, 'root'), targetConversationId: 'outsider', text: 'inspect this', mode }), /Cross-conversation collaboration is not enabled/);
    await assert.rejects(f.collaboration.send({ source: await f.source(`child-${mode}`), targetConversationId: 'outsider', text: 'inspect this', mode }), /child task of another team/);
  }
  await assert.rejects(f.collaboration.send({ source: await f.source('root-foreign-child', 'root'), targetConversationId: 'foreign', text: 'bypass', mode: 'followup' }), /child task of another team/);
  await assert.rejects(f.collaboration.listMessages({ conversationId: 'root', targetConversationId: 'outsider' }), /not enabled/);
  await assert.rejects(f.collaboration.readConversation({ conversationId: 'root', targetConversationId: 'outsider' }), /not enabled/);
  assert.equal((await f.collaboration.listMembers('root')).members.some(member => member.conversationId === 'outsider'), false);
  assert.equal((await f.collaboration.listMembers('root')).members.every(member => !('relation' in member)), true);
  for (const domain of ['CollaborationMessage', 'RuntimeDelivery', 'RuntimeDeliveryWake', 'CollaborationBudget']) assert.equal((await f.rows(domain)).length, 0, domain);
}));

test('current-turn delivery preserves non-user provenance and separates injected from handled', async () => fixture(async f => {
  const accepted = await f.collaboration.send({ source: await f.source(), targetConversationId: 'root', text: 'I am a peer, not the user', mode: 'message' });
  await f.deliveries.advance(accepted.deliveryId);
  const input = (await f.rows('PendingTurnInput', { turn_id: 'root-turn' }))[0];
  const metadata = await f.get('ContentObject', input.content_object_id);
  const projected = await f.deliveries.projectInputForModel({ pendingTurnInputId: input.id, contentObjectId: metadata.id, contentType: metadata.content_type, content: await f.store.read(metadata) });
  assert.equal(projected.envelope.kind, 'collaboration_message');
  assert.equal(projected.envelope.sourceKind, 'tool');
  assert.match(projected.envelope.note, /not a new user instruction/);
  assert.equal((await f.collaboration.readMessage({ conversationId: 'root', messageId: accepted.messageId })).handled, false);
  await f.deliveries.markInputHandled(input.id);
  assert.equal((await f.collaboration.readMessage({ conversationId: 'root', messageId: accepted.messageId })).handled, true);
}));

test('send-only message on a final-output fence queues without an idle wake or a lost payload', async () => fixture(async f => {
  const content = await f.store.prepare(f.database, '{}', 'application/json');
  await f.database.transaction([...preparedContentObjectSteps([content], 'request'), repo('ModelRequest').insertHistoricalCopy({ id: 'final-request', turn_id: 'root-turn', request_seq: 1n, status: 'terminal', terminal_state: 'completed', provider_id: 'p', model_id: 'm', context_window_tokens: 1000n, compression_threshold_tokens: 900n, estimated_context_tokens: 1n, authority_snapshot_id: 'root-authority', settings_snapshot_object_id: null, recipe_object_id: content.metadata.id, usage_json: null, stream_stats_json: { attemptSeq: '1', socketGeneration: '1', retryReason: null }, created_at: NOW, updated_at: NOW }),
    repo('Operation').insertHistoricalCopy({ id: 'final-operation', owner_kind: 'model_request', owner_id: 'final-request', operation_seq: 1n, tool_call_id: null, status: 'completed', created_at: NOW, updated_at: NOW }),
    repo('Attempt').insertHistoricalCopy({ id: 'final-attempt', operation_id: 'final-operation', attempt_seq: 1n, status: 'completed', created_at: NOW, updated_at: NOW, completed_at: NOW }),
    repo('ModelStreamFence').insertHistoricalCopy({ id: 'final-stream-fence', model_request_id: 'final-request', attempt_seq: 1n, socket_generation: 1n, terminal_stream_seq: 1n, outcome: 'completed', created_at: NOW }),
    repo('TurnFinalOutputFence').insert({ id: 'fence', turn_id: 'root-turn', model_request_id: 'final-request', created_at: NOW })]);
  const accepted = await f.collaboration.send({ source: await f.source(), targetConversationId: 'root', text: 'late peer update', mode: 'message' });
  assert.equal((await f.get('RuntimeDelivery', accepted.deliveryId)).phase, 'next_turn');
  assert.equal((await f.rows('RuntimeDeliveryWake')).length, 0);
  const decision = await new AutomaticRuntimeDeliveryRouter(f.database).resolve({ inboxItemId: accepted.inboxItemId, targetConversationId: 'root', sourceTurnId: 'root-turn' });
  assert.equal(decision.phase, 'next_turn');
  assert.equal(decision.targetTurnId, null);
}));

test('automatic followup budget is atomic under competing sends and does not change recursion depth', async () => fixture(async f => {
  const [left, right] = await Promise.all([f.source('budget-a'), f.source('budget-b')]);
  const results = await Promise.allSettled([f.collaboration.send({ source: left, targetConversationId: 'right', text: 'a', mode: 'followup' }), f.collaboration.send({ source: right, targetConversationId: 'root', text: 'b', mode: 'followup' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal((await f.rows('CollaborationRequest')).length, 1);
  assert.equal((await f.rows('ChildExecution')).length, 2);
}, 1));

test('followup completion replies to the requester and survives restart', async () => fixture(async f => {
  const accepted = await f.collaboration.send({ source: await f.source(), targetConversationId: 'root', text: 'review this', mode: 'followup' });
  await f.deliveries.advance(accepted.deliveryId);
  assert.equal((await f.rows('CollaborationRequestTurnLink'))[0].turn_id, 'root-turn');
  await f.database.transaction([repo('Turn').update('root-turn', { status: 'terminated', terminal_at: NOW, updated_at: NOW }), repo('TurnTermination').insert({ id: 'root-done', turn_id: 'root-turn', terminal_status: 'completed', reason: 'finished', created_at: NOW })]);
  await f.reopen();
  await f.collaboration.completeRequestsForTurn({ turnId: 'root-turn', text: 'explicit result' });
  await f.collaboration.reconcile();
  const messages = (await f.collaboration.listMessages({ conversationId: 'left' })).messages;
  const reply = messages.find(message => message.replyToMessageId === accepted.messageId);
  assert.ok(reply);
  assert.equal(reply.sourceKind, 'completion');
  assert.equal(reply.targetConversationId, 'left');
  assert.equal((await f.collaboration.readMessage({ conversationId: 'left', messageId: reply.messageId })).text, 'explicit result');
  assert.equal((await f.rows('CollaborationRequest'))[0].state, 'completed');
  assert.equal((await f.rows('CollaborationMessage')).length, 2);
}));

test('stopped child cannot be revived through a sibling followup', async () => fixture(async f => {
  await f.database.transaction([repo('ChildExecution').update('right-child', { status: 'interrupted', updated_at: NOW })]);
  await assert.rejects(f.collaboration.send({ source: await f.source(), targetConversationId: 'right', text: 'resume', mode: 'followup' }), /cannot revive/);
  assert.equal((await f.rows('CollaborationMessage')).length, 0);
}));

async function admitPending(f, conversationId, turnId, startingDeliveryId) {
  const policy = await f.get('AuthoritySnapshot', 'root-authority');
  const steps = await f.deliveries.prepareNextTurnDeliverySteps(conversationId, turnId, NOW, startingDeliveryId);
  await f.database.transaction([
    repo('Turn').insert({ id: turnId, conversation_id: conversationId, status: 'active', created_at: NOW, updated_at: NOW, terminal_at: null }),
    repo('AuthoritySnapshot').insert({ id: `${turnId}-policy`, turn_id: turnId, content_object_id: policy.content_object_id, created_at: NOW }),
    ...steps
  ]);
}

test('same-clock concurrent messages use a stable sequence for forward and backward pagination', async () => fixture(async f => {
  const sent = [];
  for (let index = 0; index < 5; index += 1) sent.push(await f.collaboration.send({ source: await f.source(`page-${index}`), targetConversationId: 'right', text: `item ${index}`, mode: 'message' }));
  const latest = await f.collaboration.listMessages({ conversationId: 'right', limit: 2 });
  assert.deepEqual(latest.messages.map(row => row.messageId), sent.slice(3).map(row => row.messageId));
  assert.equal(latest.olderCursor, sent[3].messageId);
  assert.equal(latest.nextCursor, sent[4].messageId);
  const previous = await f.collaboration.listMessages({ conversationId: 'right', beforeMessageId: latest.olderCursor, limit: 2 });
  assert.deepEqual(previous.messages.map(row => row.messageId), sent.slice(1, 3).map(row => row.messageId));
  const tail = await f.collaboration.listMessages({ conversationId: 'right', afterMessageId: sent[2].messageId, limit: 2 });
  assert.deepEqual(tail.messages.map(row => row.messageId), sent.slice(3).map(row => row.messageId));
  await assert.rejects(f.collaboration.listMessages({ conversationId: 'outsider', afterMessageId: sent[0].messageId }), /not visible/);
  assert.throws(() => repo('CollaborationMessage').list({ orderBy: { column: 'message_seq', direction: 'asc' }, keyset: { column: 'secret_sql', value: 1n, id: 'x', direction: 'after' }, limit: 1 }), /scalar/);
  assert.throws(() => repo('CollaborationMessage').list({ orderBy: { column: 'message_seq', direction: 'asc' }, keyset: { column: 'message_seq', value: 'not-an-integer', id: 'x', direction: 'after' }, limit: 1 }), /integer|INTEGER/);
}));

test('a nested child spawned by a followup Turn cannot reset the team followup budget', async () => fixture(async f => {
  await f.collaboration.send({ source: await f.source('start-right', 'root'), targetConversationId: 'right', text: 'delegate', mode: 'followup' });
  await admitPending(f, 'right', 'right-next');
  const policy = await f.get('AuthoritySnapshot', 'root-authority');
  await f.database.transaction([
    repo('ChildExecution').update('right-child', { status: 'active', updated_at: NOW }),
    repo('Conversation').insert({ id: 'nested', title: 'nested', status: 'active', created_at: NOW, updated_at: NOW }),
    repo('Turn').insert({ id: 'nested-turn', conversation_id: 'nested', status: 'active', created_at: NOW, updated_at: NOW, terminal_at: null }),
    repo('AuthoritySnapshot').insert({ id: 'nested-policy', turn_id: 'nested-turn', content_object_id: policy.content_object_id, created_at: NOW }),
    repo('ChildExecution').insert({ id: 'nested-child', child_conversation_id: 'nested', status: 'active', created_at: NOW, updated_at: NOW }),
    repo('ChildExecutionParentLink').insert({ id: 'nested-parent', child_execution_id: 'nested-child', source_tool_call_id: 'nested-spawn', parent_child_execution_id: 'right-child', parent_turn_id: 'right-next', created_at: NOW })
  ]);
  await assert.rejects(f.collaboration.send({ source: await f.source('nested-followup', 'nested'), targetConversationId: 'right', text: 'try to reset', mode: 'followup' }), /budget exhausted/);
  assert.equal((await f.rows('CollaborationBudget')).length, 1);
}, 1));

test('zero automatic budget rejects every agent followup while plain messages still queue', async () => fixture(async f => {
  await assert.rejects(f.collaboration.send({ source: await f.source('zero-followup'), targetConversationId: 'right', text: 'continue this task', mode: 'followup' }), /budget exhausted \(0\)/);
  assert.equal((await f.rows('CollaborationRequest')).length, 0);
  const message = await f.collaboration.send({ source: await f.source('zero-message'), targetConversationId: 'right', text: 'plain update', mode: 'message' });
  assert.equal(message.accepted, true);
  assert.equal((await f.rows('RuntimeDeliveryWake')).length, 0);
}, 0));

test('team transcript reads are bounded while conversations outside the team stay unreadable', async () => fixture(async f => {
  const content = await f.store.prepare(f.database, JSON.stringify({ role: 'model', parts: [{ text: 'private answer' }, { text: 'hidden reasoning', thought: true }] }), 'application/vnd.limcode.message+json');
  await f.database.transaction([...preparedContentObjectSteps([content], 'transcript'),
    repo('Message').insert({ id: 'history-message', created_at: NOW, updated_at: NOW, deleted_at: null }),
    repo('MessageRevision').insert({ id: 'history-revision', message_id: 'history-message', revision_seq: 1n, role: 'model', content_object_id: content.metadata.id, created_at: NOW }),
    repo('MessageCurrentRevisionLink').insert({ id: 'history-current', message_id: 'history-message', revision_id: 'history-revision', updated_at: NOW }),
    repo('MessagePartOfConversation').insert({ id: 'history-member', conversation_id: 'left', message_id: 'history-message', message_seq: 1n, created_at: NOW })]);
  await assert.rejects(f.collaboration.readConversation({ conversationId: 'root', targetConversationId: 'outsider' }), /not enabled/);
  assert.equal((await f.collaboration.readConversation({ conversationId: 'root', targetConversationId: 'left' })).messages[0].text, 'private answer');
  const taskPrompt = await f.store.prepare(f.database, 'child initial task in plain text', 'text/plain');
  await f.database.transaction([...preparedContentObjectSteps([taskPrompt], 'child_prompt'),
    repo('Message').insert({ id: 'child-first-message', created_at: NOW, updated_at: NOW, deleted_at: null }),
    repo('MessageRevision').insert({ id: 'child-first-revision', message_id: 'child-first-message', revision_seq: 1n, role: 'user', content_object_id: taskPrompt.metadata.id, created_at: NOW }),
    repo('MessageCurrentRevisionLink').insert({ id: 'child-first-current', message_id: 'child-first-message', revision_id: 'child-first-revision', updated_at: NOW }),
    repo('MessagePartOfConversation').insert({ id: 'child-first-member', conversation_id: 'right', message_id: 'child-first-message', message_seq: 1n, created_at: NOW })]);
  assert.equal((await f.collaboration.readConversation({ conversationId: 'root', targetConversationId: 'right' })).messages[0].text, 'child initial task in plain text');
  assert.equal((await f.collaboration.readConversation({ conversationId: 'left', targetConversationId: 'right' })).messages[0].text, 'child initial task in plain text');
}));

test('the durable wake scanner starts exactly one followup while idle messages stay queued', async () => fixture(async f => {
  const plain = await f.collaboration.send({ source: await f.source('quiet-send'), targetConversationId: 'right', text: 'quiet', mode: 'message' });
  const followup = await f.collaboration.send({ source: await f.source('wake-send'), targetConversationId: 'right', text: 'work', mode: 'followup' });
  const wakes = [];
  const errors = [];
  const scanner = new ProcessCompletionDeliveryControlPlane(f.database, f.store, {}, f.deliveries, { now: () => NOW, onError: detail => errors.push(detail), wakeHandler: async request => {
    wakes.push(request);
    assert.equal(request.sourceKind, 'collaboration_message');
    assert.ok(['start_continuation', 'resume_current_turn'].includes(request.action));
    assert.equal(request.childExecutionId, 'right-child');
    if (request.action === 'start_continuation') await admitPending(f, 'right', 'right-started');
    return { acknowledged: true };
  } });
  try {
    await scanner.scanNow();
    await scanner.scanNow();
    assert.equal(errors.length, 0, errors.map(detail => String(detail.error)).join('\n'));
    assert.equal(wakes.filter(request => request.action === 'start_continuation').length, 1);
    assert.equal((await f.get('RuntimeDelivery', plain.deliveryId)).state, 'consumed');
    assert.equal((await f.get('RuntimeDelivery', followup.deliveryId)).state, 'consumed');
    assert.equal((await f.rows('PendingTurnInput', { turn_id: 'right-started' })).length, 2);
  } finally { await scanner.dispose(); }
}));

async function endTurn(f, turnId) {
  await f.database.transaction([repo('Turn').update(turnId, { status: 'terminated', terminal_at: NOW, updated_at: NOW }), repo('TurnTermination').insert({ id: `${turnId}-done`, turn_id: turnId, terminal_status: 'completed', reason: 'finished', created_at: NOW })]);
}

test('a queued followup waits for the running target Turn and then starts exactly one new Turn', async () => fixture(async f => {
  const accepted = await f.collaboration.send({ source: await f.source('queued-followup'), targetConversationId: 'root', text: 'queued work', mode: 'followup', queueBehindActiveTurn: true });
  const delivery = await f.get('RuntimeDelivery', accepted.deliveryId);
  assert.equal(delivery.phase, 'next_turn');
  assert.equal(delivery.target_turn_id, null);
  assert.equal((await f.rows('CollaborationMessageTargetLink', { message_id: accepted.messageId }))[0].anchor_turn_id, 'root-turn');
  const decision = await new AutomaticRuntimeDeliveryRouter(f.database).resolve({ inboxItemId: accepted.inboxItemId, targetConversationId: 'root', sourceTurnId: 'root-turn' });
  assert.equal(decision.reason, 'collaboration_queued_behind_active_turn');
  assert.equal(decision.phase, 'next_turn');
  assert.equal(decision.targetTurnId, null);
  await f.deliveries.advance(accepted.deliveryId);
  const wakes = [];
  const errors = [];
  const scanner = new ProcessCompletionDeliveryControlPlane(f.database, f.store, {}, f.deliveries, { now: () => NOW, onError: detail => errors.push(detail), wakeHandler: async request => {
    wakes.push(request);
    if (request.action === 'start_continuation') await admitPending(f, 'root', 'root-next');
    return { acknowledged: true };
  } });
  try {
    const [before] = await f.rows('RuntimeDeliveryWake', { delivery_id: accepted.deliveryId });
    await scanner.scanNow();
    await scanner.scanNow();
    assert.equal(wakes.length, 0, 'the running target is neither resumed nor continued');
    assert.deepEqual(await f.get('RuntimeDeliveryWake', before.id), before, 'waiting leaves the wake row untouched');
    assert.equal((await f.get('RuntimeDelivery', accepted.deliveryId)).state, 'pending');
    assert.equal((await f.rows('PendingTurnInput', { turn_id: 'root-turn' })).length, 0, 'never injected into the running Turn');
    await endTurn(f, 'root-turn');
    await scanner.scanNow();
    await scanner.scanNow();
    assert.equal(errors.length, 0, errors.map(detail => String(detail.error)).join('\n'));
    assert.deepEqual(wakes.map(request => [request.action, request.conversationId, request.childExecutionId ?? null]), [['start_continuation', 'root', null]]);
    assert.deepEqual((await f.rows('Turn', { conversation_id: 'root' })).map(turn => turn.id).sort(), ['root-next', 'root-turn']);
    const consumed = await f.get('RuntimeDelivery', accepted.deliveryId);
    assert.equal(consumed.state, 'consumed');
    assert.equal(consumed.target_turn_id, 'root-next');
    assert.equal((await f.rows('CollaborationRequestTurnLink'))[0].turn_id, 'root-next');
    assert.equal((await f.rows('RuntimeDeliveryWake', { delivery_id: accepted.deliveryId }))[0].state, 'acknowledged');
  } finally { await scanner.dispose(); }
}));

test('a queued plain message waits for the target next Turn without waking it', async () => fixture(async f => {
  const accepted = await f.collaboration.send({ source: await f.source('queued-message'), targetConversationId: 'root', text: 'queued note', mode: 'message', queueBehindActiveTurn: true });
  assert.equal((await f.get('RuntimeDelivery', accepted.deliveryId)).phase, 'next_turn');
  assert.equal((await f.rows('RuntimeDeliveryWake')).length, 0);
  await f.deliveries.advance(accepted.deliveryId);
  assert.equal((await f.rows('PendingTurnInput', { turn_id: 'root-turn' })).length, 0);
  await endTurn(f, 'root-turn');
  const scanner = new ProcessCompletionDeliveryControlPlane(f.database, f.store, {}, f.deliveries, { now: () => NOW, wakeHandler: async () => assert.fail('A plain message never starts a Turn.') });
  try { await scanner.scanNow(); } finally { await scanner.dispose(); }
  assert.equal((await f.rows('Turn', { conversation_id: 'root' })).length, 1);
  assert.equal((await f.get('RuntimeDelivery', accepted.deliveryId)).state, 'pending');
  await admitPending(f, 'root', 'root-later');
  const consumed = await f.get('RuntimeDelivery', accepted.deliveryId);
  assert.equal(consumed.state, 'consumed');
  assert.equal(consumed.target_turn_id, 'root-later');
}));

test('queueing applies only to a running target and never delays a completion reply to a running requester', async () => fixture(async f => {
  const request = await f.collaboration.send({ source: await f.source('root-asks-right', 'root'), targetConversationId: 'right', text: 'review this', mode: 'followup', queueBehindActiveTurn: true });
  assert.equal((await f.rows('CollaborationMessageTargetLink', { message_id: request.messageId }))[0].anchor_turn_id, null, 'an idle target has no Turn to wait for');
  await admitPending(f, 'right', 'right-next');
  await endTurn(f, 'right-next');
  await f.collaboration.completeRequestsForTurn({ turnId: 'right-next', text: 'review result' });
  const reply = (await f.collaboration.listMessages({ conversationId: 'root' })).messages.find(message => message.sourceKind === 'completion');
  const target = (await f.rows('CollaborationMessageTargetLink', { message_id: reply.messageId }))[0];
  assert.equal(target.anchor_turn_id, null);
  const [delivery] = await f.rows('RuntimeDelivery', { inbox_item_id: target.inbox_item_id });
  assert.equal(delivery.phase, 'current_turn');
  assert.equal(delivery.target_turn_id, 'root-turn');
  assert.equal((await f.rows('RuntimeDeliveryWake', { delivery_id: delivery.id })).length, 1);
  await f.deliveries.advance(delivery.id);
  assert.equal((await f.rows('PendingTurnInput', { turn_id: 'root-turn' })).length, 1, 'the result joins the running requester Turn');
  await assert.rejects(f.collaboration.send({ source: await f.source('board-queue', 'root', 'root-turn'), targetConversationId: 'left', text: 'x', mode: 'message', queueBehindActiveTurn: 'yes' }), /must be boolean/);
}));

test('the source execution lease generation fences an otherwise valid live ToolCall', async () => fixture(async f => {
  const { runWithExecutionLeaseFence } = load('executionLeaseFence.js');
  const source = await f.source('fenced-message');
  assert.equal(await f.database.conversationOwners.tryClaim('left'), true);
  const fence = { id: 'left-lease', conversationId: 'left', turnId: 'left-turn', ownerId: 'left-owner', hostBootId: f.database.hostBootId, generation: 1n };
  await f.database.transaction([repo('ExecutionLease').insert({ id: fence.id, conversation_id: fence.conversationId, turn_id: fence.turnId, owner_id: fence.ownerId, host_boot_id: fence.hostBootId, generation: 2n, acquired_at: NOW, expires_at: '2026-09-23T00:00:00.000Z' })]);
  await assert.rejects(runWithExecutionLeaseFence(fence, () => f.collaboration.send({ source, targetConversationId: 'right', text: 'stale sender', mode: 'message' })), /ExecutionLease|Assertion|assertion/);
  assert.equal((await f.rows('CollaborationMessage')).length, 0);
  const accepted = await runWithExecutionLeaseFence({ ...fence, generation: 2n }, () => f.collaboration.send({ source, targetConversationId: 'right', text: 'current sender', mode: 'message' }));
  assert.equal(accepted.accepted, true);
}));

test('board notification expires with its original running Turn instead of becoming next-turn backlog', async () => fixture(async f => {
  const { CollaborationBoard } = load('collaborationBoard.js');
  const board = new CollaborationBoard(f.database, f.store, { now: () => NOW });
  const boardCall = async id => { await f.source(id, 'root', 'root-turn', 'agent_board'); return { conversationId: 'root', turnId: 'root-turn', toolCallId: id }; };
  const { channel } = await board.execute(await boardCall('board-channel'), { operation: 'create_channel', name: 'peer-updates' });
  const post = await board.execute(await boardCall('board-post'), { operation: 'post', channelId: channel.id, text: 'a'.repeat(70_000) });
  const notice = { postId: post.postId, channelId: channel.id, threadId: post.threadId ?? post.postId, sourceConversationId: 'root', targetConversationId: 'left', sourceTurnId: 'root-turn', sourceToolCallId: 'board-post' };
  assert.equal((await f.collaboration.notifyBoardPost(notice)).status, 'delivered');
  const delivery = (await f.rows('RuntimeDelivery'))[0];
  assert.equal(delivery.target_turn_id, 'left-turn');
  const message = (await f.collaboration.listMessages({ conversationId: 'left' })).messages[0];
  assert.ok((await f.collaboration.readMessage({ conversationId: 'left', messageId: message.messageId })).text.length < 1500);
  await f.database.transaction([repo('Turn').update('left-turn', { status: 'terminated', terminal_at: NOW, updated_at: NOW }), repo('TurnTermination').insert({ id: 'left-stopped', turn_id: 'left-turn', terminal_status: 'cancelled', reason: 'user stop', created_at: NOW })]);
  await f.deliveries.advance(delivery.id);
  assert.equal((await f.get('RuntimeDelivery', delivery.id)).state, 'failed');
  assert.equal((await f.get('RuntimeDelivery', delivery.id)).failure_reason, 'board-notification-expired');
  await admitPending(f, 'left', 'left-later');
  assert.equal((await f.rows('PendingTurnInput', { turn_id: 'left-later' })).length, 0);
}));

test('automatic runtime continuation cannot reset the user root followup budget', async () => fixture(async f => {
  await f.collaboration.send({ source: await f.source('spend-root-budget'), targetConversationId: 'right', text: 'spend', mode: 'followup' });
  const policy = await f.get('AuthoritySnapshot', 'root-authority');
  const envelope = await f.store.prepare(f.database, JSON.stringify({ version: 1, kind: 'runtime_continuation', sourceTurnId: 'root-turn' }), 'application/vnd.limcode.turn-intent+json');
  await f.database.transaction([
    ...preparedContentObjectSteps([envelope], 'auto_continuation'),
    repo('Turn').update('root-turn', { status: 'terminated', terminal_at: NOW, updated_at: NOW }),
    repo('TurnTermination').insert({ id: 'root-original-done', turn_id: 'root-turn', terminal_status: 'completed', reason: 'done', created_at: NOW }),
    repo('Turn').insert({ id: 'root-auto', conversation_id: 'root', status: 'active', created_at: NOW, updated_at: NOW, terminal_at: null }),
    repo('AuthoritySnapshot').insert({ id: 'root-auto-policy', turn_id: 'root-auto', content_object_id: policy.content_object_id, created_at: NOW }),
    repo('TurnIntent').insert({ id: 'auto-intent', conversation_id: 'root', turn_id: 'root-auto', state: 'admitted', created_at: NOW, updated_at: NOW }),
    repo('TurnIntentRevision').insert({ id: 'auto-intent-revision', intent_id: 'auto-intent', revision_seq: 1n, content_object_id: envelope.metadata.id, created_at: NOW })
  ]);
  await assert.rejects(f.collaboration.send({ source: await f.source('auto-again', 'root', 'root-auto'), targetConversationId: 'right', text: 'cannot reset', mode: 'followup' }), /budget exhausted/);
  assert.equal((await f.rows('CollaborationBudget')).length, 1);
}, 1));

test('a host that does not own the target skips a queued wake without reading its collaboration facts', async () => fixture(async f => {
  const { ConversationRuntimeOwnerManager } = load('ConversationRuntimeOwnerManager.js');
  const accepted = await f.collaboration.send({ source: await f.source('foreign-queued'), targetConversationId: 'root', text: 'queued work', mode: 'followup', queueBehindActiveTurn: true });
  // A live peer Host runs the target Turn and owns the Conversation.
  const peerOwner = new ConversationRuntimeOwnerManager(f.database.binding, 'collaboration-peer-host');
  peerOwner.setPendingWorkProbe(async () => true);
  assert.equal(await peerOwner.tryClaim('root'), true);
  const read = [];
  const restore = [];
  for (const method of ['snapshot', 'snapshotAll']) {
    const original = f.database[method];
    restore.push(() => { f.database[method] = original; });
    f.database[method] = function(operations, ...rest) {
      for (const operation of [operations].flat()) if (operation?.domain) read.push(operation.domain);
      return original.call(this, operations, ...rest);
    };
  }
  const scanner = new ProcessCompletionDeliveryControlPlane(f.database, f.store, {}, f.deliveries, { now: () => NOW,
    wakeHandler: async () => assert.fail('A foreign host never dispatches the wake.') });
  try {
    const [before] = await f.rows('RuntimeDeliveryWake', { delivery_id: accepted.deliveryId });
    read.length = 0;
    await scanner.scanNow();
    assert.ok(read.includes('RuntimeDeliveryWake'), 'the scan did run');
    for (const domain of ['CollaborationMessageTargetLink', 'CollaborationMessageSourceLink']) {
      assert.equal(read.includes(domain), false, `a non-owner host must not read ${domain} for a queued wake`);
    }
    for (const undo of restore) undo();
    assert.deepEqual(await f.get('RuntimeDeliveryWake', before.id), before, 'the foreign wake stays untouched');
  } finally { for (const undo of restore) undo(); await scanner.dispose(); await peerOwner.close(); }
}));

/** Top-level Conversations outside the fixture team, each with one frozen Turn. */
async function topLevel(f, ...conversations) {
  const policy = await f.get('AuthoritySnapshot', 'root-authority');
  await f.database.transaction(conversations.flatMap(([id, active]) => [
    repo('Conversation').insert({ id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
    repo('Turn').insert({ id: `${id}-turn`, conversation_id: id, status: active ? 'active' : 'terminated', created_at: NOW, updated_at: NOW, terminal_at: active ? null : NOW }),
    repo('AuthoritySnapshot').insert({ id: `${id}-authority`, turn_id: `${id}-turn`, content_object_id: policy.content_object_id, created_at: NOW }),
    ...(active ? [] : [repo('TurnTermination').insert({ id: `${id}-termination`, turn_id: `${id}-turn`, terminal_status: 'completed', reason: 'fixture', created_at: NOW })])
  ]));
}
async function crossSend(f, callId, from, turnId, target, mode, text = callId) {
  const source = await f.source(callId, from, turnId, 'send_conversation_message');
  return f.collaboration.send({ source, targetConversationId: target, text, mode, queueBehindActiveTurn: true, crossConversation: true });
}
/** Mirrors a runtime continuation admission: the Turn is linked to the exact delivery that started it. */
async function admitContinuation(f, conversationId, turnId, deliveryId) {
  const envelope = await f.store.prepare(f.database, JSON.stringify({ version: 1, kind: 'runtime_continuation', sourceTurnId: null }), 'application/vnd.limcode.turn-intent+json');
  await f.database.transaction([...preparedContentObjectSteps([envelope], "continuation_intent"),
    repo('TurnIntent').insert({ id: `${turnId}-intent`, conversation_id: conversationId, turn_id: null, state: 'queued', created_at: NOW, updated_at: NOW }),
    repo('TurnIntentRevision').insert({ id: `${turnId}-intent-revision`, intent_id: `${turnId}-intent`, revision_seq: 1n, content_object_id: envelope.metadata.id, created_at: NOW }),
    repo('RuntimeDeliveryIntentLink').insert({ id: `${turnId}-delivery-link`, delivery_id: deliveryId, turn_intent_id: `${turnId}-intent`, created_at: NOW })]);
  await admitPending(f, conversationId, turnId, deliveryId);
  await f.database.transaction([repo('TurnIntent').update(`${turnId}-intent`, { turn_id: turnId, state: 'admitted', updated_at: NOW })]);
}
function continuationScanner(f, started) {
  const errors = [];
  const scanner = new ProcessCompletionDeliveryControlPlane(f.database, f.store, {}, f.deliveries, { now: () => NOW, onError: detail => errors.push(detail), wakeHandler: async request => {
    // Inputs already bound into a Turn only ask that Turn to absorb them.
    if (request.action === 'resume_current_turn') return { acknowledged: true };
    assert.equal(request.action, 'start_continuation', JSON.stringify(request));
    const turnId = `${request.conversationId}-continuation-${started.length + 1}`;
    started.push({ turnId, deliveryId: request.deliveryId });
    await admitContinuation(f, request.conversationId, turnId, request.deliveryId);
    return { acknowledged: true };
  } });
  return { scanner, errors, async scan() { await scanner.scanNow(); assert.equal(errors.length, 0, errors.map(detail => String(detail.error?.stack ?? detail.error)).join('\n')); } };
}
async function budgetOf(f, deliveryId) {
  const delivery = await f.get('RuntimeDelivery', deliveryId);
  const inbox = await f.get('RuntimeInboxItem', delivery.inbox_item_id);
  const [request] = await f.rows('CollaborationRequest', { message_id: inbox.source_id });
  return (await f.get('CollaborationBudget', request.budget_id)).origin_key;
}

test('a user Turn that starts after the anchor ends never absorbs a queued cross-conversation followup', async () => fixture(async f => {
  await topLevel(f, ['peer-a', true], ['target-b', true]);
  const followup = await crossSend(f, 'a-followup', 'peer-a', 'peer-a-turn', 'target-b', 'followup', 'task from A');
  const note = await crossSend(f, 'a-note', 'peer-a', 'peer-a-turn', 'target-b', 'message', 'note from A');
  await endTurn(f, 'target-b-turn');
  // The user's own Turn wins the race against the durable wake.
  await admitPending(f, 'target-b', 'target-b-user');
  assert.equal((await f.get('RuntimeDelivery', followup.deliveryId)).state, 'pending', 'the user Turn does not consume the peer task');
  assert.deepEqual(await f.rows('CollaborationRequestTurnLink'), [], 'the peer request is not attached to the user Turn');
  assert.equal((await f.get('RuntimeDelivery', note.deliveryId)).target_turn_id, 'target-b-user', 'a plain message still joins the next Turn');
  const started = [];
  const { scanner, scan } = continuationScanner(f, started);
  try {
    await scan();
    assert.deepEqual(started, [], 'the followup waits behind the user Turn instead of being injected');
    assert.equal((await f.get('RuntimeDelivery', followup.deliveryId)).state, 'pending');
    assert.deepEqual((await f.rows('PendingTurnInput', { turn_id: 'target-b-user' })).map(row => row.id).length, 1, 'only the plain message entered the user Turn');
    // The user Turn spends its own budget, never the peer's.
    const own = await crossSend(f, 'b-user-followup', 'target-b', 'target-b-user', 'peer-a', 'followup');
    assert.equal(await budgetOf(f, own.deliveryId), 'target-b-user');
    await endTurn(f, 'target-b-user');
    await scan();
    assert.deepEqual(started.map(entry => entry.deliveryId).filter(id => id === followup.deliveryId), [followup.deliveryId]);
    const continuation = started.find(entry => entry.deliveryId === followup.deliveryId).turnId;
    assert.equal((await f.get('RuntimeDelivery', followup.deliveryId)).target_turn_id, continuation);
    const [link] = await f.rows('CollaborationRequestTurnLink', { turn_id: continuation });
    assert.ok(link, 'the peer request belongs to the continuation it started');
    const chained = await crossSend(f, 'b-continuation-followup', 'target-b', continuation, 'peer-a', 'followup');
    assert.equal(await budgetOf(f, chained.deliveryId), 'peer-a-turn', 'the continuation spends the requester budget');
  } finally { await scanner.dispose(); }
}));

test('followups from two peers queued behind one Turn start two sequential Turns with their own budgets', async () => fixture(async f => {
  await topLevel(f, ['peer-a', true], ['peer-d', true], ['target-b', true]);
  const fromA = await crossSend(f, 'a-task', 'peer-a', 'peer-a-turn', 'target-b', 'followup', 'task from A');
  const fromD = await crossSend(f, 'd-task', 'peer-d', 'peer-d-turn', 'target-b', 'followup', 'task from D');
  await endTurn(f, 'target-b-turn');
  const started = [];
  const { scanner, scan } = continuationScanner(f, started);
  try {
    await scan();
    await scan();
    assert.equal(started.length, 1, 'one continuation at a time');
    const [first] = started;
    const firstInputs = await f.rows('RuntimeDelivery', { target_turn_id: first.turnId });
    assert.deepEqual(firstInputs.map(row => row.id), [first.deliveryId], 'two peer tasks are never merged into one Turn');
    const other = first.deliveryId === fromA.deliveryId ? fromD : fromA;
    assert.equal((await f.get('RuntimeDelivery', other.deliveryId)).state, 'pending');
    const firstOrigin = first.deliveryId === fromA.deliveryId ? 'peer-a-turn' : 'peer-d-turn';
    const onward = await crossSend(f, 'b-first-onward', 'target-b', first.turnId, 'peer-a', 'message');
    assert.equal(onward.accepted, true);
    const firstFollowup = await crossSend(f, 'b-first-followup', 'target-b', first.turnId, first.deliveryId === fromA.deliveryId ? 'peer-d' : 'peer-a', 'followup');
    assert.equal(await budgetOf(f, firstFollowup.deliveryId), firstOrigin);
    await endTurn(f, first.turnId);
    await scan();
    assert.equal(started.length, 2);
    assert.equal(started[1].deliveryId, other.deliveryId);
    assert.deepEqual((await f.rows('RuntimeDelivery', { target_turn_id: started[1].turnId })).filter(row => row.id === first.deliveryId), []);
    const secondFollowup = await crossSend(f, 'b-second-followup', 'target-b', started[1].turnId, 'peer-a', 'followup');
    assert.equal(await budgetOf(f, secondFollowup.deliveryId), firstOrigin === 'peer-a-turn' ? 'peer-d-turn' : 'peer-a-turn');
  } finally { await scanner.dispose(); }
}));

test('a queued cross-conversation followup still starts its Turn when the anchor ends failed or interrupted', async () => {
  for (const terminalStatus of ['failed', 'interrupted', 'cancelled']) await fixture(async f => {
    await topLevel(f, ['peer-a', true], ['target-b', true]);
    const followup = await crossSend(f, `a-task-${terminalStatus}`, 'peer-a', 'peer-a-turn', 'target-b', 'followup');
    await f.database.transaction([repo('Turn').update('target-b-turn', { status: 'terminated', terminal_at: NOW, updated_at: NOW }), repo('TurnTermination').insert({ id: 'target-b-stopped', turn_id: 'target-b-turn', terminal_status: terminalStatus, reason: 'user stop', created_at: NOW })]);
    const started = [];
    const { scanner, scan } = continuationScanner(f, started);
    try {
      await scan();
      assert.deepEqual(started.map(entry => entry.deliveryId), [followup.deliveryId], terminalStatus);
      assert.equal((await f.get('RuntimeDelivery', followup.deliveryId)).state, 'consumed');
    } finally { await scanner.dispose(); }
  });
});

test('an A to B to A followup chain spends one shared budget until it is exhausted', async () => fixture(async f => {
  await topLevel(f, ['peer-a', true], ['target-b', false]);
  const first = await crossSend(f, 'a-asks-b', 'peer-a', 'peer-a-turn', 'target-b', 'followup');
  await endTurn(f, 'peer-a-turn');
  const started = [];
  const { scanner, scan } = continuationScanner(f, started);
  try {
    await scan();
    assert.deepEqual(started.map(entry => entry.deliveryId), [first.deliveryId]);
    const back = await crossSend(f, 'b-asks-a', 'target-b', started[0].turnId, 'peer-a', 'followup');
    assert.equal(await budgetOf(f, back.deliveryId), 'peer-a-turn');
    await endTurn(f, started[0].turnId);
    await scan();
    assert.deepEqual(started.map(entry => entry.deliveryId), [first.deliveryId, back.deliveryId]);
    await assert.rejects(crossSend(f, 'a-asks-b-again', 'peer-a', started[1].turnId, 'target-b', 'followup'), /budget exhausted \(2\)/);
    assert.equal((await f.rows('CollaborationRequest')).length, 2);
    assert.equal((await f.rows('CollaborationBudget')).length, 1);
  } finally { await scanner.dispose(); }
}, 2));

test('a cross-conversation followup whose target is deleted while queued tells the requester it could not start', async () => fixture(async f => {
  const { ConversationDeletionControlPlane } = load('conversationDeletion.js');
  await topLevel(f, ['peer-a', true], ['target-b', true]);
  const followup = await crossSend(f, 'a-task-deleted', 'peer-a', 'peer-a-turn', 'target-b', 'followup', 'task for a deleted target');
  await endTurn(f, 'target-b-turn');
  await new ConversationDeletionControlPlane(f.database).delete('target-b');
  await f.collaboration.reconcile();
  await f.collaboration.reconcile();
  const [request] = await f.rows('CollaborationRequest', { message_id: followup.messageId });
  assert.equal(request.state, 'failed');
  const replies = (await f.collaboration.listMessages({ conversationId: 'peer-a' })).messages.filter(message => message.replyToMessageId === followup.messageId);
  assert.equal(replies.length, 1, 'exactly one reply, even when reconcile runs again');
  assert.equal(replies[0].sourceKind, 'completion');
  assert.equal(replies[0].sourceConversationId, 'target-b');
  assert.match((await f.collaboration.readMessage({ conversationId: 'peer-a', messageId: replies[0].messageId })).text, /^Task could not start: the target conversation was deleted/);
  const [source] = await f.rows('CollaborationMessageSourceLink', { message_id: replies[0].messageId });
  assert.equal(source.turn_id, null, 'no Turn of the deleted target answers');
  const [reply] = await f.rows('RuntimeDelivery', { target_conversation_id: 'peer-a' });
  assert.deepEqual([reply.phase, reply.target_turn_id], ['current_turn', 'peer-a-turn'], 'the waiting requester hears back in its running Turn');
}));

test('a followup whose continuation can never be admitted is reported back to the requester', async () => fixture(async f => {
  await topLevel(f, ['peer-a', true], ['target-b', false]);
  const followup = await crossSend(f, 'a-task-unstartable', 'peer-a', 'peer-a-turn', 'target-b', 'followup');
  const scanner = new ProcessCompletionDeliveryControlPlane(f.database, f.store, {}, f.deliveries, { now: () => NOW, maxFailureCount: 1,
    wakeHandler: async () => { throw new Error('The configured provider no longer exists.'); } });
  try { await scanner.scanNow(); } finally { await scanner.dispose(); }
  assert.equal((await f.get('RuntimeDelivery', followup.deliveryId)).state, 'failed');
  await f.collaboration.reconcile();
  assert.equal((await f.rows('CollaborationRequest', { message_id: followup.messageId }))[0].state, 'failed');
  const reply = (await f.collaboration.listMessages({ conversationId: 'peer-a' })).messages.find(message => message.replyToMessageId === followup.messageId);
  assert.ok(reply, 'the requester is told instead of waiting forever');
  assert.match((await f.collaboration.readMessage({ conversationId: 'peer-a', messageId: reply.messageId })).text, /^Task could not start: .*provider no longer exists/);
}));

test('a target holds at most 16 undelivered collaboration messages from other conversations; completion replies are exempt', async () => fixture(async f => {
  await topLevel(f, ['peer-a', true], ['peer-d', true], ['target-b', true]);
  // B is waiting on A, so a completion reply is owed to B later.
  const asked = await crossSend(f, 'b-asks-a', 'target-b', 'target-b-turn', 'peer-a', 'followup');
  for (let index = 0; index < 10; index += 1) await crossSend(f, `a-note-${index}`, 'peer-a', 'peer-a-turn', 'target-b', 'message');
  for (let index = 0; index < 6; index += 1) await crossSend(f, `d-task-${index}`, 'peer-d', 'peer-d-turn', 'target-b', 'followup');
  const before = (await f.rows('CollaborationMessage')).length;
  for (const mode of ['message', 'followup']) {
    await assert.rejects(crossSend(f, `a-overflow-${mode}`, 'peer-a', 'peer-a-turn', 'target-b', mode), /16 undelivered collaboration messages/);
  }
  assert.equal((await f.rows('CollaborationMessage')).length, before, 'a rejected send writes nothing');
  assert.equal((await f.rows('CollaborationRequest')).length, 7, 'a rejected followup spends no budget');
  // The owed answer still reaches B.
  await endTurn(f, 'peer-a-turn');
  await admitContinuation(f, 'peer-a', 'peer-a-answering', asked.deliveryId);
  await endTurn(f, 'peer-a-answering');
  await f.collaboration.completeRequestsForTurn({ turnId: 'peer-a-answering', text: 'answer for B' });
  const reply = (await f.collaboration.listMessages({ conversationId: 'target-b' })).messages.find(message => message.replyToMessageId === asked.messageId);
  assert.equal(reply?.sourceKind, 'completion');
  // Once B takes its messages in, peers may send again.
  await endTurn(f, 'target-b-turn');
  await admitPending(f, 'target-b', 'target-b-next');
  assert.equal((await crossSend(f, 'd-after-drain', 'peer-d', 'peer-d-turn', 'target-b', 'message')).accepted, true);
}));
