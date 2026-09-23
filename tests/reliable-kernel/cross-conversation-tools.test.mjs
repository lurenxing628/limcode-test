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
const { createBuiltinToolDefinitions } = load('backend/world/modules/tools/definitions/index.js');
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
async function fixture(send, run, { enabled = true, switchValue = true, wakeGate, runAgentConfig = {}, toolConfigs = {}, dispatchHook } = {}) {
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
    async settingsFor(conversationId) {
      const state = await configuration.configurationClientState();
      return { modelProfiles: state.modelProfileScopeLinks.filter(link => link.scopeKind === 'conversation' && link.scopeId === conversationId),
        workEnvironments: state.conversationWorkEnvironmentLinks.filter(link => link.conversationId === conversationId) };
    },
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
      ...(enabled ? { toolConfigs: { ...toolConfigs, run_agent: { config: { ...runAgentConfig, crossConversationCollaboration: switchValue } } } } : {}) });
    const rootAuthority = new kernel.RootAuthority(() => path.join(root, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(rootAuthority);
    app = await kernel.ReliableKernelApplication.open(rootAuthority, {
      authorityCompiler: configuration, compressionSettingsAuthority: configuration, attachmentSettings: configuration,
      resolveWorkEnvironment: async () => undefined,
      // No level-trigger polling within a test: queued work must start from the commit that ends the
      // target Turn, not from a periodic rescan.
      processCompletionDelivery: { scanIntervalMs: 60000 },
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
            // A failed hook assertion fails the test at once instead of surfacing as a later timeout.
            try { await dispatchHook?.(input, f); } catch (error) { errors.push(error); throw error; }
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
    app.processDeliveries.setWakeHandler(async request => { wakes.push(structuredClone(request)); await wakeGate?.(request); return wake(request); });
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
  let rootRound = 0, peerRound = 0, childRequests = 0;
  const spawn = (id, taskName) => toolsAnswer(call(id, 'run_agent', { operation: 'spawn', taskName, prompt: `${taskName} task`, foregroundWaitMs: 0 }));
  // The production registry no longer carries the board, so no conversation is ever offered it. This
  // registry check is the guard: the fixture's own definitions never included the board.
  const builtin = createBuiltinToolDefinitions({ command: { toolName: 'bash', description: 'Synthetic shell.' } }).map(tool => tool.declaration.name);
  assert.ok(!builtin.includes('agent_board'), 'agent_board is not registered for models in phase one');
  for (const name of CROSS_CONVERSATION_TOOL_NAMES) assert.ok(builtin.includes(name), `${name} is registered`);
  await fixture(async (request, f, start) => {
    const names = start.tools.map(tool => tool.name);
    if (request.conversationId === PEER) return ++peerRound === 1 ? spawn('peer-spawn', 'peer worker') : answer(REPLY);
    // Real child tasks of both teams: phase one never lists or addresses them across teams, and a
    // child task is not offered the cross-conversation tools even though its Turn froze the switch on.
    if (request.conversationId !== ROOT) {
      childRequests += 1;
      for (const name of CROSS_CONVERSATION_TOOL_NAMES) assert.ok(!names.includes(name), `${name} offered to a child task`);
      assert.ok(names.includes('list_agents'), 'a child task keeps its team tools');
      return answer('worker done');
    }
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
    await f.until(async () => childRequests >= 2, 'Both child tasks must reach the provider.');
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

test('a message to a running conversation is never injected into its Turn and joins the next Turn without starting one', { timeout: 60000 }, async () => {
  const NOTE = 'CROSS_QUEUED_NOTE_7801';
  let rootRound = 0, peerFirstTurn, noteSeen;
  await fixture(async (request, f, start, wire) => {
    const text = JSON.stringify(start.contents);
    if (request.conversationId === PEER) {
      if (!peerFirstTurn) {
        peerFirstTurn = request.turnId;
        await f.until(async () => (await f.rows('CollaborationMessageTargetLink', { conversation_id: PEER })).length > 0, 'Root never sent to the running peer.');
        // Give the running Turn a real safe boundary: a second model request in the same Turn.
        return toolsAnswer(call('peer-list', 'list_conversations'));
      }
      if (request.turnId === peerFirstTurn) {
        assert.ok(!text.includes(NOTE), 'the running Turn never sees the queued message');
        return answer('Peer finished its own work.');
      }
      noteSeen = text.includes(NOTE);
      assertPeerWireRole(wire, NOTE);
      return answer('Peer read the note.');
    }
    rootRound += 1;
    if (rootRound === 1) {
      await f.until(() => peerFirstTurn, 'Peer never started.');
      return toolsAnswer(call('list', 'list_conversations'));
    }
    if (rootRound === 2) {
      const peer = detail(start, 'list_conversations').conversations.find(entry => entry.title === 'Peer title');
      return toolsAnswer(call('send', 'send_conversation_message', { conversationRef: peer.conversationRef, text: NOTE, mode: 'message' }));
    }
    assert.equal(detail(start, 'send_conversation_message').queued, true);
    return answer('Informed the peer.');
  }, async f => {
    const peer = await f.input(PEER, 'peer-own-work');
    const root = await f.input(ROOT, 'inform');
    await f.terminated(root.turnId);
    assert.equal((await f.terminated(peer.turnId)).terminal_status, 'completed');
    assert.deepEqual(await f.rows('PendingTurnInput', { turn_id: peer.turnId }), [], 'never injected into the running Turn');
    const [delivery] = await f.rows('RuntimeDelivery', { target_conversation_id: PEER });
    assert.deepEqual([delivery.state, delivery.phase, delivery.target_turn_id], ['pending', 'next_turn', null]);
    assert.equal((await f.rows('Turn', { conversation_id: PEER })).length, 1, 'a message never starts a Turn');
    const next = await f.input(PEER, 'anything new?');
    assert.equal((await f.terminated(next.turnId)).terminal_status, 'completed');
    assert.equal(noteSeen, true, 'the message joins the next Turn');
    assert.equal((await f.rows('RuntimeDelivery', { id: delivery.id }))[0].target_turn_id, next.turnId);
  });
});

test('a user Turn that wins the race after the anchor ends leaves the queued peer task to its own Turn', { timeout: 60000 }, async () => {
  const TASK = 'CROSS_RACE_TASK_8801';
  const RESULT = 'CROSS_RACE_RESULT_8802';
  const USER = 'PEER_USER_RACE_8803';
  const USER_ANSWER = 'PEER_USER_ANSWER_8804';
  let rootRound = 0, peerFirstTurn, userTurn, continuationTurn, held, release;
  const releaseWake = new Promise(resolve => { release = resolve; });
  await fixture(async (request, f, start, wire) => {
    const text = JSON.stringify(start.contents);
    if (request.conversationId === PEER) {
      if (!peerFirstTurn) {
        peerFirstTurn = request.turnId;
        await f.until(async () => (await f.rows('CollaborationMessageTargetLink', { conversation_id: PEER })).length > 0, 'Root never sent to the running peer.');
        return answer('Peer finished its own work.');
      }
      if (request.turnId === userTurn) {
        assert.ok(!text.includes(TASK), 'the user Turn never receives the peer task');
        return answer(USER_ANSWER);
      }
      continuationTurn = request.turnId;
      assert.ok(text.includes(TASK));
      assertPeerWireRole(wire, TASK);
      assert.deepEqual(await userMessages(f, request.turnId), [], 'the continuation carries no user message');
      return answer(RESULT);
    }
    rootRound += 1;
    if (rootRound === 1) {
      await f.until(() => peerFirstTurn, 'Peer never started.');
      return toolsAnswer(call('list', 'list_conversations'));
    }
    if (rootRound === 2) {
      const peer = detail(start, 'list_conversations').conversations.find(entry => entry.title === 'Peer title');
      return toolsAnswer(call('send', 'send_conversation_message', { conversationRef: peer.conversationRef, text: TASK, mode: 'followup' }));
    }
    return answer('Delegated to the peer.');
  }, async f => {
    const peer = await f.input(PEER, 'peer-own-work');
    const root = await f.input(ROOT, 'delegate');
    await f.terminated(root.turnId);
    await f.terminated(peer.turnId);
    await f.until(() => held, 'The queued followup was never dispatched after the anchor ended.');
    const [delivery] = (await f.rows('RuntimeDelivery', { target_conversation_id: PEER })).filter(row => row.id === held.deliveryId);
    // The user speaks first; the durable wake is still in flight.
    let user;
    try {
      user = await f.input(PEER, USER);
      userTurn = user.turnId;
      assert.equal((await f.rows('RuntimeDelivery', { id: delivery.id }))[0].state, 'pending', 'the user Turn does not consume the peer task');
    } finally { release(); }
    assert.equal((await f.terminated(user.turnId)).terminal_status, 'completed');
    await f.until(async () => (await f.rows('CollaborationRequest'))[0]?.state === 'completed', 'The peer task never ran in its own Turn.');
    const turns = await f.rows('Turn', { conversation_id: PEER });
    assert.equal(turns.length, 3, 'own work, the user Turn, then exactly one continuation');
    assert.ok(continuationTurn && continuationTurn !== user.turnId);
    assert.equal((await f.rows('RuntimeDelivery', { id: delivery.id }))[0].target_turn_id, continuationTurn);
    assert.deepEqual((await f.rows('CollaborationRequestTurnLink')).map(link => link.turn_id), [continuationTurn]);
    const completion = (await f.app.runtime.collaboration.listMessages({ conversationId: ROOT })).messages.find(message => message.sourceKind === 'completion');
    assert.equal((await f.app.runtime.collaboration.readMessage({ conversationId: ROOT, messageId: completion.messageId })).text, RESULT, 'the requester gets the peer task result, not the user answer');
  }, { wakeGate: async request => {
    if (request.conversationId !== PEER || request.action !== 'start_continuation') return;
    held = request;
    await releaseWake;
  } });
});

test('deleting the target while a followup is queued tells the waiting sender the task could not start', { timeout: 60000 }, async () => {
  const TASK = 'CROSS_DELETED_TASK_9901';
  let rootRound = 0, peerFirstTurn, held, release, heardFailure = false;
  const releaseWake = new Promise(resolve => { release = resolve; });
  await fixture(async (request, f, start) => {
    const text = JSON.stringify(start.contents);
    if (request.conversationId === PEER) {
      assert.equal(peerFirstTurn, undefined, 'the deleted target never starts the task');
      peerFirstTurn = request.turnId;
      await f.until(async () => (await f.rows('CollaborationMessageTargetLink', { conversation_id: PEER })).length > 0, 'Root never sent to the running peer.');
      return answer('Peer finished its own work.');
    }
    rootRound += 1;
    if (rootRound === 1) {
      await f.until(() => peerFirstTurn, 'Peer never started.');
      return toolsAnswer(call('list', 'list_conversations'));
    }
    if (rootRound === 2) {
      const peer = detail(start, 'list_conversations').conversations.find(entry => entry.title === 'Peer title');
      return toolsAnswer(call('send', 'send_conversation_message', { conversationRef: peer.conversationRef, text: TASK, mode: 'followup' }));
    }
    if (rootRound === 3) return answer('Waiting for the peer.');
    heardFailure = /Task could not start: the target conversation was deleted/.test(text);
    return answer('Noted.');
  }, async f => {
    const peer = await f.input(PEER, 'peer-own-work');
    const root = await f.input(ROOT, 'delegate');
    await f.terminated(root.turnId);
    await f.terminated(peer.turnId);
    await f.until(() => held, 'The queued followup was never dispatched after the anchor ended.');
    try {
      await f.app.conversationDeletion.delete(PEER);
    } finally { release(); }
    await f.until(async () => (await f.rows('CollaborationRequest'))[0]?.state === 'failed', 'The unstartable task was never settled.');
    const reply = (await f.app.runtime.collaboration.listMessages({ conversationId: ROOT })).messages.find(message => message.sourceKind === 'completion');
    assert.ok(reply, 'the sender is answered instead of waiting forever');
    assert.equal(reply.sourceConversationId, PEER);
    assert.match((await f.app.runtime.collaboration.readMessage({ conversationId: ROOT, messageId: reply.messageId })).text, /^Task could not start: the target conversation was deleted/);
    const next = await f.input(ROOT, 'any news?');
    await f.terminated(next.turnId);
    assert.equal(heardFailure, true, 'the model sees the failure reply in its next Turn');
  }, { wakeGate: async request => {
    if (request.conversationId !== PEER || request.action !== 'start_continuation') return;
    held = request;
    await releaseWake;
  } });
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

    const frozenEnvironment = JSON.parse((await f.app.contentStore.read((await f.rows('ContentObject', { id: rootAuthority.content_object_id }))[0])).toString('utf8')).workEnvironmentPolicy?.defaultWorkEnvironmentId ?? null;
    assert.ok(frozenEnvironment, 'fixture: the calling Turn froze a work environment');
    assert.deepEqual((await f.settingsFor(conversationId)).workEnvironments.map(link => link.workEnvironmentId), [frozenEnvironment],
      'the new conversation starts in the caller\'s work environment');

    const conversations = (await f.rows('Conversation')).length;
    const replay = await f.lifecycle.createForCollaboration({ turnId: rootTurn, toolCallId, sourceConversationId: ROOT, prompt: TASK, title: 'Spawned audit' });
    assert.equal(replay.conversationId, conversationId);
    assert.equal(replay.deduplicated, true);
    assert.equal((await f.rows('Conversation')).length, conversations);
    assert.equal((await f.rows('Turn', { conversation_id: conversationId })).length, 1);
    assert.equal((await f.rows('CollaborationMessage')).filter(message => message.mode === 'followup').length, 1);

    // The user deletes the created conversation; a late replay of the same call never brings it back.
    await f.app.conversationDeletion.delete(conversationId);
    await assert.rejects(f.lifecycle.createForCollaboration({ turnId: rootTurn, toolCallId, sourceConversationId: ROOT, prompt: TASK, title: 'Spawned audit' }), /deleted/);
    assert.deepEqual(await f.rows('Conversation', { id: conversationId }), []);
    assert.equal((await f.rows('Conversation')).length, conversations - 1);
  });
});

test('one Turn may create or fork at most 8 conversations; the next call is refused without writing', { timeout: 90000 }, async () => {
  let rootRound = 0, refused;
  const spawnCalls = [...Array.from({ length: 7 }, (_, index) => call(`fork-${index}`, 'fork_conversation')),
    call('create-8', 'create_conversation', { prompt: 'CAP_CREATED_TASK_1201', title: 'Eighth' }),
    call('create-9', 'create_conversation', { prompt: 'CAP_REFUSED_TASK_1202', title: 'Ninth' })];
  await fixture(async (request, f, start) => {
    if (request.conversationId !== ROOT) return answer('created conversation done');
    rootRound += 1;
    if (rootRound === 1) return answer('first answer');
    if (rootRound === 2) return toolsAnswer(...spawnCalls);
    const results = start.contents.flatMap(content => content.parts).map(part => part.functionResponse).filter(Boolean);
    refused = results.at(-1);
    assert.deepEqual(results.slice(-9, -1).map(result => result.response?.status), Array(8).fill('succeeded'), JSON.stringify(results));
    return answer('Spawned.');
  }, async f => {
    await f.terminated((await f.input(ROOT, 'first question')).turnId);
    const conversations = (await f.rows('Conversation')).length;
    const started = await f.input(ROOT, 'fan out');
    assert.equal((await f.terminated(started.turnId)).terminal_status, 'completed');
    assert.notEqual(refused?.response?.status, 'succeeded');
    assert.match(JSON.stringify(refused), /8 create_conversation or fork_conversation calls/);
    assert.equal((await f.rows('Conversation')).length, conversations + 8, 'seven forks and one created conversation, nothing for the refused call');
    const refusedId = kernel.stablePhaseFId('conversation', 'cross-create', f.toolCallId('create-9'));
    assert.deepEqual(await f.rows('Conversation', { id: refusedId }), []);
    assert.equal((await f.rows('CollaborationMessage')).filter(message => message.mode === 'followup').length, 1);
  });
});

test('create_conversation that cannot run leaves no conversation behind, not even on retry', { timeout: 60000 }, async () => {
  let rootRound = 0;
  const created = [];
  await fixture(async (request, f, start) => {
    assert.equal(request.conversationId, ROOT, 'no created conversation ever runs');
    rootRound += 1;
    if (rootRound === 1) return toolsAnswer(call('create-first', 'create_conversation', { prompt: 'NO_BUDGET_TASK_3301' }));
    const result = lastResult(start, 'create_conversation');
    assert.notEqual(result?.status, 'succeeded', JSON.stringify(result));
    assert.match(JSON.stringify(result), /budget exhausted \(0\)/);
    if (rootRound === 2) return toolsAnswer(call('create-retry', 'create_conversation', { prompt: 'NO_BUDGET_TASK_3301' }));
    return answer('Could not delegate.');
  }, async f => {
    const conversations = (await f.rows('Conversation')).length;
    const started = await f.input(ROOT, 'create a separate conversation');
    assert.equal((await f.terminated(started.turnId)).terminal_status, 'completed');
    assert.equal(rootRound, 3);
    for (const id of ['create-first', 'create-retry']) created.push(kernel.stablePhaseFId('conversation', 'cross-create', f.toolCallId(id)));
    assert.equal((await f.rows('Conversation')).length, conversations, 'a refused create writes no Conversation');
    for (const id of created) {
      assert.deepEqual(await f.settingsFor(id), { modelProfiles: [], workEnvironments: [] }, 'nor any settings for it');
      // A replay after the Turn ended is refused as well.
      await assert.rejects(f.lifecycle.createForCollaboration({ turnId: started.turnId, toolCallId: f.toolCallId(id === created[0] ? 'create-first' : 'create-retry'),
        sourceConversationId: ROOT, prompt: 'NO_BUDGET_TASK_3301' }));
    }
    assert.equal((await f.rows('Conversation')).length, conversations);
    assert.deepEqual(await f.rows('CollaborationMessage'), []);
  }, { runAgentConfig: { maxAutomaticFollowups: 0 } });
});

test('create_conversation with an unavailable work environment writes nothing', { timeout: 60000 }, async () => {
  let rootRound = 0;
  await fixture(async (request, f, start) => {
    assert.equal(request.conversationId, ROOT);
    rootRound += 1;
    if (rootRound === 1) {
      // The environment the Turn froze disappears before the call runs.
      const state = await f.configuration.configurationClientState();
      for (const environment of state.workEnvironments) await f.configuration.mutations.upsertWorkEnvironment({ ...environment, available: false });
      return toolsAnswer(call('create', 'create_conversation', { prompt: 'NO_ENVIRONMENT_TASK_3302' }));
    }
    assert.notEqual(lastResult(start, 'create_conversation')?.status, 'succeeded');
    return answer('Could not create.');
  }, async f => {
    const conversations = (await f.rows('Conversation')).length;
    const started = await f.input(ROOT, 'create a separate conversation');
    assert.equal((await f.terminated(started.turnId)).terminal_status, 'completed');
    const id = kernel.stablePhaseFId('conversation', 'cross-create', f.toolCallId('create'));
    assert.equal((await f.rows('Conversation')).length, conversations);
    assert.deepEqual(await f.settingsFor(id), { modelProfiles: [], workEnvironments: [] });
    assert.deepEqual(await f.rows('CollaborationMessage'), []);
  });
});

test('create_conversation interrupted between its steps resumes on replay without duplicating anything', { timeout: 60000 }, async () => {
  const TASK = 'RESUMED_CREATE_TASK_3303';
  let rootRound = 0, crashed = false, createdTurns = 0;
  await fixture(async (request, f) => {
    if (request.conversationId !== ROOT) { createdTurns += 1; return answer('resumed conversation done'); }
    rootRound += 1;
    if (rootRound === 1) return toolsAnswer(call('create', 'create_conversation', { prompt: TASK, title: 'Resumed' }));
    return answer('Created.');
  }, async f => {
    const started = await f.input(ROOT, 'create a separate conversation');
    assert.equal((await f.terminated(started.turnId)).terminal_status, 'completed');
    assert.equal(crashed, true);
    const id = kernel.stablePhaseFId('conversation', 'cross-create', f.toolCallId('create'));
    await f.until(async () => (await f.rows('CollaborationRequest'))[0]?.state === 'completed', 'The resumed conversation never answered.');
    assert.equal((await f.rows('Conversation', { id })).length, 1);
    assert.equal((await f.settingsFor(id)).modelProfiles.length, 1, 'the replay writes the settings again');
    assert.equal((await f.rows('CollaborationMessage')).filter(message => message.mode === 'followup').length, 1);
    assert.equal((await f.rows('Turn', { conversation_id: id })).length, 1);
    assert.equal(createdTurns, 1);
  }, { dispatchHook: async (input, f) => {
    if (input.toolName !== 'create_conversation' || crashed) return;
    crashed = true;
    // The Host dies after the first settings write: nothing is visible yet, and the replay resumes.
    const mutations = f.configuration.mutations;
    const original = mutations.initializeConversationModelProfile;
    mutations.initializeConversationModelProfile = async function(...args) { await original.apply(this, args); throw new Error('simulated crash after the model profile'); };
    try {
      await assert.rejects(f.lifecycle.createForCollaboration({ turnId: input.turnId, toolCallId: input.toolCallId, sourceConversationId: ROOT, prompt: TASK, title: 'Resumed' }), /simulated crash/);
    } finally { mutations.initializeConversationModelProfile = original; }
    const id = kernel.stablePhaseFId('conversation', 'cross-create', input.toolCallId);
    assert.deepEqual(await f.rows('Conversation', { id }), [], 'an interrupted creation leaves no conversation');
    assert.deepEqual(await f.settingsFor(id), { modelProfiles: [], workEnvironments: [] }, 'nor the work environment and model profile it had written');
    assert.deepEqual(await f.rows('CollaborationMessage'), []);
  } });
});

test('create_conversation refused by the atomic send after admission leaves no settings behind', { timeout: 60000 }, async () => {
  const TASK = 'REFUSED_AFTER_ADMISSION_3305';
  let rootRound = 0, refused = false;
  await fixture(async (request, f) => {
    if (request.conversationId !== ROOT) return answer('created conversation done');
    rootRound += 1;
    if (rootRound === 1) return toolsAnswer(call('create', 'create_conversation', { prompt: TASK, title: 'Raced' }));
    return answer('Created.');
  }, async f => {
    const started = await f.input(ROOT, 'create a separate conversation');
    assert.equal((await f.terminated(started.turnId)).terminal_status, 'completed');
    assert.equal(refused, true);
    await f.until(async () => (await f.rows('CollaborationRequest'))[0]?.state === 'completed', 'The created conversation never answered.');
  }, { dispatchHook: async (input, f) => {
    if (input.toolName !== 'create_conversation' || refused) return;
    refused = true;
    // Admission passed, then another Turn of the chain spent the last followup: the atomic send refuses.
    const collaboration = f.app.runtime.collaboration;
    const mutations = f.configuration.mutations;
    const original = collaboration.send, clear = mutations.clearConversationConfiguration;
    const create = () => f.lifecycle.createForCollaboration({ turnId: input.turnId, toolCallId: input.toolCallId, sourceConversationId: ROOT, prompt: TASK, title: 'Raced' });
    const id = kernel.stablePhaseFId('conversation', 'cross-create', input.toolCallId);
    collaboration.send = async function() { throw new Error('Automatic followup budget exhausted (1).'); };
    try {
      // A failing cleanup is only logged: the model still learns why the creation was refused.
      mutations.clearConversationConfiguration = async function() { throw new Error('settings store unavailable'); };
      try { await assert.rejects(create(), /budget exhausted/); } finally { mutations.clearConversationConfiguration = clear; }
      assert.equal((await f.settingsFor(id)).modelProfiles.length, 1, 'fixture: the failed cleanup left the settings');
      await assert.rejects(create(), /budget exhausted/);
    } finally { collaboration.send = original; }
    assert.deepEqual(await f.rows('Conversation', { id }), []);
    assert.deepEqual(await f.settingsFor(id), { modelProfiles: [], workEnvironments: [] }, 'the refused creation clears the settings it wrote');
  } });
});

test('create_conversation with confirmation required waits for approval and creates only after it', { timeout: 60000 }, async () => {
  const TASK = 'APPROVED_CREATE_TASK_3304';
  let rootRound = 0, createdObserved = false;
  await fixture(async (request, f, start) => {
    if (request.conversationId !== ROOT) { createdObserved = JSON.stringify(start.contents).includes(TASK); return answer('approved conversation done'); }
    rootRound += 1;
    if (rootRound === 1) return toolsAnswer(call('create', 'create_conversation', { prompt: TASK }));
    assert.equal(lastResult(start, 'create_conversation')?.status, 'succeeded');
    return answer('Created after approval.');
  }, async f => {
    const started = await f.input(ROOT, 'create a separate conversation');
    const [approval] = await f.until(async () => {
      const requests = (await f.rows('InteractionRequest')).filter(row => row.request_kind === 'exec_approval');
      return requests.length ? requests : undefined;
    }, 'create_conversation never asked for approval.');
    const [call] = (await f.rows('ToolCall', { turn_id: started.turnId })).filter(row => row.tool_name === 'create_conversation');
    const toolCallId = call.id;
    const [policy] = await f.rows('ToolCallPolicySnapshot', { tool_call_id: toolCallId });
    assert.notEqual(policy.execution_gate, 'automatic');
    assert.equal(f.dispatches.some(input => input.toolCallId === toolCallId), false, 'the call does not run before approval');
    const id = kernel.stablePhaseFId('conversation', 'cross-create', toolCallId);
    assert.deepEqual(await f.rows('Conversation', { id }), [], 'nothing is created before the user approves');
    await f.app.interactions.resolveExecutionApproval({ source: { kind: 'command', key: 'approve-create' }, requestId: approval.id, decision: 'accept', response: {} });
    assert.equal((await f.terminated(started.turnId)).terminal_status, 'completed');
    await f.until(async () => (await f.rows('CollaborationRequest'))[0]?.state === 'completed', 'The approved conversation never answered.');
    assert.equal((await f.rows('Conversation', { id })).length, 1);
    assert.equal(createdObserved, true);
  }, { toolConfigs: { create_conversation: { autoApproveExecution: false } } });
});

test('turning the switch off mid-Turn leaves that Turn\'s frozen switch in force until it ends', { timeout: 60000 }, async () => {
  let rootRound = 0;
  await fixture(async (request, f, start) => {
    assert.equal(request.conversationId, ROOT);
    rootRound += 1;
    const names = start.tools.map(tool => tool.name);
    if (rootRound === 1) {
      assert.ok(names.includes('list_conversations'));
      await f.configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: definitions.map(tool => tool.declaration.name),
        toolConfigs: { run_agent: { config: { crossConversationCollaboration: false } } } });
      return toolsAnswer(call('list', 'list_conversations'));
    }
    if (rootRound === 2) {
      assert.equal(lastResult(start, 'list_conversations')?.status, 'succeeded', 'the running Turn keeps its frozen switch');
      assert.ok(names.includes('list_conversations'), 'the same Turn still offers the tools');
      return answer('Listed.');
    }
    for (const name of CROSS_CONVERSATION_TOOL_NAMES) assert.ok(!names.includes(name), `${name} is gone in the next Turn`);
    return answer('Switch is off now.');
  }, async f => {
    const first = await f.input(ROOT, 'list other conversations');
    assert.equal((await f.terminated(first.turnId)).terminal_status, 'completed');
    const next = await f.input(ROOT, 'and now?');
    assert.equal((await f.terminated(next.turnId)).terminal_status, 'completed');
    assert.equal(rootRound, 3);
    await assert.rejects(f.app.runtime.collaboration.listConversations({ turnId: next.turnId }), /not enabled/);
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
