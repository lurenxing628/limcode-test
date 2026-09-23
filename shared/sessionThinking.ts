import type { LlmGenerationConfigRecord, LlmRequestBodyRecord, LlmProviderKind, LlmThinkingConfigRecord, LlmThinkingLevel, SessionThinkingOverride } from './protocol';
import { isAstraModel, isGpt6NoneCapableModel } from './openAIResponsesCapabilities';
import { geminiThinkingCapabilityForModel, isGeminiThinkingLevelSupported } from './geminiThinking';
import { THINKING_LEVEL_OPTIONS } from './llmThinkingLevels';

export type SessionThinkingCapability =
  | { kind: 'gemini-budget' | 'claude-budget'; min: number; max: number; automatic?: number; allowZero?: boolean }
  | { kind: 'openai-effort' | 'gemini-level' | 'claude-effort' | 'deepseek-effort'; values: readonly LlmThinkingLevel[] };

/** Known model constraints take priority. Configured relay aliases reuse the channel editor's values. */
export function sessionThinkingCapability(provider: LlmProviderKind, modelId: string, maxOutputTokens?: number, configuredThinking?: LlmThinkingConfigRecord): SessionThinkingCapability | undefined {
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
    if (/^claude-(opus|sonnet)-4[.-]6(?:-\d{8})?$/.test(model)) {
      return configuredEffort(provider, configuredThinking)
        ?? { kind: 'claude-effort', values: model.includes('opus') ? ['none', 'low', 'medium', 'high', 'max'] : ['none', 'low', 'medium', 'high'] };
    }
    if (/^claude-(?:3[.-]7-sonnet|(?:sonnet|opus)-4(?:[.-][015])?)(?:-|$)/.test(model) && Number.isSafeInteger(maxOutputTokens) && maxOutputTokens! > 1024) {
      return { kind: 'claude-budget', min: 1024, max: maxOutputTokens! - 1 };
    }
    return configuredEffort(provider, configuredThinking);
  }
  if (provider === 'openai-compatible' || provider === 'openai-responses') {
    if (/^o[134](?:-|$)/.test(model) && !/^o1-(?:mini|preview)/.test(model)) return { kind: 'openai-effort', values: ['low', 'medium', 'high'] };
    if (/^gpt-5(?:-mini|-nano)?(?:-\d{4}-\d{2}-\d{2})?$/.test(model)) return { kind: 'openai-effort', values: ['minimal', 'low', 'medium', 'high'] };
    if (/^gpt-5\.1(?:-2025-11-13)?$/.test(model)) return { kind: 'openai-effort', values: ['none', 'low', 'medium', 'high'] };
    if (/^gpt-5\.2(?:-2025-12-11)?$/.test(model)) return { kind: 'openai-effort', values: ['none', 'low', 'medium', 'high', 'xhigh'] };
    if (isAstraModel(model) && provider === 'openai-responses') return { kind: 'openai-effort', values: ['low', 'medium', 'high', 'xhigh', 'max'] };
    // GPT-6 Sol / Luna（models/gpt-6-sol.md、models/gpt-6-luna.md）：none、low、medium（默认）、high、xhigh、max。
    if (isGpt6NoneCapableModel(model)) return { kind: 'openai-effort', values: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] };
  }
  if (provider === 'deepseek' && /^deepseek-(?:reasoner|v4)(?:-|$)/.test(model)) return { kind: 'deepseek-effort', values: ['none', 'high', 'max'] };
  return configuredEffort(provider, configuredThinking);
}

function configuredEffort(provider: LlmProviderKind, thinking?: LlmThinkingConfigRecord): SessionThinkingCapability | undefined {
  const values = THINKING_LEVEL_OPTIONS[provider].map(option => option.value);
  if (!thinking?.thinkingLevel || !values.includes(thinking.thinkingLevel) || provider === 'gemini') return undefined;
  const kind = provider === 'claude' ? 'claude-effort' : provider === 'deepseek' ? 'deepseek-effort' : 'openai-effort';
  return { kind, values };
}

export class IncompatibleSessionThinkingError extends Error {}

export function validateSessionThinkingOverride(value: SessionThinkingOverride, provider: LlmProviderKind, model: string, generation?: LlmGenerationConfigRecord, requestBody?: LlmRequestBodyRecord): SessionThinkingOverride {
  const capability = sessionThinkingCapability(provider, model, generation?.maxOutputTokens, generation?.thinkingConfig);
  if (!value || !capability || value.kind !== capability.kind) throw new IncompatibleSessionThinkingError('当前模型不支持此思维参数，请恢复默认或重新选择。');
  if (provider === 'claude' && ('tokens' in value || value.value !== 'none')) {
    const temperature = requestBody && Object.prototype.hasOwnProperty.call(requestBody, 'temperature') ? requestBody.temperature : generation?.temperature;
    const topK = requestBody && Object.prototype.hasOwnProperty.call(requestBody, 'top_k') ? requestBody.top_k : generation?.topK;
    const topP = requestBody && Object.prototype.hasOwnProperty.call(requestBody, 'top_p') ? requestBody.top_p : generation?.topP;
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

export function thinkingValueLabel(thinking?: LlmThinkingConfigRecord): string {
  if (thinking?.thinkingLevel && !['not-set', 'non-set'].includes(thinking.thinkingLevel)) return thinking.thinkingLevel;
  if (thinking?.thinkingBudget !== undefined) return thinking.thinkingBudget === -1 ? '自动（-1）' : `${thinking.thinkingBudget} tokens`;
  return '服务默认';
}

/** Display the existing adapter's mapping without claiming a remote service's defaults. */
export function sessionThinkingDisplayLabel(provider: LlmProviderKind, model: string, thinking?: LlmThinkingConfigRecord): string {
  if (provider === 'gemini') {
    const capability = geminiThinkingCapabilityForModel(model);
    if (capability.kind === 'thinkingLevel') {
      if (thinking?.thinkingBudget !== undefined) return '配置不受支持（请求会拒绝）';
      if (isGeminiThinkingLevelSupported(capability, thinking?.thinkingLevel)) return thinking!.thinkingLevel!;
      return thinkingValueLabel(thinking) === '服务默认' ? '服务默认' : '配置不受支持（请求会拒绝）';
    }
    if (capability.kind === 'thinkingBudget') {
      if (thinking?.thinkingLevel && !['not-set', 'non-set'].includes(thinking.thinkingLevel)) return '配置不受支持（请求会拒绝）';
      return thinkingValueLabel({ thinkingBudget: thinking?.thinkingBudget });
    }
    if (capability.kind === 'unsupported') return '不支持（不发送）';
    if (capability.kind === 'unknown') return `能力未确认 · ${thinkingValueLabel(thinking)}`;
  }
  if (provider === 'openai-responses' && isAstraModel(model) && ['none', 'minimal'].includes(thinking?.thinkingLevel ?? '')) return 'low（适配器）';
  if (provider === 'openai-compatible' || provider === 'openai-responses') return thinkingValueLabel({ thinkingLevel: thinking?.thinkingLevel });
  if (provider === 'deepseek') return thinking?.thinkingLevel && ['none', 'high', 'max'].includes(thinking.thinkingLevel) ? thinking.thinkingLevel : '服务默认';
  return thinkingValueLabel(thinking);
}
