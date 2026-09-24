import { createHash } from 'node:crypto';
import type {
  CompressionCommandTarget,
  LlmProviderKind,
  MessageRetryTarget,
  SessionThinkingOverride
} from '../../shared/protocol';
import type {
  AttachmentIngestService,
  PreparedMessageAttachmentAdmission
} from './attachmentIngest';
import {
  ContentAddressedStore,
  type ContentObjectMetadata,
  type PreparedContentObject
} from './contentAddressedStore';
import { ContextSequenceControlPlane } from './contextSequence';
import { estimateStoredMessageContentTokens } from './contextTokenEstimator';
import {
  compareGuidancePositions,
  initialGuidancePosition,
  inputTurnIntentEnvelope,
  parseInputTurnIntentEnvelope,
  parseRuntimeContinuationTurnIntentEnvelope,
  runtimeContinuationTurnIntentEnvelope,
  TURN_INTENT_ENVELOPE_CONTENT_TYPE
} from './guidanceIntent';
import {
  allocatedRuntimeValue,
  allocatedValue,
  assertReceiptIdentity,
  commandEntityId,
  isTransactionAssertionError,
  normalizeForkSource,
  normalizeInitiatingSource,
  normalizeTerminalSource,
  requireBigInt,
  requireContentType,
  requireDecimalIntegerString,
  requireId,
  requirePositiveInteger,
  requireText,
  requireTimestamp,
  sourceOperationMismatch,
  TURN_INTENT_STATE_ADMITTED,
  TURN_INTENT_STATE_QUEUED,
  type CommandCommit,
  type TurnCommandCommitOptions
} from './turnCommandWire';
import { TurnGuidanceQueueOperations } from './turnGuidanceQueue';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import {
  DOMAIN_REPOSITORIES,
  savepoint,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { toolArtifactIdentifiesCall } from './copiedToolIdentity';
import { canonicalPlainJson, normalizePlainJson, type PlainJsonValue } from './plainJson';
import { sqliteUniqueFailureIncludes, stablePhaseFId } from './phaseFIdentity';
import { RuntimeDatabase } from './runtimeDatabase';
import type { ExecutionLeaseFence } from './executionLeaseFence';
import {
  childExecutionAcceptsContinuation,
  requireChildExecutionStatus
} from './childExecutionState';
import {
  judgeTurnRecovery,
  type TurnRecoveryFacts,
  type TurnRecoveryJudgment
} from './turnRecovery';
import {
  projectFolderForConversation,
  type ProjectFolderAssignment
} from './conversationProject';
import type { FrozenWorkEnvironmentBoundaryPolicy } from './workEnvironmentBoundary';
import {
  readChildExecutionBoundary,
  readChildExecutionWorkEnvironmentBoundary,
  type FrozenSkillPolicyDocument,
  type FrozenToolPolicyDocument
} from './childExecutionBoundary';

export const DEFAULT_AGENT_CONVERSATION_ROLE = 'default';

const TURN_STATUS_ACTIVE = 'active';
const TURN_STATUS_TERMINATED = 'terminated';
const CONTENT_TYPE_PRESET = 'application/vnd.limcode.turn-execution-preset+json';
const CONTENT_TYPE_AUTHORITY = 'application/vnd.limcode.turn-authority-snapshot+json';
const CONTENT_TYPE_INTERRUPT = 'application/vnd.limcode.turn-interrupt-request+json';
const TURN_TERMINATION_INPUT_KINDS = [
  'interrupt_request',
  'interrupt_current_turn',
  'termination_request'
] as const;
const TERMINAL_BLOCKING_INPUT_KINDS = ['runtime_delivery', ...TURN_TERMINATION_INPUT_KINDS] as const;

export type TurnCommandSourceKind = 'command' | 'callback' | 'internal' | 'recovery';
export type TurnCommandOperation = 'input' | 'edit' | 'delete' | 'retry' | 'interrupt' | 'continuation' | 'runtime_continuation' | 'terminal' | 'guidance';
export type TurnTerminalStatus = 'completed' | 'failed' | 'interrupted' | 'cancelled' | 'outcome_unknown';
export type TurnCommandContent = string | Uint8Array;

export type ExecutionLeaseRenewalFailureReason =
  | 'requested_expiry_not_future'
  | 'lease_missing'
  | 'fence_replaced'
  | 'lease_expired'
  | 'transaction_conflict';

export type ExecutionLeaseRenewalResult =
  | {
      renewed: true;
      observedExpiresAt: string;
      renewedExpiresAt: string;
    }
  | {
      renewed: false;
      reason: ExecutionLeaseRenewalFailureReason;
      observedExpiresAt?: string;
      observedGeneration?: string;
    };

/** A history mutation can be retried unchanged once the exact competing Turn/Intent settles. */
export class ConversationHistoryBusyError extends Error {
  public readonly code = 'CONVERSATION_HISTORY_BUSY';

  public constructor(public readonly conversationId: string) {
    super(`Conversation ${conversationId} still has an active Turn or queued TurnIntent; finish it before changing history.`);
    this.name = 'ConversationHistoryBusyError';
  }
}

export function isConversationHistoryBusyError(error: unknown): error is ConversationHistoryBusyError {
  return error instanceof ConversationHistoryBusyError
    || (error as { code?: unknown })?.code === 'CONVERSATION_HISTORY_BUSY';
}

export interface TurnCommandSource {
  kind: TurnCommandSourceKind;
  key: string;
}

export interface TurnInitiatingSource extends TurnCommandSource {
  kind: 'command' | 'internal';
}

export interface TurnTerminalSource extends TurnCommandSource {
  kind: 'callback' | 'internal' | 'recovery';
}

export interface TurnAuthorityCompilationRequest {
  conversationId: string;
  turnId: string;
  executorAgentId: string;
  intentKind: 'input' | 'retry' | 'continuation' | 'runtime_continuation';
  sourceTurnId?: string;
  /** Explicit next-Turn selection captured by the UI command admission boundary. */
  modelOverride?: TurnModelOverride;
  /**
   * Stable inherited selection used only when the target Agent/Workflow/Conversation/Run has no
   * model profile of its own. Child execution uses the parent Turn's frozen effective model here;
   * unlike modelOverride it must never hide a child Agent profile.
   */
  modelFallback?: TurnModelOverride;
  /** Conversation-bound workspace used only for model-visible runtime context/rule rendering. */
  workspace?: ProjectFolderAssignment;
  /**
   * Parent Turn's frozen work-environment boundary, supplied by child executions. The compiler
   * intersects it with the child's own scoped policy — the boundary is never widened.
   */
  inheritedWorkEnvironmentPolicy?: FrozenWorkEnvironmentBoundaryPolicy;
  /**
   * The planning Turn's working directory, supplied when a Plan the user approved runs in a new
   * conversation: the child starts there if its own settings allow it. It narrows nothing.
   */
  preferredWorkEnvironmentId?: string;
  /**
   * The parent Turn's frozen tool policy, supplied for every Turn of a child execution the model
   * started (a Plan the user approved to run in a new conversation has none). The compiler
   * intersects the child's own tool settings with it (see `boundChildToolPolicy`) — a child never
   * gets a tool, MCP source or permission its parent Turn lacked.
   */
  inheritedToolPolicy?: FrozenToolPolicyDocument;
  /**
   * The parent Turn's frozen skill settings, supplied with `inheritedToolPolicy`. A skill either side
   * turns off stays off in the child (see `boundChildSkillPolicy`).
   */
  inheritedSkillPolicy?: FrozenSkillPolicyDocument;
  /**
   * 父回合在“派出的子 Agent 也用这个思考强度”下冻结的思考强度。子对话的第一个回合在写入它自己的
   * 模型记录之前编译，对话还没有模型记录时按这里冻结，这个子 Agent 再派出的孙 Agent 才能接着继承。
   */
  inheritedThinkingOverride?: SessionThinkingOverride;
}

export interface TurnModelOverride {
  providerConfigId?: string;
  provider?: LlmProviderKind;
  model: string;
}

export interface CompiledTurnAuthorityContent {
  content: TurnCommandContent;
  contentType?: string;
}

/** Produced by the configuration-authority side, not by a user command payload. */
export interface CompiledTurnAuthority {
  turnId: string;
  executorAgentId: string;
  executionPreset: CompiledTurnAuthorityContent;
  authoritySnapshot: CompiledTurnAuthorityContent;
}

export interface TurnAuthorityCompiler {
  compile(request: TurnAuthorityCompilationRequest): Promise<CompiledTurnAuthority>;
}

export interface TurnExecutionCommand {
  source: TurnInitiatingSource;
  conversationId: string;
  leaseOwnerId: string;
  hostBootId: string;
  leaseExpiresAt: string;
  /** Optional next-Turn authority. Once admitted it is frozen into the Turn snapshot. */
  executorAgentId?: string;
  modelOverride?: TurnModelOverride;
  /** Optional explicit scheduler membership; persisted as independent ChildExecution link facts. */
  membership?: TurnExecutionMembership;
}

export interface TurnExecutionMembership {
  kind: 'child_execution';
  childExecutionId: string;
}

export interface TurnInputCommand extends TurnExecutionCommand {
  content: TurnCommandContent;
  contentType?: string;
}

export interface TurnRetryCommand extends TurnExecutionCommand {
  sourceTurnId: string;
  target: MessageRetryTarget;
  expectedMessageRevisionId?: string;
}

export interface TurnContinuationCommand extends TurnExecutionCommand {
  sourceTurnId: string;
  content: TurnCommandContent;
  contentType?: string;
}

/**
 * Internal no-visible-message continuation created for one exact RuntimeDelivery. Process and
 * child-answer deliveries inherit the frozen authority of their same-Conversation source Turn. A
 * collaboration delivery has no such Turn (sourceTurnId is null): the destination runs under its
 * own current settings, exactly like a user input, and may start its very first Turn.
 */
export interface TurnRuntimeDeliveryContinuationCommand extends TurnExecutionCommand {
  source: TurnInitiatingSource & { kind: 'internal' };
  sourceTurnId: string | null;
  deliveryId: string;
  maintenance?: undefined;
}

/**
 * Internal no-visible-message product maintenance. It inherits the frozen authority of one source
 * Turn of the Conversation; without such a Turn (sourceTurnId is null, for example a fork whose
 * Turns are all copied history) it compiles the Conversation's current settings, like the first
 * Turn of a new Conversation.
 */
export interface TurnRuntimeMaintenanceCommand extends TurnExecutionCommand {
  source: TurnInitiatingSource & { kind: 'internal' };
  sourceTurnId: string | null;
  deliveryId?: undefined;
  /**
   * Immutable product-maintenance identity carried by the admitted TurnIntent CAS payload.
   * This is deliberately not process-local state: startup recovery can classify and replay a
   * maintenance Turn even when the Host died before its first ModelRequest was created.
   */
  maintenance: TurnRuntimeMaintenanceDescriptor;
}

export type TurnRuntimeContinuationCommand =
  | TurnRuntimeDeliveryContinuationCommand
  | TurnRuntimeMaintenanceCommand;

export type TurnRuntimeMaintenanceDescriptor =
  | TurnRuntimeMaintenanceDescriptorV1
  | TurnRuntimeMaintenanceDescriptorV2;

/** Exact legacy shape retained solely so already-persisted maintenance Turns remain recoverable. */
export interface TurnRuntimeMaintenanceDescriptorV1 {
  kind: 'manual_context_compression';
  version: 1;
  compressSegmentCount: number;
  /** Stable initiating source identity, used only to locate an exact command replay. */
  commandSourceKey: string;
}

export interface TurnRuntimeMaintenanceDescriptorV2 {
  kind: 'manual_context_compression';
  version: 2;
  compressSegmentCount: number;
  /** Exact UI boundary frozen before the maintenance Turn is admitted. */
  target: CompressionCommandTarget;
  /** Explicit full-history regeneration, frozen as part of the command replay identity. */
  sourceReplay?: 'immutable_provenance';
  /** Stable initiating source identity, used only to locate an exact command replay. */
  commandSourceKey: string;
}

export interface TurnEditCommand {
  source: TurnInitiatingSource;
  conversationId: string;
  messageId: string;
  expectedRevisionId?: string;
  content: TurnCommandContent;
  contentType?: string;
  /** When true, the edited revision becomes the final Context segment and later Messages are soft-deleted. */
  deleteFollowing?: boolean;
}

export interface TurnEditAndRunCommand extends TurnExecutionCommand {
  messageId: string;
  expectedRevisionId?: string;
  content: TurnCommandContent;
  contentType?: string;
  deleteFollowing?: boolean;
}

export interface TurnDeleteCommand {
  source: TurnInitiatingSource;
  conversationId: string;
  messageId: string;
}

export interface TurnGuidanceTarget {
  intentId: string;
  expectedRevisionSeq: string;
}

export interface TurnGuidanceEditCommand extends TurnGuidanceTarget {
  source: TurnInitiatingSource;
  conversationId: string;
  text: string;
}

export interface TurnGuidanceCancelCommand extends TurnGuidanceTarget {
  source: TurnInitiatingSource;
  conversationId: string;
}

export interface TurnGuidanceHoldCommand extends TurnGuidanceTarget {
  source: TurnInitiatingSource;
  conversationId: string;
  hold: 'none' | 'paused';
}

export interface TurnGuidanceReorderCommand {
  source: TurnInitiatingSource;
  conversationId: string;
  items: TurnGuidanceTarget[];
}

export interface TurnInterruptCommand {
  source: TurnInitiatingSource;
  turnId: string;
  expectedLeaseGeneration?: string;
  reason: string;
}

export interface TurnTerminalCommand {
  source: TurnTerminalSource;
  turnId: string;
  terminalStatus: TurnTerminalStatus;
  reason: string;
  /**
   * Optional ordinary queued Intent that must still be waiting when this Turn releases execution.
   * Used by the Agent loop to hand off at a completed model/tool boundary without interrupting work.
   */
  handoffQueuedIntentId?: string;
  /** Exact append-only revision set observed while selecting the handoff candidate. */
  handoffQueuedIntentRevisionIds?: readonly string[];
}

export interface ConversationForkSource {
  sourceConversationId: string;
  sourceTurnId: string;
  sourceMessageId: string;
  sourceMessageRevisionId: string;
  sourceContextRootId: string;
}

export interface ValidatedConversationForkSource extends ConversationForkSource {
  messageRevisionSeq: string;
  contextRootSeq: string;
}

export interface TurnCommandResult {
  receiptId: string;
  deduplicated: boolean;
  commitSeq?: string;
  conversationId?: string;
  intentId?: string;
  intentRevisionSeq?: string;
  turnId?: string;
  admitted?: boolean;
  messageId?: string;
  messageRevisionId?: string;
  messageRevisionSeq?: string;
  pendingTurnInputId?: string;
  pendingTurnInputPosition?: string;
  terminalRecorded?: boolean;
  ignoredBecauseTerminal?: boolean;
  coalesced?: boolean;
}

export interface TurnRecoveryLeaseClaimResult {
  receiptId: string;
  conversationId: string;
  turnId: string;
  executionLeaseId: string;
  leaseGeneration: string;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface TurnUnresolvedFileClosure {
  prepareUnresolvedTurnClosure(
    turnId: string,
    options?: { requireLease?: boolean }
  ): Promise<RepositoryTransactionStep[]>;
}

export interface TurnControlPlaneOptions {
  authorityCompiler: TurnAuthorityCompiler;
  attachments?: AttachmentIngestService;
  unresolvedFileClosure?: TurnUnresolvedFileClosure;
  /**
   * Injects pending next_turn RuntimeDelivery facts into an admitted ordinary Turn atomically.
   * `startingDeliveryId` is the delivery a runtime continuation was admitted for.
   */
  prepareNextTurnDeliverySteps?: (
    conversationId: string,
    turnId: string,
    now: string,
    startingDeliveryId?: string | null
  ) => Promise<RepositoryTransactionStep[]>;
  /** Moves the collaboration messages a Turn never took in to next_turn inside its terminal commit. */
  prepareTerminalDeliverySteps?: (turnId: string, now: string) => Promise<RepositoryTransactionStep[]>;
  /**
   * Budget steps a runtime continuation commits with its TurnIntent: a Turn a cross-conversation
   * reply starts spends the budget of the task it answers. Throws when that budget is spent.
   */
  prepareRuntimeContinuationSteps?: (deliveryId: string) => Promise<RepositoryTransactionStep[]>;
  now?: () => string;
}

/**
 * A terminal writer lost its final input fence. The Turn is deliberately still active: the
 * executor must absorb the RuntimeDelivery or acknowledge the termination request and retry.
 */
export class TurnTerminalInputConflictError extends Error {
  public readonly code = 'TURN_TERMINAL_INPUT_CONFLICT';

  public constructor(
    public readonly turnId: string,
    public readonly pendingTurnInputIds: readonly string[],
    public readonly pendingTurnInputKinds: readonly string[]
  ) {
    super(`Turn ${turnId} gained terminal-blocking input before its terminal commit.`);
    this.name = 'TurnTerminalInputConflictError';
  }
}

export function isTurnTerminalInputConflictError(error: unknown): error is TurnTerminalInputConflictError {
  return (error as { code?: unknown })?.code === 'TURN_TERMINAL_INPUT_CONFLICT';
}

/** The queued guidance selected for a safe handoff changed before the terminal commit. */
export class TurnTerminalGuidanceConflictError extends Error {
  public readonly code = 'TURN_TERMINAL_GUIDANCE_CONFLICT';

  public constructor(
    public readonly turnId: string,
    public readonly queuedIntentId: string
  ) {
    super(`Turn ${turnId} lost queued guidance ${queuedIntentId} before its terminal commit.`);
    this.name = 'TurnTerminalGuidanceConflictError';
  }
}

export function isTurnTerminalGuidanceConflictError(
  error: unknown
): error is TurnTerminalGuidanceConflictError {
  return (error as { code?: unknown })?.code === 'TURN_TERMINAL_GUIDANCE_CONFLICT';
}

interface StartIntentPlan {
  command: TurnExecutionCommand;
  operation: 'input' | 'retry' | 'continuation' | 'runtime_continuation';
  sourceTurnId?: string;
  deliveryId?: string;
  retryTarget?: MessageRetryTarget;
  expectedMessageRevisionId?: string;
  messageContent?: TurnCommandContent;
  messageContentType?: string;
  inheritSourceAuthority?: boolean;
  rewindSourceOutput?: boolean;
  runtimeMaintenance?: TurnRuntimeMaintenanceDescriptor;
}

interface ChildAdmissionPlan {
  outerSteps: RepositoryTransactionStep[];
  admissionSteps: RepositoryTransactionStep[];
}

interface StartCommandIds {
  receipt: string;
  intent: string;
  intentRevision: string;
  presetRevision: string;
  authorityRevision: string;
  intentExecutorLink: string;
  runtimeDeliveryIntentLink?: string;
  turn: string;
  lease: string;
  authoritySnapshot: string;
  executorLink: string;
  message?: string;
  messageRevision?: string;
  currentRevisionLink?: string;
  membership?: string;
  messageTurnLink?: string;
}

interface ConversationMessageEntry {
  membership: DomainRow;
  message: DomainRow;
  messageSeq: bigint;
}

interface ConversationMessageSnapshot {
  entries: ConversationMessageEntry[];
  membershipIds: string[];
}

interface RetryLineage {
  sourceTurnId: string;
  sourceMessageId?: string;
  sourceMessageRevisionId?: string;
  sourceModelRequestId?: string;
  inheritedPlanApprovalToolCallId?: string;
}

interface RetryRewindPlan {
  steps: RepositoryTransactionStep[];
  lineage: RetryLineage;
}

/** Phase C command facade. SQLite transactions are the only lifecycle serialization authority. */
export class TurnControlPlane {
  private readonly now: () => string;
  private readonly authorityCompiler: TurnAuthorityCompiler;
  private readonly attachments?: AttachmentIngestService;
  private readonly unresolvedFileClosure?: TurnUnresolvedFileClosure;
  private readonly prepareNextTurnDeliverySteps?: TurnControlPlaneOptions['prepareNextTurnDeliverySteps'];
  private readonly prepareTerminalDeliverySteps?: TurnControlPlaneOptions['prepareTerminalDeliverySteps'];
  private readonly prepareRuntimeContinuationSteps?: TurnControlPlaneOptions['prepareRuntimeContinuationSteps'];
  private readonly contextSequence: ContextSequenceControlPlane;
  private readonly guidanceQueue: TurnGuidanceQueueOperations;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    options: TurnControlPlaneOptions
  ) {
    if (!options?.authorityCompiler || typeof options.authorityCompiler.compile !== 'function') {
      throw new TypeError('TurnControlPlane requires a server-side TurnAuthorityCompiler.');
    }
    this.authorityCompiler = options.authorityCompiler;
    this.attachments = options.attachments;
    this.unresolvedFileClosure = options.unresolvedFileClosure;
    this.prepareNextTurnDeliverySteps = options.prepareNextTurnDeliverySteps;
    this.prepareTerminalDeliverySteps = options.prepareTerminalDeliverySteps;
    this.prepareRuntimeContinuationSteps = options.prepareRuntimeContinuationSteps;
    this.now = options.now ?? (() => new Date().toISOString());
    this.contextSequence = new ContextSequenceControlPlane(database, contentStore, { now: this.now });
    this.guidanceQueue = new TurnGuidanceQueueOperations({
      database,
      contentStore,
      now: this.now,
      findReceipt: (source) => this.findReceipt(source),
      commitWithReceipt: (options) => this.commitWithReceipt(options),
      requireExisting: (domain, id) => this.requireExisting(domain, id),
      listRows: (domain, where, limit) => this.listRows(domain, where, limit),
      readContentObject: (id) => this.readContentObject(id)
    });
  }

  /**
   * Conversation-runtime ownership boundary shared by every mutating command, admission and
   * recovery entry below. A direct control-plane caller (child execution, delivery, recovery,
   * tests) receives the same guard as the product Runner: a Conversation owned by a live or
   * unknown peer Host rejects with ConversationRuntimeOwnerBusyError before any receipt or row
   * is written, and the held activity pin covers the full read-check-write sequence so an idle
   * release cannot race the mutation. Read-only facts/fence queries stay ungated.
   */
  private runOwnedConversationMutation<T>(
    conversationId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.database.conversationOwners.run(
      requireId(conversationId, 'conversationId'),
      operation
    );
  }

  public input(command: TurnInputCommand): Promise<TurnCommandResult> {
    return this.runOwnedConversationMutation(command.conversationId, () => this.startIntent({
      command,
      operation: 'input',
      messageContent: command.content,
      messageContentType: command.contentType ?? 'text/plain'
    }));
  }

  public retry(command: TurnRetryCommand): Promise<TurnCommandResult> {
    return this.runOwnedConversationMutation(command.conversationId, () => this.startIntent({
      command,
      operation: 'retry',
      sourceTurnId: command.sourceTurnId,
      retryTarget: normalizeRetryTarget(command.target),
      ...(command.expectedMessageRevisionId
        ? { expectedMessageRevisionId: requireId(command.expectedMessageRevisionId, 'expectedMessageRevisionId') }
        : {}),
      rewindSourceOutput: true
    }));
  }

  public continuation(command: TurnContinuationCommand): Promise<TurnCommandResult> {
    return this.runOwnedConversationMutation(command.conversationId, () => this.startIntent({
      command,
      operation: 'continuation',
      sourceTurnId: command.sourceTurnId,
      messageContent: command.content,
      messageContentType: command.contentType ?? 'text/plain'
    }));
  }

  public runtimeContinuation(command: TurnRuntimeContinuationCommand): Promise<TurnCommandResult> {
    if (command.source.kind !== 'internal') {
      throw new TypeError('Runtime continuation requires an internal source.');
    }
    if (command.maintenance) {
      return this.runOwnedConversationMutation(command.conversationId, () => this.startIntent({
        command,
        operation: 'retry',
        ...(command.sourceTurnId === null ? {} : { sourceTurnId: command.sourceTurnId }),
        inheritSourceAuthority: command.sourceTurnId !== null,
        runtimeMaintenance: normalizeRuntimeMaintenance(command.maintenance)
      }));
    }
    return this.runOwnedConversationMutation(command.conversationId, async () => {
      const deliveryId = requireId(command.deliveryId, 'deliveryId');
      const collaboration = await this.isCollaborationDelivery(deliveryId);
      if (collaboration !== (command.sourceTurnId === null)) {
        throw new TypeError(collaboration
          ? 'A collaboration continuation compiles the destination\'s current authority and carries no source Turn.'
          : 'A runtime continuation inherits the frozen authority of its exact source Turn.');
      }
      return this.startIntent({
        command,
        operation: 'runtime_continuation',
        ...(command.sourceTurnId === null ? {} : { sourceTurnId: command.sourceTurnId }),
        deliveryId,
        inheritSourceAuthority: !collaboration
      });
    });
  }

  /**
   * The authority a manual compression maintenance Turn would freeze now, computed the way
   * runtimeContinuation admits one: inherited from sourceTurnId when there is one, otherwise the
   * Conversation's current settings. Read-only: no Turn is admitted and nothing is written.
   */
  public async previewMaintenanceAuthority(
    conversationIdInput: string,
    sourceTurnId: string | null
  ): Promise<PlainJsonValue> {
    const conversationId = requireId(conversationIdInput, 'conversationId');
    const previewTurnId = 'turn_maintenance_authority_preview';
    const compiled = sourceTurnId === null
      ? await this.compileCurrentAuthority(conversationId, previewTurnId, 'retry')
      : await this.inheritTurnAuthority(requireId(sourceTurnId, 'sourceTurnId'), previewTurnId, conversationId, 'retry');
    const content = compiled.authoritySnapshot.content;
    const text = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
    return normalizePlainJson(JSON.parse(text) as unknown, 'Maintenance authority preview');
  }

  private async isCollaborationDelivery(deliveryId: string): Promise<boolean> {
    const delivery = await this.requireExisting('RuntimeDelivery', deliveryId);
    const inbox = await this.requireExisting(
      'RuntimeInboxItem',
      requireId(delivery.inbox_item_id, 'RuntimeDelivery.inbox_item_id')
    );
    return inbox.source_kind === 'collaboration_message';
  }

  public edit(command: TurnEditCommand): Promise<TurnCommandResult> {
    return this.runOwnedConversationMutation(command.conversationId, () => this.editMessage(command));
  }

  public editAndRun(command: TurnEditAndRunCommand): Promise<TurnCommandResult> {
    return this.runOwnedConversationMutation(command.conversationId, () => this.editMessageAndRun(command));
  }

  public delete(command: TurnDeleteCommand): Promise<TurnCommandResult> {
    return this.runOwnedConversationMutation(command.conversationId, () => this.softDeleteMessage(command));
  }

  public editGuidance(command: TurnGuidanceEditCommand): Promise<TurnCommandResult> {
    return this.runOwnedConversationMutation(command.conversationId, () =>
      this.guidanceQueue.reviseGuidanceText(command));
  }

  public cancelGuidance(command: TurnGuidanceCancelCommand): Promise<TurnCommandResult> {
    return this.runOwnedConversationMutation(command.conversationId, () =>
      this.guidanceQueue.cancelQueuedGuidance(command));
  }

  public setGuidanceHold(command: TurnGuidanceHoldCommand): Promise<TurnCommandResult> {
    return this.runOwnedConversationMutation(command.conversationId, () =>
      this.guidanceQueue.reviseGuidanceHold(command));
  }

  public reorderGuidance(command: TurnGuidanceReorderCommand): Promise<TurnCommandResult> {
    return this.runOwnedConversationMutation(command.conversationId, () =>
      this.guidanceQueue.reorderQueuedGuidance(command));
  }

  public async interrupt(command: TurnInterruptCommand): Promise<TurnCommandResult> {
    const turn = await this.getTurn(requireId(command.turnId, 'turnId'));
    return this.runOwnedConversationMutation(
      requireId(turn.conversation_id, 'Turn.conversation_id'),
      () => this.requestInterrupt(command)
    );
  }

  public async terminal(command: TurnTerminalCommand): Promise<TurnCommandResult> {
    const turn = await this.getTurn(requireId(command.turnId, 'turnId'));
    return this.runOwnedConversationMutation(
      requireId(turn.conversation_id, 'Turn.conversation_id'),
      () => this.recordTerminal(command)
    );
  }

  /** Admits the oldest ordinary queued Intent after the prior lease is released. Child intents use their lineage control plane. */
  public async admitNextQueued(input: {
    conversationId: string;
    leaseOwnerId: string;
    hostBootId: string;
    leaseExpiresAt: string;
  }): Promise<TurnCommandResult | null> {
    const conversationId = requireId(input.conversationId, 'conversationId');
    return this.runOwnedConversationMutation(conversationId, async () => {
      const queued = (await listAllDomainRows(this.database, 'TurnIntent', { conversation_id: conversationId }))
        .filter((intent) => intent.state === TURN_INTENT_STATE_QUEUED && intent.turn_id === null);
      if (queued.length === 0) return null;
      const childIntentLinks = await listAllDomainRows(this.database, 'ChildExecutionIntentLink', { state: 'pending' });
      const childIntentIds = new Set(childIntentLinks.map((link) => String(link.turn_intent_id)));
      const ranked: Array<{ intent: DomainRow; position: string }> = [];
      for (const candidate of queued) {
        const intentId = requireId(candidate.id, 'TurnIntent.id');
        if (childIntentIds.has(intentId)) continue;
        const guidance = await this.guidanceQueue.maybeCurrentGuidanceIntent(conversationId, intentId);
        if (guidance?.hold === 'paused') continue;
        ranked.push({
          intent: candidate,
          position: guidance?.position
            ?? initialGuidancePosition(requireTimestamp(candidate.created_at, 'TurnIntent.created_at'))
        });
      }
      const intent = ranked.sort((left, right) =>
        compareGuidancePositions(left.position, right.position)
        || String(left.intent.created_at).localeCompare(String(right.intent.created_at))
        || String(left.intent.id).localeCompare(String(right.intent.id))
      )[0]?.intent;
      if (!intent) return null;
      return this.admitQueuedIntent(intent, input);
    });
  }

  /** Finalize-only recovery for the identity.json active/no-lease orphan combination. */
  public async finalizeRecovery(command: TurnTerminalCommand): Promise<TurnCommandResult> {
    const turn = await this.getTurn(requireId(command.turnId, 'turnId'));
    return this.runOwnedConversationMutation(
      requireId(turn.conversation_id, 'Turn.conversation_id'),
      () => this.finalizeRecoveryOwned(command)
    );
  }

  private async finalizeRecoveryOwned(command: TurnTerminalCommand): Promise<TurnCommandResult> {
    const source = normalizeTerminalSource(command.source);
    if (source.kind !== 'recovery') throw new TypeError('Turn recovery finalization requires recovery source kind.');
    const turnId = requireId(command.turnId, 'turnId');
    const reason = requireText(command.reason, 'reason');
    requireTerminalStatus(command.terminalStatus);
    const facts = await this.recoveryFacts(turnId);
    if (facts.judgment !== 'finalize') {
      throw new Error(`Turn ${turnId} recovery judgment is ${facts.judgment}, not finalize.`);
    }
    const turn = await this.getTurn(turnId);
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    const terminationId = commandEntityId(source, 'terminal', 'turn_termination', turnId);
    const receiptId = commandEntityId(source, 'terminal', 'command_receipt', turnId);
    const duplicate = await this.findReceipt(source);
    if (duplicate) return this.replayTerminalResult(duplicate, receiptId, turnId, terminationId);
    if (turn.status === TURN_STATUS_TERMINATED) {
      const committed = await this.commitWithReceipt({ source, receiptId, conversationId, turnId, steps: [] });
      return {
        receiptId: committed.receipt.id as string,
        deduplicated: committed.deduplicated,
        commitSeq: committed.commitSeq,
        conversationId,
        turnId,
        terminalRecorded: false,
        ignoredBecauseTerminal: true
      };
    }
    const unresolvedFileSteps = this.unresolvedFileClosure
      ? await this.unresolvedFileClosure.prepareUnresolvedTurnClosure(turnId, { requireLease: false })
      : [];
    const now = this.timestamp();
    const terminalDeliverySteps = this.prepareTerminalDeliverySteps
      ? await this.prepareTerminalDeliverySteps(turnId, now)
      : [];
    const committed = await this.commitWithReceipt({
      source,
      receiptId,
      conversationId,
      turnId,
      steps: [
        DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: TURN_STATUS_ACTIVE }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assertNone({ turn_id: turnId }),
        DOMAIN_REPOSITORIES.domain('PendingTurnInput').assertNone({ turn_id: turnId }),
        DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: turnId }),
        ...terminalDeliverySteps,
        ...unresolvedFileSteps,
        DOMAIN_REPOSITORIES.domain('ToolCall').assertAll({ turn_id: turnId }, { status: 'terminal' }),
        DOMAIN_REPOSITORIES.domain('ModelRequest').assertAll({ turn_id: turnId }, { status: 'terminal' }),
        DOMAIN_REPOSITORIES.domain('TurnTermination').insert({
          id: terminationId,
          turn_id: turnId,
          terminal_status: command.terminalStatus,
          reason,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Turn').update(turnId, {
          status: TURN_STATUS_TERMINATED,
          updated_at: now,
          terminal_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
      ]
    });
    return {
      receiptId: committed.receipt.id as string,
      deduplicated: committed.deduplicated,
      commitSeq: committed.commitSeq,
      conversationId,
      turnId,
      terminalRecorded: true
    };
  }

  public async recoveryFacts(turnId: string): Promise<TurnRecoveryFacts & { judgment: TurnRecoveryJudgment }> {
    const id = requireId(turnId, 'turnId');
    const turns = DOMAIN_REPOSITORIES.domain('Turn');
    const leases = DOMAIN_REPOSITORIES.domain('ExecutionLease');
    const inputs = DOMAIN_REPOSITORIES.domain('PendingTurnInput');
    const terminations = DOMAIN_REPOSITORIES.domain('TurnTermination');
    const snapshot = await this.database.snapshot([
      turns.get(id),
      leases.list({ where: { turn_id: id }, limit: 1 }),
      inputs.list({ where: { turn_id: id }, limit: 1 }),
      terminations.list({ where: { turn_id: id }, limit: 1 })
    ]);
    const turn = requireRow(snapshot.snapshot[0], `Turn ${id}`);
    const status = requireText(turn.status, `Turn ${id}.status`);
    if (status !== TURN_STATUS_ACTIVE && status !== TURN_STATUS_TERMINATED) {
      throw new Error(`Turn ${id} has unsupported recovery status ${status}.`);
    }
    const facts: TurnRecoveryFacts = {
      turnStatus: status,
      executionLeaseExists: rows(snapshot.snapshot[1]).length > 0,
      pendingTurnInputExists: rows(snapshot.snapshot[2]).length > 0,
      turnTerminationExists: rows(snapshot.snapshot[3]).length > 0
    };
    return { ...facts, judgment: judgeTurnRecovery(facts) };
  }

  /**
   * Process-local scheduling is only a wake hint. The durable ExecutionLease remains the execution
   * authority, so every Runner drive must prove both its Host boot and owner id immediately before
   * entering the Agent loop.
   */
  public async ownsExecutionLease(input: {
    turnId: string;
    leaseOwnerId: string;
    hostBootId: string;
    generation?: bigint;
  }): Promise<boolean> {
    const turnId = requireId(input.turnId, 'turnId');
    const leaseOwnerId = requireId(input.leaseOwnerId, 'leaseOwnerId');
    const hostBootId = requireId(input.hostBootId, 'hostBootId');
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Turn').get(turnId),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').list({ where: { turn_id: turnId }, limit: 2 })
    ]);
    const turn = snapshot.snapshot[0];
    const leases = rows(snapshot.snapshot[1]);
    if (!turn || Array.isArray(turn) || turn.status !== TURN_STATUS_ACTIVE || leases.length !== 1) return false;
    return leases[0].owner_id === leaseOwnerId
      && leases[0].host_boot_id === hostBootId
      && Date.parse(requireTimestamp(leases[0].expires_at, 'ExecutionLease.expires_at')) > Date.parse(this.timestamp())
      && (input.generation === undefined || leases[0].generation === input.generation);
  }

  /** Captures the immutable tuple an executor must carry for the entire Agent-loop lifetime. */
  public async executionLeaseFence(input: {
    turnId: string;
    leaseOwnerId: string;
    hostBootId: string;
  }): Promise<ExecutionLeaseFence | null> {
    const turnId = requireId(input.turnId, 'turnId');
    const leaseOwnerId = requireId(input.leaseOwnerId, 'leaseOwnerId');
    const hostBootId = requireId(input.hostBootId, 'hostBootId');
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Turn').get(turnId),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').list({ where: { turn_id: turnId }, limit: 2 })
    ]);
    const turn = snapshot.snapshot[0];
    const leases = rows(snapshot.snapshot[1]);
    if (!turn || Array.isArray(turn) || turn.status !== TURN_STATUS_ACTIVE || leases.length !== 1) return null;
    const lease = leases[0];
    if (lease.owner_id !== leaseOwnerId || lease.host_boot_id !== hostBootId) return null;
    if (
      Date.parse(requireTimestamp(lease.expires_at, 'ExecutionLease.expires_at'))
      <= Date.parse(this.timestamp())
    ) return null;
    return {
      id: requireId(lease.id, 'ExecutionLease.id'),
      conversationId: requireId(lease.conversation_id, 'ExecutionLease.conversation_id'),
      turnId,
      ownerId: leaseOwnerId,
      hostBootId,
      generation: requirePositiveInteger(lease.generation, 'ExecutionLease.generation')
    };
  }

  /** Renews only the exact captured generation; a recovered owner makes this a harmless loser. */
  public async renewExecutionLease(input: {
    fence: ExecutionLeaseFence;
    leaseExpiresAt: string;
  }): Promise<boolean> {
    return (await this.renewExecutionLeaseDetailed(input)).renewed;
  }

  /** Same fenced renewal with metadata-only failure classification for recovery and diagnostics. */
  public async renewExecutionLeaseDetailed(input: {
    fence: ExecutionLeaseFence;
    leaseExpiresAt: string;
  }): Promise<ExecutionLeaseRenewalResult> {
    const expiresAt = requireTimestamp(input.leaseExpiresAt, 'leaseExpiresAt');
    const now = this.timestamp();
    if (Date.parse(expiresAt) <= Date.parse(now)) {
      return { renewed: false, reason: 'requested_expiry_not_future' };
    }
    const currentRows = await this.listRows('ExecutionLease', { turn_id: input.fence.turnId }, 2);
    if (currentRows.length !== 1) return { renewed: false, reason: 'lease_missing' };
    const current = currentRows[0];
    const observedExpiresAt = requireTimestamp(current.expires_at, 'ExecutionLease.expires_at');
    const observedGeneration = requirePositiveInteger(
      current.generation,
      'ExecutionLease.generation'
    ).toString();
    if (
      current.id !== input.fence.id
      || current.conversation_id !== input.fence.conversationId
      || current.turn_id !== input.fence.turnId
      || current.owner_id !== input.fence.ownerId
      || current.host_boot_id !== input.fence.hostBootId
      || current.generation !== input.fence.generation
    ) {
      return {
        renewed: false,
        reason: 'fence_replaced',
        observedExpiresAt,
        observedGeneration
      };
    }
    if (Date.parse(observedExpiresAt) <= Date.parse(now)) {
      return {
        renewed: false,
        reason: 'lease_expired',
        observedExpiresAt,
        observedGeneration
      };
    }
    try {
      await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('Turn').assert(input.fence.turnId, { status: TURN_STATUS_ACTIVE }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(input.fence.id, {
          conversation_id: input.fence.conversationId,
          turn_id: input.fence.turnId,
          owner_id: input.fence.ownerId,
          host_boot_id: input.fence.hostBootId,
          generation: input.fence.generation,
          acquired_at: current.acquired_at,
          expires_at: observedExpiresAt
        }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').update(input.fence.id, {
          expires_at: expiresAt
        })
      ]);
      return {
        renewed: true,
        observedExpiresAt,
        renewedExpiresAt: expiresAt
      };
    } catch (error) {
      if (isTransactionAssertionError(error)) {
        return {
          renewed: false,
          reason: 'transaction_conflict',
          observedExpiresAt,
          observedGeneration
        };
      }
      throw error;
    }
  }

  /**
   * Rebinds a resumable Turn's execution ownership to the current Extension Host boot. This is a
   * recovery command: an existing lease from another boot is fenced by an exact-row
   * assertion before replacement, while active/no-lease recovery requires the PendingTurnInput
   * fact mandated by identity.json. It never revives a terminal or finalize-only Turn.
   *
   * Elapsed time alone never displaces another Host: a lease whose owning Host boot is verifiably
   * live (or cannot be proven dead) stays authoritative past its expiry. Cross-boot takeover
   * requires a definitely dead/reused process identity via RuntimeDatabase.isHostAlive; the
   * exact-row generation CAS then fences every delayed write from the old owner. Reclaiming an
   * expired lease owned by this same Host boot remains allowed, which is how waiting Turns whose
   * renewal stopped resume after a human/process wake.
   *
   * The Conversation-runtime ownership boundary applies first: a Conversation owned by a live or
   * unknown peer Host rejects with ConversationRuntimeOwnerBusyError before any recovery receipt
   * or ExecutionLease row is read for mutation, so direct control-plane callers can never rebind
   * a peer-owned Conversation's execution. A null result keeps its existing meaning: lease-level
   * stand-down while this Host legitimately owns the Conversation.
   */
  public async claimRecoveryExecution(input: {
    turnId: string;
    leaseOwnerId: string;
    hostBootId: string;
    leaseExpiresAt: string;
  }): Promise<TurnRecoveryLeaseClaimResult | null> {
    const turnId = requireId(input.turnId, 'turnId');
    const turn = await this.getTurn(turnId);
    return this.runOwnedConversationMutation(
      requireId(turn.conversation_id, 'Turn.conversation_id'),
      () => this.claimRecoveryExecutionOwned(input)
    );
  }

  private async claimRecoveryExecutionOwned(input: {
    turnId: string;
    leaseOwnerId: string;
    hostBootId: string;
    leaseExpiresAt: string;
  }): Promise<TurnRecoveryLeaseClaimResult | null> {
    const turnId = requireId(input.turnId, 'turnId');
    const leaseOwnerId = requireId(input.leaseOwnerId, 'leaseOwnerId');
    const hostBootId = requireId(input.hostBootId, 'hostBootId');
    const leaseExpiresAt = requireTimestamp(input.leaseExpiresAt, 'leaseExpiresAt');
    const source: TurnCommandSource = {
      kind: 'recovery',
      key: `runner-claim-execution:${hostBootId}:${turnId}`
    };
    const receiptId = recoveryExecutionEntityId('command_receipt', hostBootId, turnId);
    const existingReceipt = await this.findReceipt(source);
    if (existingReceipt) {
      if (
        existingReceipt.id !== receiptId
        || existingReceipt.source_kind !== source.kind
        || existingReceipt.source_key !== source.key
        || existingReceipt.turn_id !== turnId
      ) throw new Error(`Turn ${turnId} recovery ownership receipt has conflicting identity.`);
      const leaseRows = await this.listRows('ExecutionLease', { turn_id: turnId }, 2);
      if (leaseRows.length !== 1) {
        throw new Error(`Recovered Turn ${turnId} lost its claimed ExecutionLease.`);
      }
      const lease = leaseRows[0];
      const turn = await this.getTurn(turnId);
      const generation = requirePositiveInteger(lease.generation, 'ExecutionLease.generation');
      const now = this.timestamp();
      const expired = Date.parse(requireTimestamp(lease.expires_at, 'ExecutionLease.expires_at')) <= Date.parse(now);
      const ownedByRequester = lease.owner_id === leaseOwnerId && lease.host_boot_id === hostBootId;
      if (ownedByRequester && !expired) {
        const renewed = await this.renewExecutionLease({
          fence: {
            id: requireId(lease.id, 'ExecutionLease.id'),
            conversationId: requireId(turn.conversation_id, 'Turn.conversation_id'),
            turnId,
            ownerId: leaseOwnerId,
            hostBootId,
            generation
          },
          leaseExpiresAt
        });
        if (!renewed) return null;
        return {
          receiptId: requireId(existingReceipt.id, 'CommandReceipt.id'),
          conversationId: requireId(turn.conversation_id, 'Turn.conversation_id'),
          turnId,
          executionLeaseId: requireId(lease.id, 'ExecutionLease.id'),
          leaseGeneration: generation.toString(),
          deduplicated: true
        };
      }
      if (!expired && lease.host_boot_id === hostBootId && lease.owner_id !== leaseOwnerId) {
        throw new Error(`Turn ${turnId} is already owned by another runner in the current host boot.`);
      }
      if (
        lease.host_boot_id !== hostBootId
        && await this.database.isHostAlive(requireId(lease.host_boot_id, 'ExecutionLease.host_boot_id'))
      ) {
        // A verifiably live (or not proven dead) Host is authoritative regardless of lease expiry;
        // elapsed time never justifies displacing it.
        return null;
      }

      // The initial recovery receipt identifies only the first generation claimed by this Host.
      // Ownership may subsequently move A→B→A. Once the observed lease is owned by this Host boot
      // (expired or not) or its old Host is definitely dead, create a generation-scoped receipt
      // and CAS the exact current owner row; an old per-Host receipt must never permanently block
      // that return path.
      const nextGeneration = generation + 1n;
      const reclaimSource: TurnCommandSource = {
        kind: 'recovery',
        key: `runner-reclaim-execution:${hostBootId}:${turnId}:${nextGeneration}`
      };
      const reclaimReceiptId = recoveryExecutionEntityId(
        'command_receipt',
        hostBootId,
        turnId,
        nextGeneration.toString()
      );
      let reclaimed: CommandCommit;
      try {
        reclaimed = await this.commitWithReceipt({
          source: reclaimSource,
          receiptId: reclaimReceiptId,
          conversationId: requireId(turn.conversation_id, 'Turn.conversation_id'),
          turnId,
          steps: [
            DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: TURN_STATUS_ACTIVE }),
            DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(
              requireId(lease.id, 'ExecutionLease.id'),
              {
                conversation_id: lease.conversation_id,
                turn_id: turnId,
                owner_id: lease.owner_id,
                host_boot_id: lease.host_boot_id,
                generation,
                acquired_at: lease.acquired_at,
                expires_at: lease.expires_at
              }
            ),
            DOMAIN_REPOSITORIES.domain('ExecutionLease').update(
              requireId(lease.id, 'ExecutionLease.id'),
              {
                owner_id: leaseOwnerId,
                host_boot_id: hostBootId,
                generation: nextGeneration,
                acquired_at: now,
                expires_at: leaseExpiresAt
              }
            )
          ]
        });
      } catch (error) {
        if (isTransactionAssertionError(error) || isLeaseAdmissionConflict(error)) return null;
        throw error;
      }
      const current = (await this.listRows('ExecutionLease', { turn_id: turnId }, 2))[0];
      if (
        !current
        || current.owner_id !== leaseOwnerId
        || current.host_boot_id !== hostBootId
        || current.generation !== nextGeneration
      ) return null;
      return {
        receiptId: requireId(reclaimed.receipt.id, 'CommandReceipt.id'),
        conversationId: requireId(turn.conversation_id, 'Turn.conversation_id'),
        turnId,
        executionLeaseId: requireId(current.id, 'ExecutionLease.id'),
        leaseGeneration: nextGeneration.toString(),
        deduplicated: reclaimed.deduplicated,
        ...(reclaimed.commitSeq ? { commitSeq: reclaimed.commitSeq } : {})
      };
    }

    const facts = await this.recoveryFacts(turnId);
    if (facts.judgment !== 'resume') return null;
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Turn').get(turnId),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').list({ where: { turn_id: turnId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('PendingTurnInput').list({ where: { turn_id: turnId }, limit: 1 }),
      DOMAIN_REPOSITORIES.domain('TurnTermination').list({ where: { turn_id: turnId }, limit: 1 })
    ]);
    const turn = requireRow(snapshot.snapshot[0], `Turn ${turnId}`);
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    const leases = rows(snapshot.snapshot[1]);
    const pendingInputs = rows(snapshot.snapshot[2]);
    const terminations = rows(snapshot.snapshot[3]);
    if (turn.status !== TURN_STATUS_ACTIVE || terminations.length !== 0 || leases.length > 1) {
      throw new Error(`Turn ${turnId} changed while claiming startup recovery ownership.`);
    }
    const existingLease = leases[0];
    const now = this.timestamp();
    if (!existingLease && pendingInputs.length === 0) {
      throw new Error(`Turn ${turnId} has no durable fact permitting recovery ownership.`);
    }
    const existingLeaseExpired = existingLease
      ? Date.parse(requireTimestamp(existingLease.expires_at, 'ExecutionLease.expires_at')) <= Date.parse(now)
      : false;
    if (
      existingLease
      && existingLease.host_boot_id !== hostBootId
      && await this.database.isHostAlive(requireId(existingLease.host_boot_id, 'ExecutionLease.host_boot_id'))
    ) {
      // A verifiably live (or not proven dead) Host remains authoritative past lease expiry:
      // elapsed time alone never displaces it. Takeover requires a definitely dead/reused process
      // identity; the exact-row generation CAS below still fences every delayed write.
      return null;
    }
    if (
      existingLease?.host_boot_id === hostBootId
      && existingLease.owner_id !== leaseOwnerId
      && !existingLeaseExpired
    ) {
      throw new Error(`Turn ${turnId} is already owned by another runner in the current host boot.`);
    }
    const executionLeaseId = existingLease
      ? requireId(existingLease.id, 'ExecutionLease.id')
      : recoveryExecutionEntityId('execution_lease', hostBootId, turnId);
    const nextGeneration = existingLease
      ? requirePositiveInteger(existingLease.generation, 'ExecutionLease.generation') + 1n
      : 1n;
    const leaseSteps: RepositoryTransactionStep[] = existingLease
      ? [
          DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(executionLeaseId, {
            conversation_id: conversationId,
            turn_id: turnId,
            owner_id: existingLease.owner_id,
            host_boot_id: existingLease.host_boot_id,
            generation: existingLease.generation,
            acquired_at: existingLease.acquired_at,
            expires_at: existingLease.expires_at
          }),
          DOMAIN_REPOSITORIES.domain('ExecutionLease').update(executionLeaseId, {
            owner_id: leaseOwnerId,
            host_boot_id: hostBootId,
            generation: nextGeneration,
            acquired_at: now,
            expires_at: leaseExpiresAt
          })
        ]
      : [
          DOMAIN_REPOSITORIES.domain('PendingTurnInput').assert(
            requireId(pendingInputs[0].id, 'PendingTurnInput.id'),
            { turn_id: turnId }
          ),
          DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
            id: executionLeaseId,
            conversation_id: conversationId,
            turn_id: turnId,
            owner_id: leaseOwnerId,
            host_boot_id: hostBootId,
            generation: nextGeneration,
            acquired_at: now,
            expires_at: leaseExpiresAt
          })
        ];
    let committed: CommandCommit;
    try {
      committed = await this.commitWithReceipt({
        source,
        receiptId,
        conversationId,
        turnId,
        steps: [
          DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: TURN_STATUS_ACTIVE }),
          DOMAIN_REPOSITORIES.domain('TurnTermination').assertNone({ turn_id: turnId }),
          ...leaseSteps
        ]
      });
    } catch (error) {
      // Multiple fresh Hosts may observe the same dead owner. Exact-row assertions elect one; the
      // loser must stand down rather than turning a safe recovery race into a startup failure.
      if (isTransactionAssertionError(error) || isLeaseAdmissionConflict(error)) return null;
      throw error;
    }
    return {
      receiptId: requireId(committed.receipt.id, 'CommandReceipt.id'),
      conversationId,
      turnId,
      executionLeaseId,
      leaseGeneration: nextGeneration.toString(),
      deduplicated: committed.deduplicated,
      ...(committed.commitSeq ? { commitSeq: committed.commitSeq } : {})
    };
  }

  /** Phase C validates stable source facts only; target fork writes belong to Phase E/F. */
  public async validateForkSource(sourceInput: ConversationForkSource): Promise<ValidatedConversationForkSource> {
    const source = normalizeForkSource(sourceInput);
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Turn').get(source.sourceTurnId),
      DOMAIN_REPOSITORIES.domain('MessageRevision').get(source.sourceMessageRevisionId),
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').get(source.sourceContextRootId),
      DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({
        where: { conversation_id: source.sourceConversationId, message_id: source.sourceMessageId },
        limit: 1
      }),
      DOMAIN_REPOSITORIES.domain('MessageTurnLink').list({
        where: { turn_id: source.sourceTurnId, message_id: source.sourceMessageId },
        limit: 10
      })
    ]);
    const turn = requireRow(snapshot.snapshot[0], `Turn ${source.sourceTurnId}`);
    const revision = requireRow(snapshot.snapshot[1], `MessageRevision ${source.sourceMessageRevisionId}`);
    const contextRoot = requireRow(snapshot.snapshot[2], `ContextSequenceRoot ${source.sourceContextRootId}`);
    if (turn.conversation_id !== source.sourceConversationId) {
      throw new Error('Fork source Turn does not belong to the source Conversation.');
    }
    if (revision.message_id !== source.sourceMessageId) {
      throw new Error('Fork source MessageRevision does not belong to the source Message.');
    }
    if (contextRoot.conversation_id !== source.sourceConversationId) {
      throw new Error('Fork source Context root does not belong to the source Conversation.');
    }
    if (rows(snapshot.snapshot[3]).length !== 1) {
      throw new Error('Fork source Message is not a member of the source Conversation.');
    }
    if (rows(snapshot.snapshot[4]).length === 0) {
      throw new Error('Fork source Message is not linked to the source Turn.');
    }
    const structure = await this.contextSequence.materializeStructure(source.sourceContextRootId);
    const revisionSources = await listAllDomainRows(this.database, 'ContextSegmentSource', {
      source_kind: 'message_revision',
      source_id: source.sourceMessageRevisionId
    });
    const revisionSegmentIds = new Set(revisionSources.map((row) =>
      requireId(row.segment_id, 'ContextSegmentSource.segment_id')
    ));
    const segmentIndexes = new Map(structure.records.map((record, index) => [
      requireId(record.segment.id, 'ContextSegment.id'),
      index
    ]));
    let previousIndex = structure.records.findIndex((record) =>
      revisionSegmentIds.has(requireId(record.segment.id, 'ContextSegment.id'))
    );
    if (previousIndex < 0) {
      throw new Error('Fork source Context root does not contain the selected MessageRevision.');
    }
    if (revision.role === 'model') {
      const callLinks = (await listAllDomainRows(this.database, 'ToolCallSourceLink', {
        message_id: source.sourceMessageId
      })).sort((left, right) => {
        const leftOrdinal = requireBigInt(left.provider_ordinal, 'ToolCallSourceLink.provider_ordinal');
        const rightOrdinal = requireBigInt(right.provider_ordinal, 'ToolCallSourceLink.provider_ordinal');
        return leftOrdinal < rightOrdinal ? -1 : leftOrdinal > rightOrdinal ? 1 : 0;
      });
      for (const callLink of callLinks) {
        const toolCallId = requireId(callLink.tool_call_id, 'ToolCallSourceLink.tool_call_id');
        const pairSources = await listAllDomainRows(this.database, 'ContextSegmentSource', {
          source_kind: 'tool_call',
          source_id: toolCallId
        });
        if (pairSources.length !== 1) {
          throw new Error(`Fork source ToolCall ${toolCallId} is unresolved.`);
        }
        const pairSegmentId = requireId(pairSources[0].segment_id, 'ContextSegmentSource.segment_id');
        const pairIndex = segmentIndexes.get(pairSegmentId) ?? -1;
        if (pairIndex <= previousIndex) {
          throw new Error(`Fork source Context root does not contain a canonical ToolCall suffix for ${toolCallId}.`);
        }
        previousIndex = pairIndex;
      }
    }
    return {
      ...source,
      messageRevisionSeq: requireBigInt(revision.revision_seq, 'MessageRevision.revision_seq').toString(),
      contextRootSeq: requireBigInt(contextRoot.root_seq, 'ContextSequenceRoot.root_seq').toString()
    };
  }

  private async admitQueuedIntent(
    intent: DomainRow,
    input: { conversationId: string; leaseOwnerId: string; hostBootId: string; leaseExpiresAt: string }
  ): Promise<TurnCommandResult | null> {
    const intentId = requireId(intent.id, 'TurnIntent.id');
    const conversationId = requireId(intent.conversation_id, 'TurnIntent.conversation_id');
    if (conversationId !== input.conversationId) throw new Error('Queued TurnIntent belongs to another Conversation.');
    const [intentRevisions, presetRevisions, authorityRevisions, executorLinks] = await Promise.all([
      listAllDomainRows(this.database, 'TurnIntentRevision', { intent_id: intentId }),
      this.listRows('TurnExecutionPresetRevision', { intent_id: intentId }, 2),
      this.listRows('TurnIntentAuthorityRevision', { intent_id: intentId }, 2),
      this.listRows('TurnIntentExecutorLink', { intent_id: intentId }, 2)
    ]);
    if (intentRevisions.length < 1 || presetRevisions.length !== 1 || authorityRevisions.length !== 1 || executorLinks.length !== 1) {
      throw new Error(`Queued TurnIntent ${intentId} has incomplete frozen admission facts.`);
    }
    const currentIntentRevision = [...intentRevisions].sort((left, right) => {
      const leftSeq = requireBigInt(left.revision_seq, 'TurnIntentRevision.revision_seq');
      const rightSeq = requireBigInt(right.revision_seq, 'TurnIntentRevision.revision_seq');
      return leftSeq < rightSeq ? 1 : leftSeq > rightSeq ? -1 : 0;
    })[0]!;
    const intentContent = await this.readContentObject(
      requireId(currentIntentRevision.content_object_id, 'TurnIntentRevision.content_object_id')
    );
    // Ensure the frozen preset still exists even though admission needs only its independent authority/executor facts.
    await this.requireExisting('ContentObject', requireId(presetRevisions[0].preset_object_id, 'TurnExecutionPresetRevision.preset_object_id'));
    const authorityObjectId = requireId(
      authorityRevisions[0].authority_object_id,
      'TurnIntentAuthorityRevision.authority_object_id'
    );
    await this.requireExisting('ContentObject', authorityObjectId);
    const executorAgentId = requireId(executorLinks[0].agent_id, 'TurnIntentExecutorLink.agent_id');
    const decoded = await this.decodeQueuedIntent(intentContent);
    const deliveryIntentLink = decoded.operation === 'runtime_continuation'
      ? (await this.listRows('RuntimeDeliveryIntentLink', { turn_intent_id: intentId }, 2))[0]
      : undefined;
    if (decoded.operation === 'runtime_continuation' && !deliveryIntentLink) {
      throw new Error(`Runtime continuation TurnIntent ${intentId} has no RuntimeDeliveryIntentLink.`);
    }
    const ids = dependentStartCommandIds(intentId, decoded.messageContent !== null);
    const admissionReceiptId = intentDependentEntityId(intentId, 'admission_command_receipt');
    const now = this.timestamp();
    const decodedMessageBytes = decoded.messageContent
      ? await this.contentStore.read(decoded.messageContent.metadata)
      : undefined;
    const decodedAttachmentAdmission = decoded.messageContent && decodedMessageBytes
      ? await this.prepareFrozenMessageAttachments(
        decodedMessageBytes,
        decoded.messageContent.metadata.content_type
      )
      : undefined;
    const admittedMessageContent = decoded.messageContent && decodedAttachmentAdmission
      ? await this.contentStore.prepare(
        this.database,
        decodedAttachmentAdmission.value,
        decodedAttachmentAdmission.contentType
      )
      : decoded.messageContent;
    const decodedMessageEstimatedTokens = admittedMessageContent && decodedAttachmentAdmission
      ? estimateStoredMessageContentTokens(
        decodedAttachmentAdmission.value,
        decodedAttachmentAdmission.contentType
      )
      : undefined;
    const messageContext = admittedMessageContent
      ? await this.contextSequence.prepareMessageAppendMutation({
          conversationId,
          messageRevisionId: requireId(ids.messageRevision, 'messageRevisionId'),
          contentObjectId: admittedMessageContent.metadata.id,
          contentByteLength: admittedMessageContent.metadata.byte_length,
          contentEstimatedTokens: decodedMessageEstimatedTokens
        })
      : null;
    const nextDeliverySteps = this.prepareNextTurnDeliverySteps
      ? await this.prepareNextTurnDeliverySteps(
          conversationId,
          ids.turn,
          now,
          deliveryIntentLink ? requireId(deliveryIntentLink.delivery_id, 'RuntimeDeliveryIntentLink.delivery_id') : null
        )
      : [];
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('TurnIntent').assert(intentId, { state: TURN_INTENT_STATE_QUEUED, turn_id: null }),
      ...(deliveryIntentLink ? [
        DOMAIN_REPOSITORIES.domain('RuntimeDeliveryIntentLink').assert(
          requireId(deliveryIntentLink.id, 'RuntimeDeliveryIntentLink.id'),
          {
            delivery_id: requireId(deliveryIntentLink.delivery_id, 'RuntimeDeliveryIntentLink.delivery_id'),
            turn_intent_id: intentId
          }
        )
      ] : []),
      DOMAIN_REPOSITORIES.domain('TurnIntentRevision').assertExactIds(
        { intent_id: intentId },
        intentRevisions.map((revision) => requireId(revision.id, 'TurnIntentRevision.id'))
      ),
      DOMAIN_REPOSITORIES.domain('TurnIntentAuthorityRevision').assert(
        requireId(authorityRevisions[0].id, 'TurnIntentAuthorityRevision.id'),
        { intent_id: intentId, authority_object_id: authorityObjectId }
      ),
      DOMAIN_REPOSITORIES.domain('TurnIntentExecutorLink').assert(
        requireId(executorLinks[0].id, 'TurnIntentExecutorLink.id'),
        { intent_id: intentId, agent_id: executorAgentId }
      ),
      DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: ids.turn,
        conversation_id: conversationId,
        status: TURN_STATUS_ACTIVE,
        created_at: now,
        updated_at: now,
        terminal_at: null
      }),
      DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
        id: admissionReceiptId,
        source_kind: 'internal',
        source_key: `turn-intent-admit:${intentId}`,
        conversation_id: conversationId,
        turn_id: ids.turn,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
        id: ids.lease,
        conversation_id: conversationId,
        turn_id: ids.turn,
        owner_id: requireText(input.leaseOwnerId, 'leaseOwnerId'),
        host_boot_id: requireText(input.hostBootId, 'hostBootId'),
        generation: 1n,
        acquired_at: now,
        expires_at: requireTimestamp(input.leaseExpiresAt, 'leaseExpiresAt')
      }),
      DOMAIN_REPOSITORIES.domain('TurnIntent').update(intentId, {
        turn_id: ids.turn,
        state: TURN_INTENT_STATE_ADMITTED,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').insert({
        id: ids.authoritySnapshot,
        turn_id: ids.turn,
        content_object_id: authorityObjectId,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('TurnExecutorLink').insert({
        id: ids.executorLink,
        turn_id: ids.turn,
        agent_id: executorAgentId,
        created_at: now
      }),
      ...(decodedAttachmentAdmission?.storageSteps ?? []),
      ...(admittedMessageContent
        ? preparedContentObjectSteps([admittedMessageContent], 'queued_message_content')
        : []),
      ...(admittedMessageContent ? messageAdmissionSteps(
        { receipt: admissionReceiptId, intent: intentId, ...ids },
        admittedMessageContent,
        conversationId,
        now
      ) : []),
      ...(decodedAttachmentAdmission && ids.messageRevision && this.attachments
        ? this.attachments.linkSteps(decodedAttachmentAdmission, ids.messageRevision, now)
        : []),
      ...(messageContext?.steps ?? []),
      ...nextDeliverySteps,
      DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
    ];
    try {
      const commit = await this.database.transaction(steps);
      return {
        receiptId: admissionReceiptId,
        deduplicated: false,
        commitSeq: commit.commitSeq,
        conversationId,
        intentId,
        admitted: true,
        turnId: ids.turn,
        ...(admittedMessageContent ? {
          messageId: ids.message,
          messageRevisionId: ids.messageRevision,
          messageRevisionSeq: allocatedRuntimeValue(
            commit.allocatedSequences,
            'MessageRevision',
            requireId(ids.messageRevision, 'messageRevisionId'),
            'revision_seq'
          )
        } : {})
      };
    } catch (error) {
      if (isTransactionAssertionError(error) || isLeaseAdmissionConflict(error)) return null;
      throw error;
    }
  }

  private async decodeQueuedIntent(intentContent: ContentObjectMetadata): Promise<{
    operation: 'input' | 'retry' | 'continuation' | 'runtime_continuation';
    messageContent: PreparedContentObject | null;
  }> {
    if (intentContent.content_type !== TURN_INTENT_ENVELOPE_CONTENT_TYPE) {
      return { operation: 'input', messageContent: { metadata: intentContent } };
    }
    const value = JSON.parse((await this.contentStore.read(intentContent)).toString('utf8')) as Record<string, unknown>;
    const inputEnvelope = parseInputTurnIntentEnvelope(value);
    if (inputEnvelope) {
      return {
        operation: 'input',
        messageContent: {
          metadata: await this.readContentObject(inputEnvelope.messageContentObjectId)
        }
      };
    }
    const runtimeContinuationEnvelope = parseRuntimeContinuationTurnIntentEnvelope(value);
    if (runtimeContinuationEnvelope) {
      return { operation: 'runtime_continuation', messageContent: null };
    }
    if (value.kind === 'retry') return { operation: 'retry', messageContent: null };
    if (value.kind !== 'continuation') throw new Error('Queued TurnIntent has an unsupported intent envelope.');
    const objectId = requireId(value.messageContentObjectId, 'TurnIntent continuation.messageContentObjectId');
    return { operation: 'continuation', messageContent: { metadata: await this.readContentObject(objectId) } };
  }

  private async prepareMessageAttachments(
    content: TurnCommandContent,
    contentType: string
  ): Promise<PreparedMessageAttachmentAdmission> {
    if (this.attachments) return this.attachments.prepareMessageContent({ content, contentType });
    return {
      value: content,
      contentType,
      attachments: [],
      storageSteps: [],
      totalBytes: 0
    };
  }

  private async prepareFrozenMessageAttachments(
    content: TurnCommandContent,
    contentType: string
  ): Promise<PreparedMessageAttachmentAdmission> {
    if (this.attachments) return this.attachments.prepareFrozenMessageContent({ content, contentType });
    return {
      value: content,
      contentType,
      attachments: [],
      storageSteps: [],
      totalBytes: 0
    };
  }

  private async readContentObject(id: string): Promise<ContentObjectMetadata> {
    return await this.requireExisting('ContentObject', id) as ContentObjectMetadata;
  }

  private async listRows(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })]);
    const rows = snapshot.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} list did not return rows.`);
    return rows;
  }

  private async startIntent(plan: StartIntentPlan): Promise<TurnCommandResult> {
    const command = normalizeExecutionCommand(plan.command, plan.operation);
    const source = normalizeInitiatingSource(command.source, plan.operation);
    const retryTarget = plan.retryTarget ? normalizeRetryTarget(plan.retryTarget) : undefined;
    const commandScopeParts: unknown[] = [
      command.conversationId,
      plan.sourceTurnId ?? null,
      retryTarget ?? null,
      command.membership ?? null
    ];
    if (plan.deliveryId) commandScopeParts.push(plan.deliveryId);
    if (plan.runtimeMaintenance?.version === 2) commandScopeParts.push(plan.runtimeMaintenance);
    const commandScope = JSON.stringify(commandScopeParts);
    const baseIds = startCommandIds(source, plan.operation, plan.messageContent !== undefined, commandScope);
    const scopedIds = command.membership
      ? childExecutionStartIds(baseIds, command.membership.childExecutionId, plan.messageContent !== undefined)
      : baseIds;
    const ids: StartCommandIds = plan.deliveryId
      ? {
          ...scopedIds,
          runtimeDeliveryIntentLink: intentDependentEntityId(scopedIds.intent, 'runtime_delivery_intent_link')
        }
      : scopedIds;
    const duplicate = await this.findReceipt(source);
    if (duplicate) {
      return this.replayStartResult(
        duplicate,
        ids,
        plan.operation,
        command.conversationId,
        plan.deliveryId
      );
    }

    const conversation = await this.getConversation(command.conversationId);
    if (plan.runtimeMaintenance) await this.requireConversationIdle(command.conversationId);
    if (plan.sourceTurnId) {
      const sourceTurnId = requireId(plan.sourceTurnId, 'sourceTurnId');
      const sourceTurn = await this.getTurn(sourceTurnId);
      if (sourceTurn.conversation_id !== conversation.id) {
        throw new Error(`Source Turn ${sourceTurnId} does not belong to Conversation ${conversation.id}.`);
      }
    }
    const retryRewind = plan.rewindSourceOutput
      ? await this.prepareRetryRewindMutation({
          conversationId: conversation.id as string,
          sourceTurnId: requireId(plan.sourceTurnId, 'sourceTurnId'),
          target: requireRetryTarget(retryTarget),
          ...(plan.expectedMessageRevisionId
            ? { expectedMessageRevisionId: plan.expectedMessageRevisionId }
            : {}),
          idempotencyKey: ids.intent
        })
      : null;
    let compiled = plan.inheritSourceAuthority
      ? await this.inheritTurnAuthority(
          requireId(plan.sourceTurnId, 'sourceTurnId'),
          ids.turn,
          conversation.id as string,
          plan.operation
        )
      : await this.compileCurrentAuthority(
          conversation.id as string,
          ids.turn,
          plan.operation,
          plan.sourceTurnId,
          command.executorAgentId,
          command.modelOverride,
          command.membership
        );
    if (retryRewind) compiled = withRetryLineage(compiled, retryRewind.lineage);
    const now = this.timestamp();

    const messageAttachmentAdmission = plan.messageContent === undefined
      ? undefined
      : await this.prepareMessageAttachments(
        plan.messageContent,
        requireContentType(plan.messageContentType ?? 'text/plain')
      );
    const messageContent = messageAttachmentAdmission === undefined
      ? undefined
      : await this.contentStore.prepare(
        this.database,
        messageAttachmentAdmission.value,
        messageAttachmentAdmission.contentType
      );
    const messageContentEstimatedTokens = messageAttachmentAdmission === undefined
      ? undefined
      : estimateStoredMessageContentTokens(
        messageAttachmentAdmission.value,
        messageAttachmentAdmission.contentType
      );
    const intentContent = plan.operation === 'input'
      ? await this.contentStore.prepare(
          this.database,
          JSON.stringify(inputTurnIntentEnvelope({
            messageContentObjectId: requirePrepared(messageContent, 'input message content').metadata.id,
            position: initialGuidancePosition(now)
          })),
          TURN_INTENT_ENVELOPE_CONTENT_TYPE
        )
      : plan.operation === 'runtime_continuation'
        ? await this.contentStore.prepare(
            this.database,
            JSON.stringify(runtimeContinuationTurnIntentEnvelope({
              sourceTurnId: plan.inheritSourceAuthority ? requireId(plan.sourceTurnId, 'sourceTurnId') : null
            })),
            TURN_INTENT_ENVELOPE_CONTENT_TYPE
          )
        : await this.contentStore.prepare(
        this.database,
        JSON.stringify({
          kind: plan.operation,
          sourceTurnId: plan.runtimeMaintenance && plan.sourceTurnId === undefined
            ? null
            : requireId(plan.sourceTurnId, 'sourceTurnId'),
          ...(retryRewind?.lineage.sourceMessageId
            ? { sourceMessageId: retryRewind.lineage.sourceMessageId }
            : {}),
          ...(retryRewind?.lineage.sourceMessageRevisionId
            ? { sourceMessageRevisionId: retryRewind.lineage.sourceMessageRevisionId }
            : {}),
          ...(retryRewind?.lineage.sourceModelRequestId
            ? { sourceModelRequestId: retryRewind.lineage.sourceModelRequestId }
            : {}),
          ...(messageContent ? { messageContentObjectId: messageContent.metadata.id } : {}),
          ...(plan.runtimeMaintenance ? { runtimeMaintenance: plan.runtimeMaintenance } : {})
        }),
        TURN_INTENT_ENVELOPE_CONTENT_TYPE
      );
    const presetContent = await this.contentStore.prepare(
      this.database,
      compiled.executionPreset.content,
      compiled.executionPreset.contentType
    );
    const authorityContent = await this.contentStore.prepare(
      this.database,
      compiled.authoritySnapshot.content,
      compiled.authoritySnapshot.contentType
    );

    const messageContext = messageContent
      ? await this.contextSequence.prepareMessageAppendMutation({
          conversationId: conversation.id as string,
          messageRevisionId: requireId(ids.messageRevision, 'message revision id'),
          contentObjectId: messageContent.metadata.id,
          contentByteLength: messageContent.metadata.byte_length,
          contentEstimatedTokens: messageContentEstimatedTokens
        })
      : null;
    const continuationSteps = plan.operation === 'runtime_continuation' && plan.deliveryId && this.prepareRuntimeContinuationSteps
      ? await this.prepareRuntimeContinuationSteps(plan.deliveryId)
      : [];
    // A manual compression or summary rebuild runs no model over new input: pending deliveries
    // stay for the next real Turn instead of blocking this Turn's terminal commit forever.
    const nextDeliverySteps = this.prepareNextTurnDeliverySteps && !plan.runtimeMaintenance
      ? await this.prepareNextTurnDeliverySteps(conversation.id as string, ids.turn, now, plan.deliveryId ?? null)
      : [];
    const childAdmission = command.membership
      ? await this.prepareChildAdmission({
          membership: command.membership,
          conversationId: conversation.id as string,
          intentId: ids.intent,
          turnId: ids.turn,
          ...(plan.sourceTurnId ? { expectedPreviousTurnId: plan.sourceTurnId } : {}),
          now
        })
      : null;

    const admission: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('Turn').insert({
        id: ids.turn,
        conversation_id: conversation.id,
        status: TURN_STATUS_ACTIVE,
        created_at: now,
        updated_at: now,
        terminal_at: null
      }),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
        id: ids.lease,
        conversation_id: conversation.id,
        turn_id: ids.turn,
        owner_id: command.leaseOwnerId,
        host_boot_id: command.hostBootId,
        generation: 1n,
        acquired_at: now,
        expires_at: command.leaseExpiresAt
      }),
      DOMAIN_REPOSITORIES.domain('TurnIntent').update(ids.intent, {
        turn_id: ids.turn,
        state: TURN_INTENT_STATE_ADMITTED,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').insert({
        id: ids.authoritySnapshot,
        turn_id: ids.turn,
        content_object_id: authorityContent.metadata.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('TurnExecutorLink').insert({
        id: ids.executorLink,
        turn_id: ids.turn,
        agent_id: compiled.executorAgentId,
        created_at: now
      })
    ];
    if (messageContent) {
      admission.push(...messageAdmissionSteps(ids, messageContent, conversation.id as string, now));
      if (messageAttachmentAdmission && this.attachments) {
        admission.push(...this.attachments.linkSteps(
          messageAttachmentAdmission,
          requireId(ids.messageRevision, 'message revision id'),
          now
        ));
      }
      admission.push(...messageContext!.steps);
    }
    if (childAdmission) admission.push(...childAdmission.admissionSteps);
    admission.push(...nextDeliverySteps);

    const commit = await this.commitWithReceipt({
      source,
      receiptId: ids.receipt,
      conversationId: conversation.id as string,
      turnId: null,
      requiresConversationIdle: Boolean(retryRewind || plan.runtimeMaintenance),
      steps: [
        ...(plan.runtimeMaintenance ? conversationIdleAssertionSteps(conversation.id as string) : []),
        ...(retryRewind?.steps ?? []),
        ...(messageAttachmentAdmission?.storageSteps ?? []),
        ...preparedContentObjectSteps([
          intentContent,
          presetContent,
          authorityContent,
          ...(messageContent ? [messageContent] : [])
        ], 'intent_content'),
        ...(plan.deliveryId ? [
          DOMAIN_REPOSITORIES.domain('RuntimeDelivery').assert(plan.deliveryId, {
            target_conversation_id: conversation.id,
            target_turn_id: null,
            phase: 'next_turn',
            state: 'pending'
          })
        ] : []),
        ...continuationSteps,
        DOMAIN_REPOSITORIES.domain('TurnIntent').insert({
          id: ids.intent,
          conversation_id: conversation.id,
          turn_id: null,
          state: TURN_INTENT_STATE_QUEUED,
          created_at: now,
          updated_at: now
        }),
        ...(plan.deliveryId ? [
          DOMAIN_REPOSITORIES.domain('RuntimeDeliveryIntentLink').insert({
            id: requireId(ids.runtimeDeliveryIntentLink, 'RuntimeDeliveryIntentLink.id'),
            delivery_id: plan.deliveryId,
            turn_intent_id: ids.intent,
            created_at: now
          })
        ] : []),
        DOMAIN_REPOSITORIES.domain('TurnIntentRevision').insert({
          id: ids.intentRevision,
          intent_id: ids.intent,
          revision_seq: '1',
          content_object_id: intentContent.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('TurnExecutionPresetRevision').insert({
          id: ids.presetRevision,
          intent_id: ids.intent,
          revision_seq: '1',
          preset_object_id: presetContent.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('TurnIntentAuthorityRevision').insert({
          id: ids.authorityRevision,
          intent_id: ids.intent,
          revision_seq: '1',
          authority_object_id: authorityContent.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('TurnIntentExecutorLink').insert({
          id: ids.intentExecutorLink,
          intent_id: ids.intent,
          agent_id: compiled.executorAgentId,
          created_at: now
        }),
        ...(childAdmission?.outerSteps ?? []),
        DOMAIN_REPOSITORIES.domain('Conversation').update(conversation.id as string, { updated_at: now }),
        ...(retryRewind || plan.runtimeMaintenance
          ? admission
          : [savepoint('admit_turn_intent', admission, {
              kind: 'rollback-and-continue-on-unique',
              constraints: [{ domain: 'ExecutionLease', columns: ['conversation_id'] }]
            })])
      ]
    });
    if (commit.deduplicated) {
      return this.replayStartResult(
        commit.receipt,
        ids,
        plan.operation,
        command.conversationId,
        plan.deliveryId
      );
    }
    return this.readStartResult(commit, ids, command.conversationId);
  }

  private async prepareChildAdmission(input: {
    membership: TurnExecutionMembership;
    conversationId: string;
    intentId: string;
    turnId: string;
    expectedPreviousTurnId?: string;
    now: string;
  }): Promise<ChildAdmissionPlan> {
    const childExecutionId = requireId(input.membership.childExecutionId, 'membership.childExecutionId');
    const child = await this.requireExisting('ChildExecution', childExecutionId);
    if (child.child_conversation_id !== input.conversationId) {
      throw new Error(`ChildExecution ${childExecutionId} does not own Conversation ${input.conversationId}.`);
    }
    const childStatus = requireChildExecutionStatus(child.status);
    if (!childExecutionAcceptsContinuation(childStatus)) {
      throw new Error(`ChildExecution ${childExecutionId} no longer accepts a new Turn.`);
    }
    const [bridges, activeLinks, turnLinks, pendingIntentLinks] = await Promise.all([
      this.listRows('AnswerBridge', { child_execution_id: childExecutionId }, 2),
      this.listRows('ChildExecutionActiveTurnLink', { child_execution_id: childExecutionId }, 2),
      listAllDomainRows(this.database, 'ChildExecutionTurnLink', { child_execution_id: childExecutionId }),
      this.listRows('ChildExecutionIntentLink', { child_execution_id: childExecutionId, state: 'pending' }, 2)
    ]);
    if (bridges.length !== 1 || bridges[0].status === 'closed') {
      throw new Error(`ChildExecution ${childExecutionId} must retain one open AnswerBridge.`);
    }
    if (activeLinks.length > 1) throw new Error(`ChildExecution ${childExecutionId} has multiple active Turn links.`);
    if (pendingIntentLinks.length > 0) {
      throw new Error(`ChildExecution ${childExecutionId} already has a pending continuation.`);
    }
    const latestLink = [...turnLinks].sort((left, right) => {
      const leftSeq = requireBigInt(left.turn_seq, 'ChildExecutionTurnLink.turn_seq');
      const rightSeq = requireBigInt(right.turn_seq, 'ChildExecutionTurnLink.turn_seq');
      return leftSeq < rightSeq ? 1 : leftSeq > rightSeq ? -1 : 0;
    })[0];
    if (!latestLink) throw new Error(`ChildExecution ${childExecutionId} has no Turn lineage.`);
    if (
      input.expectedPreviousTurnId
      && !turnLinks.some((link) => link.turn_id === input.expectedPreviousTurnId)
    ) {
      throw new Error(`Source Turn ${input.expectedPreviousTurnId} is not a member of ChildExecution ${childExecutionId}.`);
    }
    const previousTurnId = requireId(latestLink.turn_id, 'latest ChildExecutionTurnLink.turn_id');
    const previousTurn = await this.getTurn(previousTurnId);
    const activeLink = activeLinks[0] ?? null;
    if (activeLink && activeLink.turn_id !== previousTurnId) {
      throw new Error(`ChildExecution ${childExecutionId} active pointer is not its latest generation.`);
    }
    const bridge = bridges[0];
    const intentLinkId = childIntentLinkId(childExecutionId, input.intentId);
    const turnLinkId = childTurnLinkId(childExecutionId, input.intentId);
    const activeLinkId = stablePhaseFId('child_execution_active_turn_link', childExecutionId);
    return {
      outerSteps: [
        DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').insertWithNextSequence({
          id: intentLinkId,
          child_execution_id: childExecutionId,
          turn_intent_id: input.intentId,
          state: 'pending',
          created_at: input.now,
          updated_at: input.now
        }, {
          column: 'intent_seq',
          scope: { child_execution_id: childExecutionId }
        })
      ],
      admissionSteps: [
        DOMAIN_REPOSITORIES.domain('ChildExecution').assert(childExecutionId, { status: child.status }),
        DOMAIN_REPOSITORIES.domain('AnswerBridge').assert(requireId(bridge.id, 'AnswerBridge.id'), {
          child_execution_id: childExecutionId,
          status: bridge.status,
          current_submission_id: bridge.current_submission_id
        }),
        DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').assertExactIds(
          { child_execution_id: childExecutionId },
          turnLinks.map((link) => requireId(link.id, 'ChildExecutionTurnLink.id'))
        ),
        DOMAIN_REPOSITORIES.domain('Turn').assert(previousTurnId, { status: TURN_STATUS_TERMINATED }),
        ...(activeLink
          ? [
              DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assert(
                requireId(activeLink.id, 'ChildExecutionActiveTurnLink.id'),
                { child_execution_id: childExecutionId, turn_id: previousTurnId }
              ),
              DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').update(
                requireId(activeLink.id, 'ChildExecutionActiveTurnLink.id'),
                { turn_id: input.turnId, updated_at: input.now }
              )
            ]
          : [
              DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').assertNone({
                child_execution_id: childExecutionId
              }),
              DOMAIN_REPOSITORIES.domain('ChildExecutionActiveTurnLink').insert({
                id: activeLinkId,
                child_execution_id: childExecutionId,
                turn_id: input.turnId,
                updated_at: input.now
              })
            ]),
        DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').assert(intentLinkId, {
          child_execution_id: childExecutionId,
          turn_intent_id: input.intentId,
          state: 'pending'
        }),
        DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').update(intentLinkId, {
          state: 'admitted',
          updated_at: input.now
        }),
        DOMAIN_REPOSITORIES.domain('ChildExecutionTurnLink').insertWithNextSequence({
          id: turnLinkId,
          child_execution_id: childExecutionId,
          turn_id: input.turnId,
          created_at: input.now
        }, {
          column: 'turn_seq',
          scope: { child_execution_id: childExecutionId }
        }),
        DOMAIN_REPOSITORIES.domain('AnswerBridge').update(requireId(bridge.id, 'AnswerBridge.id'), {
          status: 'open',
          current_submission_id: null,
          updated_at: input.now
        }),
        DOMAIN_REPOSITORIES.domain('ChildExecution').update(childExecutionId, {
          status: 'active',
          updated_at: input.now
        })
      ]
    };
  }

  private async compileCurrentAuthority(
    conversationId: string,
    turnId: string,
    intentKind: StartIntentPlan['operation'],
    sourceTurnId?: string,
    requestedExecutorAgentId?: string,
    modelOverride?: TurnModelOverride,
    membership?: TurnExecutionMembership
  ): Promise<ReturnType<typeof normalizeCompiledTurnAuthority>> {
    const childExecutionId = membership
      ? requireId(membership.childExecutionId, 'membership.childExecutionId')
      : undefined;
    // A Turn the user starts in a child conversation keeps the child's bounds: the tools and skills
    // inherited at spawn, and the work environments of its latest Turn, as a continuation would.
    const [defaultAgent, workspace, boundary, inheritedWorkEnvironmentPolicy] = await Promise.all([
      requestedExecutorAgentId ? Promise.resolve(undefined) : this.getDefaultAgent(conversationId),
      projectFolderForConversation(this.database, conversationId),
      childExecutionId
        ? readChildExecutionBoundary(this.database, this.contentStore, childExecutionId)
        : Promise.resolve(undefined),
      childExecutionId
        ? readChildExecutionWorkEnvironmentBoundary(this.database, this.contentStore, childExecutionId)
        : Promise.resolve(undefined)
    ]);
    const executorAgentId = requestedExecutorAgentId
      ? requireId(requestedExecutorAgentId, 'TurnExecutionCommand.executorAgentId')
      : requireId(defaultAgent?.agent_id, 'AgentConversationLink.agent_id');
    return normalizeCompiledTurnAuthority(await this.authorityCompiler.compile({
      conversationId,
      turnId,
      executorAgentId,
      intentKind,
      ...(sourceTurnId ? { sourceTurnId: requireId(sourceTurnId, 'sourceTurnId') } : {}),
      ...(modelOverride ? { modelOverride } : {}),
      ...(workspace ? { workspace } : {}),
      ...(inheritedWorkEnvironmentPolicy ? { inheritedWorkEnvironmentPolicy } : {}),
      ...(boundary?.toolPolicy ? { inheritedToolPolicy: boundary.toolPolicy } : {}),
      ...(boundary?.skillPolicy ? { inheritedSkillPolicy: boundary.skillPolicy } : {})
    }), turnId, executorAgentId);
  }

  private async inheritTurnAuthority(
    sourceTurnId: string,
    targetTurnId: string,
    conversationId: string,
    intentKind: StartIntentPlan['operation']
  ): Promise<ReturnType<typeof normalizeCompiledTurnAuthority>> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').list({ where: { turn_id: sourceTurnId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('TurnExecutorLink').list({ where: { turn_id: sourceTurnId }, limit: 2 })
    ]);
    const authorityRows = rows(snapshot.snapshot[0]);
    const executorRows = rows(snapshot.snapshot[1]);
    if (authorityRows.length !== 1 || executorRows.length !== 1) {
      throw new Error(`Source Turn ${sourceTurnId} has incomplete frozen authority facts.`);
    }
    const executorAgentId = requireId(executorRows[0].agent_id, 'TurnExecutorLink.agent_id');
    const metadata = await this.readContentObject(requireId(
      authorityRows[0].content_object_id,
      'AuthoritySnapshot.content_object_id'
    ));
    let parsed: unknown;
    try {
      parsed = JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as unknown;
    } catch (error) {
      throw new Error(`Source Turn ${sourceTurnId} authority is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const normalized = normalizePlainJson(parsed, `Source Turn ${sourceTurnId} authority`);
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
      throw new Error(`Source Turn ${sourceTurnId} authority must be a JSON object.`);
    }
    const authority = canonicalPlainJson({
      ...normalized,
      turnId: targetTurnId,
      conversationId,
      executorAgentId,
      intentKind,
      sourceTurnId
    }, 'Inherited Turn authority');
    return normalizeCompiledTurnAuthority({
      turnId: targetTurnId,
      executorAgentId,
      executionPreset: {
        content: canonicalPlainJson({
          kind: 'turn-execution-preset',
          turnId: targetTurnId,
          executorAgentId,
          inheritedFromTurnId: sourceTurnId
        }),
        contentType: CONTENT_TYPE_PRESET
      },
      authoritySnapshot: {
        content: authority,
        contentType: metadata.content_type
      }
    }, targetTurnId, executorAgentId);
  }

  private async prepareRetryRewindMutation(input: {
    conversationId: string;
    sourceTurnId: string;
    target: MessageRetryTarget;
    expectedMessageRevisionId?: string;
    idempotencyKey: string;
  }): Promise<RetryRewindPlan> {
    const conversationId = requireId(input.conversationId, 'conversationId');
    const sourceTurnId = requireId(input.sourceTurnId, 'sourceTurnId');
    const target = normalizeRetryTarget(input.target);
    await this.requireConversationIdle(conversationId);
    const sourceTurn = await this.getTurn(sourceTurnId);
    if (sourceTurn.conversation_id !== conversationId) {
      throw new Error(`Source Turn ${sourceTurnId} does not belong to Conversation ${conversationId}.`);
    }
    if (sourceTurn.status !== TURN_STATUS_TERMINATED) {
      throw new Error(`Source Turn ${sourceTurnId} is not terminal and cannot be retried safely.`);
    }
    const messageSnapshot = await this.conversationMessageSnapshot(conversationId);
    const entryByMessageId = new Map(messageSnapshot.entries.map((entry) => [
      requireId(entry.message.id, 'Message.id'),
      entry
    ]));
    const baseSteps: RepositoryTransactionStep[] = [
      ...conversationIdleAssertionSteps(conversationId),
      DOMAIN_REPOSITORIES.domain('Turn').assert(sourceTurnId, {
        conversation_id: conversationId,
        status: TURN_STATUS_TERMINATED
      }),
      DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').assertExactIds(
        { conversation_id: conversationId },
        messageSnapshot.membershipIds
      )
    ];
    const heads = await this.listRows('ConversationContextHeadLink', { conversation_id: conversationId }, 2);
    if (heads.length !== 1) throw new Error(`Conversation ${conversationId} has no unique retryable Context head.`);
    const head = heads[0];
    const rootId = requireId(head.root_id, 'ConversationContextHeadLink.root_id');

    if (target.kind === 'model_request') {
      const modelRequestId = requireId(target.modelRequestId, 'RetryTarget.modelRequestId');
      const request = await this.requireExisting('ModelRequest', modelRequestId);
      if (request.turn_id !== sourceTurnId || request.status !== 'terminal') {
        throw new Error(`ModelRequest ${modelRequestId} is not a terminal output of source Turn ${sourceTurnId}.`);
      }
      const projections = await this.listRows('ModelContextProjection', {
        owner_kind: 'model_request',
        owner_id: modelRequestId
      }, 2);
      if (projections.length !== 1) throw new Error(`ModelRequest ${modelRequestId} has no unique frozen Context root.`);
      const projection = projections[0];
      const frozenRootId = requireId(projection.root_id, 'ModelContextProjection.root_id');
      if (frozenRootId !== rootId) {
        throw new Error(`Retry target ${modelRequestId} is stale because its frozen Context is no longer current.`);
      }
      const inheritedPlanApprovalToolCallId = await this.findInheritedPlanApproval({
        sourceTurnId,
        rootId,
        beforeModelRequestSeq: requireBigInt(request.request_seq, 'ModelRequest.request_seq')
      });
      return {
        lineage: {
          sourceTurnId,
          sourceModelRequestId: modelRequestId,
          ...(inheritedPlanApprovalToolCallId ? { inheritedPlanApprovalToolCallId } : {})
        },
        steps: [
          ...baseSteps,
          DOMAIN_REPOSITORIES.domain('ModelRequest').assert(modelRequestId, {
            turn_id: sourceTurnId,
            request_seq: requireBigInt(request.request_seq, 'ModelRequest.request_seq'),
            status: 'terminal'
          }),
          DOMAIN_REPOSITORIES.domain('ModelContextProjection').assert(
            requireId(projection.id, 'ModelContextProjection.id'),
            { owner_kind: 'model_request', owner_id: modelRequestId, root_id: frozenRootId }
          ),
          DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').assert(
            requireId(head.id, 'ConversationContextHeadLink.id'),
            { conversation_id: conversationId, root_id: rootId }
          )
        ]
      };
    }

    const boundaryMessageId = requireId(target.messageId, 'RetryTarget.messageId');
    const boundary = entryByMessageId.get(boundaryMessageId);
    if (!boundary) throw new Error(`Retry target Message ${boundaryMessageId} is outside Conversation ${conversationId}.`);
    const relation = await this.getMessageRelation(conversationId, boundaryMessageId);
    if (relation.message.deleted_at !== null) throw new Error(`Retry target Message ${boundaryMessageId} is soft-deleted.`);
    if (relation.currentRevision.role !== 'model') throw new Error('Only a model Message can be retried.');
    const modelTurnLinks = await this.listRows('MessageTurnLink', {
      message_id: boundaryMessageId,
      role: 'model'
    }, 2);
    if (modelTurnLinks.length !== 1 || modelTurnLinks[0].turn_id !== sourceTurnId) {
      throw new Error(`Retry target Message ${boundaryMessageId} is not the model output of source Turn ${sourceTurnId}.`);
    }
    const boundaryRevisionId = requireId(relation.currentRevision.id, 'current MessageRevision.id');
    const expectedRevisionId = requireId(
      input.expectedMessageRevisionId,
      'RetryTarget.expectedMessageRevisionId'
    );
    if (boundaryRevisionId !== expectedRevisionId) {
      throw new Error(`Retry target Message ${boundaryMessageId} changed since it was displayed.`);
    }
    const contextPlan = await this.contextSequence.prepareMessageTruncateMutation({
      conversationId,
      messageRevisionId: boundaryRevisionId,
      idempotencyKey: requireId(input.idempotencyKey, 'idempotencyKey')
    });
    const inheritedPlanApprovalToolCallId = await this.findInheritedPlanApproval({
      sourceTurnId,
      rootId,
      beforeMessageSeq: boundary.messageSeq
    });
    const targets = messageSnapshot.entries.filter((entry) => entry.messageSeq >= boundary.messageSeq);
    const now = this.timestamp();
    return {
      lineage: {
        sourceTurnId,
        sourceMessageId: boundaryMessageId,
        sourceMessageRevisionId: boundaryRevisionId,
        ...(inheritedPlanApprovalToolCallId ? { inheritedPlanApprovalToolCallId } : {})
      },
      steps: [
        ...baseSteps,
        DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').assert(
          requireId(relation.currentLink.id, 'MessageCurrentRevisionLink.id'),
          { revision_id: boundaryRevisionId }
        ),
        ...contextPlan.steps,
        ...softDeleteEntrySteps(targets, now)
      ]
    };
  }

  private async findInheritedPlanApproval(input: {
    sourceTurnId: string;
    rootId: string;
    beforeMessageSeq?: bigint;
    beforeModelRequestSeq?: bigint;
  }): Promise<string | undefined> {
    const calls = (await listAllDomainRows(this.database, 'ToolCall', {
      turn_id: input.sourceTurnId,
      tool_name: 'submit_plan'
    })).sort((left, right) => {
      const leftSeq = requireBigInt(left.call_seq, 'ToolCall.call_seq');
      const rightSeq = requireBigInt(right.call_seq, 'ToolCall.call_seq');
      return leftSeq < rightSeq ? 1 : leftSeq > rightSeq ? -1 : 0;
    });
    for (const call of calls) {
      const toolCallId = requireId(call.id, 'ToolCall.id');
      const links = await this.listRows('ToolCallSourceLink', { tool_call_id: toolCallId }, 2);
      if (links.length !== 1) continue;
      const source = links[0];
      if (input.beforeMessageSeq !== undefined) {
        const memberships = await this.listRows('MessagePartOfConversation', {
          message_id: requireId(source.message_id, 'ToolCallSourceLink.message_id')
        }, 2);
        if (
          memberships.length !== 1
          || requireBigInt(memberships[0].message_seq, 'MessagePartOfConversation.message_seq') >= input.beforeMessageSeq
        ) continue;
      }
      if (input.beforeModelRequestSeq !== undefined) {
        const request = await this.requireExisting(
          'ModelRequest',
          requireId(source.model_request_id, 'ToolCallSourceLink.model_request_id')
        );
        if (requireBigInt(request.request_seq, 'ModelRequest.request_seq') >= input.beforeModelRequestSeq) continue;
      }
      if (!await this.isApprovedPlanToolCall(call)) continue;
      if (!await contextRootContainsCompleteToolPair(this.database, input.rootId, toolCallId)) continue;
      return toolCallId;
    }
    return undefined;
  }

  private async isApprovedPlanToolCall(call: DomainRow): Promise<boolean> {
    const toolCallId = requireId(call.id, 'ToolCall.id');
    const outcomes = await this.listRows('ToolOutcome', { tool_call_id: toolCallId }, 2);
    if (outcomes.length !== 1 || outcomes[0].status !== 'succeeded') return false;
    const artifacts = await this.listRows('ToolResultArtifact', {
      tool_call_id: toolCallId,
      role: 'no_effect_result'
    }, 2);
    if (artifacts.length !== 1) return false;
    const metadata = await this.requireExisting(
      'ContentObject',
      requireId(artifacts[0].content_object_id, 'ToolResultArtifact.content_object_id')
    ) as unknown as ContentObjectMetadata;
    const body = JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as Record<string, unknown>;
    const detail = body.detail && typeof body.detail === 'object' && !Array.isArray(body.detail)
      ? body.detail as Record<string, unknown>
      : undefined;
    // A fork copies the ToolCall but shares the artifact content naming the original call.
    return body.status === 'succeeded'
      && detail?.status === 'approved'
      && await toolArtifactIdentifiesCall(this.database, body.toolCallId, call);
  }

  private async editMessage(commandInput: TurnEditCommand): Promise<TurnCommandResult> {
    const source = normalizeInitiatingSource(commandInput.source, 'edit');
    const conversationId = requireId(commandInput.conversationId, 'conversationId');
    const messageId = requireId(commandInput.messageId, 'messageId');
    const expectedRevisionId = commandInput.expectedRevisionId === undefined
      ? undefined
      : requireId(commandInput.expectedRevisionId, 'expectedRevisionId');
    const deleteFollowing = commandInput.deleteFollowing === true;
    const commandScope = JSON.stringify([conversationId, messageId, expectedRevisionId ?? null]);
    const revisionId = commandEntityId(source, 'edit', 'message_revision', commandScope);
    const receiptId = commandEntityId(source, 'edit', 'command_receipt', commandScope);
    const duplicate = await this.findReceipt(source);
    if (duplicate) return this.replayEditResult(duplicate, receiptId, conversationId, messageId, revisionId);
    await this.requireConversationIdle(conversationId);
    const relation = await this.getMessageRelation(conversationId, messageId);
    if (relation.message.deleted_at !== null) throw new Error(`Message ${messageId} is soft-deleted.`);
    if (expectedRevisionId && relation.currentRevision.id !== expectedRevisionId) {
      throw new Error(`Message ${messageId} revision changed before edit; refresh and retry.`);
    }
    const messageSnapshot = deleteFollowing
      ? await this.conversationMessageSnapshot(conversationId)
      : null;
    const sourceMessageSeq = requireBigInt(relation.membership.message_seq, 'MessagePartOfConversation.message_seq');
    const suffix = messageSnapshot
      ? messageSnapshot.entries.filter((entry) => entry.messageSeq > sourceMessageSeq)
      : [];
    const now = this.timestamp();
    const contentType = requireContentType(commandInput.contentType ?? 'text/plain');
    const attachmentAdmission = await this.prepareMessageAttachments(commandInput.content, contentType);
    const content = await this.contentStore.prepare(
      this.database,
      attachmentAdmission.value,
      attachmentAdmission.contentType
    );
    const previousRevisionId = requireId(relation.currentRevision.id, 'current MessageRevision.id');
    const contextPlan = deleteFollowing
      ? await this.contextSequence.prepareMessageTruncateMutation({
          conversationId,
          messageRevisionId: previousRevisionId,
          idempotencyKey: source.key,
          replacement: {
            messageRevisionId: revisionId,
            contentObjectId: content.metadata.id,
            contentByteLength: content.metadata.byte_length,
            contentEstimatedTokens: estimateStoredMessageContentTokens(
              attachmentAdmission.value,
              attachmentAdmission.contentType
            )
          }
        })
      : await this.contextSequence.prepareMessageEditMutation({
          conversationId,
          previousMessageRevisionId: previousRevisionId,
          nextMessageRevisionId: revisionId,
          contentObjectId: content.metadata.id,
          contentByteLength: content.metadata.byte_length
        });
    const commit = await this.commitWithReceipt({
      source,
      receiptId,
      conversationId,
      turnId: null,
      requiresConversationIdle: true,
      steps: [
        ...conversationIdleAssertionSteps(conversationId),
        ...(messageSnapshot ? [DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').assertExactIds(
          { conversation_id: conversationId },
          messageSnapshot.membershipIds
        )] : []),
        DOMAIN_REPOSITORIES.domain('Message').assert(messageId, { deleted_at: null }),
        DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').assert(
          requireId(relation.currentLink.id, 'MessageCurrentRevisionLink.id'),
          { revision_id: previousRevisionId }
        ),
        ...softDeleteEntrySteps(suffix, now),
        ...attachmentAdmission.storageSteps,
        ...preparedContentObjectSteps([content], 'edit_content'),
        DOMAIN_REPOSITORIES.domain('MessageRevision').insertWithNextSequence({
          id: revisionId,
          message_id: messageId,
          role: relation.currentRevision.role,
          content_object_id: content.metadata.id,
          created_at: now
        }, {
          column: 'revision_seq',
          scope: { message_id: messageId }
        }),
        ...(this.attachments ? this.attachments.linkSteps(attachmentAdmission, revisionId, now) : []),
        ...contextPlan.steps,
        DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').update(relation.currentLink.id as string, {
          revision_id: revisionId,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Message').update(messageId, { updated_at: now }),
        DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
      ]
    });
    if (commit.deduplicated) return this.replayEditResult(commit.receipt, receiptId, conversationId, messageId, revisionId);
    const sequence = allocatedValue(commit, 'MessageRevision', revisionId, 'revision_seq');
    return {
      receiptId: commit.receipt.id as string,
      deduplicated: false,
      commitSeq: commit.commitSeq,
      conversationId,
      messageId,
      messageRevisionId: revisionId,
      messageRevisionSeq: sequence
    };
  }

  private async editMessageAndRun(commandInput: TurnEditAndRunCommand): Promise<TurnCommandResult> {
    const command = normalizeExecutionCommand(commandInput, 'retry') as TurnEditAndRunCommand;
    const source = normalizeInitiatingSource(command.source, 'edit');
    const conversationId = requireId(command.conversationId, 'conversationId');
    const messageId = requireId(command.messageId, 'messageId');
    const expectedRevisionId = command.expectedRevisionId === undefined
      ? undefined
      : requireId(command.expectedRevisionId, 'expectedRevisionId');
    const commandScope = JSON.stringify([
      conversationId,
      messageId,
      expectedRevisionId ?? null,
      'edit-and-run',
      command.membership ?? null
    ]);
    const intentId = commandEntityId(source, 'edit', 'turn_intent', commandScope);
    const baseIds: StartCommandIds = {
      receipt: commandEntityId(source, 'edit', 'command_receipt', commandScope),
      intent: intentId,
      ...dependentStartCommandIds(intentId, false)
    };
    const ids = command.membership
      ? childExecutionStartIds(baseIds, command.membership.childExecutionId, false)
      : baseIds;
    const revisionId = commandEntityId(source, 'edit', 'message_revision', commandScope);
    const duplicate = await this.findReceipt(source);
    if (duplicate) {
      return this.replayEditAndRunResult(duplicate, ids, conversationId, messageId, revisionId);
    }

    await this.requireConversationIdle(conversationId);
    const relation = await this.getMessageRelation(conversationId, messageId);
    if (relation.message.deleted_at !== null) throw new Error(`Message ${messageId} is soft-deleted.`);
    if (expectedRevisionId && relation.currentRevision.id !== expectedRevisionId) {
      throw new Error(`Message ${messageId} revision changed before edit-and-run; refresh and retry.`);
    }
    if (relation.currentRevision.role !== 'user') throw new Error('Edit-and-run requires a user Message.');
    const sourceLinks = await this.listRows('MessageTurnLink', { message_id: messageId, role: 'input' }, 2);
    if (sourceLinks.length !== 1) throw new Error(`Message ${messageId} has no unique source Turn.`);
    const sourceTurnId = requireId(sourceLinks[0].turn_id, 'MessageTurnLink.turn_id');
    const sourceTurn = await this.getTurn(sourceTurnId);
    if (sourceTurn.conversation_id !== conversationId || sourceTurn.status !== TURN_STATUS_TERMINATED) {
      throw new Error(`Edit-and-run source Turn ${sourceTurnId} is not terminal in Conversation ${conversationId}.`);
    }

    const messageSnapshot = await this.conversationMessageSnapshot(conversationId);
    const sourceMessageSeq = requireBigInt(relation.membership.message_seq, 'MessagePartOfConversation.message_seq');
    const suffix = messageSnapshot.entries.filter((entry) => entry.messageSeq > sourceMessageSeq);
    const contentType = requireContentType(command.contentType ?? 'text/plain');
    const attachmentAdmission = await this.prepareMessageAttachments(command.content, contentType);
    const content = await this.contentStore.prepare(
      this.database,
      attachmentAdmission.value,
      attachmentAdmission.contentType
    );
    const previousRevisionId = requireId(relation.currentRevision.id, 'current MessageRevision.id');
    const contextPlan = await this.contextSequence.prepareMessageTruncateMutation({
      conversationId,
      messageRevisionId: previousRevisionId,
      idempotencyKey: intentId,
      replacement: {
        messageRevisionId: revisionId,
        contentObjectId: content.metadata.id,
        contentByteLength: content.metadata.byte_length,
        contentEstimatedTokens: estimateStoredMessageContentTokens(
          attachmentAdmission.value,
          attachmentAdmission.contentType
        )
      }
    });
    const compiled = await this.compileCurrentAuthority(
      conversationId,
      ids.turn,
      'retry',
      sourceTurnId,
      command.executorAgentId,
      command.modelOverride,
      command.membership
    );
    const intentContent = await this.contentStore.prepare(this.database, JSON.stringify({
      kind: 'retry',
      sourceTurnId,
      sourceMessageId: messageId,
      editedMessageRevisionId: revisionId
    }), TURN_INTENT_ENVELOPE_CONTENT_TYPE);
    const presetContent = await this.contentStore.prepare(
      this.database,
      compiled.executionPreset.content,
      compiled.executionPreset.contentType
    );
    const authorityContent = await this.contentStore.prepare(
      this.database,
      compiled.authoritySnapshot.content,
      compiled.authoritySnapshot.contentType
    );
    const now = this.timestamp();
    const childAdmission = command.membership
      ? await this.prepareChildAdmission({
          membership: command.membership,
          conversationId,
          intentId: ids.intent,
          turnId: ids.turn,
          expectedPreviousTurnId: sourceTurnId,
          now
        })
      : null;
    const nextDeliverySteps = this.prepareNextTurnDeliverySteps
      ? await this.prepareNextTurnDeliverySteps(conversationId, ids.turn, now)
      : [];
    const committed = await this.commitWithReceipt({
      source,
      receiptId: ids.receipt,
      conversationId,
      turnId: ids.turn,
      requiresConversationIdle: true,
      steps: [
        ...conversationIdleAssertionSteps(conversationId),
        DOMAIN_REPOSITORIES.domain('Turn').assert(sourceTurnId, {
          conversation_id: conversationId,
          status: TURN_STATUS_TERMINATED
        }),
        DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').assertExactIds(
          { conversation_id: conversationId },
          messageSnapshot.membershipIds
        ),
        DOMAIN_REPOSITORIES.domain('Message').assert(messageId, { deleted_at: null }),
        DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').assert(
          requireId(relation.currentLink.id, 'MessageCurrentRevisionLink.id'),
          { revision_id: previousRevisionId }
        ),
        ...softDeleteEntrySteps(suffix, now),
        ...attachmentAdmission.storageSteps,
        ...preparedContentObjectSteps([
          content,
          intentContent,
          presetContent,
          authorityContent
        ], 'edit_and_run_content'),
        DOMAIN_REPOSITORIES.domain('MessageRevision').insertWithNextSequence({
          id: revisionId,
          message_id: messageId,
          role: 'user',
          content_object_id: content.metadata.id,
          created_at: now
        }, { column: 'revision_seq', scope: { message_id: messageId } }),
        ...(this.attachments ? this.attachments.linkSteps(attachmentAdmission, revisionId, now) : []),
        ...contextPlan.steps,
        DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').update(
          requireId(relation.currentLink.id, 'MessageCurrentRevisionLink.id'),
          { revision_id: revisionId, updated_at: now }
        ),
        DOMAIN_REPOSITORIES.domain('Message').update(messageId, { updated_at: now }),
        DOMAIN_REPOSITORIES.domain('Turn').insert({
          id: ids.turn,
          conversation_id: conversationId,
          status: TURN_STATUS_ACTIVE,
          created_at: now,
          updated_at: now,
          terminal_at: null
        }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').insert({
          id: ids.lease,
          conversation_id: conversationId,
          turn_id: ids.turn,
          owner_id: command.leaseOwnerId,
          host_boot_id: command.hostBootId,
          generation: 1n,
          acquired_at: now,
          expires_at: command.leaseExpiresAt
        }),
        DOMAIN_REPOSITORIES.domain('TurnIntent').insert({
          id: ids.intent,
          conversation_id: conversationId,
          turn_id: ids.turn,
          state: TURN_INTENT_STATE_ADMITTED,
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('TurnIntentRevision').insert({
          id: ids.intentRevision,
          intent_id: ids.intent,
          revision_seq: '1',
          content_object_id: intentContent.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('TurnExecutionPresetRevision').insert({
          id: ids.presetRevision,
          intent_id: ids.intent,
          revision_seq: '1',
          preset_object_id: presetContent.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('TurnIntentAuthorityRevision').insert({
          id: ids.authorityRevision,
          intent_id: ids.intent,
          revision_seq: '1',
          authority_object_id: authorityContent.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('TurnIntentExecutorLink').insert({
          id: ids.intentExecutorLink,
          intent_id: ids.intent,
          agent_id: compiled.executorAgentId,
          created_at: now
        }),
        ...(childAdmission?.outerSteps ?? []),
        DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').insert({
          id: ids.authoritySnapshot,
          turn_id: ids.turn,
          content_object_id: authorityContent.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('TurnExecutorLink').insert({
          id: ids.executorLink,
          turn_id: ids.turn,
          agent_id: compiled.executorAgentId,
          created_at: now
        }),
        ...(childAdmission?.admissionSteps ?? []),
        ...nextDeliverySteps,
        DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
      ]
    });
    if (committed.deduplicated) {
      return this.replayEditAndRunResult(committed.receipt, ids, conversationId, messageId, revisionId);
    }
    return {
      receiptId: committed.receipt.id as string,
      deduplicated: false,
      commitSeq: committed.commitSeq,
      conversationId,
      intentId: ids.intent,
      admitted: true,
      turnId: ids.turn,
      messageId,
      messageRevisionId: revisionId,
      messageRevisionSeq: allocatedValue(committed, 'MessageRevision', revisionId, 'revision_seq')
    };
  }

  private async softDeleteMessage(commandInput: TurnDeleteCommand): Promise<TurnCommandResult> {
    const source = normalizeInitiatingSource(commandInput.source, 'delete');
    const conversationId = requireId(commandInput.conversationId, 'conversationId');
    const messageId = requireId(commandInput.messageId, 'messageId');
    const receiptId = commandEntityId(source, 'delete', 'command_receipt', JSON.stringify([conversationId, messageId]));
    const duplicate = await this.findReceipt(source);
    if (duplicate) {
      assertReceiptIdentity(duplicate, receiptId, 'delete');
      return basicDuplicateResult(duplicate, receiptId, 'delete', { conversationId, messageId });
    }
    await this.requireConversationIdle(conversationId);
    const relation = await this.getMessageRelation(conversationId, messageId);
    const now = this.timestamp();
    if (relation.message.deleted_at !== null) {
      const committed = await this.commitWithReceipt({ source, receiptId, conversationId, turnId: null, steps: [] });
      return committed.deduplicated
        ? basicDuplicateResult(committed.receipt, receiptId, 'delete', { conversationId, messageId })
        : basicCommittedResult(committed, { conversationId, messageId });
    }
    const messageSnapshot = await this.conversationMessageSnapshot(conversationId);
    const sourceMessageSeq = requireBigInt(relation.membership.message_seq, 'MessagePartOfConversation.message_seq');
    const targets = messageSnapshot.entries.filter((entry) => entry.messageSeq >= sourceMessageSeq);
    const contextPlan = await this.contextSequence.prepareMessageDeleteMutation({
      conversationId,
      messageRevisionId: requireId(relation.currentRevision.id, 'current MessageRevision.id'),
      idempotencyKey: source.key
    });
    const committed = await this.commitWithReceipt({
      source,
      receiptId,
      conversationId,
      turnId: null,
      requiresConversationIdle: true,
      steps: [
        ...conversationIdleAssertionSteps(conversationId),
        DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').assertExactIds(
          { conversation_id: conversationId },
          messageSnapshot.membershipIds
        ),
        DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').assert(
          requireId(relation.currentLink.id, 'MessageCurrentRevisionLink.id'),
          { revision_id: requireId(relation.currentRevision.id, 'current MessageRevision.id') }
        ),
        ...contextPlan.steps,
        ...softDeleteEntrySteps(targets, now),
        DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
      ]
    });
    return committed.deduplicated
      ? basicDuplicateResult(committed.receipt, receiptId, 'delete', { conversationId, messageId })
      : basicCommittedResult(committed, { conversationId, messageId });
  }

  private async requestInterrupt(commandInput: TurnInterruptCommand): Promise<TurnCommandResult> {
    const source = normalizeInitiatingSource(commandInput.source, 'interrupt');
    const turnId = requireId(commandInput.turnId, 'turnId');
    const reason = requireText(commandInput.reason, 'reason');
    const expectedLeaseGeneration = commandInput.expectedLeaseGeneration === undefined
      ? undefined
      : BigInt(requireDecimalIntegerString(
          commandInput.expectedLeaseGeneration,
          'expectedLeaseGeneration'
        ));
    if (expectedLeaseGeneration !== undefined && expectedLeaseGeneration <= 0n) {
      throw new TypeError('expectedLeaseGeneration must be positive.');
    }
    const pendingTurnInputId = turnInterruptInputId(turnId);
    const receiptId = commandEntityId(source, 'interrupt', 'command_receipt', turnId);
    const duplicate = await this.findReceipt(source);
    if (duplicate) return this.replayInterruptResult(duplicate, receiptId, turnId, pendingTurnInputId);
    const turn = await this.getTurn(turnId);
    const conversationId = turn.conversation_id as string;
    if (turn.status === TURN_STATUS_TERMINATED) {
      const committed = await this.commitWithReceipt({ source, receiptId, conversationId, turnId, steps: [] });
      return committed.deduplicated
        ? this.replayInterruptResult(committed.receipt, receiptId, turnId, pendingTurnInputId)
        : {
          receiptId: committed.receipt.id as string,
          deduplicated: false,
          commitSeq: committed.commitSeq,
          conversationId,
          turnId,
          ignoredBecauseTerminal: true
        };
    }
    requireActiveTurn(turn, turnId);
    const leaseFenceSteps: RepositoryTransactionStep[] = [];
    if (expectedLeaseGeneration !== undefined) {
      const leases = await this.listRows('ExecutionLease', { turn_id: turnId }, 2);
      if (
        leases.length !== 1
        || requireBigInt(leases[0].generation, 'ExecutionLease.generation') !== expectedLeaseGeneration
      ) {
        throw new Error('Turn interrupt target ExecutionLease generation was replaced.');
      }
      leaseFenceSteps.push(DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(
        requireId(leases[0].id, 'ExecutionLease.id'),
        { turn_id: turnId, generation: expectedLeaseGeneration }
      ));
    }
    const existingInterrupts = await this.listRows('PendingTurnInput', {
      turn_id: turnId,
      input_kind: 'interrupt_request',
      state: 'pending'
    }, 2);
    if (existingInterrupts.length > 1) {
      throw new Error(`Turn ${turnId} has multiple open interrupt requests.`);
    }
    if (existingInterrupts.length === 1) {
      return this.commitCoalescedInterrupt({
        source,
        receiptId,
        conversationId,
        turnId,
        pending: existingInterrupts[0],
        leaseFenceSteps
      });
    }
    const now = this.timestamp();
    const content = await this.contentStore.prepare(
      this.database,
      JSON.stringify({ kind: 'interrupt-request', reason }),
      CONTENT_TYPE_INTERRUPT
    );
    try {
      const committed = await this.commitWithReceipt({
        source,
        receiptId,
        conversationId,
        turnId,
        steps: [
          DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: TURN_STATUS_ACTIVE }),
          ...leaseFenceSteps,
          ...preparedContentObjectSteps([content], 'interrupt_content'),
          DOMAIN_REPOSITORIES.domain('PendingTurnInput').insertWithNextPosition({
            id: pendingTurnInputId,
            turn_id: turnId,
            input_kind: 'interrupt_request',
            content_object_id: content.metadata.id,
            state: 'pending',
            created_at: now,
            updated_at: now
          }),
          DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
        ]
      });
      if (committed.deduplicated) {
        return this.replayInterruptResult(committed.receipt, receiptId, turnId, pendingTurnInputId);
      }
      return {
        receiptId: committed.receipt.id as string,
        deduplicated: false,
        commitSeq: committed.commitSeq,
        conversationId,
        turnId,
        pendingTurnInputId,
        pendingTurnInputPosition: allocatedValue(
          committed,
          'PendingTurnInput',
          pendingTurnInputId,
          'position'
        )
      };
    } catch (error) {
      if (sqliteUniqueFailureIncludes(error, [
        'pending_turn_input.id',
        'pending_turn_input.turn_id, pending_turn_input.input_kind'
      ])) {
        const raced = await this.listRows('PendingTurnInput', {
          turn_id: turnId,
          input_kind: 'interrupt_request',
          state: 'pending'
        }, 2);
        if (raced.length === 1) {
          return this.commitCoalescedInterrupt({
            source,
            receiptId,
            conversationId,
            turnId,
            pending: raced[0],
            leaseFenceSteps
          });
        }
      }
      if (!isTransactionAssertionError(error)) throw error;
      const latest = await this.getTurn(turnId);
      if (latest.status !== TURN_STATUS_TERMINATED) throw error;
      const committed = await this.commitWithReceipt({ source, receiptId, conversationId, turnId, steps: [] });
      return committed.deduplicated
        ? this.replayInterruptResult(committed.receipt, receiptId, turnId, pendingTurnInputId)
        : {
          receiptId: committed.receipt.id as string,
          deduplicated: false,
          commitSeq: committed.commitSeq,
          conversationId,
          turnId,
          ignoredBecauseTerminal: true
        };
    }
  }

  private async commitCoalescedInterrupt(input: {
    source: TurnInitiatingSource;
    receiptId: string;
    conversationId: string;
    turnId: string;
    pending: DomainRow;
    leaseFenceSteps: RepositoryTransactionStep[];
  }): Promise<TurnCommandResult> {
    const committed = await this.commitWithReceipt({
      source: input.source,
      receiptId: input.receiptId,
      conversationId: input.conversationId,
      turnId: input.turnId,
      steps: input.leaseFenceSteps
    });
    return {
      receiptId: committed.receipt.id as string,
      deduplicated: committed.deduplicated,
      ...(committed.commitSeq ? { commitSeq: committed.commitSeq } : {}),
      conversationId: input.conversationId,
      turnId: input.turnId,
      pendingTurnInputId: requireId(input.pending.id, 'PendingTurnInput.id'),
      pendingTurnInputPosition: requireBigInt(
        input.pending.position,
        'PendingTurnInput.position'
      ).toString(),
      coalesced: true
    };
  }

  private async recordTerminal(commandInput: TurnTerminalCommand, attempt = 0): Promise<TurnCommandResult> {
    const source = normalizeTerminalSource(commandInput.source);
    const turnId = requireId(commandInput.turnId, 'turnId');
    const reason = requireText(commandInput.reason, 'reason');
    requireTerminalStatus(commandInput.terminalStatus);
    const terminationId = commandEntityId(source, 'terminal', 'turn_termination', turnId);
    const receiptId = commandEntityId(source, 'terminal', 'command_receipt', turnId);
    const duplicate = await this.findReceipt(source);
    if (duplicate) return this.replayTerminalResult(duplicate, receiptId, turnId, terminationId);
    const turn = await this.getTurn(turnId);
    const conversationId = turn.conversation_id as string;
    if (turn.status === TURN_STATUS_TERMINATED) {
      const committed = await this.commitWithReceipt({ source, receiptId, conversationId, turnId, steps: [] });
      return committed.deduplicated
        ? this.replayTerminalResult(committed.receipt, receiptId, turnId, terminationId)
        : {
          receiptId: committed.receipt.id as string,
          deduplicated: false,
          commitSeq: committed.commitSeq,
          conversationId,
          turnId,
          terminalRecorded: false,
          ignoredBecauseTerminal: true
        };
    }
    requireActiveTurn(turn, turnId);
    const handoffQueuedIntentId = commandInput.handoffQueuedIntentId
      ? requireId(commandInput.handoffQueuedIntentId, 'handoffQueuedIntentId')
      : undefined;
    const handoffQueuedIntentRevisionIds = commandInput.handoffQueuedIntentRevisionIds === undefined
      ? undefined
      : commandInput.handoffQueuedIntentRevisionIds.map((id) =>
          requireId(id, 'handoffQueuedIntentRevisionIds[]')
        );
    if (handoffQueuedIntentRevisionIds && !handoffQueuedIntentId) {
      throw new TypeError('handoffQueuedIntentRevisionIds requires handoffQueuedIntentId.');
    }
    if (
      handoffQueuedIntentRevisionIds
      && (
        handoffQueuedIntentRevisionIds.length === 0
        || new Set(handoffQueuedIntentRevisionIds).size !== handoffQueuedIntentRevisionIds.length
      )
    ) {
      throw new TypeError('handoffQueuedIntentRevisionIds must be a non-empty unique id set.');
    }
    const now = this.timestamp();
    const unresolvedFileSteps = this.unresolvedFileClosure
      ? await this.unresolvedFileClosure.prepareUnresolvedTurnClosure(turnId)
      : [];
    // The read builds the expected set; assertExactIds below is the writer-side authority. A
    // delivery/interrupt committed after this read makes the whole terminal transaction roll back.
    // queue_next_turn is intentionally absent: it is a legal post-terminal continuation handoff.
    const terminalInputSnapshot = (await listAllDomainRows(this.database, 'PendingTurnInput', {
      turn_id: turnId,
      state: 'pending'
    })).filter((input) => TERMINAL_BLOCKING_INPUT_KINDS.includes(
      String(input.input_kind) as typeof TERMINAL_BLOCKING_INPUT_KINDS[number]
    ));
    const terminalInputSteps = prepareTerminalInputFence(
      turnId,
      commandInput.terminalStatus,
      terminalInputSnapshot,
      now
    );
    const terminalDeliverySteps = this.prepareTerminalDeliverySteps
      ? await this.prepareTerminalDeliverySteps(turnId, now)
      : [];
    try {
      const committed = await this.commitWithReceipt({
        source,
        receiptId,
        conversationId,
        turnId,
        steps: [
          DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: TURN_STATUS_ACTIVE }),
          ...(handoffQueuedIntentId ? [
            DOMAIN_REPOSITORIES.domain('TurnIntent').assert(handoffQueuedIntentId, {
              conversation_id: conversationId,
              state: TURN_INTENT_STATE_QUEUED,
              turn_id: null
            }),
            DOMAIN_REPOSITORIES.domain('ChildExecutionIntentLink').assertNone({
              turn_intent_id: handoffQueuedIntentId
            }),
            ...(handoffQueuedIntentRevisionIds ? [
              DOMAIN_REPOSITORIES.domain('TurnIntentRevision').assertExactIds(
                { intent_id: handoffQueuedIntentId },
                handoffQueuedIntentRevisionIds
              )
            ] : [])
          ] : []),
          ...terminalInputSteps,
          // After the input fence, so a delivery injected meanwhile still reports that conflict.
          ...terminalDeliverySteps,
          ...unresolvedFileSteps,
          // A terminal Turn may not strand a pending or in-flight ToolCall. This assertion runs
          // after the pending-file closure steps in the same writer transaction.
          DOMAIN_REPOSITORIES.domain('ToolCall').assertAll({ turn_id: turnId }, { status: 'terminal' }),
          DOMAIN_REPOSITORIES.domain('ModelRequest').assertAll({ turn_id: turnId }, { status: 'terminal' }),
          DOMAIN_REPOSITORIES.domain('ExecutionLease').deleteByUnique({ conversation_id: conversationId, turn_id: turnId }),
          DOMAIN_REPOSITORIES.domain('TurnTermination').insert({
            id: terminationId,
            turn_id: turnId,
            terminal_status: commandInput.terminalStatus,
            reason,
            created_at: now
          }),
          DOMAIN_REPOSITORIES.domain('Turn').update(turnId, {
            status: TURN_STATUS_TERMINATED,
            updated_at: now,
            terminal_at: now
          }),
          DOMAIN_REPOSITORIES.domain('Conversation').update(conversationId, { updated_at: now })
        ]
      });
      return committed.deduplicated
        ? this.replayTerminalResult(committed.receipt, receiptId, turnId, terminationId)
        : {
          receiptId: committed.receipt.id as string,
          deduplicated: false,
          commitSeq: committed.commitSeq,
          conversationId,
          turnId,
          terminalRecorded: true
        };
    } catch (error) {
      if (!isTransactionAssertionError(error)) throw error;
      const latest = await this.getTurn(turnId);
      if (latest.status !== TURN_STATUS_TERMINATED) {
        // A collaboration message was routed into the Turn after the terminal read: read again.
        if (isTerminalDeliveryFenceAssertion(error) && attempt < 3) return this.recordTerminal(commandInput, attempt + 1);
        if (handoffQueuedIntentId) {
          const [handoffIntent, childLinks, handoffRevisions] = await Promise.all([
            this.maybeGet('TurnIntent', handoffQueuedIntentId),
            this.listRows('ChildExecutionIntentLink', { turn_intent_id: handoffQueuedIntentId }, 1),
            listAllDomainRows(this.database, 'TurnIntentRevision', { intent_id: handoffQueuedIntentId })
          ]);
          const handoffRevisionChanged = Boolean(handoffQueuedIntentRevisionIds)
            && !sameIdSet(
              handoffQueuedIntentRevisionIds!,
              handoffRevisions.map((revision) => requireId(revision.id, 'TurnIntentRevision.id'))
            );
          if (
            !handoffIntent
            || handoffIntent.conversation_id !== conversationId
            || handoffIntent.state !== TURN_INTENT_STATE_QUEUED
            || handoffIntent.turn_id !== null
            || childLinks.length > 0
            || handoffRevisionChanged
          ) {
            throw new TurnTerminalGuidanceConflictError(turnId, handoffQueuedIntentId);
          }
        }
        if (isTerminalInputFenceAssertion(error)) {
          const blockingInputs = await terminalBlockingInputs(this.database, turnId);
          if (blockingInputs.length > 0) {
            throw new TurnTerminalInputConflictError(
              turnId,
              blockingInputs.map((input) => requireId(input.id, 'PendingTurnInput.id')),
              blockingInputs.map((input) => requireText(input.input_kind, 'PendingTurnInput.input_kind'))
            );
          }
        }
        throw error;
      }
      const committed = await this.commitWithReceipt({ source, receiptId, conversationId, turnId, steps: [] });
      return committed.deduplicated
        ? this.replayTerminalResult(committed.receipt, receiptId, turnId, terminationId)
        : {
          receiptId: committed.receipt.id as string,
          deduplicated: false,
          commitSeq: committed.commitSeq,
          conversationId,
          turnId,
          terminalRecorded: false,
          ignoredBecauseTerminal: true
        };
    }
  }

  private async commitWithReceipt(options: TurnCommandCommitOptions): Promise<CommandCommit> {
    const existing = await this.findReceipt(options.source);
    if (existing) return deduplicatedCommit(existing);
    const receipt = {
      id: options.receiptId,
      source_kind: options.source.kind,
      source_key: options.source.key,
      conversation_id: requireId(options.conversationId, 'receipt conversationId'),
      turn_id: options.turnId === null ? null : requireId(options.turnId, 'receipt turnId'),
      created_at: this.timestamp()
    };
    try {
      const committed = await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('CommandReceipt').insert(receipt),
        ...options.steps
      ]);
      return {
        receipt,
        deduplicated: false,
        commitSeq: requireDecimalIntegerString(committed.commitSeq, 'commitSeq'),
        changes: committed.changes,
        allocatedSequences: committed.allocatedSequences.map((entry) => ({
          ...entry,
          value: requireDecimalIntegerString(entry.value, `${entry.domain}.${entry.column}`)
        }))
      };
    } catch (error) {
      const racedReceipt = await this.findReceipt(options.source);
      if (racedReceipt) return deduplicatedCommit(racedReceipt);
      if (
        options.requiresConversationIdle
        && isTransactionAssertionError(error)
        && await this.conversationHasPendingWork(options.conversationId)
      ) {
        throw new ConversationHistoryBusyError(options.conversationId);
      }
      throw error;
    }
  }

  private async replayStartResult(
    receipt: DomainRow,
    ids: StartCommandIds,
    operation: StartIntentPlan['operation'],
    conversationId: string,
    runtimeDeliveryId?: string
  ): Promise<TurnCommandResult> {
    assertReceiptIdentity(receipt, ids.receipt, operation);
    if (receipt.conversation_id !== conversationId) throw sourceOperationMismatch(receipt, operation);
    const intent = await this.maybeGet('TurnIntent', ids.intent);
    if (!intent) throw sourceOperationMismatch(receipt, operation);
    if (operation === 'runtime_continuation') {
      const linkId = requireId(ids.runtimeDeliveryIntentLink, 'RuntimeDeliveryIntentLink.id');
      const deliveryId = requireId(runtimeDeliveryId, 'runtimeDeliveryId');
      const link = await this.maybeGet('RuntimeDeliveryIntentLink', linkId);
      if (!link || link.delivery_id !== deliveryId || link.turn_intent_id !== ids.intent) {
        throw sourceOperationMismatch(receipt, operation);
      }
    }
    const admitted = intent.state === TURN_INTENT_STATE_ADMITTED && typeof intent.turn_id === 'string';
    if (admitted && intent.turn_id !== ids.turn) {
      throw new Error(`TurnIntent ${ids.intent} is linked to an unexpected Turn.`);
    }
    if (admitted) {
      await this.requireExisting('Turn', ids.turn);
      if (ids.message) await this.requireExisting('Message', ids.message);
    }
    return {
      receiptId: receipt.id as string,
      deduplicated: true,
      conversationId,
      intentId: ids.intent,
      admitted,
      ...(admitted ? {
        turnId: ids.turn,
        ...(ids.message ? { messageId: ids.message, messageRevisionId: ids.messageRevision } : {})
      } : {})
    };
  }

  private async readStartResult(
    commit: CommandCommit,
    ids: StartCommandIds,
    conversationId: string
  ): Promise<TurnCommandResult> {
    const admitted = commit.changes.some((change) =>
      change.domain === 'Turn' && change.id === ids.turn && change.kind === 'upsert'
    );
    return {
      receiptId: commit.receipt.id as string,
      deduplicated: false,
      commitSeq: commit.commitSeq,
      conversationId,
      intentId: ids.intent,
      admitted,
      ...(admitted ? {
        turnId: ids.turn,
        ...(ids.message ? { messageId: ids.message, messageRevisionId: ids.messageRevision } : {})
      } : {})
    };
  }

  private async replayEditResult(
    receipt: DomainRow,
    expectedReceiptId: string,
    conversationId: string,
    messageId: string,
    revisionId: string
  ): Promise<TurnCommandResult> {
    assertReceiptIdentity(receipt, expectedReceiptId, 'edit');
    if (receipt.conversation_id !== conversationId) throw sourceOperationMismatch(receipt, 'edit');
    const revision = await this.maybeGet('MessageRevision', revisionId);
    if (!revision || revision.message_id !== messageId) throw sourceOperationMismatch(receipt, 'edit');
    return {
      receiptId: receipt.id as string,
      deduplicated: true,
      conversationId,
      messageId,
      messageRevisionId: revisionId,
      messageRevisionSeq: requireBigInt(revision.revision_seq, 'MessageRevision.revision_seq').toString()
    };
  }

  private async replayEditAndRunResult(
    receipt: DomainRow,
    ids: StartCommandIds,
    conversationId: string,
    messageId: string,
    revisionId: string
  ): Promise<TurnCommandResult> {
    assertReceiptIdentity(receipt, ids.receipt, 'edit');
    if (receipt.conversation_id !== conversationId || receipt.turn_id !== ids.turn) {
      throw sourceOperationMismatch(receipt, 'edit');
    }
    const [revision, intent, turn] = await Promise.all([
      this.maybeGet('MessageRevision', revisionId),
      this.maybeGet('TurnIntent', ids.intent),
      this.maybeGet('Turn', ids.turn)
    ]);
    if (
      !revision
      || revision.message_id !== messageId
      || !intent
      || intent.turn_id !== ids.turn
      || intent.state !== TURN_INTENT_STATE_ADMITTED
      || !turn
      || turn.conversation_id !== conversationId
    ) throw sourceOperationMismatch(receipt, 'edit');
    return {
      receiptId: receipt.id as string,
      deduplicated: true,
      conversationId,
      intentId: ids.intent,
      admitted: true,
      turnId: ids.turn,
      messageId,
      messageRevisionId: revisionId,
      messageRevisionSeq: requireBigInt(revision.revision_seq, 'MessageRevision.revision_seq').toString()
    };
  }

  private async replayInterruptResult(
    receipt: DomainRow,
    expectedReceiptId: string,
    turnId: string,
    pendingTurnInputId: string
  ): Promise<TurnCommandResult> {
    assertReceiptIdentity(receipt, expectedReceiptId, 'interrupt');
    if (receipt.turn_id !== turnId) throw sourceOperationMismatch(receipt, 'interrupt');
    const turn = await this.getTurn(turnId);
    const pending = await this.maybeGet('PendingTurnInput', pendingTurnInputId);
    if (pending?.state === 'pending') {
      return {
        receiptId: receipt.id as string,
        deduplicated: true,
        conversationId: turn.conversation_id as string,
        turnId,
        pendingTurnInputId,
        pendingTurnInputPosition: requireBigInt(pending.position, 'PendingTurnInput.position').toString()
      };
    }
    // Terminalization consumes the interrupt input and terminates the Turn in one transaction.
    // A replay must reflect that durable terminal fact instead of treating the retained consumed
    // input as another accepted stop request.
    if (turn.status !== TURN_STATUS_TERMINATED) throw sourceOperationMismatch(receipt, 'interrupt');
    return {
      receiptId: receipt.id as string,
      deduplicated: true,
      conversationId: turn.conversation_id as string,
      turnId,
      ignoredBecauseTerminal: true
    };
  }

  private async replayTerminalResult(
    receipt: DomainRow,
    expectedReceiptId: string,
    turnId: string,
    terminationId: string
  ): Promise<TurnCommandResult> {
    assertReceiptIdentity(receipt, expectedReceiptId, 'terminal');
    if (receipt.turn_id !== turnId) throw sourceOperationMismatch(receipt, 'terminal');
    const turn = await this.getTurn(turnId);
    const termination = await this.maybeGet('TurnTermination', terminationId);
    if (turn.status !== TURN_STATUS_TERMINATED) throw sourceOperationMismatch(receipt, 'terminal');
    return {
      receiptId: receipt.id as string,
      deduplicated: true,
      conversationId: turn.conversation_id as string,
      turnId,
      terminalRecorded: termination !== null,
      ...(termination ? {} : { ignoredBecauseTerminal: true })
    };
  }

  private async findReceipt(source: TurnCommandSource): Promise<DomainRow | undefined> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('CommandReceipt').list({
        where: { source_kind: source.kind, source_key: source.key },
        limit: 1
      })
    ]);
    return rows(snapshot.snapshot[0])[0];
  }

  private async getConversation(conversationId: string): Promise<DomainRow> {
    return this.requireExisting('Conversation', requireId(conversationId, 'conversationId'));
  }

  private async getTurn(turnId: string): Promise<DomainRow> {
    return this.requireExisting('Turn', requireId(turnId, 'turnId'));
  }

  private async getMessage(messageId: string): Promise<DomainRow> {
    return this.requireExisting('Message', requireId(messageId, 'messageId'));
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

  private async getDefaultAgent(conversationId: string): Promise<DomainRow> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('AgentConversationLink').list({
        where: {
          conversation_id: requireId(conversationId, 'conversationId'),
          role: DEFAULT_AGENT_CONVERSATION_ROLE
        },
        limit: 2
      })
    ]);
    const links = rows(snapshot.snapshot[0]);
    if (links.length !== 1) {
      throw new Error(`Conversation ${conversationId} must have exactly one current default Agent link.`);
    }
    requireId(links[0].agent_id, 'AgentConversationLink.agent_id');
    return links[0];
  }

  private async requireConversationIdle(conversationIdInput: string): Promise<void> {
    const conversationId = requireId(conversationIdInput, 'conversationId');
    if (await this.conversationHasPendingWork(conversationId)) {
      throw new ConversationHistoryBusyError(conversationId);
    }
  }

  private async conversationHasPendingWork(conversationIdInput: string): Promise<boolean> {
    const conversationId = requireId(conversationIdInput, 'conversationId');
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ExecutionLease').list({ where: { conversation_id: conversationId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('Turn').list({
        where: { conversation_id: conversationId, status: TURN_STATUS_ACTIVE },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('TurnIntent').list({
        where: { conversation_id: conversationId, state: TURN_INTENT_STATE_QUEUED, turn_id: null },
        limit: 1
      })
    ]);
    return (
      rows(snapshot.snapshot[0]).length > 0
      || rows(snapshot.snapshot[1]).length > 0
      || rows(snapshot.snapshot[2]).length > 0
    );
  }

  private async conversationMessageSnapshot(conversationIdInput: string): Promise<ConversationMessageSnapshot> {
    const conversationId = requireId(conversationIdInput, 'conversationId');
    const memberships = await listAllDomainRows(
      this.database,
      'MessagePartOfConversation',
      { conversation_id: conversationId }
    );
    const ordered = [...memberships].sort((left, right) => {
      const leftSeq = requireBigInt(left.message_seq, 'MessagePartOfConversation.message_seq');
      const rightSeq = requireBigInt(right.message_seq, 'MessagePartOfConversation.message_seq');
      return leftSeq < rightSeq ? -1 : leftSeq > rightSeq ? 1 : 0;
    });
    if (ordered.length === 0) return { entries: [], membershipIds: [] };
    const messageSnapshot = await this.database.snapshot(ordered.map((membership) =>
      DOMAIN_REPOSITORIES.domain('Message').get(requireId(membership.message_id, 'MessagePartOfConversation.message_id'))
    ));
    return {
      entries: ordered.map((membership, index) => {
        const messageId = requireId(membership.message_id, 'MessagePartOfConversation.message_id');
        const message = requireRow(messageSnapshot.snapshot[index], `Message ${messageId}`);
        if (message.id !== messageId) throw new Error(`Message membership ${String(membership.id)} resolved incorrectly.`);
        return {
          membership,
          message,
          messageSeq: requireBigInt(membership.message_seq, 'MessagePartOfConversation.message_seq')
        };
      }),
      membershipIds: ordered.map((membership) => requireId(membership.id, 'MessagePartOfConversation.id'))
    };
  }

  private async getMessageRelation(conversationId: string, messageId: string): Promise<{
    message: DomainRow;
    membership: DomainRow;
    currentLink: DomainRow;
    currentRevision: DomainRow;
  }> {
    const first = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Message').get(messageId),
      DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({ where: { message_id: messageId }, limit: 1 }),
      DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').list({ where: { message_id: messageId }, limit: 1 })
    ]);
    const message = requireRow(first.snapshot[0], `Message ${messageId}`);
    const membership = rows(first.snapshot[1])[0];
    if (!membership || membership.conversation_id !== conversationId) {
      throw new Error(`Message ${messageId} does not belong to Conversation ${conversationId}.`);
    }
    const currentLink = rows(first.snapshot[2])[0];
    if (!currentLink) throw new Error(`Message ${messageId} has no current revision link.`);
    const revisionId = requireId(currentLink.revision_id, 'MessageCurrentRevisionLink.revision_id');
    const currentRevision = await this.requireExisting('MessageRevision', revisionId);
    if (currentRevision.message_id !== messageId) {
      throw new Error(`Message ${messageId} current revision belongs to another Message.`);
    }
    return { message, membership, currentLink, currentRevision };
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

function startCommandIds(
  source: TurnInitiatingSource,
  operation: StartIntentPlan['operation'],
  hasMessage: boolean,
  commandScope: string
): StartCommandIds {
  const receipt = commandEntityId(source, operation, 'command_receipt', commandScope);
  const intent = commandEntityId(source, operation, 'turn_intent', commandScope);
  return { receipt, intent, ...dependentStartCommandIds(intent, hasMessage) };
}

function dependentStartCommandIds(intentId: string, hasMessage: boolean): Omit<StartCommandIds, 'receipt' | 'intent'> {
  const id = (kind: string) => intentDependentEntityId(intentId, kind);
  return {
    intentRevision: id('turn_intent_revision'),
    presetRevision: id('turn_preset_revision'),
    authorityRevision: id('turn_intent_authority_revision'),
    intentExecutorLink: id('turn_intent_executor_link'),
    turn: id('turn'),
    lease: id('execution_lease'),
    authoritySnapshot: id('authority_snapshot'),
    executorLink: id('turn_executor_link'),
    ...(hasMessage ? {
      message: id('message'),
      messageRevision: id('message_revision'),
      currentRevisionLink: id('message_current_revision_link'),
      membership: id('message_conversation_link'),
      messageTurnLink: id('message_turn_link')
    } : {})
  };
}

function childExecutionStartIds(
  ids: StartCommandIds,
  childExecutionIdInput: string,
  hasMessage: boolean
): StartCommandIds {
  const childExecutionId = requireId(childExecutionIdInput, 'membership.childExecutionId');
  const scope = [childExecutionId, ids.intent];
  return {
    ...ids,
    turn: stablePhaseFId('turn', 'child-continuation', ...scope),
    lease: stablePhaseFId('execution_lease', 'child-continuation', ...scope),
    authoritySnapshot: stablePhaseFId('authority_snapshot', 'child-continuation', ...scope),
    executorLink: stablePhaseFId('turn_executor_link', 'child-continuation', ...scope),
    ...(hasMessage ? {
      message: stablePhaseFId('message', 'child-continuation', ...scope),
      messageRevision: stablePhaseFId('message_revision', 'child-continuation', ...scope),
      currentRevisionLink: stablePhaseFId('message_current_revision_link', 'child-continuation', ...scope),
      membership: stablePhaseFId('message_conversation_link', 'child-continuation', ...scope),
      messageTurnLink: stablePhaseFId('message_turn_link', 'child-continuation', ...scope)
    } : {})
  };
}

function childIntentLinkId(childExecutionId: string, intentId: string): string {
  return stablePhaseFId('child_execution_intent_link', 'ui-command', childExecutionId, intentId);
}

function childTurnLinkId(childExecutionId: string, intentId: string): string {
  return stablePhaseFId('child_execution_turn_link', 'child-continuation', childExecutionId, intentId);
}

function intentDependentEntityId(intentId: string, kind: string): string {
  const normalizedKind = requireText(kind, 'intent dependent kind').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const digest = createHash('sha256')
    .update('limcode-turn-intent-dependent\0')
    .update(requireId(intentId, 'intentId'))
    .update('\0')
    .update(normalizedKind)
    .digest('hex');
  return `${normalizedKind}_${digest}`;
}

function messageAdmissionSteps(
  ids: StartCommandIds,
  messageContent: PreparedContentObject,
  conversationId: string,
  now: string
): RepositoryTransactionStep[] {
  const message = requireId(ids.message, 'message id');
  const revision = requireId(ids.messageRevision, 'message revision id');
  return [
    DOMAIN_REPOSITORIES.domain('Message').insert({ id: message, created_at: now, updated_at: now, deleted_at: null }),
    DOMAIN_REPOSITORIES.domain('MessageRevision').insertWithNextSequence({
      id: revision,
      message_id: message,
      role: 'user',
      content_object_id: messageContent.metadata.id,
      created_at: now
    }, {
      column: 'revision_seq',
      scope: { message_id: message }
    }),
    DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
      id: requireId(ids.currentRevisionLink, 'current revision link id'),
      message_id: message,
      revision_id: revision,
      updated_at: now
    }),
    DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insertWithNextSequence({
      id: requireId(ids.membership, 'message membership id'),
      conversation_id: conversationId,
      message_id: message,
      created_at: now
    }, {
      column: 'message_seq',
      scope: { conversation_id: conversationId }
    }),
    DOMAIN_REPOSITORIES.domain('MessageTurnLink').insert({
      id: requireId(ids.messageTurnLink, 'message Turn link id'),
      turn_id: ids.turn,
      message_id: message,
      role: 'input',
      created_at: now
    })
  ];
}

function conversationIdleAssertionSteps(conversationIdInput: string): RepositoryTransactionStep[] {
  const conversationId = requireId(conversationIdInput, 'conversationId');
  return [
    DOMAIN_REPOSITORIES.domain('ExecutionLease').assertNone({ conversation_id: conversationId }),
    DOMAIN_REPOSITORIES.domain('Turn').assertNone({
      conversation_id: conversationId,
      status: TURN_STATUS_ACTIVE
    }),
    DOMAIN_REPOSITORIES.domain('TurnIntent').assertNone({
      conversation_id: conversationId,
      state: TURN_INTENT_STATE_QUEUED,
      turn_id: null
    })
  ];
}

function softDeleteEntrySteps(
  entries: readonly ConversationMessageEntry[],
  deletedAtInput: string
): RepositoryTransactionStep[] {
  const deletedAt = requireText(deletedAtInput, 'deletedAt');
  return entries.flatMap((entry) => {
    const messageId = requireId(entry.message.id, 'Message.id');
    if (entry.message.deleted_at !== null) {
      return [DOMAIN_REPOSITORIES.domain('Message').assert(messageId, {
        deleted_at: requireText(entry.message.deleted_at, 'Message.deleted_at')
      })];
    }
    return [
      DOMAIN_REPOSITORIES.domain('Message').assert(messageId, { deleted_at: null }),
      DOMAIN_REPOSITORIES.domain('Message').update(messageId, {
        deleted_at: deletedAt,
        updated_at: deletedAt
      })
    ];
  });
}

function normalizeExecutionCommand(
  command: TurnExecutionCommand,
  operation: StartIntentPlan['operation']
): TurnExecutionCommand {
  return {
    ...command,
    source: normalizeInitiatingSource(command.source, operation),
    conversationId: requireId(command.conversationId, 'conversationId'),
    leaseOwnerId: requireId(command.leaseOwnerId, 'leaseOwnerId'),
    hostBootId: requireId(command.hostBootId, 'hostBootId'),
    leaseExpiresAt: requireText(command.leaseExpiresAt, 'leaseExpiresAt'),
    ...(command.executorAgentId
      ? { executorAgentId: requireId(command.executorAgentId, 'executorAgentId') }
      : {}),
    ...(command.modelOverride ? { modelOverride: normalizeTurnModelOverride(command.modelOverride) } : {}),
    ...(command.membership ? { membership: normalizeTurnExecutionMembership(command.membership) } : {})
  };
}

function normalizeTurnExecutionMembership(input: TurnExecutionMembership): TurnExecutionMembership {
  if (!input || input.kind !== 'child_execution') {
    throw new TypeError('Turn execution membership must identify a ChildExecution.');
  }
  return {
    kind: 'child_execution',
    childExecutionId: requireId(input.childExecutionId, 'membership.childExecutionId')
  };
}

export function normalizeTurnModelOverride(input: TurnModelOverride): TurnModelOverride {
  if (!input || typeof input !== 'object') throw new TypeError('modelOverride must be an object.');
  return {
    ...(input.providerConfigId?.trim()
      ? { providerConfigId: requireId(input.providerConfigId, 'modelOverride.providerConfigId') }
      : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    model: requireText(input.model, 'modelOverride.model')
  };
}

function normalizeRetryTarget(input: MessageRetryTarget): MessageRetryTarget {
  if (!input || typeof input !== 'object') throw new TypeError('RetryTarget must be an object.');
  if (input.kind === 'message') {
    return { kind: 'message', messageId: requireId(input.messageId, 'RetryTarget.messageId') };
  }
  if (input.kind === 'model_request') {
    return {
      kind: 'model_request',
      modelRequestId: requireId(input.modelRequestId, 'RetryTarget.modelRequestId')
    };
  }
  throw new TypeError('RetryTarget kind must be message or model_request.');
}

function requireRetryTarget(input: MessageRetryTarget | undefined): MessageRetryTarget {
  if (!input) throw new TypeError('retry requires an exact RetryTarget.');
  return input;
}

function withRetryLineage(
  compiled: ReturnType<typeof normalizeCompiledTurnAuthority>,
  lineage: RetryLineage
): ReturnType<typeof normalizeCompiledTurnAuthority> {
  const retryLineage = {
    sourceTurnId: lineage.sourceTurnId,
    ...(lineage.sourceMessageId ? { sourceMessageId: lineage.sourceMessageId } : {}),
    ...(lineage.sourceMessageRevisionId
      ? { sourceMessageRevisionId: lineage.sourceMessageRevisionId }
      : {}),
    ...(lineage.sourceModelRequestId ? { sourceModelRequestId: lineage.sourceModelRequestId } : {}),
    ...(lineage.inheritedPlanApprovalToolCallId
      ? { inheritedPlanApprovalToolCallId: lineage.inheritedPlanApprovalToolCallId }
      : {})
  };
  const preset = compiledJsonObject(compiled.executionPreset.content, 'execution preset');
  const authority = compiledJsonObject(compiled.authoritySnapshot.content, 'authority snapshot');
  return {
    ...compiled,
    executionPreset: {
      ...compiled.executionPreset,
      content: canonicalPlainJson({ ...preset, retryLineage }, 'Retry execution preset')
    },
    authoritySnapshot: {
      ...compiled.authoritySnapshot,
      content: canonicalPlainJson({ ...authority, retryLineage }, 'Retry authority snapshot')
    }
  };
}

function compiledJsonObject(content: TurnCommandContent, label: string): Record<string, unknown> {
  const raw = typeof content === 'string' ? content : Buffer.from(content).toString('utf8');
  const normalized = normalizePlainJson(JSON.parse(raw), label);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  return normalized;
}

function normalizeRuntimeMaintenance(
  input: TurnRuntimeMaintenanceDescriptor
): TurnRuntimeMaintenanceDescriptor {
  if (!input || typeof input !== 'object') {
    throw new TypeError('runtime maintenance descriptor must be an object.');
  }
  if (input.kind !== 'manual_context_compression' || (input.version !== 1 && input.version !== 2)) {
    throw new TypeError('Unsupported runtime maintenance descriptor.');
  }
  if (!Number.isSafeInteger(input.compressSegmentCount) || input.compressSegmentCount <= 0) {
    throw new TypeError('runtime maintenance compressSegmentCount must be a positive safe integer.');
  }
  const commandSourceKey = requireText(input.commandSourceKey, 'runtime maintenance commandSourceKey');
  const sourceReplay = (input as { sourceReplay?: unknown }).sourceReplay;
  if (sourceReplay !== undefined && sourceReplay !== 'immutable_provenance') {
    throw new TypeError('runtime maintenance sourceReplay is invalid.');
  }
  if (sourceReplay && (input.version !== 2 || input.target?.kind !== 'current_head')) {
    throw new TypeError('Immutable provenance rebuild requires the complete frozen current context.');
  }
  if (input.version === 1) {
    return {
      kind: 'manual_context_compression',
      version: 1,
      compressSegmentCount: input.compressSegmentCount,
      commandSourceKey
    };
  }
  return {
    kind: 'manual_context_compression',
    version: 2,
    compressSegmentCount: input.compressSegmentCount,
    target: normalizeCompressionTarget(input.target),
    ...(sourceReplay ? { sourceReplay } : {}),
    commandSourceKey
  };
}

function normalizeCompressionTarget(input: CompressionCommandTarget): CompressionCommandTarget {
  if (!input || typeof input !== 'object') {
    throw new TypeError('runtime maintenance target must be an object.');
  }
  if (input.kind === 'current_head') {
    return {
      kind: 'current_head',
      expectedRootId: requireId(input.expectedRootId, 'runtime maintenance target.expectedRootId')
    };
  }
  if (input.kind === 'through_message') {
    return {
      kind: 'through_message',
      messageId: requireId(input.messageId, 'runtime maintenance target.messageId'),
      expectedRevisionId: requireId(
        input.expectedRevisionId,
        'runtime maintenance target.expectedRevisionId'
      )
    };
  }
  throw new TypeError('Unsupported runtime maintenance target.');
}

export function normalizeCompiledTurnAuthority(
  compiled: CompiledTurnAuthority,
  expectedTurnId: string,
  expectedExecutorAgentId: string
): Required<Pick<CompiledTurnAuthority, 'turnId' | 'executorAgentId'>> & {
  executionPreset: Required<CompiledTurnAuthorityContent>;
  authoritySnapshot: Required<CompiledTurnAuthorityContent>;
} {
  if (!compiled || typeof compiled !== 'object') throw new TypeError('TurnAuthorityCompiler returned no authority.');
  if (compiled.turnId !== expectedTurnId) throw new Error('Compiled authority is bound to another Turn.');
  if (compiled.executorAgentId !== expectedExecutorAgentId) throw new Error('Compiled authority is bound to another executor Agent.');
  return {
    turnId: compiled.turnId,
    executorAgentId: compiled.executorAgentId,
    executionPreset: normalizeCompiledContent(compiled.executionPreset, CONTENT_TYPE_PRESET, 'execution preset'),
    authoritySnapshot: normalizeCompiledContent(compiled.authoritySnapshot, CONTENT_TYPE_AUTHORITY, 'authority snapshot')
  };
}

function normalizeCompiledContent(
  content: CompiledTurnAuthorityContent,
  defaultContentType: string,
  label: string
): Required<CompiledTurnAuthorityContent> {
  if (!content || (typeof content.content !== 'string' && !(content.content instanceof Uint8Array))) {
    throw new TypeError(`Compiled ${label} content is invalid.`);
  }
  if (typeof content.content === 'string' && content.content.length === 0) {
    throw new TypeError(`Compiled ${label} content cannot be empty.`);
  }
  if (content.content instanceof Uint8Array && content.content.byteLength === 0) {
    throw new TypeError(`Compiled ${label} content cannot be empty.`);
  }
  return {
    content: content.content,
    contentType: requireContentType(content.contentType ?? defaultContentType)
  };
}

function turnInterruptInputId(turnId: string): string {
  const digest = createHash('sha256')
    .update('limcode-turn-open-interrupt\0')
    .update(turnId)
    .digest('hex');
  return `pending_turn_input_${digest}`;
}

function recoveryExecutionEntityId(
  entityKind: 'command_receipt' | 'execution_lease',
  hostBootId: string,
  turnId: string,
  claimGeneration?: string
): string {
  const digest = createHash('sha256')
    .update('limcode-turn-recovery-execution\0')
    .update(JSON.stringify(claimGeneration === undefined
      ? [hostBootId, turnId, entityKind]
      : [hostBootId, turnId, entityKind, claimGeneration]))
    .digest('hex');
  return `${entityKind}_${digest}`;
}

function deduplicatedCommit(receipt: DomainRow): CommandCommit {
  return { receipt, deduplicated: true, changes: [], allocatedSequences: [] };
}

function basicDuplicateResult(
  receipt: DomainRow,
  expectedReceiptId: string,
  operation: TurnCommandOperation,
  fields: Pick<TurnCommandResult, 'conversationId' | 'messageId'>
): TurnCommandResult {
  assertReceiptIdentity(receipt, expectedReceiptId, operation);
  if (receipt.conversation_id !== fields.conversationId) throw sourceOperationMismatch(receipt, operation);
  return { receiptId: receipt.id as string, deduplicated: true, ...fields };
}

function basicCommittedResult(
  commit: CommandCommit,
  fields: Pick<TurnCommandResult, 'conversationId' | 'messageId'>
): TurnCommandResult {
  return {
    receiptId: commit.receipt.id as string,
    deduplicated: false,
    commitSeq: commit.commitSeq,
    ...fields
  };
}

function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return expected.size === left.length && right.every((id) => expected.has(id));
}

function rows(value: DomainRow | DomainRow[] | null): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError('Repository list read did not return rows.');
  return value;
}

function requireRow(value: DomainRow | DomainRow[] | null, label: string): DomainRow {
  if (!value || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value;
}

function requirePrepared(prepared: PreparedContentObject | undefined, label: string): PreparedContentObject {
  if (!prepared) throw new Error(`${label} was not prepared.`);
  return prepared;
}

function requireActiveTurn(turn: DomainRow, turnId: string): void {
  const status = requireText(turn.status, `Turn ${turnId}.status`);
  if (status !== TURN_STATUS_ACTIVE) throw new Error(`Turn ${turnId} is not active.`);
}

function requireTerminalStatus(value: string): asserts value is TurnTerminalStatus {
  if (!['completed', 'failed', 'interrupted', 'cancelled', 'outcome_unknown'].includes(value)) {
    throw new TypeError(`Unsupported Turn terminal status: ${value}`);
  }
}

function isTerminalInputFenceAssertion(error: unknown): boolean {
  return error instanceof Error
    && error.message === 'PendingTurnInputRepository transaction assertExactIds failed.';
}

function isTerminalDeliveryFenceAssertion(error: unknown): boolean {
  return error instanceof Error
    && error.message === 'RuntimeDeliveryRepository transaction assertExactIds failed.';
}

function prepareTerminalInputFence(
  turnId: string,
  terminalStatus: TurnTerminalStatus,
  snapshot: readonly DomainRow[],
  now: string
): RepositoryTransactionStep[] {
  const inputs = DOMAIN_REPOSITORIES.domain('PendingTurnInput');
  const steps: RepositoryTransactionStep[] = [
    // Runtime context must always be appended and ACKed by the executor before any terminal fact.
    inputs.assertExactIds({ turn_id: turnId, state: 'pending', input_kind: 'runtime_delivery' }, [])
  ];
  for (const inputKind of TURN_TERMINATION_INPUT_KINDS) {
    const observed = terminalStatus === 'interrupted'
      ? snapshot.filter((input) => input.input_kind === inputKind)
      : [];
    steps.push(inputs.assertExactIds(
      { turn_id: turnId, state: 'pending', input_kind: inputKind },
      observed.map((input) => requireId(input.id, 'PendingTurnInput.id'))
    ));
    // interrupt_current_turn is also the durable lineage token consumed by
    // ChildExecution.admitQueuedIntent. Keep it pending until that atomic handoff deletes it.
    if (inputKind === 'interrupt_current_turn') continue;
    for (const input of observed) {
      steps.push(inputs.update(requireId(input.id, 'PendingTurnInput.id'), {
        state: 'consumed',
        updated_at: now
      }));
    }
  }
  return steps;
}

async function terminalBlockingInputs(database: RuntimeDatabase, turnId: string): Promise<DomainRow[]> {
  return (await listAllDomainRows(database, 'PendingTurnInput', {
    turn_id: turnId,
    state: 'pending'
  })).filter((input) => TERMINAL_BLOCKING_INPUT_KINDS.includes(
    String(input.input_kind) as typeof TERMINAL_BLOCKING_INPUT_KINDS[number]
  ));
}

export async function contextRootContainsCompleteToolPair(
  database: RuntimeDatabase,
  rootIdInput: string,
  toolCallIdInput: string
): Promise<boolean> {
  const rootId = requireId(rootIdInput, 'rootId');
  const toolCallId = requireId(toolCallIdInput, 'toolCallId');
  const callSources = await listAllDomainRows(database, 'ContextSegmentSource', {
    source_kind: 'tool_call',
    source_id: toolCallId
  });
  if (callSources.length !== 1) return false;
  const pairSegmentId = requireId(callSources[0].segment_id, 'ContextSegmentSource.segment_id');
  const pairSources = await listAllDomainRows(database, 'ContextSegmentSource', {
    segment_id: pairSegmentId
  });
  const resultSources = pairSources.filter((source) => source.source_kind === 'tool_model_result');
  if (resultSources.length === 0) return false;
  const resultSnapshot = await database.snapshot(resultSources.map((source) =>
    DOMAIN_REPOSITORIES.domain('ToolModelResult').get(
      requireId(source.source_id, 'ContextSegmentSource.source_id')
    )
  ));
  if (!resultSnapshot.snapshot.some((result) =>
    !!result && !Array.isArray(result) && result.tool_call_id === toolCallId
  )) return false;

  const materialized = await database.materializeContext(rootId);
  const conversationId = requireId(materialized.snapshot.root.conversation_id, 'ContextSequenceRoot.conversation_id');
  const visibleSegmentIds = materialized.snapshot.records.map((record) =>
    requireId(record.segment.id, 'ContextSegment.id')
  );
  if (visibleSegmentIds.includes(pairSegmentId)) return true;
  for (const segmentId of visibleSegmentIds) {
    if (await compressionContainsSegment(database, conversationId, segmentId, pairSegmentId, new Set())) return true;
  }
  return false;
}

async function compressionContainsSegment(
  database: RuntimeDatabase,
  conversationId: string,
  summarySegmentId: string,
  targetSegmentId: string,
  visited: Set<string>
): Promise<boolean> {
  if (summarySegmentId === targetSegmentId) return true;
  if (visited.has(summarySegmentId)) return false;
  visited.add(summarySegmentId);
  const summarySources = await listAllDomainRows(database, 'ContextSegmentSource', {
    segment_id: summarySegmentId,
    source_kind: 'compression_block'
  });
  if (summarySources.length === 0) return false;
  // Shared summary segments carry one block per owning Conversation; follow only this one's.
  const blocks = await database.snapshot(summarySources.map((source) =>
    DOMAIN_REPOSITORIES.domain('CompressionBlock').get(requireId(source.source_id, 'ContextSegmentSource.source_id'))
  ));
  const owned = blocks.snapshot.filter((block) =>
    !!block && !Array.isArray(block) && (block as DomainRow).conversation_id === conversationId
  ) as DomainRow[];
  if (owned.length !== 1) return false;
  const blockId = requireId(owned[0].id, 'CompressionBlock.id');
  const sources = await listAllDomainRows(database, 'CompressionBlockSource', {
    compression_block_id: blockId
  });
  for (const source of sources) {
    const segmentId = requireId(source.segment_id, 'CompressionBlockSource.segment_id');
    if (segmentId === targetSegmentId) return true;
    if (await compressionContainsSegment(database, conversationId, segmentId, targetSegmentId, visited)) return true;
  }
  return false;
}

function isLeaseAdmissionConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed: execution_lease.conversation_id')
    || message.includes('UNIQUE constraint failed: execution_lease.turn_id');
}
