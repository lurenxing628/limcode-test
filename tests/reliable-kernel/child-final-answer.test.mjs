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
const { childConversationModelProfiles } = load('backend/reliableKernel/childThinkingInheritance.js');
const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { ReliableChildAgentCoordinator } = load('backend/reliableKernel/childAgentCoordinator.js');
const { ReliableConversationRunner } = load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { createRuntimeDeliveryWakeHandler } = load('backend/application/reliableKernel/runtimeDeliveryWakeHandler.js');
const { ReliableToolDispatcher } = load('backend/reliableKernel/toolDispatcher.js');
const { CollaborationToolDispatcher } = load('backend/reliableKernel/collaborationToolDispatcher.js');
const { runAgentTool } = load('backend/world/modules/tools/definitions/runAgent/index.js');
const { agentCollaborationToolModules } = load('backend/world/modules/tools/definitions/agentCollaboration/index.js');
const { LlmEventType } = load('backend/world/modules/llm/events.js');
const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
const definitions = [runAgentTool, ...agentCollaborationToolModules.map(module => module.create({}))];
const call = (id, name, args = {}) => ({ id, functionCall: { name, args } });
const answer = text => ({ role: 'model', parts: [{ text }] });
const toolsAnswer = (...parts) => ({ role: 'model', parts });
const detail = (start, name) => start.contents.flatMap(content => content.parts)
  .filter(part => part.functionResponse?.name === name).at(-1)?.functionResponse.response?.detail;
const spawn = (id, prompt) => call(id, 'run_agent', { operation: 'spawn', taskName: id, prompt, foregroundWaitMs: 0 });
const abortError = () => Object.assign(new Error('aborted by the fixture'), { name: 'AbortError' });

/**
 * The external model alone is synthetic; dispatch, the child scheduler, answers, runtime delivery,
 * wakes and the conversation runner are production code. `send` may block on the request signal,
 * so a stopped Turn really aborts its Provider request.
 */
async function fixture(send, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-child-final-answer-'));
  const configuration = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(path.join(root, 'settings'))));
  const save = async (section, settings) => configuration.saveGlobalSettings(section, settings, (await configuration.loadGlobalSettings(section)).revision);
  const provider = { ...createDefaultLlmProviderConfig({ name: 'synthetic final answer' }), id: 'synthetic-final-answer',
    provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'gpt-6-astra',
    models: [{ id: 'gpt-6-astra', name: 'synthetic' }], modelConfigs: [], generationConfig: {}, contextWindowTokens: 200000 };
  let app, coordinator, runner, collaborationTools, worker;
  const errors = [], requests = [], wakes = [];
  const f = {
    errors, requests, wakes,
    get app() { return app; }, get runner() { return runner; }, get coordinator() { return coordinator; },
    rows: async (domain, where = {}) => (await app.database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot,
    async until(check, message, timeoutMs = 20000, describe) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (errors.length) throw errors[0];
        const result = await check();
        if (result) return result;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail(describe ? `${message}: ${await describe()}` : message);
    },
    async input(conversationId, commandId, text = commandId) { return runner.input({ conversationId, commandId, text }); },
    async terminated(turnId) { return f.until(async () => (await f.rows('TurnTermination', { turn_id: turnId }))[0], `Turn did not terminate: ${turnId}`); },
    async settled() {
      const pending = async () => ({ turns: (await f.rows('Turn', { status: 'active' })).map(turn => turn.id),
        deliveries: (await f.rows('RuntimeDelivery', { state: 'pending' })).map(row => [row.id, row.phase, row.target_turn_id]),
        wakes: [...await f.rows('RuntimeDeliveryWake', { state: 'pending' }), ...await f.rows('RuntimeDeliveryWake', { state: 'claimed' })].map(row => [row.delivery_id, row.state]) });
      const describe = async () => JSON.stringify(await pending());
      // A plain message or team reply waits for its recipient's next Turn without any wake.
      const waitingDeliveries = async () => {
        const waiting = [];
        for (const delivery of await f.rows('RuntimeDelivery', { state: 'pending' })) {
          const [inbox] = await f.rows('RuntimeInboxItem', { id: delivery.inbox_item_id });
          if (inbox.source_kind !== 'collaboration_message' || delivery.phase !== 'next_turn') waiting.push(delivery);
        }
        return waiting;
      };
      await f.until(async () => (await f.rows('Turn', { status: 'active' })).length === 0
        && (await waitingDeliveries()).length === 0
        && (await f.rows('RuntimeDeliveryWake', { state: 'pending' })).length === 0
        && (await f.rows('RuntimeDeliveryWake', { state: 'claimed' })).length === 0, 'the runtime did not settle', 20000, describe);
      await runner.waitForIdle();
      await coordinator.waitForIdle();
    },
    async child(prompt) {
      for (const execution of await f.rows('ChildExecution')) {
        const [first] = (await f.rows('MessagePartOfConversation', { conversation_id: execution.child_conversation_id }))
          .sort((left, right) => Number(left.message_seq - right.message_seq));
        const [current] = first ? await f.rows('MessageCurrentRevisionLink', { message_id: first.message_id }) : [];
        const [revision] = current ? await f.rows('MessageRevision', { id: current.revision_id }) : [];
        const [content] = revision ? await f.rows('ContentObject', { id: revision.content_object_id }) : [];
        if (content && (await app.contentStore.read(content)).toString('utf8').includes(prompt)) {
          const [bridge] = await f.rows('AnswerBridge', { child_execution_id: execution.id });
          return { childExecutionId: execution.id, conversationId: execution.child_conversation_id, bridgeId: bridge.id };
        }
      }
      return undefined;
    },
    /** Records, for each Turn recorded completed, whether its answer was already submitted then. */
    async recordAnswersAtCompletion() {
      const recorded = new Map();
      const turns = app.agentLoop.turns;
      const terminal = turns.terminal;
      turns.terminal = async function(command) {
        if (command.terminalStatus === 'completed') {
          recorded.set(command.turnId, (await f.rows('AnswerSubmission')).some(row => row.turn_id === command.turnId));
        }
        return terminal.call(this, command);
      };
      return recorded;
    },
    /** A new coordinator on the same Runtime, as a reloaded Host builds one. */
    async replaceCoordinator() {
      await coordinator.dispose();
      coordinator = createCoordinator();
      return coordinator;
    }
  };
  const createCoordinator = () => new ReliableChildAgentCoordinator({ database: app.database, ...app.runtime,
    modelProvider: app.modelProvider, turns: app.turns, agentLoop: app.agentLoop,
    agents: { async resolve() { return { agentId: worker.id, agentType: 'worker' }; } },
    modelProfiles: childConversationModelProfiles(configuration.mutations),
    deliveryWakeups: app.processDeliveries, ownedProcessCleanup: app.childOwnedProcessCleanup
  });
  try {
    await save('llmProviderConfigs', { configs: [provider] });
    await save('llm', { activeProviderConfigId: provider.id });
    const parent = await configuration.mutations.createAgent({ name: 'Synthetic root', kind: 'custom' });
    worker = await configuration.mutations.createAgent({ name: 'Synthetic worker', kind: 'custom' });
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
        const observed = { ...request, turnId: requestRow.turn_id };
        requests.push(observed);
        let start;
        const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
          start(input, emit) { start = input; emit({ type: LlmEventType.Done, payload: { requestId: input.id } }); }, abort() {}, dispose() {}
        });
        await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, terminal: true, checkpointed: true }; } });
        let content;
        try {
          content = await send(observed, f, start, controls.signal);
        } catch (error) {
          if (controls.signal?.aborted) throw error;
          errors.push(error);
          content = answer('Synthetic provider assertion failed.');
        }
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content });
      } }; } },
      createToolDispatcher: dependencies => new ReliableToolDispatcher({ ...dependencies, effects: dependencies.runtime.effects,
        host: {
          definitions: () => definitions,
          async dispatchSpecial(_definition, input, authority, signal, admission) {
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
    coordinator = createCoordinator();
    runner = new ReliableConversationRunner(app, 'synthetic-final-answer-owner');
    const wake = createRuntimeDeliveryWakeHandler({ application: () => app, conversations: () => runner, children: () => coordinator });
    app.processDeliveries.setWakeHandler(async request => { wakes.push(structuredClone(request)); return wake(request); });
    const now = new Date().toISOString();
    await app.database.transaction([
      repo('Conversation').insert({ id: 'root', title: 'root', status: 'active', created_at: now, updated_at: now }),
      repo('AgentConversationLink').insert({ id: 'root-agent', conversation_id: 'root', agent_id: parent.id, role: 'default', created_at: now, updated_at: now })
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

const text = start => JSON.stringify(start.contents);
/** Resolves once `signal` aborts; the request then fails as a real aborted transport would. */
const untilAborted = signal => new Promise((_, reject) => {
  if (signal.aborted) reject(abortError());
  signal.addEventListener('abort', () => reject(abortError()), { once: true });
});

test('a peer followup taken in by a child task Turn is answered to the peer and the Turn still answers its parent', { timeout: 90000 }, async () => {
  const TASK = 'WORKER_TASK_5510', PEER = 'PEER_TASK_5511', PEER_FOLLOWUP = 'PEER_FOLLOWUP_FOR_WORKER_5512';
  const WORKER_ANSWER = 'WORKER_ANSWER_WITH_PEER_INPUT_5513';
  let worker, peer, rootRound = 0, workerRound = 0, peerRound = 0, rootSawAnswer = false;
  await fixture(async (request, f, start) => {
    if (request.conversationId === 'root') {
      if (++rootRound === 1) return toolsAnswer(spawn('spawn-worker', TASK), spawn('spawn-peer', PEER));
      if (text(start).includes(WORKER_ANSWER)) rootSawAnswer = true;
      return answer(`Root round ${rootRound}.`);
    }
    if (text(start).includes(TASK)) worker ??= request.conversationId;
    if (text(start).includes(PEER)) peer ??= request.conversationId;
    if (request.conversationId === worker) {
      if (++workerRound === 1) {
        // The parent-assigned Turn is still running when the peer's task arrives.
        await f.until(async () => (await f.rows('CollaborationRequest')).length > 0, 'the peer never sent its followup');
        return toolsAnswer(call('worker-boundary', 'run_agent', { operation: 'list' }));
      }
      assert.ok(text(start).includes(PEER_FOLLOWUP), 'the running task Turn takes the peer task in at its next boundary');
      return answer(WORKER_ANSWER);
    }
    assert.equal(request.conversationId, peer);
    peerRound += 1;
    if (peerRound === 1) { await f.until(() => worker, 'worker never started'); return toolsAnswer(call('peer-members', 'list_agents')); }
    if (peerRound === 2) {
      const member = detail(start, 'list_agents').members.find(entry => entry.title === 'spawn-worker');
      assert.ok(member);
      return toolsAnswer(call('peer-followup', 'followup_agent_task', { conversationRef: member.conversationRef, text: PEER_FOLLOWUP }));
    }
    return answer('Peer done.');
  }, async f => {
    const answeredWhenCompleted = await f.recordAnswersAtCompletion();
    const started = await f.input('root', 'root-delegates');
    assert.equal((await f.terminated(started.turnId)).terminal_status, 'completed');
    await f.until(async () => rootSawAnswer, 'the parent never received the task answer of the Turn that also took in the peer task');
    await f.settled();
    const task = await f.child(TASK);
    const current = await f.app.runtime.answers.readCurrent(task.bridgeId);
    assert.equal(current.status, 'submitted');
    assert.equal(current.content, WORKER_ANSWER, 'the parent-assigned Turn answers its parent');
    assert.equal(answeredWhenCompleted.get(current.sourceTurnId), true,
      'the Turn itself answered its parent before completing, not a later repair');
    const [request] = await f.rows('CollaborationRequest');
    assert.equal(request.state, 'completed', 'the peer still receives its own completion reply');
    const reply = (await f.app.runtime.collaboration.listMessages({ conversationId: peer })).messages.find(message => message.sourceKind === 'completion');
    assert.equal((await f.app.runtime.collaboration.readMessage({ conversationId: peer, messageId: reply.messageId })).text, WORKER_ANSWER);
  });
});

test('a Turn the user starts in a child conversation publishes nothing and keeps the task answer', { timeout: 90000 }, async () => {
  const TASK = 'USER_TURN_TASK_6610', TASK_ANSWER = 'TASK_ANSWER_6611', USER_TEXT = 'USER_ASKS_CHILD_6612', USER_REPLY = 'CHILD_REPLIES_TO_USER_6613';
  let rootRound = 0, rootAnswers = 0;
  await fixture(async (request, f, start) => {
    if (request.conversationId === 'root') {
      if (++rootRound === 1) return toolsAnswer(spawn('spawn-task', TASK));
      if (text(start).includes(TASK_ANSWER)) rootAnswers += 1;
      if (text(start).includes(USER_REPLY)) assert.fail('a reply the child gave its user reached the parent');
      return answer(`Root round ${rootRound}.`);
    }
    return answer(text(start).includes(USER_TEXT) ? USER_REPLY : TASK_ANSWER);
  }, async f => {
    const started = await f.input('root', 'root-spawns-task');
    await f.terminated(started.turnId);
    await f.until(async () => rootAnswers === 1, 'the parent never received the task answer');
    await f.settled();
    const task = await f.child(TASK);
    const before = { submissions: (await f.rows('AnswerSubmission')).length, deliveries: (await f.rows('RuntimeDelivery', { target_conversation_id: 'root' })).length,
      rootTurns: (await f.rows('Turn', { conversation_id: 'root' })).length };
    assert.deepEqual(before, { submissions: 1, deliveries: 1, rootTurns: 2 });
    // The product facade holds the child Conversation's ownership while it forwards the user's input.
    const typed = await f.app.database.conversationOwners.run(task.conversationId, () => f.coordinator.inputFromConversation({
      commandId: 'user-types-in-child', childExecutionId: task.childExecutionId, conversationId: task.conversationId, content: USER_TEXT }));
    assert.equal((await f.terminated(typed.turnId)).terminal_status, 'completed');
    await f.settled();
    assert.equal((await f.rows('AnswerSubmission')).length, 1, 'the user Turn submits no answer');
    assert.equal((await f.rows('RuntimeDelivery', { target_conversation_id: 'root' })).length, 1, 'nothing is delivered to the parent');
    assert.equal((await f.rows('Turn', { conversation_id: 'root' })).length, 2, 'no parent continuation Turn starts');
    const current = await f.app.runtime.answers.readCurrent(task.bridgeId);
    assert.equal(current.status, 'submitted');
    assert.equal(current.content, TASK_ANSWER, 'the task answer is not overwritten or cleared by the user Turn');
    assert.equal(rootAnswers, 1);
  });
});

test('a Turn the user types after stopping the task Turn is not the task answer either', { timeout: 90000 }, async () => {
  const TASK = 'STOPPED_TASK_6710', USER_TEXT = 'USER_CONTINUES_6711', USER_REPLY = 'USER_REPLY_6712';
  let rootRound = 0, taskStarted = false;
  await fixture(async (request, f, start, signal) => {
    if (request.conversationId === 'root') {
      if (text(start).includes(USER_REPLY)) assert.fail('a reply the child gave its user reached the parent');
      return ++rootRound === 1 ? toolsAnswer(spawn('spawn-stopped', TASK)) : answer(`Root round ${rootRound}.`);
    }
    if (text(start).includes(USER_TEXT)) return answer(USER_REPLY);
    taskStarted = true;
    return untilAborted(signal);
  }, async f => {
    const started = await f.input('root', 'root-spawns-stopped');
    await f.terminated(started.turnId);
    const task = await f.until(() => f.child(TASK), 'child never started');
    await f.until(() => taskStarted, 'the task Turn never reached its Provider');
    const [taskTurn] = await f.rows('Turn', { conversation_id: task.conversationId });
    await f.app.database.conversationOwners.run(task.conversationId, () => f.coordinator.interruptFromConversation({
      commandId: 'user-stops-task', childExecutionId: task.childExecutionId, conversationId: task.conversationId,
      turnId: taskTurn.id, reason: 'user stop' }));
    assert.equal((await f.terminated(taskTurn.id)).terminal_status, 'interrupted');
    await f.settled();
    const typed = await f.app.database.conversationOwners.run(task.conversationId, () => f.coordinator.inputFromConversation({
      commandId: 'user-continues-child', childExecutionId: task.childExecutionId, conversationId: task.conversationId, content: USER_TEXT }));
    assert.equal((await f.terminated(typed.turnId)).terminal_status, 'completed');
    await f.settled();
    assert.equal((await f.rows('AnswerSubmission')).length, 0, 'the user Turn never becomes the missing task answer');
    assert.equal((await f.rows('RuntimeDelivery', { target_conversation_id: 'root' })).length, 0);
    assert.equal((await f.rows('Turn', { conversation_id: 'root' })).length, 1, 'no parent continuation Turn starts');
    assert.notEqual((await f.app.runtime.answers.readCurrent(task.bridgeId)).status, 'submitted');
  });
});

test('a child answer routed into a Turn that is streaming its final answer keeps that answer and still starts a continuation', { timeout: 90000 }, async () => {
  const TASK = 'ROUTED_FINAL_TASK_7710', CHILD_ANSWER = 'ROUTED_FINAL_CHILD_ANSWER_7711';
  let rootRound = 0, secondTurn, secondRequests = 0, continuationTurn;
  await fixture(async (request, f, start) => {
    if (request.conversationId === 'root') {
      rootRound += 1;
      if (rootRound === 1) return toolsAnswer(spawn('spawn-routed', TASK));
      if (request.turnId === secondTurn) {
        secondRequests += 1;
        // The child answers while this final answer is being produced.
        await f.until(async () => (await f.rows('RuntimeDelivery', { target_turn_id: secondTurn, phase: 'current_turn' })).length > 0,
          'the child answer was never routed into the running Turn');
        return answer('SECOND_TURN_FINAL_ANSWER');
      }
      if (text(start).includes(CHILD_ANSWER)) continuationTurn ??= request.turnId;
      return answer(`Root round ${rootRound}.`);
    }
    await f.until(() => secondRequests > 0, 'the second Turn never started its final answer');
    return answer(CHILD_ANSWER);
  }, async f => {
    const first = await f.input('root', 'root-spawns-routed');
    await f.terminated(first.turnId);
    await f.until(async () => (await f.rows('Turn', { status: 'active' })).every(turn => turn.conversation_id !== 'root'), 'root still running');
    const second = await f.input('root', 'user-asks-again');
    secondTurn = second.turnId;
    assert.equal((await f.terminated(second.turnId)).terminal_status, 'completed');
    await f.until(() => continuationTurn, 'no Turn ever handled the routed child answer');
    await f.settled();
    assert.equal(secondRequests, 1, 'the streamed final answer is kept, never regenerated');
    assert.equal((await f.rows('ModelRequest', { turn_id: second.turnId })).length, 1);
    const finals = (await f.rows('MessageTurnLink', { turn_id: second.turnId })).filter(link => link.role === 'model');
    assert.equal(finals.length, 1, 'one final answer, never a second one appended');
    assert.notEqual(continuationTurn, second.turnId);
    const [delivery] = (await f.rows('RuntimeDelivery', { target_conversation_id: 'root' }));
    assert.equal(delivery.state, 'consumed');
    assert.equal(delivery.target_turn_id, continuationTurn, 'the continuation Turn took the child answer in');
  });
});

test('stopping a Turn that a child answer was routed into still starts a continuation for that answer', { timeout: 90000 }, async () => {
  const TASK = 'ROUTED_STOP_TASK_8810', CHILD_ANSWER = 'ROUTED_STOP_CHILD_ANSWER_8811';
  let rootRound = 0, secondTurn, secondStarted = false, continuationTurn;
  await fixture(async (request, f, start, signal) => {
    if (request.conversationId === 'root') {
      rootRound += 1;
      if (rootRound === 1) return toolsAnswer(spawn('spawn-stop', TASK));
      if (request.turnId === secondTurn) { secondStarted = true; return untilAborted(signal); }
      if (text(start).includes(CHILD_ANSWER)) continuationTurn ??= request.turnId;
      return answer(`Root round ${rootRound}.`);
    }
    await f.until(() => secondStarted, 'the second Turn never reached its Provider');
    return answer(CHILD_ANSWER);
  }, async f => {
    const first = await f.input('root', 'root-spawns-stop');
    await f.terminated(first.turnId);
    await f.until(async () => (await f.rows('Turn', { status: 'active' })).every(turn => turn.conversation_id !== 'root'), 'root still running');
    const second = await f.input('root', 'user-starts-and-stops');
    secondTurn = second.turnId;
    await f.until(async () => (await f.rows('RuntimeDelivery', { target_turn_id: second.turnId, phase: 'current_turn' })).length > 0,
      'the child answer was never routed into the running Turn');
    await f.runner.interrupt({ commandId: 'user-stops-second', conversationId: 'root', turnId: second.turnId, reason: 'user stop' });
    assert.equal((await f.terminated(second.turnId)).terminal_status, 'interrupted');
    await f.until(() => continuationTurn, 'the routed child answer was swallowed by the stopped Turn');
    await f.settled();
    const [delivery] = await f.rows('RuntimeDelivery', { target_conversation_id: 'root' });
    assert.equal(delivery.target_turn_id, continuationTurn);
    assert.notEqual(continuationTurn, second.turnId);
  });
});

const nativeCapabilities = { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false, explicitCaching: true };
const nativeProbe = { name: 'native_probe', description: 'one durable native tool', parameters: { type: 'object' }, metadata: { nativeAsync: true } };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

/**
 * A child spawned through the real ChildExecution plane whose Turn runs one native logical request:
 * both async tool results are delivered to the server inside that request and the aggregate ends
 * with its final text, so the Turn completes on the native final-output path.
 */
