import { ref } from 'vue';
import { defineStore } from 'pinia';
import { bridge } from '@webview/transport';

export type ReliableTimelineFactKind = 'turn-termination' | 'compression-block' | 'compression-warning';

interface ReliableTimelinePresentationState {
  suppressedFactKeys: string[];
}

const PERSISTED_STATE_KEY = 'reliableTimelinePresentation';
const MAX_SUPPRESSED_FACT_KEYS = 1024;

/**
 * UI-only acknowledgement state. Reliable Runtime facts remain immutable and continue to exist in
 * history; dismissing a notice merely suppresses that exact standalone notice in this Webview.
 * Semantic states such as a model message being partial/terminated are projected independently.
 */
export const useReliableTimelinePresentationStore = defineStore('reliableTimelinePresentation', () => {
  const suppressedFactKeys = ref(readSuppressedFactKeys());

  function isSuppressed(conversationId: string, factKind: ReliableTimelineFactKind, factId: string): boolean {
    const key = factKey(conversationId, factKind, factId);
    return key !== undefined && suppressedFactKeys.value.includes(key);
  }

  function suppress(conversationId: string, factKind: ReliableTimelineFactKind, factId: string): void {
    const key = factKey(conversationId, factKind, factId);
    if (!key || suppressedFactKeys.value.includes(key)) return;
    suppressedFactKeys.value = [...suppressedFactKeys.value, key].slice(-MAX_SUPPRESSED_FACT_KEYS);
    persist();
  }

  function persist(): void {
    bridge.writePersistedState<ReliableTimelinePresentationState>(PERSISTED_STATE_KEY, {
      suppressedFactKeys: [...suppressedFactKeys.value]
    });
  }

  return { suppressedFactKeys, isSuppressed, suppress };
});

function readSuppressedFactKeys(): string[] {
  const persisted = bridge.readPersistedState<unknown>(PERSISTED_STATE_KEY);
  if (!isRecord(persisted) || !Array.isArray(persisted.suppressedFactKeys)) return [];
  return [...new Set(persisted.suppressedFactKeys
    .filter((value): value is string => typeof value === 'string' && value.length > 0))]
    .slice(-MAX_SUPPRESSED_FACT_KEYS);
}

function factKey(
  conversationId: string,
  factKind: ReliableTimelineFactKind,
  factId: string
): string | undefined {
  const normalizedConversationId = conversationId.trim();
  const normalizedFactId = factId.trim();
  return normalizedConversationId && normalizedFactId
    ? JSON.stringify([normalizedConversationId, factKind, normalizedFactId])
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
