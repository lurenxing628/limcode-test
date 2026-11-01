<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { IconBraces, IconMessageForward, IconPencil, IconTerminal2, IconWriting } from '@tabler/icons-vue';
import { toolCallPreviewPresentation, type ToolCallPreviewRenderMode } from '@shared/toolCallPreview';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import { useBottomStickyScroller } from '@webview/composables/useBottomStickyScroller';
import type { ReliableTransientToolCallState } from '@webview/domain/reliableTransientModel';
import TextPartView from './TextPartView.vue';

const props = withDefaults(defineProps<{
  preview: ReliableTransientToolCallState;
  active: boolean;
  /** 参数已生成、工具还没开始执行（模型仍在输出或工具在排队）：标题不能读成“已完成”。 */
  awaitingExecution?: boolean;
  maxBodyHeight?: number;
  compact?: boolean;
}>(), {
  maxBodyHeight: 168,
  compact: false,
  awaitingExecution: false
});

const framedPreview = shallowRef<ReliableTransientToolCallState>({ ...props.preview });
const pendingPreview = shallowRef<ReliableTransientToolCallState | undefined>();
const pendingFinalPreview = shallowRef<ReliableTransientToolCallState | undefined>();
const previewScroller = ref<HTMLElement | null>(null);
useBottomStickyScroller(previewScroller);
let frameRequest: number | undefined;
let renderModeCallId = framedPreview.value.callId;
const frozenRenderMode = ref<ToolCallPreviewRenderMode | undefined>();

const presentation = computed(() => toolCallPreviewPresentation(framedPreview.value));
const previewStyle = computed(() => ({
  '--tool-preview-max-body-height': `${Math.max(24, Math.round(props.maxBodyHeight))}px`
}));
const previewFinal = computed(() => framedPreview.value.final === true);
const previewStreaming = computed(() => props.active && !previewFinal.value);
const previewAwaitingExecution = computed(() => previewFinal.value && props.awaitingExecution);
const displayTitle = computed(() => {
  if (previewStreaming.value) return presentation.value.title;
  if (!previewFinal.value) return stoppedPreviewTitle(presentation.value.kind);
  if (previewAwaitingExecution.value) return awaitingPreviewTitle(presentation.value.kind);
  switch (presentation.value.kind) {
    case 'plan': return 'Plan 已生成';
    case 'agent_answer': return 'Agent 回答已生成';
    case 'write': return '文件内容已生成';
    case 'edit': return '文件修改参数已生成';
    case 'command': return '命令已生成';
    case 'generic': return `${framedPreview.value.name?.trim() || '工具'} 参数已生成`;
  }
});
const displayRenderMode = computed(() => frozenRenderMode.value ?? presentation.value.renderMode);
const icon = computed(() => {
  if (presentation.value.kind === 'write' || presentation.value.kind === 'plan') return IconWriting;
  if (presentation.value.kind === 'agent_answer') return IconMessageForward;
  if (presentation.value.kind === 'edit') return IconPencil;
  if (presentation.value.kind === 'command') return IconTerminal2;
  return IconBraces;
});

watch(
  presentation,
  (next) => {
    if (renderModeCallId !== framedPreview.value.callId) {
      renderModeCallId = framedPreview.value.callId;
      frozenRenderMode.value = undefined;
    }
    // A write delta may expose content before path. Once visible, keep one renderer mounted for
    // this call so a late `.md` suffix cannot replay the accumulated text from character zero.
    if (!frozenRenderMode.value && next.previewText && next.renderMode) {
      frozenRenderMode.value = next.renderMode;
    }
  },
  { immediate: true }
);

watch(
  () => props.preview,
  (next) => {
    if (next.final === true && frameRequest !== undefined && pendingPreview.value) {
      pendingFinalPreview.value = { ...next };
      return;
    }
    pendingPreview.value = { ...next };
    if (next.final === true) {
      flushPreviewFrame();
      return;
    }
    if (frameRequest !== undefined) return;
    frameRequest = window.requestAnimationFrame(flushPreviewFrame);
  },
  { deep: false }
);

onBeforeUnmount(() => {
  if (frameRequest !== undefined) window.cancelAnimationFrame(frameRequest);
  frameRequest = undefined;
  pendingPreview.value = undefined;
  pendingFinalPreview.value = undefined;
});

function flushPreviewFrame(): void {
  frameRequest = undefined;
  const next = pendingPreview.value;
  pendingPreview.value = undefined;
  if (next) framedPreview.value = next;
  const finalPreview = pendingFinalPreview.value;
  if (!finalPreview) return;
  pendingFinalPreview.value = undefined;
  pendingPreview.value = finalPreview;
  frameRequest = window.requestAnimationFrame(flushPreviewFrame);
}

function awaitingPreviewTitle(kind: ReturnType<typeof toolCallPreviewPresentation>['kind']): string {
  switch (kind) {
    case 'plan': return 'Plan 已生成，正在提交';
    case 'agent_answer': return 'Agent 回答已生成，正在提交';
    case 'write': return '文件内容已生成，等待写入';
    case 'edit': return '文件修改参数已生成，等待应用';
    case 'command': return '命令已生成，等待执行';
    case 'generic': return `${framedPreview.value.name?.trim() || '工具'} 参数已生成，等待执行`;
  }
}

function stoppedPreviewTitle(kind: ReturnType<typeof toolCallPreviewPresentation>['kind']): string {
  switch (kind) {
    case 'plan': return 'Plan 生成已停止';
    case 'agent_answer': return 'Agent 回答生成已停止';
    case 'write': return '文件内容生成已停止';
    case 'edit': return '文件修改准备已停止';
    case 'command': return '命令生成已停止';
    case 'generic': return '工具参数生成已停止';
  }
}
</script>

<template>
  <section
    class="tool-preview-card"
    :class="{ 'is-compact': compact }"
    :style="previewStyle"
    aria-live="polite"
    :aria-label="displayTitle"
  >
    <header class="tool-preview-header">
      <span class="tool-preview-icon" aria-hidden="true"><component :is="icon" :size="15" stroke="1.8" /></span>
      <span class="tool-preview-heading">
        <strong>{{ displayTitle }}</strong>
        <span v-if="presentation.subject" class="tool-preview-subject">{{ presentation.subject }}</span>
      </span>
      <span v-if="previewStreaming || previewAwaitingExecution" class="tool-preview-pulse" aria-hidden="true"><i></i><i></i><i></i></span>
    </header>
    <div class="tool-preview-detail">{{ presentation.detail }}</div>
    <div v-if="presentation.previewText" class="tool-preview-code-shell">
      <div ref="previewScroller" class="tool-preview-code-scroll">
        <TextPartView
          v-if="displayRenderMode === 'markdown'"
          class="tool-preview-markdown"
          :text="presentation.previewText"
          :streaming="previewStreaming"
          markdown
          :show-streaming-indicator="false"
        />
        <pre v-else><code>{{ presentation.previewText }}</code><span v-if="previewStreaming" class="tool-preview-caret" aria-hidden="true"></span></pre>
      </div>
      <AdvancedScrollbar :scroller="previewScroller" variant="minimal" />
    </div>
  </section>
</template>

<style scoped>
.tool-preview-card {
  display: grid;
  gap: var(--space-2);
  margin: var(--space-2) 0;
  padding: var(--space-3);
  border: 1px solid var(--vscode-panel-border);
  border-left: 2px solid var(--vscode-descriptionForeground);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
  color: var(--vscode-foreground);
  min-width: 0;
  animation: lc-block-reveal var(--lc-block-reveal-duration) ease-out both;
}

.tool-preview-card.is-compact {
  gap: var(--space-1);
  margin: var(--space-1) 0;
  padding-block: var(--space-2);
}

.tool-preview-card.is-compact .tool-preview-detail {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-preview-header {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 0;
}

.tool-preview-icon {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  color: var(--vscode-descriptionForeground);
}

.tool-preview-heading {
  flex: 1 1 auto;
  display: grid;
  gap: 2px;
  min-width: 0;
}

.tool-preview-heading strong {
  font-size: var(--font-size-sm);
  font-weight: 600;
  line-height: 1.35;
}

.tool-preview-subject {
  overflow: hidden;
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--font-size-xs);
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-preview-detail {
  padding-left: 28px;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.tool-preview-pulse {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 20px;
}

.tool-preview-pulse i {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.3;
  animation: tool-preview-pulse 1s ease-in-out infinite;
}

.tool-preview-pulse i:nth-child(2) { animation-delay: 120ms; }
.tool-preview-pulse i:nth-child(3) { animation-delay: 240ms; }

.tool-preview-code-shell {
  position: relative;
  min-width: 0;
  max-height: var(--tool-preview-max-body-height, 168px);
  border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 76%, transparent);
  background: color-mix(in srgb, var(--vscode-textCodeBlock-background) 86%, transparent);
}

.tool-preview-code-scroll {
  max-height: var(--tool-preview-max-body-height, 168px);
  overflow-x: hidden;
  overflow-y: auto;
  scrollbar-width: none;
}

.tool-preview-code-scroll::-webkit-scrollbar { display: none; }

.tool-preview-code-scroll pre {
  width: 100%;
  min-width: 0;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  box-sizing: border-box;
  color: var(--vscode-editor-foreground);
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-editor-font-size, 12px);
  line-height: 1.5;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-preview-markdown {
  min-width: 0;
  padding: var(--space-2) var(--space-3);
  box-sizing: border-box;
  font-size: var(--font-size-sm);
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.tool-preview-caret {
  display: inline-block;
  width: 1px;
  height: 1.05em;
  margin-left: 1px;
  vertical-align: -0.14em;
  background: currentColor;
  animation: tool-preview-caret 0.8s steps(2, end) infinite;
}

@keyframes tool-preview-pulse {
  0%, 70%, 100% { opacity: 0.25; transform: translateY(0); }
  35% { opacity: 0.9; transform: translateY(-2px); }
}

@keyframes tool-preview-caret {
  0%, 45% { opacity: 0.9; }
  46%, 100% { opacity: 0.15; }
}

@media (prefers-reduced-motion: reduce) {
  .tool-preview-card,
  .tool-preview-pulse i,
  .tool-preview-caret { animation: none; }
}
</style>
