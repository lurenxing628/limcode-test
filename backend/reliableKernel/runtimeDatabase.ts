import type { NativePendingToolCall, NativePendingWorkInput, NativeSteeringInFlightEntry } from './nativeWorkTypes';
import type { CurrentTurnTaskSnapshot } from './currentTurnTaskSnapshot';
import type { AttachmentProjectionSegmentSnapshot, AttachmentProjectionLinksSnapshot } from './attachmentProjectionSnapshot';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker, type ResourceLimits } from 'node:worker_threads';
import { RuntimeCasAccess } from './runtimeCasAccess';
import type { RelocatedWorkInventory } from './relocatedWorkInventory';
import { registerInProcessSqliteDatabase } from '../capabilities/filesystem/sqliteDatabaseFileGuard';
import {
  ROOT_BINDING_POINTER_FILE,
  type RootBinding,
  type RuntimeCommitResult,
  type SnapshotBarrier
} from './contracts';
import type {
  ClientCollaborationHistoryPageInput,
  ClientCollaborationHistoryPageResult,
  ClientKeysetPageInput,
  ClientKeysetPageResult,
  ClientVisibleMessageHistoryPageInput,
  ClientVisibleMessageHistoryPageResult,
  ConversationHistoryProjectionInput,
  ConversationHistoryProjectionResult,
  ClientProjectionSnapshot,
  ContextContentMaterializationSnapshot,
  ContextMaterializationSnapshot,
  SelectedContextAuthoritySourceInput,
  SelectedContextAuthoritySource,
  ChildConversationOriginCandidate,
  ChildProcessCleanupMaterializationCandidate,
  DatabaseWorkerData,
  ExecutionLeaseRenewalInput,
  ExecutionLeaseRenewalResult,
  DatabaseWorkerDiagnostics,
  DatabaseWorkerRequest,
  ModelStreamActivityInput,
  ModelStreamActivityResult,
  ModelStreamEventCommitInput,
  ModelStreamEventCommitResult,
  ModelRequestCancelInput,
  ModelRequestCancelResult,
  EffectReceiptReconciliationCandidate,
  ProcessOutputRegistrationMismatch,
  DatabaseWorkerRequestPayload,
  DatabaseWorkerResponse,
  RuntimeMaintenanceCommitResult,
  RuntimeMaintenanceRollbackResult,
  RuntimeWalCheckpointResult,
  SerializedWorkerError,
  ToolFactsSnapshot
} from './databaseWorkerProtocol';
import type { ConversationChildTaskFacts } from './childTaskFactsSnapshot';
import type { ContextHandleEvidenceFrontier } from './contextHandleEvidenceFrontier';
import type { RuntimeContentUsageRow } from './runtimeContentUsage';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryListRead,
  type RepositoryRead,
  type RepositoryTransactionStep
} from './repositories';
import { RootAuthority } from './rootAuthority';
import {
  ConversationRuntimeOwnerManager,
  ConversationRuntimeOwnerReleasedError
} from './ConversationRuntimeOwnerManager';
import {
  assertRuntimeHostsOffline,
  isRuntimeMaintenanceHeld,
  runtimeHostLivenessDirectory,
  withRuntimeMaintenance
} from './runtimeHostControl';
import {
  currentExecutionLeaseFence,
  ExecutionHandoffError,
  executionLeaseFenceAssertion,
  type ExecutionLeaseFence
} from './executionLeaseFence';
import {
  recordRuntimePerformanceMetric,
  type RuntimeDatabaseMetricRequestKind,
  type RuntimePerformanceMetricEvent,
  type RuntimePerformanceMetricsSink
} from './runtimePerformanceMetrics';
import { readProcessStartFingerprint } from './processProtocol';
import type { MergeModelAggregate } from './runtimeMergeAggregatePreflight';
import type { RuntimeHistoryRepairInput, RuntimeHistoryRepairResult } from './runtimeHistoryRepairTransaction';
import { HistoryPreparationAdmission, type HistoryPreparationOptions, type HistoryPreparationPermit } from './historyPreparationAdmission';

export interface SnapshotSubscription<T> {
  barrier: SnapshotBarrier<T>;
  unsubscribe(): void;
}

export class RuntimeDatabaseWorkerError extends Error {
  public readonly domain?: string;
  public readonly recordId?: string;
  public constructor(error: SerializedWorkerError) {
    super(error.message);
    this.name = error.name || 'RuntimeDatabaseWorkerError';
    if (error.stack) this.stack = error.stack;
    if (error.code) (this as Error & { code?: string }).code = error.code;
    this.domain = error.domain;
    this.recordId = error.recordId;
  }
}

const OPEN_ROOT_POINTERS = new Map<string, string>();
const HOST_HEARTBEAT_INTERVAL_MS = 5_000;
const CONVERSATION_OWNER_SWEEP_DELAY_MS = 50;
/** How long a matching process-identity comparison is reused by isHostAliveCached. */
const HOST_IDENTITY_RECHECK_MS = 60_000;
const HOST_IDENTITY_CACHE_ENTRIES = 1_000;

interface RuntimeHostLivenessRecord {
  kind: 'limcode-runtime-host-liveness';
  dataSetId: string;
  rootInstanceId: string;
  rootGeneration: number;
  hostBootId: string;
  livenessId: string;
  processId: number;
  processStartIdentity?: string;
  startedAt: string;
  heartbeatAt: string;
}

/** See RuntimeDatabase.durabilityCheckpoint: attempts, and the pause between them (about 1 s in all). */
const DURABILITY_CHECKPOINT_ATTEMPTS = 20;
const DURABILITY_CHECKPOINT_RETRY_MS = 50;

export class RuntimeDatabase {
  private readonly historyPreparation: HistoryPreparationAdmission;
  private readonly pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: unknown): void;
    requestKind: RuntimeDatabaseMetricRequestKind;
    startedAtMs?: number;
  }>();
  private readonly commitListeners = new Set<(result: RuntimeCommitResult) => void>();
  /**
   * Result of the latest `commit` message until the next response arrives: a committed
   * transaction's response names it instead of carrying a second structured clone.
   */
  private lastCommit: RuntimeCommitResult | undefined;
  private readonly performanceMetricSinks = new Set<RuntimePerformanceMetricsSink>();
  private readonly performanceMetricFanout: RuntimePerformanceMetricsSink = {
    record: (event) => {
      for (const sink of this.performanceMetricSinks) recordRuntimePerformanceMetric(sink, event);
    }
  };
  private nextRequestId = 1;
  private closed = false;
  private readonly closeListeners = new Set<() => void>();
  private closePromise: Promise<void> | undefined;
  private readonly livenessId = randomUUID();
  private readonly startedAt = new Date().toISOString();
  private readonly processStartIdentity = readProcessStartIdentity(process.pid);
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private heartbeatTask: Promise<void> = Promise.resolve();
  private heartbeatFailure: unknown;
  public readonly conversationOwners: ConversationRuntimeOwnerManager;
  private conversationOwnerSweepTimer: NodeJS.Timeout | undefined;
  private conversationOwnerSweepTask: Promise<void> = Promise.resolve();
  private conversationOwnerSweepsStopped = false;
  /** Process-identity comparisons by (hostBootId, pid) for isHostAliveCached. */
  private readonly hostIdentityComparisons = new Map<string, { result: 'alive' | 'dead'; at: number }>();

  private constructor(
    private readonly authority: RootAuthority,
    public readonly binding: RootBinding,
    public readonly hostBootId: string,
    private readonly worker: Worker,
    public readonly workerThreadId: number,
    private readonly registryKey: string,
    public readonly casAccess: RuntimeCasAccess,
    initialPerformanceMetrics?: RuntimePerformanceMetricsSink,
    /** Opened offline for maintenance: a private instance without commit listeners (see open). */
    public readonly maintenance = false,
    historyPreparationConcurrency?: number
  ) {
    this.historyPreparation = new HistoryPreparationAdmission(historyPreparationConcurrency);
    if (initialPerformanceMetrics) this.performanceMetricSinks.add(initialPerformanceMetrics);
    this.conversationOwners = new ConversationRuntimeOwnerManager(binding, hostBootId);
    this.casAccess.onFailure((error) => {
      this.markClosed();
      this.stopHistoryPreparation(error);
      this.failPending(error);
      void this.worker.terminate().catch(() => undefined);
      void this.casAccess.close().catch(() => undefined);
    });
    // Work whose execution lease another live Host holds runs there: it never keeps this Host's
    // claim, which would only stop that Host from taking the Conversation to drive it.
    this.conversationOwners.setPendingWorkProbe(async (conversationId) =>
      await this.hasConversationRuntimeWork(conversationId)
      && !await this.conversationExecutedByLivePeer(conversationId));
    worker.on('message', (message: DatabaseWorkerResponse) => this.onMessage(message));
    worker.on('error', (error) => {
      this.markClosed();
      void this.casAccess.close().catch(() => undefined);
      this.stopHistoryPreparation(error);
      this.failPending(error);
    });
    worker.on('exit', (code) => {
      this.stopHeartbeatTimer();
      // Unexpected worker exit is not proof that this Host's external capabilities quiesced:
      // the liveness record and durable conversation owners stay fail-closed until an explicit
      // graceful close() drains and fences the work (or the OS proves the process dead).
      const unexpected = !this.closed && !this.closePromise;
      this.markClosed();
      void this.casAccess.close().catch(() => undefined);
      this.stopHistoryPreparation(new ExecutionHandoffError('SQLite database worker exited.'));
      if (unexpected || code !== 0) this.failPending(new Error(`SQLite database worker exited with code ${code}.`));
    });
  }

  /**
   * Opens the shared Runtime root. The short control-root maintenance claim is held through
   * worker startup and Host liveness registration so destructive maintenance (reset, archive,
   * cutover, data-root switch) can never race a new Host whose record is not yet visible; the
   * claim is released before any execution work runs.
   */
  public static async open(
    authority: RootAuthority,
    options: {
      hostBootId?: string;
      performanceMetrics?: RuntimePerformanceMetricsSink;
      /**
       * A private offline instance for maintenance transactions (see maintenanceBegin): the caller
       * holds this root's maintenance claim for as long as it is open, and no other Host may be on it.
       * It never has commit listeners.
       */
      maintenance?: true;
      /** Worker heap limits (e.g. a test bounding a maintenance worker). */
      resourceLimits?: ResourceLimits;
      /** Internal resource-admission override for deterministic tests; never an Agent/model limit. */
      historyPreparationConcurrency?: number;
    } = {}
  ): Promise<RuntimeDatabase> {
    const hostBootId = options.hostBootId ?? randomUUID();
    if (options.maintenance && !isRuntimeMaintenanceHeld(authority.expectedPaths())) {
      throw new Error('A maintenance Runtime database is opened only while its caller holds the root maintenance claim.');
    }
    // Selection, pointer recovery and registration all join admission before scope maintenance.
    return authority.withRuntimeHostAdmission(() => withRuntimeMaintenance(authority.expectedPaths(), async () => {
      const binding = await authority.current();
      if (options.maintenance) await assertRuntimeHostsOffline(binding.paths);
      const registryKey = binding.paths.rootPointerPath;
      if (OPEN_ROOT_POINTERS.has(registryKey)) {
        throw new Error(`A Runtime database worker is already open for ${registryKey}.`);
      }
      OPEN_ROOT_POINTERS.set(registryKey, hostBootId);
      let worker: Worker | undefined;
      let casAccess: RuntimeCasAccess | undefined;
      let database: RuntimeDatabase | undefined;
      try {
        // CAS owns its own startup/failure listeners. Start it first so Runtime's readiness
        // handoff to its permanent listeners never contains an asynchronous second-worker gap.
        casAccess = await RuntimeCasAccess.open(binding);
        worker = createWorker(
          { mode: 'runtime', binding, hostBootId, ...(options.maintenance ? { maintenance: true as const } : {}) },
          options.resourceLimits
        );
        const ready = await waitForReady(worker, 'runtime');
        database = new RuntimeDatabase(
          authority,
          binding,
          hostBootId,
          worker,
          ready.workerThreadId,
          registryKey,
          casAccess,
          options.performanceMetrics,
          options.maintenance === true,
          options.historyPreparationConcurrency
        );
        await database.registerHostLiveness();
        database.assertUsable();
        return database;
      } catch (error) {
        if (database) await database.close();
        else {
          await worker?.terminate();
          await casAccess?.close();
          if (OPEN_ROOT_POINTERS.get(registryKey) === hostBootId) OPEN_ROOT_POINTERS.delete(registryKey);
        }
        throw error;
      }
    }));
  }

  /** Bound heavy history reads and copy plans for this database, including its direct callers. */
  public withHistoryPreparation<T>(operation: (permit: HistoryPreparationPermit) => Promise<T>,
    options: HistoryPreparationOptions = {}): Promise<T> {
    // Capture before waiting; never adopt a newer lease generation when this scope is admitted.
    const fence = currentExecutionLeaseFence();
    return this.historyPreparation.run(async permit => {
      if (this.closed) throw new Error('RuntimeDatabase is closed.');
      if (fence) {
        if (!this.conversationOwners.owns(fence.conversationId) || !await this.executionFenceStillCurrent(fence)) {
          throw new ExecutionHandoffError(`Turn ${fence.turnId} lost its execution authority while awaiting history preparation.`);
        }
      } else await this.validateBinding('snapshot');
      permit.assertActive();
      return operation(permit);
    }, options);
  }

  public stopHistoryPreparation(reason: unknown): void { this.historyPreparation.close(reason); }

  /**
   * Resolves with the same RuntimeCommitResult object that the commit listeners received (one
   * structured clone from the worker); the caller and the listeners must treat it as read-only.
   * `durable`: this commit is synced to disk before the call returns (the writer's synchronous is
   * FULL for this transaction only, NORMAL again afterwards), for a commit that is recorded as done
   * outside this database (the historical merge ledger).
   * `beforeSubmit` is a process-local authority check after binding validation; it is never sent
   * to the worker and cannot revoke a transaction already submitted to the writer.
   */
  public async transaction(steps: RepositoryTransactionStep[], options: { durable?: true; beforeSubmit?: () => void } = {}): Promise<RuntimeCommitResult> {
    const fence = currentExecutionLeaseFence();
    const fencedSteps = fence
      ? [
          DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(
            fence.id,
            executionLeaseFenceAssertion(fence)
          ),
          ...steps
        ]
      : steps;
    return this.requestWithExecutionFence(
      fence,
      { kind: 'transaction', steps: fencedSteps, ...(options.durable ? { durable: true as const } : {}) },
      options.beforeSubmit
    );
  }

  /** Fixed atomic renewal; priority is intrinsic to this bounded operation, never caller-selected. */
  public async renewExecutionLease(
    input: Omit<ExecutionLeaseRenewalInput, 'executionFence'>
  ): Promise<ExecutionLeaseRenewalResult> {
    const executionFence = currentExecutionLeaseFence();
    return this.requestWithExecutionFence(executionFence, {
      kind: 'renewExecutionLease',
      input: { ...input, ...(executionFence ? { executionFence } : {}) }
    });
  }

  /**
   * Maintenance transaction of a private offline instance (open `maintenance`, no commit listeners):
   * one write transaction over several requests, begun with synchronous = FULL. Steps are appended in
   * chunks under the ordinary insert invariants; the ModelRequest aggregates they touch are asserted
   * once, at the commit. While it is open this database refuses every other write, and a failed append
   * rolls all of it back. The commit reads no changes back (the result says a snapshot is required).
   */
  /** Explicit, backed-up repair of terminal owner-deletion residue; never an online or arbitrary SQL writer. */
  public async maintenanceRepairHistory(input: RuntimeHistoryRepairInput): Promise<RuntimeHistoryRepairResult> {
    this.assertMaintenanceInstance();
    return this.request<RuntimeHistoryRepairResult>({ kind: 'maintenanceRepairHistory', input });
  }

  public async maintenanceBegin(): Promise<void> {
    this.assertMaintenanceInstance();
    await this.request<null>({ kind: 'maintenanceBegin' });
  }

  public async maintenanceAppend(steps: RepositoryTransactionStep[]): Promise<void> {
    this.assertMaintenanceInstance();
    await this.request<null>({ kind: 'maintenanceAppend', steps });
  }

  /** Synced to disk when it returns (synchronous = FULL for this transaction, NORMAL again afterwards). */
  public async maintenanceCommit(): Promise<RuntimeMaintenanceCommitResult> {
    this.assertMaintenanceInstance();
    return this.request<RuntimeMaintenanceCommitResult>({ kind: 'maintenanceCommit' });
  }

  /** Rolls the open maintenance transaction back; `rolledBack` is false when none was open. */
  public async maintenanceRollback(): Promise<RuntimeMaintenanceRollbackResult> {
    this.assertMaintenanceInstance();
    return this.request<RuntimeMaintenanceRollbackResult>({ kind: 'maintenanceRollback' });
  }

  /** wal_checkpoint(TRUNCATE) outside a maintenance transaction: the WAL is written back and emptied. */
  public async maintenanceCheckpoint(): Promise<RuntimeWalCheckpointResult> {
    this.assertMaintenanceInstance();
    return this.request<RuntimeWalCheckpointResult>({ kind: 'maintenanceCheckpoint' });
  }

  /**
   * Durability barrier for a record kept outside this database that says something in it is done:
   * write that record only after this returned. Commits are synced only at a checkpoint
   * (synchronous = NORMAL), so this runs wal_checkpoint(PASSIVE) outside any transaction: the WAL
   * synced, then written back, and the database file synced once every frame is. Done only when every
   * frame was written back (`busy` 0, `checkpointed` equal to `log`): every commit made before the call
   * is on disk. PASSIVE never takes the writer lock nor waits, so another window's writes are not held
   * up (FULL would hold them while it waits for readers, up to their own busy timeout); a reader that
   * still needs an older state leaves frames behind, and after DURABILITY_CHECKPOINT_ATTEMPTS attempts
   * this throws, it is never taken as done. A durable transaction with only assertions writes no WAL
   * frame and is no such barrier. Refused while a maintenance transaction is open.
   */
  public async durabilityCheckpoint(): Promise<void> {
    let result: RuntimeWalCheckpointResult | undefined;
    for (let attempt = 0; attempt < DURABILITY_CHECKPOINT_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, DURABILITY_CHECKPOINT_RETRY_MS));
      result = await this.request<RuntimeWalCheckpointResult>({ kind: 'durabilityCheckpoint' });
      if (result.busy === 0 && result.checkpointed === result.log) return;
    }
    throw new Error(`历史库的改动没能全部写回磁盘（预写日志 ${result!.log} 帧，写回 ${result!.checkpointed} 帧；另一个窗口还在读旧的状态），稍后再试。`);
  }

  private assertMaintenanceInstance(): void {
    if (!this.maintenance) throw new Error('Maintenance transactions run only on a Runtime database opened for maintenance.');
    if (this.commitListeners.size > 0) throw new Error('Maintenance transactions run only on a Runtime database without commit listeners.');
  }

  /** Conversation-scoped native facts, validated and filtered in one worker read snapshot. */
  public nativePendingWork(input: NativePendingWorkInput): Promise<SnapshotBarrier<NativePendingToolCall[]>> {
    return this.request({ kind: 'nativePendingWork', input });
  }

  public nativeSteeringInFlight(conversationId: string): Promise<SnapshotBarrier<NativeSteeringInFlightEntry[]>> {
    return this.request({ kind: 'nativeSteeringInFlight', conversationId });
  }

  /** Only native admissions referenced by this provider Context window. */
  public nativeAdmittedProviderCallIds(conversationId: string, segmentIds: readonly string[]): Promise<SnapshotBarrier<string[]>> {
    return this.request({ kind: 'nativeAdmittedProviderCallIds', conversationId, segmentIds: [...segmentIds] });
  }

  public async snapshot(
    reads: RepositoryRead[]
  ): Promise<SnapshotBarrier<Array<DomainRow | DomainRow[] | null>>> {
    return this.request<SnapshotBarrier<Array<DomainRow | DomainRow[] | null>>>({ kind: 'snapshot', reads });
  }

  /** Complete source evidence is checked in the worker; only selected ownership is returned. */
  public attachmentProjectionSegments(conversationId: string, segmentIds: readonly string[]): Promise<SnapshotBarrier<AttachmentProjectionSegmentSnapshot>> {
    return this.request({ kind: 'attachmentProjectionSegments', conversationId, segmentIds: [...segmentIds] });
  }

  /** Fresh AttachmentLink facts and immutable Attachment metadata for bounded revision selectors. */
  public attachmentProjectionLinks(revisionIds: readonly string[]): Promise<SnapshotBarrier<AttachmentProjectionLinksSnapshot>> {
    return this.request({ kind: 'attachmentProjectionLinks', revisionIds: [...revisionIds] });
  }

  /** Bounded target aggregates for historical merge preflight, all in one worker read snapshot. */
  public async mergeModelAggregates(ids: readonly string[]): Promise<MergeModelAggregate[]> {
    return this.request<MergeModelAggregate[]>({ kind: 'mergeModelAggregates', ids: [...ids] });
  }

  /** Reads every page of one repository list inside one SQLite read transaction. */
  public async snapshotAll(read: RepositoryListRead): Promise<SnapshotBarrier<DomainRow[]>> {
    return this.request<SnapshotBarrier<DomainRow[]>>({ kind: 'snapshotAll', read });
  }

  /** Latest task rewrite and update suffix, ordered and verified in one worker read snapshot. */
  public currentTurnTaskSnapshot(turnId: string): Promise<SnapshotBarrier<CurrentTurnTaskSnapshot>> {
    return this.request({ kind: 'currentTurnTaskSnapshot', turnId });
  }

  /** Fixed dependent Tool facts resolved inside one worker read transaction. */
  public async toolFactsSnapshot(toolCallId: string): Promise<SnapshotBarrier<ToolFactsSnapshot>> {
    if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
      throw new TypeError('toolCallId must be non-empty.');
    }
    return this.request<SnapshotBarrier<ToolFactsSnapshot>>({ kind: 'toolFactsSnapshot', toolCallId });
  }

  /** One atomic, metadata-only inventory for cold handle evidence and external-change comparison. */
  public async contextHandleEvidenceFrontier(conversationId: string): Promise<SnapshotBarrier<ContextHandleEvidenceFrontier>> {
    if (typeof conversationId !== 'string' || !conversationId.trim()) throw new TypeError('conversationId must be non-empty.');
    return this.request<SnapshotBarrier<ContextHandleEvidenceFrontier>>({ kind: 'contextHandleEvidenceFrontier', conversationId });
  }

  /** Nearest authority on the exact selected Context parent chain, with its observed head basis. */
  public readSelectedContextAuthoritySource(
    input: SelectedContextAuthoritySourceInput
  ): Promise<SnapshotBarrier<SelectedContextAuthoritySource>> {
    return this.request({ kind: 'selectedContextAuthoritySource', input });
  }

  /** Full child lineage and task inputs from one SQLite read transaction; no in-memory runner state. */
  public async conversationChildTaskSnapshot(conversationId: string): Promise<SnapshotBarrier<ConversationChildTaskFacts>> {
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      throw new TypeError('conversationId must be non-empty.');
    }
    return this.request<SnapshotBarrier<ConversationChildTaskFacts>>({ kind: 'conversationChildTaskSnapshot', conversationId });
  }

  /** DB-side aggregate: returns only terminal processes whose registered chunk facts are incomplete. */
  public async processOutputRegistrationMismatches(): Promise<ProcessOutputRegistrationMismatch[]> {
    return this.request<ProcessOutputRegistrationMismatch[]>({ kind: 'processOutputRegistrationMismatches' });
  }

  /** DB-side anti-join: only receipt-written effects whose terminal projection is incomplete. */
  public async effectReceiptReconciliationCandidates(): Promise<EffectReceiptReconciliationCandidate[]> {
    return this.request<EffectReceiptReconciliationCandidate[]>({ kind: 'effectReceiptReconciliationCandidates' });
  }

  /** DB-side anti-join: only Child Conversations missing their immutable origin fact. */
  public async childConversationOriginCandidates(): Promise<ChildConversationOriginCandidate[]> {
    return this.request<ChildConversationOriginCandidate[]>({ kind: 'childConversationOriginCandidates' });
  }

  /** DB-side anti-join: only interruption/process pairs missing their cleanup outbox row. */
  public async childProcessCleanupMaterializationCandidates(): Promise<ChildProcessCleanupMaterializationCandidate[]> {
    return this.request<ChildProcessCleanupMaterializationCandidate[]>({
      kind: 'childProcessCleanupMaterializationCandidates'
    });
  }

  /**
   * ContentObject records per content_type (count, byte sum, largest), aggregated on the worker's
   * reader connection from the covering (content_type, sha256, byte_length) index alone: no CAS
   * file is read and writers are never blocked. Bytes shared by several types count once per type.
   */
  public async contentUsage(): Promise<RuntimeContentUsageRow[]> {
    return this.request<RuntimeContentUsageRow[]>({ kind: 'contentUsage' });
  }

  /**
   * Registers before requesting the writer barrier, buffers concurrent commits, discards those
   * already visible in the snapshot, then switches to live delivery without a gap.
   */
  public async snapshotAndSubscribe(
    reads: RepositoryRead[],
    onCommit: (result: RuntimeCommitResult) => void
  ): Promise<SnapshotSubscription<Array<DomainRow | DomainRow[] | null>>> {
    return this.barrierAndSubscribe(() => this.snapshot(reads), onCommit);
  }

  public async clientProjectionSnapshot(
    activeConversationId: string | null
  ): Promise<SnapshotBarrier<ClientProjectionSnapshot>> {
    if (activeConversationId !== null && (typeof activeConversationId !== 'string' || activeConversationId.length === 0)) {
      throw new TypeError('activeConversationId must be a non-empty id or null.');
    }
    return this.request<SnapshotBarrier<ClientProjectionSnapshot>>({
      kind: 'clientProjectionSnapshot',
      activeConversationId
    });
  }

  public async clientProjectionSnapshotAndSubscribe(
    activeConversationId: string | null,
    onCommit: (result: RuntimeCommitResult) => void
  ): Promise<SnapshotSubscription<ClientProjectionSnapshot>> {
    return this.barrierAndSubscribe(
      () => this.clientProjectionSnapshot(activeConversationId),
      onCommit
    );
  }

  public async clientKeysetPage(input: ClientKeysetPageInput): Promise<ClientKeysetPageResult> {
    return this.request<ClientKeysetPageResult>({ kind: 'clientKeysetPage', input });
  }

  public async clientVisibleMessageHistoryPage(
    input: ClientVisibleMessageHistoryPageInput
  ): Promise<ClientVisibleMessageHistoryPageResult> {
    return this.request<ClientVisibleMessageHistoryPageResult>({
      kind: 'clientVisibleMessageHistoryPage',
      input
    });
  }

  public async clientCollaborationHistoryPage(
    input: ClientCollaborationHistoryPageInput
  ): Promise<ClientCollaborationHistoryPageResult> {
    return this.request<ClientCollaborationHistoryPageResult>({
      kind: 'clientCollaborationHistoryPage', input
    });
  }

  public async conversationHistoryProjection(
    input: ConversationHistoryProjectionInput
  ): Promise<ConversationHistoryProjectionResult> {
    return this.request<ConversationHistoryProjectionResult>({ kind: 'conversationHistoryProjection', input });
  }

  /**
   * Connection-local SQLite data version observed by this worker's writer connection. It changes
   * only after another SQLite connection commits, so client feeds can discover commits produced by
   * a different Extension Host without turning local streaming commits into snapshot churn.
   */
  public async externalDataVersion(): Promise<string> {
    const version = await this.request<string>({ kind: 'externalDataVersion' });
    if (!/^\d+$/.test(version)) throw new TypeError('SQLite external data version must be decimal.');
    return version;
  }

  /**
   * The carried-work inventory of this whole data set (relocatedWorkInventory), read on the worker's
   * read connection: a data-root relocation settlement takes it again after each round, since
   * settling can create new work (a requester told that nobody will answer).
   */
  public async relocatedWorkInventory(): Promise<RelocatedWorkInventory> {
    return this.request<RelocatedWorkInventory>({ kind: 'relocatedWorkInventory' });
  }

  /**
   * Fixed worker-side EXISTS probe: durable pending work for one conversation across
   * active/queued Turns, finalization, delivery/wake, effect, process and child gaps. The
   * conversation owner manager consults it before any idle release; historical terminal facts
   * alone never retain ownership.
   */
  public async hasConversationRuntimeWork(conversationId: string): Promise<boolean> {
    return this.request<boolean>({
      kind: 'conversationRuntimeWork',
      conversationId: requireNonEmptyText(conversationId, 'conversationId')
    });
  }

  /**
   * Whether another Runtime Host that is alive (or cannot be proven dead) holds an ExecutionLease in
   * the Conversation. A lease handed back or left by a dead Host does not count.
   */
  public async conversationExecutedByLivePeer(conversationId: string): Promise<boolean> {
    const leases = await this.snapshotAll(DOMAIN_REPOSITORIES.domain('ExecutionLease').list({
      where: { conversation_id: requireNonEmptyText(conversationId, 'conversationId') },
      orderBy: { column: 'id', direction: 'asc' },
      limit: 1_000
    }));
    for (const lease of leases.snapshot) {
      const hostBootId = lease.host_boot_id;
      if (typeof hostBootId !== 'string' || hostBootId.length === 0 || hostBootId === this.hostBootId) continue;
      if (await this.isHostAlive(hostBootId)) return true;
    }
    return false;
  }

  /**
   * Cross-Extension-Host liveness used before rebinding an ExecutionLease. The file identity is
   * bound to this immutable Runtime root and Host boot; false is returned only for a definitely
   * dead/reused process identity or a missing/retired registration. Any unknown OS state is
   * conservative (alive): a live or unverifiable peer is never displaced, regardless of
   * heartbeat age. The heartbeat exists only to fence THIS Host's own failure, never to judge
   * peers.
   */
  public async isHostAlive(hostBootIdInput: string): Promise<boolean> {
    const hostBootId = requireNonEmptyText(hostBootIdInput, 'hostBootId');
    if (hostBootId === this.hostBootId) return !this.closed && this.heartbeatFailure === undefined;
    await this.validateBinding('host_liveness');
    const record = await readHostLiveness(this.hostLivenessPath(hostBootId));
    if (!record || !sameLivenessRoot(record, this.binding) || record.hostBootId !== hostBootId) return false;
    return inspectRecordedProcess(record) !== 'dead';
  }

  /**
   * isHostAlive for frequent scans (the takeover scan runs after other windows' commits). The
   * comparison of the recorded process start identity, which some platforms answer by starting a
   * process, is cached per (hostBootId, pid): a match is reused for HOST_IDENTITY_RECHECK_MS, a
   * mismatch or a vanished process stays dead (a hostBootId names one boot, which never comes
   * back). With `compareIdentity: false` no comparison is made at all: only whether the liveness
   * record is there and a process with its PID still exists (a signal-0 probe), so a Host that
   * exited is still recognized at once. Unknown answers are never cached and count as alive.
   */
  public async isHostAliveCached(
    hostBootIdInput: string,
    options: { compareIdentity?: boolean } = {}
  ): Promise<boolean> {
    const hostBootId = requireNonEmptyText(hostBootIdInput, 'hostBootId');
    if (hostBootId === this.hostBootId) return this.isHostAlive(hostBootId);
    await this.validateBinding('host_liveness');
    const record = await readHostLiveness(this.hostLivenessPath(hostBootId));
    if (!record || !sameLivenessRoot(record, this.binding) || record.hostBootId !== hostBootId) return false;
    const key = `${hostBootId}\0${record.processId}`;
    const cached = this.hostIdentityComparisons.get(key);
    if (cached?.result === 'dead') return false;
    const now = Date.now();
    if (options.compareIdentity === false || (cached && now - cached.at < HOST_IDENTITY_RECHECK_MS)) {
      if (!recordedProcessVanished(record.processId)) return true;
      this.rememberHostIdentity(key, 'dead', now);
      return false;
    }
    const inspected = inspectRecordedProcess(record);
    if (inspected !== 'unknown') this.rememberHostIdentity(key, inspected, now);
    return inspected !== 'dead';
  }

  /**
   * The process id a Host registered for this Runtime root, to name its window in a message; this
   * Host's own when asked for itself. Undefined without a registration.
   */
  public async hostProcessId(hostBootIdInput: string): Promise<number | undefined> {
    const hostBootId = requireNonEmptyText(hostBootIdInput, 'hostBootId');
    if (hostBootId === this.hostBootId) return process.pid;
    await this.validateBinding('host_liveness');
    const record = await readHostLiveness(this.hostLivenessPath(hostBootId));
    if (!record || !sameLivenessRoot(record, this.binding) || record.hostBootId !== hostBootId) return undefined;
    return record.processId;
  }

  private rememberHostIdentity(key: string, result: 'alive' | 'dead', at: number): void {
    if (this.hostIdentityComparisons.size >= HOST_IDENTITY_CACHE_ENTRIES) this.hostIdentityComparisons.clear();
    this.hostIdentityComparisons.set(key, { result, at });
  }

  /** The listener receives the object a committed transaction() also resolves with; read-only. */
  public onCommit(listener: (result: RuntimeCommitResult) => void): () => void {
    this.refuseCommitListenerOnMaintenance();
    this.commitListeners.add(listener);
    return () => this.commitListeners.delete(listener);
  }

  /** Release process-local derived evidence on graceful close, worker failure or root fencing. */
  public onClose(listener: () => void): () => void {
    if (this.closed) { listener(); return () => undefined; }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private markClosed(): void {
    this.closed = true;
    this.casAccess.fence();
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
  }

  private refuseCommitListenerOnMaintenance(): void {
    if (this.maintenance) throw new Error('A maintenance Runtime database has no commit listeners.');
  }

  /** Present only while an explicitly attached development observer exists. */
  public get performanceMetrics(): RuntimePerformanceMetricsSink | undefined {
    return this.performanceMetricSinks.size > 0 ? this.performanceMetricFanout : undefined;
  }

  /** Allows a focused benchmark to observe an Application-owned database after it has opened. */
  public attachPerformanceMetrics(sink: RuntimePerformanceMetricsSink): () => void {
    this.performanceMetricSinks.add(sink);
    return () => this.performanceMetricSinks.delete(sink);
  }

  /** Metadata-only hook shared by control planes that already receive this database instance. */
  public recordPerformanceMetric(event: RuntimePerformanceMetricEvent): void {
    recordRuntimePerformanceMetric(this.performanceMetrics, event);
  }

  private async barrierAndSubscribe<T>(
    readBarrier: () => Promise<SnapshotBarrier<T>>,
    onCommit: (result: RuntimeCommitResult) => void
  ): Promise<SnapshotSubscription<T>> {
    this.refuseCommitListenerOnMaintenance();
    const buffered: RuntimeCommitResult[] = [];
    let live = false;
    const listener = (result: RuntimeCommitResult) => {
      if (live) onCommit(result);
      else buffered.push(result);
    };
    this.commitListeners.add(listener);
    try {
      const barrier = await readBarrier();
      const visible = BigInt(barrier.snapshotCommitSeq);
      for (const result of buffered) {
        if (BigInt(result.commitSeq) > visible) onCommit(result);
      }
      live = true;
      return {
        barrier,
        unsubscribe: () => this.commitListeners.delete(listener)
      };
    } catch (error) {
      this.commitListeners.delete(listener);
      throw error;
    }
  }

  /** Fixed domain read; no caller-supplied SQL or closure-table state. */
  public async materializeContext(rootId: string): Promise<SnapshotBarrier<ContextMaterializationSnapshot>> {
    if (typeof rootId !== 'string' || rootId.length === 0) throw new TypeError('Context rootId must be non-empty.');
    return this.request<SnapshotBarrier<ContextMaterializationSnapshot>>({ kind: 'contextMaterialization', rootId });
  }

  /** Fixed Context + CAS read executed off the Extension Host event loop. */
  public async materializeContextContent(
    rootId: string
  ): Promise<SnapshotBarrier<ContextContentMaterializationSnapshot>> {
    if (typeof rootId !== 'string' || rootId.length === 0) throw new TypeError('Context rootId must be non-empty.');
    return this.request<SnapshotBarrier<ContextContentMaterializationSnapshot>>({
      kind: 'contextContentMaterialization', rootId
    });
  }

  public async commitModelStreamEvent(
    input: ModelStreamEventCommitInput,
    options: { beforeSubmit?: () => void } = {}
  ): Promise<ModelStreamEventCommitResult> {
    const executionFence = currentExecutionLeaseFence();
    return this.requestWithExecutionFence(executionFence, {
      kind: 'modelStreamEvent',
      input: executionFence ? { ...input, executionFence } : input
    }, options.beforeSubmit);
  }

  public async recordModelStreamActivity(
    input: ModelStreamActivityInput,
    options: { beforeSubmit?: () => void } = {}
  ): Promise<ModelStreamActivityResult> {
    const executionFence = currentExecutionLeaseFence();
    return this.requestWithExecutionFence(executionFence, {
      kind: 'modelStreamActivity',
      input: executionFence ? { ...input, executionFence } : input
    }, options.beforeSubmit);
  }

  public async cancelCurrentModelRequest(
    input: ModelRequestCancelInput
  ): Promise<ModelRequestCancelResult> {
    const executionFence = currentExecutionLeaseFence();
    return this.requestWithExecutionFence(executionFence, {
      kind: 'cancelCurrentModelRequest',
      input: executionFence ? { ...input, executionFence } : input
    });
  }

  /**
   * An executor CAS and an ownership handoff can race. Ordinary assertion failures retain their
   * original meaning while the captured lease still exists; once its immutable tuple is gone,
   * however, the executor must stand down rather than terminalizing the Turn as a tool/model
   * failure. The verification read is deliberately unfenced and never adopts a newer generation.
   */
  private async requestWithExecutionFence<T>(
    fence: ExecutionLeaseFence | undefined,
    request: DatabaseWorkerRequestPayload,
    beforeSubmit?: () => void
  ): Promise<T> {
    // Cheap local fence: once this Host released the conversation owner, stale fenced callbacks
    // (e.g. a late provider stream event) must fail without any filesystem read per event.
    // Receipt/recovery writers deliberately run without a fence and stay unaffected.
    if (fence && !this.conversationOwners.owns(fence.conversationId)) {
      throw new ConversationRuntimeOwnerReleasedError(fence.conversationId, fence.turnId);
    }
    try {
      return await this.request<T>(request, beforeSubmit);
    } catch (error) {
      if (!fence || !isRuntimeTransactionAssertionError(error)) throw error;
      const stillCurrent = await this.executionFenceStillCurrent(fence).catch(() => false);
      if (stillCurrent) throw error;
      const handoff = new ExecutionHandoffError(
        `ExecutionLease generation ${fence.generation} no longer authorizes Turn ${fence.turnId}.`
      );
      (handoff as ExecutionHandoffError & { cause?: unknown }).cause = error;
      throw handoff;
    }
  }

  private async executionFenceStillCurrent(fence: ExecutionLeaseFence): Promise<boolean> {
    const result = await this.request<SnapshotBarrier<Array<DomainRow | DomainRow[] | null>>>({
      kind: 'snapshot',
      reads: [DOMAIN_REPOSITORIES.domain('ExecutionLease').get(fence.id)]
    });
    const row = result.snapshot[0];
    return !!row
      && !Array.isArray(row)
      && row.conversation_id === fence.conversationId
      && row.turn_id === fence.turnId
      && row.owner_id === fence.ownerId
      && row.host_boot_id === fence.hostBootId
      && row.generation === fence.generation;
  }

  /** Rows over every Runtime domain, counted on this database's own reader connection (no copy). */
  public async countDomainRows(): Promise<number> {
    const rows = await this.request<string>({ kind: 'countDomainRows' });
    if (!/^\d+$/.test(rows)) throw new TypeError('Runtime domain row count must be decimal.');
    return Number(rows);
  }

  public async inspect(): Promise<DatabaseWorkerDiagnostics> {
    return this.request<DatabaseWorkerDiagnostics>({ kind: 'inspect' });
  }

  /**
   * Online, consistent copy of this database through the SQLite Backup API on a dedicated worker
   * connection, so other Hosts keep writing meanwhile. The destination must be a new file inside
   * this root's control directory; the caller verifies and publishes it.
   */
  public async backupTo(destinationPath: string): Promise<void> {
    await this.request<null>({ kind: 'backupDatabase', destinationPath });
  }

  /**
   * Close ordering: sweep timers stop and any in-flight idle sweep (whose probe still reads the
   * database) completes while the worker is open; the writer is fenced next, and only then are
   * durable conversation owner records released — never before, and never after another Host
   * could have registered this Host's liveness identity.
   */
  public close(): Promise<void> {
    this.casAccess.fence();
    this.stopHistoryPreparation(new ExecutionHandoffError('RuntimeDatabase is closing.'));
    if (!this.closePromise) {
      const task = this.closeRuntime();
      this.closePromise = task;
      // The worker remains fenced; a later close retries exact-token owner cleanup only.
      void task.catch(() => {
        if (this.closePromise === task) this.closePromise = undefined;
      });
    }
    return this.closePromise;
  }

  private async closeRuntime(): Promise<void> {
    this.stopHeartbeatTimer();
    this.conversationOwnerSweepsStopped = true;
    if (this.conversationOwnerSweepTimer) {
      clearTimeout(this.conversationOwnerSweepTimer);
      this.conversationOwnerSweepTimer = undefined;
    }
    try {
      await this.historyPreparation.whenIdle();
      await this.heartbeatTask.catch(() => undefined);
      await this.conversationOwnerSweepTask.catch(() => undefined);
      if (!this.closed) await this.sendRequest<null>({ kind: 'close' });
    } finally {
      this.markClosed();
      this.commitListeners.clear();
      await this.worker.terminate();
      // Keep root/Host/conversation admission fenced until both workers and every sidecar handle
      // have closed. A failed resource close can be retried; it cannot release ownership early.
      await this.casAccess.close();
      if (OPEN_ROOT_POINTERS.get(this.registryKey) === this.hostBootId) {
        OPEN_ROOT_POINTERS.delete(this.registryKey);
      }
      // The worker ignores every request that reached it after 'close', and a graceful exit fails
      // none of them. Reject them here, or an owner operation awaiting one would hold close forever.
      this.failPending(new Error('RuntimeDatabase is closed.'));
      try {
        await this.conversationOwners.close();
      } finally {
        await this.unregisterHostLiveness().catch(() => undefined);
        this.performanceMetricSinks.clear();
      }
    }
  }

  /** Validate the live owner/root of immutable cached evidence without issuing a SQLite request. */
  public async assertUsableBinding(requestKind: RuntimeDatabaseMetricRequestKind = 'snapshot'): Promise<RootBinding> {
    this.assertUsable();
    const binding = await this.validateBinding(requestKind);
    // A worker exit or heartbeat failure while root validation yielded still fences cached reads.
    this.assertUsable();
    return binding;
  }

  private assertUsable(): void {
    if (this.closed) throw new Error('RuntimeDatabase is closed.');
    this.casAccess.assertUsable();
    if (this.heartbeatFailure !== undefined) {
      const error = new Error('RuntimeDatabase Host liveness heartbeat failed; requests are fenced until restart.') as Error & {
        cause?: unknown;
      };
      error.cause = this.heartbeatFailure;
      throw error;
    }
  }

  private async request<T>(request: DatabaseWorkerRequestPayload, beforeSubmit?: () => void): Promise<T> {
    await this.assertUsableBinding(databaseMetricRequestKind(request.kind));
    beforeSubmit?.();
    return this.sendRequest<T>(request);
  }

  private async validateBinding(
    requestKind: RuntimeDatabaseMetricRequestKind | 'host_liveness'
  ): Promise<RootBinding> {
    const metrics = this.performanceMetrics;
    const startedAtMs = metrics ? performance.now() : undefined;
    try {
      const binding = await this.authority.validate(this.binding);
      if (metrics && startedAtMs !== undefined) {
        recordRuntimePerformanceMetric(metrics, {
          kind: 'database.root_validate',
          requestKind,
          durationMs: performance.now() - startedAtMs,
          outcome: 'ok'
        });
      }
      return binding;
    } catch (error) {
      if (metrics && startedAtMs !== undefined) {
        recordRuntimePerformanceMetric(metrics, {
          kind: 'database.root_validate',
          requestKind,
          durationMs: performance.now() - startedAtMs,
          outcome: 'error'
        });
      }
      throw error;
    }
  }

  private async registerHostLiveness(): Promise<void> {
    await this.writeHostHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.heartbeatTask = this.heartbeatTask
        .then(() => this.writeHostHeartbeat())
        .catch((error) => {
          this.heartbeatFailure = error;
          this.stopHeartbeatTimer();
          this.failPending(error);
          this.markClosed();
          this.commitListeners.clear();
          // Registration and conversation owners are retained fail-closed; only an explicit
          // graceful close() unregisters after the writer is fenced and work is drained.
          void this.worker.terminate().catch(() => undefined);
        });
    }, HOST_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref();
  }

  private async writeHostHeartbeat(): Promise<void> {
    if (this.closed) return;
    const record: RuntimeHostLivenessRecord = {
      kind: 'limcode-runtime-host-liveness',
      dataSetId: this.binding.dataSetId,
      rootInstanceId: this.binding.rootInstanceId,
      rootGeneration: this.binding.rootGeneration,
      hostBootId: this.hostBootId,
      livenessId: this.livenessId,
      processId: process.pid,
      ...(this.processStartIdentity ? { processStartIdentity: this.processStartIdentity } : {}),
      startedAt: this.startedAt,
      heartbeatAt: new Date().toISOString()
    };
    const target = this.hostLivenessPath(this.hostBootId);
    const directory = path.dirname(target);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${target}.${this.livenessId}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, target);
  }

  private async unregisterHostLiveness(): Promise<void> {
    const target = this.hostLivenessPath(this.hostBootId);
    const record = await readHostLiveness(target);
    if (record?.livenessId !== this.livenessId) return;
    await fs.rm(target, { force: true });
  }

  private stopHeartbeatTimer(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  /**
   * Commit-triggered idle sweep, coalesced so a commit burst schedules at most one bounded pass
   * and only one sweep ever runs at a time. Sweep probes are ordinary worker reads, so the pass
   * must finish before the worker closes (see close()).
   */
  private scheduleConversationOwnerSweep(): void {
    if (this.closed || this.conversationOwnerSweepsStopped || this.conversationOwnerSweepTimer) return;
    this.conversationOwnerSweepTimer = setTimeout(() => {
      this.conversationOwnerSweepTimer = undefined;
      this.conversationOwnerSweepTask = this.conversationOwnerSweepTask
        .then(() => this.conversationOwners.sweepIdle())
        .catch(() => undefined);
    }, CONVERSATION_OWNER_SWEEP_DELAY_MS);
    this.conversationOwnerSweepTimer.unref();
  }

  private hostLivenessPath(hostBootId: string): string {
    const digest = createHash('sha256')
      .update('limcode-runtime-host-liveness\0')
      .update(hostBootId)
      .digest('hex');
    return path.join(runtimeHostLivenessDirectory(this.binding.paths), `${digest}.json`);
  }

  private sendRequest<T>(request: DatabaseWorkerRequestPayload): Promise<T> {
    if (this.closed) return Promise.reject(new Error('RuntimeDatabase is closed.'));
    const id = this.nextRequestId++;
    const metrics = this.performanceMetrics;
    const startedAtMs = metrics ? performance.now() : undefined;
    const requestKind = databaseMetricRequestKind(request.kind);
    if (metrics) {
      recordRuntimePerformanceMetric(metrics, {
        kind: 'database.request',
        phase: 'started',
        requestKind
      });
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        requestKind,
        ...(startedAtMs !== undefined ? { startedAtMs } : {})
      });
      this.worker.postMessage({
        ...request,
        id,
        ...(startedAtMs !== undefined ? { metricEnqueuedAtMs: performance.now() } : {})
      } as DatabaseWorkerRequest);
    });
  }

  private onMessage(message: DatabaseWorkerResponse): void {
    if (message.type === 'commit') {
      this.lastCommit = message.result;
      const metrics = this.performanceMetrics;
      const startedAtMs = metrics ? performance.now() : undefined;
      const listenerCount = this.commitListeners.size;
      try {
        for (const listener of this.commitListeners) listener(message.result);
      } finally {
        if (metrics && startedAtMs !== undefined) {
          recordRuntimePerformanceMetric(metrics, {
            kind: 'database.commit_listeners',
            listenerCount,
            durationMs: performance.now() - startedAtMs
          });
        }
        this.scheduleConversationOwnerSweep();
      }
      return;
    }
    if (message.type === 'fatal') {
      this.stopHistoryPreparation(new RuntimeDatabaseWorkerError(message.error));
      this.failPending(new RuntimeDatabaseWorkerError(message.error));
      return;
    }
    if (message.type !== 'response') return;
    // The worker posts a transaction's commit message and its response back to back.
    const lastCommit = this.lastCommit;
    this.lastCommit = undefined;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    const metrics = this.performanceMetrics;
    if (metrics && pending.startedAtMs !== undefined) {
      recordRuntimePerformanceMetric(metrics, {
        kind: 'database.request',
        phase: 'finished',
        requestKind: pending.requestKind,
        outcome: message.ok ? 'ok' : 'error',
        roundTripDurationMs: performance.now() - pending.startedAtMs,
        ...(message.timing ? {
          workerQueueWaitMs: message.timing.queueWaitMs,
          workerExecuteDurationMs: message.timing.executeDurationMs
        } : {}),
        ...(message.timing?.writeLock ? {
          writeLockWaitMs: message.timing.writeLock.waitMs,
          writeLockHoldMs: message.timing.writeLock.holdMs,
          writeLockStage: message.timing.writeLock.stage,
          ...(message.timing.writeLock.domain ? { writeDomain: message.timing.writeLock.domain } : {})
        } : {}),
        ...(message.ok ? {} : sqliteFailureMetric(message.error))
      });
    }
    if (!message.ok) pending.reject(new RuntimeDatabaseWorkerError(message.error));
    else if (message.committed === undefined) pending.resolve(message.result);
    else if (lastCommit?.commitSeq === message.committed) pending.resolve(lastCommit);
    else pending.reject(new Error(`RuntimeDatabase worker answered commit ${message.committed} without its commit message.`));
  }

  private failPending(error: unknown): void {
    const metrics = this.performanceMetrics;
    for (const pending of this.pending.values()) {
      if (metrics && pending.startedAtMs !== undefined) {
        recordRuntimePerformanceMetric(metrics, {
          kind: 'database.request',
          phase: 'finished',
          requestKind: pending.requestKind,
          outcome: 'error',
          roundTripDurationMs: performance.now() - pending.startedAtMs
        });
      }
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function sqliteFailureMetric(error: SerializedWorkerError): { sqliteErrorCode?: string; databaseLocked?: boolean } {
  const code = typeof error.code === 'string' && /^SQLITE_[A-Z_]{1,48}$/.test(error.code) ? error.code : undefined;
  const databaseLocked = /database (?:table )?is locked/i.test(error.message);
  return {
    ...(code ? { sqliteErrorCode: code } : {}),
    ...(databaseLocked ? { databaseLocked } : {})
  };
}

export async function initializeEmptyRuntimeRoot(authority: RootAuthority): Promise<RootBinding> {
  return authority.initializeEmptyRoot(initializeBindingStorage);
}

/** Fixed SQLite/CAS initializer used only by RootAuthority's offline cutover activation. */
export async function initializeCutoverRuntimeBinding(binding: RootBinding): Promise<void> {
  return initializeBindingStorage(binding);
}

export async function resetCandidateRuntimeRoot(candidateParentPath: string): Promise<{
  authority: RootAuthority;
  binding: RootBinding;
}> {
  const pointerPath = path.join(path.resolve(candidateParentPath), ROOT_BINDING_POINTER_FILE);
  if (OPEN_ROOT_POINTERS.has(pointerPath)) {
    throw new Error('Candidate root reset requires the current Runtime database worker to be closed first.');
  }
  return RootAuthority.resetCandidateRoot(candidateParentPath, initializeBindingStorage);
}

async function initializeBindingStorage(binding: RootBinding): Promise<void> {
  const worker = createWorker({ mode: 'initialize', binding, hostBootId: randomUUID() });
  await new Promise<void>((resolve, reject) => {
    let ready = false;
    worker.on('message', (message: DatabaseWorkerResponse) => {
      if (message.type === 'fatal') reject(new RuntimeDatabaseWorkerError(message.error));
      else if (message.type === 'ready') ready = message.mode === 'initialize';
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0 && ready) resolve();
      else reject(new Error(`SQLite initialization worker exited with code ${code}${ready ? '' : ' before ready'}.`));
    });
  });
}

/**
 * The worker's SQLite locks belong to this whole process, so while it runs the in-process file
 * entry points refuse its database files under any name (sqliteDatabaseFileGuard).
 */
function createWorker(data: DatabaseWorkerData, resourceLimits?: ResourceLimits): Worker {
  const releaseRuntime = registerInProcessSqliteDatabase(data.binding.paths.databasePath);
  const releaseCas = registerInProcessSqliteDatabase(path.join(data.binding.paths.casRootPath, 'limcode.cas-small.sqlite'));
  const release = () => { releaseRuntime(); releaseCas(); };
  try {
    const worker = new Worker(path.join(__dirname, 'databaseWorker.js'), { workerData: data, ...(resourceLimits ? { resourceLimits } : {}) });
    worker.once('exit', release);
    return worker;
  } catch (error) {
    release();
    throw error;
  }
}

function waitForReady(
  worker: Worker,
  expectedMode: DatabaseWorkerData['mode']
): Promise<{ workerThreadId: number }> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: DatabaseWorkerResponse) => {
      if (message.type === 'fatal') {
        cleanup();
        reject(new RuntimeDatabaseWorkerError(message.error));
      } else if (message.type === 'ready') {
        cleanup();
        if (message.mode !== expectedMode) reject(new Error(`Unexpected database worker mode: ${message.mode}`));
        else resolve({ workerThreadId: message.workerThreadId });
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number) => {
      if (code === 0) return;
      cleanup();
      reject(new Error(`SQLite database worker exited before ready with code ${code}.`));
    };
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
  });
}

function isRuntimeTransactionAssertionError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}

function databaseMetricRequestKind(
  kind: DatabaseWorkerRequestPayload['kind']
): RuntimeDatabaseMetricRequestKind {
  if (kind === 'nativePendingWork' || kind === 'nativeSteeringInFlight' || kind === 'nativeAdmittedProviderCallIds') return 'snapshot';
  if (kind === 'selectedContextAuthoritySource') return 'snapshot';
  // Historical Message pages are the backwards/keyset form of the existing bounded page metric.
  if (kind === 'clientVisibleMessageHistoryPage' || kind === 'clientCollaborationHistoryPage') return 'clientKeysetPage';
  // The conversation pending-work probe, the domain row count and the carried-work inventory are one
  // fixed worker read snapshot each.
  if (kind === 'conversationRuntimeWork' || kind === 'countDomainRows' || kind === 'relocatedWorkInventory' || kind === 'mergeModelAggregates') return 'snapshot';
  // A maintenance transaction's requests are parts of one write transaction; the durability
  // checkpoint is the last step of the transactions before it.
  if (kind.startsWith('maintenance') || kind === 'durabilityCheckpoint') return 'transaction';
  return kind as RuntimeDatabaseMetricRequestKind;
}

async function readHostLiveness(filePath: string): Promise<RuntimeHostLivenessRecord | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    // A torn/corrupt liveness record must never be interpreted as proof that another Host is alive.
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.kind !== 'limcode-runtime-host-liveness'
    || typeof record.dataSetId !== 'string'
    || typeof record.rootInstanceId !== 'string'
    || !Number.isSafeInteger(record.rootGeneration)
    || typeof record.hostBootId !== 'string'
    || typeof record.livenessId !== 'string'
    || !Number.isSafeInteger(record.processId)
    || typeof record.startedAt !== 'string'
    || typeof record.heartbeatAt !== 'string'
    || (record.processStartIdentity !== undefined && typeof record.processStartIdentity !== 'string')
  ) return undefined;
  return record as unknown as RuntimeHostLivenessRecord;
}

function sameLivenessRoot(record: RuntimeHostLivenessRecord, binding: RootBinding): boolean {
  return record.dataSetId === binding.dataSetId
    && record.rootInstanceId === binding.rootInstanceId
    && record.rootGeneration === binding.rootGeneration;
}

/** Whether no process with this PID exists any more (signal 0 reports ESRCH); anything else is not proof. */
function recordedProcessVanished(processId: number): boolean {
  if (!Number.isSafeInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH';
  }
}

function inspectRecordedProcess(record: RuntimeHostLivenessRecord): 'alive' | 'dead' | 'unknown' {
  if (!Number.isSafeInteger(record.processId) || record.processId <= 0) return 'unknown';
  try {
    process.kill(record.processId, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
  if (!record.processStartIdentity) return 'alive';
  const currentIdentity = readProcessStartIdentity(record.processId);
  if (currentIdentity === undefined) return 'unknown';
  return currentIdentity === record.processStartIdentity ? 'alive' : 'dead';
}

/** Supported hosts fence PID reuse with the same platform-specific identity as process wrappers. */
function readProcessStartIdentity(processId: number): string | undefined {
  try {
    return readProcessStartFingerprint(processId);
  } catch {
    return undefined;
  }
}

function requireNonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}
