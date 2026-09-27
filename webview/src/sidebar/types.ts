import type {
  ConversationHistoryPageRecord,
  ConversationHistoryScope,
  OpenConversationPanelRecord,
  ProjectFolderCandidateRecord,
  SidebarHistoryScopeKind,
  SidebarConversationHistoryEntry
} from '@shared/protocol';

export const SIDEBAR_MESSAGE = {
  openConversation: 'openConversation',
  newConversation: 'newConversation',
  openGlobalSettings: 'openGlobalSettings',
  openWorkflowSettings: 'openWorkflowSettings',
  openAgentSettings: 'openAgentSettings',
  historyPageGet: 'sidebar.historyPage.get',
  state: 'sidebar.state',
  ready: 'sidebar.ready',
  renameConversation: 'renameConversation',
  deleteConversation: 'deleteConversation',
  abortConversation: 'abortConversation',
  conversationOperationResult: 'sidebar.conversationOperation.result'
} as const;

export type SidebarConversationOperation = 'delete' | 'abort';

export type SidebarToExtensionMessage =
  | { type: typeof SIDEBAR_MESSAGE.ready }
  | { type: typeof SIDEBAR_MESSAGE.openConversation; conversationId: string; title?: string }
  | { type: typeof SIDEBAR_MESSAGE.newConversation; projectFolderUri?: string }
  | { type: typeof SIDEBAR_MESSAGE.openGlobalSettings }
  | { type: typeof SIDEBAR_MESSAGE.openWorkflowSettings }
  | { type: typeof SIDEBAR_MESSAGE.openAgentSettings }
  | { type: typeof SIDEBAR_MESSAGE.historyPageGet; scopeKind: SidebarHistoryScopeKind; projectFolderUri?: string; cursor?: string; limit?: number }
  | { type: typeof SIDEBAR_MESSAGE.renameConversation; conversationId: string; title: string }
  | { type: typeof SIDEBAR_MESSAGE.deleteConversation; conversationId: string }
  | {
      type: typeof SIDEBAR_MESSAGE.abortConversation;
      conversationId: string;
      requestId: string;
      turnId: string;
      leaseGeneration: string;
    };

export type ExtensionToSidebarMessage =
  | {
      type: typeof SIDEBAR_MESSAGE.state;
      history: ConversationHistoryPageRecord;
      activeScopeKind: SidebarHistoryScopeKind;
      activeProjectFolderUri?: string;
      currentProjectScope: ConversationHistoryScope;
      projectFolders: ProjectFolderCandidateRecord[];
      openConversations: OpenConversationPanelRecord[];
    }
  | {
      type: typeof SIDEBAR_MESSAGE.conversationOperationResult;
      operation: SidebarConversationOperation;
      conversationId: string;
      ok: boolean;
      requestId?: string;
      status?: 'committed' | 'already_applied' | 'already_satisfied' | 'stale';
      runId?: string;
      deletedConversationIds?: string[];
      /** 'warning': a deletion that did not complete in time (its stop requests stay). */
      severity?: 'warning';
      message?: string;
    };

export type {
  ConversationHistoryPageRecord,
  ConversationHistoryScope,
  ProjectFolderCandidateRecord,
  SidebarHistoryScopeKind,
  SidebarConversationHistoryEntry
};
