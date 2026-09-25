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

test('a failed hand-off of a committed child answer neither fails the child Turn nor loses the answer', { timeout: 90000 }, async () => {
  const TASK = 'HANDOFF_TASK_9910', CHILD_ANSWER = 'HANDOFF_CHILD_ANSWER_9911';
  let rootRound = 0, rootSawAnswer = false, failures = 0;
  await fixture(async (request, f, start) => {
    if (request.conversationId === 'root') {
      if (++rootRound === 1) return toolsAnswer(spawn('spawn-handoff', TASK));
      if (text(start).includes(CHILD_ANSWER)) rootSawAnswer = true;
      return answer(`Root round ${rootRound}.`);
    }
    return answer(CHILD_ANSWER);
  }, async f => {
    const deliveries = f.app.runtime.deliveries;
    const createAutomatic = deliveries.createAutomatic;
    let repairable = false;
    deliveries.createAutomatic = async function(input) {
      const [inbox] = await f.rows('RuntimeInboxItem', { id: input.inboxItemId });
      if (inbox?.source_kind === 'answer_submission' && !repairable) {
        // Every hand-off tried while the child Turn is still its active generation loses the
        // delivery CAS (for example to the parent's final-output fence).
        failures += 1;
        throw Object.assign(new Error('fixture lost the delivery CAS'), { code: 'RUNTIME_TRANSACTION_ASSERTION_FAILED' });
      }
      return createAutomatic.call(this, input);
    };
    const started = await f.input('root', 'root-spawns-handoff');
    await f.terminated(started.turnId);
    const task = await f.until(() => f.child(TASK), 'child never started');
    const childTurn = await f.until(async () => (await f.rows('Turn', { conversation_id: task.conversationId }))[0], 'child Turn missing');
    assert.equal((await f.terminated(childTurn.id)).terminal_status, 'completed', 'a delivery-edge failure never fails the answered child Turn');
    await f.until(async () => (await f.rows('ChildExecutionActiveTurnLink', { child_execution_id: task.childExecutionId })).length === 0,
      'the completed child Turn never left the active pointer');
    await f.coordinator.waitForIdle();
    // Let every recovery pass that saw the child as an active generation finish (and fail) first.
    await f.coordinator.recoverStartup().catch(() => undefined);
    assert.ok(failures >= 1, 'the live hand-off failed');
    assert.equal(rootSawAnswer, false);
    // Only now can a hand-off succeed: the answer's Turn is no longer any active generation.
    repairable = true;
    await f.coordinator.recoverStartup();
    await f.until(async () => rootSawAnswer, 'the committed answer of a completed child Turn was never delivered after its hand-off failed');
    await f.settled();
    assert.equal((await f.rows('Turn', { conversation_id: task.conversationId })).length, 1);
    assert.equal((await f.rows('AnswerSubmission')).length, 1);
  });
});

test('a child Turn that completed without its answer submitted is answered by recovery, and a refused submission is no answer', { timeout: 90000 }, async () => {
  const TASK = 'RECOVER_TASK_1210', CHILD_ANSWER = 'RECOVER_CHILD_ANSWER_1211';
  let rootRound = 0, rootSawAnswer = false, refused = 0;
  await fixture(async (request, f, start) => {
    if (request.conversationId === 'root') {
      if (++rootRound === 1) return toolsAnswer(spawn('spawn-recover', TASK));
      if (text(start).includes(CHILD_ANSWER)) rootSawAnswer = true;
      return answer(`Root round ${rootRound}.`);
    }
    return answer(CHILD_ANSWER);
  }, async f => {
    const answers = f.app.runtime.answers;
    const submit = answers.submit;
    answers.submit = async function(input) {
      // The live submission is lost (an unexpected storage error); the Turn must still complete.
      if (++refused === 1) throw new Error('fixture storage error during submission');
      return submit.call(this, input);
    };
    const started = await f.input('root', 'root-spawns-recover');
    await f.terminated(started.turnId);
    await f.until(async () => rootSawAnswer, 'recovery never submitted the fenced final output of the completed child Turn');
    await f.settled();
    const task = await f.child(TASK);
    const [childTurn] = await f.rows('Turn', { conversation_id: task.conversationId });
    assert.equal((await f.rows('TurnTermination', { turn_id: childTurn.id }))[0].terminal_status, 'completed');
    const current = await f.app.runtime.answers.readCurrent(task.bridgeId);
    assert.equal(current.content, CHILD_ANSWER, 'recovery submits exactly the fenced final output');
    assert.equal((await f.rows('AnswerSubmission')).length, 1);
  });
});

test('a submission refused because the child was closed meanwhile completes the Turn with no answer', { timeout: 90000 }, async () => {
  const TASK = 'CLOSED_TASK_1310';
  let rootRound = 0;
  await fixture(async (request) => {
    if (request.conversationId === 'root') return ++rootRound === 1 ? toolsAnswer(spawn('spawn-closed', TASK)) : answer(`Root round ${rootRound}.`);
    return answer('CLOSED_CHILD_FINAL_1311');
  }, async f => {
    const answers = f.app.runtime.answers;
    const submit = answers.submit;
    answers.submit = async function(input) {
      const [bridge] = await f.rows('AnswerBridge', { id: input.answerBridgeId });
      // The child is closed between the final output and its submission.
      await f.app.database.transaction([repo('AnswerBridge').update(bridge.id, { status: 'closed', updated_at: new Date().toISOString() })]);
      return submit.call(this, input);
    };
    const started = await f.input('root', 'root-spawns-closed');
    await f.terminated(started.turnId);
    const task = await f.until(() => f.child(TASK), 'child never started');
    const childTurn = await f.until(async () => (await f.rows('Turn', { conversation_id: task.conversationId }))[0], 'child Turn missing');
    assert.equal((await f.terminated(childTurn.id)).terminal_status, 'completed', 'a refused submission never fails the Turn');
    await f.settled();
    assert.equal((await f.rows('AnswerSubmission')).length, 0);
    answers.submit = submit;
  });
});

test('closing the child scheduler while a child Turn completes still submits its answer', { timeout: 90000 }, async () => {
  const TASK = 'DISPOSE_TASK_1410', CHILD_ANSWER = 'DISPOSE_CHILD_ANSWER_1411';
  let rootRound = 0, rootSawAnswer = false, disposing;
  await fixture(async (request, f, start) => {
    if (request.conversationId === 'root') {
      if (++rootRound === 1) return toolsAnswer(spawn('spawn-dispose', TASK));
      if (text(start).includes(CHILD_ANSWER)) rootSawAnswer = true;
      return answer(`Root round ${rootRound}.`);
    }
    return answer(CHILD_ANSWER);
  }, async f => {
    const router = f.app.agentLoop.automaticDeliveries;
    const establish = router.establishFinalOutputFence;
    router.establishFinalOutputFence = async function(input) {
      const fenced = await establish.call(this, input);
      const [turn] = await f.rows('Turn', { id: input.turnId });
      // The Host starts closing right after the child fenced its final answer.
      if (fenced.established && turn.conversation_id !== 'root' && !disposing) disposing = f.coordinator.dispose();
      return fenced;
    };
    const started = await f.input('root', 'root-spawns-dispose');
    await f.terminated(started.turnId);
    await f.until(() => disposing !== undefined, 'the child never reached its final answer');
    await disposing;
    router.establishFinalOutputFence = establish;
    const task = await f.child(TASK);
    const [childTurn] = await f.rows('Turn', { conversation_id: task.conversationId });
    assert.equal((await f.rows('TurnTermination', { turn_id: childTurn.id }))[0]?.terminal_status, 'completed');
    assert.equal((await f.rows('AnswerSubmission')).length, 1, 'the draining child Turn submitted its answer before the scheduler closed');
    await f.replaceCoordinator();
    await f.coordinator.recoverStartup();
    await f.until(async () => rootSawAnswer, 'the parent never received the answer');
    await f.settled();
    assert.equal((await f.app.runtime.answers.readCurrent(task.bridgeId)).content, CHILD_ANSWER);
  });
});

test('a stop observed after the final answer is shown but before completion publishes no answer', { timeout: 90000 }, async () => {
  const TASK = 'LATE_STOP_TASK_1510';
  let rootRound = 0;
  await fixture(async (request) => {
    if (request.conversationId === 'root') return ++rootRound === 1 ? toolsAnswer(spawn('spawn-late-stop', TASK)) : answer(`Root round ${rootRound}.`);
    return answer('LATE_STOP_FINAL_1511');
  }, async f => {
    const output = f.app.agentLoop.turnOutput;
    const append = output.appendAssistantMessage;
    let stopped = false;
    output.appendAssistantMessage = async function(input) {
      const committed = await append.call(this, input);
      const [turn] = await f.rows('Turn', { id: input.turnId });
      if (turn.conversation_id !== 'root' && !stopped) {
        stopped = true;
        // The user stops the child exactly after its final answer became visible.
        await f.app.turns.interrupt({ source: { kind: 'command', key: 'late-stop' }, turnId: input.turnId, reason: 'user stop' });
      }
      return committed;
    };
    const started = await f.input('root', 'root-spawns-late-stop');
    await f.terminated(started.turnId);
    const task = await f.until(() => f.child(TASK), 'child never started');
    const childTurn = await f.until(async () => (await f.rows('Turn', { conversation_id: task.conversationId }))[0], 'child Turn missing');
    assert.equal((await f.terminated(childTurn.id)).terminal_status, 'interrupted');
    await f.settled();
    output.appendAssistantMessage = append;
    assert.equal((await f.rows('AnswerSubmission')).length, 0, 'a stopped Turn publishes no full answer');
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
test('a child Turn completed on the native final-output path answers its parent before it completes', { timeout: 60000 }, async () => {
  const NATIVE_FINAL = 'NATIVE_CHILD_FINAL_ANSWER_1610';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-native-child-answer-'));
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  let app, coordinator;
  const releaseB = deferred();
  const delivered = [];
  const rows = async (domain, where = {}) => (await app.database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;
  const waitFor = async (check, label) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail(`Timed out waiting for ${label}`);
  };
  const adapter = {
    providerId: 'native-provider',
    async materializeNativeToolOutput(outputs) { return outputs; },
    async sendFullRequest(request, controls) {
      let sequence = 0;
      let current = 'native-response-1';
      let responses = 1;
      const emit = (kind, content) => controls.onEvent({ kind, streamSeq: String(++sequence), content });
      controls.native.onController({
        get responseId() { return current; },
        endLogicalRequest() { assert.fail('a fully delivered batch never needs a carrier request'); },
        async steer() { assert.fail('no steering in this fixture'); },
        async submitToolResults(outputs) {
          const previous = current;
          current = `native-response-${++responses}`;
          const callIds = outputs.map(output => output.callId);
          // The server admits exactly these results into its next physical response.
          await emit('native_control', { type: 'response.created', responseId: current, previousResponseId: previous,
            admittedToolResultCallIds: callIds });
          delivered.push(...callIds);
          return { responseId: current, previousResponseId: previous };
        }
      });
      await emit('native_control', { type: 'response.created', responseId: current, capabilities: nativeCapabilities });
      const parts = [];
      for (const [index, callId] of ['native-call-a', 'native-call-b'].entries()) {
        const outputItem = { id: `item-${callId}`, ordinal: index, providerResponseId: current };
        parts.push({ id: callId, functionCall: { name: 'native_probe', args: { index } }, outputItem, async: true });
        await emit('output_item_done', { type: 'tool_calls', outputItem,
          calls: [{ id: callId, ordinal: index, name: 'native_probe', arguments: { index }, async: true }] });
      }
      await emit('native_control', { type: 'response.completed', responseId: current,
        usage: { input_tokens: 240, output_tokens: 12, input_tokens_details: { cached_tokens: 0 } } });
      await waitFor(() => delivered.includes('native-call-a'), 'the first settled result reached the server');
      releaseB.resolve();
      await waitFor(() => delivered.includes('native-call-b'), 'the second result reached the server');
      await waitFor(async () => (await rows('ToolCallEvent', { event_kind: 'native_delivery' })).length === 2, 'both delivery facts committed');
      await emit('native_control', { type: 'response.completed', responseId: current,
        usage: { input_tokens: 300, output_tokens: 8, input_tokens_details: { cached_tokens: 0 } } });
      await emit('completed', { role: 'model', parts: [...parts, { text: NATIVE_FINAL }] });
      controls.native.onController(undefined);
    }
  };
  const dependencies = {
    authorityCompiler: { async compile(request) { return {
      turnId: request.turnId, executorAgentId: request.executorAgentId,
      executionPreset: { content: JSON.stringify({ providerConfigId: 'native-provider', modelId: 'gpt-6-astra' }) },
      authoritySnapshot: { content: JSON.stringify({ kind: 'effective-turn-authority',
        turnId: request.turnId, conversationId: request.conversationId, executorAgentId: request.executorAgentId,
        model: { providerConfigId: 'native-provider', provider: 'openai-responses', modelId: 'gpt-6-astra',
          baseUrl: 'https://native-child.invalid/v1', openaiResponsesTransport: 'http',
          nativeResponses: { enabled: true, asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false },
          retryPolicy: { enabled: false, maxRetries: 0 } },
        modelProfile: { compressionThresholdTokens: 1000000, contextWindowTokens: 1200000,
          tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
        toolPolicy: { id: 'native-tools', allowedTools: ['native_probe', 'run_agent'], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
        planReviewPolicy: { mode: 'never' }, systemPrompt: { id: 'prompt', text: '' },
        runtimeContext: { id: null, name: '', template: '' },
        workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
      }) }
    }; } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('unexpected MCP call'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
    providers: { resolve() { return adapter; } },
    toolDispatcher: {
      definitions() { return [nativeProbe]; },
      async dispatch() { assert.fail('native calls must use the durable admitted-call dispatcher'); },
      async scheduleAdmittedCall(input) {
        if (input.providerCallId === 'native-call-b') await releaseB.promise;
        const settled = await app.runtime.effects.settleWithoutEffect({ source: { kind: 'internal', key: `native-child:${input.toolCallId}` },
          toolCallId: input.toolCallId, status: 'succeeded', detail: { ok: true, callId: input.providerCallId } });
        return settled.terminal;
      }
    }
  };
  try {
    app = await kernel.ReliableKernelApplication.open(root, dependencies);
    coordinator = new ReliableChildAgentCoordinator({ database: app.database, ...app.runtime,
      modelProvider: app.modelProvider, turns: app.turns, agentLoop: app.agentLoop,
      agents: { async resolve() { return { agentId: 'agent-child', agentType: 'worker' }; } },
      modelProfiles: { async initializeConversation() { return { created: true }; } } });
    const now = new Date().toISOString();
    await app.database.transaction([
      repo('Conversation').insert({ id: 'native-parent', title: 'native parent', status: 'active', created_at: now, updated_at: now }),
      repo('AgentConversationLink').insert({ id: 'native-parent-agent', conversation_id: 'native-parent', agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now })
    ]);
    const parent = await app.turns.input({ source: { kind: 'command', key: 'native-parent-turn' }, conversationId: 'native-parent',
      content: 'Delegate one native task.', leaseOwnerId: 'native-parent-owner', hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120000).toISOString() });
    await app.runtime.effects.createToolCall({ source: { kind: 'internal', key: 'native-spawn-call' }, toolCallId: 'native-spawn-call',
      turnId: parent.turnId, toolName: 'run_agent', arguments: { operation: 'spawn', taskName: 'native task', prompt: 'Probe twice.' } });
    const spawned = await app.runtime.children.spawn({ sourceToolCallId: 'native-spawn-call', childAgentId: 'agent-child',
      modelFallback: { providerConfigId: 'native-provider', model: 'gpt-6-astra' }, prompt: 'Probe twice.',
      completionPolicy: 'background', sourceSettlement: 'child_handle', leaseOwnerId: 'native-child-owner',
      leaseExpiresAt: new Date(Date.now() + 120000).toISOString() });
    assert.equal(await app.runtime.children.claimSpawnDispatch(spawned.effectIntentId), true);
    const receipt = await app.runtime.children.recordSpawnReceipt({ sourceKey: 'native-spawn-receipt', attemptId: spawned.attemptId, outcome: 'succeeded' });
    await app.runtime.children.reconcileSpawnReceipt(receipt.effectReceiptId);
    await app.database.conversationOwners.claim(spawned.childConversationId);
    const [lease] = await rows('ExecutionLease', { turn_id: spawned.childTurnId });
    const fence = { id: lease.id, conversationId: lease.conversation_id, turnId: lease.turn_id,
      ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation) };
    const turns = app.agentLoop.turns;
    const terminal = turns.terminal;
    let answeredWhenCompleted;
    turns.terminal = async function(command) {
      if (command.turnId === spawned.childTurnId && command.terminalStatus === 'completed') {
        answeredWhenCompleted = (await rows('AnswerSubmission')).some(row => row.turn_id === spawned.childTurnId);
      }
      return terminal.call(this, command);
    };
    const outcome = await kernel.runWithExecutionLeaseFence(fence, () => app.agentLoop.drive(spawned.childTurnId));
    turns.terminal = terminal;
    assert.equal(outcome.terminalStatus, 'completed', JSON.stringify(await rows('TurnTermination', { turn_id: spawned.childTurnId })));
    assert.equal(outcome.modelRequestIds.length, 1, 'one native logical request, no carrier request');
    const [termination] = await rows('TurnTermination', { turn_id: spawned.childTurnId });
    assert.equal(termination.reason, 'native_logical_request_completed', 'the Turn ended on the native final-output path');
    assert.equal(answeredWhenCompleted, true, 'the native final output became the answer before the Turn was recorded completed');
    const current = await app.runtime.answers.readCurrent(spawned.answerBridgeId);
    assert.equal(current.status, 'submitted');
    assert.equal(current.content, NATIVE_FINAL, 'the answer is the text after the last tool call');
    assert.equal((await rows('RuntimeDelivery', { target_conversation_id: 'native-parent' })).length, 1, 'the answer is handed on to the parent');
  } finally {
    if (coordinator) await coordinator.dispose();
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
