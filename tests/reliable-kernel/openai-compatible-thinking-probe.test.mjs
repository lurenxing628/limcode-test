import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createPinia, setActivePinia } from 'pinia';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const require = createRequire(import.meta.url);
// 渠道配置与路由模块在加载时引用 vscode；这里只用到它们的纯函数，给一个桩，并记下弹出的警告。
const warnings = [];
const vscodeStub = { window: { showWarningMessage(text) { warnings.push(text); return Promise.resolve(undefined); } } };
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  return request === 'vscode' ? vscodeStub : originalLoad.call(this, request, ...rest);
};
const { probeOpenAICompatibleThinking } = require('../../dist/extension/backend/capabilities/openAICompatibleThinkingProbe.js');
const { ReliableLlmProviderRegistry } = require('../../dist/extension/backend/reliableKernel/llmCapabilityProviderRegistry.js');
const {
  normalizeModelCapabilitySnapshot,
  normalizedEndpointFingerprint,
  resolveProviderModelCapabilities,
  resolveProviderOpenAICompatibleDialect
} = require('../../dist/extension/shared/modelCapabilities.js');
const { sessionThinkingCapability } = require('../../dist/extension/shared/sessionThinking.js');
const { dryRunLlmProvider } = require('../../dist/extension/backend/capabilities/llmProvider.js');
const protocol = require('../../dist/extension/shared/protocol.js');
const {
  describeOpenAICompatibleThinkingProbe,
  openAICompatibleThinkingProbeSummary
} = require('../../dist/extension/shared/openAICompatibleThinkingProbe.js');
const { openAICompatibleThinkingProbeEvidence } = require('../../dist/extension/shared/modelCapabilities.js');
const { VscodeReliableKernelCommandRouter } = require('../../dist/extension/backend/application/reliableKernel/VscodeReliableKernelCommandRouter.js');

const API_KEY = 'sk-probe-secret-7f3a9c';
const PROBE_KEYS = new Set(['model', 'messages', 'stream', 'max_tokens', 'thinking', 'enable_thinking', 'reasoning_effort']);

/**
 * 四种（外加一种）模拟服务端：按请求体里的思考参数决定先回思考增量、先回正文，还是 400 拒绝。
 * 回了第一段增量后不主动结束，等客户端断开，并记下断开用了多久。
 */
const BEHAVIORS = {
  // 类 DeepSeek：thinking 开关有效，reasoning_effort 只接受 low / high / max（medium 返回 400），enable_thinking 被忽略。
  'deepseek-like'(body) {
    if (body.reasoning_effort !== undefined && !['low', 'high', 'max'].includes(body.reasoning_effort)) {
      return { reject: `reasoning_effort ${body.reasoning_effort} is not supported` };
    }
    return body.thinking?.type === 'enabled' ? 'thinking' : 'answer';
  },
  // 类百炼：带 thinking 返回 400，enable_thinking 有效，不接受 reasoning_effort。
  'dashscope-like'(body) {
    if ('thinking' in body) return { reject: 'Unrecognized request argument supplied: thinking' };
    if ('reasoning_effort' in body) return { reject: 'reasoning_effort is not supported for this model' };
    return body.enable_thinking === true ? 'thinking' : 'answer';
  },
  // 默认在思考且关不掉：开关参数都被忽略，reasoning_effort none 返回 400。
  'always-thinking'(body) {
    if (body.reasoning_effort === 'none') return { reject: 'reasoning_effort none is not supported' };
    return 'thinking';
  },
  // 不会思考的模型：什么参数都接受，从不输出思考。
  'plain-chat'() {
    return 'answer';
  },
  // 只认 reasoning_effort（OpenRouter 风格的 delta.reasoning）：不带或为 none 时不思考，其余强度都接受。
  'effort-only'(body) {
    if (body.reasoning_effort === undefined || body.reasoning_effort === 'none') return 'answer';
    return 'thinking-openrouter';
  }
};

async function startProbeServer({ behaviors = BEHAVIORS, respond } = {}) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = JSON.parse(text);
    const record = { url: req.url, headers: req.headers, body, text, status: 200, clientClosed: false, serverEnded: false };
    requests.push(record);
    if (respond) { respond(req, res, record); return; }
    const verdict = req.headers.authorization === `Bearer ${API_KEY}`
      ? behaviors[body.model]?.(body) ?? { reject: `unknown model ${body.model}` }
      : { status: 401, reject: `Incorrect API key provided: ${req.headers.authorization}` };
    if (typeof verdict === 'object') {
      record.status = verdict.status ?? 400;
      res.writeHead(record.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: verdict.reject, type: 'invalid_request_error' } }));
      return;
    }
    record.verdict = verdict;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const delta = verdict === 'thinking' ? { role: 'assistant', content: null, reasoning_content: 'Let me' }
      : verdict === 'thinking-openrouter' ? { role: 'assistant', content: '', reasoning: 'Let me' }
        : { role: 'assistant', content: 'OK' };
    res.write(`data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', choices: [{ index: 0, delta }] })}\n\n`);
    const firstDeltaAt = Date.now();
    // 客户端没断开时 5 秒后自己结束，避免测试卡住；断言里要求 serverEnded 为 false。
    const fallback = setTimeout(() => { record.serverEnded = true; res.end('data: [DONE]\n\n'); }, 5000);
    res.on('close', () => {
      clearTimeout(fallback);
      if (!record.serverEnded) { record.clientClosed = true; record.closeDelayMs = Date.now() - firstDeltaAt; }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    /** 客户端断开是异步到达服务端的：先等每个流都结束（断开或服务端兜底结束），最多 3 秒。 */
    async settled() {
      const deadline = Date.now() + 3000;
      while (requests.some((record) => record.status === 200 && record.verdict && !record.clientClosed && !record.serverEnded) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); })
  };
}

function channel(baseUrl, model, overrides = {}) {
  return {
    id: 'probe-channel', name: '测试渠道', provider: 'openai-compatible', baseUrl, model,
    models: [{ id: model, name: model }], apiKey: API_KEY, toolCallFormat: 'function-call',
    stream: true, retryOnError: false, retryMaxAttempts: 0, enableMultimodalTools: true,
    promptCache: { enabled: false, mode: 'key', ttl: '30m' },
    // 渠道自己的请求体和生成参数不能进入测试请求。
    requestBody: { reasoning_effort: 'max', metadata: { conversation: 'secret history' } },
    generationConfig: { thinkingConfig: { thinkingLevel: 'max' } },
    modelConfigs: [], createdAt: 1, updatedAt: 1,
    ...overrides
  };
}

function modelConfig(modelId, overrides = {}) {
  return {
    id: `model-config-${modelId}`, modelId, toolCallFormat: 'function-call', stream: true, retryOnError: false,
    retryMaxAttempts: 0, retryDelaySeconds: 0, enableMultimodalTools: true, systemPromptPrefix: '',
    contextWindowTokens: 128000, createdAt: 1, updatedAt: 1, ...overrides
  };
}

function withEvidence(config, snapshot) {
  return { ...config, models: config.models.map((model) => model.id === snapshot.modelId ? { ...model, capabilitySnapshot: snapshot } : model) };
}

function thinkingParams(body) {
  return Object.fromEntries(['thinking', 'enable_thinking', 'reasoning_effort'].filter((key) => key in body).map((key) => [key, body[key]]));
}

/** 每次请求：只有一句合成的 user 消息，只带测试自己的键；回了 200 的流在第一段增量后就被客户端断开。 */
function assertProbeRequests(server, model) {
  assert.ok(server.requests.length >= 1 && server.requests.length <= 9, `请求次数 ${server.requests.length}`);
  for (const request of server.requests) {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, `Bearer ${API_KEY}`);
    assert.equal(request.body.model, model);
    assert.equal(request.body.stream, true);
    assert.ok(Number.isInteger(request.body.max_tokens) && request.body.max_tokens <= 128, `max_tokens ${request.body.max_tokens}`);
    assert.deepEqual(request.body.messages, [{ role: 'user', content: 'Reply with OK.' }]);
    for (const key of Object.keys(request.body)) assert.ok(PROBE_KEYS.has(key), `请求里多出了 ${key}`);
    assert.doesNotMatch(request.text, /secret history/);
    if (request.status === 200) {
      assert.equal(request.serverEnded, false, '客户端没有在第一段增量后断开');
      assert.equal(request.clientClosed, true, '服务端没有观察到连接关闭');
      assert.ok(request.closeDelayMs < 2000, `断开用了 ${request.closeDelayMs}ms`);
    }
  }
}

function assertNoSecret(value) {
  const text = JSON.stringify(value);
  assert.doesNotMatch(text, new RegExp(API_KEY));
  assert.doesNotMatch(text, /authorization|Bearer/i);
}

async function probe(model, overrides = {}, options = {}) {
  const server = await startProbeServer();
  try {
    const config = channel(server.baseUrl, model, overrides);
    const record = await probeOpenAICompatibleThinking(config, options);
    await server.settled();
    return { server, config, record, snapshot: record.capabilitySnapshot };
  } finally {
    await server.close();
  }
}

function assertSnapshotIdentity(snapshot, config, model) {
  assert.equal(snapshot.providerKind, 'openai-compatible');
  assert.equal(snapshot.modelId, model);
  assert.equal(snapshot.providerConfigId, config.id);
  assert.equal(snapshot.transport, 'http');
  assert.equal(snapshot.endpointFingerprint, normalizedEndpointFingerprint(config.baseUrl));
  assert.equal(snapshot.source, 'verified_probe');
  assert.ok(!Number.isNaN(Date.parse(snapshot.verifiedAt)));
  assert.equal(snapshot.reasoning.supportsBudget, false);
  // 快照经得起设置保存时的规范化，写法原样保留。
  assert.deepEqual(normalizeModelCapabilitySnapshot(snapshot), snapshot);
}

test('类 DeepSeek：thinking 开关有效，medium 被拒绝，测出 DeepSeek 写法、可以关闭、接受 low / high / max', async () => {
  const { server, config, record, snapshot } = await probe('deepseek-like');
  assertProbeRequests(server, 'deepseek-like');
  assert.equal(server.requests.length, 7);
  assert.deepEqual(record.id, 'deepseek-like');
  assertSnapshotIdentity(snapshot, config, 'deepseek-like');
  assert.equal(snapshot.reasoning.family, 'deepseek_toggle');
  assert.equal(snapshot.reasoning.wireFormat, 'deepseek');
  assert.deepEqual(snapshot.reasoning.levels, ['low', 'high', 'max']);
  assert.equal(snapshot.reasoning.canDisable, true);
  assert.equal(snapshot.reasoning.alwaysOn, false);
  assertNoSecret(record);
  // 第一次请求不带任何思考参数（基线）。
  assert.deepEqual(thinkingParams(server.requests[0].body), {});
});

test('类百炼：thinking 返回 400，enable_thinking 有效，不接受强度时记为只开关', async () => {
  const { server, config, snapshot } = await probe('dashscope-like');
  assertProbeRequests(server, 'dashscope-like');
  assert.equal(server.requests.length, 8);
  assertSnapshotIdentity(snapshot, config, 'dashscope-like');
  assert.equal(snapshot.reasoning.family, 'deepseek_toggle');
  assert.equal(snapshot.reasoning.wireFormat, 'enable_thinking');
  assert.deepEqual(snapshot.reasoning.levels, []);
  assert.equal(snapshot.reasoning.canDisable, true);
  assert.ok(server.requests.some((request) => request.status === 400 && 'thinking' in request.body));
  assertNoSecret(snapshot);
});

test('默认在思考且关不掉：记为不能关闭，写法取没被拒绝的那一种', async () => {
  const { server, config, snapshot } = await probe('always-thinking');
  assertProbeRequests(server, 'always-thinking');
  assert.ok(server.requests.length <= 9);
  assertSnapshotIdentity(snapshot, config, 'always-thinking');
  assert.equal(snapshot.reasoning.family, 'deepseek_toggle');
  assert.equal(snapshot.reasoning.wireFormat, 'deepseek');
  assert.equal(snapshot.reasoning.canDisable, false);
  assert.equal(snapshot.reasoning.alwaysOn, true);
  assert.deepEqual(snapshot.reasoning.levels, ['low', 'medium', 'high', 'max']);
  // 三种关闭写法都试过。
  const disables = server.requests.slice(1, 4).map((request) => thinkingParams(request.body));
  assert.deepEqual(disables, [{ thinking: { type: 'disabled' } }, { enable_thinking: false }, { reasoning_effort: 'none' }]);
});

test('不会思考的模型：记为未检测到思考，不带写法，发送时继续按自动识别', async () => {
  const { server, config, snapshot } = await probe('plain-chat');
  assertProbeRequests(server, 'plain-chat');
  assert.equal(server.requests.length, 4);
  assertSnapshotIdentity(snapshot, config, 'plain-chat');
  assert.equal(snapshot.reasoning.family, 'none');
  assert.equal('wireFormat' in snapshot.reasoning, false);
  const evidence = withEvidence(config, snapshot);
  assert.equal(resolveProviderOpenAICompatibleDialect(evidence, 'plain-chat').source, resolveProviderOpenAICompatibleDialect(config, 'plain-chat').source);
});

test('只认 reasoning_effort（OpenRouter 的 delta.reasoning 也算思考）：OpenAI 写法，none 可以关闭', async () => {
  const { server, config, snapshot } = await probe('effort-only');
  assertProbeRequests(server, 'effort-only');
  assert.ok(server.requests.length <= 9);
  assertSnapshotIdentity(snapshot, config, 'effort-only');
  assert.equal(snapshot.reasoning.family, 'openai_effort');
  assert.equal(snapshot.reasoning.wireFormat, 'reasoning_effort');
  assert.equal(snapshot.reasoning.canDisable, true);
  assert.deepEqual(snapshot.reasoning.levels, ['low', 'medium', 'high', 'max']);
});

test('测试请求不带渠道请求体，模型专属请求头替代渠道请求头，渠道请求头随请求发出', async () => {
  const server = await startProbeServer();
  const registry = new ReliableLlmProviderRegistry({
    loadProviderConfig: async () => { throw new Error('测试不应读取已保存的渠道'); },
    headers: { 'User-Agent': 'LimCode-Probe-Test' }
  });
  try {
    const config = channel(server.baseUrl, 'deepseek-like', {
      headers: { 'X-Channel': 'channel' },
      models: [{ id: 'deepseek-like', name: 'deepseek-like' }, { id: 'dashscope-like', name: 'dashscope-like' }],
      modelConfigs: [modelConfig('dashscope-like', { headers: { 'X-Model': 'model' }, requestBody: { enable_thinking: true } })]
    });
    await registry.probeOpenAICompatibleThinking({ ...config, model: 'dashscope-like' });
    for (const request of server.requests) {
      assert.equal(request.headers['x-model'], 'model');
      assert.equal(request.headers['x-channel'], undefined);
      assert.equal(request.headers['user-agent'], 'LimCode-Probe-Test');
    }
    assert.deepEqual(thinkingParams(server.requests[0].body), {});
  } finally {
    registry.dispose();
    await server.close();
  }
});

test('并发的相同测试合并成一次；结束后再点会重新测试', async () => {
  const server = await startProbeServer();
  const registry = new ReliableLlmProviderRegistry({ loadProviderConfig: async () => { throw new Error('不应读取'); } });
  try {
    const config = channel(server.baseUrl, 'deepseek-like');
    const first = registry.probeOpenAICompatibleThinking(config);
    const second = registry.probeOpenAICompatibleThinking({ ...config, models: [...config.models] });
    assert.equal(first, second);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a, b);
    assert.equal(server.requests.length, 7);
    // 换了模型不合并。
    await Promise.all([registry.probeOpenAICompatibleThinking(config), registry.probeOpenAICompatibleThinking({ ...config, model: 'plain-chat', models: [{ id: 'plain-chat', name: 'plain-chat' }] })]);
    assert.equal(server.requests.length, 7 + 7 + 4);
  } finally {
    registry.dispose();
    await server.close();
  }
});

test('拒绝非 OpenAI 兼容渠道和带凭据、查询串的地址；密钥错误时报错里不带密钥', async () => {
  await assert.rejects(probeOpenAICompatibleThinking(channel('https://api.example.invalid/v1', 'm', { provider: 'claude' })), /OpenAI 兼容/);
  await assert.rejects(probeOpenAICompatibleThinking(channel('https://user:pass@api.example.invalid/v1', 'm')), /账号密码、查询串或片段/);
  await assert.rejects(probeOpenAICompatibleThinking(channel('https://api.example.invalid/v1?key=1', 'm')), /账号密码、查询串或片段/);
  const server = await startProbeServer();
  try {
    const error = await probeOpenAICompatibleThinking(channel(server.baseUrl, 'deepseek-like', { apiKey: 'sk-wrong-key-000' })).then(() => undefined, (reason) => reason);
    assert.ok(error instanceof Error);
    assert.match(error.message, /401/);
    assert.doesNotMatch(error.message, /sk-wrong-key-000/);
    assert.equal(server.requests.length, 1, '基线就失败时不再继续发请求');
  } finally {
    await server.close();
  }
});

test('单次请求超时会中止并报错，不会一直等', async () => {
  const server = await startProbeServer({ respond: () => { /* 永远不回 */ } });
  try {
    const started = Date.now();
    await assert.rejects(probeOpenAICompatibleThinking(channel(server.baseUrl, 'deepseek-like'), { requestTimeoutMs: 300 }), /没有收到回复/);
    assert.ok(Date.now() - started < 3000);
    assert.equal(server.requests.length, 1);
  } finally {
    await server.close();
  }
});

test('优先级：手动写法 > 测试结果 > 自动识别；换接口地址或渠道 ID 后测试结果失效', async () => {
  const { config, snapshot } = await probe('dashscope-like');
  const tested = withEvidence(config, snapshot);
  const probed = resolveProviderOpenAICompatibleDialect(tested, 'dashscope-like');
  assert.deepEqual([probed.format, probed.source], ['enable_thinking', 'probe']);
  assert.equal(resolveProviderModelCapabilities(tested, 'dashscope-like').source, 'verified_probe');
  // 手动指定（渠道级、模型级）优先于测试结果。
  const manual = resolveProviderOpenAICompatibleDialect({ ...tested, openaiCompatibleThinkingFormat: 'deepseek' }, 'dashscope-like');
  assert.deepEqual([manual.format, manual.source], ['deepseek', 'manual']);
  const modelManual = resolveProviderOpenAICompatibleDialect({ ...tested, modelConfigs: [modelConfig('dashscope-like', { openaiCompatibleThinkingFormat: 'omit' })] }, 'dashscope-like');
  assert.deepEqual([modelManual.format, modelManual.source], ['omit', 'manual']);
  assert.notEqual(resolveProviderModelCapabilities({ ...tested, openaiCompatibleThinkingFormat: 'deepseek' }, 'dashscope-like').source, 'verified_probe');
  // 没有测试结果时按自动识别（本机地址、认不出的模型：OpenAI 写法）。
  assert.equal(resolveProviderOpenAICompatibleDialect(config, 'dashscope-like').source, 'platform');
  // 接口地址或渠道 ID 变了，测试结果不再采用。
  for (const changed of [{ ...tested, baseUrl: `${config.baseUrl}/other` }, { ...tested, id: 'another-channel' }]) {
    assert.notEqual(resolveProviderOpenAICompatibleDialect(changed, 'dashscope-like').source, 'probe');
    assert.notEqual(resolveProviderModelCapabilities(changed, 'dashscope-like').source, 'verified_probe');
  }
});

test('请求改写与会话思考选项采用测试结果', async () => {
  const { config, snapshot } = await probe('deepseek-like');
  const tested = withEvidence({ ...config, requestBody: undefined }, snapshot);
  const wire = async (level) => (await dryRunLlmProvider({
    id: 'probe-wire', invocationId: 'probe-wire', conversationId: 'probe-wire',
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }], tools: []
  }, { settings: async () => ({ ...tested, generationConfig: { thinkingConfig: { thinkingLevel: level } } }) })).body;
  // medium 不在测出的强度里，按规则就近换成 high。
  assert.deepEqual(thinkingParams(await wire('medium')), { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  assert.deepEqual(thinkingParams(await wire('none')), { thinking: { type: 'disabled' } });
  assert.deepEqual(sessionThinkingCapability('openai-compatible', 'deepseek-like', undefined, undefined, tested),
    { kind: 'deepseek-effort', values: ['none', 'low', 'high', 'max'] });
  // 没有测试结果时，本机服务上认不出的模型按 OpenAI 写法原样发送。
  const untested = { ...config, requestBody: undefined, generationConfig: { thinkingConfig: { thinkingLevel: 'medium' } } };
  const plain = (await dryRunLlmProvider({ id: 'plain', invocationId: 'plain', conversationId: 'plain', contents: [{ role: 'user', parts: [{ text: 'hello' }] }], tools: [] },
    { settings: async () => untested })).body;
  assert.deepEqual(thinkingParams(plain), { reasoning_effort: 'medium' });
});

async function waitFor(predicate, label) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function routerFixture(probeThinking) {
  const posted = [];
  const calls = [];
  const router = new VscodeReliableKernelCommandRouter({
    debugCapture: { setListener() {} }, toolHost: { setStateChangeListener() {} },
    async ensureCapabilitiesReady() {},
    providerRegistry: {
      async probeOpenAICompatibleThinking(config) { calls.push(config); return probeThinking(config); },
      async listModels() { throw new Error('不应获取 LLM 列表'); },
      async verifyNativeCompaction() { throw new Error('不应验证原生压缩'); }
    }
  });
  const webview = { async postMessage(message) { posted.push(message); return true; } };
  const send = (config) => router.handle('settings-panel', webview, {
    id: 'thinking-test-request', type: protocol.BridgeMessageType.LlmProviderModelsGet, payload: { config, probeThinking: true }
  });
  return { posted, calls, send };
}

test('路由：测试请求走 probeThinking 分支，结果按请求 id 回给设置页，用途标为 thinking_probe', async () => {
  const config = channel('https://relay.example.invalid/v1', 'deepseek-like');
  const record = { id: 'deepseek-like', name: 'deepseek-like', capabilitySnapshot: { source: 'verified_probe' } };
  const { posted, calls, send } = routerFixture(async () => record);
  send(config);
  await waitFor(() => posted.length > 0, '路由回复');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'deepseek-like');
  assert.equal(posted[0].type, protocol.BridgeMessageType.LlmProviderModelsSnapshot);
  assert.equal(posted[0].correlationId, 'thinking-test-request');
  assert.deepEqual(posted[0].payload, {
    configId: config.id, purpose: 'thinking_probe', provider: 'openai-compatible', baseUrl: config.baseUrl, models: [record]
  });
});

test('路由：测试失败按请求 id 回报错，不弹 VS Code 警告', async () => {
  warnings.length = 0;
  const { posted, send } = routerFixture(async () => { throw new Error('第 1 次请求失败（HTTP 401）：Incorrect API key provided'); });
  send(channel('https://relay.example.invalid/v1', 'deepseek-like'));
  await waitFor(() => posted.length > 0, '路由报错');
  assert.equal(posted[0].type, protocol.BridgeMessageType.Error);
  assert.equal(posted[0].correlationId, 'thinking-test-request');
  assert.equal(posted[0].payload.requestType, protocol.BridgeMessageType.LlmProviderModelsGet);
  assert.equal(posted[0].payload.message, '第 1 次请求失败（HTTP 401）：Incorrect API key provided');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(warnings, []);
});

function snapshotFixture(baseUrl, modelId, reasoning, providerConfigId = 'probe-channel') {
  return {
    providerKind: 'openai-compatible', modelId, providerConfigId, transport: 'http', registryRevision: '2026-09-24',
    endpointFingerprint: normalizedEndpointFingerprint(baseUrl), source: 'verified_probe', verifiedAt: '2026-09-24T02:30:00.000Z',
    reasoning: { supportsBudget: false, outputLimitIncludesThinking: true, requiresThoughtSignatures: false, ...reasoning },
    nativeCompaction: { availability: 'unknown', reason: '当前渠道和模型没有经过能力确认。' }
  };
}

const TESTED = { family: 'deepseek_toggle', levels: ['low', 'high', 'max'], canDisable: true, alwaysOn: false, wireFormat: 'deepseek' };

test('测试结果说明：写法、能否关闭、接受的强度；没测到思考时说明仍按自动识别', () => {
  const base = 'https://relay.example.invalid/v1';
  assert.equal(describeOpenAICompatibleThinkingProbe(snapshotFixture(base, 'm', TESTED)), 'DeepSeek 写法（thinking.type）；可以关闭思考；接受 low / high / max');
  assert.equal(describeOpenAICompatibleThinkingProbe(snapshotFixture(base, 'm', { family: 'deepseek_toggle', levels: [], canDisable: false, alwaysOn: true, wireFormat: 'enable_thinking' })),
    'enable_thinking 写法；关不掉思考；不接受 reasoning_effort，只开关思考');
  assert.equal(describeOpenAICompatibleThinkingProbe(snapshotFixture(base, 'm', { family: 'openai_effort', levels: ['low', 'medium', 'high'], canDisable: true, alwaysOn: false, wireFormat: 'reasoning_effort' })),
    'OpenAI 写法（只发 reasoning_effort）；可以关闭思考；接受 low / medium / high');
  assert.equal(describeOpenAICompatibleThinkingProbe(snapshotFixture(base, 'm', { family: 'none', levels: [], canDisable: false, alwaysOn: false })),
    '没有看到思考输出，发送时仍按自动识别');
  assert.match(openAICompatibleThinkingProbeSummary(snapshotFixture(base, 'm', TESTED)), /^测试结果（\d\d-\d\d \d\d:\d\d）：DeepSeek 写法/);
  // 设置界面只显示身份匹配的结果：换了接口地址或渠道就不再显示。
  const config = withEvidence(channel(base, 'm'), snapshotFixture(base, 'm', TESTED));
  assert.equal(openAICompatibleThinkingProbeEvidence(config, 'm')?.reasoning.wireFormat, 'deepseek');
  assert.equal(openAICompatibleThinkingProbeEvidence({ ...config, baseUrl: 'https://other.example.invalid/v1' }, 'm'), undefined);
  assert.equal(openAICompatibleThinkingProbeEvidence({ ...config, id: 'other' }, 'm'), undefined);
  assert.equal(openAICompatibleThinkingProbeEvidence({ ...config, provider: 'claude' }, 'm'), undefined);
});

/** 用 Vite SSR 加载真实的设置 store；bridge 发出的消息记在 posted 里，定时器由测试推进。 */
async function withSettingsStore(run) {
  const previousWindow = globalThis.window;
  const posted = [];
  const timers = new Map();
  let nextId = 0;
  let now = 0;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    acquireVsCodeApi() { return { postMessage(message) { posted.push(message); }, getState() { return undefined; }, setState() {} }; }
  };
  const server = await createWebviewSsrServer();
  try {
    const { useGlobalSettingsStore } = await server.ssrLoadModule('/src/stores/useGlobalSettingsStore.ts');
    setActivePinia(createPinia());
    const store = useGlobalSettingsStore();
    const baseUrl = 'https://relay.example.invalid/v1';
    const models = [{ id: 'deepseek-like', name: '类 DeepSeek' }, { id: 'plain-chat', name: 'plain-chat' }];
    store.applySnapshot({ section: 'llmProviderConfigs', settings: { configs: [channel(baseUrl, 'deepseek-like', { models, requestBody: undefined, generationConfig: undefined })] }, filePath: 'fixture', revision: 'initial' });
    store.applySnapshot({ section: 'llm', settings: { activeProviderConfigId: 'probe-channel' }, filePath: 'fixture', revision: 'initial' });
    const advance = (ms) => {
      const target = now + ms;
      for (;;) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      now = target;
    };
    const probeRequests = () => posted.filter((message) => message.type === protocol.BridgeMessageType.LlmProviderModelsGet && message.payload.probeThinking === true);
    const saves = () => posted.filter((message) => message.type === protocol.BridgeMessageType.GlobalSettingsUpdate && message.payload.section === 'llmProviderConfigs');
    await run({ store, posted, advance, baseUrl, probeRequests, saves, config: () => store.llmProviderConfigs.configs[0] });
  } finally {
    await server.close();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

const probeState = (store, modelId = 'deepseek-like') => store.thinkingProbeState('probe-channel', modelId);

test('设置 store：发起测试带上模型与 probeThinking，测试中不重复发送', async () => {
  await withSettingsStore(async ({ store, probeRequests }) => {
    store.testOpenAICompatibleThinking('probe-channel', 'plain-chat');
    assert.equal(probeRequests().length, 1);
    const request = probeRequests()[0];
    assert.equal(request.payload.config.id, 'probe-channel');
    assert.equal(request.payload.config.model, 'plain-chat');
    assert.equal(probeState(store, 'plain-chat').status, 'running');
    assert.equal(probeState(store, 'plain-chat').requestId, request.id);
    assert.equal(probeState(store), undefined);
    store.testOpenAICompatibleThinking('probe-channel', 'plain-chat');
    assert.equal(probeRequests().length, 1);
    // 只有 OpenAI 兼容渠道能测试。
    store.llmProviderConfigs.configs[0].provider = 'claude';
    store.testOpenAICompatibleThinking('probe-channel', 'deepseek-like');
    assert.equal(probeRequests().length, 1);
  });
});

test('设置 store：失败显示“测试思考参数失败”，不关获取 LLM 弹窗，也不当成获取 LLM 列表失败', async () => {
  await withSettingsStore(async ({ store, posted, probeRequests }) => {
    store.requestModelsForActiveConfig();
    const listRequest = posted.find((message) => message.type === protocol.BridgeMessageType.LlmProviderModelsGet && !message.payload.probeThinking);
    store.testOpenAICompatibleThinking('probe-channel', 'deepseek-like');
    store.setError('第 1 次请求失败（HTTP 401）：Incorrect API key provided', {
      requestType: protocol.BridgeMessageType.LlmProviderModelsGet, correlationId: probeRequests()[0].id
    });
    assert.deepEqual(probeState(store), {
      configId: 'probe-channel', modelId: 'deepseek-like', status: 'failed', requestId: probeRequests()[0].id,
      message: '测试思考参数失败：第 1 次请求失败（HTTP 401）：Incorrect API key provided'
    });
    assert.equal(store.status, '测试思考参数失败：第 1 次请求失败（HTTP 401）：Incorrect API key provided');
    assert.equal(store.fetchedModelsDialog.open, true);
    assert.equal(store.fetchedModelsDialog.loading, true);
    // 获取 LLM 列表自己的失败仍按原来的提示。
    store.setError('网络错误', { requestType: protocol.BridgeMessageType.LlmProviderModelsGet, correlationId: listRequest.id });
    assert.equal(store.status, '获取 LLM 列表失败：网络错误');
    assert.equal(probeState(store).status, 'failed');
    // 失败后可以重新测试。
    store.testOpenAICompatibleThinking('probe-channel', 'deepseek-like');
    assert.equal(probeRequests().length, 2);
    assert.equal(probeState(store).status, 'running');
  });
});

test('设置 store：3 分钟没有结果按超时失败', async () => {
  await withSettingsStore(async ({ store, advance }) => {
    store.testOpenAICompatibleThinking('probe-channel', 'deepseek-like');
    advance(179_999);
    assert.equal(probeState(store).status, 'running');
    advance(1);
    assert.equal(probeState(store).status, 'failed');
    assert.match(probeState(store).message, /^测试思考参数失败：3 分钟内没有结果/);
    assert.equal(store.status, probeState(store).message);
  });
});

test('设置 store：测试结果写进对应模型并保存，不影响正在获取的 LLM 列表', async () => {
  await withSettingsStore(async ({ store, probeRequests, saves, baseUrl, config }) => {
    store.requestModelsForActiveConfig();
    store.testOpenAICompatibleThinking('probe-channel', 'deepseek-like');
    const snapshot = snapshotFixture(baseUrl, 'deepseek-like', TESTED);
    store.applyLlmProviderModelsSnapshot({
      configId: 'probe-channel', purpose: 'thinking_probe', provider: 'openai-compatible', baseUrl,
      models: [{ id: 'deepseek-like', name: 'deepseek-like', capabilitySnapshot: snapshot }]
    });
    assert.deepEqual(config().models.find((model) => model.id === 'deepseek-like').capabilitySnapshot, snapshot);
    assert.equal(probeState(store), undefined);
    assert.equal(store.fetchedModelsDialog.loading, true, '测试结果不能关掉正在获取的 LLM 列表');
    assert.equal(saves().length, 1);
    const saved = saves()[0].payload.settings.configs[0].models.find((model) => model.id === 'deepseek-like');
    assert.equal(saved.capabilitySnapshot.reasoning.wireFormat, 'deepseek');
    assert.doesNotMatch(JSON.stringify(saved), new RegExp(API_KEY));
    assert.equal(store.status, '「类 DeepSeek」测试完成：DeepSeek 写法（thinking.type）；可以关闭思考；接受 low / high / max');
  });
});

test('设置 store：测试期间改了接口地址，结果作废；重新获取同名 LLM 时保留测试结果', async () => {
  await withSettingsStore(async ({ store, probeRequests, baseUrl, config }) => {
    store.testOpenAICompatibleThinking('probe-channel', 'deepseek-like');
    config().baseUrl = 'https://changed.example.invalid/v1';
    store.applyLlmProviderModelsSnapshot({
      configId: 'probe-channel', purpose: 'thinking_probe', provider: 'openai-compatible', baseUrl,
      models: [{ id: 'deepseek-like', name: 'deepseek-like', capabilitySnapshot: snapshotFixture(baseUrl, 'deepseek-like', TESTED) }]
    });
    assert.equal(config().models.find((model) => model.id === 'deepseek-like').capabilitySnapshot, undefined);
    assert.equal(probeState(store).status, 'failed');
    assert.match(probeState(store).message, /接口地址改了/);

    config().baseUrl = baseUrl;
    const snapshot = snapshotFixture(baseUrl, 'deepseek-like', TESTED);
    config().models.find((model) => model.id === 'deepseek-like').capabilitySnapshot = snapshot;
    store.requestModelsForActiveConfig();
    store.addFetchedModelsToConfig([{ id: 'deepseek-like', name: '类 DeepSeek（新名字）' }, { id: 'new-model', name: 'new-model' }]);
    const kept = config().models.find((model) => model.id === 'deepseek-like');
    assert.equal(kept.name, '类 DeepSeek（新名字）');
    assert.deepEqual(kept.capabilitySnapshot, snapshot);
  });
});
