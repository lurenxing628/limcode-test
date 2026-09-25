import type {
  AnswerBridgeId,
  AnswerSubmissionId,
  AttemptId,
  CallbackEventId,
  CommandId,
  ConversationId,
  EffectIntentId,
  ExecutionLeaseId,
  InteractionRequestId,
  InteractionResponseId,
  InvocationId,
  MessageId,
  MessageRevisionId,
  OperationId,
  PendingTurnInputId,
  RequestId,
  RunId,
  RuntimeInboxItemId,
  ToolCallId,
  TransitionId,
  TurnIntentId,
  TurnIntentRevisionId,
  AuthoritySnapshotId
} from './stableIds';
import type {
  TurnExecutionPhase,
  TurnLifecycleStatus
} from './turnLifecycle';

export const CONVERSATION_ATTACHMENTS_RESOURCE_KEY = 'conversation-attachments';
export const ANSWER_BRIDGE_LINKS_RESOURCE_KEY = 'answer-bridge-links';
/** Serializes immutable ToolResult blob admission with orphan sweeping; blobs themselves are not HEAD-owned. */
export const TOOL_RESULT_BLOBS_RESOURCE_KEY = 'tool-result-blobs';


export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type CommandScope =
  | { kind: 'conversation'; id: ConversationId }
  | { kind: 'multi_conversation'; ids: ConversationId[] };

export interface ExpectedConversationVersion {
  conversationId: ConversationId;
  version: number;
}

export interface CommandEnvelope<TPayload extends JsonValue = JsonValue> {
  commandId: CommandId;
  type: string;
  scope: CommandScope;
  expectedVersions: ExpectedConversationVersion[];
  issuedAt: number;
  payload: TPayload;
}

export interface InternalCommandEnvelope<TPayload extends JsonValue = JsonValue> {
  sourceKey: string;
  type: string;
  scope: CommandScope;
  occurredAt: number;
  payload: TPayload;
}

export interface CallbackEnvelope<TPayload extends JsonValue = JsonValue> {
  eventId: CallbackEventId;
  conversationId: ConversationId;
  operationId: OperationId;
  attemptId: AttemptId;
  generation: number;
  kind: string;
  occurredAt: number;
  payload: TPayload;
}

export interface CommittedConversationHead {
  conversationId: ConversationId;
  version: number;
  streamId: string;
  patchNextSeq: number;
}

export type CommandRejectionCode =
  | 'command_id_reused'
  | 'not_found'
  | 'invalid_state'
  | 'stale_version';

export type CommandAck<TResult extends JsonValue = JsonValue> =
  | {
      commandId: CommandId;
      transitionId: TransitionId;
      status: 'committed' | 'already_applied';
      /** Atomic durability proof for every conversation control HEAD touched by the transaction. */
      controlHeads: CommittedConversationHead[];
      /** Projection barriers actually emitted by this command; consumers wait only for views they own. */
      projectionHeads: CommittedConversationHead[];
      result: TResult;
    }
  | {
      commandId: CommandId;
      status: 'rejected';
      code: CommandRejectionCode;
      currentVersions?: ExpectedConversationVersion[];
      message: string;
    };

export interface CommandTransportReceipt {
  commandId: CommandId;
  status: 'received';
}

export interface CommandServiceError {
  commandId: CommandId;
  status: 'unavailable';
  code: 'storage_unavailable' | 'runtime_unavailable' | 'integrity_violation' | 'recovery_required' | 'migration_required';
  message: string;
  /** Proven no-WAL terminal failure; unlike recovery_required, this outcome is safe to dismiss/retry as a new command. */
  durable?: boolean;
}

export type CommandStatus =
  | { status: 'not_found' }
  | { status: 'in_progress'; transitionId: TransitionId }
  | { status: 'committed'; ack: CommandAck<JsonValue> }
  | { status: 'rejected'; ack: CommandAck<never> }
  | { status: 'failed'; error: CommandServiceError }
  | { status: 'blocked'; error: CommandServiceError };

export type ConversationStorageHeadDomain =
  | 'runtime'
  | 'timeline'
  | 'compression'
  | 'tool_calls'
  | 'tool_events'
  | 'tool_results'
  | 'interactions'
  | 'turns'
  | 'turn_intents'
  | 'execution_leases'
  | 'authority'
  | 'runtime_inbox';
export type StorageHeadKind = 'conversation-control' | 'conversation-domain' | 'resource';

/**
 * A control HEAD carries optimistic version/patch sequencing only. Domain/resource HEADs own
 * authoritative files only. The shapes intentionally share scalar fields so one WAL can atomically
 * advance several independent HEADs without re-coupling their ownership.
 */
export interface StorageHead {
  schemaVersion: 1;
  headKind: StorageHeadKind;
  headKey: string;
  conversationId?: ConversationId;
  domain?: ConversationStorageHeadDomain;
  resourceKey?: string;
  generation: number;
  latestTransitionId?: TransitionId;
  writerFencingToken: string;
  controlVersion: number;
  streamNextSeq: number;
  targetHashes: Record<string, string>;
}

export type RunGraphClosureMode = 'foreground' | 'background';

export interface DurableViewCompleteness {
  timelineRanges: Array<{
    conversationId: ConversationId;
    startSeq: number;
    endSeq: number;
    throughTail: boolean;
  }>;
  closedRunGraphRoots: RunId[];
  closedRunGraphModes: RunGraphClosureMode[];
  includedRelationFamilies: string[];
  storageHeadKeys: string[];
}

export interface DurableAggregateView<TFacts> {
  scopes: readonly ConversationId[];
  baseVersions: ReadonlyMap<ConversationId, number>;
  storageHeads: ReadonlyMap<string, StorageHead>;
  completeness: DurableViewCompleteness;
  facts: TFacts;
}

export interface DurableViewSpec<TView = unknown> {
  kind: string;
  conversations: readonly ConversationId[];
  timeline?: Array<{
    conversationId: ConversationId;
    fromMessageId?: MessageId;
    throughTail: boolean;
  }>;
  closedRunGraphRoots?: readonly RunId[];
  /** Child-edge modes proven closed inside the leased view; defaults to foreground. */
  closedRunGraphModes?: readonly RunGraphClosureMode[];
  relationFamilies: readonly string[];
  storageResourceKeys: readonly string[];
  /** Conversation roots that this transition is allowed to create from an empty committed view. */
  createMissingConversations?: readonly ConversationId[];
  /** File backend command views may merge leased conversation facts for graph-wide pure handlers. */
  mergeConversationFacts?: boolean;
  /** Root conversation whose scalar conversation record is exposed in a merged command view. */
  aggregateRootConversationId?: ConversationId;
  readonly __view?: TView;
}

export type RecordMutation =
  | { kind: 'upsert'; family: string; id: string; record: JsonValue }
  | { kind: 'remove'; family: string; id: string }
  | { kind: 'remove_many'; family: string; ids: string[] };

export interface TransientStreamEpoch {
  requestId: RequestId;
  attemptId: AttemptId;
  generation: number;
  streamSeq: number;
}

export interface PlannedPatchBatch<TPatch extends JsonValue = JsonValue> {
  conversationId: ConversationId;
  streamId: string;
  baseSeq: number;
  nextSeq: number;
  terminalStreamFences?: readonly TerminalStreamFence[];
  operations: readonly TPatch[];
}

export interface TransitionPlan<TResult extends JsonValue = JsonValue, TPatch extends JsonValue = JsonValue> {
  transitionId: TransitionId;
  scopes: readonly ConversationId[];
  baseVersions: ExpectedConversationVersion[];
  nextVersions: ExpectedConversationVersion[];
  recordMutations: readonly RecordMutation[];
  generatedIds: readonly string[];
  primaryEffectDescriptors: readonly PrimaryEffectDescriptor[];
  cleanupHints: readonly CleanupHint[];
  patches: readonly PlannedPatchBatch<TPatch>[];
  result: TResult;
}

export interface CommandPlanningContext<TIds extends Record<string, string> = Record<string, string>> {
  transitionId: TransitionId;
  now: number;
  ids: Readonly<TIds>;
  policySnapshot: JsonValue;
  /** Complete server-compiled authority for root Turn admission; never supplied by a client. */
  authoritySnapshot?: EffectiveTurnAuthority;
}

export interface CommandRejection {
  status: 'rejected';
  code: Exclude<CommandRejectionCode, 'command_id_reused'>;
  message: string;
}

export interface ConversationCommandHandler<TPayload extends JsonValue, TView, TResult extends JsonValue, TIds extends Record<string, string> = Record<string, string>> {
  requiredView(command: CommandEnvelope<TPayload>): DurableViewSpec<TView>;
  plan(
    view: DurableAggregateView<TView>,
    command: CommandEnvelope<TPayload>,
    context: CommandPlanningContext<TIds>
  ): TransitionPlan<TResult> | CommandRejection;
}

export interface InternalCommandNoop<TResult extends JsonValue = JsonValue> {
  status: 'stale' | 'already_satisfied';
  result: TResult;
}

export interface InternalCommandHandler<TPayload extends JsonValue, TView, TResult extends JsonValue, TIds extends Record<string, string> = Record<string, string>> {
  requiredView(command: InternalCommandEnvelope<TPayload>): DurableViewSpec<TView>;
  plan(
    view: DurableAggregateView<TView>,
    command: InternalCommandEnvelope<TPayload>,
    context: CommandPlanningContext<TIds>
  ): TransitionPlan<TResult> | InternalCommandNoop<TResult>;
}

export interface InternalTransitionResult<TResult extends JsonValue = JsonValue> {
  transitionId: TransitionId;
  status: 'committed' | 'already_applied' | 'stale' | 'already_satisfied';
  heads: CommittedConversationHead[];
  result: TResult;
  patches: readonly PlannedPatchBatch[];
}

export interface DurablePostimage {
  operation: 'write' | 'delete';
  targetRelativePath: string;
  stagingRelativePath?: string;
  preimageHash: string | null;
  postimageHash: string | null;
  bytes?: Uint8Array;
}

export interface DurableWriteBatch<TResult extends JsonValue = JsonValue, TPatch extends JsonValue = JsonValue> {
  transitionId: TransitionId;
  expectedStorageHeads: StorageHead[];
  postStorageHeads: StorageHead[];
  postimages: readonly DurablePostimage[];
  result: TResult;
  patches: readonly PlannedPatchBatch<TPatch>[];
}

export interface PreparedProjectionBatch {
  batchId: string;
  scopes: readonly ConversationId[];
  expectedProjectionVersions: ReadonlyMap<ConversationId, number>;
  committedStorageHeads: ReadonlyMap<string, StorageHead>;
  touchedStableIds: readonly string[];
  commitAtSchedulerSafePoint(): Promise<void>;
  /** Rebuilds the process-local projection from the already committed post-state; never writes storage. */
  rehydrateCommittedState(): Promise<void>;
  discard(): void;
}

export type OperationState =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'outcome_unknown';

export type AttemptState =
  | 'pending'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'timed_out'
  | 'outcome_unknown';

export type EffectRecoveryPolicy = 'resume_pending_if_safe' | 'interrupt_on_restart' | 'require_resolution';
export type TimeoutPolicy = 'retry_if_safe' | 'fail_run' | 'interrupt_run' | 'release_optional_barrier' | 'require_resolution';

export type DurableOperationOwner =
  | { ownerKind?: 'run'; ownerRunId: RunId }
  | { ownerKind: 'conversation'; ownerRunId?: undefined };

export type OperationRecord = DurableOperationOwner & {
  id: OperationId;
  conversationId: ConversationId;
  kind: string;
  state: OperationState;
  currentGeneration: number;
  rowVersion: number;
  timeoutPolicy: TimeoutPolicy;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  resolutionId?: string;
  error?: string;
};

export type AttemptRecord = DurableOperationOwner & {
  id: AttemptId;
  operationId: OperationId;
  conversationId: ConversationId;
  generation: number;
  state: AttemptState;
  deadlineAt: number;
  dispatchedAt?: number;
  completedAt?: number;
  streamEpoch?: string;
  rowVersion: number;
};

export interface SerializableEffectPayloadRef {
  /** `released` retains dispatch identity after a non-recoverable payload has left the hot control state. */
  kind: 'record' | 'context_snapshot' | 'input_revision' | 'released';
  id: string;
  hash: string;
}

export type DurableEffectPayloadRecord = DurableOperationOwner & {
  id: string;
  conversationId: ConversationId;
  operationId: OperationId;
  kind: string;
  payload: JsonValue;
  payloadHash: string;
  createdAt: number;
};

export type PrimaryEffectDescriptor = DurableOperationOwner & {
  effectIntentId: EffectIntentId;
  conversationId: ConversationId;
  operationId: OperationId;
  attemptId: AttemptId;
  generation: number;
  kind: string;
  idempotencyKey?: string;
  recoveryPolicy: EffectRecoveryPolicy;
  deadlineAt: number;
  payloadRef: SerializableEffectPayloadRef;
};

export interface CleanupHint {
  kind: 'llm_abort' | 'tool_abort' | 'checkpoint_gc' | 'blob_gc' | 'detached_delivery';
  conversationId: ConversationId;
  ownerId: string;
  payload?: JsonValue;
}

export interface TurnRecord {
  id: RunId;
  conversationId: ConversationId;
  lifecycle: TurnLifecycleStatus;
  phase: TurnExecutionPhase;
  rowVersion: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  retryOfRunId?: RunId;
}

export type TurnIntentState = 'queued' | 'admitted' | 'cancelled';
export type TurnIntentHold = 'none' | 'manual' | 'restored';

export interface TurnIntentRecord {
  id: TurnIntentId;
  conversationId: ConversationId;
  currentRevisionId: TurnIntentRevisionId;
  executionPresetRevisionId: string;
  order: number;
  hold: TurnIntentHold;
  state: TurnIntentState;
  rowVersion: number;
  createdAt: number;
  updatedAt: number;
  admittedTurnId?: RunId;
  admittedAt?: number;
  cancelledAt?: number;
}

export interface TurnIntentRevisionRecord {
  id: TurnIntentRevisionId;
  turnIntentId: TurnIntentId;
  content: JsonValue;
  contentHash: string;
  createdAt: number;
}

/** Frozen user-selected execution basis for a queued intent; live settings never mutate it. */
export interface TurnExecutionPresetRevisionRecord {
  id: string;
  turnIntentId: TurnIntentId;
  agentId: string;
  workflowId?: string;
  modelProfileId?: string;
  workEnvironmentId?: string;
  requestedAuthority: EffectiveTurnAuthority;
  contentHash: string;
  createdAt: number;
}

export type PendingTurnInputFallback = 'queue_next' | 'return_to_draft' | 'reject';
export type PendingTurnInputState = 'pending' | 'admitted' | 'cancelled' | 'rejected';

export interface PendingTurnInputRecord {
  id: PendingTurnInputId;
  conversationId: ConversationId;
  targetTurnId: RunId;
  targetLeaseEpoch: number;
  content: JsonValue;
  contentHash: string;
  fallback: PendingTurnInputFallback;
  state: PendingTurnInputState;
  rowVersion: number;
  createdAt: number;
  updatedAt: number;
  admittedMessageId?: MessageId;
  admittedAt?: number;
}

export interface ExecutionLeaseRecord {
  id: ExecutionLeaseId;
  conversationId: ConversationId;
  turnId: RunId;
  epoch: number;
  state: 'active' | 'interrupting' | 'released';
  acquiredAt: number;
  releasedAt?: number;
  rowVersion: number;
}

export interface EffectiveTurnAuthority {
  agent: JsonValue;
  workflow: JsonValue;
  model: JsonValue;
  systemPrompt: JsonValue;
  toolPolicy: JsonValue;
  skillPolicy: JsonValue;
  approvalPolicy: JsonValue;
  sandboxPolicy: JsonValue;
  networkPolicy: JsonValue;
  permissionProfile: JsonValue;
  runtimeContext: JsonValue;
  workEnvironment: JsonValue;
  executionPolicy: JsonValue;
}

export interface AuthoritySnapshotRecord {
  id: AuthoritySnapshotId;
  conversationId: ConversationId;
  turnId: RunId;
  authority: EffectiveTurnAuthority;
  authorityHash: string;
  derivation: 'root' | 'child' | 'continuation';
  createdAt: number;
}

export interface AuthorityDerivationLinkRecord {
  id: string;
  parentSnapshotId: AuthoritySnapshotId;
  childSnapshotId: AuthoritySnapshotId;
  parentTurnId: RunId;
  parentConversationId: ConversationId;
  childTurnId: RunId;
  childConversationId: ConversationId;
  overrideDigest: string;
  relation: 'equal' | 'restricted';
  createdAt: number;
}

export type RuntimeInboxItemKind =
  | 'child_answer_submitted'
  | 'child_terminal'
  | 'background_process_exited'
  | 'external_effect_completed'
  | 'timer_fired';

export interface RuntimeInboxItemRecord {
  id: RuntimeInboxItemId;
  kind: RuntimeInboxItemKind;
  sourceKind: 'turn' | 'child_turn' | 'background_process' | 'effect' | 'timer';
  sourceId: string;
  dedupeKey: string;
  payload: JsonValue;
  payloadHash: string;
  occurredAt: number;
  createdAt: number;
}

export type RuntimeDeliveryPolicy =
  | 'resume_owner'
  | 'inject_current_or_continue'
  | 'start_continuation_when_idle'
  | 'defer_until_next_user_turn'
  | 'notify_only';
export type RuntimeDeliveryState = 'pending' | 'delivering' | 'consumed' | 'failed';

export interface RuntimeDeliveryLinkRecord {
  id: string;
  inboxItemId: RuntimeInboxItemId;
  destinationConversationId: ConversationId;
  ownerTurnId?: RunId;
  targetTurnId?: RunId;
  policy: RuntimeDeliveryPolicy;
  state: RuntimeDeliveryState;
  rowVersion: number;
  createdAt: number;
  updatedAt: number;
  deliveringAt?: number;
  consumedAt?: number;
  failedAt?: number;
  error?: string;
}

export interface ChildTurnLinkRecord {
  id: string;
  parentTurnId: RunId;
  parentConversationId: ConversationId;
  childTurnId: RunId;
  childConversationId: ConversationId;
  mode: 'foreground' | 'background' | 'detached';
  completionPolicy: RuntimeDeliveryPolicy;
  sourceToolCallId?: ToolCallId;
  /** Foreground ownership deadline; removed when the link backgrounds or detaches. */
  foregroundDeadlineAt?: number;
  detachedAt?: number;
  detachedReason?: string;
  createdAt: number;
  rowVersion: number;
}

export type MessageTurnRole = 'input' | 'native_steer' | 'model' | 'tool_result' | 'tool_response' | 'notification';

export interface MessageTurnLinkRecord {
  id: string;
  messageId: MessageId;
  turnId: RunId;
  role: MessageTurnRole;
}

export interface InteractionOwnerLinkRecord {
  id: string;
  interactionRequestId: InteractionRequestId;
  turnId: RunId;
  conversationId: ConversationId;
  sourceToolCallId?: ToolCallId;
  createdAt: number;
}

export interface InteractionResponseRecord {
  id: InteractionResponseId;
  interactionRequestId: InteractionRequestId;
  interactionRevision: number;
  ownerTurnId: RunId;
  decision: DurableInteractionDecision;
  actor: DurableInteractionActor;
  actorId?: string;
  payload: JsonValue;
  payloadHash: string;
  commandId: string;
  createdAt: number;
}

export type DurableInteractionRequestKind =
  | 'exec_approval'
  | 'patch_approval'
  | 'result_review'
  | 'permission_request'
  | 'ask_user'
  | 'plan_review';

export type DurableInteractionDecision = 'accept' | 'reject' | 'submit' | 'cancel';
export type DurableInteractionActor = 'user' | 'policy' | 'reviewer' | 'system';

/**
 * A durable, identity-fenced decision request. The request owns decision state only; the ToolCall
 * owns execution lifecycle and EffectIntent owns the external side effect.
 */
export interface DurableInteractionRequestRecord {
  id: InteractionRequestId;
  revision: number;
  kind: DurableInteractionRequestKind;
  state: 'pending' | 'resolved' | 'cancelled' | 'expired';
  choices: DurableInteractionDecision[];
  /** Immutable semantic subject and its integrity hash. This replaces hidden resume data in Wait. */
  payload: JsonValue;
  payloadDigest: string;
  /** Optional immutable Artifact backing patch/result review content. */
  subjectRef?: string;
  subjectDigest?: string;
  policySnapshot: {
    mode: 'manual' | 'auto_at' | 'auto_immediate';
    autoDecision?: DurableInteractionDecision;
    notBeforeAt?: number;
    expiresAt?: number;
    policyVersion: string;
    environmentId?: string;
    permissionProfileVersion?: string;
  };
  createdAt: number;
  updatedAt: number;
}

export interface AnswerBridgeRecord {
  id: AnswerBridgeId;
  sourceConversationId: ConversationId;
  targetConversationId: ConversationId;
  ownerRunId: RunId;
  ownerGeneration: number;
  currentSubmissionId?: AnswerSubmissionId;
  lifecycle: 'open' | 'closed' | 'cancelled';
  rowVersion: number;
}

export interface AnswerSubmissionRecord {
  id: AnswerSubmissionId;
  bridgeId: AnswerBridgeId;
  revisionNo: number;
  payloadRef: string;
  createdAt: number;
}

export interface AnswerPayloadRecord {
  id: string;
  bridgeId: AnswerBridgeId;
  submissionId: AnswerSubmissionId;
  title: string;
  content: string;
  payloadHash: string;
  createdAt: number;
}

export interface RequestExecutionRecord {
  id: RequestId;
  conversationId: ConversationId;
  runId: RunId;
  invocationId: InvocationId;
  operationId: OperationId;
  modelMessageId?: MessageId;
  state: 'pending' | 'streaming' | 'complete' | 'error' | 'cancelled' | 'interrupted';
  streamSeq?: number;
  createdAt?: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  rowVersion: number;
}

export interface ToolExecutionRecord {
  id: ToolCallId;
  conversationId: ConversationId;
  runId: RunId;
  operationId: OperationId;
  state: 'pending' | 'executing' | 'complete' | 'error' | 'cancelled' | 'interrupted' | 'outcome_unknown';
  rowVersion: number;
}

export interface StreamCheckpointHead {
  id: string;
  requestId: RequestId;
  attemptId: AttemptId;
  generation: number;
  streamSeq: number;
  payloadHash: string;
  file: string;
}

export interface TerminalStreamFence {
  id: string;
  requestId: RequestId;
  attemptId: AttemptId;
  generation: number;
  finalStreamSeq: number;
}

export interface StatePatchBatch<TPatch extends JsonValue = JsonValue> {
  streamId: string;
  baseSeq: number;
  nextSeq: number;
  conversationVersion: number;
  commandIds: CommandId[];
  causes?: Array<{ kind: 'callback' | 'watchdog' | 'recovery'; id: string }>;
  terminalStreamFences?: TerminalStreamFence[];
  operations: TPatch[];
}

export interface PendingConversationCommand {
  commandId: CommandId;
  kind: 'send' | 'promote' | 'delete' | 'retry' | 'edit' | 'queue_control';
  targetId: string;
  phase: 'submitting' | 'awaiting_result' | 'committed_waiting_patch' | 'querying_status' | 'projection_recovery';
  startedAt: number;
  transitionId?: TransitionId;
  controlHeads?: CommittedConversationHead[];
  projectionBarrier?: CommittedConversationHead;
}
