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
  | 'kimi-code'
  | 'zhipu'
  | 'tencent'
  | 'hunyuan'
  | 'ark'
  | 'dashscope'
  | 'siliconflow'
  | 'qianfan'
  | 'openrouter'
  | 'local'
  | 'unknown';

export type OpenAICompatibleModelFamily = 'deepseek' | 'mimo' | 'kimi' | 'glm' | 'hunyuan' | 'qwen' | 'ernie';

export interface OpenAICompatibleModelThinkingRule {
  /** 按模型 ID 认出的系列；只有测试结果、认不出模型时没有。 */
  family?: OpenAICompatibleModelFamily;
  /** 用 `thinking.type` 开关思考；Kimi K3 不接受 `thinking` 参数。 */
  toggle: boolean;
  /** 接受 `thinking.type: disabled`；GLM-5.3、Kimi K2.7 Code 传 disabled 会报错。 */
  canDisable: boolean;
  /** 模型接受的 `reasoning_effort`；空数组表示从不发送强度。 */
  efforts: readonly LlmThinkingLevel[];
  /** 官方文档写明带 tools 的请求要回传 `reasoning_content`（DeepSeek、MiMo 缺了返回 400；Kimi K3 要求回传完整 assistant 消息）。 */
  requiresReasoningReplay: boolean;
}

export interface OpenAICompatibleDialect {
  platform: OpenAICompatiblePlatform;
  /** 原样的模型 ID（小写）：百炼的 `kimi/` 等前缀决定参数取值。 */
  modelId: string;
  /** 统一后的模型名（见 normalizedOpenAICompatibleModelName）。 */
  modelName: string;
  rule?: OpenAICompatibleModelThinkingRule;
  format: OpenAICompatibleThinkingFormat;
  /**
   * manual：用户手动指定；probe：按“测试这个模型”的结果；platform：按接口地址；model：按模型 ID；
   * default：都认不出，保持 OpenAI 写法。
   */
  source: 'manual' | 'probe' | 'platform' | 'model' | 'default';
  /** tool 消息的 content 可以放图片/文件数组（DeepSeek、MiMo 官方接口）。 */
  toolContentArrays: boolean;
  /**
   * 带 tools 的请求里，给每条 assistant 消息补上 `reasoning_content`（缺失时为空串）。
   * 只在官方文档写明要求回传的平台和模型上补；空串是否被各家接受官方没有写明，待真实请求验证。
   */
  fillReasoningReplay: boolean;
}

/**
 * “测试这个模型”测出的规则（存在 `models[].capabilitySnapshot` 里，`source: 'verified_probe'`，
 * `reasoning.wireFormat` 为写法，见 shared/modelCapabilities.ts 的 resolveProviderOpenAICompatibleDialect）。
 */
export interface OpenAICompatibleProbedThinking {
  format: OpenAICompatibleThinkingFormat;
  canDisable: boolean;
  /** 该写法下对方接受的 `reasoning_effort`（不含 none）；空数组表示只开关思考、不发强度。 */
  efforts: readonly LlmThinkingLevel[];
}

const DEEPSEEK_STYLE_EFFORTS: readonly LlmThinkingLevel[] = ['low', 'high', 'max'];

const GLM_TOGGLE: OpenAICompatibleModelThinkingRule = { family: 'glm', toggle: true, canDisable: true, efforts: [], requiresReasoningReplay: false };
const QWEN_HYBRID: OpenAICompatibleModelThinkingRule = { family: 'qwen', toggle: true, canDisable: true, efforts: [], requiresReasoningReplay: false };
const QWEN_THINKING_ONLY: OpenAICompatibleModelThinkingRule = { ...QWEN_HYBRID, canDisable: false };

/** 按顺序匹配；`rule: null` 表示认得出、但不思考（不发思考参数、不给档位）的模型。 */
const MODEL_RULES: ReadonlyArray<{ pattern: RegExp; rule: OpenAICompatibleModelThinkingRule | null }> = [
  { pattern: /^deepseek/, rule: { family: 'deepseek', toggle: true, canDisable: true, efforts: DEEPSEEK_STYLE_EFFORTS, requiresReasoningReplay: true } },
  { pattern: /^mimo/, rule: { family: 'mimo', toggle: true, canDisable: true, efforts: [], requiresReasoningReplay: true } },
  // Kimi K3（platform.kimi.ai kimi-k3-quickstart）：始终思考，只收顶层 reasoning_effort，要求把完整 assistant 消息原样带回。
  { pattern: /^kimi-k3/, rule: { family: 'kimi', toggle: false, canDisable: false, efforts: DEEPSEEK_STYLE_EFFORTS, requiresReasoningReplay: true } },
  { pattern: /^kimi-k2-7-code/, rule: { family: 'kimi', toggle: true, canDisable: false, efforts: [], requiresReasoningReplay: false } },
  { pattern: /^kimi-/, rule: { family: 'kimi', toggle: true, canDisable: true, efforts: [], requiresReasoningReplay: false } },
  // 智谱（docs.bigmodel.cn 对话补全）：GLM-5.3 只接受 low / high / max 且关不掉；GLM-5.2 的 low、medium 映射为 high
  // （火山方舟同样）；thinking 参数只有 GLM-4.5 及以上支持。方舟的模型 ID 带日期（glm-5-2-260617、glm-5-260117），
  // 所以版本号后面必须是连字符或结尾，glm-5-2601xx 这种带日期的 GLM-5 不能认成 5.2。
  { pattern: /^glm-5-3(?:$|-)/, rule: { ...GLM_TOGGLE, canDisable: false, efforts: DEEPSEEK_STYLE_EFFORTS } },
  { pattern: /^glm-5-2(?:$|-)/, rule: { ...GLM_TOGGLE, efforts: ['high', 'max'] } },
  { pattern: /^glm-(?:4-[5-9](?:$|[-v])|[5-9](?:$|-))/, rule: GLM_TOGGLE },
  { pattern: /^glm-/, rule: null },
  { pattern: /^(?:hunyuan|hy\d)/, rule: { family: 'hunyuan', toggle: true, canDisable: true, efforts: ['low', 'high'], requiresReasoningReplay: false } },
  // Qwen：Qwen3 起是混合思考（qwen-plus / turbo / flash 已是 Qwen3）；instruct、coder 型号不思考，thinking 型号与 QwQ 只能思考；
  // qwen-max、Qwen2.5 等更早的型号不思考。
  { pattern: /^qwen3-(?:.+-)?(?:instruct|coder)(?:$|-)/, rule: null },
  { pattern: /^qwen3-(?:.+-)?thinking(?:$|-)/, rule: QWEN_THINKING_ONLY },
  { pattern: /^(?:qwen3|qwen-(?:plus|turbo|flash))(?:$|-)/, rule: QWEN_HYBRID },
  { pattern: /^qwq/, rule: QWEN_THINKING_ONLY },
  { pattern: /^qwen/, rule: null },
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

function modelRuleEntry(model: string): { rule: OpenAICompatibleModelThinkingRule | null } | undefined {
  const name = normalizedOpenAICompatibleModelName(model);
  return MODEL_RULES.find((entry) => entry.pattern.test(name));
}

export function openAICompatibleModelThinkingRule(model: string): OpenAICompatibleModelThinkingRule | undefined {
  return modelRuleEntry(model)?.rule ?? undefined;
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
  // Kimi Code：api.kimi.com/coding/v1（中国）、api.kimi.ai/coding/v1（海外）。
  if (within('kimi.com') || within('kimi.ai')) return 'kimi-code';
  if (within('bigmodel.cn') || within('z.ai')) return 'zhipu';
  // 腾讯 TokenHub：中国站 tokenhub(-intl).tencentmaas.com / .cn，国际站 tokenhub(-intl / -us).tencentcloudmaas.com / .tech；
  // 知识引擎的 DeepSeek 接口 api.lkeap.cloud.tencent.com 已并入 TokenHub。
  if (within('tencentmaas.com') || within('tencentmaas.cn') || within('tencentcloudmaas.com') || within('tencentcloudmaas.tech')
    || host === 'api.lkeap.cloud.tencent.com') return 'tencent';
  // 旧混元平台的 OpenAI 兼容接口没有 thinking / reasoning_effort 参数，不归入 TokenHub。
  if (host === 'api.hunyuan.cloud.tencent.com') return 'hunyuan';
  if (within('volces.com') || within('bytepluses.com')) return 'ark';
  // 百炼：dashscope(-intl / -us).aliyuncs.com、cn-hongkong.dashscope.aliyuncs.com、Coding Plan 的
  // coding(-intl).dashscope.aliyuncs.com，以及业务空间 / 试用的 *.maas.aliyuncs.com。
  if (within('aliyuncs.com') && (host.startsWith('dashscope') || within('dashscope.aliyuncs.com') || host.includes('.maas.'))) return 'dashscope';
  if (within('siliconflow.cn') || within('siliconflow.com')) return 'siliconflow';
  if (within('qianfan.baidubce.com') || host === 'qianfan.bj.baidubce.com') return 'qianfan';
  if (within('openrouter.ai')) return 'openrouter';
  if (isLocalHost(host)) return 'local';
  return 'unknown';
}

function isLocalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || host === '0.0.0.0'
    || host === 'host.docker.internal') return true;
  // IPv6 唯一本地地址 fd00::/8。
  if (host.includes(':')) return /^fd[0-9a-f]{0,2}:/.test(host);
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = octets as [number, number, number, number];
  // 私有网段，以及 Tailscale 等使用的 100.64.0.0/10。
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * 有效规则的来源依次为：手动写法 → 测试结果（`probed`）→ 按接口地址 / 模型 ID 自动识别。
 * 有测试结果且没有手动写法时，写法与规则（能否关闭、接受的强度）取自测试结果；
 * 回传行为（`fillReasoningReplay`、`toolContentArrays`）仍按平台和写法计算。
 */
export function resolveOpenAICompatibleDialect(
  baseUrl: string,
  model: string,
  manual?: OpenAICompatibleThinkingFormat,
  probed?: OpenAICompatibleProbedThinking
): OpenAICompatibleDialect {
  const platform = openAICompatiblePlatform(baseUrl);
  const entry = modelRuleEntry(model);
  const modelRule = entry?.rule ?? undefined;
  const useProbe = !manual && probed !== undefined;
  const rule = useProbe ? probedRule(probed, modelRule) : modelRule;
  const automatic = automaticFormat(platform, modelRule, entry?.rule === null);
  const format = manual ?? (useProbe ? probed.format : automatic.format);
  const source = manual ? 'manual' : useProbe ? 'probe' : automatic.source;
  return {
    platform,
    modelId: model.trim().toLowerCase(),
    modelName: normalizedOpenAICompatibleModelName(model),
    ...(rule ? { rule } : {}),
    format,
    source,
    toolContentArrays: format === 'deepseek' && (platform === 'deepseek' || platform === 'mimo'),
    fillReasoningReplay: format !== 'omit' && requiresReasoningReplay(platform, model, rule)
  };
}

/**
 * 官方文档写明要回传思考内容的平台和模型：模型规则（DeepSeek、MiMo、Kimi K3）；Kimi Code 缺了返回 400
 * （kimi.com/code/docs error-reference）；百炼的第三方 `kimi/` 模型必须在每轮 assistant 消息里保留 reasoning_content
 * （help.aliyun.com/zh/model-studio/kimi-api-by-moonshot-ai）；硅基流动的 GLM-4.7 要求原样回传
 * （docs.siliconflow.com interleaved-thinking）。OpenRouter 和本机服务按它们自己的写法，不补。
 */
function requiresReasoningReplay(
  platform: OpenAICompatiblePlatform,
  model: string,
  rule: OpenAICompatibleModelThinkingRule | undefined
): boolean {
  if (platform === 'openrouter' || platform === 'local') return false;
  if (rule?.requiresReasoningReplay || platform === 'kimi-code') return true;
  if (platform === 'dashscope') return model.trim().toLowerCase().startsWith('kimi/');
  if (platform === 'siliconflow') return /^glm-4-7(?:$|-)/.test(normalizedOpenAICompatibleModelName(model));
  return false;
}

function probedRule(
  probed: OpenAICompatibleProbedThinking,
  modelRule: OpenAICompatibleModelThinkingRule | undefined
): OpenAICompatibleModelThinkingRule {
  return {
    ...(modelRule?.family ? { family: modelRule.family } : {}),
    toggle: modelRule?.toggle ?? true,
    canDisable: probed.canDisable,
    efforts: sortedLevels(probed.efforts.filter((level) => level !== 'none')),
    requiresReasoningReplay: modelRule?.requiresReasoningReplay ?? false
  };
}

function automaticFormat(
  platform: OpenAICompatiblePlatform,
  rule: OpenAICompatibleModelThinkingRule | undefined,
  nonThinking: boolean
): { format: OpenAICompatibleThinkingFormat; source: OpenAICompatibleDialect['source'] } {
  // 认得出、但不思考的模型（GLM-4.5 以下、qwen-max 等）：不发思考参数。OpenRouter 和本机服务仍按它们自己的写法。
  if (nonThinking && platform !== 'openrouter' && platform !== 'local') return { format: 'omit', source: 'model' };
  switch (platform) {
    // 平台写法只用于登记了规则的模型：平台上认不出的模型（例如腾讯 TokenHub 的 minimax-m3 传
    // thinking.type enabled 会返回 400）按 OpenAI 写法，只在设置了强度时发 reasoning_effort。
    case 'deepseek':
    case 'mimo':
    case 'moonshot':
    case 'kimi-code':
    case 'zhipu':
    case 'tencent':
    case 'ark':
      return rule ? { format: 'deepseek', source: 'platform' } : { format: 'reasoning_effort', source: 'default' };
    case 'dashscope':
    case 'siliconflow':
      return rule ? { format: 'enable_thinking', source: 'platform' } : { format: 'reasoning_effort', source: 'default' };
    case 'hunyuan':
      return { format: 'omit', source: 'platform' };
    case 'qianfan':
      // 千帆按模型分：DeepSeek、Kimi、GLM 用 thinking.type（默认关闭），Qwen、ERNIE 用 enable_thinking。
      if (rule?.family === 'qwen' || rule?.family === 'ernie') return { format: 'enable_thinking', source: 'platform' };
      if (rule?.family && DEEPSEEK_STYLE_FAMILIES.has(rule.family)) return { format: 'deepseek', source: 'platform' };
      return { format: 'reasoning_effort', source: 'default' };
    case 'openrouter':
      // OpenRouter 的顶层 reasoning_effort 是 reasoning.effort 的简写，none 也可用；不能套 DeepSeek 写法。
      return { format: 'reasoning_effort', source: 'platform' };
    case 'local':
      // vLLM / SGLang / Ollama 的开关走 chat_template_kwargs，键名随模型模板变，第一期保持原样。
      return { format: 'reasoning_effort', source: 'platform' };
    case 'unknown':
      return rule?.family && DEEPSEEK_STYLE_FAMILIES.has(rule.family)
        ? { format: 'deepseek', source: 'model' }
        : { format: 'reasoning_effort', source: 'default' };
  }
}

/**
 * 本平台、本模型接受的 `reasoning_effort` 取值；空数组表示不发送强度（只开关思考）。
 * 方舟接受七档，按原值发送；硅基流动、千帆只对 DeepSeek V4（硅基流动还有 GLM-5.2）接受 high / max；
 * 百炼按模型区分（见 dashscopeEffortValues）。
 */
export function openAICompatibleEffortValues(dialect: OpenAICompatibleDialect): readonly LlmThinkingLevel[] | 'any' {
  // 测试结果就是在这个平台上实测到的取值。
  if (dialect.source === 'probe' && dialect.rule) return dialect.rule.efforts;
  if (dialect.platform === 'ark') return 'any';
  if (dialect.platform === 'siliconflow' || dialect.platform === 'qianfan') {
    const v4 = /^deepseek-v4/.test(dialect.modelName);
    const glm52 = dialect.platform === 'siliconflow' && /^glm-5-2/.test(dialect.modelName);
    return v4 || glm52 ? ['high', 'max'] : [];
  }
  if (dialect.platform === 'dashscope') return dashscopeEffortValues(dialect);
  if (dialect.rule) return dialect.rule.efforts;
  // 手动指定 DeepSeek 写法、模型认不出时按 DeepSeek 的取值。
  return dialect.format === 'deepseek' ? DEEPSEEK_STYLE_EFFORTS : 'any';
}

/**
 * 百炼的顶层 `reasoning_effort`（help.aliyun.com/zh/model-studio 的 deepseek-api、glm、kimi-api-by-moonshot-ai、
 * qwen-api-via-openai-chat-completions）：DeepSeek-V4 为 high / max（v4.1-flash、v4-flash-0731、v4-pro-0813 另有 low）；
 * GLM-5.3 为 low / high / max，GLM-5.2 的 low、medium 按 high 处理；百炼直供的 kimi-k3 为 low / high / max，
 * 第三方 `kimi/kimi-k3` 只支持 max；Qwen3.8 为 low / medium / xhigh（high、max 按 xhigh）。其余模型只开关思考。
 */
function dashscopeEffortValues(dialect: OpenAICompatibleDialect): readonly LlmThinkingLevel[] {
  const name = dialect.modelName;
  if (/^deepseek-v4-(?:1-flash|flash-0731|pro-0813)(?:$|-)/.test(name)) return DEEPSEEK_STYLE_EFFORTS;
  if (/^deepseek-v4/.test(name)) return ['high', 'max'];
  if (/^glm-5-3(?:$|-)/.test(name)) return DEEPSEEK_STYLE_EFFORTS;
  if (/^glm-5-2(?:$|-)/.test(name)) return ['high', 'max'];
  if (/^kimi-k3/.test(name)) return dialect.modelId.startsWith('kimi/') ? ['max'] : DEEPSEEK_STYLE_EFFORTS;
  if (/^qwen3-8(?:$|-)/.test(name)) return ['low', 'medium', 'xhigh'];
  return [];
}

const LEVEL_ORDER: readonly LlmThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

function sortedLevels(levels: readonly LlmThinkingLevel[]): LlmThinkingLevel[] {
  return [...new Set(levels)]
    .filter((level) => LEVEL_ORDER.includes(level))
    .sort((left, right) => LEVEL_ORDER.indexOf(left) - LEVEL_ORDER.indexOf(right));
}

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

/**
 * 有效规则给出的思考档位：会话思考强度下拉与能力表（摘要推理）共用。
 * 只在 DeepSeek 写法或 enable_thinking 写法、且有规则（模型规则或测试结果）时有值；
 * 平台差异已算进去（方舟按模型规则，硅基流动的 DeepSeek V4 为 high / max，百炼只有开关）；
 * 只有开关、不发强度的记作 `['high']`。OpenAI 写法、不发送、认不出模型时返回 undefined。
 */
export function openAICompatibleThinkingLevels(
  dialect: OpenAICompatibleDialect
): { levels: LlmThinkingLevel[]; canDisable: boolean } | undefined {
  if ((dialect.format !== 'deepseek' && dialect.format !== 'enable_thinking') || !dialect.rule) return undefined;
  const values = openAICompatibleEffortValues(dialect);
  const efforts = sortedLevels(values === 'any' ? dialect.rule.efforts : values);
  return { levels: efforts.length ? efforts : ['high'], canDisable: dialect.rule.canDisable };
}

const PLATFORM_LABELS: Record<OpenAICompatiblePlatform, string> = {
  deepseek: 'DeepSeek 官方',
  mimo: '小米 MiMo',
  moonshot: 'Kimi（月之暗面）',
  'kimi-code': 'Kimi Code',
  zhipu: '智谱',
  tencent: '腾讯 TokenHub',
  hunyuan: '腾讯混元（旧接口）',
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
    case 'probe': return `${format} · 按测试结果`;
    case 'platform': return `${format} · 按接口地址识别：${PLATFORM_LABELS[dialect.platform]}`;
    case 'model': return `${format} · 按模型 ID 识别`;
    case 'default': return dialect.platform === 'unknown'
      ? `${format} · 未识别出服务商或模型，按 OpenAI 写法`
      : `${format} · 按接口地址识别：${PLATFORM_LABELS[dialect.platform]}，这个模型没有登记思考参数规则，按 OpenAI 写法`;
  }
}

/** 新建 OpenAI 兼容渠道时可选的服务商：只填接口地址，思考参数写法由上面的自动识别决定。 */
export const OPENAI_COMPATIBLE_SERVICE_PRESETS: ReadonlyArray<{ key: string; platform: OpenAICompatiblePlatform; label: string; baseUrl: string }> = [
  { key: 'deepseek', platform: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { key: 'moonshot', platform: 'moonshot', label: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1' },
  { key: 'moonshot-intl', platform: 'moonshot', label: 'Kimi（国际站）', baseUrl: 'https://api.moonshot.ai/v1' },
  { key: 'zhipu', platform: 'zhipu', label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { key: 'zhipu-intl', platform: 'zhipu', label: '智谱 Z.ai（国际站）', baseUrl: 'https://api.z.ai/api/paas/v4' },
  { key: 'mimo', platform: 'mimo', label: '小米 MiMo', baseUrl: 'https://api.xiaomimimo.com/v1' },
  { key: 'tencent', platform: 'tencent', label: '腾讯 TokenHub', baseUrl: 'https://tokenhub.tencentmaas.com/v1' },
  { key: 'tencent-intl', platform: 'tencent', label: '腾讯 TokenHub（国际站）', baseUrl: 'https://tokenhub-intl.tencentcloudmaas.com/v1' },
  { key: 'ark', platform: 'ark', label: '火山方舟', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
  { key: 'ark-intl', platform: 'ark', label: '火山方舟 BytePlus（国际站）', baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3' },
  { key: 'dashscope', platform: 'dashscope', label: '阿里百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { key: 'dashscope-intl', platform: 'dashscope', label: '阿里百炼（国际站）', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' },
  { key: 'siliconflow', platform: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1' },
  { key: 'siliconflow-intl', platform: 'siliconflow', label: '硅基流动（国际站）', baseUrl: 'https://api.siliconflow.com/v1' },
  { key: 'qianfan', platform: 'qianfan', label: '百度千帆', baseUrl: 'https://qianfan.baidubce.com/v2' },
  { key: 'openrouter', platform: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' }
];
