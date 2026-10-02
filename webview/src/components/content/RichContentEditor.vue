<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AdvancedScrollbar from '@webview/components/navigation/AdvancedScrollbar.vue';
import { bridge, BridgeMessageType } from '@webview/transport';
import type { FsStatResultPayload } from '@shared/protocol';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string;
    disabled?: boolean;
    rows?: number;
    /** 按 Enter（不含 Shift）是否触发 submit。Shift+Enter 始终换行。 */
    submitOnEnter?: boolean;
  }>(),
  { placeholder: '', disabled: false, rows: 2, submitOnEnter: true }
);

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void;
  (event: 'submit'): void;
  (event: 'paste-files', files: File[]): void;
}>();

const textarea = ref<HTMLTextAreaElement | null>(null);
const scrollbarRefreshKey = ref(0);
const pathDragActive = ref(false);

const focusRecoveryDelays = [80, 180] as const;
const focusVerificationDelays = [140] as const;
let lastTextareaPointerDownAt = 0;
let lastTextareaPointerDownFromBlurredWindow = false;
let focusRecoveryTimers: number[] = [];
let focusIntentRevision = 0;

const value = computed({
  get: () => props.modelValue,
  set: (next: string) => emit('update:modelValue', next)
});

watch(
  () => [props.modelValue, props.rows, props.disabled],
  () => queueScrollbarRefresh(),
  { flush: 'post' }
);

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown, true);
  document.addEventListener('pointermove', onOutsidePointerMove, true);
  document.addEventListener('focusin', onDocumentFocusIn, true);
  document.addEventListener('keydown', onFocusNavigation, true);
  window.addEventListener('blur', invalidateFocusRestore);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerDown, true);
  document.removeEventListener('pointermove', onOutsidePointerMove, true);
  document.removeEventListener('focusin', onDocumentFocusIn, true);
  document.removeEventListener('keydown', onFocusNavigation, true);
  window.removeEventListener('blur', invalidateFocusRestore);
  invalidateFocusRestore();
  clearFocusRecoveryTimers();
});

function onDocumentPointerDown(event: PointerEvent): void {
  const control = textarea.value;
  if (!control) return;
  if (event.target instanceof Node && control.contains(event.target)) return;

  invalidateFocusRestore();
  // 用户在焦点恢复窗口内再次点击输入框外时，说明明确想退出输入模式，必须取消补 focus。
  lastTextareaPointerDownAt = 0;
  lastTextareaPointerDownFromBlurredWindow = false;
  clearFocusRecoveryTimers();
}

function invalidateFocusRestore(): void { focusIntentRevision += 1; }

function onOutsidePointerMove(event: PointerEvent): void {
  if (event.target instanceof Node && textarea.value?.contains(event.target)) return;
  invalidateFocusRestore();
}

function onDocumentFocusIn(event: FocusEvent): void {
  if (event.target === textarea.value || event.target === document.body || event.target === document.documentElement) return;
  invalidateFocusRestore();
}

function onFocusNavigation(event: KeyboardEvent): void {
  if (event.key === 'Tab' || event.key === 'Escape' || event.ctrlKey || event.metaKey) invalidateFocusRestore();
}

function onTextareaPointerDown(): void {
  if (props.disabled) return;
  lastTextareaPointerDownFromBlurredWindow = !document.hasFocus();
  lastTextareaPointerDownAt = performance.now();
  if (lastTextareaPointerDownFromBlurredWindow) scheduleTextareaFocusRecovery(focusRecoveryDelays);
}

function onTextareaFocus(): void {
  if (props.disabled || performance.now() - lastTextareaPointerDownAt > 800) return;
  if (!lastTextareaPointerDownFromBlurredWindow) {
    clearFocusRecoveryTimers();
    return;
  }
  scheduleTextareaFocusRecovery(focusVerificationDelays);
}

function scheduleTextareaFocusRecovery(delays: readonly number[]): void {
  clearFocusRecoveryTimers();
  for (const delay of delays) {
    const timer = window.setTimeout(recoverTextareaFocus, delay);
    focusRecoveryTimers.push(timer);
  }
}

function recoverTextareaFocus(): void {
  if (props.disabled || performance.now() - lastTextareaPointerDownAt > 800) return;
  if (!lastTextareaPointerDownFromBlurredWindow || !document.hasFocus()) return;
  const control = textarea.value;
  if (!control || document.activeElement === control) return;

  // VS Code 窗口从失焦状态被首次点击激活时，Webview 里的 textarea 可能会先 focus 再被宿主抢回焦点。
  // 只在焦点掉回 body/html 时补一次 focus，避免用户随后点击其它按钮时被输入框反抢焦点。
  const activeElement = document.activeElement;
  if (activeElement && activeElement !== document.body && activeElement !== document.documentElement) return;
  control.focus({ preventScroll: true });
}

function clearFocusRecoveryTimers(): void {
  for (const timer of focusRecoveryTimers) window.clearTimeout(timer);
  focusRecoveryTimers = [];
}

function onKeydown(event: KeyboardEvent): void {
  if (props.submitOnEnter && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    emit('submit');
  }
}

function onPaste(event: ClipboardEvent): void {
  const files = collectPastedFiles(event.clipboardData);
  if (files.length > 0) {
    event.preventDefault();
    emit('paste-files', files);
  }
}

function onDragOver(event: DragEvent): void {
  if (props.disabled || !hasDragData(event.dataTransfer)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  pathDragActive.value = true;
}

function onDragLeave(event: DragEvent): void {
  if (!event.currentTarget || !event.relatedTarget) {
    pathDragActive.value = false;
    return;
  }
  const current = event.currentTarget as HTMLElement;
  const related = event.relatedTarget as Node;
  if (!current.contains(related)) pathDragActive.value = false;
}

function onDrop(event: DragEvent): void {
  if (props.disabled) return;
  pathDragActive.value = false;

  const dragPayload = extractDragPayload(event.dataTransfer);
  if (dragPayload.length === 0) return;

  event.preventDefault();
  event.stopPropagation();

  const messageId = bridge.request(BridgeMessageType.FsStatGet, { paths: dragPayload });
  bridge.on(BridgeMessageType.FsStatResult, (message) => {
    if (message.correlationId !== messageId) return;
    const mentionText = formatMentionsFromStat(message.payload);
    if (mentionText) insertTextAtSelection(mentionText);
  });
}

function hasDragData(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false;
  if ((dataTransfer.files?.length ?? 0) > 0) return true;
  return (dataTransfer.types?.length ?? 0) > 0;
}

function extractDragPayload(dataTransfer: DataTransfer | null): string[] {
  if (!dataTransfer) return [];

  const payload: string[] = [];

  for (const file of Array.from(dataTransfer.files ?? [])) {
    const path = (file as File & { path?: string }).path;
    if (path) payload.push(path);
  }

  for (const type of Array.from(dataTransfer.types ?? [])) {
    if (type === 'Files') continue;
    try {
      const raw = dataTransfer.getData(type).trim();
      if (raw) payload.push(raw);
    } catch {
      // ignore
    }
  }

  return payload;
}

function formatMentionsFromStat(payload: FsStatResultPayload | undefined): string {
  if (!payload?.results) return '';
  const mentions = payload.results
    .filter((result) => result.exists)
    .map((result) => ` @${result.path}${result.isDirectory ? '/' : ''} `);
  return mentions.join(mentions.length > 1 ? '\n' : ' ');
}

function collectPastedFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length > 0) return files;
  return Array.from(data.files ?? []);
}

function queueScrollbarRefresh(): void {
  void nextTick(() => {
    scrollbarRefreshKey.value += 1;
  });
}

function insertTextAtSelection(text: string): void {
  const control = textarea.value;
  const current = props.modelValue;
  const start = control?.selectionStart ?? current.length;
  const end = control?.selectionEnd ?? start;
  const before = current.slice(0, start);
  const after = current.slice(end);
  const insertion = withInsertionSpacing(before, after, text);
  const nextValue = `${before}${insertion}${after}`;
  const nextCursor = before.length + insertion.length;

  emit('update:modelValue', nextValue);
  queueScrollbarRefresh();
  void nextTick(() => {
    control?.focus();
    control?.setSelectionRange(nextCursor, nextCursor);
  });
}

function withInsertionSpacing(before: string, after: string, text: string): string {
  const multiline = text.includes('\n');
  const prefix = before.length > 0 && !/\s$/.test(before) ? (multiline ? '\n' : ' ') : '';
  const suffix = after.length > 0 && !/^\s/.test(after) ? (multiline ? '\n' : ' ') : '';
  return `${prefix}${text}${suffix}`;
}

function focus(): void {
  textarea.value?.focus();
}

/** A submit may temporarily disable (and blur) this input. Restore only its unchanged focus intent. */
function captureFocusRestore(): (() => void) | undefined {
  const control = textarea.value;
  if (!control || props.disabled || document.activeElement !== control || !document.hasFocus()) return undefined;
  const revision = ++focusIntentRevision;
  let consumed = false;
  return () => {
    if (consumed) return;
    consumed = true;
    if (revision !== focusIntentRevision || textarea.value !== control || !control.isConnected
      || props.disabled || control.disabled || !document.hasFocus()) return;
    const active = document.activeElement;
    if (active && active !== control && active !== document.body && active !== document.documentElement) return;
    control.focus({ preventScroll: true });
  };
}

defineExpose({ focus, captureFocusRestore });
</script>

<template>
  <div class="rich-editor" :class="{ 'is-disabled': disabled, 'is-path-drag-active': pathDragActive }" @dragover="onDragOver" @dragleave="onDragLeave" @drop="onDrop">
    <textarea
      ref="textarea"
      v-model="value"
      class="rich-editor-control"
      :rows="rows"
      :placeholder="placeholder"
      :disabled="disabled"
      @pointerdown.capture="onTextareaPointerDown"
      @focus="onTextareaFocus"
      @keydown="onKeydown"
      @input="queueScrollbarRefresh"
      @paste="onPaste"
    ></textarea>
    <AdvancedScrollbar
      class="rich-editor-scrollbar"
      :scroller="textarea"
      :refresh-key="scrollbarRefreshKey"
      :show-markers="false"
      :show-edge-buttons="false"
      :show-marker-preview="false"
    />
  </div>
</template>

<style scoped>
.rich-editor {
  position: relative;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  overflow: hidden;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: var(--radius-md);
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
}

.rich-editor:focus-within {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}

.rich-editor.is-disabled {
  opacity: 0.6;
}

.rich-editor.is-path-drag-active {
  border-color: color-mix(in srgb, var(--vscode-input-foreground, var(--vscode-foreground)) 44%, transparent);
  background: color-mix(in srgb, var(--vscode-input-background) 88%, var(--vscode-input-foreground, var(--vscode-foreground)) 12%);
}

.rich-editor-control {
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  min-height: 0;
  box-sizing: border-box;
  resize: none;
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  line-height: inherit;
  padding: var(--space-2) calc(var(--space-2) + 9px) var(--space-2) var(--space-2);
  overflow-y: auto;
  scrollbar-width: none;
}

.rich-editor-control::-webkit-scrollbar {
  width: 0;
  height: 0;
  display: none;
}

.rich-editor-control::placeholder {
  color: var(--vscode-input-placeholderForeground);
}

.rich-editor :deep(.advanced-scrollbar.rich-editor-scrollbar) {
  top: 4px;
  right: 3px;
  bottom: 4px;
  width: 14px;
  z-index: 2;
  opacity: 0.72;
}

.rich-editor :deep(.advanced-scrollbar.rich-editor-scrollbar.is-hidden) {
  opacity: 0;
  pointer-events: none;
}

.rich-editor :deep(.rich-editor-scrollbar .scroll-track) {
  min-height: 24px;
  border-color: transparent;
  background: transparent;
}

.rich-editor :deep(.rich-editor-scrollbar .scroll-thumb) {
  left: 4px;
  right: 4px;
  min-height: 20px;
  border: 0;
  background: color-mix(in srgb, var(--vscode-input-foreground, var(--vscode-foreground)) 42%, transparent);
}

.rich-editor :deep(.rich-editor-scrollbar .scroll-thumb:hover),
.rich-editor :deep(.rich-editor-scrollbar.is-dragging .scroll-thumb) {
  background: color-mix(in srgb, var(--vscode-input-foreground, var(--vscode-foreground)) 62%, transparent);
}
</style>
