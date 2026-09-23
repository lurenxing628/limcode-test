import { defineStore } from 'pinia';
import { createEmptyClientState } from '@shared/clientStateSchema';
import type { ClientState, ConversationRecord } from '@shared/protocol';

export interface ClientStateStoreState extends ClientState {
  /** Configuration authority is independent from the reliable Runtime Feed. */
  configurationReady: boolean;
  /** Current Webview focus; reliable Runtime records remain in their own bounded store. */
  currentConversationId: string;
}

const useClientStateStoreDefinition = defineStore('clientState', {
  state: (): ClientStateStoreState => ({
    ...createEmptyClientState(),
    configurationReady: false,
    currentConversationId: ''
  }),
  getters: {
    settingsClientStateReady(state): boolean {
      return state.configurationReady;
    },
    settingsClientStateLoading(state): boolean {
      return !state.configurationReady;
    },
    isConfigScopeClientStateLoading(state): () => boolean {
      return (): boolean => !state.configurationReady;
    },
    currentConversation(state): ConversationRecord | undefined {
      return state.conversations.find((conversation) => conversation.id === state.currentConversationId);
    }
  },
  actions: {
    applyConfigurationSnapshot(state: ClientState): void {
      Object.assign(this, {
        agents: state.agents.map(cloneRecord),
        workflows: state.workflows.map(cloneRecord),
        planReviewPolicies: state.planReviewPolicies.map(cloneRecord),
        planReviewPolicyScopeLinks: state.planReviewPolicyScopeLinks.map(cloneRecord),
        toolDefinitions: state.toolDefinitions.map(cloneRecord),
        toolPolicies: state.toolPolicies.map(cloneRecord),
        toolPolicyScopeLinks: state.toolPolicyScopeLinks.map(cloneRecord),
        builtinToolPolicies: state.builtinToolPolicies.map(cloneRecord),
        mcpToolSources: state.mcpToolSources.map(cloneRecord),
        skillDefinitions: state.skillDefinitions.map(cloneRecord),
        skillPolicies: state.skillPolicies.map(cloneRecord),
        skillPolicyScopeLinks: state.skillPolicyScopeLinks.map(cloneRecord),
        ruleFiles: state.ruleFiles.map(cloneRecord),
        systemPrompts: state.systemPrompts.map(cloneRecord),
        systemPromptScopeLinks: state.systemPromptScopeLinks.map(cloneRecord),
        promptPlaceholders: state.promptPlaceholders.map(cloneRecord),
        runtimeContexts: state.runtimeContexts.map(cloneRecord),
        runtimeContextScopeLinks: state.runtimeContextScopeLinks.map(cloneRecord),
        workEnvironments: state.workEnvironments.map(cloneRecord),
        workEnvironmentPolicies: state.workEnvironmentPolicies.map(cloneRecord),
        workEnvironmentPolicyScopeLinks: state.workEnvironmentPolicyScopeLinks.map(cloneRecord),
        checkpointPolicies: state.checkpointPolicies.map(cloneRecord),
        checkpointPolicyScopeLinks: state.checkpointPolicyScopeLinks.map(cloneRecord),
        conversationWorkflowSelections: state.conversationWorkflowSelections.map(cloneRecord),
        conversationWorkEnvironmentLinks: state.conversationWorkEnvironmentLinks.map(cloneRecord),
        configurationReady: true
      });
    },
    setCurrentConversation(conversationId: string): void {
      const normalized = conversationId.trim();
      if (normalized) this.currentConversationId = normalized;
    }
  }
});

export interface ClientStateStorePublic extends ClientStateStoreState {
  $state: ClientStateStoreState;
  readonly settingsClientStateReady: boolean;
  readonly settingsClientStateLoading: boolean;
  readonly isConfigScopeClientStateLoading: (scopeKind?: string, scopeId?: string) => boolean;
  readonly currentConversation: ConversationRecord | undefined;
  applyConfigurationSnapshot(state: ClientState): void;
  setCurrentConversation(conversationId: string): void;
}

export const useClientStateStore = useClientStateStoreDefinition as unknown as () => ClientStateStorePublic;

function cloneRecord<T extends object>(record: T): T {
  return { ...record };
}
