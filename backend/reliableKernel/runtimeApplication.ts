import {
  ReliableAgentLoop,
  type ReliableAgentLifecycleObserver,
  type ReliableAgentProviderRegistry,
  type ReliableAgentToolDispatcher,
  type ReliableAgentTransientObserver
} from './agentLoop';
import {
  AttachmentIngestService,
  type AttachmentSettingsAuthority
} from './attachmentIngest';
import {
  createReliableKernelRuntimeServices,
  type ReliableKernelRuntimeServices
} from './runtimeServices';
import { ContentAddressedStore } from './contentAddressedStore';
import { ContextCompressionControlPlane } from './contextCompression';
import { ConversationDeletionControlPlane } from './conversationDeletion';
import { ReliableContextCompressionCoordinator } from './contextCompressionCoordinator';
import { ContextSequenceControlPlane } from './contextSequence';
import type { RuntimeBuildInfoRecord } from '../../shared/protocol';
import type { ReliableDiagnosticObserver } from './diagnosticJournal';
import {
  FileChangeControlPlane,
  FileMutationDispatcher,
  type WorkEnvironmentBoundaryResolver
} from './fileEffects';
import {
  McpEffectDispatcher,
  type McpExistingPolicyGate,
  type McpMemoryConnectionRegistry
} from './mcpEffects';
import { ModelProviderControlPlane } from './modelProviderControlPlane';
import type { CompressionSettingsAuthority } from './requestCompressionSettings';
import { PhaseDRecoveryScanner, type PhaseDRecoveryResult } from './phaseDRecovery';
import { type PhaseFRecoveryResult } from './phaseFRecovery';
import { ProcessControlPlane } from './processEffects';
import { ChildOwnedProcessCleanupControlPlane } from './childOwnedProcessCleanup';
import {
  ProcessCompletionDeliveryControlPlane,
  type ProcessCompletionDeliveryOptions,
  type ProcessCompletionWakeHandler
} from './processCompletionDelivery';
import { RootAuthority } from './rootAuthority';
import { RuntimeDatabase } from './runtimeDatabase';
import { listAllDomainRows } from './repositoryPagination';
import { ToolInteractionControlPlane } from './toolInteractions';
import {
  TurnControlPlane,
  type TurnAuthorityCompiler
} from './turnControlPlane';
import { TurnOutputControlPlane } from './turnOutput';
import { ExecutionHandoffError } from './executionLeaseFence';
import { ReliableKernelWebviewFeedBridge } from './webviewFeedBridge';

export interface ReliableKernelToolDispatcherContext {
  database: RuntimeDatabase;
  contentStore: ContentAddressedStore;
  runtime: ReliableKernelRuntimeServices;
  files: FileChangeControlPlane;
  fileMutations: FileMutationDispatcher;
  processes: ProcessControlPlane;
  mcp: McpEffectDispatcher;
  interactions: ToolInteractionControlPlane;
  attachments: AttachmentIngestService;
  turns: TurnControlPlane;
  turnOutput: TurnOutputControlPlane;
}

function missingToolDispatcher(): never {
  throw new TypeError('ReliableKernelApplication requires toolDispatcher or createToolDispatcher.');
}

function missingMcpPolicyGate(): never {
  throw new TypeError('ReliableKernelApplication requires mcpPolicyGate or createMcpPolicyGate.');
}

export interface ReliableKernelApplicationDependencies {
  authorityCompiler: TurnAuthorityCompiler;
  compressionSettingsAuthority?: CompressionSettingsAuthority;
  resolveWorkEnvironment: WorkEnvironmentBoundaryResolver;
  mcpConnections: McpMemoryConnectionRegistry;
  mcpPolicyGate?: McpExistingPolicyGate;
  createMcpPolicyGate?: (context: {
    database: RuntimeDatabase;
    contentStore: ContentAddressedStore;
  }) => McpExistingPolicyGate;
  attachmentSettings: AttachmentSettingsAuthority;
  providers: ReliableAgentProviderRegistry;
  toolDispatcher?: ReliableAgentToolDispatcher;
  createToolDispatcher?: (context: ReliableKernelToolDispatcherContext) => ReliableAgentToolDispatcher;
  transientObserver?: ReliableAgentTransientObserver;
  lifecycleObserver?: ReliableAgentLifecycleObserver;
  diagnosticObserver?: ReliableDiagnosticObserver;
  runtimeBuildInfo?: () => RuntimeBuildInfoRecord;
  processCompletionWakeHandler?: ProcessCompletionWakeHandler;
  /**
   * Scanner pacing for the durable wake outbox; production keeps the defaults. `onError` observes
   * each scan, receipt or wake failure in addition to the diagnostic event.
   */
  processCompletionDelivery?: Pick<ProcessCompletionDeliveryOptions, 'scanIntervalMs' | 'retryBaseMs' | 'maxFailureCount' | 'onError'>;
  now?: () => string;
}

export interface ReliableKernelRecoveryReport {
  phaseD: PhaseDRecoveryResult[];
  phaseF: PhaseFRecoveryResult[];
}

/**
 * 可靠运行内核的唯一组合根。
 *
 * 该对象只接收配置 authority 和外部 capability adapter，不读取旧文件 Runtime，也不拥有
 * VS Code/Webview 展示规则。SQLite worker 是唯一 Runtime writer；所有长期服务共享同一个
 * fenced RootBinding、RuntimeDatabase 和 CAS。
 */
export class ReliableKernelApplication {
  public readonly database: RuntimeDatabase;
  public readonly contentStore: ContentAddressedStore;
  public readonly runtime: ReliableKernelRuntimeServices;
  public readonly conversationDeletion: ConversationDeletionControlPlane;
  public readonly context: ContextSequenceControlPlane;
  public readonly compression: ContextCompressionControlPlane;
  public readonly compressionCoordinator: ReliableContextCompressionCoordinator;
  public readonly modelProvider: ModelProviderControlPlane;
  public readonly files: FileChangeControlPlane;
  public readonly fileMutations: FileMutationDispatcher;
  public readonly processes: ProcessControlPlane;
  public readonly childOwnedProcessCleanup: ChildOwnedProcessCleanupControlPlane;
  public readonly processDeliveries: ProcessCompletionDeliveryControlPlane;
  public readonly mcp: McpEffectDispatcher;
  public readonly interactions: ToolInteractionControlPlane;
  public readonly attachments: AttachmentIngestService;
  public readonly turns: TurnControlPlane;
  public readonly turnOutput: TurnOutputControlPlane;
  public readonly toolDispatcher: ReliableAgentToolDispatcher;
  public readonly agentLoop: ReliableAgentLoop;
  public readonly phaseDRecovery: PhaseDRecoveryScanner;
  public readonly webviewFeed: ReliableKernelWebviewFeedBridge;

  private closePromise: Promise<void> | undefined;
  private handoffPromise: Promise<void> | undefined;
  private convergenceTimer: NodeJS.Timeout | undefined;
  private convergenceTask: Promise<void> | undefined;
  private convergenceRequested = false;
  private convergenceClosed = false;
  private convergenceRetryDelayMs = 0;
  private unsubscribeConvergence: (() => void) | undefined;
  private readonly providers: ReliableAgentProviderRegistry;
  private readonly diagnosticObserver: ReliableDiagnosticObserver | undefined;

  private constructor(
    private readonly authority: RootAuthority,
    database: RuntimeDatabase,
    contentStore: ContentAddressedStore,
    dependencies: ReliableKernelApplicationDependencies
  ) {
    this.providers = dependencies.providers;
    this.diagnosticObserver = dependencies.diagnosticObserver;
    this.database = database;
    this.contentStore = contentStore;

    const options = dependencies.now ? { now: dependencies.now } : {};
    this.attachments = new AttachmentIngestService(
      database,
      contentStore,
      dependencies.attachmentSettings,
      options
    );
    this.runtime = createReliableKernelRuntimeServices(database, contentStore, {
      ...options,
      authorityCompiler: dependencies.authorityCompiler,
      attachments: this.attachments
    });
    this.conversationDeletion = new ConversationDeletionControlPlane(database);
    this.context = new ContextSequenceControlPlane(database, contentStore, options);
    this.compression = new ContextCompressionControlPlane(database, contentStore, options);
    this.modelProvider = new ModelProviderControlPlane(database, contentStore, {
      ...options,
      attachments: this.attachments,
      compressionSettingsAuthority: dependencies.compressionSettingsAuthority
    });
    this.compressionCoordinator = new ReliableContextCompressionCoordinator(
      database,
      contentStore,
      this.modelProvider,
      dependencies.providers,
      options
    );
    this.files = new FileChangeControlPlane(database, contentStore, this.runtime.effects, options);
    this.fileMutations = new FileMutationDispatcher(
      database,
      contentStore,
      this.runtime.effects,
      dependencies.resolveWorkEnvironment,
      () => this.scheduleRuntimeConvergence()
    );
    this.processes = new ProcessControlPlane(
      database,
      contentStore,
      this.runtime.effects,
      authority,
      database.binding,
      {
        ...options,
        onExitObserverError: ({ processId, error }) => dependencies.diagnosticObserver?.observe({
          eventKind: 'process.exit_observer.failed',
          scopeKind: 'runtime',
          correlationId: processId,
          metadata: {
            kind: 'process-exit-observer',
            status: 'failed',
            hostBootId: database.hostBootId,
            errorName: safeErrorName(error)
          }
        })
      }
    );
    this.runtime.details.setProcessOutputReconciler((processId) =>
      this.processes.snapshotOutputForDetail(processId)
    );
    this.childOwnedProcessCleanup = new ChildOwnedProcessCleanupControlPlane(
      database,
      this.processes,
      dependencies.now
    );
    this.processDeliveries = new ProcessCompletionDeliveryControlPlane(
      database,
      contentStore,
      this.processes,
      this.runtime.deliveries,
      {
        ...options,
        ...dependencies.processCompletionDelivery,
        wakeHandler: dependencies.processCompletionWakeHandler,
        onError: (failure) => {
          dependencies.diagnosticObserver?.observe({
            eventKind: 'process.completion_delivery.failed',
            scopeKind: 'runtime',
            correlationId: failure.id,
            metadata: {
              kind: 'process-completion-delivery',
              scope: failure.scope,
              status: 'failed',
              hostBootId: database.hostBootId,
              errorName: safeErrorName(failure.error)
            }
          });
          dependencies.processCompletionDelivery?.onError?.(failure);
        }
      }
    );
    this.processes.setProcessReceiptObserver((processId) => {
      this.processDeliveries.notifyProcessReceipt(processId);
    });
    const mcpPolicyGate = dependencies.mcpPolicyGate
      ?? dependencies.createMcpPolicyGate?.({ database, contentStore })
      ?? missingMcpPolicyGate();
    this.mcp = new McpEffectDispatcher(
      database,
      this.runtime.effects,
      dependencies.mcpConnections,
      mcpPolicyGate
    );
    this.interactions = new ToolInteractionControlPlane(database, contentStore, this.runtime.effects, options);
    this.turns = new TurnControlPlane(database, contentStore, {
      authorityCompiler: dependencies.authorityCompiler,
      attachments: this.attachments,
      unresolvedFileClosure: this.files,
      prepareNextTurnDeliverySteps: (conversationId, turnId, now, startingDeliveryId) =>
        this.runtime.deliveries.prepareNextTurnDeliverySteps(conversationId, turnId, now, startingDeliveryId),
      ...options
    });
    this.turnOutput = new TurnOutputControlPlane(database, contentStore, options);
    this.toolDispatcher = dependencies.toolDispatcher ?? dependencies.createToolDispatcher?.({
      database,
      contentStore,
      runtime: this.runtime,
      files: this.files,
      fileMutations: this.fileMutations,
      processes: this.processes,
      mcp: this.mcp,
      interactions: this.interactions,
      attachments: this.attachments,
      turns: this.turns,
      turnOutput: this.turnOutput
    }) ?? missingToolDispatcher();
    this.phaseDRecovery = new PhaseDRecoveryScanner(
      database,
      this.runtime.effects,
      this.files,
      this.processes,
      this.mcp,
      dependencies.resolveWorkEnvironment,
      this.turns
    );
    this.agentLoop = new ReliableAgentLoop(
      database,
      contentStore,
      this.turns,
      this.turnOutput,
      this.modelProvider,
      this.runtime.effects,
      this.runtime.deliveries,
      dependencies.providers,
      this.compressionCoordinator,
      this.toolDispatcher,
      dependencies.transientObserver,
      dependencies.lifecycleObserver,
      {
        ...options,
        reconcileCommittedToolCall: async (toolCallId) => {
          await this.phaseDRecovery.reconcileCommittedFacts();
          return this.runtime.effects.readTerminalResult(toolCallId, false);
        }
      }
    );
    this.unsubscribeConvergence = database.onCommit((commit) => {
      if (!commit.changes.some((change) => [
        'EffectIntent',
        'EffectReceipt',
        'Operation',
        'ToolResultArtifact',
        'InteractionResponse',
        'FileChangeDecision',
        'CollaborationMessage',
        'CollaborationRequest',
        'RuntimeDelivery',
        'RuntimeDeliveryInputLink',
        'TurnTermination'
      ].includes(change.domain))) return;
      this.scheduleRuntimeConvergence();
    });
    this.webviewFeed = new ReliableKernelWebviewFeedBridge(
      this.runtime.clientFeed,
      this.runtime.details,
      undefined,
      dependencies.diagnosticObserver,
      dependencies.runtimeBuildInfo,
      this.runtime.history
    );
  }

  /** Opens only an already activated current Runtime root. Missing/pending/stale roots fail closed. */
  public static async open(
    authority: RootAuthority,
    dependencies: ReliableKernelApplicationDependencies
  ): Promise<ReliableKernelApplication> {
    const database = await RuntimeDatabase.open(authority);
    try {
      const contentStore = new ContentAddressedStore(authority, database.binding);
      return new ReliableKernelApplication(authority, database, contentStore, dependencies);
    } catch (error) {
      await database.close();
      throw error;
    }
  }

  public async validateBinding(): Promise<void> {
    await this.authority.validate(this.database.binding);
  }

  /** Runs deterministic recovery and DB-only Context integrity maintenance; never retries ambiguous effects. */
  public async recover(signal?: AbortSignal): Promise<ReliableKernelRecoveryReport> {
    signal?.throwIfAborted();
    await this.validateBinding();
    signal?.throwIfAborted();
    const phaseD = await this.phaseDRecovery.runAll(signal);
    const phaseF = await this.runtime.recovery.runAll(signal);
    signal?.throwIfAborted();
    await this.processes.cleanupArchivedSpools(signal);
    signal?.throwIfAborted();
    await this.childOwnedProcessCleanup.start();
    // Orphan tool-pair cleanup is an explicit cutover/diagnostic maintenance command. Runtime
    // mutations are transactionally closed now, so rescanning and materializing every Context
    // lineage on each Host activation only stalls live commands without repairing a new crash edge.
    signal?.throwIfAborted();
    await this.processDeliveries.start();
    await this.runtime.collaboration.reconcile();
    await this.processes.startExitObservers();
    for (const result of phaseD) {
      this.diagnosticObserver?.observe({
        eventKind: 'recovery.scan.completed',
        scopeKind: 'runtime',
        correlationId: result.id,
        metadata: {
          kind: 'phase-d',
          status: 'completed',
          hostBootId: this.database.hostBootId,
          scanned: result.scanned,
          reconciled: result.reconciled,
          unknown: result.unknown
        }
      });
    }
    for (const result of phaseF) {
      this.diagnosticObserver?.observe({
        eventKind: 'recovery.scan.completed',
        scopeKind: 'runtime',
        correlationId: result.id,
        metadata: {
          kind: 'phase-f',
          status: 'completed',
          hostBootId: this.database.hostBootId,
          scanned: result.scanned,
          reconciled: result.reconciled,
          unchanged: result.unchanged
        }
      });
    }
    return { phaseD, phaseF };
  }

  /** Reconciles only a newly claimed conversation; opening a view must not recover its peers. */
  public async recoverConversation(conversationId: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await this.database.conversationOwners.assertOwned(conversationId);
    await this.phaseDRecovery.runAll(signal, conversationId);
    await this.runtime.recovery.runAll(signal, conversationId);
    signal?.throwIfAborted();
    this.scheduleRuntimeConvergence();
  }

  /** External SQLite commits do not arrive through this host's onCommit listener. */
  public async refreshExternalRuntimeWork(): Promise<void> {
    if (this.convergenceClosed) return;
    this.scheduleRuntimeConvergence();
    await this.database.conversationOwners.sweepIdle();
  }

  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      this.convergenceClosed = true;
      this.unsubscribeConvergence?.();
      this.unsubscribeConvergence = undefined;
      if (this.convergenceTimer) clearTimeout(this.convergenceTimer);
      this.convergenceTimer = undefined;
      await this.convergenceTask?.catch(() => undefined);
      this.webviewFeed.close();
      this.runtime.clientFeed.close();
      await this.beginHandoff();
      await this.childOwnedProcessCleanup.dispose();
      await this.processes.dispose();
      await this.processDeliveries.dispose();
      await this.toolDispatcher.dispose?.();
      await this.providers.dispose?.();
      await this.database.close();
    })();
    return this.closePromise;
  }

  /**
   * Durable effect facts are level-triggered locally as well as at startup. A committed receipt,
   * terminal Operation or model artifact must not depend on the original dispatcher Promise
   * reaching its next line of code.
   */
  private scheduleRuntimeConvergence(): void {
    if (this.convergenceClosed) return;
    this.convergenceRequested = true;
    if (this.convergenceTimer || this.convergenceTask) return;
    this.convergenceTimer = setTimeout(() => {
      this.convergenceTimer = undefined;
      const task = this.runRuntimeConvergence();
      this.convergenceTask = task;
      void task.finally(() => {
        if (this.convergenceTask === task) this.convergenceTask = undefined;
        if (this.convergenceRequested) this.scheduleRuntimeConvergence();
      }).catch(() => undefined);
    }, this.convergenceRetryDelayMs || 100);
    this.convergenceTimer.unref();
  }

  private async runRuntimeConvergence(): Promise<void> {
    this.convergenceRequested = false;
    let failed = 0;
    try {
      const pendingFileMutations = await listAllDomainRows(this.database, 'EffectIntent', {
        effect_kind: 'file_mutation',
        dispatch_state: 'pending'
      });
      for (const intent of pendingFileMutations) {
        try {
          await this.convergeOwnedEffect(String(intent.id), () =>
            this.fileMutations.dispatchRecordAndReconcile(String(intent.id))
          );
        } catch (error) {
          failed += 1;
          this.diagnosticObserver?.observe({
            eventKind: 'recovery.scan.failed',
            scopeKind: 'runtime',
            correlationId: String(intent.id),
            metadata: {
              kind: 'runtime-file-mutation-convergence',
              status: 'failed',
              hostBootId: this.database.hostBootId,
              errorName: safeErrorName(error)
            }
          });
        }
      }
      const dispatchedFileMutations = await listAllDomainRows(this.database, 'EffectIntent', {
        effect_kind: 'file_mutation',
        dispatch_state: 'dispatched'
      });
      for (const intent of dispatchedFileMutations) {
        const effectIntentId = String(intent.id);
        if (this.fileMutations.isDispatchActive(effectIntentId)) continue;
        const fence = await this.runtime.effects.readEffectDispatchFence(effectIntentId);
        if (fence?.hostBootId !== this.database.hostBootId) continue;
        try {
          await this.convergeOwnedEffect(effectIntentId, () =>
            this.fileMutations.recoverDispatchedAndReconcile(effectIntentId)
          );
        } catch (error) {
          failed += 1;
          this.diagnosticObserver?.observe({
            eventKind: 'recovery.scan.failed',
            scopeKind: 'runtime',
            correlationId: effectIntentId,
            metadata: {
              kind: 'runtime-dispatched-file-mutation-convergence',
              status: 'failed',
              hostBootId: this.database.hostBootId,
              errorName: safeErrorName(error)
            }
          });
        }
      }
      const convergence = await this.phaseDRecovery.reconcileCommittedFacts();
      failed += convergence.failed;
      await this.runtime.collaboration.reconcile();
    } catch (error) {
      failed += 1;
      this.diagnosticObserver?.observe({
        eventKind: 'recovery.scan.failed',
        scopeKind: 'runtime',
        correlationId: this.database.hostBootId,
        metadata: {
          kind: 'runtime-convergence',
          status: 'failed',
          hostBootId: this.database.hostBootId,
          errorName: safeErrorName(error)
        }
      });
    }
    if (failed > 0 && !this.convergenceClosed) {
      this.convergenceRetryDelayMs = Math.min(
        this.convergenceRetryDelayMs > 0 ? this.convergenceRetryDelayMs * 2 : 100,
        2_000
      );
      this.convergenceRequested = true;
    } else {
      this.convergenceRetryDelayMs = 0;
    }
  }

  private async convergeOwnedEffect(effectIntentId: string, operation: () => Promise<unknown>): Promise<void> {
    const conversationId = await this.runtime.effects.conversationIdForEffect(effectIntentId);
    if (conversationId === null) {
      await operation();
      return;
    }
    const owners = this.database.conversationOwners;
    if (!owners.owns(conversationId)) return;
    await owners.run(conversationId, async () => { await operation(); });
  }

  public beginHandoff(
    reason = new ExecutionHandoffError('Reliable Runtime is closing for Host handoff.')
  ): Promise<void> {
    if (this.handoffPromise) return this.handoffPromise;
    this.handoffPromise = Promise.allSettled([
      this.modelProvider.quiesceAllActiveDispatches(reason),
      Promise.resolve(this.toolDispatcher.quiesce?.(reason))
    ]).then((results) => {
      const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (rejected) throw rejected.reason;
    });
    return this.handoffPromise;
  }
}

function safeErrorName(error: unknown): string {
  const name = error instanceof Error ? error.name : 'Error';
  return /^[A-Za-z][A-Za-z0-9_.-]{0,80}$/.test(name) ? name : 'Error';
}
