<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { IconChevronRight, IconCopy, IconCheck, IconX } from '@tabler/icons-vue';
import {
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  isInlineDataPart,
  isProviderContextPart,
  isTextPart,
  type ContentPart,
  type MessageContent
} from '@shared/protocol';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { reliableKernelDetailKey } from '@webview/domain/reliableDetailKey';
import { formatTokenNumber } from './tokenUsageModel';

const props = defineProps<{
  block: Record<string, unknown>;
}>();
const emit = defineEmits<{ (event: 'dismiss'): void }>();

const { feed } = useReliableConversation();
const expanded = ref(false);
const copied = ref(false);

const blockId = computed(() => stringValue(props.block.id));
const contentDetail = computed(() => feed.details[
  reliableKernelDetailKey('compression-content', blockId.value)
]);
const titleDetail = computed(() => feed.details[
  reliableKernelDetailKey('compression-title', blockId.value)
]);
const presentationDetail = computed(() => feed.details[
  reliableKernelDetailKey('compression-presentation', blockId.value)
]);
const presentation = computed(() => parsePresentation(
  presentationDetail.value?.status === 'ready' ? presentationDetail.value.text : ''
));
const envelope = computed(() => parseEnvelope(contentDetail.value?.status === 'ready' ? contentDetail.value.text : ''));
const status = computed(() => stringValue(props.block.status) || 'enabled');
const committed = computed(() => ['enabled', 'disabled', 'soft_deleted'].includes(status.value));
const trigger = computed(() =>
  stringValue(props.block.trigger) || presentation.value.trigger || envelope.value.trigger || 'manual'
);
const methodKind = computed(() =>
  stringValue(props.block.method_kind ?? props.block.methodKind)
  || presentation.value.methodKind
  || envelope.value.methodKind
);
const title = computed(() => titleDetail.value?.status === 'ready' && titleDetail.value.text.trim()
  ? titleDetail.value.text.trim()
  : presentation.value.title
    || stringValue(props.block.title)
    || (trigger.value === 'auto' ? '自动上下文压缩' : '上下文压缩'));
const methodLabel = computed(() => {
  switch (methodKind.value) {
    case 'provider_native': return 'Provider 原生压缩';
    case 'llm_summary': return 'LLM 总结';
    case 'segmented_summary': return '分段总结';
    case 'deterministic_summary': return '确定性摘要';
    case 'manual_summary': return '手动摘要';
    default: return '上下文压缩';
  }
});
const sourceCount = computed(() => nonNegativeInteger(props.block.source_count) ?? nonNegativeInteger(props.block.sourceCount));
const statusLabel = computed(() => status.value === 'enabled'
  ? '已完成'
  : status.value === 'disabled'
    ? '已禁用'
    : status.value === 'soft_deleted'
      ? '已删除'
      : status.value === 'pending'
        ? '准备中'
        : status.value === 'retrying'
          ? '恢复中'
          : status.value === 'committing'
            ? '保存中'
            : '压缩中');
const summaryText = computed(() => renderContents(envelope.value.contents));
const providerNative = computed(() => envelope.value.contents.some((content) =>
  content.parts.some((part) => isProviderContextPart(part))
));
const beforeTokens = computed(() => firstToken(
  props.block.estimated_tokens_before,
  props.block.estimatedTokensBefore,
  presentation.value.estimatedTokensBefore,
  envelope.value.estimatedTokensBefore
));
const afterTokens = computed(() => firstToken(
  props.block.estimated_tokens_after,
  props.block.estimatedTokensAfter,
  presentation.value.estimatedTokensAfter,
  envelope.value.estimatedTokensAfter
));
const savedTokens = computed(() => beforeTokens.value !== undefined && afterTokens.value !== undefined
  ? Math.max(0, beforeTokens.value - afterTokens.value)
  : undefined);
const triggerReason = computed(() =>
  stringValue(props.block.trigger_reason ?? props.block.triggerReason)
  || presentation.value.triggerReason
  || envelope.value.triggerReason
);
const triggerTokens = computed(() => firstToken(
  props.block.trigger_tokens,
  props.block.triggerTokens,
  presentation.value.triggerTokens,
  envelope.value.triggerTokens
));
const triggerTokenSource = computed(() =>
  stringValue(props.block.trigger_token_source ?? props.block.triggerTokenSource)
  || presentation.value.triggerTokenSource
  || envelope.value.triggerTokenSource
);
const configuredThresholdTokens = computed(() => firstToken(
  props.block.configured_threshold_tokens,
  props.block.configuredThresholdTokens,
  presentation.value.configuredThresholdTokens,
  envelope.value.configuredThresholdTokens
));
const providerInputTokens = computed(() => firstToken(
  presentation.value.providerInputTokens,
  envelope.value.providerInputTokens
));
const providerOutputTokens = computed(() => firstToken(
  presentation.value.providerOutputTokens,
  envelope.value.providerOutputTokens
));
const triggerLabel = computed(() => {
  if (triggerReason.value === 'configured_threshold') return '配置阈值触发';
  if (triggerReason.value === 'manual' || trigger.value === 'manual') return '手动触发';
  return trigger.value === 'auto' ? '自动触发' : '';
});
const triggerTokenSourceLabel = computed(() => {
  switch (triggerTokenSource.value) {
    case 'provider-observed-delta': return 'Provider 实测基线 + 新增内容估算';
    case 'compression-output': return '压缩结果 Token';
    case 'semantic': return '模型可见内容估算';
    default: return '';
  }
});
const diagnosticRows = computed(() => [
  { label: '触发原因', value: triggerLabel.value },
  { label: '触发时上下文', value: tokenLabel(triggerTokens.value) },
  { label: '触发值来源', value: triggerTokenSourceLabel.value },
  { label: '配置压缩阈值', value: tokenLabel(configuredThresholdTokens.value) },
  { label: '触发时完整请求估算', value: tokenLabel(beforeTokens.value) },
  { label: '触发时请求构成', value: envelope.value.requestBreakdownLabel ?? '' },
  { label: '压缩后上下文估算', value: tokenLabel(afterTokens.value) },
  { label: '压缩 Provider 实际输入', value: tokenLabel(providerInputTokens.value) },
  { label: '压缩 Provider 实际输出', value: tokenLabel(providerOutputTokens.value) },
  { label: '保留附件目录', value: envelope.value.attachmentCount === undefined ? '' : `${envelope.value.attachmentCount} 项（无正文）` }
].filter((row) => row.value));
const subtitle = computed(() => {
  const activityPrefix = [methodLabel.value, triggerLabel.value].filter(Boolean).join(' · ');
  const attempt = nonNegativeInteger(props.block.retry_attempt) ?? 0;
  const maximum = nonNegativeInteger(props.block.retry_max_attempts) ?? attempt;
  const retryLabel = attempt > 0 ? `（第 ${attempt}/${maximum} 次重试）` : '';
  if (status.value === 'pending') return `${activityPrefix} · 正在准备上下文压缩`;
  if (status.value === 'running') {
    const progressAt = nonNegativeInteger(props.block.last_stream_event_at);
    const progressTime = progressAt ? new Date(progressAt) : undefined;
    const progress = progressTime && Number.isFinite(progressTime.getTime())
      ? `已收到模型输出 · 最近进度 ${progressTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
      : '等待模型输出';
    return `${activityPrefix} · ${progress}${retryLabel}`;
  }
  if (status.value === 'committing') return `${activityPrefix} · 压缩已完成，正在保存结果`;
  if (status.value === 'retrying') {
    const reason = stringValue(props.block.retry_reason_label) || '压缩连接异常';
    const seconds = nonNegativeInteger(props.block.retry_delay_seconds) ?? 0;
    return `${reason} · ${seconds} 秒后自动恢复${retryLabel}`;
  }
  const facts = [methodLabel.value, triggerLabel.value];
  if (sourceCount.value !== undefined) facts.push(`${sourceCount.value} 个上下文段`);
  if (savedTokens.value !== undefined) facts.push(`节省约 ${formatTokenNumber(savedTokens.value)} Token`);
  return facts.join(' · ');
});

watch(
  () => `${blockId.value}:${committed.value ? 'committed' : 'active'}:${presentationDetail.value?.status ?? 'missing'}`,
  () => {
    if (!blockId.value || !committed.value || presentationDetail.value) return;
    feed.requestDetail('compression-presentation', blockId.value, { priority: 'visible' });
  },
  { immediate: true }
);

function toggle(): void {
  if (!committed.value) return;
  expanded.value = !expanded.value;
  if (!expanded.value || !blockId.value) return;
  for (const kind of ['compression-title', 'compression-content'] as const) {
    const detail = feed.details[reliableKernelDetailKey(kind, blockId.value)];
    if (detail?.status === 'error') feed.retryDetail(kind, blockId.value, { priority: 'expanded' });
    else feed.requestDetail(kind, blockId.value, { priority: 'expanded' });
  }
}

async function copySummary(): Promise<void> {
  if (!summaryText.value) return;
  await navigator.clipboard.writeText(summaryText.value);
  copied.value = true;
  window.setTimeout(() => { copied.value = false; }, 1200);
}

interface CompressionDiagnosticData {
  triggerReason?: string;
  triggerTokens?: number;
  triggerTokenSource?: string;
  configuredThresholdTokens?: number;
  estimatedTokensBefore?: number;
  estimatedTokensAfter?: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  attachmentCount?: number;
  requestBreakdownLabel?: string;
}

interface ParsedCompressionEnvelope extends CompressionDiagnosticData {
  trigger?: string;
  methodKind?: string;
  contents: MessageContent[];
}

function parseEnvelope(text: string): ParsedCompressionEnvelope {
  if (!text.trim()) return { contents: [] };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return { contents: normalizeContents(parsed) };
    const record = asRecord(parsed);
    if (!record) return { contents: [{ role: 'user', parts: [{ text }] }] };
    const contents = normalizeContents(record.contents ?? record.resultContents ?? []);
    const attachmentCatalogState = asRecord(record.attachmentCatalogState);
    const attachmentCatalog = Array.isArray(attachmentCatalogState?.catalog)
      ? attachmentCatalogState.catalog
      : undefined;
    return {
      contents,
      ...(stringValue(record.trigger) ? { trigger: stringValue(record.trigger) } : {}),
      ...(stringValue(record.methodKind ?? record.method_kind) ? { methodKind: stringValue(record.methodKind ?? record.method_kind) } : {}),
      ...parseDiagnosticFields(record),
      ...(requestBreakdownLabel(record.requestBreakdown ?? record.request_breakdown)
        ? { requestBreakdownLabel: requestBreakdownLabel(record.requestBreakdown ?? record.request_breakdown) }
        : {}),
      ...(attachmentCatalog ? { attachmentCount: attachmentCatalog.length } : {})
    };
  } catch {
    return { contents: [{ role: 'user', parts: [{ text }] }] };
  }
}

function parsePresentation(text: string): CompressionDiagnosticData & {
  title?: string;
  trigger?: string;
  methodKind?: string;
} {
  if (!text.trim()) return {};
  try {
    const record = asRecord(JSON.parse(text) as unknown);
    if (!record) return {};
    return {
      ...(stringValue(record.title) ? { title: stringValue(record.title) } : {}),
      ...(stringValue(record.trigger) ? { trigger: stringValue(record.trigger) } : {}),
      ...(stringValue(record.methodKind) ? { methodKind: stringValue(record.methodKind) } : {}),
      ...parseDiagnosticFields(record)
    };
  } catch {
    return {};
  }
}

function parseDiagnosticFields(record: Record<string, unknown>): CompressionDiagnosticData {
  const result: CompressionDiagnosticData = {};
  const triggerReason = stringValue(record.triggerReason ?? record.trigger_reason);
  if (triggerReason) result.triggerReason = triggerReason;
  const triggerTokenSource = stringValue(record.triggerTokenSource ?? record.trigger_token_source);
  if (triggerTokenSource) result.triggerTokenSource = triggerTokenSource;
  for (const [field, aliases] of Object.entries({
    triggerTokens: ['triggerTokens', 'trigger_tokens'],
    configuredThresholdTokens: ['configuredThresholdTokens', 'configured_threshold_tokens'],
    estimatedTokensBefore: ['estimatedTokensBefore', 'estimated_tokens_before'],
    estimatedTokensAfter: ['estimatedTokensAfter', 'estimated_tokens_after'],
    providerInputTokens: ['providerInputTokens', 'provider_input_tokens'],
    providerOutputTokens: ['providerOutputTokens', 'provider_output_tokens']
  } as const)) {
    const value = firstToken(...aliases.map((alias) => record[alias]));
    if (value !== undefined) (result as Record<string, unknown>)[field] = value;
  }
  return result;
}

function requestBreakdownLabel(value: unknown): string {
  const record = asRecord(value);
  if (!record) return '';
  const rows = [
    ['系统', firstToken(record.systemTokens, record.system_tokens)],
    ['工具定义', firstToken(record.toolSchemaTokens, record.tool_schema_tokens)],
    ['上下文', firstToken(record.contextTokens, record.context_tokens)],
    ['当前输入', firstToken(record.currentInputTokens, record.current_input_tokens)],
    ['运行时结果', firstToken(record.runtimeDeliveryTokens, record.runtime_delivery_tokens)],
    ['提醒', firstToken(record.turnReminderTokens, record.turn_reminder_tokens)]
  ] as const;
  return rows
    .flatMap(([label, count]) => count === undefined
      ? []
      : [`${label} ${formatTokenNumber(count)}`])
    .join(' · ');
}

function firstToken(...values: unknown[]): number | undefined {
  for (const value of values) {
    const normalized = nonNegativeInteger(value);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

function tokenLabel(value: number | undefined): string {
  return value === undefined ? '' : `${formatTokenNumber(value)} Token`;
}

function normalizeContents(value: unknown): MessageContent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record || !Array.isArray(record.parts)) return [];
    return [{
      role: record.role === 'model' ? 'model' : 'user',
      parts: record.parts as ContentPart[]
    } satisfies MessageContent];
  });
}

function renderContents(contents: MessageContent[]): string {
  return contents.flatMap((content) => content.parts.map(renderPart)).filter(Boolean).join('\n').trim();
}

function renderPart(part: ContentPart): string {
  if (isTextPart(part)) return part.thought === true ? '' : part.text;
  if (isFunctionCallPart(part)) return `[工具调用] ${part.functionCall.name}: ${safeJson(part.functionCall.args)}`;
  if (isFunctionResponsePart(part)) return `[工具结果] ${part.functionResponse.name}: ${safeJson(part.functionResponse.response)}`;
  if (isProviderContextPart(part)) return `[渠道专用上下文] ${part.providerContext.format}:${part.providerContext.itemType ?? 'context'}`;
  if (isInlineDataPart(part)) return `[内联数据] ${part.inlineData.mimeType}`;
  if (isFileDataPart(part)) return `[文件] ${part.fileData.uri}`;
  return '';
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function nonNegativeInteger(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}
</script>

<template>
  <section
    class="reliable-compression-card"
    data-testid="compression-card"
    :data-compression-block-id="blockId"
    :data-trigger="trigger"
    :data-status="status"
    :aria-busy="!committed"
  >
    <button
      type="button"
      class="compression-card-main"
      :class="{ active: !committed }"
      data-testid="compression-card-toggle"
      :disabled="!committed"
      @click="toggle"
    >
      <IconChevronRight v-if="committed" class="compression-card-chevron" :class="{ expanded }" size="16" />
      <span v-else class="compression-card-progress" aria-hidden="true" />
      <span class="compression-card-symbol" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M5 5h14l-7 6zM5 19h14l-7-6z" /></svg>
      </span>
      <span class="compression-card-copy">
        <strong>{{ title }}</strong>
        <small>{{ subtitle }}</small>
      </span>
      <span class="compression-card-status" role="status">{{ statusLabel }}</span>
    </button>
    <button
      v-if="committed"
      type="button"
      class="compression-card-dismiss"
      aria-label="关闭上下文压缩提示"
      @click="emit('dismiss')"
    >
      <IconX size="15" />
    </button>

    <div v-if="committed && expanded" class="compression-card-detail" data-testid="compression-detail">
      <p v-if="contentDetail?.status === 'loading' || !contentDetail">正在读取压缩结果…</p>
      <p v-else-if="contentDetail.status === 'error'" data-testid="compression-detail-error">{{ contentDetail.error || '压缩详情读取失败' }}</p>
      <template v-else>
        <dl v-if="diagnosticRows.length" class="compression-diagnostics" data-testid="compression-diagnostics">
          <div v-for="row in diagnosticRows" :key="row.label">
            <dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </div>
        </dl>
        <p v-if="providerNative" class="compression-provider-note">该块保留当前 Provider 的签名或不透明上下文；仅在渠道、模型与能力快照兼容时原样复用，不会转换成 Markdown。</p>
        <pre v-if="summaryText" data-testid="compression-detail-summary">{{ summaryText }}</pre>
        <p v-else>压缩结果没有可见文本，但可能包含渠道专用上下文。</p>
        <button v-if="summaryText" type="button" class="compression-copy" @click="copySummary">
          <IconCheck v-if="copied" size="15" />
          <IconCopy v-else size="15" />
          {{ copied ? '已复制' : '复制压缩内容' }}
        </button>
      </template>
    </div>
  </section>
</template>

<style scoped>
.reliable-compression-card {
  position: relative;
  margin: var(--space-2) var(--conversation-content-padding-right, var(--space-4)) var(--space-2) var(--conversation-content-padding-left, var(--space-4));
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}
.compression-card-main { width: 100%; display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3) 44px var(--space-3) var(--space-3); border: 0; color: inherit; background: transparent; text-align: left; }
.compression-card-main:disabled { cursor: default; opacity: 1; }
.compression-card-main.active { padding-right: var(--space-3); }
.compression-card-chevron { flex: 0 0 auto; transition: transform 120ms ease; }
.compression-card-chevron.expanded { transform: rotate(90deg); }
.compression-card-progress { width: 8px; height: 8px; margin: 0 4px; flex: 0 0 auto; border-radius: 50%; background: currentColor; animation: compression-pulse 1.2s ease-in-out infinite; }
.compression-card-symbol { width: 16px; height: 16px; flex: 0 0 auto; }
.compression-card-symbol svg { width: 100%; height: 100%; fill: currentColor; }
.compression-card-copy { min-width: 0; display: grid; gap: 2px; }
.compression-card-copy small { color: var(--vscode-descriptionForeground); }
.compression-card-status { margin-left: auto; color: var(--vscode-descriptionForeground); }
.compression-card-dismiss { position: absolute; top: 8px; right: 8px; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--vscode-descriptionForeground); background: transparent; }
.compression-card-dismiss:hover,
.compression-card-dismiss:focus-visible { color: var(--vscode-foreground); border-color: var(--vscode-panel-border); background: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%); outline: none; }
.compression-card-detail { display: grid; gap: var(--space-2); padding: 0 var(--space-3) var(--space-3) calc(var(--space-3) + 40px); }
.compression-card-detail p { margin: 0; color: var(--vscode-descriptionForeground); }
.compression-diagnostics { display: grid; gap: 3px; margin: 0; padding: var(--space-2); border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); }
.compression-diagnostics > div { display: grid; grid-template-columns: minmax(128px, 0.7fr) minmax(0, 1fr); gap: var(--space-2); }
.compression-diagnostics dt { color: var(--vscode-descriptionForeground); }
.compression-diagnostics dd { min-width: 0; margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.compression-card-detail pre { max-height: 320px; margin: 0; padding: var(--space-2); overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border: 1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); font: inherit; }
.compression-copy { justify-self: start; display: inline-flex; align-items: center; gap: 6px; }
@keyframes compression-pulse {
  0%, 100% { opacity: 0.28; transform: scale(0.72); }
  50% { opacity: 0.9; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .compression-card-progress { animation: none; opacity: 0.75; }
}
</style>
