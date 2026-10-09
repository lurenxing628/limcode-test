import type { LlmProviderKind } from '../../shared/protocol';
import { isRecord } from './llmStreamEventProjection';
import type { OpenAIResponsesToolCallArgumentDelta } from './openAIResponsesWebSocketSession';

const installedFormats = new WeakSet<object>();

/**
 * Responses' completed output is the authoritative full response, even when a compatible
 * endpoint omitted text deltas. Reuse the format's canonical non-streaming decoder rather
 * than reconstructing text or tools from raw protocol fields in each consumer.
 * https://platform.openai.com/docs/api-reference/responses-streaming/response/completed
 *
 * Full HTTP requests also pass through received tool-argument deltas for preview/timing. The
 * SDK still owns argument assembly and completed calls; this never creates executable partial
 * calls, native events or item-close facts. Summary-only WS decoding stays text-only.
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
    if (!isRecord(raw) || !isRecord(chunk)) return chunk;
    const event = raw.event ?? raw.type;
    if (!options.visibleTextOnly && event === 'response.function_call_arguments.delta'
      && typeof raw.delta === 'string' && raw.delta.length > 0) {
      // Reuse the SDK's item_id → call_id association, not a second tool-call accumulator.
      const pendingCalls = isRecord(state) ? state.pendingFunctionCalls : undefined;
      const itemId = raw.item_id ?? raw.id ?? raw.call_id;
      const pending = pendingCalls instanceof Map ? pendingCalls.get(itemId) : undefined;
      const callId = isRecord(pending) ? pending.callId ?? itemId : undefined;
      if (typeof callId === 'string' && callId) {
        const delta: OpenAIResponsesToolCallArgumentDelta = {
          callId,
          ...(typeof pending.name === 'string' ? { name: pending.name } : {}),
          argumentsDelta: raw.delta
        };
        chunk.toolCallArgumentDeltas = [delta];
      }
    }
    if (event !== 'response.completed' || chunk.error !== undefined || chunk.nativeEvent !== undefined
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
