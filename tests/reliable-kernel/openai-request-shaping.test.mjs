import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  createLlmProviderCapability,
  dryRunCompactLlmProvider,
  dryRunLlmProvider
} from '../../dist/extension/backend/capabilities/llmProvider.js';

function responsesSettings(baseUrl, overrides = {}) {
  return {
    id: 'shaping-provider', name: 'Shaping', provider: 'openai-responses', baseUrl, model: 'gpt-5.5', models: [],
    apiKey: 'dummy-test-key', toolCallFormat: 'function-call', openaiResponsesTransport: 'http', stream: true,
    retryOnError: false, retryMaxAttempts: 0, retryDelaySeconds: 0, enableMultimodalTools: true, systemPromptPrefix: '',
    promptCache: { enabled: true, mode: 'key', ttl: '30m' }, modelConfigs: [], createdAt: 1, updatedAt: 1,
    ...overrides
  };
}

function nativeCompactRequest(id = 'compact-request') {
  return {
    id, blockId: `${id}-block`, conversationId: 'shaping-conversation', methodKind: 'provider_native',
    methodConfigSnapshot: { id: 'native', name: 'Native', kind: 'provider_native', trigger: { mode: 'manual' }, llmSummary: { targetTokens: 1000 }, createdAt: 1, updatedAt: 1 },
    contents: [
      { role: 'user', parts: [{ text: 'Remember MARKER=42.' }] },
      { role: 'model', parts: [{ text: 'MARKER=42.' }] }
    ],
    tools: []
  };
}

// https://developers.openai.com/api/reference/resources/responses/methods/compact：Body Parameters 只有这些字段。
const COMPACT_FIELDS = new Set(['model', 'input', 'instructions', 'previous_response_id', 'prompt_cache_key',
  'prompt_cache_options', 'prompt_cache_retention', 'service_tier']);

const CHAT_REQUEST_BODY = {
  context_management: [{ type: 'compaction', compact_threshold: 200000 }],
  truncation: 'auto',
  store: false,
  reasoning: { effort: 'high' },
  include: ['reasoning.encrypted_content'],
  text: { verbosity: 'low' },
  service_tier: 'flex',
  prompt_cache_retention: '24h'
};

test('C5 compact dry-run：渠道 requestBody 只把官方允许的字段并入 /responses/compact', async () => {
  const settings = responsesSettings('https://api.openai.com/v1', { requestBody: CHAT_REQUEST_BODY });
  const result = await dryRunCompactLlmProvider(nativeCompactRequest(), { settings: async () => settings, compressionSettings: async () => undefined });
  assert.equal(result.kind, 'provider_requests');
  const call = result.calls[0];
  assert.match(call.url, /\/responses\/compact$/);
  const body = JSON.parse(call.bodyText);
  for (const key of Object.keys(body)) assert.ok(COMPACT_FIELDS.has(key), `unexpected compact field ${key}`);
  assert.equal(body.model, 'gpt-5.5');
  assert.equal(body.service_tier, 'flex');
  assert.equal(body.prompt_cache_retention, '24h');
  assert.equal(typeof body.prompt_cache_key, 'string');
  assert.ok(Array.isArray(body.input));
  assert.equal(body.context_management, undefined);
  assert.equal(body.reasoning, undefined);
});

test('C5 compact dry-run：只含允许字段的 requestBody 行为不变', async () => {
  const requestBody = { service_tier: 'priority', prompt_cache_key: 'fixed-key' };
  const settings = responsesSettings('https://api.openai.com/v1', { requestBody });
  const result = await dryRunCompactLlmProvider(nativeCompactRequest('compact-allowed'), { settings: async () => settings, compressionSettings: async () => undefined });
  const body = JSON.parse(result.calls[0].bodyText);
  assert.deepEqual(Object.keys(body).sort(), ['input', 'model', 'prompt_cache_key', 'service_tier']);
  assert.equal(body.prompt_cache_key, 'fixed-key');
  assert.equal(body.service_tier, 'priority');
});

async function withServer(respond, run) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
    calls.push(call);
    const result = respond(call);
    res.writeHead(result.status ?? 200, { 'content-type': result.sse ? 'text/event-stream' : 'application/json' });
    res.end(result.sse ?? JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/v1`, calls);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('C5 原生压缩：不再因为渠道的 context_management 得到 400 Unknown parameter', async () => {
  await withServer((call) => {
    const unknown = Object.keys(call.body).find((key) => !COMPACT_FIELDS.has(key));
    if (unknown) return { status: 400, body: { error: { message: `Unknown parameter: '${unknown}'.`, type: 'invalid_request_error', param: unknown, code: 'unknown_parameter' } } };
    return { body: { id: 'resp_compact', object: 'response.compaction', created_at: 1,
      output: [{ id: 'cmp_1', type: 'compaction', encrypted_content: 'opaque-compaction' }], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } };
  }, async (baseUrl, calls) => {
    const settings = responsesSettings(baseUrl, { requestBody: CHAT_REQUEST_BODY, promptCache: { enabled: false, mode: 'key', ttl: '30m' } });
    const capability = createLlmProviderCapability({ settings: async () => settings, compressionSettings: async () => undefined });
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('compact timed out')), 10_000);
        capability.compact(nativeCompactRequest('compact-live'), (event) => {
          if (event.type !== 'llm:compactDone' && event.type !== 'llm:compactError') return;
          clearTimeout(timer);
          resolve(event);
        });
      });
      assert.equal(result.type, 'llm:compactDone', JSON.stringify(result.payload));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].path, '/v1/responses/compact');
      assert.deepEqual(Object.keys(calls[0].body).sort(), ['input', 'model', 'prompt_cache_retention', 'service_tier']);
    } finally {
      capability.dispose();
    }
  });
});

test('C5 普通 /responses 请求仍然带渠道 requestBody', async () => {
  const settings = responsesSettings('https://api.openai.com/v1', { requestBody: CHAT_REQUEST_BODY });
  const dry = await dryRunLlmProvider({ id: 'chat', conversationId: 'shaping-conversation', contents: [{ role: 'user', parts: [{ text: 'hi' }] }], tools: [] }, { settings: async () => settings });
  assert.deepEqual(dry.body.context_management, CHAT_REQUEST_BODY.context_management);
  assert.equal(dry.body.truncation, 'auto');
});

// C6：https://developers.openai.com/api/docs/guides/prompt-caching#summary-of-model-differences
// 显式断点与 prompt_cache_options 只支持 GPT-5.6 及之后；实测 gpt-5.5 返回 400。
const hasBreakpoint = (value) => JSON.stringify(value).includes('prompt_cache_breakpoint');

async function responsesDryRun(model, mode, overrides = {}) {
  const settings = responsesSettings('https://api.openai.com/v1', { model, promptCache: { enabled: true, mode, ttl: '30m' }, ...overrides });
  return (await dryRunLlmProvider({ id: `cache-${model}-${mode}`, conversationId: 'shaping-conversation',
    systemInstruction: { role: 'user', parts: [{ text: 'stable instructions' }] },
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }], tools: [] }, { settings: async () => settings })).body;
}

test('C6 显式缓存：只对 GPT-5.6+ 与 GPT-6 家族的精确 id 发送，其他模型退回 key 模式', async () => {
  for (const model of ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-2026-10-01', 'GPT-6-SOL']) {
    const body = await responsesDryRun(model, 'explicit');
    assert.deepEqual(body.prompt_cache_options, { mode: 'explicit', ttl: '30m' }, model);
    assert.ok(hasBreakpoint(body.input), model);
    assert.equal(typeof body.prompt_cache_key, 'string', model);
  }
  for (const model of ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.6-preview', 'openai/gpt-5.6', 'gpt-6', 'custom-model']) {
    const explicit = await responsesDryRun(model, 'explicit');
    assert.equal(explicit.prompt_cache_options, undefined, model);
    assert.equal(hasBreakpoint(explicit), false, model);
    assert.equal(typeof explicit.prompt_cache_key, 'string', model);
    // 退回后与 key 模式的请求逐字节相同。
    assert.deepEqual(explicit, await responsesDryRun(model, 'key'), model);
  }
});

test('C6 key 模式与关闭缓存的请求保持不变', async () => {
  const key = await responsesDryRun('gpt-5.6', 'key');
  assert.equal(key.prompt_cache_options, undefined);
  assert.equal(hasBreakpoint(key), false);
  const disabled = await responsesDryRun('gpt-5.6', 'explicit', { promptCache: { enabled: false, mode: 'explicit', ttl: '30m' } });
  assert.equal(disabled.prompt_cache_options, undefined);
  assert.equal(disabled.prompt_cache_key, undefined);
});

// C7：https://developers.openai.com/api/docs/guides/latest-model/gpt-6-astra.md “Update API and model parameters”。
function compatibleSettings(model, overrides = {}) {
  return responsesSettings('https://gateway.example/v1', { id: `compat-${model}`, provider: 'openai-compatible', model,
    promptCache: { enabled: false, mode: 'key', ttl: '30m' }, ...overrides });
}

async function compatibleDryRun(settings) {
  return (await dryRunLlmProvider({ id: `compat-${settings.model}`, conversationId: 'shaping-conversation',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }], tools: [] }, { settings: async () => settings })).body;
}

const SAMPLING_GENERATION = { temperature: 0.3, topP: 0.9, maxOutputTokens: 512 };
const SAMPLING_BODY = { temperature: 0.5, top_p: 0.8, top_logprobs: 2, logprobs: true, include: ['message.output_text.logprobs'], other: 'keep' };

test('C7 openai-compatible 上的 Astra：去掉 temperature/top_p/top_logprobs/logprobs，none/minimal 提升为 low', async () => {
  for (const [level, expected] of [['none', 'low'], ['minimal', 'low'], ['high', 'high']]) {
    const body = await compatibleDryRun(compatibleSettings('gpt-6-astra', {
      generationConfig: { ...SAMPLING_GENERATION, thinkingConfig: { thinkingLevel: level } },
      requestBody: SAMPLING_BODY
    }));
    for (const key of ['temperature', 'top_p', 'top_logprobs', 'logprobs']) assert.equal(body[key], undefined, `${level}:${key}`);
    assert.equal(body.reasoning_effort, expected, level);
    assert.equal(body.max_tokens, 512);
    assert.equal(body.other, 'keep');
    assert.deepEqual(body.include, ['message.output_text.logprobs'], 'Chat Completions 没有 include，保持用户配置不动');
  }
  const dated = await compatibleDryRun(compatibleSettings('gpt-6-astra-2026-09-01', { generationConfig: SAMPLING_GENERATION }));
  assert.equal(dated.temperature, undefined);
});

test('C7 非 Astra 的 openai-compatible 请求保持不变（含支持 none 的 Sol/Luna）', async () => {
  for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.5', 'gpt-6-astra-preview', 'claude-sonnet-5']) {
    const body = await compatibleDryRun(compatibleSettings(model, {
      generationConfig: { ...SAMPLING_GENERATION, thinkingConfig: { thinkingLevel: 'none' } },
      requestBody: SAMPLING_BODY
    }));
    assert.equal(body.temperature, 0.5, model);
    assert.equal(body.top_p, 0.8, model);
    assert.equal(body.top_logprobs, 2, model);
    assert.equal(body.logprobs, true, model);
    assert.equal(body.reasoning_effort, 'none', model);
  }
});

test('C7 Responses 上的 Astra 适配保持原样', async () => {
  const body = (await dryRunLlmProvider({ id: 'responses-astra', conversationId: 'shaping-conversation',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }], tools: [] }, { settings: async () => responsesSettings('https://api.openai.com/v1', {
    model: 'gpt-6-astra', promptCache: { enabled: false, mode: 'key', ttl: '30m' },
    generationConfig: { ...SAMPLING_GENERATION, thinkingConfig: { thinkingLevel: 'none' } },
    requestBody: { ...SAMPLING_BODY, include: ['reasoning.encrypted_content', 'message.output_text.logprobs'] }
  }) })).body;
  for (const key of ['temperature', 'top_p', 'top_logprobs', 'logprobs']) assert.equal(body[key], undefined, key);
  assert.equal(body.reasoning.effort, 'low');
  assert.equal(body.include.includes('message.output_text.logprobs'), false);
});
