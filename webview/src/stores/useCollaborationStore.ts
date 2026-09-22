import { defineStore } from 'pinia';
import { onScopeDispose, ref } from 'vue';
import { BridgeMessageType, createMessageId, type ExtensionToWebviewMessage, type WebviewToExtensionMessage } from '@shared/protocol';
import type {
  CollaborationBoardCommandPayload, CollaborationBoardResult, CollaborationMessage,
  CollaborationPermissionSetPayload, CollaborationSendPayload, CollaborationSnapshotPayload,
  CollaborationConversationResultPayload, CollaborationCommandResultPayload, CollaborationMessageResultPayload, CollaborationBoardResultPayload
} from '@shared/collaboration';
import { bridge } from '@webview/transport';
import { channelForType } from '@webview/transport/channels';

type CollaborationResponseMap = {
  [BridgeMessageType.CollaborationConversationResult]: CollaborationConversationResultPayload;
  [BridgeMessageType.CollaborationSnapshot]: CollaborationSnapshotPayload;
  [BridgeMessageType.CollaborationCommandResult]: CollaborationCommandResultPayload;
  [BridgeMessageType.CollaborationMessageResult]: CollaborationMessageResultPayload;
  [BridgeMessageType.CollaborationBoardResult]: CollaborationBoardResultPayload;
};

/** Scoped request replies never replace another Conversation's collaboration state. */
export const useCollaborationStore = defineStore('collaboration', () => {
  const snapshots = ref<Record<string, CollaborationSnapshotPayload>>({});
  const details = ref<Record<string, CollaborationMessage & { text: string }>>({});
  const pending = new Map<string, {
    resultType: ExtensionToWebviewMessage['type'];
    resolve: (payload: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const commandIds = new Map<string, string>();
  const dispose = bridge.onAny(message => {
    const request = message.correlationId && pending.get(message.correlationId);
    if (!request) return;
    if (message.type !== request.resultType && message.type !== BridgeMessageType.Error) return;
    pending.delete(message.correlationId!);
    clearTimeout(request.timer);
    if (message.type === BridgeMessageType.Error) request.reject(new Error(message.payload?.message || '协作请求失败'));
    else request.resolve(message.payload);
  });
  onScopeDispose(() => {
    dispose();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('协作面板已关闭'));
    }
    pending.clear();
  });

  function request<TType extends WebviewToExtensionMessage['type'], TResult extends keyof CollaborationResponseMap>(
    type: TType,
    payload: Extract<WebviewToExtensionMessage, { type: TType }>['payload'],
    resultType: TResult
  ): Promise<CollaborationResponseMap[TResult]> {
    const requestId = createMessageId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('协作请求超时；可重试，已提交的操作不会重复执行。'));
      }, 30_000);
      pending.set(requestId, { resultType, resolve: payload => resolve(payload as CollaborationResponseMap[TResult]), reject, timer });
      try { bridge.post({ id: requestId, type, payload, channel: channelForType(type) } as WebviewToExtensionMessage); }
      catch (error) {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(error);
      }
    });
  }

  async function refresh(conversationId: string, beforeMessageId?: string): Promise<void> {
    const snapshot = await request(BridgeMessageType.CollaborationGet, {
      conversationId, ...(beforeMessageId ? { beforeMessageId } : {})
    }, BridgeMessageType.CollaborationSnapshot);
    if (snapshot.conversationId !== conversationId) throw new Error('协作快照的对话不匹配');
    const existing = snapshots.value[conversationId];
    if (existing) {
      const merged = new Map(existing.messages.map(message => [message.messageId, message]));
      for (const message of snapshot.messages) merged.set(message.messageId, message);
      snapshot.messages = [...merged.values()];
      if (!beforeMessageId && existing.messages.length > 50) snapshot.olderCursor = existing.olderCursor;
    }
    snapshots.value = { ...snapshots.value, [conversationId]: snapshot };
  }

  function commandIdFor(key: string): string {
    const existing = commandIds.get(key);
    if (existing) return existing;
    const id = createMessageId();
    commandIds.set(key, id);
    return id;
  }

  async function send(input: Omit<CollaborationSendPayload, 'commandId'>): Promise<void> {
    const payload = {
      conversationId: input.conversationId, targetConversationId: input.targetConversationId,
      mode: input.mode, text: input.text,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {})
    };
    const key = JSON.stringify(['send', payload]);
    const result = await request(BridgeMessageType.CollaborationSend, { ...payload, commandId: commandIdFor(key) }, BridgeMessageType.CollaborationCommandResult);
    if (result.conversationId !== input.conversationId) throw new Error('协作确认的对话不匹配');
    commandIds.delete(key);
  }

  async function setPermission(input: Omit<CollaborationPermissionSetPayload, 'commandId'>): Promise<void> {
    const payload = {
      conversationId: input.conversationId, targetConversationId: input.targetConversationId,
      allowRead: input.allowRead, allowSend: input.allowSend, allowWake: input.allowWake
    };
    const key = JSON.stringify(['permission', payload]);
    const result = await request(BridgeMessageType.CollaborationPermissionSet, { ...payload, commandId: commandIdFor(key) }, BridgeMessageType.CollaborationCommandResult);
    if (result.conversationId !== input.conversationId) throw new Error('协作确认的对话不匹配');
    commandIds.delete(key);
  }

  async function readMessage(conversationId: string, messageId: string): Promise<void> {
    const response = await request(BridgeMessageType.CollaborationMessageRead, { conversationId, messageId }, BridgeMessageType.CollaborationMessageResult);
    if (response.conversationId !== conversationId || response.message.messageId !== messageId) throw new Error('协作消息的对话不匹配');
    details.value = { ...details.value, [`${conversationId}:${messageId}`]: response.message };
  }

  async function board(input: Omit<CollaborationBoardCommandPayload, 'commandId'>): Promise<CollaborationBoardResult> {
    // Explicit reconstruction keeps Vue reactive state out of bridge payloads.
    const payload = {
      conversationId: input.conversationId, operation: input.operation,
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.postId ? { postId: input.postId } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.text !== undefined ? { text: input.text } : {}),
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.subscribe !== undefined ? { subscribe: input.subscribe } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.offsetChars !== undefined ? { offsetChars: input.offsetChars } : {}),
      ...(input.limitChars !== undefined ? { limitChars: input.limitChars } : {})
    };
    const key = JSON.stringify(['board', payload]);
    const response = await request(BridgeMessageType.CollaborationBoardCommand, { ...payload, commandId: commandIdFor(key) }, BridgeMessageType.CollaborationBoardResult);
    if (response.conversationId !== input.conversationId || response.operation !== input.operation) throw new Error('留言板的对话或操作不匹配');
    commandIds.delete(key);
    return response.result;
  }
  async function readConversation(conversationId: string, targetConversationId: string, beforeMessageId?: string): Promise<CollaborationConversationResultPayload['target']> {
    const response = await request(BridgeMessageType.CollaborationConversationRead, { conversationId, targetConversationId,
      ...(beforeMessageId ? { beforeMessageId } : {}) }, BridgeMessageType.CollaborationConversationResult);
    if (response.conversationId !== conversationId || response.target.conversationId !== targetConversationId) throw new Error('读取的对话不匹配');
    return response.target;
  }
  return { snapshots, details, refresh, send, setPermission, readMessage, readConversation, board };
});
