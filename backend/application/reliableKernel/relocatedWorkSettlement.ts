import { isConversationRuntimeOwnerBusyError } from '../../reliableKernel/ConversationRuntimeOwnerManager';
import { collaborationMessageWakePolicy } from '../../reliableKernel/collaborationWake';
import {
  runWithExecutionLeaseFence,
  runWithoutExecutionLeaseFence,
  type ExecutionLeaseFence
} from '../../reliableKernel/executionLeaseFence';
import { stablePhaseFId } from '../../reliableKernel/phaseFIdentity';
import { DOMAIN_REPOSITORIES, type DomainRow } from '../../reliableKernel/repositories';
import { listAllDomainRows } from '../../reliableKernel/repositoryPagination';
import {
  RELOCATED_WORK_LISTS,
  parseRelocatedWorkInventory,
  type RelocatedConversationWork,
  type RelocatedWorkInventory
} from '../../reliableKernel/relocatedWorkInventory';
import type { ReliableKernelApplication } from '../../reliableKernel/runtimeApplication';

/**
 * Closes, in the old data directory, the unfinished work a data-root relocation carried into the
 * new one (see relocatedWorkInventory), so that a Host recovering the old directory never runs it a
 * second time: no model call, no tool, no continuation.
 *
 * Only the existing, public control-plane transitions of a user's explicit stop are used, in the
 * order the tested stop paths use them (ReliableConversationRunner.interrupt with its control-only
 * settlement, ReliableChildAgentCoordinator.interruptSubtree with `userStop`):
 *
 * | Work                                              | Transition                                                   |
 * |---------------------------------------------------|--------------------------------------------------------------|
 * | queued user message                               | TurnControlPlane.cancelGuidance                              |
 * | active Turn (top level)                           | requestExternalInterrupt, control lease, AgentLoop.terminateRequested → interrupted |
 * | its unstarted ModelRequest, undispatched effect   | closed by terminateRequested                                 |
 * | its pending question or approval                  | cancelled as ReliableToolDispatcher.cancelWaiting does, then terminateRequested |
 * | its result already routed to it                   | taken in by terminateRequested (kept in its history)         |
 * | effect dispatched by a window proven dead         | PhaseDRecoveryScanner.abandonDeadHostEffects → outcome_unknown |
 * | subagent spawn dispatched by a window proven dead | ChildExecutionControlPlane.recoverSpawnIntent (recorded as spawned) |
 * | running or pending child Agent, with its subtree  | ChildExecutionControlPlane.interruptSubtree, then its Turns as above |
 * | background child Agent of a completed parent Turn | its active Turn stopped as from its own panel (stop request, as above); it goes idle, no answer |
 * | orphan Turn (no lease, no input)                  | TurnControlPlane.finalizeRecovery → cancelled               |
 *
 * Work no existing transition closes without starting a Turn is left untouched and returned in
 * `unsettled` (a result waiting for a new Turn, a child answer not delivered yet, a background
 * child with a queued continuation whose partial answer continues a parent that already completed).
 * Work a live Host executes gets the durable stop request and is returned in `live`; that Host
 * closes it.
 *
 * Call it on the old directory's opened Runtime before its startup recovery (application.recover,
 * the child scheduler and the Runner) runs, and only on the user's explicit choice: closing work
 * dispatched by a dead window as outcome_unknown is reserved to a user's stop (AGENTS.md).
 */
export function relocatedWorkSettlementReason(targetRootPath: string): string {
  return `数据目录已迁移到 ${targetRootPath}，这个任务已随数据迁走，可能已在新目录执行过；在这里按中止收尾，不再执行。`;
}

export interface RelocatedWorkSettlementCounts {
  /** Top-level Turns stopped (recorded as interrupted; an orphan one as cancelled). */
  turnsStopped: number;
  /** Child Agent Turns stopped through their subtree. */
  childTurnsStopped: number;
  /** Child executions interrupted, each with its whole subtree. */
  childExecutionsInterrupted: number;
  /** Background child Agents of a completed parent Turn, stopped like from their own panel (they go idle). */
  backgroundChildrenStopped: number;
  /** Queued user messages cancelled. */
  queuedMessagesCancelled: number;
  /** Pending child continuations cancelled with their subtree. */
  childContinuationsCancelled: number;
  /** Questions and approvals that waited for the user, cancelled with their Turn. */
  interactionsCancelled: number;
  /** Model requests that never started, closed with their Turn. */
  modelRequestsClosed: number;
  /** Tool effects not dispatched yet, cancelled with their Turn. */
  effectsCancelled: number;
  /** Tool effects dispatched by a window that is gone, closed as outcome_unknown. */
  effectsClosedAsUnknown: number;
  /** Results already addressed to a stopped Turn, kept in its history instead of continuing it. */
  deliveriesTakenIn: number;
}

export type RelocatedWorkUnsettledKind =
  /** A pending result or message that would open a new Turn; no terminal transition exists for it. */
  | 'continuation_delivery'
  /** A finished background process of a Turn that had completed; its delivery would open a Turn. */
  | 'process_completion'
  /** A child answer not delivered yet; delivering it continues its parent Conversation. */
  | 'child_answer'
  /**
   * A background child of a completed parent Turn that has a queued continuation: only the subtree
   * interruption cancels that, and its interrupted answer continues the parent once.
   */
  | 'background_child'
  /** A queued continuation that is not an ordinary user message (cancelGuidance does not apply). */
  | 'queued_continuation'
  /** A Turn the stop path does not close here (child spawn or cancel in flight, inconsistent facts). */
  | 'needs_human'
  /** Settling this item threw; `detail` has the error. */
  | 'failed';

/**
 * The inventory lists whose items this module may only report (no existing transition closes them
 * without starting a Turn): opening the old directory may still run them once. Prompts list the
 * inventory's items of these lists; a kind that becomes settleable leaves this table, and the
 * prompts shrink with it.
 */
export const RELOCATED_WORK_REPORTED_ONLY: Readonly<Partial<Record<(typeof RELOCATED_WORK_LISTS)[number], RelocatedWorkUnsettledKind>>> = Object.freeze({
  pendingDeliveryIds: 'continuation_delivery',
  undeliveredAnswerIds: 'child_answer',
  pendingProcessCompletionIds: 'process_completion'
});

export interface RelocatedWorkUnsettled {
  conversationId: string;
  kind: RelocatedWorkUnsettledKind;
  id: string;
  detail: string;
}

export interface RelocatedWorkSettlementResult {
  reason: string;
  counts: RelocatedWorkSettlementCounts;
  /** Work a live Host executes: its durable stop request is written and that Host closes it. */
  live: Array<{ conversationId: string; id: string }>;
  unsettled: RelocatedWorkUnsettled[];
}

const SOURCE_PREFIX = 'data-root-relocated';
const CONTROL_LEASE_MS = 30_000;
const CHILD_RUNNING_STATUSES = ['starting', 'active', 'interrupting'] as const;
const STOPPED_TERMINAL_STATUSES = new Set(['interrupted', 'cancelled']);

type TurnOutcome = 'stopped' | 'terminal' | 'live' | 'unsupported' | 'needs_human' | 'failed';
type IncludedChild = { parentChildExecutionId: string | null; parentTurn: DomainRow | null };

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
  const inventory = parseRelocatedWorkInventory(input.inventory);
  if (typeof input.targetRootPath !== 'string' || input.targetRootPath.trim().length === 0) {
    throw new TypeError('settleRelocatedWork requires the new data directory.');
  }
  return new RelocatedWorkSettlement(
    input.application,
    inventory,
    relocatedWorkSettlementReason(input.targetRootPath)
  ).run();
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
    deliveriesTakenIn: 0
  };
  private readonly live: RelocatedWorkSettlementResult['live'] = [];
  private readonly unsettled: RelocatedWorkUnsettled[] = [];
  private readonly hostBootId: string;
  private readonly leaseOwnerId: string;

  public constructor(
    private readonly application: ReliableKernelApplication,
    private readonly inventory: RelocatedWorkInventory,
    private readonly reason: string
  ) {
    this.hostBootId = application.database.hostBootId;
    this.leaseOwnerId = `${SOURCE_PREFIX}:${this.hostBootId}`;
  }

  public async run(): Promise<RelocatedWorkSettlementResult> {
    const conversations: RelocatedConversationWork[] = [];
    for (const conversation of this.inventory.conversations) {
      if (await this.get('Conversation', conversation.conversationId)) conversations.push(conversation);
    }
    // A queued message goes first, so no Turn ending below admits it.
    for (const conversation of conversations) await this.cancelQueuedMessages(conversation.conversationId);
    // Parents stop before their children: an interrupted child's partial answer then only
    // notifies a stopped parent instead of continuing it.
    for (const conversation of conversations) await this.stopTopLevelTurns(conversation.conversationId);
    await this.interruptChildren(new Set(conversations.map((conversation) => conversation.conversationId)));
    const listed = new Set(conversations.map((conversation) => conversation.conversationId));
    for (const conversation of conversations) {
      await this.reportPendingDeliveries(conversation.conversationId);
      await this.reportUndeliveredAnswers(conversation);
    }
    await this.reportProcessCompletions(listed);
    return {
      reason: this.reason,
      counts: { ...this.counts },
      live: [...this.live],
      unsettled: [...this.unsettled]
    };
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
          source: { kind: 'command', key: `${SOURCE_PREFIX}:message:${intentId}` },
          conversationId,
          intentId,
          expectedRevisionSeq: revisionSeq.toString()
        });
        if (!result.deduplicated) this.counts.queuedMessagesCancelled += 1;
      } catch (error) {
        if (isConversationRuntimeOwnerBusyError(error)) {
          this.live.push({ conversationId, id: intentId });
        } else if (/not an ordinary queued guidance message/.test(errorMessage(error))) {
          this.unsettled.push({
            conversationId, kind: 'queued_continuation', id: intentId,
            detail: '排队的续跑不是普通消息，没有现成的取消转换；打开后会被执行。'
          });
        } else {
          this.unsettled.push({ conversationId, kind: 'failed', id: intentId, detail: errorMessage(error) });
        }
      }
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
          source: { kind: 'command', key: `${SOURCE_PREFIX}:turn:${turnId}` },
          turnId,
          reason: this.reason
        });
        if (requested.ignoredBecauseTerminal) return 'terminal';
      }
      await this.recordDeadHostSpawns(turnId);
      const outcome = await this.application.database.conversationOwners.run(
        conversationId,
        () => this.settleOwnedTurn(turnId)
      );
      if (outcome === 'stopped') await this.countClosedWork(before);
      else if (outcome === 'live') this.live.push({ conversationId, id: turnId });
      else if (outcome === 'unsupported' || outcome === 'needs_human') {
        this.unsettled.push({
          conversationId, kind: 'needs_human', id: turnId,
          detail: outcome === 'unsupported'
            ? '子 Agent 的派生或取消仍在进行，停止路径不在这里收尾；已记录停止请求。'
            : 'Turn 的终态事实不一致，需要人工处理；已记录停止请求。'
        });
      } else if (outcome === 'failed') {
        this.unsettled.push({ conversationId, kind: 'failed', id: turnId, detail: '停止请求没有被收尾路径接受。' });
      }
      return outcome;
    } catch (error) {
      if (isConversationRuntimeOwnerBusyError(error)) {
        this.live.push({ conversationId, id: turnId });
        return 'live';
      }
      this.unsettled.push({ conversationId, kind: 'failed', id: turnId, detail: errorMessage(error) });
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
        source: { kind: 'recovery', key: `${SOURCE_PREFIX}:finalize:${turnId}` },
        turnId,
        terminalStatus: 'cancelled',
        reason: this.reason
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
            sourceKey: `${SOURCE_PREFIX}:dead-host:${turnId}`,
            effectIntentIds: current.effectIntentIds,
            reason: this.reason
          });
          this.counts.effectsClosedAsUnknown += unknown;
        } else {
          await phaseD.reconcileArrivedReceipts(current.receiptEffectIntentIds);
        }
        await this.closePendingInteractions(turnId);
        return this.application.agentLoop.terminateRequested(turnId, SOURCE_PREFIX);
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
      const source = { kind: 'command' as const, key: `${SOURCE_PREFIX}:interaction:${requestId}` };
      const response = { reason: this.reason };
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
      const [parentLink] = await this.list('ChildExecutionParentLink', { child_execution_id: childExecutionId });
      if (!parentLink) continue;
      const parentTurn = await this.get('Turn', String(parentLink.parent_turn_id));
      if (!listed.has(String(child.child_conversation_id)) && !(parentTurn && listed.has(String(parentTurn.conversation_id)))) {
        continue;
      }
      included.set(childExecutionId, {
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
        if (await this.stopDetachedChild(rootId, root)) detached.add(rootId);
        else await this.interruptSubtreeOf(rootId, root);
      }
    }
  }

  /**
   * A background child whose parent Turn completed, stopped like from its own panel. False when that
   * stop does not end its work: it has a queued continuation (only the subtree interruption cancels
   * it) or no Turn yet.
   */
  private async stopDetachedChild(childExecutionId: string, entry: IncludedChild): Promise<boolean> {
    if (!await this.completedSuccessfully(entry.parentTurn)) return false;
    if ((await this.list('ChildExecutionIntentLink', { child_execution_id: childExecutionId, state: 'pending' })).length > 0) {
      return false;
    }
    const links = await this.list('ChildExecutionActiveTurnLink', { child_execution_id: childExecutionId });
    if (links.length === 0) return false;
    let stopped = 0;
    for (const link of links) {
      const turn = await this.get('Turn', String(link.turn_id));
      // A Turn already ended (a second settlement) leaves the child to go idle in its scheduler.
      if (!turn || turn.status !== 'active') continue;
      if (await this.stopTurn(String(turn.conversation_id), String(turn.id), true) === 'stopped') stopped += 1;
    }
    this.counts.childTurnsStopped += stopped;
    if (stopped > 0) this.counts.backgroundChildrenStopped += 1;
    return true;
  }

  private async interruptSubtreeOf(rootId: string, root: IncludedChild): Promise<void> {
    const parentConversationId = root.parentTurn ? String(root.parentTurn.conversation_id) : undefined;
    try {
      const interrupted = await this.application.runtime.children.interruptSubtree({
        sourceKey: `${SOURCE_PREFIX}:child:${rootId}`,
        childExecutionId: rootId,
        reason: this.reason
      });
      if (!interrupted.deduplicated) {
        this.counts.childExecutionsInterrupted += interrupted.lineageIds.length;
        this.counts.childContinuationsCancelled += interrupted.intentsCancelled;
      }
      for (const turnId of interrupted.activeTurnIds) {
        const turn = await this.get('Turn', turnId);
        if (!turn || turn.status !== 'active') continue;
        const outcome = await this.stopTurn(String(turn.conversation_id), turnId, false);
        if (outcome !== 'stopped') continue;
        this.counts.childTurnsStopped += 1;
        const [membership] = await this.list('ChildExecutionTurnLink', { turn_id: turnId });
        if (String(membership?.child_execution_id) === rootId && await this.completedSuccessfully(root.parentTurn)) {
          this.unsettled.push({
            conversationId: parentConversationId ?? String(turn.conversation_id), kind: 'background_child', id: rootId,
            detail: '后台子 Agent 还有排队的续跑消息，只能按子树中断；派出它的父 Turn 已完成，子 Agent 的中断结果按现有规则会让父对话续跑一次。'
          });
        }
      }
    } catch (error) {
      this.unsettled.push({
        conversationId: parentConversationId ?? rootId, kind: 'failed', id: rootId, detail: errorMessage(error)
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
   * A pending delivery addressed to a Turn that has ended moves on through its own routing (the same
   * advance its wake performs). What then waits for a new Turn of the Conversation would start one:
   * no terminal transition exists for it, so it is only reported.
   */
  private async reportPendingDeliveries(conversationId: string): Promise<void> {
    for (const pending of await this.list('RuntimeDelivery', { target_conversation_id: conversationId, state: 'pending' })) {
      const deliveryId = String(pending.id);
      let delivery: DomainRow | null = pending;
      if (delivery.phase === 'current_turn' && delivery.target_turn_id !== null) {
        const target = await this.get('Turn', String(delivery.target_turn_id));
        // A Turn still active here is held by a live Host, which takes the delivery in.
        if (target?.status === 'active') continue;
        try {
          await this.application.database.conversationOwners.run(conversationId, () =>
            this.application.runtime.deliveries.advance(deliveryId));
        } catch (error) {
          if (isConversationRuntimeOwnerBusyError(error)) continue;
          this.unsettled.push({ conversationId, kind: 'failed', id: deliveryId, detail: errorMessage(error) });
          continue;
        }
        delivery = await this.get('RuntimeDelivery', deliveryId);
        if (!delivery || delivery.state !== 'pending') continue;
      }
      if (delivery.phase !== 'next_turn' || delivery.target_turn_id !== null) continue;
      if (!await this.opensTurn(delivery)) continue;
      this.unsettled.push({
        conversationId, kind: 'continuation_delivery', id: deliveryId,
        detail: '待投递的后台结果或消息会开启新的 Turn 续跑，没有现成的终态转换可以收尾。'
      });
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

  /** A child answer still to be delivered continues its parent when the delivery routing says so. */
  private async reportUndeliveredAnswers(conversation: RelocatedConversationWork): Promise<void> {
    for (const submissionId of conversation.undeliveredAnswerIds) {
      const submission = await this.get('AnswerSubmission', submissionId);
      if (!submission) continue;
      const routed = await this.list('RuntimeInboxItem', { source_kind: 'answer_submission', source_id: submissionId });
      if (routed.some((item) => item.state !== 'available')) continue;
      const bridge = await this.get('AnswerBridge', String(submission.answer_bridge_id));
      if (!bridge) continue;
      const childExecutionId = String(bridge.child_execution_id);
      const [parentLink] = await this.list('ChildExecutionParentLink', { child_execution_id: childExecutionId });
      const parentTurn = parentLink ? await this.get('Turn', String(parentLink.parent_turn_id)) : null;
      if (!parentTurn || parentTurn.status === 'active') continue;
      const [termination] = await this.list('TurnTermination', { turn_id: String(parentTurn.id) });
      const status = String(termination?.terminal_status);
      const failedSubmissionId = stablePhaseFId('answer_submission', 'child-drive-failed', childExecutionId, String(submission.turn_id));
      const continues = status === 'completed' || (
        STOPPED_TERMINAL_STATUSES.has(status)
        && submission.interrupted === 0n
        && bridge.current_submission_id === submissionId
        && submissionId !== failedSubmissionId
      );
      if (!continues) continue;
      this.unsettled.push({
        conversationId: conversation.conversationId, kind: 'child_answer', id: submissionId,
        detail: '子 Agent 的答复尚未送达，送达后会让父对话续跑，没有现成的终态转换可以收尾。'
      });
    }
  }

  private async reportProcessCompletions(listed: ReadonlySet<string>): Promise<void> {
    const dispatches = [
      ...await this.list('ProcessCompletionDispatch', { state: 'pending' }),
      ...await this.list('ProcessCompletionDispatch', { state: 'claimed' })
    ];
    for (const dispatch of dispatches) {
      const receipt = await this.get('ProcessReceipt', String(dispatch.process_receipt_id));
      if (!receipt) continue;
      const [source] = await this.list('ProcessCompletionSourceLink', { process_id: String(receipt.process_id) });
      if (!source || !listed.has(String(source.conversation_id))) continue;
      // A stopped source Turn only notifies; a live Host's active Turn takes the result in.
      if (!await this.completedSuccessfully(await this.get('Turn', String(source.source_turn_id)))) continue;
      this.unsettled.push({
        conversationId: String(source.conversation_id), kind: 'process_completion', id: String(dispatch.id),
        detail: '后台进程在已完成的 Turn 之后结束，它的完成通知送达后会开启新的 Turn 续跑，没有现成的终态转换可以收尾。'
      });
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
