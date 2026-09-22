import type {
  ChatModelOverrideRecord,
  CompressionCommandTarget,
  MessageContent,
  MessageRetryTarget
} from '../../../shared/protocol';
import {
  ReliableKernelApplication
} from '../../reliableKernel/runtimeApplication';
import { listAllDomainRows } from '../../reliableKernel/repositoryPagination';
import type {
  TurnCommandResult,
  TurnContinuationCommand,
  TurnEditAndRunCommand,
  TurnGuidanceCancelCommand,
  TurnGuidanceEditCommand,
  TurnGuidanceHoldCommand,
  TurnGuidanceReorderCommand,
  TurnInputCommand,
  TurnRetryCommand,
  TurnRuntimeContinuationCommand,
  ExecutionLeaseRenewalResult
} from '../../reliableKernel/turnControlPlane';
import {
  ExecutionHandoffError,
  isExecutionHandoffError,
  runWithExecutionLeaseFence,
  type ExecutionLeaseFence
} from '../../reliableKernel/executionLeaseFence';
import {
  isConversationRuntimeOwnerBusyError,
  type ConversationRuntimeOwnerManager
} from '../../reliableKernel/ConversationRuntimeOwnerManager';
import { DOMAIN_REPOSITORIES } from '../../reliableKernel/repositories';
import type { CoordinateCompressionResult } from '../../reliableKernel/contextCompressionCoordinator';
import type { ContentObjectMetadata } from '../../reliableKernel/contentAddressedStore';
import type { ReliableDiagnosticObserver } from '../../reliableKernel/diagnosticJournal';

const DEFAULT_LEASE_DURATION_MS = 30_000;
const EXTERNAL_WAKE_POLL_MS = 500;
const TERMINATION_RECOVERY_BASE_DELAY_MS = 250;
const TERMINATION_RECOVERY_MAX_DELAY_MS = 10_000;
const LOCAL_TURN_WAKE_DOMAINS = new Set([
  'EffectIntent',
  'EffectReceipt',
  'Operation',
  'ToolResultArtifact',
  'ToolOutcome',
  'ToolModelResult',
  'InteractionResponse',
  'FileChangeDecision',
  'ProcessReceipt',
  'PendingTurnInput',
  'RuntimeDelivery'
]);

interface DriveSlot {
  conversationId: string;
  turnId: string;
  requestedGeneration: bigint;
  completedGeneration: bigint;
  terminal: boolean;
  waitingExternalDataVersion?: string;
  waitingWakeFingerprint?: string;
  maintenanceResult?: CoordinateCompressionResult;
  error?: unknown;
  task: Promise<void>;
}

type ManualCompressionMaintenance = (
  | {
      kind: 'manual_context_compression';
      version: 1;
      compressSegmentCount: number;
      commandSourceKey: string;
    }
  | {
      kind: 'manual_context_compression';
      version: 2;
      compressSegmentCount: number;
      target: CompressionCommandTarget;
      commandSourceKey: string;
    }) & { sourceReplay?: 'immutable_provenance' };

interface FrozenManualCompressionDrive {
  descriptor: ManualCompressionMaintenance;
  settingsSnapshotContentObjectId?: string;
  authoritySnapshotId: string;
  headRootId: string;
  compressSegmentCount: number;
}

interface AdmissionSlot {
  conversationId: string;
  requestedGeneration: bigint;
  completedGeneration: bigint;
  task: Promise<void>;
}

interface WaitingOwnedTurn {
  conversationId: string;
  turnId: string;
  externalDataVersion: string;
  wakeFingerprint: string;
}

interface DeferredRecoveryTurn {
  conversationId: string;
  turnId: string;
  nextAttemptAt?: number;
  failureCount?: number;
}

export interface ReliableConversationRunnerRecoveryReport {
  activeTurnsScanned: number;
  resumedTurnIds: string[];
  finalizedTurnIds: string[];
  needsHumanTurnIds: string[];
  liveOwnedTurnIds: string[];
  queuedConversationIds: string[];
}

export interface ReliableManualCompressionResult {
  turnId: string;
  deduplicated: boolean;
  inProgress?: boolean;
  terminal?: {
    status: 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'outcome_unknown';
    reason: string;
  };
  compression?: CoordinateCompressionResult;
}

export interface ReliableManualCompressionDriveResult {
  terminalStatus: 'completed' | 'interrupted';
  compression?: CoordinateCompressionResult;
}

export type ReliableConversationRunnerErrorHandler = (
  error: unknown,
  context: {
    operation: 'drive' | 'admit-next' | 'watch-external' | 'watch-recovery';
    conversationId: string;
    turnId?: string;
  }
) => void;

/**
 * Product-side admission/drive coordinator. Durable ordering remains TurnIntent + ExecutionLease in
 * SQLite; this class only wakes the relevant Agent loop and drains the next frozen queued Intent.
 */
export class ReliableConversationRunner {
  private readonly active = new Map<string, DriveSlot>();
  private readonly admissions = new Map<string, AdmissionSlot>();
  private readonly waitingOwned = new Map<string, WaitingOwnedTurn>();
  private readonly deferredRecovery = new Map<string, DeferredRecoveryTurn>();
  private readonly terminationRecoveryFailures = new Map<string, number>();
  private readonly interruptCancellationSignaled = new Set<string>();
  private externalWakeTimer: NodeJS.Timeout | undefined;
  private externalWakePollInFlight = false;
  private externalWakeTask: Promise<void> | undefined;
  private localWakeRequested = false;
  private readonly unsubscribeCommit: () => void;
  private disposed = false;

  public constructor(
    private readonly application: ReliableKernelApplication,
    private readonly leaseOwnerId: string,
    private readonly onError: ReliableConversationRunnerErrorHandler = defaultErrorHandler,
    private readonly leaseDurationMs = DEFAULT_LEASE_DURATION_MS,
    private readonly diagnostics?: ReliableDiagnosticObserver
  ) {
    this.unsubscribeCommit = application.database.onCommit((commit) => {
      if (!commit.changes.some((change) => LOCAL_TURN_WAKE_DOMAINS.has(change.domain))) return;
      this.localWakeRequested = true;
      this.ensureExternalWakePolling();
    });
  }

  public async input(input: {
    commandId: string;
    conversationId: string;
    text?: string;
    content?: MessageContent;
    agentId?: string;
    model?: ChatModelOverrideRecord;
  }): Promise<TurnCommandResult> {
    this.requireOpen();
    return this.conversationOwners.run(input.conversationId, async () => {
      const content = serializeUserContent(input.text, input.content);
      const command: TurnInputCommand = {
        source: { kind: 'command', key: input.commandId },
        ...this.lease(input.conversationId),
        ...(input.agentId?.trim() ? { executorAgentId: input.agentId.trim() } : {}),
        ...(input.model ? { modelOverride: input.model } : {}),
        content: content.value,
        contentType: content.contentType
      };
      const result = await this.application.turns.input(command);
      this.wake(result);
      return result;
    });
  }

  public async editGuidance(input: {
    commandId: string;
    conversationId: string;
    intentId: string;
    expectedRevisionSeq: string;
    text: string;
  }): Promise<TurnCommandResult> {
    this.requireOpen();
    return this.conversationOwners.run(input.conversationId, async () => {
      const command: TurnGuidanceEditCommand = {
        source: { kind: 'command', key: input.commandId },
        conversationId: input.conversationId,
        intentId: input.intentId,
        expectedRevisionSeq: input.expectedRevisionSeq,
        text: input.text
      };
      const result = await this.application.turns.editGuidance(command);
      this.wake(result);
      return result;
    });
  }

  public async cancelGuidance(input: {
    commandId: string;
    conversationId: string;
    intentId: string;
    expectedRevisionSeq: string;
  }): Promise<TurnCommandResult> {
    this.requireOpen();
    return this.conversationOwners.run(input.conversationId, async () => {
      const command: TurnGuidanceCancelCommand = {
        source: { kind: 'command', key: input.commandId },
        conversationId: input.conversationId,
        intentId: input.intentId,
        expectedRevisionSeq: input.expectedRevisionSeq
      };
      const result = await this.application.turns.cancelGuidance(command);
      this.wake(result);
      return result;
    });
  }

  public async setGuidanceHold(input: {
    commandId: string;
    conversationId: string;
    intentId: string;
    expectedRevisionSeq: string;
    hold: 'none' | 'paused';
  }): Promise<TurnCommandResult> {
    this.requireOpen();
    return this.conversationOwners.run(input.conversationId, async () => {
      const command: TurnGuidanceHoldCommand = {
        source: { kind: 'command', key: input.commandId },
        conversationId: input.conversationId,
        intentId: input.intentId,
        expectedRevisionSeq: input.expectedRevisionSeq,
        hold: input.hold
      };
      const result = await this.application.turns.setGuidanceHold(command);
      this.wake(result);
      return result;
    });
  }

  public async reorderGuidance(input: {
    commandId: string;
    conversationId: string;
    items: Array<{ intentId: string; expectedRevisionSeq: string }>;
  }): Promise<TurnCommandResult> {
    this.requireOpen();
    return this.conversationOwners.run(input.conversationId, async () => {
      const command: TurnGuidanceReorderCommand = {
        source: { kind: 'command', key: input.commandId },
        conversationId: input.conversationId,
        items: input.items
      };
      const result = await this.application.turns.reorderGuidance(command);
      this.wake(result);
      return result;
    });
  }

  public async retry(input: {
    commandId: string;
    conversationId: string;
    sourceTurnId: string;
    target: MessageRetryTarget;
    expectedMessageRevisionId?: string;
    agentId?: string;
    model?: ChatModelOverrideRecord;
  }): Promise<TurnCommandResult> {
    this.requireOpen();
    return this.conversationOwners.run(input.conversationId, async () => {
      const command: TurnRetryCommand = {
        source: { kind: 'command', key: input.commandId },
        ...this.lease(input.conversationId),
        ...(input.agentId?.trim() ? { executorAgentId: input.agentId.trim() } : {}),
        ...(input.model ? { modelOverride: input.model } : {}),
        sourceTurnId: input.sourceTurnId,
        target: input.target,
        ...(input.expectedMessageRevisionId
          ? { expectedMessageRevisionId: input.expectedMessageRevisionId }
          : {})
      };
      const result = await this.application.turns.retry(command);
      this.wake(result);
      return result;
    });
  }

  public async editAndRun(input: {
    commandId: string;
    conversationId: string;
    messageId: string;
    expectedRevisionId: string;
    text?: string;
    content?: MessageContent;
    deleteFollowing?: boolean;
    agentId?: string;
    model?: ChatModelOverrideRecord;
  }): Promise<TurnCommandResult> {
    this.requireOpen();
    return this.conversationOwners.run(input.conversationId, async () => {
      const content = serializeUserContent(input.text, input.content);
      const command: TurnEditAndRunCommand = {
        source: { kind: 'command', key: input.commandId },
        ...this.lease(input.conversationId),
        messageId: input.messageId,
        expectedRevisionId: input.expectedRevisionId,
        content: content.value,
        contentType: content.contentType,
        ...(input.deleteFollowing ? { deleteFollowing: true } : {}),
        ...(input.agentId?.trim() ? { executorAgentId: input.agentId.trim() } : {}),
        ...(input.model ? { modelOverride: input.model } : {})
      };
      const result = await this.application.turns.editAndRun(command);
      this.wake(result);
      return result;
    });
  }

  public async continuation(input: {
    commandId: string;
    conversationId: string;
    sourceTurnId: string;
    text?: string;
    content?: MessageContent;
  }): Promise<TurnCommandResult> {
    this.requireOpen();
    return this.conversationOwners.run(input.conversationId, async () => {
      const content = serializeUserContent(input.text, input.content);
      const command: TurnContinuationCommand = {
        source: { kind: 'command', key: input.commandId },
        ...this.lease(input.conversationId),
        sourceTurnId: input.sourceTurnId,
        content: content.value,
        contentType: content.contentType
      };
      const result = await this.application.turns.continuation(command);
      this.wake(result);
      return result;
    });
  }

  /** Durable internal continuation: no visible synthetic user message and frozen source authority. */
  public async runtimeContinuation(input: {
    commandId: string;
    deliveryId: string;
    conversationId: string;
    sourceTurnId: string;
  }): Promise<TurnCommandResult> {
    this.requireOpen();
    return this.conversationOwners.run(input.conversationId, async () => {
      const command: TurnRuntimeContinuationCommand = {
        source: { kind: 'internal', key: input.commandId },
        ...this.lease(input.conversationId),
        sourceTurnId: input.sourceTurnId,
        deliveryId: input.deliveryId
      };
      const result = await this.application.turns.runtimeContinuation(command);
      this.wake(result);
      return result;
    });
  }

  /**
   * Runs an explicit compression command inside a no-visible-message maintenance Turn. The Turn
   * supplies the same ExecutionLease/Authority/ModelRequest fences as normal Agent work, while the
   * completed maintenance Turn remains absent from the chat transcript.
   */
  public async manualCompression(input: {
    commandId: string;
    conversationId: string;
    compressSegmentCount: number;
    target?: CompressionCommandTarget;
    sourceReplay?: 'immutable_provenance';
  }): Promise<ReliableManualCompressionResult> {
    this.requireOpen();
    return this.conversationOwners.run(input.conversationId, async () => {
      const replay = await this.inspectManualCompression({
        commandId: input.commandId,
        conversationId: input.conversationId,
        target: input.target,
        sourceReplay: input.sourceReplay
      });
      if (replay) return replay;
      const started = await this.admitManualCompression(input);
      const turnId = requireId(started.turnId, 'Manual compression Turn.id');
      if (started.admitted !== true) {
        throw new Error('手动压缩维护 Turn 未取得当前对话执行租约。');
      }
      // Use the same registered DriveSlot as ordinary Turns. This makes remote durable interrupts,
      // lease renewal/handoff and waitForIdle observe maintenance work; scheduleDrive classifies the
      // Turn from its immutable TurnIntent payload before choosing a driver.
      const slot = this.scheduleDrive(input.conversationId, turnId);
      if (!slot) throw new Error('手动压缩维护 Turn 未能进入可靠调度。');
      await slot.task;
      if (slot.error) throw slot.error;
      return {
        turnId,
        deduplicated: started.deduplicated,
        ...(slot.maintenanceResult ? { compression: slot.maintenanceResult } : {})
      };
    });
  }

  /**
   * Admits the immutable maintenance Turn for either the ordinary conversation scheduler or the
   * scheduler that owns a ChildExecution. Driving is deliberately separate: scheduler membership
   * and the ExecutionLease owner must remain the same across live work and startup recovery.
   */
  public async admitManualCompression(input: {
    commandId: string;
    conversationId: string;
    compressSegmentCount: number;
    target?: CompressionCommandTarget;
    sourceReplay?: 'immutable_provenance';
    childExecution?: {
      childExecutionId: string;
      leaseOwnerId: string;
    };
  }): Promise<TurnCommandResult> {
    this.requireOpen();
    const sourceReplay = parseManualCompressionSourceReplay(input.sourceReplay, input.target);
    return this.conversationOwners.run(input.conversationId, async () => {
      if (sourceReplay) {
        const heads = await listAllDomainRows(this.application.database, 'ConversationContextHeadLink', {
          conversation_id: input.conversationId
        });
        if (heads.length !== 1 || input.target?.kind !== 'current_head'
          || heads[0].root_id !== input.target.expectedRootId) {
          throw new Error('重建摘要的当前上下文已变化，请重新确认。');
        }
        const structure = await this.application.context.materializeStructure(input.target.expectedRootId);
        if (structure.records.length === 0 || structure.records.length !== input.compressSegmentCount) {
          throw new Error('从原始记录重建摘要必须包含当前完整上下文。');
        }
      }
      const commandSourceKey = `manual-compression:${input.commandId}:turn`;
      const sourceTurnId = await this.manualCompressionSourceTurn(
        input.conversationId,
        input.childExecution?.childExecutionId
      );
      const execution = input.childExecution
        ? {
            conversationId: input.conversationId,
            leaseOwnerId: requireId(input.childExecution.leaseOwnerId, 'Child scheduler lease owner'),
            hostBootId: this.application.database.hostBootId,
            leaseExpiresAt: new Date(Date.now() + this.leaseDurationMs).toISOString(),
            membership: {
              kind: 'child_execution' as const,
              childExecutionId: requireId(
                input.childExecution.childExecutionId,
                'Manual compression ChildExecution.id'
              )
            }
          }
        : this.lease(input.conversationId);
      return this.application.turns.runtimeContinuation({
        source: { kind: 'internal', key: commandSourceKey },
        ...execution,
        sourceTurnId,
        // Calls which predate target freezing retain the exact v1 descriptor. Every UI command now
        // supplies a frozen target and therefore emits v2; recovery must continue to understand
        // already-persisted v1 Turns without rewriting their identity or payload shape.
        maintenance: input.target
          ? {
              kind: 'manual_context_compression',
              version: 2,
              compressSegmentCount: input.compressSegmentCount,
              target: input.target,
              ...(sourceReplay ? { sourceReplay } : {}),
              commandSourceKey
            }
          : {
              kind: 'manual_context_compression',
              version: 1,
              compressSegmentCount: input.compressSegmentCount,
              commandSourceKey
            }
      });
    });
  }

  /** Runs a maintenance descriptor under the caller's already-established execution fence. */
  public async driveManualCompressionIfPresent(input: {
    conversationId: string;
    turnId: string;
  }): Promise<ReliableManualCompressionDriveResult | null> {
    this.requireOpen();
    const slot = {
      conversationId: requireId(input.conversationId, 'Manual compression Conversation.id'),
      turnId: requireId(input.turnId, 'Manual compression Turn.id')
    };
    // The caller holds the execution fence; it must also hold this Conversation's runtime
    // ownership. Driving peer-owned work is never allowed, even through an established fence.
    await this.conversationOwners.assertOwned(slot.conversationId);
    const frozen = await this.readManualCompressionDrive(slot);
    return frozen ? this.driveManualCompression(slot, frozen) : null;
  }

  private async manualCompressionSourceTurn(
    conversationId: string,
    childExecutionId?: string
  ): Promise<string> {
    if (childExecutionId) {
      const links = (await listAllDomainRows(this.application.database, 'ChildExecutionTurnLink', {
        child_execution_id: childExecutionId
      })).sort((left, right) => compareBigInt(right.turn_seq, left.turn_seq));
      const latest = links[0];
      if (!latest) throw new Error('ChildExecution 没有可供手动压缩继承的 Turn 谱系。');
      const sourceTurnId = requireId(latest.turn_id, 'Manual compression child source Turn.id');
      const sourceTurns = await listAllDomainRows(this.application.database, 'Turn', { id: sourceTurnId });
      if (sourceTurns.length !== 1 || sourceTurns[0].conversation_id !== conversationId) {
        throw new Error('ChildExecution 最新 Turn 不属于当前 Conversation。');
      }
      const [authority, executor] = await Promise.all([
        listAllDomainRows(this.application.database, 'AuthoritySnapshot', { turn_id: sourceTurnId }),
        listAllDomainRows(this.application.database, 'TurnExecutorLink', { turn_id: sourceTurnId })
      ]);
      if (authority.length !== 1 || executor.length !== 1) {
        throw new Error('ChildExecution 最新 Turn 缺少可继承的冻结模型配置。');
      }
      return sourceTurnId;
    }
    const candidates = (await listAllDomainRows(this.application.database, 'Turn', {
      conversation_id: conversationId,
      status: 'terminated'
    }))
      .filter((turn) => turn.conversation_id === conversationId && turn.status === 'terminated')
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at))
        || String(right.id).localeCompare(String(left.id)));
    for (const candidate of candidates) {
      const candidateId = requireId(candidate.id, 'Manual compression source Turn.id');
      const [authority, executor] = await Promise.all([
        listAllDomainRows(this.application.database, 'AuthoritySnapshot', { turn_id: candidateId }),
        listAllDomainRows(this.application.database, 'TurnExecutorLink', { turn_id: candidateId })
      ]);
      if (authority.length === 1 && executor.length === 1) {
        return candidateId;
      }
    }
    throw new Error('当前对话没有可供手动压缩继承的冻结模型配置。');
  }

  /** Reads an already-admitted exact maintenance command without consulting the mutable Context head. */
  public async inspectManualCompression(input: {
    commandId: string;
    conversationId: string;
    target?: CompressionCommandTarget;
    sourceReplay?: 'immutable_provenance';
  }): Promise<ReliableManualCompressionResult | null> {
    this.requireOpen();
    const sourceReplay = parseManualCompressionSourceReplay(input.sourceReplay, input.target);
    const commandSourceKey = `manual-compression:${input.commandId}:turn`;
    const existingReceipts = await listAllDomainRows(this.application.database, 'CommandReceipt', {
      source_kind: 'internal',
      source_key: commandSourceKey
    });
    if (existingReceipts.length > 1) throw new Error('手动压缩命令身份不唯一。');
    if (existingReceipts.length === 0) return null;
    const existingTurnId = await this.findManualCompressionTurn(commandSourceKey, input.conversationId);
    if (!existingTurnId) throw new Error('手动压缩命令回执缺少对应的维护 Turn。');
    const descriptor = await this.readRuntimeMaintenanceDescriptor({
      conversationId: input.conversationId,
      turnId: existingTurnId
    });
    if (
      !descriptor
      || descriptor.sourceReplay !== sourceReplay
      || (descriptor.version === 1 && input.target !== undefined)
      || (descriptor.version === 2 && (!input.target || !sameCompressionTarget(descriptor.target, input.target)))
    ) {
      throw new Error('相同的手动压缩命令被用于不同的冻结目标或原始记录重建方式。');
    }
    const existing = (await listAllDomainRows(this.application.database, 'Turn', { id: existingTurnId }))[0];
    if (!existing || existing.conversation_id !== input.conversationId) {
      throw new Error('手动压缩命令回放指向另一 Conversation。');
    }
    if (existing.status !== 'terminated') {
      return { turnId: existingTurnId, deduplicated: true, inProgress: true };
    }
    const terminations = await listAllDomainRows(this.application.database, 'TurnTermination', {
      turn_id: existingTurnId
    });
    if (terminations.length !== 1) {
      throw new Error('已终止的手动压缩 Turn 缺少唯一终态事实。');
    }
    const terminal = {
      status: parseTurnTerminalStatus(terminations[0].terminal_status),
      reason: requireId(terminations[0].reason, 'Manual compression TurnTermination.reason')
    };
    return terminal.status === 'completed' && terminal.reason === 'manual_context_compression_completed'
      ? { turnId: existingTurnId, deduplicated: true }
      : { turnId: existingTurnId, deduplicated: true, terminal };
  }

  public resume(conversationId: string, turnId: string): void {
    if (this.disposed) return;
    this.scheduleDrive(conversationId, turnId);
  }

  /**
   * Startup entrypoint, to be called after ReliableKernelApplication.recover(). It reclaims every
   * resumable active Turn according to identity.json, finalizes orphan Turns, and level-triggers
   * ordinary queued admission. Scheduling is idempotent; use waitForIdle() only when shutdown/tests
   * need to drain the resulting work.
   *
   * Every recovered Conversation is first claimed through the runtime owner manager. A
   * Conversation owned by a live/unknown peer Host is skipped (reported as live-owned) without
   * poisoning unrelated recovery; resume candidates stay level-triggered via deferredRecovery so
   * a later peer release/shutdown still reclaims execution in this Host.
   *
   * Passing conversationId scopes every repository scan and ownership claim to that one
   * Conversation: a view taking over a crashed peer's Conversation recovers it inside this
   * already-running Host without a reboot or a global sweep.
   */
  public async recoverStartup(
    signal?: AbortSignal,
    conversationId?: string
  ): Promise<ReliableConversationRunnerRecoveryReport> {
    this.requireOpen();
    signal?.throwIfAborted();
    const scopedConversationId = conversationId === undefined
      ? undefined
      : requireId(conversationId, 'Recovery Conversation.id');
    const childTurnIds = new Set(
      (await listAllDomainRows(this.application.database, 'ChildExecutionActiveTurnLink'))
        .map((link) => requireId(link.turn_id, 'ChildExecutionActiveTurnLink.turn_id'))
    );
    // The mutable active pointer is committed atomically with every child Turn admission. Reading
    // it avoids scanning immutable historical membership while still preventing this runner from
    // replacing the child coordinator's lease generation.
    const activeTurns = (await listAllDomainRows(this.application.database, 'Turn', {
      status: 'active',
      ...(scopedConversationId ? { conversation_id: scopedConversationId } : {})
    }))
      .filter((turn) => !childTurnIds.has(requireId(turn.id, 'Turn.id')))
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at))
        || String(left.id).localeCompare(String(right.id)));
    const report: ReliableConversationRunnerRecoveryReport = {
      activeTurnsScanned: activeTurns.length,
      resumedTurnIds: [],
      finalizedTurnIds: [],
      needsHumanTurnIds: [],
      liveOwnedTurnIds: [],
      queuedConversationIds: []
    };
    const admissionBlockedConversationIds = new Set<string>();
    const ownership = new Map<string, boolean>();
    for (const turn of activeTurns) {
      signal?.throwIfAborted();
      const turnId = requireId(turn.id, 'Turn.id');
      const turnConversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
      const facts = await this.application.turns.recoveryFacts(turnId);
      if (facts.judgment === 'needs_human') {
        report.needsHumanTurnIds.push(turnId);
        admissionBlockedConversationIds.add(turnConversationId);
        continue;
      }
      if (!await this.tryOwnConversation(turnConversationId, ownership)) {
        // A live peer Host owns this Conversation. Skipping it must not poison unrelated
        // recovery; the resume candidate stays level-triggered for a later release/shutdown.
        report.liveOwnedTurnIds.push(turnId);
        admissionBlockedConversationIds.add(turnConversationId);
        if (facts.judgment === 'resume') {
          this.deferredRecovery.set(turnId, { conversationId: turnConversationId, turnId });
          this.ensureExternalWakePolling();
        }
        continue;
      }
      if (facts.judgment === 'finalize') {
        await this.application.turns.finalizeRecovery({
          source: { kind: 'recovery', key: `runner-finalize-orphan:${turnId}` },
          turnId,
          terminalStatus: 'cancelled',
          reason: 'Startup recovery finalized an active Turn with no execution ownership or pending input.'
        });
        report.finalizedTurnIds.push(turnId);
        continue;
      }
      const claimed = await this.application.turns.claimRecoveryExecution({
        turnId,
        ...this.lease(turnConversationId)
      });
      if (!claimed) {
        // A live owner or another recovery contender won the exact-row CAS. Both are safe,
        // non-error startup outcomes; this Host must not schedule the Turn.
        report.liveOwnedTurnIds.push(turnId);
        admissionBlockedConversationIds.add(turnConversationId);
        this.deferredRecovery.set(turnId, { conversationId: turnConversationId, turnId });
        this.ensureExternalWakePolling();
        continue;
      }
      report.resumedTurnIds.push(turnId);
      admissionBlockedConversationIds.add(turnConversationId);
      this.scheduleDrive(turnConversationId, turnId);
    }

    const [queued, childIntentLinks] = await Promise.all([
      listAllDomainRows(this.application.database, 'TurnIntent', {
        state: 'queued',
        turn_id: null,
        ...(scopedConversationId ? { conversation_id: scopedConversationId } : {})
      }),
      listAllDomainRows(this.application.database, 'ChildExecutionIntentLink', { state: 'pending' })
    ]);
    const childIntentIds = new Set(childIntentLinks.map((link) => String(link.turn_intent_id)));
    const queuedConversationIds = [...new Set(queued
      .filter((intent) => !childIntentIds.has(String(intent.id)))
      .filter((intent) => !admissionBlockedConversationIds.has(String(intent.conversation_id)))
      .map((intent) => requireId(intent.conversation_id, 'TurnIntent.conversation_id'))
    )].sort();
    for (const queuedConversationId of queuedConversationIds) {
      signal?.throwIfAborted();
      // Queued admission drains only under this Host's Conversation ownership; a live peer owner
      // drains its own queue and is skipped here.
      if (!await this.tryOwnConversation(queuedConversationId, ownership)) continue;
      report.queuedConversationIds.push(queuedConversationId);
      this.scheduleAdmission(queuedConversationId);
    }
    return report;
  }

  public async interrupt(input: {
    commandId: string;
    conversationId: string;
    turnId: string;
    expectedLeaseGeneration?: string;
    reason: string;
  }): Promise<TurnCommandResult> {
    this.requireOpen();
    return this.conversationOwners.run(input.conversationId, async () => {
      const result = await this.application.turns.interrupt({
        source: { kind: 'command', key: input.commandId },
        turnId: input.turnId,
        ...(input.expectedLeaseGeneration
          ? { expectedLeaseGeneration: input.expectedLeaseGeneration }
          : {}),
        reason: input.reason
      });
      this.scheduleDrive(input.conversationId, input.turnId);
      void this.cancelLocalExecution(input.conversationId, input.turnId, input.reason).catch((error) => {
        this.onError(error, {
          operation: 'drive',
          conversationId: input.conversationId,
          turnId: input.turnId
        });
      });
      return result;
    });
  }

  public async waitForIdle(): Promise<void> {
    for (;;) {
      const tasks = [
        ...[...this.active.values()].map((slot) => slot.task),
        ...[...this.admissions.values()].map((slot) => slot.task),
        ...(this.disposed && this.externalWakeTask ? [this.externalWakeTask] : [])
      ];
      if (tasks.length === 0) return;
      await Promise.allSettled(tasks);
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.unsubscribeCommit();
    if (this.externalWakeTimer) clearTimeout(this.externalWakeTimer);
    this.externalWakeTimer = undefined;
    this.waitingOwned.clear();
    this.deferredRecovery.clear();
    this.terminationRecoveryFailures.clear();
    this.interruptCancellationSignaled.clear();
  }

  private wake(result: TurnCommandResult): void {
    if (result.admitted && result.turnId && result.conversationId) {
      this.scheduleDrive(result.conversationId, result.turnId);
      return;
    }
    if (result.conversationId) this.scheduleAdmission(result.conversationId);
  }

  private scheduleDrive(conversationId: string, turnId: string): DriveSlot | undefined {
    if (this.disposed) return undefined;
    this.waitingOwned.delete(turnId);
    const existing = this.active.get(turnId);
    if (existing) {
      if (existing.terminal) return existing;
      existing.requestedGeneration += 1n;
      return existing;
    }
    const slot: DriveSlot = {
      conversationId,
      turnId,
      requestedGeneration: 1n,
      completedGeneration: 0n,
      terminal: false,
      task: Promise.resolve()
    };
    const task = this.runOwnedDriveSlot(slot)
      .catch(async (error) => {
        slot.error = error;
        let terminationPending = false;
        try {
          terminationPending = Boolean(await this.findPendingTermination(turnId));
        } catch (inspectionError) {
          this.onError(inspectionError, { operation: 'watch-recovery', conversationId, turnId });
        }
        if (terminationPending && !this.disposed) {
          this.deferFailedTerminationRecovery(slot, error);
        }
        this.onError(error, { operation: 'drive', conversationId, turnId });
      })
      .finally(() => this.finishDriveSlot(slot));
    slot.task = task;
    this.active.set(turnId, slot);
    this.ensureExternalWakePolling();
    return slot;
  }

  /**
   * Every asynchronous drive pins its Conversation runtime ownership for the entire slot
   * lifetime, so an idle ownership release can never race a scheduled drive. A Conversation
   * owned by a live peer Host is a quiet stand-down, not an error: the level-triggered deferred
   * candidate reclaims execution here once the peer releases ownership or shuts down.
   */
  private async runOwnedDriveSlot(slot: DriveSlot): Promise<void> {
    try {
      await this.conversationOwners.run(slot.conversationId, () => this.runDriveSlot(slot));
    } catch (error) {
      if (isConversationRuntimeOwnerBusyError(error)) {
        slot.terminal = true;
        slot.completedGeneration = slot.requestedGeneration;
        this.deferExecutionRecovery(slot);
        return;
      }
      throw error;
    }
  }

  private async runDriveSlot(slot: DriveSlot): Promise<void> {
    for (;;) {
      if (this.disposed) return;
      // Driving/dispatching requires this Host to own the Conversation runtime. The enclosing
      // ownership pin makes this a cheap invariant assertion rather than an acquisition.
      await this.conversationOwners.assertOwned(slot.conversationId);
      const generation = slot.requestedGeneration;
      try {
        let fence = await this.application.turns.executionLeaseFence({
          turnId: slot.turnId,
          leaseOwnerId: this.leaseOwnerId,
          hostBootId: this.application.database.hostBootId
        });
        if (!fence) {
          fence = await this.recoverMissingExecutionFence(slot);
          if (!fence) {
            // A resolver Host may observe the wake while another live Host still owns the Turn.
            // The deferred level-trigger keeps the fact alive through owner shutdown/expiry; it
            // never adopts the other Host's generation.
            slot.terminal = true;
            slot.completedGeneration = slot.requestedGeneration;
            return;
          }
        }
        this.deferredRecovery.delete(slot.turnId);
        const preflightRenewal = await this.renewExecutionLease(slot, fence, 'before_drive');
        if (!preflightRenewal.renewed) {
          // A waiting Turn can resume while its old lease still passes the fence read but has less
          // lifetime than the first interval tick. Never start Provider/tool work on that stale
          // authority: retain a level-triggered recovery fact and let the exact-row claim advance
          // generation before re-drive.
          this.deferExecutionRecovery(slot);
          slot.error = new ExecutionHandoffError(
            `ExecutionLease preflight renewal lost for Turn ${slot.turnId}: ${preflightRenewal.reason}.`
          );
          slot.terminal = true;
          slot.completedGeneration = slot.requestedGeneration;
          return;
        }
        const renewal = this.startLeaseRenewal(slot, fence);
        let result: { terminalStatus: string; waitingToolCallId?: string };
        try {
          result = await runWithExecutionLeaseFence(fence, async () => {
            const maintenance = await this.readManualCompressionDrive(slot);
            if (!maintenance) return this.application.agentLoop.drive(slot.turnId);
            const driven = await this.driveManualCompression(slot, maintenance);
            if (driven.compression) slot.maintenanceResult = driven.compression;
            return { terminalStatus: driven.terminalStatus };
          });
        } finally {
          await renewal.stop();
        }
        slot.completedGeneration = generation;
        if (this.disposed) return;
        if (result.terminalStatus === 'waiting') {
          this.terminationRecoveryFailures.delete(slot.turnId);
          if (slot.requestedGeneration > generation) continue;
          if (!await this.ownsExecution(slot.turnId)) {
            // The Turn is still durably active, but this process no longer owns its generation.
            // Keep a level-triggered recovery candidate instead of silently abandoning it.
            this.deferredRecovery.set(slot.turnId, {
              conversationId: slot.conversationId,
              turnId: slot.turnId
            });
            this.ensureExternalWakePolling();
            slot.terminal = true;
            slot.completedGeneration = slot.requestedGeneration;
            return;
          }
          const observation = await this.observeWaitingWake(slot.turnId, result.waitingToolCallId);
          if (observation.ready) {
            // The answer/interrupt raced the Agent loop's final waiting read. Re-drive immediately;
            // the Turn-scoped observation below proves this is a target-Turn fact, not global noise.
            slot.requestedGeneration += 1n;
            continue;
          }
          slot.waitingExternalDataVersion = observation.externalDataVersion;
          slot.waitingWakeFingerprint = observation.fingerprint;
          return;
        }
        // Terminal commits release ExecutionLease. Queue admission is a separate level-triggered
        // slot so a queued command racing this release cannot be lost between a one-shot scan and
        // an old Promise.finally callback.
        slot.terminal = true;
        slot.completedGeneration = slot.requestedGeneration;
        this.terminationRecoveryFailures.delete(slot.turnId);
        this.scheduleAdmission(slot.conversationId);
        return;
      } catch (error) {
        slot.completedGeneration = generation;
        if (isExecutionHandoffError(error)) {
          // A local handoff is not a durable terminal fact. Unless this Host itself is shutting
          // down, preserve a level-triggered recovery candidate so an expired/replaced generation
          // cannot orphan an active Turn and streaming ModelRequest until the next user command.
          if (!this.disposed) this.deferExecutionRecovery(slot);
          slot.error = error;
          slot.terminal = true;
          return;
        }
        throw error;
      }
    }
  }

  /**
   * Classifies a no-message maintenance Turn from its immutable TurnIntentRevision payload. Once
   * a compression ModelRequest exists, its immutable recipe becomes the replay authority for the
   * exact source root/count. This deliberately runs before AgentLoop selection on every wake.
   */
  private async readManualCompressionDrive(
    slot: Pick<DriveSlot, 'conversationId' | 'turnId'>
  ): Promise<FrozenManualCompressionDrive | null> {
    const descriptor = await this.readRuntimeMaintenanceDescriptor(slot);
    if (!descriptor) return null;

    const authorities = await listAllDomainRows(this.application.database, 'AuthoritySnapshot', {
      turn_id: slot.turnId
    });
    if (authorities.length !== 1) {
      throw new Error(`Manual compression Turn ${slot.turnId} lacks one frozen AuthoritySnapshot.`);
    }
    const authoritySnapshotId = requireId(authorities[0].id, 'Manual compression AuthoritySnapshot.id');
    const requests = (await listAllDomainRows(this.application.database, 'ModelRequest', {
      turn_id: slot.turnId
    })).sort((left, right) => compareBigInt(left.request_seq, right.request_seq));
    if (requests.length > 6) throw new Error('Manual compression exceeded its bounded method chain.');
    if (requests.length > 0) {
      let headRootId: string | undefined;
      const settingsSnapshotContentObjectId = requireId(
        requests[0].settings_snapshot_object_id, 'Manual compression frozen request settings'
      );
      for (const [index, request] of requests.entries()) {
        if (request.authority_snapshot_id !== authoritySnapshotId
          || request.settings_snapshot_object_id !== settingsSnapshotContentObjectId) {
          throw new Error('Manual compression methods do not share the same frozen authority/settings.');
        }
        if (index < requests.length - 1 && request.status !== 'terminal') {
          throw new Error('Manual compression started a fallback before its predecessor terminated.');
        }
        const recipe = await this.readJsonContentObject(
          requireId(request.recipe_object_id, 'Manual compression ModelRequest.recipe_object_id'),
          `Manual compression ModelRequest ${String(request.id)} recipe`
        );
        if (!recipe || recipe.kind !== 'reliable-context-compression'
          || recipe.trigger !== 'manual' || recipe.requestKind !== 'context_compression_manual') {
          throw new Error(`Maintenance Turn ${slot.turnId} contains a non-manual-compression ModelRequest.`);
        }
        if (recipe.sourceReplay !== descriptor.sourceReplay) {
          throw new Error('Manual compression replay changed its immutable source replay selection.');
        }
        const sourceRootId = requireId(recipe.sourceRootId, 'Manual compression source root');
        const sourceCount = requireSafePositiveInteger(recipe.sourceSegmentCount, 'Manual compression prefix');
        if ((headRootId && headRootId !== sourceRootId) || sourceCount > descriptor.compressSegmentCount) {
          throw new Error('Manual compression fallback changed its frozen source or widened the selected prefix.');
        }
        if (descriptor.sourceReplay && (sourceCount !== descriptor.compressSegmentCount
          || descriptor.version !== 2 || descriptor.target.kind !== 'current_head'
          || sourceRootId !== descriptor.target.expectedRootId)) {
          throw new Error('Immutable source rebuild replay changed its complete frozen context.');
        }
        headRootId = sourceRootId;
      }
      return {
        descriptor, authoritySnapshotId, settingsSnapshotContentObjectId,
        headRootId: requireId(headRootId, 'Manual compression source root'),
        compressSegmentCount: descriptor.compressSegmentCount
      };
    }

    // Before the first ModelRequest, the Conversation lease makes the current head immutable to
    // other Turns. The descriptor freezes the requested count; coordinator creation then freezes
    // the exact root and boundary into its recipe atomically with the request.
    const heads = await listAllDomainRows(this.application.database, 'ConversationContextHeadLink', {
      conversation_id: slot.conversationId
    });
    if (heads.length !== 1) {
      throw new Error(`Manual compression Turn ${slot.turnId} lacks one current Context head.`);
    }
    if (descriptor.sourceReplay && (descriptor.version !== 2 || descriptor.target.kind !== 'current_head'
      || heads[0].root_id !== descriptor.target.expectedRootId)) {
      throw new Error('Immutable source rebuild lost its frozen current Context head.');
    }
    return {
      descriptor,
      authoritySnapshotId,
      headRootId: requireId(heads[0].root_id, 'Manual compression Context head.root_id'),
      compressSegmentCount: descriptor.compressSegmentCount
    };
  }

  private async readRuntimeMaintenanceDescriptor(
    slot: Pick<DriveSlot, 'conversationId' | 'turnId'>
  ): Promise<ManualCompressionMaintenance | null> {
    const intents = await listAllDomainRows(this.application.database, 'TurnIntent', {
      turn_id: slot.turnId
    });
    if (intents.length === 0) return null;
    const intent = intents[0];
    if (intent.conversation_id !== slot.conversationId) {
      throw new Error(`TurnIntent for ${slot.turnId} belongs to another Conversation.`);
    }
    const revisions = (await listAllDomainRows(this.application.database, 'TurnIntentRevision', {
      intent_id: requireId(intent.id, 'Manual maintenance TurnIntent.id')
    })).sort((left, right) => compareBigInt(right.revision_seq, left.revision_seq));
    if (revisions.length === 0) throw new Error(`TurnIntent for ${slot.turnId} has no revision.`);
    const intentPayload = await this.readJsonContentObject(
      requireId(revisions[0].content_object_id, 'TurnIntentRevision.content_object_id'),
      `TurnIntent ${String(intent.id)} payload`,
      'application/vnd.limcode.turn-intent+json'
    );
    // Input intents store the user content directly and therefore are intentionally not JSON
    // maintenance envelopes. Retry/continuation envelopes use the MIME type above.
    if (!intentPayload) return null;
    const runtimeMaintenance = intentPayload.runtimeMaintenance;
    if (runtimeMaintenance === undefined) return null;
    return parseManualCompressionMaintenance(runtimeMaintenance);
  }

  private async findManualCompressionTurn(
    commandSourceKey: string,
    conversationId: string
  ): Promise<string | null> {
    const intents = await listAllDomainRows(this.application.database, 'TurnIntent', {
      conversation_id: conversationId
    });
    for (const intent of intents) {
      if (typeof intent.turn_id !== 'string' || intent.turn_id.length === 0) continue;
      const descriptor = await this.readRuntimeMaintenanceDescriptor({
        conversationId,
        turnId: intent.turn_id
      });
      if (descriptor?.commandSourceKey === commandSourceKey) return intent.turn_id;
    }
    return null;
  }

  private async driveManualCompression(
    slot: Pick<DriveSlot, 'conversationId' | 'turnId'>,
    frozen: FrozenManualCompressionDrive
  ): Promise<{
    terminalStatus: 'completed' | 'interrupted';
    compression?: CoordinateCompressionResult;
  }> {
    try {
      if (await this.hasPendingTermination(slot.turnId)) {
        await this.settleManualCompressionInterrupted(slot, 'manual_context_compression_interrupted_before_dispatch');
        return { terminalStatus: 'interrupted' };
      }
      const compression = await this.application.compressionCoordinator.coordinate({
        turnId: slot.turnId,
        authoritySnapshotId: frozen.authoritySnapshotId,
        ...(frozen.settingsSnapshotContentObjectId ? { settingsSnapshotContentObjectId: frozen.settingsSnapshotContentObjectId } : {}),
        headRootId: frozen.headRootId,
        trigger: 'manual',
        compressSegmentCount: frozen.compressSegmentCount,
        ...(frozen.descriptor.sourceReplay ? { sourceReplay: frozen.descriptor.sourceReplay } : {}),
        title: frozen.descriptor.sourceReplay ? '从原始记录重建摘要' : '手动上下文压缩'
      });
      if (await this.hasPendingTermination(slot.turnId)) {
        await this.settleManualCompressionInterrupted(slot, 'manual_context_compression_interrupted_after_provider');
        return { terminalStatus: 'interrupted', compression };
      }
      if (compression.status === 'error') {
        throw new Error(
          `${compression.code}: ${compression.message} `
          + `(${compression.estimatedTokens}/${compression.limitTokens} tokens)`
        );
      }
      await this.application.turns.terminal({
        source: { kind: 'internal', key: `manual-compression-maintenance:${slot.turnId}:terminal` },
        turnId: slot.turnId,
        terminalStatus: 'completed',
        reason: compression.status === 'compressed'
          ? 'manual_context_compression_completed'
          : `manual_context_compression_${compression.reason}`
      });
      return { terminalStatus: 'completed', compression };
    } catch (error) {
      if (isExecutionHandoffError(error)) throw error;
      if (await this.hasPendingTermination(slot.turnId)) {
        await this.settleManualCompressionInterrupted(slot, 'manual_context_compression_interrupted');
        return { terminalStatus: 'interrupted' };
      }
      try {
        await this.application.turns.terminal({
          source: { kind: 'internal', key: `manual-compression-maintenance:${slot.turnId}:failed` },
          turnId: slot.turnId,
          terminalStatus: 'failed',
          reason: error instanceof Error ? error.message : String(error)
        });
      } catch {
        // An interrupt may win between the read above and the failed terminal transaction. Its
        // durable PendingTurnInput takes precedence and must not leave the maintenance Turn active.
        if (await this.hasPendingTermination(slot.turnId)) {
          await this.settleManualCompressionInterrupted(slot, 'manual_context_compression_interrupted');
          return { terminalStatus: 'interrupted' };
        }
      }
      throw error;
    }
  }

  private async settleManualCompressionInterrupted(
    slot: Pick<DriveSlot, 'conversationId' | 'turnId'>,
    reason: string
  ): Promise<void> {
    // Startup recovery can encounter an interrupt committed against a streaming request whose
    // original Host is already gone. Persistently cancel every non-terminal request before the
    // Turn terminal assertion; process-local AbortControllers alone are insufficient there.
    await this.cancelLocalExecution(slot.conversationId, slot.turnId, reason);
    await this.application.turns.terminal({
      source: { kind: 'internal', key: `manual-compression-maintenance:${slot.turnId}:interrupted` },
      turnId: slot.turnId,
      terminalStatus: 'interrupted',
      reason
    });
  }

  private async hasPendingTermination(turnId: string): Promise<boolean> {
    return (await this.findPendingTermination(turnId)) !== undefined;
  }

  private async findPendingTermination(turnId: string) {
    const pending = await listAllDomainRows(this.application.database, 'PendingTurnInput', {
      turn_id: turnId,
      state: 'pending'
    });
    return pending.find((input) => [
      'interrupt_request',
      'interrupt_current_turn',
      'termination_request'
    ].includes(String(input.input_kind)));
  }

  private async readJsonContentObject(
    contentObjectId: string,
    label: string,
    expectedContentType?: string
  ): Promise<Record<string, unknown> | null> {
    const rows = await listAllDomainRows(this.application.database, 'ContentObject', { id: contentObjectId });
    if (rows.length !== 1) throw new Error(`${label} ContentObject does not exist.`);
    if (expectedContentType && rows[0].content_type !== expectedContentType) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse((await this.application.contentStore.read(
        asContentObjectMetadata(rows[0], label)
      )).toString('utf8')) as unknown;
    } catch (error) {
      throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TypeError(`${label} must be a JSON object.`);
    }
    return parsed as Record<string, unknown>;
  }

  private finishDriveSlot(slot: DriveSlot): void {
    if (this.active.get(slot.turnId) !== slot) return;
    this.active.delete(slot.turnId);
    this.interruptCancellationSignaled.delete(slot.turnId);
    if (!this.disposed && slot.requestedGeneration > slot.completedGeneration) {
      this.scheduleDrive(slot.conversationId, slot.turnId);
      return;
    }
    if (
      !this.disposed
      && !slot.terminal
      && slot.waitingExternalDataVersion !== undefined
      && slot.waitingWakeFingerprint !== undefined
    ) {
      this.waitingOwned.set(slot.turnId, {
        conversationId: slot.conversationId,
        turnId: slot.turnId,
        externalDataVersion: slot.waitingExternalDataVersion,
        wakeFingerprint: slot.waitingWakeFingerprint
      });
      this.ensureExternalWakePolling();
    }
  }

  private ensureExternalWakePolling(): void {
    if (
      this.disposed
      || (this.active.size === 0 && this.waitingOwned.size === 0 && this.deferredRecovery.size === 0)
      || this.externalWakeTimer
    ) return;
    this.externalWakeTimer = setTimeout(() => {
      this.externalWakeTimer = undefined;
      const task = this.pollExternalWakes();
      this.externalWakeTask = task;
      void task.finally(() => {
        if (this.externalWakeTask === task) this.externalWakeTask = undefined;
      }).catch(() => undefined);
    }, EXTERNAL_WAKE_POLL_MS);
    this.externalWakeTimer.unref();
  }

  private async pollExternalWakes(): Promise<void> {
    if (
      this.disposed
      || this.externalWakePollInFlight
      || (this.active.size === 0 && this.waitingOwned.size === 0 && this.deferredRecovery.size === 0)
    ) return;
    this.externalWakePollInFlight = true;
    try {
      const ownership = new Map<string, boolean>();
      await this.cancelDurablyInterruptedLocalTurns();
      if (this.waitingOwned.size > 0) {
        const localWake = this.localWakeRequested;
        this.localWakeRequested = false;
        const version = await this.application.database.externalDataVersion();
        for (const waiting of [...this.waitingOwned.values()]) {
          if (!localWake && waiting.externalDataVersion === version) continue;
          if (!await this.tryOwnConversation(waiting.conversationId, ownership)) {
            // A live peer Host owns this Conversation now; its runner observes and drives the
            // waiting Turn. Keeping the local entry would auto-drive peer-owned work.
            this.waitingOwned.delete(waiting.turnId);
            continue;
          }
          const observation = await this.observeWaitingWake(waiting.turnId);
          if (observation.fingerprint === waiting.wakeFingerprint) {
            // SQLite data_version is database-global. A different Conversation/Turn committed;
            // acknowledge that edge without replaying this durable human/process wait.
            waiting.externalDataVersion = observation.externalDataVersion;
            continue;
          }
          this.waitingOwned.delete(waiting.turnId);
          this.scheduleDrive(waiting.conversationId, waiting.turnId);
        }
      }
      for (const deferred of [...this.deferredRecovery.values()]) {
        if (deferred.nextAttemptAt !== undefined && Date.now() < deferred.nextAttemptAt) continue;
        const facts = await this.application.turns.recoveryFacts(deferred.turnId);
        if (facts.judgment !== 'resume') {
          this.deferredRecovery.delete(deferred.turnId);
          this.terminationRecoveryFailures.delete(deferred.turnId);
          continue;
        }
        // A live/unknown peer Conversation owner must never be displaced. The candidate stays
        // level-triggered so a later peer release/shutdown still reclaims execution here.
        if (!await this.tryOwnConversation(deferred.conversationId, ownership)) continue;
        const claimed = await this.application.turns.claimRecoveryExecution({
          turnId: deferred.turnId,
          ...this.lease(deferred.conversationId)
        });
        if (!claimed) continue;
        this.deferredRecovery.delete(deferred.turnId);
        this.scheduleDrive(deferred.conversationId, deferred.turnId);
      }
    } catch (error) {
      const waiting = this.waitingOwned.values().next().value as WaitingOwnedTurn | undefined;
      const deferred = this.deferredRecovery.values().next().value as DeferredRecoveryTurn | undefined;
      const first = waiting ?? deferred;
      this.onError(error, {
        operation: waiting ? 'watch-external' : 'watch-recovery',
        conversationId: first?.conversationId ?? 'unknown',
        ...(first ? { turnId: first.turnId } : {})
      });
    } finally {
      this.externalWakePollInFlight = false;
      this.ensureExternalWakePolling();
    }
  }

  /**
   * Turn-scoped level-trigger for a waiting Agent loop. SQLite data_version only tells us that some
   * other connection committed; this fingerprint proves whether the target Turn's resumable facts
   * changed. It intentionally excludes ExecutionLease renewals and unrelated Conversation rows.
   */
  private async observeWaitingWake(
    turnId: string,
    waitingToolCallId?: string
  ): Promise<{ externalDataVersion: string; fingerprint: string; ready: boolean }> {
    const before = await this.application.database.externalDataVersion();
    const observation = await this.waitingWakeFingerprint(turnId, waitingToolCallId);
    const after = await this.application.database.externalDataVersion();
    // If another connection committed during the Turn-scoped read, retain the older edge. The next
    // poll must then re-observe the target facts. This closes the publish race without spinning or
    // starving behind a different Conversation that is continuously streaming commits.
    return {
      externalDataVersion: before === after ? after : before,
      ...observation
    };
  }

  private async waitingWakeFingerprint(
    turnId: string,
    waitingToolCallId?: string
  ): Promise<{ fingerprint: string; ready: boolean }> {
    const [turns, pendingInputs, toolCalls] = await Promise.all([
      listAllDomainRows(this.application.database, 'Turn', { id: turnId }),
      listAllDomainRows(this.application.database, 'PendingTurnInput', { turn_id: turnId }),
      listAllDomainRows(this.application.database, 'ToolCall', { turn_id: turnId })
    ]);
    const waitingToolCalls = toolCalls
      .filter((row) => row.status !== 'terminal')
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const [executionsByCall, operationsByCall] = await Promise.all([
      Promise.all(waitingToolCalls.map((row) => listAllDomainRows(
        this.application.database,
        'ToolExecution',
        { tool_call_id: requireId(row.id, 'ToolCall.id') }
      ))),
      Promise.all(waitingToolCalls.map((row) => listAllDomainRows(
        this.application.database,
        'Operation',
        { tool_call_id: requireId(row.id, 'ToolCall.id') }
      )))
    ]);
    const waitingToolCall = waitingToolCallId
      ? toolCalls.find((row) => row.id === waitingToolCallId)
      : undefined;
    const ready = turns.some((row) => row.status !== 'active')
      || pendingInputs.some((row) => row.state === 'pending')
      || Boolean(waitingToolCallId && (!waitingToolCall || waitingToolCall.status === 'terminal'));
    return {
      ready,
      fingerprint: JSON.stringify({
        turn: turns.map((row) => [String(row.id), String(row.status)]).sort(),
        pendingInputs: pendingInputs.map((row) => [
          String(row.id), String(row.position), String(row.input_kind), String(row.state)
        ]).sort((left, right) => left.join('\u0000').localeCompare(right.join('\u0000'))),
        waitingToolCalls: waitingToolCalls.map((row) => [
          String(row.id), String(row.status)
        ]),
        waitingToolExecutions: executionsByCall.flat().map((row) => [
          String(row.id), String(row.tool_call_id), String(row.status)
        ]).sort((left, right) => left.join('\u0000').localeCompare(right.join('\u0000'))),
        waitingOperations: operationsByCall.flat().map((row) => [
          String(row.id), String(row.tool_call_id), String(row.status)
        ]).sort((left, right) => left.join('\u0000').localeCompare(right.join('\u0000')))
      })
    };
  }

  /**
   * PendingTurnInput is the durable, host-directed interrupt wake. Every Host may observe it, but
   * only the Host that still owns the exact lease is allowed to touch its local AbortControllers.
   */
  private async cancelDurablyInterruptedLocalTurns(): Promise<void> {
    for (const slot of [...this.active.values()]) {
      if (this.interruptCancellationSignaled.has(slot.turnId)) continue;
      const interruption = await this.findPendingTermination(slot.turnId);
      if (!interruption) continue;
      this.interruptCancellationSignaled.add(slot.turnId);
      try {
        await this.cancelLocalExecution(
          slot.conversationId,
          slot.turnId,
          `Durable ${String(interruption.input_kind)} wake reached the owning Host.`
        );
      } catch (error) {
        this.interruptCancellationSignaled.delete(slot.turnId);
        throw error;
      }
    }
  }

  /**
   * Waiting Turns intentionally stop renewing their lease. A human answer can therefore arrive
   * after expiry; that wake must reclaim a fresh generation rather than disappear when the old
   * fence lookup returns null. ChildExecutionTurnLink remains exclusive scheduler membership and
   * is never claimed by the ordinary conversation runner.
   */
  private async recoverMissingExecutionFence(slot: DriveSlot): Promise<ExecutionLeaseFence | null> {
    const membership = await this.application.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').list({
        where: { turn_id: slot.turnId },
        limit: 2
      })
    ]);
    const childLinks = membership.snapshot[0];
    if (!Array.isArray(childLinks)) throw new TypeError('ChildExecutionTurnLink lookup did not return rows.');
    if (childLinks.length > 0) return null;

    const facts = await this.application.turns.recoveryFacts(slot.turnId);
    if (facts.judgment !== 'resume') {
      this.deferredRecovery.delete(slot.turnId);
      this.terminationRecoveryFailures.delete(slot.turnId);
      return null;
    }
    const claimed = await this.application.turns.claimRecoveryExecution({
      turnId: slot.turnId,
      ...this.lease(slot.conversationId)
    });
    if (!claimed) {
      this.deferredRecovery.set(slot.turnId, {
        conversationId: slot.conversationId,
        turnId: slot.turnId
      });
      this.ensureExternalWakePolling();
      return null;
    }
    this.deferredRecovery.delete(slot.turnId);
    const fence = await this.application.turns.executionLeaseFence({
      turnId: slot.turnId,
      leaseOwnerId: this.leaseOwnerId,
      hostBootId: this.application.database.hostBootId
    });
    if (!fence) {
      throw new ExecutionHandoffError(
        `Recovered Turn ${slot.turnId} lost its new ExecutionLease before drive admission.`
      );
    }
    return fence;
  }

  private async cancelLocalExecution(
    conversationId: string,
    turnId: string,
    reason: string
  ): Promise<void> {
    const fence = await this.application.turns.executionLeaseFence({
      turnId,
      leaseOwnerId: this.leaseOwnerId,
      hostBootId: this.application.database.hostBootId
    });
    if (!fence) return;
    const results = await runWithExecutionLeaseFence(fence, () => Promise.allSettled([
      this.application.modelProvider.cancelTurnDispatches(turnId, reason),
      Promise.resolve(this.application.toolDispatcher.cancelActive?.({ turnId, reason }))
    ]));
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  }

  private async quiesceLocalExecution(
    conversationId: string,
    turnId: string,
    reason: ExecutionHandoffError
  ): Promise<void> {
    const results = await Promise.allSettled([
      this.application.modelProvider.quiesceTurnDispatches(turnId, reason),
      Promise.resolve(this.application.toolDispatcher.quiesceTurn?.({ turnId, reason }))
    ]);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (rejected) this.onError(rejected.reason, { operation: 'drive', conversationId, turnId });
  }

  private deferFailedTerminationRecovery(
    slot: Pick<DriveSlot, 'conversationId' | 'turnId'>,
    error: unknown
  ): void {
    if (this.disposed) return;
    const failureCount = (this.terminationRecoveryFailures.get(slot.turnId) ?? 0) + 1;
    this.terminationRecoveryFailures.set(slot.turnId, failureCount);
    const delayMs = Math.min(
      TERMINATION_RECOVERY_MAX_DELAY_MS,
      TERMINATION_RECOVERY_BASE_DELAY_MS * (2 ** Math.min(10, failureCount - 1))
    );
    this.waitingOwned.delete(slot.turnId);
    this.deferredRecovery.set(slot.turnId, {
      conversationId: slot.conversationId,
      turnId: slot.turnId,
      failureCount,
      nextAttemptAt: Date.now() + delayMs
    });
    this.diagnostics?.observe({
      eventKind: 'turn_interrupt_recovery_scheduled',
      scopeKind: 'turn',
      scopeId: slot.turnId,
      correlationId: slot.turnId,
      metadata: {
        conversationId: slot.conversationId,
        turnId: slot.turnId,
        stage: 'drive_failed_with_pending_termination',
        status: 'scheduled',
        reasonCode: 'pending_termination',
        round: failureCount,
        errorName: error instanceof Error ? error.name : 'unknown'
      }
    });
    this.ensureExternalWakePolling();
  }

  private deferExecutionRecovery(slot: Pick<DriveSlot, 'conversationId' | 'turnId'>): void {
    if (this.disposed) return;
    this.waitingOwned.delete(slot.turnId);
    const existing = this.deferredRecovery.get(slot.turnId);
    this.deferredRecovery.set(slot.turnId, {
      conversationId: slot.conversationId,
      turnId: slot.turnId,
      ...(existing?.failureCount ? { failureCount: existing.failureCount } : {})
    });
    this.ensureExternalWakePolling();
  }

  private async renewExecutionLease(
    slot: Pick<DriveSlot, 'conversationId' | 'turnId'>,
    fence: ExecutionLeaseFence,
    stage: 'before_drive' | 'interval'
  ): Promise<ExecutionLeaseRenewalResult> {
    const observedAt = Date.now();
    const requestedExpiresAt = new Date(observedAt + this.leaseDurationMs).toISOString();
    try {
      const result = await this.application.turns.renewExecutionLeaseDetailed({
        fence,
        leaseExpiresAt: requestedExpiresAt
      });
      this.observeLeaseRenewal(slot, fence, stage, observedAt, result);
      return result;
    } catch (error) {
      this.deferExecutionRecovery(slot);
      this.diagnostics?.observe({
        eventKind: 'execution_lease_renewal',
        scopeKind: 'turn',
        scopeId: slot.turnId,
        correlationId: fence.id,
        metadata: {
          conversationId: slot.conversationId,
          turnId: slot.turnId,
          hostBootId: fence.hostBootId,
          stage,
          status: 'failed',
          leaseGeneration: fence.generation.toString(),
          leaseExpiresAt: requestedExpiresAt,
          renewalReason: 'exception',
          errorName: error instanceof Error ? error.name : 'unknown'
        }
      });
      throw error;
    }
  }

  private observeLeaseRenewal(
    slot: Pick<DriveSlot, 'conversationId' | 'turnId'>,
    fence: ExecutionLeaseFence,
    stage: 'before_drive' | 'interval',
    observedAt: number,
    result: ExecutionLeaseRenewalResult
  ): void {
    const leaseExpiresAt = result.renewed
      ? result.renewedExpiresAt
      : result.observedExpiresAt;
    this.diagnostics?.observe({
      eventKind: 'execution_lease_renewal',
      scopeKind: 'turn',
      scopeId: slot.turnId,
      correlationId: fence.id,
      metadata: {
        conversationId: slot.conversationId,
        turnId: slot.turnId,
        hostBootId: fence.hostBootId,
        stage,
        status: result.renewed ? 'renewed' : 'lost',
        leaseGeneration: fence.generation.toString(),
        ...(leaseExpiresAt ? {
          leaseExpiresAt,
          remainingMs: Date.parse(leaseExpiresAt) - observedAt
        } : {}),
        ...(!result.renewed ? { renewalReason: result.reason } : {})
      }
    });
  }

  private startLeaseRenewal(slot: DriveSlot, fence: ExecutionLeaseFence): {
    stop(): Promise<void>;
  } {
    let stopped = false;
    let renewal = Promise.resolve();
    const intervalMs = Math.max(1_000, Math.min(10_000, Math.floor(this.leaseDurationMs / 3)));
    const timer = setInterval(() => {
      renewal = renewal.then(async () => {
        if (stopped || this.disposed) return;
        const result = await this.renewExecutionLease(slot, fence, 'interval');
        if (result.renewed) return;
        stopped = true;
        clearInterval(timer);
        this.deferExecutionRecovery(slot);
        await this.quiesceLocalExecution(
          slot.conversationId,
          slot.turnId,
          new ExecutionHandoffError(
            `ExecutionLease renewal lost for Turn ${slot.turnId}: ${result.reason}.`
          )
        );
      }).catch(async (error) => {
        stopped = true;
        clearInterval(timer);
        this.onError(error, {
          operation: 'drive',
          conversationId: slot.conversationId,
          turnId: slot.turnId
        });
        this.deferExecutionRecovery(slot);
        await this.quiesceLocalExecution(
          slot.conversationId,
          slot.turnId,
          new ExecutionHandoffError(`ExecutionLease renewal failed for Turn ${slot.turnId}.`)
        );
      });
    }, intervalMs);
    timer.unref();
    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await renewal;
      }
    };
  }

  private async ownsExecution(turnId: string): Promise<boolean> {
    return (await this.application.turns.executionLeaseFence({
      turnId,
      leaseOwnerId: this.leaseOwnerId,
      hostBootId: this.application.database.hostBootId
    })) !== null;
  }

  private scheduleAdmission(conversationId: string): void {
    if (this.disposed) return;
    const existing = this.admissions.get(conversationId);
    if (existing) {
      existing.requestedGeneration += 1n;
      return;
    }
    const slot: AdmissionSlot = {
      conversationId,
      requestedGeneration: 1n,
      completedGeneration: 0n,
      task: Promise.resolve()
    };
    const task = this.runOwnedAdmissionSlot(slot)
      .catch((error) => this.onError(error, { operation: 'admit-next', conversationId }))
      .finally(() => this.finishAdmissionSlot(slot));
    slot.task = task;
    this.admissions.set(conversationId, slot);
  }

  /**
   * Queued admission drains only under this Host's Conversation runtime ownership, pinned through
   * completion so an idle release cannot race an in-flight admission. A live peer owner drains
   * its own queue; standing down is a safe no-op because the queued Intent stays durable.
   */
  private async runOwnedAdmissionSlot(slot: AdmissionSlot): Promise<void> {
    try {
      await this.conversationOwners.run(slot.conversationId, () => this.runAdmissionSlot(slot));
    } catch (error) {
      if (isConversationRuntimeOwnerBusyError(error)) return;
      throw error;
    }
  }

  private async runAdmissionSlot(slot: AdmissionSlot): Promise<void> {
    for (;;) {
      if (this.disposed) return;
      const generation = slot.requestedGeneration;
      try {
        const next = await this.application.turns.admitNextQueued(this.lease(slot.conversationId));
        slot.completedGeneration = generation;
        if (this.disposed) return;
        if (next?.turnId) {
          // An admitted Turn now owns the Conversation lease; absorb redundant admission wakes.
          slot.completedGeneration = slot.requestedGeneration;
          this.scheduleDrive(slot.conversationId, next.turnId);
          return;
        }
        if (slot.requestedGeneration > generation) continue;
        return;
      } catch (error) {
        slot.completedGeneration = generation;
        throw error;
      }
    }
  }

  private finishAdmissionSlot(slot: AdmissionSlot): void {
    if (this.admissions.get(slot.conversationId) !== slot) return;
    this.admissions.delete(slot.conversationId);
    if (!this.disposed && slot.requestedGeneration > slot.completedGeneration) {
      this.scheduleAdmission(slot.conversationId);
    }
  }

  private lease(conversationId: string): {
    conversationId: string;
    leaseOwnerId: string;
    hostBootId: string;
    leaseExpiresAt: string;
  } {
    return {
      conversationId,
      leaseOwnerId: this.leaseOwnerId,
      hostBootId: this.application.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + this.leaseDurationMs).toISOString()
    };
  }

  private get conversationOwners(): ConversationRuntimeOwnerManager {
    return this.application.database.conversationOwners;
  }

  /**
   * Claims a Conversation for recovery/poll work with stand-down semantics: false means a
   * live/unknown peer Host owns it and this Host must not drive its work. Results are cached per
   * recovery sweep/poll tick; each new tick re-evaluates, which keeps the level trigger alive.
   */
  private async tryOwnConversation(
    conversationId: string,
    cache: Map<string, boolean>
  ): Promise<boolean> {
    const cached = cache.get(conversationId);
    if (cached !== undefined) return cached;
    const owned = await this.conversationOwners.tryClaim(conversationId);
    cache.set(conversationId, owned);
    return owned;
  }

  private requireOpen(): void {
    if (this.disposed) throw new Error('ReliableConversationRunner 已关闭。');
  }
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty id.`);
  return value;
}

function parseManualCompressionMaintenance(value: unknown): ManualCompressionMaintenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Runtime maintenance descriptor must be an object.');
  }
  const descriptor = value as Record<string, unknown>;
  if (
    descriptor.kind !== 'manual_context_compression'
    || (descriptor.version !== 1 && descriptor.version !== 2)
  ) {
    throw new TypeError('Unsupported runtime maintenance descriptor.');
  }
  const compressSegmentCount = requireSafePositiveInteger(
    descriptor.compressSegmentCount,
    'Runtime maintenance compressSegmentCount'
  );
  const commandSourceKey = requireId(
    descriptor.commandSourceKey,
    'Runtime maintenance commandSourceKey'
  );
  const target = descriptor.version === 2 ? parseCompressionTarget(descriptor.target) : undefined;
  const sourceReplay = parseManualCompressionSourceReplay(descriptor.sourceReplay, target);
  if (descriptor.version === 1) {
    return {
      kind: 'manual_context_compression',
      version: 1,
      compressSegmentCount,
      commandSourceKey
    };
  }
  return {
    kind: 'manual_context_compression',
    version: 2,
    compressSegmentCount,
    target: target!,
    ...(sourceReplay ? { sourceReplay } : {}),
    commandSourceKey
  };
}

function parseManualCompressionSourceReplay(
  value: unknown,
  target: CompressionCommandTarget | undefined
): 'immutable_provenance' | undefined {
  if (value === undefined) return undefined;
  if (value !== 'immutable_provenance') {
    throw new TypeError('Manual compression sourceReplay is invalid.');
  }
  if (target?.kind !== 'current_head') {
    throw new TypeError('从原始记录重建摘要必须明确选择当前完整上下文。');
  }
  return value;
}

function parseCompressionTarget(value: unknown): CompressionCommandTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Runtime maintenance target must be an object.');
  }
  const target = value as Record<string, unknown>;
  if (target.kind === 'current_head') {
    return {
      kind: 'current_head',
      expectedRootId: requireId(target.expectedRootId, 'Runtime maintenance target.expectedRootId')
    };
  }
  if (target.kind === 'through_message') {
    return {
      kind: 'through_message',
      messageId: requireId(target.messageId, 'Runtime maintenance target.messageId'),
      expectedRevisionId: requireId(
        target.expectedRevisionId,
        'Runtime maintenance target.expectedRevisionId'
      )
    };
  }
  throw new TypeError('Unsupported Runtime maintenance target.');
}

function sameCompressionTarget(left: CompressionCommandTarget, right: CompressionCommandTarget): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'current_head'
    ? left.expectedRootId === (right as Extract<CompressionCommandTarget, { kind: 'current_head' }>).expectedRootId
    : left.messageId === (right as Extract<CompressionCommandTarget, { kind: 'through_message' }>).messageId
      && left.expectedRevisionId === (right as Extract<CompressionCommandTarget, { kind: 'through_message' }>).expectedRevisionId;
}

function parseTurnTerminalStatus(
  value: unknown
): 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'outcome_unknown' {
  if (
    value === 'completed'
    || value === 'failed'
    || value === 'interrupted'
    || value === 'cancelled'
    || value === 'outcome_unknown'
  ) return value;
  throw new TypeError('Manual compression TurnTermination.terminal_status is invalid.');
}

function requireSafePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function compareBigInt(left: unknown, right: unknown): number {
  if (typeof left !== 'bigint' || typeof right !== 'bigint') {
    throw new TypeError('Reliable sequence values must remain bigint inside JavaScript.');
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function asContentObjectMetadata(row: Record<string, unknown>, label: string): ContentObjectMetadata {
  const byteLength = row.byte_length;
  if (typeof byteLength !== 'bigint' || byteLength < 0n) {
    throw new TypeError(`${label} ContentObject.byte_length must be a non-negative bigint.`);
  }
  return {
    ...row,
    id: requireId(row.id, `${label} ContentObject.id`),
    content_type: requireId(row.content_type, `${label} ContentObject.content_type`),
    sha256: requireId(row.sha256, `${label} ContentObject.sha256`),
    byte_length: byteLength,
    storage_key: requireId(row.storage_key, `${label} ContentObject.storage_key`),
    created_at: requireId(row.created_at, `${label} ContentObject.created_at`)
  };
}

function serializeUserContent(text: string | undefined, content: MessageContent | undefined): {
  value: string;
  contentType: string;
} {
  if (content?.parts?.length) {
    return {
      value: JSON.stringify({ role: 'user', parts: content.parts }),
      contentType: 'application/vnd.limcode.message+json'
    };
  }
  const value = text?.trim() ?? '';
  if (!value) throw new TypeError('可靠 Turn 输入不能为空。');
  return { value, contentType: 'text/plain; charset=utf-8' };
}

function defaultErrorHandler(
  error: unknown,
  context: {
    operation: 'drive' | 'admit-next' | 'watch-external' | 'watch-recovery';
    conversationId: string;
    turnId?: string;
  }
): void {
  console.error('[LimCode] Reliable conversation runner failed.', context, error);
  if (!error || typeof error !== 'object') return;
  if ('originalError' in error) {
    console.error(
      '[LimCode] Reliable conversation runner original error.',
      context,
      (error as { originalError?: unknown }).originalError
    );
  }
  if ('terminalError' in error) {
    console.error(
      '[LimCode] Reliable conversation runner terminal-state error.',
      context,
      (error as { terminalError?: unknown }).terminalError
    );
  }
}
