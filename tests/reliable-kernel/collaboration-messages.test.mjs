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
  const prepared = await store.prepare(database, JSON.stringify({ toolPolicy: { toolConfigs: { run_agent: { config: { maxAutomaticFollowups: budget } } } } }), 'application/json');
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
    await run({ get database() { return database; }, get deliveries() { return deliveries; }, get collaboration() { return collaboration; }, store, rows, get,
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

async function admitPending(f, conversationId, turnId) {
  const policy = await f.get('AuthoritySnapshot', 'root-authority');
  const steps = await f.deliveries.prepareNextTurnDeliverySteps(conversationId, turnId, NOW);
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
