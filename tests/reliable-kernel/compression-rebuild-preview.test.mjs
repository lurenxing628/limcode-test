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
const {
  COMPRESSION_SOURCE_REPLAY_LIMITS,
  compressionSourceReplayLimitOf,
  expandTextCompressionSources
} = require('../../dist/extension/backend/reliableKernel/compressionSourceReplay.js');
const protocol = require('../../dist/extension/shared/protocol.js');
const { VscodeReliableKernelCommandRouter } = require('../../dist/extension/backend/application/reliableKernel/VscodeReliableKernelCommandRouter.js');

const SUMMARY = [
  '目标', '- 保留历史事实', '', '重要约束、决定和准确标识', '- 无', '',
  '工作状态', '  - 已完成', '    - 无', '  - 正在做', '    - 无', '  - 受阻', '    - 无', '',
  '下一步', '- 无', '', '相关文件', '- 无'
].join('\n');

async function startSummaryServer() {
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-${bodies.length}`, object: 'chat.completion', created: 1, model: 'preview-model',
      choices: [{ index: 0, message: { role: 'assistant', content: SUMMARY }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 }
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { bodies, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function listFiles(root) {
  const result = [];
  async function walk(directory) {
    let entries = [];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      // SQLite keeps its WAL index in shared memory files that readers may touch.
      else if (!/\.(?:sqlite|db)(?:-wal|-shm)?$|-journal$/.test(entry.name)) {
        result.push(`${path.relative(root, absolute)}:${(await fs.stat(absolute)).size}`);
      }
    }
  }
  await walk(root);
  return result.sort();
}

/** One Conversation whose history was already replaced by a short text summary. */
async function fixture({ contextWindowTokens = 40_000, compression = {}, turns }, run) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-rebuild-preview-'));
  const server = await startSummaryServer();
  let app;
  let registry;
  let runner;
  try {
    const configuration = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(path.join(parent, 'settings'))));
    const save = async (section, settings) => configuration.saveGlobalSettings(section, settings, (await configuration.loadGlobalSettings(section)).revision);
    const provider = {
      ...createDefaultLlmProviderConfig({ name: '预估渠道' }), id: 'preview-provider', provider: 'openai-compatible',
      baseUrl: server.baseUrl, apiKey: 'local-test-key', model: 'preview-model', models: [{ id: 'preview-model', name: '预估模型' }],
      contextWindowTokens, stream: false
    };
    const config = {
      ...protocol.createDefaultLlmCompressionConfig('预估压缩'),
      trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: Math.floor(contextWindowTokens * 0.8) },
      llmSummary: { targetTokens: 1_000, reasoning: { mode: 'provider_default' } },
      ...compression
    };
    await save('llmProviderConfigs', { configs: [provider] });
    await save('llm', { activeProviderConfigId: provider.id });
    await save('llmCompressionConfigs', { configs: [config] });
    await save('llmCompression', { defaultConfigId: config.id, providerBindings: [], modelBindings: [] });
    const agent = await configuration.mutations.createAgent({ name: '预估助手', kind: 'custom' });
    const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(authority);
    registry = new kernel.ReliableLlmProviderRegistry({
      async loadProviderConfig(id) {
        return (await configuration.loadGlobalSettings('llmProviderConfigs')).settings.configs.find((item) => item.id === id);
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
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'preview-conversation', title: '预估', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'preview-link', conversation_id: 'preview-conversation', agent_id: agent.id, role: 'default', created_at: now, updated_at: now })
    ]);
    let lastTurnId;
    for (const [index, text] of turns.entries()) {
      const started = await app.turns.input({
        source: { kind: 'command', key: `preview-history-${index}` }, conversationId: 'preview-conversation',
        leaseOwnerId: 'preview-owner', hostBootId: app.database.hostBootId,
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), content: text
      });
      await app.turns.terminal({ source: { kind: 'internal', key: `preview-terminal-${index}` }, turnId: started.turnId, terminalStatus: 'completed', reason: 'fixture' });
      lastTurnId = started.turnId;
    }
    const [authorityRow] = await list('AuthoritySnapshot', { turn_id: lastTurnId });
    const [originalHead] = await list('ConversationContextHeadLink');
    await new ContextCompressionControlPlane(app.database, app.contentStore).create({
      conversationId: 'preview-conversation', headRootId: originalHead.root_id, authoritySnapshotId: authorityRow.id,
      compressSegmentCount: turns.length, title: '旧摘要', idempotencyKey: 'old-text-summary',
      summary: [{ role: 'user', parts: [{ text: '[Context Summary]\n旧摘要缺少细节。' }] }]
    });
    const [head] = await list('ConversationContextHeadLink');
    runner = new ReliableConversationRunner(app, 'preview-owner');
    const commitSeq = async () => (await app.database.snapshot([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').get('preview-conversation')
    ])).snapshotCommitSeq;
    const preview = async (expectedRootId = head.root_id) => {
      const before = { seq: await commitSeq(), files: await listFiles(parent) };
      const result = await runner.previewSourceReplayCompression({ conversationId: 'preview-conversation', expectedRootId });
      assert.equal(await commitSeq(), before.seq, 'the preview must not commit anything');
      assert.deepEqual(await listFiles(parent), before.files, 'the preview must not write content or settings files');
      return result;
    };
    const rebuild = () => runner.manualCompression({
      commandId: 'preview-then-rebuild', conversationId: 'preview-conversation', compressSegmentCount: 1,
      target: { kind: 'current_head', expectedRootId: head.root_id }, sourceReplay: 'immutable_provenance'
    });
    await run({ preview, rebuild, server, list, headRootId: head.root_id, save, config });
  } finally {
    runner?.dispose();
    if (app) await app.close();
    registry?.dispose();
    await server.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
}

const words = (count, tag) => Array.from({ length: count }, (_, index) => `${tag}-${index}`).join(' ');

test('小来源：预估一次摘要请求，窗口与估算来自冻结的压缩设置，且不写任何数据', async () => {
  await fixture({ turns: [`SMALL ${words(300, 'fact')}`, `SECOND ${words(200, 'more')}`] }, async ({ preview }) => {
    const result = await preview();
    assert.equal(result.outcome.kind, 'ready', JSON.stringify(result));
    assert.equal(result.outcome.methodKind, 'segmented_summary');
    assert.equal(result.outcome.summaryRequests, 1);
    assert.equal(result.outcome.mergeRequests, 0);
    assert.equal(result.outcome.attachmentRequests, 0);
    assert.equal(result.outcome.providerRequests, 1);
    assert.equal(result.estimate.summaryCount, 1);
    assert.equal(result.estimate.contextWindowTokens, 40_000);
    assert.equal(result.estimate.inputCapacityTokens, 24_000);
    assert.ok(result.estimate.sourceTokens > 500 && result.estimate.sourceTokens < 24_000, JSON.stringify(result.estimate));
  });
});

test('大来源：预估的分段请求数与随后真实重建发出的分段请求数一致', async () => {
  await fixture({ turns: [`HISTORY-START ${words(40_000, 'fact')} HISTORY-END`] }, async ({ preview, rebuild, server }) => {
    const result = await preview();
    assert.equal(result.outcome.kind, 'ready', JSON.stringify(result));
    assert.equal(result.outcome.methodKind, 'segmented_summary');
    assert.ok(result.outcome.summaryRequests >= 2 && result.outcome.summaryRequests <= 32);
    assert.ok(result.outcome.mergeRequests >= 1);
    assert.equal(result.outcome.providerRequests, result.outcome.summaryRequests + result.outcome.mergeRequests);
    assert.ok(result.estimate.sourceTokens > result.estimate.inputCapacityTokens);
    assert.equal(server.bodies.length, 0, 'the preview calls no model');
    const rebuilt = await rebuild();
    assert.equal(rebuilt.compression.status, 'compressed');
    const leafCalls = server.bodies.filter((body) => body.includes('本回合记录')).length;
    assert.equal(leafCalls, result.outcome.summaryRequests);
  });
});

test('超过 32 段：预估直接说明超出分段上限', async () => {
  await fixture({ contextWindowTokens: 28_000, turns: [words(120_000, 'fact')] }, async ({ preview, server }) => {
    const result = await preview();
    assert.deepEqual(result.outcome, { kind: 'blocked', reason: 'leaf_budget_exceeded', leafRequestLimit: 32 });
    assert.ok(result.estimate.sourceTokens > 32 * result.estimate.inputCapacityTokens / 2);
    assert.equal(server.bodies.length, 0);
  });
});

test('只有单次调用方法时，超出窗口的来源被说明为不能分段', async () => {
  await fixture({ turns: [words(40_000, 'fact')], compression: { kind: 'llm_summary', fallbacks: [] } }, async ({ preview }) => {
    const result = await preview();
    assert.deepEqual(result.outcome, { kind: 'blocked', reason: 'no_chunking_method' });
    assert.ok(result.estimate.sourceTokens > result.estimate.inputCapacityTokens);
  });
});

test('单次摘要放得下时预估一次请求；压缩关闭和上下文已变化分别说明', async () => {
  await fixture({ turns: [words(300, 'fact')], compression: { kind: 'llm_summary', fallbacks: ['segmented_summary'] } }, async ({ preview, save, config }) => {
    const ready = await preview();
    assert.equal(ready.outcome.kind, 'ready');
    assert.equal(ready.outcome.methodKind, 'llm_summary');
    assert.equal(ready.outcome.providerRequests, 1);
    assert.deepEqual((await preview('some-older-root')).outcome, { kind: 'stale' });
    await save('llmCompressionConfigs', { configs: [{ ...config, kind: 'disabled' }] });
    assert.deepEqual((await preview()).outcome, { kind: 'blocked', reason: 'compression_disabled' });
  });
});

test('重建数量和字节上限报告为上限，而不是来源损坏', async () => {
  const database = { async snapshotAll() { throw new Error('cap must be reached before any provenance read'); } };
  const compression = { segmentId: 'summary', segmentKind: 'compression', messageRole: null,
    contentType: 'application/vnd.limcode.compression-contents+json', content: '{}' };
  const message = (content, index = 0) => ({ segmentId: `message-${index}`, segmentKind: 'message', messageRole: 'user',
    contentType: 'text/plain', content });
  const bytes = await expandTextCompressionSources(database, {}, 'conversation', [
    message('x'.repeat(COMPRESSION_SOURCE_REPLAY_LIMITS.bytes + 1)), compression
  ], { sourceReplay: 'immutable_provenance' }).then(() => undefined, (error) => error);
  assert.equal(compressionSourceReplayLimitOf(bytes), 'bytes');
  const segments = await expandTextCompressionSources(database, {}, 'conversation', [
    ...Array.from({ length: COMPRESSION_SOURCE_REPLAY_LIMITS.segments + 1 }, (_, index) => message('x', index)), compression
  ], { sourceReplay: 'immutable_provenance' }).then(() => undefined, (error) => error);
  assert.equal(compressionSourceReplayLimitOf(segments), 'segments');
  assert.equal(compressionSourceReplayLimitOf(Object.assign(new Error('cycle'), { code: 'MODEL_CONTEXT_NATIVE_SOURCE_INVALID' })), undefined);
});

function routerFixture(preview) {
  const posted = [];
  const calls = [];
  const router = new VscodeReliableKernelCommandRouter({
    debugCapture: { setListener() {} }, toolHost: { setStateChangeListener() {} },
    async ensureCapabilitiesReady() {},
    application: { database: { conversationOwners: { async run(_id, operation) { return operation(); } } } },
    conversations: { async previewSourceReplayCompression(input) { calls.push(input); return preview(input); } },
    childAgents: {}
  });
  router.requireRow = async (_domain, id) => ({ id });
  router.childExecutionIdForConversation = async () => 'child-execution';
  const run = () => router.dispatch('panel', { async postMessage(message) { posted.push(message); return true; } }, {
    id: 'preview-ui', type: protocol.BridgeMessageType.CompressionRebuildPreviewGet,
    payload: { conversationId: 'conversation', expectedRootId: 'root-current' }
  });
  return { run, posted, calls };
}

test('路由把预估结果按请求 id 回给 Webview，失败也作为对话框内容返回而不弹警告', async () => {
  const ready = routerFixture(async () => ({
    estimate: { sourceTokens: 1200, summaryCount: 1, contextWindowTokens: 40000, inputCapacityTokens: 24000 },
    outcome: { kind: 'ready', methodKind: 'segmented_summary', providerRequests: 1, summaryRequests: 1, mergeRequests: 0, attachmentRequests: 0 }
  }));
  await ready.run();
  assert.deepEqual(ready.calls, [{ conversationId: 'conversation', expectedRootId: 'root-current', childExecutionId: 'child-execution' }]);
  assert.equal(ready.posted.length, 1);
  assert.equal(ready.posted[0].type, protocol.BridgeMessageType.CompressionRebuildPreviewResult);
  assert.equal(ready.posted[0].correlationId, 'preview-ui');
  assert.equal(ready.posted[0].payload.rootId, 'root-current');
  assert.equal(ready.posted[0].payload.outcome.summaryRequests, 1);

  const failed = routerFixture(async () => { throw new Error('来源缺失'); });
  await failed.run();
  assert.deepEqual(failed.posted[0].payload, {
    conversationId: 'conversation', rootId: 'root-current', outcome: { kind: 'error', message: '来源缺失' }
  });
});
