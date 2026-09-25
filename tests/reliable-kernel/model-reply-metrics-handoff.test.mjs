import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiled, 'backend/reliableKernel/index.js'));
const { ReliableLlmProviderRegistry } = require(path.join(compiled, 'backend/reliableKernel/llmCapabilityProviderRegistry.js'));
const conversationId = 'metrics-handoff-conversation';
const providerId = '20260925-120000-000-openai-compatible-provider-0123456';
const modelId = 'gpt-6-astra';
const nativeResponses = { enabled: true, asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false };
const usage = {
  prompt_tokens: 537, completion_tokens: 111, total_tokens: 648,
  prompt_tokens_details: { cached_tokens: 500, audio_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 11, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 }
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// No key or external service: use the production OpenAI-compatible decoder, capability, adapter,
// control plane and SQLite writer against a loopback SSE endpoint. Never open the user's data root.
async function openRuntime(provider) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-metrics-handoff-'));
  const timeline = [];
  const wireRequests = [];
  let app, feed, providers;
  const endpoint = http.createServer(async (request, response) => {
    let body = '';
    for await (const bytes of request) body += bytes;
    wireRequests.push(JSON.parse(body));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (provider === 'openai-responses') {
      let sequence = 0;
      const send = event => response.write(`data: ${JSON.stringify({ sequence_number: ++sequence, ...event })}\n\n`);
      const responseId = 'resp_0123456789abcdef0123456789abcdef';
      const item = { type: 'message', id: 'msg_0123456789abcdef0123456789abcdef', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: '已提交的普通回复', annotations: [] }] };
      send({ type: 'response.created', response: { id: responseId, status: 'in_progress', model: modelId, output: [] } });
      await delay(15);
      send({ type: 'response.output_text.delta', response_id: responseId, item_id: item.id, output_index: 0, content_index: 0, delta: '已提交的普通回复' });
      await delay(20);
      send({ type: 'response.output_item.done', response_id: responseId, output_index: 0, item });
      send({ type: 'response.completed', response: { id: responseId, status: 'completed', model: modelId, output: [item],
        usage: { input_tokens: 537, output_tokens: 111, total_tokens: 648,
          input_tokens_details: { cached_tokens: 500 }, output_tokens_details: { reasoning_tokens: 11 } } } });
      response.end('data: [DONE]\n\n');
      return;
    }
    const chunk = data => response.write(`data: ${JSON.stringify({ id: 'chatcmpl-metrics', object: 'chat.completion.chunk', model: modelId, ...data })}\n\n`);
    await delay(15);
    chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '已提交的普通回复' }, finish_reason: null }] });
    await delay(20);
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    chunk({ choices: [], usage });
    response.end('data: [DONE]\n\n');
  });
  const close = async () => {
    feed?.close();
    await app?.close();
    providers?.dispose();
    endpoint.closeAllConnections();
    await new Promise(resolve => endpoint.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  };
  try {
    await new Promise(resolve => endpoint.listen(0, '127.0.0.1', resolve));
    providers = new ReliableLlmProviderRegistry({ async loadProviderConfig() {
      return { id: providerId, name: 'Loopback metrics', provider, model: modelId,
        openaiResponsesTransport: 'http', nativeResponses, stream: true,
        models: [{ id: modelId, name: modelId }], modelConfigs: [], generationConfig: {}, apiKey: 'local-fixture',
        baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1` };
    } });
    const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(root);
    app = await kernel.ReliableKernelApplication.open(root, {
      authorityCompiler: { async compile(request) {
        return {
          turnId: request.turnId, executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: providerId, modelId }) },
          authoritySnapshot: { content: JSON.stringify({
            kind: 'effective-turn-authority', turnId: request.turnId, conversationId: request.conversationId,
            executorAgentId: request.executorAgentId,
            model: { providerConfigId: providerId, provider, modelId,
              baseUrl: `http://127.0.0.1:${endpoint.address().port}/v1`, openaiResponsesTransport: 'http', nativeResponses,
              generationConfig: {}, retryPolicy: { enabled: false, maxRetries: 0 } },
            modelProfile: { compressionThresholdTokens: 100_000, contextWindowTokens: 128_000,
              tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
            toolPolicy: { id: 'metrics-tools', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
            planReviewPolicy: { mode: 'off' }, systemPrompt: { id: 'metrics-prompt', text: '' },
            runtimeContext: { id: null, name: '', template: '' },
            workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
          }) }
        };
      } },
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { return null; } },
      mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
      attachmentSettings: { async loadGlobalSettings() {
        return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'isolated/attachments.json' };
      } },
      providers,
      transientObserver: { observe(event) { timeline.push({ transient: structuredClone(event) }); } },
      toolDispatcher: { definitions() { return []; }, async dispatch() { throw new Error('No tools in this fixture'); } }
    });
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: conversationId, title: 'Metrics', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'metrics-agent-link', conversation_id: conversationId, agent_id: 'metrics-agent', role: 'default', created_at: now, updated_at: now })
    ]);
    feed = new kernel.BoundedClientFeed(app.database);
    const connection = await feed.connect({ activeConversationId: conversationId, send(frame) {
      timeline.push({ frame: structuredClone(frame) });
      queueMicrotask(() => feed.acknowledge({ sessionId: frame.sessionId, hostBootId: frame.hostBootId, messageSeq: frame.messageSeq }));
    } });
    const run = async () => {
      const result = await app.agentLoop.runInput({ source: { kind: 'command', key: 'metrics-input' },
        conversationId, leaseOwnerId: 'metrics-owner', hostBootId: app.database.hostBootId,
        leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), content: '请回复' });
      assert.equal(result.terminalStatus, 'completed');
      await waitFor(() => timeline.some(({ frame }) => frame?.type === 'reliable-kernel.snapshot'
        && frame.projections.activeTurnSummary.turns.some(turn => turn.id === result.turnId && turn.status === 'terminated')));
      return result;
    };
    return { app, feed, connection, run, timeline, wireRequests, close };
  } catch (error) { await close(); throw error; }
}

async function openWebview() {
  const pinia = await import('pinia');
  const { createSSRApp } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const posted = [];
  let server;
  const close = async () => {
    await server?.close();
    pinia.setActivePinia(previousPinia);
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  };
  try {
    globalThis.window = {
      addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, atob,
      requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
      cancelAnimationFrame(id) { clearTimeout(id); },
      acquireVsCodeApi() { return { postMessage(message) { posted.push(message); }, getState() {}, setState() {} }; }
    };
    server = await createWebviewSsrServer();
    const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
    const { projectReliableConversation } = await server.ssrLoadModule('/src/domain/reliableConversationProjection.ts');
    const { modelRunMetrics } = await server.ssrLoadModule('/src/components/conversation/runMetricsModel.ts');
    const { default: MessageItem } = await server.ssrLoadModule('/src/components/conversation/MessageItem.vue');
    globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
    const active = pinia.createPinia();
    pinia.setActivePinia(active);
    const store = useReliableKernelClientFeedStore();
    const project = () => projectReliableConversation({ conversationId, records: store.records,
      details: store.details, transientModelRequests: store.transientModelRequests, lastCommitSeq: store.lastCommitSeq });
    const render = message => renderToString(createSSRApp(MessageItem, {
      message, floorNumber: project().absoluteFloorByMessageId[message.id], detailReady: true
    }).use(active));
    return { store, project, render, modelRunMetrics, posted, close };
  } catch (error) { await close(); throw error; }
}

async function waitFor(predicate) {
  for (let i = 0; i < 600; i += 1) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail('Timed out waiting for the committed Feed frontier');
}

const parse = value => typeof value === 'string' ? JSON.parse(value) : value;

for (const provider of ['openai-compatible', 'openai-responses']) test(`${provider} 普通回复通过实时 Feed 和详情交接后，楼层与已提交页脚计量同时保留`, async t => {
  const runtime = await openRuntime(provider);
  t.after(() => runtime.close());
  const view = await openWebview();
  t.after(() => view.close());
  await runtime.run();
  assert.equal(runtime.wireRequests.length, 1, '实际经过本地 HTTP provider 解码，不直接注入完成计量');
  assert.ok(runtime.timeline.some(({ frame }) => frame?.type === 'reliable-kernel.changes'), '覆盖真实增量 Feed');

  let sawTransientUsage = false;
  const handoffs = [];
  const reader = new kernel.ClientDetailReader(runtime.app.database, runtime.app.contentStore);
  const hydrated = new Set();
  for (const entry of runtime.timeline) {
    if (entry.frame) view.store.observe(entry.frame);
    else view.store.observe({ type: 'reliable-kernel.transient', sessionId: view.store.sessionId,
      hostBootId: view.store.hostBootId, ...entry.transient });
    if (Object.values(view.store.transientModelRequests).some(request => request.usageMetadata?.promptTokenCount === 537)) {
      sawTransientUsage = true;
    }
    // Hydrate at the actual live frontier, not only after the final snapshot. Incremental upserts
    // carry decoded JSON objects whereas database window rows carry JSON strings.
    for (const link of Object.values(view.store.records.ModelRequestMessageLink ?? {})) {
      const request = view.store.records.ModelRequest?.[link.model_request_id];
      const message = view.store.records.Message?.[link.message_id];
      if (!sawTransientUsage || request?.status !== 'terminal' || !message?.revision_id || hydrated.has(message.revision_id)) continue;
      const before = view.project().messages.find(value => value.id === message.id);
      assert.equal(before.usageMetadata?.promptTokenCount, 537, '瞬态交接前输入计量可见');
      view.store.requestDetail('message-content', message.revision_id, { priority: 'visible' });
      const pending = view.posted.findLast(message => message.type === 'reliable-kernel.detail-request');
      const detail = await reader.read({ kind: 'message-content', recordId: message.revision_id, offset: 0, maxBytes: 65536, conversationId });
      view.store.observe({ type: 'reliable-kernel.detail-result', requestId: pending.requestId, sessionId: view.store.sessionId, detail });
      hydrated.add(message.revision_id);
      const after = view.project().messages.find(value => value.id === message.id);
      const html = await view.render(after);
      assert.match(html, /message-floor-index[^>]*>#2</, '瞬态退场后的消息及楼层仍在');
      assert.equal(view.store.transientModelRequests[request.id], undefined, '详情就绪后应及时清理瞬态');
      handoffs.push({ frameType: entry.frame?.type, input: after.usageMetadata?.promptTokenCount,
        output: after.usageMetadata?.candidatesTokenCount, hasTokens: html.includes('token-usage-row'),
        metrics: view.modelRunMetrics(after, false), summaryTruncated: request.summary_truncated });
    }
  }
  t.diagnostic(JSON.stringify({ handoffs }));
  assert.ok(handoffs.length > 0);
  assert.ok(handoffs.every(value => value.input === 537 && value.output === 111 && value.hasTokens),
    '实时交接不能出现瞬态指标退场、楼层仍在但输入/输出数字消失');
  assert.ok(handoffs.every(({ metrics }) => metrics.ttftMs >= 0 && metrics.totalMs > 0 && metrics.tokenSpeed > 0),
    '实时交接的首字、总耗和速度必须来自同一已提交请求');
  assert.ok(sawTransientUsage, '完成事件的计量曾在瞬态出现');
  const snapshot = (await runtime.app.database.clientProjectionSnapshot(conversationId)).snapshot;
  const model = snapshot.activeConversationWindow.messages.find(message => message.role === 'model');
  const link = snapshot.activeTurnSummary.modelRequestMessageLinks.find(link => link.message_id === model.id);
  const request = snapshot.activeTurnSummary.modelRequests.find(request => request.id === link.model_request_id);
  assert.equal(parse(request.usage_json).promptTokenCount, 537);
  assert.ok(parse(request.stream_stats_json).completedAt > 0);
  assert.ok(Object.values(view.store.records.ModelRequestMessageLink).some(value => value.message_id === model.id));
  const after = view.project().messages.find(message => message.id === model.id);
  const html = await view.render(after);
  assert.match(html, /message-floor-index[^>]*>#2</, '指标消失的复现中，消息楼层仍然存在');
  t.diagnostic(JSON.stringify({ rawRequestBytes: Buffer.byteLength(JSON.stringify(request, (_key, value) => typeof value === 'bigint' ? value.toString() : value)),
    wireRequestBytes: Buffer.byteLength(JSON.stringify(view.store.records.ModelRequest[request.id])) }));
  assert.equal(after.usageMetadata?.promptTokenCount, 537, '瞬态退场后，必须由已提交请求继续展示输入 Token');
  assert.equal(after.usageMetadata?.candidatesTokenCount, 111);
  assert.equal(after.usageMetadata?.cachedContentTokenCount, 500);
  const metrics = view.modelRunMetrics(after, false);
  assert.ok(metrics.ttftMs >= 0 && metrics.totalMs > 0 && metrics.tokenSpeed > 0);
  assert.match(html, /token-usage-row/);
  assert.deepEqual(view.store.records.ModelRequest[request.id].stream_stats_json, parse(request.stream_stats_json),
    '模型时间、原生首轮和最近物理 response 在真正 Wire 摘要中完整保留');

  // A new Webview session starts from the real bounded snapshot, with no transient memory.
  const reconnectFrames = [];
  await runtime.feed.connect({ activeConversationId: conversationId, send(frame) { reconnectFrames.push(frame); } });
  view.store.$reset();
  view.store.observe(reconnectFrames[0]);
  assert.deepEqual(Object.keys(view.store.transientModelRequests), []);
  const restored = view.project().messages.find(message => message.id === model.id);
  assert.deepEqual(restored.usageMetadata, after.usageMetadata);
  assert.deepEqual(view.modelRunMetrics(restored, false), metrics);
  assert.match(await view.render(restored), /token-usage-row/);

  // Scrolled-out messages use worker-side history sizing and a second bridge projection.
  const history = await new kernel.ClientHistoryReader(runtime.app.database).backwardVisibleMessages({
    conversationId, limit: 20, beforeMessageSeq: String(BigInt(model.message_seq) + 1n), beforeId: model.id
  });
  view.store.records = Object.fromEntries(Object.entries(history.records).map(([type, rows]) =>
    [type, Object.fromEntries(rows.map(row => [row.id, row]))]));
  const historical = view.project().messages.find(message => message.id === model.id);
  assert.deepEqual(historical.usageMetadata, after.usageMetadata);
  assert.deepEqual(view.modelRunMetrics(historical, false), metrics);
  assert.match(await view.render(historical), /message-floor-index[^>]*>#2</);
});
