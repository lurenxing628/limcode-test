<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  direction: 'before' | 'after';
  available: boolean;
  active: boolean;
  searching: boolean;
  loading: boolean;
  blocked: boolean;
  scannedRows: number;
  notice: string;
  error: string | null;
}>();
const emit = defineEmits<{ (event: 'search'): void; (event: 'stop'): void }>();
const directionLabel = computed(() => props.direction === 'before' ? '更早' : '较新');
const label = computed(() => props.active && props.loading
  ? props.searching ? `正在查找${directionLabel.value}协作记录` : '正在接收协作记录'
  : `查找${directionLabel.value}协作记录`);
const progress = computed(() => [
  props.searching ? '正在查找' : props.notice,
  `已检查 ${props.scannedRows.toLocaleString()} 条记录`,
  !props.searching && props.loading ? '正在接收已发出的页面' : ''
].filter(Boolean).join(' · '));
</script>

<template>
  <div v-if="available || (active && (searching || notice || error))"
    class="reliable-collaboration-history-controls" :data-history-direction="direction"
    :data-scroll-anchor-key="`collaboration-history-${direction}`">
    <div class="reliable-collaboration-history-actions">
      <button v-if="available" type="button" class="reliable-segment-control"
        :disabled="blocked || searching || loading" @click="emit('search')">{{ label }}</button>
      <button v-if="active && searching" type="button" class="reliable-segment-control"
        @click="emit('stop')">停止查找</button>
    </div>
    <p v-if="active && (searching || notice)" class="reliable-collaboration-progress" role="status">{{ progress }}</p>
    <p v-if="active && error" class="reliable-history-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.reliable-collaboration-history-controls {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
}
.reliable-collaboration-history-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
}
.reliable-segment-control {
  min-height: 28px;
  padding: 0 var(--space-3);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
}
.reliable-segment-control:hover,
.reliable-segment-control:focus-visible {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}
.reliable-segment-control:disabled { cursor: default; opacity: 0.65; }
.reliable-collaboration-progress,
.reliable-history-error { margin: 0; font-size: var(--font-size-sm); text-align: center; }
.reliable-collaboration-progress { color: var(--vscode-descriptionForeground); }
.reliable-history-error { color: var(--vscode-errorForeground); }
</style>
