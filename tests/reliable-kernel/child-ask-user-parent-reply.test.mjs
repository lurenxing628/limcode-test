import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));

const kernel = load('backend/reliableKernel/index.js');
const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
const { emptyConversationContextHandleStateStep } = load('backend/reliableKernel/conversationContextHandleState.js');
const { ReliableChildAgentCoordinator } = load('backend/reliableKernel/childAgentCoordinator.js');
const { ReliableToolDispatcher } = load('backend/reliableKernel/toolDispatcher.js');
const { ReliableConversationRunner } = load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { createRuntimeDeliveryWakeHandler } = load('backend/application/reliableKernel/runtimeDeliveryWakeHandler.js');
const { readPendingInteractionAttention } = load('backend/application/reliableKernel/interactionAttention.js');
const { askUserTool } = load('backend/world/modules/tools/definitions/askUser/index.js');
const { runAgentTool } = load('backend/world/modules/tools/definitions/runAgent/index.js');
const { resolveModelToolArguments } = load('backend/reliableKernel/modelHandleCatalog.js');
const {
  readConversationChildTaskProjection,
  readConversationChildTaskRuntimeStatus,
  renderConversationChildTaskCard,
  sameConversationChildTaskState
} = load('backend/reliableKernel/conversationChildTaskProjection.js');
const { LlmEventType } = load('backend/world/modules/llm/events.js');

const gate = () => {
  const value = { settled: false };
  let done;
  value.promise = new Promise(resolve => { done = resolve; });
  value.resolve = result => {
    if (value.settled) return;
    value.settled = true;
    value.value = result;
    done(result);
  };
  return value;
};

const textAnswer = text => ({ role: 'model', parts: [{ text }] });
const toolCallAnswer = (name, args, id) => ({
  role: 'model',
  parts: [{ functionCall: { ...(id ? { id } : {}), name, args } }]
});

async function openAskUserFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-child-ask-parent-'));
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  let serial = 0;
  const now = () => new Date().toISOString();
  const configs = new Map();
  const observed = [];
  let app;
  let coordinator;
  let runner;

  const f = {
    directory,
    root,
    now,
    configs,
    observed,
    errors: [],
    get app() { return app; },
    get coordinator() { return coordinator; },
    get runner() { return runner; },
    model: async request => textAnswer(`completed ${request.conversationId}`)
  };

  const authority = request => ({
    kind: 'effective-turn-authority',
    turnId: request.turnId,
    conversationId: request.conversationId,
    executorAgentId: request.executorAgentId,
    model: {
      providerConfigId: 'provider',
      provider: 'openai-compatible',
      modelId: 'model',
      retryPolicy: { enabled: false, maxRetries: 0 }
    },
    modelProfile: {
      contextWindowTokens: 128000,
      compressionThresholdTokens: 100000,
      tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
    },
    toolPolicy: {
      id: 'child-ask-tools',
      allowedTools: ['run_agent', 'ask_user'],
      preset: 'custom',
      sourceConfigs: {},
      toolConfigs: {
        run_agent: { config: { maxChildAgentDepth: 3, maxConcurrentAgents: 8, maxAutomaticFollowups: 32 } },
        ask_user: { config: { autoApprove: false } }
      },
      ...(configs.get(request.conversationId) ?? {})
    },
    planReviewPolicy: { mode: 'never' },
    systemPrompt: { id: 'prompt', text: '' },
    runtimeContext: { id: null, name: '', template: '' },
    workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
  });

  app = await kernel.ReliableKernelApplication.open(root, {
    holdRuntimeConvergence: true,
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: 'provider', modelId: 'model' }) },
          authoritySnapshot: { content: JSON.stringify(authority(request)) }
        };
      }
    },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: {
      async toolAnnotations() { return {}; },
      async callTool() { assert.fail('unexpected MCP'); }
    },
    mcpPolicyGate: {
      async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; }
    },
    attachmentSettings: {
      async loadGlobalSettings() {
        return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' };
      }
    },
    providers: {
      resolve(providerId) {
        return {
          providerId,
          async sendFullRequest(request, controls) {
            const [record] = await f.rows('ModelRequest', { id: request.modelRequestId });
            const seen = { ...request, turnId: record.turn_id };
            let start;
            const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
              start(input, emit) {
                start = input;
                emit({ type: LlmEventType.Done, payload: { requestId: input.id } });
              },
              abort() {},
              dispose() {}
            });
            await adapter.sendFullRequest(request, {
              async onEvent() { return { accepted: true, terminal: true, checkpointed: true }; }
            });
            observed.push({ ...seen, start });
            await controls.onEvent({
              kind: 'completed',
              streamSeq: '1',
              content: await f.model(seen, start, controls.signal)
            });
          }
        };
      }
    },
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) =>
      new ReliableToolDispatcher({
        database,
        contentStore,
        effects: runtime.effects,
        files,
        fileMutations,
        processes,
        mcp,
        interactions,
        host: {
          definitions: () => [runAgentTool, askUserTool],
          dispatchSpecial: async (_definition, input, frozenAuthority, signal, admission) =>
            coordinator?.dispatch(input, signal, frozenAuthority, admission)
        }
      })
  });

  f.rows = async (domain, where = {}) =>
    (await app.database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;
  f.get = async (domain, id) => (await app.database.snapshot([repo(domain).get(id)])).snapshot[0];
  f.id = label => `${label}-${++serial}`;

  f.addConversation = async label => {
    const id = f.id(label);
    const at = now();
    await app.database.transaction([
      repo('Conversation').insert({ id, title: label, status: 'active', created_at: at, updated_at: at }),
      emptyConversationContextHandleStateStep(id, at),
      repo('AgentConversationLink').insert({
        id: `${id}-agent`,
        conversation_id: id,
        agent_id: 'agent-main',
        role: 'default',
        created_at: at,
        updated_at: at
      })
    ]);
    return id;
  };

  f.parentTurn = async (label, toolPolicyOverrides) => {
    const conversationId = await f.addConversation(label);
    if (toolPolicyOverrides) configs.set(conversationId, toolPolicyOverrides);
    const result = await app.turns.input({
      source: { kind: 'command', key: f.id('input') },
      conversationId,
      content: label,
      leaseOwnerId: 'fixture-owner',
      hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 600000).toISOString()
    });
    return { conversationId, turnId: result.turnId };
  };

  f.toolCall = async (turnId, toolName, args) => {
    const toolCallId = f.id('tool');
    await app.runtime.effects.createToolCall({
      source: { kind: 'internal', key: toolCallId },
      toolCallId,
      turnId,
      toolName,
      arguments: args
    });
    return toolCallId;
  };

  f.endTurn = async (turnId, terminalStatus = 'completed') => {
    const turn = await f.get('Turn', turnId);
    if (turn.status === 'terminated') return;
    await app.database.transaction([
      repo('Turn').update(turnId, { status: 'terminated', terminal_at: now(), updated_at: now() }),
      repo('TurnTermination').insert({
        id: f.id('termination'),
        turn_id: turnId,
        terminal_status: terminalStatus,
        reason: 'fixture completed',
        created_at: now()
      }),
      repo('ExecutionLease').deleteByUnique({ conversation_id: turn.conversation_id, turn_id: turnId })
    ]);
  };

  f.spawn = async (parent, title = 'worker-child') => {
    const sourceToolCallId = await f.toolCall(parent.turnId, 'run_agent', {
      operation: 'spawn',
      taskName: title,
      prompt: 'Execute subtask'
    });
    const child = await app.runtime.children.spawn({
      sourceToolCallId,
      childAgentId: 'agent-child',
      modelFallback: { providerConfigId: 'provider', model: 'model' },
      prompt: 'Execute subtask',
      title,
      completionPolicy: 'background',
      sourceSettlement: 'child_handle',
      leaseOwnerId: `child-driver:${app.database.hostBootId}`,
      leaseExpiresAt: new Date(Date.now() + 600000).toISOString(),
      leaseDurationMs: 600000
    });
    await app.runtime.children.claimSpawnDispatch(child.effectIntentId);
    const receipt = await app.runtime.children.recordSpawnReceipt({
      sourceKey: `fixture-spawn:${child.attemptId}`,
      attemptId: child.attemptId,
      outcome: 'succeeded',
      detail: { adapter: 'reliable-local-agent-loop' }
    });
    await app.runtime.children.reconcileSpawnReceipt(receipt.effectReceiptId);
    return child;
  };

  f.readToolDetail = async toolCallId => {
    const [artifact] = await f.rows('ToolResultArtifact', { tool_call_id: toolCallId, role: 'no_effect_result' });
    assert.ok(artifact, `Expected ToolResultArtifact for ${toolCallId}`);
    const meta = await f.get('ContentObject', artifact.content_object_id);
    const parsed = JSON.parse((await app.contentStore.read(meta)).toString('utf8'));
    return parsed.detail;
  };

  f.dispatchRunAgent = async (turnId, args) => {
    const toolCallId = await f.toolCall(turnId, 'run_agent', args);
    const result = await coordinator.dispatch({
      turnId,
      modelRequestId: f.id('req'),
      toolCallId,
      toolName: 'run_agent',
      arguments: args
    });
    const detail = await f.readToolDetail(toolCallId);
    return { toolCallId, result, detail };
  };

  coordinator = new ReliableChildAgentCoordinator({
    database: app.database,
    effects: app.runtime.effects,
    children: app.runtime.children,
    answers: app.runtime.answers,
    deliveries: app.runtime.deliveries,
    collaboration: app.runtime.collaboration,
    interactions: app.interactions,
    turns: app.turns,
    modelProvider: app.modelProvider,
    agentLoop: app.agentLoop,
    agents: { async resolve() { return { agentId: 'agent-child', agentType: 'worker' }; } },
    modelProfiles: { async initializeConversation() { return { created: true }; } },
    deliveryWakeups: app.processDeliveries
  });

  f.activateRunner = () => {
    runner ??= new ReliableConversationRunner(app, 'child-ask-suite-owner', error => { f.errors.push(error); });
    const wake = createRuntimeDeliveryWakeHandler({
      application: () => app,
      conversations: () => runner,
      children: () => coordinator
    });
    app.processDeliveries.setWakeHandler(wake);
    return runner;
  };

  f.until = async (probe, label, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (f.errors.length) throw f.errors[0];
      const value = await probe();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.fail(label);
  };

  f.close = async () => {
    runner?.dispose();
    await runner?.waitForIdle();
    await coordinator.dispose();
    await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  };

  return f;
}

test('modelHandleCatalog resolves childRef for run_agent answer_question and ignores childRefs', () => {
  const args = resolveModelToolArguments(
    'run_agent',
    {
      operation: 'answer_question',
      childRef: 'A1',
      childRefs: ['A99'],
      questionId: 'q-1',
      selectedOptionIndexes: [0]
    },
    { entries: [{ kind: 'child', ref: 'A1', target: 'bridge-1' }] }
  );
  assert.equal(args.answerBridgeId, 'bridge-1');
  assert.equal(args.questionId, 'q-1');
  assert.deepEqual(args.selectedOptionIndexes, [0]);
  assert.equal('answerBridgeIds' in args, false);
});

test('child ask_user is exposed in list/read/wait/card/runtimeStatus and wakes run_agent(wait) immediately', { timeout: 10000 }, async () => {
  const f = await openAskUserFixture();
  try {
  const parent = await f.parentTurn('inspect-pending-question');
  const child = await f.spawn(parent, 'db-migration-worker');

  const beforeProj = await readConversationChildTaskProjection(f.app.database, f.app.contentStore, parent.conversationId);
  assert.equal(beforeProj.tasks.length, 1);
  assert.equal(beforeProj.tasks[0].pendingQuestion, undefined);

  // Start wait BEFORE the child calls ask_user to verify immediate wakeup on state change.
  const waitToolCallId = await f.toolCall(parent.turnId, 'run_agent', {
    operation: 'wait',
    answerBridgeId: child.answerBridgeId,
    timeoutMs: 15000
  });
  const waitPromise = f.coordinator.dispatch({
    turnId: parent.turnId,
    modelRequestId: f.id('wait-req'),
    toolCallId: waitToolCallId,
    toolName: 'run_agent',
    arguments: { operation: 'wait', answerBridgeId: child.answerBridgeId, timeoutMs: 15000 }
  });

  // Child pauses on ask_user.
  const askCallId = await f.toolCall(child.childTurnId, 'ask_user', {
    question: 'Which database driver should I use?',
    options: [
      { label: 'PostgreSQL', description: 'Production relational store' },
      { label: 'SQLite', description: 'Embedded local store' }
    ],
    multiple: false
  });
  const paused = await f.app.interactions.pauseForAskUser({
    source: { kind: 'internal', key: `pause:${askCallId}` },
    toolCallId: askCallId,
    prompt: {
      question: 'Which database driver should I use?',
      options: [
        { label: 'PostgreSQL', description: 'Production relational store' },
        { label: 'SQLite', description: 'Embedded local store' }
      ],
      multiple: false
    }
  });

  // 1. wait wakes immediately with changed=true and pendingQuestion populated.
  await waitPromise;
  const waitDetail = await f.readToolDetail(waitToolCallId);
  assert.equal(waitDetail.operation, 'wait');
  assert.equal(waitDetail.changed, true);
  assert.equal(waitDetail.timedOut, false);
  assert.equal(waitDetail.tasks.length, 1);
  assert.deepEqual(waitDetail.tasks[0].pendingQuestion, {
    questionId: paused.requestId,
    toolCallId: askCallId,
    question: 'Which database driver should I use?',
    options: [
      { index: 0, label: 'PostgreSQL', description: 'Production relational store' },
      { index: 1, label: 'SQLite', description: 'Embedded local store' }
    ],
    multiple: false,
    createdAt: waitDetail.tasks[0].pendingQuestion.createdAt
  });

  // 2. wait called AFTER child already has pendingQuestion settles immediately without timing out.
  const secondWait = await f.dispatchRunAgent(parent.turnId, {
    operation: 'wait',
    answerBridgeId: child.answerBridgeId,
    timeoutMs: 15000
  });
  assert.equal(secondWait.detail.timedOut, false);
  assert.equal(secondWait.detail.tasks[0].pendingQuestion.questionId, paused.requestId);

  // 3. sameConversationChildTaskState detects pendingQuestion transition.
  const afterProj = await readConversationChildTaskProjection(f.app.database, f.app.contentStore, parent.conversationId);
  assert.equal(sameConversationChildTaskState(beforeProj.tasks[0], afterProj.tasks[0]), false);
  assert.equal(sameConversationChildTaskState(afterProj.tasks[0], afterProj.tasks[0]), true);

  // 4. list, read, runtimeStatus, and rendered card all expose pendingQuestion.
  const listed = await f.dispatchRunAgent(parent.turnId, { operation: 'list' });
  assert.equal(listed.detail.tasks[0].pendingQuestion.questionId, paused.requestId);
  assert.equal(listed.detail.tasks[0].pendingQuestion.question, 'Which database driver should I use?');

  const read = await f.dispatchRunAgent(parent.turnId, {
    operation: 'read',
    answerBridgeId: child.answerBridgeId
  });
  assert.equal(read.detail.task.pendingQuestion.questionId, paused.requestId);

  const runtimeStatus = await readConversationChildTaskRuntimeStatus(
    f.app.database,
    f.app.contentStore,
    parent.conversationId,
    10
  );
  assert.equal(runtimeStatus.children[0].pendingQuestion.questionId, paused.requestId);

  const cardText = renderConversationChildTaskCard(afterProj.tasks[0], { childRef: 'A1' });
  assert.match(cardText, /pending_question:/);
  assert.match(cardText, /run_agent operation=answer_question/);
  assert.match(cardText, /childRef=A1/);
  assert.match(cardText, new RegExp(paused.requestId));
  } finally {
    await f.close();
  }
});

test('idle parent is proactively woken with child_question (even with budget=0), answers via run_agent(answer_question), and child resumes and finishes', { timeout: 15000 }, async () => {
  const local = await openAskUserFixture();
  try {
    // Even with maxAutomaticFollowups=0, child ask_user must still wake its direct parent!
    const parent = await local.parentTurn('idle-parent-wake', {
      toolConfigs: {
        run_agent: { config: { maxChildAgentDepth: 3, maxConcurrentAgents: 8, maxAutomaticFollowups: 0 } },
        ask_user: { config: { autoApprove: false } }
      }
    });
    const child = await local.spawn(parent, 'auth-worker');
    // Parent ends its Turn before child asks the question.
    await local.endTurn(parent.turnId);

    const parentSawQuestion = gate();
    const childReceivedParentAnswer = gate();
    let childModelRound = 0;
    let parentModelRound = 0;
    let capturedParentWire = '';
    let capturedChildAnswerWire = '';

    local.model = async (request, start) => {
      const wire = JSON.stringify(start.contents);
      if (request.conversationId === child.childConversationId) {
        childModelRound += 1;
        if (childModelRound === 1) {
          return toolCallAnswer('ask_user', {
            question: 'Should auth tokens use JWT or opaque sessions?',
            options: [
              { label: 'JWT', description: 'Stateless signed tokens' },
              { label: 'Opaque sessions', description: 'Server-side revocable sessions' }
            ],
            multiple: false
          }, 'child-ask-1');
        }
        capturedChildAnswerWire = wire;
        childReceivedParentAnswer.resolve(wire);
        return textAnswer('Implemented opaque sessions as instructed by parent.');
      }

      if (request.conversationId === parent.conversationId) {
        parentModelRound += 1;
        if (parentModelRound === 1) {
          capturedParentWire = wire;
          parentSawQuestion.resolve(wire);
          // Parse childRef and questionId out of the delivered prompt just like a real LLM!
          const childRefMatch = wire.match(/childRef=(A\d+)/);
          const questionIdMatch = wire.match(/questionId:\s*([^\s\\"]+)/);
          assert.ok(childRefMatch, `Expected childRef in parent wire: ${wire}`);
          assert.ok(questionIdMatch, `Expected questionId in parent wire: ${wire}`);
          return toolCallAnswer('run_agent', {
            operation: 'answer_question',
            childRef: childRefMatch[1],
            questionId: questionIdMatch[1],
            selectedOptionIndexes: [1]
          }, 'parent-answer-1');
        }
        return textAnswer('Answered the child question and let it continue.');
      }

      return textAnswer('ok');
    };

    local.activateRunner();
    await local.app.processDeliveries.start();

    // Launch child -> child calls ask_user -> pauses -> notifies parent -> wakes idle parent!
    assert.equal(local.coordinator.launch(child.childExecutionId, child.childTurnId), true);

    await local.until(() => parentSawQuestion.settled, 'idle parent was not woken by child ask_user');
    assert.match(capturedParentWire, /Collaboration child question/);
    assert.match(capturedParentWire, /Should auth tokens use JWT or opaque sessions\?/);
    assert.match(capturedParentWire, /Opaque sessions/);
    assert.match(capturedParentWire, /operation=\\"answer_question\\"/);

    // Wait for child to receive parent's answer and finish its Turn!
    await local.until(() => childReceivedParentAnswer.settled, 'child did not resume after parent answered');
    assert.match(capturedChildAnswerWire, /Opaque sessions/);

    await local.coordinator.waitForIdle();
    await local.runner.waitForIdle();

    // Verify idempotency: re-calling notifyChildQuestion produces zero duplicate messages/deliveries.
    const childQuestions = await local.rows('CollaborationMessageSourceLink', { source_kind: 'child_question' });
    assert.equal(childQuestions.length, 1);

    // Verify NO CollaborationRequest (no spurious completion reply back to child!).
    assert.equal((await local.rows('CollaborationRequest')).length, 0);
    assert.equal((await local.rows('CollaborationMessageSourceLink', { source_kind: 'completion' })).length, 0);

    // Verify child actually completed and submitted its final answer.
    const answer = await local.app.runtime.answers.readCurrent(child.answerBridgeId);
    assert.equal(answer.status, 'submitted');
    assert.match(answer.content, /Implemented opaque sessions/);
  } finally {
    await local.close();
  }
});

test('active parent receives child_question into its running turn, and repeated re-drive notifications are strictly idempotent', { timeout: 12000 }, async () => {
  const local = await openAskUserFixture();
  try {
    const parent = await local.parentTurn('active-parent-delivery');
    const child = await local.spawn(parent, 'active-child');

    // Child calls ask_user in its Turn and pauses.
    local.model = async request => {
      if (request.conversationId === child.childConversationId) {
        return toolCallAnswer('ask_user', {
          question: 'Pick cache strategy',
          options: [{ label: 'LRU' }, { label: 'LFU' }],
          multiple: false
        }, 'active-ask-1');
      }
      return textAnswer('done');
    };

    assert.equal(local.coordinator.launch(child.childExecutionId, child.childTurnId), true);
    await local.coordinator.activeTurns.get(child.childTurnId);

    // Parent Turn is active -> delivery must target parent's active Turn with phase='current_turn'.
    const sources = await local.rows('CollaborationMessageSourceLink', { source_kind: 'child_question' });
    assert.equal(sources.length, 1);
    const deliveries = await local.rows('RuntimeDelivery', { target_conversation_id: parent.conversationId });
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].phase, 'current_turn');
    assert.equal(deliveries[0].target_turn_id, parent.turnId);

    // Simulate re-drive / restart calling notifyChildQuestion again for the same InteractionRequest.
    const [req] = await local.rows('InteractionRequest', { request_kind: 'ask_user', status: 'pending' });
    assert.ok(req);
    const replay = await local.app.runtime.collaboration.notifyChildQuestion({
      childTurnId: child.childTurnId,
      childExecutionId: child.childExecutionId,
      answerBridgeId: child.answerBridgeId,
      requestId: req.id,
      parentConversationId: parent.conversationId
    });
    assert.equal(replay.status, 'delivered');
    assert.equal(replay.deduplicated, true);

    // Still strictly 1 message, 1 delivery, 1 wake!
    assert.equal((await local.rows('CollaborationMessageSourceLink', { source_kind: 'child_question' })).length, 1);
    assert.equal((await local.rows('RuntimeDelivery', { target_conversation_id: parent.conversationId })).length, 1);
    assert.equal((await local.rows('RuntimeDeliveryWake', { delivery_id: deliveries[0].id })).length, 1);
  } finally {
    await local.close();
  }
});

test('lineage security: foreign parent and grandparent cannot answer a child ask_user question', { timeout: 10000 }, async () => {
  const f = await openAskUserFixture();
  try {
  const grandparent = await f.parentTurn('grandparent-lineage');
  const middle = await f.spawn(grandparent, 'middle-child');
  const grandchild = await f.spawn(
    { conversationId: middle.childConversationId, turnId: middle.childTurnId },
    'grandchild'
  );
  const outsider = await f.parentTurn('foreign-outsider');

  let grandchildRound = 0;
  f.model = async request => {
    if (request.conversationId === grandchild.childConversationId) {
      grandchildRound += 1;
      if (grandchildRound === 1) {
        return toolCallAnswer('ask_user', {
          question: 'Need approval from direct parent only',
          options: [{ label: 'Yes' }, { label: 'No' }],
          multiple: false
        }, 'grandchild-ask-1');
      }
      return textAnswer('Grandchild finished with direct parent guidance.');
    }
    return textAnswer('done');
  };
  assert.equal(f.coordinator.launch(grandchild.childExecutionId, grandchild.childTurnId), true);
  await f.coordinator.activeTurns.get(grandchild.childTurnId);
  const [pausedReq] = await f.rows('InteractionRequest', { request_kind: 'ask_user', status: 'pending' });
  assert.ok(pausedReq);
  const paused = { requestId: pausedReq.id };

  // 1. Foreign outsider rejected by run_agent(answer_question).
  await assert.rejects(
    f.dispatchRunAgent(outsider.turnId, {
      operation: 'answer_question',
      answerBridgeId: grandchild.answerBridgeId,
      questionId: paused.requestId,
      selectedOptionIndexes: [0]
    }),
    /outside the caller's direct parent lineage/
  );

  // 2. Grandparent rejected by run_agent(answer_question) (must be direct parent!).
  await assert.rejects(
    f.dispatchRunAgent(grandparent.turnId, {
      operation: 'answer_question',
      answerBridgeId: grandchild.answerBridgeId,
      questionId: paused.requestId,
      selectedOptionIndexes: [0]
    }),
    /outside the caller's direct parent lineage/
  );

  // 3. Grandparent ALSO rejected directly at ToolInteractionControlPlane.resolveAskUser!
  const forgedToolCallId = await f.toolCall(grandparent.turnId, 'run_agent', {
    operation: 'answer_question',
    answerBridgeId: grandchild.answerBridgeId
  });
  await assert.rejects(
    f.app.interactions.resolveAskUser({
      source: { kind: 'internal', key: `forged:${forgedToolCallId}` },
      requestId: paused.requestId,
      response: { answer: { selectedOptionIndexes: [0] } },
      parentAgent: {
        parentConversationId: grandparent.conversationId,
        parentTurnId: grandparent.turnId,
        parentToolCallId: forgedToolCallId,
        childExecutionId: grandchild.childExecutionId
      }
    }),
    /只有直接父 Agent 对话才能回答该子 Agent 的提问/
  );

  // 4. Direct parent (middle) succeeds, even omitting questionId and using custom answer text!
  const answered = await f.dispatchRunAgent(middle.childTurnId, {
    operation: 'answer_question',
    answerBridgeId: grandchild.answerBridgeId,
    answer: 'Use custom direct-parent guidance'
  });
  assert.equal(answered.detail.ok, true);
  assert.equal(answered.detail.operation, 'answer_question');
  assert.equal(answered.detail.status, 'answered');
  assert.equal(answered.detail.questionId, paused.requestId);
  assert.equal(answered.detail.answer, 'Use custom direct-parent guidance');

  // Verify validation rejects empty answer_question calls.
  await assert.rejects(
    f.dispatchRunAgent(middle.childTurnId, {
      operation: 'answer_question',
      answerBridgeId: grandchild.answerBridgeId
    }),
    /requires at least one of selectedOptionIndexes or answer/
  );
  await f.coordinator.waitForIdle();
  const grandchildAnswer = await f.app.runtime.answers.readCurrent(grandchild.answerBridgeId);
  assert.equal(grandchildAnswer.status, 'submitted');
  assert.match(grandchildAnswer.content, /Grandchild finished/);
  } finally {
    await f.close();
  }
});

test('first-response-wins: user answering first causes parent answer_question to return already_answered cleanly', { timeout: 10000 }, async () => {
  const f = await openAskUserFixture();
  try {
  const parent = await f.parentTurn('first-response-wins-parent');
  const child = await f.spawn(parent, 'race-child');

  let childRound = 0;
  f.model = async request => {
    if (request.conversationId === child.childConversationId) {
      childRound += 1;
      if (childRound === 1) {
        return toolCallAnswer('ask_user', {
          question: 'Choose deployment target',
          options: [{ label: 'Staging' }, { label: 'Production' }],
          multiple: false
        }, 'race-ask-1');
      }
      return textAnswer('Deployed to Staging.');
    }
    return textAnswer('done');
  };
  assert.equal(f.coordinator.launch(child.childExecutionId, child.childTurnId), true);
  await f.coordinator.activeTurns.get(child.childTurnId);
  const [pausedReq] = await f.rows('InteractionRequest', { request_kind: 'ask_user', status: 'pending' });
  const [toolLink] = await f.rows('InteractionToolCallLink', { request_id: pausedReq.id });
  assert.ok(pausedReq && toolLink);
  const paused = { requestId: pausedReq.id };
  const askCallId = toolLink.tool_call_id;

  // Human user answers first via command source.
  const userResolution = await f.app.interactions.resolveAskUser({
    source: { kind: 'command', key: f.id('user-first') },
    requestId: paused.requestId,
    response: { answer: { selectedOptionIndexes: [0] } }
  });
  assert.equal(userResolution.won, true);

  // Parent tries to answer with explicit questionId -> cleanly returns already_answered.
  const explicitReplay = await f.dispatchRunAgent(parent.turnId, {
    operation: 'answer_question',
    answerBridgeId: child.answerBridgeId,
    questionId: paused.requestId,
    selectedOptionIndexes: [1]
  });
  assert.equal(explicitReplay.detail.ok, true);
  assert.equal(explicitReplay.detail.operation, 'answer_question');
  assert.equal(explicitReplay.detail.status, 'already_answered');
  assert.equal(explicitReplay.detail.questionId, paused.requestId);

  // Parent tries to answer omitting questionId -> also cleanly returns already_answered.
  const omittedReplay = await f.dispatchRunAgent(parent.turnId, {
    operation: 'answer_question',
    answerBridgeId: child.answerBridgeId,
    selectedOptionIndexes: [1]
  });
  assert.equal(omittedReplay.detail.ok, true);
  assert.equal(omittedReplay.detail.operation, 'answer_question');
  assert.equal(omittedReplay.detail.status, 'already_answered');

  // Verify the winning user answer ('Staging') was preserved untouched.
  const askDetail = await f.readToolDetail(askCallId);
  assert.equal(askDetail.selectedOptions[0].label, 'Staging');
  await f.coordinator.waitForIdle();
  } finally {
    await f.close();
  }
});

test('interactionAttention suppresses child ask_user popups while preserving top-level ask_user popups', { timeout: 10000 }, async () => {
  const local = await openAskUserFixture();
  try {
    const parent = await local.parentTurn('attention-top-level');
    const child = await local.spawn(parent, 'attention-child');

    const childAskCallId = await local.toolCall(child.childTurnId, 'ask_user', {
      question: 'Child question should not toast user',
      options: [{ label: 'A' }],
      multiple: false
    });
    const childPaused = await local.app.interactions.pauseForAskUser({
      source: { kind: 'internal', key: `pause:${childAskCallId}` },
      toolCallId: childAskCallId,
      prompt: {
        question: 'Child question should not toast user',
        options: [{ label: 'A' }],
        multiple: false
      }
    });

    const parentAskCallId = await local.toolCall(parent.turnId, 'ask_user', {
      question: 'Top-level question must still toast user',
      options: [{ label: 'B' }],
      multiple: false
    });
    const parentPaused = await local.app.interactions.pauseForAskUser({
      source: { kind: 'internal', key: `pause:${parentAskCallId}` },
      toolCallId: parentAskCallId,
      prompt: {
        question: 'Top-level question must still toast user',
        options: [{ label: 'B' }],
        multiple: false
      }
    });

    const pending = await readPendingInteractionAttention(local.app.database, local.app.database.hostBootId, local.app.contentStore);
    const ids = pending.map(item => item.requestId);
    assert.equal(ids.includes(childPaused.requestId), false, 'child task ask_user must NOT trigger VS Code attention toast');
    assert.equal(ids.includes(parentPaused.requestId), true, 'top-level ask_user MUST still trigger VS Code attention toast');
  } finally {
    await local.close();
  }
});

test('foreground wait (spawn & send with foregroundWaitMs=30s) settles immediately when child calls ask_user without deadlock', { timeout: 15000 }, async () => {
  const local = await openAskUserFixture();
  try {
    const parent = await local.parentTurn('foreground-wait-no-deadlock');
    let childConversationId;
    let childModelRound = 0;

    local.model = async (request, start) => {
      const wire = JSON.stringify(start.contents);
      if (request.conversationId !== parent.conversationId) {
        childConversationId = request.conversationId;
        childModelRound += 1;
        if (childModelRound === 1) {
          return toolCallAnswer('ask_user', {
            question: 'Spawn phase: pick serialization format',
            options: [{ label: 'JSON' }, { label: 'CBOR' }],
            multiple: false
          }, 'fg-spawn-ask-1');
        }
        if (childModelRound === 2) {
          assert.match(wire, /CBOR/);
          return textAnswer('Spawn completed with CBOR.');
        }
        if (childModelRound === 3) {
          return toolCallAnswer('ask_user', {
            question: 'Send phase: enable compression?',
            options: [{ label: 'Yes' }, { label: 'No' }],
            multiple: false
          }, 'fg-send-ask-1');
        }
        assert.match(wire, /Yes/);
        return textAnswer('Continuation completed with compression enabled.');
      }
      return textAnswer('parent ok');
    };

    const [parentAuthoritySnap] = await local.rows('AuthoritySnapshot', { turn_id: parent.turnId });
    const parentAuthorityMeta = await local.get('ContentObject', parentAuthoritySnap.content_object_id);
    const parentAuthorityDoc = JSON.parse((await local.app.contentStore.read(parentAuthorityMeta)).toString('utf8'));

    // 1. Spawn with foregroundWaitMs=30_000 -> child calls ask_user -> settles well under 5s!
    const spawnToolCallId = await local.toolCall(parent.turnId, 'run_agent', {
      operation: 'spawn',
      taskName: 'fg-worker',
      prompt: 'Choose format and implement',
      foregroundWaitMs: 30_000
    });
    const spawnStartedAt = Date.now();
    await local.coordinator.dispatch(
      {
        turnId: parent.turnId,
        modelRequestId: local.id('fg-spawn-req'),
        toolCallId: spawnToolCallId,
        toolName: 'run_agent',
        arguments: {
          operation: 'spawn',
          taskName: 'fg-worker',
          prompt: 'Choose format and implement',
          foregroundWaitMs: 30_000
        }
      },
      undefined,
      { document: parentAuthorityDoc }
    );
    const spawnElapsedMs = Date.now() - spawnStartedAt;
    assert.ok(spawnElapsedMs < 5_000, `spawn foreground wait deadlocked (${spawnElapsedMs}ms)`);

    const spawnDetail = await local.readToolDetail(spawnToolCallId);
    assert.equal(spawnDetail.status, 'awaiting_parent_answer');
    assert.equal(spawnDetail.childContinuesInBackground, true);
    assert.ok(spawnDetail.answerBridgeId);
    assert.equal(spawnDetail.pendingQuestion.question, 'Spawn phase: pick serialization format');
    assert.equal(spawnDetail.pendingQuestion.options[1].label, 'CBOR');
    assert.match(spawnDetail.guidance, /answer_question/);

    // Verify durable settlement invariants on parent ToolCall/ToolExecution/ToolOutcome/ToolModelResult.
    assert.equal((await local.get('ToolCall', spawnToolCallId)).status, 'terminal');
    assert.equal((await local.rows('ToolOutcome', { tool_call_id: spawnToolCallId })).length, 1);
    assert.equal((await local.rows('ToolModelResult', { tool_call_id: spawnToolCallId })).length, 1);

    // Parent answers the spawn-phase question -> child resumes and completes!
    const spawnAnswered = await local.dispatchRunAgent(parent.turnId, {
      operation: 'answer_question',
      answerBridgeId: spawnDetail.answerBridgeId,
      questionId: spawnDetail.pendingQuestion.questionId,
      selectedOptionIndexes: [1]
    });
    assert.equal(spawnAnswered.detail.status, 'answered');
    await local.coordinator.waitForIdle();
    const afterSpawnAnswer = await local.app.runtime.answers.readCurrent(spawnDetail.answerBridgeId);
    assert.equal(afterSpawnAnswer.status, 'submitted');
    assert.match(afterSpawnAnswer.content, /Spawn completed with CBOR/);

    // 2. Continuation send with foregroundWaitMs=30_000 -> child calls ask_user -> settles immediately!
    const sendToolCallId = await local.toolCall(parent.turnId, 'run_agent', {
      operation: 'send',
      answerBridgeId: spawnDetail.answerBridgeId,
      prompt: 'Now add transport layer',
      foregroundWaitMs: 30_000
    });
    const sendStartedAt = Date.now();
    await local.coordinator.dispatch({
      turnId: parent.turnId,
      modelRequestId: local.id('fg-send-req'),
      toolCallId: sendToolCallId,
      toolName: 'run_agent',
      arguments: {
        operation: 'send',
        answerBridgeId: spawnDetail.answerBridgeId,
        prompt: 'Now add transport layer',
        foregroundWaitMs: 30_000
      }
    });
    const sendElapsedMs = Date.now() - sendStartedAt;
    assert.ok(sendElapsedMs < 5_000, `send foreground wait deadlocked (${sendElapsedMs}ms)`);

    const sendDetail = await local.readToolDetail(sendToolCallId);
    assert.equal(sendDetail.status, 'awaiting_parent_answer');
    assert.equal(sendDetail.childContinuesInBackground, true);
    assert.equal(sendDetail.answerBridgeId, spawnDetail.answerBridgeId);
    assert.equal(sendDetail.pendingQuestion.question, 'Send phase: enable compression?');

    // Parent answers continuation question -> child resumes and completes!
    const sendAnswered = await local.dispatchRunAgent(parent.turnId, {
      operation: 'answer_question',
      answerBridgeId: spawnDetail.answerBridgeId,
      questionId: sendDetail.pendingQuestion.questionId,
      selectedOptionIndexes: [0]
    });
    assert.equal(sendAnswered.detail.status, 'answered');
    await local.coordinator.waitForIdle();
    const afterSendAnswer = await local.app.runtime.answers.readCurrent(spawnDetail.answerBridgeId);
    assert.equal(afterSendAnswer.status, 'submitted');
    assert.match(afterSendAnswer.content, /Continuation completed with compression enabled/);
    assert.ok(childConversationId);
  } finally {
    await local.close();
  }
});

test('transient notifyChildQuestion failure retries automatically via poll loop and recoverStartup delivers already-parked questions', { timeout: 15000 }, async () => {
  const local = await openAskUserFixture();
  try {
    const parent = await local.parentTurn('transient-notify-retry');
    const child = await local.spawn(parent, 'retry-worker');
    await local.endTurn(parent.turnId);

    const parentSawQuestion = gate();
    const childFinished = gate();
    let childRound = 0;
    let parentRound = 0;

    local.model = async (request, start) => {
      const wire = JSON.stringify(start.contents);
      if (request.conversationId === child.childConversationId) {
        childRound += 1;
        if (childRound === 1) {
          return toolCallAnswer('ask_user', {
            question: 'Retry delivery question: pick port?',
            options: [{ label: '8080' }, { label: '9090' }],
            multiple: false
          }, 'retry-ask-1');
        }
        childFinished.resolve(wire);
        return textAnswer('Using port 9090.');
      }
      if (request.conversationId === parent.conversationId) {
        parentRound += 1;
        if (parentRound === 1) {
          parentSawQuestion.resolve(wire);
          const childRefMatch = wire.match(/childRef=(A\d+)/);
          const questionIdMatch = wire.match(/questionId:\s*([^\s\\"]+)/);
          assert.ok(childRefMatch && questionIdMatch);
          return toolCallAnswer('run_agent', {
            operation: 'answer_question',
            childRef: childRefMatch[1],
            questionId: questionIdMatch[1],
            selectedOptionIndexes: [1]
          }, 'retry-parent-answer-1');
        }
        return textAnswer('Replied after retry.');
      }
      return textAnswer('ok');
    };

    // Inject a one-time transient error on collaboration.notifyChildQuestion.
    const originalNotify = local.app.runtime.collaboration.notifyChildQuestion.bind(local.app.runtime.collaboration);
    let notifyAttempts = 0;
    local.app.runtime.collaboration.notifyChildQuestion = async (input) => {
      notifyAttempts += 1;
      if (notifyAttempts === 1) {
        throw new Error('Injected transient SQLITE_BUSY during notifyChildQuestion');
      }
      return originalNotify(input);
    };

    local.activateRunner();
    await local.app.processDeliveries.start();

    assert.equal(local.coordinator.launch(child.childExecutionId, child.childTurnId), true);
    await local.coordinator.activeTurns.get(child.childTurnId);

    // First attempt failed transiently -> no message yet, child is parked with retry scheduled.
    assert.equal(notifyAttempts, 1);
    assert.equal((await local.rows('CollaborationMessageSourceLink', { source_kind: 'child_question' })).length, 0);

    // Without any manual intervention or Host restart, the poll loop retries and wakes the parent!
    await local.until(() => parentSawQuestion.settled, 'poll loop did not retry failed notifyChildQuestion', 8_000);
    assert.ok(notifyAttempts >= 2);
    await local.until(() => childFinished.settled, 'child did not resume after retried notification');

    await local.coordinator.waitForIdle();
    await local.runner.waitForIdle();
    const answer = await local.app.runtime.answers.readCurrent(child.answerBridgeId);
    assert.equal(answer.status, 'submitted');
    assert.match(answer.content, /Using port 9090/);

    // Part B: recoverStartup delivers a child ask_user that was already parked before Host restart.
    const recoveryParent = await local.parentTurn('recovery-parked-question-parent');
    const recoveryChild = await local.spawn(recoveryParent, 'recovery-parked-worker');
    local.model = async request => {
      if (request.conversationId === recoveryChild.childConversationId) {
        return toolCallAnswer('ask_user', {
          question: 'Already parked before startup recovery',
          options: [{ label: 'Continue' }],
          multiple: false
        }, 'recovery-parked-ask-1');
      }
      return textAnswer('ok');
    };
    // Simulate a Host crash/failure right before notifyChildQuestion could commit.
    local.app.runtime.collaboration.notifyChildQuestion = async () => {
      throw new Error('Host died before notifying parent');
    };
    assert.equal(local.coordinator.launch(recoveryChild.childExecutionId, recoveryChild.childTurnId), true);
    await local.coordinator.activeTurns.get(recoveryChild.childTurnId);
    const [parkedReq] = await local.rows('InteractionRequest', { request_kind: 'ask_user', status: 'pending' });
    assert.ok(parkedReq);
    assert.equal(
      (await local.rows('CollaborationMessageSourceLink', { source_kind: 'child_question', source_key: parkedReq.id })).length,
      0
    );
    // Clear in-memory waitingOwned (simulating fresh startup) and restore notifyChildQuestion.
    local.coordinator.waitingOwned.clear();
    local.app.runtime.collaboration.notifyChildQuestion = originalNotify;

    await local.coordinator.recoverStartup();
    await local.coordinator.waitForIdle();
    assert.equal(
      (await local.rows('CollaborationMessageSourceLink', { source_kind: 'child_question', source_key: parkedReq.id })).length,
      1,
      'recoverStartup must deliver pending ask_user for already-parked child task Turns'
    );
  } finally {
    await local.close();
  }
});

test('direct human chat Turn in child tab preserves interactionAttention toast and does NOT notify parent', { timeout: 12000 }, async () => {
  const local = await openAskUserFixture();
  try {
    const parent = await local.parentTurn('human-chat-in-child-tab-parent');
    const child = await local.spawn(parent, 'child-tab-worker');

    // Finish the parent-dispatched spawn Turn so the child conversation is idle.
    await local.endTurn(child.childTurnId, 'completed');
    await local.app.runtime.children.observeTurnTerminal(child.childExecutionId, child.childTurnId);
    await local.app.database.conversationOwners.claim(child.childConversationId);

    // Human user directly sends a message in the child conversation tab.
    local.model = async request => {
      if (request.conversationId === child.childConversationId) {
        return toolCallAnswer('ask_user', {
          question: 'Direct human chat question in child tab',
          options: [{ label: 'Option 1' }, { label: 'Option 2' }],
          multiple: false
        }, 'human-child-tab-ask-1');
      }
      return textAnswer('done');
    };
    const humanTurn = await local.coordinator.inputFromConversation({
      commandId: local.id('human-child-input'),
      childExecutionId: child.childExecutionId,
      conversationId: child.childConversationId,
      content: 'Hey child, quick question from the human user'
    });
    assert.ok(humanTurn.admitted && humanTurn.turnId);
    await local.coordinator.activeTurns.get(humanTurn.turnId);

    const [humanAskReq] = await local.rows('InteractionRequest', { request_kind: 'ask_user', status: 'pending' });
    assert.ok(humanAskReq, 'expected pending ask_user from human-initiated child tab turn');
    assert.equal(await local.app.runtime.answers.isChildTaskTurn(humanTurn.turnId), false);

    // 1. Must NOT notify or wake parent Agent!
    assert.equal((await local.rows('CollaborationMessageSourceLink', { source_kind: 'child_question' })).length, 0);
    assert.equal((await local.rows('RuntimeDelivery', { target_conversation_id: parent.conversationId })).length, 0);

    // 2. Must STILL produce an interactionAttention toast (both with and without contentStore)!
    const withStore = await readPendingInteractionAttention(
      local.app.database,
      local.app.database.hostBootId,
      local.app.contentStore
    );
    const withoutStore = await readPendingInteractionAttention(
      local.app.database,
      local.app.database.hostBootId
    );
    assert.equal(withStore.some(item => item.requestId === humanAskReq.id), true, 'human-authored child-tab ask_user must keep VS Code toast (with contentStore)');
    assert.equal(withoutStore.some(item => item.requestId === humanAskReq.id), true, 'human-authored child-tab ask_user must keep VS Code toast (without contentStore)');
  } finally {
    await local.close();
  }
});

test('authority guard rejects already-terminal parent run_agent ToolCall in resolveAskUser', { timeout: 10000 }, async () => {
  const local = await openAskUserFixture();
  try {
    const parent = await local.parentTurn('terminal-parent-tool-guard');
    const child = await local.spawn(parent, 'guarded-child');
    const askCallId = await local.toolCall(child.childTurnId, 'ask_user', {
      question: 'Need live parent run_agent call',
      options: [{ label: 'Yes' }],
      multiple: false
    });
    const paused = await local.app.interactions.pauseForAskUser({
      source: { kind: 'internal', key: `pause:${askCallId}` },
      toolCallId: askCallId,
      prompt: {
        question: 'Need live parent run_agent call',
        options: [{ label: 'Yes' }],
        multiple: false
      }
    });

    // Execute a benign run_agent(list) so we obtain a genuine, already-terminal run_agent ToolCall in parentTurn.
    const listed = await local.dispatchRunAgent(parent.turnId, { operation: 'list' });
    assert.equal((await local.get('ToolCall', listed.toolCallId)).status, 'terminal');

    await assert.rejects(
      local.app.interactions.resolveAskUser({
        source: { kind: 'internal', key: `replay-terminal:${listed.toolCallId}` },
        requestId: paused.requestId,
        response: { answer: { selectedOptionIndexes: [0] } },
        parentAgent: {
          parentConversationId: parent.conversationId,
          parentTurnId: parent.turnId,
          parentToolCallId: listed.toolCallId,
          childExecutionId: child.childExecutionId
        }
      }),
      /运行中 run_agent 调用/
    );
  } finally {
    await local.close();
  }
});
