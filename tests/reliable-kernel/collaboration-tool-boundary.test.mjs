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

function fixture({ toolName = 'send_agent_message', args = { targetConversationId: 'peer', text: 'hello' }, crossConversation, allowedTools = [toolName, 'run_agent'] } = {}) {
  const document = { toolPolicy: { allowedTools,
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
      async readConversationMessage(input) { calls.push({ readConversationMessage: input }); return { conversationId: input.targetConversationId, conversationMessageId: input.messageId, text: 'page', offset: input.offset, nextOffset: null }; },
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
  // One transcript message is read whole through its R# reference; a mailbox message through M#.
  assert.deepEqual(resolveModelToolArguments('read_agent_messages', { view: 'conversation', conversationRef: projected.conversationRef, messageRef: 'R1', offset: 40 }, handles),
    { view: 'conversation', targetConversationId: 'peer', messageId: 'chat-message', offset: 40 });
  assert.throws(() => resolveModelToolArguments('read_agent_messages', { view: 'conversation', messageRef: 'M1' }, handles), error => error.code === 'UNKNOWN_MODEL_HANDLE_REFERENCE');
  assert.deepEqual(resolveModelToolArguments('read_agent_messages', { messageRef: 'M1', offset: 0 }, handles), { messageId: 'message-one', offset: 0 });
  const page = fixture({ toolName: 'read_agent_messages', args: { view: 'conversation', targetConversationId: 'peer', messageId: 'chat-message', offset: 40 } });
  await page.dispatcher.dispatch(page.input, undefined, page.authority);
  assert.deepEqual(page.calls, [{ readConversationMessage: { conversationId: 'conversation', targetConversationId: 'peer', messageId: 'chat-message', offset: 40 } }]);
  for (const args of [{ view: 'conversation', targetConversationId: 'peer', messageId: 'chat-message', limit: 5 }, { view: 'conversation', targetConversationId: 'peer', offset: 3 }]) {
    const refused = fixture({ toolName: 'read_agent_messages', args });
    await assert.rejects(refused.dispatcher.dispatch(refused.input, undefined, refused.authority));
    assert.deepEqual(refused.calls, []);
  }
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
  // Sending acts on another conversation and needs run_agent in the same frozen list; reading does not.
  const noRunAgent = fixture({ toolName: 'send_conversation_message', args: { targetConversationId: 'peer', text: 'hello', mode: 'message' },
    crossConversation: true, allowedTools: ['send_conversation_message'] });
  await assert.rejects(noRunAgent.dispatcher.dispatch(noRunAgent.input, undefined, noRunAgent.authority), /lacks run_agent/);
  assert.deepEqual(noRunAgent.calls, []);
  const listWithoutRunAgent = fixture({ toolName: 'list_conversations', args: {}, crossConversation: true, allowedTools: ['list_conversations'] });
  await listWithoutRunAgent.dispatcher.dispatch(listWithoutRunAgent.input, undefined, listWithoutRunAgent.authority);
  assert.deepEqual(listWithoutRunAgent.calls, [{ list: { turnId: 'turn', limit: 20 } }]);
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
  assert.deepEqual(resolveModelToolArguments('read_conversation', { conversationRef: projected.conversations[0].conversationRef, messageRef: projected.olderMessageRef, offset: 7 }, handles),
    { targetConversationId: 'peer-x', messageId: 'chat-x', offset: 7 });
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
  // How a task's reply comes back: into the running turn, else a new turn within the automatic
  // followup budget, else the next turn; wait_agent_messages returns it within this turn.
  for (const name of ['send_conversation_message', 'create_conversation']) {
    assert.doesNotMatch(byName[name], /returned to you automatically/, name);
    assert.match(byName[name], /still running, the reply is added to it/, name);
    assert.match(byName[name], /a new turn starts to handle it while the automatic followup budget allows; otherwise it arrives with your next turn/, name);
    assert.match(byName[name], /wait_agent_messages with afterMessageRef set to the messageRef this call returns/, name);
  }
  assert.match(byName.list_conversations, /this conversation's project/);
  assert.doesNotMatch(Object.values(byName).join('\n'), /workspace/);
});

/**
 * The general dispatcher's own run_agent rule, reached by a directly dispatched ToolCall with no
 * provider declaration to match: neither offering nor the collaboration dispatcher can mask it.
 */
test('general dispatch admission refuses send, create and fork without run_agent in the frozen list', async () => {
  const { ReliableToolDispatcher } = load('backend/reliableKernel/toolDispatcher.js');
  const admit = async (toolName, allowedTools) => {
    const document = {
      toolPolicy: { allowedTools, preset: 'custom', toolConfigs: { run_agent: { config: { crossConversationCollaboration: true } } }, sourceConfigs: {} },
      planReviewPolicy: { mode: 'off' },
      workEnvironmentPolicy: { enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
    };
    const records = {
      ToolCall: [{ id: 'call', turn_id: 'turn', tool_name: toolName, call_seq: 1n, status: 'pending' }],
      AuthoritySnapshot: [{ id: 'authority', turn_id: 'turn', content_object_id: 'authority-content' }],
      ContentObject: [{ id: 'authority-content' }],
      Turn: [{ id: 'turn', conversation_id: 'conversation', status: 'active' }]
    };
    const matching = read => (records[read.domain] ?? []).filter(row => Object.entries(read.where ?? {}).every(([key, value]) => row[key] === value));
    const settlements = [];
    const declaration = crossConversationToolModules.map(module => module.create({})).find(tool => tool.declaration.name === toolName).declaration;
    const dispatcher = new ReliableToolDispatcher({
      database: {
        async snapshot(reads) { return { snapshot: reads.map(read => read.kind === 'get' ? (records[read.domain] ?? []).find(row => row.id === read.id) : matching(read)) }; },
        async snapshotAll(read) { return { snapshot: matching(read) }; }
      },
      contentStore: { async read() { return Buffer.from(JSON.stringify(document)); } },
      effects: {
        subscribeToolModelResults() { return () => {}; },
        async finalizeReadyInOrder() {},
        async readTerminalResult() { return null; },
        async settleWithoutEffect(input) { settlements.push(input); return { status: input.status }; }
      },
      host: { definitions: () => [{ execution: 'backend', declaration, async execute() { throw new Error('not reached'); } }] }
    });
    await dispatcher.dispatch({ turnId: 'turn', modelRequestId: 'request', toolCallId: 'call', toolName, arguments: {} }).catch(() => undefined);
    return settlements.filter(entry => entry.status === 'rejected').map(entry => entry.detail.reason);
  };
  const policyRefusal = /工具策略不含 run_agent/;
  for (const toolName of ['send_conversation_message', 'create_conversation', 'fork_conversation']) {
    const refused = await admit(toolName, [toolName]);
    assert.equal(refused.length, 1, toolName);
    assert.match(refused[0], policyRefusal, `${toolName} without run_agent`);
    assert.doesNotMatch((await admit(toolName, [toolName, 'run_agent'])).join('\n'), policyRefusal, `${toolName} with run_agent passes the policy check`);
  }
  for (const toolName of ['list_conversations', 'read_conversation']) {
    assert.doesNotMatch((await admit(toolName, [toolName])).join('\n'), policyRefusal, `${toolName} needs no run_agent`);
  }
});

/**
 * The general dispatcher over a stub frozen Turn: its own offering (`definitions(turnId)`) and
 * dispatch admission, with no provider declaration to match.
 */
function frozenTurnDispatcher({ allowedTools, toolConfigs = {}, childConversation = false }) {
  const { ReliableToolDispatcher } = load('backend/reliableKernel/toolDispatcher.js');
  const document = {
    toolPolicy: { allowedTools, preset: 'custom', toolConfigs, sourceConfigs: {} },
    planReviewPolicy: { mode: 'off' },
    workEnvironmentPolicy: { enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
  };
  const records = {
    ToolCall: [],
    AuthoritySnapshot: [{ id: 'authority', turn_id: 'turn', content_object_id: 'authority-content' }],
    ContentObject: [{ id: 'authority-content' }],
    Turn: [{ id: 'turn', conversation_id: 'conversation', status: 'active' }],
    ChildExecution: childConversation ? [{ id: 'child', child_conversation_id: 'conversation' }] : []
  };
  const matching = read => (records[read.domain] ?? []).filter(row => Object.entries(read.where ?? {}).every(([key, value]) => row[key] === value));
  const settlements = [];
  const declarations = [load('backend/world/modules/tools/definitions/runAgent/index.js').runAgentTool.declaration,
    ...crossConversationToolModules.map(module => module.create({}).declaration)];
  const dispatcher = new ReliableToolDispatcher({
    database: {
      async snapshot(reads) { return { snapshot: reads.map(read => read.kind === 'get' ? (records[read.domain] ?? []).find(row => row.id === read.id) : matching(read)) }; },
      async snapshotAll(read) { return { snapshot: matching(read) }; }
    },
    contentStore: { async read() { return Buffer.from(JSON.stringify(document)); } },
    effects: {
      subscribeToolModelResults() { return () => {}; },
      async finalizeReadyInOrder() {},
      async readTerminalResult() { return null; },
      async settleWithoutEffect(input) { settlements.push(input); return { status: input.status }; }
    },
    host: { definitions: () => declarations.map(declaration => ({ execution: 'backend', declaration, async execute() { throw new Error('not reached'); } })) }
  });
  return {
    async offered() { return (await dispatcher.definitions('turn')).map(tool => tool.name).filter(name => CROSS.includes(name)); },
    /** The refusal reasons of one directly dispatched call. */
    async refusals(toolName) {
      const id = `call-${records.ToolCall.length}`;
      records.ToolCall.push({ id, turn_id: 'turn', tool_name: toolName, call_seq: BigInt(records.ToolCall.length + 1), status: 'pending' });
      const before = settlements.length;
      await dispatcher.dispatch({ turnId: 'turn', modelRequestId: 'request', toolCallId: id, toolName, arguments: {} }).catch(() => undefined);
      return settlements.slice(before).filter(entry => entry.status === 'rejected').map(entry => entry.detail.reason);
    }
  };
}

const CROSS = ['list_conversations', 'read_conversation', 'send_conversation_message', 'create_conversation', 'fork_conversation'];
const READ_TYPE = ['list_conversations', 'read_conversation'];
const switchConfig = value => ({ run_agent: { config: { crossConversationCollaboration: value } } });
const policyRefusal = /ToolPolicy|工具策略|跨对话协作/;

test('the switch is the grant: the frozen switch offers and admits the tools whatever the tool list names', async () => {
  // Switch on: a list that names none of the five still gets all of them with run_agent, and only list and read without it.
  const granted = frozenTurnDispatcher({ allowedTools: ['run_agent'], toolConfigs: switchConfig(true) });
  assert.deepEqual(await granted.offered(), CROSS);
  for (const toolName of CROSS) assert.doesNotMatch((await granted.refusals(toolName)).join('\n'), policyRefusal, `${toolName} is admitted`);
  const readOnly = frozenTurnDispatcher({ allowedTools: ['read'], toolConfigs: switchConfig(true) });
  assert.deepEqual(await readOnly.offered(), READ_TYPE);
  for (const toolName of READ_TYPE) assert.doesNotMatch((await readOnly.refusals(toolName)).join('\n'), policyRefusal);
  for (const toolName of CROSS.filter(name => !READ_TYPE.includes(name))) assert.match((await readOnly.refusals(toolName)).join('\n'), /run_agent/);

  // Switch off (or a child task): a list that names all five offers and admits none; a forged call is refused.
  for (const off of [frozenTurnDispatcher({ allowedTools: ['run_agent', ...CROSS], toolConfigs: switchConfig(false) }),
    frozenTurnDispatcher({ allowedTools: ['run_agent', ...CROSS] }),
    frozenTurnDispatcher({ allowedTools: ['run_agent', ...CROSS], toolConfigs: switchConfig(true), childConversation: true })]) {
    assert.deepEqual(await off.offered(), []);
    for (const toolName of CROSS) assert.match((await off.refusals(toolName)).join('\n'), /未开启跨对话协作/, `${toolName} is refused`);
  }
});

test('the collaboration dispatcher admits the tools by the frozen switch, not by list entries', async () => {
  const send = fixture({ toolName: 'send_conversation_message', args: { targetConversationId: 'peer', text: 'hello', mode: 'message' },
    crossConversation: true, allowedTools: ['run_agent'] });
  await send.dispatcher.dispatch(send.input, undefined, send.authority);
  assert.equal(send.calls.length, 1, 'a list without the tool name still sends while the switch is on');
  const list = fixture({ toolName: 'list_conversations', args: {}, crossConversation: true, allowedTools: [] });
  await list.dispatcher.dispatch(list.input, undefined, list.authority);
  assert.deepEqual(list.calls, [{ list: { turnId: 'turn', limit: 20 } }]);
  const off = fixture({ toolName: 'list_conversations', args: {}, crossConversation: false, allowedTools: ['run_agent', ...CROSS] });
  await assert.rejects(off.dispatcher.dispatch(off.input, undefined, off.authority), /not enabled/);
  assert.deepEqual(off.calls, []);
});
