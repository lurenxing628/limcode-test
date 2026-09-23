<script setup lang="ts">
import { computed } from 'vue';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';
import {
  SUMMARY_REBUILD_COST_NOTE,
  SUMMARY_REBUILD_DESCRIPTION,
  summaryRebuildPreviewView,
  type SummaryRebuildPreviewState
} from './summaryRebuildPreview';

const props = defineProps<{
  open: boolean;
  preview?: SummaryRebuildPreviewState;
  /** The dialog still targets the current, idle Context it was opened for. */
  targetCurrent: boolean;
}>();

const emit = defineEmits<{
  (event: 'confirm'): void;
  (event: 'cancel'): void;
}>();

const view = computed(() => summaryRebuildPreviewView(props.preview));
const confirmable = computed(() => props.targetCurrent && view.value.canConfirm);
const actions = computed<ConfirmPanelAction[]>(() => [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'confirm', label: '重建摘要', disabled: !confirmable.value }
]);

function confirm(): void {
  if (confirmable.value) emit('confirm');
}
</script>

<template>
  <ConfirmPanel
    :open="open"
    title="从原始记录重建摘要？"
    :description="SUMMARY_REBUILD_DESCRIPTION"
    :actions="actions"
    test-id="compression-rebuild-confirm"
    @confirm="confirm"
    @cancel="emit('cancel')"
  >
    <p class="summary-rebuild-note">{{ SUMMARY_REBUILD_COST_NOTE }}</p>
    <dl v-if="view.rows.length" class="summary-rebuild-rows" data-testid="compression-rebuild-preview">
      <div v-for="row in view.rows" :key="row.label" class="summary-rebuild-row">
        <dt>{{ row.label }}</dt>
        <dd>{{ row.value }}</dd>
      </div>
    </dl>
    <p
      v-if="view.notice"
      class="summary-rebuild-notice"
      :class="`is-${view.tone}`"
      role="status"
      data-testid="compression-rebuild-notice"
    >{{ view.notice }}</p>
    <p v-if="!targetCurrent" class="summary-rebuild-notice is-blocked">当前上下文或执行状态已变化，请关闭后重新选择。</p>
  </ConfirmPanel>
</template>

<style scoped>
.summary-rebuild-note {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  line-height: 1.5;
}

.summary-rebuild-rows {
  display: grid;
  gap: var(--space-1);
  margin: var(--space-3) 0 0;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.28));
  border-radius: var(--radius-sm);
}

.summary-rebuild-row {
  display: grid;
  grid-template-columns: 7em minmax(0, 1fr);
  gap: var(--space-2);
  line-height: 1.5;
}

.summary-rebuild-row dt {
  color: var(--vscode-descriptionForeground);
}

.summary-rebuild-row dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}

.summary-rebuild-notice {
  margin: var(--space-3) 0 0;
  line-height: 1.5;
  color: var(--vscode-descriptionForeground);
}

.summary-rebuild-notice.is-blocked {
  color: var(--vscode-errorForeground);
}

.summary-rebuild-notice.is-unknown {
  color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
}
</style>
