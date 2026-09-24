import type { LlmThinkingLevel, OpenAICompatibleThinkingFormat } from './protocol';

/**
 * OpenAI 兼容渠道的方言识别。
 *
 * 很多服务商在 Chat Completions 上沿用了 DeepSeek 的写法（`reasoning_content`、`thinking.type`、
 * `reasoning_effort`），但同一个模型在不同平台上的参数名不同（DeepSeek V4 在官方用 `thinking.type`，
 * 在百炼、硅基流动用 `enable_thinking`）。所以分两层判断：
 * - 参数写法看接口地址（平台）；认不出的中转站再看模型 ID；
 * - 模型能做什么（能否关闭思考、`reasoning_effort` 接受哪些值、是否必须回传思考内容）看模型 ID。
 * 用户可以在渠道或模型高级配置里手动指定写法，覆盖自动识别。
 *
 * 依据各家官方文档（2026-09）：DeepSeek、小米 MiMo、Kimi、智谱、腾讯 TokenHub、火山方舟、
 * 阿里百炼、硅基流动、百度千帆、OpenRouter。
 */

export type OpenAICompatiblePlatform =
  | 'deepseek'
  | 'mimo'
  | 'moonshot'
  | 'zhipu'
  | 'tencent'
  | 'ark'
  | 'dashscope'
  | 'siliconflow'
  | 'qianfan'
  | 'openrouter'
  | 'local'
  | 'unknown';

export type OpenAICompatibleModelFamily = 'deepseek' | 'mimo' | 'kimi' | 'glm' | 'hunyuan' | 'qwen' | 'ernie';

export interface OpenAICompatibleModelThinkingRule {
  family: OpenAICompatibleModelFamily;
  /** 用 `thinking.type` 开关思考；Kimi K3 不接受 `thinking` 参数。 */
  toggle: boolean;
  /** 接受 `thinking.type: disabled`；GLM-5.3、Kimi K2.7 Code 传 disabled 会报错。 */
  canDisable: boolean;
  /** 模型接受的 `reasoning_effort`；空数组表示从不发送强度。 */
  efforts: readonly LlmThinkingLevel[];
  /** 官方接口在带 tools 的请求里要求每条 assistant 消息都回传 `reasoning_content`，否则返回 400。 */
  requiresReasoningReplay: boolean;
}

export interface OpenAICompatibleDialect {
  platform: OpenAICompatiblePlatform;
  /** 统一后的模型名（见 normalizedOpenAICompatibleModelName）。 */
  modelName: string;
  rule?: OpenAICompatibleModelThinkingRule;
  format: OpenAICompatibleThinkingFormat;
  /** manual：用户手动指定；platform：按接口地址；model：按模型 ID；default：都认不出，保持 OpenAI 写法。 */
  source: 'manual' | 'platform' | 'model' | 'default';
  /** tool 消息的 content 可以放图片/文件数组（DeepSeek、MiMo 官方接口）。 */
  toolContentArrays: boolean;
  /** 带 tools 的请求里，给每条 assistant 消息补上 `reasoning_content`（缺失时为空串）。 */
  fillReasoningReplay: boolean;
}

const DEEPSEEK_STYLE_EFFORTS: readonly LlmThinkingLevel[] = ['low', 'high', 'max'];

const MODEL_RULES: ReadonlyArray<{ pattern: RegExp; rule: OpenAICompatibleModelThinkingRule }> = [
  { pattern: /^deepseek/, rule: { family: 'deepseek', toggle: true, canDisable: true, efforts: DEEPSEEK_STYLE_EFFORTS, requiresReasoningReplay: true } },
  { pattern: /^mimo/, rule: { family: 'mimo', toggle: true, canDisable: true, efforts: [], requiresReasoningReplay: true } },
  { pattern: /^kimi-k3/, rule: { family: 'kimi', toggle: false, canDisable: false, efforts: DEEPSEEK_STYLE_EFFORTS, requiresReasoningReplay: false } },
  { pattern: /^kimi-k2-7-code/, rule: { family: 'kimi', toggle: true, canDisable: false, efforts: [], requiresReasoningReplay: false } },
  { pattern: /^kimi-/, rule: { family: 'kimi', toggle: true, canDisable: true, efforts: [], requiresReasoningReplay: false } },
  { pattern: /^glm-5-3/, rule: { family: 'glm', toggle: true, canDisable: false, efforts: DEEPSEEK_STYLE_EFFORTS, requiresReasoningReplay: false } },
  { pattern: /^glm-5-2/, rule: { family: 'glm', toggle: true, canDisable: true, efforts: DEEPSEEK_STYLE_EFFORTS, requiresReasoningReplay: false } },
  { pattern: /^glm-/, rule: { family: 'glm', toggle: true, canDisable: true, efforts: [], requiresReasoningReplay: false } },
  { pattern: /^(?:hunyuan|hy\d)/, rule: { family: 'hunyuan', toggle: true, canDisable: true, efforts: ['low', 'high'], requiresReasoningReplay: false } },
  { pattern: /^qwen/, rule: { family: 'qwen', toggle: true, canDisable: true, efforts: [], requiresReasoningReplay: false } },
  { pattern: /^ernie/, rule: { family: 'ernie', toggle: true, canDisable: true, efforts: [], requiresReasoningReplay: false } }
];

/** 这些模型系列在认不出的中转站上也按 DeepSeek 写法发送（各家官方都是这一套）。 */
const DEEPSEEK_STYLE_FAMILIES: ReadonlySet<OpenAICompatibleModelFamily> = new Set(['deepseek', 'mimo', 'kimi', 'glm', 'hunyuan']);

/**
 * 统一模型 ID：去掉 `deepseek-ai/`、`Pro/`、`kimi/` 等平台前缀，小写，点号换成连字符
 * （方舟把 `glm-5.3` 写成 `glm-5-3-flash-260828`）。
 */
export function normalizedOpenAICompatibleModelName(model: string): string {
  const last = model.trim().toLowerCase().split('/').filter(Boolean).pop() ?? '';
  return last.replace(/\./g, '-');
}

export function openAICompatibleModelThinkingRule(model: string): OpenAICompatibleModelThinkingRule | undefined {
  const name = normalizedOpenAICompatibleModelName(model);
  return MODEL_RULES.find((entry) => entry.pattern.test(name))?.rule;
}

export function openAICompatiblePlatform(baseUrl: string): OpenAICompatiblePlatform {
  let host: string;
  try {
    host = new URL(baseUrl.trim()).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return 'unknown';
  }
  const within = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (within('deepseek.com')) return 'deepseek';
  if (within('xiaomimimo.com')) return 'mimo';
  if (within('moonshot.cn') || within('moonshot.ai')) return 'moonshot';
  if (within('bigmodel.cn') || within('z.ai')) return 'zhipu';
  if (within('tencentmaas.com') || host === 'api.hunyuan.cloud.tencent.com') return 'tencent';
  if (within('volces.com')) return 'ark';
  if (within('aliyuncs.com') && (host.startsWith('dashscope') || host.includes('.maas.'))) return 'dashscope';
  if (within('siliconflow.cn') || within('siliconflow.com')) return 'siliconflow';
  if (within('qianfan.baidubce.com')) return 'qianfan';
  if (within('openrouter.ai')) return 'openrouter';
  if (isLocalHost(host)) return 'local';
  return 'unknown';
}

function isLocalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || host === '0.0.0.0') return true;
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

export function resolveOpenAICompatibleDialect(
  baseUrl: string,
  model: string,
  manual?: OpenAICompatibleThinkingFormat
): OpenAICompatibleDialect {
  const platform = openAICompatiblePlatform(baseUrl);
  const rule = openAICompatibleModelThinkingRule(model);
  const automatic = automaticFormat(platform, rule);
  const format = manual ?? automatic.format;
  const source = manual ? 'manual' : automatic.source;
  return {
    platform,
    modelName: normalizedOpenAICompatibleModelName(model),
    ...(rule ? { rule } : {}),
    format,
    source,
    toolContentArrays: format === 'deepseek' && (platform === 'deepseek' || platform === 'mimo'),
    fillReasoningReplay: format === 'deepseek'
      || (rule?.requiresReasoningReplay === true && platform !== 'openrouter' && platform !== 'local')
  };
}

function automaticFormat(
  platform: OpenAICompatiblePlatform,
  rule: OpenAICompatibleModelThinkingRule | undefined
): { format: OpenAICompatibleThinkingFormat; source: OpenAICompatibleDialect['source'] } {
  switch (platform) {
    case 'deepseek':
    case 'mimo':
    case 'moonshot':
    case 'zhipu':
    case 'tencent':
    case 'ark':
      return { format: 'deepseek', source: 'platform' };
    case 'dashscope':
    case 'siliconflow':
      return { format: 'enable_thinking', source: 'platform' };
    case 'qianfan':
      // 千帆按模型分：DeepSeek、Kimi、GLM 用 thinking.type（默认关闭），Qwen、ERNIE 用 enable_thinking。
      if (rule?.family === 'qwen' || rule?.family === 'ernie') return { format: 'enable_thinking', source: 'platform' };
      if (rule && DEEPSEEK_STYLE_FAMILIES.has(rule.family)) return { format: 'deepseek', source: 'platform' };
      return { format: 'reasoning_effort', source: 'default' };
    case 'openrouter':
      // OpenRouter 的顶层 reasoning_effort 是 reasoning.effort 的简写，none 也可用；不能套 DeepSeek 写法。
      return { format: 'reasoning_effort', source: 'platform' };
    case 'local':
      // vLLM / SGLang / Ollama 的开关走 chat_template_kwargs，键名随模型模板变，第一期保持原样。
      return { format: 'reasoning_effort', source: 'platform' };
    case 'unknown':
      return rule && DEEPSEEK_STYLE_FAMILIES.has(rule.family)
        ? { format: 'deepseek', source: 'model' }
        : { format: 'reasoning_effort', source: 'default' };
  }
}

/**
 * 本平台、本模型接受的 `reasoning_effort` 取值；空数组表示不发送强度（只开关思考）。
 * 方舟接受七档，按原值发送；硅基流动、千帆只对 DeepSeek V4（硅基流动还有 GLM-5.2）接受 high / max。
 */
export function openAICompatibleEffortValues(dialect: OpenAICompatibleDialect): readonly LlmThinkingLevel[] | 'any' {
  if (dialect.platform === 'ark') return 'any';
  if (dialect.platform === 'siliconflow' || dialect.platform === 'qianfan') {
    const v4 = /^deepseek-v4/.test(dialect.modelName);
    const glm52 = dialect.platform === 'siliconflow' && /^glm-5-2/.test(dialect.modelName);
    return v4 || glm52 ? ['high', 'max'] : [];
  }
  if (dialect.platform === 'dashscope') return [];
  if (dialect.rule) return dialect.rule.efforts;
  // 手动指定 DeepSeek 写法、模型认不出时按 DeepSeek 的取值。
  return dialect.format === 'deepseek' ? DEEPSEEK_STYLE_EFFORTS : 'any';
}

const LEVEL_ORDER: readonly LlmThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 把渠道上的思考档位换成对方接受的值。先按 DeepSeek 官方的换算（minimal→low，medium、xhigh→high），
 * 仍不在集合里时取不低于它的最小值，没有就取最大值。
 */
export function mapOpenAICompatibleEffort(
  level: LlmThinkingLevel,
  allowed: readonly LlmThinkingLevel[] | 'any'
): LlmThinkingLevel | undefined {
  if (allowed === 'any') return level;
  if (allowed.length === 0) return undefined;
  if (allowed.includes(level)) return level;
  const official = level === 'minimal' ? 'low' : level === 'medium' || level === 'xhigh' ? 'high' : level;
  if (allowed.includes(official)) return official;
  const rank = LEVEL_ORDER.indexOf(official);
  const higher = allowed
    .filter((value) => LEVEL_ORDER.indexOf(value) >= rank)
    .sort((left, right) => LEVEL_ORDER.indexOf(left) - LEVEL_ORDER.indexOf(right));
  return higher[0] ?? [...allowed].sort((left, right) => LEVEL_ORDER.indexOf(right) - LEVEL_ORDER.indexOf(left))[0];
}

/** 会话思考强度下拉可选的值：能关闭时有“关闭”，只能开关的模型只给“开启（high）”。 */
export function openAICompatibleSessionThinkingValues(rule: OpenAICompatibleModelThinkingRule): LlmThinkingLevel[] {
  const levels: LlmThinkingLevel[] = rule.efforts.length ? [...rule.efforts] : ['high'];
  return rule.canDisable ? ['none', ...levels] : levels;
}

const PLATFORM_LABELS: Record<OpenAICompatiblePlatform, string> = {
  deepseek: 'DeepSeek 官方',
  mimo: '小米 MiMo',
  moonshot: 'Kimi（月之暗面）',
  zhipu: '智谱',
  tencent: '腾讯 TokenHub',
  ark: '火山方舟',
  dashscope: '阿里百炼',
  siliconflow: '硅基流动',
  qianfan: '百度千帆',
  openrouter: 'OpenRouter',
  local: '本机或局域网服务',
  unknown: '未知服务'
};

export const OPENAI_COMPATIBLE_THINKING_FORMAT_LABELS: Record<OpenAICompatibleThinkingFormat, string> = {
  deepseek: 'DeepSeek 写法（thinking.type + reasoning_effort）',
  enable_thinking: 'enable_thinking 写法（百炼、硅基流动等）',
  reasoning_effort: 'OpenAI 写法（只发 reasoning_effort）',
  omit: '不发送思考参数'
};

/** 设置界面上说明自动识别的结果，例如“DeepSeek 写法 · 按接口地址识别：DeepSeek 官方”。 */
export function describeOpenAICompatibleDialect(dialect: OpenAICompatibleDialect): string {
  const format = OPENAI_COMPATIBLE_THINKING_FORMAT_LABELS[dialect.format];
  switch (dialect.source) {
    case 'manual': return `${format} · 手动指定`;
    case 'platform': return `${format} · 按接口地址识别：${PLATFORM_LABELS[dialect.platform]}`;
    case 'model': return `${format} · 按模型 ID 识别`;
    case 'default': return `${format} · 未识别出服务商或模型，按 OpenAI 写法`;
  }
}

/** 新建 OpenAI 兼容渠道时可选的服务商：只填接口地址，思考参数写法由上面的自动识别决定。 */
export const OPENAI_COMPATIBLE_SERVICE_PRESETS: ReadonlyArray<{ id: OpenAICompatiblePlatform; label: string; baseUrl: string }> = [
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'moonshot', label: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'zhipu', label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'mimo', label: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1' },
  { id: 'tencent', label: '腾讯 TokenHub', baseUrl: 'https://tokenhub.tencentmaas.com/v1' },
  { id: 'ark', label: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { id: 'dashscope', label: '阿里百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1' },
  { id: 'qianfan', label: '百度千帆', baseUrl: 'https://qianfan.baidubce.com/v2' },
  { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' }
];
