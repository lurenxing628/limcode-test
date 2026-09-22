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
const { createRuntimeDeliveryWakeHandler } = load('backend/application/reliableKernel/runtimeDeliveryWakeHandler.js');
const { ReliableToolDispatcher } = load('backend/reliableKernel/toolDispatcher.js');
const { CollaborationToolDispatcher } = load('backend/reliableKernel/collaborationToolDispatcher.js');
const { runAgentTool } = load('backend/world/modules/tools/definitions/runAgent/index.js');
const { agentCollaborationToolModules } = load('backend/world/modules/tools/definitions/agentCollaboration/index.js');
const { dryRunLlmProvider } = load('backend/capabilities/llmProvider.js');
const { applyFrozenModelProviderConfig } = load('backend/reliableKernel/llmCapabilityProviderRegistry.js');
const { LlmEventType } = load('backend/world/modules/llm/events.js');
const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
const definitions = [runAgentTool, ...agentCollaborationToolModules.map(module => module.create({}))];
const call = (id, name, args = {}) => ({ id, functionCall: { name, args } });
const answer = text => ({ role: 'model', parts: [{ text }] });
const toolsAnswer = (...parts) => ({ role: 'model', parts });
const complete = (controls, content) => controls.onEvent({ kind: 'completed', streamSeq: '1', content });
const lastResult = (start, name) => start.contents.flatMap(content => content.parts)
  .filter(part => part.functionResponse?.name === name).at(-1)?.functionResponse.response;
const detail = (start, name) => lastResult(start, name)?.detail;

/** The external model alone is synthetic; dispatch, authority, ownership, persistence and wakes are production code. */
async function fixture(send, run, providerType = 'openai-compatible') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-collaboration-runtime-'));
  const configuration = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(path.join(root, 'settings'))));
  const save = async (section, settings) => configuration.saveGlobalSettings(section, settings, (await configuration.loadGlobalSettings(section)).revision);
  const provider = { ...createDefaultLlmProviderConfig({ name: 'synthetic collaboration' }), id: 'synthetic-collaboration',
    provider: providerType, baseUrl: 'https://example.invalid/v1', model: 'gpt-6-astra',
    models: [{ id: 'gpt-6-astra', name: 'synthetic' }], modelConfigs: [], generationConfig: {}, contextWindowTokens: 200000 };
  let app, coordinator, runner, collaborationTools;
  const errors = [], requests = [], wires = [], dispatches = [], wakes = [];
  const f = {
    errors, requests, wires, dispatches, wakes, configuration,
    get app() { return app; }, get runner() { return runner; },
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
    async terminated(turnId) { return f.until(async () => (await f.rows('TurnTermination', { turn_id: turnId }))[0], `Turn did not terminate: ${turnId}`); }
  };
  try {
    await save('llmProviderConfigs', { configs: [provider] });
    await save('llm', { activeProviderConfigId: provider.id });
    const parent = await configuration.mutations.createAgent({ name: 'Synthetic root', kind: 'custom' });
    const worker = await configuration.mutations.createAgent({ name: 'Synthetic worker', kind: 'custom' });
    // Deliberately omit maxChildAgentDepth: the unchanged user default must be 1.
    await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: definitions.map(tool => tool.declaration.name) });
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
        requests.push(observedRequest);
        try {
          let start;
          const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
            start(input, emit) { start = input; emit({ type: LlmEventType.Done, payload: { requestId: input.id } }); }, abort() {}, dispose() {}
          });
          await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, terminal: true, checkpointed: true }; } });
          const effective = applyFrozenModelProviderConfig(await configuration.providerConfig(providerId), request.modelId);
          const wire = await dryRunLlmProvider(start, { settings: { ...effective, apiKey: '' } });
          wires.push({ conversationId: request.conversationId, turnId: request.turnId, body: wire.body, start });
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
    collaborationTools = new CollaborationToolDispatcher({ database: app.database, contentStore: app.contentStore,
      effects: app.runtime.effects, collaboration: app.runtime.collaboration, board: app.runtime.collaborationBoard });
    coordinator = new ReliableChildAgentCoordinator({ database: app.database, ...app.runtime,
      modelProvider: app.modelProvider, turns: app.turns, agentLoop: app.agentLoop,
      agents: { async resolve() { return { agentId: worker.id, agentType: 'worker' }; } },
      modelProfiles: { initializeConversation: ({ conversationId, model, thinkingOverride }) =>
        configuration.mutations.initializeConversationModelProfile({ conversationId, ...model, ...(thinkingOverride ? { thinkingOverride } : {}) }) },
      deliveryWakeups: app.processDeliveries, ownedProcessCleanup: app.childOwnedProcessCleanup
    });
    runner = new ReliableConversationRunner(app, 'synthetic-collaboration-owner');
    const wake = createRuntimeDeliveryWakeHandler({ application: () => app, conversations: () => runner, children: () => coordinator });
    app.processDeliveries.setWakeHandler(async request => { wakes.push(structuredClone(request)); return wake(request); });
    const now = new Date().toISOString();
    await app.database.transaction(['root', 'ordinary'].flatMap(id => [
      repo('Conversation').insert({ id, title: id, status: 'active', created_at: now, updated_at: now }),
      repo('AgentConversationLink').insert({ id: `${id}-agent`, conversation_id: id, agent_id: parent.id, role: 'default', created_at: now, updated_at: now })
    ]));
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

const ACTIVE_MESSAGE = 'PEER_RUNNING_MESSAGE_6159';
const IDLE_MESSAGE = 'PEER_IDLE_MESSAGE_7128';
const FOLLOWUP = 'PEER_FOLLOWUP_TASK_8821';
const FOLLOWUP_RESULT = 'B_FINAL_RESULT_FOR_REQUESTER_A_2201';
const PEER_ACK = 'B_ACK_USES_NEW_C_AND_M_REFERENCES_3481';
function assertPeerWireRole(wire, marker) {
  const messages = (wire.messages ?? wire.input).filter(message => JSON.stringify(message.content ?? '').includes(marker));
  assert.ok(messages.length > 0, `Peer payload absent from provider wire: ${marker}`);
  assert.ok(messages.every(message => message.role === 'assistant'), 'peer result data is assistant transport, never user or system authority');
}

for (const providerType of ['openai-compatible', 'openai-responses']) test(`${providerType}: real sibling tools deliver at a safe boundary, preserve depth 1, and wake only explicit follow-ups with results returned to the requester`, { timeout: 90000 }, async () => {
  let a, b, aRound = 0, bRound = 0, rootRound = 0, bInitialTurn, bRef, activeMessageRef, idleTurnCount;
  let siblingFinished = false, activeObserved = false, followupObserved = false;
  await fixture(async (request, f, start, wire) => {
    if (request.conversationId === 'root') {
      if (++rootRound === 1) return toolsAnswer(
        call('spawn-a', 'run_agent', { operation: 'spawn', taskName: 'collaborator A', prompt: 'INITIAL_TASK_A_2001', foregroundWaitMs: 0 }),
        call('spawn-b', 'run_agent', { operation: 'spawn', taskName: 'collaborator B', prompt: 'INITIAL_TASK_B_2002', foregroundWaitMs: 0 }));
      await f.until(() => siblingFinished, 'Sibling collaboration never completed.');
      return answer('Root observed completed collaboration.');
    }
    const text = JSON.stringify(start.contents);
    if (text.includes('INITIAL_TASK_A_2001') && !a) a = request.conversationId;
    if (text.includes('INITIAL_TASK_B_2002') && !b) b = request.conversationId;
    if (request.conversationId === a) {
      aRound += 1;
      if (aRound === 1) { await f.until(() => b, 'B never started.'); return toolsAnswer(call('a-members', 'list_agents')); }
      if (aRound === 2) {
        const roster = detail(start, 'list_agents');
        const transcript = await f.app.runtime.collaboration.readConversation({
          conversationId: a, targetConversationId: b, limit: 20
        });
        assert.ok(transcript.messages.some(message => message.text.includes('INITIAL_TASK_B_2002')),
          'the real child spawn text/plain assignment must be readable by a team peer');
        const member = roster.members.find(member => member.title === 'collaborator B');
        assert.ok(member, JSON.stringify(roster));
        bRef = member.conversationRef;
        assert.match(bRef, /^C\d+$/);
        return toolsAnswer(call('a-send-running', 'send_agent_message', { conversationRef: bRef, text: ACTIVE_MESSAGE }));
      }
      if (aRound === 3) {
        activeMessageRef = detail(start, 'send_agent_message').messageRef;
        assert.match(activeMessageRef, /^M\d+$/);
        await f.until(async () => (await f.rows('ChildExecution', { child_conversation_id: b }))[0]?.status === 'idle', 'B initial Turn never became idle.');
        assert.equal(activeObserved, true);
        idleTurnCount = (await f.rows('Turn', { conversation_id: b })).length;
        return toolsAnswer(call('a-send-idle', 'send_agent_message', { conversationRef: bRef, text: IDLE_MESSAGE }));
      }
      if (aRound === 4) {
        await f.app.processDeliveries.scanNow();
        assert.equal((await f.rows('Turn', { conversation_id: b })).length, idleTurnCount, 'pure idle message must not start another Turn');
        const source = (await f.rows('CollaborationMessageSourceLink')).find(row => row.tool_call_id === f.dispatches.find(input => input.providerCallId === 'a-send-idle').toolCallId);
        const target = (await f.rows('CollaborationMessageTargetLink', { message_id: source.message_id }))[0];
        const delivery = (await f.rows('RuntimeDelivery', { inbox_item_id: target.inbox_item_id }))[0];
        assert.equal(delivery.phase, 'next_turn');
        assert.equal((await f.rows('RuntimeDeliveryWake', { delivery_id: delivery.id })).length, 0);
        return toolsAnswer(call('a-followup-b', 'followup_agent_task', { conversationRef: bRef, text: FOLLOWUP }));
      }
      if (aRound === 5) {
        await f.until(async () => (await f.app.runtime.collaboration.listMessages({ conversationId: a })).messages.some(message => message.sourceKind === 'completion'), 'B completion never returned to requesting sibling A.');
        return toolsAnswer(call('a-read-reply', 'read_agent_messages'));
      }
      if (aRound === 6) {
        const messages = detail(start, 'read_agent_messages').messages;
        const completion = messages.find(message => message.sourceKind === 'completion');
        assert.match(completion.messageRef, /^M\d+$/);
        return toolsAnswer(call('a-read-result', 'read_agent_messages', { messageRef: completion.messageRef }));
      }
      assert.equal(detail(start, 'read_agent_messages').text, FOLLOWUP_RESULT);
      assert.equal(followupObserved, true);
      siblingFinished = true;
      return answer('A received the explicit result from B.');
    }
    assert.equal(request.conversationId, b);
    bRound += 1;
    if (bRound === 1) {
      bInitialTurn = request.turnId;
      const runDefinition = start.tools.find(tool => tool.name === 'run_agent');
      assert.ok(runDefinition);
      assert.ok(!runDefinition.parameters.properties.operation.enum.includes('spawn'), 'depth 1 removes new child spawning but leaves collaboration tools');
      assert.ok(start.tools.some(tool => tool.name === 'send_agent_message'));
      await f.until(async () => (await f.rows('CollaborationMessageTargetLink', { conversation_id: b })).length > 0, 'A did not send to running B.');
      return toolsAnswer(call('b-safe-boundary', 'run_agent', { operation: 'list' }));
    }
    if (request.turnId === bInitialTurn) {
      assert.ok(JSON.stringify(wire).includes(ACTIVE_MESSAGE), 'running peer message must reach B at the next provider boundary');
      assert.match(text, /collaboration_message/);
      assert.match(text, /sourceKind.*tool/);
      assert.match(text, /not a new user instruction/);
      assert.match(text, /sourceConversationRef.*C\d+/);
      assert.match(text, /messageRef.*M\d+/);
      assertPeerWireRole(wire, ACTIVE_MESSAGE);
      activeObserved = true;
      if (bRound === 2) {
        const part = start.contents.flatMap(content => content.parts).find(part => typeof part.text === 'string' && part.text.startsWith('[Runtime delivery:') && part.text.includes(ACTIVE_MESSAGE));
        const envelope = JSON.parse(part.text.slice(part.text.indexOf('\n') + 1));
        return toolsAnswer(call('b-reply-fresh-handles', 'send_agent_message', { conversationRef: envelope.sourceConversationRef, replyToMessageRef: envelope.messageRef, text: PEER_ACK }));
      }
      assert.equal(detail(start, 'send_agent_message').accepted, true, 'the fresh C and M references from incoming runtime data resolve in the next actual tool call');
      return answer('B initial work complete.');
    }
    assert.ok(text.includes(FOLLOWUP));
    assertPeerWireRole(wire, FOLLOWUP);
    assert.ok(text.includes(IDLE_MESSAGE), 'the preceding queued message is absorbed by the explicitly authorized follow-up Turn');
    assert.equal((await f.rows('Turn', { conversation_id: b })).length, 2, 'followup creates exactly one child Turn');
    const links = await f.rows('ChildExecutionTurnLink', { turn_id: request.turnId });
    assert.equal(links.length, 1, 'followup must enter the real child scheduler, never an ordinary orphan Turn');
    followupObserved = true;
    return answer(FOLLOWUP_RESULT);
  }, async f => {
    const started = await f.input('root', 'spawn-team');
    const ended = await f.terminated(started.turnId);
    assert.equal(ended.terminal_status, 'completed');
    assert.equal(activeObserved, true);
    assert.equal(followupObserved, true);
    const childRows = await f.rows('ChildExecution');
    assert.equal(childRows.length, 2);
    assert.ok((await f.rows('ChildExecutionParentLink')).every(link => link.parent_child_execution_id === null));
    const completionSources = (await f.rows('CollaborationMessageSourceLink')).filter(source => source.source_kind === 'completion');
    assert.equal(completionSources.length, 1);
    assert.equal((await f.rows('CollaborationMessageTargetLink', { message_id: completionSources[0].message_id }))[0].conversation_id, a);
    assert.ok(f.wakes.some(wake => wake.conversationId === b && wake.action === 'resume_current_turn'));
    assert.ok(f.wakes.some(wake => wake.conversationId === b && wake.action === 'start_continuation' && wake.childExecutionId));
    assert.equal((await f.rows('CollaborationRequest'))[0].state, 'completed');
  }, providerType);
});

test('ordinary conversation follow-up enters the owning runner and revoked permission rejects a previously issued reference', { timeout: 60000 }, async () => {
  let phase = 'initialize', rootRound = 0, ordinaryTurns = 0, ordinaryRef, followedUp = false;
  const taskText = 'ORDINARY_FOLLOWUP_9217';
  const resultText = 'ORDINARY_RESULT_7436';
  await fixture(async (request, f, start, wire) => {
    if (request.conversationId === 'ordinary') {
      ordinaryTurns += 1;
      if (ordinaryTurns === 1) return answer('Initial ordinary conversation completed.');
      assert.equal(ordinaryTurns, 2, 'only the authorized follow-up starts an ordinary Turn');
      assert.ok(JSON.stringify(wire).includes(taskText));
      assertPeerWireRole(wire, taskText);
      assert.equal(f.app.database.conversationOwners.owns('ordinary'), true, 'only the conversation owner may execute the follow-up');
      assert.equal((await f.rows('ChildExecutionTurnLink', { turn_id: request.turnId })).length, 0, 'ordinary peers do not acquire child lineage');
      followedUp = true;
      return answer(resultText);
    }
    rootRound += 1;
    if (phase === 'authorized') {
      if (rootRound === 1) return toolsAnswer(call('ordinary-members', 'list_agents'));
      if (rootRound === 2) {
        const peer = detail(start, 'list_agents').members.find(member => member.relation === 'permitted');
        assert.equal(peer.relation, 'permitted');
        assert.equal(peer.allowWake, true);
        ordinaryRef = peer.conversationRef;
        return toolsAnswer(call('ordinary-followup', 'followup_agent_task', { conversationRef: ordinaryRef, text: taskText }));
      }
      await f.until(async () => (await f.app.runtime.collaboration.listMessages({ conversationId: 'root' })).messages.some(message => message.sourceKind === 'completion'), 'Ordinary peer result was not returned.');
      return answer('Authorized ordinary follow-up completed.');
    }
    assert.equal(phase, 'revoked');
    if (rootRound === 1) return toolsAnswer(call('ordinary-revoked', 'followup_agent_task', { conversationRef: ordinaryRef, text: 'THIS_MUST_NOT_BE_SENT_6408' }));
    const result = lastResult(start, 'followup_agent_task');
    assert.match(JSON.stringify(result), /not authorized/);
    return answer('Revocation rejected the stale address.');
  }, async f => {
    const initial = await f.input('ordinary', 'ordinary-initial');
    assert.equal((await f.terminated(initial.turnId)).terminal_status, 'completed');
    await f.app.runtime.collaboration.setPermission({ commandId: 'grant-ordinary', sourceConversationId: 'root', targetConversationId: 'ordinary', allowRead: true, allowSend: true, allowWake: true });
    phase = 'authorized';
    const allowed = await f.input('root', 'ordinary-authorized');
    assert.equal((await f.terminated(allowed.turnId)).terminal_status, 'completed');
    assert.equal(followedUp, true);
    assert.ok(f.wakes.some(wake => wake.conversationId === 'ordinary' && wake.action === 'start_continuation' && !wake.childExecutionId));
    const completion = (await f.app.runtime.collaboration.listMessages({ conversationId: 'root' })).messages.find(message => message.sourceKind === 'completion');
    assert.equal((await f.app.runtime.collaboration.readMessage({ conversationId: 'root', messageId: completion.messageId })).text, resultText);
    const before = (await f.rows('CollaborationMessage')).length;
    await f.app.runtime.collaboration.setPermission({ commandId: 'revoke-ordinary', sourceConversationId: 'root', targetConversationId: 'ordinary', allowRead: false, allowSend: false, allowWake: false });
    phase = 'revoked'; rootRound = 0;
    const rejected = await f.input('root', 'ordinary-revoked');
    assert.equal((await f.terminated(rejected.turnId)).terminal_status, 'completed');
    assert.equal((await f.rows('CollaborationMessage')).length, before, 'revocation fails before committing any peer message');
    assert.equal((await f.rows('Turn', { conversation_id: 'ordinary' })).length, 2);
  });
});
