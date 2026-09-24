import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
class Uri {
  constructor(value) { this.scheme = 'file'; this.fsPath = path.resolve(value); this.path = this.fsPath; }
  static file(value) { return new Uri(value); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.path}`; }
}
const vscode = { Uri, FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 }, workspace: { fs: {
  createDirectory: uri => fs.mkdir(uri.fsPath, { recursive: true }), readFile: uri => fs.readFile(uri.fsPath),
  async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
  async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map(item => [item.name, item.isDirectory() ? 2 : 1]); },
  delete: uri => fs.rm(uri.fsPath, { recursive: true, force: true }),
  async stat(uri) { const s = await fs.stat(uri.fsPath); return { type: s.isDirectory() ? 2 : 1, size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs }; }
} } };
Module._load = function(request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
after(() => { Module._load = originalLoad; });
const kernel = require('../../dist/extension/backend/reliableKernel/index.js');
const { VscodeConfigurationAuthority } = require('../../dist/extension/backend/reliableKernel/vscodeConfigurationAuthority.js');
const { childConversationModelProfiles } = require('../../dist/extension/backend/reliableKernel/childThinkingInheritance.js');
const { createVscodeStoragePaths } = require('../../dist/extension/backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = require('../../dist/extension/backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { ReliableChildAgentCoordinator } = require('../../dist/extension/backend/reliableKernel/childAgentCoordinator.js');
const { readFrozenTurnAuthority } = require('../../dist/extension/backend/reliableKernel/frozenAuthority.js');
const { dryRunLlmProvider } = require('../../dist/extension/backend/capabilities/llmProvider.js');
const { applyFrozenModelProviderConfig } = require('../../dist/extension/backend/reliableKernel/llmCapabilityProviderRegistry.js');
const { LlmEventType } = require('../../dist/extension/backend/world/modules/llm/events.js');

test('会话读取保留已保存版本，失效模型仍可通过选择有效模型恢复', async () => {
  await fixture(async f => {
    await f.configuration.mutations.setModelProfile({ scopeKind: 'conversation', scopeId: 'parent',
      providerConfigId: f.provider.id, provider: f.provider.provider, model: 'removed-model' });
    const { send, receive, T } = scopeRouter(f);
    send('read-invalid-model', T.ModelProfileScopeRead, { scopeKind: 'conversation', scopeId: 'parent' });
    const read = await receive('read-invalid-model');
    assert.equal(read.outcome, 'observed');
    assert.ok(read.revision);
    assert.match(read.effectiveModelError, /removed-model/);
    send('repair-model', T.ModelProfileScopeSet, { scopeKind: 'conversation', scopeId: 'parent',
      authorityId: read.authorityId, sessionId: read.sessionId, expectedRevision: read.revision,
      operation: 'select', providerConfigId: f.provider.id, provider: f.provider.provider, model: f.provider.model });
    const saved = await receive('repair-model');
    assert.equal(saved.outcome, 'committed');
    assert.equal(saved.effectiveModel.model, f.provider.model);
    assert.equal(saved.effectiveModelError, undefined);
    await f.app.agentLoop.runInput(f.input('repaired-model-input'));
    assert.equal(f.wires.at(-1).body.reasoning_effort, 'low');
  });
});

test('子继承可开关，恢复思维默认保留独立的子继承选择', async () => {
  await fixture(async f => {
    const { send, receive, T } = scopeRouter(f);
    const scope = { scopeKind: 'conversation', scopeId: 'parent' };
    send('inherit-read', T.ModelProfileScopeRead, scope);
    let observed = await receive('inherit-read');
    async function update(id, operation, extra) {
      send(id, T.ModelProfileScopeSet, { ...scope, ...observed.effectiveModel, authorityId: observed.authorityId,
        sessionId: observed.sessionId, expectedRevision: observed.revision, expectedEffectiveModel: observed.effectiveModel,
        operation, ...extra });
      observed = await receive(id);
      assert.equal(observed.outcome, 'committed');
      return observed.profile;
    }
    assert.equal((await update('inherit-on', 'inherit', { inheritThinkingToChildren: true })).inheritThinkingToChildren, true);
    assert.equal((await update('inherit-off', 'inherit', { inheritThinkingToChildren: false })).inheritThinkingToChildren, false);
    await update('inherit-on-again', 'inherit', { inheritThinkingToChildren: true });
    await update('thinking-high', 'thinking', { thinkingOverride: { kind: 'openai-effort', value: 'high' } });
    const reset = await update('thinking-reset', 'reset', { thinkingOverride: null });
    assert.equal(reset.thinkingOverride, undefined);
    assert.equal(reset.inheritThinkingToChildren, true);
    assert.equal(reset.inheritModel, true);
    // Changing an inherited model cannot transplant a former model's override when
    // the user resets thinking or toggles the independent child-inheritance setting.
    await update('old-model-thinking', 'thinking', { thinkingOverride: { kind: 'openai-effort', value: 'high' } });
    const nextProvider = { ...f.provider, model: 'gpt-5.6-terra', models: [...f.provider.models, { id: 'gpt-5.6-terra', name: 'Terra' }] };
    await f.save('llmProviderConfigs', { configs: [nextProvider] });
    send('changed-model-read', T.ModelProfileScopeRead, scope);
    observed = await receive('changed-model-read');
    assert.equal(observed.effectiveModel.model, nextProvider.model);
    const changed = await update('changed-model-inherit-off', 'inherit', { inheritThinkingToChildren: false });
    assert.equal(changed.thinkingOverride, undefined);
    assert.equal(changed.model, nextProvider.model);
    await update('changed-model-inherit-on', 'inherit', { inheritThinkingToChildren: true });
    await f.save('llmProviderConfigs', { configs: [f.provider] });
    send('original-model-read', T.ModelProfileScopeRead, scope);
    observed = await receive('original-model-read');
    const restored = await update('reset-after-model-change', 'reset', { thinkingOverride: null });
    assert.equal(restored.model, f.provider.model);
    assert.equal(restored.inheritThinkingToChildren, true);
  });
});

test('会话思维保存不重写其他会话的配置，确认后可以发送', async () => {
  await fixture(async f => {
    const { paths } = f.configuration.mutations.captureModelProfileRoot();
    const seed = async (root, index, key, make) => {
      const savedAt = '2020-01-01T00:00:00.000Z';
      await fs.mkdir(path.join(root.fsPath, 'records'), { recursive: true });
      const records = Array.from({ length: 874 }, (_, i) => make(i));
      await Promise.all(records.map(record => fs.writeFile(path.join(root.fsPath, 'records', `${record.id}.json`), JSON.stringify({ schemaVersion: 1, savedAt, [key]: record }))));
      await fs.writeFile(index.fsPath, JSON.stringify({ schemaVersion: 1, savedAt, records: records.map(record => ({ id: record.id, file: `records/${record.id}.json`, updatedAt: savedAt })) }));
      const untouched = path.join(root.fsPath, 'records', `${records[0].id}.json`);
      return { untouched, bytes: await fs.readFile(untouched, 'utf8') };
    };
    const profiles = await seed(paths.modelProfilesRootUri, paths.modelProfilesIndexUri, 'modelProfile', i => ({ id: `historical-profile-${i}`, name: 'Historical', providerConfigId: f.provider.id, provider: f.provider.provider, model: f.provider.model }));
    const links = await seed(paths.modelProfileScopeLinksRootUri, paths.modelProfileScopeLinksIndexUri, 'link', i => ({ id: `historical-link-${i}`, scopeKind: 'conversation', scopeId: `historical-conversation-${i}`, modelProfileId: `historical-profile-${i}`, role: 'active', createdAt: 1, updatedAt: 1 }));
    const { send, receive, T } = scopeRouter(f);
    const scope = { scopeKind: 'conversation', scopeId: 'parent' };
    send('large-read', T.ModelProfileScopeRead, scope);
    const initial = await receive('large-read');
    const start = performance.now();
    send('large-save', T.ModelProfileScopeSet, { ...scope, ...initial.effectiveModel, expectedEffectiveModel: initial.effectiveModel,
      authorityId: initial.authorityId, sessionId: initial.sessionId, expectedRevision: initial.revision,
      operation: 'thinking', thinkingOverride: { kind: 'openai-effort', value: 'high' } });
    const saved = await receive('large-save', 60000);
    console.log(`large-scope save: ${Math.round(performance.now() - start)} ms`);
    assert.equal(saved.outcome, 'committed', saved.error);
    for (const other of [profiles, links]) assert.equal(await fs.readFile(other.untouched, 'utf8'), other.bytes);
    assert.equal((await f.app.agentLoop.runInput(f.input('large-scope-send'))).terminalStatus, 'completed');
    assert.equal(f.wires.at(-1).body.reasoning_effort, 'high');
  });
});

async function fixture(run, hooks = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-session-thinking-runtime-'));
  let app, coordinator;
  try {
    const configuration = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(path.join(root, 'settings'))));
    const save = async (section, settings) => configuration.saveGlobalSettings(section, settings, (await configuration.loadGlobalSettings(section)).revision);
    const provider = { ...createDefaultLlmProviderConfig({ name: 'synthetic' }), id: 'thinking-runtime', provider: 'openai-compatible', model: 'o3', models: [{ id: 'o3', name: 'o3' }], modelConfigs: [], generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } };
    await save('llmProviderConfigs', { configs: [provider] });
    await save('llm', { activeProviderConfigId: provider.id });
    const agent = await configuration.mutations.createAgent({ name: 'synthetic', kind: 'custom' });
    const childAgent = await configuration.mutations.createAgent({ name: 'synthetic child', kind: 'custom' });
    await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['counter', 'run_agent'], toolConfigs: { run_agent: { config: { maxChildAgentDepth: 3 } } } });
    const set = (conversationId, value) => configuration.mutations.setModelProfile({ scopeKind: 'conversation', scopeId: conversationId, providerConfigId: provider.id, provider: provider.provider, model: provider.model, thinkingOverride: value ? { kind: 'openai-effort', value } : null });
    const authority = new kernel.RootAuthority(() => path.join(root, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(authority);
    const requests = [], wires = [];
    let f;
    const frozen = async turnId => {
      const [row] = await list('AuthoritySnapshot', { turn_id: turnId });
      return readFrozenTurnAuthority(app.database, app.contentStore, row.id, turnId);
    };
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: configuration, compressionSettingsAuthority: configuration, attachmentSettings: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { return null; } },
      mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
      providers: { resolve(providerId) { return { providerId, async sendFullRequest(request, controls) {
        requests.push(request);
        if (request.recipe.kind === 'reliable-context-compression' && hooks.send) return hooks.send(request, controls, f);
        let projected;
        const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
          start(input, emit) { projected = input; emit({ type: LlmEventType.Done, payload: { requestId: input.id } }); }, abort() {}, dispose() {}
        });
        await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, terminal: true, checkpointed: true }; } });
        const effective = applyFrozenModelProviderConfig(await configuration.providerConfig(providerId), request.modelId);
        const wire = await dryRunLlmProvider(projected, { settings: { ...effective, baseUrl: 'https://example.invalid/v1', apiKey: '' } });
        wires.push({ conversationId: request.conversationId, turnId: request.turnId, body: wire.body });
        if (hooks.send) return hooks.send(request, controls, f);
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: 'done' }] } });
      } }; } },
      toolDispatcher: {
        definitions() { return ['counter', 'run_agent'].map(name => ({ name, description: 'synthetic', parameters: { type: 'object', properties: {} }, metadata: { readonly: true } })); },
        async dispatch(input) {
          if (input.toolName === 'run_agent') {
            const authority = await frozen(input.turnId);
            return coordinator.dispatch(input, undefined, { snapshotId: authority.snapshot.id, document: authority.document, toolConfig: { config: { maxChildAgentDepth: 3 } } });
          }
          await hooks.tool?.(f);
          const settled = await app.runtime.effects.settleWithoutEffect({ source: { kind: 'internal', key: `counter:${input.toolCallId}` }, toolCallId: input.toolCallId, status: 'succeeded', detail: { count: 1 } });
          return settled.terminal ?? app.runtime.effects.readTerminalResult(input.toolCallId, true);
        }
      }
    });
    const list = async (domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))).snapshot;
    coordinator = new ReliableChildAgentCoordinator({ database: app.database, ...app.runtime, modelProvider: app.modelProvider, turns: app.turns, agentLoop: app.agentLoop,
      agents: { async resolve() { return { agentId: childAgent.id, agentType: 'worker' }; } },
      // Production wiring (VscodeReliableKernelProductRuntime uses the same adapter).
      modelProfiles: childConversationModelProfiles(configuration.mutations)
    });
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'parent', title: 'Synthetic', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'parent-agent', conversation_id: 'parent', agent_id: agent.id, role: 'default', created_at: now, updated_at: now })
    ]);
    const input = key => ({ source: { kind: 'command', key }, conversationId: 'parent', leaseOwnerId: 'thinking-owner', hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), content: 'synthetic input' });
    f = { app, configuration, coordinator, provider, agent, childAgent, set, save, input, requests, wires, list, frozen };
    await run(f);
  } finally {
    if (coordinator) await coordinator.dispose();
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function scopeRouter(f, onMessage = () => {}) {
  const { VscodeReliableKernelCommandRouter } = require('../../dist/extension/backend/application/reliableKernel/VscodeReliableKernelCommandRouter.js');
  const T = require('../../dist/extension/shared/protocol.js').BridgeMessageType;
  const messages = [], webviews = new Map();
  const product = { configuration: f.configuration, application: f.app, debugCapture: { setListener() {} }, toolHost: { setStateChangeListener() {}, definitionRecords() { return []; }, mcp: { sourceRecords() { return []; } }, skillDefinitions() { return []; }, ruleFiles() { return []; } } };
  const router = new VscodeReliableKernelCommandRouter(product);
  return { router, T, messages,
    send(id, type, payload, client = 'scope-client') {
      if (!webviews.has(client)) webviews.set(client, { async postMessage(message) { messages.push(structuredClone(message)); onMessage(message); return true; } });
      router.handle(client, webviews.get(client), { id, type, payload });
    },
    async receive(id, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      while (!messages.some(message => message.correlationId === id)) { if (Date.now() > deadline) throw new Error(`No response: ${id}`); await new Promise(resolve => setTimeout(resolve, 5)); }
      return messages.find(message => message.correlationId === id).payload;
    }
  };
}

for (const inheritedScope of ['agent', 'workflow']) test(`review scope actual component save to Turn preserves ${inheritedScope} identity, not global fallback`, async () => {
  await fixture(async f => {
    const provider = { ...f.provider, id: 'inherited-gemini', provider: 'gemini', model: 'gemini-2.5-flash', models: [{ id: 'gemini-2.5-flash', name: 'Gemini' }], generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 1024 } } };
    await f.save('llmProviderConfigs', { configs: [f.provider, provider] });
    let scopeId = f.agent.id;
    if (inheritedScope === 'workflow') {
      const workflow = await f.configuration.mutations.createWorkflow({ name: 'synthetic thinking workflow', steps: [] });
      scopeId = workflow.id;
      await f.configuration.mutations.selectConversationWorkflow({ conversationId: 'parent', scopeKind: 'workflow', workflowId: workflow.id });
      await f.configuration.mutations.setModelProfile({ scopeKind: 'agent', scopeId: f.agent.id, providerConfigId: f.provider.id, provider: f.provider.provider, model: f.provider.model });
    }
    await f.configuration.mutations.setModelProfile({ scopeKind: inheritedScope, scopeId, providerConfigId: provider.id, provider: provider.provider, model: provider.model });
    let ui;
    const channel = scopeRouter(f, message => ui.receive(message));
    ui = require('./session-thinking-ui-fixture.cjs').createThinkingUi(message => channel.send(message.id, message.type, message.payload));
    try {
      ui.store.activateScope('conversation', 'parent'); await channel.receive(ui.requests.at(-1).id);
      const effective = ui.store.effectiveFor('conversation', 'parent');
      assert.equal(effective.providerConfigId, provider.id); assert.equal(effective.model, provider.model);
      // The same effective identity is passed by Composer to this production script-setup.
      const control = ui.control(provider, effective.model);
      assert.equal(control.defaultLabel.value, '跟随渠道设置：1024 tokens');
      control.save('2048');
      await ui.store.awaitSavedForScope('conversation', 'parent');
      const saved = ui.store.confirmedFor('conversation', 'parent');
      assert.equal(saved.profile.inheritModel, true);
      assert.equal(saved.profile.providerConfigId, provider.id);
      assert.equal(ui.requests.at(-1).payload.operation, 'thinking');
      assert.equal((await f.app.agentLoop.runInput(f.input(`component-${inheritedScope}`))).terminalStatus, 'completed');
      assert.equal(f.requests.at(-1).modelId, provider.model);
      assert.equal(f.wires.at(-1).body.generationConfig.thinkingConfig.thinkingBudget, 2048);
      assert.equal(f.wires.at(-1).body.reasoning_effort, undefined);
      control.save('default'); await ui.store.awaitSavedForScope('conversation', 'parent');
      assert.equal(ui.store.confirmedFor('conversation', 'parent').profile, undefined, 'reset restores inheritance, not pinned global identity');
      assert.equal((await f.app.agentLoop.runInput(f.input(`component-reset-${inheritedScope}`))).terminalStatus, 'completed');
      assert.equal(f.requests.at(-1).modelId, provider.model);
      assert.equal(f.wires.at(-1).body.generationConfig.thinkingConfig.thinkingBudget, 1024);
    } finally { ui.dispose(); }
  });
});

test('review scope session capacity pins in-flight client/scope; idle eviction is unknown and reconnect reads actual state', async () => {
  await fixture(async f => {
    const channel = scopeRouter(f), { router, T, send, receive } = channel;
    const scope = { scopeKind: 'conversation', scopeId: 'parent' };
    send('cap-initial', T.ModelProfileScopeRead, scope); const initial = await receive('cap-initial');
    let release; const gate = new Promise(resolve => { release = resolve; });
    const original = f.configuration.providerConfig.bind(f.configuration);
    f.configuration.providerConfig = async id => { await gate; return original(id); };
    const selection = { ...scope, ...initial.effectiveModel, operation: 'thinking', expectedEffectiveModel: initial.effectiveModel, authorityId: initial.authorityId, sessionId: initial.sessionId, expectedRevision: initial.revision, thinkingOverride: { kind: 'openai-effort', value: 'high' } };
    send('cap-write', T.ModelProfileScopeSet, selection);
    const sessions = router.modelProfileSessions;
    const realKey = JSON.stringify(['scope-client', initial.authorityId, scope]);
    assert.equal(sessions.get(realKey).inFlight, 1);
    // Bounded capacity seam; no unbounded traffic or synthetic settings mutations required.
    for (let index = 0; index < 255; index++) sessions.set(`synthetic-idle-${index}`, { id: `idle-${index}`, inFlight: 0 });
    send('other-client', T.ModelProfileScopeRead, { scopeKind: 'agent', scopeId: f.agent.id }, 'other-client');
    assert.equal((await receive('other-client')).outcome, 'observed');
    assert.equal(sessions.get(realKey).id, initial.sessionId, 'pressure on other window cannot fence pending original');
    send('ordinary-mount', T.ModelProfileScopeRead, scope);
    assert.equal((await receive('ordinary-mount')).sessionId, initial.sessionId, 'mount does not renew');
    release(); assert.equal((await receive('cap-write')).outcome, 'committed');
    // Simulate capacity occupied by pending entries: rejection is not accepted/settled work.
    for (const entry of sessions.values()) entry.inFlight++;
    send('overflow-read', T.ModelProfileScopeRead, { scopeKind: 'agent', scopeId: 'capacity-extra' }, 'extra-client');
    assert.equal((await receive('overflow-read')).outcome, 'uncertain');
    assert.equal(sessions.size, 256);
    for (const entry of sessions.values()) entry.inFlight--;
    // The oldest real session is now idle and may be evicted; its old token never regains authority.
    send('evict-idle', T.ModelProfileScopeRead, { scopeKind: 'agent', scopeId: 'capacity-new' }, 'extra-client');
    await receive('evict-idle'); assert.equal(sessions.has(realKey), false);
    send('stale-token', T.ModelProfileScopeRead, { ...scope, sessionId: initial.sessionId, authorityId: initial.authorityId });
    assert.equal((await receive('stale-token')).outcome, 'uncertain');
    send('capacity-reconnect', T.ModelProfileScopeRead, { ...scope, renewSession: true });
    const restored = await receive('capacity-reconnect');
    assert.notEqual(restored.sessionId, initial.sessionId); assert.equal(restored.profile.thinkingOverride.value, 'high');
  });
});


test('review scope router registers before suspended preflight; after-read waits and explicit session fences late write', async () => {
  await fixture(async f => {
    const { VscodeReliableKernelCommandRouter } = require('../../dist/extension/backend/application/reliableKernel/VscodeReliableKernelCommandRouter.js');
    const { BridgeMessageType: T } = require('../../dist/extension/shared/protocol.js');
    const messages = [];
    const webview = { async postMessage(message) { messages.push(structuredClone(message)); return true; } };
    const product = { configuration: f.configuration, application: f.app, debugCapture: { setListener() {} }, toolHost: { setStateChangeListener() {}, definitionRecords() { return []; }, mcp: { sourceRecords() { return []; } }, skillDefinitions() { return []; }, ruleFiles() { return []; } } };
    const router = new VscodeReliableKernelCommandRouter(product);
    const scope = { scopeKind: 'conversation', scopeId: 'parent' };
    const receive = async id => {
      const deadline = Date.now() + 8000;
      while (!messages.some(message => message.correlationId === id)) { if (Date.now() > deadline) throw new Error(`No scope response: ${id}`); await new Promise(resolve => setTimeout(resolve, 5)); }
      return messages.find(message => message.correlationId === id).payload;
    };
    const send = (id, type, payload) => router.handle('scope-client', webview, { id, type, payload });
    send('initial-scope', T.ModelProfileScopeRead, scope);
    const initial = await receive('initial-scope');
    assert.equal(initial.outcome, 'observed'); assert.ok(initial.sessionId);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const originalProvider = f.configuration.providerConfig.bind(f.configuration);
    f.configuration.providerConfig = async id => { await gate; return originalProvider(id); };
    const selection = { ...scope, ...initial.effectiveModel, authorityId: initial.authorityId, sessionId: initial.sessionId, expectedRevision: initial.revision, operation: 'thinking', expectedEffectiveModel: initial.effectiveModel, thinkingOverride: { kind: 'openai-effort', value: 'high' } };
    send('suspended-write', T.ModelProfileScopeSet, selection);
    send('read-after-write', T.ModelProfileScopeRead, { ...scope, authorityId: initial.authorityId, sessionId: initial.sessionId, afterRequestId: 'suspended-write' });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(!messages.some(message => message.correlationId === 'read-after-write'), 'cannot return old state before original preflight settles');
    send('renew-editor', T.ModelProfileScopeRead, { ...scope, renewSession: true });
    const renewed = await receive('renew-editor');
    assert.equal(renewed.profile, undefined); assert.notEqual(renewed.sessionId, initial.sessionId);
    release();
    assert.equal((await receive('suspended-write')).outcome, 'uncertain');
    assert.equal((await receive('read-after-write')).outcome, 'uncertain');
    send('new-write', T.ModelProfileScopeSet, { ...selection, sessionId: renewed.sessionId, expectedRevision: renewed.revision });
    const current = await receive('new-write'); assert.equal(current.outcome, 'committed');
    assert.equal(current.profile.thinkingOverride.value, 'high');
    // Simulate a failure after a real commit; settled observation must still return the actual pair.
    const originalWrite = f.configuration.mutations.writeModelProfileScope.bind(f.configuration.mutations);
    f.configuration.mutations.writeModelProfileScope = async (...args) => { await originalWrite(...args); throw new Error('synthetic post-write failure'); };
    send('post-write-error', T.ModelProfileScopeSet, { ...selection, sessionId: current.sessionId, expectedRevision: current.revision, thinkingOverride: { kind: 'openai-effort', value: 'medium' } });
    assert.equal((await receive('post-write-error')).outcome, 'uncertain');
    send('read-post-error', T.ModelProfileScopeRead, { ...scope, authorityId: current.authorityId, sessionId: current.sessionId, afterRequestId: 'post-write-error' });
    const observed = await receive('read-post-error');
    assert.equal(observed.outcome, 'observed'); assert.equal(observed.profile.thinkingOverride.value, 'medium');
  });
});

test('review P1-1真实authority无覆盖Astra冻结raw body仍经过适配器清洗', async () => {
  await fixture(async f => {
    const astra = { ...f.provider, provider: 'openai-responses', model: 'gpt-6-astra', models: [{ id: 'gpt-6-astra', name: 'Astra' }], generationConfig: {}, requestBody: { temperature: 0.7, top_logprobs: 5, include: ['message.output_text.logprobs'], custom_field: 'keep' } };
    await f.save('llmProviderConfigs', { configs: [astra] });
    const result = await f.app.agentLoop.runInput(f.input('astra-raw-no-override'));
    assert.equal(result.terminalStatus, 'completed');
    const body = f.wires[0].body;
    assert.equal(body.temperature, undefined);
    assert.equal(body.top_logprobs, undefined);
    assert.ok(!body.include?.includes('message.output_text.logprobs'));
    assert.equal(body.custom_field, 'keep');
  });
});

test('review P2-4非法Claude覆盖只拒绝本次保存，原会话仍按默认发送', async () => {
  await fixture(async f => {
    const claude = { ...f.provider, provider: 'claude', model: 'claude-sonnet-4-5', models: [{ id: 'claude-sonnet-4-5', name: 'Claude' }], generationConfig: { maxOutputTokens: 8192, temperature: 0.7 } };
    await f.save('llmProviderConfigs', { configs: [claude] });
    const selection = { scopeKind: 'conversation', scopeId: 'parent', providerConfigId: claude.id, provider: claude.provider, model: claude.model };
    await assert.rejects(f.configuration.mutations.setModelProfile({ ...selection, thinkingOverride: { kind: 'claude-budget', tokens: 2048 } }), /采样/);
    await f.configuration.mutations.setModelProfile({ ...selection, thinkingOverride: null });
    assert.equal((await f.app.agentLoop.runInput(f.input('claude-after-rejected-save'))).terminalStatus, 'completed');
    assert.equal(f.wires[0].body.temperature, 0.7);
    assert.equal(f.wires[0].body.thinking, undefined);
    await f.save('llmProviderConfigs', { configs: [{ ...claude, generationConfig: { maxOutputTokens: 8192, topP: .95 } }] });
    await f.configuration.mutations.setModelProfile({ ...selection, thinkingOverride: { kind: 'claude-budget', tokens: 2048 } });
    assert.equal((await f.app.agentLoop.runInput(f.input('claude-legal-sampling'))).terminalStatus, 'completed');
    assert.equal(f.wires[1].body.top_p, .95);
    assert.equal(f.wires[1].body.thinking.budget_tokens, 2048);
  });
});

for (const transport of ['http', 'websocket']) for (const scenario of [
  { name: 'service-default', nextEffort: null }, { name: 'channel-low', nextEffort: null, defaultEffort: 'low' },
  { name: 'medium', nextEffort: 'medium' }, { name: 'unchanged-high', nextEffort: 'high' }
]) test(`review P1-2同Turn普通请求真实authority压缩fresh update不覆盖本次选择 ${transport}/${scenario.name}`, async () => {
  const { nextEffort, defaultEffort } = scenario;
  const expectedEffort = nextEffort ?? defaultEffort;
  let setThinking, enableCompression, toolCount = 0;
  await fixture(async f => {
    const provider = { ...f.provider, provider: 'openai-responses', model: 'gpt-6-astra', models: [{ id: 'gpt-6-astra', name: 'Astra' }], generationConfig: { thinkingConfig: { reasoningMode: 'standard', ...(defaultEffort ? { thinkingLevel: defaultEffort } : {}) } }, openaiResponsesTransport: transport, nativeResponses: { enabled: true, reasoningUpdates: true, asyncTools: false, steering: false, multiplexing: false } };
    await f.save('llmProviderConfigs', { configs: [provider] });
    const defaults = require('../../dist/extension/shared/protocol.js').createDefaultLlmCompressionConfig('native synthetic compression');
    const compression = { ...defaults, kind: 'llm_summary', bodyTargetTokens: 4096, llmSummary: { targetTokens: 1024 }, trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: 120000 } };
    await f.save('llmCompressionConfigs', { configs: [compression] });
    await f.save('llmCompression', { defaultConfigId: compression.id, providerBindings: [], modelBindings: [] });
    setThinking = value => f.configuration.mutations.setModelProfile({ scopeKind: 'conversation', scopeId: 'parent', providerConfigId: provider.id, provider: provider.provider, model: provider.model, thinkingOverride: value ? { kind: 'openai-effort', value } : null });
    enableCompression = () => f.save('llmCompressionConfigs', { configs: [{ ...compression, trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 10000 } }] });
    const seed = await f.app.turns.input({ ...f.input('native-history'), content: 'synthetic historical evidence '.repeat(18000) });
    await f.app.turns.terminal({ source: { kind: 'internal', key: 'native-history-done' }, turnId: seed.turnId, terminalStatus: 'completed', reason: 'synthetic' });
    await setThinking('low');
    assert.equal((await f.app.agentLoop.runInput(f.input('native-low'))).terminalStatus, 'completed');
    await setThinking('high');
    assert.equal((await f.app.agentLoop.runInput(f.input('native-high-reset'))).terminalStatus, 'completed');
    assert.equal((await f.list('CompressionBlock')).length, 1);
    assert.equal(toolCount, 2);
    const ordinary = f.requests.filter(request => request.recipe.kind === 'reliable-agent-turn');
    assert.equal(ordinary.length, 4);
    assert.equal(new Set(ordinary.slice(1).map(request => request.turnId)).size, 1, 'all three ordinary requests share one Turn');
    assert.equal(new Set(ordinary.slice(1).map(request => request.modelRequestId)).size, 3, 'not a native continuation inside one frozen request');
    const previous = ordinary.at(-2).recipe;
    assert.equal(previous.nativeReasoning.effectiveEffort, 'high');
    assert.ok(previous.nativeReasoning.updates.length > 0, 'compression is preceded by a carried update, not just base high');
    assert.equal(previous.nativeReasoning.updates.at(-1).effort, 'high');
    const body = f.wires.at(-1).body;
    assert.equal(body.reasoning?.effort, expectedEffort);
    assert.equal(body.reasoning?.mode, 'standard');
    const updates = body.input.filter(item => item.type === 'configuration_update');
    if (!expectedEffort) assert.deepEqual(updates, []);
    else assert.ok(updates.every(item => item.reasoning.effort === expectedEffort));
    const recipe = ordinary.at(-1).recipe;
    assert.equal(recipe.nativeReasoning.effectiveEffort, expectedEffort);
    assert.equal(recipe.nativeReasoning.baseMode, previous.nativeReasoning.baseMode);
    assert.deepEqual(recipe.nativeResponses, previous.nativeResponses);
    assert.deepEqual(body.tools, f.wires.at(-2).body.tools);
    assert.deepEqual(recipe.nativeReasoning.pendingConfigurationUpdate, expectedEffort ? { effort: expectedEffort } : undefined);
    const calls = await f.list('ToolCall'), results = await f.list('ToolModelResult');
    assert.equal(results.length, 2); assert.equal(calls.length, 2);
    assert.deepEqual(results.map(result => result.tool_call_id).sort(), calls.map(call => call.id).sort(), 'each original call settles exactly once');
  }, { async tool() { if (++toolCount === 2) { await setThinking(nextEffort); await enableCompression(); } },
    async send(request, controls, f) {
      const compression = request.recipe.kind === 'reliable-context-compression';
      const content = compression ? { type: 'compression_result', contents: [{ role: 'user', parts: [{ text: 'synthetic summary' }] }] }
        : { role: 'model', parts: f.wires.length === 2 || f.wires.length === 3 ? [{ id: `native-counter-${f.wires.length}`, functionCall: { name: 'counter', args: {} } }] : [{ text: 'done' }] };
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content });
    }
  });
});

const clearAckTargets = [
  { provider: 'openai-compatible', model: 'o3', value: 'medium' },
  { provider: 'gemini', model: 'gemini-2.5-flash', value: '2048' },
  { provider: 'claude', model: 'claude-sonnet-4-5', value: '2048' },
  { provider: 'claude', model: 'claude-opus-4-6', value: 'none' },
  { provider: 'openai-compatible', model: 'deepseek-reasoner', value: 'none' },
  { provider: 'openai-compatible', model: 'gpt-4o' }
];
for (const target of clearAckTargets) test(`review scope clear receipt is channel-independent across switch/reset/clear/inherited set: ${target.provider}/${target.model}`, async () => {
  await fixture(async f => {
    const provider = { ...f.provider, id: 'target-channel', provider: target.provider, model: target.model, models: [{ id: target.model, name: target.model }], generationConfig: { maxOutputTokens: 8192 } };
    const identity = { providerConfigId: provider.id, provider: provider.provider, model: provider.model };
    await f.save('llmProviderConfigs', { configs: [f.provider, provider] });
    let ui;
    const channel = scopeRouter(f, message => ui.receive(message));
    ui = require('./session-thinking-ui-fixture.cjs').createThinkingUi(message => channel.send(message.id, message.type, message.payload));
    const receipts = [];
    const saved = async action => {
      action(); const request = ui.requests.at(-1);
      await ui.store.awaitSavedForScope('conversation', 'parent');
      const receipt = await channel.receive(request.id);
      receipts.push({ request, receipt });
      assert.equal(ui.store.pendingFor('conversation', 'parent'), undefined);
      const capture = f.configuration.mutations.captureModelProfileRoot();
      const disk = await f.configuration.mutations.readModelProfileScope(capture, { scopeKind: 'conversation', scopeId: 'parent' }, () => f.configuration.effectiveConversationModel('parent', f.agent.id));
      assert.deepEqual(JSON.parse(JSON.stringify(ui.store.confirmedFor('conversation', 'parent').profile ?? null)), disk.profile ?? null);
      assert.equal(ui.store.confirmedFor('conversation', 'parent').revision, disk.revision);
      return receipt;
    };
    try {
      ui.store.activateScope('conversation', 'parent'); await channel.receive(ui.requests.at(-1).id);
      await saved(() => ui.control(f.provider, f.provider.model).save('high'));
      const selected = await saved(() => ui.store.setProfileForScope('conversation', 'parent', identity));
      assert.equal(selected.profile.thinkingOverride, undefined, 'model switch clears old OpenAI effort');
      const control = ui.control(provider, provider.model);
      const resetCurrent = () => ui.store.setThinkingForScope('parent', ui.store.effectiveFor('conversation', 'parent'), null);
      if (target.value) await saved(() => control.save(target.value));
      else { assert.equal(control.capability.value, undefined); assert.ok(ui.store.effectiveFor('conversation', 'parent'), 'guarded reset does not depend on thinking capability'); }
      const reset = await saved(resetCurrent);
      assert.equal(reset.profile.providerConfigId, provider.id, 'reset preserves explicit selected model');
      assert.equal(reset.profile.thinkingOverride, undefined);
      await f.configuration.mutations.setModelProfile({ scopeKind: 'agent', scopeId: f.agent.id, ...identity });
      const cleared = await saved(() => ui.store.clearProfileScope('conversation', 'parent'));
      assert.equal(cleared.profile, undefined); assert.equal(cleared.link, undefined);
      assert.deepEqual(cleared.effectiveModel, identity);
      assert.equal(ui.store.pendingFor('conversation', 'parent'), undefined);
      const staleDraft = { scopeKind: 'conversation', scopeId: 'parent', ...identity, authorityId: cleared.authorityId, sessionId: cleared.sessionId,
        expectedRevision: cleared.revision, operation: 'thinking', expectedEffectiveModel: { providerConfigId: f.provider.id, provider: f.provider.provider, model: f.provider.model }, thinkingOverride: { kind: 'openai-effort', value: 'high' } };
      channel.send('old-model-after-clear', channel.T.ModelProfileScopeSet, staleDraft);
      const staleModel = await channel.receive('old-model-after-clear');
      assert.equal(staleModel.outcome, 'uncertain'); assert.match(staleModel.error, /继承模型/);
      channel.send('old-revision-after-clear', channel.T.ModelProfileScopeSet, { ...staleDraft, expectedRevision: reset.revision, expectedEffectiveModel: identity });
      const staleRevision = await channel.receive('old-revision-after-clear');
      assert.equal(staleRevision.outcome, 'uncertain'); assert.match(staleRevision.error, /其他窗口/);
      const stillAbsent = await f.configuration.mutations.readModelProfileScope(f.configuration.mutations.captureModelProfileRoot(), { scopeKind: 'conversation', scopeId: 'parent' });
      assert.equal(stillAbsent.profile, undefined); assert.equal(stillAbsent.revision, cleared.revision);
      if (target.value) {
        const inherited = await saved(() => control.save(target.value));
        assert.equal(inherited.profile.inheritModel, true);
        assert.deepEqual(ui.requests.at(-1).payload.expectedEffectiveModel, identity);
        assert.equal(inherited.profile.providerConfigId, provider.id);
      } else {
        const absentReset = await saved(resetCurrent);
        assert.equal(absentReset.profile, undefined, 'unsupported reset confirms absence, never creates an invalid override');
      }
      assert.equal((await f.app.agentLoop.runInput(f.input(`clear-channel-${target.model}`))).terminalStatus, 'completed');
      assert.equal(f.requests.at(-1).modelId, provider.model);
      const body = f.wires.at(-1).body;
      if (target.provider === 'gemini') { assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 2048); assert.equal(body.reasoning_effort, undefined); }
      if (target.model === 'claude-sonnet-4-5') assert.equal(body.thinking.budget_tokens, 2048);
      if (target.model === 'gpt-4o') assert.equal(body.reasoning_effort, undefined);
      // Assert the real wire clear first: no manufactured host payload or bypassed production path.
      const clearReceipt = receipts.find(item => item.request.type === channel.T.ModelProfileScopeClear);
      assert.equal(clearReceipt.receipt.operation, 'clear');
      assert.equal(clearReceipt.receipt.profileState, 'absent');
      for (const { request, receipt } of receipts) {
        assert.equal(receipt.operation, request.type === channel.T.ModelProfileScopeClear ? 'clear' : request.payload.operation);
        assert.equal(receipt.expectedRevision, request.payload.expectedRevision);
        assert.equal(receipt.profileState, !receipt.profile ? 'absent' : receipt.profile.thinkingOverride ? 'overridden' : 'default');
        assert.equal(receipt.authorityId, request.payload.authorityId); assert.equal(receipt.sessionId, request.payload.sessionId);
      }
    } finally { ui.dispose(); }
  });
});

test('review scope delayed real clear ack releases queued new channel only once, duplicate cannot confirm new write', async () => {
  await fixture(async f => {
    const provider = { ...f.provider, id: 'queued-gemini', provider: 'gemini', model: 'gemini-2.5-flash', models: [{ id: 'gemini-2.5-flash', name: 'Gemini' }], generationConfig: { maxOutputTokens: 8192 } };
    await f.save('llmProviderConfigs', { configs: [f.provider, provider] });
    let ui, delayedId, held;
    const channel = scopeRouter(f, message => { if (message.correlationId === delayedId) held = message; else ui.receive(message); });
    ui = require('./session-thinking-ui-fixture.cjs').createThinkingUi(message => channel.send(message.id, message.type, message.payload));
    try {
      ui.store.activateScope('conversation', 'parent'); await channel.receive(ui.requests.at(-1).id);
      ui.control(f.provider, f.provider.model).save('high'); await ui.store.awaitSavedForScope('conversation', 'parent');
      ui.store.clearProfileScope('conversation', 'parent'); delayedId = ui.requests.at(-1).id;
      await channel.receive(delayedId); assert.ok(held);
      ui.store.setProfileForScope('conversation', 'parent', { providerConfigId: provider.id, provider: provider.provider, model: provider.model });
      assert.equal(ui.requests.at(-1).id, delayedId, 'healthy UI cannot submit newer write before clear settles');
      ui.receive(held); const selected = ui.requests.at(-1);
      assert.equal(selected.payload.operation, 'select');
      ui.receive(held);
      assert.equal(ui.store.pendingFor('conversation', 'parent').requestId, selected.id);
      await ui.store.awaitSavedForScope('conversation', 'parent');
      ui.receive(held);
      assert.equal(ui.store.effectiveFor('conversation', 'parent').providerConfigId, provider.id);
      assert.equal(ui.store.confirmedFor('conversation', 'parent').profile.providerConfigId, provider.id);
      assert.equal(held.payload.operation, 'clear'); assert.equal(held.payload.profileState, 'absent');
    } finally { ui.dispose(); }
  });
});


test('子 Agent 自有另一渠道和协议优先，父 OpenAI effort 不写入子 Gemini wire', async () => {
  await fixture(async f => {
    const childProvider = { ...f.provider, id: 'child-gemini', provider: 'gemini', model: 'gemini-2.5-flash', models: [{ id: 'gemini-2.5-flash', name: 'synthetic Gemini' }], generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 2048 } } };
    await f.save('llmProviderConfigs', { configs: [f.provider, childProvider] });
    await f.configuration.mutations.setModelProfile({ scopeKind: 'agent', scopeId: f.childAgent.id, providerConfigId: childProvider.id, provider: childProvider.provider, model: childProvider.model });
    await f.set('parent', 'high');
    await f.app.agentLoop.runInput(f.input('cross-provider-child'));
    await f.coordinator.waitForIdle();
    const children = f.wires.filter(w => w.conversationId !== 'parent');
    assert.ok(children.length);
    for (const child of children) {
      assert.equal(child.body.generationConfig.thinkingConfig.thinkingBudget, 2048);
      assert.equal(child.body.reasoning_effort, undefined);
      assert.equal(child.body.generationConfig.thinkingConfig.thinkingLevel, undefined);
    }
  }, { async send(request, controls, f) {
    await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: f.requests.length === 1 ? [{ id: 'cross-child', functionCall: { name: 'run_agent', args: { operation: 'spawn', taskName: 'Check cross-provider selection', prompt: 'synthetic cross-provider task' } } }] : [{ text: 'done' }] } });
  } });
});

for (const childModel of [
  { provider: 'gemini', model: 'gemini-2.5-flash', generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 2048 } } },
  { provider: 'openai-compatible', model: 'gpt-5.1', generationConfig: { thinkingConfig: { thinkingLevel: 'low' } } }
]) test(`review child inheritance skips an incompatible override for ${childModel.model}`, async () => {
  await fixture(async f => {
    const parentProvider = { ...f.provider, model: 'gpt-5.2', models: [{ id: 'gpt-5.2', name: 'Parent' }] };
    const childProvider = { ...f.provider, id: 'child-specific', ...childModel, models: [{ id: childModel.model, name: 'Child' }] };
    await f.save('llmProviderConfigs', { configs: [parentProvider, childProvider] });
    await f.configuration.mutations.setModelProfile({ scopeKind: 'agent', scopeId: f.childAgent.id,
      providerConfigId: childProvider.id, provider: childProvider.provider, model: childProvider.model });
    await f.configuration.mutations.setModelProfile({ scopeKind: 'conversation', scopeId: 'parent',
      providerConfigId: parentProvider.id, provider: parentProvider.provider, model: parentProvider.model,
      thinkingOverride: { kind: 'openai-effort', value: 'xhigh' }, inheritThinkingToChildren: true });
    const result = await f.app.agentLoop.runInput(f.input('incompatible-child-thinking'));
    assert.equal(result.terminalStatus, 'completed');
    await f.coordinator.waitForIdle();
    const children = await f.list('ChildExecution');
    assert.equal(children.length, 1);
    assert.equal(children[0].status, 'idle', 'incompatible inheritance must not strand a spawned child');
    const childWires = f.wires.filter(wire => wire.conversationId !== 'parent');
    assert.ok(childWires.length, 'child must complete a provider request using its own settings');
    for (const wire of childWires) {
      if (childProvider.provider === 'gemini') assert.equal(wire.body.generationConfig.thinkingConfig.thinkingBudget, 2048);
      else assert.equal(wire.body.reasoning_effort, 'low');
    }
  }, { async send(request, controls, f) {
    const first = request.conversationId === 'parent' && f.requests.filter(r => r.conversationId === 'parent').length === 1;
    await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [first
      ? { id: 'incompatible-child', functionCall: { name: 'run_agent', args: { operation: 'spawn', taskName: 'Check incompatible child model', prompt: 'use the child model' } } }
      : { text: 'done' }] } });
  } });
});

test('勾选子继承时，实际 child generation 使用父会话当前有效 thinking override', async () => {
  await fixture(async f => {
    await f.configuration.mutations.setModelProfile({
      scopeKind: 'conversation',
      scopeId: 'parent',
      providerConfigId: f.provider.id,
      provider: f.provider.provider,
      model: f.provider.model,
      thinkingOverride: { kind: 'openai-effort', value: 'high' },
      inheritThinkingToChildren: true
    });
    await f.app.agentLoop.runInput(f.input('inherit-child-thinking'));
    await f.coordinator.waitForIdle();
    const childWires = f.wires.filter(wire => wire.conversationId !== 'parent');
    assert.ok(childWires.length, 'child must issue an actual provider request');
    assert.ok(childWires.every(wire => wire.body.reasoning_effort === 'high'));
    // Plan delegation and crash repair read the same choice from the spawning parent Turn.
    const [child] = await f.list('ChildExecution');
    const [parentLink] = await f.list('ChildExecutionParentLink', { child_execution_id: child.id });
    const [parentTurn] = await f.list('Turn', { conversation_id: 'parent' });
    assert.equal(parentLink.parent_turn_id, parentTurn.id);
    assert.deepEqual(await f.app.runtime.children.frozenChildThinkingOverrideForTurn(parentLink.parent_turn_id), { kind: 'openai-effort', value: 'high' });
  }, {
    async send(request, controls, f) {
      const firstParentRequest = request.conversationId === 'parent'
        && f.requests.filter(item => item.conversationId === 'parent').length === 1;
      await controls.onEvent({
        kind: 'completed',
        streamSeq: '1',
        content: { role: 'model', parts: [firstParentRequest
          ? { id: 'inherit-child', functionCall: { name: 'run_agent', args: { operation: 'spawn', taskName: 'Check inherited thinking', prompt: 'inherit thinking' } } }
          : { text: 'done' }] }
      });
    }
  });
});
test('产品接线把父对话冻结的思考强度写入子对话记录，关闭继承时不写', async () => {
  const source = await fs.readFile(path.resolve('backend/application/reliableKernel/VscodeReliableKernelProductRuntime.ts'), 'utf8');
  assert.match(source, /modelProfiles: childConversationModelProfiles\(configuration\.mutations\)/);
  assert.doesNotMatch(source, /initializeConversation: \(\{ conversationId, model \}\)/, 'the product must not drop thinkingOverride');
  const calls = [];
  const store = childConversationModelProfiles({ async initializeConversationModelProfile(input) { calls.push(input); return { created: true }; } });
  await store.initializeConversation({ conversationId: 'child', model: { providerConfigId: 'p', provider: 'claude', model: 'claude-opus-5-5' }, thinkingOverride: { kind: 'claude-effort', value: 'high' } });
  await store.initializeConversation({ conversationId: 'other', model: { model: 'm' } });
  assert.deepEqual(calls, [
    { conversationId: 'child', providerConfigId: 'p', provider: 'claude', model: 'claude-opus-5-5', thinkingOverride: { kind: 'claude-effort', value: 'high' } },
    { conversationId: 'other', model: 'm' }
  ]);
});

test('子对话记录写入前崩溃，启动恢复补写时仍带上父对话选择的思考强度', async () => {
  let crashed = false;
  await fixture(async f => {
    await f.configuration.mutations.setModelProfile({
      scopeKind: 'conversation', scopeId: 'parent', providerConfigId: f.provider.id, provider: f.provider.provider,
      model: f.provider.model, thinkingOverride: { kind: 'openai-effort', value: 'high' }, inheritThinkingToChildren: true
    });
    const mutations = f.configuration.mutations;
    const original = mutations.initializeConversationModelProfile;
    mutations.initializeConversationModelProfile = async function(...args) {
      if (!crashed) { crashed = true; throw new Error('simulated crash before the child model profile'); }
      return original.apply(this, args);
    };
    await f.app.agentLoop.runInput(f.input('inherit-after-crash'));
    await f.coordinator.waitForIdle();
    assert.ok(crashed, 'the spawn must hit the simulated crash');
    await f.coordinator.recoverStartup();
    await f.coordinator.waitForIdle();
    const childWires = f.wires.filter(wire => wire.conversationId !== 'parent');
    assert.ok(childWires.length, 'the repaired child must issue a provider request');
    assert.ok(childWires.every(wire => wire.body.reasoning_effort === 'high'), JSON.stringify(childWires.map(wire => wire.body.reasoning_effort)));
  }, {
    async send(request, controls, f) {
      const firstParentRequest = request.conversationId === 'parent'
        && f.requests.filter(item => item.conversationId === 'parent').length === 1;
      await controls.onEvent({
        kind: 'completed',
        streamSeq: '1',
        content: { role: 'model', parts: [firstParentRequest
          ? { id: 'inherit-crash-child', functionCall: { name: 'run_agent', args: { operation: 'spawn', taskName: 'Check repaired thinking', prompt: 'inherit thinking' } } }
          : { text: 'done' }] }
      });
    }
  });
});

test('首次/工具新请求/下一用户请求用新覆盖；旧请求 replay 保持原快照', async () => {
  await fixture(async f => {
    await f.set('parent', 'high');
    const result = await f.app.agentLoop.runInput(f.input('first'));
    assert.equal(result.terminalStatus, 'completed');
    assert.deepEqual(f.wires.map(w => w.body.reasoning_effort), ['high', 'medium']);
    const replay = await f.app.modelProvider.replay(f.requests[0].modelRequestId);
    assert.equal(replay.authoritySnapshot.model.generationConfig.thinkingConfig.thinkingLevel, 'high');
    assert.deepEqual(replay.settingsSnapshot, f.requests[0].settingsSnapshot);
    await f.set('parent', null);
    await f.app.agentLoop.runInput(f.input('second'));
    assert.equal(f.wires[2].body.reasoning_effort, 'low');
    assert.equal((await f.frozen(result.turnId)).document.model.thinkingConfig.thinkingLevel, 'low', 'Turn identity is not rewritten');
  }, {
    async tool(f) { await f.set('parent', 'medium'); },
    async send(request, controls, f) {
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: f.requests.length === 1 ? [{ id: 'counter-1', functionCall: { name: 'counter', args: {} } }] : [{ text: 'done' }] } });
    }
  });
});

test('同一请求瞬时失败自动重试不读取保存后的思维覆盖', async () => {
  await fixture(async f => {
    await f.set('parent', 'high');
    const result = await f.app.agentLoop.runInput(f.input('retry-thinking'));
    assert.equal(result.terminalStatus, 'completed');
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[0].modelRequestId, f.requests[1].modelRequestId);
    assert.deepEqual(f.requests[0].settingsSnapshot, f.requests[1].settingsSnapshot);
    assert.deepEqual(f.wires.map(w => w.body.reasoning_effort), ['high', 'high']);
  }, { async send(request, controls, f) {
    if (f.requests.length === 1) {
      await f.set('parent', 'medium');
      throw new kernel.ProviderTransientError('temporary_service_error', 'synthetic retry only');
    }
    await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: 'done' }] } });
  } });
});


test('已排队输入在实际新请求冻结时采用新值，不追改在途请求', async () => {
  await fixture(async f => {
    await f.set('parent', 'high');
    await f.app.agentLoop.runInput(f.input('before-queue'));
    const admitted = await f.app.turns.admitNextQueued(f.input('queue-owner'));
    assert.ok(admitted?.turnId);
    await f.app.agentLoop.drive(admitted.turnId);
    assert.deepEqual(f.wires.map(w => w.body.reasoning_effort), ['high', 'medium']);
  }, { async send(request, controls, f) {
    if (f.requests.length === 1) {
      const queued = await f.app.turns.input(f.input('queued-input'));
      assert.equal(queued.admitted, false);
      await f.set('parent', 'medium');
    }
    await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: 'done' }] } });
  } });
});

test('运行中的子 Agent 默认排队续聊，保留当前执行和同一会话', async () => {
  let releaseChild;
  const childGate = new Promise(resolve => { releaseChild = resolve; });
  await fixture(async f => {
    try {
      const parent = await f.app.agentLoop.runInput(f.input('queue-followup'));
      assert.equal(parent.terminalStatus, 'completed');
      const children = await f.list('ChildExecution');
      assert.equal(children.length, 1, 'follow-up must not spawn another child');
      const [active] = await f.list('ChildExecutionActiveTurnLink', { child_execution_id: children[0].id });
      assert.ok(active, 'first child turn remains active');
      const pending = await f.list('ChildExecutionIntentLink', { child_execution_id: children[0].id, state: 'pending' });
      assert.equal(pending.length, 1);
      releaseChild();
      await f.coordinator.waitForIdle();
      await f.coordinator.recoverStartup();
      await f.coordinator.waitForIdle();
      const turns = await f.list('ChildExecutionTurnLink', { child_execution_id: children[0].id });
      assert.equal(turns.length, 2);
      for (const turn of turns) {
        const [terminal] = await f.list('TurnTermination', { turn_id: turn.turn_id });
        assert.equal(terminal.terminal_status, 'completed');
      }
    } finally { releaseChild(); }
  }, { async send(request, controls, f) {
    let part = { text: 'done' };
    const count = f.requests.filter(r => r.conversationId === request.conversationId).length;
    if (request.conversationId === 'parent' && count === 1) part = { id: 'spawn-queued', functionCall: { name: 'run_agent', args: { operation: 'spawn', prompt: 'investigate', taskName: 'Investigate send failure' } } };
    if (request.conversationId === 'parent' && count === 2) {
      const ref = request.recipe.modelHandleCatalog.entries.find(e => e.kind === 'child').ref;
      part = { id: 'followup-queued', functionCall: { name: 'run_agent', args: { operation: 'send', childRef: ref, prompt: 'also verify configuration saving' } } };
    }
    if (request.conversationId !== 'parent' && count === 1) await childGate;
    await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [part] } });
  } });
});

test('实际 coordinator 从父工具创建/嵌套/继续子会话：最终普通 wire 不继承父覆盖', async () => {
  await fixture(async f => {
    await f.set('parent', 'high');
    await f.app.agentLoop.runInput(f.input('delegate'));


    await f.coordinator.waitForIdle();
    const childWires = f.wires.filter(w => w.conversationId !== 'parent');
    assert.ok(new Set(childWires.map(w => w.conversationId)).size >= 2, 'child and nested child ran');
    assert.ok(childWires.every(w => w.body.reasoning_effort === 'low'));
    const [child] = await f.list('ChildExecution');
    await f.set(child.child_conversation_id, 'medium');
    await f.set('parent', 'high');
    await f.app.database.conversationOwners.claim(child.child_conversation_id);
    await f.coordinator.inputFromConversation({ commandId: 'continue-child', childExecutionId: child.id, conversationId: child.child_conversation_id, content: 'continue synthetic child' });
    await f.coordinator.waitForIdle();
    assert.equal(f.wires.filter(w => w.conversationId === child.child_conversation_id).at(-1).body.reasoning_effort, 'medium');
    const oldCatalog = f.requests.filter(r => r.conversationId === 'parent').at(-1).recipe.modelHandleCatalog;
    await f.app.agentLoop.runInput(f.input('parent-sees-completed-children'));
    const next = f.requests.filter(r => r.conversationId === 'parent').at(-1);
    assert.ok(next.recipe.runtimeStatusCard.children.some(c => c.status === 'idle' && c.resumable));
    assert.match(next.recipe.runtimeStatusCard.card, /"childRef":"A1"/);
    for (const ref of oldCatalog.entries.filter(e => e.kind === 'child')) {
      assert.deepEqual(next.recipe.modelHandleCatalog.entries.find(e => e.target === ref.target), ref);
    }
  }, {
    async send(request, controls, f) {
      const depth = request.conversationId === 'parent' ? 0 : new Set(f.requests.filter(r => r.conversationId !== 'parent').map(r => r.conversationId)).size;
      const first = f.requests.filter(r => r.conversationId === request.conversationId).length === 1;
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: first && depth < 2 ? [{ id: `delegate-${depth}`, functionCall: { name: 'run_agent', args: { operation: 'spawn', prompt: 'synthetic child', taskName: `Investigate level ${depth}`, agent: { type: 'worker' } } } }] : [{ text: 'done' }] } });
    }
  });
});

for (const tokens of [0, -1]) test(`review child inheritance sends Gemini budget ${tokens} on the child wire`, async () => {
  await fixture(async f => {
    const provider = { ...f.provider, provider: 'gemini', model: 'gemini-2.5-flash', models: [{ id: 'gemini-2.5-flash', name: 'Gemini' }], generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 2048 } } };
    await f.save('llmProviderConfigs', { configs: [provider] });
    await f.configuration.mutations.setModelProfile({ scopeKind: 'conversation', scopeId: 'parent',
      providerConfigId: provider.id, provider: provider.provider, model: provider.model,
      thinkingOverride: { kind: 'gemini-budget', tokens }, inheritThinkingToChildren: true });
    assert.equal((await f.app.agentLoop.runInput(f.input(`inherit-gemini-${tokens}`))).terminalStatus, 'completed');
    await f.coordinator.waitForIdle();
    const childWires = f.wires.filter(wire => wire.conversationId !== 'parent');
    assert.ok(childWires.length);
    for (const wire of childWires) assert.equal(wire.body.generationConfig.thinkingConfig.thinkingBudget, tokens);
  }, { async send(request, controls, f) {
    const first = request.conversationId === 'parent' && f.requests.filter(r => r.conversationId === 'parent').length === 1;
    await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [first
      ? { id: 'gemini-child', functionCall: { name: 'run_agent', args: { operation: 'spawn', taskName: 'Check inherited Gemini budget', prompt: 'inherit the configured budget' } } }
      : { text: 'done' }] } });
  } });
});

/** 模拟升级前保存、按现在的规则已不合法的会话思考覆盖：直接写记录，不经过保存校验。 */
async function injectSavedThinkingOverride(f, provider, override) {
  const { loadRecordStore, saveRecordStore } = require('../../dist/extension/backend/capabilities/vscodeStorage/recordStore.js');
  await f.save('llmProviderConfigs', { configs: [provider] });
  await f.configuration.mutations.setModelProfile({ scopeKind: 'conversation', scopeId: 'parent', providerConfigId: provider.id, provider: provider.provider, model: provider.model });
  const paths = f.configuration.getPaths();
  const records = await loadRecordStore(paths.modelProfilesRootUri, paths.modelProfilesIndexUri, 'modelProfile');
  const target = records.find(record => record.providerConfigId === provider.id && record.model === provider.model);
  assert.ok(target);
  await saveRecordStore(paths.modelProfilesRootUri, paths.modelProfilesIndexUri, records.map(record => record === target ? { ...record, thinkingOverride: override } : record), 'modelProfile');
}

test('升级前保存的会话思考覆盖：kind 不同但值可用时照常生效，已不合法的按渠道设置发送，对话不再每轮失败', async () => {
  await fixture(async f => {
    const deepseek = { ...f.provider, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek' }], generationConfig: {} };
    await injectSavedThinkingOverride(f, deepseek, { kind: 'openai-effort', value: 'high' });
    assert.equal((await f.app.agentLoop.runInput(f.input('legacy-kind'))).terminalStatus, 'completed');
    assert.deepEqual(f.wires.at(-1).body.thinking, { type: 'enabled' });
    assert.equal(f.wires.at(-1).body.reasoning_effort, 'high');
    await injectSavedThinkingOverride(f, deepseek, { kind: 'openai-effort', value: 'medium' });
    assert.equal((await f.app.agentLoop.runInput(f.input('legacy-value'))).terminalStatus, 'completed');
    assert.equal(f.wires.at(-1).body.thinking, undefined);
    assert.equal(f.wires.at(-1).body.reasoning_effort, undefined);
    // 自定义请求体后来加了思考参数：已保存的覆盖不生效，不报错。
    await f.save('llmProviderConfigs', { configs: [{ ...deepseek, requestBody: { thinking: { type: 'disabled' } } }] });
    assert.equal((await f.app.agentLoop.runInput(f.input('legacy-body'))).terminalStatus, 'completed');
    assert.deepEqual(f.wires.at(-1).body.thinking, { type: 'disabled' });
    const opus = { ...f.provider, provider: 'claude', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', models: [{ id: 'claude-opus-5-5', name: 'Opus' }], generationConfig: {} };
    await injectSavedThinkingOverride(f, opus, { kind: 'claude-effort', value: 'none' });
    assert.equal((await f.app.agentLoop.runInput(f.input('legacy-opus-none'))).terminalStatus, 'completed');
    assert.notEqual(f.wires.at(-1).body.thinking?.type, 'disabled');
    // 修改“子 Agent 也用”开关不因旧覆盖报错，旧覆盖原样保留，界面仍可重置。
    const { send, receive, T } = scopeRouter(f);
    const scope = { scopeKind: 'conversation', scopeId: 'parent' };
    send('legacy-read', T.ModelProfileScopeRead, scope);
    const observed = await receive('legacy-read');
    send('legacy-inherit', T.ModelProfileScopeSet, { ...scope, ...observed.effectiveModel, authorityId: observed.authorityId,
      sessionId: observed.sessionId, expectedRevision: observed.revision, expectedEffectiveModel: observed.effectiveModel,
      operation: 'inherit', inheritThinkingToChildren: true });
    const inherited = await receive('legacy-inherit');
    assert.equal(inherited.outcome, 'committed', inherited.message);
    assert.equal(inherited.profile.inheritThinkingToChildren, true);
    assert.deepEqual(inherited.profile.thinkingOverride, { kind: 'claude-effort', value: 'none' });
    send('legacy-reset', T.ModelProfileScopeSet, { ...scope, ...inherited.effectiveModel, authorityId: inherited.authorityId,
      sessionId: inherited.sessionId, expectedRevision: inherited.revision, expectedEffectiveModel: inherited.effectiveModel,
      operation: 'reset', thinkingOverride: null });
    const reset = await receive('legacy-reset');
    assert.equal(reset.outcome, 'committed', reset.message);
    assert.equal(reset.profile?.thinkingOverride, undefined);
  });
});
