import {
  toStructuredClonePlainData,
  type PlainData
} from './plainData';

export const RELIABLE_KERNEL_SNAPSHOT_MESSAGE = 'reliable-kernel.snapshot';
export const RELIABLE_KERNEL_CHANGES_MESSAGE = 'reliable-kernel.changes';
export const RELIABLE_KERNEL_ACK_MESSAGE = 'reliable-kernel.ack';
export const RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE = 'reliable-kernel.snapshot-request';
export const RELIABLE_KERNEL_DETAIL_REQUEST_MESSAGE = 'reliable-kernel.detail-request';
export const RELIABLE_KERNEL_DETAIL_RESULT_MESSAGE = 'reliable-kernel.detail-result';
export const RELIABLE_KERNEL_DETAIL_ERROR_MESSAGE = 'reliable-kernel.detail-error';
export const RELIABLE_KERNEL_HISTORY_PAGE_REQUEST_MESSAGE = 'reliable-kernel.history-page-request';
export const RELIABLE_KERNEL_HISTORY_PAGE_RESULT_MESSAGE = 'reliable-kernel.history-page-result';
export const RELIABLE_KERNEL_HISTORY_PAGE_ERROR_MESSAGE = 'reliable-kernel.history-page-error';
export const RELIABLE_KERNEL_TRANSIENT_MESSAGE = 'reliable-kernel.transient';
export const RELIABLE_KERNEL_TRANSIENT_BATCH_MESSAGE = 'reliable-kernel.transient-batch';
export const RELIABLE_KERNEL_TRANSIENT_ACK_MESSAGE = 'reliable-kernel.transient-ack';
export const RELIABLE_KERNEL_TRANSIENT_SNAPSHOT_REQUEST_MESSAGE = 'reliable-kernel.transient-snapshot-request';
export const RELIABLE_KERNEL_TRANSIENT_SNAPSHOT_MESSAGE = 'reliable-kernel.transient-snapshot';
export const RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE = 'reliable-kernel.client-diagnostic';

export interface ReliableKernelClientChange {
  type: string;
  operation: 'upsert' | 'remove';
  id: string;
  record?: { [key: string]: PlainData };
  /** The durable record still exists; only the bounded live projection is releasing it. */
  removalCause?: 'window-eviction';
}

/** Read-only work-environment authority for the selected Conversation's active Turn. */
export interface ActiveTurnWorkEnvironmentProjection {
  conversationId: string;
  turnId: string;
  enabled: boolean;
  defaultWorkEnvironmentId: string | null;
  allowedWorkEnvironmentIds: string[];
}

export interface ReliableKernelSnapshotMessage {
  type: typeof RELIABLE_KERNEL_SNAPSHOT_MESSAGE;
  sessionId: string;
  hostBootId: string;
  messageSeq: string;
  /** Webview navigation generation, attached by the host bridge. */
  navigationGeneration?: string;
  snapshotCommitSeq: string;
  projections: { [key: string]: PlainData };
}

export interface ReliableKernelChangesMessage {
  type: typeof RELIABLE_KERNEL_CHANGES_MESSAGE;
  sessionId: string;
  hostBootId: string;
  messageSeq: string;
  /** Webview navigation generation, attached by the host bridge. */
  navigationGeneration?: string;
  commitSeq: string;
  changes: ReliableKernelClientChange[];
}

export interface ReliableKernelAckMessage {
  type: typeof RELIABLE_KERNEL_ACK_MESSAGE;
  sessionId: string;
  hostBootId: string;
  messageSeq: string;
}

export interface ReliableKernelSnapshotRequestMessage {
  type: typeof RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE;
  sessionId?: string;
  activeConversationId?: string;
}

export type ReliableKernelClientDetailKind =
  | 'message-content'
  | 'turn-intent-preview'
  | 'tool-arguments-content'
  | 'tool-result-content'
  | 'tool-event-content'
  | 'interaction-prompt'
  | 'file-change-base-content'
  | 'file-change-content'
  | 'file-change-diff'
  | 'process-output'
  | 'process-stdout'
  | 'process-stderr'
  | 'context-projection-detail'
  | 'model-request-purpose'
  | 'compression-presentation'
  | 'compression-content'
  | 'compression-title'
  | 'answer-content';

export interface ReliableKernelGuidanceTurnIntentPreview {
  version: 3;
  kind: 'guidance';
  text: string;
  editorText: string;
  hasAttachments: boolean;
  truncated: boolean;
  revisionSeq: string;
  position: string;
  hold: 'none' | 'paused';
}

export interface ReliableKernelBackgroundProcessContinuationSource {
  kind: 'background_process';
  inboxItemId: string;
  sourceId: string;
  processId: string;
  processReceiptId: string;
  processStatus: string;
  outcome: string;
  commandPreview?: string;
  toolCallId?: string;
  exitCode?: string;
  exitSignal?: string;
}

export interface ReliableKernelSubagentContinuationSource {
  kind: 'subagent';
  inboxItemId: string;
  sourceId: string;
  submissionId: string;
  childExecutionId: string;
  childConversationId: string;
  childStatus: string;
  interrupted: boolean;
  agentId?: string;
  title?: string;
}

export interface ReliableKernelCollaborationContinuationSource {
  kind: 'collaboration_message';
  inboxItemId: string;
  sourceId: string;
  sourceConversationId: string;
  mode: 'message' | 'followup';
  textPreview: string;
}

export type ReliableKernelRuntimeContinuationSource =
  | ReliableKernelBackgroundProcessContinuationSource
  | ReliableKernelSubagentContinuationSource
  | ReliableKernelCollaborationContinuationSource;

export interface ReliableKernelRuntimeContinuationTurnIntentPreview {
  version: 3;
  kind: 'runtime_continuation';
  revisionSeq: string;
  sourceTurnId: string;
  deliveryId: string;
  deliveryState: string;
  phase: string;
  source: ReliableKernelRuntimeContinuationSource;
}

export type ReliableKernelTurnIntentPreview =
  | ReliableKernelGuidanceTurnIntentPreview
  | ReliableKernelRuntimeContinuationTurnIntentPreview;

export interface ReliableKernelDetailRequestMessage {
  type: typeof RELIABLE_KERNEL_DETAIL_REQUEST_MESSAGE;
  requestId: string;
  sessionId?: string;
  kind: ReliableKernelClientDetailKind;
  recordId: string;
  offset: number;
  maxBytes: number;
  /** Freezes a mutable detail prefix after the first page; omitted on a new demand or refresh. */
  expectedTotalBytes?: number;
}

export interface ReliableKernelDetailResultMessage {
  type: typeof RELIABLE_KERNEL_DETAIL_RESULT_MESSAGE;
  requestId: string;
  sessionId: string;
  detail: {
    recordId: string;
    offset: number;
    chunk: string;
    encoding: 'base64';
    nextOffset?: number;
    totalBytes: number;
    hasMore: boolean;
    responseBytes: number;
  };
}

export interface ReliableKernelDetailErrorMessage {
  type: typeof RELIABLE_KERNEL_DETAIL_ERROR_MESSAGE;
  requestId: string;
  sessionId: string;
  message: string;
}

export interface ReliableKernelHistoryPageRequestMessage {
  type: typeof RELIABLE_KERNEL_HISTORY_PAGE_REQUEST_MESSAGE;
  requestId: string;
  sessionId?: string;
  conversationId: string;
  /** Exclusive backward keyset cursor in durable Message membership order. */
  beforeMessageSeq: string;
  beforeId: string;
  limit: number;
}

export interface ReliableKernelHistoryPage {
  records: Record<string, Array<Record<string, PlainData>>>;
  nextBeforeMessageSeq?: string;
  nextBeforeId?: string;
  hasMore: boolean;
  responseBytes: number;
}

export interface ReliableKernelHistoryPageResultMessage {
  type: typeof RELIABLE_KERNEL_HISTORY_PAGE_RESULT_MESSAGE;
  requestId: string;
  sessionId: string;
  conversationId: string;
  page: ReliableKernelHistoryPage;
}

export interface ReliableKernelHistoryPageErrorMessage {
  type: typeof RELIABLE_KERNEL_HISTORY_PAGE_ERROR_MESSAGE;
  requestId: string;
  sessionId: string;
  conversationId: string;
  message: string;
}

/** Memory-only low-latency stream overlay. Durable final authority remains Message/ModelRequest. */
export interface ReliableKernelTransientMessage {
  type: typeof RELIABLE_KERNEL_TRANSIENT_MESSAGE;
  /** Exact bounded-feed session. Navigation creates a new session and retires old overlays. */
  sessionId: string;
  navigationGeneration?: string;
  hostBootId: string;
  conversationId: string;
  turnId: string;
  modelRequestId: string;
  /** Frozen durable request identity; never derived from the current UI model selection. */
  requestSeq: string;
  providerId: string;
  modelId: string;
  /** Provider retry identity. A changed attempt/generation starts a fresh transient accumulator. */
  attemptSeq: string;
  socketGeneration: string;
  /** Durable feed frontier that must be painted before this overlay is causally displayable. */
  afterCommitSeq: string;
  /** First provider sequence represented by this event after bounded bridge coalescing. */
  fromStreamSeq: string;
  observedAt: string;
  event: {
    kind: 'output_delta' | 'output_item_done' | 'completed' | 'failed' | 'cancelled';
    streamSeq: string;
    content: PlainData;
    usage?: PlainData;
    timing?: {
      providerStartedAt?: number;
      firstOutputAt?: number;
      completedAt?: number;
      streamOutputDurationMs?: number;
    };
  };
}

export type ReliableKernelTransientBatchItem = Omit<
  ReliableKernelTransientMessage,
  'type' | 'sessionId' | 'navigationGeneration' | 'hostBootId' | 'conversationId'
>;

/** One bounded IPC envelope for an ordered burst of memory-only stream events. */
export interface ReliableKernelTransientBatchMessage {
  type: typeof RELIABLE_KERNEL_TRANSIENT_BATCH_MESSAGE;
  deliveryId: string;
  sessionId: string;
  navigationGeneration?: string;
  hostBootId: string;
  conversationId: string;
  events: ReliableKernelTransientBatchItem[];
}

export interface ReliableKernelTransientRequestHead {
  modelRequestId: string;
  attemptSeq: string;
  socketGeneration: string;
  streamSeq: string;
}

/** Transport receipt only; durable Feed commit acknowledgement remains a separate contract. */
export interface ReliableKernelTransientAckMessage {
  type: typeof RELIABLE_KERNEL_TRANSIENT_ACK_MESSAGE;
  deliveryId: string;
  sessionId: string;
  hostBootId: string;
  navigationGeneration?: string;
  heads: ReliableKernelTransientRequestHead[];
}

export interface ReliableKernelTransientSnapshotRequestMessage {
  type: typeof RELIABLE_KERNEL_TRANSIENT_SNAPSHOT_REQUEST_MESSAGE;
  requestId: string;
  sessionId: string;
  hostBootId: string;
  navigationGeneration?: string;
  conversationId: string;
  modelRequestId: string;
  attemptSeq: string;
  socketGeneration: string;
  /** Last contiguous sequence retained by the Webview; zero means no trusted prefix. */
  afterStreamSeq: string;
}

/** A cumulative, memory-only replay projection for one exact Provider request attempt. */
export interface ReliableKernelTransientSnapshotMessage {
  type: typeof RELIABLE_KERNEL_TRANSIENT_SNAPSHOT_MESSAGE;
  deliveryId: string;
  requestId?: string;
  sessionId: string;
  hostBootId: string;
  navigationGeneration?: string;
  conversationId: string;
  turnId: string;
  modelRequestId: string;
  requestSeq: string;
  providerId: string;
  modelId: string;
  attemptSeq: string;
  socketGeneration: string;
  afterCommitSeq: string;
  headStreamSeq: string;
  observedAt: string;
  /** Coalesced semantic replay events in first-observed output order. */
  events: ReliableKernelTransientBatchItem[];
}

/** Client-reported paint/gap markers contain identities/timestamps only; arbitrary metadata is forbidden. */
export interface ReliableKernelClientDiagnosticMessage {
  type: typeof RELIABLE_KERNEL_CLIENT_DIAGNOSTIC_MESSAGE;
  sessionId: string;
  eventKind: 'feed-painted' | 'transient-painted' | 'transient-gap' | 'transient-snapshot-replayed' | 'transient-snapshot-rejected';
  observedAt: string;
  conversationId?: string;
  turnId?: string;
  messageSeq?: string;
  modelRequestId?: string;
  streamSeq?: string;
  attemptSeq?: string;
  socketGeneration?: string;
}

export type ReliableKernelDataMessage = ReliableKernelSnapshotMessage | ReliableKernelChangesMessage;

export interface ReliableKernelBoundedClientState {
  sessionId: string | null;
  hostBootId: string | null;
  lastMessageSeq: string | null;
  lastCommitSeq: string | null;
  projections: { [key: string]: PlainData };
  records: Record<string, Record<string, { [key: string]: PlainData }>>;
  snapshotRequired: boolean;
}

export interface ReliableKernelClientApplyResult {
  state: ReliableKernelBoundedClientState;
  ack?: ReliableKernelAckMessage;
  snapshotRequired: boolean;
  reason?: 'host-boot-mismatch' | 'session-mismatch' | 'message-gap' | 'commit-order' | 'unknown-change-type' | 'apply-failed';
}

export const RELIABLE_KERNEL_CLIENT_CHANGE_TYPES = new Set([
  'Conversation',
  'ProjectContext',
  'ConversationProjectLink',
  'ConversationReuseLink',
  'ConversationBranchLink',
  'ConversationOriginLink',
  'AgentConversationLink',
  'Turn',
  'TurnIntent',
  'ExecutionLease',
  'TurnTermination',
  'TurnExecutorLink',
  'Message',
  'MessageRevision',
  'MessageTurnLink',
  'InteractionRequest',
  'InteractionOwnerLink',
  'InteractionToolCallLink',
  'InteractionResponse',
  'ToolCall',
  'ToolCallSourceLink',
  'ToolCallPolicySnapshot',
  'ToolCallEvent',
  'ToolExecution',
  'ToolOutcome',
  'ToolModelResult',
  'ToolResultArtifact',
  'FileChangeSet',
  'FileChangeSetMember',
  'FileChangeDecision',
  'FileMutationReceipt',
  'FileMutationReceiptMember',
  'Process',
  'ProcessOriginLink',
  'ProcessOutputChunk',
  'ProcessReceipt',
  'ModelRequest',
  'ModelContextProjection',
  'ModelRequestMessageLink',
  'CompressionBlock',
  /** Derived bounded view; not a persisted Runtime domain or schema-manifest entry. */
  'ConversationContextStatus',
  /** Conversation-scoped durable acknowledgement; CommandReceipt itself remains client=none. */
  'ConversationCommandReceipt',
  'ChildExecution',
  'ChildExecutionParentLink',
  'ChildExecutionTurnLink',
  'ChildExecutionActiveTurnLink',
  /** Derived bounded view; child transcript and raw ToolCall rows remain isolated. */
  'ChildExecutionActivity',
  'AnswerBridge',
  'AnswerSubmission',
  'RuntimeInboxItem',
  'RuntimeDelivery',
  'RuntimeDeliveryIntentLink',
  'CollaborationMessage',
  'CollaborationMessageSourceLink',
  'CollaborationMessageTargetLink',
  'CollaborationMessageReplyLink',
  'CollaborationRequest',
  'CollaborationRequestTurnLink',
  'ConversationCommunicationLink'
] as const);

export function createEmptyReliableKernelClientState(): ReliableKernelBoundedClientState {
  return {
    sessionId: null,
    hostBootId: null,
    lastMessageSeq: null,
    lastCommitSeq: null,
    projections: {},
    records: {},
    snapshotRequired: true
  };
}

/**
 * Applies one host data message atomically. Any gap, unknown type or malformed record leaves the
 * prior records untouched and requests a fresh bounded snapshot.
 */
export function applyReliableKernelDataMessage(
  current: ReliableKernelBoundedClientState,
  messageInput: unknown
): ReliableKernelClientApplyResult {
  let message: ReliableKernelDataMessage;
  try {
    message = toStructuredClonePlainData(messageInput, 'client feed message') as unknown as ReliableKernelDataMessage;
  } catch {
    return requireSnapshot(current, 'apply-failed');
  }
  if (message.type === RELIABLE_KERNEL_SNAPSHOT_MESSAGE) {
    try {
      requireId(message.sessionId, 'snapshot.sessionId');
      requireId(message.hostBootId, 'snapshot.hostBootId');
      requireDecimal(message.messageSeq, 'snapshot.messageSeq');
      requireDecimal(message.snapshotCommitSeq, 'snapshot.snapshotCommitSeq');
      if (!message.projections || typeof message.projections !== 'object' || Array.isArray(message.projections)) {
        throw new TypeError('snapshot.projections must be an object.');
      }
      const projections = toStructuredClonePlainData(message.projections, 'snapshot.projections') as {
        [key: string]: PlainData;
      };
      const state: ReliableKernelBoundedClientState = {
        sessionId: message.sessionId,
        hostBootId: message.hostBootId,
        lastMessageSeq: message.messageSeq,
        lastCommitSeq: message.snapshotCommitSeq,
        projections,
        records: seedRecordsFromSnapshot(projections),
        snapshotRequired: false
      };
      return {
        state,
        snapshotRequired: false,
        ack: ackFor(message)
      };
    } catch {
      return requireSnapshot(current, 'apply-failed');
    }
  }
  if (message.type !== RELIABLE_KERNEL_CHANGES_MESSAGE) return requireSnapshot(current, 'unknown-change-type');
  if (current.hostBootId !== message.hostBootId) return requireSnapshot(current, 'host-boot-mismatch');
  if (current.sessionId !== message.sessionId) return requireSnapshot(current, 'session-mismatch');
  try {
    const messageSeq = requireDecimal(message.messageSeq, 'changes.messageSeq');
    const expectedMessageSeq = BigInt(requireDecimal(current.lastMessageSeq, 'state.lastMessageSeq')) + 1n;
    if (BigInt(messageSeq) !== expectedMessageSeq) return requireSnapshot(current, 'message-gap');
    const commitSeq = requireDecimal(message.commitSeq, 'changes.commitSeq');
    // commitSeq is a database frontier, not a transport sequence. Invisible commits are deliberately
    // omitted by the host, so the next visible commit may jump forward but may never repeat/regress.
    const priorCommitSeq = BigInt(requireDecimal(current.lastCommitSeq, 'state.lastCommitSeq'));
    if (BigInt(commitSeq) <= priorCommitSeq) return requireSnapshot(current, 'commit-order');
    if (!Array.isArray(message.changes)) throw new TypeError('changes.changes must be an array.');
    const nextRecords: ReliableKernelBoundedClientState['records'] = { ...current.records };
    const copiedTypes = new Set<string>();
    for (const change of message.changes) {
      if (!change || typeof change !== 'object' || Array.isArray(change)) throw new TypeError('Client change is invalid.');
      if (!RELIABLE_KERNEL_CLIENT_CHANGE_TYPES.has(change.type as never)) {
        return requireSnapshot(current, 'unknown-change-type');
      }
      const id = requireId(change.id, 'change.id');
      if (change.operation !== 'upsert' && change.operation !== 'remove') {
        throw new TypeError('Client change operation is invalid.');
      }
      if (!copiedTypes.has(change.type)) {
        nextRecords[change.type] = { ...(nextRecords[change.type] ?? {}) };
        copiedTypes.add(change.type);
      }
      if (change.operation === 'remove') {
        delete nextRecords[change.type][id];
        continue;
      }
      if (!change.record || typeof change.record !== 'object' || Array.isArray(change.record)) {
        throw new TypeError('Client upsert requires a record.');
      }
      const record = toStructuredClonePlainData(change.record, `change.${change.type}.${id}`) as {
        [key: string]: PlainData;
      };
      if (record.id !== id) throw new TypeError('Client upsert record id does not match change identity.');
      nextRecords[change.type][id] = record;
    }
    const state: ReliableKernelBoundedClientState = {
      ...current,
      lastMessageSeq: messageSeq,
      lastCommitSeq: commitSeq,
      records: nextRecords,
      snapshotRequired: false
    };
    return { state, snapshotRequired: false, ack: ackFor(message) };
  } catch {
    return requireSnapshot(current, 'apply-failed');
  }
}

function seedRecordsFromSnapshot(
  projections: { [key: string]: PlainData }
): ReliableKernelBoundedClientState['records'] {
  const records: ReliableKernelBoundedClientState['records'] = {};
  const arrayKeyToType: Record<string, string> = {
    conversations: 'Conversation',
    projectContexts: 'ProjectContext',
    conversationProjectLinks: 'ConversationProjectLink',
    conversationReuseLinks: 'ConversationReuseLink',
    conversationBranchLinks: 'ConversationBranchLink',
    conversationOriginLinks: 'ConversationOriginLink',
    agentConversationLinks: 'AgentConversationLink',
    commandReceipts: 'ConversationCommandReceipt',
    messages: 'Message',
    queuedTurnIntents: 'TurnIntent',
    turns: 'Turn',
    executionLeases: 'ExecutionLease',
    turnTerminations: 'TurnTermination',
    turnExecutorLinks: 'TurnExecutorLink',
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
    modelRequests: 'ModelRequest',
    modelContextProjections: 'ModelContextProjection',
    modelRequestMessageLinks: 'ModelRequestMessageLink',
    compressionBlocks: 'CompressionBlock',
    conversationContextStatuses: 'ConversationContextStatus',
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
    collaborationRequestTurnLinks: 'CollaborationRequestTurnLink',
    conversationCommunicationLinks: 'ConversationCommunicationLink'
  };
  const visit = (value: PlainData): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      const type = arrayKeyToType[key];
      if (type && Array.isArray(nested)) {
        const bucket = (records[type] ??= {});
        for (const entry of nested) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
          const id = (entry as Record<string, PlainData>).id;
          if (typeof id === 'string' && id) bucket[id] = entry as { [key: string]: PlainData };
        }
      }
      visit(nested);
    }
  };
  visit(projections);
  return records;
}

function requireSnapshot(
  current: ReliableKernelBoundedClientState,
  reason: NonNullable<ReliableKernelClientApplyResult['reason']>
): ReliableKernelClientApplyResult {
  const discardPriorHost = reason === 'host-boot-mismatch' || reason === 'session-mismatch';
  return {
    state: discardPriorHost
      ? createEmptyReliableKernelClientState()
      : { ...current, snapshotRequired: true },
    snapshotRequired: true,
    reason
  };
}

function ackFor(message: ReliableKernelDataMessage): ReliableKernelAckMessage {
  return {
    type: RELIABLE_KERNEL_ACK_MESSAGE,
    sessionId: message.sessionId,
    hostBootId: message.hostBootId,
    messageSeq: message.messageSeq
  };
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty id.`);
  return value;
}

function requireDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string.`);
  }
  return value;
}
