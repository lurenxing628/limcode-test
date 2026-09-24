/**
 * Claude 保留思考处理按对话持久化（真实内核 + 真实请求编码，只有模型服务是本地假服务）。
 *
 * 官方（https://platform.claude.com/docs/en/build-with-claude/preserved-thinking “Handle the error in code”）：
 * 前缀失配的 400 后带 beta 头与 drop_block 重试一次，并把这个选择随会话保存，之后每个请求都带上，重启后也一样；
 * 发不了 beta 头时去掉历史里全部 thinking / redacted_thinking 块并一直保持去掉（“Once you remove a block, leave it out”）。
 *
 * 假服务模拟一个悄悄删掉 block_binding、也不转发 beta 头的中转：历史里只要有思考块就返回失配 400。
 * 第一次学到“去掉思考块”后，选择写进那次 ModelRequest 的终态；清空进程内记忆（等同重启）之后，内核从窗口里模型输出所属
 * 请求的终态得出这个对话的选择，第一次发送就去掉思考块。同一渠道的其他对话不受影响。
 */
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
const vscode = createVscodeStub();
Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const kernel = load('backend/reliableKernel/index.js');
const { VscodeConfigurationAuthority } = load('backend/reliableKernel/vscodeConfigurationAuthority.js');
const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { workEnvironmentIdFromUri } = load('shared/workEnvironmentCatalog.js');
const { resetProviderRequestAdaptations } = load('backend/capabilities/providerParameterAdaptation.js');

const PREFIX_MISMATCH = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. '
      + 'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".'
  }
};

function replyStream(count) {
  return [
    ['message_start', { type: 'message_start', message: { id: `msg_${count}`, type: 'message', role: 'assistant', content: [], model: 'claude-opus-5-5', stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: `thinking ${count}` } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: `sig-${count}` } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: `reply ${count}` } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }]
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

const hasThinkingBlock = (body) => body.messages.some((message) => Array.isArray(message.content)
  && message.content.some((block) => block.type === 'thinking' || block.type === 'redacted_thinking'));

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where, orderBy: { column: 'id', direction: 'asc' }, limit: 200
  }))).snapshot;
}

async function withRuntime(run) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push({ headers: req.headers, body });
    if (hasThinkingBlock(body)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(PREFIX_MISMATCH));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(replyStream(calls.length));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-thinking-binding-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const getPaths = () => createVscodeStoragePaths(vscode.Uri.file(path.join(directory, 'configuration')));
  let configuration = new VscodeConfigurationAuthority(getPaths);
  const claude = {
    ...createDefaultLlmProviderConfig({ name: 'Relay fixture' }), id: 'claude-relay', provider: 'claude',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'dummy-test-key',
    model: 'claude-opus-5-5', models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5' }],
    promptCache: { enabled: false, mode: 'explicit', ttl: '5m' }, retryOnError: false, retryMaxAttempts: 0, retryDelaySeconds: 0
  };
  for (const [section, settings] of [
    ['llmProviderConfigs', { configs: [claude] }],
    ['llm', { activeProviderConfigId: claude.id }]
  ]) {
    const current = await configuration.loadGlobalSettings(section);
    await configuration.saveGlobalSettings(section, settings, current.revision);
  }
  await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: [] });
  const agent = await configuration.mutations.createAgent({ name: 'Binding fixture', kind: 'custom' });
  const folderPath = path.join(directory, 'workspace');
  await fs.mkdir(folderPath);
  const uri = vscode.Uri.file(folderPath).toString();
  let app;
  let providers;
  const open = async () => {
    configuration = new VscodeConfigurationAuthority(getPaths);
    await configuration.synchronizeWorkspaceFolders([{ uri, name: 'Fixture', rootPath: folderPath, index: 0 }]);
    providers = new kernel.ReliableLlmProviderRegistry({ loadProviderConfig: (id) => configuration.providerConfig(id) });
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('no MCP'); } },
      mcpPolicyGate: { async authorize() { assert.fail('no MCP'); } },
      attachmentSettings: configuration,
      providers,
      toolDispatcher: { definitions() { return []; }, async dispatch() { assert.fail('no tools'); } }
    });
  };
  const createConversation = async (conversationId) => {
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: conversationId, title: conversationId, status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: `${conversationId}-agent`, conversation_id: conversationId, agent_id: agent.id, role: 'default', created_at: now, updated_at: now
      })
    ]);
    await configuration.mutations.selectConversationWorkEnvironment(conversationId, workEnvironmentIdFromUri(uri));
  };
  try {
    await configuration.synchronizeWorkspaceFolders([{ uri, name: 'Fixture', rootPath: folderPath, index: 0 }]);
    await open();
    const harness = {
      calls,
      get app() { return app; },
      createConversation,
      async restart() {
        await app.close();
        providers.dispose();
        resetProviderRequestAdaptations();
        await open();
      },
      async turn(conversationId, text) {
        await app.database.conversationOwners.retain(conversationId, `fixture-panel:${conversationId}`);
        const input = await app.turns.input({
          source: { kind: 'command', key: `${conversationId}:${text}` }, conversationId,
          leaseOwnerId: 'binding-fixture-owner', hostBootId: app.database.hostBootId,
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), content: text
        });
        const [lease] = await rows(app, 'ExecutionLease', { turn_id: input.turnId });
        const result = await kernel.runWithExecutionLeaseFence({
          id: lease.id, conversationId, turnId: input.turnId, ownerId: lease.owner_id,
          hostBootId: lease.host_boot_id, generation: BigInt(lease.generation)
        }, () => app.agentLoop.drive(input.turnId)).catch((error) => ({ terminalStatus: 'failed', error }));
        assert.equal(result.terminalStatus, 'completed',
          JSON.stringify({ result: String(result.error ?? ''), termination: await rows(app, 'TurnTermination', { turn_id: input.turnId }) }));
        return input.turnId;
      },
      async requestStats(turnId) {
        return (await rows(app, 'ModelRequest', { turn_id: turnId })).map((request) => request.stream_stats_json);
      }
    };
    await run(harness);
  } finally {
    await app?.close();
    providers?.dispose();
    resetProviderRequestAdaptations();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('去掉思考块的选择按对话持久化：重启后第一次发送就去掉，同渠道的其他对话不受影响', { timeout: 180_000 }, async () => {
  resetProviderRequestAdaptations();
  await withRuntime(async (h) => {
    await h.createConversation('source');
    await h.turn('source', 'first');
    assert.equal(h.calls.length, 1);
    assert.equal(hasThinkingBlock(h.calls[0].body), false);

    // 第二轮历史里有思考块：失配 → drop_block 重发仍失配（中转丢了 block_binding）→ 去掉思考块。
    const second = await h.turn('source', 'second');
    assert.equal(h.calls.length, 4);
    assert.equal(hasThinkingBlock(h.calls[1].body), true);
    assert.equal(h.calls[2].body.thinking?.block_binding?.prefix_mismatch_behavior, 'drop_block');
    assert.equal(hasThinkingBlock(h.calls[3].body), false);
    const stats = await h.requestStats(second);
    assert.equal(stats.at(-1).claudeThinkingBinding, 'strip_thinking', '选择写进这次请求的终态');

    // 重启：进程内记忆清空，内核从窗口里模型输出所属请求的终态得出这个对话的选择。
    await h.restart();
    const third = await h.turn('source', 'third');
    assert.equal(h.calls.length, 5, '重启后第一次发送就去掉思考块，不再先失败');
    assert.equal(hasThinkingBlock(h.calls[4].body), false);
    assert.equal(h.calls[4].body.thinking?.block_binding, undefined);
    assert.equal((await h.requestStats(third)).at(-1).claudeThinkingBinding, 'strip_thinking', '沿用的选择继续往后传');

    // 同一渠道的另一个对话：没有这个选择，照常带思考块发送。
    await h.createConversation('other');
    await h.turn('other', 'first');
    const before = h.calls.length;
    await h.turn('other', 'second');
    assert.equal(hasThinkingBlock(h.calls[before].body), true, '其他对话不被套上去掉思考块');
  });
});

function createVscodeStub() {
  class Uri {
    constructor(fsPath) { this.scheme = 'file'; this.fsPath = path.resolve(fsPath); this.path = this.fsPath.split(path.sep).join('/'); }
    static file(value) { return new Uri(value); }
    static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
    toString() { return `file://${this.path}`; }
  }
  const FileType = { Unknown: 0, File: 1, Directory: 2 };
  return { Uri, FileType, workspace: { fs: {
    async createDirectory(uri) { await fs.mkdir(uri.fsPath, { recursive: true }); },
    async readFile(uri) { return fs.readFile(uri.fsPath); },
    async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
    async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map(entry => [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File]); },
    async delete(uri) { await fs.rm(uri.fsPath, { recursive: true, force: true }); },
    async stat(uri) { const stat = await fs.stat(uri.fsPath); return { type: stat.isDirectory() ? FileType.Directory : FileType.File, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size }; }
  } } };
}
