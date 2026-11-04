import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import {
  MESSAGE_CONTENT_ITEM_PAGE_SIZE, parseReliableMessageContentItemPage, residentReliableMessageContentItems,
  reliableMessageContentItemsKey, type ReliableMessageContentWindow
} from '@webview/domain/reliableMessageContentWindow';
import { reliableOutputItemIdentity } from '@webview/domain/reliableOutputItemIdentity';
import { parseReliableMessageContent } from '@webview/domain/reliableConversationProjection';
import {
  admitReliableHistoryRecords, applyReliableCommittedChanges, compareReliableMessageCursors,
  reliableCollaborationPageForCard, reliableHistoryPageForMessage, releaseReliablePageMembers, replaceReliableCommittedLive,
  retainReliableCollaborationPages, retainReliableReadingPages,
  type ReliableResidentHistoryPage, type ReliableResidentCollaborationPage, type ReleasedReliableRecord
} from '@webview/domain/reliableHistoryResidency';
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
  type ReliableKernelCollaborationHistoryCursor,
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
  type ContentPart,
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
  updateReliableTransientThoughtPart,
  replaceReliableTransientCommittedPart
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
  peerState?: 'known' | 'deleted' | 'unknown';
  peerStateGeneration?: number;
}

interface PendingDetailRequest {
  itemAfterSequence?: number;
  itemLimit?: number;
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
  /** A newer mutable-prefix demand arrived while this exact request was in flight. */
  refreshRequested?: boolean;
  peerState?: 'known' | 'deleted' | 'unknown';
  peerStateGeneration?: number;
}

export type ReliableKernelDetailPriority = 'critical' | 'expanded' | 'visible' | 'background';

interface ReliableKernelDetailRequestOptions {
  itemAfterSequence?: number;
  itemLimit?: number;
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
  detailOwnerKeys: Record<string, string[]>;
  releasedDetailKeys: Record<string, true>;
  messageContentWindows: Record<string, ReliableMessageContentWindow>;
  messageContentItemOwners: Record<string, string>;
  retiredSessionIds: string[];
  navigationGeneration: string | null;
  /** Causal visibility frontier of the current full snapshot, never advanced by a delta. */
  lastSnapshotCommitSeq: string | null;
  /** Local snapshot fence for mutable peer existence on immutable accepted-answer facts. */
  peerStateGeneration: number;
  acceptedAnswerPeerGenerations: Record<string, number>;
  transientModelRequests: Record<string, ReliableKernelTransientState>;
  pendingTransientRecoveries: Record<string, PendingTransientRecovery>;
  /** The sole committed fact store; live windows and pages own only memberships. */
  committedRecords: ReliableKernelBoundedClientState['records'];
  historyConversationId: string | null;
  historyPages: ReliableResidentHistoryPage[];
  historyCurrentPageId: string | null;
  historyRequestDirection: 'before' | 'after';
  historyNextAfterMessageSeq: string | null;
  historyNextAfterId: string | null;
  historyHasMoreAfter: boolean;
  historyNextBeforeMessageSeq: string | null;
  historyNextBeforeId: string | null;
  historyHasMore: boolean;
  historyLoading: boolean;
  historyError: string | null;
  historyRequestId: string | null;
  historyLoadedPages: number;
  /** Independent exchange history, followed by envelopes without proven placement. */
  collaborationHistoryConversationId: string | null;
  collaborationHistoryPages: ReliableResidentCollaborationPage[];
  collaborationHistoryCurrentPageId: string | null;
  collaborationHistoryNextBeforeCursor: ReliableKernelCollaborationHistoryCursor | null;
  collaborationHistoryNextAfterCursor: ReliableKernelCollaborationHistoryCursor | null;
  collaborationHistoryHasMoreBefore: boolean;
  collaborationHistoryHasMoreAfter: boolean;
  collaborationHistoryScanProgress: boolean;
  collaborationHistoryLoading: boolean;
  collaborationHistoryError: string | null;
  collaborationHistoryRequestId: string | null;
  collaborationHistoryRequestDirection: 'before' | 'after';
  collaborationHistoryRequestCursor: ReliableKernelCollaborationHistoryCursor | null;
  collaborationHistoryRequestPageId: string | null;
  collaborationHistoryRequestPeerGeneration: number | null;
  collaborationHistoryRequestIsBootstrap: boolean;
  collaborationHistoryLoadedPages: number;
  collaborationHistoryScannedRows: number;
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
const HISTORY_REQUEST_DEADLINE_MS = 20_000;
const historyRequestTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
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

const useReliableKernelClientFeedStoreDefinition = defineStore('reliableKernelClientFeed', {
  state: (): ReliableKernelFeedStoreState => ({
    ...createEmptyReliableKernelClientState(),
    details: {},
    pendingDetails: {},
    detailQueue: [],
    activeDetailRequestIds: [],
    detailCacheMeta: {},
    pinnedDetailKeys: [],
    detailOwnerKeys: {},
    releasedDetailKeys: {},
    messageContentWindows: {},
    messageContentItemOwners: {},
    retiredSessionIds: [],
    navigationGeneration: null,
    lastSnapshotCommitSeq: null,
    peerStateGeneration: 0,
    acceptedAnswerPeerGenerations: {},
    transientModelRequests: {},
    pendingTransientRecoveries: {},
    committedRecords: markRaw({}),
    historyConversationId: null,
    historyPages: [],
    historyCurrentPageId: null,
    historyRequestDirection: 'before',
    historyNextAfterMessageSeq: null,
    historyNextAfterId: null,
    historyHasMoreAfter: false,
    historyNextBeforeMessageSeq: null,
    historyNextBeforeId: null,
    historyHasMore: false,
    historyLoading: false,
    historyError: null,
    historyRequestId: null,
    historyLoadedPages: 0,
    collaborationHistoryConversationId: null,
    collaborationHistoryPages: [],
    collaborationHistoryCurrentPageId: null,
    collaborationHistoryNextBeforeCursor: null,
    collaborationHistoryNextAfterCursor: null,
    collaborationHistoryHasMoreBefore: false,
    collaborationHistoryHasMoreAfter: false,
    collaborationHistoryScanProgress: false,
    collaborationHistoryLoading: false,
    collaborationHistoryError: null,
    collaborationHistoryRequestId: null,
    collaborationHistoryRequestDirection: 'before',
    collaborationHistoryRequestCursor: null,
    collaborationHistoryRequestPageId: null,
    collaborationHistoryRequestPeerGeneration: null,
    collaborationHistoryRequestIsBootstrap: false,
    collaborationHistoryLoadedPages: 0,
    collaborationHistoryScannedRows: 0,
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
      const continuingLoadedHistory = Boolean(
        result.ack
        && previousConversationId
        && previousConversationId === nextConversationId
        && this.historyConversationId === previousConversationId
        && (this.historyLoadedPages > 0 || this.historyLoading)
      );
      // Only an accepted snapshot continuing loaded history can invalidate or skip its floors.
      // Ordinary durable changes must not scan the unbounded historical prefix before ACK.
      const checkingHistorySnapshot = continuingLoadedHistory
        && incomingType === RELIABLE_KERNEL_SNAPSHOT_MESSAGE;
      const previousLoadedFloorCeiling = checkingHistorySnapshot
        ? maximumVisibleMessageFloor(this.committedRecords, {}, previousConversationId!)
        : 0n;
      const historyInvalidated = checkingHistorySnapshot
        && visibleMessageCount(result.state.projections) < previousLoadedFloorCeiling;
      let replayDetails: Array<{
        kind: ReliableKernelClientDetailKind;
        recordId: string;
        priority: ReliableKernelDetailPriority;
        mode: 'initial' | 'refresh';
        itemAfterSequence?: number;
        itemLimit?: number;
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
            mode: pending.mode,
            itemAfterSequence: pending.itemAfterSequence, itemLimit: pending.itemLimit
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
      if (result.ack && incomingType === RELIABLE_KERNEL_SNAPSHOT_MESSAGE) {
        this.lastSnapshotCommitSeq = result.state.lastCommitSeq;
      }
      this.projections = result.state.projections;
      this.records = result.state.records;
      this.snapshotRequired = result.state.snapshotRequired;
      if (result.ack) {
        if (previousConversationId !== nextConversationId || previousSessionId !== this.sessionId) {
          this.acceptedAnswerPeerGenerations = {};
        }
        if (incomingType === RELIABLE_KERNEL_SNAPSHOT_MESSAGE) {
          this.peerStateGeneration += 1;
          // Only the bounded live snapshot is fresh. Historical records keep their old stamp;
          // their selector will render unknown liveness without rewriting or dropping the facts.
          for (const id of Object.keys(this.records.RuntimeDeliveryAnswerPresentation ?? {})) {
            this.acceptedAnswerPeerGenerations[id] = this.peerStateGeneration;
          }
        } else if (incomingType === RELIABLE_KERNEL_CHANGES_MESSAGE) {
          for (const value of Array.isArray(envelope?.changes) ? envelope.changes : []) {
            const change = plainRecord(value);
            const id = nonEmptyString(change?.id);
            if (change?.type !== 'RuntimeDeliveryAnswerPresentation' || !id) continue;
            if (change.operation === 'upsert') this.acceptedAnswerPeerGenerations[id] = this.peerStateGeneration;
            else if (change.removalCause !== 'window-eviction') delete this.acceptedAnswerPeerGenerations[id];
          }
        }
      }
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

        }
        this.synchronizeCollaborationHistoryScope(
          nextConversationId ?? '',
          Boolean(previousSessionId && previousSessionId !== result.state.sessionId)
        );
      }
      if (result.ack) {
        const released = incomingType === RELIABLE_KERNEL_SNAPSHOT_MESSAGE
          ? replaceReliableCommittedLive(this.$state)
          : applyReliableCommittedChanges(this.$state, (Array.isArray(envelope?.changes) ? envelope.changes : [])
            .filter(isRecord));
        releaseResidentDetails(this.$state, released);
      }
      // ACK means the ordered durable state was accepted. Send it before optional detail replay and
      // transient-overlay reconciliation so rendering work cannot head-of-line block the Feed.
      if (result.ack) bridge.postRaw(result.ack);
      if (result.ack && nextConversationId && visibleMessageCount(result.state.projections) > 0n
        && this.collaborationHistoryLoadedPages === 0
        && !this.collaborationHistoryLoading && !this.collaborationHistoryError) {
        // An ordinary transcript gives bootstrap a real reading boundary. A brand-new empty
        // Conversation has no possible local collaboration history, so do not scan the global
        // collaboration inventory just to paint navigation controls.
        this.collaborationHistoryHasMoreBefore = true;
        this.requestEarlierCollaborationHistory(nextConversationId, true);
      }
      for (const detail of replayDetails) {
        if (detail.mode === 'refresh') {
          this.refreshDetail(detail.kind, detail.recordId, { priority: detail.priority });
        } else {
          this.requestDetail(detail.kind, detail.recordId, { priority: detail.priority, itemAfterSequence: detail.itemAfterSequence, itemLimit: detail.itemLimit });
        }
      }
      reconcileReliableTransientRequests(this.transientModelRequests, this.records, this.details, this.messageContentWindows);
      releaseRetiredNativeHandoffs(this.$state);
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
        clearHistoryRequestTimeout(this.historyRequestId);
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

    requestEarlierCollaborationHistory(conversationId: string, bootstrap = false): boolean {
      return this.requestCollaborationHistoryPage(conversationId, 'before', bootstrap);
    },

    requestLaterCollaborationHistory(conversationId: string): boolean {
      return this.requestCollaborationHistoryPage(conversationId, 'after');
    },

    requestCollaborationHistoryPage(conversationId: string, direction: 'before' | 'after', bootstrap = false): boolean {
      const normalized = conversationId.trim();
      const sessionId = this.sessionId;
      if (!normalized || !sessionId || activeConversationId(this.projections) !== normalized
        || this.collaborationHistoryConversationId !== normalized || this.collaborationHistoryLoading
        || !(direction === 'before' ? this.collaborationHistoryHasMoreBefore : this.collaborationHistoryHasMoreAfter)) return false;
      const cursor = direction === 'before' ? this.collaborationHistoryNextBeforeCursor : this.collaborationHistoryNextAfterCursor;
      if (cursor && !isCollaborationHistoryCursor(cursor, direction)) {
        this.collaborationHistoryError = '协作历史分页游标不可用。';
        return false;
      }
      const requestId = createMessageId();
      this.collaborationHistoryLoading = true;
      this.collaborationHistoryError = null;
      this.collaborationHistoryRequestId = requestId;
      this.collaborationHistoryRequestDirection = direction;
      this.collaborationHistoryRequestCursor = cursor;
      const edgePage = direction === 'before' ? this.collaborationHistoryPages[0] : this.collaborationHistoryPages[this.collaborationHistoryPages.length - 1];
      this.collaborationHistoryRequestPageId = edgePage?.id ?? null;
      this.collaborationHistoryRequestPeerGeneration = this.peerStateGeneration;
      this.collaborationHistoryRequestIsBootstrap = bootstrap;
      const timeout = setTimeout(() => {
        collaborationHistoryTimeouts.delete(requestId);
        if (this.collaborationHistoryRequestId !== requestId || this.sessionId !== sessionId
          || this.collaborationHistoryConversationId !== normalized) return;
        this.collaborationHistoryLoading = false;
        this.collaborationHistoryRequestId = null;
        this.collaborationHistoryRequestIsBootstrap = false;
        this.collaborationHistoryError = '协作历史请求超时，请重试。';
      }, COLLABORATION_HISTORY_REQUEST_DEADLINE_MS);
      // Node SSR regressions must not keep the process alive for an unanswered optional read.
      (timeout as unknown as { unref?: () => void }).unref?.();
      collaborationHistoryTimeouts.set(requestId, timeout);
      try {
        bridge.postRaw({
          type: RELIABLE_KERNEL_COLLABORATION_HISTORY_REQUEST_MESSAGE,
          requestId, sessionId, conversationId: normalized, direction,
          ...(cursor === null ? {} : { cursor }),
          limit: HISTORY_PAGE_LIMIT
        });
      } catch (error) {
        clearCollaborationHistoryTimeout(requestId);
        this.collaborationHistoryLoading = false;
        this.collaborationHistoryRequestId = null;
        this.collaborationHistoryRequestIsBootstrap = false;
        this.collaborationHistoryError = error instanceof Error ? error.message : '请求协作历史失败。';
        return false;
      }
      return true;
    },

    observeCollaborationHistoryResult(message: ReliableKernelCollaborationHistoryResultMessage): void {
      if (message.sessionId !== this.sessionId
        || message.conversationId !== this.collaborationHistoryConversationId
        || message.conversationId !== activeConversationId(this.projections)
        || message.requestId !== this.collaborationHistoryRequestId) return;
      const direction = this.collaborationHistoryRequestDirection;
      const cursor = this.collaborationHistoryRequestCursor;
      if (!isCollaborationHistoryPage(message.page, cursor, direction, message.conversationId)) {
        clearCollaborationHistoryTimeout(message.requestId);
        this.collaborationHistoryLoading = false;
        this.collaborationHistoryRequestId = null;
        this.collaborationHistoryRequestIsBootstrap = false;
        this.collaborationHistoryError = '协作历史分页游标或记录格式无效。';
        return;
      }
      try {
        const records = mergeHistoryRecordPage({}, message.page.records, COLLABORATION_HISTORY_RECORD_TYPES);
        const hasRecords = Object.values(records).some(bucket => Object.keys(bucket).length > 0);
        const page: ReliableResidentCollaborationPage = { id: message.requestId,
          members: hasRecords ? admitReliableHistoryRecords(this.$state, records) : {},
          before: message.page.nextBeforeCursor, after: message.page.nextAfterCursor,
          hasMoreBefore: message.page.hasMoreBefore, hasMoreAfter: message.page.hasMoreAfter };
        const source = this.collaborationHistoryPages.find(candidate => candidate.id === this.collaborationHistoryRequestPageId);
        if (source && !hasRecords) {
          // Empty inventory scans extend the known edge. They neither evict readable cards nor
          // turn a source transition into unvisited history on the already scanned opposite side.
          if (direction === 'before') {
            source.before = page.before;
            source.hasMoreBefore = page.hasMoreBefore;
          } else {
            source.after = page.after;
            source.hasMoreAfter = page.hasMoreAfter;
          }
        } else {
          const emptySource = source && Object.values(source.members).every(ids => Object.keys(ids).length === 0) ? source : undefined;
          if (emptySource) {
            // The first real page also owns the empty interval already crossed to reach it.
            if (direction === 'before') {
              page.after = emptySource.after;
              page.hasMoreAfter = emptySource.hasMoreAfter;
            } else {
              page.before = emptySource.before;
              page.hasMoreBefore = emptySource.hasMoreBefore;
            }
          }
          const replaced = this.collaborationHistoryPages.filter(candidate => candidate === emptySource
            || sameCollaborationCursor(candidate.before, page.before) && sameCollaborationCursor(candidate.after, page.after));
          const pages = this.collaborationHistoryPages.filter(candidate => !replaced.includes(candidate));
          if (direction === 'before') pages.unshift(page);
          else pages.push(page);
          this.collaborationHistoryPages = pages;
          releaseResidentDetails(this.$state, releaseReliablePageMembers(this.$state, replaced));
          releaseResidentDetails(this.$state, retainReliableCollaborationPages(this.$state, page.id));
        }
        setCollaborationHistoryCursorsFromResidentPages(this.$state);
        for (const row of message.page.records.RuntimeDeliveryAnswerPresentation ?? []) {
          const id = String(row.id);
          this.acceptedAnswerPeerGenerations[id] = this.records.RuntimeDeliveryAnswerPresentation?.[id]
            ? this.peerStateGeneration : this.collaborationHistoryRequestPeerGeneration ?? this.peerStateGeneration;
        }
      } catch (error) {
        clearCollaborationHistoryTimeout(message.requestId);
        this.collaborationHistoryLoading = false;
        this.collaborationHistoryRequestId = null;
        this.collaborationHistoryRequestIsBootstrap = false;
        this.collaborationHistoryError = error instanceof Error ? error.message : '协作历史页面格式无效。';
        return;
      }
      // Bootstrap can cross the three fixed sources, but never scan another window in a lane.
      // Empty transcripts may still have collaboration cards; only a terminal page proves absence.
      const nextCursor = message.page.nextBeforeCursor;
      const continueBootstrap = this.collaborationHistoryRequestIsBootstrap
        && this.collaborationHistoryLoadedPages < 2
        && message.page.hasMoreBefore
        && Object.values(message.page.records).every((rows) => rows.length === 0)
        && ((!cursor && nextCursor?.kind === 'message' && nextCursor.beforeMessageSeq === undefined)
          || (cursor?.kind === 'message' && cursor.beforeMessageSeq === undefined
            && nextCursor?.kind === 'answer' && nextCursor.beforeCreatedAt === undefined));
      clearCollaborationHistoryTimeout(message.requestId);
      this.collaborationHistoryScanProgress = message.page.scanProgress;
      this.collaborationHistoryLoading = false;
      this.collaborationHistoryError = null;
      this.collaborationHistoryRequestId = null;
      this.collaborationHistoryRequestIsBootstrap = false;
      this.collaborationHistoryScannedRows += message.page.scannedRows;
      this.collaborationHistoryLoadedPages += 1;
      if (continueBootstrap) this.requestEarlierCollaborationHistory(message.conversationId, true);
    },

    retainCollaborationReadingPage(card: { messageId: string; acceptedAnswerId?: string }): void {
      if (this.collaborationHistoryLoading) return;
      const page = reliableCollaborationPageForCard(this.$state, card);
      if (!page) return;
      if (this.collaborationHistoryCurrentPageId !== page.id || this.collaborationHistoryPages.length > 3) {
        releaseResidentDetails(this.$state, retainReliableCollaborationPages(this.$state, page.id));
      }
      setCollaborationHistoryCursorsFromResidentPages(this.$state);
    },

    observeCollaborationHistoryError(message: ReliableKernelCollaborationHistoryErrorMessage): void {
      if (message.sessionId !== this.sessionId
        || message.conversationId !== this.collaborationHistoryConversationId
        || message.requestId !== this.collaborationHistoryRequestId) return;
      clearCollaborationHistoryTimeout(message.requestId);
      this.collaborationHistoryLoading = false;
      this.collaborationHistoryRequestId = null;
      this.collaborationHistoryRequestIsBootstrap = false;
      this.collaborationHistoryError = message.message.trim() || '读取协作历史失败。';
    },

    cancelHistoryRequests(): void {
      clearHistoryRequestTimeout(this.historyRequestId);
      clearCollaborationHistoryTimeout(this.collaborationHistoryRequestId);
      this.historyLoading = false;
      this.historyRequestId = null;
      this.collaborationHistoryLoading = false;
      this.collaborationHistoryRequestId = null;
      this.collaborationHistoryRequestIsBootstrap = false;
    },

    requestEarlierHistory(conversationId: string): boolean {
      return this.requestHistoryPage(conversationId, 'before');
    },

    requestLaterHistory(conversationId: string): boolean {
      return this.requestHistoryPage(conversationId, 'after');
    },

    requestHistoryPage(conversationId: string, direction: 'before' | 'after'): boolean {
      const normalized = conversationId.trim();
      const sessionId = this.sessionId;
      if (
        !normalized
        || !sessionId
        || activeConversationId(this.projections) !== normalized
        || this.historyConversationId !== normalized
        || this.historyLoading
        || !(direction === 'before' ? this.historyHasMore : this.historyHasMoreAfter)
      ) return false;
      const cursorMessageSeq = direction === 'before' ? this.historyNextBeforeMessageSeq : this.historyNextAfterMessageSeq;
      const cursorId = direction === 'before' ? this.historyNextBeforeId : this.historyNextAfterId;
      if (!cursorMessageSeq || !cursorId) {
        this.historyError = '更早消息的分页游标不可用。';
        return false;
      }
      const requestId = createMessageId();
      this.historyLoading = true;
      this.historyError = null;
      this.historyRequestId = requestId;
      this.historyRequestDirection = direction;
      const timeout = setTimeout(() => {
        historyRequestTimeouts.delete(requestId);
        if (this.historyRequestId !== requestId || this.sessionId !== sessionId
          || this.historyConversationId !== normalized) return;
        this.historyLoading = false;
        this.historyRequestId = null;
        this.historyError = '更早消息请求超时，请重试。';
      }, HISTORY_REQUEST_DEADLINE_MS);
      (timeout as unknown as { unref?: () => void }).unref?.();
      historyRequestTimeouts.set(requestId, timeout);
      try {
        bridge.postRaw({
          type: RELIABLE_KERNEL_HISTORY_PAGE_REQUEST_MESSAGE,
          requestId,
          sessionId,
          conversationId: normalized,
          ...(direction === 'before'
            ? { beforeMessageSeq: cursorMessageSeq, beforeId: cursorId }
            : { afterMessageSeq: cursorMessageSeq, afterId: cursorId }),
          limit: HISTORY_PAGE_LIMIT
        });
      } catch (error) {
        clearHistoryRequestTimeout(this.historyRequestId);
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
      clearHistoryRequestTimeout(message.requestId);
      if ((message.page.hasMoreBefore && (!message.page.nextBeforeMessageSeq || !message.page.nextBeforeId))
        || (message.page.hasMoreAfter && (!message.page.nextAfterMessageSeq || !message.page.nextAfterId))) {
        this.historyLoading = false;
        this.historyRequestId = null;
        this.historyError = '消息页面缺少连续分页游标。';
        return;
      }
      try {
        const records = mergeHistoryRecordPage({}, message.page.records);
        const messages = Object.values(records.Message ?? {}).filter(row => isVisibleConversationMessage(row, message.conversationId))
          .sort((left, right) => compareIntegerStrings(String(left.message_seq), String(right.message_seq))
            || String(left.id).localeCompare(String(right.id)));
        const first = messages[0], last = messages[messages.length - 1];
        if (first && last) {
          const members = admitReliableHistoryRecords(this.$state, records);
          const page: ReliableResidentHistoryPage = {
            id: message.requestId, members, messageIds: messages.map(row => String(row.id)),
            before: { messageSeq: message.page.nextBeforeMessageSeq ?? String(first.message_seq), id: message.page.nextBeforeId ?? String(first.id) },
            after: { messageSeq: message.page.nextAfterMessageSeq ?? String(last.message_seq), id: message.page.nextAfterId ?? String(last.id) },
            hasMoreBefore: message.page.hasMoreBefore, hasMoreAfter: message.page.hasMoreAfter
          };
          const replaced = this.historyPages.filter(candidate => candidate.before.id === page.before.id && candidate.after.id === page.after.id);
          this.historyPages = [...this.historyPages.filter(candidate => !replaced.includes(candidate)), page]
            .sort((left, right) => compareReliableMessageCursors(left.before, right.before));
          releaseResidentDetails(this.$state, releaseReliablePageMembers(this.$state, replaced));
          releaseResidentDetails(this.$state, retainReliableReadingPages(this.$state, page.id));
          setHistoryCursorFromPage(this.$state, page);
        } else if (this.historyRequestDirection === 'before') this.historyHasMore = false;
        else this.historyHasMoreAfter = false;
      } catch (error) {
        this.historyLoading = false;
        this.historyRequestId = null;
        this.historyError = error instanceof Error ? error.message : '消息页面格式无效。';
        return;
      }
      this.historyLoading = false;
      this.historyError = null;
      this.historyRequestId = null;
      this.historyLoadedPages += 1;
    },

    retainReadingPage(messageId?: string): void {
      const page = reliableHistoryPageForMessage(this.$state, messageId);
      const pageId = page?.id ?? null;
      if (this.historyCurrentPageId !== pageId || this.historyPages.length > 3) {
        releaseResidentDetails(this.$state, retainReliableReadingPages(this.$state, pageId));
      }
      if (page) setHistoryCursorFromPage(this.$state, page);
      else if (this.historyConversationId) seedHistoryCursorFromLiveRecords(this.$state, this.historyConversationId);
    },

    observeHistoryPageError(message: ReliableKernelHistoryPageErrorMessage): void {
      if (
        message.sessionId !== this.sessionId
        || message.conversationId !== this.historyConversationId
        || message.requestId !== this.historyRequestId
      ) return;
      clearHistoryRequestTimeout(message.requestId);
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
      const handoffOwner = `native-handoff:${message.modelRequestId}`;
      const releasedHandoffKeys = this.detailOwnerKeys[handoffOwner] ?? [];
      delete this.detailOwnerKeys[handoffOwner];
      this.releaseDetails(releasedHandoffKeys);
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
        if (content?.type === 'native_completed') {
          delete next.completedContent;
        } else {
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
        }
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
      const committedRevisionId = nonEmptyString(content?.committedRevisionId);
      const committedContentObjectId = nonEmptyString(content?.committedContentObjectId);
      const committedPart = plainRecord(content?.committedPart) as ContentPart | undefined;
      const handoffOwner = `native-handoff:${message.modelRequestId}`;
      if (message.event.kind === 'output_item_done' && committedRevisionId && committedContentObjectId && committedPart) {
        const key = detailKey('message-content-item', committedContentObjectId);
        if (this.details[key]?.status !== 'ready') {
          const text = JSON.stringify({ role: 'model', parts: [committedPart] } satisfies MessageContent);
          this.details[key] = { status: 'ready', text, totalBytes: new TextEncoder().encode(text).byteLength };
          this.detailCacheMeta[key] = { lastAccessedAt: Date.now(), bytes: this.details[key]!.totalBytes };
        }
        // The live handoff and the committed projection share the one parsed CAS item. The Feed
        // may still be publishing its bounded index page when the item-done frame arrives.
        const storedPart = parseReliableMessageContent(this.details[key]!, 'model').parts[0]!;
        next.outputParts = replaceReliableTransientCommittedPart(next.outputParts, storedPart);
        const keys = [...new Set([...(this.detailOwnerKeys[handoffOwner] ?? []), key])];
        this.setDetailOwnerKeys(handoffOwner, keys);
      }
      this.transientModelRequests[message.modelRequestId] = next;
      if (committedContentObjectId) {
        const link = Object.values(this.committedRecords.ModelRequestMessageLink ?? {}).find(value => value.model_request_id === message.modelRequestId);
        const messageId = nonEmptyString(link?.message_id);
        const window = messageId ? this.messageContentWindows[messageId] : undefined;
        const offscreen = window?.followTail === false;
        this.retireCommittedTransientItem(committedContentObjectId, offscreen ? message.modelRequestId : undefined);
        const keys = this.detailOwnerKeys[handoffOwner] ?? [];
        for (const key of keys.slice(0, Math.max(0, keys.length - MESSAGE_CONTENT_ITEM_PAGE_SIZE))) {
          this.retireCommittedTransientItem(key.slice('message-content-item:'.length), message.modelRequestId);
        }
      }
      debugCaptureTrace.observe(debug, () => ({ stage: 'ui.frame', metadata: { ...debugFrameMetadata(message), ...debugMode, decision: 'applied', status: next.status }, payload: message.event }));
      // A streaming delta cannot retire any overlay. Full reconciliation scans the bounded durable
      // window and is needed only at terminal events or durable Feed commits.
      if (next.status !== 'streaming') {
        reconcileReliableTransientRequests(this.transientModelRequests, this.records, this.details, this.messageContentWindows);
        releaseRetiredNativeHandoffs(this.$state);
      }
      if (!current) reportTransientPaint(this.sessionId, message, sequence);
    },

    setPinnedDetailKeys(keys: string[]): void {
      this.pinnedDetailKeys = [...new Set(keys.filter((key) => key.length > 0))].slice(0, 256);
      releaseUnownedDetailKeys(this.$state);
      this.pumpDetailQueue();
      pruneDetailCache(this.$state);
    },

    setDetailOwnerKeys(owner: string, keys: string[]): void {
      if (keys.length > 0) this.detailOwnerKeys[owner] = keys;
      else delete this.detailOwnerKeys[owner];
      releaseUnownedDetailKeys(this.$state);
      this.pumpDetailQueue();
    },

    releaseDetails(keys: readonly string[]): void {
      for (const key of keys) this.releasedDetailKeys[key] = true;
      releaseUnownedDetailKeys(this.$state);
      this.pumpDetailQueue();
    },

    retainMessageContentWindows(messageIds: readonly string[]): void {
      const retained = new Set(messageIds);
      for (const [messageId, window] of Object.entries(this.messageContentWindows)) {
        if (retained.has(messageId) && this.committedRecords.Message?.[messageId]) continue;
        delete this.messageContentWindows[messageId];
        delete this.detailOwnerKeys[`message-content-window:${messageId}`];
        const keys = window.pages.flatMap(page => [page.key, ...page.items.map(item => detailKey('message-content-item', item.contentObjectId))]);
        for (const [key, owner] of Object.entries(this.messageContentItemOwners)) if (owner === messageId) {
          delete this.messageContentItemOwners[key]; keys.push(key);
        }
        this.releaseDetails(keys);
        for (const link of Object.values(this.committedRecords.ModelRequestMessageLink ?? {})) {
          if (link.message_id !== messageId || typeof link.model_request_id !== 'string') continue;
          const owner = `native-handoff:${link.model_request_id}`;
          for (const key of this.detailOwnerKeys[owner] ?? []) {
            this.retireCommittedTransientItem(key.slice('message-content-item:'.length), link.model_request_id);
          }
        }
      }
    },

    requestMessageContentPage(messageId: string, afterSequence?: number, options: { prefetch?: boolean; priority?: ReliableKernelDetailPriority; retry?: boolean } = {}): void {
      const message = this.committedRecords.Message?.[messageId];
      const indexRevisionId = nonEmptyString(message?.item_index_revision_id);
      if (!indexRevisionId) return;
      const key = reliableMessageContentItemsKey(indexRevisionId, afterSequence);
      const previous = this.messageContentWindows[messageId];
      const window: ReliableMessageContentWindow = previous ?? { indexRevisionId, pages: [], followTail: afterSequence === undefined };
      const cachedPage = window.pages.find(page => page.key === key);
      const currentPageKey = cachedPage ? key : window.currentPageKey;
      const followTail = afterSequence === undefined || Boolean(cachedPage
        && cachedPage.items[cachedPage.items.length - 1]?.sequence === cachedPage.totalItems);
      if (!previous || window.indexRevisionId !== indexRevisionId || (!options.prefetch
        && (window.currentAfterSequence !== afterSequence || window.currentPageKey !== currentPageKey || window.followTail !== followTail))) {
        this.messageContentWindows[messageId] = { ...window, indexRevisionId,
          ...(!options.prefetch ? { currentAfterSequence: afterSequence, currentPageKey, followTail } : {}) };
      }
      this.messageContentItemOwners[key] = messageId;
      if (window.indexRevisionId !== indexRevisionId) {
        const retainedPageKeys = new Set(window.pages.map(page => page.key));
        for (const [candidate, owner] of Object.entries(this.messageContentItemOwners)) {
          if (owner !== messageId || candidate === key || retainedPageKeys.has(candidate)) continue;
          delete this.messageContentItemOwners[candidate];
          this.releasedDetailKeys[candidate] = true;
        }
      }
      this.hydrateMessageContentWindow(messageId);
      if (cachedPage) return;
      this.requestDetail('message-content-items', indexRevisionId, { itemAfterSequence: afterSequence,
        itemLimit: MESSAGE_CONTENT_ITEM_PAGE_SIZE, priority: options.priority ?? (options.prefetch ? 'background' : 'visible'),
        ...(options.retry ? { bypassBackoff: true, retryCount: 0 } : {}) });
      if (this.details[key]?.status === 'ready') this.admitMessageContentItems(key, indexRevisionId);
    },

    ensureMessageContent(messageId: string, priority: ReliableKernelDetailPriority = 'visible'): void {
      const message = this.committedRecords.Message?.[messageId];
      const revisionId = nonEmptyString(message?.revision_id);
      if (!revisionId) return;
      if (!nonEmptyString(message?.item_index_revision_id)) { this.requestDetail('message-content', revisionId, { priority }); return; }
      const window = this.messageContentWindows[messageId];
      this.requestMessageContentPage(messageId, window?.followTail === false ? window.currentAfterSequence : undefined, { priority });
    },

    moveMessageContentWindow(messageId: string, direction: 'before' | 'after'): void {
      const window = this.messageContentWindows[messageId];
      if (!window || this.details[reliableMessageContentItemsKey(window.indexRevisionId, window.currentAfterSequence)]?.status === 'loading') return;
      const items = residentReliableMessageContentItems(window);
      const first = items[0]?.sequence ?? 1, last = items[items.length - 1]?.sequence ?? 0;
      const total = window.pages.reduce((max, page) => Math.max(max, page.totalItems), 0);
      if (direction === 'before' && first > 1) this.requestMessageContentPage(messageId, Math.max(0, first - MESSAGE_CONTENT_ITEM_PAGE_SIZE - 1));
      else if (direction === 'after' && last < total) this.requestMessageContentPage(messageId, last);
    },

    retryMessageContentWindow(messageId: string): void {
      const window = this.messageContentWindows[messageId];
      if (!window) return;
      const metadataKey = reliableMessageContentItemsKey(window.indexRevisionId, window.currentAfterSequence);
      const metadataDetail = this.details[metadataKey];
      if (metadataDetail?.status === 'loading') return;
      if (metadataDetail?.status === 'error' && !metadataDetail.terminalError) {
        this.requestMessageContentPage(messageId, window.currentAfterSequence, { retry: true });
      }
      for (const item of residentReliableMessageContentItems(window)) {
        const detail = this.details[detailKey('message-content-item', item.contentObjectId)];
        if (detail?.status === 'error' && !detail.terminalError) this.retryDetail('message-content-item', item.contentObjectId, { priority: 'visible' });
      }
    },

    admitMessageContentItems(key: string, indexRevisionId: string): void {
      const messageId = this.messageContentItemOwners[key];
      const window = messageId ? this.messageContentWindows[messageId] : undefined;
      const detail = this.details[key];
      if (!window || window.indexRevisionId !== indexRevisionId) {
        delete this.messageContentItemOwners[key];
        if (messageId && window) this.hydrateMessageContentWindow(messageId);
        this.releaseDetails([key]);
        return;
      }
      if (detail?.status !== 'ready') return;
      const page = parseReliableMessageContentItemPage(detail.text, key, indexRevisionId);
      const knownItems = new Map(residentReliableMessageContentItems(window).map(item => [item.id, item]));
      page.items = page.items.map(item => knownItems.get(item.id) ?? item);
      const candidates = [...window.pages.filter(candidate => candidate.key !== key
        && !(candidate.items[0]?.sequence === page.items[0]?.sequence && candidate.items[candidate.items.length - 1]?.sequence === page.items[page.items.length - 1]?.sequence)), page]
        .sort((left, right) => (left.items[0]?.sequence ?? 0) - (right.items[0]?.sequence ?? 0));
      const selected = reliableMessageContentItemsKey(window.indexRevisionId, window.currentAfterSequence) === key;
      const currentKey = selected || !window.currentPageKey ? key : window.currentPageKey;
      const current = Math.max(0, candidates.findIndex(candidate => candidate.key === currentKey));
      const pages = candidates.slice(Math.max(0, current - 1), current + 2);
      const removed = [...window.pages, page].filter(candidate => !pages.includes(candidate));
      this.messageContentWindows[messageId!] = { ...window, pages, currentPageKey: currentKey,
        ...(selected ? { followTail: page.items[page.items.length - 1]?.sequence === page.totalItems } : {}) };
      for (const removedPage of removed) delete this.messageContentItemOwners[removedPage.key];
      this.hydrateMessageContentWindow(messageId!);
      const keptKeys = new Set(pages.flatMap(candidate => [candidate.key, ...candidate.items.map(item => detailKey('message-content-item', item.contentObjectId))]));
      this.releaseDetails(removed.flatMap(candidate => [candidate.key, ...candidate.items.map(item => detailKey('message-content-item', item.contentObjectId))]).filter(candidate => !keptKeys.has(candidate)));
      if (selected && page.items.length > 0) {
        const first = page.items[0]!.sequence, last = page.items[page.items.length - 1]!.sequence;
        if (first > 1) this.requestMessageContentPage(messageId!, Math.max(0, first - MESSAGE_CONTENT_ITEM_PAGE_SIZE - 1), { prefetch: true });
        if (last < page.totalItems) this.requestMessageContentPage(messageId!, last, { prefetch: true });
      }
    },

    hydrateMessageContentWindow(messageId: string): void {
      const window = this.messageContentWindows[messageId];
      if (!window) return;
      const keys = window.pages.flatMap(page => [page.key, ...page.items.map(item => detailKey('message-content-item', item.contentObjectId))]);
      for (const [key, owner] of Object.entries(this.messageContentItemOwners)) if (owner === messageId) keys.push(key);
      this.setDetailOwnerKeys(`message-content-window:${messageId}`, [...new Set(keys)]);
      for (const item of residentReliableMessageContentItems(window)) {
        this.requestDetail('message-content-item', item.contentObjectId, { priority: 'visible' });
        this.retireCommittedTransientItem(item.contentObjectId);
      }
    },

    retireCommittedTransientItem(contentObjectId: string, forceRequestId?: string): void {
      const key = detailKey('message-content-item', contentObjectId), detail = this.details[key];
      if (detail?.status !== 'ready') return;
      const requestIds = new Set<string>();
      if (forceRequestId) requestIds.add(forceRequestId);
      else {
        const owners = new Set(Object.entries(this.messageContentWindows).flatMap(([messageId, window]) =>
          window.pages.some(page => page.items.some(item => item.contentObjectId === contentObjectId)) ? [messageId] : []));
        for (const link of Object.values(this.committedRecords.ModelRequestMessageLink ?? {})) {
          if (owners.has(String(link.message_id)) && typeof link.model_request_id === 'string') requestIds.add(link.model_request_id);
        }
      }
      for (const requestId of requestIds) {
        const transient = this.transientModelRequests[requestId];
        if (transient) this.transientModelRequests[requestId] = withoutCommittedTransientParts(transient, parseReliableMessageContent(detail, 'model'));
        const owner = `native-handoff:${requestId}`;
        this.setDetailOwnerKeys(owner, (this.detailOwnerKeys[owner] ?? []).filter(candidate => candidate !== key));
      }
      if (requestIds.size > 0) this.releaseDetails([key]);
    },

    requestDetail(
      kind: ReliableKernelClientDetailKind,
      recordId: string,
      options: ReliableKernelDetailRequestOptions = {}
    ): string | undefined {
      const id = recordId.trim();
      const sessionId = this.sessionId;
      if (!id || !sessionId) return undefined;
      const key = detailKey(kind, id, options);
      delete this.releasedDetailKeys[key];
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
              mode: 'initial', itemAfterSequence: options.itemAfterSequence, itemLimit: options.itemLimit
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
        itemAfterSequence: options.itemAfterSequence, itemLimit: options.itemLimit,
        retryCount,
        ...(kind === 'accepted-answer-content' ? { peerStateGeneration: this.peerStateGeneration } : {})
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
      if (current?.terminalError) return key;
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
      if (!id || !sessionId) return undefined;
      const existing = Object.values(this.pendingDetails).find((request) => request.key === key);
      if (existing) {
        // Its pages freeze the older prefix. One later read must observe a final Process update
        // even if it arrives before these pages finish and the running-process poll stops.
        existing.refreshRequested = true;
        const priority = options.priority ?? 'visible';
        if (DETAIL_PRIORITY_ORDER[priority] < DETAIL_PRIORITY_ORDER[existing.priority]) {
          existing.priority = priority;
          this.sortDetailQueue();
          this.pumpDetailQueue();
        }
        return key;
      }
      if (current?.status !== 'ready') return this.requestDetail(kind, recordId, options);
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
        ...(current.peerState ? { peerState: current.peerState } : {}),
        ...(current.peerStateGeneration === undefined ? {} : { peerStateGeneration: current.peerStateGeneration }),
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
        retryCount: options.retryCount ?? current.retryCount ?? 0,
        ...(kind === 'accepted-answer-content' ? { peerStateGeneration: this.peerStateGeneration } : {})
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
      if (pending.kind === 'accepted-answer-content'
        && pending.peerStateGeneration === this.peerStateGeneration
        && ['known', 'deleted', 'unknown'].includes(message.detail.peerState ?? '')) {
        pending.peerState = message.detail.peerState;
      }
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
          totalBytes: message.detail.totalBytes,
          ...(pending.kind === 'accepted-answer-content' && pending.peerStateGeneration === this.peerStateGeneration
            ? { peerStateGeneration: this.peerStateGeneration, ...(pending.peerState ? { peerState: pending.peerState } : {}) } : {})
        };
        clearDetailRetryTimer(pending.key);
        this.detailCacheMeta[pending.key] = {
          lastAccessedAt: Date.now(),
          bytes: message.detail.totalBytes
        };
        if (pending.kind === 'message-content-items') this.admitMessageContentItems(pending.key, pending.recordId);
        else if (pending.kind === 'message-content-item') this.retireCommittedTransientItem(pending.recordId);
        pruneDetailCache(this.$state);
        // The durable Message shell can precede its on-demand body. Retire a completed transient
        // overlay in the same action that makes the final detail ready, rather than waiting for an
        // unrelated later feed commit or transient event to trigger reconciliation.
        reconcileReliableTransientRequests(this.transientModelRequests, this.records, this.details, this.messageContentWindows);
        releaseRetiredNativeHandoffs(this.$state);
      } catch (error) {
        this.failDetailRequest(
          message.requestId,
          error instanceof Error ? error.message : '详情内容解码失败。',
          message.detail.totalBytes
        );
        return;
      }
      this.finishDetailRequest(message.requestId, { completed: true });
    },

    observeDetailError(message: ReliableKernelDetailErrorMessage): void {
      if (message.sessionId !== this.sessionId) return;
      const pending = this.pendingDetails[message.requestId];
      if (!pending || pending.sessionId !== message.sessionId) return;
      this.failDetailRequest(message.requestId, message.message, undefined, message.retryable !== false);
    },

    failDetailRequest(requestId: string, error: string, totalBytes?: number, retryable = true): void {
      const pending = this.pendingDetails[requestId];
      if (!pending) return;
      const current = this.details[pending.key];
      const retryCount = pending.retryCount + 1;
      const retryDelay = retryable ? DETAIL_AUTO_RETRY_DELAYS_MS[retryCount - 1] : undefined;
      if (!retryable) clearDetailRetryTimer(pending.key);
      const nextRetryAt = retryDelay === undefined ? undefined : Date.now() + retryDelay;
      if (pending.mode === 'refresh' && current?.status === 'ready') {
        this.details[pending.key] = {
          status: 'ready',
          text: current.text,
          totalBytes: current.totalBytes,
          refreshError: error,
          retryCount,
          ...(!retryable ? { terminalError: true } : {}),
          ...(nextRetryAt !== undefined ? { nextRetryAt } : {})
        };
      } else {
        this.details[pending.key] = {
          status: 'error',
          text: '',
          totalBytes: totalBytes ?? current?.totalBytes ?? 0,
          error,
          retryCount,
          ...(!retryable ? { terminalError: true } : {}),
          ...(nextRetryAt !== undefined ? { nextRetryAt } : {})
        };
      }
      this.finishDetailRequest(requestId);
      if (retryDelay !== undefined) {
        this.scheduleDetailRetry(pending.kind, pending.recordId, {
          priority: pending.priority,
          retryCount,
          mode: pending.mode, itemAfterSequence: pending.itemAfterSequence, itemLimit: pending.itemLimit
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
        itemAfterSequence?: number;
        itemLimit?: number;
      },
      delayMs: number
    ): void {
      const id = recordId.trim();
      const sessionId = this.sessionId;
      if (!id || !sessionId) return;
      const key = detailKey(kind, id, retry);
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
          itemAfterSequence: retry.itemAfterSequence, itemLimit: retry.itemLimit,
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

    finishDetailRequest(requestId: string, options: { completed?: boolean } = {}): void {
      const pending = this.pendingDetails[requestId];
      const timeout = detailRequestTimeouts.get(requestId);
      if (timeout !== undefined) clearTimeout(timeout);
      detailRequestTimeouts.delete(requestId);
      detailDecoders.delete(requestId);
      detailTextChunks.delete(requestId);
      delete this.pendingDetails[requestId];
      this.activeDetailRequestIds = this.activeDetailRequestIds.filter((id) => id !== requestId);
      this.detailQueue = this.detailQueue.filter((id) => id !== requestId);
      this.pumpDetailQueue();
      // Only a completed read drains a later demand. A failed read keeps the existing bounded
      // retry/backoff path; it must not turn a polling demand into a fresh retry budget.
      if (options.completed && pending?.refreshRequested && pending.sessionId === this.sessionId) {
        this.refreshDetail(pending.kind, pending.recordId, { priority: pending.priority });
      }
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
        ...(pending.itemAfterSequence === undefined ? {} : { itemAfterSequence: pending.itemAfterSequence }),
        ...(pending.itemLimit === undefined ? {} : { itemLimit: pending.itemLimit }),
        ...(pending.totalBytes === undefined ? {} : { expectedTotalBytes: pending.totalBytes })
      });
    }
  }
});

const historyLifecycleStores = new WeakSet<object>();
export const useReliableKernelClientFeedStore: typeof useReliableKernelClientFeedStoreDefinition = Object.assign(
  (...args: Parameters<typeof useReliableKernelClientFeedStoreDefinition>) => {
    const store = useReliableKernelClientFeedStoreDefinition(...args);
    if (!historyLifecycleStores.has(store)) {
      historyLifecycleStores.add(store);
      const reset = store.$reset.bind(store);
      store.$reset = () => { store.cancelHistoryRequests(); reset(); };
      const dispose = store.$dispose.bind(store);
      store.$dispose = () => { store.cancelHistoryRequests(); historyLifecycleStores.delete(store); dispose(); };
    }
    return store;
  }, useReliableKernelClientFeedStoreDefinition
);

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
  const validCompletedContent = kind !== 'completed' || plainRecord(item.event.content)?.type === 'native_completed'
    || messageContentValue(item.event.content) !== undefined;
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
  const providerResponseId = nonEmptyString(record?.providerResponseId);
  const previousResponseId = nonEmptyString(record?.previousResponseId);
  const steeringSuccessorResponseId = nonEmptyString(record?.steeringSuccessorResponseId);
  return { id, ordinal, ...(phase ? { phase } : {}), ...(providerResponseId ? { providerResponseId } : {}),
    ...(previousResponseId ? { previousResponseId } : {}), ...(steeringSuccessorResponseId ? { steeringSuccessorResponseId } : {}) };
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
  const releasedPages = state.collaborationHistoryPages;
  state.collaborationHistoryPages = [];
  releaseResidentDetails(state, releaseReliablePageMembers(state, releasedPages));
  state.collaborationHistoryCurrentPageId = null;
  state.collaborationHistoryNextBeforeCursor = null;
  state.collaborationHistoryNextAfterCursor = null;
  state.collaborationHistoryHasMoreBefore = false;
  state.collaborationHistoryHasMoreAfter = false;
  state.collaborationHistoryScanProgress = false;
  state.collaborationHistoryLoading = false;
  state.collaborationHistoryError = null;
  state.collaborationHistoryRequestId = null;
  state.collaborationHistoryRequestDirection = 'before';
  state.collaborationHistoryRequestCursor = null;
  state.collaborationHistoryRequestPageId = null;
  state.collaborationHistoryRequestPeerGeneration = null;
  state.collaborationHistoryRequestIsBootstrap = false;
  state.collaborationHistoryLoadedPages = 0;
  state.collaborationHistoryScannedRows = 0;
}

/** Reading selects cache residency, while requests continue outside the whole resident interval. */
function setCollaborationHistoryCursorsFromResidentPages(state: ReliableKernelFeedStoreState): void {
  const first = state.collaborationHistoryPages[0];
  const last = state.collaborationHistoryPages[state.collaborationHistoryPages.length - 1];
  state.collaborationHistoryNextBeforeCursor = first?.before ?? null;
  state.collaborationHistoryNextAfterCursor = last?.after ?? null;
  state.collaborationHistoryHasMoreBefore = first?.hasMoreBefore ?? false;
  state.collaborationHistoryHasMoreAfter = last?.hasMoreAfter ?? false;
}

function sameCollaborationCursor(
  left: ReliableKernelCollaborationHistoryCursor | undefined,
  right: ReliableKernelCollaborationHistoryCursor | undefined
): boolean {
  if (!left || !right) return left === right;
  const a = left as unknown as Record<string, unknown>, b = right as unknown as Record<string, unknown>;
  return ['kind', 'beforeExchangeSeq', 'beforeMessageSeq', 'beforeCreatedAt', 'beforeId',
    'afterExchangeSeq', 'afterMessageSeq', 'afterCreatedAt', 'afterId'].every(key => a[key] === b[key]);
}

/** Validate exact keyset boundaries without using them as Message placement evidence. */
function isCollaborationHistoryCursor(value: unknown, direction: 'before' | 'after'): value is ReliableKernelCollaborationHistoryCursor {
  if (!isRecord(value)) return false;
  const other = direction === 'before' ? 'after' : 'before';
  if (Object.keys(value).some(key => key.startsWith(other))) return false;
  if (value.kind === 'exchange') {
    const seq = value[`${direction}ExchangeSeq`];
    return Object.keys(value).every(key => key === 'kind' || key === `${direction}ExchangeSeq`)
      && (seq === undefined || Boolean(positiveDecimal(seq)));
  }
  if (value.kind === 'message') {
    const seq = value[`${direction}MessageSeq`], id = value[`${direction}Id`];
    return Object.keys(value).every(key => key === 'kind' || key === `${direction}MessageSeq` || key === `${direction}Id`)
      && ((seq === undefined && id === undefined) || Boolean(positiveDecimal(seq) && nonEmptyString(id)));
  }
  if (value.kind === 'answer') {
    const createdAt = value[`${direction}CreatedAt`], id = value[`${direction}Id`];
    return Object.keys(value).every(key => key === 'kind' || key === `${direction}CreatedAt` || key === `${direction}Id`)
      && ((createdAt === undefined && id === undefined) || Boolean(nonEmptyString(createdAt) && nonEmptyString(id)));
  }
  return false;
}

function isCollaborationHistoryPage(
  page: ReliableKernelCollaborationHistoryResultMessage['page'],
  previousCursor: ReliableKernelCollaborationHistoryCursor | null,
  direction: 'before' | 'after',
  conversationId: string
): boolean {
  if (!isRecord(page) || !isRecord(page.records)
    || typeof page.hasMoreBefore !== 'boolean' || typeof page.hasMoreAfter !== 'boolean'
    || typeof page.scanProgress !== 'boolean'
    || !Number.isSafeInteger(page.scannedRows) || page.scannedRows < 0 || page.scannedRows > 4096
    || !Number.isSafeInteger(page.responseBytes) || page.responseBytes < 0 || page.responseBytes > 524_288
    || (page.hasMoreBefore && page.nextBeforeCursor === undefined)
    || (page.hasMoreAfter && page.nextAfterCursor === undefined)
    || (page.nextBeforeCursor !== undefined && !isCollaborationHistoryCursor(page.nextBeforeCursor, 'before'))
    || (page.nextAfterCursor !== undefined && !isCollaborationHistoryCursor(page.nextAfterCursor, 'after'))) return false;
  const cursor = (previousCursor ?? { kind: 'exchange' }) as unknown as Record<string, unknown>;
  const next = (direction === 'before' ? page.nextBeforeCursor : page.nextAfterCursor) as unknown as Record<string, unknown> | undefined;
  if (next !== undefined) {
    const lane = { exchange: 0, message: 1, answer: 2 };
    const priorLane = lane[cursor.kind as keyof typeof lane], nextLane = lane[next.kind as keyof typeof lane];
    if (direction === 'before' ? nextLane < priorLane : nextLane > priorLane) return false;
    if (next.kind === cursor.kind) {
      const key = next.kind === 'exchange' ? `${direction}ExchangeSeq`
        : next.kind === 'message' ? `${direction}MessageSeq` : `${direction}CreatedAt`;
      const nextValue = next[key], priorValue = cursor[key];
      const hasMore = direction === 'before' ? page.hasMoreBefore : page.hasMoreAfter;
      if (hasMore && !nextValue) return false;
      if (nextValue && priorValue) {
        const primary = next.kind === 'answer' ? String(nextValue).localeCompare(String(priorValue))
          : compareIntegerStrings(String(nextValue), String(priorValue));
        const comparison = primary || String(next[`${direction}Id`] ?? '').localeCompare(String(cursor[`${direction}Id`] ?? ''));
        if (hasMore && (direction === 'before' ? comparison >= 0 : comparison <= 0)) return false;
      }
    }
  }
  for (const [type, rows] of Object.entries(page.records)) {
    if (!COLLABORATION_HISTORY_RECORD_TYPES.has(type) || !Array.isArray(rows)) return false;
    if (rows.some((row) => !isRecord(row) || !nonEmptyString(row.id))) return false;
    if (type === 'RuntimeDeliveryAnswerPresentation' && rows.some((row) => row.conversation_id !== conversationId)) return false;
  }
  const links = [...(page.records.RuntimeDeliveryTimelineLink ?? []), ...(page.records.CollaborationSendTimelineLink ?? [])];
  if (links.length > HISTORY_PAGE_LIMIT) return false;
  const seen = new Set<string>();
  for (const link of links) {
    const seq = positiveDecimal(link.exchange_seq);
    if (link.conversation_id !== conversationId || !seq || seen.has(seq)) return false;
    seen.add(seq);
    if (direction === 'before' && cursor.kind === 'exchange' && cursor.beforeExchangeSeq
      && BigInt(seq) >= BigInt(String(cursor.beforeExchangeSeq))) return false;
    // A selected retry can carry its older canonical acceptance as dependency closure. The
    // cursor advances the inspected event window, not that retained proof's older coordinate.
  }
  const rows = cursor.kind === 'message' ? page.records.CollaborationMessage ?? []
    : cursor.kind === 'answer' ? (page.records.RuntimeDelivery ?? []).filter(row => row.target_conversation_id === conversationId && row.history_inventory_item === true) : [];
  if (rows.length > HISTORY_PAGE_LIMIT) return false;
  for (const row of rows) {
    if (cursor.kind === 'message') {
      const seq = positiveDecimal(row.message_seq);
      if (!seq) return false;
      const boundary = cursor[`${direction}MessageSeq`], id = cursor[`${direction}Id`];
      if (boundary && id) {
        const comparison = compareIntegerStrings(seq, String(boundary)) || String(row.id).localeCompare(String(id));
        if (direction === 'before' ? comparison >= 0 : comparison <= 0) return false;
      }
    } else if (cursor.kind === 'answer') {
      const createdAt = nonEmptyString(row.created_at);
      if (!createdAt) return false;
      const boundary = cursor[`${direction}CreatedAt`], id = cursor[`${direction}Id`];
      if (boundary && id) {
        const comparison = createdAt.localeCompare(String(boundary)) || String(row.id).localeCompare(String(id));
        if (direction === 'before' ? comparison >= 0 : comparison <= 0) return false;
      }
    }
  }
  return true;
}

function clearHistoryRequestTimeout(requestId: string | null): void {
  if (!requestId) return;
  const timeout = historyRequestTimeouts.get(requestId);
  if (timeout !== undefined) clearTimeout(timeout);
  historyRequestTimeouts.delete(requestId);
}

function resetHistoryState(
  state: ReliableKernelFeedStoreState,
  conversationId: string | null
): void {
  clearHistoryRequestTimeout(state.historyRequestId);
  state.historyConversationId = conversationId;
  const releasedPages = state.historyPages;
  state.historyPages = [];
  state.historyCurrentPageId = null;
  releaseResidentDetails(state, releaseReliablePageMembers(state, releasedPages));
  state.historyNextAfterMessageSeq = null;
  state.historyNextAfterId = null;
  state.historyHasMoreAfter = false;
  state.historyNextBeforeMessageSeq = null;
  state.historyNextBeforeId = null;
  state.historyHasMore = false;
  state.historyLoading = false;
  state.historyError = null;
  state.historyRequestId = null;
  state.historyLoadedPages = 0;
  if (conversationId) seedHistoryCursorFromLiveRecords(state, conversationId);
}

function setHistoryCursorFromPage(state: ReliableKernelFeedStoreState, page: ReliableResidentHistoryPage): void {
  state.historyNextBeforeMessageSeq = page.before.messageSeq;
  state.historyNextBeforeId = page.before.id;
  state.historyHasMore = page.hasMoreBefore;
  state.historyNextAfterMessageSeq = page.after.messageSeq;
  state.historyNextAfterId = page.after.id;
  state.historyHasMoreAfter = page.hasMoreAfter;
}

/** Sealed identities retire without rebuilding any earlier Message content. */
function withoutCommittedTransientParts(transient: ReliableKernelTransientState, committed: MessageContent): ReliableKernelTransientState {
  const itemIds = new Set(committed.parts.flatMap(part => { const id = reliableOutputItemIdentity(part.outputItem); return id ? [id] : []; }));
  const callIds = new Set(committed.parts.flatMap(part => 'functionCall' in part && part.id ? [part.id] : []));
  const outputParts = transient.outputParts.filter(part => !itemIds.has(reliableOutputItemIdentity(part.outputItem) ?? '')
    && !(!part.outputItem && 'functionCall' in part && part.id && callIds.has(part.id)));
  if (outputParts.length === transient.outputParts.length) return transient;
  return { ...transient, outputParts,
    text: outputParts.flatMap(part => 'text' in part && !part.thought ? [part.text] : []).join(''),
    thought: outputParts.flatMap(part => 'text' in part && part.thought ? [part.text] : []).join(''),
    toolCalls: transient.toolCalls.filter(call => !itemIds.has(reliableOutputItemIdentity(call.outputItem) ?? '')
      && (call.outputItem || !callIds.has(call.callId ?? ''))) };
}

function releaseRetiredNativeHandoffs(state: ReliableKernelFeedStoreState): void {
  for (const [owner, keys] of Object.entries(state.detailOwnerKeys)) {
    if (!owner.startsWith('native-handoff:') || state.transientModelRequests[owner.slice('native-handoff:'.length)]) continue;
    delete state.detailOwnerKeys[owner];
    for (const key of keys) state.releasedDetailKeys[key] = true;
  }
  releaseUnownedDetailKeys(state);
}

/** Body references leave with the final resident owner; an open editor/card keeps its demand. */
function releaseResidentDetails(state: ReliableKernelFeedStoreState, released: readonly ReleasedReliableRecord[]): void {
  for (const { type, id, record } of released) {
    const add = (kind: ReliableKernelClientDetailKind, recordId: unknown = id): void => {
      const value = nonEmptyString(recordId);
      if (value) state.releasedDetailKeys[detailKey(kind, value)] = true;
    };
    switch (type) {
      case 'Message': {
        add('message-content', record.revision_id);
        const window = state.messageContentWindows[id];
        if (window) {
          delete state.messageContentWindows[id];
          delete state.detailOwnerKeys[`message-content-window:${id}`];
          for (const page of window.pages) {
            state.releasedDetailKeys[page.key] = true;
            for (const item of page.items) add('message-content-item', item.contentObjectId);
          }
          for (const [key, owner] of Object.entries(state.messageContentItemOwners)) if (owner === id) {
            delete state.messageContentItemOwners[key]; state.releasedDetailKeys[key] = true;
          }
        }
        break;
      }
      case 'MessageRevision': add('message-content'); break;
      case 'ToolCall': add('tool-arguments-content'); add('tool-result-content'); break;
      case 'ToolCallEvent': add('tool-event-content'); break;
      case 'InteractionRequest': add('interaction-prompt'); break;
      case 'FileChangeSetMember': add('file-change-base-content'); add('file-change-content'); add('file-change-diff'); break;
      case 'ModelRequest': {
        add('model-request-purpose');
        const owner = `native-handoff:${id}`;
        for (const key of state.detailOwnerKeys[owner] ?? []) state.releasedDetailKeys[key] = true;
        delete state.detailOwnerKeys[owner];
        break;
      }
      case 'CompressionBlock': add('compression-presentation'); add('compression-content'); add('compression-title'); break;
      case 'AnswerSubmission': add('answer-content'); break;
      case 'RuntimeDeliveryAnswerPresentation':
        add('accepted-answer-content'); delete state.acceptedAnswerPeerGenerations[id]; break;
      case 'Process': add('process-stdout'); add('process-stderr'); break;
      case 'ProcessOutputChunk': add('process-output'); break;
      case 'TurnIntent': add('turn-intent-preview'); break;
    }
  }
  releaseUnownedDetailKeys(state);
}

function releaseUnownedDetailKeys(state: ReliableKernelFeedStoreState): void {
  const pinned = new Set([...state.pinnedDetailKeys, ...Object.values(state.detailOwnerKeys).flat()]);
  for (const key of Object.keys(state.releasedDetailKeys)) {
    if (pinned.has(key)) continue;
    delete state.releasedDetailKeys[key];
    delete state.details[key];
    delete state.detailCacheMeta[key];
    clearDetailRetryTimer(key);
    for (const [requestId, pending] of Object.entries(state.pendingDetails)) {
      if (pending.key !== key) continue;
      const timeout = detailRequestTimeouts.get(requestId);
      if (timeout !== undefined) clearTimeout(timeout);
      detailRequestTimeouts.delete(requestId);
      detailDecoders.delete(requestId);
      detailTextChunks.delete(requestId);
      delete state.pendingDetails[requestId];
      state.activeDetailRequestIds = state.activeDetailRequestIds.filter(id => id !== requestId);
      state.detailQueue = state.detailQueue.filter(id => id !== requestId);
    }
  }
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
  state.historyNextAfterMessageSeq = null;
  state.historyNextAfterId = null;
  state.historyHasMoreAfter = false;
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
        case 'RuntimeDeliveryAnswerPresentation':
          add('accepted-answer-content');
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
  'RuntimeDelivery', 'RuntimeDeliveryTimelineLink', 'RuntimeDeliveryAnswerPresentation', 'CollaborationSendTimelineLink',
  'RuntimeInboxItem', 'AnswerSubmission', 'AnswerBridge', 'ChildExecution', 'ChildExecutionParentLink',
  'Turn', 'CollaborationPeerConversation'
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
  const pinned = new Set([...state.pinnedDetailKeys, ...Object.values(state.detailOwnerKeys).flat()]);
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

function detailKey(kind: ReliableKernelClientDetailKind, recordId: string, options: { itemAfterSequence?: number } = {}): string {
  return kind === 'message-content-items' ? reliableMessageContentItemsKey(recordId, options.itemAfterSequence) : `${kind}:${recordId}`;
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
