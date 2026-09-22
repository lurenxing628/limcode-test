import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

test('协作设置保持用户默认深度、单项继承和作用域隔离，保存为可克隆的原工具策略', async (t) => {
  const { createServer } = await import('vite');
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
  const server = await createServer({
    configFile: path.join(process.cwd(), 'vite.config.ts'),
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'error'
  });
  try {
    const { default: editor } = await server.ssrLoadModule('/src/components/settings/agent/AgentCollaborationSettings.vue');
    const { default: toolEditor } = await server.ssrLoadModule('/src/components/settings/tools/ToolPolicyEditor.vue');
    const { useClientStateStore } = await server.ssrLoadModule('/src/stores/useClientStateStore.ts');
    const { useToolPolicyStore } = await server.ssrLoadModule('/src/stores/useToolPolicyStore.ts');
    const { GLOBAL_SETTINGS_TABS } = await server.ssrLoadModule('/src/components/settings/global/globalSettingsTabs.ts');
    const { runAgentTool } = await server.ssrLoadModule(path.join(process.cwd(), 'backend/world/modules/tools/definitions/runAgent/index.ts'));
    const { crossConversationToolModules } = await server.ssrLoadModule(path.join(process.cwd(), 'backend/world/modules/tools/definitions/crossConversation/index.ts'));
    const activePinia = pinia.createPinia();
    pinia.setActivePinia(activePinia);
    const client = useClientStateStore();
    client.configurationReady = true;
    client.toolDefinitions = [runAgentTool.declaration, { name: 'read_file', execution: 'backend', parameters: { type: 'object' }, description: 'read', defaultConfig: {} }];
    const store = useToolPolicyStore();
    const render = async (component, props) => renderToString(createSSRApp(component, props).use(activePinia));
    const input = (html, label) => html.match(new RegExp('<input[^>]*aria-label="' + label + '"[^>]*>'))?.[0];

    await t.test('主入口位于全局一级页签，默认 1，预算和深度均不是模型参数', async () => {
      assert.ok(GLOBAL_SETTINGS_TABS.findIndex((tab) => tab.key === 'agent-collaboration') < GLOBAL_SETTINGS_TABS.findIndex((tab) => tab.key === 'tools'));
      for (const [key, value] of Object.entries({ maxChildAgentDepth: 1, maxConcurrentAgents: 8, maxAutomaticFollowups: 32 })) {
        assert.equal(runAgentTool.declaration.defaultConfig[key], value);
        assert.equal(runAgentTool.declaration.parameters.properties[key], undefined);
      }
      const html = await render(editor, { scopeKind: 'global' });
      assert.match(input(html, '最大子 Agent 深度'), /value="1"/);
      assert.doesNotMatch(input(html, '最大子 Agent 深度'), /disabled/);
      assert.match(html, /1（默认）/);
      assert.match(input(html, '团队同时运行的子 Agent 上限'), /min="1"/);
      assert.match(input(html, '每轮任务自动续派上限'), /min="0"/);
      const oldHtml = await render(toolEditor, { scopeKind: 'global' });
      assert.doesNotMatch(oldHtml, /<input[^>]*aria-label="最大子 Agent 深度"/);
      assert.match(oldHtml, /全局设置的「Agent 协作」页/);
      const readonlyHtml = await render(editor, { scopeKind: 'global', readonly: true });
      assert.match(input(readonlyHtml, '最大子 Agent 深度'), /disabled/);
    });

    await t.test('局部调整不复制无关的全局设置，0 覆盖与恢复继承都保留其它策略', async () => {
      store.setPolicyForScope('global', undefined, ['run_agent', 'read_file'], 'Global', {
        run_agent: { config: { maxChildAgentDepth: 1, maxConcurrentAgents: 9 }, nativeAsync: true },
        read_file: { config: { nested: { enabled: true } }, autoApproveExecution: false }
      }, { server: { enabled: true } }, 'yolo');
      store.setAgentCollaborationFieldForScope('agent', 'worker', 'maxChildAgentDepth', 0);
      const local = store.localPolicyFor('agent', 'worker').policy;
      assert.deepEqual(local.toolConfigs, { run_agent: { config: { maxChildAgentDepth: 0 } } });
      assert.equal(local.sourceConfigs, undefined);
      assert.equal(store.effectivePolicyFor('agent', 'worker').policy.toolConfigs.run_agent.config.maxConcurrentAgents, 9);
      assert.equal(store.effectivePolicyFor('agent', 'worker').policy.preset, 'yolo');
      assert.equal(messages.at(-1).payload.scopeId, 'worker');
      assert.equal(messages.at(-1).payload.toolConfigs.run_agent.config.maxChildAgentDepth, 0);

      store.setAgentCollaborationFieldForScope('agent', 'worker', 'maxConcurrentAgents', 4);
      store.setAgentCollaborationFieldForScope('agent', 'worker', 'maxChildAgentDepth', undefined);
      assert.deepEqual(store.localPolicyFor('agent', 'worker').policy.toolConfigs.run_agent.config, { maxConcurrentAgents: 4 });
      assert.equal(store.effectivePolicyFor('agent', 'worker').policy.toolConfigs.run_agent.config.maxChildAgentDepth, 1);
      store.setAgentCollaborationFieldForScope('global', undefined, 'maxChildAgentDepth', 3);
      assert.equal(store.effectivePolicyFor('agent', 'worker').policy.toolConfigs.run_agent.config.maxChildAgentDepth, 3);
      assert.equal(store.effectivePolicyFor('agent', 'worker').policy.toolConfigs.run_agent.config.maxConcurrentAgents, 4);
      assert.equal(store.localPolicyFor('global').policy.toolConfigs.run_agent.nativeAsync, true);
      assert.deepEqual(store.localPolicyFor('global').policy.toolConfigs.read_file, { config: { nested: { enabled: true } }, autoApproveExecution: false });
      assert.deepEqual(store.localPolicyFor('global').policy.sourceConfigs, { server: { enabled: true } });

      store.setAgentCollaborationFieldForScope('conversation', 'conversation-a', 'maxChildAgentDepth', 2);
      store.setAgentCollaborationFieldForScope('conversation', 'conversation-b', 'maxChildAgentDepth', 0);
      assert.equal(store.localPolicyFor('conversation', 'conversation-a').policy.toolConfigs.run_agent.config.maxChildAgentDepth, 2);
      assert.equal(store.localPolicyFor('conversation', 'conversation-b').policy.toolConfigs.run_agent.config.maxChildAgentDepth, 0);
      store.setAgentCollaborationFieldForScope('global', undefined, 'maxChildAgentDepth', undefined);
      const html = await render(editor, { scopeKind: 'global' });
      assert.match(input(html, '最大子 Agent 深度'), /value="1"/);
    });

    await t.test('非法数字和缺少作用域不会发送请求，不自动启用已禁用的工具', async () => {
      const count = messages.length;
      for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => store.setAgentCollaborationFieldForScope('global', undefined, 'maxChildAgentDepth', value), TypeError);
      }
      assert.throws(() => store.setAgentCollaborationFieldForScope('global', undefined, 'maxConcurrentAgents', 0), TypeError);
      store.setAgentCollaborationFieldForScope('conversation', undefined, 'maxChildAgentDepth', 2);
      assert.equal(messages.length, count);
      store.setPolicyForScope('agent', 'disabled', ['read_file'], 'Disabled', { run_agent: { config: {}, autoApproveExecution: false } });
      store.setAgentCollaborationFieldForScope('agent', 'disabled', 'maxChildAgentDepth', 2);
      assert.deepEqual(store.localPolicyFor('agent', 'disabled').policy.allowedTools, ['read_file']);
      assert.equal(store.localPolicyFor('agent', 'disabled').policy.toolConfigs.run_agent.autoApproveExecution, false);
      const html = await render(editor, { scopeKind: 'agent', scopeId: 'disabled' });
      assert.match(html, /调整协作设置不会自动启用工具/);
    });

    await t.test('跨对话协作开关默认关闭，开启时把跨对话工具加入该作用域允许列表，关闭与恢复继承不改动允许列表', async () => {
      const crossTools = crossConversationToolModules.map((module) => module.create({}).declaration);
      const crossNames = crossTools.map((tool) => tool.name);
      client.toolDefinitions = [...client.toolDefinitions, ...crossTools];
      const field = runAgentTool.declaration.configSchema.fields.find((candidate) => candidate.key === 'crossConversationCollaboration');
      assert.equal(field.type, 'boolean');
      assert.equal(field.defaultValue, false);
      assert.equal('crossConversationCollaboration' in runAgentTool.declaration.defaultConfig, false, '只写 defaultValue，不写 defaultConfig');
      assert.equal(runAgentTool.declaration.parameters.properties.crossConversationCollaboration, undefined);
      const checkbox = (html) => html.match(/<button[^>]*aria-label="跨对话协作"[^>]*>/)?.[0];
      assert.match(checkbox(await render(editor, { scopeKind: 'global' })), /aria-checked="false"/);
      assert.doesNotMatch(await render(toolEditor, { scopeKind: 'global' }), /aria-label="跨对话协作"/);

      store.setPolicyForScope('conversation', 'cross-a', ['read_file', 'run_agent'], 'Custom', { run_agent: { config: { maxConcurrentAgents: 3 } } });
      store.setCrossConversationCollaborationForScope('conversation', 'cross-a', true);
      const enabled = store.localPolicyFor('conversation', 'cross-a').policy;
      assert.deepEqual(enabled.toolConfigs.run_agent.config, { maxConcurrentAgents: 3, crossConversationCollaboration: true });
      assert.deepEqual(enabled.allowedTools, ['read_file', 'run_agent', ...crossNames]);
      assert.equal(messages.at(-1).payload.toolConfigs.run_agent.config.crossConversationCollaboration, true);
      assert.deepEqual(messages.at(-1).payload.allowedTools, ['read_file', 'run_agent', ...crossNames]);
      assert.match(checkbox(await render(editor, { scopeKind: 'conversation', scopeId: 'cross-a' })), /aria-checked="true"/);
      assert.equal(store.localPolicyFor('conversation', 'cross-b').policy, undefined, '其它对话作用域不受影响');

      store.setCrossConversationCollaborationForScope('conversation', 'cross-a', false);
      assert.equal(store.localPolicyFor('conversation', 'cross-a').policy.toolConfigs.run_agent.config.crossConversationCollaboration, false);
      assert.deepEqual(store.localPolicyFor('conversation', 'cross-a').policy.allowedTools, ['read_file', 'run_agent', ...crossNames]);
      store.setCrossConversationCollaborationForScope('conversation', 'cross-a', undefined);
      assert.deepEqual(store.localPolicyFor('conversation', 'cross-a').policy.toolConfigs.run_agent.config, { maxConcurrentAgents: 3 });
      assert.throws(() => store.setCrossConversationCollaborationForScope('global', undefined, 'yes'), TypeError);
    });
  } finally {
    pinia.setActivePinia(previousPinia);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  }
});
