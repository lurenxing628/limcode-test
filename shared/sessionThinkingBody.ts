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
  const keys = provider === 'openai-responses' ? ['reasoning', 'max_output_tokens']
    : ['reasoning_effort', 'thinking', 'max_tokens', 'max_completion_tokens'];
  return keys.some(owns);
}
