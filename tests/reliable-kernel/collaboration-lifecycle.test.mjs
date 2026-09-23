import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const kernel = require(path.resolve('dist/extension/backend/reliableKernel/index.js'));
const NOW = '2026-09-22T00:00:00.000Z';
const row = (domain, value) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(value);
async function withRuntime(body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-collaboration-lifecycle-'));
  let database;
  try {
    const fixture = await kernel.resetCandidateRuntimeRoot(directory);
    database = await kernel.RuntimeDatabase.open(fixture.authority, { hostBootId: 'collaboration-lifecycle-test' });
    const store = new kernel.ContentAddressedStore(fixture.authority, fixture.binding);
    await database.transaction(['sender','target','unrelated'].map(id => row('Conversation', { id, title: id, status: 'active', created_at: NOW, updated_at: NOW })));
    return await body({ database, store });
  } finally { if (database) await database.close(); await fs.rm(directory, { recursive: true, force: true }); }
}
async function seedMessage({ database, store }, id, mode = 'message', target = 'target', text = `body of ${id}`, source = 'sender') {
  const payload = await store.ingest(database, text, 'text/vnd.limcode.collaboration-message');
  await database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('CollaborationMessage').insertWithNextSequence({ id, dedupe_key: id, mode, created_at: NOW }, { column: 'message_seq', scope: {} }),
    row('CollaborationMessageSourceLink', { id: `${id}-source`, message_id: id, conversation_id: source, source_kind: 'tool', source_key: id, turn_id: null, tool_call_id: null, created_at: NOW }),
    row('RuntimeInboxItem', { id: `${id}-inbox`, dedupe_key: id, source_kind: 'collaboration_message', source_id: id, state: 'available', created_at: NOW, updated_at: NOW }),
    row('CollaborationMessageTargetLink', { id: `${id}-target`, message_id: id, conversation_id: target, inbox_item_id: `${id}-inbox`, anchor_turn_id: null, created_at: NOW }),
    row('CollaborationMessagePayloadLink', { id: `${id}-payload`, message_id: id, content_object_id: payload.id, created_at: NOW }),
    row('RuntimeDelivery', { id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: target, target_turn_id: null, phase: 'next_turn', attempt_seq: 1n, retry_of_delivery_id: null, state: 'pending', failure_reason: null, created_at: NOW, updated_at: NOW })
  ]);
}
async function get(database, domain, id) { return (await database.snapshot([kernel.DOMAIN_REPOSITORIES.domain(domain).get(id)])).snapshot[0]; }

test('idle message retains history without retaining owner; target deletion settles only its own delivery', async () => withRuntime(async (runtime) => {
  const { database } = runtime;
  await seedMessage(runtime, 'silent', 'message', 'target', '  short\n peer   note  ');
  await seedMessage(runtime, 'other', 'message', 'unrelated');
  assert.equal(await database.hasConversationRuntimeWork('target'), false);
  const snapshot = (await database.clientProjectionSnapshot('target')).snapshot.subagentDeliverySummary;
  assert.deepEqual(snapshot.collaborationMessages.map(value => value.id), ['silent']);
  assert.equal(snapshot.collaborationMessageSourceLinks[0].conversation_id, 'sender');
  assert.equal(snapshot.collaborationMessages[0].content_object_id, undefined);
  assert.equal(snapshot.collaborationMessages[0].text_preview, 'short peer note');
  await new kernel.ConversationDeletionControlPlane(database).delete('target');
  assert.equal(await get(database, 'Conversation', 'target'), null);
  assert.equal((await get(database, 'RuntimeDelivery', 'silent-delivery')).failure_reason, 'target-gone');
  assert.ok(await get(database, 'CollaborationMessage', 'silent'));
  assert.ok(await get(database, 'RuntimeInboxItem', 'silent-inbox'));
  assert.equal((await get(database, 'RuntimeDelivery', 'other-delivery')).state, 'pending');
}));

test('target deletion closes the pending wake and the sender hears the task could not start', async () => withRuntime(async (runtime) => {
  const { database } = runtime;
  await seedMessage(runtime, 'followup', 'followup');
  await database.transaction([
    row('CollaborationBudget', { id: 'budget', origin_kind: 'turn', origin_key: 'historical-turn', authority_turn_id: 'historical-turn', created_at: NOW }),
    row('CollaborationRequest', { id: 'request', message_id: 'followup', budget_id: 'budget', automatic: 1n, state: 'pending', created_at: NOW, updated_at: NOW }),
    row('RuntimeDeliveryWake', { id: 'wake', delivery_id: 'followup-delivery', state: 'pending', claim_owner_host_boot_id: null, claim_generation: 0n, claim_expires_at: null, attempt_count: 0n, failure_count: 0n, next_attempt_at: NOW, last_error: null, acknowledged_at: null, created_at: NOW, updated_at: NOW })
  ]);
  assert.equal(await database.hasConversationRuntimeWork('target'), true);
  await new kernel.ConversationDeletionControlPlane(database).delete('target');
  assert.equal((await get(database, 'RuntimeDelivery', 'followup-delivery')).failure_reason, 'target-gone');
  assert.equal((await get(database, 'RuntimeDeliveryWake', 'wake')).state, 'dead_letter');
  // The request is settled by reconcile, which first tells the sender the task could not start.
  const { CollaborationControlPlane } = require(path.resolve('dist/extension/backend/reliableKernel/collaborationControlPlane.js'));
  const { RuntimeDeliveryControlPlane } = require(path.resolve('dist/extension/backend/reliableKernel/answerDelivery.js'));
  const collaboration = new CollaborationControlPlane(database, runtime.store, new RuntimeDeliveryControlPlane(database));
  await collaboration.reconcile();
  assert.equal((await get(database, 'CollaborationRequest', 'request')).state, 'failed');
  const reply = (await collaboration.listMessages({ conversationId: 'sender' })).messages.find(message => message.replyToMessageId === 'followup');
  assert.match((await collaboration.readMessage({ conversationId: 'sender', messageId: reply.messageId })).text, /could not start: the target conversation was deleted/);
  assert.ok(await get(database, 'Conversation', 'sender'));
  assert.ok(await get(database, 'CollaborationMessage', 'followup'));
}));

test('board root deletion removes channel posts and replies while unrelated board stays intact', async () => withRuntime(async ({ database, store }) => {
  const content = await store.ingest(database, 'board content', 'text/plain');
  const steps = [];
  for (const [id, root] of [['channel', 'target'], ['other-channel', 'unrelated']]) {
    steps.push(row('CollaborationBoardChannel', { id, name: id, created_at: NOW }), row('CollaborationBoardChannelScopeLink', { id: `${id}-scope`, channel_id: id, root_conversation_id: root, created_at: NOW }));
  }
  for (const [id, channel] of [['post', 'channel'], ['reply', 'channel'], ['other-post', 'other-channel']]) {
    steps.push(row('CollaborationBoardPost', { id, content_object_id: content.id, character_count: 13n, created_at: NOW }), row('CollaborationBoardPostChannelLink', { id: `${id}-channel`, post_id: id, channel_id: channel, created_at: NOW }), row('CollaborationBoardPostSourceLink', { id: `${id}-source`, post_id: id, source_kind: 'tool', source_key: id, conversation_id: 'sender', source_turn_id: null, source_tool_call_id: null, created_at: NOW }));
  }
  steps.push(row('CollaborationBoardReplyLink', { id: 'reply-link', post_id: 'reply', thread_id: 'post', created_at: NOW }));
  await database.transaction(steps);
  await new kernel.ConversationDeletionControlPlane(database).delete('target');
  assert.equal(await get(database, 'CollaborationBoardPost', 'post'), null);
  assert.equal(await get(database, 'CollaborationBoardPost', 'reply'), null);
  assert.equal(await get(database, 'CollaborationBoardChannel', 'channel'), null);
  assert.ok(await get(database, 'CollaborationBoardPost', 'other-post'));
  assert.ok(await get(database, 'ContentObject', content.id));
}));


test('live collaboration feed includes only source and destination envelopes with a bounded text preview', async () => withRuntime(async (runtime) => {
  const { database } = runtime;
  const feed = new kernel.BoundedClientFeed(database);
  const received = [];
  try {
    const connection = await feed.connect({ activeConversationId: 'target', send: message => received.push(message) });
    feed.acknowledge({ sessionId: connection.sessionId, hostBootId: connection.hostBootId, messageSeq: received[0].messageSeq });
    const body = `开头 ${'协作😀'.repeat(400)} TAIL_MARKER_NOT_IN_PREVIEW`;
    await seedMessage(runtime, 'visible-live', 'followup', 'target', body);
    await new Promise(resolve => setImmediate(resolve));
    const update = received.at(-1);
    assert.equal(update.type, 'reliable-kernel.changes');
    const live = update.changes.find(change => change.type === 'CollaborationMessage' && change.id === 'visible-live');
    assert.ok(live);
    const preview = live.record.text_preview;
    assert.equal(Array.from(preview).length, 320, 'the preview is bounded by characters, never by UTF-16 units or bytes');
    assert.ok(preview.startsWith('开头 协作😀'));
    assert.ok(preview.endsWith('…'));
    assert.doesNotMatch(preview, /TAIL_MARKER_NOT_IN_PREVIEW/);
    assert.equal(JSON.stringify(update).includes('TAIL_MARKER_NOT_IN_PREVIEW'), false, 'the full body never enters the feed');
    const snapshot = (await database.clientProjectionSnapshot('target')).snapshot.subagentDeliverySummary;
    assert.equal(snapshot.collaborationMessages.find(message => message.id === 'visible-live').text_preview, preview);
    assert.ok(update.changes.some(change => change.type === 'CollaborationMessageSourceLink'));
    assert.ok(update.changes.some(change => change.type === 'CollaborationMessageTargetLink'));
    feed.acknowledge({ sessionId: connection.sessionId, hostBootId: connection.hostBootId, messageSeq: update.messageSeq });
    const before = received.length;
    await seedMessage(runtime, 'not-visible-live', 'message', 'unrelated');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(received.length, before);
  } finally { feed.close(); }
}));

test('collaboration snapshot ships its peers as their own set with the sidebar title, beyond the navigation window', async () => withRuntime(async (runtime) => {
  const { database, store } = runtime;
  const LATER = '2026-09-23T00:00:00.000Z';
  // The placeholder-titled sender shows its first user message in the sidebar.
  const firstUser = await store.ingest(database, JSON.stringify({ role: 'user', parts: [{ text: '调研登录流程' }] }), 'application/vnd.limcode.message+json');
  await database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').update('sender', { title: '新对话', updated_at: NOW }),
    row('Message', { id: 'sender-first', created_at: NOW, updated_at: NOW, deleted_at: null }),
    row('MessageRevision', { id: 'sender-first-revision', message_id: 'sender-first', revision_seq: 1n, role: 'user', content_object_id: firstUser.id, created_at: NOW }),
    row('MessageCurrentRevisionLink', { id: 'sender-first-current', message_id: 'sender-first', revision_id: 'sender-first-revision', updated_at: NOW }),
    row('MessagePartOfConversation', { id: 'sender-first-member', conversation_id: 'sender', message_id: 'sender-first', message_seq: 1n, created_at: NOW }),
    row('Conversation', { id: 'gone', title: '已删的对话', status: 'active', created_at: NOW, updated_at: NOW }),
    // Newer conversations (for example child tasks) push the idle peers out of the navigation list.
    ...Array.from({ length: 205 }, (_value, index) => row('Conversation', { id: `busy-${index}`, title: `busy ${index}`, status: 'active', created_at: LATER, updated_at: LATER }))
  ]);
  await seedMessage(runtime, 'from-sender');
  await seedMessage(runtime, 'from-gone', 'message', 'target', 'from a peer that is deleted later', 'gone');
  await seedMessage(runtime, 'to-unrelated', 'message', 'unrelated', 'not ours', 'sender');
  await new kernel.ConversationDeletionControlPlane(database).delete('gone');

  const snapshot = (await database.clientProjectionSnapshot('target')).snapshot;
  const navigation = snapshot.navigationSummary.conversations.map((value) => value.id);
  assert.equal(navigation.includes('sender'), false, 'the peer is outside the bounded navigation list');
  const peers = Object.fromEntries(snapshot.subagentDeliverySummary.collaborationPeerConversations.map((value) => [value.id, value]));
  assert.deepEqual(Object.keys(peers).sort(), ['gone', 'sender'], 'exactly the peers of the loaded links');
  assert.equal(peers.sender.status, 'active');
  assert.equal(peers.sender.title, '新对话');
  assert.equal(peers.sender.display_title, '调研登录流程', 'the same title the sidebar shows for a placeholder title');
  assert.deepEqual(peers.gone, { id: 'gone', title: null, status: 'deleted', display_title: null }, 'a peer removed from the Runtime is known to be deleted');
}));

test('collaboration request identity cannot be rewritten and no per-conversation grant domain exists', () => {
  assert.throws(() => kernel.DOMAIN_REPOSITORIES.domain('CollaborationRequest').update('request', { message_id: 'other' }), /immutable|not mutable|cannot|not allowed/);
  assert.throws(() => kernel.DOMAIN_REPOSITORIES.domain('ConversationCommunicationLink'), /ConversationCommunicationLink|unknown|Unknown|not registered/);
});

test('collaboration snapshot bounds messages by durable sequence even at identical timestamps', async () => withRuntime(async (runtime) => {
  const { database } = runtime;
  for (let index = 0; index < 35; index += 1) await seedMessage(runtime, `seq-${35 - index}`);
  const summary = (await database.clientProjectionSnapshot('target')).snapshot.subagentDeliverySummary;
  assert.equal(summary.collaborationMessages.length, 32);
  assert.equal(summary.collaborationMessages[0].id, 'seq-1');
  assert.equal(summary.collaborationMessages.at(-1).id, 'seq-32');
  assert.equal(summary.collaborationMessageSourceLinks.length, 32);
  assert.equal(summary.collaborationMessageTargetLinks.length, 32);
}));
