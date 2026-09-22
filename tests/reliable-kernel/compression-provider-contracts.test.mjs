import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createLlmProviderCapability, dryRunCompactLlmProvider, dryRunLlmProvider, probeLlmProviderNativeCompaction }
  from '../../dist/extension/backend/capabilities/llmProvider.js';
import { resolveModelCapabilities, resolveSummaryReasoning } from '../../dist/extension/shared/modelCapabilities.js';
import { resolveSummaryOutputBudget } from '../../dist/extension/shared/summaryOutputBudget.js';

function provider(kind, baseUrl, model) {
  return { id: 'contract-provider', name: 'Contract', provider: kind, baseUrl, model, models: [{ id: model, name: model }],
    apiKey: 'dummy-test-key', toolCallFormat: 'function-call', openaiResponsesTransport: 'http', stream: false,
    retryOnError: false, retryMaxAttempts: 0, retryDelaySeconds: 0, enableMultimodalTools: true,
    contextWindowTokens: 65536, systemPromptPrefix: '', promptCache: { enabled: false, mode: 'key', ttl: '30m' },
    modelConfigs: [], createdAt: 1, updatedAt: 1 };
}
function request(kind = 'llm_summary', generationConfig) {
  return { id: 'contract-request', blockId: 'contract-block', conversationId: 'contract-conversation', methodKind: kind,
    methodConfigSnapshot: { id: 'contract-method', name: 'Contract summary', kind, trigger: { mode: 'manual' },
      llmSummary: { targetTokens: 1000, reasoning: { mode: 'provider_default' }, ...(generationConfig ? { generationConfig } : {}) },
      createdAt: 1, updatedAt: 1 },
    contents: [{ role: 'user', parts: [{ text: 'Preserve ORIGINAL_HISTORY_MARKER=42.' }] }] };
}
const options = (settings) => ({ settings: async () => settings, compressionSettings: async () => undefined });
async function bodyOf(req, settings) {
  const result = await dryRunCompactLlmProvider(req, options(settings));
  assert.equal(result.kind, 'provider_requests');
  return { body: JSON.parse(result.calls[0].bodyText), call: result.calls[0] };
}
async function serverFixture(run, response) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const record = { path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
    calls.push(record);
    const result = await response(record, calls.length);
    res.writeHead(result.status ?? 200, { 'content-type': result.sse ? 'text/event-stream' : 'application/json' });
    res.end(result.sse ?? JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base, calls); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}
async function compact(settings, req) {
  const capability = createLlmProviderCapability(options(settings));
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Contract compact timed out')), 10000);
      capability.compact(req, (event) => {
        if (event.type !== 'llm:compactDone' && event.type !== 'llm:compactError') return;
        clearTimeout(timer); resolve(event);
      });
    });
  } finally { capability.dispose(); }
}

for (const [kind, endpoint, model] of [
  ['openai-responses', 'https://api.openai.com/v1', 'gpt-5.4'],
  ['openai-compatible', 'https://gateway.example/v1', 'custom-model'],
  ['claude', 'https://api.anthropic.com/v1', 'claude-opus-4-6'],
  ['gemini', 'https://generativelanguage.googleapis.com/v1beta', 'gemini-2.5-pro']
]) {
  test(`${kind}: actual summary encoder omits chat reasoning and sampling overrides`, async () => {
    const settings = { ...provider(kind, endpoint, model), generationConfig: { thinkingConfig: { thinkingLevel: 'high' }, temperature: 0.9 },
      requestBody: { reasoning: { effort: 'high' }, reasoning_effort: 'high', thinking: { type: 'adaptive' }, max_tokens: 2,
        temperature: 0.7, generationConfig: { thinkingConfig: { thinkingBudget: 20000 } } } };
    const { body } = await bodyOf(request(), settings);
    assert.equal(body.reasoning, undefined); assert.equal(body.reasoning_effort, undefined); assert.equal(body.thinking, undefined);
    assert.equal(body.generationConfig?.thinkingConfig, undefined); assert.equal(body.temperature, undefined);
    assert.ok((body.max_tokens ?? body.max_output_tokens ?? body.generationConfig?.maxOutputTokens) >= 8192);
  });
}

test('Claude 4.5 extended budget survives the real encoder without adaptive thinking', async () => {
  const settings = provider('claude', 'https://api.anthropic.com', 'claude-sonnet-4-5');
  const req = request('llm_summary', { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 2048 } });
  req.methodConfigSnapshot.llmSummary.reasoning.mode = 'explicit';
  const { body } = await bodyOf(req, settings);
  assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 2048 });
  assert.equal(body.output_config?.effort, undefined);
});

test('Google compatible explicit budget uses extra_body and never overlaps reasoning_effort', async () => {
  const settings = provider('openai-compatible', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.5-pro');
  const req = request('llm_summary', { thinkingConfig: { thinkingBudget: 8192 } });
  req.methodConfigSnapshot.llmSummary.reasoning.mode = 'explicit';
  const { body } = await bodyOf(req, settings);
  assert.equal(body.reasoning_effort, undefined);
  assert.deepEqual(body.extra_body.google.thinking_config, { thinking_budget: 8192 });
});

test('Google compatible thought visibility survives the encoder alongside effort without a second budget or level', async () => {
  for (const [model, includeThoughts] of [['gemini-2.5-pro', true], ['gemini-3.8-flash', false]]) {
    const settings = provider('openai-compatible', 'https://generativelanguage.googleapis.com/v1beta/openai', model);
    const req = request('llm_summary', { thinkingConfig: { thinkingLevel: 'high', includeThoughts } });
    req.methodConfigSnapshot.llmSummary.reasoning.mode = 'explicit';
    const { body } = await bodyOf(req, settings);
    assert.equal(body.reasoning_effort, 'high');
    assert.deepEqual(body.extra_body?.google?.thinking_config, { include_thoughts: includeThoughts });
  }
});

test('summary output budget reserves reasoning, preserves explicit limits, and rejects impossible budgets', () => {
  assert.equal(resolveSummaryOutputBudget(1000), 8192);
  assert.equal(resolveSummaryOutputBudget(2000, { thinkingConfig: { thinkingBudget: 10000 } }), 13024);
  assert.equal(resolveSummaryOutputBudget(1000, { maxOutputTokens: 2048 }), 2048);
  assert.throws(() => resolveSummaryOutputBudget(1000, { maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 2048 } }));
});

test('keyless local summary makes a real request; empty output is an error rather than hidden deterministic success', async () => {
  await serverFixture(async (base, calls) => {
    const settings = { ...provider('openai-compatible', `${base}/v1`, 'local-model'), apiKey: '' };
    const result = await compact(settings, request());
    assert.equal(calls.length, 1);
    assert.equal(result.type, 'llm:compactError');
    assert.match(JSON.stringify(result.payload), /no visible summary|empty/i);
  }, () => ({ body: { id: 'empty', object: 'chat.completion', model: 'local-model',
    choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 0, total_tokens: 20 } } }));
});

test('Claude on-demand compaction carries frozen system/tools/thinking and preserves the signed block', async () => {
  const signed = { type: 'compaction', content: 'ORIGINAL_HISTORY_MARKER=42', signature: 'signed-test-token' };
  await serverFixture(async (base, calls) => {
    const settings = provider('claude', `${base}/v1`, 'claude-opus-4-6');
    const req = request('provider_native');
    req.systemInstruction = { role: 'user', parts: [{ text: 'FROZEN_SYSTEM' }] };
    req.tools = [{ functionDeclarations: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } }] }];
    req.nativeGenerationConfig = { maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'medium' } };
    req.nativeRequestBody = {};
    const result = await compact(settings, req);
    assert.equal(result.type, 'llm:compactDone', JSON.stringify(result));
    assert.equal(calls[0].path, '/v1/messages');
    assert.match(calls[0].headers['anthropic-beta'], /compact-2026-09-04/);
    assert.equal(calls[0].body.compaction.type, 'summarize');
    assert.equal(calls[0].body.output_config.effort, 'medium');
    assert.match(JSON.stringify(calls[0].body.system), /FROZEN_SYSTEM/);
    assert.equal(calls[0].body.tools[0].name, 'read');
    const contents = result.payload.result.contents;
    assert.deepEqual(contents[0].parts[0].providerContext.rawItem, signed);
    const replay = await dryRunLlmProvider({ id: 'replay', conversationId: 'contract-conversation', contents: [...contents,
      { role: 'user', parts: [{ text: 'Continue.' }] }], tools: [] }, options(settings));
    const body = JSON.parse(replay.bodyText);
    assert.deepEqual(body.messages[0].content[0], signed);
    assert.match(JSON.stringify(replay.headers), /compact-2026-09-04/);
  }, () => ({ body: { id: 'compacted', type: 'message', role: 'assistant', stop_reason: 'compaction', content: [signed],
    usage: { input_tokens: 0, output_tokens: 0, iterations: [{ input_tokens: 100, output_tokens: 20 }] } } }));
});

test('manual native probe uses synthetic contents only; a 404 is exact negative capability evidence', async () => {
  await serverFixture(async (base, calls) => {
    const settings = provider('openai-responses', `${base}/v1`, 'custom-model');
    const result = await probeLlmProviderNativeCompaction(settings, options(settings));
    assert.equal(calls.length, 1);
    assert.match(calls[0].path, /responses\/compact/);
    assert.match(JSON.stringify(calls[0].body), /verification_marker/);
    assert.doesNotMatch(JSON.stringify(calls[0].body), /ORIGINAL_HISTORY/);
    assert.equal(result.capabilitySnapshot.nativeCompaction.availability, 'unsupported');
    assert.equal(result.capabilitySnapshot.providerConfigId, settings.id);
  }, () => ({ status: 404, body: { error: { message: 'Upstream request failed', type: 'upstream_error' } } }));
});


test('streamed partial text ending at output limit is not committed as a successful summary', async () => {
  await serverFixture(async (base, calls) => {
    const settings = { ...provider('openai-compatible', `${base}/v1`, 'local-model'), stream: true };
    const result = await compact(settings, request());
    assert.equal(calls.length, 1);
    assert.equal(result.type, 'llm:compactError', 'truncated visible text must not become a replacement summary');
  }, () => ({ sse: [
    `data: ${JSON.stringify({ id: 'truncated', object: 'chat.completion.chunk', model: 'local-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Only a partial summary of' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: 'truncated', object: 'chat.completion.chunk', model: 'local-model', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })}\n\n`,
    'data: [DONE]\n\n'
  ].join('') }));
});
