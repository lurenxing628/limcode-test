<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconAlertTriangle, IconRefresh, IconX } from '@tabler/icons-vue';
import type { RunTerminationRecord } from '@shared/protocol';
import ConfirmPanel from '@webview/components/ui/ConfirmPanel.vue';

const props = defineProps<{
  termination: RunTerminationRecord;
  title?: string;
  retryModelRequestId?: string;
  retryBlockedReason?: string;
  retryPending?: boolean;
}>();
const emit = defineEmits<{ (event: 'dismiss'): void; (event: 'retry', modelRequestId: string): void }>();
const confirmingRequestId = ref<string>();
const retryBlocked = computed(() => props.retryPending || !props.retryModelRequestId || Boolean(props.retryBlockedReason));
watch(() => [props.retryModelRequestId, props.retryBlockedReason, props.retryPending, props.termination.id], () => {
  confirmingRequestId.value = undefined;
});
function confirmRetry(): void {
  const requestId = confirmingRequestId.value;
  confirmingRequestId.value = undefined;
  if (retryBlocked.value || !requestId || requestId !== props.retryModelRequestId) return;
  emit('retry', requestId);
}

const title = computed(() => props.title ?? (props.termination.kind === 'failed'
  ? '本轮执行失败'
  : props.termination.kind === 'cancelled'
    ? '本轮已取消'
    : '本轮已中断'));
const detail = computed(() => props.termination.detail?.trim() || props.termination.reasonCode);
</script>

<template>
  <article class="reliable-termination-row" role="status" :aria-label="`${title}：${detail}`">
    <div class="reliable-termination-icon" aria-hidden="true">
      <IconAlertTriangle :size="17" stroke="1.9" />
    </div>
    <div class="reliable-termination-content">
      <strong>{{ title }}</strong>
      <p>{{ detail }}</p>
      <p v-if="retryBlockedReason" class="reliable-retry-explanation">{{ retryBlockedReason }}</p>
      <button v-if="retryModelRequestId" type="button" class="reliable-termination-retry"
        :disabled="retryBlocked" aria-label="重试本轮模型请求"
        @click="confirmingRequestId = retryModelRequestId">
        <IconRefresh :size="14" aria-hidden="true" />{{ retryPending ? '正在提交重试' : '重试模型请求' }}
      </button>
    </div>
    <button
      type="button"
      class="reliable-termination-dismiss"
      aria-label="关闭本轮终止提示"
      @click="emit('dismiss')"
    >
      <IconX :size="15" stroke="1.9" />
    </button>
  </article>
  <ConfirmPanel :open="Boolean(confirmingRequestId)" title="重试模型请求？"
    description="将从这次请求的上下文重新生成回复。已经写入上下文的工具结果会保留；模型仍可能提出新的工具调用。"
    confirm-label="重试" @cancel="confirmingRequestId = undefined" @confirm="confirmRetry" />
</template>

<style scoped>
.reliable-termination-retry {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  margin-top: var(--space-2);
  padding: 4px 8px;
  color: var(--vscode-foreground);
  background: transparent;
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
}
.reliable-termination-retry:disabled { opacity: 0.55; cursor: default; }
.reliable-termination-retry:not(:disabled):hover { background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%); }
.reliable-retry-explanation { margin-top: var(--space-1); }

.reliable-termination-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: var(--space-2) var(--conversation-content-padding-right, var(--space-4))
    var(--space-2) var(--conversation-content-padding-left, var(--space-4));
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--vscode-editorError-foreground, #f48771) 46%, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-editorError-foreground, #f48771) 6%);
}

.reliable-termination-icon {
  flex: 0 0 auto;
  display: inline-flex;
  color: var(--vscode-editorError-foreground, #f48771);
}

.reliable-termination-content {
  min-width: 0;
  flex: 1 1 auto;
}

.reliable-termination-dismiss {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin: -2px -4px 0 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.reliable-termination-dismiss:hover,
.reliable-termination-dismiss:focus-visible {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  outline: none;
}

.reliable-termination-content strong {
  display: block;
  margin-bottom: 2px;
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.reliable-termination-content p {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  overflow-wrap: anywhere;
}
</style>
