/**
 * Claude 思考块回放适配。
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
import type { EncodedProviderRequest } from './providerParameterAdaptation';
import { isRecord } from './llmStreamEventProjection';

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
