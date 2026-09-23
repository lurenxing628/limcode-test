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
