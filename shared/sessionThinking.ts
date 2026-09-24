import type { LlmGenerationConfigRecord, LlmRequestBodyRecord, LlmProviderKind, LlmThinkingConfigRecord, LlmThinkingLevel, SessionThinkingOverride } from './protocol';
import { isAstraModel, isGpt6NoneCapableModel } from './openAIResponsesCapabilities';
import { geminiThinkingCapabilityForModel, isGeminiThinkingLevelSupported } from './geminiThinking';
import { THINKING_LEVEL_OPTIONS } from './llmThinkingLevels';
import { hasThinkingBodyConflict } from './sessionThinkingBody';
import { anthropicModelReasoningCapability, anthropicRejectsNonDefaultSampling, resolveProviderOpenAICompatibleDialect } from './modelCapabilities';
import {
  mapOpenAICompatibleEffort,
  openAICompatibleEffortValues,
  openAICompatibleModelThinkingRule,
  openAICompatibleThinkingLevels,
  resolveOpenAICompatibleDialect
} from './openAICompatibleDialect';

/** 渠道配置（接口地址、测试结果、手动写法）：OpenAI 兼容渠道按它算出有效规则。 */
export type SessionThinkingProviderConfig = Parameters<typeof resolveProviderOpenAICompatibleDialect>[0];

/**
 * OpenRouter 按原值转发顶层 `reasoning_effort`（openrouter.ai/docs Parameters）：取值没有 max；
 * 必须思考的模型拒绝 none（Reasoning Tokens 页）。
 */
const OPENROUTER_EFFORTS: readonly LlmThinkingLevel[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export type SessionThinkingCapability =
  | { kind: 'gemini-budget' | 'claude-budget'; min: number; max: number; automatic?: number; allowZero?: boolean }
  | { kind: 'openai-effort' | 'gemini-level' | 'claude-effort' | 'deepseek-effort'; values: readonly LlmThinkingLevel[] };

/**
 * Known model constraints take priority. Configured relay aliases reuse the channel editor's values.
 * `providerConfig`：OpenAI 兼容渠道按渠道配置（接口地址、测试结果、手动写法）算选项；没有时只按模型规则。
 */
export function sessionThinkingCapability(provider: LlmProviderKind, modelId: string, maxOutputTokens?: number, configuredThinking?: LlmThinkingConfigRecord, providerConfig?: SessionThinkingProviderConfig): SessionThinkingCapability | undefined {
  const model = modelId.toLowerCase().replace(/^models\//, '');
  if (provider === 'gemini') {
    const capability = geminiThinkingCapabilityForModel(model);
    if (capability.kind === 'thinkingLevel') return { kind: 'gemini-level', values: capability.levels };
    if (capability.kind === 'thinkingBudget' && !/image|audio|tts|live/.test(model)) {
      if (model.includes('pro')) return { kind: 'gemini-budget', min: 128, max: 32768, automatic: -1 };
      if (model.includes('flash')) return { kind: 'gemini-budget', min: model.includes('lite') ? 512 : 1, max: 24576, automatic: -1, allowZero: true };
    }
    return undefined;
  }
  if (provider === 'claude') {
    // 能力表里的 adaptive 模型（Claude 4.7 及之后：Opus 5.5、Fable、Sonnet 5 等）与混合模型（Opus / Sonnet 4.6、
    // Mythos Preview）按表给 effort：xhigh 只给官方列出的模型（https://platform.claude.com/docs/en/build-with-claude/effort），
    // 始终开启的模型（Fable、Mythos、Opus 5.5）不提供关闭。已知模型不被渠道配置放宽。编码见 claudeThinkingAdaptation.ts。
    // 会话选项也认 `claude-opus-4.6` 这类点号写法。
    const reasoning = anthropicModelReasoningCapability(model.replace(/\./g, '-'));
    if ((reasoning?.family === 'anthropic_adaptive' || reasoning?.family === 'anthropic_hybrid') && reasoning.levels.length) {
      return { kind: 'claude-effort', values: [...(reasoning.canDisable ? ['none' as const] : []), ...reasoning.levels] };
    }
    if (/^claude-(?:3[.-]7-sonnet|(?:sonnet|opus)-4(?:[.-][015])?)(?:-|$)/.test(model) && Number.isSafeInteger(maxOutputTokens) && maxOutputTokens! > 1024) {
      return { kind: 'claude-budget', min: 1024, max: maxOutputTokens! - 1 };
    }
    return configuredEffort(provider, configuredThinking);
  }
  // OpenAI 兼容渠道按有效规则不发送思考参数时（手动“不发送”、认得出的不思考模型、旧混元接口），没有可选强度。
  const compatibleDialect = provider === 'openai-compatible' && providerConfig
    ? resolveProviderOpenAICompatibleDialect(providerConfig, modelId) : undefined;
  if (compatibleDialect?.format === 'omit') return undefined;
  if (provider === 'openai-compatible' || provider === 'openai-responses') {
    if (/^o[134](?:-|$)/.test(model) && !/^o1-(?:mini|preview)/.test(model)) return { kind: 'openai-effort', values: ['low', 'medium', 'high'] };
    if (/^gpt-5(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return { kind: 'openai-effort', values: ['minimal', 'low', 'medium', 'high'] };
    if (/^gpt-5\.1(?:-2025-11-13)?$/.test(model)) return { kind: 'openai-effort', values: ['none', 'low', 'medium', 'high'] };
    if (/^gpt-5\.2(?:-2025-12-11)?$/.test(model)) return { kind: 'openai-effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] };
    if (/^gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) {
      // GPT-5.6 各型号（models/gpt-5.6-sol 等）：none、low、medium（默认）、high、xhigh、max，没有 minimal。
      return { kind: 'openai-effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] };
    }
    // Astra 在 Responses 与 Chat Completions 上都由适配器把 none / minimal 发成 low。
    if (isAstraModel(model)) return { kind: 'openai-effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] };
    // GPT-6 Sol / Luna（models/gpt-6-sol.md、models/gpt-6-luna.md）：none、low、medium（默认）、high、xhigh、max。
    if (isGpt6NoneCapableModel(model)) return { kind: 'openai-effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] };
  }
  if (provider === 'openai-compatible') {
    // DeepSeek 写法或 enable_thinking 写法的模型：按有效规则（手动写法 → 测试结果 → 平台 / 模型 ID）给档位，
    // 与请求改写（backend/capabilities/openAICompatibleDialectAdaptation.ts）和能力表共用同一份规则。
    // 没有渠道配置时只能按模型规则。kind 沿用 'deepseek-effort'（原 DeepSeek 渠道）。
    const dialect = compatibleDialect
      ?? (openAICompatibleModelThinkingRule(model) ? resolveOpenAICompatibleDialect('', model, 'deepseek') : undefined);
    const thinking = dialect ? openAICompatibleThinkingLevels(dialect) : undefined;
    if (thinking) return { kind: 'deepseek-effort', values: thinking.canDisable ? ['none', ...thinking.levels] : thinking.levels };
    // OpenRouter 按原值发送，不套 DeepSeek 档位；认得出的思考模型直接给选项，其余沿用渠道已配置强度的判断。
    if (compatibleDialect?.platform === 'openrouter' && compatibleDialect.format === 'reasoning_effort'
      && (compatibleDialect.rule || configuredEffort(provider, configuredThinking))) {
      return { kind: 'openai-effort', values: compatibleDialect.rule?.canDisable === false ? OPENROUTER_EFFORTS.filter((value) => value !== 'none') : OPENROUTER_EFFORTS };
    }
  }
  return configuredEffort(provider, configuredThinking);
}

function configuredEffort(provider: LlmProviderKind, thinking?: LlmThinkingConfigRecord): SessionThinkingCapability | undefined {
  const values = THINKING_LEVEL_OPTIONS[provider].map(option => option.value);
  if (!thinking?.thinkingLevel || !values.includes(thinking.thinkingLevel) || provider === 'gemini') return undefined;
  const kind = provider === 'claude' ? 'claude-effort' : 'openai-effort';
  return { kind, values };
}

export class IncompatibleSessionThinkingError extends Error {}

export function validateSessionThinkingOverride(value: SessionThinkingOverride, provider: LlmProviderKind, model: string, generation?: LlmGenerationConfigRecord, requestBody?: LlmRequestBodyRecord, providerConfig?: SessionThinkingProviderConfig): SessionThinkingOverride {
  const capability = sessionThinkingCapability(provider, model, generation?.maxOutputTokens, generation?.thinkingConfig, providerConfig);
  if (!value || !capability || value.kind !== capability.kind) throw new IncompatibleSessionThinkingError('当前模型不支持此思维参数，请恢复默认或重新选择。');
  const strictSampling = provider === 'claude' && anthropicRejectsNonDefaultSampling(model);
  if (provider === 'claude' && (strictSampling || 'tokens' in value || value.value !== 'none')) {
    const temperature = requestBody && Object.prototype.hasOwnProperty.call(requestBody, 'temperature') ? requestBody.temperature : generation?.temperature;
    const topK = requestBody && Object.prototype.hasOwnProperty.call(requestBody, 'top_k') ? requestBody.top_k : generation?.topK;
    const topP = requestBody && Object.prototype.hasOwnProperty.call(requestBody, 'top_p') ? requestBody.top_p : generation?.topP;
    // Claude 4.7 及之后：非默认的采样参数无论是否思考都返回 400。
    if (strictSampling && ((temperature !== undefined && temperature !== 1) || topK !== undefined || topP !== undefined)) {
      throw new IncompatibleSessionThinkingError('当前 Claude 模型不接受非默认的采样参数（无论是否思考）：temperature 只能省略或为 1，top_p、top_k 必须省略。未修改渠道采样，请先在渠道设置调整或恢复默认。');
    }
    if ((temperature !== undefined && temperature !== 1) || topK !== undefined || (topP !== undefined && (typeof topP !== 'number' || topP < .95 || topP > 1))) {
      throw new IncompatibleSessionThinkingError('当前 Claude 思维模式与采样参数冲突：temperature 仅可省略或为 1，top_k 必须省略，top_p 仅可省略或在 0.95–1。未修改渠道采样，请先在渠道设置调整或恢复默认。');
    }
  }
  if ('tokens' in value && 'min' in capability) {
    if (!Number.isSafeInteger(value.tokens) || !(value.tokens === capability.automatic || (capability.allowZero && value.tokens === 0) || (value.tokens >= capability.min && value.tokens <= capability.max))) throw new IncompatibleSessionThinkingError('思维预算超出当前模型合法范围。');
    if (value.tokens > 0 && generation?.maxOutputTokens !== undefined && value.tokens >= generation.maxOutputTokens) throw new IncompatibleSessionThinkingError('思维预算必须小于最大输出 Token。');
    return { kind: value.kind, tokens: value.tokens };
  }
  if ('value' in value && 'values' in capability && capability.values.includes(value.value)) return { kind: value.kind, value: value.value };
  throw new IncompatibleSessionThinkingError('当前模型不支持此思维等级。');
}

/** 已保存的会话思考覆盖在当前模型上不生效时，界面和说明里用的话。 */
export const INACTIVE_SESSION_THINKING_NOTICE = '已保存的思考强度不适用于当前模型，已按渠道设置发送。';

export type SavedSessionThinking =
  | { status: 'applied'; override: SessionThinkingOverride }
  | { status: 'inactive'; reason: string };

const EFFORT_OVERRIDE_KINDS: ReadonlySet<string> = new Set(['openai-effort', 'deepseek-effort']);

/**
 * 请求冻结、子 Agent 继承与“子 Agent 也用”开关对已保存覆盖的容错解析（保存时仍用上面的严格校验）：
 * 升级后同一模型可能换了强度类 kind（openai-effort ↔ deepseek-effort），值仍在可选集合里就改写 kind 后生效；
 * 已不合法的值（例如 Opus 5.5 以前保存的 none）或自定义请求体已控制思考时视为没有覆盖，按渠道设置发送。
 */
export function resolveSavedSessionThinkingOverride(value: SessionThinkingOverride, provider: LlmProviderKind, model: string, generation?: LlmGenerationConfigRecord, requestBody?: LlmRequestBodyRecord, providerConfig?: SessionThinkingProviderConfig): SavedSessionThinking {
  if (hasThinkingBodyConflict(provider, requestBody)) {
    return { status: 'inactive', reason: '自定义请求体已控制思考参数，已保存的思考强度不生效，按渠道设置发送。' };
  }
  const capability = sessionThinkingCapability(provider, model, generation?.maxOutputTokens, generation?.thinkingConfig, providerConfig);
  const candidate: SessionThinkingOverride = capability && 'values' in capability && 'value' in value
    && EFFORT_OVERRIDE_KINDS.has(value.kind) && EFFORT_OVERRIDE_KINDS.has(capability.kind) && value.kind !== capability.kind
    ? { kind: capability.kind as 'openai-effort' | 'deepseek-effort', value: value.value }
    : value;
  try {
    return { status: 'applied', override: validateSessionThinkingOverride(candidate, provider, model, generation, requestBody, providerConfig) };
  } catch (error) {
    if (error instanceof IncompatibleSessionThinkingError) return { status: 'inactive', reason: INACTIVE_SESSION_THINKING_NOTICE };
    throw error;
  }
}

export function applySessionThinkingOverride(generation: LlmGenerationConfigRecord | undefined, override: SessionThinkingOverride | undefined): LlmGenerationConfigRecord {
  const result = { ...generation, ...(generation?.thinkingConfig ? { thinkingConfig: { ...generation.thinkingConfig } } : {}) };
  if (!override) return result;
  const thinkingConfig = { ...result.thinkingConfig };
  delete thinkingConfig.thinkingBudget;
  delete thinkingConfig.thinkingLevel;
  if ('tokens' in override) thinkingConfig.thinkingBudget = override.tokens;
  else thinkingConfig.thinkingLevel = override.value;
  return { ...result, thinkingConfig };
}

/** 渠道和模型配置都没有指定思考强度：请求不带思考参数，由服务端决定。 */
export const UNSET_THINKING_LABEL = '未设置（由服务决定）';

export function thinkingValueLabel(thinking?: LlmThinkingConfigRecord): string {
  if (thinking?.thinkingLevel && !['not-set', 'non-set'].includes(thinking.thinkingLevel)) return thinking.thinkingLevel;
  if (thinking?.thinkingBudget !== undefined) return thinking.thinkingBudget === -1 ? '自动（-1）' : `${thinking.thinkingBudget} tokens`;
  return UNSET_THINKING_LABEL;
}

/**
 * OpenAI 兼容渠道按有效规则实际发出的值：换算后的强度、只开关的模型、关不掉思考的模型、不发送。
 * 与发出的值相同时返回 undefined（直接显示渠道设置的值）。
 */
function openAICompatibleSentLabel(providerConfig: SessionThinkingProviderConfig, model: string, thinking?: LlmThinkingConfigRecord): string | undefined {
  const level = thinking?.thinkingLevel;
  if (!level || level === 'not-set' || level === 'non-set') return undefined;
  const dialect = resolveProviderOpenAICompatibleDialect(providerConfig, model);
  if (dialect.format === 'omit') return `${level}，不发送思考参数`;
  if (dialect.format === 'reasoning_effort' || !dialect.rule) return undefined;
  if (level === 'none') return dialect.rule.canDisable ? undefined : 'none，模型关不掉思考，实际仍会思考';
  const sent = mapOpenAICompatibleEffort(level, openAICompatibleEffortValues(dialect));
  if (!sent) return `${level}，只开启思考，不发强度`;
  return sent === level ? undefined : `${level}，实际发 ${sent}`;
}

/** Display the existing adapter's mapping without claiming a remote service's defaults. */
export function sessionThinkingDisplayLabel(provider: LlmProviderKind, model: string, thinking?: LlmThinkingConfigRecord, providerConfig?: SessionThinkingProviderConfig): string {
  if (provider === 'gemini') {
    const capability = geminiThinkingCapabilityForModel(model);
    if (capability.kind === 'thinkingLevel') {
      if (thinking?.thinkingBudget !== undefined) return '配置不受支持（请求会拒绝）';
      if (isGeminiThinkingLevelSupported(capability, thinking?.thinkingLevel)) return thinking!.thinkingLevel!;
      return thinkingValueLabel(thinking) === UNSET_THINKING_LABEL ? UNSET_THINKING_LABEL : '配置不受支持（请求会拒绝）';
    }
    if (capability.kind === 'thinkingBudget') {
      if (thinking?.thinkingLevel && !['not-set', 'non-set'].includes(thinking.thinkingLevel)) return '配置不受支持（请求会拒绝）';
      return thinkingValueLabel({ thinkingBudget: thinking?.thinkingBudget });
    }
    if (capability.kind === 'unsupported') return '不支持（不发送）';
    if (capability.kind === 'unknown') return `能力未确认 · ${thinkingValueLabel(thinking)}`;
  }
  if ((provider === 'openai-responses' || provider === 'openai-compatible') && isAstraModel(model) && ['none', 'minimal'].includes(thinking?.thinkingLevel ?? '')) return 'low（适配器）';
  if ((provider === 'openai-responses' || provider === 'openai-compatible') && isGpt6NoneCapableModel(model) && thinking?.thinkingLevel === 'minimal') return 'low（适配器）';
  // 始终思考的 Claude（Fable、Mythos、Opus 5.5）：none 不发送（claudeThinkingAdaptation 去掉 disabled），模型仍会思考。
  if (provider === 'claude' && thinking?.thinkingLevel === 'none' && anthropicModelReasoningCapability(model.replace(/\./g, '-'))?.alwaysOn) {
    return 'none，模型始终思考，实际仍会思考';
  }
  const compatibleLabel = provider === 'openai-compatible' && providerConfig ? openAICompatibleSentLabel(providerConfig, model, thinking) : undefined;
  if (compatibleLabel) return compatibleLabel;
  if (provider === 'openai-compatible' || provider === 'openai-responses') return thinkingValueLabel({ thinkingLevel: thinking?.thinkingLevel });
  return thinkingValueLabel(thinking);
}
