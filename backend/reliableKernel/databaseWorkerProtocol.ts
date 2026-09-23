import type { RootBinding, RuntimeCommitResult, SnapshotBarrier } from './contracts';
import type {
  DomainRow,
  RepositoryInsertMutation,
  RepositoryListRead,
  RepositoryRead,
  RepositoryTransactionStep
} from './repositories';
import type { DatabaseFoundationInspection } from './databaseSchema';
import type { ActiveTurnWorkEnvironmentProjection } from '../../shared/reliableKernelClientFeed';
import type { ConversationChildTaskFacts } from './childTaskFactsSnapshot';
export type { ConversationChildTaskFacts } from './childTaskFactsSnapshot';

export const MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT = 33;
export const MODEL_STREAM_OUTPUT_DELTA_CHECKPOINT_LIMIT = 1;
export const MODEL_STREAM_TERMINAL_TAIL = 32;

/** Structured-clone-safe immutable execution token supplied by the Extension Host. */
export interface ExecutionLeaseFencePayload {
  id: string;
  conversationId: string;
  turnId: string;
  ownerId: string;
  hostBootId: string;
  generation: bigint;
}

export interface ContextModelSource {
  providerId: string;
  modelId: string;
}

export interface ContextMaterializationRecord {
  node: DomainRow;
  segment: DomainRow;
  contentObject: DomainRow;
  /** Immutable MessageRevision role resolved through ContextSegmentSource; NULL for non-message segments. */
  messageRole: string | null;
  modelSource?: ContextModelSource;
  /** Frozen recipe ContentObject of the ModelRequest whose output this model message segment is. */
  sourceRecipeObjectId?: string;
}

export interface ContextMaterializationSnapshot {
  root: DomainRow;
  records: ContextMaterializationRecord[];
}

export interface ContextContentMaterializationRecord extends ContextMaterializationRecord {
  content: Uint8Array;
}

export interface ContextContentMaterializationSnapshot {
  root: DomainRow;
  records: ContextContentMaterializationRecord[];
}

export interface ModelStreamEventCommitInput {
  modelRequestId: string;
  checkpointId: string;
  attemptSeq: bigint;
  socketGeneration: bigint;
  streamSeq: bigint;
  checkpointKind: 'output_delta' | 'output_item_done' | 'native_control' | 'native_tool_call' | 'partial_summary' | 'terminal_summary';
  terminalFenceId: string | null;
  contentObject: DomainRow;
  contentInsert?: RepositoryInsertMutation;
  usage: unknown | null;
  terminalStats: DomainRow | null;
  now: string;
  executionFence?: ExecutionLeaseFencePayload;
}

export interface ModelStreamEventCommitResult {
  accepted: boolean;
  checkpointed: boolean;
  terminal: boolean;
  ignoredReason?: 'old-attempt' | 'old-socket-generation' | 'terminal' | 'checkpoint-capacity' | 'duplicate';
  commit?: RuntimeCommitResult;
}

export interface ModelStreamActivityInput {
  modelRequestId: string;
  attemptSeq: bigint;
  socketGeneration: bigint;
  streamSeq: bigint;
  observedAt: number;
  now: string;
  executionFence?: ExecutionLeaseFencePayload;
}

export interface ModelStreamActivityResult {
  accepted: boolean;
  terminal: boolean;
  commit?: RuntimeCommitResult;
}

export interface ModelRequestCancelInput {
  modelRequestId: string;
  terminalState: string;
  now: string;
  executionFence?: ExecutionLeaseFencePayload;
}

export interface ModelRequestCancelResult {
  cancelled: boolean;
  terminalState: string | null;
  attemptSeq: string;
  socketGeneration: string;
  commit?: RuntimeCommitResult;
}

export interface ClientProjectionSnapshot {
  navigationSummary: Record<string, unknown>;
  activeConversationWindow: Record<string, unknown> & {
    activeTurnWorkEnvironment: ActiveTurnWorkEnvironmentProjection | null;
  };
  activeTurnSummary: Record<string, unknown>;
  activeToolAndInteractionSummary: Record<string, unknown>;
  subagentDeliverySummary: Record<string, unknown>;
}

export interface ClientKeysetPageInput {
  query: 'message' | 'conversation';
  sortId: 'message_seq' | 'created_at+id';
  conversationId?: string;
  limit: number;
  afterSortKey?: string;
  afterId?: string;
}

export interface ClientKeysetPageResult {
  rows: Array<Record<string, unknown>>;
  nextSortKey?: string;
  nextId?: string;
  hasMore: boolean;
  responseBytes: number;
}

export interface ClientVisibleMessageHistoryPageInput {
  conversationId: string;
  limit: number;
  /** Exclusive backward keyset cursor. Both cursor fields are always required. */
  beforeMessageSeq: string;
  beforeId: string;
}

export interface ClientVisibleMessageHistoryPageResult {
  records: Record<string, DomainRow[]>;
  nextBeforeMessageSeq?: string;
  nextBeforeId?: string;
  hasMore: boolean;
  responseBytes: number;
}

export interface ConversationHistoryProjectionInput {
  scopeKind: 'all' | 'unbound' | 'project';
  projectFolderUri?: string;
  limit: number;
  afterUpdatedAt?: string;
  afterId?: string;
  expectedCommitSeq?: string;
}

export interface ConversationHistoryProjectionResult {
  snapshotCommitSeq: string;
  cursorReset: boolean;
  seedRows: DomainRow[];
  conversations: DomainRow[];
  origins: DomainRow[];
  turns: DomainRow[];
  leases: DomainRow[];
  agentLinks: DomainRow[];
  messageSummaries: DomainRow[];
  previewTargets: Array<{ conversationId: string; revisionId: string; content: DomainRow }>;
  titleTargets: Array<{ conversationId: string; revisionId: string; content: DomainRow }>;
  childExecutions: DomainRow[];
  activeChildTurnLinks: DomainRow[];
  answerBridges: DomainRow[];
  inboxItems: DomainRow[];
  deliveries: DomainRow[];
  deliveryWakes: DomainRow[];
  deliveryInputLinks: DomainRow[];
  projectContexts: DomainRow[];
  conversationProjectLinks: DomainRow[];
  total: number;
  hasMore: boolean;
}

export interface ProcessOutputRegistrationMismatch {
  processId: string;
  expectedChunks: string;
  registeredChunks: string;
  expectedBytes: string;
  registeredBytes: string;
}

export interface EffectReceiptReconciliationCandidate {
  effectIntentId: string;
  effectReceiptId: string;
}

export interface ChildConversationOriginCandidate {
  childExecutionId: string;
}

export interface ChildProcessCleanupMaterializationCandidate {
  turnLinkId: string;
  interruptionRequestId: string;
  turnId: string;
  sourceLinkId: string;
  processId: string;
}

/** Fixed dependent facts resolved by the worker inside one SQLite read transaction. */
export interface ToolFactsSnapshot {
  toolCall: DomainRow | null;
  executions: DomainRow[];
  turn: DomainRow | null;
  leases: DomainRow[];
  conversation: DomainRow | null;
}

export interface DatabaseWorkerData {
  mode: 'initialize' | 'runtime';
  binding: RootBinding;
  hostBootId: string;
}

export type DatabaseWorkerRequestPayload =
  | { kind: 'transaction'; steps: RepositoryTransactionStep[] }
  | { kind: 'snapshot'; reads: RepositoryRead[] }
  | { kind: 'snapshotAll'; read: RepositoryListRead }
  | { kind: 'toolFactsSnapshot'; toolCallId: string }
  | { kind: 'conversationChildTaskSnapshot'; conversationId: string }
  | { kind: 'processOutputRegistrationMismatches' }
  | { kind: 'effectReceiptReconciliationCandidates' }
  | { kind: 'childConversationOriginCandidates' }
  | { kind: 'childProcessCleanupMaterializationCandidates' }
  | { kind: 'conversationRuntimeWork'; conversationId: string }
  | { kind: 'contextMaterialization'; rootId: string }
  | { kind: 'contextContentMaterialization'; rootId: string }
  | { kind: 'modelStreamEvent'; input: ModelStreamEventCommitInput }
  | { kind: 'modelStreamActivity'; input: ModelStreamActivityInput }
  | { kind: 'cancelCurrentModelRequest'; input: ModelRequestCancelInput }
  | { kind: 'clientProjectionSnapshot'; activeConversationId: string | null }
  | { kind: 'clientKeysetPage'; input: ClientKeysetPageInput }
  | { kind: 'clientVisibleMessageHistoryPage'; input: ClientVisibleMessageHistoryPageInput }
  | { kind: 'conversationHistoryProjection'; input: ConversationHistoryProjectionInput }
  | { kind: 'externalDataVersion' }
  | { kind: 'inspect' }
  | { kind: 'close' };

export interface DatabaseWorkerTiming {
  queueWaitMs: number;
  executeDurationMs: number;
}

export type DatabaseWorkerRequest = DatabaseWorkerRequestPayload & {
  id: number;
  /** Host monotonic timestamp; present only while development metrics are attached. */
  metricEnqueuedAtMs?: number;
};

export interface DatabaseWorkerDiagnostics extends DatabaseFoundationInspection {
  workerThreadId: number;
  hostBootId: string;
  writerConnectionCount: 1;
  readerConnectionCount: 1;
  readerJournalMode: string;
  readerForeignKeys: bigint;
  readerBusyTimeoutMs: bigint;
  currentCommitSeq: string;
  /** Bounded verified Context CAS cache counters; metadata only, never content bytes. */
  contextCasCache: {
    entries: number;
    bytes: number;
    maxEntries: number;
    maxBytes: number;
    hits: number;
    misses: number;
    evictions: number;
  };
}

export type DatabaseWorkerResponse =
  | { type: 'ready'; workerThreadId: number; mode: DatabaseWorkerData['mode'] }
  | ({ type: 'response'; id: number; ok: true; result: RuntimeCommitResult | ModelStreamEventCommitResult | ModelStreamActivityResult | ModelRequestCancelResult | ClientKeysetPageResult | ClientVisibleMessageHistoryPageResult | ConversationHistoryProjectionResult | ProcessOutputRegistrationMismatch[] | EffectReceiptReconciliationCandidate[] | ChildConversationOriginCandidate[] | ChildProcessCleanupMaterializationCandidate[] | SnapshotBarrier<ToolFactsSnapshot> | SnapshotBarrier<ConversationChildTaskFacts> | SnapshotBarrier<ClientProjectionSnapshot> | SnapshotBarrier<Array<DomainRow | DomainRow[] | null>> | SnapshotBarrier<DomainRow[]> | SnapshotBarrier<ContextMaterializationSnapshot> | SnapshotBarrier<ContextContentMaterializationSnapshot> | DatabaseWorkerDiagnostics | boolean | string | null; timing?: DatabaseWorkerTiming })
  | ({ type: 'response'; id: number; ok: false; error: SerializedWorkerError; timing?: DatabaseWorkerTiming })
  | { type: 'commit'; result: RuntimeCommitResult }
  | { type: 'fatal'; error: SerializedWorkerError };

export interface SerializedWorkerError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}
