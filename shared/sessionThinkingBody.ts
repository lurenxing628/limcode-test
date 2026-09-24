import type { LlmProviderKind, LlmRequestBodyRecord } from './protocol';

/** Mirror deep-merge semantics: unrelated object children are safe; replacing a parent is not. */
export function hasThinkingBodyConflict(provider: LlmProviderKind, body?: LlmRequestBodyRecord): boolean {
  if (!body) return false;
  const owns = (key: string): boolean => Object.prototype.hasOwnProperty.call(body, key);
  const nestedConflict = (key: string, children: readonly string[]): boolean => {
    if (!owns(key)) return false;
    const value = body[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
    return children.some(child => Object.prototype.hasOwnProperty.call(value, child));
  };
  if (provider === 'gemini') return owns('thinkingConfig') || nestedConflict('generationConfig', ['thinkingConfig', 'maxOutputTokens']);
  if (provider === 'claude') return owns('thinking') || owns('max_tokens') || nestedConflict('output_config', ['effort']);
  if (provider === 'openai-responses') return ['reasoning', 'max_output_tokens'].some(owns);
  return openAICompatibleBodyControlsThinking(body) || ['max_tokens', 'max_completion_tokens'].some(owns);
}

/** vLLM / SGLang 等的模板参数里控制思考的子键；其余模板参数与思考无关。 */
const CHAT_TEMPLATE_THINKING_KEYS = ['enable_thinking', 'thinking', 'reasoning_effort', 'thinking_budget'] as const;

/**
 * OpenAI 兼容渠道的自定义请求体自己决定了思考参数（任一写法）：会话思考覆盖与之冲突，
 * 请求改写也不再改动这些参数。`chat_template_kwargs` 只在含思考相关子键时才算。
 */
export function openAICompatibleBodyControlsThinking(body?: LlmRequestBodyRecord): boolean {
  if (!body) return false;
  const owns = (key: string): boolean => Object.prototype.hasOwnProperty.call(body, key);
  if (['reasoning_effort', 'thinking', 'enable_thinking', 'thinking_budget'].some(owns)) return true;
  if (!owns('chat_template_kwargs')) return false;
  const kwargs = body.chat_template_kwargs;
  if (!kwargs || typeof kwargs !== 'object' || Array.isArray(kwargs)) return true;
  return CHAT_TEMPLATE_THINKING_KEYS.some((key) => Object.prototype.hasOwnProperty.call(kwargs, key));
}
