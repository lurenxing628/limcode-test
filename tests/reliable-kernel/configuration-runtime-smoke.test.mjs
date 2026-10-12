import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { before, after, test } from 'node:test';
import { authorityAt, compiled, installVscode, ordinaryWire, provider, saveGlobal, seedProvider, Uri } from './configuration-smoke-fixture.mjs';

const host = installVscode();
let root, harness;
before(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-configuration-smoke-')); });
after(async () => {
  try { await harness?.close(); }
  finally { host.dispose(); if (root) await fs.rm(root, { recursive: true, force: true }); }
});
const settings = name => authorityAt(path.join(root, name));
const compile = async (authority, id, extra = {}) => JSON.parse((await authority.compile({
  conversationId: id, turnId: `turn:${id}`, executorAgentId: 'main', intentKind: 'input', ...extra
})).authoritySnapshot.content);

test('缺失设置目录只读默认，首次渠道保存成功且真实旧修订被拒绝', async () => {
  const { authority, paths } = settings('first-save');
  const llm = await authority.loadGlobalSettings('llm');
  const providers = await authority.loadGlobalSettings('llmProviderConfigs');
  await assert.rejects(fs.stat(path.dirname(paths.llmSettingsUri.fsPath)), { code: 'ENOENT' });
  const p = provider();
  await authority.saveGlobalSettings('llmProviderConfigs', { configs: [p] }, providers.revision);
  await authority.saveGlobalSettings('llm', { activeProviderConfigId: p.id }, llm.revision);
  const read = await authority.loadGlobalSettings('llm');
  assert.equal(read.settings.activeProviderConfigId, p.id);
  const current = await authority.loadGlobalSettings('llmProviderConfigs');
  await authority.saveGlobalSettings('llmProviderConfigs', { configs: [{ ...p, name: 'peer edit' }] }, current.revision);
  await assert.rejects(authority.saveGlobalSettings('llmProviderConfigs', current.settings, current.revision), error => error.settingsRevisionConflict === true);
});

test('共同记录存储只修改选中项，重复保存保持revision和其它记录', async () => {
  const { authority } = settings('delta');
  let saved = await saveGlobal(authority, 'llmProviderConfigs', { configs: [provider(), provider({ id: 'other', name: 'other' })] });
  const index = JSON.parse(await fs.readFile(saved.filePath, 'utf8'));
  const other = path.join(path.dirname(saved.filePath), index.records.find(row => row.id === 'other').file);
  const original = await fs.readFile(other, 'utf8'), oldRevision = saved.revision;
  const edited = structuredClone(saved.settings);
  edited.configs.find(config => config.id === 'smoke-provider').name = 'edited';
  saved = await authority.saveGlobalSettings('llmProviderConfigs', edited, saved.revision);
  assert.equal(await fs.readFile(other, 'utf8'), original);
  const bytes = await fs.readFile(saved.filePath, 'utf8');
  const repeated = await authority.saveGlobalSettings('llmProviderConfigs', saved.settings, saved.revision);
  assert.equal(repeated.revision, saved.revision);
  assert.equal(await fs.readFile(saved.filePath, 'utf8'), bytes);
  await assert.rejects(authority.saveGlobalSettings('llmProviderConfigs', edited, oldRevision), error => error.settingsRevisionConflict === true);
});

test('显式空上下文与恢复继承进入实际编译，后续Turn读取最新项目规则', async () => {
  const configRoot = path.join(root, 'prompts'), project = path.join(root, 'project');
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'PROJECT-A');
  const folder = { uri: Uri.file(project).toString(), rootPath: project, name: 'Project', index: 0 };
  const context = { globalStorageUri: Uri.file(configRoot), globalState: { get() {} } };
  const { authority } = authorityAt(configRoot, [folder], context);
  await seedProvider(authority);
  const request = { workspace: { uri: folder.uri } };
  const initial = await compile(authority, 'prompt', request);
  assert.match(initial.runtimeContext.text, /PROJECT-A/);
  await authority.mutations.setSystemPrompt({ scopeKind: 'global', text: 'MY PROMPT' });
  await authority.mutations.setRuntimeContext({ scopeKind: 'global', template: '' });
  const empty = await compile(authority, 'empty', request);
  assert.equal(empty.runtimeContext.template, '');
  assert.match(empty.systemPrompt.text, /MY PROMPT/);
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'PROJECT-B');
  const next = await compile(authority, 'next', { ...request, initialRuntimeContext: {
    id: initial.runtimeContext.id, name: initial.runtimeContext.name, template: initial.runtimeContext.template,
    text: initial.runtimeContext.renderedTemplateText
  } });
  assert.equal(next.runtimeContext.renderedTemplateText, initial.runtimeContext.renderedTemplateText);
  assert.match(next.runtimeContext.text, /PROJECT-B/);
  await authority.mutations.clearRuntimeContext('global');
  assert.equal((await compile(authority, 'restored', request)).runtimeContext.template,
    compiled('shared/promptTemplateCatalog.js').DEFAULT_RUNTIME_CONTEXT_TEMPLATE);
});

test('模型scope的peer revision、继承模型与配置根共同隔离旧写入', async () => {
  const { createVscodeStoragePaths } = compiled('backend/capabilities/vscodeStorage/paths.js');
  const { VscodeConfigurationAuthority } = compiled('backend/reliableKernel/vscodeConfigurationAuthority.js');
  let currentRoot = path.join(root, 'scope');
  const paths = () => createVscodeStoragePaths(Uri.file(currentRoot));
  const a = new VscodeConfigurationAuthority(paths), b = new VscodeConfigurationAuthority(paths);
  const p = await seedProvider(a), agent = await a.mutations.createAgent({ name: 'Scope', kind: 'custom' });
  const model = { providerConfigId: p.id, provider: p.provider, model: p.model };
  await a.mutations.setModelProfile({ scopeKind: 'agent', scopeId: agent.id, ...model });
  const scope = { scopeKind: 'conversation', scopeId: 'scope-conversation' };
  const ca = a.mutations.captureModelProfileRoot(), cb = b.mutations.captureModelProfileRoot();
  const effective = () => a.effectiveConversationModel(scope.scopeId, agent.id);
  const first = await a.mutations.readModelProfileScope(ca, scope, effective);
  const peer = await b.mutations.readModelProfileScope(cb, scope, effective);
  const mutation = { ...scope, ...model, authorityId: ca.authorityId, expectedRevision: first.revision,
    expectedEffectiveModel: model, operation: 'thinking', thinkingOverride: { kind: 'openai-effort', value: 'high' } };
  const saved = await a.mutations.writeModelProfileScope(ca, mutation, false, effective);
  assert.equal(saved.profile.inheritModel, true);
  await assert.rejects(b.mutations.writeModelProfileScope(cb, { ...mutation, authorityId: cb.authorityId,
    expectedRevision: peer.revision }, false, effective), /其他窗口/);
  await a.mutations.setModelProfile({ scopeKind: 'agent', scopeId: agent.id, ...model, model: 'o4-mini' });
  await assert.rejects(a.mutations.writeModelProfileScope(ca, { ...mutation, expectedRevision: saved.revision }, false, effective), /继承模型/);
  currentRoot = path.join(root, 'new-scope-root');
  await assert.rejects(a.mutations.writeModelProfileScope(ca, mutation, false, effective), /改变/);
  assert.equal((await a.mutations.readModelProfileScope(a.mutations.captureModelProfileRoot(), scope)).profile, undefined);
});

test('实际authority按Conversation与Workflow选择独立配置，工具上界及来源deny收窄', async () => {
  const { authority } = settings('layers');
  const p = await seedProvider(authority), agent = await authority.mutations.createAgent({ name: 'Layer', kind: 'custom' });
  const workflow = await authority.mutations.createWorkflow({ name: 'Flow' });
  await authority.mutations.selectConversationWorkflow({ conversationId: 'layers', scopeKind: 'workflow', workflowId: workflow.id });
  await authority.mutations.setModelProfile({ scopeKind: 'agent', scopeId: agent.id, providerConfigId: p.id, provider: p.provider, model: 'o3' });
  await authority.mutations.setModelProfile({ scopeKind: 'conversation', scopeId: 'layers', providerConfigId: p.id, provider: p.provider, model: 'o4-mini' });
  await authority.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['read', 'bash'], sourceConfigs: { exa: { enabled: false } } });
  await authority.mutations.setToolPolicy({ scopeKind: 'workflow', scopeId: workflow.id, allowedTools: ['read'], sourceConfigs: { exa: { enabled: true } } });
  const frozen = await compile(authority, 'layers', { executorAgentId: agent.id });
  assert.equal(frozen.model.modelId, 'o4-mini');
  assert.deepEqual(frozen.toolPolicy.allowedTools, ['read']);
  assert.equal(frozen.toolPolicy.sourceConfigs.exa.enabled, false);
  const view = await authority.configurationClientState();
  const link = view.modelProfileScopeLinks.find(row => row.scopeId === 'layers');
  assert.equal(view.modelProfiles.find(row => row.id === link.modelProfileId).model, 'o4-mini');
});

test('Fork只填目标空位，目标后续编辑与源和全局配置独立', async () => {
  const { authority } = settings('fork');
  const p = await seedProvider(authority), m = authority.mutations;
  await m.setSystemPrompt({ scopeKind: 'global', text: 'GLOBAL' });
  await m.setSystemPrompt({ scopeKind: 'conversation', scopeId: 'source', text: 'SOURCE' });
  await m.setSystemPrompt({ scopeKind: 'conversation', scopeId: 'target', text: 'TARGET' });
  await m.setModelProfile({ scopeKind: 'conversation', scopeId: 'source', providerConfigId: p.id, provider: p.provider, model: 'o4-mini' });
  await m.setToolPolicy({ scopeKind: 'conversation', scopeId: 'source', allowedTools: ['read', 'run_agent'], toolConfigs: { run_agent: { config: { maxChildAgentDepth: 2 } } } });
  await m.copyConversationConfiguration('source', 'target');
  const before = await authority.configurationClientState();
  const model = id => before.modelProfiles.find(row => row.id === before.modelProfileScopeLinks.find(link => link.scopeId === id).modelProfileId);
  assert.notEqual(model('source').id, model('target').id);
  assert.equal(model('target').model, 'o4-mini');
  const promptId = before.systemPromptScopeLinks.find(row => row.scopeId === 'target').systemPromptId;
  assert.equal(before.systemPrompts.find(row => row.id === promptId).text, 'TARGET');
  await m.setModelProfile({ scopeKind: 'conversation', scopeId: 'target', providerConfigId: p.id, provider: p.provider, model: 'o3' });
  assert.equal((await compile(authority, 'source')).model.modelId, 'o4-mini');
  assert.equal((await compile(authority, 'target')).model.modelId, 'o3');
  assert.equal((await authority.configurationClientState()).systemPrompts.find(row => row.id === promptId).text, 'TARGET');
});

test('实际新请求冻结新思考值，自动重试和replay保留原请求快照', async () => {
  const f = await kernelHarness();
  await f.addConversation('request-freeze');
  await f.set('request-freeze', 'high');
  let count = 0;
  f.hooks = { async send(request, controls) {
    count++;
    if (count === 1) {
      await f.set('request-freeze', 'medium');
      throw new f.kernel.ProviderTransientError('temporary_service_error', 'smoke retry');
    }
    await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: count === 2
      ? [{ id: 'counter', functionCall: { name: 'counter', args: {} } }] : [{ text: 'done' }] } });
  } };
  await f.app.agentLoop.runInput(f.input('request-freeze', 'freeze-first'));
  const requests = f.requests.filter(request => request.conversationId === 'request-freeze');
  assert.equal(requests[0].modelRequestId, requests[1].modelRequestId);
  assert.deepEqual(f.wires.filter(w => w.conversationId === 'request-freeze').map(w => w.body.reasoning_effort), ['high', 'high', 'medium']);
  const replay = await f.app.modelProvider.replay(requests[0].modelRequestId);
  assert.equal(replay.authoritySnapshot.model.generationConfig.thinkingConfig.thinkingLevel, 'high');
  await f.set('request-freeze', null);
  await f.app.agentLoop.runInput(f.input('request-freeze', 'freeze-next'));
  assert.equal(f.wires.at(-1).body.reasoning_effort, 'low');
});

test('Gemini预算零经过生产adapter形成thinkingBudget零', async () => {
  const { applySessionThinkingOverride, validateSessionThinkingOverride } = compiled('shared/sessionThinking.js');
  const override = { kind: 'gemini-budget', tokens: 0 };
  validateSessionThinkingOverride(override, 'gemini', 'gemini-2.5-flash');
  const wire = await ordinaryWire('gemini', 'gemini-2.5-flash', applySessionThinkingOverride(undefined, override));
  assert.equal(wire.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.equal(wire.later_setting, undefined);
});

test('Claude adaptive effort进入实际wire，冲突采样覆盖拒绝且原配置保留', async () => {
  const { applySessionThinkingOverride, validateSessionThinkingOverride } = compiled('shared/sessionThinking.js');
  const { hasThinkingBodyConflict } = compiled('shared/sessionThinkingBody.js');
  const override = { kind: 'claude-effort', value: 'high' };
  const defaults = { maxOutputTokens: 8192 };
  validateSessionThinkingOverride(override, 'claude', 'claude-opus-4-6', defaults);
  const wire = await ordinaryWire('claude', 'claude-opus-4-6', applySessionThinkingOverride(defaults, override));
  assert.equal(wire.thinking.type, 'adaptive');
  assert.equal(wire.output_config.effort, 'high');
  const invalid = { ...defaults, temperature: 0.7 };
  assert.throws(() => validateSessionThinkingOverride({ kind: 'claude-budget', tokens: 2048 }, 'claude', 'claude-sonnet-4-5', invalid), /采样|temperature|top/);
  assert.deepEqual(invalid, { maxOutputTokens: 8192, temperature: 0.7 });
  assert.equal(hasThinkingBodyConflict('claude', { thinking: { type: 'disabled' } }), true);
});

test('子Agent初始化中断恢复冻结思考继承，父链深度上界仍限制新spawn', async () => {
  const f = await kernelHarness();
  await f.addConversation('child-parent');
  await f.configuration.mutations.setModelProfile({ scopeKind: 'conversation', scopeId: 'child-parent',
    providerConfigId: f.p.id, provider: f.p.provider, model: f.p.model,
    thinkingOverride: { kind: 'openai-effort', value: 'high' }, inheritThinkingToChildren: true });
  const mutations = f.configuration.mutations, initialize = mutations.initializeConversationModelProfile;
  let interrupted = false;
  mutations.initializeConversationModelProfile = async function(...args) {
    if (!interrupted) { interrupted = true; throw new Error('smoke profile initialization interruption'); }
    return initialize.apply(this, args);
  };
  const seen = new Set();
  f.hooks = { maxDepth: 1, async send(request, controls) {
    const first = !seen.has(request.conversationId);
    seen.add(request.conversationId);
    await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: first
      ? [{ id: `spawn:${request.conversationId}`, functionCall: { name: 'run_agent', args: {
        operation: 'spawn', taskName: 'smoke child', prompt: 'check inherited thinking' } } }]
      : [{ text: 'done' }] } });
  } };
  try {
    await f.app.agentLoop.runInput(f.input('child-parent', 'spawn-after-interruption'));
    await f.coordinator.waitForIdle();
    assert.equal(interrupted, true);
    await f.coordinator.recoverStartup();
    await f.coordinator.waitForIdle();
    const children = await f.rows('ChildExecution');
    assert.equal(children.length, 1, 'the child at the limit cannot create a grandchild');
    const childWires = f.wires.filter(wire => wire.conversationId === children[0].child_conversation_id);
    assert.ok(childWires.length);
    assert.ok(childWires.every(wire => wire.body.reasoning_effort === 'high'));
    const childCalls = await f.rows('ToolCall');
    assert.ok(childCalls.some(call => call.tool_name === 'run_agent' && call.status !== 'succeeded'));
  } finally { mutations.initializeConversationModelProfile = initialize; }
});

test('MCP只读scope的来源deny约束提供与实际dispatcher准入，确切scope才能开启', async () => {
  const { authority } = settings('mcp');
  await seedProvider(authority);
  await authority.mutations.setToolPolicy({ scopeKind: 'global', sourceConfigs: { exa: { enabled: true } } });
  await authority.mutations.setToolPolicy({ scopeKind: 'conversation', scopeId: 'readonly', sourceConfigs: { exa: { enabled: true } } });
  const tool = { name: 'exa_search', source: { kind: 'mcp', sourceId: 'exa', originalToolName: 'search' } };
  const { toolAllowedByPolicy } = compiled('shared/toolPolicyResolution.js');
  const frozen = await compile(authority, 'readonly', { executorAgentId: 'explore' });
  assert.equal(toolAllowedByPolicy(frozen.toolPolicy, tool), false);
  const denied = await directAdmission(tool, frozen);
  assert.equal(denied.reached, false);
  assert.match(denied.rejected[0], /ToolPolicy/);
  await authority.mutations.setToolPolicy({ scopeKind: 'agent', scopeId: 'explore', sourceConfigs: { exa: { enabled: true } } });
  const opened = await compile(authority, 'readonly', { executorAgentId: 'explore' });
  assert.equal(toolAllowedByPolicy(opened.toolPolicy, tool), true);
  assert.equal((await directAdmission(tool, opened)).reached, true);
});

test('MCP稳定模型名独立于输入顺序，授权仍按来源和原始工具名', () => {
  const { dedupeMcpToolNames } = compiled('backend/application/mcpRuntimeManager.js');
  const { toolAllowedByPolicy } = compiled('shared/toolPolicyResolution.js');
  const original = `${'query'.repeat(16)}:中文`;
  const tool = sourceId => ({ execution: 'runtime', declaration: { name: 'postgres_query', description: 'smoke', parameters: { type: 'object' },
    source: { kind: 'mcp', sourceId, sourceName: 'Postgres', originalToolName: original } }, async execute() {} });
  const a = tool('a'), b = tool('b');
  const forward = dedupeMcpToolNames([a, b], []), backward = dedupeMcpToolNames([b, a], []);
  const names = tools => Object.fromEntries(tools.map(t => [t.declaration.source.sourceId, t.declaration.name]));
  assert.deepEqual(names(forward), names(backward));
  assert.notEqual(names(forward).a, names(forward).b);
  assert.match(names(forward).a, /^[a-zA-Z0-9_-]{1,64}$/);
  const policy = { allowedTools: [], sourceConfigs: { a: { enabled: true, disabledTools: [original] }, b: { enabled: true } } };
  assert.equal(toolAllowedByPolicy(policy, forward.find(t => t.declaration.source.sourceId === 'a').declaration), false);
  assert.equal(toolAllowedByPolicy(policy, forward.find(t => t.declaration.source.sourceId === 'b').declaration), true);
});

async function directAdmission(declaration, document) {
  const { ReliableToolDispatcher } = compiled('backend/reliableKernel/toolDispatcher.js');
  const records = {
    ToolCall: [{ id: 'call', turn_id: 'turn', tool_name: declaration.name, call_seq: 1n, status: 'pending' }],
    AuthoritySnapshot: [{ id: 'authority', turn_id: 'turn', content_object_id: 'authority-content' }],
    ContentObject: [{ id: 'authority-content' }], Turn: [{ id: 'turn', conversation_id: 'readonly', status: 'active' }]
  };
  const matching = read => (records[read.domain] ?? []).filter(row => Object.entries(read.where ?? {}).every(([key, value]) => row[key] === value));
  const rejected = [], reached = { value: false }, external = new Error('external MCP reached');
  const dispatcher = new ReliableToolDispatcher({
    database: {
      async snapshot(reads) { return { snapshot: reads.map(read => read.kind === 'get' ? (records[read.domain] ?? []).find(row => row.id === read.id) : matching(read)) }; },
      async snapshotAll(read) { return { snapshot: matching(read) }; }
    }, contentStore: { async read() { return Buffer.from(JSON.stringify(document)); } },
    effects: { subscribeToolModelResults() { return () => {}; }, async finalizeReadyInOrder() {}, async readTerminalResult() { return null; },
      async settleWithoutEffect(input) { rejected.push(input.detail.reason); return { status: input.status }; } },
    mcp: { async prepare() { reached.value = true; throw external; } },
    host: { definitions: () => [{ execution: 'runtime', declaration, async execute() { throw new Error('native dispatch required'); } }] }
  });
  try {
    await dispatcher.dispatch({ turnId: 'turn', modelRequestId: 'request', toolCallId: 'call', toolName: declaration.name, arguments: {} });
  } catch (error) { if (error !== external) throw error; }
  finally { await dispatcher.dispose(); }
  return { rejected, reached: reached.value };
}

async function kernelHarness() {
  if (harness) return harness;
  const kernel = compiled('backend/reliableKernel/index.js');
  const { emptyConversationContextHandleStateStep } = compiled('backend/reliableKernel/conversationContextHandleState.js');
  const { childConversationModelProfiles } = compiled('backend/reliableKernel/childThinkingInheritance.js');
  const { readFrozenTurnAuthority } = compiled('backend/reliableKernel/frozenAuthority.js');
  const { dryRunLlmProvider } = compiled('backend/capabilities/llmProvider.js');
  const { applyFrozenModelProviderConfig } = compiled('backend/reliableKernel/llmCapabilityProviderRegistry.js');
  const { LlmEventType } = compiled('backend/world/modules/llm/events.js');
  const { authority: configuration } = settings('kernel-settings'), p = await seedProvider(configuration);
  const agent = await configuration.mutations.createAgent({ name: 'Kernel', kind: 'custom' });
  const childAgent = await configuration.mutations.createAgent({ name: 'Child', kind: 'custom' });
  await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['counter', 'run_agent'],
    toolConfigs: { run_agent: { config: { maxChildAgentDepth: 1 } } } });
  const authority = new kernel.RootAuthority(() => path.join(root, 'kernel'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const f = { kernel, configuration, p, agent, childAgent, requests: [], wires: [], hooks: {} };
  let app, coordinator;
  try {
    const rows = async (domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain)
      .list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))).snapshot;
    const frozen = async turnId => {
      const [row] = await rows('AuthoritySnapshot', { turn_id: turnId });
      return readFrozenTurnAuthority(app.database, app.contentStore, row.id, turnId);
    };
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: configuration, compressionSettingsAuthority: configuration, attachmentSettings: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { return null; } },
      mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
      providers: { resolve(providerId) { return { providerId, async sendFullRequest(request, controls) {
        f.requests.push(request);
        let projected;
        const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
          start(input, emit) { projected = input; emit({ type: LlmEventType.Done, payload: { requestId: input.id } }); }, abort() {}, dispose() {}
        });
        await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, terminal: true, checkpointed: true }; } });
        const effective = applyFrozenModelProviderConfig(await configuration.providerConfig(providerId), request.modelId);
        const wire = await dryRunLlmProvider(projected, { settings: { ...effective, baseUrl: 'https://example.invalid/v1', apiKey: '' } });
        f.wires.push({ conversationId: request.conversationId, body: wire.body });
        if (f.hooks.send) return f.hooks.send(request, controls);
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: 'done' }] } });
      } }; } },
      toolDispatcher: {
        definitions() { return ['counter', 'run_agent'].map(name => ({ name, description: 'smoke', parameters: { type: 'object', properties: {} }, metadata: { readonly: true } })); },
        async dispatch(input) {
          if (input.toolName === 'run_agent') {
            const authority = await frozen(input.turnId);
            return coordinator.dispatch(input, undefined, { snapshotId: authority.snapshot.id, document: authority.document,
              toolConfig: { config: { maxChildAgentDepth: f.hooks.maxDepth ?? 1 } } });
          }
          const settled = await app.runtime.effects.settleWithoutEffect({ source: { kind: 'internal', key: `counter:${input.toolCallId}` },
            toolCallId: input.toolCallId, status: 'succeeded', detail: { count: 1 } });
          return settled.terminal ?? app.runtime.effects.readTerminalResult(input.toolCallId, true);
        }
      }
    });
    const { ReliableChildAgentCoordinator } = compiled('backend/reliableKernel/childAgentCoordinator.js');
    coordinator = new ReliableChildAgentCoordinator({ database: app.database, ...app.runtime,
      modelProvider: app.modelProvider, turns: app.turns, agentLoop: app.agentLoop,
      agents: { async resolve() { return { agentId: childAgent.id, agentType: 'worker' }; } },
      modelProfiles: childConversationModelProfiles(configuration.mutations) });
    Object.assign(f, { app, coordinator, rows,
      set: (conversationId, value) => configuration.mutations.setModelProfile({ scopeKind: 'conversation', scopeId: conversationId,
        providerConfigId: p.id, provider: p.provider, model: p.model, thinkingOverride: value ? { kind: 'openai-effort', value } : null }),
      async addConversation(id) {
        const now = new Date().toISOString();
        await app.database.transaction([
          kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id, title: id, status: 'active', created_at: now, updated_at: now }),
          emptyConversationContextHandleStateStep(id, now),
          kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: `agent:${id}`, conversation_id: id, agent_id: agent.id,
            role: 'default', created_at: now, updated_at: now })
        ]);
      },
      input: (conversationId, key) => ({ source: { kind: 'command', key }, conversationId, leaseOwnerId: 'smoke-owner',
        hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), content: 'smoke input' }),
      async close() { try { await coordinator.dispose(); } finally { await app.close(); } }
    });
    harness = f;
    return f;
  } catch (error) {
    try { await coordinator?.dispose(); } finally { await app?.close(); }
    throw error;
  }
}
