import { computed, shallowRef, watch, type Ref } from 'vue';
import type { InlineDataPart } from '@shared/protocol';
import type { ChatDraftPrefillRequest } from '@webview/stores/useConversationUiStore';

/** The parts of the conversation UI store a "send as a new message" request needs. */
export interface ChatDraftPrefillHost {
  readonly chatDraftPrefill: ChatDraftPrefillRequest | undefined;
  readonly isEditing: boolean;
  readonly chatDraft: string;
  takeChatDraftPrefill(key: number): ChatDraftPrefillRequest | undefined;
  replaceChatDraft(text: string): void;
}

/**
 * Applies a "send as a new message" request to the chat composer. An empty chat draft outside edit
 * mode is filled at once, attachments included. A draft with text or attachments, or an open edit,
 * is replaced only after the user confirms, so nothing typed or being edited disappears silently.
 */
export function useChatDraftPrefill(ui: ChatDraftPrefillHost, chatAttachments: Ref<InlineDataPart[]>) {
  const pending = shallowRef<ChatDraftPrefillRequest>();
  const confirmDescription = computed(() => {
    const replacesDraft = ui.chatDraft.trim().length > 0 || chatAttachments.value.length > 0;
    if (ui.isEditing && replacesDraft) {
      return '正在编辑的消息会被放弃，输入框里尚未发送的文字和附件也会换成这条消息的内容。';
    }
    if (ui.isEditing) return '正在编辑的消息会被放弃，输入框会换成这条消息的文字和附件。';
    return '输入框里尚未发送的文字和附件会换成这条消息的内容。';
  });

  watch(() => ui.chatDraftPrefill, (request) => {
    if (!request || !ui.takeChatDraftPrefill(request.key)) return;
    if (ui.isEditing || ui.chatDraft.trim() || chatAttachments.value.length > 0) {
      pending.value = request;
      return;
    }
    apply(request);
  }, { immediate: true });

  function apply(request: ChatDraftPrefillRequest): void {
    chatAttachments.value = request.attachments.map((part) => ({ inlineData: { ...part.inlineData } }));
    ui.replaceChatDraft(request.text);
  }

  function confirm(): void {
    const request = pending.value;
    pending.value = undefined;
    if (request) apply(request);
  }

  function cancel(): void {
    pending.value = undefined;
  }

  return { pending, confirmDescription, confirm, cancel };
}
