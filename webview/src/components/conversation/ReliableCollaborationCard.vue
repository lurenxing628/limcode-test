<script setup lang="ts">
import { computed } from 'vue';
import { IconArrowDownLeft, IconArrowUpRight } from '@tabler/icons-vue';
import {
  collaborationCardKindLabel,
  collaborationCardLabel,
  type CollaborationTimelineCard
} from '@webview/domain/reliableCollaborationTimeline';

const props = defineProps<{ card: CollaborationTimelineCard }>();

const label = computed(() => collaborationCardLabel(props.card));
const kindLabel = computed(() => collaborationCardKindLabel(props.card));
</script>

<template>
  <article
    class="collaboration-card"
    :class="{ 'is-outgoing': card.direction === 'outgoing', 'is-waiting': card.waiting }"
    :aria-label="`${label} · ${kindLabel}`"
  >
    <header class="collaboration-card-header">
      <IconArrowDownLeft v-if="card.direction === 'incoming'" :size="14" stroke="1.9" aria-hidden="true" />
      <IconArrowUpRight v-else :size="14" stroke="1.9" aria-hidden="true" />
      <strong class="collaboration-card-peer" :class="{ 'is-deleted': card.peer.state === 'deleted', 'is-unknown': card.peer.state === 'unknown' }">{{ label }}</strong>
      <span class="collaboration-card-kind">{{ kindLabel }}</span>
      <span v-if="card.waiting" class="collaboration-card-state">等待下一轮处理</span>
    </header>
    <p v-if="card.textPreview" class="collaboration-card-preview">{{ card.textPreview }}</p>
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
</style>
