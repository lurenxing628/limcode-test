<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { isVisibleTextPart, type MessageContent, type TurnAuthoritySelection } from '@shared/protocol';
import { useConversationUiStore } from '@webview/stores/useConversationUiStore';
import { useChat } from '@webview/composables/useChat';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { useBottomStickyScroller } from '@webview/composables/useBottomStickyScroller';
import ReliableMessageList from './ReliableMessageList.vue';
import Composer from '@webview/components/input/Composer.vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';

const conversationUi = useConversationUiStore();
const reliableConversation = useReliableConversation();
const { sendMessage, editMessage } = useChat();
const currentConversationId = reliableConversation.conversationId;
const currentDisplayMessages = computed(() => reliableConversation.projection.value.messages);

const scroller = ref<HTMLElement | null>(null);
const conversationBody = ref<HTMLElement | null>(null);
const bottomStickyScroller = useBottomStickyScroller(scroller);
const followLatestTimeline = computed(() => bottomStickyScroller.stickyToBottom.value);
let pendingInitialBottomConversationId = '';
let initialBottomScrollFrame: number | undefined;
let pendingEditAuthority: TurnAuthoritySelection = {};
let pendingEditContent: MessageContent | undefined;

const loadingDetail = computed(() =>
  Boolean(reliableConversation.feed.sessionId)
  && Boolean(currentConversationId.value)
  && currentDisplayMessages.value.length === 0
  && reliableConversation.projection.value.loadingMessageRevisionIds.length > 0
);
const ready = computed(() => Boolean(reliableConversation.feed.sessionId && currentConversationId.value) && !loadingDetail.value);
const placeholder = computed(() =>
  ready.value
    ? '输入消息，Enter 发送，Shift+Enter 换行'
    : loadingDetail.value ? '对话内容加载中…' : '对话正在初始化…'
);
const emptyHint = computed(() =>
  ready.value ? '还没有消息，发一条试试。' : loadingDetail.value ? '正在加载对话内容，请稍候。' : '对话正在初始化，请稍候。'
);
const editFollowupCount = computed(() => Math.max(0, (conversationUi.editingMessage?.deleteCount ?? 1) - 1));
const editConfirmDescriptionHtml = computed(
  () => `是否编辑此消息？将同时删除后续 ${editFollowupCount.value} 条消息，此操作<strong>不可撤销</strong>`
);
const editConfirmActions: ConfirmPanelAction[] = [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'direct-confirm', label: '确认编辑' }
];
const scrollMarkers = computed(() =>
  currentDisplayMessages.value
    .filter((message) => message.role === 'user')
    .map((message, index) => {
      const editing = conversationUi.editingMessage?.message.id === message.id;
      const text = compactMessagePreview(message.content.parts);
      return {
        id: message.id,
        label: `用户消息 · ${index + 1}`,
        preview: text,
        kind: editing ? 'user editing' : 'user'
      };
    })
);

watch(
  currentConversationId,
  (conversationId) => {
    pendingInitialBottomConversationId = conversationId;
    bottomStickyScroller.scrollToBottomNow();
    scheduleInitialConversationBottomScroll();
  },
  { immediate: true, flush: 'post' }
);

watch(
  () => `${currentConversationId.value}:${currentDisplayMessages.value.length}:${reliableConversation.feed.lastCommitSeq ?? ''}:${Object.keys(reliableConversation.feed.transientModelRequests).length}`,
  () => scheduleInitialConversationBottomScroll(),
  { flush: 'post' }
);

onBeforeUnmount(() => cancelInitialBottomScrollFrame());

function scheduleInitialConversationBottomScroll(): void {
  const conversationId = currentConversationId.value;
  if (!conversationId || pendingInitialBottomConversationId !== conversationId) return;
  if (currentDisplayMessages.value.length === 0 && loadingDetail.value) return;
  void nextTick(() => {
    if (pendingInitialBottomConversationId !== conversationId || currentConversationId.value !== conversationId) return;
    bottomStickyScroller.scrollToBottomNow();
    cancelInitialBottomScrollFrame();
    initialBottomScrollFrame = window.requestAnimationFrame(() => {
      initialBottomScrollFrame = undefined;
      if (pendingInitialBottomConversationId !== conversationId || currentConversationId.value !== conversationId) return;
      bottomStickyScroller.scrollToBottomNow();
      pendingInitialBottomConversationId = '';
    });
  });
}

function cancelInitialBottomScrollFrame(): void {
  if (initialBottomScrollFrame === undefined) return;
  window.cancelAnimationFrame(initialBottomScrollFrame);
  initialBottomScrollFrame = undefined;
}

function onSubmit(text: string, content: MessageContent | undefined, authority: TurnAuthoritySelection): void {
  if (conversationUi.isEditing) {
    conversationUi.pendingEditText = text;
    pendingEditContent = content ? structuredClone(content) : undefined;
    pendingEditAuthority = {
      ...(authority.agentId?.trim() ? { agentId: authority.agentId.trim() } : {}),
      ...(authority.model ? { model: { ...authority.model } } : {})
    };
    conversationUi.editConfirmOpen = true;
    return;
  }
  sendMessage(text, content, authority);
}

function handleEditConfirmAction(action: ConfirmPanelAction): void {
  if (action.key === 'cancel') {
    conversationUi.editConfirmOpen = false;
    pendingEditAuthority = {};
    return;
  }
  if (action.key === 'direct-confirm') commitEditMessage();
}

function commitEditMessage(): void {
  const editing = conversationUi.editingMessage;
  const text = conversationUi.pendingEditText.trim();
  const content = pendingEditContent;
  if (!editing || (!text && !content?.parts.length)) return;
  const accepted = editMessage(editing.message.conversationId, editing.message.id, text, {
    expectedRevisionId: editing.message.revisionId ?? '',
    ...(content?.parts.length ? { content } : {}),
    runAfterEdit: true,
    deleteFollowing: true,
    ...pendingEditAuthority
  });
  if (!accepted) {
    // A competing stop-then action remains exact and cannot be silently replaced. Keep the edit
    // draft and confirmation open so the user can retry after that action has reconciled.
    conversationUi.editConfirmOpen = true;
    return;
  }
  conversationUi.editConfirmOpen = false;
  const finishAcceptedEdit = (): void => {
    pendingEditAuthority = {};
    pendingEditContent = undefined;
    conversationUi.cancelEditMode();
  };
  const nextMessage = nextMessageAfter(editing.message.id);
  if (nextMessage) {
    conversationUi.playExitFrom(nextMessage.id, finishAcceptedEdit);
    return;
  }
  finishAcceptedEdit();
}

function nextMessageAfter(messageId: string) {
  const index = currentDisplayMessages.value.findIndex((message) => message.id === messageId);
  return index >= 0 ? currentDisplayMessages.value[index + 1] : undefined;
}

function startReliableMessageEdit(message: (typeof currentDisplayMessages.value)[number], deleteCount: number): void {
  pendingEditContent = undefined;
  conversationUi.startEditMessage(message, deleteCount);
}

function compactMessagePreview(parts: MessageContent['parts']): string {
  const maxPreviewCharacters = 180;
  const maxScannedCharacters = 4_096;
  let preview = '';
  let scanned = 0;
  let pendingSpace = false;
  for (const part of parts) {
    if (!isVisibleTextPart(part)) continue;
    for (let index = 0; index < part.text.length && scanned < maxScannedCharacters; index += 1) {
      scanned += 1;
      const character = part.text.charAt(index);
      if (/\s/.test(character)) {
        pendingSpace = preview.length > 0;
        continue;
      }
      if (pendingSpace) preview += ' ';
      pendingSpace = false;
      preview += character;
      if (preview.length > maxPreviewCharacters) return `${preview.slice(0, maxPreviewCharacters)}...`;
    }
    if (scanned >= maxScannedCharacters) break;
  }
  return preview;
}
</script>

<template>
  <div class="conversation">
    <div ref="conversationBody" class="conversation-body">
      <div ref="scroller" class="conversation-scroll">
        <ReliableMessageList
          :empty-hint="emptyHint"
          :scroller="scroller"
          :follow-latest="followLatestTimeline"
          @edit-message="startReliableMessageEdit"
          @resend-as-new="conversationUi.prefillChatDraft"
        />
      </div>
      <AdvancedScrollbar
        class="conversation-main-scrollbar"
        :scroller="scroller"
        :markers="scrollMarkers"
        show-markers
        show-edge-buttons
        show-marker-preview
      />
    </div>
    <footer class="conversation-composer">
      <Composer :disabled="!ready" :placeholder="placeholder" :expand-boundary="conversationBody" @submit="onSubmit" />
    </footer>
    <ConfirmPanel
      :open="conversationUi.editConfirmOpen"
      title="编辑消息"
      :description-html="editConfirmDescriptionHtml"
      :actions="editConfirmActions"
      @action="handleEditConfirmAction"
      @cancel="conversationUi.editConfirmOpen = false"
    />
  </div>
</template>

<style scoped>
.conversation {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  --conversation-timeline-marker-width: 24px;
  --conversation-content-padding-left: var(--conversation-timeline-marker-width);
  --conversation-content-padding-right: var(--conversation-timeline-marker-width);
}

.conversation-body {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.conversation-scroll {
  height: 100%;
  overflow-y: auto;
  padding: 0;
  scrollbar-width: none;
  overflow-anchor: none;
}

.conversation-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.conversation :deep(.advanced-scrollbar.conversation-main-scrollbar) {
  right: 0;
}

.conversation-composer {
  flex: 0 0 auto;
  border-top: 1px solid var(--vscode-panel-border);
  padding: 0;
  background-color: var(--vscode-editor-background);
}
</style>
