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
  // The bridge is a window singleton; each isolated session swaps in its own message list.
  const sink = { messages: [] };
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout,
    acquireVsCodeApi() { return { postMessage(message) { sink.messages.push(structuredClone(message)); }, getState() {}, setState() {} }; }
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
    const crossTools = crossConversationToolModules.map((module) => module.create({}).declaration);
    const crossNames = crossTools.map((tool) => tool.name);
    const readFileTool = { name: 'read_file', execution: 'backend', parameters: { type: 'object' }, description: 'read', defaultConfig: {} };
    const input = (html, label) => html.match(new RegExp('<input[^>]*aria-label="' + label + '"[^>]*>'))?.[0];
    const checkbox = (html) => html.match(/<button[^>]*aria-label="跨对话协作"[^>]*>/)?.[0];

    /** An isolated settings session: its own Pinia, configuration snapshot and posted messages. */
    const fresh = (definitions = [runAgentTool.declaration, readFileTool, ...crossTools]) => {
      const isolated = pinia.createPinia();
      pinia.setActivePinia(isolated);
      sink.messages = [];
      const client = useClientStateStore();
      client.configurationReady = true;
      client.toolDefinitions = definitions;
      return {
        client,
        store: useToolPolicyStore(),
        messages: sink.messages,
        render: (component, props) => renderToString(createSSRApp(component, props).use(isolated)),
        /** The component's own handlers, reached after a server render instead of through the DOM. */
        bindings: async (component, props) => {
          let setupState;
          const app = createSSRApp(component, props).use(isolated);
          app.mixin({ created() { if (this.$.type.__name === component.__name) setupState = this.$.setupState; } });
          await renderToString(app);
          return setupState;
        }
      };
    };

    await t.test('主入口位于全局一级页签，默认 1，预算和深度均不是模型参数', async () => {
      const { render } = fresh();
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
      const { store, messages, render } = fresh();
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
      const { store, messages, render } = fresh();
      for (const value of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => store.setAgentCollaborationFieldForScope('global', undefined, 'maxChildAgentDepth', value), TypeError);
      }
      assert.throws(() => store.setAgentCollaborationFieldForScope('global', undefined, 'maxConcurrentAgents', 0), TypeError);
      store.setAgentCollaborationFieldForScope('conversation', undefined, 'maxChildAgentDepth', 2);
      assert.equal(messages.length, 0);
      store.setPolicyForScope('agent', 'disabled', ['read_file'], 'Disabled', { run_agent: { config: {}, autoApproveExecution: false } });
      store.setAgentCollaborationFieldForScope('agent', 'disabled', 'maxChildAgentDepth', 2);
      assert.deepEqual(store.localPolicyFor('agent', 'disabled').policy.allowedTools, ['read_file']);
      assert.equal(store.localPolicyFor('agent', 'disabled').policy.toolConfigs.run_agent.autoApproveExecution, false);
      const html = await render(editor, { scopeKind: 'agent', scopeId: 'disabled' });
      assert.match(html, /调整协作设置不会自动启用工具/);
    });

    await t.test('工具设置里的单项修改只写本层自己的配置，不把全局配置复制到下层', async () => {
      const shellTool = { name: 'shell', execution: 'backend', parameters: { type: 'object' }, description: 'shell', defaultConfig: {},
        configSchema: { fields: [
          { key: 'timeoutSeconds', label: '超时', type: 'number', defaultValue: 30 },
          { key: 'allowedCommands', label: '允许命令', type: 'stringList', defaultValue: [] }
        ] } };
      const { store, bindings } = fresh([runAgentTool.declaration, readFileTool, shellTool, ...crossTools]);
      store.setPolicyForScope('global', undefined, ['run_agent', 'read_file', ...crossNames], 'Global', {
        run_agent: { config: { crossConversationCollaboration: true, maxConcurrentAgents: 9 } },
        read_file: { config: {}, autoApproveExecution: false }
      }, { server: { enabled: true } });
      store.setPolicyForScope('conversation', 'edits', ['run_agent', 'read_file', 'send_conversation_message'], 'Local', {
        read_file: { config: {}, display: { autoExpand: true } }
      });
      const toolEditorState = await bindings(toolEditor, { scopeKind: 'conversation', scopeId: 'edits' });
      const tool = (name) => store.toolDefinitions.find((candidate) => candidate.name === name);

      toolEditorState.updateGateSetting(tool('send_conversation_message'), 'autoApproveExecution', false);
      let local = store.localPolicyFor('conversation', 'edits').policy;
      assert.deepEqual(local.toolConfigs, {
        read_file: { config: {}, display: { autoExpand: true } },
        send_conversation_message: { config: {}, autoApproveExecution: false }
      }, 'the global switch and the global read_file gate stay in the global layer');
      assert.deepEqual(local.sourceConfigs ?? {}, {}, 'global MCP source settings are not copied down');

      toolEditorState.updateGateSetting(tool('run_agent'), 'autoApproveExecution', false);
      local = store.localPolicyFor('conversation', 'edits').policy;
      assert.deepEqual(local.toolConfigs.run_agent, { config: {}, autoApproveExecution: false },
        'a gate change on run_agent does not freeze the inherited switch or budgets');

      store.setPolicyForScope('global', undefined, store.localPolicyFor('global').policy.allowedTools, 'Global', {
        ...store.localPolicyFor('global').policy.toolConfigs,
        shell: { config: { timeoutSeconds: 60, allowedCommands: ['git'] } }
      }, { server: { enabled: true } });
      const shellField = (key) => shellTool.configSchema.fields.find((field) => field.key === key);
      toolEditorState.updateScalarField(shellTool, shellField('timeoutSeconds'), 90);
      assert.deepEqual(store.localPolicyFor('conversation', 'edits').policy.toolConfigs.shell, { config: { timeoutSeconds: 90 } },
        'a field edit writes only that field; the global command list stays inherited');
      toolEditorState.updateStringListField(shellTool, shellField('allowedCommands'), 'npm\nnode');
      assert.deepEqual(store.localPolicyFor('conversation', 'edits').policy.toolConfigs.shell,
        { config: { timeoutSeconds: 90, allowedCommands: ['npm', 'node'] } });

      store.setAgentCollaborationFieldForScope('global', undefined, 'maxConcurrentAgents', undefined);
      store.setCrossConversationCollaborationForScope('global', undefined, false);
      const effective = store.effectivePolicyFor('conversation', 'edits').policy.toolConfigs.run_agent.config;
      assert.equal(effective.crossConversationCollaboration, false, 'turning the switch off globally reaches this scope');
      assert.equal(effective.maxConcurrentAgents, undefined);
    });

    const writeTool = { name: 'write', execution: 'backend', parameters: { type: 'object' }, description: 'write', defaultConfig: {}, metadata: { riskLevel: 'write' } };
    const transferTool = { name: 'transfer', execution: 'backend', parameters: { type: 'object' }, description: 'transfer', defaultConfig: {}, metadata: { defaultEnabled: false } };
    const mcpTool = { name: 'mcp_search', execution: 'backend', parameters: { type: 'object' }, description: 'mcp', defaultConfig: {}, source: { kind: 'mcp', sourceId: 'exa' } };
    const allDefinitions = [runAgentTool.declaration, readFileTool, writeTool, transferTool, mcpTool, ...crossTools];
    const readonlyList = ['read_file', 'list_conversations', 'read_conversation'];
    const builtinToolPolicies = [
      { id: 'builtin-tool-policy:agent:main', scopeKind: 'agent', scopeId: 'main', allowedTools: ['run_agent', 'read_file', 'write', 'transfer', ...crossNames] },
      { id: 'builtin-tool-policy:agent:explore', scopeKind: 'agent', scopeId: 'explore', allowedTools: readonlyList },
      { id: 'builtin-tool-policy:workflow:builtin:readonly', scopeKind: 'workflow', scopeId: 'builtin:readonly', allowedTools: readonlyList }
    ];
    const sorted = (names) => [...names].sort();
    const switchOn = { run_agent: { config: { crossConversationCollaboration: true } } };

    await t.test('跨对话协作开关只写 defaultValue，默认关闭且不出现在工具设置里', async () => {
      const { render } = fresh();
      const field = runAgentTool.declaration.configSchema.fields.find((candidate) => candidate.key === 'crossConversationCollaboration');
      assert.equal(field.type, 'boolean');
      assert.equal(field.defaultValue, false);
      assert.equal('crossConversationCollaboration' in runAgentTool.declaration.defaultConfig, false, '只写 defaultValue，不写 defaultConfig');
      assert.equal(runAgentTool.declaration.parameters.properties.crossConversationCollaboration, undefined);
      assert.match(checkbox(await render(editor, { scopeKind: 'global' })), /aria-checked="false"/);
      assert.doesNotMatch(await render(toolEditor, { scopeKind: 'global' }), /aria-label="跨对话协作"/);
    });

    await t.test('本层没有工具策略时开启只保存开关，不新建收窄上界，关闭保留开关，恢复继承删除该记录', async () => {
      const { store, messages, render } = fresh(allDefinitions);
      store.setPolicyForScope('global', undefined, ['run_agent', 'read_file', ...crossNames], 'Global');
      store.setCrossConversationCollaborationForScope('conversation', 'plain', true);
      let local = store.localPolicyFor('conversation', 'plain').policy;
      assert.equal(local.allowedTools, undefined, 'the switch does not freeze a tool list for this conversation');
      assert.deepEqual(local.toolConfigs, switchOn);
      assert.equal('allowedTools' in messages.at(-1).payload, false);
      assert.match(checkbox(await render(editor, { scopeKind: 'conversation', scopeId: 'plain' })), /aria-checked="true"/);
      assert.equal(store.localPolicyFor('conversation', 'other').policy, undefined, '其它对话作用域不受影响');

      store.setPolicyForScope('global', undefined, ['run_agent', 'read_file', 'write', ...crossNames], 'Global');
      assert.ok(store.effectivePolicyFor('conversation', 'plain').policy.allowedTools.includes('write'),
        'a tool enabled globally later still reaches the conversation');

      store.setCrossConversationCollaborationForScope('conversation', 'plain', false);
      local = store.localPolicyFor('conversation', 'plain').policy;
      assert.equal(local.allowedTools, undefined);
      assert.deepEqual(local.toolConfigs, { run_agent: { config: { crossConversationCollaboration: false } } });

      store.setCrossConversationCollaborationForScope('conversation', 'plain', undefined);
      assert.equal(store.localPolicyFor('conversation', 'plain').policy, undefined, 'restoring inheritance removes the record the switch created');
      assert.deepEqual(messages.at(-1), { ...messages.at(-1), type: 'toolPolicy.scope.clear', payload: { scopeKind: 'conversation', scopeId: 'plain' } });
      assert.throws(() => store.setCrossConversationCollaborationForScope('global', undefined, 'yes'), TypeError);
    });

    await t.test('全局没有保存策略时开启不写入默认列表，MCP 与默认关闭的工具不被挡住', async () => {
      const { store, messages } = fresh(allDefinitions);
      store.setCrossConversationCollaborationForScope('global', undefined, true);
      const global = store.localPolicyFor('global').policy;
      assert.equal(global.allowedTools, undefined, 'no global ceiling is written as a side effect');
      assert.deepEqual(global.toolConfigs, switchOn);
      assert.equal('allowedTools' in messages.at(-1).payload, false);
      assert.deepEqual(sorted(store.effectivePolicyFor('agent', 'main').policy.allowedTools), sorted(builtinToolPolicies[0].allowedTools).filter((name) => name !== 'transfer'),
        'the global view keeps showing the default list');

      store.setCrossConversationCollaborationForScope('global', undefined, undefined);
      assert.equal(store.localPolicyFor('global').policy, undefined, 'restoring the default removes the switch-only global record');
      assert.deepEqual(messages.at(-1).payload, { scopeKind: 'global' });
      assert.equal(messages.at(-1).type, 'toolPolicy.scope.clear');
    });

    await t.test('内置只读 Agent 和工作流开启后不获得写工具，只增加读取类对话工具', async () => {
      const { client, store, render } = fresh(allDefinitions);
      client.builtinToolPolicies = builtinToolPolicies;
      store.setPolicyForScope('global', undefined, ['run_agent', 'read_file', 'write', ...crossNames], 'Global');
      assert.deepEqual(store.effectivePolicyFor('agent', 'explore').policy.allowedTools, sorted(readonlyList),
        'the settings view shows the built-in read-only list, not the global one');

      store.setCrossConversationCollaborationForScope('agent', 'explore', true);
      assert.equal(store.localPolicyFor('agent', 'explore').policy.allowedTools, undefined, 'the built-in read-only list stays in force');
      assert.deepEqual(store.effectivePolicyFor('agent', 'explore').policy.allowedTools, sorted(readonlyList));
      const html = await render(editor, { scopeKind: 'agent', scopeId: 'explore' });
      assert.match(checkbox(html), /aria-checked="true"/);
      assert.match(html, /只提供列出和读取对话/);
      assert.doesNotMatch(html, /上层工具策略/);

      store.setCrossConversationCollaborationForScope('workflow', 'builtin:readonly', true);
      assert.equal(store.localPolicyFor('workflow', 'builtin:readonly').policy.allowedTools, undefined);
      assert.deepEqual(store.effectivePolicyFor('workflow', 'builtin:readonly').policy.allowedTools, sorted(readonlyList));

      store.setPolicyForScope('agent', 'reader', ['read_file'], 'Reader');
      store.setCrossConversationCollaborationForScope('agent', 'reader', true);
      assert.deepEqual(store.localPolicyFor('agent', 'reader').policy.allowedTools, ['read_file', 'list_conversations', 'read_conversation'],
        'a scope without run_agent gains only the read-type tools');
      store.setCrossConversationCollaborationForScope('agent', 'reader', false);
      assert.deepEqual(store.localPolicyFor('agent', 'reader').policy.allowedTools, ['read_file']);
    });

    await t.test('扩展已有允许列表，关闭或恢复继承只移除开关加入的工具', async () => {
      const { store, messages } = fresh(allDefinitions);
      store.setPolicyForScope('conversation', 'custom', ['read_file', 'run_agent', 'list_conversations'], 'Custom', { run_agent: { config: { maxConcurrentAgents: 3 } } });
      store.setCrossConversationCollaborationForScope('conversation', 'custom', true);
      const added = ['read_conversation', 'send_conversation_message', 'create_conversation', 'fork_conversation'];
      let local = store.localPolicyFor('conversation', 'custom').policy;
      assert.deepEqual(local.allowedTools, ['read_file', 'run_agent', 'list_conversations', ...added]);
      assert.deepEqual(local.toolConfigs.run_agent.config, { maxConcurrentAgents: 3, crossConversationCollaboration: true });
      assert.deepEqual(messages.at(-1).payload.allowedTools, local.allowedTools);

      store.setCrossConversationCollaborationForScope('conversation', 'custom', false);
      local = store.localPolicyFor('conversation', 'custom').policy;
      assert.deepEqual(local.allowedTools, ['read_file', 'run_agent', 'list_conversations'], 'a tool the user had before stays');
      assert.equal(local.toolConfigs.run_agent.config.crossConversationCollaboration, false);

      store.setCrossConversationCollaborationForScope('conversation', 'custom', true);
      // A later manual edit of the list keeps only the additions the user did not remove.
      store.setPolicyForScope('conversation', 'custom', store.localPolicyFor('conversation', 'custom').policy.allowedTools
        .filter((name) => name !== 'create_conversation'), undefined, store.localPolicyFor('conversation', 'custom').policy.toolConfigs);
      store.setCrossConversationCollaborationForScope('conversation', 'custom', undefined);
      local = store.localPolicyFor('conversation', 'custom').policy;
      assert.deepEqual(local.allowedTools, ['read_file', 'run_agent', 'list_conversations']);
      assert.deepEqual(local.toolConfigs.run_agent.config, { maxConcurrentAgents: 3 }, 'the record keeps the user’s own settings');
    });

    await t.test('只改审批、预设或协作上限时不给本层新建工具列表，内置只读 Agent 仍保持只读', async () => {
      const { client, store, bindings } = fresh(allDefinitions);
      client.builtinToolPolicies = builtinToolPolicies;
      store.setPolicyForScope('global', undefined, ['run_agent', 'read_file', 'write', ...crossNames], 'Global', {
        read_file: { config: {}, autoApproveExecution: false }
      });
      const explore = await bindings(toolEditor, { scopeKind: 'agent', scopeId: 'explore' });
      explore.updateGateSetting(store.toolDefinitions.find((tool) => tool.name === 'read_file'), 'autoApproveExecution', true);
      assert.equal(store.localPolicyFor('agent', 'explore').policy.allowedTools, undefined);
      assert.deepEqual(store.effectivePolicyFor('agent', 'explore').policy.allowedTools, sorted(readonlyList));

      store.setPolicyPresetForScope('conversation', 'preset-only', 'yolo');
      const preset = store.localPolicyFor('conversation', 'preset-only').policy;
      assert.equal(preset.allowedTools, undefined);
      assert.deepEqual(preset.toolConfigs, {}, 'a preset change does not copy the global per-tool settings down');

      store.setAgentCollaborationFieldForScope('agent', 'worker', 'maxChildAgentDepth', 0);
      assert.equal(store.localPolicyFor('agent', 'worker').policy.allowedTools, undefined);
      store.setAgentCollaborationFieldForScope('agent', 'worker', 'maxChildAgentDepth', undefined);
      assert.equal(store.localPolicyFor('agent', 'worker').policy, undefined, 'restoring the only override removes the empty record');
    });

    await t.test('上层允许列表仍挡住跨对话工具时显示提示', async () => {
      const { store, render } = fresh(allDefinitions);
      store.setPolicyForScope('global', undefined, ['run_agent', 'read_file'], 'Global');
      store.setCrossConversationCollaborationForScope('conversation', 'blocked', true);
      assert.match(await render(editor, { scopeKind: 'conversation', scopeId: 'blocked' }), /上层工具策略/);
      store.setPolicyForScope('global', undefined, ['run_agent', 'read_file', ...crossNames], 'Global');
      assert.doesNotMatch(await render(editor, { scopeKind: 'conversation', scopeId: 'blocked' }), /上层工具策略/);
    });
  } finally {
    pinia.setActivePinia(previousPinia);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  }
});
