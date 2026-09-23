<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { IconBulb } from '@tabler/icons-vue';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import StreamingIndicatorTail from '../StreamingIndicatorTail.vue';
import { renderInlineMarkdown } from '../markdown/markdownRenderer';
import { useSmoothStreamingText } from '../useSmoothStreamingText';
import CollapsibleContentBlock from '../CollapsibleContentBlock.vue';
import TextPartView from './TextPartView.vue';
import {
  THOUGHT_TIMER_REFRESH_INTERVAL_MS,
  formatThoughtDuration,
  liveThoughtDurationMs
} from '../thoughtTiming';

const props = withDefaults(
  defineProps<{
    text: string;
    streaming?: boolean;
    streamingPhase?: 'waiting' | 'thinking' | 'writing';
    durationMs?: number;
    completedDurationMs?: number;
    elapsedMs?: number;
    startedAt?: number;
  }>(),
  { streaming: false, streamingPhase: 'thinking' }
);

const globalSettings = useGlobalSettingsStore();
const expanded = ref(false);
const clockNow = ref(Date.now());
let refreshTimer: ReturnType<typeof setInterval> | undefined;
const { displayedText } = useSmoothStreamingText(
  () => props.text,
  () => props.streaming
);
// 思考结束但没有文字：模型只返回了签名（例如 Claude adaptive 思考省略了内容），不能一直显示“正在思考”。
const EMPTY_THOUGHT_LABEL = '模型没有返回思考内容';
const preview = computed(() => lastNonEmptyLine(displayedText.value) || (props.streaming ? '正在思考...' : EMPTY_THOUGHT_LABEL));
const previewHtml = computed(() => renderInlineMarkdown(preview.value));
const liveDurationMs = computed(() => liveThoughtDurationMs({
  completedDurationMs: props.completedDurationMs,
  elapsedMs: props.elapsedMs,
  startedAt: props.startedAt
}, clockNow.value));
const tailText = computed(() => {
  if (props.streaming) {
    const hasTiming = typeof props.startedAt === 'number'
      || typeof props.elapsedMs === 'number'
      || typeof props.completedDurationMs === 'number';
    return hasTiming
      ? `思考了 ${formatThoughtDuration(liveDurationMs.value)}`
      : '思考中';
  }
  return props.durationMs !== undefined ? `已思考 ${formatThoughtDuration(props.durationMs)}` : '思考完成';
});

watch(
  () => [props.streaming, props.startedAt] as const,
  () => syncRefreshTimer(),
  { immediate: true }
);
onBeforeUnmount(() => stopRefreshTimer());

function syncRefreshTimer(): void {
  stopRefreshTimer();
  clockNow.value = Date.now();
  if (!props.streaming || typeof props.startedAt !== 'number' || !Number.isFinite(props.startedAt)) return;
  refreshTimer = setInterval(() => {
    clockNow.value = Date.now();
  }, THOUGHT_TIMER_REFRESH_INTERVAL_MS);
}

function stopRefreshTimer(): void {
  if (refreshTimer === undefined) return;
  clearInterval(refreshTimer);
  refreshTimer = undefined;
}

function lastNonEmptyLine(text: string): string {
  let end = text.length;
  while (end > 0 && /\s/.test(text.charAt(end - 1))) end -= 1;
  if (end <= 0) return '';

  let lineEnd = end;
  while (lineEnd > 0) {
    let lineStart = lineEnd;
    while (lineStart > 0 && text.charAt(lineStart - 1) !== '\n' && text.charAt(lineStart - 1) !== '\r') lineStart -= 1;
    const line = text.slice(lineStart, lineEnd).trim();
    if (line) return line;
    lineEnd = lineStart;
    while (lineEnd > 0 && (text.charAt(lineEnd - 1) === '\n' || text.charAt(lineEnd - 1) === '\r')) lineEnd -= 1;
  }
  return '';
}

</script>

<template>
  <CollapsibleContentBlock
    v-model:expanded="expanded"
    class="thought-panel"
    :class="{ 'is-streaming': streaming }"
    kind="input"
    :icon-active="streaming"
    :aria-label="expanded ? '收起思考内容' : '展开思考内容'"
  >
    <template #icon>
      <IconBulb stroke="2" aria-hidden="true" />
    </template>
    <template #summary>
      <span class="thought-preview" v-html="previewHtml"></span>
    </template>
    <template #trail>
      <span class="thought-tail">{{ tailText }}</span>
    </template>

    <!-- 折叠时不渲染完整 Markdown；展开后由正文组件直接消费原始流，不能把预览的平滑帧误当成最终文本替换。 -->
    <TextPartView
      v-if="expanded"
      class="thought-content"
      :text="text"
      :streaming="streaming"
      streaming-phase="thinking"
      markdown
      preserve-soft-breaks
      :show-streaming-indicator="false"
    />
  </CollapsibleContentBlock>
  <div v-if="streaming" class="thought-streaming-row"><StreamingIndicatorTail :text="globalSettings.appearance.streamingTextThinking" variant="thinking" /></div>
</template>

<style scoped>
.thought-panel {
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  min-width: 0;
}

.thought-preview {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-style: italic;
}

.thought-tail {
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
}

.thought-content {
  margin: 3px 0 0;
  padding: 8px 10px;
  border-left: 2px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.32));
  color: var(--vscode-descriptionForeground);
  background: var(--lc-content-input-background);
  word-break: break-word;
  overflow-wrap: anywhere;
  font: inherit;
  font-style: italic;
  line-height: 1.5;
}

.thought-streaming-row {
  margin-top: 4px;
  font-style: italic;
}
</style>
