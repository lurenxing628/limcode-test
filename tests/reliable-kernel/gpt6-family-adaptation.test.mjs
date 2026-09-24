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
const { LlmCapabilityFullRequestAdapter } = require(path.join(compiledRoot, 'backend/reliableKernel/llmCapabilityProviderAdapter.js'));
const { LlmEventType } = require(path.join(compiledRoot, 'backend/world/modules/llm/events.js'));

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

// ---- 参数适配：Using GPT-6 “Update API and model parameters” ----
const SAMPLING_GENERATION = { temperature: 0.3, topP: 0.9, maxOutputTokens: 512 };
const SAMPLING_BODY = { top_logprobs: 2, logprobs: true, include: ['reasoning.encrypted_content', 'message.output_text.logprobs'], other: 'keep' };

async function parameterDryRun(provider, model, thinkingLevel, overrides = {}) {
  const generationConfig = { ...SAMPLING_GENERATION, ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}) };
  return (await dryRunLlmProvider(chatRequest(`params-${provider}-${model}-${thinkingLevel}`, overrides.request), {
    settings: async () => providerConfig({
      provider, model, baseUrl: provider === 'openai-compatible' ? 'https://gateway.example/v1' : OFFICIAL,
      generationConfig, requestBody: SAMPLING_BODY, ...overrides.settings
    })
  })).body;
}

const effortOf = (provider, body) => provider === 'openai-compatible' ? body.reasoning_effort : body.reasoning?.effort;

test('Sol / Luna：推理强度为 none 时保留采样参数，none 不改写', async () => {
  for (const provider of ['openai-responses', 'openai-compatible']) {
    for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-luna-2026-06-01']) {
      const body = await parameterDryRun(provider, model, 'none');
      assert.equal(effortOf(provider, body), 'none', `${provider}:${model}`);
      assert.equal(body.temperature, 0.3);
      assert.equal(body.top_p, 0.9);
      assert.equal(body.top_logprobs, 2);
      assert.equal(body.logprobs, true);
      assert.ok(body.include.includes('message.output_text.logprobs'));
      assert.equal(body.other, 'keep');
    }
  }
});

test('Sol / Luna：强度不是 none（含未设置 = 默认 medium）时去掉采样参数；minimal 提升为 low', async () => {
  for (const provider of ['openai-responses', 'openai-compatible']) {
    for (const model of ['gpt-6-sol', 'gpt-6-luna']) {
      for (const [level, expected] of [[undefined, undefined], ['not-set', undefined], ['minimal', 'low'], ['low', 'low'],
        ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']]) {
        const label = `${provider}:${model}:${level}`;
        const body = await parameterDryRun(provider, model, level);
        assert.equal(effortOf(provider, body), expected, label);
        for (const key of ['temperature', 'top_p', 'top_logprobs']) assert.equal(key in body, false, `${label}:${key}`);
        if (provider === 'openai-compatible') {
          // Chat Completions 另去掉 logprobs；Chat 没有 include，保留用户配置。
          assert.equal('logprobs' in body, false, label);
          assert.deepEqual(body.include, SAMPLING_BODY.include, label);
        } else {
          // Responses 从 include 去掉 message.output_text.logprobs，其余 include 保留。
          assert.equal(body.include.includes('message.output_text.logprobs'), false, label);
          assert.ok(body.include.includes('reasoning.encrypted_content'), label);
        }
        assert.equal(body.other, 'keep', label);
        assert.equal(provider === 'openai-compatible' ? body.max_tokens : body.max_output_tokens, 512, label);
      }
    }
  }
});

test('Sol / Luna：按最终请求里生效的强度判断（requestBody 覆盖与 configuration_update）', async () => {
  // requestBody 把强度覆盖为 none：保留采样参数。
  const responsesNone = await parameterDryRun('openai-responses', 'gpt-6-sol', 'high', {
    settings: { requestBody: { ...SAMPLING_BODY, reasoning: { effort: 'none' } } }
  });
  assert.equal(responsesNone.reasoning.effort, 'none');
  assert.equal(responsesNone.temperature, 0.3);
  const chatNone = await parameterDryRun('openai-compatible', 'gpt-6-luna', 'high', {
    settings: { requestBody: { ...SAMPLING_BODY, reasoning_effort: 'none' } }
  });
  assert.equal(chatNone.reasoning_effort, 'none');
  assert.equal(chatNone.logprobs, true);
  // requestBody 把强度覆盖为 high：去掉。
  const chatHigh = await parameterDryRun('openai-compatible', 'gpt-6-luna', 'none', {
    settings: { requestBody: { ...SAMPLING_BODY, reasoning_effort: 'high' } }
  });
  assert.equal('temperature' in chatHigh, false);
  // 请求级 none，但 configuration_update 把后续响应改为 high：同样去掉。
  const updated = await parameterDryRun('openai-responses', 'gpt-6-sol', 'none', {
    request: { contents: [
      { role: 'user', parts: [{ text: 'earlier' }] },
      { role: 'user', parts: [{ providerContext: {
        provider: 'openai', format: 'openai-responses', endpoint: 'responses', itemType: 'configuration_update',
        rawItem: { type: 'configuration_update', reasoning: { effort: 'high' } }
      } }] }
    ] }
  });
  assert.equal(updated.reasoning.effort, 'none');
  assert.equal('temperature' in updated, false);
  assert.equal('top_p' in updated, false);
});

test('渠道 requestBody 里直接写的推理强度同样按 GPT-6 规则适配（Sol / Luna minimal → low；Astra none / minimal → low）', async () => {
  // Using GPT-6：“GPT-6 Sol and Luna support none. If your existing request uses minimal, start with low.”；
  // Astra 不支持 none（用 low）。requestBody 原样发出这些值会被官方 400。
  const cases = [
    ['gpt-6-sol', 'minimal', 'low'], ['gpt-6-luna', 'minimal', 'low'], ['gpt-6-sol', 'none', 'none'], ['gpt-6-luna', 'high', 'high'],
    ['gpt-6-astra', 'minimal', 'low'], ['gpt-6-astra', 'none', 'low'], ['gpt-6-astra', 'high', 'high']
  ];
  for (const [model, written, expected] of cases) {
    const responses = await parameterDryRun('openai-responses', model, undefined, {
      settings: { requestBody: { reasoning: { effort: written, summary: 'auto' }, other: 'keep' } }
    });
    assert.deepEqual(responses.reasoning, { effort: expected, summary: 'auto' }, `responses:${model}:${written}`);
    assert.equal(responses.other, 'keep');
    const chat = await parameterDryRun('openai-compatible', model, undefined, {
      settings: { requestBody: { reasoning_effort: written, other: 'keep' } }
    });
    assert.equal(chat.reasoning_effort, expected, `chat:${model}:${written}`);
    assert.equal(chat.other, 'keep');
  }
  // 冻结快照里的 requestBody 同样适配。
  const frozen = await parameterDryRun('openai-responses', 'gpt-6-sol', undefined, {
    settings: { requestBody: { reasoning: { effort: 'high' } } },
    request: { settingsSnapshot: { generationConfig: { maxOutputTokens: 512 }, requestBody: { reasoning: { effort: 'minimal' } } } }
  });
  assert.equal(frozen.reasoning.effort, 'low');
  // 其他模型原样发送。
  for (const model of ['gpt-5.5', 'gpt-5.6', '[az]gpt-6-luna']) {
    const other = await parameterDryRun('openai-responses', model, undefined, { settings: { requestBody: { reasoning: { effort: 'minimal' } } } });
    assert.equal(other.reasoning.effort, 'minimal', model);
  }
});

test('Astra 与其他模型的参数适配不变', async () => {
  // Astra：none/minimal → low，始终去掉采样参数（原行为）。
  for (const provider of ['openai-responses', 'openai-compatible']) {
    const astra = await parameterDryRun(provider, 'gpt-6-astra', 'none');
    assert.equal(effortOf(provider, astra), 'low', provider);
    for (const key of ['temperature', 'top_p', 'top_logprobs', 'logprobs']) assert.equal(key in astra, false, `${provider}:${key}`);
  }
  // 其他模型（含网关别名）：采样参数、minimal、include 原样发送。
  for (const provider of ['openai-responses', 'openai-compatible']) {
    for (const model of ['gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-6-sol-xhigh', '[az]gpt-6-luna', 'claude-sonnet-5']) {
      const body = await parameterDryRun(provider, model, 'minimal');
      assert.equal(effortOf(provider, body), 'minimal', `${provider}:${model}`);
      assert.equal(body.temperature, 0.3, `${provider}:${model}`);
      assert.equal(body.top_p, 0.9, `${provider}:${model}`);
      assert.equal(body.top_logprobs, 2, `${provider}:${model}`);
      assert.equal(body.logprobs, true, `${provider}:${model}`);
      assert.ok(body.include.includes('message.output_text.logprobs'), `${provider}:${model}`);
    }
  }
});

test('Astra 摘要请求：压缩方法自带的采样参数同样去掉；其他模型原样发送', async () => {
  const { dryRunCompactLlmProvider } = require(path.join(compiledRoot, 'backend/capabilities/llmProvider.js'));
  const summaryBody = async (provider, model) => {
    const result = await dryRunCompactLlmProvider({
      id: `summary-${provider}-${model}`, blockId: 'summary-block', conversationId: 'conversation-gpt6', methodKind: 'llm_summary',
      methodConfigSnapshot: { id: 'summary-method', name: 'Summary', kind: 'llm_summary', trigger: { mode: 'manual' },
        llmSummary: { targetTokens: 1000, reasoning: { mode: 'provider_default' }, generationConfig: { temperature: 0.3, topP: 0.9 } },
        createdAt: 1, updatedAt: 1 },
      contents: [{ role: 'user', parts: [{ text: 'history to summarize' }] }]
    }, {
      settings: async () => providerConfig({
        provider, model, baseUrl: provider === 'openai-compatible' ? 'https://gateway.example/v1' : OFFICIAL, stream: false
      }),
      compressionSettings: async () => undefined
    });
    assert.equal(result.kind, 'provider_requests');
    return JSON.parse(result.calls[0].bodyText);
  };
  for (const provider of ['openai-responses', 'openai-compatible']) {
    for (const model of ['gpt-6-astra', 'gpt-6-astra-2026-09-01']) {
      const body = await summaryBody(provider, model);
      assert.equal('temperature' in body, false, `${provider}:${model}`);
      assert.equal('top_p' in body, false, `${provider}:${model}`);
    }
    for (const model of ['gpt-5.5', 'gpt-6-sol-xhigh']) {
      const body = await summaryBody(provider, model);
      assert.equal(body.temperature, 0.3, `${provider}:${model}`);
      assert.equal(body.top_p, 0.9, `${provider}:${model}`);
    }
  }
});

/** 经 Reliable adapter 投影（冻结 authority 快照 + 可选冻结原生 reasoning 配方），再用不同的实时设置 dry-run。 */
async function frozenWire(model, generationConfig, nativeReasoning, liveThinkingLevel = 'high') {
  let projected;
  const adapter = new LlmCapabilityFullRequestAdapter('fixture-provider', {
    start(request, emit) { projected = request; emit({ type: LlmEventType.Done, payload: { requestId: request.id } }); },
    abort() {}, dispose() {}
  });
  await adapter.sendFullRequest({
    kind: 'full-model-request', modelRequestId: `frozen-${model}`, conversationId: 'fixture-session', attemptSeq: '1', socketGeneration: '1',
    providerId: 'fixture-provider', modelId: model,
    authoritySnapshot: { model: { providerConfigId: 'fixture-provider', provider: 'openai-responses', modelId: model, generationConfig, requestBody: {} },
      toolPolicy: { allowedTools: [], preset: 'custom', sourceConfigs: {} } },
    recipe: { tools: [], ...(nativeReasoning ? { nativeReasoning } : {}) },
    context: [{ segmentId: 'input', segmentKind: 'message', messageRole: 'user', contentType: 'application/vnd.limcode.message+json',
      content: JSON.stringify({ role: 'user', parts: [{ text: 'synthetic fixture' }] }) }],
    attachmentCatalogState: { catalog: [], placements: [] }
  }, { async onEvent() { return { accepted: true, checkpointed: true, terminal: true }; } });
  return (await dryRunLlmProvider(projected, { settings: providerConfig({
    id: 'fixture-provider', model, baseUrl: 'https://relay.example/v1',
    generationConfig: { thinkingConfig: { thinkingLevel: liveThinkingLevel } }
  }) })).body;
}

test('冻结快照：Sol 冻结的 none 优先于实时设置并保留采样参数；冻结的 minimal 提升为 low', async () => {
  const none = await frozenWire('gpt-6-sol', { temperature: 0.4, thinkingConfig: { thinkingLevel: 'none' } });
  assert.equal(none.reasoning.effort, 'none');
  assert.equal(none.temperature, 0.4);
  const minimal = await frozenWire('gpt-6-luna', { temperature: 0.4, thinkingConfig: { thinkingLevel: 'minimal' } }, undefined, 'none');
  assert.equal(minimal.reasoning.effort, 'low');
  assert.equal('temperature' in minimal, false);
  // Astra 冻结的 none 仍按原规则变为 low。
  const astra = await frozenWire('gpt-6-astra', { temperature: 0.4, thinkingConfig: { thinkingLevel: 'none' } });
  assert.equal(astra.reasoning.effort, 'low');
  assert.equal('temperature' in astra, false);
});

test('冻结原生 reasoning 配方按模型归一：Sol / Luna 保留 none、minimal → low；Astra 的 none 仍转 low', async () => {
  const recipe = { baseEffort: 'none', baseMode: 'standard', updates: [{ effort: 'minimal' }], effectiveEffort: 'minimal' };
  const updates = (body) => body.input.filter((item) => item.type === 'configuration_update').map((item) => item.reasoning.effort);
  for (const model of ['gpt-6-sol', 'gpt-6-luna']) {
    const body = await frozenWire(model, { thinkingConfig: { thinkingLevel: 'none' } }, recipe);
    assert.equal(body.reasoning.effort, 'none', model);
    assert.deepEqual(updates(body), ['low'], model);
  }
  const noneOnly = await frozenWire('gpt-6-sol', { temperature: 0.4 }, { baseEffort: 'none', updates: [{ effort: 'none' }] });
  assert.equal(noneOnly.reasoning.effort, 'none');
  assert.deepEqual(updates(noneOnly), ['none']);
  assert.equal(noneOnly.temperature, 0.4, 'every effort in play is none');
  const astra = await frozenWire('gpt-6-astra', { thinkingConfig: { thinkingLevel: 'none' } }, recipe);
  assert.equal(astra.reasoning.effort, 'low');
  assert.deepEqual(updates(astra), ['low']);
});

test('会话思考显示：Sol / Luna 的 minimal 显示为适配器映射，none 原样显示', () => {
  const { sessionThinkingDisplayLabel } = sessionThinking;
  for (const provider of ['openai-responses', 'openai-compatible']) {
    assert.equal(sessionThinkingDisplayLabel(provider, 'gpt-6-sol', { thinkingLevel: 'minimal' }), 'low（适配器）');
    assert.equal(sessionThinkingDisplayLabel(provider, 'gpt-6-luna', { thinkingLevel: 'none' }), 'none');
    assert.equal(sessionThinkingDisplayLabel(provider, 'gpt-5.6', { thinkingLevel: 'minimal' }), 'minimal');
  }
  assert.equal(sessionThinkingDisplayLabel('openai-responses', 'gpt-6-astra', { thinkingLevel: 'none' }), 'low（适配器）');
  assert.equal(sessionThinkingDisplayLabel('openai-compatible', 'gpt-6-astra', { thinkingLevel: 'none' }), 'none');
});

// 显式缓存：https://developers.openai.com/api/docs/guides/prompt-caching（GPT-5.6 and later；ttl 只能是 "30m"；
// “Top-level instructions cannot contain an explicit breakpoint”）。WebSocket 模式指南对请求字段没有模型限制。
test('WS dry-run：支持显式缓存的模型保留 prompt_cache_options 与断点（原生与否一致），其他模型剥离', async () => {
  const explicitCache = { enabled: true, mode: 'explicit', ttl: '30m' };
  const request = (id) => chatRequest(id, { systemInstruction: { role: 'user', parts: [{ text: 'stable instructions' }] } });
  for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra']) {
    for (const nativeResponses of [undefined, { enabled: false }]) {
      const body = (await dryRunLlmProvider(request(`ws-cache-${model}`), {
        settings: async () => providerConfig({ model, openaiResponsesTransport: 'websocket', promptCache: explicitCache,
          ...(nativeResponses ? { nativeResponses } : {}) })
      })).body;
      assert.equal(body.type, 'response.create', model);
      assert.deepEqual(body.prompt_cache_options, { mode: 'explicit', ttl: '30m' }, model);
      assert.equal(body.instructions, undefined, model);
      const developer = body.input.find((item) => item?.role === 'developer');
      assert.deepEqual(developer?.content?.[0], { type: 'input_text', text: 'stable instructions', prompt_cache_breakpoint: { mode: 'explicit' } }, model);
    }
  }
  for (const model of ['gpt-5.5', 'gpt-6-sol-xhigh']) {
    const body = (await dryRunLlmProvider(request(`ws-cache-${model}`), {
      settings: async () => providerConfig({ model, openaiResponsesTransport: 'websocket', promptCache: explicitCache,
        requestBody: { prompt_cache_options: { mode: 'explicit', ttl: '30m' } } })
    })).body;
    assert.equal('prompt_cache_options' in body, false, model);
    assert.equal(JSON.stringify(body).includes('prompt_cache_breakpoint'), false, model);
    assert.equal(body.instructions, 'stable instructions', model);
  }
});

// 推理模式：https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode
// “GPT-5.6 and GPT-6 models support standard and pro reasoning modes in the Responses API.”
test('推理模式参数：openai-responses 上的 GPT-5.6 与 GPT-6 官方 id 开放，其他模型与渠道不变', () => {
  const { parameterDefinitionsForProvider } = loadWebviewModule('webview/src/components/settings/global/parameters/llmParameterDefinitions.ts');
  const hasMode = (model, provider = 'openai-responses') => parameterDefinitionsForProvider(provider, model, officialCapability(model, provider))
    .some((definition) => definition.key === 'reasoningMode');
  for (const model of ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra-2026-09-01', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
    assert.equal(hasMode(model), true, model);
  }
  // 已登记推理能力的更早模型不开放（与修改前一致）。
  for (const model of ['gpt-5', 'gpt-5.1', 'gpt-5.2', 'gpt-5.4']) assert.equal(hasMode(model), false, model);
  // Chat Completions 没有 reasoning.mode。
  for (const model of ['gpt-6-sol', 'gpt-6-astra']) assert.equal(hasMode(model, 'openai-compatible'), false, model);
});

test('推理模式编码：reasoning.mode 按配置发送，不再只认 Astra；Chat Completions 不发送', async () => {
  for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6', 'gpt-6-astra']) {
    const body = (await dryRunLlmProvider(chatRequest(`mode-${model}`), {
      settings: async () => providerConfig({ model, generationConfig: { thinkingConfig: { thinkingLevel: 'high', reasoningMode: 'pro' } } })
    })).body;
    assert.equal(body.reasoning.mode, 'pro', model);
    assert.equal(body.reasoning.effort, 'high', model);
  }
  const chat = (await dryRunLlmProvider(chatRequest('mode-chat'), {
    settings: async () => providerConfig({ provider: 'openai-compatible', baseUrl: 'https://gateway.example/v1',
      generationConfig: { thinkingConfig: { thinkingLevel: 'high', reasoningMode: 'pro' } } })
  })).body;
  assert.equal(chat.reasoning_effort, 'high');
  assert.equal(JSON.stringify(chat).includes('"pro"'), false);
});

// Chat Completions 工具限制：Using GPT-6 “Update API and model parameters”：“GPT-6 Astra supports Chat Completions,
// but its tool calling requires Responses. GPT-6 Sol and Luna support function calling in Chat Completions only with
// reasoning_effort: "none".” LimCode 不改写推理强度，只在设置界面提示。
test('Chat Completions 工具限制：只对 openai-compatible 上的 GPT-6 官方 id 给出提示', () => {
  const { gpt6ChatCompletionsToolRestriction: restriction } = capabilities;
  assert.equal(restriction('openai-compatible', 'gpt-6-astra'), 'unsupported');
  assert.equal(restriction('openai-compatible', 'gpt-6-astra-2026-09-01'), 'unsupported');
  for (const model of ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-luna-2026-06-01']) {
    assert.equal(restriction('openai-compatible', model), 'requires_none_effort', model);
  }
  for (const model of FAMILY) assert.equal(restriction('openai-responses', model), undefined, model);
  for (const model of ['gpt-6-sol-xhigh', '[az]gpt-6-astra-xhigh', 'gpt-5.6', 'gpt-5.5', 'claude-sonnet-5']) {
    assert.equal(restriction('openai-compatible', model), undefined, model);
  }
});

test('Chat Completions 带工具时不擅自改写推理强度', async () => {
  const tools = [{ name: 'probe', description: 'd', parameters: { type: 'object', properties: {} } }];
  for (const [model, level] of [['gpt-6-sol', 'high'], ['gpt-6-luna', 'none'], ['gpt-6-astra', 'high']]) {
    const body = (await dryRunLlmProvider(chatRequest(`chat-tools-${model}`, { tools }), {
      settings: async () => providerConfig({ provider: 'openai-compatible', model, baseUrl: 'https://gateway.example/v1',
        generationConfig: { thinkingConfig: { thinkingLevel: level } } })
    })).body;
    assert.equal(body.reasoning_effort, level, model);
    assert.equal(body.tools.length, 1, model);
  }
});

test('设置界面：openai-compatible 上的 GPT-6 模型显示工具调用限制提示，其他情况不显示', async () => {
  const { createWebviewSsrServer } = await import('./webview-ssr-server.mjs');
  const server = await createWebviewSsrServer();
  // 原生能力状态的悬浮面板在 setup 里读取视口尺寸；SSR 下给一个最小的 document 桩。
  const previousDocument = globalThis.document;
  globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
  try {
    const { default: editor } = await server.ssrLoadModule('/src/components/settings/global/LlmAdvancedConfigEditor.vue');
    const { createSSRApp } = await import('vue');
    const { renderToString } = await import('@vue/server-renderer');
    const render = (provider, model, generationConfig) => renderToString(createSSRApp(editor, {
      config: providerConfig({ provider, model, ...(generationConfig ? { generationConfig } : {}) })
    }));
    const astra = await render('openai-compatible', 'gpt-6-astra');
    assert.match(astra, /GPT-6 Astra 走 Chat Completions 时不支持工具调用/);
    for (const model of ['gpt-6-sol', 'gpt-6-luna']) {
      assert.match(await render('openai-compatible', model), /工具调用需要推理强度为 none/, model);
    }
    for (const [provider, model] of [['openai-responses', 'gpt-6-sol'], ['openai-compatible', 'gpt-5.5'], ['openai-compatible', 'gpt-6-sol-xhigh']]) {
      assert.doesNotMatch(await render(provider, model), /chat-completions-tool-hint/, `${provider}:${model}`);
    }
    // Responses 渠道：原生能力区块改为 GPT-6 家族；pro 模式下提示动态推理更新不可用。
    const sol = await render('openai-responses', 'gpt-6-sol');
    assert.match(sol, /GPT-6 原生能力/);
    assert.match(sol, /已启用/);
    assert.doesNotMatch(sol, /推理模式为 pro 时不可用/);
    const pro = await render('openai-responses', 'gpt-6-luna', { thinkingConfig: { reasoningMode: 'pro' } });
    assert.match(pro, /推理模式为 pro 时不可用/);
    assert.match(await render('openai-responses', 'gpt-6-sol-xhigh'), /当前 LLM 不支持/);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    await server.close();
  }
});
