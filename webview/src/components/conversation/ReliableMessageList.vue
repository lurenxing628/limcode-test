<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { MessageRecord, RunTerminationRecord } from '@shared/protocol';
import { projectCompressionNotices, type CompressionNotice as CompressionWarningRecord } from '@shared/compressionNotices';
import { useChat } from '@webview/composables/useChat';
import { messageForkBlocked } from '@webview/composables/forkRequestLifecycle';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { useGlobalSettingsStore } from '@webview/stores/useGlobalSettingsStore';
import { useModelProfileStore } from '@webview/stores/useModelProfileStore';
import { useReliableTimelinePresentationStore } from '@webview/stores/useReliableTimelinePresentationStore';
import {
  parseReliableCompressionRequestPurpose,
  projectReliableCompressionTimeline
} from '@webview/domain/reliableCompressionProjection';
import {
  reliableKernelDetailDemandSignature,
  reliableKernelDetailKey
} from '@webview/domain/reliableDetailKey';
import {
  hasVisibleStreamingTransientForRequestAttempt,
  hasVisibleStreamingTransientForTurn,
  reliableRetryStreamingActivityLabel
} from '@webview/domain/reliableTransientActivity';
import { modelRequestStreamStats } from '@webview/reliability/modelRequestStreamStats';
import { projectCollaborationTimeline } from '@webview/domain/reliableCollaborationTimeline';
import MessageItem from './MessageItem.vue';
import ReliableCollaborationCard from './ReliableCollaborationCard.vue';
import ReliableTurnTerminationRow from './ReliableTurnTerminationRow.vue';
import ReliableCompressionCard from './ReliableCompressionCard.vue';
import ReliableCompressionWarningRow from './ReliableCompressionWarningRow.vue';
import TimelineActivityRow from './TimelineActivityRow.vue';
import {
  TIMELINE_MOUNT_LIMIT,
  TIMELINE_SEGMENT_STEP,
  absoluteTimelineFloor,
  clampTimelineSegmentStart,
  latestTimelineSegmentStart,
  prioritizedTimelineDetailDemand
} from './segmentedTimeline';
import { captureScrollAnchor, restoreScrollAfterHistoryLoad, releaseStickyFromUserScroll, type ScrollAnchor } from './scrollAnchor';

const props = withDefaults(defineProps<{
  emptyHint?: string;
  scroller?: HTMLElement | null;
  followLatest?: boolean;
}>(), {
  emptyHint: '还没有消息，发一条试试。',
  scroller: null,
  followLatest: true
});
const emit = defineEmits<{
  (event: 'edit-message', message: MessageRecord, deleteCount: number): void;
}>();
const { feed, conversationId, projection, ensureDetails } = useReliableConversation();
const {
  retryMessageFrom,
  deleteMessagesFrom,
  forkConversationFrom,
  compressContext,
  conversationAction,
  conversationActionPending,
  conversationActionLabel,
  conversationActionNotice,
  conversationForkReadyNotice,
  openForkReadyNotice,
  dismissForkReadyNotice,
  forkPendingTargetIds,
  currentAuthoritySelection
} = useChat();
const globalSettings = useGlobalSettingsStore();
const modelProfiles = useModelProfileStore();
const timelinePresentation = useReliableTimelinePresentationStore();
const messages = computed(() => projection.value.messages);
const mountedTransientRequestIds = computed(() => new Set(messages.value.flatMap((message) =>
  message.id.startsWith('transient:')
    ? [message.id.slice('transient:'.length)]
    : []
)));
const compressionBlocks = computed(() => Object.values(feed.records.CompressionBlock ?? {})
  .filter((block) => block.conversation_id === conversationId.value && block.status !== 'soft_deleted')
  .filter((block) => !timelinePresentation.isSuppressed(
    conversationId.value,
    'compression-block',
    reliableText(block.id)
  ))
  .sort((left, right) => String(left.created_at ?? '').localeCompare(String(right.created_at ?? ''))));
const segmentStart = ref(0);
const followLatestSegment = ref(true);
const pendingHistoryAnchorId = ref<string | null>(null);
const pendingScrollAnchor = ref<ScrollAnchor | null>(null);
const visibleTimelineRows = computed(() => messages.value.slice(
  segmentStart.value,
  segmentStart.value + TIMELINE_MOUNT_LIMIT
));
const earliestLoadedFloor = computed(() => {
  const first = messages.value[0];
  if (!first) return 0;
  return projection.value.absoluteFloorByMessageId[first.id] ?? first.seq;
});
const hasLoadedFloorGap = computed(() => {
  let previous = 0;
  for (const message of messages.value) {
    const floor = projection.value.absoluteFloorByMessageId[message.id];
    if (!floor) continue;
    if (previous > 0 && floor > previous + 1) return true;
    previous = Math.max(previous, floor);
  }
  return false;
});
const canRequestEarlierHistory = computed(() =>
  feed.historyConversationId === conversationId.value
  && feed.historyHasMore
  && (earliestLoadedFloor.value > 1 || hasLoadedFloorGap.value)
);
const hasEarlierSegment = computed(() => segmentStart.value > 0 || canRequestEarlierHistory.value);
const hasLaterSegment = computed(() => segmentStart.value + TIMELINE_MOUNT_LIMIT < messages.value.length);
const earlierSegmentLabel = computed(() => feed.historyLoading
  ? '正在加载更早内容'
  : feed.historyError && segmentStart.value === 0
    ? '重试加载更早内容'
    : segmentStart.value > 0
      ? `显示更早内容（前方 ${segmentStart.value} 个步骤）`
      : '显示更早内容'
);
const compressionTimeline = computed(() => projectReliableCompressionTimeline(
  compressionBlocks.value,
  messages.value.map((message) => ({ id: message.id, createdAt: message.createdAt }))
));
const compressionBlocksByAnchor = computed(() => compressionTimeline.value.byAnchor);
const terminationRowsByAnchor = computed(() => {
  const result: Record<string, RunTerminationRecord[]> = {};
  for (const [messageId, termination] of Object.entries(projection.value.terminationByMessageId)) {
    const anchor = messages.value.find((message) => message.id === messageId);
    if (anchor?.role !== 'user' || isTerminationSuppressed(termination)) continue;
    (result[messageId] ??= []).push(termination);
  }
  return result;
});

// Collaboration envelopes from or to other Conversations, placed at the Turn they belong to.
const collaborationTimeline = computed(() => projectCollaborationTimeline({
  conversationId: conversationId.value,
  records: feed.records,
  messages: messages.value,
  turnIdByMessageId: projection.value.turnIdByMessageId,
  removedConversationIds: feed.removedConversationIds
}));

const compressionNotices = computed(() => projectCompressionNotices({
  conversationId: conversationId.value, records: feed.records, messages: messages.value,
  turnIdByMessageId: projection.value.turnIdByMessageId,
  placedTerminationIds: Object.values(projection.value.terminationByMessageId).map((item) => item.id)
}));
const compressionWarningsByAnchor = computed(() => Object.fromEntries(
  Object.entries(compressionNotices.value.byAnchor).map(([anchor, notices]) => [anchor,
    notices.filter((notice) => !timelinePresentation.isSuppressed(conversationId.value, 'compression-warning', notice.id))])
));
const unanchoredCompressionWarnings = computed(() => compressionNotices.value.unanchored.filter((notice) =>
  !timelinePresentation.isSuppressed(conversationId.value, 'compression-warning', notice.id)));
const unanchoredTurnFailures = computed(() => compressionNotices.value.unanchoredFailures.filter((notice) =>
  !timelinePresentation.isSuppressed(conversationId.value, 'turn-termination', notice.id)));

watch(
  () => props.followLatest,
  (followLatest) => {
    followLatestSegment.value = followLatest;
    if (followLatest) segmentStart.value = latestTimelineSegmentStart(messages.value.length);
  },
  { immediate: true }
);

watch(
  () => `${messages.value.length}:${messages.value[messages.value.length - 1]?.id ?? ''}`,
  () => {
    const total = messages.value.length;
    segmentStart.value = followLatestSegment.value
      ? latestTimelineSegmentStart(total)
      : clampTimelineSegmentStart(total, segmentStart.value);
  },
  { immediate: true }
);

watch(conversationId, () => {
  pendingHistoryAnchorId.value = null;
  pendingScrollAnchor.value = null;
  followLatestSegment.value = props.followLatest;
  segmentStart.value = props.followLatest
    ? latestTimelineSegmentStart(messages.value.length)
    : clampTimelineSegmentStart(messages.value.length, segmentStart.value);
});

watch(
  () => feed.historyLoadedPages,
  (loadedPages, previousLoadedPages) => {
    if (loadedPages <= previousLoadedPages) return;
    const anchorId = pendingHistoryAnchorId.value;
    pendingHistoryAnchorId.value = null;
    if (!anchorId) return;
    const anchorIndex = messages.value.findIndex((message) => message.id === anchorId);
    if (anchorIndex < 0) return;
    followLatestSegment.value = false;
    segmentStart.value = clampTimelineSegmentStart(
      messages.value.length,
      Math.max(0, anchorIndex - TIMELINE_SEGMENT_STEP)
    );

    void restorePendingScrollAnchor();
  }
);

const activeTurn = computed(() => {
  if (!conversationId.value) return undefined;
  return Object.values(feed.records.Turn ?? {}).find((turn) =>
    turn.conversation_id === conversationId.value && turn.status === 'active'
  );
});
const activeTurnRequests = computed(() => {
  if (!activeTurn.value || typeof activeTurn.value.id !== 'string') return [];
  return Object.values(feed.records.ModelRequest ?? {})
    .filter((request) => request.turn_id === activeTurn.value?.id)
    .sort((left, right) => reliableInteger(right.request_seq) - reliableInteger(left.request_seq));
});
const latestActiveTurnRequest = computed(() => activeTurnRequests.value[0]);
const latestRequestPurposeDetail = computed(() => {
  const requestId = reliableText(latestActiveTurnRequest.value?.id);
  return requestId
    ? feed.details[reliableKernelDetailKey('model-request-purpose', requestId)]
    : undefined;
});
const latestCompressionPurpose = computed(() => {
  const detail = latestRequestPurposeDetail.value;
  return detail?.status === 'ready'
    ? parseReliableCompressionRequestPurpose(detail.text)
    : undefined;
});
const activeCompressionCard = computed<Record<string, unknown> | undefined>(() => {
  const request = latestActiveTurnRequest.value;
  const purpose = latestCompressionPurpose.value;
  if (!request || !purpose || compressionBlocks.value.some((block) => reliableText(block.id) === purpose.blockId)) {
    return undefined;
  }
  const requestStatus = reliableText(request.status);
  const terminalState = reliableText(request.terminal_state);
  if (requestStatus === 'terminal' && terminalState !== 'completed') return undefined;
  const retry = modelRequestRetryState(request);
  const status = requestStatus === 'retrying'
    ? 'retrying'
    : requestStatus === 'streaming'
      ? 'running'
      : requestStatus === 'terminal'
        ? 'committing'
        : 'pending';
  return {
    id: purpose.blockId,
    conversation_id: conversationId.value,
    status,
    title: purpose.trigger === 'auto' ? '自动上下文压缩' : '上下文压缩',
    trigger: purpose.trigger,
    method_kind: purpose.methodKind,
    source_count: purpose.sourceSegmentCount,
    ...(purpose.triggerReason ? { trigger_reason: purpose.triggerReason } : {}),
    ...(purpose.triggerTokens === undefined ? {} : {
      trigger_tokens: purpose.triggerTokens
    }),
    ...(purpose.triggerTokenSource === undefined ? {} : {
      trigger_token_source: purpose.triggerTokenSource
    }),
    ...(purpose.configuredThresholdTokens === undefined ? {} : {
      configured_threshold_tokens: purpose.configuredThresholdTokens
    }),
    model_request_id: reliableText(request.id),
    last_stream_event_at: reliableInteger(modelRequestStreamStats(request)?.lastStreamEventAt),
    created_at: request.created_at,
    retry_reason_label: retry.reasonLabel,
    retry_delay_seconds: Math.max(0, Math.ceil(retry.remainingDelayMs / 1_000)),
    retry_attempt: retry.retryAttempt,
    retry_max_attempts: retry.retryMaxAttempts
  };
});

watch(
  () => {
    const requestId = reliableText(latestActiveTurnRequest.value?.id);
    if (!requestId) return '';
    const status = feed.details[reliableKernelDetailKey('model-request-purpose', requestId)]?.status;
    return `${requestId}:${status ?? 'missing'}`;
  },
  () => {
    const requestId = reliableText(latestActiveTurnRequest.value?.id);
    if (!requestId) return;
    const detail = feed.details[reliableKernelDetailKey('model-request-purpose', requestId)];
    if (!detail) feed.requestDetail('model-request-purpose', requestId, { priority: 'visible' });
  },
  { immediate: true }
);
const activityModelLabel = computed(() => {
  const request = activeTurnRequests.value[0];
  const frozenModel = reliableText(request?.model_id);
  if (frozenModel) return frozenModel;
  for (let index = messages.value.length - 1; index >= 0; index -= 1) {
    const message = messages.value[index];
    if (message?.role === 'model' && message.model?.trim()) return message.model.trim();
  }
  const requestProviderId = reliableText(request?.provider_id);
  const profile = conversationId.value
    ? modelProfiles.localProfileFor('conversation', conversationId.value).profile
    : undefined;
  const configuredProviderId = profile?.providerConfigId?.trim() ?? '';
  const provider = globalSettings.llmProviderConfigs.configs.find((config) => config.id === requestProviderId)
    ?? globalSettings.llmProviderConfigs.configs.find((config) => config.id === configuredProviderId)
    ?? globalSettings.llmProviderConfigs.configs.find((config) => config.id === globalSettings.llm.activeProviderConfigId)
    ?? globalSettings.llmProviderConfigs.configs[0];
  const profileProviderConfigId = profile?.providerConfigId?.trim();
  const override = profile && provider && profileProviderConfigId && profileProviderConfigId === provider.id
    ? profile.model.trim()
    : '';
  return override || provider?.model?.trim() || 'LLM';
});
const activityHeartbeat = computed(() => {
  const request = latestActiveTurnRequest.value;
  if (!request || reliableText(request.status) !== 'streaming') return undefined;
  const stats = modelRequestStreamStats(request);
  const observedAt = reliableInteger(stats?.lastStreamEventAt);
  const streamSeq = reliableText(stats?.lastStreamSeq);
  if (observedAt <= 0 || !streamSeq) return undefined;
  return { observedAt, streamSeq };
});
const activityLabel = computed(() => {
  const action = conversationAction.value;
  if (action?.action === 'retry' && action.phase !== 'running') {
    if (action.phase === 'requesting_stop') return '正在提交停止旧回复的请求';
    if (action.phase === 'stopping') return '正在停止旧回复，完成后将创建重试回合';
    if (action.phase === 'submitting') return conversationActionLabel.value ?? '旧回复已停止，正在创建重试回合';
    return '正在等待旧回复停止后开始重试';
  }
  const turn = activeTurn.value;
  if (!turn || typeof turn.id !== 'string') return undefined;
  const pendingPlanReview = Object.values(projection.value.interactionByToolCallId).some((interaction) =>
    interaction.turnId === turn.id
    && interaction.kind === 'plan_review'
    && interaction.status === 'pending'
  );
  if (pendingPlanReview) return '等待你审批 Plan';
  const latest = latestActiveTurnRequest.value;
  if (!latest) return '正在准备上下文';
  if (activeCompressionCard.value) return undefined;
  const retry = modelRequestRetryState(latest);
  // Keep the durable retry identity while the exact Attempt is waiting for output. Once its
  // transient renders model-owned content, the content itself replaces this activity row.
  if (latest.status === 'retrying') {
    const delaySeconds = Math.max(0, Math.ceil(retry.remainingDelayMs / 1_000));
    return `${retry.reasonLabel}，${delaySeconds} 秒后自动恢复（第 ${retry.retryAttempt}/${retry.retryMaxAttempts} 次）`;
  }
  if (latest.status === 'streaming' && retry.retryAttempt > 0) {
    const modelRequestId = reliableText(latest.id);
    return reliableRetryStreamingActivityLabel({
      retryAttempt: retry.retryAttempt,
      retryMaxAttempts: retry.retryMaxAttempts,
      hasVisibleOutput: Boolean(modelRequestId) && hasVisibleStreamingTransientForRequestAttempt(
        feed.transientModelRequests,
        modelRequestId,
        String(retry.retryAttempt + 1),
        mountedTransientRequestIds.value
      )
    });
  }
  if (hasVisibleStreamingTransientForTurn(
    feed.transientModelRequests,
    turn.id,
    mountedTransientRequestIds.value
  )) return undefined;
  const activeTool = Object.values(feed.records.ToolCall ?? {}).find((call) =>
    call.turn_id === turn.id && call.status !== 'terminal'
  );
  if (activeTool) return undefined;
  if (latest.status === 'prepared' || latest.status === 'pending') {
    return '正在启动 LLM 请求';
  }
  if (latest.status === 'streaming') {
    const heartbeat = activityHeartbeat.value;
    return heartbeat
      ? `正在等待 LLM 终态 · 最近流活动 ${formatActivityTime(heartbeat.observedAt)} · #${heartbeat.streamSeq}`
      : '正在等待 LLM 输出';
  }
  return 'LLM 结果已提交，正在准备工具或下一轮';
});
const retryBoundaryLabel = computed(() => {
  const action = conversationAction.value;
  return action?.action === 'retry' && action.phase === 'running'
    ? conversationActionLabel.value ?? '正在重新生成回复'
    : undefined;
});
const visibleRetryBoundaryMessageId = computed(() => {
  const turnId = conversationAction.value?.action === 'retry'
    ? conversationAction.value.operationTurnId
    : undefined;
  if (!turnId) return undefined;
  return visibleTimelineRows.value.find((message) =>
    projection.value.turnIdByMessageId[message.id] === turnId
  )?.id;
});

watch(
  () => [
    ...visibleTimelineRows.value.map(messageDetailDemandSignature),
    ...Object.entries(projection.value.interactionByToolCallId)
      .filter(([, interaction]) => interaction.status === 'pending')
      .map(([toolCallId]) => toolCallId)
  ].join('|'),
  () => {
    const pinnedDetailKeys = visibleTimelineRows.value.flatMap((message) => {
      const revisionId = projection.value.messageRevisionIdByMessageId[message.id];
      return revisionId ? [reliableKernelDetailKey('message-content', revisionId)] : [];
    });
    feed.setPinnedDetailKeys(pinnedDetailKeys);
    const demand = prioritizedTimelineDetailDemand(
      visibleTimelineRows.value.map((message) => message.id)
    );
    // The body nearest the composer must win the first transport slot. Pending interactions remain
    // critical, but are admitted only after that body so an old Conversation never paints its tail
    // last merely because the mounted segment is ordered chronologically.
    ensureDetails({ messageIds: demand.critical, priority: 'critical', includePendingInteractions: false });
    ensureDetails({ priority: 'critical', includePendingInteractions: true });
    ensureDetails({ messageIds: demand.visible, priority: 'visible', includePendingInteractions: false });
    ensureDetails({ messageIds: demand.background, priority: 'background', includePendingInteractions: false });
  },
  { immediate: true }
);

onBeforeUnmount(() => feed.setPinnedDetailKeys([]));

function deleteCount(message: MessageRecord): number {
  const index = messages.value.findIndex((candidate) => candidate.id === message.id);
  return index < 0 ? 1 : messages.value.length - index;
}

function runHadCompletedTools(message: MessageRecord): boolean {
  const turnId = projection.value.turnIdByMessageId[message.id];
  if (!turnId) return false;
  return projection.value.toolCalls.some((call) =>
    (call.status === 'success' || call.status === 'warning' || call.status === 'error')
    && (call.messageId === message.id || projection.value.turnIdByMessageId[call.messageId] === turnId)
  );
}

async function restorePendingScrollAnchor(): Promise<void> {
  const anchor = pendingScrollAnchor.value;
  const scroller = props.scroller;
  const conversation = conversationId.value;
  await nextTick();
  if (pendingScrollAnchor.value !== anchor || props.scroller !== scroller || conversationId.value !== conversation) return;
  pendingScrollAnchor.value = null;
  restoreScrollAfterHistoryLoad({ scroller, anchor });
}

function showEarlierSegment(): void {
  if (feed.historyLoading || !hasEarlierSegment.value) return;
  const scroller = props.scroller;
  pendingScrollAnchor.value = captureScrollAnchor({
    scroller,
    visibleRows: visibleTimelineRows.value
  });
  releaseStickyFromUserScroll(scroller);

  if (segmentStart.value > 0) {
    followLatestSegment.value = false;
    segmentStart.value = clampTimelineSegmentStart(
      messages.value.length,
      segmentStart.value - TIMELINE_SEGMENT_STEP
    );
    void restorePendingScrollAnchor();
  } else if (canRequestEarlierHistory.value) {
    followLatestSegment.value = false;
    const anchorId = visibleTimelineRows.value[0]?.id ?? null;
    if (feed.requestEarlierHistory(conversationId.value)) {
      pendingHistoryAnchorId.value = anchorId;
    } else {
      pendingScrollAnchor.value = null;
    }
  }
}

function showLaterSegment(): void {
  const next = clampTimelineSegmentStart(
    messages.value.length,
    segmentStart.value + TIMELINE_SEGMENT_STEP
  );
  segmentStart.value = next;
  followLatestSegment.value = next >= latestTimelineSegmentStart(messages.value.length);
}

function retryFrom(message: MessageRecord): void {
  if (!message.retryTarget) return;
  retryMessageFrom(
    message.conversationId,
    message.retryTarget,
    currentAuthoritySelection(),
    projection.value.messageRevisionIdByMessageId[message.id],
    timelineFloor(
      message,
      messages.value.findIndex((candidate) => candidate.id === message.id) - segmentStart.value
    )
  );
}

function retryBlocked(message: MessageRecord): boolean {
  if ((conversationActionPending.value && isConversationActionTarget(message)) || !message.retryTarget) return true;
  return message.retryTarget.kind === 'message'
    && !projection.value.messageRevisionIdByMessageId[message.id];
}

function deleteFrom(message: MessageRecord): void {
  deleteMessagesFrom(message.conversationId, message.id);
}

function forkBlocked(message: MessageRecord): boolean {
  // A fork copies completed turns only; messages of the running turn become forkable once it ends.
  return messageForkBlocked(message, {
    activeTurnId: reliableText(activeTurn.value?.id),
    pendingMessageIds: forkPendingTargetIds.value,
    revisionIdByMessageId: projection.value.messageRevisionIdByMessageId,
    turnIdByMessageId: projection.value.turnIdByMessageId
  });
}

function forkFrom(message: MessageRecord): void {
  const revisionId = projection.value.messageRevisionIdByMessageId[message.id];
  if (revisionId) forkConversationFrom(message.conversationId, message.id, revisionId);
}

function compactTo(message: MessageRecord): void {
  compressContext(message.conversationId, { kind: 'through_message', messageId: message.id });
}

function isConversationActionTarget(message: MessageRecord): boolean {
  const action = conversationAction.value;
  if (!action) return false;
  if (action.action !== 'retry') return action.targetId === message.id;
  const target = message.retryTarget;
  return target?.kind === 'message'
    ? target.messageId === action.targetId
    : target?.modelRequestId === action.targetId;
}

function messageTermination(message: MessageRecord): RunTerminationRecord | undefined {
  if (message.role !== 'model') return undefined;
  return projection.value.terminationByMessageId[message.id];
}

function isMessageTerminationSuppressed(message: MessageRecord): boolean {
  const termination = messageTermination(message);
  return termination ? isTerminationSuppressed(termination) : false;
}

function isTerminationSuppressed(termination: RunTerminationRecord): boolean {
  return timelinePresentation.isSuppressed(conversationId.value, 'turn-termination', termination.id);
}

function dismissTermination(termination: RunTerminationRecord): void {
  timelinePresentation.suppress(conversationId.value, 'turn-termination', termination.id);
}

function dismissCompression(block: Record<string, unknown>): void {
  timelinePresentation.suppress(conversationId.value, 'compression-block', reliableText(block.id));
}

function dismissCompressionWarning(warning: CompressionWarningRecord): void {
  timelinePresentation.suppress(conversationId.value, 'compression-warning', warning.id);
}

function messageDetailDemandSignature(message: MessageRecord): string {
  const revisionId = projection.value.messageRevisionIdByMessageId[message.id];
  if (!revisionId) return `message:${message.id}:no-revision`;
  const status = feed.details[reliableKernelDetailKey('message-content', revisionId)]?.status;
  return reliableKernelDetailDemandSignature({
    hydrate: true,
    callId: message.id,
    targets: [{ kind: 'message-content', recordId: revisionId, status }]
  });
}

function messageDetailReady(message: MessageRecord): boolean {
  const revisionId = projection.value.messageRevisionIdByMessageId[message.id];
  if (!revisionId) return false;
  return feed.details[reliableKernelDetailKey('message-content', revisionId)]?.status === 'ready';
}

function messageDetailLoading(message: MessageRecord): boolean {
  if (message.content.parts.length > 0) return false;
  const revisionId = projection.value.messageRevisionIdByMessageId[message.id];
  if (!revisionId) return false;
  const status = feed.details[reliableKernelDetailKey('message-content', revisionId)]?.status;
  return status === undefined || status === 'loading';
}

function timelineFloor(message: MessageRecord, visibleIndex: number): number {
  const projected = projection.value.absoluteFloorByMessageId[message.id] ?? message.seq;
  return absoluteTimelineFloor(projected, segmentStart.value + visibleIndex + 1);
}

function formatActivityTime(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '未知';
}

function modelRequestRetryState(request: Record<string, unknown>): {
  retryAttempt: number;
  retryMaxAttempts: number;
  remainingDelayMs: number;
  reasonLabel: 'LLM 输出停滞' | 'LLM 连接异常' | '上下文压缩超时';
} {
  const stats = modelRequestStreamStats(request);
  const attemptSeq = Math.max(1, reliableInteger(stats?.attemptSeq));
  const retryDelayMs = Math.max(0, reliableInteger(stats?.retryDelayMs));
  const retryNotBeforeAt = Math.max(0, reliableInteger(stats?.retryNotBeforeAt));
  const retryReason = reliableText(stats?.retryReason);
  return {
    retryAttempt: Math.max(0, attemptSeq - 1),
    retryMaxAttempts: Math.max(attemptSeq - 1, reliableInteger(stats?.retryMaxAttempts)),
    remainingDelayMs: retryNotBeforeAt > 0 ? Math.max(0, retryNotBeforeAt - Date.now()) : retryDelayMs,
    reasonLabel: retryReason === 'compression_timeout'
      ? '上下文压缩超时'
      : retryReason === 'stream_stalled' || retryReason === 'first_semantic_timeout'
        ? 'LLM 输出停滞'
        : 'LLM 连接异常'
  };
}

function reliableInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return 0;
}

function reliableText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function messageRenderKey(message: MessageRecord): string {
  const transientRequestId = message.id.startsWith('transient:')
    ? message.id.slice('transient:'.length)
    : undefined;
  const modelRequestId = transientRequestId
    || projection.value.modelRequestIdByMessageId[message.id];
  return modelRequestId ? `model-request:${modelRequestId}` : `message:${message.id}`;
}
</script>

<template>
  <div class="reliable-message-list">
    <button
      v-if="hasEarlierSegment"
      type="button"
      class="reliable-segment-control"
      :disabled="feed.historyLoading"
      @click="showEarlierSegment"
    >
      {{ earlierSegmentLabel }}
    </button>
    <p
      v-if="feed.historyError && segmentStart === 0"
      class="reliable-history-error"
      role="alert"
    >
      {{ feed.historyError }}
    </p>
    <div
      v-for="(message, index) in visibleTimelineRows"
      :key="messageRenderKey(message)"
      class="reliable-message-row"
      :data-timeline-row-key="message.id"
    >
      <p
        v-if="retryBoundaryLabel && visibleRetryBoundaryMessageId === message.id"
        class="reliable-retry-boundary"
        role="status"
      >
        {{ retryBoundaryLabel }}
      </p>
      <ReliableCollaborationCard
        v-for="card in collaborationTimeline.beforeMessage[message.id] ?? []"
        :key="`collaboration:${card.messageId}`"
        :card="card"
        :data-timeline-row-key="`collaboration:${card.messageId}`"
      />
      <MessageItem
        :message="message"
        :run-id="projection.turnIdByMessageId[message.id]"
        :termination="messageTermination(message)"
        :termination-notice-suppressed="isMessageTerminationSuppressed(message)"
        :run-had-completed-tools="runHadCompletedTools(message)"
        :delete-count="deleteCount(message)"
        :compact-count="Math.max(1, timelineFloor(message, index))"
        :detail-loading="messageDetailLoading(message)"
        :detail-ready="messageDetailReady(message)"
        :mutation-pending="conversationActionPending && isConversationActionTarget(message)"
        :mutation-blocked="(conversationActionPending && isConversationActionTarget(message)) || !projection.messageRevisionIdByMessageId[message.id]"
        :retry-blocked="retryBlocked(message)"
        :compact-blocked="(conversationActionPending && isConversationActionTarget(message)) || !projection.messageRevisionIdByMessageId[message.id]"
        :fork-blocked="forkBlocked(message)"
        :pending-label="conversationActionLabel ?? '正在提交操作'"
        :floor-number="timelineFloor(message, index)"
        @edit-message="emit('edit-message', message, deleteCount(message))"
        @retry-from="retryFrom"
        @delete-from="deleteFrom"
        @fork-from="forkFrom"
        @compact-to="compactTo"
        @dismiss-termination="dismissTermination"
      />
      <ReliableTurnTerminationRow
        v-for="termination in terminationRowsByAnchor[message.id] ?? []"
        :key="termination.id"
        :termination="termination"
        @dismiss="dismissTermination(termination)"
      />
      <ReliableCompressionWarningRow
        v-for="warning in compressionWarningsByAnchor[message.id] ?? []"
        :key="warning.id"
        :title="warning.title"
        :detail="warning.detail"
        @dismiss="dismissCompressionWarning(warning)"
      />
      <ReliableCompressionCard
        v-for="block in compressionBlocksByAnchor[message.id] ?? []"
        :key="`compression:${String(block.id)}`"
        :block="block"
        :data-timeline-row-key="`compression:${String(block.id)}`"
        @dismiss="dismissCompression(block)"
      />
      <ReliableCollaborationCard
        v-for="card in collaborationTimeline.afterMessage[message.id] ?? []"
        :key="`collaboration:${card.messageId}`"
        :card="card"
        :data-timeline-row-key="`collaboration:${card.messageId}`"
      />
    </div>
    <button
      v-if="hasLaterSegment"
      type="button"
      class="reliable-segment-control"
      @click="showLaterSegment"
    >
      显示较新内容
    </button>
    <p
      v-if="retryBoundaryLabel && !visibleRetryBoundaryMessageId"
      class="reliable-retry-boundary"
      role="status"
    >
      {{ retryBoundaryLabel }}
    </p>
    <template v-if="!hasLaterSegment">
      <ReliableCompressionWarningRow v-for="warning in unanchoredCompressionWarnings"
        :key="warning.id" :title="warning.title" :detail="warning.detail"
        @dismiss="dismissCompressionWarning(warning)" />
      <ReliableCompressionWarningRow v-for="failure in unanchoredTurnFailures"
        :key="failure.id" :title="failure.title" :detail="failure.detail" severity="error"
        @dismiss="timelinePresentation.suppress(conversationId, 'turn-termination', failure.id)" />
    </template>
    <template v-if="!hasLaterSegment">
      <ReliableCollaborationCard
        v-for="card in collaborationTimeline.unbound"
        :key="`collaboration:${card.messageId}`"
        :card="card"
        :data-timeline-row-key="`collaboration:${card.messageId}`"
      />
    </template>
    <ReliableCompressionCard
      v-if="activeCompressionCard && !hasLaterSegment"
      :key="`compression:${String(activeCompressionCard.id)}`"
      :block="activeCompressionCard"
      data-timeline-row-key="active-compression"
    />
    <TimelineActivityRow
      v-if="activityLabel && !hasLaterSegment"
      activity-kind="preparing"
      :label="activityLabel"
      :model-label="activityModelLabel"
    />
    <p v-if="conversationActionNotice" class="reliable-action-notice" role="status">
      {{ conversationActionNotice }}
    </p>
    <p v-if="conversationForkReadyNotice" class="reliable-action-notice reliable-fork-ready" role="status">
      <span>{{ conversationForkReadyNotice.replayed ? '之前的分支请求已完成，分支已创建。' : '分支已创建。' }}</span>
      <button type="button" @click="openForkReadyNotice">打开分支</button>
      <button type="button" aria-label="关闭分支提示" @click="dismissForkReadyNotice">关闭</button>
    </p>
    <div v-if="messages.length === 0 && !activityLabel && !activeCompressionCard" class="reliable-message-empty-container">
      <p class="reliable-message-empty">{{ emptyHint }}</p>
    </div>
  </div>
</template>

<style scoped>
.reliable-retry-boundary {
  margin: 4px 0 2px;
  padding: 5px 8px;
  border-left: 2px solid var(--vscode-focusBorder, #007acc);
  color: var(--vscode-descriptionForeground);
  background: color-mix(in srgb, var(--vscode-editor-background) 94%, var(--vscode-focusBorder, #007acc) 6%);
  font-size: var(--font-size-sm);
}

.reliable-message-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  overflow-anchor: none;
}

.reliable-message-row {
  display: block;
}

.reliable-segment-control {
  align-self: center;
  margin: var(--space-2) 0;
  min-height: 28px;
  padding: 0 var(--space-3);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  color: var(--vscode-descriptionForeground);
  background: transparent;
}

.reliable-segment-control:hover,
.reliable-segment-control:focus-visible {
  color: var(--vscode-foreground);
  background: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-foreground) 12%));
  outline: none;
}

.reliable-segment-control:disabled {
  cursor: default;
  opacity: 0.65;
}

.reliable-history-error {
  align-self: center;
  margin: 0 var(--space-3) var(--space-2);
  color: var(--vscode-errorForeground);
  font-size: var(--font-size-sm);
  text-align: center;
}

.reliable-action-notice {
  align-self: center;
  margin: var(--space-2) var(--space-3);
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
  text-align: center;
}

.reliable-fork-ready {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--space-2);
}

.reliable-fork-ready button {
  padding: 1px var(--space-2);
  border: 1px solid var(--vscode-panel-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--vscode-foreground);
  font: inherit;
  cursor: pointer;
}

.reliable-fork-ready button:hover,
.reliable-fork-ready button:focus-visible {
  outline: 1px solid color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
  outline-offset: 1px;
  background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-foreground) 8%);
}

.reliable-message-empty-container {
  padding: var(--space-6) var(--conversation-content-padding-right, var(--space-4))
    var(--space-6) var(--conversation-content-padding-left, var(--space-4));
}

.reliable-message-empty {
  margin: var(--space-6) 0 0;
  text-align: center;
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-sm);
}
</style>
