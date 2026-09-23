import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const require = createRequire(import.meta.url);
const kernel = require('../../dist/extension/backend/reliableKernel/index.js');
const { askUserTool } = require('../../dist/extension/backend/world/modules/tools/definitions/askUser/index.js');
const { submitPlanTool } = require('../../dist/extension/backend/world/modules/tools/definitions/submitPlan/index.js');
const { BACKGROUND_ASK_USER_AUTO_ANSWER } = require('../../dist/extension/shared/askUser.js');
const { CHILD_PLAN_AUTO_APPROVAL_MESSAGE } = require('../../dist/extension/shared/planReview.js');
const { frozenInteractionAutoApproval } = require('../../dist/extension/backend/reliableKernel/frozenAuthority.js');

const ASK_ARGS = {
  question: '请选择实现方式。',
  options: [{ label: '最小修改' }, { label: '重构模块' }]
};
const PLAN_ARGS = {
  plan: '检查现有实现，做最小修改并验证。',
  taskList: {
    mode: 'rewrite',
    items: [{ title: '验证最小修改', description: '检查交互终态。', status: 'pending', delete: false }]
  }
};
const AUTO_ANSWER = { answer: { selectedOptionIndexes: [], customText: BACKGROUND_ASK_USER_AUTO_ANSWER } };
const guardedTool = {
  declaration: {
    name: 'guarded_action',
    description: 'Requires separate execution approval.',
    parameters: { type: 'object', properties: {} },
    metadata: { riskLevel: 'write', readonly: false, defaultAutoApproveExecution: false, defaultAutoSubmitResult: true }
  },
  scheduling: () => ({ mode: 'serial', reason: 'guarded_action' })
};

test('自动审批只接受明确的布尔 true，YOLO 和执行审批不隐式开启交互审批', () => {
  for (const toolName of ['ask_user', 'submit_plan']) {
    for (const value of [undefined, null, false, 'true', 1, true]) {
      const document = {
        toolPolicy: {
          preset: 'yolo', allowedTools: [toolName],
          toolConfigs: { [toolName]: { autoApproveExecution: true, config: value === undefined ? {} : { autoApprove: value } } }
        }
      };
      assert.equal(frozenInteractionAutoApproval(document, toolName), value === true);
      document.toolPolicy.allowedTools = [];
      assert.equal(frozenInteractionAutoApproval(document, toolName), false);
    }
    assert.equal(frozenInteractionAutoApproval({}, toolName), false);
  }
});

for (const toolName of ['ask_user', 'submit_plan']) {
  test(toolName + ' 默认仍等待人工响应，开启另一个工具不影响它', async () => {
    const otherTool = toolName === 'ask_user' ? 'submit_plan' : 'ask_user';
    const harness = await createHarness({ toolConfigs: { [otherTool]: { config: { autoApprove: true } } } });
    try {
      const input = await harness.createTool(toolName);
      const result = await harness.app.toolDispatcher.dispatch(input);
      assert.equal(result.disposition, 'paused');
      assert.equal(result.reason, toolName === 'ask_user' ? 'awaiting_user' : 'awaiting_plan_review');
      assert.equal((await rows(harness.app, 'InteractionResponse')).length, 0);
      assert.equal((await rows(harness.app, 'InteractionRequest'))[0].status, 'pending');
    } finally {
      await harness.close();
    }
  });

  test(toolName + ' 显式开启后持久化自动响应，重放不重复审批', async () => {
    const harness = await createHarness({ toolConfigs: { [toolName]: { config: { autoApprove: true } } } });
    try {
      const input = await harness.createTool(toolName);
      const result = await harness.app.toolDispatcher.dispatch(input);
      assert.equal(result.status, 'succeeded');
      const [request] = await rows(harness.app, 'InteractionRequest');
      assert.equal(request.status, 'succeeded');
      const response = await responseBody(harness.app, request.id);
      if (toolName === 'ask_user') {
        assert.deepEqual(response.response, AUTO_ANSWER);
        const artifact = await artifactBody(harness.app, input.toolCallId);
        assert.deepEqual(artifact.detail, {
          kind: 'ask_user.result', question: ASK_ARGS.question, multiple: false,
          selectedOptions: [], customText: BACKGROUND_ASK_USER_AUTO_ANSWER
        });
      } else {
        assert.equal(response.decision, 'accept');
        assert.equal(response.output.status, 'approved');
        assert.equal((await rows(harness.app, 'ChildExecution')).length, 0);
        const artifact = await artifactBody(harness.app, input.toolCallId);
        assert.equal(artifact.detail.executionTarget, 'current_conversation');
      }
      assert.equal((await harness.app.toolDispatcher.dispatch(input)).status, 'succeeded');
      assert.equal((await rows(harness.app, 'InteractionResponse')).length, 1);
      assert.equal((await rows(harness.app, 'OperationResolution')).length, 1);
      assert.equal((await rows(harness.app, 'ToolOutcome')).length, 1);
    } finally {
      await harness.close();
    }
  });

  test(toolName + ' 已落盘但尚未回复的等待可按冻结设置恢复', async () => {
    const harness = await createHarness({ toolConfigs: { [toolName]: { config: { autoApprove: true } } } });
    try {
      const input = await harness.createTool(toolName);
      const pause = await pauseInteraction(harness.app, input);
      const dispatcher = new kernel.ReliableToolDispatcher(harness.dispatcherDependencies);
      assert.equal((await dispatcher.dispatch(input)).status, 'succeeded');
      assert.equal((await rows(harness.app, 'InteractionRequest')).length, 1);
      assert.ok(await responseBody(harness.app, pause.requestId));
    } finally {
      await harness.close();
    }
  });

  test(toolName + ' 不允许无授权的内部自动响应', async () => {
    const harness = await createHarness();
    try {
      const input = await harness.createTool(toolName);
      const pause = await pauseInteraction(harness.app, input);
      await assert.rejects(resolveAutomatic(harness.app, toolName, pause.requestId), /自动|internal|内部|source/i);
      assert.equal((await rows(harness.app, 'InteractionResponse')).length, 0);
    } finally {
      await harness.close();
    }
  });

  test(toolName + ' 人工取消先到时不会被自动响应覆盖', async () => {
    const harness = await createHarness({ toolConfigs: { [toolName]: { config: { autoApprove: true } } } });
    try {
      const input = await harness.createTool(toolName);
      const pause = await pauseInteraction(harness.app, input);
      await resolveManually(harness.app, toolName, pause.requestId);
      assert.equal((await harness.app.toolDispatcher.dispatch(input)).status, 'cancelled');
      const automatic = await resolveAutomatic(harness.app, toolName, pause.requestId);
      assert.equal(automatic.won, false);
      assert.equal((await rows(harness.app, 'InteractionResponse')).length, 1);
      assert.equal((await rows(harness.app, 'InteractionRequest'))[0].status, 'cancelled');
    } finally {
      await harness.close();
    }
  });

  test(toolName + ' 人工取消与自动响应并发时只有一个持久结果', async () => {
    const harness = await createHarness({ toolConfigs: { [toolName]: { config: { autoApprove: true } } } });
    try {
      const input = await harness.createTool(toolName);
      const pause = await pauseInteraction(harness.app, input);
      const results = await Promise.all([
        resolveAutomatic(harness.app, toolName, pause.requestId),
        resolveManually(harness.app, toolName, pause.requestId)
      ]);
      assert.equal(results.filter((result) => result.won).length, 1);
      assert.equal((await rows(harness.app, 'InteractionResponse')).length, 1);
      assert.equal((await rows(harness.app, 'OperationResolution')).length, 1);
      assert.equal((await rows(harness.app, 'ToolOutcome')).length, 1);
    } finally {
      await harness.close();
    }
  });
}

test('自动回应 Ask 不允许内部来源代选具体答案或取消问题', async () => {
  const harness = await createHarness({ toolConfigs: { ask_user: { config: { autoApprove: true } } } });
  try {
    const pause = await pauseInteraction(harness.app, await harness.createTool('ask_user'));
    for (const extra of [
      { response: { answer: { selectedOptionIndexes: [0] } } },
      { response: AUTO_ANSWER, cancelled: true }
    ]) {
      await assert.rejects(harness.app.interactions.resolveAskUser({
        source: { kind: 'internal', key: 'forged-ask-response' },
        requestId: pause.requestId,
        ...extra
      }), /自动|内部/);
    }
    assert.equal((await rows(harness.app, 'InteractionResponse')).length, 0);
  } finally {
    await harness.close();
  }
});

test('自动批准 Plan 不允许内部来源委派新 Agent 或拒绝计划', async () => {
  const harness = await createHarness({ toolConfigs: { submit_plan: { config: { autoApprove: true } } } });
  try {
    const pause = await pauseInteraction(harness.app, await harness.createTool('submit_plan'));
    for (const extra of [
      { decision: 'accept', response: { executionTarget: 'new_conversation', agentType: 'main' } },
      { decision: 'reject', response: {} }
    ]) {
      await assert.rejects(harness.app.interactions.resolvePlanReview({
        source: { kind: 'internal', key: 'forged-plan-response' },
        requestId: pause.requestId,
        ...extra
      }), /自动|内部/);
    }
    assert.equal((await rows(harness.app, 'InteractionResponse')).length, 0);
  } finally {
    await harness.close();
  }
});

test('子 Agent 原有 Plan 自动批准不受默认关闭影响', async () => {
  const harness = await createHarness({ child: true });
  try {
    const input = await harness.createTool('submit_plan');
    assert.equal((await harness.app.toolDispatcher.dispatch(input)).status, 'succeeded');
    const artifact = await artifactBody(harness.app, input.toolCallId);
    assert.equal(artifact.detail.userMessage, CHILD_PLAN_AUTO_APPROVAL_MESSAGE);
  } finally {
    await harness.close();
  }
});

test('Ask/Plan 自动审批不启用被禁用工具，也不绕过其它执行审批', async () => {
  const harness = await createHarness({
    allowedTools: ['submit_plan', 'guarded_action'],
    toolConfigs: {
      ask_user: { config: { autoApprove: true } },
      submit_plan: { config: { autoApprove: true } }
    }
  });
  try {
    const denied = await harness.app.toolDispatcher.dispatch(await harness.createTool('ask_user'));
    assert.equal(denied.status, 'rejected');
    const guarded = await harness.app.toolDispatcher.dispatch(await harness.createTool('guarded_action'));
    assert.equal(guarded.reason, 'awaiting_approval');
    assert.equal((await rows(harness.app, 'InteractionResponse')).length, 0);
  } finally {
    await harness.close();
  }
});

test('工具页顶部显示两个独立开关，保存复用现有策略且保留其它工具设置', async () => {
  const { createSSRApp } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const pinia = await import('pinia');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const messages = [];
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout,
    acquireVsCodeApi() { return { postMessage(message) { messages.push(structuredClone(message)); }, getState() {}, setState() {} }; }
  };
  const server = await createWebviewSsrServer();
  try {
    const { default: editor } = await server.ssrLoadModule('/src/components/settings/tools/ToolPolicyEditor.vue');
    const { useClientStateStore } = await server.ssrLoadModule('/src/stores/useClientStateStore.ts');
    const { useToolPolicyStore } = await server.ssrLoadModule('/src/stores/useToolPolicyStore.ts');
    const activePinia = pinia.createPinia();
    pinia.setActivePinia(activePinia);
    const client = useClientStateStore();
    client.toolDefinitions = [askUserTool.declaration, submitPlanTool.declaration, guardedTool.declaration];
    const store = useToolPolicyStore();
    const allowedTools = client.toolDefinitions.map((tool) => tool.name);
    const preserved = { config: {}, autoApproveExecution: false, display: { autoExpand: false } };
    store.setPolicyForScope('global', undefined, allowedTools, 'Global', { guarded_action: preserved });
    const render = async (readonly = false) => renderToString(createSSRApp(editor, { scopeKind: 'global', readonly }).use(activePinia));
    let html = await render();
    const button = (label) => html.match(new RegExp('<button[^>]*aria-label="' + label + '"[^>]*>'))?.[0];
    assert.ok(html.indexOf('aria-label="无人值守审批"') < html.indexOf('aria-label="工具策略预设"'));
    assert.match(button('自动批准 Plan'), /aria-checked="false"/);
    assert.match(button('自动回应 Ask'), /aria-checked="false"/);
    store.setPolicyForScope('global', undefined, allowedTools, 'Global', {
      ...store.effectivePolicyFor('global').policy.toolConfigs,
      ask_user: { config: { autoApprove: true } }
    });
    html = await render();
    assert.match(button('自动批准 Plan'), /aria-checked="false"/);
    assert.match(button('自动回应 Ask'), /aria-checked="true"/);
    assert.deepEqual(store.effectivePolicyFor('global').policy.toolConfigs.guarded_action, preserved);
    assert.equal(messages.at(-1).payload.toolConfigs.ask_user.config.autoApprove, true);
    html = await render(true);
    assert.match(button('自动回应 Ask'), /disabled/);
  } finally {
    pinia.setActivePinia(previousPinia);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  }
});

async function createHarness(options = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-auto-approval-'));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  let dispatcherDependencies;
  const app = await kernel.ReliableKernelApplication.open(authority, {
    authorityCompiler: { async compile() { throw new Error('No live authority compilation in this fixture.'); } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('Unexpected MCP call.'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: false, planReviewAllowed: false }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' }; } },
    providers: { resolve() { throw new Error('No network Provider in this fixture.'); } },
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) => {
      dispatcherDependencies = {
        database, contentStore, effects: runtime.effects, files, fileMutations, processes, mcp, interactions,
        host: { definitions() { return [askUserTool, submitPlanTool, guardedTool]; }, async cancelTurnWaits() {}, async dispose() {} }
      };
      return new kernel.ReliableToolDispatcher(dispatcherDependencies);
    }
  });
  const conversationId = 'conversation-auto-approval';
  const turnId = 'turn-auto-approval';
  const now = new Date().toISOString();
  const frozen = await app.contentStore.prepare(app.database, JSON.stringify({
    planReviewPolicy: { mode: 'optional' },
    toolPolicy: {
      id: 'auto-approval-policy', preset: 'custom',
      allowedTools: options.allowedTools ?? ['ask_user', 'submit_plan', 'guarded_action'],
      toolConfigs: options.toolConfigs ?? {}, sourceConfigs: {}
    }
  }), 'application/json');
  await app.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: conversationId, title: 'Auto approval', status: 'active', created_at: now, updated_at: now }),
    kernel.DOMAIN_REPOSITORIES.domain('Turn').insert({ id: turnId, conversation_id: conversationId, status: 'active', created_at: now, updated_at: now, terminal_at: null }),
    kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
      id: 'lease-auto-approval', conversation_id: conversationId, turn_id: turnId, owner_id: 'auto-approval-test',
      host_boot_id: app.database.hostBootId, generation: 1n, acquired_at: now, expires_at: new Date(Date.now() + 60_000).toISOString()
    }),
    ...kernel.preparedContentSteps([frozen], 'auto_approval_authority'),
    kernel.DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').insert({ id: 'authority-auto-approval', turn_id: turnId, content_object_id: frozen.metadata.id, created_at: now }),
    ...(options.child ? [
      kernel.DOMAIN_REPOSITORIES.domain('ChildExecution').insert({ id: 'child-auto-approval', child_conversation_id: conversationId, status: 'running', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').insert({ id: 'child-turn-auto-approval', child_execution_id: 'child-auto-approval', turn_id: turnId, turn_seq: 1n, created_at: now })
    ] : [])
  ]);
  let sequence = 0;
  return {
    app, dispatcherDependencies,
    async createTool(toolName) {
      const toolCallId = 'auto-approval-call-' + (++sequence);
      const args = toolName === 'ask_user' ? ASK_ARGS : toolName === 'submit_plan' ? PLAN_ARGS : {};
      await app.runtime.effects.createToolCall({ source: { kind: 'internal', key: 'create:' + toolCallId }, toolCallId, turnId, toolName, arguments: args });
      return { turnId, modelRequestId: 'auto-approval-model', toolCallId, toolName, arguments: args };
    },
    async close() {
      await app.close();
      const resolvedParent = await fs.realpath(parent);
      assert.equal(path.dirname(resolvedParent), await fs.realpath(os.tmpdir()));
      await fs.rm(resolvedParent, { recursive: true, force: true });
    }
  };
}

function pauseInteraction(app, input) {
  const base = { source: { kind: 'internal', key: 'pause:' + input.toolCallId }, toolCallId: input.toolCallId };
  return input.toolName === 'ask_user'
    ? app.interactions.pauseForAskUser({ ...base, prompt: input.arguments })
    : app.interactions.pauseForPlanReview({ ...base, request: input.arguments });
}

function resolveAutomatic(app, toolName, requestId) {
  const base = { source: { kind: 'internal', key: 'auto:' + requestId }, requestId };
  return toolName === 'ask_user'
    ? app.interactions.resolveAskUser({ ...base, response: AUTO_ANSWER })
    : app.interactions.resolvePlanReview({ ...base, decision: 'accept', response: { executionTarget: 'current_conversation' } });
}

function resolveManually(app, toolName, requestId) {
  const base = { source: { kind: 'command', key: 'manual:' + requestId }, requestId };
  return toolName === 'ask_user'
    ? app.interactions.resolveAskUser({ ...base, cancelled: true, response: { reason: '用户取消问题。' } })
    : app.interactions.resolvePlanReview({ ...base, decision: 'cancel', response: { message: '用户取消计划。' } });
}

async function responseBody(app, requestId) {
  const [response] = await rows(app, 'InteractionResponse', { request_id: requestId });
  return contentBody(app, response.content_object_id);
}

async function artifactBody(app, toolCallId) {
  const [artifact] = await rows(app, 'ToolResultArtifact', { tool_call_id: toolCallId });
  return contentBody(app, artifact.content_object_id);
}

async function contentBody(app, contentObjectId) {
  const [metadata] = await rows(app, 'ContentObject', { id: contentObjectId });
  return JSON.parse((await app.contentStore.read(metadata)).toString('utf8'));
}

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))).snapshot;
}
