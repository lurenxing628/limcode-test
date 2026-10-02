import { computed, type ComputedRef } from 'vue';
import {
  projectReliableConversation,
  reliableActiveConversationId,
  type ReliableClientRecordBuckets,
  type ReliableConversationProjection
} from '@webview/domain/reliableConversationProjection';
import {
  useReliableKernelClientFeedStore,
  type ReliableKernelDetailPriority
} from '@webview/stores/useReliableKernelClientFeedStore';
import { steeringReceiptsByConversationState } from '@webview/composables/steeringReceipts';

export interface ReliableDetailDemand {
  /** Timeline rows currently mounted (or about to enter the viewport). */
  messageIds?: readonly string[];
  /** Tool cards explicitly expanded/opened outside the timeline. */
  toolCallIds?: readonly string[];
  priority?: ReliableKernelDetailPriority;
  /** Pending mandatory interactions are always critical unless explicitly disabled. */
  includePendingInteractions?: boolean;
}

interface SharedReliableConversation {
  feed: ReturnType<typeof useReliableKernelClientFeedStore>;
  conversationId: ComputedRef<string>;
  projection: ComputedRef<ReliableConversationProjection>;
  ensureDetails(demand?: ReliableDetailDemand): void;
}

const sharedByFeed = new WeakMap<object, SharedReliableConversation>();

/**
 * One shared projection per Pinia feed instance. Previously every card/composer/panel created its
 * own full computed scan, turning N mounted cards into N whole-conversation projections.
 */
export function useReliableConversation(): SharedReliableConversation {
  const feed = useReliableKernelClientFeedStore();
  const cached = sharedByFeed.get(feed);
  if (cached) return cached;

  const conversationId = computed(() => reliableActiveConversationId(feed.projections));
  const records = computed(() => mergeReliableRecordBuckets(
    feed.historyConversationId === conversationId.value
      ? feed.historyRecords as unknown as ReliableClientRecordBuckets
      : {},
    feed.records as unknown as ReliableClientRecordBuckets
  ));
  const projection = computed(() => projectReliableConversation({
    conversationId: conversationId.value,
    records: records.value,
    details: feed.details,
    transientModelRequests: feed.transientModelRequests,
    lastCommitSeq: feed.lastCommitSeq,
    lastSnapshotCommitSeq: feed.lastSnapshotCommitSeq,
    steeringReceipts: Object.values(steeringReceiptsByConversationState().value[conversationId.value] ?? {})
  }));

  function ensureDetails(demand: ReliableDetailDemand = {}): void {
    const current = projection.value;
    const priority = demand.priority ?? 'visible';
    const messageIds = new Set(demand.messageIds ?? []);
    const explicitlyDemandedCallIds = new Set(demand.toolCallIds ?? []);
    const toolCallIds = new Set(explicitlyDemandedCallIds);
    for (const messageId of messageIds) {
      for (const call of current.toolCallsByMessageId[messageId] ?? []) toolCallIds.add(call.id);
      const revisionId = current.messageRevisionIdByMessageId[messageId];
      if (revisionId) feed.requestDetail('message-content', revisionId, { priority });
    }

    const criticalCallIds = new Set<string>();
    if (demand.includePendingInteractions !== false) {
      for (const [toolCallId, interaction] of Object.entries(current.interactionByToolCallId)) {
        if (interaction.status !== 'pending') continue;
        criticalCallIds.add(toolCallId);
        toolCallIds.add(toolCallId);
      }
    }

    for (const toolCallId of toolCallIds) {
      const callPriority: ReliableKernelDetailPriority = criticalCallIds.has(toolCallId) ? 'critical' : priority;
      const hydrateBody = criticalCallIds.has(toolCallId) || explicitlyDemandedCallIds.has(toolCallId);
      const promptId = current.interactionPromptIdByToolCallId[toolCallId];
      if (promptId && current.missingInteractionPromptIds.includes(promptId)) {
        feed.requestDetail('interaction-prompt', promptId, { priority: callPriority });
      }
      if (hydrateBody) {
        if (current.missingToolArgumentIds.includes(toolCallId)) {
          feed.requestDetail('tool-arguments-content', toolCallId, { priority: callPriority });
        }
        if (current.missingToolResultIds.includes(toolCallId)) {
          feed.requestDetail('tool-result-content', toolCallId, { priority: callPriority });
        }
      }
      for (const eventId of current.toolEventIdsByCallId[toolCallId] ?? []) {
        if (current.missingToolEventIds.includes(eventId)) {
          feed.requestDetail('tool-event-content', eventId, { priority: callPriority });
        }
      }
      for (const memberId of hydrateBody ? current.fileDiffMemberIdsByToolCallId[toolCallId] ?? [] : []) {
        if (current.missingFileDiffMemberIds.includes(memberId)) {
          feed.requestDetail('file-change-diff', memberId, { priority: callPriority });
        }
      }
    }
  }

  const shared = { feed, conversationId, projection, ensureDetails };
  sharedByFeed.set(feed, shared);
  return shared;
}

/** Historical pages are immutable prefixes; the bounded live feed remains authoritative on overlap. */
function mergeReliableRecordBuckets(
  history: ReliableClientRecordBuckets,
  live: ReliableClientRecordBuckets
): ReliableClientRecordBuckets {
  const merged: ReliableClientRecordBuckets = {};
  for (const [type, bucket] of Object.entries(history)) merged[type] = { ...bucket };
  for (const [type, bucket] of Object.entries(live)) {
    merged[type] = { ...(merged[type] ?? {}), ...bucket };
  }
  return merged;
}
