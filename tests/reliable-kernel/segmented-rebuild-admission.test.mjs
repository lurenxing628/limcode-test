import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
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
const { ContextCompressionControlPlane } = require('../../dist/extension/backend/reliableKernel/contextCompression.js');
const protocol = require('../../dist/extension/shared/protocol.js');

const STRUCTURED_SUMMARY = [
  '目标', '- 保留历史事实', '',
  '重要约束、决定和准确标识', '- 无', '',
  '工作状态', '  - 已完成', '    - 无',
  '  - 正在做', '    - 无', '  - 受阻', '    - 无', '',
  '下一步', '- 无', '', '相关文件', '- 无'
].join('\n');

/** Local chat-completions stand-in: the real summary Provider path runs, but no request leaves the host. */
async function startSummaryServer() {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-${bodies.length}`, object: 'chat.completion', created: 1, model: 'rebuild-model',
      choices: [{ index: 0, message: { role: 'assistant', content: STRUCTURED_SUMMARY }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return { bodies, baseUrl: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * One Conversation whose single user turn is far larger than the compression model's window,
 * already replaced by a short text summary; rebuilding must expand that summary back to the turn.
 */
async function fixture({ contextWindowTokens, compression, historyText, oldSummary = true }, run) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-segmented-rebuild-'));
  const server = await startSummaryServer();
  let app;
  let registry;
  try {
    const configuration = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(path.join(parent, 'settings'))));
    const save = async (section, settings) => configuration.saveGlobalSettings(section, settings, (await configuration.loadGlobalSettings(section)).revision);
    const provider = {
      ...createDefaultLlmProviderConfig({ name: '重建渠道' }), id: 'rebuild-provider', provider: 'openai-compatible',
      baseUrl: server.baseUrl, apiKey: 'local-test-key', model: 'rebuild-model', models: [{ id: 'rebuild-model', name: '重建模型' }],
      contextWindowTokens, stream: false
    };
    const config = {
      ...protocol.createDefaultLlmCompressionConfig('重建压缩'),
      trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: Math.floor(contextWindowTokens * 0.8) },
      llmSummary: { targetTokens: 1_000, reasoning: { mode: 'provider_default' } },
      ...compression
    };
    await save('llmProviderConfigs', { configs: [provider] });
    await save('llm', { activeProviderConfigId: provider.id });
    await save('llmCompressionConfigs', { configs: [config] });
    await save('llmCompression', { defaultConfigId: config.id, providerBindings: [], modelBindings: [] });
    const agent = await configuration.mutations.createAgent({ name: '重建助手', kind: 'custom' });
    const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(authority);
    registry = new kernel.ReliableLlmProviderRegistry({
      async loadProviderConfig(id) {
        const found = (await configuration.loadGlobalSettings('llmProviderConfigs')).settings.configs.find((item) => item.id === id);
        if (!found) throw new Error(`missing provider ${id}`);
        return found;
      }
    });
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: configuration,
      compressionSettingsAuthority: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { return null; } },
      mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
      attachmentSettings: configuration,
      providers: registry,
      toolDispatcher: { definitions() { return []; }, async dispatch() { throw new Error('fixture has no tools'); } }
    });
    const list = async (domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
      where, orderBy: { column: 'id', direction: 'asc' }, limit: 100
    }))).snapshot;
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'rebuild-conversation', title: '重建', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'rebuild-link', conversation_id: 'rebuild-conversation', agent_id: agent.id, role: 'default', created_at: now, updated_at: now })
    ]);
    const history = await app.turns.input({
      source: { kind: 'command', key: 'rebuild-history' }, conversationId: 'rebuild-conversation',
      leaseOwnerId: 'rebuild-owner', hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), content: historyText
    });
    await app.turns.terminal({ source: { kind: 'internal', key: 'rebuild-history-terminal' }, turnId: history.turnId, terminalStatus: 'completed', reason: 'fixture' });
    if (oldSummary) {
      const [authorityRow] = await list('AuthoritySnapshot', { turn_id: history.turnId });
      const [originalHead] = await list('ConversationContextHeadLink');
      await new ContextCompressionControlPlane(app.database, app.contentStore).create({
        conversationId: 'rebuild-conversation', headRootId: originalHead.root_id, authoritySnapshotId: authorityRow.id,
        compressSegmentCount: 1, title: '旧摘要', idempotencyKey: 'old-text-summary',
        summary: [{ role: 'user', parts: [{ text: '[Context Summary]\n旧摘要缺少细节。' }] }]
      });
    }
    const [head] = await list('ConversationContextHeadLink');
    const runner = new ReliableConversationRunner(app, 'rebuild-owner');
    const rebuild = (commandId, sourceReplay = 'immutable_provenance') => runner.manualCompression({
      commandId, conversationId: 'rebuild-conversation', compressSegmentCount: 1,
      target: { kind: 'current_head', expectedRootId: head.root_id }, ...(sourceReplay ? { sourceReplay } : {})
    });
    try {
      await run({ app, list, rebuild, server, headRootId: head.root_id });
    } finally { runner.dispose(); }
  } finally {
    if (app) await app.close();
    registry?.dispose();
    await server.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
}

const oversizedTurn = (words) => `HISTORY-START ${Array.from({ length: words }, (_, index) => `fact-${index}`).join(' ')} HISTORY-END`;

test('分段摘要重建：单个回合超过压缩窗口时仍按分段调用模型，而不是被预检拒绝后退回机械摘要', async () => {
  await fixture({ contextWindowTokens: 40_000, historyText: oversizedTurn(40_000), compression: {} }, async ({ list, rebuild, server }) => {
    const result = await rebuild('segmented-rebuild');
    assert.equal(result.compression?.status, 'compressed', JSON.stringify(result));
    assert.deepEqual(result.compression.attemptedMethods, ['segmented_summary']);
    assert.equal(result.compression.failures, undefined);
    const requests = await list('ModelRequest', { turn_id: result.turnId });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].terminal_state, 'completed');
    const leafBodies = server.bodies.filter((body) => body.includes('本回合记录'));
    assert.ok(leafBodies.length >= 2, `expected several leaf summary calls, saw ${leafBodies.length}`);
    assert.ok(leafBodies.length <= 32);
    const wire = leafBodies.join('\n');
    assert.match(wire, /HISTORY-START/);
    assert.match(wire, /HISTORY-END/);
    assert.doesNotMatch(wire, /旧摘要缺少细节/, 'the old summary is replaced by its original records');
  });
});

test('普通手动分段压缩：当前单个回合超过压缩窗口时同样分段调用模型', async () => {
  await fixture({ contextWindowTokens: 40_000, historyText: oversizedTurn(40_000), compression: {}, oldSummary: false }, async ({ rebuild, server }) => {
    const result = await rebuild('segmented-manual', null);
    assert.equal(result.compression?.status, 'compressed', JSON.stringify(result));
    assert.deepEqual(result.compression.attemptedMethods, ['segmented_summary']);
    assert.ok(server.bodies.filter((body) => body.includes('本回合记录')).length >= 2);
  });
});

test('单次调用的摘要方法仍由预检拒绝超过窗口的来源，不发送模型请求', async () => {
  await fixture({
    contextWindowTokens: 40_000,
    historyText: oversizedTurn(40_000),
    compression: { kind: 'llm_summary', fallbacks: [] }
  }, async ({ list, rebuild, server }) => {
    await assert.rejects(rebuild('single-call-rebuild'), /compression_request_too_large/);
    assert.equal(server.bodies.length, 0);
    const requests = await list('ModelRequest');
    assert.equal(requests.length, 1);
    assert.notEqual(requests[0].terminal_state, 'completed');
  });
});

test('超过 32 段上限时明确报告 compression_source_too_large，不发送任何摘要请求', async () => {
  await fixture({
    contextWindowTokens: 28_000,
    historyText: oversizedTurn(120_000),
    compression: {}
  }, async ({ list, rebuild, server }) => {
    const failure = await rebuild('beyond-leaf-budget').then(() => undefined, (error) => error);
    assert.ok(failure instanceof Error, 'a source beyond the leaf budget must not complete');
    // The configured deterministic fallback measures the whole source against the same window and
    // is rejected too; the final error still names the segmented leaf budget that stopped the rebuild.
    assert.match(failure.message, /segmented_summary: compression_source_too_large/);
    assert.match(failure.message, /deterministic_summary: compression_request_too_large/);
    assert.doesNotMatch(failure.message, /compression_request_too_large: compression_request_too_large/);
    assert.equal(server.bodies.length, 0);
    const segmented = (await list('ModelRequest')).find((row) =>
      row.stream_stats_json?.compressionPurpose?.methodKind === 'segmented_summary');
    assert.notEqual(segmented.terminal_state, 'completed');
    assert.match(segmented.stream_stats_json.failure.message, /compression_source_too_large/);
    assert.equal((await list('CompressionBlock')).length, 1, 'only the old summary block remains');
  });
});
