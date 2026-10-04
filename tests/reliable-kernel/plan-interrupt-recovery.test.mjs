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
const { emptyConversationContextHandleStateStep } = await import(pathToFileURL(
  path.join(root, 'dist/extension/backend/reliableKernel/conversationContextHandleState.js')
).href);
const { ReliableConversationRunner } = await import(pathToFileURL(
  path.join(root, 'dist/extension/backend/application/reliableKernel/ReliableConversationRunner.js')
).href);
const { submitPlanTool } = await import(pathToFileURL(
  path.join(root, 'dist/extension/backend/world/modules/tools/definitions/submitPlan/index.js')
).href);
const { askUserTool } = await import(pathToFileURL(
  path.join(root, 'dist/extension/backend/world/modules/tools/definitions/askUser/index.js')
).href);
const { taskListTool } = await import(pathToFileURL(
  path.join(root, 'dist/extension/backend/world/modules/tools/definitions/taskList/index.js')
).href);

const PLAN_ARGS = {
  plan: '1. 检查停止路径。\n2. 验证终结事实。',
  taskList: {
    mode: 'rewrite',
    items: [
      { title: '检查停止路径', description: '检查全局停止。', status: 'pending', delete: false },
      { title: '验证终结事实', description: '检查持久化状态。', status: 'pending', delete: false }
    ]
  }
};

test('Plan 等待中全局停止会取消 Interaction、终结 Turn 并释放租约', async () => {
  const harness = await createHarness();
  try {
    const started = await harness.startPlan();
    const lease = (await rows(harness.app, 'ExecutionLease', { turn_id: started.turnId }))[0];
    const ack = await harness.runner.interrupt({
      commandId: 'plan-stop-normal-interrupt',
      conversationId: harness.conversationId,
      turnId: started.turnId,
      expectedLeaseGeneration: String(lease.generation),
      reason: 'test_global_stop'
    });
    assert.ok(ack.pendingTurnInputId);
    await assertInterrupted(harness, started.turnId);
    assert.deepEqual(harness.errors, []);
  } finally {
    await harness.close();
  }
});

test('Plan 等待租约过期后仍可携带旧 generation 停止并恢复', async () => {
  const harness = await createHarness({ leaseDurationMs: 1_200 });
  try {
    const started = await harness.startPlan();
    const lease = (await rows(harness.app, 'ExecutionLease', { turn_id: started.turnId }))[0];
    await sleep(Math.max(0, Date.parse(lease.expires_at) - Date.now() + 120));
    assert.ok(Date.parse(lease.expires_at) <= Date.now(), 'fixture lease must be expired');
    await harness.runner.interrupt({
      commandId: 'plan-stop-expired-interrupt',
      conversationId: harness.conversationId,
      turnId: started.turnId,
      expectedLeaseGeneration: String(lease.generation),
      reason: 'test_expired_global_stop'
    });
    await assertInterrupted(harness, started.turnId);
    assert.deepEqual(harness.errors, []);
  } finally {
    await harness.close();
  }
});

test('中断 ACK 后 cancelWaiting 连续失败会由 level-triggered recovery 自动收敛', async () => {
  let cancelAttempts = 0;
  const harness = await createHarness({
    patchCancelWaiting(dispatcher) {
      const original = dispatcher.cancelWaiting.bind(dispatcher);
      dispatcher.cancelWaiting = async (input) => {
        cancelAttempts += 1;
        if (cancelAttempts <= 2) throw new Error(`injected cancelWaiting failure ${cancelAttempts}`);
        return original(input);
      };
    }
  });
  try {
    const started = await harness.startPlan();
    await harness.runner.interrupt({
      commandId: 'plan-stop-recovery-interrupt',
      conversationId: harness.conversationId,
      turnId: started.turnId,
      reason: 'test_recovering_global_stop'
    });
    await assertInterrupted(harness, started.turnId, 12_000);
    assert.ok(cancelAttempts >= 3, 'Runner must retry the durable pending termination');
    assert.ok(harness.errors.some((entry) => /could not record terminal state|cancelWaiting failure/.test(entry.error)));
  } finally {
    await harness.close();
  }
});

test('开启无人值守审批后 Plan、Ask 和后续生成连续完成，不等待人工命令', async () => {
  const harness = await createHarness({ autoApproveInteractions: true });
  try {
    const started = await harness.runner.input({
      commandId: 'auto-approval-input', conversationId: harness.conversationId, text: '按计划自主继续。'
    });
    await eventually(async () => (await rows(harness.app, 'TurnTermination', { turn_id: started.turnId })).length === 1, 10_000, 'Auto-approved Turn did not finish');
    const [termination] = await rows(harness.app, 'TurnTermination', { turn_id: started.turnId });
    assert.equal(termination.terminal_status, 'completed', JSON.stringify({ termination, errors: harness.errors, providerCalls: harness.providerCalls }));
    assert.equal(harness.providerCalls, 4);
    const requests = await rows(harness.app, 'InteractionRequest');
    assert.deepEqual(requests.map((request) => [request.request_kind, request.status]).sort(), [
      ['ask_user', 'succeeded'], ['plan_review', 'succeeded']
    ]);
    assert.equal((await rows(harness.app, 'InteractionResponse')).length, 2);
    assert.equal((await rows(harness.app, 'ToolOutcome')).length, 3);
    assert.deepEqual(harness.errors, []);
  } finally {
    await harness.close();
  }
});

async function createHarness(options = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-plan-interrupt-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  let providerCalls = 0;
  const replies = [modelContent([{ id: 'provider-plan-call', name: 'submit_plan', arguments: PLAN_ARGS }])];
  if (options.autoApproveInteractions) {
    replies.push(modelContent([{
      id: 'provider-ask-call', name: 'ask_user',
      arguments: { question: '如何继续？', options: [{ label: '最小修改' }, { label: '重构' }] }
    }]));
    replies.push(modelContent([{
      id: 'provider-task-complete-call', name: 'update_task_list',
      arguments: { mode: 'update', items: PLAN_ARGS.taskList.items.map((item) => ({ title: item.title, status: 'completed' })) }
    }]));
    replies.push({ role: 'model', parts: [{ text: '已按自动回复继续并完成。' }] });
  }
  const provider = {
    providerId: 'provider-plan-interrupt',
    async sendFullRequest(_request, controls) {
      providerCalls += 1;
      const content = replies[providerCalls - 1];
      if (!content) throw new Error(`Unexpected Provider call ${providerCalls}.`);
      await controls.onEvent({
        kind: 'completed',
        streamSeq: '1',
        content
      });
    }
  };
  const host = {
    definitions() { return options.autoApproveInteractions ? [submitPlanTool, askUserTool, taskListTool] : [submitPlanTool]; },
    async cancelTurnWaits() {},
    async dispose() {}
  };
  const app = await kernel.ReliableKernelApplication.open(authority, dependencies(provider, host, options));
  options.patchCancelWaiting?.(app.toolDispatcher);
  const errors = [];
  const runner = new ReliableConversationRunner(
    app,
    `plan-interrupt-runner:${app.database.hostBootId}`,
    (error, context) => errors.push({ error: error?.stack ?? String(error), context }),
    options.leaseDurationMs
  );
  const conversationId = `conversation-plan-interrupt-${path.basename(parent)}`;
  const now = new Date().toISOString();
  await app.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
      id: conversationId,
      title: 'Plan interrupt test',
      status: 'active',
      created_at: now,
      updated_at: now
    }),
    emptyConversationContextHandleStateStep(conversationId, now),
    kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
      id: `link-${path.basename(parent)}`,
      conversation_id: conversationId,
      agent_id: 'agent-main',
      role: 'default',
      created_at: now,
      updated_at: now
    })
  ]);

  return {
    app,
    runner,
    errors,
    conversationId,
    get providerCalls() { return providerCalls; },
    async startPlan() {
      const started = await runner.input({
        commandId: `input-${path.basename(parent)}`,
        conversationId,
        text: '请提交 Plan。'
      });
      await eventually(async () => (await rows(app, 'InteractionRequest', {
        request_kind: 'plan_review',
        status: 'pending'
      })).length === 1, 10_000, 'Plan review did not enter pending state');
      return started;
    },
    async close() {
      runner.dispose();
      await app.close();
      await fs.rm(parent, { recursive: true, force: true });
    }
  };
}

function dependencies(provider, host, options) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: {
            content: JSON.stringify({ providerConfigId: provider.providerId, modelId: 'model-plan-interrupt' })
          },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: {
                providerConfigId: provider.providerId,
                provider: 'fixture',
                modelId: 'model-plan-interrupt',
                retryPolicy: { enabled: false, maxRetries: 0 }
              },
              modelProfile: {
                compressionThresholdTokens: 100_000,
                contextWindowTokens: 128_000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              toolPolicy: {
                id: 'plan-interrupt-tools',
                allowedTools: options.autoApproveInteractions ? ['submit_plan', 'ask_user', 'update_task_list'] : ['submit_plan'],
                preset: 'custom',
                toolConfigs: options.autoApproveInteractions ? {
                  ask_user: { config: { autoApprove: true } },
                  submit_plan: { config: { autoApprove: true } }
                } : {},
                sourceConfigs: {}
              },
              planReviewPolicy: { mode: 'optional' },
              systemPrompt: { id: 'plan-interrupt-prompt', text: '' },
              runtimeContext: { id: null, name: '', template: '' },
              workEnvironmentPolicy: {
                id: null,
                enabled: false,
                allowedWorkEnvironmentIds: [],
                defaultWorkEnvironmentId: null
              }
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
      async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; }
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
        if (providerId !== provider.providerId) throw new Error(`Unexpected provider ${providerId}.`);
        return provider;
      }
    },
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) =>
      new kernel.ReliableToolDispatcher({
        database,
        contentStore,
        effects: runtime.effects,
        files,
        fileMutations,
        processes,
        mcp,
        interactions,
        host
      })
  };
}

async function assertInterrupted(harness, turnId, timeoutMs = 8_000) {
  await eventually(async () => {
    const turns = await rows(harness.app, 'Turn', { id: turnId });
    return turns[0]?.status === 'terminated';
  }, timeoutMs, `Turn ${turnId} did not terminate`);
  const [terminations, leases, requests, calls, operations, pauses, artifacts] = await Promise.all([
    rows(harness.app, 'TurnTermination', { turn_id: turnId }),
    rows(harness.app, 'ExecutionLease', { turn_id: turnId }),
    rows(harness.app, 'InteractionRequest', { request_kind: 'plan_review' }),
    rows(harness.app, 'ToolCall', { turn_id: turnId }),
    rows(harness.app, 'Operation'),
    rows(harness.app, 'OutcomePause'),
    rows(harness.app, 'ToolResultArtifact')
  ]);
  assert.equal(terminations[0]?.terminal_status, 'interrupted');
  assert.deepEqual(leases, []);
  assert.equal(requests[0]?.status, 'cancelled');
  assert.ok(calls.length > 0 && calls.every((call) => call.status === 'terminal'));
  assert.ok(operations.filter((operation) => operation.tool_call_id).every((operation) => operation.status === 'cancelled'));
  assert.ok(pauses.every((pause) => pause.status === 'resolved'));
  assert.equal(artifacts.length, 1);
  const [metadata] = await rows(harness.app, 'ContentObject', { id: artifacts[0].content_object_id });
  const artifact = JSON.parse((await harness.app.contentStore.read(metadata)).toString('utf8'));
  assert.equal(artifact.status, 'cancelled');
  assert.equal(artifact.detail?.kind, 'submit_plan.result');
  assert.equal(artifact.detail?.status, 'cancelled');
}

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 100
  }))).snapshot;
}

async function eventually(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(20);
  }
  throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function modelContent(toolCalls) {
  return {
    role: 'model',
    parts: toolCalls.map((call) => ({
      id: call.id,
      functionCall: { name: call.name, args: call.arguments }
    }))
  };
}
