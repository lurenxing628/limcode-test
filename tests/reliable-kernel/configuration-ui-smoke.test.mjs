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
  const f = graph.session(t), { view } = f.mount('Prompt', { scopeKind: 'conversation', scopeId: 'prompt' });
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
  f.client.systemPrompts[0].text = 'typed before load';
  f.client.systemPromptScopeLinks[0].updatedAt = 2;
  f.prompts.reconcilePendingSave(request.id);
  await graph.vue.nextTick();
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
  const { view } = f.mount('Model', { scopeKind: 'agent', scopeId: 'agent' });
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
  const release = activate(f, 'thinking', 'high'); t.after(release);
  const thinking = f.mount('Thinking', { conversationId: 'thinking', model: 'o3', config: {
    id: 'provider', provider: 'openai-compatible', model: 'o3', modelConfigs: [] } }).view;
  thinking.setInheritance(true);
  const inherit = f.last(T.ModelProfileScopeSet);
  assert.equal(inherit.payload.operation, 'inherit');
  assert.equal(inherit.payload.inheritThinkingToChildren, true);
  assert.doesNotThrow(() => structuredClone(inherit.payload));
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
