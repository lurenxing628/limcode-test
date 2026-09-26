import { BACKGROUND_ASK_USER_AUTO_ANSWER, normalizeAskUserToolRequest, resolveAskUserAnswer } from '../../shared/askUser';
import {
  createDelegatedPlanPrompt,
  createSubmitPlanToolOutput,
  DELEGATED_PLAN_APPROVAL_MESSAGE,
  normalizeSubmitPlanToolRequest,
  submitPlanOutputFromResult
} from '../../shared/planReview';
import type { SubmitPlanToolRequestRecord } from '../../shared/protocol';
import { requireTaskListOperation } from '../../shared/taskListProjection';
import { ContentAddressedStore, type ContentObjectMetadata, type PreparedContentObject } from './contentAddressedStore';
import {
  EffectControlPlane,
  preparedContentSteps,
  stablePhaseDId,
  type PhaseDCommandSource,
  type ToolSettlementResult,
  type ToolTerminalResult
} from './effectControlPlane';
import { canonicalPlainJson as canonicalJson, normalizePlainJson } from './plainJson';
import { frozenInteractionAutoApproval, readFrozenTurnAuthority } from './frozenAuthority';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';

export interface AskUserPauseResult {
  receiptId: string;
  requestId: string;
  operationId: string;
  pauseId: string;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface AskUserResolutionResult {
  receiptId: string;
  requestId: string;
  won: boolean;
  deduplicated: boolean;
  terminal?: ToolTerminalResult;
  commitSeq?: string;
}

export interface PlanReviewPauseResult extends AskUserPauseResult {
  proposalId: string;
}

export interface PlanReviewResolutionResult extends AskUserResolutionResult {
  proposalId: string;
}

export interface PlanDelegationRequest {
  sourceToolCallId: string;
  parentTurnId: string;
  requestedAgentId: string;
  prompt: string;
}

export interface PlanDelegationIdentity {
  childExecutionId: string;
  childConversationId: string;
  answerBridgeId: string;
  agentId: string;
  agentType: string;
}

export interface PlanDelegationResult {
  childExecutionId: string;
  childConversationId: string;
  childTurnId: string;
  answerBridgeId: string;
  agentId: string;
  agentType: string;
}

export interface PlanDelegationEnsureRequest extends PlanDelegationRequest {
  expected: PlanDelegationIdentity;
}

export interface PlanDelegator {
  preview(request: PlanDelegationRequest): Promise<PlanDelegationResult>;
  ensure(request: PlanDelegationEnsureRequest): Promise<PlanDelegationResult>;
  /**
   * Whether this Host may start the delegated child now: starting it runs the executor Agent, so
   * only a Host serving the parent Conversation does. Elsewhere the approval is only recorded and
   * the serving Host's resume of the parent Turn starts the child (completeRecordedPlanReview).
   */
  mayEnsure?(request: PlanDelegationRequest): Promise<boolean>;
}

export interface ExecutionApprovalPauseResult {
  receiptId: string;
  requestId: string;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface ExecutionApprovalResolutionResult {
  receiptId: string;
  requestId: string;
  won: boolean;
  approved: boolean;
  cancelled: boolean;
  deduplicated: boolean;
  terminal?: ToolTerminalResult;
  commitSeq?: string;
}

/** ask_user reuses generic Tool/Interaction/Pause/Resolution facts; there is no AskUser table. */
export class ToolInteractionControlPlane {
  private readonly now: () => string;
  private planDelegator: PlanDelegator | undefined;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly effects: EffectControlPlane,
    options: { now?: () => string; planDelegator?: PlanDelegator } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.planDelegator = options.planDelegator;
  }

  public setPlanDelegator(planDelegator: PlanDelegator): void {
    if (this.planDelegator && this.planDelegator !== planDelegator) {
      throw new Error('Plan delegator is already registered.');
    }
    this.planDelegator = planDelegator;
  }

  public async pauseForAskUser(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    prompt: unknown;
    waitDeadlineAt?: string | null;
  }): Promise<AskUserPauseResult> {
    const source = normalizeSource(input.source, ['internal'], 'ask-user-pause');
    const toolCallId = requireId(input.toolCallId, 'toolCallId');
    const facts = await this.requireActiveToolFacts(toolCallId);
    if (facts.toolCall.status !== 'pending' || facts.execution.status !== 'pending') {
      throw new Error(`ToolCall ${toolCallId} cannot enter ask_user waiting from ${String(facts.toolCall.status)}/${String(facts.execution.status)}.`);
    }
    const requestId = stablePhaseDId('interaction_request', `ask-user:${toolCallId}`);
    const operationId = stablePhaseDId('operation', `ask-user:${toolCallId}`);
    const pauseId = stablePhaseDId('outcome_pause', operationId);
    const receiptId = sourceReceiptId(source, 'ask-user-pause', toolCallId);
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) return this.replayPause(duplicate, receiptId, requestId, operationId, pauseId);
    const prompt = await this.contentStore.prepare(
      this.database,
      canonicalJson({ toolCallId, prompt: input.prompt }),
      'application/vnd.limcode.ask-user-prompt+json'
    );
    const now = this.timestamp();
    const committed = await this.commitSource({
      source,
      receiptId,
      conversationId: facts.conversation.id as string,
      turnId: facts.turn.id as string,
      steps: [
        DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
          conversation_id: facts.conversation.id,
          turn_id: facts.turn.id
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolCallId, { status: 'pending' }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(facts.execution.id as string, { status: 'pending' }),
        ...preparedContentSteps([prompt], 'ask_user_prompt'),
        DOMAIN_REPOSITORIES.domain('Operation').insertWithNextSequence({
          id: operationId,
          owner_kind: 'tool_execution',
          owner_id: facts.execution.id,
          tool_call_id: toolCallId,
          status: 'waiting_answer',
          created_at: now,
          updated_at: now
        }, {
          column: 'operation_seq',
          scope: { owner_kind: 'tool_execution', owner_id: facts.execution.id }
        }),
        DOMAIN_REPOSITORIES.domain('OutcomePause').insert({
          id: pauseId,
          operation_id: operationId,
          status: 'waiting',
          reason: 'ask_user',
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('InteractionRequest').insert({
          id: requestId,
          request_kind: 'ask_user',
          status: 'pending',
          prompt_object_id: prompt.metadata.id,
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('InteractionOwnerLink').insert({
          id: stablePhaseDId('interaction_owner_link', requestId),
          request_id: requestId,
          turn_id: facts.turn.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('InteractionToolCallLink').insert({
          id: stablePhaseDId('interaction_tool_call_link', requestId),
          request_id: requestId,
          tool_call_id: toolCallId,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').update(toolCallId, { status: 'waiting_answer', updated_at: now }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').update(facts.execution.id as string, {
          status: 'waiting_answer',
          wait_deadline_at: input.waitDeadlineAt === undefined ? null : input.waitDeadlineAt,
          updated_at: now
        })
      ]
    });
    if (committed.deduplicated) return this.replayPause(committed.receipt, receiptId, requestId, operationId, pauseId);
    return { receiptId, requestId, operationId, pauseId, deduplicated: false, commitSeq: committed.commitSeq };
  }

  /** submit_plan uses the same durable pause/first-response-wins protocol as ask_user. */
  public async pauseForPlanReview(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    request: unknown;
    waitDeadlineAt?: string | null;
  }): Promise<PlanReviewPauseResult> {
    const source = normalizeSource(input.source, ['internal'], 'plan-review-pause');
    const toolCallId = requireId(input.toolCallId, 'toolCallId');
    const facts = await this.requireActiveToolFacts(toolCallId);
    if (facts.toolCall.status !== 'pending' || facts.execution.status !== 'pending') {
      throw new Error(`ToolCall ${toolCallId} cannot enter plan review from ${String(facts.toolCall.status)}/${String(facts.execution.status)}.`);
    }
    const request = normalizeSubmitPlanToolRequest(input.request);
    const requestId = stablePhaseDId('interaction_request', `plan-review:${toolCallId}`);
    const proposalId = planProposalId(toolCallId);
    const operationId = stablePhaseDId('operation', `plan-review:${toolCallId}`);
    const pauseId = stablePhaseDId('outcome_pause', operationId);
    const receiptId = sourceReceiptId(source, 'plan-review-pause', toolCallId);
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) {
      const replay = this.replayPause(duplicate, receiptId, requestId, operationId, pauseId);
      return { ...(await replay), proposalId };
    }
    const prompt = await this.contentStore.prepare(
      this.database,
      canonicalJson({ toolCallId, proposalId, request }),
      'application/vnd.limcode.plan-review-prompt+json'
    );
    const now = this.timestamp();
    const committed = await this.commitSource({
      source,
      receiptId,
      conversationId: facts.conversation.id as string,
      turnId: facts.turn.id as string,
      steps: [
        DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
          conversation_id: facts.conversation.id,
          turn_id: facts.turn.id
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolCallId, { status: 'pending' }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(facts.execution.id as string, { status: 'pending' }),
        ...preparedContentSteps([prompt], 'plan_review_prompt'),
        DOMAIN_REPOSITORIES.domain('Operation').insertWithNextSequence({
          id: operationId,
          owner_kind: 'tool_execution',
          owner_id: facts.execution.id,
          tool_call_id: toolCallId,
          status: 'waiting_answer',
          created_at: now,
          updated_at: now
        }, {
          column: 'operation_seq',
          scope: { owner_kind: 'tool_execution', owner_id: facts.execution.id }
        }),
        DOMAIN_REPOSITORIES.domain('OutcomePause').insert({
          id: pauseId,
          operation_id: operationId,
          status: 'waiting',
          reason: 'plan_review',
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('InteractionRequest').insert({
          id: requestId,
          request_kind: 'plan_review',
          status: 'pending',
          prompt_object_id: prompt.metadata.id,
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('InteractionOwnerLink').insert({
          id: stablePhaseDId('interaction_owner_link', requestId),
          request_id: requestId,
          turn_id: facts.turn.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('InteractionToolCallLink').insert({
          id: stablePhaseDId('interaction_tool_call_link', requestId),
          request_id: requestId,
          tool_call_id: toolCallId,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').update(toolCallId, { status: 'waiting_answer', updated_at: now }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').update(facts.execution.id as string, {
          status: 'waiting_answer',
          wait_deadline_at: input.waitDeadlineAt === undefined ? null : input.waitDeadlineAt,
          updated_at: now
        })
      ]
    });
    if (committed.deduplicated) {
      const replay = await this.replayPause(committed.receipt, receiptId, requestId, operationId, pauseId);
      return { ...replay, proposalId };
    }
    return {
      receiptId,
      requestId,
      proposalId,
      operationId,
      pauseId,
      deduplicated: false,
      commitSeq: committed.commitSeq
    };
  }

  /**
   * Generic execution approval is a gate in front of the real Tool Operation.  It therefore uses
   * Interaction facts without creating an Operation/OutcomePause: approving returns ToolCall and
   * ToolExecution to pending so the frozen call can execute once; rejecting is durably settled by
   * resolveExecutionApproval.
   */
  public async pauseForExecutionApproval(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    prompt: unknown;
  }): Promise<ExecutionApprovalPauseResult> {
    const source = normalizeSource(input.source, ['internal'], 'execution-approval-pause');
    const toolCallId = requireId(input.toolCallId, 'toolCallId');
    const facts = await this.requireActiveToolFacts(toolCallId);
    if (facts.toolCall.status !== 'pending' || facts.execution.status !== 'pending') {
      throw new Error(`ToolCall ${toolCallId} cannot enter execution approval from ${String(facts.toolCall.status)}/${String(facts.execution.status)}.`);
    }
    const requestId = stablePhaseDId('interaction_request', `execution-approval:${toolCallId}`);
    const receiptId = sourceReceiptId(source, 'execution-approval-pause', toolCallId);
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) return this.replayExecutionApprovalPause(duplicate, receiptId, requestId, toolCallId);
    const prompt = await this.contentStore.prepare(
      this.database,
      canonicalJson({ toolCallId, prompt: input.prompt }),
      'application/vnd.limcode.execution-approval-prompt+json'
    );
    const now = this.timestamp();
    const committed = await this.commitSource({
      source,
      receiptId,
      conversationId: facts.conversation.id as string,
      turnId: facts.turn.id as string,
      steps: [
        DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
          conversation_id: facts.conversation.id,
          turn_id: facts.turn.id
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolCallId, { status: 'pending' }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(facts.execution.id as string, { status: 'pending' }),
        ...preparedContentSteps([prompt], 'execution_approval_prompt'),
        DOMAIN_REPOSITORIES.domain('InteractionRequest').insert({
          id: requestId,
          request_kind: 'exec_approval',
          status: 'pending',
          prompt_object_id: prompt.metadata.id,
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('InteractionOwnerLink').insert({
          id: stablePhaseDId('interaction_owner_link', requestId),
          request_id: requestId,
          turn_id: facts.turn.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('InteractionToolCallLink').insert({
          id: stablePhaseDId('interaction_tool_call_link', requestId),
          request_id: requestId,
          tool_call_id: toolCallId,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').update(toolCallId, { status: 'waiting_answer', updated_at: now }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').update(facts.execution.id as string, {
          status: 'waiting_answer',
          wait_deadline_at: null,
          updated_at: now
        })
      ]
    });
    if (committed.deduplicated) {
      return this.replayExecutionApprovalPause(committed.receipt, receiptId, requestId, toolCallId);
    }
    return { receiptId, requestId, deduplicated: false, commitSeq: committed.commitSeq };
  }

  public async resolveExecutionApproval(input: {
    source: PhaseDCommandSource;
    requestId: string;
    decision: 'accept' | 'reject' | 'cancel';
    response: unknown;
  }): Promise<ExecutionApprovalResolutionResult> {
    const source = normalizeSource(input.source, ['command'], 'execution-approval-resolve');
    const requestId = requireId(input.requestId, 'requestId');
    const request = await this.requireExisting('InteractionRequest', requestId);
    if (request.request_kind !== 'exec_approval') throw new Error('InteractionRequest is not exec_approval.');
    const ownerRows = await this.list('InteractionOwnerLink', { request_id: requestId }, 2);
    const toolLinks = await this.list('InteractionToolCallLink', { request_id: requestId }, 2);
    if (ownerRows.length !== 1 || toolLinks.length !== 1) {
      throw new Error('exec_approval InteractionRequest must have one owner and one ToolCall link.');
    }
    const turn = await this.requireExisting('Turn', requireId(ownerRows[0].turn_id, 'InteractionOwnerLink.turn_id'));
    const toolCallId = requireId(toolLinks[0].tool_call_id, 'InteractionToolCallLink.tool_call_id');
    const receiptId = sourceReceiptId(source, 'execution-approval-resolve', JSON.stringify([requestId, input.decision]));
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) {
      return this.replayExecutionApprovalResolution(duplicate, receiptId, requestId, toolCallId);
    }
    const existingResponse = (await this.list('InteractionResponse', { request_id: requestId }, 2))[0];
    if (existingResponse) {
      const committed = await this.commitSource({
        source,
        receiptId,
        conversationId: requireId(turn.conversation_id, 'Turn.conversation_id'),
        turnId: requireId(turn.id, 'Turn.id'),
        steps: []
      });
      return this.replayExecutionApprovalResolution(committed.receipt, receiptId, requestId, toolCallId);
    }
    const facts = await this.requireActiveToolFacts(toolCallId);
    if (facts.toolCall.status !== 'waiting_answer' || facts.execution.status !== 'waiting_answer') {
      throw new Error(`ToolCall ${toolCallId} is no longer waiting for execution approval.`);
    }
    const approved = input.decision === 'accept';
    const cancelled = input.decision === 'cancel';
    const response = await this.contentStore.prepare(
      this.database,
      canonicalJson({
        requestId,
        toolCallId,
        sourceReceiptId: receiptId,
        decision: input.decision,
        response: input.response
      }),
      'application/vnd.limcode.execution-approval-response+json'
    );
    const now = this.timestamp();
    const committed = await this.commitSource({
      source,
      receiptId,
      conversationId: facts.conversation.id as string,
      turnId: facts.turn.id as string,
      firstResponseRequestId: requestId,
      steps: [
        ...preparedContentSteps([response], 'execution_approval_response'),
        DOMAIN_REPOSITORIES.domain('InteractionResponse').insert({
          id: stablePhaseDId('interaction_response', requestId),
          request_id: requestId,
          content_object_id: response.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
          conversation_id: facts.conversation.id,
          turn_id: facts.turn.id
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolCallId, { status: 'waiting_answer' }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(facts.execution.id as string, { status: 'waiting_answer' }),
        DOMAIN_REPOSITORIES.domain('InteractionRequest').update(requestId, {
          status: approved ? 'succeeded' : cancelled ? 'cancelled' : 'rejected',
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').update(toolCallId, { status: 'pending', updated_at: now }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').update(facts.execution.id as string, {
          status: 'pending',
          wait_deadline_at: null,
          updated_at: now
        })
      ]
    });
    if (committed.deduplicated || committed.firstResponseLost) {
      return this.replayExecutionApprovalResolution(committed.receipt, receiptId, requestId, toolCallId);
    }
    const terminal = approved
      ? undefined
      : await this.settleDeclinedExecutionApproval(
          requestId,
          toolCallId,
          cancelled ? 'cancelled' : 'rejected'
        );
    return {
      receiptId,
      requestId,
      won: true,
      approved,
      cancelled,
      deduplicated: false,
      commitSeq: committed.commitSeq,
      ...(terminal ? { terminal } : {})
    };
  }

  public async resolveAskUser(input: {
    source: PhaseDCommandSource;
    requestId: string;
    response: unknown;
    cancelled?: boolean;
  }): Promise<AskUserResolutionResult> {
    const source = normalizeSource(input.source, ['command', 'internal'], 'ask-user-resolve');
    const requestId = requireId(input.requestId, 'requestId');
    const request = await this.requireExisting('InteractionRequest', requestId);
    if (request.request_kind !== 'ask_user') throw new Error('InteractionRequest is not ask_user.');
    const ownerRows = await this.list('InteractionOwnerLink', { request_id: requestId }, 2);
    if (ownerRows.length !== 1) throw new Error('ask_user InteractionRequest must have one owner link.');
    const turn = await this.requireExisting('Turn', requireId(ownerRows[0].turn_id, 'InteractionOwnerLink.turn_id'));
    if (source.kind === 'internal') {
      if (input.cancelled === true || !await this.autoApprovalAllowed(turn.id as string, 'ask_user')) {
        throw new Error('内部 Ask 自动回复需要冻结工具策略明确授权，且不能取消问题。');
      }
      const automaticResponse = {
        answer: { selectedOptionIndexes: [], customText: BACKGROUND_ASK_USER_AUTO_ANSWER }
      };
      if (canonicalJson(input.response) !== canonicalJson(automaticResponse)) {
        throw new Error('内部 Ask 自动回复只能使用系统默认回答，不能代选用户答案。');
      }
    }
    const pauseId = stablePhaseDId('outcome_pause', stablePhaseDId('operation', `ask-user:${await this.toolCallIdForRequest(requestId)}`));
    const pause = await this.requireExisting('OutcomePause', pauseId);
    const operation = await this.requireExisting('Operation', requireId(pause.operation_id, 'OutcomePause.operation_id'));
    const toolCallId = requireId(operation.tool_call_id, 'Operation.tool_call_id');
    const status = input.cancelled === true ? 'cancelled' as const : 'succeeded' as const;
    const receiptId = sourceReceiptId(source, 'ask-user-resolve', JSON.stringify([requestId, status]));
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) {
      await this.effects.finalizeReadyInOrder(turn.id as string);
      return this.replayResolution(duplicate, receiptId, requestId);
    }
    const existingResponse = (await this.list('InteractionResponse', { request_id: requestId }, 2))[0];
    if (existingResponse) {
      const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
      const committed = await this.commitSource({
        source,
        receiptId,
        conversationId,
        turnId: turn.id as string,
        steps: []
      });
      await this.effects.finalizeReadyInOrder(turn.id as string);
      return this.lostResolutionResult(committed.receipt, requestId, committed.deduplicated);
    }
    const facts = await this.requireActiveToolFacts(toolCallId);
    if (
      facts.toolCall.status !== 'waiting_answer'
      || facts.execution.status !== 'waiting_answer'
      || operation.status !== 'waiting_answer'
    ) {
      throw new Error(`ToolCall ${toolCallId} is no longer waiting for an ask_user response.`);
    }
    const response = await this.contentStore.prepare(
      this.database,
      canonicalJson({ requestId, sourceReceiptId: receiptId, response: input.response }),
      'application/vnd.limcode.ask-user-response+json'
    );
    const automaticResult = source.kind === 'internal'
      ? await this.prepareAutomaticAskResult(request, toolCallId)
      : undefined;
    const now = this.timestamp();
    const committed = await this.commitSource({
      source,
      receiptId,
      conversationId: facts.conversation.id as string,
      turnId: facts.turn.id as string,
      firstResponseRequestId: requestId,
      steps: [
        ...preparedContentSteps(automaticResult ? [response, automaticResult] : [response], 'ask_user_response'),
        // The first-response UNIQUE must linearize before lifecycle assertions so a concurrent
        // loser can replay the winner instead of surfacing a stale-state assertion.
        DOMAIN_REPOSITORIES.domain('InteractionResponse').insert({
          id: stablePhaseDId('interaction_response', requestId),
          request_id: requestId,
          content_object_id: response.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
          conversation_id: facts.conversation.id,
          turn_id: facts.turn.id
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolCallId, { status: 'waiting_answer' }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(facts.execution.id as string, { status: 'waiting_answer' }),
        DOMAIN_REPOSITORIES.domain('Operation').assert(operation.id as string, { status: 'waiting_answer' }),
        ...(automaticResult ? [DOMAIN_REPOSITORIES.domain('ToolResultArtifact').insert({
          id: stablePhaseDId('tool_result_artifact', `ask-user:${toolCallId}`),
          tool_call_id: toolCallId,
          role: 'no_effect_result',
          content_object_id: automaticResult.metadata.id,
          created_at: now
        })] : []),
        DOMAIN_REPOSITORIES.domain('InteractionRequest').update(requestId, {
          status,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('OperationResolution').insert({
          id: stablePhaseDId('operation_resolution', pauseId),
          pause_id: pauseId,
          resolution_kind: status,
          content_object_id: response.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('OutcomePause').update(pauseId, {
          status: 'resolved',
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Operation').update(operation.id as string, {
          status,
          updated_at: now
        })
      ]
    });
    if (committed.deduplicated) {
      await this.effects.finalizeReadyInOrder(facts.turn.id as string);
      return this.replayResolution(committed.receipt, receiptId, requestId);
    }
    if (committed.firstResponseLost) {
      await this.effects.finalizeReadyInOrder(facts.turn.id as string);
      return this.lostResolutionResult(committed.receipt, requestId, false);
    }
    const finalized = await this.effects.finalizeReadyInOrder(facts.turn.id as string);
    const terminal = finalized.find((entry) => entry.toolCallId === toolCallId)
      ?? await this.effects.readTerminalResult(toolCallId, false);
    return {
      receiptId,
      requestId,
      won: true,
      deduplicated: false,
      commitSeq: committed.commitSeq,
      ...(terminal ? { terminal: { ...terminal, receiptId } } : {})
    };
  }

  public async resolvePlanReview(input: {
    source: PhaseDCommandSource;
    requestId: string;
    decision: 'accept' | 'submit' | 'reject' | 'cancel';
    response: unknown;
  }): Promise<PlanReviewResolutionResult> {
    const source = normalizeSource(input.source, ['command', 'internal'], 'plan-review-resolve');
    const requestId = requireId(input.requestId, 'requestId');
    const request = await this.requireExisting('InteractionRequest', requestId);
    if (request.request_kind !== 'plan_review') throw new Error('InteractionRequest is not plan_review.');
    const ownerRows = await this.list('InteractionOwnerLink', { request_id: requestId }, 2);
    if (ownerRows.length !== 1) throw new Error('plan_review InteractionRequest must have one owner link.');
    const turn = await this.requireExisting('Turn', requireId(ownerRows[0].turn_id, 'InteractionOwnerLink.turn_id'));
    if (source.kind === 'internal') {
      if (input.decision !== 'accept') {
        throw new Error('内部 Plan 决策只允许自动批准。');
      }
      const childMemberships = await this.list('ChildExecutionTurnLink', { turn_id: turn.id }, 2);
      if (childMemberships.length > 1) {
        throw new Error('内部 Plan 自动批准要求唯一 ChildExecution 归属。');
      }
      if (childMemberships.length === 0 && !await this.autoApprovalAllowed(turn.id as string, 'submit_plan')) {
        throw new Error('内部 Plan 自动批准需要父任务授权或冻结工具策略明确开启。');
      }
    }
    const subject = await this.readPlanReviewSubject(requestId);
    const proposalId = subject.proposalId;
    const pauseId = stablePhaseDId('outcome_pause', stablePhaseDId('operation', `plan-review:${subject.toolCallId}`));
    const pause = await this.requireExisting('OutcomePause', pauseId);
    const operation = await this.requireExisting('Operation', requireId(pause.operation_id, 'OutcomePause.operation_id'));
    const toolCallId = requireId(operation.tool_call_id, 'Operation.tool_call_id');
    if (toolCallId !== subject.toolCallId) throw new Error('Plan review Operation does not match its immutable subject.');

    const responseRecord = optionalRecord(input.response);
    const suppliedProposalId = optionalText(responseRecord?.planProposalId);
    if (suppliedProposalId && suppliedProposalId !== proposalId) {
      throw new Error('Plan review response targets another proposal.');
    }
    const decisionStatus = input.decision === 'accept'
      ? 'approved' as const
      : input.decision === 'submit'
        ? 'change_requested' as const
        : input.decision === 'cancel'
          ? 'cancelled' as const
          : 'rejected' as const;
    const executionTarget = responseRecord?.executionTarget === 'new_conversation'
      ? 'new_conversation' as const
      : 'current_conversation' as const;
    if (source.kind === 'internal' && executionTarget !== 'current_conversation') {
      throw new Error('内部 Plan 自动批准只能在当前会话执行，不能委派新 Agent。');
    }
    const requestedAgentId = decisionStatus === 'approved' && executionTarget === 'new_conversation'
      ? requireId(responseRecord?.agentType, 'Plan delegation agentType')
      : undefined;
    const delegationRequest = requestedAgentId
      ? {
          sourceToolCallId: toolCallId,
          parentTurnId: requireId(turn.id, 'Plan delegation parent Turn.id'),
          requestedAgentId,
          prompt: createDelegatedPlanPrompt(subject.planRequest)
        }
      : undefined;
    const userMessage = optionalText(responseRecord?.message)
      ?? (requestedAgentId ? DELEGATED_PLAN_APPROVAL_MESSAGE : defaultPlanDecisionMessage(decisionStatus));
    const receiptId = sourceReceiptId(source, 'plan-review-resolve', JSON.stringify([requestId, input.decision]));
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) {
      return this.replayPlanResolution(duplicate, receiptId, requestId, proposalId);
    }
    const existingResponse = (await this.list('InteractionResponse', { request_id: requestId }, 2))[0];
    if (existingResponse) {
      const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
      const committed = await this.commitSource({ source, receiptId, conversationId, turnId: turn.id as string, steps: [] });
      await this.helpWinningPlanResolution(requestId);
      return this.lostPlanResolution(committed.receipt, requestId, proposalId, committed.deduplicated);
    }
    const facts = await this.requireActiveToolFacts(toolCallId);
    if (
      facts.toolCall.status !== 'waiting_answer'
      || facts.execution.status !== 'waiting_answer'
      || operation.status !== 'waiting_answer'
    ) throw new Error(`ToolCall ${toolCallId} is no longer waiting for Plan review.`);

    // Preview is deliberately read-only: the durable winning InteractionResponse below is the
    // delegation intent. A competing response can therefore win without leaving an orphan child.
    const delegation = delegationRequest
      ? normalizePlanDelegationResult(await this.requirePlanDelegator().preview(delegationRequest))
      : undefined;
    const output = createSubmitPlanToolOutput({
      proposalId,
      status: decisionStatus,
      userMessage,
      ...(decisionStatus === 'approved' ? { executionTarget } : {}),
      ...(delegation ? {
        delegationStatus: 'backgrounded' as const,
        agentId: delegation.agentId,
        agentType: delegation.agentType,
        childExecutionId: delegation.childExecutionId,
        conversationId: delegation.childConversationId,
        answerBridgeId: delegation.answerBridgeId
      } : {})
    });

    const response = await this.contentStore.prepare(
      this.database,
      canonicalJson({
        requestId,
        proposalId,
        sourceReceiptId: receiptId,
        decision: input.decision,
        response: input.response,
        output
      }),
      'application/vnd.limcode.plan-review-response+json'
    );
    const now = this.timestamp();
    const committed = await this.commitSource({
      source,
      receiptId,
      conversationId: facts.conversation.id as string,
      turnId: facts.turn.id as string,
      firstResponseRequestId: requestId,
      steps: [
        ...preparedContentSteps([response], 'plan_review_response'),
        DOMAIN_REPOSITORIES.domain('InteractionResponse').insert({
          id: stablePhaseDId('interaction_response', requestId),
          request_id: requestId,
          content_object_id: response.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
          conversation_id: facts.conversation.id,
          turn_id: facts.turn.id
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolCallId, { status: 'waiting_answer' }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(facts.execution.id as string, { status: 'waiting_answer' }),
        DOMAIN_REPOSITORIES.domain('Operation').assert(operation.id as string, { status: 'waiting_answer' })
      ]
    });
    if (committed.deduplicated) {
      return this.replayPlanResolution(committed.receipt, receiptId, requestId, proposalId);
    }
    if (committed.firstResponseLost) {
      await this.helpWinningPlanResolution(requestId);
      return this.lostPlanResolution(committed.receipt, requestId, proposalId, false);
    }
    if (await this.ensureWinningPlanDelegation(requestId, receiptId, proposalId, subject.planRequest) === 'deferred') {
      return { receiptId, requestId, proposalId, won: true, deduplicated: false, commitSeq: committed.commitSeq };
    }
    await this.settleWinningPlanResponse(requestId, receiptId);
    const finalized = await this.effects.finalizeReadyInOrder(facts.turn.id as string);
    const terminal = finalized.find((entry) => entry.toolCallId === toolCallId)
      ?? await this.effects.readTerminalResult(toolCallId, false);
    return {
      receiptId,
      requestId,
      proposalId,
      won: true,
      deduplicated: false,
      commitSeq: committed.commitSeq,
      ...(terminal ? { terminal: { ...terminal, receiptId } } : {})
    };
  }

  /** update_task_list remains structured Tool facts; Phase F will derive its client projection. */
  /**
   * Completes a Plan review whose winning response was recorded but not settled: the approval came
   * from a Host that must not start the delegated child, or the recording Host stopped before
   * settling. Called when the parent Turn resumes; false when no response is recorded yet.
   */
  public async completeRecordedPlanReview(requestIdInput: string): Promise<boolean> {
    const requestId = requireId(requestIdInput, 'requestId');
    const requests = await this.list('InteractionRequest', { id: requestId }, 2);
    if (requests.length !== 1 || requests[0].request_kind !== 'plan_review' || requests[0].status !== 'pending') return false;
    if ((await this.list('InteractionResponse', { request_id: requestId }, 2)).length === 0) return false;
    await this.helpWinningPlanResolution(requestId);
    return true;
  }

  public async settleTaskList(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    operation: unknown;
  }): Promise<ToolSettlementResult> {
    const operation = requireTaskListOperation(normalizePlainJson(input.operation, 'taskList'));
    return this.effects.settleWithoutEffect({
      source: input.source,
      toolCallId: input.toolCallId,
      status: 'succeeded',
      detail: { kind: 'task-list', operation }
    });
  }

  private async toolCallIdForRequest(requestId: string): Promise<string> {
    const request = await this.requireExisting('InteractionRequest', requestId);
    const metadata = await this.requireExisting(
      'ContentObject',
      requireId(request.prompt_object_id, 'InteractionRequest.prompt_object_id')
    ) as ContentObjectMetadata;
    const body = JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as Record<string, unknown>;
    const toolCallId = requireId(body.toolCallId, 'ask_user prompt toolCallId');
    if (stablePhaseDId('interaction_request', `ask-user:${toolCallId}`) !== requestId) {
      throw new Error('ask_user prompt does not match InteractionRequest identity.');
    }
    return toolCallId;
  }

  private async replayPause(
    receipt: DomainRow,
    expectedReceiptId: string,
    requestId: string,
    operationId: string,
    pauseId: string
  ): Promise<AskUserPauseResult> {
    assertSourceReceipt(receipt, expectedReceiptId, 'ask-user-pause');
    await this.requireExisting('InteractionRequest', requestId);
    await this.requireExisting('Operation', operationId);
    await this.requireExisting('OutcomePause', pauseId);
    return { receiptId: receipt.id as string, requestId, operationId, pauseId, deduplicated: true };
  }

  private async replayExecutionApprovalPause(
    receipt: DomainRow,
    expectedReceiptId: string,
    requestId: string,
    toolCallId: string
  ): Promise<ExecutionApprovalPauseResult> {
    assertSourceReceipt(receipt, expectedReceiptId, 'execution-approval-pause');
    const request = await this.requireExisting('InteractionRequest', requestId);
    if (request.request_kind !== 'exec_approval') throw new Error('Stable execution approval has the wrong request kind.');
    const links = await this.list('InteractionToolCallLink', { request_id: requestId, tool_call_id: toolCallId }, 2);
    if (links.length !== 1) throw new Error('Stable execution approval is not linked to its ToolCall.');
    return { receiptId: receipt.id as string, requestId, deduplicated: true };
  }

  private async replayExecutionApprovalResolution(
    receipt: DomainRow,
    expectedReceiptId: string,
    requestId: string,
    toolCallId: string
  ): Promise<ExecutionApprovalResolutionResult> {
    assertSourceReceipt(receipt, expectedReceiptId, 'execution-approval-resolve');
    const request = await this.requireExisting('InteractionRequest', requestId);
    const approved = request.status === 'succeeded';
    const cancelled = request.status === 'cancelled';
    if (!approved && !cancelled && request.status !== 'rejected') {
      throw new Error(`Execution approval ${requestId} is not resolved.`);
    }
    const terminal = approved
      ? undefined
      : await this.settleDeclinedExecutionApproval(
          requestId,
          toolCallId,
          cancelled ? 'cancelled' : 'rejected'
        );
    return {
      receiptId: receipt.id as string,
      requestId,
      won: await this.responseReceiptWon(requestId, receipt.id as string),
      approved,
      cancelled,
      deduplicated: true,
      ...(terminal ? { terminal } : {})
    };
  }

  private async settleDeclinedExecutionApproval(
    requestId: string,
    toolCallId: string,
    status: 'rejected' | 'cancelled'
  ): Promise<ToolTerminalResult | undefined> {
    const cancelled = status === 'cancelled';
    const reason = cancelled ? '工具执行审批已取消。' : '用户拒绝执行工具。';
    const settled = await this.effects.settleWithoutEffect({
      source: { kind: 'internal', key: `execution-approval-${status}:${requestId}` },
      toolCallId,
      status,
      detail: { requestId, reason }
    });
    return settled.terminal;
  }

  private async replayResolution(
    receipt: DomainRow,
    expectedReceiptId: string,
    requestId: string
  ): Promise<AskUserResolutionResult> {
    assertSourceReceipt(receipt, expectedReceiptId, 'ask-user-resolve');
    const toolCallId = await this.toolCallIdForResolvedRequest(requestId);
    const terminal = await this.effects.readTerminalResult(toolCallId, true);
    return {
      receiptId: receipt.id as string,
      requestId,
      won: await this.responseReceiptWon(requestId, receipt.id as string),
      deduplicated: true,
      ...(terminal ? { terminal: { ...terminal, receiptId: receipt.id as string } } : {})
    };
  }

  private async lostResolutionResult(
    receipt: DomainRow,
    requestId: string,
    deduplicated: boolean
  ): Promise<AskUserResolutionResult> {
    const toolCallId = await this.toolCallIdForResolvedRequest(requestId);
    const terminal = await this.effects.readTerminalResult(toolCallId, true);
    return {
      receiptId: receipt.id as string,
      requestId,
      won: false,
      deduplicated,
      ...(terminal ? { terminal: { ...terminal, receiptId: receipt.id as string } } : {})
    };
  }

  private async toolCallIdForResolvedRequest(requestId: string): Promise<string> {
    const response = (await this.list('InteractionResponse', { request_id: requestId }, 2))[0];
    if (!response) throw new Error('Stable ask_user resolution has no InteractionResponse.');
    return this.toolCallIdForRequest(requestId);
  }

  private async responseReceiptWon(requestId: string, receiptId: string): Promise<boolean> {
    const response = (await this.list('InteractionResponse', { request_id: requestId }, 2))[0];
    if (!response) throw new Error('ask_user resolution has no InteractionResponse.');
    const metadata = await this.requireExisting(
      'ContentObject',
      requireId(response.content_object_id, 'InteractionResponse.content_object_id')
    ) as ContentObjectMetadata;
    const body = JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as Record<string, unknown>;
    return body.sourceReceiptId === receiptId;
  }

  /** 'deferred' means the winning approval delegates and this Host must not start the child. */
  private async ensureWinningPlanDelegation(
    requestId: string,
    expectedReceiptId: string,
    expectedProposalId: string,
    planRequest: SubmitPlanToolRequestRecord
  ): Promise<'ensured' | 'deferred' | 'none'> {
    const responses = await this.list('InteractionResponse', { request_id: requestId }, 2);
    if (responses.length !== 1) throw new Error('Stable Plan resolution must have one InteractionResponse.');
    const metadata = await this.requireExisting(
      'ContentObject',
      requireId(responses[0].content_object_id, 'InteractionResponse.content_object_id')
    ) as ContentObjectMetadata;
    const body = JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as Record<string, unknown>;
    if (body.sourceReceiptId !== expectedReceiptId) return 'none';
    const output = submitPlanOutputFromResult(body.output);
    if (!output || output.proposalId !== expectedProposalId) {
      throw new Error('Winning Plan response lost its durable submit_plan result.');
    }
    if (output.status !== 'approved' || output.executionTarget !== 'new_conversation') return 'none';
    if (output.delegationStatus !== 'backgrounded') {
      throw new Error('Approved delegated Plan response lost its durable delegation intent.');
    }
    const persistedResponse = optionalRecord(body.response);
    const requestedAgentId = requireId(persistedResponse?.agentType, 'Plan delegation requested agentType');
    const subject = await this.readPlanReviewSubject(requestId);
    if (subject.proposalId !== expectedProposalId) throw new Error('Plan delegation proposal identity changed.');
    const expected = normalizePlanDelegationIdentity({
      childExecutionId: output.childExecutionId,
      childConversationId: output.conversationId,
      answerBridgeId: output.answerBridgeId,
      agentId: output.agentId,
      agentType: output.agentType
    });
    const delegator = this.requirePlanDelegator();
    const request: PlanDelegationRequest = {
      sourceToolCallId: subject.toolCallId,
      parentTurnId: requireId(
        (await this.requireExisting('ToolCall', subject.toolCallId)).turn_id,
        'Plan delegation parent Turn.id'
      ),
      requestedAgentId,
      prompt: createDelegatedPlanPrompt(planRequest)
    };
    if (delegator.mayEnsure && !await delegator.mayEnsure(request)) return 'deferred';
    const ensured = normalizePlanDelegationResult(await delegator.ensure({ ...request, expected }));
    assertPlanDelegationIdentity(ensured, expected);
    return 'ensured';
  }

  private async settleWinningPlanResponse(requestId: string, expectedReceiptId: string): Promise<void> {
    const responses = await this.list('InteractionResponse', { request_id: requestId }, 2);
    if (responses.length !== 1) throw new Error('Stable Plan settlement must have one InteractionResponse.');
    const response = responses[0];
    const responseMetadata = await this.requireExisting(
      'ContentObject',
      requireId(response.content_object_id, 'InteractionResponse.content_object_id')
    ) as ContentObjectMetadata;
    const body = JSON.parse((await this.contentStore.read(responseMetadata)).toString('utf8')) as Record<string, unknown>;
    if (body.sourceReceiptId !== expectedReceiptId) {
      throw new Error('Only the winning Plan response source may settle Plan review.');
    }
    const output = submitPlanOutputFromResult(body.output);
    if (!output) throw new Error('Winning Plan response lost its durable submit_plan result.');
    const decision = requirePlanResolutionDecision(body.decision);
    const expectedDecisionStatus = decision === 'accept'
      ? 'approved'
      : decision === 'submit'
        ? 'change_requested'
        : decision === 'cancel'
          ? 'cancelled'
          : 'rejected';
    if (output.status !== expectedDecisionStatus) {
      throw new Error('Winning Plan response decision and submit_plan result disagree.');
    }
    const operationStatus = output.status === 'cancelled'
      ? 'cancelled' as const
      : output.status === 'rejected'
        ? 'rejected' as const
        : 'succeeded' as const;
    const requestStatus = output.status === 'cancelled'
      ? 'cancelled'
      : output.status === 'rejected'
        ? 'rejected'
        : 'succeeded';
    const subject = await this.readPlanReviewSubject(requestId);
    if (subject.proposalId !== output.proposalId) throw new Error('Plan settlement proposal identity changed.');
    const pauseId = stablePhaseDId(
      'outcome_pause',
      stablePhaseDId('operation', `plan-review:${subject.toolCallId}`)
    );
    const pause = await this.requireExisting('OutcomePause', pauseId);
    const operation = await this.requireExisting(
      'Operation',
      requireId(pause.operation_id, 'OutcomePause.operation_id')
    );
    const resultArtifact = await this.contentStore.prepare(
      this.database,
      canonicalJson({ toolCallId: subject.toolCallId, status: operationStatus, detail: output }),
      'application/vnd.limcode.tool-result-artifact+json'
    );
    if (operation.status !== 'waiting_answer') {
      await this.assertSettledPlanResponse({
        requestId,
        response,
        pauseId,
        operation,
        operationStatus,
        requestStatus,
        toolCallId: subject.toolCallId,
        resultArtifactId: resultArtifact.metadata.id
      });
      return;
    }
    const facts = await this.requireActiveToolFacts(subject.toolCallId);
    const now = this.timestamp();
    try {
      await this.database.transaction([
        ...preparedContentSteps([resultArtifact], 'plan_review_result'),
        DOMAIN_REPOSITORIES.domain('InteractionResponse').assert(
          requireId(response.id, 'InteractionResponse.id'),
          { request_id: requestId, content_object_id: responseMetadata.id }
        ),
        DOMAIN_REPOSITORIES.domain('InteractionRequest').assert(requestId, { status: 'pending' }),
        DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: 'active' }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
          conversation_id: facts.conversation.id,
          turn_id: facts.turn.id
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(subject.toolCallId, { status: 'waiting_answer' }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(facts.execution.id as string, {
          status: 'waiting_answer'
        }),
        DOMAIN_REPOSITORIES.domain('OutcomePause').assert(pauseId, { status: 'waiting' }),
        DOMAIN_REPOSITORIES.domain('Operation').assert(operation.id as string, { status: 'waiting_answer' }),
        DOMAIN_REPOSITORIES.domain('ToolResultArtifact').insert({
          id: stablePhaseDId('tool_result_artifact', `plan-review:${subject.toolCallId}`),
          tool_call_id: subject.toolCallId,
          role: 'no_effect_result',
          content_object_id: resultArtifact.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('InteractionRequest').update(requestId, {
          status: requestStatus,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('OperationResolution').insert({
          id: stablePhaseDId('operation_resolution', pauseId),
          pause_id: pauseId,
          resolution_kind: operationStatus,
          content_object_id: responseMetadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('OutcomePause').update(pauseId, { status: 'resolved', updated_at: now }),
        DOMAIN_REPOSITORIES.domain('Operation').update(operation.id as string, {
          status: operationStatus,
          updated_at: now
        })
      ]);
    } catch (error) {
      if (!isRuntimeTransactionAssertionFailure(error) && !matchesExpectedUnique(error, [
        ['tool_result_artifact', ['id']],
        ['operation_resolution', ['id']]
      ])) throw error;
    }
    await this.assertSettledPlanResponse({
      requestId,
      response,
      pauseId,
      operation,
      operationStatus,
      requestStatus,
      toolCallId: subject.toolCallId,
      resultArtifactId: resultArtifact.metadata.id
    });
  }

  private async assertSettledPlanResponse(input: {
    requestId: string;
    response: DomainRow;
    pauseId: string;
    operation: DomainRow;
    operationStatus: 'succeeded' | 'rejected' | 'cancelled';
    requestStatus: string;
    toolCallId: string;
    resultArtifactId: string;
  }): Promise<void> {
    const [request, pause, operation] = await Promise.all([
      this.requireExisting('InteractionRequest', input.requestId),
      this.requireExisting('OutcomePause', input.pauseId),
      this.requireExisting('Operation', requireId(input.operation.id, 'Operation.id'))
    ]);
    const [resolutions, artifacts] = await Promise.all([
      this.list('OperationResolution', { pause_id: input.pauseId }, 2),
      this.list('ToolResultArtifact', { tool_call_id: input.toolCallId }, 2)
    ]);
    if (
      request.status !== input.requestStatus
      || pause.status !== 'resolved'
      || operation.status !== input.operationStatus
      || resolutions.length !== 1
      || resolutions[0].resolution_kind !== input.operationStatus
      || resolutions[0].content_object_id !== input.response.content_object_id
      || artifacts.length !== 1
      || artifacts[0].role !== 'no_effect_result'
      || artifacts[0].content_object_id !== input.resultArtifactId
    ) throw new Error('Plan response settlement replay found conflicting facts.');
  }

  private async readPlanReviewSubject(requestId: string): Promise<{
    toolCallId: string;
    proposalId: string;
    planRequest: SubmitPlanToolRequestRecord;
  }> {
    const request = await this.requireExisting('InteractionRequest', requestId);
    if (request.request_kind !== 'plan_review') throw new Error('InteractionRequest is not plan_review.');
    const metadata = await this.requireExisting(
      'ContentObject',
      requireId(request.prompt_object_id, 'InteractionRequest.prompt_object_id')
    ) as ContentObjectMetadata;
    const body = JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as Record<string, unknown>;
    const toolCallId = requireId(body.toolCallId, 'plan review prompt toolCallId');
    const proposalId = requireId(body.proposalId, 'plan review prompt proposalId');
    if (
      stablePhaseDId('interaction_request', `plan-review:${toolCallId}`) !== requestId
      || proposalId !== planProposalId(toolCallId)
    ) throw new Error('plan_review prompt does not match InteractionRequest identity.');
    const planRequest = normalizeSubmitPlanToolRequest(body.request);
    return { toolCallId, proposalId, planRequest };
  }

  private requirePlanDelegator(): PlanDelegator {
    if (!this.planDelegator) {
      throw new Error('可靠 Plan 控制面尚未连接独立对话委派。');
    }
    return this.planDelegator;
  }

  private async helpWinningPlanResolution(requestId: string): Promise<void> {
    const subject = await this.readPlanReviewSubject(requestId);
    const responses = await this.list('InteractionResponse', { request_id: requestId }, 2);
    if (responses.length !== 1) throw new Error('Durable Plan winner must have one InteractionResponse.');
    const metadata = await this.requireExisting(
      'ContentObject',
      requireId(responses[0].content_object_id, 'InteractionResponse.content_object_id')
    ) as ContentObjectMetadata;
    const body = JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as Record<string, unknown>;
    const winnerReceiptId = requireId(body.sourceReceiptId, 'Plan winner sourceReceiptId');
    const winnerReceipt = await this.requireExisting('CommandReceipt', winnerReceiptId);
    const toolCall = await this.requireExisting('ToolCall', subject.toolCallId);
    const parentTurnId = requireId(toolCall.turn_id, 'ToolCall.turn_id');
    if (winnerReceipt.turn_id !== parentTurnId) {
      throw new Error('Durable Plan winner receipt does not belong to the Plan parent Turn.');
    }
    if (await this.ensureWinningPlanDelegation(
      requestId,
      winnerReceiptId,
      subject.proposalId,
      subject.planRequest
    ) === 'deferred') return;
    await this.settleWinningPlanResponse(requestId, winnerReceiptId);
    await this.effects.finalizeReadyInOrder(parentTurnId);
  }

  private async replayPlanResolution(
    receipt: DomainRow,
    expectedReceiptId: string,
    requestId: string,
    proposalId: string
  ): Promise<PlanReviewResolutionResult> {
    assertSourceReceipt(receipt, expectedReceiptId, 'plan-review-resolve');
    const subject = await this.readPlanReviewSubject(requestId);
    const won = await this.responseReceiptWon(requestId, receipt.id as string);
    await this.helpWinningPlanResolution(requestId);
    const toolCallId = subject.toolCallId;
    const terminal = await this.effects.readTerminalResult(toolCallId, true);
    return {
      receiptId: receipt.id as string,
      requestId,
      proposalId,
      won,
      deduplicated: true,
      ...(terminal ? { terminal: { ...terminal, receiptId: receipt.id as string } } : {})
    };
  }

  private async lostPlanResolution(
    receipt: DomainRow,
    requestId: string,
    proposalId: string,
    deduplicated: boolean
  ): Promise<PlanReviewResolutionResult> {
    const toolCallId = (await this.readPlanReviewSubject(requestId)).toolCallId;
    const terminal = await this.effects.readTerminalResult(toolCallId, true);
    return {
      receiptId: receipt.id as string,
      requestId,
      proposalId,
      won: false,
      deduplicated,
      ...(terminal ? { terminal: { ...terminal, receiptId: receipt.id as string } } : {})
    };
  }

  private async prepareAutomaticAskResult(request: DomainRow, toolCallId: string): Promise<PreparedContentObject> {
    const metadata = await this.requireExisting(
      'ContentObject',
      requireId(request.prompt_object_id, 'InteractionRequest.prompt_object_id')
    ) as ContentObjectMetadata;
    const body = JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as Record<string, unknown>;
    if (body.toolCallId !== toolCallId) throw new Error('Ask 自动回复与请求的 ToolCall 不一致。');
    const output = resolveAskUserAnswer(normalizeAskUserToolRequest(body.prompt), {
      selectedOptionIndexes: [],
      customText: BACKGROUND_ASK_USER_AUTO_ANSWER
    });
    return this.contentStore.prepare(
      this.database,
      canonicalJson({ toolCallId, status: 'succeeded', detail: output }),
      'application/vnd.limcode.tool-result-artifact+json'
    );
  }

  private async autoApprovalAllowed(turnId: string, toolName: 'ask_user' | 'submit_plan'): Promise<boolean> {
    const snapshots = await this.list('AuthoritySnapshot', { turn_id: turnId }, 2);
    if (snapshots.length !== 1) throw new Error('内部自动审批需要唯一的冻结 AuthoritySnapshot。');
    const frozen = await readFrozenTurnAuthority(
      this.database,
      this.contentStore,
      requireId(snapshots[0].id, 'AuthoritySnapshot.id'),
      turnId
    );
    return frozenInteractionAutoApproval(frozen.document, toolName);
  }

  private async requireActiveToolFacts(toolCallId: string): Promise<{
    toolCall: DomainRow;
    execution: DomainRow;
    turn: DomainRow;
    conversation: DomainRow;
    lease: DomainRow;
  }> {
    const toolCall = await this.requireExisting('ToolCall', toolCallId);
    const executions = await this.list('ToolExecution', { tool_call_id: toolCallId }, 2);
    if (executions.length !== 1) throw new Error(`ToolCall ${toolCallId} must have one ToolExecution.`);
    const turn = await this.requireExisting('Turn', requireId(toolCall.turn_id, 'ToolCall.turn_id'));
    const conversation = await this.requireExisting('Conversation', requireId(turn.conversation_id, 'Turn.conversation_id'));
    const leases = await this.list('ExecutionLease', { turn_id: turn.id }, 2);
    if (turn.status !== 'active' || leases.length !== 1) throw new Error('ask_user requires its active Turn ExecutionLease.');
    return { toolCall, execution: executions[0], turn, conversation, lease: leases[0] };
  }

  private async commitSource(options: {
    source: PhaseDCommandSource;
    receiptId: string;
    conversationId: string;
    turnId: string;
    firstResponseRequestId?: string;
    steps: RepositoryTransactionStep[];
  }): Promise<{ receipt: DomainRow; deduplicated: boolean; firstResponseLost?: boolean; commitSeq?: string }> {
    const existing = await this.findSourceReceipt(options.source);
    if (existing) {
      assertSourceReceipt(existing, options.receiptId, 'tool interaction');
      return { receipt: existing, deduplicated: true };
    }
    const receipt = {
      id: options.receiptId,
      source_kind: options.source.kind,
      source_key: options.source.key,
      conversation_id: options.conversationId,
      turn_id: options.turnId,
      created_at: this.timestamp()
    };
    try {
      const committed = await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('CommandReceipt').insert(receipt),
        ...options.steps
      ]);
      return { receipt, deduplicated: false, commitSeq: committed.commitSeq };
    } catch (error) {
      if (!matchesExpectedUnique(error, [
        ['command_receipt', ['id']],
        ['command_receipt', ['source_kind', 'source_key']],
        ['interaction_response', ['id']],
        ['interaction_response', ['request_id']]
      ])) throw error;
      const racedSource = await this.findSourceReceipt(options.source);
      if (racedSource) {
        assertSourceReceipt(racedSource, options.receiptId, 'tool interaction');
        return { receipt: racedSource, deduplicated: true };
      }
      if (options.firstResponseRequestId) {
        const winner = (await this.list('InteractionResponse', {
          request_id: options.firstResponseRequestId
        }, 2))[0];
        if (winner) {
          const receiptOnly = await this.commitSource({
            source: options.source,
            receiptId: options.receiptId,
            conversationId: options.conversationId,
            turnId: options.turnId,
            steps: []
          });
          return { ...receiptOnly, firstResponseLost: true };
        }
      }
      throw error;
    }
  }

  private async findSourceReceipt(source: PhaseDCommandSource): Promise<DomainRow | undefined> {
    return (await this.list('CommandReceipt', { source_kind: source.kind, source_key: source.key }, 2))[0];
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    if (!row || Array.isArray(row)) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })]);
    const rows = snapshot.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} list did not return rows.`);
    return rows;
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

function normalizeSource<T extends PhaseDCommandSource['kind']>(
  source: PhaseDCommandSource,
  allowed: readonly T[],
  operation: string
): PhaseDCommandSource & { kind: T } {
  if (!source || !allowed.includes(source.kind as T)) {
    throw new TypeError(`${operation} source kind must be one of: ${allowed.join(', ')}.`);
  }
  return { kind: source.kind as T, key: requireText(source.key, `${operation} source key`) };
}

function sourceReceiptId(source: PhaseDCommandSource, operation: string, scope: string): string {
  return stablePhaseDId('command_receipt', JSON.stringify([source.kind, source.key, operation, scope]));
}

function normalizePlanDelegationResult(result: PlanDelegationResult): PlanDelegationResult {
  if (!result || typeof result !== 'object') throw new TypeError('Plan delegator returned no result.');
  const identity = normalizePlanDelegationIdentity(result);
  return {
    ...identity,
    childTurnId: requireId(result.childTurnId, 'Plan delegation childTurnId')
  };
}

function normalizePlanDelegationIdentity(result: {
  childExecutionId?: unknown;
  childConversationId?: unknown;
  answerBridgeId?: unknown;
  agentId?: unknown;
  agentType?: unknown;
}): PlanDelegationIdentity {
  if (!result || typeof result !== 'object') throw new TypeError('Plan delegator returned no identity.');
  return {
    childExecutionId: requireId(result.childExecutionId, 'Plan delegation childExecutionId'),
    childConversationId: requireId(result.childConversationId, 'Plan delegation childConversationId'),
    answerBridgeId: requireId(result.answerBridgeId, 'Plan delegation answerBridgeId'),
    agentId: requireId(result.agentId, 'Plan delegation agentId'),
    agentType: requireId(result.agentType, 'Plan delegation agentType')
  };
}

function assertPlanDelegationIdentity(
  actual: PlanDelegationResult,
  expected: PlanDelegationIdentity
): void {
  for (const key of [
    'childExecutionId',
    'childConversationId',
    'answerBridgeId',
    'agentId',
    'agentType'
  ] as const) {
    if (actual[key] !== expected[key]) {
      throw new Error(`Plan delegation ensure changed durable ${key}.`);
    }
  }
}

function requirePlanResolutionDecision(value: unknown): 'accept' | 'submit' | 'reject' | 'cancel' {
  if (value !== 'accept' && value !== 'submit' && value !== 'reject' && value !== 'cancel') {
    throw new TypeError('Plan response decision is invalid.');
  }
  return value;
}

function isRuntimeTransactionAssertionFailure(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}

function assertSourceReceipt(receipt: DomainRow, expected: string, operation: string): void {
  if (receipt.id !== expected) throw new Error(`CommandReceipt does not contain ${operation} result facts.`);
}

function matchesExpectedUnique(
  error: unknown,
  expected: ReadonlyArray<readonly [table: string, columns: readonly string[]]>
): boolean {
  const value = error as { code?: unknown; message?: unknown };
  if (
    typeof value.code !== 'string'
    || !['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY'].includes(value.code)
    || typeof value.message !== 'string'
  ) return false;
  const marker = 'UNIQUE constraint failed:';
  const index = value.message.indexOf(marker);
  if (index < 0) return false;
  const actual = value.message
    .slice(index + marker.length)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .sort();
  return expected.some(([table, columns]) => {
    const wanted = columns.map((column) => `${table}.${column}`).sort();
    return wanted.length === actual.length && wanted.every((column, ordinal) => column === actual[ordinal]);
  });
}

function planProposalId(toolCallId: string): string {
  return `plan-proposal:${requireId(toolCallId, 'toolCallId')}`;
}

function defaultPlanDecisionMessage(status: 'approved' | 'change_requested' | 'rejected' | 'cancelled'): string {
  if (status === 'approved') return 'User approved the plan. Continue with the approved plan.';
  if (status === 'change_requested') return 'User requested changes to the plan. Revise the plan and submit it again.';
  if (status === 'cancelled') return 'The current response was stopped, so the pending plan review was cancelled.';
  return 'User rejected the plan.';
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value;
}
