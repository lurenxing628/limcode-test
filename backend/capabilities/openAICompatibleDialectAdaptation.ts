/**
 * 按方言改写 OpenAI 兼容请求（shared/openAICompatibleDialect.ts 负责识别）。
 *
 * 接入库对 OpenAI 兼容渠道只发 `reasoning_effort`；这里在“编码 + requestBody 合并”之后换成对方的写法：
 * - DeepSeek 写法：`thinking.type` + 收敛到对方接受值的 `reasoning_effort`；不能关闭思考的模型不发 disabled。
 * - enable_thinking 写法：`enable_thinking` 开关，只在对方接受时带 `reasoning_effort`。
 * - 不发送：去掉所有思考参数。
 * 带 tools 的请求里给每条 assistant 消息补上 `reasoning_content`（缺失时为空串）：只在官方文档写明要求回传的
 * 平台和模型上补（见 shared/openAICompatibleDialect.ts 的 fillReasoningReplay）；空串是否被接受官方没有写明。
 * DeepSeek 写法和 enable_thinking 写法下，历史里 OpenRouter 的 `reasoning` 文本挪到 `reasoning_content`。
 * 用户在自定义请求体里自己写了思考参数时不改写，只补回传。
 */
import type { LlmProviderConfigRecord, LlmThinkingLevel } from '../../shared/protocol';
import {
  mapOpenAICompatibleEffort,
  openAICompatibleEffortValues,
  type OpenAICompatibleDialect
} from '../../shared/openAICompatibleDialect';
import { resolveProviderOpenAICompatibleDialect } from '../../shared/modelCapabilities';
import { openAICompatibleBodyControlsThinking } from '../../shared/sessionThinkingBody';
import type { EncodedProviderRequest } from './providerParameterAdaptation';

/** 运行时的 settings 来自 applyFrozenModelProviderConfig，带着 models（测试结果）与 modelConfigs。 */
type DialectSettings = Pick<LlmProviderConfigRecord, 'provider' | 'baseUrl' | 'model' | 'openaiCompatibleThinkingFormat'>
  & Partial<Pick<LlmProviderConfigRecord, 'id' | 'models' | 'modelConfigs'>>;

const THINKING_LEVELS: ReadonlySet<string> = new Set<LlmThinkingLevel>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function openAICompatibleDialectForSettings(settings: DialectSettings): OpenAICompatibleDialect {
  return resolveProviderOpenAICompatibleDialect(settings, settings.model);
}

/**
 * 交给接入库的渠道类型。接入库的 DeepSeek 格式会把工具结果里的图片/文件留在 tool 消息里，
 * 只有 DeepSeek、MiMo 官方接口接受；其余 OpenAI 兼容服务一律用通用格式。
 */
export function libraryProviderKind(settings: DialectSettings): string {
  if (settings.provider !== 'openai-compatible') return settings.provider;
  return openAICompatibleDialectForSettings(settings).toolContentArrays ? 'deepseek' : settings.provider;
}

export function adaptOpenAICompatibleDialect(
  request: EncodedProviderRequest,
  settings: DialectSettings & Pick<LlmProviderConfigRecord, 'requestBody'>
): EncodedProviderRequest {
  if (settings.provider !== 'openai-compatible' || !isRecord(request.body)) return request;
  const dialect = openAICompatibleDialectForSettings(settings);
  let body = request.body;
  // 用户在自定义请求体里自己写了思考参数（与会话思考覆盖的冲突检查同一口径）：不改写、也不删除。
  if (!openAICompatibleBodyControlsThinking(settings.requestBody)) body = withDialectThinking(body, dialect);
  if (dialect.format === 'deepseek' || dialect.format === 'enable_thinking') body = withReasoningContentField(body);
  if (dialect.fillReasoningReplay) body = withReasoningReplay(body);
  return body === request.body ? request : { ...request, body };
}

/**
 * 从 OpenRouter 切过来时，历史 assistant 消息的思考在 `reasoning`（加 `reasoning_details`）里；
 * DeepSeek 等只认 `reasoning_content`（DeepSeek 带 tools 时缺了返回 400），把文本挪过去，去掉 OpenRouter 专有字段。
 */
function withReasoningContentField(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  let changed = false;
  const messages = body.messages.map((message) => {
    if (!isRecord(message) || message.role !== 'assistant' || !('reasoning' in message || 'reasoning_details' in message)) return message;
    changed = true;
    const { reasoning, reasoning_details: _details, ...rest } = message;
    return typeof rest.reasoning_content !== 'string' && typeof reasoning === 'string' && reasoning
      ? { ...rest, reasoning_content: reasoning }
      : rest;
  });
  return changed ? { ...body, messages } : body;
}

/** 渠道或会话选的档位：接入库把它编码成 `reasoning_effort`（官方 DeepSeek 走接入库的 DeepSeek 格式时是 thinking.type）。 */
function requestedLevel(body: Record<string, unknown>): LlmThinkingLevel | undefined {
  if (typeof body.reasoning_effort === 'string' && THINKING_LEVELS.has(body.reasoning_effort)) {
    return body.reasoning_effort as LlmThinkingLevel;
  }
  const thinking = isRecord(body.thinking) ? body.thinking : undefined;
  return thinking?.type === 'disabled' ? 'none' : undefined;
}

function withDialectThinking(body: Record<string, unknown>, dialect: OpenAICompatibleDialect): Record<string, unknown> {
  if (dialect.format === 'reasoning_effort') return body;
  if (dialect.format === 'omit') {
    if (!('reasoning_effort' in body) && !('thinking' in body) && !('enable_thinking' in body)) return body;
    const { reasoning_effort: _effort, thinking: _thinking, enable_thinking: _enable, ...rest } = body;
    return rest;
  }
  const level = requestedLevel(body);
  // 没有设置思考档位：不发任何思考参数，由服务端决定。
  if (!level) return body;
  const { reasoning_effort: _effort, thinking: _thinking, enable_thinking: _enable, ...next } = body;
  const rule = dialect.rule;
  if (dialect.format === 'deepseek') {
    if (level === 'none') {
      // Kimi K3 没有 thinking 参数，GLM-5.3、Kimi K2.7 Code 传 disabled 会报错：这些模型关不掉思考，什么都不发。
      return rule?.toggle === false || rule?.canDisable === false ? next : { ...next, thinking: { type: 'disabled' } };
    }
    const effort = mapOpenAICompatibleEffort(level, openAICompatibleEffortValues(dialect));
    return {
      ...next,
      ...(rule?.toggle === false ? {} : { thinking: { type: 'enabled' } }),
      ...(effort ? { reasoning_effort: effort } : {})
    };
  }
  // 与 DeepSeek 写法一致：关不掉思考的模型（百炼的 GLM-5.3、Kimi K3 只接受 true）不发 false，
  // 不接受开关参数的模型不带 enable_thinking。
  if (level === 'none') return rule?.toggle === false || rule?.canDisable === false ? next : { ...next, enable_thinking: false };
  const effort = mapOpenAICompatibleEffort(level, openAICompatibleEffortValues(dialect));
  return {
    ...next,
    ...(rule?.toggle === false ? {} : { enable_thinking: true }),
    ...(effort ? { reasoning_effort: effort } : {})
  };
}

function withReasoningReplay(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.tools) || body.tools.length === 0 || !Array.isArray(body.messages)) return body;
  let changed = false;
  const messages = body.messages.map((message) => {
    if (!isRecord(message) || message.role !== 'assistant') return message;
    if (typeof message.reasoning_content === 'string') return message;
    changed = true;
    return { ...message, reasoning_content: '' };
  });
  return changed ? { ...body, messages } : body;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
