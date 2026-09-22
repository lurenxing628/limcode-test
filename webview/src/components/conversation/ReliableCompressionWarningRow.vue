<script setup lang="ts">
import { IconAlertTriangle, IconX } from '@tabler/icons-vue';

defineProps<{
  title: string;
  detail: string;
  severity?: 'warning' | 'error';
}>();

const emit = defineEmits<{ (event: 'dismiss'): void }>();
</script>

<template>
  <article class="compression-warning-row" :class="{ 'is-error': severity === 'error' }" :role="severity === 'error' ? 'alert' : 'status'" :aria-label="`${title}：${detail}`">
    <div class="compression-warning-icon" aria-hidden="true">
      <IconAlertTriangle :size="17" stroke="1.9" />
    </div>
    <div class="compression-warning-content">
      <strong>{{ title }}</strong>
      <p>{{ detail }}</p>
    </div>
    <button
      type="button"
      class="compression-warning-dismiss"
      aria-label="关闭上下文压缩提示"
      @click="emit('dismiss')"
    >
      <IconX :size="15" stroke="1.9" />
    </button>
  </article>
</template>

<style scoped>
.compression-warning-row.is-error { border-color: var(--vscode-editorError-foreground); }
.compression-warning-row.is-error .compression-warning-icon { color: var(--vscode-editorError-foreground); }
.compression-warning-row {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: var(--space-2) var(--conversation-content-padding-right, var(--space-4))
    var(--space-2) var(--conversation-content-padding-left, var(--space-4));
  padding: var(--space-2) var(--space-3);
  border: 1px solid color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 48%, var(--vscode-panel-border));
  border-radius: var(--radius-sm);
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-editorWarning-foreground, #cca700) 6%);
}

.compression-warning-icon {
  flex: 0 0 auto;
  display: inline-flex;
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.compression-warning-content {
  min-width: 0;
  flex: 1 1 auto;
}

.compression-warning-content strong {
  display: block;
  margin-bottom: 2px;
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.compression-warning-content p {
  margin: 0;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.compression-warning-dismiss {
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

.compression-warning-dismiss:hover,
.compression-warning-dismiss:focus-visible {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border);
  background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%);
  outline: none;
}
</style>
