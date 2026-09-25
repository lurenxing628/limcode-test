import { readRequestTurnAuthority } from './requestCompressionSettings';

import {
  buildModelHandleCatalog,
  modelHandleEntries,
  modelHandleRef,
  normalizeModelHandleCatalog,
  resolveModelToolArguments,
  UnknownModelHandleReferenceError,
  type ModelHandleCatalog,
  type ModelHandleEntry
} from './modelHandleCatalog';
import { forkInheritedChildTargets, forkSourceConversationIds, isForkConversation, readConversationChildHandles } from './conversationChildHandles';
import { readConversationChildTaskProjection } from './conversationChildTaskProjection';
import { isReadonlyAgentCollaborationTool } from '../world/modules/tools/definitions/agentCollaboration';
import { isReadonlyCrossConversationTool } from '../world/modules/tools/definitions/crossConversation';
import { isReadonlyAgentBoardOperation } from '../world/modules/tools/definitions/agentBoard';
import { isReadonlyRunAgentOperation } from '../world/modules/tools/definitions/runAgent';
import { createHash } from 'node:crypto';
import type {
  LlmOpenAIResponsesTransport,
  LlmProviderKind,
  MessageContent
} from '../../shared/protocol';
import { mapSettledWithBoundedConcurrency } from '../capabilities/boundedConcurrency';
import { classifyCommandCall } from '../world/modules/tools/definitions/command';
import type { RuntimeDeliveryControlPlane } from './answerDelivery';
import { AutomaticRuntimeDeliveryRouter } from './automaticRuntimeDelivery';
import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { ContextSequenceControlPlane } from './contextSequence';
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
  ModelRequestPreflightError,
  ModelProviderControlPlane,
  modelRequestIdFor,
  PROVIDER_PARTIAL_OUTPUT_SNAPSHOT_TYPE,
  type FullRequestProviderAdapter,
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
  nativePhysicalResponseBudgetPressure,
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
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';
import {
  isTurnTerminalGuidanceConflictError,
  isTurnTerminalInputConflictError,
  TurnControlPlane,
  type TurnInputCommand
} from './turnControlPlane';
import { frozenCompressionPolicy, readFrozenTurnAuthority } from './frozenAuthority';
import { assistantMessageIdFor, TurnOutputControlPlane } from './turnOutput';
import { ExecutionHandoffError, isExecutionHandoffError } from './executionLeaseFence';
import type {
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

export interface ReliableAgentLoopResult {
  turnId: string;
  terminalStatus: 'completed' | 'failed' | 'interrupted' | 'waiting';
  modelRequestIds: string[];
  assistantMessageIds: string[];
  toolCallIds: string[];
  waitingToolCallId?: string;
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

interface CurrentTurnRequestState {
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
    kind: 'runtime_status_card', activeChildCount: 0, runningProcessCount: 0, childTaskRevision: 'none',
    totalChildCount: 0, descendantCount: 0, queuedInputCount: 0, awaitingHandlingCount: 0,
    childHandleTargets: [], children: [], processes: [], card: heading
  };
}

interface FrozenRuntimeStatusCard {
  kind: 'runtime_status_card';
  activeChildCount: number;
  runningProcessCount: number;
  childTaskRevision: string;
  totalChildCount: number;
  descendantCount: number;
  queuedInputCount: number;
  awaitingHandlingCount: number;
  /** Identity candidates include omitted rows; the provider sees only stable short references. */
  childHandleTargets: Array<{ answerBridgeId: string }>;
  /** Child refs a fork copied from its source history; listed as not operable from this Conversation. */
  inheritedChildTargets?: string[];
  children: Array<{
    childExecutionId: string;
    answerBridgeId: string;
    status: string;
    task: string;
    label: string;
    initialTask?: string;
    currentTasks: string[];
    queuedTasks: string[];
    currentInputCount: number;
    queuedInputCount: number;
    truncated: boolean;
    latestTurnOutcome?: string;
    answerAvailable: boolean;
    answerHandling: 'handled' | 'runtime_pending' | 'tool_result' | 'failed' | 'unknown';
    resumable: boolean;
  }>;
  processes: Array<{ processId: string; status: 'running' }>;
  card: string;
}

interface AgentLoopResumeState {
  requestSequence: bigint;
  openTaskCompletionCheckConsumed: boolean;
}

export type OpenTaskCompletionAction = 'complete' | 'continue_once' | 'complete_with_open_tasks';

const MESSAGE_CONTENT_TYPE = 'application/vnd.limcode.message+json';
const RUNTIME_STATUS_RECIPE_LIMIT = 32;
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
  private readonly context: ContextSequenceControlPlane;
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

  /** Safe for explicit recovery/re-entry; every round and output identity is deterministic. */
  public async drive(turnIdInput: string): Promise<ReliableAgentLoopResult> {
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
          const settingsSnapshotContentObjectId = await this.modelProvider.freezeRequestSettings(
            turnId, requireId(facts.authority.id, 'AuthoritySnapshot.id')
          );
          let frozenRecipe = await this.freezeOrdinaryRequestRecipe({
            settingsSnapshotContentObjectId,
            turnId,
            round,
            headRootId: requireId(facts.head.root_id, 'ConversationContextHeadLink.root_id'),
            authoritySnapshotId: requireId(facts.authority.id, 'AuthoritySnapshot.id'),
            tools: toolDefinitions,
            includeOpenTaskCompletionCheck
          });
          let preview = await this.modelProvider.previewOrdinaryRequest({
            turnId,
            settingsSnapshotContentObjectId,
            contextRootId: requireId(facts.head.root_id, 'ConversationContextHeadLink.root_id'),
            authoritySnapshotId: requireId(facts.authority.id, 'AuthoritySnapshot.id'),
            recipe: frozenRecipe,
            idempotencyKey
          });
          let previewAdapter = await this.providers.resolve(preview.providerId);
          if (previewAdapter.providerId !== preview.providerId) {
            throw new Error(`Provider registry returned ${previewAdapter.providerId} for ${preview.providerId}.`);
          }
          let planningBudget = this.modelProvider.planFullRequest(preview, previewAdapter);
          // Full-request tokenization is model-independent planning data. Compression admission is
          // level-triggered by the Provider-observed Context estimate; ordinary sending is never
          // rejected solely because this heuristic estimate is high.
          const compression = await this.compressionCoordinator.coordinate({
            turnId,
            settingsSnapshotContentObjectId,
            authoritySnapshotId: requireId(facts.authority.id, 'AuthoritySnapshot.id'),
            headRootId: requireId(facts.head.root_id, 'ConversationContextHeadLink.root_id'),
            trigger: 'auto',
            requestBudget: planningBudget,
            protectedCurrentInputTokens: currentInputReferenceTokens(frozenRecipe),
            modelHandleCatalog: normalizeModelHandleCatalog(asRecord(frozenRecipe)?.modelHandleCatalog),
            tools: toolDefinitions
          });
          if (compression.status === 'error') {
            throw new ModelRequestPreflightError(
              compression.code,
              `${compression.code}: ${compression.message}`,
              compression.estimatedTokens,
              compression.limitTokens
            );
          }
          if (compression.status === 'compressed') {
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
            preview = await this.modelProvider.previewOrdinaryRequest({
              turnId,
              settingsSnapshotContentObjectId,
              contextRootId: requireId(facts.head.root_id, 'ConversationContextHeadLink.root_id'),
              authoritySnapshotId: requireId(facts.authority.id, 'AuthoritySnapshot.id'),
              recipe: frozenRecipe,
              idempotencyKey
            });
            previewAdapter = await this.providers.resolve(preview.providerId);
            if (previewAdapter.providerId !== preview.providerId) {
              throw new Error(`Provider registry returned ${previewAdapter.providerId} for ${preview.providerId}.`);
            }
            planningBudget = this.modelProvider.planFullRequest(preview, previewAdapter);
          }
          if ((compression.status === 'compressed' || compression.status === 'continued_uncompressed')
            && compression.recoveryDecision) {
            frozenRecipe = normalizePlainJson({
              ...(frozenRecipe as { [key: string]: PlainJsonValue }),
              compressionDecision: compression.recoveryDecision
            }, 'Request compression recovery decision');
          }
          if (readFrozenNativeCapabilities(requireRecord(frozenRecipe, 'Native request recipe'))) {
            const compressionPolicy = frozenCompressionPolicy(preview.authoritySnapshot);
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
              if (previous && previous.provider_id === preview.providerId && previous.model_id === preview.modelId) {
                const observed = await this.modelProvider.readNativeLatestResponseUsage(previousId);
                const previousStream = asRecord(previous.stream_stats_json);
                if (observed?.inputTokens !== undefined
                  && observed.attemptSeq === String(previousStream?.attemptSeq)
                  && observed.socketGeneration === String(previousStream?.socketGeneration)
                  && nativePhysicalResponseBudgetPressure({
                    budget: nativeBudget,
                    physicalInputTokens: observed.inputTokens,
                    // The eighth physical response is a periodic preflight checkpoint, not by
                    // itself evidence that its input is near capacity. Only actual raw input may
                    // force a refusal when the user disabled compression.
                    physicalResponseCount: 1
                  }) && (compression.status !== 'compressed'
                    || nativePhysicalResponseBudgetPressure({
                      budget: nativeBudget,
                      physicalInputTokens: planningBudget.estimatedFullInputTokens,
                      physicalResponseCount: 1
                    }))) {
                  // A committed compression still needs to leave planning headroom. Never send a
                  // growing raw input a second time or enable a user-disabled method implicitly.
                  throw new NativeRequestBudgetError(observed.inputTokens,
                    nativeBudget.planningInputCapacityTokens);
                }
              }
            }
          }
          await this.guardNativeModelSwitch(
            requireId(facts.turn.conversation_id, 'Turn.conversation_id'),
            preview.providerId,
            preview.modelId
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
        let output: NormalizedProviderOutput;
        if (request.status === 'terminal') {
          output = await this.readTerminalProviderOutput(modelRequestId);
        } else {
          this.observeLifecycle({ turnId, stage: 'provider_dispatch_started', round, modelRequestId });
          output = await this.dispatchAndCapture(
            requireId(facts.turn.conversation_id, 'Turn.conversation_id'),
            turnId,
            modelRequestId,
            request
          );
        }
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
    const [currentTurnState, runtimeStatus, turnTaskCard, previousTaskCard, nativeFreeze] = await Promise.all([
      this.readCurrentTurnInputReference(input.turnId, input.headRootId),
      this.readRuntimeStatusCard(input.turnId),
      readCurrentTurnTaskCard(this.database, this.contentStore, input.turnId),
      this.readPreviousTaskCardReminderStateForRound(input.turnId, input.round),
      this.readNativeRecipeFreeze(input)
    ]);
    const runtimeStatusCard = runtimeStatus.statusCard;
    const materialized = await this.context.materialize(input.headRootId);
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
    const handleSources: unknown[] = [
      ...materialized.segments.map((segment) => Buffer.from(segment.content).toString('utf8')),
      attachmentCatalogState.catalog,
      ...(runtimeStatusCard ? [runtimeStatusCard] : []),
      input.tools
    ];
    if (currentTurnState.reference) {
      const inputContentObject = await this.requireExisting(
        'ContentObject',
        currentTurnState.reference.contentObjectId
      ) as unknown as ContentObjectMetadata;
      handleSources.push((await this.contentStore.read(inputContentObject)).toString('utf8'));
    }
    const seeds = [...attachmentHandles.entries, ...runtimeStatus.childHandles];
    let modelHandleCatalog = buildModelHandleCatalog(handleSources, seeds);
    const forkIdentity = runtimeStatus.forkIdentity;
    const inheritedCollaboration = forkIdentity ? forkInheritedCollaborationTargets(modelHandleCatalog, forkIdentity) : undefined;
    if (forkIdentity && inheritedCollaboration) {
      // The fork's own address joins the catalog so the model can tell itself from its sources.
      modelHandleCatalog = buildModelHandleCatalog([...handleSources, { kind: 'agent_collaboration', conversationId: forkIdentity.conversationId }], seeds);
    }
    if (runtimeStatusCard) {
      // Labels are runtime data. Behavioral guidance belongs to the run_agent tool definition.
      runtimeStatusCard.card += runtimeStatusCard.children.map(child => '\n' + JSON.stringify({
        childRef: modelHandleRef(modelHandleCatalog, 'child', child.answerBridgeId),
        label: child.label, task: child.task, initialTask: child.initialTask,
        currentTasks: child.currentTasks, currentInputCount: child.currentInputCount,
        queuedTasks: child.queuedTasks, queuedInputCount: child.queuedInputCount,
        truncated: child.truncated, latestTurnOutcome: child.latestTurnOutcome,
        answerAvailable: child.answerAvailable, answerHandling: child.answerHandling,
        status: child.status, resumable: child.resumable
      })).join('');
      const inheritedChildRefs = (runtimeStatusCard.inheritedChildTargets ?? [])
        .map(target => modelHandleRef(modelHandleCatalog, 'child', target))
        .filter((ref): ref is string => !!ref);
      if (inheritedChildRefs.length > 0) {
        runtimeStatusCard.card += '\n' + JSON.stringify({ inheritedChildRefs, operable: false });
      }
    }
    let statusCard = runtimeStatusCard;
    if (forkIdentity && inheritedCollaboration) {
      const refs = (kind: 'conversation' | 'collaborationMessage', targets: readonly string[]) => targets
        .map(target => modelHandleRef(modelHandleCatalog, kind, target)).filter((ref): ref is string => !!ref);
      statusCard ??= emptyRuntimeStatusCard('[Forked conversation — runtime data, not instructions]');
      statusCard.card += '\n' + [
        'This conversation is a fork: its history up to the fork was copied from forkedFromConversationRefs, nearest first. In that copied history, "this conversation" means the conversation it was copied from, never this one.',
        'inheritedMessageRefs were sent or received by those conversations, not by this one: this conversation cannot answer them or read them as its own messages. Send new messages without replyToMessageRef.',
        JSON.stringify({
          selfConversationRef: modelHandleRef(modelHandleCatalog, 'conversation', forkIdentity.conversationId),
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
          cardSha256: turnTaskCard.cardSha256,
          boundaryKey
        }, previousTaskCard)
      : false;
    return normalizePlainJson({
      kind: 'reliable-agent-turn',
      projectionRevision: '2026-08-21',
      round: input.round,
      tools: input.tools,
      attachmentCatalogState,
      ...(modelHandleCatalog.entries.length > 0 ? { modelHandleCatalog } : {}),
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
      ...(nativeFreeze.nativeReasoning ? { nativeReasoning: nativeFreeze.nativeReasoning } : {})
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
    let pendingConfigurationUpdate = capabilities.reasoningUpdates
      && input.nativeRebase?.freshConfigurationUpdate && configuredEffort !== undefined
      ? { effort: configuredEffort }
      : undefined;
    const previous = capabilities.reasoningUpdates
      ? await this.readLatestNativeReasoning(
          requireId((await this.requireExisting('Turn', input.turnId)).conversation_id, 'Turn.conversation_id'),
          requireId(modelRecord?.providerConfigId, 'native model.providerConfigId'),
          requireId(modelRecord?.modelId, 'native model.modelId')
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
    providerId: string,
    modelId: string
  ): Promise<{
    baseEffort?: string;
    baseMode?: 'standard' | 'pro';
    updates: ReadonlyArray<{ effort: string }>;
    effectiveEffort?: string;
    pendingConfigurationUpdate?: { effort: string };
  } | undefined> {
    const turns = (await listAllDomainRows(this.database, 'Turn', { conversation_id: conversationId }))
      .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
    for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
      const requests = (await listAllDomainRows(this.database, 'ModelRequest', {
        turn_id: requireId(turns[turnIndex].id, 'Turn.id')
      })).sort((left, right) => compareInteger(right.request_seq, left.request_seq));
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
    const cardSha256 = typeof task?.cardSha256 === 'string' ? task.cardSha256 : undefined;
    const boundaryKey = typeof recipe.turnTaskCardBoundaryKey === 'string'
      ? recipe.turnTaskCardBoundaryKey
      : 'pre-compression';
    if (!revision || !cardSha256) return undefined;
    return { revision, cardSha256, boundaryKey };
  }

  private async readCurrentTurnInputReference(
    turnId: string,
    headRootId: string
  ): Promise<CurrentTurnRequestState> {
    const current = await this.context.materializeStructure(requireId(headRootId, 'headRootId'));
    const firstSegment = current.records[0]?.segment;
    const compressionBoundaryId = firstSegment?.segment_kind === 'compression'
      ? requireId(firstSegment.id, 'ContextSegment.id')
      : undefined;
    const inputLinks = await this.list('MessageTurnLink', { turn_id: turnId, role: 'input' }, 2);
    if (inputLinks.length === 0) return { compressionBoundaryId };
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
    /** Persistent child refs of the Conversation, read once for the recipe's handle catalog. */
    childHandles: ModelHandleEntry[];
    /** For a fork: what copied collaboration refs mean here, read once for the recipe. */
    forkIdentity?: ForkIdentityFacts;
  }> {
    const turn = await this.requireExisting('Turn', turnId);
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    const [projection, processLinks, childHandles, fork] = await Promise.all([
      readConversationChildTaskProjection(this.database, this.contentStore, conversationId),
      listAllDomainRows(this.database, 'ProcessCompletionSourceLink', { source_turn_id: turnId }),
      readConversationChildHandles(this.database, this.contentStore, conversationId),
      isForkConversation(this.database, conversationId)
    ]);
    const inheritedChildTargets = fork
      ? forkInheritedChildTargets(childHandles, new Set(projection.tasks.map(task => task.answerBridgeId)))
      : [];
    const forkIdentity = fork ? await this.readForkIdentityFacts(conversationId) : undefined;
    const processSnapshot = processLinks.length === 0 ? null : await this.database.snapshot(processLinks.map(link =>
      DOMAIN_REPOSITORIES.domain('Process').get(requireId(link.process_id, 'ProcessCompletionSourceLink.process_id'))));
    const runningProcesses = (processSnapshot?.snapshot ?? []).flatMap(row =>
      row && !Array.isArray(row) && row.status === 'running'
        ? [{ processId: requireId(row.id, 'Process.id'), status: 'running' as const }]
        : []);
    const direct = projection.tasks.filter(task => task.depth === 1);
    if (direct.length === 0 && runningProcesses.length === 0 && inheritedChildTargets.length === 0) {
      return { childHandles, ...(forkIdentity ? { forkIdentity } : {}) };
    }
    const live = (status: string) => ['starting', 'active', 'interrupting'].includes(status);
    const pendingHandling = (task: typeof direct[number]) => task.result.deliveries.some(delivery =>
      delivery.state !== 'failed' && delivery.wakeState !== 'dead_letter' && delivery.phase !== 'notify_only'
      && !delivery.handledAt && delivery.targetConversationId === conversationId);
    const ranked = [...direct].sort((a, b) =>
      Number(live(b.status)) - Number(live(a.status))
      || Number(b.queuedInputs.length > 0) - Number(a.queuedInputs.length > 0)
      || Number(pendingHandling(b)) - Number(pendingHandling(a))
      || Number(a.status === 'closed') - Number(b.status === 'closed')
      || b.createdAt.localeCompare(a.createdAt) || a.childExecutionId.localeCompare(b.childExecutionId));
    const preview = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 180);
    const selected = ranked.slice(0, RUNTIME_STATUS_RECIPE_LIMIT);
    const children: FrozenRuntimeStatusCard['children'] = selected.map(task => {
      const current = task.currentInputs.filter(source => source.classification === 'task');
      const queued = task.queuedInputs.filter(source => source.classification === 'task');
      return {
        childExecutionId: task.childExecutionId, answerBridgeId: task.answerBridgeId,
        status: task.status, label: preview(task.label),
        task: preview(current[current.length - 1]?.text ?? task.initialTask?.text ?? ''),
        ...(task.initialTask ? { initialTask: preview(task.initialTask.text) } : {}),
        currentTasks: current.slice(-2).map(source => preview(source.text)),
        queuedTasks: queued.slice(0, 2).map(source => preview(source.text)),
        currentInputCount: current.length, queuedInputCount: queued.length,
        truncated: current.length > 2 || queued.length > 2
          || [task.initialTask, ...current, ...queued].some(source => source && source.text.replace(/\s+/g, ' ').trim().length > 180),
        ...(task.execution.termination ? { latestTurnOutcome: task.execution.termination.status } : {}),
        answerAvailable: !!task.result.latestAnswer,
        answerHandling: task.result.handling.some(item => item.answerId === task.result.latestAnswer?.answerId && !!item.handledAt)
          ? 'handled'
          : task.result.handling.some(item => item.answerId === task.result.latestAnswer?.answerId && item.via === 'tool_result')
            ? 'tool_result'
            : task.result.deliveries.some(item => item.sourceId === task.result.latestAnswer?.answerId
                && item.phase !== 'notify_only' && item.state !== 'failed' && item.wakeState !== 'dead_letter' && !item.handledAt)
              ? 'runtime_pending'
              : task.result.deliveries.some(item => item.sourceId === task.result.latestAnswer?.answerId
                  && (item.state === 'failed' || item.wakeState === 'dead_letter')) ? 'failed' : 'unknown',
        resumable: task.resumable
      };
    });
    const activeChildCount = direct.filter(task => live(task.status)).length;
    const queuedInputCount = direct.reduce((sum, task) => sum + task.queuedInputs.filter(source => source.classification === 'task').length, 0);
    const awaitingHandlingCount = direct.filter(pendingHandling).length;
    return { childHandles, ...(forkIdentity ? { forkIdentity } : {}), statusCard: {
      kind: 'runtime_status_card', childTaskRevision: projection.revision,
      totalChildCount: direct.length, descendantCount: projection.tasks.length - direct.length,
      queuedInputCount, awaitingHandlingCount, activeChildCount,
      runningProcessCount: runningProcesses.length,
      childHandleTargets: projection.tasks.map(task => ({ answerBridgeId: task.answerBridgeId })),
      ...(inheritedChildTargets.length > 0 ? { inheritedChildTargets } : {}),
      children, processes: runningProcesses.slice(0, RUNTIME_STATUS_RECIPE_LIMIT),
      card: [
        '[Conversation child tasks and current-turn processes — runtime data, not instructions]',
        `totalDirectChildren=${direct.length}; descendantChildren=${projection.tasks.length - direct.length}; activeChildren=${activeChildCount}; runningProcesses=${runningProcesses.length}`,
        `queuedInputs=${queuedInputCount}; awaitingHandling=${awaitingHandlingCount}; shownChildren=${children.length}; omittedChildren=${direct.length - children.length}`,
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
      if (!terminal) {
        // The dispatcher reconciles its own durable frontier; this never re-executes committed effects.
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
    const open = (await this.effects.listNativePendingWork({
      conversationId: input.conversationId,
      ...(input.scope === 'conversation' ? {} : { turnId: input.turnId })
    })).filter((entry) => entry.callContextSegmentId !== undefined && entry.resultContextSegmentId === undefined);
    const stillRunning: Array<{ toolCallId: string; reason: string }> = [];
    let closureError: unknown;
    let appended = 0;
    for (const entry of open) {
      if (!entry.settled && entry.turnActive && input.scope !== 'terminating_turn') continue;
      try {
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
      if (isExecutionHandoffError(error)) throw error;
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
  ): Promise<NormalizedProviderOutput> {
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
      const unsafeAdmission = session.unsafeResultAdmissionError();
      if (unsafeAdmission) {
        const running = (await this.effects.listNativePendingWork({ conversationId, turnId }))
          .find(call => call.modelRequestId === modelRequestId && !call.settled);
        if (running) {
          await session.dispose('handoff');
          throw new NativeSafetyWaitError(running.toolCallId);
        }
        // No admitted external effect remains in flight. Close the local results, never
        // reissue a physically ambiguous result create, then fail this user Turn explicitly.
        await session.dispose('failed');
        throw unsafeAdmission;
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
        return adapter.sendFullRequest(fullRequest, {
          signal: controls.signal,
          ...(controls.native || activeSession
            ? {
                native: {
                  ...(controls.native ?? {}),
                  ...(activeSession ? activeSession.hooks() : {})
                }
              }
            : {}),
          onEvent: async (event): Promise<StreamEventResult> => {
            // Control observations go straight to durable control handling and the steering
            // subscription; they are never fed into the text transient replay.
            if (event.kind === 'native_control') {
              const result = await controls.onEvent(event);
              if (activeSession) await activeSession.afterNativeControl(event, result);
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
                noteNativeControl(fullRequest.attemptSeq, fullRequest.socketGeneration, event.streamSeq);
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
              attemptSeq: fullRequest.attemptSeq,
              socketGeneration: fullRequest.socketGeneration,
              afterCommitSeq: dispatchBarrier.snapshotCommitSeq,
              fromStreamSeq: visibleFromStreamSeq(fullRequest.attemptSeq, fullRequest.socketGeneration, event.streamSeq),
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
                    fullRequest.attemptSeq,
                    fullRequest.socketGeneration,
                    event.streamSeq,
                    proof
                  );
                  observe();
                  await activeSession.admitStreamedCall(callItem, event.streamSeq, result);
                  return result;
                }
                const result = await controls.onEvent(event);
                observe();
                await activeSession.admitStreamedContentItem(event, result);
                return result;
              }
            }
            // Streaming deltas are intentionally low-latency. A terminal visual state, however,
            // must never outrun the durable terminal checkpoint it claims to represent.
            if (event.kind === 'completed') {
              const result = await controls.onEvent(event);
              observe();
              return result;
            }
            observe();
            return controls.onEvent(event);
          }
        })
      }
    };
    const streamStats = asRecord(request.stream_stats_json);
    const reconnect = reliableDecimal(streamStats?.socketGeneration) > 0n || request.status === 'streaming';
    let outcome: 'completed' | 'failed' | 'cancelled' | 'handoff' = 'completed';
    try {
      await this.modelProvider.dispatch(modelRequestId, wrapped, {
        ...(reconnect ? { reconnect: true } : {}),
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
      outcome = isExecutionHandoffError(error)
        ? 'handoff'
        : error instanceof Error && error.name === 'AbortError'
          ? 'cancelled'
          : 'failed';
      throw error;
    } finally {
      if (session) {
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
    // The Provider may have accepted an ambiguous result/steer successor without furnishing
    // separate admission proofs. The physical chain has ended, its settled ToolModelResult was
    // durably closed into Context by dispose, but another automatic full request would risk
    // replaying a result that the Provider already consumed. Fail the Turn visibly instead.
    const unsafeAdmission = session?.unsafeResultAdmissionError();
    if (unsafeAdmission) throw unsafeAdmission;
    // The terminal CAS checkpoint is the only final output authority. The transient collector exists
    // solely to drive low-latency UI observation and must never become a second durable result path.
    return this.readTerminalProviderOutput(modelRequestId);
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
    const pending = (await this.effects.listNativePendingWork({ conversationId }))
      .filter((entry) => !entry.settled || entry.resultContextSegmentId === undefined);
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
  private async dispatchNativeCall(
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
      if (isExecutionHandoffError(error)) throw error;
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
    const pending = (await this.effects.listNativePendingWork({ conversationId }))
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
    modelRequestId: string | undefined
  ): Promise<string | undefined> {
    if (!modelRequestId) return undefined;
    const request = await this.maybeGet('ModelRequest', modelRequestId);
    if (
      !request
      || request.turn_id !== turnId
      || request.status !== 'terminal'
      || !isProviderFailureTerminalState(optionalText(request.terminal_state))
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
    const committed = await this.turnOutput.appendAssistantMessage({
      turnId,
      modelRequestId,
      sourceKey: `failed-partial:${modelRequestId}`,
      content: canonicalPlainJson(output.content, 'Failed partial Provider MessageContent'),
      contentType: MESSAGE_CONTENT_TYPE,
      contextDisposition: 'exclude'
    });
    return committed.messageId;
  }

  private async readTerminalProviderOutput(modelRequestId: string): Promise<NormalizedProviderOutput> {
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
    const requests = (await listAllDomainRows(this.database, 'ModelRequest', { turn_id: turnId }))
      .sort((left, right) => compareInteger(left.request_seq, right.request_seq));
    const recipes = await this.readModelRequestRecipes(requests);
    let expectedPhysicalSequence = 1n;
    let normalRound = 0n;
    let openTaskCompletionCheckConsumed = false;
    for (const request of requests) {
      const actual = requirePositiveInteger(request.request_seq, 'ModelRequest.request_seq');
      if (actual !== expectedPhysicalSequence) {
        throw new Error(`Turn ${turnId} ModelRequest sequence is not contiguous at ${expectedPhysicalSequence.toString()}.`);
      }
      const requestId = requireId(request.id, 'ModelRequest.id');
      const recipe = recipes.get(requestId);
      if (!recipe) throw new Error(`ModelRequest ${requestId} recipe batch lost its request.`);
      if (recipe.kind === 'reliable-agent-turn') {
        normalRound += 1n;
        openTaskCompletionCheckConsumed ||= recipeHasOpenTaskCompletionCheck(recipe);
        const round = requirePositiveInteger(recipe.round, 'ModelRequest recipe.round');
        if (round !== normalRound) {
          throw new Error(`Turn ${turnId} ordinary ModelRequest round is not contiguous at ${normalRound.toString()}.`);
        }
        const expectedId = modelRequestIdFor(turnId, `agent-loop:${turnId}:round:${normalRound.toString()}`);
        if (request.id !== expectedId) {
          throw new Error(`Turn ${turnId} ordinary ModelRequest ${normalRound.toString()} has an invalid identity.`);
        }
      } else if (recipe.kind !== 'reliable-context-compression') {
        throw new Error(`Turn ${turnId} ModelRequest ${String(request.id)} has unsupported recipe kind ${String(recipe.kind)}.`);
      }
      expectedPhysicalSequence += 1n;
    }
    return {
      requestSequence: normalRound === 0n ? 1n : normalRound,
      openTaskCompletionCheckConsumed
    };
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

  /** Preserves the full-history recipe audit while collapsing its SQLite and CAS round trips. */
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

  private async absorbRuntimeDeliveryInputs(turnId: string): Promise<number> {
    const deliveries = (await listAllDomainRows(this.database, 'RuntimeDelivery', {
      target_turn_id: turnId,
      phase: 'current_turn',
      state: 'pending'
    })).sort((left, right) =>
      String(left.created_at).localeCompare(String(right.created_at))
      || String(left.id).localeCompare(String(right.id))
    );
    for (const delivery of deliveries) {
      await this.runtimeDeliveries.advance(requireId(delivery.id, 'RuntimeDelivery.id'));
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
      const contentObjectId = requireId(input.content_object_id, 'PendingTurnInput.content_object_id');
      const metadata = await this.requireExisting('ContentObject', contentObjectId) as unknown as ContentObjectMetadata;
      const content = await this.contentStore.read(metadata);
      const projection = await this.runtimeDeliveries.projectInputForModel({
        pendingTurnInputId: inputId,
        contentObjectId,
        content,
        contentType: requireText(metadata.content_type, 'ContentObject.content_type')
      });
      if (!projection) {
        await this.runtimeDeliveries.markInputHandled(inputId);
        absorbed += 1;
        continue;
      }
      await this.context.appendContent({
        conversationId,
        segmentKind: 'runtime_context',
        source: {
          sourceKind: 'runtime_context',
          sourceId: inputId,
          // Runtime context identity is carried by the stable PendingTurnInput id. Unlike a
          // MessageRevision or tool call sequence it has no revision axis; ContextSequence's
          // source contract therefore requires the sentinel revision 0.
          sourceRevision: 0n
        },
        content: projection.content,
        contentType: projection.contentType
      });
      await this.runtimeDeliveries.markInputHandled(inputId);
      absorbed += 1;
    }
    return absorbed;
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
      await this.tools.cancelWaiting?.({
        turnId,
        sourceKey: `agent-loop:${turnId}:termination-request:${request.id}`,
        reason: `Turn observed ${String(request.input_kind)} at ${stage}.`
      });
      await this.closeInterruptedToolContext(turnId, requireId(request.id, 'PendingTurnInput.id'), pendingToolCallId);
      await this.absorbRuntimeDeliveryInputs(turnId);
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
   * order. This keeps the next Provider request canonical after interruption and is safe to replay.
   */
  private async closeInterruptedToolContext(
    turnId: string,
    terminationRequestId: string,
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
            `agent-loop:${turnId}:termination-request:${terminationRequestId}`
          );
          const operations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: toolCallId });
          if (operations.length === 0) {
            const settled = await this.effects.settleWithoutEffect({
              source: {
                kind: 'internal',
                key: `agent-loop:${turnId}:termination-request:${terminationRequestId}:cancel-tool:${toolCallId}`
              },
              toolCallId,
              status: 'cancelled',
              detail: { reason: 'turn_termination_requested' }
            });
            terminal = settled.terminal ?? null;
          } else {
            await this.effects.finalizeReadyInOrder(turnId);
            terminal = await this.effects.readTerminalResult(toolCallId, false)
              ?? await this.reconcileCommittedToolCall?.(toolCallId)
              ?? await this.effects.finalizeTerminalOperationsWithFallback({
                source: {
                  kind: 'internal',
                  key: `agent-loop:${turnId}:termination-request:${terminationRequestId}:close-effect:${toolCallId}`
                },
                toolCallId,
                detail: { reason: 'turn_termination_requested_after_effect_terminal' }
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
      sourcePrefix: `agent-loop:${turnId}:termination-request:${terminationRequestId}:native-closure`,
      scope: 'terminating_turn'
    });

    if (pendingToolCallId && !representedToolCallIds.has(pendingToolCallId)
      && !await this.effects.readTerminalResult(pendingToolCallId, false)) {
      await this.cancelUndispatchedToolEffects(
        pendingToolCallId,
        `agent-loop:${turnId}:termination-request:${terminationRequestId}`
      );
      const operations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: pendingToolCallId });
      if (operations.length === 0) {
        await this.effects.settleWithoutEffect({
          source: {
            kind: 'internal',
            key: `agent-loop:${turnId}:termination-request:${terminationRequestId}:cancel-unrepresented-tool:${pendingToolCallId}`
          },
          toolCallId: pendingToolCallId,
          status: 'cancelled',
          detail: { reason: 'turn_termination_requested' }
        });
      } else {
        await this.effects.finalizeReadyInOrder(turnId);
        const terminal = await this.effects.readTerminalResult(pendingToolCallId, false)
          ?? await this.reconcileCommittedToolCall?.(pendingToolCallId)
          ?? await this.effects.finalizeTerminalOperationsWithFallback({
            source: {
              kind: 'internal',
              key: `agent-loop:${turnId}:termination-request:${terminationRequestId}:close-effect:${pendingToolCallId}`
            },
            toolCallId: pendingToolCallId,
            detail: { reason: 'turn_termination_requested_after_effect_terminal' }
          });
        if (!terminal) await this.requireTerminalToolResult(pendingToolCallId);
      }
    }
  }

  /** A prepared Effect may be cancelled; a dispatched Effect must first produce/recover a Receipt. */
  private async cancelUndispatchedToolEffects(toolCallId: string, sourcePrefix: string): Promise<void> {
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
          detail: { reason: 'turn_termination_requested_before_effect_dispatch' }
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
      // A failed Provider chain may leave settled siblings of a still-open batch outside Context.
      await this.closeNativeResultOccurrences({
        conversationId: requireId(turn.conversation_id, 'Turn.conversation_id'),
        turnId,
        sourcePrefix: `agent-loop:${turnId}:failed:${stableDigest(reason)}:native-closure`,
        scope: 'terminating_turn'
      });
      await this.absorbRuntimeDeliveryInputs(turnId);
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
