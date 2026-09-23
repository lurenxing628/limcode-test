import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));
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
async function seedMessage({ database, store }, id, mode = 'message', target = 'target', text = `body of ${id}`, source = 'sender', turns = {}) {
  const payload = await store.ingest(database, text, 'text/vnd.limcode.collaboration-message');
  const delivered = turns.deliveredTurnId ?? null;
  const deliveryState = turns.deliveryState ?? (delivered ? 'consumed' : 'pending');
  await database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('CollaborationMessage').insertWithNextSequence({ id, dedupe_key: id, mode, created_at: NOW }, { column: 'message_seq', scope: {} }),
    row('CollaborationMessageSourceLink', { id: `${id}-source`, message_id: id, conversation_id: source, source_kind: 'tool', source_key: id, turn_id: turns.sourceTurnId ?? null, tool_call_id: null, created_at: NOW }),
    row('RuntimeInboxItem', { id: `${id}-inbox`, dedupe_key: id, source_kind: 'collaboration_message', source_id: id, state: 'available', created_at: NOW, updated_at: NOW }),
    row('CollaborationMessageTargetLink', { id: `${id}-target`, message_id: id, conversation_id: target, inbox_item_id: `${id}-inbox`, anchor_turn_id: null, created_at: NOW }),
    row('CollaborationMessagePayloadLink', { id: `${id}-payload`, message_id: id, content_object_id: payload.id, created_at: NOW }),
    row('RuntimeDelivery', { id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: target, target_turn_id: delivered, phase: 'next_turn', attempt_seq: 1n, retry_of_delivery_id: null, state: deliveryState, failure_reason: deliveryState === 'failed' ? 'target-gone' : null, created_at: NOW, updated_at: NOW }),
    ...(deliveryState === 'consumed' ? [row('RuntimeDeliveryInputLink', { id: `${id}-input`, delivery_id: `${id}-delivery`, pending_turn_input_id: `${id}-pending-input`, handled_at: NOW, created_at: NOW, updated_at: NOW })] : [])
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
  const { CollaborationControlPlane } = require(path.join(compiled, 'backend/reliableKernel/collaborationControlPlane.js'));
  const { RuntimeDeliveryControlPlane } = require(path.join(compiled, 'backend/reliableKernel/answerDelivery.js'));
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

test('the sender sees the target delivery of its own outgoing message, including a later failure', async () => withRuntime(async (runtime) => {
  const { database } = runtime;
  await database.transaction([row('Turn', { id: 'sender-turn', conversation_id: 'sender', status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW })]);
  await seedMessage(runtime, 'outgoing', 'message', 'target', 'hello', 'sender', { sourceTurnId: 'sender-turn' });
  await seedMessage(runtime, 'not-ours', 'message', 'unrelated', 'between others', 'target');
  const summary = (await database.clientProjectionSnapshot('sender')).snapshot.subagentDeliverySummary;
  assert.ok(summary.collaborationMessages.some((value) => value.id === 'outgoing'));
  assert.deepEqual(summary.runtimeDeliveries.map((value) => [value.id, value.state]), [['outgoing-delivery', 'pending']],
    'only the deliveries of this Conversation’s own outgoing messages');
  const feed = new kernel.BoundedClientFeed(database);
  const received = [];
  try {
    const connection = await feed.connect({ activeConversationId: 'sender', send: (message) => received.push(message) });
    feed.acknowledge({ sessionId: connection.sessionId, hostBootId: connection.hostBootId, messageSeq: received[0].messageSeq });
    await database.transaction([kernel.DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update('outgoing-delivery', { state: 'failed', failure_reason: 'target-gone', updated_at: NOW })]);
    await new Promise((resolve) => setImmediate(resolve));
    const update = received.at(-1);
    assert.equal(update.type, 'reliable-kernel.changes');
    const change = update.changes.find((value) => value.type === 'RuntimeDelivery' && value.id === 'outgoing-delivery');
    assert.equal(change?.record?.state, 'failed', 'the failure reaches the sender live');
    feed.acknowledge({ sessionId: connection.sessionId, hostBootId: connection.hostBootId, messageSeq: update.messageSeq });
    const before = received.length;
    await database.transaction([kernel.DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update('not-ours-delivery', { state: 'failed', failure_reason: 'target-gone', updated_at: NOW })]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, before, 'deliveries of other Conversations’ messages stay out');
  } finally { feed.close(); }
}));

test('a new outgoing message and a retry of its delivery reach the connected sender live', async () => withRuntime(async (runtime) => {
  const { database } = runtime;
  await database.transaction([row('Turn', { id: 'sender-turn', conversation_id: 'sender', status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW })]);
  const feed = new kernel.BoundedClientFeed(database);
  const received = [];
  const settle = async () => {
    await new Promise((resolve) => setImmediate(resolve));
    const update = received.at(-1);
    assert.equal(update.type, 'reliable-kernel.changes');
    feed.acknowledge({ sessionId: update.sessionId, hostBootId: update.hostBootId, messageSeq: update.messageSeq });
    return update;
  };
  try {
    const connection = await feed.connect({ activeConversationId: 'sender', send: (message) => received.push(message) });
    feed.acknowledge({ sessionId: connection.sessionId, hostBootId: connection.hostBootId, messageSeq: received[0].messageSeq });
    await seedMessage(runtime, 'fresh', 'message', 'target', 'sent while connected', 'sender', { sourceTurnId: 'sender-turn' });
    let update = await settle();
    assert.equal(update.changes.find((value) => value.type === 'RuntimeDelivery' && value.id === 'fresh-delivery')?.record?.state, 'pending',
      'the delivery of a message sent after the snapshot reaches the sender');
    await database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update('fresh-delivery', { state: 'failed', failure_reason: 'wake-dead-letter:retry', updated_at: NOW }),
      row('RuntimeDelivery', { id: 'fresh-delivery-2', inbox_item_id: 'fresh-inbox', target_conversation_id: 'target', target_turn_id: null, phase: 'next_turn', attempt_seq: 2n,
        retry_of_delivery_id: 'fresh-delivery', state: 'pending', failure_reason: null, created_at: NOW, updated_at: NOW })
    ]);
    update = await settle();
    assert.equal(update.changes.find((value) => value.type === 'RuntimeDelivery' && value.id === 'fresh-delivery-2')?.record?.attempt_seq, '2',
      'a retry attempt reaches the sender too, so the newest attempt decides the card');
    const before = received.length;
    await seedMessage(runtime, 'others', 'message', 'unrelated', 'between others', 'target');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, before, 'deliveries of other Conversations’ new messages stay out');
  } finally { feed.close(); }
}));

test('a snapshot without an active conversation carries the same subagent sections as one with it', async () => withRuntime(async (runtime) => {
  const { database } = runtime;
  const withConversation = (await database.clientProjectionSnapshot('target')).snapshot.subagentDeliverySummary;
  const withoutConversation = (await database.clientProjectionSnapshot(null)).snapshot.subagentDeliverySummary;
  assert.deepEqual(Object.keys(withoutConversation).sort(), Object.keys(withConversation).sort());
  assert.ok(Object.values(withoutConversation).every((value) => Array.isArray(value) && value.length === 0));
}));

test('collaboration request identity cannot be rewritten and no per-conversation grant domain exists', () => {
  assert.throws(() => kernel.DOMAIN_REPOSITORIES.domain('CollaborationRequest').update('request', { message_id: 'other' }), /immutable|not mutable|cannot|not allowed/);
  assert.throws(() => kernel.DOMAIN_REPOSITORIES.domain('ConversationCommunicationLink'), /ConversationCommunicationLink|unknown|Unknown|not registered/);
});

test('collaboration snapshot keeps the cards of every loaded Turn instead of only the newest 32 messages', async () => withRuntime(async (runtime) => {
  const { database } = runtime;
  const LATER = '2026-09-23T00:00:00.000Z';
  await database.transaction([
    row('Turn', { id: 'target-old-turn', conversation_id: 'target', status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
    row('Turn', { id: 'target-new-turn', conversation_id: 'target', status: 'terminated', created_at: LATER, updated_at: LATER, terminal_at: LATER })
  ]);
  for (let index = 0; index < 30; index += 1) {
    await seedMessage(runtime, `delivered-${index}`, 'message', 'target', `delivered ${index}`, 'sender', { deliveredTurnId: 'target-old-turn' });
  }
  for (let index = 0; index < 30; index += 1) {
    await seedMessage(runtime, `sent-${index}`, 'message', 'sender', `sent ${index}`, 'target', { sourceTurnId: 'target-new-turn' });
  }
  await seedMessage(runtime, 'queued', 'followup', 'target', 'waits for the next Turn');
  await seedMessage(runtime, 'failed', 'message', 'target', 'never delivered', 'sender', { deliveryState: 'failed' });
  await seedMessage(runtime, 'elsewhere', 'message', 'target', 'bound to a Turn this view does not load', 'sender', { deliveredTurnId: 'unloaded-turn' });
  await seedMessage(runtime, 'foreign', 'message', 'unrelated', 'between other Conversations', 'sender', { sourceTurnId: 'target-new-turn' });

  const summary = (await database.clientProjectionSnapshot('target')).snapshot.subagentDeliverySummary;
  const ids = new Set(summary.collaborationMessages.map((value) => value.id));
  for (let index = 0; index < 30; index += 1) {
    assert.ok(ids.has(`delivered-${index}`), `delivered-${index} belongs to a loaded Turn`);
    assert.ok(ids.has(`sent-${index}`), `sent-${index} belongs to a loaded Turn`);
  }
  assert.ok(ids.has('queued'), 'a message still waiting for a Turn stays visible');
  assert.ok(ids.has('failed'), 'a failed delivery stays visible');
  assert.equal(ids.has('elsewhere'), false);
  assert.equal(ids.has('foreign'), false);
  assert.equal(summary.collaborationMessages.length, 62);
  const deliveries = new Set(summary.runtimeDeliveries.map((value) => value.id));
  for (let index = 0; index < 30; index += 1) assert.ok(deliveries.has(`delivered-${index}-delivery`), 'each incoming card has its delivery');
}));

test('collaboration snapshot stays bounded by durable sequence even at identical timestamps', async () => withRuntime(async (runtime) => {
  const { database } = runtime;
  for (let index = 0; index < 205; index += 1) await seedMessage(runtime, `seq-${205 - index}`);
  const summary = (await database.clientProjectionSnapshot('target')).snapshot.subagentDeliverySummary;
  assert.equal(summary.collaborationMessages.length, 200);
  assert.equal(summary.collaborationMessages[0].id, 'seq-1');
  assert.equal(summary.collaborationMessages.at(-1).id, 'seq-200');
  assert.equal(summary.collaborationMessageSourceLinks.length, 200);
  assert.equal(summary.collaborationMessageTargetLinks.length, 200);
}));

test('the collaboration snapshot starts from the conversation links, never scans every message, and selects the same rows', async () => {
  const Database = require('better-sqlite3');
  const { createRuntimeSchemaSql } = require(path.join(compiled, 'backend/reliableKernel/schema/domainManifest.js'));
  const { queryCollaborationMessagesForTurns } = require(path.join(compiled, 'backend/reliableKernel/clientProjection.js'));
  const db = new Database(':memory:');
  try {
    db.defaultSafeIntegers(true);
    db.pragma('foreign_keys = OFF');
    for (const statement of createRuntimeSchemaSql()) db.exec(statement);
    const insert = {
      message: db.prepare('INSERT INTO collaboration_message (id, dedupe_key, message_seq, mode, created_at) VALUES (?, ?, ?, ?, ?)'),
      source: db.prepare('INSERT INTO collaboration_message_source_link (id, message_id, conversation_id, source_kind, source_key, turn_id, tool_call_id, board_post_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)'),
      target: db.prepare('INSERT INTO collaboration_message_target_link (id, message_id, conversation_id, inbox_item_id, anchor_turn_id, created_at) VALUES (?, ?, ?, ?, NULL, ?)'),
      delivery: db.prepare('INSERT INTO runtime_delivery (id, inbox_item_id, target_conversation_id, target_turn_id, phase, attempt_seq, retry_of_delivery_id, state, failure_reason, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?)')
    };
    let seq = 0;
    const add = (from, to, sourceTurn, deliveries) => {
      const id = `m${seq}`;
      insert.message.run(id, `k${seq}`, BigInt(seq), 'message', NOW);
      insert.source.run(`s${seq}`, id, from, 'tool', `sk${seq}`, sourceTurn, NOW);
      insert.target.run(`t${seq}`, id, to, `i${seq}`, NOW);
      deliveries.forEach(([target, turn, state], attempt) => insert.delivery.run(`d${seq}-${attempt}`, `i${seq}`, target, turn, 'next_turn', BigInt(attempt + 1), state, NOW, NOW));
      seq += 1;
      return id;
    };
    db.transaction(() => {
      // Traffic between other conversations fills the table.
      for (let i = 0; i < 20000; i += 1) {
        const from = `c${i % 400}`, to = `c${(i + 1) % 400}`;
        add(from, to, `turn-${from}`, [[to, `turn-${to}`, 'consumed']]);
      }
      // Every case of the selected conversation X, loaded Turns turn-x-1 and turn-x-2.
      add('x', 'c1', 'turn-x-1', [['c1', 'turn-c1', 'consumed']]);
      add('x', 'c1', 'turn-x-old', [['c1', null, 'pending']]);
      add('c2', 'x', 'turn-c2', [['x', 'turn-x-2', 'consumed']]);
      add('c2', 'x', 'turn-c2', [['x', 'turn-x-old', 'consumed']]);
      add('c3', 'x', 'turn-c3', [['x', null, 'pending']]);
      add('c3', 'x', 'turn-c3', [['x', null, 'failed']]);
      add('c3', 'x', 'turn-c3', [['x', null, 'failed'], ['x', 'turn-x-old', 'consumed']]);
      add('c4', 'c5', 'turn-x-1', [['x', 'turn-x-1', 'consumed']]);
    })();
    const legacy = (turnIds) => {
      const parameters = { conversationId: 'x', limit: 200n };
      const list = turnIds.map((id, index) => { parameters[`turn${index}`] = id; return `@turn${index}`; }).join(',');
      const inLoaded = (column) => list ? `${column} IN (${list})` : '0';
      return db.prepare(`SELECT message.* FROM collaboration_message AS message
         WHERE EXISTS (SELECT 1 FROM collaboration_message_source_link AS source
                 WHERE source.message_id = message.id AND source.conversation_id = @conversationId AND ${inLoaded('source.turn_id')})
            OR EXISTS (SELECT 1 FROM collaboration_message_target_link AS target
                  JOIN runtime_delivery AS delivery ON delivery.inbox_item_id = target.inbox_item_id AND delivery.target_conversation_id = @conversationId
                 WHERE target.message_id = message.id AND target.conversation_id = @conversationId
                   AND (delivery.state IN ('pending', 'failed') OR ${inLoaded('delivery.target_turn_id')}))
         ORDER BY message.message_seq DESC, message.id DESC LIMIT @limit`).all(parameters);
    };
    for (const turnIds of [['turn-x-1', 'turn-x-2'], [], ['turn-x-old']]) {
      assert.deepEqual(queryCollaborationMessagesForTurns(db, 'x', turnIds), legacy(turnIds), `same rows for loaded Turns ${turnIds.join(',')}`);
    }
    assert.deepEqual(queryCollaborationMessagesForTurns(db, 'x', ['turn-x-1', 'turn-x-2']).map((row) => row.id), ['m20006', 'm20005', 'm20004', 'm20002', 'm20000']);

    const captured = [];
    const recording = { prepare(sql) { captured.push(sql); return db.prepare(sql); } };
    const loaded = Array.from({ length: 200 }, (_value, index) => `turn-x-${index}`);
    queryCollaborationMessagesForTurns(recording, 'x', loaded);
    const parameters = { conversationId: 'x', limit: 200n, ...Object.fromEntries(loaded.map((id, index) => [`turn${index}`, id])) };
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${captured[0]}`).all(parameters).map((row) => row.detail);
    assert.equal(plan.some((detail) => /^SCAN (message|collaboration_message)\b/.test(detail)), false, `no full scan of the message table:\n${plan.join('\n')}`);
    const time = (run) => { const start = process.hrtime.bigint(); for (let round = 0; round < 20; round += 1) run(); return Number(process.hrtime.bigint() - start) / 20e6; };
    console.log(`COLLABORATION_SNAPSHOT_QUERY messages=${seq} legacy=${time(() => legacy(loaded)).toFixed(2)}ms current=${time(() => queryCollaborationMessagesForTurns(db, 'x', loaded)).toFixed(2)}ms`);
  } finally { db.close(); }
});

test('the snapshot byte limit drops a collaboration message with its peer delivery, inbox item and peer row, and stops their live updates', async () => withRuntime(async ({ database }) => {
  const { CLIENT_SNAPSHOT_MAX_BYTES } = require(path.join(compiled, 'backend/reliableKernel/clientFeedBounds.js'));
  const wireBytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  // Just under the per-record summary bound, so each row keeps its identity and its full weight.
  const padded = (record) => ({ ...record, ...Object.fromEntries(Array.from({ length: 7 }, (_value, index) => [`padding_${index}`, 'x'.repeat(240)])) });
  // The real snapshot shape of `target`, as plain wire data.
  const projection = JSON.parse(JSON.stringify((await database.clientProjectionSnapshot('target')).snapshot,
    (_key, value) => typeof value === 'bigint' ? value.toString() : value));
  const subagents = projection.subagentDeliverySummary;
  const outgoing = Array.from({ length: 200 }, (_value, index) => `out-${String(199 - index).padStart(3, '0')}`);
  for (const id of outgoing) {
    const peer = `peer-${id.slice(4)}`;
    subagents.collaborationMessages.push(padded({ id, message_seq: String(Number(id.slice(4)) + 1), mode: 'message', created_at: NOW }));
    subagents.collaborationMessageSourceLinks.push(padded({ id: `${id}-source`, message_id: id, conversation_id: 'target', source_kind: 'tool', turn_id: null }));
    subagents.collaborationMessageTargetLinks.push(padded({ id: `${id}-target`, message_id: id, conversation_id: peer, inbox_item_id: `${id}-inbox` }));
    subagents.runtimeDeliveries.push(padded({ id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: peer, target_turn_id: null, state: 'pending', attempt_seq: '1' }));
    subagents.runtimeInboxItems.push(padded({ id: `${id}-inbox`, source_kind: 'collaboration_message', source_id: id, state: 'available' }));
    subagents.collaborationPeerConversations.push(padded({ id: peer, title: peer, status: 'active', display_title: peer }));
  }
  // The selected Conversation's own queue is not collaboration data and is never trimmed with it.
  const own = Array.from({ length: 850 }, (_value, index) => `own-${index}`);
  for (const id of own) {
    subagents.runtimeDeliveries.push(padded({ id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: 'target', target_turn_id: null, state: 'pending', attempt_seq: '1' }));
    subagents.runtimeInboxItems.push(padded({ id: `${id}-inbox`, source_kind: 'child_execution', source_id: id, state: 'available' }));
  }
  assert.ok(wireBytes(projection) > CLIENT_SNAPSHOT_MAX_BYTES, 'the projection needs trimming');

  let commit;
  const received = [];
  const feed = new kernel.BoundedClientFeed({
    hostBootId: 'collaboration-trim',
    async externalDataVersion() { return '1'; },
    async clientProjectionSnapshotAndSubscribe(_conversationId, listener) {
      commit = listener;
      return { barrier: { snapshotCommitSeq: '1', snapshot: projection }, unsubscribe() {} };
    }
  });
  try {
    const connection = await feed.connect({ activeConversationId: 'target', send: (message) => received.push(message) });
    const snapshot = received[0];
    assert.ok(wireBytes(snapshot) <= CLIENT_SNAPSHOT_MAX_BYTES);
    const summary = snapshot.projections.subagentDeliverySummary;
    const kept = new Set(summary.collaborationMessages.map((value) => value.id));
    assert.ok(kept.size > 0 && kept.size < outgoing.length, `some collaboration messages were trimmed (kept ${kept.size})`);
    assert.ok(kept.has('out-199') && !kept.has('out-000'), 'the oldest go first');
    const keptTargets = new Set(summary.collaborationMessageTargetLinks.map((link) => `${link.inbox_item_id}\0${link.conversation_id}`));
    assert.deepEqual(summary.runtimeDeliveries.filter((delivery) => delivery.target_conversation_id !== 'target'
      && !keptTargets.has(`${delivery.inbox_item_id}\0${delivery.target_conversation_id}`)).map((delivery) => delivery.id), [],
      'no delivery to the peer of a trimmed message is left behind');
    assert.equal(summary.runtimeDeliveries.filter((delivery) => delivery.target_conversation_id === 'target').length, own.length);
    const keptInbox = new Set(summary.runtimeDeliveries.map((delivery) => delivery.inbox_item_id));
    assert.deepEqual(summary.runtimeInboxItems.filter((item) => !keptInbox.has(item.id)).map((item) => item.id), []);
    const namedPeers = new Set([...summary.collaborationMessageSourceLinks, ...summary.collaborationMessageTargetLinks].map((link) => link.conversation_id));
    assert.deepEqual(summary.collaborationPeerConversations.filter((peer) => !namedPeers.has(peer.id)).map((peer) => peer.id), [],
      'a peer no kept message names is dropped too');
    assert.equal(summary.collaborationPeerConversations.length, kept.size);

    feed.acknowledge({ sessionId: connection.sessionId, hostBootId: connection.hostBootId, messageSeq: snapshot.messageSeq });
    const update = (id) => ({ domain: 'RuntimeDelivery', kind: 'upsert', id: `${id}-delivery`,
      record: { id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: `peer-${id.slice(4)}`, target_turn_id: null, state: 'failed', attempt_seq: '1' } });
    commit({ commitSeq: '2', changes: [update('out-000')], allocatedSequences: [] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(received.length, 1, 'a trimmed message no longer receives its peer delivery live');
    commit({ commitSeq: '3', changes: [update('out-199')], allocatedSequences: [] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(received.at(-1)?.changes?.map((change) => change.id), ['out-199-delivery'], 'a kept message still does');
  } finally { feed.close(); }

  const contract = JSON.parse(await fs.readFile('docs/architecture/reliable-kernel/contracts/client-feed.json', 'utf8'));
  assert.equal(contract.collaborationProjection.byteLimitTrim,
    'a-collaboration-message-trimmed-under-snapshot-maxBytes-takes-its-links-requests-deliveries-to-its-peer-their-inbox-items-and-a-peer-row-no-kept-link-names; '
    + 'oldest-message_seq-first; deliveries-to-the-selected-conversation-stay');
}));
