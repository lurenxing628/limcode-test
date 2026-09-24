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

/** VS Code shell 只依赖此门面，不拥有或推断 Runtime 领域关系。 */
export interface ApplicationFacade {
  readonly onDidChangeConversationHistory: vscode.Event<void>;

  createConversation(options?: { projectFolderUri?: string }): Promise<string>;
  forkConversation(request: ConversationForkPayload): Promise<ConversationForkResult>;
  waitUntilHydrated(): Promise<void>;
  conversationExists(conversationId: string): Promise<boolean>;
  /**
   * Claims this Host as the Conversation Runtime owner for one view reference. Rejects with
   * `conversation-runtime-owner-busy` when a live/unknown peer Host owns the Conversation. Each
   * view (main or auxiliary) uses its own unique referenceId; hiding a view keeps the reference,
   * only dispose may release it.
   */
  retainConversation(conversationId: string, referenceId: string): Promise<void>;
  /** Best-effort release of one view reference; never fails a dispose path. */
  releaseConversation(conversationId: string, referenceId: string): Promise<void>;
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
