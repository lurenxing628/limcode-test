<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconArrowDownLeft, IconArrowUpRight } from '@tabler/icons-vue';
import { useReliableKernelClientFeedStore } from '@webview/stores/useReliableKernelClientFeedStore';
import { reliableKernelDetailKey } from '@webview/domain/reliableDetailKey';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import {
  collaborationCardKindLabel,
  collaborationCardLabel,
  collaborationCardStatusLabel,
  type CollaborationTimelineCard
} from '@webview/domain/reliableCollaborationTimeline';

const props = defineProps<{ card: CollaborationTimelineCard }>();

const feed = useReliableKernelClientFeedStore();
const expanded = ref(false);
const bodyScroller = ref<HTMLElement | null>(null);
const acceptedAnswerId = computed(() => props.card.acceptedAnswerId ?? '');
const detail = computed(() => acceptedAnswerId.value
  ? feed.details[reliableKernelDetailKey('accepted-answer-content', acceptedAnswerId.value)] : undefined);
const label = computed(() => collaborationCardLabel(props.card));
const kindLabel = computed(() => collaborationCardKindLabel(props.card));
const statusLabel = computed(() => collaborationCardStatusLabel(props.card));

watch(acceptedAnswerId, () => { expanded.value = false; }, { flush: 'sync' });
watch(() => `${expanded.value}:${acceptedAnswerId.value}:${detail.value?.status ?? 'missing'}:${feed.peerStateGeneration}:${detail.value?.peerStateGeneration ?? 'missing'}`, ensureDetail);

function ensureDetail(): void {
  if (!expanded.value || !acceptedAnswerId.value) return;
  if (!detail.value) {
    feed.requestDetail('accepted-answer-content', acceptedAnswerId.value, { priority: 'expanded' });
  } else if (detail.value.status === 'ready' && !detail.value.refreshing
    && detail.value.peerStateGeneration !== feed.peerStateGeneration) {
    // Immutable bytes are already complete. An EOF range refreshes scoped peer liveness only.
    feed.refreshDetail('accepted-answer-content', acceptedAnswerId.value, { priority: 'expanded' });
  }
}

function toggle(): void {
  expanded.value = !expanded.value;
  ensureDetail();
}

function retry(): void {
  if (acceptedAnswerId.value && !detail.value?.terminalError) {
    feed.retryDetail('accepted-answer-content', acceptedAnswerId.value, { priority: 'expanded' });
  }
}
</script>

<template>
  <article
    class="collaboration-card"
    :class="{ 'is-outgoing': card.direction === 'outgoing', 'is-waiting': card.status === 'waiting', 'is-failed': card.status === 'failed' || card.kind === 'failed_answer' }"
    :aria-label="[label, kindLabel, statusLabel].filter(Boolean).join(' · ')"
  >
    <header class="collaboration-card-header">
      <IconArrowDownLeft v-if="card.direction === 'incoming'" :size="14" stroke="1.9" aria-hidden="true" />
      <IconArrowUpRight v-else :size="14" stroke="1.9" aria-hidden="true" />
      <strong class="collaboration-card-peer" :class="{ 'is-deleted': card.peer.state === 'deleted', 'is-unknown': card.peer.state === 'unknown' }">{{ label }}</strong>
      <span class="collaboration-card-kind">{{ kindLabel }}</span>
      <span v-if="statusLabel" class="collaboration-card-state">{{ statusLabel }}</span>
      <button v-if="acceptedAnswerId" class="collaboration-card-toggle" type="button"
        :aria-expanded="expanded" :aria-label="expanded ? '收起已接收结果' : '查看已接收结果'" @click="toggle">
        {{ expanded ? '收起结果' : '查看结果' }}
      </button>
    </header>
    <p v-if="card.textPreview" class="collaboration-card-preview">{{ card.textPreview }}</p>
    <section v-if="expanded && acceptedAnswerId" class="collaboration-card-detail" aria-label="已接收结果正文">
      <p v-if="!detail || detail.status === 'loading'" class="collaboration-card-preview" role="status">正在加载已接收结果…</p>
      <div v-else-if="detail.status === 'error'" class="collaboration-card-error" role="status">
        <span>{{ detail.error || '结果正文加载失败。' }}</span>
        <button v-if="!detail.terminalError" class="collaboration-card-toggle" type="button" @click="retry">重试加载</button>
      </div>
      <template v-else>
        <div v-if="detail.refreshError" class="collaboration-card-error" role="status">
          <span>来源状态暂时无法确认：{{ detail.refreshError }}</span>
          <button v-if="!detail.terminalError" class="collaboration-card-toggle" type="button" @click="retry">重试核对来源</button>
        </div>
        <div ref="bodyScroller" class="collaboration-card-body-scroller">
          <pre class="collaboration-card-body">{{ detail.text || '（已接收结果为空）' }}</pre>
        </div>
        <AdvancedScrollbar :scroller="bodyScroller" :refresh-key="detail.totalBytes" variant="minimal" />
      </template>
    </section>
  </article>
</template>

<style scoped>
.collaboration-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: var(--space-2) var(--conversation-content-padding-right, var(--space-4))
    var(--space-2) var(--conversation-content-padding-left, var(--space-4));
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--vscode-panel-border);
  border-left-width: 2px;
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 95%, var(--vscode-foreground) 5%);
}

.collaboration-card.is-outgoing {
  background: transparent;
}

.collaboration-card.is-waiting {
  border-style: dashed;
}

.collaboration-card.is-failed {
  border-left-color: var(--vscode-errorForeground);
}

.collaboration-card.is-failed .collaboration-card-state {
  color: var(--vscode-errorForeground);
}

.collaboration-card-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-2);
  min-width: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.collaboration-card-peer {
  min-width: 0;
  overflow: hidden;
  color: var(--vscode-foreground);
  font-size: var(--font-size-sm);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.collaboration-card-peer.is-deleted,
.collaboration-card-peer.is-unknown {
  color: var(--vscode-descriptionForeground);
}

.collaboration-card-peer.is-deleted {
  font-style: italic;
}

.collaboration-card-kind,
.collaboration-card-state {
  padding: 0 var(--space-1);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
}

.collaboration-card-preview {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.collaboration-card-toggle {
  padding: 1px var(--space-1);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--vscode-foreground);
  font: inherit;
  cursor: pointer;
}

.collaboration-card-toggle:hover,
.collaboration-card-toggle:focus-visible {
  background: color-mix(in srgb, var(--vscode-foreground) 10%, transparent);
}

.collaboration-card-toggle:focus-visible {
  outline: 1px solid var(--vscode-foreground);
  outline-offset: 2px;
}

.collaboration-card-detail {
  position: relative;
  margin-top: var(--space-2);
  min-width: 0;
}

.collaboration-card-body-scroller {
  max-height: 360px;
  overflow: auto;
  scrollbar-width: none;
}

.collaboration-card-body-scroller::-webkit-scrollbar {
  display: none;
}

.collaboration-card-body {
  margin: 0;
  padding-right: var(--space-3);
  font-family: inherit;
  font-size: var(--font-size-sm);
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.collaboration-card-error {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--vscode-errorForeground);
  font-size: var(--font-size-xs);
}
</style>
