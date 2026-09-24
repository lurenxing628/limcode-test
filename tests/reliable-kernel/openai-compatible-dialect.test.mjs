import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// 渠道配置存储模块在加载时引用 vscode；这里只用到它的纯函数（配置规范化），给一个空桩。
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  return request === 'vscode' ? {} : originalLoad.call(this, request, ...rest);
};
const {
  mapOpenAICompatibleEffort,
  normalizedOpenAICompatibleModelName,
  openAICompatibleEffortValues,
  openAICompatiblePlatform,
  openAICompatibleThinkingLevels,
  resolveOpenAICompatibleDialect,
  describeOpenAICompatibleDialect,
  OPENAI_COMPATIBLE_SERVICE_PRESETS
} = require('../../dist/extension/shared/openAICompatibleDialect.js');
const { canonicalLlmProviderKind } = require('../../dist/extension/shared/protocol.js');
const { sessionThinkingCapability, validateSessionThinkingOverride } = require('../../dist/extension/shared/sessionThinking.js');
const { normalizeModelCapabilitySnapshot, resolveProviderOpenAICompatibleDialect } = require('../../dist/extension/shared/modelCapabilities.js');
const { libraryProviderKind } = require('../../dist/extension/backend/capabilities/openAICompatibleDialectAdaptation.js');
const { dryRunLlmProvider } = require('../../dist/extension/backend/capabilities/llmProvider.js');
const { normalizeLlmProviderConfig } = require('../../dist/extension/backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { canonicalModelProfile } = require('../../dist/extension/backend/reliableKernel/scopedModelProfiles.js');
const { frozenModelSelection } = require('../../dist/extension/backend/reliableKernel/frozenAuthority.js');

const DEEPSEEK = 'https://api.deepseek.com/v1';
const MOONSHOT = 'https://api.moonshot.cn/v1';
const ZHIPU = 'https://open.bigmodel.cn/api/paas/v4';
const DASHSCOPE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const SILICONFLOW = 'https://api.siliconflow.cn/v1';
const QIANFAN = 'https://qianfan.baidubce.com/v2';
const OPENROUTER = 'https://openrouter.ai/api/v1';
const RELAY = 'https://relay.example.invalid/v1';

const THINKING_KEYS = ['thinking', 'enable_thinking', 'reasoning_effort'];

function settings(baseUrl, model, overrides = {}) {
  return {
    id: 'dialect-channel', name: 'dialect', provider: 'openai-compatible', baseUrl, model,
    models: [{ id: model, name: model }], apiKey: 'offline-placeholder', toolCallFormat: 'function-call',
    stream: false, retryOnError: false, retryMaxAttempts: 0, enableMultimodalTools: true,
    promptCache: { enabled: false, mode: 'key', ttl: '30m' }, modelConfigs: [], createdAt: 1, updatedAt: 1,
    ...overrides
  };
}

/** 真实编码链路（接入库编码 + requestBody 合并 + 方言改写）产出的请求体。 */
async function wire(baseUrl, model, { level, contents, tools = [], ...overrides } = {}) {
  const result = await dryRunLlmProvider({
    id: 'dialect', invocationId: 'dialect', conversationId: 'dialect',
    contents: contents ?? [{ role: 'user', parts: [{ text: 'hello' }] }],
    tools
  }, {
    settings: async () => settings(baseUrl, model, {
      ...(level ? { generationConfig: { thinkingConfig: { thinkingLevel: level } } } : {}),
      ...overrides
    })
  });
  return result.body;
}

function thinkingParams(body) {
  return Object.fromEntries(THINKING_KEYS.filter((key) => key in body).map((key) => [key, body[key]]));
}

test('按接口地址识别平台：各服务商官方地址、本机与局域网、认不出的中转站', () => {
  for (const preset of OPENAI_COMPATIBLE_SERVICE_PRESETS) {
    assert.equal(openAICompatiblePlatform(preset.baseUrl), preset.id, preset.baseUrl);
  }
  assert.equal(openAICompatiblePlatform('https://api.z.ai/api/paas/v4'), 'zhipu');
  assert.equal(openAICompatiblePlatform('https://api.moonshot.ai/v1'), 'moonshot');
  assert.equal(openAICompatiblePlatform('https://dashscope-intl.aliyuncs.com/compatible-mode/v1'), 'dashscope');
  for (const local of ['http://localhost:11434/v1', 'http://127.0.0.1:8000/v1', 'http://192.168.1.20:8000/v1', 'http://10.0.0.5/v1', 'http://172.20.0.2/v1', 'http://[::1]:8000/v1']) {
    assert.equal(openAICompatiblePlatform(local), 'local', local);
  }
  assert.equal(openAICompatiblePlatform('http://172.40.0.2/v1'), 'unknown');
  // 只认主机名：路径里出现服务商名字的中转站不算。
  assert.equal(openAICompatiblePlatform('https://relay.example.invalid/deepseek.com/v1'), 'unknown');
  assert.equal(openAICompatiblePlatform('https://notdeepseek.com/v1'), 'unknown');
  assert.equal(openAICompatiblePlatform('not a url'), 'unknown');
});

test('模型 ID 去掉平台前缀、小写并把点号换成连字符后再匹配能力', () => {
  assert.equal(normalizedOpenAICompatibleModelName('deepseek-ai/DeepSeek-V4-Pro'), 'deepseek-v4-pro');
  assert.equal(normalizedOpenAICompatibleModelName('Pro/zai-org/GLM-5.2'), 'glm-5-2');
  const glm53 = resolveOpenAICompatibleDialect('https://ark.cn-beijing.volces.com/api/v3', 'glm-5-3-flash-260828');
  assert.equal(glm53.rule.family, 'glm');
  assert.equal(glm53.rule.canDisable, false);
  assert.equal(resolveOpenAICompatibleDialect(SILICONFLOW, 'moonshotai/Kimi-K3').rule.toggle, false);
});

test('自动识别写法：先看平台，认不出的中转站再看模型 ID，手动指定优先', () => {
  const cases = [
    [DEEPSEEK, 'deepseek-v4-pro', 'deepseek', 'platform', true, true],
    ['https://api.xiaomimimo.com/v1', 'mimo-v2-pro', 'deepseek', 'platform', true, true],
    [MOONSHOT, 'kimi-k3', 'deepseek', 'platform', false, true],
    [ZHIPU, 'glm-5.2', 'deepseek', 'platform', false, true],
    [DASHSCOPE, 'deepseek-v4-pro', 'enable_thinking', 'platform', false, true],
    [DASHSCOPE, 'qwen3-max', 'enable_thinking', 'platform', false, false],
    [SILICONFLOW, 'Qwen/Qwen3-32B', 'enable_thinking', 'platform', false, false],
    [QIANFAN, 'qwen3-235b-a22b', 'enable_thinking', 'platform', false, false],
    [QIANFAN, 'ernie-5.0', 'enable_thinking', 'platform', false, false],
    [QIANFAN, 'deepseek-v4-pro', 'deepseek', 'platform', false, true],
    [QIANFAN, 'some-other-model', 'reasoning_effort', 'default', false, false],
    // OpenRouter 不能套 DeepSeek 写法，也不补回传。
    [OPENROUTER, 'deepseek/deepseek-v4-pro', 'reasoning_effort', 'platform', false, false],
    ['http://127.0.0.1:8000/v1', 'deepseek-v4-pro', 'reasoning_effort', 'platform', false, false],
    [RELAY, 'deepseek-v4-flash', 'deepseek', 'model', false, true],
    [RELAY, 'glm-5.3', 'deepseek', 'model', false, true],
    [RELAY, 'qwen3-max', 'reasoning_effort', 'default', false, false],
    [RELAY, 'gpt-5.5', 'reasoning_effort', 'default', false, false]
  ];
  for (const [baseUrl, model, format, source, toolContentArrays, fillReasoningReplay] of cases) {
    const dialect = resolveOpenAICompatibleDialect(baseUrl, model);
    assert.deepEqual(
      { format: dialect.format, source: dialect.source, toolContentArrays: dialect.toolContentArrays, fillReasoningReplay: dialect.fillReasoningReplay },
      { format, source, toolContentArrays, fillReasoningReplay },
      `${baseUrl} ${model}`
    );
  }
  const manual = resolveOpenAICompatibleDialect(DEEPSEEK, 'deepseek-v4-pro', 'reasoning_effort');
  assert.equal(manual.format, 'reasoning_effort');
  assert.equal(manual.source, 'manual');
  assert.equal(manual.toolContentArrays, false);
  assert.equal(describeOpenAICompatibleDialect(resolveOpenAICompatibleDialect(DEEPSEEK, 'deepseek-v4-pro')), 'DeepSeek 写法（thinking.type + reasoning_effort） · 按接口地址识别：DeepSeek 官方');
  assert.equal(describeOpenAICompatibleDialect(manual), 'OpenAI 写法（只发 reasoning_effort） · 手动指定');
});

test('只有官方 DeepSeek、MiMo 接口交给接入库的 DeepSeek 格式编码', () => {
  assert.equal(libraryProviderKind(settings(DEEPSEEK, 'deepseek-v4-pro')), 'deepseek');
  assert.equal(libraryProviderKind(settings('https://api.xiaomimimo.com/v1', 'mimo-v2-pro')), 'deepseek');
  assert.equal(libraryProviderKind(settings(MOONSHOT, 'kimi-k3')), 'openai-compatible');
  assert.equal(libraryProviderKind(settings(RELAY, 'deepseek-v4-pro')), 'openai-compatible');
  assert.equal(libraryProviderKind(settings(DEEPSEEK, 'deepseek-v4-pro', { openaiCompatibleThinkingFormat: 'reasoning_effort' })), 'openai-compatible');
  assert.equal(libraryProviderKind({ ...settings(DEEPSEEK, 'claude-opus-5-5'), provider: 'claude' }), 'claude');
});

test('思考强度换成对方接受的值：先按 DeepSeek 官方换算，再取不低于它的最小值', () => {
  const deepseek = ['low', 'high', 'max'];
  assert.equal(mapOpenAICompatibleEffort('minimal', deepseek), 'low');
  assert.equal(mapOpenAICompatibleEffort('medium', deepseek), 'high');
  assert.equal(mapOpenAICompatibleEffort('xhigh', deepseek), 'high');
  assert.equal(mapOpenAICompatibleEffort('max', deepseek), 'max');
  assert.equal(mapOpenAICompatibleEffort('max', ['low', 'high']), 'high');
  assert.equal(mapOpenAICompatibleEffort('low', ['high', 'max']), 'high');
  assert.equal(mapOpenAICompatibleEffort('medium', []), undefined);
  assert.equal(mapOpenAICompatibleEffort('medium', 'any'), 'medium');
  assert.equal(openAICompatibleEffortValues(resolveOpenAICompatibleDialect('https://ark.cn-beijing.volces.com/api/v3', 'deepseek-v4-pro')), 'any');
  assert.deepEqual(openAICompatibleEffortValues(resolveOpenAICompatibleDialect(SILICONFLOW, 'deepseek-ai/DeepSeek-V4-Pro')), ['high', 'max']);
  assert.deepEqual(openAICompatibleEffortValues(resolveOpenAICompatibleDialect(SILICONFLOW, 'zai-org/GLM-5.2')), ['high', 'max']);
  assert.deepEqual(openAICompatibleEffortValues(resolveOpenAICompatibleDialect(QIANFAN, 'glm-5.2')), []);
  assert.deepEqual(openAICompatibleEffortValues(resolveOpenAICompatibleDialect(DASHSCOPE, 'deepseek-v4-pro')), []);
  assert.deepEqual(openAICompatibleEffortValues(resolveOpenAICompatibleDialect(RELAY, 'hunyuan-t2')), ['low', 'high']);
  assert.deepEqual(openAICompatibleEffortValues(resolveOpenAICompatibleDialect(RELAY, 'unknown-model', 'deepseek')), deepseek);
  assert.equal(openAICompatibleEffortValues(resolveOpenAICompatibleDialect(RELAY, 'gpt-5.5')), 'any');
});

test('会话思考强度按模型能力给选项：关不掉的模型没有“关闭”，只能开关的给 none / high', () => {
  const values = (model) => sessionThinkingCapability('openai-compatible', model)?.values;
  assert.deepEqual(values('deepseek-v4-pro'), ['none', 'low', 'high', 'max']);
  assert.deepEqual(values('deepseek-ai/DeepSeek-V4-Flash'), ['none', 'low', 'high', 'max']);
  assert.deepEqual(values('kimi-k3'), ['low', 'high', 'max']);
  assert.deepEqual(values('kimi-k2.7-code'), ['high']);
  assert.deepEqual(values('glm-5.3'), ['low', 'high', 'max']);
  assert.deepEqual(values('qwen3-max'), ['none', 'high']);
  assert.deepEqual(values('hunyuan-t2'), ['none', 'low', 'high']);
  assert.equal(sessionThinkingCapability('openai-compatible', 'deepseek-v4-pro').kind, 'deepseek-effort');
  assert.equal(values('gpt-4o'), undefined);
});

test('DeepSeek 写法：官方接口按档位发 thinking.type + 收敛后的 reasoning_effort', async () => {
  assert.deepEqual(thinkingParams(await wire(DEEPSEEK, 'deepseek-v4-pro', { level: 'medium' })), { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  assert.deepEqual(thinkingParams(await wire(DEEPSEEK, 'deepseek-v4-pro', { level: 'max' })), { thinking: { type: 'enabled' }, reasoning_effort: 'max' });
  assert.deepEqual(thinkingParams(await wire(DEEPSEEK, 'deepseek-v4-pro', { level: 'none' })), { thinking: { type: 'disabled' } });
  // 没有设置档位：不发任何思考参数，由服务决定。
  assert.deepEqual(thinkingParams(await wire(DEEPSEEK, 'deepseek-v4-pro')), {});
  // 认不出的中转站按模型 ID 走同一写法。
  assert.deepEqual(thinkingParams(await wire(RELAY, 'deepseek-v4-flash', { level: 'low' })), { thinking: { type: 'enabled' }, reasoning_effort: 'low' });
  // MiMo 只开关，不发强度。
  assert.deepEqual(thinkingParams(await wire('https://api.xiaomimimo.com/v1', 'mimo-v2-pro', { level: 'high' })), { thinking: { type: 'enabled' } });
});

test('DeepSeek 写法：关不掉思考的模型不发 disabled，Kimi K3 不发 thinking 参数', async () => {
  assert.deepEqual(thinkingParams(await wire(MOONSHOT, 'kimi-k3', { level: 'none' })), {});
  assert.deepEqual(thinkingParams(await wire(MOONSHOT, 'kimi-k3', { level: 'medium' })), { reasoning_effort: 'high' });
  assert.deepEqual(thinkingParams(await wire(ZHIPU, 'glm-5.3', { level: 'none' })), {});
  assert.deepEqual(thinkingParams(await wire(ZHIPU, 'glm-5.3', { level: 'xhigh' })), { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  assert.deepEqual(thinkingParams(await wire(ZHIPU, 'glm-4.6', { level: 'high' })), { thinking: { type: 'enabled' } });
  assert.deepEqual(thinkingParams(await wire(ZHIPU, 'glm-4.6', { level: 'none' })), { thinking: { type: 'disabled' } });
});

test('enable_thinking 写法：百炼、硅基流动、千帆 Qwen 用开关，只在对方接受时带强度', async () => {
  assert.deepEqual(thinkingParams(await wire(DASHSCOPE, 'qwen3-max', { level: 'high' })), { enable_thinking: true });
  assert.deepEqual(thinkingParams(await wire(DASHSCOPE, 'deepseek-v4-pro', { level: 'none' })), { enable_thinking: false });
  assert.deepEqual(thinkingParams(await wire(SILICONFLOW, 'deepseek-ai/DeepSeek-V4-Pro', { level: 'low' })), { enable_thinking: true, reasoning_effort: 'high' });
  assert.deepEqual(thinkingParams(await wire(QIANFAN, 'qwen3-235b-a22b', { level: 'medium' })), { enable_thinking: true });
});

test('OpenAI 写法与不发送：OpenRouter、本机服务原样发 reasoning_effort，手动“不发送”去掉全部思考参数', async () => {
  assert.deepEqual(thinkingParams(await wire(OPENROUTER, 'deepseek/deepseek-v4-pro', { level: 'medium' })), { reasoning_effort: 'medium' });
  assert.deepEqual(thinkingParams(await wire('http://127.0.0.1:8000/v1', 'qwen3-32b', { level: 'none' })), { reasoning_effort: 'none' });
  assert.deepEqual(thinkingParams(await wire(RELAY, 'gpt-5.5', { level: 'high' })), { reasoning_effort: 'high' });
  assert.deepEqual(thinkingParams(await wire(DEEPSEEK, 'deepseek-v4-pro', { level: 'high', openaiCompatibleThinkingFormat: 'omit' })), {});
  assert.deepEqual(thinkingParams(await wire(RELAY, 'renamed-model', { level: 'medium', openaiCompatibleThinkingFormat: 'deepseek' })), { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  assert.deepEqual(thinkingParams(await wire(RELAY, 'renamed-model', { level: 'none', openaiCompatibleThinkingFormat: 'enable_thinking' })), { enable_thinking: false });
});

test('用户在自定义请求体里写了思考参数时不改写', async () => {
  const body = await wire(DASHSCOPE, 'qwen3-max', { level: 'high', requestBody: { enable_thinking: false, thinking_budget: 256 } });
  assert.equal(body.enable_thinking, false);
  assert.equal(body.thinking_budget, 256);
  assert.equal('thinking' in body, false);
  const custom = await wire(DEEPSEEK, 'deepseek-v4-pro', { level: 'high', requestBody: { thinking: { type: 'disabled' } } });
  assert.deepEqual(custom.thinking, { type: 'disabled' });
});

const TOOL = { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {} } };
const TOOL_HISTORY = [
  { role: 'user', parts: [{ text: 'go' }] },
  { role: 'model', parts: [{ id: 'call_1', functionCall: { name: 'probe', args: {} } }] },
  { role: 'user', parts: [{ id: 'call_1', functionResponse: { name: 'probe', response: { ok: true } } }] },
  { role: 'model', parts: [{ text: 'done' }] },
  { role: 'user', parts: [{ text: 'next' }] }
];

test('带 tools 的请求给每条 assistant 消息补上 reasoning_content；OpenRouter、OpenAI 写法不补', async () => {
  for (const [baseUrl, model] of [[DEEPSEEK, 'deepseek-v4-pro'], [MOONSHOT, 'kimi-k3'], [DASHSCOPE, 'deepseek-v4-pro'], [RELAY, 'deepseek-v4-flash']]) {
    const body = await wire(baseUrl, model, { level: 'high', contents: TOOL_HISTORY, tools: [TOOL] });
    const assistants = body.messages.filter((message) => message.role === 'assistant');
    assert.equal(assistants.length, 2, baseUrl);
    for (const message of assistants) assert.equal(message.reasoning_content, '', `${baseUrl} ${model}`);
  }
  for (const [baseUrl, model] of [[OPENROUTER, 'deepseek/deepseek-v4-pro'], [RELAY, 'gpt-5.5']]) {
    const body = await wire(baseUrl, model, { level: 'high', contents: TOOL_HISTORY, tools: [TOOL] });
    for (const message of body.messages.filter((entry) => entry.role === 'assistant')) {
      assert.equal('reasoning_content' in message, false, baseUrl);
    }
  }
  // 没有 tools 时不补。
  const plain = await wire(DEEPSEEK, 'deepseek-v4-pro', { level: 'high', contents: [TOOL_HISTORY[0], TOOL_HISTORY[3], TOOL_HISTORY[4]] });
  assert.equal('reasoning_content' in plain.messages.find((message) => message.role === 'assistant'), false);
});

test('原 DeepSeek 渠道迁移为 OpenAI 兼容：没填地址的补上官方地址，思考写法只保存合法值', () => {
  const legacy = normalizeLlmProviderConfig({ id: 'legacy', name: 'DeepSeek', provider: 'deepseek', baseUrl: '', model: 'deepseek-v4-pro' });
  assert.equal(legacy.provider, 'openai-compatible');
  assert.equal(legacy.baseUrl, 'https://api.deepseek.com/v1');
  assert.equal(resolveOpenAICompatibleDialect(legacy.baseUrl, legacy.model).format, 'deepseek');
  const relay = normalizeLlmProviderConfig({ id: 'relay', provider: 'deepseek', baseUrl: 'https://relay.example.invalid/v1', model: 'deepseek-v4-pro' });
  assert.equal(relay.baseUrl, 'https://relay.example.invalid/v1');
  assert.equal('openaiCompatibleThinkingFormat' in relay, false);
  const manual = normalizeLlmProviderConfig({
    id: 'manual', provider: 'openai-compatible', baseUrl: RELAY, model: 'a', openaiCompatibleThinkingFormat: 'enable_thinking',
    models: [{ id: 'a', name: 'a' }, { id: 'b', name: 'b' }],
    modelConfigs: [
      { id: 'mc-a', modelId: 'a', toolCallFormat: 'function-call', openaiResponsesTransport: 'http', stream: true, retryOnError: true, retryMaxAttempts: 3, enableMultimodalTools: true, openaiCompatibleThinkingFormat: 'omit', createdAt: 1, updatedAt: 1 },
      { id: 'mc-b', modelId: 'b', toolCallFormat: 'function-call', openaiResponsesTransport: 'http', stream: true, retryOnError: true, retryMaxAttempts: 3, enableMultimodalTools: true, openaiCompatibleThinkingFormat: 'bogus', createdAt: 1, updatedAt: 1 }
    ]
  });
  assert.equal(manual.openaiCompatibleThinkingFormat, 'enable_thinking');
  assert.equal(manual.modelConfigs.find((entry) => entry.modelId === 'a').openaiCompatibleThinkingFormat, 'omit');
  assert.equal('openaiCompatibleThinkingFormat' in manual.modelConfigs.find((entry) => entry.modelId === 'b'), false);
  assert.equal('openaiCompatibleThinkingFormat' in normalizeLlmProviderConfig({ provider: 'openai-compatible', openaiCompatibleThinkingFormat: 'bogus' }), false);
});

test('已保存的模型选择、历史回合快照和能力快照里的 deepseek 读作 OpenAI 兼容', () => {
  assert.equal(canonicalLlmProviderKind('deepseek'), 'openai-compatible');
  assert.equal(canonicalLlmProviderKind('claude'), 'claude');
  assert.equal(canonicalLlmProviderKind('bogus'), undefined);
  const profile = { providerConfigId: 'legacy', provider: 'deepseek', model: 'deepseek-v4-pro' };
  assert.equal(canonicalModelProfile(profile).provider, 'openai-compatible');
  const current = { providerConfigId: 'c', provider: 'claude', model: 'claude-opus-5-5' };
  assert.equal(canonicalModelProfile(current), current);
  assert.equal(frozenModelSelection({ model: { providerConfigId: 'legacy', provider: 'deepseek', modelId: 'deepseek-v4-pro' } }).provider, 'openai-compatible');
  assert.throws(() => frozenModelSelection({ model: { providerConfigId: 'legacy', provider: 'bogus', modelId: 'x' } }), /provider is invalid/);
  const snapshot = normalizeModelCapabilitySnapshot({
    providerKind: 'deepseek', modelId: 'deepseek-v4-pro', endpointFingerprint: 'https://api.deepseek.com/v1', source: 'official_registry',
    reasoning: { family: 'deepseek_toggle', levels: ['high', 'max'], supportsBudget: false, canDisable: true, alwaysOn: false, outputLimitIncludesThinking: true, requiresThoughtSignatures: false },
    nativeCompaction: { availability: 'unsupported', reason: 'none' }
  });
  assert.equal(snapshot.providerKind, 'openai-compatible');
});

/** “测试这个模型”写进 models[].capabilitySnapshot 的证据（由 1b 的探测产生，这里直接构造）。 */
function probeSnapshot(baseUrl, model, { wireFormat, canDisable, levels, providerConfigId = 'dialect-channel' }) {
  return {
    providerKind: 'openai-compatible', modelId: model, providerConfigId, transport: 'http',
    endpointFingerprint: baseUrl.replace(/\/+$/, ''), source: 'verified_probe', verifiedAt: '2026-09-24T02:30:00.000Z',
    reasoning: {
      family: wireFormat === 'reasoning_effort' ? 'openai_effort' : 'deepseek_toggle', levels, supportsBudget: false,
      canDisable, alwaysOn: !canDisable, outputLimitIncludesThinking: true, requiresThoughtSignatures: false, wireFormat
    },
    nativeCompaction: { availability: 'unknown', reason: '当前渠道和模型没有经过能力确认。' }
  };
}

function probedSettings(baseUrl, model, probe, overrides = {}) {
  return settings(baseUrl, model, { models: [{ id: model, name: model, capabilitySnapshot: probeSnapshot(baseUrl, model, probe) }], ...overrides });
}

test('测试证据：wireFormat 随能力快照保存，只对 OpenAI 兼容保留合法值', () => {
  const snapshot = probeSnapshot(RELAY, 'renamed-model', { wireFormat: 'enable_thinking', canDisable: true, levels: ['high', 'max'] });
  assert.equal(normalizeModelCapabilitySnapshot(snapshot).reasoning.wireFormat, 'enable_thinking');
  assert.equal('wireFormat' in normalizeModelCapabilitySnapshot({ ...snapshot, reasoning: { ...snapshot.reasoning, wireFormat: 'bogus' } }).reasoning, false);
  assert.equal('wireFormat' in normalizeModelCapabilitySnapshot({ ...snapshot, providerKind: 'claude' }).reasoning, false);
});

test('测试证据作为 probed 传入：写法与规则取自测试结果，手动写法优先', () => {
  const probed = { format: 'enable_thinking', canDisable: false, efforts: ['high', 'max'] };
  const dialect = resolveOpenAICompatibleDialect(RELAY, 'renamed-model', undefined, probed);
  assert.equal(dialect.format, 'enable_thinking');
  assert.equal(dialect.source, 'probe');
  assert.equal(dialect.rule.canDisable, false);
  assert.deepEqual(dialect.rule.efforts, ['high', 'max']);
  assert.deepEqual(openAICompatibleEffortValues(dialect), ['high', 'max']);
  assert.equal(describeOpenAICompatibleDialect(dialect), 'enable_thinking 写法（百炼、硅基流动等） · 按测试结果');
  // 平台相关的回传行为仍按平台和写法计算。
  assert.equal(resolveOpenAICompatibleDialect(DEEPSEEK, 'renamed', undefined, { format: 'deepseek', canDisable: true, efforts: [] }).toolContentArrays, true);
  const manual = resolveOpenAICompatibleDialect(RELAY, 'renamed-model', 'deepseek', probed);
  assert.equal(manual.source, 'manual');
  assert.equal(manual.rule, undefined);
});

test('有效档位：平台差异算进去，只有开关的记作 high，OpenAI 写法与不发送没有档位', () => {
  const levels = (baseUrl, model, manual, probed) => openAICompatibleThinkingLevels(resolveOpenAICompatibleDialect(baseUrl, model, manual, probed));
  assert.deepEqual(levels(DEEPSEEK, 'deepseek-v4-pro'), { levels: ['low', 'high', 'max'], canDisable: true });
  assert.deepEqual(levels(MOONSHOT, 'kimi-k3'), { levels: ['low', 'high', 'max'], canDisable: false });
  assert.deepEqual(levels('https://ark.cn-beijing.volces.com/api/v3', 'deepseek-v4-pro'), { levels: ['low', 'high', 'max'], canDisable: true });
  assert.deepEqual(levels(SILICONFLOW, 'deepseek-ai/DeepSeek-V4-Pro'), { levels: ['high', 'max'], canDisable: true });
  assert.deepEqual(levels('https://api.xiaomimimo.com/v1', 'mimo-v2-pro'), { levels: ['high'], canDisable: true });
  assert.deepEqual(levels(RELAY, 'renamed-model', undefined, { format: 'deepseek', canDisable: true, efforts: [] }), { levels: ['high'], canDisable: true });
  assert.equal(levels(OPENROUTER, 'deepseek/deepseek-v4-pro'), undefined);
  assert.equal(levels(DEEPSEEK, 'deepseek-v4-pro', 'omit'), undefined);
  assert.equal(levels(RELAY, 'renamed-model', 'deepseek'), undefined);
});

test('按渠道配置解析方言：模型级手动 > 渠道级手动 > 测试证据 > 自动识别，证据换地址或渠道即失效', () => {
  const probe = { wireFormat: 'enable_thinking', canDisable: true, levels: ['low', 'high'] };
  const config = probedSettings(RELAY, 'renamed-model', probe);
  const probed = resolveProviderOpenAICompatibleDialect(config, 'renamed-model');
  assert.equal(probed.source, 'probe');
  assert.equal(probed.format, 'enable_thinking');
  assert.deepEqual(probed.rule.efforts, ['low', 'high']);
  assert.equal(resolveProviderOpenAICompatibleDialect({ ...config, baseUrl: 'https://other.example.invalid/v1' }, 'renamed-model').source, 'default');
  assert.equal(resolveProviderOpenAICompatibleDialect({ ...config, id: 'another-channel' }, 'renamed-model').source, 'default');
  const channelManual = resolveProviderOpenAICompatibleDialect({ ...config, openaiCompatibleThinkingFormat: 'deepseek' }, 'renamed-model');
  assert.equal(channelManual.source, 'manual');
  assert.equal(channelManual.format, 'deepseek');
  const modelManual = resolveProviderOpenAICompatibleDialect({
    ...config, openaiCompatibleThinkingFormat: 'deepseek',
    modelConfigs: [{ id: 'mc', modelId: 'renamed-model', openaiCompatibleThinkingFormat: 'omit' }]
  }, 'renamed-model');
  assert.equal(modelManual.format, 'omit');
  // 编辑器里“自动识别”一项的说明：忽略手动写法。
  assert.equal(resolveProviderOpenAICompatibleDialect({ ...config, openaiCompatibleThinkingFormat: 'deepseek' }, 'renamed-model', { manual: null }).source, 'probe');
});

test('请求改写与接入库格式都采用测试结果', async () => {
  const probe = { wireFormat: 'enable_thinking', canDisable: true, levels: ['high', 'max'] };
  const body = await wire(RELAY, 'renamed-model', { level: 'low', models: [{ id: 'renamed-model', name: 'renamed-model', capabilitySnapshot: probeSnapshot(RELAY, 'renamed-model', probe) }] });
  assert.deepEqual(thinkingParams(body), { enable_thinking: true, reasoning_effort: 'high' });
  const off = await wire(RELAY, 'renamed-model', { level: 'none', models: [{ id: 'renamed-model', name: 'renamed-model', capabilitySnapshot: probeSnapshot(RELAY, 'renamed-model', probe) }] });
  assert.deepEqual(thinkingParams(off), { enable_thinking: false });
  // 手动写法优先于测试结果。
  const manual = await wire(RELAY, 'renamed-model', { level: 'low', openaiCompatibleThinkingFormat: 'reasoning_effort', models: [{ id: 'renamed-model', name: 'renamed-model', capabilitySnapshot: probeSnapshot(RELAY, 'renamed-model', probe) }] });
  assert.deepEqual(thinkingParams(manual), { reasoning_effort: 'low' });
  // DeepSeek 官方地址上测出 DeepSeek 写法时仍交给接入库的 DeepSeek 格式。
  assert.equal(libraryProviderKind(probedSettings(DEEPSEEK, 'renamed', { wireFormat: 'deepseek', canDisable: true, levels: [] })), 'deepseek');
});

test('会话思考强度按渠道配置给选项：平台差异、测试结果与手动写法都算进去', () => {
  const values = (baseUrl, model, extra = {}) => sessionThinkingCapability('openai-compatible', model, undefined, undefined, settings(baseUrl, model, extra))?.values;
  assert.deepEqual(values(DEEPSEEK, 'deepseek-v4-pro'), ['none', 'low', 'high', 'max']);
  assert.deepEqual(values(SILICONFLOW, 'deepseek-ai/DeepSeek-V4-Pro'), ['none', 'high', 'max']);
  assert.deepEqual(values(MOONSHOT, 'kimi-k3'), ['low', 'high', 'max']);
  const probe = { wireFormat: 'deepseek', canDisable: false, levels: ['high', 'max'] };
  assert.deepEqual(sessionThinkingCapability('openai-compatible', 'renamed-model', undefined, undefined, probedSettings(RELAY, 'renamed-model', probe)),
    { kind: 'deepseek-effort', values: ['high', 'max'] });
  assert.equal(values(DEEPSEEK, 'deepseek-v4-pro', { openaiCompatibleThinkingFormat: 'omit' }), undefined);
  assert.throws(() => validateSessionThinkingOverride({ kind: 'deepseek-effort', value: 'low' }, 'openai-compatible', 'deepseek-ai/DeepSeek-V4-Pro',
    undefined, undefined, settings(SILICONFLOW, 'deepseek-ai/DeepSeek-V4-Pro')), /不支持/);
  assert.deepEqual(validateSessionThinkingOverride({ kind: 'deepseek-effort', value: 'max' }, 'openai-compatible', 'renamed-model',
    undefined, undefined, probedSettings(RELAY, 'renamed-model', probe)), { kind: 'deepseek-effort', value: 'max' });
});
