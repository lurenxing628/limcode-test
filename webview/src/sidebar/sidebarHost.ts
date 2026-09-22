import { createHostApi } from '@webview/platform/createHostApi';
import type { ExtensionToSidebarMessage, SidebarToExtensionMessage } from './types';

const host = createHostApi();

export interface SidebarHostState {
  expandedConversationIds: string[];
  favoriteConversationIds: string[];
  userCollapsedConversationIds: string[];
}

export function postSidebarMessage(message: SidebarToExtensionMessage): void {
  host.postMessage(message);
}

export function onSidebarMessage(handler: (message: ExtensionToSidebarMessage) => void): () => void {
  return host.onMessage((raw) => handler(raw as ExtensionToSidebarMessage));
}

function readIdList(state: Record<string, unknown>, key: string): string[] {
  const value = state[key];
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0))]
    : [];
}

export function readSidebarHostState(): SidebarHostState {
  const state = host.getState<unknown>();
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return { expandedConversationIds: [], favoriteConversationIds: [], userCollapsedConversationIds: [] };
  }
  const record = state as Record<string, unknown>;
  return {
    expandedConversationIds: readIdList(record, 'expandedConversationIds'),
    favoriteConversationIds: readIdList(record, 'favoriteConversationIds'),
    userCollapsedConversationIds: readIdList(record, 'userCollapsedConversationIds')
  };
}

export function getPersistedSidebarHostState(): SidebarHostState {
  return readSidebarHostState();
}

export function writeSidebarHostState(state: SidebarHostState): void {
  host.setState<SidebarHostState>({
    expandedConversationIds: [...state.expandedConversationIds],
    favoriteConversationIds: [...state.favoriteConversationIds],
    userCollapsedConversationIds: [...state.userCollapsedConversationIds]
  });
}
