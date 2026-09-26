import type * as vscode from 'vscode';
import type { StorageDataResetResult } from '../backend/capabilities/types';
import type {
  BridgeClientId,
  ConversationForkPayload,
  ConversationHistoryPageRecord,
  ConversationHistoryScope,
  ProjectFolderCandidateRecord,
  GlobalSettingsSection,
  SidebarConversationHistoryEntry,
  SidebarHistoryScopeKind,
  WebviewClientMeta,
  WebviewToExtensionMessage
} from '../shared/protocol';

export interface ConversationAbortResult {
  status: 'committed' | 'already_applied' | 'already_satisfied' | 'stale';
  reason?: string;
  turnId?: string;
}

export interface ConversationAbortTarget {
  turnId: string;
  leaseGeneration: string;
}

export interface ConversationForkResult {
  conversationId: string;
  deduplicated: boolean;
}

/**
 * Outcome of the opportunistic takeover a passive view attempts. The waiting variants mean the
 * Conversation still has unfinished work that this window does not serve, so it stayed untouched.
 */
export type ConversationRecoveryResult =
  | { status: 'checked' }
  | { status: 'waiting_for_project'; projectName: string }
  | { status: 'waiting_for_work_environment'; workEnvironmentId: string };

/** VS Code shell 只依赖此门面，不拥有或推断 Runtime 领域关系。 */
export interface ApplicationFacade {
  readonly onDidChangeConversationHistory: vscode.Event<void>;

  createConversation(options?: { projectFolderUri?: string }): Promise<string>;
  forkConversation(request: ConversationForkPayload): Promise<ConversationForkResult>;
  waitUntilHydrated(): Promise<void>;
  conversationExists(conversationId: string): Promise<boolean>;
  /**
   * Best-effort scoped recovery after opening a passive Conversation view; a live peer may own it,
   * and a window that does not serve the Conversation's project never takes it over.
   */
  recoverConversation(conversationId: string): Promise<ConversationRecoveryResult>;
  getConversationDisplayTitle(conversationId: string | undefined): string;
  renameConversationTitle(conversationId: string, title: string): Promise<boolean>;
  deleteConversation(conversationId: string): Promise<string[] | null>;
  abortConversation(
    conversationId: string,
    requestId: string,
    target: ConversationAbortTarget
  ): Promise<ConversationAbortResult>;

  getConversationHistoryEntries(): SidebarConversationHistoryEntry[];
  getConversationHistoryPage(input: {
    scopeKind: SidebarHistoryScopeKind;
    projectFolderUri?: string;
    cursor?: string;
    limit?: number;
  }): Promise<ConversationHistoryPageRecord>;
  getCurrentProjectHistoryScope(): ConversationHistoryScope;
  getProjectFolderCandidates(): ProjectFolderCandidateRecord[];

  getStorageRootUri(): vscode.Uri;
  refreshGlobalSettings(section: GlobalSettingsSection): Promise<void>;
  resetDevelopmentData(): Promise<StorageDataResetResult>;
  selectRuntimeDataSet(id: string): Promise<void>;
  inspectReliability(conversationId?: string): Promise<unknown>;

  attachWebview(webview: vscode.Webview, meta?: WebviewClientMeta): BridgeClientId;
  setWebviewVisible(clientId: BridgeClientId, visible: boolean): void;
  detachWebview(clientId: BridgeClientId): void;
  handleWebviewMessage(clientId: BridgeClientId, message: WebviewToExtensionMessage): void;
  handleReliableKernelControl?(clientId: BridgeClientId, message: unknown): Promise<boolean> | boolean;
  dispose(): Promise<void>;
}
