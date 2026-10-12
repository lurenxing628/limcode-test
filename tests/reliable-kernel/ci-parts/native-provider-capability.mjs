import assert from 'node:assert/strict';

import http from 'node:http';

import path from 'node:path';

import test from 'node:test';

import { once } from 'node:events';

import { setTimeout as delay } from 'node:timers/promises';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');

const {
  createLlmProviderCapability,
  dryRunLlmProvider
} = require(path.join(compiledRoot, 'backend/capabilities/llmProvider.js'));

const ASTRA = 'gpt-6-astra';

function providerConfig(overrides = {}) {
  return {
    id: 'provider-openai-responses',
    name: 'OpenAI Responses',
    provider: 'openai-responses',
    baseUrl: 'https://example.test/v1',
    model: ASTRA,
    models: [{ id: ASTRA, name: 'Astra' }],
    apiKey: 'sk-test-secret-1234',
    toolCallFormat: 'function-call',
    openaiResponsesTransport: 'http',
    stream: true,
    retryOnError: false,
    retryMaxAttempts: 0,
    enableMultimodalTools: true,
    promptCache: { enabled: false, mode: 'key', ttl: '30m' },
    modelConfigs: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function chatRequest(id, overrides = {}) {
  return {
    id,
    invocationId: `invocation-${id}`,
    conversationId: 'conversation-native',
    contents: [{ role: 'user', parts: [{ text: 'Hello Astra' }] }],
    tools: [],
    ...overrides
  };
}

function registerCases(test) {

test('dry-run：冻结的普通/原生会话资格优先于当前渠道开关，不能在重试时重新分类', async () => {
  const tools = [{ name: 'probe', description: 'd', parameters: { type: 'object', properties: {} }, async: true }];
  const ordinary = await dryRunLlmProvider(chatRequest('frozen-ordinary', { tools, nativeSessionCapabilities: null }), {
    settings: async () => providerConfig({ nativeResponses: { enabled: true } })
  });
  assert.equal('async' in ordinary.body.tools[0], false);
  const capabilities = { asyncTools: true, steering: false, reasoningUpdates: true, multiplexing: false, explicitCaching: true };
  const native = await dryRunLlmProvider(chatRequest('frozen-native', { tools, nativeSessionCapabilities: capabilities }), {
    settings: async () => providerConfig({ nativeResponses: { enabled: false } })
  });
  assert.equal(native.body.tools[0].async, true);
});
}

export { registerCases };
