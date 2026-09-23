import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const vscode = createVscodeStub();
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const { createVscodeStoragePaths } = require('../../dist/extension/backend/capabilities/vscodeStorage/paths.js');
const {
  createDefaultLlmProviderConfig,
  normalizeLlmProviderConfig
} = require('../../dist/extension/backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { loadRecordStore } = require('../../dist/extension/backend/capabilities/vscodeStorage/recordStore.js');
const { VscodeConfigurationAuthority } = require('../../dist/extension/backend/reliableKernel/vscodeConfigurationAuthority.js');
const { frozenCompressionPolicy, frozenInteractionAutoApproval } = require('../../dist/extension/backend/reliableKernel/frozenAuthority.js');
const {
  createDefaultLlmCompressionConfig,
  normalizeLlmCompressionMaxDurationMinutes,
  DEFAULT_LLM_RETRY_DELAY_SECONDS,
  MAX_LLM_RETRY_DELAY_SECONDS
} = require('../../dist/extension/shared/protocol.js');
const { resolveToolPolicyLayers } = require('../../dist/extension/shared/toolPolicyResolution.js');
const {
  createRemoteServerWorkEnvironmentRecord,
  workEnvironmentIdFromUri
} = require('../../dist/extension/shared/workEnvironmentCatalog.js');

test('渠道、压缩与 MCP 目录保存只修改选中记录，重复保存保持文件和 revision', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-catalog-delta-'));
  try {
    const authority = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(vscode.Uri.file(root)));
    const cases = [
      ['llmProviderConfigs', 'configs', i => ({ ...createDefaultLlmProviderConfig(), id: `provider-${i}`, name: `Provider ${i}`, createdAt: 1, updatedAt: 1 })],
      ['llmCompressionConfigs', 'configs', i => ({ ...createDefaultLlmCompressionConfig(), id: `compression-${i}`, name: `Compression ${i}`, createdAt: 1, updatedAt: 1 })],
      ['mcpServers', 'servers', i => ({ id: `mcp-${i}`, name: `MCP ${i}`, enabled: false, transport: { kind: 'stdio', command: 'fixture' }, createdAt: 1, updatedAt: 1 })]
    ];
    for (const [section, key, make] of cases) {
      let result = await saveLatestGlobalSettings(authority, section, { [key]: [make(1), make(2)] });
      const index = JSON.parse(await fs.readFile(result.filePath, 'utf8'));
      const otherFile = path.join(path.dirname(result.filePath), index.records.find(r => r.id === make(2).id).file);
      const otherBytes = await fs.readFile(otherFile, 'utf8');
      const edited = structuredClone(result.settings);
      const selected = edited[key].find(r => r.id === make(1).id);
      selected.name = 'Edited'; selected.updatedAt = 2;
      result = await authority.saveGlobalSettings(section, edited, result.revision);
      assert.equal(await fs.readFile(otherFile, 'utf8'), otherBytes, section);
      const indexBytes = await fs.readFile(result.filePath, 'utf8');
      const unchanged = await authority.saveGlobalSettings(section, result.settings, result.revision);
      assert.equal(unchanged.revision, result.revision, section);
      assert.equal(await fs.readFile(result.filePath, 'utf8'), indexBytes, section);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

async function saveLatestGlobalSettings(authority, section, settings) {
  const current = await authority.loadGlobalSettings(section);
  return authority.saveGlobalSettings(section, settings, current.revision);
}

test('effective model observation uses no Turn compile, deduplicates reads and tracks peer revision', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-model-read-cost-'));
  const readFile = fs.readFile;
  try {
    const authority = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(vscode.Uri.file(directory)));
    const provider = { ...createDefaultLlmProviderConfig({ name: 'cache fixture' }), id: 'cost-provider', provider: 'openai-compatible', model: 'o3', models: [{ id: 'o3', name: 'o3' }, { id: 'o4-mini', name: 'o4-mini' }], modelConfigs: [] };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: provider.id });
    const agent = await authority.mutations.createAgent({ name: 'read cost', kind: 'custom' });
    let reads = 0, compiles = 0;
    const compile = authority.compile.bind(authority);
    authority.compile = request => { compiles++; return compile(request); };
    fs.readFile = (...args) => { reads++; return readFile(...args); };
    const result = await Promise.all(Array.from({ length: 5 }, () => authority.effectiveConversationModel('cost-conversation', agent.id)));
    console.log(`MODEL_OBSERVATION_COST concurrent=5 readFile=${reads} compile=${compiles}`);
    assert.ok(result.every(item => item.model === 'o3'));
    assert.equal(compiles, 0, 'UI model observation must not compile prompts/policies/compression');
    assert.ok(reads < 40, 'concurrent observation must share a minimal model-only read');
    await authority.mutations.setModelProfile({ scopeKind: 'agent', scopeId: agent.id, providerConfigId: provider.id, provider: provider.provider, model: 'o4-mini' });
    assert.equal((await authority.effectiveConversationModel('cost-conversation', agent.id)).model, 'o4-mini', 'fresh source revision invalidates cached model');
  } finally { fs.readFile = readFile; await fs.rm(directory, { recursive: true, force: true }); }
});

test('review scope CAS protects inheritance, absence, peer writes, reset and root fencing', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-thinking-scope-'));
  let root = path.join(directory, 'first');
  const getPaths = () => createVscodeStoragePaths(vscode.Uri.file(root));
  try {
    const a = new VscodeConfigurationAuthority(getPaths), b = new VscodeConfigurationAuthority(getPaths);
    const one = { ...createDefaultLlmProviderConfig({ name: 'global' }), id: 'global-o3', provider: 'openai-compatible', model: 'o3', models: [{ id: 'o3', name: 'o3' }], modelConfigs: [] };
    const two = { ...one, id: 'agent-gemini', provider: 'gemini', model: 'gemini-2.5-flash', models: [{ id: 'gemini-2.5-flash', name: 'Gemini' }], generationConfig: { maxOutputTokens: 8192 } };
    await saveLatestGlobalSettings(a, 'llmProviderConfigs', { configs: [one, two] });
    await saveLatestGlobalSettings(a, 'llm', { activeProviderConfigId: one.id });
    const agent = await a.mutations.createAgent({ name: 'scope agent', kind: 'custom' });
    const gemini = { providerConfigId: two.id, provider: two.provider, model: two.model };
    const openai = { providerConfigId: one.id, provider: one.provider, model: one.model };
    await a.mutations.setModelProfile({ scopeKind: 'agent', scopeId: agent.id, ...gemini });
    const effective = () => a.effectiveConversationModel('conversation-a', agent.id);
    const scope = { scopeKind: 'conversation', scopeId: 'conversation-a' };
    const ca = a.mutations.captureModelProfileRoot(), cb = b.mutations.captureModelProfileRoot();
    const first = await a.mutations.readModelProfileScope(ca, scope, effective);
    const peer = await b.mutations.readModelProfileScope(cb, scope, effective);
    assert.equal(first.profile, undefined); assert.deepEqual(first.effectiveModel, gemini);
    const mutation = { ...scope, ...gemini, authorityId: ca.authorityId, expectedRevision: first.revision, operation: 'thinking', expectedEffectiveModel: gemini, thinkingOverride: { kind: 'gemini-budget', tokens: 2048 } };
    const saved = await a.mutations.writeModelProfileScope(ca, mutation, false, effective);
    assert.equal(saved.profile.inheritModel, true);
    assert.deepEqual(await effective(), gemini);
    assert.equal((await a.loadRequestGenerationSettings(gemini, scope.scopeId)).generationConfig.thinkingConfig.thinkingBudget, 2048);
    await assert.rejects(b.mutations.writeModelProfileScope(cb, { ...mutation, authorityId: cb.authorityId, expectedRevision: peer.revision }, false, effective), /其他窗口/);
    const other = { scopeKind: 'conversation', scopeId: 'conversation-b' };
    const otherBefore = await b.mutations.readModelProfileScope(cb, other);
    await b.mutations.writeModelProfileScope(cb, { ...other, ...openai, authorityId: cb.authorityId, expectedRevision: otherBefore.revision, operation: 'select' }, false);
    assert.equal((await a.mutations.readModelProfileScope(ca, scope)).revision, saved.revision, 'other scope does not conflict');
    await a.mutations.setModelProfile({ scopeKind: 'agent', scopeId: agent.id, ...openai });
    await assert.rejects(a.mutations.writeModelProfileScope(ca, { ...mutation, expectedRevision: saved.revision }, false, effective), /继承模型/);
    assert.deepEqual(await effective(), openai, 'thinking overlay does not pin the old Gemini model');
    const reset = await a.mutations.writeModelProfileScope(ca, { ...mutation, expectedRevision: saved.revision, operation: 'reset', expectedEffectiveModel: openai }, false, effective);
    assert.equal(reset.profile, undefined, 'reset of inherit-only overlay restores true absence');
    const explicit = await a.mutations.writeModelProfileScope(ca, { ...scope, ...openai, authorityId: ca.authorityId, expectedRevision: reset.revision, operation: 'select' }, false, effective);
    const resetExplicit = await a.mutations.writeModelProfileScope(ca, { ...scope, ...openai, authorityId: ca.authorityId, expectedRevision: explicit.revision, operation: 'reset', expectedEffectiveModel: openai }, false, effective);
    assert.equal(resetExplicit.profile.model, one.model, 'reset preserves explicit model selection');
    await assert.rejects(a.mutations.writeModelProfileScope(ca, { ...scope, ...openai, operation: 'select' }, false), /revision/);
    root = path.join(directory, 'second');
    const next = a.mutations.captureModelProfileRoot();
    await assert.rejects(a.mutations.writeModelProfileScope(ca, { ...mutation, expectedRevision: resetExplicit.revision }, false, effective), /改变/);
    assert.equal((await a.mutations.readModelProfileScope(next, scope)).profile, undefined, 'old queued write cannot enter new root');
    a.mutations.retireModelProfileAuthority();
    assert.throws(() => a.mutations.captureModelProfileRoot(), /已结束/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('review completion fence waits preflight and settled failure; expiry/inflight is never cancellation', async () => {
  const { ModelProfileMutationCompletions } = require('../../dist/extension/backend/application/reliableKernel/ModelProfileMutationCompletions.js');
  let time = 0, release, stored = 0;
  const registry = new ModelProfileMutationCompletions(() => time, 2, 10);
  const gate = new Promise(resolve => { release = resolve; });
  const original = registry.register('scope:a:first', async () => { await gate; stored = 1; throw new Error('synthetic failure after write'); }).catch(error => error.message);
  await assert.rejects(registry.after('scope:a:first', 1), /在途/);
  assert.equal(stored, 0);
  const occupied = registry.register('scope:b:second', async () => { await gate; });
  await assert.rejects(registry.register('scope:a:first', async () => { throw new Error('must not run'); }), /重复/);
  await assert.rejects(registry.register('scope:c:overflow', async () => { throw new Error('must not run'); }), /处理中/);
  await assert.rejects(registry.after('scope:c:overflow'), /未知/);
  time = 100;
  await assert.rejects(registry.after('scope:a:first', 1), /在途/, 'pending entries do not expire as settled');
  release(); await original; await occupied; await registry.after('scope:a:first');
  assert.equal(stored, 1, 'settled rejection may have written; only subsequent actual read can decide');
  time = 200;
  await assert.rejects(registry.after('scope:a:first'), /未知/);
  await assert.rejects(registry.after('scope:a:unknown'), /未知/);
});

for (const operation of ['absent-set', 'existing-set', 'clear']) test(`review scope session fence between record/link writes is readable partial commit: ${operation}`, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-thinking-partial-'));
  try {
    const authority = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(vscode.Uri.file(directory)));
    const mutation = authority.mutations, capture = mutation.captureModelProfileRoot();
    const scope = { scopeKind: 'conversation', scopeId: 'partial-scope' };
    const selection = { providerConfigId: 'synthetic', provider: 'openai-compatible', model: 'o3' };
    if (operation !== 'absent-set') await mutation.setModelProfile({ ...scope, ...selection });
    const before = await mutation.readModelProfileScope(capture, scope);
    let guardCalls = 0, reconnectRead, enteredSecondWrite = false;
    const fence = () => {
      if (++guardCalls === 4) {
        // This is the real second store-write guard, after saveStore(index+record) completed.
        enteredSecondWrite = true;
        reconnectRead = mutation.readModelProfileScope(capture, scope);
        throw new Error('synthetic session changed between stores');
      }
    };
    await assert.rejects(mutation.writeModelProfileScope(capture, { ...scope, ...selection, model: 'o4-mini', operation: 'select', authorityId: capture.authorityId, expectedRevision: before.revision }, operation === 'clear', undefined, fence), /session changed/);
    assert.equal(enteredSecondWrite, true);
    const after = await reconnectRead;
    const catalog = await authority.configurationClientState();
    assert.ok(catalog.modelProfileScopeLinks.every(link => catalog.modelProfiles.some(profile => profile.id === link.modelProfileId)), 'no dangling link');
    if (operation === 'existing-set') {
      assert.equal(after.profile.model, 'o4-mini', 'failure has already changed the linked record');
      assert.equal(after.link.id, before.link.id);
      assert.notEqual(after.revision, before.revision);
    } else {
      assert.equal(after.profile, undefined); assert.equal(after.link, undefined);
      assert.equal(catalog.modelProfiles.length, 1, 'unreachable record is retained, never silently compensated/deleted');
      if (operation === 'absent-set') assert.equal(after.revision, before.revision, 'unpublished record cannot change safe absence');
    }
    // An explicit user operation using the actual observation can recover without removing locks.
    const recovered = await mutation.writeModelProfileScope(capture, { ...scope, ...selection, operation: 'select', authorityId: capture.authorityId, expectedRevision: after.revision }, false);
    assert.equal(recovered.profile.model, 'o3'); assert.equal(recovered.outcome, 'committed');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('调试默认设置使用独立设置文件、现有修订检查与当前数据目录，不保存开启状态', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-debug-settings-'));
  try {
    let currentRoot = path.join(root, 'first');
    const authority = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(vscode.Uri.file(currentRoot)));
    const initial = await authority.loadGlobalSettings('debugCapture');
    assert.deepEqual(initial.settings, { scope: 'conversation', maxMiB: 32, maxMinutes: 30 });
    assert.equal(initial.filePath, path.join(currentRoot, 'settings', 'debug-capture.json'));
    const updated = await authority.saveGlobalSettings('debugCapture', {
      scope: 'workspace', maxMiB: 8, maxMinutes: 5, enabled: true
    }, initial.revision);
    assert.deepEqual(updated.settings, { scope: 'workspace', maxMiB: 8, maxMinutes: 5 });
    await assert.rejects(authority.saveGlobalSettings('debugCapture', initial.settings, initial.revision), /revision|版本|冲突/i);
    const saved = JSON.parse(await fs.readFile(initial.filePath, 'utf8'));
    assert.equal('enabled' in saved.settings, false);
    currentRoot = path.join(root, 'second');
    const switched = await authority.loadGlobalSettings('debugCapture');
    assert.deepEqual(switched.settings, initial.settings);
    assert.equal(switched.filePath, path.join(currentRoot, 'settings', 'debug-capture.json'));
    assert.deepEqual(JSON.parse(await fs.readFile(initial.filePath, 'utf8')).settings, updated.settings);
    const damaged = JSON.parse(await fs.readFile(switched.filePath, 'utf8'));
    damaged.settings.maxMiB = 999;
    await fs.writeFile(switched.filePath, JSON.stringify(damaged));
    await assert.rejects(authority.loadGlobalSettings('debugCapture'), /内容损坏/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('会话思维覆盖持久化、隔离、模型替代、Fork独立及子初始化不复制', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-session-thinking-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    let authority = new VscodeConfigurationAuthority(() => paths);
    const provider = { ...createDefaultLlmProviderConfig({ name: 'synthetic' }), id: 'thinking', provider: 'openai-compatible', model: 'o3', models: [{ id: 'o3', name: 'o3' }, { id: 'o4-mini', name: 'o4' }], generationConfig: { thinkingConfig: { thinkingLevel: 'low' } }, modelConfigs: [] };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: provider.id });
    const selection = { providerConfigId: provider.id, provider: provider.provider, model: 'o3' };
    const set = (scopeId, value, other = {}) => authority.mutations.setModelProfile({ scopeKind: 'conversation', scopeId, ...selection, thinkingOverride: value ? { kind: 'openai-effort', value } : null, ...other });
    const thinking = async (id, model = selection) => (await authority.loadRequestGenerationSettings(model, id)).generationConfig.thinkingConfig?.thinkingLevel;
    await set('parent', 'high');
    assert.equal(await thinking('parent'), 'high');
    assert.equal(await thinking('other'), 'low');
    authority = new VscodeConfigurationAuthority(() => paths);
    assert.equal(await thinking('parent'), 'high');
    await authority.mutations.copyConversationConfiguration('parent', 'fork');
    await set('parent', 'medium');
    assert.equal(await thinking('fork'), 'high');
    await authority.mutations.initializeConversationModelProfile({ conversationId: 'child', ...selection });
    assert.equal(await thinking('child'), 'low');
    await set('child', 'medium');
    await authority.mutations.initializeConversationModelProfile({ conversationId: 'child', ...selection });
    assert.equal(await thinking('child'), 'medium');
    await authority.mutations.initializeConversationModelProfile({ conversationId: 'nested', ...selection });
    assert.equal(await thinking('nested'), 'low');
    await set('parent', null);
    assert.equal(await thinking('parent'), 'low');
    await set('parent', 'high');
    await set('parent', null, { model: 'o4-mini' });
    assert.equal(await thinking('parent', { ...selection, model: 'o4-mini' }), 'low');
    await assert.rejects(authority.mutations.setModelProfile({ scopeKind: 'agent', scopeId: 'main', ...selection, thinkingOverride: { kind: 'openai-effort', value: 'high' } }), /仅限/);
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [{ ...provider, modelConfigs: [{ modelId: 'o3', toolCallFormat: 'function-call', systemPromptPrefix: '' }] }] });
    assert.equal(await thinking('other'), undefined, 'model-specific empty config does not inherit channel low');
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [{ ...provider, requestBody: { reasoning_effort: 'low' } }] });
    await assert.rejects(set('other', 'high'), /自定义请求体/);
    await set('other', null);
    assert.equal((await authority.loadRequestGenerationSettings(selection, 'other')).thinkingControlledByBody, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test('全局 UA 随当前配置根持久化，旧窗口不能覆盖且损坏记录不回退默认值', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-network-settings-'));
  try {
    let currentRoot = path.join(root, 'first');
    const getPaths = () => createVscodeStoragePaths(vscode.Uri.file(currentRoot));
    const authority = new VscodeConfigurationAuthority(getPaths);
    const peer = new VscodeConfigurationAuthority(getPaths);
    const initial = await authority.loadGlobalSettings('network');
    const stale = await peer.loadGlobalSettings('network');
    const updated = await authority.saveGlobalSettings('network', {
      userAgent: '  Global Client/1 (Windows)  '
    }, initial.revision);
    assert.deepEqual(updated.settings, { userAgent: 'Global Client/1 (Windows)' });
    assert.equal(updated.filePath, path.join(currentRoot, 'settings', 'network.json'));
    await assert.rejects(peer.saveGlobalSettings('network', { userAgent: 'stale client' }, stale.revision), /revision|版本|冲突/i);
    assert.deepEqual((await peer.loadGlobalSettings('network')).settings, updated.settings);

    currentRoot = path.join(root, 'second');
    const switched = await authority.loadGlobalSettings('network');
    assert.deepEqual(switched.settings, { userAgent: '' });
    assert.equal(switched.filePath, path.join(currentRoot, 'settings', 'network.json'));
    assert.deepEqual(JSON.parse(await fs.readFile(updated.filePath, 'utf8')).settings, updated.settings);
    const damaged = JSON.parse(await fs.readFile(switched.filePath, 'utf8'));
    damaged.settings.userAgent = 42;
    await fs.writeFile(switched.filePath, JSON.stringify(damaged));
    await assert.rejects(authority.loadGlobalSettings('network'), /内容损坏/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ToolPolicy 层按能力上界收窄、深合并配置，并保持来源 deny 单调', () => {
  const resolved = resolveToolPolicyLayers([
    {
      scopeKind: 'global',
      policy: {
        id: 'global-policy',
        allowedTools: ['read', 'write', 'bash'],
        preset: 'yolo',
        toolConfigs: {
          bash: {
            config: { limits: { lines: 20, chars: 1000 }, cwd: 'global' },
            autoApproveExecution: false,
            display: { autoExpand: false, autoOpenDiffPreview: true }
          }
        },
        sourceConfigs: {
          exa: { enabled: false, disabledTools: ['exa_global_denied'] }
        }
      }
    },
    {
      scopeKind: 'agent',
      policy: {
        id: 'agent-policy',
        allowedTools: ['read', 'bash', 'skills'],
        preset: 'inherit',
        toolConfigs: {
          bash: {
            config: { limits: { chars: 500 }, cwd: 'agent' },
            autoApproveExecution: true,
            display: { autoExpand: true }
          }
        },
        sourceConfigs: {
          exa: { enabled: true, disabledTools: ['exa_agent_denied'] }
        }
      }
    },
    {
      scopeKind: 'workflow',
      policy: {
        id: 'workflow-policy',
        allowedTools: ['bash'],
        preset: 'inherit'
      }
    }
  ], ['read', 'write', 'bash', 'skills', 'delete']);

  assert.equal(resolved.id, 'workflow-policy');
  assert.equal(resolved.preset, 'yolo');
  assert.deepEqual(resolved.allowedTools, ['bash']);
  assert.deepEqual(resolved.toolConfigs.bash, {
    config: { limits: { lines: 20, chars: 500 }, cwd: 'agent' },
    autoApproveExecution: true,
    display: { autoExpand: true, autoOpenDiffPreview: true }
  });
  assert.deepEqual(resolved.sourceConfigs.exa, {
    enabled: false,
    disabledTools: ['exa_agent_denied', 'exa_global_denied']
  });
});

test('VscodeConfigurationAuthority 独立持久化配置记录/Link，并按 Run→Conversation→Workflow→Agent→Global 冻结 authority', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-configuration-authority-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const provider = {
      ...createDefaultLlmProviderConfig({ name: '测试 Provider' }),
      id: 'provider:test',
      model: 'model:test',
      models: [{ id: 'model:test', name: '测试模型' }],
      systemPromptPrefix: '渠道默认前置要求',
      modelConfigs: [{
        id: 'model-config:test',
        modelId: 'model:test',
        toolCallFormat: 'function-call',
        openaiResponsesTransport: 'http',
        stream: true,
        retryOnError: true,
        retryMaxAttempts: 3,
        enableMultimodalTools: true,
        contextWindowTokens: 180_000,
        generationConfig: { maxOutputTokens: 24_000 },
        systemPromptPrefix: '模型专属前置要求',
        createdAt: 1,
        updatedAt: 1
      }]
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: provider.id });

    const folderPath = path.join(root, 'workspace');
    await fs.mkdir(folderPath, { recursive: true });
    const folderUri = vscode.Uri.file(folderPath).toString();
    await authority.synchronizeWorkspaceFolders([{ uri: folderUri, name: 'Workspace', rootPath: folderPath, index: 0 }]);
    const workEnvironmentId = workEnvironmentIdFromUri(folderUri);
    const remoteEnvironment = await authority.mutations.upsertWorkEnvironment(createRemoteServerWorkEnvironmentRecord({
      id: 'work-env-remote-test',
      name: 'Remote Test',
      host: 'remote.test'
    }));

    const agent = await authority.mutations.createAgent({ name: '配置 Agent', kind: 'custom' });
    const workflow = await authority.mutations.createWorkflow({ name: '可靠 Workflow' });
    await authority.mutations.selectConversationWorkflow({
      conversationId: 'conversation:test',
      scopeKind: 'workflow',
      workflowId: workflow.id
    });
    await authority.mutations.setModelProfile({
      scopeKind: 'conversation',
      scopeId: 'conversation:test',
      name: '对话模型',
      providerConfigId: provider.id,
      provider: provider.provider,
      model: 'model:test'
    });
    await authority.mutations.setToolPolicy({
      scopeKind: 'global',
      name: '全局工具',
      allowedTools: ['read'],
      sourceConfigs: {
        'mcp-exa': { enabled: true, disabledTools: ['exa_hidden'] }
      }
    });
    await authority.mutations.setToolPolicy({
      scopeKind: 'workflow',
      scopeId: workflow.id,
      name: 'Workflow 工具',
      allowedTools: ['read', 'skills']
    });
    await authority.mutations.setPlanReviewPolicy({
      scopeKind: 'workflow',
      scopeId: workflow.id,
      mode: 'before_mutation',
      allowReadonlyBeforeApproval: true,
      requireForToolRiskLevels: ['write']
    });
    await authority.mutations.setSystemPrompt({ scopeKind: 'global', name: '全局规则', text: 'GLOBAL' });
    await authority.mutations.setSystemPrompt({ scopeKind: 'agent', scopeId: agent.id, name: 'Agent 规则', text: 'AGENT' });
    await authority.mutations.setSystemPrompt({ scopeKind: 'workflow', scopeId: workflow.id, name: '工作流规则', text: 'WORKFLOW' });
    await authority.mutations.setSystemPrompt({ scopeKind: 'conversation', scopeId: 'conversation:test', name: '对话规则', text: 'CONVERSATION' });
    await authority.mutations.setRuntimeContext({
      scopeKind: 'conversation',
      scopeId: 'conversation:test',
      template: 'ENV:\n{{$workEnvironment.current}}'
    });
    await authority.mutations.setWorkEnvironmentPolicy({
      scopeKind: 'conversation',
      scopeId: 'conversation:test',
      enabled: true,
      allowedWorkEnvironmentIds: [workEnvironmentId],
      defaultWorkEnvironmentId: workEnvironmentId
    });
    await authority.mutations.selectConversationWorkEnvironment('conversation:test', workEnvironmentId);
    await authority.mutations.copyConversationConfiguration('conversation:test', 'conversation:fork');

    const snapshot = await authority.configurationClientState();
    assert.equal(snapshot.agents.some((record) => record.id === agent.id), true);
    assert.equal(snapshot.workflows.some((record) => record.id === workflow.id), true);
    assert.equal(snapshot.workflows.some((record) => record.id === 'builtin:plan'), true);
    assert.equal(snapshot.conversationWorkflowSelections.length, 2);
    assert.equal(snapshot.conversationWorkflowSelections.find((record) =>
      record.conversationId === 'conversation:fork'
    )?.workflowId, workflow.id);
    assert.equal(snapshot.conversationWorkEnvironmentLinks.length, 2);
    assert.equal(snapshot.conversationWorkEnvironmentLinks.find((record) =>
      record.conversationId === 'conversation:fork'
    )?.workEnvironmentId, workEnvironmentId);
    assert.equal(snapshot.workEnvironments.find((record) => record.id === workEnvironmentId)?.available, true);
    const sourceModelLink = snapshot.modelProfileScopeLinks.find((link) =>
      link.scopeKind === 'conversation' && link.scopeId === 'conversation:test'
    );
    const forkModelLink = snapshot.modelProfileScopeLinks.find((link) =>
      link.scopeKind === 'conversation' && link.scopeId === 'conversation:fork'
    );
    assert.ok(sourceModelLink);
    assert.ok(forkModelLink);
    assert.notEqual(forkModelLink.modelProfileId, sourceModelLink.modelProfileId);
    assert.equal(snapshot.modelProfiles.find((record) => record.id === forkModelLink.modelProfileId)?.model, 'model:test');
    const forkLinks = (links) => links.filter((link) => link.scopeKind === 'conversation' && link.scopeId === 'conversation:fork');
    // Every Conversation-layer value the source owns becomes the fork's own copy.
    for (const [links, field] of [
      [snapshot.systemPromptScopeLinks, 'systemPromptId'],
      [snapshot.runtimeContextScopeLinks, 'runtimeContextId'],
      [snapshot.workEnvironmentPolicyScopeLinks, 'workEnvironmentPolicyId']
    ]) {
      const source = links.find((link) => link.scopeKind === 'conversation' && link.scopeId === 'conversation:test');
      assert.equal(forkLinks(links).length, 1);
      assert.notEqual(forkLinks(links)[0][field], source[field]);
    }
    // Layers the source only inherits from workflow/global scopes stay inherited on the fork.
    for (const links of [
      snapshot.planReviewPolicyScopeLinks,
      snapshot.toolPolicyScopeLinks,
      snapshot.skillPolicyScopeLinks,
      snapshot.checkpointPolicyScopeLinks
    ]) {
      assert.deepEqual(forkLinks(links), []);
    }

    const forkCompiled = await authority.compile({
      conversationId: 'conversation:fork',
      turnId: 'turn:fork',
      executorAgentId: agent.id,
      intentKind: 'input'
    });
    const forkFrozen = JSON.parse(forkCompiled.authoritySnapshot.content);
    const forkPreset = JSON.parse(forkCompiled.executionPreset.content);
    assert.equal(forkFrozen.model.modelId, 'model:test');
    assert.equal(forkFrozen.planReviewPolicy.mode, 'before_mutation');
    assert.match(forkFrozen.systemPrompt.text, /\[对话规则\]\nCONVERSATION$/);
    assert.equal(forkFrozen.runtimeContext.template, 'ENV:\n{{$workEnvironment.current}}');
    assert.equal(forkPreset.defaultWorkEnvironmentId, workEnvironmentId);

    await authority.mutations.setModelProfile({
      scopeKind: 'conversation',
      scopeId: 'conversation:test',
      providerConfigId: provider.id,
      provider: provider.provider,
      model: 'model:source-after-fork'
    });
    const afterSourceModelChange = await authority.configurationClientState();
    assert.equal(afterSourceModelChange.modelProfiles.find((record) =>
      record.id === forkModelLink.modelProfileId
    )?.model, 'model:test');
    await authority.mutations.setModelProfile({
      scopeKind: 'conversation',
      scopeId: 'conversation:test',
      name: '对话模型',
      providerConfigId: provider.id,
      provider: provider.provider,
      model: 'model:test'
    });

    const compiled = await authority.compile({
      conversationId: 'conversation:test',
      turnId: 'turn:test',
      executorAgentId: agent.id,
      intentKind: 'input'
    });
    const frozen = JSON.parse(compiled.authoritySnapshot.content);
    assert.equal(frozen.model.providerConfigId, provider.id);
    assert.equal(frozen.model.modelId, 'model:test');
    assert.equal(frozen.model.systemPromptPrefix, '模型专属前置要求');
    assert.equal(frozen.model.maxOutputTokens, 24_000);
    assert.equal(frozen.compression.config.llmSummary.targetTokens, 8_000);
    assert.equal(frozen.compression.provider.contextWindowTokens, 180_000);
    assert.equal(frozen.compression.provider.maxOutputTokens, 16_000);
    assert.deepEqual(frozen.toolPolicy.allowedTools, ['read']);
    assert.deepEqual(frozen.toolPolicy.sourceConfigs, {
      'mcp-exa': { enabled: true, disabledTools: ['exa_hidden'] }
    });
    assert.equal(frozen.planReviewPolicy.mode, 'before_mutation');
    assert.deepEqual(frozen.planReviewPolicy.requireForToolRiskLevels, ['write']);
    assert.equal(
      frozen.systemPrompt.text,
      '[全局规则]\nGLOBAL\n\n[Agent 规则]\nAGENT\n\n[工作流规则]\nWORKFLOW\n\n[对话规则]\nCONVERSATION'
    );
    assert.equal(frozen.runtimeContext.template, 'ENV:\n{{$workEnvironment.current}}');
    assert.match(frozen.runtimeContext.text, /Workspace · 本地/);
    assert.doesNotMatch(frozen.runtimeContext.text, /work-env-/);
    assert.equal(frozen.workEnvironmentPolicy.enabled, true);
    assert.deepEqual(frozen.workEnvironmentPolicy.allowedWorkEnvironmentIds, [workEnvironmentId]);
    assert.equal(frozen.workEnvironmentPolicy.defaultWorkEnvironmentId, workEnvironmentId);

    await authority.mutations.clearWorkEnvironmentPolicy('conversation', 'conversation:test');
    const withoutEnvironmentPolicy = JSON.parse((await authority.compile({
      conversationId: 'conversation:test',
      turnId: 'turn:no-environment-policy',
      executorAgentId: agent.id,
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.equal(withoutEnvironmentPolicy.workEnvironmentPolicy.enabled, false);
    assert.match(withoutEnvironmentPolicy.runtimeContext.text, /Workspace · 本地/);
    assert.doesNotMatch(withoutEnvironmentPolicy.runtimeContext.text, /work-env-/);

    // 子 Agent 继承父 Turn 冻结的工作环境边界：自身无策略时收敛到父边界，只收紧不放宽。
    const childInherited = JSON.parse((await authority.compile({
      conversationId: 'conversation:child-inherited',
      turnId: 'turn:child-inherited',
      executorAgentId: agent.id,
      intentKind: 'input',
      inheritedWorkEnvironmentPolicy: {
        enabled: true,
        allowedWorkEnvironmentIds: [workEnvironmentId],
        defaultWorkEnvironmentId: workEnvironmentId
      }
    })).authoritySnapshot.content);
    assert.deepEqual(childInherited.workEnvironmentPolicy.allowedWorkEnvironmentIds, [workEnvironmentId]);
    assert.equal(childInherited.workEnvironmentPolicy.defaultWorkEnvironmentId, workEnvironmentId);

    // 交集为父边界子集；父默认环境在交集内时被保留。
    await authority.mutations.setRuntimeContext({
      scopeKind: 'conversation',
      scopeId: 'conversation:child-remote-only',
      template: 'ENV:\n{{$workEnvironment.current}}'
    });
    const childRemoteOnly = JSON.parse((await authority.compile({
      conversationId: 'conversation:child-remote-only',
      turnId: 'turn:child-remote-only',
      executorAgentId: agent.id,
      intentKind: 'input',
      inheritedWorkEnvironmentPolicy: {
        enabled: true,
        allowedWorkEnvironmentIds: [remoteEnvironment.id],
        defaultWorkEnvironmentId: remoteEnvironment.id
      }
    })).authoritySnapshot.content);
    assert.deepEqual(childRemoteOnly.workEnvironmentPolicy.allowedWorkEnvironmentIds, [remoteEnvironment.id]);
    assert.equal(childRemoteOnly.workEnvironmentPolicy.defaultWorkEnvironmentId, remoteEnvironment.id);
    assert.match(childRemoteOnly.runtimeContext.text, /Remote Test/);
    assert.doesNotMatch(childRemoteOnly.runtimeContext.text, /Workspace · 本地/);

    await authority.mutations.setWorkEnvironmentPolicy({
      scopeKind: 'conversation',
      scopeId: 'conversation:child-disjoint',
      enabled: true,
      allowedWorkEnvironmentIds: [workEnvironmentId],
      defaultWorkEnvironmentId: workEnvironmentId
    });
    await authority.mutations.setRuntimeContext({
      scopeKind: 'conversation',
      scopeId: 'conversation:child-disjoint',
      template: 'ENV:\n{{$workEnvironment.current}}'
    });
    await assert.rejects(authority.compile({
      conversationId: 'conversation:child-disjoint',
      turnId: 'turn:child-disjoint',
      executorAgentId: agent.id,
      intentKind: 'input',
      inheritedWorkEnvironmentPolicy: {
        enabled: true,
        allowedWorkEnvironmentIds: [remoteEnvironment.id],
        defaultWorkEnvironmentId: remoteEnvironment.id
      }
    }), /未获当前策略允许/);

    // Multiple candidates without a project, explicit selection or default require a choice.
    await assert.rejects(authority.compile({
      conversationId: 'conversation:child-unbounded',
      turnId: 'turn:child-unbounded',
      executorAgentId: agent.id,
      intentKind: 'input'
    }), /多个工作环境/);

    const changedProvider = {
      ...provider,
      modelConfigs: provider.modelConfigs.map((modelConfig) => ({
        ...modelConfig,
        systemPromptPrefix: '后来修改的模型要求',
        updatedAt: 2
      }))
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [changedProvider] });
    const afterSettingsChange = JSON.parse((await authority.compile({
      conversationId: 'conversation:test',
      turnId: 'turn:after-settings-change',
      executorAgentId: agent.id,
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.equal(frozen.model.systemPromptPrefix, '模型专属前置要求');
    assert.equal(afterSettingsChange.model.systemPromptPrefix, '后来修改的模型要求');

    await authority.mutations.clearToolPolicy('workflow', workflow.id);
    const inherited = JSON.parse((await authority.compile({
      conversationId: 'conversation:test',
      turnId: 'turn:inherited',
      executorAgentId: agent.id,
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.deepEqual(inherited.toolPolicy.allowedTools, ['read']);
    assert.deepEqual(inherited.toolPolicy.sourceConfigs, {
      'mcp-exa': { enabled: true, disabledTools: ['exa_hidden'] }
    });

    await authority.mutations.deleteWorkflow(workflow.id);
    const afterDelete = await authority.configurationClientState();
    assert.equal(afterDelete.workflows.some((record) => record.id === workflow.id), false);
    assert.equal(afterDelete.conversationWorkflowSelections.length, 0);
    assert.equal(afterDelete.systemPromptScopeLinks.some((link) => link.scopeKind === 'workflow' && link.scopeId === workflow.id), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('子 Agent 模型优先级、父 Turn fallback 与手动续聊的 Conversation 选择保持稳定', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-child-model-inheritance-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const provider = {
      ...createDefaultLlmProviderConfig({ name: '子 Agent 模型测试 Provider' }),
      id: 'provider:child-model-test',
      model: 'model:global',
      models: [
        { id: 'model:global', name: 'Global' },
        { id: 'model:parent', name: 'Parent' },
        { id: 'model:child-agent', name: 'Child Agent' },
        { id: 'model:manual', name: 'Manual' }
      ],
      modelConfigs: []
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: provider.id });
    const parentFallback = {
      providerConfigId: provider.id,
      provider: provider.provider,
      model: 'model:parent'
    };

    await authority.mutations.setModelProfile({
      scopeKind: 'agent',
      scopeId: 'main',
      name: '子 Agent 自有模型',
      providerConfigId: provider.id,
      provider: provider.provider,
      model: 'model:child-agent'
    });
    const agentProfileWins = JSON.parse((await authority.compile({
      conversationId: 'conversation:child-agent-profile',
      turnId: 'turn:child-agent-profile',
      executorAgentId: 'main',
      intentKind: 'input',
      modelFallback: parentFallback
    })).authoritySnapshot.content);
    assert.equal(agentProfileWins.model.modelId, 'model:child-agent');

    await authority.mutations.clearModelProfile('agent', 'main');
    const parentFallbackWins = JSON.parse((await authority.compile({
      conversationId: 'conversation:child-parent-fallback',
      turnId: 'turn:child-parent-fallback',
      executorAgentId: 'main',
      intentKind: 'input',
      modelFallback: parentFallback
    })).authoritySnapshot.content);
    assert.equal(parentFallbackWins.model.modelId, 'model:parent');
    assert.notEqual(parentFallbackWins.model.modelId, 'model:global');

    assert.deepEqual(await authority.mutations.initializeConversationModelProfile({
      conversationId: 'conversation:child-parent-fallback',
      ...parentFallback
    }), { created: true });
    const manualContinuation = JSON.parse((await authority.compile({
      conversationId: 'conversation:child-parent-fallback',
      turnId: 'turn:child-manual-continuation',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.equal(manualContinuation.model.modelId, 'model:parent');

    await authority.mutations.setModelProfile({
      scopeKind: 'conversation',
      scopeId: 'conversation:child-parent-fallback',
      name: '用户显式切换',
      providerConfigId: provider.id,
      provider: provider.provider,
      model: 'model:manual'
    });
    assert.deepEqual(await authority.mutations.initializeConversationModelProfile({
      conversationId: 'conversation:child-parent-fallback',
      ...parentFallback
    }), { created: false });
    const explicitSwitchWins = JSON.parse((await authority.compile({
      conversationId: 'conversation:child-parent-fallback',
      turnId: 'turn:child-explicit-switch',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.equal(explicitSwitchWins.model.modelId, 'model:manual');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('VscodeConfigurationAuthority 让 Agent 缺省 preset 继承全局 YOLO，同时保留能力上界与逐工具配置', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-configuration-yolo-inherit-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const provider = {
      ...createDefaultLlmProviderConfig({ name: 'YOLO Provider' }),
      id: 'provider:yolo',
      model: 'model:yolo',
      models: [{ id: 'model:yolo', name: 'YOLO 模型' }],
      modelConfigs: []
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: provider.id });
    await authority.mutations.setToolPolicy({
      scopeKind: 'global',
      name: '全局 YOLO',
      preset: 'yolo',
      allowedTools: ['read', 'write', 'edit', 'delete', 'bash', 'skills'],
      toolConfigs: {
        write: { config: {}, autoApproveExecution: true, autoApplyChange: true },
        edit: { config: {}, autoApproveExecution: true, autoApplyChange: true },
        delete: { config: {}, autoApproveExecution: true, autoApplyChange: true },
        bash: {
          config: { limits: { lines: 40, chars: 2000 }, cwd: 'global' },
          display: { autoExpand: false }
        }
      },
      sourceConfigs: { exa: { enabled: true, disabledTools: ['exa_global_denied'] } }
    });
    await authority.mutations.setToolPolicy({
      scopeKind: 'agent',
      scopeId: 'main',
      name: 'Main 上界',
      allowedTools: ['read', 'write', 'edit', 'delete', 'bash'],
      toolConfigs: {
        bash: {
          config: { limits: { chars: 500 }, cwd: 'agent' },
          display: { autoExpand: true }
        }
      },
      sourceConfigs: { exa: { enabled: true, disabledTools: ['exa_agent_denied'] } }
    });

    const frozen = JSON.parse((await authority.compile({
      conversationId: 'conversation:yolo',
      turnId: 'turn:yolo',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.equal(frozen.toolPolicy.preset, 'yolo');
    assert.deepEqual(frozen.toolPolicy.allowedTools, ['bash', 'delete', 'edit', 'read', 'write']);
    assert.equal(frozen.toolPolicy.toolConfigs.write.autoApproveExecution, true);
    assert.equal(frozen.toolPolicy.toolConfigs.edit.autoApplyChange, true);
    assert.equal(frozen.toolPolicy.toolConfigs.delete.autoApplyChange, true);
    assert.deepEqual(frozen.toolPolicy.toolConfigs.bash, {
      config: { limits: { lines: 40, chars: 500 }, cwd: 'agent' },
      display: { autoExpand: true }
    });
    assert.deepEqual(frozen.toolPolicy.sourceConfigs.exa, {
      enabled: true,
      disabledTools: ['exa_agent_denied', 'exa_global_denied']
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('未写允许列表的工具策略层不收窄上层，内置 Agent 与工作流仍用自己的工具列表', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-configuration-listless-tool-policy-'));
  try {
    const { createDefaultAgentBlueprints } = require('../../dist/extension/backend/world/modules/agent/blueprints.js');
    const blueprints = createDefaultAgentBlueprints();
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const provider = {
      ...createDefaultLlmProviderConfig({ name: 'Listless Provider' }),
      id: 'provider:listless',
      model: 'model:listless',
      models: [{ id: 'model:listless', name: '模型' }],
      modelConfigs: []
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: provider.id });
    const switchOn = { run_agent: { config: { crossConversationCollaboration: true } } };
    const compile = async (executorAgentId, conversationId) => JSON.parse((await authority.compile({
      conversationId, turnId: `turn:${conversationId}`, executorAgentId, intentKind: 'input'
    })).authoritySnapshot.content).toolPolicy;

    // Global switch only: no global ceiling, so the main Agent keeps its whole default list
    // (including tools the settings page lists as off by default).
    await authority.mutations.setToolPolicy({ scopeKind: 'global', toolConfigs: switchOn });
    const main = await compile('main', 'conversation:main');
    assert.deepEqual(main.allowedTools, [...blueprints.agents.main.toolPolicy.allowedTools].sort());
    assert.ok(main.allowedTools.includes('transfer'));
    assert.equal(main.toolConfigs.run_agent.config.crossConversationCollaboration, true);

    // A switch-only Agent record keeps the built-in read-only list instead of replacing it.
    await authority.mutations.setToolPolicy({ scopeKind: 'agent', scopeId: 'explore', toolConfigs: switchOn });
    const explore = await compile('explore', 'conversation:explore');
    assert.deepEqual(explore.allowedTools, [...blueprints.agents.explore.toolPolicy.allowedTools].sort());
    for (const name of ['write', 'edit', 'delete', 'run_agent', 'send_conversation_message']) {
      assert.equal(explore.allowedTools.includes(name), false, `${name} must stay out of the read-only Agent`);
    }

    await authority.mutations.setToolPolicy({ scopeKind: 'workflow', scopeId: 'builtin:readonly', toolConfigs: switchOn });
    await authority.mutations.selectConversationWorkflow({ conversationId: 'conversation:readonly', scopeKind: 'workflow', workflowId: 'builtin:readonly' });
    const readonly = await compile('main', 'conversation:readonly');
    assert.deepEqual(readonly.allowedTools, [...blueprints.workflows.readonly.toolPolicy.allowedTools].sort());

    // A saved list still narrows as before.
    await authority.mutations.setToolPolicy({ scopeKind: 'conversation', scopeId: 'conversation:main', allowedTools: ['read', 'list_conversations'] });
    assert.deepEqual((await compile('main', 'conversation:main')).allowedTools, ['list_conversations', 'read']);

    const client = await authority.configurationClientState();
    const builtin = (scopeKind, scopeId) => client.builtinToolPolicies.find((record) => record.scopeKind === scopeKind && record.scopeId === scopeId);
    assert.deepEqual(builtin('agent', 'explore').allowedTools, blueprints.agents.explore.toolPolicy.allowedTools);
    assert.deepEqual(builtin('agent', 'main').allowedTools, blueprints.agents.main.toolPolicy.allowedTools);
    assert.deepEqual(builtin('workflow', 'builtin:review').allowedTools, blueprints.workflows.review.toolPolicy.allowedTools);
    assert.equal(builtin('workflow', 'builtin:plan'), undefined, 'a workflow without its own list narrows nothing');
    assert.equal(client.toolPolicies.find((record) => record.id === client.toolPolicyScopeLinks.find((link) => link.scopeKind === 'global').toolPolicyId).allowedTools, undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Ask/Plan 自动审批通过原有工具策略落盘、继承并允许局部关闭', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-auto-approval-settings-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const provider = {
      ...createDefaultLlmProviderConfig({ name: 'Auto approval provider' }),
      id: 'provider:auto-approval', model: 'model:auto-approval',
      models: [{ id: 'model:auto-approval', name: 'Test model' }], modelConfigs: []
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: provider.id });
    const compileRequest = {
      conversationId: 'conversation:auto-approval', turnId: 'turn:auto-approval',
      executorAgentId: 'main', intentKind: 'input'
    };
    const initial = JSON.parse((await authority.compile(compileRequest)).authoritySnapshot.content);
    assert.equal(frozenInteractionAutoApproval(initial, 'ask_user'), false);
    assert.equal(frozenInteractionAutoApproval(initial, 'submit_plan'), false);
    await authority.mutations.setToolPolicy({
      scopeKind: 'global', preset: 'custom', allowedTools: ['ask_user', 'submit_plan', 'write'],
      toolConfigs: {
        ask_user: { config: { autoApprove: true } },
        submit_plan: { config: { autoApprove: true } },
        write: { config: { allowOutsideProjectPaths: false }, autoApplyChange: false }
      }
    });
    const reopened = new VscodeConfigurationAuthority(() => paths);
    const inherited = JSON.parse((await reopened.compile(compileRequest)).authoritySnapshot.content);
    assert.equal(frozenInteractionAutoApproval(inherited, 'ask_user'), true);
    assert.equal(frozenInteractionAutoApproval(inherited, 'submit_plan'), true);
    assert.equal(inherited.toolPolicy.toolConfigs.write.autoApplyChange, false);
    await reopened.mutations.setToolPolicy({
      scopeKind: 'conversation', scopeId: compileRequest.conversationId,
      allowedTools: ['ask_user', 'submit_plan', 'write'],
      toolConfigs: { ask_user: { config: {} }, submit_plan: { config: { autoApprove: false } } }
    });
    const overridden = JSON.parse((await reopened.compile(compileRequest)).authoritySnapshot.content);
    assert.equal(frozenInteractionAutoApproval(overridden, 'ask_user'), true);
    assert.equal(frozenInteractionAutoApproval(overridden, 'submit_plan'), false);
    assert.equal(frozenInteractionAutoApproval(inherited, 'submit_plan'), true);
    assert.deepEqual(overridden.toolPolicy.toolConfigs.write, inherited.toolPolicy.toolConfigs.write);
  } finally {
    const resolvedRoot = await fs.realpath(root);
    assert.equal(path.dirname(resolvedRoot), await fs.realpath(os.tmpdir()));
    await fs.rm(resolvedRoot, { recursive: true, force: true });
  }
});

test('多个Host共享WorkEnvironment存储时只在本地投影当前Workspace可用性与有效策略', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-work-environment-rebind-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const firstAuthority = new VscodeConfigurationAuthority(() => paths);
    const secondAuthority = new VscodeConfigurationAuthority(() => paths);
    const firstPath = path.join(root, 'workspace-first');
    const secondPath = path.join(root, 'workspace-second');
    await fs.mkdir(firstPath, { recursive: true });
    await fs.mkdir(secondPath, { recursive: true });
    const firstUri = vscode.Uri.file(firstPath).toString();
    const secondUri = vscode.Uri.file(secondPath).toString();
    const firstId = workEnvironmentIdFromUri(firstUri);
    const secondId = workEnvironmentIdFromUri(secondUri);

    const provider = {
      ...createDefaultLlmProviderConfig({ name: 'Workspace Provider' }),
      id: 'provider:workspace-isolation',
      model: 'model:workspace-isolation',
      models: [{ id: 'model:workspace-isolation', name: 'Workspace Model' }],
      modelConfigs: []
    };
    await saveLatestGlobalSettings(firstAuthority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(firstAuthority, 'llm', { activeProviderConfigId: provider.id });

    const eagerFirstAuthority = new VscodeConfigurationAuthority(() => paths, undefined, [{
      uri: firstUri,
      name: 'First',
      rootPath: firstPath,
      index: 0
    }]);
    const eagerFirstSnapshot = await eagerFirstAuthority.configurationClientState();
    assert.equal(eagerFirstSnapshot.workEnvironments.find((record) => record.id === firstId)?.available, true);
    assert.equal(eagerFirstSnapshot.workEnvironments.find((record) => record.id === secondId), undefined);

    await firstAuthority.synchronizeWorkspaceFolders([{ uri: firstUri, name: 'First', rootPath: firstPath, index: 0 }]);
    await firstAuthority.mutations.setWorkEnvironmentPolicy({
      scopeKind: 'global',
      enabled: false,
      allowedWorkEnvironmentIds: [firstId],
      defaultWorkEnvironmentId: firstId
    });
    await secondAuthority.synchronizeWorkspaceFolders([{ uri: secondUri, name: 'Second', rootPath: secondPath, index: 0 }]);

    const storedEnvironments = await loadRecordStore(
      paths.workEnvironmentsRootUri,
      paths.workEnvironmentsIndexUri,
      'workEnvironment'
    );
    assert.equal(storedEnvironments.find((record) => record.id === firstId)?.available, true);
    assert.equal(storedEnvironments.find((record) => record.id === secondId)?.available, true);
    const storedPolicies = await loadRecordStore(
      paths.workEnvironmentPoliciesRootUri,
      paths.workEnvironmentPoliciesIndexUri,
      'policy'
    );
    const storedPolicy = storedPolicies.find((record) => record.id === 'work-environment-policy:global:global');
    assert.deepEqual(storedPolicy?.allowedWorkEnvironmentIds, [firstId]);
    assert.equal(storedPolicy?.defaultWorkEnvironmentId, firstId);

    const firstSnapshot = await firstAuthority.configurationClientState();
    const firstPolicy = firstSnapshot.workEnvironmentPolicies.find((record) => record.id === 'work-environment-policy:global:global');
    assert.deepEqual(firstPolicy?.allowedWorkEnvironmentIds, [firstId]);
    assert.equal(firstPolicy?.defaultWorkEnvironmentId, firstId);
    assert.equal(firstSnapshot.workEnvironments.find((record) => record.id === firstId)?.available, true);
    assert.equal(firstSnapshot.workEnvironments.find((record) => record.id === secondId)?.available, false);

    const secondSnapshot = await secondAuthority.configurationClientState();
    const secondPolicy = secondSnapshot.workEnvironmentPolicies.find((record) => record.id === 'work-environment-policy:global:global');
    assert.equal(secondPolicy?.enabled, false);
    assert.deepEqual(secondPolicy?.allowedWorkEnvironmentIds, [firstId]);
    assert.equal(secondPolicy?.defaultWorkEnvironmentId, firstId);
    assert.equal(secondSnapshot.workEnvironments.find((record) => record.id === firstId)?.available, false);
    assert.equal(secondSnapshot.workEnvironments.find((record) => record.id === secondId)?.available, true);

    await assert.rejects(secondAuthority.compile({
      conversationId: 'conversation:second-workspace',
      turnId: 'turn:second-workspace',
      executorAgentId: 'main',
      intentKind: 'input'
    }), /当前窗口的工作环境不可用/);

    const manualId = 'work-environment:shared-remote';
    await firstAuthority.mutations.upsertWorkEnvironment({
      id: manualId,
      kind: 'remoteServer',
      source: 'manual',
      name: 'Shared Remote',
      host: 'example.test',
      available: true,
      createdAt: 1,
      updatedAt: 1
    });
    await firstAuthority.mutations.setWorkEnvironmentPolicy({
      scopeKind: 'global',
      enabled: true,
      allowedWorkEnvironmentIds: [manualId],
      defaultWorkEnvironmentId: manualId
    });
    const manualSnapshot = await secondAuthority.configurationClientState();
    const manualPolicy = manualSnapshot.workEnvironmentPolicies.find((record) => record.id === 'work-environment-policy:global:global');
    assert.deepEqual(manualPolicy?.allowedWorkEnvironmentIds, [manualId]);
    assert.equal(manualPolicy?.defaultWorkEnvironmentId, manualId);
    assert.equal(manualSnapshot.workEnvironments.find((record) => record.id === manualId)?.available, true);

    const manualFrozen = JSON.parse((await secondAuthority.compile({
      conversationId: 'conversation:shared-remote',
      turnId: 'turn:shared-remote',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.deepEqual(manualFrozen.workEnvironmentPolicy.allowedWorkEnvironmentIds, [manualId]);
    assert.equal(manualFrozen.workEnvironmentPolicy.defaultWorkEnvironmentId, manualId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('不相关的旧压缩配置不会阻塞 Agent、Workflow 与 ConfigurationSnapshot 投影', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-agent-projection-isolation-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const compressionRoot = path.join(paths.settingsRootUri.fsPath, 'llm-compression-configs');
    const recordsRoot = path.join(compressionRoot, 'records');
    const recordFile = 'records/legacy-compression.json';
    const savedAt = new Date().toISOString();
    await fs.mkdir(recordsRoot, { recursive: true });
    await fs.writeFile(path.join(compressionRoot, 'index.json'), `${JSON.stringify({
      schemaVersion: 1,
      savedAt,
      records: [{ id: 'legacy-compression', file: recordFile, updatedAt: savedAt }]
    }, null, 2)}\n`);
    await fs.writeFile(path.join(compressionRoot, ...recordFile.split('/')), `${JSON.stringify({
      schemaVersion: 1,
      savedAt,
      config: {
        id: 'legacy-compression',
        name: 'Legacy compression',
        kind: 'segmented_summary',
        trigger: {
          mode: 'token_threshold',
          thresholdUnit: 'percent',
          thresholdPercent: 90,
          preserveLatestMessages: 8,
          reserveLatestUserMessageTokens: 20_000
        },
        llmSummary: { targetTokens: 2_000 },
        createdAt: 1,
        updatedAt: 1
      }
    }, null, 2)}\n`);

    const agents = await authority.agents();
    assert.ok(agents.some((agent) => agent.id === 'main'));
    const resolvedAgent = await authority.resolveAgent({ agentType: 'main' });
    assert.equal(resolvedAgent.agentId, 'main');
    const workflow = await authority.workflow('builtin:plan');
    assert.equal(workflow.id, 'builtin:plan');
    const snapshot = await authority.configurationClientState();
    assert.ok(snapshot.agents.some((agent) => agent.id === 'main'));
    assert.ok(snapshot.workflows.some((candidate) => candidate.id === 'builtin:plan'));
    await assert.rejects(
      authority.loadGlobalSettings('llmCompressionConfigs'),
      /removed message-count\/user-reserve fields/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('重试间隔按模型覆盖渠道冻结成 retryDelayMs，并夹到 0..600 秒', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-retry-delay-authority-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const provider = {
      ...createDefaultLlmProviderConfig({ name: '重试间隔 Provider' }),
      id: 'provider:retry-delay',
      model: 'model:channel',
      models: [{ id: 'model:channel', name: '渠道默认模型' }, { id: 'model:override', name: '模型覆盖' }],
      retryOnError: true,
      retryMaxAttempts: 4,
      retryDelaySeconds: 30,
      modelConfigs: [{
        id: 'model-config:override',
        modelId: 'model:override',
        toolCallFormat: 'function-call',
        openaiResponsesTransport: 'http',
        stream: true,
        retryOnError: true,
        retryMaxAttempts: 2,
        retryDelaySeconds: 60,
        enableMultimodalTools: true,
        systemPromptPrefix: '',
        createdAt: 1,
        updatedAt: 1
      }]
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: provider.id });

    const channelFrozen = JSON.parse((await authority.compile({
      conversationId: 'conversation:retry-channel',
      turnId: 'turn:retry-channel',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.deepEqual(channelFrozen.model.retryPolicy, {
      enabled: true,
      maxRetries: 4,
      retryDelayMs: 30_000
    });

    await authority.mutations.setModelProfile({
      scopeKind: 'conversation',
      scopeId: 'conversation:retry-model',
      name: '模型覆盖',
      providerConfigId: provider.id,
      provider: provider.provider,
      model: 'model:override'
    });
    const modelFrozen = JSON.parse((await authority.compile({
      conversationId: 'conversation:retry-model',
      turnId: 'turn:retry-model',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.deepEqual(modelFrozen.model.retryPolicy, {
      enabled: true,
      maxRetries: 2,
      retryDelayMs: 60_000
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('重试间隔归一化：非法值与负数落回 0，超过上限夹到 600 秒', () => {
  const config = normalizeLlmProviderConfig({ retryDelaySeconds: 999_999 });
  assert.equal(config.retryDelaySeconds, MAX_LLM_RETRY_DELAY_SECONDS);
  assert.equal(normalizeLlmProviderConfig({}).retryDelaySeconds, DEFAULT_LLM_RETRY_DELAY_SECONDS);
  assert.equal(normalizeLlmProviderConfig({ retryDelaySeconds: -30 }).retryDelaySeconds, 0);
  assert.equal(normalizeLlmProviderConfig({ retryDelaySeconds: Number.NaN }).retryDelaySeconds, 0);
  assert.equal(normalizeLlmProviderConfig({ retryDelaySeconds: 30.9 }).retryDelaySeconds, 30);
});

test('压缩最长时间默认20分钟并限制为1到1440分钟的整数', () => {
  assert.equal(createDefaultLlmCompressionConfig().maxDurationMinutes, 20);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes(undefined), 20);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes(NaN), 20);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes(Infinity), 20);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes('37'), 20);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes(37), 37);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes(2.6), 3);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes(0), 1);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes(-5), 1);
  assert.equal(normalizeLlmCompressionMaxDurationMinutes(999999999), 1440);
});

test('压缩配置 hard-cut 旧保留字段并冻结压缩 Provider 自己的窗口、输出上限和最长时间', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-compression-config-cutover-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const primary = {
      ...createDefaultLlmProviderConfig({ name: '主模型渠道' }),
      id: 'provider:primary-compression-cutover',
      model: 'model:primary-372k',
      models: [{ id: 'model:primary-372k', name: 'Primary 372K' }],
      contextWindowTokens: 372_000,
      generationConfig: { maxOutputTokens: 20_000 },
      modelConfigs: []
    };
    const summary = {
      ...createDefaultLlmProviderConfig({ name: '摘要渠道' }),
      id: 'provider:summary-compression-cutover',
      model: 'model:summary-64k',
      models: [{ id: 'model:summary-64k', name: 'Summary 64K' }],
      contextWindowTokens: 64_000,
      generationConfig: { maxOutputTokens: 6_000 },
      modelConfigs: []
    };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [primary, summary] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: primary.id });

    const legacyCompressionConfig = {
      id: 'compression-config:cutover',
      name: 'Hard cut compression',
      kind: 'llm_summary',
      trigger: {
        mode: 'token_threshold',
        thresholdUnit: 'tokens',
        thresholdTokens: 300_000,
        thresholdPercent: 80,
        preserveLatestMessages: 99,
        reserveLatestUserMessageTokens: 123_000
      },
      llmSummary: {
        providerConfigId: summary.id,
        model: summary.model,
        generationConfig: { maxOutputTokens: 12_000 }
      },
      createdAt: 1,
      updatedAt: 1
    };
    await assert.rejects(
      saveLatestGlobalSettings(authority, 'llmCompressionConfigs', {
        configs: [legacyCompressionConfig]
      }),
      /removed message-count\/user-reserve fields/
    );
    const compressionConfig = {
      ...legacyCompressionConfig,
      maxDurationMinutes: 37,
      trigger: {
        mode: 'token_threshold',
        thresholdUnit: 'tokens',
        thresholdTokens: 300_000,
        thresholdPercent: 80
      }
    };
    const saved = await saveLatestGlobalSettings(authority, 'llmCompressionConfigs', {
      configs: [compressionConfig]
    });
    const normalizedConfig = saved.settings.configs[0];
    assert.equal(normalizedConfig.maxDurationMinutes, 37);
    assert.equal((await authority.loadGlobalSettings('llmCompressionConfigs')).settings.configs[0].maxDurationMinutes, 37);
    assert.equal(normalizedConfig.llmSummary.targetTokens, 8_000);
    assert.deepEqual(Object.keys(normalizedConfig.trigger).sort(), [
      'mode', 'thresholdPercent', 'thresholdTokens', 'thresholdUnit'
    ]);
    await saveLatestGlobalSettings(authority, 'llmCompression', {
      defaultConfigId: normalizedConfig.id,
      providerBindings: [],
      modelBindings: []
    });

    const frozen = JSON.parse((await authority.compile({
      conversationId: 'conversation:compression-cutover',
      turnId: 'turn:compression-cutover',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.equal(frozen.modelProfile.contextWindowTokens, 372_000);
    assert.equal(frozen.model.maxOutputTokens, 20_000);
    assert.equal(frozen.compression.config.llmSummary.targetTokens, 8_000);
    assert.equal(frozen.compression.provider.providerConfigId, summary.id);
    assert.equal(frozen.compression.provider.modelId, summary.model);
    assert.equal(frozen.compression.provider.contextWindowTokens, 64_000);
    assert.equal(frozen.compression.provider.maxOutputTokens, 12_000);
    assert.equal(frozen.compression.config.maxDurationMinutes, 37);
    assert.equal(Object.hasOwn(frozen.compression, 'preserveLatestMessages'), false);
    assert.equal(Object.hasOwn(frozen.compression.config.trigger, 'preserveLatestMessages'), false);
    assert.equal(Object.hasOwn(frozen.compression.config.trigger, 'reserveLatestUserMessageTokens'), false);
    assert.equal(frozenCompressionPolicy(frozen).provider.contextWindowTokens, 64_000);
    await saveLatestGlobalSettings(authority, 'llmCompressionConfigs', {
      configs: [{ ...normalizedConfig, maxDurationMinutes: 45 }]
    });
    const nextFrozen = JSON.parse((await authority.compile({
      conversationId: 'conversation:compression-cutover',
      turnId: 'turn:compression-cutover-next',
      executorAgentId: 'main',
      intentKind: 'input'
    })).authoritySnapshot.content);
    assert.equal(nextFrozen.compression.config.maxDurationMinutes, 45);
    assert.equal(frozen.compression.config.maxDurationMinutes, 37);

    const incomplete = structuredClone(frozen);
    delete incomplete.compression.provider.contextWindowTokens;
    assert.throws(
      () => frozenCompressionPolicy(incomplete),
      /compression\.provider\.contextWindowTokens/
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function createVscodeStub() {
  const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };
  class Uri {
    constructor(fsPath) {
      this.scheme = 'file';
      this.fsPath = path.resolve(fsPath);
      this.path = this.fsPath.split(path.sep).join('/');
    }
    static file(filePath) { return new Uri(filePath); }
    static joinPath(base, ...segments) { return new Uri(path.join(base.fsPath, ...segments)); }
    toString() { return `file://${this.path}`; }
  }
  return {
    Uri,
    FileType,
    workspace: {
      fs: {
        async createDirectory(uri) { await fs.mkdir(uri.fsPath, { recursive: true }); },
        async readFile(uri) { return fs.readFile(uri.fsPath); },
        async writeFile(uri, bytes) {
          await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
          await fs.writeFile(uri.fsPath, bytes);
        },
        async readDirectory(uri) {
          const entries = await fs.readdir(uri.fsPath, { withFileTypes: true });
          return entries.map((entry) => [
            entry.name,
            entry.isDirectory() ? FileType.Directory : entry.isFile() ? FileType.File : FileType.Unknown
          ]);
        },
        async delete(uri) { await fs.rm(uri.fsPath, { recursive: true, force: true }); },
        async stat(uri) {
          const stat = await fs.stat(uri.fsPath);
          return {
            type: stat.isDirectory() ? FileType.Directory : FileType.File,
            ctime: stat.ctimeMs,
            mtime: stat.mtimeMs,
            size: stat.size
          };
        }
      }
    }
  };
}

test('Host 投影保留用户 allow-list 与 remote default，不自动授权本地目录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-projection-default-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const localUri = vscode.Uri.file(path.join(root, 'my-folder')).toString();
    const localId = workEnvironmentIdFromUri(localUri);
    const remoteId = 'work-env-remote:my-server';

    const authority = new VscodeConfigurationAuthority(() => paths, undefined, [{
      uri: localUri, name: 'My Folder', rootPath: path.join(root, 'my-folder'), index: 0
    }]);
    await authority.mutations.upsertWorkEnvironment({
      id: remoteId, kind: 'remoteServer', source: 'manual', name: 'Server',
      host: 'server.test', available: true, createdAt: 1, updatedAt: 1
    });
    await authority.mutations.setWorkEnvironmentPolicy({
      scopeKind: 'global', enabled: true,
      allowedWorkEnvironmentIds: [remoteId],
      defaultWorkEnvironmentId: remoteId
    });

    const snapshot = await authority.configurationClientState();
    const policy = snapshot.workEnvironmentPolicies.find(
      (record) => record.id === 'work-environment-policy:global:global'
    );
    assert.ok(policy, 'global policy should exist');
    assert.deepEqual(policy.allowedWorkEnvironmentIds, [remoteId]);
    assert.equal(policy.defaultWorkEnvironmentId, remoteId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('多 Host 投影仅改变目录可用性，不改变共享策略默认与授权', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-multi-host-default-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const uriA = vscode.Uri.file(path.join(root, 'folder-a')).toString();
    const uriB = vscode.Uri.file(path.join(root, 'folder-b')).toString();
    const idA = workEnvironmentIdFromUri(uriA);
    const idB = workEnvironmentIdFromUri(uriB);
    const remoteId = 'work-env-remote:shared-server';

    const authA = new VscodeConfigurationAuthority(() => paths, undefined, [
      { uri: uriA, name: 'A', rootPath: path.join(root, 'folder-a'), index: 0 }
    ]);
    const authB = new VscodeConfigurationAuthority(() => paths, undefined, [
      { uri: uriB, name: 'B', rootPath: path.join(root, 'folder-b'), index: 0 }
    ]);

    await authA.mutations.upsertWorkEnvironment({
      id: remoteId, kind: 'remoteServer', source: 'manual', name: 'Server',
      host: 'srv.test', available: true, createdAt: 1, updatedAt: 1
    });
    await authA.mutations.setWorkEnvironmentPolicy({
      scopeKind: 'global', enabled: true,
      allowedWorkEnvironmentIds: [remoteId],
      defaultWorkEnvironmentId: remoteId
    });

    const snapA = await authA.configurationClientState();
    const policyA = snapA.workEnvironmentPolicies.find(
      (record) => record.id === 'work-environment-policy:global:global'
    );
    assert.deepEqual(policyA.allowedWorkEnvironmentIds, [remoteId]);
    assert.equal(policyA.defaultWorkEnvironmentId, remoteId);

    const snapB = await authB.configurationClientState();
    const policyB = snapB.workEnvironmentPolicies.find(
      (record) => record.id === 'work-environment-policy:global:global'
    );
    assert.deepEqual(policyB.allowedWorkEnvironmentIds, [remoteId]);
    assert.equal(policyB.defaultWorkEnvironmentId, remoteId);

    const storedPolicies = await loadRecordStore(
      paths.workEnvironmentPoliciesRootUri,
      paths.workEnvironmentPoliciesIndexUri,
      'policy'
    );
    const storedPolicy = storedPolicies.find(
      (record) => record.id === 'work-environment-policy:global:global'
    );
    assert.deepEqual(storedPolicy.allowedWorkEnvironmentIds, [remoteId]);
    assert.equal(storedPolicy.defaultWorkEnvironmentId, remoteId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('A+B 会话绑定 B 冻结首个相对工具根；显式 remote 和子继承优先，失效不落 A', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-workspace-selection-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const authority = new VscodeConfigurationAuthority(() => paths);
    const folders = ['A', 'B'].map((name, index) => {
      const rootPath = path.join(root, name);
      return { uri: vscode.Uri.file(rootPath).toString(), rootPath, name, index };
    });
    const [a, b] = folders.map(folder => workEnvironmentIdFromUri(folder.uri));
    const provider = { ...createDefaultLlmProviderConfig(), id: 'provider:workspace-choice', model: 'fixture', models: [{ id: 'fixture', name: 'fixture' }], modelConfigs: [] };
    await saveLatestGlobalSettings(authority, 'llmProviderConfigs', { configs: [provider] });
    await saveLatestGlobalSettings(authority, 'llm', { activeProviderConfigId: provider.id });
    await authority.synchronizeWorkspaceFolders(folders);
    const compile = (conversationId, extra = {}) => authority.compile({ conversationId, turnId: `turn:${conversationId}`, executorAgentId: 'main', intentKind: 'input', ...extra });
    const policyOf = result => JSON.parse(result.authoritySnapshot.content).workEnvironmentPolicy;
    await authority.mutations.setWorkEnvironmentPolicy({ scopeKind: 'global', enabled: false, allowedWorkEnvironmentIds: [a, b], defaultWorkEnvironmentId: a });
    const boundB = { workspace: { uri: folders[1].uri, name: 'B' } };
    const frozenB = policyOf(await compile('bound-b', boundB));
    assert.equal(frozenB.defaultWorkEnvironmentId, b);
    const { resolveFrozenWorkEnvironmentBoundary } = require('../../dist/extension/backend/reliableKernel/workEnvironmentBoundary.js');
    const { resolvePathInsideBoundary } = require('../../dist/extension/backend/reliableKernel/localFileToolPlanner.js');
    await fs.mkdir(folders[1].rootPath, { recursive: true });
    await fs.writeFile(path.join(folders[1].rootPath, 'first.txt'), 'B');
    const active = resolveFrozenWorkEnvironmentBoundary(frozenB, await authority.workEnvironments()).active;
    assert.equal((await resolvePathInsideBoundary(active.id, active.rootPath, 'first.txt')).absolutePath, path.join(folders[1].rootPath, 'first.txt'));

    const remote = await authority.mutations.upsertWorkEnvironment(createRemoteServerWorkEnvironmentRecord({ id: 'remote:explicit', name: 'Remote', host: 'example.invalid' }));
    await authority.mutations.setWorkEnvironmentPolicy({ scopeKind: 'global', enabled: true, allowedWorkEnvironmentIds: [a, b, remote.id], defaultWorkEnvironmentId: a });
    await authority.mutations.selectConversationWorkEnvironment('explicit', remote.id);
    assert.equal(policyOf(await compile('explicit', boundB)).defaultWorkEnvironmentId, remote.id);
    assert.equal(policyOf(await compile('child', { ...boundB, inheritedWorkEnvironmentPolicy: { enabled: true, allowedWorkEnvironmentIds: [a, b, remote.id], defaultWorkEnvironmentId: remote.id } })).defaultWorkEnvironmentId, remote.id);

    // A folder event and a newly admitted Turn share one queue, including reordering and removal.
    const reordered = authority.synchronizeWorkspaceFolders([{ ...folders[1], index: 0 }, { ...folders[0], index: 1 }]);
    const pendingTurn = compile('after-reorder', boundB);
    await reordered;
    assert.equal(policyOf(await pendingTurn).defaultWorkEnvironmentId, b);
    await authority.synchronizeWorkspaceFolders([folders[0]]);
    await assert.rejects(compile('removed-b', boundB), /不可用/);
    assert.throws(() => resolveFrozenWorkEnvironmentBoundary(frozenB, [
      { ...(active), available: false }, { ...(active), id: a, rootPath: folders[0].rootPath, available: true }
    ]), /冻结的工作环境已不可用/);

    await authority.synchronizeWorkspaceFolders(folders);
    await authority.mutations.setWorkEnvironmentPolicy({ scopeKind: 'global', enabled: false, allowedWorkEnvironmentIds: [a], defaultWorkEnvironmentId: a });
    await assert.rejects(compile('denied-b', boundB), /未获当前策略允许/);
    await authority.mutations.setWorkEnvironmentPolicy({ scopeKind: 'global', enabled: true, allowedWorkEnvironmentIds: [a, b] });
    const saved = (await authority.configurationClientState()).workEnvironmentPolicies[0];
    assert.equal(saved.defaultWorkEnvironmentId, undefined);
    await assert.rejects(compile('needs-choice'), /多个工作环境/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Host 本地移除与同步失败隔离：其他 Host 不被禁用，后续同步恢复且失败不猜根', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-folder-sync-fence-'));
  try {
    const paths = createVscodeStoragePaths(vscode.Uri.file(root));
    const one = new VscodeConfigurationAuthority(() => paths);
    const two = new VscodeConfigurationAuthority(() => paths);
    const folder = { uri: vscode.Uri.file(path.join(root, 'B')).toString(), name: 'B', rootPath: path.join(root, 'B'), index: 0 };
    const id = workEnvironmentIdFromUri(folder.uri);
    await one.synchronizeWorkspaceFolders([folder]);
    await two.synchronizeWorkspaceFolders([folder]);
    await one.synchronizeWorkspaceFolders([]);
    assert.equal((await one.workEnvironments()).find(record => record.id === id).available, false);
    assert.equal((await two.workEnvironments()).find(record => record.id === id).available, true);
    assert.equal((await loadRecordStore(paths.workEnvironmentsRootUri, paths.workEnvironmentsIndexUri, 'workEnvironment')).find(record => record.id === id).available, true);

    const synchronize = one.mutations.synchronizeWorkspaceFolders.bind(one.mutations);
    one.mutations.synchronizeWorkspaceFolders = async () => { throw new Error('injected synchronization failure'); };
    await assert.rejects(one.synchronizeWorkspaceFolders([folder]), /injected synchronization failure/);
    await assert.rejects(one.compile({ conversationId: 'blocked', turnId: 'turn:blocked', executorAgentId: 'main', intentKind: 'input' }), /injected synchronization failure/);
    await assert.rejects(one.configurationClientState(), /injected synchronization failure/);
    one.mutations.synchronizeWorkspaceFolders = synchronize;
    await one.synchronizeWorkspaceFolders([folder]);
    assert.equal((await one.workEnvironments()).find(record => record.id === id).available, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
