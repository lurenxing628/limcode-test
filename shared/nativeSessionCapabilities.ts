import type { OpenAIResponsesNativeCapabilities } from './openAIResponsesNative';

/**
 * The same frozen decision must govern both NativeRequestSession and measurement semantics.
 * Transport lifecycle events, explicit caching and multiplexing alone are not a native session.
 * Receives a recipe's already frozen nativeResponses, never current editable channel settings.
 */
export function nativeSessionCapabilities(value: unknown): OpenAIResponsesNativeCapabilities | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const capabilities: OpenAIResponsesNativeCapabilities = {
    asyncTools: record.asyncTools === true,
    steering: record.steering === true,
    reasoningUpdates: record.reasoningUpdates === true,
    multiplexing: record.multiplexing === true,
    explicitCaching: record.explicitCaching === true
  };
  return capabilities.asyncTools || capabilities.steering || capabilities.reasoningUpdates
    ? capabilities : undefined;
}
