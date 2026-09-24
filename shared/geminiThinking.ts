import { resolveModelCapabilities } from './modelCapabilities';
import type { LlmThinkingLevel } from './protocol';

export type GeminiThinkingLevel = Extract<LlmThinkingLevel, 'minimal' | 'low' | 'medium' | 'high'>;

export interface GeminiThinkingLevelCapability {
  kind: 'thinkingLevel';
  levels: readonly GeminiThinkingLevel[];
  defaultLevel: GeminiThinkingLevel;
}

export interface GeminiThinkingBudgetCapability {
  kind: 'thinkingBudget';
  levels: readonly [];
}

export interface GeminiThinkingUnsupportedCapability {
  kind: 'unsupported';
  levels: readonly [];
}

export interface GeminiThinkingUnknownCapability {
  kind: 'unknown';
  levels: readonly GeminiThinkingLevel[];
}

export type GeminiThinkingCapability =
  | GeminiThinkingLevelCapability
  | GeminiThinkingBudgetCapability
  | GeminiThinkingUnsupportedCapability
  | GeminiThinkingUnknownCapability;

const ALL_GEMINI_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const satisfies readonly GeminiThinkingLevel[];
const NO_LEVELS = [] as const;

/**
 * 返回 Gemini 模型原生支持的思考控制方式。
 *
 * Gemini 2.5 使用 thinkingBudget；Gemini 3.x 使用 thinkingLevel，而且各模型系列
 * 支持的等级并不相同。未知模型不猜测请求能力，由调用方保留通用编辑体验但不应用
 * Gemini 3.x 的请求默认值。
 */
export function geminiThinkingCapabilityForModel(modelId: string | undefined): GeminiThinkingCapability {
  const model = normalizeGeminiModelId(modelId);
  if (!model) return { kind: 'unknown', levels: ALL_GEMINI_THINKING_LEVELS };
  if (!isGeminiModelId(model)) return { kind: 'unsupported', levels: NO_LEVELS };

  const capability = resolveModelCapabilities({
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    modelId: model,
    trustMode: 'verified_only'
  }).reasoning;
  if (capability.family === 'gemini_budget') {
    return { kind: 'thinkingBudget', levels: NO_LEVELS };
  }
  if (capability.family === 'gemini_level' && capability.defaultLevel) {
    const levels = capability.levels.filter(isGeminiThinkingLevel);
    return {
      kind: 'thinkingLevel',
      levels,
      defaultLevel: isGeminiThinkingLevel(capability.defaultLevel)
        ? capability.defaultLevel
        : levels[0] ?? 'high'
    };
  }
  return { kind: 'unknown', levels: ALL_GEMINI_THINKING_LEVELS };
}

export function isGeminiThinkingLevelSupported(
  capability: GeminiThinkingCapability,
  value: unknown
): value is GeminiThinkingLevel {
  return capability.kind === 'thinkingLevel'
    && typeof value === 'string'
    && capability.levels.some((level) => level === value);
}

function isGeminiThinkingLevel(value: LlmThinkingLevel): value is GeminiThinkingLevel {
  return value === 'minimal' || value === 'low' || value === 'medium' || value === 'high';
}

function normalizeGeminiModelId(modelId: string | undefined): string {
  const normalized = modelId?.trim().toLowerCase() ?? '';
  if (!normalized) return '';
  return normalized.match(/gemini-[a-z0-9][a-z0-9._-]*/)?.[0] ?? normalized;
}

function isGeminiModelId(modelId: string): boolean {
  return /^gemini-(?:\d|pro|flash)/.test(modelId);
}
