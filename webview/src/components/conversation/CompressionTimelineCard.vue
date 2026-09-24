<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { IconCheck, IconChevronRight, IconCopy, IconEye, IconRefresh, IconTrash, IconPlayerPause, IconPlayerPlay } from '@tabler/icons-vue';
import {
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  isInlineDataPart,
  isProviderContextPart,
  isTextPart,
  type CompressionBlockRecord,
  type ContentPart,
  type LlmInvocationRecord,
  type MessageContent
} from '@shared/protocol';
import { compressionProviderContents } from '@shared/compressionPresentation';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';
import { useClientStateStore } from '@webview/stores/useClientStateStore';
import CompressionRetryStatus from './CompressionRetryStatus.vue';

const props = defineProps<{
  block: CompressionBlockRecord;
  phase?: 'stable' | 'entering' | 'exiting';
}>();

const emit = defineEmits<{
  (event: 'delete', block: CompressionBlockRecord): void;
  (event: 'regenerate', block: CompressionBlockRecord): void;
  (event: 'toggle-enabled', block: CompressionBlockRecord, enabled: boolean): void;
  (event: 'view-detail', block: CompressionBlockRecord): void;
}>();

const clientState = useClientStateStore();

const expanded = ref(false);
const confirmDeleteOpen = ref(false);
const copied = ref(false);
let copiedResetTimer: number | undefined;

const methodLabel = computed(() => {
  switch (props.block.methodKind) {
    case 'provider_native': return 'Provider 原生压缩';
    case 'llm_summary': return 'LLM 总结';
    case 'segmented_summary': return '分段总结拼接';
    case 'deterministic_summary': return '确定性摘要';
    case 'manual_summary': return '手动摘要';
    case 'disabled': return '已关闭';
  }
});

const statusLabel = computed(() => {
  if (props.block.status === 'running') {
    if (compressionInvocation.value?.retryStatus === 'scheduled') return '等待重试';
    if (compressionInvocation.value?.retryStatus === 'retrying') return '重试中';
  }
  switch (props.block.status) {
    case 'pending': return '等待中';
    case 'running': return '压缩中';
    case 'complete': return compressionInvocation.value?.retryStatus === 'recovered' ? '重试完成' : '可用';
    case 'error': return compressionInvocation.value?.retryStatus === 'exhausted' ? '重试失败' : '失败';
    case 'stale': return '已失效';
    case 'disabled': return '已禁用';
  }
});

const rangeLabel = computed(() => {
  if (props.block.startSeq === undefined || props.block.endSeq === undefined) return undefined;
  return `覆盖 ${props.block.sourceMessageCount ?? 0} 条消息`;
});

const tokenSavedLabel = computed(() => {
  if (props.block.tokenSaved === undefined) return undefined;
  return `节省约 ${formatCompactNumber(props.block.tokenSaved)} Token`;
});

const compressionInvocation = computed<LlmInvocationRecord | undefined>(() => {
  const link = clientState.compressionBlockLlmInvocationLinks
    .filter((candidate) => candidate.blockId === props.block.id)
    .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))[0];
  return link ? clientState.llmInvocations.find((invocation) => invocation.id === link.invocationId) : undefined;
});
const retryActive = computed(() => compressionInvocation.value?.retryStatus === 'scheduled' || compressionInvocation.value?.retryStatus === 'retrying');
const showRetryStatus = computed(() => !!compressionInvocation.value?.retryStatus && props.block.status !== 'stale' && props.block.status !== 'disabled');
const isWorking = computed(() => props.block.status === 'pending' || props.block.status === 'running' || retryActive.value);
const previewText = computed(() => {
  const retryStatus = compressionInvocation.value?.retryStatus;
  if (retryStatus === 'scheduled') return retryPreviewText('上次压缩请求报错，正在等待自动重试');
  if (retryStatus === 'retrying') return retryPreviewText('上次压缩请求报错，正在自动重试压缩');
  if (props.block.summaryPreview?.trim()) return props.block.summaryPreview.trim();
  if (props.block.status === 'pending') return '已创建压缩占位，等待开始生成摘要...';
  if (props.block.status === 'running') return '正在压缩上下文，摘要生成后会显示在这里...';
  if (props.block.status === 'error') return props.block.error || '压缩失败。';
  if (props.block.status === 'stale') return props.block.staleReason || '该压缩块已失效。';
  return '';
});
const blockVariants = computed(() => clientState.compressionContextVariants.filter((variant) => variant.blockId === props.block.id));
const summaryVariant = computed(() => blockVariants.value.find((variant) => variant.kind === 'provider_neutral_summary') ?? blockVariants.value[0]);
const providerSummaryContents = computed(() => {
  const variant = summaryVariant.value;
  if (!variant) return [];
  return compressionProviderContents({
    blockId: props.block.id,
    canonicalContents: variant.contents,
    projections: clientState.modelContextProjections,
    compressionLinks: clientState.compressionModelContextProjectionLinks
  }) ?? [];
});
const copyText = computed(() => {
  const variantText = providerSummaryContents.value.map(renderContent).filter(Boolean).join('\n\n').trim();
  return variantText || props.block.summaryPreview?.trim() || previewText.value.trim();
});



const deleteActions: ConfirmPanelAction[] = [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'confirm', label: '删除' }
];

onBeforeUnmount(() => {
  if (copiedResetTimer !== undefined) window.clearTimeout(copiedResetTimer);
});

function onDeleteAction(action: ConfirmPanelAction): void {
  confirmDeleteOpen.value = false;
  if (action.key === 'confirm' && !isWorking.value) emit('delete', props.block);
}

function toggleExpanded(): void {
  expanded.value = !expanded.value;
}

async function copyCompressionContent(): Promise<void> {
  const text = copyText.value;
  if (!text) return;
  const ok = await writeClipboard(text);
  if (!ok) return;
  copied.value = true;
  if (copiedResetTimer !== undefined) window.clearTimeout(copiedResetTimer);
  copiedResetTimer = window.setTimeout(() => {
    copied.value = false;
    copiedResetTimer = undefined;
  }, 1400);
}

async function writeClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fallback below
    }
  }
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
  } finally {
    textarea.remove();
  }
}

function renderContent(content: MessageContent): string {
  return content.parts.map(renderPart).filter(Boolean).join('\n');
}

function renderPart(part: ContentPart): string {
  if (isTextPart(part)) return part.thought === true ? '' : part.text;
  if (isFunctionCallPart(part)) return `[tool call] ${part.functionCall.name}: ${safeJson(part.functionCall.args)}`;
  if (isFunctionResponsePart(part)) return `[tool result] ${part.functionResponse.name}: ${safeJson(part.functionResponse.response)}`;
  if (isInlineDataPart(part)) return `[inline data] ${part.inlineData.mimeType}`;
  if (isFileDataPart(part)) return `[file] ${part.fileData.uri}`;
  if (isProviderContextPart(part)) return `[渠道专用上下文] ${part.providerContext.format}:${part.providerContext.itemType ?? 'context'}`;
  return '';
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

function retryPreviewText(prefix: string): string {
  const invocation = compressionInvocation.value;
  const attempt = formatRetryAttempt(invocation?.retryAttempt, invocation?.retryMaxAttempts);
  const suffix = attempt ? `（${attempt}）` : '';
  return `${prefix}${suffix}...`;
}

function formatRetryAttempt(attempt: number | undefined, max: number | undefined): string {
  if (attempt === undefined) return '';
  if (max === -1) return `第 ${attempt}/∞ 次`;
  if (max !== undefined) return `第 ${attempt}/${max} 次`;
  return `第 ${attempt} 次`;
}
</script>

<template>
  <div class="compression-card" :class="[`status-${block.status}`, phase === 'entering' ? 'entering' : '', phase === 'exiting' ? 'exiting' : '']">
    <button type="button" class="compression-main" @click="toggleExpanded">
      <IconChevronRight
        class="compression-chevron lc-collapse-chevron"
        :class="{ 'is-expanded': expanded }"
        stroke="2"
        aria-hidden="true"
      />
      <span class="compression-icon" :class="{ 'is-working': isWorking }" aria-hidden="true">
        <svg class="compression-symbol" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
          <path class="compression-symbol-top" d="M5 5h14l-7 6z" />
          <path class="compression-symbol-bottom" d="M5 19h14l-7 -6z" />
        </svg>
      </span>
      <span class="compression-body">
        <span class="compression-title">{{ block.title || '上下文已压缩' }}</span>
        <span class="compression-meta">
          <span>{{ methodLabel }}</span>
          <span v-if="rangeLabel">{{ rangeLabel }}</span>
          <span v-if="tokenSavedLabel">{{ tokenSavedLabel }}</span>
        </span>
      </span>
      <span class="compression-status">{{ statusLabel }}</span>
    </button>

    <div class="compression-actions" aria-label="压缩记录操作">
      <button type="button" class="compression-action-button" title="查看本次压缩调用详情" aria-label="查看本次压缩调用详情" @click="emit('view-detail', block)">
        <IconEye class="compression-action-icon" size="15" stroke="1.8" />
      </button>
      <button type="button" class="compression-action-button" :disabled="isWorking" :title="block.status === 'disabled' ? '启用压缩块' : '禁用压缩块'" @click="emit('toggle-enabled', block, block.status === 'disabled')">
        <IconPlayerPlay v-if="block.status === 'disabled'" class="compression-action-icon" size="15" stroke="1.8" />
        <IconPlayerPause v-else class="compression-action-icon" size="15" stroke="1.8" />
      </button>
      <button type="button" class="compression-action-button" :disabled="isWorking" title="重新生成" @click="emit('regenerate', block)">
        <IconRefresh class="compression-action-icon" size="15" stroke="1.8" />
      </button>
      <button type="button" class="compression-action-button" :disabled="!copyText" :title="copied ? '已复制' : '复制压缩内容'" @click="copyCompressionContent">
        <IconCheck v-if="copied" class="compression-action-icon" size="15" stroke="1.8" />
        <IconCopy v-else class="compression-action-icon" size="15" stroke="1.8" />
      </button>
      <button
        type="button"
        class="compression-action-button"
        :disabled="isWorking"
        :title="isWorking ? '压缩进行中，当前版本暂不支持取消或删除' : '删除压缩记录'"
        @click="confirmDeleteOpen = true"
      >
        <IconTrash class="compression-action-icon" size="15" stroke="1.8" />
      </button>
    </div>

    <div v-if="previewText" class="compression-preview" :class="{ placeholder: isWorking }">
      {{ previewText }}
    </div>

    <CompressionRetryStatus
      v-if="showRetryStatus"
      :invocation="compressionInvocation"
      :block-status="block.status"
    />

    <div v-if="expanded" class="compression-detail">
      <div class="detail-row"><span>来源范围</span><strong>{{ rangeLabel || '未知' }}</strong></div>
      <div class="detail-row"><span>压缩前</span><strong>{{ block.tokenCountBefore ?? '—' }}</strong></div>
      <div class="detail-row"><span>压缩后</span><strong>{{ block.tokenCountAfter ?? '—' }}</strong></div>
      <div v-if="compressionInvocation?.retryAttempt" class="detail-row"><span>自动重试</span><strong>{{ formatRetryAttempt(compressionInvocation.retryAttempt, compressionInvocation.retryMaxAttempts) || '—' }}</strong></div>
      <div class="detail-row"><span>来源校验值</span><code>{{ block.sourceHash || '—' }}</code></div>
      <p v-if="block.summaryPreview" class="summary-preview">{{ block.summaryPreview }}</p>
      <p v-if="block.error" class="detail-error">{{ block.error }}</p>
      <p v-if="block.staleReason" class="detail-muted">{{ block.staleReason }}</p>
      <p v-if="block.methodKind === 'provider_native'" class="detail-muted">Provider 原生压缩块只在渠道、模型与冻结能力快照兼容时原样复用；不兼容或调用失败时由冻结的后备链处理。</p>
    </div>

    <ConfirmPanel
      :open="confirmDeleteOpen"
      title="删除压缩记录"
      description-html="删除后后续请求将不再使用此压缩块，原始聊天消息不会删除。"
      :actions="deleteActions"
      @action="onDeleteAction"
    />
  </div>
</template>

<style scoped>
.compression-card {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--space-2);
  align-items: start;
  width: 100%;
  box-sizing: border-box;
  margin: 0;
  padding: var(--space-4) var(--conversation-content-padding-right, calc(var(--space-4) + 24px))
    var(--space-4) var(--conversation-content-padding-left, var(--space-4));
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-editor-foreground) 6%);
  color: var(--vscode-editor-foreground);
}
.compression-main {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: var(--space-2);
  border: 1px solid transparent;
  padding: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
}
.compression-main:hover,
.compression-main:focus,
.compression-main:focus-visible,
.compression-main:active {
  background: transparent;
  border-color: transparent;
  outline: none;
  box-shadow: none;
}
.compression-main:hover .compression-title,
.compression-main:focus-visible .compression-title {
  color: var(--vscode-foreground);
}
.compression-chevron,
.compression-icon {
  width: 14px;
  height: 14px;
  color: var(--vscode-descriptionForeground);
  flex: 0 0 auto;
}
.compression-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.compression-symbol {
  width: 15px;
  height: 15px;
  display: block;
  color: currentColor;
}
.compression-symbol path {
  fill: currentColor;
}
.compression-main:hover .compression-chevron,
.compression-main:focus-visible .compression-chevron,
.compression-main:hover .compression-icon,
.compression-main:focus-visible .compression-icon {
  color: var(--vscode-foreground);
}
.compression-icon.is-working {
  color: var(--vscode-editorWarning-foreground, #cca700);
}
.compression-icon.is-working .compression-symbol-top {
  animation: compression-squeeze-top 1.1s ease-in-out infinite;
  transform-origin: 12px 8px;
}
.compression-icon.is-working .compression-symbol-bottom {
  animation: compression-squeeze-bottom 1.1s ease-in-out infinite;
  transform-origin: 12px 16px;
}
.compression-body { min-width: 0; display: grid; gap: 2px; }
.compression-title { font-size: var(--font-size-sm); font-weight: 600; }
.compression-meta { display: flex; flex-wrap: wrap; gap: var(--space-2); color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); }
.compression-status { display: inline-flex; align-items: center; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-xs); padding: 1px 6px; color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); }
.status-error .compression-status { color: var(--vscode-errorForeground); }
.status-stale,
.status-disabled { opacity: 0.72; border-style: dashed; }
.compression-actions {
  position: absolute;
  top: var(--space-2);
  right: var(--conversation-content-padding-right, calc(var(--space-4) + 24px));
  display: flex;
  align-items: center;
  gap: var(--space-1);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--lc-message-actions-fade-duration, 120ms) ease-out;
}
.compression-card:hover .compression-actions,
.compression-card:focus-within .compression-actions {
  opacity: 1;
  pointer-events: auto;
}
.compression-action-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  min-width: 0;
  min-height: 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--vscode-descriptionForeground);
  cursor: pointer;
}
.compression-action-button:hover:not(:disabled),
.compression-action-button:focus-visible {
  color: var(--vscode-foreground);
  background: transparent;
  border-color: transparent;
}
.compression-action-button:focus-visible {
  outline: none;
}
.compression-action-button:disabled {
  opacity: 0.45;
  border-color: transparent;
  cursor: default;
}
.compression-action-icon {
  width: 15px;
  height: 15px;
  pointer-events: none;
}
.compression-preview {
  grid-column: 1 / -1;
  min-width: 0;
  margin: 0 0 0 calc(16px + var(--space-2));
  overflow: hidden;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  line-height: 1.55;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.compression-preview.placeholder { color: var(--vscode-descriptionForeground); font-style: italic; }
.compression-detail { grid-column: 1 / -1; display: grid; gap: var(--space-1); padding: var(--space-2) 0 0 calc(16px + var(--space-2)); font-size: var(--font-size-xs); color: var(--vscode-descriptionForeground); }
.detail-row { display: flex; gap: var(--space-2); align-items: baseline; }
.detail-row span { min-width: 72px; }
.detail-row strong { color: var(--vscode-descriptionForeground); font-weight: 500; }
.detail-row code { font-family: var(--font-mono); }
.summary-preview { margin: var(--space-1) 0 0; white-space: pre-wrap; color: var(--vscode-descriptionForeground); }
.detail-error { margin: var(--space-1) 0 0; color: var(--vscode-errorForeground); }
.detail-muted { margin: var(--space-1) 0 0; color: var(--vscode-descriptionForeground); }
.entering { animation: compression-enter 100ms ease-out; }
.exiting { opacity: 0; transform: translateY(-3px); transition: opacity 100ms ease, transform 100ms ease; }
@keyframes compression-enter { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }
@keyframes compression-squeeze-top {
  0%, 100% { transform: translateY(-1px); }
  50% { transform: translateY(2px); }
}
@keyframes compression-squeeze-bottom {
  0%, 100% { transform: translateY(1px); }
  50% { transform: translateY(-2px); }
}
</style>
