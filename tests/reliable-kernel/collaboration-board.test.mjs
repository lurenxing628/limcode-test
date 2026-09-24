import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, 'backend/reliableKernel', file));
const { RootAuthority } = load('rootAuthority.js');
const { RuntimeDatabase } = load('runtimeDatabase.js');
const { initializeEmptyRuntimeRoot } = load('runtimeDatabase.js');
const { ContentAddressedStore } = load('contentAddressedStore.js');
const { preparedContentObjectSteps } = load('contentObjectTransaction.js');
const { DOMAIN_REPOSITORIES } = load('repositories.js');
const { CollaborationBoard } = load('collaborationBoard.js');
const repo = domain => DOMAIN_REPOSITORIES.domain(domain);
const now = '2026-09-22T00:00:00.000Z';

async function fixture(run, notify) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-agent-board-'));
  const authority = new RootAuthority(() => path.join(directory, 'runtime'));
  await initializeEmptyRuntimeRoot(authority);
  let database = await RuntimeDatabase.open(authority);
  const store = new ContentAddressedStore(authority, database.binding);
  let clock = 0;
  const timestamp = () => new Date(Date.parse(now) + ++clock).toISOString();
  let board = new CollaborationBoard(database, store, { now: timestamp, notify });
  const rows = async (domain, where = {}) => (await database.snapshot([repo(domain).list({ where, limit: 1000 })])).snapshot[0];
  let command = 0;
  const calls = new Set();
  // Every board mutation is attributed to a live model ToolCall; there is no user-side board entry.
  const tool = async (id, conversationId) => {
    if (!calls.has(id)) {
      const content = await store.prepare(database, '{}', 'application/json');
      await database.transaction([...preparedContentObjectSteps([content], 'fixture_tool'), repo('ToolCall').insert({ id, turn_id: `${conversationId}-turn`, call_seq: BigInt(++command), tool_name: 'agent_board', status: 'pending', arguments_object_id: content.metadata.id, created_at: now, updated_at: now })]);
      calls.add(id);
    }
    return { conversationId, turnId: `${conversationId}-turn`, toolCallId: id };
  };
  let callId = 0;
  const call = async (conversationId, args, toolCallId = `board-call-${++callId}`) => board.execute(await tool(toolCallId, conversationId), args);
  try {
    await database.transaction(['root', 'sibling', 'idle', 'outsider'].map(id => repo('Conversation').insert({ id, title: id, status: 'active', created_at: now, updated_at: now })));
    await database.transaction(['root', 'sibling', 'idle', 'outsider'].map(id => repo('Turn').insert({ id: `${id}-turn`, conversation_id: id, status: 'active', created_at: now, updated_at: now, terminal_at: null })));
    await database.transaction(['sibling', 'idle'].flatMap(id => [
      repo('ChildExecution').insert({ id: `${id}-child`, child_conversation_id: id, status: id === 'idle' ? 'idle' : 'active', created_at: now, updated_at: now }),
      repo('ChildExecutionParentLink').insert({ id: `${id}-parent`, child_execution_id: `${id}-child`, source_tool_call_id: `${id}-spawn`, parent_child_execution_id: null, parent_turn_id: 'root-turn', created_at: now })
    ]));
    await run({ get database() { return database; }, get board() { return board; }, store, rows, call, tool,
      async reopen() { await database.close(); database = await RuntimeDatabase.open(authority); board = new CollaborationBoard(database, store, { now: timestamp, notify }); },
      async idle(conversationId) {
        await database.transaction([
          repo('Turn').update(`${conversationId}-turn`, { status: 'terminated', terminal_at: now, updated_at: now }),
          repo('TurnTermination').insert({ id: `${conversationId}-done`, turn_id: `${conversationId}-turn`, terminal_status: 'completed', reason: 'fixture', created_at: now })
        ]);
      }
    });
  } finally { await database.close(); await fs.rm(directory, { recursive: true, force: true }); }
}

test('board derives sibling scope, preserves CAS text across reopen and rejects unrelated conversations', async () => {
  await fixture(async f => {
    const { channel } = await f.call('root', { operation: 'create_channel', name: 'Research' });
    assert.equal(channel.name, 'research');
    assert.equal(typeof channel.createdAt, 'number');
    const post = await f.call('sibling', { operation: 'post', channelId: channel.id, text: 'Shared investigation 中文 🛰️' });
    await assert.rejects(f.call('outsider', { operation: 'read_post', postId: post.postId }), /task tree/);
    await assert.rejects(f.call('outsider', { operation: 'post', channelId: channel.id, text: 'inject' }), /task tree/);
    await assert.rejects(f.call('root', { operation: 'post', channelId: channel.id, text: 'notify external', notifyConversationIds: ['outsider'] }), /outside/);
    await f.reopen();
    const read = await f.call('root', { operation: 'read_post', postId: post.postId });
    assert.equal(read.text, 'Shared investigation 中文 🛰️');
    assert.equal(read.post.authorKind, 'tool');
    assert.equal(read.post.authorConversationId, 'sibling');
    assert.equal((await f.rows('CollaborationBoardPost')).length, 1);
    const [source] = await f.rows('CollaborationBoardPostSourceLink');
    assert.equal(source.source_kind, 'tool');
    assert.equal(source.source_turn_id, 'sibling-turn');
    assert.ok(source.source_tool_call_id);
  });
});

test('tool provenance is verified; exactly-once command retry cannot change body or resurrect subscriptions', async () => {
  await fixture(async f => {
    const { channel } = await f.call('root', { operation: 'create_channel', name: 'general' });
    const source = await f.tool('board-call', 'root');
    const args = { operation: 'post', channelId: channel.id, text: 'tool-authored message' };
    const [one, duplicate] = await Promise.all([f.board.execute(source, args), f.board.execute(source, args)]);
    assert.equal(one.postId, duplicate.postId);
    assert.equal([one, duplicate].filter(result => result.deduplicated).length, 1);
    assert.equal((await f.rows('CollaborationBoardPost')).length, 1);
    assert.equal((await f.call('root', { operation: 'read_post', postId: one.postId })).post.authorKind, 'tool');
    await assert.rejects(f.board.execute(source, { ...args, text: 'changed' }), /reused/);
    await assert.rejects(f.board.execute({ ...source, conversationId: 'sibling' }, args), /source Turn/);
    const subscribe = { operation: 'subscribe', channelId: channel.id };
    await f.call('sibling', subscribe, 'subscribe-once');
    await f.call('sibling', { operation: 'unsubscribe', channelId: channel.id });
    assert.equal((await f.call('sibling', subscribe, 'subscribe-once')).deduplicated, true);
    await assert.rejects(f.board.execute({ conversationId: 'root', turnId: 'root-turn', toolCallId: 'missing-call' }, { operation: 'list_channels' }), /ToolCall identity/);
    assert.equal((await f.call('sibling', { operation: 'list_channels' })).channels[0].subscribed, false);
  });
});

test('root and reply subscriptions notify running members only; failure preserves posts and retry never replays notices', async () => {
  const notices = [];
  await fixture(async f => {
    const { channel } = await f.call('root', { operation: 'create_channel', name: 'notices' });
    for (const conversation of ['sibling', 'idle']) await f.call(conversation, { operation: 'subscribe', channelId: channel.id });
    await f.idle('idle');
    const args = { operation: 'post', channelId: channel.id, text: 'root discussion' };
    const post = await f.call('root', args, 'notice-post');
    assert.deepEqual(new Set(post.notifications.map(item => item.status)), new Set(['failed', 'skipped_idle']));
    assert.equal(notices.length, 1);
    const retry = await f.call('root', args, 'notice-post');
    assert.equal(retry.notificationReplay, 'not_replayed');
    assert.equal(notices.length, 1);
    assert.equal((await f.call('sibling', { operation: 'read_post', postId: post.postId })).text, 'root discussion');
    const reply = await f.call('sibling', { operation: 'post', threadId: post.threadId, text: 'reply' });
    assert.equal(reply.notifications.length, 1, 'thread author was automatically subscribed');
    assert.equal(reply.notifications[0].targetConversationId, 'root');
    await assert.rejects(f.call('root', { operation: 'post', threadId: reply.postId, text: 'nested' }), /discussion root/);
    assert.equal((await f.call('sibling', { operation: 'read_thread', threadId: post.threadId })).subscribed, true);
  }, async notice => { notices.push(notice); throw new Error('offline'); });
});

test('bounded Unicode reads, case-insensitive search, scoped cursors and complete reply pagination', async () => {
  await fixture(async f => {
    const { channel } = await f.call('root', { operation: 'create_channel', name: 'paging' });
    const text = '😀中文AbC'.repeat(400);
    const root = await f.call('root', { operation: 'post', channelId: channel.id, text });
    let offset = 0; let full = '';
    do {
      const page = await f.call('sibling', { operation: 'read_post', postId: root.postId, offsetChars: offset, limitChars: 101 });
      full += page.text; offset = page.nextOffsetChars;
    } while (offset !== undefined);
    assert.equal(full, text);
    for (let i = 0; i < 5; i++) await f.call('sibling', { operation: 'post', threadId: root.threadId, text: `reply ${i}` });
    const ids = []; const previews = []; let cursor;
    do {
      const page = await f.call('root', { operation: 'read_thread', threadId: root.threadId, limit: 2, ...(cursor ? { cursor } : {}) });
      assert.equal(page.root.id, root.postId); assert.ok(page.replies.length <= 2);
      ids.push(...page.replies.map(item => item.id)); previews.push(...page.replies.map(item => item.preview)); cursor = page.nextCursor;
    } while (cursor);
    assert.equal(new Set(ids).size, 5);
    assert.deepEqual(previews, Array.from({ length: 5 }, (_, index) => `reply ${index}`));
    const search = await f.call('root', { operation: 'search', channelId: channel.id, query: 'abc' });
    assert.equal(search.posts.length, 1);
    assert.equal(search.posts[0].id, root.postId);
    const page = await f.call('root', { operation: 'search', channelId: channel.id, limit: 1 });
    await assert.rejects(f.call('root', { operation: 'search', channelId: channel.id, query: 'reply', cursor: page.nextCursor }), /cursor/);
    await assert.rejects(f.call('root', { operation: 'read_post', postId: root.postId, limitChars: 20001 }), /limitChars/);
    assert.equal((await f.call('root', { operation: 'list_threads', channelId: channel.id })).posts.length, 1);
  });
});

test('concurrent channel creation is one shared channel and strict arguments reject ignored mutations', async () => {
  await fixture(async f => {
    const [first, second] = await Promise.all([
      f.call('root', { operation: 'create_channel', name: 'Common', subscribe: false }),
      f.call('sibling', { operation: 'create_channel', name: 'COMMON', subscribe: false })
    ]);
    assert.deepEqual(first.channel, second.channel);
    assert.equal((await f.rows('CollaborationBoardChannel')).length, 1);
    assert.equal((await f.rows('CollaborationBoardChannelScopeLink')).length, 1);
    await assert.rejects(f.call('root', { operation: 'list_channels', query: 12 }), /query must be text/);
    await assert.rejects(f.call('root', { operation: 'list_threads', channelId: first.channel.id, text: 'silently mutate' }), /Unexpected/);
    await assert.rejects(f.call('root', { operation: 'list_channels', cursor: Buffer.from('null').toString('base64url') }), /cursor/);
  });
});
