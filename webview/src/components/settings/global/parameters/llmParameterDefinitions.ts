import { THINKING_LEVEL_OPTIONS } from '@shared/llmThinkingLevels';
import type { LlmProviderKind, LlmReasoningMode, LlmThinkingLevel } from '@shared/protocol';
import { geminiThinkingCapabilityForModel } from '@shared/geminiThinking';

export type LlmParameterValueType = 'number' | 'boolean' | 'enum';

export interface LlmParameterDefinition {
  /** 内部稳定 key，用于识别参数定义。 */
  key: string;
  /** LimCode 写入 generationConfig 的统一路径，不随 provider 改变。 */
  path: string[];
  /** 面向用户展示的参数名，会按 provider 调整为更接近原生字段的名称。 */
  label: string;
  /** 面向用户展示的说明，会按 provider 补充原生映射说明。 */
  description: string;
  /** 当前 provider 下最终请求体里的原生字段路径，仅用于 UI 展示。 */
  displayPath: string;
  valueType: LlmParameterValueType;
  defaultValue: number | boolean | LlmThinkingLevel | LlmReasoningMode;
  providers: readonly LlmProviderKind[];
  options?: readonly { value: string; label: string; description?: string }[];
}

type BaseLlmParameterDefinition = Omit<LlmParameterDefinition, 'displayPath'>;

interface ProviderParameterDisplay {
  label?: string;
  path: string;
  description?: string;
}

const ALL_PROVIDERS = ['openai-compatible', 'openai-responses', 'claude', 'gemini', 'deepseek'] as const satisfies readonly LlmProviderKind[];
const GEMINI_CLAUDE = ['gemini', 'claude'] as const satisfies readonly LlmProviderKind[];
const REASONING_MODE_OPTIONS = [
  { value: 'standard', label: '标准' },
  { value: 'pro', label: '专业' }
] as const satisfies readonly { value: LlmReasoningMode; label: string }[];


const PROVIDER_PARAMETER_DISPLAY: Record<LlmProviderKind, Record<string, ProviderParameterDisplay>> = {
  gemini: {
    temperature: { path: 'generationConfig.temperature' },
    topP: { path: 'generationConfig.topP' },
    topK: { path: 'generationConfig.topK' },
    maxOutputTokens: { path: 'generationConfig.maxOutputTokens' },
    includeThoughts: { path: 'generationConfig.thinkingConfig.includeThoughts' },
    thinkingBudget: { path: 'generationConfig.thinkingConfig.thinkingBudget' },
    thinkingLevel: { path: 'generationConfig.thinkingConfig.thinkingLevel', label: 'Thinking Level' }
  },
  claude: {
    temperature: { path: 'temperature' },
    topP: { path: 'top_p', label: 'Top P / top_p' },
    topK: { path: 'top_k', label: 'Top K / top_k' },
    maxOutputTokens: { path: 'max_tokens', label: 'Max Tokens' },
    thinkingBudget: {
      path: 'thinking.budget_tokens',
      label: '思考预算',
      description: 'Claude 原生思考 Token 预算；如果同时设置思考强度，系统会优先使用强度等级。'
    },
    thinkingLevel: {
      path: 'thinking.type / output_config.effort',
      label: '思考强度',
      description: 'Claude：关闭时禁用思考；低、高等等级会转换为对应的自适应思考强度。'
    }
  },
  'openai-compatible': {
    temperature: { path: 'temperature' },
    topP: { path: 'top_p', label: 'Top P / top_p' },
    maxOutputTokens: { path: 'max_tokens', label: 'Max Tokens' },
    thinkingLevel: {
      path: 'reasoning_effort',
      label: 'Reasoning Effort',
      description: 'OpenAI Chat / Compatible 原生推理强度字段。'
    }
  },
  'openai-responses': {
    temperature: { path: 'temperature' },
    topP: { path: 'top_p', label: 'Top P / top_p' },
    maxOutputTokens: { path: 'max_output_tokens', label: 'Max Output Tokens' },
    reasoningMode: {
      path: 'reasoning.mode',
      label: '推理模式',
      description: 'OpenAI Responses 推理模式：standard 为标准模式，pro 为专业模式。'
    },
    thinkingLevel: {
      path: 'reasoning.effort',
      label: '推理强度',
      description: 'OpenAI Responses 的推理强度设置。'
    }
  },
  deepseek: {
    temperature: { path: 'temperature' },
    topP: { path: 'top_p', label: 'Top P / top_p' },
    maxOutputTokens: { path: 'max_tokens', label: 'Max Tokens' },
    thinkingLevel: {
      path: 'thinking.type / reasoning_effort',
      label: '思考强度',
      description: 'DeepSeek 思考控制：关闭时禁用思考；高和最高会启用对应强度。'
    }
  }
};

export const LLM_PARAMETER_DEFINITIONS: readonly BaseLlmParameterDefinition[] = [
  {
    key: 'temperature',
    path: ['temperature'],
    label: 'Temperature',
    description: '控制输出随机性，值越高越发散。',
    valueType: 'number',
    defaultValue: 0.7,
    providers: ALL_PROVIDERS
  },
  {
    key: 'topP',
    path: ['topP'],
    label: 'Top P',
    description: '核采样阈值，通常取 0-1。',
    valueType: 'number',
    defaultValue: 0.9,
    providers: ALL_PROVIDERS
  },
  {
    key: 'topK',
    path: ['topK'],
    label: 'Top K',
    description: '候选 Token 数量上限，仅 Gemini 和 Claude 支持。',
    valueType: 'number',
    defaultValue: 40,
    providers: GEMINI_CLAUDE
  },
  {
    key: 'maxOutputTokens',
    path: ['maxOutputTokens'],
    label: '最大输出 Token',
    description: '限制单次回复输出的 Token 数。',
    valueType: 'number',
    defaultValue: 1024,
    providers: ALL_PROVIDERS
  },
  {
    key: 'includeThoughts',
    path: ['thinkingConfig', 'includeThoughts'],
    label: '输出思考内容',
    description: '是否让 Gemini 返回思考内容；其他 LLM 服务会忽略此设置。',
    valueType: 'boolean',
    defaultValue: true,
    providers: ['gemini']
  },
  {
    key: 'thinkingBudget',
    path: ['thinkingConfig', 'thinkingBudget'],
    label: '思考预算',
    description: '思考 Token 预算，Gemini 和 Claude 支持此设置。',
    valueType: 'number',
    defaultValue: 10000,
    providers: GEMINI_CLAUDE
  },
  {
    key: 'reasoningMode',
    path: ['thinkingConfig', 'reasoningMode'],
    label: '推理模式',
    description: 'OpenAI Responses 推理模式。',
    valueType: 'enum',
    defaultValue: 'standard',
    providers: ['openai-responses'],
    options: REASONING_MODE_OPTIONS
  }
];

export function thinkingLevelDefinition(provider: LlmProviderKind, modelId?: string): LlmParameterDefinition {
  const capability = provider === 'gemini' ? geminiThinkingCapabilityForModel(modelId) : undefined;
  const options = capability?.levels.length
    ? capability.levels.map((level) => THINKING_LEVEL_OPTIONS.gemini.find((option) => option.value === level)!)
    : THINKING_LEVEL_OPTIONS[provider] ?? THINKING_LEVEL_OPTIONS['openai-compatible'];
  return withProviderDisplay({
    key: 'thinkingLevel',
    path: ['thinkingConfig', 'thinkingLevel'],
    label: '思考强度',
    description: 'LLM 的思考或推理强度；系统会按当前渠道转换为对应请求参数。',
    valueType: 'enum',
    defaultValue: capability?.kind === 'thinkingLevel' ? capability.defaultLevel : options[0]?.value ?? 'low',
    providers: [provider],
    options
  }, provider);
}

export function parameterDefinitionsForProvider(provider: LlmProviderKind, modelId?: string): LlmParameterDefinition[] {
  const geminiCapability = provider === 'gemini' ? geminiThinkingCapabilityForModel(modelId) : undefined;
  const definitions = LLM_PARAMETER_DEFINITIONS
    .filter((definition) => definition.providers.includes(provider))
    .filter((definition) => {
      if (provider !== 'gemini' || definition.key !== 'thinkingBudget') return true;
      return geminiCapability?.kind === 'thinkingBudget' || geminiCapability?.kind === 'unknown';
    })
    .map((definition) => withProviderDisplay(definition, provider));
  const supportsThinkingLevel = provider !== 'gemini'
    || geminiCapability?.kind === 'thinkingLevel'
    || geminiCapability?.kind === 'unknown';
  return supportsThinkingLevel
    ? [...definitions, thinkingLevelDefinition(provider, modelId)]
    : definitions;
}

export function labelForProvider(provider: LlmProviderKind): string {
  switch (provider) {
    case 'openai-compatible':
      return 'OpenAI Compatible';
    case 'openai-responses':
      return 'OpenAI Responses';
    case 'claude':
      return 'Claude';
    case 'gemini':
      return 'Gemini';
    case 'deepseek':
      return 'DeepSeek';
    default:
      return provider;
  }
}

function withProviderDisplay(definition: BaseLlmParameterDefinition, provider: LlmProviderKind): LlmParameterDefinition {
  const display = PROVIDER_PARAMETER_DISPLAY[provider]?.[definition.key];
  return {
    ...definition,
    label: display?.label ?? definition.label,
    description: display?.description ?? definition.description,
    displayPath: display?.path ?? definition.path.join('.')
  };
}
