// Focused real production probes; no matrix or duplicate registrations.
import assert from 'node:assert/strict';

import fs from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import { pathToFileURL } from 'node:url';

const root = process.cwd();

const kernel = await import(pathToFileURL(
  path.join(root, 'dist/extension/backend/reliableKernel/index.js')
).href);

const { emptyConversationContextHandleStateStep } = await import(pathToFileURL(
  path.join(root, 'dist/extension/backend/reliableKernel/conversationContextHandleState.js')
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
    emptyConversationContextHandleStateStep(conversationId, now),
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



export const scenario1 = async getRuntime => {
  const fixture = await getRuntime();
  const app = fixture.app;
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
            { id: 'guidance-tool-provider-call', name: 'counter', arguments: { value: 1 } }
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
  const scope = await fixture.scope('guidance-queue', {
    reply: (request, controls) => provider.sendFullRequest(request, controls),
    async execute() {
      toolDispatches += 1;
      markToolStarted();
      await toolGate;
      toolFinished = true;
      return { ok: true, output: 'Current tool completed.' };
    }
  });
  const conversationId = scope.id;
  const cancelWaiting = app.toolDispatcher.cancelWaiting;
  app.toolDispatcher.cancelWaiting = async (...args) => {
    toolCancellationCalls += 1;
    return cancelWaiting.apply(app.toolDispatcher, args);
  };
  const runner = scope.runner(errors);

  try {
    const first = await scope.input('先完成当前任务', 'guidance-first');
    await runner.recoverStartup(undefined, conversationId);
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
    assert.equal((await listRows(app.database, 'TurnIntent', { conversation_id: conversationId, state: 'queued' })).length, 2);

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
    assert.equal((await listRows(app.database, 'TurnIntent', { conversation_id: conversationId, state: 'queued' })).length, 0);
    assert.equal((await listRows(app.database, 'MessageRevision', { role: 'user' })).length, 3);
  } finally {
    releaseTool();
    runner.dispose();
    await runner.waitForIdle();
    app.toolDispatcher.cancelWaiting = cancelWaiting;
  }
};

export const scenario2 = async () => {
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
};
