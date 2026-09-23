// GPT-6 家族（Astra / Sol / Luna）适配。依据 OpenAI 官方文档：
// - Using GPT-6：https://developers.openai.com/api/docs/guides/latest-model
// - 模型页：https://developers.openai.com/api/docs/models/gpt-6-astra、gpt-6-sol、gpt-6-luna
// - 推理：https://developers.openai.com/api/docs/guides/reasoning（Reasoning mode；Change reasoning mid-conversation）
// - 提示缓存：https://developers.openai.com/api/docs/guides/prompt-caching#summary-of-model-differences
// - 异步工具：https://developers.openai.com/api/docs/guides/async-tool-calling（Compatibility）
// - 转向：https://developers.openai.com/api/docs/guides/steering
// 只认官方精确 id 及其日期快照；网关别名不外推。不做网关实测，只用单元与 dry-run 验证。
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const capabilities = require(path.join(compiledRoot, 'shared/openAIResponsesCapabilities.js'));
const { dryRunLlmProvider } = require(path.join(compiledRoot, 'backend/capabilities/llmProvider.js'));

const FAMILY = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'];
const DATED_FAMILY = ['gpt-6-astra-2026-09-01', 'gpt-6-sol-2026-05-01', 'gpt-6-luna-2026-06-01'];
const GPT56 = ['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
// 网关别名、未发布名称与更早的模型：一律不按 GPT-6 家族处理。
const NOT_FAMILY = [
  'gpt-6-sol-xhigh', 'gpt-6-astra-xhigh', 'gpt-6-astra-max', '[az]gpt-6-astra-xhigh', '[az]gpt-6-luna',
  'gpt-6-astra-pro', 'gpt-6-astra-preview', 'gpt-6', 'gpt-6-sol-20260501', 'openai/gpt-6-sol',
  'gpt-5.6-sol', 'gpt-5.6', 'gpt-5.5', 'gpt-5.4', 'claude-opus-5-5', 'gemini-3.8-flash', '', undefined
];
const OFFICIAL = 'https://api.openai.com/v1';

function providerConfig(overrides = {}) {
  const model = overrides.model ?? 'gpt-6-sol';
  return {
    id: 'gpt6-family-provider', name: 'GPT-6 family', provider: 'openai-responses', baseUrl: OFFICIAL,
    model, models: [{ id: model, name: model }], apiKey: 'sk-test-secret-1234', toolCallFormat: 'function-call',
    openaiResponsesTransport: 'http', stream: true, retryOnError: false, retryMaxAttempts: 0,
    enableMultimodalTools: true, systemPromptPrefix: '', promptCache: { enabled: false, mode: 'key', ttl: '30m' },
    modelConfigs: [], createdAt: 1, updatedAt: 1,
    ...overrides
  };
}

function chatRequest(id, overrides = {}) {
  return {
    id, invocationId: `invocation-${id}`, conversationId: 'conversation-gpt6', tools: [],
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    ...overrides
  };
}

test('模型族识别：只认 gpt-6-astra / gpt-6-sol / gpt-6-luna 及日期快照', () => {
  const { gpt6ModelVariant, isGpt6FamilyModel, isGpt6NoneCapableModel, isAstraModel } = capabilities;
  assert.deepEqual(FAMILY.map(gpt6ModelVariant), ['astra', 'sol', 'luna']);
  assert.deepEqual(DATED_FAMILY.map(gpt6ModelVariant), ['astra', 'sol', 'luna']);
  assert.deepEqual([' GPT-6-Sol ', 'Gpt-6-Luna'].map(gpt6ModelVariant), ['sol', 'luna']);
  for (const model of NOT_FAMILY) {
    assert.equal(gpt6ModelVariant(model), undefined, String(model));
    assert.equal(isGpt6FamilyModel(model), false, String(model));
  }
  // Sol、Luna 支持 none；Astra 不支持（Using GPT-6 “Limitations”）。
  assert.deepEqual(FAMILY.map(isGpt6NoneCapableModel), [false, true, true]);
  // isAstraModel 保持原语义：Sol、Luna 不是 Astra。
  assert.deepEqual(FAMILY.map(isAstraModel), [true, false, false]);
});

test('显式缓存与推理模式：GPT-5.6 及之后的官方 id（含日期快照）', () => {
  const { supportsOpenAIExplicitPromptCache, supportsOpenAIReasoningMode } = capabilities;
  for (const model of [...GPT56, ...FAMILY, ...DATED_FAMILY, 'gpt-5.6-2026-04-01']) {
    assert.equal(supportsOpenAIExplicitPromptCache(model), true, model);
    assert.equal(supportsOpenAIReasoningMode(model), true, model);
  }
  for (const model of ['gpt-5.5', 'gpt-5.5-pro', 'gpt-5.4', 'gpt-5.6-preview', 'gpt-5.6-pro', 'gpt-5.6-sol-xhigh',
    '[az]gpt-5.6-sol', 'openai/gpt-5.6', 'gpt-6', 'gpt-6-sol-xhigh', 'gpt-6-astra-pro', '', undefined]) {
    assert.equal(supportsOpenAIExplicitPromptCache(model), false, String(model));
    assert.equal(supportsOpenAIReasoningMode(model), false, String(model));
  }
});

test('原生能力：Sol、Luna 与 Astra 同一门禁矩阵（官方渠道 / 显式 enabled / 传输 / 子开关）', () => {
  const { openAIResponsesNativeCapabilities: native } = capabilities;
  for (const model of [...FAMILY, ...DATED_FAMILY]) {
    const base = { provider: 'openai-responses', model, transport: 'websocket' };
    assert.deepEqual(native({ ...base, baseUrl: OFFICIAL }), {
      asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: true, explicitCaching: true
    }, model);
    assert.deepEqual(native({ ...base, transport: 'http', baseUrl: OFFICIAL }), {
      asyncTools: true, steering: false, reasoningUpdates: true, multiplexing: false, explicitCaching: true
    }, model);
    for (const flags of [undefined, {}]) {
      assert.deepEqual(native({ ...base, baseUrl: 'https://relay.example/v1', nativeResponses: flags }), {
        asyncTools: false, steering: false, reasoningUpdates: false, multiplexing: false, explicitCaching: false
      }, model);
    }
    assert.equal(native({ ...base, baseUrl: 'https://relay.example/v1', nativeResponses: { enabled: true } }).steering, true);
    assert.equal(native({ ...base, baseUrl: OFFICIAL, nativeResponses: { enabled: false } }).asyncTools, false);
    const partial = native({ ...base, baseUrl: OFFICIAL, nativeResponses: { asyncTools: false, multiplexing: false } });
    assert.deepEqual(partial, {
      asyncTools: false, steering: true, reasoningUpdates: true, multiplexing: false, explicitCaching: true
    }, model);
    // 官方：configuration_update 只支持 standard 模式；pro 模式关闭动态推理更新，其余不变。
    assert.deepEqual(native({ ...base, baseUrl: OFFICIAL, reasoningMode: 'pro' }), {
      asyncTools: true, steering: true, reasoningUpdates: false, multiplexing: true, explicitCaching: true
    }, model);
    assert.equal(native({ ...base, baseUrl: OFFICIAL, reasoningMode: 'standard' }).reasoningUpdates, true);
    // openai-compatible（Chat Completions）没有原生能力。
    assert.equal(native({ ...base, provider: 'openai-compatible', baseUrl: OFFICIAL }).asyncTools, false);
  }
});

test('原生能力：网关别名与其他模型一律关闭', () => {
  const { openAIResponsesNativeCapabilities: native } = capabilities;
  for (const model of NOT_FAMILY) {
    for (const nativeResponses of [undefined, { enabled: true }]) {
      assert.deepEqual(native({ provider: 'openai-responses', model, transport: 'websocket', baseUrl: OFFICIAL, nativeResponses }), {
        asyncTools: false, steering: false, reasoningUpdates: false, multiplexing: false, explicitCaching: false
      }, String(model));
    }
  }
});

test('dry-run：Sol / Luna 在官方渠道按 per-tool 声明编码 async:true；其他模型不编码', async () => {
  const tools = [
    { name: 'probe', description: 'd', parameters: { type: 'object', properties: {} }, async: true },
    { name: 'sync_tool', description: 'd', parameters: { type: 'object', properties: {} } }
  ];
  for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-luna-2026-06-01']) {
    const body = (await dryRunLlmProvider(chatRequest(`async-${model}`, { tools }), {
      settings: async () => providerConfig({ model })
    })).body;
    assert.equal(body.tools.find((tool) => tool.name === 'probe').async, true, model);
    assert.equal('async' in body.tools.find((tool) => tool.name === 'sync_tool'), false, model);
  }
  for (const model of ['gpt-5.6', 'gpt-5.5', 'gpt-6-sol-xhigh']) {
    const body = (await dryRunLlmProvider(chatRequest(`async-${model}`, { tools }), {
      settings: async () => providerConfig({ model })
    })).body;
    assert.equal('async' in body.tools.find((tool) => tool.name === 'probe'), false, model);
  }
  // 中继渠道仍需显式 enabled。
  const relay = (await dryRunLlmProvider(chatRequest('async-relay', { tools }), {
    settings: async () => providerConfig({ baseUrl: 'https://relay.example/v1' })
  })).body;
  assert.equal('async' in relay.tools.find((tool) => tool.name === 'probe'), false);
});
