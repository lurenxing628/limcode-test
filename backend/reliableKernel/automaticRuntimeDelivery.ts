import type { RuntimeDeliveryPhase } from './answerDelivery';
import {
  isChildExecutionInterrupting,
  isChildExecutionPermanentlyTerminal,
  requireChildExecutionStatus
} from './childExecutionState';
import {
  TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION,
  TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY
} from './nativeToolFacts';
import {
  isTransactionAssertionFailure,
  sqliteUniqueFailureIncludes,
  stablePhaseFId
} from './phaseFIdentity';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';


export type AutomaticRuntimeDeliveryReason =
  | 'source_turn_active'
  | 'source_turn_final_output_fenced'
  | 'source_turn_completed'
  | 'source_turn_stopped_with_deliverable_answer'
  | 'source_turn_not_successful'
  | 'source_turn_missing'
  | 'source_turn_conversation_mismatch'
  | 'conversation_not_active'
  | 'terminal_evidence_incomplete'
  | 'child_generation_stale_or_terminal'
  | 'collaboration_message_waiting'
  | 'collaboration_followup_requested'
  | 'collaboration_queued_behind_active_turn'
  | 'collaboration_notification_expired';

export interface AutomaticRuntimeDeliveryDecision {
  phase: RuntimeDeliveryPhase;
  targetTurnId: string | null;
  sourceTurnId: string;
  targetConversationId: string;
  reason: AutomaticRuntimeDeliveryReason;
  childExecutionId: string | null;
  /** CAS assertions that preserve the authority snapshot until delivery injection/retarget. */
  authoritySteps: RepositoryTransactionStep[];
}

interface ChildGenerationAuthority {
  childExecutionId: string;
  currentAllowed: boolean;
  continuationAllowed: boolean;
  steps: RepositoryTransactionStep[];
}

interface DeliverySourceAuthority {
  continueAfterStoppedSource: boolean;
  steps: RepositoryTransactionStep[];
}

const TERMINAL_FAILURES = new Set(['interrupted', 'cancelled', 'failed', 'outcome_unknown']);
/**
 * One fail-closed policy for automatic Process/Child answer delivery.
 *
 * It deliberately routes from the immutable source Turn and durable Inbox source facts, never from
 * whichever Turn happens to be active when a delayed callback arrives. Callers must include
 * `authoritySteps` in the transaction that injects/retargets the delivery; a read-only decision is
 * only a scheduling hint.
 */
export class AutomaticRuntimeDeliveryRouter {
  public constructor(private readonly database: RuntimeDatabase) {}

  /**
   * Fences a no-tool-call Provider result before it becomes visible. A delivery that won first
   * makes this return false so the Agent loop absorbs it and asks the model for a new final answer.
   */
  public async establishFinalOutputFence(input: {
    turnId: string;
    modelRequestId: string;
  }): Promise<{ established: boolean; fenceId: string }> {
    const turnId = requireId(input.turnId, 'turnId');
    const modelRequestId = requireId(input.modelRequestId, 'modelRequestId');
    const fenceId = stablePhaseFId('turn_final_output_fence', turnId, modelRequestId);
    const existing = await this.list('TurnFinalOutputFence', { turn_id: turnId }, 2);
    if (existing.length > 1) throw new Error(`Turn ${turnId} has multiple final-output fences.`);
    if (existing.length === 1) {
      assertFinalFenceReplay(existing[0], fenceId, turnId, modelRequestId);
      return { established: true, fenceId };
    }
    const [turn, request] = await Promise.all([
      this.requireExisting('Turn', turnId),
      this.requireExisting('ModelRequest', modelRequestId)
    ]);
    if (turn.status !== 'active' || request.turn_id !== turnId || request.status !== 'terminal') {
      return { established: false, fenceId };
    }
    // Legacy rule: a final-output fence requires a no-tool-call request. The native exception must
    // atomically prove every candidate-linked call terminal, context-closed and server-admitted —
    // anything less stays fail-closed and the Turn continues with a carrier request instead.
    const sourceLinks = await this.list('ToolCallSourceLink', { model_request_id: modelRequestId }, 500);
    let callGuardSteps: RepositoryTransactionStep[];
    if (sourceLinks.length === 0) {
      callGuardSteps = [
        DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').assertNone({ model_request_id: modelRequestId })
      ];
    } else {
      const proof = await this.buildNativeDeliveredCallGuard(sourceLinks);
      if (!proof) return { established: false, fenceId };
      callGuardSteps = proof;
    }
    const now = new Date().toISOString();
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: turnId }),
        DOMAIN_REPOSITORIES.domain('ModelRequest').assert(modelRequestId, {
          turn_id: turnId,
          status: 'terminal'
        }),
        ...callGuardSteps,
        DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assertNone({
          target_turn_id: turnId,
          phase: 'current_turn',
          state: 'pending'
        }),
        DOMAIN_REPOSITORIES.domain('PendingTurnInput').assertNone({
          turn_id: turnId,
          input_kind: 'runtime_delivery',
          state: 'pending'
        }),
        DOMAIN_REPOSITORIES.domain('TurnFinalOutputFence').insert({
          id: fenceId,
          turn_id: turnId,
          model_request_id: modelRequestId,
          created_at: now
        })
      ]);
      return { established: true, fenceId };
    } catch (error) {
      const raced = await this.list('TurnFinalOutputFence', { turn_id: turnId }, 2);
      if (raced.length === 1) {
        assertFinalFenceReplay(raced[0], fenceId, turnId, modelRequestId);
        return { established: true, fenceId };
      }
      if (isTransactionAssertionFailure(error) || sqliteUniqueFailureIncludes(error, [
        'turn_final_output_fence.id',
        'turn_final_output_fence.turn_id',
        'turn_final_output_fence.model_request_id'
      ])) return { established: false, fenceId };
      throw error;
    }
  }

  /**
   * Atomic guard replacing the no-tool-call assertNone for a completed native logical request.
   * Returns the frozen assertion steps only when EVERY linked call is durably admitted, terminal,
   * settled with its result occurrence appended, and server-admission delivered. The proof freezes
   * the exact row identities it relied on, so a concurrent fact change fails the transaction
   * instead of slipping a half-proven fence through.
   */
  private async buildNativeDeliveredCallGuard(
    sourceLinks: readonly DomainRow[]
  ): Promise<RepositoryTransactionStep[] | null> {
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').assertExactIds(
        { model_request_id: requireId(sourceLinks[0].model_request_id, 'ToolCallSourceLink.model_request_id') },
        sourceLinks.map((link) => requireId(link.id, 'ToolCallSourceLink.id'))
      )
    ];
    for (const link of sourceLinks) {
      const toolCallId = requireId(link.tool_call_id, 'ToolCallSourceLink.tool_call_id');
      const [call, results, admissions, deliveries] = await Promise.all([
        this.maybeGet('ToolCall', toolCallId),
        this.list('ToolModelResult', { tool_call_id: toolCallId }, 2),
        this.list('ToolCallEvent', {
          tool_call_id: toolCallId,
          event_kind: TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION
        }, 2),
        this.list('ToolCallEvent', {
          tool_call_id: toolCallId,
          event_kind: TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY
        }, 2)
      ]);
      if (!call || call.status !== 'terminal') return null;
      if (results.length !== 1) return null;
      if (admissions.length !== 1 || deliveries.length !== 1) return null;
      const resultId = requireId(results[0].id, 'ToolModelResult.id');
      const contextSources = await this.list('ContextSegmentSource', {
        source_kind: 'tool_model_result',
        source_id: resultId
      }, 2);
      if (contextSources.length !== 1) return null;
      steps.push(
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolCallId, { status: call.status }),
        DOMAIN_REPOSITORIES.domain('ToolModelResult').assertExactIds(
          { tool_call_id: toolCallId },
          [resultId]
        ),
        DOMAIN_REPOSITORIES.domain('ContextSegmentSource').assertExactIds(
          { source_kind: 'tool_model_result', source_id: resultId },
          [requireId(contextSources[0].id, 'ContextSegmentSource.id')]
        ),
        DOMAIN_REPOSITORIES.domain('ToolCallEvent').assertExactIds(
          { tool_call_id: toolCallId, event_kind: TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION },
          [requireId(admissions[0].id, 'ToolCallEvent.id')]
        ),
        DOMAIN_REPOSITORIES.domain('ToolCallEvent').assertExactIds(
          { tool_call_id: toolCallId, event_kind: TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY },
          [requireId(deliveries[0].id, 'ToolCallEvent.id')]
        )
      );
    }
    return steps;
  }

  public async resolve(input: {
    inboxItemId: string;
    targetConversationId: string;
    sourceTurnId: string;
  }): Promise<AutomaticRuntimeDeliveryDecision> {
    const inboxItemId = requireId(input.inboxItemId, 'inboxItemId');
    const inbox = await this.requireExisting('RuntimeInboxItem', inboxItemId);
    if (inbox.source_kind === 'collaboration_message') return this.resolveCollaboration(input, inbox);
    const targetConversationId = requireId(input.targetConversationId, 'targetConversationId');
    const sourceTurnId = requireId(input.sourceTurnId, 'sourceTurnId');
    const [conversation, sourceTurn] = await Promise.all([
      this.maybeGet('Conversation', targetConversationId),
      this.maybeGet('Turn', sourceTurnId)
    ]);
    if (!sourceTurn) {
      return decision({
        targetConversationId,
        sourceTurnId,
        reason: 'source_turn_missing'
      });
    }
    if (sourceTurn.conversation_id !== targetConversationId) {
      return decision({
        targetConversationId,
        sourceTurnId,
        reason: 'source_turn_conversation_mismatch'
      });
    }
    if (!conversation || conversation.status !== 'active') {
      return decision({
        targetConversationId,
        sourceTurnId,
        reason: 'conversation_not_active'
      });
    }

    const [terminations, fences, childAuthority] = await Promise.all([
      this.list('TurnTermination', { turn_id: sourceTurnId }, 2),
      this.list('TurnFinalOutputFence', { turn_id: sourceTurnId }, 2),
      this.childGenerationAuthority(sourceTurnId)
    ]);
    if (terminations.length > 1) throw new Error(`Turn ${sourceTurnId} has multiple TurnTerminations.`);
    if (fences.length > 1) throw new Error(`Turn ${sourceTurnId} has multiple final-output fences.`);
    const common: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('Conversation').assert(targetConversationId, { status: 'active' }),
      DOMAIN_REPOSITORIES.domain('Turn').assert(sourceTurnId, {
        conversation_id: targetConversationId,
        status: sourceTurn.status
      }),
      ...childAuthority.steps
    ];

    if (sourceTurn.status === 'active') {
      if (terminations.length !== 0) {
        return decision({
          targetConversationId,
          sourceTurnId,
          reason: 'terminal_evidence_incomplete',
          childExecutionId: childAuthority.childExecutionId,
          authoritySteps: common
        });
      }
      if (fences.length === 1) {
        if (!childAuthority.continuationAllowed) {
          return decision({
            targetConversationId,
            sourceTurnId,
            reason: 'child_generation_stale_or_terminal',
            childExecutionId: childAuthority.childExecutionId,
            authoritySteps: common
          });
        }
        const fence = fences[0];
        return decision({
          phase: 'next_turn',
          targetConversationId,
          sourceTurnId,
          reason: 'source_turn_final_output_fenced',
          childExecutionId: childAuthority.childExecutionId,
          authoritySteps: [
            ...common,
            DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: sourceTurnId }),
            DOMAIN_REPOSITORIES.domain('TurnFinalOutputFence').assert(requireId(fence.id, 'TurnFinalOutputFence.id'), {
              turn_id: sourceTurnId,
              model_request_id: fence.model_request_id
            })
          ]
        });
      }
      if (!childAuthority.currentAllowed) {
        return decision({
          targetConversationId,
          sourceTurnId,
          reason: 'child_generation_stale_or_terminal',
          childExecutionId: childAuthority.childExecutionId,
          authoritySteps: common
        });
      }
      return decision({
        phase: 'current_turn',
        targetTurnId: sourceTurnId,
        targetConversationId,
        sourceTurnId,
        reason: 'source_turn_active',
        childExecutionId: childAuthority.childExecutionId,
        authoritySteps: [
          ...common,
          DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: sourceTurnId }),
          DOMAIN_REPOSITORIES.domain('TurnFinalOutputFence').assertNone({ turn_id: sourceTurnId })
        ]
      });
    }

    if (sourceTurn.status !== 'terminated' || terminations.length !== 1) {
      return decision({
        targetConversationId,
        sourceTurnId,
        reason: 'terminal_evidence_incomplete',
        childExecutionId: childAuthority.childExecutionId,
        authoritySteps: common
      });
    }
    const termination = terminations[0];
    const terminalStatus = String(termination.terminal_status);
    const terminalSteps = [
      ...common,
      DOMAIN_REPOSITORIES.domain('TurnTermination').assert(requireId(termination.id, 'TurnTermination.id'), {
        turn_id: sourceTurnId,
        terminal_status: terminalStatus
      })
    ];
    if (terminalStatus === 'completed') {
      if (!childAuthority.continuationAllowed) {
        return decision({
          targetConversationId,
          sourceTurnId,
          reason: 'child_generation_stale_or_terminal',
          childExecutionId: childAuthority.childExecutionId,
          authoritySteps: terminalSteps
        });
      }
      return decision({
        phase: 'next_turn',
        targetConversationId,
        sourceTurnId,
        reason: 'source_turn_completed',
        childExecutionId: childAuthority.childExecutionId,
        authoritySteps: terminalSteps
      });
    }
    if (terminalStatus === 'interrupted' || terminalStatus === 'cancelled') {
      const sourceAuthority = await this.deliverySourceAuthority(inboxItemId, sourceTurnId);
      const stoppedSourceSteps = [...terminalSteps, ...sourceAuthority.steps];
      if (sourceAuthority.continueAfterStoppedSource) {
        if (!childAuthority.continuationAllowed) {
          return decision({
            targetConversationId,
            sourceTurnId,
            reason: 'child_generation_stale_or_terminal',
            childExecutionId: childAuthority.childExecutionId,
            authoritySteps: stoppedSourceSteps
          });
        }
        return decision({
          phase: 'next_turn',
          targetConversationId,
          sourceTurnId,
          reason: 'source_turn_stopped_with_deliverable_answer',
          childExecutionId: childAuthority.childExecutionId,
          authoritySteps: stoppedSourceSteps
        });
      }
      return decision({
        targetConversationId,
        sourceTurnId,
        reason: 'source_turn_not_successful',
        childExecutionId: childAuthority.childExecutionId,
        authoritySteps: stoppedSourceSteps
      });
    }
    if (!TERMINAL_FAILURES.has(terminalStatus)) {
      throw new Error(`Turn ${sourceTurnId} has unsupported terminal status ${terminalStatus}.`);
    }
    return decision({
      targetConversationId,
      sourceTurnId,
      reason: 'source_turn_not_successful',
      childExecutionId: childAuthority.childExecutionId,
      authoritySteps: terminalSteps
    });
  }

  /** Collaboration has destination authority, separate from the sender's Turn or user authority. */
  private async resolveCollaboration(input: {
    inboxItemId: string; targetConversationId: string; sourceTurnId: string;
  }, inbox: DomainRow): Promise<AutomaticRuntimeDeliveryDecision> {
    const message = await this.requireExisting('CollaborationMessage', requireId(inbox.source_id, 'Collaboration message id'));
    const links = await this.list('CollaborationMessageTargetLink', { message_id: message.id }, 2);
    if (links.length !== 1 || links[0].conversation_id !== input.targetConversationId || links[0].inbox_item_id !== input.inboxItemId) throw new Error('Collaboration delivery destination conflicts with its immutable target link.');
    if (message.mode !== 'message' && message.mode !== 'followup') throw new Error('Unsupported collaboration mode.');
    const sources = await this.list('CollaborationMessageSourceLink', { message_id: message.id }, 2);
    if (sources.length !== 1) throw new Error('Collaboration message has no unique source.');
    const boardNotice = sources[0].source_kind === 'board';
    const conversation = await this.maybeGet('Conversation', input.targetConversationId);
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').assert(input.inboxItemId, { source_kind: 'collaboration_message', source_id: message.id }),
      DOMAIN_REPOSITORIES.domain('CollaborationMessage').assert(String(message.id), { mode: message.mode }),
      DOMAIN_REPOSITORIES.domain('CollaborationMessageTargetLink').assert(String(links[0].id), { conversation_id: input.targetConversationId, inbox_item_id: input.inboxItemId })
    ];
    if (!conversation || conversation.status !== 'active') return decision({ ...input, reason: 'conversation_not_active', authoritySteps: steps });
    steps.push(DOMAIN_REPOSITORIES.domain('Conversation').assert(input.targetConversationId, { status: 'active' }));
    const children = await this.list('ChildExecution', { child_conversation_id: input.targetConversationId }, 2);
    if (children.length > 1) throw new Error('Collaboration target has multiple child memberships.');
    const child = children[0];
    if (child) {
      steps.push(DOMAIN_REPOSITORIES.domain('ChildExecution').assert(String(child.id), { status: child.status, child_conversation_id: input.targetConversationId }));
      if (!['active', 'idle'].includes(String(child.status))) return decision({ ...input, reason: 'child_generation_stale_or_terminal', childExecutionId: String(child.id), authoritySteps: steps });
    }
    const turns = await listAllDomainRows(this.database, 'Turn', { conversation_id: input.targetConversationId });
    turns.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)) || String(right.id).localeCompare(String(left.id)));
    const active = turns.filter((turn) => turn.status === 'active');
    if (active.length > 1) throw new Error('Collaboration target has multiple active Turns.');
    const turn = active[0];
    const anchor = turn ?? turns[0];
    const sourceTurnId = anchor ? String(anchor.id) : input.sourceTurnId;
    if (boardNotice && (!turn || links[0].anchor_turn_id !== turn.id)) return decision({ ...input, sourceTurnId, reason: 'collaboration_notification_expired', authoritySteps: steps });
    // A send queued behind the target's running Turn is never injected into that Turn. It stays a
    // next-Turn delivery until the anchor Turn ends; the level-triggered wake then routes it.
    if (!boardNotice && turn && links[0].anchor_turn_id === turn.id) {
      steps.push(DOMAIN_REPOSITORIES.domain('CollaborationMessageTargetLink').assert(String(links[0].id), { anchor_turn_id: turn.id }),
        DOMAIN_REPOSITORIES.domain('Turn').assert(String(turn.id), { status: 'active', conversation_id: input.targetConversationId }),
        DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: turn.id }));
      return decision({ ...input, sourceTurnId, phase: 'next_turn', reason: 'collaboration_queued_behind_active_turn', childExecutionId: child ? String(child.id) : undefined, authoritySteps: steps });
    }
    if (!turn) {
      steps.push(DOMAIN_REPOSITORIES.domain('Turn').assertNone({ conversation_id: input.targetConversationId, status: 'active' }));
      if (anchor) steps.push(DOMAIN_REPOSITORIES.domain('Turn').assert(String(anchor.id), { status: anchor.status }));
      return decision({ ...input, sourceTurnId, phase: 'next_turn', reason: message.mode === 'followup' ? 'collaboration_followup_requested' : 'collaboration_message_waiting', childExecutionId: child ? String(child.id) : undefined, authoritySteps: steps });
    }
    const fences = await this.list('TurnFinalOutputFence', { turn_id: turn.id }, 2);
    steps.push(DOMAIN_REPOSITORIES.domain('Turn').assert(String(turn.id), { status: 'active', conversation_id: input.targetConversationId }), DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: turn.id }));
    if (fences.length) {
      steps.push(DOMAIN_REPOSITORIES.domain('TurnFinalOutputFence').assert(String(fences[0].id), { turn_id: turn.id }));
      if (boardNotice) return decision({ ...input, sourceTurnId, reason: 'collaboration_notification_expired', authoritySteps: steps });
      return decision({ ...input, sourceTurnId, phase: 'next_turn', reason: 'source_turn_final_output_fenced', childExecutionId: child ? String(child.id) : undefined, authoritySteps: steps });
    }
    steps.push(DOMAIN_REPOSITORIES.domain('TurnFinalOutputFence').assertNone({ turn_id: turn.id }));
    return decision({ ...input, sourceTurnId, phase: 'current_turn', targetTurnId: String(turn.id), reason: 'source_turn_active', childExecutionId: child ? String(child.id) : undefined, authoritySteps: steps });
  }

  /** Revalidates and, if necessary, retargets one still-pending delivery in the same CAS. */
  public async reconcilePendingDelivery(input: {
    deliveryId: string;
    targetConversationId: string;
    sourceTurnId: string;
  }): Promise<{ delivery: DomainRow; decision: AutomaticRuntimeDeliveryDecision; changed: boolean }> {
    const deliveryId = requireId(input.deliveryId, 'deliveryId');
    const delivery = await this.requireExisting('RuntimeDelivery', deliveryId);
    const decision = await this.resolve({
      ...input,
      inboxItemId: requireId(delivery.inbox_item_id, 'RuntimeDelivery.inbox_item_id')
    });
    if (delivery.state !== 'pending') return { delivery, decision, changed: false };
    if (delivery.target_conversation_id !== decision.targetConversationId) {
      throw new Error('RuntimeDelivery target Conversation conflicts with automatic delivery authority.');
    }
    const changed = delivery.phase !== decision.phase || delivery.target_turn_id !== decision.targetTurnId;
    const now = new Date().toISOString();
    await this.database.transaction([
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(deliveryId, {
        state: 'pending',
        phase: delivery.phase,
        target_turn_id: delivery.target_turn_id,
        target_conversation_id: decision.targetConversationId,
        attempt_seq: delivery.attempt_seq
      }),
      ...decision.authoritySteps,
      ...(changed ? [DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update(deliveryId, {
        phase: decision.phase,
        target_turn_id: decision.targetTurnId,
        ...(decision.reason === 'collaboration_notification_expired' ? { state: 'failed', failure_reason: 'board-notification-expired' } : {}),
        updated_at: now
      })] : [])
    ]);
    return {
      delivery: await this.requireExisting('RuntimeDelivery', deliveryId),
      decision,
      changed
    };
  }

  private async deliverySourceAuthority(
    inboxItemId: string,
    sourceTurnId: string
  ): Promise<DeliverySourceAuthority> {
    const inbox = await this.requireExisting('RuntimeInboxItem', inboxItemId);
    const sourceKind = requireId(inbox.source_kind, 'RuntimeInboxItem.source_kind');
    const sourceId = requireId(inbox.source_id, 'RuntimeInboxItem.source_id');
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('RuntimeInboxItem').assert(inboxItemId, {
        source_kind: sourceKind,
        source_id: sourceId
      })
    ];
    if (sourceKind !== 'answer_submission') {
      return { continueAfterStoppedSource: false, steps };
    }

    const submission = await this.requireExisting('AnswerSubmission', sourceId);
    const interrupted = requireBigInt(submission.interrupted, 'AnswerSubmission.interrupted');
    if (interrupted !== 0n && interrupted !== 1n) {
      throw new Error(`AnswerSubmission has unsupported interrupted flag ${String(interrupted)}.`);
    }
    const answerBridgeId = requireId(submission.answer_bridge_id, 'AnswerSubmission.answer_bridge_id');
    steps.push(DOMAIN_REPOSITORIES.domain('AnswerSubmission').assert(sourceId, {
      answer_bridge_id: answerBridgeId,
      turn_id: submission.turn_id,
      interrupted
    }));
    const bridge = await this.requireExisting('AnswerBridge', answerBridgeId);
    const childExecutionId = requireId(bridge.child_execution_id, 'AnswerBridge.child_execution_id');
    steps.push(DOMAIN_REPOSITORIES.domain('AnswerBridge').assert(answerBridgeId, {
      child_execution_id: childExecutionId,
      current_submission_id: sourceId
    }));
    const parentLinks = await this.list('ChildExecutionParentLink', {
      child_execution_id: childExecutionId
    }, 2);
    if (parentLinks.length !== 1) {
      throw new Error(`Answer delivery requires exactly one parent link for ChildExecution ${childExecutionId}.`);
    }
    const parentLink = parentLinks[0];
    const parentLinkId = requireId(parentLink.id, 'ChildExecutionParentLink.id');
    const answerParentTurnId = requireId(parentLink.parent_turn_id, 'ChildExecutionParentLink.parent_turn_id');
    steps.push(
      DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').assertExactIds(
        { child_execution_id: childExecutionId },
        [parentLinkId]
      ),
      DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').assert(parentLinkId, {
        child_execution_id: childExecutionId,
        parent_turn_id: answerParentTurnId
      })
    );
    const answerSourceTurnId = requireId(submission.turn_id, 'AnswerSubmission.turn_id');
    // The current schema stores interrupted as a bit; child-drive failure uses this reserved stable ID
    // so it cannot acquire the stronger "normal answer may continue a stopped parent" authority.
    const failedSubmissionId = stablePhaseFId(
      'answer_submission',
      'child-drive-failed',
      childExecutionId,
      answerSourceTurnId
    );
    return {
      continueAfterStoppedSource: (
        answerParentTurnId === sourceTurnId
        && interrupted === 0n
        && sourceId !== failedSubmissionId
      ),
      steps
    };
  }

  private async childGenerationAuthority(sourceTurnId: string): Promise<ChildGenerationAuthority> {
    const memberships = await this.list('ChildExecutionTurnLink', { turn_id: sourceTurnId }, 2);
    if (memberships.length > 1) throw new Error(`Turn ${sourceTurnId} belongs to multiple ChildExecutions.`);
    if (memberships.length === 0) {
      return { childExecutionId: '', currentAllowed: true, continuationAllowed: true, steps: [] };
    }
    const membership = memberships[0];
    const childExecutionId = requireId(membership.child_execution_id, 'ChildExecutionTurnLink.child_execution_id');
    const [child, lineage, activeLinks] = await Promise.all([
      this.requireExisting('ChildExecution', childExecutionId),
      listAllDomainRows(this.database, 'ChildExecutionTurnLink', {
        child_execution_id: childExecutionId
      }),
      this.list('ChildExecutionActiveTurnLink', { child_execution_id: childExecutionId }, 2)
    ]);
    if (activeLinks.length > 1) throw new Error(`ChildExecution ${childExecutionId} has multiple active Turn links.`);
    const latest = [...lineage].sort((left, right) => compareInteger(right.turn_seq, left.turn_seq))[0];
    if (!latest) throw new Error(`ChildExecution ${childExecutionId} has no Turn lineage.`);
    const active = activeLinks[0] ?? null;
    const status = requireChildExecutionStatus(child.status);
    const isLatest = latest.turn_id === sourceTurnId;
    const blocked = isChildExecutionInterrupting(status)
      || status === 'interrupted'
      || isChildExecutionPermanentlyTerminal(status);
    const currentAllowed = isLatest
      && !blocked
      && status === 'active'
      && active?.turn_id === sourceTurnId;
    const continuationAllowed = isLatest
      && !blocked
      && (status === 'active' || status === 'idle')
      && (active === null || active.turn_id === sourceTurnId);
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('ChildExecution').assert(childExecutionId, { status: child.status }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').assert(requireId(membership.id, 'ChildExecutionTurnLink.id'), {
        child_execution_id: childExecutionId,
        turn_id: sourceTurnId,
        turn_seq: membership.turn_seq
      }),
      ...(active ? [DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assert(
        requireId(active.id, 'ChildExecutionActiveTurnLink.id'),
        { child_execution_id: childExecutionId, turn_id: active.turn_id }
      )] : [DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assertNone({
        child_execution_id: childExecutionId
      })])
    ];
    return { childExecutionId, currentAllowed, continuationAllowed, steps };
  }

  private async maybeGet(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return snapshot.snapshot[0] as DomainRow | null;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const row = await this.maybeGet(domain, id);
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })]);
    if (!Array.isArray(snapshot.snapshot[0])) throw new TypeError(`${domain} list did not return rows.`);
    return snapshot.snapshot[0] as DomainRow[];
  }
}

function decision(input: {
  phase?: RuntimeDeliveryPhase;
  targetTurnId?: string | null;
  targetConversationId: string;
  sourceTurnId: string;
  reason: AutomaticRuntimeDeliveryReason;
  childExecutionId?: string;
  authoritySteps?: RepositoryTransactionStep[];
}): AutomaticRuntimeDeliveryDecision {
  return {
    phase: input.phase ?? 'notify_only',
    targetTurnId: input.targetTurnId ?? null,
    targetConversationId: input.targetConversationId,
    sourceTurnId: input.sourceTurnId,
    reason: input.reason,
    childExecutionId: input.childExecutionId || null,
    authoritySteps: input.authoritySteps ?? []
  };
}

function compareInteger(left: unknown, right: unknown): number {
  const a = requireBigInt(left, 'integer');
  const b = requireBigInt(right, 'integer');
  return a === b ? 0 : a < b ? -1 : 1;
}

function assertFinalFenceReplay(
  fence: DomainRow,
  fenceId: string,
  turnId: string,
  modelRequestId: string
): void {
  if (fence.id !== fenceId || fence.turn_id !== turnId || fence.model_request_id !== modelRequestId) {
    throw new Error('Turn final-output fence identity was replayed with different facts.');
  }
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${label} must remain bigint.`);
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty id.`);
  return value;
}
