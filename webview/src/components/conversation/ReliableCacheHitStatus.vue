<script setup lang="ts">
import { modelRequestObservedUsage } from '@shared/modelRequestMeasurement';
import { computed } from 'vue';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import HoverTooltipPanel from '@webview/components/ui/HoverTooltipPanel.vue';
import { formatTokenNumber } from './tokenUsageModel';
import {
  CACHE_HIT_RECENT_REQUEST_LIMIT,
  cacheHitSample,
  formatCacheHitPercent,
  recentCacheHitSummaries,
  type CacheHitSample,
  type CacheHitSummary
} from './cacheHitModel';

const reliableConversation = useReliableConversation();

// 只统计带回复消息的普通请求；压缩请求的用量描述的是压缩本身，不代表对话缓存是否正常。
const samples = computed<CacheHitSample[]>(() => {
  const conversationId = reliableConversation.conversationId.value;
  const turnIds = new Set(Object.values(reliableConversation.feed.records.Turn ?? {})
    .filter((turn) => turn.conversation_id === conversationId)
    .map((turn) => String(turn.id)));
  const ordinaryIds = new Set(Object.values(reliableConversation.feed.records.ModelRequestMessageLink ?? {})
    .map((link) => text(link.model_request_id))
    .filter(Boolean));
  return Object.values(reliableConversation.feed.records.ModelRequest ?? {})
    .filter((request) => turnIds.has(String(request.turn_id)) && ordinaryIds.has(text(request.id)))
    .sort((left, right) => timestamp(right.created_at) - timestamp(left.created_at)
      || integer(right.request_seq) - integer(left.request_seq))
    .flatMap((request) => {
      const createdAt = timestamp(request.created_at);
      const sample = cacheHitSample(modelRequestObservedUsage(request), {
        providerId: text(request.provider_id),
        turnId: String(request.turn_id),
        ...(createdAt ? { createdAt } : {})
      });
      return sample ? [sample] : [];
    });
});
const summaries = computed(() => recentCacheHitSummaries(samples.value));
const recent = computed(() => summaries.value.recent);
const percent = computed(() => recent.value.ratio === undefined ? '—' : formatCacheHitPercent(recent.value.ratio));
const tooltipRows = computed(() => {
  const latest = summaries.value.latestTurn;
  return [
    { label: `最近 ${CACHE_HIT_RECENT_REQUEST_LIMIT} 次`, value: summaryValue(recent.value) },
    ...(latest ? [{ label: '最近一轮', value: `${summaryValue(latest)}，${latest.requests} 次请求` }] : []),
    { label: '统计范围', value: rangeLabel(recent.value) },
    ...(recent.value.unreported > 0
      ? [{ label: '渠道未返回缓存', value: `${recent.value.unreported} 次，未计入` }]
      : [])
  ];
});

function summaryValue(summary: CacheHitSummary): string {
  if (summary.ratio === undefined) return '渠道未返回缓存数据';
  return `${formatCacheHitPercent(summary.ratio)}（${formatTokenNumber(summary.cachedTokens)} / ${formatTokenNumber(summary.inputTokens)}）`;
}

function rangeLabel(summary: CacheHitSummary): string {
  const count = `${summary.requests} 次请求`;
  if (summary.firstAt === undefined || summary.lastAt === undefined) return count;
  return `${count}，${clock(summary.firstAt)} – ${clock(summary.lastAt)}`;
}

function clock(value: number): string {
  const date = new Date(value);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const today = new Date();
  return date.toDateString() === today.toDateString() ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function integer(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0;
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
</script>

<template>
  <HoverTooltipPanel
    v-if="samples.length > 0"
    class="reliable-cache-hit-status"
    panel-title="缓存命中率"
    :rows="tooltipRows"
    :delay-ms="180"
  >
    <button type="button" class="reliable-cache-hit-button" :aria-label="`缓存命中率 ${percent}`"><span class="reliable-cache-hit-prefix">缓存 </span>{{ percent }}</button>
  </HoverTooltipPanel>
</template>

<style scoped>
.reliable-cache-hit-status {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
}

.reliable-cache-hit-button {
  min-height: 22px;
  padding: 2px 4px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font: inherit;
  font-size: var(--font-size-xs);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.reliable-cache-hit-button:hover,
.reliable-cache-hit-button:focus-visible {
  color: var(--vscode-foreground);
  border-color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, transparent);
  outline: none;
}

/* 窄面板只留百分比，悬浮说明仍写明是缓存命中率。 */
@media (max-width: 400px) {
  .reliable-cache-hit-prefix { display: none; }
}
</style>
