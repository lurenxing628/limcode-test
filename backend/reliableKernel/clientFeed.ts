import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  RELIABLE_KERNEL_CHANGES_MESSAGE,
  RELIABLE_KERNEL_CLIENT_CHANGE_TYPES,
  RELIABLE_KERNEL_SNAPSHOT_MESSAGE,
  type ReliableKernelChangesMessage,
  type ReliableKernelClientChange,
  type ReliableKernelClientDetailKind,
  type ReliableKernelDataMessage,
  type ReliableKernelHistoryPage,
  type ReliableKernelRuntimeContinuationSource,
  type ReliableKernelRuntimeContinuationTurnIntentPreview,
  type ReliableKernelSnapshotMessage,
  type ReliableKernelTurnIntentPreview
} from '../../shared/reliableKernelClientFeed';
import type { PlainData } from '../../shared/plainData';
import { buildFileDiffRecord } from '../capabilities/fileDiff';
import {
  initialGuidancePosition,
  parseInputTurnIntentEnvelopeText,
  parseRuntimeContinuationTurnIntentEnvelopeText,
  TURN_INTENT_ENVELOPE_CONTENT_TYPE,
  type RuntimeContinuationTurnIntentEnvelope
} from './guidanceIntent';
import {
  CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE,
  CLIENT_CHANGE_BATCH_MAX_BYTES,
  CLIENT_CHANGE_BATCH_MAX_RECORDS,
  CLIENT_DETAIL_MAX_RESPONSE_BYTES,
  CLIENT_MAX_INFLIGHT_DATA_MESSAGES,
  CLIENT_MAX_QUEUED_BATCHES,
  CLIENT_MAX_QUEUED_BYTES,
  CLIENT_MESSAGE_WINDOW_LIMIT,
  CLIENT_PAGE_MAX_BYTES,
  CLIENT_PAGE_MAX_ROWS,
  CLIENT_SNAPSHOT_MAX_BYTES
} from './clientFeedBounds';
import {
  boundClientRecordSummary as boundRecord,
  clientWireBytes as wireBytes,
  settleClientWireResponseBytes,
  toClientWirePlain as toWirePlain
} from './clientWireData';
import type {
  ClientKeysetPageInput,
  ClientKeysetPageResult,
  ClientProjectionSnapshot,
  ClientVisibleMessageHistoryPageInput
} from './databaseWorkerProtocol';
import {
  ContentAddressedStore,
  type ContentObjectMetadata
} from './contentAddressedStore';
import type { RuntimeChange, RuntimeCommitResult } from './contracts';
import { requirePhaseFId, requirePhaseFText } from './phaseFIdentity';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';
import {
  RUNTIME_DOMAIN_SCHEMA_BY_KEY,
  RUNTIME_DOMAIN_SCHEMA_BY_TABLE
} from './schema/domainManifest';

export interface ClientFeedSessionView {
  sessionId: string;
  hostBootId: string;
  nextMessageSeq: string;
  inflightMessageSeq: string | null;
  lastAckedCommitSeq: string | null;
  snapshotRequired: boolean;
  queuedBatches: number;
  queuedBytes: number;
  activeRecordKeyCount: number;
  materializedRecordCount: number;
  maxMaterializedRecordsPerType: number;
  latestMessageSeq: string;
  latestVisibleMessageFloor: string;
}

export interface ClientFeedConnection {
  sessionId: string;
  hostBootId: string;
}

interface QueuedDataMessage {
  message: ReliableKernelDataMessage;
  bytes: number;
  commitSeq: string;
}

interface PendingChangesBatch {
  commitSeq: string;
  changes: ReliableKernelClientChange[];
  bytes: number;
}

type ClientScopedRuntimeChange = RuntimeChange & {
  removalCause?: 'window-eviction';
};

interface ClientFeedSession {
  sessionId: string;
  hostBootId: string;
  activeConversationId: string | null;
  nextMessageSeq: bigint;
  inflight: QueuedDataMessage | null;
  lastAckedCommitSeq: string | null;
  snapshotRequired: boolean;
  snapshotRequestGeneration: number;
  queue: PendingChangesBatch[];
  queuedBytes: number;
  send(message: ReliableKernelDataMessage): void;
  onFailure?: (error: unknown) => void;
  unsubscribe: (() => void) | null;
  initializing: boolean;
  refreshing: boolean;
  collectingRefresh: boolean;
  handoffCommits: RuntimeCommitResult[];
  /** Typed (domain,id) identities reachable from the active conversation projection. */
  activeRecordKeys: Set<string>;
  activeRecordKeyRefCounts: Map<string, number>;
  materializedRecordKeys: Set<string>;
  materializedRecords: Map<string, Record<string, unknown>>;
  materializedRecordReferences: Map<string, Set<string>>;
  materializedRecordTemporal: Map<string, string>;
  activeRecordCounts: Map<string, number>;
  latestMessageSeq: bigint;
  latestVisibleMessageFloor: bigint;
  messageDisplayFloors: Map<string, bigint>;
  navigationConversationIds: Set<string>;
  /** Primary active-conversation rows, kept distinct from child-summary rows of the same domain. */
  primaryTurnIds: Set<string>;
  visibleMessageIds: Set<string>;
  projectedToolCallIds: Set<string>;
  currentTaskSourceMessageId: string | null;
  closed: boolean;
}

export class UnknownClientSessionError extends Error {
  public readonly code = 'unknown-session';

  public constructor(sessionId: string) {
    super(`Unknown bounded client feed session: ${sessionId}`);
    this.name = 'UnknownClientSessionError';
  }
}

/** Memory-only, one-inflight bounded Extension Host feed. */
export class BoundedClientFeed {
  private readonly sessions = new Map<string, ClientFeedSession>();
  private readonly sharedSnapshotReads = new Map<string, Promise<Awaited<ReturnType<RuntimeDatabase['clientProjectionSnapshot']>>>>();
  private externalDataVersion: string | null = null;
  private externalPollTimer: NodeJS.Timeout | null = null;
  private externalPollInitialization: Promise<void> | null = null;
  private externalPollInFlight = false;

  public constructor(private readonly database: RuntimeDatabase) {
    if (CLIENT_MAX_INFLIGHT_DATA_MESSAGES !== 1) {
      throw new Error('BoundedClientFeed implementation requires maxInflightDataMessages=1.');
    }
  }

  public async connect(input: {
    activeConversationId?: string | null;
    send(message: ReliableKernelDataMessage): void;
    /** Called after an already-connected asynchronous feed session becomes unusable. */
    onFailure?(error: unknown): void;
  }): Promise<ClientFeedConnection> {
    if (typeof input.send !== 'function') throw new TypeError('Client feed send callback is required.');
    const activeConversationId = input.activeConversationId === undefined || input.activeConversationId === null
      ? null
      : requirePhaseFId(input.activeConversationId, 'activeConversationId');
    const session: ClientFeedSession = {
      sessionId: randomUUID(),
      hostBootId: this.database.hostBootId,
      activeConversationId,
      nextMessageSeq: 1n,
      inflight: null,
      lastAckedCommitSeq: null,
      snapshotRequired: false,
      snapshotRequestGeneration: 0,
      queue: [],
      queuedBytes: 0,
      send: input.send,
      onFailure: input.onFailure,
      unsubscribe: null,
      initializing: true,
      refreshing: false,
      collectingRefresh: false,
      handoffCommits: [],
      activeRecordKeys: new Set<string>(),
      activeRecordKeyRefCounts: new Map<string, number>(),
      materializedRecordKeys: new Set<string>(),
      materializedRecords: new Map<string, Record<string, unknown>>(),
      materializedRecordReferences: new Map<string, Set<string>>(),
      materializedRecordTemporal: new Map<string, string>(),
      activeRecordCounts: new Map<string, number>(),
      latestMessageSeq: 0n,
      latestVisibleMessageFloor: 0n,
      messageDisplayFloors: new Map<string, bigint>(),
      navigationConversationIds: new Set<string>(),
      primaryTurnIds: new Set<string>(),
      visibleMessageIds: new Set<string>(),
      projectedToolCallIds: new Set<string>(),
      currentTaskSourceMessageId: null,
      closed: false
    };
    this.sessions.set(session.sessionId, session);
    try {
      // Establish the external-writer baseline before the initial snapshot. A commit racing after
      // this read is consequently discovered by the poller and cannot fall through the handoff.
      await this.ensureExternalCommitPolling();
      const subscription = await this.database.clientProjectionSnapshotAndSubscribe(
        activeConversationId,
        (commit) => this.onCommit(session, commit)
      );
      session.unsubscribe = subscription.unsubscribe;
      const snapshot = this.createSnapshotMessage(session, subscription.barrier.snapshotCommitSeq, subscription.barrier.snapshot);
      this.sendNow(session, snapshot, subscription.barrier.snapshotCommitSeq);
      session.initializing = false;
      const buffered = session.handoffCommits;
      session.handoffCommits = [];
      for (const commit of buffered) this.enqueueCommit(session, commit);
      return { sessionId: session.sessionId, hostBootId: session.hostBootId };
    } catch (error) {
      session.unsubscribe?.();
      this.sessions.delete(session.sessionId);
      this.stopExternalCommitPollingIfIdle();
      throw error;
    }
  }

  public acknowledge(input: {
    sessionId: string;
    hostBootId: string;
    messageSeq: string;
  }): void {
    const session = this.requireSession(input.sessionId);
    if (input.hostBootId !== session.hostBootId) throw new UnknownClientSessionError(input.sessionId);
    const messageSeq = requireDecimal(input.messageSeq, 'messageSeq');
    if (!session.inflight || session.inflight.message.messageSeq !== messageSeq) {
      throw new Error(`Client ACK ${messageSeq} does not match the one inflight data message.`);
    }
    session.lastAckedCommitSeq = session.inflight.commitSeq;
    session.inflight = null;
    if (session.snapshotRequired) {
      void this.refreshSnapshot(session).catch((error) => this.closeFailedSession(session, error));
      return;
    }
    this.flushNext(session);
  }

  public requestSnapshot(sessionIdInput: string, activeConversationId?: string | null): void {
    const session = this.requireSession(sessionIdInput);
    session.activeConversationId = activeConversationId === undefined || activeConversationId === null
      ? null
      : requirePhaseFId(activeConversationId, 'activeConversationId');
    this.enterSnapshotRequired(session);
  }

  public disconnect(sessionIdInput: string): void {
    const sessionId = requirePhaseFId(sessionIdInput, 'sessionId');
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.closed = true;
    session.unsubscribe?.();
    session.queue = [];
    session.queuedBytes = 0;
    session.inflight = null;
    this.sessions.delete(sessionId);
    this.stopExternalCommitPollingIfIdle();
  }

  public inspectSession(sessionIdInput: string): ClientFeedSessionView {
    const session = this.requireSession(sessionIdInput);
    return {
      sessionId: session.sessionId,
      hostBootId: session.hostBootId,
      nextMessageSeq: session.nextMessageSeq.toString(),
      inflightMessageSeq: session.inflight?.message.messageSeq ?? null,
      lastAckedCommitSeq: session.lastAckedCommitSeq,
      snapshotRequired: session.snapshotRequired,
      queuedBatches: session.queue.length,
      queuedBytes: session.queuedBytes,
      activeRecordKeyCount: session.activeRecordKeys.size,
      materializedRecordCount: session.materializedRecordKeys.size,
      maxMaterializedRecordsPerType: Math.max(0, ...session.activeRecordCounts.values()),
      latestMessageSeq: session.latestMessageSeq.toString(),
      latestVisibleMessageFloor: session.latestVisibleMessageFloor.toString()
    };
  }

  public close(): void {
    for (const session of [...this.sessions.values()]) this.disconnect(session.sessionId);
  }

  private onCommit(session: ClientFeedSession, commit: RuntimeCommitResult): void {
    const metricStartedAt = this.database.performanceMetrics ? performance.now() : undefined;
    try {
      if (session.closed) return;
      if (session.initializing || session.collectingRefresh) {
        session.handoffCommits.push(commit);
        return;
      }
      if (session.snapshotRequired) return;
      this.enqueueCommit(session, commit);
    } finally {
      if (metricStartedAt !== undefined) {
        this.database.recordPerformanceMetric({
          kind: 'client_feed.sync_listener',
          listenerKind: 'feed_projection',
          listenerCount: 1,
          durationMs: performance.now() - metricStartedAt
        });
      }
    }
  }

  private enqueueCommit(session: ClientFeedSession, commit: RuntimeCommitResult): void {
    if (session.closed || session.snapshotRequired) return;
    const scoped = this.scopeCommit(session, commit);
    if (scoped.requiresSnapshot) {
      this.enterSnapshotRequired(session);
      return;
    }
    // Database commitSeq is intentionally allowed to jump on the wire. Commits with no visible
    // records must not consume the one-inflight ACK channel or invalidate the Webview projection.
    if (scoped.changes.length === 0) return;
    const pending = this.createPendingChanges(session, commit.commitSeq, scoped.changes);
    if (
      pending.changes.length > CLIENT_CHANGE_BATCH_MAX_RECORDS
      || pending.bytes > CLIENT_CHANGE_BATCH_MAX_BYTES
    ) {
      this.enterSnapshotRequired(session);
      return;
    }
    if (!session.inflight && session.queue.length === 0 && !session.refreshing) {
      this.sendPendingNow(session, pending);
      return;
    }
    if (this.compactPendingQueue(session, pending)) return;
    if (
      session.queue.length + 1 > CLIENT_MAX_QUEUED_BATCHES
      || session.queuedBytes + pending.bytes > CLIENT_MAX_QUEUED_BYTES
    ) {
      this.enterSnapshotRequired(session);
      return;
    }
    session.queue.push(pending);
    session.queuedBytes += pending.bytes;
  }

  private enterSnapshotRequired(session: ClientFeedSession): void {
    if (session.closed) return;
    session.queue = [];
    session.queuedBytes = 0;
    session.snapshotRequired = true;
    session.snapshotRequestGeneration += 1;
    if (!session.inflight && !session.refreshing && !session.initializing) {
      void this.refreshSnapshot(session).catch((error) => this.closeFailedSession(session, error));
    }
  }

  private async refreshSnapshot(session: ClientFeedSession): Promise<void> {
    if (session.closed || session.refreshing || session.inflight) return;
    session.refreshing = true;
    session.collectingRefresh = true;
    session.handoffCommits = [];
    const refreshRequestGeneration = session.snapshotRequestGeneration;
    try {
      const barrier = await this.sharedProjectionSnapshot(session.activeConversationId);
      const visible = BigInt(barrier.snapshotCommitSeq);
      const buffered = session.handoffCommits.filter((commit) => BigInt(commit.commitSeq) > visible);
      session.handoffCommits = [];
      session.collectingRefresh = false;
      // An external commit may arrive while the read transaction is materializing this snapshot.
      // Preserve that later request so the ACK of this snapshot schedules one more refresh.
      session.snapshotRequired = session.snapshotRequestGeneration !== refreshRequestGeneration;
      const snapshot = this.createSnapshotMessage(session, barrier.snapshotCommitSeq, barrier.snapshot);
      this.sendNow(session, snapshot, barrier.snapshotCommitSeq);
      for (const commit of buffered) this.enqueueCommit(session, commit);
    } finally {
      session.collectingRefresh = false;
      session.refreshing = false;
    }
  }

  private flushNext(session: ClientFeedSession): void {
    if (session.closed || session.inflight || session.snapshotRequired || session.refreshing) return;
    const next = session.queue.shift();
    if (!next) return;
    session.queuedBytes -= next.bytes;
    this.sendPendingNow(session, next);
  }

  private sendPendingNow(session: ClientFeedSession, pending: PendingChangesBatch): void {
    const message = this.createChangesMessage(session, pending.commitSeq, pending.changes);
    this.sendQueuedNow(session, {
      message,
      bytes: wireBytes(message),
      commitSeq: pending.commitSeq
    });
  }

  private sendQueuedNow(session: ClientFeedSession, queued: QueuedDataMessage): void {
    if (session.inflight) throw new Error('Client feed attempted more than one inflight data message.');
    session.inflight = queued;
    session.send(queued.message);
  }

  private sendNow(
    session: ClientFeedSession,
    message: ReliableKernelDataMessage,
    commitSeq: string
  ): void {
    const queued: QueuedDataMessage = {
      message,
      bytes: wireBytes(message),
      commitSeq
    };
    this.sendQueuedNow(session, queued);
  }

  private createSnapshotMessage(
    session: ClientFeedSession,
    snapshotCommitSeq: string,
    projectionInput: ClientProjectionSnapshot
  ): ReliableKernelSnapshotMessage {
    const messageSeq = this.allocateMessageSeq(session);
    const projections = boundProjectionRecords(toWirePlain(projectionInput) as Record<string, PlainData>);
    const message: ReliableKernelSnapshotMessage = {
      type: RELIABLE_KERNEL_SNAPSHOT_MESSAGE,
      sessionId: session.sessionId,
      hostBootId: session.hostBootId,
      messageSeq,
      snapshotCommitSeq: requireDecimal(snapshotCommitSeq, 'snapshotCommitSeq'),
      projections
    };
    enforceSnapshotBounds(message);
    // Seed visibility from exactly what survived all byte/row bounds. Seeding before final
    // truncation leaves ghost identities that can admit unrelated incremental records.
    this.resetVisibleIdentities(session, message.projections);
    return message;
  }

  private createChangesMessage(
    session: ClientFeedSession,
    commitSeq: string,
    changes: ReliableKernelClientChange[]
  ): ReliableKernelChangesMessage {
    return {
      type: RELIABLE_KERNEL_CHANGES_MESSAGE,
      sessionId: session.sessionId,
      hostBootId: session.hostBootId,
      messageSeq: this.allocateMessageSeq(session),
      commitSeq: requireDecimal(commitSeq, 'commitSeq'),
      changes
    };
  }

  private createPendingChanges(
    session: ClientFeedSession,
    commitSeq: string,
    scopedChanges: ClientScopedRuntimeChange[]
  ): PendingChangesBatch {
    const changes = compactClientChanges(scopedChanges.map(toReliableClientChange));
    return pendingChangesBatch(session, commitSeq, changes);
  }

  /**
   * Slow renderers need the latest bounded projection delta, not every intermediate repaint of the
   * same records. Only unsent changes sharing the current ACK baseline are compacted; the inflight
   * frame remains byte-for-byte stable for retransmission.
   */
  private compactPendingQueue(session: ClientFeedSession, incoming: PendingChangesBatch): boolean {
    if (session.queue.length === 0) return false;
    const allChanges = compactClientChanges([
      ...session.queue.flatMap((batch) => batch.changes),
      ...incoming.changes
    ]);
    const compacted = pendingChangesBatch(session, incoming.commitSeq, allChanges);
    if (
      compacted.changes.length <= CLIENT_CHANGE_BATCH_MAX_RECORDS
      && compacted.bytes <= CLIENT_CHANGE_BATCH_MAX_BYTES
    ) {
      session.queue = [compacted];
      session.queuedBytes = compacted.bytes;
      return true;
    }

    const tail = session.queue[session.queue.length - 1];
    const tailChanges = compactClientChanges([...tail.changes, ...incoming.changes]);
    const compactedTail = pendingChangesBatch(session, incoming.commitSeq, tailChanges);
    if (
      compactedTail.changes.length > CLIENT_CHANGE_BATCH_MAX_RECORDS
      || compactedTail.bytes > CLIENT_CHANGE_BATCH_MAX_BYTES
    ) return false;
    session.queue[session.queue.length - 1] = compactedTail;
    session.queuedBytes += compactedTail.bytes - tail.bytes;
    return true;
  }

  private scopeCommit(
    session: ClientFeedSession,
    commit: RuntimeCommitResult
  ): { changes: ClientScopedRuntimeChange[]; requiresSnapshot: boolean } {
    const accepted: ClientScopedRuntimeChange[] = [];
    const evictions: ClientScopedRuntimeChange[] = [];
    const pending: RuntimeChange[] = [];
    let requiresSnapshot = false;
    let messageWindowAdvanced = false;
    let taskProjectionRefreshRequired = false;

    for (const change of commit.changes) {
      // These persisted facts retain their current-epoch detail/none client mappings. The database
      // worker emits only the derived ConversationContextStatus view for head mutations.
      if (
        change.domain === 'ContextSequenceRoot'
        || change.domain === 'ConversationContextHeadLink'
        || change.domain === 'ProcessOutputChunk'
      ) {
        continue;
      }
      if (change.domain === 'Conversation') {
        accepted.push(change);
        if (change.kind === 'remove') {
          session.navigationConversationIds.delete(change.id);
        } else if (!session.navigationConversationIds.has(change.id)) {
          if (session.navigationConversationIds.size >= CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE) requiresSnapshot = true;
          else session.navigationConversationIds.add(change.id);
        }
        continue;
      }
      if (change.kind === 'remove') {
        const key = recordKey(change.domain, change.id);
        if (change.domain === 'Message') requiresSnapshot = true;
        // Removing the independent relationship changes ProjectContext reachability; a bounded
        // snapshot atomically removes the now-unreferenced context instead of retaining an orphan.
        if (change.domain === 'ConversationProjectLink' && session.materializedRecordKeys.has(key)) {
          requiresSnapshot = true;
        }
        if (session.materializedRecordKeys.has(key)) {
          accepted.push(change);
          removeMaterializedRecord(session, key);
        }
        // Structural owner/link removal is replayed from one fresh causal snapshot. Ephemeral
        // leaves such as an ExecutionLease can still be removed in the atomic live batch.
        if (SNAPSHOT_ON_STRUCTURAL_REMOVE_DOMAINS.has(change.domain)) requiresSnapshot = true;
        continue;
      }
      pending.push(change);
    }

    let changed = true;
    while (changed && pending.length > 0) {
      changed = false;
      for (let index = 0; index < pending.length;) {
        const change = pending[index];
        let record = change.record;
        if (!record || !this.recordVisibleToSession(session, change.domain, change.id, record)) {
          index += 1;
          continue;
        }
        let acceptedChange = change;
        if (change.domain === 'Message') {
          const projected = attachMessageDisplayFloor(session, change.id, record);
          if (!projected) {
            requiresSnapshot = true;
            pending.splice(index, 1);
            changed = true;
            continue;
          }
          record = projected;
          acceptedChange = { ...change, record };
        }
        const ownKey = recordKey(change.domain, change.id);
        const wasKnown = session.materializedRecordKeys.has(ownKey);
        if (change.domain === 'Turn' && record.conversation_id === session.activeConversationId) {
          const previousStatus = session.materializedRecords.get(ownKey)?.status;
          if (previousStatus !== record.status && (previousStatus === 'active' || record.status === 'active')) {
            // The frozen work-environment summary is a snapshot-only projection. Refresh it
            // atomically when its active Turn appears or ends, including a child Conversation.
            requiresSnapshot = true;
          }
        }
        accepted.push(acceptedChange);
        pending.splice(index, 1);
        if (wasKnown) {
          forgetScopedProjectionIdentity(
            session,
            change.domain,
            change.id,
            session.materializedRecords.get(ownKey)
          );
          releaseMaterializedRecordReferences(session, ownKey);
        }
        session.materializedRecordKeys.add(ownKey);
        session.materializedRecords.set(ownKey, record);
        session.materializedRecordTemporal.set(ownKey, recordTemporalKey(change.domain, record, change.id));
        retainMaterializedRecordReferences(session, change.domain, change.id, record);
        rememberScopedProjectionIdentity(session, change.domain, change.id, record);
        if (
          change.domain === 'ToolOutcome'
          && record.status === 'succeeded'
        ) {
          const toolCallId = recordStringField(record, 'tool_call_id');
          const toolCall = toolCallId
            ? session.materializedRecords.get(recordKey('ToolCall', toolCallId))
            : undefined;
          if (toolCall?.tool_name === 'update_task_list' || toolCall?.tool_name === 'submit_plan') {
            taskProjectionRefreshRequired = true;
          }
        }
        if (!wasKnown) {
          if (change.domain === 'Message') messageWindowAdvanced = true;
          const count = incrementRecordCount(session.activeRecordCounts, change.domain);
          if (
            count > CLIENT_ACTIVE_RECORD_LIMIT_PER_TYPE
            && LIVE_SNAPSHOT_WINDOW_ROOT_DOMAINS.has(change.domain)
            && change.domain !== 'Message'
          ) {
            // Never evict a relationship-bearing root type independently. The snapshot builder
            // chooses temporal roots and returns their complete normalized dependency closure.
            requiresSnapshot = true;
          }
        }
        changed = true;
      }
    }

    if (taskProjectionRefreshRequired) requiresSnapshot = true;
    if (!requiresSnapshot && messageWindowAdvanced) {
      const rollover = evictMessagesOutsideLiveWindow(session);
      evictions.push(...rollover.changes);
      requiresSnapshot = rollover.requiresSnapshot;
    }

    const acceptedById = new Map(accepted.map((change) => [
      `${change.domain}\0${change.id}\0${change.kind}`,
      change
    ]));
    return {
      changes: [
        ...commit.changes.flatMap((change) => {
          const acceptedChange = acceptedById.get(`${change.domain}\0${change.id}\0${change.kind}`);
          return acceptedChange ? [acceptedChange] : [];
        }),
        ...evictions
      ],
      requiresSnapshot
    };
  }

  private recordVisibleToSession(
    session: ClientFeedSession,
    domain: string,
    id: string,
    record: Record<string, unknown>
  ): boolean {
    const ownKey = recordKey(domain, id);
    if (session.materializedRecordKeys.has(ownKey)) return true;
    const activeConversationId = session.activeConversationId;
    if (!activeConversationId) return false;
    const field = (key: string): string | undefined => {
      const value = record[key];
      return typeof value === 'string' && value ? value : undefined;
    };
    const materialized = (targetDomain: string, targetId: string | undefined): boolean =>
      Boolean(targetId && session.materializedRecordKeys.has(recordKey(targetDomain, targetId)));
    const referencedBy = (...sourceDomains: string[]): boolean =>
      hasMaterializedReferenceFrom(session, ownKey, sourceDomains);

    switch (domain) {
      case 'ProjectContext':
        return referencedBy('ConversationProjectLink');
      case 'ConversationProjectLink':
      case 'ConversationReuseLink':
      case 'ConversationCommandReceipt':
      case 'TurnIntent':
      case 'CompressionBlock':
      case 'ConversationContextStatus':
        return field('conversation_id') === activeConversationId;
      case 'ConversationBranchLink':
        return field('target_conversation_id') === activeConversationId
          || field('source_conversation_id') === activeConversationId;
      case 'ConversationOriginLink':
        return field('conversation_id') === activeConversationId
          || field('source_conversation_id') === activeConversationId;
      case 'AgentConversationLink': {
        const conversationId = field('conversation_id');
        return conversationId === activeConversationId
          || Boolean(conversationId && hasMaterializedReferenceFrom(
            session,
            recordKey('Conversation', conversationId),
            ['ChildExecution']
          ));
      }
      case 'Turn':
        return field('conversation_id') === activeConversationId
          || referencedBy('ChildExecutionTurnLink', 'ChildExecutionActiveTurnLink');
      case 'ExecutionLease':
      case 'TurnTermination':
      case 'TurnExecutorLink':
        return materialized('Turn', field('turn_id'));
      case 'Message':
        return field('conversation_id') === activeConversationId
          && record.deleted_at === null
          && (record.role === 'user' || record.role === 'model');
      // Message window rows already carry the exact current revision identity/metadata. Raw
      // revisions are detail authority and would otherwise accumulate beside evicted roots.
      case 'MessageRevision':
        return false;
      case 'MessageTurnLink': {
        const messageId = field('message_id');
        const turnId = field('turn_id');
        return Boolean(messageId && turnId
          && session.visibleMessageIds.has(messageId)
          && session.primaryTurnIds.has(turnId));
      }
      case 'ModelRequest': {
        const turnId = field('turn_id');
        return Boolean(turnId && session.primaryTurnIds.has(turnId));
      }
      case 'ModelContextProjection':
        return field('owner_kind') === 'model_request'
          && materialized('ModelRequest', field('owner_id'));
      case 'ModelRequestMessageLink': {
        const messageId = field('message_id');
        return materialized('ModelRequest', field('model_request_id'))
          && Boolean(messageId && session.visibleMessageIds.has(messageId));
      }
      case 'ToolCall': {
        const turnId = field('turn_id');
        return Boolean(turnId && session.primaryTurnIds.has(turnId));
      }
      case 'ToolCallSourceLink': {
        const toolCallId = field('tool_call_id');
        const messageId = field('message_id');
        return Boolean(toolCallId && messageId
          && session.projectedToolCallIds.has(toolCallId)
          && session.visibleMessageIds.has(messageId)
          && materialized('ModelRequest', field('model_request_id')));
      }
      case 'ToolCallPolicySnapshot':
      case 'ToolCallEvent':
      case 'ToolExecution':
      case 'ToolOutcome':
      case 'ToolModelResult':
      case 'ToolResultArtifact':
      case 'FileChangeSet': {
        const toolCallId = field('tool_call_id');
        return Boolean(toolCallId && session.projectedToolCallIds.has(toolCallId));
      }
      case 'FileChangeSetMember':
      case 'FileChangeDecision':
      case 'FileMutationReceipt':
        return materialized('FileChangeSet', field('change_set_id'));
      case 'FileMutationReceiptMember':
        return materialized('FileMutationReceipt', field('receipt_id'));
      case 'InteractionOwnerLink': {
        const turnId = field('turn_id');
        return Boolean(turnId && session.primaryTurnIds.has(turnId));
      }
      case 'InteractionToolCallLink': {
        const toolCallId = field('tool_call_id');
        return Boolean(toolCallId && session.projectedToolCallIds.has(toolCallId));
      }
      case 'InteractionRequest':
        return referencedBy('InteractionOwnerLink', 'InteractionToolCallLink');
      case 'InteractionResponse':
        return materialized('InteractionRequest', field('request_id'));
      case 'ProcessOriginLink': {
        const toolCallId = field('tool_call_id');
        return Boolean(toolCallId && session.projectedToolCallIds.has(toolCallId));
      }
      case 'Process':
        return referencedBy('ProcessOriginLink');
      case 'ProcessReceipt':
        return materialized('Process', field('process_id'));
      case 'ChildExecutionParentLink': {
        const toolCallId = field('source_tool_call_id');
        return Boolean(
          (toolCallId && session.projectedToolCallIds.has(toolCallId))
          || materialized('ChildExecution', field('child_execution_id'))
        );
      }
      case 'ChildExecution':
        return field('child_conversation_id') === activeConversationId
          || referencedBy('ChildExecutionParentLink');
      case 'ChildExecutionTurnLink':
      case 'ChildExecutionActiveTurnLink':
        return materialized('ChildExecution', field('child_execution_id'));
      case 'ChildExecutionActivity':
        return materialized('ChildExecution', field('child_execution_id'));
      case 'AnswerBridge':
        return materialized('ChildExecution', field('child_execution_id'));
      case 'AnswerSubmission':
        return materialized('AnswerBridge', field('answer_bridge_id'));
      case 'CollaborationMessageSourceLink':
      case 'CollaborationMessageTargetLink':
        return field('conversation_id') === activeConversationId
          || materialized('CollaborationMessage', field('message_id'));
      case 'CollaborationMessage':
        return referencedBy('CollaborationMessageSourceLink', 'CollaborationMessageTargetLink');
      case 'CollaborationMessageReplyLink':
      case 'CollaborationRequest':
        return materialized('CollaborationMessage', field('message_id'));
      case 'CollaborationRequestTurnLink':
        return materialized('CollaborationRequest', field('request_id'));
      case 'RuntimeDelivery':
        return field('target_conversation_id') === activeConversationId;
      case 'RuntimeDeliveryIntentLink':
        return materialized('RuntimeDelivery', field('delivery_id'))
          && materialized('TurnIntent', field('turn_intent_id'));
      case 'RuntimeInboxItem':
        return referencedBy('RuntimeDelivery');
      default:
        return false;
    }
  }

  private resetVisibleIdentities(
    session: ClientFeedSession,
    projections: Record<string, PlainData>
  ): void {
    session.activeRecordKeys.clear();
    session.activeRecordKeyRefCounts.clear();
    session.materializedRecordKeys.clear();
    session.materializedRecords.clear();
    session.materializedRecordReferences.clear();
    session.materializedRecordTemporal.clear();
    session.activeRecordCounts.clear();
    session.latestMessageSeq = 0n;
    session.latestVisibleMessageFloor = 0n;
    session.messageDisplayFloors.clear();
    session.navigationConversationIds.clear();
    session.primaryTurnIds.clear();
    session.visibleMessageIds.clear();
    session.projectedToolCallIds.clear();
    session.currentTaskSourceMessageId = null;
    const navigation = projections.navigationSummary;
    if (isPlainRecord(navigation) && Array.isArray(navigation.conversations)) {
      for (const conversation of navigation.conversations) {
        if (!isPlainRecord(conversation)) continue;
        const id = conversation.id;
        if (typeof id === 'string' && id) session.navigationConversationIds.add(id);
      }
    }
    const countedRecords = new Set<string>();
    for (const [key, value] of Object.entries(projections)) {
      if (key === 'navigationSummary') continue;
      collectProjectionRecordKeys(
        value,
        session.activeRecordKeys,
        session.activeRecordKeyRefCounts,
        session.materializedRecords,
        session.materializedRecordReferences,
        session.activeRecordCounts,
        countedRecords,
        session.materializedRecordTemporal
      );
    }
    for (const key of countedRecords) session.materializedRecordKeys.add(key);
    const activeWindow = projections.activeConversationWindow;
    if (isPlainRecord(activeWindow)) {
      session.latestMessageSeq = plainNonNegativeBigInt(activeWindow.lastMessageSeq);
      session.latestVisibleMessageFloor = plainNonNegativeBigInt(activeWindow.visibleMessageCount);
      if (Array.isArray(activeWindow.messages)) {
        for (const message of activeWindow.messages) {
          if (!isPlainRecord(message) || typeof message.id !== 'string') continue;
          session.visibleMessageIds.add(message.id);
          const displayFloor = plainNonNegativeBigInt(message.display_seq);
          if (displayFloor > 0n) session.messageDisplayFloors.set(message.id, displayFloor);
        }
      }
      if (isPlainRecord(activeWindow.currentTaskList)) {
        const sourceMessageId = activeWindow.currentTaskList.sourceMessageId;
        if (typeof sourceMessageId === 'string' && sourceMessageId) {
          session.currentTaskSourceMessageId = sourceMessageId;
        }
      }
    }
    seedScopedProjectionIdentities(session, projections);
  }

  private allocateMessageSeq(session: ClientFeedSession): string {
    const value = session.nextMessageSeq;
    session.nextMessageSeq += 1n;
    return value.toString();
  }

  private requireSession(sessionIdInput: string): ClientFeedSession {
    const sessionId = requirePhaseFId(sessionIdInput, 'sessionId');
    const session = this.sessions.get(sessionId);
    if (!session || session.closed) throw new UnknownClientSessionError(sessionId);
    return session;
  }

  private closeFailedSession(session: ClientFeedSession, error: unknown): void {
    if (session.closed) return;
    this.disconnect(session.sessionId);
    // An asynchronous refresh cannot reject the already-resolved connect() promise. Notify its
    // bridge explicitly after closing the unusable session so the bridge can enter its bounded
    // reconnect loop instead of retaining a dead session forever.
    console.error(`[LimCode] Bounded client feed session ${session.sessionId} closed after failure.`, error);
    try {
      session.onFailure?.(error);
    } catch (notificationError) {
      console.error(`[LimCode] Bounded client feed failure notification for ${session.sessionId} failed.`, notificationError);
    }
  }

  private sharedProjectionSnapshot(
    activeConversationId: string | null
  ): Promise<Awaited<ReturnType<RuntimeDatabase['clientProjectionSnapshot']>>> {
    const key = activeConversationId ?? '\0navigation-only';
    const existing = this.sharedSnapshotReads.get(key);
    if (existing) return existing;
    const read = this.database.clientProjectionSnapshot(activeConversationId);
    this.sharedSnapshotReads.set(key, read);
    void read.finally(() => {
      if (this.sharedSnapshotReads.get(key) === read) this.sharedSnapshotReads.delete(key);
    }).catch(() => undefined);
    return read;
  }

  private async ensureExternalCommitPolling(): Promise<void> {
    if (this.externalPollTimer) return;
    if (!this.externalPollInitialization) {
      this.externalPollInitialization = (async () => {
        this.externalDataVersion = await this.database.externalDataVersion();
        if (this.sessions.size === 0 || this.externalPollTimer) return;
        this.externalPollTimer = setInterval(() => {
          void this.pollExternalCommits();
        }, 1_000);
        this.externalPollTimer.unref();
      })().finally(() => {
        this.externalPollInitialization = null;
      });
    }
    await this.externalPollInitialization;
  }

  private async pollExternalCommits(): Promise<void> {
    if (this.externalPollInFlight || this.sessions.size === 0) return;
    this.externalPollInFlight = true;
    try {
      const nextVersion = await this.database.externalDataVersion();
      if (this.externalDataVersion === null) {
        this.externalDataVersion = nextVersion;
        return;
      }
      if (nextVersion === this.externalDataVersion) return;
      this.externalDataVersion = nextVersion;
      for (const session of this.sessions.values()) this.enterSnapshotRequired(session);
    } catch (error) {
      for (const session of [...this.sessions.values()]) this.closeFailedSession(session, error);
    } finally {
      this.externalPollInFlight = false;
    }
  }

  private stopExternalCommitPollingIfIdle(): void {
    if (this.sessions.size > 0) return;
    if (this.externalPollTimer) clearInterval(this.externalPollTimer);
    this.externalPollTimer = null;
    this.externalDataVersion = null;
  }
}

function toReliableClientChange(change: ClientScopedRuntimeChange): ReliableKernelClientChange {
  if (!RELIABLE_KERNEL_CLIENT_CHANGE_TYPES.has(change.domain as never)) {
    throw new Error(`Committed client change uses unknown domain ${change.domain}.`);
  }
  if (change.kind === 'remove') {
    return {
      type: change.domain,
      operation: 'remove',
      id: change.id,
      ...(change.removalCause ? { removalCause: change.removalCause } : {})
    };
  }
  if (!change.record) throw new Error(`Committed client upsert ${change.domain}/${change.id} has no record projection.`);
  const record = boundRecord(toWirePlain(change.record) as Record<string, PlainData>);
  if (record.id !== change.id) throw new Error('Committed client upsert record identity mismatch.');
  return { type: change.domain, operation: 'upsert', id: change.id, record };
}

/** Last writer wins while the first occurrence retains repository/topological ordering. */
function compactClientChanges(changes: readonly ReliableKernelClientChange[]): ReliableKernelClientChange[] {
  const compacted = new Map<string, ReliableKernelClientChange>();
  for (const change of changes) compacted.set(`${change.type}\0${change.id}`, change);
  return [...compacted.values()];
}

function pendingChangesBatch(
  session: ClientFeedSession,
  commitSeqInput: string,
  changes: ReliableKernelClientChange[]
): PendingChangesBatch {
  const commitSeq = requireDecimal(commitSeqInput, 'commitSeq');
  const bytes = wireBytes({
    type: RELIABLE_KERNEL_CHANGES_MESSAGE,
    sessionId: session.sessionId,
    hostBootId: session.hostBootId,
    // Unsent batches have no transport sequence. Reserve every sequence digit reachable while the
    // bounded queue drains, without consuming a sequence that the Webview could observe as a gap.
    messageSeq: (session.nextMessageSeq + BigInt(CLIENT_MAX_QUEUED_BATCHES + 1)).toString(),
    commitSeq,
    changes
  });
  return { commitSeq, changes, bytes };
}

/** Fixed keyset pagination facade; offset and mutable sort keys are not accepted. */
export class ClientHistoryReader {
  public constructor(private readonly database: RuntimeDatabase) {}

  public async page(input: ClientKeysetPageInput): Promise<ClientKeysetPageResult> {
    if ('offset' in (input as unknown as Record<string, unknown>)) {
      throw new TypeError('Offset pagination is forbidden.');
    }
    const result = await this.database.clientKeysetPage(input);
    if (result.rows.length > CLIENT_PAGE_MAX_ROWS || result.responseBytes > CLIENT_PAGE_MAX_BYTES) {
      throw new Error('Database worker returned an out-of-bounds keyset page.');
    }
    return toWirePlain(result) as unknown as ClientKeysetPageResult;
  }

  public async backwardVisibleMessages(
    input: ClientVisibleMessageHistoryPageInput
  ): Promise<ReliableKernelHistoryPage> {
    if ('offset' in (input as unknown as Record<string, unknown>)) {
      throw new TypeError('Offset pagination is forbidden.');
    }
    const result = await this.database.clientVisibleMessageHistoryPage(input);
    if (
      (result.records.Message?.length ?? 0) > CLIENT_PAGE_MAX_ROWS
      || result.responseBytes > CLIENT_PAGE_MAX_BYTES
    ) {
      throw new Error('Database worker returned an out-of-bounds visible Message history page.');
    }
    const records: ReliableKernelHistoryPage['records'] = {};
    for (const [domain, rows] of Object.entries(result.records)) {
      records[domain] = rows.map((row) => boundRecord(
        toWirePlain(row) as Record<string, PlainData>
      ));
    }
    const page: ReliableKernelHistoryPage = {
      records,
      ...(result.nextBeforeMessageSeq === undefined
        ? {}
        : { nextBeforeMessageSeq: result.nextBeforeMessageSeq }),
      ...(result.nextBeforeId === undefined ? {} : { nextBeforeId: result.nextBeforeId }),
      hasMore: result.hasMore,
      responseBytes: 0
    };
    settleClientWireResponseBytes(page);
    if (page.responseBytes > CLIENT_PAGE_MAX_BYTES) {
      throw new Error('Visible Message history page exceeds maxPageBytes after wire encoding.');
    }
    return page;
  }
}

export type ClientDetailKind = ReliableKernelClientDetailKind;

export interface ClientDetailChunk {
  recordId: string;
  offset: number;
  chunk: string;
  encoding: 'base64';
  nextOffset?: number;
  totalBytes: number;
  hasMore: boolean;
  responseBytes: number;
}

interface ProcessStreamChunkIndexEntry {
  row: DomainRow;
  offset: number;
  byteLength: number;
}

interface ProcessOutputDetailIndex {
  retainedBytes: string;
  retainedChunks: string;
  stdout: ProcessStreamChunkIndexEntry[];
  stderr: ProcessStreamChunkIndexEntry[];
  stdoutBytes: number;
  stderrBytes: number;
  lastAccessedAt: number;
}

interface ProcessDetailReconciliation {
  retainedBytes: string;
  retainedChunks: string;
  stdout: Buffer;
  stderr: Buffer;
}

interface MessageContentMetadataWaiter {
  resolve(metadata: ContentObjectMetadata): void;
  reject(error: unknown): void;
}

const PROCESS_DETAIL_INDEX_CACHE_ENTRIES = 8;
const MESSAGE_CONTENT_METADATA_CACHE_ENTRIES = 1_024;
const TURN_INTENT_PREVIEW_TEXT_CHARACTERS = 512;
const TURN_INTENT_SOURCE_LABEL_CHARACTERS = 240;
const TURN_INTENT_SOURCE_ARGUMENTS_MAX_BYTES = 64 * 1024;

/** On-demand CAS detail reader with an actual wire-byte response cap. */
export class ClientDetailReader {
  /** Rebuildable chunk metadata only; output bytes remain in CAS and are read one requested page at a time. */
  private readonly processOutputIndexes = new Map<string, ProcessOutputDetailIndex>();
  private readonly processOutputReconciliations = new Map<string, Promise<ProcessDetailReconciliation>>();
  /** MessageRevision and ContentObject are immutable, so continuation pages and revisits can reuse them. */
  private readonly messageContentMetadata = new Map<string, ContentObjectMetadata>();
  private readonly pendingMessageContentMetadata = new Map<string, MessageContentMetadataWaiter[]>();
  private messageContentMetadataFlushScheduled = false;
  private reconcileProcessOutput: ((processId: string) => Promise<ProcessDetailReconciliation>) | undefined;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore
  ) {}

  /** Product composition supplies the verified spool importer after ProcessControlPlane exists. */
  public setProcessOutputReconciler(
    reconcile: (processId: string) => Promise<ProcessDetailReconciliation>
  ): void {
    this.reconcileProcessOutput = reconcile;
  }

  public async read(input: {
    kind: ClientDetailKind;
    recordId: string;
    offset: number;
    maxBytes: number;
    expectedTotalBytes?: number;
    /** Webview transport scope. Undefined is reserved for trusted in-process callers. */
    conversationId?: string | null;
  }): Promise<ClientDetailChunk> {
    const recordId = requirePhaseFId(input.recordId, 'recordId');
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) throw new RangeError('Detail offset must be non-negative.');
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) throw new RangeError('Detail maxBytes must be positive.');
    const maxRawBytes = detailRawByteLimit(input.maxBytes);
    if (input.kind === 'process-stdout' || input.kind === 'process-stderr') {
      return this.readProcessStreamDetail(
        recordId,
        input.kind === 'process-stdout' ? 'stdout' : 'stderr',
        input.offset,
        maxRawBytes,
        input.conversationId,
        input.expectedTotalBytes
      );
    }
    if (
      input.kind === 'context-projection-detail'
      || input.kind === 'file-change-diff'
      || input.kind === 'turn-intent-preview'
      || input.kind === 'model-request-purpose'
      || input.kind === 'compression-presentation'
    ) {
      const bytes = input.kind === 'context-projection-detail'
        ? await this.materializeContextProjectionDetail(recordId)
        : input.kind === 'file-change-diff'
          ? await this.materializeFileChangeDiff(recordId)
          : input.kind === 'turn-intent-preview'
            ? await this.materializeTurnIntentPreview(recordId, input.conversationId)
            : input.kind === 'model-request-purpose'
              ? await this.materializeModelRequestPurpose(recordId, input.conversationId)
              : await this.materializeCompressionPresentation(recordId, input.conversationId);
      if (input.offset > bytes.length) throw new RangeError('Detail offset exceeds structural payload length.');
      const end = Math.min(bytes.length, input.offset + maxRawBytes);
      return buildDetailChunk(recordId, input.offset, bytes.subarray(input.offset, end), bytes.length);
    }
    const contentRow = input.kind === 'message-content'
      ? await this.loadMessageContentMetadata(recordId)
      : await this.resolveContentMetadata(input.kind, recordId, input.conversationId);
    const range = await this.contentStore.readChunk(contentRow, input.offset, maxRawBytes);
    return buildDetailChunk(recordId, input.offset, range.chunk, range.totalBytes);
  }

  private async resolveContentMetadata(
    kind: Exclude<
      ClientDetailKind,
      'message-content' | 'context-projection-detail' | 'file-change-diff' | 'turn-intent-preview' | 'model-request-purpose' | 'compression-presentation' | 'process-stdout' | 'process-stderr'
    >,
    recordId: string,
    conversationId?: string | null
  ): Promise<ContentObjectMetadata> {
    const contentObjectId = await this.resolveContentObjectId(kind, recordId, conversationId);
    return await this.requireExisting('ContentObject', contentObjectId) as ContentObjectMetadata;
  }

  private loadMessageContentMetadata(revisionId: string): Promise<ContentObjectMetadata> {
    const cached = this.messageContentMetadata.get(revisionId);
    if (cached) {
      this.messageContentMetadata.delete(revisionId);
      this.messageContentMetadata.set(revisionId, cached);
      return Promise.resolve(cached);
    }
    return new Promise<ContentObjectMetadata>((resolve, reject) => {
      const waiters = this.pendingMessageContentMetadata.get(revisionId) ?? [];
      waiters.push({ resolve, reject });
      this.pendingMessageContentMetadata.set(revisionId, waiters);
      if (this.messageContentMetadataFlushScheduled) return;
      this.messageContentMetadataFlushScheduled = true;
      // Webview postMessage deliveries and the four CAS completions are separate callbacks. Waiting
      // until the next timer phase lets one transport wave join one immutable metadata batch.
      setTimeout(() => void this.flushMessageContentMetadata(), 0);
    });
  }

  /**
   * Four Webview detail reads normally arrive in one turn. Resolve all revisions in one worker
   * snapshot and all distinct ContentObjects in a second snapshot, instead of two worker round
   * trips per message.
   */
  private async flushMessageContentMetadata(): Promise<void> {
    this.messageContentMetadataFlushScheduled = false;
    const batch = [...this.pendingMessageContentMetadata.entries()];
    this.pendingMessageContentMetadata.clear();
    if (batch.length === 0) return;
    const revisions = DOMAIN_REPOSITORIES.domain('MessageRevision');
    const contents = DOMAIN_REPOSITORIES.domain('ContentObject');
    try {
      const revisionBarrier = await this.database.snapshot(
        batch.map(([revisionId]) => revisions.get(revisionId))
      );
      if (revisionBarrier.snapshot.length !== batch.length) {
        throw new Error('Message detail metadata batch returned the wrong revision count.');
      }
      const contentIdByRevision = new Map<string, string>();
      batch.forEach(([revisionId], index) => {
        const row = revisionBarrier.snapshot[index];
        if (!row || Array.isArray(row)) return;
        contentIdByRevision.set(
          revisionId,
          requirePhaseFId(row.content_object_id, 'MessageRevision.content_object_id')
        );
      });
      const contentIds = [...new Set(contentIdByRevision.values())];
      const contentBarrier = contentIds.length > 0
        ? await this.database.snapshot(contentIds.map((contentId) => contents.get(contentId)))
        : { snapshot: [] as Array<DomainRow | DomainRow[] | null> };
      if (contentBarrier.snapshot.length !== contentIds.length) {
        throw new Error('Message detail metadata batch returned the wrong ContentObject count.');
      }
      const contentById = new Map<string, ContentObjectMetadata>();
      contentIds.forEach((contentId, index) => {
        const row = contentBarrier.snapshot[index];
        if (row && !Array.isArray(row)) contentById.set(contentId, row as ContentObjectMetadata);
      });
      for (const [revisionId, waiters] of batch) {
        const contentId = contentIdByRevision.get(revisionId);
        const metadata = contentId ? contentById.get(contentId) : undefined;
        if (!contentId) {
          const error = new Error(`MessageRevision ${revisionId} does not exist.`);
          for (const waiter of waiters) waiter.reject(error);
          continue;
        }
        if (!metadata) {
          const error = new Error(`ContentObject ${contentId} does not exist.`);
          for (const waiter of waiters) waiter.reject(error);
          continue;
        }
        this.rememberMessageContentMetadata(revisionId, metadata);
        for (const waiter of waiters) waiter.resolve(metadata);
      }
    } catch (error) {
      for (const [, waiters] of batch) {
        for (const waiter of waiters) waiter.reject(error);
      }
    }
  }

  private rememberMessageContentMetadata(revisionId: string, metadata: ContentObjectMetadata): void {
    this.messageContentMetadata.delete(revisionId);
    this.messageContentMetadata.set(revisionId, metadata);
    while (this.messageContentMetadata.size > MESSAGE_CONTENT_METADATA_CACHE_ENTRIES) {
      const oldest = this.messageContentMetadata.keys().next().value as string | undefined;
      if (!oldest) break;
      this.messageContentMetadata.delete(oldest);
    }
  }

  private async readProcessStreamDetail(
    processId: string,
    streamKind: 'stdout' | 'stderr',
    offset: number,
    maxRawBytes: number,
    conversationId?: string | null,
    expectedTotalBytes?: number
  ): Promise<ClientDetailChunk> {
    if (conversationId !== undefined) await this.assertProcessVisible(processId, conversationId);
    // A new demand/refresh captures one verified CAS/live pairing. Continuation pages only need a
    // new pairing while their frozen prefix still extends beyond the now-durable CAS frontier.
    let liveSnapshot = expectedTotalBytes === undefined
      ? await this.reconcileProcessOutputForDetail(processId)
      : undefined;
    let index: ProcessOutputDetailIndex;
    for (;;) {
      const processRow = await this.requireExisting('Process', processId);
      index = await this.processOutputIndex(processId, processRow);
      const durableBytes = streamKind === 'stdout' ? index.stdoutBytes : index.stderrBytes;
      if (expectedTotalBytes !== undefined && expectedTotalBytes <= durableBytes) {
        liveSnapshot = undefined;
        break;
      }
      if (!liveSnapshot) {
        liveSnapshot = await this.reconcileProcessOutputForDetail(processId);
        continue;
      }
      if (
        liveSnapshot.retainedBytes !== index.retainedBytes
        || liveSnapshot.retainedChunks !== index.retainedChunks
      ) {
        liveSnapshot = await this.reconcileProcessOutputForDetail(processId);
        continue;
      }
      break;
    }
    const durableBytes = streamKind === 'stdout' ? index.stdoutBytes : index.stderrBytes;
    const liveBytes = liveSnapshot?.[streamKind] ?? Buffer.alloc(0);
    const currentTotalBytes = durableBytes + liveBytes.byteLength;
    if (!Number.isSafeInteger(currentTotalBytes)) {
      throw new RangeError('Process stream length exceeds the pageable detail protocol integer range.');
    }
    const renderableTotalBytes = expectedTotalBytes ?? currentTotalBytes - incompleteUtf8TailLength(
      await this.readProcessStreamRange(
        processId,
        index[streamKind],
        durableBytes,
        liveBytes,
        Math.max(0, currentTotalBytes - 4),
        Math.min(4, currentTotalBytes)
      )
    );
    if (
      !Number.isSafeInteger(renderableTotalBytes)
      || renderableTotalBytes < 0
      || renderableTotalBytes > currentTotalBytes
    ) throw new RangeError('Frozen process detail prefix is outside the verified stream.');
    const totalBytes = renderableTotalBytes;
    if (offset > totalBytes) throw new RangeError('Detail offset exceeds process stream length.');
    const bytes = await this.readProcessStreamRange(
      processId,
      index[streamKind],
      durableBytes,
      liveBytes,
      offset,
      Math.min(maxRawBytes, totalBytes - offset)
    );
    return buildDetailChunk(processId, offset, bytes, totalBytes);
  }

  private async readProcessStreamRange(
    processId: string,
    entries: readonly ProcessStreamChunkIndexEntry[],
    durableBytes: number,
    liveBytes: Buffer,
    offset: number,
    byteLength: number
  ): Promise<Buffer> {
    let cursor = offset;
    let remaining = byteLength;
    const parts: Buffer[] = [];
    let chunkIndex = firstChunkEndingAfter(entries, cursor);
    while (remaining > 0 && cursor < durableBytes && chunkIndex < entries.length) {
      const entry = entries[chunkIndex++]!;
      const localOffset = Math.max(0, cursor - entry.offset);
      const take = Math.min(entry.byteLength - localOffset, durableBytes - cursor, remaining);
      const metadata = await this.requireExisting(
        'ContentObject',
        requirePhaseFId(entry.row.content_object_id, 'ProcessOutputChunk.content_object_id')
      ) as ContentObjectMetadata;
      const range = await this.contentStore.readChunk(metadata, localOffset, take);
      if (range.totalBytes !== entry.byteLength || range.chunk.byteLength !== take) {
        throw new Error(`ProcessOutputChunk ${String(entry.row.id)} CAS range is incomplete.`);
      }
      parts.push(range.chunk);
      cursor += take;
      remaining -= take;
    }
    if (remaining > 0) {
      const liveOffset = cursor - durableBytes;
      const take = Math.min(Math.max(0, liveBytes.byteLength - liveOffset), remaining);
      if (take > 0) {
        parts.push(liveBytes.subarray(liveOffset, liveOffset + take));
        cursor += take;
        remaining -= take;
      }
    }
    if (remaining !== 0) {
      throw new Error(`Process ${processId} stream snapshot is not continuous.`);
    }
    return Buffer.concat(parts, byteLength);
  }

  private reconcileProcessOutputForDetail(processId: string): Promise<ProcessDetailReconciliation> {
    if (!this.reconcileProcessOutput) {
      throw new Error('Process detail reader is not connected to ProcessControlPlane.');
    }
    const existing = this.processOutputReconciliations.get(processId);
    if (existing) return existing;
    const task = Promise.resolve(this.reconcileProcessOutput(processId))
      .finally(() => {
        if (this.processOutputReconciliations.get(processId) === task) {
          this.processOutputReconciliations.delete(processId);
        }
      });
    this.processOutputReconciliations.set(processId, task);
    return task;
  }

  private async processOutputIndex(processId: string, processRow: DomainRow): Promise<ProcessOutputDetailIndex> {
    const retainedChunks = requireRuntimeNonNegativeBigInt(processRow.retained_chunks, 'Process.retained_chunks');
    const retainedBytes = requireRuntimeNonNegativeBigInt(processRow.retained_bytes, 'Process.retained_bytes');
    const cached = this.processOutputIndexes.get(processId);
    if (
      cached
      && cached.retainedChunks === retainedChunks.toString()
      && cached.retainedBytes === retainedBytes.toString()
    ) {
      cached.lastAccessedAt = Date.now();
      return cached;
    }
    const chunks = await this.database.snapshotAll(DOMAIN_REPOSITORIES.domain('ProcessOutputChunk').list({
      where: { process_id: processId },
      orderBy: { column: 'id', direction: 'asc' },
      limit: 1_000
    }));
    // Reconciliation publishes chunk rows in bounded transactions and advances Process counters as
    // its final fence. Rows beyond that fence belong to a later prefix and are not visible yet.
    const retainedChunkCount = runtimeNonNegativeSafeInteger(retainedChunks, 'Process.retained_chunks');
    const allRows = chunks.snapshot
      .sort((left, right) => compareRuntimeIntegers(left.chunk_seq, right.chunk_seq))
      .slice(0, retainedChunkCount);
    let allBytes = 0n;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: ProcessStreamChunkIndexEntry[] = [];
    const stderr: ProcessStreamChunkIndexEntry[] = [];
    for (let rowIndex = 0; rowIndex < allRows.length; rowIndex += 1) {
      const row = allRows[rowIndex]!;
      if (requireRuntimeNonNegativeBigInt(row.chunk_seq, 'ProcessOutputChunk.chunk_seq') !== BigInt(rowIndex + 1)) {
        throw new Error(`Process ${processId} output chunk sequence is not contiguous.`);
      }
      const byteLength = runtimeNonNegativeSafeInteger(row.byte_length, 'ProcessOutputChunk.byte_length');
      allBytes += BigInt(byteLength);
      if (row.stream_kind === 'stdout') {
        stdout.push({ row, offset: stdoutBytes, byteLength });
        stdoutBytes += byteLength;
      } else if (row.stream_kind === 'stderr') {
        stderr.push({ row, offset: stderrBytes, byteLength });
        stderrBytes += byteLength;
      } else {
        throw new Error(`ProcessOutputChunk ${String(row.id)} has an invalid stream kind.`);
      }
      if (!Number.isSafeInteger(stdoutBytes) || !Number.isSafeInteger(stderrBytes)) {
        throw new Error(`Process ${processId} stream length exceeds the pageable detail protocol integer range.`);
      }
    }
    if (allRows.length !== retainedChunkCount || allBytes !== retainedBytes) {
      throw new Error(`Process ${processId} output CAS materialization is not complete yet.`);
    }
    const built: ProcessOutputDetailIndex = {
      retainedBytes: retainedBytes.toString(),
      retainedChunks: retainedChunks.toString(),
      stdout,
      stderr,
      stdoutBytes,
      stderrBytes,
      lastAccessedAt: Date.now()
    };
    this.processOutputIndexes.delete(processId);
    this.processOutputIndexes.set(processId, built);
    if (this.processOutputIndexes.size > PROCESS_DETAIL_INDEX_CACHE_ENTRIES) {
      const oldest = [...this.processOutputIndexes.entries()]
        .filter(([candidateId]) => candidateId !== processId)
        .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt || left[0].localeCompare(right[0]))[0];
      if (oldest) this.processOutputIndexes.delete(oldest[0]);
    }
    return built;
  }

  private async assertProcessVisible(processId: string, conversationId: string | null): Promise<void> {
    const scopedConversationId = conversationId === null
      ? null
      : requirePhaseFId(conversationId, 'detail.conversationId');
    if (!scopedConversationId) throw new Error(`Process ${processId} is not visible without an active Conversation.`);
    const origins = await this.listRows('ProcessOriginLink', { process_id: processId }, 2);
    if (origins.length !== 1) throw new Error(`Process ${processId} does not have one visible origin.`);
    const call = await this.requireExisting(
      'ToolCall',
      requirePhaseFId(origins[0]!.tool_call_id, 'ProcessOriginLink.tool_call_id')
    );
    const turn = await this.requireExisting('Turn', requirePhaseFId(call.turn_id, 'ToolCall.turn_id'));
    if (turn.conversation_id !== scopedConversationId) {
      throw new Error(`Process ${processId} is not visible in the active Conversation.`);
    }
  }

  private async materializeContextProjectionDetail(recordId: string): Promise<Buffer> {
    const projection = await this.requireExisting('ModelContextProjection', recordId);
    const rootId = requirePhaseFId(projection.root_id, 'ModelContextProjection.root_id');
    const barrier = await this.database.materializeContext(rootId);
    const structural = toWirePlain({
      projection,
      snapshotCommitSeq: barrier.snapshotCommitSeq,
      root: barrier.snapshot.root,
      records: barrier.snapshot.records.map((record) => ({
        node: record.node,
        segment: record.segment,
        contentObject: {
          id: record.contentObject.id,
          content_type: record.contentObject.content_type,
          sha256: record.contentObject.sha256,
          byte_length: record.contentObject.byte_length
        },
        messageRole: record.messageRole
      }))
    });
    return Buffer.from(JSON.stringify(structural), 'utf8');
  }

  /**
   * Exposes only the small, non-secret request purpose needed by the timeline. The immutable
   * recipe may contain prompts and tool definitions, so it must never be returned to the Webview.
   */
  private async materializeModelRequestPurpose(
    recordId: string,
    conversationId?: string | null
  ): Promise<Buffer> {
    const request = await this.requireExisting('ModelRequest', recordId);
    if (conversationId !== undefined) {
      const scopedConversationId = conversationId === null
        ? null
        : requirePhaseFId(conversationId, 'detail.conversationId');
      const turn = await this.requireExisting(
        'Turn',
        requirePhaseFId(request.turn_id, 'ModelRequest.turn_id')
      );
      if (!scopedConversationId || turn.conversation_id !== scopedConversationId) {
        throw new Error(`ModelRequest ${recordId} is not visible in the active Conversation.`);
      }
    }
    const recipeObject = await this.requireExisting(
      'ContentObject',
      requirePhaseFId(request.recipe_object_id, 'ModelRequest.recipe_object_id')
    ) as ContentObjectMetadata;
    const recipeBytes = await this.contentStore.read(recipeObject);
    let parsed: unknown;
    try {
      parsed = JSON.parse(recipeBytes.toString('utf8')) as unknown;
    } catch {
      throw new Error(`ModelRequest ${recordId} recipe is not valid JSON.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`ModelRequest ${recordId} recipe must be a JSON object.`);
    }
    const recipe = parsed as Record<string, unknown>;
    if (recipe.kind !== 'reliable-context-compression') {
      return Buffer.from(JSON.stringify({ kind: 'model' }), 'utf8');
    }
    const trigger = recipe.trigger;
    const requestKind = recipe.requestKind;
    if (
      (trigger !== 'auto' && trigger !== 'manual')
      || (requestKind !== 'context_compression_pre' && requestKind !== 'context_compression_manual')
      || (trigger === 'auto') !== (requestKind === 'context_compression_pre')
    ) {
      throw new Error(`Compression ModelRequest ${recordId} has inconsistent trigger metadata.`);
    }
    const methodKind = requireCompressionMethodKind(recipe.compressionMethodKind);
    const sourceSegmentCount = runtimeNonNegativeSafeInteger(
      recipe.sourceSegmentCount as PlainData | undefined,
      'compression recipe.sourceSegmentCount'
    );
    if (sourceSegmentCount === 0) {
      throw new Error(`Compression ModelRequest ${recordId} has no source segments.`);
    }
    return Buffer.from(JSON.stringify(toWirePlain({
      kind: 'context_compression',
      trigger,
      requestKind,
      blockId: requirePhaseFId(recipe.blockId, 'compression recipe.blockId'),
      methodKind,
      sourceSegmentCount,
      ...(optionalCompressionTriggerReason(recipe.triggerReason) ? {
        triggerReason: optionalCompressionTriggerReason(recipe.triggerReason)
      } : {}),
      ...(optionalCompressionTokenSource(recipe.triggerTokenSource) ? {
        triggerTokenSource: optionalCompressionTokenSource(recipe.triggerTokenSource)
      } : {}),
      ...compressionPresentationTokens(recipe)
    })), 'utf8');
  }

  /** Small collapsed-card metadata; summary contents remain in the pageable detail authority. */
  private async materializeCompressionPresentation(
    recordId: string,
    conversationId?: string | null
  ): Promise<Buffer> {
    const [titleObjectId, summaryObjectId] = await Promise.all([
      this.compressionObjectId(recordId, 'title_object_id', conversationId),
      this.compressionObjectId(recordId, 'summary_object_id', conversationId)
    ]);
    const [titleObject, summaryObject] = await Promise.all([
      this.requireExisting('ContentObject', titleObjectId),
      this.requireExisting('ContentObject', summaryObjectId)
    ]) as [ContentObjectMetadata, ContentObjectMetadata];
    const [titleBytes, summaryBytes] = await Promise.all([
      this.contentStore.read(titleObject),
      this.contentStore.read(summaryObject)
    ]);
    const title = decodeUtf8DiffContent(titleBytes, 'compression title').trim();
    if (!title) throw new Error(`CompressionBlock ${recordId} has an empty title.`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(summaryBytes.toString('utf8')) as unknown;
    } catch {
      throw new Error(`CompressionBlock ${recordId} summary is not valid JSON.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`CompressionBlock ${recordId} summary must be a JSON object.`);
    }
    const summary = parsed as Record<string, unknown>;
    const trigger = summary.trigger;
    if (trigger !== 'auto' && trigger !== 'manual') {
      throw new TypeError(`CompressionBlock ${recordId} has an invalid trigger.`);
    }
    const triggerReason = optionalCompressionTriggerReason(summary.triggerReason);
    const triggerTokenSource = optionalCompressionTokenSource(summary.triggerTokenSource);
    return Buffer.from(JSON.stringify(toWirePlain({
      title,
      trigger,
      methodKind: requireCompressionMethodKind(summary.methodKind),
      ...(triggerReason ? { triggerReason } : {}),
      ...(triggerTokenSource ? { triggerTokenSource } : {}),
      ...compressionPresentationTokens(summary)
    })), 'utf8');
  }

  private async materializeFileChangeDiff(recordId: string): Promise<Buffer> {
    const member = await this.requireExisting('FileChangeSetMember', recordId);
    const operation = requireFileChangeOperation(member.operation);
    const targetPath = requirePhaseFText(member.target_path, 'FileChangeSetMember.target_path');
    const baseContent = await this.readOptionalContent(member.base_content_object_id, 'FileChangeSetMember.base_content_object_id');
    const targetContent = await this.readOptionalContent(member.target_content_object_id, 'FileChangeSetMember.target_content_object_id');
    const before = decodeUtf8DiffContent(baseContent, 'base');
    const after = decodeUtf8DiffContent(targetContent, 'target');
    const diff = operation === 'create_directory' || operation === 'delete_directory_tree'
      ? undefined
      : buildFileDiffRecord(targetPath, before, after, operation !== 'create_file');
    return Buffer.from(JSON.stringify(toWirePlain({
      memberId: recordId,
      operation,
      path: targetPath,
      action: operation === 'create_file'
        ? 'created'
        : operation === 'delete_file' || operation === 'delete_directory_tree'
          ? 'deleted'
          : operation === 'create_directory'
            ? 'created-directory'
            : 'modified',
      ...(diff ? { diff } : {})
    })), 'utf8');
  }

  private async materializeTurnIntentPreview(
    recordId: string,
    conversationId?: string | null
  ): Promise<Buffer> {
    const current = await this.turnIntentCurrentContent(recordId, conversationId);
    let metadata = await this.requireExisting(
      'ContentObject',
      current.contentObjectId
    ) as ContentObjectMetadata;
    let position = initialGuidancePosition(requirePhaseFText(current.intent.created_at, 'TurnIntent.created_at'));
    let hold: 'none' | 'paused' = 'none';
    if (metadata.content_type === TURN_INTENT_ENVELOPE_CONTENT_TYPE) {
      const envelopeSource = (await this.contentStore.read(metadata)).toString('utf8');
      const inputEnvelope = parseInputTurnIntentEnvelopeText(envelopeSource);
      if (!inputEnvelope) {
        const runtimeEnvelope = parseRuntimeContinuationTurnIntentEnvelopeText(envelopeSource);
        if (!runtimeEnvelope) throw new Error(`TurnIntent ${recordId} has an unsupported envelope kind.`);
        const preview = await this.materializeRuntimeContinuationTurnIntentPreview(
          recordId,
          current,
          runtimeEnvelope
        );
        return Buffer.from(JSON.stringify(toWirePlain(preview)), 'utf8');
      }
      metadata = await this.requireExisting(
        'ContentObject',
        inputEnvelope.messageContentObjectId
      ) as ContentObjectMetadata;
      position = inputEnvelope.guidance.position;
      hold = inputEnvelope.guidance.hold;
    }
    const source = (await this.contentStore.read(metadata)).toString('utf8');
    let text = '';
    let hasAttachments = false;
    if (metadata.content_type === 'application/vnd.limcode.message+json') {
      try {
        const parsed = JSON.parse(source) as { parts?: unknown };
        if (Array.isArray(parsed.parts)) {
          text = parsed.parts.flatMap((part) => {
            if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
            const value = part as { text?: unknown; thought?: unknown };
            return typeof value.text === 'string' && value.thought !== true ? [value.text] : [];
          }).join('');
          hasAttachments = parsed.parts.some((part) =>
            Boolean(
              part
              && typeof part === 'object'
              && !Array.isArray(part)
              && ('inlineData' in part || 'fileData' in part)
            )
          );
        }
      } catch {
        text = '';
      }
    } else {
      text = source;
    }
    const editorText = text.trim();
    const characters = Array.from(editorText);
    const truncated = characters.length > TURN_INTENT_PREVIEW_TEXT_CHARACTERS;
    const visibleText = characters.slice(0, TURN_INTENT_PREVIEW_TEXT_CHARACTERS).join('');
    const preview: ReliableKernelTurnIntentPreview = {
      version: 3,
      kind: 'guidance',
      text: visibleText,
      editorText,
      hasAttachments,
      truncated,
      revisionSeq: current.revisionSeq,
      position,
      hold
    };
    return Buffer.from(JSON.stringify(toWirePlain(preview)), 'utf8');
  }

  private async materializeRuntimeContinuationTurnIntentPreview(
    recordId: string,
    current: { contentObjectId: string; revisionSeq: string; intent: DomainRow },
    envelope: RuntimeContinuationTurnIntentEnvelope
  ): Promise<ReliableKernelRuntimeContinuationTurnIntentPreview> {
    const links = await this.listRows('RuntimeDeliveryIntentLink', { turn_intent_id: recordId }, 2);
    if (links.length !== 1) {
      throw new Error(`Runtime continuation TurnIntent ${recordId} must have one RuntimeDeliveryIntentLink.`);
    }
    const deliveryId = requirePhaseFId(
      links[0]!.delivery_id,
      'RuntimeDeliveryIntentLink.delivery_id'
    );
    const delivery = await this.requireExisting('RuntimeDelivery', deliveryId);
    if (delivery.target_conversation_id !== current.intent.conversation_id) {
      throw new Error(`RuntimeDelivery ${deliveryId} targets a different Conversation than TurnIntent ${recordId}.`);
    }
    if (delivery.phase !== 'next_turn') {
      throw new Error(`Runtime continuation TurnIntent ${recordId} requires a next_turn RuntimeDelivery.`);
    }
    const inboxItemId = requirePhaseFId(
      delivery.inbox_item_id,
      'RuntimeDelivery.inbox_item_id'
    );
    const inbox = await this.requireExisting('RuntimeInboxItem', inboxItemId);
    const source = await this.materializeRuntimeContinuationSource(inbox, inboxItemId);
    return {
      version: 3,
      kind: 'runtime_continuation',
      revisionSeq: current.revisionSeq,
      sourceTurnId: envelope.sourceTurnId,
      deliveryId,
      deliveryState: requirePhaseFText(delivery.state, 'RuntimeDelivery.state'),
      phase: requirePhaseFText(delivery.phase, 'RuntimeDelivery.phase'),
      source
    };
  }

  private async materializeRuntimeContinuationSource(
    inbox: DomainRow,
    inboxItemId: string
  ): Promise<ReliableKernelRuntimeContinuationSource> {
    const sourceId = requirePhaseFId(inbox.source_id, 'RuntimeInboxItem.source_id');
    if (inbox.source_kind === 'process_receipt') {
      const receipt = await this.requireExisting('ProcessReceipt', sourceId);
      const processId = requirePhaseFId(receipt.process_id, 'ProcessReceipt.process_id');
      const process = await this.requireExisting('Process', processId);
      const origins = await this.listRows('ProcessOriginLink', { process_id: processId }, 2);
      if (origins.length !== 1) throw new Error(`Process ${processId} must have one ProcessOriginLink.`);
      const toolCallId = requirePhaseFId(origins[0]!.tool_call_id, 'ProcessOriginLink.tool_call_id');
      const toolCall = await this.requireExisting('ToolCall', toolCallId);
      const commandPreview = await this.runtimeProcessCommandPreview(toolCall);
      const exitCode = optionalRuntimeIntegerText(receipt.exit_code, 'ProcessReceipt.exit_code');
      const exitSignal = receipt.exit_signal === null
        ? undefined
        : requirePhaseFText(receipt.exit_signal, 'ProcessReceipt.exit_signal');
      return {
        kind: 'background_process',
        inboxItemId,
        sourceId,
        processId,
        processReceiptId: sourceId,
        processStatus: requirePhaseFText(process.status, 'Process.status'),
        outcome: requirePhaseFText(receipt.outcome, 'ProcessReceipt.outcome'),
        ...(commandPreview ? { commandPreview } : {}),
        toolCallId,
        ...(exitCode ? { exitCode } : {}),
        ...(exitSignal ? { exitSignal } : {})
      };
    }
    if (inbox.source_kind === 'collaboration_message') {
      const message = await this.requireExisting('CollaborationMessage', sourceId);
      if (message.mode !== 'message' && message.mode !== 'followup') throw new Error('Invalid CollaborationMessage mode.');
      const [sources, payloads, targets] = await Promise.all([
        this.listRows('CollaborationMessageSourceLink', { message_id: sourceId }, 2),
        this.listRows('CollaborationMessagePayloadLink', { message_id: sourceId }, 2),
        this.listRows('CollaborationMessageTargetLink', { message_id: sourceId, inbox_item_id: inboxItemId }, 2)
      ]);
      if (sources.length !== 1 || payloads.length !== 1 || targets.length !== 1) {
        throw new Error('Collaboration message preview requires exact source, payload and destination links.');
      }
      const metadata = await this.requireExisting('ContentObject', String(payloads[0]!.content_object_id)) as ContentObjectMetadata;
      if (metadata.content_type !== 'text/vnd.limcode.collaboration-message' || BigInt(metadata.byte_length) > 64000n) {
        throw new Error('Collaboration message preview payload violates its content contract.');
      }
      const text = (await this.contentStore.read(metadata)).toString('utf8');
      return { kind: 'collaboration_message', inboxItemId, sourceId,
        sourceConversationId: requirePhaseFId(sources[0]!.conversation_id, 'CollaborationMessageSourceLink.conversation_id'),
        mode: message.mode, textPreview: boundedTurnIntentSourceText(text, 320) ?? '' };
    }
    if (inbox.source_kind !== 'answer_submission') {
      throw new Error(`RuntimeInboxItem ${inboxItemId} has unsupported source kind ${String(inbox.source_kind)}.`);
    }
    const submission = await this.requireExisting('AnswerSubmission', sourceId);
    const bridge = await this.requireExisting(
      'AnswerBridge',
      requirePhaseFId(submission.answer_bridge_id, 'AnswerSubmission.answer_bridge_id')
    );
    const childExecutionId = requirePhaseFId(
      bridge.child_execution_id,
      'AnswerBridge.child_execution_id'
    );
    const child = await this.requireExisting('ChildExecution', childExecutionId);
    const childConversationId = requirePhaseFId(
      child.child_conversation_id,
      'ChildExecution.child_conversation_id'
    );
    const agentLinks = await this.listRows('AgentConversationLink', {
      conversation_id: childConversationId,
      role: 'default'
    }, 2);
    if (agentLinks.length !== 1) {
      throw new Error(`Child Conversation ${childConversationId} must have one default AgentConversationLink.`);
    }
    const payloads = await this.listRows('AnswerPayload', { submission_id: sourceId }, 2);
    if (payloads.length !== 1) throw new Error(`AnswerSubmission ${sourceId} must have one AnswerPayload.`);
    const interrupted = runtimeBoolean(submission.interrupted, 'AnswerSubmission.interrupted');
    const title = payloads[0]!.title === null
      ? undefined
      : boundedTurnIntentSourceText(
          requirePhaseFText(payloads[0]!.title, 'AnswerPayload.title'),
          TURN_INTENT_SOURCE_LABEL_CHARACTERS
        );
    return {
      kind: 'subagent',
      inboxItemId,
      sourceId,
      submissionId: sourceId,
      childExecutionId,
      childConversationId,
      childStatus: requirePhaseFText(child.status, 'ChildExecution.status'),
      interrupted,
      agentId: requirePhaseFId(agentLinks[0]!.agent_id, 'AgentConversationLink.agent_id'),
      ...(title ? { title } : {})
    };
  }

  private async runtimeProcessCommandPreview(toolCall: DomainRow): Promise<string | undefined> {
    const metadata = await this.requireExisting(
      'ContentObject',
      requirePhaseFId(toolCall.arguments_object_id, 'ToolCall.arguments_object_id')
    ) as ContentObjectMetadata;
    const byteLength = requireRuntimeNonNegativeBigInt(
      metadata.byte_length,
      'ToolCall arguments ContentObject.byte_length'
    );
    if (byteLength > BigInt(TURN_INTENT_SOURCE_ARGUMENTS_MAX_BYTES)) return undefined;
    try {
      const parsed = JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
      const command = (parsed as Record<string, unknown>).command;
      return typeof command === 'string'
        ? boundedTurnIntentSourceText(command, TURN_INTENT_SOURCE_LABEL_CHARACTERS)
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async readOptionalContent(value: unknown, label: string): Promise<Buffer> {
    if (value === null) return Buffer.alloc(0);
    const metadata = await this.requireExisting('ContentObject', requirePhaseFId(value, label)) as ContentObjectMetadata;
    return this.contentStore.read(metadata);
  }

  private async resolveContentObjectId(
    kind: Exclude<
      ClientDetailKind,
      'context-projection-detail' | 'file-change-diff' | 'turn-intent-preview' | 'model-request-purpose' | 'compression-presentation' | 'process-stdout' | 'process-stderr'
    >,
    recordId: string,
    conversationId?: string | null
  ): Promise<string> {
    switch (kind) {
      case 'message-content':
        return this.objectIdFromRow('MessageRevision', recordId, 'content_object_id');
      case 'tool-arguments-content':
        return this.objectIdFromRow('ToolCall', recordId, 'arguments_object_id');
      case 'tool-result-content': {
        const outcome = await this.maybeGet('ToolOutcome', recordId)
          ?? (await this.listRows('ToolOutcome', { tool_call_id: recordId }, 2))[0];
        if (!outcome) throw new Error(`Tool result ${recordId} does not exist.`);
        return requirePhaseFId(outcome.content_object_id, 'ToolOutcome.content_object_id');
      }
      case 'tool-event-content':
        return this.objectIdFromRow('ToolCallEvent', recordId, 'content_object_id');
      case 'interaction-prompt':
        return this.objectIdFromRow('InteractionRequest', recordId, 'prompt_object_id');
      case 'file-change-base-content':
        return this.objectIdFromRow('FileChangeSetMember', recordId, 'base_content_object_id');
      case 'file-change-content':
        return this.objectIdFromRow('FileChangeSetMember', recordId, 'target_content_object_id');
      case 'process-output':
        return this.objectIdFromRow('ProcessOutputChunk', recordId, 'content_object_id');
      case 'answer-content': {
        const payload = await this.maybeGet('AnswerPayload', recordId)
          ?? (await this.listRows('AnswerPayload', { submission_id: recordId }, 2))[0];
        if (!payload) throw new Error(`Answer detail ${recordId} does not exist.`);
        return requirePhaseFId(payload.content_object_id, 'AnswerPayload.content_object_id');
      }
      case 'compression-content':
        return this.compressionObjectId(recordId, 'summary_object_id', conversationId);
      case 'compression-title':
        return this.compressionObjectId(recordId, 'title_object_id', conversationId);
    }
  }

  private async turnIntentCurrentContent(
    recordId: string,
    conversationId?: string | null
  ): Promise<{ contentObjectId: string; revisionSeq: string; intent: DomainRow }> {
    const intent = await this.requireExisting('TurnIntent', recordId);
    const scopedConversationId = conversationId == null
      ? null
      : requirePhaseFId(conversationId, 'detail.conversationId');
    const childLinks = await this.listRows('ChildExecutionIntentLink', {
      turn_intent_id: recordId
    }, 1);
    if (
      !scopedConversationId
      || intent.conversation_id !== scopedConversationId
      || intent.state !== 'queued'
      || intent.turn_id !== null
      || childLinks.length > 0
    ) {
      throw new Error(`TurnIntent ${recordId} is not visible in the active Conversation queue.`);
    }
    const barrier = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('TurnIntentRevision').list({
        where: { intent_id: recordId },
        orderBy: { column: 'revision_seq', direction: 'desc' },
        limit: 1
      })
    ]);
    const revisions = barrier.snapshot[0];
    if (!Array.isArray(revisions) || revisions.length !== 1) {
      throw new Error(`TurnIntent ${recordId} does not have one current content revision.`);
    }
    return {
      contentObjectId: requirePhaseFId(
        revisions[0]!.content_object_id,
        'TurnIntentRevision.content_object_id'
      ),
      revisionSeq: requireRuntimeNonNegativeBigInt(
        revisions[0]!.revision_seq,
        'TurnIntentRevision.revision_seq'
      ).toString(),
      intent
    };
  }

  private async compressionObjectId(
    recordId: string,
    field: 'summary_object_id' | 'title_object_id',
    conversationId?: string | null
  ): Promise<string> {
    const block = await this.requireExisting('CompressionBlock', recordId);
    if (conversationId !== undefined) {
      const scopedConversationId = conversationId === null
        ? null
        : requirePhaseFId(conversationId, 'detail.conversationId');
      if (!scopedConversationId || block.conversation_id !== scopedConversationId) {
        throw new Error(`CompressionBlock ${recordId} is not visible in the active Conversation.`);
      }
    }
    return requirePhaseFId(block[field], `CompressionBlock.${field}`);
  }

  private async objectIdFromRow(domain: string, id: string, field: string): Promise<string> {
    const row = await this.requireExisting(domain, id);
    return requirePhaseFId(row[field], `${domain}.${field}`);
  }

  private async listRows(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const barrier = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    const rows = barrier.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} detail lookup did not return rows.`);
    return rows;
  }

  private async maybeGet(domain: string, id: string): Promise<DomainRow | null> {
    const barrier = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return barrier.snapshot[0] as DomainRow | null;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const row = await this.maybeGet(domain, id);
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }
}

function runtimeBoolean(value: unknown, label: string): boolean {
  if (value === 0n) return false;
  if (value === 1n) return true;
  throw new TypeError(`${label} must be SQLite boolean 0 or 1.`);
}

function optionalRuntimeIntegerText(value: unknown, label: string): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== 'bigint') throw new TypeError(`${label} must be a SQLite INTEGER or NULL.`);
  return value.toString();
}

function boundedTurnIntentSourceText(value: string, maxCharacters: number): string | undefined {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return undefined;
  const characters = Array.from(normalized);
  return characters.length <= maxCharacters
    ? normalized
    : `${characters.slice(0, Math.max(0, maxCharacters - 1)).join('')}…`;
}

function requireFileChangeOperation(value: unknown): 'create_file' | 'replace_file' | 'delete_file' | 'create_directory' | 'delete_directory_tree' {
  if (!['create_file', 'replace_file', 'delete_file', 'create_directory', 'delete_directory_tree'].includes(String(value))) {
    throw new TypeError(`Unsupported FileChangeSetMember operation: ${String(value)}.`);
  }
  return value as 'create_file' | 'replace_file' | 'delete_file' | 'create_directory' | 'delete_directory_tree';
}

function optionalCompressionTriggerReason(
  value: unknown
): 'manual' | 'configured_threshold' | undefined {
  if (value === undefined) return undefined;
  if (value === 'manual' || value === 'configured_threshold') return value;
  throw new TypeError(`Unsupported compression trigger reason: ${String(value)}.`);
}

function optionalCompressionTokenSource(
  value: unknown
): 'provider-observed-delta' | 'compression-output' | 'semantic' | undefined {
  if (value === undefined) return undefined;
  if (value === 'provider-observed-delta' || value === 'compression-output' || value === 'semantic') return value;
  throw new TypeError(`Unsupported compression token source: ${String(value)}.`);
}

function compressionPresentationTokens(summary: Record<string, unknown>): Record<string, number> {
  const fields = [
    'triggerTokens',
    'configuredThresholdTokens',
    'estimatedTokensBefore',
    'estimatedTokensAfter',
    'calibratedTokensBefore',
    'calibratedTokensAfter',
    'providerInputTokens',
    'providerOutputTokens'
  ] as const;
  return Object.fromEntries(fields.flatMap((field) => {
    const value = summary[field];
    if (value === undefined) return [];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Compression presentation ${field} must be a non-negative safe integer.`);
    }
    return [[field, value] as const];
  }));
}

function requireCompressionMethodKind(value: unknown): string {
  const allowed = [
    'provider_native',
    'llm_summary',
    'segmented_summary',
    'deterministic_summary',
    'manual_summary'
  ];
  if (!allowed.includes(String(value))) {
    throw new TypeError(`Unsupported compression method: ${String(value)}.`);
  }
  return String(value);
}

function decodeUtf8DiffContent(bytes: Buffer, role: string): string {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`File change ${role} content is not exact UTF-8 text and cannot be rendered as an inline Diff.`);
  }
  return text;
}

const LIVE_SNAPSHOT_WINDOW_ROOT_DOMAINS = new Set([
  'Message',
  'Turn',
  'ConversationProjectLink',
  'ConversationReuseLink',
  'ConversationBranchLink',
  'ConversationOriginLink',
  'AgentConversationLink',
  'ConversationCommandReceipt',
  'TurnIntent',
  'CompressionBlock',
  'Process',
  'ChildExecution',
  'AnswerSubmission',
  'RuntimeDelivery',
  'CollaborationMessage'
]);

const SNAPSHOT_ON_STRUCTURAL_REMOVE_DOMAINS = new Set([
  'Message',
  'MessageTurnLink',
  'ModelRequest',
  'ModelContextProjection',
  'ModelRequestMessageLink',
  'ToolCall',
  'ToolCallSourceLink',
  'FileChangeSet',
  'FileChangeSetMember',
  'Process',
  'ProcessOriginLink',
  'ChildExecution',
  'ChildExecutionParentLink',
  'ChildExecutionTurnLink',
  'ChildExecutionActiveTurnLink',
  'AnswerBridge',
  'RuntimeDelivery',
  'CollaborationMessage'
]);

/** Text links which are intentionally not SQLite foreign keys still need an explicit type. */
const EXPLICIT_REFERENCE_DOMAINS: Readonly<Record<string, string>> = Object.freeze({
  conversation_id: 'Conversation',
  target_conversation_id: 'Conversation',
  source_conversation_id: 'Conversation',
  child_conversation_id: 'Conversation',
  project_context_id: 'ProjectContext',
  turn_id: 'Turn',
  target_turn_id: 'Turn',
  parent_turn_id: 'Turn',
  source_turn_id: 'Turn',
  message_id: 'Message',
  revision_id: 'MessageRevision',
  message_revision_id: 'MessageRevision',
  source_message_revision_id: 'MessageRevision',
  tool_call_id: 'ToolCall',
  source_tool_call_id: 'ToolCall',
  model_request_id: 'ModelRequest',
  request_id: 'InteractionRequest',
  process_id: 'Process',
  change_set_id: 'FileChangeSet',
  child_execution_id: 'ChildExecution',
  parent_child_execution_id: 'ChildExecution',
  answer_bridge_id: 'AnswerBridge',
  current_submission_id: 'AnswerSubmission',
  submission_id: 'AnswerSubmission',
  inbox_item_id: 'RuntimeInboxItem',
  delivery_id: 'RuntimeDelivery',
  retry_of_delivery_id: 'RuntimeDelivery',
  root_id: 'ContextSequenceRoot'
});

const CLIENT_PROJECTION_ARRAY_DOMAINS: Readonly<Record<string, string>> = Object.freeze({
  messages: 'Message',
  projectContexts: 'ProjectContext',
  conversationProjectLinks: 'ConversationProjectLink',
  conversationReuseLinks: 'ConversationReuseLink',
  conversationBranchLinks: 'ConversationBranchLink',
  conversationOriginLinks: 'ConversationOriginLink',
  agentConversationLinks: 'AgentConversationLink',
  commandReceipts: 'ConversationCommandReceipt',
  queuedTurnIntents: 'TurnIntent',
  compressionBlocks: 'CompressionBlock',
  conversationContextStatuses: 'ConversationContextStatus',
  turns: 'Turn',
  executionLeases: 'ExecutionLease',
  turnTerminations: 'TurnTermination',
  turnExecutorLinks: 'TurnExecutorLink',
  modelRequests: 'ModelRequest',
  modelContextProjections: 'ModelContextProjection',
  modelRequestMessageLinks: 'ModelRequestMessageLink',
  messageTurnLinks: 'MessageTurnLink',
  toolCalls: 'ToolCall',
  toolCallSourceLinks: 'ToolCallSourceLink',
  toolCallPolicySnapshots: 'ToolCallPolicySnapshot',
  toolCallEvents: 'ToolCallEvent',
  toolExecutions: 'ToolExecution',
  toolOutcomes: 'ToolOutcome',
  toolModelResults: 'ToolModelResult',
  toolResultArtifacts: 'ToolResultArtifact',
  interactionRequests: 'InteractionRequest',
  interactionOwnerLinks: 'InteractionOwnerLink',
  interactionToolCallLinks: 'InteractionToolCallLink',
  interactionResponses: 'InteractionResponse',
  fileChangeSets: 'FileChangeSet',
  fileChangeSetMembers: 'FileChangeSetMember',
  fileChangeDecisions: 'FileChangeDecision',
  fileMutationReceipts: 'FileMutationReceipt',
  fileMutationReceiptMembers: 'FileMutationReceiptMember',
  processes: 'Process',
  processOriginLinks: 'ProcessOriginLink',
  processOutputChunks: 'ProcessOutputChunk',
  processReceipts: 'ProcessReceipt',
  childExecutions: 'ChildExecution',
  childExecutionParentLinks: 'ChildExecutionParentLink',
  childExecutionTurnLinks: 'ChildExecutionTurnLink',
  childExecutionActiveTurnLinks: 'ChildExecutionActiveTurnLink',
  childTurns: 'Turn',
  childExecutionLeases: 'ExecutionLease',
  childTurnTerminations: 'TurnTermination',
  childTurnExecutorLinks: 'TurnExecutorLink',
  childExecutionActivities: 'ChildExecutionActivity',
  answerBridges: 'AnswerBridge',
  answerSubmissions: 'AnswerSubmission',
  runtimeInboxItems: 'RuntimeInboxItem',
  runtimeDeliveries: 'RuntimeDelivery',
  runtimeDeliveryIntentLinks: 'RuntimeDeliveryIntentLink',
    collaborationMessages: 'CollaborationMessage',
    collaborationMessageSourceLinks: 'CollaborationMessageSourceLink',
    collaborationMessageTargetLinks: 'CollaborationMessageTargetLink',
    collaborationMessageReplyLinks: 'CollaborationMessageReplyLink',
    collaborationRequests: 'CollaborationRequest',
    collaborationRequestTurnLinks: 'CollaborationRequestTurnLink'
});

function recordKey(domain: string, id: string): string {
  return `${domain}\0${id}`;
}

function referenceDomain(domain: string, field: string): string | undefined {
  const schema = RUNTIME_DOMAIN_SCHEMA_BY_KEY.get(domain);
  const column = schema?.columns.find((candidate) => candidate.name === field);
  if (column?.references) return RUNTIME_DOMAIN_SCHEMA_BY_TABLE.get(column.references.table)?.key;
  return EXPLICIT_REFERENCE_DOMAINS[field];
}

function typedRecordReferenceKeys(
  domain: string,
  record: Record<string, unknown>
): Set<string> {
  const references = new Set<string>();
  for (const [field, value] of Object.entries(record)) {
    if (typeof value !== 'string' || !value) continue;
    const targetDomain = referenceDomain(domain, field);
    if (targetDomain) references.add(recordKey(targetDomain, value));
  }
  return references;
}

function retainMaterializedRecordReferences(
  session: ClientFeedSession,
  domain: string,
  id: string,
  record: Record<string, unknown>
): void {
  const ownKey = recordKey(domain, id);
  const references = typedRecordReferenceKeys(domain, record);
  references.add(ownKey);
  session.materializedRecordReferences.set(ownKey, references);
  for (const reference of references) retainActiveRecordKey(session, reference);
}

function releaseMaterializedRecordReferences(session: ClientFeedSession, ownKey: string): void {
  const references = session.materializedRecordReferences.get(ownKey);
  if (!references) return;
  session.materializedRecordReferences.delete(ownKey);
  for (const reference of references) releaseActiveRecordKey(session, reference);
}

function removeMaterializedRecord(session: ClientFeedSession, ownKey: string): void {
  if (!session.materializedRecordKeys.has(ownKey)) return;
  const domain = recordDomainFromKey(ownKey);
  const id = recordIdFromKey(ownKey);
  if (domain === 'Message' && session.currentTaskSourceMessageId === id) {
    session.currentTaskSourceMessageId = null;
  }
  forgetScopedProjectionIdentity(session, domain, id, session.materializedRecords.get(ownKey));
  releaseMaterializedRecordReferences(session, ownKey);
  forgetMessageDisplayFloor(session, ownKey);
  session.materializedRecordKeys.delete(ownKey);
  session.materializedRecords.delete(ownKey);
  session.materializedRecordTemporal.delete(ownKey);
  decrementRecordCount(session.activeRecordCounts, domain);
}

function retainActiveRecordKey(session: ClientFeedSession, key: string): void {
  const next = (session.activeRecordKeyRefCounts.get(key) ?? 0) + 1;
  session.activeRecordKeyRefCounts.set(key, next);
  session.activeRecordKeys.add(key);
}

function releaseActiveRecordKey(session: ClientFeedSession, key: string): void {
  const next = Math.max(0, (session.activeRecordKeyRefCounts.get(key) ?? 0) - 1);
  if (next === 0) {
    session.activeRecordKeyRefCounts.delete(key);
    session.activeRecordKeys.delete(key);
  } else {
    session.activeRecordKeyRefCounts.set(key, next);
  }
}

function hasMaterializedReferenceFrom(
  session: ClientFeedSession,
  targetKey: string,
  sourceDomains: readonly string[]
): boolean {
  for (const [sourceKey, references] of session.materializedRecordReferences) {
    if (!sourceDomains.some((domain) => sourceKey.startsWith(`${domain}\0`))) continue;
    if (references.has(targetKey)) return true;
  }
  return false;
}

function rememberScopedProjectionIdentity(
  session: ClientFeedSession,
  domain: string,
  id: string,
  record: Record<string, unknown>
): void {
  if (domain === 'Turn' && record.conversation_id === session.activeConversationId) {
    session.primaryTurnIds.add(id);
    return;
  }
  if (
    domain === 'Message'
    && record.conversation_id === session.activeConversationId
    && record.deleted_at === null
    && (record.role === 'user' || record.role === 'model')
  ) {
    session.visibleMessageIds.add(id);
    return;
  }
  if (domain === 'ToolCall') {
    session.projectedToolCallIds.add(id);
    return;
  }
}

function forgetScopedProjectionIdentity(
  session: ClientFeedSession,
  domain: string,
  id: string,
  record?: Record<string, unknown>
): void {
  if (domain === 'Turn' && record?.conversation_id === session.activeConversationId) {
    session.primaryTurnIds.delete(id);
    return;
  }
  if (domain === 'Message') {
    session.visibleMessageIds.delete(id);
    return;
  }
  if (domain === 'ToolCall') session.projectedToolCallIds.delete(id);
}

function seedScopedProjectionIdentities(
  session: ClientFeedSession,
  projections: Record<string, PlainData>
): void {
  const activeTurns = projections.activeTurnSummary;
  if (isPlainRecord(activeTurns) && Array.isArray(activeTurns.turns)) {
    for (const turn of activeTurns.turns) {
      if (isPlainRecord(turn) && typeof turn.id === 'string') session.primaryTurnIds.add(turn.id);
    }
  }
  const tools = projections.activeToolAndInteractionSummary;
  if (isPlainRecord(tools) && Array.isArray(tools.toolCalls)) {
    for (const toolCall of tools.toolCalls) {
      if (isPlainRecord(toolCall) && typeof toolCall.id === 'string') session.projectedToolCallIds.add(toolCall.id);
    }
  }
}

function attachMessageDisplayFloor(
  session: ClientFeedSession,
  messageId: string,
  record: Record<string, unknown>
): Record<string, unknown> | undefined {
  const rawSequence = runtimeNonNegativeBigInt(record.message_seq);
  if (rawSequence === undefined || rawSequence === 0n) return undefined;
  const visible = record.deleted_at === null || record.deleted_at === undefined
    ? record.role === 'user' || record.role === 'model'
    : false;
  const existingFloor = session.messageDisplayFloors.get(messageId);
  if (existingFloor !== undefined) {
    if (!visible) return undefined;
    return { ...record, display_seq: existingFloor };
  }
  if (rawSequence <= session.latestMessageSeq) {
    // An update to an evicted/historical visible message can change every later display rank. A
    // bounded snapshot recomputes that rank atomically; hidden tool messages need no floor.
    return visible ? undefined : record;
  }
  session.latestMessageSeq = rawSequence;
  if (!visible) return record;
  session.latestVisibleMessageFloor += 1n;
  session.messageDisplayFloors.set(messageId, session.latestVisibleMessageFloor);
  return { ...record, display_seq: session.latestVisibleMessageFloor };
}

function forgetMessageDisplayFloor(session: ClientFeedSession, typedKey: string): void {
  if (!typedKey.startsWith('Message\0')) return;
  session.messageDisplayFloors.delete(recordIdFromKey(typedKey));
}

function runtimeNonNegativeBigInt(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value >= 0n ? value : undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  return undefined;
}

function plainNonNegativeBigInt(value: PlainData | undefined): bigint {
  const parsed = runtimeNonNegativeBigInt(value);
  return parsed ?? 0n;
}

function collectProjectionRecordKeys(
  value: PlainData,
  target: Set<string>,
  refCounts: Map<string, number>,
  records: Map<string, Record<string, unknown>>,
  referencesByRecord: Map<string, Set<string>>,
  counts: Map<string, number>,
  countedRecords: Set<string>,
  temporal: Map<string, string>
): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectProjectionRecordKeys(entry, target, refCounts, records, referencesByRecord, counts, countedRecords, temporal);
    }
    return;
  }
  if (!isPlainRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const domain = CLIENT_PROJECTION_ARRAY_DOMAINS[key];
    if (domain && Array.isArray(nested)) {
      for (const entry of nested) {
        if (!isPlainRecord(entry)) continue;
        const id = entry.id;
        if (typeof id !== 'string' || !id) continue;
        const ownKey = recordKey(domain, id);
        if (!countedRecords.has(ownKey)) {
          countedRecords.add(ownKey);
          records.set(ownKey, entry);
          incrementRecordCount(counts, domain);
          const references = typedRecordReferenceKeys(domain, entry);
          references.add(ownKey);
          referencesByRecord.set(ownKey, references);
          for (const reference of references) {
            const next = (refCounts.get(reference) ?? 0) + 1;
            refCounts.set(reference, next);
            target.add(reference);
          }
        }
        temporal.set(ownKey, recordTemporalKey(domain, entry, id));
      }
    }
    collectProjectionRecordKeys(nested, target, refCounts, records, referencesByRecord, counts, countedRecords, temporal);
  }
}

function incrementRecordCount(counts: Map<string, number>, domain: string): number {
  const count = (counts.get(domain) ?? 0) + 1;
  counts.set(domain, count);
  return count;
}

function decrementRecordCount(counts: Map<string, number>, domain: string): void {
  const next = Math.max(0, (counts.get(domain) ?? 0) - 1);
  if (next === 0) counts.delete(domain);
  else counts.set(domain, next);
}

type MessageWindowEvictionPlan =
  | { kind: 'evict'; keys: string[] }
  | { kind: 'pinned' }
  | { kind: 'snapshot' };

const TERMINAL_TOOL_OWNED_DOMAINS = [
  'ToolCallPolicySnapshot',
  'ToolCallEvent',
  'ToolExecution',
  'ToolOutcome',
  'ToolModelResult',
  'ToolResultArtifact'
] as const;

function evictMessagesOutsideLiveWindow(
  session: ClientFeedSession
): { changes: ClientScopedRuntimeChange[]; requiresSnapshot: boolean } {
  const limit = BigInt(CLIENT_MESSAGE_WINDOW_LIMIT);
  if (session.latestVisibleMessageFloor <= limit) return { changes: [], requiresSnapshot: false };
  const cutoff = session.latestVisibleMessageFloor - limit;
  const candidates = [...session.messageDisplayFloors.entries()]
    .filter(([messageId, floor]) =>
      floor <= cutoff && session.materializedRecordKeys.has(recordKey('Message', messageId)))
    .sort((left, right) => left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : left[0].localeCompare(right[0]));
  const changes: ClientScopedRuntimeChange[] = [];
  for (const [messageId] of candidates) {
    const plan = planMessageWindowEviction(session, messageId);
    if (plan.kind === 'pinned') continue;
    if (plan.kind === 'snapshot') return { changes, requiresSnapshot: true };
    for (const key of plan.keys) {
      if (!session.materializedRecordKeys.has(key)) continue;
      const domain = recordDomainFromKey(key);
      const id = recordIdFromKey(key);
      removeMaterializedRecord(session, key);
      changes.push({ domain, kind: 'remove', id, removalCause: 'window-eviction' });
    }
  }
  return { changes, requiresSnapshot: false };
}

function planMessageWindowEviction(
  session: ClientFeedSession,
  messageId: string
): MessageWindowEvictionPlan {
  if (session.currentTaskSourceMessageId === messageId) return { kind: 'pinned' };
  const messageKey = recordKey('Message', messageId);
  if (!session.materializedRecordKeys.has(messageKey)) return { kind: 'evict', keys: [] };

  const bundle = new Set<string>([messageKey]);
  const requestIds = new Set<string>();
  const toolCallIds = new Set<string>();
  for (const [key] of materializedRecordsMatching(session, 'MessageTurnLink', 'message_id', messageId)) {
    bundle.add(key);
  }
  for (const [key, link] of materializedRecordsMatching(
    session,
    'ModelRequestMessageLink',
    'message_id',
    messageId
  )) {
    const requestId = recordStringField(link, 'model_request_id');
    if (!requestId) return { kind: 'snapshot' };
    requestIds.add(requestId);
    bundle.add(key);
  }
  for (const [key, link] of materializedRecordsMatching(
    session,
    'ToolCallSourceLink',
    'message_id',
    messageId
  )) {
    const requestId = recordStringField(link, 'model_request_id');
    const toolCallId = recordStringField(link, 'tool_call_id');
    if (!requestId || !toolCallId) return { kind: 'snapshot' };
    requestIds.add(requestId);
    toolCallIds.add(toolCallId);
    bundle.add(key);
  }

  for (const requestId of requestIds) {
    const requestKey = recordKey('ModelRequest', requestId);
    const request = session.materializedRecords.get(requestKey);
    if (!request) return { kind: 'snapshot' };
    if (request.status !== 'terminal') return { kind: 'pinned' };
    bundle.add(requestKey);
    for (const [key, projection] of materializedRecordsMatching(
      session,
      'ModelContextProjection',
      'owner_id',
      requestId
    )) {
      if (recordStringField(projection, 'owner_kind') !== 'model_request') return { kind: 'snapshot' };
      bundle.add(key);
    }
    for (const [key, link] of materializedRecordsMatching(
      session,
      'ModelRequestMessageLink',
      'model_request_id',
      requestId
    )) {
      if (recordStringField(link, 'message_id') !== messageId) return { kind: 'snapshot' };
      bundle.add(key);
    }
    for (const [key, link] of materializedRecordsMatching(
      session,
      'ToolCallSourceLink',
      'model_request_id',
      requestId
    )) {
      const toolCallId = recordStringField(link, 'tool_call_id');
      if (recordStringField(link, 'message_id') !== messageId || !toolCallId) return { kind: 'snapshot' };
      toolCallIds.add(toolCallId);
      bundle.add(key);
    }
  }

  for (const toolCallId of toolCallIds) {
    const toolCallKey = recordKey('ToolCall', toolCallId);
    const toolCall = session.materializedRecords.get(toolCallKey);
    if (!toolCall) return { kind: 'snapshot' };
    if (toolCall.status !== 'terminal') return { kind: 'pinned' };
    if (toolCall.tool_name === 'update_task_list' || toolCall.tool_name === 'submit_plan') {
      return { kind: 'snapshot' };
    }
    bundle.add(toolCallKey);
    for (const [key, link] of materializedRecordsMatching(
      session,
      'ToolCallSourceLink',
      'tool_call_id',
      toolCallId
    )) {
      const requestId = recordStringField(link, 'model_request_id');
      if (
        recordStringField(link, 'message_id') !== messageId
        || !requestId
        || !requestIds.has(requestId)
      ) return { kind: 'snapshot' };
      bundle.add(key);
    }
    for (const domain of TERMINAL_TOOL_OWNED_DOMAINS) {
      for (const [key, record] of materializedRecordsMatching(session, domain, 'tool_call_id', toolCallId)) {
        if (domain === 'ToolExecution' && record.status !== 'completed') return { kind: 'pinned' };
        bundle.add(key);
      }
    }

    const childLinks = materializedRecordsMatching(
      session,
      'ChildExecutionParentLink',
      'source_tool_call_id',
      toolCallId
    );
    if (childLinks.length > 0) {
      for (const [, link] of childLinks) {
        const childId = recordStringField(link, 'child_execution_id');
        const child = childId
          ? session.materializedRecords.get(recordKey('ChildExecution', childId))
          : undefined;
        if (!child) return { kind: 'snapshot' };
        if (child.status !== 'closed' && child.status !== 'needs_human') return { kind: 'pinned' };
      }
      return { kind: 'snapshot' };
    }

    for (const [originKey, origin] of materializedRecordsMatching(
      session,
      'ProcessOriginLink',
      'tool_call_id',
      toolCallId
    )) {
      const processId = recordStringField(origin, 'process_id');
      const processKey = processId ? recordKey('Process', processId) : '';
      const process = processKey ? session.materializedRecords.get(processKey) : undefined;
      if (!processId || !process) return { kind: 'snapshot' };
      if (process.status === 'running') return { kind: 'pinned' };
      bundle.add(originKey);
      bundle.add(processKey);
      for (const domain of ['ProcessOutputChunk', 'ProcessReceipt'] as const) {
        for (const [key] of materializedRecordsMatching(session, domain, 'process_id', processId)) bundle.add(key);
      }
    }

    for (const [toolLinkKey, toolLink] of materializedRecordsMatching(
      session,
      'InteractionToolCallLink',
      'tool_call_id',
      toolCallId
    )) {
      const requestId = recordStringField(toolLink, 'request_id');
      const requestKey = requestId ? recordKey('InteractionRequest', requestId) : '';
      const request = requestKey ? session.materializedRecords.get(requestKey) : undefined;
      if (!requestId || !request) return { kind: 'snapshot' };
      if (request.status === 'pending') return { kind: 'pinned' };
      bundle.add(toolLinkKey);
      bundle.add(requestKey);
      for (const domain of ['InteractionOwnerLink', 'InteractionToolCallLink', 'InteractionResponse'] as const) {
        for (const [key, record] of materializedRecordsMatching(session, domain, 'request_id', requestId)) {
          if (
            domain === 'InteractionToolCallLink'
            && !toolCallIds.has(recordStringField(record, 'tool_call_id') ?? '')
          ) return { kind: 'snapshot' };
          bundle.add(key);
        }
      }
    }

    for (const [changeSetKey, changeSet] of materializedRecordsMatching(
      session,
      'FileChangeSet',
      'tool_call_id',
      toolCallId
    )) {
      if (changeSet.status === 'pending') return { kind: 'pinned' };
      const changeSetId = recordIdFromKey(changeSetKey);
      bundle.add(changeSetKey);
      for (const domain of ['FileChangeSetMember', 'FileChangeDecision'] as const) {
        for (const [key] of materializedRecordsMatching(session, domain, 'change_set_id', changeSetId)) bundle.add(key);
      }
      for (const [receiptKey] of materializedRecordsMatching(
        session,
        'FileMutationReceipt',
        'change_set_id',
        changeSetId
      )) {
        bundle.add(receiptKey);
        const receiptId = recordIdFromKey(receiptKey);
        for (const [key] of materializedRecordsMatching(
          session,
          'FileMutationReceiptMember',
          'receipt_id',
          receiptId
        )) bundle.add(key);
      }
    }
  }

  for (const [sourceKey, references] of session.materializedRecordReferences) {
    if (bundle.has(sourceKey)) continue;
    for (const targetKey of bundle) {
      if (references.has(targetKey)) return { kind: 'snapshot' };
    }
  }
  const keys = [...bundle].sort((left, right) => {
    if (left === messageKey) return 1;
    if (right === messageKey) return -1;
    return left.localeCompare(right);
  });
  return { kind: 'evict', keys };
}

function materializedRecordsMatching(
  session: ClientFeedSession,
  domain: string,
  field: string,
  value: string
): Array<[string, Record<string, unknown>]> {
  const prefix = `${domain}\0`;
  return [...session.materializedRecords.entries()].filter(([key, record]) =>
    key.startsWith(prefix) && record[field] === value
  );
}

function recordStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === 'string' && value ? value : undefined;
}

function recordTemporalKey(domain: string, record: Record<string, unknown>, id: string): string {
  const messageSequence = runtimeNonNegativeBigInt(record.message_seq);
  if (messageSequence !== undefined) return `${messageSequence.toString().padStart(32, '0')}\0${id}`;
  if (domain === 'ModelRequest') {
    const requestSequence = runtimeNonNegativeBigInt(record.request_seq) ?? 0n;
    const createdAt = typeof record.created_at === 'string' ? Date.parse(record.created_at) : 0;
    const createdKey = Number.isFinite(createdAt) ? String(createdAt).padStart(16, '0') : '0000000000000000';
    return `${createdKey}\0${requestSequence.toString().padStart(32, '0')}\0${id}`;
  }
  for (const field of [
    'updated_at',
    'created_at',
    'received_at',
    'started_at',
    'completed_at',
    'decided_at',
    'handled_at'
  ]) {
    const value = record[field];
    if (typeof value !== 'string') continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return `${String(timestamp).padStart(16, '0')}\0${id}`;
  }
  return `0000000000000000\0${id}`;
}

function recordIdFromKey(key: string): string {
  const separator = key.indexOf('\0');
  if (separator < 0 || separator === key.length - 1) throw new Error(`Invalid typed client record key: ${key}`);
  return key.slice(separator + 1);
}

function recordDomainFromKey(key: string): string {
  const separator = key.indexOf('\0');
  if (separator <= 0) throw new Error(`Invalid typed client record key: ${key}`);
  return key.slice(0, separator);
}

function isPlainRecord(value: PlainData | undefined): value is { [key: string]: PlainData } {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function detailRawByteLimit(requestedMaxBytes: number): number {
  // Base64 expands 4/3; reserve envelope space and enforce the actual encoded response below.
  return Math.min(
    requestedMaxBytes,
    Math.floor((CLIENT_DETAIL_MAX_RESPONSE_BYTES - 2048) * 3 / 4)
  );
}

function runtimeNonNegativeSafeInteger(value: unknown, label: string): number {
  const integer = requireRuntimeNonNegativeBigInt(value, label);
  if (integer > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return Number(integer);
}

function requireRuntimeNonNegativeBigInt(value: unknown, label: string): bigint {
  const integer = typeof value === 'bigint'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value)
      ? BigInt(value)
      : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)
        ? BigInt(value)
        : undefined;
  if (integer === undefined || integer < 0n) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return integer;
}

function compareRuntimeIntegers(left: unknown, right: unknown): number {
  const leftValue = runtimeNonNegativeSafeInteger(left, 'left runtime integer');
  const rightValue = runtimeNonNegativeSafeInteger(right, 'right runtime integer');
  return leftValue - rightValue;
}

function firstChunkEndingAfter(chunks: readonly ProcessStreamChunkIndexEntry[], offset: number): number {
  let low = 0;
  let high = chunks.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    const candidate = chunks[middle]!;
    if (candidate.offset + candidate.byteLength <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function incompleteUtf8TailLength(bytes: Buffer): number {
  let leadingIndex = bytes.byteLength - 1;
  while (leadingIndex >= 0 && (bytes[leadingIndex]! & 0xc0) === 0x80) leadingIndex -= 1;
  if (leadingIndex < 0) return 0;
  const leading = bytes[leadingIndex]!;
  const expectedLength = leading >= 0xc2 && leading <= 0xdf
    ? 2
    : leading >= 0xe0 && leading <= 0xef
      ? 3
      : leading >= 0xf0 && leading <= 0xf4
        ? 4
        : 1;
  const available = bytes.byteLength - leadingIndex;
  return expectedLength > available ? available : 0;
}

function buildDetailChunk(
  recordId: string,
  offset: number,
  chunk: Buffer,
  totalBytes: number
): ClientDetailChunk {
  const nextOffsetValue = offset + chunk.length;
  const hasMore = nextOffsetValue < totalBytes;
  const response: ClientDetailChunk = {
    recordId,
    offset,
    chunk: chunk.toString('base64'),
    encoding: 'base64',
    ...(hasMore ? { nextOffset: nextOffsetValue } : {}),
    totalBytes,
    hasMore,
    responseBytes: 0
  };
  response.responseBytes = wireBytes(response);
  if (response.responseBytes > CLIENT_DETAIL_MAX_RESPONSE_BYTES) {
    throw new Error('Detail chunk exceeds maxResponseBytes after wire encoding.');
  }
  return response;
}

function boundProjectionRecords(projections: Record<string, PlainData>): Record<string, PlainData> {
  const visit = (value: PlainData): PlainData => {
    if (Array.isArray(value)) {
      return value.map((entry) => {
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) return boundRecord(entry);
        return visit(entry);
      });
    }
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([nestedKey, nested]) => [nestedKey, visit(nested)]));
  };
  return visit(projections) as Record<string, PlainData>;
}

function enforceSnapshotBounds(message: ReliableKernelSnapshotMessage): void {
  let bytes = wireBytes(message);
  if (bytes <= CLIENT_SNAPSHOT_MAX_BYTES) return;
  const activeWindow = requireSnapshotSection(message.projections, 'activeConversationWindow');
  const activeConversationId = typeof activeWindow.conversationId === 'string'
    ? activeWindow.conversationId
    : undefined;
  while (bytes > CLIENT_SNAPSHOT_MAX_BYTES) {
    const candidates = snapshotRetentionCandidates(message.projections, activeConversationId);
    const target = candidates.sort((left, right) =>
      right.weight - left.weight || right.eligibleCount - left.eligibleCount || left.key.localeCompare(right.key)
    )[0];
    if (!target) throw new Error('Client snapshot fixed envelope exceeds maxBytes.');
    const averageRecordBytes = Math.max(1, Math.ceil(target.weight / target.values.length));
    const desired = Math.max(1, Math.ceil((bytes - CLIENT_SNAPSHOT_MAX_BYTES) / averageRecordBytes));
    const dropCount = Math.min(
      target.eligibleCount,
      Math.max(1, Math.min(Math.ceil(target.eligibleCount / 4), desired))
    );
    dropOldestSnapshotRecords(target, dropCount);
    reconcileSnapshotCausalBundles(message.projections);
    bytes = wireBytes(message);
  }
}

interface SnapshotRetentionCandidate {
  key: string;
  values: PlainData[];
  direction: 'oldest-first' | 'newest-first';
  protectedIds?: ReadonlySet<string>;
  eligibleCount: number;
  weight: number;
}

/**
 * Only independently meaningful temporal anchors are eligible for byte-pressure trimming. Link and
 * child arrays are deliberately absent: `reconcileSnapshotCausalBundles` prunes them with their
 * anchor, so request↔message, tool↔source, message↔turn and process↔origin cannot be split by
 * an arbitrary longest-array pop.
 */
function snapshotRetentionCandidates(
  projections: Record<string, PlainData>,
  activeConversationId?: string
): SnapshotRetentionCandidate[] {
  const navigation = requireSnapshotSection(projections, 'navigationSummary');
  const window = requireSnapshotSection(projections, 'activeConversationWindow');
  const turns = requireSnapshotSection(projections, 'activeTurnSummary');
  const tools = requireSnapshotSection(projections, 'activeToolAndInteractionSummary');
  const subagents = requireSnapshotSection(projections, 'subagentDeliverySummary');
  const protectedMessageIds = snapshotProtectedMessageIds(window, turns, tools, subagents);
  const candidates: SnapshotRetentionCandidate[] = [];
  const add = (
    section: Record<string, PlainData>,
    key: string,
    direction: SnapshotRetentionCandidate['direction'],
    protectedIds?: ReadonlySet<string>
  ): void => {
    const values = snapshotArray(section, key);
    const eligibleCount = protectedIds
      ? values.filter((value) => !protectedIds.has(snapshotRecordId(value) ?? '')).length
      : values.length;
    if (eligibleCount === 0) return;
    candidates.push({
      key,
      values,
      direction,
      ...(protectedIds ? { protectedIds } : {}),
      eligibleCount,
      weight: wireBytes(values)
    });
  };

  add(
    navigation,
    'conversations',
    'newest-first',
    activeConversationId ? new Set([activeConversationId]) : undefined
  );
  add(window, 'messages', 'oldest-first', protectedMessageIds);
  add(window, 'conversationReuseLinks', 'newest-first');
  add(window, 'conversationBranchLinks', 'newest-first');
  add(window, 'conversationOriginLinks', 'newest-first');
  add(window, 'commandReceipts', 'newest-first');
  add(window, 'compressionBlocks', 'oldest-first');
  add(subagents, 'collaborationMessages', 'newest-first');
  return candidates;
}

function dropOldestSnapshotRecords(target: SnapshotRetentionCandidate, count: number): void {
  let remaining = count;
  while (remaining > 0 && target.values.length > 0) {
    let index = target.direction === 'oldest-first' ? 0 : target.values.length - 1;
    if (target.protectedIds) {
      while (
        index >= 0
        && index < target.values.length
        && target.protectedIds.has(snapshotRecordId(target.values[index]) ?? '')
      ) {
        index += target.direction === 'oldest-first' ? 1 : -1;
      }
    }
    if (index < 0 || index >= target.values.length) return;
    target.values.splice(index, 1);
    remaining -= 1;
  }
}

function snapshotProtectedMessageIds(
  window: Record<string, PlainData>,
  turns: Record<string, PlainData>,
  tools: Record<string, PlainData>,
  subagents: Record<string, PlainData>
): Set<string> {
  const protectedToolIds = new Set(snapshotArray(tools, 'toolCalls').flatMap((toolCall) => {
    const status = snapshotField(toolCall, 'status');
    return status && status !== 'terminal' ? [snapshotRecordId(toolCall) ?? ''] : [];
  }).filter(Boolean));
  const processOriginById = new Map(snapshotArray(tools, 'processOriginLinks').flatMap((link) => {
    const processId = snapshotField(link, 'process_id');
    const toolCallId = snapshotField(link, 'tool_call_id');
    return processId && toolCallId ? [[processId, toolCallId] as const] : [];
  }));
  for (const process of snapshotArray(tools, 'processes')) {
    if (snapshotField(process, 'status') !== 'running') continue;
    const toolCallId = processOriginById.get(snapshotRecordId(process) ?? '');
    if (toolCallId) protectedToolIds.add(toolCallId);
  }
  const interactionToolByRequest = new Map(snapshotArray(tools, 'interactionToolCallLinks').flatMap((link) => {
    const requestId = snapshotField(link, 'request_id');
    const toolCallId = snapshotField(link, 'tool_call_id');
    return requestId && toolCallId ? [[requestId, toolCallId] as const] : [];
  }));
  for (const request of snapshotArray(tools, 'interactionRequests')) {
    if (snapshotField(request, 'status') !== 'pending') continue;
    const toolCallId = interactionToolByRequest.get(snapshotRecordId(request) ?? '');
    if (toolCallId) protectedToolIds.add(toolCallId);
  }
  const activeChildIds = new Set(snapshotArray(subagents, 'childExecutions').flatMap((child) => {
    const status = snapshotField(child, 'status');
    return status && status !== 'closed' && status !== 'needs_human'
      ? [snapshotRecordId(child) ?? '']
      : [];
  }).filter(Boolean));
  for (const link of snapshotArray(subagents, 'childExecutionParentLinks')) {
    if (!activeChildIds.has(snapshotField(link, 'child_execution_id') ?? '')) continue;
    const toolCallId = snapshotField(link, 'source_tool_call_id');
    if (toolCallId) protectedToolIds.add(toolCallId);
  }
  const protectedRequestIds = new Set(snapshotArray(turns, 'modelRequests').flatMap((request) => {
    const status = snapshotField(request, 'status');
    return status && status !== 'terminal' ? [snapshotRecordId(request) ?? ''] : [];
  }).filter(Boolean));
  const protectedMessageIds = new Set<string>();
  for (const link of snapshotArray(tools, 'toolCallSourceLinks')) {
    if (!protectedToolIds.has(snapshotField(link, 'tool_call_id') ?? '')) continue;
    const messageId = snapshotField(link, 'message_id');
    if (messageId) protectedMessageIds.add(messageId);
  }
  for (const link of snapshotArray(turns, 'modelRequestMessageLinks')) {
    if (!protectedRequestIds.has(snapshotField(link, 'model_request_id') ?? '')) continue;
    const messageId = snapshotField(link, 'message_id');
    if (messageId) protectedMessageIds.add(messageId);
  }
  const currentTaskList = window.currentTaskList;
  if (isPlainRecord(currentTaskList)) {
    const sourceMessageId = snapshotField(currentTaskList, 'sourceMessageId');
    if (sourceMessageId) protectedMessageIds.add(sourceMessageId);
  }
  return protectedMessageIds;
}

function reconcileSnapshotCausalBundles(projections: Record<string, PlainData>): void {
  const window = requireSnapshotSection(projections, 'activeConversationWindow');
  const turns = requireSnapshotSection(projections, 'activeTurnSummary');
  const tools = requireSnapshotSection(projections, 'activeToolAndInteractionSummary');
  const subagents = requireSnapshotSection(projections, 'subagentDeliverySummary');

  let messageIds = snapshotIds(window, 'messages');
  const requestMessageLinks = snapshotArray(turns, 'modelRequestMessageLinks');
  const linkedRequestIds = new Set(requestMessageLinks.flatMap((link) => {
    const id = snapshotField(link, 'model_request_id');
    return id ? [id] : [];
  }));
  filterSnapshotArray(turns, 'modelRequests', (request) => {
    const id = snapshotRecordId(request);
    if (!id) return false;
    if (snapshotField(request, 'status') !== 'terminal') return true;
    if (!linkedRequestIds.has(id)) return true;
    return requestMessageLinks.some((link) =>
      snapshotField(link, 'model_request_id') === id
      && messageIds.has(snapshotField(link, 'message_id') ?? '')
    );
  });
  let requestIds = snapshotIds(turns, 'modelRequests');

  const sourceLinks = snapshotArray(tools, 'toolCallSourceLinks');
  filterSnapshotArray(tools, 'toolCalls', (toolCall) => {
    const id = snapshotRecordId(toolCall);
    if (!id) return false;
    return sourceLinks.some((link) =>
      snapshotField(link, 'tool_call_id') === id
      && messageIds.has(snapshotField(link, 'message_id') ?? '')
      && requestIds.has(snapshotField(link, 'model_request_id') ?? '')
    );
  });
  let toolCallIds = snapshotIds(tools, 'toolCalls');

  const interactionToolLinks = snapshotArray(tools, 'interactionToolCallLinks');
  const interactionOwnerLinks = snapshotArray(tools, 'interactionOwnerLinks');
  filterSnapshotArray(tools, 'interactionRequests', (request) => {
    const requestId = snapshotRecordId(request);
    return Boolean(
      requestId
      && interactionOwnerLinks.some((link) => snapshotField(link, 'request_id') === requestId)
      && interactionToolLinks.some((link) =>
        snapshotField(link, 'request_id') === requestId
        && toolCallIds.has(snapshotField(link, 'tool_call_id') ?? '')
      )
    );
  });
  const interactionIdsBeforeTurnPrune = snapshotIds(tools, 'interactionRequests');

  const processOriginLinks = snapshotArray(tools, 'processOriginLinks');
  filterSnapshotArray(tools, 'processes', (process) => {
    const processId = snapshotRecordId(process);
    return Boolean(processId && processOriginLinks.some((link) =>
      snapshotField(link, 'process_id') === processId
      && toolCallIds.has(snapshotField(link, 'tool_call_id') ?? '')
    ));
  });
  let processIds = snapshotIds(tools, 'processes');

  const childParentLinks = snapshotArray(subagents, 'childExecutionParentLinks');
  const activeConversationId = snapshotField(window, 'conversationId')
    ?? (typeof window.conversationId === 'string' ? window.conversationId : undefined);
  filterSnapshotArray(subagents, 'childExecutions', (child) => {
    const childId = snapshotRecordId(child);
    if (!childId) return false;
    if (activeConversationId && snapshotField(child, 'child_conversation_id') === activeConversationId) return true;
    return childParentLinks.some((link) =>
      snapshotField(link, 'child_execution_id') === childId
      && toolCallIds.has(snapshotField(link, 'source_tool_call_id') ?? '')
    );
  });
  const childIdsBeforeTurnPrune = snapshotIds(subagents, 'childExecutions');

  const retainedTurnIds = new Set(snapshotArray(turns, 'turns').flatMap((turn) =>
    snapshotField(turn, 'status') === 'active' ? [snapshotRecordId(turn) ?? ''] : []
  ).filter(Boolean));
  const messageTurnLinks = snapshotArray(tools, 'messageTurnLinks');
  for (const link of messageTurnLinks) {
    const messageId = snapshotField(link, 'message_id');
    const turnId = snapshotField(link, 'turn_id');
    if (messageId && turnId && messageIds.has(messageId)) retainedTurnIds.add(turnId);
  }
  for (const request of snapshotArray(turns, 'modelRequests')) {
    const turnId = snapshotField(request, 'turn_id');
    if (turnId) retainedTurnIds.add(turnId);
  }
  for (const toolCall of snapshotArray(tools, 'toolCalls')) {
    const turnId = snapshotField(toolCall, 'turn_id');
    if (turnId) retainedTurnIds.add(turnId);
  }
  for (const link of interactionOwnerLinks) {
    if (!interactionIdsBeforeTurnPrune.has(snapshotField(link, 'request_id') ?? '')) continue;
    const turnId = snapshotField(link, 'turn_id');
    if (turnId) retainedTurnIds.add(turnId);
  }
  filterSnapshotArray(turns, 'turns', (turn) => retainedTurnIds.has(snapshotRecordId(turn) ?? ''));

  // Re-read anchor sets after cascades, then retain every dependent fact only with its owner.
  let turnIds = snapshotIds(turns, 'turns');
  messageIds = snapshotIds(window, 'messages');
  requestIds = snapshotIds(turns, 'modelRequests');
  filterSnapshotArray(turns, 'modelContextProjections', (projection) =>
    snapshotField(projection, 'owner_kind') === 'model_request'
    && requestIds.has(snapshotField(projection, 'owner_id') ?? '')
  );
  toolCallIds = snapshotIds(tools, 'toolCalls');
  processIds = snapshotIds(tools, 'processes');
  filterSnapshotReference(turns, 'executionLeases', 'turn_id', turnIds);
  filterSnapshotReference(turns, 'turnTerminations', 'turn_id', turnIds);
  filterSnapshotReference(turns, 'turnExecutorLinks', 'turn_id', turnIds);
  filterSnapshotArray(turns, 'modelRequestMessageLinks', (link) =>
    requestIds.has(snapshotField(link, 'model_request_id') ?? '')
    && messageIds.has(snapshotField(link, 'message_id') ?? '')
  );
  filterSnapshotArray(tools, 'messageTurnLinks', (link) =>
    messageIds.has(snapshotField(link, 'message_id') ?? '')
    && turnIds.has(snapshotField(link, 'turn_id') ?? '')
  );
  filterSnapshotArray(tools, 'toolCallSourceLinks', (link) => {
    const requestId = snapshotField(link, 'model_request_id');
    const messageId = snapshotField(link, 'message_id');
    return toolCallIds.has(snapshotField(link, 'tool_call_id') ?? '')
      && (!requestId || requestIds.has(requestId))
      && (!messageId || messageIds.has(messageId));
  });
  for (const key of [
    'toolCallPolicySnapshots',
    'toolCallEvents',
    'toolExecutions',
    'toolOutcomes',
    'toolModelResults',
    'toolResultArtifacts'
  ]) filterSnapshotReference(tools, key, 'tool_call_id', toolCallIds);
  filterSnapshotReference(window, 'taskList', 'tool_call_id', toolCallIds);

  const retainedInteractionRequestIds = snapshotIds(tools, 'interactionRequests');
  const ownerLinks = snapshotArray(tools, 'interactionOwnerLinks')
    .filter((link) =>
      turnIds.has(snapshotField(link, 'turn_id') ?? '')
      && retainedInteractionRequestIds.has(snapshotField(link, 'request_id') ?? '')
    );
  tools.interactionOwnerLinks = ownerLinks;
  const interactionIds = new Set(ownerLinks.flatMap((link) => {
    const id = snapshotField(link, 'request_id');
    return id ? [id] : [];
  }));
  filterSnapshotArray(tools, 'interactionRequests', (request) => interactionIds.has(snapshotRecordId(request) ?? ''));
  filterSnapshotArray(tools, 'interactionToolCallLinks', (link) =>
    interactionIds.has(snapshotField(link, 'request_id') ?? '')
    && toolCallIds.has(snapshotField(link, 'tool_call_id') ?? '')
  );
  filterSnapshotReference(tools, 'interactionResponses', 'request_id', interactionIds);

  filterSnapshotReference(tools, 'fileChangeSets', 'tool_call_id', toolCallIds);
  const changeSetIds = snapshotIds(tools, 'fileChangeSets');
  filterSnapshotReference(tools, 'fileChangeSetMembers', 'change_set_id', changeSetIds);
  filterSnapshotReference(tools, 'fileChangeDecisions', 'change_set_id', changeSetIds);
  filterSnapshotReference(tools, 'fileMutationReceipts', 'change_set_id', changeSetIds);
  const mutationReceiptIds = snapshotIds(tools, 'fileMutationReceipts');
  filterSnapshotReference(tools, 'fileMutationReceiptMembers', 'receipt_id', mutationReceiptIds);

  filterSnapshotArray(tools, 'processOriginLinks', (link) =>
    processIds.has(snapshotField(link, 'process_id') ?? '')
    && toolCallIds.has(snapshotField(link, 'tool_call_id') ?? '')
  );
  filterSnapshotReference(tools, 'processOutputChunks', 'process_id', processIds);
  filterSnapshotReference(tools, 'processReceipts', 'process_id', processIds);

  const projectLinkIds = snapshotArray(window, 'conversationProjectLinks');
  const projectContextIds = new Set(projectLinkIds.flatMap((link) => {
    const id = snapshotField(link, 'project_context_id');
    return id ? [id] : [];
  }));
  filterSnapshotArray(window, 'projectContexts', (context) => projectContextIds.has(snapshotRecordId(context) ?? ''));

  const childIds = snapshotIds(subagents, 'childExecutions');
  const retainedChildConversationIds = new Set(snapshotArray(subagents, 'childExecutions').flatMap((child) => {
    const id = snapshotField(child, 'child_conversation_id');
    return id ? [id] : [];
  }));
  filterSnapshotArray(window, 'agentConversationLinks', (link) => {
    const conversationId = snapshotField(link, 'conversation_id');
    return Boolean(conversationId && (
      conversationId === activeConversationId
      || retainedChildConversationIds.has(conversationId)
    ));
  });
  for (const key of [
    'childExecutionParentLinks',
    'childExecutionTurnLinks',
    'childExecutionActiveTurnLinks'
  ]) filterSnapshotReference(subagents, key, 'child_execution_id', childIds);
  const childTurnIds = new Set([
    ...snapshotArray(subagents, 'childExecutionTurnLinks'),
    ...snapshotArray(subagents, 'childExecutionActiveTurnLinks')
  ].flatMap((link) => {
    const id = snapshotField(link, 'turn_id');
    return id ? [id] : [];
  }));
  filterSnapshotArray(subagents, 'childTurns', (turn) => childTurnIds.has(snapshotRecordId(turn) ?? ''));
  filterSnapshotReference(subagents, 'childExecutionLeases', 'turn_id', childTurnIds);
  filterSnapshotReference(subagents, 'childTurnTerminations', 'turn_id', childTurnIds);
  filterSnapshotReference(subagents, 'childTurnExecutorLinks', 'turn_id', childTurnIds);
  filterSnapshotReference(subagents, 'childExecutionActivities', 'child_execution_id', childIds);
  filterSnapshotReference(subagents, 'answerBridges', 'child_execution_id', childIds);
  const answerBridgeIds = snapshotIds(subagents, 'answerBridges');
  filterSnapshotReference(subagents, 'answerSubmissions', 'answer_bridge_id', answerBridgeIds);

  const collaborationMessageIds = snapshotIds(subagents, 'collaborationMessages');
  for (const key of ['collaborationMessageSourceLinks', 'collaborationMessageTargetLinks',
    'collaborationMessageReplyLinks', 'collaborationRequests']) {
    filterSnapshotReference(subagents, key, 'message_id', collaborationMessageIds);
  }
  filterSnapshotReference(subagents, 'collaborationRequestTurnLinks', 'request_id',
    snapshotIds(subagents, 'collaborationRequests'));

  const deliveryIds = snapshotIds(subagents, 'runtimeDeliveries');
  const queuedTurnIntentIds = snapshotIds(window, 'queuedTurnIntents');
  filterSnapshotArray(subagents, 'runtimeDeliveryIntentLinks', (link) =>
    deliveryIds.has(snapshotField(link, 'delivery_id') ?? '')
    && queuedTurnIntentIds.has(snapshotField(link, 'turn_intent_id') ?? '')
  );
  const inboxIds = new Set(snapshotArray(subagents, 'runtimeDeliveries').flatMap((delivery) => {
    const id = snapshotField(delivery, 'inbox_item_id');
    return id ? [id] : [];
  }));
  filterSnapshotArray(subagents, 'runtimeInboxItems', (item) => inboxIds.has(snapshotRecordId(item) ?? ''));
  if (deliveryIds.size === 0) subagents.runtimeInboxItems = [];
}

function requireSnapshotSection(
  projections: Record<string, PlainData>,
  key: string
): Record<string, PlainData> {
  const section = projections[key];
  if (!isPlainRecord(section)) throw new Error(`Client snapshot is missing ${key}.`);
  return section;
}

function snapshotArray(section: Record<string, PlainData>, key: string): PlainData[] {
  const value = section[key];
  if (!Array.isArray(value)) throw new Error(`Client snapshot projection ${key} must be an array.`);
  return value;
}

function snapshotRecordId(value: PlainData | undefined): string | undefined {
  return isPlainRecord(value) && typeof value.id === 'string' ? value.id : undefined;
}

function snapshotField(value: PlainData | undefined, field: string): string | undefined {
  if (!isPlainRecord(value)) return undefined;
  const fieldValue = value[field];
  return typeof fieldValue === 'string' && fieldValue ? fieldValue : undefined;
}

function snapshotIds(section: Record<string, PlainData>, key: string): Set<string> {
  return new Set(snapshotArray(section, key).flatMap((value) => {
    const id = snapshotRecordId(value);
    return id ? [id] : [];
  }));
}

function removeSnapshotIds(section: Record<string, PlainData>, key: string, ids: Set<string>): void {
  if (ids.size === 0) return;
  filterSnapshotArray(section, key, (value) => !ids.has(snapshotRecordId(value) ?? ''));
}

function filterSnapshotReference(
  section: Record<string, PlainData>,
  key: string,
  field: string,
  retainedIds: Set<string>
): void {
  filterSnapshotArray(section, key, (value) => retainedIds.has(snapshotField(value, field) ?? ''));
}

function filterSnapshotArray(
  section: Record<string, PlainData>,
  key: string,
  retain: (value: PlainData) => boolean
): void {
  section[key] = snapshotArray(section, key).filter(retain);
}

function requireDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string.`);
  }
  return value;
}
