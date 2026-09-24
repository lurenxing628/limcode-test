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
      load,
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
    const { default: skillEditor } = await server.ssrLoadModule('/src/components/settings/skills/SkillPolicyEditor.vue');
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
      assert.doesNotMatch(oldHtml, /受派出它的对话限制/, 'the global scope never runs as a child');
      const agentToolHtml = await render(toolEditor, { scopeKind: 'agent', scopeId: 'worker' });
      assert.match(agentToolHtml, /这个 Agent 被模型派出作为子 Agent 运行时，还受派出它的对话限制：只能使用双方都允许的工具和 MCP 服务/);
      assert.match(agentToolHtml, /用户在 Plan 卡片上选「新开对话执行」交给它时，按它自己的工具设置运行/);
      const agentSkillHtml = await render(skillEditor, { scopeKind: 'agent', scopeId: 'worker' });
      assert.match(agentSkillHtml, /这个 Agent 被模型派出作为子 Agent 运行时，派出它的对话关掉的技能，这里也用不了/);
      assert.match(agentSkillHtml, /用户在 Plan 卡片上选「新开对话执行」交给它时，按它自己的技能设置运行/);
      assert.doesNotMatch(await render(skillEditor, { scopeKind: 'global' }), /派出它的对话关掉的技能/);
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
    // An MCP tool is identified by its server id and the name the server gives it; `mcp_search` is only its display name.
    const mcpTool = { name: 'mcp_search', execution: 'backend', parameters: { type: 'object' }, description: 'mcp', defaultConfig: {}, source: { kind: 'mcp', sourceId: 'exa', originalToolName: 'search' } };
    const allDefinitions = [runAgentTool.declaration, readFileTool, writeTool, transferTool, mcpTool, ...crossTools];
    // As the blueprints: no list names the cross-conversation tools, which the switch alone grants.
    const readonlyList = ['read_file'];
    const builtinToolPolicies = [
      { id: 'builtin-tool-policy:agent:main', scopeKind: 'agent', scopeId: 'main', allowedTools: ['run_agent', 'read_file', 'write', 'transfer'] },
      { id: 'builtin-tool-policy:agent:explore', scopeKind: 'agent', scopeId: 'explore', allowedTools: readonlyList },
      { id: 'builtin-tool-policy:workflow:builtin:readonly', scopeKind: 'workflow', scopeId: 'builtin:readonly', allowedTools: readonlyList }
    ];
    const sorted = (names) => [...names].sort();
    const switchOn = { run_agent: { config: { crossConversationCollaboration: true } } };
    const readType = ['list_conversations', 'read_conversation'];

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
      assert.deepEqual(sorted(store.effectivePolicyFor('global').policy.allowedTools), sorted(['run_agent', 'read_file', 'write']),
        'the global view shows the default tool set: no MCP tools, nothing that is off by default and none of the switch-granted tools');
      assert.deepEqual(store.crossConversationStateFor('global'), { enabled: true, sendTools: true, offered: crossNames });

      store.setCrossConversationCollaborationForScope('global', undefined, undefined);
      assert.equal(store.localPolicyFor('global').policy, undefined, 'restoring the default removes the switch-only global record');
      assert.deepEqual(messages.at(-1).payload, { scopeKind: 'global' });
      assert.equal(messages.at(-1).type, 'toolPolicy.scope.clear');
    });

    await t.test('没有任何工具列表时按默认工具集显示，内置 Agent 按自己的列表显示，和后端编译一致', async () => {
      const { client, feed, store } = fresh(allDefinitions);
      client.builtinToolPolicies = builtinToolPolicies;
      const defaultToolSet = sorted(['run_agent', 'read_file', 'write']);
      feed.records = { AgentConversationLink: {
        custom: { id: 'custom', conversation_id: 'custom-conversation', agent_id: 'agent:custom', role: 'default' },
        main: { id: 'main', conversation_id: 'main-conversation', agent_id: 'main', role: 'default' }
      } };
      store.setCrossConversationCollaborationForScope('global', undefined, true);
      assert.equal(store.localPolicyFor('global').policy.allowedTools, undefined);
      assert.deepEqual(store.effectivePolicyFor('conversation', 'custom-conversation').policy.allowedTools, defaultToolSet,
        'a custom Agent under a list-less global record gets the default tool set');
      assert.deepEqual(store.crossConversationStateFor('conversation', 'custom-conversation').offered, crossNames);
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
        assert.doesNotMatch(collaboration, /当前生效/, 'no effective state is claimed while the list cannot compile');
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
      assert.deepEqual(sorted(store.localPolicyFor('global').policy.allowedTools), sorted(['run_agent', 'read_file', 'transfer']));
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
      }, { exa: { enabled: true, disabledTools: ['search'] } }, 'yolo');
      global = await bindings(toolEditor, { scopeKind: 'global' });
      assert.equal(global.canRestoreDefault, true);
      global.inheritDefaults();
      const saved = store.localPolicyFor('global').policy;
      assert.equal(saved.allowedTools, undefined, 'the global ceiling is dropped instead of writing the default list');
      assert.deepEqual(saved.toolConfigs, { ...switchOn, read_file: { config: {}, autoApproveExecution: false } });
      assert.deepEqual(saved.sourceConfigs, { exa: { enabled: true, disabledTools: ['search'] } });
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
        sorted(['run_agent', 'read_file']), 'a custom-Agent conversation starts from the default tool set');

      // An edit to a saved list keeps the entries an upper layer blocks for now.
      store.setPolicyForScope('conversation', 'saved', ['read_file', 'write', 'run_agent'], 'Saved');
      (await bindings(toolEditor, { scopeKind: 'conversation', scopeId: 'saved' })).setToolEnabled(tool('transfer'), true);
      assert.deepEqual(sorted(store.localPolicyFor('conversation', 'saved').policy.allowedTools), sorted(['read_file', 'write', 'run_agent', 'transfer']));
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

    await t.test('协作设置按实际生效的状态说明跨对话工具：关闭、只有列出和读取、或全部五个', async () => {
      const { store, render, bindings } = fresh(allDefinitions);
      const tool = (name) => store.toolDefinitions.find((candidate) => candidate.name === name);
      const note = async () => (await render(editor, { scopeKind: 'global' })).match(/<p class="collaboration-note collaboration-cross-state"[^>]*>([^<]*)<\/p>/)?.[1];
      assert.equal(await note(), '当前生效：关闭，不提供跨对话工具。');
      store.setPolicyForScope('global', undefined, ['read_file', 'write', ...crossNames], 'Global');
      assert.deepEqual(store.localPolicyFor('global').policy.allowedTools, ['read_file', 'write'], 'a saved list never holds the switch-granted tools');
      store.setCrossConversationCollaborationForScope('global', undefined, true);
      assert.deepEqual(store.crossConversationStateFor('global'), { enabled: true, sendTools: false, offered: readType });
      assert.equal(await note(), '当前生效：已开启，但当前范围的工具列表不含 run_agent，不提供发送、新建和分支对话工具；实际提供：list_conversations、read_conversation。');
      // run_agent enabled after the switch: the send-type tools come with it, nothing else changes.
      (await bindings(toolEditor, { scopeKind: 'global' })).setToolEnabled(tool('run_agent'), true);
      assert.deepEqual(sorted(store.localPolicyFor('global').policy.allowedTools), ['read_file', 'run_agent', 'write']);
      assert.deepEqual(store.crossConversationStateFor('global'), { enabled: true, sendTools: true, offered: crossNames });
      assert.equal(await note(), `当前生效：已开启，提供 ${crossNames.join('、')}。`);
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
      assert.deepEqual(global.sourceConfigs, { exa: { enabled: true, disabledTools: ['search'] } }, 'the disable names the tool as its server does');
      assert.deepEqual(global.toolConfigs, switchOn, 'the cross-conversation switch stays');
      assert.equal(tab.isToolGloballyEnabled(mcp), false);
      assert.ok(store.effectivePolicyFor('agent', 'main').policy.allowedTools.includes('transfer'), 'built-in Agents keep their own lists');
      tab.setToolGlobalEnabled(mcp, true);
      global = store.localPolicyFor('global').policy;
      assert.equal(global.allowedTools, undefined);
      assert.deepEqual(global.sourceConfigs, { exa: { enabled: true } });

      // A saved global list keeps its state and never holds MCP tools.
      store.setPolicyForScope('global', undefined, ['read_file', 'mcp_search'], 'Global', switchOn, { exa: { enabled: true } });
      assert.deepEqual(store.localPolicyFor('global').policy.allowedTools, ['read_file']);
      tab.setToolGlobalEnabled(mcp, false);
      assert.deepEqual(store.localPolicyFor('global').policy.allowedTools, ['read_file']);
    });

    await t.test('MCP 工具的每个开关只改它显示的那个工具：勾选未设置来源的一个工具不会开启整个服务，全局取消勾选不会新建列表', async () => {
      const { default: mcpTab } = await server.ssrLoadModule('/src/components/settings/global/McpToolSettingsTab.vue');
      const deleteAll = { ...mcpTool, name: 'mcp_delete_all', description: 'mcp delete', source: { ...mcpTool.source, originalToolName: 'delete_all' } };
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
        assert.deepEqual(store.localPolicyFor('global').policy.sourceConfigs, { exa: { enabled: true, enabledTools: ['search'] } });
        assert.equal('allowedTools' in messages.at(-1).payload, false);
        // A list naming MCP tools admits none of them: only source settings do.
        client.toolPolicies = [{ id: 'tool-policy:global:global', name: 'Global', allowedTools: ['read_file', 'mcp_search', 'mcp_delete_all'] }];
        tab = await bindings(mcpTab, {});
        assert.deepEqual([tab.isToolGloballyEnabled(search), tab.isToolGloballyEnabled(other)], [false, false]);
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
        assert.deepEqual(store.localPolicyFor('global').policy.sourceConfigs, { exa: { enabled: true, disabledTools: ['search'] } });
        editor.setToolEnabled(search, true);
        assert.deepEqual(store.localPolicyFor('global').policy.sourceConfigs, { exa: { enabled: true } });

        // Below global, a tool the global layer disables cannot be turned on here, so its box is disabled and a click saves nothing.
        store.setPolicyForScope('global', undefined, undefined, 'Global', {}, { exa: { enabled: true, disabledTools: ['delete_all'] } });
        const before = messages.length;
        const conversation = await bindings(toolEditor, { scopeKind: 'conversation', scopeId: 'below' });
        conversation.setToolEnabled(other, true);
        assert.equal(messages.length, before);
        assert.match(await render(toolEditor, { scopeKind: 'conversation', scopeId: 'below' }), /<button[^>]*aria-label="启用工具 mcp_delete_all"[^>]*disabled/);
        // Unticking one tool here writes only this scope's choice, not the global layer's disabled tool.
        conversation.setToolEnabled(search, false);
        assert.deepEqual(store.localPolicyFor('conversation', 'below').policy.sourceConfigs, { exa: { enabled: true, disabledTools: ['search'] } });
        assert.equal(store.localPolicyFor('conversation', 'below').policy.allowedTools, undefined);
        assert.equal((await bindings(toolEditor, { scopeKind: 'conversation', scopeId: 'below' })).isToolEnabled(search), false);
      }
    });

    await t.test('MCP 工具的停用和自动批准跟着服务 id 与原始工具名走：前一个服务停用、连不上、删除或还在连接时都不会换到另一个服务的工具上', async () => {
      await withBackendSettings(async ({ configuration, compile, toolDefinitions, toolAllowedByPolicy, sync, apply, load }) => {
        const { McpRuntimeManager, dedupeMcpToolNames } = load('backend/application/mcpRuntimeManager.js');
        const { toolDefinitionRecord } = load('backend/world/modules/tools/registry.js');
        const { ReliableToolDispatcher } = load('backend/reliableKernel/toolDispatcher.js');
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-mcp-identity-'));
        try {
          // A real stdio MCP server listing `query` and `execute` after an optional delay.
          const script = path.join(root, 'server.cjs');
          await fs.writeFile(script, `
const { Server } = require(${JSON.stringify(requireCompiled.resolve('@modelcontextprotocol/sdk/server/index.js'))});
const { StdioServerTransport } = require(${JSON.stringify(requireCompiled.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});
const { ListToolsRequestSchema } = require(${JSON.stringify(requireCompiled.resolve('@modelcontextprotocol/sdk/types.js'))});
const delay = Number(process.argv[2]);
const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => { await new Promise(resolve => setTimeout(resolve, delay)); return { tools: ['query', 'execute'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) }; });
server.connect(new StdioServerTransport());
`);
          // Both names reduce to the same prefix; A has the lower id.
          const A = 'mcp-postgres-a', B = 'mcp-postgres-b';
          const server = (id, name, { enabled = true, delay = 0, command = process.execPath } = {}) =>
            ({ id, name, enabled, transport: { kind: 'stdio', command, args: [script, String(delay)] }, createdAt: 1, updatedAt: 1 });
          const reserved = toolDefinitions().map((tool) => tool.name);
          /** The tools as the host names them while these servers are configured; also every intermediate state. */
          const connect = async (servers) => {
            const manager = new McpRuntimeManager({ async loadGlobalSettings() { return { settings: { servers } }; } });
            const seen = [];
            const named = () => dedupeMcpToolNames(manager.runtimeTools(), reserved);
            manager.setStateChangeListener(() => seen.push(named()));
            try {
              await manager.refreshFromSettings({ discover: true });
              return { tools: named(), seen };
            } finally { await manager.dispose(); }
          };
          const find = (tools, sourceId, original) => tools.find((tool) => tool.declaration.source?.sourceId === sourceId && tool.declaration.source?.originalToolName === original);
          const both = (await connect([server(A, 'Postgres 测试'), server(B, 'Postgres 生产')])).tools;
          assert.equal(find(both, A, 'execute').declaration.name.endsWith('_execute'), true);
          assert.equal(find(both, B, 'execute').declaration.name, `${find(both, A, 'execute').declaration.name}_2`, 'B gets the suffix while A is connected');

          // The settings page with both servers connected: enable both, turn B's execute off, auto-approve A's query.
          const custom = await configuration.mutations.createAgent({ name: 'Custom', kind: 'custom' });
          const { client, store, bindings, messages } = fresh(toolDefinitions(...both.map(toolDefinitionRecord)));
          await sync(client);
          client.mcpToolSources = [A, B].map((id) => ({ id, name: id, transportKind: 'stdio', status: 'connected', toolCount: 2 }));
          const record = (sourceId, original) => store.toolDefinitions.find((tool) => tool.source?.sourceId === sourceId && tool.source?.originalToolName === original);
          (await bindings(toolEditor, { scopeKind: 'global' })).toggleMcpSource(A, true);
          (await bindings(toolEditor, { scopeKind: 'global' })).toggleMcpSource(B, true);
          (await bindings(toolEditor, { scopeKind: 'global' })).setToolEnabled(record(B, 'execute'), false);
          (await bindings(toolEditor, { scopeKind: 'global' })).updateGateSetting(record(A, 'query'), 'autoApproveExecution', true);
          for (const message of messages.splice(0)) await apply(message);
          const policy = await compile(custom.id, 'conversation:custom');

          /** The dispatcher's frozen approval gate for one call of this tool under the compiled policy. */
          const approvalGate = async (tools, tool) => {
            const records = {
              AuthoritySnapshot: [{ id: 'authority', turn_id: 'turn', content_object_id: 'authority-content' }],
              ContentObject: [{ id: 'authority-content' }],
              Turn: [{ id: 'turn', conversation_id: 'conversation', status: 'active' }]
            };
            const matching = (read) => (records[read.domain] ?? []).filter((row) => Object.entries(read.where ?? {}).every(([key, value]) => row[key] === value));
            const dispatcher = new ReliableToolDispatcher({
              database: {
                async snapshot(reads) { return { snapshot: reads.map((read) => read.kind === 'get' ? (records[read.domain] ?? []).find((row) => row.id === read.id) : matching(read)) }; },
                async snapshotAll(read) { return { snapshot: matching(read) }; }
              },
              contentStore: { async read() { return Buffer.from(JSON.stringify({ toolPolicy: policy })); } },
              effects: { subscribeToolModelResults() { return () => {}; } },
              host: { definitions: () => tools }
            });
            const { name, description, parameters, source, metadata } = tool.declaration;
            return (await dispatcher.freezeCall({ turnId: 'turn', modelRequestId: 'request', toolCallId: `call-${name}`, toolName: name, arguments: {},
              definition: { name, description, parameters, source, metadata } })).executionGate;
          };
          const allowed = (tool) => toolAllowedByPolicy(policy, toolDefinitionRecord(tool));
          assert.deepEqual([allowed(find(both, A, 'execute')), allowed(find(both, B, 'execute'))], [true, false]);
          assert.equal(await approvalGate(both, find(both, A, 'query')), 'automatic');
          assert.equal(await approvalGate(both, find(both, B, 'query')), 'approval_required');

          const withoutA = [
            ['A switched off', (await connect([server(A, 'Postgres 测试', { enabled: false }), server(B, 'Postgres 生产')])).tools],
            ['A fails to connect', (await connect([server(A, 'Postgres 测试', { command: path.join(root, 'missing-command') }), server(B, 'Postgres 生产')])).tools],
            ['A removed', (await connect([server(B, 'Postgres 生产')])).tools],
            ['A still connecting', (await connect([server(A, 'Postgres 测试', { delay: 1500 }), server(B, 'Postgres 生产')])).seen
              .find((tools) => find(tools, B, 'execute') && !find(tools, A, 'execute'))]
          ];
          for (const [label, tools] of withoutA) {
            assert.ok(tools, `${label}: B was connected alone`);
            assert.equal(find(tools, B, 'execute').declaration.name, find(both, A, 'execute').declaration.name, `${label}: B's tool takes the name A's had`);
            assert.equal(allowed(find(tools, B, 'execute')), false, `${label}: B's execute stays off`);
            assert.equal(allowed(find(tools, B, 'query')), true);
            assert.equal(await approvalGate(tools, find(tools, B, 'query')), 'approval_required', `${label}: B's query does not take A's auto-approve`);
          }
          // B gone instead: A keeps its own settings.
          const withoutB = (await connect([server(A, 'Postgres 测试')])).tools;
          assert.equal(await approvalGate(withoutB, find(withoutB, A, 'query')), 'automatic');
          assert.equal(allowed(find(withoutB, A, 'execute')), true);
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      });
    });

    await t.test('只勾选单个 MCP 工具时只开启这些工具：服务以后新增的工具不会自动开启，也不丢掉当前没列出的工具的停用', async () => {
      const { default: mcpTab } = await server.ssrLoadModule('/src/components/settings/global/McpToolSettingsTab.vue');
      const { TOOL_POLICY_ALL_MCP_SOURCES } = await server.ssrLoadModule(path.join(process.cwd(), 'shared/protocol.ts'));
      const gh = (original) => ({ ...mcpTool, name: `gh_${original}`, description: original, source: { kind: 'mcp', sourceId: 'gh', originalToolName: original } });
      const [search, remove, merge, list, deleteRepo] = ['search_code', 'delete_file', 'merge_pull_request', 'list_issues', 'delete_repo'].map(gh);
      const sources = [{ id: 'gh', name: 'gh', transportKind: 'stdio', status: 'connected', toolCount: 2 }];
      const readonlyMcp = { [TOOL_POLICY_ALL_MCP_SOURCES]: { enabled: false } };
      const builtins = builtinToolPolicies.map((record) => record.allowedTools === readonlyList ? { ...record, sourceConfigs: readonlyMcp } : record);
      const session = (tools) => {
        const state = fresh([...allDefinitions, ...tools]);
        state.client.builtinToolPolicies = builtins;
        state.client.mcpToolSources = sources;
        return state;
      };
      const on = (store, scopeKind, scopeId, tool) => toolAllowedByPolicy(store.effectivePolicyFor(scopeKind, scopeId).policy, tool);
      const { toolAllowedByPolicy } = await server.ssrLoadModule(path.join(process.cwd(), 'shared/toolPolicyResolution.ts'));

      // M1: the MCP tab, a source nobody configured. Ticking one tool enables that tool only, now and later.
      {
        const { client, store, bindings } = session([search, remove]);
        (await bindings(mcpTab, {})).setToolGlobalEnabled(store.toolDefinitions.find((tool) => tool.name === search.name), true);
        assert.deepEqual(store.localPolicyFor('global').policy.sourceConfigs, { gh: { enabled: true, enabledTools: ['search_code'] } });
        client.toolDefinitions = [...client.toolDefinitions, merge];
        for (const agent of ['agent:custom', 'main']) {
          assert.deepEqual([on(store, 'agent', agent, search), on(store, 'agent', agent, remove), on(store, 'agent', agent, merge)], [true, false, false],
            `${agent}: a tool the server adds later stays off`);
        }
        // Ticking the source itself is the way to take every tool, including later ones.
        (await bindings(toolEditor, { scopeKind: 'global' })).toggleMcpSource('gh', true);
        assert.deepEqual(store.localPolicyFor('global').policy.sourceConfigs, { gh: { enabled: true } });
        assert.equal(on(store, 'agent', 'agent:custom', merge), true);
      }
      // M1 through the all-tools list at an Agent scope; the tools under a server that is off can be ticked one by one too.
      {
        const { client, store, bindings, render } = session([search, remove]);
        const chips = (await render(toolEditor, { scopeKind: 'agent', scopeId: 'agent:d' })).match(/<button[^>]*class="[^"]*mcp-tool-chip[^"]*"[^>]*>/g);
        assert.equal(chips.length, 2);
        for (const chip of chips) assert.doesNotMatch(chip, / disabled/, 'a tool of a server that is off here can still be opted in');
        (await bindings(toolEditor, { scopeKind: 'agent', scopeId: 'agent:d' })).setToolEnabled(store.toolDefinitions.find((tool) => tool.name === search.name), true);
        assert.deepEqual(store.localPolicyFor('agent', 'agent:d').policy.sourceConfigs, { gh: { enabled: true, enabledTools: ['search_code'] } });
        client.toolDefinitions = [...client.toolDefinitions, merge];
        assert.equal(on(store, 'agent', 'agent:d', merge), false);
        // A second tick adds to the same allowlist; unticking the last one turns the source off here.
        (await bindings(toolEditor, { scopeKind: 'agent', scopeId: 'agent:d' })).setToolEnabled(store.toolDefinitions.find((tool) => tool.name === remove.name), true);
        assert.deepEqual(store.localPolicyFor('agent', 'agent:d').policy.sourceConfigs, { gh: { enabled: true, enabledTools: ['search_code', 'delete_file'] } });
        (await bindings(toolEditor, { scopeKind: 'agent', scopeId: 'agent:d' })).setToolEnabled(store.toolDefinitions.find((tool) => tool.name === search.name), false);
        (await bindings(toolEditor, { scopeKind: 'agent', scopeId: 'agent:d' })).setToolEnabled(store.toolDefinitions.find((tool) => tool.name === remove.name), false);
        assert.deepEqual(store.localPolicyFor('agent', 'agent:d').policy.sourceConfigs, { gh: { enabled: false } });
      }
      // M1b: the source is on globally; Explore opts in one tool, and a later write tool does not reach it.
      {
        const { client, store, bindings } = session([search, remove]);
        store.setPolicyForScope('global', undefined, undefined, 'Global', {}, { gh: { enabled: true } });
        assert.deepEqual([on(store, 'agent', 'explore', search), on(store, 'agent', 'explore', remove)], [false, false]);
        (await bindings(toolEditor, { scopeKind: 'agent', scopeId: 'explore' })).setToolEnabled(store.toolDefinitions.find((tool) => tool.name === search.name), true);
        assert.deepEqual(store.localPolicyFor('agent', 'explore').policy.sourceConfigs, { gh: { enabled: true, enabledTools: ['search_code'] } });
        client.toolDefinitions = [...client.toolDefinitions, merge];
        assert.deepEqual([on(store, 'agent', 'explore', search), on(store, 'agent', 'explore', remove), on(store, 'agent', 'explore', merge)], [true, false, false]);
        assert.equal(on(store, 'agent', 'agent:custom', merge), true, 'the global all-tools setting still applies elsewhere');
      }
      // M3: a disable for a tool the server does not list right now survives an edit of another tool.
      {
        const { client, store, bindings } = session([search, list]);
        store.setPolicyForScope('global', undefined, undefined, 'Global', {}, { gh: { enabled: true, disabledTools: ['delete_repo'] } });
        (await bindings(mcpTab, {})).setToolGlobalEnabled(store.toolDefinitions.find((tool) => tool.name === list.name), false);
        assert.deepEqual(store.localPolicyFor('global').policy.sourceConfigs, { gh: { enabled: true, disabledTools: ['delete_repo', 'list_issues'] } });
        client.toolDefinitions = [...client.toolDefinitions, deleteRepo];
        assert.equal(on(store, 'agent', 'agent:custom', deleteRepo), false, 'the tool comes back still off');
        (await bindings(mcpTab, {})).setToolGlobalEnabled(store.toolDefinitions.find((tool) => tool.name === list.name), true);
        assert.deepEqual(store.localPolicyFor('global').policy.sourceConfigs, { gh: { enabled: true, disabledTools: ['delete_repo'] } });
      }
      // The backend compiles the allowlist the same way, and a lower layer can only narrow it.
      await withBackendSettings(async ({ configuration, compile, toolAllowedByPolicy: backendAllowed }) => {
        const custom = await configuration.mutations.createAgent({ name: 'Custom', kind: 'custom' });
        await configuration.mutations.setToolPolicy({ scopeKind: 'global', sourceConfigs: { gh: { enabled: true, enabledTools: ['search_code', 'delete_file'] } } });
        await configuration.mutations.setToolPolicy({ scopeKind: 'agent', scopeId: custom.id, sourceConfigs: { gh: { enabled: true, enabledTools: ['search_code', 'merge_pull_request'] } } });
        const policy = await compile(custom.id, 'conversation:custom');
        assert.deepEqual([search, remove, merge].map((tool) => backendAllowed(policy, tool)), [true, false, false]);
        const main = await compile('main', 'conversation:main');
        assert.deepEqual([search, remove, merge].map((tool) => backendAllowed(main, tool)), [true, true, false]);
      });
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

    await t.test('写坏的 disabledTools 或 enabledTools 让该服务按关闭处理：不拆成单个字符放行，不报成工具列表无效，设置页指出字段并能修复', async () => {
      const { default: workflowTab } = await server.ssrLoadModule('/src/components/settings/workflow/WorkflowEditorTab.vue');
      const gh = (original) => ({ ...mcpTool, name: `gh_${original}`, description: original, source: { kind: 'mcp', sourceId: 'gh', originalToolName: original } });
      const [search, remove] = ['search_code', 'delete_file'].map(gh);
      const alert = (html) => html.match(/<p class="tool-policy-error"[^>]*role="alert"[^>]*>([^<]*)<\/p>/)?.[1];
      for (const [scopeKind, scopeId, label] of [['workflow', 'wf', '此范围'], ['global', undefined, '此范围']]) {
        for (const [field, malformed] of [['disabledTools', 'gh_delete_file'], ['disabledTools', 5], ['disabledTools', {}], ['disabledTools', [1]], ['enabledTools', 'search_code'], ['disabledTools', null]]) {
          const { client, feed, store, bindings, render, messages } = fresh([...allDefinitions, search, remove]);
          client.mcpToolSources = [{ id: 'gh', name: 'GitHub', transportKind: 'stdio', status: 'connected', toolCount: 2 }];
          const policyId = scopeKind === 'global' ? 'tool-policy:global:global' : 'raw';
          client.toolPolicies = [{ id: policyId, name: 'Raw', sourceConfigs: { gh: { enabled: true, [field]: malformed } } }];
          client.toolPolicyScopeLinks = [{ id: `${policyId}-link`, scopeKind, ...(scopeId ? { scopeId } : {}), toolPolicyId: policyId, role: 'active', createdAt: 1, updatedAt: 1 }];
          const what = `${scopeKind} ${field}=${JSON.stringify(malformed)}`;
          let page = await bindings(toolEditor, { scopeKind, scopeId });
          assert.deepEqual([page.isToolEnabled(store.toolDefinitions.find((tool) => tool.name === search.name)), page.isToolEnabled(store.toolDefinitions.find((tool) => tool.name === remove.name))],
            [false, false], `${what}: the whole source is off`);
          assert.equal(store.toolListErrorFor(scopeKind, scopeId), undefined, `${what}: not reported as an invalid tool list`);
          const text = alert(await render(toolEditor, { scopeKind, scopeId }));
          assert.match(text ?? '', new RegExp(`${label}保存的 MCP 服务「GitHub」的来源设置无效：${field} 必须是工具名数组`), what);
          assert.match(text, /重新勾选这个服务/, `${what}: the note offers a repair`);
          // Saving another setting keeps the fail-closed meaning instead of rewriting the value into characters.
          page.updateGateSetting(store.toolDefinitions.find((tool) => tool.name === 'read_file'), 'autoApproveExecution', false);
          assert.deepEqual(messages.at(-1).payload.sourceConfigs, { gh: { enabled: false } }, what);
          // The source switch at that scope repairs it.
          page = await bindings(toolEditor, { scopeKind, scopeId });
          page.toggleMcpSource('gh', true);
          assert.deepEqual(messages.at(-1).payload.sourceConfigs, { gh: { enabled: true } });
          assert.equal(alert(await render(toolEditor, { scopeKind, scopeId })), undefined, `${what}: repaired`);
          // A scope below names the layer to repair.
          if (scopeKind === 'global') {
            client.toolPolicies = [{ id: policyId, name: 'Raw', sourceConfigs: { gh: { enabled: true, [field]: malformed } } }];
            feed.records = { AgentConversationLink: { link: { id: 'link', conversation_id: 'below', agent_id: 'agent:custom', role: 'default' } } };
            assert.match(alert(await render(toolEditor, { scopeKind: 'conversation', scopeId: 'below' })) ?? '', new RegExp(`全局保存的 MCP 服务「GitHub」的来源设置无效：${field}`));
          }
        }
      }

      // The raw workflow editor refuses such a value and names the field; nothing is sent.
      const { client, messages, bindings } = fresh([...allDefinitions, search, remove]);
      client.workflows = [{ id: 'wf', name: 'W', source: 'user', createdAt: 1, updatedAt: 1 }];
      for (const [sourceConfigs, message] of [
        [{ gh: { enabled: true, disabledTools: 'gh_delete_file' } }, /toolPolicies\[0\]\.sourceConfigs\.gh\.disabledTools 必须是工具名数组/],
        [{ gh: { enabled: true, enabledTools: [1] } }, /toolPolicies\[0\]\.sourceConfigs\.gh\.enabledTools 必须是工具名数组/],
        [{ gh: { enabled: 'yes' } }, /toolPolicies\[0\]\.sourceConfigs\.gh\.enabled 必须是 true 或 false/],
        [{ gh: null }, /toolPolicies\[0\]\.sourceConfigs\.gh 必须是对象/],
        [[], /toolPolicies\[0\]\.sourceConfigs 省略时不设置 MCP 服务；填写时必须是以服务 id 为键的对象/]
      ]) {
        const tab = await bindings(workflowTab, {});
        const raw = JSON.parse(tab.rawText);
        raw.toolPolicies = [{ id: 'raw', name: 'Raw', sourceConfigs }];
        tab.rawText = JSON.stringify(raw);
        const before = messages.length;
        tab.saveRawWorkflow();
        assert.match(tab.rawError, message);
        assert.equal(messages.length, before, 'nothing is saved');
      }
    });

    await t.test('内置只读 Agent 和工作流开启后不获得写工具，只提供读取类对话工具，也不写工具列表', async () => {
      const { client, store, render, messages } = fresh(allDefinitions);
      client.builtinToolPolicies = builtinToolPolicies;
      store.setPolicyForScope('global', undefined, ['run_agent', 'read_file', 'write'], 'Global');
      assert.deepEqual(store.effectivePolicyFor('agent', 'explore').policy.allowedTools, sorted(readonlyList),
        'the settings view shows the built-in read-only list, not the global one');

      store.setCrossConversationCollaborationForScope('agent', 'explore', true);
      assert.equal(store.localPolicyFor('agent', 'explore').policy.allowedTools, undefined, 'the built-in read-only list stays in force');
      assert.equal('allowedTools' in messages.at(-1).payload, false);
      assert.deepEqual(store.effectivePolicyFor('agent', 'explore').policy.allowedTools, sorted(readonlyList));
      assert.deepEqual(store.crossConversationStateFor('agent', 'explore').offered, readType);
      const html = await render(editor, { scopeKind: 'agent', scopeId: 'explore' });
      assert.match(checkbox(html), /aria-checked="true"/);
      assert.match(html, /不提供发送、新建和分支对话工具；实际提供：list_conversations、read_conversation。/);
      assert.doesNotMatch(html, /上层工具策略/);

      store.setCrossConversationCollaborationForScope('workflow', 'builtin:readonly', true);
      assert.equal(store.localPolicyFor('workflow', 'builtin:readonly').policy.allowedTools, undefined);
      assert.deepEqual(store.crossConversationStateFor('workflow', 'builtin:readonly').offered, readType);

      // A scope with its own list keeps it exactly as saved, switch on or off.
      store.setPolicyForScope('agent', 'reader', ['read_file'], 'Reader');
      store.setCrossConversationCollaborationForScope('agent', 'reader', true);
      assert.deepEqual(store.localPolicyFor('agent', 'reader').policy.allowedTools, ['read_file']);
      assert.deepEqual(store.crossConversationStateFor('agent', 'reader').offered, readType);
      store.setCrossConversationCollaborationForScope('agent', 'reader', false);
      assert.deepEqual(store.localPolicyFor('agent', 'reader').policy.allowedTools, ['read_file']);
      assert.deepEqual(store.crossConversationStateFor('agent', 'reader'), { enabled: false, sendTools: false, offered: [] });
    });

    await t.test('开关就是授权：开启、关闭或恢复继承只写开关值，不改本层工具列表，也不记录开关加入的工具', async () => {
      const { store, messages } = fresh(allDefinitions);
      store.setPolicyForScope('conversation', 'custom', ['read_file', 'run_agent'], 'Custom', { run_agent: { config: { maxConcurrentAgents: 3 } } });
      store.setCrossConversationCollaborationForScope('conversation', 'custom', true);
      let local = store.localPolicyFor('conversation', 'custom').policy;
      assert.deepEqual(local.allowedTools, ['read_file', 'run_agent'], 'the list stays as the user saved it');
      assert.deepEqual(local.toolConfigs.run_agent.config, { maxConcurrentAgents: 3, crossConversationCollaboration: true });
      assert.deepEqual(Object.keys(messages.at(-1).payload).sort(), ['allowedTools', 'name', 'scopeId', 'scopeKind', 'toolConfigs']);
      assert.deepEqual(messages.at(-1).payload.allowedTools, ['read_file', 'run_agent']);
      assert.deepEqual(store.crossConversationStateFor('conversation', 'custom').offered, crossNames);

      store.setCrossConversationCollaborationForScope('conversation', 'custom', false);
      local = store.localPolicyFor('conversation', 'custom').policy;
      assert.deepEqual(local.allowedTools, ['read_file', 'run_agent']);
      assert.deepEqual(store.crossConversationStateFor('conversation', 'custom').offered, []);

      store.setCrossConversationCollaborationForScope('global', undefined, true);
      store.setCrossConversationCollaborationForScope('conversation', 'custom', undefined);
      local = store.localPolicyFor('conversation', 'custom').policy;
      assert.deepEqual(local.allowedTools, ['read_file', 'run_agent']);
      assert.deepEqual(local.toolConfigs.run_agent.config, { maxConcurrentAgents: 3 }, 'the record keeps the user’s own settings');
      assert.deepEqual(store.crossConversationStateFor('conversation', 'custom').offered, crossNames, 'the inherited switch applies at once');
    });

    await t.test('全局开启时下层自己的工具列表不挡住跨对话工具；全局关闭时 Agent 自己开启也能得到，后端编译一致', async () => {
      await withBackendSettings(async ({ configuration, compile, toolDefinitions, toolAllowedByPolicy, sync, apply }) => {
        const custom = await configuration.mutations.createAgent({ name: 'Custom', kind: 'custom' });
        // Lower scopes hold their own lists, which name none of the tools.
        await configuration.mutations.setToolPolicy({ scopeKind: 'agent', scopeId: custom.id, allowedTools: ['read', 'run_agent'] });
        await configuration.mutations.setToolPolicy({ scopeKind: 'conversation', scopeId: 'conversation:c', allowedTools: ['read', 'run_agent'] });
        const offered = (policy) => crossNames.filter((name) => toolAllowedByPolicy(policy, { name }));
        const { client, store, messages } = fresh(toolDefinitions());
        await sync(client);
        store.setCrossConversationCollaborationForScope('global', undefined, true);
        await apply(messages.at(-1));
        await sync(client);
        assert.deepEqual(offered(await compile(custom.id, 'conversation:c')), crossNames);
        assert.deepEqual(store.crossConversationStateFor('agent', custom.id).offered, crossNames);
        assert.deepEqual(offered(await compile('explore', 'conversation:explore')), readType, 'a read-only Agent gets list and read only');

        store.setCrossConversationCollaborationForScope('global', undefined, false);
        await apply(messages.at(-1));
        await sync(client);
        assert.deepEqual(offered(await compile(custom.id, 'conversation:c')), []);
        store.setCrossConversationCollaborationForScope('agent', custom.id, true);
        await apply(messages.at(-1));
        await sync(client);
        assert.deepEqual(offered(await compile(custom.id, 'conversation:c')), crossNames, 'the Agent turns the switch on for its own conversations');
        assert.deepEqual(offered(await compile('main', 'conversation:main')), [], 'other Agents keep the global switch off');
        assert.deepEqual(store.localPolicyFor('agent', custom.id).policy.allowedTools, ['read', 'run_agent'], 'the Agent list is untouched');
        assert.deepEqual(store.crossConversationStateFor('agent', custom.id).offered, crossNames);
      });
    });

    await t.test('工具设置里的跨对话工具由开关控制：勾选框不可用、点击不保存、启用全部不写入，仍可改为执行前确认', async () => {
      const { client, feed, store, bindings, render, messages } = fresh(allDefinitions);
      const tool = (name) => store.toolDefinitions.find((candidate) => candidate.name === name);
      const send = tool('send_conversation_message');
      store.setPolicyForScope('global', undefined, ['run_agent', 'read_file'], 'Global');
      let page = await bindings(toolEditor, { scopeKind: 'global' });
      assert.equal(page.isToolEnabled(send), false, 'off while the switch is off, whatever the list');
      const before = messages.length;
      page.setToolEnabled(send, true);
      assert.equal(messages.length, before, 'a click on a switch-granted tool saves nothing');

      store.setCrossConversationCollaborationForScope('global', undefined, true);
      page = await bindings(toolEditor, { scopeKind: 'global' });
      assert.equal(page.isToolEnabled(send), true);
      const html = await render(toolEditor, { scopeKind: 'global' });
      assert.match(html, /<button[^>]*aria-label="工具 send_conversation_message 由跨对话协作开关控制"[^>]*disabled/);
      assert.match(html, /由全局设置的「Agent 协作」页里的「跨对话协作」开关控制，不受这里的工具开关和工具列表影响/);
      page.setToolEnabled(send, false);
      assert.equal(store.effectivePolicyFor('global').policy.toolConfigs.run_agent.config.crossConversationCollaboration, true, 'the box cannot turn the switch off either');
      page.enableAll();
      assert.equal(store.localPolicyFor('global').policy.allowedTools.some((name) => crossNames.includes(name)), false, '启用全部 writes none of them');

      // Per-tool confirmation still applies to each tool.
      page.updateGateSetting(send, 'autoApproveExecution', false);
      assert.deepEqual(store.localPolicyFor('global').policy.toolConfigs.send_conversation_message, { config: {}, autoApproveExecution: false });
      assert.equal(store.effectivePolicyFor('agent', 'agent:any').policy.toolConfigs.send_conversation_message.autoApproveExecution, false);

      // A list saved before the switch became the grant may still name them: the names are ignored, and the next save drops them.
      client.toolPolicies = [...client.toolPolicies.filter((policy) => policy.id !== 'old'), { id: 'old', name: 'Old', allowedTools: ['read_file', 'send_conversation_message'],
        crossConversationGrantedTools: ['send_conversation_message'], toolConfigs: { run_agent: { config: { crossConversationCollaboration: false } } } }];
      client.toolPolicyScopeLinks = [...client.toolPolicyScopeLinks, { id: 'old-link', scopeKind: 'agent', scopeId: 'agent:old', toolPolicyId: 'old', role: 'active', createdAt: 1, updatedAt: 1 }];
      assert.equal((await bindings(toolEditor, { scopeKind: 'agent', scopeId: 'agent:old' })).isToolEnabled(send), false, 'the old list entry grants nothing');
      assert.deepEqual(store.crossConversationStateFor('agent', 'agent:old').offered, []);
      (await bindings(toolEditor, { scopeKind: 'agent', scopeId: 'agent:old' })).setToolEnabled(tool('write'), true);
      assert.deepEqual(messages.at(-1).payload.allowedTools, ['read_file', 'write']);
      assert.equal('crossConversationGrantedTools' in messages.at(-1).payload, false);

      // A child task conversation is never offered them.
      feed.records = { ChildExecution: { child: { id: 'child', child_conversation_id: 'child-conversation', status: 'active' } } };
      assert.equal((await bindings(toolEditor, { scopeKind: 'conversation', scopeId: 'child-conversation' })).isToolEnabled(send), false);
      // Its tool settings say the conversation that started it bounds them too; a top-level conversation's do not.
      assert.match(await render(toolEditor, { scopeKind: 'conversation', scopeId: 'child-conversation' }), /这是子 Agent 对话，工具还受派出它的对话限制/);
      assert.doesNotMatch(await render(toolEditor, { scopeKind: 'conversation', scopeId: 'plain' }), /受派出它的对话限制/);
      assert.match(await render(skillEditor, { scopeKind: 'conversation', scopeId: 'child-conversation' }), /这是子 Agent 对话，派出它的对话关掉的技能/);
      assert.doesNotMatch(await render(skillEditor, { scopeKind: 'conversation', scopeId: 'plain' }), /派出它的对话关掉的技能/);
      // A Plan the user approved to run in a new conversation is not bounded by the planning conversation.
      feed.projections = { activeConversationWindow: { conversationId: 'child-conversation', childConversationBoundary: {
        conversationId: 'child-conversation', childExecutionId: 'child', boundedByParent: false, workEnvironment: null } } };
      const delegatedTools = await render(toolEditor, { scopeKind: 'conversation', scopeId: 'child-conversation' });
      assert.doesNotMatch(delegatedTools, /工具还受派出它的对话限制/);
      assert.match(delegatedTools, /这是用户批准 Plan 后新开的子 Agent 对话，按执行 Agent 自己的工具设置运行，不受派出它的对话限制/);
      const delegatedSkills = await render(skillEditor, { scopeKind: 'conversation', scopeId: 'child-conversation' });
      assert.doesNotMatch(delegatedSkills, /派出它的对话关掉的技能/);
      assert.match(delegatedSkills, /这是用户批准 Plan 后新开的子 Agent 对话，按执行 Agent 自己的技能设置运行/);
      assert.equal((await bindings(toolEditor, { scopeKind: 'conversation', scopeId: 'child-conversation' })).isToolEnabled(send), false,
        'it is still a child task conversation without cross-conversation tools');
    });

    await t.test('工具设置的恢复继承只重置工具设置，保留 Agent 协作里的开关和上限', async () => {
      const { store, bindings, messages } = fresh(allDefinitions);
      store.setPolicyForScope('agent', 'worker', ['read_file'], 'Worker', {
        run_agent: { config: { crossConversationCollaboration: true, maxChildAgentDepth: 2 }, autoApproveExecution: false },
        read_file: { config: {}, autoApproveExecution: false }
      }, { exa: { enabled: true } }, 'yolo');
      (await bindings(toolEditor, { scopeKind: 'agent', scopeId: 'worker' })).restoreInheritance();
      const local = store.localPolicyFor('agent', 'worker').policy;
      assert.equal(local.allowedTools, undefined);
      assert.deepEqual(local.toolConfigs, { run_agent: { config: { crossConversationCollaboration: true, maxChildAgentDepth: 2 } } });
      assert.deepEqual(local.sourceConfigs, {});
      assert.equal(store.effectivePolicyFor('agent', 'worker').policy.preset, 'custom', 'the scope preset goes back to the global one');
      assert.equal('allowedTools' in messages.at(-1).payload, false);
      assert.deepEqual(store.crossConversationStateFor('agent', 'worker').offered, crossNames);

      // A record with nothing from the Agent 协作 area is removed, as before.
      store.setPolicyForScope('agent', 'plain', ['read_file'], 'Plain', { read_file: { config: {}, autoApproveExecution: false } });
      (await bindings(toolEditor, { scopeKind: 'agent', scopeId: 'plain' })).restoreInheritance();
      assert.equal(store.localPolicyFor('agent', 'plain').policy, undefined);
      assert.deepEqual(messages.at(-1).payload, { scopeKind: 'agent', scopeId: 'plain' });
      // Restoring the last collaboration override afterwards drops the record left behind.
      store.setAgentCollaborationFieldForScope('agent', 'worker', 'maxChildAgentDepth', undefined);
      store.setCrossConversationCollaborationForScope('agent', 'worker', undefined);
      assert.equal(store.localPolicyFor('agent', 'worker').policy, undefined);
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
      assert.match(html, /不提供发送、新建和分支对话工具；实际提供：list_conversations、read_conversation。/);
    });

    await t.test('上层工具列表不含跨对话工具时仍按开关提供，不再提示被上层挡住', async () => {
      const { store, render } = fresh(allDefinitions);
      store.setPolicyForScope('global', undefined, ['run_agent', 'read_file'], 'Global');
      store.setCrossConversationCollaborationForScope('conversation', 'below', true);
      const html = await render(editor, { scopeKind: 'conversation', scopeId: 'below' });
      assert.doesNotMatch(html, /上层工具策略/);
      assert.match(html, new RegExp(`当前生效：已开启，提供 ${crossNames.join('、')}。`));
    });
  } finally {
    pinia.setActivePinia(previousPinia);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  }
});
