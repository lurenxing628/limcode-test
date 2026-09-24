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
const vscode = {
  Uri, FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  workspace: { fs: {
    createDirectory: (uri) => fs.mkdir(uri.fsPath, { recursive: true }),
    readFile: (uri) => fs.readFile(uri.fsPath),
    async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
    async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map((item) => [item.name, item.isDirectory() ? 2 : 1]); },
    delete: (uri) => fs.rm(uri.fsPath, { recursive: true, force: true }),
    async stat(uri) { const s = await fs.stat(uri.fsPath); return { type: s.isDirectory() ? 2 : 1, size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs }; }
  } }
};
Module._load = function(request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });
const kernel = require('../../dist/extension/backend/reliableKernel/index.js');
const { VscodeConfigurationAuthority } = require('../../dist/extension/backend/reliableKernel/vscodeConfigurationAuthority.js');
const { createVscodeStoragePaths } = require('../../dist/extension/backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = require('../../dist/extension/backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { ReliableConversationRunner } = require('../../dist/extension/backend/application/reliableKernel/ReliableConversationRunner.js');
const protocol = require('../../dist/extension/shared/protocol.js');
const { readFrozenTurnAuthority } = require('../../dist/extension/backend/reliableKernel/frozenAuthority.js');
const { applyRequestCompressionSettings, readRequestSettings } = require('../../dist/extension/backend/reliableKernel/requestCompressionSettings.js');

async function fixture(run, hooks = {}) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-live-compression-'));
  let app;
  try {
    const configuration = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(path.join(parent, 'settings'))));
    const save = async (section, settings) => configuration.saveGlobalSettings(section, settings, (await configuration.loadGlobalSettings(section)).revision);
    const provider = { ...createDefaultLlmProviderConfig({ name: '测试渠道' }), id: 'live-provider', model: 'live-model', models: [{ id: 'live-model', name: '测试模型' }], contextWindowTokens: 200000 };
    const oldConfig = { ...protocol.createDefaultLlmCompressionConfig('测试压缩'), kind: 'deterministic_summary', trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: 120000 } };
    await save('llmProviderConfigs', { configs: [provider] });
    await save('llm', { activeProviderConfigId: provider.id });
    await save('llmCompressionConfigs', { configs: [oldConfig] });
    await save('llmCompression', { defaultConfigId: oldConfig.id, providerBindings: [], modelBindings: [] });
    const agent = await configuration.mutations.createAgent({ name: '测试助手', kind: 'custom' });
    await configuration.mutations.setToolPolicy({ scopeKind: 'global', name: '测试工具', allowedTools: ['counter'] });
    const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(authority);
    const requests = [];
    const update = (patch = {}) => save('llmCompressionConfigs', { configs: [{ ...oldConfig, kind: 'llm_summary', trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 40000 }, ...patch }] });
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: configuration,
      compressionSettingsAuthority: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { return null; } },
      mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
      attachmentSettings: configuration,
      providers: { resolve(providerId) { return { providerId, async sendFullRequest(request, controls) {
        requests.push(request);
        if (hooks.send) return hooks.send(request, controls, { app, update, requests });
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content: {
          type: 'compression_result', contents: [{ role: 'user', parts: [{ text: '已总结的历史。' }] }]
        } });
      } }; } },
      toolDispatcher: {
        definitions() { return [{ name: 'counter', description: '测试工具', parameters: { type: 'object', properties: {} }, metadata: { readonly: true } }]; },
        async dispatch(input) {
          await hooks.tool?.({ app, update });
          const settled = await app.runtime.effects.settleWithoutEffect({
            source: { kind: 'internal', key: `counter:${input.toolCallId}` }, toolCallId: input.toolCallId, status: 'succeeded', detail: { count: 1 }
          });
          return settled.terminal ?? app.runtime.effects.readTerminalResult(input.toolCallId, true);
        }
      }
    });
    const list = async (domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))).snapshot;
    const frozen = async (turnId) => {
      const [row] = await list('AuthoritySnapshot', { turn_id: turnId });
      return readFrozenTurnAuthority(app.database, app.contentStore, row.id, turnId);
    };
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'live-conversation', title: '测试', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'live-link', conversation_id: 'live-conversation', agent_id: agent.id, role: 'default', created_at: now, updated_at: now })
    ]);
    const input = (key, content = '测试输入') => ({ source: { kind: 'command', key }, conversationId: 'live-conversation', leaseOwnerId: 'live-owner', hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), content });
    const terminal = (turnId) => app.turns.terminal({ source: { kind: 'internal', key: `terminal:${turnId}` }, turnId, terminalStatus: 'completed', reason: 'test' });
    await run({ app, configuration, save, update, oldConfig, provider, list, frozen, input, terminal, requests });
  } finally {
    if (app) await app.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
}

test('保存压缩设置后同一任务的下一次模型请求采用新值，旧请求及整轮配置保持不变', async () => {
  await fixture(async ({ app, frozen, input, requests, list, oldConfig }) => {
    const result = await app.agentLoop.runInput(input('live-tool-round'));
    assert.equal(result.terminalStatus, 'completed');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].authoritySnapshot.compression.thresholdTokens, 120000);
    assert.equal(requests[1].authoritySnapshot.compression.thresholdTokens, 40000);
    assert.equal(requests[1].authoritySnapshot.compression.config.trigger.mode, 'token_threshold');
    assert.equal(requests[0].authoritySnapshot.compression.config.bodyTargetTokens, oldConfig.bodyTargetTokens);
    assert.equal(requests[1].authoritySnapshot.compression.config.bodyTargetTokens, 32000);
    assert.equal((await frozen(result.turnId)).document.compression.thresholdTokens, 120000);
    const firstReplay = await app.modelProvider.replay(requests[0].modelRequestId);
    assert.equal(firstReplay.authoritySnapshot.compression.thresholdTokens, 120000);
    assert.equal(firstReplay.authoritySnapshot.compression.config.bodyTargetTokens, oldConfig.bodyTargetTokens);
    assert.deepEqual(firstReplay.settingsSnapshot, requests[0].settingsSnapshot);
    assert.equal((await list('ToolModelResult')).length, 1);
    const rows = await list('ModelRequest');
    assert.deepEqual(rows.map((row) => Number(row.compression_threshold_tokens)).sort((a, b) => a - b), [40000, 120000]);
  }, {
    async tool({ update }) { await update({ bodyTargetTokens: 32000 }); },
    async send(request, controls) {
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: {
        role: 'model', parts: request.recipe.round === '1'
          ? [{ id: 'counter-1', functionCall: { name: 'counter', args: {} } }]
          : [{ text: '完成。' }]
      } });
    }
  });
});

test('新手动压缩读取已保存方法，执行期间再次修改不会改变原请求或摘要记录', async () => {
  await fixture(async ({ app, update, input, terminal, frozen, requests, list }) => {
    const started = await app.turns.input(input('history', '原始历史内容。'.repeat(600)));
    await terminal(started.turnId);
    const before = await frozen(started.turnId);
    await update();
    const runner = new ReliableConversationRunner(app, 'live-owner');
    try {
      const [head] = await list('ConversationContextHeadLink');
      const result = await runner.manualCompression({ commandId: 'manual-live', conversationId: 'live-conversation', compressSegmentCount: 1, target: { kind: 'current_head', expectedRootId: head.root_id } });
      assert.equal(result.compression.status, 'compressed');
      assert.equal(requests[0].authoritySnapshot.compression.methodKind, 'llm_summary');
      assert.equal(requests[0].authoritySnapshot.compression.thresholdTokens, 40000);
      assert.equal((await frozen(started.turnId)).snapshot.content_object_id, before.snapshot.content_object_id);
      assert.equal((await list('CompressionBlock')).length, 1);
      const replay = await app.modelProvider.replay(requests[0].modelRequestId);
      assert.equal(replay.authoritySnapshot.compression.thresholdTokens, 40000);
      assert.equal(replay.authoritySnapshot.compression.methodKind, 'llm_summary');
    } finally { runner.dispose(); }
  }, {
    async send(_request, controls, { update }) {
      await update({ kind: 'disabled', trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: 80000 } });
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { type: 'compression_result', contents: [{ role: 'user', parts: [{ text: '摘要。' }] }] } });
    }
  });
});

test('同一任务打开自动压缩并降低阈值后，无需新用户消息即可压缩后续请求', async () => {
  await fixture(async ({ app, input, terminal, requests, list }) => {
    const history = await app.turns.input(input('long-history', '以前的重要历史。'.repeat(12000)));
    await terminal(history.turnId);
    const result = await app.agentLoop.runInput(input('enable-during-tools'));
    assert.equal(result.terminalStatus, 'completed');
    assert.equal(requests.length, 3);
    assert.equal(requests[1].recipe.kind, 'reliable-context-compression');
    assert.equal(requests[1].recipe.trigger, 'auto');
    assert.equal(requests[1].authoritySnapshot.compression.thresholdTokens, 10000);
    assert.equal(requests[2].authoritySnapshot.compression.thresholdTokens, 10000);
    assert.equal((await list('CompressionBlock')).length, 1);
    assert.equal((await list('ToolModelResult')).length, 1);
  }, {
    async tool({ update }) { await update({ trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 10000 } }); },
    async send(request, controls, { update }) {
      if (request.recipe.kind === 'reliable-context-compression') {
        await update({ trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: 80000 } });
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { type: 'compression_result', contents: [{ role: 'user', parts: [{ text: '历史摘要。' }] }] } });
      } else {
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content: {
          role: 'model', parts: request.recipe.round === '1'
            ? [{ id: 'auto-counter', functionCall: { name: 'counter', args: {} } }]
            : [{ text: '完成。' }]
        } });
      }
    }
  });
});

test('模型请求恢复只读已保存的压缩设置，不读取后来改变的配置', async () => {
  await fixture(async ({ app, update, input, frozen, list, configuration }) => {
    const started = await app.turns.input(input('recover', '恢复测试。'.repeat(300)));
    const authority = await frozen(started.turnId);
    await update();
    const settingsId = await app.modelProvider.freezeRequestSettings(started.turnId, authority.snapshot.id);
    const [head] = await list('ConversationContextHeadLink');
    const created = await app.modelProvider.createModelRequest({
      turnId: started.turnId, authoritySnapshotId: authority.snapshot.id, contextRootId: head.root_id,
      settingsSnapshotContentObjectId: settingsId,
      recipe: { kind: 'reliable-context-compression', sourceRootId: head.root_id, sourceSegmentCount: 1 }, idempotencyKey: 'pending-compression'
    });
    await update({ kind: 'disabled' });
    const restarted = new kernel.ModelProviderControlPlane(app.database, app.contentStore, { compressionSettingsAuthority: configuration });
    assert.equal(await restarted.freezeRequestSettings(started.turnId, authority.snapshot.id), settingsId);
    const replay = await restarted.replay(created.modelRequestId);
    assert.equal(replay.authoritySnapshot.compression.methodKind, 'llm_summary');
    assert.equal(replay.authoritySnapshot.compression.thresholdTokens, 40000);
    assert.equal((await configuration.loadGlobalSettings('llmCompressionConfigs')).settings.configs[0].kind, 'disabled');
  });
});

test('集成：摘要继承同次请求的会话思维，输出预留随冻结生成设置更新', async () => {
  await fixture(async ({ app, configuration, save, update, provider, input, frozen }) => {
    const chat = { ...provider, provider: 'openai-responses', baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.2', models: [{ id: 'gpt-5.2', name: 'gpt-5.2' }],
      generationConfig: { maxOutputTokens: 32000, thinkingConfig: { thinkingLevel: 'high' } } };
    await save('llmProviderConfigs', { configs: [chat] });
    await update({ llmSummary: { targetTokens: 1000, reasoning: { mode: 'inherit_chat' } } });
    await configuration.mutations.setModelProfile({ scopeKind: 'conversation', scopeId: 'live-conversation',
      providerConfigId: chat.id, provider: chat.provider, model: chat.model,
      thinkingOverride: { kind: 'openai-effort', value: 'medium' } });
    const started = await app.turns.input(input('frozen-summary-thinking'));
    const original = await frozen(started.turnId);
    await save('llmProviderConfigs', { configs: [{ ...chat,
      generationConfig: { ...chat.generationConfig, maxOutputTokens: 64000 } }] });
    const settingsId = await app.modelProvider.freezeRequestSettings(started.turnId, original.snapshot.id);
    const settings = await readRequestSettings(app.database, app.contentStore, settingsId);
    assert.equal(settings.requestGeneration.generationConfig.thinkingConfig.thinkingLevel, 'medium');
    assert.equal(settings.requestCompression.compression.provider.summaryReasoning.generationConfig.thinkingConfig.thinkingLevel, 'medium');
    const effective = applyRequestCompressionSettings(original.document, settings);
    assert.equal(effective.model.maxOutputTokens, 64000);
    assert.equal(original.document.model.maxOutputTokens, 32000);
    const reset = applyRequestCompressionSettings(original.document, { requestGeneration: {
      ...settings.requestGeneration, generationConfig: {}
    } });
    assert.equal(reset.model.maxOutputTokens, protocol.DEFAULT_LLM_COMPRESSION_OUTPUT_RESERVE_TOKENS);
    await save('llmProviderConfigs', { configs: [chat] });
    assert.deepEqual(await readRequestSettings(app.database, app.contentStore, settingsId), settings);
  });
});

test('请求压缩设置不允许改变模型身份或接受不一致阈值', async () => {
  await fixture(async ({ app, configuration, input, frozen }) => {
    const started = await app.turns.input(input('invalid-settings'));
    const source = (await frozen(started.turnId)).document;
    const selected = await configuration.loadRequestCompressionSettings({ providerConfigId: 'live-provider', provider: source.model.provider, model: 'live-model' });
    assert.throws(() => applyRequestCompressionSettings(source, { requestCompression: { ...selected, model: { ...selected.model, model: 'other' } } }), /模型选择/);
    assert.throws(() => applyRequestCompressionSettings(source, { requestCompression: { ...selected, modelProfile: { ...selected.modelProfile, compressionThresholdTokens: 999 } } }), /阈值/);
    assert.throws(() => applyRequestCompressionSettings(source, { requestCompression: null }), /不完整/);
  });
});


test('升级前冻结的请求设置快照（原 DeepSeek 渠道类型）重放时仍认作同一个模型', async () => {
  await fixture(async ({ app, configuration, input, frozen }) => {
    const started = await app.turns.input(input('legacy-deepseek-settings'));
    const source = (await frozen(started.turnId)).document;
    assert.equal(source.model.provider, 'openai-compatible');
    const selected = await configuration.loadRequestCompressionSettings({ providerConfigId: 'live-provider', provider: source.model.provider, model: 'live-model' });
    const legacyModel = { ...selected.model, provider: 'deepseek' };
    const generation = { model: legacyModel, generationConfig: {}, requestBody: {}, thinkingControlledByBody: false };
    for (const authority of [source, { ...source, model: { ...source.model, provider: 'deepseek' } }]) {
      applyRequestCompressionSettings(authority, { requestGeneration: generation });
      applyRequestCompressionSettings(authority, { requestCompression: { ...selected, model: legacyModel } });
    }
    assert.throws(() => applyRequestCompressionSettings(source, { requestGeneration: { ...generation, model: { ...legacyModel, provider: 'claude' } } }), /不能更换本轮模型/);
  });
});

test('自动摘要失败但完整输入仍可容纳：保留原上下文、正常回答、冻结有界继续决定', async () => {
  await fixture(async ({ app, input, terminal, update, list, requests }) => {
    const history = await app.turns.input(input('fallback-history', 'KEEP_ORIGINAL_42 历史约束。'.repeat(5000)));
    await terminal(history.turnId);
    await update({ kind: 'llm_summary', fallbacks: ['continue_uncompressed_if_fits'],
      trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 10000 } });
    const result = await app.agentLoop.runInput(input('fallback-input'));
    assert.equal(result.terminalStatus, 'completed');
    assert.equal(requests.filter((request) => request.recipe.kind === 'reliable-context-compression').length, 1);
    const ordinary = requests.find((request) => request.recipe.kind === 'reliable-agent-turn');
    assert.ok(ordinary.context.some((item) => item.content.includes('KEEP_ORIGINAL_42')));
    const rows = await list('ModelRequest', { turn_id: result.turnId });
    const failed = rows.find((row) => row.terminal_state !== 'completed');
    assert.equal(failed.stream_stats_json.failure.category, 'capability');
    assert.equal(failed.stream_stats_json.failure.status, 400);
    const continued = rows.find((row) => row.id === ordinary.modelRequestId);
    assert.equal(continued.stream_stats_json.compressionDecision.outcome, 'continued_uncompressed');
    assert.equal(continued.stream_stats_json.compressionDecision.failures[0].modelRequestId, failed.id);
    assert.ok(continued.stream_stats_json.compressionDecision.estimatedTokens <= continued.stream_stats_json.compressionDecision.limitTokens);
    assert.equal((await list('CompressionBlock')).length, 0);
    await update({ kind: 'disabled' });
    const replay = await app.modelProvider.replay(ordinary.modelRequestId);
    assert.deepEqual(replay.recipe.compressionDecision, continued.stream_stats_json.compressionDecision);
  }, { async send(request, controls) {
    if (request.recipe.kind === 'reliable-context-compression') {
      throw new kernel.ProviderCapabilityError('unsupported_parameter', 'Summary parameter unsupported', 400, 'llm_summary');
    }
    await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: '正常回答。' }] } });
  } });
});

for (const scenario of ['authentication', 'internal']) {
  test(`自动压缩 ${scenario} 故障不被降级掩盖或继续发送`, async () => {
    await fixture(async ({ app, input, terminal, update, list, requests }) => {
      const history = await app.turns.input(input(`fatal-history-${scenario}`, '以前的重要历史。'.repeat(12000)));
      await terminal(history.turnId);
      await update({ kind: 'llm_summary', trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 10000 } });
      const result = await app.agentLoop.runInput(input(`fatal-${scenario}`));
      assert.equal(result.terminalStatus, 'failed');
      assert.equal(requests.length, 1);
      assert.equal((await list('CompressionBlock')).length, 0);
      const [failed] = await list('ModelRequest', { turn_id: result.turnId });
      assert.equal(failed.stream_stats_json.failure.category, scenario === 'internal' ? 'internal' : 'permanent');
    }, { async send() {
      if (scenario === 'internal') throw new TypeError('Internal context invariant failed');
      throw Object.assign(new Error('authentication_error: invalid_api_key'), { status: 401 });
    } });
  });
}

test('手动压缩三段后备链只有一个维护回合；执行中改设置不改变冻结顺序', async () => {
  await fixture(async ({ app, input, terminal, update, requests, list }) => {
    const history = await app.turns.input(input('manual-chain-history', '必须保留的历史。'.repeat(600)));
    await terminal(history.turnId);
    await update({ kind: 'llm_summary', fallbacks: ['segmented_summary', 'deterministic_summary'] });
    const runner = new ReliableConversationRunner(app, 'live-owner');
    try {
      const [head] = await list('ConversationContextHeadLink');
      const result = await runner.manualCompression({ commandId: 'manual-chain', conversationId: 'live-conversation',
        compressSegmentCount: 1, target: { kind: 'current_head', expectedRootId: head.root_id } });
      assert.equal(result.compression.status, 'compressed');
      assert.deepEqual(requests.map((request) => request.recipe.compressionMethodKind), ['llm_summary', 'segmented_summary', 'deterministic_summary']);
      assert.equal(new Set(requests.map((request) => request.modelRequestId)).size, 3);
      const rows = await list('ModelRequest', { turn_id: result.turnId });
      assert.equal(new Set(rows.map((row) => row.settings_snapshot_object_id)).size, 1);
      const completed = rows.find((row) => row.terminal_state === 'completed');
      assert.equal(completed.stream_stats_json.compressionPurpose.priorFailures.length, 2);
      assert.equal((await list('MessageTurnLink', { turn_id: result.turnId })).length, 0);
      assert.equal((await list('CompressionBlock')).length, 1);
      const restored = await runner.readManualCompressionDrive({ conversationId: 'live-conversation', turnId: result.turnId });
      assert.equal(restored.compressSegmentCount, 1);
      assert.equal(restored.settingsSnapshotContentObjectId, rows[0].settings_snapshot_object_id);
      const replay = await runner.manualCompression({ commandId: 'manual-chain', conversationId: 'live-conversation',
        compressSegmentCount: 1, target: { kind: 'current_head', expectedRootId: head.root_id } });
      assert.equal(replay.deduplicated, true);
      assert.equal(requests.length, 3);
    } finally { runner.dispose(); }
  }, { async send(request, controls, { update }) {
    if (request.recipe.compressionMethodKind !== 'deterministic_summary') {
      await update({ kind: 'disabled' });
      throw new kernel.ProviderCapabilityError('unsupported_parameter', 'Not supported by test provider', 400, 'summary');
    }
    await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { type: 'compression_result',
      contents: [{ role: 'user', parts: [{ text: '保留约束的确定性摘要。' }] }] } });
  } });
});

test('原生压缩不透明状态的文本后备从不可变来源重建，而不是总结加密占位符', async () => {
  await fixture(async ({ app, input, terminal, update, frozen, list, requests }) => {
    const started = await app.turns.input(input('native-source-history', 'ORIGINAL_CANONICAL_MARKER_42 '.repeat(600)));
    await terminal(started.turnId);
    const authority = await frozen(started.turnId);
    const [head] = await list('ConversationContextHeadLink');
    const { ContextCompressionControlPlane } = require('../../dist/extension/backend/reliableKernel/contextCompression.js');
    const compression = new ContextCompressionControlPlane(app.database, app.contentStore);
    await compression.create({ conversationId: 'live-conversation', headRootId: head.root_id,
      authoritySnapshotId: authority.snapshot.id, compressSegmentCount: 1, title: '原生状态', idempotencyKey: 'native-canonical-test',
      summary: [{ role: 'model', parts: [{ providerContext: { format: 'openai-responses', itemType: 'compaction',
        rawItem: { type: 'compaction', encrypted_content: 'OPAQUE_NOT_HISTORY' } } }] }] });
    await update({ kind: 'llm_summary', fallbacks: [] });
    const runner = new ReliableConversationRunner(app, 'live-owner');
    try {
      const [nativeHead] = await list('ConversationContextHeadLink');
      const result = await runner.manualCompression({ commandId: 'native-to-text', conversationId: 'live-conversation', compressSegmentCount: 1,
        target: { kind: 'current_head', expectedRootId: nativeHead.root_id } });
      assert.equal(result.compression.status, 'compressed');
      assert.ok(requests[0].context.some((item) => item.content.includes('OPAQUE_NOT_HISTORY')));
      assert.ok(requests[0].compressionSourceContext.some((item) => item.content.includes('ORIGINAL_CANONICAL_MARKER_42')));
      assert.ok(!requests[0].compressionSourceContext.some((item) => item.content.includes('OPAQUE_NOT_HISTORY')));
      assert.equal((await list('CompressionBlock')).length, 2);
    } finally { runner.dispose(); }
  });
});
