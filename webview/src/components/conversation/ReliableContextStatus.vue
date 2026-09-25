<script setup lang="ts">
import { computed } from 'vue';
import {
  DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT,
  type LlmCompressionConfigRecord,
  type LlmProviderConfigRecord,
  type LlmUsageMetadataRecord
} from '@shared/protocol';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useModelProfileStore } from '@webview/stores/useModelProfileStore';
import HoverTooltipPanel from '@webview/components/ui/HoverTooltipPanel.vue';
import { currentRootEstimatedTokens, formatCompactTokenNumber, formatTokenNumber } from './tokenUsageModel';
import { compressionEstimateHint, observeContextInput, type ContextInputObservation } from './contextUsageModel';

const reliableConversation = useReliableConversation();
const globalSettings = useGlobalSettingsStore();
const modelProfiles = useModelProfileStore();

const conversationTurns = computed(() => new Map(Object.values(reliableConversation.feed.records.Turn ?? {})
  .filter((turn) => turn.conversation_id === reliableConversation.conversationId.value)
  .map((turn) => [String(turn.id), turn])));
const conversationRequests = computed(() => Object.values(reliableConversation.feed.records.ModelRequest ?? {})
  .filter((request) => conversationTurns.value.has(String(request.turn_id)))
  .sort((left, right) => requestOrder(right) - requestOrder(left) || integer(right.request_seq) - integer(left.request_seq)));
const ordinaryRequestIds = computed(() => new Set(
  Object.values(reliableConversation.feed.records.ModelRequestMessageLink ?? {})
    .map((link) => text(link.model_request_id))
    .filter(Boolean)
));
// Compression calls are ModelRequests too, but their usage describes the compaction operation rather
// than the ordinary model prompt. Only requests that own an assistant Message are context baselines.
const requestProjections = computed(() => new Map(Object.values(reliableConversation.feed.records.ModelContextProjection ?? {})
  .filter((projection) => projection.owner_kind === 'model_request')
  .map((projection) => [text(projection.owner_id), projection])));
const ordinaryRequests = computed(() => conversationRequests.value
  .filter((request) => ordinaryRequestIds.value.has(text(request.id))
    || (request.status !== 'terminal' && isNativeRequest(request)
      && requestProjections.value.has(text(request.id)))));
const latestOrdinaryRequest = computed(() => ordinaryRequests.value[0]);
const currentContextStatus = computed(() => Object.values(
  reliableConversation.feed.records.ConversationContextStatus ?? {}
).find((status) => status.conversation_id === reliableConversation.conversationId.value));
const latestOrdinaryProjection = computed(() => {
  const requestId = text(latestOrdinaryRequest.value?.id);
  if (!requestId) return undefined;
  return requestProjections.value.get(requestId);
});
// Configuration may fall back to a compression request before an ordinary response is linked, but
// usage below must never use that compaction call as the conversation-context baseline.
const latestRequest = computed(() => latestOrdinaryRequest.value ?? conversationRequests.value[0]);
const providerConfig = computed(() => activeProviderConfig());
const modelId = computed(() => text(latestRequest.value?.model_id) || selectedModelId(providerConfig.value));
const modelConfig = computed(() => providerConfig.value?.modelConfigs.find((candidate) => candidate.modelId === modelId.value));
const contextWindowTokens = computed(() =>
  positiveInteger(latestRequest.value?.context_window_tokens)
  ?? positiveInteger(latestRequest.value?.contextWindowTokens)
  ?? nestedToken(latestRequest.value?.model_profile_json, 'contextWindowTokens', 'context_window_tokens')
  ?? positiveInteger(modelConfig.value?.contextWindowTokens)
  ?? positiveInteger(providerConfig.value?.contextWindowTokens)
);
const inputObservation = computed<ContextInputObservation>(() => {
  let latest: ContextInputObservation | undefined;
  for (const [index, request] of ordinaryRequests.value.entries()) {
    const requestId = text(request.id);
    const observation = observeContextInput({
      native: isNativeRequest(request),
      usage: reliableConversation.feed.transientModelRequests[requestId]?.usageMetadata ?? usageFromRequest(request),
      streamStats: request.stream_stats_json,
      requestRootId: text(requestProjections.value.get(requestId)?.root_id),
      currentRootId: text(currentContextStatus.value?.root_id)
    });
    latest ??= observation;
    // Keep the preceding observed input through a new request's streaming/retry phase. Select
    // committed request facts in this Conversation; no cached display number or estimated fill.
    if (observation.tokens !== undefined) return index === 0
      ? observation
      : { ...observation, quality: 'recent' };
  }
  return latest ?? { native: false, quality: 'unknown' };
});
const estimatedContextTokens = computed(() => currentRootEstimatedTokens(
  text(currentContextStatus.value?.root_id),
  currentContextStatus.value?.estimated_tokens,
  text(latestOrdinaryProjection.value?.root_id),
  latestOrdinaryRequest.value?.estimated_context_tokens
));
// Use provider input for the label and fill; estimates remain separate compression hints.
const displayedContextTokens = computed(() => inputObservation.value.tokens);
const usageQuality = computed(() => inputObservation.value.quality);
const currentConfiguredWindow = computed(() => positiveInteger(modelConfig.value?.contextWindowTokens)
  ?? positiveInteger(providerConfig.value?.contextWindowTokens));
const currentConfiguredThreshold = computed(() => configuredCompressionThreshold(currentConfiguredWindow.value));
const automaticCompression = computed(() => {
  const config = configuredCompressionConfig();
  return config !== undefined && config.kind !== 'disabled' && config.trigger.mode === 'token_threshold';
});
const compressionHint = computed(() => compressionEstimateHint({
  automatic: automaticCompression.value,
  observation: inputObservation.value,
  estimatedTokens: estimatedContextTokens.value,
  thresholdTokens: currentConfiguredThreshold.value
}));
const compressionHintLabel = computed(() => compressionHint.value?.atThreshold
  ? '预估达阈值' : '临近压缩');
const currentCompressionMode = computed(() => {
  const config = configuredCompressionConfig();
  if (config?.kind === 'disabled') return '已关闭';
  if (config?.trigger.mode === 'manual') return '仅手动压缩';
  return tokenValueLabel(currentConfiguredThreshold.value);
});
const usageRatio = computed(() => displayedContextTokens.value !== undefined && contextWindowTokens.value !== undefined
  ? displayedContextTokens.value / contextWindowTokens.value
  : undefined);
const fillStyle = computed(() => ({
  width: usageRatio.value === undefined ? '0%' : `${Math.max(0, Math.min(1, usageRatio.value)) * 100}%`
}));
const thresholdStyle = computed(() => ({
  left: contextWindowTokens.value && currentConfiguredThreshold.value !== undefined
    ? `${Math.max(0, Math.min(100, currentConfiguredThreshold.value / contextWindowTokens.value * 100))}%`
    : '100%'
}));
const compactLabel = computed(() => {
  const used = displayedContextTokens.value === undefined ? '?' : formatCompactTokenNumber(displayedContextTokens.value);
  const window = contextWindowTokens.value === undefined ? '?' : formatCompactTokenNumber(contextWindowTokens.value);
  return `${used} / ${window}`;
});
const percentLabel = computed(() => usageRatio.value === undefined ? '未知' : `${(usageRatio.value * 100).toFixed(usageRatio.value < 0.1 ? 1 : 0)}%`);
const tooltipRows = computed(() => [
  { label: '模型', value: modelId.value || '未知' },
  { label: '输入', value: tokenValueLabel(displayedContextTokens.value) },
  { label: '窗口', value: tokenValueLabel(contextWindowTokens.value) },
  { label: '占比', value: percentLabel.value },
  { label: '压缩阈值', value: currentCompressionMode.value },
  ...(compressionHint.value
    ? [{ label: '压缩预估', value: `≈${formatTokenNumber(compressionHint.value.tokens)} Token` }]
    : [])
]);
const overThreshold = computed(() => automaticCompression.value && (
  compressionHint.value?.atThreshold === true
  || (usageQuality.value === 'current' && displayedContextTokens.value !== undefined
    && currentConfiguredThreshold.value !== undefined && displayedContextTokens.value >= currentConfiguredThreshold.value)
));

function activeProviderConfig(): LlmProviderConfigRecord | undefined {
  const providerId = text(latestRequest.value?.provider_id);
  const configs = globalSettings.llmProviderConfigs.configs;
  if (providerId) {
    const frozen = configs.find((config) => config.id === providerId);
    if (frozen) return frozen;
  }
  const conversationId = reliableConversation.conversationId.value;
  const configuredId = conversationId
    ? modelProfiles.localProfileFor('conversation', conversationId).profile?.providerConfigId?.trim() ?? ''
    : '';
  return configs.find((config) => config.id === configuredId)
    ?? configs.find((config) => config.id === globalSettings.llm.activeProviderConfigId)
    ?? configs[0];
}

function selectedModelId(config: LlmProviderConfigRecord | undefined): string {
  if (!config) return '';
  const conversationId = reliableConversation.conversationId.value;
  const profile = conversationId
    ? modelProfiles.localProfileFor('conversation', conversationId).profile
    : undefined;
  const override = profile?.providerConfigId?.trim() === config.id ? profile.model.trim() : '';
  return override || config.model?.trim() || '';
}

function configuredCompressionConfig(): LlmCompressionConfigRecord | undefined {
  const configId = providerConfig.value?.id;
  const model = modelId.value;
  const modelBinding = configId && model
    ? globalSettings.llmCompression.modelBindings.find((item) => item.providerConfigId === configId && item.modelId === model)
    : undefined;
  const providerBinding = configId
    ? globalSettings.llmCompression.providerBindings.find((item) => item.providerConfigId === configId)
    : undefined;
  const compressionId = modelBinding?.compressionConfigId
    ?? providerBinding?.compressionConfigId
    ?? globalSettings.llmCompression.defaultConfigId;
  return globalSettings.llmCompressionConfigs.configs.find((candidate) => candidate.id === compressionId)
    ?? globalSettings.llmCompressionConfigs.configs[0];
}

function configuredCompressionThreshold(contextWindow: number | undefined): number | undefined {
  if (!contextWindow) return undefined;
  const config = configuredCompressionConfig();
  const explicit = config?.trigger.thresholdUnit === 'tokens' ? positiveInteger(config.trigger.thresholdTokens) : undefined;
  if (explicit !== undefined) return Math.min(contextWindow, explicit);
  const percent = finiteNumber(config?.trigger?.thresholdPercent) ?? DEFAULT_LLM_COMPRESSION_TRIGGER_PERCENT;
  return Math.round(contextWindow * Math.max(0, Math.min(100, percent)) / 100);
}

function isNativeRequest(request: Record<string, unknown> | undefined): boolean {
  if (!request) return false;
  const stats = asRecord(typeof request.stream_stats_json === 'string'
    ? parseJson(request.stream_stats_json) : request.stream_stats_json);
  return usageFromRequest(request)?.nativeChainBilling === true
    || stats?.nativeCapabilities !== undefined
    || stats?.nativeInitialPromptTokenCount !== undefined
    || stats?.nativeLatestResponseUsage !== undefined;
}

function usageFromRequest(request: Record<string, unknown> | undefined): LlmUsageMetadataRecord | undefined {
  if (!request) return undefined;
  const value = typeof request.usage_json === 'string' ? parseJson(request.usage_json) : request.usage_json;
  return asRecord(value) as LlmUsageMetadataRecord | undefined;
}

function tokenValueLabel(value: number | undefined): string {
  return value === undefined ? '未知' : `${formatTokenNumber(value)} Token`;
}

function nestedToken(value: unknown, ...keys: string[]): number | undefined {
  const source = asRecord(typeof value === 'string' ? parseJson(value) : value);
  if (!source) return undefined;
  for (const key of keys) {
    const result = positiveInteger(source[key]);
    if (result !== undefined) return result;
  }
  return undefined;
}

function requestOrder(request: Record<string, unknown>): number {
  const turn = conversationTurns.value.get(String(request.turn_id));
  return timestamp(turn?.created_at) || timestamp(request.created_at);
}

function positiveInteger(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number !== undefined && number > 0 ? Math.round(number) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function integer(value: unknown): number {
  const number = finiteNumber(value);
  return number !== undefined && Number.isSafeInteger(number) ? number : 0;
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
</script>

<template>
  <HoverTooltipPanel
    class="reliable-context-status"
    :class="{ 'is-over-threshold': overThreshold, 'is-unknown': displayedContextTokens === undefined }"
    panel-title="LLM 上下文"
    :rows="tooltipRows"
    :delay-ms="180"
  >
    <button type="button" class="reliable-context-button" :aria-label="`LLM 上下文 ${compactLabel}${compressionHint ? `，${compressionHintLabel}` : ''}`">
      <span class="reliable-context-track" aria-hidden="true">
        <span class="reliable-context-fill" :style="fillStyle"></span>
        <span v-if="automaticCompression && currentConfiguredThreshold !== undefined && contextWindowTokens" class="reliable-context-threshold" :style="thresholdStyle"></span>
      </span>
      <span class="reliable-context-label">{{ compactLabel }}</span>
      <span v-if="compressionHint" class="reliable-context-compression-hint">{{ compressionHintLabel }}</span>
    </button>
  </HoverTooltipPanel>
</template>

<style scoped>
.reliable-context-status {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  min-width: 86px;
}

.reliable-context-button {
  width: 100%;
  min-width: 86px;
  min-height: 22px;
  display: inline-grid;
  grid-template-columns: minmax(34px, 1fr) auto;
  align-items: center;
  gap: 6px;
  padding: 2px 6px;
  border: 1px solid var(--vscode-panel-border, transparent);
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font: inherit;
  font-size: var(--font-size-xs);
}

.reliable-context-button:hover,
.reliable-context-button:focus-visible {
  color: var(--vscode-foreground);
  border-color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, transparent);
  outline: none;
}

.reliable-context-track {
  position: relative;
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: color-mix(in srgb, var(--vscode-descriptionForeground) 24%, transparent);
}

.reliable-context-fill {
  position: absolute;
  inset: 0 auto 0 0;
  background: var(--vscode-descriptionForeground);
  transition: width 160ms ease;
}

.reliable-context-threshold {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--vscode-editorWarning-foreground, #cca700);
}

.reliable-context-compression-hint {
  grid-column: 1 / -1;
  justify-self: end;
  color: var(--vscode-editorWarning-foreground, #cca700);
  white-space: nowrap;
}

.reliable-context-label {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.reliable-context-status.is-over-threshold .reliable-context-fill {
  background: var(--vscode-editorWarning-foreground, #cca700);
}

.reliable-context-status.is-unknown .reliable-context-track {
  background: repeating-linear-gradient(
    90deg,
    color-mix(in srgb, var(--vscode-descriptionForeground) 24%, transparent) 0 4px,
    transparent 4px 7px
  );
}

@media (max-width: 720px) {
  .reliable-context-button {
    min-width: 70px;
    grid-template-columns: 20px auto;
  }
}
</style>
