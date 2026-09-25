import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const kernel = await import(pathToFileURL(
  path.join(root, 'dist/extension/backend/reliableKernel/index.js')
).href);
const { ReliableConversationRunner } = await import(pathToFileURL(
  path.join(root, 'dist/extension/backend/application/reliableKernel/ReliableConversationRunner.js')
).href);

function modelContent(text = '', toolCalls = []) {
  return {
    role: 'model',
    parts: [
      ...(text ? [{ text }] : []),
      ...toolCalls.map((call) => ({
        ...(call.id ? { id: call.id } : {}),
        functionCall: { name: call.name, args: call.arguments ?? {} }
      }))
    ]
  };
}

function dependencies(overrides = {}) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: {
            content: JSON.stringify({ providerConfigId: 'provider-local', modelId: 'model-local' })
          },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              executorAgentId: request.executorAgentId,
              modelProfile: {
                compressionThresholdTokens: 100000,
                contextWindowTokens: 128000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              model: { providerConfigId: 'provider-local', modelId: 'model-local' },
              policies: { toolPolicyId: 'tools-default', systemPromptId: 'prompt-default' }
            })
          }
        };
      }
    },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: {
      async toolAnnotations() { return {}; },
      async callTool() { return null; }
    },
    mcpPolicyGate: {
      async authorize() {
        return { toolPolicyAllowed: true, planReviewAllowed: true };
      }
    },
    attachmentSettings: {
      async loadGlobalSettings() {
        return {
          section: 'attachments',
          settings: { maxStoredInlineFileMb: 25 },
          filePath: 'settings/attachments.json'
        };
      }
    },
    providers: {
      resolve(providerId) {
        return {
          providerId,
          async sendFullRequest() {
            throw new Error('测试未派发 Provider。');
          }
        };
      }
    },
    toolDispatcher: {
      definitions() { return []; },
      async dispatch() { throw new Error('测试未派发工具。'); }
    },
    ...overrides
  };
}

test('引导消息等待当前回复和工具全部完成后按发送顺序自动接续', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-guidance-queue-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);

  let app;
  let releaseTool = () => {};
  let markToolStarted = () => {};
  const toolStarted = new Promise((resolve) => { markToolStarted = resolve; });
  const toolGate = new Promise((resolve) => { releaseTool = resolve; });
  let providerCalls = 0;
  let toolDispatches = 0;
  let toolCancellationCalls = 0;
  let toolFinished = false;
  const providerContexts = [];
  const provider = {
    providerId: 'provider-local',
    async sendFullRequest(request, controls) {
      providerCalls += 1;
      assert.ok(providerCalls <= 3, '引导消息不得造成额外模型调用');
      const round = Number(request.recipe.round);
      providerContexts.push(request.context.map((item) => item.content).join('\n'));

      if (providerCalls === 1) {
        assert.equal(round, 1);
        await controls.onEvent({
          kind: 'completed',
          streamSeq: '1',
          content: modelContent('先完成当前工具。', [
            { id: 'guidance-tool-provider-call', name: 'guidance_tool', arguments: {} }
          ])
        });
        return;
      }

      assert.equal(round, 1);
      assert.ok(request.context.some((item) => item.segmentKind === 'tool_pair'));
      const expectedGuidance = providerCalls === 2 ? 'guide-one' : 'guide-two';
      const contextText = request.context.map((item) => item.content).join('\n');
      assert.match(contextText, new RegExp(expectedGuidance));
      if (providerCalls === 2) assert.doesNotMatch(contextText, /guide-two/);
      await controls.onEvent({
        kind: 'completed',
        streamSeq: '1',
        content: modelContent(
          providerCalls === 2 ? '第一条引导消息已处理。' : '第二条引导消息已处理。'
        )
      });
    }
  };
  const errors = [];
  const conversationId = 'guidance-queue-conversation';
  app = await kernel.ReliableKernelApplication.open(authority, dependencies({
    providers: { resolve: () => provider },
    toolDispatcher: {
      definitions() {
        return [{ name: 'guidance_tool', description: '等待测试放行', parameters: { type: 'object' } }];
      },
      async dispatch(input) {
        toolDispatches += 1;
        markToolStarted();
        await toolGate;
        const settled = await app.runtime.effects.settleWithoutEffect({
          source: { kind: 'internal', key: `guidance-tool:${input.toolCallId}` },
          toolCallId: input.toolCallId,
          status: 'succeeded',
          detail: { completed: true }
        });
        toolFinished = true;
        return settled.terminal ?? app.runtime.effects.readTerminalResult(input.toolCallId, true);
      },
      async cancelWaiting() {
        toolCancellationCalls += 1;
      }
    }
  }));
  const runner = new ReliableConversationRunner(
    app,
    `guidance-runner:${app.database.hostBootId}`,
    (error, context) => errors.push({ error, context })
  );

  try {
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId,
        title: 'Guidance queue',
        status: 'active',
        created_at: now,
        updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: 'guidance-agent-link',
        conversation_id: conversationId,
        agent_id: 'agent-main',
        role: 'default',
        created_at: now,
        updated_at: now
      })
    ]);

    const first = await runner.input({
      commandId: 'guidance-first',
      conversationId,
      text: '先完成当前任务'
    });
    await withTimeout(toolStarted, 5_000, '当前回复未进入工具执行');

    const firstGuidance = await runner.input({
      commandId: 'guidance-second',
      conversationId,
      text: 'guide-one'
    });
    const secondGuidance = await runner.input({
      commandId: 'guidance-third',
      conversationId,
      text: 'guide-two'
    });

    assert.equal(first.admitted, true);
    assert.equal(firstGuidance.admitted, false);
    assert.equal(secondGuidance.admitted, false);
    assert.equal(providerCalls, 1, '工具完成前不得开始引导消息');
    assert.equal(toolDispatches, 1);
    assert.equal(toolFinished, false);
    assert.equal(toolCancellationCalls, 0);
    assert.equal((await listRows(app.database, 'TurnIntent', { state: 'queued' })).length, 2);

    releaseTool();
    await withTimeout(runner.waitForIdle(), 10_000, '当前工具完成后引导消息未自动接续');

    assert.equal(errors.length, 0);
    assert.equal(toolFinished, true);
    assert.equal(toolCancellationCalls, 0, '引导消息不得取消当前工具');
    assert.equal(providerCalls, 3);
    assert.match(providerContexts[1], /guide-one/);
    assert.doesNotMatch(providerContexts[1], /guide-two/);
    assert.match(providerContexts[2], /guide-two/);

    const firstTurnRequests = await listRows(app.database, 'ModelRequest', { turn_id: first.turnId });
    assert.equal(firstTurnRequests.length, 1, '工具完成后必须先接续引导消息，不能让原任务自行继续');
    const turns = await listRows(app.database, 'Turn', { conversation_id: conversationId });
    assert.equal(turns.length, 3);
    assert.ok(turns.every((turn) => turn.status === 'terminated'));
    assert.equal((await listRows(app.database, 'TurnIntent', { state: 'queued' })).length, 0);
    assert.equal((await listRows(app.database, 'MessageRevision', { role: 'user' })).length, 3);
  } finally {
    releaseTool();
    runner.dispose();
    await runner.waitForIdle();
    await app.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('Subagent RuntimeDelivery continuation 在当前回复和工具批次结束后立即接续', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-runtime-delivery-handoff-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);

  let app;
  let releaseTool = () => {};
  let markToolStarted = () => {};
  const toolStarted = new Promise((resolve) => { markToolStarted = resolve; });
  const toolGate = new Promise((resolve) => { releaseTool = resolve; });
  let providerCalls = 0;
  const providerContexts = [];
  const provider = {
    providerId: 'provider-local',
    async sendFullRequest(request, controls) {
      providerCalls += 1;
      providerContexts.push(request.context.map((item) => item.content).join('\n'));
      assert.ok(providerCalls <= 3, 'RuntimeDelivery continuation 不得产生额外模型调用');
      await controls.onEvent({
        kind: 'completed',
        streamSeq: '1',
        content: providerCalls === 1
          ? modelContent('先完成当前工具。', [
              { id: 'runtime-delivery-tool-provider-call', name: 'runtime_delivery_tool', arguments: {} }
            ])
          : modelContent('Subagent 通知已处理。')
      });
    }
  };
  const errors = [];
  const conversationId = 'runtime-delivery-handoff-conversation';
  app = await kernel.ReliableKernelApplication.open(authority, dependencies({
    providers: { resolve: () => provider },
    toolDispatcher: {
      definitions() {
        return [{ name: 'runtime_delivery_tool', description: '等待测试放行', parameters: { type: 'object' } }];
      },
      async dispatch(input) {
        markToolStarted();
        await toolGate;
        const settled = await app.runtime.effects.settleWithoutEffect({
          source: { kind: 'internal', key: `runtime-delivery-tool:${input.toolCallId}` },
          toolCallId: input.toolCallId,
          status: 'succeeded',
          detail: { completed: true }
        });
        return settled.terminal ?? app.runtime.effects.readTerminalResult(input.toolCallId, true);
      }
    }
  }));
  const runner = new ReliableConversationRunner(
    app,
    `runtime-delivery-handoff:${app.database.hostBootId}`,
    (error, context) => errors.push({ error, context })
  );

  try {
    await createConversation(app, conversationId, 'runtime-delivery-handoff-agent-link');
    const first = await runner.input({
      commandId: 'runtime-delivery-handoff-first',
      conversationId,
      text: '执行当前任务'
    });
    await withTimeout(toolStarted, 5_000, '当前回复未进入工具执行');

    const answerPayload = await app.contentStore.ingest(
      app.database,
      'INTERRUPTED-SUBAGENT-HANDOFF-PAYLOAD',
      'text/plain'
    );
    const deliveryNow = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: 'runtime-handoff-child-conversation',
        title: 'Interrupted Subagent fixture',
        status: 'active',
        created_at: deliveryNow,
        updated_at: deliveryNow
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: 'runtime-handoff-child-agent-link',
        conversation_id: 'runtime-handoff-child-conversation',
        agent_id: 'agent-reviewer',
        role: 'default',
        created_at: deliveryNow,
        updated_at: deliveryNow
      }),
      kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: 'runtime-handoff-child-turn',
        conversation_id: 'runtime-handoff-child-conversation',
        status: 'terminated',
        created_at: deliveryNow,
        updated_at: deliveryNow,
        terminal_at: deliveryNow
      }),
      kernel.DOMAIN_REPOSITORIES.domain('ChildExecution').insert({
        id: 'runtime-handoff-child-execution',
        child_conversation_id: 'runtime-handoff-child-conversation',
        status: 'interrupted',
        created_at: deliveryNow,
        updated_at: deliveryNow
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AnswerBridge').insert({
        id: 'runtime-handoff-answer-bridge',
        child_execution_id: 'runtime-handoff-child-execution',
        current_submission_id: 'runtime-handoff-answer-submission',
        status: 'interrupted',
        created_at: deliveryNow,
        updated_at: deliveryNow
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AnswerSubmission').insert({
        id: 'runtime-handoff-answer-submission',
        answer_bridge_id: 'runtime-handoff-answer-bridge',
        submission_seq: '1',
        turn_id: 'runtime-handoff-child-turn',
        interrupted: '1',
        created_at: deliveryNow
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AnswerPayload').insert({
        id: 'runtime-handoff-answer-payload',
        submission_id: 'runtime-handoff-answer-submission',
        title: 'Interrupted Subagent result',
        content_object_id: answerPayload.id,
        byte_length: answerPayload.byte_length,
        created_at: deliveryNow
      }),
      kernel.DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').insert({
        id: 'runtime-handoff-inbox',
        dedupe_key: 'answer:runtime-handoff-answer-bridge:runtime-handoff-answer-submission',
        source_kind: 'answer_submission',
        source_id: 'runtime-handoff-answer-submission',
        state: 'available',
        created_at: deliveryNow,
        updated_at: deliveryNow
      }),
      kernel.DOMAIN_REPOSITORIES.domain('RuntimeInboxPayloadLink').insert({
        id: 'runtime-handoff-payload-link',
        inbox_item_id: 'runtime-handoff-inbox',
        content_object_id: answerPayload.id,
        created_at: deliveryNow
      })
    ]);
    const runtimeDelivery = await app.runtime.deliveries.create({
      inboxItemId: 'runtime-handoff-inbox',
      targetConversationId: conversationId,
      phase: 'next_turn'
    });

    // This is the exact no-visible-message TurnIntent created by the RuntimeDelivery wake handler
    // after a background/interrupted/timed-out Subagent result is routed to next_turn.
    const continuation = await runner.runtimeContinuation({
      commandId: 'runtime-delivery:subagent-timeout-answer',
      conversationId,
      sourceTurnId: first.turnId,
      deliveryId: runtimeDelivery.delivery.id
    });
    assert.equal(first.admitted, true);
    assert.equal(continuation.admitted, false);
    assert.equal(providerCalls, 1, '当前回复和工具尚未结束时不得抢占');

    const [deliveryIntentLink] = await listRows(app.database, 'RuntimeDeliveryIntentLink', {
      turn_intent_id: continuation.intentId
    });
    assert.equal(deliveryIntentLink.delivery_id, runtimeDelivery.delivery.id);
    const continuationEnvelope = await readCurrentIntentEnvelope(app, continuation.intentId);
    assert.deepEqual(continuationEnvelope, {
      version: 1,
      kind: 'runtime_continuation',
      sourceTurnId: first.turnId
    });
    assert.equal('deliveryId' in continuationEnvelope, false, 'Delivery 身份只能存在于独立 Link 中');

    const previewReader = new kernel.ClientDetailReader(app.database, app.contentStore);
    const previewDetail = await previewReader.read({
      kind: 'turn-intent-preview',
      recordId: continuation.intentId,
      conversationId,
      offset: 0,
      maxBytes: 64 * 1024
    });
    const preview = JSON.parse(Buffer.from(previewDetail.chunk, 'base64').toString('utf8'));
    assert.equal(preview.version, 3);
    assert.equal(preview.kind, 'runtime_continuation');
    assert.equal(preview.deliveryId, runtimeDelivery.delivery.id);
    assert.equal(preview.source.kind, 'subagent');
    assert.equal(preview.source.agentId, 'agent-reviewer');
    assert.equal(preview.source.childExecutionId, 'runtime-handoff-child-execution');
    assert.equal(preview.source.title, 'Interrupted Subagent result');
    assert.equal(preview.source.outcome, 'interrupted');
    assert.equal('interrupted' in preview.source, false, 'the preview names the answer outcome, not a raw bit');
    const projection = await app.database.clientProjectionSnapshot(conversationId);
    assert.deepEqual(
      projection.snapshot.subagentDeliverySummary.runtimeDeliveryIntentLinks.map((link) => ({
        deliveryId: link.delivery_id,
        intentId: link.turn_intent_id
      })),
      [{ deliveryId: runtimeDelivery.delivery.id, intentId: continuation.intentId }]
    );

    releaseTool();
    await withTimeout(runner.waitForIdle(), 10_000, 'RuntimeDelivery continuation 未在响应边界立即接续');

    assert.equal(errors.length, 0);
    assert.equal(providerCalls, 2, '不得等原 Turn 自行跑完下一轮后才处理 Subagent 通知');
    assert.match(
      providerContexts[1],
      /INTERRUPTED-SUBAGENT-HANDOFF-PAYLOAD/,
      '下一次模型请求必须实际携带排队的 RuntimeDelivery payload'
    );
    assert.equal(
      (await listRows(app.database, 'ModelRequest', { turn_id: first.turnId })).length,
      1,
      '当前工具批次完成后必须交接，原 Turn 不得再发起模型请求'
    );
    const [admittedContinuation] = await listRows(app.database, 'TurnIntent', { id: continuation.intentId });
    assert.ok(admittedContinuation.turn_id, 'RuntimeDelivery continuation 应已取得一个新 Turn');
    assert.equal(
      (await listRows(app.database, 'ModelRequest', { turn_id: admittedContinuation.turn_id })).length,
      1,
      '排队的 RuntimeDelivery continuation 必须立即取得下一次模型请求'
    );
    const [consumedDelivery] = await listRows(app.database, 'RuntimeDelivery', {
      id: runtimeDelivery.delivery.id
    });
    assert.equal(consumedDelivery.state, 'consumed');
    const [inputLink] = await listRows(app.database, 'RuntimeDeliveryInputLink', {
      delivery_id: runtimeDelivery.delivery.id
    });
    assert.ok(inputLink.handled_at, '模型读取后必须 ACK 精确 RuntimeDelivery input link');
    assert.equal((await listRows(app.database, 'TurnIntent', { state: 'queued' })).length, 0);
  } finally {
    releaseTool();
    runner.dispose();
    await runner.waitForIdle();
    await app.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('没有工具时在当前模型输出结束后立即接续引导消息', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-guidance-no-tool-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  let releaseFirst = () => {};
  let markFirstStarted = () => {};
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let providerCalls = 0;
  const contexts = [];
  const provider = {
    providerId: 'provider-local',
    async sendFullRequest(request, controls) {
      providerCalls += 1;
      contexts.push(request.context.map((item) => item.content).join('\n'));
      if (providerCalls === 1) {
        markFirstStarted();
        await firstGate;
      }
      await controls.onEvent({
        kind: 'completed',
        streamSeq: '1',
        content: modelContent(providerCalls === 1 ? '当前输出完成。' : '无工具引导已处理。')
      });
    }
  };
  const app = await kernel.ReliableKernelApplication.open(authority, dependencies({
    providers: { resolve: () => provider }
  }));
  const runner = new ReliableConversationRunner(app, `guidance-no-tool:${app.database.hostBootId}`);
  const conversationId = 'guidance-no-tool-conversation';
  try {
    await createConversation(app, conversationId, 'guidance-no-tool-agent-link');
    const first = await runner.input({
      commandId: 'guidance-no-tool-first', conversationId, text: '先输出一次'
    });
    await withTimeout(firstStarted, 5_000, '当前模型输出未开始');
    const guidance = await runner.input({
      commandId: 'guidance-no-tool-second', conversationId, text: 'no-tool-guide'
    });
    assert.equal(first.admitted, true);
    assert.equal(guidance.admitted, false);
    assert.equal(providerCalls, 1);

    releaseFirst();
    await withTimeout(runner.waitForIdle(), 10_000, '无工具引导消息未自动接续');

    assert.equal(providerCalls, 2);
    assert.match(contexts[1], /no-tool-guide/);
    assert.equal((await listRows(app.database, 'ModelRequest', { turn_id: first.turnId })).length, 1);
    assert.equal((await listRows(app.database, 'TurnIntent', { state: 'queued' })).length, 0);
  } finally {
    releaseFirst();
    runner.dispose();
    await runner.waitForIdle();
    await app.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('引导交接时消息状态变化会保留当前任务而不是误结束', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-guidance-conflict-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const app = await kernel.ReliableKernelApplication.open(authority, dependencies());
  const conversationId = 'guidance-conflict-conversation';
  try {
    await createConversation(app, conversationId, 'guidance-conflict-agent-link');
    const lease = leaseInput(app, conversationId, 'guidance-conflict-owner');
    const first = await app.turns.input({
      source: { kind: 'command', key: 'guidance-conflict-first' },
      ...lease,
      content: 'current task'
    });
    const guidance = await app.turns.input({
      source: { kind: 'command', key: 'guidance-conflict-second' },
      ...lease,
      content: 'cancelled guidance'
    });
    assert.equal(first.admitted, true);
    assert.equal(guidance.admitted, false);

    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('TurnIntent').update(guidance.intentId, {
        state: 'cancelled',
        updated_at: new Date().toISOString()
      })
    ]);
    await assert.rejects(
      app.turns.terminal({
        source: { kind: 'internal', key: 'guidance-conflict-terminal' },
        turnId: first.turnId,
        terminalStatus: 'completed',
        reason: 'test_guidance_conflict',
        handoffQueuedIntentId: guidance.intentId
      }),
      (error) => error?.code === 'TURN_TERMINAL_GUIDANCE_CONFLICT'
    );

    const versionedGuidance = await app.turns.input({
      source: { kind: 'command', key: 'guidance-conflict-versioned' },
      ...lease,
      content: 'versioned guidance'
    });
    const selectedRevisionRows = await listRows(app.database, 'TurnIntentRevision', {
      intent_id: versionedGuidance.intentId
    });
    await app.turns.setGuidanceHold({
      source: { kind: 'command', key: 'guidance-conflict-pause-after-selection' },
      conversationId,
      intentId: versionedGuidance.intentId,
      expectedRevisionSeq: selectedRevisionRows[0].revision_seq.toString(),
      hold: 'paused'
    });
    await assert.rejects(
      app.turns.terminal({
        source: { kind: 'internal', key: 'guidance-conflict-version-terminal' },
        turnId: first.turnId,
        terminalStatus: 'completed',
        reason: 'test_guidance_revision_conflict',
        handoffQueuedIntentId: versionedGuidance.intentId,
        handoffQueuedIntentRevisionIds: selectedRevisionRows.map((revision) => revision.id)
      }),
      (error) => error?.code === 'TURN_TERMINAL_GUIDANCE_CONFLICT'
    );

    const [turn] = await listRows(app.database, 'Turn', { id: first.turnId });
    assert.equal(turn.status, 'active');
    assert.equal((await listRows(app.database, 'ExecutionLease', { turn_id: first.turnId })).length, 1);
    assert.equal((await listRows(app.database, 'TurnTermination', { turn_id: first.turnId })).length, 0);
  } finally {
    await app.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('已完成引导交接在扩展重启后仍会自动发送', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-guidance-restart-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const conversationId = 'guidance-restart-conversation';
  let guidanceIntentId;

  const firstApp = await kernel.ReliableKernelApplication.open(authority, dependencies());
  try {
    await createConversation(firstApp, conversationId, 'guidance-restart-agent-link');
    const lease = leaseInput(firstApp, conversationId, 'guidance-restart-owner');
    const first = await firstApp.turns.input({
      source: { kind: 'command', key: 'guidance-restart-first' },
      ...lease,
      content: 'current task before restart'
    });
    const guidance = await firstApp.turns.input({
      source: { kind: 'command', key: 'guidance-restart-second' },
      ...lease,
      content: 'restart-guide'
    });
    guidanceIntentId = guidance.intentId;
    await firstApp.turns.terminal({
      source: { kind: 'internal', key: 'guidance-restart-handoff' },
      turnId: first.turnId,
      terminalStatus: 'completed',
      reason: 'test_guidance_restart_handoff',
      handoffQueuedIntentId: guidance.intentId
    });
  } finally {
    await firstApp.close();
  }

  let providerCalls = 0;
  let observedContext = '';
  const provider = {
    providerId: 'provider-local',
    async sendFullRequest(request, controls) {
      providerCalls += 1;
      observedContext = request.context.map((item) => item.content).join('\n');
      await controls.onEvent({
        kind: 'completed', streamSeq: '1',
        content: modelContent('重启后的引导消息已处理。')
      });
    }
  };
  const secondApp = await kernel.ReliableKernelApplication.open(authority, dependencies({
    providers: { resolve: () => provider }
  }));
  const runner = new ReliableConversationRunner(
    secondApp,
    `guidance-restart:${secondApp.database.hostBootId}`
  );
  try {
    await runner.recoverStartup();
    await withTimeout(runner.waitForIdle(), 10_000, '重启后引导消息未自动发送');
    assert.equal(providerCalls, 1);
    assert.match(observedContext, /restart-guide/);
    const [intent] = await listRows(secondApp.database, 'TurnIntent', { id: guidanceIntentId });
    assert.equal(intent.state, 'admitted');
    assert.ok(intent.turn_id);
    assert.equal((await listRows(secondApp.database, 'TurnIntent', { state: 'queued' })).length, 0);
  } finally {
    runner.dispose();
    await runner.waitForIdle();
    await secondApp.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test('引导消息支持编辑附件正文、取消、重排、暂停恢复、并发保护和重启恢复', async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-guidance-controls-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const conversationId = 'guidance-controls-conversation';
  let attachmentIntentId;
  let pausedIntentId;
  let pausedRevisionSeq;
  let cancelledIntentId;

  const firstApp = await kernel.ReliableKernelApplication.open(authority, dependencies());
  try {
    await createConversation(firstApp, conversationId, 'guidance-controls-agent-link');
    const lease = leaseInput(firstApp, conversationId, 'guidance-controls-owner');
    const active = await firstApp.turns.input({
      source: { kind: 'command', key: 'guidance-controls-active' },
      ...lease,
      content: 'active blocker'
    });
    const attachment = await firstApp.turns.input({
      source: { kind: 'command', key: 'guidance-controls-attachment' },
      ...lease,
      contentType: 'application/vnd.limcode.message+json',
      content: JSON.stringify({
        role: 'user',
        parts: [
          { text: 'attachment before edit' },
          { inlineData: {
            mimeType: 'image/png',
            name: 'guide.png',
            data: Buffer.from('guidance-attachment').toString('base64')
          } }
        ]
      })
    });
    const paused = await firstApp.turns.input({
      source: { kind: 'command', key: 'guidance-controls-paused' },
      ...lease,
      content: 'pause-me'
    });
    const cancelled = await firstApp.turns.input({
      source: { kind: 'command', key: 'guidance-controls-cancelled' },
      ...lease,
      content: 'cancel-me'
    });
    assert.equal(active.admitted, true);
    assert.equal(attachment.admitted, false);
    assert.equal(paused.admitted, false);
    assert.equal(cancelled.admitted, false);
    attachmentIntentId = attachment.intentId;
    pausedIntentId = paused.intentId;
    cancelledIntentId = cancelled.intentId;

    const attachmentRevision1 = await currentIntentRevisionSeq(firstApp.database, attachment.intentId);
    const editCommand = {
      source: { kind: 'command', key: 'guidance-controls-edit' },
      conversationId,
      intentId: attachment.intentId,
      expectedRevisionSeq: attachmentRevision1,
      text: 'attachment after edit'
    };
    const edited = await firstApp.turns.editGuidance(editCommand);
    assert.equal(edited.deduplicated, false);
    assert.equal(edited.intentRevisionSeq, '2');
    const editReplay = await firstApp.turns.editGuidance(editCommand);
    assert.equal(editReplay.deduplicated, true, '相同控制命令必须幂等重放');
    await assert.rejects(
      firstApp.turns.setGuidanceHold({
        source: { kind: 'command', key: 'guidance-controls-stale' },
        conversationId,
        intentId: attachment.intentId,
        expectedRevisionSeq: attachmentRevision1,
        hold: 'paused'
      }),
      (error) => error?.code === 'GUIDANCE_CONTROL_CONFLICT'
    );

    await firstApp.turns.cancelGuidance({
      source: { kind: 'command', key: 'guidance-controls-cancel' },
      conversationId,
      intentId: cancelled.intentId,
      expectedRevisionSeq: await currentIntentRevisionSeq(firstApp.database, cancelled.intentId)
    });
    const [cancelledRow] = await listRows(firstApp.database, 'TurnIntent', { id: cancelled.intentId });
    assert.equal(cancelledRow.state, 'cancelled');

    await firstApp.turns.reorderGuidance({
      source: { kind: 'command', key: 'guidance-controls-reorder' },
      conversationId,
      items: [
        {
          intentId: paused.intentId,
          expectedRevisionSeq: await currentIntentRevisionSeq(firstApp.database, paused.intentId)
        },
        {
          intentId: attachment.intentId,
          expectedRevisionSeq: await currentIntentRevisionSeq(firstApp.database, attachment.intentId)
        }
      ]
    });
    await firstApp.turns.setGuidanceHold({
      source: { kind: 'command', key: 'guidance-controls-pause' },
      conversationId,
      intentId: paused.intentId,
      expectedRevisionSeq: await currentIntentRevisionSeq(firstApp.database, paused.intentId),
      hold: 'paused'
    });
    pausedRevisionSeq = await currentIntentRevisionSeq(firstApp.database, paused.intentId);

    await firstApp.turns.terminal({
      source: { kind: 'internal', key: 'guidance-controls-release-active' },
      turnId: active.turnId,
      terminalStatus: 'completed',
      reason: 'guidance_controls_test_release'
    });
  } finally {
    await firstApp.close();
  }

  const secondApp = await kernel.ReliableKernelApplication.open(authority, dependencies());
  try {
    const firstAdmission = await secondApp.turns.admitNextQueued(
      leaseInput(secondApp, conversationId, 'guidance-controls-restart-owner')
    );
    assert.ok(firstAdmission);
    assert.equal(firstAdmission.intentId, attachmentIntentId, '排在前面的暂停项应被跳过');
    const admittedContent = await readMessageRevisionContent(secondApp, firstAdmission.messageRevisionId);
    assert.equal(admittedContent.parts[0].text, 'attachment after edit');
    assert.ok(admittedContent.parts[1].inlineData.attachmentId, '编辑必须保留托管附件引用');
    assert.equal('data' in admittedContent.parts[1].inlineData, false);

    await secondApp.turns.terminal({
      source: { kind: 'internal', key: 'guidance-controls-first-admission-terminal' },
      turnId: firstAdmission.turnId,
      terminalStatus: 'completed',
      reason: 'guidance_controls_first_admission_complete'
    });
    const whilePaused = await secondApp.turns.admitNextQueued(
      leaseInput(secondApp, conversationId, 'guidance-controls-paused-owner')
    );
    assert.equal(whilePaused, null, '只剩暂停引导时不得自动接纳');

    await secondApp.turns.setGuidanceHold({
      source: { kind: 'command', key: 'guidance-controls-resume' },
      conversationId,
      intentId: pausedIntentId,
      expectedRevisionSeq: pausedRevisionSeq,
      hold: 'none'
    });
    const resumedAdmission = await secondApp.turns.admitNextQueued(
      leaseInput(secondApp, conversationId, 'guidance-controls-resumed-owner')
    );
    assert.ok(resumedAdmission);
    assert.equal(resumedAdmission.intentId, pausedIntentId);
    const resumedContent = await readMessageRevisionContent(secondApp, resumedAdmission.messageRevisionId);
    assert.equal(resumedContent, 'pause-me');
    const [cancelledAfterRestart] = await listRows(secondApp.database, 'TurnIntent', { id: cancelledIntentId });
    assert.equal(cancelledAfterRestart.state, 'cancelled');
  } finally {
    await secondApp.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
});

async function readCurrentIntentEnvelope(app, intentId) {
  const revisions = await listRows(app.database, 'TurnIntentRevision', { intent_id: intentId });
  assert.equal(revisions.length, 1);
  const [metadata] = await listRows(app.database, 'ContentObject', {
    id: revisions[0].content_object_id
  });
  assert.equal(metadata.content_type, 'application/vnd.limcode.turn-intent+json');
  return JSON.parse((await app.contentStore.read(metadata)).toString('utf8'));
}

async function currentIntentRevisionSeq(database, intentId) {
  const revisions = await listRows(database, 'TurnIntentRevision', { intent_id: intentId });
  const current = revisions.sort((left, right) => left.revision_seq < right.revision_seq ? 1 : -1)[0];
  return current.revision_seq.toString();
}

async function readMessageRevisionContent(app, revisionId) {
  const [revision] = await listRows(app.database, 'MessageRevision', { id: revisionId });
  const [metadata] = await listRows(app.database, 'ContentObject', { id: revision.content_object_id });
  const source = (await app.contentStore.read(metadata)).toString('utf8');
  return metadata.content_type === 'application/vnd.limcode.message+json'
    ? JSON.parse(source)
    : source;
}

async function createConversation(app, conversationId, linkId) {
  const now = new Date().toISOString();
  await app.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
      id: conversationId,
      title: conversationId,
      status: 'active',
      created_at: now,
      updated_at: now
    }),
    kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
      id: linkId,
      conversation_id: conversationId,
      agent_id: 'agent-main',
      role: 'default',
      created_at: now,
      updated_at: now
    })
  ]);
}

function leaseInput(app, conversationId, ownerId) {
  return {
    conversationId,
    leaseOwnerId: ownerId,
    hostBootId: app.database.hostBootId,
    leaseExpiresAt: new Date(Date.now() + 120_000).toISOString()
  };
}

async function listRows(database, domain, where) {
  const result = await database.snapshot([
    kernel.DOMAIN_REPOSITORIES.domain(domain).list({ where, limit: 1000 })
  ]);
  return result.snapshot[0];
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
