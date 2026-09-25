import { defineStore } from 'pinia';
import { debugCaptureTrace } from '@webview/transport/debugCapture';
import { rememberRemovedConversations } from '@webview/domain/collaborationPeer';
import type { ReliableToolApplyObserver } from '@webview/domain/reliableTransientModel';
import {
  RELIABLE_KERNEL_CHANGES_MESSAGE,
  RELIABLE_KERNEL_CLIENT_CHANGE_TYPES,
  RELIABLE_KERNEL_COLLABORATION_HISTORY_ERROR_MESSAGE,
  RELIABLE_KERNEL_COLLABORATION_HISTORY_REQUEST_MESSAGE,
  RELIABLE_KERNEL_COLLABORATION_HISTORY_RESULT_MESSAGE,
  RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE,
  RELIABLE_KERNEL_DETAIL_ERROR_MESSAGE,
  RELIABLE_KERNEL_DETAIL_REQUEST_MESSAGE,
  RELIABLE_KERNEL_DETAIL_RESULT_MESSAGE,
  RELIABLE_KERNEL_HISTORY_PAGE_ERROR_MESSAGE,
  RELIABLE_KERNEL_HISTORY_PAGE_REQUEST_MESSAGE,
  RELIABLE_KERNEL_HISTORY_PAGE_RESULT_MESSAGE,
  RELIABLE_KERNEL_SNAPSHOT_MESSAGE,
  RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE,
  RELIABLE_KERNEL_TRANSIENT_ACK_MESSAGE,
  RELIABLE_KERNEL_TRANSIENT_BATCH_MESSAGE,
  RELIABLE_KERNEL_TRANSIENT_MESSAGE,
  RELIABLE_KERNEL_TRANSIENT_SNAPSHOT_MESSAGE,
  RELIABLE_KERNEL_TRANSIENT_SNAPSHOT_REQUEST_MESSAGE,
  applyReliableKernelDataMessage,
  createEmptyReliableKernelClientState,
  type ReliableKernelBoundedClientState,
  type ReliableKernelClientDetailKind,
  type ReliableKernelCollaborationHistoryErrorMessage,
  type ReliableKernelCollaborationHistoryResultMessage,
  type ReliableKernelDetailErrorMessage,
  type ReliableKernelDetailResultMessage,
  type ReliableKernelHistoryPageErrorMessage,
  type ReliableKernelHistoryPageResultMessage,
  type ReliableKernelTransientBatchItem,
  type ReliableKernelTransientBatchMessage,
  type ReliableKernelTransientMessage,
  type ReliableKernelTransientSnapshotMessage
} from '@shared/reliableKernelClientFeed';
import {
  createMessageId,
  type LlmUsageMetadataRecord,
  type MessageContent,
  type ModelOutputItemReference
} from '@shared/protocol';
import {
  compareReliableTransientIdentity,
  mergeReliableCompletedToolCalls,
  mergeReliableToolCallDeltas,
  replaceReliableCompletedToolCalls,
  type ReliableTransientToolCallState
} from '@webview/domain/reliableTransientModel';
import {
  applyReliableTransientOutputItem,
  appendReliableTransientTextPart,
  cloneReliableTransientParts,
  syncReliableTransientFunctionCallParts,
  updateReliableTransientThoughtPart
} from '@webview/domain/reliableTransientOutput';
import { reconcileReliableTransientRequests } from '@webview/domain/reliableTransientLifecycle';
import { bridge } from '@webview/transport';

export interface ReliableKernelDetailState {
  status: 'loading' | 'ready' | 'error';
  text: string;
  totalBytes: number;
  error?: string;
  /** Number of failed initial loads retained across automatic/manual retries. */
  retryCount?: number;
  /** Earliest epoch at which another automatic request may be admitted. */
  nextRetryAt?: number;
  /** Explicit non-recoverable detail failure; ordinary bridge/read errors remain retryable. */
  terminalError?: boolean;
  /** A mutable detail is being extended while its last complete value remains renderable. */
  refreshing?: boolean;
  /** The last background refresh failed. This never invalidates the complete value in `text`. */
  refreshError?: string;
}

interface PendingDetailRequest {
  key: string;
  kind: ReliableKernelClientDetailKind;
  recordId: string;
  nextOffset: number;
  totalBytes?: number;
  sessionId: string;
  priority: ReliableKernelDetailPriority;
  enqueuedAt: number;
  mode: 'initial' | 'refresh';
  retryCount: number;
}

export type ReliableKernelDetailPriority = 'critical' | 'expanded' | 'visible' | 'background';

interface ReliableKernelDetailRequestOptions {
  priority?: ReliableKernelDetailPriority;
  /** Internal retry generation. Public callers should use retryDetail for an immediate retry. */
  retryCount?: number;
  /** Internal admission flag used only by an already-scheduled or explicit retry. */
  bypassBackoff?: boolean;
}

interface ReliableKernelDetailCacheMeta {
  lastAccessedAt: number;
  bytes: number;
}

export interface ReliableKernelTransientState {
  conversationId: string;
  turnId: string;
  modelRequestId: string;
  requestSeq: string;
  providerId: string;
  modelId: string;
  attemptSeq?: string;
  socketGeneration?: string;
  afterCommitSeq?: string;
  streamSeq: string;
  text: string;
  thought: string;
  /** Ordered low-latency model output; this is the transient rendering authority. */
  outputParts: MessageContent['parts'];
  /** Exact terminal model parts; present once the Provider completion is observed. */
  completedContent?: MessageContent;
  thoughtSignature?: string;
  /** 当前思考块是否仍活动；与整个 Provider 请求的 streaming 状态相互独立。 */
  thoughtActive?: boolean;
  thoughtStartedAt?: number;
  thoughtCompletedDurationMs?: number;
  thoughtElapsedMs?: number;
  thoughtDurationMs?: number;
  toolCalls: ReliableTransientToolCallState[];
  usageMetadata?: LlmUsageMetadataRecord;
  providerStartedAt?: number;
  firstOutputAt?: number;
  completedAt?: number;
  streamOutputDurationMs?: number;
  status: 'streaming' | 'completed' | 'failed' | 'cancelled';
  /** A continuity gap is being healed; the last contiguous prefix remains renderable. */
  recovering?: boolean;
  startedAt: number;
  updatedAt: number;
}

interface PendingTransientRecovery {
  requestId: string;
  sessionId: string;
  hostBootId: string;
  navigationGeneration?: string;
  conversationId: string;
  modelRequestId: string;
  attemptSeq: string;
  socketGeneration: string;
  afterStreamSeq: string;
}

interface ReliableKernelFeedStoreState extends ReliableKernelBoundedClientState {
  details: Record<string, ReliableKernelDetailState>;
  pendingDetails: Record<string, PendingDetailRequest>;
  detailQueue: string[];
  activeDetailRequestIds: string[];
  detailCacheMeta: Record<string, ReliableKernelDetailCacheMeta>;
  /** Ready detail entries owned by the currently mounted timeline segment. */
  pinnedDetailKeys: string[];
  retiredSessionIds: string[];
  navigationGeneration: string | null;
  transientModelRequests: Record<string, ReliableKernelTransientState>;
  pendingTransientRecoveries: Record<string, PendingTransientRecovery>;
  /** Memory-only immutable history prefix for the currently projected Conversation. */
  historyConversationId: string | null;
  historyRecords: ReliableKernelBoundedClientState['records'];
  historyNextBeforeMessageSeq: string | null;
  historyNextBeforeId: string | null;
  historyHasMore: boolean;
  historyLoading: boolean;
  historyError: string | null;
  historyRequestId: string | null;
  historyLoadedPages: number;
  /** CollaborationMessage's own independent keyset, never seeded by Message membership. */
  collaborationHistoryConversationId: string | null;
  collaborationHistoryRecords: ReliableKernelBoundedClientState['records'];
  collaborationHistoryNextBeforeMessageSeq: string | null;
  collaborationHistoryNextBeforeId: string | null;
  collaborationHistoryHasMore: boolean;
  collaborationHistoryScanProgress: boolean;
  collaborationHistoryLoading: boolean;
  collaborationHistoryError: string | null;
  collaborationHistoryRequestId: string | null;
  collaborationHistoryLoadedPages: number;
  /**
   * Conversations this view saw removed by a committed change. A peer merely missing from the
   * bounded lists is unknown; only these read as deleted. Memory-only and bounded.
   */
  removedConversationIds: string[];
}

const DETAIL_CHUNK_MAX_BYTES = 262_144;
const DETAIL_MAX_INFLIGHT_REQUESTS = 4;
const DETAIL_REQUEST_DEADLINE_MS = 20_000;
const DETAIL_AUTO_RETRY_DELAYS_MS = [250, 750, 2_000] as const;
// The byte budget remains authoritative. A 256-entry cap evicted many small historical messages
// after roughly eight conversations while leaving most of the 16 MiB budget unused.
const DETAIL_CACHE_MAX_ENTRIES = 1_024;
const DETAIL_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const HISTORY_PAGE_LIMIT = 200;
const COLLABORATION_HISTORY_REQUEST_DEADLINE_MS = 20_000;
const collaborationHistoryTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const MAX_REPORTED_TRANSIENT_PAINTS = 512;
const reportedTransientPaints = new Set<string>();
const detailDecoders = new Map<string, TextDecoder>();
// Streaming pieces stay outside Vue deep reactivity. Reassigning one growing string for every
// frame copies its entire prefix repeatedly; a single final join keeps large details linear.
const detailTextChunks = new Map<string, string[]>();
const detailRequestTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const detailRetryTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
const DETAIL_PRIORITY_ORDER: Readonly<Record<ReliableKernelDetailPriority, number>> = Object.freeze({
  critical: 0,
  expanded: 1,
  visible: 2,
  background: 3
});

export const useReliableKernelClientFeedStore = defineStore('reliableKernelClientFeed', {
  state: (): ReliableKernelFeedStoreState => ({
    ...createEmptyReliableKernelClientState(),
    details: {},
    pendingDetails: {},
    detailQueue: [],
    activeDetailRequestIds: [],
    detailCacheMeta: {},
    pinnedDetailKeys: [],
    retiredSessionIds: [],
    navigationGeneration: null,
    transientModelRequests: {},
    pendingTransientRecoveries: {},
    historyConversationId: null,
    historyRecords: {},
    historyNextBeforeMessageSeq: null,
    historyNextBeforeId: null,
    historyHasMore: false,
    historyLoading: false,
    historyError: null,
    historyRequestId: null,
    historyLoadedPages: 0,
    collaborationHistoryConversationId: null,
    collaborationHistoryRecords: {},
    collaborationHistoryNextBeforeMessageSeq: null,
    collaborationHistoryNextBeforeId: null,
    collaborationHistoryHasMore: false,
    collaborationHistoryScanProgress: false,
    collaborationHistoryLoading: false,
    collaborationHistoryError: null,
    collaborationHistoryRequestId: null,
    collaborationHistoryLoadedPages: 0,
    removedConversationIds: []
  }),
  getters: {
    childExecutionFacts: (state) => Object.values(state.records.ChildExecution ?? {}),
    activeChildTurnFacts: (state) => Object.values(state.records.ChildExecutionActiveTurnLink ?? {}),
    answerBridgeFacts: (state) => Object.values(state.records.AnswerBridge ?? {}),
    answerSubmissionFacts: (state) => Object.values(state.records.AnswerSubmission ?? {}),
    runtimeDeliveryFacts: (state) => Object.values(state.records.RuntimeDelivery ?? {}),
    terminationFacts: (state) => Object.values(state.records.TurnTermination ?? {})
  },
  actions: {
    observe(message: unknown): void {
      if (isReliableKernelFeedDataMessage(message)) {
        this.observeData(message);
        return;
      }
      if (isReliableKernelDetailResultMessage(message)) {
        this.observeDetailResult(message);
        return;
      }
      if (isReliableKernelDetailErrorMessage(message)) {
        this.observeDetailError(message);
        return;
      }
      if (isReliableKernelCollaborationHistoryResultMessage(message)) {
        this.observeCollaborationHistoryResult(message);
        return;
      }
      if (isReliableKernelCollaborationHistoryErrorMessage(message)) {
        this.observeCollaborationHistoryError(message);
        return;
      }
      if (isReliableKernelHistoryPageResultMessage(message)) {
        this.observeHistoryPageResult(message);
        return;
      }
      if (isReliableKernelHistoryPageErrorMessage(message)) {
        this.observeHistoryPageError(message);
        return;
      }
      if (isReliableKernelTransientSnapshotMessage(message)) {
        this.observeTransientSnapshot(message);
        return;
      }
      if (isReliableKernelTransientBatchMessage(message)) {
        this.observeTransientBatch(message);
        return;
      }
      if (isReliableKernelTransientMessage(message)) this.observeTransientFrame(message);
    },

    observeData(message: unknown): void {
      const envelope = plainRecord(message);
      const incomingSessionId = stringValue(envelope?.sessionId);
      const incomingType = stringValue(envelope?.type);
      const incomingGeneration = optionalDecimal(envelope?.navigationGeneration);
      if (!incomingSessionId) return;
      if (this.retiredSessionIds.includes(incomingSessionId)) return;
      if (incomingType === RELIABLE_KERNEL_CHANGES_MESSAGE && this.sessionId !== incomingSessionId) return;
      if (
        incomingGeneration
        && this.navigationGeneration
        && BigInt(incomingGeneration) < BigInt(this.navigationGeneration)
      ) return;
      const previousSessionId = this.sessionId;
      const previousHostBootId = this.hostBootId;
      const previousConversationId = activeConversationId(this.projections);
      const result = applyReliableKernelDataMessage(this.$state, message);
      const nextConversationId = activeConversationId(result.state.projections);
      const nextVisibleMessages = visibleMessageCount(result.state.projections);
      const previousLoadedFloorCeiling = maximumVisibleMessageFloor(
        this.historyRecords,
        this.records,
        previousConversationId ?? ''
      );
      const continuingLoadedHistory = Boolean(
        result.ack
        && previousConversationId
        && previousConversationId === nextConversationId
        && this.historyConversationId === previousConversationId
        && (this.historyLoadedPages > 0 || this.historyLoading)
      );
      const historyInvalidated = continuingLoadedHistory
        && incomingType === RELIABLE_KERNEL_SNAPSHOT_MESSAGE
        && nextVisibleMessages < previousLoadedFloorCeiling;
      const nextSuffixFloor = previousConversationId
        ? visibleMessageSuffixFloor(result.state.records.Message ?? {}, previousConversationId)
        : undefined;
      const snapshotSkippedLoadedFloors = continuingLoadedHistory
        && !historyInvalidated
        && incomingType === RELIABLE_KERNEL_SNAPSHOT_MESSAGE
        && nextSuffixFloor !== undefined
        && previousLoadedFloorCeiling > 0n
        && nextSuffixFloor > previousLoadedFloorCeiling + 1n;
      const rolledMessageIds = continuingLoadedHistory && !historyInvalidated && previousConversationId
        ? rolledOffVisibleMessageIds(this.records, result.state.records, previousConversationId)
        : new Set<string>();
      if (rolledMessageIds.size > 0) {
        this.historyRecords = retainRolledOffLiveRecords(
          this.historyRecords,
          this.records,
          result.state.records,
          rolledMessageIds
        );
      }
      if (continuingLoadedHistory && incomingType === RELIABLE_KERNEL_CHANGES_MESSAGE) {
        this.historyRecords = reconcileHistoryRecordsWithLiveChanges(
          this.historyRecords,
          envelope,
          this.records,
          result.state.records
        );
      }
      let replayDetails: Array<{
        kind: ReliableKernelClientDetailKind;
        recordId: string;
        priority: ReliableKernelDetailPriority;
        mode: 'initial' | 'refresh';
      }> = [];
      if (previousSessionId && result.state.sessionId !== previousSessionId) {
        this.retiredSessionIds = [...this.retiredSessionIds, previousSessionId].slice(-16);
        const sameTransientScope = previousConversationId !== undefined
          && previousConversationId === activeConversationId(result.state.projections);
        if (sameTransientScope) {
          replayDetails = Object.values(this.pendingDetails).map((pending) => ({
            kind: pending.kind,
            recordId: pending.recordId,
            priority: pending.priority,
            mode: pending.mode
          }));
        }
        cancelAllDetailRequests(this.$state);
        this.pendingTransientRecoveries = {};
        if (!sameTransientScope) {
          this.transientModelRequests = {};
          reportedTransientPaints.clear();
        } else if (previousHostBootId !== result.state.hostBootId) {
          this.transientModelRequests = markTransientRequestsRecovering(this.transientModelRequests);
        }
      }
      if (previousHostBootId && result.state.hostBootId !== previousHostBootId) {
        clearAllDetailRetryTimers();
        this.details = {};
        this.detailCacheMeta = {};
      }
      this.sessionId = result.state.sessionId;
      this.hostBootId = result.state.hostBootId;
      this.lastMessageSeq = result.state.lastMessageSeq;
      this.lastCommitSeq = result.state.lastCommitSeq;
      this.projections = result.state.projections;
      this.records = result.state.records;
      this.snapshotRequired = result.state.snapshotRequired;
      if (result.ack) {
        invalidateRetryableDetailsForDurableMessage(this.$state, envelope, incomingType);
      }
      if (result.ack && incomingType === RELIABLE_KERNEL_CHANGES_MESSAGE) {
        this.transientModelRequests = removeTransientModelRequests(
          this.transientModelRequests,
          removedModelRequestIds(envelope)
        );
        const removedConversations = rememberRemovedConversations(this.removedConversationIds, envelope?.changes);
        if (removedConversations.length !== this.removedConversationIds.length
          || removedConversations.some((id, index) => id !== this.removedConversationIds[index])) {
          this.removedConversationIds = removedConversations;
        }
      }
      if (incomingGeneration) this.navigationGeneration = incomingGeneration;
      if (result.ack) {
        if (historyInvalidated) {
          resetHistoryState(this.$state, nextConversationId ?? null);
        } else {
          this.synchronizeHistoryScope(
            nextConversationId ?? '',
            Boolean(previousSessionId && previousSessionId !== result.state.sessionId)
          );
          if (snapshotSkippedLoadedFloors && nextConversationId) {
            this.historyLoading = false;
            this.historyRequestId = null;
            this.historyError = null;
            seedHistoryCursorFromLiveRecords(this.$state, nextConversationId);
          }
        }
        this.synchronizeCollaborationHistoryScope(
          nextConversationId ?? '',
          Boolean(previousSessionId && previousSessionId !== result.state.sessionId)
        );
      }
      // ACK means the ordered durable state was accepted. Send it before optional detail replay and
      // transient-overlay reconciliation so rendering work cannot head-of-line block the Feed.
      if (result.ack) bridge.postRaw(result.ack);
      if (result.ack && nextConversationId && this.collaborationHistoryLoadedPages === 0
        && !this.collaborationHistoryLoading && !this.collaborationHistoryError) {
        // Always bootstrap: a Conversation with no ordinary Message can still have older cards.
        this.requestEarlierCollaborationHistory(nextConversationId);
      }
      for (const detail of replayDetails) {
        if (detail.mode === 'refresh') {
          this.refreshDetail(detail.kind, detail.recordId, { priority: detail.priority });
        } else {
          this.requestDetail(detail.kind, detail.recordId, { priority: detail.priority });
        }
      }
      reconcileReliableTransientRequests(this.transientModelRequests, this.records, this.details);
      if (result.ack) {
        reportFeedPaint(
          message,
          stringValue(plainRecord(this.projections.activeConversationWindow)?.conversationId)
        );
      }
      if (result.snapshotRequired) {
        bridge.postRaw({
          type: RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE,
          ...(this.sessionId ? { sessionId: this.sessionId } : {})
        });
      }
    },

    synchronizeHistoryScope(conversationId: string, sessionChanged: boolean): void {
      const normalized = conversationId.trim();
      if (this.historyConversationId !== (normalized || null)) {
        resetHistoryState(this.$state, normalized || null);
      } else if (sessionChanged) {
        this.historyLoading = false;
        this.historyRequestId = null;
        this.historyError = null;
      }
      if (!normalized || this.historyLoadedPages > 0 || this.historyLoading) return;
      seedHistoryCursorFromLiveRecords(this.$state, normalized);
    },

    synchronizeCollaborationHistoryScope(conversationId: string, sessionChanged: boolean): void {
      const normalized = conversationId.trim() || null;
      if (this.collaborationHistoryConversationId !== normalized || sessionChanged) {
        // A new session can also bind the same Conversation id in another Runtime root.
        // Re-read rather than keep a page whose root identity the Webview cannot prove.
        resetCollaborationHistoryState(this.$state, normalized);
      }
    },

    requestEarlierCollaborationHistory(conversationId: string): boolean {
      const normalized = conversationId.trim();
      const sessionId = this.sessionId;
      if (!normalized || !sessionId || activeConversationId(this.projections) !== normalized
        || this.collaborationHistoryConversationId !== normalized || this.collaborationHistoryLoading
        || !this.collaborationHistoryHasMore) return false;
      const beforeMessageSeq = this.collaborationHistoryNextBeforeMessageSeq;
      const beforeId = this.collaborationHistoryNextBeforeId;
      if ((beforeMessageSeq === null) !== (beforeId === null)) {
        this.collaborationHistoryError = '协作历史分页游标不可用。';
        return false;
      }
      const requestId = createMessageId();
      this.collaborationHistoryLoading = true;
      this.collaborationHistoryError = null;
      this.collaborationHistoryRequestId = requestId;
      const timeout = setTimeout(() => {
        collaborationHistoryTimeouts.delete(requestId);
        if (this.collaborationHistoryRequestId !== requestId || this.sessionId !== sessionId
          || this.collaborationHistoryConversationId !== normalized) return;
        this.collaborationHistoryLoading = false;
        this.collaborationHistoryRequestId = null;
        this.collaborationHistoryError = '协作历史请求超时，请重试。';
      }, COLLABORATION_HISTORY_REQUEST_DEADLINE_MS);
      // Node SSR regressions must not keep the process alive for an unanswered optional read.
      (timeout as unknown as { unref?: () => void }).unref?.();
      collaborationHistoryTimeouts.set(requestId, timeout);
      try {
        bridge.postRaw({
          type: RELIABLE_KERNEL_COLLABORATION_HISTORY_REQUEST_MESSAGE,
          requestId, sessionId, conversationId: normalized,
          ...(beforeMessageSeq === null ? {} : { beforeMessageSeq, beforeId }),
          limit: HISTORY_PAGE_LIMIT
        });
      } catch (error) {
        clearCollaborationHistoryTimeout(requestId);
        this.collaborationHistoryLoading = false;
        this.collaborationHistoryRequestId = null;
        this.collaborationHistoryError = error instanceof Error ? error.message : '请求更早协作历史失败。';
        return false;
      }
      return true;
    },

    observeCollaborationHistoryResult(message: ReliableKernelCollaborationHistoryResultMessage): void {
      if (message.sessionId !== this.sessionId
        || message.conversationId !== this.collaborationHistoryConversationId
        || message.conversationId !== activeConversationId(this.projections)
        || message.requestId !== this.collaborationHistoryRequestId) return;
      if (!isCollaborationHistoryPage(message.page, this.collaborationHistoryNextBeforeMessageSeq,
        this.collaborationHistoryNextBeforeId)) {
        clearCollaborationHistoryTimeout(message.requestId);
        this.collaborationHistoryLoading = false;
        this.collaborationHistoryRequestId = null;
        this.collaborationHistoryError = '协作历史分页游标或记录格式无效。';
        return;
      }
      try {
        this.collaborationHistoryRecords = mergeHistoryRecordPage(
          this.collaborationHistoryRecords, message.page.records, COLLABORATION_HISTORY_RECORD_TYPES
        );
      } catch (error) {
        clearCollaborationHistoryTimeout(message.requestId);
        this.collaborationHistoryLoading = false;
        this.collaborationHistoryRequestId = null;
        this.collaborationHistoryError = error instanceof Error ? error.message : '协作历史页面格式无效。';
        return;
      }
      clearCollaborationHistoryTimeout(message.requestId);
      this.collaborationHistoryNextBeforeMessageSeq = message.page.nextBeforeMessageSeq ?? null;
      this.collaborationHistoryNextBeforeId = message.page.nextBeforeId ?? null;
      this.collaborationHistoryHasMore = message.page.hasMore;
      this.collaborationHistoryScanProgress = message.page.scanProgress;
      this.collaborationHistoryLoading = false;
      this.collaborationHistoryError = null;
      this.collaborationHistoryRequestId = null;
      this.collaborationHistoryLoadedPages += 1;
    },

    observeCollaborationHistoryError(message: ReliableKernelCollaborationHistoryErrorMessage): void {
      if (message.sessionId !== this.sessionId
        || message.conversationId !== this.collaborationHistoryConversationId
        || message.requestId !== this.collaborationHistoryRequestId) return;
      clearCollaborationHistoryTimeout(message.requestId);
      this.collaborationHistoryLoading = false;
      this.collaborationHistoryRequestId = null;
      this.collaborationHistoryError = message.message.trim() || '读取协作历史失败。';
    },

    requestEarlierHistory(conversationId: string): boolean {
      const normalized = conversationId.trim();
      const sessionId = this.sessionId;
      if (
        !normalized
        || !sessionId
        || activeConversationId(this.projections) !== normalized
        || this.historyConversationId !== normalized
        || this.historyLoading
        || !this.historyHasMore
      ) return false;
      const beforeMessageSeq = this.historyNextBeforeMessageSeq;
      const beforeId = this.historyNextBeforeId;
      if (!beforeMessageSeq || !beforeId) {
        this.historyError = '更早消息的分页游标不可用。';
        return false;
      }
      const requestId = createMessageId();
      this.historyLoading = true;
      this.historyError = null;
      this.historyRequestId = requestId;
      try {
        bridge.postRaw({
          type: RELIABLE_KERNEL_HISTORY_PAGE_REQUEST_MESSAGE,
          requestId,
          sessionId,
          conversationId: normalized,
          beforeMessageSeq,
          beforeId,
          limit: HISTORY_PAGE_LIMIT
        });
      } catch (error) {
        this.historyLoading = false;
        this.historyRequestId = null;
        this.historyError = error instanceof Error ? error.message : '请求更早消息失败。';
        return false;
      }
      return true;
    },

    observeHistoryPageResult(message: ReliableKernelHistoryPageResultMessage): void {
      if (
        message.sessionId !== this.sessionId
        || message.conversationId !== this.historyConversationId
        || message.requestId !== this.historyRequestId
      ) return;
      if (
        message.page.hasMore
        && (!message.page.nextBeforeMessageSeq || !message.page.nextBeforeId)
      ) {
        this.historyLoading = false;
        this.historyRequestId = null;
        this.historyError = '更早消息页面缺少连续分页游标。';
        return;
      }
      try {
        this.historyRecords = mergeHistoryRecordPage(this.historyRecords, message.page.records);
      } catch (error) {
        this.historyLoading = false;
        this.historyRequestId = null;
        this.historyError = error instanceof Error ? error.message : '更早消息页面格式无效。';
        return;
      }
      this.historyNextBeforeMessageSeq = message.page.nextBeforeMessageSeq ?? null;
      this.historyNextBeforeId = message.page.nextBeforeId ?? null;
      this.historyHasMore = message.page.hasMore;
      this.historyLoading = false;
      this.historyError = null;
      this.historyRequestId = null;
      this.historyLoadedPages += 1;
    },

    observeHistoryPageError(message: ReliableKernelHistoryPageErrorMessage): void {
      if (
        message.sessionId !== this.sessionId
        || message.conversationId !== this.historyConversationId
        || message.requestId !== this.historyRequestId
      ) return;
      this.historyLoading = false;
      this.historyRequestId = null;
      this.historyError = message.message.trim() || '读取更早消息失败。';
    },

    observeTransientBatch(message: ReliableKernelTransientBatchMessage): void {
      if (!transientEnvelopeMatches(this.$state, message)) return;
      let accepted = true;
      for (const event of message.events) {
        const transient: ReliableKernelTransientMessage = {
          type: RELIABLE_KERNEL_TRANSIENT_MESSAGE,
          ...event,
          sessionId: message.sessionId,
          ...(message.navigationGeneration ? { navigationGeneration: message.navigationGeneration } : {}),
          hostBootId: message.hostBootId,
          conversationId: message.conversationId
        };
        if (!this.observeTransientFrame(transient)) accepted = false;
      }
      // A gap intentionally withholds the transport receipt. The explicit snapshot request is the
      // primary recovery path; the Host ACK watchdog is the bounded fallback if that request drops.
      if (accepted) {
        this.ackTransientDelivery(
          message.deliveryId,
          message.sessionId,
          message.hostBootId,
          message.navigationGeneration,
          transientHeadsForItems(this.transientModelRequests, message.events)
        );
      }
    },

    observeTransientFrame(message: ReliableKernelTransientMessage): boolean {
      if (!transientEnvelopeMatches(this.$state, message)) {
        debugCaptureTrace.observe(debugContext(message), () => ({ stage: 'ui.frame', metadata: { ...debugFrameMetadata(message), decision: 'envelope_rejected' } }));
        return false;
      }
      const decision = transientContinuityDecision(
        this.transientModelRequests[message.modelRequestId],
        message
      );
      debugCaptureTrace.observe(debugContext(message), () => ({ stage: 'ui.frame', metadata: { ...debugFrameMetadata(message), decision: decision.kind } }));
      if (decision.kind === 'invalid') return false;
      if (decision.kind === 'stale') return true;
      if (decision.kind === 'gap') {
        this.requestTransientSnapshot(message, decision.afterStreamSeq);
        return false;
      }
      if (decision.replacesIdentity) {
        this.pendingTransientRecoveries = removeTransientRecoveriesForModelRequest(
          this.pendingTransientRecoveries,
          message.modelRequestId
        );
      }
      this.observeTransient(message);
      return true;
    },

    requestTransientSnapshot(message: ReliableKernelTransientMessage, afterStreamSeq: string): void {
      const sessionId = this.sessionId;
      const hostBootId = this.hostBootId;
      if (!sessionId || !hostBootId) return;
      const key = transientRecoveryKey(
        message.modelRequestId,
        message.attemptSeq,
        message.socketGeneration
      );
      if (this.pendingTransientRecoveries[key]) return;
      const requestId = createMessageId();
      const recovery: PendingTransientRecovery = {
        requestId,
        sessionId,
        hostBootId,
        ...(this.navigationGeneration ? { navigationGeneration: this.navigationGeneration } : {}),
        conversationId: message.conversationId,
        modelRequestId: message.modelRequestId,
        attemptSeq: message.attemptSeq,
        socketGeneration: message.socketGeneration,
        afterStreamSeq
      };
      this.pendingTransientRecoveries[key] = recovery;
      const current = this.transientModelRequests[message.modelRequestId];
      if (
        current
        && compareReliableTransientIdentity(current, message.attemptSeq, message.socketGeneration) === 'same'
      ) current.recovering = true;
      bridge.postRaw({
        type: RELIABLE_KERNEL_TRANSIENT_SNAPSHOT_REQUEST_MESSAGE,
        ...recovery
      });
      reportTransientRecoveryDiagnostic(this.$state, message, 'transient-gap', message.event.streamSeq);
    },

    observeTransientSnapshot(message: ReliableKernelTransientSnapshotMessage): void {
      if (!transientEnvelopeMatches(this.$state, message)) return;
      debugCaptureTrace.observe(debugContext(message), () => ({ stage: 'ui.snapshot', metadata: { sessionId: message.sessionId, snapshotId: message.deliveryId, headStreamSeq: message.headStreamSeq, mode: 'rebuild' }, payload: message.events }));
      const headStreamSeq = decimal(message.headStreamSeq);
      const attemptSeq = decimal(message.attemptSeq);
      const socketGeneration = decimal(message.socketGeneration);
      const requestSeq = positiveDecimal(message.requestSeq);
      const afterCommitSeq = decimal(message.afterCommitSeq);
      const providerId = nonEmptyString(message.providerId);
      const modelId = nonEmptyString(message.modelId);
      const validEvents = headStreamSeq !== undefined
        && attemptSeq !== undefined
        && socketGeneration !== undefined
        && Boolean(requestSeq && afterCommitSeq !== undefined && providerId && modelId)
        && message.events.length > 0
        && message.events.every((event) => transientSnapshotItemMatches(message, event, headStreamSeq));
      const prior = this.transientModelRequests[message.modelRequestId];
      const identity = compareReliableTransientIdentity(prior, attemptSeq, socketGeneration);
      if (!validEvents || identity === 'stale') {
        this.ackTransientDelivery(
          message.deliveryId,
          message.sessionId,
          message.hostBootId,
          message.navigationGeneration,
          prior ? [transientHead(prior)] : []
        );
        reportTransientSnapshotDiagnostic(this.$state, message, 'transient-snapshot-rejected');
        return;
      }

      delete this.transientModelRequests[message.modelRequestId];
      try {
        message.events.forEach((event, index) => {
          // Snapshot events are a semantic cumulative projection rather than the original frame
          // sequence. Apply them in projection order, then publish the authoritative provider head.
          const localSequence = String(index + 1);
          this.observeTransient({
            type: RELIABLE_KERNEL_TRANSIENT_MESSAGE,
            ...event,
            fromStreamSeq: localSequence,
            sessionId: message.sessionId,
            ...(message.navigationGeneration ? { navigationGeneration: message.navigationGeneration } : {}),
            hostBootId: message.hostBootId,
            conversationId: message.conversationId,
            event: { ...event.event, streamSeq: localSequence }
          }, { mode: 'rebuild', snapshotId: message.deliveryId, headStreamSeq: message.headStreamSeq });
        });
      } catch {
        if (prior) this.transientModelRequests[message.modelRequestId] = prior;
        else delete this.transientModelRequests[message.modelRequestId];
        this.ackTransientDelivery(
          message.deliveryId,
          message.sessionId,
          message.hostBootId,
          message.navigationGeneration,
          prior ? [transientHead(prior)] : []
        );
        reportTransientSnapshotDiagnostic(this.$state, message, 'transient-snapshot-rejected');
        return;
      }
      const recovered = this.transientModelRequests[message.modelRequestId];
      if (!recovered) {
        const terminalKind = message.events[message.events.length - 1]?.event.kind;
        if (terminalKind === 'completed' || terminalKind === 'failed' || terminalKind === 'cancelled') {
          const key = transientRecoveryKey(message.modelRequestId, message.attemptSeq, message.socketGeneration);
          delete this.pendingTransientRecoveries[key];
          this.ackTransientDelivery(
            message.deliveryId,
            message.sessionId,
            message.hostBootId,
            message.navigationGeneration,
            [{
              modelRequestId: message.modelRequestId,
              attemptSeq: message.attemptSeq,
              socketGeneration: message.socketGeneration,
              streamSeq: headStreamSeq!
            }]
          );
          reportTransientSnapshotDiagnostic(this.$state, message, 'transient-snapshot-replayed');
          return;
        }
        if (prior) this.transientModelRequests[message.modelRequestId] = prior;
        this.ackTransientDelivery(
          message.deliveryId,
          message.sessionId,
          message.hostBootId,
          message.navigationGeneration,
          prior ? [transientHead(prior)] : []
        );
        reportTransientSnapshotDiagnostic(this.$state, message, 'transient-snapshot-rejected');
        return;
      }
      recovered.streamSeq = headStreamSeq!;
      recovered.updatedAt = timestamp(message.observedAt) || Date.now();
      recovered.recovering = false;
      const key = transientRecoveryKey(message.modelRequestId, message.attemptSeq, message.socketGeneration);
      delete this.pendingTransientRecoveries[key];
      this.ackTransientDelivery(
        message.deliveryId,
        message.sessionId,
        message.hostBootId,
        message.navigationGeneration,
        [transientHead(recovered)]
      );
      reportTransientSnapshotDiagnostic(this.$state, message, 'transient-snapshot-replayed');
    },

    ackTransientDelivery(
      deliveryId: string,
      sessionId: string,
      hostBootId: string,
      navigationGeneration: string | undefined,
      heads: ReturnType<typeof transientHead>[]
    ): void {
      bridge.postRaw({
        type: RELIABLE_KERNEL_TRANSIENT_ACK_MESSAGE,
        deliveryId,
        sessionId,
        hostBootId,
        ...(navigationGeneration ? { navigationGeneration } : {}),
        heads
      });
    },

    observeTransient(message: ReliableKernelTransientMessage, debugMode: { mode: 'apply' | 'rebuild'; snapshotId?: string; headStreamSeq?: string } = { mode: 'apply' }): void {
      if (
        !this.hostBootId
        || message.hostBootId !== this.hostBootId
        || !this.sessionId
        || message.sessionId !== this.sessionId
        || this.retiredSessionIds.includes(message.sessionId)
      ) return;
      const activeConversationId = stringValue(plainRecord(this.projections.activeConversationWindow)?.conversationId);
      if (!activeConversationId || message.conversationId !== activeConversationId) return;
      const incomingGeneration = optionalDecimal(message.navigationGeneration);
      if (
        incomingGeneration
        && this.navigationGeneration
        && BigInt(incomingGeneration) !== BigInt(this.navigationGeneration)
      ) return;
      const sequence = decimal(message.event.streamSeq);
      const requestSeq = positiveDecimal(message.requestSeq);
      const providerId = nonEmptyString(message.providerId);
      const modelId = nonEmptyString(message.modelId);
      if (sequence === undefined || !requestSeq || !providerId || !modelId) return;
      const attemptSeq = optionalDecimal(message.attemptSeq);
      const socketGeneration = optionalDecimal(message.socketGeneration);
      const afterCommitSeq = optionalDecimal(message.afterCommitSeq);
      const prior = this.transientModelRequests[message.modelRequestId];
      const identity = compareReliableTransientIdentity(prior, attemptSeq, socketGeneration);
      if (identity === 'stale') return;
      const current = identity === 'newer' ? undefined : prior;
      if (current && BigInt(current.streamSeq) >= BigInt(sequence)) return;
      const content = plainRecord(message.event.content);
      const outputItem = modelOutputItemValue(content?.outputItem);
      const observedAt = timestamp(message.observedAt) || Date.now();
      const debug = debugContext(message);
      const observeTool: ReliableToolApplyObserver | undefined = debugCaptureTrace.active(debug) ? change => {
        debugCaptureTrace.tool(debug, { ...debugFrameMetadata(message), ...debugMode, callId: change.callId, streamIndex: change.streamIndex ?? null, operation: change.operation }, change.before, change.fragment, change.after);
      } : undefined;
      const next: ReliableKernelTransientState = current
        ? {
            ...current,
            streamSeq: sequence,
            updatedAt: observedAt,
            ...(afterCommitSeq ? { afterCommitSeq } : {})
          }
        : {
            conversationId: message.conversationId,
            turnId: message.turnId,
            modelRequestId: message.modelRequestId,
            requestSeq,
            providerId,
            modelId,
            ...(attemptSeq ? { attemptSeq } : {}),
            ...(socketGeneration ? { socketGeneration } : {}),
            ...(afterCommitSeq ? { afterCommitSeq } : {}),
            streamSeq: sequence,
            text: '',
            thought: '',
            outputParts: [],
            toolCalls: [],
            status: 'streaming',
            startedAt: observedAt,
            updatedAt: observedAt
          };
      if (message.event.kind === 'completed') {
        const completedContent = messageContentValue(content);
        if (!completedContent) return;
        next.completedContent = completedContent;
        next.outputParts = cloneReliableTransientParts(completedContent.parts);
        next.text = completedContent.parts
          .filter((part) => 'text' in part && part.thought !== true)
          .map((part) => 'text' in part ? part.text : '')
          .join('');
        next.thought = completedContent.parts
          .filter((part) => 'text' in part && part.thought === true)
          .map((part) => 'text' in part ? part.text : '')
          .join('\n');
        const terminalThoughtParts = completedContent.parts
          .filter((part) => 'text' in part && part.thought === true);
        next.thoughtSignature = [...terminalThoughtParts]
          .reverse()
          .map((part) => 'thoughtSignature' in part ? part.thoughtSignature : undefined)
          .find((value): value is string => typeof value === 'string')
          ?? next.thoughtSignature;
        const thoughtDurationMs = terminalThoughtParts
          .map((part) => 'thoughtDurationMs' in part ? nonNegativeNumber(part.thoughtDurationMs) ?? 0 : 0)
          .reduce((sum, duration) => sum + duration, 0)
          || next.thoughtDurationMs
          || (next.thoughtActive
            ? (next.thoughtCompletedDurationMs ?? 0) + currentTransientThoughtDurationMs(next, observedAt)
            : next.thoughtCompletedDurationMs);
        if (thoughtDurationMs !== undefined) {
          next.thoughtDurationMs = thoughtDurationMs;
          next.thoughtCompletedDurationMs = thoughtDurationMs;
        }
        next.thoughtActive = false;
        delete next.thoughtStartedAt;
        delete next.thoughtElapsedMs;
        next.toolCalls = replaceReliableCompletedToolCalls(
          completedContent.parts.flatMap((part) => 'functionCall' in part
            ? [{
                ...(part.id ? { id: part.id } : {}),
                name: part.functionCall.name,
                arguments: part.functionCall.args,
                ...(part.outputItem ? { outputItem: part.outputItem } : {})
              }]
            : []),
          message.modelRequestId,
          observedAt,
          undefined,
          observeTool,
          next.toolCalls
        ) ?? [];
        const usage = plainRecord(message.event.usage);
        if (usage) next.usageMetadata = usage;
        const timing = plainRecord(message.event.timing);
        next.providerStartedAt = positiveNumber(timing?.providerStartedAt) ?? next.providerStartedAt;
        next.firstOutputAt = positiveNumber(timing?.firstOutputAt) ?? next.firstOutputAt;
        next.completedAt = positiveNumber(timing?.completedAt) ?? next.completedAt;
        next.streamOutputDurationMs = nonNegativeNumber(timing?.streamOutputDurationMs)
          ?? next.streamOutputDurationMs;
        next.status = 'completed';
      } else if (message.event.kind === 'failed' || message.event.kind === 'cancelled') {
        next.status = message.event.kind;
        // A Provider failure never authorizes dispatch of a partially assembled call. Retain
        // auditable text/thought output, but remove the live tool card so it cannot still look active.
        next.toolCalls = [];
        next.outputParts = next.outputParts.filter((part) => !('functionCall' in part));
        if (content?.discardOutput === true) {
          next.text = '';
          next.thought = '';
          next.outputParts = [];
          next.toolCalls = [];
          delete next.completedContent;
          delete next.thoughtSignature;
          delete next.thoughtStartedAt;
          delete next.thoughtCompletedDurationMs;
          delete next.thoughtElapsedMs;
          delete next.thoughtDurationMs;
          delete next.usageMetadata;
          delete next.firstOutputAt;
          delete next.completedAt;
          delete next.streamOutputDurationMs;
        }
        const terminalText = stringValue(content?.text);
        if (terminalText !== undefined) next.text = terminalText;
        const terminalThought = stringValue(content?.thought);
        if (terminalThought !== undefined) next.thought = terminalThought;
        if (next.thoughtActive) {
          const thoughtBlockDurationMs = currentTransientThoughtDurationMs(next, observedAt);
          next.thoughtDurationMs = (next.thoughtCompletedDurationMs ?? 0) + thoughtBlockDurationMs;
          next.thoughtCompletedDurationMs = next.thoughtDurationMs;
          next.outputParts = updateReliableTransientThoughtPart(next.outputParts, {
            ...(next.thoughtSignature ? { thoughtSignature: next.thoughtSignature } : {}),
            thoughtDurationMs: thoughtBlockDurationMs,
            done: true
          });
        }
        next.thoughtActive = false;
        delete next.thoughtStartedAt;
        delete next.thoughtElapsedMs;
      } else if (content?.type === 'text_delta') {
        const delta = stringValue(content.text) ?? '';
        next.text += delta;
        if (delta) {
          next.outputParts = appendReliableTransientTextPart(next.outputParts, {
            text: delta,
            thought: false,
            ...(outputItem ? { outputItem } : {})
          });
        }
      } else if (content?.type === 'thought_delta') {
        const delta = stringValue(content.text) ?? '';
        next.thought += delta;
        next.thoughtSignature = stringValue(content.thoughtSignature) ?? next.thoughtSignature;
        openTransientThought(next, content, observedAt);
        if (delta) {
          next.outputParts = appendReliableTransientTextPart(next.outputParts, {
            text: delta,
            thought: true,
            ...(outputItem ? { outputItem } : {}),
            ...(next.thoughtSignature ? { thoughtSignature: next.thoughtSignature } : {}),
            ...(next.thoughtStartedAt !== undefined ? { thoughtStartedAt: next.thoughtStartedAt } : {}),
            ...(next.thoughtCompletedDurationMs !== undefined
              ? { thoughtCompletedDurationMs: next.thoughtCompletedDurationMs }
              : {}),
            ...(next.thoughtElapsedMs !== undefined ? { thoughtElapsedMs: next.thoughtElapsedMs } : {})
          });
        }
      } else if (content?.type === 'thought_progress') {
        next.thoughtSignature = stringValue(content.thoughtSignature) ?? next.thoughtSignature;
        openTransientThought(next, content, observedAt);
        next.outputParts = updateReliableTransientThoughtPart(next.outputParts, {
          ...(outputItem ? { outputItem } : {}),
          ...(next.thoughtSignature ? { thoughtSignature: next.thoughtSignature } : {}),
          ...(next.thoughtStartedAt !== undefined ? { thoughtStartedAt: next.thoughtStartedAt } : {}),
          ...(next.thoughtCompletedDurationMs !== undefined
            ? { thoughtCompletedDurationMs: next.thoughtCompletedDurationMs }
            : {}),
          ...(next.thoughtElapsedMs !== undefined ? { thoughtElapsedMs: next.thoughtElapsedMs } : {})
        });
      } else if (content?.type === 'thought_done') {
        const thoughtBlockDurationMs = nonNegativeNumber(content.thoughtBlockDurationMs)
          ?? nonNegativeNumber(content.thoughtDurationMs)
          ?? currentTransientThoughtDurationMs(next, observedAt);
        const thoughtDurationMs = nonNegativeNumber(content.thoughtDurationMs)
          ?? nonNegativeNumber(content.thoughtCompletedDurationMs)
          ?? (next.thoughtCompletedDurationMs ?? 0) + thoughtBlockDurationMs;
        next.thoughtDurationMs = thoughtDurationMs;
        next.thoughtCompletedDurationMs = thoughtDurationMs;
        next.thoughtActive = false;
        delete next.thoughtStartedAt;
        delete next.thoughtElapsedMs;
        next.thoughtSignature = stringValue(content.thoughtSignature) ?? next.thoughtSignature;
        next.outputParts = updateReliableTransientThoughtPart(next.outputParts, {
          ...(outputItem ? { outputItem } : {}),
          ...(next.thoughtSignature ? { thoughtSignature: next.thoughtSignature } : {}),
          thoughtDurationMs: thoughtBlockDurationMs,
          done: true
        });
      } else if (content?.type === 'output_item_done' && outputItem) {
        next.outputParts = applyReliableTransientOutputItem(next.outputParts, outputItem);
      } else if (content?.type === 'tool_call_delta') {
        next.toolCalls = mergeReliableToolCallDeltas(
          next.toolCalls,
          content.calls,
          message.modelRequestId,
          observedAt,
          outputItem,
          observeTool
        );
        next.outputParts = syncReliableTransientFunctionCallParts(next.outputParts, next.toolCalls);
      } else if (content?.type === 'tool_calls' && Array.isArray(content.calls)) {
        next.toolCalls = mergeReliableCompletedToolCalls(
          next.toolCalls,
          content.calls,
          message.modelRequestId,
          observedAt,
          outputItem,
          observeTool
        );
        next.outputParts = syncReliableTransientFunctionCallParts(next.outputParts, next.toolCalls);
      }
      this.transientModelRequests[message.modelRequestId] = next;
      debugCaptureTrace.observe(debug, () => ({ stage: 'ui.frame', metadata: { ...debugFrameMetadata(message), ...debugMode, decision: 'applied', status: next.status }, payload: message.event }));
      // A streaming delta cannot retire any overlay. Full reconciliation scans the bounded durable
      // window and is needed only at terminal events or durable Feed commits.
      if (next.status !== 'streaming') {
        reconcileReliableTransientRequests(this.transientModelRequests, this.records, this.details);
      }
      if (!current) reportTransientPaint(this.sessionId, message, sequence);
    },

    setPinnedDetailKeys(keys: string[]): void {
      this.pinnedDetailKeys = [...new Set(keys.filter((key) => key.length > 0))].slice(0, 256);
      pruneDetailCache(this.$state);
    },

    requestDetail(
      kind: ReliableKernelClientDetailKind,
      recordId: string,
      options: ReliableKernelDetailRequestOptions = {}
    ): string | undefined {
      const id = recordId.trim();
      const sessionId = this.sessionId;
      if (!id || !sessionId) return undefined;
      const key = detailKey(kind, id);
      const current = this.details[key];
      const priority = options.priority ?? 'visible';
      if (current?.status === 'ready') {
        const pending = Object.values(this.pendingDetails).find((request) => request.key === key);
        if (pending && DETAIL_PRIORITY_ORDER[priority] < DETAIL_PRIORITY_ORDER[pending.priority]) {
          pending.priority = priority;
          this.sortDetailQueue();
          this.pumpDetailQueue();
        }
        this.detailCacheMeta[key] = {
          lastAccessedAt: Date.now(),
          bytes: current.totalBytes
        };
        return key;
      }
      if (current?.status === 'error') {
        if (current.terminalError || !options.bypassBackoff) {
          if (!current.terminalError && current.nextRetryAt !== undefined) {
            this.scheduleDetailRetry(kind, id, {
              priority,
              retryCount: current.retryCount ?? 0,
              mode: 'initial'
            }, Math.max(0, current.nextRetryAt - Date.now()));
          }
          return key;
        }
        clearDetailRetryTimer(key);
        delete this.details[key];
        delete this.detailCacheMeta[key];
      }
      if (current?.status === 'loading') {
        const pending = Object.values(this.pendingDetails).find((request) => request.key === key);
        if (pending && DETAIL_PRIORITY_ORDER[priority] < DETAIL_PRIORITY_ORDER[pending.priority]) {
          pending.priority = priority;
          this.sortDetailQueue();
          this.pumpDetailQueue();
        }
        return key;
      }
      clearDetailRetryTimer(key);
      const requestId = createMessageId();
      const retryCount = options.retryCount ?? current?.retryCount ?? 0;
      this.details[key] = {
        status: 'loading',
        text: '',
        totalBytes: 0,
        ...(retryCount > 0 ? { retryCount } : {})
      };
      detailTextChunks.set(requestId, []);
      this.pendingDetails[requestId] = {
        key,
        kind,
        recordId: id,
        nextOffset: 0,
        sessionId,
        priority,
        enqueuedAt: Date.now(),
        mode: 'initial',
        retryCount
      };
      this.detailQueue.push(requestId);
      this.sortDetailQueue();
      this.pumpDetailQueue();
      return key;
    },

    reloadDetail(
      kind: ReliableKernelClientDetailKind,
      recordId: string,
      options: { priority?: ReliableKernelDetailPriority } = {}
    ): string | undefined {
      const id = recordId.trim();
      if (!id) return undefined;
      const key = detailKey(kind, id);
      clearDetailRetryTimer(key);
      const cancelledRequestIds = Object.entries(this.pendingDetails)
        .filter(([, pending]) => pending.key === key)
        .map(([requestId]) => requestId);
      for (const requestId of cancelledRequestIds) {
        const timeout = detailRequestTimeouts.get(requestId);
        if (timeout !== undefined) clearTimeout(timeout);
        detailRequestTimeouts.delete(requestId);
        detailDecoders.delete(requestId);
        detailTextChunks.delete(requestId);
        delete this.pendingDetails[requestId];
      }
      if (cancelledRequestIds.length > 0) {
        const cancelled = new Set(cancelledRequestIds);
        this.detailQueue = this.detailQueue.filter((requestId) => !cancelled.has(requestId));
        this.activeDetailRequestIds = this.activeDetailRequestIds.filter((requestId) => !cancelled.has(requestId));
      }
      delete this.details[key];
      delete this.detailCacheMeta[key];
      const requested = this.requestDetail(kind, id, {
        ...options,
        retryCount: 0,
        bypassBackoff: true
      });
      this.pumpDetailQueue();
      return requested;
    },

    retryDetail(
      kind: ReliableKernelClientDetailKind,
      recordId: string,
      options: { priority?: ReliableKernelDetailPriority } = {}
    ): string | undefined {
      const key = detailKey(kind, recordId.trim());
      const current = this.details[key];
      if (current?.status === 'ready') {
        clearDetailRetryTimer(key);
        return this.refreshDetail(kind, recordId, {
          ...options,
          retryCount: 0,
          bypassBackoff: true
        });
      }
      return this.reloadDetail(kind, recordId, options);
    },

    /** Continues a mutable process stream from its already-rendered durable byte prefix. */
    refreshDetail(
      kind: ReliableKernelClientDetailKind,
      recordId: string,
      options: ReliableKernelDetailRequestOptions = {}
    ): string | undefined {
      const id = recordId.trim();
      const sessionId = this.sessionId;
      const key = detailKey(kind, id);
      const current = this.details[key];
      if (!id || !sessionId || current?.status !== 'ready') {
        return this.requestDetail(kind, recordId, options);
      }
      const existing = Object.values(this.pendingDetails).find((request) => request.key === key);
      if (existing) {
        const priority = options.priority ?? 'visible';
        if (DETAIL_PRIORITY_ORDER[priority] < DETAIL_PRIORITY_ORDER[existing.priority]) {
          existing.priority = priority;
          this.sortDetailQueue();
          this.pumpDetailQueue();
        }
        return key;
      }
      const priority = options.priority ?? 'visible';
      if (current.refreshError && !options.bypassBackoff) {
        if (!current.terminalError && current.nextRetryAt !== undefined) {
          this.scheduleDetailRetry(kind, id, {
            priority,
            retryCount: current.retryCount ?? 0,
            mode: 'refresh'
          }, Math.max(0, current.nextRetryAt - Date.now()));
        }
        return key;
      }
      clearDetailRetryTimer(key);
      const requestId = createMessageId();
      this.details[key] = {
        status: 'ready',
        text: current.text,
        totalBytes: current.totalBytes,
        refreshing: true
      };
      detailTextChunks.set(requestId, [current.text]);
      this.pendingDetails[requestId] = {
        key,
        kind,
        recordId: id,
        nextOffset: current.totalBytes,
        sessionId,
        priority,
        enqueuedAt: Date.now(),
        mode: 'refresh',
        retryCount: options.retryCount ?? current.retryCount ?? 0
      };
      this.detailQueue.push(requestId);
      this.sortDetailQueue();
      this.pumpDetailQueue();
      return key;
    },

    observeDetailResult(message: ReliableKernelDetailResultMessage): void {
      if (message.sessionId !== this.sessionId) return;
      const pending = this.pendingDetails[message.requestId];
      if (!pending || pending.sessionId !== message.sessionId || message.detail.recordId !== pending.recordId) return;
      if (
        message.detail.offset !== pending.nextOffset
        || (pending.totalBytes !== undefined && pending.totalBytes !== message.detail.totalBytes)
      ) {
        this.failDetailRequest(
          message.requestId,
          '详情分块不连续；未将不完整内容标记为已就绪。',
          message.detail.totalBytes
        );
        return;
      }
      const bytes = decodeBase64Bytes(message.detail.chunk);
      const nextOffset = message.detail.offset + bytes.byteLength;
      if (
        nextOffset > message.detail.totalBytes
        || (message.detail.hasMore && message.detail.nextOffset !== nextOffset)
        || (!message.detail.hasMore && nextOffset !== message.detail.totalBytes)
      ) {
        this.failDetailRequest(
          message.requestId,
          '对话详情数据不完整，请重新加载。',
          message.detail.totalBytes
        );
        return;
      }
      pending.nextOffset = nextOffset;
      pending.totalBytes = message.detail.totalBytes;
      const decoder = detailDecoder(message.requestId);
      const currentDetail = this.details[pending.key];
      const requestOwnsDetail = pending.mode === 'refresh'
        ? currentDetail?.status === 'ready' && currentDetail.refreshing === true
        : currentDetail?.status === 'loading';
      if (!currentDetail || !requestOwnsDetail) {
        this.finishDetailRequest(message.requestId);
        return;
      }
      try {
        detailTextChunks.get(message.requestId)?.push(
          decoder.decode(bytes, { stream: message.detail.hasMore })
        );
        if (pending.mode === 'initial') currentDetail.totalBytes = message.detail.totalBytes;
      } catch (error) {
        this.failDetailRequest(
          message.requestId,
          error instanceof Error ? error.message : '详情内容解码失败。',
          message.detail.totalBytes
        );
        return;
      }
      if (message.detail.hasMore && message.detail.nextOffset !== undefined) {
        this.postDetailChunk(message.requestId, message.detail.nextOffset);
        return;
      }
      try {
        const chunks = detailTextChunks.get(message.requestId) ?? [];
        chunks.push(decoder.decode());
        this.details[pending.key] = {
          status: 'ready',
          text: chunks.join(''),
          totalBytes: message.detail.totalBytes
        };
        clearDetailRetryTimer(pending.key);
        this.detailCacheMeta[pending.key] = {
          lastAccessedAt: Date.now(),
          bytes: message.detail.totalBytes
        };
        pruneDetailCache(this.$state);
        // The durable Message shell can precede its on-demand body. Retire a completed transient
        // overlay in the same action that makes the final detail ready, rather than waiting for an
        // unrelated later feed commit or transient event to trigger reconciliation.
        reconcileReliableTransientRequests(this.transientModelRequests, this.records, this.details);
      } catch (error) {
        this.failDetailRequest(
          message.requestId,
          error instanceof Error ? error.message : '详情内容解码失败。',
          message.detail.totalBytes
        );
        return;
      }
      this.finishDetailRequest(message.requestId);
    },

    observeDetailError(message: ReliableKernelDetailErrorMessage): void {
      if (message.sessionId !== this.sessionId) return;
      const pending = this.pendingDetails[message.requestId];
      if (!pending || pending.sessionId !== message.sessionId) return;
      this.failDetailRequest(message.requestId, message.message);
    },

    failDetailRequest(requestId: string, error: string, totalBytes?: number): void {
      const pending = this.pendingDetails[requestId];
      if (!pending) return;
      const current = this.details[pending.key];
      const retryCount = pending.retryCount + 1;
      const retryDelay = DETAIL_AUTO_RETRY_DELAYS_MS[retryCount - 1];
      const nextRetryAt = retryDelay === undefined ? undefined : Date.now() + retryDelay;
      if (pending.mode === 'refresh' && current?.status === 'ready') {
        this.details[pending.key] = {
          status: 'ready',
          text: current.text,
          totalBytes: current.totalBytes,
          refreshError: error,
          retryCount,
          ...(nextRetryAt !== undefined ? { nextRetryAt } : {})
        };
      } else {
        this.details[pending.key] = {
          status: 'error',
          text: '',
          totalBytes: totalBytes ?? current?.totalBytes ?? 0,
          error,
          retryCount,
          ...(nextRetryAt !== undefined ? { nextRetryAt } : {})
        };
      }
      this.finishDetailRequest(requestId);
      if (retryDelay !== undefined) {
        this.scheduleDetailRetry(pending.kind, pending.recordId, {
          priority: pending.priority,
          retryCount,
          mode: pending.mode
        }, retryDelay);
      }
    },

    scheduleDetailRetry(
      kind: ReliableKernelClientDetailKind,
      recordId: string,
      retry: {
        priority: ReliableKernelDetailPriority;
        retryCount: number;
        mode: 'initial' | 'refresh';
      },
      delayMs: number
    ): void {
      const id = recordId.trim();
      const sessionId = this.sessionId;
      if (!id || !sessionId) return;
      const key = detailKey(kind, id);
      clearDetailRetryTimer(key);
      detailRetryTimeouts.set(key, setTimeout(() => {
        detailRetryTimeouts.delete(key);
        if (this.sessionId !== sessionId) return;
        const current = this.details[key];
        if (retry.mode === 'refresh') {
          if (current?.status !== 'ready' || !current.refreshError || current.terminalError) return;
          this.refreshDetail(kind, id, {
            priority: retry.priority,
            retryCount: retry.retryCount,
            bypassBackoff: true
          });
          return;
        }
        if (current?.status !== 'error' || current.terminalError) return;
        this.requestDetail(kind, id, {
          priority: retry.priority,
          retryCount: retry.retryCount,
          bypassBackoff: true
        });
      }, Math.max(0, Math.round(delayMs))));
    },

    expireDetailRequest(requestId: string): void {
      if (!this.pendingDetails[requestId]) return;
      this.failDetailRequest(requestId, '详情请求超时，可重试。');
    },

    pumpDetailQueue(): void {
      this.sortDetailQueue();
      while (
        this.activeDetailRequestIds.length < DETAIL_MAX_INFLIGHT_REQUESTS
        && this.detailQueue.length > 0
      ) {
        const requestId = this.detailQueue.shift();
        const pending = requestId ? this.pendingDetails[requestId] : undefined;
        if (!requestId || !pending) continue;
        this.activeDetailRequestIds.push(requestId);
        this.postDetailChunk(requestId, pending.nextOffset);
      }
    },

    finishDetailRequest(requestId: string): void {
      const timeout = detailRequestTimeouts.get(requestId);
      if (timeout !== undefined) clearTimeout(timeout);
      detailRequestTimeouts.delete(requestId);
      detailDecoders.delete(requestId);
      detailTextChunks.delete(requestId);
      delete this.pendingDetails[requestId];
      this.activeDetailRequestIds = this.activeDetailRequestIds.filter((id) => id !== requestId);
      this.detailQueue = this.detailQueue.filter((id) => id !== requestId);
      this.pumpDetailQueue();
    },

    sortDetailQueue(): void {
      this.detailQueue.sort((leftId, rightId) => {
        const left = this.pendingDetails[leftId];
        const right = this.pendingDetails[rightId];
        if (!left) return 1;
        if (!right) return -1;
        return DETAIL_PRIORITY_ORDER[left.priority] - DETAIL_PRIORITY_ORDER[right.priority]
          || left.enqueuedAt - right.enqueuedAt
          || leftId.localeCompare(rightId);
      });
    },

    postDetailChunk(requestId: string, offset: number): void {
      const pending = this.pendingDetails[requestId];
      const sessionId = this.sessionId;
      if (
        !pending
        || !sessionId
        || pending.sessionId !== sessionId
        || !this.activeDetailRequestIds.includes(requestId)
      ) return;
      const priorTimeout = detailRequestTimeouts.get(requestId);
      if (priorTimeout !== undefined) clearTimeout(priorTimeout);
      detailRequestTimeouts.set(requestId, setTimeout(() => {
        detailRequestTimeouts.delete(requestId);
        this.expireDetailRequest(requestId);
      }, DETAIL_REQUEST_DEADLINE_MS));
      bridge.postRaw({
        type: RELIABLE_KERNEL_DETAIL_REQUEST_MESSAGE,
        requestId,
        sessionId,
        kind: pending.kind,
        recordId: pending.recordId,
        offset,
        maxBytes: DETAIL_CHUNK_MAX_BYTES,
        ...(pending.totalBytes === undefined ? {} : { expectedTotalBytes: pending.totalBytes })
      });
    }
  }
});

export function isReliableKernelFeedMessage(message: unknown): boolean {
  return isReliableKernelFeedDataMessage(message)
    || isReliableKernelDetailResultMessage(message)
    || isReliableKernelDetailErrorMessage(message)
    || isReliableKernelCollaborationHistoryResultMessage(message)
    || isReliableKernelCollaborationHistoryErrorMessage(message)
    || isReliableKernelHistoryPageResultMessage(message)
    || isReliableKernelHistoryPageErrorMessage(message)
    || isReliableKernelTransientSnapshotMessage(message)
    || isReliableKernelTransientBatchMessage(message)
    || isReliableKernelTransientMessage(message);
}

export function isReliableKernelFeedDataMessage(message: unknown): boolean {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const type = (message as Record<string, unknown>).type;
  return type === RELIABLE_KERNEL_SNAPSHOT_MESSAGE || type === RELIABLE_KERNEL_CHANGES_MESSAGE;
}

function isReliableKernelDetailResultMessage(message: unknown): message is ReliableKernelDetailResultMessage {
  return isRecord(message) && message.type === RELIABLE_KERNEL_DETAIL_RESULT_MESSAGE;
}

function isReliableKernelDetailErrorMessage(message: unknown): message is ReliableKernelDetailErrorMessage {
  return isRecord(message) && message.type === RELIABLE_KERNEL_DETAIL_ERROR_MESSAGE;
}

function isReliableKernelCollaborationHistoryResultMessage(
  message: unknown
): message is ReliableKernelCollaborationHistoryResultMessage {
  return isRecord(message) && message.type === RELIABLE_KERNEL_COLLABORATION_HISTORY_RESULT_MESSAGE
    && isRecord(message.page) && isRecord(message.page.records);
}

function isReliableKernelCollaborationHistoryErrorMessage(
  message: unknown
): message is ReliableKernelCollaborationHistoryErrorMessage {
  return isRecord(message) && message.type === RELIABLE_KERNEL_COLLABORATION_HISTORY_ERROR_MESSAGE;
}

function isReliableKernelHistoryPageResultMessage(message: unknown): message is ReliableKernelHistoryPageResultMessage {
  return isRecord(message)
    && message.type === RELIABLE_KERNEL_HISTORY_PAGE_RESULT_MESSAGE
    && isRecord(message.page)
    && isRecord(message.page.records);
}

function isReliableKernelHistoryPageErrorMessage(message: unknown): message is ReliableKernelHistoryPageErrorMessage {
  return isRecord(message) && message.type === RELIABLE_KERNEL_HISTORY_PAGE_ERROR_MESSAGE;
}

function isReliableKernelTransientBatchMessage(message: unknown): message is ReliableKernelTransientBatchMessage {
  return isRecord(message)
    && message.type === RELIABLE_KERNEL_TRANSIENT_BATCH_MESSAGE
    && nonEmptyString(message.deliveryId) !== undefined
    && Array.isArray(message.events)
    && message.events.length > 0
    && message.events.every((event) =>
      isRecord(event)
      && decimal(event.fromStreamSeq) !== undefined
      && isRecord(event.event)
      && decimal(event.event.streamSeq) !== undefined
    );
}

function isReliableKernelTransientSnapshotMessage(message: unknown): message is ReliableKernelTransientSnapshotMessage {
  return isRecord(message)
    && message.type === RELIABLE_KERNEL_TRANSIENT_SNAPSHOT_MESSAGE
    && nonEmptyString(message.deliveryId) !== undefined
    && decimal(message.headStreamSeq) !== undefined
    && Array.isArray(message.events)
    && message.events.length > 0
    && message.events.every((event) => isRecord(event) && isRecord(event.event));
}

function isReliableKernelTransientMessage(message: unknown): message is ReliableKernelTransientMessage {
  return isRecord(message)
    && message.type === RELIABLE_KERNEL_TRANSIENT_MESSAGE
    && decimal(message.fromStreamSeq) !== undefined
    && isRecord(message.event)
    && decimal(message.event.streamSeq) !== undefined;
}

function reportFeedPaint(message: unknown, conversationId?: string): void {
  const record = plainRecord(message);
  const sessionId = stringValue(record?.sessionId);
  const messageSeq = decimal(record?.messageSeq);
  if (!sessionId || !messageSeq) return;
  afterNextPaint(() => bridge.postRaw({
    type: RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE,
    sessionId,
    eventKind: 'feed-painted',
    observedAt: new Date().toISOString(),
    ...(conversationId ? { conversationId } : {}),
    messageSeq
  }));
}

function reportTransientPaint(
  sessionId: string | null,
  message: ReliableKernelTransientMessage,
  streamSeq: string
): void {
  const generation = `${message.modelRequestId}:${message.attemptSeq ?? '0'}:${message.socketGeneration ?? '0'}`;
  if (!sessionId || reportedTransientPaints.has(generation)) return;
  reportedTransientPaints.add(generation);
  while (reportedTransientPaints.size > MAX_REPORTED_TRANSIENT_PAINTS) {
    const oldest = reportedTransientPaints.values().next().value as string | undefined;
    if (!oldest) break;
    reportedTransientPaints.delete(oldest);
  }
  afterNextPaint(() => bridge.postRaw({
    type: RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE,
    sessionId,
    eventKind: 'transient-painted',
    observedAt: new Date().toISOString(),
    conversationId: message.conversationId,
    turnId: message.turnId,
    modelRequestId: message.modelRequestId,
    ...(message.attemptSeq ? { attemptSeq: message.attemptSeq } : {}),
    ...(message.socketGeneration ? { socketGeneration: message.socketGeneration } : {}),
    streamSeq
  }));
}

function transientEnvelopeMatches(
  state: ReliableKernelFeedStoreState,
  message: {
    sessionId: string;
    hostBootId: string;
    navigationGeneration?: string;
    conversationId: string;
  }
): boolean {
  if (
    !state.hostBootId
    || message.hostBootId !== state.hostBootId
    || !state.sessionId
    || message.sessionId !== state.sessionId
    || state.retiredSessionIds.includes(message.sessionId)
  ) return false;
  const conversationId = activeConversationId(state.projections);
  if (!conversationId || message.conversationId !== conversationId) return false;
  const incomingGeneration = optionalDecimal(message.navigationGeneration);
  return !(
    incomingGeneration
    && state.navigationGeneration
    && BigInt(incomingGeneration) !== BigInt(state.navigationGeneration)
  );
}

type TransientContinuityDecision =
  | { kind: 'accept'; replacesIdentity: boolean }
  | { kind: 'stale' }
  | { kind: 'gap'; afterStreamSeq: string }
  | { kind: 'invalid' };

function transientContinuityDecision(
  current: ReliableKernelTransientState | undefined,
  message: ReliableKernelTransientMessage
): TransientContinuityDecision {
  const fromStreamSeq = decimal(message.fromStreamSeq);
  const streamSeq = decimal(message.event.streamSeq);
  const attemptSeq = decimal(message.attemptSeq);
  const socketGeneration = decimal(message.socketGeneration);
  if (
    fromStreamSeq === undefined
    || streamSeq === undefined
    || attemptSeq === undefined
    || socketGeneration === undefined
    || BigInt(streamSeq) < BigInt(fromStreamSeq)
  ) return { kind: 'invalid' };
  const identity = compareReliableTransientIdentity(current, attemptSeq, socketGeneration);
  if (identity === 'stale') return { kind: 'stale' };
  const replacesIdentity = identity === 'newer';
  const afterStreamSeq = replacesIdentity ? '0' : current?.streamSeq ?? '0';
  if (!replacesIdentity && BigInt(streamSeq) <= BigInt(afterStreamSeq)) return { kind: 'stale' };
  if (BigInt(fromStreamSeq) !== BigInt(afterStreamSeq) + 1n) {
    return { kind: 'gap', afterStreamSeq };
  }
  return { kind: 'accept', replacesIdentity };
}

function transientSnapshotItemMatches(
  snapshot: ReliableKernelTransientSnapshotMessage,
  item: ReliableKernelTransientBatchItem,
  headStreamSeq: string
): boolean {
  const fromStreamSeq = decimal(item.fromStreamSeq);
  const streamSeq = decimal(item.event.streamSeq);
  const kind = item.event.kind;
  const validKind = kind === 'output_delta'
    || kind === 'output_item_done'
    || kind === 'completed'
    || kind === 'failed'
    || kind === 'cancelled';
  const validCompletedContent = kind !== 'completed' || messageContentValue(item.event.content) !== undefined;
  return validKind
    && validCompletedContent
    && item.modelRequestId === snapshot.modelRequestId
    && item.turnId === snapshot.turnId
    && item.requestSeq === snapshot.requestSeq
    && item.providerId === snapshot.providerId
    && item.modelId === snapshot.modelId
    && item.attemptSeq === snapshot.attemptSeq
    && item.socketGeneration === snapshot.socketGeneration
    && item.afterCommitSeq === snapshot.afterCommitSeq
    && fromStreamSeq !== undefined
    && streamSeq !== undefined
    && BigInt(streamSeq) >= BigInt(fromStreamSeq)
    && BigInt(streamSeq) <= BigInt(headStreamSeq);
}

function transientHead(state: ReliableKernelTransientState): {
  modelRequestId: string;
  attemptSeq: string;
  socketGeneration: string;
  streamSeq: string;
} {
  return {
    modelRequestId: state.modelRequestId,
    attemptSeq: state.attemptSeq ?? '0',
    socketGeneration: state.socketGeneration ?? '0',
    streamSeq: state.streamSeq
  };
}

function transientHeadsForItems(
  states: Record<string, ReliableKernelTransientState>,
  items: ReliableKernelTransientBatchItem[]
): ReturnType<typeof transientHead>[] {
  const result: ReturnType<typeof transientHead>[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.modelRequestId)) continue;
    seen.add(item.modelRequestId);
    const state = states[item.modelRequestId];
    if (state) result.push(transientHead(state));
  }
  return result;
}

function transientRecoveryKey(
  modelRequestId: string,
  attemptSeq: string,
  socketGeneration: string
): string {
  return `${modelRequestId}\0${attemptSeq}\0${socketGeneration}`;
}

function removeTransientRecoveriesForModelRequest(
  recoveries: Record<string, PendingTransientRecovery>,
  modelRequestId: string
): Record<string, PendingTransientRecovery> {
  return Object.fromEntries(
    Object.entries(recoveries).filter(([, recovery]) => recovery.modelRequestId !== modelRequestId)
  );
}

function markTransientRequestsRecovering(
  requests: Record<string, ReliableKernelTransientState>
): Record<string, ReliableKernelTransientState> {
  return Object.fromEntries(
    Object.entries(requests).map(([id, request]) => [id, { ...request, recovering: true }])
  );
}

function reportTransientRecoveryDiagnostic(
  state: ReliableKernelFeedStoreState,
  message: ReliableKernelTransientMessage,
  eventKind: 'transient-gap',
  streamSeq: string | bigint
): void {
  if (!state.sessionId) return;
  bridge.postRaw({
    type: RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE,
    sessionId: state.sessionId,
    eventKind,
    observedAt: new Date().toISOString(),
    conversationId: message.conversationId,
    turnId: message.turnId,
    modelRequestId: message.modelRequestId,
    attemptSeq: message.attemptSeq,
    socketGeneration: message.socketGeneration,
    streamSeq: String(streamSeq)
  });
}

function reportTransientSnapshotDiagnostic(
  state: ReliableKernelFeedStoreState,
  message: ReliableKernelTransientSnapshotMessage,
  eventKind: 'transient-snapshot-replayed' | 'transient-snapshot-rejected'
): void {
  if (!state.sessionId) return;
  bridge.postRaw({
    type: RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE,
    sessionId: state.sessionId,
    eventKind,
    observedAt: new Date().toISOString(),
    conversationId: message.conversationId,
    turnId: message.turnId,
    modelRequestId: message.modelRequestId,
    attemptSeq: message.attemptSeq,
    socketGeneration: message.socketGeneration,
    streamSeq: message.headStreamSeq
  });
}

function afterNextPaint(callback: () => void): void {
  window.requestAnimationFrame(() => window.requestAnimationFrame(callback));
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function modelOutputItemValue(value: unknown): ModelOutputItemReference | undefined {
  const record = plainRecord(value);
  const id = nonEmptyString(record?.id);
  const ordinal = nonNegativeNumber(record?.ordinal);
  if (!id || ordinal === undefined) return undefined;
  const phase = record?.phase === 'commentary' || record?.phase === 'final_answer'
    ? record.phase
    : undefined;
  return { id, ordinal, ...(phase ? { phase } : {}) };
}

function messageContentValue(value: unknown): MessageContent | undefined {
  const record = plainRecord(value);
  if (!record || record.role !== 'model' || !Array.isArray(record.parts)) return undefined;
  return {
    role: 'model',
    parts: structuredClone(record.parts) as MessageContent['parts']
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function decimal(value: unknown): string | undefined {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? value : undefined;
}

function optionalDecimal(value: unknown): string | undefined {
  return value === undefined ? undefined : decimal(value);
}

function positiveDecimal(value: unknown): string | undefined {
  const normalized = decimal(value);
  return normalized && normalized !== '0' ? normalized : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function clearCollaborationHistoryTimeout(requestId: string | null): void {
  if (!requestId) return;
  const timer = collaborationHistoryTimeouts.get(requestId);
  if (timer !== undefined) clearTimeout(timer);
  collaborationHistoryTimeouts.delete(requestId);
}

function resetCollaborationHistoryState(
  state: ReliableKernelFeedStoreState,
  conversationId: string | null
): void {
  clearCollaborationHistoryTimeout(state.collaborationHistoryRequestId);
  state.collaborationHistoryConversationId = conversationId;
  state.collaborationHistoryRecords = {};
  state.collaborationHistoryNextBeforeMessageSeq = null;
  state.collaborationHistoryNextBeforeId = null;
  state.collaborationHistoryHasMore = Boolean(conversationId);
  state.collaborationHistoryScanProgress = false;
  state.collaborationHistoryLoading = false;
  state.collaborationHistoryError = null;
  state.collaborationHistoryRequestId = null;
  state.collaborationHistoryLoadedPages = 0;
}

/** Reject a backward page that would loop or splice in foreign/mismatched independent facts. */
function isCollaborationHistoryPage(
  page: ReliableKernelCollaborationHistoryResultMessage['page'],
  beforeMessageSeq: string | null,
  beforeId: string | null
): boolean {
  const rows = page.records.CollaborationMessage ?? [];
  if (!Array.isArray(rows) || rows.length > HISTORY_PAGE_LIMIT || typeof page.hasMore !== 'boolean'
    || typeof page.scanProgress !== 'boolean'
    || !Number.isSafeInteger(page.scannedRows) || page.scannedRows < 0 || page.scannedRows > 4096
    || !Number.isSafeInteger(page.responseBytes) || page.responseBytes > 524_288
    || (page.scanProgress && !page.hasMore)
    || (page.hasMore && !page.nextBeforeMessageSeq)
    || (page.nextBeforeMessageSeq === undefined) !== (page.nextBeforeId === undefined)
    || (rows.length > 0 && (page.nextBeforeMessageSeq === undefined || page.nextBeforeId === undefined))) return false;
  const cursorSeq = page.nextBeforeMessageSeq === undefined ? undefined : positiveDecimal(page.nextBeforeMessageSeq);
  const cursorId = page.nextBeforeId;
  if (page.nextBeforeMessageSeq !== undefined && (!cursorSeq || !nonEmptyString(cursorId))) return false;
  if (cursorSeq && beforeMessageSeq && (BigInt(cursorSeq) >= BigInt(beforeMessageSeq)
    || cursorSeq === beforeMessageSeq && cursorId === beforeId)) return false;
  let previous: { seq: bigint; id: string } | undefined;
  for (const row of rows) {
    if (!isRecord(row) || !nonEmptyString(row.id)) return false;
    const seq = positiveDecimal(row.message_seq);
    if (!seq) return false;
    const current = { seq: BigInt(seq), id: row.id as string };
    if (previous && (current.seq < previous.seq || current.seq === previous.seq && current.id <= previous.id)) return false;
    if (beforeMessageSeq && beforeId && (current.seq > BigInt(beforeMessageSeq)
      || current.seq === BigInt(beforeMessageSeq) && current.id >= beforeId)) return false;
    previous = current;
  }
  const oldest = rows[0];
  if (page.scanProgress) {
    return Boolean(cursorSeq && cursorId && page.scannedRows > 0
      && (rows.length === 0 || BigInt(cursorSeq) <= BigInt(String(oldest?.message_seq))));
  }
  return rows.length === 0
    ? !page.hasMore && page.nextBeforeMessageSeq === undefined
    : page.nextBeforeMessageSeq === oldest?.message_seq && page.nextBeforeId === oldest.id;
}

function resetHistoryState(
  state: ReliableKernelFeedStoreState,
  conversationId: string | null
): void {
  state.historyConversationId = conversationId;
  state.historyRecords = {};
  state.historyNextBeforeMessageSeq = null;
  state.historyNextBeforeId = null;
  state.historyHasMore = false;
  state.historyLoading = false;
  state.historyError = null;
  state.historyRequestId = null;
  state.historyLoadedPages = 0;
  if (conversationId) seedHistoryCursorFromLiveRecords(state, conversationId);
}

function seedHistoryCursorFromLiveRecords(
  state: ReliableKernelFeedStoreState,
  conversationId: string
): void {
  const suffixFloor = visibleMessageSuffixFloor(state.records.Message ?? {}, conversationId);
  const oldest = Object.values(state.records.Message ?? {})
    .filter((message) => isVisibleConversationMessage(message, conversationId))
    .flatMap((message) => {
      const id = nonEmptyString(message.id);
      const messageSeq = integerString(message.message_seq);
      const displaySeq = integerString(message.display_seq);
      return id && messageSeq && displaySeq && BigInt(displaySeq) === suffixFloor
        ? [{ id, messageSeq }]
        : [];
    })
    .sort((left, right) => compareIntegerStrings(left.messageSeq, right.messageSeq)
      || left.id.localeCompare(right.id))[0];
  const hasMore = Boolean(oldest && suffixFloor && suffixFloor > 1n);
  state.historyHasMore = hasMore;
  state.historyNextBeforeMessageSeq = hasMore ? oldest!.messageSeq : null;
  state.historyNextBeforeId = hasMore ? oldest!.id : null;
}

function visibleMessageCount(projections: Record<string, unknown>): bigint {
  const count = integerString(plainRecord(projections.activeConversationWindow)?.visibleMessageCount);
  return count ? BigInt(count) : 0n;
}

function maximumVisibleMessageFloor(
  history: ReliableKernelBoundedClientState['records'],
  live: ReliableKernelBoundedClientState['records'],
  conversationId: string
): bigint {
  let maximum = 0n;
  for (const bucket of [history.Message ?? {}, live.Message ?? {}]) {
    for (const message of Object.values(bucket)) {
      if (!isVisibleConversationMessage(message, conversationId)) continue;
      const displaySeq = integerString(message.display_seq);
      if (displaySeq && BigInt(displaySeq) > maximum) maximum = BigInt(displaySeq);
    }
  }
  return maximum;
}

/**
 * Once history has been requested, a bounded live window must hand records that roll out of its
 * front to the memory-only prefix. Its full causal bundle is copied at that boundary even when a
 * dependency remains live for a later Message; subsequent live changes keep overlapping ids fresh.
 */
function retainRolledOffLiveRecords(
  history: ReliableKernelBoundedClientState['records'],
  previousLive: ReliableKernelBoundedClientState['records'],
  nextLive: ReliableKernelBoundedClientState['records'],
  rolledMessageIds: ReadonlySet<string>
): ReliableKernelBoundedClientState['records'] {
  const causalRecordIds = rolledMessageCausalRecordIds(previousLive, rolledMessageIds);

  let changed = false;
  const retained = { ...history };
  for (const [type, previousBucket] of Object.entries(previousLive)) {
    let retainedBucket = retained[type];
    for (const [id, record] of Object.entries(previousBucket)) {
      if (!causalRecordIds[type]?.has(id)) continue;
      if (!changed || retainedBucket === history[type]) retainedBucket = { ...(retainedBucket ?? {}) };
      retainedBucket[id] = nextLive[type]?.[id] ?? record;
      changed = true;
    }
    if (retainedBucket && retainedBucket !== retained[type]) retained[type] = retainedBucket;
  }
  return changed ? retained : history;
}

function rolledOffVisibleMessageIds(
  previousLive: ReliableKernelBoundedClientState['records'],
  nextLive: ReliableKernelBoundedClientState['records'],
  conversationId: string
): Set<string> {
  const nextMessages = nextLive.Message ?? {};
  const nextSuffixFloor = visibleMessageSuffixFloor(nextMessages, conversationId);
  if (nextSuffixFloor === undefined) return new Set();
  return new Set(Object.values(previousLive.Message ?? {})
    .filter((message) => isVisibleConversationMessage(message, conversationId))
    .flatMap((message) => {
      const id = nonEmptyString(message.id);
      const displaySeq = integerString(message.display_seq);
      return id && displaySeq && BigInt(displaySeq) < nextSuffixFloor && !nextMessages[id]
        ? [id]
        : [];
    }));
}

/** Mirrors the backend history-page closure without traversing sideways through a shared Turn. */
function rolledMessageCausalRecordIds(
  records: ReliableKernelBoundedClientState['records'],
  messageIds: ReadonlySet<string>
): Record<string, Set<string>> {
  const kept: Record<string, Set<string>> = {};
  const rows = (type: string): Array<Record<string, unknown>> => Object.values(records[type] ?? {});
  const value = (row: Record<string, unknown>, field: string): string | undefined =>
    nonEmptyString(row[field]);
  const byId = (type: string, ids: ReadonlySet<string>): Array<Record<string, unknown>> =>
    rows(type).filter((row) => {
      const id = value(row, 'id');
      return Boolean(id && ids.has(id));
    });
  const byField = (
    type: string,
    field: string,
    ids: ReadonlySet<string>
  ): Array<Record<string, unknown>> => rows(type).filter((row) => {
    const id = value(row, field);
    return Boolean(id && ids.has(id));
  });
  const idsFrom = (selected: readonly Record<string, unknown>[], field: string): Set<string> =>
    new Set(selected.flatMap((row) => {
      const id = value(row, field);
      return id ? [id] : [];
    }));
  const union = (...sets: ReadonlySet<string>[]): Set<string> =>
    new Set(sets.flatMap((set) => [...set]));
  const include = (type: string, selected: readonly Record<string, unknown>[]): void => {
    for (const id of idsFrom(selected, 'id')) (kept[type] ??= new Set()).add(id);
  };

  include('Message', byId('Message', messageIds));
  const messageTurnLinks = byField('MessageTurnLink', 'message_id', messageIds);
  const requestMessageLinks = byField('ModelRequestMessageLink', 'message_id', messageIds);
  const sourceLinks = byField('ToolCallSourceLink', 'message_id', messageIds);
  include('MessageTurnLink', messageTurnLinks);
  include('ModelRequestMessageLink', requestMessageLinks);
  include('ToolCallSourceLink', sourceLinks);

  const requestIds = union(
    idsFrom(requestMessageLinks, 'model_request_id'),
    idsFrom(sourceLinks, 'model_request_id')
  );
  const modelRequests = byId('ModelRequest', requestIds);
  include('ModelRequest', modelRequests);

  const toolCallIds = idsFrom(sourceLinks, 'tool_call_id');
  const toolCalls = byId('ToolCall', toolCallIds);
  include('ToolCall', toolCalls);
  for (const type of [
    'ToolCallPolicySnapshot',
    'ToolCallEvent',
    'ToolExecution',
    'ToolOutcome',
    'ToolModelResult',
    'ToolResultArtifact'
  ]) {
    include(type, byField(type, 'tool_call_id', toolCallIds));
  }

  const interactionToolLinks = byField('InteractionToolCallLink', 'tool_call_id', toolCallIds);
  const interactionRequestIds = idsFrom(interactionToolLinks, 'request_id');
  const interactionRequests = byId('InteractionRequest', interactionRequestIds);
  const interactionOwnerLinks = byField('InteractionOwnerLink', 'request_id', interactionRequestIds);
  include('InteractionToolCallLink', interactionToolLinks);
  include('InteractionRequest', interactionRequests);
  include('InteractionOwnerLink', interactionOwnerLinks);
  include('InteractionResponse', byField('InteractionResponse', 'request_id', interactionRequestIds));

  const fileChangeSets = byField('FileChangeSet', 'tool_call_id', toolCallIds);
  const fileChangeSetIds = idsFrom(fileChangeSets, 'id');
  const mutationReceipts = byField('FileMutationReceipt', 'change_set_id', fileChangeSetIds);
  include('FileChangeSet', fileChangeSets);
  include('FileChangeSetMember', byField('FileChangeSetMember', 'change_set_id', fileChangeSetIds));
  include('FileChangeDecision', byField('FileChangeDecision', 'change_set_id', fileChangeSetIds));
  include('FileMutationReceipt', mutationReceipts);
  include('FileMutationReceiptMember', byField(
    'FileMutationReceiptMember',
    'receipt_id',
    idsFrom(mutationReceipts, 'id')
  ));

  const processOriginLinks = byField('ProcessOriginLink', 'tool_call_id', toolCallIds);
  const processIds = idsFrom(processOriginLinks, 'process_id');
  include('ProcessOriginLink', processOriginLinks);
  include('Process', byId('Process', processIds));
  include('ProcessReceipt', byField('ProcessReceipt', 'process_id', processIds));

  const childParentLinks = byField('ChildExecutionParentLink', 'source_tool_call_id', toolCallIds);
  const childExecutionIds = idsFrom(childParentLinks, 'child_execution_id');
  const childExecutions = byId('ChildExecution', childExecutionIds);
  const childActiveLinks = byField('ChildExecutionActiveTurnLink', 'child_execution_id', childExecutionIds);
  const childTurnLinks = byField('ChildExecutionTurnLink', 'child_execution_id', childExecutionIds);
  const childTurnIds = union(
    idsFrom(childActiveLinks, 'turn_id'),
    idsFrom(childTurnLinks, 'turn_id')
  );
  include('ChildExecutionParentLink', childParentLinks);
  include('ChildExecution', childExecutions);
  include('ChildExecutionActiveTurnLink', childActiveLinks);
  include('ChildExecutionTurnLink', childTurnLinks);
  include('AgentConversationLink', byField(
    'AgentConversationLink',
    'conversation_id',
    idsFrom(childExecutions, 'child_conversation_id')
  ));

  const answerBridges = byField('AnswerBridge', 'child_execution_id', childExecutionIds);
  include('AnswerBridge', answerBridges);
  include('AnswerSubmission', byId(
    'AnswerSubmission',
    idsFrom(answerBridges, 'current_submission_id')
  ));

  const turnIds = union(
    idsFrom(messageTurnLinks, 'turn_id'),
    idsFrom(modelRequests, 'turn_id'),
    idsFrom(toolCalls, 'turn_id'),
    idsFrom(interactionOwnerLinks, 'turn_id'),
    idsFrom(childParentLinks, 'parent_turn_id'),
    childTurnIds
  );
  include('Turn', byId('Turn', turnIds));
  include('ExecutionLease', byField('ExecutionLease', 'turn_id', turnIds));
  include('TurnTermination', byField('TurnTermination', 'turn_id', turnIds));
  include('TurnExecutorLink', byField('TurnExecutorLink', 'turn_id', turnIds));
  return kept;
}

/** Keeps mutable historical summaries aligned with any later live upsert/remove for the same id. */
function reconcileHistoryRecordsWithLiveChanges(
  history: ReliableKernelBoundedClientState['records'],
  envelope: Record<string, unknown> | undefined,
  previousLive: ReliableKernelBoundedClientState['records'],
  nextLive: ReliableKernelBoundedClientState['records']
): ReliableKernelBoundedClientState['records'] {
  const changes = Array.isArray(envelope?.changes) ? envelope.changes : [];
  const finalEvictedRecords = new Map<
    string,
    ReliableKernelBoundedClientState['records'][string][string]
  >();
  const windowEvictionKeys = new Set(changes.flatMap((value) => {
    const change = plainRecord(value);
    const type = nonEmptyString(change?.type);
    const id = nonEmptyString(change?.id);
    return type && id && change?.operation === 'remove' && change.removalCause === 'window-eviction'
      ? [`${type}\0${id}`]
      : [];
  }));
  for (const value of changes) {
    const change = plainRecord(value);
    const type = nonEmptyString(change?.type);
    const id = nonEmptyString(change?.id);
    const record = plainRecord(change?.record);
    if (type && id && record && change?.operation === 'upsert' && windowEvictionKeys.has(`${type}\0${id}`)) {
      finalEvictedRecords.set(
        `${type}\0${id}`,
        record as ReliableKernelBoundedClientState['records'][string][string]
      );
    }
  }
  let next = history;
  const copiedTypes = new Set<string>();
  for (const value of changes) {
    const change = plainRecord(value);
    const type = nonEmptyString(change?.type);
    const id = nonEmptyString(change?.id);
    if (!type || !id) continue;
    const windowEviction = change?.operation === 'remove'
      && change.removalCause === 'window-eviction';
    const previousRecord = previousLive[type]?.[id];
    const finalEvictedRecord = finalEvictedRecords.get(`${type}\0${id}`) ?? previousRecord;
    if (windowEviction && !finalEvictedRecord) continue;
    if (!windowEviction && !history[type]?.[id] && !next[type]?.[id]) continue;
    if (next === history) next = { ...history };
    if (!copiedTypes.has(type)) {
      next[type] = { ...(history[type] ?? {}) };
      copiedTypes.add(type);
    }
    if (windowEviction) {
      next[type][id] = finalEvictedRecord!;
      continue;
    }
    const liveRecord = nextLive[type]?.[id];
    if (change?.operation === 'remove' || !liveRecord) {
      delete next[type][id];
    } else {
      next[type][id] = liveRecord;
    }
  }
  return next;
}

function invalidateRetryableDetailsForDurableMessage(
  state: ReliableKernelFeedStoreState,
  envelope: Record<string, unknown> | undefined,
  messageType: string | undefined
): void {
  const invalidatedKeys = new Set<string>();
  if (messageType === RELIABLE_KERNEL_SNAPSHOT_MESSAGE) {
    for (const key of Object.keys(state.details)) invalidatedKeys.add(key);
  } else if (messageType === RELIABLE_KERNEL_CHANGES_MESSAGE) {
    const changes = Array.isArray(envelope?.changes) ? envelope.changes : [];
    for (const value of changes) {
      const change = plainRecord(value);
      if (change?.operation !== 'upsert') continue;
      const type = nonEmptyString(change.type);
      const id = nonEmptyString(change.id);
      const record = plainRecord(change.record);
      if (!type || !id) continue;
      const add = (kind: ReliableKernelClientDetailKind, recordId: unknown = id): void => {
        const normalizedId = nonEmptyString(recordId);
        if (normalizedId) invalidatedKeys.add(detailKey(kind, normalizedId));
      };
      switch (type) {
        case 'MessageRevision':
          add('message-content');
          break;
        case 'TurnIntent':
          add('turn-intent-preview');
          break;
        case 'RuntimeDeliveryIntentLink':
          add('turn-intent-preview', record?.turn_intent_id);
          break;
        case 'RuntimeDelivery':
          for (const link of Object.values(state.records.RuntimeDeliveryIntentLink ?? {})) {
            if (link.delivery_id === id) add('turn-intent-preview', link.turn_intent_id);
          }
          break;
        case 'ToolCall':
          add('tool-arguments-content');
          break;
        case 'ToolOutcome':
          add('tool-result-content', record?.tool_call_id ?? id);
          break;
        case 'ToolCallEvent':
          add('tool-event-content');
          break;
        case 'InteractionRequest':
          add('interaction-prompt');
          break;
        case 'FileChangeSetMember':
          add('file-change-base-content');
          add('file-change-content');
          add('file-change-diff');
          break;
        case 'Process':
          add('process-stdout');
          add('process-stderr');
          break;
        case 'ProcessOutputChunk':
          add('process-output');
          add('process-stdout', record?.process_id);
          add('process-stderr', record?.process_id);
          break;
        case 'ModelContextProjection':
          add('context-projection-detail');
          break;
        case 'ModelRequest':
          add('model-request-purpose');
          break;
        case 'CompressionBlock':
          add('compression-presentation');
          add('compression-content');
          add('compression-title');
          break;
        case 'AnswerSubmission':
          add('answer-content');
          break;
      }
    }
  }
  for (const key of invalidatedKeys) {
    const detail = state.details[key];
    if (!detail || detail.terminalError) continue;
    if (detail.status === 'error') {
      clearDetailRetryTimer(key);
      delete state.details[key];
      delete state.detailCacheMeta[key];
      continue;
    }
    if (detail.status === 'ready' && detail.refreshError) {
      clearDetailRetryTimer(key);
      state.details[key] = {
        status: 'ready',
        text: detail.text,
        totalBytes: detail.totalBytes
      };
    }
  }
}

function removedModelRequestIds(
  envelope: Record<string, unknown> | undefined
): Set<string> {
  const removed = new Set<string>();
  const changes = Array.isArray(envelope?.changes) ? envelope.changes : [];
  for (const value of changes) {
    const change = plainRecord(value);
    if (change?.type !== 'ModelRequest' || change.operation !== 'remove') continue;
    const id = nonEmptyString(change.id);
    if (id) removed.add(id);
  }
  return removed;
}

function removeTransientModelRequests(
  current: Record<string, ReliableKernelTransientState>,
  removedIds: ReadonlySet<string>
): Record<string, ReliableKernelTransientState> {
  if (![...removedIds].some((id) => current[id])) return current;
  const next = { ...current };
  for (const id of removedIds) delete next[id];
  return next;
}

/** Finds the first row in the newest contiguous display-rank suffix, ignoring pinned old anchors. */
function visibleMessageSuffixFloor(
  messages: Record<string, Record<string, unknown>>,
  conversationId: string
): bigint | undefined {
  const ranks = Object.values(messages)
    .filter((message) => isVisibleConversationMessage(message, conversationId))
    .flatMap((message) => {
      const displaySeq = integerString(message.display_seq);
      return displaySeq && displaySeq !== '0' ? [BigInt(displaySeq)] : [];
    })
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  let floor = ranks[ranks.length - 1];
  if (floor === undefined) return undefined;
  for (let index = ranks.length - 2; index >= 0; index -= 1) {
    if (ranks[index] !== floor - 1n) break;
    floor = ranks[index];
  }
  return floor;
}

function isVisibleConversationMessage(
  message: Record<string, unknown>,
  conversationId: string
): boolean {
  return message.conversation_id === conversationId
    && (message.deleted_at === null || message.deleted_at === undefined)
    && (message.role === 'user' || message.role === 'model');
}

const COLLABORATION_HISTORY_RECORD_TYPES = new Set([
  'CollaborationMessage', 'CollaborationMessageSourceLink', 'CollaborationMessageTargetLink',
  'RuntimeDelivery', 'Turn', 'CollaborationPeerConversation'
]);

function mergeHistoryRecordPage(
  current: ReliableKernelBoundedClientState['records'],
  page: ReliableKernelHistoryPageResultMessage['page']['records'],
  allowedTypes?: ReadonlySet<string>
): ReliableKernelBoundedClientState['records'] {
  const next = { ...current };
  for (const [type, rows] of Object.entries(page)) {
    if (allowedTypes ? !allowedTypes.has(type) : !RELIABLE_KERNEL_CLIENT_CHANGE_TYPES.has(type as never)) {
      throw new TypeError(`更早消息页面包含未知记录类型：${type}`);
    }
    if (!Array.isArray(rows)) throw new TypeError(`更早消息页面的 ${type} 记录无效。`);
    const bucket = { ...(next[type] ?? {}) };
    for (const row of rows) {
      if (!isRecord(row) || !nonEmptyString(row.id)) {
        throw new TypeError(`更早消息页面的 ${type} 记录缺少稳定 id。`);
      }
      bucket[row.id as string] = row;
    }
    next[type] = bucket;
  }
  return next;
}

function integerString(value: unknown): string | undefined {
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'bigint' && value >= 0n) return value.toString();
  return undefined;
}

function compareIntegerStrings(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function clearDetailRetryTimer(key: string): void {
  const timeout = detailRetryTimeouts.get(key);
  if (timeout !== undefined) clearTimeout(timeout);
  detailRetryTimeouts.delete(key);
}

function clearAllDetailRetryTimers(): void {
  for (const timeout of detailRetryTimeouts.values()) clearTimeout(timeout);
  detailRetryTimeouts.clear();
}

function cancelAllDetailRequests(state: ReliableKernelFeedStoreState): void {
  clearAllDetailRetryTimers();
  for (const requestId of Object.keys(state.pendingDetails)) {
    const timeout = detailRequestTimeouts.get(requestId);
    if (timeout !== undefined) clearTimeout(timeout);
    detailRequestTimeouts.delete(requestId);
    detailDecoders.delete(requestId);
    detailTextChunks.delete(requestId);
  }
  for (const pending of Object.values(state.pendingDetails)) {
    const detail = state.details[pending.key];
    if (detail?.status === 'loading') {
      delete state.details[pending.key];
    } else if (pending.mode === 'refresh' && detail?.status === 'ready') {
      state.details[pending.key] = {
        status: 'ready',
        text: detail.text,
        totalBytes: detail.totalBytes
      };
    }
  }
  for (const [key, detail] of Object.entries(state.details)) {
    if (detail.status === 'error') delete state.details[key];
  }
  state.pendingDetails = {};
  state.detailQueue = [];
  state.activeDetailRequestIds = [];
}

function pruneDetailCache(state: ReliableKernelFeedStoreState): void {
  const ready = Object.entries(state.detailCacheMeta)
    .filter(([key]) => state.details[key]?.status === 'ready');
  const pinned = new Set(state.pinnedDetailKeys);
  // Mounted timeline bodies are explicitly owned by the current view and do not consume the
  // ordinary LRU budget. Otherwise one large visible transcript segment would evict every tool or
  // process detail as soon as it finishes loading.
  const candidates = ready
    .filter(([key]) => !pinned.has(key))
    .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt || left[0].localeCompare(right[0]));
  let totalBytes = candidates.reduce((total, [, meta]) => total + meta.bytes, 0);
  let totalEntries = candidates.length;
  for (const [key, meta] of candidates) {
    if (totalEntries <= DETAIL_CACHE_MAX_ENTRIES && totalBytes <= DETAIL_CACHE_MAX_BYTES) break;
    // Keep the newest/only oversized detail while it is being viewed; deleting it here changes its
    // demand signature and immediately requests the same multi-page payload again.
    if (totalEntries <= 1) break;
    delete state.details[key];
    delete state.detailCacheMeta[key];
    totalEntries -= 1;
    totalBytes -= meta.bytes;
  }
}

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function openTransientThought(
  state: ReliableKernelTransientState,
  content: Record<string, unknown>,
  observedAt: number
): void {
  const incomingElapsedMs = nonNegativeNumber(content.thoughtElapsedMs);
  const incomingStartedAt = positiveNumber(content.thoughtStartedAt);
  const blockChanged = state.thoughtActive !== true
    || (incomingStartedAt !== undefined && incomingStartedAt !== state.thoughtStartedAt);
  const completedDurationMs = nonNegativeNumber(content.thoughtCompletedDurationMs)
    ?? state.thoughtCompletedDurationMs
    ?? state.thoughtDurationMs
    ?? 0;

  state.thoughtActive = true;
  state.thoughtCompletedDurationMs = completedDurationMs;
  state.thoughtStartedAt = incomingStartedAt
    ?? (blockChanged
      ? Math.max(1, observedAt - (incomingElapsedMs ?? 0))
      : state.thoughtStartedAt);
  if (incomingElapsedMs !== undefined) state.thoughtElapsedMs = incomingElapsedMs;
  else if (blockChanged) delete state.thoughtElapsedMs;
  // thoughtDurationMs is a terminal cumulative fact. A new block explicitly reopens thinking.
  delete state.thoughtDurationMs;
}

function currentTransientThoughtDurationMs(
  state: ReliableKernelTransientState,
  observedAt: number
): number {
  const authoritativeElapsedMs = state.thoughtElapsedMs ?? 0;
  if (state.thoughtStartedAt === undefined || !Number.isFinite(observedAt)) return authoritativeElapsedMs;
  return Math.max(
    authoritativeElapsedMs,
    Math.max(0, Math.round(observedAt - state.thoughtStartedAt))
  );
}

function detailKey(kind: ReliableKernelClientDetailKind, recordId: string): string {
  return `${kind}:${recordId}`;
}

function decodeBase64Bytes(chunk: string): Uint8Array {
  const binary = window.atob(chunk);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function detailDecoder(requestId: string): TextDecoder {
  const existing = detailDecoders.get(requestId);
  if (existing) return existing;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  detailDecoders.set(requestId, decoder);
  return decoder;
}

function activeConversationId(projections: Record<string, unknown>): string | undefined {
  return stringValue(plainRecord(projections.activeConversationWindow)?.conversationId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function debugContext(message: { conversationId: string; modelRequestId: string; attemptSeq: string; socketGeneration: string }) {
  return { conversationId: message.conversationId, modelRequestId: message.modelRequestId, attemptSeq: message.attemptSeq, socketGeneration: message.socketGeneration };
}
function debugFrameMetadata(message: ReliableKernelTransientMessage) {
  return { sessionId: message.sessionId, streamSeq: message.event.streamSeq, fromStreamSeq: message.fromStreamSeq ?? message.event.streamSeq,
    navigationGeneration: message.navigationGeneration ?? '', kind: message.event.kind };
}
