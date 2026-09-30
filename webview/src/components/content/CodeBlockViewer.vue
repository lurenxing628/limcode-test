<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { CodeLineHeights, codeLineWindow, codeLineAnchor, codeLineAnchorOffset, syncCodeLineObservers, codeLineColumns } from '@webview/domain/codeLineWindow';
import { IconCheck, IconCopy, IconTextWrap, IconTextWrapDisabled } from '@tabler/icons-vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';

const props = withDefaults(
  defineProps<{
    code: string;
    language?: string;
    info?: string;
  }>(),
  {
    language: '',
    info: ''
  }
);

const scroller = ref<HTMLElement | null>(null);
const softWrap = ref(true);
const copied = ref(false);
let copiedResetTimer: number | undefined;

const normalizedCode = computed(() => props.code.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
const displayText = computed(() => {
  const text = normalizedCode.value;
  return text.endsWith('\n') ? text.slice(0, -1) : text;
});
const lines = computed(() => {
  if (!displayText.value) return [''];
  return displayText.value.split('\n');
});
const languageLabel = computed(() => displayLanguage(props.language, props.info));
const lineNumberWidth = computed(() => `${Math.max(2, String(lines.value.length).length) + 2}ch`);
const refreshKey = computed(() => `${softWrap.value ? 'wrap' : 'nowrap'}:${normalizedCode.value.length}:${lines.value.length}`);

// Only mounted rows are measured. The height index keeps scrolling logarithmic and preserves
// already measured unchanged lines as streamed text is appended.
const heights = shallowRef(new CodeLineHeights(lines.value.length, 19));
const heightRevision = ref(0);
const scrollTop = ref(0);
const viewportHeight = ref(520);
const windowRange = computed(() => {
  void heightRevision.value;
  return codeLineWindow(heights.value, scrollTop.value, viewportHeight.value);
});
const visibleLines = computed(() => lines.value.slice(windowRange.value.start, windowRange.value.end));
// Offscreen long lines must keep the horizontal range available in nowrap mode.
const longestLineColumns = computed(() => lines.value.reduce((max, line) => Math.max(max, codeLineColumns(line)), 0));
const measuredContentWidth = ref(0);
const linesStyle = computed(() => softWrap.value ? undefined : {
  minWidth: `max(100%, calc(${longestLineColumns.value}ch + ${lineNumberWidth.value} + 20px), ${measuredContentWidth.value}px)`
});
let rowObserver: ResizeObserver | undefined;
let viewportObserver: ResizeObserver | undefined;
let frame = 0;
let mounted = false;
let measuredWidth = 0;
const observedRows = new Set<Element>();
let resizeAnchor: ReturnType<typeof codeLineAnchor> | undefined;

function scheduleMeasure(): void {
  if (!mounted || frame) return;
  frame = window.requestAnimationFrame(() => { frame = 0; measureRows(); });
}

function measureRows(): void {
  const element = scroller.value;
  if (!element) return;
  const index = heights.value;
  const top = Math.max(0, element.scrollTop - 6);
  const anchor = resizeAnchor ?? codeLineAnchor(index, top);
  const resizing = resizeAnchor !== undefined;
  resizeAnchor = undefined;
  let changed = false;
  const currentRows = new Set(element.querySelectorAll<HTMLElement>('.lc-code-block-line'));
  syncCodeLineObservers(rowObserver, observedRows, currentRows);
  for (const row of currentRows) { // Measure only this bounded mounted window.
    const position = Number(row.dataset.lineIndex);
    const bounds = row.getBoundingClientRect();
    const height = bounds.height;
    if (!softWrap.value) measuredContentWidth.value = Math.max(measuredContentWidth.value, bounds.width);
    if (height > 0 && Math.abs(index.height(position) - height) > 0.1) {
      index.set(position, height);
      changed = true;
    }
  }
  if (changed || resizing) {
    heightRevision.value++;
    const nextTop = codeLineAnchorOffset(index, anchor) + (element.scrollTop >= 6 ? 6 : 0);
    void nextTick(() => {
      if (!scroller.value || heights.value !== index) return;
      scroller.value.scrollTop = nextTop;
      onScroll();
    });
  }
}

function onScroll(): void {
  if (!scroller.value) return;
  scrollTop.value = Math.max(0, scroller.value.scrollTop - 6);
  viewportHeight.value = scroller.value.clientHeight || 520;
  scheduleMeasure();
}

watch(lines, (current, previous) => {
  measuredContentWidth.value = 0;
  const old = heights.value;
  heights.value = new CodeLineHeights(current.length, 19, (index) =>
    current[index] === previous[index] ? old.height(index) || 19 : 19);
  // Replacement/shrinking content may leave the old scroll position beyond the new end.
  scrollTop.value = Math.min(scrollTop.value, Math.max(0, heights.value.offset(current.length) - viewportHeight.value));
  void nextTick(() => { onScroll(); scheduleMeasure(); });
});
function resetMeasurements(): void {
  resizeAnchor = resizeAnchor ?? codeLineAnchor(heights.value, scrollTop.value);
  heights.value = new CodeLineHeights(lines.value.length, 19);
  scrollTop.value = codeLineAnchorOffset(heights.value, resizeAnchor);
  void nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = scrollTop.value + (scrollTop.value > 0 ? 6 : 0);
    viewportHeight.value = scroller.value?.clientHeight || 520;
    scheduleMeasure();
  });
}
watch(softWrap, resetMeasurements);
watch(() => [windowRange.value.start, windowRange.value.end], () => { void nextTick(scheduleMeasure); });
onMounted(() => {
  mounted = true;
  rowObserver = new ResizeObserver(scheduleMeasure);
  viewportObserver = new ResizeObserver(() => {
    const width = scroller.value?.clientWidth ?? 0;
    if (width !== measuredWidth) {
      measuredWidth = width;
      if (softWrap.value) { resetMeasurements(); return; }
    }
    onScroll();
  });
  if (scroller.value) viewportObserver.observe(scroller.value);
  onScroll();
});

onBeforeUnmount(() => {
  mounted = false;
  rowObserver?.disconnect();
  viewportObserver?.disconnect();
  if (frame) window.cancelAnimationFrame(frame);
  if (copiedResetTimer !== undefined) window.clearTimeout(copiedResetTimer);
});

function toggleWrap(): void {
  softWrap.value = !softWrap.value;
}

async function copyCode(): Promise<void> {
  const ok = await writeClipboard(props.code);
  if (!ok) return;

  copied.value = true;
  if (copiedResetTimer !== undefined) window.clearTimeout(copiedResetTimer);
  copiedResetTimer = window.setTimeout(() => {
    copied.value = false;
    copiedResetTimer = undefined;
  }, 1400);
}

function displayLanguage(language: string | undefined, info: string | undefined): string {
  const raw = (language || firstInfoToken(info) || 'text').trim();
  const normalized = raw
    .replace(/^language-/i, '')
    .replace(/^\./, '')
    .replace(/^\{\.?/, '')
    .replace(/\}$/, '')
    .trim();
  return (normalized || 'text').toUpperCase();
}

function firstInfoToken(info: string | undefined): string {
  const trimmed = info?.trim() ?? '';
  if (!trimmed) return '';
  const classMatch = trimmed.match(/^\{\.?([\w+#.-]+)/);
  return classMatch?.[1] ?? trimmed.split(/\s+/)[0] ?? '';
}

async function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // VS Code Webview / 老环境可能拒绝 Clipboard API，继续尝试 textarea fallback。
    }
  }

  return writeClipboardFallback(text);
}

function writeClipboardFallback(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';

  try {
    document.body.appendChild(textarea);
    textarea.select();
    return document.execCommand('copy');
  } catch (error) {
    console.warn('[LimCode] Failed to copy code block.', error);
    return false;
  } finally {
    textarea.remove();
  }
}
</script>

<template>
  <section class="lc-code-block-viewer" :class="{ 'is-wrap': softWrap, 'is-nowrap': !softWrap }">
    <header class="lc-code-block-header">
      <span class="lc-code-block-language">{{ languageLabel }}</span>
      <div class="lc-code-block-actions">
        <button
          type="button"
          class="lc-code-block-action"
          :aria-pressed="softWrap"
          :aria-label="softWrap ? '当前自动换行，点击切换为不换行' : '当前不换行，点击切换为自动换行'"
          @click="toggleWrap"
        >
          <IconTextWrap v-if="softWrap" class="lc-code-block-action-icon" size="14" stroke="2" aria-hidden="true" />
          <IconTextWrapDisabled v-else class="lc-code-block-action-icon" size="14" stroke="2" aria-hidden="true" />
          <span>{{ softWrap ? '自动换行' : '不换行' }}</span>
        </button>
        <button
          type="button"
          class="lc-code-block-action"
          :aria-label="copied ? '已复制代码' : '复制代码'"
          @click="copyCode"
        >
          <IconCheck v-if="copied" class="lc-code-block-action-icon" size="14" stroke="2" aria-hidden="true" />
          <IconCopy v-else class="lc-code-block-action-icon" size="14" stroke="2" aria-hidden="true" />
          <span>{{ copied ? '已复制' : '复制' }}</span>
        </button>
      </div>
    </header>

    <div class="lc-code-block-body-shell">
      <div
        ref="scroller"
        class="lc-code-block-scroll"
        @scroll.passive="onScroll"
        :style="{ '--lc-code-line-number-width': lineNumberWidth }"
      >
        <div class="lc-code-block-lines" :style="linesStyle" role="list" :aria-label="`${languageLabel} 代码块`">
          <div aria-hidden="true" :style="{ height: `${windowRange.before}px`, flexShrink: 0 }" />
          <div v-for="(line, index) in visibleLines" :key="windowRange.start + index" class="lc-code-block-line"
            :data-line-index="windowRange.start + index" role="listitem" :aria-posinset="windowRange.start + index + 1" :aria-setsize="lines.length">
            <span class="lc-code-block-line-number" aria-hidden="true">{{ windowRange.start + index + 1 }}</span>
            <span class="lc-code-block-line-text">{{ line || ' ' }}</span>
          </div>
          <div aria-hidden="true" :style="{ height: `${windowRange.after}px`, flexShrink: 0 }" />
        </div>
      </div>
      <AdvancedScrollbar
        class="lc-code-block-scrollbar lc-code-block-scrollbar-y"
        :scroller="scroller"
        variant="minimal"
        :refresh-key="refreshKey"
      />
      <AdvancedScrollbar
        class="lc-code-block-scrollbar lc-code-block-scrollbar-x"
        :scroller="scroller"
        variant="minimal"
        orientation="horizontal"
        :refresh-key="refreshKey"
      />
    </div>
  </section>
</template>

<style scoped>
.lc-code-block-viewer {
  margin: 0 0 var(--space-2);
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.24));
  border-radius: var(--radius-sm);
  overflow: hidden;
  color: var(--vscode-foreground);
  background: var(--vscode-textCodeBlock-background, color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%));
  box-sizing: border-box;
}

.lc-code-block-header {
  min-height: 30px;
  padding: 4px 6px 4px 9px;
  border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border, rgba(128, 128, 128, 0.28)) 84%, transparent);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
  box-sizing: border-box;
}

.lc-code-block-language {
  min-width: 0;
  max-width: 45%;
  overflow: hidden;
  color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: var(--font-size-xs);
  font-weight: 600;
  letter-spacing: 0.04em;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lc-code-block-actions {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.lc-code-block-action {
  min-height: 22px;
  min-width: 0;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--vscode-panel-border, rgba(128, 128, 128, 0.26)) 88%, transparent);
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font: inherit;
  font-size: var(--font-size-xs);
  line-height: 1;
  cursor: pointer;
  appearance: none;
}

.lc-code-block-action:hover,
.lc-code-block-action:focus-visible {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 84%, var(--vscode-foreground) 16%));
  outline: none;
}

.lc-code-block-action:focus-visible {
  box-shadow: 0 0 0 1px var(--vscode-focusBorder, currentColor);
}

.lc-code-block-action[aria-pressed='true'] {
  color: var(--vscode-foreground);
  background: color-mix(in srgb, var(--vscode-editor-background) 82%, var(--vscode-foreground) 18%);
}

.lc-code-block-action-icon {
  flex: 0 0 auto;
}

.lc-code-block-body-shell {
  position: relative;
  max-height: min(52vh, 520px);
  min-height: 32px;
  overflow: hidden;
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.lc-code-block-scroll {
  width: 100%;
  max-height: min(52vh, 520px);
  overflow: auto;
  padding: 6px 13px 12px 0;
  box-sizing: border-box;
  overflow-anchor: none;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.lc-code-block-scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.lc-code-block-lines {
  min-width: 100%;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  font-family: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: var(--font-size-xs);
  line-height: 1.55;
  tab-size: 2;
}

.lc-code-block-line {
  min-width: 100%;
  display: grid;
  grid-template-columns: minmax(var(--lc-code-line-number-width), max-content) minmax(0, 1fr);
  align-items: stretch;
}

.lc-code-block-viewer.is-nowrap .lc-code-block-line {
  width: max-content;
  grid-template-columns: minmax(var(--lc-code-line-number-width), max-content) max-content;
}

.lc-code-block-line:hover {
  background: color-mix(in srgb, var(--vscode-foreground) 6%, transparent);
}

.lc-code-block-line-number {
  position: sticky;
  left: 0;
  z-index: 1;
  width: var(--lc-code-line-number-width);
  min-width: var(--lc-code-line-number-width);
  padding: 0 8px;
  border-right: 1px solid color-mix(in srgb, var(--vscode-descriptionForeground) 28%, transparent);
  color: color-mix(in srgb, var(--vscode-descriptionForeground) 78%, transparent);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
  text-align: right;
  white-space: nowrap;
  word-break: keep-all;
  overflow-wrap: normal;
  font-variant-numeric: tabular-nums;
  user-select: none;
  box-sizing: border-box;
}

.lc-code-block-line-text {
  min-width: 0;
  padding: 0 10px;
  color: var(--vscode-foreground);
  box-sizing: border-box;
}

.lc-code-block-viewer.is-wrap .lc-code-block-line-text {
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

.lc-code-block-viewer.is-nowrap .lc-code-block-line-text {
  white-space: pre;
  word-break: normal;
  overflow-wrap: normal;
}

.lc-code-block-viewer :deep(.advanced-scrollbar.lc-code-block-scrollbar) {
  z-index: 3;
}

.lc-code-block-viewer :deep(.advanced-scrollbar.lc-code-block-scrollbar-y) {
  top: 4px;
  right: 2px;
  bottom: 10px;
  width: 8px;
}

.lc-code-block-viewer :deep(.advanced-scrollbar.lc-code-block-scrollbar-x) {
  right: 10px;
  bottom: 1px;
  left: 2px;
  height: 7px;
}

.lc-code-block-viewer :deep(.lc-code-block-scrollbar .scroll-thumb) {
  background: color-mix(in srgb, var(--vscode-foreground) 42%, transparent);
}

.lc-code-block-viewer :deep(.lc-code-block-scrollbar .scroll-thumb:hover),
.lc-code-block-viewer :deep(.lc-code-block-scrollbar.is-dragging .scroll-thumb) {
  background: color-mix(in srgb, var(--vscode-foreground) 66%, transparent);
}

@media (max-width: 460px) {
  .lc-code-block-action span {
    display: none;
  }

  .lc-code-block-action {
    width: 24px;
    justify-content: center;
    padding: 0;
  }
}
</style>
