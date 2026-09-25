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
 * The external model alone is synthetic; dispatch, the child scheduler, answers, collaboration,
 * runtime delivery, wakes and the conversation runner are production code.
 */
async function fixture(send, run, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-collaboration-wake-'));
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
    await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: definitions.map(tool => tool.declaration.name),
      ...(options.maxAutomaticFollowups === undefined ? {} : { toolConfigs: { run_agent: { config: { maxAutomaticFollowups: options.maxAutomaticFollowups } } } }) });
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

const TASK_READY = 'TASK_READY_2210';
/** The one collaboration message a Conversation took in with this text, and the Turn that took it. */
async function deliveredTo(f, conversationId, textMarker) {
  for (const delivery of await f.rows('RuntimeDelivery', { target_conversation_id: conversationId })) {
    const [inbox] = await f.rows('RuntimeInboxItem', { id: delivery.inbox_item_id });
    if (inbox.source_kind !== 'collaboration_message') continue;
    const [payload] = await f.rows('RuntimeInboxPayloadLink', { inbox_item_id: inbox.id });
    const [content] = await f.rows('ContentObject', { id: payload.content_object_id });
    if ((await f.app.contentStore.read(content)).toString('utf8').includes(textMarker)) return delivery;
  }
  return undefined;
}
async function turnsOf(f, conversationId) {
  return (await f.rows('Turn', { conversation_id: conversationId })).map(turn => turn.id);
}
const idle = async (f, conversationId) => (await f.rows('Turn', { conversation_id: conversationId })).every(turn => turn.status === 'terminated');

test('a message from the root wakes its idle child, and the child reply wakes the idle root, with no user input', { timeout: 90000 }, async () => {
  const TASK = 'ROUND_TRIP_TASK_3310', QUESTION = 'ROOT_QUESTION_3311', REPLY = 'CHILD_REPLY_3312';
  let child, rootAskTurn, childWokenTurn, rootReadTurn, sendResult;
  await fixture(async (request, f, start) => {
    if (request.conversationId === 'root') {
      if (text(start).includes(REPLY)) { rootReadTurn = request.turnId; return answer('Root read the child reply.'); }
      if (request.turnId === rootAskTurn) {
        if (!detail(start, 'send_agent_message')) {
          const member = detail(start, 'list_agents')?.members.find(entry => entry.title === 'spawn-round-trip');
          if (!member) return toolsAnswer(call('root-members', 'list_agents'));
          return toolsAnswer(call('root-asks', 'send_agent_message', { conversationRef: member.conversationRef, text: QUESTION }));
        }
        sendResult = detail(start, 'send_agent_message');
        return answer('Asked the idle child.');
      }
      if (text(start).includes(TASK_READY) || detail(start, 'run_agent')) return answer('Root noted the child task.');
      return toolsAnswer(spawn('spawn-round-trip', TASK));
    }
    child ??= request.conversationId;
    if (!text(start).includes(QUESTION)) return answer(TASK_READY);
    childWokenTurn = request.turnId;
    if (detail(start, 'send_agent_message')) return answer('Replied to the root.');
    // Reply only once the root is idle, so the reply must wake it.
    await f.until(() => idle(f, 'root'), 'the root never became idle');
    const [root] = (detail(start, 'list_agents')?.members ?? []).filter(entry => entry.parentConversationRef === null);
    if (!root) return toolsAnswer(call('child-members', 'list_agents'));
    return toolsAnswer(call('child-replies', 'send_agent_message', { conversationRef: root.conversationRef, text: REPLY }));
  }, async f => {
    const spawned = await f.input('root', 'root-spawns');
    await f.terminated(spawned.turnId);
    await f.settled();
    const before = { root: (await turnsOf(f, 'root')).length, child: (await turnsOf(f, child)).length };
    const ask = await f.input('root', 'root-asks-child');
    rootAskTurn = ask.turnId;
    await f.until(() => rootReadTurn, 'the child reply never woke the root');
    await f.settled();
    assert.equal(sendResult.targetDelivery, 'wakes_target', 'the root is told its idle child is started');
    assert.equal((await turnsOf(f, child)).length, before.child + 1, 'the question opens exactly one child Turn');
    assert.equal((await deliveredTo(f, child, QUESTION)).target_turn_id, childWokenTurn);
    assert.equal((await turnsOf(f, 'root')).length, before.root + 2, 'the user asked once; the reply opened the root Turn itself');
    assert.equal((await deliveredTo(f, 'root', REPLY)).target_turn_id, rootReadTurn);
    const task = await f.child(TASK);
    assert.equal((await f.app.runtime.answers.readCurrent(task.bridgeId)).content, TASK_READY, 'a message-woken Turn is not a task Turn and never replaces the task answer');
  });
});

test('a running child task wakes an idle sibling for its message', { timeout: 90000 }, async () => {
  const TASK_A = 'SIBLING_A_4410', TASK_B = 'SIBLING_B_4411', NOTE = 'SIBLING_NOTE_4412';
  let a, b, bWoken, noteSent = false;
  await fixture(async (request, f, start) => {
    if (request.conversationId === 'root') {
      if (!detail(start, 'run_agent')) return toolsAnswer(spawn('sibling-a', TASK_A), spawn('sibling-b', TASK_B));
      return answer('Root waits for its tasks.');
    }
    if (text(start).includes(TASK_B)) b ??= request.conversationId;
    if (text(start).includes(TASK_A)) a ??= request.conversationId;
    if (request.conversationId === b) {
      if (!text(start).includes(NOTE)) return answer('B finished its task.');
      bWoken = request.turnId;
      return answer('B read the note.');
    }
    if (!detail(start, 'list_agents')) {
      await f.until(async () => b && await idle(f, b), 'B never became idle');
      return toolsAnswer(call('a-members', 'list_agents'));
    }
    if (!noteSent) {
      noteSent = true;
      const member = detail(start, 'list_agents').members.find(entry => entry.title === 'sibling-b');
      return toolsAnswer(call('a-notes-b', 'send_agent_message', { conversationRef: member.conversationRef, text: NOTE }));
    }
    assert.equal(detail(start, 'send_agent_message').targetDelivery, 'wakes_target');
    await f.until(() => bWoken, 'the note never woke B');
    return answer('A is done.');
  }, async f => {
    const started = await f.input('root', 'root-spawns-siblings');
    await f.terminated(started.turnId);
    await f.until(() => bWoken, 'the note never woke the idle sibling');
    await f.settled();
    assert.equal((await turnsOf(f, b)).length, 2, 'B ran its task and exactly one Turn for the note');
    assert.equal((await deliveredTo(f, b, NOTE)).target_turn_id, bWoken);
  });
});

test('five messages to one idle target open exactly one Turn that takes them all in', { timeout: 90000 }, async () => {
  const TASK_A = 'FIVE_A_5510', TASK_B = 'FIVE_B_5511', NOTE = 'FIVE_NOTE_5512';
  let a, b, sent = false;
  const woken = new Set();
  await fixture(async (request, f, start) => {
    if (request.conversationId === 'root') {
      if (!detail(start, 'run_agent')) return toolsAnswer(spawn('five-a', TASK_A), spawn('five-b', TASK_B));
      return answer('Root waits for its tasks.');
    }
    if (text(start).includes(TASK_B)) b ??= request.conversationId;
    if (text(start).includes(TASK_A)) a ??= request.conversationId;
    if (request.conversationId === b) {
      if (!text(start).includes(NOTE)) return answer('B finished its task.');
      woken.add(request.turnId);
      // Answer only once every note is committed: all of them reach this one Turn.
      await f.until(async () => (await f.rows('CollaborationMessage')).length >= 5, 'the notes were never sent');
      return answer('B read the notes.');
    }
    if (!detail(start, 'list_agents')) {
      await f.until(async () => b && await idle(f, b), 'B never became idle');
      return toolsAnswer(call('a-members', 'list_agents'));
    }
    if (!sent) {
      sent = true;
      const member = detail(start, 'list_agents').members.find(entry => entry.title === 'five-b');
      return toolsAnswer(...[1, 2, 3, 4, 5].map(index => call(`a-note-${index}`, 'send_agent_message', { conversationRef: member.conversationRef, text: `${NOTE} #${index}` })));
    }
    return answer('A sent five notes.');
  }, async f => {
    const started = await f.input('root', 'root-spawns-five');
    await f.terminated(started.turnId);
    await f.until(async () => woken.size > 0 && (await f.rows('RuntimeDelivery', { target_conversation_id: b })).filter(row => row.state === 'consumed').length >= 5, 'the notes never reached B');
    await f.settled();
    assert.equal(woken.size, 1, 'one idle period opens one Turn');
    assert.equal((await turnsOf(f, b)).length, 2);
    const turns = new Set();
    for (let index = 1; index <= 5; index += 1) turns.add((await deliveredTo(f, b, `${NOTE} #${index}`)).target_turn_id);
    assert.deepEqual([...turns], [...woken], 'that one Turn takes in all five notes');
    assert.deepEqual((await f.rows('TurnIntent', { conversation_id: b })).filter(intent => intent.state === 'queued'), []);
  });
});

test('a progress message from a running child task waits for its answer instead of waking the parent', { timeout: 90000 }, async () => {
  const TASK = 'PROGRESS_TASK_6610', PROGRESS = 'PROGRESS_NOTE_6611', FINAL = 'PROGRESS_FINAL_6612';
  let rootAnswerTurn, progressResult;
  await fixture(async (request, f, start) => {
    if (request.conversationId === 'root') {
      if (text(start).includes(FINAL)) { rootAnswerTurn = request.turnId; return answer('Root read the task result.'); }
      if (!detail(start, 'run_agent')) return toolsAnswer(spawn('progress-task', TASK));
      return answer('Root waits for the task.');
    }
    if (!detail(start, 'list_agents')) {
      await f.until(() => idle(f, 'root'), 'the root never became idle');
      return toolsAnswer(call('task-members', 'list_agents'));
    }
    if (!detail(start, 'send_agent_message')) {
      const root = detail(start, 'list_agents').members.find(entry => entry.parentConversationRef === null);
      return toolsAnswer(call('task-progress', 'send_agent_message', { conversationRef: root.conversationRef, text: PROGRESS }));
    }
    progressResult = detail(start, 'send_agent_message');
    // The parent stays idle while the task keeps working.
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await f.rows('Turn', { conversation_id: 'root' })).length, 1, 'the progress message never wakes the parent');
    return answer(FINAL);
  }, async f => {
    const started = await f.input('root', 'root-spawns-progress');
    await f.terminated(started.turnId);
    await f.until(() => rootAnswerTurn, 'the task answer never woke the parent');
    await f.settled();
    assert.equal(progressResult.targetDelivery, 'waits_for_your_answer');
    assert.equal((await turnsOf(f, 'root')).length, 2, 'only the task answer opens a parent Turn');
    assert.equal((await deliveredTo(f, 'root', PROGRESS)).target_turn_id, rootAnswerTurn, 'the Turn the answer opened reads the progress message too');
    assert.deepEqual(await f.rows('RuntimeDeliveryIntentLink', { delivery_id: (await deliveredTo(f, 'root', PROGRESS)).id }), [], 'it never opened a Turn of its own');
  });
});

test('with the automatic budget spent a message opens no Turn and waits for the target next Turn', { timeout: 90000 }, async () => {
  const TASK = 'BUDGET_TASK_7710', NOTE = 'BUDGET_NOTE_7711';
  let child, askTurn, sendResult;
  await fixture(async (request, f, start) => {
    if (request.conversationId === 'root') {
      if (request.turnId === askTurn) {
        if (sendResult) return answer('Noted.');
        const member = detail(start, 'list_agents')?.members.find(entry => entry.title === 'budget-task');
        if (!member) return toolsAnswer(call('root-members', 'list_agents'));
        if (!detail(start, 'send_agent_message')) return toolsAnswer(call('root-notes', 'send_agent_message', { conversationRef: member.conversationRef, text: NOTE }));
        sendResult = detail(start, 'send_agent_message');
        return answer('Sent.');
      }
      if (text(start).includes(TASK_READY) || detail(start, 'run_agent')) return answer('Root noted the child task.');
      return toolsAnswer(spawn('budget-task', TASK));
    }
    child ??= request.conversationId;
    if (text(start).includes(NOTE)) assert.fail('a spent budget never starts the target');
    return answer(TASK_READY);
  }, async f => {
    const spawned = await f.input('root', 'root-spawns-budget');
    await f.terminated(spawned.turnId);
    await f.settled();
    const ask = await f.input('root', 'root-notes-child');
    askTurn = ask.turnId;
    await f.terminated(ask.turnId);
    await f.settled();
    assert.equal(sendResult.targetDelivery, 'waits_budget_exhausted');
    assert.equal((await turnsOf(f, child)).length, 1, 'no Turn opens');
    const note = await deliveredTo(f, child, NOTE);
    assert.deepEqual([note.state, note.phase, note.target_turn_id], ['pending', 'next_turn', null], 'the message waits for the next Turn');
    assert.deepEqual(await f.rows('RuntimeDeliveryWake', { delivery_id: note.id }), []);
  }, { maxAutomaticFollowups: 0 });
});

test('a team followup reply wakes its idle requester', { timeout: 90000 }, async () => {
  const TASK = 'FOLLOWUP_TASK_8810', WORK = 'FOLLOWUP_WORK_8811', RESULT = 'FOLLOWUP_RESULT_8812';
  let child, askTurn, readTurn;
  await fixture(async (request, f, start) => {
    if (request.conversationId === 'root') {
      if (text(start).includes(RESULT)) { readTurn = request.turnId; return answer('Root read the followup result.'); }
      if (request.turnId === askTurn) {
        const member = detail(start, 'list_agents')?.members.find(entry => entry.title === 'followup-task');
        if (!member) return toolsAnswer(call('root-members', 'list_agents'));
        if (!detail(start, 'followup_agent_task')) return toolsAnswer(call('root-assigns', 'followup_agent_task', { conversationRef: member.conversationRef, text: WORK }));
        return answer('Assigned.');
      }
      if (text(start).includes(TASK_READY) || detail(start, 'run_agent')) return answer('Root noted the child task.');
      return toolsAnswer(spawn('followup-task', TASK));
    }
    child ??= request.conversationId;
    if (!text(start).includes(WORK)) return answer(TASK_READY);
    await f.until(() => idle(f, 'root'), 'the root never became idle');
    return answer(RESULT);
  }, async f => {
    const spawned = await f.input('root', 'root-spawns-followup');
    await f.terminated(spawned.turnId);
    await f.settled();
    const before = (await turnsOf(f, 'root')).length;
    const ask = await f.input('root', 'root-assigns-work');
    askTurn = ask.turnId;
    await f.until(() => readTurn, 'the team reply never woke its idle requester');
    await f.settled();
    assert.equal((await turnsOf(f, 'root')).length, before + 2, 'the reply opened exactly one requester Turn');
    assert.equal((await deliveredTo(f, 'root', RESULT)).target_turn_id, readTurn);
    assert.equal((await f.rows('CollaborationRequest'))[0].state, 'completed');
  });
});
