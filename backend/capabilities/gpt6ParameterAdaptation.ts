/**
 * GPT-6 Sol / Luna 的参数适配（Astra 另有设置层适配，见 llmProvider 的 adaptAstra*，行为不变）。
 *
 * 依据 https://developers.openai.com/api/docs/guides/latest-model（Using GPT-6 “Update API and model parameters”）：
 * - “GPT-6 Sol and Luna support `none`. If your existing request uses `minimal`, start with `low`.”
 * - “When reasoning effort is not `none`, remove `temperature`, `top_p`, and `top_logprobs`. For Chat Completions,
 *   also remove `logprobs`. For Responses, remove `message.output_text.logprobs` from `include`.”
 * 模型页（models/gpt-6-sol.md、models/gpt-6-luna.md）：effort 默认 `medium`，所以没有设置强度时同样要去掉。
 *
 * `minimal → low` 在设置解析与冻结快照层完成（与 Astra 相同位置）；采样参数按线上请求体里实际生效的强度
 * 决定：请求级 effort（缺省按 medium）以及 Responses input 里 configuration_update 选择的 effort，只要有一个
 * 不是 none 就去掉。这样 requestBody 覆盖、会话思考覆盖、冻结配方与原生动态推理都按最终请求判断。
 */
import type { LlmGenerationConfigRecord, LlmProviderKind } from '../../shared/protocol';
import { isGpt6NoneCapableModel } from '../../shared/openAIResponsesCapabilities';
import { isRecord } from './llmStreamEventProjection';
import type { EncodedProviderRequest } from './providerParameterAdaptation';

/** Sol 与 Luna 在未设置 reasoning.effort 时的官方默认值。 */
const GPT6_NONE_CAPABLE_DEFAULT_EFFORT = 'medium';
const RESPONSES_SAMPLING_KEYS = ['temperature', 'top_p', 'top_logprobs'] as const;
const CHAT_COMPLETIONS_SAMPLING_KEYS = ['temperature', 'top_p', 'top_logprobs', 'logprobs'] as const;
const RESPONSES_LOGPROBS_INCLUDE = 'message.output_text.logprobs';

/** 只作用于精确 Sol / Luna 模型的 Responses 与 Chat Completions 形状请求。 */
export function isGpt6NoneCapableParameterTarget(settings: { provider: LlmProviderKind; model: string }): boolean {
  return (settings.provider === 'openai-responses' || settings.provider === 'openai-compatible')
    && isGpt6NoneCapableModel(settings.model);
}

/** Sol / Luna 保留 none，只把 minimal 提升为 low；没有改动时返回同一引用。 */
export function adaptGpt6NoneCapableGenerationConfig(
  generationConfig: LlmGenerationConfigRecord | undefined
): LlmGenerationConfigRecord | undefined {
  const thinkingConfig = generationConfig?.thinkingConfig;
  if (!generationConfig || !thinkingConfig || thinkingConfig.thinkingLevel !== 'minimal') return generationConfig;
  return { ...generationConfig, thinkingConfig: { ...thinkingConfig, thinkingLevel: 'low' } };
}

/**
 * 编码后请求的最终适配：请求里实际生效的推理强度只要有一个不是 none，就去掉官方要求去掉的采样参数。
 * 全部是 none 时原样返回同一引用（采样参数照常发送）。
 *
 * `alwaysReasoning`：Astra 不支持 none，推理始终开启，所以不看强度、一律去掉。Astra 普通请求的采样参数
 * 已在设置层去掉；这里兜住摘要等按压缩方法自带 generationConfig 编码的请求。
 */
export function adaptGpt6SamplingForReasoningEffort(
  request: EncodedProviderRequest,
  provider: LlmProviderKind,
  options: { alwaysReasoning?: boolean } = {}
): EncodedProviderRequest {
  const body = request.body;
  if (!isRecord(body)) return request;
  if (provider !== 'openai-responses' && provider !== 'openai-compatible') return request;
  if (!options.alwaysReasoning && reasoningEffortsInPlay(body, provider).every((effort) => effort === 'none')) return request;
  const keys = provider === 'openai-compatible' ? CHAT_COMPLETIONS_SAMPLING_KEYS : RESPONSES_SAMPLING_KEYS;
  const presentKeys = keys.filter((key) => Object.prototype.hasOwnProperty.call(body, key));
  // include 只属于 Responses；Chat Completions 没有该字段，原样保留用户配置。
  const include = provider === 'openai-responses' && Array.isArray(body.include) ? body.include : undefined;
  const adaptedInclude = include?.filter((value) => value !== RESPONSES_LOGPROBS_INCLUDE);
  const includeChanged = include !== undefined && adaptedInclude !== undefined && adaptedInclude.length !== include.length;
  if (presentKeys.length === 0 && !includeChanged) return request;
  const next: Record<string, unknown> = { ...body };
  for (const key of presentKeys) delete next[key];
  if (includeChanged) {
    if (adaptedInclude.length > 0) next.include = adaptedInclude;
    else delete next.include;
  }
  return { ...request, body: next };
}

function reasoningEffortsInPlay(body: Record<string, unknown>, provider: LlmProviderKind): string[] {
  if (provider === 'openai-compatible') return [normalizedEffort(body.reasoning_effort)];
  const efforts = [normalizedEffort(isRecord(body.reasoning) ? body.reasoning.effort : undefined)];
  // 原生动态推理：configuration_update 选择的 effort 对后续响应生效，同样要按它判断。
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (!isRecord(item) || item.type !== 'configuration_update' || !isRecord(item.reasoning)) continue;
    if (typeof item.reasoning.effort === 'string') efforts.push(normalizedEffort(item.reasoning.effort));
  }
  return efforts;
}

function normalizedEffort(value: unknown): string {
  const effort = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return effort || GPT6_NONE_CAPABLE_DEFAULT_EFFORT;
}
