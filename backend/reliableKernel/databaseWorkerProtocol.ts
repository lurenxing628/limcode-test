import type { RootBinding, RuntimeCommitResult, SnapshotBarrier } from './contracts';
import type {
  DomainRow,
  RepositoryInsertMutation,
  RepositoryListRead,
  RepositoryRead,
  RepositoryTransactionStep
} from './repositories';
import type { DatabaseFoundationInspection } from './databaseSchema';
import type { RuntimeStatementCacheCounters } from './runtimeStatementCache';
import type {
  ActiveTurnWorkEnvironmentProjection,
  ChildConversationBoundaryProjection
} from '../../shared/reliableKernelClientFeed';
import type { ConversationChildTaskFacts } from './childTaskFactsSnapshot';
export type { ConversationChildTaskFacts } from './childTaskFactsSnapshot';
import type { RuntimeContentUsageRow } from './runtimeContentUsage';
import type { RelocatedWorkInventory } from './relocatedWorkInventory';

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
  /** Claude 保留思考处理：产生这条模型输出的 ModelRequest 实际发出时这个对话已选定的处理（stream_stats 里的持久记录）。 */
  sourceClaudeThinkingBinding?: 'drop_block' | 'strip_thinking';
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
    childConversationBoundary: ChildConversationBoundaryProjection | null;
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

export interface ClientCollaborationHistoryPageInput {
  conversationId: string;
  limit: number;
  /** Independent CollaborationMessage.message_seq/id exclusive backward cursor. */
  beforeMessageSeq?: string;
  beforeId?: string;
}

export interface ClientCollaborationHistoryPageResult extends ClientVisibleMessageHistoryPageResult {
  scanProgress: boolean;
  scannedRows: number;
}

/** One (updated_at, id) key of the history order; `from` is inclusive, `after`/`before` exclusive. */
export interface ConversationHistoryPageBoundary {
  kind: 'from' | 'after' | 'before';
  updatedAt: string;
  id: string;
}

export interface ConversationHistoryProjectionInput {
  scopeKind: 'all' | 'unbound' | 'project';
  projectFolderUri?: string;
  limit: number;
  /** Requested zero-based page; the worker clamps it to the current last page. */
  pageIndex: number;
  /** Positions pages beyond the exact page-number window; ignored inside that window. */
  boundary?: ConversationHistoryPageBoundary;
}

export interface ConversationHistoryProjectionResult {
  /** The page actually read after clamping to the current data. */
  pageIndex: number;
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
  /**
   * A private instance opened offline for maintenance (RuntimeDatabase.open `maintenance`): only it
   * accepts the maintenance transaction requests.
   */
  maintenance?: true;
}

/**
 * Answer of `maintenanceCommit`. The transaction's changes are not read back or projected (a
 * maintenance instance has no commit listeners): anything that shows this database must take a new
 * snapshot. Allocated writer sequences are only counted.
 */
export interface RuntimeMaintenanceCommitResult {
  commitSeq: string;
  snapshotRequired: true;
  allocatedSequences: number;
}

/** Answer of `maintenanceRollback`: false when no maintenance transaction was open (already rolled back). */
export interface RuntimeMaintenanceRollbackResult {
  rolledBack: boolean;
}

/** Answer of `maintenanceCheckpoint` and `durabilityCheckpoint`: SQLite's wal_checkpoint(TRUNCATE / PASSIVE) row. */
export interface RuntimeWalCheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
}

export type DatabaseWorkerRequestPayload =
  /** `durable`: this commit is synced before the response (see RuntimeDatabase.transaction). */
  | { kind: 'transaction'; steps: RepositoryTransactionStep[]; durable?: true }
  | { kind: 'snapshot'; reads: RepositoryRead[] }
  | { kind: 'snapshotAll'; read: RepositoryListRead }
  | { kind: 'toolFactsSnapshot'; toolCallId: string }
  | { kind: 'conversationChildTaskSnapshot'; conversationId: string }
  | { kind: 'processOutputRegistrationMismatches' }
  | { kind: 'effectReceiptReconciliationCandidates' }
  | { kind: 'childConversationOriginCandidates' }
  | { kind: 'childProcessCleanupMaterializationCandidates' }
  /** ContentObject records per content_type, aggregated on the reader from the covering index only. */
  | { kind: 'contentUsage' }
  | { kind: 'relocatedWorkInventory' }
  | { kind: 'conversationRuntimeWork'; conversationId: string }
  | { kind: 'contextMaterialization'; rootId: string }
  | { kind: 'contextContentMaterialization'; rootId: string }
  | { kind: 'modelStreamEvent'; input: ModelStreamEventCommitInput }
  | { kind: 'modelStreamActivity'; input: ModelStreamActivityInput }
  | { kind: 'cancelCurrentModelRequest'; input: ModelRequestCancelInput }
  | { kind: 'clientProjectionSnapshot'; activeConversationId: string | null }
  | { kind: 'clientKeysetPage'; input: ClientKeysetPageInput }
  | { kind: 'clientVisibleMessageHistoryPage'; input: ClientVisibleMessageHistoryPageInput }
  | { kind: 'clientCollaborationHistoryPage'; input: ClientCollaborationHistoryPageInput }
  | { kind: 'conversationHistoryProjection'; input: ConversationHistoryProjectionInput }
  | { kind: 'externalDataVersion' }
  /** Rows over every Runtime domain table, counted in one read transaction of the reader connection. */
  | { kind: 'countDomainRows' }
  /** Consistent SQLite Backup API copy of the live database into its own control root. */
  | { kind: 'backupDatabase'; destinationPath: string }
  /**
   * One write transaction over several requests, only on a maintenance instance (see
   * DatabaseWorkerData.maintenance): begun with synchronous = FULL, steps appended in chunks under
   * the ordinary insert invariants, the touched ModelRequest aggregates asserted once at the commit,
   * no changes read back. While it is open every other write request is refused; a failed append
   * rolls the whole transaction back. `maintenanceCheckpoint` runs wal_checkpoint(TRUNCATE) outside it.
   */
  | { kind: 'maintenanceBegin' }
  | { kind: 'maintenanceAppend'; steps: RepositoryTransactionStep[] }
  | { kind: 'maintenanceCommit' }
  | { kind: 'maintenanceRollback' }
  | { kind: 'maintenanceCheckpoint' }
  /**
   * wal_checkpoint(PASSIVE) on the writer outside any transaction (refused while a maintenance
   * transaction is open): the durability barrier of RuntimeDatabase.durabilityCheckpoint.
   */
  | { kind: 'durabilityCheckpoint' }
  | { kind: 'inspect' }
  | { kind: 'close' };

export interface DatabaseWorkerTiming {
  queueWaitMs: number;
  executeDurationMs: number;
  /**
   * Present only when this very request opened a BEGIN IMMEDIATE writer transaction. A response
   * posted after other requests ran (an online backup) never reports their writer lock.
   */
  writeLock?: DatabaseWorkerWriteLockTiming;
}

export interface DatabaseWorkerWriteLockTiming {
  /** BEGIN IMMEDIATE duration, including SQLite busy_timeout waiting for another connection. */
  waitMs: number;
  /** Lock acquired until COMMIT returned, or until the response when the transaction rolled back. */
  holdMs: number;
  /** Last stage reached; a failure reports where it happened. */
  stage: 'begin' | 'body' | 'commit' | 'committed';
  /** First mutated Repository domain of a `transaction` request; a schema key, never row content. */
  domain?: string;
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
  /** Transactions this worker committed with synchronous = FULL on request (`durable`), read back in effect after the commit. */
  durableCommitCount: number;
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
  /** Bounded prepared-statement LRU of each worker connection; counters only, never SQL text. */
  statementCache: {
    writer: RuntimeStatementCacheCounters;
    reader: RuntimeStatementCacheCounters;
  };
}

export type DatabaseWorkerResponse =
  | { type: 'ready'; workerThreadId: number; mode: DatabaseWorkerData['mode'] }
  | ({ type: 'response'; id: number; ok: true; result: RuntimeCommitResult | ModelStreamEventCommitResult | ModelStreamActivityResult | ModelRequestCancelResult | ClientKeysetPageResult | ClientVisibleMessageHistoryPageResult | ClientCollaborationHistoryPageResult | ConversationHistoryProjectionResult | ProcessOutputRegistrationMismatch[] | EffectReceiptReconciliationCandidate[] | ChildConversationOriginCandidate[] | ChildProcessCleanupMaterializationCandidate[] | RuntimeContentUsageRow[] | RelocatedWorkInventory | SnapshotBarrier<ToolFactsSnapshot> | SnapshotBarrier<ConversationChildTaskFacts> | SnapshotBarrier<ClientProjectionSnapshot> | SnapshotBarrier<Array<DomainRow | DomainRow[] | null>> | SnapshotBarrier<DomainRow[]> | SnapshotBarrier<ContextMaterializationSnapshot> | SnapshotBarrier<ContextContentMaterializationSnapshot> | DatabaseWorkerDiagnostics | RuntimeMaintenanceCommitResult | RuntimeMaintenanceRollbackResult | RuntimeWalCheckpointResult | boolean | string | null;
      /**
       * Answer of a committed `transaction`: its RuntimeCommitResult is the `commit` message posted
       * right before this response (with this commitSeq) and `result` is null, so a large commit is
       * structured-cloned once and the caller gets the object the commit listeners saw.
       */
      committed?: string;
      timing?: DatabaseWorkerTiming })
  | ({ type: 'response'; id: number; ok: false; error: SerializedWorkerError; timing?: DatabaseWorkerTiming })
  | { type: 'commit'; result: RuntimeCommitResult }
  | { type: 'fatal'; error: SerializedWorkerError };

export interface SerializedWorkerError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
}
