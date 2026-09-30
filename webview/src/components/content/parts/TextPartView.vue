<script setup lang="ts">
import { computed, onBeforeUnmount, shallowRef, watch } from 'vue';
import { LOCAL_FILE_LINK_DATA_ATTRIBUTE } from '@shared/localFileResources';
import { BridgeMessageType } from '@shared/protocol';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { bridge } from '@webview/transport';
import CodeBlockViewer from '../CodeBlockViewer.vue';
import StreamingIndicatorTail from '../StreamingIndicatorTail.vue';
import { useSmoothStreamingText } from '../useSmoothStreamingText';
import { createStreamingMarkdownPartsRenderer, type MarkdownRenderedPart } from '../markdown/markdownRenderer';

const props = withDefaults(
  defineProps<{
    text: string;
    streaming?: boolean;
    streamingPhase?: 'waiting' | 'thinking' | 'writing';
    showStreamingIndicator?: boolean;
    markdown?: boolean;
    preserveSoftBreaks?: boolean;
  }>(),
  { streaming: false, streamingPhase: 'writing', showStreamingIndicator: true, markdown: false, preserveSoftBreaks: false }
);

const globalSettings = useGlobalSettingsStore();

const tailText = computed(() => {
  switch (props.streamingPhase) {
    case 'waiting': return globalSettings.appearance.streamingTextWaiting;
    case 'thinking': return globalSettings.appearance.streamingTextThinking;
    case 'writing': return globalSettings.appearance.streamingTextWriting;
  }
});

const { displayedText, replacing: replaceAnimating } = useSmoothStreamingText(
  () => props.text,
  () => props.streaming,
  { animateReplace: true, flushLagChars: 2_048 }
);
const renderedParts = shallowRef<MarkdownRenderedPart[]>([]);
const keyedRenderedParts = computed(() => {
  let codeOrdinal = 0;
  return renderedParts.value.map((part, index) => ({
    part,
    // Streaming may split HTML into several prefix fragments that final parsing combines.
    // A code viewer belongs to its code-block ordinal, independent of those HTML fragments.
    key: part.kind === 'code' ? `code-${codeOrdinal++}` : `html-${index}`
  }));
});
const streamingMarkdownRenderer = createStreamingMarkdownPartsRenderer();
const DEFERRED_FINAL_MARKDOWN_CHARACTERS = 16 * 1024;
let deferredMarkdownFirstFrame: number | undefined;
let deferredMarkdownSecondFrame: number | undefined;
let markdownRenderGeneration = 0;
let hasRenderedStreamingMarkdown = false;
// Streaming Markdown follows displayedText synchronously; only a large, already-final historical
// body yields one paint so its readable plain-text fallback appears before rich parsing.
const markdownReady = computed(() => props.markdown);

watch(
  () => [displayedText.value, props.streaming, props.markdown, props.preserveSoftBreaks] as const,
  () => renderCurrentMarkdown(),
  { immediate: true }
);
onBeforeUnmount(() => cancelDeferredMarkdownRender());

function renderCurrentMarkdown(): void {
  const generation = cancelDeferredMarkdownRender();
  if (!markdownReady.value) {
    streamingMarkdownRenderer.reset();
    renderedParts.value = [];
    hasRenderedStreamingMarkdown = false;
    return;
  }

  // A historical body arrives atomically. Paint its plain text first so a long final Markdown parse
  // cannot keep the tail row blank for another frame; rich formatting replaces it after that paint.
  const effectivelyStreaming = props.streaming || displayedText.value !== props.text;
  // A part that already rendered during a stream owns live code viewers. Keep those children
  // mounted when the stream finishes, including any final bytes flushed by the smoothing layer.
  if (!effectivelyStreaming && !hasRenderedStreamingMarkdown
    && displayedText.value.length >= DEFERRED_FINAL_MARKDOWN_CHARACTERS) {
    streamingMarkdownRenderer.reset();
    renderedParts.value = [];
    deferredMarkdownFirstFrame = window.requestAnimationFrame(() => {
      deferredMarkdownFirstFrame = undefined;
      deferredMarkdownSecondFrame = window.requestAnimationFrame(() => {
        deferredMarkdownSecondFrame = undefined;
        if (generation !== markdownRenderGeneration) return;
        renderMarkdownNow(false);
      });
    });
    return;
  }

  renderMarkdownNow(effectivelyStreaming);
}

function renderMarkdownNow(effectivelyStreaming: boolean): void {
  try {
    // 流中按增量尾块解析；terminal 会先同步完整 displayedText，再写入权威整文缓存。
    renderedParts.value = streamingMarkdownRenderer.render(displayedText.value, {
      streaming: effectivelyStreaming,
      preserveSoftBreaks: props.preserveSoftBreaks
    });
    if (props.streaming && renderedParts.value.length > 0) hasRenderedStreamingMarkdown = true;
  } catch (error) {
    streamingMarkdownRenderer.reset();
    console.warn('[LimCode] Failed to render markdown.', error);
    renderedParts.value = [];
    hasRenderedStreamingMarkdown = false;
  }
}

function cancelDeferredMarkdownRender(): number {
  markdownRenderGeneration += 1;
  if (deferredMarkdownFirstFrame !== undefined) {
    window.cancelAnimationFrame(deferredMarkdownFirstFrame);
    deferredMarkdownFirstFrame = undefined;
  }
  if (deferredMarkdownSecondFrame !== undefined) {
    window.cancelAnimationFrame(deferredMarkdownSecondFrame);
    deferredMarkdownSecondFrame = undefined;
  }
  return markdownRenderGeneration;
}

function handleMarkdownClick(event: MouseEvent): void {
  const element = event.target instanceof Element ? event.target : undefined;
  const link = element?.closest(`a[${LOCAL_FILE_LINK_DATA_ATTRIBUTE}]`);
  const source = link?.getAttribute(LOCAL_FILE_LINK_DATA_ATTRIBUTE)?.trim();
  if (!source) return;
  event.preventDefault();
  event.stopPropagation();
  bridge.request(BridgeMessageType.LocalFileOpen, { source });
}
</script>

<template>
  <div v-if="markdownReady" class="rc-markdown-shell" :class="{ streaming, replacing: replaceAnimating }">
    <template v-if="renderedParts.length">
      <template v-for="{ part, key } in keyedRenderedParts" :key="key">
        <div v-if="part.kind === 'html'" class="rc-markdown" v-html="part.html" @click="handleMarkdownClick"></div>
        <CodeBlockViewer v-else class="rc-code-block" :code="part.code" :language="part.language" :info="part.info" />
      </template>
    </template>
    <pre v-else class="rc-text">{{ displayedText }}</pre>
    <StreamingIndicatorTail v-if="streaming && showStreamingIndicator" :text="tailText" :variant="streamingPhase" />
  </div>
  <pre v-else class="rc-text" :class="{ replacing: replaceAnimating }">{{ displayedText }}<StreamingIndicatorTail v-if="streaming && showStreamingIndicator" :text="tailText" :variant="streamingPhase" /></pre>
</template>

<style scoped>
.rc-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
}

.rc-text,
.rc-markdown,
.rc-code-block {
  transition: opacity var(--lc-content-replace-duration) ease-out, transform var(--lc-content-replace-duration) ease-out;
}

.rc-text.replacing,
.rc-markdown-shell.replacing .rc-text,
.rc-markdown-shell.replacing .rc-markdown,
.rc-markdown-shell.replacing .rc-code-block {
  opacity: 0;
  transform: translateY(-3px);
}

.rc-markdown-shell {
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.rc-markdown {
  min-width: 0;
}

.rc-markdown :deep(.katex) {
  color: var(--vscode-foreground);
  font-size: 1em;
}

.rc-markdown :deep(eq) {
  display: inline-block;
  max-width: 100%;
  vertical-align: -0.08em;
}

.rc-markdown :deep(eqn) {
  display: block;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 2px 0;
}

.rc-markdown :deep(eqn .katex-display) {
  margin: 0.35em 0;
}

.rc-markdown :deep(section.eqno) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  max-width: 100%;
}

.rc-markdown :deep(section.eqno > eqn) {
  flex: 1 1 auto;
  min-width: 0;
}

.rc-markdown :deep(section.eqno > span) {
  flex: 0 0 auto;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}

.rc-markdown :deep(.katex-error) {
  color: var(--vscode-errorForeground, #f14c4c);
}

.rc-markdown:not(:last-child) {
  margin-bottom: var(--space-2);
}

.rc-code-block:last-child {
  margin-bottom: 0;
}

.rc-markdown :deep(p),
.rc-markdown :deep(ul),
.rc-markdown :deep(ol),
.rc-markdown :deep(pre),
.rc-markdown :deep(blockquote),
.rc-markdown :deep(table) {
  margin-top: 0;
  margin-bottom: var(--space-2);
}

.rc-markdown :deep(:last-child) {
  margin-bottom: 0;
}

.rc-markdown :deep(ul),
.rc-markdown :deep(ol) {
  padding-left: var(--space-5);
}

.rc-markdown :deep(li + li) {
  margin-top: 2px;
}

.rc-markdown :deep(blockquote) {
  margin-left: 0;
  margin-right: 0;
  padding: 2px 0 2px var(--space-3);
  border-left: 3px solid color-mix(in srgb, var(--vscode-descriptionForeground) 58%, transparent);
  color: var(--vscode-descriptionForeground);
  text-align: left;
}

.rc-markdown :deep(blockquote p) {
  text-align: left;
}

.rc-markdown :deep(pre) {
  max-width: 100%;
  overflow: auto;
  padding: var(--space-2);
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.18));
  border-radius: var(--radius-sm);
  background: var(--vscode-textCodeBlock-background, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
}

.rc-markdown :deep(code) {
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 0.95em;
}

.rc-markdown :deep(pre code) {
  padding: 0;
  border-radius: 0;
  background: transparent;
}

.rc-markdown :deep(a) {
  color: var(--vscode-textLink-foreground);
}

.rc-markdown :deep(table) {
  display: block;
  max-width: 100%;
  overflow: auto;
  border-collapse: collapse;
}

.rc-markdown :deep(th),
.rc-markdown :deep(td) {
  padding: 4px 7px;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.22));
}

.rc-markdown :deep(img) {
  display: block;
  width: auto;
  max-width: min(100%, 50vw);
  max-height: 50vh;
  height: auto;
  object-fit: contain;
}
</style>
