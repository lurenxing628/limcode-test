import { readConversationContextHandleStateRow, readCurrentConversationContextHandleState } from './conversationContextHandleState';
import { acceptedNoticeMetadata, type AcceptedAnswerNotice } from './answerPresentation';
import { CHILD_ANSWER_SOURCE_DELETED_CONTENT_TYPE } from './deliverySettlementSteps';
import { readRequestTurnAuthority } from './requestCompressionSettings';
import { isTransactionAssertionFailure } from './phaseFIdentity';
import { readAgentLoopResumeState, type AgentLoopResumeState } from './agentLoopResumeState';

import {
  buildModelHandleCatalog,
  mergeModelHandleCatalogs,
  modelHandleEntries,
  modelHandleRef,
  normalizeModelHandleCatalog,
  prepareModelHandleCatalog,
  resolveModelToolArguments,
  UnknownModelHandleReferenceError,
  type ModelHandleCatalog
} from './modelHandleCatalog';
import { forkInheritedChildTargets, forkSourceConversationIds, isForkConversation, readConversationContextHandleState } from './conversationChildHandles';
import { historicalProcessHandleCard } from './historicalProcessHandleCard';
import { readConversationChildTaskRuntimeStatus, type ConversationChildTaskRuntimeStatus } from './conversationChildTaskProjection';
import { isReadonlyAgentCollaborationTool } from '../world/modules/tools/definitions/agentCollaboration';
import { isReadonlyCrossConversationTool } from '../world/modules/tools/definitions/crossConversation';
import { isReadonlyAgentBoardOperation } from '../world/modules/tools/definitions/agentBoard';
import { isReadonlyRunAgentOperation } from '../world/modules/tools/definitions/runAgent';
import { createHash } from 'node:crypto';
import {
  isVisibleTextPart,
  type LlmOpenAIResponsesTransport,
  type LlmProviderKind,
  type MessageContent
} from '../../shared/protocol';
import { mapSettledWithBoundedConcurrency } from '../capabilities/boundedConcurrency';
import { classifyCommandCall } from '../world/modules/tools/definitions/command';
import type { RuntimeDeliveryControlPlane } from './answerDelivery';
import type { RuntimeDeliveryModelProjection } from './runtimeDeliveryProjection';
import { AutomaticRuntimeDeliveryRouter } from './automaticRuntimeDelivery';
import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { ContextSequenceControlPlane, type MaterializedContextStructure } from './contextSequence';
import { selectContextHandleBindings } from './contextHandleOccurrenceEvidence';
import { estimateStoredMessageContentTokens } from './contextTokenEstimator';
import {
  compareGuidancePositions,
  initialGuidancePosition,
  parseInputTurnIntentEnvelope,
  parseRuntimeContinuationTurnIntentEnvelope,
  TURN_INTENT_ENVELOPE_CONTENT_TYPE
} from './guidanceIntent';
import {
  EffectControlPlane,
  type CreatedToolCallBatch,
  type FrozenToolCallPolicyDecision,
  type NativeToolAdmission,
  type ToolOutcomeStatus,
  type ToolTerminalResult
} from './effectControlPlane';
import {
  isNativeChainReplayUnsafeError,
  ModelRequestPreflightError,
  ModelProviderControlPlane,
  modelRequestIdFor,
  assertProviderCallbackAuthority,
  restoredProviderRequestFailure,
  NATIVE_CHAIN_REBASED_TERMINAL_STATE,
  PROVIDER_PARTIAL_OUTPUT_SNAPSHOT_TYPE,
  type FullRequestProviderAdapter,
  type ProviderDispatchControls,
  type ProviderTransientStreamEvent,
  type StreamEventResult
} from './modelProviderControlPlane';
import {
  openAIResponsesNativeCapabilities,
  normalizeOpenAIResponsesNativeSettings
} from '../../shared/openAIResponsesCapabilities';
import type { OpenAIResponsesNativeCapabilities } from '../../shared/openAIResponsesNative';
import { NativeRequestSession } from './nativeRequestSession';
import { NativeAsyncWorkPendingError, TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY, parseNativeControlCheckpoint } from './nativeToolFacts';
import { readNativeSteeringInFlight } from './nativeSteering';
import {
  NativeRequestBudgetError,
  NativeSafetyWaitError,
  nativeFullRequestExceedsBudget,
  planNativeCompressionRebase,
  type NativeLogicalRequestBudget
} from './nativeCompressionGuard';
import {
  readCurrentTurnTaskCard,
  shouldInjectTurnTaskCard,
  type TurnTaskCardReminderState
} from './currentTurnTaskProjection';
import { canonicalPlainJson, normalizePlainJson, type PlainJsonValue } from './plainJson';
import { CLAUDE_TURN_SCOPED_REMINDER_DELIVERY, claudeTurnScopedRemindersEnabled } from './turnReminderProjection';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryKeysetCursor } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { orderRuntimeDeliveriesForInjection } from './runtimeDeliveryOrder';
import { RuntimeDatabase } from './runtimeDatabase';
import {
  isTurnTerminalGuidanceConflictError,
  isTurnTerminalInputConflictError,
  TurnControlPlane,
  type TurnInputCommand
} from './turnControlPlane';
import { frozenCompressionPolicy, frozenProviderRetryPolicy, readFrozenTurnAuthority } from './frozenAuthority';
import { assistantMessageIdFor, nativeAssistantPartIdentity, TurnOutputControlPlane } from './turnOutput';
import { currentExecutionLeaseFence, ExecutionEligibilityLostError, ExecutionHandoffError, isExecutionHandoffError } from './executionLeaseFence';
import { isRetryableLocalExecutionError, LOCAL_EXECUTION_MAX_RETRIES, LocalExecutionRecoveryExhaustedError, waitForLocalExecutionRetry } from './localExecutionRecovery';
import { isStrictSingleSummaryPlan } from './contextCompressionCoordinator';
import type {
  AutomaticCompressionContinuation,
  CoordinateCompressionCommand,
  CoordinateCompressionResult
} from './contextCompressionCoordinator';

export interface ReliableAgentToolDefinition {
  name: string;
  description: string;
  parameters: PlainJsonValue;
  /** Credential-free source identity used for frozen dynamic MCP policy evaluation. */
  source?: PlainJsonValue;
  /** Plain definition facts frozen into the ModelRequest recipe. */
  metadata?: PlainJsonValue;
  defaultConfig?: PlainJsonValue;
}

export interface ReliableAgentProviderRegistry {
  resolve(providerId: string): Promise<FullRequestProviderAdapter> | FullRequestProviderAdapter;
  dispose?(): Promise<void> | void;
}

export interface ReliableAgentCompressionCoordinator {
  coordinate(command: CoordinateCompressionCommand): Promise<CoordinateCompressionResult>;
  readAutomaticCompressionContinuation?(input: {
    turnId: string; ordinaryRequestId: string; authoritySnapshotId: string; headRootId: string;
  }): Promise<AutomaticCompressionContinuation | undefined>;
  recoverProviderContextOverflow?(input: { turnId: string; failedModelRequestId: string }): Promise<CoordinateCompressionResult>;
}

export interface ReliableAgentToolDispatchInput {
  turnId: string;
  modelRequestId: string;
  toolCallId: string;
  providerCallId?: string;
  toolName: string;
  arguments: PlainJsonValue;
}

export interface ReliableAgentToolPause {
  disposition: 'paused';
  toolCallId: string;
  reason: 'awaiting_user' | 'awaiting_approval' | 'awaiting_plan_review' | 'awaiting_child' | 'background_process' | 'converging';
  resumeKey?: string;
}

export interface ReliableAgentToolSettled {
  disposition: 'settled';
  toolCallId: string;
  status: ToolOutcomeStatus;
}

export interface ReliableAgentToolBatchAdmission {
  readonly kind: 'checked-provider-tool-batch';
  /** Process-local identity. The issuing dispatcher is the only authority that can resolve it. */
  readonly token: object;
}

export interface ReliableAgentToolBatchConfirmationInput {
  turnId: string;
  modelRequestId: string;
  messageId: string;
  batchId: string;
  recipeDefinitions: readonly ReliableAgentToolDefinition[];
  calls: ReadonlyArray<ReliableAgentToolDispatchInput & {
    providerOrdinal: number;
    policy: FrozenToolCallPolicyDecision;
  }>;
  creation: CreatedToolCallBatch;
}

/** Dispatcher owns capability-specific EffectIntent/Receipt semantics and may durably pause the Turn. */
export interface ReliableAgentToolDispatcher {
  /** turnId selects definitions through that Turn's immutable authority snapshot. */
  definitions(turnId?: string): Promise<ReliableAgentToolDefinition[]> | ReliableAgentToolDefinition[];
  /** Compiles display/gate/scheduling for a Provider batch from one immutable authority read. */
  freezeCalls?(inputs: ReadonlyArray<ReliableAgentToolDispatchInput & {
    definition: ReliableAgentToolDefinition;
  }>): Promise<FrozenToolCallPolicyDecision[]>;
  /** Compiles display/gate/scheduling from the immutable Turn authority and frozen recipe definition. */
  freezeCall?(input: ReliableAgentToolDispatchInput & {
    definition: ReliableAgentToolDefinition;
  }): Promise<FrozenToolCallPolicyDecision>;
  /** Turns one fresh atomic ToolCall batch receipt into a process-local checked fast-path token. */
  confirmPreparedBatch?(
    input: ReliableAgentToolBatchConfirmationInput
  ): Promise<ReliableAgentToolBatchAdmission | undefined> | ReliableAgentToolBatchAdmission | undefined;
  /** Dispatches one already-frozen parallel group while sharing read-only preflight/finalization work. */
  dispatchBatch?(
    inputs: readonly ReliableAgentToolDispatchInput[],
    options?: { admission?: ReliableAgentToolBatchAdmission }
  ): Promise<Array<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled>>;
  dispatch(input: ReliableAgentToolDispatchInput): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled>;
  /**
   * Starts one durably admitted native streamed call using the dispatcher's own classifiers,
   * serial/parallel policy, approval/admission behavior and shared Turn scheduling limits. The
   * kernel never imposes a second scheduler for early async execution.
   */
  scheduleAdmittedCall?(
    input: ReliableAgentToolDispatchInput
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled>;
  /**
   * Fires whenever a ToolCall of the Turn gains a terminal ToolModelResult through any live path
   * (dispatch resolution, batch, approval resume, deferred no-effect, cancellation settlement).
   * Native async deliveries depend on it while the loop is blocked inside a logical request.
   */
  subscribeToolSettlements?(
    input: { turnId: string },
    listener: (event: { toolCallId: string }) => void
  ): () => void;
  /** Prewired cancellation boundary; Runner may invoke it without knowing capability internals. */
  cancelActive?(input: { turnId: string; reason: string }): Promise<void> | void;
  /** Host handoff aborts local waits without inventing a user cancellation or terminal Turn. */
  quiesceTurn?(input: { turnId: string; reason: ExecutionHandoffError }): Promise<void> | void;
  quiesce?(reason: ExecutionHandoffError): Promise<void> | void;
  /** Closes capability-specific durable waits before a terminal Turn asserts every ToolCall is terminal. */
  cancelWaiting?(input: { turnId: string; sourceKey: string; reason: string }): Promise<void>;
  dispose?(): Promise<void> | void;
}

export interface ReliableAgentTransientEvent {
  conversationId: string;
  turnId: string;
  modelRequestId: string;
  requestSeq: string;
  providerId: string;
  modelId: string;
  attemptSeq: string;
  socketGeneration: string;
  /** Durable commit frontier visible before this Provider socket was dispatched. */
  afterCommitSeq: string;
  /** First stream sequence covered by this visible event and contiguous observed native controls. */
  fromStreamSeq?: string;
  event: ProviderTransientStreamEvent;
  observedAt: string;
}

export interface ReliableAgentTransientObserver {
  observe(event: ReliableAgentTransientEvent): void;
}

export type ReliableAgentLifecycleStage =
  | 'drive_started'
  | 'round_facts_ready'
  | 'provider_dispatch_started'
  | 'provider_output_ready'
  | 'assistant_commit_started'
  | 'assistant_commit_completed'
  | 'tool_dispatch_started'
  | 'tool_dispatch_completed'
  | 'tool_model_result_committed'
  | 'terminal_prefix_scanned'
  | 'context_tool_pair_committed'
  | 'turn_terminal_started'
  | 'turn_terminal_completed'
  | 'open_tasks_at_final'
  | 'drive_failed'
  | 'failure_terminal_started'
  | 'failure_terminal_completed'
  | 'failure_terminal_failed'
  | 'native_context_closure_failed';

/** Bounded metadata-only diagnostics. No prompt, model output, tool arguments, or credentials are exposed. */
export interface ReliableAgentLifecycleEvent {
  turnId: string;
  stage: ReliableAgentLifecycleStage;
  observedAt: string;
  /** Durable ModelRequest sequence. Decimal string because runtime sequences must not cross JS number. */
  round?: string;
  modelRequestId?: string;
  toolCallId?: string;
  /** Present when one dispatcher call owns a Provider parallel group. */
  toolBatchSize?: number;
  schedulingMode?: 'parallel' | 'serial';
  terminalCallsScanned?: number;
  terminalPrefixCursor?: number;
  contextPairCount?: number;
  contextTransactionCount?: number;
  openTaskCount?: number;
  taskCardSha256?: string;
  activeChildCount?: number;
  runningProcessCount?: number;
  errorName?: string;
  errorMessage?: string;
}

export interface ReliableAgentLifecycleObserver {
  observe(event: ReliableAgentLifecycleEvent): void;
}

/**
 * Observes the final answer of a Turn after it is committed and fenced, before the Turn is recorded
 * completed. A child execution uses it to hand that answer to its parent. Must be idempotent: a
 * recovered drive of the same Turn calls it again for the same ModelRequest.
 */
export interface ReliableTurnFinalOutputObserver {
  beforeTurnCompleted(input: { turnId: string; modelRequestId: string; finalText: string }): Promise<void>;
}

export interface ReliableAgentLoopResult {
  turnId: string;
  terminalStatus: 'completed' | 'failed' | 'interrupted' | 'waiting';
  modelRequestIds: string[];
  assistantMessageIds: string[];
  toolCallIds: string[];
  waitingToolCallId?: string;
  waitingContextHandleUpgrade?: true;
}

interface NormalizedToolCall {
  providerCallId?: string;
  providerOrdinal: number;
  name: string;
  arguments: PlainJsonValue;
  thoughtSignature?: string;
}

interface NormalizedProviderOutput {
  content: MessageContent;
  toolCalls: NormalizedToolCall[];
  usage?: PlainJsonValue;
}

interface ResolvedProviderToolCall extends NormalizedToolCall {
  argumentResolutionError?: string;
}

interface FrozenProviderToolCall extends ResolvedProviderToolCall {
  toolCallId: string;
  policy: FrozenToolCallPolicyDecision;
  /** Present only for the same-process, newly committed Provider batch. */
  batchAdmission?: ReliableAgentToolBatchAdmission;
}

interface FrozenCurrentTurnInputReference {
  kind: 'current_turn_input';
  messageId: string;
  messageRevisionId: string;
  contentObjectId: string;
  estimatedTokens: number;
  reinject: boolean;
}

/** No model-visible Context or adapter survives the short-lived planning frame. */
interface OrdinaryRequestPlanningFacts {
  providerId: string;
  modelId: string;
  compressionAuthority: PlainJsonValue;
  budget: ReturnType<ModelProviderControlPlane['planFullRequest']>;
}

interface CurrentTurnRequestState {
  /** Operation-local immutable root view, reused by native predecessor selection. */
  structure: MaterializedContextStructure;
  reference?: FrozenCurrentTurnInputReference;
  compressionBoundaryId?: string;
}

interface ForkIdentityFacts {
  conversationId: string;
  /** Branch sources, nearest first. */
  sourceConversationIds: string[];
  /** Collaboration messages this Conversation itself sent or received. */
  ownMessageIds: ReadonlySet<string>;
}

/**
 * The collaboration refs of a fork's catalog that it inherited: its branch sources among its
 * conversation refs, and the messages it was not party to. Undefined when there are none, so a
 * fork of a conversation that never collaborated gets no card.
 */
function forkInheritedCollaborationTargets(catalog: ModelHandleCatalog, facts: ForkIdentityFacts): {
  sourceConversationIds: string[]; messageIds: string[];
} | undefined {
  const known = (kind: 'conversation' | 'collaborationMessage') => new Set(modelHandleEntries(catalog, kind).map(entry => entry.target));
  const conversations = known('conversation');
  const sourceConversationIds = facts.sourceConversationIds.filter(id => conversations.has(id));
  const messageIds = [...known('collaborationMessage')].filter(id => !facts.ownMessageIds.has(id));
  return sourceConversationIds.length || messageIds.length ? { sourceConversationIds, messageIds } : undefined;
}

function emptyRuntimeStatusCard(heading: string): FrozenRuntimeStatusCard {
  return {
    kind: 'runtime_status_card', activeChildCount: 0, runningProcessCount: 0,
    totalChildCount: 0, descendantCount: 0, queuedInputCount: 0, awaitingHandlingCount: 0,
    childHandleTargets: [], children: [], processes: [], card: heading
  };
}

interface FrozenRuntimeStatusCard {
  kind: 'runtime_status_card';
  activeChildCount: number;
  runningProcessCount: number;
  totalChildCount: number;
  descendantCount: number;
  queuedInputCount: number;
  awaitingHandlingCount: number;
  /** Identity candidates include omitted rows; the provider sees only stable short references. */
  childHandleTargets: Array<{ answerBridgeId: string }>;
  /** Child refs a fork copied from its source history; listed as not operable from this Conversation. */
  inheritedChildTargets?: string[];
  children: ConversationChildTaskRuntimeStatus['children'];
  processes: Array<{ processId: string; status: 'running' }>;
  card: string;
}

export type OpenTaskCompletionAction = 'complete' | 'continue_once' | 'complete_with_open_tasks';

const MESSAGE_CONTENT_TYPE = 'application/vnd.limcode.message+json';
const RUNTIME_STATUS_RECIPE_LIMIT = 32;
const REQUEST_HISTORY_PAGE_SIZE = 32;
const OPEN_TASK_COMPLETION_CHECK_KIND = 'open_task_completion_check';
const OPEN_TASK_COMPLETION_CHECK_CARD = [
  '[Open Task Completion Check — system continuation, not a new user instruction]',
  'The previous response ended while the task list still had unfinished items.',
  'Continue the approved work where possible, then reconcile the complete task list before ending.',
  'Keep genuinely unfinished or blocked items explicit; do not replace or narrow the approved scope.'
].join('\n');

/**
 * 单 Turn 的可靠 Agent loop。每轮都冻结 Context root/authority，Provider 完成摘要先落 SQLite/CAS，
 * 再幂等提交 assistant Message；工具结果按 call_seq 持久化并追加 Context tool_pair。
 */
export class ReliableAgentLoop {
  private readonly finalOutputObservers = new Set<ReliableTurnFinalOutputObserver>();
  private readonly context: ContextSequenceControlPlane;
  /**
   * Host-local in-flight native call executions. A recovery re-drive attaches to the running
   * execution instead of dispatching the same admitted ToolCall a second time.
   */
  private readonly nativeCallExecutions = new Map<
    string,
    Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled>
  >();
  /** The Turn of each in-flight native call execution (same keys as nativeCallExecutions). */
  private readonly nativeCallTurnIds = new Map<string, string>();
  private readonly automaticDeliveries: AutomaticRuntimeDeliveryRouter;
  private readonly now: () => string;
  private readonly reconcileCommittedToolCall:
    | ((toolCallId: string) => Promise<ToolTerminalResult | null>)
    | undefined;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly turns: TurnControlPlane,
    private readonly turnOutput: TurnOutputControlPlane,
    private readonly modelProvider: ModelProviderControlPlane,
    private readonly effects: EffectControlPlane,
    private readonly runtimeDeliveries: RuntimeDeliveryControlPlane,
    private readonly providers: ReliableAgentProviderRegistry,
    private readonly compressionCoordinator: ReliableAgentCompressionCoordinator,
    private readonly tools: ReliableAgentToolDispatcher,
    private readonly transientObserver?: ReliableAgentTransientObserver,
    private readonly lifecycleObserver?: ReliableAgentLifecycleObserver,
    options: {
      now?: () => string;
      reconcileCommittedToolCall?: (toolCallId: string) => Promise<ToolTerminalResult | null>;
    } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.reconcileCommittedToolCall = options.reconcileCommittedToolCall;
    this.context = new ContextSequenceControlPlane(database, contentStore, options);
    this.automaticDeliveries = new AutomaticRuntimeDeliveryRouter(database, contentStore);
  }

  public async runInput(command: TurnInputCommand): Promise<ReliableAgentLoopResult> {
    const started = await this.turns.input(command);
    const turnId = requireId(started.turnId, 'Turn input result.turnId');
    return this.drive(turnId);
  }

  public registerFinalOutputObserver(observer: ReliableTurnFinalOutputObserver): () => void {
    this.finalOutputObservers.add(observer);
    return () => { this.finalOutputObservers.delete(observer); };
  }

  private async notifyFinalOutput(turnId: string, modelRequestId: string, content: MessageContent): Promise<void> {
    const finalText = finalAnswerText(content);
    for (const observer of this.finalOutputObservers) {
      await observer.beforeTurnCompleted({ turnId, modelRequestId, finalText });
    }
  }

  /**
   * The final answer a Turn fenced, read back from its durable Provider output: exactly what the
   * observers were (or would have been) given. Null when the Turn never fenced a final output.
   */
  public async readFinalOutput(turnIdInput: string): Promise<{ modelRequestId: string; finalText: string } | null> {
    const turnId = requireId(turnIdInput, 'turnId');
    const fences = await this.list('TurnFinalOutputFence', { turn_id: turnId }, 2);
    if (fences.length > 1) throw new Error(`Turn ${turnId} has multiple final-output fences.`);
    if (fences.length === 0) return null;
    const modelRequestId = requireId(fences[0].model_request_id, 'TurnFinalOutputFence.model_request_id');
    const output = await this.readTerminalProviderOutput(modelRequestId);
    return { modelRequestId, finalText: finalAnswerText(providerOutputMessage(output)) };
  }

  /** Safe for explicit recovery/re-entry; every round and output identity is deterministic. */
  /**
   * Control-only settlement of a durable stop request, for a window that must not execute the
   * Conversation: it opens the same Context boundary as drive() and records the pending interrupt
   * as the Turn's terminal state. It never dispatches the Provider or runs a tool; durable waits
   * are cancelled and non-terminal ModelRequests are closed as cancelled. Returns false when no
   * termination request is pending.
   */
  public async terminateRequested(turnIdInput: string, stage = 'control-settlement'): Promise<boolean> {
    const turnId = requireId(turnIdInput, 'turnId');
    const turn = await this.requireExisting('Turn', turnId);
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    await this.database.conversationOwners.assertOwned(conversationId);
    if (turn.status !== 'active') return turn.status === 'terminated';
    await this.openEmptyContextWithDeliveredInput(turnId);
    return this.terminateIfRequested(turnId, stage);
  }

  public async drive(turnIdInput: string): Promise<ReliableAgentLoopResult> {
    const turnId = requireId(turnIdInput, 'turnId');
    for (let retryNumber = 0; ; retryNumber += 1) {
      try {
        return await this.driveOnce(turnId, retryNumber < LOCAL_EXECUTION_MAX_RETRIES);
      } catch (error) {
        if ((error as { code?: string }).code === 'MODEL_CONTEXT_HANDLE_FRONTIER_CHANGED') {
          retryNumber -= 1;
          await new Promise<void>(resolve => setImmediate(resolve));
          continue;
        }
        if (!isRetryableLocalExecutionError(error)) throw error;
        if (retryNumber >= LOCAL_EXECUTION_MAX_RETRIES) throw new LocalExecutionRecoveryExhaustedError(error);
        // Re-entry uses the last durable ModelRequest, assistant identity and Effect receipts.
        // In particular a completed provider response is read from CAS, never requested again.
        await waitForLocalExecutionRetry(retryNumber + 1, async () => {
          try {
            if (await this.terminateIfRequested(turnId, 'local-recovery-backoff')) return true;
            await this.assertRecoveryStillOwned(turnId);
            return false;
          } catch (stopError) {
            if (!isRetryableLocalExecutionError(stopError)) throw stopError;
            return false;
          }
        });
      }
    }
  }

  private async driveOnce(turnIdInput: string, allowLocalRetry: boolean): Promise<ReliableAgentLoopResult> {
    const turnId = requireId(turnIdInput, 'turnId');
    const modelRequestIds: string[] = [];
    const assistantMessageIds: string[] = [];
    const toolCallIds: string[] = [];
    this.observeLifecycle({ turnId, stage: 'drive_started' });

    try {
      // ModelRequest.request_seq is the durable loop frontier. A re-entry deliberately starts at
      // the last committed request so a crash between Provider completion, assistant commit, tool
      // settlement and Context append replays that one round idempotently. Only after the replayed
      // round is complete do we advance to request_seq + 1. There is no process-local round cap:
      // safety limits belong to explicit token/cost/time policy, never an invisible failed Turn.
      await this.openEmptyContextWithDeliveredInput(turnId);
      const resumeState = await this.readResumeState(turnId);
      let requestSequence = resumeState.requestSequence;
      let openTaskCompletionCheckConsumed = resumeState.openTaskCompletionCheckConsumed;
      let includeOpenTaskCompletionCheck = false;
      let endedTurnsClosed = false;
      agentRounds: for (;;) {
        const round = requestSequence.toString();
        let facts = await this.readRoundFacts(turnId);
        const conversationId = requireId(facts.turn.conversation_id, 'Turn.conversation_id');
        if (!this.database.conversationOwners.owns(conversationId)) {
          throw new ExecutionHandoffError(`Conversation ${conversationId} is not owned by this Runtime Host.`);
        }
        await this.database.conversationOwners.assertOwned(conversationId);
        // A Host that stopped serving the Conversation (its folder left this window) stops here and
        // hands the Turn over. No synchronous tool of this Turn is running at a round boundary, but
        // an admitted async native call may still run in this Host: the hand-back waits for it
        // (quiesceNativeCalls) before the lease goes back.
        if (await this.database.conversationOwners.executionEligibility(conversationId) === 'ineligible') {
          throw new ExecutionEligibilityLostError(conversationId);
        }
        if ((await readConversationContextHandleStateRow(this.database, conversationId)).state === 'pending') {
          if (await this.terminateIfRequested(turnId, 'context-handle-upgrade-wait')) {
            return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
          }
          return { turnId, terminalStatus: 'waiting', modelRequestIds, assistantMessageIds, toolCallIds,
            waitingContextHandleUpgrade: true };
        }
        await this.cancelSupersededCompressionRequests(
          turnId,
          requireId(facts.head.root_id, 'ConversationContextHeadLink.root_id')
        );
        this.observeLifecycle({ turnId, stage: 'round_facts_ready', round });
        if (facts.turn.status !== 'active') {
          return {
            turnId,
            terminalStatus: await this.readLoopTerminalStatus(turnId, facts.turn),
            modelRequestIds,
            assistantMessageIds,
            toolCallIds
          };
        }
        if (await this.terminateIfRequested(turnId, `round:${round}:before-model-request`)) {
          return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
        }
        const idempotencyKey = `agent-loop:${turnId}:round:${round}`;
        const expectedModelRequestId = modelRequestIdFor(turnId, idempotencyKey);
        let request = await this.maybeGet('ModelRequest', expectedModelRequestId);
        if (!request) {
          // A new root must not freeze an unresolved native call: close committed results left by
          // an interrupted/failed chain (this Turn or an earlier one) before anything else lands.
          if (await this.closeNativeResultOccurrences({
            conversationId,
            turnId,
            sourcePrefix: `agent-loop:${turnId}:round:${round}:native-closure`,
            scope: endedTurnsClosed ? 'turn' : 'conversation'
          }) > 0) {
            facts = await this.readRoundFacts(turnId);
          }
          endedTurnsClosed = true;
          // Runtime input is admitted only at a new request boundary. On recovery an existing
          // request may still be waiting for its tool results; inserting runtime_context before
          // those results would split the atomic assistant-tool/result pair.
          if (await this.absorbRuntimeDeliveryInputs(turnId) > 0) {
            facts = await this.readRoundFacts(turnId);
          }
          const toolDefinitions = await this.tools.definitions(turnId);
          const recoveredCompression = await this.compressionCoordinator.readAutomaticCompressionContinuation?.({
            turnId, ordinaryRequestId: expectedModelRequestId,
            authoritySnapshotId: requireId(facts.authority.id, 'AuthoritySnapshot.id'),
            headRootId: requireId(facts.head.root_id, 'ConversationContextHeadLink.root_id')
          });
          const settingsSnapshotContentObjectId = recoveredCompression
            ? recoveredCompression.settingsSnapshotContentObjectId
            : await this.modelProvider.freezeRequestSettings(turnId, requireId(facts.authority.id, 'AuthoritySnapshot.id'));
          const recoveredRebase = recoveredCompression?.recoveryDecision
            ? recoveredCompression.nativeRebase ?? planNativeCompressionRebase({ nativeEnabled: true, updates: [] })
            : undefined;
          let frozenRecipe = await this.freezeOrdinaryRequestRecipe({
            settingsSnapshotContentObjectId,
            turnId,
            round,
            headRootId: requireId(facts.head.root_id, 'ConversationContextHeadLink.root_id'),
            authoritySnapshotId: requireId(facts.authority.id, 'AuthoritySnapshot.id'),
            tools: toolDefinitions,
            includeOpenTaskCompletionCheck,
            ...(recoveredRebase ? { nativeRebase: {
              cacheReset: recoveredRebase.cacheReset, forceFullReason: recoveredRebase.forceFullReason,
              ...(recoveredRebase.freshConfigurationUpdate ? { freshConfigurationUpdate: recoveredRebase.freshConfigurationUpdate } : {})
            } } : {})
          });
          let planning = await this.prepareOrdinaryRequestPlanning({
            turnId,
            settingsSnapshotContentObjectId,
            contextRootId: requireId(facts.head.root_id, 'ConversationContextHeadLink.root_id'),
            authoritySnapshotId: requireId(facts.authority.id, 'AuthoritySnapshot.id'),
            recipe: frozenRecipe,
            idempotencyKey
          });
          let planningBudget = planning.budget;
          // Full-request tokenization is model-independent planning data. Compression admission is
          // level-triggered by the Provider-observed Context estimate; ordinary sending is never
          // rejected solely because this heuristic estimate is high.
          let compression: CoordinateCompressionResult;
          let compressionDecision = recoveredCompression?.recoveryDecision;
          let capacityPasses = recoveredCompression?.committedCapacityPasses ?? 0;
          let hadCapacityProgress = capacityPasses > 0;
          for (;;) {
            compression = await this.compressionCoordinator.coordinate({
              turnId, ordinaryRequestId: expectedModelRequestId, settingsSnapshotContentObjectId,
              authoritySnapshotId: requireId(facts.authority.id, 'AuthoritySnapshot.id'),
              headRootId: requireId(facts.head.root_id, 'ConversationContextHeadLink.root_id'),
              trigger: 'auto', requestBudget: planningBudget,
              protectedCurrentInputTokens: currentInputReferenceTokens(frozenRecipe),
              modelHandleCatalog: normalizeModelHandleCatalog(asRecord(frozenRecipe)?.modelHandleCatalog),
              tools: toolDefinitions
            });
            if (compression.status === 'error') throw new ModelRequestPreflightError(
              compression.code, `${compression.code}: ${compression.message}`, compression.estimatedTokens, compression.limitTokens
            );
            if ((compression.status === 'compressed' || compression.status === 'continued_uncompressed')
              && compression.recoveryDecision) compressionDecision = compression.recoveryDecision;
            if (compression.status !== 'compressed') break;
            if (compression.capacityLimitedPrefix) {
              const policy = frozenCompressionPolicy(planning.compressionAuthority);
              if (!policy || !isStrictSingleSummaryPlan(policy.executionPlan)) {
                throw new Error('Capacity continuation requires the frozen strict single-summary policy.');
              }
              hadCapacityProgress = true;
              if (++capacityPasses > 32) throw new ModelRequestPreflightError('compressed_context_too_large',
                'Automatic compression exceeded its bounded continuation count.', capacityPasses, 32);
            }
            facts = await this.readRoundFacts(turnId);
            // Delivery that became model-visible while Compact was running belongs after the
            // canonical output. It is absorbed only after the new head CAS has succeeded.
            if (await this.absorbRuntimeDeliveryInputs(turnId) > 0) {
              facts = await this.readRoundFacts(turnId);
            }
            // A compression on a native turn always rebases the fresh chain; without detected
            // updates the plan carries no configuration_update but still resets the cache.
            const nativeRebasePlan = compression.nativeRebase
              ?? planNativeCompressionRebase({ nativeEnabled: true, updates: [] });
            frozenRecipe = await this.freezeOrdinaryRequestRecipe({
              settingsSnapshotContentObjectId,
              turnId,
              round,
              headRootId: requireId(facts.head.root_id, 'ConversationContextHeadLink.root_id'),
              authoritySnapshotId: requireId(facts.authority.id, 'AuthoritySnapshot.id'),
              tools: toolDefinitions,
              includeOpenTaskCompletionCheck,
              ...(nativeRebasePlan
                ? {
                    nativeRebase: {
                      cacheReset: nativeRebasePlan.cacheReset,
                      forceFullReason: nativeRebasePlan.forceFullReason,
                      ...(nativeRebasePlan.freshConfigurationUpdate
                        ? { freshConfigurationUpdate: nativeRebasePlan.freshConfigurationUpdate }
                        : {})
                    }
                  }
                : {})
            });
            planning = await this.prepareOrdinaryRequestPlanning({
              turnId,
              settingsSnapshotContentObjectId,
              contextRootId: requireId(facts.head.root_id, 'ConversationContextHeadLink.root_id'),
              authoritySnapshotId: requireId(facts.authority.id, 'AuthoritySnapshot.id'),
              recipe: frozenRecipe,
              idempotencyKey
            });
            planningBudget = planning.budget;
            if (await this.terminateIfRequested(turnId, `round:${round}:after-capacity-compression`)) {
              return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
            }
            if (!compression.capacityLimitedPrefix) break;
          }
          if (hadCapacityProgress && planningBudget.estimatedFullInputTokens > planningBudget.planningInputCapacityTokens) {
            throw new ModelRequestPreflightError('compressed_context_too_large',
              'Automatic capacity recovery did not produce a fitting ordinary request.',
              planningBudget.estimatedFullInputTokens, planningBudget.planningInputCapacityTokens);
          }
          if (compressionDecision) {
            frozenRecipe = normalizePlainJson({
              ...(frozenRecipe as { [key: string]: PlainJsonValue }), compressionDecision
            }, 'Request compression recovery decision');
          }
          if (readFrozenNativeCapabilities(requireRecord(frozenRecipe, 'Native request recipe'))) {
            const compressionPolicy = frozenCompressionPolicy(planning.compressionAuthority);
            const nativeBudget: NativeLogicalRequestBudget = {
              planningInputCapacityTokens: planningBudget.planningInputCapacityTokens,
              compressionThresholdTokens: planningBudget.compressionThresholdTokens,
              autoCompressionEnabled: compressionPolicy?.triggerMode === 'token_threshold'
                && compressionPolicy.methodKind !== 'disabled'
            };
            // Freeze the actual full-request planning budget with the recipe; a reconnected Host
            // must not derive a different safety capacity from mutable settings or a later head.
            frozenRecipe = normalizePlainJson({
              ...(frozenRecipe as { [key: string]: PlainJsonValue }),
              nativeLogicalBudget: nativeBudget
            }, 'Native logical request budget');
            if (requestSequence > 1n) {
              const previousId = modelRequestIdFor(turnId,
                `agent-loop:${turnId}:round:${(requestSequence - 1n).toString()}`);
              const previous = await this.maybeGet('ModelRequest', previousId);
              if (previous && previous.provider_id === planning.providerId && previous.model_id === planning.modelId) {
                const observed = await this.modelProvider.readNativeLatestResponseUsage(previousId);
                const previousStream = asRecord(previous.stream_stats_json);
                const sameStream = observed?.inputTokens !== undefined
                  && observed.attemptSeq === String(previousStream?.attemptSeq)
                  && observed.socketGeneration === String(previousStream?.socketGeneration);
                if (sameStream && nativeFullRequestExceedsBudget({
                  budget: nativeBudget,
                  observedPhysicalInputTokens: observed.inputTokens,
                  plannedFullInputTokens: planningBudget.estimatedFullInputTokens,
                  compression: compression.status === 'skipped'
                    ? { status: 'skipped', reason: compression.reason }
                    : { status: compression.status }
                })) {
                  // Never send a raw input that already filled the planning capacity a second
                  // time or enable a user-disabled method implicitly; the coordinator's decision
                  // (the threshold, a continue-if-fits fallback) is otherwise respected.
                  throw new NativeRequestBudgetError(observed.inputTokens!,
                    nativeBudget.planningInputCapacityTokens);
                }
              }
            }
          }
          await this.guardNativeModelSwitch(
            requireId(facts.turn.conversation_id, 'Turn.conversation_id'),
            planning.providerId,
            planning.modelId
          );
          const created = await this.modelProvider.createModelRequest({
            turnId,
            settingsSnapshotContentObjectId,
            contextRootId: requireId(facts.head.root_id, 'ConversationContextHeadLink.root_id'),
            authoritySnapshotId: requireId(facts.authority.id, 'AuthoritySnapshot.id'),
            recipe: frozenRecipe,
            projectedEstimatedTokens: planningBudget.estimatedFullInputTokens,
            idempotencyKey
          });
          if (created.modelRequestId !== expectedModelRequestId) {
            throw new Error('ModelProvider returned an unexpected stable ModelRequest identity.');
          }
          request = await this.requireExisting('ModelRequest', expectedModelRequestId);
        }
        const modelRequestRecipe = await this.assertModelRequestRound(
          request,
          requestSequence,
          expectedModelRequestId
        );
        includeOpenTaskCompletionCheck = false;
        if (recipeHasOpenTaskCompletionCheck(modelRequestRecipe)) {
          openTaskCompletionCheckConsumed = true;
        }
        const modelRequestId = expectedModelRequestId;
        modelRequestIds.push(modelRequestId);
        if (await this.terminateIfRequested(turnId, `round:${round}:model-request:${modelRequestId}`)) {
          return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
        }
        let dispatched: NormalizedProviderOutput | typeof NATIVE_CHAIN_REBASED_TERMINAL_STATE;
        if (request.status === 'terminal') {
          if (await this.recoverProviderContextOverflow(turnId, request)) {
            requestSequence += 1n;
            continue agentRounds;
          }
          dispatched = request.terminal_state === NATIVE_CHAIN_REBASED_TERMINAL_STATE
            ? NATIVE_CHAIN_REBASED_TERMINAL_STATE
            : await this.readTerminalProviderOutput(modelRequestId);
        } else {
          this.observeLifecycle({ turnId, stage: 'provider_dispatch_started', round, modelRequestId });
          try {
            dispatched = await this.dispatchAndCapture(
              requireId(facts.turn.conversation_id, 'Turn.conversation_id'),
              turnId,
              modelRequestId,
              request
            );
          } catch (error) {
            if (isExecutionHandoffError(error)) throw error;
            const failed = await this.requireExisting('ModelRequest', modelRequestId);
            if (!await this.recoverProviderContextOverflow(turnId, failed)) throw error;
            requestSequence += 1n;
            continue agentRounds;
          }
        }
        if (dispatched === NATIVE_CHAIN_REBASED_TERMINAL_STATE) {
          await this.assertNativeErrorRebaseBudget(turnId, modelRequestId);
          // The sealed chain's items, admitted calls and closed results already live in Context;
          // the Turn continues with a new full request (where queued runtime input is absorbed).
          requestSequence += 1n;
          continue agentRounds;
        }
        const output = dispatched;
        this.observeLifecycle({ turnId, stage: 'provider_output_ready', round, modelRequestId });
        if (await this.terminateIfRequested(turnId, `round:${round}:provider-output:${modelRequestId}`)) {
          return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
        }
        const openTaskCompletion = decideOpenTaskCompletion(
          modelRequestRecipe,
          openTaskCompletionCheckConsumed
        );
        const shouldContinueOpenTasks = output.toolCalls.length === 0
          && openTaskCompletion === 'continue_once';
        if (output.toolCalls.length === 0 && !shouldContinueOpenTasks) {
          const fence = await this.automaticDeliveries.establishFinalOutputFence({ turnId, modelRequestId });
          if (!fence.established) {
            if (await this.absorbRuntimeDeliveryInputs(turnId) > 0) {
              requestSequence += 1n;
              continue agentRounds;
            }
            const latestTurn = await this.requireExisting('Turn', turnId);
            if (latestTurn.status !== 'active') {
              return {
                turnId,
                terminalStatus: await this.readLoopTerminalStatus(turnId, latestTurn),
                modelRequestIds,
                assistantMessageIds,
                toolCallIds
              };
            }
            throw new Error(`Turn ${turnId} could not establish final-output authority.`);
          }
          if (await this.terminateIfRequested(turnId, `round:${round}:final-output-fenced:${modelRequestId}`)) {
            return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
          }
        }
        this.observeLifecycle({ turnId, stage: 'assistant_commit_started', round, modelRequestId });
        const nativeCapabilities = readFrozenNativeCapabilities(modelRequestRecipe);
        const message = nativeCapabilities
          ? await this.turnOutput.appendNativeAssistantAggregate({
              turnId,
              modelRequestId,
              content: JSON.stringify(providerOutputMessage(output)),
              contentType: MESSAGE_CONTENT_TYPE
            })
          : await this.turnOutput.appendAssistantMessage({
              turnId,
              modelRequestId,
              sourceKey: modelRequestId,
              content: JSON.stringify(providerOutputMessage(output)),
              contentType: MESSAGE_CONTENT_TYPE
            });
        assistantMessageIds.push(message.messageId);
        this.observeLifecycle({ turnId, stage: 'assistant_commit_completed', round, modelRequestId });
        if (shouldContinueOpenTasks) {
          // This visible output remains an in-progress assistant message. The next frozen recipe owns
          // the one durable completion-check marker, so crash recovery cannot create an endless loop.
          openTaskCompletionCheckConsumed = true;
          includeOpenTaskCompletionCheck = true;
          requestSequence += 1n;
          continue agentRounds;
        }

        if (output.toolCalls.length === 0) {
          // The final-output fence was committed before this visible Message. Automatic runtime
          // input must now target a new Turn; extending this Turn would rewrite a displayed final.
          for (;;) {
            if (await this.terminateIfRequested(turnId, `round:${round}:before-complete:${modelRequestId}`)) {
              return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
            }
            // Like the native path: a stop observed first means this Turn publishes no answer.
            await this.notifyFinalOutput(turnId, modelRequestId, providerOutputMessage(output));
            this.observeLifecycle({ turnId, stage: 'turn_terminal_started', round, modelRequestId });
            try {
              await this.turns.terminal({
                source: { kind: 'internal', key: `agent-loop:${turnId}:complete:${modelRequestId}` },
                turnId,
                terminalStatus: 'completed',
                reason: openTaskCompletion === 'complete_with_open_tasks'
                  ? 'model_completed_with_open_tasks'
                  : 'model_completed_without_tool_calls'
              });
            } catch (error) {
              if (isTurnTerminalInputConflictError(error)) {
                if (await this.terminateIfRequested(turnId, `round:${round}:final-output-fenced:${modelRequestId}`)) {
                  return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
                }
                throw new Error(
                  `Runtime input crossed final-output fence for Turn ${turnId}: ${errorMessage(error)}`
                );
              }
              throw error;
            }
            this.observeLifecycle({ turnId, stage: 'turn_terminal_completed', round, modelRequestId });
            this.observeOpenTasksAtFinal(turnId, round, modelRequestId, modelRequestRecipe);
            const terminalTurn = await this.requireExisting('Turn', turnId);
            return {
              turnId,
              terminalStatus: await this.readLoopTerminalStatus(turnId, terminalTurn),
              modelRequestIds,
              assistantMessageIds,
              toolCallIds
            };
          }
        }

        const batch = await this.prepareProviderToolBatch({
          turnId,
          modelRequestId,
          messageId: message.messageId,
          output,
          recipe: modelRequestRecipe
        });
        toolCallIds.push(...batch.map((call) => call.toolCallId));
        if (await this.terminateIfRequested(
          turnId,
          `round:${round}:created-tool-batch`,
          batch[0]?.toolCallId
        )) {
          return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
        }
        const batchDispatch = nativeCapabilities
          ? await this.dispatchNativeToolBatch({
              conversationId: requireId(facts.turn.conversation_id, 'Turn.conversation_id'),
              turnId,
              round,
              modelRequestId,
              calls: batch
            })
          : await this.dispatchProviderToolBatch({
              conversationId: requireId(facts.turn.conversation_id, 'Turn.conversation_id'),
              turnId,
              round,
              modelRequestId,
              calls: batch
            });
        if (batchDispatch.status === 'interrupted') {
          return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
        }
        if (batchDispatch.status === 'waiting') {
          return {
            turnId,
            terminalStatus: 'waiting',
            modelRequestIds,
            assistantMessageIds,
            toolCallIds,
            waitingToolCallId: batchDispatch.toolCallId
          };
        }
        if (await this.completeForQueuedBoundaryInput({
          turnId,
          conversationId: requireId(facts.turn.conversation_id, 'Turn.conversation_id'),
          round,
          modelRequestId
        })) {
          const terminalTurn = await this.requireExisting('Turn', turnId);
          return {
            turnId,
            terminalStatus: await this.readLoopTerminalStatus(turnId, terminalTurn),
            modelRequestIds,
            assistantMessageIds,
            toolCallIds
          };
        }
        // A native logical ModelRequest that delivered every call's result and received final
        // successor text is complete: the aggregate is the final answer, never a new legacy round.
        // Undelivered (HTTP-pending or unadmitted) calls still continue with a carrier request.
        if (nativeCapabilities && await this.nativeLogicalRequestDeliveredAll(batch)) {
          const fence = await this.automaticDeliveries.establishFinalOutputFence({ turnId, modelRequestId });
          if (!fence.established) {
            if (await this.absorbRuntimeDeliveryInputs(turnId) > 0) {
              requestSequence += 1n;
              continue agentRounds;
            }
            const latestTurn = await this.requireExisting('Turn', turnId);
            if (latestTurn.status !== 'active') {
              return {
                turnId,
                terminalStatus: await this.readLoopTerminalStatus(turnId, latestTurn),
                modelRequestIds,
                assistantMessageIds,
                toolCallIds
              };
            }
            throw new Error(`Turn ${turnId} could not establish final-output authority.`);
          }
          if (await this.terminateIfRequested(turnId, `round:${round}:native-final-output-fenced:${modelRequestId}`)) {
            return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
          }
          await this.notifyFinalOutput(turnId, modelRequestId, providerOutputMessage(output));
          this.observeLifecycle({ turnId, stage: 'turn_terminal_started', round, modelRequestId });
          try {
            await this.turns.terminal({
              source: { kind: 'internal', key: `agent-loop:${turnId}:complete-native:${modelRequestId}` },
              turnId,
              terminalStatus: 'completed',
              reason: 'native_logical_request_completed'
            });
          } catch (error) {
            if (isTurnTerminalInputConflictError(error)) {
              if (await this.terminateIfRequested(turnId, `round:${round}:native-final-output-fenced:${modelRequestId}`)) {
                return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
              }
              throw new Error(
                `Runtime input crossed final-output fence for Turn ${turnId}: ${errorMessage(error)}`
              );
            }
            throw error;
          }
          this.observeLifecycle({ turnId, stage: 'turn_terminal_completed', round, modelRequestId });
          const terminalTurn = await this.requireExisting('Turn', turnId);
          return {
            turnId,
            terminalStatus: await this.readLoopTerminalStatus(turnId, terminalTurn),
            modelRequestIds,
            assistantMessageIds,
            toolCallIds
          };
        }
        requestSequence += 1n;
      }
    } catch (error) {
      if ((error as { code?: string }).code === 'MODEL_CONTEXT_HANDLE_UPGRADE_PENDING') {
        if (await this.terminateIfRequested(turnId, 'context-handle-upgrade-wait')) {
          return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
        }
        return { turnId, terminalStatus: 'waiting', modelRequestIds, assistantMessageIds, toolCallIds,
          waitingContextHandleUpgrade: true };
      }
      if ((error as { code?: string }).code === 'MODEL_CONTEXT_HANDLE_FRONTIER_CHANGED') throw error;
      if (error instanceof NativeSafetyWaitError) {
        if (await this.terminateIfRequested(turnId, 'native-safety-wait')) {
          return { turnId, terminalStatus: 'interrupted', modelRequestIds, assistantMessageIds, toolCallIds };
        }
        // An ambiguous wire result cannot be resent, but this already-admitted external tool
        // must not be cancelled merely to turn a pending Turn into a failure. The durable
        // dispatcher/runner wakes the same Turn after settlement, then refusal can close it.
        return {
          turnId, terminalStatus: 'waiting', modelRequestIds, assistantMessageIds,
          toolCallIds, waitingToolCallId: error.toolCallId
        };
      }
      // Host shutdown / lease replacement is a recoverable transport handoff. Recording a failed
      // Turn here would destroy the exact durable frontier the next Host needs to resume.
      if (isExecutionHandoffError(error)) throw error;
      // Local contention/resource pressure is not a model failure. Preserve the durable frontier
      // for the bounded, cancellation-aware replay above; unknown/invariant errors fail closed.
      if (allowLocalRetry && isRetryableLocalExecutionError(error)) throw error;
      let interruptionCheckError: unknown;
      try {
        if (await this.terminateIfRequested(turnId, 'drive-interrupted')) {
          const terminalTurn = await this.requireExisting('Turn', turnId);
          return {
            turnId,
            terminalStatus: await this.readLoopTerminalStatus(turnId, terminalTurn),
            modelRequestIds,
            assistantMessageIds,
            toolCallIds
          };
        }
      } catch (checkError) {
        interruptionCheckError = checkError;
      }
      // A durable interrupt wins over the transport AbortError that it deliberately caused. Only a
      // genuine unrequested failure is allowed to enter the drive_failed terminal path.
      this.observeLifecycle({ turnId, stage: 'drive_failed', ...errorDiagnostic(error) });
      try {
        if (interruptionCheckError !== undefined) throw interruptionCheckError;
        this.observeLifecycle({ turnId, stage: 'failure_terminal_started' });
        if (!await this.terminateIfRequested(turnId, 'drive-failed')) {
          const latestModelRequestId = modelRequestIds[modelRequestIds.length - 1];
          const partialMessageId = await this.materializeFailedPartialOutput(turnId, latestModelRequestId);
          if (partialMessageId && !assistantMessageIds.includes(partialMessageId)) {
            assistantMessageIds.push(partialMessageId);
          }
          await this.failActiveTurn(turnId, error);
        }
        this.observeLifecycle({ turnId, stage: 'failure_terminal_completed' });
      } catch (terminalError) {
        this.observeLifecycle({ turnId, stage: 'failure_terminal_failed', ...errorDiagnostic(terminalError) });
        const combined = new Error(`Reliable Agent Turn ${turnId} failed and could not record terminal state.`) as Error & {
          originalError?: unknown;
          terminalError?: unknown;
        };
        combined.originalError = error;
        combined.terminalError = terminalError;
        throw combined;
      }
      const terminalTurn = await this.requireExisting('Turn', turnId);
      return {
        turnId,
        terminalStatus: await this.readLoopTerminalStatus(turnId, terminalTurn),
        modelRequestIds,
        assistantMessageIds,
        toolCallIds
      };
    }
  }

  /**
   * The full preview is needed only for provider-aligned planning. Return its small continuation
   * facts before awaiting compression, so the old full Context is not retained alongside the
   * coordinator's materialized source and the compression Provider's separately built request.
   */
  private async prepareOrdinaryRequestPlanning(
    command: Parameters<ModelProviderControlPlane['previewOrdinaryRequest']>[0]
  ): Promise<OrdinaryRequestPlanningFacts> {
    const preview = await this.modelProvider.previewOrdinaryRequest(command);
    const adapter = await this.providers.resolve(preview.providerId);
    if (adapter.providerId !== preview.providerId) {
      throw new Error(`Provider registry returned ${adapter.providerId} for ${preview.providerId}.`);
    }
    const budget = this.modelProvider.planFullRequest(preview, adapter);
    const compression = asRecord(preview.authoritySnapshot)?.compression;
    return {
      providerId: preview.providerId,
      modelId: preview.modelId,
      // Keep policy parsing in its original conditional branches: an unused malformed policy
      // must not introduce a new eager error or retain the rest of the Authority/preview graph.
      compressionAuthority: compression === undefined ? null : { compression: compression as PlainJsonValue },
      budget
    };
  }

  private async freezeOrdinaryRequestRecipe(input: {
    settingsSnapshotContentObjectId?: string;
    turnId: string;
    round: string;
    headRootId: string;
    authoritySnapshotId: string;
    tools: readonly ReliableAgentToolDefinition[];
    includeOpenTaskCompletionCheck: boolean;
    /** Outcome of a just-committed native compression rebase, frozen into the successor request. */
    nativeRebase?: {
      cacheReset?: boolean;
      forceFullReason?: 'compression';
      freshConfigurationUpdate?: { effort: string };
    };
  }): Promise<PlainJsonValue> {
    const [runtimeStatus, turnTaskCard, previousTaskCard] = await Promise.all([
      this.readRuntimeStatusCard(input.turnId),
      readCurrentTurnTaskCard(this.database, input.turnId),
      this.readPreviousTaskCardReminderStateForRound(input.turnId, input.round)
    ]);
    const runtimeStatusCard = runtimeStatus.statusCard;
    // One validated immutable root supplies both input membership and provider-visible bytes.
    // Wait for the independent metadata first so a slow historical read cannot retain this body.
    const { structure, content: materialized } = await this.context.materializeWithStructure(
      requireId(input.headRootId, 'headRootId')
    );
    const [currentTurnState, nativeFreeze] = await Promise.all([
      this.readCurrentTurnInputReference(input.turnId, structure),
      this.readNativeRecipeFreeze({ ...input, scopeReset: runtimeStatus.requiresNativeReset, structure })
    ]);
    const conversationId = requireId(materialized.root.conversation_id, 'ContextSequenceRoot.conversation_id');
    const attachmentCatalogState = await this.modelProvider.projectAttachmentCatalogState(
      conversationId,
      materialized.segments.map((segment) => ({ segmentId: segment.segmentId })),
      currentTurnState.reference ? [currentTurnState.reference.messageRevisionId] : []
    );
    const attachmentHandles = await this.modelProvider.ensureAttachmentHandles(
      conversationId,
      attachmentCatalogState.catalog
    );
    const contextInputSources: unknown[] = materialized.segments.map((segment) => Buffer.from(segment.content).toString('utf8'));
    const handleSources: unknown[] = [
      ...contextInputSources,
      attachmentCatalogState.catalog,
      ...(runtimeStatusCard ? [runtimeStatusCard] : []),
      input.tools
    ];
    if (currentTurnState.reference) {
      const inputContentObject = await this.requireExisting(
        'ContentObject',
        currentTurnState.reference.contentObjectId
      ) as unknown as ContentObjectMetadata;
      const inputContent = (await this.contentStore.read(inputContentObject)).toString('utf8');
      handleSources.push(inputContent);
      if (currentTurnState.reference.reinject) contextInputSources.push(inputContent);
    }
    const seeds = mergeModelHandleCatalogs(attachmentHandles, runtimeStatus.contextHandles);
    let modelHandleCatalog = buildModelHandleCatalog(handleSources, seeds);
    const forkIdentity = runtimeStatus.forkIdentity;
    const inheritedCollaboration = forkIdentity ? forkInheritedCollaborationTargets(modelHandleCatalog, forkIdentity) : undefined;
    if (forkIdentity && inheritedCollaboration) {
      // The fork's own address joins the catalog so the model can tell itself from its sources.
      modelHandleCatalog = buildModelHandleCatalog([...handleSources, { kind: 'agent_collaboration', conversationId: forkIdentity.conversationId }], seeds);
    }
    // Raw user/tool JSON is not an attachment registry. It may mention a canonical Attachment
    // outside the visible catalog, but cannot mint an F address or change a reserved one.
    const attachmentRefs = new Map(attachmentHandles.entries.map(entry => [entry.target, entry.ref]));
    modelHandleCatalog = { ...modelHandleCatalog, entries: modelHandleCatalog.entries.filter(entry =>
      entry.kind !== 'attachment' || attachmentRefs.get(entry.target) === entry.ref) };
    // Share one immutable lookup for this operation; keep the plain catalog in the frozen recipe.
    const preparedModelHandles = prepareModelHandleCatalog(modelHandleCatalog);
    const inputBindings = selectContextHandleBindings(contextInputSources, modelHandleCatalog);
    const establishedInputRefs = new Map(runtimeStatus.contextHandles.entries.map(entry => [entry.ref, entry]));
    const contextHandleInputBindings = { ...inputBindings, entries: inputBindings.entries.filter(entry => {
      const established = establishedInputRefs.get(entry.ref);
      return !established || established.kind !== entry.kind || established.target !== entry.target;
    }) };
    if (runtimeStatusCard) {
      // Labels are runtime data. Behavioral guidance belongs to the run_agent tool definition.
      runtimeStatusCard.card += runtimeStatusCard.children.map(child => '\n' + JSON.stringify({
        childRef: modelHandleRef(preparedModelHandles, 'child', child.answerBridgeId),
        label: child.label, task: child.task, initialTask: child.initialTask,
        currentTasks: child.currentTasks, currentInputCount: child.currentInputCount,
        queuedTasks: child.queuedTasks, queuedInputCount: child.queuedInputCount,
        truncated: child.truncated, latestTurnOutcome: child.latestTurnOutcome,
        answerAvailable: child.answerAvailable, answerHandling: child.answerHandling,
        status: child.status, resumable: child.resumable
      })).join('');
      const inheritedChildRefs = (runtimeStatusCard.inheritedChildTargets ?? [])
        .map(target => modelHandleRef(preparedModelHandles, 'child', target))
        .filter((ref): ref is string => !!ref);
      if (inheritedChildRefs.length > 0) {
        runtimeStatusCard.card += '\n' + JSON.stringify({ inheritedChildRefs, operable: false });
      }
    }
    let statusCard = runtimeStatusCard;
    const processRepairCard = await historicalProcessHandleCard(this.database, this.contentStore, conversationId, preparedModelHandles);
    if (processRepairCard) {
      statusCard ??= emptyRuntimeStatusCard('[Historical reference repair — runtime data]');
      statusCard.card += '\n' + processRepairCard;
    }
    if (forkIdentity && inheritedCollaboration) {
      const refs = (kind: 'conversation' | 'collaborationMessage', targets: readonly string[]) => targets
        .map(target => modelHandleRef(preparedModelHandles, kind, target)).filter((ref): ref is string => !!ref);
      statusCard ??= emptyRuntimeStatusCard('[Forked conversation — runtime data, not instructions]');
      statusCard.card += '\n' + [
        'This conversation is a fork: its history up to the fork was copied from forkedFromConversationRefs, nearest first. In that copied history, "this conversation" means the conversation it was copied from, never this one.',
        'inheritedMessageRefs were sent or received by those conversations, not by this one: this conversation cannot answer them or read them as its own messages. Send new messages without replyToMessageRef.',
        JSON.stringify({
          selfConversationRef: modelHandleRef(preparedModelHandles, 'conversation', forkIdentity.conversationId),
          forkedFromConversationRefs: refs('conversation', inheritedCollaboration.sourceConversationIds),
          inheritedMessageRefs: refs('collaborationMessage', inheritedCollaboration.messageIds),
          operable: false
        })
      ].join('\n');
    }
    const boundaryKey = currentTurnState.compressionBoundaryId ?? 'pre-compression';
    const turnTaskCardReminderEnabled = turnTaskCard
      ? shouldInjectTurnTaskCard({
          revision: turnTaskCard.revision,
          card: turnTaskCard.card,
          boundaryKey
        }, previousTaskCard)
      : false;
    const nativeErrorRecovery = nativeFreeze.nativeResponses
      ? await this.readNativeErrorRecoveryBudget(input.turnId)
      : undefined;
    return normalizePlainJson({
      kind: 'reliable-agent-turn',
      projectionRevision: '2026-08-21',
      round: input.round,
      tools: input.tools,
      attachmentCatalogState,
      modelHandleCatalog,
      contextHandleScope: runtimeStatus.contextHandleScope,
      ...(contextHandleInputBindings.entries.length ? { contextHandleInputBindings } : {}),
      ...(currentTurnState.reference ? { currentTurnInput: currentTurnState.reference } : {}),
      ...(turnTaskCard ? {
        turnTaskCard,
        turnTaskCardBoundaryKey: boundaryKey,
        turnTaskCardReminderEnabled
      } : {}),
      ...(statusCard ? { runtimeStatusCard: statusCard } : {}),
      ...(input.includeOpenTaskCompletionCheck ? {
        openTaskCompletionCheck: {
          kind: OPEN_TASK_COMPLETION_CHECK_KIND,
          card: OPEN_TASK_COMPLETION_CHECK_CARD
        }
      } : {}),
      ...(nativeFreeze.turnReminderDelivery ? { turnReminderDelivery: nativeFreeze.turnReminderDelivery } : {}),
      ...(nativeFreeze.nativeResponses ? { nativeResponses: nativeFreeze.nativeResponses } : {}),
      ...(nativeErrorRecovery && nativeErrorRecovery.failures > 0 ? { nativeErrorRecovery } : {}),
      ...(nativeFreeze.nativeReasoning || (nativeFreeze.nativeResponses && runtimeStatus.requiresNativeReset)
        ? { nativeReasoning: {
            ...nativeFreeze.nativeReasoning,
            ...(nativeFreeze.nativeResponses && runtimeStatus.requiresNativeReset
              ? { resetCache: true, forceFullReason: 'context_handle_identity_repair' } : {})
          } } : {})
    }, 'Reliable Agent recipe');
  }

  /**
   * Freezes the GPT-6 native decision and reasoning facts into the ordinary recipe so recovery
   * replays byte-identical behavior. Capability inputs come from the frozen Turn authority (never
   * live settings). The base stays stable on a compatible lineage; effort changes become pending
   * configuration updates. Mode/model/provider changes and compression rebase discard stale updates.
   * The same frozen authority also records how this request sends its reminders: only requests sent
   * as Claude turn-scoped system messages are later re-sent verbatim in the history.
   */
  private async readNativeRecipeFreeze(input: {
    settingsSnapshotContentObjectId?: string;
    turnId: string;
    round: string;
    authoritySnapshotId: string;
    headRootId: string;
    scopeReset?: boolean;
    structure?: MaterializedContextStructure;
    nativeRebase?: {
      cacheReset?: boolean;
      forceFullReason?: 'compression';
      freshConfigurationUpdate?: { effort: string };
    };
  }): Promise<{
    turnReminderDelivery?: typeof CLAUDE_TURN_SCOPED_REMINDER_DELIVERY;
    nativeResponses?: OpenAIResponsesNativeCapabilities;
    nativeReasoning?: {
      baseEffort?: string;
      baseMode?: 'standard' | 'pro';
      updates: ReadonlyArray<{ effort: string }>;
      effectiveEffort?: string;
      resetCache?: boolean;
      forceFullReason?: 'compression' | 'thinking_defaults_restored';
      pendingConfigurationUpdate?: { effort: string };
    };
  }> {
    const frozen = await readRequestTurnAuthority(
      this.database,
      this.contentStore,
      requireId(input.authoritySnapshotId, 'authoritySnapshotId'),
      requireId(input.turnId, 'turnId'),
      input.settingsSnapshotContentObjectId
    );
    const delivery = claudeTurnScopedRemindersEnabled(frozen.document)
      ? { turnReminderDelivery: CLAUDE_TURN_SCOPED_REMINDER_DELIVERY }
      : {};
    const documentModel = asRecord(frozen.document)?.model;
    const modelRecord = asRecord(documentModel);
    const thinking = asRecord(modelRecord?.thinkingConfig);
    const capabilities = openAIResponsesNativeCapabilities({
      provider: modelRecord?.provider as LlmProviderKind | undefined,
      model: typeof modelRecord?.modelId === 'string' ? modelRecord.modelId : undefined,
      baseUrl: typeof modelRecord?.baseUrl === 'string' ? modelRecord.baseUrl : undefined,
      transport: modelRecord?.openaiResponsesTransport as LlmOpenAIResponsesTransport | undefined,
      nativeResponses: normalizeOpenAIResponsesNativeSettings(modelRecord?.nativeResponses),
      ...(typeof thinking?.reasoningMode === 'string' ? { reasoningMode: thinking.reasoningMode } : {})
    });
    if (!capabilities.asyncTools && !capabilities.steering && !capabilities.reasoningUpdates) {
      return delivery;
    }
    const configuredEffort = typeof thinking?.thinkingLevel === 'string' && thinking.thinkingLevel !== 'not-set' && thinking.thinkingLevel !== 'non-set'
      ? thinking.thinkingLevel
      : undefined;
    const configuredMode = thinking?.reasoningMode === 'standard' || thinking?.reasoningMode === 'pro'
      ? thinking.reasoningMode
      : undefined;
    // The base request reasoning stays stable across the conversation's native chains; a changed
    // configured effort is bridged by exactly one new configuration_update (never adjacent), and a
    // changed reasoning mode resets the base because updates carry effort only. The previous
    // pending update counts as applied by its own request.
    let baseEffort = configuredEffort;
    let baseMode: 'standard' | 'pro' | undefined = configuredMode;
    let carriedUpdates: ReadonlyArray<{ effort: string }> = [];
    const compressionRebase = input.nativeRebase?.forceFullReason === 'compression';
    // Compression records an older request's effective effort. It is not an authority for this
    // newly frozen request: restore-to-omission clears it, and an explicit new choice replaces it.
    let pendingConfigurationUpdate = !input.scopeReset && capabilities.reasoningUpdates
      && input.nativeRebase?.freshConfigurationUpdate && configuredEffort !== undefined
      ? { effort: configuredEffort }
      : undefined;
    const previous = !input.scopeReset && capabilities.reasoningUpdates
      ? await this.readLatestNativeReasoning(
          requireId((await this.requireExisting('Turn', input.turnId)).conversation_id, 'Turn.conversation_id'),
          input.headRootId,
          requireId(modelRecord?.providerConfigId, 'native model.providerConfigId'),
          requireId(modelRecord?.modelId, 'native model.modelId'), input.structure
        )
      : undefined;
    const restoreDefaults = previous !== undefined && configuredEffort === undefined && previous.effectiveEffort !== undefined;
    if (previous && !restoreDefaults && !compressionRebase) {
      const appliedUpdates = [
        ...previous.updates,
        ...(previous.pendingConfigurationUpdate ? [previous.pendingConfigurationUpdate] : [])
      ];
      if (previous.baseMode !== configuredMode) {
        carriedUpdates = [];
      } else {
        baseEffort = previous.baseEffort ?? configuredEffort;
        baseMode = previous.baseMode ?? configuredMode;
        carriedUpdates = appliedUpdates;
        const previousEffective = previous.effectiveEffort
          ?? appliedUpdates[appliedUpdates.length - 1]?.effort
          ?? previous.baseEffort;
        if (
          !pendingConfigurationUpdate
          && configuredEffort !== undefined
          && configuredEffort !== previousEffective
        ) {
          pendingConfigurationUpdate = { effort: configuredEffort };
        }
      }
    }
    if (input.nativeRebase?.forceFullReason === 'compression') carriedUpdates = [];
    const effectiveEffort = pendingConfigurationUpdate?.effort
      ?? configuredEffort
      ?? carriedUpdates[carriedUpdates.length - 1]?.effort
      ?? baseEffort;
    return {
      ...delivery,
      nativeResponses: capabilities,
      nativeReasoning: {
        ...(restoreDefaults ? { resetCache: true, forceFullReason: 'thinking_defaults_restored' as const } : {}),
        ...(baseEffort ? { baseEffort } : {}),
        ...(baseMode ? { baseMode } : {}),
        updates: carriedUpdates,
        ...(effectiveEffort ? { effectiveEffort } : {}),
        ...(input.nativeRebase?.cacheReset === true ? { resetCache: true } : {}),
        ...(input.nativeRebase?.forceFullReason === 'compression' ? { forceFullReason: 'compression' as const } : {}),
        ...(pendingConfigurationUpdate ? { pendingConfigurationUpdate } : {})
      }
    };
  }

  /**
   * Reads the newest ordinary request on the compatible model/provider lineage. A non-native or
   * different model/provider request ends that lineage; older native choices cannot leak across it.
   */
  private async readLatestNativeReasoning(
    conversationId: string,
    rootId: string,
    providerId: string,
    modelId: string,
    knownStructure?: MaterializedContextStructure
  ): Promise<{
    baseEffort?: string;
    baseMode?: 'standard' | 'pro';
    updates: ReadonlyArray<{ effort: string }>;
    effectiveEffort?: string;
    pendingConfigurationUpdate?: { effort: string };
  } | undefined> {
    const structure = knownStructure ?? await this.context.materializeStructure(rootId);
    if (structure.root.id !== rootId) throw new Error('Native reasoning predecessor snapshot names another root.');
    if (structure.root.conversation_id !== conversationId) throw new Error('Native reasoning predecessor belongs to another Context scope.');
    for (let index = structure.records.length - 1; index >= 0; index--) {
      const segment = structure.records[index].segment;
      if (segment.segment_kind === 'compression') return undefined;
      if (segment.segment_kind !== 'message' && segment.segment_kind !== 'tool_pair') continue;
      const sources = await this.list('ContextSegmentSource', { segment_id: requireId(segment.id, 'Context segment id') }, 32);
      const requestIds = new Set<string>();
      for (const source of sources) {
        if (source.source_kind === 'message_revision') {
          const revision = await this.maybeGet('MessageRevision', requireId(source.source_id, 'Context Message revision'));
          if (!revision || revision.role !== 'model' || revision.revision_seq !== source.source_revision
            || revision.content_object_id !== segment.content_object_id) continue;
          const links = await this.list('ModelRequestMessageLink', { message_id: revision.message_id }, 2);
          for (const link of links) requestIds.add(requireId(link.model_request_id, 'Model output request'));
        } else if (source.source_kind === 'tool_call' || source.source_kind === 'tool_model_result') {
          const result = source.source_kind === 'tool_model_result'
            ? await this.maybeGet('ToolModelResult', requireId(source.source_id, 'Context tool result')) : null;
          if (source.source_kind === 'tool_model_result' && !result) continue;
          const toolCallId = requireId(result?.tool_call_id ?? source.source_id, 'Context tool call');
          for (const link of await this.list('ToolCallSourceLink', { tool_call_id: toolCallId }, 2)) {
            requestIds.add(requireId(link.model_request_id, 'Tool source request'));
          }
        }
      }
      const requests: DomainRow[] = [];
      for (const requestId of requestIds) {
        const request = await this.maybeGet('ModelRequest', requestId);
        if (request && (await this.maybeGet('Turn', requireId(request.turn_id, 'ModelRequest Turn')))?.conversation_id === conversationId) {
          requests.push(request);
        }
      }
      if (requests.length > 1) throw new Error('Native reasoning occurrence has multiple scoped producer requests.');
      for (const request of requests) {
        const recipe = (await this.readModelRequestRecipes([request])).get(requireId(request.id, 'ModelRequest.id'));
        if (!recipe || recipe.kind !== 'reliable-agent-turn') continue;
        if (request.provider_id !== providerId || request.model_id !== modelId
          || asRecord(recipe.nativeResponses) === undefined) return undefined;
        const reasoning = asRecord(recipe.nativeReasoning);
        if (!reasoning) return undefined;
        const updates = Array.isArray(reasoning.updates)
          ? reasoning.updates
              .map((entry) => asRecord(entry))
              .filter((entry): entry is Record<string, unknown> => entry !== undefined && typeof entry.effort === 'string')
              .map((entry) => ({ effort: entry.effort as string }))
          : [];
        const pending = asRecord(reasoning.pendingConfigurationUpdate);
        return {
          ...(typeof reasoning.baseEffort === 'string' ? { baseEffort: reasoning.baseEffort } : {}),
          ...(reasoning.baseMode === 'standard' || reasoning.baseMode === 'pro'
            ? { baseMode: reasoning.baseMode }
            : {}),
          updates,
          ...(typeof reasoning.effectiveEffort === 'string' ? { effectiveEffort: reasoning.effectiveEffort } : {}),
          ...(pending && typeof pending.effort === 'string'
            ? { pendingConfigurationUpdate: { effort: pending.effort } }
            : {})
        };
      }
    }
    return undefined;
  }

  private async readPreviousTaskCardReminderStateForRound(
    turnId: string,
    round: string
  ): Promise<TurnTaskCardReminderState | undefined> {
    const currentRound = requirePositiveInteger(round, 'ModelRequest recipe.round');
    if (currentRound <= 1n) return undefined;
    const previousId = modelRequestIdFor(
      turnId,
      `agent-loop:${turnId}:round:${(currentRound - 1n).toString()}`
    );
    const previousRequest = await this.maybeGet('ModelRequest', previousId);
    if (!previousRequest) return undefined;
    const recipe = (await this.readModelRequestRecipes([previousRequest])).get(previousId);
    if (!recipe || recipe.kind !== 'reliable-agent-turn') return undefined;
    const task = asRecord(recipe.turnTaskCard);
    const revision = typeof task?.revision === 'string' ? task.revision : undefined;
    const card = typeof task?.card === 'string' ? task.card : undefined;
    const boundaryKey = typeof recipe.turnTaskCardBoundaryKey === 'string'
      ? recipe.turnTaskCardBoundaryKey
      : 'pre-compression';
    if (!revision || card === undefined) return undefined;
    return { revision, card, boundaryKey };
  }

  private async readCurrentTurnInputReference(
    turnId: string,
    current: MaterializedContextStructure
  ): Promise<CurrentTurnRequestState> {
    const firstSegment = current.records[0]?.segment;
    const compressionBoundaryId = firstSegment?.segment_kind === 'compression'
      ? requireId(firstSegment.id, 'ContextSegment.id')
      : undefined;
    const inputLinks = await this.list('MessageTurnLink', { turn_id: turnId, role: 'input' }, 2);
    if (inputLinks.length === 0) return { compressionBoundaryId, structure: current };
    if (inputLinks.length !== 1) throw new Error(`Turn ${turnId} must have at most one input Message.`);
    const messageId = requireId(inputLinks[0].message_id, 'MessageTurnLink.message_id');
    const currentLinks = await this.list('MessageCurrentRevisionLink', { message_id: messageId }, 2);
    if (currentLinks.length !== 1) throw new Error(`Input Message ${messageId} must have one current revision.`);
    const messageRevisionId = requireId(
      currentLinks[0].revision_id,
      'MessageCurrentRevisionLink.revision_id'
    );
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('MessageRevision').get(messageRevisionId),
      DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
        where: { source_kind: 'message_revision', source_id: messageRevisionId }, limit: 8
      })
    ]);
    const revision = requireRow(snapshot.snapshot[0], `MessageRevision ${messageRevisionId}`);
    if (revision.message_id !== messageId || revision.role !== 'user') {
      throw new Error(`Current input revision ${messageRevisionId} conflicts with Turn ${turnId}.`);
    }
    const sources = rows(snapshot.snapshot[1]);
    const currentSegmentIds = new Set(current.records.map((record) =>
      requireId(record.segment.id, 'ContextSegment.id')
    ));
    const presentInCurrentWindow = sources.some((source) =>
      currentSegmentIds.has(requireId(source.segment_id, 'ContextSegmentSource.segment_id'))
    );
    const contentObjectId = requireId(revision.content_object_id, 'MessageRevision.content_object_id');
    const contentObject = await this.requireExisting('ContentObject', contentObjectId) as unknown as ContentObjectMetadata;
    const content = await this.contentStore.read(contentObject);
    return {
      structure: current,
      ...(compressionBoundaryId ? { compressionBoundaryId } : {}),
      reference: {
        kind: 'current_turn_input',
        messageId,
        messageRevisionId,
        contentObjectId,
        estimatedTokens: estimateStoredMessageContentTokens(content, contentObject.content_type),
        reinject: !presentInCurrentWindow
      }
    };
  }

  private async readRuntimeStatusCard(turnId: string): Promise<{
    statusCard?: FrozenRuntimeStatusCard;
    /** Complete identity state, including retired addresses, frozen into the next request. */
    contextHandles: ModelHandleCatalog;
    requiresNativeReset: boolean;
    contextHandleScope: { conversationId: string; rootId: string | null; provenanceRevision: string; resetFence: string };
    /** For a fork: what copied collaboration refs mean here, read once for the recipe. */
    forkIdentity?: ForkIdentityFacts;
  }> {
    const turn = await this.requireExisting('Turn', turnId);
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    const [projection, processLinks, handleState, fork] = await Promise.all([
      readConversationChildTaskRuntimeStatus(this.database, this.contentStore, conversationId, RUNTIME_STATUS_RECIPE_LIMIT),
      listAllDomainRows(this.database, 'ProcessCompletionSourceLink', { source_turn_id: turnId }),
      readCurrentConversationContextHandleState(this.database, this.contentStore, conversationId),
      isForkConversation(this.database, conversationId)
    ]);
    const contextHandleScope = { conversationId, rootId: handleState.row.context_root_id as string | null,
      provenanceRevision: String(handleState.row.provenance_revision), resetFence: String(handleState.row.requires_native_reset) };
    const inheritedChildTargets = fork
      ? forkInheritedChildTargets(handleState.catalog.entries, new Set(projection.childHandleTargets.map(task => task.answerBridgeId)))
      : [];
    const forkIdentity = fork ? await this.readForkIdentityFacts(conversationId) : undefined;
    const processSnapshot = processLinks.length === 0 ? null : await this.database.snapshot(processLinks.map(link =>
      DOMAIN_REPOSITORIES.domain('Process').get(requireId(link.process_id, 'ProcessCompletionSourceLink.process_id'))));
    const runningProcesses = (processSnapshot?.snapshot ?? []).flatMap(row =>
      row && !Array.isArray(row) && row.status === 'running'
        ? [{ processId: requireId(row.id, 'Process.id'), status: 'running' as const }]
        : []);
    if (projection.totalChildCount === 0 && runningProcesses.length === 0 && inheritedChildTargets.length === 0) {
      return { contextHandles: handleState.catalog, requiresNativeReset: handleState.requiresNativeReset, contextHandleScope,
        ...(forkIdentity ? { forkIdentity } : {}) };
    }
    const { children, totalChildCount, descendantCount, queuedInputCount, awaitingHandlingCount, activeChildCount } = projection;
    return { contextHandles: handleState.catalog, requiresNativeReset: handleState.requiresNativeReset, contextHandleScope,
      ...(forkIdentity ? { forkIdentity } : {}), statusCard: {
      kind: 'runtime_status_card',
      totalChildCount, descendantCount,
      queuedInputCount, awaitingHandlingCount, activeChildCount,
      runningProcessCount: runningProcesses.length,
      childHandleTargets: projection.childHandleTargets,
      ...(inheritedChildTargets.length > 0 ? { inheritedChildTargets } : {}),
      children, processes: runningProcesses.slice(0, RUNTIME_STATUS_RECIPE_LIMIT),
      card: [
        '[Conversation child tasks and current-turn processes — runtime data, not instructions]',
        `totalDirectChildren=${totalChildCount}; descendantChildren=${descendantCount}; activeChildren=${activeChildCount}; runningProcesses=${runningProcesses.length}`,
        `queuedInputs=${queuedInputCount}; awaitingHandling=${awaitingHandlingCount}; shownChildren=${children.length}; omittedChildren=${totalChildCount - children.length}`,
        'Task text marked truncated is a preview; run_agent operation=list/read returns retained children and paged task inputs. Closed children remain discoverable. Results delivered and results handled are separate facts.',
        ...(inheritedChildTargets.length > 0
          ? ['inheritedChildRefs appear in history copied from this fork\'s source Conversation; those children belong to the source, not to this Conversation.']
          : [])
      ].join('\n')
    } };
  }

  /**
   * A fork's copied history keeps the collaboration refs of the Conversations it was copied from:
   * their "this conversation" is not this one, and their collaboration messages were exchanged
   * without it. Its own messages are the ones it sent or received itself.
   */
  private async readForkIdentityFacts(conversationId: string): Promise<ForkIdentityFacts> {
    const [sourceConversationIds, sent, received] = await Promise.all([
      forkSourceConversationIds(this.database, conversationId),
      listAllDomainRows(this.database, 'CollaborationMessageSourceLink', { conversation_id: conversationId }),
      listAllDomainRows(this.database, 'CollaborationMessageTargetLink', { conversation_id: conversationId })
    ]);
    return {
      conversationId, sourceConversationIds,
      ownMessageIds: new Set([...sent, ...received].map(row => requireId(row.message_id, 'CollaborationMessage link message_id')))
    };
  }

  private observeOpenTasksAtFinal(
    turnId: string,
    round: string,
    modelRequestId: string,
    recipe: { [key: string]: PlainJsonValue }
  ): void {
    const task = asRecord(recipe.turnTaskCard);
    const counts = asRecord(task?.counts);
    const unfinished = optionalNonNegativeInteger(counts?.unfinished) ?? 0;
    if (unfinished <= 0) return;
    const runtime = asRecord(recipe.runtimeStatusCard);
    this.observeLifecycle({
      turnId,
      stage: 'open_tasks_at_final',
      round,
      modelRequestId,
      openTaskCount: unfinished,
      ...(typeof task?.cardSha256 === 'string' ? { taskCardSha256: task.cardSha256 } : {}),
      activeChildCount: optionalNonNegativeInteger(runtime?.activeChildCount) ?? 0,
      runningProcessCount: optionalNonNegativeInteger(runtime?.runningProcessCount) ?? 0
    });
  }

  private async prepareProviderToolBatch(input: {
    turnId: string;
    modelRequestId: string;
    messageId: string;
    output: NormalizedProviderOutput;
    recipe?: { [key: string]: PlainJsonValue };
  }): Promise<FrozenProviderToolCall[]> {
    const recipe = input.recipe ?? await this.readModelRequestRecipe(input.modelRequestId);
    const definitions = await this.readModelRequestToolDefinitions(input.modelRequestId, recipe);
    const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
    const catalog = normalizeModelHandleCatalog(recipe.modelHandleCatalog);
    const existingLinks = await listAllDomainRows(
      this.database,
      'ToolCallSourceLink',
      { model_request_id: input.modelRequestId }
    );
    // Native streamed admission legitimately persists a subset of links before the terminal read;
    // each one is still validated against its ordinal below. Ordinary batches stay all-or-nothing.
    const nativePartialBatch = asRecord(recipe.nativeResponses) !== undefined;
    if (
      existingLinks.length !== 0
      && (existingLinks.length > input.output.toolCalls.length
        || (existingLinks.length !== input.output.toolCalls.length && !nativePartialBatch))
    ) {
      throw new Error(`ModelRequest ${input.modelRequestId} has an incomplete durable ToolCall batch.`);
    }
    const existingByOrdinal = new Map(existingLinks.map((link) => [
      requireNonNegativeSafeNumber(link.provider_ordinal, 'ToolCallSourceLink.provider_ordinal'),
      link
    ]));
    const calls: Array<FrozenProviderToolCall | undefined> = new Array(input.output.toolCalls.length);
    const pending: Array<{
      index: number;
      call: ResolvedProviderToolCall;
      toolCallId: string;
      dispatchInput: ReliableAgentToolDispatchInput & { definition: ReliableAgentToolDefinition };
    }> = [];
    for (let index = 0; index < input.output.toolCalls.length; index += 1) {
      const call = input.output.toolCalls[index];
      let resolvedArguments: PlainJsonValue;
      let argumentResolutionError: string | undefined;
      try {
        resolvedArguments = normalizePlainJson(
          resolveModelToolArguments(call.name, call.arguments, catalog),
          `Provider ToolCall ${call.name} resolved arguments`
        );
      } catch (error) {
        if (!(error instanceof UnknownModelHandleReferenceError)) throw error;
        resolvedArguments = normalizePlainJson(
          call.arguments,
          `Provider ToolCall ${call.name} unresolved arguments`
        );
        argumentResolutionError = errorMessage(error);
      }
      const resolvedCall: ResolvedProviderToolCall = {
        ...call,
        arguments: resolvedArguments,
        ...(argumentResolutionError ? { argumentResolutionError } : {})
      };
      const toolCallId = providerToolCallId(input.modelRequestId, call);
      const existingLink = existingByOrdinal.get(call.providerOrdinal);
      if (existingLink) {
        if (
          existingLink.tool_call_id !== toolCallId
          || existingLink.message_id !== input.messageId
          || existingLink.provider_call_id !== (call.providerCallId ?? null)
          || existingLink.thought_signature !== (call.thoughtSignature ?? null)
        ) throw new Error(`Provider ToolCall source replay conflicts at ordinal ${call.providerOrdinal}.`);
        const rows = await this.list('ToolCallPolicySnapshot', { tool_call_id: toolCallId }, 2);
        if (rows.length !== 1) throw new Error(`ToolCall ${toolCallId} must have one frozen policy snapshot.`);
        calls[index] = { ...resolvedCall, toolCallId, policy: frozenPolicyFromRow(rows[0]) };
        continue;
      }
      const definition = definitionsByName.get(call.name) ?? unknownToolDefinition(call.name);
      pending.push({
        index,
        call: resolvedCall,
        toolCallId,
        dispatchInput: {
          turnId: input.turnId,
          modelRequestId: input.modelRequestId,
          toolCallId,
          ...(call.providerCallId ? { providerCallId: call.providerCallId } : {}),
          toolName: call.name,
          arguments: resolvedCall.arguments,
          definition
        }
      });
    }
    const pendingPolicies = this.tools.freezeCalls
      ? await this.tools.freezeCalls(pending.map((entry) => entry.dispatchInput))
      : await Promise.all(pending.map((entry) => this.tools.freezeCall
          ? this.tools.freezeCall(entry.dispatchInput)
          : Promise.resolve(fallbackFrozenToolPolicy(entry.dispatchInput.definition, entry.call.arguments))));
    if (pendingPolicies.length !== pending.length) {
      throw new Error('Tool dispatcher freezeCalls result length does not match the Provider batch.');
    }
    for (let index = 0; index < pending.length; index += 1) {
      const entry = pending[index];
      calls[entry.index] = {
        ...entry.call,
        toolCallId: entry.toolCallId,
        policy: pendingPolicies[index]
      };
    }
    const frozenCalls = calls.map((call, index) => {
      if (!call) throw new Error(`Provider ToolCall ${index} lacks a frozen policy.`);
      return call;
    });
    const batchId = stableId('tool_call_batch', input.modelRequestId);
    // Native streamed admission already created its calls in per-call batches; the terminal batch
    // creates only the missing entries. A fully linked ordinary batch still replays through the
    // same stable receipt so its process-local admission token survives recovery.
    const creationCalls = pending.length > 0
      ? pending.map((entry) => frozenCalls[entry.index])
      : frozenCalls;
    const creation = pending.length > 0 || !nativePartialBatch
      ? await this.effects.createToolCallBatch({
          source: { kind: 'callback', key: `agent-loop:${input.modelRequestId}:tool-batch` },
          batchId,
          turnId: input.turnId,
          modelRequestId: input.modelRequestId,
          messageId: input.messageId,
          entries: creationCalls.map((call) => ({
            toolCallId: call.toolCallId,
            toolName: call.name,
            arguments: call.arguments,
            ...(call.providerCallId ? { providerCallId: call.providerCallId } : {}),
            providerOrdinal: call.providerOrdinal,
            ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
            policy: call.policy
          }))
        })
      : undefined;
    const batchAdmission = creation && this.tools.confirmPreparedBatch
      ? await this.tools.confirmPreparedBatch({
          turnId: input.turnId,
          modelRequestId: input.modelRequestId,
          messageId: input.messageId,
          batchId,
          recipeDefinitions: definitions,
          calls: creationCalls.map((call) => ({
            turnId: input.turnId,
            modelRequestId: input.modelRequestId,
            toolCallId: call.toolCallId,
            ...(call.providerCallId ? { providerCallId: call.providerCallId } : {}),
            toolName: call.name,
            arguments: call.arguments,
            providerOrdinal: call.providerOrdinal,
            policy: call.policy
          })),
          creation
        })
      : undefined;
    return batchAdmission
      ? frozenCalls.map((call) => ({ ...call, batchAdmission }))
      : frozenCalls;
  }

  private async dispatchProviderToolBatch(input: {
    conversationId: string;
    turnId: string;
    round: string;
    modelRequestId: string;
    calls: readonly FrozenProviderToolCall[];
  }): Promise<{ status: 'completed' } | { status: 'waiting' | 'interrupted'; toolCallId: string }> {
    let cursor = 0;
    let terminalPrefixCursor = 0;
    while (cursor < input.calls.length) {
      const first = input.calls[cursor];
      if (await this.terminateIfRequested(
        input.turnId,
        `round:${input.round}:before-tool-batch:${cursor + 1}`,
        first.toolCallId
      )) return { status: 'interrupted', toolCallId: first.toolCallId };
      let end = cursor + 1;
      if (first.policy.schedulingMode === 'parallel') {
        while (end < input.calls.length && input.calls[end].policy.schedulingMode === 'parallel') end += 1;
      }
      const group = input.calls.slice(cursor, end);
      const batchFinalized = await this.dispatchProviderToolGroup({
        turnId: input.turnId,
        round: input.round,
        modelRequestId: input.modelRequestId,
        calls: group
      });
      if (!batchFinalized) await this.effects.finalizeReadyInOrder(input.turnId);
      terminalPrefixCursor = await this.appendTerminalToolPairsInOrder({
        conversationId: input.conversationId,
        turnId: input.turnId,
        round: input.round,
        modelRequestId: input.modelRequestId,
        calls: input.calls,
        terminalPrefixCursor,
        terminalPrefixLimit: end
      });

      if (await this.terminateIfRequested(
        input.turnId,
        `round:${input.round}:after-tool-batch:${end}`,
        group[group.length - 1].toolCallId
      )) return { status: 'interrupted', toolCallId: group[group.length - 1].toolCallId };
      if (terminalPrefixCursor < end) {
        return { status: 'waiting', toolCallId: input.calls[terminalPrefixCursor].toolCallId };
      }
      cursor = end;
    }
    return { status: 'completed' };
  }

  /**
   * Native logical-request batch: admitted calls reconcile settlement and append their result
   * occurrence explicitly (closure path — live-chain deliveries already committed at the admission
   * created event); unadmitted runs keep the exact ordinary group/pair semantics. A round with
   * fresh occurrences continues so the next request carries ready results; only a fully stalled
   * admitted set parks the Turn until its settlement wake.
   */
  private async dispatchNativeToolBatch(input: {
    conversationId: string;
    turnId: string;
    round: string;
    modelRequestId: string;
    calls: readonly FrozenProviderToolCall[];
  }): Promise<{ status: 'completed' } | { status: 'waiting' | 'interrupted'; toolCallId: string }> {
    const admissions = new Map<string, NativeToolAdmission | undefined>();
    for (const call of input.calls) {
      admissions.set(call.toolCallId, await this.effects.readNativeAdmission(call.toolCallId));
    }
    let progressed = false;
    let firstPending: string | undefined;
    let firstPendingSync: string | undefined;
    let cursor = 0;
    while (cursor < input.calls.length) {
      const call = input.calls[cursor];
      if (!admissions.get(call.toolCallId)) {
        let end = cursor + 1;
        while (end < input.calls.length && !admissions.get(input.calls[end].toolCallId)) end += 1;
        const runDispatch = await this.dispatchProviderToolBatch({
          conversationId: input.conversationId,
          turnId: input.turnId,
          round: input.round,
          modelRequestId: input.modelRequestId,
          calls: input.calls.slice(cursor, end)
        });
        if (runDispatch.status !== 'completed') return runDispatch;
        progressed = true;
        cursor = end;
        continue;
      }
      if (await this.terminateIfRequested(
        input.turnId,
        `round:${input.round}:native-tool-batch:${cursor}`,
        call.toolCallId
      )) {
        return { status: 'interrupted', toolCallId: call.toolCallId };
      }
      let terminal = await this.effects.readTerminalResult(call.toolCallId, false);
      if (!terminal && !this.nativeCallExecutions.has(call.toolCallId)) {
        // The dispatcher reconciles its own durable frontier; this never re-executes committed
        // effects. An execution this Host already runs is never dispatched a second time: the
        // call stays pending below and its settlement wakes the Turn.
        await this.dispatchProviderToolCall({
          turnId: input.turnId,
          round: input.round,
          modelRequestId: input.modelRequestId,
          call
        });
        terminal = await this.effects.readTerminalResult(call.toolCallId, false);
      }
      if (terminal) {
        const appended = await this.appendNativeResultOccurrenceOnce({
          conversationId: input.conversationId,
          toolCallId: call.toolCallId,
          toolModelResultId: terminal.toolModelResultId
        });
        if (appended) {
          progressed = true;
          this.observeLifecycle({
            turnId: input.turnId,
            stage: 'context_tool_pair_committed',
            round: input.round,
            modelRequestId: input.modelRequestId,
            toolCallId: call.toolCallId,
            contextPairCount: 1,
            contextTransactionCount: 1
          });
        }
      } else {
        firstPending ??= call.toolCallId;
        if (admissions.get(call.toolCallId)?.declaredAsync !== true) firstPendingSync ??= call.toolCallId;
      }
      cursor += 1;
    }
    // Only an admitted async call may stay pending across the next request; a synchronous call
    // without a result would reach the Provider as an unresolved function call.
    if (firstPendingSync) return { status: 'waiting', toolCallId: firstPendingSync };
    if (firstPending && !progressed) return { status: 'waiting', toolCallId: firstPending };
    return { status: 'completed' };
  }

  /**
   * Native tool-pair closure. Every native call occurrence in Context must be followed by the
   * occurrence of its committed ToolModelResult before another request root is frozen or a Turn
   * terminates; otherwise every later Provider request carries an unresolved call. A settled result
   * is a committed fact, so appending its occurrence records no delivery and resends nothing.
   * Unsettled calls of ended Turns (or of the terminating Turn itself) are closed through the same
   * cancellation path as an abandoned chain. Live calls of the current Turn stay with their owner:
   * sync calls park the Turn, admitted async calls may legally stay pending at the Provider.
   */
  private async closeNativeResultOccurrences(input: {
    conversationId: string;
    turnId: string;
    sourcePrefix: string;
    /**
     * conversation: every ended Turn too (their gaps only appear when a Turn ends, so once per drive
     * suffices); turn: this live Turn only; terminating_turn: this Turn while it is being closed.
     */
    scope: 'conversation' | 'turn' | 'terminating_turn';
  }): Promise<number> {
    const candidates = (await this.effects.listNativePendingWork({
      conversationId: input.conversationId,
      ...(input.scope === 'conversation' ? {} : { turnId: input.turnId })
    })).filter((entry) => entry.resultContextSegmentId === undefined
      // An admitted call without its call occurrence (Host lost between the two commits) is
      // repaired only for the Turn being driven; an ended Turn's never-visible call stays out.
      && (entry.callContextSegmentId !== undefined || entry.turnId === input.turnId));
    if (candidates.length === 0) return 0;
    // Only calls whose call occurrence is part of the CURRENT head can be closed there. A call
    // cut away by edit-and-run/retry truncation must never gain a result occurrence in the new
    // head: that orphan result would make every later Provider request invalid.
    const headRootId = await this.context.currentHeadRootId(input.conversationId);
    const headSegmentIds = new Set(headRootId
      ? (await this.context.materializeStructure(headRootId)).records.map((record) =>
        requireId(record.segment.id, 'ContextSegment.id'))
      : []);
    const open = candidates.filter((entry) =>
      entry.callContextSegmentId === undefined || headSegmentIds.has(entry.callContextSegmentId));
    const stillRunning: Array<{ toolCallId: string; reason: string }> = [];
    let closureError: unknown;
    let appended = 0;
    for (const entry of open) {
      if (!entry.settled && entry.turnActive && input.scope !== 'terminating_turn') continue;
      try {
        if (entry.callContextSegmentId === undefined) {
          await this.context.ensureNativeToolCall({
            conversationId: input.conversationId,
            toolCallId: entry.toolCallId,
            ...(entry.providerCallId ? { providerCallId: entry.providerCallId } : {})
          });
        }
        let toolModelResultId = entry.toolModelResultId;
        if (!entry.settled) {
          try {
            await this.closeNativeAdmittedCall(entry.toolCallId, `${input.sourcePrefix}:${entry.toolCallId}`);
          } catch (error) {
            if (isExecutionHandoffError(error)) throw error;
            stillRunning.push({ toolCallId: entry.toolCallId, reason: errorMessage(error) });
            continue;
          }
          toolModelResultId = (await this.requireTerminalToolResult(entry.toolCallId)).toolModelResultId;
        }
        if (!await this.appendNativeResultOccurrenceOnce({
          conversationId: input.conversationId,
          toolCallId: entry.toolCallId,
          toolModelResultId: requireId(toolModelResultId, 'NativePendingToolCall.toolModelResultId')
        })) continue;
        appended += 1;
        this.observeLifecycle({
          turnId: input.turnId,
          stage: 'context_tool_pair_committed',
          toolCallId: entry.toolCallId,
          contextPairCount: 1,
          contextTransactionCount: 1
        });
      } catch (error) {
        if (isExecutionHandoffError(error)) throw error;
        closureError ??= error;
      }
    }
    if (input.scope === 'terminating_turn') {
      // Termination must still be recordable; the next request boundary retries the closure once
      // a still-running effect has produced its receipt.
      if (closureError !== undefined || stillRunning.length > 0) {
        this.observeLifecycle({
          turnId: input.turnId,
          stage: 'native_context_closure_failed',
          ...(stillRunning[0] ? { toolCallId: stillRunning[0].toolCallId } : {}),
          ...(closureError !== undefined ? errorDiagnostic(closureError) : {})
        });
      }
      return appended;
    }
    if (closureError !== undefined) throw closureError;
    if (stillRunning.length > 0) {
      throw new NativeAsyncWorkPendingError(
        stillRunning,
        `${stillRunning.length} 个已结束轮次的原生工具仍在执行，结果写回上下文前不能发送新的模型请求；请等待其结束后重试。`
      );
    }
    return appended;
  }

  /** Idempotent explicit result occurrence append of the native closure path. */
  private async appendNativeResultOccurrenceOnce(input: {
    conversationId: string;
    toolCallId: string;
    toolModelResultId: string;
  }): Promise<boolean> {
    const sources = await this.list('ContextSegmentSource', {
      source_kind: 'tool_model_result',
      source_id: input.toolModelResultId
    }, 2);
    if (sources.length > 1) {
      throw new Error(`ToolModelResult ${input.toolModelResultId} has multiple Context occurrences.`);
    }
    if (sources.length === 1) return false;
    // Admission and its call occurrence commit separately; repair a lost call occurrence first.
    await this.context.ensureNativeToolCall({
      conversationId: input.conversationId,
      toolCallId: input.toolCallId
    });
    await this.context.appendNativeToolResult({
      conversationId: input.conversationId,
      toolCallId: input.toolCallId,
      toolModelResultId: input.toolModelResultId
    });
    return true;
  }

  private async dispatchProviderToolGroup(input: {
    turnId: string;
    round: string;
    modelRequestId: string;
    calls: readonly FrozenProviderToolCall[];
  }): Promise<boolean> {
    if (!this.tools.dispatchBatch) {
      const outcomes = await mapSettledWithBoundedConcurrency(
        input.calls,
        4,
        async (call) => this.dispatchProviderToolCall({
          turnId: input.turnId,
          round: input.round,
          modelRequestId: input.modelRequestId,
          call
        })
      );
      const rejected = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
      );
      if (rejected) throw rejected.reason;
      return false;
    }
    const schedulingMode = input.calls[0]?.policy.schedulingMode ?? 'serial';
    for (const call of input.calls) {
      this.observeLifecycle({
        turnId: input.turnId,
        stage: 'tool_dispatch_started',
        round: input.round,
        modelRequestId: input.modelRequestId,
        toolCallId: call.toolCallId,
        toolBatchSize: input.calls.length,
        schedulingMode
      });
    }
    const invalidCalls = input.calls.filter((call) => call.argumentResolutionError);
    if (invalidCalls.length > 0) {
      await this.effects.settleWithoutEffectBatch({
        turnId: input.turnId,
        settlements: invalidCalls.map((call) => ({
          source: {
            kind: 'internal' as const,
            key: `agent-loop:${call.toolCallId}:invalid-model-handle-reference`
          },
          toolCallId: call.toolCallId,
          status: 'failed' as const,
          detail: {
            code: 'invalid_model_handle_reference',
            error: call.argumentResolutionError!
          }
        }))
      });
      for (const call of invalidCalls) {
        this.observeLifecycle({
          turnId: input.turnId,
          stage: 'tool_dispatch_completed',
          round: input.round,
          modelRequestId: input.modelRequestId,
          toolCallId: call.toolCallId,
          toolBatchSize: input.calls.length,
          schedulingMode
        });
      }
    }
    const dispatchableCalls = input.calls.filter((call) => !call.argumentResolutionError);
    if (dispatchableCalls.length === 0) return false;
    const dispatchInputs = dispatchableCalls.map((call) => ({
      turnId: input.turnId,
      modelRequestId: input.modelRequestId,
      toolCallId: call.toolCallId,
      ...(call.providerCallId ? { providerCallId: call.providerCallId } : {}),
      toolName: call.name,
      arguments: call.arguments
    }));
    const batchAdmission = dispatchableCalls.length > 0
      && dispatchableCalls.every((call) => call.batchAdmission === dispatchableCalls[0].batchAdmission)
      ? dispatchableCalls[0].batchAdmission
      : undefined;
    const dispatched = await this.tools.dispatchBatch(
      dispatchInputs,
      batchAdmission ? { admission: batchAdmission } : undefined
    );
    if (dispatched.length !== dispatchableCalls.length) {
      throw new Error('Tool dispatcher dispatchBatch result length does not match the provider group.');
    }
    for (let index = 0; index < dispatched.length; index += 1) {
      if (isToolPause(dispatched[index])) continue;
      this.observeLifecycle({
        turnId: input.turnId,
        stage: 'tool_dispatch_completed',
        round: input.round,
        modelRequestId: input.modelRequestId,
        toolCallId: dispatchableCalls[index].toolCallId,
        toolBatchSize: input.calls.length,
        schedulingMode
      });
    }
    return true;
  }

  private async dispatchProviderToolCall(input: {
    turnId: string;
    round: string;
    modelRequestId: string;
    call: FrozenProviderToolCall;
  }): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled> {
    const existing = await this.effects.readTerminalResult(input.call.toolCallId, false);
    if (existing) return existing;
    try {
      this.observeLifecycle({
        turnId: input.turnId,
        stage: 'tool_dispatch_started',
        round: input.round,
        modelRequestId: input.modelRequestId,
        toolCallId: input.call.toolCallId
      });
      if (input.call.argumentResolutionError) {
        const failed = await this.effects.settleWithoutEffect({
          source: {
            kind: 'internal',
            key: `agent-loop:${input.call.toolCallId}:invalid-model-handle-reference`
          },
          toolCallId: input.call.toolCallId,
          status: 'failed',
          detail: {
            code: 'invalid_model_handle_reference',
            error: input.call.argumentResolutionError
          }
        }, { finalize: false });
        this.observeLifecycle({
          turnId: input.turnId,
          stage: 'tool_dispatch_completed',
          round: input.round,
          modelRequestId: input.modelRequestId,
          toolCallId: input.call.toolCallId
        });
        return failed.terminal ?? {
          disposition: 'settled',
          toolCallId: input.call.toolCallId,
          status: failed.status
        };
      }
      const dispatched = await this.tools.dispatch({
        turnId: input.turnId,
        modelRequestId: input.modelRequestId,
        toolCallId: input.call.toolCallId,
        ...(input.call.providerCallId ? { providerCallId: input.call.providerCallId } : {}),
        toolName: input.call.name,
        arguments: input.call.arguments
      });
      if (!isToolPause(dispatched)) {
        this.observeLifecycle({
          turnId: input.turnId,
          stage: 'tool_dispatch_completed',
          round: input.round,
          modelRequestId: input.modelRequestId,
          toolCallId: input.call.toolCallId
        });
      }
      return dispatched;
    } catch (error) {
      // Host handoff is not a tool failure. The durable ToolCall/Effect frontier deliberately
      // remains incomplete so the next lease generation can recover it; materializing a failed
      // ToolOutcome here would both lie to the model and race a still-running detached process.
      if (isExecutionHandoffError(error) || error instanceof LocalExecutionRecoveryExhaustedError) throw error;
      await this.effects.finalizeReadyInOrder(input.turnId);
      const terminal = await this.effects.readTerminalResult(input.call.toolCallId, false);
      if (terminal) return terminal;
      const operations = await listAllDomainRows(this.database, 'Operation', {
        tool_call_id: input.call.toolCallId
      });
      if (operations.length > 0) {
        return {
          disposition: 'paused',
          toolCallId: input.call.toolCallId,
          reason: 'background_process',
          resumeKey: input.call.toolCallId
        };
      }
      const failed = await this.effects.settleWithoutEffect({
        source: { kind: 'internal', key: `agent-loop:${input.call.toolCallId}:dispatcher-failed` },
        toolCallId: input.call.toolCallId,
        status: 'failed',
        detail: { error: error instanceof Error ? error.message : String(error) }
      });
      return failed.terminal ?? {
        disposition: 'settled',
        toolCallId: input.call.toolCallId,
        status: failed.status
      };
    }
  }

  private async appendTerminalToolPairsInOrder(input: {
    conversationId: string;
    turnId: string;
    round: string;
    modelRequestId: string;
    calls: readonly FrozenProviderToolCall[];
    terminalPrefixCursor: number;
    terminalPrefixLimit: number;
  }): Promise<number> {
    if (
      !Number.isSafeInteger(input.terminalPrefixCursor)
      || input.terminalPrefixCursor < 0
      || input.terminalPrefixCursor > input.calls.length
    ) throw new RangeError('terminalPrefixCursor is outside the Provider ToolCall batch.');
    if (
      !Number.isSafeInteger(input.terminalPrefixLimit)
      || input.terminalPrefixLimit < input.terminalPrefixCursor
      || input.terminalPrefixLimit > input.calls.length
    ) throw new RangeError('terminalPrefixLimit is outside the dispatched Provider ToolCall prefix.');
    let cursor = input.terminalPrefixCursor;
    let scanned = 0;
    const pairs: Array<{
      toolCallId: string;
      toolModelResultId: string;
      providerCallId?: string;
    }> = [];
    const terminalResults = await this.effects.readTerminalResults(
      input.calls.slice(cursor, input.terminalPrefixLimit).map((call) => call.toolCallId),
      false
    );
    for (const terminal of terminalResults) {
      const call = input.calls[cursor];
      scanned += 1;
      if (!terminal) break;
      this.observeLifecycle({
        turnId: input.turnId,
        stage: 'tool_model_result_committed',
        round: input.round,
        modelRequestId: input.modelRequestId,
        toolCallId: call.toolCallId
      });
      pairs.push({
        toolCallId: call.toolCallId,
        toolModelResultId: terminal.toolModelResultId,
        ...(call.providerCallId ? { providerCallId: call.providerCallId } : {})
      });
      cursor += 1;
    }
    this.observeLifecycle({
      turnId: input.turnId,
      stage: 'terminal_prefix_scanned',
      round: input.round,
      modelRequestId: input.modelRequestId,
      terminalCallsScanned: scanned,
      terminalPrefixCursor: cursor
    });
    if (pairs.length === 0) return cursor;
    const appended = await this.context.appendToolPairsInOrderBatch({
      conversationId: input.conversationId,
      pairs
    });
    this.observeLifecycle({
      turnId: input.turnId,
      stage: 'context_tool_pair_committed',
      round: input.round,
      modelRequestId: input.modelRequestId,
      toolCallId: pairs[pairs.length - 1].toolCallId,
      contextPairCount: pairs.length,
      contextTransactionCount: appended.transactionCount
    });
    return cursor;
  }

  private async readModelRequestToolDefinitions(
    modelRequestId: string,
    frozenRecipe?: { [key: string]: PlainJsonValue }
  ): Promise<ReliableAgentToolDefinition[]> {
    const recipe = frozenRecipe ?? await this.readModelRequestRecipe(modelRequestId);
    if (!Array.isArray(recipe.tools)) throw new TypeError('ModelRequest recipe.tools must be an array.');
    return recipe.tools.map((value, index) => normalizeFrozenToolDefinition(value, index));
  }

  private async dispatchAndCapture(
    conversationId: string,
    turnId: string,
    modelRequestId: string,
    request: DomainRow
  ): Promise<NormalizedProviderOutput | typeof NATIVE_CHAIN_REBASED_TERMINAL_STATE> {
    const providerId = requireText(request.provider_id, 'ModelRequest.provider_id');
    const modelId = requireText(request.model_id, 'ModelRequest.model_id');
    const requestSeq = requirePositiveInteger(request.request_seq, 'ModelRequest.request_seq').toString();
    const adapter = await this.providers.resolve(providerId);
    if (adapter.providerId !== providerId) throw new Error(`Provider registry returned ${adapter.providerId} for ${providerId}.`);
    const dispatchBarrier = await this.database.snapshot([]);
    const recipe = await this.readModelRequestRecipe(modelRequestId);
    const nativeCapabilities = readFrozenNativeCapabilities(recipe);
    let session: NativeRequestSession | undefined;
    if (nativeCapabilities) {
      const definitions = await this.readModelRequestToolDefinitions(modelRequestId, recipe);
      const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));
      const catalog = normalizeModelHandleCatalog(recipe.modelHandleCatalog);
      const projection = await this.list('ModelContextProjection', {
        owner_kind: 'model_request', owner_id: modelRequestId
      }, 2);
      if (projection.length !== 1) throw new Error(`Native ModelRequest ${modelRequestId} has no unique frozen Context root.`);
      session = new NativeRequestSession({
        database: this.database,
        contentStore: this.contentStore,
        context: this.context,
        turnOutput: this.turnOutput,
        effects: this.effects,
        tools: this.tools,
        modelProvider: this.modelProvider,
        conversationId,
        turnId,
        modelRequestId,
        providerId,
        modelId,
        capabilities: nativeCapabilities,
        budget: readFrozenNativeLogicalBudget(recipe),
        initialContextRootId: requireId(projection[0]!.root_id, 'ModelContextProjection.root_id'),
        modelHandleCatalog: catalog,
        resolveAdapter: async (id) => this.providers.resolve(id),
        resolveDefinition: (name) => definitionsByName.get(name) ?? unknownToolDefinition(name),
        freezePolicies: async (inputs) => this.freezeDispatchPolicies(inputs),
        dispatchCall: async (input) => this.dispatchNativeCall(input),
        toolCallIdFor: (providerOrdinal, providerCallId, name) =>
          providerToolCallId(modelRequestId, { providerOrdinal, providerCallId, name, arguments: {} }),
        closeAdmittedCall: async (toolCallId, sourceKey) => this.closeNativeAdmittedCall(toolCallId, sourceKey),
        resolveCallArguments: (name, argumentsValue) => {
          try {
            return {
              arguments: normalizePlainJson(
                resolveModelToolArguments(name, argumentsValue, session?.currentModelHandleCatalog() ?? catalog),
                `Native ToolCall ${name} resolved arguments`
              )
            };
          } catch (error) {
            if (!(error instanceof UnknownModelHandleReferenceError)) throw error;
            return {
              arguments: normalizePlainJson(argumentsValue, `Native ToolCall ${name} unresolved arguments`),
              error: errorMessage(error)
            };
          }
        },
        now: this.now
      });
      await session.reconcile();
      // A previously dispatched chain with durable progress is never replayed from its frozen
      // input after a Host change: the model would redo admitted tools and duplicate items. The
      // same holds for a chain whose result admission is unknown. Wait for admitted effects, close
      // their results into Context, seal the chain, and let the Turn continue from Context. A
      // request parked between transient Attempts ('retrying') was dispatched too.
      const previouslyDispatched = reliableDecimal(asRecord(request.stream_stats_json)?.socketGeneration) > 0n
        || request.status === 'streaming' || request.status === 'retrying';
      if (session.unsafeResultAdmissionError()
        || (previouslyDispatched && session.hasDurableChainProgress())) {
        return this.closeNativeChainForRebase(session, modelRequestId);
      }
    }
    const activeSession = session;
    // Native controls consume provider stream sequence numbers but never enter the Webview
    // transient overlay. Cover only controls observed contiguously next to a visible event;
    // an unknown provider/observer gap must still make the Webview request a snapshot.
    const transientSpans = new Map<string, {
      lastObservedStreamSeq: bigint;
      controlRunStart?: bigint;
      unknownGap: boolean;
    }>();
    const transientSpan = (attemptSeq: string, socketGeneration: string) => {
      const key = `${attemptSeq}\0${socketGeneration}`;
      let span = transientSpans.get(key);
      if (!span) {
        span = { lastObservedStreamSeq: 0n, unknownGap: false };
        transientSpans.set(key, span);
      }
      return span;
    };
    const noteNativeControl = (attemptSeq: string, socketGeneration: string, streamSeq: string | bigint): void => {
      const span = transientSpan(attemptSeq, socketGeneration);
      const sequence = requirePositiveInteger(streamSeq, 'native control streamSeq');
      if (sequence <= span.lastObservedStreamSeq) return;
      if (sequence === span.lastObservedStreamSeq + 1n && !span.unknownGap) {
        span.controlRunStart ??= sequence;
      } else {
        span.unknownGap = true;
        span.controlRunStart = undefined;
      }
      span.lastObservedStreamSeq = sequence;
    };
    const visibleFromStreamSeq = (attemptSeq: string, socketGeneration: string, streamSeq: string | bigint): string => {
      const span = transientSpan(attemptSeq, socketGeneration);
      const sequence = requirePositiveInteger(streamSeq, 'visible streamSeq');
      if (sequence <= span.lastObservedStreamSeq) return sequence.toString();
      const contiguous = !span.unknownGap && sequence === span.lastObservedStreamSeq + 1n;
      const from = contiguous ? span.controlRunStart ?? sequence : sequence;
      span.lastObservedStreamSeq = sequence;
      span.controlRunStart = undefined;
      span.unknownGap = false;
      return from.toString();
    };
    // Stream callbacks outlive raw Context preparation. Build them in a scope that receives
    // only stream identity and controls, so keeping a callback cannot keep the full request alive.
    const streamControls = (
      attemptSeq: string,
      socketGeneration: string,
      controls: ProviderDispatchControls
    ): ProviderDispatchControls => ({
      signal: controls.signal,
      ...(controls.onFailedPartialOutput ? { onFailedPartialOutput: controls.onFailedPartialOutput } : {}),
      ...(controls.native || activeSession
        ? {
            native: {
              ...(controls.native ?? {}),
              ...(activeSession ? activeSession.hooks(controls.signal, controls.onLocalFailure) : {})
            }
          }
        : {}),
      onEvent: async (event): Promise<StreamEventResult> => {
        assertProviderCallbackAuthority(controls.signal, modelRequestId);
        // Control observations go straight to durable control handling and the steering
        // subscription; they are never fed into the text transient replay.
        if (event.kind === 'native_control') {
          const result = await controls.onEvent(event);
          assertProviderCallbackAuthority(controls.signal, modelRequestId);
          if (activeSession) await activeSession.afterNativeControl(event, result, controls.signal);
          if (activeSession && (result.checkpointed || result.ignoredReason === 'duplicate')) {
            const admission = parseNativeControlCheckpoint(event.content);
            if (admission.type === 'response.created' && admission.admittedToolResultCallIds?.length) {
              await this.markNativeCarrierDeliveries(
                conversationId,
                turnId,
                modelRequestId,
                admission.responseId,
                admission.admittedToolResultCallIds
              );
            }
          }
          if (result.checkpointed || result.ignoredReason === 'duplicate') {
            noteNativeControl(attemptSeq, socketGeneration, event.streamSeq);
          }
          return result;
        }
        const transientKind = event.kind;
        const observe = (): void => this.observeTransientEvent({
          conversationId,
          turnId,
          modelRequestId,
          requestSeq,
          providerId,
          modelId,
          attemptSeq,
          socketGeneration,
          afterCommitSeq: dispatchBarrier.snapshotCommitSeq,
          fromStreamSeq: visibleFromStreamSeq(attemptSeq, socketGeneration, event.streamSeq),
          event: {
            kind: transientKind,
            streamSeq: event.streamSeq,
            content: event.content,
            ...(event.usage !== undefined ? { usage: event.usage } : {}),
            ...(event.timing !== undefined ? { timing: event.timing } : {})
          },
          observedAt: this.timestamp()
        });
        if (activeSession) {
          if (event.kind === 'output_delta') {
            activeSession.observeDelta(event.content);
          }
          if (event.kind === 'output_item_done') {
            const callItem = activeSession.parseCallItem(event.content);
            if (callItem) {
              const proof = activeSession.buildCallProof(callItem);
              const result = await this.modelProvider.recordNativeToolCallProof(
                modelRequestId,
                attemptSeq,
                socketGeneration,
                event.streamSeq,
                proof,
                { beforeSubmit: () => assertProviderCallbackAuthority(controls.signal, modelRequestId) }
              );
              assertProviderCallbackAuthority(controls.signal, modelRequestId);
              observe();
              await activeSession.admitStreamedCall(callItem, event.streamSeq, result, controls.signal);
              return result;
            }
            const result = await controls.onEvent(event);
            assertProviderCallbackAuthority(controls.signal, modelRequestId);
            observe();
            await activeSession.admitStreamedContentItem(event, result, controls.signal);
            return result;
          }
        }
        // Streaming deltas are intentionally low-latency. A terminal visual state, however,
        // must never outrun the durable terminal checkpoint it claims to represent.
        if (event.kind === 'completed') {
          const result = await controls.onEvent(event);
          assertProviderCallbackAuthority(controls.signal, modelRequestId);
          observe();
          return result;
        }
        observe();
        return controls.onEvent(event);
      }
    });
    const wrapped: FullRequestProviderAdapter = {
      providerId,
      ...(adapter.estimateFullRequestInput
        ? { estimateFullRequestInput: (fullRequest) => adapter.estimateFullRequestInput!(fullRequest) }
        : {}),
      sendFullRequest: (fullRequest, controls) => {
        activeSession?.bindStream({
          attemptSeq: fullRequest.attemptSeq,
          socketGeneration: fullRequest.socketGeneration
        });
        return adapter.sendFullRequest(fullRequest, streamControls(
          fullRequest.attemptSeq,
          fullRequest.socketGeneration,
          controls
        ));
      }
    };
    const streamStats = asRecord(request.stream_stats_json);
    const reconnect = reliableDecimal(streamStats?.socketGeneration) > 0n || request.status === 'streaming';
    let outcome: 'completed' | 'failed' | 'cancelled' | 'handoff' | 'rebase' = 'completed';
    try {
      await this.modelProvider.dispatch(modelRequestId, wrapped, {
        ...(reconnect ? { reconnect: true } : {}),
        // A transient transport failure after durable chain progress must not start a new Attempt
        // that re-sends the frozen input: admitted tools would be issued again under new
        // identities. The provider plane leaves the request open and this loop rebases it.
        ...(activeSession
          ? {
              nativeReplayUnsafe: () => activeSession.hasDurableChainProgress()
                || activeSession.unsafeResultAdmissionError() !== undefined
            }
          : {}),
        onTransientTerminal: (terminal) => this.observeTransientEvent({
          conversationId,
          turnId,
          modelRequestId,
          requestSeq,
          providerId,
          modelId,
          attemptSeq: terminal.attemptSeq,
          socketGeneration: terminal.socketGeneration,
          afterCommitSeq: dispatchBarrier.snapshotCommitSeq,
          fromStreamSeq: visibleFromStreamSeq(terminal.attemptSeq, terminal.socketGeneration, terminal.event.streamSeq),
          event: terminal.event,
          observedAt: this.timestamp()
        })
      });
    } catch (error) {
      if (session && isNativeChainReplayUnsafeError(error)) {
        outcome = 'rebase';
      } else {
        outcome = isExecutionHandoffError(error)
          ? 'handoff'
          : error instanceof Error && error.name === 'AbortError'
            ? 'cancelled'
            : 'failed';
        throw error;
      }
    } finally {
      if (session && outcome !== 'rebase') {
        try {
          await session.dispose(outcome);
        } catch (disposeError) {
          // A completed chain must not continue past an unclosed result. After an abort/failure
          // the original error stays authoritative; the terminal/request-boundary closure retries.
          if (outcome === 'completed' || isExecutionHandoffError(disposeError)) throw disposeError;
          this.observeLifecycle({
            turnId, stage: 'native_context_closure_failed', modelRequestId, ...errorDiagnostic(disposeError)
          });
        }
      }
    }
    if (outcome === 'rebase' && session) {
      // The live session still knows every admitted call and its settlement: close the chain
      // into Context now (or park the Turn until its running tools settle) and continue the Turn
      // with a fresh full request instead of failing it.
      return this.closeNativeChainForRebase(session, modelRequestId);
    }
    // An ambiguous result admission ended the physical chain; dispose closed every settled result
    // into Context. The next request is a fresh full request built from that Context, so the model
    // sees each result exactly once whether or not the abandoned chain consumed it. No external
    // effect is ever re-executed: tool execution is keyed on durable EffectIntents, not on wire input.
    // The terminal CAS checkpoint is the only final output authority. The transient collector exists
    // solely to drive low-latency UI observation and must never become a second durable result path.
    return this.readTerminalProviderOutput(modelRequestId);
  }

  /**
   * Local end of a native physical chain that must not be replayed from its frozen input (Host
   * change, unknown result admission, transient transport failure after durable progress). An
   * admitted tool that is still running keeps the Turn waiting until it settles — it is never
   * cancelled or dispatched again. Otherwise every settled result is closed into Context, the
   * ModelRequest is sealed as rebased and the Turn continues with a fresh full request.
   */
  private async closeNativeChainForRebase(
    session: NativeRequestSession,
    modelRequestId: string
  ): Promise<typeof NATIVE_CHAIN_REBASED_TERMINAL_STATE> {
    // Aborting the physical dispatch may retire an in-flight settlement observer after the
    // result committed. Refresh only this session's admitted frontier; never redispatch tools.
    await session.refreshSettledAdmittedCalls(() => this.assertRecoveryStillOwned(session.turnId));
    const [running] = session.unsettledAdmittedCallIds();
    if (running) {
      await session.dispose('handoff');
      throw new NativeSafetyWaitError(running);
    }
    await session.dispose('completed');
    await this.modelProvider.sealNativeChainForRebase(modelRequestId);
    return NATIVE_CHAIN_REBASED_TERMINAL_STATE;
  }

  /**
   * Error-driven native rebases cannot reset the frozen Provider retry budget by allocating a
   * new ModelRequest. Derive it from durable failure/Attempt facts so a restart cannot reset it.
   * Successful ordinary rounds reset this consecutive-failure budget; handoff-only rebases cost
   * no extra retry and still preserve any failed Attempts that preceded the handoff.
   */
  private async assertNativeErrorRebaseBudget(turnId: string, modelRequestId: string): Promise<void> {
    const recovery = await this.readNativeErrorRecoveryBudget(turnId);
    if (recovery.failures === 0) return;
    const request = await this.requireExisting('ModelRequest', modelRequestId);
    const frozen = await readRequestTurnAuthority(this.database, this.contentStore,
      requireId(request.authority_snapshot_id, 'ModelRequest.authority_snapshot_id'), turnId,
      typeof request.settings_snapshot_object_id === 'string' ? request.settings_snapshot_object_id : undefined);
    const policy = frozenProviderRetryPolicy(frozen.document);
    const maxRetries = policy.enabled ? Math.min(policy.maxRetries, recovery.modelOutputRepair ? 2 : policy.maxRetries) : 0;
    if (recovery.failures <= maxRetries) {
      // A server minimum/backoff persisted before sealing survives restart. Native recovery may
      // change request identity for safety, but must not use that to evade Retry-After.
      const stats = asRecord(request.stream_stats_json);
      const notBefore = typeof stats?.retryNotBeforeAt === 'number' ? stats.retryNotBeforeAt : 0;
      while (Date.now() < notBefore) {
        if (await this.terminateIfRequested(turnId, 'native-rebase-backoff')) return;
        await this.assertRecoveryStillOwned(turnId);
        await new Promise<void>(resolve => setTimeout(resolve, Math.min(250, notBefore - Date.now())));
      }
      return;
    }
    const failure = asRecord(asRecord(request.stream_stats_json)?.failure);
    throw Object.assign(new Error(`Native request recovery exhausted its retry budget (${recovery.failures} failures). ${typeof failure?.message === 'string' ? failure.message : ''}`.trim()),
      { code: 'PROVIDER_RECOVERY_BUDGET_EXHAUSTED' });
  }

  private async readNativeErrorRecoveryBudget(turnId: string): Promise<{ failures: number; modelOutputRepair: boolean }> {
    let failures = 0;
    let modelOutputRepair = false;
    for await (const { request, recipe } of this.readNewestModelRequestRecipes(turnId)) {
      if (recipe.kind !== 'reliable-agent-turn') continue;
      if (request.terminal_state === 'completed' || request.status !== 'terminal') break;
      const stats = asRecord(request.stream_stats_json);
      const failure = asRecord(stats?.failure);
      const attempts = Number(reliableDecimal(stats?.attemptSeq));
      failures += Math.max(0, attempts - 1);
      if (failure?.category === 'transient' || failure?.code === 'CONTEXT_WINDOW_EXCEEDED') {
        failures += 1;
        modelOutputRepair ||= failure.code === 'PROVIDER_MODEL_OUTPUT_INVALID';
      }
    }
    return { failures, modelOutputRepair };
  }

  /** Read-only backoffs still belong to the original execution generation and Host lifecycle. */
  private async assertRecoveryStillOwned(turnId: string): Promise<void> {
    this.modelProvider.assertNotHandingOff();
    const fence = currentExecutionLeaseFence();
    if (!fence) return;
    const current = await this.turns.executionLeaseFence({
      turnId, leaseOwnerId: fence.ownerId, hostBootId: fence.hostBootId
    });
    if (!current || current.id !== fence.id || current.generation !== fence.generation) {
      throw new ExecutionHandoffError('ExecutionLease changed during recovery backoff.');
    }
  }

  /**
   * Model/channel switch guard before a new frozen provider request: fully context-closed native
   * calls never block; unsettled or occurrence-missing calls and in-flight steering owned by a
   * different provider/model reject the switch (never a silent drop). Configuration saves stay
   * unaffected — only applying the request to the provider is guarded.
   */
  private async guardNativeModelSwitch(
    conversationId: string,
    providerId: string,
    modelId: string
  ): Promise<void> {
    let pending = (await this.effects.listNativePendingWork({ conversationId }))
      .filter((entry) => !entry.settled || entry.resultContextSegmentId === undefined);
    if (pending.length > 0) {
      // A call cut out of the current head by edit/retry truncation is no longer model-visible
      // and is never closed into this head; it cannot pin the Conversation to its old model.
      const headRootId = await this.context.currentHeadRootId(conversationId);
      const headSegmentIds = new Set(headRootId
        ? (await this.context.materializeStructure(headRootId)).records.map((record) =>
          requireId(record.segment.id, 'ContextSegment.id'))
        : []);
      pending = pending.filter((entry) =>
        entry.callContextSegmentId === undefined || headSegmentIds.has(entry.callContextSegmentId));
    }
    const steering = await readNativeSteeringInFlight(this.database, conversationId);
    if (pending.length === 0 && steering.length === 0) return;
    const allowedTargets = new Set<string>();
    for (const entry of pending) {
      const request = await this.maybeGet('ModelRequest', entry.modelRequestId);
      if (!request) continue;
      allowedTargets.add(`${requireText(request.provider_id, 'ModelRequest.provider_id')}/${requireText(request.model_id, 'ModelRequest.model_id')}`);
    }
    for (const entry of steering) {
      const requests = await listAllDomainRows(this.database, 'ModelRequest', { turn_id: entry.turnId });
      const latest = requests.sort((left, right) => compareInteger(right.request_seq, left.request_seq))[0];
      if (latest) {
        allowedTargets.add(`${requireText(latest.provider_id, 'ModelRequest.provider_id')}/${requireText(latest.model_id, 'ModelRequest.model_id')}`);
      }
    }
    const target = `${providerId}/${modelId}`;
    if (allowedTargets.has(target)) return;
    const detail = [
      pending.length > 0 ? `${pending.length} native tool call(s) not context-closed` : '',
      steering.length > 0 ? `${steering.length} steering submission(s) in flight` : ''
    ].filter(Boolean).join(' and ');
    throw new NativeAsyncWorkPendingError(
      pending.map((entry) => ({
        toolCallId: entry.toolCallId,
        reason: 'native work owned by another provider/model is not context-closed'
      })),
      `Switching the Conversation to ${target} is blocked until ${detail} settles; the pending native work stays owned by its original provider/model.`
    );
  }

  /**
   * True when every call of a completed native logical request has a server-admission delivery
   * fact. Unadmitted calls (ordinary sync) and admitted-but-undelivered ones (HTTP-pending or
   * chain-dead) keep the Turn alive for a carrier request instead.
   */
  private async nativeLogicalRequestDeliveredAll(calls: readonly FrozenProviderToolCall[]): Promise<boolean> {
    for (const call of calls) {
      const admission = await this.effects.readNativeAdmission(call.toolCallId);
      if (!admission) return false;
      const deliveries = await this.list('ToolCallEvent', {
        tool_call_id: call.toolCallId,
        event_kind: TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY
      }, 2);
      if (deliveries.length !== 1) return false;
    }
    return true;
  }

  /** Policy freeze for native streamed admissions, mirroring the terminal batch path. */
  private async freezeDispatchPolicies(
    inputs: ReadonlyArray<ReliableAgentToolDispatchInput & { definition: ReliableAgentToolDefinition }>
  ): Promise<FrozenToolCallPolicyDecision[]> {
    if (this.tools.freezeCalls) return this.tools.freezeCalls(inputs);
    return Promise.all(inputs.map((input) => this.tools.freezeCall
      ? this.tools.freezeCall(input)
      : Promise.resolve(fallbackFrozenToolPolicy(input.definition, input.arguments))));
  }

  /**
   * Native call dispatch with the same failure semantics as the terminal batch path. Native
   * admissions require the dispatcher's own scheduling; falling back to the old single-call path
   * would recreate the scheduling bypass, so an unsupported dispatcher fails explicitly.
   */
  private dispatchNativeCall(
    input: ReliableAgentToolDispatchInput
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled> {
    // A waiting Turn is re-driven whenever its facts change, possibly while an admitted call it
    // already started is still running in this Host. Dispatching it again would make the
    // dispatcher's "already has an active host execution" refusal the call's only outcome and
    // replace its real result. Re-drive attaches to the running execution instead.
    const running = this.nativeCallExecutions.get(input.toolCallId);
    if (running) return running;
    const execution = this.dispatchNativeCallOnce(input);
    this.nativeCallExecutions.set(input.toolCallId, execution);
    this.nativeCallTurnIds.set(input.toolCallId, input.turnId);
    void execution.then(() => undefined, () => undefined).then(() => {
      if (this.nativeCallExecutions.get(input.toolCallId) === execution) {
        this.nativeCallExecutions.delete(input.toolCallId);
        this.nativeCallTurnIds.delete(input.toolCallId);
      }
    });
    return execution;
  }

  /** Whether this Host still runs a native call it started for the Turn. */
  public hasNativeCalls(turnId: string): boolean {
    for (const callTurnId of this.nativeCallTurnIds.values()) if (callTurnId === turnId) return true;
    return false;
  }

  /**
   * Waits until every native call this Host started for the Turn has settled (its result recorded,
   * or its execution ended). A Host that hands the Turn's lease back waits here first, so none of
   * its effects is still in flight under a lease another Host may then hold. Nothing is cancelled.
   */
  public async quiesceNativeCalls(turnId: string): Promise<void> {
    const awaited = new Set<Promise<unknown>>();
    for (;;) {
      const running = [...this.nativeCallTurnIds]
        .filter(([, callTurnId]) => callTurnId === turnId)
        .map(([toolCallId]) => this.nativeCallExecutions.get(toolCallId))
        .filter((execution): execution is NonNullable<typeof execution> => execution !== undefined && !awaited.has(execution));
      if (running.length === 0) return;
      for (const execution of running) awaited.add(execution);
      await Promise.allSettled(running);
    }
  }

  private async dispatchNativeCallOnce(
    input: ReliableAgentToolDispatchInput
  ): Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled> {
    const existing = await this.effects.readTerminalResult(input.toolCallId, false);
    if (existing) return existing;
    if (!this.tools.scheduleAdmittedCall) {
      throw new Error(
        'Native streamed admission requires a tool dispatcher implementing scheduleAdmittedCall.'
      );
    }
    try {
      return await this.tools.scheduleAdmittedCall(input);
    } catch (error) {
      if (isExecutionHandoffError(error) || error instanceof LocalExecutionRecoveryExhaustedError) throw error;
      await this.effects.finalizeReadyInOrder(input.turnId);
      const terminal = await this.effects.readTerminalResult(input.toolCallId, false);
      if (terminal) return terminal;
      const failed = await this.effects.settleWithoutEffect({
        source: { kind: 'internal', key: `agent-loop:${input.toolCallId}:native-dispatcher-failed` },
        toolCallId: input.toolCallId,
        status: 'failed',
        detail: { error: errorMessage(error) }
      });
      return failed.terminal ?? {
        disposition: 'settled',
        toolCallId: input.toolCallId,
        status: failed.status
      };
    }
  }

  /**
   * Abandoned-chain closure for one admitted native call: cancel pending effects, settle a real
   * cancelled result, and leave the terminal ToolModelResult for the explicit occurrence append.
   */
  private async closeNativeAdmittedCall(toolCallId: string, sourceKey: string): Promise<void> {
    if (await this.effects.readTerminalResult(toolCallId, false)) return;
    await this.cancelUndispatchedToolEffects(toolCallId, sourceKey);
    const call = await this.requireExisting('ToolCall', toolCallId);
    const turnId = requireId(call.turn_id, 'ToolCall.turn_id');
    const operations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: toolCallId });
    if (operations.length === 0) {
      await this.effects.settleWithoutEffect({
        source: { kind: 'internal', key: `${sourceKey}:cancel-native-tool` },
        toolCallId,
        status: 'cancelled',
        detail: { reason: 'native_logical_request_ended' }
      });
      return;
    }
    await this.effects.finalizeReadyInOrder(turnId);
    const terminal = await this.effects.readTerminalResult(toolCallId, false)
      ?? await this.reconcileCommittedToolCall?.(toolCallId)
      ?? await this.effects.finalizeTerminalOperationsWithFallback({
        source: { kind: 'internal', key: `${sourceKey}:close-native-effect` },
        toolCallId,
        detail: { reason: 'native_logical_request_ended_after_effect_terminal' }
      });
    if (!terminal) await this.requireTerminalToolResult(toolCallId);
  }

  /**
   * A checkpointed response.created proves only the result call IDs that its actual wire create
   * admitted. Mark earlier settled results while that proof is still durable: terminal stream
   * pruning retains only a bounded tail and may remove this first response.created later.
   */
  private async markNativeCarrierDeliveries(
    conversationId: string,
    turnId: string,
    carrierModelRequestId: string,
    providerResponseId: string,
    admittedToolResultCallIds: readonly string[]
  ): Promise<void> {
    const admittedCallIds = new Set(admittedToolResultCallIds);
    // Only settled results of EARLIER requests of this same Turn can be carried here. The first
    // request of a Turn has nothing earlier: skip the scan (every new full request's first
    // response.created lists all history results it re-sent).
    const carrier = await this.maybeGet('ModelRequest', carrierModelRequestId);
    if (!carrier || requirePositiveInteger(carrier.request_seq, 'ModelRequest.request_seq') <= 1n) return;
    const pending = (await this.effects.listNativePendingWork({ conversationId, turnId, includeUndelivered: true }))
      .filter((entry) =>
        entry.turnId === turnId
        && entry.modelRequestId !== carrierModelRequestId
        && entry.settled
        && !entry.delivered
        && entry.resultContextSegmentId !== undefined
        && entry.providerCallId !== undefined
        && admittedCallIds.has(entry.providerCallId));
    if (pending.length === 0) return;
    const projections = await this.list('ModelContextProjection', {
      owner_kind: 'model_request', owner_id: carrierModelRequestId
    }, 2);
    if (projections.length !== 1) throw new Error(`ModelRequest ${carrierModelRequestId} lacks its unique Context projection.`);
    const projection = projections[0];
    const structure = await this.context.materializeStructure(
      requireId(projection.root_id, 'ModelContextProjection.root_id')
    );
    const projectedSegmentIds = new Set(structure.records.map((record) =>
      requireId(record.segment.id, 'ContextSegment.id')
    ));
    const eligible = pending.filter((entry) =>
      projectedSegmentIds.has(requireText(entry.resultContextSegmentId, 'NativePendingToolCall.resultContextSegmentId')));
    if (eligible.length === 0) return;
    await this.effects.markNativeResultsDelivered({
      source: {
        kind: 'callback',
        key: `agent-loop:${carrierModelRequestId}:native-carrier-delivery:${providerResponseId}`
      },
      deliveries: eligible.map((entry) => ({
        toolCallId: entry.toolCallId,
        carrierModelRequestId,
        providerResponseId
      }))
    });
  }

  private async readLoopTerminalStatus(
    turnId: string,
    turn: DomainRow
  ): Promise<ReliableAgentLoopResult['terminalStatus']> {
    if (turn.status !== 'terminated') return 'failed';
    const terminations = await this.list('TurnTermination', { turn_id: turnId }, 2);
    if (terminations.length !== 1) {
      throw new Error(`Terminated Turn ${turnId} must have exactly one TurnTermination.`);
    }
    if (terminations[0].terminal_status === 'completed') return 'completed';
    if (terminations[0].terminal_status === 'interrupted') return 'interrupted';
    return 'failed';
  }

  private async materializeFailedPartialOutput(
    turnId: string,
    modelRequestId: string | undefined,
    interrupted = false
  ): Promise<string | undefined> {
    if (!modelRequestId) return undefined;
    const request = await this.maybeGet('ModelRequest', modelRequestId);
    if (
      !request
      || request.turn_id !== turnId
      || request.status !== 'terminal'
      || (!isProviderFailureTerminalState(optionalText(request.terminal_state))
        && (!interrupted || request.terminal_state === 'completed'
          || request.terminal_state === NATIVE_CHAIN_REBASED_TERMINAL_STATE))
    ) return undefined;

    const checkpoints = await this.list('ModelStreamCheckpoint', { model_request_id: modelRequestId }, 512);
    const partialCheckpoints = checkpoints.filter((row) => row.checkpoint_kind === 'partial_summary');
    if (partialCheckpoints.length === 0) return undefined;
    const stats = asRecord(request.stream_stats_json);
    if (!stats) throw new TypeError(`ModelRequest ${modelRequestId} has invalid stream stats.`);
    const attemptSeq = requirePositiveInteger(stats.attemptSeq, 'ModelRequest.stream_stats.attemptSeq');
    const socketGeneration = requirePositiveInteger(
      stats.socketGeneration,
      'ModelRequest.stream_stats.socketGeneration'
    );
    const partial = partialCheckpoints
      .filter((row) => reliableDecimal(row.attempt_seq) === attemptSeq
        && reliableDecimal(row.socket_generation) === socketGeneration)
      .sort((left, right) => compareInteger(right.stream_seq, left.stream_seq))[0];
    if (!partial) return undefined;

    const metadata = await this.requireExisting(
      'ContentObject',
      requireId(partial.content_object_id, 'ModelStreamCheckpoint.content_object_id')
    );
    const bytes = await this.contentStore.read(metadata as unknown as ContentObjectMetadata);
    const envelope = normalizePlainJson(JSON.parse(bytes.toString('utf8')), 'Model partial checkpoint');
    const record = requireRecord(envelope, 'Model partial checkpoint');
    if (record.kind !== 'output_item_done') {
      throw new Error(`ModelRequest ${modelRequestId} partial checkpoint is not an output item event.`);
    }
    const payload = requireRecord(record.content, 'Model partial checkpoint content');
    if (payload.type !== PROVIDER_PARTIAL_OUTPUT_SNAPSHOT_TYPE) {
      throw new Error(`ModelRequest ${modelRequestId} partial checkpoint has an invalid snapshot type.`);
    }
    const output = normalizeProviderOutput(payload.message);
    if (output.toolCalls.length > 0) {
      throw new Error(`ModelRequest ${modelRequestId} partial checkpoint must not contain tool calls.`);
    }
    if (!output.content.parts.some((part) => 'text' in part && part.text.trim().length > 0)) {
      return undefined;
    }
    const recipe = await this.readModelRequestRecipe(modelRequestId);
    const native = readFrozenNativeCapabilities(recipe);
    let displayContent = output.content;
    if (native) {
      // A native request may already have immutable closed items, including executed calls.
      // The text-only snapshot adds unclosed display evidence; it cannot erase those items or
      // introduce a partially assembled call. Keep the committed item body for shared identities.
      const current = await this.list('MessageCurrentRevisionLink', {
        message_id: assistantMessageIdFor(turnId, modelRequestId)
      }, 2);
      if (current.length > 0) {
        if (current.length !== 1) throw new Error('Native partial display requires one current Message revision.');
        const revision = await this.requireExisting('MessageRevision', requireId(current[0].revision_id, 'MessageCurrentRevisionLink.revision_id'));
        const metadata = await this.requireExisting('ContentObject', requireId(revision.content_object_id, 'MessageRevision.content_object_id'));
        const committed = normalizeProviderOutput(normalizePlainJson(JSON.parse(
          (await this.contentStore.read(metadata as unknown as ContentObjectMetadata)).toString('utf8')
        ), 'Native committed display Message')).content;
        const known = new Set(committed.parts.map(part => nativeAssistantPartIdentity({ ...part })));
        const parts = [...committed.parts, ...output.content.parts.filter(part => !known.has(nativeAssistantPartIdentity({ ...part })))];
        const responseOrder = new Map<string, number>();
        for (const part of parts) {
          const responseId = requireId(part.outputItem?.providerResponseId, 'Native display response id');
          if (!responseOrder.has(responseId)) responseOrder.set(responseId, responseOrder.size);
        }
        parts.sort((left, right) => responseOrder.get(left.outputItem!.providerResponseId!)!
          - responseOrder.get(right.outputItem!.providerResponseId!)!
          || left.outputItem!.ordinal - right.outputItem!.ordinal);
        displayContent = { role: 'model', parts };
      }
    }
    const partialInput = {
      turnId,
      modelRequestId,
      sourceKey: `failed-partial:${modelRequestId}`,
      content: canonicalPlainJson(displayContent, 'Partial Provider display MessageContent'),
      contentType: MESSAGE_CONTENT_TYPE
    };
    const committed = native
      ? await this.turnOutput.appendNativeAssistantPartialAggregate(partialInput)
      : await this.turnOutput.appendAssistantMessage({ ...partialInput, contextDisposition: 'exclude' });
    return committed.messageId;
  }

  private async readTerminalProviderOutput(modelRequestId: string): Promise<NormalizedProviderOutput> {
    const request = await this.requireExisting('ModelRequest', modelRequestId);
    if (request.status === 'terminal' && request.terminal_state !== 'completed') {
      const failure = asRecord(request.stream_stats_json)?.failure;
      if (failure !== undefined) throw restoredProviderRequestFailure(failure, String(request.terminal_state));
    }
    const checkpoints = await this.list('ModelStreamCheckpoint', { model_request_id: modelRequestId }, 512);
    const terminal = checkpoints
      .filter((row) => row.checkpoint_kind === 'terminal_summary')
      .sort((left, right) => compareInteger(right.stream_seq, left.stream_seq))[0];
    if (!terminal) throw new Error(`Terminal ModelRequest ${modelRequestId} has no terminal summary checkpoint.`);
    const metadata = await this.requireExisting('ContentObject', requireId(terminal.content_object_id, 'ModelStreamCheckpoint.content_object_id'));
    const bytes = await this.contentStore.read(metadata as unknown as ContentObjectMetadata);
    const envelope = normalizePlainJson(JSON.parse(bytes.toString('utf8')), 'Model terminal checkpoint');
    const record = requireRecord(envelope, 'Model terminal checkpoint');
    if (record.kind !== 'completed') throw new Error('Model terminal checkpoint is not a completed event.');
    return normalizeProviderOutput(record.content);
  }

  /** Provider rejection repairs the Context once per failed immutable request, never its payload. */
  private async recoverProviderContextOverflow(turnId: string, request: DomainRow): Promise<boolean> {
    if (request.status !== 'terminal' || request.terminal_state === 'completed'
      || asRecord(asRecord(request.stream_stats_json)?.failure)?.code !== 'CONTEXT_WINDOW_EXCEEDED'
      || !this.compressionCoordinator.recoverProviderContextOverflow) return false;
    // Paid repair is bounded across restart, but a genuinely successful ordinary round resets
    // the consecutive-failure budget. A long productive Turn may need compression again later.
    let failures = 0;
    for await (const { request: candidate, recipe } of this.readNewestModelRequestRecipes(turnId)) {
      if (recipe.kind !== 'reliable-agent-turn') continue;
      if (candidate.terminal_state === 'completed') break;
      if (asRecord(asRecord(candidate.stream_stats_json)?.failure)?.code === 'CONTEXT_WINDOW_EXCEEDED') failures += 1;
    }
    if (failures > 2) return false;
    if (await this.terminateIfRequested(turnId, 'before-context-overflow-recovery')) return false;
    const recovered = await this.compressionCoordinator.recoverProviderContextOverflow({
      turnId, failedModelRequestId: requireId(request.id, 'ModelRequest.id')
    });
    return recovered.status === 'compressed';
  }

  private async readRoundFacts(turnId: string): Promise<{ turn: DomainRow; authority: DomainRow; head: DomainRow }> {
    const turn = await this.requireExisting('Turn', turnId);
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').list({ where: { turn_id: turnId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').list({ where: { conversation_id: conversationId }, limit: 2 })
    ]);
    const authorities = rows(snapshot.snapshot[0]);
    const heads = rows(snapshot.snapshot[1]);
    if (authorities.length !== 1) throw new Error(`Turn ${turnId} must have exactly one AuthoritySnapshot.`);
    if (heads.length !== 1) throw new Error(`Conversation ${conversationId} must have exactly one Context head.`);
    return { turn, authority: authorities[0], head: heads[0] };
  }

  /**
   * Returns the last durable request sequence, or 1 for a fresh Turn. Replaying the last sequence
   * is required: request existence alone does not prove that its assistant Message, every tool
   * result and every Context tool_pair were committed before a crash.
   */
  private async resumeRequestSequence(turnId: string): Promise<bigint> {
    return (await this.readResumeState(turnId)).requestSequence;
  }

  private async readResumeState(turnId: string): Promise<AgentLoopResumeState> {
    return readAgentLoopResumeState(this.database, this.contentStore, turnId);
  }

  private async cancelSupersededCompressionRequests(turnId: string, currentHeadRootId: string): Promise<void> {
    const requests = await listAllDomainRows(this.database, 'ModelRequest', { turn_id: turnId });
    const activeRequests = requests.filter((request) => request.status !== 'terminal');
    const recipes = await this.readModelRequestRecipes(activeRequests);
    for (const request of activeRequests) {
      const requestId = requireId(request.id, 'ModelRequest.id');
      const recipe = recipes.get(requestId);
      if (!recipe) throw new Error(`ModelRequest ${requestId} recipe batch lost its request.`);
      if (recipe.kind !== 'reliable-context-compression') continue;
      const sourceRootId = requireId(recipe.sourceRootId, 'Compression recipe.sourceRootId');
      if (sourceRootId === currentHeadRootId) continue;
      await this.modelProvider.cancel(requestId, 'compression-source-head-superseded-before-recovery');
    }
  }

  private async assertModelRequestRound(
    request: DomainRow,
    expected: bigint,
    expectedId: string
  ): Promise<{ [key: string]: PlainJsonValue }> {
    if (request.id !== expectedId) throw new Error('ModelProvider returned an unexpected stable ModelRequest identity.');
    const recipe = (await this.readModelRequestRecipes([request])).get(expectedId);
    if (!recipe) throw new Error(`ModelRequest ${expectedId} recipe batch lost its request.`);
    const actual = requirePositiveInteger(recipe.round, 'ModelRequest recipe.round');
    if (recipe.kind !== 'reliable-agent-turn' || actual !== expected) {
      throw new Error(
        `ModelRequest ${expectedId} recipe round ${actual.toString()} does not match durable round ${expected.toString()}.`
      );
    }
    return recipe;
  }

  private async readModelRequestRecipe(modelRequestId: string): Promise<{ [key: string]: PlainJsonValue }> {
    const request = await this.requireExisting('ModelRequest', modelRequestId);
    const recipe = (await this.readModelRequestRecipes([request])).get(modelRequestId);
    if (!recipe) throw new Error(`ModelRequest ${modelRequestId} recipe batch lost its request.`);
    return recipe;
  }

  /**
   * Tail readers stop at their semantic boundary without loading the complete Turn or request
   * history. Both orderings use existing owner-prefixed indexes; the id tie-breaker preserves
   * newest-first ordering even when several Turns share a creation timestamp.
   */
  private async *readNewestHistoryRows(domain: 'Turn' | 'ModelRequest', ownerId: string): AsyncGenerator<DomainRow> {
    const repository = DOMAIN_REPOSITORIES.domain(domain);
    const column = domain === 'Turn' ? 'created_at' : 'request_seq';
    const where = domain === 'Turn' ? { conversation_id: ownerId } : { turn_id: ownerId };
    let keyset: RepositoryKeysetCursor | undefined;
    while (true) {
      const snapshot = await this.database.snapshot([repository.list({
        where,
        orderBy: { column, direction: 'desc' },
        ...(keyset ? { keyset } : {}),
        limit: REQUEST_HISTORY_PAGE_SIZE
      })]);
      const page = rows(snapshot.snapshot[0]);
      for (const row of page) yield row;
      if (page.length < REQUEST_HISTORY_PAGE_SIZE) return;
      const last = page[page.length - 1];
      keyset = {
        column,
        value: domain === 'Turn'
          ? requireText(last.created_at, 'Turn.created_at')
          : requirePositiveInteger(last.request_seq, 'ModelRequest.request_seq'),
        id: requireId(last.id, `${domain}.id`),
        direction: 'before'
      };
    }
  }

  /** Decode only visited recipes, including compression candidates before an ordinary boundary. */
  private async *readNewestModelRequestRecipes(turnId: string): AsyncGenerator<{
    request: DomainRow;
    recipe: { [key: string]: PlainJsonValue };
  }> {
    for await (const request of this.readNewestHistoryRows('ModelRequest', turnId)) {
      const requestId = requireId(request.id, 'ModelRequest.id');
      const recipe = (await this.readModelRequestRecipes([request])).get(requestId);
      if (!recipe) throw new Error(`ModelRequest ${requestId} recipe batch lost its request.`);
      yield { request, recipe };
    }
  }

  /** Full recipe reader for callers that need payloads; resume evidence uses its own bounded scan. */
  private async readModelRequestRecipes(
    requests: readonly DomainRow[]
  ): Promise<Map<string, { [key: string]: PlainJsonValue }>> {
    if (requests.length === 0) return new Map();
    const indexed = requests.map((request) => ({
      requestId: requireId(request.id, 'ModelRequest.id'),
      recipeObjectId: requireId(request.recipe_object_id, 'ModelRequest.recipe_object_id')
    }));
    const recipeObjectIds = [...new Set(indexed.map((entry) => entry.recipeObjectId))];
    const snapshot = await this.database.snapshot(recipeObjectIds.map((id) =>
      DOMAIN_REPOSITORIES.domain('ContentObject').get(id)
    ));
    if (snapshot.snapshot.length !== recipeObjectIds.length) {
      throw new Error('ModelRequest recipe metadata batch returned the wrong result count.');
    }
    const metadata = snapshot.snapshot.map((value, index) => {
      if (!value || Array.isArray(value)) {
        throw new Error(`ContentObject ${recipeObjectIds[index]} does not exist.`);
      }
      return value as unknown as ContentObjectMetadata;
    });
    const bytes = await this.contentStore.readMany(metadata);
    if (bytes.length !== recipeObjectIds.length) {
      throw new Error('ModelRequest recipe CAS batch returned the wrong result count.');
    }
    const recipeByObjectId = new Map(recipeObjectIds.map((id, index) => [
      id,
      requireRecord(
        normalizePlainJson(JSON.parse(bytes[index].toString('utf8')), 'ModelRequest recipe'),
        'ModelRequest recipe'
      )
    ]));
    return new Map(indexed.map(({ requestId, recipeObjectId }) => {
      const recipe = recipeByObjectId.get(recipeObjectId);
      if (!recipe) throw new Error(`ContentObject ${recipeObjectId} recipe batch lost its content.`);
      return [requestId, recipe];
    }));
  }

  private async requireTerminalToolResult(toolCallId: string): Promise<ToolTerminalResult> {
    const terminal = await this.effects.readTerminalResult(toolCallId, true);
    if (!terminal) throw new Error(`ToolCall ${toolCallId} has no terminal model result.`);
    return terminal;
  }

  /**
   * A Provider round containing tools owns the whole tool batch. Once that response boundary is
   * durably complete, hand off before issuing another Provider request when either ordinary user
   * guidance or an internal RuntimeDelivery continuation is already queued. The latter now has an
   * explicit runtime_continuation envelope, so it cannot be confused with a user retry.
   */
  private async completeForQueuedBoundaryInput(input: {
    turnId: string;
    conversationId: string;
    round: string;
    modelRequestId: string;
  }): Promise<boolean> {
    for (;;) {
      const queuedInput = await this.oldestQueuedBoundaryIntent(input.conversationId);
      if (!queuedInput) return false;
      const queuedIntentId = requireId(queuedInput.intent.id, 'Queued boundary TurnIntent.id');
      if (await this.terminateIfRequested(
        input.turnId,
        `round:${input.round}:before-queued-input-handoff:${queuedIntentId}`
      )) return true;
      this.observeLifecycle({
        turnId: input.turnId,
        stage: 'turn_terminal_started',
        round: input.round,
        modelRequestId: input.modelRequestId
      });
      try {
        await this.turns.terminal({
          source: {
            kind: 'internal',
            key: `agent-loop:${input.turnId}:queued-input-handoff:${queuedIntentId}:${input.modelRequestId}`
          },
          turnId: input.turnId,
          terminalStatus: 'completed',
          reason: queuedInput.kind === 'runtime_continuation'
            ? 'queued_runtime_delivery_after_response_boundary'
            : 'queued_guidance_after_tool_batch',
          handoffQueuedIntentId: queuedIntentId,
          handoffQueuedIntentRevisionIds: queuedInput.revisionIds
        });
        this.observeLifecycle({
          turnId: input.turnId,
          stage: 'turn_terminal_completed',
          round: input.round,
          modelRequestId: input.modelRequestId
        });
        return true;
      } catch (error) {
        if (isTurnTerminalGuidanceConflictError(error)) continue;
        if (isTurnTerminalInputConflictError(error)) {
          if (await this.terminateIfRequested(
            input.turnId,
            `round:${input.round}:queued-input-handoff-conflict:${queuedIntentId}`
          )) return true;
          if (await this.absorbRuntimeDeliveryInputs(input.turnId) > 0) continue;
        }
        throw error;
      }
    }
  }

  private async oldestQueuedBoundaryIntent(conversationId: string): Promise<{
    intent: DomainRow;
    kind: 'guidance' | 'runtime_continuation';
    revisionIds: string[];
  } | null> {
    const [queued, childIntentLinks] = await Promise.all([
      listAllDomainRows(this.database, 'TurnIntent', { conversation_id: conversationId }),
      listAllDomainRows(this.database, 'ChildExecutionIntentLink', { state: 'pending' })
    ]);
    const childIntentIds = new Set(childIntentLinks.map((link) =>
      requireId(link.turn_intent_id, 'ChildExecutionIntentLink.turn_intent_id')
    ));
    const candidates = queued
      .filter((intent) => intent.state === 'queued' && intent.turn_id === null)
      .filter((intent) => !childIntentIds.has(requireId(intent.id, 'TurnIntent.id')));
    const boundaryInputs: Array<{
      intent: DomainRow;
      kind: 'guidance' | 'runtime_continuation';
      position: string;
      hold: 'none' | 'paused';
      revisionIds: string[];
    }> = [];
    for (const candidate of candidates) {
      const intentId = requireId(candidate.id, 'TurnIntent.id');
      const revisions = await listAllDomainRows(this.database, 'TurnIntentRevision', { intent_id: intentId });
      if (revisions.length === 0) throw new Error(`Queued TurnIntent ${intentId} has no frozen revision.`);
      const current = [...revisions].sort((left, right) =>
        compareInteger(right.revision_seq, left.revision_seq)
      )[0]!;
      const contentObject = await this.requireExisting(
        'ContentObject',
        requireId(current.content_object_id, 'TurnIntentRevision.content_object_id')
      );
      if (contentObject.content_type !== TURN_INTENT_ENVELOPE_CONTENT_TYPE) {
        boundaryInputs.push({
          intent: candidate,
          kind: 'guidance',
          position: initialGuidancePosition(requireText(candidate.created_at, 'TurnIntent.created_at')),
          hold: 'none',
          revisionIds: revisions.map((revision) => requireId(revision.id, 'TurnIntentRevision.id'))
        });
        continue;
      }
      const metadata = contentObject as unknown as ContentObjectMetadata;
      const envelopeValue = JSON.parse(
        (await this.contentStore.read(metadata)).toString('utf8')
      ) as unknown;
      const envelope = parseInputTurnIntentEnvelope(envelopeValue);
      if (envelope) {
        boundaryInputs.push({
          intent: candidate,
          kind: 'guidance',
          position: envelope.guidance.position,
          hold: envelope.guidance.hold,
          revisionIds: revisions.map((revision) => requireId(revision.id, 'TurnIntentRevision.id'))
        });
        continue;
      }
      if (!parseRuntimeContinuationTurnIntentEnvelope(envelopeValue)) continue;
      boundaryInputs.push({
        intent: candidate,
        kind: 'runtime_continuation',
        position: initialGuidancePosition(requireText(candidate.created_at, 'TurnIntent.created_at')),
        hold: 'none',
        revisionIds: revisions.map((revision) => requireId(revision.id, 'TurnIntentRevision.id'))
      });
    }
    return boundaryInputs
      .filter((entry) => entry.hold === 'none')
      .sort((left, right) => compareGuidancePositions(left.position, right.position)
        || String(left.intent.created_at).localeCompare(String(right.intent.created_at))
        || String(left.intent.id).localeCompare(String(right.intent.id)))[0] ?? null;
  }

  /**
   * A peer followup may start a Conversation's very first Turn. Its delivered input is then the
   * first Context occurrence, so it is absorbed before the round reads the Context head.
   */
  private async openEmptyContextWithDeliveredInput(turnId: string): Promise<void> {
    const turn = await this.requireExisting('Turn', turnId);
    if (turn.status !== 'active') return;
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    if ((await this.list('ConversationContextHeadLink', { conversation_id: conversationId }, 1)).length > 0) return;
    if (!this.database.conversationOwners.owns(conversationId)) {
      throw new ExecutionHandoffError(`Conversation ${conversationId} is not owned by this Runtime Host.`);
    }
    await this.absorbRuntimeDeliveryInputs(turnId);
  }

  /**
   * Takes committed runtime input into this Turn's Context at a request boundary. A Turn that is
   * ending (`routed: 'leave'`) still takes in results of its own work, but leaves results routed in
   * from another source Turn to its terminal commit, which passes them on to the next Turn.
   */
  private async absorbRuntimeDeliveryInputs(turnId: string, routed: 'take' | 'leave' = 'take'): Promise<number> {
    const deliveries = await orderRuntimeDeliveriesForInjection(this.database, await listAllDomainRows(this.database, 'RuntimeDelivery', {
      target_turn_id: turnId,
      phase: 'current_turn',
      state: 'pending'
    }));
    for (const delivery of deliveries) {
      await this.runtimeDeliveries.advance(
        requireId(delivery.id, 'RuntimeDelivery.id'),
        routed === 'take' ? { boundaryTurnId: turnId } : {}
      );
    }
    const pending = (await listAllDomainRows(this.database, 'PendingTurnInput', {
      turn_id: turnId,
      state: 'pending',
      input_kind: 'runtime_delivery'
    }))
      .sort((left, right) => compareInteger(left.position, right.position));
    if (pending.length === 0) return 0;
    const turn = await this.requireExisting('Turn', turnId);
    if (turn.status !== 'active') return 0;
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    let absorbed = 0;
    for (const input of pending) {
      const inputId = requireId(input.id, 'PendingTurnInput.id');
      // A published runtime may have committed this immutable occurrence before crashing at
      // its separate ACK. It can now be an ancestor after recovery appended other work: do not
      // reproject, duplicate it or reactivate its old head. Its original acceptance already won.
      if ((await this.list('ContextSegmentSource', {
        source_kind: 'runtime_context', source_id: inputId, source_revision: 0n
      }, 1)).length > 0) {
        await this.runtimeDeliveries.markInputHandled(inputId);
        absorbed += 1;
        continue;
      }
      let contentObjectId = requireId(input.content_object_id, 'PendingTurnInput.content_object_id');
      for (let attempt = 0; ; attempt += 1) {
        const projection = await this.projectRuntimeInput(inputId, contentObjectId);
        if (!projection) {
          await this.runtimeDeliveries.markInputHandled(inputId);
          break;
        }
        try {
          await this.context.appendContent({
            conversationId,
            segmentKind: 'runtime_context',
            runtimeDeliveryAcceptance: { deliveryId: projection.envelope.deliveryId, pendingTurnInputId: inputId,
              inputContentObjectId: projection.inputContentObjectId, answerNotice: projection.answerNotice },
            source: { sourceKind: 'runtime_context', sourceId: inputId, sourceRevision: 0n },
            content: projection.content,
            contentType: projection.contentType
          });
          // New acceptance acknowledged the input atomically. Historical replay uses the same
          // idempotent acknowledgement, without allocating a new timeline coordinate.
          await this.runtimeDeliveries.markInputHandled(inputId);
          break;
        } catch (error) {
          const latest = await this.requireExisting('PendingTurnInput', inputId);
          const latestContent = requireId(latest.content_object_id, 'PendingTurnInput.content_object_id');
          if (!isTransactionAssertionFailure(error)) throw error;
          if (latest.state === 'consumed') {
            // Another acceptance, or a source-deletion disposal without a notice, won first.
            // Neither case may publish the stale projection as a new occurrence.
            await this.runtimeDeliveries.markInputHandled(inputId);
            break;
          }
          if (attempt > 0 || latestContent === projection.inputContentObjectId) throw error;
          // A source-child deletion won before acceptance: project its now-authoritative notice
          // once. The rejected transaction published neither Context nor a timeline receipt.
          contentObjectId = latestContent;
        }
      }
      absorbed += 1;
    }
    return absorbed;
  }

  /**
   * The model projection of one runtime input. Deleting a child Conversation replaces an input of its
   * answer that this Turn has not taken in by the deletion notice (ConversationDeletionControlPlane):
   * an input whose content changed while it was projected is projected once more as it is now.
   */
  private async projectRuntimeInput(inputId: string, contentObjectIdInput: string): Promise<(RuntimeDeliveryModelProjection & { inputContentObjectId: string; answerNotice?: AcceptedAnswerNotice }) | null> {
    let contentObjectId = contentObjectIdInput;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const metadata = await this.requireExisting('ContentObject', contentObjectId) as unknown as ContentObjectMetadata;
        const content = await this.contentStore.read(metadata);
        const projection = await this.runtimeDeliveries.projectInputForModel({
          pendingTurnInputId: inputId,
          contentObjectId,
          content,
          contentType: requireText(metadata.content_type, 'ContentObject.content_type')
        });
        return projection ? { ...projection, inputContentObjectId: contentObjectId,
          ...(metadata.content_type === CHILD_ANSWER_SOURCE_DELETED_CONTENT_TYPE
            ? { answerNotice: acceptedNoticeMetadata(content, projection.envelope) } : {}) } : null;
      } catch (error) {
        const latest = requireId((await this.requireExisting('PendingTurnInput', inputId)).content_object_id, 'PendingTurnInput.content_object_id');
        if (attempt > 0 || latest === contentObjectId) throw error;
        contentObjectId = latest;
      }
    }
  }

  private async terminateIfRequested(
    turnId: string,
    stage: string,
    pendingToolCallId?: string
  ): Promise<boolean> {
    for (;;) {
      const terminationFacts = await this.readTurnTerminationFacts(turnId);
      const turn = terminationFacts.turn;
      if (turn.status !== 'active') return turn.status === 'terminated';
      const request = terminationFacts.pending
        .sort((left, right) => compareInteger(left.position, right.position))[0];
      if (!request) return false;

      // Cancellation may race between ModelRequest/ToolCall creation and external dispatch. Close
      // every durable wait, then absorb any concurrently delivered runtime context before the
      // interrupted terminal writer ACKs termination inputs and releases the exact lease.
      await this.modelProvider.cancelTurnDispatches(turnId, `termination request observed at ${stage}`);
      // Stop preserves observed text/thought for the transcript, while cancelled requests and
      // their unclosed items remain excluded from model Context. The Turn still owns its lease.
      const stoppedRequests = await listAllDomainRows(this.database, 'ModelRequest', { turn_id: turnId });
      for (const stopped of stoppedRequests) {
        await this.materializeFailedPartialOutput(turnId, requireId(stopped.id, 'ModelRequest.id'), true);
      }
      await this.tools.cancelWaiting?.({
        turnId,
        sourceKey: `agent-loop:${turnId}:termination-request:${request.id}`,
        reason: `Turn observed ${String(request.input_kind)} at ${stage}.`
      });
      await this.closeTerminalToolContext(
        turnId,
        `agent-loop:${turnId}:termination-request:${requireId(request.id, 'PendingTurnInput.id')}`,
        'turn_termination_requested',
        pendingToolCallId
      );
      await this.absorbRuntimeDeliveryInputs(turnId, 'leave');
      try {
        await this.turns.terminal({
          source: { kind: 'internal', key: `agent-loop:${turnId}:termination-request:${request.id}` },
          turnId,
          terminalStatus: 'interrupted',
          reason: `Executor observed ${String(request.input_kind)} at ${stage}.`
        });
        return true;
      } catch (error) {
        if (isTurnTerminalInputConflictError(error)) continue;
        throw error;
      }
    }
  }

  /**
   * A committed assistant message may contain several function calls while only the first call has
   * reached a durable user/file wait. Before terminating the Turn, materialize and cancel every
   * call represented by that committed message, then append each terminal tool_pair in provider
   * order. This keeps the next Provider request canonical after interruption or failure and is safe to replay.
   */
  private async closeTerminalToolContext(
    turnId: string,
    sourcePrefix: string,
    reason: 'turn_termination_requested' | 'turn_failed',
    pendingToolCallId?: string
  ): Promise<void> {
    const turn = await this.requireExisting('Turn', turnId);
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    const representedToolCallIds = new Set<string>();
    const requests = (await listAllDomainRows(this.database, 'ModelRequest', {
      turn_id: turnId,
      status: 'terminal',
      terminal_state: 'completed'
    }))
      .sort((left, right) => compareInteger(left.request_seq, right.request_seq));

    for (const request of requests) {
      const modelRequestId = requireId(request.id, 'ModelRequest.id');
      const committedAssistant = await this.maybeGet('Message', assistantMessageIdFor(turnId, modelRequestId));
      if (!committedAssistant) continue;
      const output = await this.readTerminalProviderOutput(modelRequestId);
      if (output.toolCalls.length === 0) continue;
      const batch = await this.prepareProviderToolBatch({
        turnId,
        modelRequestId,
        messageId: requireId(committedAssistant.id, 'Assistant Message.id'),
        output
      });
      for (const call of batch) {
        const toolCallId = call.toolCallId;
        representedToolCallIds.add(toolCallId);
        let terminal = await this.effects.readTerminalResult(toolCallId, false);
        if (!terminal) {
          await this.cancelUndispatchedToolEffects(
            toolCallId,
            sourcePrefix,
            `${reason}_before_effect_dispatch`
          );
          const operations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: toolCallId });
          if (operations.length === 0) {
            const settled = await this.effects.settleWithoutEffect({
              source: {
                kind: 'internal',
                key: `${sourcePrefix}:cancel-tool:${toolCallId}`
              },
              toolCallId,
              status: 'cancelled',
              detail: { reason }
            });
            terminal = settled.terminal ?? null;
          } else {
            await this.effects.finalizeReadyInOrder(turnId);
            terminal = await this.effects.readTerminalResult(toolCallId, false)
              ?? await this.reconcileCommittedToolCall?.(toolCallId)
              ?? await this.effects.finalizeTerminalOperationsWithFallback({
                source: {
                  kind: 'internal',
                  key: `${sourcePrefix}:close-effect:${toolCallId}`
                },
                toolCallId,
                detail: { reason: `${reason}_after_effect_terminal` }
              });
          }
          terminal ??= await this.requireTerminalToolResult(toolCallId);
        }
        if (await this.effects.readNativeAdmission(toolCallId)) {
          // The native call occurrence already exists; only the result occurrence closes the pair.
          await this.appendNativeResultOccurrenceOnce({
            conversationId,
            toolCallId,
            toolModelResultId: terminal.toolModelResultId
          });
        } else {
          await this.appendTerminalToolPairOnce({
            conversationId,
            toolCallId,
            toolModelResultId: terminal.toolModelResultId,
            ...(call.providerCallId ? { providerCallId: call.providerCallId } : {})
          });
        }
      }
    }

    // Native calls of a chain that ended without a completed ModelRequest (interrupt/abort while a
    // sibling was running) are not represented above; close every committed/cancelled result.
    await this.closeNativeResultOccurrences({
      conversationId,
      turnId,
      sourcePrefix: `${sourcePrefix}:native-closure`,
      scope: 'terminating_turn'
    });

    if (pendingToolCallId && !representedToolCallIds.has(pendingToolCallId)
      && !await this.effects.readTerminalResult(pendingToolCallId, false)) {
      await this.cancelUndispatchedToolEffects(
        pendingToolCallId,
        sourcePrefix,
        `${reason}_before_effect_dispatch`
      );
      const operations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: pendingToolCallId });
      if (operations.length === 0) {
        await this.effects.settleWithoutEffect({
          source: {
            kind: 'internal',
            key: `${sourcePrefix}:cancel-unrepresented-tool:${pendingToolCallId}`
          },
          toolCallId: pendingToolCallId,
          status: 'cancelled',
          detail: { reason }
        });
      } else {
        await this.effects.finalizeReadyInOrder(turnId);
        const terminal = await this.effects.readTerminalResult(pendingToolCallId, false)
          ?? await this.reconcileCommittedToolCall?.(pendingToolCallId)
          ?? await this.effects.finalizeTerminalOperationsWithFallback({
            source: {
              kind: 'internal',
              key: `${sourcePrefix}:close-effect:${pendingToolCallId}`
            },
            toolCallId: pendingToolCallId,
            detail: { reason: `${reason}_after_effect_terminal` }
          });
        if (!terminal) await this.requireTerminalToolResult(pendingToolCallId);
      }
    }
  }

  /** A prepared Effect may be cancelled; a dispatched Effect must first produce/recover a Receipt. */
  private async cancelUndispatchedToolEffects(
    toolCallId: string,
    sourcePrefix: string,
    reason = 'turn_termination_requested_before_effect_dispatch'
  ): Promise<void> {
    const operations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: toolCallId });
    for (const operation of operations) {
      if (isTerminalToolStatus(operation.status)) continue;
      const attempts = await listAllDomainRows(this.database, 'Attempt', { operation_id: operation.id });
      for (const attempt of attempts) {
        const intents = await this.list('EffectIntent', { attempt_id: attempt.id }, 2);
        if (intents.length > 1) throw new Error(`Attempt ${String(attempt.id)} has multiple EffectIntents.`);
        if (intents[0]?.dispatch_state !== 'pending') continue;
        await this.effects.cancelPendingEffect({
          source: {
            kind: 'internal',
            key: `${sourcePrefix}:cancel-before-dispatch:${String(intents[0].id)}`
          },
          effectIntentId: requireId(intents[0].id, 'EffectIntent.id'),
          detail: { reason }
        });
      }
    }
    const remaining = await listAllDomainRows(this.database, 'Operation', { tool_call_id: toolCallId });
    const unresolved = remaining.filter((operation) => !isTerminalToolStatus(operation.status));
    if (unresolved.length > 0) {
      throw new Error(
        `ToolCall ${toolCallId} still has non-terminal Operations after cancellation: ${unresolved
          .map((operation) => `${String(operation.id)}=${String(operation.status)}`)
          .join(', ')}.`
      );
    }
  }

  private async appendTerminalToolPairOnce(input: {
    conversationId: string;
    toolCallId: string;
    toolModelResultId: string;
    providerCallId?: string;
  }): Promise<void> {
    const sources = await this.list('ContextSegmentSource', {
      source_kind: 'tool_model_result',
      source_id: input.toolModelResultId
    }, 2);
    if (sources.length > 1) {
      throw new Error(`ToolModelResult ${input.toolModelResultId} has multiple Context occurrences.`);
    }
    if (sources.length === 1) {
      // Tool-pair segments are immutable and shared by Conversation forks; each copy registers its
      // own call source, so only this ToolCall's occurrence in the same segment closes the pair.
      const callSources = await this.list('ContextSegmentSource', {
        segment_id: requireId(sources[0].segment_id, 'ContextSegmentSource.segment_id'),
        source_kind: 'tool_call',
        source_id: input.toolCallId
      }, 2);
      if (callSources.length !== 1) {
        throw new Error(`ToolModelResult ${input.toolModelResultId} is linked to a conflicting Context tool pair.`);
      }
      return;
    }
    await this.context.appendToolPair(input);
  }

  private async failActiveTurn(turnId: string, error: unknown): Promise<void> {
    const reason = errorMessage(error);
    for (;;) {
      const turn = await this.maybeGet('Turn', turnId);
      if (!turn || turn.status !== 'active') return;
      if (await this.terminateIfRequested(turnId, 'failure-terminal')) return;
      // A failed dispatch may still own prepared, never-started effects. Close the committed
      // tool batch using the same pending-only CAS and canonical Context rules as interruption.
      // A dispatched effect without a terminal result still blocks closure.
      await this.closeTerminalToolContext(
        turnId,
        `agent-loop:${turnId}:failed:${stableDigest(reason)}`,
        'turn_failed'
      );
      await this.absorbRuntimeDeliveryInputs(turnId, 'leave');
      try {
        await this.turns.terminal({
          source: {
            kind: 'internal',
            key: `agent-loop:${turnId}:failed:${stableDigest(reason)}`
          },
          turnId,
          terminalStatus: 'failed',
          reason
        });
        return;
      } catch (terminalError) {
        if (isTurnTerminalInputConflictError(terminalError)) continue;
        throw terminalError;
      }
    }
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
    return rows(snapshot.snapshot[0]);
  }

  private async readTurnTerminationFacts(
    turnId: string
  ): Promise<{ turn: DomainRow; pending: DomainRow[] }> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Turn').get(turnId),
      ...TERMINATION_INPUT_KINDS.map((inputKind) =>
        DOMAIN_REPOSITORIES.domain('PendingTurnInput').list({
          where: { turn_id: turnId, state: 'pending', input_kind: inputKind },
          orderBy: { column: 'position', direction: 'asc' },
          limit: 1
        }))
    ]);
    const turn = snapshot.snapshot[0];
    if (!turn || Array.isArray(turn)) throw new Error(`Turn ${turnId} does not exist.`);
    return {
      turn,
      pending: snapshot.snapshot.slice(1).flatMap((value) => rows(value))
    };
  }

  private observeLifecycle(event: Omit<ReliableAgentLifecycleEvent, 'observedAt'>): void {
    if (!this.lifecycleObserver) return;
    try {
      this.lifecycleObserver.observe({ ...event, observedAt: this.timestamp() });
    } catch {
      // Diagnostics must never become a second control path or break the Agent loop.
    }
  }

  private observeTransientEvent(event: ReliableAgentTransientEvent): void {
    if (!this.transientObserver) return;
    try {
      this.transientObserver.observe(event);
    } catch {
      // A memory-only low-latency overlay must never become a Provider/Turn control path.
    }
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

const TERMINATION_INPUT_KINDS = [
  'interrupt_request',
  'interrupt_current_turn',
  'termination_request'
] as const;

function isTerminalToolStatus(value: unknown): boolean {
  return ['succeeded', 'failed', 'partial', 'rejected', 'cancelled', 'conflict', 'outcome_unknown']
    .includes(String(value));
}

function isProviderFailureTerminalState(value: string): boolean {
  return value === 'provider_failed' || value.startsWith('provider_transient_');
}

function providerOutputMessage(output: NormalizedProviderOutput): MessageContent {
  return output.content;
}

/**
 * The answer a Turn ends with: the visible text after its last tool call (a native aggregate also
 * carries the commentary written between earlier physical responses). Thoughts are never part of it.
 */
function finalAnswerText(content: MessageContent): string {
  let texts: string[] = [];
  for (const part of content.parts) {
    if ('functionCall' in part) {
      texts = [];
      continue;
    }
    if (isVisibleTextPart(part) && part.text.trim()) texts.push(part.text.trim());
  }
  return texts.join('\n\n');
}

function normalizeProviderOutput(value: PlainJsonValue): NormalizedProviderOutput {
  const record = requireRecord(value, 'Provider completed MessageContent');
  if (record.role !== 'model' || !Array.isArray(record.parts)) {
    throw new TypeError('Provider completed MessageContent must contain model parts.');
  }
  const content = normalizePlainJson(record, 'Provider completed MessageContent') as unknown as MessageContent;
  const calls: PlainJsonValue[] = [];
  for (const part of content.parts) {
    if (!('functionCall' in part)) continue;
    calls.push(normalizePlainJson({
      ...(part.id ? { id: part.id } : {}),
      ordinal: calls.length,
      name: part.functionCall.name,
      arguments: part.functionCall.args,
      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {})
    }, `Provider completed function call ${calls.length}`));
  }
  return { content, toolCalls: normalizeToolCalls(calls) };
}

function normalizeToolCalls(value: unknown): NormalizedToolCall[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError('Provider toolCalls must be an array.');
  const normalized: NormalizedToolCall[] = [];
  const byProviderCallId = new Map<string, { signature: string; index: number }>();
  const byExplicitOrdinal = new Map<number, number>();
  const explicitOrdinalByIndex: Array<number | undefined> = [];
  value.forEach((entry, index) => {
    const record = requireRecord(entry as PlainJsonValue, `Provider toolCall ${index}`);
    const name = requireText(record.name, `Provider toolCall ${index}.name`);
    let argumentsValue = record.arguments;
    if (typeof record.argumentsJson === 'string') {
      argumentsValue = normalizePlainJson(JSON.parse(record.argumentsJson), `Provider toolCall ${index}.argumentsJson`);
    }
    const providerCallId = optionalText(record.id);
    const explicitOrdinal = optionalNonNegativeInteger(record.ordinal);
    const providerOrdinal = explicitOrdinal ?? index;
    const call: NormalizedToolCall = {
      ...(providerCallId ? { providerCallId } : {}),
      providerOrdinal,
      name,
      arguments: normalizePlainJson(argumentsValue ?? {}, `Provider toolCall ${index}.arguments`),
      ...(optionalText(record.thoughtSignature) ? { thoughtSignature: optionalText(record.thoughtSignature) } : {})
    };
    const signature = canonicalPlainJson({
      name: call.name,
      arguments: call.arguments
    }, 'Provider toolCall signature');
    const idIdentity = providerCallId ? byProviderCallId.get(providerCallId) : undefined;
    const ordinalIdentity = explicitOrdinal === undefined ? undefined : byExplicitOrdinal.get(explicitOrdinal);
    if (idIdentity !== undefined && ordinalIdentity !== undefined && idIdentity.index !== ordinalIdentity) {
      throw new Error(
        `Provider tool call id ${providerCallId} and ordinal ${explicitOrdinal} identify different calls.`
      );
    }
    const existingIndex = idIdentity?.index ?? ordinalIdentity;
    if (existingIndex !== undefined) {
      const prior = normalized[existingIndex];
      if (prior.providerCallId && providerCallId && prior.providerCallId !== providerCallId) {
        throw new Error(
          `Provider reused tool call ordinal ${explicitOrdinal} for ids ${prior.providerCallId} and ${providerCallId}.`
        );
      }
      const priorSignature = canonicalPlainJson({
        name: prior.name,
        arguments: prior.arguments
      }, 'Provider prior toolCall signature');
      if (priorSignature !== signature) {
        const identity = providerCallId ? `id ${providerCallId}` : `ordinal ${explicitOrdinal}`;
        throw new Error(`Provider reused tool call ${identity} with conflicting content.`);
      }
      const priorExplicitOrdinal = explicitOrdinalByIndex[existingIndex];
      if (
        explicitOrdinal !== undefined
        && priorExplicitOrdinal !== undefined
        && priorExplicitOrdinal !== explicitOrdinal
      ) {
        throw new Error(`Provider reused tool call id ${providerCallId} with ordinal ${explicitOrdinal}.`);
      }
      if (prior.thoughtSignature && call.thoughtSignature && prior.thoughtSignature !== call.thoughtSignature) {
        const identity = providerCallId ? `id ${providerCallId}` : `ordinal ${explicitOrdinal}`;
        throw new Error(`Provider reused tool call ${identity} with conflicting thoughtSignature.`);
      }
      if (!prior.providerCallId && providerCallId) {
        prior.providerCallId = providerCallId;
        byProviderCallId.set(providerCallId, { signature, index: existingIndex });
      }
      if (priorExplicitOrdinal === undefined && explicitOrdinal !== undefined) {
        prior.providerOrdinal = explicitOrdinal;
        explicitOrdinalByIndex[existingIndex] = explicitOrdinal;
        byExplicitOrdinal.set(explicitOrdinal, existingIndex);
      }
      if (!prior.thoughtSignature && call.thoughtSignature) prior.thoughtSignature = call.thoughtSignature;
      return;
    }
    if (providerCallId) byProviderCallId.set(providerCallId, { signature, index: normalized.length });
    if (explicitOrdinal !== undefined) byExplicitOrdinal.set(explicitOrdinal, normalized.length);
    explicitOrdinalByIndex.push(explicitOrdinal);
    normalized.push(call);
  });
  const ordinals = new Set<number>();
  for (const call of normalized) {
    if (ordinals.has(call.providerOrdinal)) {
      throw new Error(`Provider repeated tool call ordinal ${call.providerOrdinal}.`);
    }
    ordinals.add(call.providerOrdinal);
  }
  return normalized;
}

function isToolPause(
  value: ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled
): value is ReliableAgentToolPause {
  return 'disposition' in value && value.disposition === 'paused';
}

/** Reads the frozen native capability decision of one ordinary recipe; undefined on the old path. */
function readFrozenNativeCapabilities(
  recipe: { [key: string]: PlainJsonValue }
): OpenAIResponsesNativeCapabilities | undefined {
  const record = asRecord(recipe.nativeResponses);
  if (!record) return undefined;
  const capabilities: OpenAIResponsesNativeCapabilities = {
    asyncTools: record.asyncTools === true,
    steering: record.steering === true,
    reasoningUpdates: record.reasoningUpdates === true,
    multiplexing: record.multiplexing === true,
    explicitCaching: record.explicitCaching === true
  };
  return capabilities.asyncTools || capabilities.steering || capabilities.reasoningUpdates
    ? capabilities
    : undefined;
}

function readFrozenNativeLogicalBudget(
  recipe: { [key: string]: PlainJsonValue }
): NativeLogicalRequestBudget {
  const budget = asRecord(recipe.nativeLogicalBudget);
  if (!budget || !Number.isSafeInteger(budget.planningInputCapacityTokens)
    || (budget.planningInputCapacityTokens as number) < 0
    || !Number.isSafeInteger(budget.compressionThresholdTokens)
    || (budget.compressionThresholdTokens as number) <= 0
    || typeof budget.autoCompressionEnabled !== 'boolean') {
    throw new Error('Native ModelRequest has no valid frozen full-request safety budget.');
  }
  return {
    planningInputCapacityTokens: budget.planningInputCapacityTokens as number,
    compressionThresholdTokens: budget.compressionThresholdTokens as number,
    autoCompressionEnabled: budget.autoCompressionEnabled as boolean
  };
}

function providerToolCallId(modelRequestId: string, call: NormalizedToolCall): string {
  return stableId(
    'tool_call',
    modelRequestId,
    String(call.providerOrdinal),
    call.providerCallId ?? call.name
  );
}

function normalizeFrozenToolDefinition(value: PlainJsonValue, index: number): ReliableAgentToolDefinition {
  const record = requireRecord(value, `ModelRequest recipe.tools[${index}]`);
  return {
    name: requireText(record.name, `ModelRequest recipe.tools[${index}].name`),
    description: optionalText(record.description),
    parameters: normalizePlainJson(record.parameters ?? {}, `ModelRequest recipe.tools[${index}].parameters`),
    ...(record.source !== undefined
      ? { source: normalizePlainJson(record.source, `ModelRequest recipe.tools[${index}].source`) }
      : {}),
    ...(record.metadata !== undefined
      ? { metadata: normalizePlainJson(record.metadata, `ModelRequest recipe.tools[${index}].metadata`) }
      : {}),
    ...(record.defaultConfig !== undefined
      ? { defaultConfig: normalizePlainJson(record.defaultConfig, `ModelRequest recipe.tools[${index}].defaultConfig`) }
      : {})
  };
}

function unknownToolDefinition(name: string): ReliableAgentToolDefinition {
  return {
    name,
    description: '',
    parameters: {},
    metadata: { defaultEnabled: false }
  };
}

function fallbackFrozenToolPolicy(
  definition: ReliableAgentToolDefinition,
  argumentsValue: PlainJsonValue
): FrozenToolCallPolicyDecision {
  const metadata = asRecord(definition.metadata);
  const args = asRecord(argumentsValue);
  const requestedScheduling = args?.scheduling === 'parallel' || args?.scheduling === 'serial'
    ? args.scheduling
    : undefined;
  const trustedCommand = definition.name === 'bash' || definition.name === 'shell'
    ? classifyCommandCall(argumentsValue)
    : undefined;
  const backendParallel = trustedCommand
    ? trustedCommand.parallelSafe
    : (definition.name === 'run_agent' && isReadonlyRunAgentOperation(args))
      || isReadonlyAgentCollaborationTool(definition.name)
      || isReadonlyCrossConversationTool(definition.name)
      || (definition.name === 'agent_board' && isReadonlyAgentBoardOperation(args))
      || metadata?.readonly === true || metadata?.riskLevel === 'read';
  const schedulingMode = requestedScheduling === 'serial'
    ? 'serial'
    : requestedScheduling === 'parallel' || backendParallel ? 'parallel' : 'serial';
  const supportsChangeApply = metadata?.supportsChangeApply === true;
  const automaticChangeApply = supportsChangeApply && metadata?.defaultAutoApplyChange === true;
  const configuredDelay = optionalNonNegativeInteger(metadata?.defaultAutoApplyChangeDelaySeconds) ?? 0;
  return {
    displayAutoExpand: metadata?.defaultAutoExpand === true,
    displayAutoOpenDiff: metadata?.defaultAutoOpenDiffPreview === true,
    executionGate: ['ask_user', 'submit_plan'].includes(definition.name)
      || metadata?.defaultAutoApproveExecution !== false
      ? 'automatic'
      : 'approval_required',
    changeApplyMode: supportsChangeApply
      ? automaticChangeApply ? 'automatic' : 'manual'
      : 'unsupported',
    changeApplyDelaySeconds: automaticChangeApply ? Math.min(configuredDelay, 600) : 0,
    autoSubmitResult: metadata?.defaultAutoSubmitResult !== false,
    schedulingMode,
    schedulingReason: requestedScheduling === 'serial'
      ? 'model_selected_serial'
      : requestedScheduling === 'parallel'
        ? 'model_selected_parallel'
      : backendParallel
        ? trustedCommand?.reason ?? 'frozen_readonly_metadata'
        : trustedCommand?.reason ?? 'frozen_default_serial'
  };
}

function frozenPolicyFromRow(row: DomainRow): FrozenToolCallPolicyDecision {
  const executionGate = String(row.execution_gate);
  const changeApplyMode = String(row.change_apply_mode);
  const schedulingMode = String(row.scheduling_mode);
  if (!['automatic', 'approval_required'].includes(executionGate)) {
    throw new TypeError(`Invalid frozen Tool execution gate: ${executionGate}.`);
  }
  if (!['automatic', 'manual', 'unsupported'].includes(changeApplyMode)) {
    throw new TypeError(`Invalid frozen Tool change-apply mode: ${changeApplyMode}.`);
  }
  if (!['parallel', 'serial'].includes(schedulingMode)) {
    throw new TypeError(`Invalid frozen Tool scheduling mode: ${schedulingMode}.`);
  }
  return {
    ...(typeof row.summary === 'string' ? { summary: row.summary } : {}),
    displayAutoExpand: row.display_auto_expand === 1n,
    displayAutoOpenDiff: row.display_auto_open_diff === 1n,
    executionGate: executionGate as FrozenToolCallPolicyDecision['executionGate'],
    changeApplyMode: changeApplyMode as FrozenToolCallPolicyDecision['changeApplyMode'],
    changeApplyDelaySeconds: requireNonNegativeSafeNumber(
      row.change_apply_delay_seconds,
      'ToolCallPolicySnapshot.change_apply_delay_seconds'
    ),
    autoSubmitResult: row.auto_submit_result === 1n,
    schedulingMode: schedulingMode as FrozenToolCallPolicyDecision['schedulingMode'],
    ...(typeof row.scheduling_reason === 'string' ? { schedulingReason: row.scheduling_reason } : {})
  };
}

function requireNonNegativeSafeNumber(value: unknown, label: string): number {
  const bigint = typeof value === 'bigint'
    ? value
    : typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value)
      : typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value) ? BigInt(value)
        : -1n;
  if (bigint < 0n || bigint > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return Number(bigint);
}

function rows(value: DomainRow | DomainRow[] | null): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError('Repository list did not return rows.');
  return value;
}

function requireRow(value: DomainRow | DomainRow[] | null, label: string): DomainRow {
  if (!value || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value;
}

function requireRecord(value: PlainJsonValue, label: string): { [key: string]: PlainJsonValue } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object.`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function reliableDecimal(value: unknown): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return BigInt(value);
  return 0n;
}

function requirePositiveInteger(value: unknown, label: string): bigint {
  const normalized = reliableDecimal(value);
  if (normalized < 1n) throw new TypeError(`${label} must be a positive integer.`);
  return normalized;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function recipeHasOpenTaskCompletionCheck(recipe: Record<string, unknown>): boolean {
  return asRecord(recipe.openTaskCompletionCheck)?.kind === OPEN_TASK_COMPLETION_CHECK_KIND;
}

export function decideOpenTaskCompletion(
  recipe: PlainJsonValue,
  completionCheckConsumed: boolean
): OpenTaskCompletionAction {
  const task = asRecord(asRecord(recipe)?.turnTaskCard);
  const counts = asRecord(task?.counts);
  const unfinished = optionalNonNegativeInteger(counts?.unfinished) ?? 0;
  if (unfinished === 0) return 'complete';
  return completionCheckConsumed ? 'complete_with_open_tasks' : 'continue_once';
}

function currentInputReferenceTokens(recipe: PlainJsonValue): number {
  const record = asRecord(recipe);
  const currentInput = asRecord(record?.currentTurnInput);
  return optionalNonNegativeInteger(currentInput?.estimatedTokens) ?? 0;
}

function compareInteger(left: unknown, right: unknown): number {
  const a = reliableDecimal(left);
  const b = reliableDecimal(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function stableId(kind: string, ...parts: string[]): string {
  return `rk_${kind}_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`;
}

function stableDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function errorDiagnostic(error: unknown): Pick<ReliableAgentLifecycleEvent, 'errorName' | 'errorMessage'> {
  return {
    errorName: error instanceof Error ? error.name : 'NonError',
    errorMessage: errorMessage(error, 500)
  };
}

function errorMessage(error: unknown, maxLength = 2_000): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= maxLength ? message : `${message.slice(0, Math.max(0, maxLength - 3))}...`;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty id.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}
