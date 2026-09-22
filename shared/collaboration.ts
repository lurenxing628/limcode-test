/** Plain bridge projections; Runtime records remain owned by their independent domains. */
export interface CollaborationMember {
  conversationId: string;
  childExecutionId: string | null;
  parentConversationId: string | null;
  status: string;
  title: string;
  relation: 'team' | 'permitted';
}
export interface CollaborationPermission {
  sourceConversationId: string;
  targetConversationId: string;
  allowRead: boolean;
  allowSend: boolean;
  allowWake: boolean;
}
export interface CollaborationMessage {
  messageId: string;
  sourceConversationId: string;
  targetConversationId: string;
  mode: 'message' | 'followup';
  sourceKind: string;
  createdAt: string;
  replyToMessageId: string | null;
  deliveryState: 'pending' | 'consumed' | 'failed';
  handled: boolean;
  text?: string;
}
export interface CollaborationGetPayload { conversationId: string; beforeMessageId?: string; }
export interface CollaborationSnapshotPayload {
  conversationId: string;
  rootConversationId: string;
  members: CollaborationMember[];
  messages: CollaborationMessage[];
  nextCursor: string | null;
  olderCursor: string | null;
  permissions: CollaborationPermission[];
  permissionCandidates: Array<{ conversationId: string; title: string }>;
}
export interface CollaborationSendPayload {
  conversationId: string;
  commandId: string;
  targetConversationId: string;
  text: string;
  mode: 'message' | 'followup';
  replyToMessageId?: string;
}
export interface CollaborationPermissionSetPayload {
  conversationId: string;
  commandId: string;
  targetConversationId: string;
  allowRead: boolean;
  allowSend: boolean;
  allowWake: boolean;
}
export interface CollaborationMessageReadPayload { conversationId: string; messageId: string; }
export interface CollaborationCommandResultPayload { conversationId: string; messageId?: string; }
export interface CollaborationMessageResultPayload { conversationId: string; message: CollaborationMessage & { text: string }; }
export interface CollaborationBoardCommandPayload {
  conversationId: string;
  commandId: string;
  operation: 'create_channel' | 'list_channels' | 'list_threads' | 'read_thread' | 'read_post' | 'search' | 'subscribe' | 'unsubscribe' | 'post';
  channelId?: string;
  threadId?: string;
  postId?: string;
  name?: string;
  text?: string;
  query?: string;
  subscribe?: boolean;
  limit?: number;
  cursor?: string;
  offsetChars?: number;
  limitChars?: number;
}
export interface CollaborationBoardChannel { id: string; name: string; createdAt: number; subscribed: boolean; }
export interface CollaborationBoardPost {
  id: string;
  channelId: string;
  threadId: string;
  authorConversationId: string;
  authorKind: 'tool' | 'user';
  createdAt: number;
  preview: string;
  characterCount: number;
}
export interface CollaborationBoardResult {
  channels?: CollaborationBoardChannel[];
  channel?: Omit<CollaborationBoardChannel, 'subscribed'>;
  posts?: CollaborationBoardPost[];
  root?: CollaborationBoardPost;
  replies?: CollaborationBoardPost[];
  post?: CollaborationBoardPost;
  text?: string;
  postId?: string;
  threadId?: string;
  channelId?: string;
  subscribed?: boolean;
  nextCursor?: string;
  nextOffsetChars?: number;
}
export interface CollaborationBoardResultPayload {
  conversationId: string;
  operation: CollaborationBoardCommandPayload['operation'];
  result: CollaborationBoardResult;
}

export interface CollaborationConversationReadPayload {
  conversationId: string;
  targetConversationId: string;
  beforeMessageId?: string;
}
export interface CollaborationConversationResultPayload {
  conversationId: string;
  target: {
    conversationId: string;
    title: string;
    status: string;
    messages: Array<{ messageId: string; role: string; text: string; createdAt: string; truncated: boolean }>;
    olderMessageId: string | null;
    hasMore: boolean;
  };
}
