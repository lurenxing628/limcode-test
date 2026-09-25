<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import {
  IconArrowBackUp,
  IconArrowFork,
  IconArrowNarrowDown,
  IconArrowNarrowUp,
  IconBolt,
  IconCheck,
  IconClock,
  IconCopy,
  IconEdit,
  IconHourglassEmpty,
  IconHash,
  IconRefresh,
  IconTrash,
  IconX
} from '@tabler/icons-vue';
import { isVisibleTextPart, type LlmUsageMetadataRecord, type MessageRecord, type RunTerminationRecord } from '@shared/protocol';
import RichContentView from '@webview/components/content/RichContentView.vue';
import ConfirmPanel, { type ConfirmPanelAction } from '@webview/components/ui/ConfirmPanel.vue';
import HoverTooltipPanel from '@webview/components/ui/HoverTooltipPanel.vue';
import { normalizeTokenUsage } from './tokenUsageModel';

const props = withDefaults(
  defineProps<{
    message: MessageRecord;
    runId?: string;
    termination?: RunTerminationRecord;
    terminationNoticeSuppressed?: boolean;
    runHadCompletedTools?: boolean;
    deleteCount?: number;
    floorNumber?: number;
    compactCount?: number;
    deleting?: boolean;
    entering?: boolean;
    editingHighlighted?: boolean;
    detailLoading?: boolean;
    detailReady?: boolean;
    mutationPending?: boolean;
    mutationBlocked?: boolean;
    retryBlocked?: boolean;
    compactBlocked?: boolean;
    forkBlocked?: boolean;
    pendingLabel?: string;
  }>(),
  { runId: undefined, termination: undefined, terminationNoticeSuppressed: false, runHadCompletedTools: false, deleteCount: 1, floorNumber: 0, compactCount: 1, deleting: false, entering: false, editingHighlighted: false, detailLoading: false, detailReady: true, mutationPending: false, mutationBlocked: false, retryBlocked: false, compactBlocked: false, forkBlocked: false, pendingLabel: '正在提交操作' }
);

const emit = defineEmits<{
  (event: 'edit-message', message: MessageRecord): void;
  (event: 'resend-as-new', message: MessageRecord): void;
  (event: 'retry-from', message: MessageRecord): void;
  (event: 'delete-from', message: MessageRecord): void;
  (event: 'compact-to', message: MessageRecord): void;
  (event: 'fork-from', message: MessageRecord): void;
  (event: 'dismiss-termination', termination: RunTerminationRecord): void;
}>();

const roleLabel = computed(() => {
  if (props.message.role === 'user') return '你';
  const model = props.message.model?.trim();
  return model || 'LLM';
});
type RunMetricKey = 'time' | 'ttft' | 'total' | 'speed';
interface RunMetricDetailItem {
  label: string;
  value: string;
}
interface RunMetricItem {
  key: RunMetricKey;
  label: string;
  value: string;
  tooltipTitle: string;
  details: RunMetricDetailItem[];
}
interface TooltipPanelRow {
  kind?: 'row';
  label: string;
  value: string;
  nested?: boolean;
}
interface TooltipPanelDivider {
  kind: 'divider';
  id?: string;
}
type TooltipPanelItem = TooltipPanelRow | TooltipPanelDivider;
type TokenUsageKind = 'total' | 'input' | 'output';
interface TokenUsageDetailItem {
  label: string;
  value: string;
  depth?: number;
}
interface TokenUsageItem {
  key: TokenUsageKind;
  label: string;
  value: number;
  compact: string;
  exact: string;
  suffix?: string;
  details: TokenUsageDetailItem[];
}

const hasOwn = Object.prototype.hasOwnProperty;
const LOCAL_DAY_MS = 86_400_000;
const streaming = computed(() => props.message.status === 'streaming' && !props.detailLoading);
const messageMutationBlocked = computed(() => props.mutationPending || props.mutationBlocked);
const editMutationBlocked = computed(() => messageMutationBlocked.value || !props.detailReady);
const retryMutationBlocked = computed(() => props.mutationPending || props.retryBlocked);
const compactMutationBlocked = computed(() => props.mutationPending || props.compactBlocked);
const forkMutationBlocked = computed(() => props.mutationPending || props.forkBlocked);
const copied = ref(false);
const terminatedContentExpanded = ref(false);
const confirmRetryOpen = ref(false);
const confirmDeleteOpen = ref(false);
const confirmCompactOpen = ref(false);
const confirmForkOpen = ref(false);
watch(messageMutationBlocked, (blocked) => {
  if (!blocked) return;
  confirmDeleteOpen.value = false;
});
watch(retryMutationBlocked, (blocked) => {
  if (blocked) confirmRetryOpen.value = false;
});
watch(compactMutationBlocked, (blocked) => {
  if (blocked) confirmCompactOpen.value = false;
});
watch(forkMutationBlocked, (blocked) => {
  if (blocked) confirmForkOpen.value = false;
});
const deleteDescriptionHtml = computed(
  () => `将删除这条消息以及它之后的所有共 ${props.deleteCount} 条消息，此操作<strong>无法撤销</strong>。`
);
const compactDescriptionHtml = computed(() => terminatedPartial.value
  ? `确定总结到此处吗？共 <strong>${props.compactCount}</strong> 条消息。已终止回复的未完成原文不会进入摘要，只保留终止位置与已完成的工具结果。`
  : `确定从此处开始往前进行总结吗？共 <strong>${props.compactCount}</strong> 条消息（前面的总结块本身额外算一条）。总结块会追加到这条消息后面。`
);
const forkDescriptionHtml = computed(
  () => `将从对话开头复制到此处，共 <strong>${Math.max(1, props.floorNumber)}</strong> 条消息。确认后会创建并自动打开新的分支对话。`
);
const retryDescriptionHtml = computed(() => terminatedPartial.value
  ? `确定重试这次已终止回复吗？将删除已保留的未完成回复及后续共 ${props.deleteCount} 条消息，并从原用户输入重新请求 LLM。此操作<strong>不可撤销</strong>。`
  : `确定要重试此消息吗？这将删除此消息及后续共 ${props.deleteCount} 条消息，然后重新请求 LLM。此操作<strong>不可撤销</strong>。`
);
const messageText = computed(() =>
  props.message.content.parts
    .filter(isVisibleTextPart)
    .map((part) => part.text)
    .join('')
);

const tokenUsageItems = computed<TokenUsageItem[]>(() => {
  if (props.message.role === 'user') return [];
  const usage = props.message.usageMetadata;
  if (!usage) return [];

  const normalized = normalizeTokenUsage(usage);
  const input = normalized.input;
  const output = normalized.output;
  const total = normalized.total;

  return [
    createTokenUsageItem('total', '总', total, usage),
    createTokenUsageItem('input', '输入', input, usage),
    createTokenUsageItem('output', '输出', output, usage)
  ].filter((item): item is TokenUsageItem => item !== undefined);
});

const runMetricItems = computed<RunMetricItem[]>(() => {
  const startedAt = normalizeTimestamp(
    props.message.role === 'model'
      ? props.message.firstChunkAt ?? props.message.createdAt
      : props.message.createdAt
  );
  const timeMetric: RunMetricItem | undefined = startedAt !== undefined
    ? {
        key: 'time' as const,
        label: props.message.role === 'user' ? '发送时间' : '响应时间',
        value: formatCallTime(startedAt),
        tooltipTitle: props.message.role === 'user' ? '发送时间' : '响应时间',
        details: [{ label: props.message.role === 'user' ? '发送时间' : '开始获取响应', value: formatFullDateTime(startedAt) }]
      }
    : undefined;

  if (props.message.role === 'user' || streaming.value) {
    return [timeMetric].filter((item): item is RunMetricItem => item !== undefined);
  }

  const explicitStreamDurationMs = normalizeDurationMs(props.message.streamOutputDurationMs);
  const requestStartedAt = normalizeTimestamp(props.message.requestStartedAt);
  const firstChunkAt = normalizeTimestamp(props.message.firstChunkAt ?? props.message.createdAt);
  const completedAt = normalizeTimestamp(props.message.completedAt);
  const streamDurationMs = explicitStreamDurationMs
    ?? (firstChunkAt !== undefined && completedAt !== undefined && completedAt >= firstChunkAt
      ? completedAt - firstChunkAt
      : undefined);
  const ttftMs = requestStartedAt !== undefined && firstChunkAt !== undefined && firstChunkAt >= requestStartedAt
    ? firstChunkAt - requestStartedAt
    : undefined;
  const totalMs = requestStartedAt !== undefined && completedAt !== undefined && completedAt >= requestStartedAt
    ? completedAt - requestStartedAt
    : ttftMs !== undefined && streamDurationMs !== undefined
      ? ttftMs + streamDurationMs
      : undefined;
  const outputTokens = props.message.usageMetadata
    ? normalizeTokenUsage(props.message.usageMetadata).output
    : undefined;
  const tokenSpeed = streamDurationMs !== undefined && streamDurationMs > 0 && outputTokens !== undefined
    ? outputTokens / (streamDurationMs / 1000)
    : undefined;

  const items: Array<RunMetricItem | undefined> = [
    timeMetric,
    ttftMs !== undefined
      ? {
          key: 'ttft' as const,
          label: '首字',
          value: formatDurationMs(ttftMs),
          tooltipTitle: '首字用时',
          details: [{ label: '首字用时', value: formatDurationMs(ttftMs) }]
        }
      : undefined,
    totalMs !== undefined
      ? {
          key: 'total' as const,
          label: '总耗',
          value: formatDurationMs(totalMs),
          tooltipTitle: '总耗时',
          details: [
            { label: '总耗时', value: formatDurationMs(totalMs) },
            ...(ttftMs !== undefined ? [{ label: '首字用时', value: formatDurationMs(ttftMs) }] : []),
            ...(streamDurationMs !== undefined ? [{ label: '输出耗时', value: formatDurationMs(streamDurationMs) }] : [])
          ]
        }
      : undefined,
    tokenSpeed !== undefined
      ? {
          key: 'speed' as const,
          label: '速度',
          value: formattokenSpeed(tokenSpeed),
          tooltipTitle: '输出 Token 速度（含思考）',
          details: [
            { label: '输出 Token（含思考）', value: formatExactNumber(outputTokens!) },
            { label: '输出耗时', value: formatDurationMs(streamDurationMs!) },
            { label: '速度', value: formattokenSpeedExact(tokenSpeed) }
          ]
        }
      : undefined
  ];
  return items.filter((item): item is RunMetricItem => item !== undefined);
});

const messageFooterVisible = computed(() => props.floorNumber > 0 || runMetricItems.value.length > 0 || tokenUsageItems.value.length > 0);

function createTokenUsageItem(key: TokenUsageKind, label: string, value: number | undefined, usage: LlmUsageMetadataRecord): TokenUsageItem | undefined {
  if (value === undefined) return undefined;
  const exact = formatExactNumber(value);
  const suffix = tokenUsageSuffix(key, usage);
  return {
    key,
    label,
    value,
    compact: formatCompactNumber(value),
    exact,
    ...(suffix ? { suffix } : {}),
    details: tokenUsageDetails(key, usage)
  };
}

let copiedResetTimer: number | undefined;

const deleteConfirmActions: ConfirmPanelAction[] = [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'confirm', label: '删除' }
];
const retryConfirmActions: ConfirmPanelAction[] = [
  { key: 'cancel', label: '取消', variant: 'secondary' },
  { key: 'confirm', label: '确认' }
];

onBeforeUnmount(() => {
  if (copiedResetTimer !== undefined) window.clearTimeout(copiedResetTimer);
});

const terminationLabel = computed<string | undefined>(() => {
  const termination = props.termination;
  if (!termination) return undefined;
  if (termination.kind === 'stale') return '已失效';
  if (termination.reasonCode === 'empty_model_result') return '未生成正文';
  if (termination.kind === 'failed') return '执行失败';
  if (termination.reasonCode === 'run_promoted'
    || termination.reasonCode === 'retry_requested'
    || termination.reasonCode === 'regenerate_requested'
    || termination.reasonCode === 'answer_bridge_continued') return '已替换';
  return '已终止';
});

const terminationClass = computed<string | undefined>(() => props.termination
  ? `termination-${props.termination.kind}`
  : undefined);
const terminatedPartial = computed(() => props.message.role === 'model'
  && props.message.status === 'partial'
  && props.termination !== undefined);
const hasTerminatedAuditContent = computed(() => terminatedPartial.value && props.message.content.parts.length > 0);
const showMessageContent = computed(() =>
  !terminatedPartial.value || props.terminationNoticeSuppressed || terminatedContentExpanded.value
);
const terminationNotice = computed(() => {
  const detail = props.termination?.detail?.trim().replace(/[。.!！?？]+$/, '');
  if (props.termination?.reasonCode === 'empty_model_result') {
    return props.runHadCompletedTools
      ? '工具调用已完成，但 LLM 没有返回可显示的最终说明。本轮已明确失败，工具结果仍会保留。'
      : 'LLM 调用已结束，但没有返回可显示的正文。本轮已明确失败，不会以空回复静默完成。';
  }
  if (props.runHadCompletedTools) {
    return detail
      ? `本轮在工具调用后未正常完成：${detail}。工具结果已保留。`
      : '本轮在工具调用后被终止，未生成最终说明；工具结果已保留，未完成回复不会计入后续 LLM 上下文。';
  }
  if (detail) return `本次回复未正常完成：${detail}`;
  return props.termination?.kind === 'failed'
    ? '本次回复未正常完成。未完成的回复正文不会进入后续 LLM 上下文；已完成的工具结果和中断位置仍会保留。'
    : '本次回复已终止。未完成的回复正文不会进入后续 LLM 上下文；已完成的工具结果和中断位置仍会保留。';
});
const terminationTooltipRows = computed(() => props.termination ? [
  { label: '原因', value: props.termination.detail?.trim() || props.termination.reasonCode },
  ...(props.termination.detail?.trim() ? [{ label: '分类', value: props.termination.reasonCode }] : []),
  { label: '上下文', value: '未完成正文不进入后续 LLM 上下文' },
  { label: '保留事实', value: '已执行工具结果与中断边界' }
] : []);
const copyableMessageText = computed(() =>
  terminatedPartial.value && !props.terminationNoticeSuppressed && !terminatedContentExpanded.value
    ? ''
    : messageText.value
);

function toggleTerminatedContent(): void {
  terminatedContentExpanded.value = !terminatedContentExpanded.value;
}

function usageNumber(usage: LlmUsageMetadataRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    if (!hasOwn.call(usage, key)) continue;
    const value = usage[key];
    const numeric = normalizeTokenNumber(value);
    if (numeric !== undefined) return numeric;
  }
  return undefined;
}

function normalizeTokenNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalizeTimestamp(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeDurationMs(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function formatCallTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const dayDiff = localDayNumber(now) - localDayNumber(date);
  const monthDiff = localMonthNumber(now) - localMonthNumber(date);
  const shortTime = formatTimeOfDay(date);

  if (dayDiff === 0) return formatTimeOfDay(date, { seconds: true });
  if (dayDiff === 1) return `昨天 ${shortTime}`;
  if (dayDiff === 2) return `前天 ${shortTime}`;
  if (dayDiff === -1) return `明天 ${shortTime}`;
  if (dayDiff > 2 && isSameLocalMonth(date, now)) return `本月 ${date.getDate()}日 ${shortTime}`;
  if (monthDiff === 1) return `上个月 ${date.getDate()}日 ${shortTime}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日 ${shortTime}`;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${shortTime}`;
}

function formatFullDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${formatTimeOfDay(date, { seconds: true })} ${formatTimezoneLabel(date)}`;
}

function formatTimeOfDay(date: Date, options: { seconds?: boolean } = {}): string {
  const base = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return options.seconds ? `${base}:${pad2(date.getSeconds())}` : base;
}

function isSameLocalMonth(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth();
}

function localDayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / LOCAL_DAY_MS);
}

function localMonthNumber(date: Date): number {
  return date.getFullYear() * 12 + date.getMonth();
}

function formatTimezoneLabel(date: Date): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `UTC${sign}${pad2(Math.floor(absoluteOffset / 60))}:${pad2(absoluteOffset % 60)}`;
  return timeZone ? `${timeZone} ${offset}` : offset;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatDurationMs(durationMs: number): string {
  const safeDuration = Math.max(0, durationMs);
  if (safeDuration < 1000) return `${Math.round(safeDuration)} 毫秒`;
  const seconds = safeDuration / 1000;
  if (seconds < 60) {
    const digits = seconds < 10 ? 1 : 0;
    return `${trimFixed(seconds, digits)} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  return `${minutes} 分 ${restSeconds.toString().padStart(2, '0')} 秒`;
}

function formattokenSpeed(speed: number): string {
  const abs = Math.abs(speed);
  if (abs >= 1000) return `${(speed / 1000).toFixed(1)}k Token/秒`;
  return `${speed.toFixed(1)} Token/秒`;
}

function formattokenSpeedExact(speed: number): string {
  return `${speed.toFixed(1)} Token/秒`;
}

function trimFixed(value: number, digits: number): string {
  const fixed = value.toFixed(digits);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

function formatCompactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${formatScaledNumber(value, 1_000_000_000)}b`;
  if (abs >= 1_000_000) return `${formatScaledNumber(value, 1_000_000)}m`;
  if (abs >= 1_000) return `${formatScaledNumber(value, 1_000)}k`;
  return formatExactNumber(value);
}

function formatScaledNumber(value: number, divisor: number): string {
  const scaled = value / divisor;
  const fixed = scaled.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

function formatExactNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { maximumFractionDigits: 3 });
}

function tokenUsageSuffix(key: TokenUsageKind, usage: LlmUsageMetadataRecord): string | undefined {
  if (key === 'input') {
    const cached = usageNumber(usage, ['cachedContentTokenCount', 'cached_content_token_count', 'cached_tokens']);
    return cached !== undefined ? `(${formatCompactNumber(cached)})` : undefined;
  }

  if (key === 'output') {
    const thoughts = normalizeTokenUsage(usage).reasoning;
    return thoughts !== undefined ? `(${formatCompactNumber(thoughts)})` : undefined;
  }

  return undefined;
}

function tokenUsageDetails(key: TokenUsageKind, usage: LlmUsageMetadataRecord): TokenUsageDetailItem[] {
  switch (key) {
    case 'total':
      return usageDetailItems(usage, ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount']);
    case 'input':
      return [
        ...usageDetailItems(usage, ['cachedContentTokenCount', 'cacheCreationInputTokenCount']),
        ...recordUsageDetailItems(usage.cacheCreationInputTokensDetails, 0)
      ];
    case 'output':
      return outputTokenDetails(usage);
  }
  return [];
}

function usageDetailItems(usage: LlmUsageMetadataRecord, keys: readonly string[]): TokenUsageDetailItem[] {
  const details: TokenUsageDetailItem[] = [];
  for (const key of keys) {
    if (!hasOwn.call(usage, key)) continue;
    const item = detailItemFromValue(key, usage[key], 0);
    if (item) details.push(...item);
  }
  return details;
}

function outputTokenDetails(usage: LlmUsageMetadataRecord): TokenUsageDetailItem[] {
  const normalized = normalizeTokenUsage(usage);
  const thoughts = normalized.reasoning;
  if (thoughts === undefined) return [];

  const bodyTokens = normalized.output !== undefined ? Math.max(0, normalized.output - thoughts) : undefined;
  return [
    ...(bodyTokens !== undefined ? [{ label: '正文 Token', value: formatExactNumber(bodyTokens) }] : []),
    ...usageDetailItems(usage, ['thoughtsTokenCount', 'reasoning_tokens'])
  ];
}

function recordUsageDetailItems(value: unknown, depth: number): TokenUsageDetailItem[] {
  const record = recordValue(value);
  if (!record) return [];
  return Object.entries(record).flatMap(([key, child]) => detailItemFromValue(key, child, depth) ?? []);
}

function detailItemFromValue(key: string, value: unknown, depth: number): TokenUsageDetailItem[] | undefined {
  const numeric = normalizeTokenNumber(value);
  if (numeric !== undefined) {
    return [{ label: usageLabel(key), value: formatExactNumber(numeric), depth }];
  }

  if (typeof value === 'string' && value.trim()) {
    return [{ label: usageLabel(key), value, depth }];
  }

  const record = recordValue(value);
  if (record) {
    return Object.entries(record).flatMap(([childKey, childValue]) => detailItemFromValue(childKey, childValue, depth + 1) ?? []);
  }

  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function usageLabel(key: string): string {
  const labels: Record<string, string> = {
    promptTokenCount: '输入 Token',
    prompt_tokens: '输入 Token',
    input_tokens: '输入 Token',
    inputTokens: '输入 Token',
    cachedContentTokenCount: '缓存命中 Token',
    cached_content_token_count: '缓存命中 Token',
    cached_tokens: '缓存命中 Token',
    cache_read_input_tokens: '缓存读取输入 Token',
    cacheCreationInputTokenCount: '缓存创建输入 Token',
    cache_creation_input_tokens: '缓存创建输入 Token',
    cacheCreationInputTokensDetails: '缓存创建输入明细',
    ephemeral5mInputTokenCount: '5 分钟缓存创建输入 Token',
    ephemeral_5m_input_tokens: '5 分钟缓存创建输入 Token',
    ephemeral1hInputTokenCount: '1 小时缓存创建输入 Token',
    ephemeral_1h_input_tokens: '1 小时缓存创建输入 Token',
    candidatesTokenCount: '输出 Token',
    completion_tokens: '输出 Token',
    output_tokens: '输出 Token',
    outputTokens: '输出 Token',
    thoughtsTokenCount: '思考 Token',
    reasoning_tokens: '推理 Token',
    totalTokenCount: '总 Token',
    total_tokens: '总 Token',
    totalTokens: '总 Token'
  };
  return labels[key] ?? humanizeUsageKey(key);
}

function humanizeUsageKey(key: string): string {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  const words = normalized.split(/\s+/).filter(Boolean).map((word) => usageWordLabel(word));
  return words.length > 0 ? words.join(' ') : key;
}

function usageWordLabel(word: string): string {
  const labels: Record<string, string> = {
    prompt: '输入',
    input: '输入',
    output: '输出',
    completion: '输出',
    candidate: '候选输出',
    candidates: '输出',
    total: '总',
    token: 'Token',
    tokens: 'Token',
    cached: '缓存命中',
    cache: '缓存',
    creation: '创建',
    read: '读取',
    reasoning: '推理',
    thoughts: '思考',
    ephemeral: '临时'
  };
  return labels[word] ?? word;
}

function tokenUsageTooltipRows(item: TokenUsageItem): TooltipPanelItem[] {
  const rows: TooltipPanelItem[] = [{ label: '精确值', value: item.exact }];
  if (item.details.length > 0) {
    rows.push({ kind: 'divider', id: `${item.key}-details` });
    rows.push(...item.details.map((detail): TooltipPanelRow => ({
      label: detail.label,
      value: detail.value,
      nested: (detail.depth ?? 0) > 0
    })));
  }
  return rows;
}



async function copyMessage(): Promise<void> {
  const text = copyableMessageText.value;
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
    console.warn('[LimCode] Failed to copy message.', error);
    return false;
  } finally {
    textarea.remove();
  }
}

function openDeleteConfirm(): void {
  if (messageMutationBlocked.value) return;
  confirmDeleteOpen.value = true;
}

function openCompactConfirm(): void {
  if (compactMutationBlocked.value) return;
  confirmCompactOpen.value = true;
}

function openForkConfirm(): void {
  if (forkMutationBlocked.value) return;
  confirmForkOpen.value = true;
}

function editMessage(): void {
  if (editMutationBlocked.value) return;
  emit('edit-message', props.message);
}

function openRetryConfirm(): void {
  if (retryMutationBlocked.value) return;
  confirmRetryOpen.value = true;
}

function cancelRetry(): void {
  confirmRetryOpen.value = false;
}

function confirmRetry(): void {
  if (retryMutationBlocked.value) return cancelRetry();
  emit('retry-from', props.message);
  confirmRetryOpen.value = false;
}

function cancelDelete(): void {
  confirmDeleteOpen.value = false;
}

function confirmDelete(): void {
  if (messageMutationBlocked.value) return cancelDelete();
  emit('delete-from', props.message);
  confirmDeleteOpen.value = false;
}

function cancelCompact(): void {
  confirmCompactOpen.value = false;
}

function confirmCompact(): void {
  if (compactMutationBlocked.value) return cancelCompact();
  emit('compact-to', props.message);
  confirmCompactOpen.value = false;
}

function cancelFork(): void {
  confirmForkOpen.value = false;
}

function confirmFork(): void {
  if (forkMutationBlocked.value) return cancelFork();
  emit('fork-from', props.message);
  confirmForkOpen.value = false;
}

function onDeleteConfirmAction(action: ConfirmPanelAction): void {
  if (action.key === 'cancel') cancelDelete();
  if (action.key === 'confirm') confirmDelete();
}

function onRetryConfirmAction(action: ConfirmPanelAction): void {
  if (action.key === 'cancel') cancelRetry();
  if (action.key === 'confirm') confirmRetry();
}
</script>

<template>
  <article class="message-floor" :class="[message.role, { streaming, 'is-deleting': deleting, 'is-entering': entering, 'is-edit-target': editingHighlighted, 'is-mutation-pending': mutationPending }]" :data-scroll-marker-id="message.id" :data-message-id="message.id">
    <div class="floor-container">
      <div class="floor-content-column">
        <header class="floor-header">
          <span class="role-chip" :class="message.role === 'user' ? 'user' : 'assistant'">
            <span class="role-dot" aria-hidden="true"></span>
            <span class="floor-role-name">{{ roleLabel }}</span>
          </span>
          <span v-if="mutationPending" class="floor-status-badge is-pending">{{ pendingLabel }}</span>
          <HoverTooltipPanel
            v-if="terminationLabel"
            class="floor-status-badge is-stop"
            :class="terminationClass"
            :aria-label="terminationLabel"
            :panel-title="terminationLabel"
            :rows="terminationTooltipRows"
            tabindex="0"
          >
            <span>{{ terminationLabel }}</span>
          </HoverTooltipPanel>
        </header>
        <div class="floor-body">
          <div v-if="termination && !terminationNoticeSuppressed" class="terminated-message-placeholder">
            <p>{{ terminationNotice }}</p>
            <button
              type="button"
              class="terminated-notice-dismiss"
              aria-label="关闭本轮终止提示"
              @click="emit('dismiss-termination', termination)"
            >
              <IconX :size="15" stroke="1.9" />
            </button>
            <button
              v-if="terminatedPartial && hasTerminatedAuditContent"
              type="button"
              class="terminated-content-toggle"
              :aria-expanded="terminatedContentExpanded"
              @click="toggleTerminatedContent"
            >
              {{ terminatedContentExpanded ? '收起已终止内容' : '展开已终止内容' }}
            </button>
          </div>
          <div v-if="detailLoading" class="message-detail-loading" role="status" aria-live="polite">
            <span class="message-detail-loading-bar" aria-hidden="true"></span>
            <span>内容加载中</span>
          </div>
          <RichContentView
            v-else-if="showMessageContent"
            :parts="message.content.parts"
            :markdown="message.role !== 'user'"
            :streaming="streaming"
            :message-id="message.id"
          />
        </div>
        <footer v-if="messageFooterVisible" class="message-footer">
          <div v-if="floorNumber > 0 || runMetricItems.length > 0" class="message-turn-metrics" aria-label="消息楼层与 LLM 调用指标">
            <span v-if="floorNumber > 0" class="message-floor-index">#{{ floorNumber }}</span>
            <HoverTooltipPanel
              v-for="metric in runMetricItems"
              :key="metric.key"
              class="message-turn-metric"
              :class="`is-${metric.key}`"
              :aria-label="`${metric.label} ${metric.value}`"
              :panel-title="metric.tooltipTitle"
              :rows="metric.details"
              tabindex="0"
            >
              <IconHourglassEmpty v-if="metric.key === 'ttft'" class="message-turn-metric-icon" stroke="2" aria-hidden="true" />
              <IconClock v-else-if="metric.key === 'total'" class="message-turn-metric-icon" stroke="2" aria-hidden="true" />
              <IconBolt v-else-if="metric.key === 'speed'" class="message-turn-metric-icon" stroke="2" aria-hidden="true" />
              <span class="message-turn-metric-value">{{ metric.value }}</span>
            </HoverTooltipPanel>
          </div>
          <div v-if="tokenUsageItems.length > 0" class="token-usage-row" aria-label="Token 用量">
            <HoverTooltipPanel
              v-for="item in tokenUsageItems"
              :key="item.key"
              class="token-usage-item"
              :aria-label="`${item.label} Token ${item.exact}`"
              :panel-title="`${item.label} Token`"
              :rows="tokenUsageTooltipRows(item)"
              tabindex="0"
            >
              <IconHash v-if="item.key === 'total'" class="token-usage-icon" stroke="2" aria-hidden="true" />
              <IconArrowNarrowUp
                v-else-if="item.key === 'input'"
                class="token-usage-icon"
                stroke="2"
                aria-hidden="true"
              />
              <IconArrowNarrowDown v-else class="token-usage-icon" stroke="2" aria-hidden="true" />
              <span class="token-usage-value">{{ item.compact }}</span>
              <span v-if="item.suffix" class="token-usage-suffix">{{ item.suffix }}</span>
            </HoverTooltipPanel>
          </div>
        </footer>
      </div>
    </div>
    <div class="message-actions" aria-label="消息操作">
      <button
        v-if="message.role === 'user' && message.steeringInput"
        type="button"
        class="message-action-button"
        :disabled="!detailReady"
        aria-label="作为新消息发送"
        title="转向消息不能编辑重跑；把内容放回输入框，作为新消息发送"
        @click="emit('resend-as-new', message)"
      >
        <IconArrowBackUp class="message-action-icon" stroke="2" aria-hidden="true" />
      </button>
      <button
        v-if="message.role === 'user' && !message.steeringInput"
        type="button"
        class="message-action-button"
        :disabled="editMutationBlocked"
        aria-label="编辑消息"
        :title="!detailReady ? '消息附件仍在加载，请稍候' : '编辑消息'"
        @click="editMessage"
      >
        <IconEdit class="message-action-icon" stroke="2" aria-hidden="true" />
      </button>
      <button
        v-if="message.role !== 'user'"
        type="button"
        class="message-action-button"
        :disabled="retryMutationBlocked"
        aria-label="重试此消息"
        title="重试此消息"
        @click="openRetryConfirm"
      >
        <IconRefresh class="message-action-icon" stroke="2" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="message-action-button"
        :disabled="compactMutationBlocked || compactCount < 1"
        aria-label="总结到此处"
        title="总结到此处"
        data-testid="compression-start-to"
        @click="openCompactConfirm"
      >
        <svg class="message-action-icon message-compact-icon" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
          <path class="message-compact-icon-top" d="M5 5h14l-7 6z" />
          <path class="message-compact-icon-bottom" d="M5 19h14l-7 -6z" />
        </svg>
      </button>
      <button
        type="button"
        class="message-action-button"
        :disabled="forkMutationBlocked || terminatedPartial || floorNumber < 1"
        :aria-label="terminatedPartial ? '已终止的未完成回复不能作为分支位置' : '复制本对话至此'"
        :title="terminatedPartial ? '请选择上一条完整消息创建分支' : '复制本对话至此'"
        @click="openForkConfirm"
      >
        <IconArrowFork class="message-action-icon" stroke="2" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="message-action-button"
        :class="{ 'is-copied': copied }"
        :disabled="!copyableMessageText"
        :aria-label="copied ? '已复制消息' : '复制消息'"
        :title="copied ? '已复制' : '复制消息'"
        @click="copyMessage"
      >
        <IconCheck v-if="copied" class="message-action-icon" stroke="2" aria-hidden="true" />
        <IconCopy v-else class="message-action-icon" stroke="2" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="message-action-button"
        :disabled="messageMutationBlocked"
        aria-label="删除到此消息"
        title="删除到此消息"
        @click="openDeleteConfirm"
      >
        <IconTrash class="message-action-icon" stroke="2" aria-hidden="true" />
      </button>
    </div>
    <ConfirmPanel
      :open="confirmRetryOpen"
      title="重试消息？"
      :description-html="retryDescriptionHtml"
      :actions="retryConfirmActions"
      @action="onRetryConfirmAction"
      @cancel="cancelRetry"
    />
    <ConfirmPanel
      :open="confirmDeleteOpen"
      title="删除消息？"
      :description-html="deleteDescriptionHtml"
      :actions="deleteConfirmActions"
      @action="onDeleteConfirmAction"
      @cancel="cancelDelete"
    />
    <ConfirmPanel
      :open="confirmCompactOpen"
      title="总结到此处？"
      :description-html="compactDescriptionHtml"
      confirm-label="开始总结"
      test-id="compression-start-confirm"
      @confirm="confirmCompact"
      @cancel="cancelCompact"
    />
    <ConfirmPanel
      :open="confirmForkOpen"
      title="复制本对话至此？"
      :description-html="forkDescriptionHtml"
      confirm-label="复制并打开"
      @confirm="confirmFork"
      @cancel="cancelFork"
    />
  </article>
</template>

<style scoped>
.message-floor {
  position: relative;
  width: 100%;
  --message-floor-padding-block: 10px;
  padding: var(--message-floor-padding-block) var(--conversation-content-padding-right, calc(var(--space-4) + 24px))
    var(--message-floor-padding-block) var(--conversation-content-padding-left, var(--space-4));
  box-sizing: border-box;
  background-color: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%);
  transition: background-color var(--lc-message-bg-transition-duration) ease;
}

.message-floor.user {
  background-color: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-foreground) 10%);
}

.message-floor.model,
.message-floor.assistant {
  background-color: color-mix(in srgb, var(--vscode-editor-background) 97%, var(--vscode-foreground) 3%);
}

.message-floor.is-mutation-pending {
  opacity: 0.7;
}

.message-floor.is-deleting {
  pointer-events: none;
  animation: lc-message-exit-right var(--lc-message-exit-duration) var(--lc-motion-exit-standard) forwards;
  will-change: opacity, transform;
}

.message-floor.is-entering {
  animation: lc-message-enter var(--lc-message-enter-duration) var(--lc-motion-enter-emphasized) both;
  will-change: opacity, transform;
}

.message-floor.is-deleting .message-actions {
  opacity: 0;
}

.message-floor.is-edit-target {
  box-shadow: inset 0 0 0 1px var(--vscode-editorWarning-foreground, #cca700);
}

.floor-container {
  max-width: 100%;
}

.floor-content-column {
  width: 100%;
  min-width: 0;
}

.floor-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
  padding-right: 150px;
  flex-wrap: wrap;
}

.message-actions {
  position: absolute;
  top: var(--message-floor-padding-block, var(--space-2));
  right: var(--conversation-content-padding-right, calc(var(--space-4) + 24px));
  display: flex;
  align-items: center;
  gap: var(--space-1);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--lc-message-actions-fade-duration) ease-out;
}

.message-floor:hover .message-actions {
  opacity: 1;
  pointer-events: auto;
}

.message-action-button {
  width: 26px;
  height: 26px;
  min-width: 0;
  min-height: 0;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  cursor: pointer;
}

.message-action-button:hover:not(:disabled),
.message-action-button:focus-visible {
  color: var(--vscode-foreground);
  background: transparent;
  border-color: transparent;
}

.message-action-button:focus-visible {
  outline: none;
}

.message-action-button:disabled {
  opacity: 0.45;
  border-color: transparent;
  cursor: default;
}

.message-action-button.is-loading .message-action-icon {
  opacity: 0.55;
}

.message-action-icon {
  width: 15px;
  height: 15px;
  pointer-events: none;
}

.message-compact-icon path {
  fill: currentColor;
  stroke: none;
}

.role-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.role-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: 0 0 auto;
  background: currentColor;
}

.role-chip.user {
  color: var(--vscode-testing-iconPassed, #4caf50);
}

.role-chip.assistant {
  color: var(--vscode-editorWarning-foreground, #cca700);
}

.floor-role-name {
  font-weight: 600;
  font-size: var(--font-size-sm);
  color: currentColor;
}

.floor-status-badge {
  font-size: var(--font-size-xs);
  color: var(--vscode-descriptionForeground);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
}

.floor-status-badge.is-stop {
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
  background-color: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%);
}

.floor-status-badge.termination-cancelled,
.floor-status-badge.termination-interrupted,
.floor-status-badge.termination-failed {
  color: var(--vscode-errorForeground);
  border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-panel-border));
  background-color: var(--vscode-inputValidation-errorBackground, color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-foreground) 6%));
}

.floor-status-badge.termination-stale {
  color: var(--vscode-descriptionForeground);
  border-style: dashed;
}


.floor-body {
  font-size: var(--font-size-md);
  line-height: 1.6;
  color: var(--vscode-foreground);
}

.message-floor.streaming .floor-body {
  min-height: 1.6em;
}

.message-detail-loading {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 1.6em;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  font-style: italic;
}

.message-detail-loading-bar {
  width: 42px;
  height: 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--vscode-descriptionForeground) 34%, transparent);
}

.terminated-message-placeholder {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 8px 38px 8px 10px;
  border-left: 2px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-editor-background) 96%, var(--vscode-foreground) 4%);
  font-size: var(--font-size-sm);
}

.terminated-notice-dismiss {
  position: absolute;
  top: 5px;
  right: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.terminated-notice-dismiss:hover,
.terminated-notice-dismiss:focus-visible {
  color: var(--vscode-foreground);
  border-color: var(--vscode-panel-border);
  outline: none;
}

.terminated-message-placeholder p {
  margin: 0;
}

.terminated-content-toggle {
  padding: 0;
  border: 0;
  color: var(--vscode-foreground);
  background: transparent;
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.terminated-content-toggle:hover,
.terminated-content-toggle:focus-visible {
  color: var(--vscode-foreground);
  background: transparent;
  outline: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.45));
  outline-offset: 2px;
}

.message-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  margin-top: var(--space-2);
}

.message-turn-metrics {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  flex: 1 1 auto;
  flex-wrap: wrap;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 14px;
  user-select: none;
}

.message-floor-index {
  display: inline-flex;
  align-items: center;
  height: 14px;
  color: var(--vscode-descriptionForeground);
  font-weight: 500;
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
  line-height: 14px;
  opacity: 0.78;
}

.message-turn-metric,
.token-usage-item {
  display: inline-flex;
  align-items: center;
  height: 14px;
  line-height: 14px;
  white-space: nowrap;
  cursor: default;
  outline: none;
}

.message-turn-metric {
  min-width: 0;
  gap: 4px;
  color: inherit;
  opacity: 0.78;
}

.message-turn-metric.is-time {
  opacity: 0.82;
}

.message-turn-metric:hover {
  color: var(--vscode-foreground);
  opacity: 0.96;
}

.message-turn-metric:focus-visible {
  color: var(--vscode-foreground);
  opacity: 0.96;
  outline: 1px solid var(--vscode-focusBorder, currentColor);
  outline-offset: 2px;
}

.message-turn-metric-icon,
.token-usage-icon {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
  display: block;
}

.message-turn-metric-value,
.token-usage-value,
.token-usage-suffix {
  display: inline-flex;
  align-items: center;
  height: 14px;
  font-variant-numeric: tabular-nums;
  font-feature-settings: 'tnum';
  line-height: 14px;
}

.message-turn-metric-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.token-usage-row {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex: 0 0 auto;
  margin-left: auto;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
  line-height: 14px;
  user-select: none;
}

.token-usage-item {
  position: relative;
  gap: 2px;
  max-width: 132px;
  color: var(--vscode-descriptionForeground);
  opacity: 1;
}

.token-usage-item:hover {
  color: var(--vscode-foreground);
}

.token-usage-item:focus-visible {
  color: var(--vscode-foreground);
  outline: 1px solid var(--vscode-focusBorder, currentColor);
  outline-offset: 2px;
}

</style>
