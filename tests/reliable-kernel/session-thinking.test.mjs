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

test('默认展示区分未设置（由服务决定）、非法 Gemini 配置和 Astra adapter 映射', async () => {
  assert.equal(sessionThinkingDisplayLabel('gemini', 'gemini-3.1-pro-preview'), '未设置（由服务决定）');
  const gemini = await ordinaryWire('gemini', 'gemini-3.1-pro-preview', {});
  assert.equal(gemini.generationConfig?.thinkingConfig, undefined);
  await assert.rejects(ordinaryWire('gemini', 'gemini-3.1-pro-preview', { thinkingConfig: { thinkingBudget: 4096 } }), /Unsupported Gemini thinking/);
  assert.equal(sessionThinkingDisplayLabel('gemini', 'gemini-3.1-pro-preview', { thinkingBudget: 4096 }), '配置不受支持（请求会拒绝）');
  assert.equal(sessionThinkingDisplayLabel('gemini', 'gemini-2.5-flash', { thinkingLevel: 'high' }), '配置不受支持（请求会拒绝）');
  assert.equal(sessionThinkingDisplayLabel('openai-responses', 'gpt-6-astra', { thinkingLevel: 'none' }), 'low（适配器）');
  const astra = await ordinaryWire('openai-responses', 'gpt-6-astra', { thinkingConfig: { thinkingLevel: 'none' } });
  assert.equal(astra.reasoning.effort, 'low');
});

const matrix = [
  ['openai-compatible', 'o3', { kind: 'openai-effort', value: 'high' }, body => assert.equal(body.reasoning_effort, 'high')],
  ['openai-responses', 'o3', { kind: 'openai-effort', value: 'high' }, body => assert.equal(body.reasoning.effort, 'high')],
  ['gemini', 'gemini-2.5-flash', { kind: 'gemini-budget', tokens: 0 }, body => assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 0)],
  ['gemini', 'gemini-2.5-pro', { kind: 'gemini-budget', tokens: -1 }, body => assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, -1)],
  ['gemini', 'gemini-3.1-pro-preview', { kind: 'gemini-level', value: 'medium' }, body => assert.equal(body.generationConfig.thinkingConfig.thinkingLevel.toLowerCase(), 'medium')],
  ['claude', 'claude-sonnet-4-5', { kind: 'claude-budget', tokens: 2048 }, body => { assert.equal(body.thinking.budget_tokens, 2048); assert.equal(body.thinking.type, 'enabled'); assert.equal(body.output_config, undefined); }],
  ['claude', 'claude-opus-4-6', { kind: 'claude-effort', value: 'high' }, body => { assert.equal(body.thinking.type, 'adaptive'); assert.equal(body.output_config.effort, 'high'); assert.equal(body.thinking.budget_tokens, undefined); }],
  ['claude', 'claude-opus-4-6', { kind: 'claude-effort', value: 'none' }, body => assert.equal(body.thinking.type, 'disabled')],
  ['openai-compatible', 'deepseek-reasoner', { kind: 'deepseek-effort', value: 'high' }, body => { assert.equal(body.thinking.type, 'enabled'); assert.equal(body.reasoning_effort, 'high'); }],
  ['openai-compatible', 'deepseek-v4-pro', { kind: 'deepseek-effort', value: 'none' }, body => { assert.deepEqual(body.thinking, { type: 'disabled' }); assert.equal(body.reasoning_effort, undefined); }],
  ['openai-compatible', 'glm-5.2', { kind: 'deepseek-effort', value: 'max' }, body => { assert.equal(body.thinking.type, 'enabled'); assert.equal(body.reasoning_effort, 'max'); }]
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
  assert.throws(() => validate({ kind: 'openai-effort', value: 'high' }, 'gemini', 'gemini-3.1-pro-preview'));
  assert.throws(() => validate({ kind: 'gemini-level', value: 'medium' }, 'gemini', 'gemini-3-pro'));
  assert.throws(() => validate({ kind: 'claude-budget', tokens: 1023 }, 'claude', 'claude-sonnet-4-5', { maxOutputTokens: 8192 }));
  assert.equal(thinkingValueLabel(), '未设置（由服务决定）');
  assert.equal(thinkingValueLabel({ thinkingBudget: 0 }), '0 tokens');
  assert.equal(thinkingValueLabel({ thinkingLevel: 'none' }), 'none');
  assert.equal(thinkingValueLabel({ thinkingBudget: -1 }), '自动（-1）');
});

test('自定义请求体冲突仅针对思维/输出字段，无关自定义字段允许保留', () => {
  for (const [provider, body] of [['openai-compatible', { reasoning_effort: 'low' }], ['openai-responses', { reasoning: { effort: 'low' } }], ['claude', { thinking: { budget_tokens: 1024 } }], ['gemini', { generationConfig: { thinkingConfig: { thinkingBudget: 0 } } }], ['openai-compatible', { thinking: { type: 'disabled' } }], ['openai-compatible', { enable_thinking: false }], ['openai-compatible', { chat_template_kwargs: { enable_thinking: false } }]]) assert.equal(hasThinkingBodyConflict(provider, body), true);
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

test('Claude 4.7 及之后的 adaptive 模型可按会话选择 effort，始终开启的模型不提供关闭', async () => {
  // 能力表 anthropic_adaptive（https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting）。
  assert.deepEqual(capability('claude', 'claude-opus-5-5'), { kind: 'claude-effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] });
  assert.deepEqual(capability('claude', 'claude-fable-5-1-20260801'), { kind: 'claude-effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] });
  assert.deepEqual(capability('claude', 'claude-sonnet-5'), { kind: 'claude-effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] });
  assert.deepEqual(capability('claude', 'claude-opus-4-6'), { kind: 'claude-effort', values: ['none', 'low', 'medium', 'high', 'max'] }, '4.6 unchanged');
  assert.deepEqual(capability('claude', 'claude-sonnet-4-5', 32000), { kind: 'claude-budget', min: 1024, max: 31999 }, 'extended unchanged');
  assert.equal(capability('claude', 'claude-unknown-9'), undefined, 'unknown models are not guessed');
  assert.throws(() => validate({ kind: 'claude-effort', value: 'none' }, 'claude', 'claude-opus-5-5'));
  const override = validate({ kind: 'claude-effort', value: 'xhigh' }, 'claude', 'claude-opus-5-5');
  const body = await ordinaryWire('claude', 'claude-opus-5-5', apply({}, override));
  assert.deepEqual(body.thinking, { type: 'adaptive' });
  assert.equal(body.output_config?.effort, 'xhigh');
  const off = await ordinaryWire('claude', 'claude-sonnet-5', apply({}, validate({ kind: 'claude-effort', value: 'none' }, 'claude', 'claude-sonnet-5')));
  assert.equal(off.output_config?.effort, undefined);
  assert.notEqual(off.thinking?.type, 'adaptive');
});

const { resolveSavedSessionThinkingOverride } = require('../../dist/extension/shared/sessionThinking.js');
const deepseekChannel = (model = 'deepseek-v4-pro', extra = {}) => ({ id: 'legacy', provider: 'openai-compatible', baseUrl: 'https://api.deepseek.com/v1', model, models: [{ id: model, name: model }], modelConfigs: [], ...extra });

test('已保存的会话思考覆盖容错解析：强度类 kind 不同但值可用时改写 kind，否则不生效', () => {
  const saved = (value, provider, model, generation, body, config) => resolveSavedSessionThinkingOverride(value, provider, model, generation, body, config);
  assert.deepEqual(saved({ kind: 'openai-effort', value: 'high' }, 'openai-compatible', 'deepseek-v4-pro', undefined, undefined, deepseekChannel()),
    { status: 'applied', override: { kind: 'deepseek-effort', value: 'high' } });
  for (const model of ['glm-4.6', 'qwen3-max', 'kimi-k2-0905-preview']) {
    assert.equal(saved({ kind: 'openai-effort', value: 'high' }, 'openai-compatible', model).status, 'applied', model);
  }
  assert.equal(saved({ kind: 'openai-effort', value: 'medium' }, 'openai-compatible', 'deepseek-v4-pro', undefined, undefined, deepseekChannel()).status, 'inactive');
  // 原 DeepSeek 渠道上的中转别名：现在按渠道配置给 openai-effort。
  assert.deepEqual(saved({ kind: 'deepseek-effort', value: 'high' }, 'openai-compatible', 'relay-alias', { thinkingConfig: { thinkingLevel: 'high' } }),
    { status: 'applied', override: { kind: 'openai-effort', value: 'high' } });
  // Opus 5.5 / Fable / Mythos 以前保存的 none 现在不合法。
  for (const model of ['claude-opus-5-5', 'claude-fable-5', 'claude-mythos-5']) {
    const result = saved({ kind: 'claude-effort', value: 'none' }, 'claude', model);
    assert.equal(result.status, 'inactive', model);
    assert.match(result.reason, /不适用于当前模型/);
  }
  // 预算类不跨 kind 改写。
  assert.equal(saved({ kind: 'gemini-budget', tokens: 2048 }, 'claude', 'claude-sonnet-4-5', { maxOutputTokens: 8192 }).status, 'inactive');
  // 自定义请求体控制思考：不生效，不报错。
  assert.equal(saved({ kind: 'deepseek-effort', value: 'high' }, 'openai-compatible', 'deepseek-v4-pro', undefined, { enable_thinking: false }, deepseekChannel()).status, 'inactive');
  assert.throws(() => validate({ kind: 'openai-effort', value: 'high' }, 'openai-compatible', 'deepseek-v4-pro', undefined, undefined, deepseekChannel()), '保存时仍然严格校验');
});

test('chat_template_kwargs 只在含思考相关子键时才算与会话思考冲突', () => {
  assert.equal(hasThinkingBodyConflict('openai-compatible', { chat_template_kwargs: { add_generation_prompt: true } }), false);
  for (const key of ['enable_thinking', 'thinking', 'reasoning_effort', 'thinking_budget']) {
    assert.equal(hasThinkingBodyConflict('openai-compatible', { chat_template_kwargs: { [key]: true } }), true, key);
  }
  assert.equal(resolveSavedSessionThinkingOverride({ kind: 'deepseek-effort', value: 'high' }, 'openai-compatible', 'deepseek-v4-pro', undefined,
    { chat_template_kwargs: { add_generation_prompt: true } }, deepseekChannel()).status, 'applied');
});

test('Claude 档位按官方文档：Mythos Preview 没有关闭和 xhigh，Sonnet 4.6 有 max，渠道配置不能放宽已知模型', () => {
  // https://platform.claude.com/docs/en/build-with-claude/effort：max / xhigh 支持列表；Mythos Preview 始终思考。
  assert.deepEqual(capability('claude', 'claude-mythos-preview'), { kind: 'claude-effort', values: ['low', 'medium', 'high', 'max'] });
  assert.deepEqual(capability('claude', 'claude-mythos-preview', undefined, { thinkingLevel: 'xhigh' }).values, ['low', 'medium', 'high', 'max']);
  assert.deepEqual(capability('claude', 'claude-sonnet-4-6'), { kind: 'claude-effort', values: ['none', 'low', 'medium', 'high', 'max'] });
  assert.deepEqual(capability('claude', 'claude-opus-4.6', undefined, { thinkingLevel: 'xhigh' }).values, ['none', 'low', 'medium', 'high', 'max']);
});

test('Claude 4.7 及之后：非默认的 temperature / top_p / top_k 无论是否思考都冲突', () => {
  // https://platform.claude.com/docs/en/build-with-claude/thinking：“non-default temperature, top_p, or top_k values return a 400 error on every request, regardless of whether thinking is used.”
  assert.throws(() => validate({ kind: 'claude-effort', value: 'none' }, 'claude', 'claude-sonnet-5', { temperature: 0.7 }), /采样/);
  assert.throws(() => validate({ kind: 'claude-effort', value: 'high' }, 'claude', 'claude-opus-5-5', { topP: 0.95 }), /采样/);
  assert.throws(() => validate({ kind: 'claude-effort', value: 'high' }, 'claude', 'claude-mythos-preview', {}, { top_k: 5 }), /采样/);
  validate({ kind: 'claude-effort', value: 'high' }, 'claude', 'claude-opus-5-5', { temperature: 1 });
  validate({ kind: 'claude-effort', value: 'high' }, 'claude', 'claude-opus-4-6', { topP: 0.95 });
  validate({ kind: 'claude-effort', value: 'none' }, 'claude', 'claude-opus-4-6', { temperature: 0.7 });
});

test('始终思考的模型渠道设了 none 时，说明实际仍会思考', () => {
  assert.equal(sessionThinkingDisplayLabel('claude', 'claude-opus-5-5', { thinkingLevel: 'none' }), 'none，模型始终思考，实际仍会思考');
  assert.equal(sessionThinkingDisplayLabel('claude', 'claude-sonnet-5', { thinkingLevel: 'none' }), 'none');
});
