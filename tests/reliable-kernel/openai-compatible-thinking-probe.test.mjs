import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// 渠道配置与路由模块在加载时引用 vscode；这里只用到它们的纯函数，给一个空桩。
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  return request === 'vscode' ? {} : originalLoad.call(this, request, ...rest);
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
