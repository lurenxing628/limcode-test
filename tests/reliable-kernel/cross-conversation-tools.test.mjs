import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const Module = require('node:module');
const originalLoad = Module._load;
class Uri {
  constructor(value) { this.scheme = 'file'; this.fsPath = path.resolve(value); this.path = this.fsPath; }
  static file(value) { return new Uri(value); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.path}`; }
}
const vscode = { Uri, FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 }, workspace: { fs: {
  createDirectory: uri => fs.mkdir(uri.fsPath, { recursive: true }), readFile: uri => fs.readFile(uri.fsPath),
  async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
  async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map(item => [item.name, item.isDirectory() ? 2 : 1]); },
  delete: uri => fs.rm(uri.fsPath, { recursive: true, force: true }),
  async stat(uri) { const stat = await fs.stat(uri.fsPath); return { type: stat.isDirectory() ? 2 : 1, size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs }; }
} } };
Module._load = function(request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });
const kernel = load('backend/reliableKernel/index.js');
const { VscodeConfigurationAuthority } = load('backend/reliableKernel/vscodeConfigurationAuthority.js');
const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { ReliableChildAgentCoordinator } = load('backend/reliableKernel/childAgentCoordinator.js');
const { ReliableConversationRunner } = load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { ReliableConversationLifecycle } = load('backend/application/reliableKernel/conversationLifecycle.js');
const { createRuntimeDeliveryWakeHandler } = load('backend/application/reliableKernel/runtimeDeliveryWakeHandler.js');
const { ReliableToolDispatcher } = load('backend/reliableKernel/toolDispatcher.js');
const { CollaborationToolDispatcher } = load('backend/reliableKernel/collaborationToolDispatcher.js');
const { runAgentTool } = load('backend/world/modules/tools/definitions/runAgent/index.js');
const { agentCollaborationToolModules } = load('backend/world/modules/tools/definitions/agentCollaboration/index.js');
const { crossConversationToolModules, CROSS_CONVERSATION_TOOL_NAMES } = load('backend/world/modules/tools/definitions/crossConversation/index.js');
const { dryRunLlmProvider } = load('backend/capabilities/llmProvider.js');
const { applyFrozenModelProviderConfig } = load('backend/reliableKernel/llmCapabilityProviderRegistry.js');
const { LlmEventType } = load('backend/world/modules/llm/events.js');
const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
// Canonical ids never occur inside titles or message text, as with production random ids.
const ROOT = 'conv-root-7c1', PEER = 'conv-peer-7c2';
const definitions = [runAgentTool, ...agentCollaborationToolModules.map(module => module.create({})),
  ...crossConversationToolModules.map(module => module.create({}))];
const call = (id, name, args = {}) => ({ id, functionCall: { name, args } });
const answer = text => ({ role: 'model', parts: [{ text }] });
const toolsAnswer = (...parts) => ({ role: 'model', parts });
const complete = (controls, content) => controls.onEvent({ kind: 'completed', streamSeq: '1', content });
const lastResult = (start, name) => start.contents.flatMap(content => content.parts)
  .filter(part => part.functionResponse?.name === name).at(-1)?.functionResponse.response;
const detail = (start, name) => lastResult(start, name)?.detail;

/** The external model alone is synthetic; tools, authority, ownership, persistence and wakes are production code. */
async function fixture(send, run, { enabled = true, switchValue = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-cross-conversation-'));
  const configuration = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(path.join(root, 'settings'))));
  const save = async (section, settings) => configuration.saveGlobalSettings(section, settings, (await configuration.loadGlobalSettings(section)).revision);
  const provider = { ...createDefaultLlmProviderConfig({ name: 'synthetic cross conversation' }), id: 'synthetic-cross',
    provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'gpt-6-astra',
    models: [{ id: 'gpt-6-astra', name: 'synthetic' }], modelConfigs: [], generationConfig: {}, contextWindowTokens: 200000 };
  let app, coordinator, runner, collaborationTools, lifecycle;
  const errors = [], dispatches = [], wakes = [];
  const f = {
    errors, dispatches, wakes, configuration,
    get app() { return app; }, get runner() { return runner; }, get lifecycle() { return lifecycle; },
    rows: async (domain, where = {}) => (await app.database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot,
    async until(check, message, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (errors.length) throw errors[0];
        const result = await check();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail(message);
    },
    async input(conversationId, commandId, text = commandId) { return runner.input({ conversationId, commandId, text }); },
    async terminated(turnId) { return f.until(async () => (await f.rows('TurnTermination', { turn_id: turnId }))[0], `Turn did not terminate: ${turnId}`); },
    toolCallId(providerCallId) { return f.dispatches.find(input => input.providerCallId === providerCallId)?.toolCallId; },
    async transcript(conversationId) {
      return (await app.runtime.collaboration.readConversation({ conversationId, targetConversationId: conversationId, limit: 50 })).messages;
    }
  };
  try {
    await save('llmProviderConfigs', { configs: [provider] });
    await save('llm', { activeProviderConfigId: provider.id });
    const folderPath = path.join(root, 'workspace');
    await fs.mkdir(folderPath);
    const project = { uri: Uri.file(folderPath).toString(), name: 'cross-project' };
    await configuration.synchronizeWorkspaceFolders([{ ...project, rootPath: folderPath, index: 0 }]);
    const agent = await configuration.mutations.createAgent({ name: 'Synthetic top-level', kind: 'custom' });
    await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: definitions.map(tool => tool.declaration.name),
      ...(enabled ? { toolConfigs: { run_agent: { config: { crossConversationCollaboration: switchValue } } } } : {}) });
    const rootAuthority = new kernel.RootAuthority(() => path.join(root, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(rootAuthority);
    app = await kernel.ReliableKernelApplication.open(rootAuthority, {
      authorityCompiler: configuration, compressionSettingsAuthority: configuration, attachmentSettings: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('External tool calls are forbidden in this fixture.'); } },
      mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
      providers: { resolve(providerId) { return { providerId, async sendFullRequest(request, controls) {
        const [requestRow] = await f.rows('ModelRequest', { id: request.modelRequestId });
        const observedRequest = { ...request, turnId: requestRow.turn_id };
        try {
          let start;
          const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
            start(input, emit) { start = input; emit({ type: LlmEventType.Done, payload: { requestId: input.id } }); }, abort() {}, dispose() {}
          });
          await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, terminal: true, checkpointed: true }; } });
          const effective = applyFrozenModelProviderConfig(await configuration.providerConfig(providerId), request.modelId);
          const wire = await dryRunLlmProvider(start, { settings: { ...effective, apiKey: '' } });
          await complete(controls, await send(observedRequest, f, start, wire.body));
        } catch (error) { errors.push(error); await complete(controls, answer('Synthetic provider assertion failed.')); }
      } }; } },
      createToolDispatcher: dependencies => new ReliableToolDispatcher({ ...dependencies, effects: dependencies.runtime.effects,
        host: {
          definitions: () => definitions,
          async dispatchSpecial(_definition, input, authority, signal, admission) {
            dispatches.push(structuredClone(input));
            return await collaborationTools.dispatch(input, signal, authority)
              ?? await coordinator.dispatch(input, signal, authority, admission);
          },
          cancelTurnWaits: input => coordinator.cancelParentWaits(input),
          quiesce: reason => coordinator.quiesce(reason)
        }
      })
    });
    lifecycle = new ReliableConversationLifecycle({ application: app, configuration });
    collaborationTools = new CollaborationToolDispatcher({ database: app.database, contentStore: app.contentStore,
      effects: app.runtime.effects, collaboration: app.runtime.collaboration, board: app.runtime.collaborationBoard, conversations: lifecycle });
    coordinator = new ReliableChildAgentCoordinator({ database: app.database, ...app.runtime,
      modelProvider: app.modelProvider, turns: app.turns, agentLoop: app.agentLoop,
      agents: { async resolve() { return { agentId: agent.id, agentType: 'worker' }; } },
      modelProfiles: { initializeConversation: ({ conversationId, model }) =>
        configuration.mutations.initializeConversationModelProfile({ conversationId, ...model }) },
      deliveryWakeups: app.processDeliveries, ownedProcessCleanup: app.childOwnedProcessCleanup
    });
    runner = new ReliableConversationRunner(app, 'synthetic-cross-owner');
    const wake = createRuntimeDeliveryWakeHandler({ application: () => app, conversations: () => runner, children: () => coordinator });
    app.processDeliveries.setWakeHandler(async request => { wakes.push(structuredClone(request)); return wake(request); });
    const now = new Date().toISOString();
    await app.database.transaction([
      ...[[ROOT, 'Root title'], [PEER, 'Peer title']].flatMap(([id, title]) => [
        repo('Conversation').insert({ id, title, status: 'active', created_at: now, updated_at: now }),
        repo('AgentConversationLink').insert({ id: `${id}-agent`, conversation_id: id, agent_id: agent.id, role: 'default', created_at: now, updated_at: now })
      ]),
      ...kernel.projectFolderAssignmentSteps({ conversationId: ROOT, folder: project, now })
    ]);
    await app.recover();
    await run(f);
    assert.deepEqual(errors, []);
  } finally {
    runner?.dispose();
    if (coordinator) await coordinator.dispose();
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function assertPeerWireRole(wire, marker) {
  const messages = (wire.messages ?? wire.input).filter(message => JSON.stringify(message.content ?? '').includes(marker));
  assert.ok(messages.length > 0, `Peer payload absent from provider wire: ${marker}`);
  assert.ok(messages.every(message => message.role === 'assistant'), 'peer text is attributed assistant transport, never user or system authority');
}

async function userMessages(f, turnId) {
  return (await f.rows('MessageTurnLink', { turn_id: turnId })).filter(link => link.role === 'user');
}

test('with the switch off the tools are not offered and every entry point rejects them', { timeout: 60000 }, async () => {
  let round = 0, forgedTurn;
  await fixture(async (request, f, start) => {
    assert.equal(request.conversationId, ROOT);
    round += 1;
    if (round === 1) {
      forgedTurn = request.turnId;
      const names = start.tools.map(tool => tool.name);
      for (const name of CROSS_CONVERSATION_TOOL_NAMES) assert.ok(!names.includes(name), `${name} must not be offered`);
      assert.ok(names.includes('list_agents'), 'team tools do not depend on the switch');
      return toolsAnswer(call('forged-list', 'list_conversations'), call('forged-send', 'send_conversation_message', { conversationRef: 'C1', text: 'x', mode: 'followup' }));
    }
    for (const name of ['list_conversations', 'send_conversation_message']) {
      const result = lastResult(start, name);
      assert.ok(result, `${name} result missing`);
      assert.notEqual(result.status, 'succeeded', `${name} must not execute: ${JSON.stringify(result)}`);
    }
    await assert.rejects(f.app.runtime.collaboration.listConversations({ turnId: request.turnId }), /not enabled/);
    await assert.rejects(f.app.runtime.collaboration.readConversation({ conversationId: ROOT, targetConversationId: PEER, crossConversationTurnId: request.turnId }), /not enabled/);
    return answer('Nothing to do.');
  }, async f => {
    const started = await f.input(ROOT, 'switch-off');
    assert.equal((await f.terminated(started.turnId)).terminal_status, 'completed');
    assert.equal(forgedTurn, started.turnId);
    assert.equal((await f.rows('CollaborationMessage')).length, 0);
    assert.equal(f.dispatches.filter(input => CROSS_CONVERSATION_TOOL_NAMES.includes(input.toolName)).length, 0, 'the special control plane is never reached');
    // Even a forged direct send is refused by the control plane's own frozen-authority check.
    const [forgedCall] = await f.rows('ToolCall', { turn_id: started.turnId });
    await assert.rejects(f.app.runtime.collaboration.send({ source: { kind: 'tool', turnId: started.turnId, toolCallId: forgedCall.id },
      targetConversationId: PEER, text: 'forged', mode: 'followup', crossConversation: true }), /not enabled/);
  }, { enabled: false });
});

test('a malformed switch value fails closed instead of breaking every Turn', { timeout: 60000 }, async () => {
  const { frozenCrossConversationEnabled } = load('backend/reliableKernel/collaborationPolicy.js');
  for (const value of ['true', 1, null, {}]) {
    assert.equal(frozenCrossConversationEnabled({ toolPolicy: { toolConfigs: { run_agent: { config: { crossConversationCollaboration: value } } } } }), false, JSON.stringify(value));
  }
  let rootRound = 0;
  await fixture(async (request, f, start) => {
    if (request.conversationId !== ROOT) return answer('worker done');
    rootRound += 1;
    const names = start.tools.map(tool => tool.name);
    for (const name of CROSS_CONVERSATION_TOOL_NAMES) assert.ok(!names.includes(name), `${name} must not be offered`);
    if (rootRound === 1) return toolsAnswer(call('forged-list', 'list_conversations'),
      call('spawn', 'run_agent', { operation: 'spawn', taskName: 'worker', prompt: 'worker task', foregroundWaitMs: 0 }));
    assert.notEqual(lastResult(start, 'list_conversations')?.status, 'succeeded');
    return answer('Team work still runs.');
  }, async f => {
    const started = await f.input(ROOT, 'malformed switch');
    assert.equal((await f.terminated(started.turnId)).terminal_status, 'completed');
    assert.equal(rootRound, 2);
    const [child] = await f.rows('ChildExecution');
    assert.ok(child, 'child tasks still start under a malformed switch');
    await f.until(async () => (await f.rows('Turn', { conversation_id: child.child_conversation_id })).some(turn => turn.status === 'terminated'), 'The child never ran.');
    await assert.rejects(f.app.runtime.collaboration.listConversations({ turnId: started.turnId }), /not enabled/);
  }, { switchValue: 'true' });
});

test('list excludes this conversation, its team and child tasks; read returns the peer transcript as untrusted data', { timeout: 60000 }, async () => {
  const HISTORY = 'PEER_HISTORY_QUESTION_4410';
  const REPLY = 'PEER_HISTORY_REPLY_4411';
  let rootRound = 0, peerRound = 0;
  const spawn = (id, taskName) => toolsAnswer(call(id, 'run_agent', { operation: 'spawn', taskName, prompt: `${taskName} task`, foregroundWaitMs: 0 }));
  await fixture(async (request, f, start) => {
    if (request.conversationId === PEER) return ++peerRound === 1 ? spawn('peer-spawn', 'peer worker') : answer(REPLY);
    // Real child tasks of both teams: phase one never lists or addresses them across teams.
    if (request.conversationId !== ROOT) return answer('worker done');
    rootRound += 1;
    if (rootRound === 1) {
      const names = start.tools.map(tool => tool.name);
      for (const name of CROSS_CONVERSATION_TOOL_NAMES) assert.ok(names.includes(name), `${name} must be offered`);
      return spawn('root-spawn', 'root worker');
    }
    if (rootRound === 2) return toolsAnswer(call('list', 'list_conversations'));
    if (rootRound === 3) {
      const listed = detail(start, 'list_conversations');
      assert.match(listed.untrustedDataNotice, /untrusted/);
      assert.deepEqual(listed.conversations.map(entry => entry.title), ['Peer title'], 'self, own team and child tasks are excluded');
      assert.equal(listed.conversations[0].running, false);
      assert.match(listed.conversations[0].conversationRef, /^C\d+$/);
      assert.doesNotMatch(JSON.stringify(listed), /"conversationId"/);
      return toolsAnswer(call('read', 'read_conversation', { conversationRef: listed.conversations[0].conversationRef }));
    }
    const transcript = detail(start, 'read_conversation');
    assert.match(transcript?.untrustedDataNotice ?? '', /untrusted/, JSON.stringify(lastResult(start, 'read_conversation')));
    const texts = transcript.messages.map(message => [message.role, message.text]);
    assert.deepEqual(texts.find(([, text]) => text === HISTORY), ['user', HISTORY]);
    assert.deepEqual(texts.find(([, text]) => text === REPLY), ['model', REPLY]);
    assert.ok(transcript.messages.every(message => /^R\d+$/.test(message.messageRef)));
    return answer('Read the peer.');
  }, async f => {
    const peer = await f.input(PEER, HISTORY);
    assert.equal((await f.terminated(peer.turnId)).terminal_status, 'completed');
    const started = await f.input(ROOT, 'list-and-read');
    assert.equal((await f.terminated(started.turnId)).terminal_status, 'completed');
    assert.equal(rootRound, 4);
    const children = await f.rows('ChildExecution');
    assert.equal(children.length, 2);
    assert.equal((await f.rows('Turn', { conversation_id: PEER })).length, 1, 'reading never starts the other conversation');
    for (const child of children) {
      await assert.rejects(f.app.runtime.collaboration.readConversation({ conversationId: ROOT, targetConversationId: child.child_conversation_id,
        crossConversationTurnId: started.turnId }), /child task/);
      await assert.rejects(f.app.runtime.collaboration.listConversations({ turnId: (await f.rows('Turn', { conversation_id: child.child_conversation_id }))[0].id }),
        /top-level/, 'a child task cannot use cross-conversation access');
    }
  });
});

test('a followup to a running conversation waits for its Turn to end, then starts exactly one Turn', { timeout: 60000 }, async () => {
  const TASK = 'CROSS_QUEUED_TASK_7701';
  const RESULT = 'CROSS_QUEUED_RESULT_7702';
  let rootRound = 0, peerFirstTurn, followupObserved = false;
  await fixture(async (request, f, start, wire) => {
    const text = JSON.stringify(start.contents);
    if (request.conversationId === PEER) {
      if (!peerFirstTurn) {
        peerFirstTurn = request.turnId;
        await f.until(async () => (await f.rows('CollaborationMessageTargetLink', { conversation_id: PEER })).length > 0, 'Root never sent to the running peer.');
        const [target] = await f.rows('CollaborationMessageTargetLink', { conversation_id: PEER });
        assert.equal(target.anchor_turn_id, peerFirstTurn, 'the send is anchored behind the running Turn');
        assert.equal((await f.rows('PendingTurnInput', { turn_id: peerFirstTurn })).length, 0, 'the running Turn is never interrupted');
        return answer('Peer finished its own work.');
      }
      assert.notEqual(request.turnId, peerFirstTurn);
      assert.ok(text.includes(TASK));
      assertPeerWireRole(wire, TASK);
      assert.match(text, /not a new user instruction/);
      assert.deepEqual(await userMessages(f, request.turnId), [], 'the peer task is never a user message');
      followupObserved = true;
      return answer(RESULT);
    }
    assert.equal(request.conversationId, ROOT);
    rootRound += 1;
    if (rootRound === 1) {
      await f.until(() => peerFirstTurn, 'Peer never started.');
      return toolsAnswer(call('list', 'list_conversations'));
    }
    if (rootRound === 2) {
      const listed = lastResult(start, 'list_conversations');
      const peer = listed.detail?.conversations?.find(entry => entry.title === 'Peer title');
      assert.ok(peer, JSON.stringify(listed));
      assert.equal(peer.running, true);
      return toolsAnswer(call('send', 'send_conversation_message', { conversationRef: peer.conversationRef, text: TASK, mode: 'followup' }));
    }
    const sent = detail(start, 'send_conversation_message');
    assert.equal(sent.accepted, true);
    assert.equal(sent.queued, true);
    assert.match(sent.messageRef, /^M\d+$/);
    return answer('Delegated to the peer.');
  }, async f => {
    const peer = await f.input(PEER, 'peer-own-work');
    const started = await f.input(ROOT, 'delegate');
    assert.equal((await f.terminated(started.turnId)).terminal_status, 'completed');
    assert.equal((await f.terminated(peer.turnId)).terminal_status, 'completed');
    await f.until(async () => followupObserved && (await f.rows('CollaborationRequest'))[0]?.state === 'completed', 'The queued followup never completed.');
    await f.until(async () => (await f.rows('Turn', { conversation_id: PEER })).every(turn => turn.status === 'terminated'), 'Peer followup never ended.');
    assert.equal((await f.rows('Turn', { conversation_id: PEER })).length, 2, 'the followup starts exactly one Turn after the running one');
    const completion = (await f.app.runtime.collaboration.listMessages({ conversationId: ROOT })).messages.find(message => message.sourceKind === 'completion');
    assert.equal((await f.app.runtime.collaboration.readMessage({ conversationId: ROOT, messageId: completion.messageId })).text, RESULT);
  });
});

test('create_conversation starts a first Turn from a peer task and replaying the call creates nothing new', { timeout: 60000 }, async () => {
  const TASK = 'CROSS_CREATED_TASK_5501';
  const RESULT = 'CROSS_CREATED_RESULT_5502';
  let rootRound = 0, createdObserved, rootTurn;
  await fixture(async (request, f, start, wire) => {
    if (request.conversationId !== ROOT) {
      createdObserved = request.conversationId;
      assert.ok(JSON.stringify(start.contents).includes(TASK));
      assertPeerWireRole(wire, TASK);
      assert.deepEqual(await userMessages(f, request.turnId), []);
      return answer(RESULT);
    }
    rootRound += 1;
    rootTurn = request.turnId;
    if (rootRound === 1) return toolsAnswer(call('create', 'create_conversation', { prompt: TASK, title: 'Spawned audit' }));
    const created = detail(start, 'create_conversation');
    assert.match(created.conversationRef, /^C\d+$/);
    assert.equal(created.title, 'Spawned audit');
    assert.match(created.messageRef, /^M\d+$/);
    return answer('Created a conversation.');
  }, async f => {
    const started = await f.input(ROOT, 'please create a separate conversation');
    assert.equal((await f.terminated(started.turnId)).terminal_status, 'completed');
    const toolCallId = f.toolCallId('create');
    const conversationId = kernel.stablePhaseFId('conversation', 'cross-create', toolCallId);
    const [policy] = await f.rows('ToolCallPolicySnapshot', { tool_call_id: toolCallId });
    assert.equal(policy.execution_gate, 'automatic', 'send-type tools run without confirmation unless the user asks for it');
    assert.equal(policy.summary, '新建对话 · Spawned audit');
    await f.until(async () => (await f.rows('CollaborationRequest'))[0]?.state === 'completed', 'The created conversation never answered.');
    assert.equal(createdObserved, conversationId);
    const [conversation] = await f.rows('Conversation', { id: conversationId });
    assert.equal(conversation.title, 'Spawned audit');
    assert.equal((await f.rows('AgentConversationLink', { conversation_id: conversationId, role: 'default' })).length, 1);
    const [rootProject] = await f.rows('ConversationProjectLink', { conversation_id: ROOT });
    const [createdProject] = await f.rows('ConversationProjectLink', { conversation_id: conversationId });
    assert.equal(createdProject.project_context_id, rootProject.project_context_id, 'the new conversation joins the caller\'s project');
    assert.deepEqual(await f.rows('ConversationOriginLink', { conversation_id: conversationId }), [], 'not a child task of the caller');
    assert.deepEqual(await f.rows('ChildExecution', { child_conversation_id: conversationId }), []);
    const turns = await f.rows('Turn', { conversation_id: conversationId });
    assert.equal(turns.length, 1);
    const [firstAuthority] = await f.rows('AuthoritySnapshot', { turn_id: turns[0].id });
    const [rootAuthority] = await f.rows('AuthoritySnapshot', { turn_id: started.turnId });
    const model = async row => JSON.parse((await f.app.contentStore.read((await f.rows('ContentObject', { id: row.content_object_id }))[0])).toString('utf8')).model;
    assert.deepEqual([(await model(firstAuthority)).providerConfigId, (await model(firstAuthority)).modelId],
      [(await model(rootAuthority)).providerConfigId, (await model(rootAuthority)).modelId], 'the calling Turn fixes the model');
    const completion = (await f.app.runtime.collaboration.listMessages({ conversationId: ROOT })).messages.find(message => message.sourceKind === 'completion');
    assert.equal((await f.app.runtime.collaboration.readMessage({ conversationId: ROOT, messageId: completion.messageId })).text, RESULT);

    const conversations = (await f.rows('Conversation')).length;
    const replay = await f.lifecycle.createForCollaboration({ turnId: rootTurn, toolCallId, sourceConversationId: ROOT, prompt: TASK, title: 'Spawned audit' });
    assert.equal(replay.conversationId, conversationId);
    assert.equal(replay.deduplicated, true);
    assert.equal((await f.rows('Conversation')).length, conversations);
    assert.equal((await f.rows('Turn', { conversation_id: conversationId })).length, 1);
    assert.equal((await f.rows('CollaborationMessage')).filter(message => message.mode === 'followup').length, 1);
  });
});

test('fork_conversation copies completed history of the running caller and of another conversation, and replays deduplicate', { timeout: 60000 }, async () => {
  const QUESTION = 'ROOT_FIRST_QUESTION_6601';
  const ANSWER = 'ROOT_FIRST_ANSWER_6602';
  const SECOND = 'ROOT_SECOND_QUESTION_6603';
  let rootRound = 0, selfFork, peerFork;
  await fixture(async (request, f, start) => {
    if (request.conversationId === PEER) return answer('PEER_ANSWER_6604');
    assert.equal(request.conversationId, ROOT);
    rootRound += 1;
    if (rootRound === 1) return answer(ANSWER);
    if (rootRound === 2) return toolsAnswer(call('fork-self', 'fork_conversation'));
    if (rootRound === 3) {
      selfFork = detail(start, 'fork_conversation');
      assert.equal(selfFork.turnStarted, false);
      assert.match(selfFork.note, /did not start a turn/);
      assert.match(selfFork.conversationRef, /^C\d+$/);
      assert.notEqual(selfFork.conversationRef, selfFork.sourceConversationRef);
      const forkId = kernel.stablePhaseFId('conversation', `conversation-fork:${f.toolCallId('fork-self')}`);
      assert.deepEqual((await f.transcript(forkId)).map(message => message.text), [QUESTION, ANSWER], 'only the completed Turn is copied');
      assert.deepEqual(await f.rows('Turn', { conversation_id: forkId, status: 'active' }), [], 'the fork never starts a Turn');
      return toolsAnswer(call('list', 'list_conversations'));
    }
    if (rootRound === 4) {
      const peer = detail(start, 'list_conversations').conversations.find(entry => entry.title === 'Peer title');
      return toolsAnswer(call('fork-peer', 'fork_conversation', { conversationRef: peer.conversationRef }));
    }
    peerFork = detail(start, 'fork_conversation');
    return answer('Forked twice.');
  }, async f => {
    const first = await f.input(ROOT, QUESTION);
    await f.terminated(first.turnId);
    const peer = await f.input(PEER, 'PEER_QUESTION_6605');
    await f.terminated(peer.turnId);
    const second = await f.input(ROOT, SECOND);
    assert.equal((await f.terminated(second.turnId)).terminal_status, 'completed');
    assert.ok(selfFork && peerFork);
    const selfForkId = kernel.stablePhaseFId('conversation', `conversation-fork:${f.toolCallId('fork-self')}`);
    const peerForkId = kernel.stablePhaseFId('conversation', `conversation-fork:${f.toolCallId('fork-peer')}`);
    assert.deepEqual((await f.transcript(peerForkId)).map(message => message.text), ['PEER_QUESTION_6605', 'PEER_ANSWER_6604']);
    for (const id of [selfForkId, peerForkId]) {
      const [origin] = await f.rows('ConversationOriginLink', { conversation_id: id });
      assert.equal(origin.source_tool_call_id, null, 'a forked conversation is not a child task');
      assert.deepEqual(await f.rows('Turn', { conversation_id: id, status: 'active' }), []);
    }
    // The caller's second Turn has now ended too, yet the replay keeps the committed boundary.
    const replay = await f.lifecycle.forkCompletedHistory({ sourceConversationId: ROOT, commandId: f.toolCallId('fork-self') });
    assert.deepEqual([replay.conversationId, replay.deduplicated], [selfForkId, true]);
    assert.deepEqual((await f.transcript(selfForkId)).map(message => message.text), [QUESTION, ANSWER]);
    assert.equal((await f.rows('ConversationBranchLink')).length, 2);
  });
});
