import { isConversationRuntimeOwnerBusyError } from '../../reliableKernel/ConversationRuntimeOwnerManager';
import { collaborationMessageWakePolicy } from '../../reliableKernel/collaborationWake';
import {
  runWithExecutionLeaseFence,
  runWithoutExecutionLeaseFence,
  type ExecutionLeaseFence
} from '../../reliableKernel/executionLeaseFence';
import { DATA_ROOT_RELOCATED_REASON, HISTORICAL_MERGE_SETTLED_REASON } from '../../reliableKernel/deliverySettlementSteps';
import { DOMAIN_REPOSITORIES, type DomainRow } from '../../reliableKernel/repositories';
import { listAllDomainRows } from '../../reliableKernel/repositoryPagination';
import {
  RELOCATED_WORK_LISTS,
  parseRelocatedWorkInventory,
  type RelocatedConversationWork,
  type RelocatedWorkInventory
} from '../../reliableKernel/relocatedWorkInventory';
import type { ReliableKernelApplication } from '../../reliableKernel/runtimeApplication';

import type {
  RelocatedWorkSettlementCounts, RelocatedWorkItem, RelocatedWorkUnsettled,
  RelocatedWorkItemList, RelocatedWorkSettlementResult
} from '../../reliableKernel/historicalWorkSettlement';
export type {
  RelocatedWorkSettlementCounts, RelocatedWorkItem, RelocatedWorkUnsettled, RelocatedWorkUnsettledKind,
  RelocatedWorkItemList, RelocatedWorkSettlementResult
} from '../../reliableKernel/historicalWorkSettlement';

/**
 * Closes, in the old data directory, the unfinished work a data-root relocation carried into the
 * new one (see relocatedWorkInventory), so that a Host recovering the old directory never runs it a
 * second time: no model call, no tool, no continuation.
 *
 * Only public control-plane transitions are used: those of a user's explicit stop, in the order the
 * tested stop paths use them (ReliableConversationRunner.interrupt with its control-only settlement,
 * ReliableChildAgentCoordinator.interruptSubtree with `userStop`), and the abandon transitions that
 * give a result up with the selected settlement reason (deliverySettlementSteps: the rows'
 * existing terminal states failed / dead_letter, never retried, never opening a Turn):
 *
 * | Work                                              | Transition                                                   |
 * |---------------------------------------------------|--------------------------------------------------------------|
 * | queued user message                               | TurnControlPlane.cancelGuidance                              |
 * | queued retry or runtime continuation              | TurnControlPlane.cancelQueuedIntent                          |
 * | active Turn (top level)                           | requestExternalInterrupt, control lease, AgentLoop.terminateRequested → interrupted |
 * | its unstarted ModelRequest, undispatched effect   | closed by terminateRequested                                 |
 * | its pending question or approval                  | cancelled as ReliableToolDispatcher.cancelWaiting does, then terminateRequested |
 * | its result already routed to it                   | taken in by terminateRequested (kept in its history)         |
 * | effect dispatched by a window proven dead         | PhaseDRecoveryScanner.abandonDeadHostEffects → outcome_unknown |
 * | subagent spawn dispatched by a window proven dead | ChildExecutionControlPlane.recoverSpawnIntent (recorded as spawned) |
 * | running or pending child Agent, with its subtree  | ChildExecutionControlPlane.interruptSubtree, then its Turns as above |
 * | background child Agent of a completed parent Turn | its active Turn stopped as from its own panel (stop request, as above); it goes idle, no answer; a queued continuation is then cancelled with interruptSubtree |
 * | orphan Turn (no lease, no input)                  | TurnControlPlane.finalizeRecovery → cancelled               |
 * | pending result or message that would open a Turn  | RuntimeDeliveryControlPlane.abandonPending → failed, wakes dead_letter, its runtime continuation cancelled |
 * | child answer not routed yet                       | RuntimeDeliveryControlPlane.createAbandoned → an already failed delivery, no wake |
 * | finished background process not delivered yet    | ProcessCompletionDeliveryControlPlane.abandonDispatch → dead_letter |
 *
 * Settling can create new work (a requester told that nobody will answer), so it runs in rounds over
 * the whole data set (see run). Work a live Host executes gets the durable stop request, or is left
 * to that Host, and is returned in `live`; what a stop path does not close here is returned in
 * `unsettled` (`needs_human`, `failed`, and `rounds_exhausted` past the round limit). Nothing
 * returned there is settled: while anything is, the caller lets nothing run (the old directory does
 * not open, see relocatedWorkOpening) and the next open settles the whole data set again.
 *
 * Call it on the old directory's opened Runtime before its startup recovery (application.recover,
 * the child scheduler and the Runner) runs, and only on the user's explicit choice: closing work
 * dispatched by a dead window as outcome_unknown is reserved to a user's stop (AGENTS.md).
 */
export function relocatedWorkSettlementReason(targetRootPath: string): string {
  return `数据目录已迁移到 ${targetRootPath}，这个任务已随数据迁走，可能已在新目录执行过；在这里按中止收尾，不再执行。`;
}

/** Rounds of settle, converge collaboration, take the inventory again; more new work is left (`rounds_exhausted`). */
const MAX_SETTLEMENT_ROUNDS = 5;
export const HISTORICAL_MERGE_SETTLEMENT_MAX_ROUNDS = 3;
export const HISTORICAL_MERGE_SETTLEMENT_REASON = '合并前按用户确认中止未完成的工作，不再执行。';

export interface OfflineWorkSettlementPolicy {
  reasonCode: typeof DATA_ROOT_RELOCATED_REASON | typeof HISTORICAL_MERGE_SETTLED_REASON;
  reason: string;
  sourceKeyPrefix: string;
  maxRounds: number;
}
/** Converging and taking the inventory between rounds is tried this often (another Host may converge the same facts). */
const ROUND_ATTEMPTS = 3;
const ROUND_RETRY_DELAY_MS = 100;
const CONTROL_LEASE_MS = 30_000;
const CHILD_RUNNING_STATUSES = ['starting', 'active', 'interrupting'] as const;

type TurnOutcome = 'stopped' | 'terminal' | 'live' | 'unsupported' | 'needs_human' | 'failed';
type IncludedChild = { childConversationId: string; parentChildExecutionId: string | null; parentTurn: DomainRow | null };

/**
 * Settles the carried work of every Conversation the inventory lists (the inventory as written into
 * the old directory's moved notice). Idempotent: a second call finds the work closed and changes
 * nothing. Returns what it closed per kind, for the prompt, and what it could not close.
 */
export async function settleRelocatedWork(input: {
  application: ReliableKernelApplication;
  inventory: RelocatedWorkInventory | unknown;
  targetRootPath: string;
}): Promise<RelocatedWorkSettlementResult> {
  if (typeof input.targetRootPath !== 'string' || input.targetRootPath.trim().length === 0) {
    throw new TypeError('settleRelocatedWork requires the new data directory.');
  }
  return settleOfflineWork({
    ...input,
    policy: {
      reasonCode: DATA_ROOT_RELOCATED_REASON,
      reason: relocatedWorkSettlementReason(input.targetRootPath),
      sourceKeyPrefix: DATA_ROOT_RELOCATED_REASON,
      maxRounds: MAX_SETTLEMENT_ROUNDS
    }
  });
}

/**
 * A local historical source only: the caller owns its offline maintenance claim, has backed it up
 * and durably recorded the user's consent before this call. Never use this on a foreign root.
 * Items in live/unsettled carry Conversation ids for exclusion; an empty id is a source-wide
 * failure and must defer the source. Checkpoint the result before recording finalization counts.
 */
export function settleHistoricalMergeWork(input: {
  application: ReliableKernelApplication;
  inventory: RelocatedWorkInventory | unknown;
  /** The merge exclusion closure, including child families, must not be settled in any round. */
  excludedConversationIds?: ReadonlySet<string>;
}): Promise<RelocatedWorkSettlementResult> {
  return settleOfflineWork({
    ...input,
    policy: {
      reasonCode: HISTORICAL_MERGE_SETTLED_REASON,
      reason: HISTORICAL_MERGE_SETTLEMENT_REASON,
      sourceKeyPrefix: HISTORICAL_MERGE_SETTLED_REASON,
      maxRounds: HISTORICAL_MERGE_SETTLEMENT_MAX_ROUNDS
    }
  });
}

/** Shared stop transitions; the supplied policy changes only provenance, user-facing copy and round limit. */
export function settleOfflineWork(input: {
  application: ReliableKernelApplication;
  inventory: RelocatedWorkInventory | unknown;
  policy: OfflineWorkSettlementPolicy;
  excludedConversationIds?: ReadonlySet<string>;
}): Promise<RelocatedWorkSettlementResult> {
  const inventory = parseRelocatedWorkInventory(input.inventory);
  return new RelocatedWorkSettlement(input.application, inventory, input.policy, input.excludedConversationIds).run();
}

class RelocatedWorkSettlement {
  private readonly counts: RelocatedWorkSettlementCounts = {
    turnsStopped: 0,
    childTurnsStopped: 0,
    childExecutionsInterrupted: 0,
    backgroundChildrenStopped: 0,
    queuedMessagesCancelled: 0,
    childContinuationsCancelled: 0,
    interactionsCancelled: 0,
    modelRequestsClosed: 0,
    effectsCancelled: 0,
    effectsClosedAsUnknown: 0,
    deliveriesTakenIn: 0,
    queuedIntentsCancelled: 0,
    deliveriesAbandoned: 0,
    answersAbandoned: 0,
    processCompletionsAbandoned: 0
  };
  private readonly live: RelocatedWorkSettlementResult['live'] = [];
  private readonly unsettled: RelocatedWorkUnsettled[] = [];
  private readonly hostBootId: string;
  private readonly leaseOwnerId: string;

  public constructor(
    private readonly application: ReliableKernelApplication,
    private readonly inventory: RelocatedWorkInventory,
    private readonly policy: OfflineWorkSettlementPolicy,
    private readonly excludedConversationIds: ReadonlySet<string> = new Set()
  ) {
    this.hostBootId = application.database.hostBootId;
    this.leaseOwnerId = `${this.policy.sourceKeyPrefix}:${this.hostBootId}`;
  }

  /**
   * Settles in rounds. Settling can create new work: a collaboration request whose deliveries all
   * failed tells its requester that nobody will answer (CollaborationControlPlane.reconcile), and a
   * Turn that ended completes the requests it took in; such a reply may open a Turn there. So after
   * each round the collaboration facts converge, the whole data set is taken again
   * (RuntimeDatabase.relocatedWorkInventory) and the Conversations with work not seen before are
   * settled the same way, until no new work appears. After the policy's maximum rounds, what is
   * still new is left (`rounds_exhausted`: the caller must not let it run). Converging and taking the
   * inventory is tried ROUND_ATTEMPTS times (another live Host of the old directory may converge the
   * same facts at once); when it keeps failing, the round is `failed`: what it would have found is
   * not settled, so the caller must not let anything run.
   */
  public async run(): Promise<RelocatedWorkSettlementResult> {
    const seen = new Set<string>();
    let round = 1;
    await this.settleRound(this.inventory.conversations.filter((item) => !this.excludedConversationIds.has(item.conversationId)), seen);
    for (;;) {
      const next = await this.nextInventory(round + 1);
      if (!next) break;
      const fresh = next.conversations.filter((conversation) => !this.excludedConversationIds.has(conversation.conversationId)
        && workKeys(conversation).some((key) => !seen.has(key)));
      if (fresh.length === 0) break;
      if (round >= this.policy.maxRounds) {
        for (const conversation of fresh) {
          for (const key of workKeys(conversation).filter((item) => !seen.has(item))) {
            const [list, id] = key.split('|');
            this.unsettled.push({
              conversationId: conversation.conversationId, list: list as RelocatedWorkItemList, kind: 'rounds_exhausted', id,
              detail: `收尾 ${this.policy.maxRounds} 轮后仍出现新的可执行项（${list}），这次不再收尾。`
            });
          }
        }
        break;
      }
      round += 1;
      await this.settleRound(fresh, seen);
    }
    return this.result(round);
  }

  /** Collaboration converged and the whole data set taken again, tried a few times; undefined (a `failed` round) when it keeps failing. */
  private async nextInventory(round: number): Promise<RelocatedWorkInventory | undefined> {
    let failure: unknown;
    for (let attempt = 1; attempt <= ROUND_ATTEMPTS; attempt += 1) {
      try {
        await this.application.runtime.collaboration.reconcile();
        return parseRelocatedWorkInventory(await this.application.database.relocatedWorkInventory());
      } catch (error) {
        failure = error;
        if (attempt < ROUND_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, ROUND_RETRY_DELAY_MS * attempt));
      }
    }
    this.unsettled.push({
      conversationId: '', list: 'round', kind: 'failed', id: `round-${round}`,
      detail: `第 ${round} 轮之前协作收敛或重新盘点失败（试了 ${ROUND_ATTEMPTS} 次）：${errorMessage(failure)}`
    });
    return undefined;
  }

  private result(rounds: number): RelocatedWorkSettlementResult {
    // A Conversation settled again in a later round reports what is still open once.
    return {
      reason: this.policy.reason,
      counts: { ...this.counts },
      live: uniqueBy(this.live, (item) => `${item.conversationId}|${item.id}`),
      unsettled: uniqueBy(this.unsettled, (item) => `${item.conversationId}|${item.kind}|${item.id}`),
      rounds
    };
  }

  /** One round over the given Conversations' work, in the order the stop paths need. */
  private async settleRound(inventory: readonly RelocatedConversationWork[], seen: Set<string>): Promise<void> {
    const conversations: RelocatedConversationWork[] = [];
    for (const conversation of inventory) {
      for (const key of workKeys(conversation)) seen.add(key);
      // Once settled, a Conversation the pending-work probe still sees as busy (a stopped lineage
      // converges in the child scheduler's recovery) is not new work.
      seen.add(`otherRuntimeWork|${conversation.conversationId}`);
      if (await this.get('Conversation', conversation.conversationId)) conversations.push(conversation);
    }
    // A queued message goes first, so no Turn ending below admits it.
    for (const conversation of conversations) await this.cancelQueuedMessages(conversation.conversationId);
    // Parents stop before their children: an interrupted child's partial answer then only
    // notifies a stopped parent instead of continuing it.
    for (const conversation of conversations) await this.stopTopLevelTurns(conversation.conversationId);
    const listed = new Set(conversations.map((conversation) => conversation.conversationId));
    await this.interruptChildren(listed);
    for (const conversation of conversations) {
      await this.abandonPendingDeliveries(conversation.conversationId);
      await this.abandonUndeliveredAnswers(conversation);
    }
    await this.abandonProcessCompletions(listed);
  }

  private async cancelQueuedMessages(conversationId: string): Promise<void> {
    const queued = (await this.list('TurnIntent', { conversation_id: conversationId, state: 'queued' }))
      .filter((intent) => intent.turn_id === null);
    for (const intent of queued) {
      const intentId = String(intent.id);
      // A child continuation belongs to its lineage; interruptSubtree cancels it.
      if ((await this.list('ChildExecutionIntentLink', { turn_intent_id: intentId })).length > 0) continue;
      const revisions = await this.list('TurnIntentRevision', { intent_id: intentId });
      const revisionSeq = revisions.reduce((maximum, revision) => {
        const seq = BigInt(revision.revision_seq as bigint);
        return seq > maximum ? seq : maximum;
      }, 0n);
      try {
        const result = await this.application.turns.cancelGuidance({
          source: { kind: 'command', key: `${this.policy.sourceKeyPrefix}:message:${intentId}` },
          conversationId,
          intentId,
          expectedRevisionSeq: revisionSeq.toString()
        });
        if (!result.deduplicated) this.counts.queuedMessagesCancelled += 1;
      } catch (error) {
        if (isConversationRuntimeOwnerBusyError(error)) {
          this.live.push({ conversationId, id: intentId, list: 'queuedIntentIds' });
        } else if (/not an ordinary queued guidance message/.test(errorMessage(error))) {
          await this.cancelQueuedIntent(conversationId, intentId, revisionSeq.toString());
        } else {
          this.unsettled.push({ conversationId, list: 'queuedIntentIds', kind: 'failed', id: intentId, detail: errorMessage(error) });
        }
      }
    }
  }

  /** A queued continuation that is not an ordinary message (a retry, a runtime continuation). */
  private async cancelQueuedIntent(conversationId: string, intentId: string, expectedRevisionSeq: string): Promise<void> {
    try {
      const result = await this.application.turns.cancelQueuedIntent({
        source: { kind: 'command', key: `${this.policy.sourceKeyPrefix}:intent:${intentId}` },
        conversationId,
        intentId,
        expectedRevisionSeq
      });
      if (!result.deduplicated) this.counts.queuedIntentsCancelled += 1;
    } catch (error) {
      if (isConversationRuntimeOwnerBusyError(error)) this.live.push({ conversationId, id: intentId, list: 'queuedIntentIds' });
      else this.unsettled.push({ conversationId, list: 'queuedIntentIds', kind: 'failed', id: intentId, detail: errorMessage(error) });
    }
  }

  private async stopTopLevelTurns(conversationId: string): Promise<void> {
    for (const turn of await this.list('Turn', { conversation_id: conversationId, status: 'active' })) {
      const turnId = String(turn.id);
      // A child Agent's Turn stops with its subtree (interruptChildren).
      if ((await this.list('ChildExecutionTurnLink', { turn_id: turnId })).length > 0) continue;
      if (await this.stopTurn(conversationId, turnId, true) === 'stopped') this.counts.turnsStopped += 1;
    }
  }

  /**
   * One Turn, as a user's stop closes it in a window that does not execute it: the durable stop
   * request first (a live owner executes it), a dead window's dispatched spawns recorded, then the
   * control-only settlement under a short control lease that is handed back unless the Turn ended.
   */
  private async stopTurn(conversationId: string, turnId: string, requestInterrupt: boolean): Promise<TurnOutcome> {
    try {
      const before = await this.turnWork(turnId);
      if (requestInterrupt) {
        const requested = await this.application.turns.requestExternalInterrupt(conversationId, {
          source: { kind: 'command', key: `${this.policy.sourceKeyPrefix}:turn:${turnId}` },
          turnId,
          reason: this.policy.reason
        });
        if (requested.ignoredBecauseTerminal) return 'terminal';
      }
      await this.recordDeadHostSpawns(turnId);
      const outcome = await this.application.database.conversationOwners.run(
        conversationId,
        () => this.settleOwnedTurn(turnId)
      );
      if (outcome === 'stopped') await this.countClosedWork(before);
      else if (outcome === 'live') this.live.push({ conversationId, id: turnId, list: 'activeTurnIds' });
      else if (outcome === 'unsupported' || outcome === 'needs_human') {
        this.unsettled.push({
          conversationId, list: 'activeTurnIds', kind: 'needs_human', id: turnId,
          detail: outcome === 'unsupported'
            ? '存在停止路径不支持的已派发效果或子 Agent 操作；已记录停止请求。'
            : 'Turn 的终态事实不一致，需要人工处理；已记录停止请求。'
        });
      } else if (outcome === 'failed') {
        this.unsettled.push({ conversationId, list: 'activeTurnIds', kind: 'failed', id: turnId, detail: '停止请求没有被收尾路径接受。' });
      }
      return outcome;
    } catch (error) {
      if (isConversationRuntimeOwnerBusyError(error)) {
        this.live.push({ conversationId, id: turnId, list: 'activeTurnIds' });
        return 'live';
      }
      this.unsettled.push({ conversationId, list: 'activeTurnIds', kind: 'failed', id: turnId, detail: errorMessage(error) });
      return 'failed';
    }
  }

  /** The control-only settlement of ReliableConversationRunner (settleDeadHostExecution / settleWithoutExecution). */
  private async settleOwnedTurn(turnId: string): Promise<TurnOutcome> {
    const turns = this.application.turns;
    const phaseD = this.application.phaseDRecovery;
    const facts = await turns.recoveryFacts(turnId);
    if (facts.turnStatus !== 'active') return 'terminal';
    if (facts.judgment === 'finalize') {
      await turns.finalizeRecovery({
        source: { kind: 'recovery', key: `${this.policy.sourceKeyPrefix}:finalize:${turnId}` },
        turnId,
        terminalStatus: 'cancelled',
        reason: this.policy.reason
      });
      return 'stopped';
    }
    if (facts.judgment !== 'resume') return 'needs_human';
    const preview = await phaseD.deadHostEffectsForTurn(turnId, this.hostBootId);
    if (preview.state === 'live') return 'live';
    if (preview.state === 'unsupported') return 'unsupported';
    const fence = await this.claimControlLease(turnId);
    if (!fence) return 'live';
    let unsettled: TurnOutcome = 'failed';
    let terminated = false;
    try {
      terminated = await runWithoutExecutionLeaseFence(() => runWithExecutionLeaseFence(fence, async () => {
        // Re-read under the lease: another stop may have closed some of the work meanwhile.
        const current = await phaseD.deadHostEffectsForTurn(turnId, this.hostBootId);
        if (current.state === 'live' || current.state === 'unsupported') {
          unsettled = current.state;
          return false;
        }
        if (current.state === 'dead') {
          const unknown = await this.withoutReceipt(current.effectIntentIds);
          await phaseD.abandonDeadHostEffects({
            sourceKey: `${this.policy.sourceKeyPrefix}:dead-host:${turnId}`,
            effectIntentIds: current.effectIntentIds,
            reason: this.policy.reason
          });
          this.counts.effectsClosedAsUnknown += unknown;
        } else {
          await phaseD.reconcileArrivedReceipts(current.receiptEffectIntentIds);
        }
        await this.closePendingInteractions(turnId);
        return this.application.agentLoop.terminateRequested(turnId, this.policy.sourceKeyPrefix);
      }));
    } finally {
      // Anything short of a terminal Turn, a failure included, hands the lease back in this hold.
      if (!terminated) await turns.releaseExecutionLease(fence).catch(() => undefined);
    }
    return terminated ? 'stopped' : unsettled;
  }

  /**
   * The Turn's pending questions and approvals, closed with the transitions and in the way
   * ReliableToolDispatcher.cancelWaiting closes them for a recorded stop, under the same lease, so
   * each one's response records the relocation reason. terminateRequested closes whatever is left
   * the same way, with its generic "Turn observed interrupt_request" reason.
   */
  private async closePendingInteractions(turnId: string): Promise<void> {
    const owners = (await this.list('InteractionOwnerLink', { turn_id: turnId }))
      .sort((left, right) => String(left.request_id).localeCompare(String(right.request_id)));
    for (const owner of owners) {
      const requestId = String(owner.request_id);
      const request = await this.require('InteractionRequest', requestId);
      if (request.status !== 'pending') continue;
      const source = { kind: 'command' as const, key: `${this.policy.sourceKeyPrefix}:interaction:${requestId}` };
      const response = { reason: this.policy.reason };
      switch (request.request_kind) {
        case 'ask_user':
          await this.application.interactions.resolveAskUser({ source, requestId, response, cancelled: true });
          break;
        case 'file_change_approval': {
          const [toolLink] = await this.list('InteractionToolCallLink', { request_id: requestId });
          const changeSets = toolLink ? await this.list('FileChangeSet', { tool_call_id: String(toolLink.tool_call_id) }) : [];
          if (changeSets.length !== 1) throw new Error(`File approval ${requestId} must have one FileChangeSet.`);
          await this.application.files.decide({ source, changeSetId: String(changeSets[0].id), decision: 'cancelled', response });
          break;
        }
        case 'plan_review':
          await this.application.interactions.resolvePlanReview({ source, requestId, decision: 'cancel', response });
          break;
        case 'exec_approval':
          await this.application.interactions.resolveExecutionApproval({ source, requestId, decision: 'cancel', response });
          break;
        default:
          throw new Error(`Unsupported pending InteractionRequest kind: ${String(request.request_kind)}.`);
      }
    }
  }

  private async claimControlLease(turnId: string): Promise<ExecutionLeaseFence | null> {
    const turns = this.application.turns;
    let claimed: Awaited<ReturnType<typeof turns.claimRecoveryExecution>>;
    try {
      claimed = await turns.claimRecoveryExecution({
        turnId,
        leaseOwnerId: this.leaseOwnerId,
        hostBootId: this.hostBootId,
        leaseExpiresAt: new Date(Date.now() + CONTROL_LEASE_MS).toISOString()
      });
    } catch (error) {
      // The claim may have committed before a later read failed: hand back what this Host holds.
      const held = await turns.executionLeaseFence({
        turnId,
        leaseOwnerId: this.leaseOwnerId,
        hostBootId: this.hostBootId
      }).catch(() => null);
      if (held) await turns.releaseExecutionLease(held).catch(() => undefined);
      throw error;
    }
    if (!claimed) return null;
    return {
      id: claimed.executionLeaseId,
      conversationId: claimed.conversationId,
      turnId: claimed.turnId,
      ownerId: this.leaseOwnerId,
      hostBootId: this.hostBootId,
      generation: BigInt(claimed.leaseGeneration)
    };
  }

  /**
   * ReliableConversationRunner.recordSpawnedChildren: a run_agent spawn dispatched by a window proven
   * dead already created its child; the child scheduler's recovery transition records it as spawned,
   * so the stop can close the parent's wait and the cascade reaches the child.
   */
  private async recordDeadHostSpawns(turnId: string): Promise<void> {
    const effects = await this.application.phaseDRecovery.deadHostEffectsForTurn(turnId, this.hostBootId);
    if (effects.state !== 'unsupported' || !effects.spawnEffectIntentIds) return;
    for (const effectIntentId of effects.spawnEffectIntentIds) {
      const childConversationId = await this.spawnedChildConversation(effectIntentId);
      await this.application.database.conversationOwners.run(childConversationId, () =>
        this.application.runtime.children.recoverSpawnIntent(effectIntentId));
    }
  }

  private async spawnedChildConversation(effectIntentId: string): Promise<string> {
    const intent = await this.require('EffectIntent', effectIntentId);
    const attempt = await this.require('Attempt', String(intent.attempt_id));
    const operation = await this.require('Operation', String(attempt.operation_id));
    if (operation.owner_kind !== 'child_execution') throw new Error(`Spawn ${effectIntentId} has no ChildExecution Operation.`);
    const child = await this.require('ChildExecution', String(operation.owner_id));
    return String(child.child_conversation_id);
  }

  /**
   * Every running or pending child execution spawned from, or being, a listed Conversation is
   * stopped, topmost first:
   * - a background child whose parent Turn had already completed, with an active Turn and no queued
   *   continuation, is stopped the way a user stops it from its own panel
   *   (ReliableChildAgentCoordinator.interruptFromConversation): each active Turn gets an ordinary
   *   stop request and is settled like a top-level one. With no termination request the child
   *   publishes no interrupted answer and goes idle, so the completed parent is never continued.
   *   Its own children are handled next, the same way, as the topmost ones left;
   * - every other child is interrupted with its subtree (a subtree includes its descendants), then
   *   each child Turn that was active is settled the same way; its interrupted answer only notifies
   *   its stopped parent.
   * The lineage itself converges in the child scheduler's recovery, exactly as after a user's stop in
   * a window that does not run it.
   */
  private async interruptChildren(listed: ReadonlySet<string>): Promise<void> {
    const candidates = new Map<string, DomainRow>();
    for (const status of CHILD_RUNNING_STATUSES) {
      for (const child of await this.list('ChildExecution', { status })) candidates.set(String(child.id), child);
    }
    const linked = [
      ...(await this.list('ChildExecutionActiveTurnLink', {})).map((link) => String(link.child_execution_id)),
      ...(await this.list('ChildExecutionIntentLink', { state: 'pending' })).map((link) => String(link.child_execution_id))
    ];
    for (const childExecutionId of linked) {
      if (candidates.has(childExecutionId)) continue;
      const child = await this.get('ChildExecution', childExecutionId);
      if (child) candidates.set(childExecutionId, child);
    }
    const included = new Map<string, IncludedChild>();
    for (const [childExecutionId, child] of candidates) {
      if (this.excludedConversationIds.has(String(child.child_conversation_id))) continue;
      const [parentLink] = await this.list('ChildExecutionParentLink', { child_execution_id: childExecutionId });
      if (!parentLink) continue;
      const parentTurn = await this.get('Turn', String(parentLink.parent_turn_id));
      if (!listed.has(String(child.child_conversation_id)) && !(parentTurn && listed.has(String(parentTurn.conversation_id)))) {
        continue;
      }
      included.set(childExecutionId, {
        childConversationId: String(child.child_conversation_id),
        parentChildExecutionId: parentLink.parent_child_execution_id === null ? null : String(parentLink.parent_child_execution_id),
        parentTurn
      });
    }
    // Detached children are only stopped, so their descendants become the topmost ones next round.
    const detached = new Set<string>();
    const done = new Set<string>();
    for (;;) {
      const roots: Array<[string, IncludedChild]> = [];
      for (const [childExecutionId, entry] of [...included].sort(([left], [right]) => left.localeCompare(right))) {
        if (done.has(childExecutionId)) continue;
        if (await this.hasIncludedAncestor(entry.parentChildExecutionId, included, detached)) continue;
        roots.push([childExecutionId, entry]);
      }
      if (roots.length === 0) return;
      for (const [rootId, root] of roots) {
        done.add(rootId);
        const handled = await this.stopDetachedChild(rootId, root);
        if (handled === 'stopped') detached.add(rootId);
        else if (handled === 'no') await this.interruptSubtreeOf(rootId, root);
      }
    }
  }

  /**
   * A background child whose parent Turn completed, stopped like from its own panel: its active
   * Turns get an ordinary stop request and are settled like top-level ones, so it publishes no
   * interrupted answer and the completed parent is never continued (`stopped`; its own children are
   * handled next). A queued continuation (a run_agent send) is then cancelled with the lineage
   * (ChildExecutionControlPlane.interruptSubtree): with none of its Turns active any more, the
   * interruption writes no termination request, so again nothing reaches the parent (`subtree`).
   * `no` when it is not such a child: it is interrupted with its subtree as usual.
   */
  private async stopDetachedChild(childExecutionId: string, entry: IncludedChild): Promise<'stopped' | 'subtree' | 'no'> {
    if (!await this.completedSuccessfully(entry.parentTurn)) return 'no';
    const queued = (await this.list('ChildExecutionIntentLink', { child_execution_id: childExecutionId, state: 'pending' })).length > 0;
    const links = await this.list('ChildExecutionActiveTurnLink', { child_execution_id: childExecutionId });
    if (links.length === 0 && !queued) return 'no';
    let stopped = 0;
    let live = false;
    for (const link of links) {
      const turn = await this.get('Turn', String(link.turn_id));
      // A Turn already ended (a second settlement) leaves the child to go idle in its scheduler.
      if (!turn || turn.status !== 'active') continue;
      const outcome = await this.stopTurn(String(turn.conversation_id), String(turn.id), true);
      if (outcome === 'stopped') stopped += 1;
      else if (outcome !== 'terminal') live = true;
    }
    this.counts.childTurnsStopped += stopped;
    if (stopped > 0 || (queued && !live)) this.counts.backgroundChildrenStopped += 1;
    // A Turn a live Host still runs keeps its lineage there: that Host executes the stop request.
    if (!queued || live) return 'stopped';
    await this.interruptSubtreeOf(childExecutionId, entry);
    return 'subtree';
  }

  private async interruptSubtreeOf(rootId: string, root: IncludedChild): Promise<void> {
    const parentConversationId = root.parentTurn ? String(root.parentTurn.conversation_id) : undefined;
    try {
      const interrupted = await this.application.runtime.children.interruptSubtree({
        sourceKey: `${this.policy.sourceKeyPrefix}:child:${rootId}`,
        childExecutionId: rootId,
        reason: this.policy.reason
      });
      if (!interrupted.deduplicated) {
        this.counts.childExecutionsInterrupted += interrupted.lineageIds.length;
        this.counts.childContinuationsCancelled += interrupted.intentsCancelled;
      }
      for (const turnId of interrupted.activeTurnIds) {
        const turn = await this.get('Turn', turnId);
        if (!turn || turn.status !== 'active') continue;
        if (await this.stopTurn(String(turn.conversation_id), turnId, false) === 'stopped') this.counts.childTurnsStopped += 1;
      }
    } catch (error) {
      this.unsettled.push({
        conversationId: parentConversationId ?? root.childConversationId, list: 'childExecutionIds', kind: 'failed', id: rootId, detail: errorMessage(error)
      });
    }
  }

  /** Whether an ancestor is interrupted with its subtree (a detached ancestor was only stopped). */
  private async hasIncludedAncestor(
    parentChildExecutionId: string | null,
    included: ReadonlyMap<string, unknown>,
    detached: ReadonlySet<string>
  ): Promise<boolean> {
    const seen = new Set<string>();
    let cursor = parentChildExecutionId;
    while (cursor !== null && !seen.has(cursor)) {
      if (included.has(cursor) && !detached.has(cursor)) return true;
      seen.add(cursor);
      const [link] = await this.list('ChildExecutionParentLink', { child_execution_id: cursor });
      cursor = link && link.parent_child_execution_id !== null ? String(link.parent_child_execution_id) : null;
    }
    return false;
  }

  /**
   * Every pending delivery to the Conversation that would reach it on its own is given up
   * (RuntimeDeliveryControlPlane.abandonPending): it fails as not delivered here, its wakes are
   * dead-lettered and a runtime continuation queued for it is cancelled, so it never opens a Turn.
   * A delivery addressed to a Turn still active belongs to the live Host running that Turn, and one
   * whose wake a live Host claimed is that Host's (`live`). A plain message without a wake is left
   * for whichever Turn comes next: it opens none by itself.
   */
  private async abandonPendingDeliveries(conversationId: string): Promise<void> {
    for (const pending of await this.list('RuntimeDelivery', { target_conversation_id: conversationId, state: 'pending' })) {
      const deliveryId = String(pending.id);
      if (pending.target_turn_id !== null) {
        if ((await this.get('Turn', String(pending.target_turn_id)))?.status === 'active') continue;
      } else if (!await this.opensTurn(pending)) {
        continue;
      }
      try {
        const result = await this.application.runtime.deliveries.abandonPending({ deliveryId, reason: this.policy.reasonCode });
        if (result.outcome === 'abandoned') {
          this.counts.deliveriesAbandoned += 1;
          this.counts.queuedIntentsCancelled += result.intentsCancelled;
        } else if (result.outcome === 'live') {
          this.live.push({ conversationId, id: deliveryId, list: 'pendingDeliveryIds' });
        }
      } catch (error) {
        this.unsettled.push({ conversationId, list: 'pendingDeliveryIds', kind: 'failed', id: deliveryId, detail: errorMessage(error) });
      }
    }
  }

  private async opensTurn(delivery: DomainRow): Promise<boolean> {
    const inbox = await this.get('RuntimeInboxItem', String(delivery.inbox_item_id));
    if (inbox?.source_kind !== 'collaboration_message') return true;
    const message = await this.get('CollaborationMessage', String(inbox.source_id));
    if (message?.mode !== 'message') return true;
    // A plain message without a wake just waits for the next Turn (the wake sweep skips it).
    const wakes = await this.list('RuntimeDeliveryWake', { delivery_id: String(delivery.id) });
    if (!wakes.some((wake) => wake.state === 'pending' || wake.state === 'claimed')) return false;
    return await collaborationMessageWakePolicy(
      this.application.database,
      this.application.contentStore,
      String(message.id)
    ) === 'opens_turn';
  }

  /**
   * A child answer to the Conversation that nobody routed yet gets an already failed delivery
   * (RuntimeDeliveryControlPlane.createAbandoned) instead of the one recovery would create and that
   * would continue the parent. Recovery's own classification decides what the answer needs: one that
   * settled a wait, or already has a delivery (settled above), needs nothing; one whose source Turn a
   * live Host still owns, or whose parent Turn is still active, is that Host's.
   */
  private async abandonUndeliveredAnswers(conversation: RelocatedConversationWork): Promise<void> {
    const answers = this.application.runtime.answers;
    for (const submissionId of conversation.undeliveredAnswerIds) {
      const conversationId = conversation.conversationId;
      try {
        if (!await this.get('AnswerSubmission', submissionId)) continue;
        const inbox = await answers.ensureInboxForSubmission(submissionId);
        if (inbox.deferredLiveOwner) {
          this.live.push({ conversationId, id: submissionId, list: 'undeliveredAnswerIds' });
          continue;
        }
        const disposition = await answers.classifyDeliveryRecovery(submissionId);
        if (disposition.kind === 'deferred_live_owner') {
          this.live.push({ conversationId, id: submissionId, list: 'undeliveredAnswerIds' });
          continue;
        }
        if (disposition.kind !== 'delivery_required') continue;
        // A parent Turn still active after the stops above is a live Host's (reported there): it takes the answer in.
        if ((await this.get('Turn', disposition.automaticSourceTurnId))?.status === 'active') {
          this.live.push({ conversationId, id: submissionId, list: 'undeliveredAnswerIds' });
          continue;
        }
        const abandoned = await this.application.runtime.deliveries.createAbandoned({
          inboxItemId: disposition.inboxItemId,
          targetConversationId: disposition.command.targetConversationId,
          reason: this.policy.reasonCode
        });
        if (abandoned.created) this.counts.answersAbandoned += 1;
      } catch (error) {
        this.unsettled.push({ conversationId, list: 'undeliveredAnswerIds', kind: 'failed', id: submissionId, detail: errorMessage(error) });
      }
    }
  }

  /**
   * The completion notice of a finished background Process started from a listed Conversation is
   * dead-lettered (ProcessCompletionDeliveryControlPlane.abandonDispatch) instead of becoming a
   * delivery that continues its Conversation. A source Turn still active belongs to a live Host,
   * which takes the result in; a dispatch a live Host claimed is that Host's (`live`).
   */
  private async abandonProcessCompletions(listed: ReadonlySet<string>): Promise<void> {
    const dispatches = [
      ...await this.list('ProcessCompletionDispatch', { state: 'pending' }),
      ...await this.list('ProcessCompletionDispatch', { state: 'claimed' })
    ];
    for (const dispatch of dispatches) {
      const receipt = await this.get('ProcessReceipt', String(dispatch.process_receipt_id));
      if (!receipt) continue;
      const [source] = await this.list('ProcessCompletionSourceLink', { process_id: String(receipt.process_id) });
      if (!source || !listed.has(String(source.conversation_id))) continue;
      if ((await this.get('Turn', String(source.source_turn_id)))?.status === 'active') continue;
      const conversationId = String(source.conversation_id);
      try {
        const outcome = await this.application.processDeliveries.abandonDispatch({
          dispatchId: String(dispatch.id),
          reason: this.policy.reasonCode
        });
        if (outcome === 'abandoned') this.counts.processCompletionsAbandoned += 1;
        else if (outcome === 'live') this.live.push({ conversationId, id: String(dispatch.id), list: 'pendingProcessCompletionIds' });
      } catch (error) {
        this.unsettled.push({ conversationId, list: 'pendingProcessCompletionIds', kind: 'failed', id: String(dispatch.id), detail: errorMessage(error) });
      }
    }
  }

  private async completedSuccessfully(turn: DomainRow | null): Promise<boolean> {
    if (!turn || turn.status !== 'terminated') return false;
    const [termination] = await this.list('TurnTermination', { turn_id: String(turn.id) });
    return termination?.terminal_status === 'completed';
  }

  /** What a stop closes with its Turn, read before the stop, for the counts. */
  private async turnWork(turnId: string): Promise<{
    interactionIds: string[];
    modelRequestIds: string[];
    pendingEffectIds: string[];
    deliveryIds: string[];
  }> {
    const interactionIds: string[] = [];
    for (const link of await this.list('InteractionOwnerLink', { turn_id: turnId })) {
      const request = await this.get('InteractionRequest', String(link.request_id));
      if (request?.status === 'pending') interactionIds.push(String(request.id));
    }
    const modelRequestIds = (await this.list('ModelRequest', { turn_id: turnId }))
      .filter((request) => request.status !== 'terminal')
      .map((request) => String(request.id));
    const pendingEffectIds: string[] = [];
    for (const call of await this.list('ToolCall', { turn_id: turnId, status: 'executing' })) {
      for (const operation of await this.list('Operation', { tool_call_id: String(call.id) })) {
        for (const attempt of await this.list('Attempt', { operation_id: String(operation.id) })) {
          for (const intent of await this.list('EffectIntent', { attempt_id: String(attempt.id) })) {
            if (intent.dispatch_state === 'pending') pendingEffectIds.push(String(intent.id));
          }
        }
      }
    }
    const deliveryIds = (await this.list('RuntimeDelivery', { target_turn_id: turnId, phase: 'current_turn', state: 'pending' }))
      .map((delivery) => String(delivery.id));
    return { interactionIds, modelRequestIds, pendingEffectIds, deliveryIds };
  }

  private async countClosedWork(before: Awaited<ReturnType<RelocatedWorkSettlement['turnWork']>>): Promise<void> {
    for (const id of before.interactionIds) {
      if ((await this.get('InteractionRequest', id))?.status !== 'pending') this.counts.interactionsCancelled += 1;
    }
    for (const id of before.modelRequestIds) {
      if ((await this.get('ModelRequest', id))?.status === 'terminal') this.counts.modelRequestsClosed += 1;
    }
    for (const id of before.pendingEffectIds) {
      if ((await this.get('EffectIntent', id))?.dispatch_state === 'cancelled_before_dispatch') this.counts.effectsCancelled += 1;
    }
    for (const id of before.deliveryIds) {
      if ((await this.get('RuntimeDelivery', id))?.state === 'consumed') this.counts.deliveriesTakenIn += 1;
    }
  }

  private async withoutReceipt(effectIntentIds: readonly string[]): Promise<number> {
    let count = 0;
    for (const id of effectIntentIds) {
      if ((await this.get('EffectIntent', id))?.dispatch_state === 'dispatched') count += 1;
    }
    return count;
  }

  private list(domain: string, where: DomainRow): Promise<DomainRow[]> {
    return listAllDomainRows(this.application.database, domain, where);
  }

  private async get(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.application.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    return row && !Array.isArray(row) ? row : null;
  }

  private async require(domain: string, id: string): Promise<DomainRow> {
    const row = await this.get(domain, id);
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }
}

/** Each item of a Conversation's listed work, as `list|id` (and `otherRuntimeWork|conversation`). */
function workKeys(conversation: RelocatedConversationWork): string[] {
  const keys = RELOCATED_WORK_LISTS.flatMap((list) => conversation[list].map((id) => `${list}|${id}`));
  return conversation.otherRuntimeWork ? [...keys, `otherRuntimeWork|${conversation.conversationId}`] : keys;
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const itemKey = key(item);
    if (seen.has(itemKey)) return false;
    seen.add(itemKey);
    return true;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
