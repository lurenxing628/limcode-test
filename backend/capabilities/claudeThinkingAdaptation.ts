/**
 * Claude 思考配置与思考块回放适配。
 *
 * 思考类型按模型族（https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting）：
 * - Opus 4.5、Sonnet 4.5、Haiku 4.5 等只支持 extended，`adaptive` 返回 400
 *   “adaptive thinking is not supported on this model”；
 * - Claude 4.7 及之后只支持 adaptive，`enabled` 返回 400
 *   “"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" and "output_config.effort"”；
 * - Fable、Mythos、Opus 5.5 始终开启，`disabled` 返回 400，文档要求 “Omit the `thinking` parameter”。
 * 接入库编码时把任意思考档位都写成 adaptive；这里按 shared/modelCapabilities.ts 的族信息改写，
 * 与摘要路径 reasoningNativeFields 一致：extended 模型绝不编造 adaptive，也不凭空编造预算。
 *
 * 保留思考（https://platform.claude.com/docs/en/build-with-claude/preserved-thinking）：
 * Claude Fable 5.1 / Opus 5.5 只在 system、tools 与此前消息都未改变时接受回放的 thinking 块，否则返回 400：
 *   messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.
 *   Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".
 * 文档给出的处理：不要原样重发；带 `anthropic-beta: thinking-binding-controls-2026-08-01` 与
 * `thinking.block_binding.prefix_mismatch_behavior: "drop_block"` 重试一次，并在之后的每个请求都带上；
 * 如果无法发送 beta 头（没带头时发 block_binding 会得到 `block_binding: Extra inputs are not permitted`），
 * 就把历史里所有 thinking 与 redacted_thinking 块去掉并一直保持去掉——“Once you remove a block, leave it out”。
 */
import type { ModelReasoningCapability } from '../../shared/modelCapabilities';
import type { EncodedProviderRequest } from './providerParameterAdaptation';
import { isRecord } from './llmStreamEventProjection';

export interface ClaudeThinkingFamilyProfile {
  family: 'anthropic_adaptive' | 'anthropic_hybrid' | 'anthropic_extended';
  /** 始终开启：拒绝 `thinking.type: "disabled"`。 */
  alwaysOn: boolean;
  /** 该模型确认支持的 output_config.effort 档位（extended 模型里只有 Opus 4.5 支持 effort）。 */
  effortLevels: readonly string[];
}

export function claudeThinkingFamilyProfile(
  capability: ModelReasoningCapability | undefined
): ClaudeThinkingFamilyProfile | undefined {
  if (!capability) return undefined;
  const family = capability.family;
  if (family !== 'anthropic_adaptive' && family !== 'anthropic_hybrid' && family !== 'anthropic_extended') return undefined;
  return { family, alwaysOn: capability.alwaysOn, effortLevels: [...capability.levels] };
}

/** 把编码后的 `thinking` 改写成该模型族接受的形状；族未知或已兼容时原样返回同一引用。 */
export function adaptClaudeThinkingForFamily(
  request: EncodedProviderRequest,
  profile: ClaudeThinkingFamilyProfile
): EncodedProviderRequest {
  const body = request.body;
  if (!isRecord(body) || !isRecord(body.thinking)) return request;
  const thinking = body.thinking;
  if (thinking.type === 'disabled' && profile.alwaysOn) {
    const { thinking: _disabled, ...rest } = body;
    return { ...request, body: rest };
  }
  if (thinking.type === 'enabled' && profile.family === 'anthropic_adaptive') {
    const { budget_tokens: _budget, ...rest } = thinking;
    return { ...request, body: { ...body, thinking: { ...rest, type: 'adaptive' } } };
  }
  if (thinking.type === 'adaptive' && profile.family === 'anthropic_extended') {
    const budget = sourceThinkingBudget(request.canonicalRequest);
    const { thinking: _adaptive, ...rest } = body;
    const next: Record<string, unknown> = budget === undefined
      ? rest
      : { ...rest, thinking: { ...thinking, type: 'enabled', budget_tokens: budget } };
    // 编码器随 adaptive 一起写的 effort 只保留该模型确认支持的档位（Sonnet 4.5 / Haiku 4.5 不支持 effort）。
    if (isRecord(next.output_config) && typeof next.output_config.effort === 'string'
      && !profile.effortLevels.includes(next.output_config.effort)) {
      const { effort: _effort, ...outputConfig } = next.output_config;
      if (Object.keys(outputConfig).length > 0) next.output_config = outputConfig;
      else delete next.output_config;
    }
    return { ...request, body: next };
  }
  return request;
}

/** 用户自己给出的思考预算（统一请求 generationConfig.thinkingConfig.thinkingBudget）。 */
function sourceThinkingBudget(canonicalRequest: unknown): number | undefined {
  if (!isRecord(canonicalRequest) || !isRecord(canonicalRequest.generationConfig)) return undefined;
  const thinkingConfig = canonicalRequest.generationConfig.thinkingConfig;
  const budget = isRecord(thinkingConfig) ? thinkingConfig.thinkingBudget : undefined;
  return typeof budget === 'number' && Number.isSafeInteger(budget) && budget > 0 ? budget : undefined;
}

export const CLAUDE_THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01';

/** drop_block：带 beta 头让 API 丢弃失配块；strip_thinking：网关不转发 beta 头，永久去掉历史思考块。 */
export type ClaudeThinkingBindingMode = 'drop_block' | 'strip_thinking';

/**
 * 只认文档原文：前缀失配的 400 必含 “bound to a different conversation”；签名本身被篡改的 400 不含这句话，
 * prefix_mismatch_behavior 对它无效，不能匹配。回退只在我们已经发过 block_binding 之后才发生。
 */
export function claudeThinkingBindingModeForError(
  errorText: string,
  current: ClaudeThinkingBindingMode | undefined
): ClaudeThinkingBindingMode | undefined {
  if (/the block is bound to a different conversation/i.test(errorText)) {
    return current === 'strip_thinking' ? 'strip_thinking' : 'drop_block';
  }
  if (current !== undefined
    && /(?<![\w])block_binding['"`]?\s*:?\s*extra inputs are not permitted/i.test(errorText)) {
    return 'strip_thinking';
  }
  return undefined;
}

export function applyClaudeThinkingBinding(
  request: EncodedProviderRequest,
  mode: ClaudeThinkingBindingMode
): EncodedProviderRequest {
  if (!isRecord(request.body)) return request;
  if (mode === 'drop_block') {
    const thinking = request.body.thinking;
    // block_binding 只能与 adaptive / enabled 同时出现；不带 thinking 时这些模型默认就是 adaptive。
    if (isRecord(thinking) && thinking.type !== 'adaptive' && thinking.type !== 'enabled') return request;
    const current = isRecord(thinking) ? thinking : { type: 'adaptive' };
    const binding = isRecord(current.block_binding) ? current.block_binding : {};
    return {
      ...request,
      body: {
        ...request.body,
        thinking: { ...current, block_binding: { ...binding, prefix_mismatch_behavior: 'drop_block' } }
      },
      headers: withAnthropicBeta(request.headers, CLAUDE_THINKING_BINDING_BETA)
    };
  }
  const body = withoutHistoryThinkingBlocks(withoutBlockBinding(request.body));
  return body === request.body ? request : { ...request, body };
}

function withoutBlockBinding(body: Record<string, unknown>): Record<string, unknown> {
  const thinking = body.thinking;
  if (!isRecord(thinking) || !Object.prototype.hasOwnProperty.call(thinking, 'block_binding')) return body;
  const { block_binding: _binding, ...rest } = thinking;
  return { ...body, thinking: rest };
}

/** 去掉所有 thinking / redacted_thinking 块；因此变空的 assistant 消息整条去掉（相邻同角色消息由 API 合并）。 */
function withoutHistoryThinkingBlocks(body: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(body.messages)) return body;
  let changed = false;
  const messages: unknown[] = [];
  for (const message of body.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) {
      messages.push(message);
      continue;
    }
    const content = message.content.filter((block) =>
      !(isRecord(block) && (block.type === 'thinking' || block.type === 'redacted_thinking')));
    if (content.length === message.content.length) {
      messages.push(message);
      continue;
    }
    changed = true;
    if (content.length === 0 && message.role === 'assistant') continue;
    messages.push({ ...message, content });
  }
  return changed ? { ...body, messages } : body;
}

function withAnthropicBeta(headers: Record<string, string>, beta: string): Record<string, string> {
  const existingKey = Object.keys(headers).find((key) => key.toLowerCase() === 'anthropic-beta');
  const values = (existingKey ? headers[existingKey] : '').split(',').map((value) => value.trim()).filter(Boolean);
  if (values.includes(beta)) return headers;
  const next = { ...headers };
  if (existingKey) delete next[existingKey];
  next['anthropic-beta'] = [...values, beta].join(',');
  return next;
}
