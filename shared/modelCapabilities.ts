import type {
  LlmCompressionConfigRecord,
  LlmCompressionFallbackKind,
  LlmCompressionMethodKind,
  LlmGenerationConfigRecord,
  LlmNativeCompactionTrustMode,
  LlmProviderConfigRecord,
  LlmProviderKind,
  LlmSummaryReasoningMode,
  LlmThinkingConfigRecord,
  LlmThinkingLevel,
  OpenAICompatibleThinkingFormat
} from './protocol';
import { canonicalLlmProviderKind } from './protocol';
import {
  resolveOpenAICompatibleDialect,
  type OpenAICompatibleDialect,
  type OpenAICompatibleProbedThinking
} from './openAICompatibleDialect';

/** Registry entries are documentation evidence, never a claim of a successful live request. */
export const MODEL_CAPABILITY_REGISTRY_REVISION = '2026-09-22';
export type ModelCapabilitySource = 'official_registry' | 'provider_api' | 'verified_probe' | 'explicit_trust' | 'unknown';
export type NativeCompactionKind = 'openai_responses' | 'anthropic_messages';
export type NativeCompactionAvailability = 'documented' | 'verified' | 'declared' | 'unsupported' | 'unknown';
export type ReasoningCapabilityFamily =
  | 'none'
  | 'openai_effort'
  | 'anthropic_adaptive'
  | 'anthropic_extended'
  | 'anthropic_hybrid'
  | 'gemini_level'
  | 'gemini_budget'
  | 'deepseek_toggle';

export interface ModelReasoningCapability {
  family: ReasoningCapabilityFamily;
  levels: LlmThinkingLevel[];
  defaultLevel?: LlmThinkingLevel;
  supportsBudget: boolean;
  canDisable: boolean;
  alwaysOn: boolean;
  outputLimitIncludesThinking: boolean;
  requiresThoughtSignatures: boolean;
  minBudgetTokens?: number;
  maxBudgetTokens?: number;
  /** 只用于 OpenAI 兼容：思考参数的写法（测试结果或方言规则）。 */
  wireFormat?: OpenAICompatibleThinkingFormat;
}

const OPENAI_COMPATIBLE_THINKING_FORMATS: readonly OpenAICompatibleThinkingFormat[] = ['deepseek', 'enable_thinking', 'reasoning_effort', 'omit'];

export interface ModelNativeCompactionCapability {
  kind?: NativeCompactionKind;
  availability: NativeCompactionAvailability;
  reason: string;
}

export interface ModelCapabilitySnapshot {
  providerKind: LlmProviderKind;
  modelId: string;
  providerConfigId?: string;
  transport?: string;
  registryRevision?: string;
  verifiedAt?: string;
  endpointFingerprint: string;
  source: ModelCapabilitySource;
  reasoning: ModelReasoningCapability;
  nativeCompaction: ModelNativeCompactionCapability;
}

export interface CompressionExecutionAttempt {
  methodKind: Exclude<LlmCompressionMethodKind, 'disabled' | 'auto'>;
  nativeKind?: NativeCompactionKind;
}

export interface CompressionExecutionPlan {
  strategy: LlmCompressionConfigRecord['kind'];
  attempts: CompressionExecutionAttempt[];
  continueUncompressedIfFits: boolean;
  nativeCapability: ModelNativeCompactionCapability;
}

export interface ResolvedSummaryReasoning {
  intent: LlmSummaryReasoningMode;
  status: 'provider_default' | 'applied' | 'unsupported' | 'explicit_unverified';
  description: string;
  generationConfig?: LlmGenerationConfigRecord;
  /** Final native reasoning fields, frozen before dispatch; SDK defaults cannot override them. */
  requestBody?: import('./protocol').LlmRequestBodyRecord;
}

const DEFAULT_FALLBACKS: readonly LlmCompressionFallbackKind[] = [
  'segmented_summary',
  'deterministic_summary',
  'continue_uncompressed_if_fits'
];

const LEVEL_ORDER: readonly LlmThinkingLevel[] = [
  'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'
];

export function resolveModelCapabilities(input: {
  provider: LlmProviderKind;
  baseUrl: string;
  modelId: string;
  trustMode?: LlmNativeCompactionTrustMode;
  providerConfigId?: string;
  transport?: string;
}): ModelCapabilitySnapshot {
  const providerKind = input.provider;
  const modelId = input.modelId.trim();
  const endpointFingerprint = normalizedEndpointFingerprint(input.baseUrl);
  const host = endpointHost(input.baseUrl);
  const officialOpenAI = (providerKind === 'openai-responses' || providerKind === 'openai-compatible')
    && isOfficialEndpoint(input.baseUrl, 'api.openai.com', ['/v1']);
  const officialAnthropic = providerKind === 'claude'
    && isOfficialEndpoint(input.baseUrl, 'api.anthropic.com', ['', '/v1']);
  const officialGemini = host === 'generativelanguage.googleapis.com' && (
    providerKind === 'gemini' && isOfficialEndpoint(input.baseUrl, host, ['', '/v1', '/v1beta'])
    || providerKind === 'openai-compatible' && isOfficialEndpoint(input.baseUrl, host, ['/v1beta/openai'])
  );

  let source: ModelCapabilitySource = officialOpenAI || officialAnthropic || officialGemini
    ? 'official_registry'
    : input.trustMode === 'trust_configured_endpoint'
      ? 'explicit_trust'
      : 'unknown';
  let reasoning = unknownReasoningCapability();
  let nativeCompaction: ModelNativeCompactionCapability = {
    availability: 'unknown',
    reason: '当前渠道和模型没有经过能力确认。'
  };

  if (officialOpenAI) {
    reasoning = openAIReasoningCapability(modelId);
    nativeCompaction = providerKind === 'openai-responses' && reasoning.family === 'openai_effort'
      ? { kind: 'openai_responses', availability: 'documented', reason: '官方文档列出的模型与 Responses 端点；尚未进行实时探测。' }
      : { availability: 'unknown', reason: '当前模型或接口没有经过原生压缩能力确认。' };
  } else if (officialAnthropic) {
    reasoning = anthropicReasoningCapability(modelId);
    nativeCompaction = anthropicNativeCompactionCapability(modelId);
  } else if (officialGemini) {
    reasoning = geminiReasoningCapability(modelId, providerKind === 'openai-compatible');
    nativeCompaction = {
      availability: 'unsupported',
      reason: 'Gemini 当前使用本地分段摘要；上下文缓存不等同于可回放的原生压缩状态。'
    };
  } else if (providerKind === 'openai-compatible' && isOfficialEndpoint(input.baseUrl, 'api.deepseek.com', ['', '/v1'])) {
    // Compatible transport is not model capability proof. Keep explicit controls available, but
    // do not invent supported levels for an unversioned or newly released DeepSeek model.
    reasoning = unknownReasoningCapability();
    nativeCompaction = {
      availability: 'unsupported',
      reason: 'DeepSeek 官方接口没有可回放的 Provider 原生压缩契约。'
    };
  } else if (input.trustMode === 'trust_configured_endpoint') {
    source = 'explicit_trust';
    if (providerKind === 'openai-responses') {
      nativeCompaction = {
        kind: 'openai_responses',
        availability: 'declared',
        reason: '用户明确声明该 Responses 兼容端点支持原生 compaction。'
      };
    } else if (providerKind === 'claude') {
      nativeCompaction = {
        kind: 'anthropic_messages',
        availability: 'declared',
        reason: '用户明确声明该 Anthropic 兼容端点支持原生 compaction。'
      };
    } else {
      nativeCompaction = {
        availability: 'unsupported',
        reason: '该 Provider 格式没有 LimCode 可验证的原生压缩适配器。'
      };
    }
  } else if (providerKind === 'openai-responses') {
    reasoning = unknownReasoningCapability();
  } else if (providerKind === 'claude') {
    reasoning = unknownReasoningCapability('none');
  }

  if (input.trustMode === 'trust_configured_endpoint' && (providerKind === 'claude' || providerKind === 'openai-responses')) {
    nativeCompaction = {
      kind: providerKind === 'claude' ? 'anthropic_messages' : 'openai_responses',
      availability: 'declared', reason: '用户明确声明使用该原生端点；不是在线验证结果。'
    };
  }
  return {
    providerKind,
    modelId,
    registryRevision: MODEL_CAPABILITY_REGISTRY_REVISION,
    ...(input.providerConfigId ? { providerConfigId: input.providerConfigId } : {}),
    ...(input.transport ? { transport: input.transport } : {}),
    endpointFingerprint,
    source,
    reasoning,
    nativeCompaction
  };
}

type ProviderCapabilityConfig = Pick<LlmProviderConfigRecord, 'provider' | 'baseUrl' | 'model'>
  & Partial<Pick<LlmProviderConfigRecord, 'id' | 'models' | 'modelConfigs' | 'openaiResponsesTransport'>>;

function providerTransport(provider: ProviderCapabilityConfig, modelId: string): string {
  return provider.provider === 'openai-responses'
    ? provider.modelConfigs?.find((model) => model.modelId === modelId)?.openaiResponsesTransport
      ?? provider.openaiResponsesTransport ?? 'http'
    : 'http';
}

/**
 * A catalog belongs to the exact channel/model/endpoint/transport. Editing any of them invalidates
 * it for new requests, while existing frozen request snapshots remain unaffected.
 */
function boundCapabilityEvidence(provider: ProviderCapabilityConfig, modelId: string): ModelCapabilitySnapshot | undefined {
  const discovered = normalizeModelCapabilitySnapshot(
    provider.models?.find((model) => model.id === modelId)?.capabilitySnapshot
  );
  if (!discovered || discovered.modelId !== modelId
    || discovered.providerKind !== provider.provider
    || discovered.endpointFingerprint !== normalizedEndpointFingerprint(provider.baseUrl)
    || discovered.providerConfigId !== provider.id
    || discovered.transport !== providerTransport(provider, modelId)) return undefined;
  return discovered;
}

/** 渠道或模型高级配置里手动指定的思考参数写法：先取模型级，没有再取渠道级。 */
function configuredOpenAICompatibleThinkingFormat(
  provider: Partial<Pick<LlmProviderConfigRecord, 'modelConfigs' | 'openaiCompatibleThinkingFormat'>>,
  modelId: string
): OpenAICompatibleThinkingFormat | undefined {
  return provider.modelConfigs?.find((model) => model.modelId === modelId)?.openaiCompatibleThinkingFormat
    ?? provider.openaiCompatibleThinkingFormat;
}

/** 身份匹配的“测试这个模型”证据：`verified_probe` 且带写法。 */
function probedOpenAICompatibleThinking(
  provider: ProviderCapabilityConfig,
  modelId: string
): OpenAICompatibleProbedThinking | undefined {
  if (provider.provider !== 'openai-compatible') return undefined;
  const evidence = boundCapabilityEvidence(provider, modelId);
  const format = evidence?.source === 'verified_probe' ? evidence.reasoning.wireFormat : undefined;
  if (!evidence || !format) return undefined;
  return {
    format,
    canDisable: evidence.reasoning.canDisable,
    efforts: evidence.reasoning.levels.filter((level) => level !== 'none')
  };
}

/**
 * 按渠道配置解析 OpenAI 兼容方言，请求改写、会话思考强度、能力表与设置界面共用：
 * 手动写法（模型级优先）→ 身份匹配的测试结果 → 按接口地址 / 模型 ID 自动识别。
 * `options.manual`：不传时读配置里的手动写法；`null` 表示忽略手动写法（设置界面“自动识别”一项的说明）。
 */
export function resolveProviderOpenAICompatibleDialect(
  config: ProviderCapabilityConfig & Partial<Pick<LlmProviderConfigRecord, 'openaiCompatibleThinkingFormat'>>,
  modelIdInput?: string,
  options: { manual?: OpenAICompatibleThinkingFormat | null } = {}
): OpenAICompatibleDialect {
  const modelId = modelIdInput?.trim() || config.model.trim();
  const manual = options.manual === null ? undefined : options.manual ?? configuredOpenAICompatibleThinkingFormat(config, modelId);
  return manual
    ? resolveOpenAICompatibleDialect(config.baseUrl, modelId, manual)
    : resolveOpenAICompatibleDialect(config.baseUrl, modelId, undefined, probedOpenAICompatibleThinking(config, modelId));
}

export function resolveProviderModelCapabilities(
  provider: Pick<LlmProviderConfigRecord, 'provider' | 'baseUrl' | 'model' | 'modelConfigs'>
    & Partial<Pick<LlmProviderConfigRecord, 'id' | 'models' | 'openaiResponsesTransport'>>,
  modelIdInput?: string,
  trustMode?: LlmNativeCompactionTrustMode
): ModelCapabilitySnapshot {
  const modelId = modelIdInput?.trim() || provider.model.trim();
  const transport = providerTransport(provider, modelId);
  const fallback = resolveModelCapabilities({
    provider: provider.provider, baseUrl: provider.baseUrl, modelId, trustMode,
    providerConfigId: provider.id, transport
  });
  const discovered = boundCapabilityEvidence(provider, modelId);
  if (!discovered) return fallback;
  if (trustMode === 'trust_configured_endpoint' && fallback.nativeCompaction.availability === 'declared') {
    return { ...discovered, source: 'explicit_trust', nativeCompaction: fallback.nativeCompaction };
  }
  return discovered;
}

/** A bounded, credential-free codec shared by settings save/load, UI and capability discovery. */
export function normalizeModelCapabilitySnapshot(value: unknown): ModelCapabilitySnapshot | undefined {
  if (!isObject(value) || typeof value.modelId !== 'string' || !value.modelId.trim()
    || typeof value.endpointFingerprint !== 'string' || value.endpointFingerprint.length > 2048
    || !canonicalLlmProviderKind(value.providerKind)
    || !['official_registry', 'provider_api', 'verified_probe', 'explicit_trust', 'unknown'].includes(String(value.source))
    || !isObject(value.reasoning) || !isObject(value.nativeCompaction)) return undefined;
  const reasoning = value.reasoning;
  if (!['none', 'openai_effort', 'anthropic_adaptive', 'anthropic_extended', 'anthropic_hybrid',
    'gemini_level', 'gemini_budget', 'deepseek_toggle'].includes(String(reasoning.family))
    || !Array.isArray(reasoning.levels) || reasoning.levels.length > LEVEL_ORDER.length
    || reasoning.levels.some((level) => !LEVEL_ORDER.includes(level as LlmThinkingLevel))
    || ['supportsBudget', 'canDisable', 'alwaysOn', 'outputLimitIncludesThinking', 'requiresThoughtSignatures']
      .some((key) => typeof reasoning[key] !== 'boolean')) return undefined;
  const native = value.nativeCompaction;
  if (!['documented', 'verified', 'declared', 'unsupported', 'unknown'].includes(String(native.availability))
    || typeof native.reason !== 'string' || native.reason.length > 1024
    || (native.kind !== undefined && native.kind !== 'openai_responses' && native.kind !== 'anthropic_messages')) return undefined;
  const result: ModelCapabilitySnapshot = {
    // 原 DeepSeek 渠道的快照迁移后仍属于同一个（已改为 OpenAI 兼容的）渠道。
    providerKind: canonicalLlmProviderKind(value.providerKind)!,
    modelId: value.modelId.trim(),
    endpointFingerprint: normalizedEndpointFingerprint(value.endpointFingerprint),
    source: value.source as ModelCapabilitySource,
    reasoning: {
      family: reasoning.family as ReasoningCapabilityFamily,
      levels: [...new Set(reasoning.levels)] as LlmThinkingLevel[],
      supportsBudget: reasoning.supportsBudget as boolean,
      canDisable: reasoning.canDisable as boolean,
      alwaysOn: reasoning.alwaysOn as boolean,
      outputLimitIncludesThinking: reasoning.outputLimitIncludesThinking as boolean,
      requiresThoughtSignatures: reasoning.requiresThoughtSignatures as boolean,
      ...(LEVEL_ORDER.includes(reasoning.defaultLevel as LlmThinkingLevel)
        ? { defaultLevel: reasoning.defaultLevel as LlmThinkingLevel } : {}),
      ...(Number.isSafeInteger(reasoning.minBudgetTokens) && Number(reasoning.minBudgetTokens) >= 0
        ? { minBudgetTokens: Number(reasoning.minBudgetTokens) } : {}),
      ...(Number.isSafeInteger(reasoning.maxBudgetTokens) && Number(reasoning.maxBudgetTokens) > 0
        ? { maxBudgetTokens: Number(reasoning.maxBudgetTokens) } : {}),
      ...(canonicalLlmProviderKind(value.providerKind) === 'openai-compatible'
        && OPENAI_COMPATIBLE_THINKING_FORMATS.includes(reasoning.wireFormat as OpenAICompatibleThinkingFormat)
        ? { wireFormat: reasoning.wireFormat as OpenAICompatibleThinkingFormat } : {})
    },
    nativeCompaction: {
      availability: native.availability as NativeCompactionAvailability,
      reason: native.reason,
      ...(native.kind ? { kind: native.kind as NativeCompactionKind } : {})
    }
  };
  for (const key of ['providerConfigId', 'transport', 'registryRevision', 'verifiedAt'] as const) {
    if (typeof value[key] === 'string' && value[key].length <= 256) result[key] = value[key];
  }
  return result;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function resolveCompressionExecutionPlan(
  config: LlmCompressionConfigRecord,
  capabilities: ModelCapabilitySnapshot
): CompressionExecutionPlan {
  if (config.kind === 'disabled') {
    return {
      strategy: config.kind,
      attempts: [],
      continueUncompressedIfFits: false,
      nativeCapability: capabilities.nativeCompaction
    };
  }

  const fallbacks = normalizeFallbacks(config.fallbacks);
  const continueUncompressedIfFits = fallbacks.includes('continue_uncompressed_if_fits');
  const nativeAvailable = capabilities.nativeCompaction.kind !== undefined
    && (capabilities.nativeCompaction.availability === 'verified'
      || capabilities.nativeCompaction.availability === 'declared');
  const attempts: CompressionExecutionAttempt[] = [];
  const push = (attempt: CompressionExecutionAttempt): void => {
    if (!attempts.some((candidate) => candidate.methodKind === attempt.methodKind)) attempts.push(attempt);
  };

  if ((config.kind === 'auto' || config.kind === 'provider_native') && nativeAvailable) {
    push({
      methodKind: 'provider_native',
      nativeKind: capabilities.nativeCompaction.kind
    });
  }
  if (config.kind === 'llm_summary') push({ methodKind: 'llm_summary' });
  if (config.kind === 'segmented_summary') push({ methodKind: 'segmented_summary' });
  if (config.kind === 'deterministic_summary') push({ methodKind: 'deterministic_summary' });
  if (config.kind === 'manual_summary') push({ methodKind: 'manual_summary' });

  for (const fallback of fallbacks) {
    if (fallback === 'segmented_summary') push({ methodKind: 'segmented_summary' });
    if (fallback === 'deterministic_summary') push({ methodKind: 'deterministic_summary' });
  }

  return {
    strategy: config.kind,
    attempts,
    continueUncompressedIfFits,
    nativeCapability: capabilities.nativeCompaction
  };
}

function resolveSummaryReasoningIntent(input: {
  mode?: LlmSummaryReasoningMode;
  methodGenerationConfig?: LlmGenerationConfigRecord;
  inheritedGenerationConfig?: LlmGenerationConfigRecord;
  capabilities: ModelCapabilitySnapshot;
}): ResolvedSummaryReasoning {
  const intent = input.mode ?? 'provider_default';
  const method = cloneGenerationConfig(input.methodGenerationConfig);
  const inherited = cloneGenerationConfig(input.inheritedGenerationConfig);
  const withoutThinking = { ...method };
  delete withoutThinking.thinkingConfig;

  if (intent === 'provider_default') {
    return resolvedProviderDefault(intent, withoutThinking, '跟随 Provider 默认，不发送 reasoning/thinking 覆盖。');
  }

  if (intent === 'inherit_chat') {
    const inheritedThinking = inherited.thinkingConfig;
    if (!inheritedThinking || !thinkingConfigSupported(inheritedThinking, input.capabilities.reasoning)) {
      return resolvedProviderDefault(intent, withoutThinking, '聊天思考配置不受当前总结模型确认支持，改用 Provider 默认。', 'unsupported');
    }
    return {
      intent,
      status: 'applied',
      description: '继承并验证了当前聊天模型的思考配置。',
      generationConfig: withThinking(withoutThinking, inheritedThinking)
    };
  }

  if (intent === 'explicit') {
    const explicit = method.thinkingConfig;
    if (!explicit) {
      return resolvedProviderDefault(intent, withoutThinking, '高级原生模式没有填写思考参数，改用 Provider 默认。', 'unsupported');
    }
    if (input.capabilities.source === 'unknown' || input.capabilities.reasoning.family === 'none') {
      return {
        intent,
        status: 'explicit_unverified',
        description: '按用户显式配置发送；当前兼容渠道无法验证该参数。',
        generationConfig: method
      };
    }
    if (!thinkingConfigSupported(explicit, input.capabilities.reasoning)) {
      return resolvedProviderDefault(intent, withoutThinking, '高级思考参数不在当前模型能力集合内，未发送。', 'unsupported');
    }
    return {
      intent,
      status: 'applied',
      description: '高级原生思考参数已通过当前模型能力校验。',
      generationConfig: method
    };
  }

  if (intent === 'disabled') {
    if (!input.capabilities.reasoning.canDisable) {
      return resolvedProviderDefault(intent, withoutThinking, '当前模型不支持关闭思考，改用 Provider 默认。', 'unsupported');
    }
    return {
      intent,
      status: 'applied',
      description: '当前模型已确认支持关闭思考。',
      generationConfig: withThinking(withoutThinking, input.capabilities.reasoning.family === 'gemini_budget'
        && input.capabilities.providerKind === 'gemini'
        ? { thinkingBudget: 0, includeThoughts: false } : { thinkingLevel: 'none' })
    };
  }

  const target = presetLevel(intent, input.capabilities.reasoning.levels);
  if (!target) {
    return resolvedProviderDefault(intent, withoutThinking, '当前模型没有与该预设完全对应的已确认档位，改用 Provider 默认。', 'unsupported');
  }
  return {
    intent,
    status: 'applied',
    description: `已映射为 ${target} 思考档位。`,
    generationConfig: withThinking(withoutThinking, {
      thinkingLevel: target,
      ...(input.capabilities.reasoning.family === 'gemini_level' ? { includeThoughts: false } : {})
    })
  };
}

export function capabilityDisplayLabel(capability: ModelCapabilitySnapshot): string {
  const native = capability.nativeCompaction;
  if (native.availability === 'documented') return '官方文档列出（未实测）';
  if (native.availability === 'verified') return capability.source === 'provider_api' ? 'Provider 能力 API 已确认' : '在线探测已通过';
  if (native.availability === 'declared') return '已由用户显式声明';
  if (native.availability === 'unsupported') return '当前模型不支持';
  return '尚未验证';
}

function resolvedProviderDefault(
  intent: LlmSummaryReasoningMode,
  generationConfig: LlmGenerationConfigRecord,
  description: string,
  status: ResolvedSummaryReasoning['status'] = 'provider_default'
): ResolvedSummaryReasoning {
  return {
    intent,
    status,
    description,
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {})
  };
}

function withThinking(
  generationConfig: LlmGenerationConfigRecord,
  thinkingConfig: LlmThinkingConfigRecord
): LlmGenerationConfigRecord {
  return { ...generationConfig, thinkingConfig: { ...thinkingConfig } };
}

export function thinkingConfigSupported(
  config: LlmThinkingConfigRecord,
  capability: ModelReasoningCapability
): boolean {
  const level = config.thinkingLevel;
  if (level === 'none') {
    if (!capability.canDisable || config.thinkingBudget !== undefined) return false;
  } else if (level && level !== 'not-set' && level !== 'non-set' && !capability.levels.includes(level)) return false;
  if (config.thinkingBudget !== undefined) {
    const budget = config.thinkingBudget;
    if (!capability.supportsBudget || !Number.isSafeInteger(budget)) return false;
    if (budget === 0 && !capability.canDisable) return false;
    if (budget < 0 && !(budget === -1 && capability.family === 'gemini_budget')) return false;
    if (budget > 0 && capability.minBudgetTokens !== undefined && budget < capability.minBudgetTokens) return false;
    if (capability.maxBudgetTokens !== undefined && budget > capability.maxBudgetTokens) return false;
    if (capability.family === 'gemini_budget' && level && level !== 'not-set' && level !== 'non-set') return false;
  }
  if (config.reasoningMode !== undefined && capability.family !== 'openai_effort') return false;
  if (config.includeThoughts !== undefined
    && capability.family !== 'gemini_level'
    && capability.family !== 'gemini_budget') return false;
  return capability.family !== 'none' || Object.keys(config).length === 0;
}

export function resolveSummaryReasoning(input: Parameters<typeof resolveSummaryReasoningIntent>[0]): ResolvedSummaryReasoning {
  const result = resolveSummaryReasoningIntent(input);
  const thinking = result.generationConfig?.thinkingConfig;
  if (!thinking || result.status === 'unsupported') return result;
  return { ...result, requestBody: reasoningNativeFields(thinking, input.capabilities) };
}

/** No guessing or silent correction for a user-requested hard setting. Presets may visibly use defaults. */
export function assertSummaryReasoningPlan(plan: ResolvedSummaryReasoning): void {
  if ((plan.intent === 'explicit' || plan.intent === 'disabled') && plan.status === 'unsupported') {
    throw Object.assign(new Error(plan.description), { code: 'UNSUPPORTED_REASONING_CONFIGURATION' });
  }
}

export function reasoningNativeFields(
  thinking: LlmThinkingConfigRecord,
  capabilities: ModelCapabilitySnapshot
): import('./protocol').LlmRequestBodyRecord {
  const level = thinking.thinkingLevel === 'not-set' || thinking.thinkingLevel === 'non-set'
    ? undefined : thinking.thinkingLevel;
  const budget = thinking.thinkingBudget;
  const provider = capabilities.providerKind;
  const family = capabilities.reasoning.family;
  if (provider === 'claude') {
    if (level === 'none') return { thinking: { type: 'disabled' } };
    const effort: import('./protocol').LlmRequestBodyRecord = level ? { output_config: { effort: level } } : {};
    if (budget !== undefined) return { ...effort, thinking: { type: 'enabled', budget_tokens: budget } };
    if (!level) return {};
    // Effort and thinking mode are independent on extended-only Opus. Never fabricate adaptive.
    return family === 'anthropic_extended' ? effort : { ...effort, thinking: { type: 'adaptive' } };
  }
  if (provider === 'gemini') {
    const config = {
      ...(level ? { thinkingLevel: level } : {}),
      ...(budget === undefined ? {} : { thinkingBudget: budget }),
      ...(thinking.includeThoughts === undefined ? {} : { includeThoughts: thinking.includeThoughts })
    };
    return Object.keys(config).length ? { generationConfig: { thinkingConfig: config } } : {};
  }
  if (provider === 'openai-compatible' && family.startsWith('gemini')) {
    const config = {
      ...(budget === undefined ? {} : { thinking_budget: budget }),
      ...(thinking.includeThoughts === undefined ? {} : { include_thoughts: thinking.includeThoughts })
    };
    // Thought visibility is independent of effort. Only a numeric budget replaces reasoning_effort.
    return {
      ...(budget === undefined && level ? { reasoning_effort: level } : {}),
      ...(Object.keys(config).length ? { extra_body: { google: { thinking_config: config } } } : {})
    };
  }
  if (provider === 'openai-responses') {
    const reasoning = {
      ...(level ? { effort: level } : {}),
      ...(thinking.reasoningMode ? { mode: thinking.reasoningMode } : {})
    };
    return Object.keys(reasoning).length ? { reasoning } : {};
  }
  return level ? { reasoning_effort: level } : {};
}

function presetLevel(
  intent: Exclude<LlmSummaryReasoningMode, 'provider_default' | 'inherit_chat' | 'disabled' | 'explicit'>,
  levels: readonly LlmThinkingLevel[]
): LlmThinkingLevel | undefined {
  if (intent === 'economy') {
    return ['minimal', 'low'].find((level) => levels.includes(level as LlmThinkingLevel)) as LlmThinkingLevel | undefined;
  }
  if (intent === 'balanced') return levels.includes('medium') ? 'medium' : undefined;
  if (intent === 'quality') return levels.includes('high') ? 'high' : undefined;
  const ranked = LEVEL_ORDER.filter((level) => level !== 'none' && levels.includes(level));
  return ranked[ranked.length - 1];
}

function normalizeFallbacks(input: readonly LlmCompressionFallbackKind[] | undefined): LlmCompressionFallbackKind[] {
  const values = input ?? DEFAULT_FALLBACKS;
  return [...new Set(values.filter((value): value is LlmCompressionFallbackKind =>
    value === 'segmented_summary'
      || value === 'deterministic_summary'
      || value === 'continue_uncompressed_if_fits'))];
}

function cloneGenerationConfig(input: LlmGenerationConfigRecord | undefined): LlmGenerationConfigRecord {
  if (!input) return {};
  return {
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { topP: input.topP } : {}),
    ...(input.topK !== undefined ? { topK: input.topK } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.thinkingConfig ? { thinkingConfig: { ...input.thinkingConfig } } : {})
  };
}

function openAIReasoningCapability(modelId: string): ModelReasoningCapability {
  // Only documented model ids, plus their dated snapshots. A gateway alias/future family is unknown.
  const id = modelId.toLowerCase().replace(/-\d{4}-\d{2}-\d{2}$/, '');
  // GPT-6（https://developers.openai.com/api/docs/models/gpt-6-astra、gpt-6-sol、gpt-6-luna）：
  // Astra 的 reasoning.effort 支持 low、medium、high、xhigh、max，不支持 none，官方没有写默认值；
  // Sol 和 Luna 支持 none、low、medium（默认）、high、xhigh、max。`pro` 是 reasoning.mode，不是模型 id。
  const levels: Record<string, LlmThinkingLevel[]> = {
    'gpt-5': ['minimal', 'low', 'medium', 'high'],
    'gpt-5-mini': ['minimal', 'low', 'medium', 'high'],
    'gpt-5-nano': ['minimal', 'low', 'medium', 'high'],
    'gpt-5.1': ['none', 'low', 'medium', 'high'],
    'gpt-5.2': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-5.4': ['none', 'low', 'medium', 'high', 'xhigh'],
    'gpt-6-astra': ['low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-6-sol': ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
    'gpt-6-luna': ['none', 'low', 'medium', 'high', 'xhigh', 'max']
  };
  const defaultLevels: Record<string, LlmThinkingLevel> = {
    'gpt-6-sol': 'medium',
    'gpt-6-luna': 'medium'
  };
  if (!levels[id]) return unknownReasoningCapability();
  return {
    family: 'openai_effort', levels: levels[id],
    ...(defaultLevels[id] ? { defaultLevel: defaultLevels[id] } : {}),
    supportsBudget: false,
    canDisable: levels[id].includes('none'), alwaysOn: !levels[id].includes('none'),
    outputLimitIncludesThinking: true, requiresThoughtSignatures: true
  };
}

/**
 * Claude 思考族（https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting 按模型表）：
 * adaptive-only 拒绝 `enabled`；Fable/Mythos/Opus 5.5 始终开启、拒绝 `disabled`；4.5 及更早只有 extended、拒绝 `adaptive`。
 * Claude Opus 5.5（https://platform.claude.com/docs/en/models/opus-5-5/overview）：adaptive 始终开启，五档 effort，默认 medium。
 */
function anthropicReasoningCapability(modelId: string): ModelReasoningCapability {
  const id = modelId.toLowerCase().replace(/-\d{8}$/, '');
  const adaptiveOnly = ['claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5', 'claude-mythos-5-1',
    'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-7', 'claude-opus-4-8', 'claude-sonnet-5'];
  const hybrid = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-mythos-preview'];
  const extended = ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5',
    'claude-opus-4', 'claude-opus-4-1', 'claude-sonnet-4', 'claude-3-7-sonnet'];
  const family = adaptiveOnly.includes(id) ? 'anthropic_adaptive'
    : hybrid.includes(id) ? 'anthropic_hybrid'
    : extended.includes(id) ? 'anthropic_extended' : undefined;
  if (!family) return unknownReasoningCapability();
  const alwaysOn = id.startsWith('claude-fable-') || id.startsWith('claude-mythos-') || id === 'claude-opus-5-5';
  const levels: LlmThinkingLevel[] = family === 'anthropic_extended'
    ? id === 'claude-opus-4-5' ? ['low', 'medium', 'high'] : []
    : ['low', 'medium', 'high', ...(adaptiveOnly.includes(id) ? ['xhigh' as const] : []), 'max'];
  const defaultLevel: LlmThinkingLevel = id === 'claude-opus-5-5' ? 'medium' : 'high';
  return {
    family, levels, ...(levels.length ? { defaultLevel } : {}),
    supportsBudget: family !== 'anthropic_adaptive', canDisable: !alwaysOn, alwaysOn,
    outputLimitIncludesThinking: true, requiresThoughtSignatures: true,
    ...(family !== 'anthropic_adaptive' ? { minBudgetTokens: 1024 } : {})
  };
}

/** 按模型 id 查 Claude 思考族（与端点无关）；不在能力表里的模型返回 undefined。 */
export function anthropicModelReasoningCapability(modelId: string): ModelReasoningCapability | undefined {
  const capability = anthropicReasoningCapability(modelId.trim());
  return capability.family === 'none' ? undefined : capability;
}

function anthropicNativeCompactionCapability(modelId: string): ModelNativeCompactionCapability {
  const id = modelId.toLowerCase().replace(/-\d{8}$/, '');
  const supported = ['claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5', 'claude-mythos-5-1',
    'claude-mythos-preview', 'claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7',
    'claude-opus-4-6', 'claude-sonnet-5', 'claude-sonnet-4-6'].includes(id);
  return supported
    ? { kind: 'anthropic_messages', availability: 'documented', reason: '官方文档列出的按需签名压缩模型；尚未实时探测。' }
    : { availability: 'unknown', reason: '该模型没有确认按需 compaction 能力；可刷新 Models API 获取。' };
}

function geminiReasoningCapability(modelId: string, openAICompatible = false): ModelReasoningCapability {
  const model = normalizeGeminiModelId(modelId);
  const budgets: Record<string, { min: number; max: number; canDisable: boolean }> = {
    'gemini-2.5-pro': { min: 128, max: 32768, canDisable: false },
    'gemini-2.5-flash': { min: 1, max: 24576, canDisable: true },
    'gemini-2.5-flash-lite': { min: 512, max: 24576, canDisable: true }
  };
  const budget = budgets[model];
  if (budget) return {
    family: 'gemini_budget',
    levels: openAICompatible ? ['minimal', 'low', 'medium', 'high'] : [],
    supportsBudget: true, canDisable: budget.canDisable, alwaysOn: !budget.canDisable,
    outputLimitIncludesThinking: true, requiresThoughtSignatures: true,
    minBudgetTokens: budget.min, maxBudgetTokens: budget.max
  };
  const table: Record<string, { levels: LlmThinkingLevel[]; defaultLevel: LlmThinkingLevel }> = {
    'gemini-3.8-flash': { levels: ['low', 'medium', 'high'], defaultLevel: 'medium' },
    'gemini-3.7-flash': { levels: ['low', 'medium', 'high'], defaultLevel: 'medium' },
    'gemini-3.6-flash': { levels: ['minimal', 'low', 'medium', 'high'], defaultLevel: 'medium' },
    'gemini-3.5-flash': { levels: ['minimal', 'low', 'medium', 'high'], defaultLevel: 'medium' },
    'gemini-3.5-flash-lite': { levels: ['minimal', 'low', 'medium', 'high'], defaultLevel: 'minimal' },
    'gemini-3.1-pro-preview': { levels: ['low', 'medium', 'high'], defaultLevel: 'high' },
    'gemini-3.1-flash-lite-preview': { levels: ['minimal', 'low', 'medium', 'high'], defaultLevel: 'minimal' },
    'gemini-3.1-flash-lite': { levels: ['minimal', 'low', 'medium', 'high'], defaultLevel: 'minimal' },
    'gemini-3.1-flash-lite-image': { levels: ['minimal', 'high'], defaultLevel: 'minimal' },
    'gemini-3.1-flash-image-preview': { levels: ['minimal', 'high'], defaultLevel: 'minimal' },
    'gemini-3-flash-preview': { levels: ['minimal', 'low', 'medium', 'high'], defaultLevel: 'high' },
    'gemini-3-pro-preview': { levels: ['low', 'high'], defaultLevel: 'high' },
    'gemini-3-pro-image-preview': { levels: ['low', 'high'], defaultLevel: 'high' }
  };
  const matched = table[model];
  if (!matched) return unknownReasoningCapability();
  return {
    family: 'gemini_level', levels: matched.levels, defaultLevel: matched.defaultLevel,
    supportsBudget: false, canDisable: false, alwaysOn: true,
    outputLimitIncludesThinking: true, requiresThoughtSignatures: true
  };
}

function unknownReasoningCapability(family: ReasoningCapabilityFamily = 'none'): ModelReasoningCapability {
  return {
    family,
    levels: [],
    supportsBudget: false,
    canDisable: false,
    alwaysOn: false,
    outputLimitIncludesThinking: true,
    requiresThoughtSignatures: false
  };
}

function normalizeGeminiModelId(modelId: string): string {
  return modelId.trim().toLowerCase().replace(/^models\//, '');
}

function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function normalizedEndpointFingerprint(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.protocol}//${url.host.toLowerCase()}${path}`;
  } catch {
    return 'invalid-endpoint';
  }
}

function isOfficialEndpoint(baseUrl: string, host: string, paths: string[]): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === host
      && !url.port && !url.username && !url.password && !url.search && !url.hash
      && paths.includes(url.pathname.replace(/\/+$/, ''));
  } catch { return false; }
}
