import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { createConfigurationUiGraph } from './configuration-ui-fixture.mjs';
import { authorityAt, compiled, installVscode, seedProvider, temporaryRoot, Uri } from './configuration-smoke-fixture.mjs';

const host = installVscode(), protocol = compiled('shared/protocol.js'), T = protocol.BridgeMessageType;
let graph;
before(async () => { graph = await createConfigurationUiGraph(); });
after(async () => { try { await graph?.close(); } finally { host.dispose(); } });

function globals(t) {
  const f = graph.session(t), section = 'llmCompressionConfigs';
  const config = { ...protocol.createDefaultLlmCompressionConfig('smoke'),
    trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 120000 } };
  const initial = { section, settings: { configs: [config] }, filePath: 'fixture', revision: 'initial' };
  f.global.applySnapshot(initial);
  return Object.assign(f, { initial, section,
    edit(value) { f.global.llmCompressionConfigs.configs[0].trigger.thresholdTokens = value; f.global.queueLlmCompressionConfigsAutoSave(); },
    writes: () => f.messagesOf(T.GlobalSettingsUpdate).filter(message => message.payload.section === section),
    reads: () => f.messagesOf(T.GlobalSettingsGet).filter(message => message.payload.section === section),
    ack(write) { f.global.applySnapshot({ ...initial, revision: `saved:${write.id}`, settings: write.payload.settings }, write.id); }
  });
}

test('Agent 删除子任务开关默认关闭，保存与恢复继承只修改对应配置', async t => {
  const f = graph.session(t);
  const { createBuiltinToolDefinitions } = compiled('backend/world/modules/tools/definitions/index.js');
  const { commandDeclarationCapability } = compiled('backend/reliableKernel/builtinToolCatalog.js');
  const { toolDefinitionRecord } = compiled('backend/world/modules/tools/registry.js');
  f.client.configurationReady = true;
  f.client.toolDefinitions = createBuiltinToolDefinitions({ command: commandDeclarationCapability() }).map(toolDefinitionRecord);
  const { view } = f.mount('Collaboration', { scopeKind: 'agent', scopeId: 'worker' });
  assert.equal(view.deleteChildField.enabled, false);
  view.setDeleteChild(true);
  const write = f.last(T.ToolPolicyScopeSet);
  assert.equal(write.payload.toolConfigs.run_agent.config.allowDeleteSubagents, true);
  assert.equal(write.payload.allowedTools, undefined);
  f.client.toolPolicies = [{ id: 'delete-global', name: 'Global', toolConfigs: { run_agent: { config: { allowDeleteSubagents: true } } } },
    { id: 'delete-agent', name: 'Agent', toolConfigs: { run_agent: { config: { allowDeleteSubagents: false, maxChildAgentDepth: 2 } } } }];
  f.client.toolPolicyScopeLinks = [{ id: 'delete-global-link', scopeKind: 'global', role: 'active', toolPolicyId: 'delete-global' },
    { id: 'delete-agent-link', scopeKind: 'agent', scopeId: 'worker', role: 'active', toolPolicyId: 'delete-agent' }];
  assert.equal(view.deleteChildField.enabled, false);
  view.setDeleteChild(undefined);
  const restore = f.last(T.ToolPolicyScopeSet);
  assert.equal(restore.payload.toolConfigs.run_agent.config.allowDeleteSubagents, undefined);
  assert.equal(restore.payload.toolConfigs.run_agent.config.maxChildAgentDepth, 2);
  f.client.toolPolicies[1].toolConfigs.run_agent.config = { maxChildAgentDepth: 2 };
  assert.equal(view.deleteChildField.enabled, true);
});

test('真实自动保存仅在最新编辑和多面板确认到齐后放行', async t => {
  const f = globals(t), { GlobalSettingsSaveBarrier } = compiled('backend/application/reliableKernel/GlobalSettingsSaveBarrier.js');
  const barrier = new GlobalSettingsSaveBarrier(1000), flushMessages = [];
  let firstSave;
  barrier.attach('settings', { async postMessage(message) {
    flushMessages.push(message);
    firstSave = f.global.flushForExecution().then(() => barrier.receive('settings', message.id, { status: 'saved' }));
    return true;
  } });
  barrier.attach('other', { async postMessage(message) { flushMessages.push(message); return true; } });
  t.after(() => barrier.detach('settings'));
  t.after(() => barrier.detach('other'));
  f.edit(40000);
  let finished = false;
  const flushing = barrier.flush().then(() => { finished = true; });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.writes().length, 1);
  f.edit(50000); f.global.saveLlmCompressionConfigs();
  f.ack(f.writes()[0]); await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(f.writes()[1].payload.settings.configs[0].trigger.thresholdTokens, 50000);
  f.ack(f.writes()[1]);
  await firstSave;
  assert.equal(finished, false, 'the other panel still has no receipt');
  barrier.receive('other', 'wrong-id', { status: 'saved' });
  assert.equal(finished, false);
  barrier.detach('other');
  await flushing;
  assert.equal(finished, true);
  assert.doesNotThrow(() => structuredClone(f.writes()[1].payload));
});

test('同字段外部冲突保留草稿，明确选择后按新revision保存', async t => {
  const f = globals(t);
  f.edit(40000); await f.clock.advance(400);
  const first = f.writes()[0], external = structuredClone(f.initial);
  external.revision = 'peer'; external.settings.configs[0].trigger.thresholdTokens = 60000;
  f.global.applySnapshot(external);
  f.global.setError('修订冲突', { section: f.section, code: 'settings_revision_conflict', correlationId: first.id });
  assert.equal(f.global.llmCompressionConfigs.configs[0].trigger.thresholdTokens, 40000);
  await assert.rejects(f.global.flushForExecution(), /其他窗口/);
  f.global.dismissExternalSettingsChange(f.section);
  assert.equal(f.writes()[1].payload.expectedRevision, 'peer');
  f.ack(f.writes()[1]);
  await f.global.flushForExecution();
});

test('丢失ACK后生产store核对磁盘并提交最新排队草稿，旧ACK不倒退', async t => {
  const f = globals(t);
  f.edit(40000); await f.clock.advance(400);
  const first = f.writes()[0];
  f.edit(50000); await f.clock.advance(5000);
  assert.equal(f.reads().length, 1);
  f.global.applySnapshot({ ...f.initial, revision: 'first-committed', settings: first.payload.settings }, f.reads()[0].id);
  assert.equal(f.writes().length, 2);
  assert.equal(f.writes()[1].payload.settings.configs[0].trigger.thresholdTokens, 50000);
  f.ack(f.writes()[1]); f.ack(first);
  await f.global.flushForExecution();
  assert.equal(f.global.llmCompressionConfigs.configs[0].trigger.thresholdTokens, 50000);
});

test('实际prompt编辑器的早期草稿与保存后新编辑都不会被旧快照擦掉', async t => {
  const f = graph.session(t), mounted = f.mount('Prompt', { scopeKind: 'conversation', scopeId: 'prompt' }), { view } = mounted;
  f.client.configurationReady = false;
  view.draft = 'typed before load';
  f.client.systemPrompts = [{ id: 'prompt-record', name: 'smoke', text: 'saved prompt' }];
  f.client.systemPromptScopeLinks = [{ id: 'prompt-link', scopeKind: 'conversation', scopeId: 'prompt',
    systemPromptId: 'prompt-record', role: 'active', createdAt: 1, updatedAt: 1 }];
  await graph.vue.nextTick();
  assert.equal(view.draft, 'typed before load');
  view.inheritMode = false;
  view.save(); const request = f.messages.at(-1);
  view.draft = 'newer local draft';
  await mounted.setProps({ scopeId: 'other-prompt' });
  view.draft = 'other object draft';
  f.client.systemPrompts[0].text = 'typed before load';
  f.client.systemPromptScopeLinks[0].updatedAt = 2;
  f.prompts.reconcilePendingSave(request.id);
  await graph.vue.nextTick();
  assert.equal(view.draft, 'other object draft');
  await mounted.setProps({ scopeId: 'prompt' });
  assert.equal(view.draft, 'newer local draft');
  view.draftState.reset();
  assert.equal(view.draft, 'typed before load');
});

function modelSnapshot(id, sequence, value, authorityId = 'authority') {
  const model = { providerConfigId: 'provider', provider: 'openai-compatible', model: 'o3' };
  const profile = value ? { id: `profile:${id}`, name: 'Model', ...model, thinkingOverride: { kind: 'openai-effort', value } } : undefined;
  return { scopeKind: 'conversation', scopeId: id, authorityId, sessionId: `session:${id}:${authorityId}`,
    revision: String(sequence), sequence, outcome: 'observed', effectiveModel: model,
    profileState: profile ? 'overridden' : 'absent', ...(profile ? { profile,
      link: { id: `link:${id}`, scopeKind: 'conversation', scopeId: id, modelProfileId: profile.id, role: 'active', createdAt: 1, updatedAt: sequence } } : {}) };
}

function activate(f, id, value) {
  const release = f.models.activateScope('conversation', id), read = f.last(T.ModelProfileScopeRead);
  f.models.applyScopeSnapshot(modelSnapshot(id, 1, value), read.id);
  return release;
}

function ackThinking(f, write, sequence, value) {
  f.models.applyScopeSnapshot({ ...modelSnapshot(write.payload.scopeId, sequence, value), outcome: 'committed',
    operation: write.payload.operation, expectedRevision: write.payload.expectedRevision }, write.id);
}

test('真实model编辑器的排队Save只接受自己的ACK，thinking控件写显式继承值', async t => {
  const f = graph.session(t);
  f.global.llmProviderConfigs.configs = [{ id: 'provider', name: 'smoke', provider: 'openai-compatible', model: 'A', models: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }] }];
  const mounted = f.mount('Model', { scopeKind: 'agent', scopeId: 'agent' }), { view } = mounted;
  const read = f.last(T.ModelProfileScopeRead);
  const profile = { id: 'profile', name: 'Model', providerConfigId: 'provider', provider: 'openai-compatible', model: 'A' };
  const base = { scopeKind: 'agent', scopeId: 'agent', authorityId: 'authority', sessionId: 'session', profileState: 'default',
    profile, link: { id: 'link', scopeKind: 'agent', scopeId: 'agent', modelProfileId: 'profile', role: 'active', createdAt: 1, updatedAt: 1 } };
  f.models.applyScopeSnapshot({ ...base, sequence: 1, revision: '1', outcome: 'observed' }, read.id);
  const ack = (write, sequence) => f.models.applyScopeSnapshot({ ...base, profile: { ...profile, model: write.payload.model },
    sequence, revision: String(sequence), outcome: 'committed', operation: write.payload.operation,
    expectedRevision: write.payload.expectedRevision }, write.id);
  view.model = 'B'; view.save(); const first = f.last(T.ModelProfileScopeSet);
  view.model = 'A'; view.save();
  assert.equal(f.messagesOf(T.ModelProfileScopeSet).length, 1);
  ack(first, 2); await graph.vue.nextTick();
  const second = f.last(T.ModelProfileScopeSet);
  assert.notEqual(first.id, second.id);
  assert.equal(view.draftState.dirty.value, true);
  ack(second, 3); await graph.vue.nextTick();
  assert.equal(view.draftState.dirty.value, false);
  view.model = 'B'; view.save();
  view.model = 'C'; view.discardDraft();
  const discardRead = f.last(T.ModelProfileScopeRead);
  await mounted.setProps({ scopeId: 'other-agent' });
  view.model = 'other draft';
  f.models.applyScopeSnapshot({ ...base, profile: { ...profile, model: 'B' },
    sequence: 4, revision: '4', outcome: 'observed', afterRequestId: discardRead.payload.afterRequestId }, discardRead.id);
  assert.equal(f.models.pendingFor('agent', 'agent'), undefined);
  assert.equal(view.model, 'other draft', '原对象的丢弃读取不能改当前对象');
  await mounted.setProps({ scopeId: 'agent' });
  assert.equal(view.model, 'B', '回到原对象不能恢复已放弃的C');
  assert.equal(view.draftState.dirty.value, false);
  const staleReset = view.draftState.prepareReset();
  view.model = 'C';
  await mounted.setProps({ scopeId: 'other-agent' });
  staleReset();
  await mounted.setProps({ scopeId: 'agent' });
  assert.equal(view.model, 'C', '原scope在读取后新编辑的缓存仍需保留');
  view.draftState.reset();
  view.providerConfigId = '__inherit_global_model__';
  assert.equal(f.messagesOf(T.ModelProfileScopeClear).length, 0, '继承选择和普通选择一样只修改草稿');
  view.save();
  assert.equal(f.last(T.ModelProfileScopeClear).payload.scopeId, 'agent');
  const release = activate(f, 'thinking', 'high'); t.after(release);
  const thinking = f.mount('Thinking', { conversationId: 'thinking', model: 'o3', config: {
    id: 'provider', provider: 'openai-compatible', model: 'o3', modelConfigs: [] } }).view;
  thinking.setInheritance(true);
  const inherit = f.last(T.ModelProfileScopeSet);
  assert.equal(inherit.payload.operation, 'inherit');
  assert.equal(inherit.payload.inheritThinkingToChildren, true);
  assert.doesNotThrow(() => structuredClone(inherit.payload));
});

test('Agent 模型下拉展示渠道默认配置，切换渠道重置模型且选择只修改草稿', async t => {
  const f = channelSettings(t);
  const { view } = f.mount('Model', { scopeKind: 'agent', scopeId: 'worker' });
  const read = f.last(T.ModelProfileScopeRead);
  f.models.applyScopeSnapshot({ ...modelSnapshot('worker', 1), scopeKind: 'agent' }, read.id);
  assert.equal(view.isInheritSelected, true);
  assert.match(view.modelOptions[0].label, /渠道默认配置/);
  view.selectedProviderConfigId = 'B';
  assert.equal(view.model, 'B-one');
  assert.equal(view.modelOptions[0].value, 'B-one');
  assert.match(view.modelOptions[0].label, /渠道默认配置/);
  assert.ok(view.modelOptions.some(option => option.value === 'B-two'));
  view.model = 'B-two';
  view.selectedProviderConfigId = 'A';
  assert.equal(view.model, 'A-one', '不能把另一个渠道的模型带入新渠道');
  assert.equal(f.global.llm.activeProviderConfigId, 'A');
  assert.equal(f.messagesOf(T.ModelProfileScopeSet).length, 0);
  view.save();
  const saved = f.last(T.ModelProfileScopeSet);
  assert.equal(saved.payload.scopeKind, 'agent');
  assert.equal(saved.payload.scopeId, 'worker');
  assert.equal(saved.payload.providerConfigId, 'A');
  assert.equal(saved.payload.model, 'A-one');
});

test('Agent 从选中渠道获取并添加模型，不改变全局渠道或默认模型', async t => {
  const f = channelSettings(t);
  const { view } = f.mount('Model', { scopeKind: 'agent', scopeId: 'worker' });
  view.selectedProviderConfigId = 'B';
  view.fetchModels();
  const request = f.last(T.LlmProviderModelsGet);
  assert.equal(request.payload.config.id, 'B');
  assert.equal(view.modelFetchDialog.loading, true);
  f.global.applyLlmProviderModelsSnapshot(modelListResponse(request, 'B-fetched'), request.id);
  assert.equal(view.modelFetchDialog.loading, false);
  view.addFetchedModels(view.modelFetchDialog.models);
  assert.equal(f.global.fetchedModelsDialog.open, false);
  assert.ok(view.modelOptions.some(option => option.value === 'B-fetched'));
  assert.equal(view.model, 'B-one', '添加模型不隐式选中它');
  assert.equal(f.global.llm.activeProviderConfigId, 'A');
  const config = f.global.llmProviderConfigs.configs.find(item => item.id === 'B');
  assert.equal(config.model, 'B-one');
  view.confirmManualModel(' B-custom ');
  assert.equal(view.model, 'B-custom');
  assert.ok(config.models.some(item => item.id === 'B-custom'));
  assert.equal(config.model, 'B-one');
  assert.equal(f.global.llm.activeProviderConfigId, 'A');
});

test('Agent 获取模型时切换渠道或 Agent 关闭旧弹窗，迟到响应不改新目标', async t => {
  const f = channelSettings(t);
  const mounted = f.mount('Model', { scopeKind: 'agent', scopeId: 'worker' }), { view } = mounted;
  view.selectedProviderConfigId = 'B'; view.fetchModels();
  const old = f.last(T.LlmProviderModelsGet);
  view.selectedProviderConfigId = 'A';
  assert.equal(f.global.fetchedModelsDialog.open, false);
  f.global.applyLlmProviderModelsSnapshot(modelListResponse(old, 'B-late'), old.id);
  assert.equal(view.model, 'A-one');
  assert.ok(!view.modelOptions.some(option => option.value === 'B-late'));
  view.fetchModels();
  view.manualModelOpen = true;
  await mounted.setProps({ scopeId: 'another-agent' });
  assert.equal(f.global.fetchedModelsDialog.open, false);
  assert.equal(view.manualModelOpen, false);
});

test('新root重连保留草稿，迟到旧保存与错误不恢复旧scope', async t => {
  const f = graph.session(t), release = activate(f, 'root-change'); t.after(release);
  f.models.setThinkingForScope('root-change', { providerConfigId: 'provider', provider: 'openai-compatible', model: 'o3' }, { kind: 'openai-effort', value: 'high' });
  const old = f.last(T.ModelProfileScopeSet);
  f.models.rejectPending(old.id, 'host restarted');
  f.models.refreshScope('conversation', 'root-change', { adoptRoot: true });
  f.models.applyScopeSnapshot(modelSnapshot('root-change', 1, undefined, 'new-root'), f.last(T.ModelProfileScopeRead).id);
  ackThinking(f, old, 99, 'high');
  f.models.rejectPending(old.id, 'late old error');
  assert.equal(f.models.confirmedFor('conversation', 'root-change').authorityId, 'new-root');
  assert.equal(f.models.pendingFor('conversation', 'root-change'), undefined);
  assert.equal(f.models.detachedFor('conversation', 'root-change').profile.thinkingOverride.value, 'high');
  assert.equal(f.messagesOf(T.ModelProfileScopeSet).length, 1);
});

test('实际Composer等待原scope，导航后迟到ACK不会把旧消息发送给新对话', async t => {
  const f = graph.session(t);
  f.client.currentConversationId = 'origin';
  const { view } = f.mount('Composer');
  f.models.applyScopeSnapshot(modelSnapshot('origin', 1), f.last(T.ModelProfileScopeRead).id);
  f.models.setThinkingForScope('origin', { providerConfigId: 'provider', provider: 'openai-compatible', model: 'o3' }, { kind: 'openai-effort', value: 'high' });
  const write = f.last(T.ModelProfileScopeSet);
  view.draft = 'origin input';
  const sending = view.submit();
  assert.equal(view.savingSessionSelection, true);
  f.client.currentConversationId = 'destination';
  await graph.vue.nextTick();
  f.models.applyScopeSnapshot(modelSnapshot('destination', 1), f.last(T.ModelProfileScopeRead).id);
  ackThinking(f, write, 2, 'high');
  await sending;
  assert.equal(view.savingSessionSelection, false);
  assert.equal(f.messagesOf(T.TurnStart).length, 0);
});

test('实际Composer首次模型读取失败释放等待，不发送旧配置且保留局部错误', async t => {
  const f = graph.session(t);
  f.client.currentConversationId = 'read-failure';
  const { view } = f.mount('Composer'), read = f.last(T.ModelProfileScopeRead);
  f.models.setProfileForScope('conversation', 'read-failure', { providerConfigId: 'provider', provider: 'openai-compatible', model: 'o3' });
  view.draft = 'input';
  const sending = view.submit();
  assert.equal(view.savingSessionSelection, true);
  f.models.rejectRequest(read.id, 'transport read failed');
  await sending;
  assert.equal(view.savingSessionSelection, false);
  assert.ok(f.models.errorFor('conversation', 'read-failure'));
  assert.equal(f.messagesOf(T.TurnStart).length, 0);
  assert.equal(view.draft, 'input');
});

test('实际Router与Feed只更新绑定会话的面板，store丢弃旧会话快照和错误', async t => {
  const f = graph.session(t);
  const { ReliableKernelWebviewFeedBridge } = compiled('backend/reliableKernel/webviewFeedBridge.js');
  const { VscodeReliableKernelCommandRouter } = compiled('backend/application/reliableKernel/VscodeReliableKernelCommandRouter.js');
  const bridge = new ReliableKernelWebviewFeedBridge({}, {}), a = [], otherA = [], b = [];
  const panel = target => ({ async postMessage(message) { target.push(message); return true; } });
  const panelA = panel(a), requester = bridge.attach(panelA, { kind: 'mainPanel', conversationId: 'a' });
  bridge.attach(panel(otherA), { kind: 'planDetail', conversationId: 'a' });
  bridge.attach(panel(b), { kind: 'mainPanel', conversationId: 'b' });
  t.after(() => bridge.close());
  const router = new VscodeReliableKernelCommandRouter({ debugCapture: { setListener() {} }, toolHost: { setStateChangeListener() {} },
    application: { database: { async transaction() {}, conversationOwners: { async run(_id, operation) { return operation(); } } }, webviewFeed: { reconnect() {} } } },
    { postToConversation: (id, message) => bridge.postToConversation(id, message) });
  router.requireRow = async (_domain, id) => ({ id });
  router.readConversationSettings = async id => ({ conversationId: id, section: 'common', settings: { conversationId: id, name: 'saved A' }, filePath: '' });
  await router.dispatch(requester, panelA, { id: 'rename', type: T.ConversationSettingsUpdate, channel: 'command',
    payload: { section: 'common', settings: { conversationId: 'a', name: 'saved A' } } });
  const updates = target => target.filter(message => message.type === T.ConversationSettingsSnapshot);
  assert.equal(updates(a).length, 1);
  assert.equal(updates(otherA).length, 1);
  assert.equal(updates(b).length, 0);
  f.conversation.request('b');
  f.conversation.applySnapshot({ conversationId: 'b', section: 'common', settings: { conversationId: 'b', name: 'B' }, filePath: '' });
  f.conversation.applySnapshot(updates(a)[0].payload);
  f.conversation.applyError({ conversationId: 'a', message: 'late error' });
  assert.equal(f.conversation.common.conversationId, 'b');
  assert.equal(f.conversation.common.name, 'B');
});

test('实际工具编辑器只保存本层授权与MCP原名，未复制上层工具列表', async t => {
  const f = graph.session(t), root = await temporaryRoot(t, 'tool-settings-smoke');
  const { authority } = authorityAt(root); await seedProvider(authority);
  const { createBuiltinToolDefinitions } = compiled('backend/world/modules/tools/definitions/index.js');
  const { commandDeclarationCapability } = compiled('backend/reliableKernel/builtinToolCatalog.js');
  const { toolDefinitionRecord } = compiled('backend/world/modules/tools/registry.js');
  const state = await authority.configurationClientState();
  f.client.applyConfigurationSnapshot(state);
  f.client.configurationReady = true;
  const mcp = { name: 'mcp_query', description: 'query', execution: 'runtime', parameters: { type: 'object' },
    source: { kind: 'mcp', sourceId: 'exa', sourceName: 'exa', originalToolName: 'query' } };
  f.client.toolDefinitions = [...createBuiltinToolDefinitions({ command: commandDeclarationCapability() }).map(toolDefinitionRecord), mcp];
  f.client.mcpToolSources = [{ id: 'exa', name: 'exa', status: 'connected', transportKind: 'stdio', toolCount: 1 }];
  f.tools.setRunAgentConfigValueForScope('conversation', 'tools', 'maxChildAgentDepth', 2);
  const limit = f.last(T.ToolPolicyScopeSet);
  assert.equal(limit.payload.allowedTools, undefined);
  await authority.mutations.setToolPolicy(limit.payload);
  const { view } = f.mount('Tools', { scopeKind: 'conversation', scopeId: 'tools' });
  view.setToolEnabled(f.tools.toolDefinitions.find(tool => tool.name === mcp.name), true);
  const write = f.last(T.ToolPolicyScopeSet);
  assert.deepEqual(write.payload.sourceConfigs.exa, { enabled: true, enabledTools: ['query'] });
  assert.equal(write.payload.allowedTools, undefined);
  assert.doesNotThrow(() => structuredClone(write.payload));
  await authority.mutations.setToolPolicy(write.payload);
  const frozen = JSON.parse((await authority.compile({ conversationId: 'tools', turnId: 'tools-turn', executorAgentId: 'main', intentKind: 'input' })).authoritySnapshot.content);
  assert.equal(frozen.toolPolicy.toolConfigs.run_agent.config.maxChildAgentDepth, 2);
  assert.equal(compiled('shared/toolPolicyResolution.js').toolAllowedByPolicy(frozen.toolPolicy, mcp), true);
  f.tools.setPolicyForScope('conversation', 'tools', undefined, 'blocked result', {
    read: { config: {}, autoSubmitResult: false }, write: { config: {}, autoSubmitResult: false }
  });
  const readTool = f.tools.toolDefinitions.find(tool => tool.name === 'read');
  const count = f.messagesOf(T.ToolPolicyScopeSet).length;
  assert.equal(view.toolGateValue(readTool, 'autoSubmitResult'), false);
  view.restoreResultTool = readTool;
  assert.equal(f.messagesOf(T.ToolPolicyScopeSet).length, count, '打开确认不放行');
  view.confirmRestoreResult();
  const restored = f.last(T.ToolPolicyScopeSet).payload.toolConfigs;
  assert.equal(restored.read.autoSubmitResult, true);
  assert.equal(restored.write.autoSubmitResult, false, '不恢复其它工具');
});

test('实际设置watcher跳过自发布，外部事件合并且读锁不触发循环', async t => {
  const f = graph.session(t), root = await temporaryRoot(t, 'settings-watcher-smoke');
  const { registerGlobalSettingsWatcher } = compiled('vscode/watchers/GlobalSettingsWatcher.js');
  const { withPublishedStorageWrites } = compiled('backend/capabilities/vscodeStorage/storageFilePublications.js');
  const { writeJson } = compiled('backend/capabilities/vscodeStorage/json.js');
  const subscriptions = [], refreshed = [], offset = host.watchers.length;
  registerGlobalSettingsWatcher({ globalStorageUri: Uri.file(root), subscriptions }, { getStorageRootUri: () => Uri.file(root),
    async refreshGlobalSettings(section) {
      refreshed.push(section);
      const watcher = host.watchers[offset + 1];
      watcher.callbacks.create(Uri.joinPath(watcher.pattern.baseUri, 'index.json.lock/owner.json'));
    } });
  t.after(() => subscriptions.forEach(subscription => subscription.dispose()));
  const watcher = host.watchers[offset], file = Uri.joinPath(watcher.pattern.baseUri, 'appearance.json');
  await withPublishedStorageWrites(async () => { await writeJson(file, { value: 'own' }); return { filePath: file.fsPath }; }, () => {});
  watcher.callbacks.change(file); await f.clock.advance(180);
  assert.deepEqual(refreshed, []);
  await fs.writeFile(file.fsPath, JSON.stringify({ value: 'peer' }));
  watcher.callbacks.change(file); watcher.callbacks.create(file);
  await f.clock.advance(180);
  assert.deepEqual(refreshed, ['appearance']);
  await f.clock.advance(180);
  assert.deepEqual(refreshed, ['appearance']);
});

function channelSettings(t) {
  const f = graph.session(t);
  const provider = id => ({ id, name: id, provider: 'openai-responses', baseUrl: 'https://api.openai.com/v1', apiKey: '',
    model: `${id}-one`, models: [{ id: `${id}-one`, name: 'One' }, { id: `${id}-two`, name: 'Two' }], modelConfigs: [],
    toolCallFormat: 'function-call', stream: true, retryOnError: true, retryMaxAttempts: 8, retryDelaySeconds: 0,
    enableMultimodalTools: true, headers: {}, generationConfig: {}, requestBody: {}, createdAt: 1, updatedAt: 1 });
  for (const [section, settings] of Object.entries({
    llm: { activeProviderConfigId: 'A' }, llmProviderConfigs: { configs: [provider('A'), provider('B')] },
    llmCompression: { defaultConfigId: 'compression', providerBindings: [], modelBindings: [] },
    llmCompressionConfigs: { configs: [{ ...protocol.createDefaultLlmCompressionConfig('shared'), id: 'compression' }] }
  })) f.global.applySnapshot({ section, settings, revision: `initial:${section}`, filePath: 'fixture' });
  f.ack = write => f.global.applySnapshot({ ...write.payload, revision: `saved:${write.id}`, filePath: 'fixture' }, write.id);
  return f;
}

test('浏览、新建和添加模型不激活；目标绑定编辑与迟到确认不串渠道', async t => {
  const f = channelSettings(t), channel = f.mount('Channel').view;
  channel.editingConfigId = 'B'; channel.editorModelId = 'B-two';
  assert.equal(f.global.llm.activeProviderConfigId, 'A');
  assert.equal(f.global.activeLlmProviderConfig.model, 'A-one');
  assert.equal(channel.editingConfig.model, 'B-one');
  channel.openNewModel(); channel.editingConfigId = 'A'; channel.confirmNewModel('B-three');
  assert.equal(f.global.llmProviderConfigs.configs.find(item => item.id === 'B').model, 'B-one');
  assert.ok(f.global.llmProviderConfigs.configs.find(item => item.id === 'B').models.some(item => item.id === 'B-three'));
  const editor = f.mount('ChannelEditor', { providerConfigId: 'B' }).view;
  editor.updateGenerationConfig({ temperature: 0.2 });
  await f.clock.advance(400);
  channel.confirmCreate('C'); const createdId = channel.editingConfigId;
  assert.notEqual(createdId, 'A'); assert.equal(f.global.llm.activeProviderConfigId, 'A');
  // Even a callback from the old editor remains bound to B, never to C or the true active A.
  editor.updateGenerationConfig({ temperature: 0.3 });
  editor.updateCompressionBodyTargetTokens(32000);
  f.global.saveLlmProviderConfigs();
  assert.equal(f.global.activeLlmProviderConfig.generationConfig.temperature, undefined);
  assert.equal(f.global.llmProviderConfigs.configs.find(item => item.id === 'B').generationConfig.temperature, 0.3);
  assert.equal(f.global.compressionConfigForProvider('B').bodyTargetTokens, 32000);
  assert.notEqual(f.global.compressionConfigForProvider('A').id, f.global.compressionConfigForProvider('B').id);
  f.global.selectLlmProviderConfig(createdId);
  const providerWrites = () => f.messagesOf(T.GlobalSettingsUpdate).filter(item => item.payload.section === 'llmProviderConfigs');
  f.ack(providerWrites()[0]);
  assert.equal(f.global.llm.activeProviderConfigId, createdId);
  assert.equal(f.messagesOf(T.GlobalSettingsUpdate).filter(item => item.payload.section === 'llm').length, 0, '旧ACK未包含新渠道，不提交选择');
  f.ack(providerWrites().at(-1));
  assert.equal(f.last(T.GlobalSettingsUpdate).payload.settings.activeProviderConfigId, createdId);
  f.global.addModelToActiveConfig('C-model', undefined, createdId);
  assert.equal(f.global.activeLlmProviderConfig.model, '');
  f.global.selectLlmProviderConfigModel(createdId, 'C-model');
  assert.equal(f.global.activeLlmProviderConfig.model, 'C-model');
  const modelConfig = f.global.createModelConfigForActiveConfig('B-two', 'B');
  const modelEditor = f.mount('ChannelEditor', { providerConfigId: 'B', modelConfigId: modelConfig.id }).view;
  modelEditor.updateField({ retryMaxAttempts: 2 });
  modelEditor.updateCompressionBodyTargetTokens(24000);
  assert.equal(f.global.llmProviderConfigs.configs.find(item => item.id === 'B').modelConfigs[0].retryMaxAttempts, 2);
  assert.equal(f.global.compressionConfigForProvider('B', 'B-two').bodyTargetTokens, 24000);
  assert.equal(f.global.compressionConfigForProvider('B').bodyTargetTokens, 32000, '模型副本不反向改渠道默认');
  f.global.deleteModelConfigFromActiveConfig(modelConfig.id, 'B');
  assert.equal(modelEditor.config, undefined, '删除目标卸载缓存表单');
  const bindings = f.global.llmCompression.modelBindings.length;
  modelEditor.updateCompressionBodyTargetTokens(9999);
  assert.equal(f.global.llmCompression.modelBindings.length, bindings, '被删除对象的迟到事件不能重建配置');
  assert.doesNotThrow(() => structuredClone(f.messagesOf(T.GlobalSettingsUpdate).at(-1).payload));
});

function modelListResponse(request, modelId = 'fetched-model') {
  const { id, provider, baseUrl } = request.payload.config;
  return { configId: id, provider, baseUrl, models: [{ id: modelId, name: modelId }] };
}

for (const [defaultProvider, targetProvider, targetId] of [
  ['gemini', 'gemini', 'A'],
  ['gemini', 'openai-compatible', 'B'],
  ['gemini', 'openai-responses', 'B'],
  ['openai-compatible', 'openai-compatible', 'A'],
  ['openai-compatible', 'gemini', 'B']
]) test(`获取模型按编辑目标接收且不激活：默认${defaultProvider}，目标${targetProvider}/${targetId}`, async t => {
  const f = channelSettings(t), configs = f.global.llmProviderConfigs.configs;
  configs[0].provider = defaultProvider;
  configs.find(config => config.id === targetId).provider = targetProvider;
  const channel = f.mount('Channel').view;
  channel.editingConfigId = targetId;
  f.global.requestModelsForActiveConfig(channel.editingConfigId);
  const request = f.last(T.LlmProviderModelsGet);
  assert.equal(request.payload.config.id, targetId);
  assert.equal(f.global.fetchedModelsDialog.open, true, '打开弹窗不能触发取消');
  assert.equal(f.global.fetchedModelsDialog.loading, true);
  channel.editingConfigId = targetId === 'A' ? 'B' : 'A';
  f.global.applyLlmProviderModelsSnapshot(modelListResponse(request), request.id);
  assert.equal(f.global.fetchedModelsDialog.configId, targetId);
  assert.equal(f.global.fetchedModelsDialog.loading, false);
  assert.deepEqual(f.global.fetchedModelsDialog.models.map(model => model.id), ['fetched-model']);
  const status = f.global.status;
  await f.clock.advance(60_000);
  assert.equal(f.global.status, status, '成功响应应清除获取超时');
  f.global.addFetchedModelsToConfig(f.global.fetchedModelsDialog.models);
  assert.ok(configs.find(config => config.id === targetId).models.some(model => model.id === 'fetched-model'));
  assert.ok(!configs.find(config => config.id !== targetId).models.some(model => model.id === 'fetched-model'));
  assert.equal(f.global.llm.activeProviderConfigId, 'A');
});

test('获取模型不因全局默认选择或无关渠道的端点变化而取消', t => {
  const f = channelSettings(t);
  f.global.requestModelsForActiveConfig('B');
  const request = f.last(T.LlmProviderModelsGet), defaultConfig = f.global.activeLlmProviderConfig;
  defaultConfig.baseUrl = 'https://other.example/v1';
  defaultConfig.apiKey = 'changed';
  defaultConfig.headers.Authorization = 'changed';
  f.global.selectLlmProviderConfig('B');
  f.global.selectLlmProviderConfig('A');
  assert.equal(f.global.fetchedModelsDialog.open, true);
  assert.equal(f.global.fetchedModelsDialog.loading, true);
  f.global.applyLlmProviderModelsSnapshot(modelListResponse(request), request.id);
  assert.equal(f.global.fetchedModelsDialog.loading, false);
  assert.deepEqual(f.global.fetchedModelsDialog.models.map(model => model.id), ['fetched-model']);
});

test('获取模型允许目标配置的等价规范化和非端点编辑', t => {
  const f = channelSettings(t), config = f.global.llmProviderConfigs.configs[1];
  config.baseUrl = ' https://api.example/v1 ';
  config.apiKey = ' key ';
  config.headers = { ' X-Test ': ' value ' };
  f.global.requestModelsForActiveConfig('B');
  const request = f.last(T.LlmProviderModelsGet);
  config.baseUrl = config.baseUrl.trim();
  config.apiKey = config.apiKey.trim();
  config.headers = { 'X-Test': 'value' };
  config.name = 'renamed';
  config.model = 'B-two';
  assert.equal(f.global.fetchedModelsDialog.loading, true);
  f.global.applyLlmProviderModelsSnapshot(modelListResponse(request), request.id);
  assert.equal(f.global.fetchedModelsDialog.loading, false);
  assert.deepEqual(f.global.fetchedModelsDialog.models.map(model => model.id), ['fetched-model']);
});

for (const [label, change] of [
  ['类型', config => { config.provider = 'gemini'; }],
  ['地址', config => { config.baseUrl = 'https://changed.example/v1'; }],
  ['密钥', config => { config.apiKey = 'changed'; }],
  ['请求头', config => { config.headers.Authorization = 'changed'; }],
  ['删除', (_config, store) => { store.llmProviderConfigs.configs.splice(1, 1); }]
]) test(`获取模型在非默认目标渠道${label}变化后取消并忽略旧响应`, async t => {
  const f = channelSettings(t);
  f.global.requestModelsForActiveConfig('B');
  const request = f.last(T.LlmProviderModelsGet);
  change(f.global.llmProviderConfigs.configs[1], f.global);
  assert.equal(f.global.fetchedModelsDialog.open, false);
  const status = f.global.status;
  f.global.applyLlmProviderModelsSnapshot(modelListResponse(request), request.id);
  await f.clock.advance(60_000);
  assert.equal(f.global.fetchedModelsDialog.open, false);
  assert.deepEqual(f.global.fetchedModelsDialog.models, []);
  assert.equal(f.global.status, status, '取消后旧获取超时不能重开弹窗');
});

for (const targetId of ['A', 'B']) test(`获取模型的新请求${targetId}不被旧响应或错误覆盖`, async t => {
  const f = channelSettings(t);
  f.global.requestModelsForActiveConfig('B');
  const oldRequest = f.last(T.LlmProviderModelsGet);
  f.global.requestModelsForActiveConfig(targetId);
  const request = f.last(T.LlmProviderModelsGet);
  assert.notEqual(request.id, oldRequest.id);
  f.global.applyLlmProviderModelsSnapshot(modelListResponse(oldRequest, 'old-model'), oldRequest.id);
  f.global.setError('old error', { requestType: T.LlmProviderModelsGet, correlationId: oldRequest.id });
  assert.equal(f.global.fetchedModelsDialog.open, true);
  assert.equal(f.global.fetchedModelsDialog.loading, true);
  assert.equal(f.global.fetchedModelsDialog.configId, targetId);
  assert.deepEqual(f.global.fetchedModelsDialog.models, []);
  f.global.applyLlmProviderModelsSnapshot(modelListResponse(request), request.id);
  const status = f.global.status;
  await f.clock.advance(60_000);
  assert.equal(f.global.status, status);
  assert.deepEqual(f.global.fetchedModelsDialog.models.map(model => model.id), ['fetched-model']);
  f.global.requestModelsForActiveConfig(targetId);
  const closedRequest = f.last(T.LlmProviderModelsGet);
  f.global.closeFetchedModelsDialog();
  f.global.applyLlmProviderModelsSnapshot(modelListResponse(closedRequest), closedRequest.id);
  await f.clock.advance(60_000);
  assert.equal(f.global.fetchedModelsDialog.open, false);
});

test('未知 Gemini 模型默认可选思考等级，官方地址与网关一致且不写入默认值', async t => {
  const f = channelSettings(t), emitted = [];
  const base = { ...f.global.activeLlmProviderConfig, provider: 'gemini', generationConfig: {} };
  const parameters = f.mount('Parameters', { config: base,
    'onUpdate-generation-config': value => emitted.push(value) });
  const { validateSessionThinkingOverride } = compiled('shared/sessionThinking.js');
  for (const model of ['gemini-4-argon', 'gemini-flash-latest']) {
    for (const baseUrl of ['https://generativelanguage.googleapis.com',
      'https://generativelanguage.googleapis.com/v1beta/', 'https://relay.invalid/v1beta']) {
      const config = { ...base, model, baseUrl };
      await parameters.setProps({ config });
      assert.equal(emitted.length, 0, '显示选项不自动写入思考参数');
      const level = parameters.view.definitions.find(item => item.key === 'thinkingLevel');
      assert.deepEqual(level?.options.map(item => item.value), ['minimal', 'low', 'medium', 'high'], `${model} ${baseUrl}`);
      assert.equal(parameters.view.definitions.some(item => item.key === 'thinkingBudget'), false);
      parameters.view.updateKnownValue(level, 'high');
      assert.equal(parameters.view.jsonError, '');
      assert.deepEqual(emitted.pop(), { thinkingConfig: { thinkingLevel: 'high' } });
      const override = { kind: 'gemini-level', value: 'high' };
      assert.deepEqual(validateSessionThinkingOverride(override, 'gemini', model, {}, undefined, config), override);
    }
  }
  for (const [model, levels, budget] of [
    ['gemini-3-pro-preview', ['low', 'high'], false],
    ['gemini-3.8-flash', ['low', 'medium', 'high'], false],
    ['gemini-2.5-pro', [], true]
  ]) {
    await parameters.setProps({ config: { ...base, model, baseUrl: 'https://generativelanguage.googleapis.com/v1beta' } });
    const level = parameters.view.definitions.find(item => item.key === 'thinkingLevel');
    assert.deepEqual(level?.options.map(item => item.value) ?? [], levels);
    assert.equal(parameters.view.definitions.some(item => item.key === 'thinkingBudget'), budget);
  }
  await parameters.setProps({ config: { ...base, model: 'gemini-4-argon',
    baseUrl: 'https://generativelanguage.googleapis.com', generationConfig: { thinkingConfig: { thinkingBudget: 1024 } } } });
  const budget = parameters.view.definitions.find(item => item.key === 'thinkingBudget');
  assert.ok(budget, '已有预算保留供清除');
  parameters.view.removeKnownParameter(budget);
  assert.equal(emitted.pop(), undefined);
});

test('专业参数编辑挂载不写默认，数值清空不落为0，思考档位复用能力集合', async t => {
  const f = channelSettings(t), emitted = [];
  const config = { ...f.global.activeLlmProviderConfig, model: 'gpt-6-astra' };
  const parameterMount = f.mount('Parameters', { config, 'onUpdate-generation-config': value => emitted.push(value) });
  const parameters = parameterMount.view;
  assert.equal(emitted.length, 0);
  const removedKeys = ['temperature', 'topP'];
  assert.ok(parameters.definitions.every(item => !removedKeys.includes(item.key)));
  const maxOutput = parameters.definitions.find(item => item.key === 'maxOutputTokens');
  assert.equal(parameters.definitions[0], maxOutput, '最大输出排在最前');
  parameters.updateKnownValue(maxOutput, 64000);
  assert.deepEqual(emitted.pop(), { maxOutputTokens: 64000 });
  parameters.updateKnownValue(maxOutput, 1.5);
  assert.equal(emitted.length, 0, '非整数不写入');
  assert.match(parameters.jsonError, /正整数/);
  parameters.updateKnownValue(maxOutput, undefined);
  assert.equal(emitted.pop(), undefined, '清空后不再发送');
  const thinking = parameters.definitions.find(item => item.key === 'thinkingLevel');
  assert.ok(thinking.options.every(item => !['none', 'minimal'].includes(item.value)));
  const advanced = f.mount('Advanced', { config,
    'onUpdate-context-window-tokens': value => emitted.push(value), 'onUpdate-field': value => emitted.push(value) }).view;
  assert.equal(emitted.length, 0);
  advanced.updateContextWindowTokens({ target: { value: '' } });
  assert.equal(emitted.pop(), undefined);
  advanced.updateRetryMaxAttempts({ target: { value: '99' } });
  assert.deepEqual(emitted.pop(), { retryMaxAttempts: 10 });
  parameters.onJsonInput({ target: { value: '{bad' } });
  parameters.onJsonBlur();
  await parameterMount.setProps({ config: { ...config, requestBody: { peer: true } } });
  assert.equal(parameters.jsonDraft, '{bad', '失焦后迟到快照不能覆盖无效JSON草稿');
  parameters.resetJsonDraft();
  assert.deepEqual(JSON.parse(parameters.jsonDraft), { peer: true });
  const saved = { maxOutputTokens: 4096, temperature: 0.2, topP: 0.9 };
  for (const [provider, model, baseUrl, wireField] of [
    ['openai-responses', 'gpt-6-astra', 'https://api.openai.com/v1', 'max_output_tokens'],
    ['openai-compatible', 'deepseek-chat', 'https://api.deepseek.com/v1', 'max_tokens'],
    ['gemini', 'gemini-2.5-pro', 'https://generativelanguage.googleapis.com', 'generationConfig.maxOutputTokens'],
    ['claude', 'claude-sonnet-4-5', 'https://api.anthropic.com', 'max_tokens']
  ]) {
    await parameterMount.setProps({ config: { ...config, provider, model, baseUrl, generationConfig: saved } });
    assert.ok(parameters.definitions.every(item => !removedKeys.includes(item.key)), `${provider}不重新显示已移除的控件`);
    assert.equal(parameters.definitions.find(item => item.key === 'maxOutputTokens')?.displayPath, wireField, `${provider}显示最大输出`);
  }
  assert.equal(emitted.length, 0, '移除界面入口不能改写已有配置');
  const topK = parameters.definitions.find(item => item.key === 'topK');
  parameters.updateKnownValue(topK, 40);
  assert.deepEqual(emitted.pop(), { ...saved, topK: 40 });
  parameters.updateKnownValue(topK, undefined);
  assert.deepEqual(emitted.pop(), saved);
  const claudeMax = parameters.definitions.find(item => item.key === 'maxOutputTokens');
  assert.match(claudeMax.description, /64000/, 'Claude 说明未设置时实际发送的默认上限');
  assert.equal(claudeMax.placeholder, '未设置（发送 64000）');
  assert.equal(maxOutput.placeholder, undefined, '其它渠道未设置时不发送');
  await parameterMount.setProps({ config: { ...config, provider: 'claude', model: 'claude-sonnet-4-5', baseUrl: 'https://api.anthropic.com',
    generationConfig: { thinkingConfig: { thinkingBudget: 8000 } } } });
  parameters.updateKnownValue(parameters.definitions.find(item => item.key === 'maxOutputTokens'), 8000);
  assert.equal(emitted.length, 0, 'Claude 最大输出不能不大于思考预算');
  assert.match(parameters.jsonError, /思考预算必须小于最大输出/);
  parameters.updateKnownValue(parameters.definitions.find(item => item.key === 'maxOutputTokens'), 32000);
  assert.deepEqual(emitted.pop(), { maxOutputTokens: 32000, thinkingConfig: { thinkingBudget: 8000 } });
  await parameterMount.setProps({ config: { ...config, provider: 'claude', model: 'claude-sonnet-4-5', baseUrl: 'https://api.anthropic.com', generationConfig: saved } });
  const claudeThinking = parameters.definitions.find(item => item.key === 'thinkingLevel');
  assert.deepEqual(claudeThinking.options.map(item => item.value), ['none'], '预算模型仍可显式关闭思考');
  parameters.updateKnownValue(claudeThinking, 'none');
  assert.deepEqual(emitted.pop(), { ...saved, thinkingConfig: { thinkingLevel: 'none' } });
});


test('重试提示显示上次具体错误，不把等待输出说成正在连接', t => {
  const f = graph.session(t);
  const { reliableRetryFailureLabel, reliableRetryStreamingActivityLabel } = f.domain('reliableTransientActivity');
  const lastFailureLabel = reliableRetryFailureLabel({ lastRetryFailure: {
    error: { status: 504, code: 'upstream_timeout', message: 'gateway timeout' }
  } });
  assert.equal(lastFailureLabel, '上次失败：HTTP 504 · upstream_timeout · gateway timeout');
  const input = { retryAttempt: 1, retryMaxAttempts: 10, hasVisibleOutput: false, lastFailureLabel };
  assert.equal(reliableRetryStreamingActivityLabel(input),
    '第 1/10 次自动恢复已启动，正在等待 LLM 输出；上次失败：HTTP 504 · upstream_timeout · gateway timeout');
  assert.equal(reliableRetryStreamingActivityLabel({ ...input, hasVisibleOutput: true }), undefined);
  assert.equal(reliableRetryFailureLabel(undefined), '');
});
