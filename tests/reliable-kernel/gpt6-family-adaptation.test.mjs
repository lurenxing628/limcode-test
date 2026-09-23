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
const modelCapabilities = require(path.join(compiledRoot, 'shared/modelCapabilities.js'));
const sessionThinking = require(path.join(compiledRoot, 'shared/sessionThinking.js'));
const { dryRunLlmProvider } = require(path.join(compiledRoot, 'backend/capabilities/llmProvider.js'));

/** 用 esbuild 把 webview 源码模块打成 CJS 在 Node 里加载（与 tests/openAIResponsesWebSocket.test.cjs 相同做法）。 */
function loadWebviewModule(relativeEntry) {
  const Module = require('node:module');
  const esbuild = require('esbuild');
  const root = path.resolve('.');
  const result = esbuild.buildSync({
    entryPoints: [path.join(root, relativeEntry)], absWorkingDir: root, bundle: true, write: false,
    platform: 'node', format: 'cjs', target: 'node18', tsconfig: path.join(root, 'tsconfig.webview.json'), logLevel: 'silent'
  });
  const filename = path.join(root, `.test-gpt6-${path.basename(relativeEntry)}.cjs`);
  const compiled = new Module(filename);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(root);
  compiled._compile(result.outputFiles[0].text, filename);
  return compiled.exports;
}

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

const officialCapability = (modelId, provider = 'openai-responses') => modelCapabilities.resolveModelCapabilities({
  provider, modelId, baseUrl: OFFICIAL, providerConfigId: 'channel', transport: 'http'
});

test('推理强度表：Astra 为 low…max 且不支持 none、官方未写默认值；Sol / Luna 为 none…max、默认 medium', () => {
  for (const provider of ['openai-responses', 'openai-compatible']) {
    for (const model of ['gpt-6-astra', 'gpt-6-astra-2026-09-01']) {
      assert.deepEqual(officialCapability(model, provider).reasoning, {
        family: 'openai_effort', levels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsBudget: false,
        canDisable: false, alwaysOn: true, outputLimitIncludesThinking: true, requiresThoughtSignatures: true
      }, `${provider}:${model}`);
    }
    for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-sol-2026-05-01']) {
      assert.deepEqual(officialCapability(model, provider).reasoning, {
        family: 'openai_effort', levels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'medium',
        supportsBudget: false, canDisable: true, alwaysOn: false, outputLimitIncludesThinking: true, requiresThoughtSignatures: true
      }, `${provider}:${model}`);
    }
  }
  // gpt-6-astra-pro 不是官方模型 id（pro 是 reasoning.mode），与网关别名一样按未知处理。
  for (const model of ['gpt-6-astra-pro', 'gpt-6-sol-xhigh', 'gpt-6']) {
    assert.equal(officialCapability(model).reasoning.family, 'none', model);
  }
});

test('推理强度表：其他 OpenAI 模型的能力快照逐字节不变', () => {
  const expected = {
    'gpt-5': ['minimal', 'low', 'medium', 'high'],
    'gpt-5-mini': ['minimal', 'low', 'medium', 'high'],
    'gpt-5.1': ['none', 'low', 'medium', 'high'],
    'gpt-5.2': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.4-2026-03-05': ['none', 'low', 'medium', 'high', 'xhigh']
  };
  for (const [model, levels] of Object.entries(expected)) {
    const none = levels.includes('none');
    assert.equal(JSON.stringify(officialCapability(model).reasoning), JSON.stringify({
      family: 'openai_effort', levels, supportsBudget: false, canDisable: none, alwaysOn: !none,
      outputLimitIncludesThinking: true, requiresThoughtSignatures: true
    }), model);
  }
  for (const model of ['gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol']) assert.equal(officialCapability(model).reasoning.family, 'none', model);
});

test('摘要推理预设按新表映射：Astra maximum → max、不能关闭；Sol / Luna 可以关闭', () => {
  const reason = (model, mode, thinkingConfig) => modelCapabilities.resolveSummaryReasoning({
    capabilities: officialCapability(model), mode,
    methodGenerationConfig: thinkingConfig ? { thinkingConfig } : undefined,
    inheritedGenerationConfig: { thinkingConfig: { thinkingLevel: 'high' } }
  });
  assert.deepEqual(reason('gpt-6-astra', 'maximum').requestBody, { reasoning: { effort: 'max' } });
  assert.deepEqual(reason('gpt-6-astra', 'economy').requestBody, { reasoning: { effort: 'low' } });
  assert.equal(reason('gpt-6-astra', 'disabled').status, 'unsupported');
  assert.equal(reason('gpt-6-astra', 'explicit', { thinkingLevel: 'none' }).status, 'unsupported');
  assert.equal(reason('gpt-6-astra', 'explicit', { thinkingLevel: 'xhigh' }).status, 'applied');
  for (const model of ['gpt-6-sol', 'gpt-6-luna']) {
    assert.deepEqual(reason(model, 'disabled').requestBody, { reasoning: { effort: 'none' } }, model);
    assert.deepEqual(reason(model, 'maximum').requestBody, { reasoning: { effort: 'max' } }, model);
    assert.equal(reason(model, 'explicit', { thinkingLevel: 'minimal' }).status, 'unsupported', model);
  }
});

test('会话思考选项：Sol / Luna 在 openai-responses 与 openai-compatible 下都可选 none…max', () => {
  const { sessionThinkingCapability } = sessionThinking;
  const range = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
  for (const provider of ['openai-responses', 'openai-compatible']) {
    for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-luna-2026-06-01', 'GPT-6-Sol']) {
      assert.deepEqual(sessionThinkingCapability(provider, model), { kind: 'openai-effort', values: range }, `${provider}:${model}`);
    }
  }
  // Astra 保持原样：openai-responses 为 low…max，openai-compatible 跟随渠道配置。
  assert.deepEqual(sessionThinkingCapability('openai-responses', 'gpt-6-astra'),
    { kind: 'openai-effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] });
  assert.equal(sessionThinkingCapability('openai-compatible', 'gpt-6-astra'), undefined);
  // 网关别名与其他模型不变。
  for (const model of ['gpt-6-sol-xhigh', '[az]gpt-6-luna', 'gpt-5.6-sol']) {
    assert.equal(sessionThinkingCapability('openai-responses', model), undefined, model);
  }
  assert.deepEqual(sessionThinkingCapability('openai-responses', 'gpt-5.2'),
    { kind: 'openai-effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] });
});

test('设置界面思考强度选项按新表过滤，Sol / Luna 默认 medium', () => {
  const { parameterDefinitionsForProvider } = loadWebviewModule('webview/src/components/settings/global/parameters/llmParameterDefinitions.ts');
  const thinking = (model, provider = 'openai-responses') => parameterDefinitionsForProvider(provider, model, officialCapability(model, provider))
    .find((definition) => definition.key === 'thinkingLevel');
  const astra = thinking('gpt-6-astra');
  assert.deepEqual(astra.options.map((option) => option.value), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(astra.defaultValue, 'low');
  for (const provider of ['openai-responses', 'openai-compatible']) {
    for (const model of ['gpt-6-sol', 'gpt-6-luna']) {
      const definition = thinking(model, provider);
      assert.deepEqual(definition.options.map((option) => option.value), ['none', 'low', 'medium', 'high', 'xhigh', 'max'], model);
      assert.equal(definition.defaultValue, 'medium', model);
    }
  }
  assert.deepEqual(thinking('gpt-5.2').options.map((option) => option.value), ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(thinking('gpt-5.2').defaultValue, 'none');
});
