<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconChevronRight, IconListNumbers } from '@tabler/icons-vue';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import TaskListDisplay from './TaskListDisplay.vue';
import {
  emptyTaskListSnapshot,
  formatTaskListProgress,
  type TaskListSnapshotView
} from './taskListModel';

const reliableConversation = useReliableConversation();
const expanded = ref(false);
const listScroller = ref<HTMLElement | null>(null);

const projectedSnapshot = computed(() => currentTaskListSnapshot(
  reliableConversation.feed.projections.activeConversationWindow,
  reliableConversation.conversationId.value
));
// Only the committed Conversation projection is authoritative. ToolCall arguments and historical
// page contents can preview a proposed operation, but must never alter the top task state.
const snapshot = computed<TaskListSnapshotView>(() =>
  projectedSnapshot.value ?? emptyTaskListSnapshot());
const visible = computed(() => snapshot.value.items.length > 0);
const progressLabel = computed(() => formatTaskListProgress(snapshot.value));
const activeLabel = computed(() => {
  const active = snapshot.value.activeItem;
  return active ? active.description || active.title : '';
});
const statsLabel = computed(() => {
  const stats = snapshot.value.stats;
  return `${stats.completed}/${stats.total} 已完成`;
});
const refreshKey = computed(() => snapshot.value.items.map((item) => `${item.key}:${item.status}:${item.updatedOrder}`).join('|'));

watch(reliableConversation.conversationId, () => {
  expanded.value = false;
});

function toggleExpanded(): void {
  expanded.value = !expanded.value;
}

function currentTaskListSnapshot(value: unknown, conversationId: string): TaskListSnapshotView | undefined {
  const window = plainRecord(value);
  const current = plainRecord(window?.currentTaskList);
  if (!current || (current.conversationId ?? current.conversation_id) !== conversationId || !Array.isArray(current.items)) {
    return undefined;
  }
  const items = current.items.flatMap((value, index) => {
    const item = plainRecord(value);
    const key = stringValue(item?.key);
    const title = stringValue(item?.title);
    const status = taskStatus(item?.status);
    if (!key || !title || !status) return [];
    const description = stringValue(item?.description);
    const sourceToolCallId = stringValue(item?.sourceToolCallId);
    return [{
      key,
      title,
      ...(description ? { description } : {}),
      status,
      createdOrder: safeInteger(item?.createdOrder) ?? index,
      updatedOrder: safeInteger(item?.updatedOrder) ?? index,
      ...(sourceToolCallId ? { sourceToolCallId } : {})
    }];
  });
  if (items.length !== current.items.length || new Set(items.map((item) => item.key)).size !== items.length) {
    return undefined;
  }
  const stats = {
    total: items.length,
    pending: items.filter((item) => item.status === 'pending').length,
    inProgress: items.filter((item) => item.status === 'in_progress').length,
    completed: items.filter((item) => item.status === 'completed').length,
    blocked: items.filter((item) => item.status === 'blocked').length,
    cancelled: items.filter((item) => item.status === 'cancelled').length,
    open: items.filter((item) => item.status !== 'completed' && item.status !== 'cancelled').length
  };
  const activeItem = items.find((item) => item.status === 'in_progress');
  // The revision is computed by the backend from (message_seq, provider_ordinal, call_seq, id).
  // A source Message or ToolCall need not remain in the bounded live window for this card to exist.
  if (!stringValue(current.revision) || !stringValue(current.sourceToolCallId)) return undefined;
  return { items, stats, ...(activeItem ? { activeItem } : {}) };
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function taskStatus(value: unknown): 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled' | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed'
    || value === 'blocked' || value === 'cancelled'
    ? value
    : undefined;
}
</script>

<template>
  <section v-if="visible" class="task-list-top-panel" :class="{ 'is-expanded': expanded }" :aria-label="progressLabel">
    <button
      type="button"
      class="task-list-top-header"
      :aria-expanded="expanded"
      aria-label="展开或收起任务清单"
      @click="toggleExpanded"
    >
      <IconListNumbers class="task-list-top-icon" stroke="2" aria-hidden="true" />
      <span class="task-list-top-title">任务清单</span>
      <span class="task-list-top-stats">{{ statsLabel }}</span>
      <span v-if="activeLabel" class="task-list-top-active">当前：{{ activeLabel }}</span>
      <IconChevronRight
        class="task-list-top-chevron lc-collapse-chevron"
        :class="{ 'is-expanded': expanded }"
        stroke="2"
        aria-hidden="true"
      />
    </button>

    <div class="task-list-top-body lc-collapse-shell" :class="{ 'is-expanded': expanded }" :aria-hidden="!expanded">
      <div class="task-list-top-body-frame lc-collapse-frame">
        <div class="task-list-top-body-content">
          <div class="task-list-top-scroll-shell">
            <div ref="listScroller" class="task-list-top-scroll">
              <TaskListDisplay :items="snapshot.items" density="compact" :show-description="false" />
            </div>
            <AdvancedScrollbar :scroller="listScroller" :refresh-key="refreshKey" variant="minimal" />
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.task-list-top-panel {
  flex: 0 0 auto;
  border-bottom: 1px solid var(--vscode-panel-border);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
}

.task-list-top-header {
  width: 100%;
  min-height: 28px;
  border: 0;
  padding: 0 var(--space-4);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--vscode-foreground);
  background: transparent;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.task-list-top-header:hover,
.task-list-top-header:focus-visible {
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.task-list-top-title {
  flex: 0 0 auto;
  font-weight: 600;
  font-size: var(--font-size-sm);
}

.task-list-top-stats,
.task-list-top-active {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.task-list-top-active {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-list-top-icon {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  color: var(--vscode-descriptionForeground);
}

.task-list-top-chevron {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--vscode-descriptionForeground);
}

.task-list-top-body-content {
  padding: 0 var(--conversation-content-padding-right, calc(var(--space-4) + 24px)) 8px
    var(--conversation-content-padding-left, var(--space-4));
}

.task-list-top-scroll-shell {
  position: relative;
  min-height: 0;
}

.task-list-top-scroll {
  max-height: 138px;
  overflow-y: auto;
  padding: 2px 14px 2px 0;
  scrollbar-width: none;
}

.task-list-top-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}
</style>
