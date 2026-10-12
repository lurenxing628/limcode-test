import assert from 'node:assert/strict';

import http from 'node:http';

import test from 'node:test';

import { createLlmProviderCapability, dryRunCompactLlmProvider, dryRunLlmProvider, probeLlmProviderNativeCompaction }
  from '../../../dist/extension/backend/capabilities/llmProvider.js';

import { resolveModelCapabilities, resolveSummaryReasoning } from '../../../dist/extension/shared/modelCapabilities.js';

import { resolveSummaryOutputBudget } from '../../../dist/extension/shared/summaryOutputBudget.js';

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

function registerCases(test) {

test('summary output budget reserves reasoning, preserves explicit limits, and rejects impossible budgets', () => {
  assert.equal(resolveSummaryOutputBudget(1000), 8192);
  assert.equal(resolveSummaryOutputBudget(2000, { thinkingConfig: { thinkingBudget: 10000 } }), 13024);
  assert.equal(resolveSummaryOutputBudget(1000, { maxOutputTokens: 2048 }), 2048);
  assert.throws(() => resolveSummaryOutputBudget(1000, { maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 2048 } }));
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
}

export { registerCases };
