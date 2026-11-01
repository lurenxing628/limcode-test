<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { MessageRecord, RunTerminationRecord } from '@shared/protocol';
import { projectCompressionNotices, type CompressionNotice as CompressionWarningRecord } from '@shared/compressionNotices';
import { useChat } from '@webview/composables/useChat';
import { messageForkBlocked } from '@webview/composables/forkRequestLifecycle';
import { useReliableConversation } from '@webview/composables/useReliableConversation';
import { USER_SCROLL_INTENT_EVENT, userScrollIntentDetail } from '@webview/composables/scrollIntent';
import { useSessionStore } from '@webview/stores/useSessionStore';
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
  createReliableRetryClock,
  reliableRetryStreamingActivityLabel,
  reliableRetryDelaySourceLabel,
  reliableRetryFailureLabel
} from '@webview/domain/reliableTransientActivity';
import { createReliableModelRequestRetryIndex, createTurnProjectionIndex, modelRequestRetryForTurn, projectReliableTurnTermination } from '@webview/domain/reliableConversationProjection';
import { modelRequestStreamStats } from '@webview/reliability/modelRequestStreamStats';
import { turnInputEchoContent, turnInputEchoMessage } from '@webview/domain/reliableTurnInputSubmission';
import { collaborationCardPlacementLabel, projectCollaborationTimeline } from '@webview/domain/reliableCollaborationTimeline';
import MessageItem from './MessageItem.vue';
import ConfirmPanel from '@webview/components/ui/ConfirmPanel.vue';
import ReliableCollaborationCard from './ReliableCollaborationCard.vue';
import ReliableTurnTerminationRow from './ReliableTurnTerminationRow.vue';
import { isManualStop } from './terminationNotice';
import ReliableCompressionCard from './ReliableCompressionCard.vue';
import ReliableCompressionWarningRow from './ReliableCompressionWarningRow.vue';
import TimelineActivityRow from './TimelineActivityRow.vue';
import {
  TIMELINE_MOUNT_LIMIT,
  PENDING_TIMELINE_MOUNT_LIMIT,
  TIMELINE_SEGMENT_STEP,
  absoluteTimelineFloor,
  composeTimelineRows,
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
  (event: 'resend-as-new', message: MessageRecord): void;
}>();
const session = useSessionStore();
const { feed, conversationId, projection, ensureDetails, completeMessageContent } = useReliableConversation();
const {
  retryMessageFrom,
  deleteMessagesFrom,
  forkConversationFrom,
  compressContext,
  conversationAction,
  conversationActionPending,
  conversationActionLabel,
  conversationActionNotice,
  unconfirmedHistoryCommands,
  dismissUnconfirmedHistoryCommands,
  conversationForkReadyNotice,
  openForkReadyNotice,
  dismissForkReadyNotice,
  forkPendingTargetIds,
  currentAuthoritySelection,
  currentTurnInputEchoes,
  retryTurnInputSubmission
} = useChat();
const historyDismissSelection = shallowRef<NonNullable<typeof unconfirmedHistoryCommands.value>>();
function confirmHistoryDismiss(): void {
  const selection = historyDismissSelection.value;
  historyDismissSelection.value = undefined;
  if (selection) dismissUnconfirmedHistoryCommands(selection);
}
watch(() => [conversationId.value, feed.sessionId, feed.hostBootId], () => {
  historyDismissSelection.value = undefined;
}, { flush: 'sync' });
const globalSettings = useGlobalSettingsStore();
const modelProfiles = useModelProfileStore();
const timelinePresentation = useReliableTimelinePresentationStore();
const messages = computed(() => projection.value.messages);
const submissionEchoByMessageId = computed(() => Object.fromEntries(currentTurnInputEchoes.value.flatMap((echo) =>
  echo.displayTarget ? [[echo.displayTarget.messageId, echo] as const] : [])));
const unlocatedSubmissionEchoes = computed(() => currentTurnInputEchoes.value
  .filter((echo) => !echo.displayTarget).slice(-PENDING_TIMELINE_MOUNT_LIMIT));
function displayedMessage(message: MessageRecord): MessageRecord {
  const echo = submissionEchoByMessageId.value[message.id];
  return echo ? { ...message, content: turnInputEchoContent(echo) } : message;
}
const messageOrderIds = computed(() => projection.value.index.messageIds);
const messageMetadata = computed(() => projection.value.index.messageMetadata);
const messagePositions = computed(() => projection.value.index.messagePositionById);
const compressionPositions = computed(() => projection.value.index.compressionPositions);
const absoluteFloors = computed(() => projection.value.absoluteFloorByMessageId);
const splitSourceMessageIds = computed(() => projection.value.splitSourceMessageIdByMessageId);
const terminations = computed(() => projection.value.terminationByMessageId);
const mountedTransientRequestIds = computed(() => new Set(messageOrderIds.value.flatMap((id) =>
  id.startsWith('transient:')
    ? [id.slice('transient:'.length)]
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
const pendingHistoryDirection = ref<'before' | 'after'>('before');
const pendingCollaborationPageForReading = ref(false);
const pendingScrollAnchor = ref<ScrollAnchor | null>(null);
const readingRoot = ref<HTMLElement | null>(null);
let readingScrollAnchor: ScrollAnchor | null = null;
let readingScroller: HTMLElement | null = null;
let readingScrollTop: number | undefined;
let readingResizeObserver: ResizeObserver | undefined;
/** Timeline rows present when the user asked for older collaboration records. */
const pendingCollaborationRowIds = shallowRef<Set<string> | null>(null);
const collaborationSearching = ref(false);
const collaborationSearchDirection = ref<'before' | 'after'>('before');
const collaborationSearchNotice = ref('');
const collaborationSearchStart = ref(0);
const collaborationScanned = computed(() => Math.max(0, feed.collaborationHistoryScannedRows - collaborationSearchStart.value));
let collaborationSearchTimer: ReturnType<typeof setTimeout> | undefined;
function stopCollaborationSearch(notice = '已停止查找'): void {
  if (collaborationSearchTimer !== undefined) clearTimeout(collaborationSearchTimer);
  collaborationSearchTimer = undefined;
  collaborationSearching.value = false;
  pendingCollaborationRowIds.value = null;
  collaborationSearchNotice.value = notice;
}
onBeforeUnmount(() => stopCollaborationSearch(''));
watch(() => feed.sessionId, () => stopCollaborationSearch(''));
watch(() => feed.collaborationHistoryError, error => { if (error) stopCollaborationSearch('查找失败，可从当前位置重试'); });
watch(() => session.runtimeError, error => { if (error) stopCollaborationSearch('运行连接已停止'); });
const canRequestEarlierHistory = computed(() =>
  feed.historyConversationId === conversationId.value && feed.historyHasMore
);
const canRequestLaterHistory = computed(() =>
  feed.historyConversationId === conversationId.value && feed.historyHasMoreAfter
);
const canRequestEarlierCollaboration = computed(() =>
  feed.collaborationHistoryConversationId === conversationId.value && feed.collaborationHistoryHasMoreBefore);
const canRequestLaterCollaboration = computed(() =>
  feed.collaborationHistoryConversationId === conversationId.value && feed.collaborationHistoryHasMoreAfter);
const readingHistoryLoading = computed(() => feed.historyLoading
  || (pendingCollaborationPageForReading.value && feed.collaborationHistoryLoading));
const hasEarlierSegment = computed(() => segmentStart.value > readingRun.value.start
  || canRequestEarlierHistory.value || canRequestEarlierCollaboration.value);
const hasLaterSegment = computed(() => segmentEnd.value < readingRun.value.end
  || readingRun.value.end < timelineRows.value.length || canRequestLaterHistory.value);
const earlierSegmentLabel = computed(() => readingHistoryLoading.value && pendingHistoryDirection.value === 'before'
  ? '正在加载更早内容'
  : feed.historyError && segmentStart.value === readingRun.value.start
    ? '重试加载更早内容'
    : '显示更早内容'
);
const compressionTimeline = computed(() => projectReliableCompressionTimeline(
  compressionBlocks.value,
  { messageIds: messageOrderIds.value, messagePositionById: messagePositions.value, compressionPositions: compressionPositions.value }
));
const compressionBlocksByAnchor = computed(() => compressionTimeline.value.byAnchor);
const messageRoles = computed(() => new Map(messageMetadata.value.map(message => [message.id, message.role])));
// Only rows anchored to the user message render here; a reply's own termination renders in MessageItem.
// A manual stop with no reply left (stopped before output, or its reply deleted afterwards) adds
// nothing the user does not already know, so it is not shown instead of lingering under the question.
const terminationRowsByAnchor = computed(() => {
  const result: Record<string, RunTerminationRecord[]> = {};
  for (const [messageId, termination] of Object.entries(terminations.value)) {
    if (messageRoles.value.get(messageId) !== 'user' || isTerminationSuppressed(termination)
      || isManualStop(termination)) continue;
    (result[messageId] ??= []).push(termination);
  }
  return result;
});

const collaborationRecords = computed(() => feed.committedRecords);
const messageOrder = computed(() => messageOrderIds.value.map(id => ({ id })));
const messageTurnIds = computed(() => projection.value.turnIdByMessageId);
const collaborationTimeline = computed(() => projectCollaborationTimeline({
  conversationId: conversationId.value,
  records: collaborationRecords.value,
  messages: messageOrder.value,
  turnIdByMessageId: messageTurnIds.value,
  removedConversationIds: feed.removedConversationIds,
  peerStateGeneration: feed.peerStateGeneration,
  acceptedAnswerPeerGenerations: feed.acceptedAnswerPeerGenerations,
  acceptedAnswerDetails: feed.details
}));
const timelineRows = computed(() => composeTimelineRows(messageOrder.value, collaborationTimeline.value));
// A released history page is a real gap. Never put its distant neighbour directly beside the
// current page; the same keyset endpoint fills that range when the reader moves through it.
const residentRuns = computed(() => {
  const runs: Array<{ start: number; end: number }> = [];
  let start = 0, priorFloor = 0;
  timelineRows.value.forEach((row, index) => {
    if (row.kind !== 'message') return;
    const floor = absoluteFloors.value[row.message.id] ?? 0;
    if (floor > 0 && priorFloor > 0 && floor > priorFloor + 1) {
      runs.push({ start, end: index }); start = index;
    }
    priorFloor = Math.max(priorFloor, floor);
  });
  runs.push({ start, end: timelineRows.value.length });
  return runs;
});
const readingRun = computed(() => residentRuns.value.find(run => segmentStart.value >= run.start && segmentStart.value < run.end)
  ?? residentRuns.value[residentRuns.value.length - 1]!);
const segmentEnd = computed(() => Math.min(readingRun.value.end, segmentStart.value + TIMELINE_MOUNT_LIMIT));
function clampReadingStart(requested: number): number {
  const run = residentRuns.value.find(candidate => requested >= candidate.start && requested < candidate.end)
    ?? residentRuns.value[residentRuns.value.length - 1]!;
  return Math.max(run.start, Math.min(requested, Math.max(run.start, run.end - TIMELINE_MOUNT_LIMIT)));
}
function latestReadingStart(): number {
  const run = residentRuns.value[residentRuns.value.length - 1]!;
  return Math.max(run.start, run.end - TIMELINE_MOUNT_LIMIT);
}
const visibleRowMembership = computed(() => timelineRows.value.slice(segmentStart.value, segmentEnd.value));
const visibleTimelineRows = computed(() => visibleRowMembership.value.map(row => row.kind === 'message' ? { ...row, message: projection.value.index.messageById.get(row.message.id)! } : row));
const visibleMessageRows = computed(() => visibleTimelineRows.value.flatMap((row) =>
  row.kind === 'message' ? [row.message] : []
));
const hasCollaborationCards = computed(() => timelineRows.value.some((row) => row.kind === 'collaboration'));

const retryRecords = computed(() => feed.committedRecords);
const retryIndex = computed(() => createReliableModelRequestRetryIndex(retryRecords.value, conversationId.value));
function terminationRetry(turnId: string): ReturnType<typeof modelRequestRetryForTurn> {
  return modelRequestRetryForTurn(retryRecords.value, conversationId.value, turnId, retryIndex.value);
}
function retryTerminatedRequest(termination: RunTerminationRecord, requestId: string): void {
  if (conversationActionPending.value) return;
  const retry = terminationRetry(termination.runId);
  if (!retry.target || retry.target.modelRequestId !== requestId) return;
  retryMessageFrom(conversationId.value, retry.target, currentAuthoritySelection());
}
const compressionNotices = computed(() => projectCompressionNotices({
  conversationId: conversationId.value, records: feed.records, messages: messageMetadata.value,
  turnIdByMessageId: messageTurnIds.value,
  placedTerminationIds: Object.values(terminations.value).map((item) => item.id)
}));
const compressionWarningsByAnchor = computed(() => Object.fromEntries(
  Object.entries(compressionNotices.value.byAnchor).map(([anchor, notices]) => [anchor,
    notices.filter((notice) => !timelinePresentation.isSuppressed(conversationId.value, 'compression-warning', notice.id))])
));
const unanchoredCompressionWarnings = computed(() => compressionNotices.value.unanchored.filter((notice) =>
  !timelinePresentation.isSuppressed(conversationId.value, 'compression-warning', notice.id)));
const unanchoredTurnFailures = computed(() => compressionNotices.value.unanchoredFailures.filter((notice) =>
  !timelinePresentation.isSuppressed(conversationId.value, 'turn-termination', notice.id)));
const unanchoredTerminationRows = computed(() => {
  if (!unanchoredTurnFailures.value.length) return [];
  const index = createTurnProjectionIndex(retryRecords.value);
  return unanchoredTurnFailures.value.flatMap((failure) => {
    const raw = retryRecords.value.TurnTermination?.[failure.id];
    const termination = raw ? projectReliableTurnTermination(raw, retryRecords.value, index) : undefined;
    return termination ? [{ termination: { ...termination, detail: failure.detail }, title: failure.title }] : [];
  });
});

watch(
  () => props.followLatest,
  (followLatest) => {
    followLatestSegment.value = followLatest;
    if (followLatest) followLatestReading();
  },
  { immediate: true }
);

let previousRowIds: string[] = [];
watch(
  timelineRows,
  () => {
    const ids = timelineRows.value.map((row) => row.id);
    const previousFirst = previousRowIds[segmentStart.value];
    const anchor = !followLatestSegment.value && !pendingScrollAnchor.value && !pendingCollaborationRowIds.value
      ? captureScrollAnchor({ scroller: props.scroller,
        visibleRows: previousRowIds.slice(segmentStart.value, segmentStart.value + TIMELINE_MOUNT_LIMIT).map((id) => ({ id })) })
      : null;
    previousRowIds = ids;
    if (followLatestSegment.value) {
      segmentStart.value = latestReadingStart();
      return;
    }
    // Rows inserted above the mounted window (an older collaboration page, a card of an earlier
    // Turn) must not shift the rows the user is reading.
    const kept = previousFirst ? ids.indexOf(previousFirst) : -1;
    segmentStart.value = clampReadingStart(kept >= 0 ? kept : segmentStart.value);
    if (anchor) {
      pendingScrollAnchor.value = anchor;
      void restorePendingScrollAnchor();
    }
  },
  { immediate: true }
);

watch(conversationId, () => {
  stopCollaborationSearch('');
  pendingHistoryAnchorId.value = null;
  pendingCollaborationPageForReading.value = false;
  pendingCollaborationRowIds.value = null;
  pendingScrollAnchor.value = null;
  readingScrollAnchor = null;
  readingScrollTop = undefined;
  followLatestSegment.value = props.followLatest;
  segmentStart.value = props.followLatest
    ? latestReadingStart()
    : clampReadingStart(segmentStart.value);
});

watch(
  () => [feed.historyLoadedPages, feed.collaborationHistoryLoadedPages, readingHistoryLoading.value] as const,
  () => {
    if (readingHistoryLoading.value || collaborationSearching.value) return;
    const anchorId = pendingHistoryAnchorId.value;
    pendingHistoryAnchorId.value = null;
    pendingCollaborationPageForReading.value = false;
    if (anchorId) {
      const anchorIndex = timelineRows.value.findIndex((row) => row.id === anchorId);
      if (anchorIndex >= 0) {
        followLatestSegment.value = false;
        segmentStart.value = clampReadingStart(Math.max(0, anchorIndex - (pendingHistoryDirection.value === 'before'
          ? TIMELINE_SEGMENT_STEP : TIMELINE_MOUNT_LIMIT - TIMELINE_SEGMENT_STEP - 1)));
      }
    }
    if (pendingScrollAnchor.value) void restorePendingScrollAnchor();
  }
);

// A collaboration page can fill any proven Message boundary, including between already loaded
// messages. Mount the segment at its first new card instead of assuming the whole page prepends.
watch(
  () => feed.collaborationHistoryLoadedPages,
  (pages, previousPages) => {
    const known = pendingCollaborationRowIds.value;
    if (pages <= previousPages || !known || !collaborationSearching.value) return;
    const firstNew = timelineRows.value.findIndex((row) => row.kind === 'collaboration' && !known.has(row.id));
    if (firstNew >= 0) {
      stopCollaborationSearch(collaborationSearchDirection.value === 'before' ? '已找到更早的协作记录' : '已找到较新的协作记录');
      followLatestSegment.value = false;
      segmentStart.value = clampReadingStart(firstNew);
      return;
    }
    if (!(collaborationSearchDirection.value === 'before' ? feed.collaborationHistoryHasMoreBefore : feed.collaborationHistoryHasMoreAfter)) {
      stopCollaborationSearch(collaborationSearchDirection.value === 'before' ? '没有更早的协作记录' : '没有较新的协作记录');
      return;
    }
    // One request at a time; yield between empty/duplicate pages so progress and Stop can paint.
    collaborationSearchTimer = setTimeout(() => {
      collaborationSearchTimer = undefined;
      if (collaborationSearching.value && !feed.requestCollaborationHistoryPage(conversationId.value, collaborationSearchDirection.value)) {
        stopCollaborationSearch('查找已暂停');
      }
    }, 0);
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
const retryNow = ref(Date.now());
const retryClock = createReliableRetryClock((now) => { retryNow.value = now; });
watch(() => {
  const request = latestActiveTurnRequest.value;
  return request?.status === 'retrying' && !hasLaterSegment.value
    ? reliableInteger(modelRequestStreamStats(request)?.retryNotBeforeAt) : 0;
}, (deadline) => {
  if (deadline > 0) retryClock.start(deadline);
  else retryClock.stop();
}, { immediate: true });
onBeforeUnmount(() => retryClock.stop());
const latestRequestHasVisibleModelRow = computed(() => {
  const requestId = reliableText(latestActiveTurnRequest.value?.id);
  if (!requestId) return false;
  return visibleMessageRows.value.some((message) =>
    message.role === 'model'
    && message.status === 'streaming'
    && message.content.parts.length > 0
    && (message.id === `transient:${requestId}`
      || projection.value.modelRequestIdByMessageId[message.id] === requestId)
  );
});
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
  const retry = modelRequestRetryState(request, retryNow.value);
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
const activityLabel = computed(() => {
  if (session.runtimeError) return '';
  const action = conversationAction.value;
  if (action?.action === 'retry' && action.phase !== 'running' && action.phase !== 'unconfirmed') {
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
  const retry = modelRequestRetryState(latest, retryNow.value);
  // Keep the durable retry identity while the exact Attempt is waiting for output. Once its
  // transient renders model-owned content, the content itself replaces this activity row.
  if (latest.status === 'retrying') {
    const reasonLabel = [retry.reasonLabel, reliableRetryFailureLabel(modelRequestStreamStats(latest))]
      .filter(Boolean).join('；');
    const delaySeconds = Math.max(0, Math.ceil(retry.remainingDelayMs / 1_000));
    return delaySeconds > 0
      ? `${reasonLabel}，${delaySeconds} 秒后自动恢复（第 ${retry.retryAttempt}/${retry.retryMaxAttempts} 次）`
      : `${reasonLabel}，正在启动第 ${retry.retryAttempt}/${retry.retryMaxAttempts} 次自动恢复`;
  }
  if (latest.status === 'streaming' && retry.retryAttempt > 0) {
    const modelRequestId = reliableText(latest.id);
    return reliableRetryStreamingActivityLabel({
      retryAttempt: retry.retryAttempt,
      retryMaxAttempts: retry.retryMaxAttempts,
      lastFailureLabel: reliableRetryFailureLabel(modelRequestStreamStats(latest)),
      hasVisibleOutput: Boolean(modelRequestId) && hasVisibleStreamingTransientForRequestAttempt(
        feed.transientModelRequests,
        modelRequestId,
        String(retry.retryAttempt + 1),
        mountedTransientRequestIds.value
      )
    });
  }
  // Native Responses may commit an output item into a durable Message before the request ends.
  // Its live transient is then merged into that Message, so no `transient:` row is mounted.
  if (latestRequestHasVisibleModelRow.value || hasVisibleStreamingTransientForTurn(
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
    return '正在等待模型回复';
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
  return visibleMessageRows.value.find((message) =>
    projection.value.turnIdByMessageId[message.id] === turnId
  )?.id;
});

watch(
  () => [
    ...visibleTimelineRows.value.flatMap((row) => row.kind === 'collaboration' && row.card.acceptedAnswerId
      ? [row.card.acceptedAnswerId] : []),
    ...visibleMessageRows.value.map(messageDetailDemandSignature),
    ...Object.entries(projection.value.interactionByToolCallId)
      .filter(([, interaction]) => interaction.status === 'pending')
      .map(([toolCallId]) => toolCallId)
  ].join('|'),
  () => {
    feed.retainMessageContentWindows(visibleMessageRows.value.map(message => historySourceMessageId(message.id)));
    const pinnedDetailKeys = visibleMessageRows.value.flatMap((message) => {
      if (projection.value.contentWindowByMessageId[message.id]) return [];
      const revisionId = projection.value.messageRevisionIdByMessageId[message.id];
      return revisionId ? [reliableKernelDetailKey('message-content', revisionId)] : [];
    });
    feed.setPinnedDetailKeys([...pinnedDetailKeys, ...visibleTimelineRows.value.flatMap((row) =>
      row.kind === 'collaboration' && row.card.acceptedAnswerId
        ? [reliableKernelDetailKey('accepted-answer-content', row.card.acceptedAnswerId)] : [])]);
    const demand = prioritizedTimelineDetailDemand(
      visibleMessageRows.value.map((message) => message.id)
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

onBeforeUnmount(() => { feed.setPinnedDetailKeys([]); feed.retainMessageContentWindows([]); });

function deleteCount(message: MessageRecord): number {
  const count = Number((feed.projections.activeConversationWindow as { visibleMessageCount?: string } | undefined)?.visibleMessageCount);
  const floor = absoluteFloors.value[message.id];
  if (Number.isSafeInteger(count) && floor !== undefined) return Math.max(1, count - floor + 1);
  const index = projection.value.index.messagePositionById.get(message.id);
  return index === undefined ? 1 : messages.value.length - index;
}

function runHadCompletedTools(message: MessageRecord): boolean {
  const turnId = projection.value.turnIdByMessageId[message.id];
  if (!turnId) return false;
  return projection.value.index.completedToolTurnIds.has(turnId);
}

async function restorePendingScrollAnchor(): Promise<void> {
  const anchor = pendingScrollAnchor.value;
  const scroller = props.scroller;
  const conversation = conversationId.value;
  await nextTick();
  if (pendingScrollAnchor.value !== anchor || props.scroller !== scroller || conversationId.value !== conversation) return;
  pendingScrollAnchor.value = null;
  readingScrollAnchor = restoreScrollAfterHistoryLoad({ scroller, anchor }) ? anchor : null;
  readingScrollTop = scroller?.scrollTop;
}

function captureReadingScrollAnchor(): void {
  if (collaborationSearching.value) return;
  // Restoring layout produces a scroll event too. It keeps the same logical reading point;
  // only a new scroll position chooses another row, which may now be partly visible above it.
  if (readingScroller?.scrollTop === readingScrollTop) return;
  readingScrollAnchor = followLatestSegment.value ? null
    : captureScrollAnchor({ scroller: readingScroller, visibleRows: visibleRowMembership.value });
  if (pendingScrollAnchor.value) pendingScrollAnchor.value = readingScrollAnchor;
  readingScrollTop = readingScroller?.scrollTop;
}

function followLatestReading(): void {
  stopCollaborationSearch('');
  pendingHistoryAnchorId.value = null;
  pendingScrollAnchor.value = null;
  readingScrollAnchor = null;
  followLatestSegment.value = true;
  segmentStart.value = latestReadingStart();
}

function handleReadingNavigation(event: Event): void {
  const intent = userScrollIntentDetail(event);
  if (!intent || intent.direction === 'none' || intent.source === 'scrollAnchor') return;
  if (intent.direction === 'jump-end') { followLatestReading(); return; }
  // Arrival still admits the page, but a newer navigation owns which rows remain on screen.
  pendingHistoryAnchorId.value = null;
  stopCollaborationSearch('');
  if (pendingScrollAnchor.value) pendingScrollAnchor.value = captureScrollAnchor({
    scroller: readingScroller, visibleRows: visibleRowMembership.value
  });
}

function connectReadingScroller(scroller: HTMLElement | null): void {
  readingScroller?.removeEventListener('scroll', captureReadingScrollAnchor);
  readingScroller?.removeEventListener(USER_SCROLL_INTENT_EVENT, handleReadingNavigation);
  readingScroller = scroller;
  readingScrollTop = undefined;
  scroller?.addEventListener('scroll', captureReadingScrollAnchor, { passive: true });
  scroller?.addEventListener(USER_SCROLL_INTENT_EVENT, handleReadingNavigation);
  captureReadingScrollAnchor();
}

watch(() => props.scroller, connectReadingScroller, { flush: 'post' });
watch(followLatestSegment, (following) => { if (following) readingScrollAnchor = null; });
onMounted(() => {
  connectReadingScroller(props.scroller);
  // A history page admits identities before its bodies. Keep the same reading point through
  // those body/layout commits, including deferred Markdown, until the reader scrolls again.
  readingResizeObserver = new ResizeObserver(() => {
    if (followLatestSegment.value || pendingScrollAnchor.value || collaborationSearching.value) return;
    // Inner content windows can restore their own block position in the same layout cycle.
    // Adopt that scroll before applying the outer row anchor.
    if (readingScroller?.scrollTop !== readingScrollTop) { captureReadingScrollAnchor(); return; }
    if (readingScrollAnchor && restoreScrollAfterHistoryLoad({ scroller: readingScroller, anchor: readingScrollAnchor })) {
      readingScrollTop = readingScroller?.scrollTop;
    } else {
      readingScrollTop = undefined;
      captureReadingScrollAnchor();
    }
  });
  if (readingRoot.value) readingResizeObserver.observe(readingRoot.value);
});
onBeforeUnmount(() => {
  readingScroller?.removeEventListener('scroll', captureReadingScrollAnchor);
  readingScroller?.removeEventListener(USER_SCROLL_INTENT_EVENT, handleReadingNavigation);
  readingResizeObserver?.disconnect();
});

function showCollaborationHistory(direction: 'before' | 'after'): void {
  if (session.runtimeError || collaborationSearching.value || feed.historyLoading || feed.collaborationHistoryLoading
    || !(direction === 'before' ? canRequestEarlierCollaboration.value : canRequestLaterCollaboration.value)) return;
  releaseStickyFromUserScroll(props.scroller);
  followLatestSegment.value = false;
  readingScrollAnchor = null;
  collaborationSearchStart.value = feed.collaborationHistoryScannedRows;
  collaborationSearchNotice.value = '';
  collaborationSearchDirection.value = direction;
  pendingCollaborationRowIds.value = new Set(timelineRows.value.map((row) => row.id));
  collaborationSearching.value = true;
  if (!feed.requestCollaborationHistoryPage(conversationId.value, direction)) stopCollaborationSearch('查找未开始，请重试');
}
function showEarlierCollaboration(): void { showCollaborationHistory('before'); }
function showLaterCollaboration(): void { showCollaborationHistory('after'); }

function historySourceMessageId(id: string): string {
  return splitSourceMessageIds.value[id] ?? id;
}

function retainVisibleReadingPage(): void {
  if (feed.historyLoading || feed.collaborationHistoryLoading || pendingHistoryAnchorId.value || collaborationSearching.value) return;
  const rows = visibleRowMembership.value.filter(row => row.kind === 'message');
  const row = rows[Math.floor(rows.length / 2)];
  const cards = visibleRowMembership.value.filter(row => row.kind === 'collaboration');
  const card = cards[Math.floor(cards.length / 2)];
  if (!row && !card) return;
  const anchor = pendingScrollAnchor.value ?? captureScrollAnchor({ scroller: props.scroller, visibleRows: visibleRowMembership.value });
  const previousPage = feed.historyCurrentPageId;
  const previousCollaborationPage = feed.collaborationHistoryCurrentPageId;
  if (row?.kind === 'message') feed.retainReadingPage(historySourceMessageId(row.message.id));
  if (card?.kind === 'collaboration') feed.retainCollaborationReadingPage(card.card);
  if ((feed.historyCurrentPageId !== previousPage || feed.collaborationHistoryCurrentPageId !== previousCollaborationPage) && anchor) {
    pendingScrollAnchor.value = anchor;
    void restorePendingScrollAnchor();
  }
}
watch(visibleRowMembership, retainVisibleReadingPage, { flush: 'post' });

function requestAdjacentHistory(direction: 'before' | 'after'): void {
  const visible = visibleRowMembership.value;
  const rows = visible.filter(row => row.kind === 'message'), cards = visible.filter(row => row.kind === 'collaboration');
  const row = direction === 'before' ? rows[0] : rows[rows.length - 1];
  const card = direction === 'before' ? cards[0] : cards[cards.length - 1];
  const anchor = direction === 'before' ? visible[0] : visible[visible.length - 1];
  if (row?.kind === 'message') feed.retainReadingPage(historySourceMessageId(row.message.id));
  if (card?.kind === 'collaboration') feed.retainCollaborationReadingPage(card.card);
  pendingHistoryDirection.value = direction;
  pendingHistoryAnchorId.value = anchor?.id ?? null;
  const requestedMessages = row?.kind === 'message' && (direction === 'before'
    ? feed.requestEarlierHistory(conversationId.value) : feed.requestLaterHistory(conversationId.value));
  const requestedCollaboration = (direction === 'before' ? canRequestEarlierCollaboration.value : canRequestLaterCollaboration.value)
    && feed.requestCollaborationHistoryPage(conversationId.value, direction);
  pendingCollaborationPageForReading.value = Boolean(requestedCollaboration);
  if (!requestedMessages && !requestedCollaboration) { pendingHistoryAnchorId.value = null; pendingScrollAnchor.value = null; }
}

function moveReadingSegment(direction: 'before' | 'after'): void {
  if (readingHistoryLoading.value || collaborationSearching.value || !(direction === 'before' ? hasEarlierSegment.value : hasLaterSegment.value)) return;
  pendingScrollAnchor.value = captureScrollAnchor({ scroller: props.scroller, visibleRows: visibleTimelineRows.value });
  releaseStickyFromUserScroll(props.scroller);
  followLatestSegment.value = false;
  if (direction === 'before' && segmentStart.value > readingRun.value.start) {
    segmentStart.value = Math.max(readingRun.value.start, segmentStart.value - TIMELINE_SEGMENT_STEP);
  } else if (direction === 'after' && segmentEnd.value < readingRun.value.end) {
    segmentStart.value = clampReadingStart(segmentStart.value + TIMELINE_SEGMENT_STEP);
    followLatestSegment.value = segmentStart.value >= latestReadingStart() && !canRequestLaterHistory.value && !canRequestLaterCollaboration.value;
  } else {
    requestAdjacentHistory(direction);
    return;
  }
  void restorePendingScrollAnchor();
}
function showEarlierSegment(): void { moveReadingSegment('before'); }
function showLaterSegment(): void { moveReadingSegment('after'); }

function retryFrom(message: MessageRecord): void {
  if (!message.retryTarget) return;
  retryMessageFrom(
    message.conversationId,
    message.retryTarget,
    currentAuthoritySelection(),
    projection.value.messageRevisionIdByMessageId[message.id],
    timelineFloor(message)
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
  const window = projection.value.contentWindowByMessageId[message.id];
  if (window) return !window.loading;
  const revisionId = projection.value.messageRevisionIdByMessageId[message.id];
  if (!revisionId) return false;
  return feed.details[reliableKernelDetailKey('message-content', revisionId)]?.status === 'ready';
}

function messageDetailLoading(message: MessageRecord): boolean {
  if (submissionEchoByMessageId.value[message.id]) return false;
  const window = projection.value.contentWindowByMessageId[message.id];
  if (window) return window.loading && message.content.parts.length === 0;
  if (message.content.parts.length > 0) return false;
  const revisionId = projection.value.messageRevisionIdByMessageId[message.id];
  if (!revisionId) return false;
  const status = feed.details[reliableKernelDetailKey('message-content', revisionId)]?.status;
  return status === undefined || status === 'loading';
}

function timelineFloor(message: MessageRecord): number {
  const projected = projection.value.absoluteFloorByMessageId[message.id] ?? message.seq;
  return absoluteTimelineFloor(projected, (projection.value.index.messagePositionById.get(message.id) ?? 0) + 1);
}

function modelRequestRetryState(request: Record<string, unknown>, now: number): {
  retryAttempt: number;
  retryMaxAttempts: number;
  remainingDelayMs: number;
  reasonLabel: string;
} {
  const stats = modelRequestStreamStats(request);
  const attemptSeq = Math.max(1, reliableInteger(stats?.attemptSeq));
  const retryDelayMs = Math.max(0, reliableInteger(stats?.retryDelayMs));
  const retryNotBeforeAt = Math.max(0, reliableInteger(stats?.retryNotBeforeAt));
  const retryReason = reliableText(stats?.retryReason);
  const reasonLabel = retryReason === 'compression_timeout'
      ? '上下文压缩超时'
      : retryReason === 'stream_stalled' || retryReason === 'first_semantic_timeout'
        ? 'LLM 输出停滞'
        : retryReason === 'rate_limited'
          ? 'LLM 服务限流'
          : retryReason === 'temporary_service_error'
            ? 'LLM 服务暂时不可用'
            : 'LLM 连接异常';
  const delaySource = reliableRetryDelaySourceLabel(stats);
  return {
    retryAttempt: Math.max(0, attemptSeq - 1),
    retryMaxAttempts: Math.max(attemptSeq - 1, reliableInteger(stats?.retryMaxAttempts)),
    remainingDelayMs: retryNotBeforeAt > 0 ? Math.max(0, retryNotBeforeAt - now) : retryDelayMs,
    reasonLabel: delaySource ? `${reasonLabel}；${delaySource}` : reasonLabel
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
  <div ref="readingRoot" class="reliable-message-list">
    <button
      v-if="canRequestEarlierCollaboration"
      type="button"
      class="reliable-segment-control"
      :disabled="!!session.runtimeError || collaborationSearching || feed.collaborationHistoryLoading"
      @click="showEarlierCollaboration"
    >
      {{ (collaborationSearching || feed.collaborationHistoryLoading) && collaborationSearchDirection === 'before' ? '正在查找更早协作记录'
        : '查找更早协作记录' }}
    </button>
    <button v-if="collaborationSearching" type="button" class="reliable-segment-control" @click="stopCollaborationSearch()">停止查找</button>
    <p v-if="collaborationSearching || collaborationSearchNotice" class="reliable-collaboration-progress" role="status">
      {{ collaborationSearching ? '正在查找' : collaborationSearchNotice }} · 已检查 {{ collaborationScanned.toLocaleString() }} 条记录
    </p>
    <p v-if="feed.collaborationHistoryError" class="reliable-history-error" role="alert">
      {{ feed.collaborationHistoryError }}
    </p>
    <button
      v-if="hasEarlierSegment"
      type="button"
      class="reliable-segment-control"
      :disabled="readingHistoryLoading || collaborationSearching"
      @click="showEarlierSegment"
    >
      {{ earlierSegmentLabel }}
    </button>
    <p
      v-if="feed.historyError"
      class="reliable-history-error"
      role="alert"
    >
      {{ feed.historyError }}
    </p>
    <template v-for="row in visibleTimelineRows" :key="row.id">
      <div
        v-if="row.kind === 'message'"
        :key="messageRenderKey(row.message)"
        class="reliable-message-row"
        :data-timeline-row-key="row.id"
      >
        <p
          v-if="retryBoundaryLabel && visibleRetryBoundaryMessageId === row.message.id"
          class="reliable-retry-boundary"
          role="status"
        >
          {{ retryBoundaryLabel }}
        </p>
        <MessageItem
          :message="displayedMessage(row.message)"
          :scroller="scroller"
          :content-window="projection.contentWindowByMessageId[row.message.id]"
          :load-complete-content="() => completeMessageContent(row.message.id)"
          @earlier-content="feed.moveMessageContentWindow(historySourceMessageId(row.message.id), 'before')"
          @later-content="feed.moveMessageContentWindow(historySourceMessageId(row.message.id), 'after')"
          @retry-content="feed.retryMessageContentWindow(historySourceMessageId(row.message.id))"
          :run-id="projection.turnIdByMessageId[row.message.id]"
          :termination="messageTermination(row.message)"
          :termination-notice-suppressed="isMessageTerminationSuppressed(row.message)"
          :run-had-completed-tools="runHadCompletedTools(row.message)"
          :delete-count="deleteCount(row.message)"
          :compact-count="Math.max(1, timelineFloor(row.message))"
          :detail-loading="messageDetailLoading(row.message)"
          :detail-ready="messageDetailReady(row.message)"
          :mutation-pending="!!submissionEchoByMessageId[row.message.id] || (conversationActionPending && isConversationActionTarget(row.message))"
          :mutation-blocked="!!submissionEchoByMessageId[row.message.id] || (conversationActionPending && isConversationActionTarget(row.message)) || !projection.messageRevisionIdByMessageId[row.message.id]"
          :retry-blocked="!!submissionEchoByMessageId[row.message.id] || retryBlocked(row.message)"
          :compact-blocked="!!submissionEchoByMessageId[row.message.id] || (conversationActionPending && isConversationActionTarget(row.message)) || !projection.messageRevisionIdByMessageId[row.message.id]"
          :fork-blocked="!!submissionEchoByMessageId[row.message.id] || forkBlocked(row.message)"
          :pending-label="submissionEchoByMessageId[row.message.id]?.label ?? conversationActionLabel ?? '正在提交操作'"
          :floor-number="timelineFloor(row.message)"
          @edit-message="emit('edit-message', row.message, deleteCount(row.message))"
          @resend-as-new="emit('resend-as-new', row.message)"
          @retry-from="retryFrom"
          @delete-from="deleteFrom"
          @fork-from="forkFrom"
          @compact-to="compactTo"
          @dismiss-termination="dismissTermination"
        />
        <ReliableTurnTerminationRow
          v-for="termination in terminationRowsByAnchor[row.message.id] ?? []"
          :key="termination.id"
          :termination="termination"
          :retry-model-request-id="terminationRetry(termination.runId).target?.modelRequestId"
          :retry-blocked-reason="terminationRetry(termination.runId).blockedReason"
          :retry-pending="conversationActionPending"
          @retry="retryTerminatedRequest(termination, $event)"
          @dismiss="dismissTermination(termination)"
        />
        <ReliableCompressionWarningRow
          v-for="warning in compressionWarningsByAnchor[row.message.id] ?? []"
          :key="warning.id"
          :title="warning.title"
          :detail="warning.detail"
          @dismiss="dismissCompressionWarning(warning)"
        />
        <ReliableCompressionCard
          v-for="block in compressionBlocksByAnchor[row.message.id] ?? []"
          :key="`compression:${String(block.id)}`"
          :block="block"
          :data-timeline-row-key="`compression:${String(block.id)}`"
          @dismiss="dismissCompression(block)"
        />
      </div>
      <div v-else class="reliable-collaboration-row" :data-timeline-row-key="row.id">
        <ReliableCollaborationCard :card="row.card" />
        <p v-if="collaborationCardPlacementLabel(row.card)" class="reliable-collaboration-placement">
          {{ collaborationCardPlacementLabel(row.card) }}
        </p>
      </div>
    </template>
    <button
      v-if="hasLaterSegment"
      type="button"
      class="reliable-segment-control"
      :disabled="readingHistoryLoading || collaborationSearching"
      @click="showLaterSegment"
    >
      {{ readingHistoryLoading && pendingHistoryDirection === 'after' ? '正在加载较新内容' : '显示较新内容' }}
    </button>
    <button v-if="canRequestLaterCollaboration" type="button" class="reliable-segment-control"
      :disabled="!!session.runtimeError || collaborationSearching || feed.historyLoading || feed.collaborationHistoryLoading"
      @click="showLaterCollaboration">
      {{ (collaborationSearching || feed.collaborationHistoryLoading) && collaborationSearchDirection === 'after'
        ? '正在查找较新协作记录' : '查找较新协作记录' }}
    </button>
    <p
      v-if="retryBoundaryLabel && !visibleRetryBoundaryMessageId"
      class="reliable-retry-boundary"
      role="status"
    >
      {{ retryBoundaryLabel }}
    </p>
    <template v-if="!hasLaterSegment">
      <div v-for="echo in unlocatedSubmissionEchoes" :key="echo.submission.commandId"
        class="reliable-message-row" :data-pending-command-id="echo.submission.commandId">
        <MessageItem :message="turnInputEchoMessage(echo)" :mutation-pending="true"
          :mutation-blocked="true" :retry-blocked="true" :compact-blocked="true" :fork-blocked="true"
          :detail-ready="false" :pending-label="echo.label" />
        <p v-if="!echo.submission.result && (echo.submission.automaticRetryCount ?? 0) > 0"
          class="reliable-action-notice">
          <button type="button" @click="retryTurnInputSubmission(echo.submission.commandId)">重试确认消息</button>
        </p>
      </div>
      <ReliableCompressionWarningRow v-for="warning in unanchoredCompressionWarnings"
        :key="warning.id" :title="warning.title" :detail="warning.detail"
        @dismiss="dismissCompressionWarning(warning)" />
      <ReliableTurnTerminationRow v-for="{ termination, title } in unanchoredTerminationRows"
        :key="termination.id" :termination="termination" :title="title"
        :retry-model-request-id="terminationRetry(termination.runId).target?.modelRequestId"
        :retry-blocked-reason="terminationRetry(termination.runId).blockedReason"
        :retry-pending="conversationActionPending"
        @retry="retryTerminatedRequest(termination, $event)"
        @dismiss="dismissTermination(termination)" />
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
    <p v-if="unconfirmedHistoryCommands" class="reliable-action-notice">
      <button type="button" @click="historyDismissSelection = unconfirmedHistoryCommands">核对后解除本地锁定</button>
    </p>
    <ConfirmPanel :open="!!historyDismissSelection" title="解除本地锁定？"
      description="原操作结果尚未确认。解除只恢复界面操作，不会取消或重发原请求。再次执行可能重复，请先核对历史。"
      confirm-label="已核对，解除锁定" @confirm="confirmHistoryDismiss" @cancel="historyDismissSelection = undefined" />
    <p v-if="conversationForkReadyNotice" class="reliable-action-notice reliable-fork-ready" role="status">
      <span>{{ conversationForkReadyNotice.replayed ? '之前的分支请求已完成，分支已创建。' : '分支已创建。' }}</span>
      <button type="button" @click="openForkReadyNotice">打开分支</button>
      <button type="button" aria-label="关闭分支提示" @click="dismissForkReadyNotice">关闭</button>
    </p>
    <div v-if="messages.length === 0 && unlocatedSubmissionEchoes.length === 0 && !hasCollaborationCards && !activityLabel && !activeCompressionCard && unanchoredTerminationRows.length === 0 && unanchoredCompressionWarnings.length === 0" class="reliable-message-empty-container">
      <p class="reliable-message-empty">
        {{ feed.collaborationHistoryLoading ? '正在查找协作记录…'
          : feed.collaborationHistoryScanProgress ? '本页未找到协作记录，可继续查找更早记录。' : emptyHint }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.reliable-collaboration-progress { color: var(--vscode-descriptionForeground); font-size: var(--font-size-xs); margin: 4px 0 8px; }
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

.reliable-message-row,
.reliable-collaboration-row {
  display: block;
}

.reliable-collaboration-placement {
  margin: -4px var(--conversation-content-padding-right, var(--space-4)) var(--space-2)
    var(--conversation-content-padding-left, var(--space-4));
  color: var(--vscode-descriptionForeground);
  font-size: var(--font-size-xs);
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
