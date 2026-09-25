import type { InlineDataPart, ModelOutputItemReference } from '../../shared/protocol';
import {
  AttachmentAdmissionError,
  type AttachmentIngestService,
  type PreparedAttachmentAdmission
} from './attachmentIngest';
import { createHash } from 'node:crypto';
import {
  ContentAddressedStore,
  type ContentObjectMetadata,
  type PreparedContentObject
} from './contentAddressedStore';
import {
  DOMAIN_REPOSITORIES,
  savepoint,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { canonicalPlainJson as canonicalJson } from './plainJson';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';
import {
  currentExecutionLeaseFence,
  runWithoutExecutionLeaseFence,
  type ExecutionLeaseFence
} from './executionLeaseFence';
import {
  isNativeAdmissionBoundary,
  NATIVE_TOOL_ADMISSION_CONTENT_TYPE,
  NATIVE_TOOL_DELIVERY_CONTENT_TYPE,
  NativeAsyncWorkPendingError,
  nativeAdmissionContent,
  nativeDeliveryContent,
  normalizeNativeStreamIdentity,
  parseNativeAdmissionContent,
  parseNativeControlCheckpoint,
  parseNativeDeliveryContent,
  parseNativeToolCallCheckpoint,
  TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION,
  TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY,
  type NativeToolCallStreamIdentity
} from './nativeToolFacts';

export {
  NATIVE_ASYNC_WORK_PENDING_CODE,
  NativeAsyncWorkPendingError,
  TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION,
  TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY,
  type NativePendingWorkRef,
  type NativeToolCallStreamIdentity
} from './nativeToolFacts';

export type PhaseDSourceKind = 'command' | 'callback' | 'internal' | 'recovery';
export type PhaseDEffectKind =
  | 'file_mutation'
  | 'process_start'
  | 'process_exit'
  | 'process_stop_request'
  | 'file_transfer'
  | 'subagent_spawn'
  | 'subagent_cancel'
  | 'mcp_tool_call';
export type EffectObservedOutcome = 'succeeded' | 'failed' | 'cancelled' | 'conflict' | 'outcome_unknown';
export type ToolOutcomeStatus =
  | 'succeeded'
  | 'failed'
  | 'partial'
  | 'rejected'
  | 'cancelled'
  | 'conflict'
  | 'outcome_unknown';

export interface PhaseDCommandSource {
  kind: PhaseDSourceKind;
  key: string;
}

export interface CreatedToolCall {
  receiptId: string;
  toolCallId: string;
  toolExecutionId: string;
  callSeq: string;
  deduplicated: boolean;
  commitSeq?: string;
}

export type FrozenToolSchedulingMode = 'parallel' | 'serial';
export type FrozenToolExecutionGate = 'automatic' | 'approval_required';
export type FrozenToolChangeApplyMode = 'automatic' | 'manual' | 'unsupported';

/** Immutable per-call policy/presentation decision compiled before a Provider batch is dispatched. */
export interface FrozenToolCallPolicyDecision {
  summary?: string;
  displayAutoExpand: boolean;
  displayAutoOpenDiff: boolean;
  executionGate: FrozenToolExecutionGate;
  changeApplyMode: FrozenToolChangeApplyMode;
  changeApplyDelaySeconds: number;
  autoSubmitResult: boolean;
  schedulingMode: FrozenToolSchedulingMode;
  schedulingReason?: string;
}

export interface ToolCallBatchEntry {
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  providerCallId?: string;
  providerOrdinal: number;
  thoughtSignature?: string;
  policy: FrozenToolCallPolicyDecision;
}

export interface CreatedToolCallBatch {
  receiptId: string;
  batchId: string;
  calls: Array<{
    toolCallId: string;
    toolExecutionId: string;
    callSeq: string;
    providerOrdinal: number;
  }>;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface AppendedToolCallEvent {
  receiptId: string;
  eventId: string;
  eventSeq: string;
  deduplicated: boolean;
  commitSeq?: string;
}

/** Durable native admission attribution of one ToolCall (row identity + parsed event payload). */
export interface NativeToolAdmission {
  eventId: string;
  toolCallId: string;
  providerCallId: string;
  checkpointId: string;
  attemptSeq: string;
  socketGeneration: string;
  streamSeq: string;
  responseId: string;
  declaredAsync: boolean;
  admittedAt: string;
  /** Actual output-item reference copied from the admission proof. */
  outputItem?: ModelOutputItemReference;
}

/**
 * One durably admitted native ToolCall whose result facts are not fully closed yet.
 * Ordinary unmarked unresolved calls never appear here; they keep failing the regular guards.
 */
export interface NativePendingToolCall {
  toolCallId: string;
  toolName: string;
  turnId: string;
  turnActive: boolean;
  status: string;
  providerCallId: string | undefined;
  /** ToolCallSourceLink.message_id — the assistant Message carrying the call. */
  messageId: string;
  /** ToolCallSourceLink.model_request_id — the request that admitted the call. */
  modelRequestId: string;
  /** The unique ToolModelResult id once the call is settled. */
  toolModelResultId: string | undefined;
  callContextSegmentId: string | undefined;
  resultContextSegmentId: string | undefined;
  /** A unique ToolModelResult exists (the call reached its terminal settlement). */
  settled: boolean;
  /** A native_delivery ToolCallEvent records a server-admitted result delivery. */
  delivered: boolean;
}

export interface NativeResultDeliveryInput {
  toolCallId: string;
  /** The logical local ModelRequest whose continuation carried the outputs (may be unchanged). */
  carrierModelRequestId: string;
  /** Server response.created identity that admitted the outputs. */
  providerResponseId: string;
  connectionGeneration?: string;
  streamId?: string;
}

export interface NativeResultDeliveryMark {
  receiptId: string;
  events: Array<{ toolCallId: string; eventId: string }>;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface PreparedEffectIntent {
  receiptId: string;
  toolCallId: string;
  toolExecutionId: string;
  operationId: string;
  attemptId: string;
  effectIntentId: string;
  effectKind: PhaseDEffectKind;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface RecordedEffectReceipt {
  receiptId: string;
  effectReceiptId: string;
  attemptId: string;
  deduplicated: boolean;
  lateAfterTerminal: boolean;
  commitSeq?: string;
}

export interface ToolTerminalResult {
  /** Present only when the caller has a real persisted CommandReceipt for this replay. */
  receiptId?: string;
  toolCallId: string;
  toolOutcomeId: string;
  toolModelResultId: string;
  messageId: string;
  messageRevisionId: string;
  status: ToolOutcomeStatus;
  deduplicated: boolean;
  commitSeq?: string;
}

export interface ToolSettlementResult {
  receiptId: string;
  toolCallId: string;
  status: ToolOutcomeStatus;
  deduplicated: boolean;
  commitSeq?: string;
  terminal?: ToolTerminalResult;
  toolOutcomeId?: string;
  toolModelResultId?: string;
  messageId?: string;
  messageRevisionId?: string;
}

export interface ToolTerminalPlan extends ToolTerminalResult {
  receiptId: string;
  steps: RepositoryTransactionStep[];
}

export interface OperationCompletion {
  source: PhaseDCommandSource;
  effectReceiptId: string;
  outcome: Exclude<ToolOutcomeStatus, 'rejected'>;
  additionalSteps?: RepositoryTransactionStep[];
}

export class ToolCallOrderBlockedError extends Error {
  public constructor(public readonly toolCallId: string, public readonly predecessorCallSeq: string) {
    super(`ToolCall ${toolCallId} must wait for earlier call_seq ${predecessorCallSeq}.`);
    this.name = 'ToolCallOrderBlockedError';
  }
}

export interface PhaseDDiagnostic {
  kind: 'effect-receipt-deduplicated';
  attemptId: string;
  existingOutcome: string;
  incomingOutcome: string;
  sourceKind: PhaseDSourceKind;
  sourceKey: string;
}

interface ToolFacts {
  toolCall: DomainRow;
  execution: DomainRow;
  turn: DomainRow;
  lease: DomainRow;
  conversation: DomainRow;
}

export interface EffectDispatchFence {
  executionLeaseId: string;
  conversationId: string;
  turnId: string;
  ownerId: string;
  hostBootId: string;
  generation: string;
  expiresAt: string;
}

interface EffectDispatchRequestEnvelope {
  kind: 'limcode-effect-dispatch-request';
  request: unknown;
  dispatchFence: EffectDispatchFence;
}

interface CommandCommit {
  receipt: DomainRow;
  deduplicated: boolean;
  commitSeq?: string;
  allocatedSequences: ReadonlyArray<{ domain: string; id: string; column: string; value: string }>;
}

/** Proof that the caller already performed the source-key duplicate read for this command. */
interface CommandReceiptPreflight {
  receipt: DomainRow | null;
}

const ACTIVE_TURN = 'active';
/** Turns or ToolCalls whose native facts are read in one worker snapshot (five reads per call). */
const NATIVE_PENDING_WORK_BATCH = 200;
/** One repository page of a Turn's ToolCalls inside the batched listing snapshot. */
const NATIVE_PENDING_TOOL_CALL_PAGE = 1000;
const TERMINAL_TURN = 'terminated';
const EFFECT_KINDS: readonly PhaseDEffectKind[] = [
  'file_mutation',
  'process_start',
  'process_exit',
  'process_stop_request',
  'file_transfer',
  'subagent_spawn',
  'subagent_cancel',
  'mcp_tool_call'
];
const TERMINAL_OPERATION_STATUSES: readonly ToolOutcomeStatus[] = [
  'succeeded',
  'failed',
  'partial',
  'rejected',
  'cancelled',
  'conflict',
  'outcome_unknown'
];

/**
 * Phase D Tool/Effect control plane. SQLite facts are the lifecycle authority; dispatchers only run
 * after claimEffectDispatch() commits and report observations through recordEffectReceipt().
 */
export class EffectControlPlane {
  private readonly now: () => string;
  private readonly onDiagnostic: (diagnostic: PhaseDDiagnostic) => void;
  private readonly attachments?: AttachmentIngestService;
  private readonly toolModelResultListeners = new Set<
    (events: Array<{ turnId: string; toolCallId: string }>) => void
  >();
  private readonly finalizationFlights = new Map<string, {
    rerun: boolean;
    promise: Promise<ToolTerminalResult[]>;
  }>();

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    options: {
      now?: () => string;
      onDiagnostic?: (diagnostic: PhaseDDiagnostic) => void;
      attachments?: AttachmentIngestService;
    } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.attachments = options.attachments;
    this.onDiagnostic = options.onDiagnostic ?? ((diagnostic) => {
      console.warn('[reliable-kernel]', JSON.stringify(diagnostic));
    });
  }

  public async createToolCall(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    turnId: string;
    toolName: string;
    arguments: unknown;
  }): Promise<CreatedToolCall> {
    const source = normalizeSource(input.source, ['callback', 'internal'], 'tool-call-create');
    const toolCallId = requireId(input.toolCallId, 'toolCallId');
    const turnId = requireId(input.turnId, 'turnId');
    const toolName = requireText(input.toolName, 'toolName');
    const executionId = stablePhaseDId('tool_execution', toolCallId);
    const scope = JSON.stringify([toolCallId, turnId, toolName]);
    const receiptId = sourceReceiptId(source, 'tool-call-create', scope);
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) return this.replayToolCall(duplicate, receiptId, toolCallId, executionId);

    const turnContext = await this.requireActiveTurnContext(turnId);
    const argumentsContent = await this.contentStore.prepare(
      this.database,
      canonicalJson(input.arguments),
      'application/vnd.limcode.tool-arguments+json'
    );
    const now = this.timestamp();
    const committed = await this.commitSource({
      source,
      receiptId,
      conversationId: turnContext.conversation.id as string,
      turnId,
      receiptPreflight: { receipt: duplicate ?? null },
      steps: [
        DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: ACTIVE_TURN }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(turnContext.lease.id as string, {
          conversation_id: turnContext.conversation.id,
          turn_id: turnId
        }),
        ...preparedContentSteps([argumentsContent], 'tool_args'),
        DOMAIN_REPOSITORIES.domain('ToolCall').insertWithNextSequence({
          id: toolCallId,
          turn_id: turnId,
          tool_name: toolName,
          status: 'pending',
          arguments_object_id: argumentsContent.metadata.id,
          created_at: now,
          updated_at: now
        }, {
          column: 'call_seq',
          scope: { turn_id: turnId }
        }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').insert({
          id: executionId,
          tool_call_id: toolCallId,
          status: 'pending',
          wait_deadline_at: null,
          started_at: now,
          updated_at: now,
          completed_at: null
        })
      ]
    });
    if (committed.deduplicated) return this.replayToolCall(committed.receipt, receiptId, toolCallId, executionId);
    return {
      receiptId,
      toolCallId,
      toolExecutionId: executionId,
      callSeq: allocatedValue(committed, 'ToolCall', toolCallId, 'call_seq'),
      deduplicated: false,
      commitSeq: committed.commitSeq
    };
  }

  /**
   * Persists one completed Provider output as an indivisible call batch. ToolCall is the lifecycle
   * fact; source/policy are separate one-to-one facts and can never be observed half-populated.
   *
   * Native streamed admission (streamIdentity present) admits exactly one call while the logical
   * ModelRequest is still in flight: the persisted complete native call item checkpoint is the
   * execution proof, asynchronous calls admit at the item boundary, synchronous calls additionally
   * require the matching native_control response-boundary checkpoint. A native_admission
   * ToolCallEvent is committed in the same transaction so the proof survives checkpoint pruning.
   */
  public async createToolCallBatch(input: {
    source: PhaseDCommandSource;
    batchId: string;
    turnId: string;
    modelRequestId: string;
    messageId: string;
    entries: readonly ToolCallBatchEntry[];
    streamIdentity?: NativeToolCallStreamIdentity;
  }): Promise<CreatedToolCallBatch> {
    const source = normalizeSource(input.source, ['callback', 'internal'], 'tool-call-batch-create');
    const batchId = requireId(input.batchId, 'batchId');
    const turnId = requireId(input.turnId, 'turnId');
    const modelRequestId = requireId(input.modelRequestId, 'modelRequestId');
    const messageId = requireId(input.messageId, 'messageId');
    if (!Array.isArray(input.entries) || input.entries.length === 0) {
      throw new TypeError('ToolCall batch requires at least one entry.');
    }
    const entries = input.entries.map((entry, index) => normalizeToolCallBatchEntry(entry, index));
    assertUniqueBatchEntries(entries);
    const streamIdentity = input.streamIdentity === undefined
      ? undefined
      : normalizeNativeStreamIdentity(input.streamIdentity);
    if (streamIdentity !== undefined && entries.length !== 1) {
      throw new Error('Native streamed ToolCall admission persists exactly one call per batch.');
    }
    const scope = canonicalJson({
      batchId,
      turnId,
      modelRequestId,
      messageId,
      entries,
      ...(streamIdentity === undefined ? {} : { streamIdentity })
    });
    const receiptId = sourceReceiptId(source, 'tool-call-batch-create', scope);
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) {
      return this.replayToolCallBatch(duplicate, receiptId, batchId, modelRequestId, messageId, entries, streamIdentity);
    }

    const turnContext = await this.requireActiveTurnContext(turnId);
    const modelRequest = await this.requireExisting('ModelRequest', modelRequestId);
    if (streamIdentity === undefined) {
      if (
        modelRequest.turn_id !== turnId
        || modelRequest.status !== 'terminal'
        || modelRequest.terminal_state !== 'completed'
      ) throw new Error(`ModelRequest ${modelRequestId} is not the completed Provider source for Turn ${turnId}.`);
    } else if (modelRequest.turn_id !== turnId) {
      throw new Error(`ModelRequest ${modelRequestId} does not belong to Turn ${turnId}.`);
    } else if (modelRequest.status === 'terminal') {
      throw new Error(
        `ModelRequest ${modelRequestId} is already terminal; native streamed admission of ${entries[0].toolCallId} requires the in-flight request.`
      );
    }
    await this.requireExisting('Message', messageId);
    const messageLinks = await this.list('ModelRequestMessageLink', { model_request_id: modelRequestId }, 2);
    if (messageLinks.length !== 1 || messageLinks[0].message_id !== messageId) {
      throw new Error(`ModelRequest ${modelRequestId} is not linked to assistant Message ${messageId}.`);
    }
    const nativeProof = streamIdentity === undefined
      ? undefined
      : await this.requireNativeAdmissionProof(modelRequestId, streamIdentity, entries[0]);

    const argumentContents = await this.contentStore.prepareBatch(
      this.database,
      entries.map((entry) => ({
        content: canonicalJson(entry.arguments),
        contentType: 'application/vnd.limcode.tool-arguments+json'
      }))
    );
    if (argumentContents.length !== entries.length) {
      throw new Error('ToolCall batch argument prepare returned the wrong result count.');
    }
    const preparedEntries = entries.map((entry, index) => ({
      entry,
      executionId: stablePhaseDId('tool_execution', entry.toolCallId),
      sourceLinkId: stablePhaseDId('tool_call_source_link', entry.toolCallId),
      policySnapshotId: stablePhaseDId('tool_call_policy_snapshot', entry.toolCallId),
      argumentsContent: argumentContents[index]
    }));
    const now = this.timestamp();
    const nativeAdmissionContentObject = streamIdentity === undefined || nativeProof === undefined
      ? undefined
      : await this.contentStore.prepare(
          this.database,
          canonicalJson(nativeAdmissionContent({
            providerCallId: entries[0].providerCallId as string,
            checkpointId: nativeProof.checkpointId,
            attemptSeq: streamIdentity.attemptSeq,
            socketGeneration: streamIdentity.socketGeneration,
            streamSeq: streamIdentity.streamSeq,
            responseId: nativeProof.responseId,
            declaredAsync: nativeProof.declaredAsync,
            admittedAt: now,
            ...(nativeProof.outputItem ? { outputItem: nativeProof.outputItem } : {})
          })),
          NATIVE_TOOL_ADMISSION_CONTENT_TYPE
        );
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: ACTIVE_TURN }),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(turnContext.lease.id as string, {
        conversation_id: turnContext.conversation.id,
        turn_id: turnId
      }),
      streamIdentity === undefined
        ? DOMAIN_REPOSITORIES.domain('ModelRequest').assert(modelRequestId, {
            turn_id: turnId,
            status: 'terminal',
            terminal_state: 'completed'
          })
        : DOMAIN_REPOSITORIES.domain('ModelRequest').assert(modelRequestId, {
            turn_id: turnId,
            status: requireText(modelRequest.status, 'ModelRequest.status')
          }),
      DOMAIN_REPOSITORIES.domain('ModelRequestMessageLink').assert(messageLinks[0].id as string, {
        model_request_id: modelRequestId,
        message_id: messageId
      }),
      ...preparedContentSteps(preparedEntries.map((entry) => entry.argumentsContent), 'tool_batch_args'),
      ...(nativeAdmissionContentObject === undefined
        ? []
        : preparedContentSteps([nativeAdmissionContentObject], 'tool_native_admission'))
    ];
    // Lifecycle rows are staged first; relation/snapshot rows are staged only after the complete
    // Provider call set exists. SQLite commit still publishes the whole batch atomically.
    for (const prepared of preparedEntries) {
      const { entry } = prepared;
      steps.push(
        DOMAIN_REPOSITORIES.domain('ToolCall').insertWithNextSequence({
          id: entry.toolCallId,
          turn_id: turnId,
          tool_name: entry.toolName,
          status: 'pending',
          arguments_object_id: prepared.argumentsContent.metadata.id,
          created_at: now,
          updated_at: now
        }, {
          column: 'call_seq',
          scope: { turn_id: turnId }
        }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').insert({
          id: prepared.executionId,
          tool_call_id: entry.toolCallId,
          status: 'pending',
          wait_deadline_at: null,
          started_at: now,
          updated_at: now,
          completed_at: null
        })
      );
    }
    for (const [index, prepared] of preparedEntries.entries()) {
      const { entry } = prepared;
      steps.push(
        DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').insert({
          id: prepared.sourceLinkId,
          tool_call_id: entry.toolCallId,
          model_request_id: modelRequestId,
          message_id: messageId,
          provider_call_id: entry.providerCallId ?? null,
          provider_ordinal: BigInt(entry.providerOrdinal),
          batch_id: batchId,
          batch_ordinal: BigInt(index),
          thought_signature: entry.thoughtSignature ?? null,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolCallPolicySnapshot').insert({
          id: prepared.policySnapshotId,
          tool_call_id: entry.toolCallId,
          summary: entry.policy.summary ?? null,
          display_auto_expand: entry.policy.displayAutoExpand ? 1n : 0n,
          display_auto_open_diff: entry.policy.displayAutoOpenDiff ? 1n : 0n,
          execution_gate: entry.policy.executionGate,
          change_apply_mode: entry.policy.changeApplyMode,
          change_apply_delay_seconds: BigInt(entry.policy.changeApplyDelaySeconds),
          auto_submit_result: entry.policy.autoSubmitResult ? 1n : 0n,
          scheduling_mode: entry.policy.schedulingMode,
          scheduling_reason: entry.policy.schedulingReason ?? null,
          created_at: now
        })
      );
    }
    if (streamIdentity !== undefined && nativeAdmissionContentObject !== undefined) {
      steps.push(
        DOMAIN_REPOSITORIES.domain('ToolCallEvent').insertWithNextSequence({
          id: stablePhaseDId('tool_call_event', `native_admission:${entries[0].toolCallId}`),
          tool_call_id: entries[0].toolCallId,
          event_kind: TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION,
          content_object_id: nativeAdmissionContentObject.metadata.id,
          created_at: now
        }, {
          column: 'event_seq',
          scope: { tool_call_id: entries[0].toolCallId }
        })
      );
    }

    const committed = await this.commitSource({
      source,
      receiptId,
      conversationId: turnContext.conversation.id as string,
      turnId,
      receiptPreflight: { receipt: duplicate ?? null },
      steps
    });
    if (committed.deduplicated) {
      return this.replayToolCallBatch(committed.receipt, receiptId, batchId, modelRequestId, messageId, entries, streamIdentity);
    }
    return {
      receiptId,
      batchId,
      calls: preparedEntries.map((prepared) => ({
        toolCallId: prepared.entry.toolCallId,
        toolExecutionId: prepared.executionId,
        callSeq: allocatedValue(committed, 'ToolCall', prepared.entry.toolCallId, 'call_seq'),
        providerOrdinal: prepared.entry.providerOrdinal
      })),
      deduplicated: false,
      commitSeq: committed.commitSeq
    };
  }

  /** ToolExecutionContext.emit is serialized through this durable, replay-safe event append. */
  public async appendToolCallEvent(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    eventKind: 'stdout' | 'stderr' | 'progress';
    content: unknown;
  }): Promise<AppendedToolCallEvent> {
    const source = normalizeSource(input.source, ['callback', 'internal'], 'tool-call-event-append');
    const toolCallId = requireId(input.toolCallId, 'toolCallId');
    const eventKind = requireToolCallEventKind(input.eventKind);
    const eventId = stablePhaseDId('tool_call_event', `${toolCallId}:${source.kind}:${source.key}`);
    const scope = canonicalJson({ toolCallId, eventKind, content: input.content });
    const receiptId = sourceReceiptId(source, 'tool-call-event-append', scope);
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) return this.replayToolCallEvent(duplicate, receiptId, eventId, toolCallId, eventKind);
    const facts = await this.requireToolFacts(toolCallId, true);
    if (!['pending', 'executing'].includes(String(facts.toolCall.status))) {
      throw new Error(`ToolCall ${toolCallId} cannot append runtime events from ${String(facts.toolCall.status)}.`);
    }
    const content = await this.contentStore.prepare(
      this.database,
      canonicalJson(input.content),
      'application/vnd.limcode.tool-call-event+json'
    );
    const committed = await this.commitSource({
      source,
      receiptId,
      conversationId: facts.conversation.id as string,
      turnId: facts.turn.id as string,
      receiptPreflight: { receipt: duplicate ?? null },
      steps: [
        DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: ACTIVE_TURN }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
          conversation_id: facts.conversation.id,
          turn_id: facts.turn.id
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolCallId, { status: facts.toolCall.status }),
        ...preparedContentSteps([content], 'tool_call_event'),
        DOMAIN_REPOSITORIES.domain('ToolCallEvent').insertWithNextSequence({
          id: eventId,
          tool_call_id: toolCallId,
          event_kind: eventKind,
          content_object_id: content.metadata.id,
          created_at: this.timestamp()
        }, {
          column: 'event_seq',
          scope: { tool_call_id: toolCallId }
        })
      ]
    });
    if (committed.deduplicated) {
      return this.replayToolCallEvent(committed.receipt, receiptId, eventId, toolCallId, eventKind);
    }
    return {
      receiptId,
      eventId,
      eventSeq: allocatedValue(committed, 'ToolCallEvent', eventId, 'event_seq'),
      deduplicated: false,
      commitSeq: committed.commitSeq
    };
  }

  /**
   * Locates the durable native admission of one ToolCall by row identity (tool_call_id +
   * event_kind), never by a deterministic event id, so forked copies with rewritten row ids and
   * pruned original checkpoints still resolve. A ToolCall is native-admitted iff this exists.
   */
  public async readNativeAdmission(toolCallIdInput: string): Promise<NativeToolAdmission | undefined> {
    const toolCallId = requireId(toolCallIdInput, 'toolCallId');
    const events = await this.list('ToolCallEvent', {
      tool_call_id: toolCallId,
      event_kind: TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION
    }, 2);
    if (events.length === 0) return undefined;
    if (events.length > 1) throw new Error(`ToolCall ${toolCallId} has multiple native admission events.`);
    const content = parseNativeAdmissionContent(await this.readToolCallEventContent(events[0]));
    return {
      eventId: requireId(events[0].id, 'ToolCallEvent.id'),
      toolCallId,
      providerCallId: content.providerCallId,
      checkpointId: content.checkpointId,
      attemptSeq: content.attemptSeq,
      socketGeneration: content.socketGeneration,
      streamSeq: content.streamSeq,
      responseId: content.responseId,
      declaredAsync: content.declaredAsync,
      admittedAt: content.admittedAt,
      ...(content.outputItem ? { outputItem: content.outputItem } : {})
    };
  }

  /**
   * Open native work of one Conversation (optionally one Turn): durably admitted native calls
   * whose result is not settled or whose call/result Context occurrence is missing. A call closed
   * in Context is not open work even without a provider native_delivery fact (a chain closed
   * locally never gets one); `includeUndelivered` additionally returns those closed-undelivered
   * calls for callers that attach a later carrier delivery. Every per-call fact is read in bounded
   * batched snapshots instead of sequential round-trips per call.
   */
  public async listNativePendingWork(input: {
    conversationId: string;
    turnId?: string;
    includeUndelivered?: boolean;
  }): Promise<NativePendingToolCall[]> {
    const conversationId = requireId(input.conversationId, 'conversationId');
    const turns = input.turnId === undefined
      ? await listAllDomainRows(this.database, 'Turn', { conversation_id: conversationId })
      : [await this.requireExisting('Turn', requireId(input.turnId, 'turnId'))];
    for (const turn of turns) {
      if (turn.conversation_id !== conversationId) {
        throw new Error(`Turn ${String(turn.id)} belongs to another Conversation.`);
      }
    }
    // ToolCalls of many Turns are listed in one snapshot per chunk; only a Turn filling a whole
    // page falls back to paginated listing.
    const calls: Array<{ turn: DomainRow; call: DomainRow }> = [];
    for (let offset = 0; offset < turns.length; offset += NATIVE_PENDING_WORK_BATCH) {
      const chunk = turns.slice(offset, offset + NATIVE_PENDING_WORK_BATCH);
      const listed = await this.database.snapshot(chunk.map((turn) =>
        DOMAIN_REPOSITORIES.domain('ToolCall').list({
          where: { turn_id: requireId(turn.id, 'Turn.id') },
          orderBy: { column: 'id', direction: 'asc' },
          limit: NATIVE_PENDING_TOOL_CALL_PAGE
        })
      ));
      for (const [index, turn] of chunk.entries()) {
        const page = listed.snapshot[index];
        if (!Array.isArray(page)) throw new TypeError('Native pending-work ToolCall read did not return rows.');
        const turnCalls = page.length < NATIVE_PENDING_TOOL_CALL_PAGE
          ? page
          : await listAllDomainRows(this.database, 'ToolCall', { turn_id: requireId(turn.id, 'Turn.id') });
        for (const call of turnCalls) calls.push({ turn, call });
      }
    }
    const pending: NativePendingToolCall[] = [];
    for (let offset = 0; offset < calls.length; offset += NATIVE_PENDING_WORK_BATCH) {
      pending.push(...await this.readNativePendingBatch(
        calls.slice(offset, offset + NATIVE_PENDING_WORK_BATCH),
        input.includeUndelivered === true
      ));
    }
    return pending;
  }

  private async readNativePendingBatch(
    batch: ReadonlyArray<{ turn: DomainRow; call: DomainRow }>,
    includeUndelivered: boolean
  ): Promise<NativePendingToolCall[]> {
    const calls = batch.map((entry) => entry.call);
    const toolCallIds = calls.map((call) => requireId(call.id, 'ToolCall.id'));
    const facts = await this.database.snapshot(toolCallIds.flatMap((toolCallId) => [
      DOMAIN_REPOSITORIES.domain('ToolCallEvent').list({
        where: { tool_call_id: toolCallId, event_kind: TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION }, limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').list({ where: { tool_call_id: toolCallId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('ToolModelResult').list({ where: { tool_call_id: toolCallId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('ToolCallEvent').list({
        where: { tool_call_id: toolCallId, event_kind: TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY }, limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
        where: { source_kind: 'tool_call', source_id: toolCallId }, limit: 2
      })
    ]));
    const batchRows = (index: number): DomainRow[] => {
      const value = facts.snapshot[index];
      if (!Array.isArray(value)) throw new TypeError('Native pending-work batch read did not return rows.');
      return value;
    };
    const admitted: Array<{
      turn: DomainRow;
      call: DomainRow;
      toolCallId: string;
      link: DomainRow;
      result?: DomainRow;
      delivered: boolean;
      callSource?: DomainRow;
    }> = [];
    for (const [index, call] of calls.entries()) {
      const toolCallId = toolCallIds[index]!;
      const base = index * 5;
      const admissions = batchRows(base);
      if (admissions.length === 0) continue;
      if (admissions.length > 1) throw new Error(`ToolCall ${toolCallId} has multiple native admission events.`);
      const links = batchRows(base + 1);
      if (links.length !== 1) throw new Error(`Native ToolCall ${toolCallId} lacks its unique ToolCallSourceLink.`);
      const results = batchRows(base + 2);
      if (results.length > 1) throw new Error(`ToolCall ${toolCallId} has multiple ToolModelResult rows.`);
      const deliveries = batchRows(base + 3);
      if (deliveries.length > 1) throw new Error(`ToolCall ${toolCallId} has multiple native delivery events.`);
      const callSources = batchRows(base + 4);
      if (callSources.length > 1) throw new Error(`ToolCall ${toolCallId} has multiple Context occurrences.`);
      admitted.push({
        turn: batch[index]!.turn, call, toolCallId, link: links[0]!,
        ...(results[0] ? { result: results[0] } : {}),
        delivered: deliveries.length === 1,
        ...(callSources[0] ? { callSource: callSources[0] } : {})
      });
    }
    const settledEntries = admitted.filter((entry) => entry.result !== undefined);
    const resultFacts = settledEntries.length === 0 ? { snapshot: [] } : await this.database.snapshot(
      settledEntries.map((entry) => DOMAIN_REPOSITORIES.domain('ContextSegmentSource').list({
        where: { source_kind: 'tool_model_result', source_id: requireId(entry.result!.id, 'ToolModelResult.id') },
        limit: 2
      }))
    );
    const resultSourceByCall = new Map<string, DomainRow>();
    for (const [index, entry] of settledEntries.entries()) {
      const sources = resultFacts.snapshot[index];
      if (!Array.isArray(sources)) throw new TypeError('Native result occurrence batch read did not return rows.');
      if (sources.length > 1) {
        throw new Error(`ToolModelResult ${String(entry.result!.id)} has multiple Context occurrences.`);
      }
      if (sources[0]) resultSourceByCall.set(entry.toolCallId, sources[0]);
    }
    const pending: NativePendingToolCall[] = [];
    for (const entry of admitted) {
      const resultSource = resultSourceByCall.get(entry.toolCallId);
      const settled = entry.result !== undefined;
      const closed = settled && entry.callSource !== undefined && resultSource !== undefined;
      if (closed && (entry.delivered || !includeUndelivered)) continue;
      // The admission and its SourceLink commit together from the same provider call identity;
      // reading the link avoids a CAS read per listed call.
      const providerCallId = requireText(entry.link.provider_call_id, 'Native ToolCallSourceLink.provider_call_id');
      pending.push({
        toolCallId: entry.toolCallId,
        toolName: requireText(entry.call.tool_name, 'ToolCall.tool_name'),
        turnId: requireId(entry.turn.id, 'Turn.id'),
        turnActive: entry.turn.status === ACTIVE_TURN,
        status: requireText(entry.call.status, 'ToolCall.status'),
        providerCallId,
        messageId: requireId(entry.link.message_id, 'ToolCallSourceLink.message_id'),
        modelRequestId: requireId(entry.link.model_request_id, 'ToolCallSourceLink.model_request_id'),
        toolModelResultId: entry.result === undefined ? undefined : requireId(entry.result.id, 'ToolModelResult.id'),
        callContextSegmentId: entry.callSource === undefined
          ? undefined
          : requireId(entry.callSource.segment_id, 'ContextSegmentSource.segment_id'),
        resultContextSegmentId: resultSource === undefined
          ? undefined
          : requireId(resultSource.segment_id, 'ContextSegmentSource.segment_id'),
        settled,
        delivered: entry.delivered
      });
    }
    return pending;
  }

  /**
   * Fork/model-switch guard: every durably admitted native call of the Conversation must own a
   * terminal ToolModelResult AND its result Context occurrence. Throws NativeAsyncWorkPendingError
   * (code NATIVE_ASYNC_WORK_PENDING) naming each open call otherwise.
   */
  public async assertNativeWorkSettledForConversation(conversationIdInput: string): Promise<void> {
    const conversationId = requireId(conversationIdInput, 'conversationId');
    const open = (await this.listNativePendingWork({ conversationId })).filter((entry) =>
      !entry.settled || entry.resultContextSegmentId === undefined
    );
    if (open.length === 0) return;
    throw new NativeAsyncWorkPendingError(
      open.map((entry) => ({
        toolCallId: entry.toolCallId,
        reason: !entry.settled
          ? `result not settled (ToolCall status ${entry.status})`
          : 'result Context occurrence not appended'
      })),
      'Wait for the active Turn to settle and append every native result, or cancel it, before forking or switching.'
    );
  }

  /**
   * Commits the durable "server admitted this result" fact once per native ToolCall. The Kernel
   * delivery pump calls this only for a matched explicit result create whose response.created is
   * already checkpointed — the carrier's native_control response.created naming the provider call
   * id in admittedToolResultCallIds is the required durable admission proof (proven replay works
   * even after the carrier sealed; an unverified new delivery is rejected). Unknown or failed
   * outcomes stay unmarked and remain visible through listNativePendingWork. Exactly-once is
   * enforced inside the writer transaction: a repeat with the same carrier identity deduplicates,
   * a conflicting carrier fails.
   */
  public async markNativeResultsDelivered(input: {
    source: PhaseDCommandSource;
    deliveries: readonly NativeResultDeliveryInput[];
  }): Promise<NativeResultDeliveryMark> {
    const source = normalizeSource(input.source, ['callback', 'internal'], 'native-tool-delivery-mark');
    if (!Array.isArray(input.deliveries) || input.deliveries.length === 0) {
      throw new TypeError('Native result delivery requires at least one delivery.');
    }
    const deliveries = input.deliveries.map((delivery, index) => ({
      toolCallId: requireId(delivery?.toolCallId, `deliveries[${index}].toolCallId`),
      carrierModelRequestId: requireId(
        delivery?.carrierModelRequestId,
        `deliveries[${index}].carrierModelRequestId`
      ),
      providerResponseId: requireText(
        delivery?.providerResponseId,
        `deliveries[${index}].providerResponseId`
      ),
      ...(delivery?.connectionGeneration === undefined
        ? {}
        : {
            connectionGeneration: requireDecimalString(
              delivery.connectionGeneration,
              `deliveries[${index}].connectionGeneration`
            )
          }),
      ...(delivery?.streamId === undefined
        ? {}
        : { streamId: requireText(delivery.streamId, `deliveries[${index}].streamId`) })
    }));
    if (new Set(deliveries.map((delivery) => delivery.toolCallId)).size !== deliveries.length) {
      throw new Error('Native result delivery repeats a ToolCall identity.');
    }
    const scope = canonicalJson({ deliveries });
    const receiptId = sourceReceiptId(source, 'native-tool-delivery-mark', scope);
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) {
      assertSourceReceipt(duplicate, receiptId, 'native-tool-delivery-mark');
      return {
        receiptId,
        events: await this.readNativeDeliveryEventRefs(deliveries.map((delivery) => delivery.toolCallId)),
        deduplicated: true
      };
    }

    const prepared: Array<{
      delivery: (typeof deliveries)[number];
      call: DomainRow;
      result: DomainRow;
      providerCallId: string;
      alreadyDelivered: boolean;
    }> = [];
    for (const delivery of deliveries) {
      const call = await this.requireExisting('ToolCall', delivery.toolCallId);
      if (call.status !== 'terminal') {
        throw new Error(`ToolCall ${delivery.toolCallId} is not terminal; only settled native results can be delivered.`);
      }
      const admissions = await this.list('ToolCallEvent', {
        tool_call_id: delivery.toolCallId,
        event_kind: TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION
      }, 2);
      if (admissions.length !== 1) {
        throw new Error(`ToolCall ${delivery.toolCallId} has no durable native admission to deliver.`);
      }
      const results = await this.list('ToolModelResult', { tool_call_id: delivery.toolCallId }, 2);
      if (results.length !== 1) {
        throw new Error(`ToolCall ${delivery.toolCallId} lacks its unique ToolModelResult.`);
      }
      const links = await this.list('ToolCallSourceLink', { tool_call_id: delivery.toolCallId }, 2);
      if (links.length !== 1) {
        throw new Error(`ToolCall ${delivery.toolCallId} lacks its unique ToolCallSourceLink.`);
      }
      const existing = await this.list('ToolCallEvent', {
        tool_call_id: delivery.toolCallId,
        event_kind: TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY
      }, 2);
      if (existing.length > 1) {
        throw new Error(`ToolCall ${delivery.toolCallId} has multiple native delivery events.`);
      }
      let alreadyDelivered = false;
      if (existing.length === 1) {
        const content = parseNativeDeliveryContent(await this.readToolCallEventContent(existing[0]));
        if (
          content.carrierModelRequestId !== delivery.carrierModelRequestId
          || content.providerResponseId !== delivery.providerResponseId
          || content.toolModelResultId !== requireId(results[0].id, 'ToolModelResult.id')
        ) {
          throw new Error(`ToolCall ${delivery.toolCallId} already has a conflicting native delivery.`);
        }
        alreadyDelivered = true;
      }
      prepared.push({
        delivery,
        call,
        result: results[0],
        providerCallId: requireText(links[0].provider_call_id, 'ToolCallSourceLink.provider_call_id'),
        alreadyDelivered
      });
    }
    const turnIdValues = new Set(prepared.map((entry) => requireId(entry.call.turn_id, 'ToolCall.turn_id')));
    if (turnIdValues.size !== 1) {
      throw new Error('One native result delivery command must belong to a single Turn.');
    }
    const turnId = [...turnIdValues][0];
    const turn = await this.requireExisting('Turn', turnId);

    // The carrier is the local logical ModelRequest whose continuation carried the outputs to the
    // server. Proof of the actual server admission is the carrier's persisted native_control
    // response.created checkpoint naming this call in admittedToolResultCallIds — a wrong, missing
    // or cross-Turn carrier can never produce it, and a later-sealed carrier with the checkpoint
    // still supports proven recovery repair (never an unverified new delivery).
    const carrierIds = new Set<string>();
    for (const delivery of deliveries) {
      if (carrierIds.has(delivery.carrierModelRequestId)) continue;
      const carrier = await this.requireExisting('ModelRequest', delivery.carrierModelRequestId);
      if (carrier.turn_id !== turnId) {
        throw new Error(
          `Carrier ModelRequest ${delivery.carrierModelRequestId} does not belong to Turn ${turnId}; it cannot carry native results of this Turn.`
        );
      }
      carrierIds.add(delivery.carrierModelRequestId);
    }
    const fence = currentExecutionLeaseFence();
    if (fence && fence.conversationId !== turn.conversation_id) {
      throw new Error('Native result delivery fence belongs to another Conversation.');
    }
    // commitSource's transaction already prepends the ambient fence's full tuple assertion;
    // unfenced recovery/closure marking deliberately survives its source Turn.

    const fresh = prepared.filter((entry) => !entry.alreadyDelivered);
    for (const entry of fresh) {
      await this.requireNativeAdmissionCreatedProof(
        entry.delivery.carrierModelRequestId,
        entry.providerCallId,
        entry.delivery.providerResponseId
      );
    }
    const now = this.timestamp();
    const contents = await this.contentStore.prepareBatch(
      this.database,
      fresh.map((entry) => ({
        content: canonicalJson(nativeDeliveryContent({
          toolModelResultId: requireId(entry.result.id, 'ToolModelResult.id'),
          messageRevisionId: requireId(entry.result.message_revision_id, 'ToolModelResult.message_revision_id'),
          providerCallId: entry.providerCallId,
          carrierModelRequestId: entry.delivery.carrierModelRequestId,
          providerResponseId: entry.delivery.providerResponseId,
          ...(entry.delivery.connectionGeneration === undefined
            ? {}
            : { connectionGeneration: entry.delivery.connectionGeneration }),
          ...(entry.delivery.streamId === undefined ? {} : { streamId: entry.delivery.streamId }),
          deliveredAt: now
        })),
        contentType: NATIVE_TOOL_DELIVERY_CONTENT_TYPE
      }))
    );
    if (contents.length !== fresh.length) {
      throw new Error('Native delivery content prepare returned the wrong result count.');
    }
    const steps: RepositoryTransactionStep[] = [
      ...[...carrierIds].map((carrierModelRequestId) =>
        DOMAIN_REPOSITORIES.domain('ModelRequest').assert(carrierModelRequestId, { turn_id: turnId })
      )
    ];
    for (const [index, entry] of fresh.entries()) {
      steps.push(
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(entry.delivery.toolCallId, { status: 'terminal' }),
        DOMAIN_REPOSITORIES.domain('ToolModelResult').assert(requireId(entry.result.id, 'ToolModelResult.id'), {
          tool_call_id: entry.delivery.toolCallId
        }),
        DOMAIN_REPOSITORIES.domain('ToolCallEvent').assertNone({
          tool_call_id: entry.delivery.toolCallId,
          event_kind: TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY
        }),
        ...preparedContentSteps([contents[index]], 'tool_native_delivery'),
        DOMAIN_REPOSITORIES.domain('ToolCallEvent').insertWithNextSequence({
          id: stablePhaseDId('tool_call_event', `native_delivery:${entry.delivery.toolCallId}`),
          tool_call_id: entry.delivery.toolCallId,
          event_kind: TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY,
          content_object_id: contents[index].metadata.id,
          created_at: now
        }, {
          column: 'event_seq',
          scope: { tool_call_id: entry.delivery.toolCallId }
        })
      );
    }

    let committed: CommandCommit;
    try {
      committed = await this.commitSource({
        source,
        receiptId,
        conversationId: requireId(turn.conversation_id, 'Turn.conversation_id'),
        turnId,
        receiptPreflight: { receipt: duplicate ?? null },
        steps
      });
    } catch (error) {
      // A racing delivery committed first (same or conflicting carrier). First-wins: identical
      // carrier identity deduplicates; anything else is a real conflict and must surface.
      if (!isTransactionAssertionError(error) && !matchesExpectedUnique(error, [
        ['tool_call_event', ['id']],
        ['tool_call_event', ['tool_call_id', 'event_seq']]
      ])) throw error;
      const events: Array<{ toolCallId: string; eventId: string }> = [];
      for (const entry of prepared) {
        const rows = await this.list('ToolCallEvent', {
          tool_call_id: entry.delivery.toolCallId,
          event_kind: TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY
        }, 2);
        if (rows.length !== 1) throw error;
        const content = parseNativeDeliveryContent(await this.readToolCallEventContent(rows[0]));
        if (
          content.carrierModelRequestId !== entry.delivery.carrierModelRequestId
          || content.providerResponseId !== entry.delivery.providerResponseId
        ) throw error;
        events.push({
          toolCallId: entry.delivery.toolCallId,
          eventId: requireId(rows[0].id, 'ToolCallEvent.id')
        });
      }
      return { receiptId, events, deduplicated: true };
    }
    if (committed.deduplicated) {
      return {
        receiptId,
        events: await this.readNativeDeliveryEventRefs(deliveries.map((delivery) => delivery.toolCallId)),
        deduplicated: true
      };
    }
    return {
      receiptId,
      events: prepared.map((entry) => ({
        toolCallId: entry.delivery.toolCallId,
        eventId: stablePhaseDId('tool_call_event', `native_delivery:${entry.delivery.toolCallId}`)
      })),
      deduplicated: false,
      commitSeq: committed.commitSeq
    };
  }

  /** Operation, Attempt and EffectIntent are inserted in this one SQLite transaction. */
  public async prepareEffectIntent(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    effectKind: PhaseDEffectKind;
    request: unknown;
    owner?: { kind: 'tool_execution' | 'file_change_set' | 'process'; id: string };
  }): Promise<PreparedEffectIntent> {
    const source = normalizeSource(input.source, ['internal'], 'effect-intent-create');
    const toolCallId = requireId(input.toolCallId, 'toolCallId');
    const effectKind = requireEffectKind(input.effectKind);
    const facts = await this.requireToolFacts(toolCallId, true);
    const owner = input.owner ?? { kind: 'tool_execution' as const, id: facts.execution.id as string };
    requireId(owner.id, 'effect owner id');
    const ids = effectIds(toolCallId, owner.kind, owner.id, effectKind);
    const scope = JSON.stringify([toolCallId, owner.kind, owner.id, effectKind]);
    const receiptId = sourceReceiptId(source, 'effect-intent-create', scope);
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) return this.replayPreparedEffect(duplicate, receiptId, ids, toolCallId, effectKind);
    if (facts.toolCall.status !== 'pending' || facts.execution.status !== 'pending') {
      throw new Error(`ToolCall ${toolCallId} cannot create an EffectIntent from ${String(facts.toolCall.status)}/${String(facts.execution.status)}.`);
    }
    const requestContent = await this.contentStore.prepare(
      this.database,
      canonicalJson(input.request),
      `application/vnd.limcode.effect-${effectKind}+json`
    );
    const now = this.timestamp();
    const committed = await this.commitSource({
      source,
      receiptId,
      conversationId: facts.conversation.id as string,
      turnId: facts.turn.id as string,
      receiptPreflight: { receipt: duplicate ?? null },
      steps: [
        DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: ACTIVE_TURN }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
          conversation_id: facts.conversation.id,
          turn_id: facts.turn.id
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolCallId, { status: 'pending' }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(facts.execution.id as string, { status: 'pending' }),
        ...preparedContentSteps([requestContent], 'effect_request'),
        DOMAIN_REPOSITORIES.domain('Operation').insertWithNextSequence({
          id: ids.operationId,
          owner_kind: owner.kind,
          owner_id: owner.id,
          tool_call_id: toolCallId,
          status: 'pending',
          created_at: now,
          updated_at: now
        }, {
          column: 'operation_seq',
          scope: { owner_kind: owner.kind, owner_id: owner.id }
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
          effect_kind: effectKind,
          dispatch_state: 'pending',
          request_object_id: requestContent.metadata.id,
          created_at: now,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').update(toolCallId, { status: 'executing', updated_at: now }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').update(facts.execution.id as string, {
          status: 'executing',
          updated_at: now
        })
      ]
    });
    if (committed.deduplicated) {
      return this.replayPreparedEffect(committed.receipt, receiptId, ids, toolCallId, effectKind);
    }
    return {
      receiptId,
      toolCallId,
      toolExecutionId: facts.execution.id as string,
      ...ids,
      effectKind,
      deduplicated: false,
      commitSeq: committed.commitSeq
    };
  }

  /**
   * Claims the pending intent by committing dispatch_state=dispatched before any external capability
   * is invoked. false means this intent was already claimed/observed and must not be dispatched again.
   */
  public async claimEffectDispatch(effectIntentIdInput: string): Promise<boolean> {
    const effectIntentId = requireId(effectIntentIdInput, 'effectIntentId');
    const intent = await this.requireExisting('EffectIntent', effectIntentId);
    const state = requireText(intent.dispatch_state, 'EffectIntent.dispatch_state');
    if (state !== 'pending') return false;
    const attempt = await this.requireExisting('Attempt', requireId(intent.attempt_id, 'EffectIntent.attempt_id'));
    const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
    if (attempt.status !== 'pending' || operation.status !== 'pending') {
      throw new Error(`EffectIntent ${effectIntentId} parent Attempt/Operation is no longer dispatchable.`);
    }
    const toolFacts = operation.tool_call_id === null
      ? null
      : await this.requireToolFacts(requireId(operation.tool_call_id, 'Operation.tool_call_id'), true);
    if (toolFacts && (toolFacts.toolCall.status !== 'executing' || toolFacts.execution.status !== 'executing')) {
      throw new Error(`EffectIntent ${effectIntentId} belongs to a ToolCall that is no longer executing.`);
    }
    const shouldPersistDispatchFence = toolFacts
      && !['subagent_spawn', 'subagent_cancel'].includes(String(intent.effect_kind));
    const dispatchEnvelope = shouldPersistDispatchFence
      ? await this.contentStore.prepare(
          this.database,
          canonicalJson({
            kind: 'limcode-effect-dispatch-request',
            request: await this.readRawEffectRequest(intent),
            dispatchFence: effectDispatchFence(toolFacts)
          } satisfies EffectDispatchRequestEnvelope),
          'application/vnd.limcode.effect-dispatch-request+json'
        )
      : undefined;
    const now = this.timestamp();
    const assertions: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('EffectIntent').assert(effectIntentId, {
        dispatch_state: 'pending',
        request_object_id: intent.request_object_id
      }),
      DOMAIN_REPOSITORIES.domain('Attempt').assert(attempt.id as string, { status: 'pending' }),
      DOMAIN_REPOSITORIES.domain('Operation').assert(operation.id as string, { status: 'pending' })
    ];
    if (toolFacts) {
      assertions.push(
        DOMAIN_REPOSITORIES.domain('Turn').assert(toolFacts.turn.id as string, { status: ACTIVE_TURN }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(toolFacts.lease.id as string, {
          conversation_id: toolFacts.conversation.id,
          turn_id: toolFacts.turn.id,
          owner_id: toolFacts.lease.owner_id,
          host_boot_id: toolFacts.lease.host_boot_id,
          generation: toolFacts.lease.generation
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolFacts.toolCall.id as string, { status: 'executing' }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(toolFacts.execution.id as string, { status: 'executing' })
      );
    }
    try {
      await this.database.transaction([
        ...assertions,
        ...(dispatchEnvelope ? preparedContentSteps([dispatchEnvelope], 'effect_dispatch_request') : []),
        DOMAIN_REPOSITORIES.domain('EffectIntent').update(effectIntentId, {
          dispatch_state: 'dispatched',
          ...(dispatchEnvelope ? { request_object_id: dispatchEnvelope.metadata.id } : {}),
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Attempt').update(attempt.id as string, {
          status: 'dispatched',
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Operation').update(operation.id as string, {
          status: 'executing',
          updated_at: now
        })
      ]);
      return true;
    } catch (error) {
      if (!isTransactionAssertionError(error)) throw error;
      const latest = await this.requireExisting('EffectIntent', effectIntentId);
      if (latest.dispatch_state === 'pending') throw error;
      return false;
    }
  }

  /**
   * Cancels an EffectIntent only while dispatch_state is still pending. Once dispatch wins the CAS,
   * capability-specific code must persist a real Receipt (often outcome_unknown) instead.
   */
  public async cancelPendingEffect(input: {
    source: PhaseDCommandSource;
    effectIntentId: string;
    detail: unknown;
  }): Promise<ToolSettlementResult | null> {
    const source = normalizeSource(input.source, ['internal'], 'effect-cancel-before-dispatch');
    const effectIntentId = requireId(input.effectIntentId, 'effectIntentId');
    const intent = await this.requireExisting('EffectIntent', effectIntentId);
    const attempt = await this.requireExisting('Attempt', requireId(intent.attempt_id, 'EffectIntent.attempt_id'));
    const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
    const toolCallId = requireId(operation.tool_call_id, 'Operation.tool_call_id');
    const facts = await this.requireToolFacts(toolCallId, true);
    const receiptId = sourceReceiptId(
      source,
      'effect-cancel-before-dispatch',
      JSON.stringify([effectIntentId, toolCallId])
    );
    const duplicate = await this.findSourceReceipt(source);
    if (intent.dispatch_state !== 'pending' && !duplicate) return null;
    if (!duplicate) {
      const now = this.timestamp();
      const resultContent = await this.contentStore.prepare(
        this.database,
        canonicalJson({ toolCallId, status: 'cancelled', detail: input.detail }),
        'application/vnd.limcode.tool-result-artifact+json'
      );
      const ownerCancellationSteps: RepositoryTransactionStep[] = [];
      if (intent.effect_kind === 'file_mutation' && operation.owner_kind === 'file_change_set') {
        ownerCancellationSteps.push(
          DOMAIN_REPOSITORIES.domain('FileChangeSet').update(requireId(operation.owner_id, 'Operation.owner_id'), {
            status: 'cancelled',
            updated_at: now
          })
        );
      }
      try {
        await this.commitSource({
          source,
          receiptId,
          conversationId: requireId(facts.conversation.id, 'Conversation.id'),
          turnId: requireId(facts.turn.id, 'Turn.id'),
          receiptPreflight: { receipt: duplicate ?? null },
          steps: [
            ...preparedContentSteps([resultContent], 'effect_cancel_before_dispatch'),
            DOMAIN_REPOSITORIES.domain('EffectIntent').assert(effectIntentId, { dispatch_state: 'pending' }),
            DOMAIN_REPOSITORIES.domain('Attempt').assert(requireId(attempt.id, 'Attempt.id'), { status: 'pending' }),
            DOMAIN_REPOSITORIES.domain('Operation').assert(requireId(operation.id, 'Operation.id'), { status: 'pending' }),
            DOMAIN_REPOSITORIES.domain('EffectIntent').update(effectIntentId, {
              dispatch_state: 'cancelled_before_dispatch',
              updated_at: now
            }),
            DOMAIN_REPOSITORIES.domain('Attempt').update(requireId(attempt.id, 'Attempt.id'), {
              status: 'cancelled',
              updated_at: now,
              completed_at: now
            }),
            DOMAIN_REPOSITORIES.domain('Operation').update(requireId(operation.id, 'Operation.id'), {
              status: 'cancelled',
              updated_at: now
            }),
            DOMAIN_REPOSITORIES.domain('ToolResultArtifact').insert({
              id: stablePhaseDId('tool_result_artifact', `cancel-before-dispatch:${toolCallId}`),
              tool_call_id: toolCallId,
              role: 'no_effect_result',
              content_object_id: resultContent.metadata.id,
              created_at: now
            }),
            ...ownerCancellationSteps
          ]
        });
      } catch (error) {
        if (!isTransactionAssertionError(error)) throw error;
        const latest = await this.requireExisting('EffectIntent', effectIntentId);
        if (latest.dispatch_state !== 'pending') return null;
        throw error;
      }
    }
    const finalized = await this.finalizeReadyInOrder(requireId(facts.turn.id, 'Turn.id'));
    const terminal = finalized.find((entry) => entry.toolCallId === toolCallId)
      ?? await this.readTerminalResult(toolCallId, true, duplicate?.id as string | undefined);
    return this.settlementResult(
      duplicate ? requireId(duplicate.id, 'CommandReceipt.id') : receiptId,
      toolCallId,
      'cancelled',
      duplicate !== undefined,
      terminal ?? undefined
    );
  }

  public async readEffectRequest<T = unknown>(effectIntentIdInput: string): Promise<T> {
    const intent = await this.requireExisting('EffectIntent', requireId(effectIntentIdInput, 'effectIntentId'));
    const value = await this.readRawEffectRequest(intent);
    return isEffectDispatchRequestEnvelope(value) ? value.request as T : value as T;
  }

  public async readEffectDispatchFence(effectIntentIdInput: string): Promise<EffectDispatchFence | undefined> {
    const intent = await this.requireExisting('EffectIntent', requireId(effectIntentIdInput, 'effectIntentId'));
    const value = await this.readRawEffectRequest(intent);
    return isEffectDispatchRequestEnvelope(value) ? value.dispatchFence : undefined;
  }

  /**
   * Resolves the Conversation whose mutable execution this effect belongs to, following
   * EffectIntent → Attempt → Operation → ToolCall → Turn. Returns null only for genuinely
   * detached effects (for example a Process-owned process_exit Operation with no ToolCall);
   * a missing dispatch fence is never treated as detached. Ownership gates use this before any
   * pending/dispatched convergence so a foreign live owner is never dispatched locally.
   */
  public async conversationIdForEffect(effectIntentIdInput: string): Promise<string | null> {
    const intent = await this.requireExisting('EffectIntent', requireId(effectIntentIdInput, 'effectIntentId'));
    const attempt = await this.requireExisting('Attempt', requireId(intent.attempt_id, 'EffectIntent.attempt_id'));
    const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
    if (operation.tool_call_id === null) return null;
    const toolCall = await this.requireExisting('ToolCall', requireId(operation.tool_call_id, 'Operation.tool_call_id'));
    const turn = await this.requireExisting('Turn', requireId(toolCall.turn_id, 'ToolCall.turn_id'));
    return requireId(turn.conversation_id, 'Turn.conversation_id');
  }

  /** Receipt writes do not require or assert an ExecutionLease. */
  public async recordEffectReceipt(input: {
    source: PhaseDCommandSource;
    attemptId: string;
    effectKind: PhaseDEffectKind;
    outcome: EffectObservedOutcome;
    detail?: unknown;
  }): Promise<RecordedEffectReceipt> {
    if (currentExecutionLeaseFence()) {
      return runWithoutExecutionLeaseFence(() => this.recordEffectReceipt(input));
    }
    const source = normalizeSource(input.source, ['callback', 'recovery'], 'effect-receipt-write');
    const attemptId = requireId(input.attemptId, 'attemptId');
    const effectKind = requireEffectKind(input.effectKind);
    const outcome = requireObservedOutcome(input.outcome);
    const intentRows = await this.list('EffectIntent', { attempt_id: attemptId }, 2);
    if (intentRows.length !== 1) throw new Error(`Attempt ${attemptId} must have exactly one EffectIntent.`);
    const intent = intentRows[0];
    if (intent.effect_kind !== effectKind) throw new Error('EffectReceipt kind does not match EffectIntent.');
    if (!['dispatched', 'receipt_written'].includes(String(intent.dispatch_state))) {
      throw new Error(`EffectReceipt cannot be written from dispatch_state=${String(intent.dispatch_state)}.`);
    }
    const attempt = await this.requireExisting('Attempt', attemptId);
    const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
    const toolCallId = operation.tool_call_id === null ? null : requireId(operation.tool_call_id, 'Operation.tool_call_id');
    const toolCall = toolCallId ? await this.requireExisting('ToolCall', toolCallId) : null;
    const turn = toolCall ? await this.requireExisting('Turn', requireId(toolCall.turn_id, 'ToolCall.turn_id')) : null;
    const receiptId = stablePhaseDId('effect_receipt', attemptId);
    const sourceReceipt = sourceReceiptId(source, 'effect-receipt-write', JSON.stringify([attemptId, effectKind]));
    const duplicateSource = await this.findSourceReceipt(source);
    if (duplicateSource) {
      assertSourceReceipt(duplicateSource, sourceReceipt, 'effect-receipt-write');
      const existing = await this.requireExisting('EffectReceipt', receiptId);
      this.logDeduplicatedReceipt(existing, outcome, source);
      return this.effectReceiptResult(existing, duplicateSource, true, toolCall);
    }
    const existingRows = await this.list('EffectReceipt', { attempt_id: attemptId }, 2);
    if (existingRows.length > 0) {
      const committed = await this.commitSource({
        source,
        receiptId: sourceReceipt,
        conversationId: turn ? requireId(turn.conversation_id, 'Turn.conversation_id') : null,
        turnId: turn?.id as string ?? null,
        receiptPreflight: { receipt: duplicateSource ?? null },
        steps: []
      });
      this.logDeduplicatedReceipt(existingRows[0], outcome, source);
      return this.effectReceiptResult(existingRows[0], committed.receipt, true, toolCall);
    }
    const detailAdmission = input.detail === undefined
      ? undefined
      : this.attachments
        ? await this.attachments.prepareValueAttachments(
            input.detail,
            `EffectReceipt ${effectKind}/${attemptId}`
          )
        : { value: input.detail, attachments: [], storageSteps: [], totalBytes: 0 };
    const detail = detailAdmission === undefined
      ? undefined
      : await this.contentStore.prepare(
          this.database,
          canonicalJson(detailAdmission.value),
          `application/vnd.limcode.effect-${effectKind}-receipt+json`
        );
    const now = this.timestamp();
    try {
      const committed = await this.commitSource({
        source,
        receiptId: sourceReceipt,
        conversationId: turn ? requireId(turn.conversation_id, 'Turn.conversation_id') : null,
        turnId: turn?.id as string ?? null,
        receiptPreflight: { receipt: duplicateSource ?? null },
        steps: [
          ...(detailAdmission?.storageSteps ?? []),
          ...(detail ? preparedContentSteps([detail], 'effect_receipt') : []),
          DOMAIN_REPOSITORIES.domain('EffectReceipt').insert({
            id: receiptId,
            attempt_id: attemptId,
            effect_kind: effectKind,
            outcome,
            response_object_id: detail?.metadata.id ?? null,
            conversation_id: turn?.conversation_id ?? null,
            tool_call_id: toolCallId,
            operation_id: operation.id,
            received_at: now
          }),
          DOMAIN_REPOSITORIES.domain('EffectIntent').update(intent.id as string, {
            dispatch_state: 'receipt_written',
            updated_at: now
          })
        ]
      });
      if (committed.deduplicated) {
        const existing = await this.requireExisting('EffectReceipt', receiptId);
        return this.effectReceiptResult(existing, committed.receipt, true, toolCall);
      }
      const written = await this.requireExisting('EffectReceipt', receiptId);
      return this.effectReceiptResult(written, committed.receipt, false, toolCall, committed.commitSeq);
    } catch (error) {
      if (!matchesExpectedUnique(error, [
        ['effect_receipt', ['id']],
        ['effect_receipt', ['attempt_id']],
        ['command_receipt', ['id']],
        ['command_receipt', ['source_kind', 'source_key']]
      ])) throw error;
      const raced = (await this.list('EffectReceipt', { attempt_id: attemptId }, 1))[0];
      if (!raced) throw error;
      const committed = await this.commitSource({
        source,
        receiptId: sourceReceipt,
        conversationId: turn ? requireId(turn.conversation_id, 'Turn.conversation_id') : null,
        turnId: turn?.id as string ?? null,
        receiptPreflight: { receipt: duplicateSource ?? null },
        steps: []
      });
      this.logDeduplicatedReceipt(raced, outcome, source);
      return this.effectReceiptResult(raced, committed.receipt, true, toolCall, committed.commitSeq);
    }
  }

  /**
   * Converts an observed receipt into Attempt/Operation domain status. Tool finalization is then
   * assembled in stable call_seq order; EffectReceipt itself never decides the ToolOutcome.
   */
  public async completeOperation(
    input: OperationCompletion,
    options: { finalize?: boolean } = {}
  ): Promise<ToolTerminalResult | null> {
    const source = normalizeSource(input.source, ['internal', 'recovery'], 'effect-reconcile');
    const effectReceipt = await this.requireExisting('EffectReceipt', requireId(input.effectReceiptId, 'effectReceiptId'));
    const attempt = await this.requireExisting('Attempt', requireId(effectReceipt.attempt_id, 'EffectReceipt.attempt_id'));
    const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
    const toolCallId = requireId(operation.tool_call_id, 'Operation.tool_call_id');
    const toolCall = await this.requireExisting('ToolCall', toolCallId);
    const turnId = requireId(toolCall.turn_id, 'ToolCall.turn_id');
    const turn = await this.requireExisting('Turn', turnId);
    const sourceReceipt = sourceReceiptId(source, 'effect-reconcile', JSON.stringify([effectReceipt.id, input.outcome]));
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) {
      assertSourceReceipt(duplicate, sourceReceipt, 'effect-reconcile');
      const replay = await this.readTerminalResult(toolCallId, true, duplicate.id as string);
      if (replay) return replay;
      if (options.finalize === false) return null;
      const finalized = await this.finalizeReadyInOrder(turnId);
      return finalized.find((entry) => entry.toolCallId === toolCallId)
        ?? await this.readTerminalResult(toolCallId, true, duplicate.id as string);
    }
    const existingOutcome = await this.findToolOutcome(toolCallId);
    if (existingOutcome || turn.status === TERMINAL_TURN) {
      const committed = await this.commitSource({
        source,
        receiptId: sourceReceipt,
        conversationId: turn.conversation_id as string,
        turnId,
        receiptPreflight: { receipt: duplicate ?? null },
        steps: []
      });
      return existingOutcome
        ? this.readTerminalResult(toolCallId, true, committed.receipt.id as string)
        : null;
    }
    requireOperationOutcome(input.outcome);
    const facts = await this.requireToolFacts(toolCallId, true);
    const now = this.timestamp();
    const operationAlreadyTerminal = isTerminalOperationStatus(operation.status);
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: ACTIVE_TURN }),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
        conversation_id: facts.conversation.id,
        turn_id: turnId
      })
    ];
    if (!operationAlreadyTerminal) {
      steps.push(
        DOMAIN_REPOSITORIES.domain('Attempt').assert(attempt.id as string, { status: attempt.status }),
        DOMAIN_REPOSITORIES.domain('Operation').assert(operation.id as string, { status: operation.status }),
        DOMAIN_REPOSITORIES.domain('Attempt').update(attempt.id as string, {
          status: input.outcome,
          updated_at: now,
          completed_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Operation').update(operation.id as string, {
          status: input.outcome,
          updated_at: now
        })
      );
    }
    if (input.additionalSteps) steps.push(...input.additionalSteps);
    try {
      await this.commitSource({
        source,
        receiptId: sourceReceipt,
        conversationId: facts.conversation.id as string,
        turnId,
        receiptPreflight: { receipt: duplicate ?? null },
        steps
      });
    } catch (error) {
      if (!isTransactionAssertionError(error)) throw error;
      const latestOperation = await this.requireExisting('Operation', operation.id as string);
      if (!isTerminalOperationStatus(latestOperation.status)) throw error;
      await this.commitSource({
        source,
        receiptId: sourceReceipt,
        conversationId: facts.conversation.id as string,
        turnId,
        receiptPreflight: { receipt: duplicate ?? null },
        steps: []
      });
    }
    if (options.finalize === false) return null;
    const finalized = await this.finalizeReadyInOrder(turnId);
    return finalized.find((entry) => entry.toolCallId === toolCallId)
      ?? await this.readTerminalResult(toolCallId, false, sourceReceipt);
  }

  /** Persists a compact model-facing override after effect facts settle and before ordered finalization. */
  public async recordToolModelDetail(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    status: ToolOutcomeStatus;
    detail: unknown;
  }): Promise<ToolTerminalResult | null> {
    const source = normalizeSource(input.source, ['internal', 'recovery'], 'tool-model-detail-record');
    const toolCallId = requireId(input.toolCallId, 'toolCallId');
    const status = requireToolOutcome(input.status);
    // The source identity represents the one model response slot, not a mutable observation of
    // live output. Recovery must be able to reuse the first committed artifact after output grows.
    const scope = canonicalJson({ toolCallId, status });
    const receiptId = sourceReceiptId(source, 'tool-model-detail-record', scope);
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) {
      assertSourceReceipt(duplicate, receiptId, 'tool-model-detail-record');
      const facts = await this.requireToolFacts(toolCallId, false);
      await this.finalizeReadyInOrder(facts.turn.id as string);
      const terminal = await this.readTerminalResult(toolCallId, true, duplicate.id as string);
      if (!terminal) {
        throw new Error(`ToolCall ${toolCallId} model detail source receipt has no terminal result.`);
      }
      return terminal;
    }
    const facts = await this.requireToolFacts(toolCallId, true);
    const existingTerminal = await this.readTerminalResult(toolCallId, true);
    if (existingTerminal) {
      const committed = await this.commitSource({
        source,
        receiptId,
        conversationId: facts.conversation.id as string,
        turnId: facts.turn.id as string,
        receiptPreflight: { receipt: duplicate ?? null },
        steps: []
      });
      return { ...existingTerminal, receiptId: committed.receipt.id as string };
    }
    const operations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: toolCallId });
    if (operations.length === 0 || operations.some((operation) => !isTerminalOperationStatus(operation.status))) {
      throw new Error(`ToolCall ${toolCallId} cannot record model detail before every Operation settles.`);
    }
    const aggregate = aggregateOperationOutcomes(operations.map((operation) => operation.status as ToolOutcomeStatus));
    if (aggregate !== status) {
      throw new Error(`ToolCall ${toolCallId} model detail status ${status} does not match Operation status ${aggregate}.`);
    }
    const existingArtifacts = await this.list('ToolResultArtifact', { tool_call_id: toolCallId, role: 'model_response' }, 2);
    if (existingArtifacts.length > 1) {
      throw new Error(`ToolCall ${toolCallId} has multiple model_response artifacts.`);
    }
    if (existingArtifacts.length === 1) {
      const ready = await this.readReadyToolOutcome(toolCallId, operations);
      if (!ready || ready.status !== status) {
        throw new Error(`ToolCall ${toolCallId} existing model_response artifact is inconsistent.`);
      }
      const committed = await this.commitSource({
        source,
        receiptId,
        conversationId: facts.conversation.id as string,
        turnId: facts.turn.id as string,
        receiptPreflight: { receipt: duplicate ?? null },
        steps: []
      });
      const finalized = await this.finalizeReadyInOrder(facts.turn.id as string);
      return finalized.find((entry) => entry.toolCallId === toolCallId)
        ?? await this.readTerminalResult(toolCallId, true, committed.receipt.id as string);
    }
    const content = await this.contentStore.prepare(
      this.database,
      canonicalJson({ toolCallId, status, detail: input.detail }),
      'application/vnd.limcode.tool-result-artifact+json'
    );
    const now = this.timestamp();
    let committed: CommandCommit;
    try {
      committed = await this.commitSource({
        source,
        receiptId,
        conversationId: facts.conversation.id as string,
        turnId: facts.turn.id as string,
        receiptPreflight: { receipt: duplicate ?? null },
        steps: [
          DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: ACTIVE_TURN }),
          DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
            conversation_id: facts.conversation.id,
            turn_id: facts.turn.id
          }),
          ...preparedContentSteps([content], 'tool_model_detail'),
          DOMAIN_REPOSITORIES.domain('ToolResultArtifact').insert({
            id: stablePhaseDId('tool_result_artifact', `model-response:${toolCallId}`),
            tool_call_id: toolCallId,
            role: 'model_response',
            content_object_id: content.metadata.id,
            created_at: now
          })
        ]
      });
    } catch (error) {
      if (!matchesExpectedUnique(error, [
        ['tool_result_artifact', ['id']],
        ['tool_result_artifact', ['tool_call_id', 'role']]
      ])) throw error;
      const artifacts = await this.list('ToolResultArtifact', { tool_call_id: toolCallId, role: 'model_response' }, 2);
      if (artifacts.length !== 1) throw error;
      committed = await this.commitSource({
        source,
        receiptId,
        conversationId: facts.conversation.id as string,
        turnId: facts.turn.id as string,
        receiptPreflight: { receipt: duplicate ?? null },
        steps: []
      });
    }
    const finalized = await this.finalizeReadyInOrder(facts.turn.id as string);
    return finalized.find((entry) => entry.toolCallId === toolCallId)
      ?? await this.readTerminalResult(toolCallId, committed.deduplicated, committed.receipt.id as string);
  }

  /**
   * Last-mile closure for interruption/recovery after every effect Operation is already durable.
   * It preserves the aggregate observed status and supplies only a bounded missing-detail marker;
   * it never reclassifies a successful external effect as failed or cancelled.
   */
  public async finalizeTerminalOperationsWithFallback(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    detail: unknown;
  }): Promise<ToolTerminalResult | null> {
    const toolCallId = requireId(input.toolCallId, 'toolCallId');
    const existing = await this.readTerminalResult(toolCallId, false);
    if (existing) return existing;
    const operations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: toolCallId });
    if (operations.length === 0 || operations.some((operation) => !isTerminalOperationStatus(operation.status))) {
      return null;
    }
    // process_start requires its effect-specific stable handoff detail (especially processId).
    // A generic interruption marker must never win the immutable model_response slot.
    if (await this.operationsRequireModelResponse(operations)) return null;
    return this.recordToolModelDetail({
      source: input.source,
      toolCallId,
      status: aggregateOperationOutcomes(operations.map((operation) => operation.status as ToolOutcomeStatus)),
      detail: input.detail
    });
  }

  /** Completes a Process-owned observation Operation that intentionally has no ToolCall result. */
  public async completeDetachedOperation(input: {
    source: PhaseDCommandSource;
    effectReceiptId: string;
    outcome: Exclude<ToolOutcomeStatus, 'rejected'>;
    additionalSteps: RepositoryTransactionStep[];
  }): Promise<{ receiptId: string; deduplicated: boolean; commitSeq?: string }> {
    if (currentExecutionLeaseFence()) {
      return runWithoutExecutionLeaseFence(() => this.completeDetachedOperation(input));
    }
    const source = normalizeSource(input.source, ['internal', 'recovery'], 'detached-effect-reconcile');
    const effectReceipt = await this.requireExisting('EffectReceipt', requireId(input.effectReceiptId, 'effectReceiptId'));
    const attempt = await this.requireExisting('Attempt', requireId(effectReceipt.attempt_id, 'EffectReceipt.attempt_id'));
    const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
    if (operation.tool_call_id !== null) throw new Error('Detached Effect Operation must not reference a ToolCall.');
    requireOperationOutcome(input.outcome);
    const receiptId = sourceReceiptId(source, 'detached-effect-reconcile', JSON.stringify([effectReceipt.id, input.outcome]));
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) {
      assertSourceReceipt(duplicate, receiptId, 'detached-effect-reconcile');
      return { receiptId: duplicate.id as string, deduplicated: true };
    }
    if (isTerminalOperationStatus(operation.status)) {
      const committed = await this.commitSource({
        source,
        receiptId,
        conversationId: null,
        turnId: null,
        receiptPreflight: { receipt: duplicate ?? null },
        steps: []
      });
      return { receiptId: committed.receipt.id as string, deduplicated: committed.deduplicated, commitSeq: committed.commitSeq };
    }
    const now = this.timestamp();
    try {
      const committed = await this.commitSource({
        source,
        receiptId,
        conversationId: null,
        turnId: null,
        receiptPreflight: { receipt: duplicate ?? null },
        steps: [
          DOMAIN_REPOSITORIES.domain('Attempt').assert(attempt.id as string, { status: attempt.status }),
          DOMAIN_REPOSITORIES.domain('Operation').assert(operation.id as string, { status: operation.status }),
          DOMAIN_REPOSITORIES.domain('Attempt').update(attempt.id as string, {
            status: input.outcome,
            updated_at: now,
            completed_at: now
          }),
          DOMAIN_REPOSITORIES.domain('Operation').update(operation.id as string, {
            status: input.outcome,
            updated_at: now
          }),
          ...input.additionalSteps
        ]
      });
      return { receiptId: committed.receipt.id as string, deduplicated: committed.deduplicated, commitSeq: committed.commitSeq };
    } catch (error) {
      if (!isTransactionAssertionError(error)) throw error;
      const latest = await this.requireExisting('Operation', operation.id as string);
      if (!isTerminalOperationStatus(latest.status)) throw error;
      const committed = await this.commitSource({
        source,
        receiptId,
        conversationId: null,
        turnId: null,
        receiptPreflight: { receipt: duplicate ?? null },
        steps: []
      });
      return { receiptId: committed.receipt.id as string, deduplicated: true, commitSeq: committed.commitSeq };
    }
  }

  /** Persists an internal no-external-effect completion before ordered model-result assembly. */
  public async settleWithoutEffect(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    status: ToolOutcomeStatus;
    detail: unknown;
  }, options: { finalize?: boolean } = {}): Promise<ToolSettlementResult> {
    const source = normalizeSource(input.source, ['internal'], 'tool-settle-without-effect');
    const toolCallId = requireId(input.toolCallId, 'toolCallId');
    const status = requireToolOutcome(input.status);
    const scope = JSON.stringify([toolCallId, status]);
    const receiptId = sourceReceiptId(source, 'tool-settle-without-effect', scope);
    const duplicate = await this.findSourceReceipt(source);
    if (duplicate) {
      assertSourceReceipt(duplicate, receiptId, 'tool-settle-without-effect');
      const facts = await this.requireToolFacts(toolCallId, false);
      if (options.finalize !== false) await this.finalizeReadyInOrder(facts.turn.id as string);
      const replayTerminal = options.finalize === false
        ? undefined
        : await this.readTerminalResult(toolCallId, true, duplicate.id as string) ?? undefined;
      const replayStatus = replayTerminal?.status
        ?? await this.persistedToolOperationStatus(toolCallId, status);
      return this.settlementResult(
        duplicate.id as string,
        toolCallId,
        replayStatus,
        true,
        replayTerminal
      );
    }

    const facts = await this.requireToolFacts(toolCallId, true);
    const existingTerminal = await this.readTerminalResult(toolCallId, true);
    if (existingTerminal) {
      const committed = await this.commitSource({
        source,
        receiptId,
        conversationId: facts.conversation.id as string,
        turnId: facts.turn.id as string,
        receiptPreflight: { receipt: duplicate ?? null },
        steps: []
      });
      return this.settlementResult(
        committed.receipt.id as string,
        toolCallId,
        existingTerminal.status,
        committed.deduplicated,
        { ...existingTerminal, receiptId: committed.receipt.id as string }
      );
    }

    const operations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: toolCallId });
    if (operations.some((operation) => !isTerminalOperationStatus(operation.status))) {
      throw new Error(`ToolCall ${toolCallId} has a non-terminal Operation and cannot use no-effect settlement.`);
    }
    const now = this.timestamp();
    let settledStatus = status;
    let steps: RepositoryTransactionStep[] = [];
    if (operations.length === 0) {
      if (facts.toolCall.status !== 'pending' || facts.execution.status !== 'pending') {
        throw new Error(`ToolCall ${toolCallId} cannot persist a no-effect result from ${String(facts.toolCall.status)}/${String(facts.execution.status)}.`);
      }
      if ((await this.list('FileChangeSet', { tool_call_id: toolCallId }, 1)).length > 0) {
        throw new Error(`ToolCall ${toolCallId} has a FileChangeSet and cannot bypass its decision path.`);
      }
      const preparedAttachment = await this.prepareToolResultAdmission(
        input.detail,
        `Tool ${toolCallId} result`
      );
      const attachmentAdmission = preparedAttachment.admission;
      settledStatus = preparedAttachment.statusOverride ?? status;
      const content = await this.contentStore.prepare(
        this.database,
        canonicalJson({ toolCallId, status: settledStatus, detail: attachmentAdmission.value }),
        'application/vnd.limcode.tool-result-artifact+json'
      );
      const operationId = stablePhaseDId('operation', `no-effect:${toolCallId}`);
      const artifactId = stablePhaseDId('tool_result_artifact', `no-effect:${toolCallId}`);
      steps = [
        DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: ACTIVE_TURN }),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
          conversation_id: facts.conversation.id,
          turn_id: facts.turn.id
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(toolCallId, { status: 'pending' }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(facts.execution.id as string, { status: 'pending' }),
        ...attachmentAdmission.storageSteps,
        ...preparedContentSteps([content], 'tool_result_artifact'),
        DOMAIN_REPOSITORIES.domain('Operation').insertWithNextSequence({
          id: operationId,
          owner_kind: 'tool_execution',
          owner_id: facts.execution.id,
          tool_call_id: toolCallId,
          status: settledStatus,
          created_at: now,
          updated_at: now
        }, {
          column: 'operation_seq',
          scope: { owner_kind: 'tool_execution', owner_id: facts.execution.id }
        }),
        DOMAIN_REPOSITORIES.domain('ToolResultArtifact').insert({
          id: artifactId,
          tool_call_id: toolCallId,
          role: 'no_effect_result',
          content_object_id: content.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').update(toolCallId, { status: 'executing', updated_at: now }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').update(facts.execution.id as string, {
          status: 'executing',
          updated_at: now
        })
      ];
    }

    let committed: CommandCommit;
    try {
      committed = await this.commitSource({
        source,
        receiptId,
        conversationId: facts.conversation.id as string,
        turnId: facts.turn.id as string,
        receiptPreflight: { receipt: duplicate ?? null },
        steps
      });
    } catch (error) {
      const expectedUnique = matchesExpectedUnique(error, [
        ['operation', ['id']],
        ['operation', ['owner_kind', 'owner_id', 'operation_seq']],
        ['tool_result_artifact', ['id']],
        ['tool_result_artifact', ['tool_call_id', 'role']]
      ]);
      if (!expectedUnique && !isTransactionAssertionError(error)) throw error;
      const latestOperations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: toolCallId });
      const latestArtifacts = await this.list('ToolResultArtifact', {
        tool_call_id: toolCallId,
        role: 'no_effect_result'
      }, 2);
      if (
        latestOperations.length !== 1
        || !isTerminalOperationStatus(latestOperations[0].status)
        || latestArtifacts.length !== 1
      ) throw error;
      committed = await this.commitSource({
        source,
        receiptId,
        conversationId: facts.conversation.id as string,
        turnId: facts.turn.id as string,
        receiptPreflight: { receipt: duplicate ?? null },
        steps: []
      });
    }
    const finalized = options.finalize === false
      ? []
      : await this.finalizeReadyInOrder(facts.turn.id as string);
    const terminal = options.finalize === false
      ? undefined
      : finalized.find((entry) => entry.toolCallId === toolCallId)
        ?? await this.readTerminalResult(toolCallId, committed.deduplicated, committed.receipt.id as string);
    const persistedStatus = terminal?.status
      ?? await this.persistedToolOperationStatus(toolCallId, settledStatus);
    return this.settlementResult(
      committed.receipt.id as string,
      toolCallId,
      persistedStatus,
      committed.deduplicated,
      terminal ? { ...terminal, receiptId: committed.receipt.id as string } : undefined,
      committed.commitSeq
    );
  }

  /** Persists a fresh readonly parallel group in one CAS/SQLite transaction. */
  public async settleWithoutEffectBatch(input: {
    turnId: string;
    settlements: ReadonlyArray<{
      source: PhaseDCommandSource;
      toolCallId: string;
      status: ToolOutcomeStatus;
      detail: unknown;
    }>;
  }): Promise<ToolSettlementResult[]> {
    const turnId = requireId(input.turnId, 'turnId');
    if (input.settlements.length === 0) return [];
    if (input.settlements.length === 1) {
      return [await this.settleWithoutEffect(input.settlements[0], { finalize: false })];
    }
    const context = await this.requireActiveTurnContext(turnId);
    const normalized = input.settlements.map((settlement) => {
      const source = normalizeSource(settlement.source, ['internal'], 'tool-settle-without-effect');
      const toolCallId = requireId(settlement.toolCallId, 'toolCallId');
      const status = requireToolOutcome(settlement.status);
      const receiptId = sourceReceiptId(
        source,
        'tool-settle-without-effect',
        JSON.stringify([toolCallId, status])
      );
      return { ...settlement, source, toolCallId, status, receiptId };
    });
    if (new Set(normalized.map((entry) => entry.toolCallId)).size !== normalized.length) {
      throw new Error('Readonly settlement batch contains duplicate ToolCall ids.');
    }

    const snapshot = await this.database.snapshot(normalized.flatMap((entry) => [
      DOMAIN_REPOSITORIES.domain('ToolCall').get(entry.toolCallId),
      DOMAIN_REPOSITORIES.domain('ToolExecution').list({ where: { tool_call_id: entry.toolCallId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('Operation').list({ where: { tool_call_id: entry.toolCallId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('FileChangeSet').list({ where: { tool_call_id: entry.toolCallId }, limit: 1 }),
      DOMAIN_REPOSITORIES.domain('CommandReceipt').list({
        where: { source_kind: entry.source.kind, source_key: entry.source.key },
        limit: 2
      })
    ]));
    const facts = normalized.map((entry, entryIndex) => {
      const offset = entryIndex * 5;
      const toolCall = snapshot.snapshot[offset];
      const executions = snapshot.snapshot[offset + 1];
      const operations = snapshot.snapshot[offset + 2];
      const changeSets = snapshot.snapshot[offset + 3];
      const receipts = snapshot.snapshot[offset + 4];
      if (!toolCall || Array.isArray(toolCall)) throw new Error(`ToolCall ${entry.toolCallId} does not exist.`);
      if (!Array.isArray(executions) || !Array.isArray(operations) || !Array.isArray(changeSets) || !Array.isArray(receipts)) {
        throw new TypeError('Readonly settlement batch snapshot shape is invalid.');
      }
      return { entry, toolCall, executions, operations, changeSets, receipts };
    });
    const requiresReplayPath = facts.some(({ toolCall, executions, operations, changeSets, receipts }) =>
      toolCall.turn_id !== turnId
      || toolCall.status !== 'pending'
      || executions.length !== 1
      || executions[0].status !== 'pending'
      || operations.length !== 0
      || changeSets.length !== 0
      || receipts.length !== 0
    );
    if (requiresReplayPath) {
      return Promise.all(normalized.map((entry) => this.settleWithoutEffect(entry, { finalize: false })));
    }

    const preparedAttachments = await Promise.all(facts.map(({ entry }) =>
      this.prepareToolResultAdmission(entry.detail, `Tool ${entry.toolCallId} result`)
    ));
    const effectiveFacts = facts.map((fact, index) => ({
      ...fact,
      entry: {
        ...fact.entry,
        status: preparedAttachments[index].statusOverride ?? fact.entry.status
      }
    }));
    const attachmentAdmissions = preparedAttachments.map((prepared) => prepared.admission);
    const preparedContents = await this.contentStore.prepareBatch(
      this.database,
      effectiveFacts.map(({ entry }, index) => ({
        content: canonicalJson({
          toolCallId: entry.toolCallId,
          status: entry.status,
          detail: attachmentAdmissions[index].value
        }),
        contentType: 'application/vnd.limcode.tool-result-artifact+json'
      }))
    );
    const prepared = effectiveFacts.map(({ entry }, index) => ({ entry, content: preparedContents[index] }));
    const now = this.timestamp();
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: ACTIVE_TURN }),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(context.lease.id as string, {
        conversation_id: context.conversation.id,
        turn_id: turnId
      }),
      ...attachmentAdmissions.flatMap((entry) => entry.storageSteps),
      ...preparedContentSteps(prepared.map((entry) => entry.content), 'tool_result_artifact_batch')
    ];
    for (let index = 0; index < effectiveFacts.length; index += 1) {
      const { entry, executions } = effectiveFacts[index];
      const execution = executions[0];
      steps.push(
        DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
          id: entry.receiptId,
          source_kind: entry.source.kind,
          source_key: entry.source.key,
          conversation_id: context.conversation.id,
          turn_id: turnId,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').assert(entry.toolCallId, { status: 'pending', turn_id: turnId }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').assert(execution.id as string, { status: 'pending' }),
        DOMAIN_REPOSITORIES.domain('Operation').insertWithNextSequence({
          id: stablePhaseDId('operation', `no-effect:${entry.toolCallId}`),
          owner_kind: 'tool_execution',
          owner_id: execution.id,
          tool_call_id: entry.toolCallId,
          status: entry.status,
          created_at: now,
          updated_at: now
        }, {
          column: 'operation_seq',
          scope: { owner_kind: 'tool_execution', owner_id: execution.id }
        }),
        DOMAIN_REPOSITORIES.domain('ToolResultArtifact').insert({
          id: stablePhaseDId('tool_result_artifact', `no-effect:${entry.toolCallId}`),
          tool_call_id: entry.toolCallId,
          role: 'no_effect_result',
          content_object_id: prepared[index].content.metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').update(entry.toolCallId, { status: 'executing', updated_at: now }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').update(execution.id as string, {
          status: 'executing',
          updated_at: now
        })
      );
    }
    let commitSeq: string;
    try {
      const committed = await this.database.transaction(steps);
      commitSeq = requireDecimalString(committed.commitSeq, 'commitSeq');
    } catch (error) {
      if (!isTransactionAssertionError(error) && !matchesExpectedUnique(error, [
        ['command_receipt', ['id']],
        ['command_receipt', ['source_kind', 'source_key']],
        ['operation', ['id']],
        ['operation', ['owner_kind', 'owner_id', 'operation_seq']],
        ['tool_result_artifact', ['id']],
        ['tool_result_artifact', ['tool_call_id', 'role']]
      ])) throw error;
      return Promise.all(normalized.map((entry) => this.settleWithoutEffect(entry, { finalize: false })));
    }
    return effectiveFacts.map(({ entry }) => this.settlementResult(
      entry.receiptId,
      entry.toolCallId,
      entry.status,
      false,
      undefined,
      commitSeq
    ));
  }

  /** Used by File decisions/recovery to commit decision + terminal result atomically. */
  public async prepareTerminalPlan(
    toolCallIdInput: string,
    statusInput: ToolOutcomeStatus,
    detail: unknown,
    receiptId = stablePhaseDId('command_receipt', `tool-finalize:${toolCallIdInput}`),
    plannedPredecessors: ReadonlySet<string> = new Set(),
    options: { requireLease?: boolean; attachmentsFrozen?: boolean } = {}
  ): Promise<ToolTerminalPlan> {
    const toolCallId = requireId(toolCallIdInput, 'toolCallId');
    const status = requireToolOutcome(statusInput);
    const existing = await this.readTerminalResult(toolCallId, true, receiptId);
    if (existing) return { ...existing, receiptId, steps: [] };
    const requireLease = options.requireLease !== false;
    const facts = await this.requireToolFacts(toolCallId, requireLease);
    await this.assertCallIsNextForModelResult(facts.toolCall, plannedPredecessors);
    const now = this.timestamp();
    const ids = terminalIds(toolCallId);
    const attachmentAdmission = this.attachments
      ? options.attachmentsFrozen
        ? await this.attachments.prepareFrozenValueAttachments(detail, `Tool ${toolCallId} terminal result`)
        : await this.attachments.prepareValueAttachments(detail, `Tool ${toolCallId} terminal result`)
      : { value: detail, attachments: [], storageSteps: [], totalBytes: 0 };
    const content = await this.contentStore.prepare(
      this.database,
      canonicalJson({ toolCallId, status, detail: attachmentAdmission.value }),
      'application/vnd.limcode.tool-model-result+json'
    );
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('Turn').assert(facts.turn.id as string, { status: ACTIVE_TURN }),
      ...(requireLease ? [DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(facts.lease.id as string, {
        conversation_id: facts.conversation.id,
        turn_id: facts.turn.id
      })] : []),
      ...attachmentAdmission.storageSteps,
      ...preparedContentSteps([content], 'tool_result'),
      DOMAIN_REPOSITORIES.domain('ToolOutcome').insert({
        id: ids.toolOutcomeId,
        tool_call_id: toolCallId,
        status,
        content_object_id: content.metadata.id,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Message').insert({
        id: ids.messageId,
        created_at: now,
        updated_at: now,
        deleted_at: null
      }),
      DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
        id: ids.messageRevisionId,
        message_id: ids.messageId,
        revision_seq: '1',
        role: 'tool',
        content_object_id: content.metadata.id,
        created_at: now
      }),
      ...(this.attachments
        ? this.attachments.linkSteps(attachmentAdmission, ids.messageRevisionId, now)
        : []),
      DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
        id: ids.currentRevisionLinkId,
        message_id: ids.messageId,
        revision_id: ids.messageRevisionId,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insertWithNextSequence({
        id: ids.messageConversationLinkId,
        conversation_id: facts.conversation.id,
        message_id: ids.messageId,
        created_at: now
      }, {
        column: 'message_seq',
        scope: { conversation_id: facts.conversation.id }
      }),
      DOMAIN_REPOSITORIES.domain('MessageTurnLink').insert({
        id: ids.messageTurnLinkId,
        turn_id: facts.turn.id,
        message_id: ids.messageId,
        role: 'tool_result',
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ToolModelResult').insert({
        id: ids.toolModelResultId,
        tool_call_id: toolCallId,
        message_revision_id: ids.messageRevisionId,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ToolCall').update(toolCallId, { status: 'terminal', updated_at: now }),
      DOMAIN_REPOSITORIES.domain('ToolExecution').update(facts.execution.id as string, {
        status: 'completed',
        updated_at: now,
        completed_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Conversation').update(facts.conversation.id as string, { updated_at: now })
    ];
    return {
      receiptId,
      toolCallId,
      ...ids,
      status,
      deduplicated: false,
      steps
    };
  }

  public finalizeReadyInOrder(turnIdInput: string): Promise<ToolTerminalResult[]> {
    const turnId = requireId(turnIdInput, 'turnId');
    const existing = this.finalizationFlights.get(turnId);
    if (existing) {
      existing.rerun = true;
      return existing.promise;
    }
    const flight: { rerun: boolean; promise: Promise<ToolTerminalResult[]> } = {
      rerun: false,
      promise: Promise.resolve([])
    };
    flight.promise = (async () => {
      const finalizedById = new Map<string, ToolTerminalResult>();
      for (;;) {
        flight.rerun = false;
        for (const terminal of await this.finalizeReadyInOrderPass(turnId)) {
          finalizedById.set(terminal.toolCallId, terminal);
        }
        if (flight.rerun) continue;
        // Delete synchronously with the final rerun check. A later caller now creates a new flight
        // instead of attaching to an already-resolved promise and losing its requested pass.
        if (this.finalizationFlights.get(turnId) === flight) this.finalizationFlights.delete(turnId);
        const results = [...finalizedById.values()];
        this.emitToolModelResults(turnId, results);
        return results;
      }
    })().finally(() => {
      if (this.finalizationFlights.get(turnId) === flight) this.finalizationFlights.delete(turnId);
    });
    this.finalizationFlights.set(turnId, flight);
    return flight.promise;
  }

  /**
   * Internal settlement observation for the dispatcher's delivery-pump wake. Fires once per
   * finalize flight with the newly committed ToolModelResult owners; listener exceptions never
   * break finalization. Terminals committed outside a finalize flight (file decision plans) are
   * re-announced by the dispatcher at its own observation points instead.
   */
  public subscribeToolModelResults(
    listener: (events: Array<{ turnId: string; toolCallId: string }>) => void
  ): () => void {
    this.toolModelResultListeners.add(listener);
    return () => {
      this.toolModelResultListeners.delete(listener);
    };
  }

  private emitToolModelResults(turnId: string, results: readonly ToolTerminalResult[]): void {
    if (results.length === 0 || this.toolModelResultListeners.size === 0) return;
    const events = results.map((result) => ({ turnId, toolCallId: result.toolCallId }));
    for (const listener of [...this.toolModelResultListeners]) {
      try {
        listener(events);
      } catch {
        // Settlement observers must never break finalization.
      }
    }
  }

  private async finalizeReadyInOrderPass(turnId: string): Promise<ToolTerminalResult[]> {
    const turn = await this.requireExisting('Turn', turnId);
    if (turn.status !== ACTIVE_TURN) return [];
    const calls = (await listAllDomainRows(this.database, 'ToolCall', { turn_id: turnId }))
      .sort((left, right) => compareBigInt(left.call_seq, right.call_seq));
    const batched = await this.finalizeFreshNoEffectPrefix(turnId, calls);
    const finalized: ToolTerminalResult[] = batched ?? [];
    const batchedIds = new Set(finalized.map((entry) => entry.toolCallId));
    for (const call of calls) {
      if (call.status === 'terminal') continue;
      const toolCallId = call.id as string;
      if (batchedIds.has(toolCallId)) continue;
      const existing = await this.readTerminalResult(toolCallId, true);
      if (existing) continue;
      const operations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: toolCallId });
      const ready = await this.readReadyToolOutcome(toolCallId, operations);
      if (!ready) break;
      const { status, detail } = ready;
      const source: PhaseDCommandSource = { kind: 'internal', key: `tool-finalize:${toolCallId}` };
      const receiptId = sourceReceiptId(source, 'tool-finalize', toolCallId);
      const plan = await this.prepareTerminalPlan(
        toolCallId,
        status,
        detail,
        receiptId,
        new Set(),
        { attachmentsFrozen: true }
      );
      const facts = await this.requireToolFacts(toolCallId, true);
      try {
        const committed = await this.commitSource({
          source,
          receiptId,
          conversationId: facts.conversation.id as string,
          turnId,
          steps: plan.steps
        });
        if (committed.deduplicated) {
          const replay = await this.readTerminalResult(toolCallId, true, committed.receipt.id as string);
          if (replay) finalized.push(replay);
        } else {
          finalized.push({
            ...withoutSteps(plan),
            receiptId: committed.receipt.id as string,
            deduplicated: false,
            commitSeq: committed.commitSeq
          });
        }
      } catch (error) {
        if (!matchesExpectedUnique(error, [
          ['tool_outcome', ['id']],
          ['tool_outcome', ['tool_call_id']],
          ['tool_model_result', ['id']],
          ['tool_model_result', ['tool_call_id']],
          ['tool_model_result', ['message_revision_id']],
          ['command_receipt', ['id']],
          ['command_receipt', ['source_kind', 'source_key']]
        ])) throw error;
        const raced = await this.readTerminalResult(toolCallId, true);
        if (!raced) throw error;
        finalized.push(raced);
      }
    }
    return finalized;
  }

  private async finalizeFreshNoEffectPrefix(
    turnId: string,
    calls: readonly DomainRow[]
  ): Promise<ToolTerminalResult[] | null> {
    const pending = calls.filter((call) => call.status !== 'terminal');
    if (pending.length < 2) return null;
    const snapshot = await this.database.snapshot(pending.flatMap((call) => {
      const toolCallId = requireId(call.id, 'ToolCall.id');
      const finalizeSource = { kind: 'internal' as const, key: `tool-finalize:${toolCallId}` };
      return [
        DOMAIN_REPOSITORIES.domain('ToolExecution').list({ where: { tool_call_id: toolCallId }, limit: 2 }),
        DOMAIN_REPOSITORIES.domain('Operation').list({ where: { tool_call_id: toolCallId }, limit: 2 }),
        DOMAIN_REPOSITORIES.domain('ToolResultArtifact').list({
          where: { tool_call_id: toolCallId, role: 'no_effect_result' }, limit: 2
        }),
        DOMAIN_REPOSITORIES.domain('FileChangeSet').list({ where: { tool_call_id: toolCallId }, limit: 1 }),
        DOMAIN_REPOSITORIES.domain('ToolOutcome').list({ where: { tool_call_id: toolCallId }, limit: 1 }),
        DOMAIN_REPOSITORIES.domain('CommandReceipt').list({
          where: { source_kind: finalizeSource.kind, source_key: finalizeSource.key }, limit: 2
        })
      ];
    }));
    const readyFacts: Array<{
      call: DomainRow;
      execution: DomainRow;
      operation: DomainRow;
      artifact: DomainRow;
    }> = [];
    for (let index = 0; index < pending.length; index += 1) {
      const offset = index * 6;
      const executions = snapshot.snapshot[offset];
      const operations = snapshot.snapshot[offset + 1];
      const artifacts = snapshot.snapshot[offset + 2];
      const changeSets = snapshot.snapshot[offset + 3];
      const outcomes = snapshot.snapshot[offset + 4];
      const receipts = snapshot.snapshot[offset + 5];
      if (
        !Array.isArray(executions)
        || !Array.isArray(operations)
        || !Array.isArray(artifacts)
        || !Array.isArray(changeSets)
        || !Array.isArray(outcomes)
        || !Array.isArray(receipts)
      ) throw new TypeError('Readonly finalization batch snapshot shape is invalid.');
      const ready = pending[index].status === 'executing'
        && executions.length === 1
        && executions[0].status === 'executing'
        && operations.length === 1
        && isTerminalOperationStatus(operations[0].status)
        && artifacts.length === 1
        && changeSets.length === 0
        && outcomes.length === 0
        && receipts.length === 0;
      if (!ready) break;
      readyFacts.push({
        call: pending[index],
        execution: executions[0],
        operation: operations[0],
        artifact: artifacts[0]
      });
    }
    if (readyFacts.length < 2) return null;

    const metadataSnapshot = await this.database.snapshot(readyFacts.map((facts) =>
      DOMAIN_REPOSITORIES.domain('ContentObject').get(
        requireId(facts.artifact.content_object_id, 'ToolResultArtifact.content_object_id')
      )
    ));
    const ready = await Promise.all(readyFacts.map(async (facts, index) => {
      const metadata = metadataSnapshot.snapshot[index];
      if (!metadata || Array.isArray(metadata)) throw new Error('Readonly result artifact ContentObject does not exist.');
      const body = JSON.parse((await this.contentStore.read(metadata as ContentObjectMetadata)).toString('utf8')) as Record<string, unknown>;
      const toolCallId = requireId(facts.call.id, 'ToolCall.id');
      const status = requireToolOutcome(body.status);
      if (body.toolCallId !== toolCallId || status !== facts.operation.status) {
        throw new Error(`ToolCall ${toolCallId} no-effect result artifact is inconsistent.`);
      }
      return { ...facts, toolCallId, status, detail: body.detail };
    }));
    const context = await this.requireActiveTurnContext(turnId);
    const attachmentAdmissions = await Promise.all(ready.map((entry) => this.attachments
      ? this.attachments.prepareFrozenValueAttachments(entry.detail, `Tool ${entry.toolCallId} terminal result`)
      : Promise.resolve({ value: entry.detail, attachments: [], storageSteps: [], totalBytes: 0 })));
    const prepared = await this.contentStore.prepareBatch(
      this.database,
      ready.map((entry, index) => ({
        content: canonicalJson({
          toolCallId: entry.toolCallId,
          status: entry.status,
          detail: attachmentAdmissions[index].value
        }),
        contentType: 'application/vnd.limcode.tool-model-result+json'
      }))
    );
    const now = this.timestamp();
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: ACTIVE_TURN }),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').assert(context.lease.id as string, {
        conversation_id: context.conversation.id,
        turn_id: turnId
      }),
      ...attachmentAdmissions.flatMap((entry) => entry.storageSteps),
      ...preparedContentSteps(prepared, 'tool_result_batch')
    ];
    const terminals = ready.map((entry, index) => {
      const ids = terminalIds(entry.toolCallId);
      const source = { kind: 'internal' as const, key: `tool-finalize:${entry.toolCallId}` };
      const receiptId = sourceReceiptId(source, 'tool-finalize', entry.toolCallId);
      steps.push(
        DOMAIN_REPOSITORIES.domain('CommandReceipt').insert({
          id: receiptId,
          source_kind: source.kind,
          source_key: source.key,
          conversation_id: context.conversation.id,
          turn_id: turnId,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolOutcome').insert({
          id: ids.toolOutcomeId,
          tool_call_id: entry.toolCallId,
          status: entry.status,
          content_object_id: prepared[index].metadata.id,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Message').insert({
          id: ids.messageId, created_at: now, updated_at: now, deleted_at: null
        }),
        DOMAIN_REPOSITORIES.domain('MessageRevision').insert({
          id: ids.messageRevisionId,
          message_id: ids.messageId,
          revision_seq: '1',
          role: 'tool',
          content_object_id: prepared[index].metadata.id,
          created_at: now
        }),
        ...(this.attachments
          ? this.attachments.linkSteps(attachmentAdmissions[index], ids.messageRevisionId, now)
          : []),
        DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({
          id: ids.currentRevisionLinkId,
          message_id: ids.messageId,
          revision_id: ids.messageRevisionId,
          updated_at: now
        }),
        DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insertWithNextSequence({
          id: ids.messageConversationLinkId,
          conversation_id: context.conversation.id,
          message_id: ids.messageId,
          created_at: now
        }, {
          column: 'message_seq',
          scope: { conversation_id: context.conversation.id }
        }),
        DOMAIN_REPOSITORIES.domain('MessageTurnLink').insert({
          id: ids.messageTurnLinkId,
          turn_id: turnId,
          message_id: ids.messageId,
          role: 'tool_result',
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolModelResult').insert({
          id: ids.toolModelResultId,
          tool_call_id: entry.toolCallId,
          message_revision_id: ids.messageRevisionId,
          created_at: now
        }),
        DOMAIN_REPOSITORIES.domain('ToolCall').update(entry.toolCallId, { status: 'terminal', updated_at: now }),
        DOMAIN_REPOSITORIES.domain('ToolExecution').update(entry.execution.id as string, {
          status: 'completed', updated_at: now, completed_at: now
        })
      );
      return { entry, ids, receiptId };
    });
    steps.push(DOMAIN_REPOSITORIES.domain('Conversation').update(
      context.conversation.id as string,
      { updated_at: now }
    ));
    let commitSeq: string;
    try {
      const committed = await this.database.transaction(steps);
      commitSeq = requireDecimalString(committed.commitSeq, 'commitSeq');
    } catch (error) {
      if (!isTransactionAssertionError(error) && !matchesExpectedUnique(error, [
        ['tool_outcome', ['id']],
        ['tool_outcome', ['tool_call_id']],
        ['tool_model_result', ['id']],
        ['tool_model_result', ['tool_call_id']],
        ['tool_model_result', ['message_revision_id']],
        ['command_receipt', ['id']],
        ['command_receipt', ['source_kind', 'source_key']]
      ])) throw error;
      return null;
    }
    return terminals.map(({ entry, ids, receiptId }) => ({
      receiptId,
      toolCallId: entry.toolCallId,
      ...ids,
      status: entry.status,
      deduplicated: false,
      commitSeq
    }));
  }

  public async readTerminalResult(
    toolCallIdInput: string,
    deduplicated: boolean,
    receiptId?: string
  ): Promise<ToolTerminalResult | null> {
    const toolCallId = requireId(toolCallIdInput, 'toolCallId');
    const terminal = (await this.readTerminalResults([toolCallId], deduplicated))[0] ?? null;
    return terminal && receiptId
      ? { ...terminal, receiptId: requireId(receiptId, 'CommandReceipt.id') }
      : terminal;
  }

  /** Reads an ordered ToolCall slice through one SQLite snapshot barrier. */
  public async readTerminalResults(
    toolCallIdInputs: readonly string[],
    deduplicated: boolean
  ): Promise<Array<ToolTerminalResult | null>> {
    const toolCallIds = toolCallIdInputs.map((value) => requireId(value, 'toolCallId'));
    if (toolCallIds.length === 0) return [];
    const identities = toolCallIds.map((toolCallId) => terminalIds(toolCallId));
    const terminalSnapshot = await this.database.snapshot(toolCallIds.flatMap((toolCallId, index) => [
      DOMAIN_REPOSITORIES.domain('ToolOutcome').list({ where: { tool_call_id: toolCallId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('ToolModelResult').list({ where: { tool_call_id: toolCallId }, limit: 2 }),
      DOMAIN_REPOSITORIES.domain('MessageRevision').get(identities[index].messageRevisionId)
    ]));
    if (terminalSnapshot.snapshot.length !== toolCallIds.length * 3) {
      throw new Error('Terminal ToolCall batch snapshot returned the wrong result count.');
    }
    return toolCallIds.map((toolCallId, index) => this.terminalResultFromSnapshot(
      toolCallId,
      identities[index],
      deduplicated,
      terminalSnapshot.snapshot[index * 3],
      terminalSnapshot.snapshot[index * 3 + 1],
      terminalSnapshot.snapshot[index * 3 + 2]
    ));
  }

  private terminalResultFromSnapshot(
    toolCallId: string,
    ids: ReturnType<typeof terminalIds>,
    deduplicated: boolean,
    outcomeRows: DomainRow | DomainRow[] | null,
    modelRows: DomainRow | DomainRow[] | null,
    revision: DomainRow | DomainRow[] | null
  ): ToolTerminalResult | null {
    if (!Array.isArray(outcomeRows) || !Array.isArray(modelRows)) {
      throw new TypeError('Terminal ToolCall snapshot shape is invalid.');
    }
    if (outcomeRows.length === 0) return null;
    if (outcomeRows.length !== 1) {
      throw new Error(`Terminal ToolCall ${toolCallId} must have exactly one ToolOutcome.`);
    }
    const outcome = outcomeRows[0];
    if (modelRows.length !== 1) throw new Error(`Terminal ToolCall ${toolCallId} must have exactly one ToolModelResult.`);
    const model = modelRows[0];
    if (
      outcome.id !== ids.toolOutcomeId
      || outcome.tool_call_id !== toolCallId
      || model.id !== ids.toolModelResultId
      || model.tool_call_id !== toolCallId
      || model.message_revision_id !== ids.messageRevisionId
      || !revision
      || Array.isArray(revision)
      || revision.id !== ids.messageRevisionId
      || revision.message_id !== ids.messageId
    ) throw new Error(`ToolCall ${toolCallId} terminal identity is inconsistent.`);
    return {
      toolCallId,
      ...ids,
      status: requireToolOutcome(outcome.status),
      deduplicated
    };
  }

  private async persistedToolOperationStatus(
    toolCallId: string,
    fallback: ToolOutcomeStatus
  ): Promise<ToolOutcomeStatus> {
    const operations = await listAllDomainRows(this.database, 'Operation', { tool_call_id: toolCallId });
    if (operations.length === 1 && isTerminalOperationStatus(operations[0].status)) {
      return requireToolOutcome(operations[0].status);
    }
    return fallback;
  }

  private async prepareToolResultAdmission(
    detail: unknown,
    label: string
  ): Promise<{
    admission: PreparedAttachmentAdmission;
    statusOverride?: Extract<ToolOutcomeStatus, 'failed'>;
  }> {
    if (!this.attachments) {
      return { admission: { value: detail, attachments: [], storageSteps: [], totalBytes: 0 } };
    }
    try {
      return { admission: await this.attachments.prepareValueAttachments(detail, label) };
    } catch (error) {
      if (!(error instanceof AttachmentAdmissionError)) throw error;
      const failure = {
        ok: false,
        kind: 'attachment-admission-failed',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 1000)
      };
      return {
        admission: await this.attachments.prepareValueAttachments(failure, `${label} failure`),
        statusOverride: 'failed'
      };
    }
  }

  private settlementResult(
    receiptId: string,
    toolCallId: string,
    status: ToolOutcomeStatus,
    deduplicated: boolean,
    terminal?: ToolTerminalResult,
    commitSeq?: string
  ): ToolSettlementResult {
    return {
      receiptId,
      toolCallId,
      status,
      deduplicated,
      ...(commitSeq ? { commitSeq } : {}),
      ...(terminal ? {
        terminal,
        toolOutcomeId: terminal.toolOutcomeId,
        toolModelResultId: terminal.toolModelResultId,
        messageId: terminal.messageId,
        messageRevisionId: terminal.messageRevisionId
      } : {})
    };
  }

  private async replayToolCall(
    receipt: DomainRow,
    expectedReceiptId: string,
    toolCallId: string,
    executionId: string
  ): Promise<CreatedToolCall> {
    assertSourceReceipt(receipt, expectedReceiptId, 'tool-call-create');
    const toolCall = await this.requireExisting('ToolCall', toolCallId);
    const execution = await this.requireExisting('ToolExecution', executionId);
    if (execution.tool_call_id !== toolCallId) throw new Error('Stable ToolExecution belongs to another ToolCall.');
    return {
      receiptId: receipt.id as string,
      toolCallId,
      toolExecutionId: executionId,
      callSeq: requireBigInt(toolCall.call_seq, 'ToolCall.call_seq').toString(),
      deduplicated: true
    };
  }

  private async replayPreparedEffect(
    receipt: DomainRow,
    expectedReceiptId: string,
    ids: ReturnType<typeof effectIds>,
    toolCallId: string,
    effectKind: PhaseDEffectKind
  ): Promise<PreparedEffectIntent> {
    assertSourceReceipt(receipt, expectedReceiptId, 'effect-intent-create');
    const intent = await this.requireExisting('EffectIntent', ids.effectIntentId);
    const attempt = await this.requireExisting('Attempt', ids.attemptId);
    const operation = await this.requireExisting('Operation', ids.operationId);
    if (
      intent.attempt_id !== ids.attemptId
      || intent.effect_kind !== effectKind
      || attempt.operation_id !== ids.operationId
      || operation.tool_call_id !== toolCallId
    ) throw new Error('Stable EffectIntent result facts do not match the source operation.');
    const executionRows = await this.list('ToolExecution', { tool_call_id: toolCallId }, 2);
    if (executionRows.length !== 1) throw new Error(`ToolCall ${toolCallId} must have one ToolExecution.`);
    return {
      receiptId: receipt.id as string,
      toolCallId,
      toolExecutionId: executionRows[0].id as string,
      ...ids,
      effectKind,
      deduplicated: true
    };
  }

  private logDeduplicatedReceipt(
    existing: DomainRow,
    incomingOutcome: EffectObservedOutcome,
    source: PhaseDCommandSource
  ): void {
    this.onDiagnostic({
      kind: 'effect-receipt-deduplicated',
      attemptId: requireId(existing.attempt_id, 'EffectReceipt.attempt_id'),
      existingOutcome: requireText(existing.outcome, 'EffectReceipt.outcome'),
      incomingOutcome,
      sourceKind: source.kind,
      sourceKey: source.key
    });
  }

  private effectReceiptResult(
    effectReceipt: DomainRow,
    sourceReceipt: DomainRow,
    deduplicated: boolean,
    toolCall: DomainRow | null,
    commitSeq?: string
  ): RecordedEffectReceipt {
    return {
      receiptId: sourceReceipt.id as string,
      effectReceiptId: effectReceipt.id as string,
      attemptId: effectReceipt.attempt_id as string,
      deduplicated,
      lateAfterTerminal: toolCall?.status === 'terminal',
      ...(commitSeq ? { commitSeq } : {})
    };
  }

  private async requireToolFacts(toolCallId: string, requireLease: boolean): Promise<ToolFacts> {
    const compound = await this.database.toolFactsSnapshot(toolCallId);
    const toolCall = requireSnapshotRow(compound.snapshot.toolCall, 'ToolCall', toolCallId);
    const executions = requireSnapshotRows(compound.snapshot.executions, 'ToolExecution');
    assertSingleToolExecution(toolCallId, executions);
    const turnId = requireId(toolCall.turn_id, 'ToolCall.turn_id');
    const turn = requireSnapshotRow(compound.snapshot.turn, 'Turn', turnId);
    const leases = requireSnapshotRows(compound.snapshot.leases, 'ExecutionLease');
    if (leases.length > 1) throw new Error(`Turn ${turnId} must not have multiple ExecutionLeases.`);
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    const conversation = requireSnapshotRow(compound.snapshot.conversation, 'Conversation', conversationId);
    const lease = leases[0];
    if (lease && (lease.turn_id !== turnId || lease.conversation_id !== conversationId)) {
      throw new Error(`Turn ${turnId} ExecutionLease relationship is inconsistent.`);
    }
    const fence = currentExecutionLeaseFence();
    // A same-Turn capability must match every captured generation fact. Coordinators may legally
    // finalize a Child Turn while running under their own parent fence; those transactions retain
    // both the automatic owning-fence assertion and the explicit target-lease assertions in the
    // terminal plan, matching the pre-compound control-plane semantics.
    if (fence?.turnId === turnId) {
      if (conversationId !== fence.conversationId || !lease || lease.id !== fence.id) {
        throw new Error(`ToolCall ${toolCallId} does not belong to its captured ExecutionLease scope.`);
      }
      assertExecutionLeaseIdentity(lease, fence);
    }
    if (requireLease && (turn.status !== ACTIVE_TURN || leases.length !== 1)) {
      throw new Error(`ToolCall ${toolCallId} cannot write terminal facts without its active Turn ExecutionLease.`);
    }
    return { toolCall, execution: executions[0], turn, lease: lease ?? {}, conversation };
  }

  private async requireActiveTurnContext(turnId: string): Promise<{ turn: DomainRow; lease: DomainRow; conversation: DomainRow }> {
    const fence = currentExecutionLeaseFence();
    if (fence) {
      if (fence.turnId !== turnId) {
        throw new Error(`Turn ${turnId} does not match captured ExecutionLease Turn ${fence.turnId}.`);
      }
      const snapshot = await this.database.snapshot([
        DOMAIN_REPOSITORIES.domain('Turn').get(turnId),
        DOMAIN_REPOSITORIES.domain('ExecutionLease').get(fence.id),
        DOMAIN_REPOSITORIES.domain('Conversation').get(fence.conversationId)
      ]);
      const turn = requireSnapshotRow(snapshot.snapshot[0], 'Turn', turnId);
      const lease = requireSnapshotRow(snapshot.snapshot[1], 'ExecutionLease', fence.id);
      const conversation = requireSnapshotRow(snapshot.snapshot[2], 'Conversation', fence.conversationId);
      if (turn.status !== ACTIVE_TURN) throw new Error(`Turn ${turnId} is not active.`);
      if (turn.conversation_id !== fence.conversationId || conversation.id !== fence.conversationId) {
        throw new Error(`Turn ${turnId} does not belong to its captured ExecutionLease Conversation.`);
      }
      assertExecutionLeaseIdentity(lease, fence);
      return { turn, lease, conversation };
    }

    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Turn').get(turnId),
      DOMAIN_REPOSITORIES.domain('ExecutionLease').list({ where: { turn_id: turnId }, limit: 2 })
    ]);
    const turn = requireSnapshotRow(snapshot.snapshot[0], 'Turn', turnId);
    const leases = requireSnapshotRows(snapshot.snapshot[1], 'ExecutionLease');
    if (turn.status !== ACTIVE_TURN) throw new Error(`Turn ${turnId} is not active.`);
    if (leases.length !== 1) throw new Error(`Turn ${turnId} must have exactly one ExecutionLease.`);
    const conversationId = requireId(turn.conversation_id, 'Turn.conversation_id');
    const conversationSnapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Conversation').get(conversationId)
    ]);
    const conversation = requireSnapshotRow(conversationSnapshot.snapshot[0], 'Conversation', conversationId);
    if (leases[0].conversation_id !== conversationId || leases[0].turn_id !== turnId) {
      throw new Error(`Turn ${turnId} ExecutionLease relationship is inconsistent.`);
    }
    return { turn, lease: leases[0], conversation };
  }

  private async assertCallIsNextForModelResult(
    toolCall: DomainRow,
    plannedPredecessors: ReadonlySet<string>
  ): Promise<void> {
    const turnId = requireId(toolCall.turn_id, 'ToolCall.turn_id');
    const callSeq = requireBigInt(toolCall.call_seq, 'ToolCall.call_seq');
    const calls = (await listAllDomainRows(this.database, 'ToolCall', { turn_id: turnId }))
      .sort((left, right) => compareBigInt(left.call_seq, right.call_seq));
    for (const candidate of calls) {
      const candidateSeq = requireBigInt(candidate.call_seq, 'ToolCall.call_seq');
      if (candidateSeq >= callSeq) break;
      const candidateId = requireId(candidate.id, 'ToolCall.id');
      if (!plannedPredecessors.has(candidateId) && !await this.findToolOutcome(candidateId)) {
        throw new ToolCallOrderBlockedError(toolCall.id as string, candidateSeq.toString());
      }
    }
  }

  private async findToolOutcome(toolCallId: string): Promise<DomainRow | undefined> {
    return (await this.list('ToolOutcome', { tool_call_id: toolCallId }, 2))[0];
  }

  private async readReadyToolOutcome(
    toolCallId: string,
    operations: DomainRow[]
  ): Promise<{ status: ToolOutcomeStatus; detail: unknown } | null> {
    if (operations.length > 0) {
      if (operations.some((operation) => !isTerminalOperationStatus(operation.status))) return null;
      const modelArtifacts = await this.list('ToolResultArtifact', {
        tool_call_id: toolCallId,
        role: 'model_response'
      }, 2);
      if (modelArtifacts.length > 0) {
        if (modelArtifacts.length !== 1) {
          throw new Error(`ToolCall ${toolCallId} has multiple model_response artifacts.`);
        }
        const metadata = await this.requireContentObject(
          requireId(modelArtifacts[0].content_object_id, 'ToolResultArtifact.content_object_id')
        );
        const body = JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as Record<string, unknown>;
        const status = requireToolOutcome(body.status);
        const aggregate = aggregateOperationOutcomes(operations.map((operation) => operation.status as ToolOutcomeStatus));
        if (body.toolCallId !== toolCallId || status !== aggregate) {
          throw new Error(`ToolCall ${toolCallId} model_response artifact is inconsistent.`);
        }
        return { status, detail: body.detail };
      }
      const artifacts = await this.list('ToolResultArtifact', {
        tool_call_id: toolCallId,
        role: 'no_effect_result'
      }, 2);
      if (artifacts.length > 0) {
        if (artifacts.length !== 1 || operations.length !== 1) {
          throw new Error(`ToolCall ${toolCallId} no-effect result facts are not one-to-one.`);
        }
        const metadata = await this.requireContentObject(
          requireId(artifacts[0].content_object_id, 'ToolResultArtifact.content_object_id')
        );
        const body = JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as Record<string, unknown>;
        const status = requireToolOutcome(body.status);
        if (body.toolCallId !== toolCallId || status !== operations[0].status) {
          throw new Error(`ToolCall ${toolCallId} no-effect result artifact is inconsistent.`);
        }
        return { status, detail: body.detail };
      }
      if (await this.operationsRequireModelResponse(operations)) return null;
      const operationDetails = await Promise.all(operations
        .sort((left, right) => compareBigInt(left.operation_seq, right.operation_seq))
        .map(async (operation) => ({
          operationId: operation.id,
          operationSeq: requireBigInt(operation.operation_seq, 'Operation.operation_seq').toString(),
          status: operation.status,
          ...(await this.readOperationObservation(operation))
        })));
      return {
        status: aggregateOperationOutcomes(operations.map((operation) => operation.status as ToolOutcomeStatus)),
        detail: hoistOperationAttachmentParts(operationDetails)
      };
    }
    const changeSets = await this.list('FileChangeSet', { tool_call_id: toolCallId }, 2);
    if (changeSets.length !== 1) return null;
    const decisions = await this.list('FileChangeDecision', { change_set_id: changeSets[0].id }, 2);
    if (decisions.length !== 1) return null;
    const decision = String(decisions[0].decision);
    if (decision !== 'rejected' && decision !== 'cancelled' && decision !== 'expired') return null;
    return {
      status: decision === 'rejected' ? 'rejected' : 'cancelled',
      detail: { changeSetId: changeSets[0].id, decision }
    };
  }

  private async operationsRequireModelResponse(operations: readonly DomainRow[]): Promise<boolean> {
    for (const operation of operations) {
      const attempts = await listAllDomainRows(this.database, 'Attempt', { operation_id: operation.id });
      for (const attempt of attempts) {
        const intents = await this.list('EffectIntent', { attempt_id: attempt.id }, 2);
        if (intents.some((intent) => intent.effect_kind === 'process_start')) return true;
      }
    }
    return false;
  }

  private async readOperationObservation(operation: DomainRow): Promise<{
    effectReceiptId?: string;
    detail?: unknown;
  }> {
    const attempts = (await listAllDomainRows(this.database, 'Attempt', {
      operation_id: operation.id
    })).sort((left, right) => compareBigInt(left.attempt_seq, right.attempt_seq));
    const attempt = attempts[attempts.length - 1];
    if (attempt) {
      const receipts = await this.list('EffectReceipt', { attempt_id: attempt.id }, 2);
      const receipt = receipts[0];
      if (receipt) {
        if (receipt.response_object_id === null) return { effectReceiptId: receipt.id as string };
        const metadata = await this.requireContentObject(
          requireId(receipt.response_object_id, 'EffectReceipt.response_object_id')
        );
        return {
          effectReceiptId: receipt.id as string,
          detail: JSON.parse((await this.contentStore.read(metadata)).toString('utf8'))
        };
      }
    }
    const pauses = await this.list('OutcomePause', { operation_id: operation.id }, 2);
    if (pauses.length !== 1) return {};
    const resolutions = await this.list('OperationResolution', { pause_id: pauses[0].id }, 2);
    if (resolutions.length !== 1 || resolutions[0].content_object_id === null) return {};
    const metadata = await this.requireContentObject(
      requireId(resolutions[0].content_object_id, 'OperationResolution.content_object_id')
    );
    return { detail: JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) };
  }

  private async replayToolCallBatch(
    receipt: DomainRow,
    expectedReceiptId: string,
    batchId: string,
    modelRequestId: string,
    messageId: string,
    entries: readonly ToolCallBatchEntry[],
    streamIdentity?: NativeToolCallStreamIdentity
  ): Promise<CreatedToolCallBatch> {
    assertSourceReceipt(receipt, expectedReceiptId, 'tool-call-batch-create');
    const calls: CreatedToolCallBatch['calls'] = [];
    for (const [index, entry] of entries.entries()) {
      const call = await this.requireExisting('ToolCall', entry.toolCallId);
      const executions = await this.list('ToolExecution', { tool_call_id: entry.toolCallId }, 2);
      const links = await this.list('ToolCallSourceLink', { tool_call_id: entry.toolCallId }, 2);
      const policies = await this.list('ToolCallPolicySnapshot', { tool_call_id: entry.toolCallId }, 2);
      if (
        call.tool_name !== entry.toolName
        || executions.length !== 1
        || links.length !== 1
        || policies.length !== 1
      ) throw new Error(`ToolCall batch replay facts conflict for ${entry.toolCallId}.`);
      if (streamIdentity !== undefined) {
        const admissions = await this.list('ToolCallEvent', {
          tool_call_id: entry.toolCallId,
          event_kind: TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION
        }, 2);
        if (admissions.length !== 1) {
          throw new Error(`ToolCall ${entry.toolCallId} native replay lacks its durable admission event.`);
        }
      }
      const link = links[0];
      if (
        link.model_request_id !== modelRequestId
        || link.message_id !== messageId
        || link.provider_call_id !== (entry.providerCallId ?? null)
        || link.provider_ordinal !== BigInt(entry.providerOrdinal)
        || link.batch_id !== batchId
        || link.batch_ordinal !== BigInt(index)
        || link.thought_signature !== (entry.thoughtSignature ?? null)
      ) throw new Error(`ToolCallSourceLink replay conflicts for ${entry.toolCallId}.`);
      assertFrozenPolicyRow(policies[0], entry.policy, entry.toolCallId);
      calls.push({
        toolCallId: entry.toolCallId,
        toolExecutionId: requireId(executions[0].id, 'ToolExecution.id'),
        callSeq: requireBigInt(call.call_seq, 'ToolCall.call_seq').toString(),
        providerOrdinal: entry.providerOrdinal
      });
    }
    return {
      receiptId: requireId(receipt.id, 'CommandReceipt.id'),
      batchId,
      calls,
      deduplicated: true
    };
  }

  private async replayToolCallEvent(
    receipt: DomainRow,
    expectedReceiptId: string,
    eventId: string,
    toolCallId: string,
    eventKind: string
  ): Promise<AppendedToolCallEvent> {
    assertSourceReceipt(receipt, expectedReceiptId, 'tool-call-event-append');
    const event = await this.requireExisting('ToolCallEvent', eventId);
    if (event.tool_call_id !== toolCallId || event.event_kind !== eventKind) {
      throw new Error(`ToolCallEvent ${eventId} conflicts with its replay source.`);
    }
    return {
      receiptId: requireId(receipt.id, 'CommandReceipt.id'),
      eventId,
      eventSeq: requireBigInt(event.event_seq, 'ToolCallEvent.event_seq').toString(),
      deduplicated: true
    };
  }

  private async commitSource(options: {
    source: PhaseDCommandSource;
    receiptId: string;
    conversationId: string | null;
    turnId: string | null;
    steps: RepositoryTransactionStep[];
    receiptPreflight?: CommandReceiptPreflight;
  }): Promise<CommandCommit> {
    const existing = options.receiptPreflight
      ? options.receiptPreflight.receipt ?? undefined
      : await this.findSourceReceipt(options.source);
    if (existing) {
      assertSourceReceipt(existing, options.receiptId, 'Phase D command');
      return { receipt: existing, deduplicated: true, allocatedSequences: [] };
    }
    const receipt = {
      id: options.receiptId,
      source_kind: options.source.kind,
      source_key: options.source.key,
      conversation_id: options.conversationId === null
        ? null
        : requireId(options.conversationId, 'CommandReceipt.conversation_id'),
      turn_id: options.turnId === null ? null : requireId(options.turnId, 'CommandReceipt.turn_id'),
      created_at: this.timestamp()
    };
    try {
      const result = await this.database.transaction([
        DOMAIN_REPOSITORIES.domain('CommandReceipt').insert(receipt),
        ...options.steps
      ]);
      return {
        receipt,
        deduplicated: false,
        commitSeq: requireDecimalString(result.commitSeq, 'commitSeq'),
        allocatedSequences: result.allocatedSequences.map((entry) => ({
          ...entry,
          value: requireDecimalString(entry.value, `${entry.domain}.${entry.column}`)
        }))
      };
    } catch (error) {
      if (!matchesExpectedUnique(error, [
        ['command_receipt', ['id']],
        ['command_receipt', ['source_kind', 'source_key']]
      ])) throw error;
      const raced = await this.findSourceReceipt(options.source);
      if (!raced) throw error;
      assertSourceReceipt(raced, options.receiptId, 'Phase D command');
      return { receipt: raced, deduplicated: true, allocatedSequences: [] };
    }
  }

  private async findSourceReceipt(source: PhaseDCommandSource): Promise<DomainRow | undefined> {
    return (await this.list('CommandReceipt', {
      source_kind: source.kind,
      source_key: source.key
    }, 2))[0];
  }

  private async readRawEffectRequest(intent: DomainRow): Promise<unknown> {
    const metadata = await this.requireContentObject(
      requireId(intent.request_object_id, 'EffectIntent.request_object_id')
    );
    return JSON.parse((await this.contentStore.read(metadata)).toString('utf8'));
  }

  private async readToolCallEventContent(event: DomainRow): Promise<unknown> {
    const metadata = await this.requireContentObject(
      requireId(event.content_object_id, 'ToolCallEvent.content_object_id')
    );
    return JSON.parse((await this.contentStore.read(metadata)).toString('utf8'));
  }

  private async readNativeDeliveryEventRefs(
    toolCallIds: readonly string[]
  ): Promise<Array<{ toolCallId: string; eventId: string }>> {
    const events: Array<{ toolCallId: string; eventId: string }> = [];
    for (const toolCallId of toolCallIds) {
      const rows = await this.list('ToolCallEvent', {
        tool_call_id: toolCallId,
        event_kind: TOOL_CALL_EVENT_KIND_NATIVE_DELIVERY
      }, 2);
      if (rows.length !== 1) {
        throw new Error(`ToolCall ${toolCallId} native delivery replay facts are missing.`);
      }
      events.push({ toolCallId, eventId: requireId(rows[0].id, 'ToolCallEvent.id') });
    }
    return events;
  }

  /**
   * Validates the persisted complete native call item checkpoint behind one streamed admission.
   * Asynchronous calls admit at the complete item; synchronous calls additionally require the
   * native_control response boundary of the SAME provider response (matched by responseId inside
   * the same attempt/socket epoch) and never admit at mere item completion.
   */
  private async requireNativeAdmissionProof(
    modelRequestId: string,
    identity: NativeToolCallStreamIdentity,
    entry: ToolCallBatchEntry
  ): Promise<{ checkpointId: string; responseId: string; declaredAsync: boolean; outputItem?: ModelOutputItemReference }> {
    const providerCallId = entry.providerCallId;
    if (typeof providerCallId !== 'string' || providerCallId.length === 0) {
      throw new Error(
        `Native ToolCall ${entry.toolCallId} requires the original provider call id; anonymous native calls cannot be admitted.`
      );
    }
    const itemSeq = BigInt(identity.streamSeq);
    const attemptSeq = BigInt(identity.attemptSeq);
    const socketGeneration = BigInt(identity.socketGeneration);
    const checkpoints = (await listAllDomainRows(this.database, 'ModelStreamCheckpoint', {
      model_request_id: modelRequestId
    })).filter((row) =>
      requireBigInt(row.attempt_seq, 'ModelStreamCheckpoint.attempt_seq') === attemptSeq
      && requireBigInt(row.socket_generation, 'ModelStreamCheckpoint.socket_generation') === socketGeneration
    );
    const checkpoint = checkpoints.find((row) =>
      row.checkpoint_kind === 'native_tool_call'
      && requireBigInt(row.stream_seq, 'ModelStreamCheckpoint.stream_seq') === itemSeq
    );
    if (!checkpoint) {
      throw new Error(
        `ModelRequest ${modelRequestId} has no persisted complete native call item at ${identity.attemptSeq}/${identity.socketGeneration}/${identity.streamSeq}.`
      );
    }
    const checkpointContent = parseNativeToolCallCheckpoint(
      await this.readCheckpointContent(checkpoint)
    );
    if (
      checkpointContent.toolName !== entry.toolName
      || checkpointContent.providerCallId !== providerCallId
      || checkpointContent.providerOrdinal !== entry.providerOrdinal
      || canonicalJson(checkpointContent.resolvedArguments) !== canonicalJson(entry.arguments)
    ) {
      throw new Error(
        `Native checkpoint ${String(checkpoint.id)} does not match ToolCall ${entry.toolCallId} identity.`
      );
    }
    const checkpointId = requireId(checkpoint.id, 'ModelStreamCheckpoint.id');
    if (checkpointContent.async) {
      if (identity.completedResponseStreamSeq !== undefined || identity.providerResponseId !== undefined) {
        throw new Error('Asynchronous native admission does not take a response boundary.');
      }
      return {
        checkpointId,
        responseId: checkpointContent.responseId,
        declaredAsync: true,
        ...(checkpointContent.outputItem ? { outputItem: checkpointContent.outputItem } : {})
      };
    }
    if (identity.completedResponseStreamSeq === undefined || identity.providerResponseId === undefined) {
      throw new Error(
        `Synchronous native ToolCall ${entry.toolCallId} requires completedResponseStreamSeq and providerResponseId; sync calls never admit at item completion.`
      );
    }
    if (checkpointContent.responseId !== identity.providerResponseId) {
      throw new Error(
        `Native call item ${checkpointId} belongs to provider response ${checkpointContent.responseId}, not ${identity.providerResponseId}.`
      );
    }
    const boundarySeq = BigInt(identity.completedResponseStreamSeq);
    if (boundarySeq <= itemSeq) {
      throw new Error('Native sync admission boundary must follow the complete call item checkpoint.');
    }
    const boundary = checkpoints.find((row) =>
      row.checkpoint_kind === 'native_control'
      && requireBigInt(row.stream_seq, 'ModelStreamCheckpoint.stream_seq') === boundarySeq
    );
    if (!boundary) {
      throw new Error(
        `ModelRequest ${modelRequestId} has no native response boundary checkpoint at stream_seq ${identity.completedResponseStreamSeq}.`
      );
    }
    const boundaryContent = parseNativeControlCheckpoint(await this.readCheckpointContent(boundary));
    if (!isNativeAdmissionBoundary(boundaryContent)) {
      throw new Error(
        `Native control checkpoint ${String(boundary.id)} (${boundaryContent.type}${boundaryContent.reason ? `/${boundaryContent.reason}` : ''}) is not an admission boundary for synchronous calls.`
      );
    }
    if (boundaryContent.responseId !== identity.providerResponseId) {
      throw new Error('Native sync admission boundary belongs to another provider response.');
    }
    return {
      checkpointId,
      responseId: checkpointContent.responseId,
      declaredAsync: false,
      ...(checkpointContent.outputItem ? { outputItem: checkpointContent.outputItem } : {})
    };
  }

  private async readCheckpointContent(checkpoint: DomainRow): Promise<unknown> {
    const metadata = await this.requireContentObject(
      requireId(checkpoint.content_object_id, 'ModelStreamCheckpoint.content_object_id')
    );
    const envelope = plainRecord(JSON.parse((await this.contentStore.read(metadata)).toString('utf8')));
    if (!envelope || envelope.kind !== checkpoint.checkpoint_kind
      || envelope.streamSeq !== String(checkpoint.stream_seq)) {
      throw new TypeError(`Native checkpoint ${String(checkpoint.id)} has an invalid envelope identity.`);
    }
    return envelope.content;
  }

  /**
   * Proves the actual server admission behind one result delivery: the carrier ModelRequest owns a
   * persisted native_control response.created checkpoint for the delivered provider response that
   * names the original provider call id in admittedToolResultCallIds. Without it the delivery is
   * unverified and must stay unmarked (recovery retains it for the closure path instead).
   */
  private async requireNativeAdmissionCreatedProof(
    carrierModelRequestId: string,
    providerCallId: string,
    providerResponseId: string
  ): Promise<void> {
    const checkpoints = (await listAllDomainRows(this.database, 'ModelStreamCheckpoint', {
      model_request_id: carrierModelRequestId
    })).filter((row) => row.checkpoint_kind === 'native_control');
    for (const checkpoint of checkpoints) {
      const content = parseNativeControlCheckpoint(await this.readCheckpointContent(checkpoint));
      if (content.type !== 'response.created' || content.responseId !== providerResponseId) continue;
      if ((content.admittedToolResultCallIds ?? []).includes(providerCallId)) return;
    }
    throw new Error(
      `Carrier ModelRequest ${carrierModelRequestId} has no durable response.created admission for ${providerResponseId} naming provider call ${providerCallId}; the delivery is unverified.`
    );
  }

  private async requireContentObject(id: string): Promise<ContentObjectMetadata> {
    return await this.requireExisting('ContentObject', id) as ContentObjectMetadata;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const result = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = result.snapshot[0];
    if (!row || Array.isArray(row)) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const result = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })
    ]);
    const value = result.snapshot[0];
    if (!Array.isArray(value)) throw new TypeError(`${domain} list did not return rows.`);
    return value;
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

function requireSnapshotRow(
  value: DomainRow | DomainRow[] | null | undefined,
  domain: string,
  id: string
): DomainRow {
  if (!value || Array.isArray(value) || value.id !== id) {
    throw new Error(`${domain} ${id} does not exist.`);
  }
  return value;
}

function requireSnapshotRows(
  value: DomainRow | DomainRow[] | null | undefined,
  domain: string
): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError(`${domain} list did not return rows.`);
  return value;
}

function assertSingleToolExecution(toolCallId: string, executions: readonly DomainRow[]): void {
  if (executions.length !== 1) {
    throw new Error(`ToolCall ${toolCallId} must have exactly one ToolExecution.`);
  }
  if (executions[0].tool_call_id !== toolCallId) {
    throw new Error(`ToolCall ${toolCallId} ToolExecution relationship is inconsistent.`);
  }
}

function assertExecutionLeaseIdentity(lease: DomainRow, fence: ExecutionLeaseFence): void {
  if (
    lease.id !== fence.id
    || lease.conversation_id !== fence.conversationId
    || lease.turn_id !== fence.turnId
    || lease.owner_id !== fence.ownerId
    || lease.host_boot_id !== fence.hostBootId
    || lease.generation !== fence.generation
  ) {
    throw new Error(`ExecutionLease ${fence.id} no longer matches its captured generation identity.`);
  }
}

export function stablePhaseDId(kind: string, scope: string): string {
  const normalizedKind = requireText(kind, 'stable id kind').toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const digest = createHash('sha256')
    .update('limcode-phase-d-entity\0')
    .update(normalizedKind)
    .update('\0')
    .update(requireText(scope, 'stable id scope'))
    .digest('hex');
  return `${normalizedKind}_${digest}`;
}

export function preparedContentSteps(
  prepared: readonly PreparedContentObject[],
  prefix: string
): RepositoryTransactionStep[] {
  const unique = new Map(prepared.map((entry) => [entry.metadata.id, entry]));
  const steps: RepositoryTransactionStep[] = [];
  let index = 0;
  for (const content of unique.values()) {
    if (content.insert) {
      steps.push(savepoint(`${safeSavepointPrefix(prefix)}_${index++}`, [content.insert], {
        kind: 'rollback-and-continue-on-unique',
        constraints: [
          { domain: 'ContentObject', columns: ['id'] },
          { domain: 'ContentObject', columns: ['content_type', 'sha256', 'byte_length'] }
        ]
      }));
    }
    steps.push(DOMAIN_REPOSITORIES.domain('ContentObject').assert(content.metadata.id, {
      content_type: content.metadata.content_type,
      sha256: content.metadata.sha256,
      byte_length: content.metadata.byte_length,
      storage_key: content.metadata.storage_key
    }));
  }
  return steps;
}

export function effectIds(
  toolCallId: string,
  ownerKind: string,
  ownerId: string,
  effectKind: PhaseDEffectKind
): { operationId: string; attemptId: string; effectIntentId: string } {
  const scope = JSON.stringify([toolCallId, ownerKind, ownerId, effectKind]);
  const operationId = stablePhaseDId('operation', scope);
  const attemptId = stablePhaseDId('attempt', `${operationId}:1`);
  return {
    operationId,
    attemptId,
    effectIntentId: stablePhaseDId('effect_intent', attemptId)
  };
}

function terminalIds(toolCallId: string): {
  toolOutcomeId: string;
  toolModelResultId: string;
  messageId: string;
  messageRevisionId: string;
  currentRevisionLinkId: string;
  messageConversationLinkId: string;
  messageTurnLinkId: string;
} {
  return {
    toolOutcomeId: stablePhaseDId('tool_outcome', toolCallId),
    toolModelResultId: stablePhaseDId('tool_model_result', toolCallId),
    messageId: stablePhaseDId('message', `tool-result:${toolCallId}`),
    messageRevisionId: stablePhaseDId('message_revision', `tool-result:${toolCallId}`),
    currentRevisionLinkId: stablePhaseDId('message_current_revision_link', `tool-result:${toolCallId}`),
    messageConversationLinkId: stablePhaseDId('message_conversation_link', `tool-result:${toolCallId}`),
    messageTurnLinkId: stablePhaseDId('message_turn_link', `tool-result:${toolCallId}`)
  };
}

function normalizeToolCallBatchEntry(entry: ToolCallBatchEntry, index: number): ToolCallBatchEntry {
  if (!entry || typeof entry !== 'object') throw new TypeError(`ToolCall batch entry ${index} must be an object.`);
  return {
    toolCallId: requireId(entry.toolCallId, `ToolCall batch entry ${index}.toolCallId`),
    toolName: requireText(entry.toolName, `ToolCall batch entry ${index}.toolName`),
    arguments: entry.arguments,
    ...(entry.providerCallId ? {
      providerCallId: requireId(entry.providerCallId, `ToolCall batch entry ${index}.providerCallId`)
    } : {}),
    providerOrdinal: requireNonNegativeSafeInteger(
      entry.providerOrdinal,
      `ToolCall batch entry ${index}.providerOrdinal`
    ),
    ...(entry.thoughtSignature ? {
      thoughtSignature: requireText(entry.thoughtSignature, `ToolCall batch entry ${index}.thoughtSignature`)
    } : {}),
    policy: normalizeFrozenToolPolicy(entry.policy, index)
  };
}

function normalizeFrozenToolPolicy(
  policy: FrozenToolCallPolicyDecision,
  index: number
): FrozenToolCallPolicyDecision {
  if (!policy || typeof policy !== 'object') throw new TypeError(`ToolCall batch entry ${index}.policy must be an object.`);
  if (!['automatic', 'approval_required'].includes(policy.executionGate)) {
    throw new TypeError(`ToolCall batch entry ${index}.policy.executionGate is invalid.`);
  }
  if (!['automatic', 'manual', 'unsupported'].includes(policy.changeApplyMode)) {
    throw new TypeError(`ToolCall batch entry ${index}.policy.changeApplyMode is invalid.`);
  }
  if (!['parallel', 'serial'].includes(policy.schedulingMode)) {
    throw new TypeError(`ToolCall batch entry ${index}.policy.schedulingMode is invalid.`);
  }
  const delay = requireNonNegativeSafeInteger(
    policy.changeApplyDelaySeconds,
    `ToolCall batch entry ${index}.policy.changeApplyDelaySeconds`
  );
  if (delay > 600) throw new TypeError('ToolCall change-apply delay cannot exceed 600 seconds.');
  if (policy.changeApplyMode !== 'automatic' && delay !== 0) {
    throw new TypeError('Only automatic change apply may carry a non-zero delay.');
  }
  return {
    ...(policy.summary ? { summary: requireText(policy.summary, `ToolCall batch entry ${index}.policy.summary`) } : {}),
    displayAutoExpand: policy.displayAutoExpand === true,
    displayAutoOpenDiff: policy.displayAutoOpenDiff === true,
    executionGate: policy.executionGate,
    changeApplyMode: policy.changeApplyMode,
    changeApplyDelaySeconds: delay,
    autoSubmitResult: policy.autoSubmitResult === true,
    schedulingMode: policy.schedulingMode,
    ...(policy.schedulingReason ? {
      schedulingReason: requireText(policy.schedulingReason, `ToolCall batch entry ${index}.policy.schedulingReason`)
    } : {})
  };
}

function assertUniqueBatchEntries(entries: readonly ToolCallBatchEntry[]): void {
  const ids = new Set<string>();
  const providerIds = new Set<string>();
  const ordinals = new Set<number>();
  for (const entry of entries) {
    if (ids.has(entry.toolCallId)) throw new Error(`ToolCall batch repeats id ${entry.toolCallId}.`);
    ids.add(entry.toolCallId);
    if (entry.providerCallId) {
      if (providerIds.has(entry.providerCallId)) {
        throw new Error(`ToolCall batch repeats Provider call id ${entry.providerCallId}.`);
      }
      providerIds.add(entry.providerCallId);
    }
    if (ordinals.has(entry.providerOrdinal)) {
      throw new Error(`ToolCall batch repeats Provider ordinal ${entry.providerOrdinal}.`);
    }
    ordinals.add(entry.providerOrdinal);
  }
}

function assertFrozenPolicyRow(
  row: DomainRow,
  policy: FrozenToolCallPolicyDecision,
  toolCallId: string
): void {
  if (
    row.summary !== (policy.summary ?? null)
    || row.display_auto_expand !== (policy.displayAutoExpand ? 1n : 0n)
    || row.display_auto_open_diff !== (policy.displayAutoOpenDiff ? 1n : 0n)
    || row.execution_gate !== policy.executionGate
    || row.change_apply_mode !== policy.changeApplyMode
    || row.change_apply_delay_seconds !== BigInt(policy.changeApplyDelaySeconds)
    || row.auto_submit_result !== (policy.autoSubmitResult ? 1n : 0n)
    || row.scheduling_mode !== policy.schedulingMode
    || row.scheduling_reason !== (policy.schedulingReason ?? null)
  ) throw new Error(`ToolCallPolicySnapshot replay conflicts for ${toolCallId}.`);
}

function requireToolCallEventKind(value: unknown): 'stdout' | 'stderr' | 'progress' {
  if (!['stdout', 'stderr', 'progress'].includes(String(value))) {
    throw new TypeError(`Unsupported ToolCallEvent kind: ${String(value)}.`);
  }
  return value as 'stdout' | 'stderr' | 'progress';
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function aggregateOperationOutcomes(statuses: ToolOutcomeStatus[]): ToolOutcomeStatus {
  if (statuses.includes('conflict')) return 'conflict';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('outcome_unknown')) return 'outcome_unknown';
  if (statuses.includes('partial')) return 'partial';
  if (statuses.includes('cancelled')) return 'cancelled';
  return 'succeeded';
}

function normalizeSource(
  source: PhaseDCommandSource,
  allowed: readonly PhaseDSourceKind[],
  operation: string
): PhaseDCommandSource {
  if (!source || !allowed.includes(source.kind)) {
    throw new TypeError(`${operation} source kind must be one of: ${allowed.join(', ')}.`);
  }
  return { kind: source.kind, key: requireText(source.key, `${operation} source key`) };
}

function sourceReceiptId(source: PhaseDCommandSource, operation: string, scope: string): string {
  return stablePhaseDId('command_receipt', JSON.stringify([source.kind, source.key, operation, scope]));
}

function assertSourceReceipt(receipt: DomainRow, expectedId: string, operation: string): void {
  if (receipt.id !== expectedId) {
    throw new Error(`CommandReceipt (${String(receipt.source_kind)},${String(receipt.source_key)}) does not contain ${operation} result facts.`);
  }
}

function withoutSteps(plan: ToolTerminalPlan): ToolTerminalResult {
  const { steps: _steps, ...result } = plan;
  return result;
}

function allocatedValue(
  commit: CommandCommit,
  domain: string,
  id: string,
  column: string
): string {
  const entry = commit.allocatedSequences.find((candidate) =>
    candidate.domain === domain && candidate.id === id && candidate.column === column
  );
  if (!entry) throw new Error(`${domain} ${id} did not allocate ${column}.`);
  return requireDecimalString(entry.value, `${domain}.${column}`);
}

function requireEffectKind(value: PhaseDEffectKind): PhaseDEffectKind {
  if (!EFFECT_KINDS.includes(value)) throw new TypeError(`Unsupported Effect kind: ${String(value)}`);
  return value;
}

function requireObservedOutcome(value: EffectObservedOutcome): EffectObservedOutcome {
  if (!['succeeded', 'failed', 'cancelled', 'conflict', 'outcome_unknown'].includes(value)) {
    throw new TypeError(`Unsupported EffectReceipt outcome: ${String(value)}`);
  }
  return value;
}

function requireOperationOutcome(value: ToolOutcomeStatus): ToolOutcomeStatus {
  if (!TERMINAL_OPERATION_STATUSES.includes(value) || value === 'rejected') {
    throw new TypeError(`Unsupported Operation outcome: ${String(value)}`);
  }
  return value;
}

function requireToolOutcome(value: unknown): ToolOutcomeStatus {
  if (typeof value !== 'string' || !TERMINAL_OPERATION_STATUSES.includes(value as ToolOutcomeStatus)) {
    throw new TypeError(`Unsupported ToolOutcome status: ${String(value)}`);
  }
  return value as ToolOutcomeStatus;
}

function isTerminalOperationStatus(value: unknown): value is ToolOutcomeStatus {
  return typeof value === 'string' && TERMINAL_OPERATION_STATUSES.includes(value as ToolOutcomeStatus);
}

export function matchesExpectedUnique(
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

function safeSavepointPrefix(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').slice(0, 40);
  return normalized || 'content';
}

function hoistOperationAttachmentParts(
  operations: Array<Record<string, unknown>>
): { operations: Array<Record<string, unknown>>; parts?: InlineDataPart[] } {
  const parts: InlineDataPart[] = [];
  const normalized = operations.map((operation) => {
    const detail = plainRecord(operation.detail);
    if (!detail || !Array.isArray(detail.parts)) return operation;
    const attachmentParts = detail.parts.filter(isInlineDataPart);
    if (attachmentParts.length === 0) return operation;
    parts.push(...attachmentParts);
    const remaining = detail.parts.filter((part) => !isInlineDataPart(part));
    const { parts: _parts, ...detailWithoutParts } = detail;
    return {
      ...operation,
      detail: remaining.length > 0
        ? { ...detailWithoutParts, parts: remaining }
        : detailWithoutParts
    };
  });
  return {
    operations: normalized,
    ...(parts.length > 0 ? { parts } : {})
  };
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isInlineDataPart(value: unknown): value is InlineDataPart {
  const record = plainRecord(value);
  const inlineData = plainRecord(record?.inlineData);
  return !!inlineData
    && typeof inlineData.mimeType === 'string'
    && (
      typeof inlineData.attachmentId === 'string'
      || typeof inlineData.data === 'string'
      || typeof inlineData.sourcePath === 'string'
    );
}

function compareBigInt(left: unknown, right: unknown): number {
  const leftValue = requireBigInt(left, 'sequence');
  const rightValue = requireBigInt(right, 'sequence');
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function effectDispatchFence(facts: ToolFacts): EffectDispatchFence {
  return {
    executionLeaseId: requireId(facts.lease.id, 'ExecutionLease.id'),
    conversationId: requireId(facts.conversation.id, 'Conversation.id'),
    turnId: requireId(facts.turn.id, 'Turn.id'),
    ownerId: requireId(facts.lease.owner_id, 'ExecutionLease.owner_id'),
    hostBootId: requireId(facts.lease.host_boot_id, 'ExecutionLease.host_boot_id'),
    generation: requireBigInt(facts.lease.generation, 'ExecutionLease.generation').toString(),
    expiresAt: requireText(facts.lease.expires_at, 'ExecutionLease.expires_at')
  };
}

function isEffectDispatchRequestEnvelope(value: unknown): value is EffectDispatchRequestEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (envelope.kind !== 'limcode-effect-dispatch-request') return false;
  const fence = envelope.dispatchFence;
  if (!fence || typeof fence !== 'object' || Array.isArray(fence)) return false;
  const record = fence as Record<string, unknown>;
  return [
    record.executionLeaseId,
    record.conversationId,
    record.turnId,
    record.ownerId,
    record.hostBootId,
    record.expiresAt
  ].every((entry) => typeof entry === 'string' && entry.length > 0)
    && typeof record.generation === 'string'
    && /^[1-9]\d*$/.test(record.generation);
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${label} must remain bigint in JavaScript.`);
  return value;
}

function requireDecimalString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string on the wire.`);
  }
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value;
}

function isTransactionAssertionError(error: unknown): boolean {
  return (error as { code?: unknown })?.code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}
