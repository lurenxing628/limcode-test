import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { sessionThinkingDisplayLabel, sessionThinkingCapability: capability, validateSessionThinkingOverride: validate, applySessionThinkingOverride: apply, thinkingValueLabel } = require('../../dist/extension/shared/sessionThinking.js');
const { hasThinkingBodyConflict } = require('../../dist/extension/shared/sessionThinkingBody.js');
const { dryRunLlmProvider } = require('../../dist/extension/backend/capabilities/llmProvider.js');
const { LlmCapabilityFullRequestAdapter } = require('../../dist/extension/backend/reliableKernel/llmCapabilityProviderAdapter.js');
const { LlmEventType } = require('../../dist/extension/backend/world/modules/llm/events.js');

export async function ordinaryWire(provider, model, generationConfig, transport = 'http', body = {}) {
  let projected;
  const adapter = new LlmCapabilityFullRequestAdapter('fixture-provider', {
    start(request, emit) { projected = request; emit({ type: LlmEventType.Done, payload: { requestId: request.id } }); },
    abort() {}, dispose() {}
  });
  await adapter.sendFullRequest({
    kind: 'full-model-request', modelRequestId: 'thinking-matrix', conversationId: 'fixture-session', attemptSeq: '1', socketGeneration: '1',
    providerId: 'fixture-provider', modelId: model,
    authoritySnapshot: { model: { providerConfigId: 'fixture-provider', provider, modelId: model, generationConfig, requestBody: body }, toolPolicy: { allowedTools: [], preset: 'custom', sourceConfigs: {} } },
    recipe: { tools: [] }, context: [{ segmentId: 'input', segmentKind: 'message', messageRole: 'user', contentType: 'application/vnd.limcode.message+json', content: JSON.stringify({ role: 'user', parts: [{ text: 'synthetic fixture' }] }) }],
    attachmentCatalogState: { catalog: [], placements: [] }
  }, { async onEvent() { return { accepted: true, checkpointed: true, terminal: true }; } });
  assert.deepEqual(projected.settingsSnapshot.generationConfig, generationConfig);
  const result = await dryRunLlmProvider(projected, { settings: {
    id: 'fixture-provider', name: 'Synthetic fixture', provider, model, models: [{ id: model, name: model }], modelConfigs: [],
    baseUrl: 'https://example.invalid/v1', apiKey: '', stream: true, openaiResponsesTransport: transport, toolCallFormat: 'function-call',
    systemPromptPrefix: '', generationConfig: { thinkingConfig: { thinkingLevel: 'low' } }, requestBody: { test_later_setting: 'must not leak' },
    createdAt: 1, updatedAt: 1, promptCache: { enabled: false }
  } });
  assert.equal(result.body.test_later_setting, undefined);
  return result.body;
}

test('默认展示区分服务默认和既有 adapter 映射，不虚构预算', async () => {
  assert.equal(sessionThinkingDisplayLabel('gemini', 'gemini-3.1-pro'), '服务默认（适配器：high）');
  const gemini = await ordinaryWire('gemini', 'gemini-3.1-pro', { thinkingConfig: { thinkingBudget: 4096 } });
  assert.equal(gemini.generationConfig.thinkingConfig.thinkingLevel.toLowerCase(), 'high');
  assert.equal(gemini.generationConfig.thinkingConfig.thinkingBudget, undefined);
  assert.equal(sessionThinkingDisplayLabel('gemini', 'gemini-3.1-pro', { thinkingBudget: 4096 }), '渠道配置已适配（适配器：high）');
  assert.equal(sessionThinkingDisplayLabel('openai-responses', 'gpt-6-astra', { thinkingLevel: 'none' }), 'low（适配器）');
  const astra = await ordinaryWire('openai-responses', 'gpt-6-astra', { thinkingConfig: { thinkingLevel: 'none' } });
  assert.equal(astra.reasoning.effort, 'low');
});

const matrix = [
  ['openai-compatible', 'o3', { kind: 'openai-effort', value: 'high' }, body => assert.equal(body.reasoning_effort, 'high')],
  ['openai-responses', 'o3', { kind: 'openai-effort', value: 'high' }, body => assert.equal(body.reasoning.effort, 'high')],
  ['gemini', 'gemini-2.5-flash', { kind: 'gemini-budget', tokens: 0 }, body => assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0)],
  ['gemini', 'gemini-2.5-pro', { kind: 'gemini-budget', tokens: -1 }, body => assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, -1)],
  ['gemini', 'gemini-3.1-pro', { kind: 'gemini-level', value: 'medium' }, body => assert.equal(body.generationConfig.thinkingConfig.thinkingLevel.toLowerCase(), 'medium')],
  ['claude', 'claude-sonnet-4-5', { kind: 'claude-budget', tokens: 2048 }, body => { assert.equal(body.thinking.budget_tokens, 2048); assert.equal(body.thinking.type, 'enabled'); assert.equal(body.output_config, undefined); }],
  ['claude', 'claude-opus-4-6', { kind: 'claude-effort', value: 'high' }, body => { assert.equal(body.thinking.type, 'adaptive'); assert.equal(body.output_config.effort, 'high'); assert.equal(body.thinking.budget_tokens, undefined); }],
  ['claude', 'claude-opus-4-6', { kind: 'claude-effort', value: 'none' }, body => assert.equal(body.thinking.type, 'disabled')],
  ['deepseek', 'deepseek-reasoner', { kind: 'deepseek-effort', value: 'high' }, body => { assert.equal(body.thinking.type, 'enabled'); assert.equal(body.reasoning_effort, 'high'); }]
];
for (const [provider, model, override, check] of matrix) test(`普通 adapter → 实际 dry-run body: ${provider}/${model}/${JSON.stringify(override)}`, async () => {
  const defaults = { maxOutputTokens: 32768 };
  validate(override, provider, model, defaults);
  check(await ordinaryWire(provider, model, apply(defaults, override)));
});

test('Responses HTTP/WS high → 默认省略，快照空对象不能回读实时 low；保留无关 custom body', async () => {
  for (const transport of ['http', 'websocket']) {
    const high = await ordinaryWire('openai-responses', 'o3', apply(undefined, { kind: 'openai-effort', value: 'high' }), transport);
    assert.equal(high.reasoning.effort, 'high');
    const reset = await ordinaryWire('openai-responses', 'o3', {}, transport, { metadata: { fixture: 'keep' } });
    assert.equal(reset.reasoning, undefined);
    assert.deepEqual(reset.metadata, { fixture: 'keep' });
  }
});

test('渠道已配置的兼容型号复用参数定义，保存后的真实wire保留所选等级', async () => {
  for (const [provider, model] of [['openai-compatible', 'gpt-5.6-terra'], ['openai-responses', 'relay-reasoner'], ['claude', 'relay-claude']]) {
    const defaults = { thinkingConfig: { thinkingLevel: 'high' } };
    const override = { kind: provider === 'claude' ? 'claude-effort' : 'openai-effort', value: 'medium' };
    assert.ok(capability(provider, model, undefined, defaults.thinkingConfig).values.includes('medium'));
    validate(override, provider, model, defaults);
    const body = await ordinaryWire(provider, model, apply(defaults, override));
    assert.equal(provider === 'claude' ? body.output_config.effort : provider === 'openai-responses' ? body.reasoning.effort : body.reasoning_effort, 'medium');
  }
});

test('能力负例与特殊值：未知不猜测、格式不等价、合法范围和输出限制', () => {
  assert.equal(capability('openai-compatible', 'relay-custom-model'), undefined);
  assert.equal(capability('openai-compatible', 'gpt-4o'), undefined);
  assert.equal(capability('openai-compatible', 'o1-mini'), undefined);
  assert.equal(capability('gemini', 'gemini-2.0-flash'), undefined);
  assert.equal(capability('claude', 'claude-sonnet-4-5'), undefined, 'Claude numeric budget needs an explicit max output');
  assert.throws(() => validate({ kind: 'gemini-budget', tokens: 0 }, 'gemini', 'gemini-2.5-pro'));
  assert.throws(() => validate({ kind: 'gemini-budget', tokens: -2 }, 'gemini', 'gemini-2.5-flash'));
  assert.throws(() => validate({ kind: 'gemini-budget', tokens: 32769 }, 'gemini', 'gemini-2.5-pro'));
  assert.throws(() => validate({ kind: 'gemini-budget', tokens: 1024 }, 'gemini', 'gemini-2.5-flash', { maxOutputTokens: 1024 }));
  assert.throws(() => validate({ kind: 'openai-effort', value: 'high' }, 'gemini', 'gemini-3.1-pro'));
  assert.throws(() => validate({ kind: 'gemini-level', value: 'medium' }, 'gemini', 'gemini-3-pro'));
  assert.throws(() => validate({ kind: 'claude-budget', tokens: 1023 }, 'claude', 'claude-sonnet-4-5', { maxOutputTokens: 8192 }));
  assert.equal(thinkingValueLabel(), '服务默认');
  assert.equal(thinkingValueLabel({ thinkingBudget: 0 }), '0 tokens');
  assert.equal(thinkingValueLabel({ thinkingLevel: 'none' }), 'none');
  assert.equal(thinkingValueLabel({ thinkingBudget: -1 }), '自动（-1）');
});

test('自定义请求体冲突仅针对思维/输出字段，无关自定义字段允许保留', () => {
  for (const [provider, body] of [['openai-compatible', { reasoning_effort: 'low' }], ['openai-responses', { reasoning: { effort: 'low' } }], ['claude', { thinking: { budget_tokens: 1024 } }], ['gemini', { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }], ['deepseek', { thinking: { type: 'disabled' } }]]) assert.equal(hasThinkingBodyConflict(provider, body), true);
  assert.equal(hasThinkingBodyConflict('openai-responses', { metadata: { fixture: true } }), false);
});

test('review P2-3 GPT-5.1不得开放xhigh，未知小版本不由小数点推能力', () => {
  for (const model of ['gpt-5.1', 'gpt-5.1-2025-11-13']) {
    assert.deepEqual(capability('openai-responses', model)?.values, ['none', 'low', 'medium', 'high']);
    assert.throws(() => validate({ kind: 'openai-effort', value: 'xhigh' }, 'openai-responses', model));
  }
  assert.equal(capability('openai-compatible', 'gpt-5.99'), undefined);
});
test('review P2-4 Claude预算与采样配置不能同时形成非法wire，也不暗改默认', async () => {
  const override = { kind: 'claude-budget', tokens: 2048 };
  for (const sampling of [{ temperature: 0.7 }, { topK: 2 }, { topP: 0.8 }]) {
    const generation = { maxOutputTokens: 8192, ...sampling };
    assert.throws(() => validate(override, 'claude', 'claude-sonnet-4-5', generation), /采样|temperature|top/);
    assert.deepEqual(generation, { maxOutputTokens: 8192, ...sampling });
  }
  const generation = { maxOutputTokens: 8192, temperature: 1 };
  validate(override, 'claude', 'claude-sonnet-4-5', generation);
  const wire = await ordinaryWire('claude', 'claude-sonnet-4-5', apply(generation, override));
  assert.equal(wire.temperature, 1);
  assert.equal(wire.thinking.budget_tokens, 2048);
});
test('review P2-5 Gemini只检测会覆盖思维/输出的nested字段', async () => {
  for (const body of [{ generationConfig: {} }, { generationConfig: { temperature: 0.2 } }]) assert.equal(hasThinkingBodyConflict('gemini', body), false);
  for (const body of [{ generationConfig: null }, { generationConfig: false }, { generationConfig: { maxOutputTokens: 1 } }, { generationConfig: { thinkingConfig: null } }]) assert.equal(hasThinkingBodyConflict('gemini', body), true);
  const wire = await ordinaryWire('gemini', 'gemini-2.5-flash', apply({ maxOutputTokens: 8192 }, { kind: 'gemini-budget', tokens: 2048 }), 'http', { generationConfig: { temperature: 0.2 }, custom_field: 'keep' });
  assert.equal(wire.generationConfig.temperature, 0.2);
  assert.equal(wire.generationConfig.thinkingConfig.thinkingBudget, 2048);
  assert.equal(wire.custom_field, 'keep');
});

