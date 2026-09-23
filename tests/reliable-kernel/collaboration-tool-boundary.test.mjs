import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const root = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(root, file));
const { CollaborationToolDispatcher } = load('backend/reliableKernel/collaborationToolDispatcher.js');
const { buildModelHandleCatalog, resolveModelToolArguments, projectToolResultForModel } = load('backend/reliableKernel/modelHandleCatalog.js');
const { mergeConversationChildHandles, readConversationChildHandles } = load('backend/reliableKernel/conversationChildHandles.js');
const { agentCollaborationToolModules } = load('backend/world/modules/tools/definitions/agentCollaboration/index.js');
const { crossConversationToolModules } = load('backend/world/modules/tools/definitions/crossConversation/index.js');

const detail = { kind: 'agent_collaboration', conversationId: 'peer-one', messageId: 'message-one',
  channelId: 'channel-one', threadId: 'post-one', postId: 'post-one' };
const catalog = buildModelHandleCatalog([detail]);

test('collaboration short references retain distinct kinds, do not expose canonical IDs, and reject bypasses', () => {
  assert.deepEqual(projectToolResultForModel('agent_board', detail, catalog), {
    kind: 'agent_collaboration', conversationRef: 'C1', messageRef: 'M1', channelRef: 'H1', threadRef: 'T1', postRef: 'B1'
  });
  assert.deepEqual(resolveModelToolArguments('send_agent_message', { conversationRef: 'C1', text: 'hello', replyToMessageRef: 'M1' }, catalog), {
    targetConversationId: 'peer-one', text: 'hello', replyToMessageId: 'message-one'
  });
  assert.deepEqual(resolveModelToolArguments('agent_board', { operation: 'post', channelRef: 'H1', notifyConversationRefs: ['C1'] }, catalog), {
    operation: 'post', channelId: 'channel-one', notifyConversationIds: ['peer-one']
  });
  for (const args of [{ conversationRef: 'C99' }, { conversationRef: 'M1' }, { conversationRef: '' },
    { conversationRef: 1 }, { targetConversationId: 'peer-one' }, { conversationRef: 'C1', targetConversationId: 'peer-one' }]) {
    assert.throws(() => resolveModelToolArguments('send_agent_message', args, catalog), error => error.code === 'UNKNOWN_MODEL_HANDLE_REFERENCE');
  }
  assert.throws(() => resolveModelToolArguments('agent_board', { notifyConversationIds: ['peer-one'] }, catalog), error => error.code === 'UNKNOWN_MODEL_HANDLE_REFERENCE');
  const next = buildModelHandleCatalog([{ kind: 'agent_collaboration', conversationId: 'peer-two', messageId: 'message-two' }], catalog.entries);
  assert.equal(next.entries.find(entry => entry.target === 'peer-two').ref, 'C2');
  assert.equal(next.entries.find(entry => entry.target === 'message-two').ref, 'M2');
  assert.equal(mergeConversationChildHandles(catalog.entries).length, 5, 'same post ID can have both thread and post references');
  assert.deepEqual(buildModelHandleCatalog([{ conversationId: 'hidden-child', messageId: 'historical-chat' }]).entries, [], 'unrelated internal IDs are not collaboration references');
});

test('compressed and fork-copied recipes reserve collaboration references without scanning source conversations', async () => {
  const domains = {
    Turn: [{ id: 'fork-turn', conversation_id: 'fork', created_at: 'same' }],
    ModelRequest: [{ id: 'request', turn_id: 'fork-turn', request_seq: 1n, recipe_object_id: 'recipe' }],
    ContentObject: [{ id: 'recipe' }]
  };
  const database = {
    async snapshotAll(read) { return { snapshot: (domains[read.domain] ?? []).filter(row => Object.entries(read.where ?? {}).every(([key, value]) => row[key] === value)) }; },
    async snapshot(reads) { return { snapshot: reads.map(read => (domains[read.domain] ?? []).find(row => row.id === read.id)) }; }
  };
  const store = { async read() { return Buffer.from(JSON.stringify({ kind: 'reliable-context-compression', modelHandleCatalog: catalog })); } };
  assert.deepEqual(await readConversationChildHandles(database, store, 'fork'), mergeConversationChildHandles(catalog.entries));
  assert.deepEqual(await readConversationChildHandles(database, store, 'source'), []);
});

function fixture({ toolName = 'send_agent_message', args = { targetConversationId: 'peer', text: 'hello' }, crossConversation } = {}) {
  const document = { toolPolicy: { allowedTools: [toolName],
    ...(crossConversation === undefined ? {} : { toolConfigs: { run_agent: { config: { crossConversationCollaboration: crossConversation } } } }) } };
  const authority = { snapshotId: 'authority', document };
  const records = {
    AuthoritySnapshot: { id: 'authority', turn_id: 'turn', content_object_id: 'authority-content' },
    Turn: { id: 'turn', conversation_id: 'conversation', status: 'active' },
    ToolCall: { id: 'call', turn_id: 'turn', tool_name: toolName, arguments_object_id: 'arguments', status: 'pending' },
    ModelRequest: { id: 'request', turn_id: 'turn', authority_snapshot_id: 'authority' },
    ToolCallSourceLink: [{ id: 'source', tool_call_id: 'call', model_request_id: 'request' }]
  };
  const calls = [];
  const settlements = [];
  const dispatcher = new CollaborationToolDispatcher({
    database: { async snapshot(reads) { return { snapshot: reads.map(read => read.domain === 'ContentObject' ? { id: read.id } : records[read.domain]) }; } },
    contentStore: { async read(row) { return Buffer.from(JSON.stringify(row.id === 'authority-content' ? document : args)); } },
    collaboration: {
      async send(input) { calls.push(input); return { messageId: 'message', accepted: true }; },
      async listMembers(id) { calls.push(id); return { members: [] }; },
      async listMessages(input) { calls.push(input); return { messages: [] }; },
      async readConversation(input) { calls.push(input); return { conversationId: input.targetConversationId, title: 'peer', status: 'active',
        messages: [{ messageId: 'chat-message', role: 'model', text: 'retained reply' }], olderMessageId: 'chat-message', hasMore: true }; },
      async readMessage(input) { calls.push(input); return { messageId: input.messageId }; },
      async waitMessages(input) { calls.push(input); return { messages: [], timedOut: true }; },
      async listConversations(input) { calls.push({ list: input }); return { conversations: [{ conversationId: 'peer', title: 'peer', running: false, updatedAt: 'now' }], hasMore: false }; },
      async authorizeCrossConversation(input) { calls.push({ authorize: input }); return { conversationId: 'conversation' }; },
      async assertConversationSpawnAllowed(input) { calls.push({ spawnCapacity: input }); }
    },
    conversations: {
      async createForCollaboration(input) { calls.push({ create: input }); return { conversationId: 'created', title: 'created', messageId: 'message', deduplicated: false }; },
      async forkCompletedHistory(input) { calls.push({ fork: input }); return { conversationId: 'forked', title: 'forked', deduplicated: false }; }
    },
    effects: { async settleWithoutEffect(input) { settlements.push(input); return { status: input.status, terminal: input }; } }
  });
  const input = { turnId: 'turn', modelRequestId: 'request', toolCallId: 'call', toolName, arguments: args };
  return { dispatcher, input, authority, document, records, calls, settlements };
}

test('special dispatch preserves peer source and separates message delivery from follow-up wake', async () => {
  for (const [toolName, mode] of [['send_agent_message', 'message'], ['followup_agent_task', 'followup']]) {
    const f = fixture({ toolName });
    await f.dispatcher.dispatch(f.input, undefined, f.authority);
    assert.deepEqual(f.calls, [{ source: { kind: 'tool', turnId: 'turn', toolCallId: 'call' }, targetConversationId: 'peer', text: 'hello', mode }]);
    assert.equal(f.settlements[0].detail.kind, 'agent_collaboration');
  }
});

test('frozen tool source, snapshot and committed arguments cannot be forged before collaboration mutation', async () => {
  const mutations = [
    f => { f.input.turnId = 'other'; },
    f => { f.records.ModelRequest.authority_snapshot_id = 'other-authority'; },
    f => { f.records.ToolCall.tool_name = 'list_agents'; },
    f => { f.records.ToolCallSourceLink[0].model_request_id = 'other-request'; },
    f => { f.authority = { ...f.authority, document: { toolPolicy: { allowedTools: [] } } }; },
    f => { f.document.toolPolicy.allowedTools = []; },
    f => { f.input.arguments = { ...f.input.arguments, text: 'changed after commit' }; }
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.dispatcher.dispatch(f.input, undefined, f.authority));
    assert.deepEqual(f.calls, []); assert.deepEqual(f.settlements, []);
  }
});

test('read and wait validation rejects unbounded or mixed arguments without side effects', async () => {
  for (const [toolName, args] of [['read_agent_messages', { messageId: 'm', limit: 20 }],
    ['read_agent_messages', { limit: 101 }], ['wait_agent_messages', { timeoutMs: 60001 }], ['list_agents', { conversationId: 'other' }]]) {
    const f = fixture({ toolName, args });
    await assert.rejects(f.dispatcher.dispatch(f.input, undefined, f.authority));
    assert.deepEqual(f.calls, []);
  }
  const f = fixture({ toolName: 'wait_agent_messages', args: { timeoutMs: 0 } });
  await f.dispatcher.dispatch(f.input, undefined, f.authority);
  assert.equal(f.calls[0].timeoutMs, 0);
});

test('collaboration declarations classify only observations as read-only and expose no permission mutation', () => {
  const definitions = agentCollaborationToolModules.map(module => module.create({}));
  assert.deepEqual(definitions.filter(tool => tool.declaration.metadata.readonly).map(tool => tool.declaration.name), ['list_agents', 'read_agent_messages', 'wait_agent_messages']);
  for (const tool of definitions) assert.equal(tool.declaration.parameters.additionalProperties, false);
  assert.equal(definitions.some(tool => /permission|depth/.test(tool.declaration.name)), false);
});


test('board discovery IDs and post authors use typed references without leaking UI record IDs', () => {
  const raw = { kind: 'agent_collaboration', channels: [{ id: 'channel-x', channelId: 'channel-x', name: 'review' }],
    posts: [{ id: 'post-x', postId: 'post-x', channelId: 'channel-x', threadId: 'post-x', authorConversationId: 'peer-x' }] };
  const handles = buildModelHandleCatalog([raw]);
  const projected = projectToolResultForModel('agent_board', raw, handles);
  assert.deepEqual(projected.channels, [{ channelRef: 'H1', name: 'review' }]);
  assert.deepEqual(projected.posts, [{ postRef: 'B1', channelRef: 'H1', threadRef: 'T1', authorConversationRef: 'C1' }]);
  assert.doesNotMatch(JSON.stringify(projected), /channel-x|post-x|peer-x/);
  assert.deepEqual(resolveModelToolArguments('agent_board', { operation: 'read_post', postRef: projected.posts[0].postRef }, handles),
    { operation: 'read_post', postId: 'post-x' });
});

test('reading another permitted mailbox keeps caller identity separate and projects message page cursors', async () => {
  const f = fixture({ toolName: 'read_agent_messages', args: { targetConversationId: 'peer', limit: 2 } });
  const result = await f.dispatcher.dispatch(f.input, undefined, f.authority);
  assert.deepEqual(f.calls, [{ conversationId: 'conversation', targetConversationId: 'peer', limit: 2 }]);
  assert.equal(result.detail.kind, 'agent_collaboration');
  const raw = { kind: 'agent_collaboration', nextAfterMessageId: 'cursor-message', messages: [{ messageId: 'first-message' }] };
  const handles = buildModelHandleCatalog([raw]);
  const projected = projectToolResultForModel('read_agent_messages', raw, handles);
  assert.equal(projected.nextAfterMessageRef, handles.entries.find(entry => entry.target === 'cursor-message').ref);
});


test('a squeezed board result keeps the current-page cursor and body offsets for lossless rereading', () => {
  const { projectToolResultBatch } = load('backend/reliableKernel/modelFacingContextProjection.js');
  const rereadCursor = 'opaque-current-page-' + 'x'.repeat(1200);
  const batch = projectToolResultBatch([{ toolName: 'agent_board', response: {
    operation: 'read_post', postRef: 'B1', rereadCursor, offsetChars: 2000, nextOffsetChars: 14000, text: 'body'.repeat(10000)
  } }], { perResultTokens: 200, batchTokens: 400 });
  assert.equal(batch.items[0].truncated, true);
  assert.equal(batch.items[0].response.rereadCursor, rereadCursor);
  assert.equal(batch.items[0].response.offsetChars, 2000);
  assert.equal(batch.items[0].response.nextOffsetChars, 14000);
  assert.equal(batch.items[0].response.postRef, 'B1');
});


test('authorized conversation history uses a separate reference kind from collaboration mail', async () => {
  const f = fixture({ toolName: 'read_agent_messages', args: { view: 'conversation', targetConversationId: 'peer', limit: 10 } });
  const result = await f.dispatcher.dispatch(f.input, undefined, f.authority);
  assert.deepEqual(f.calls, [{ conversationId: 'conversation', targetConversationId: 'peer', limit: 10 }]);
  const handles = buildModelHandleCatalog([result.detail], catalog.entries);
  const projected = projectToolResultForModel('read_agent_messages', result.detail, handles);
  assert.equal(projected.view, 'conversation');
  assert.equal(projected.messages[0].messageRef, 'R1');
  assert.equal(projected.olderMessageRef, 'R1');
  assert.deepEqual(resolveModelToolArguments('read_agent_messages', { view: 'conversation', conversationRef: projected.conversationRef, beforeMessageRef: 'R1' }, handles),
    { view: 'conversation', targetConversationId: 'peer', beforeMessageId: 'chat-message' });
  assert.throws(() => resolveModelToolArguments('read_agent_messages', { beforeMessageRef: 'R1' }, handles), error => error.code === 'UNKNOWN_MODEL_HANDLE_REFERENCE');
  assert.throws(() => resolveModelToolArguments('read_agent_messages', { view: 'conversation', beforeMessageRef: 'M1' }, handles), error => error.code === 'UNKNOWN_MODEL_HANDLE_REFERENCE');
});


// Queueing behind a running target is asserted end to end in cross-conversation-tools.test.mjs; this
// boundary test only pins what the dispatcher asks the control plane for.
test('cross-conversation dispatch requires the frozen switch and asks the control plane to queue every send', async () => {
  for (const crossConversation of [undefined, false]) {
    const f = fixture({ toolName: 'send_conversation_message', args: { targetConversationId: 'peer', text: 'hello', mode: 'followup' }, crossConversation });
    await assert.rejects(f.dispatcher.dispatch(f.input, undefined, f.authority), /not enabled/);
    assert.deepEqual(f.calls, []); assert.deepEqual(f.settlements, []);
  }
  const send = fixture({ toolName: 'send_conversation_message', args: { targetConversationId: 'peer', text: 'hello', mode: 'message' }, crossConversation: true });
  await send.dispatcher.dispatch(send.input, undefined, send.authority);
  assert.deepEqual(send.calls, [{ source: { kind: 'tool', turnId: 'turn', toolCallId: 'call' }, targetConversationId: 'peer', text: 'hello',
    mode: 'message', queueBehindActiveTurn: true, crossConversation: true }]);
  assert.equal(send.settlements[0].detail.kind, 'cross_conversation');
  const badMode = fixture({ toolName: 'send_conversation_message', args: { targetConversationId: 'peer', text: 'hello' }, crossConversation: true });
  await assert.rejects(badMode.dispatcher.dispatch(badMode.input, undefined, badMode.authority), /mode/);
  assert.deepEqual(badMode.calls, []);

  const list = fixture({ toolName: 'list_conversations', args: {}, crossConversation: true });
  const listed = await list.dispatcher.dispatch(list.input, undefined, list.authority);
  assert.deepEqual(list.calls, [{ list: { turnId: 'turn', limit: 20 } }]);
  assert.match(listed.detail.untrustedDataNotice, /untrusted/);
  const read = fixture({ toolName: 'read_conversation', args: { targetConversationId: 'peer' }, crossConversation: true });
  const transcript = await read.dispatcher.dispatch(read.input, undefined, read.authority);
  assert.deepEqual(read.calls, [{ conversationId: 'conversation', targetConversationId: 'peer', crossConversationTurnId: 'turn', limit: 20 }]);
  assert.equal(transcript.detail.messages[0].conversationMessageId, 'chat-message');
  assert.match(transcript.detail.untrustedDataNotice, /untrusted/);

  const create = fixture({ toolName: 'create_conversation', args: { prompt: 'do it', title: 'Task' }, crossConversation: true });
  await create.dispatcher.dispatch(create.input, undefined, create.authority);
  assert.deepEqual(create.calls, [{ authorize: { turnId: 'turn' } }, { spawnCapacity: { turnId: 'turn', toolCallId: 'call' } },
    { create: { turnId: 'turn', toolCallId: 'call', sourceConversationId: 'conversation', prompt: 'do it', title: 'Task' } }]);
  const fork = fixture({ toolName: 'fork_conversation', args: {}, crossConversation: true });
  const forked = await fork.dispatcher.dispatch(fork.input, undefined, fork.authority);
  assert.deepEqual(fork.calls, [{ authorize: { turnId: 'turn' } }, { spawnCapacity: { turnId: 'turn', toolCallId: 'call' } },
    { fork: { sourceConversationId: 'conversation', commandId: 'call' } }]);
  assert.equal(forked.detail.turnStarted, false);
  assert.equal(forked.detail.sourceConversationId, 'conversation');
});

test('cross-conversation references map whole conversations, transcript pages and replies, never canonical ids', () => {
  const raw = { kind: 'cross_conversation', conversations: [{ conversationId: 'peer-x', title: 'Peer' }], messages: [{ conversationMessageId: 'chat-x' }],
    olderConversationMessageId: 'chat-x', sourceConversationId: 'self-x' };
  const handles = buildModelHandleCatalog([raw]);
  const projected = projectToolResultForModel('read_conversation', raw, handles);
  assert.doesNotMatch(JSON.stringify(projected), /peer-x|chat-x|self-x/);
  assert.match(projected.conversations[0].conversationRef, /^C\d+$/);
  assert.match(projected.olderMessageRef, /^R\d+$/);
  assert.deepEqual(resolveModelToolArguments('read_conversation', { conversationRef: projected.conversations[0].conversationRef, beforeMessageRef: projected.olderMessageRef }, handles),
    { targetConversationId: 'peer-x', beforeMessageId: 'chat-x' });
  assert.deepEqual(resolveModelToolArguments('fork_conversation', {}, handles), {});
  for (const [toolName, args] of [['send_conversation_message', { targetConversationId: 'peer-x', text: 'x', mode: 'message' }],
    ['fork_conversation', { conversationRef: 'C99' }], ['read_conversation', { conversationRef: projected.conversations[0].conversationRef, beforeMessageRef: 'M1' }]]) {
    assert.throws(() => resolveModelToolArguments(toolName, args, handles), error => error.code === 'UNKNOWN_MODEL_HANDLE_REFERENCE');
  }
});

test('cross-conversation declarations are strict, summarize every call and classify only list and read as read-only', () => {
  const definitions = crossConversationToolModules.map(module => module.create({}));
  assert.deepEqual(definitions.map(tool => tool.declaration.name), ['list_conversations', 'read_conversation', 'send_conversation_message', 'create_conversation', 'fork_conversation']);
  assert.deepEqual(definitions.filter(tool => tool.declaration.metadata.readonly).map(tool => tool.declaration.name), ['list_conversations', 'read_conversation']);
  for (const tool of [...definitions, ...agentCollaborationToolModules.map(module => module.create({}))]) {
    assert.equal(tool.declaration.parameters.additionalProperties, false);
    assert.equal(tool.declaration.metadata.defaultAutoApproveExecution, undefined, 'send-type tools stay auto-approved by default');
    assert.equal(typeof tool.summary?.({ text: 'hello', prompt: 'p', mode: 'followup' }, { toolName: tool.declaration.name }), 'string');
  }
  const byName = Object.fromEntries(definitions.map(tool => [tool.declaration.name, tool.declaration.description]));
  for (const name of ['list_conversations', 'read_conversation']) assert.match(byName[name], /untrusted/);
  assert.match(byName.create_conversation, /only when the user explicitly asks/);
  assert.match(byName.fork_conversation, /completed history/);
  assert.match(byName.fork_conversation, /starts no turn/);
});
