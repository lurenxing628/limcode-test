import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const requireCompiled = createRequire(import.meta.url);
const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
class Uri {
  constructor(value) { this.scheme = 'file'; this.fsPath = path.resolve(value); this.path = this.fsPath; }
  static file(value) { return new Uri(value); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.path}`; }
}
const vscodeStub = { Uri, FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 }, workspace: { fs: {
  createDirectory: uri => fs.mkdir(uri.fsPath, { recursive: true }), readFile: uri => fs.readFile(uri.fsPath),
  async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
  async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map(item => [item.name, item.isDirectory() ? 2 : 1]); },
  delete: uri => fs.rm(uri.fsPath, { recursive: true, force: true }),
  async stat(uri) { const stat = await fs.stat(uri.fsPath); return { type: stat.isDirectory() ? 2 : 1, size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs }; }
} } };

/**
 * The real configuration authority behind the settings page: what the page posts is saved by the
 * production mutations and compiled exactly as a Turn would freeze it.
 */
async function withBackendSettings(run) {
  const Module = requireCompiled('node:module');
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) { return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, parent, isMain); };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-settings-roundtrip-'));
  try {
    const load = file => requireCompiled(path.join(compiledRoot, file));
    const { VscodeConfigurationAuthority } = load('backend/reliableKernel/vscodeConfigurationAuthority.js');
    const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');
    const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
    const { createBuiltinToolDefinitions } = load('backend/world/modules/tools/definitions/index.js');
    const { commandDeclarationCapability } = load('backend/reliableKernel/builtinToolCatalog.js');
    const { toolDefinitionRecord } = load('backend/world/modules/tools/registry.js');
    const { toolAllowedByPolicy } = load('shared/toolPolicyResolution.js');
    const configuration = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(root)));
    const save = async (section, settings) => configuration.saveGlobalSettings(section, settings, (await configuration.loadGlobalSettings(section)).revision);
    const provider = { ...createDefaultLlmProviderConfig({ name: 'settings round trip' }), id: 'provider:settings-round-trip',
      model: 'model:settings-round-trip', models: [{ id: 'model:settings-round-trip', name: 'model' }], modelConfigs: [] };
    await save('llmProviderConfigs', { configs: [provider] });
    await save('llm', { activeProviderConfigId: provider.id });
    let turn = 0;
    await run({
      configuration,
      toolAllowedByPolicy,
      /** The real tool catalog, plus MCP tools as a connected server declares them. */
      toolDefinitions: (...mcp) => [...createBuiltinToolDefinitions({ command: commandDeclarationCapability() }).map(toolDefinitionRecord), ...mcp],
      compile: async (executorAgentId, conversationId) => JSON.parse((await configuration.compile({
        conversationId, turnId: `turn:${conversationId}:${turn++}`, executorAgentId, intentKind: 'input'
      })).authoritySnapshot.content).toolPolicy,
      /** Loads the saved configuration into the page's client state, as the bridge snapshot does. */
      async sync(client) {
        const state = await configuration.configurationClientState();
        for (const key of ['agents', 'workflows', 'toolPolicies', 'toolPolicyScopeLinks', 'builtinToolPolicies', 'conversationWorkflowSelections']) client[key] = state[key];
      },
      /** Saves what the page posted through the production mutations. */
      async apply(message) {
        if (message.type === 'toolPolicy.scope.set') await configuration.mutations.setToolPolicy(message.payload);
        else if (message.type === 'toolPolicy.scope.clear') await configuration.mutations.clearToolPolicy(message.payload.scopeKind, message.payload.scopeId);
        else assert.fail(`unexpected settings message ${message.type}`);
      }
    });
  } finally {
    Module._load = originalLoad;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('协作设置保持用户默认深度、单项继承和作用域隔离，保存为可克隆的原工具策略', async (t) => {
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
  const server = await createWebviewSsrServer();
  try {
    const { default: editor } = await server.ssrLoadModule('/src/components/settings/agent/AgentCollaborationSettings.vue');
    const { default: toolEditor } = await server.ssrLoadModule('/src/components/settings/tools/ToolPolicyEditor.vue');
    const { useClientStateStore } = await server.ssrLoadModule('/src/stores/useClientStateStore.ts');
    const { useToolPolicyStore } = await server.ssrLoadModule('/src/stores/useToolPolicyStore.ts');
    const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
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
        feed: useReliableKernelClientFeedStore(),
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
      assert.deepEqual(sorted(store.effectivePolicyFor('global').policy.allowedTools), sorted(['run_agent', 'read_file', 'write', ...crossNames]),
        'the global view shows the default tool set: no MCP tools and nothing that is off by default');

      store.setCrossConversationCollaborationForScope('global', undefined, undefined);
      assert.equal(store.localPolicyFor('global').policy, undefined, 'restoring the default removes the switch-only global record');
      assert.deepEqual(messages.at(-1).payload, { scopeKind: 'global' });
      assert.equal(messages.at(-1).type, 'toolPolicy.scope.clear');
    });

    await t.test('没有任何工具列表时按默认工具集显示，内置 Agent 按自己的列表显示，和后端编译一致', async () => {
      const { client, feed, store } = fresh(allDefinitions);
      client.builtinToolPolicies = builtinToolPolicies;
      const defaultToolSet = sorted(['run_agent', 'read_file', 'write', ...crossNames]);
      feed.records = { AgentConversationLink: {
        custom: { id: 'custom', conversation_id: 'custom-conversation', agent_id: 'agent:custom', role: 'default' },
        main: { id: 'main', conversation_id: 'main-conversation', agent_id: 'main', role: 'default' }
      } };
      store.setCrossConversationCollaborationForScope('global', undefined, true);
      assert.equal(store.localPolicyFor('global').policy.allowedTools, undefined);
      assert.deepEqual(store.effectivePolicyFor('conversation', 'custom-conversation').policy.allowedTools, defaultToolSet,
        'a custom Agent under a list-less global record gets the default tool set');
      assert.deepEqual(store.crossConversationToolsFor('conversation', 'custom-conversation').missing, []);
      assert.deepEqual(store.effectivePolicyFor('agent', 'main').policy.allowedTools, sorted(builtinToolPolicies[0].allowedTools),
        'the main Agent keeps transfer from its built-in list while global saves no list');
      assert.deepEqual(store.effectivePolicyFor('conversation', 'main-conversation').policy.allowedTools, sorted(builtinToolPolicies[0].allowedTools));

      // A hand-edited global list that is not an array of names shows nothing enabled, as the backend refuses to compile it.
      client.toolPolicies = client.toolPolicies.map((policy) => policy.id === 'tool-policy:global:global' ? { ...policy, allowedTools: null } : policy);
      assert.deepEqual(store.effectivePolicyFor('conversation', 'custom-conversation').policy.allowedTools, []);
      assert.deepEqual(store.effectivePolicyFor('agent', 'main').policy.allowedTools, []);
    });

    await t.test('手工写坏的工具列表在设置页显示为无效，重置前不能改工具开关，协作提示也不指向上层', async () => {
      const { default: mcpTab } = await server.ssrLoadModule('/src/components/settings/global/McpToolSettingsTab.vue');
      const { client, feed, store, bindings, render, messages } = fresh(allDefinitions);
      client.builtinToolPolicies = builtinToolPolicies;
      client.mcpToolSources = [{ id: 'exa', name: 'exa', transportKind: 'stdio', status: 'connected', toolCount: 1 }];
      feed.records = { AgentConversationLink: { link: { id: 'link', conversation_id: 'below', agent_id: 'agent:custom', role: 'default' } } };
      const tool = (name) => store.toolDefinitions.find((candidate) => candidate.name === name);
      for (const malformed of [null, 'read_file']) {
        client.toolPolicies = [{ id: 'tool-policy:global:global', name: 'Global', allowedTools: malformed, toolConfigs: switchOn }];
        client.toolPolicyScopeLinks = [{ id: 'tool-policy-scope:global:global', scopeKind: 'global', toolPolicyId: 'tool-policy:global:global', role: 'active', createdAt: 1, updatedAt: 1 }];
        messages.length = 0;
        assert.match(await render(toolEditor, { scopeKind: 'global' }), /此范围保存的工具列表无效/, `${JSON.stringify(malformed)} is reported`);
        const page = await bindings(toolEditor, { scopeKind: 'global' });
        page.setToolEnabled(tool('read_file'), true);
        page.setToolEnabled(tool('write'), true);
        page.enableAll();
        page.disableAll();
        page.updateGateSetting(tool('read_file'), 'autoApproveExecution', false);
        (await bindings(mcpTab, {})).setToolGlobalEnabled(tool('mcp_search'), true);
        assert.throws(() => store.listSeedFor('global'), /无效/);
        assert.throws(() => store.setCrossConversationCollaborationForScope('global', undefined, false), /无效/);
        assert.throws(() => store.setAgentCollaborationFieldForScope('global', undefined, 'maxChildAgentDepth', 2), /无效/);
        assert.throws(() => store.setPolicyPresetForScope('global', undefined, 'yolo'), /无效/);
        assert.deepEqual(messages, [], 'nothing rewrites the stored value until it is reset');
        assert.equal(store.localPolicyFor('global').policy.allowedTools, malformed);

        const collaboration = await render(editor, { scopeKind: 'global' });
        assert.match(collaboration, /此范围保存的工具列表无效/);
        assert.doesNotMatch(collaboration, /上层工具策略/, 'the note does not blame an upper layer');
        assert.doesNotMatch(collaboration, /不含 run_agent/);
        assert.match(await render(toolEditor, { scopeKind: 'conversation', scopeId: 'below' }), /全局保存的工具列表无效/, 'a scope below names the layer to fix');
        assert.match(await render(editor, { scopeKind: 'conversation', scopeId: 'below' }), /全局保存的工具列表无效/);
        // A scope below the invalid list cannot change its tool switches either: a click saves nothing
        // (a refusal may also throw the same note).
        const below = await bindings(toolEditor, { scopeKind: 'conversation', scopeId: 'below' });
        const refused = (action) => { try { action(); } catch (error) { assert.match(error.message, /无效/); } };
        refused(() => below.setToolEnabled(tool('read_file'), false));
        refused(() => below.setToolEnabled(tool('write'), true));
        refused(() => below.enableAll());
        refused(() => below.disableAll());
        assert.deepEqual(messages, [], 'nothing is saved below the invalid list until it is reset');
        assert.equal(store.localPolicyFor('conversation', 'below').policy, undefined);
      }

      // 继承默认 resets the list and keeps the rest; list edits work again from the default set.
      (await bindings(toolEditor, { scopeKind: 'global' })).inheritDefaults();
      assert.equal('allowedTools' in messages.at(-1).payload, false);
      assert.equal(store.localPolicyFor('global').policy.allowedTools, undefined);
      assert.deepEqual(store.localPolicyFor('global').policy.toolConfigs, switchOn);
      (await bindings(toolEditor, { scopeKind: 'global' })).setToolEnabled(tool('write'), false);
      assert.deepEqual(sorted(store.localPolicyFor('global').policy.allowedTools), sorted(['run_agent', 'read_file', 'transfer', ...crossNames]));
    });

    await t.test('全局“继承默认”只去掉全局工具列表，保留开关、审批与 MCP 来源设置', async () => {
      const { client, store, bindings, render, messages } = fresh(allDefinitions);
      client.builtinToolPolicies = builtinToolPolicies;
      const inheritButton = (html) => html.match(/<button[^>]*>继承默认<\/button>/)?.[0];
      store.setCrossConversationCollaborationForScope('global', undefined, true);
      let global = await bindings(toolEditor, { scopeKind: 'global' });
      assert.equal(global.canRestoreDefault, false, 'a global record without a list already uses the default tool set');
      assert.match(inheritButton(await render(toolEditor, { scopeKind: 'global' })), /disabled/);

      store.setPolicyForScope('global', undefined, ['run_agent', 'read_file'], 'Global', {
        ...switchOn, read_file: { config: {}, autoApproveExecution: false }
      }, { exa: { enabled: true, disabledTools: ['mcp_search'] } }, 'yolo');
      global = await bindings(toolEditor, { scopeKind: 'global' });
      assert.equal(global.canRestoreDefault, true);
      global.inheritDefaults();
      const saved = store.localPolicyFor('global').policy;
      assert.equal(saved.allowedTools, undefined, 'the global ceiling is dropped instead of writing the default list');
      assert.deepEqual(saved.toolConfigs, { ...switchOn, read_file: { config: {}, autoApproveExecution: false } });
      assert.deepEqual(saved.sourceConfigs, { exa: { enabled: true, disabledTools: ['mcp_search'] } });
      assert.equal(saved.preset, 'yolo');
      assert.equal('allowedTools' in messages.at(-1).payload, false);
      assert.deepEqual(store.effectivePolicyFor('agent', 'main').policy.allowedTools, sorted(builtinToolPolicies[0].allowedTools),
        'the main Agent keeps transfer after 继承默认');
      assert.equal(store.effectivePolicyFor('global').policy.toolConfigs.run_agent.config.crossConversationCollaboration, true);

      // A global record that holds nothing but a list is removed.
      store.dropLocalPolicy('global');
      store.setPolicyForScope('global', undefined, ['read_file'], 'Global');
      (await bindings(toolEditor, { scopeKind: 'global' })).inheritDefaults();
      assert.equal(store.localPolicyFor('global').policy, undefined);
      assert.deepEqual({ type: messages.at(-1).type, payload: messages.at(-1).payload }, { type: 'toolPolicy.scope.clear', payload: { scopeKind: 'global' } });
    });

    await t.test('在没有列表的范围里第一次改工具开关时，不悄悄收走该范围 Agent 现有的工具', async () => {
      const { client, feed, store, bindings } = fresh(allDefinitions);
      client.builtinToolPolicies = builtinToolPolicies;
      const tool = (name) => store.toolDefinitions.find((candidate) => candidate.name === name);
      store.setPolicyForScope('agent', 'porter', ['read_file', 'transfer'], 'Porter');
      const mainBefore = store.effectivePolicyFor('agent', 'main').policy.allowedTools;
      assert.ok(mainBefore.includes('transfer'));

      (await bindings(toolEditor, { scopeKind: 'global' })).setToolEnabled(tool('write'), false);
      const globalList = store.localPolicyFor('global').policy.allowedTools;
      assert.equal(globalList.includes('write'), false);
      assert.deepEqual(store.effectivePolicyFor('agent', 'main').policy.allowedTools, mainBefore.filter((name) => name !== 'write'),
        'the main Agent loses only the tool the user turned off, not transfer from its built-in list');
      assert.deepEqual(store.effectivePolicyFor('agent', 'porter').policy.allowedTools, ['read_file', 'transfer']);
      assert.deepEqual(store.effectivePolicyFor('agent', 'explore').policy.allowedTools, sorted(readonlyList));
      assert.equal(globalList.includes('mcp_search'), false, 'MCP tools stay governed by their source settings');

      const agentScope = fresh(allDefinitions);
      agentScope.client.builtinToolPolicies = builtinToolPolicies;
      (await agentScope.bindings(toolEditor, { scopeKind: 'agent', scopeId: 'main' })).setToolEnabled(agentScope.store.toolDefinitions.find((candidate) => candidate.name === 'read_file'), false);
      assert.deepEqual(sorted(agentScope.store.localPolicyFor('agent', 'main').policy.allowedTools),
        sorted(builtinToolPolicies[0].allowedTools.filter((name) => name !== 'read_file')), 'an Agent scope starts from its built-in list');

      const workflowScope = fresh(allDefinitions);
      workflowScope.client.builtinToolPolicies = builtinToolPolicies;
      (await workflowScope.bindings(toolEditor, { scopeKind: 'workflow', scopeId: 'wf' })).setToolEnabled(workflowScope.store.toolDefinitions.find((candidate) => candidate.name === 'write'), false);
      assert.ok(workflowScope.store.localPolicyFor('workflow', 'wf').policy.allowedTools.includes('transfer'),
        'a workflow bounds every Agent, so it keeps what the built-in Agents have');

      const conversationScope = fresh(allDefinitions);
      conversationScope.feed.records = { AgentConversationLink: { link: { id: 'link', conversation_id: 'plain', agent_id: 'agent:custom', role: 'default' } } };
      (await conversationScope.bindings(toolEditor, { scopeKind: 'conversation', scopeId: 'plain' })).setToolEnabled(conversationScope.store.toolDefinitions.find((candidate) => candidate.name === 'write'), false);
      assert.deepEqual(sorted(conversationScope.store.localPolicyFor('conversation', 'plain').policy.allowedTools),
        sorted(['run_agent', 'read_file', ...crossNames]), 'a custom-Agent conversation starts from the default tool set');

      // An edit to a saved list keeps the entries an upper layer blocks for now.
      store.setPolicyForScope('conversation', 'saved', ['read_file', 'write', 'run_agent'], 'Saved');
      (await bindings(toolEditor, { scopeKind: 'conversation', scopeId: 'saved' })).setToolEnabled(tool('list_conversations'), true);
      assert.deepEqual(sorted(store.localPolicyFor('conversation', 'saved').policy.allowedTools), sorted(['read_file', 'write', 'run_agent', 'list_conversations']));
      assert.ok(feed);
    });

    await t.test('第一次保存全局或工作流列表时，只从其它 Agent 带入默认工具和内置 Agent 的工具，不带入 MCP 工具或手动勾选的工具', async () => {
      const switchTool = { name: 'switch_work_environment', execution: 'backend', parameters: { type: 'object' }, description: 'switch', defaultConfig: {}, metadata: { defaultEnabled: false } };
      const legacyTool = { name: 'legacy_tool', execution: 'backend', parameters: { type: 'object' }, description: 'legacy', defaultConfig: {}, metadata: { defaultEnabled: false } };
      const catalog = [...allDefinitions, switchTool, legacyTool];
      const builtins = builtinToolPolicies.map((record) => record.scopeId === 'main' ? { ...record, allowedTools: [...record.allowedTools, 'switch_work_environment'] } : record);
      const customChain = (...upper) => [{ scopeKind: 'global' }, { scopeKind: 'agent', scopeId: 'agent:custom' }, ...upper];
      for (const [scopeKind, scopeId] of [['global', undefined], ['workflow', 'wf']]) {
        const { client, store, bindings, render } = fresh(catalog);
        client.builtinToolPolicies = builtins;
        // Another Agent's own list holds an MCP tool whose source nobody configured, and a tool that is off by default.
        store.setPolicyForScope('agent', 'agent:other', ['read_file', 'mcp_search', 'legacy_tool'], 'Other');
        const chain = customChain(...(scopeKind === 'workflow' ? [{ scopeKind, scopeId }] : []));
        const before = store.resolveScopes(chain).allowedTools;
        assert.equal(before.includes('mcp_search'), false);
        assert.match(await render(toolEditor, { scopeKind, scopeId }), /没有自己列表的自定义 Agent 也会因此得到 switch_work_environment、transfer。/,
          `${scopeKind} says what its first list adds`);
        (await bindings(toolEditor, { scopeKind, scopeId })).setToolEnabled(store.toolDefinitions.find((tool) => tool.name === 'write'), false);
        const saved = store.localPolicyFor(scopeKind, scopeId).policy.allowedTools;
        for (const name of ['mcp_search', 'legacy_tool']) assert.equal(saved.includes(name), false, `${scopeKind} list must not take ${name} from another Agent`);
        const after = store.resolveScopes(chain);
        assert.deepEqual(sorted(after.allowedTools.filter((name) => !before.includes(name))), ['switch_work_environment', 'transfer'],
          `a list-less custom Agent under the first ${scopeKind} list gains only the main Agent's built-ins (the accepted trade-off)`);
        assert.deepEqual(before.filter((name) => !after.allowedTools.includes(name)), ['write'], 'and loses only what the user turned off');
        assert.equal(store.effectivePolicyFor('agent', 'main').policy.allowedTools.includes('transfer'), true, 'the main Agent keeps transfer');
        assert.doesNotMatch(await render(toolEditor, { scopeKind, scopeId }), /没有自己列表的自定义 Agent 也会因此得到/, 'the note goes once a list is saved');
      }
    });

    await t.test('设置页第一次保存的全局或工作流列表，经后端编译后也不让没有列表的 Agent 得到其它 Agent 的 MCP 工具', async () => {
      await withBackendSettings(async ({ configuration, compile, toolDefinitions, toolAllowedByPolicy, sync, apply }) => {
        const exa = { name: 'exa_search', execution: 'runtime', description: 'MCP exa', parameters: { type: 'object' },
          source: { kind: 'mcp', sourceId: 'exa', sourceName: 'exa', originalToolName: 'search' },
          metadata: { category: 'general', scope: 'general', riskLevel: 'command', readonly: false, defaultEnabled: false } };
        const custom = await configuration.mutations.createAgent({ name: 'Custom', kind: 'custom' });
        const other = await configuration.mutations.createAgent({ name: 'Other', kind: 'custom' });
        const workflow = await configuration.mutations.createWorkflow({ name: 'W' });
        await configuration.mutations.selectConversationWorkflow({ conversationId: 'conversation:w', scopeKind: 'workflow', workflowId: workflow.id });
        await configuration.mutations.setToolPolicy({ scopeKind: 'agent', scopeId: other.id, allowedTools: ['read', 'exa_search'] });
        for (const [scopeKind, scopeId, conversationId] of [['global', undefined, 'conversation:plain'], ['workflow', workflow.id, 'conversation:w']]) {
          await configuration.mutations.clearToolPolicy('global');
          await configuration.mutations.clearToolPolicy('workflow', workflow.id);
          const before = await compile(custom.id, conversationId);
          assert.equal(toolAllowedByPolicy(before, exa), false);
          const { client, store, bindings, messages } = fresh(toolDefinitions(exa));
          await sync(client);
          (await bindings(toolEditor, { scopeKind, scopeId })).setToolEnabled(store.toolDefinitions.find((tool) => tool.name === 'delete'), false);
          await apply(messages.at(-1));
          const after = await compile(custom.id, conversationId);
          assert.equal(toolAllowedByPolicy(after, exa), false, `the first ${scopeKind} list does not admit another Agent's MCP tool`);
          assert.deepEqual(after.allowedTools.filter((name) => !before.allowedTools.includes(name)), ['switch_work_environment', 'transfer']);
          assert.deepEqual(before.allowedTools.filter((name) => !after.allowedTools.includes(name)), ['delete']);
          assert.ok((await compile('main', conversationId)).allowedTools.includes('transfer'), 'the main Agent keeps transfer');
        }
      });
    });

    await t.test('全局开启的 MCP 服务不进入内置只读 Agent 与工作流，只能在该 Agent 或工作流里单独开启', async () => {
      const { TOOL_POLICY_ALL_MCP_SOURCES } = await server.ssrLoadModule(path.join(process.cwd(), 'shared/protocol.ts'));
      const readonlyMcp = { [TOOL_POLICY_ALL_MCP_SOURCES]: { enabled: false } };
      const { client, feed, store, bindings, render } = fresh(allDefinitions);
      client.builtinToolPolicies = builtinToolPolicies.map((record) => record.allowedTools === readonlyList ? { ...record, sourceConfigs: readonlyMcp } : record);
      client.mcpToolSources = [{ id: 'exa', name: 'exa', transportKind: 'stdio', status: 'connected', toolCount: 1 }];
      feed.records = { AgentConversationLink: { link: { id: 'link', conversation_id: 'explore-conversation', agent_id: 'explore', role: 'default' } } };
      const mcp = store.toolDefinitions.find((tool) => tool.name === 'mcp_search');
      store.setPolicyForScope('global', undefined, undefined, 'Global', {}, { exa: { enabled: true } });
      const view = async (scopeKind, scopeId) => {
        const editor = await bindings(toolEditor, { scopeKind, scopeId });
        return { source: editor.isMcpSourceEnabled('exa'), tool: editor.isToolEnabled(mcp), editor };
      };
      assert.deepEqual((({ source, tool }) => ({ source, tool }))(await view('agent', 'main')), { source: true, tool: true });
      for (const [scopeKind, scopeId] of [['agent', 'explore'], ['workflow', 'builtin:readonly'], ['conversation', 'explore-conversation']]) {
        const { source, tool } = await view(scopeKind, scopeId);
        assert.deepEqual({ source, tool }, { source: false, tool: false }, `${scopeKind}:${scopeId} shows the MCP server off`);
      }
      store.setCrossConversationCollaborationForScope('agent', 'explore', true);
      assert.equal((await view('agent', 'explore')).tool, false, 'a list-less record keeps the restriction');
      assert.match(await render(toolEditor, { scopeKind: 'agent', scopeId: 'explore' }), /内置只读 Agent 和工作流默认不使用 MCP 工具/);

      // A conversation below the read-only Agent cannot re-enable the source; the Agent scope can.
      (await view('conversation', 'explore-conversation')).editor.toggleMcpSource('exa', true);
      assert.equal((await view('conversation', 'explore-conversation')).tool, false);
      (await view('agent', 'explore')).editor.toggleMcpSource('exa', true);
      assert.deepEqual(store.localPolicyFor('agent', 'explore').policy.sourceConfigs, { exa: { enabled: true } });
      assert.equal(store.localPolicyFor('agent', 'explore').policy.allowedTools, undefined, 'opting in keeps the built-in list');
      assert.deepEqual((({ source, tool }) => ({ source, tool }))(await view('agent', 'explore')), { source: true, tool: true });
      assert.equal(store.effectivePolicyFor('agent', 'explore').policy.allowedTools.includes('write'), false);
    });

    await t.test('工具列表不含 run_agent 时，提示按实际列表列出可用的跨对话工具，与后端只提供列出和读取一致', async () => {
      const { store, render } = fresh(allDefinitions);
      const note = (html) => html.match(/<p class="collaboration-note"[^>]*>当前范围的工具列表不含 run_agent[^<]*<\/p>/)?.[0];
      store.setPolicyForScope('global', undefined, ['read_file', 'write', ...crossNames], 'Global');
      store.setCrossConversationCollaborationForScope('global', undefined, true);
      const availability = store.crossConversationToolsFor('global');
      assert.equal(availability.sendTools, false);
      assert.deepEqual(availability.available, ['list_conversations', 'read_conversation'],
        'the send-type tools stay in the saved list but the backend does not offer them');
      assert.match(note(await render(editor, { scopeKind: 'global' })), /不会提供发送、新建和分支对话工具；实际可用：list_conversations、read_conversation/);

      store.setPolicyForScope('global', undefined, ['read_file', 'list_conversations', 'send_conversation_message'], 'Global', switchOn);
      assert.deepEqual(store.crossConversationToolsFor('global').available, ['list_conversations']);
      const html = await render(editor, { scopeKind: 'global' });
      assert.match(note(html), /实际可用：list_conversations。/);
      assert.match(html, /仍未允许 read_conversation/);
    });

    await t.test('MCP 页里开关单个工具只改来源设置，不给全局写入工具列表，也不丢掉全局的其它设置', async () => {
      const { default: mcpTab } = await server.ssrLoadModule('/src/components/settings/global/McpToolSettingsTab.vue');
      const { client, store, bindings, messages } = fresh(allDefinitions);
      client.builtinToolPolicies = builtinToolPolicies;
      client.mcpToolSources = [{ id: 'exa', name: 'exa', transportKind: 'stdio', status: 'connected', toolCount: 1 }];
      const mcp = store.toolDefinitions.find((tool) => tool.name === 'mcp_search');
      store.setPolicyForScope('global', undefined, undefined, 'Global', switchOn, { exa: { enabled: true } });
      const tab = await bindings(mcpTab, {});
      assert.equal(tab.isToolGloballyEnabled(mcp), true);
      tab.setToolGlobalEnabled(mcp, false);
      let global = store.localPolicyFor('global').policy;
      assert.equal(global.allowedTools, undefined, 'no global list is written as a side effect');
      assert.equal('allowedTools' in messages.at(-1).payload, false);
      assert.deepEqual(global.sourceConfigs, { exa: { enabled: true, disabledTools: ['mcp_search'] } });
      assert.deepEqual(global.toolConfigs, switchOn, 'the cross-conversation switch stays');
      assert.equal(tab.isToolGloballyEnabled(mcp), false);
      assert.ok(store.effectivePolicyFor('agent', 'main').policy.allowedTools.includes('transfer'), 'built-in Agents keep their own lists');
      tab.setToolGlobalEnabled(mcp, true);
      global = store.localPolicyFor('global').policy;
      assert.equal(global.allowedTools, undefined);
      assert.deepEqual(global.sourceConfigs, { exa: { enabled: true } });

      // A saved global list keeps its state; turning an MCP tool off also drops it from that list.
      store.setPolicyForScope('global', undefined, ['read_file', 'mcp_search'], 'Global', switchOn, { exa: { enabled: true } });
      tab.setToolGlobalEnabled(mcp, false);
      assert.deepEqual(store.localPolicyFor('global').policy.allowedTools, ['read_file']);
    });

    await t.test('MCP 工具的每个开关只改它显示的那个工具：勾选未设置来源的一个工具不会开启整个服务，全局取消勾选不会新建列表', async () => {
      const { default: mcpTab } = await server.ssrLoadModule('/src/components/settings/global/McpToolSettingsTab.vue');
      const deleteAll = { ...mcpTool, name: 'mcp_delete_all', description: 'mcp delete' };
      const catalog = [...allDefinitions, deleteAll];
      const sources = [{ id: 'exa', name: 'exa', transportKind: 'stdio', status: 'connected', toolCount: 2 }];
      const tools = (store) => ({ search: store.toolDefinitions.find((tool) => tool.name === 'mcp_search'), deleteAll: store.toolDefinitions.find((tool) => tool.name === 'mcp_delete_all') });

      // (a) The MCP tab, a source nobody configured: ticking one tool enables that tool only.
      {
        const { client, store, bindings, messages } = fresh(catalog);
        client.mcpToolSources = sources;
        const { search, deleteAll: other } = tools(store);
        let tab = await bindings(mcpTab, {});
        assert.deepEqual([tab.isToolGloballyEnabled(search), tab.isToolGloballyEnabled(other)], [false, false]);
        tab.setToolGlobalEnabled(search, true);
        tab = await bindings(mcpTab, {});
        assert.deepEqual([tab.isToolGloballyEnabled(search), tab.isToolGloballyEnabled(other)], [true, false], 'only the ticked tool is on');
        assert.deepEqual(store.localPolicyFor('global').policy.sourceConfigs, { exa: { enabled: true, disabledTools: ['mcp_delete_all'] } });
        assert.equal('allowedTools' in messages.at(-1).payload, false);
        // A tool on only through a saved global list (no source settings): unticking it leaves the other one on.
        store.setPolicyForScope('global', undefined, ['read_file', 'mcp_search', 'mcp_delete_all'], 'Global', {}, {});
        tab = await bindings(mcpTab, {});
        assert.deepEqual([tab.isToolGloballyEnabled(search), tab.isToolGloballyEnabled(other)], [true, true]);
        tab.setToolGlobalEnabled(search, false);
        tab = await bindings(mcpTab, {});
        assert.deepEqual([tab.isToolGloballyEnabled(search), tab.isToolGloballyEnabled(other)], [false, true]);
        assert.deepEqual(store.localPolicyFor('global').policy.allowedTools, ['read_file', 'mcp_delete_all']);
      }

      // (b) The global all-tools list with the server enabled: unticking turns that tool off and saves no list.
      {
        const { client, store, bindings, render, messages } = fresh(catalog);
        client.builtinToolPolicies = builtinToolPolicies;
        client.mcpToolSources = sources;
        const { search, deleteAll: other } = tools(store);
        store.setPolicyForScope('global', undefined, undefined, 'Global', {}, { exa: { enabled: true } });
        let editor = await bindings(toolEditor, { scopeKind: 'global' });
        editor.setToolEnabled(search, false);
        editor = await bindings(toolEditor, { scopeKind: 'global' });
        assert.deepEqual([editor.isToolEnabled(search), editor.isToolEnabled(other)], [false, true]);
        assert.equal(store.localPolicyFor('global').policy.allowedTools, undefined, 'no global list is created');
        assert.equal('allowedTools' in messages.at(-1).payload, false);
        assert.deepEqual(store.localPolicyFor('global').policy.sourceConfigs, { exa: { enabled: true, disabledTools: ['mcp_search'] } });
        editor.setToolEnabled(search, true);
        assert.deepEqual(store.localPolicyFor('global').policy.sourceConfigs, { exa: { enabled: true } });

        // Below global, a tool the global layer disables cannot be turned on here, so its box is disabled and a click saves nothing.
        store.setPolicyForScope('global', undefined, undefined, 'Global', {}, { exa: { enabled: true, disabledTools: ['mcp_delete_all'] } });
        const before = messages.length;
        const conversation = await bindings(toolEditor, { scopeKind: 'conversation', scopeId: 'below' });
        conversation.setToolEnabled(other, true);
        assert.equal(messages.length, before);
        assert.match(await render(toolEditor, { scopeKind: 'conversation', scopeId: 'below' }), /<button[^>]*aria-label="启用工具 mcp_delete_all"[^>]*disabled/);
        // Unticking one tool here writes only this scope's choice, not the global layer's disabled tool.
        conversation.setToolEnabled(search, false);
        assert.deepEqual(store.localPolicyFor('conversation', 'below').policy.sourceConfigs, { exa: { enabled: true, disabledTools: ['mcp_search'] } });
        assert.equal(store.localPolicyFor('conversation', 'below').policy.allowedTools, undefined);
        assert.equal((await bindings(toolEditor, { scopeKind: 'conversation', scopeId: 'below' })).isToolEnabled(search), false);
      }
    });

    await t.test('内置只读 Agent 或工作流下的对话里开启 MCP 服务不会生效，开关不可用并提示到哪个 Agent 或工作流开启', async () => {
      const { TOOL_POLICY_ALL_MCP_SOURCES } = await server.ssrLoadModule(path.join(process.cwd(), 'shared/protocol.ts'));
      const readonlyMcp = { [TOOL_POLICY_ALL_MCP_SOURCES]: { enabled: false } };
      const sourceToggle = (html) => html.match(/<button[^>]*aria-label="MCP 服务 exa"[^>]*>/)?.[0];
      for (const [conversationId, agentId, workflowId, name] of [['under-explore', 'explore', undefined, 'Agent「Explore」'], ['under-readonly', 'main', 'builtin:readonly', '工作流「只读」']]) {
        const { client, feed, store, bindings, render, messages } = fresh(allDefinitions);
        client.builtinToolPolicies = builtinToolPolicies.map((record) => record.allowedTools === readonlyList ? { ...record, sourceConfigs: readonlyMcp } : record);
        client.agents = [{ id: 'explore', name: 'Explore' }, { id: 'main', name: '主 Agent' }];
        client.workflows = [{ id: 'builtin:readonly', name: '只读' }];
        client.mcpToolSources = [{ id: 'exa', name: 'exa', transportKind: 'stdio', status: 'connected', toolCount: 1 }];
        feed.records = { AgentConversationLink: { link: { id: 'link', conversation_id: conversationId, agent_id: agentId, role: 'default' } } };
        if (workflowId) client.conversationWorkflowSelections = [{ id: 'selection', conversationId, scopeKind: 'workflow', workflowId, role: 'active', createdAt: 1, updatedAt: 1 }];
        store.setPolicyForScope('global', undefined, undefined, 'Global', {}, { exa: { enabled: true } });
        const before = messages.length;
        (await bindings(toolEditor, { scopeKind: 'conversation', scopeId: conversationId })).toggleMcpSource('exa', true);
        assert.equal(messages.length, before, 'nothing is saved that could never take effect');
        assert.equal(store.localPolicyFor('conversation', conversationId).policy, undefined);
        const html = await render(toolEditor, { scopeKind: 'conversation', scopeId: conversationId });
        assert.match(sourceToggle(html), /disabled/, `${conversationId}: the server toggle is not usable`);
        assert.match(html, new RegExp(`此对话使用的内置只读${name}不使用其它范围开启的 MCP 服务`), `${conversationId} names ${name}`);
        // At that Agent or workflow scope itself the toggle stays usable: that is where the opt-in lives.
        const [scopeKind, scopeId] = workflowId ? ['workflow', workflowId] : ['agent', agentId];
        assert.doesNotMatch(sourceToggle(await render(toolEditor, { scopeKind, scopeId })), /disabled/);
      }
    });

    await t.test('写坏的来源设置在设置页保存时不报错，全来源值仍按拒绝保存', async () => {
      const { client, store, bindings, messages } = fresh(allDefinitions);
      client.mcpToolSources = [{ id: 'exa', name: 'exa', transportKind: 'stdio', status: 'connected', toolCount: 1 }];
      store.setPolicyForScope('global', undefined, undefined, 'Global', {}, { exa: { enabled: true } });
      const mcp = store.toolDefinitions.find((tool) => tool.name === 'mcp_search');
      for (const value of [null, 'x', []]) {
        client.toolPolicies = [...client.toolPolicies.filter((policy) => policy.id !== 'raw'), { id: 'raw', name: 'Raw', sourceConfigs: { '*': value, exa: null } }];
        client.toolPolicyScopeLinks = [...client.toolPolicyScopeLinks.filter((link) => link.id !== 'raw-link'),
          { id: 'raw-link', scopeKind: 'workflow', scopeId: 'wf', toolPolicyId: 'raw', role: 'active', createdAt: 1, updatedAt: 1 }];
        assert.equal((await bindings(toolEditor, { scopeKind: 'workflow', scopeId: 'wf' })).isToolEnabled(mcp), false, `'*' ${JSON.stringify(value)} denies`);
        (await bindings(toolEditor, { scopeKind: 'workflow', scopeId: 'wf' })).updateGateSetting(store.toolDefinitions.find((tool) => tool.name === 'read_file'), 'autoApproveExecution', false);
        assert.deepEqual(messages.at(-1).payload.sourceConfigs, { '*': { enabled: false } }, `'*' ${JSON.stringify(value)} is saved as a deny`);
        assert.equal((await bindings(toolEditor, { scopeKind: 'workflow', scopeId: 'wf' })).isToolEnabled(mcp), false);
        store.setAgentCollaborationFieldForScope('workflow', 'wf', 'maxChildAgentDepth', 2);
        assert.deepEqual(messages.at(-1).payload.sourceConfigs, { '*': { enabled: false } });
      }
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
      assert.match(html, /不会提供发送、新建和分支对话工具；实际可用：list_conversations、read_conversation。/);
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

    await t.test('恢复继承时上层开关仍开启就保留开关加入的工具；用户明确启用的工具不再算开关加入的', async () => {
      const { store, bindings } = fresh(allDefinitions);
      const added = ['list_conversations', 'read_conversation', 'send_conversation_message', 'create_conversation', 'fork_conversation'];
      store.setCrossConversationCollaborationForScope('global', undefined, true);
      store.setPolicyForScope('conversation', 'kept', ['read_file', 'run_agent'], 'Kept');
      store.setCrossConversationCollaborationForScope('conversation', 'kept', true);
      assert.deepEqual(store.localPolicyFor('conversation', 'kept').policy.crossConversationGrantedTools, added);
      store.setCrossConversationCollaborationForScope('conversation', 'kept', undefined);
      let local = store.localPolicyFor('conversation', 'kept').policy;
      assert.deepEqual(local.allowedTools, ['read_file', 'run_agent', ...added], 'the inherited switch is still on, so its tools stay');
      assert.equal(local.toolConfigs?.run_agent, undefined, 'the local switch value itself is removed');
      assert.deepEqual(store.crossConversationToolsFor('conversation', 'kept').missing, []);
      store.setCrossConversationCollaborationForScope('conversation', 'kept', false);
      assert.deepEqual(store.localPolicyFor('conversation', 'kept').policy.allowedTools, ['read_file', 'run_agent'],
        'turning the switch off here later still removes exactly the tools it added');

      // 启用全部 is an explicit enable of every tool: a later switch-off keeps them.
      store.setPolicyForScope('conversation', 'all', ['read_file', 'run_agent'], 'All');
      store.setCrossConversationCollaborationForScope('conversation', 'all', true);
      (await bindings(toolEditor, { scopeKind: 'conversation', scopeId: 'all' })).enableAll();
      assert.equal(store.localPolicyFor('conversation', 'all').policy.crossConversationGrantedTools, undefined);
      store.setCrossConversationCollaborationForScope('conversation', 'all', false);
      for (const name of added) assert.ok(store.localPolicyFor('conversation', 'all').policy.allowedTools.includes(name), `${name} stays after 启用全部`);

      // Enabling one switch-added tool the global list still blocks marks it as the user's own.
      store.setPolicyForScope('global', undefined, ['read_file', 'run_agent', 'list_conversations', 'read_conversation'], 'Global', switchOn);
      store.setPolicyForScope('conversation', 'one', ['read_file', 'run_agent'], 'One');
      store.setCrossConversationCollaborationForScope('conversation', 'one', true);
      const editor = await bindings(toolEditor, { scopeKind: 'conversation', scopeId: 'one' });
      editor.setToolEnabled(store.toolDefinitions.find((tool) => tool.name === 'send_conversation_message'), true);
      assert.equal(store.localPolicyFor('conversation', 'one').policy.crossConversationGrantedTools.includes('send_conversation_message'), false);
      store.setCrossConversationCollaborationForScope('conversation', 'one', false);
      assert.ok(store.localPolicyFor('conversation', 'one').policy.allowedTools.includes('send_conversation_message'));
      assert.equal(store.localPolicyFor('conversation', 'one').policy.allowedTools.includes('create_conversation'), false);
    });

    await t.test('在工作流或 Agent 恢复继承时，与它组合运行的 Agent 或工作流仍开着开关，就保留开关加入的工具', async () => {
      const added = ['list_conversations', 'read_conversation', 'send_conversation_message', 'create_conversation', 'fork_conversation'];
      const crossTools = (chain) => store => store.resolveScopes(chain).allowedTools.filter((name) => added.includes(name)).sort();
      {
        const { store } = fresh(allDefinitions);
        store.setPolicyForScope('agent', 'agent:a', undefined, 'A', switchOn);
        store.setPolicyForScope('workflow', 'wf', ['read_file', 'run_agent'], 'W');
        store.setCrossConversationCollaborationForScope('workflow', 'wf', true);
        store.setCrossConversationCollaborationForScope('workflow', 'wf', undefined);
        assert.deepEqual(store.localPolicyFor('workflow', 'wf').policy.allowedTools, ['read_file', 'run_agent', ...added],
          'Agent A keeps the switch on and runs under this workflow, so the workflow keeps the tools');
        const aUnderW = [{ scopeKind: 'global' }, { scopeKind: 'agent', scopeId: 'agent:a' }, { scopeKind: 'workflow', scopeId: 'wf' }];
        assert.equal(store.resolveScopes(aUnderW).toolConfigs.run_agent.config.crossConversationCollaboration, true);
        assert.deepEqual(crossTools(aUnderW)(store), sorted(added));
        store.setCrossConversationCollaborationForScope('workflow', 'wf', false);
        assert.deepEqual(store.localPolicyFor('workflow', 'wf').policy.allowedTools, ['read_file', 'run_agent'], 'a later switch-off still removes exactly them');
      }
      {
        const { store } = fresh(allDefinitions);
        store.setPolicyForScope('workflow', 'wf', undefined, 'W', switchOn);
        store.setPolicyForScope('agent', 'agent:b', ['read_file', 'run_agent'], 'B');
        store.setCrossConversationCollaborationForScope('agent', 'agent:b', true);
        store.setCrossConversationCollaborationForScope('agent', 'agent:b', undefined);
        assert.deepEqual(store.localPolicyFor('agent', 'agent:b').policy.allowedTools, ['read_file', 'run_agent', ...added],
          'a workflow that turns the switch on still needs the tools in the Agent list');
        assert.deepEqual(crossTools([{ scopeKind: 'global' }, { scopeKind: 'agent', scopeId: 'agent:b' }, { scopeKind: 'workflow', scopeId: 'wf' }])(store), sorted(added));
      }
      {
        // With the switch off everywhere else, restoring removes what the switch added.
        const { store } = fresh(allDefinitions);
        store.setPolicyForScope('agent', 'agent:off', undefined, 'Off', { run_agent: { config: { crossConversationCollaboration: false } } });
        store.setPolicyForScope('workflow', 'wf', ['read_file', 'run_agent'], 'W');
        store.setCrossConversationCollaborationForScope('workflow', 'wf', true);
        store.setCrossConversationCollaborationForScope('workflow', 'wf', undefined);
        assert.deepEqual(store.localPolicyFor('workflow', 'wf').policy.allowedTools, ['read_file', 'run_agent']);
      }
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

    await t.test('子 Agent 对话的设置里不显示跨对话开关', async () => {
      const { feed, render } = fresh(allDefinitions);
      feed.records = { ChildExecution: { child: { id: 'child', child_conversation_id: 'child-conversation', status: 'active' } } };
      const childHtml = await render(editor, { scopeKind: 'conversation', scopeId: 'child-conversation' });
      assert.equal(checkbox(childHtml), undefined);
      assert.match(childHtml, /子 Agent 对话只在所属团队内协作，不提供跨对话工具/);
      assert.match(input(childHtml, '最大子 Agent 深度'), /value="1"/, 'the team budgets stay editable');
      assert.ok(checkbox(await render(editor, { scopeKind: 'conversation', scopeId: 'top-level' })), 'top-level conversations keep the switch');
    });

    await t.test('对话的继承值按 Agent 与工作流层计算，而不是只看全局', async () => {
      const { client, feed, store, render } = fresh(allDefinitions);
      client.builtinToolPolicies = builtinToolPolicies;
      feed.records = { AgentConversationLink: { link: { id: 'link', conversation_id: 'layered', agent_id: 'explore', role: 'default' } } };
      client.conversationWorkflowSelections = [{ id: 'selection', conversationId: 'layered', scopeKind: 'workflow', workflowId: 'wf', role: 'active', createdAt: 1, updatedAt: 1 }];
      store.setPolicyForScope('global', undefined, ['run_agent', 'read_file', 'write', ...crossNames], 'Global');
      store.setAgentCollaborationFieldForScope('agent', 'explore', 'maxChildAgentDepth', 3);
      store.setCrossConversationCollaborationForScope('workflow', 'wf', true);

      const html = await render(editor, { scopeKind: 'conversation', scopeId: 'layered' });
      assert.match(checkbox(html), /aria-checked="true"/, 'the workflow layer turned the switch on');
      assert.match(html, /继承上层 · 工作流开启/);
      assert.match(input(html, '最大子 Agent 深度'), /value="3"/);
      assert.match(html, /继承上层 · Agent 3/);
      assert.deepEqual(store.effectivePolicyFor('conversation', 'layered').policy.allowedTools, sorted(readonlyList),
        'the conversation shows the read-only list of its Agent');
      assert.match(html, /不会提供发送、新建和分支对话工具；实际可用：list_conversations、read_conversation。/);
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
