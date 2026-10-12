import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
class Uri {
  constructor(value) { this.scheme = 'file'; this.fsPath = path.resolve(value); this.path = this.fsPath; }
  static file(value) { return new Uri(value); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.path}`; }
}
const vscode = { Uri, FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 }, workspace: { fs: {
  createDirectory: uri => fs.mkdir(uri.fsPath, { recursive: true }),
  readFile: uri => fs.readFile(uri.fsPath),
  async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
  async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map(entry => [entry.name, entry.isDirectory() ? 2 : 1]); },
  delete: uri => fs.rm(uri.fsPath, { recursive: true, force: true }),
  async stat(uri) { const s = await fs.stat(uri.fsPath); return { type: s.isDirectory() ? 2 : 1, size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs }; }
} } };
const originalLoad = Module._load;
let Configuration, storagePaths, defaultProvider;
try {
  Module._load = function (request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
  ({ VscodeConfigurationAuthority: Configuration } = load('backend/reliableKernel/vscodeConfigurationAuthority.js'));
  ({ createVscodeStoragePaths: storagePaths } = load('backend/capabilities/vscodeStorage/paths.js'));
  ({ createDefaultLlmProviderConfig: defaultProvider } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js'));
} finally { Module._load = originalLoad; }

export const kernel = load('backend/reliableKernel/index.js');
export const { emptyConversationContextHandleStateStep } = load('backend/reliableKernel/conversationContextHandleState.js');
export const { ReliableConversationRunner } = load('backend/application/reliableKernel/ReliableConversationRunner.js');
export const { expandTextCompressionSources } = load('backend/reliableKernel/compressionSourceReplay.js');
export const { readFileTool } = load('backend/world/modules/tools/definitions/readFile/index.js');
export const { createLlmProviderCapability, dryRunCompactLlmProvider } = load('backend/capabilities/llmProvider.js');
export const protocol = load('shared/protocol.js');
export const SUMMARY = ['目标', '- 保留实际历史', '', '重要约束、决定和准确标识', '- 无', '',
  '工作状态', '  - 已完成', '    - 无', '  - 正在做', '    - 无', '  - 受阻', '    - 无', '',
  '下一步', '- 无', '', '相关文件', '- 无'].join('\n');
export const IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
export const words = count => Array.from({ length: count }, (_, i) => `fact-${i}`).join(' ');
export const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

export function compactRequest(id, text, kind = 'segmented_summary') {
  return { id, blockId: `${id}-block`, conversationId: id, methodKind: kind,
    methodConfigSnapshot: { id: 'compact-method', name: '摘要', kind, trigger: { mode: 'manual' },
      llmSummary: { targetTokens: 1_000, generationConfig: { maxOutputTokens: 2_048 } }, createdAt: 1, updatedAt: 1 },
    contents: kind === 'llm_summary' ? [{ role: 'user', parts: [{ text }] }] : [],
    ...(kind === 'llm_summary' ? {} : { segments: [[{ role: 'user', parts: [{ text }] }]] }) };
}

/** A single real Runtime/CAS/configuration and HTTP provider for serial scenarios in this file. */
export async function createAttachmentCompressionFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-ui-compression-'));
  const bodies = [];
  const state = { reply: undefined };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const record = { body: JSON.parse(Buffer.concat(chunks).toString('utf8')), done: false };
    record.text = JSON.stringify(record.body); bodies.push(record);
    let answer = state.reply ? await state.reply(record, res) : SUMMARY;
    if (answer === undefined || res.destroyed) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: `chatcmpl-${bodies.length}`, object: 'chat.completion', created: 1, model: 'fixture-model',
      choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }));
    record.done = true;
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const configuration = new Configuration(() => storagePaths(Uri.file(path.join(directory, 'settings'))));
  const save = async (section, settings) => configuration.saveGlobalSettings(section, settings, (await configuration.loadGlobalSettings(section)).revision);
  const provider = { ...defaultProvider({ name: '本地真实请求' }), id: 'fixture-provider', provider: 'openai-compatible',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: '', model: 'fixture-model',
    models: [{ id: 'fixture-model', name: '本地模型' }], contextWindowTokens: 40_000, stream: false,
    retryOnError: false, retryMaxAttempts: 0, enableMultimodalTools: true };
  const config = { ...protocol.createDefaultLlmCompressionConfig('测试压缩'), kind: 'segmented_summary', fallbacks: [],
    trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: 32_000 },
    llmSummary: { targetTokens: 1_000, reasoning: { mode: 'provider_default' } } };
  let app, registry, runner;
  try {
    await save('llmProviderConfigs', { configs: [provider] });
    await save('llm', { activeProviderConfigId: provider.id });
    await save('llmCompressionConfigs', { configs: [config] });
    await save('llmCompression', { defaultConfigId: config.id, providerBindings: [], modelBindings: [] });
    await save('attachments', { maxStoredInlineFileMb: 20 });
    const agent = await configuration.mutations.createAgent({ name: '附件压缩助手', kind: 'custom' });
    const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(authority);
    registry = new kernel.ReliableLlmProviderRegistry({ async loadProviderConfig() { return provider; } });
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: configuration, compressionSettingsAuthority: configuration, attachmentSettings: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('Unexpected MCP call'); } },
      mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
      providers: registry, toolDispatcher: { definitions() { return []; }, async dispatch() { throw new Error('Unexpected tool dispatch'); } }
    });
    runner = new ReliableConversationRunner(app, 'ui-compression-owner');
    const list = async (domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
      where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))).snapshot;
    const seed = async (id, content, oldSummary = false, contentType = 'text/plain') => {
      const now = new Date().toISOString();
      await app.database.transaction([
        kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id, title: id, status: 'active', created_at: now, updated_at: now }),
        emptyConversationContextHandleStateStep(id, now),
        kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: `${id}-agent`, conversation_id: id, agent_id: agent.id,
          role: 'default', created_at: now, updated_at: now })
      ]);
      const started = await app.turns.input({ source: { kind: 'command', key: `${id}-history` }, conversationId: id,
        leaseOwnerId: 'ui-compression-owner', hostBootId: app.database.hostBootId,
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), content, contentType });
      await app.turns.terminal({ source: { kind: 'internal', key: `${id}-terminal` }, turnId: started.turnId, terminalStatus: 'completed', reason: 'fixture' });
      const [authorityRow] = await list('AuthoritySnapshot', { turn_id: started.turnId });
      if (oldSummary) await app.compression.create({ conversationId: id, headRootId: await app.context.currentHeadRootId(id),
        authoritySnapshotId: authorityRow.id, compressSegmentCount: 1, title: '旧摘要', idempotencyKey: `${id}-old-summary`,
        summary: [{ role: 'user', parts: [{ text: '[Context Summary]\n旧摘要遗漏了原始细节。' }] }] });
      return { conversationId: id, turnId: started.turnId, authoritySnapshotId: authorityRow.id,
        rootId: await app.context.currentHeadRootId(id) };
    };
    const rebuild = async (history, commandId = `${history.conversationId}-rebuild`, sourceReplay = 'immutable_provenance') => {
      const rootId = history.rootId;
      const structure = await app.context.materializeStructure(rootId);
      return runner.manualCompression({ commandId, conversationId: history.conversationId,
        compressSegmentCount: structure.records.length, target: { kind: 'current_head', expectedRootId: rootId },
        ...(sourceReplay ? { sourceReplay } : {}) });
    };
    return { directory, app, agent, configuration, runner, list, seed, rebuild, provider, config, save, bodies, state,
      async withProviderWindow(contextWindowTokens, operation) {
        const original = provider.contextWindowTokens;
        provider.contextWindowTokens = contextWindowTokens;
        await save('llmProviderConfigs', { configs: [provider] });
        try { return await operation(); }
        finally { provider.contextWindowTokens = original; await save('llmProviderConfigs', { configs: [provider] }); }
      },
      providerOptions: overrides => ({ settings: async () => ({ ...provider, ...overrides }), compressionSettings: async () => undefined,
        resolveAttachment: input => app.attachments.resolveProviderInlineData(input) }),
      async admit(bytes, mimeType, name) {
        const prepared = await app.attachments.prepareValueAttachments({ inlineData: { data: bytes.toString('base64'), mimeType, name, storage: 'embedded' } });
        await app.database.transaction(prepared.storageSteps);
        return prepared.value;
      },
      readDependencies: { fs: {}, command: {}, workEnvironment: {}, skills: {}, attachments: {
        reference: id => app.attachments.managedReference(id), resolve: id => app.attachments.resolveInlineData(id) } },
      async close() { runner.dispose(); await app.close(); registry.dispose(); server.closeAllConnections();
        await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); }
    };
  } catch (error) {
    runner?.dispose(); await app?.close(); registry?.dispose(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); throw error;
  }
}

export async function compact(capability, request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Actual compaction did not settle')), 5_000);
    capability.compact(request, event => {
      if (event.type !== 'llm:compactDone' && event.type !== 'llm:compactError') return;
      clearTimeout(timer); resolve(event);
    });
  });
}
