import type { LlmProviderKind } from '../../shared/protocol';
import { isRecord } from './llmStreamEventProjection';

const installedFormats = new WeakSet<object>();

/**
 * Responses' completed output is the authoritative full response, even when a compatible
 * endpoint omitted text deltas. Reuse the format's canonical non-streaming decoder rather
 * than reconstructing text or tools from raw protocol fields in each consumer.
 * https://platform.openai.com/docs/api-reference/responses-streaming/response/completed
 *
 * This adds a final aggregate only. It never fabricates deltas, native events or item-close
 * facts; the native decoder keeps sole ownership of those identities and admission rules.
 */
export function installOpenAIResponsesCompletedContent<T>(
  provider: T,
  providerKind: LlmProviderKind,
  options: { visibleTextOnly?: boolean } = {}
): T {
  if (providerKind !== 'openai-responses') return provider;
  const format = (provider as T & { format?: {
    decodeResponse?: (raw: unknown) => unknown;
    decodeStreamChunk?: (raw: unknown, state: unknown) => unknown;
  } }).format;
  if (!format || installedFormats.has(format)
    || typeof format.decodeResponse !== 'function' || typeof format.decodeStreamChunk !== 'function') return provider;
  const decodeResponse = format.decodeResponse.bind(format);
  const decodeStreamChunk = format.decodeStreamChunk.bind(format);
  const completedStates = new WeakSet<object>();
  format.decodeStreamChunk = (raw, state) => {
    const chunk = decodeStreamChunk(raw, state);
    if (!isRecord(raw) || (raw.event ?? raw.type) !== 'response.completed'
      || !isRecord(chunk) || chunk.error !== undefined || chunk.nativeEvent !== undefined
      || chunk.completedOutputItems !== undefined || Array.isArray(chunk.completedContents)) return chunk;
    const response = isRecord(raw.response) ? raw.response : raw;
    // Some compatible endpoints finish a correctly streamed response with output: []. That
    // carries no replacement content and must not erase the deltas already received.
    if ((response.status !== undefined && response.status !== 'completed')
      || !Array.isArray(response.output) || response.output.length === 0) return chunk;
    // Each ordinary HTTP stream has one completed response. Repeated terminal frames must
    // not append its entire content a second time to the consumer's completed-content list.
    if (isRecord(state) && completedStates.has(state)) return chunk;
    const decoded = decodeResponse(response);
    if (!isRecord(decoded) || !isRecord(decoded.content) || !Array.isArray(decoded.content.parts)) {
      throw new Error('OpenAI Responses completed output did not decode to canonical content.');
    }
    if (isRecord(state)) completedStates.add(state);
    // Summary-only WS requests need final visible text independently of the session's
    // stricter continuation proof. Never turn terminal-only reasoning/signatures or opaque
    // provider items into continuation authority, or copy them into this summary aggregate.
    const content = options.visibleTextOnly ? { role: 'model', parts: decoded.content.parts
      .filter((part): part is Record<string, unknown> => isRecord(part)
        && typeof part.text === 'string' && part.thought !== true)
      .map(part => ({ text: part.text })) } : decoded.content;
    return { ...chunk, completedContents: [content] };
  };
  installedFormats.add(format);
  return provider;
}
