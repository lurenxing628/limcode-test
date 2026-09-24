import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const caps = require('../../dist/extension/shared/modelCapabilities.js');
const execution = require('../../dist/extension/shared/compressionExecution.js');
const ts = require('typescript');
const noticeSource = readFileSync(new URL('../../shared/compressionNotices.ts', import.meta.url), 'utf8');
const noticeExports = {};
new Function('require', 'exports', ts.transpileModule(noticeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText)(createRequire(new URL('../../dist/extension/shared/compressionNotices.js', import.meta.url)), noticeExports);
const { projectCompressionNotices } = noticeExports;
const { summaryRequestBody, frozenSummaryReasoning } = require('../../dist/extension/backend/capabilities/summaryReasoning.js');
const { parseAnthropicCapabilities, discoverAnthropicModels } = require('../../dist/extension/backend/capabilities/modelCapabilityDiscovery.js');
const { restoredProviderRequestFailure } = require('../../dist/extension/backend/reliableKernel/modelProviderControlPlane.js');

const hosts = { 'openai-responses': 'https://api.openai.com/v1', claude: 'https://api.anthropic.com', gemini: 'https://generativelanguage.googleapis.com' };
const capability = (provider, modelId, baseUrl = hosts[provider]) => caps.resolveModelCapabilities({ provider, modelId, baseUrl, providerConfigId: 'channel', transport: 'http' });
const reason = (capabilities, mode, thinkingConfig) => caps.resolveSummaryReasoning({ capabilities, mode,
  methodGenerationConfig: thinkingConfig ? { thinkingConfig } : undefined,
  inheritedGenerationConfig: { thinkingConfig: { thinkingLevel: 'high' }, temperature: 0.7 }
});
const config = (provider = 'openai-responses', model = 'gpt-5.4') => ({ id: 'channel', provider, model, baseUrl: hosts[provider],
  models: [{ id: model, name: model }], modelConfigs: [], openaiResponsesTransport: 'http', apiKey: 'test-key' });
const method = (kind = 'auto', fallbacks = ['segmented_summary', 'deterministic_summary', 'continue_uncompressed_if_fits']) => ({ kind, fallbacks });

test('unknown channels, future names and spoofed official endpoints do not inherit model capabilities', () => {
  for (const url of ['https://gateway.example/v1', 'http://api.openai.com/v1', 'https://api.openai.com:444/v1',
    'https://api.openai.com/other', 'https://api.openai.com/v1?token=secret', 'https://user:pass@api.openai.com/v1']) {
    const value = capability('openai-responses', 'gpt-5.4', url);
    assert.equal(value.nativeCompaction.availability, 'unknown', url);
    assert.equal(value.reasoning.family, 'none', url);
    assert.ok(!JSON.stringify(value).includes('secret'));
    assert.ok(!JSON.stringify(value).includes('pass@'));
  }
  for (const id of ['gpt-5.99', 'gpt-5.4-gateway-low', '[route]gpt-5.4']) {
    assert.equal(capability('openai-responses', id).reasoning.family, 'none');
  }
  assert.equal(capability('gemini', 'gemini-9-flash').reasoning.family, 'none');
});

test('documented native capability is not mislabeled as a live verification', () => {
  const value = capability('openai-responses', 'gpt-5.4');
  assert.equal(value.source, 'official_registry');
  assert.equal(value.nativeCompaction.availability, 'documented');
  assert.match(caps.capabilityDisplayLabel(value), /未实测/);
  assert.equal(value.registryRevision, caps.MODEL_CAPABILITY_REGISTRY_REVISION);
  assert.equal(caps.resolveCompressionExecutionPlan(method(), value).attempts[0].methodKind, 'segmented_summary');
  const declared = caps.resolveProviderModelCapabilities(config(), undefined, 'trust_configured_endpoint');
  assert.equal(caps.resolveCompressionExecutionPlan(method(), declared).attempts[0].methodKind, 'provider_native');
});

for (const [provider, model] of [['openai-responses', 'gpt-5.4'], ['claude', 'claude-opus-4-6'], ['gemini', 'gemini-2.5-pro']]) {
  test(`${provider} summary provider_default omits controls rather than inheriting high`, () => {
    const resolved = reason(capability(provider, model), 'provider_default');
    assert.equal(resolved.generationConfig?.thinkingConfig, undefined);
    assert.equal(resolved.requestBody, undefined);
    assert.deepEqual(summaryRequestBody({ reasoning: { effort: 'high' }, thinking: { type: 'enabled', budget_tokens: 9000 },
      reasoning_effort: 'high', generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
      extra_body: { google: { thinking_config: { thinking_budget: 9000 } } },
      max_tokens: 2, response_format: { type: 'json_object' }, tools: [], model: 'wrong-model'
    }, resolved), {});
  });
}

test('OpenAI exact supported effort and no forced summary=detailed', () => {
  const value = capability('openai-responses', 'gpt-5.4');
  assert.deepEqual(reason(value, 'balanced').requestBody, { reasoning: { effort: 'medium' } });
  assert.throws(() => caps.assertSummaryReasoningPlan(reason(capability('openai-responses', 'gpt-6-astra'), 'disabled')), /关闭/);
  const explicit = reason(value, 'explicit', { thinkingLevel: 'max' });
  assert.equal(explicit.status, 'unsupported');
  assert.throws(() => caps.assertSummaryReasoningPlan(explicit));
});

test('Claude extended-only budget does not become adaptive; effort is independent', () => {
  const old = capability('claude', 'claude-sonnet-4-5');
  assert.deepEqual(reason(old, 'explicit', { thinkingBudget: 2048 }).requestBody,
    { thinking: { type: 'enabled', budget_tokens: 2048 } });
  assert.equal(reason(old, 'explicit', { thinkingLevel: 'medium' }).status, 'unsupported');
  const opus = capability('claude', 'claude-opus-4-5');
  assert.deepEqual(reason(opus, 'balanced').requestBody, { output_config: { effort: 'medium' } });
  assert.equal(reason(old, 'explicit', { thinkingBudget: 1023 }).status, 'unsupported');
});

test('Claude adaptive-only rejects budgets and always-on rejects disabled', () => {
  const newer = capability('claude', 'claude-opus-4-7');
  assert.equal(reason(newer, 'explicit', { thinkingBudget: 2048 }).status, 'unsupported');
  assert.deepEqual(reason(newer, 'balanced').requestBody,
    { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } });
  assert.equal(newer.reasoning.canDisable, true);
  assert.equal(reason(capability('claude', 'claude-fable-5'), 'disabled').status, 'unsupported');
});

test('Gemini generateContent 2.5 budget and OpenAI compatibility effort are distinct', () => {
  const native = capability('gemini', 'gemini-2.5-pro');
  assert.equal(native.reasoning.family, 'gemini_budget');
  assert.deepEqual(native.reasoning.levels, []);
  assert.equal(reason(native, 'explicit', { thinkingLevel: 'medium' }).status, 'unsupported');
  assert.deepEqual(reason(native, 'explicit', { thinkingBudget: 8192, includeThoughts: false }).requestBody,
    { generationConfig: { thinkingConfig: { thinkingBudget: 8192, includeThoughts: false } } });
  assert.equal(reason(native, 'disabled').status, 'unsupported');
  assert.deepEqual(reason(capability('gemini', 'gemini-2.5-flash'), 'disabled').requestBody,
    { generationConfig: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } } });
  const compatible = capability('openai-compatible', 'gemini-2.5-pro', 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.deepEqual(reason(compatible, 'balanced').requestBody, { reasoning_effort: 'medium' });
  assert.deepEqual(reason(compatible, 'explicit', { thinkingBudget: 8192 }).requestBody,
    { extra_body: { google: { thinking_config: { thinking_budget: 8192 } } } });
  assert.equal(reason(compatible, 'explicit', { thinkingBudget: 8192, thinkingLevel: 'medium' }).status, 'unsupported');
});

test('Gemini levels/defaults are exact model facts; unknown values do not silently become high', () => {
  assert.equal(capability('gemini', 'gemini-3.8-flash').reasoning.defaultLevel, 'medium');
  assert.equal(capability('gemini', 'gemini-3.5-flash-lite').reasoning.defaultLevel, 'minimal');
  const earlier = capability('gemini', 'gemini-3-pro-preview');
  assert.equal(reason(earlier, 'balanced').requestBody, undefined);
  assert.equal(reason(earlier, 'explicit', { thinkingLevel: 'medium' }).status, 'unsupported');
});

test('explicit empty fallback chain is honored and unknown native endpoints are not guessed', () => {
  const value = capability('openai-responses', 'some-model', 'https://gateway.example/v1');
  assert.deepEqual(caps.resolveCompressionExecutionPlan(method('auto', []), value).attempts, []);
  assert.deepEqual(caps.resolveCompressionExecutionPlan(method(), value).attempts.map((a) => a.methodKind),
    ['segmented_summary', 'deterministic_summary']);
  assert.deepEqual(caps.resolveCompressionExecutionPlan(method('disabled'), value).attempts, []);
});

test('capability evidence is bound to channel, endpoint, model and transport and survives normalization', () => {
  const provider = config();
  const evidence = { ...caps.resolveProviderModelCapabilities(provider), source: 'verified_probe', verifiedAt: '2026-09-22T00:00:00Z',
    nativeCompaction: { kind: 'openai_responses', availability: 'unsupported', reason: 'HTTP 404' } };
  provider.models[0].capabilitySnapshot = evidence;
  assert.equal(caps.resolveProviderModelCapabilities(provider).nativeCompaction.availability, 'unsupported');
  assert.equal(caps.resolveProviderModelCapabilities(provider, undefined, 'trust_configured_endpoint').nativeCompaction.availability, 'declared');
  for (const patch of [{ id: 'other' }, { baseUrl: 'https://new.example/v1' }, { openaiResponsesTransport: 'websocket' }]) {
    assert.notEqual(caps.resolveProviderModelCapabilities({ ...provider, ...patch }).source, 'verified_probe');
  }
  assert.deepEqual(caps.normalizeModelCapabilitySnapshot({ ...evidence, apiKey: 'must-not-persist' }), evidence);
  assert.equal(caps.normalizeModelCapabilitySnapshot({ ...evidence, reasoning: { family: 'guess' } }), undefined);
});

test('Anthropic API distinguishes on-demand summarize from threshold compaction', () => {
  const baseline = capability('claude', 'claude-opus-4-6');
  const raw = { thinking: { supported: true, types: { enabled: { supported: false }, adaptive: { supported: true } } },
    effort: { supported: true, low: { supported: true }, medium: { supported: true } },
    context_management: { compact_20260112: { supported: true } } };
  const thresholdOnly = parseAnthropicCapabilities(raw, baseline, '2026-09-22T00:00:00Z');
  assert.equal(thresholdOnly.reasoning.family, 'anthropic_adaptive');
  assert.equal(thresholdOnly.reasoning.supportsBudget, false);
  assert.equal(thresholdOnly.nativeCompaction.availability, 'unknown');
  const actual = parseAnthropicCapabilities({ ...raw, compaction: { supported: true, summarize: { supported: true } } }, baseline, '2026-09-22T00:00:00Z');
  assert.equal(actual.nativeCompaction.availability, 'verified');
  assert.equal(actual.source, 'provider_api');
});

test('explicit model refresh follows pagination and never issues compaction or includes prompts', async () => {
  const provider = config('claude', 'claude-opus-4-6');
  const seen = [];
  const found = await discoverAnthropicModels(provider, async (url, options) => {
    seen.push({ url, options });
    return new Response(JSON.stringify({ data: [{ id: `model-${seen.length}`, display_name: 'model' }],
      has_more: seen.length === 1, last_id: `model-${seen.length}` }), { status: 200 });
  });
  assert.equal(found.length, 2);
  assert.match(seen[1].url, /after_id=model-1/);
  assert.equal(seen[0].options.body, undefined);
  assert.equal(seen[0].options.redirect, 'error');
  assert.ok(seen.every((entry) => new URL(entry.url).pathname === '/v1/models'));
  await assert.rejects(discoverAnthropicModels(provider, async () => new Response(JSON.stringify({ data: [], has_more: true }))), /游标/);
});

test('durable failure facts remain typed after recovery and redact secrets', () => {
  const message = execution.safeProviderFailureMessage('failed https://user:pass@api.example/v1?token=secret Bearer abcdef api_key=abcdef sk-secretxyz');
  assert.ok(!message.includes('abcdef') && !message.includes('secretxyz') && !message.includes('user:pass'));
  const fact = { category: 'capability', status: 404, message, reason: 'native_compaction_unsupported' };
  const restored = restoredProviderRequestFailure(fact, 'provider_failed');
  assert.equal(restored.category, 'capability'); assert.equal(restored.status, 404);
  assert.throws(() => execution.readProviderRequestFailure({ ...fact, rawHeaders: { authorization: 'secret' } }));
  assert.throws(() => execution.readCompressionDecision({ groupId: 'g', outcome: 'continued_uncompressed', failures: [], estimatedTokens: 20, limitTokens: 10 }));
});

const created = '2026-09-22T00:00:01Z';
const decision = { groupId: 'g', outcome: 'continued_uncompressed', estimatedTokens: 20, limitTokens: 100,
  failures: [{ methodKind: 'provider_native', message: 'unsupported', status: 404, modelRequestId: 'r1' }] };
const noticeInput = () => ({ conversationId: 'c', records: {
  Turn: { t: { id: 't', conversation_id: 'c' } },
  ModelRequest: { r2: { id: 'r2', turn_id: 't', created_at: created, stream_stats_json: { compressionDecision: decision } } }
}, messages: [{ id: 'm', role: 'user', createdAt: Date.parse(created) - 1000 }], turnIdByMessageId: { m: 't' } });

test('compression notices come from committed decisions, include original failure, and survive missing details', () => {
  const result = projectCompressionNotices(noticeInput());
  assert.equal(result.byAnchor.m.length, 1);
  assert.match(result.byAnchor.m[0].detail, /HTTP 404/);
  assert.match(result.byAnchor.m[0].detail, /20 Token/);
  assert.deepEqual(result.unanchored, []);
});

test('no-message maintenance failure is visible, old off-window facts and duplicate placements are not moved', () => {
  const input = noticeInput();
  input.records.TurnTermination = { f: { id: 'f', turn_id: 't', terminal_status: 'failed', reason: 'HTTP 404', created_at: created } };
  input.turnIdByMessageId = {};
  let result = projectCompressionNotices(input);
  assert.equal(result.unanchoredFailures.length, 1);
  assert.equal(result.unanchored.length, 1);
  assert.equal(projectCompressionNotices({ ...input, placedTerminationIds: ['f'] }).unanchoredFailures.length, 0);
  input.messages[0].createdAt = Date.parse(created) + 1000;
  result = projectCompressionNotices(input);
  assert.equal(result.unanchoredFailures.length, 0);
  assert.equal(result.unanchored.length, 0);
});

test('successful provider response alone cannot claim a committed fallback summary', () => {
  const input = noticeInput();
  input.records.ModelRequest = { r: { id: 'r', turn_id: 't', terminal_state: 'completed', created_at: created,
    stream_stats_json: { compressionPurpose: { groupId: 'g', blockId: 'b', methodKind: 'segmented_summary', trigger: 'manual', priorFailures: decision.failures } } } };
  assert.equal(projectCompressionNotices(input).byAnchor.m, undefined);
  input.records.CompressionBlock = { b: { id: 'b', status: 'active', created_at: created } };
  assert.equal(projectCompressionNotices(input).byAnchor.m.length, 1);
  input.records.CompressionBlock.b.status = 'soft_deleted';
  assert.equal(projectCompressionNotices(input).byAnchor.m, undefined);
});

test('frozen reasoning is not recalculated from a later target configuration', () => {
  const plan = reason(capability('openai-responses', 'gpt-5.4'), 'balanced');
  assert.deepEqual(frozenSummaryReasoning({ summaryReasoning: plan }, { llmSummary: { reasoning: { mode: 'maximum' } } }, config()), plan);
});

// ---- OpenAI 兼容：能力表复用方言规则（摘要推理） ----
const { dryRunCompactLlmProvider } = require('../../dist/extension/backend/capabilities/llmProvider.js');
const COMPAT = {
  deepseek: 'https://api.deepseek.com/v1', moonshot: 'https://api.moonshot.cn/v1',
  dashscope: 'https://dashscope.aliyuncs.com/compatible-mode/v1', siliconflow: 'https://api.siliconflow.cn/v1',
  openrouter: 'https://openrouter.ai/api/v1', relay: 'https://relay.example.invalid/v1'
};
const compat = (baseUrl, modelId, extra = {}) => caps.resolveModelCapabilities({ provider: 'openai-compatible', baseUrl, modelId, providerConfigId: 'channel', transport: 'http', ...extra });
const compatConfig = (baseUrl, model, extra = {}) => ({ id: 'channel', provider: 'openai-compatible', baseUrl, model,
  models: [{ id: model, name: model }], modelConfigs: [], apiKey: 'test-key', ...extra });

test('OpenAI 兼容能力表：按方言规则给出 deepseek_toggle，平台认出的记为官方文档，中转站仍未确认', () => {
  const deepseek = compat(COMPAT.deepseek, 'deepseek-v4-pro');
  assert.equal(deepseek.source, 'official_registry');
  assert.deepEqual({ family: deepseek.reasoning.family, levels: deepseek.reasoning.levels, canDisable: deepseek.reasoning.canDisable, alwaysOn: deepseek.reasoning.alwaysOn, wireFormat: deepseek.reasoning.wireFormat },
    { family: 'deepseek_toggle', levels: ['low', 'high', 'max'], canDisable: true, alwaysOn: false, wireFormat: 'deepseek' });
  assert.equal(deepseek.nativeCompaction.availability, 'unsupported', '原生压缩能力不变');
  const kimi = compat(COMPAT.moonshot, 'kimi-k3');
  assert.equal(kimi.reasoning.canDisable, false);
  assert.equal(kimi.reasoning.alwaysOn, true);
  const qwen = compat(COMPAT.dashscope, 'qwen3-max');
  assert.deepEqual([qwen.reasoning.family, qwen.reasoning.levels, qwen.reasoning.canDisable, qwen.reasoning.wireFormat], ['deepseek_toggle', ['high'], true, 'enable_thinking']);
  assert.deepEqual(compat(COMPAT.siliconflow, 'deepseek-ai/DeepSeek-V4-Pro').reasoning.levels, ['high', 'max']);
  const relay = compat(COMPAT.relay, 'deepseek-v4-flash');
  assert.equal(relay.source, 'unknown');
  assert.deepEqual(relay.reasoning.levels, ['low', 'high', 'max']);
  assert.equal(relay.nativeCompaction.availability, 'unknown');
  assert.equal(compat(COMPAT.openrouter, 'deepseek/deepseek-v4-pro').reasoning.family, 'none');
  assert.equal(compat(COMPAT.deepseek, 'deepseek-v4-pro', { thinkingFormat: 'omit' }).reasoning.family, 'none');
  assert.equal(compat(COMPAT.deepseek, 'deepseek-v4-pro', { thinkingFormat: 'omit' }).source, 'unknown');
  // 信任模式保持现状。
  const trusted = compat(COMPAT.deepseek, 'deepseek-v4-pro', { trustMode: 'trust_configured_endpoint' });
  assert.equal(trusted.source, 'explicit_trust');
  assert.equal(trusted.nativeCompaction.availability, 'unsupported');
  assert.equal(compat(COMPAT.relay, 'custom', { trustMode: 'trust_configured_endpoint' }).nativeCompaction.availability, 'unsupported');
  assert.equal(caps.MODEL_CAPABILITY_REGISTRY_REVISION, '2026-09-24');
});

test('渠道能力：手动写法先取模型级、不采用测试证据；测试证据按有效规则给档位', () => {
  const omitted = caps.resolveProviderModelCapabilities(compatConfig(COMPAT.deepseek, 'deepseek-v4-pro', {
    openaiCompatibleThinkingFormat: 'deepseek',
    modelConfigs: [{ id: 'mc', modelId: 'deepseek-v4-pro', openaiCompatibleThinkingFormat: 'omit' }]
  }));
  assert.equal(omitted.reasoning.family, 'none');
  const probe = { providerKind: 'openai-compatible', modelId: 'renamed', providerConfigId: 'channel', transport: 'http',
    endpointFingerprint: COMPAT.relay, source: 'verified_probe', verifiedAt: '2026-09-24T00:00:00Z',
    reasoning: { family: 'deepseek_toggle', levels: [], supportsBudget: false, canDisable: true, alwaysOn: false,
      outputLimitIncludesThinking: true, requiresThoughtSignatures: false, wireFormat: 'enable_thinking' },
    nativeCompaction: { availability: 'unknown', reason: 'baseline' } };
  const probed = caps.resolveProviderModelCapabilities(compatConfig(COMPAT.relay, 'renamed', { models: [{ id: 'renamed', name: 'renamed', capabilitySnapshot: probe }] }));
  assert.equal(probed.source, 'verified_probe');
  assert.deepEqual([probed.reasoning.levels, probed.reasoning.canDisable, probed.reasoning.wireFormat], [['high'], true, 'enable_thinking']);
  const manual = caps.resolveProviderModelCapabilities(compatConfig(COMPAT.relay, 'renamed', {
    openaiCompatibleThinkingFormat: 'reasoning_effort', models: [{ id: 'renamed', name: 'renamed', capabilitySnapshot: probe }] }));
  assert.notEqual(manual.source, 'verified_probe');
  assert.equal(manual.reasoning.family, 'none');
});

test('摘要推理：DeepSeek 与百炼的预设就近换算，显式 medium 换算不报错，Kimi K3 显式关闭仍报错', () => {
  const deepseek = compat(COMPAT.deepseek, 'deepseek-v4-pro');
  assert.deepEqual(reason(deepseek, 'economy').requestBody, { reasoning_effort: 'low' });
  assert.deepEqual(reason(deepseek, 'balanced').requestBody, { reasoning_effort: 'high' });
  assert.deepEqual(reason(deepseek, 'quality').requestBody, { reasoning_effort: 'high' });
  assert.deepEqual(reason(deepseek, 'maximum').requestBody, { reasoning_effort: 'max' });
  assert.deepEqual(reason(deepseek, 'disabled').requestBody, { reasoning_effort: 'none' });
  const qwen = compat(COMPAT.dashscope, 'qwen3-max');
  for (const mode of ['economy', 'balanced', 'quality', 'maximum']) assert.deepEqual(reason(qwen, mode).requestBody, { reasoning_effort: 'high' }, mode);
  const explicit = reason(deepseek, 'explicit', { thinkingLevel: 'medium' });
  assert.equal(explicit.status, 'applied');
  assert.match(explicit.description, /medium 实际发送为 high/);
  caps.assertSummaryReasoningPlan(explicit);
  assert.equal(caps.thinkingConfigSupported({ thinkingLevel: 'xhigh' }, deepseek.reasoning), true);
  assert.equal(caps.thinkingConfigSupported({ thinkingBudget: 1024 }, deepseek.reasoning), false);
  const kimi = compat(COMPAT.moonshot, 'kimi-k3');
  assert.throws(() => caps.assertSummaryReasoningPlan(reason(kimi, 'explicit', { thinkingLevel: 'none' })));
  assert.throws(() => caps.assertSummaryReasoningPlan(reason(kimi, 'disabled')), /关闭/);
});

async function summaryWire(baseUrl, model, mode, extra = {}) {
  const settings = { id: 'channel', name: 'summary', provider: 'openai-compatible', baseUrl, model, models: [{ id: model, name: model }],
    apiKey: 'offline-placeholder', toolCallFormat: 'function-call', openaiResponsesTransport: 'http', stream: false,
    retryOnError: false, retryMaxAttempts: 0, retryDelaySeconds: 0, enableMultimodalTools: true, contextWindowTokens: 65536,
    systemPromptPrefix: '', promptCache: { enabled: false, mode: 'key', ttl: '30m' }, modelConfigs: [], createdAt: 1, updatedAt: 1, ...extra };
  const result = await dryRunCompactLlmProvider({ id: 'summary-request', blockId: 'summary-block', conversationId: 'summary-conversation', methodKind: 'llm_summary',
    methodConfigSnapshot: { id: 'summary-method', name: 'summary', kind: 'llm_summary', trigger: { mode: 'manual' },
      llmSummary: { targetTokens: 1000, reasoning: { mode } }, createdAt: 1, updatedAt: 1 },
    contents: [{ role: 'user', parts: [{ text: 'history' }] }] }, { settings: async () => settings, compressionSettings: async () => undefined });
  return JSON.parse(result.calls[0].bodyText);
}

test('摘要请求最终按方言发出 thinking.type 或 enable_thinking', async () => {
  const deepseek = await summaryWire(COMPAT.deepseek, 'deepseek-v4-pro', 'balanced');
  assert.deepEqual(deepseek.thinking, { type: 'enabled' });
  assert.equal(deepseek.reasoning_effort, 'high');
  const qwen = await summaryWire(COMPAT.dashscope, 'qwen3-max', 'disabled');
  assert.equal(qwen.enable_thinking, false);
  assert.equal('reasoning_effort' in qwen, false);
});

function loadWebviewModule(relativeEntry) {
  const Module = require('node:module');
  const esbuild = require('esbuild');
  const path = require('node:path');
  const root = path.resolve('.');
  const result = esbuild.buildSync({
    entryPoints: [path.join(root, relativeEntry)], absWorkingDir: root, bundle: true, write: false,
    platform: 'node', format: 'cjs', target: 'node18', tsconfig: path.join(root, 'tsconfig.webview.json'), logLevel: 'silent'
  });
  const filename = path.join(root, `.test-capabilities-${path.basename(relativeEntry)}.cjs`);
  const compiled = new Module(filename);
  compiled.filename = filename;
  compiled.paths = Module._nodeModulePaths(root);
  compiled._compile(result.outputFiles[0].text, filename);
  return compiled.exports;
}

test('渠道参数编辑器：deepseek_toggle 不按能力过滤思考强度，发送时就近换算', () => {
  const { parameterDefinitionsForProvider } = loadWebviewModule('webview/src/components/settings/global/parameters/llmParameterDefinitions.ts');
  for (const [baseUrl, model] of [[COMPAT.deepseek, 'deepseek-v4-pro'], [COMPAT.moonshot, 'kimi-k3'], [COMPAT.dashscope, 'qwen3-max']]) {
    const definition = parameterDefinitionsForProvider('openai-compatible', model, compat(baseUrl, model)).find((entry) => entry.key === 'thinkingLevel');
    assert.deepEqual(definition.options.map((option) => option.value), ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'], model);
  }
  const source = readFileSync(new URL('../../webview/src/components/settings/global/parameters/LlmParameterSettings.vue', import.meta.url), 'utf8');
  assert.match(source, /reasoning\.family !== 'deepseek_toggle'/);
});

test('渠道请求体自己写了思考参数时，摘要请求仍按方言改写，并去掉会改变思考的键', async () => {
  const deepseek = await summaryWire(COMPAT.deepseek, 'deepseek-v4-pro', 'balanced', { requestBody: { thinking: { type: 'disabled' }, thinking_budget: 64 } });
  assert.deepEqual(deepseek.thinking, { type: 'enabled' });
  assert.equal(deepseek.reasoning_effort, 'high');
  assert.equal('thinking_budget' in deepseek, false);
  const qwen = await summaryWire(COMPAT.dashscope, 'qwen3-max', 'disabled', {
    requestBody: { enable_thinking: true, chat_template_kwargs: { enable_thinking: true, custom_template_flag: 1 } } });
  assert.equal(qwen.enable_thinking, false);
  assert.equal('reasoning_effort' in qwen, false);
  assert.deepEqual(qwen.chat_template_kwargs, { custom_template_flag: 1 }, '与思考无关的模板参数保留');
  const plan = { intent: 'provider_default', status: 'provider_default', description: '' };
  assert.deepEqual(summaryRequestBody({ chat_template_kwargs: { thinking: true } }, plan), {});
  assert.deepEqual(summaryRequestBody({ chat_template_kwargs: { enable_thinking: false, custom_template_flag: 1 } }, plan),
    { chat_template_kwargs: { custom_template_flag: 1 } }, '与思考无关的模板参数保留');
});
