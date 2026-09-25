import type {
  ReliableAgentLoop,
  ReliableAgentLoopResult,
  ReliableAgentToolDispatchInput,
  ReliableAgentToolPause,
  ReliableAgentToolSettled
} from './agentLoop';
import type { AnswerControlPlane, RuntimeDeliveryControlPlane } from './answerDelivery';
import { normalizeChildForkTurns } from './childContextFork';
import {
  childContinuationTurnId,
  childExecutionSpawnIdentity,
  type ChildExecutionCancelCommand,
  type ChildExecutionCancelSubtreeResult,
  type ChildExecutionControlPlane,
  type ChildExecutionSnapshot
} from './childExecution';
import type {
  PlanDelegationEnsureRequest,
  PlanDelegationRequest,
  PlanDelegationResult
} from './toolInteractions';
import type { EffectControlPlane, ToolTerminalResult } from './effectControlPlane';
import type { ModelProviderControlPlane } from './modelProviderControlPlane';
import type { CoordinateCompressionResult } from './contextCompressionCoordinator';
import { frozenModelSelection } from './frozenAuthority';
import { stablePhaseFId, isTransactionAssertionFailure } from './phaseFIdentity';
import { CollaborationCapacityError, CollaborationMembershipChangedError } from './collaborationCapacity';
import type { PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import type { RuntimeDatabase } from './runtimeDatabase';
import type { ReliableSpecialToolAdmission, ReliableToolDispatchAuthority } from './toolDispatcher';
import { listAllDomainRows } from './repositoryPagination';
import type {
  TurnCommandContent,
  TurnCommandResult,
  TurnControlPlane,
  TurnModelOverride
} from './turnControlPlane';
import type { CompressionCommandTarget, MessageRetryTarget, SessionThinkingOverride } from '../../shared/protocol';
import {
  ExecutionHandoffError,
  isExecutionHandoffError,
  runWithoutExecutionLeaseFence,
  runWithExecutionLeaseFence,
  type ExecutionLeaseFence
} from './executionLeaseFence';
import { isConversationRuntimeOwnerBusyError } from './ConversationRuntimeOwnerManager';
import { ConversationOwnershipGate } from './conversationOwnershipGate';
import { maxChildAgentDepthFromConfig, RUN_AGENT_OPERATIONS } from '../world/modules/tools/definitions/runAgent';
import {
  listConversationChildTasks,
  readConversationChildTask,
  childTaskSummary,
  type ConversationChildTaskProjection,
  type ConversationChildTaskRecord
} from './conversationChildTaskProjection';
import { requireChildExecutionStatus } from './childExecutionState';
import { childThinkingInheritanceFromAuthority, childThinkingOverrideForSpawn } from './childThinkingInheritance';
import { childAgentDepthForTurn } from './childAgentDepth';
import { forkInheritedChildTargets, isForkConversation } from './conversationChildHandles';

export interface ReliableChildAgentSelection {
  agentId: string;
  agentType: string;
  title?: string;
}

export interface ReliableChildAgentSelector {
  resolve(input: { agentId?: string; agentType?: string }): Promise<ReliableChildAgentSelection>;
}

export interface ReliableChildModelProfileStore {
  initializeConversation(input: {
    conversationId: string;
    model: TurnModelOverride;
    thinkingOverride?: SessionThinkingOverride;
  }): Promise<{ created: boolean }>;
}

export interface ReliableChildAgentCoordinatorDependencies {
  database: RuntimeDatabase;
  effects: EffectControlPlane;
  children: ChildExecutionControlPlane;
  answers: AnswerControlPlane;
  deliveries: RuntimeDeliveryControlPlane;
  modelProvider: ModelProviderControlPlane;
  turns: TurnControlPlane;
  agentLoop: ReliableAgentLoop;
  agents: ReliableChildAgentSelector;
  modelProfiles: ReliableChildModelProfileStore;
  deliveryWakeups?: {
    notifyRuntimeDelivery(deliveryId: string): void;
  };
  ownedProcessCleanup?: {
    notify(): void;
  };
  cancelTurnExecution?: (input: { turnId: string; reason: string }) => Promise<void>;
  quiesceTurnExecution?: (input: { turnId: string; reason: ExecutionHandoffError }) => Promise<void>;
  manualCompression?: {
    admit(input: {
      commandId: string;
      conversationId: string;
      compressSegmentCount: number;
      target?: CompressionCommandTarget;
      sourceReplay?: 'immutable_provenance';
      childExecution: { childExecutionId: string; leaseOwnerId: string };
    }): Promise<TurnCommandResult>;
    inspect(input: {
      commandId: string;
      conversationId: string;
      target?: CompressionCommandTarget;
      sourceReplay?: 'immutable_provenance';
    }): Promise<ReliableChildManualCompressionResult | null>;
    driveIfPresent(input: {
      conversationId: string;
      turnId: string;
    }): Promise<ReliableChildMaintenanceDriveResult | null>;
  };
  now?: () => string;
}

export interface ReliableChildManualCompressionResult {
  turnId: string;
  deduplicated: boolean;
  inProgress?: boolean;
  terminal?: {
    status: 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'outcome_unknown';
    reason: string;
  };
  compression?: CoordinateCompressionResult;
}

export interface ReliableChildMaintenanceDriveResult {
  terminalStatus: 'completed' | 'interrupted';
  compression?: CoordinateCompressionResult;
}

type ReliableChildDriveResult = ReliableAgentLoopResult & {
  compression?: CoordinateCompressionResult;
};

export interface ReliableChildAgentRecoveryReport {
  spawnIntentsScanned: number;
  spawnIntentsReconciled: number;
  activeTurnsScanned: number;
  resumedTurnIds: string[];
  deferredTurnIds: string[];
  continuationsAdmitted: string[];
  terminalTurnsReconciled: string[];
}

const CHILD_WAKE_POLL_MS = 500;
const CHILD_RECOVERY_CHANGE_SCAN_MS = 2_000;
const CHILD_RECOVERY_SAFETY_SCAN_MS = 5_000;
type ChildDispatchResult = ToolTerminalResult | ReliableAgentToolSettled | ReliableAgentToolPause;

/**
 * Product orchestration for run_agent and AnswerBridge tools. Durable lifecycle facts stay in their
 * dedicated control planes; this coordinator only orders local dispatch, waiting and re-entry.
 */
export class ReliableChildAgentCoordinator {
  private readonly activeTurns = new Map<string, Promise<ReliableChildDriveResult>>();
  private readonly now: () => string;
  private readonly childLeaseOwnerId: string;
  private disposing = false;
  private disposePromise: Promise<void> | undefined;
  private handoff: ExecutionHandoffError | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryPass: Promise<ReliableChildAgentRecoveryReport> | undefined;
  private recoveryPassScope: string | undefined;
  private recoveryRerunRequested = false;
  private recoveryRerunUnscoped = false;
  private recoveryPollingNeeded = false;
  private recoveryObservedDataVersion: string | undefined;
  private recoveryChangeScanAt = 0;
  private recoverySafetyScanAt = 0;
  private readonly cancellationSignaled = new Set<string>();
  private readonly recoveryAfterDrive = new Set<string>();
  /** Level-triggered wakes that arrive while the same Turn is still inside driveChild(). */
  private readonly pendingDriveWakes = new Set<string>();
  private readonly waitingOwned = new Map<string, { childExecutionId: string; externalDataVersion: string }>();
  private recoveryPollInFlight = false;
  private recoveryPollTask: Promise<void> | undefined;
  /** Frozen parent Turns never change, so each one's child thinking choice is read once per Host. */
  private readonly parentTurnThinking = new Map<string, Promise<SessionThinkingOverride | undefined>>();
  /** Child Conversations whose model record recovery already wrote or found; later passes skip them. */
  private readonly repairedChildModelProfiles = new Set<string>();
  /** Recovery failures already logged, so a failure that repeats on every pass is logged once. */
  private readonly reportedRecoveryFailures = new Set<string>();
  private readonly unregisterFinalOutput: () => void;

  public constructor(private readonly dependencies: ReliableChildAgentCoordinatorDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.childLeaseOwnerId = `child-driver:${dependencies.database.hostBootId}`;
    // A child's answer is the final output of its Turn: one channel, no separate submit tool.
    this.unregisterFinalOutput = dependencies.agentLoop?.registerFinalOutputObserver({
      beforeTurnCompleted: (input) => this.submitTurnFinalAnswer(input)
    }) ?? (() => undefined);
  }

  public async dispatch(
    input: ReliableAgentToolDispatchInput,
    signal?: AbortSignal,
    authority?: ReliableToolDispatchAuthority,
    admission?: ReliableSpecialToolAdmission
  ): Promise<ChildDispatchResult | undefined> {
    if (this.handoff) throw this.handoff;
    const aborted = await this.settleUserAbort(input.toolCallId, signal, 'before-special-dispatch');
    if (aborted) return aborted;
    switch (input.toolName) {
      case 'run_agent':
        return this.runAgent(input, signal, authority, admission);
      case 'read_agent_answer':
        return this.readAnswer(input);
      default:
        return undefined;
    }
  }

  /** Resolves Agent configuration and reserves deterministic child identities without writing facts. */
  public async previewApprovedPlan(input: PlanDelegationRequest): Promise<PlanDelegationResult> {
    return (await this.planDelegationPreview(input)).result;
  }

  private async planDelegationPreview(input: PlanDelegationRequest): Promise<{
    result: PlanDelegationResult;
    selection: ReliableChildAgentSelection;
  }> {
    if (this.handoff) throw this.handoff;
    if (this.disposing) throw new Error('ReliableChildAgentCoordinator is disposing.');
    const sourceToolCallId = requireId(input.sourceToolCallId, 'sourceToolCallId');
    const parentTurnId = requireId(input.parentTurnId, 'parentTurnId');
    const sourceToolCall = await this.get('ToolCall', sourceToolCallId);
    if (!sourceToolCall || requireId(sourceToolCall.turn_id, 'ToolCall.turn_id') !== parentTurnId) {
      throw new Error('Plan delegation source ToolCall does not belong to the requested parent Turn.');
    }
    const selection = await this.dependencies.agents.resolve({
      agentId: requireId(input.requestedAgentId, 'requestedAgentId')
    });
    const identity = childExecutionSpawnIdentity({ sourceToolCallId });
    return {
      result: {
        ...identity,
        agentId: selection.agentId,
        agentType: selection.agentType
      },
      selection
    };
  }

  /**
   * Ensures the child lineage for an already-committed approved Plan. The durable Plan response is
   * the intent; this method is idempotent and never owns settlement of the source submit_plan call.
   */
  public async ensureApprovedPlan(input: PlanDelegationEnsureRequest): Promise<PlanDelegationResult> {
    const { result: preview, selection } = await this.planDelegationPreview(input);
    assertExpectedPlanDelegation(preview, input.expected);
    const sourceToolCallId = requireId(input.sourceToolCallId, 'sourceToolCallId');
    const parentTurnId = requireId(input.parentTurnId, 'parentTurnId');
    const spawned = await this.dependencies.children.spawn({
      sourceToolCallId,
      childAgentId: selection.agentId,
      modelFallback: await this.dependencies.children.frozenModelSelectionForTurn(parentTurnId),
      prompt: promptWithAnswerBridge(requireText(input.prompt, 'prompt')),
      completionPolicy: 'background',
      sourceSettlement: 'external',
      // The user approved this delegation on the Plan card: the executor Agent runs with its own
      // settings instead of the planning Turn's (see ChildSpawnAuthorityBound).
      authorityBound: 'executor_agent',
      leaseOwnerId: this.childLeaseOwnerId,
      leaseExpiresAt: leaseExpiry(this.timestamp(), 0)
    });
    const inheritedThinkingOverride = await this.dependencies.children.frozenChildThinkingOverrideForTurn(parentTurnId);
    await this.dependencies.modelProfiles.initializeConversation({
      conversationId: spawned.childConversationId,
      model: spawned.modelSelection,
      ...(inheritedThinkingOverride ? { thinkingOverride: inheritedThinkingOverride } : {})
    });
    if (spawned.answerBridgeId !== preview.answerBridgeId) {
      throw new Error('Plan delegation returned an unexpected AnswerBridge identity.');
    }
    const claimed = await this.dependencies.children.claimSpawnDispatch(spawned.effectIntentId);
    if (claimed) {
      const receipt = await this.dependencies.children.recordSpawnReceipt({
        sourceKey: `plan-child-spawn:${spawned.attemptId}`,
        attemptId: spawned.attemptId,
        outcome: 'succeeded',
        detail: { adapter: 'reliable-local-agent-loop', source: 'approved-plan' }
      });
      await this.dependencies.children.reconcileSpawnReceipt(receipt.effectReceiptId);
      this.launch(spawned.childExecutionId, spawned.childTurnId);
    } else {
      const recovered = await this.dependencies.children.recoverSpawnIntent(spawned.effectIntentId);
      if (recovered.shouldDrive) this.launch(recovered.childExecutionId, recovered.childTurnId);
      if (recovered.childStatus === 'starting') {
        throw new Error('Plan child spawn recovery did not finish its durable dispatch.');
      }
    }
    return {
      childExecutionId: spawned.childExecutionId,
      childConversationId: spawned.childConversationId,
      childTurnId: spawned.childTurnId,
      answerBridgeId: spawned.answerBridgeId,
      agentId: selection.agentId,
      agentType: selection.agentType
    };
  }

  /** Parent interruption closes local foreground waits but intentionally leaves children running. */
  public async cancelParentWaits(input: { turnId: string; reason: string }): Promise<void> {
    const turnId = requireId(input.turnId, 'turnId');
    const calls = await listAllDomainRows(this.dependencies.database, 'ToolCall', {
      turn_id: turnId
    });
    for (const call of calls) {
      const toolCallId = requireId(call.id, 'ToolCall.id');
      const waiting = await this.list('Operation', { tool_call_id: toolCallId, status: 'waiting_answer' }, 2);
      if (waiting.length === 0) continue;
      await this.dependencies.children.cancelForegroundWaitForToolCall({
        toolCallId,
        reason: input.reason,
        sourceIdentity: `parent-turn-interrupt:${turnId}:${toolCallId}`
      });
    }
  }

  /**
   * Replays durable child scheduling facts after Host restart; safe to call repeatedly. With
   * `conversationId` only children of that Conversation are recovered — used when a new owner
   * takes over one child Conversation while this Host is already running.
   */
  public recoverStartup(signal?: AbortSignal, conversationId?: string): Promise<ReliableChildAgentRecoveryReport> {
    signal?.throwIfAborted();
    if (this.recoveryPass) {
      const runningScope = this.recoveryPassScope;
      if (runningScope === undefined || runningScope === conversationId) {
        // Remember a wake that races an in-flight scan. Returning the same Promise without this
        // level-trigger would lose facts committed behind the scan cursor. An unscoped pass (or
        // one already covering this Conversation) satisfies this requester.
        this.recoveryRerunRequested = true;
        return this.recoveryPass;
      }
      if (conversationId === undefined) {
        this.recoveryRerunRequested = true;
        this.recoveryRerunUnscoped = true;
        return this.recoveryPass;
      }
      // A differently scoped pass is in flight; queue this Conversation behind it.
      return this.recoveryPass.then(
        () => this.recoverStartup(signal, conversationId),
        () => this.recoverStartup(signal, conversationId)
      );
    }
    this.recoveryPollingNeeded = true;
    const pass = runWithoutExecutionLeaseFence(async () => {
      let aggregate: ReliableChildAgentRecoveryReport | undefined;
      let passScope = conversationId;
      do {
        signal?.throwIfAborted();
        this.recoveryRerunRequested = false;
        if (this.recoveryRerunUnscoped) {
          this.recoveryRerunUnscoped = false;
          passScope = undefined;
        }
        aggregate = mergeRecoveryReports(aggregate, await this.runRecoveryPass(signal, passScope));
      } while (this.recoveryRerunRequested && !this.disposing && !this.handoff);
      return aggregate ?? emptyRecoveryReport();
    })
      .finally(() => {
        const rerun = this.recoveryRerunRequested;
        if (this.recoveryPass === pass) {
          this.recoveryPass = undefined;
          this.recoveryPassScope = undefined;
        }
        if (rerun && !signal?.aborted && !this.disposing && !this.handoff) {
          this.recoveryRerunRequested = false;
          void this.recoverStartup().catch((error) => this.reportError(error, 'recovery-rerun'));
        }
        if (!signal?.aborted) this.ensureRecoveryPolling();
      });
    this.recoveryPass = pass;
    this.recoveryPassScope = conversationId;
    return pass;
  }

  /** Routes an interaction/delivery wake only when immutable child scheduler membership exists. */
  public async resume(turnIdInput: string): Promise<boolean> {
    if (this.disposing || this.handoff) return false;
    const turnId = requireId(turnIdInput, 'turnId');
    const memberships = await this.list('ChildExecutionTurnLink', { turn_id: turnId }, 2);
    if (memberships.length === 0) return false;
    if (memberships.length !== 1) throw new Error(`Child Turn ${turnId} has non-unique scheduler membership.`);
    const childExecutionId = requireId(
      memberships[0].child_execution_id,
      'ChildExecutionTurnLink.child_execution_id'
    );
    // Only the child Conversation's owner may drive it. A wake for a foreign-owned child stays on
    // the durable outbox; the owning Host's own scan routes it there instead.
    const turn = await this.get('Turn', turnId);
    if (turn) {
      const owners = this.dependencies.database.conversationOwners;
      const turnConversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
      let eligible = owners.owns(turnConversationId);
      if (!eligible) {
        try {
          eligible = await owners.tryClaim(turnConversationId);
        } catch (error) {
          if (!isConversationRuntimeOwnerBusyError(error)) {
            this.reportError(error, 'resume-ownership-claim', turnId);
          }
          eligible = false;
        }
      }
      if (!eligible) return false;
    }
    this.waitingOwned.delete(turnId);
    if (await this.dependencies.turns.ownsExecutionLease({
      turnId,
      leaseOwnerId: this.childLeaseOwnerId,
      hostBootId: this.dependencies.database.hostBootId
    })) {
      this.launch(childExecutionId, turnId);
    } else {
      this.triggerRecoveryPass();
    }
    return true;
  }

  /** Starts or queues a user-authored Turn without detaching the ChildExecution/AnswerBridge lineage. */
  public async inputFromConversation(input: {
    commandId: string;
    childExecutionId: string;
    conversationId: string;
    content: TurnCommandContent;
    contentType?: string;
    executorAgentId?: string;
    modelOverride?: TurnModelOverride;
  }): Promise<TurnCommandResult> {
    const childExecutionId = requireId(input.childExecutionId, 'childExecutionId');
    await this.dependencies.database.conversationOwners.assertOwned(
      requireId(input.conversationId, 'conversationId')
    );
    const result = await this.dependencies.turns.input({
      source: { kind: 'command', key: requireId(input.commandId, 'commandId') },
      conversationId: requireId(input.conversationId, 'conversationId'),
      leaseOwnerId: this.childLeaseOwnerId,
      hostBootId: this.dependencies.database.hostBootId,
      leaseExpiresAt: leaseExpiry(this.timestamp(), 0),
      content: input.content,
      ...(input.contentType ? { contentType: input.contentType } : {}),
      ...(input.executorAgentId ? { executorAgentId: input.executorAgentId } : {}),
      ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
      membership: { kind: 'child_execution', childExecutionId }
    });
    this.scheduleConversationCommand(childExecutionId, result);
    return result;
  }

  /** Exact child retry: history rewind stays idle-fenced and the replacement Turn remains a child generation. */
  public async retryFromConversation(input: {
    commandId: string;
    childExecutionId: string;
    conversationId: string;
    sourceTurnId: string;
    target: MessageRetryTarget;
    expectedMessageRevisionId?: string;
    executorAgentId?: string;
    modelOverride?: TurnModelOverride;
  }): Promise<TurnCommandResult> {
    const childExecutionId = requireId(input.childExecutionId, 'childExecutionId');
    await this.dependencies.database.conversationOwners.assertOwned(
      requireId(input.conversationId, 'conversationId')
    );
    const result = await this.dependencies.turns.retry({
      source: { kind: 'command', key: requireId(input.commandId, 'commandId') },
      conversationId: requireId(input.conversationId, 'conversationId'),
      leaseOwnerId: this.childLeaseOwnerId,
      hostBootId: this.dependencies.database.hostBootId,
      leaseExpiresAt: leaseExpiry(this.timestamp(), 0),
      sourceTurnId: requireId(input.sourceTurnId, 'sourceTurnId'),
      target: input.target,
      ...(input.expectedMessageRevisionId
        ? { expectedMessageRevisionId: input.expectedMessageRevisionId }
        : {}),
      ...(input.executorAgentId ? { executorAgentId: input.executorAgentId } : {}),
      ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
      membership: { kind: 'child_execution', childExecutionId }
    });
    this.scheduleConversationCommand(childExecutionId, result);
    return result;
  }

  /** Atomic child edit-and-run with the same ChildExecution generation and AnswerBridge. */
  public async editAndRunFromConversation(input: {
    commandId: string;
    childExecutionId: string;
    conversationId: string;
    messageId: string;
    expectedRevisionId?: string;
    content: TurnCommandContent;
    contentType?: string;
    deleteFollowing?: boolean;
    executorAgentId?: string;
    modelOverride?: TurnModelOverride;
  }): Promise<TurnCommandResult> {
    const childExecutionId = requireId(input.childExecutionId, 'childExecutionId');
    await this.dependencies.database.conversationOwners.assertOwned(
      requireId(input.conversationId, 'conversationId')
    );
    const result = await this.dependencies.turns.editAndRun({
      source: { kind: 'command', key: requireId(input.commandId, 'commandId') },
      conversationId: requireId(input.conversationId, 'conversationId'),
      leaseOwnerId: this.childLeaseOwnerId,
      hostBootId: this.dependencies.database.hostBootId,
      leaseExpiresAt: leaseExpiry(this.timestamp(), 0),
      messageId: requireId(input.messageId, 'messageId'),
      ...(input.expectedRevisionId ? { expectedRevisionId: input.expectedRevisionId } : {}),
      content: input.content,
      ...(input.contentType ? { contentType: input.contentType } : {}),
      ...(input.deleteFollowing ? { deleteFollowing: true } : {}),
      ...(input.executorAgentId ? { executorAgentId: input.executorAgentId } : {}),
      ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
      membership: { kind: 'child_execution', childExecutionId }
    });
    this.scheduleConversationCommand(childExecutionId, result);
    return result;
  }

  /**
   * Runs manual Context compression as a real generation of the owning ChildExecution. The same
   * child scheduler therefore owns live drive, restart recovery and subtree interruption.
   */
  public async manualCompressionFromConversation(input: {
    commandId: string;
    childExecutionId: string;
    conversationId: string;
    compressSegmentCount: number;
    target?: CompressionCommandTarget;
    sourceReplay?: 'immutable_provenance';
  }): Promise<ReliableChildManualCompressionResult> {
    const maintenance = this.dependencies.manualCompression;
    if (!maintenance) throw new Error('Child scheduler 缺少手动压缩驱动。');
    const childExecutionId = requireId(input.childExecutionId, 'childExecutionId');
    await this.dependencies.database.conversationOwners.assertOwned(
      requireId(input.conversationId, 'conversationId')
    );
    const replay = await maintenance.inspect({
      commandId: input.commandId,
      conversationId: input.conversationId,
      target: input.target,
      sourceReplay: input.sourceReplay
    });
    if (replay) return replay;
    const started = await maintenance.admit({
      commandId: input.commandId,
      conversationId: input.conversationId,
      compressSegmentCount: input.compressSegmentCount,
      target: input.target,
      sourceReplay: input.sourceReplay,
      childExecution: {
        childExecutionId,
        leaseOwnerId: this.childLeaseOwnerId
      }
    });
    const turnId = requireId(started.turnId, 'Child manual compression Turn.id');
    if (!started.admitted) {
      const concurrentReplay = await maintenance.inspect({
        commandId: input.commandId,
        conversationId: input.conversationId,
        target: input.target,
        sourceReplay: input.sourceReplay
      });
      if (concurrentReplay) return concurrentReplay;
      throw new Error('Child 手动压缩维护 Turn 未取得执行租约。');
    }
    this.launch(childExecutionId, turnId);
    const task = this.activeTurns.get(turnId);
    if (!task) throw new Error('Child 手动压缩维护 Turn 未进入子调度器。');
    const driven = await task;
    if (driven.compression) {
      return {
        turnId,
        deduplicated: started.deduplicated,
        compression: driven.compression
      };
    }
    const terminal = await maintenance.inspect({
      commandId: input.commandId,
      conversationId: input.conversationId,
      target: input.target,
      sourceReplay: input.sourceReplay
    });
    if (!terminal) throw new Error('Child 手动压缩完成后缺少可回放的终态。');
    return { ...terminal, deduplicated: started.deduplicated };
  }

  /** Commits and immediately wakes an interrupt through the scheduler that owns this child Turn. */
  public async interruptFromConversation(input: {
    commandId: string;
    childExecutionId: string;
    conversationId: string;
    turnId: string;
    expectedLeaseGeneration?: string;
    reason: string;
  }): Promise<TurnCommandResult> {
    const childExecutionId = requireId(input.childExecutionId, 'childExecutionId');
    const turnId = requireId(input.turnId, 'turnId');
    await this.dependencies.database.conversationOwners.assertOwned(
      requireId(input.conversationId, 'conversationId')
    );
    const memberships = await this.list('ChildExecutionTurnLink', { turn_id: turnId }, 2);
    if (
      memberships.length !== 1
      || requireId(memberships[0].child_execution_id, 'ChildExecutionTurnLink.child_execution_id') !== childExecutionId
    ) {
      throw new Error('Turn 不属于当前 ChildExecution 谱系。');
    }
    const result = await this.dependencies.turns.interrupt({
      source: { kind: 'command', key: requireId(input.commandId, 'commandId') },
      turnId,
      ...(input.expectedLeaseGeneration
        ? { expectedLeaseGeneration: input.expectedLeaseGeneration }
        : {}),
      reason: input.reason
    });
    this.waitingOwned.delete(turnId);
    await this.cancelLocalChildTurn(turnId, input.reason);
    if (!result.ignoredBecauseTerminal) this.launch(childExecutionId, turnId);
    return result;
  }

  /**
   * Commits one durable recursive ChildExecution interruption and immediately signals every
   * locally-owned Turn in that subtree. The control plane remains the cross-Host authority; the
   * local cancellation step only removes the avoidable wake-poll delay for product/UI commands.
   */
  public async interruptSubtree(
    input: ChildExecutionCancelCommand
  ): Promise<ChildExecutionCancelSubtreeResult> {
    const cancelled = await this.dependencies.children.interruptSubtree({
      sourceKey: requireId(input.sourceKey, 'sourceKey'),
      childExecutionId: requireId(input.childExecutionId, 'childExecutionId'),
      reason: requireText(input.reason, 'reason')
    });
    await Promise.all(cancelled.activeTurnIds.map((turnId) =>
      this.cancelLocalChildTurn(turnId, input.reason)
    ));
    this.dependencies.ownedProcessCleanup?.notify();
    return cancelled;
  }

  /**
   * Converts a next-turn delivery for a completed Child Turn into a durable child-owned intent.
   * The wake may be ACKed once that intent exists because startup recovery owns its admission.
   */
  public async runtimeDeliveryContinuation(input: {
    deliveryId: string;
    childExecutionId: string;
    sourceTurnId: string;
  }): Promise<{ acknowledged: boolean }> {
    if (this.disposing || this.handoff) return { acknowledged: false };
    const childExecutionId = requireId(input.childExecutionId, 'childExecutionId');
    // The delivery wake holds the child Conversation owner pin through this invocation; an
    // internal continuation only ever runs on the existing owner, never on a second Host.
    const child = await this.get('ChildExecution', childExecutionId);
    if (child) {
      await this.dependencies.database.conversationOwners.assertOwned(
        requireId(child.child_conversation_id, 'ChildExecution.child_conversation_id')
      );
    }
    const queued = await this.dependencies.children.queueRuntimeDeliveryContinuation({
      deliveryId: requireId(input.deliveryId, 'deliveryId'),
      childExecutionId,
      sourceTurnId: requireId(input.sourceTurnId, 'sourceTurnId')
    });
    if (!queued) return { acknowledged: false };
    this.triggerRecoveryPass();
    return { acknowledged: true };
  }

  /** Waits for currently launched child Turns and any tasks they launch before returning. */
  public async waitForIdle(): Promise<void> {
    for (;;) {
      const active = [...this.activeTurns.values()];
      if (active.length === 0) return;
      await Promise.allSettled(active);
    }
  }

  /** Stops new launches, aborts per-child Provider dispatches, then drains local Turn tasks. */
  public dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposing = true;
    this.unregisterFinalOutput();
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.waitingOwned.clear();
    this.pendingDriveWakes.clear();
    this.disposePromise = (async () => {
      await this.quiesce(this.handoff ?? new ExecutionHandoffError('Child coordinator is handing off.'));
      await this.waitForRecoveryIdle();
      await this.waitForIdle();
    })();
    return this.disposePromise;
  }

  public async quiesce(reason: ExecutionHandoffError): Promise<void> {
    this.handoff = reason;
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.waitingOwned.clear();
    this.pendingDriveWakes.clear();
    await Promise.allSettled([...this.activeTurns.keys()].map((turnId) =>
      this.dependencies.quiesceTurnExecution
        ? this.dependencies.quiesceTurnExecution({ turnId, reason })
        : this.dependencies.modelProvider.quiesceTurnDispatches(turnId, reason)
    ));
  }

  private async runRecoveryPass(signal?: AbortSignal, conversationId?: string): Promise<ReliableChildAgentRecoveryReport> {
    const report: ReliableChildAgentRecoveryReport = {
      spawnIntentsScanned: 0,
      spawnIntentsReconciled: 0,
      activeTurnsScanned: 0,
      resumedTurnIds: [],
      deferredTurnIds: [],
      continuationsAdmitted: [],
      terminalTurnsReconciled: []
    };
    signal?.throwIfAborted();
    if (this.disposing || this.handoff) return report;
    const scopedChildIds = conversationId === undefined
      ? undefined
      : new Set((await listAllDomainRows(this.dependencies.database, 'ChildExecution', {
          child_conversation_id: conversationId
        })).map((row) => requireId(row.id, 'ChildExecution.id')));
    const inScope = (childExecutionId: string): boolean =>
      scopedChildIds === undefined || scopedChildIds.has(childExecutionId);
    // Explicit recovery may claim unowned children; children another live or unknown owner holds
    // are left to that owner's own passes and stay deferred for the level-triggered takeover edge.
    const gate = new ConversationOwnershipGate(this.dependencies.database, 'claim');
    try {

    // The EffectIntent state and its Attempt state advance monotonically. Read the two live intent
    // states first, then use only live Attempts to close the receipt_written crash boundary. This
    // keeps recovery proportional to unsettled work without treating a repository page as a cap.
    const [
      pendingSpawnIntents,
      dispatchedSpawnIntents,
      pendingAttempts,
      dispatchedAttempts,
      activeLinks
    ] = await Promise.all([
      listAllDomainRows(this.dependencies.database, 'EffectIntent', {
        effect_kind: 'subagent_spawn',
        dispatch_state: 'pending'
      }),
      listAllDomainRows(this.dependencies.database, 'EffectIntent', {
        effect_kind: 'subagent_spawn',
        dispatch_state: 'dispatched'
      }),
      listAllDomainRows(this.dependencies.database, 'Attempt', { status: 'pending' }),
      listAllDomainRows(this.dependencies.database, 'Attempt', { status: 'dispatched' }),
      listAllDomainRows(this.dependencies.database, 'ChildExecutionActiveTurnLink')
    ]);
    const scopedActiveLinks = scopedChildIds === undefined
      ? activeLinks
      : activeLinks.filter((link) => inScope(requireId(
          link.child_execution_id,
          'ChildExecutionActiveTurnLink.child_execution_id'
        )));
    const childConversationCache = new Map<string, string | undefined>();
    const spawnIntentById = new Map<string, DomainRow>();
    for (const intent of [...pendingSpawnIntents, ...dispatchedSpawnIntents]) {
      spawnIntentById.set(requireId(intent.id, 'EffectIntent.id'), intent);
    }
    for (const attempt of [...pendingAttempts, ...dispatchedAttempts]) {
      signal?.throwIfAborted();
      const attemptId = requireId(attempt.id, 'Attempt.id');
      const intents = await this.list('EffectIntent', { attempt_id: attemptId }, 2);
      if (intents.length > 1) throw new Error(`Attempt ${attemptId} has multiple EffectIntents.`);
      const intent = intents[0];
      if (
        intent?.effect_kind === 'subagent_spawn'
        && ['pending', 'dispatched', 'receipt_written'].includes(String(intent.dispatch_state))
      ) {
        spawnIntentById.set(requireId(intent.id, 'EffectIntent.id'), intent);
      }
    }
    // Cancelling a not-yet-dispatched spawn atomically closes the Effect/Attempt before the
    // ChildExecution is terminalized. Recover only that crash gap by walking current active links
    // whose child is still `starting`; do not scan historical cancelled intents.
    for (const link of scopedActiveLinks) {
      signal?.throwIfAborted();
      const childExecutionId = requireId(
        link.child_execution_id,
        'ChildExecutionActiveTurnLink.child_execution_id'
      );
      const child = await this.get('ChildExecution', childExecutionId);
      if (child?.status !== 'starting') continue;
      const operations = await this.list('Operation', {
        owner_kind: 'child_execution',
        owner_id: childExecutionId
      }, 2);
      if (operations.length !== 1) {
        throw new Error(`Starting ChildExecution ${childExecutionId} must retain one spawn Operation.`);
      }
      const attempts = await listAllDomainRows(this.dependencies.database, 'Attempt', {
        operation_id: requireId(operations[0].id, 'Operation.id')
      });
      for (const attempt of attempts) {
        const intents = await this.list('EffectIntent', {
          attempt_id: requireId(attempt.id, 'Attempt.id')
        }, 2);
        if (intents.length > 1) {
          throw new Error(`Attempt ${String(attempt.id)} has multiple EffectIntents.`);
        }
        const intent = intents[0];
        if (
          intent?.effect_kind === 'subagent_spawn'
          && intent.dispatch_state === 'cancelled_before_dispatch'
        ) {
          spawnIntentById.set(requireId(intent.id, 'EffectIntent.id'), intent);
        }
      }
    }
    const spawnIntents = [...spawnIntentById.values()]
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const spawnWork: Array<{ intent: DomainRow; childConversationId: string | undefined }> = [];
    for (const intent of spawnIntents) {
      signal?.throwIfAborted();
      const ownerChildExecutionId = await this.spawnIntentOwner(intent);
      if (ownerChildExecutionId !== undefined && !inScope(ownerChildExecutionId)) continue;
      spawnWork.push({
        intent,
        childConversationId: ownerChildExecutionId === undefined
          ? undefined
          : await this.childConversationFor(ownerChildExecutionId, childConversationCache)
      });
    }
    report.spawnIntentsScanned = spawnWork.length;
    for (const { intent, childConversationId } of spawnWork) {
      signal?.throwIfAborted();
      const before = String(intent.dispatch_state);
      const recovered = childConversationId === undefined
        ? { ran: true as const, value: await this.dependencies.children.recoverSpawnIntent(
            requireId(intent.id, 'EffectIntent.id')
          ) }
        : await gate.run(childConversationId, () => this.dependencies.children.recoverSpawnIntent(
            requireId(intent.id, 'EffectIntent.id')
          ));
      if (!recovered.ran) continue;
      if (before !== recovered.value.dispatchState || recovered.value.shouldDrive) report.spawnIntentsReconciled += 1;
    }

    const interruptingChildren = (await listAllDomainRows(
      this.dependencies.database,
      'ChildExecution',
      { status: 'interrupting' }
    )).filter((child) => inScope(requireId(child.id, 'ChildExecution.id')));
    const activeLinkByChild = new Map(scopedActiveLinks.map((link) => [
      requireId(link.child_execution_id, 'ChildExecutionActiveTurnLink.child_execution_id'),
      link
    ]));
    const membershipById = new Map<string, DomainRow>();
    for (const link of scopedActiveLinks) {
      signal?.throwIfAborted();
      const turnId = requireId(link.turn_id, 'ChildExecutionActiveTurnLink.turn_id');
      const currentMemberships = await this.list('ChildExecutionTurnLink', { turn_id: turnId }, 2);
      if (currentMemberships.length > 1) {
        throw new Error(`Active child Turn ${turnId} has non-unique scheduler membership.`);
      }
      for (const membership of currentMemberships) {
        membershipById.set(requireId(membership.id, 'ChildExecutionTurnLink.id'), membership);
      }
    }
    for (const child of interruptingChildren) {
      signal?.throwIfAborted();
      const childExecutionId = requireId(child.id, 'ChildExecution.id');
      const cancellationMemberships = await listAllDomainRows(
        this.dependencies.database,
        'ChildExecutionTurnLink',
        { child_execution_id: childExecutionId }
      );
      for (const membership of cancellationMemberships) {
        membershipById.set(requireId(membership.id, 'ChildExecutionTurnLink.id'), membership);
      }
    }
    const memberships = [...membershipById.values()]
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const childById = new Map(interruptingChildren.map((child) => [
      requireId(child.id, 'ChildExecution.id'),
      child
    ]));
    const candidateChildIds = new Set(memberships.map((membership) =>
      requireId(membership.child_execution_id, 'ChildExecutionTurnLink.child_execution_id')
    ));
    for (const childExecutionId of [...candidateChildIds].sort()) {
      signal?.throwIfAborted();
      if (childById.has(childExecutionId)) continue;
      const child = await this.get('ChildExecution', childExecutionId);
      if (child) childById.set(childExecutionId, child);
    }
    const turnById = new Map<string, DomainRow>();
    const candidateTurnIds = new Set(memberships.map((membership) =>
      requireId(membership.turn_id, 'ChildExecutionTurnLink.turn_id')
    ));
    for (const turnId of [...candidateTurnIds].sort()) {
      signal?.throwIfAborted();
      const turn = await this.get('Turn', turnId);
      if (turn) turnById.set(turnId, turn);
    }
    for (const membership of memberships) {
      signal?.throwIfAborted();
      const childExecutionId = requireId(membership.child_execution_id, 'ChildExecutionTurnLink.child_execution_id');
      const turnId = requireId(membership.turn_id, 'ChildExecutionTurnLink.turn_id');
      const child = childById.get(childExecutionId);
      if (!child) throw new Error(`ChildExecutionTurnLink references missing ChildExecution ${childExecutionId}.`);
      const cancellationRecovery = child.status === 'interrupting';
      const isActivePointer = activeLinkByChild.get(childExecutionId)?.turn_id === turnId;
      // Immutable membership is historical. Only the mutable active pointer or an unfinished
      // cancellation lineage can require terminal reconciliation; scanning every old child answer
      // here made recovery cost grow quadratically with long conversations.
      if (!isActivePointer && !cancellationRecovery) continue;
      const turn = turnById.get(turnId);
      if (!turn || turn.status !== 'terminated') continue;
      const ran = await gate.run(
        requireId(child.child_conversation_id, 'ChildExecution.child_conversation_id'),
        async () => {
          const snapshot = await this.dependencies.children.readExecutionSnapshot(childExecutionId);
          let terminalReconciled = await this.reconcileTerminalChildTurn(childExecutionId, turnId);
          if (snapshot.activeTurnLink?.turn_id === turnId) {
            await this.dependencies.children.observeTurnTerminal(childExecutionId, turnId);
          }
          if (!terminalReconciled) {
            terminalReconciled = await this.reconcileTerminalChildTurn(childExecutionId, turnId);
          }
          if (cancellationRecovery) {
            await this.dependencies.children.reconcileCancelledLineage(
              childExecutionId,
              `Startup recovery observed terminal child Turn ${turnId}.`
            );
          }
          return { terminalReconciled };
        }
      );
      if (!ran.ran) continue;
      if (ran.value.terminalReconciled) {
        report.terminalTurnsReconciled.push(turnId);
      }
    }

    for (const link of scopedActiveLinks) {
      signal?.throwIfAborted();
      const childExecutionId = requireId(link.child_execution_id, 'ChildExecutionActiveTurnLink.child_execution_id');
      const turnId = requireId(link.turn_id, 'ChildExecutionActiveTurnLink.turn_id');
      const turn = await this.get('Turn', turnId);
      if (!turn || turn.status !== 'active') continue;
      report.activeTurnsScanned += 1;
      if (this.activeTurns.has(turnId)) {
        await this.signalDurableChildCancellation(turnId);
        continue;
      }
      const child = await this.get('ChildExecution', childExecutionId);
      const activeChildConversationId = child
        ? requireId(child.child_conversation_id, 'ChildExecution.child_conversation_id')
        : undefined;
      const recovered = activeChildConversationId === undefined
        ? { ran: true as const, value: await this.recoverActiveChildTurn(childExecutionId, turnId, child) }
        : await gate.run(activeChildConversationId, () =>
            this.recoverActiveChildTurn(childExecutionId, turnId, child));
      if (!recovered.ran) {
        // Another live owner drives this child; keep the level-triggered takeover edge alive.
        report.deferredTurnIds.push(turnId);
        continue;
      }
      if (recovered.value === 'resumed') {
        report.resumedTurnIds.push(turnId);
      } else if (recovered.value === 'terminal') {
        report.terminalTurnsReconciled.push(turnId);
      } else {
        report.deferredTurnIds.push(turnId);
      }
    }

    const pending = (await this.dependencies.children.listPendingContinuations())
      .filter((entry) => inScope(entry.childExecutionId));
    const firstByChild = new Map<string, typeof pending[number]>();
    for (const entry of pending) if (!firstByChild.has(entry.childExecutionId)) firstByChild.set(entry.childExecutionId, entry);
    for (const entry of firstByChild.values()) {
      signal?.throwIfAborted();
      const entryConversationId = await this.childConversationFor(entry.childExecutionId, childConversationCache);
      if (entryConversationId === undefined) continue;
      const admission = await gate.run(entryConversationId, async () => {
        const snapshot = await this.dependencies.children.readExecutionSnapshot(entry.childExecutionId);
        if (['closed', 'needs_human', 'interrupting'].includes(
          String(snapshot.childExecution.status)
        )) return { kind: 'skipped' as const };
        if (snapshot.activeTurn?.status === 'active') {
          return { kind: 'deferred-turn' as const, turnId: requireId(snapshot.activeTurn.id, 'Turn.id') };
        }
        if (snapshot.activeTurn?.status === 'terminated' && snapshot.activeTurnLink) {
          await this.dependencies.children.observeTurnTerminal(
            entry.childExecutionId,
            requireId(snapshot.activeTurn.id, 'Turn.id')
          );
        }
        try {
          const admitted = await this.dependencies.children.admitQueuedIntent({
            sourceKey: `child-continuation-admit:${entry.turnIntentId}`,
            childExecutionId: entry.childExecutionId,
            turnIntentId: entry.turnIntentId,
            leaseOwnerId: this.childLeaseOwnerId,
            leaseExpiresAt: leaseExpiry(this.timestamp(), 0)
          });
          return { kind: 'admitted' as const, admitted };
        } catch (error) {
          // Another Host may still be clearing the previous terminal pointer. Exact admission CAS
          // remains authoritative; the level-triggered pass retries without inventing another Turn.
          const latest = await this.dependencies.children.listPendingContinuations(entry.childExecutionId);
          if (latest.some((candidate) => candidate.turnIntentId === entry.turnIntentId)) {
            return { kind: 'deferred-intent' as const };
          }
          throw error;
        }
      });
      if (!admission.ran) continue;
      if (admission.value.kind === 'admitted') {
        report.continuationsAdmitted.push(admission.value.admitted.turnId);
        this.launch(admission.value.admitted.childExecutionId, admission.value.admitted.turnId);
      } else if (admission.value.kind === 'deferred-turn') {
        if (!report.deferredTurnIds.includes(admission.value.turnId)) {
          report.deferredTurnIds.push(admission.value.turnId);
        }
      } else if (admission.value.kind === 'deferred-intent') {
        report.deferredTurnIds.push(entry.turnIntentId);
      }
    }

    // Answer submission and parent delivery are intentionally separate commits. Reconcile the
    // missing edge while this coordinator is online as well as at startup: a final-answer
    // submission interrupted before its delivery must not strand its already durable answer behind
    // a live-host fence that only the owning coordinator is allowed to cross.
    signal?.throwIfAborted();
    await this.reconcileCommittedAnswers(
      scopedActiveLinks.map((link) => requireId(
        link.child_execution_id,
        'ChildExecutionActiveTurnLink.child_execution_id'
      )),
      signal,
      gate
    );
    signal?.throwIfAborted();

    const outstandingContinuations = (await this.dependencies.children.listPendingContinuations())
      .filter((entry) => inScope(entry.childExecutionId));
    const passNeedsPolling = report.deferredTurnIds.length > 0 || outstandingContinuations.length > 0;
    // A scoped pass must not clear polling another Conversation still needs.
    this.recoveryPollingNeeded = conversationId === undefined
      ? passNeedsPolling
      : this.recoveryPollingNeeded || passNeedsPolling;
    if (this.recoveryPollingNeeded) {
      this.recoveryObservedDataVersion = await this.dependencies.database.externalDataVersion();
      this.recoveryChangeScanAt = Date.now() + CHILD_RECOVERY_CHANGE_SCAN_MS;
      this.recoverySafetyScanAt = Date.now() + CHILD_RECOVERY_SAFETY_SCAN_MS;
    } else {
      this.recoveryObservedDataVersion = undefined;
      this.recoveryChangeScanAt = 0;
      this.recoverySafetyScanAt = 0;
    }
    return report;
    } finally {
      await gate.releaseClaimed();
    }
  }

  /** Recovers one active child Turn; the caller holds the child Conversation ownership pin. */
  private async recoverActiveChildTurn(
    childExecutionId: string,
    turnId: string,
    child: DomainRow | null
  ): Promise<'resumed' | 'deferred' | 'terminal'> {
    if (!child || child.status === 'starting') return 'deferred';
    await this.repairChildModelProfile(childExecutionId, turnId, child);
    if (await this.dependencies.turns.ownsExecutionLease({
      turnId,
      leaseOwnerId: this.childLeaseOwnerId,
      hostBootId: this.dependencies.database.hostBootId
    })) {
      this.launch(childExecutionId, turnId);
      return 'resumed';
    }
    const facts = await this.dependencies.turns.recoveryFacts(turnId);
    if (facts.judgment === 'finalize') {
      await this.dependencies.turns.finalizeRecovery({
        source: { kind: 'recovery', key: `child-driver-finalize:${turnId}` },
        turnId,
        terminalStatus: 'cancelled',
        reason: 'Child scheduler recovered an active Turn without execution authority.'
      });
      await this.dependencies.children.observeTurnTerminal(childExecutionId, turnId);
      await this.reconcileTerminalChildTurn(childExecutionId, turnId);
      return 'terminal';
    }
    if (facts.judgment !== 'resume') return 'deferred';
    const claimed = await this.dependencies.turns.claimRecoveryExecution({
      turnId,
      leaseOwnerId: this.childLeaseOwnerId,
      hostBootId: this.dependencies.database.hostBootId,
      leaseExpiresAt: leaseExpiry(this.timestamp(), 0)
    });
    if (!claimed) return 'deferred';
    this.launch(childExecutionId, turnId);
    return 'resumed';
  }

  /**
   * Repairs the crash boundary between the Runtime spawn transaction and the independent settings
   * transaction. Existing Conversation selection remains authoritative; the inherited thinking
   * strength comes from the parent Turn that spawned this child, as at spawn time. The Turn itself
   * is already frozen, so a record that cannot be written (for example, the user deleted the
   * child's channel meanwhile) is reported and skipped: the child still recovers, and so does
   * every other child in the pass.
   */
  private async repairChildModelProfile(childExecutionId: string, turnId: string, child: DomainRow): Promise<void> {
    const conversationId = requireId(child.child_conversation_id, 'ChildExecution.child_conversation_id');
    if (this.repairedChildModelProfiles.has(conversationId)) return;
    try {
      const [parentLink] = await this.list('ChildExecutionParentLink', { child_execution_id: childExecutionId }, 1);
      const parentTurnId = typeof parentLink?.parent_turn_id === 'string' ? parentLink.parent_turn_id : undefined;
      const inheritedThinkingOverride = parentTurnId ? await this.parentTurnThinkingOverride(parentTurnId) : undefined;
      await this.dependencies.modelProfiles.initializeConversation({
        conversationId,
        model: await this.dependencies.children.frozenModelSelectionForTurn(turnId),
        ...(inheritedThinkingOverride ? { thinkingOverride: inheritedThinkingOverride } : {})
      });
      this.repairedChildModelProfiles.add(conversationId);
    } catch (error) {
      this.reportRecoveryFailureOnce(error, 'recovery-child-model-profile', turnId);
    }
  }

  private parentTurnThinkingOverride(parentTurnId: string): Promise<SessionThinkingOverride | undefined> {
    let read = this.parentTurnThinking.get(parentTurnId);
    if (!read) {
      read = this.dependencies.children.frozenChildThinkingOverrideForTurn(parentTurnId);
      this.parentTurnThinking.set(parentTurnId, read);
      read.catch(() => this.parentTurnThinking.delete(parentTurnId));
    }
    return read;
  }

  private reportRecoveryFailureOnce(error: unknown, operation: string, turnId: string): void {
    const key = `${operation}:${turnId}:${error instanceof Error ? error.message : String(error)}`;
    if (this.reportedRecoveryFailures.has(key)) return;
    this.reportedRecoveryFailures.add(key);
    this.reportError(error, operation, turnId);
  }

  /** Resolves the ChildExecution owning a spawn EffectIntent through its Attempt and Operation. */
  private async spawnIntentOwner(intent: DomainRow): Promise<string | undefined> {
    const attempts = await this.list('Attempt', { id: intent.attempt_id }, 1);
    if (attempts.length !== 1) return undefined;
    const operations = await this.list('Operation', { id: attempts[0].operation_id }, 1);
    if (operations.length !== 1 || operations[0].owner_kind !== 'child_execution') return undefined;
    return requireId(operations[0].owner_id, 'Operation.owner_id');
  }

  private async childConversationFor(
    childExecutionId: string,
    cache: Map<string, string | undefined>
  ): Promise<string | undefined> {
    const cached = cache.get(childExecutionId);
    if (cached !== undefined || cache.has(childExecutionId)) return cached;
    const child = await this.get('ChildExecution', childExecutionId);
    const conversationId = child
      ? requireId(child.child_conversation_id, 'ChildExecution.child_conversation_id')
      : undefined;
    cache.set(childExecutionId, conversationId);
    return conversationId;
  }

  private async parentConversationForChild(
    childExecutionId: string,
    cache: Map<string, string>
  ): Promise<string> {
    const cached = cache.get(childExecutionId);
    if (cached !== undefined) return cached;
    const links = await listAllDomainRows(this.dependencies.database, 'ChildExecutionParentLink', {
      child_execution_id: childExecutionId
    });
    if (links.length !== 1) {
      throw new Error(`ChildExecution ${childExecutionId} must retain exactly one ChildExecutionParentLink.`);
    }
    const parentTurnId = requireId(links[0].parent_turn_id, 'ChildExecutionParentLink.parent_turn_id');
    const parentTurn = await this.get('Turn', parentTurnId);
    if (!parentTurn) throw new Error(`Parent Turn ${parentTurnId} does not exist.`);
    const conversationId = requireId(parentTurn.conversation_id, 'Parent Turn.conversation_id');
    cache.set(childExecutionId, conversationId);
    return conversationId;
  }

  private scheduleConversationCommand(childExecutionId: string, result: TurnCommandResult): void {
    if (result.admitted && result.turnId) {
      this.launch(childExecutionId, result.turnId);
      return;
    }
    this.triggerRecoveryPass();
  }

  private ensureRecoveryPolling(): void {
    if (
      this.disposing
      || this.handoff
      || (!this.recoveryPollingNeeded && this.activeTurns.size === 0 && this.waitingOwned.size === 0)
      || this.recoveryTimer
    ) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      const task = this.pollChildWakes();
      this.recoveryPollTask = task;
      void task.catch((error) => {
        if (this.disposing || this.handoff) return;
        this.reportError(error, 'wake-poll');
        this.triggerRecoveryPass();
      }).finally(() => {
        if (this.recoveryPollTask === task) this.recoveryPollTask = undefined;
      });
    }, CHILD_WAKE_POLL_MS);
    this.recoveryTimer.unref?.();
  }

  private async pollChildWakes(): Promise<void> {
    if (this.disposing || this.handoff || this.recoveryPollInFlight) return;
    this.recoveryPollInFlight = true;
    try {
      for (const turnId of this.activeTurns.keys()) await this.signalDurableChildCancellation(turnId);
      if (this.waitingOwned.size > 0) {
        const version = await this.dependencies.database.externalDataVersion();
        for (const [turnId, waiting] of [...this.waitingOwned]) {
          if (waiting.externalDataVersion === version) continue;
          this.waitingOwned.delete(turnId);
          // A human interaction can arrive after the 30s execution lease expired. Route the
          // level-trigger through resume(), which either launches the still-owned generation or
          // asks recovery to claim a new one. Blindly launching here would reject on the expired
          // fence and permanently lose the only cross-Host wake edge.
          await this.resume(turnId);
        }
      }
      if (this.recoveryPollingNeeded) {
        const version = await this.dependencies.database.externalDataVersion();
        if (
          this.recoveryObservedDataVersion === undefined
          || (version !== this.recoveryObservedDataVersion && Date.now() >= this.recoveryChangeScanAt)
          || Date.now() >= this.recoverySafetyScanAt
        ) await this.recoverStartup();
      }
    } finally {
      this.recoveryPollInFlight = false;
      this.ensureRecoveryPolling();
    }
  }

  /** Database shutdown must not overtake a scan that was already admitted by the wake timer. */
  private async waitForRecoveryIdle(): Promise<void> {
    for (;;) {
      const tasks: Promise<unknown>[] = [];
      if (this.recoveryPollTask) tasks.push(this.recoveryPollTask);
      if (this.recoveryPass) tasks.push(this.recoveryPass);
      if (tasks.length === 0) return;
      await Promise.allSettled(tasks);
    }
  }

  private triggerRecoveryPass(): void {
    if (this.disposing || this.handoff) return;
    this.recoveryPollingNeeded = true;
    this.recoveryObservedDataVersion = undefined;
    this.recoveryChangeScanAt = 0;
    this.recoverySafetyScanAt = 0;
    void this.recoverStartup().catch((error) => this.reportError(error, 'recovery-pass'));
  }

  private async signalDurableChildCancellation(turnId: string): Promise<void> {
    if (this.cancellationSignaled.has(turnId)) return;
    const inputs = await listAllDomainRows(this.dependencies.database, 'PendingTurnInput', {
      turn_id: turnId,
      state: 'pending'
    });
    const request = inputs.find((row) => [
      'interrupt_request',
      'interrupt_current_turn',
      'termination_request'
    ].includes(String(row.input_kind)));
    if (!request) return;
    this.cancellationSignaled.add(turnId);
    try {
      await this.cancelLocalChildTurn(
        turnId,
        `Durable ${String(request.input_kind)} reached the owning child scheduler.`
      );
    } catch (error) {
      this.cancellationSignaled.delete(turnId);
      throw error;
    }
  }

  private async cancelLocalChildTurn(turnId: string, reason: string): Promise<void> {
    const fence = await this.dependencies.turns.executionLeaseFence({
      turnId,
      leaseOwnerId: this.childLeaseOwnerId,
      hostBootId: this.dependencies.database.hostBootId
    });
    if (!fence) return;
    await runWithoutExecutionLeaseFence(() => runWithExecutionLeaseFence(fence, async () => {
      if (this.dependencies.cancelTurnExecution) {
        await this.dependencies.cancelTurnExecution({ turnId, reason });
        return;
      }
      await this.dependencies.modelProvider.cancelTurnDispatches(turnId, reason);
    }));
  }

  private async reconcileTerminalChildTurn(childExecutionId: string, turnId: string): Promise<boolean> {
    const terminations = await this.list('TurnTermination', { turn_id: turnId }, 2);
    if (terminations.length !== 1) {
      throw new Error(`Terminal child Turn ${turnId} must have exactly one TurnTermination.`);
    }
    const terminalStatus = String(terminations[0].terminal_status);
    const reason = typeof terminations[0].reason === 'string' && terminations[0].reason.trim()
      ? terminations[0].reason.trim()
      : `Child Turn ${turnId} terminated with status ${terminalStatus}.`;
    if (terminalStatus === 'failed') {
      const failed = await this.dependencies.answers.reconcileFailedTurn({
        childExecutionId,
        turnId,
        reason
      });
      if (!failed) return false;
      if (failed.disposition.kind === 'delivery_required') {
        await this.deliverBackgroundAnswer(failed.answerBridgeId, failed.inboxItemId);
      } else if (failed.disposition.kind === 'existing') {
        for (const deliveryId of failed.disposition.deliveryIds) this.notifyExistingDelivery(deliveryId);
      }
      return true;
    }
    if (!['interrupted', 'cancelled'].includes(terminalStatus)) return false;
    const inputs = await listAllDomainRows(this.dependencies.database, 'PendingTurnInput', {
      turn_id: turnId,
      input_kind: 'termination_request'
    });
    // `interrupt_current_turn` is a normal continuation handoff. Only the explicit
    // run_agent(mode=interrupt) termination_request may publish an interrupted partial answer.
    const cancellationInput = inputs[0];
    if (!cancellationInput) return false;
    const cancellationReason = typeof terminations[0].reason === 'string' && terminations[0].reason.trim()
      ? terminations[0].reason.trim()
      : `Child Turn ${turnId} was interrupted.`;
    const submitted = await this.dependencies.answers.ensureInterruptedPartial({
      childExecutionId,
      turnId,
      reason: cancellationReason
    });
    if (!submitted) return false;
    const current = await this.dependencies.answers.readCurrent(submitted.answerBridgeId);
    const detail = current.status === 'submitted'
      ? {
          ok: false,
          status: 'interrupted',
          partial: true,
          interrupted: true,
          answerBridgeId: current.answerBridgeId,
          submissionId: current.submissionId,
          title: current.title,
          content: current.content
        }
      : {
          ok: false,
          partial: true,
          interrupted: true,
          answerBridgeId: submitted.answerBridgeId,
          submissionId: submitted.submissionId
        };
    const continuationSettlements = await this.dependencies.children.settleContinuationWaits({
      answerBridgeId: submitted.answerBridgeId,
      sourceTurnId: turnId,
      detail,
      status: 'partial',
      sourceIdentity: `interrupted-answer:${submitted.submissionId}`,
      observedAt: this.timestamp()
    });
    if (!submitted.foregroundSettled && continuationSettlements.length === 0) {
      await this.deliverBackgroundAnswer(submitted.answerBridgeId, submitted.inboxItemId);
    }
    return true;
  }

  private async runAgent(
    input: ReliableAgentToolDispatchInput,
    signal?: AbortSignal,
    authority?: ReliableToolDispatchAuthority,
    admission?: ReliableSpecialToolAdmission
  ): Promise<ChildDispatchResult> {
    const args = requireRecord(input.arguments, 'run_agent arguments');
    const operation = requireText(args.operation, 'run_agent.operation');
    assertRunAgentArguments(operation, args);
    switch (operation) {
      case 'spawn':
        requireText(args.taskName, 'run_agent.taskName');
        return this.spawnChild(input, args, requireText(args.prompt, 'run_agent.prompt'),
          requireWaitMs(args.foregroundWaitMs), authority, signal, admission);
      case 'send':
        if (args.interrupt !== undefined && typeof args.interrupt !== 'boolean') throw new Error('run_agent.interrupt must be a boolean.');
        return this.continueChild(input, requireText(args.answerBridgeId, 'run_agent.answerBridgeId'),
          requireText(args.prompt, 'run_agent.prompt'), requireWaitMs(args.foregroundWaitMs), args.interrupt === true, signal, admission);
      case 'list':
      case 'read':
        return this.inspectChildTasks(input, args, operation);
      case 'wait':
        return this.waitChildTasks(input, args, signal);
      case 'interrupt_subtree':
        return this.interruptChild(input, args);
      default:
        throw new Error(`Unsupported run_agent operation: ${operation}.`);
    }
  }

  private async conversationForCaller(input: ReliableAgentToolDispatchInput): Promise<string> {
    const [turn, call] = await Promise.all([this.get('Turn', input.turnId), this.get('ToolCall', input.toolCallId)]);
    if (!turn || !call || call.turn_id !== input.turnId) {
      throw new Error('Child task access requires a ToolCall owned by the calling Turn.');
    }
    return requireId(turn.conversation_id, 'Calling Turn.conversation_id');
  }

  private async inspectChildTasks(input: ReliableAgentToolDispatchInput,
    args: { [key: string]: PlainJsonValue }, operation: 'list' | 'read'): Promise<ChildDispatchResult> {
    const conversationId = await this.conversationForCaller(input);
    const projection = await this.dependencies.children.readConversationTaskProjection(conversationId);
    const scope = childTaskScope(args.scope);
    const limit = boundedChildTaskInteger(args.limit, 'limit', 32, 1, 100);
    const cursor = args.cursor === undefined ? undefined : requireText(args.cursor, 'run_agent.cursor');
    if (operation === 'list') {
      const result = listConversationChildTasks(projection, { scope, limit,
        ...(args.status === undefined ? {} : { status: requireChildExecutionStatus(args.status, 'run_agent.status') }),
        ...(cursor ? { cursor } : {}) });
      return this.settleOwnTool(input.toolCallId, { ...result, operation }, `run-agent-list:${input.toolCallId}`);
    }
    const task = await this.requireScopedChildTask(projection, requireText(args.answerBridgeId, 'run_agent.answerBridgeId'), scope);
    const result = readConversationChildTask(projection, { childExecutionId: task.childExecutionId, scope, limit,
      ...(cursor ? { cursor } : {}) });
    return this.settleOwnTool(input.toolCallId, { ...result, operation }, `run-agent-read:${input.toolCallId}`);
  }

  private async waitChildTasks(input: ReliableAgentToolDispatchInput,
    args: { [key: string]: PlainJsonValue }, signal?: AbortSignal): Promise<ChildDispatchResult> {
    const conversationId = await this.conversationForCaller(input);
    const scope = childTaskScope(args.scope);
    const timeoutMs = boundedChildTaskInteger(args.timeoutMs, 'timeoutMs', 0, 0, 60_000);
    const bridgeIds = childTaskWaitReferences(args);
    const read = async () => {
      const projection = await this.dependencies.children.readConversationTaskProjection(conversationId);
      return Promise.all(bridgeIds.map(id => this.requireScopedChildTask(projection, id, scope)));
    };
    const initial = await read();
    const initialRevisions = initial.map(task => task.revision).join('\n');
    let observed = initial;
    let changed = false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !childTaskWaitSettled(observed)) {
      await waitForChildTaskObservation(this.dependencies.database, Math.min(500, deadline - Date.now()), signal);
      signal?.throwIfAborted();
      observed = await read();
      changed = observed.map(task => task.revision).join('\n') !== initialRevisions;
      if (changed) break;
    }
    return this.settleOwnTool(input.toolCallId, {
      operation: 'wait',
      answerBridgeIds: bridgeIds,
      changed,
      timedOut: timeoutMs > 0 && !changed && !childTaskWaitSettled(observed),
      tasks: observed.map(childTaskSummary)
    }, `run-agent-wait:${input.toolCallId}`);
  }

  private async scopedSnapshotForBridge(input: ReliableAgentToolDispatchInput,
    answerBridgeId: string, scope: 'direct' | 'tree' = 'direct'): Promise<ChildExecutionSnapshot> {
    const conversationId = await this.conversationForCaller(input);
    const projection = await this.dependencies.children.readConversationTaskProjection(conversationId);
    const task = await this.requireScopedChildTask(projection, answerBridgeId, scope);
    return this.dependencies.children.readExecutionSnapshot(task.childExecutionId);
  }

  private async requireScopedChildTask(projection: ConversationChildTaskProjection, bridgeId: string,
    scope: 'direct' | 'tree'): Promise<ConversationChildTaskRecord> {
    const task = scopedChildTask(projection, bridgeId, scope);
    if (task) return task;
    if (await isForkConversation(this.dependencies.database, projection.conversationId)) {
      const handles = await this.dependencies.children.readConversationChildHandles(projection.conversationId);
      const own = new Set(projection.tasks.map(item => item.answerBridgeId));
      if (forkInheritedChildTargets(handles, own).includes(bridgeId)) {
        throw new Error(`子 Agent ${bridgeId} 属于分支来源对话：本分支只从复制的历史中继承了它的引用，没有继承父子关系，`
          + '因此不能在这里读取、等待、续聊或中断它；需要时请在来源对话中操作，或在本对话新建子 Agent。');
      }
    }
    throw new Error(`Child task ${bridgeId} is outside the caller's ${scope} parent lineage or does not exist.`);
  }

  private async spawnChild(
    input: ReliableAgentToolDispatchInput,
    args: { [key: string]: PlainJsonValue },
    prompt: string,
    foregroundWaitMs: number,
    authority?: ReliableToolDispatchAuthority,
    signal?: AbortSignal,
    admission?: ReliableSpecialToolAdmission
  ): Promise<ChildDispatchResult> {
    const beforeSelection = await this.settleUserAbort(input.toolCallId, signal, 'before-child-selection');
    if (beforeSelection) return beforeSelection;
    await this.authorizeNewChildDepth(input, authority);
    const agentArgs = optionalRecord(args.agent);
    const selection = await this.dependencies.agents.resolve({
      ...(optionalText(agentArgs?.type) ? { agentType: optionalText(agentArgs?.type) } : {})
    });
    const answerBridgeId = stablePhaseFId('answer_bridge', input.toolCallId);
    const beforeSpawn = await this.settleUserAbort(input.toolCallId, signal, 'before-child-spawn');
    if (beforeSpawn) return beforeSpawn;
    const completionPolicy = foregroundWaitMs === 0 ? 'background' as const : 'wait_for_answer' as const;
    const deadline = completionPolicy === 'wait_for_answer'
      ? new Date(Date.parse(this.timestamp()) + foregroundWaitMs).toISOString()
      : undefined;
    const inheritance = childThinkingInheritanceFromAuthority(authority?.document);
    const inheritedThinkingOverride = childThinkingOverrideForSpawn(inheritance);
    const spawned = await this.dependencies.children.spawn({
      sourceToolCallId: input.toolCallId,
      childAgentId: selection.agentId,
      modelFallback: frozenParentModelSelection(authority),
      prompt: promptWithAnswerBridge(prompt),
      forkTurns: normalizeChildForkTurns(args.forkTurns),
      completionPolicy,
      sourceSettlement: 'child_handle',
      ...(deadline ? { waitDeadlineAt: deadline } : {}),
      title: requireText(args.taskName, 'run_agent.taskName').replace(/\s+/g, ' ').slice(0, 120),
      leaseOwnerId: this.childLeaseOwnerId,
      leaseExpiresAt: leaseExpiry(this.timestamp(), foregroundWaitMs)
    });
    await this.dependencies.modelProfiles.initializeConversation({
      conversationId: spawned.childConversationId,
      model: spawned.modelSelection,
      ...(inheritedThinkingOverride ? { thinkingOverride: inheritedThinkingOverride } : {})
    });
    if (spawned.answerBridgeId !== answerBridgeId) {
      throw new Error('ChildExecution returned an unexpected AnswerBridge identity.');
    }
    // ChildExecution/AnswerBridge/spawn intent are now durable. Foreground answer waiting must not
    // retain the scarce child-start slot; cancellation remains attached to the active ToolCall.
    admission?.release();
    const claimed = await this.dependencies.children.claimSpawnDispatch(spawned.effectIntentId);
    if (!claimed) {
      const replay = await this.dependencies.effects.readTerminalResult(input.toolCallId, false);
      if (replay) return replay;
      throw new Error(`subagent_spawn ${spawned.effectIntentId} was already claimed without a terminal Tool result.`);
    }
    const receipt = await this.dependencies.children.recordSpawnReceipt({
      sourceKey: `local-child-spawn:${spawned.attemptId}`,
      attemptId: spawned.attemptId,
      outcome: 'succeeded',
      detail: { adapter: 'reliable-local-agent-loop' }
    });
    await this.dependencies.children.reconcileSpawnReceipt(receipt.effectReceiptId);
    // The spawning Host is the natural first driver of the brand-new child Conversation. Every
    // child fact is already durable, so if the claim fails closed another Host's recovery drives
    // the child and the durable wait below still settles this ToolCall.
    let drivesChild = true;
    try {
      await this.dependencies.database.conversationOwners.claim(spawned.childConversationId);
    } catch (error) {
      console.warn(
        '[reliable-kernel] Fresh child conversation ownership claim failed.',
        spawned.childConversationId,
        error
      );
      drivesChild = false;
    }
    if (drivesChild) this.launch(spawned.childExecutionId, spawned.childTurnId);
    if (completionPolicy === 'background') return this.requireWaitSettlement(input.toolCallId);
    return this.waitInitialForeground(input.toolCallId, spawned.childExecutionId, deadline!, signal);
  }

  private async authorizeNewChildDepth(
    input: ReliableAgentToolDispatchInput,
    authority: ReliableToolDispatchAuthority | undefined
  ): Promise<void> {
    const existingChildren = await this.list('ChildExecutionParentLink', {
      source_tool_call_id: requireId(input.toolCallId, 'toolCallId')
    }, 2);
    if (existingChildren.length > 1) {
      throw new Error(`run_agent ToolCall ${input.toolCallId} has multiple child lineages.`);
    }
    // Re-entering the same durable ToolCall only replays its existing ChildExecution; it does not
    // create another nesting level and therefore must not be rejected by a newly lowered limit.
    if (existingChildren.length === 1) return;

    const maxDepth = maxChildAgentDepthFromConfig(authority?.toolConfig?.config);
    const currentDepth = await childAgentDepthForTurn(this.dependencies.database, input.turnId);
    const requestedDepth = currentDepth + 1;
    if (requestedDepth <= maxDepth) return;
    throw new Error(
      `run_agent 已达到最大子 Agent 层级：当前对话是第 ${currentDepth} 层，`
      + `新建子 Agent 会进入第 ${requestedDepth} 层，但当前上限是 ${maxDepth}。`
    );
  }

  private async continueChild(
    input: ReliableAgentToolDispatchInput,
    answerBridgeId: string,
    prompt: string,
    foregroundWaitMs: number,
    interrupt: boolean,
    signal?: AbortSignal,
    admission?: ReliableSpecialToolAdmission
  ): Promise<ChildDispatchResult> {
    const beforeSend = await this.settleUserAbort(input.toolCallId, signal, 'before-child-continuation', true);
    if (beforeSend) return beforeSend;
    const snapshot = await this.scopedSnapshotForBridge(input, answerBridgeId);
    const activeTurnId = snapshot.activeTurn?.status === 'active'
      ? requireId(snapshot.activeTurn.id, 'Child active Turn.id')
      : undefined;
    const completionPolicy = foregroundWaitMs === 0 ? 'background' as const : 'wait_for_answer' as const;
    const deadline = completionPolicy === 'wait_for_answer'
      ? new Date(Date.parse(this.timestamp()) + foregroundWaitMs).toISOString()
      : undefined;
    const sent = await this.dependencies.children.send({
      sourceKey: `run-agent-continuation:${input.toolCallId}`,
      sourceToolCallId: input.toolCallId,
      childExecutionId: requireId(snapshot.childExecution.id, 'ChildExecution.id'),
      mode: activeTurnId && interrupt ? 'interrupt_current_turn' : 'queue_next_turn',
      content: promptWithAnswerBridge(prompt),
      completionPolicy,
      ...(deadline ? { waitDeadlineAt: deadline } : {})
    });
    // The continuation intent is durable; waiting for/cancelling the prior child Turn is no longer
    // part of child admission and must not block another run_agent startup.
    admission?.release();

    const afterSend = await this.settleUserAbort(input.toolCallId, signal, 'after-child-continuation-queued', true);
    if (afterSend) {
      // The continuation intent is already durable. Its scheduler must keep progressing even
      // though the parent stopped waiting for the answer.
      this.triggerRecoveryPass();
      return afterSend;
    }

    if (activeTurnId && !interrupt) {
      // The current child turn owns execution until its natural boundary. Recovery admits
      // this durable continuation afterwards; do not cancel it or admit a competing turn.
      this.triggerRecoveryPass();
      if (completionPolicy === 'background') return this.requireWaitSettlement(input.toolCallId);
      return this.waitContinuationForeground(input.toolCallId, answerBridgeId,
        childContinuationTurnId(requireId(snapshot.childExecution.id, 'ChildExecution.id'), sent.turnIntentId), deadline!, signal);
    }
    if (activeTurnId) {
      await this.cancelLocalChildTurn(
        activeTurnId,
        'run_agent continuation interrupted current child Turn'
      );
      if (completionPolicy === 'background') {
        this.triggerRecoveryPass();
        return this.requireWaitSettlement(input.toolCallId);
      }
      const waitState = await this.awaitTurnTask(activeTurnId, signal, deadline);
      if (waitState !== 'terminated') {
        this.triggerRecoveryPass();
        if (waitState === 'aborted') {
          const aborted = await this.settleUserAbort(
            input.toolCallId,
            signal,
            'child-continuation-waiting-for-prior-turn',
            true
          );
          if (aborted) return aborted;
        }
        await this.dependencies.children.settleContinuationWaits({
          answerBridgeId,
          toolCallId: input.toolCallId,
          detail: { timeout: true },
          sourceIdentity: `foreground-timeout:${input.toolCallId}:${deadline}`,
          observedAt: this.timestamp()
        });
        return this.requireWaitSettlement(input.toolCallId);
      }
      const latest = await this.dependencies.children.readExecutionSnapshot(
        requireId(snapshot.childExecution.id, 'ChildExecution.id')
      );
      if (latest.activeTurn?.id === activeTurnId && latest.activeTurn.status === 'terminated') {
        await this.dependencies.children.observeTurnTerminal(
          requireId(snapshot.childExecution.id, 'ChildExecution.id'),
          activeTurnId
        );
      }
    }

    // Only the child Conversation's owner admits and drives its queued intents. The intent is
    // durable either way: a foreign owner's level-triggered recovery admits it there, while our
    // foreground/background wait simply observes the durable outcome.
    const childConversationId = requireId(
      snapshot.childExecution.child_conversation_id,
      'ChildExecution.child_conversation_id'
    );
    const owners = this.dependencies.database.conversationOwners;
    let drivesChild = owners.owns(childConversationId);
    if (!drivesChild) {
      try {
        drivesChild = await owners.tryClaim(childConversationId);
      } catch (error) {
        if (!isConversationRuntimeOwnerBusyError(error)) {
          console.warn('[reliable-kernel] Child conversation ownership claim failed closed.', childConversationId, error);
        }
        drivesChild = false;
      }
    }
    if (drivesChild) {
      try {
        const admitted = await this.dependencies.children.admitQueuedIntent({
          sourceKey: `child-continuation-admit:${sent.turnIntentId}`,
          childExecutionId: requireId(snapshot.childExecution.id, 'ChildExecution.id'),
          turnIntentId: sent.turnIntentId,
          leaseOwnerId: this.childLeaseOwnerId,
          leaseExpiresAt: leaseExpiry(this.timestamp(), foregroundWaitMs)
        });
        this.launch(admitted.childExecutionId, admitted.turnId);
      } catch (error) {
        if (!(error instanceof CollaborationCapacityError) && !(error instanceof CollaborationMembershipChangedError) && !isTransactionAssertionFailure(error)) throw error;
        // The continuation is already durable. Capacity contention defers admission; it must
        // never turn a successful submission into a failed or duplicate assignment.
        this.triggerRecoveryPass();
      }
    }
    if (completionPolicy === 'background') return this.requireWaitSettlement(input.toolCallId);
    return this.waitContinuationForeground(
      input.toolCallId,
      answerBridgeId,
      // Admission is deterministic: whichever owner admits the intent produces this exact Turn.
      childContinuationTurnId(requireId(snapshot.childExecution.id, 'ChildExecution.id'), sent.turnIntentId),
      deadline!,
      signal
    );
  }

  private async interruptChild(
    input: ReliableAgentToolDispatchInput,
    args: { [key: string]: PlainJsonValue }
  ): Promise<ChildDispatchResult> {
    const answerBridgeId = requireText(args.answerBridgeId, 'run_agent.answerBridgeId');
    const snapshot = await this.scopedSnapshotForBridge(input, answerBridgeId);
    const cancelled = await this.interruptSubtree({
      sourceKey: `run-agent-interrupt:${input.toolCallId}`,
      childExecutionId: requireId(snapshot.childExecution.id, 'ChildExecution.id'),
      reason: 'run_agent interrupt_subtree requested'
    });
    return this.settleOwnTool(input.toolCallId, {
      ok: true,
      status: 'interrupt_committed',
      answerBridgeId,
      childExecutionId: cancelled.rootChildExecutionId,
      activeTurnIds: cancelled.activeTurnIds,
      cancelledIntentIds: cancelled.cancelledIntentIds
    }, `run-agent-interrupt:${input.toolCallId}`);
  }

  /**
   * The final output of a child task Turn becomes the answer on its AnswerBridge: it settles a
   * waiting run_agent call or is delivered to the parent. A peer's followup taken in by that Turn
   * is answered through its own collaboration reply as well; a Turn a peer's followup started answers
   * only that peer, and a Turn the user started answers only the user. Runs before the Turn is
   * recorded completed, so the active-generation authority of the submission still holds.
   */
  private async submitTurnFinalAnswer(input: { turnId: string; modelRequestId: string; finalText: string }): Promise<void> {
    const memberships = await this.list('ChildExecutionTurnLink', { turn_id: input.turnId }, 2);
    if (memberships.length !== 1) return;
    if (!await this.dependencies.answers.isChildTaskTurn(input.turnId)) return;
    const childExecutionId = requireId(memberships[0].child_execution_id, 'ChildExecutionTurnLink.child_execution_id');
    const bridges = await this.list('AnswerBridge', { child_execution_id: childExecutionId }, 2);
    if (bridges.length !== 1) return;
    // A child being interrupted or closed answers through its interruption path, if at all; its
    // otherwise normal completion must not turn into a failed Turn over a refused submission.
    const child = await this.get('ChildExecution', childExecutionId);
    if (child?.status !== 'active' || !['open', 'submitted'].includes(String(bridges[0].status))) return;
    const answerBridgeId = requireId(bridges[0].id, 'AnswerBridge.id');
    const content = input.finalText.trim() || '（子 Agent 本轮结束时没有输出文字。）';
    const submissionId = stablePhaseFId('answer_submission', 'turn-final-output', input.turnId, input.modelRequestId, answerBridgeId);
    const submitted = await this.dependencies.answers.submit({
      answerBridgeId,
      submissionId,
      sourceTurnId: input.turnId,
      title: finalAnswerTitle(content),
      content,
      contentType: 'text/plain'
    });
    if (submitted.historicalReplay) return;
    const waits = await this.dependencies.answers.reconcileCommittedWaits(submissionId);
    if (!waits.settledByAnswer) await this.deliverBackgroundAnswer(answerBridgeId, submitted.inboxItemId);
  }

  private async readAnswer(input: ReliableAgentToolDispatchInput): Promise<ChildDispatchResult> {
    const args = requireRecord(input.arguments, 'read_agent_answer arguments');
    const answerBridgeId = requireText(args.answerBridgeId, 'read_agent_answer.answerBridgeId');
    await this.scopedSnapshotForBridge(input, answerBridgeId, childTaskScope(args.scope));
    const answer = await this.dependencies.answers.readCurrent(answerBridgeId);
    const detail = answer.status === 'submitted'
      ? answer.interrupted
        ? {
            ok: false,
            status: 'interrupted',
            partial: true,
            answerBridgeId,
            title: answer.title,
            content: answer.content,
            submissionId: answer.submissionId,
            interrupted: true
          }
        : {
            ok: true,
            answerBridgeId,
            title: answer.title,
            content: answer.content,
            submissionId: answer.submissionId,
            interrupted: false
          }
      : answer.status === 'failed'
        ? {
            ok: false,
            status: 'failed',
            error: answer.content,
            answerBridgeId,
            title: answer.title,
            content: answer.content,
            submissionId: answer.submissionId
          }
        : answer.status === 'running'
          ? { ok: false, status: 'running', error: '对应子 Agent 仍在运行，尚未提交回答。', answerBridgeId }
          : answer.status === 'interrupted'
            ? { ok: false, status: 'interrupted', error: '对应子 Agent 当前没有活动 Turn，也没有已提交回答。', answerBridgeId }
            : { ok: false, status: 'not_found', error: '未找到对应的 AnswerBridge。', answerBridgeId };
    return this.settleOwnTool(input.toolCallId, detail, `read-agent-answer:${input.toolCallId}`);
  }

  private launch(childExecutionId: string, turnId: string): void {
    if (this.disposing) throw new Error('ReliableChildAgentCoordinator is disposing.');
    if (this.activeTurns.has(turnId)) {
      // Do not collapse an edge-triggered interaction/delivery wake into the currently executing
      // drive. The active drive may already have passed the corresponding durable read and be about
      // to publish `waiting`; consume this level-trigger immediately after its cleanup instead.
      this.pendingDriveWakes.add(turnId);
      return;
    }
    this.pendingDriveWakes.delete(turnId);
    this.waitingOwned.delete(turnId);
    const task = runWithoutExecutionLeaseFence(() => this.driveChild(childExecutionId, turnId));
    let handoff = false;
    let terminalStatus: ReliableChildDriveResult['terminalStatus'] | undefined;
    this.activeTurns.set(turnId, task);
    this.ensureRecoveryPolling();
    void task.then((result) => {
      terminalStatus = result.terminalStatus;
    }, (error) => {
      if (this.disposing || this.handoff) return;
      if (isExecutionHandoffError(error)) {
        handoff = true;
        return;
      }
      // Another live owner claimed the child Conversation between recovery and launch; its own
      // coordinator drives the Turn, so there is nothing local to report or recover.
      if (isConversationRuntimeOwnerBusyError(error)) return;
      this.reportError(error, 'drive-child-terminalization', turnId);
    }).finally(() => {
      if (this.activeTurns.get(turnId) === task) this.activeTurns.delete(turnId);
      this.cancellationSignaled.delete(turnId);
      const pendingWake = this.pendingDriveWakes.delete(turnId);
      const recover = handoff || this.recoveryAfterDrive.delete(turnId);
      if (recover && !this.disposing && !this.handoff) {
        // Lease loss/handoff has priority over a local wake. Recovery must establish the next
        // immutable execution fence before any replacement drive starts.
        this.triggerRecoveryPass();
      } else if (
        pendingWake
        && terminalStatus === 'waiting'
        && !this.disposing
        && !this.handoff
      ) {
        this.launch(childExecutionId, turnId);
      } else {
        this.ensureRecoveryPolling();
      }
    });
  }

  private async driveChild(childExecutionId: string, turnId: string): Promise<ReliableChildDriveResult> {
    const child = await this.get('ChildExecution', childExecutionId);
    if (!child) throw new Error(`ChildExecution ${childExecutionId} does not exist.`);
    // The child Conversation's owner drives it. The activity pin holds ownership for the whole
    // drive and releases-if-idle afterwards, so ownership follows real work across Hosts.
    return this.dependencies.database.conversationOwners.run(
      requireId(child.child_conversation_id, 'ChildExecution.child_conversation_id'),
      () => this.driveChildOwned(childExecutionId, turnId)
    );
  }

  private async driveChildOwned(childExecutionId: string, turnId: string): Promise<ReliableChildDriveResult> {
    const fence = await this.readChildExecutionFence(turnId);
    const renewal = this.startChildLeaseRenewal(fence);
    const externalVersionBeforeDrive = await this.dependencies.database.externalDataVersion();
    let result: ReliableChildDriveResult;
    try {
      result = await runWithExecutionLeaseFence(fence, async () => {
        if (this.dependencies.manualCompression) {
          const turn = await this.get('Turn', turnId);
          if (!turn) throw new Error(`Child Turn ${turnId} does not exist.`);
          const maintenance = await this.dependencies.manualCompression.driveIfPresent({
            conversationId: requireId(turn.conversation_id, 'Child Turn.conversation_id'),
            turnId
          });
          if (maintenance) {
            return {
              turnId,
              terminalStatus: maintenance.terminalStatus,
              modelRequestIds: [],
              assistantMessageIds: [],
              toolCallIds: [],
              ...(maintenance.compression ? { compression: maintenance.compression } : {})
            };
          }
        }
        return this.dependencies.agentLoop.drive(turnId);
      });
    } catch (error) {
      if (isExecutionHandoffError(error)) throw error;
      result = await this.failChildDrive(fence, childExecutionId, turnId, error);
    } finally {
      await renewal.stop();
    }
    if (result.terminalStatus === 'waiting') {
      const externalVersionAfterDrive = await this.dependencies.database.externalDataVersion();
      // Publish the waiting slot even when an external commit raced the drive. Keeping the older
      // version makes the next targeted poll level-trigger the Turn *after* activeTurns cleanup.
      // A shared boolean recovery flag could be overwritten by a concurrent recovery pass and
      // strand the child forever at this exact boundary.
      this.waitingOwned.set(turnId, {
        childExecutionId,
        externalDataVersion: externalVersionAfterDrive === externalVersionBeforeDrive
          ? externalVersionAfterDrive
          : externalVersionBeforeDrive
      });
    } else {
      this.waitingOwned.delete(turnId);
      const snapshot = await this.dependencies.children.readExecutionSnapshot(childExecutionId);
      const cancellationRecovery = snapshot.childExecution.status === 'interrupting';
      if (result.terminalStatus === 'failed') {
        await this.reconcileTerminalChildTurn(childExecutionId, turnId);
      }
      if (snapshot.activeTurn?.id === turnId && snapshot.activeTurn.status === 'terminated') {
        await this.dependencies.children.observeTurnTerminal(childExecutionId, turnId);
      }
      if (result.terminalStatus !== 'failed') {
        await this.reconcileTerminalChildTurn(childExecutionId, turnId);
      }
      if (cancellationRecovery) {
        await this.dependencies.children.reconcileCancelledLineage(
          childExecutionId,
          `Child Turn ${turnId} reached terminal state after cancellation.`
        );
      }
      this.triggerRecoveryPass();
    }
    return result;
  }

  private async failChildDrive(
    fence: ExecutionLeaseFence,
    childExecutionId: string,
    turnId: string,
    error: unknown
  ): Promise<ReliableChildDriveResult> {
    const reason = error instanceof Error ? error.message : String(error);
    this.reportError(error, 'drive-child', turnId);
    await runWithExecutionLeaseFence(fence, () => this.dependencies.turns.terminal({
      source: { kind: 'internal', key: `child-drive-terminal:${childExecutionId}:${turnId}` },
      turnId,
      terminalStatus: 'failed',
      reason
    }));
    return {
      turnId,
      terminalStatus: 'failed',
      modelRequestIds: [],
      assistantMessageIds: [],
      toolCallIds: []
    };
  }

  private async readChildExecutionFence(turnId: string): Promise<ExecutionLeaseFence> {
    const fence = await this.dependencies.turns.executionLeaseFence({
      turnId,
      leaseOwnerId: this.childLeaseOwnerId,
      hostBootId: this.dependencies.database.hostBootId
    });
    if (!fence) throw new ExecutionHandoffError(`Child Turn ${turnId} is not owned by this child scheduler.`);
    return fence;
  }

  private startChildLeaseRenewal(fence: ExecutionLeaseFence): { stop(): Promise<void> } {
    let stopped = false;
    let task = Promise.resolve();
    const timer = setInterval(() => {
      task = task.then(async () => {
        if (stopped || this.handoff) return;
        try {
          const renewed = await this.dependencies.turns.renewExecutionLease({
            fence,
            leaseExpiresAt: new Date(Date.now() + 30_000).toISOString()
          });
          if (!renewed) throw new ExecutionHandoffError(
            `Child Turn ${fence.turnId} lost its ExecutionLease generation.`
          );
        } catch (error) {
          stopped = true;
          clearInterval(timer);
          const handoff = new ExecutionHandoffError(`Child Turn ${fence.turnId} lost its ExecutionLease generation.`);
          this.recoveryAfterDrive.add(fence.turnId);
          if (!isExecutionHandoffError(error)) {
            this.reportError(error, 'renew-child-lease', fence.turnId);
          }
          try {
            if (this.dependencies.quiesceTurnExecution) {
              await this.dependencies.quiesceTurnExecution({ turnId: fence.turnId, reason: handoff });
            } else {
              await this.dependencies.modelProvider.quiesceTurnDispatches(fence.turnId, handoff);
            }
          } catch (quiesceError) {
            this.reportError(quiesceError, 'quiesce-child-after-lease-loss', fence.turnId);
          }
        }
      });
    }, 10_000);
    timer.unref();
    return {
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await task;
      }
    };
  }

  private async awaitTurnTask(
    turnId: string,
    signal?: AbortSignal,
    deadline?: string
  ): Promise<'terminated' | 'aborted' | 'deadline'> {
    const deadlineMs = deadline === undefined ? undefined : Date.parse(deadline);
    for (;;) {
      if (signal?.aborted) return 'aborted';
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) return 'deadline';
      const task = this.activeTurns.get(turnId);
      if (task) {
        const completed = await Promise.race([
          task.then(() => true),
          delay(25).then(() => false)
        ]);
        if (completed) return 'terminated';
        continue;
      }
      const turn = await this.get('Turn', turnId);
      if (!turn || turn.status === 'terminated') return 'terminated';
      await delay(25);
    }
  }

  private async waitInitialForeground(
    toolCallId: string,
    childExecutionId: string,
    deadline: string,
    signal?: AbortSignal
  ): Promise<ChildDispatchResult> {
    for (;;) {
      if (this.handoff) throw this.handoff;
      const aborted = await this.settleUserAbort(toolCallId, signal, 'child-foreground-wait', true);
      if (aborted) return aborted;
      const settled = await this.dependencies.children.finalizeWaitSettlement(toolCallId);
      if (settled) return this.childWaitResult(settled);
      const remaining = Date.parse(deadline) - Date.now();
      if (remaining <= 0) break;
      const snapshot = await this.dependencies.children.wait(
        childExecutionId,
        Math.min(remaining, signal ? 50 : 1_000)
      );
      if (snapshot.currentSubmission) continue;
      if (!snapshot.activeTurn || snapshot.activeTurn.status === 'terminated') {
        await delay(Math.min(50, remaining));
      }
    }
    await this.dependencies.children.settleForegroundTimeout(childExecutionId, this.timestamp());
    return this.requireWaitSettlement(toolCallId);
  }

  private async waitContinuationForeground(
    toolCallId: string,
    answerBridgeId: string,
    sourceTurnId: string,
    deadline: string,
    signal?: AbortSignal
  ): Promise<ChildDispatchResult> {
    for (;;) {
      if (this.handoff) throw this.handoff;
      const aborted = await this.settleUserAbort(toolCallId, signal, 'child-continuation-foreground-wait', true);
      if (aborted) return aborted;
      const settled = await this.dependencies.children.finalizeWaitSettlement(toolCallId);
      if (settled) return this.childWaitResult(settled);
      const remaining = Date.parse(deadline) - Date.now();
      if (remaining <= 0) break;
      await delay(Math.min(50, remaining));
    }
    await this.dependencies.children.settleContinuationWaits({
      answerBridgeId,
      sourceTurnId,
      toolCallId,
      detail: { timeout: true },
      sourceIdentity: `foreground-timeout:${toolCallId}:${deadline}`,
      observedAt: this.timestamp()
    });
    return this.requireWaitSettlement(toolCallId);
  }

  private async deliverBackgroundAnswer(answerBridgeId: string, inboxItemId: string): Promise<void> {
    const snapshot = await this.snapshotForBridge(answerBridgeId);
    const parentTurnId = requireId(snapshot.parentLink.parent_turn_id, 'ChildExecutionParentLink.parent_turn_id');
    const parentTurn = await this.get('Turn', parentTurnId);
    if (!parentTurn) throw new Error(`Parent Turn ${parentTurnId} no longer exists for answer delivery.`);
    const targetConversationId = requireId(parentTurn.conversation_id, 'Parent Turn.conversation_id');
    const delivery = await this.dependencies.deliveries.createAutomatic({
      inboxItemId,
      targetConversationId,
      sourceTurnId: parentTurnId
    });
    const deliveryId = requireId(delivery.delivery.id, 'RuntimeDelivery.id');
    if (this.dependencies.deliveryWakeups) {
      this.dependencies.deliveryWakeups.notifyRuntimeDelivery(deliveryId);
      return;
    }
    // Isolated control-plane tests may omit the product scheduler. Production always supplies the
    // durable wake outbox; this direct advancement keeps the domain fixture self-contained. The
    // fallback is not an authorization to mutate a foreign Conversation: a live/unknown owner
    // keeps the durable delivery pending and advances it through its own scheduler instead.
    if (delivery.delivery.phase !== 'notify_only') {
      const owners = this.dependencies.database.conversationOwners;
      let targetOwned = owners.owns(targetConversationId);
      if (!targetOwned) {
        try {
          targetOwned = await owners.tryClaim(targetConversationId);
        } catch (error) {
          if (!isConversationRuntimeOwnerBusyError(error)) {
            console.warn(
              '[reliable-kernel] Delivery target conversation ownership claim failed closed.',
              targetConversationId,
              error
            );
          }
          targetOwned = false;
        }
      }
      if (targetOwned) {
        await owners.run(targetConversationId, () => this.dependencies.deliveries.advance(deliveryId));
      }
    }
    // notify_only remains pending until the product notification scheduler performs the real wake
    // and explicitly acknowledges it. A control-plane recovery pass is not that consumer.
  }

  private async reconcileCommittedAnswers(
    activeChildExecutionIds: readonly string[],
    signal: AbortSignal | undefined,
    gate: ConversationOwnershipGate
  ): Promise<void> {
    const currentSubmissionById = new Map<string, DomainRow>();
    const childBySubmissionId = new Map<string, string>();
    for (const childExecutionId of uniqueStrings(activeChildExecutionIds).sort()) {
      signal?.throwIfAborted();
      const bridges = await this.list('AnswerBridge', { child_execution_id: childExecutionId }, 2);
      if (bridges.length > 1) {
        throw new Error(`ChildExecution ${childExecutionId} has multiple AnswerBridges.`);
      }
      const bridge = bridges[0];
      if (!bridge || bridge.current_submission_id === null) continue;
      const submissionId = requireId(bridge.current_submission_id, 'AnswerBridge.current_submission_id');
      const submission = await this.get('AnswerSubmission', submissionId);
      if (!submission) throw new Error(`AnswerBridge references missing AnswerSubmission ${submissionId}.`);
      currentSubmissionById.set(submissionId, submission);
      childBySubmissionId.set(submissionId, childExecutionId);
    }
    const submissions = [...currentSubmissionById.values()]
      .sort((left, right) => String(left.answer_bridge_id).localeCompare(String(right.answer_bridge_id))
        || compareCounter(left.submission_seq, right.submission_seq));
    const parentConversationCache = new Map<string, string>();
    for (const submission of submissions) {
      signal?.throwIfAborted();
      const submissionId = requireId(submission.id, 'AnswerSubmission.id');
      // Wait settlements and delivery routing mutate the parent Conversation; only its owner may
      // cross that edge. A foreign parent's durable answer waits for its own coordinator pass.
      const parentConversationId = await this.parentConversationForChild(
        childBySubmissionId.get(submissionId)!,
        parentConversationCache
      );
      const ran = await gate.run(parentConversationId, async () => {
        const sourceTurnId = requireId(submission.turn_id, 'AnswerSubmission.turn_id');
        let disposition = await this.dependencies.answers.classifyDeliveryRecovery(submissionId);
        if (disposition.kind === 'existing') {
          for (const deliveryId of disposition.deliveryIds) this.notifyExistingDelivery(deliveryId);
          return;
        }
        const liveSourceTurnId = await this.dependencies.answers.liveSourceTurnForRecovery(
          submissionId
        );
        const locallyOwned = liveSourceTurnId !== null && await this.dependencies.turns.ownsExecutionLease({
          turnId: sourceTurnId,
          leaseOwnerId: this.childLeaseOwnerId,
          hostBootId: this.dependencies.database.hostBootId
        });
        if (liveSourceTurnId !== null && !locallyOwned) return;
        if (disposition.kind === 'settled_by_answer') {
          await this.dependencies.answers.reconcileCommittedWaits(submissionId);
          return;
        }
        if (disposition.kind === 'deferred_live_owner' && !locallyOwned) return;

        const waits = await this.dependencies.answers.reconcileCommittedWaits(submissionId);
        disposition = await this.dependencies.answers.classifyDeliveryRecovery(submissionId);
        if (disposition.kind === 'settled_by_answer') return;
        if (disposition.kind === 'existing') {
          for (const deliveryId of disposition.deliveryIds) this.notifyExistingDelivery(deliveryId);
          return;
        }
        if (disposition.kind === 'delivery_required') {
          await this.deliverBackgroundAnswer(waits.answerBridgeId, waits.inboxItemId);
          return;
        }

        // classifyDeliveryRecovery deliberately defers every live source owner to avoid a second Host
        // racing the in-process callback. This exact coordinator proved the current child lease above,
        // so after replaying all waits it is the one safe writer for the remaining background edge.
        if (await this.dependencies.turns.ownsExecutionLease({
          turnId: sourceTurnId,
          leaseOwnerId: this.childLeaseOwnerId,
          hostBootId: this.dependencies.database.hostBootId
        })) {
          await this.deliverBackgroundAnswer(waits.answerBridgeId, waits.inboxItemId);
        }
      });
      if (!ran.ran) continue;
    }
  }

  private notifyExistingDelivery(deliveryId: string): void {
    this.dependencies.deliveryWakeups?.notifyRuntimeDelivery(deliveryId);
  }

  private async snapshotForBridge(answerBridgeId: string): Promise<ChildExecutionSnapshot> {
    const bridge = await this.get('AnswerBridge', requireId(answerBridgeId, 'answerBridgeId'));
    if (!bridge) throw new Error(`未找到 answerBridgeId：${answerBridgeId}`);
    return this.dependencies.children.readExecutionSnapshot(
      requireId(bridge.child_execution_id, 'AnswerBridge.child_execution_id')
    );
  }

  private async settleOwnTool(toolCallId: string, detail: unknown, sourceKey: string): Promise<ChildDispatchResult> {
    const settled = await this.dependencies.effects.settleWithoutEffect({
      source: { kind: 'internal', key: sourceKey },
      toolCallId,
      status: 'succeeded',
      detail
    });
    return settled.terminal ?? {
      disposition: 'settled',
      toolCallId,
      status: settled.status
    };
  }

  private async settleUserAbort(
    toolCallIdInput: string,
    signal: AbortSignal | undefined,
    scope: string,
    childContinuesInBackground = false
  ): Promise<ChildDispatchResult | undefined> {
    if (!signal?.aborted) return undefined;
    const toolCallId = requireId(toolCallIdInput, 'toolCallId');
    if (isExecutionHandoffError(signal.reason)) throw signal.reason;
    const reason = abortReason(signal.reason);
    await this.dependencies.children.cancelForegroundWaitForToolCall({
      toolCallId,
      reason,
      sourceIdentity: `user-abort:${toolCallId}`
    });
    const existing = await this.dependencies.children.finalizeWaitSettlement(toolCallId);
    if (existing) return this.childWaitResult(existing);
    const settled = await this.dependencies.effects.settleWithoutEffect({
      source: { kind: 'internal', key: `child-parent-abort:${toolCallId}` },
      toolCallId,
      status: 'cancelled',
      detail: {
        reason,
        scope,
        childExecutionContinuesInBackground: childContinuesInBackground
      }
    });
    return settled.terminal ?? {
      disposition: 'settled',
      toolCallId,
      status: settled.status
    };
  }

  private async requireWaitSettlement(toolCallId: string): Promise<ChildDispatchResult> {
    const settled = await this.dependencies.children.finalizeWaitSettlement(toolCallId);
    if (!settled) throw new Error(`ToolCall ${toolCallId} has no durable child wait settlement.`);
    return this.childWaitResult(settled);
  }

  private childWaitResult(settled: {
    toolCallId: string;
    status: ReliableAgentToolSettled['status'];
    terminal?: ToolTerminalResult;
  }): ChildDispatchResult {
    return settled.terminal ?? {
      disposition: 'settled',
      toolCallId: settled.toolCallId,
      status: settled.status
    };
  }

  private async get(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.dependencies.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return snapshot.snapshot[0] as DomainRow | null;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.dependencies.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    if (!Array.isArray(snapshot.snapshot[0])) throw new TypeError(`${domain} list did not return rows.`);
    return snapshot.snapshot[0];
  }

  private timestamp(): string {
    const value = this.now();
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError('Coordinator clock must return ISO time.');
    return value;
  }

  private reportError(error: unknown, operation: string, turnId?: string): void {
    console.error('[LimCode] Reliable child Agent coordinator failed.', {
      operation,
      ...(turnId ? { turnId } : {})
    }, error);
  }

}

function frozenParentModelSelection(
  authority: ReliableToolDispatchAuthority | undefined
): TurnModelOverride {
  if (!authority) throw new Error('run_agent child spawn requires the parent Turn frozen authority.');
  return frozenModelSelection(authority.document);
}

function promptWithAnswerBridge(prompt: string): string {
  return `${prompt}\n\n[Agent answer]\n完成任务后直接写出最终回复：本轮最后一条回复会自动作为结果交给派发任务的 Agent，不需要调用工具提交。中途需要告知进展或提问时用 send_agent_message，向已有同伴续派任务用 followup_agent_task。`;
}

/** A short title for a final answer: its first non-empty line, bounded. */
function finalAnswerTitle(content: string): string {
  const firstLine = content.split('\n').map((line) => line.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) ?? '';
  const title = firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
  return title || '子 Agent 最终结果';
}

function assertExpectedPlanDelegation(
  actual: PlanDelegationResult,
  expected: PlanDelegationEnsureRequest['expected']
): void {
  for (const key of [
    'childExecutionId',
    'childConversationId',
    'answerBridgeId',
    'agentId',
    'agentType'
  ] as const) {
    if (actual[key] !== requireId(expected[key], `Plan delegation expected ${key}`)) {
      throw new Error(`Approved Plan delegation intent does not match stable ${key}.`);
    }
  }
}

function leaseExpiry(now: string, foregroundWaitMs: number): string {
  void foregroundWaitMs;
  return new Date(Date.parse(now) + 30_000).toISOString();
}

function requireWaitMs(value: PlainJsonValue | undefined): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 86_400_000) {
    throw new TypeError('run_agent.foregroundWaitMs 省略时默认为 0；传入时必须是 0 到 86400000 的整数毫秒数。');
  }
  return value;
}

function requireRecord(value: PlainJsonValue | undefined, label: string): { [key: string]: PlainJsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function optionalRecord(value: PlainJsonValue | undefined): { [key: string]: PlainJsonValue } | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function requireText(value: PlainJsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function optionalText(value: PlainJsonValue | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function assertRunAgentArguments(operation: string, args: { [key: string]: PlainJsonValue }): void {
  if (!(RUN_AGENT_OPERATIONS as readonly string[]).includes(operation)) {
    throw new Error(`Unsupported run_agent operation: ${operation}.`);
  }
  const fields: Record<string, readonly string[]> = {
    spawn: ['taskName', 'prompt', 'agent', 'foregroundWaitMs', 'forkTurns'],
    send: ['answerBridgeId', 'prompt', 'interrupt', 'foregroundWaitMs'],
    list: ['scope', 'status', 'limit', 'cursor'],
    read: ['answerBridgeId', 'scope', 'limit', 'cursor'],
    wait: ['answerBridgeId', 'answerBridgeIds', 'scope', 'timeoutMs'],
    interrupt_subtree: ['answerBridgeId']
  };
  const allowed = new Set(['operation', 'scheduling', ...fields[operation]]);
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new Error(`run_agent.${operation} does not accept ${key}.`);
  }
  if (args.scheduling !== undefined && args.scheduling !== 'serial' && args.scheduling !== 'parallel') {
    throw new Error('run_agent.scheduling must be parallel or serial.');
  }
  if (operation === 'spawn') normalizeChildForkTurns(args.forkTurns);
  if (args.agent !== undefined) {
    const agent = requireRecord(args.agent, 'run_agent.agent');
    if (Object.keys(agent).some(key => key !== 'type')) throw new Error('run_agent.agent only accepts type.');
    if (agent.type !== undefined) requireText(agent.type, 'run_agent.agent.type');
  }
}

function childTaskScope(value: PlainJsonValue | undefined): 'direct' | 'tree' {
  if (value === undefined || value === 'direct') return 'direct';
  if (value === 'tree') return 'tree';
  throw new Error('run_agent.scope must be direct or tree.');
}

function boundedChildTaskInteger(value: PlainJsonValue | undefined, name: string,
  fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`run_agent.${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function scopedChildTask(projection: ConversationChildTaskProjection, bridgeId: string,
  scope: 'direct' | 'tree'): ConversationChildTaskRecord | undefined {
  const tasks = projection.tasks.filter(task => task.answerBridgeId === bridgeId);
  if (tasks.length !== 1 || tasks[0].depth < 1
    || (scope === 'direct' && (tasks[0].depth !== 1 || tasks[0].parentConversationId !== projection.conversationId))) {
    return undefined;
  }
  return tasks[0];
}

function childTaskWaitReferences(args: { [key: string]: PlainJsonValue }): string[] {
  if ((args.answerBridgeId !== undefined) === (args.answerBridgeIds !== undefined)) {
    throw new Error('run_agent.wait requires exactly one of answerBridgeId or answerBridgeIds.');
  }
  if (args.answerBridgeId !== undefined) return [requireText(args.answerBridgeId, 'run_agent.answerBridgeId')];
  if (!Array.isArray(args.answerBridgeIds) || args.answerBridgeIds.length < 1 || args.answerBridgeIds.length > 32) {
    throw new Error('run_agent.answerBridgeIds must contain 1 to 32 distinct references.');
  }
  const ids = args.answerBridgeIds.map(id => requireText(id, 'run_agent.answerBridgeIds item'));
  if (new Set(ids).size !== ids.length) throw new Error('run_agent.answerBridgeIds must contain distinct references.');
  return ids;
}

function childTaskWaitSettled(tasks: ConversationChildTaskRecord[]): boolean {
  return tasks.some(task => !['starting', 'active', 'interrupting'].includes(task.status) && task.queuedInputs.length === 0);
}

function waitForChildTaskObservation(database: RuntimeDatabase, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve();
    };
    const aborted = () => finish(signal?.reason ?? new Error('Child task wait aborted.'));
    const timer = setTimeout(() => finish(), Math.max(1, timeoutMs));
    unsubscribe = database.onCommit(() => finish());
    signal?.addEventListener('abort', aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function abortReason(value: unknown): string {
  if (value instanceof Error && value.message.trim()) return value.message.trim().slice(0, 500);
  if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 500);
  return 'Parent Turn was cancelled while waiting for the child Agent.';
}

function emptyRecoveryReport(): ReliableChildAgentRecoveryReport {
  return {
    spawnIntentsScanned: 0,
    spawnIntentsReconciled: 0,
    activeTurnsScanned: 0,
    resumedTurnIds: [],
    deferredTurnIds: [],
    continuationsAdmitted: [],
    terminalTurnsReconciled: []
  };
}

function mergeRecoveryReports(
  aggregate: ReliableChildAgentRecoveryReport | undefined,
  current: ReliableChildAgentRecoveryReport
): ReliableChildAgentRecoveryReport {
  if (!aggregate) return current;
  return {
    spawnIntentsScanned: aggregate.spawnIntentsScanned + current.spawnIntentsScanned,
    spawnIntentsReconciled: aggregate.spawnIntentsReconciled + current.spawnIntentsReconciled,
    activeTurnsScanned: aggregate.activeTurnsScanned + current.activeTurnsScanned,
    resumedTurnIds: uniqueStrings([...aggregate.resumedTurnIds, ...current.resumedTurnIds]),
    deferredTurnIds: uniqueStrings([...aggregate.deferredTurnIds, ...current.deferredTurnIds]),
    continuationsAdmitted: uniqueStrings([
      ...aggregate.continuationsAdmitted,
      ...current.continuationsAdmitted
    ]),
    terminalTurnsReconciled: uniqueStrings([
      ...aggregate.terminalTurnsReconciled,
      ...current.terminalTurnsReconciled
    ])
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function compareCounter(left: unknown, right: unknown): number {
  const a = typeof left === 'bigint' ? left : BigInt(String(left));
  const b = typeof right === 'bigint' ? right : BigInt(String(right));
  return a < b ? -1 : a > b ? 1 : 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, ms)));
}
