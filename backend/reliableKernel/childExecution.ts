import type { AttachmentIngestService, PreparedMessageAttachmentAdmission } from './attachmentIngest';
import {
  ContentAddressedStore,
  type ContentObjectMetadata,
  type PreparedContentObject
} from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import { ContextSequenceControlPlane } from './contextSequence';
import { readConversationChildTaskProjection } from './conversationChildTaskProjection';
import { estimateStoredMessageContentTokens } from './contextTokenEstimator';
import {
  parseInputTurnIntentEnvelopeText,
  runtimeContinuationTurnIntentEnvelope,
  TURN_INTENT_ENVELOPE_CONTENT_TYPE
} from './guidanceIntent';
import {
  conversationProjectLinkInsertStep,
  projectFolderForConversation
} from './conversationProject';
import {
  assertChildExecutionTransition,
  childExecutionAcceptsContinuation,
  interruptedStatusAfterTurnTerminal,
  isChildExecutionInterrupting,
  isChildExecutionPermanentlyTerminal,
  requireChildExecutionStatus
} from './childExecutionState';
import {
  EffectControlPlane,
  type EffectObservedOutcome,
  type RecordedEffectReceipt,
  type ToolOutcomeStatus,
  type ToolTerminalResult
} from './effectControlPlane';
import { frozenModelSelection, frozenWorkEnvironmentPolicy, readFrozenTurnAuthority } from './frozenAuthority';
import type { FrozenWorkEnvironmentBoundaryPolicy } from './workEnvironmentBoundary';
import { canonicalPlainJson } from './plainJson';
import {
  isTransactionAssertionFailure,
  optionalPhaseFId,
  requireIsoTimestamp,
  requirePhaseFId,
  requirePhaseFText,
  stablePhaseFId,
  sqliteUniqueFailureIncludes
} from './phaseFIdentity';
import {
  CHILD_RUNTIME_DELIVERY_CONTINUATION_CONTENT_TYPE as RUNTIME_DELIVERY_CONTINUATION_CONTENT_TYPE,
  TURN_EXECUTION_PRESET_CONTENT_TYPE,
  childRuntimeDeliveryContinuationIds as runtimeDeliveryContinuationIds
} from './runtimeDeliveryContinuationIdentity';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';
import {
  normalizeTurnModelOverride,
  normalizeCompiledTurnAuthority,
  type TurnAuthorityCompiler,
  type TurnModelOverride
} from './turnControlPlane';

export const CHILD_INTERRUPTION_RECOVERY_SOURCE_PREFIX = 'recovery:interrupt-subtree:';
export const CHILD_INTERRUPTION_RECOVERY_REASON =
  'Extension Host restart resumed an incomplete subtree interruption.';

export type ChildCompletionPolicy = 'wait_for_answer' | 'background';
export type ChildSpawnSourceSettlement = 'child_handle' | 'external';
export type ChildSendMode = 'queue_next_turn' | 'interrupt_current_turn';

export interface ChildExecutionSpawnCommand {
  sourceToolCallId: string;
  childAgentId: string;
  /** Parent Turn's frozen effective model; child-local profiles still have higher precedence. */
  modelFallback: TurnModelOverride;
  prompt: string;
  completionPolicy: ChildCompletionPolicy;
  /**
   * `child_handle` owns and settles a run_agent ToolCall. `external` only anchors lineage to a
   * ToolCall whose interaction control plane remains its sole settlement owner.
   */
  sourceSettlement: ChildSpawnSourceSettlement;
  waitDeadlineAt?: string;
  childConversationId?: string;
  title?: string;
  leaseOwnerId: string;
  leaseExpiresAt: string;
}

export interface ChildExecutionSpawnResult {
  childExecutionId: string;
  childConversationId: string;
  childTurnId: string;
  answerBridgeId: string;
  operationId: string;
  attemptId: string;
  effectIntentId: string;
  modelSelection: TurnModelOverride;
  completionPolicy: ChildCompletionPolicy;
  deduplicated: boolean;
  commitSeq?: string;
}

/** Stable identities reserved by a source ToolCall before any ChildExecution facts are written. */
export interface ChildExecutionSpawnIdentity {
  childExecutionId: string;
  childConversationId: string;
  childTurnId: string;
  answerBridgeId: string;
}

export function childExecutionSpawnIdentity(input: {
  sourceToolCallId: string;
  childConversationId?: string;
}): ChildExecutionSpawnIdentity {
  const sourceToolCallId = requirePhaseFId(input.sourceToolCallId, 'sourceToolCallId');
  const childConversationId = optionalPhaseFId(input.childConversationId, 'childConversationId')
    ?? stablePhaseFId('conversation', 'child', sourceToolCallId);
  return {
    childExecutionId: stablePhaseFId('child_execution', sourceToolCallId),
    childConversationId,
    childTurnId: stablePhaseFId('turn', 'child-first', sourceToolCallId),
    answerBridgeId: stablePhaseFId('answer_bridge', sourceToolCallId)
  };
}

export interface ChildExecutionSendCommand {
  sourceKey: string;
  sourceToolCallId: string;
  childExecutionId: string;
  mode: ChildSendMode;
  content: string | Uint8Array;
  contentType?: string;
  completionPolicy: ChildCompletionPolicy;
  waitDeadlineAt?: string;
}

export interface ChildExecutionSendResult {
  childExecutionId: string;
  turnIntentId: string;
  intentLinkId: string;
  pendingTurnInputId?: string;
  operationId: string;
  pauseId?: string;
  mode: ChildSendMode;
  completionPolicy: ChildCompletionPolicy;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface ChildContinuationAdmissionCommand {
  sourceKey: string;
  childExecutionId: string;
  turnIntentId: string;
  leaseOwnerId: string;
  leaseExpiresAt: string;
}

export interface ChildContinuationAdmissionResult {
  childExecutionId: string;
  turnIntentId: string;
  turnId: string;
  turnSeq: string;
  answerBridgeId: string;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface ChildRuntimeDeliveryContinuationCommand {
  deliveryId: string;
  childExecutionId: string;
  sourceTurnId: string;
}

export interface ChildRuntimeDeliveryContinuationResult {
  childExecutionId: string;
  turnIntentId: string;
  intentLinkId: string;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface ChildExecutionCancelCommand {
  sourceKey: string;
  childExecutionId: string;
  reason: string;
}

export interface ChildExecutionCancelSubtreeResult {
  rootChildExecutionId: string;
  lineageIds: string[];
  activeTurnIds: string[];
  cancelledIntentIds: string[];
  terminationRequestsWritten: number;
  intentsCancelled: number;
  waitsSettled: number;
  terminalizedLineageIds: string[];
  deduplicated: boolean;
  commitSeq?: string;
}

export interface ChildSpawnRecoveryResult {
  effectIntentId: string;
  childExecutionId: string;
  childTurnId: string;
  dispatchState: string;
  childStatus: string;
  turnStatus: string;
  shouldDrive: boolean;
}

export interface PendingChildContinuation {
  childExecutionId: string;
  turnIntentId: string;
  intentSeq: string;
}

export interface ChildExecutionSnapshot {
  childExecution: DomainRow;
  parentLink: DomainRow;
  turnLinks: DomainRow[];
  activeTurnLink: DomainRow | null;
  activeTurn: DomainRow | null;
  answerBridge: DomainRow;
  currentSubmission: DomainRow | null;
}

export interface PreparedForegroundSettlement {
  toolCallId: string;
  childExecutionId: string;
  receiptId: string;
  waitDeadlineAt: string;
  status: ToolOutcomeStatus;
  steps: RepositoryTransactionStep[];
}

export interface ChildWaitSettlement {
  toolCallId: string;
  status: ToolOutcomeStatus;
  terminal?: ToolTerminalResult;
}

export interface ChildExecutionControlPlaneOptions {
  now?: () => string;
  authorityCompiler: TurnAuthorityCompiler;
  attachments?: AttachmentIngestService;
  /** Allows Turn admission to attach pending next_turn deliveries in the very same writer transaction. */
  prepareNextTurnDeliverySteps?: (
    conversationId: string,
    turnId: string,
    now: string
  ) => Promise<RepositoryTransactionStep[]>;
}

interface InterruptionReplayFacts {
  result: ChildExecutionCancelSubtreeResult;
  /** The immutable reason committed by the first invocation; recovery replay must reuse it. */
  reason: string;
}

interface SpawnIds {
  childExecutionId: string;
  childConversationId: string;
  childOriginLinkId: string;
  childAgentLinkId: string;
  childTurnId: string;
  childLeaseId: string;
  childExecutorLinkId: string;
  childAuthoritySnapshotId: string;
  childMessageId: string;
  childMessageRevisionId: string;
  childMessageCurrentLinkId: string;
  childMessageMembershipId: string;
  childMessageTurnLinkId: string;
  parentLinkId: string;
  turnLinkId: string;
  activeTurnLinkId: string;
  answerBridgeId: string;
  operationId: string;
  attemptId: string;
  effectIntentId: string;
  commandReceiptId: string;
}

interface SpawnIntentFacts {
  intent: DomainRow;
  attempt: DomainRow;
  operation: DomainRow;
  childExecution: DomainRow;
  childTurnLink: DomainRow;
  childTurn: DomainRow;
  childLease: DomainRow | null;
  activeLink: DomainRow | null;
  bridge: DomainRow;
}

const ACTIVE_TURN = 'active';
const TERMINATED_TURN = 'terminated';
export const CHILD_TURN_ANSWER_WAIT_OWNER_KIND = 'child_turn_answer_wait';
export const LEGACY_ANSWER_BRIDGE_WAIT_OWNER_KIND = 'answer_bridge_wait';
const SUBAGENT_SPAWN_CONTENT_TYPE = 'application/vnd.limcode.subagent-spawn+json';
const TERMINAL_OPERATION_STATES = new Set([
  'succeeded', 'failed', 'partial', 'rejected', 'cancelled', 'conflict', 'outcome_unknown'
]);

/** Stable ChildExecution lineage and run_agent control plane for Phase F. */
export class ChildExecutionControlPlane {
  private readonly now: () => string;
  private readonly authorityCompiler: TurnAuthorityCompiler;
  private readonly contextSequence: ContextSequenceControlPlane;
  private readonly attachments: AttachmentIngestService | undefined;
  private readonly prepareNextTurnDeliverySteps?: ChildExecutionControlPlaneOptions['prepareNextTurnDeliverySteps'];

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly effects: EffectControlPlane,
    options: ChildExecutionControlPlaneOptions
  ) {
    if (!options.authorityCompiler || typeof options.authorityCompiler.compile !== 'function') {
      throw new TypeError('ChildExecutionControlPlane requires a server-side TurnAuthorityCompiler.');
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.authorityCompiler = options.authorityCompiler;
    this.contextSequence = new ContextSequenceControlPlane(database, contentStore, { now: this.now });
    this.attachments = options.attachments;
    this.prepareNextTurnDeliverySteps = options.prepareNextTurnDeliverySteps;
  }

  /** Model-facing task observations are reconstructed from committed lineage and source facts. */
  public readConversationTaskProjection(conversationId: string) {
    return readConversationChildTaskProjection(this.database, this.contentStore,
      requirePhaseFId(conversationId, 'conversationId'));
  }

  /**
   * Child Conversation, stable lineage/links, first Turn, bridge and spawn Effect facts are one
   * transaction. The CAS request is published first and may remain as an unreferenced orphan if the
   * transaction fails.
   */
  public async spawn(commandInput: ChildExecutionSpawnCommand): Promise<ChildExecutionSpawnResult> {
    const command = normalizeSpawnCommand(commandInput);
    const ids = spawnIds(command);
    const replay = await this.findSpawnReplay(command, ids);
    if (replay) return replay;

    const parent = await this.readSpawnParent(command.sourceToolCallId);
    if (parent.turn.status !== ACTIVE_TURN || parent.termination !== null) {
      throw new Error('ChildExecution spawn is rejected because the parent Turn is terminal.');
    }
    if (!parent.lease) throw new Error('ChildExecution spawn requires the parent Turn ExecutionLease.');
    if (parent.parentChildExecution) {
      const parentStatus = requireChildExecutionStatus(parent.parentChildExecution.status);
      if (isChildExecutionPermanentlyTerminal(parentStatus) || isChildExecutionInterrupting(parentStatus)) {
        throw new Error('ChildExecution spawn is rejected because the parent lineage is terminating.');
      }
    }
    const expectedSourceStatus = command.sourceSettlement === 'external' ? 'waiting_answer' : 'pending';
    if (parent.toolCall.status !== expectedSourceStatus || parent.toolExecution.status !== expectedSourceStatus) {
      throw new Error(`Source ToolCall cannot spawn from ${String(parent.toolCall.status)}/${String(parent.toolExecution.status)}.`);
    }

    const workspace = await projectFolderForConversation(
      this.database,
      requirePhaseFId(parent.conversation.id, 'Conversation.id')
    );
    const inheritedBoundary = await this.frozenWorkEnvironmentPolicyForTurn(
      requirePhaseFId(parent.turn.id, 'parent Turn.id')
    );
    const compiled = normalizeCompiledTurnAuthority(await this.authorityCompiler.compile({
      conversationId: ids.childConversationId,
      turnId: ids.childTurnId,
      executorAgentId: command.childAgentId,
      intentKind: 'input',
      modelFallback: command.modelFallback,
      ...(workspace ? { workspace } : {}),
      ...(inheritedBoundary ? { inheritedWorkEnvironmentPolicy: inheritedBoundary } : {})
    }), ids.childTurnId, command.childAgentId);
    const modelSelection = frozenModelSelection(JSON.parse(asUtf8Text(
      compiled.authoritySnapshot.content,
      'Child AuthoritySnapshot'
    )));
    const [requestContent, promptContent, authorityContent] = await Promise.all([
      this.contentStore.prepare(
        this.database,
        canonicalPlainJson(spawnRequestPayload(command, ids)),
        SUBAGENT_SPAWN_CONTENT_TYPE
      ),
      this.contentStore.prepare(this.database, command.prompt, 'text/plain'),
      this.contentStore.prepare(
        this.database,
        compiled.authoritySnapshot.content,
        compiled.authoritySnapshot.contentType
      )
    ]);
    const promptContext = this.contextSequence.prepareFreshConversationMessageMutation({
      conversationId: ids.childConversationId,
      messageRevisionId: ids.childMessageRevisionId,
      contentObjectId: promptContent.metadata.id,
      contentByteLength: promptContent.metadata.byte_length,
      contentEstimatedTokens: estimateStoredMessageContentTokens(command.prompt, 'text/plain')
    });
    const now = this.timestamp();
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
        id: ids.commandReceiptId,
        source_kind: 'internal',
        source_key: `subagent-spawn:${command.sourceToolCallId}`,
        conversation_id: parent.conversation.id,
        turn_id: parent.turn.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Turn').assert(parent.turn.id as string, { status: ACTIVE_TURN }),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(parent.lease.id as string, {
        conversation_id: parent.conversation.id,
        turn_id: parent.turn.id
      }),
      DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: parent.turn.id }),
      DOMAIN_REPOSITORIES.domain('ToolCall').assert(command.sourceToolCallId, { status: expectedSourceStatus }),
      DOMAIN_REPOSITORIES.domain('ToolExecution').assert(parent.toolExecution.id as string, {
        status: expectedSourceStatus
      }),
      ...(parent.parentChildExecution
        ? [DOMAIN_REPOSITORIES.domain('ChildExecution').assert(parent.parentChildExecution.id as string, {
            status: parent.parentChildExecution.status
          })]
        : []),
      ...(parent.projectLink
        ? [DOMAIN_REPOSITORIES.domain('ConversationProjectLink').assert(
            requirePhaseFId(parent.projectLink.id, 'ConversationProjectLink.id'),
            {
              conversation_id: parent.conversation.id,
              project_context_id: parent.projectLink.project_context_id,
              role: 'primary'
            }
          )]
        : [DOMAIN_REPOSITORIES.domain('ConversationProjectLink').assertNone({
            conversation_id: parent.conversation.id,
            role: 'primary'
          })]),
      ...preparedContentObjectSteps(
        uniquePrepared([requestContent, promptContent, authorityContent]),
        'subagent_spawn_content'
      ),
      DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: ids.childConversationId,
        title: command.title,
        status: 'active',
        created_at: now,
        updated_at: now
      }),
      ...(parent.projectLink
        ? [conversationProjectLinkInsertStep({
            conversationId: ids.childConversationId,
            projectContextId: requirePhaseFId(
              parent.projectLink.project_context_id,
              'ConversationProjectLink.project_context_id'
            ),
            now
          })]
        : []),
      DOMAIN_REPOSITORIES.domain('ConversationOriginLink').insert({
        id: ids.childOriginLinkId,
        conversation_id: ids.childConversationId,
        source_conversation_id: parent.conversation.id,
        source_turn_id: parent.turn.id,
        source_tool_call_id: command.sourceToolCallId,
        source_message_revision_id: null,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: ids.childAgentLinkId,
        conversation_id: ids.childConversationId,
        agent_id: command.childAgentId,
        role: 'default',
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecution').insert({
        id: ids.childExecutionId,
        child_conversation_id: ids.childConversationId,
        status: 'starting',
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').insert({
        id: ids.parentLinkId,
        child_execution_id: ids.childExecutionId,
        source_tool_call_id: command.sourceToolCallId,
        parent_child_execution_id: parent.parentChildExecution?.id ?? null,
        parent_turn_id: parent.turn.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: ids.childTurnId,
        conversation_id: ids.childConversationId,
        status: ACTIVE_TURN,
        created_at: now,
        updated_at: now,
        terminal_at: null
      }),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
        id: ids.childLeaseId,
        conversation_id: ids.childConversationId,
        turn_id: ids.childTurnId,
        owner_id: command.leaseOwnerId,
        host_boot_id: this.database.hostBootId,
        generation: 1n,
        acquired_at: now,
        expires_at: command.leaseExpiresAt
      }),
      DOMAIN_REPOSITORIES.domain('TurnExecutorLink').insert({
        id: ids.childExecutorLinkId,
        turn_id: ids.childTurnId,
        agent_id: command.childAgentId,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').insert({
        id: ids.childAuthoritySnapshotId,
        turn_id: ids.childTurnId,
        content_object_id: authorityContent.metadata.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Message').insert({
        id: ids.childMessageId,
        created_at: now,
        updated_at: now,
        deleted_at: null
      }),
      DOMAIN_REPOSITORIES.domain('MessageRevision').insertWithNextSequence({
        id: ids.childMessageRevisionId,
        message_id: ids.childMessageId,
        role: 'user',
        content_object_id: promptContent.metadata.id,
        created_at: now
      }, {
        column: 'revision_seq',
        scope: { message_id: ids.childMessageId }
      }),
      DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
        id: ids.childMessageCurrentLinkId,
        message_id: ids.childMessageId,
        revision_id: ids.childMessageRevisionId,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insertWithNextSequence({
        id: ids.childMessageMembershipId,
        conversation_id: ids.childConversationId,
        message_id: ids.childMessageId,
        created_at: now
      }, {
        column: 'message_seq',
        scope: { conversation_id: ids.childConversationId }
      }),
      DOMAIN_REPOSITORIES.domain('MessageTurnLink').insert({
        id: ids.childMessageTurnLinkId,
        turn_id: ids.childTurnId,
        message_id: ids.childMessageId,
        role: 'input',
        created_at: now
      }),
      ...promptContext.steps,
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').insert({
        id: ids.turnLinkId,
        child_execution_id: ids.childExecutionId,
        turn_seq: '1',
        turn_id: ids.childTurnId,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').insert({
        id: ids.activeTurnLinkId,
        child_execution_id: ids.childExecutionId,
        turn_id: ids.childTurnId,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('AnswerBridge').insert({
        id: ids.answerBridgeId,
        child_execution_id: ids.childExecutionId,
        current_submission_id: null,
        status: 'open',
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Operation').insertWithNextSequence({
        id: ids.operationId,
        owner_kind: 'child_execution',
        owner_id: ids.childExecutionId,
        tool_call_id: command.sourceSettlement === 'child_handle' ? command.sourceToolCallId : null,
        status: 'pending',
        created_at: now,
        updated_at: now
      }, {
        column: 'operation_seq',
        scope: { owner_kind: 'child_execution', owner_id: ids.childExecutionId }
      }),
      DOMAIN_REPOSITORIES.domain('Attempt').insert({
        id: ids.attemptId,
        operation_id: ids.operationId,
        attempt_seq: '1',
        status: 'pending',
        created_at: now,
        updated_at: now,
        completed_at: null
      }),
      DOMAIN_REPOSITORIES.domain('EffectIntent').insert({
        id: ids.effectIntentId,
        attempt_id: ids.attemptId,
        effect_kind: 'subagent_spawn',
        dispatch_state: 'pending',
        request_object_id: requestContent.metadata.id,
        created_at: now,
        updated_at: now
      }),
      ...(command.sourceSettlement === 'child_handle' ? [
        DOMAIN_REPOSITORIES.domain('ToolCall').update(command.sourceToolCallId, {
          status: 'executing',
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').update(parent.toolExecution.id as string, {
          status: 'executing',
          wait_deadline_at: command.waitDeadlineAt ?? null,
          updated_at: now
        })
      ] : [])
    ];

    try {
      const commit = await this.database.transaction(steps);
      return spawnResult(ids, command.completionPolicy, modelSelection, false, commit.commitSeq);
    } catch (error) {
      if (!isExpectedSpawnIdentityConflict(error)) throw error;
      const raced = await this.findSpawnReplay(command, ids, requestContent);
      if (!raced) throw error;
      return raced;
    }
  }

  public claimSpawnDispatch(effectIntentId: string): Promise<boolean> {
    return this.effects.claimEffectDispatch(requirePhaseFId(effectIntentId, 'effectIntentId'));
  }

  /** Reads the immutable effective model selected for an already-admitted parent Turn. */
  public async frozenModelSelectionForTurn(turnIdInput: string): Promise<TurnModelOverride> {
    const turnId = requirePhaseFId(turnIdInput, 'turnId');
    const snapshots = await this.listRows('AuthoritySnapshot', { turn_id: turnId }, 2);
    if (snapshots.length !== 1) throw new Error(`Turn ${turnId} must have exactly one AuthoritySnapshot.`);
    const frozen = await readFrozenTurnAuthority(
      this.database,
      this.contentStore,
      requirePhaseFId(snapshots[0].id, 'AuthoritySnapshot.id'),
      turnId
    );
    return frozenModelSelection(frozen.document);
  }

  /** Reads the immutable work-environment boundary frozen for one Turn; absent on legacy snapshots. */
  public async frozenWorkEnvironmentPolicyForTurn(
    turnIdInput: string
  ): Promise<FrozenWorkEnvironmentBoundaryPolicy | undefined> {
    const turnId = requirePhaseFId(turnIdInput, 'turnId');
    const snapshots = await this.listRows('AuthoritySnapshot', { turn_id: turnId }, 2);
    if (snapshots.length !== 1) throw new Error(`Turn ${turnId} must have exactly one AuthoritySnapshot.`);
    const frozen = await readFrozenTurnAuthority(
      this.database,
      this.contentStore,
      requirePhaseFId(snapshots[0].id, 'AuthoritySnapshot.id'),
      turnId
    );
    return frozenWorkEnvironmentPolicy(frozen.document);
  }

  public recordSpawnReceipt(input: {
    sourceKey: string;
    attemptId: string;
    outcome: EffectObservedOutcome;
    detail?: unknown;
  }): Promise<RecordedEffectReceipt> {
    return this.effects.recordEffectReceipt({
      source: { kind: 'callback', key: requirePhaseFText(input.sourceKey, 'sourceKey') },
      attemptId: requirePhaseFId(input.attemptId, 'attemptId'),
      effectKind: 'subagent_spawn',
      outcome: input.outcome,
      ...(input.detail === undefined ? {} : { detail: input.detail })
    });
  }

  /** Reconciles the persisted spawn receipt without dispatching the external spawn again. */
  public async reconcileSpawnReceipt(effectReceiptIdInput: string): Promise<{
    childExecutionId: string;
    toolCallId: string;
    status: string;
    terminalToolResult: boolean;
    deduplicated: boolean;
    commitSeq?: string;
  }> {
    const effectReceiptId = requirePhaseFId(effectReceiptIdInput, 'effectReceiptId');
    const facts = await this.readSpawnReceiptFacts(effectReceiptId);
    if (facts.intent.effect_kind !== 'subagent_spawn') throw new Error('EffectReceipt is not a subagent_spawn receipt.');
    const request = spawnRequestMetadata(await this.effects.readEffectRequest(facts.intent.id as string));
    const ownsSourceSettlement = request.sourceSettlement === 'child_handle';
    if (ownsSourceSettlement !== (facts.toolCall !== null && facts.toolExecution !== null)) {
      throw new Error('subagent_spawn source settlement ownership does not match its Operation lineage.');
    }
    const currentOperationStatus = String(facts.operation.status);
    if (currentOperationStatus === 'waiting_answer' || TERMINAL_OPERATION_STATES.has(currentOperationStatus)) {
      const settlement = ownsSourceSettlement && TERMINAL_OPERATION_STATES.has(currentOperationStatus)
        ? await this.finalizeWaitSettlement(request.sourceToolCallId)
        : null;
      return {
        childExecutionId: facts.childExecution.id as string,
        toolCallId: request.sourceToolCallId,
        status: currentOperationStatus,
        terminalToolResult: settlement?.terminal !== undefined,
        deduplicated: true
      };
    }

    const observed = requireSpawnObservedOutcome(facts.receipt.outcome);
    const completionPolicy = request.completionPolicy;
    const now = this.timestamp();
    const currentChildStatus = requireChildExecutionStatus(facts.childExecution.status);
    const cancellationCommitted = currentChildStatus === 'interrupting' || currentChildStatus === 'interrupted';
    const cancelledAfterSpawn = observed === 'succeeded' && cancellationCommitted;
    const successfulWait = observed === 'succeeded'
      && completionPolicy === 'wait_for_answer'
      && !cancelledAfterSpawn;
    const toolStatus = cancelledAfterSpawn ? 'cancelled' : observedToToolOutcome(observed);
    const terminalResultSteps = !ownsSourceSettlement || successfulWait
      ? []
      : await this.prepareWaitResultArtifact(
          request.sourceToolCallId,
          toolStatus,
          cancelledAfterSpawn
            ? {
                childExecutionId: facts.childExecution.id,
                answerBridgeId: facts.bridge.id,
                cancelledSubtree: true,
                reason: 'ChildExecution was interrupted before its spawn receipt was reconciled.'
              }
            : observed === 'succeeded'
            ? childControlHandle(facts.childExecution, facts.bridge)
            : { childExecutionId: facts.childExecution.id, answerBridgeId: facts.bridge.id, spawnOutcome: observed }
        );
    const terminalChild = observed !== 'succeeded';
    const nextChildStatus = cancelledAfterSpawn
      ? currentChildStatus
      : observed === 'succeeded' ? 'active' : observed === 'outcome_unknown' ? 'needs_human' : 'closed';
    assertChildExecutionTransition(currentChildStatus, nextChildStatus);
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('EffectReceipt').assert(effectReceiptId, {
        attempt_id: facts.attempt.id,
        outcome: observed
      }),
      DOMAIN_REPOSITORIES.domain('Attempt').assert(facts.attempt.id as string, { status: facts.attempt.status }),
      DOMAIN_REPOSITORIES.domain('Operation').assert(facts.operation.id as string, { status: facts.operation.status }),
      DOMAIN_REPOSITORIES.domain('ChildExecution').assert(facts.childExecution.id as string, {
        status: facts.childExecution.status
      }),
      DOMAIN_REPOSITORIES.domain('Attempt').update(facts.attempt.id as string, {
        status: observed,
        updated_at: now,
        completed_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Operation').update(facts.operation.id as string, {
        status: successfulWait ? 'waiting_answer' : toolStatus,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecution').update(facts.childExecution.id as string, {
        status: nextChildStatus,
        updated_at: now
      }),
      ...(ownsSourceSettlement && successfulWait
        ? [DOMAIN_REPOSITORIES.domain('ToolExecution').update(facts.toolExecution!.id as string, {
            status: 'waiting_answer',
            updated_at: now
          })]
        : []),
      ...(terminalChild ? terminalChildTurnSteps(facts, observed, now) : []),
      ...terminalResultSteps
    ];
    try {
      const commit = await this.database.transaction(steps);
      const settlement = !ownsSourceSettlement || successfulWait
        ? null
        : await this.finalizeWaitSettlement(request.sourceToolCallId);
      return {
        childExecutionId: facts.childExecution.id as string,
        toolCallId: request.sourceToolCallId,
        status: successfulWait ? 'waiting_answer' : toolStatus,
        terminalToolResult: settlement?.terminal !== undefined,
        deduplicated: false,
        commitSeq: commit.commitSeq
      };
    } catch (error) {
      if (!isExpectedSettlementRace(error)) throw error;
      const latestOperation = await this.requireExisting('Operation', facts.operation.id as string);
      if (latestOperation.status === facts.operation.status) throw error;
      const settlement = ownsSourceSettlement && TERMINAL_OPERATION_STATES.has(String(latestOperation.status))
        ? await this.finalizeWaitSettlement(request.sourceToolCallId)
        : null;
      return {
        childExecutionId: facts.childExecution.id as string,
        toolCallId: request.sourceToolCallId,
        status: String(latestOperation.status),
        terminalToolResult: settlement?.terminal !== undefined,
        deduplicated: true
      };
    }
  }

  /**
   * Level-triggered recovery for the local-only subagent_spawn capability.
   *
   * The durable spawn transaction already created the ChildExecution, child Turn and all lineage
   * links.  Claiming the EffectIntent therefore never creates a second external child object: a
   * pending/dispatched intent can be completed with one stable succeeded receipt and the unique
   * child Turn is subsequently driven by the Child coordinator.  This closes every crash boundary
   * around claim -> receipt -> reconcile without treating an internal scheduler edge as an
   * ambiguous external side effect.
   */
  public async recoverSpawnIntent(effectIntentIdInput: string): Promise<ChildSpawnRecoveryResult> {
    const effectIntentId = requirePhaseFId(effectIntentIdInput, 'effectIntentId');
    let facts = await this.readSpawnIntentFacts(effectIntentId);
    if (facts.intent.effect_kind !== 'subagent_spawn') {
      throw new Error(`EffectIntent ${effectIntentId} is not a subagent_spawn intent.`);
    }

    if (facts.intent.dispatch_state === 'pending') {
      try {
        await this.effects.claimEffectDispatch(effectIntentId);
      } catch (error) {
        // Parent cancellation and dispatch race through the same exact EffectIntent row.  If the
        // cancellation won, the refreshed durable state below is authoritative; a still-pending
        // state means the parent is not currently dispatchable and must be retried by the level
        // scheduler after its recovery owner is established.
        facts = await this.readSpawnIntentFacts(effectIntentId);
        if (facts.intent.dispatch_state === 'pending') return spawnRecoveryResult(facts, false);
        if (facts.intent.dispatch_state !== 'cancelled_before_dispatch') throw error;
      }
      facts = await this.readSpawnIntentFacts(effectIntentId);
    }

    if (facts.intent.dispatch_state === 'dispatched') {
      const receipts = await this.listRows('EffectReceipt', { attempt_id: facts.attempt.id }, 2);
      if (receipts.length > 1) throw new Error(`subagent_spawn ${effectIntentId} has multiple EffectReceipts.`);
      if (receipts.length === 0) {
        await this.effects.recordEffectReceipt({
          source: { kind: 'recovery', key: `child-spawn-receipt:${effectIntentId}` },
          attemptId: requirePhaseFId(facts.attempt.id, 'Attempt.id'),
          effectKind: 'subagent_spawn',
          outcome: 'succeeded',
          detail: { adapter: 'reliable-local-agent-loop', recovered: true }
        });
      }
      facts = await this.readSpawnIntentFacts(effectIntentId);
    }

    if (facts.intent.dispatch_state === 'receipt_written') {
      const receipts = await this.listRows('EffectReceipt', { attempt_id: facts.attempt.id }, 2);
      if (receipts.length !== 1) throw new Error(`receipt_written subagent_spawn ${effectIntentId} lacks one receipt.`);
      await this.reconcileSpawnReceipt(requirePhaseFId(receipts[0].id, 'EffectReceipt.id'));
      facts = await this.readSpawnIntentFacts(effectIntentId);
    } else if (facts.intent.dispatch_state === 'cancelled_before_dispatch') {
      await this.terminalizeCancelledPreparedSpawn(facts);
      facts = await this.readSpawnIntentFacts(effectIntentId);
    }

    return spawnRecoveryResult(facts, true);
  }

  /** Complete pending child continuations in stable lineage order; admission remains a separate CAS. */
  public async listPendingContinuations(childExecutionIdInput?: string): Promise<PendingChildContinuation[]> {
    const childExecutionId = childExecutionIdInput === undefined
      ? undefined
      : requirePhaseFId(childExecutionIdInput, 'childExecutionId');
    const rows = await listAllDomainRows(this.database, 'ChildExecutionIntentLink', {
      ...(childExecutionId ? { child_execution_id: childExecutionId } : {}),
      state: 'pending'
    });
    return rows
      .sort((left, right) => compareBigInt(left.intent_seq, right.intent_seq)
        || String(left.id).localeCompare(String(right.id)))
      .map((row) => ({
        childExecutionId: requirePhaseFId(row.child_execution_id, 'ChildExecutionIntentLink.child_execution_id'),
        turnIntentId: requirePhaseFId(row.turn_intent_id, 'ChildExecutionIntentLink.turn_intent_id'),
        intentSeq: requireBigInt(row.intent_seq, 'ChildExecutionIntentLink.intent_seq').toString()
      }));
  }

  public async send(commandInput: ChildExecutionSendCommand): Promise<ChildExecutionSendResult> {
    const command = normalizeSendCommand(commandInput);
    const ids = sendIds(command);
    const replay = await this.findSendReplay(command, ids);
    if (replay) return replay;
    const snapshot = await this.readExecutionSnapshot(command.childExecutionId);
    const childStatus = requireChildExecutionStatus(snapshot.childExecution.status);
    if (!childExecutionAcceptsContinuation(childStatus) || snapshot.answerBridge.status === 'closed') {
      throw new Error('Cannot send to a closed or interrupting ChildExecution.');
    }
    const parent = await this.readSpawnParent(command.sourceToolCallId);
    if (parent.turn.status !== ACTIVE_TURN || parent.termination !== null || !parent.lease) {
      throw new Error('Child continuation requires an active parent Turn and ExecutionLease.');
    }
    const originalParentTurn = await this.requireExisting('Turn',
      requirePhaseFId(snapshot.parentLink.parent_turn_id, 'ChildExecutionParentLink.parent_turn_id'));
    if (originalParentTurn.conversation_id !== parent.conversation.id) {
      throw new Error('Child continuation is outside the calling Conversation parent lineage.');
    }
    if (parent.toolCall.status !== 'pending' || parent.toolExecution.status !== 'pending') {
      throw new Error('Child continuation source ToolCall is no longer pending.');
    }
    if (!!snapshot.activeTurnLink !== !!snapshot.activeTurn) {
      throw new Error('ChildExecution active Turn facts are incomplete.');
    }
    if (snapshot.activeTurn && snapshot.activeTurn.status !== ACTIVE_TURN && snapshot.activeTurn.status !== TERMINATED_TURN) {
      throw new Error(`ChildExecution active Turn has unsupported status ${String(snapshot.activeTurn.status)}.`);
    }
    const currentTurn = snapshot.activeTurn?.status === ACTIVE_TURN ? snapshot.activeTurn : null;
    const currentActiveLink = currentTurn ? snapshot.activeTurnLink : null;
    const content = await this.contentStore.prepare(
      this.database,
      command.content,
      command.contentType
    );
    const preset = await this.contentStore.prepare(
      this.database,
      canonicalPlainJson({ kind: 'child-continuation', mode: command.mode }),
      TURN_EXECUTION_PRESET_CONTENT_TYPE
    );
    const interrupt = currentTurn && command.mode === 'interrupt_current_turn'
      ? await this.contentStore.prepare(
          this.database,
          canonicalPlainJson({
            kind: 'interrupt-request',
            reason: 'run_agent interrupt_current_turn requested a normal continuation boundary.',
            continuationIntentId: ids.turnIntentId
          }),
          'application/vnd.limcode.turn-interrupt-request+json'
        )
      : content;
    const backgroundResultSteps = command.completionPolicy === 'background'
      ? await this.prepareWaitResultArtifact(
          command.sourceToolCallId,
          'succeeded',
          childControlHandle(snapshot.childExecution, snapshot.answerBridge)
        )
      : [];
    const now = this.timestamp();
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
        id: ids.commandReceiptId,
        source_kind: 'command',
        source_key: command.sourceKey,
        conversation_id: parent.conversation.id,
        turn_id: parent.turn.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Turn').assert(parent.turn.id as string, { status: ACTIVE_TURN }),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(parent.lease.id as string, {
        conversation_id: parent.conversation.id,
        turn_id: parent.turn.id
      }),
      DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: parent.turn.id }),
      DOMAIN_REPOSITORIES.domain('ToolCall').assert(command.sourceToolCallId, { status: 'pending' }),
      DOMAIN_REPOSITORIES.domain('ToolExecution').assert(parent.toolExecution.id as string, { status: 'pending' }),
      DOMAIN_REPOSITORIES.domain('ChildExecution').assert(command.childExecutionId, {
        status: snapshot.childExecution.status
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').assert(snapshot.parentLink.id as string, {
        child_execution_id: command.childExecutionId,
        parent_turn_id: originalParentTurn.id
      }),
      ...(currentTurn && currentActiveLink ? [
        DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assert(currentActiveLink.id as string, {
          child_execution_id: command.childExecutionId,
          turn_id: currentTurn.id
        }),
        DOMAIN_REPOSITORIES.domain('Turn').assert(currentTurn.id as string, { status: ACTIVE_TURN })
      ] : []),
      ...preparedContentObjectSteps(
        uniquePrepared([content, preset, ...(currentTurn ? [interrupt] : [])]),
        'child_send_content'
      ),
      DOMAIN_REPOSITORIES.domain('TurnIntent').insert({
        id: ids.turnIntentId,
        conversation_id: snapshot.childExecution.child_conversation_id,
        turn_id: null,
        state: 'queued',
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('TurnIntentRevision').insert({
        id: ids.turnIntentRevisionId,
        intent_id: ids.turnIntentId,
        revision_seq: '1',
        content_object_id: content.metadata.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('TurnExecutionPresetRevision').insert({
        id: ids.presetRevisionId,
        intent_id: ids.turnIntentId,
        revision_seq: '1',
        preset_object_id: preset.metadata.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').insertWithNextSequence({
        id: ids.intentLinkId,
        child_execution_id: command.childExecutionId,
        turn_intent_id: ids.turnIntentId,
        state: 'pending',
        created_at: now,
        updated_at: now
      }, {
        column: 'intent_seq',
        scope: { child_execution_id: command.childExecutionId }
      }),
      DOMAIN_REPOSITORIES.domain('Operation').insertWithNextSequence({
        id: ids.operationId,
        owner_kind: CHILD_TURN_ANSWER_WAIT_OWNER_KIND,
        owner_id: childContinuationTurnId(command.childExecutionId, ids.turnIntentId),
        tool_call_id: command.sourceToolCallId,
        status: command.completionPolicy === 'wait_for_answer' ? 'waiting_answer' : 'succeeded',
        created_at: now,
        updated_at: now
      }, {
        column: 'operation_seq',
        scope: {
          owner_kind: CHILD_TURN_ANSWER_WAIT_OWNER_KIND,
          owner_id: childContinuationTurnId(command.childExecutionId, ids.turnIntentId)
        }
      }),
      ...(command.completionPolicy === 'wait_for_answer' ? [
        DOMAIN_REPOSITORIES.domain('OutcomePause').insert({
          id: ids.pauseId,
          operation_id: ids.operationId,
          status: 'waiting',
          reason: 'child_answer',
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').update(command.sourceToolCallId, {
          status: 'waiting_answer',
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').update(parent.toolExecution.id as string, {
          status: 'waiting_answer',
          wait_deadline_at: command.waitDeadlineAt,
          updated_at: now
        })
      ] : backgroundResultSteps),
      ...(currentTurn ? [DOMAIN_REPOSITORIES.domain('PendingTurnInput').insertWithNextPosition({
        id: ids.pendingTurnInputId,
        turn_id: currentTurn.id,
        input_kind: command.mode,
        content_object_id: interrupt.metadata.id,
        state: 'pending',
        created_at: now,
        updated_at: now
      })] : []),
      DOMAIN_REPOSITORIES.domain('Conversation').update(snapshot.childExecution.child_conversation_id as string, {
        updated_at: now
      })
    ];
    try {
      const commit = await this.database.transaction(steps);
      return sendResult(command, ids, currentTurn !== null, false, commit.commitSeq);
    } catch (error) {
      if (!isExpectedSendIdentityConflict(error)) throw error;
      const raced = await this.findSendReplay(command, ids, content);
      if (!raced) throw error;
      return raced;
    }
  }

  /**
   * Queues one invisible child continuation for a durable next-turn RuntimeDelivery. The delivery
   * identity owns the intent identity, so wake replay cannot create a second child generation.
   */
  public async queueRuntimeDeliveryContinuation(
    commandInput: ChildRuntimeDeliveryContinuationCommand
  ): Promise<ChildRuntimeDeliveryContinuationResult | null> {
    const command = normalizeRuntimeDeliveryContinuationCommand(commandInput);
    const ids = runtimeDeliveryContinuationIds(command);
    const replay = await this.findRuntimeDeliveryContinuationReplay(command, ids);
    if (replay) return replay;

    const snapshot = await this.readExecutionSnapshot(command.childExecutionId);
    const childStatus = requireChildExecutionStatus(snapshot.childExecution.status);
    if (childStatus !== 'idle' || snapshot.activeTurnLink !== null) return null;
    if ((await this.listRows('ChildExecutionIntentLink', {
      child_execution_id: command.childExecutionId,
      state: 'pending'
    }, 1)).length > 0) return null;
    if (snapshot.answerBridge.status === 'closed') return null;
    const allTurnLinks = await listAllDomainRows(this.database, 'ChildExecutionTurnLink', {
      child_execution_id: command.childExecutionId
    });
    const sourceLink = allTurnLinks.find((link) => link.turn_id === command.sourceTurnId);
    if (!sourceLink) throw new Error('Runtime delivery source Turn is not a member of the ChildExecution.');
    const latestLink = [...allTurnLinks].sort((left, right) =>
      compareBigInt(right.turn_seq, left.turn_seq)
    )[0];
    if (!latestLink || latestLink.id !== sourceLink.id) return null;
    const sourceTurn = await this.requireExisting('Turn', command.sourceTurnId);
    const sourceTerminations = await this.listRows('TurnTermination', {
      turn_id: command.sourceTurnId
    }, 2);
    if (
      sourceTurn.status !== TERMINATED_TURN
      || sourceTerminations.length !== 1
      || sourceTerminations[0].terminal_status !== 'completed'
    ) return null;
    const delivery = await this.requireExisting('RuntimeDelivery', command.deliveryId);
    if (
      delivery.state !== 'pending'
      || delivery.phase !== 'next_turn'
      || delivery.target_turn_id !== null
      || delivery.target_conversation_id !== snapshot.childExecution.child_conversation_id
    ) return null;

    const [intentContent, presetContent] = await Promise.all([
      this.contentStore.prepare(
        this.database,
        canonicalPlainJson(runtimeContinuationTurnIntentEnvelope({
          sourceTurnId: command.sourceTurnId
        })),
        RUNTIME_DELIVERY_CONTINUATION_CONTENT_TYPE
      ),
      this.contentStore.prepare(
        this.database,
        canonicalPlainJson({ kind: 'runtime_continuation' }),
        TURN_EXECUTION_PRESET_CONTENT_TYPE
      )
    ]);
    const now = this.timestamp();
    try {
      const commit = await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
          id: ids.commandReceiptId,
          source_kind: 'internal',
          source_key: ids.sourceKey,
          conversation_id: snapshot.childExecution.child_conversation_id,
          turn_id: command.sourceTurnId,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ChildExecution').assert(command.childExecutionId, {
          status: 'idle'
        }),
        DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assertNone({
          child_execution_id: command.childExecutionId
        }),
        DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').assertNone({
          child_execution_id: command.childExecutionId,
          state: 'pending'
        }),
        DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').assertExactIds(
          { child_execution_id: command.childExecutionId },
          allTurnLinks.map((link) => requirePhaseFId(link.id, 'ChildExecutionTurnLink.id'))
        ),
        DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').assert(
          requirePhaseFId(sourceLink.id, 'ChildExecutionTurnLink.id'),
          {
            child_execution_id: command.childExecutionId,
            turn_id: command.sourceTurnId,
            turn_seq: sourceLink.turn_seq
          }
        ),
        DOMAIN_REPOSITORIES.domain('Turn').assert(command.sourceTurnId, {
          status: TERMINATED_TURN
        }),
        DOMAIN_REPOSITORIES.domain('TurnTermination').assert(
          requirePhaseFId(sourceTerminations[0].id, 'TurnTermination.id'),
          { turn_id: command.sourceTurnId, terminal_status: 'completed' }
        ),
        DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(command.deliveryId, {
          state: 'pending',
          phase: 'next_turn',
          target_conversation_id: snapshot.childExecution.child_conversation_id,
          target_turn_id: null
        }),
        ...preparedContentObjectSteps([intentContent, presetContent], 'child_runtime_delivery'),
        DOMAIN_REPOSITORIES.domain('TurnIntent').insert({
          id: ids.turnIntentId,
          conversation_id: snapshot.childExecution.child_conversation_id,
          turn_id: null,
          state: 'queued',
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('RuntimeDeliveryIntentLink').insert({
          id: ids.deliveryIntentLinkId,
          delivery_id: command.deliveryId,
          turn_intent_id: ids.turnIntentId,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('TurnIntentRevision').insert({
          id: ids.turnIntentRevisionId,
          intent_id: ids.turnIntentId,
          revision_seq: '1',
          content_object_id: intentContent.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('TurnExecutionPresetRevision').insert({
          id: ids.presetRevisionId,
          intent_id: ids.turnIntentId,
          revision_seq: '1',
          preset_object_id: presetContent.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').insertWithNextSequence({
          id: ids.intentLinkId,
          child_execution_id: command.childExecutionId,
          turn_intent_id: ids.turnIntentId,
          state: 'pending',
          created_at: now,
          updated_at: now
        }, {
          column: 'intent_seq',
          scope: { child_execution_id: command.childExecutionId }
        }),
        DOMAIN_REPOSITORIES.domain('Conversation').update(
          requirePhaseFId(snapshot.childExecution.child_conversation_id, 'ChildExecution.child_conversation_id'),
          { updated_at: now }
        )
      ]);
      return {
        childExecutionId: command.childExecutionId,
        turnIntentId: ids.turnIntentId,
        intentLinkId: ids.intentLinkId,
        deduplicated: false,
        commitSeq: commit.commitSeq
      };
    } catch (error) {
      if (!isExpectedRuntimeDeliveryContinuationConflict(error)) throw error;
      const raced = await this.findRuntimeDeliveryContinuationReplay(command, ids);
      if (raced) return raced;
      if (isTransactionAssertionFailure(error)) return null;
      throw error;
    }
  }

  /** Admits a queued continuation without creating a new ChildExecution or AnswerBridge. */
  public async admitQueuedIntent(
    commandInput: ChildContinuationAdmissionCommand
  ): Promise<ChildContinuationAdmissionResult> {
    const command = normalizeAdmissionCommand(commandInput);
    const ids = admissionIds(command);
    const replay = await this.findAdmissionReplay(command, ids);
    if (replay) return replay;
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ChildExecution').get(command.childExecutionId),
      DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').list({
        where: { child_execution_id: command.childExecutionId, turn_intent_id: command.turnIntentId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('TurnIntent').get(command.turnIntentId),
      DOMAIN_REPOSITORIES.domain('TurnIntentRevision').list({
        where: { intent_id: command.turnIntentId, revision_seq: '1' },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('TurnExecutionPresetRevision').list({
        where: { intent_id: command.turnIntentId, revision_seq: '1' },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').list({
        where: { child_execution_id: command.childExecutionId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('AnswerBridge').list({
        where: { child_execution_id: command.childExecutionId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('PendingTurnInput').get(
        queuedIntentPendingInputId(command.childExecutionId, command.turnIntentId)
      ),
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').list({
        where: { child_execution_id: command.childExecutionId },
        orderBy: { column: 'turn_seq', direction: 'desc' },
        limit: 1
      })
    ]);
    const child = requireRow(snapshot.snapshot[0], `ChildExecution ${command.childExecutionId}`);
    const agentLinks = await this.listRows('AgentConversationLink', {
      conversation_id: requirePhaseFId(
        child.child_conversation_id,
        'ChildExecution.child_conversation_id'
      ),
      role: 'default'
    }, 2);
    const intentLinks = requireRows(snapshot.snapshot[1], 'ChildExecutionIntentLink admission lookup');
    if (intentLinks.length !== 1) throw new Error('Queued continuation must have exactly one ChildExecutionIntentLink.');
    const intentLink = intentLinks[0];
    const intent = requireRow(snapshot.snapshot[2], `TurnIntent ${command.turnIntentId}`);
    if (intent.state !== 'queued' || intentLink.state !== 'pending') {
      throw new Error('Child continuation intent is not pending admission.');
    }
    const revisions = requireRows(snapshot.snapshot[3], 'TurnIntentRevision admission lookup');
    const presets = requireRows(snapshot.snapshot[4], 'TurnExecutionPresetRevision admission lookup');
    if (revisions.length !== 1 || presets.length !== 1) {
      throw new Error('Child continuation intent must have one immutable input and preset revision.');
    }
    const activeLinks = requireRows(snapshot.snapshot[5], 'ChildExecutionActiveTurnLink admission lookup');
    if (activeLinks.length > 1) throw new Error('ChildExecution has multiple active Turn links.');
    const activeLink = activeLinks[0] ?? null;
    const sourcePendingInput = snapshot.snapshot[7] === null
      ? null
      : requireRow(snapshot.snapshot[7], 'Queued continuation source PendingTurnInput');
    const latestTurnLinks = requireRows(snapshot.snapshot[8], 'ChildExecution latest Turn membership lookup');
    const previousTurnId = sourcePendingInput
      ? requirePhaseFId(sourcePendingInput.turn_id, 'PendingTurnInput.turn_id')
      : activeLink
        ? requirePhaseFId(activeLink.turn_id, 'ActiveTurnLink.turn_id')
        : latestTurnLinks[0]
          ? requirePhaseFId(latestTurnLinks[0].turn_id, 'ChildExecutionTurnLink.turn_id')
          : null;
    const previousTurn = previousTurnId
      ? await this.requireExisting('Turn', previousTurnId)
      : null;
    if (!previousTurn) throw new Error('Child continuation requires a previous lineage Turn.');
    if (previousTurn.status === ACTIVE_TURN) {
      throw new Error('Queued continuation cannot be admitted while the previous child Turn is active.');
    }
    if (previousTurn.status !== TERMINATED_TURN) {
      throw new Error(`Previous child Turn has unsupported status ${String(previousTurn.status)}.`);
    }
    const bridges = requireRows(snapshot.snapshot[6], 'AnswerBridge admission lookup');
    if (bridges.length !== 1) throw new Error('ChildExecution must retain exactly one AnswerBridge.');
    const bridge = bridges[0];
    const childStatus = requireChildExecutionStatus(child.status);
    if (!childExecutionAcceptsContinuation(childStatus) || bridge.status === 'closed') {
      throw new Error('Cannot admit a continuation for a closed or interrupting ChildExecution.');
    }
    if (agentLinks.length !== 1) throw new Error('Child Conversation must have one default Agent link.');
    const executorAgentId = requirePhaseFId(agentLinks[0].agent_id, 'AgentConversationLink.agent_id');
    const childConversationId = requirePhaseFId(child.child_conversation_id, 'ChildExecution.child_conversation_id');
    const intentContentObjectId = requirePhaseFId(
      revisions[0].content_object_id,
      'TurnIntentRevision.content_object_id'
    );
    let messageContentObject = await this.requireExisting('ContentObject', intentContentObjectId);
    const invisibleRuntimeDelivery = messageContentObject.content_type === RUNTIME_DELIVERY_CONTINUATION_CONTENT_TYPE;
    const deliveryIntentLink = invisibleRuntimeDelivery
      ? (await this.listRows('RuntimeDeliveryIntentLink', { turn_intent_id: command.turnIntentId }, 2))[0]
      : undefined;
    if (invisibleRuntimeDelivery && !deliveryIntentLink) {
      throw new Error(`Child Runtime continuation TurnIntent ${command.turnIntentId} has no RuntimeDeliveryIntentLink.`);
    }
    if (messageContentObject.content_type === TURN_INTENT_ENVELOPE_CONTENT_TYPE) {
      const envelope = parseInputTurnIntentEnvelopeText(
        (await this.contentStore.read(messageContentObject as ContentObjectMetadata)).toString('utf8')
      );
      if (envelope) {
        messageContentObject = await this.requireExisting(
          'ContentObject',
          envelope.messageContentObjectId
        );
      }
    }
    const messageContentObjectId = requirePhaseFId(
      messageContentObject.id,
      'queued child message ContentObject.id'
    );
    const messageContentType = requirePhaseFText(messageContentObject.content_type, 'ContentObject.content_type');
    const workspace = await projectFolderForConversation(this.database, childConversationId);
    const inheritedBoundary = await this.frozenWorkEnvironmentPolicyForTurn(
      requirePhaseFId(previousTurn.id, 'previous Turn.id')
    );
    const compiled = normalizeCompiledTurnAuthority(await this.authorityCompiler.compile({
      conversationId: childConversationId,
      turnId: ids.turnId,
      executorAgentId,
      intentKind: invisibleRuntimeDelivery ? 'runtime_continuation' : 'continuation',
      sourceTurnId: requirePhaseFId(previousTurn.id, 'previous Turn.id'),
      ...(workspace ? { workspace } : {}),
      ...(inheritedBoundary ? { inheritedWorkEnvironmentPolicy: inheritedBoundary } : {})
    }), ids.turnId, executorAgentId);
    const authorityContent = await this.contentStore.prepare(
      this.database,
      compiled.authoritySnapshot.content,
      compiled.authoritySnapshot.contentType
    );
    const messageContentBytes = invisibleRuntimeDelivery
      ? undefined
      : await this.contentStore.read(messageContentObject as ContentObjectMetadata);
    const attachmentAdmission: PreparedMessageAttachmentAdmission | null = invisibleRuntimeDelivery
      ? null
      : this.attachments
        ? await this.attachments.prepareFrozenMessageContent({
            content: messageContentBytes!,
            contentType: messageContentType
          })
        : {
            value: messageContentBytes!,
            contentType: messageContentType,
            attachments: [],
            storageSteps: [],
            totalBytes: 0
          };
    const admittedMessageContent = attachmentAdmission
      ? await this.contentStore.prepare(
          this.database,
          attachmentAdmission.value,
          attachmentAdmission.contentType
        )
      : null;
    const messageEstimatedTokens = invisibleRuntimeDelivery
      ? undefined
      : estimateStoredMessageContentTokens(
          attachmentAdmission!.value,
          attachmentAdmission!.contentType
        );
    const messageContext = invisibleRuntimeDelivery
      ? null
      : await this.contextSequence.prepareMessageAppendMutation({
          conversationId: requirePhaseFId(child.child_conversation_id, 'ChildExecution.child_conversation_id'),
          messageRevisionId: ids.messageRevisionId,
          contentObjectId: admittedMessageContent!.metadata.id,
          contentByteLength: admittedMessageContent!.metadata.byte_length,
          contentEstimatedTokens: messageEstimatedTokens
        });
    const now = this.timestamp();
    const nextDeliverySteps = this.prepareNextTurnDeliverySteps
      ? await this.prepareNextTurnDeliverySteps(child.child_conversation_id as string, ids.turnId, now)
      : [];
    const activeMutation = activeLink
      ? DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').update(activeLink.id as string, {
          turn_id: ids.turnId,
          updated_at: now
        })
      : DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').insert({
          id: stablePhaseFId('child_execution_active_turn_link', command.childExecutionId),
          child_execution_id: command.childExecutionId,
          turn_id: ids.turnId,
          updated_at: now
        });
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
        id: ids.commandReceiptId,
        source_kind: 'internal',
        source_key: command.sourceKey,
        conversation_id: child.child_conversation_id,
        turn_id: ids.turnId,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecution').assert(command.childExecutionId, { status: child.status }),
      DOMAIN_REPOSITORIES.domain('AnswerBridge').assert(bridge.id as string, {
        child_execution_id: command.childExecutionId,
        status: bridge.status,
        current_submission_id: bridge.current_submission_id
      }),
      DOMAIN_REPOSITORIES.domain('AnswerBridge').update(bridge.id as string, {
        status: 'open',
        current_submission_id: null,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('TurnIntent').assert(command.turnIntentId, { state: 'queued', turn_id: null }),
      ...(deliveryIntentLink ? [
        DOMAIN_REPOSITORIES.domain('RuntimeDeliveryIntentLink').assert(
          requirePhaseFId(deliveryIntentLink.id, 'RuntimeDeliveryIntentLink.id'),
          {
            delivery_id: requirePhaseFId(deliveryIntentLink.delivery_id, 'RuntimeDeliveryIntentLink.delivery_id'),
            turn_intent_id: command.turnIntentId
          }
        )
      ] : []),
      DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').assert(intentLink.id as string, {
        child_execution_id: command.childExecutionId,
        turn_intent_id: command.turnIntentId,
        state: 'pending'
      }),
      ...(activeLink
        ? [
            DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assert(activeLink.id as string, {
              child_execution_id: command.childExecutionId,
              turn_id: activeLink.turn_id
            }),
            DOMAIN_REPOSITORIES.domain('Turn').assert(previousTurn.id as string, { status: TERMINATED_TURN })
          ]
        : []),
      DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: ids.turnId,
        conversation_id: child.child_conversation_id,
        status: ACTIVE_TURN,
        created_at: now,
        updated_at: now,
        terminal_at: null
      }),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
        id: ids.leaseId,
        conversation_id: child.child_conversation_id,
        turn_id: ids.turnId,
        owner_id: command.leaseOwnerId,
        host_boot_id: this.database.hostBootId,
        generation: 1n,
        acquired_at: now,
        expires_at: command.leaseExpiresAt
      }),
      ...preparedContentObjectSteps([authorityContent], 'child_continuation_authority'),
      DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').insert({
        id: ids.authoritySnapshotId,
        turn_id: ids.turnId,
        content_object_id: authorityContent.metadata.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('TurnExecutorLink').insert({
        id: ids.executorLinkId,
        turn_id: ids.turnId,
        agent_id: executorAgentId,
        created_at: now
      }),
      ...(!messageContext ? [] : [
        ...attachmentAdmission!.storageSteps,
        ...preparedContentObjectSteps([admittedMessageContent!], 'child_continuation_message'),
        DOMAIN_REPOSITORIES.domain('Message').insert({
          id: ids.messageId,
          created_at: now,
          updated_at: now,
          deleted_at: null
        }),
        DOMAIN_REPOSITORIES.domain('MessageRevision').insertWithNextSequence({
          id: ids.messageRevisionId,
          message_id: ids.messageId,
          role: 'user',
          content_object_id: admittedMessageContent!.metadata.id,
          created_at: now
        }, {
          column: 'revision_seq',
          scope: { message_id: ids.messageId }
        }),
        ...(this.attachments
          ? this.attachments.linkSteps(attachmentAdmission!, ids.messageRevisionId, now)
          : []),
        DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
          id: ids.messageCurrentLinkId,
          message_id: ids.messageId,
          revision_id: ids.messageRevisionId,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insertWithNextSequence({
          id: ids.messageMembershipId,
          conversation_id: child.child_conversation_id,
          message_id: ids.messageId,
          created_at: now
        }, {
          column: 'message_seq',
          scope: { conversation_id: child.child_conversation_id }
        }),
        DOMAIN_REPOSITORIES.domain('MessageTurnLink').insert({
          id: ids.messageTurnLinkId,
          turn_id: ids.turnId,
          message_id: ids.messageId,
          role: 'input',
          created_at: now
        }),
        ...messageContext.steps
      ]),
      ...(sourcePendingInput ? [
        DOMAIN_REPOSITORIES.domain('PendingTurnInput').assert(
          requirePhaseFId(sourcePendingInput.id, 'PendingTurnInput.id'),
          { turn_id: previousTurn.id, state: 'pending' }
        ),
        DOMAIN_REPOSITORIES.domain('PendingTurnInput').delete(
          requirePhaseFId(sourcePendingInput.id, 'PendingTurnInput.id')
        )
      ] : []),
      DOMAIN_REPOSITORIES.domain('TurnIntent').update(command.turnIntentId, {
        turn_id: ids.turnId,
        state: 'admitted',
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').update(intentLink.id as string, {
        state: 'admitted',
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').insertWithNextSequence({
        id: ids.turnLinkId,
        child_execution_id: command.childExecutionId,
        turn_id: ids.turnId,
        created_at: now
      }, {
        column: 'turn_seq',
        scope: { child_execution_id: command.childExecutionId }
      }),
      activeMutation,
      ...nextDeliverySteps,
      DOMAIN_REPOSITORIES.domain('ChildExecution').update(command.childExecutionId, {
        status: 'active',
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Conversation').update(child.child_conversation_id as string, {
        updated_at: now
      })
    ];
    try {
      const commit = await this.database.transaction(steps);
      const turnSeq = allocatedValue(commit.allocatedSequences, 'ChildExecutionTurnLink', ids.turnLinkId, 'turn_seq');
      return {
        childExecutionId: command.childExecutionId,
        turnIntentId: command.turnIntentId,
        turnId: ids.turnId,
        turnSeq,
        answerBridgeId: bridge.id as string,
        deduplicated: false,
        commitSeq: commit.commitSeq
      };
    } catch (error) {
      if (!isExpectedAdmissionIdentityConflict(error)) throw error;
      const raced = await this.findAdmissionReplay(command, ids);
      if (!raced) throw error;
      return raced;
    }
  }

  /**
   * Recurses over stable ParentLink edges and writes every active termination request plus every
   * pending IntentLink cancellation in one SQLite transaction. ActiveTurnLink is never used to infer
   * tree membership.
   */
  /**
   * Interrupts the current run generation for this stable ChildExecution tree. The logical child
   * conversations and AnswerBridges remain resumable; permanent close/delete is a separate action.
   */
  public async interruptSubtree(commandInput: ChildExecutionCancelCommand): Promise<ChildExecutionCancelSubtreeResult> {
    const command = normalizeCancelCommand(commandInput);
    const replay = await this.findInterruptionReplay(command);
    if (replay) {
      let waitsSettled = 0;
      for (const childExecutionId of replay.result.lineageIds) {
        const settled = await this.settleCancelledExecutionWaits({
          childExecutionId,
          reason: replay.reason,
          sourceIdentity: `interrupt-replay:${command.sourceKey}`
        });
        waitsSettled += Number(settled.foregroundSettled) + settled.continuationSettlements;
      }
      return { ...replay.result, waitsSettled };
    }
    return this.interruptSubtreeAttempt(command);
  }

  /** Re-enters a durable subtree interruption from any descendant after one child Turn stops. */
  public async reconcileCancelledLineage(
    childExecutionIdInput: string,
    _observedReason?: string
  ): Promise<ChildExecutionCancelSubtreeResult | null> {
    const childExecutionId = requirePhaseFId(childExecutionIdInput, 'childExecutionId');
    const seen = new Set<string>();
    let cursor: string | null = childExecutionId;
    while (cursor) {
      if (seen.has(cursor)) throw new Error('ChildExecution parent lineage contains a cycle.');
      seen.add(cursor);
      const child = await this.requireExisting('ChildExecution', cursor);
      if (isChildExecutionInterrupting(requireChildExecutionStatus(child.status))) {
        return this.interruptSubtree({
          sourceKey: childInterruptionRecoverySourceKey(cursor),
          childExecutionId: cursor,
          reason: CHILD_INTERRUPTION_RECOVERY_REASON
        });
      }
      const parentLinks = await this.listRows('ChildExecutionParentLink', {
        child_execution_id: cursor
      }, 2);
      if (parentLinks.length !== 1) {
        throw new Error(`ChildExecution ${cursor} must retain exactly one parent link.`);
      }
      cursor = parentLinks[0].parent_child_execution_id === null
        ? null
        : requirePhaseFId(
            parentLinks[0].parent_child_execution_id,
            'ChildExecutionParentLink.parent_child_execution_id'
          );
    }
    return null;
  }

  private async interruptSubtreeAttempt(
    command: ReturnType<typeof normalizeCancelCommand>,
    previousConflict?: { treeIdentity: string; error: unknown }
  ): Promise<ChildExecutionCancelSubtreeResult> {
    const tree = await this.readStableTreeSnapshot(command.childExecutionId);
    const treeIdentity = this.interruptionTreeIdentity(tree);
    if (previousConflict?.treeIdentity === treeIdentity) throw previousConflict.error;
    const lineageStatuses = new Map(tree.lineages.map((lineage) => [
      requirePhaseFId(lineage.id, 'ChildExecution.id'),
      requireChildExecutionStatus(lineage.status)
    ]));
    const rootStatus = requireChildExecutionStatus(tree.root.status);
    if (isChildExecutionPermanentlyTerminal(rootStatus)) {
      throw new Error(`Cannot interrupt permanently terminal ChildExecution ${command.childExecutionId}.`);
    }
    const targetLineages = tree.lineages.filter((lineage) =>
      !isChildExecutionPermanentlyTerminal(
        lineageStatuses.get(requirePhaseFId(lineage.id, 'ChildExecution.id'))!
      )
    );
    const targetLineageIds = new Set(targetLineages.map((lineage) =>
      requirePhaseFId(lineage.id, 'ChildExecution.id')
    ));
    const targetActiveLinks = tree.activeLinks.filter((link) =>
      targetLineageIds.has(requirePhaseFId(link.child_execution_id, 'ChildExecutionActiveTurnLink.child_execution_id'))
    );
    const targetActiveTurnIds = new Set(targetActiveLinks.map((link) =>
      requirePhaseFId(link.turn_id, 'ChildExecutionActiveTurnLink.turn_id')
    ));
    const targetActiveTurns = tree.activeTurns.filter((turn) =>
      targetActiveTurnIds.has(requirePhaseFId(turn.id, 'Turn.id'))
    );
    const targetPendingIntentLinks = tree.pendingIntentLinks.filter((link) =>
      targetLineageIds.has(requirePhaseFId(link.child_execution_id, 'ChildExecutionIntentLink.child_execution_id'))
    );
    const terminalLineageIds = new Set(tree.lineages
      .map((lineage) => requirePhaseFId(lineage.id, 'ChildExecution.id'))
      .filter((id) => !targetLineageIds.has(id)));
    if (tree.activeLinks.some((link) => terminalLineageIds.has(String(link.child_execution_id)))) {
      throw new Error('Permanently terminal ChildExecution cannot retain an active Turn link.');
    }
    if (tree.pendingIntentLinks.some((link) => terminalLineageIds.has(String(link.child_execution_id)))) {
      throw new Error('Permanently terminal ChildExecution cannot retain a pending continuation intent.');
    }
    const content = await this.contentStore.prepare(
      this.database,
      canonicalPlainJson({
        kind: 'subagent-interrupt-subtree',
        rootChildExecutionId: command.childExecutionId,
        reason: command.reason
      }),
      'application/vnd.limcode.turn-interrupt-request+json'
    );
    const sourceKind = command.sourceKey.startsWith('recovery:') ? 'recovery' : 'command';
    const interruptionRequestId = stablePhaseFId(
      'child_interruption_request',
      sourceKind,
      command.sourceKey
    );
    const now = this.timestamp();
    const liveActiveTurns = targetActiveTurns.filter((turn) => turn.status === ACTIVE_TURN);
    const shouldTerminalize = liveActiveTurns.length === 0;
    const newTerminationTurns = targetActiveTurns.filter((turn) =>
      turn.status === ACTIVE_TURN
      && !tree.pendingInputIds.has(stablePhaseFId(
        'pending_turn_input', 'child-interruption-turn', turn.id
      ))
    );
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
        id: stablePhaseFId('command_receipt', 'interrupt-subtree', sourceKind, command.sourceKey),
        source_kind: sourceKind,
        source_key: command.sourceKey,
        conversation_id: tree.root.child_conversation_id,
        turn_id: targetActiveTurns[0]?.id ?? null,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ChildInterruptionRequest').insert({
        id: interruptionRequestId,
        root_child_execution_id: command.childExecutionId,
        source_kind: sourceKind,
        source_key: command.sourceKey,
        reason: command.reason,
        created_at: now
      }),
      ...tree.parentLinks.map((link) => DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').assert(
        link.id as string,
        {
          child_execution_id: link.child_execution_id,
          parent_child_execution_id: link.parent_child_execution_id,
          parent_turn_id: link.parent_turn_id
        }
      )),
      ...tree.lineages.flatMap((lineage) => [
        DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').assertExactIds(
          { parent_child_execution_id: lineage.id },
          tree.parentLinks
            .filter((link) => link.parent_child_execution_id === lineage.id)
            .map((link) => requirePhaseFId(link.id, 'ChildExecutionParentLink.id'))
        ),
        DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assertExactIds(
          { child_execution_id: lineage.id },
          tree.activeLinks
            .filter((link) => link.child_execution_id === lineage.id)
            .map((link) => requirePhaseFId(link.id, 'ChildExecutionActiveTurnLink.id'))
        ),
        DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').assertExactIds(
          { child_execution_id: lineage.id },
          tree.intentLinks
            .filter((link) => link.child_execution_id === lineage.id)
            .map((link) => requirePhaseFId(link.id, 'ChildExecutionIntentLink.id'))
        )
      ]),
      ...tree.activeLinks.map((link) => DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assert(
        link.id as string,
        { child_execution_id: link.child_execution_id, turn_id: link.turn_id }
      )),
      ...tree.lineages.map((lineage) => DOMAIN_REPOSITORIES.domain('ChildExecution').assert(
        requirePhaseFId(lineage.id, 'ChildExecution.id'),
        { status: lineage.status }
      )),
      ...preparedContentObjectSteps([content], 'interrupt_subtree'),
      ...targetActiveTurns.flatMap((turn) => {
        const inputId = stablePhaseFId(
          'pending_turn_input', 'child-interruption-turn', turn.id
        );
        if (tree.pendingInputIds.has(inputId) || turn.status !== ACTIVE_TURN) return [];
        return [
          DOMAIN_REPOSITORIES.domain('Turn').assert(turn.id as string, { status: ACTIVE_TURN }),
          DOMAIN_REPOSITORIES.domain('PendingTurnInput').insertWithNextPosition({
            id: inputId,
            turn_id: turn.id,
            input_kind: 'termination_request',
            content_object_id: content.metadata.id,
            state: 'pending',
            created_at: now,
            updated_at: now
          })
        ];
      }),
      ...targetLineages.map((lineage) => DOMAIN_REPOSITORIES.domain(
        'ChildInterruptionLineageLink'
      ).insert({
        id: stablePhaseFId('child_interruption_lineage_link', interruptionRequestId, lineage.id as string),
        interruption_request_id: interruptionRequestId,
        child_execution_id: lineage.id,
        created_at: now
      })),
      ...targetActiveTurns.map((turn) => {
        const activeLink = targetActiveLinks.find((link) => link.turn_id === turn.id);
        if (!activeLink) throw new Error('Interrupted Turn lost its ChildExecution active membership.');
        return DOMAIN_REPOSITORIES.domain('ChildInterruptionTurnLink').insert({
          id: stablePhaseFId('child_interruption_turn_link', interruptionRequestId, turn.id as string),
          interruption_request_id: interruptionRequestId,
          child_execution_id: activeLink.child_execution_id,
          turn_id: turn.id,
          pending_turn_input_id: stablePhaseFId('pending_turn_input', 'child-interruption-turn', turn.id as string),
          created_at: now
        });
      }),
      ...targetPendingIntentLinks.map((link) => DOMAIN_REPOSITORIES.domain(
        'ChildInterruptionIntentLink'
      ).insert({
        id: stablePhaseFId('child_interruption_intent_link', interruptionRequestId, link.id as string),
        interruption_request_id: interruptionRequestId,
        child_execution_id: link.child_execution_id,
        child_execution_intent_link_id: link.id,
        created_at: now
      })),
      ...targetPendingIntentLinks.flatMap((link) => [
        DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').assert(link.id as string, { state: 'pending' }),
        DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').update(link.id as string, {
          state: 'cancelled',
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('TurnIntent').update(link.turn_intent_id as string, {
          state: 'cancelled',
          updated_at: now
        }),
        ...(() => {
          const pendingInputId = queuedIntentPendingInputId(
            requirePhaseFId(link.child_execution_id, 'ChildExecutionIntentLink.child_execution_id'),
            requirePhaseFId(link.turn_intent_id, 'ChildExecutionIntentLink.turn_intent_id')
          );
          const pendingInput = tree.pendingInputs.find((input) => input.id === pendingInputId);
          if (!pendingInput || pendingInput.state !== 'pending') return [];
          if (!['queue_next_turn', 'interrupt_current_turn'].includes(String(pendingInput.input_kind))) {
            throw new Error(`Child continuation ${String(link.turn_intent_id)} has an unexpected PendingTurnInput kind.`);
          }
          return [
            DOMAIN_REPOSITORIES.domain('PendingTurnInput').assert(pendingInputId, {
              turn_id: pendingInput.turn_id,
              input_kind: pendingInput.input_kind,
              state: 'pending'
            }),
            DOMAIN_REPOSITORIES.domain('PendingTurnInput').update(pendingInputId, {
              state: 'consumed',
              updated_at: now
            })
          ];
        })()
      ]),
      ...(shouldTerminalize ? targetActiveLinks.flatMap((link) => {
        const target = targetActiveTurns.find((turn) => turn.id === link.turn_id);
        if (!target || target.status !== TERMINATED_TURN) return [];
        return [DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').delete(
          requirePhaseFId(link.id, 'ChildExecutionActiveTurnLink.id')
        )];
      }) : []),
      ...targetLineages.map((child) => {
        const childId = requirePhaseFId(child.id, 'ChildExecution.id');
        const from = lineageStatuses.get(childId)!;
        const to = shouldTerminalize ? 'interrupted' : 'interrupting';
        assertChildExecutionTransition(from, to);
        return DOMAIN_REPOSITORIES.domain('ChildExecution').update(childId, {
          status: to,
          updated_at: now
        });
      }),
      ...(shouldTerminalize ? tree.answerBridges
        .filter((bridge) => targetLineageIds.has(String(bridge.child_execution_id)))
        .filter((bridge) => bridge.current_submission_id === null)
        .map((bridge) => DOMAIN_REPOSITORIES.domain('AnswerBridge').update(
          requirePhaseFId(bridge.id, 'AnswerBridge.id'),
          { status: 'interrupted', updated_at: now }
        )) : [])
    ];
    let commit: Awaited<ReturnType<RuntimeDatabase['transaction']>>;
    try {
      commit = await this.database.transaction(steps);
    } catch (error) {
      if (isExpectedCancelIdentityConflict(error)) {
        const replay = await this.findInterruptionReplay(command);
        if (replay) return this.interruptSubtree(command);
        // Descendants are durable monotonic facts. Re-read the exact tree and retry its authority
        // CAS instead of imposing a correctness cap on concurrent lineage growth.
        return this.interruptSubtreeAttempt(command, { treeIdentity, error });
      }
      throw error;
    }
    let waitsSettled = 0;
    for (const lineage of targetLineages) {
      const settled = await this.settleCancelledExecutionWaits({
        childExecutionId: requirePhaseFId(lineage.id, 'ChildExecution.id'),
        reason: command.reason,
        sourceIdentity: `interrupt-subtree:${interruptionRequestId}`
      });
      waitsSettled += Number(settled.foregroundSettled) + settled.continuationSettlements;
    }
    return {
      rootChildExecutionId: command.childExecutionId,
      lineageIds: targetLineages.map((entry) => entry.id as string),
      activeTurnIds: targetActiveTurns.filter((turn) => turn.status === ACTIVE_TURN).map((turn) => turn.id as string),
      cancelledIntentIds: targetPendingIntentLinks.map((link) => link.turn_intent_id as string),
      terminationRequestsWritten: newTerminationTurns.length,
      intentsCancelled: targetPendingIntentLinks.length,
      waitsSettled,
      terminalizedLineageIds: shouldTerminalize
        ? targetLineages.map((entry) => requirePhaseFId(entry.id, 'ChildExecution.id'))
        : [],
      deduplicated: false,
      commitSeq: commit.commitSeq
    };
  }

  private interruptionTreeIdentity(
    tree: Awaited<ReturnType<ChildExecutionControlPlane['readStableTreeSnapshot']>>
  ): string {
    const facts = [
      ...tree.lineages.map((row) => [
        'child', row.id, row.status
      ].map(String).join('\0')),
      ...tree.parentLinks.map((row) => [
        'parent', row.id, row.child_execution_id, row.parent_child_execution_id,
        row.parent_turn_id, row.source_tool_call_id
      ].map(String).join('\0')),
      ...tree.activeLinks.map((row) => [
        'active-link', row.id, row.child_execution_id, row.turn_id
      ].map(String).join('\0')),
      ...tree.activeTurns.map((row) => [
        'active-turn', row.id, row.status
      ].map(String).join('\0')),
      ...tree.intentLinks.map((row) => [
        'intent', row.id, row.child_execution_id, row.turn_intent_id, row.state
      ].map(String).join('\0')),
      ...tree.pendingInputs.map((row) => [
        'input', row.id, row.turn_id, row.input_kind, row.state
      ].map(String).join('\0')),
      ...tree.answerBridges.map((row) => [
        'bridge', row.id, row.child_execution_id, row.status, row.current_submission_id
      ].map(String).join('\0'))
    ].sort();
    return stablePhaseFId('child_interruption_tree_snapshot', ...facts);
  }

  /** Clears only the mutable active pointer after the Turn has durably terminated. */
  public async observeTurnTerminal(childExecutionIdInput: string, turnIdInput: string): Promise<boolean> {
    const childExecutionId = requirePhaseFId(childExecutionIdInput, 'childExecutionId');
    const turnId = requirePhaseFId(turnIdInput, 'turnId');
    const snapshot = await this.readExecutionSnapshot(childExecutionId);
    if (!snapshot.activeTurnLink || snapshot.activeTurnLink.turn_id !== turnId) return false;
    if (!snapshot.activeTurn || snapshot.activeTurn.status !== TERMINATED_TURN) {
      throw new Error('ActiveTurnLink can only be cleared after its exact Turn is terminal.');
    }
    const now = this.timestamp();
    await this.database.transaction([
      DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: TERMINATED_TURN }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assert(snapshot.activeTurnLink.id as string, {
        child_execution_id: childExecutionId,
        turn_id: turnId
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').delete(snapshot.activeTurnLink.id as string),
      DOMAIN_REPOSITORIES.domain('ChildExecution').update(childExecutionId, {
        status: interruptedStatusAfterTurnTerminal(
          requireChildExecutionStatus(snapshot.childExecution.status)
        ),
        updated_at: now
      })
    ]);
    return true;
  }

  /** Identity-scoped read; no answer/delivery state is consumed. */
  public async readExecutionSnapshot(childExecutionIdInput: string): Promise<ChildExecutionSnapshot> {
    const childExecutionId = requirePhaseFId(childExecutionIdInput, 'childExecutionId');
    const barrier = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ChildExecution').get(childExecutionId),
      DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').list({
        where: { child_execution_id: childExecutionId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').list({
        where: { child_execution_id: childExecutionId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('AnswerBridge').list({
        where: { child_execution_id: childExecutionId },
        limit: 2
      })
    ]);
    const childExecution = requireRow(barrier.snapshot[0], `ChildExecution ${childExecutionId}`);
    const parentLinks = requireRows(barrier.snapshot[1], 'ChildExecutionParentLink snapshot');
    const activeLinks = requireRows(barrier.snapshot[2], 'ChildExecutionActiveTurnLink snapshot');
    const bridges = requireRows(barrier.snapshot[3], 'AnswerBridge snapshot');
    if (parentLinks.length !== 1) throw new Error('ChildExecution must have exactly one stable ParentLink.');
    if (activeLinks.length > 1) throw new Error('ChildExecution has multiple ActiveTurnLinks.');
    if (bridges.length !== 1) throw new Error('ChildExecution must have exactly one AnswerBridge.');
    const activeTurnLink = activeLinks[0] ?? null;
    const bridge = bridges[0];
    const turnLinks = (await listAllDomainRows(this.database, 'ChildExecutionTurnLink', {
      child_execution_id: childExecutionId
    })).sort((left, right) => compareBigInt(left.turn_seq, right.turn_seq));
    const targetReads = [
      ...(activeTurnLink
        ? [DOMAIN_REPOSITORIES.domain('Turn').get(
            requirePhaseFId(activeTurnLink.turn_id, 'ChildExecutionActiveTurnLink.turn_id')
          )]
        : []),
      ...(bridge.current_submission_id === null
        ? []
        : [DOMAIN_REPOSITORIES.domain('AnswerSubmission').get(
            requirePhaseFId(bridge.current_submission_id, 'AnswerBridge.current_submission_id')
          )])
    ];
    const targets = targetReads.length > 0
      ? (await this.database.snapshot(targetReads)).snapshot
      : [];
    let targetIndex = 0;
    const activeTurn = activeTurnLink
      ? requireRow(targets[targetIndex++], `Turn ${String(activeTurnLink.turn_id)}`)
      : null;
    if (activeTurnLink && !activeTurn) throw new Error('ChildExecution ActiveTurnLink target is missing.');
    const currentSubmission = bridge.current_submission_id === null
      ? null
      : requireRow(targets[targetIndex], `AnswerSubmission ${String(bridge.current_submission_id)}`);
    return {
      childExecution,
      parentLink: parentLinks[0],
      turnLinks,
      activeTurnLink,
      activeTurn,
      answerBridge: bridge,
      currentSubmission
    };
  }

  /** Reads a bounded child page and bulk-resolves every uncapped relation/target identity. */
  public async list(limit = 200): Promise<ChildExecutionSnapshot[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 200) {
      throw new RangeError('ChildExecution list limit must be from 1 to 200.');
    }
    const barrier = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ChildExecution').list({
        orderBy: { column: 'created_at', direction: 'desc' },
        limit
      })
    ]);
    const children = requireRows(barrier.snapshot[0], 'ChildExecution list snapshot');
    if (children.length === 0) return [];
    const childIds = new Set(children.map((child) =>
      requirePhaseFId(child.id, 'ChildExecution.id')
    ));
    const [allParents, allMemberships, allActiveLinks, allBridges] = await Promise.all([
      listAllDomainRows(this.database, 'ChildExecutionParentLink'),
      listAllDomainRows(this.database, 'ChildExecutionTurnLink'),
      listAllDomainRows(this.database, 'ChildExecutionActiveTurnLink'),
      listAllDomainRows(this.database, 'AnswerBridge')
    ]);
    const parents = allParents.filter((row) => childIds.has(String(row.child_execution_id)));
    const memberships = allMemberships.filter((row) => childIds.has(String(row.child_execution_id)));
    const activeLinks = allActiveLinks.filter((row) => childIds.has(String(row.child_execution_id)));
    const bridges = allBridges.filter((row) => childIds.has(String(row.child_execution_id)));
    const activeTurnIds = [...new Set(activeLinks.map((row) =>
      requirePhaseFId(row.turn_id, 'ChildExecutionActiveTurnLink.turn_id')
    ))];
    const currentSubmissionIds = [...new Set(bridges
      .filter((row) => row.current_submission_id !== null)
      .map((row) => requirePhaseFId(
        row.current_submission_id,
        'AnswerBridge.current_submission_id'
      )))];
    const targetSnapshot = activeTurnIds.length + currentSubmissionIds.length === 0
      ? []
      : (await this.database.snapshot([
          ...activeTurnIds.map((id) => DOMAIN_REPOSITORIES.domain('Turn').get(id)),
          ...currentSubmissionIds.map((id) =>
            DOMAIN_REPOSITORIES.domain('AnswerSubmission').get(id)
          )
        ])).snapshot;
    const turnsById = new Map(activeTurnIds.map((id, index) => [
      id,
      requireRow(targetSnapshot[index], `Turn ${id}`)
    ]));
    const submissionsById = new Map(currentSubmissionIds.map((id, index) => [
      id,
      requireRow(targetSnapshot[activeTurnIds.length + index], `AnswerSubmission ${id}`)
    ]));
    return children.map((child) => {
      const childId = requirePhaseFId(child.id, 'ChildExecution.id');
      const parentRows = parents.filter((row) => row.child_execution_id === childId);
      const activeRows = activeLinks.filter((row) => row.child_execution_id === childId);
      const bridgeRows = bridges.filter((row) => row.child_execution_id === childId);
      if (parentRows.length !== 1 || activeRows.length > 1 || bridgeRows.length !== 1) {
        throw new Error(`ChildExecution ${childId} link cardinality is invalid.`);
      }
      const activeTurnLink = activeRows[0] ?? null;
      const answerBridge = bridgeRows[0];
      return {
        childExecution: child,
        parentLink: parentRows[0],
        turnLinks: memberships
          .filter((row) => row.child_execution_id === childId)
          .sort((left, right) => compareBigInt(left.turn_seq, right.turn_seq)),
        activeTurnLink,
        activeTurn: activeTurnLink
          ? turnsById.get(requirePhaseFId(
              activeTurnLink.turn_id,
              'ChildExecutionActiveTurnLink.turn_id'
            )) ?? null
          : null,
        answerBridge,
        currentSubmission: answerBridge.current_submission_id === null
          ? null
          : submissionsById.get(requirePhaseFId(
              answerBridge.current_submission_id,
              'AnswerBridge.current_submission_id'
            )) ?? null
      };
    });
  }

  /** Local timeout has no durable side effect; each observed state is from one SQLite snapshot. */
  public async wait(childExecutionId: string, timeoutMs = 0): Promise<ChildExecutionSnapshot> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
      throw new RangeError('ChildExecution wait timeout must be from 0 to 60000ms.');
    }
    const first = await this.readExecutionSnapshot(childExecutionId);
    if (timeoutMs === 0 || executionWaitComplete(first)) return first;
    return new Promise<ChildExecutionSnapshot>((resolve, reject) => {
      let settled = false;
      let reading = false;
      const finish = (value: ChildExecutionSnapshot) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(value);
      };
      const unsubscribe = this.database.onCommit(() => {
        if (settled || reading) return;
        reading = true;
        void this.readExecutionSnapshot(childExecutionId).then((snapshot) => {
          reading = false;
          if (executionWaitComplete(snapshot)) finish(snapshot);
        }, (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unsubscribe();
          reject(error);
        });
      });
      const timer = setTimeout(() => finish(first), timeoutMs);
    });
  }

  /** Settles every still-waiting continuation invocation bound to this stable AnswerBridge. */
  public async settleContinuationWaits(input: {
    answerBridgeId: string;
    detail: unknown;
    sourceIdentity: string;
    observedAt?: string;
    sourceTurnId?: string;
    toolCallId?: string;
    status?: ToolOutcomeStatus;
  }): Promise<ChildWaitSettlement[]> {
    const answerBridgeId = requirePhaseFId(input.answerBridgeId, 'answerBridgeId');
    const sourceIdentity = requirePhaseFText(input.sourceIdentity, 'sourceIdentity');
    const observedAt = requireIsoTimestamp(input.observedAt ?? this.timestamp(), 'observedAt');
    const bridge = await this.requireExisting('AnswerBridge', answerBridgeId);
    const sourceTurnId = input.sourceTurnId === undefined
      ? undefined
      : requirePhaseFId(input.sourceTurnId, 'sourceTurnId');
    const toolCallId = input.toolCallId === undefined
      ? undefined
      : requirePhaseFId(input.toolCallId, 'toolCallId');
    const operations = await this.readContinuationWaitOperations({
      bridge,
      status: 'waiting_answer',
      ...(sourceTurnId ? { sourceTurnId } : {}),
      ...(toolCallId ? { toolCallId } : {})
    });
    const terminals: ChildWaitSettlement[] = [];
    for (const operation of operations) {
      const toolCallId = requirePhaseFId(operation.tool_call_id, 'Operation.tool_call_id');
      const executions = await this.listRows('ToolExecution', { tool_call_id: toolCallId }, 2);
      if (executions.length !== 1) throw new Error('Continuation wait requires exactly one ToolExecution.');
      const deadline = requireIsoTimestamp(executions[0].wait_deadline_at, 'ToolExecution.wait_deadline_at');
      const detail = Date.parse(observedAt) <= Date.parse(deadline)
        ? input.detail
        : childControlHandle(
            await this.requireExisting('ChildExecution', requirePhaseFId(bridge.child_execution_id, 'AnswerBridge.child_execution_id')),
            bridge
          );
      const terminal = await this.settleContinuationOperation({
        operation,
        execution: executions[0],
        detail,
        status: input.status ?? 'succeeded',
        sourceIdentity: `${sourceIdentity}:${Date.parse(observedAt) <= Date.parse(deadline) ? 'answer' : 'timeout'}`
      });
      if (terminal) terminals.push(terminal);
    }
    return terminals;
  }

  /** Read-only generation-resolved continuation waits used by answer/recovery orchestration. */
  public async listContinuationWaitOperations(input: {
    answerBridgeId: string;
    status?: string;
    sourceTurnId?: string;
    toolCallId?: string;
  }): Promise<DomainRow[]> {
    const answerBridgeId = requirePhaseFId(input.answerBridgeId, 'answerBridgeId');
    const bridge = await this.requireExisting('AnswerBridge', answerBridgeId);
    return this.readContinuationWaitOperations({
      bridge,
      ...(input.status === undefined ? {} : { status: requirePhaseFText(input.status, 'status') }),
      ...(input.sourceTurnId === undefined
        ? {}
        : { sourceTurnId: requirePhaseFId(input.sourceTurnId, 'sourceTurnId') }),
      ...(input.toolCallId === undefined
        ? {}
        : { toolCallId: requirePhaseFId(input.toolCallId, 'toolCallId') })
    });
  }

  /**
   * A continuation wait is owned by the stable Turn id that its TurnIntent will admit. This is the
   * durable generation fence: a submission from one child Turn cannot observe or settle a wait for
   * an older/newer generation, even when both transactions share the same millisecond timestamp.
   */
  private async readContinuationWaitOperations(input: {
    bridge: DomainRow;
    status?: string;
    sourceTurnId?: string;
    toolCallId?: string;
  }): Promise<DomainRow[]> {
    const childExecutionId = requirePhaseFId(
      input.bridge.child_execution_id,
      'AnswerBridge.child_execution_id'
    );
    const intentLinks = await listAllDomainRows(this.database, 'ChildExecutionIntentLink', {
      child_execution_id: childExecutionId
    });
    const targetTurnIds = new Set(intentLinks.map((link) => childContinuationTurnId(
      childExecutionId,
      requirePhaseFId(link.turn_intent_id, 'ChildExecutionIntentLink.turn_intent_id')
    )));
    if (input.sourceTurnId) {
      const memberships = await this.listRows('ChildExecutionTurnLink', {
        turn_id: input.sourceTurnId
      }, 2);
      if (memberships.length !== 1 || memberships[0].child_execution_id !== childExecutionId) {
        throw new Error('Continuation answer source Turn is not a member of its AnswerBridge ChildExecution.');
      }
    }
    const legacy = await listAllDomainRows(this.database, 'Operation', {
      owner_kind: LEGACY_ANSWER_BRIDGE_WAIT_OWNER_KIND,
      owner_id: requirePhaseFId(input.bridge.id, 'AnswerBridge.id'),
      ...(input.status ? { status: input.status } : {}),
      ...(input.toolCallId ? { tool_call_id: input.toolCallId } : {})
    });
    const resolvedLegacy = await this.resolveLegacyContinuationWaitOperations({
      childExecutionId,
      operations: legacy,
      intentLinks,
      ...(input.sourceTurnId ? { sourceTurnId: input.sourceTurnId } : {})
    });

    let current: DomainRow[];
    if (input.sourceTurnId) {
      current = targetTurnIds.has(input.sourceTurnId)
        ? await listAllDomainRows(this.database, 'Operation', {
            owner_kind: CHILD_TURN_ANSWER_WAIT_OWNER_KIND,
            owner_id: input.sourceTurnId,
            ...(input.status ? { status: input.status } : {}),
            ...(input.toolCallId ? { tool_call_id: input.toolCallId } : {})
          })
        : [];
    } else if (input.toolCallId) {
      const rows = await listAllDomainRows(this.database, 'Operation', {
        tool_call_id: input.toolCallId,
        ...(input.status ? { status: input.status } : {})
      });
      current = rows.filter((operation) =>
        operation.owner_kind === CHILD_TURN_ANSWER_WAIT_OWNER_KIND
        && targetTurnIds.has(requirePhaseFId(operation.owner_id, 'Operation.owner_id'))
      );
    } else {
      current = (await listAllDomainRows(this.database, 'Operation', {
        owner_kind: CHILD_TURN_ANSWER_WAIT_OWNER_KIND,
        ...(input.status ? { status: input.status } : {})
      })).filter((operation) => targetTurnIds.has(
        requirePhaseFId(operation.owner_id, 'Operation.owner_id')
      ));
    }
    return [...current, ...resolvedLegacy].sort((left, right) =>
      compareBigInt(left.operation_seq, right.operation_seq)
      || String(left.id).localeCompare(String(right.id))
    );
  }

  /**
   * Resolves only the one legacy owner shape shipped before Turn-generation ownership. The legacy
   * operation is accepted solely when its stable ids, parent ToolCall/CommandReceipt, TurnIntent,
   * immutable mode preset and ChildExecutionIntentLink reconstruct one child-send command.
   * Timestamps and sequence proximity never participate in the mapping.
   */
  private async resolveLegacyContinuationWaitOperations(input: {
    childExecutionId: string;
    operations: DomainRow[];
    intentLinks: DomainRow[];
    sourceTurnId?: string;
  }): Promise<DomainRow[]> {
    if (input.operations.length === 0) return [];
    const child = await this.requireExisting('ChildExecution', input.childExecutionId);
    const intentLinksById = new Map(input.intentLinks.map((link) => [String(link.id), link]));
    const toolCallIds = [...new Set(input.operations.map((operation) =>
      requirePhaseFId(operation.tool_call_id, 'Operation.tool_call_id')
    ))];
    const toolCallSnapshot = await this.database.snapshot(toolCallIds.map((toolCallId) =>
      DOMAIN_REPOSITORIES.domain('ToolCall').get(toolCallId)
    ));
    const toolCallsById = new Map(toolCallIds.map((toolCallId, index) => [
      toolCallId,
      requireRow(toolCallSnapshot.snapshot[index], `ToolCall ${toolCallId}`)
    ]));
    const parentTurnIds = [...new Set([...toolCallsById.values()].map((toolCall) =>
      requirePhaseFId(toolCall.turn_id, 'ToolCall.turn_id')
    ))];
    const receiptGroups = await Promise.all(parentTurnIds.map((parentTurnId) =>
      listAllDomainRows(this.database, 'CommandReceipt', {
        source_kind: 'command',
        turn_id: parentTurnId
      })
    ));
    const receiptsByTurn = new Map(parentTurnIds.map((parentTurnId, index) => [
      parentTurnId,
      receiptGroups[index]
    ]));
    const matches: Array<{
      operation: DomainRow;
      ids: ReturnType<typeof sendIdentityIds>;
      mode: ChildSendMode;
      targetTurnId: string;
      intentLink: DomainRow;
    }> = [];
    for (const operation of input.operations) {
      const operationId = requirePhaseFId(operation.id, 'Operation.id');
      const toolCallId = requirePhaseFId(operation.tool_call_id, 'Operation.tool_call_id');
      const toolCall = toolCallsById.get(toolCallId)!;
      const parentTurnId = requirePhaseFId(toolCall.turn_id, 'ToolCall.turn_id');
      const operationMatches: typeof matches = [];
      for (const receipt of receiptsByTurn.get(parentTurnId) ?? []) {
        const sourceKey = requirePhaseFText(receipt.source_key, 'CommandReceipt.source_key');
        for (const mode of ['queue_next_turn', 'interrupt_current_turn'] as const) {
          const ids = sendIdentityIds(input.childExecutionId, sourceKey, toolCallId, mode);
          if (ids.operationId !== operationId || ids.commandReceiptId !== receipt.id) continue;
          const intentLink = intentLinksById.get(ids.intentLinkId);
          if (
            !intentLink
            || intentLink.child_execution_id !== input.childExecutionId
            || intentLink.turn_intent_id !== ids.turnIntentId
          ) continue;
          operationMatches.push({
            operation,
            ids,
            mode,
            targetTurnId: childContinuationTurnId(input.childExecutionId, ids.turnIntentId),
            intentLink
          });
        }
      }
      if (operationMatches.length !== 1) {
        throw new Error(`Legacy continuation wait ${operationId} has no unique durable child-send identity.`);
      }
      if (!input.sourceTurnId || operationMatches[0].targetTurnId === input.sourceTurnId) {
        matches.push(operationMatches[0]);
      }
    }
    if (matches.length === 0) return [];
    const factSnapshot = await this.database.snapshot(matches.flatMap((match) => [
      DOMAIN_REPOSITORIES.domain('TurnIntent').get(match.ids.turnIntentId),
      DOMAIN_REPOSITORIES.domain('TurnIntentRevision').get(match.ids.turnIntentRevisionId),
      DOMAIN_REPOSITORIES.domain('TurnExecutionPresetRevision').get(match.ids.presetRevisionId)
    ]));
    const resolved: DomainRow[] = [];
    for (const [index, match] of matches.entries()) {
      const intent = requireRow(
        factSnapshot.snapshot[index * 3],
        `TurnIntent ${match.ids.turnIntentId}`
      );
      const revision = requireRow(
        factSnapshot.snapshot[index * 3 + 1],
        `TurnIntentRevision ${match.ids.turnIntentRevisionId}`
      );
      const preset = requireRow(
        factSnapshot.snapshot[index * 3 + 2],
        `TurnExecutionPresetRevision ${match.ids.presetRevisionId}`
      );
      const expectedPresetObjectId = this.contentStore.identity(
        canonicalPlainJson({ kind: 'child-continuation', mode: match.mode }),
        TURN_EXECUTION_PRESET_CONTENT_TYPE
      ).id;
      const expectedLinkState = intent.state === 'queued' ? 'pending' : intent.state;
      if (
        intent.conversation_id !== child.child_conversation_id
        || (intent.turn_id !== null && intent.turn_id !== match.targetTurnId)
        || revision.intent_id !== match.ids.turnIntentId
        || revision.revision_seq !== 1n
        || preset.intent_id !== match.ids.turnIntentId
        || preset.revision_seq !== 1n
        || preset.preset_object_id !== expectedPresetObjectId
        || match.intentLink.state !== expectedLinkState
      ) {
        throw new Error(
          `Legacy continuation wait ${String(match.operation.id)} has conflicting durable child-send facts.`
        );
      }
      if (input.sourceTurnId) {
        if (intent.state !== 'admitted' || intent.turn_id !== input.sourceTurnId) {
          throw new Error(
            `Legacy continuation wait ${String(match.operation.id)} is not admitted by its source Turn.`
          );
        }
      }
      resolved.push(match.operation);
    }
    return resolved;
  }

  /**
   * Closes every parent-side wait after a durable subtree interruption was committed.
   *
   * Wait settlement is intentionally idempotent and may run both immediately after the cancel
   * transaction and from Phase F startup recovery. This closes the crash window where the lineage
   * reached terminal/interrupted state but the Extension Host died before the initial run_agent or
   * a continuation wait received its cancelled ToolOutcome.
   */
  public async settleCancelledExecutionWaits(input: {
    childExecutionId: string;
    reason: string;
    sourceIdentity: string;
  }): Promise<{ foregroundSettled: boolean; continuationSettlements: number }> {
    const childExecutionId = requirePhaseFId(input.childExecutionId, 'childExecutionId');
    const reason = requirePhaseFText(input.reason, 'reason');
    const sourceIdentity = requirePhaseFText(input.sourceIdentity, 'sourceIdentity');
    const snapshot = await this.readExecutionSnapshot(childExecutionId);
    const childStatus = requireChildExecutionStatus(snapshot.childExecution.status);
    const cancellationCommitted = childStatus === 'interrupting' || childStatus === 'interrupted';
    if (!cancellationCommitted) {
      return { foregroundSettled: false, continuationSettlements: 0 };
    }
    const sourceToolCallId = requirePhaseFId(
      snapshot.parentLink.source_tool_call_id,
      'ChildExecutionParentLink.source_tool_call_id'
    );
    const waitOperations = [
      ...await listAllDomainRows(this.database, 'Operation', {
        owner_kind: 'child_execution',
        owner_id: childExecutionId
      }),
      ...await this.readContinuationWaitOperations({ bridge: snapshot.answerBridge })
    ];
    const unmaterialized = new Set<string>();
    for (const operation of waitOperations) {
      if (operation.tool_call_id === null) continue;
      const toolCallId = requirePhaseFId(operation.tool_call_id, 'Operation.tool_call_id');
      if (!await this.effects.readTerminalResult(toolCallId, true)) unmaterialized.add(toolCallId);
    }
    const foregroundOperations = await this.listRows('Operation', {
      owner_kind: 'child_execution',
      owner_id: childExecutionId,
      status: 'waiting_answer'
    }, 2);
    const foregroundWasWaiting = foregroundOperations.length > 0;
    const foregroundSettled = await this.cancelForegroundWaitForToolCall({
      toolCallId: sourceToolCallId,
      reason,
      sourceIdentity: `${sourceIdentity}:foreground`,
      childContinuesInBackground: false,
      cancelledSubtree: true
    });
    const continuation = await this.settleContinuationWaits({
      answerBridgeId: requirePhaseFId(snapshot.answerBridge.id, 'AnswerBridge.id'),
      detail: {
        interrupted: true,
        cancelledSubtree: true,
        childExecutionId,
        reason
      },
      status: 'cancelled',
      sourceIdentity: `${sourceIdentity}:continuation`,
      observedAt: this.timestamp()
    });
    const continuationSettledIds = new Set(continuation.map((entry) => entry.toolCallId));
    for (const operation of waitOperations) {
      if (!TERMINAL_OPERATION_STATES.has(String(operation.status)) || operation.tool_call_id === null) continue;
      const toolCallId = requirePhaseFId(operation.tool_call_id, 'Operation.tool_call_id');
      if (!unmaterialized.has(toolCallId) || toolCallId === sourceToolCallId) continue;
      if ((await this.finalizeWaitSettlement(toolCallId))?.terminal) continuationSettledIds.add(toolCallId);
    }
    const foregroundMaterialized = unmaterialized.has(sourceToolCallId)
      && (await this.effects.readTerminalResult(sourceToolCallId, true)) !== null;
    return {
      foregroundSettled: (foregroundWasWaiting && foregroundSettled) || foregroundMaterialized,
      continuationSettlements: continuationSettledIds.size
    };
  }

  /**
   * Cancels only one parent-side foreground wait. The ChildExecution and its active Turn remain
   * untouched so non-cascade parent interruption converts the child to background execution.
   */
  public async cancelForegroundWaitForToolCall(input: {
    toolCallId: string;
    reason: string;
    sourceIdentity: string;
    childContinuesInBackground?: boolean;
    cancelledSubtree?: boolean;
  }): Promise<boolean> {
    const toolCallId = requirePhaseFId(input.toolCallId, 'toolCallId');
    const sourceIdentity = requirePhaseFText(input.sourceIdentity, 'sourceIdentity');
    const operations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: toolCallId });
    const waitingOperations = operations.filter((operation) => operation.status === 'waiting_answer');
    if (waitingOperations.length === 0) return (await this.finalizeWaitSettlement(toolCallId)) !== null;
    if (waitingOperations.length !== 1) {
      throw new Error(`Foreground child wait ${toolCallId} has multiple waiting Operations.`);
    }
    const waiting = waitingOperations[0];
    const executions = await this.listRows('ToolExecution', { tool_call_id: toolCallId }, 2);
    if (executions.length !== 1 || executions[0].status !== 'waiting_answer') {
      throw new Error(`Foreground child wait ${toolCallId} has incomplete ToolExecution facts.`);
    }
    const detail = {
      interrupted: true,
      parentWaitCancelled: true,
      childContinuesInBackground: input.childContinuesInBackground ?? true,
      ...(input.cancelledSubtree ? { cancelledSubtree: true } : {}),
      reason: requirePhaseFText(input.reason, 'reason')
    };
    if (waiting.owner_kind === CHILD_TURN_ANSWER_WAIT_OWNER_KIND) {
      return (await this.settleContinuationOperation({
        operation: waiting,
        execution: executions[0],
        detail,
        status: 'cancelled',
        sourceIdentity
      })) !== null;
    }
    if (waiting.owner_kind === LEGACY_ANSWER_BRIDGE_WAIT_OWNER_KIND) {
      const bridge = await this.requireExisting(
        'AnswerBridge',
        requirePhaseFId(waiting.owner_id, 'Operation.owner_id')
      );
      const resolved = await this.readContinuationWaitOperations({
        bridge,
        status: 'waiting_answer',
        toolCallId
      });
      if (!resolved.some((operation) => operation.id === waiting.id)) {
        throw new Error(`Legacy continuation wait ${String(waiting.id)} has no exact child-send identity.`);
      }
      return (await this.settleContinuationOperation({
        operation: waiting,
        execution: executions[0],
        detail,
        status: 'cancelled',
        sourceIdentity
      })) !== null;
    }
    if (waiting.owner_kind !== 'child_execution') {
      throw new Error(`Unsupported foreground child wait owner ${String(waiting.owner_kind)}.`);
    }
    const settlement = await this.prepareForegroundSettlement({
      childExecutionId: requirePhaseFId(waiting.owner_id, 'Operation.owner_id'),
      status: 'cancelled',
      detail,
      sourceIdentity
    });
    if (!settlement) return (await this.finalizeWaitSettlement(toolCallId)) !== null;
    const toolCall = await this.requireExisting('ToolCall', toolCallId);
    const turn = await this.requireExisting('Turn', requirePhaseFId(toolCall.turn_id, 'ToolCall.turn_id'));
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
          id: settlement.receiptId,
          source_kind: 'internal',
          source_key: `foreground-cancel:${sourceIdentity}:${toolCallId}`,
          conversation_id: turn.conversation_id,
          turn_id: turn.id,
          created_at: this.timestamp()
        }),
        ...settlement.steps
      ]);
      await this.finalizeWaitSettlement(toolCallId);
      return true;
    } catch (error) {
      if (!isExpectedSettlementRace(error)) throw error;
      return (await this.finalizeWaitSettlement(toolCallId)) !== null;
    }
  }

  /**
   * Prepares the first-wins durable wait result. Ordered ToolOutcome/ToolModelResult materialization
   * is deliberately left to finalizeReadyInOrder after this transaction commits.
   */
  public async prepareForegroundSettlement(input: {
    childExecutionId: string;
    status: ToolOutcomeStatus;
    detail: unknown;
    sourceIdentity: string;
  }): Promise<PreparedForegroundSettlement | null> {
    const childExecutionId = requirePhaseFId(input.childExecutionId, 'childExecutionId');
    const sourceIdentity = requirePhaseFText(input.sourceIdentity, 'sourceIdentity');
    const parentLinks = await this.listRows('ChildExecutionParentLink', { child_execution_id: childExecutionId }, 2);
    if (parentLinks.length !== 1) throw new Error('ChildExecution foreground settlement requires one ParentLink.');
    const toolCallId = requirePhaseFId(parentLinks[0].source_tool_call_id, 'ParentLink.source_tool_call_id');
    const executions = await this.listRows('ToolExecution', { tool_call_id: toolCallId }, 2);
    const operations = await this.listRows('Operation', {
      owner_kind: 'child_execution',
      owner_id: childExecutionId
    }, 2);
    if (executions.length !== 1 || operations.length !== 1) {
      throw new Error('ChildExecution foreground settlement facts are incomplete.');
    }
    if (executions[0].status !== 'waiting_answer' || operations[0].status !== 'waiting_answer') return null;
    const waitDeadlineAt = requireIsoTimestamp(executions[0].wait_deadline_at, 'ToolExecution.wait_deadline_at');
    const receiptId = stablePhaseFId('command_receipt', 'foreground-settlement', sourceIdentity, toolCallId);
    const result = await this.prepareWaitResultArtifact(
      toolCallId,
      input.status,
      input.detail
    );
    const now = this.timestamp();
    return {
      toolCallId,
      childExecutionId,
      receiptId,
      waitDeadlineAt,
      status: input.status,
      steps: [
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(executions[0].id as string, {
          status: 'waiting_answer',
          wait_deadline_at: executions[0].wait_deadline_at
        }),
        DOMAIN_REPOSITORIES.domain('Operation').assert(operations[0].id as string, { status: 'waiting_answer' }),
        DOMAIN_REPOSITORIES.domain('Operation').update(operations[0].id as string, {
          status: input.status,
          updated_at: now
        }),
        ...result
      ]
    };
  }

  private async settleContinuationOperation(input: {
    operation: DomainRow;
    execution: DomainRow;
    detail: unknown;
    status: ToolOutcomeStatus;
    sourceIdentity: string;
  }): Promise<ChildWaitSettlement | null> {
    const operationId = requirePhaseFId(input.operation.id, 'Operation.id');
    const toolCallId = requirePhaseFId(input.operation.tool_call_id, 'Operation.tool_call_id');
    const pauses = await this.listRows('OutcomePause', { operation_id: operationId }, 2);
    if (pauses.length !== 1) throw new Error('Continuation wait Operation must have exactly one OutcomePause.');
    const pause = pauses[0];
    const receiptId = stablePhaseFId(
      'command_receipt',
      'continuation-wait-settle',
      input.sourceIdentity,
      toolCallId
    );
    const existingReceipt = await this.findCommandReceipt('internal', `continuation-wait:${input.sourceIdentity}:${toolCallId}`);
    if (existingReceipt) return this.finalizeWaitSettlement(toolCallId);
    const resolution = await this.contentStore.prepare(
      this.database,
      canonicalPlainJson({ kind: 'child-answer-wait-resolution', detail: input.detail }),
      'application/vnd.limcode.child-answer-resolution+json'
    );
    const result = await this.prepareWaitResultArtifact(
      toolCallId,
      input.status,
      input.detail
    );
    const toolCall = await this.requireExisting('ToolCall', toolCallId);
    const turn = await this.requireExisting('Turn', requirePhaseFId(toolCall.turn_id, 'ToolCall.turn_id'));
    const now = this.timestamp();
    const sourceKey = `continuation-wait:${input.sourceIdentity}:${toolCallId}`;
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
          id: receiptId,
          source_kind: 'internal',
          source_key: sourceKey,
          conversation_id: turn.conversation_id,
          turn_id: turn.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Operation').assert(operationId, { status: 'waiting_answer' }),
        DOMAIN_REPOSITORIES.domain('OutcomePause').assert(
          requirePhaseFId(pause.id, 'OutcomePause.id'),
          { status: 'waiting', operation_id: operationId }
        ),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(
          requirePhaseFId(input.execution.id, 'ToolExecution.id'),
          { status: 'waiting_answer', wait_deadline_at: input.execution.wait_deadline_at }
        ),
        ...preparedContentObjectSteps([resolution], 'child_answer_wait_resolution'),
        DOMAIN_REPOSITORIES.domain('OperationResolution').insert({
          id: stablePhaseFId('operation_resolution', 'continuation-wait', pause.id),
          pause_id: pause.id,
          resolution_kind: input.status,
          content_object_id: resolution.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('OutcomePause').update(requirePhaseFId(pause.id, 'OutcomePause.id'), {
          status: 'resolved',
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Operation').update(operationId, {
          status: input.status,
          updated_at: now
        }),
        ...result
      ]);
      return this.finalizeWaitSettlement(toolCallId);
    } catch (error) {
      if (!isExpectedSettlementRace(error)) throw error;
      const settled = await this.finalizeWaitSettlement(toolCallId);
      if (!settled) throw error;
      return settled;
    }
  }

  /** A child drive failure is terminal; settle an active parent wait immediately instead of timing out. */
  public async settleForegroundFailure(
    childExecutionIdInput: string,
    turnIdInput: string,
    reasonInput: string
  ): Promise<boolean> {
    const childExecutionId = requirePhaseFId(childExecutionIdInput, 'childExecutionId');
    const turnId = requirePhaseFId(turnIdInput, 'turnId');
    const reason = requirePhaseFText(reasonInput, 'reason');
    const snapshot = await this.readExecutionSnapshot(childExecutionId);
    const sourceIdentity = `child-drive-failed:${childExecutionId}:${turnId}`;
    const answerSubmissionId = stablePhaseFId(
      'answer_submission',
      'child-drive-failed',
      childExecutionId,
      turnId
    );
    const settlement = await this.prepareForegroundSettlement({
      childExecutionId,
      status: 'failed',
      detail: {
        ...childControlHandle(snapshot.childExecution, snapshot.answerBridge),
        answerSubmissionId,
        failed: true,
        reason
      },
      sourceIdentity
    });
    if (!settlement) return false;
    const toolCall = await this.requireExisting('ToolCall', settlement.toolCallId);
    const parentTurn = await this.requireExisting('Turn', requirePhaseFId(toolCall.turn_id, 'ToolCall.turn_id'));
    const now = this.timestamp();
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
          id: settlement.receiptId,
          source_kind: 'internal',
          source_key: sourceIdentity,
          conversation_id: parentTurn.conversation_id,
          turn_id: parentTurn.id,
          created_at: now
        }),
        ...settlement.steps
      ]);
      await this.finalizeWaitSettlement(settlement.toolCallId);
      return true;
    } catch (error) {
      if (!isExpectedSettlementRace(error)) throw error;
      return (await this.finalizeWaitSettlement(settlement.toolCallId)) !== null;
    }
  }

  /** Expired foreground wait settles with a background control handle and never dispatches spawn. */
  public async settleForegroundTimeout(childExecutionIdInput: string, nowInput = this.timestamp()): Promise<boolean> {
    const childExecutionId = requirePhaseFId(childExecutionIdInput, 'childExecutionId');
    const now = requireIsoTimestamp(nowInput, 'now');
    const snapshot = await this.readExecutionSnapshot(childExecutionId);
    const parentLinks = [snapshot.parentLink];
    const toolCallId = parentLinks[0].source_tool_call_id as string;
    const executions = await this.listRows('ToolExecution', { tool_call_id: toolCallId }, 2);
    if (executions.length !== 1 || executions[0].status !== 'waiting_answer') return false;
    const deadline = executions[0].wait_deadline_at;
    if (typeof deadline !== 'string' || Date.parse(deadline) > Date.parse(now)) return false;
    const settlement = await this.prepareForegroundSettlement({
      childExecutionId,
      status: 'succeeded',
      detail: childControlHandle(snapshot.childExecution, snapshot.answerBridge),
      sourceIdentity: `foreground-timeout:${toolCallId}:${deadline}`
    });
    if (!settlement) return false;
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
          id: settlement.receiptId,
          source_kind: 'recovery',
          source_key: `foreground-timeout:${toolCallId}:${deadline}`,
          conversation_id: (await this.requireExisting('Turn', (await this.requireExisting('ToolCall', toolCallId)).turn_id as string)).conversation_id,
          turn_id: (await this.requireExisting('ToolCall', toolCallId)).turn_id,
          created_at: now
        }),
        ...settlement.steps
      ]);
      await this.finalizeWaitSettlement(toolCallId);
      return true;
    } catch (error) {
      if (!isExpectedSettlementRace(error)) throw error;
      return (await this.finalizeWaitSettlement(toolCallId)) === null ? Promise.reject(error) : false;
    }
  }

  /** Materializes every ready predecessor/result in call_seq order, or exposes the durable wait fact. */
  public async finalizeWaitSettlement(toolCallIdInput: string): Promise<ChildWaitSettlement | null> {
    const toolCallId = requirePhaseFId(toolCallIdInput, 'toolCallId');
    const toolCall = await this.requireExisting('ToolCall', toolCallId);
    await this.effects.finalizeReadyInOrder(requirePhaseFId(toolCall.turn_id, 'ToolCall.turn_id'));
    const terminal = await this.effects.readTerminalResult(toolCallId, true);
    if (terminal) return { toolCallId, status: terminal.status, terminal };
    const operations = await this.listRows('Operation', { tool_call_id: toolCallId }, 2);
    const artifacts = await this.listRows('ToolResultArtifact', {
      tool_call_id: toolCallId,
      role: 'no_effect_result'
    }, 2);
    if (
      operations.length !== 1
      || !TERMINAL_OPERATION_STATES.has(String(operations[0].status))
      || artifacts.length !== 1
    ) return null;
    return {
      toolCallId,
      status: operations[0].status as ToolOutcomeStatus
    };
  }

  private async prepareWaitResultArtifact(
    toolCallId: string,
    status: ToolOutcomeStatus,
    detail: unknown
  ): Promise<RepositoryTransactionStep[]> {
    const content = await this.contentStore.prepare(
      this.database,
      canonicalPlainJson({ toolCallId, status, detail }, 'Child wait result'),
      'application/vnd.limcode.tool-result-artifact+json'
    );
    return [
      ...preparedContentObjectSteps([content], 'child_wait_result'),
      DOMAIN_REPOSITORIES.domain('ToolResultArtifact').insert({
        id: stablePhaseFId('tool_result_artifact', 'child-wait', toolCallId),
        tool_call_id: toolCallId,
        role: 'no_effect_result',
        content_object_id: content.metadata.id,
        created_at: this.timestamp()
      })
    ];
  }

  private async readSpawnParent(sourceToolCallId: string): Promise<{
    toolCall: DomainRow;
    toolExecution: DomainRow;
    turn: DomainRow;
    conversation: DomainRow;
    lease: DomainRow | null;
    termination: DomainRow | null;
    parentChildExecution: DomainRow | null;
    projectLink: DomainRow | null;
  }> {
    const first = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ToolCall').get(sourceToolCallId),
      DOMAIN_REPOSITORIES.domain('ToolExecution').list({ where: { tool_call_id: sourceToolCallId }, limit: 2 })
    ]);
    const toolCall = requireRow(first.snapshot[0], `ToolCall ${sourceToolCallId}`);
    const executions = requireRows(first.snapshot[1], 'ToolExecution spawn lookup');
    if (executions.length !== 1) throw new Error('Source ToolCall must have exactly one ToolExecution.');
    const turnId = requirePhaseFId(toolCall.turn_id, 'ToolCall.turn_id');
    const second = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Turn').get(turnId),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').list({ where: { turn_id: turnId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('TurnTermination').list({ where: { turn_id: turnId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').list({
        where: { turn_id: turnId },
        limit: 2
      })
    ]);
    const turn = requireRow(second.snapshot[0], `Turn ${turnId}`);
    const leases = requireRows(second.snapshot[1], 'ExecutionLease spawn lookup');
    const terminations = requireRows(second.snapshot[2], 'TurnTermination spawn lookup');
    const parentMemberships = requireRows(second.snapshot[3], 'ChildExecutionTurnLink parent lookup');
    if (parentMemberships.length > 1) throw new Error('Parent Turn has multiple ChildExecution memberships.');
    const parentMembership = parentMemberships[0] ?? null;
    const parentChildExecution = parentMembership
      ? await this.requireExisting(
          'ChildExecution',
          requirePhaseFId(parentMembership.child_execution_id, 'ChildExecutionTurnLink.child_execution_id')
        )
      : null;
    const conversation = await this.requireExisting('Conversation', requirePhaseFId(turn.conversation_id, 'Turn.conversation_id'));
    const projectLinks = await this.listRows('ConversationProjectLink', {
      conversation_id: conversation.id,
      role: 'primary'
    }, 2);
    if (projectLinks.length > 1) throw new Error('Parent Conversation has multiple primary project links.');
    return {
      toolCall,
      toolExecution: executions[0],
      turn,
      conversation,
      lease: leases[0] ?? null,
      termination: terminations[0] ?? null,
      parentChildExecution,
      projectLink: projectLinks[0] ?? null
    };
  }

  private async findSpawnReplay(
    command: ReturnType<typeof normalizeSpawnCommand>,
    ids: SpawnIds,
    preparedRequest?: PreparedContentObject
  ): Promise<ChildExecutionSpawnResult | null> {
    const links = await this.listRows('ChildExecutionParentLink', {
      source_tool_call_id: command.sourceToolCallId
    }, 2);
    if (links.length === 0) return null;
    if (links.length !== 1 || links[0].child_execution_id !== ids.childExecutionId) {
      throw new Error('Source ToolCall already owns a different ChildExecution lineage.');
    }
    await this.ensureConversationOrigin(ids.childExecutionId);
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ChildExecution').get(ids.childExecutionId),
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').get(ids.turnLinkId),
      DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').get(ids.activeTurnLinkId),
      DOMAIN_REPOSITORIES.domain('AnswerBridge').get(ids.answerBridgeId),
      DOMAIN_REPOSITORIES.domain('Operation').get(ids.operationId),
      DOMAIN_REPOSITORIES.domain('Attempt').get(ids.attemptId),
      DOMAIN_REPOSITORIES.domain('EffectIntent').get(ids.effectIntentId),
      DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').get(ids.childAuthoritySnapshotId),
      DOMAIN_REPOSITORIES.domain('MessageRevision').get(ids.childMessageRevisionId),
      DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').get(ids.childMessageMembershipId),
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').list({
        where: { conversation_id: ids.childConversationId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('ConversationOriginLink').get(ids.childOriginLinkId)
    ]);
    const child = requireRow(snapshot.snapshot[0], `ChildExecution ${ids.childExecutionId}`);
    const turnLink = requireRow(snapshot.snapshot[1], `ChildExecutionTurnLink ${ids.turnLinkId}`);
    const active = optionalRow(snapshot.snapshot[2], `ChildExecutionActiveTurnLink ${ids.activeTurnLinkId}`);
    const bridge = requireRow(snapshot.snapshot[3], `AnswerBridge ${ids.answerBridgeId}`);
    const operation = requireRow(snapshot.snapshot[4], `Operation ${ids.operationId}`);
    const attempt = requireRow(snapshot.snapshot[5], `Attempt ${ids.attemptId}`);
    const intent = requireRow(snapshot.snapshot[6], `EffectIntent ${ids.effectIntentId}`);
    const authority = requireRow(snapshot.snapshot[7], `AuthoritySnapshot ${ids.childAuthoritySnapshotId}`);
    const promptRevision = requireRow(snapshot.snapshot[8], `MessageRevision ${ids.childMessageRevisionId}`);
    const promptMembership = requireRow(snapshot.snapshot[9], `MessagePartOfConversation ${ids.childMessageMembershipId}`);
    const contextHeads = requireRows(snapshot.snapshot[10], 'Child Conversation Context head replay lookup');
    const origin = requireRow(snapshot.snapshot[11], `ConversationOriginLink ${ids.childOriginLinkId}`);
    const expectedRequestObjectId = preparedRequest?.metadata.id ?? this.contentStore.identity(
      canonicalPlainJson(spawnRequestPayload(command, ids)),
      SUBAGENT_SPAWN_CONTENT_TYPE
    ).id;
    const expectedPromptObjectId = this.contentStore.identity(command.prompt, 'text/plain').id;
    const parentTurn = await this.requireExisting(
      'Turn',
      requirePhaseFId(links[0].parent_turn_id, 'ChildExecutionParentLink.parent_turn_id')
    );
    const [parentProjectLinks, childProjectLinks] = await Promise.all([
      this.listRows('ConversationProjectLink', {
        conversation_id: requirePhaseFId(parentTurn.conversation_id, 'Turn.conversation_id'),
        role: 'primary'
      }, 2),
      this.listRows('ConversationProjectLink', {
        conversation_id: ids.childConversationId,
        role: 'primary'
      }, 2)
    ]);
    if (parentProjectLinks.length > 1 || childProjectLinks.length > 1) {
      throw new Error('ChildExecution spawn replay found non-unique project links.');
    }
    const projectInheritanceMatches = parentProjectLinks.length === 0
      ? childProjectLinks.length === 0
      : childProjectLinks.length === 1
        && childProjectLinks[0].project_context_id === parentProjectLinks[0].project_context_id
      ;
    const childStatus = requireChildExecutionStatus(child.status);
    const activeLinkRequired = childStatus === 'starting'
      || childStatus === 'active'
      || childStatus === 'interrupting';
    if (
      child.child_conversation_id !== ids.childConversationId
      || turnLink.turn_id !== ids.childTurnId
      || (active ? active.turn_id !== ids.childTurnId : activeLinkRequired)
      || bridge.child_execution_id !== ids.childExecutionId
      || operation.owner_kind !== 'child_execution'
      || operation.owner_id !== ids.childExecutionId
      || operation.tool_call_id !== (command.sourceSettlement === 'child_handle' ? command.sourceToolCallId : null)
      || attempt.operation_id !== ids.operationId
      || intent.attempt_id !== ids.attemptId
      || intent.effect_kind !== 'subagent_spawn'
      || intent.request_object_id !== expectedRequestObjectId
      || authority.turn_id !== ids.childTurnId
      || promptRevision.message_id !== ids.childMessageId
      || promptRevision.role !== 'user'
      || promptRevision.content_object_id !== expectedPromptObjectId
      || promptMembership.conversation_id !== ids.childConversationId
      || promptMembership.message_id !== ids.childMessageId
      || contextHeads.length !== 1
      || origin.conversation_id !== ids.childConversationId
      || typeof origin.source_conversation_id !== 'string'
      || origin.source_conversation_id.length === 0
      || origin.source_turn_id !== links[0].parent_turn_id
      || origin.source_tool_call_id !== command.sourceToolCallId
      || origin.source_message_revision_id !== null
      || !projectInheritanceMatches
    ) throw new Error('ChildExecution spawn source was replayed with different facts.');
    const frozen = await readFrozenTurnAuthority(
      this.database,
      this.contentStore,
      ids.childAuthoritySnapshotId,
      ids.childTurnId
    );
    return spawnResult(
      ids,
      command.completionPolicy,
      frozenModelSelection(frozen.document),
      true
    );
  }

  /**
   * Repairs the lineage projection introduced after early Phase F roots were already durable.
   * The ChildExecution parent relation is authoritative; ConversationOriginLink is a stable,
   * idempotent read-model edge used by the sidebar tree and child-Agent status labels.
   */
  public async ensureConversationOrigin(childExecutionIdInput: string): Promise<{
    originLinkId: string;
    created: boolean;
  }> {
    const childExecutionId = requirePhaseFId(childExecutionIdInput, 'childExecutionId');
    const first = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ChildExecution').get(childExecutionId),
      DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').list({
        where: { child_execution_id: childExecutionId },
        limit: 2
      })
    ]);
    const child = requireRow(first.snapshot[0], `ChildExecution ${childExecutionId}`);
    const parentLinks = requireRows(first.snapshot[1], `ChildExecutionParentLink ${childExecutionId}`);
    if (parentLinks.length !== 1) throw new Error(`ChildExecution ${childExecutionId} must have one parent link.`);
    const parentLink = parentLinks[0];
    const parentTurnId = requirePhaseFId(parentLink.parent_turn_id, 'ChildExecutionParentLink.parent_turn_id');
    const sourceToolCallId = requirePhaseFId(parentLink.source_tool_call_id, 'ChildExecutionParentLink.source_tool_call_id');
    const childConversationId = requirePhaseFId(child.child_conversation_id, 'ChildExecution.child_conversation_id');
    const second = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Turn').get(parentTurnId),
      DOMAIN_REPOSITORIES.domain('ConversationOriginLink').list({
        where: { conversation_id: childConversationId },
        limit: 2
      })
    ]);
    const parentTurn = requireRow(second.snapshot[0], `Turn ${parentTurnId}`);
    const sourceConversationId = requirePhaseFId(parentTurn.conversation_id, 'Turn.conversation_id');
    const originLinkId = childConversationOriginLinkId(sourceToolCallId);
    const existing = requireRows(second.snapshot[1], `ConversationOriginLink ${childConversationId}`);
    if (existing.length > 0) {
      assertChildConversationOrigin(existing, {
        originLinkId,
        childConversationId,
        sourceConversationId,
        parentTurnId,
        sourceToolCallId
      });
      return { originLinkId, created: false };
    }
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('ChildExecution').assert(childExecutionId, {
          child_conversation_id: childConversationId
        }),
        DOMAIN_REPOSITORIES.domain('ChildExecutionParentLink').assert(String(parentLink.id), {
          child_execution_id: childExecutionId,
          source_tool_call_id: sourceToolCallId,
          parent_turn_id: parentTurnId
        }),
        DOMAIN_REPOSITORIES.domain('Turn').assert(parentTurnId, {
          conversation_id: sourceConversationId
        }),
        DOMAIN_REPOSITORIES.domain('ConversationOriginLink').insert({
          id: originLinkId,
          conversation_id: childConversationId,
          source_conversation_id: sourceConversationId,
          source_turn_id: parentTurnId,
          source_tool_call_id: sourceToolCallId,
          source_message_revision_id: null,
          created_at: this.timestamp()
        })
      ]);
      return { originLinkId, created: true };
    } catch (error) {
      if (
        !isTransactionAssertionFailure(error)
        && !sqliteUniqueFailureIncludes(error, [
          'conversation_origin_link.id',
          'conversation_origin_link.conversation_id'
        ])
      ) throw error;
      const raced = await this.listRows('ConversationOriginLink', { conversation_id: childConversationId }, 2);
      assertChildConversationOrigin(raced, {
        originLinkId,
        childConversationId,
        sourceConversationId,
        parentTurnId,
        sourceToolCallId
      });
      return { originLinkId, created: false };
    }
  }

  private async readSpawnIntentFacts(effectIntentId: string): Promise<SpawnIntentFacts> {
    const intent = await this.requireExisting('EffectIntent', effectIntentId);
    const attempt = await this.requireExisting(
      'Attempt',
      requirePhaseFId(intent.attempt_id, 'EffectIntent.attempt_id')
    );
    const operation = await this.requireExisting(
      'Operation',
      requirePhaseFId(attempt.operation_id, 'Attempt.operation_id')
    );
    if (operation.owner_kind !== 'child_execution') {
      throw new Error(`subagent_spawn ${effectIntentId} Operation is not owned by ChildExecution.`);
    }
    const childExecution = await this.requireExisting(
      'ChildExecution',
      requirePhaseFId(operation.owner_id, 'Operation.owner_id')
    );
    const childExecutionId = requirePhaseFId(childExecution.id, 'ChildExecution.id');
    const [turnLinks, activeLinks, bridges] = await Promise.all([
      this.listRows('ChildExecutionTurnLink', {
        child_execution_id: childExecutionId,
        turn_seq: '1'
      }, 2),
      this.listRows('ChildExecutionActiveTurnLink', { child_execution_id: childExecutionId }, 2),
      this.listRows('AnswerBridge', { child_execution_id: childExecutionId }, 2)
    ]);
    if (turnLinks.length !== 1 || activeLinks.length > 1 || bridges.length !== 1) {
      throw new Error(`subagent_spawn ${effectIntentId} lineage facts are incomplete.`);
    }
    const childTurn = await this.requireExisting(
      'Turn',
      requirePhaseFId(turnLinks[0].turn_id, 'ChildExecutionTurnLink.turn_id')
    );
    const leases = await this.listRows('ExecutionLease', { turn_id: childTurn.id }, 2);
    if (leases.length > 1) throw new Error(`Child Turn ${String(childTurn.id)} has multiple ExecutionLeases.`);
    return {
      intent,
      attempt,
      operation,
      childExecution,
      childTurnLink: turnLinks[0],
      childTurn,
      childLease: leases[0] ?? null,
      activeLink: activeLinks[0] ?? null,
      bridge: bridges[0]
    };
  }

  private async terminalizeCancelledPreparedSpawn(facts: SpawnIntentFacts): Promise<void> {
    const childExecutionId = requirePhaseFId(facts.childExecution.id, 'ChildExecution.id');
    const childTurnId = requirePhaseFId(facts.childTurn.id, 'Turn.id');
    const now = this.timestamp();
    const terminations = await this.listRows('TurnTermination', { turn_id: childTurnId }, 2);
    if (terminations.length > 1) throw new Error(`Cancelled child Turn ${childTurnId} has multiple terminations.`);
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('EffectIntent').assert(
        requirePhaseFId(facts.intent.id, 'EffectIntent.id'),
        { dispatch_state: 'cancelled_before_dispatch' }
      ),
      DOMAIN_REPOSITORIES.domain('ChildExecution').assert(childExecutionId, {
        status: facts.childExecution.status
      }),
      ...(facts.childTurn.status === ACTIVE_TURN ? [
        DOMAIN_REPOSITORIES.domain('Turn').assert(childTurnId, { status: ACTIVE_TURN }),
        ...(facts.childLease ? [DOMAIN_REPOSITORIES.domain('ExecutionLease').delete(
          requirePhaseFId(facts.childLease.id, 'ExecutionLease.id')
        )] : []),
        ...(terminations.length === 0 ? [DOMAIN_REPOSITORIES.domain('TurnTermination').insert({
          id: stablePhaseFId('turn_termination', 'spawn-cancelled-before-dispatch', childTurnId),
          turn_id: childTurnId,
          terminal_status: 'cancelled',
          reason: 'subagent_spawn was cancelled before local dispatch',
          created_at: now
        })] : []),
        DOMAIN_REPOSITORIES.domain('Turn').update(childTurnId, {
          status: TERMINATED_TURN,
          updated_at: now,
          terminal_at: now
        })
      ] : []),
      ...(facts.activeLink ? [
        DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assert(
          requirePhaseFId(facts.activeLink.id, 'ChildExecutionActiveTurnLink.id'),
          { child_execution_id: childExecutionId, turn_id: childTurnId }
        ),
        DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').delete(
          requirePhaseFId(facts.activeLink.id, 'ChildExecutionActiveTurnLink.id')
        )
      ] : []),
      DOMAIN_REPOSITORIES.domain('ChildExecution').update(childExecutionId, {
        status: 'closed',
        updated_at: now
      }),
      ...(facts.bridge.current_submission_id === null ? [
        DOMAIN_REPOSITORIES.domain('AnswerBridge').update(
          requirePhaseFId(facts.bridge.id, 'AnswerBridge.id'),
          { status: 'interrupted', updated_at: now }
        )
      ] : [])
    ];
    try {
      await this.database.transaction(steps);
    } catch (error) {
      if (!isTransactionAssertionFailure(error)) throw error;
      const latest = await this.requireExisting('ChildExecution', childExecutionId);
      if (latest.status !== 'closed') throw error;
    }
  }

  private async readSpawnReceiptFacts(effectReceiptId: string) {
    const receipt = await this.requireExisting('EffectReceipt', effectReceiptId);
    const attempt = await this.requireExisting('Attempt', requirePhaseFId(receipt.attempt_id, 'EffectReceipt.attempt_id'));
    const operation = await this.requireExisting('Operation', requirePhaseFId(attempt.operation_id, 'Attempt.operation_id'));
    if (operation.owner_kind !== 'child_execution') throw new Error('Spawn Operation is not owned by ChildExecution.');
    const childExecution = await this.requireExisting('ChildExecution', requirePhaseFId(operation.owner_id, 'Operation.owner_id'));
    const intentRows = await this.listRows('EffectIntent', { attempt_id: attempt.id }, 2);
    const toolCall = operation.tool_call_id === null
      ? null
      : await this.requireExisting('ToolCall', requirePhaseFId(operation.tool_call_id, 'Operation.tool_call_id'));
    const toolExecutions = toolCall
      ? await this.listRows('ToolExecution', { tool_call_id: toolCall.id }, 2)
      : [];
    const bridges = await this.listRows('AnswerBridge', { child_execution_id: childExecution.id }, 2);
    const activeLinks = await this.listRows('ChildExecutionActiveTurnLink', { child_execution_id: childExecution.id }, 2);
    if (
      intentRows.length !== 1
      || (toolCall !== null && toolExecutions.length !== 1)
      || bridges.length !== 1
      || activeLinks.length > 1
    ) {
      throw new Error('Spawn receipt lineage facts are incomplete.');
    }
    const childTurn = activeLinks[0]
      ? await this.requireExisting('Turn', requirePhaseFId(activeLinks[0].turn_id, 'ActiveTurnLink.turn_id'))
      : null;
    const childLeaseRows = childTurn
      ? await this.listRows('ExecutionLease', { turn_id: childTurn.id }, 2)
      : [];
    return {
      receipt,
      attempt,
      operation,
      childExecution,
      intent: intentRows[0],
      toolCall,
      toolExecution: toolExecutions[0] ?? null,
      bridge: bridges[0],
      activeLink: activeLinks[0] ?? null,
      childTurn,
      childLease: childLeaseRows[0] ?? null
    };
  }

  private async findSendReplay(
    command: ReturnType<typeof normalizeSendCommand>,
    ids: ReturnType<typeof sendIds>,
    preparedContent?: PreparedContentObject
  ): Promise<ChildExecutionSendResult | null> {
    const receipt = await this.findCommandReceipt('command', command.sourceKey);
    if (!receipt) return null;
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('TurnIntent').get(ids.turnIntentId),
      DOMAIN_REPOSITORIES.domain('TurnIntentRevision').get(ids.turnIntentRevisionId),
      DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').get(ids.intentLinkId),
      DOMAIN_REPOSITORIES.domain('PendingTurnInput').get(ids.pendingTurnInputId),
      DOMAIN_REPOSITORIES.domain('Operation').get(ids.operationId),
      DOMAIN_REPOSITORIES.domain('OutcomePause').get(ids.pauseId),
      DOMAIN_REPOSITORIES.domain('AnswerBridge').list({
        where: { child_execution_id: command.childExecutionId },
        limit: 2
      })
    ]);
    const intent = requireRow(snapshot.snapshot[0], `TurnIntent ${ids.turnIntentId}`);
    const revision = requireRow(snapshot.snapshot[1], `TurnIntentRevision ${ids.turnIntentRevisionId}`);
    const link = requireRow(snapshot.snapshot[2], `ChildExecutionIntentLink ${ids.intentLinkId}`);
    const pendingInput = snapshot.snapshot[3] === null
      ? null
      : requireRow(snapshot.snapshot[3], `PendingTurnInput ${ids.pendingTurnInputId}`);
    const operation = requireRow(snapshot.snapshot[4], `Operation ${ids.operationId}`);
    const pause = snapshot.snapshot[5] === null
      ? null
      : requireRow(snapshot.snapshot[5], `OutcomePause ${ids.pauseId}`);
    const bridges = requireRows(snapshot.snapshot[6], 'AnswerBridge send replay lookup');
    const expectedContentObjectId = preparedContent?.metadata.id
      ?? this.contentStore.identity(command.content, command.contentType).id;
    if (
      receipt.id !== ids.commandReceiptId
      || bridges.length !== 1
      || link.child_execution_id !== command.childExecutionId
      || link.turn_intent_id !== ids.turnIntentId
      || revision.content_object_id !== expectedContentObjectId
      || operation.owner_kind !== CHILD_TURN_ANSWER_WAIT_OWNER_KIND
      || operation.owner_id !== childContinuationTurnId(command.childExecutionId, ids.turnIntentId)
      || operation.tool_call_id !== command.sourceToolCallId
      || (command.completionPolicy === 'wait_for_answer') !== (pause !== null)
      || (pause !== null && pause.operation_id !== ids.operationId)
    ) throw new Error('ChildExecution send source was replayed with different facts.');
    return sendResult(command, ids, pendingInput !== null, true);
  }

  private async findRuntimeDeliveryContinuationReplay(
    command: ReturnType<typeof normalizeRuntimeDeliveryContinuationCommand>,
    ids: ReturnType<typeof runtimeDeliveryContinuationIds>
  ): Promise<ChildRuntimeDeliveryContinuationResult | null> {
    const receipt = await this.findCommandReceipt('internal', ids.sourceKey);
    if (!receipt) return null;
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('TurnIntent').get(ids.turnIntentId),
      DOMAIN_REPOSITORIES.domain('TurnIntentRevision').get(ids.turnIntentRevisionId),
      DOMAIN_REPOSITORIES.domain('TurnExecutionPresetRevision').get(ids.presetRevisionId),
      DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').get(ids.intentLinkId),
      DOMAIN_REPOSITORIES.domain('RuntimeDeliveryIntentLink').get(ids.deliveryIntentLinkId)
    ]);
    const intent = requireRow(snapshot.snapshot[0], `TurnIntent ${ids.turnIntentId}`);
    const revision = requireRow(snapshot.snapshot[1], `TurnIntentRevision ${ids.turnIntentRevisionId}`);
    const preset = requireRow(snapshot.snapshot[2], `TurnExecutionPresetRevision ${ids.presetRevisionId}`);
    const link = requireRow(snapshot.snapshot[3], `ChildExecutionIntentLink ${ids.intentLinkId}`);
    const deliveryIntentLink = requireRow(
      snapshot.snapshot[4],
      `RuntimeDeliveryIntentLink ${ids.deliveryIntentLinkId}`
    );
    const expectedIntent = this.contentStore.identity(
      canonicalPlainJson(runtimeContinuationTurnIntentEnvelope({
        sourceTurnId: command.sourceTurnId
      })),
      RUNTIME_DELIVERY_CONTINUATION_CONTENT_TYPE
    );
    const expectedPreset = this.contentStore.identity(
      canonicalPlainJson({ kind: 'runtime_continuation' }),
      TURN_EXECUTION_PRESET_CONTENT_TYPE
    );
    if (
      receipt.id !== ids.commandReceiptId
      || receipt.turn_id !== command.sourceTurnId
      || intent.conversation_id === null
      || !['queued', 'admitted'].includes(String(intent.state))
      || revision.intent_id !== ids.turnIntentId
      || revision.content_object_id !== expectedIntent.id
      || preset.intent_id !== ids.turnIntentId
      || preset.preset_object_id !== expectedPreset.id
      || link.child_execution_id !== command.childExecutionId
      || link.turn_intent_id !== ids.turnIntentId
      || !['pending', 'admitted'].includes(String(link.state))
      || deliveryIntentLink.delivery_id !== command.deliveryId
      || deliveryIntentLink.turn_intent_id !== ids.turnIntentId
    ) throw new Error('Runtime delivery continuation identity was replayed with different facts.');
    return {
      childExecutionId: command.childExecutionId,
      turnIntentId: ids.turnIntentId,
      intentLinkId: ids.intentLinkId,
      deduplicated: true
    };
  }

  private async findAdmissionReplay(
    command: ReturnType<typeof normalizeAdmissionCommand>,
    ids: ReturnType<typeof admissionIds>
  ): Promise<ChildContinuationAdmissionResult | null> {
    const receipt = await this.findCommandReceipt('internal', command.sourceKey);
    if (!receipt) return null;
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('TurnIntent').get(command.turnIntentId),
      DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').get(ids.turnLinkId),
      DOMAIN_REPOSITORIES.domain('AnswerBridge').list({
        where: { child_execution_id: command.childExecutionId },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').get(ids.authoritySnapshotId),
      DOMAIN_REPOSITORIES.domain('MessageTurnLink').get(ids.messageTurnLinkId),
      DOMAIN_REPOSITORIES.domain('MessageRevision').get(ids.messageRevisionId),
      DOMAIN_REPOSITORIES.domain('TurnIntentRevision').list({
        where: { intent_id: command.turnIntentId, revision_seq: '1' },
        limit: 2
      })
    ]);
    const intent = requireRow(snapshot.snapshot[0], `TurnIntent ${command.turnIntentId}`);
    const turnLink = requireRow(snapshot.snapshot[1], `ChildExecutionTurnLink ${ids.turnLinkId}`);
    const bridges = requireRows(snapshot.snapshot[2], 'AnswerBridge admission replay');
    const authority = requireRow(snapshot.snapshot[3], `AuthoritySnapshot ${ids.authoritySnapshotId}`);
    const intentRevisions = requireRows(snapshot.snapshot[6], 'TurnIntentRevision admission replay');
    if (intentRevisions.length !== 1) throw new Error('Admitted child intent lost its input revision.');
    const intentContent = await this.requireExisting(
      'ContentObject',
      requirePhaseFId(intentRevisions[0].content_object_id, 'TurnIntentRevision.content_object_id')
    );
    const invisibleRuntimeDelivery = intentContent.content_type
      === RUNTIME_DELIVERY_CONTINUATION_CONTENT_TYPE;
    const messageLink = snapshot.snapshot[4] === null
      ? null
      : requireRow(snapshot.snapshot[4], `MessageTurnLink ${ids.messageTurnLinkId}`);
    const messageRevision = snapshot.snapshot[5] === null
      ? null
      : requireRow(snapshot.snapshot[5], `MessageRevision ${ids.messageRevisionId}`);
    const visibleMessageInvalid = !messageLink || !messageRevision
      || messageLink.turn_id !== ids.turnId
      || messageLink.message_id !== ids.messageId
      || messageLink.role !== 'input'
      || messageRevision.message_id !== ids.messageId
      || messageRevision.role !== 'user';
    if (
      intent.turn_id !== ids.turnId
      || intent.state !== 'admitted'
      || turnLink.child_execution_id !== command.childExecutionId
      || turnLink.turn_id !== ids.turnId
      || bridges.length !== 1
      || authority.turn_id !== ids.turnId
      || (invisibleRuntimeDelivery && (messageLink !== null || messageRevision !== null))
      || (!invisibleRuntimeDelivery && visibleMessageInvalid)
    ) throw new Error('Child continuation admission source was replayed with different facts.');
    return {
      childExecutionId: command.childExecutionId,
      turnIntentId: command.turnIntentId,
      turnId: ids.turnId,
      turnSeq: String(turnLink.turn_seq),
      answerBridgeId: bridges[0].id as string,
      deduplicated: true
    };
  }

  private async readStableTreeSnapshot(rootId: string): Promise<{
    root: DomainRow;
    lineages: DomainRow[];
    parentLinks: DomainRow[];
    activeLinks: DomainRow[];
    activeTurns: DomainRow[];
    intentLinks: DomainRow[];
    pendingIntentLinks: DomainRow[];
    answerBridges: DomainRow[];
    pendingInputs: DomainRow[];
    pendingInputIds: Set<string>;
  }> {
    // The relation sets can exceed one repository page. Each fixed-domain scan is complete, and the
    // writer transaction below asserts the exact Parent/Active/Intent sets before changing anything.
    const links = await listAllDomainRows(this.database, 'ChildExecutionParentLink');
    const children = await listAllDomainRows(this.database, 'ChildExecution');
    const active = await listAllDomainRows(this.database, 'ChildExecutionActiveTurnLink');
    const intents = await listAllDomainRows(this.database, 'ChildExecutionIntentLink');
    const bridges = await listAllDomainRows(this.database, 'AnswerBridge');
    const turns = await listAllDomainRows(this.database, 'Turn');
    const pendingInputs = await listAllDomainRows(this.database, 'PendingTurnInput');
    const byId = new Map(children.map((child) => [child.id as string, child]));
    const root = byId.get(rootId);
    if (!root) throw new Error(`ChildExecution ${rootId} does not exist.`);
    const descendants = new Set([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const link of links) {
        const parentId = link.parent_child_execution_id;
        if (typeof parentId !== 'string' || !descendants.has(parentId)) continue;
        const childId = requirePhaseFId(link.child_execution_id, 'ChildExecutionParentLink.child_execution_id');
        if (!descendants.has(childId)) {
          descendants.add(childId);
          changed = true;
        }
      }
    }
    const lineages = [...descendants].map((id) => {
      const child = byId.get(id);
      if (!child) throw new Error(`ChildExecution tree references missing lineage ${id}.`);
      return child;
    });
    const parentLinks = links.filter((link) => descendants.has(link.child_execution_id as string));
    const activeLinks = active.filter((link) => descendants.has(link.child_execution_id as string));
    const intentLinks = intents.filter((link) => descendants.has(link.child_execution_id as string));
    const activeTurnIds = new Set(activeLinks.map((link) => link.turn_id as string));
    const activeTurns = turns.filter((turn) => activeTurnIds.has(turn.id as string));
    if (activeTurns.length !== activeTurnIds.size) throw new Error('ChildExecution tree contains a missing active Turn target.');
    const answerBridges = bridges.filter((bridge) => descendants.has(bridge.child_execution_id as string));
    if (answerBridges.length !== lineages.length || lineages.some((lineage) =>
      answerBridges.filter((bridge) => bridge.child_execution_id === lineage.id).length !== 1
    )) throw new Error('ChildExecution tree must retain exactly one AnswerBridge per lineage.');
    return {
      root,
      lineages,
      parentLinks,
      activeLinks,
      activeTurns,
      intentLinks,
      pendingIntentLinks: intentLinks.filter((link) => link.state === 'pending'),
      answerBridges,
      pendingInputs,
      pendingInputIds: new Set(pendingInputs.map((input) => input.id as string))
    };
  }

  private async findInterruptionReplay(
    command: ReturnType<typeof normalizeCancelCommand>
  ): Promise<InterruptionReplayFacts | null> {
    const sourceKind = command.sourceKey.startsWith('recovery:') ? 'recovery' : 'command';
    const recoveryReplay = isChildInterruptionRecoverySourceKey(command.sourceKey);
    if (recoveryReplay && command.sourceKey !== childInterruptionRecoverySourceKey(command.childExecutionId)) {
      throw new Error('Child interruption recovery source identity does not match its root execution.');
    }
    const requests = await this.listRows('ChildInterruptionRequest', {
      source_kind: sourceKind,
      source_key: command.sourceKey
    }, 2);
    if (requests.length === 0) return null;
    if (requests.length !== 1) throw new Error('Child interruption source identity is not unique.');
    const request = requests[0];
    const requestId = requirePhaseFId(request.id, 'ChildInterruptionRequest.id');
    const expectedRequestId = stablePhaseFId(
      'child_interruption_request',
      sourceKind,
      command.sourceKey
    );
    if (
      requestId !== expectedRequestId
      || request.root_child_execution_id !== command.childExecutionId
      || (!recoveryReplay && request.reason !== command.reason)
    ) throw new Error('Child interruption command was replayed with different facts.');
    const [lineageLinks, turnLinks, intentLinks, receipts] = await Promise.all([
      listAllDomainRows(this.database, 'ChildInterruptionLineageLink', { interruption_request_id: requestId }),
      listAllDomainRows(this.database, 'ChildInterruptionTurnLink', { interruption_request_id: requestId }),
      listAllDomainRows(this.database, 'ChildInterruptionIntentLink', { interruption_request_id: requestId }),
      this.listRows('CommandReceipt', { source_kind: sourceKind, source_key: command.sourceKey }, 2)
    ]);
    if (receipts.length !== 1) throw new Error('Child interruption request lost its CommandReceipt.');
    const lineageIds = lineageLinks
      .map((link) => requirePhaseFId(link.child_execution_id, 'ChildInterruptionLineageLink.child_execution_id'))
      .sort();
    if (!lineageIds.includes(command.childExecutionId)) {
      throw new Error('Child interruption request lost its root lineage target.');
    }
    const intentRows = await Promise.all(intentLinks.map((link) => this.requireExisting(
      'ChildExecutionIntentLink',
      requirePhaseFId(
        link.child_execution_intent_link_id,
        'ChildInterruptionIntentLink.child_execution_intent_link_id'
      )
    )));
    const lineageRows = await Promise.all(lineageIds.map((id) => this.requireExisting('ChildExecution', id)));
    const terminalizedLineageIds = lineageRows.every((row) =>
      requireChildExecutionStatus(row.status) === 'interrupted'
    ) ? lineageIds : [];
    return {
      reason: requirePhaseFText(request.reason, 'ChildInterruptionRequest.reason'),
      result: {
        rootChildExecutionId: command.childExecutionId,
        lineageIds,
        activeTurnIds: turnLinks
          .map((link) => requirePhaseFId(link.turn_id, 'ChildInterruptionTurnLink.turn_id'))
          .sort(),
        cancelledIntentIds: intentRows
          .map((link) => requirePhaseFId(link.turn_intent_id, 'ChildExecutionIntentLink.turn_intent_id'))
          .sort(),
        // These fields report mutations performed by this invocation. A replay exposes the
        // immutable target snapshot above, but must not masquerade as fresh reconciliation work.
        terminationRequestsWritten: 0,
        intentsCancelled: 0,
        waitsSettled: 0,
        terminalizedLineageIds,
        deduplicated: true
      }
    };
  }

  private async findCommandReceipt(sourceKind: string, sourceKey: string): Promise<DomainRow | null> {
    const rows = await this.listRows('CommandReceipt', { source_kind: sourceKind, source_key: sourceKey }, 2);
    if (rows.length > 1) throw new Error('CommandReceipt source identity is not unique.');
    return rows[0] ?? null;
  }

  private async listRows(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const barrier = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    return requireRows(barrier.snapshot[0], `${domain} list`);
  }

  private async maybeGet(domain: string, id: string): Promise<DomainRow | null> {
    const barrier = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return barrier.snapshot[0] as DomainRow | null;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    return requireRow(await this.maybeGet(domain, id), `${domain} ${id}`);
  }

  private timestamp(): string {
    return requireIsoTimestamp(this.now(), 'ChildExecution clock');
  }
}

function normalizeSpawnCommand(command: ChildExecutionSpawnCommand) {
  const sourceToolCallId = requirePhaseFId(command.sourceToolCallId, 'sourceToolCallId');
  const childAgentId = requirePhaseFId(command.childAgentId, 'childAgentId');
  const completionPolicy = requireCompletionPolicy(command.completionPolicy);
  const sourceSettlement = requireSpawnSourceSettlement(command.sourceSettlement);
  const waitDeadlineAt = command.waitDeadlineAt === undefined
    ? undefined
    : requireIsoTimestamp(command.waitDeadlineAt, 'waitDeadlineAt');
  if (completionPolicy === 'wait_for_answer' && !waitDeadlineAt) {
    throw new TypeError('wait_for_answer requires a persisted waitDeadlineAt.');
  }
  if (completionPolicy === 'background' && waitDeadlineAt) {
    throw new TypeError('background completion must not persist a foreground wait deadline.');
  }
  if (sourceSettlement === 'external' && completionPolicy !== 'background') {
    throw new TypeError('external source settlement requires background completion.');
  }
  return {
    sourceToolCallId,
    childAgentId,
    modelFallback: normalizeTurnModelOverride(command.modelFallback),
    prompt: requirePhaseFText(command.prompt, 'prompt'),
    completionPolicy,
    sourceSettlement,
    ...(waitDeadlineAt ? { waitDeadlineAt } : {}),
    ...(optionalPhaseFId(command.childConversationId, 'childConversationId')
      ? { childConversationId: optionalPhaseFId(command.childConversationId, 'childConversationId')! }
      : {}),
    title: typeof command.title === 'string' && command.title.trim()
      ? command.title.trim()
      : '子 Agent 对话',
    leaseOwnerId: requirePhaseFId(command.leaseOwnerId, 'leaseOwnerId'),
    leaseExpiresAt: requireIsoTimestamp(command.leaseExpiresAt, 'leaseExpiresAt')
  };
}

function normalizeSendCommand(command: ChildExecutionSendCommand) {
  if (typeof command.content !== 'string' && !(command.content instanceof Uint8Array)) {
    throw new TypeError('ChildExecution send content must be text or bytes.');
  }
  const completionPolicy = requireCompletionPolicy(command.completionPolicy);
  const waitDeadlineAt = command.waitDeadlineAt === undefined
    ? undefined
    : requireIsoTimestamp(command.waitDeadlineAt, 'waitDeadlineAt');
  if (completionPolicy === 'wait_for_answer' && !waitDeadlineAt) {
    throw new TypeError('wait_for_answer continuation requires a persisted waitDeadlineAt.');
  }
  if (completionPolicy === 'background' && waitDeadlineAt) {
    throw new TypeError('background continuation must not persist a wait deadline.');
  }
  return {
    sourceKey: requirePhaseFText(command.sourceKey, 'sourceKey'),
    sourceToolCallId: requirePhaseFId(command.sourceToolCallId, 'sourceToolCallId'),
    childExecutionId: requirePhaseFId(command.childExecutionId, 'childExecutionId'),
    mode: requireSendMode(command.mode),
    content: command.content,
    contentType: command.contentType === undefined
      ? 'text/plain'
      : requirePhaseFText(command.contentType, 'contentType'),
    completionPolicy,
    ...(waitDeadlineAt ? { waitDeadlineAt } : {})
  };
}

function normalizeRuntimeDeliveryContinuationCommand(
  command: ChildRuntimeDeliveryContinuationCommand
) {
  return {
    deliveryId: requirePhaseFId(command.deliveryId, 'deliveryId'),
    childExecutionId: requirePhaseFId(command.childExecutionId, 'childExecutionId'),
    sourceTurnId: requirePhaseFId(command.sourceTurnId, 'sourceTurnId')
  };
}

function normalizeAdmissionCommand(command: ChildContinuationAdmissionCommand) {
  return {
    sourceKey: requirePhaseFText(command.sourceKey, 'sourceKey'),
    childExecutionId: requirePhaseFId(command.childExecutionId, 'childExecutionId'),
    turnIntentId: requirePhaseFId(command.turnIntentId, 'turnIntentId'),
    leaseOwnerId: requirePhaseFId(command.leaseOwnerId, 'leaseOwnerId'),
    leaseExpiresAt: requireIsoTimestamp(command.leaseExpiresAt, 'leaseExpiresAt')
  };
}

export function childInterruptionRecoverySourceKey(childExecutionIdInput: string): string {
  return `${CHILD_INTERRUPTION_RECOVERY_SOURCE_PREFIX}${requirePhaseFId(
    childExecutionIdInput,
    'childExecutionId'
  )}`;
}

function isChildInterruptionRecoverySourceKey(sourceKey: string): boolean {
  return sourceKey.startsWith(CHILD_INTERRUPTION_RECOVERY_SOURCE_PREFIX)
    && sourceKey.length > CHILD_INTERRUPTION_RECOVERY_SOURCE_PREFIX.length;
}

function normalizeCancelCommand(command: ChildExecutionCancelCommand) {
  return {
    sourceKey: requirePhaseFText(command.sourceKey, 'sourceKey'),
    childExecutionId: requirePhaseFId(command.childExecutionId, 'childExecutionId'),
    reason: requirePhaseFText(command.reason, 'reason')
  };
}

function spawnIds(command: ReturnType<typeof normalizeSpawnCommand>): SpawnIds {
  const source = command.sourceToolCallId;
  const identity = childExecutionSpawnIdentity({
    sourceToolCallId: source,
    ...(command.childConversationId ? { childConversationId: command.childConversationId } : {})
  });
  const { childExecutionId, childConversationId, childTurnId, answerBridgeId } = identity;
  return {
    childExecutionId,
    childConversationId,
    childOriginLinkId: childConversationOriginLinkId(source),
    childAgentLinkId: stablePhaseFId('agent_conversation_link', 'child', source),
    childTurnId,
    childLeaseId: stablePhaseFId('execution_lease', 'child-first', source),
    childExecutorLinkId: stablePhaseFId('turn_executor_link', 'child-first', source),
    childAuthoritySnapshotId: stablePhaseFId('authority_snapshot', 'child-first', source),
    childMessageId: stablePhaseFId('message', 'child-first', source),
    childMessageRevisionId: stablePhaseFId('message_revision', 'child-first', source),
    childMessageCurrentLinkId: stablePhaseFId('message_current_revision_link', 'child-first', source),
    childMessageMembershipId: stablePhaseFId('message_conversation_link', 'child-first', source),
    childMessageTurnLinkId: stablePhaseFId('message_turn_link', 'child-first', source),
    parentLinkId: stablePhaseFId('child_execution_parent_link', source),
    turnLinkId: stablePhaseFId('child_execution_turn_link', 'first', source),
    activeTurnLinkId: stablePhaseFId('child_execution_active_turn_link', source),
    answerBridgeId,
    operationId: stablePhaseFId('operation', 'subagent-spawn', source),
    attemptId: stablePhaseFId('attempt', 'subagent-spawn', source, 1),
    effectIntentId: stablePhaseFId('effect_intent', 'subagent-spawn', source, 1),
    commandReceiptId: stablePhaseFId('command_receipt', 'subagent-spawn', source)
  };
}

function childConversationOriginLinkId(sourceToolCallId: string): string {
  return stablePhaseFId('conversation_origin_link', 'child', sourceToolCallId);
}

function assertChildConversationOrigin(
  rows: DomainRow[],
  expected: {
    originLinkId: string;
    childConversationId: string;
    sourceConversationId: string;
    parentTurnId: string;
    sourceToolCallId: string;
  }
): void {
  if (rows.length !== 1) throw new Error(`Child Conversation ${expected.childConversationId} must have one origin link.`);
  const origin = rows[0];
  if (
    origin.id !== expected.originLinkId
    || origin.conversation_id !== expected.childConversationId
    || origin.source_conversation_id !== expected.sourceConversationId
    || origin.source_turn_id !== expected.parentTurnId
    || origin.source_tool_call_id !== expected.sourceToolCallId
    || origin.source_message_revision_id !== null
  ) throw new Error(`Child Conversation ${expected.childConversationId} has conflicting origin lineage.`);
}

function spawnRequestPayload(
  command: ReturnType<typeof normalizeSpawnCommand>,
  ids: SpawnIds
): Record<string, unknown> {
  // Lease owner/expiry are host-local fencing facts stored on ExecutionLease. They are excluded
  // from the immutable effect identity so a durable spawn can be replayed after Host restart.
  return {
    sourceToolCallId: command.sourceToolCallId,
    childExecutionId: ids.childExecutionId,
    childConversationId: ids.childConversationId,
    childTurnId: ids.childTurnId,
    answerBridgeId: ids.answerBridgeId,
    childAgentId: command.childAgentId,
    modelFallback: command.modelFallback,
    authoritySnapshotId: ids.childAuthoritySnapshotId,
    inputMessageId: ids.childMessageId,
    inputMessageRevisionId: ids.childMessageRevisionId,
    completionPolicy: command.completionPolicy,
    sourceSettlement: command.sourceSettlement,
    waitDeadlineAt: command.waitDeadlineAt ?? null,
    title: command.title,
    prompt: command.prompt
  };
}

function spawnResult(
  ids: SpawnIds,
  completionPolicy: ChildCompletionPolicy,
  modelSelection: TurnModelOverride,
  deduplicated: boolean,
  commitSeq?: string
): ChildExecutionSpawnResult {
  return {
    childExecutionId: ids.childExecutionId,
    childConversationId: ids.childConversationId,
    childTurnId: ids.childTurnId,
    answerBridgeId: ids.answerBridgeId,
    operationId: ids.operationId,
    attemptId: ids.attemptId,
    effectIntentId: ids.effectIntentId,
    modelSelection,
    completionPolicy,
    deduplicated,
    ...(commitSeq ? { commitSeq } : {})
  };
}

function asUtf8Text(content: string | Uint8Array, label: string): string {
  if (typeof content === 'string') return content;
  try {
    return Buffer.from(content).toString('utf8');
  } catch (error) {
    throw new Error(`${label} is not valid UTF-8 content: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sendIds(command: ReturnType<typeof normalizeSendCommand>) {
  return sendIdentityIds(
    command.childExecutionId,
    command.sourceKey,
    command.sourceToolCallId,
    command.mode
  );
}

function sendIdentityIds(
  childExecutionId: string,
  sourceKey: string,
  sourceToolCallId: string,
  mode: ChildSendMode
) {
  const scope = [childExecutionId, sourceKey, sourceToolCallId, mode];
  return {
    commandReceiptId: stablePhaseFId('command_receipt', 'child-send', ...scope),
    turnIntentId: stablePhaseFId('turn_intent', 'child-send', ...scope),
    turnIntentRevisionId: stablePhaseFId('turn_intent_revision', 'child-send', ...scope),
    presetRevisionId: stablePhaseFId('turn_execution_preset_revision', 'child-send', ...scope),
    intentLinkId: stablePhaseFId('child_execution_intent_link', 'child-send', ...scope),
    pendingTurnInputId: queuedIntentPendingInputId(childExecutionId, stablePhaseFId('turn_intent', 'child-send', ...scope)),
    operationId: stablePhaseFId('operation', 'child-send', ...scope),
    pauseId: stablePhaseFId('outcome_pause', 'child-send', ...scope)
  };
}

function sendResult(
  command: ReturnType<typeof normalizeSendCommand>,
  ids: ReturnType<typeof sendIds>,
  hasPendingTurnInput: boolean,
  deduplicated: boolean,
  commitSeq?: string
): ChildExecutionSendResult {
  return {
    childExecutionId: command.childExecutionId,
    turnIntentId: ids.turnIntentId,
    intentLinkId: ids.intentLinkId,
    ...(hasPendingTurnInput ? { pendingTurnInputId: ids.pendingTurnInputId } : {}),
    operationId: ids.operationId,
    ...(command.completionPolicy === 'wait_for_answer' ? { pauseId: ids.pauseId } : {}),
    mode: command.mode,
    completionPolicy: command.completionPolicy,
    deduplicated,
    ...(commitSeq ? { commitSeq } : {})
  };
}

function queuedIntentPendingInputId(childExecutionId: string, turnIntentId: string): string {
  return stablePhaseFId('pending_turn_input', 'child-send-intent', childExecutionId, turnIntentId);
}

function admissionIds(command: ReturnType<typeof normalizeAdmissionCommand>) {
  const scope = [command.childExecutionId, command.turnIntentId];
  return {
    commandReceiptId: stablePhaseFId('command_receipt', 'child-admit', command.sourceKey, ...scope),
    turnId: childContinuationTurnId(command.childExecutionId, command.turnIntentId),
    leaseId: stablePhaseFId('execution_lease', 'child-continuation', ...scope),
    authoritySnapshotId: stablePhaseFId('authority_snapshot', 'child-continuation', ...scope),
    executorLinkId: stablePhaseFId('turn_executor_link', 'child-continuation', ...scope),
    messageId: stablePhaseFId('message', 'child-continuation', ...scope),
    messageRevisionId: stablePhaseFId('message_revision', 'child-continuation', ...scope),
    messageCurrentLinkId: stablePhaseFId('message_current_revision_link', 'child-continuation', ...scope),
    messageMembershipId: stablePhaseFId('message_conversation_link', 'child-continuation', ...scope),
    messageTurnLinkId: stablePhaseFId('message_turn_link', 'child-continuation', ...scope),
    turnLinkId: stablePhaseFId('child_execution_turn_link', 'child-continuation', ...scope)
  };
}

export function childContinuationTurnId(childExecutionId: string, turnIntentId: string): string {
  return stablePhaseFId('turn', 'child-continuation', childExecutionId, turnIntentId);
}

function terminalChildTurnSteps(
  facts: Awaited<ReturnType<ChildExecutionControlPlane['reconcileSpawnReceipt']>> extends never ? never : any,
  observed: EffectObservedOutcome,
  now: string
): RepositoryTransactionStep[] {
  if (!facts.childTurn || facts.childTurn.status !== ACTIVE_TURN) return [];
  const status = observed === 'cancelled' ? 'cancelled' : observed === 'outcome_unknown' ? 'outcome_unknown' : 'failed';
  return [
    DOMAIN_REPOSITORIES.domain('Turn').assert(facts.childTurn.id as string, { status: ACTIVE_TURN }),
    ...(facts.childLease
      ? [DOMAIN_REPOSITORIES.domain('ExecutionLease').deleteByUnique({ turn_id: facts.childTurn.id })]
      : []),
    DOMAIN_REPOSITORIES.domain('TurnTermination').insert({
      id: stablePhaseFId('turn_termination', 'spawn-failure', facts.childTurn.id),
      turn_id: facts.childTurn.id,
      terminal_status: status,
      reason: `subagent spawn settled as ${observed}`,
      created_at: now
    }),
    DOMAIN_REPOSITORIES.domain('Turn').update(facts.childTurn.id as string, {
      status: TERMINATED_TURN,
      updated_at: now,
      terminal_at: now
    }),
    ...(facts.activeLink
      ? [DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').delete(facts.activeLink.id as string)]
      : [])
  ];
}

function childControlHandle(child: DomainRow, bridge: DomainRow) {
  return {
    childExecutionId: child.id,
    childConversationId: child.child_conversation_id,
    answerBridgeId: bridge.id,
    state: child.status
  };
}

function spawnRecoveryResult(facts: SpawnIntentFacts, reconciled: boolean): ChildSpawnRecoveryResult {
  const dispatchState = requirePhaseFText(facts.intent.dispatch_state, 'EffectIntent.dispatch_state');
  const childStatus = requirePhaseFText(facts.childExecution.status, 'ChildExecution.status');
  const turnStatus = requirePhaseFText(facts.childTurn.status, 'Turn.status');
  return {
    effectIntentId: requirePhaseFId(facts.intent.id, 'EffectIntent.id'),
    childExecutionId: requirePhaseFId(facts.childExecution.id, 'ChildExecution.id'),
    childTurnId: requirePhaseFId(facts.childTurn.id, 'Turn.id'),
    dispatchState,
    childStatus,
    turnStatus,
    shouldDrive: reconciled && childStatus === 'active' && turnStatus === ACTIVE_TURN
  };
}

function spawnRequestMetadata(value: unknown): {
  sourceToolCallId: string;
  completionPolicy: ChildCompletionPolicy;
  sourceSettlement: ChildSpawnSourceSettlement;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('subagent_spawn request payload is invalid.');
  }
  const record = value as Record<string, unknown>;
  return {
    sourceToolCallId: requirePhaseFId(record.sourceToolCallId, 'subagent_spawn.sourceToolCallId'),
    completionPolicy: requireCompletionPolicy(record.completionPolicy),
    sourceSettlement: requireSpawnSourceSettlement(record.sourceSettlement)
  };
}

function requireCompletionPolicy(value: unknown): ChildCompletionPolicy {
  if (value !== 'wait_for_answer' && value !== 'background') {
    throw new TypeError('completionPolicy must be wait_for_answer or background.');
  }
  return value;
}

function requireSpawnSourceSettlement(value: unknown): ChildSpawnSourceSettlement {
  if (value !== 'child_handle' && value !== 'external') {
    throw new TypeError('sourceSettlement must be child_handle or external.');
  }
  return value;
}

function requireSendMode(value: unknown): ChildSendMode {
  if (value !== 'queue_next_turn' && value !== 'interrupt_current_turn') {
    throw new TypeError('ChildExecution send mode must be queue_next_turn or interrupt_current_turn.');
  }
  return value;
}

function requireSpawnObservedOutcome(value: unknown): EffectObservedOutcome {
  if (!['succeeded', 'failed', 'cancelled', 'conflict', 'outcome_unknown'].includes(String(value))) {
    throw new TypeError(`Unsupported subagent spawn receipt outcome: ${String(value)}.`);
  }
  return value as EffectObservedOutcome;
}

function observedToToolOutcome(value: EffectObservedOutcome): ToolOutcomeStatus {
  return value;
}

function uniquePrepared(values: PreparedContentObject[]): PreparedContentObject[] {
  return [...new Map(values.map((value) => [value.metadata.id, value])).values()];
}

function allocatedValue(
  allocated: ReadonlyArray<{ domain: string; id: string; column: string; value: string }>,
  domain: string,
  id: string,
  column: string
): string {
  const row = allocated.find((entry) => entry.domain === domain && entry.id === id && entry.column === column);
  if (!row) throw new Error(`Missing allocated ${domain}.${column} for ${id}.`);
  return row.value;
}

function isExpectedSpawnIdentityConflict(error: unknown): boolean {
  return sqliteUniqueFailureIncludes(error, [
    'child_execution_parent_link.source_tool_call_id',
    'child_execution.id',
    'conversation.id',
    'command_receipt.source_kind, command_receipt.source_key'
  ]);
}

function isExpectedSendIdentityConflict(error: unknown): boolean {
  return sqliteUniqueFailureIncludes(error, [
    'command_receipt.source_kind, command_receipt.source_key',
    'turn_intent.id',
    'child_execution_intent_link.turn_intent_id'
  ]);
}

function isExpectedRuntimeDeliveryContinuationConflict(error: unknown): boolean {
  return isTransactionAssertionFailure(error) || sqliteUniqueFailureIncludes(error, [
    'command_receipt.source_kind, command_receipt.source_key',
    'turn_intent.id',
    'child_execution_intent_link.turn_intent_id',
    'runtime_delivery_intent_link.delivery_id',
    'runtime_delivery_intent_link.turn_intent_id'
  ]);
}

function isExpectedAdmissionIdentityConflict(error: unknown): boolean {
  return sqliteUniqueFailureIncludes(error, [
    'command_receipt.source_kind, command_receipt.source_key',
    'turn.id',
    'child_execution_turn_link.turn_id'
  ]) || isTransactionAssertionFailure(error);
}

function isExpectedCancelIdentityConflict(error: unknown): boolean {
  return sqliteUniqueFailureIncludes(error, [
    'command_receipt.source_kind, command_receipt.source_key',
    'pending_turn_input.id'
  ]) || isTransactionAssertionFailure(error);
}

function isExpectedSettlementRace(error: unknown): boolean {
  return isTransactionAssertionFailure(error) || sqliteUniqueFailureIncludes(error, [
    'tool_result_artifact.id',
    'tool_result_artifact.tool_call_id, tool_result_artifact.role',
    'tool_outcome.tool_call_id',
    'tool_model_result.tool_call_id',
    'tool_model_result.message_revision_id',
    'command_receipt.source_kind, command_receipt.source_key'
  ]);
}

function executionWaitComplete(snapshot: ChildExecutionSnapshot): boolean {
  const status = requireChildExecutionStatus(snapshot.childExecution.status);
  return snapshot.currentSubmission !== null
    || isChildExecutionPermanentlyTerminal(status)
    || status === 'interrupted'
    || snapshot.activeTurn === null
    || snapshot.activeTurn.status === TERMINATED_TURN;
}

function compareBigInt(left: unknown, right: unknown): number {
  const a = typeof left === 'bigint' ? left : BigInt(String(left));
  const b = typeof right === 'bigint' ? right : BigInt(String(right));
  return a < b ? -1 : a > b ? 1 : 0;
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new TypeError(`${label} must be an integer.`);
}

function requireRow(value: unknown, label: string): DomainRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value as DomainRow;
}

function optionalRow(value: unknown, label: string): DomainRow | null {
  if (value === null || value === undefined) return null;
  return requireRow(value, label);
}

function requireRows(value: unknown, label: string): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} did not return rows.`);
  return value as DomainRow[];
}
