import { createHash } from 'node:crypto';
import type {
  OpenAIResponsesNativeCapabilities,
  OpenAIResponsesNativeEvent,
  OpenAIResponsesToolOutput,
  OpenAIResponsesRequiredInput,
  OpenAIResponsesSteeringState
} from '../../shared/openAIResponsesNative';
import {
  isOpenAIResponsesNativeDeliveryError,
  type OpenAIResponsesNativeController,
  type OpenAIResponsesNativeHooks
} from '../capabilities/openAIResponsesNativeControl';
import { SKILLS_TOOL_NAME, type ModelOutputItemReference, type ModelResponseTiming } from '../../shared/protocol';
import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { freezeNativeChildToolProjection, readNativeRequestChildHandles, withChildHandles } from './conversationChildHandles';
import { isCollaborationHandleTool, normalizeModelHandleCatalog, projectToolResultForModel, type ModelHandleCatalog } from './modelHandleCatalog';
import { projectToolResultBatch, readModelTextToolResponse } from './modelFacingContextProjection';
import { ContextSequenceControlPlane } from './contextSequence';
import { nativePhysicalResponseBudgetPressure, type NativeLogicalRequestBudget } from './nativeCompressionGuard';
import {
  EffectControlPlane,
  type FrozenToolCallPolicyDecision,
  type ToolTerminalResult
} from './effectControlPlane';
import {
  currentExecutionLeaseFence,
  isExecutionHandoffError,
  runWithExecutionLeaseFence,
  type ExecutionLeaseFence
} from './executionLeaseFence';
import {
  isNativeAdmissionBoundary,
  parseNativeControlCheckpoint,
  parseNativeToolCallCheckpoint,
  type NativeToolCallStreamIdentity
} from './nativeToolFacts';
import type {
  ModelProviderControlPlane,
  NativeSteerCommand,
  NativeSteeringReceipt,
  ProviderOutputStreamEvent,
  StreamEventResult
} from './modelProviderControlPlane';
import { canonicalPlainJson, normalizePlainJson, type PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';
import { assistantMessageIdFor, nativeItemRevisionId, TurnOutputControlPlane } from './turnOutput';
import type {
  ReliableAgentToolDefinition,
  ReliableAgentToolDispatchInput,
  ReliableAgentToolDispatcher,
  ReliableAgentToolPause,
  ReliableAgentToolSettled
} from './agentLoop';

const MESSAGE_CONTENT_TYPE = 'application/vnd.limcode.message+json';

/** Parsed 'tool_calls' output_item_done envelope (exact NativeProvider adapter shape). */
export interface NativeCallItemEnvelope {
  outputItem?: ModelOutputItemReference;
  call: {
    id: string;
    ordinal: number;
    name: string;
    arguments: PlainJsonValue;
    thoughtSignature?: string;
    async?: boolean;
  };
}

interface NativeSessionCall {
  toolCallId: string;
  providerCallId: string;
  name: string;
  arguments: PlainJsonValue;
  providerOrdinal: number;
  responseId: string;
  itemSeq: string;
  thoughtSignature?: string;
  asyncDeclared: boolean;
  admitted: boolean;
  settled: boolean;
  toolModelResultId?: string;
  resultOccurrence: boolean;
  delivered: boolean;
}

interface NativeSessionResponse {
  responseId: string;
  previousResponseId?: string;
  boundarySeq?: string;
  boundaryReason?: string;
  admissionBoundary: boolean;
  /** Only a real completed response is a safe logical-request checkpoint (not a steered incomplete). */
  completed: boolean;
  syncRequired: boolean;
}

export interface NativeRequestSessionDeps {
  database: RuntimeDatabase;
  contentStore: ContentAddressedStore;
  context: ContextSequenceControlPlane;
  turnOutput: TurnOutputControlPlane;
  effects: EffectControlPlane;
  tools: ReliableAgentToolDispatcher;
  modelProvider: ModelProviderControlPlane;
  conversationId: string;
  turnId: string;
  modelRequestId: string;
  providerId: string;
  modelId: string;
  capabilities: OpenAIResponsesNativeCapabilities;
  budget: NativeLogicalRequestBudget;
  /** Root frozen in the original request; not proof that any subsequent native wire input covers it. */
  initialContextRootId: string;
  /** Immutable initial recipe catalog; committed native tool projections extend its child identities. */
  modelHandleCatalog?: ModelHandleCatalog;
  resolveAdapter: (providerId: string) => Promise<{
    providerId: string;
    materializeNativeToolOutput?(
      outputs: readonly OpenAIResponsesToolOutput[]
    ): Promise<readonly OpenAIResponsesToolOutput[]>;
  }>;
  resolveDefinition: (name: string) => ReliableAgentToolDefinition;
  /** Model-handle argument resolution against the frozen recipe catalog (attachment references). */
  resolveCallArguments: (
    name: string,
    argumentsValue: PlainJsonValue
  ) => { arguments: PlainJsonValue; error?: string };
  freezePolicies: (
    inputs: ReadonlyArray<ReliableAgentToolDispatchInput & { definition: ReliableAgentToolDefinition }>
  ) => Promise<FrozenToolCallPolicyDecision[]>;
  dispatchCall: (
    input: ReliableAgentToolDispatchInput
  ) => Promise<ToolTerminalResult | ReliableAgentToolPause | ReliableAgentToolSettled>;
  /** Deterministic ToolCall identity identical to the terminal batch replay. */
  toolCallIdFor: (providerOrdinal: number, providerCallId: string, name: string) => string;
  /** Cancels one admitted call's pending effects and settles a cancelled result (chain abandoned). */
  closeAdmittedCall: (toolCallId: string, sourceKey: string) => Promise<void>;
  now: () => string;
  onDiagnostic?: (message: string) => void;
}

/**
 * Per-logical-request Astra native orchestration. Durable admissions happen inside the serialized
 * onEvent tail; tool execution, result delivery and steering sends always run outside it. The
 * session is transport-agnostic: it consumes the single controller contract on WS and HTTP and
 * fences every mutation with the ExecutionLeaseFence captured at controller registration (falling
 * back to the one captured at session creation), never adopting a replacement owner.
 */
export class NativeRequestSession {
  private controller?: OpenAIResponsesNativeController;
  private controllerFence?: ExecutionLeaseFence;
  private readonly creationFence?: ExecutionLeaseFence;
  private unregisterSteering?: () => void;
  private unsubscribeSettlements?: () => void;
  private stream?: { attemptSeq: string; socketGeneration: string };
  /** Latest Attempt that produced durable stream facts, reconstructed by reconcile(). */
  private durableAttemptSeq?: string;
  private readonly calls = new Map<string, NativeSessionCall>();
  private readonly callByProviderId = new Map<string, NativeSessionCall>();
  /** Global ordinals live on SourceLinks beyond bounded proofs or a new socket generation. */
  private readonly durableCallOrdinals = new Map<string, { toolCallId: string; providerOrdinal: number }>();
  private readonly responses = new Map<string, NativeSessionResponse>();
  private readonly responseOrder: string[] = [];
  private readonly itemAccumulators = new Map<string, { text: string; thought: string; thoughtSignature?: string }>();
  /**
   * Chain-ordered real item parts (observation order == chain/aggregate order). Keys are
   * response-scoped because provider output ordinals are response-local; re-stream replays dedupe
   * by key. The durable current projection is their aggregate.
   */
  private readonly itemPartsOrdered: Array<{ key: string; part: Record<string, unknown> }> = [];
  private readonly itemPartKeys = new Set<string>();
  /** Per-socket-generation call counts by response; reset on every new durable stream generation. */
  private readonly responseCallCounts = new Map<string, number>();
  private readonly steerReceipts = new Map<string, NativeSteeringReceipt>();
  /** Per-submission serialization of durable receipt writes (see transitionSteer). */
  private readonly steerTails = new Map<string, Promise<void>>();
  private firstResponseId?: string;
  private firstResponseLost = false;
  private pumpRunning = false;
  private pumpDirty = false;
  private readonly inFlightDeliveries = new Set<string>();
  /** Wire-written but unacknowledged results must never be auto-resubmitted on this chain. */
  private readonly uncertainResultCalls = new Set<string>();
  private unsafeResultAdmission?: Error;
  /** No further create fits the physical budget: end the chain once admitted work settles. */
  private budgetClosureRequested = false;
  private disposed = false;
  private yieldingForRuntimeInput = false;
  private preparingCheckpoint = false;
  private lastBackpressureResponseId?: string;
  private childCatalog: ModelHandleCatalog;
  private readonly callResolutions = new Map<string, {
    arguments: PlainJsonValue;
    error?: string;
    catalog: ModelHandleCatalog;
    /** Original provider arguments of the frozen proof; replay identity, never re-resolved. */
    original?: PlainJsonValue;
  }>();

  public constructor(private readonly deps: NativeRequestSessionDeps) {
    this.childCatalog = normalizeModelHandleCatalog(deps.modelHandleCatalog);
    this.creationFence = currentExecutionLeaseFence();
    this.unsubscribeSettlements = deps.tools.subscribeToolSettlements?.(
      { turnId: deps.turnId },
      (event) => {
        const fence = this.activeFence();
        if (!fence || this.disposed) return;
        void runWithExecutionLeaseFence(fence, () => this.onSettlement(event.toolCallId))
          .catch((error) => this.diagnose(`native settlement handling failed: ${errorMessage(error)}`));
      }
    );
  }

  public currentModelHandleCatalog(): ModelHandleCatalog {
    return normalizeModelHandleCatalog(this.childCatalog);
  }

  /**
   * The physical chain can no longer carry a result create: a result may already have been
   * admitted without proof. The chain ends once every admitted effect settles; the Turn continues
   * with a fresh full request from Context instead of resubmitting into this chain.
   */
  public unsafeResultAdmissionError(): Error | undefined {
    return this.unsafeResultAdmission;
  }

  /**
   * True once this logical request has durable chain progress: a streamed item revision or a
   * checkpointed call. Its frozen input no longer describes the conversation, so a new Host must
   * not replay it (the model would redo admitted tools and duplicate items); it closes the chain.
   */
  public hasDurableChainProgress(): boolean {
    return this.calls.size > 0 || this.itemPartsOrdered.length > 0
      // A steering Message applied to Context belongs to this chain's successor, not its input.
      || [...this.steerReceipts.values()].some(receipt =>
        receipt.modelRequestId === this.deps.modelRequestId
        && (receipt.state === 'continuing' || receipt.state === 'completed'));
  }

  /** Admitted calls whose external effect has not settled yet (a restarted Host must wait for them). */
  public unsettledAdmittedCallIds(): string[] {
    return [...this.calls.values()].filter(call => call.admitted && !call.settled).map(call => call.toolCallId);
  }

  /** Rebuilds in-memory orchestration state from durable facts after a crash/reconnect. */
  public async reconcile(): Promise<void> {
    this.childCatalog = withChildHandles(this.childCatalog,
      await readNativeRequestChildHandles(this.deps.database, this.deps.contentStore, this.deps.modelRequestId));
    const previouslyObserved = await this.deps.modelProvider.readNativeLatestResponseUsage(this.deps.modelRequestId);
    // Terminal checkpoints can be compacted/pruned. If the first response is no longer
    // represented, the earliest surviving response.created cannot calibrate its initial root.
    this.firstResponseLost = (previouslyObserved?.physicalResponseCount ?? 0) > 1;
    if (previouslyObserved?.physicalResponseCount === 1) this.firstResponseId = previouslyObserved.responseId;
    const sourceLinks = (await listAllDomainRows(this.deps.database, 'ToolCallSourceLink', {
      model_request_id: this.deps.modelRequestId
    })).sort((left, right) => {
      const a = BigInt(String(left.provider_ordinal));
      const b = BigInt(String(right.provider_ordinal));
      return a < b ? -1 : a > b ? 1 : 0;
    });
    for (const source of sourceLinks) {
      const providerCallId = typeof source.provider_call_id === 'string' ? source.provider_call_id : undefined;
      if (!providerCallId) continue;
      const toolCallId = requireId(source.tool_call_id, 'ToolCallSourceLink.tool_call_id');
      const providerOrdinal = Number(source.provider_ordinal);
      if (!Number.isSafeInteger(providerOrdinal) || providerOrdinal < 0) {
        throw new Error(`Native ToolCallSourceLink ${String(source.id)} has an invalid provider ordinal.`);
      }
      const old = this.durableCallOrdinals.get(providerCallId);
      if (old && (old.toolCallId !== toolCallId || old.providerOrdinal !== providerOrdinal)) {
        throw new Error(`Native provider call ${providerCallId} has conflicting durable identities.`);
      }
      this.durableCallOrdinals.set(providerCallId, { toolCallId, providerOrdinal });
      const admission = await this.deps.effects.readNativeAdmission(toolCallId);
      if (!admission) continue;
      if (admission.providerCallId !== providerCallId) {
        throw new Error(`Native admission for ${toolCallId} disagrees with ToolCallSourceLink.`);
      }
      if (this.durableAttemptSeq === undefined || BigInt(admission.attemptSeq) > BigInt(this.durableAttemptSeq)) {
        this.durableAttemptSeq = admission.attemptSeq;
      }
      const toolCall = await this.requireDomain('ToolCall', toolCallId);
      const metadata = await this.requireDomain('ContentObject',
        requireId(toolCall.arguments_object_id, 'ToolCall.arguments_object_id')) as unknown as ContentObjectMetadata;
      const argumentsValue = normalizePlainJson(JSON.parse((await this.deps.contentStore.read(metadata)).toString('utf8')),
        'Durable native tool arguments');
      this.callResolutions.set(providerCallId, { arguments: argumentsValue, catalog: this.currentModelHandleCatalog() });
      const call: NativeSessionCall = {
        toolCallId, providerCallId, providerOrdinal, responseId: admission.responseId,
        name: requireId(toolCall.tool_name, 'ToolCall.tool_name'), arguments: argumentsValue,
        itemSeq: admission.streamSeq, asyncDeclared: admission.declaredAsync,
        admitted: true, settled: false, resultOccurrence: false, delivered: false
      };
      this.calls.set(toolCallId, call);
      this.callByProviderId.set(providerCallId, call);
      this.responseFor(admission.responseId);
    }
    const checkpoints = (await listAllDomainRows(this.deps.database, 'ModelStreamCheckpoint', {
      model_request_id: this.deps.modelRequestId
    })).sort((left, right) => {
      for (const key of ['attempt_seq', 'socket_generation', 'stream_seq']) {
        const a = BigInt(String(left[key]));
        const b = BigInt(String(right[key]));
        if (a !== b) return a < b ? -1 : 1;
      }
      return 0;
    });
    const checkpointCreatedOrder: string[] = [];
    const contentRows = new Map<string, DomainRow>();
    for (const checkpoint of checkpoints) {
      const attemptSeq = String(checkpoint.attempt_seq);
      if (this.durableAttemptSeq === undefined || BigInt(attemptSeq) > BigInt(this.durableAttemptSeq)) {
        this.durableAttemptSeq = attemptSeq;
      }
      const kind = String(checkpoint.checkpoint_kind);
      if (kind !== 'native_tool_call' && kind !== 'native_control') continue;
      const contentObjectId = requireId(checkpoint.content_object_id, 'ModelStreamCheckpoint.content_object_id');
      const metadata = contentRows.get(contentObjectId)
        ?? await this.requireDomain('ContentObject', contentObjectId);
      contentRows.set(contentObjectId, metadata);
      const value = normalizePlainJson(
        JSON.parse((await this.deps.contentStore.read(metadata as unknown as ContentObjectMetadata)).toString('utf8')),
        'Native stream checkpoint'
      );
      const envelope = asRecord(value);
      const content = asRecord(envelope?.content);
      if (!content) throw new Error(`Native stream checkpoint ${String(checkpoint.id)} has no content.`);
      if (kind === 'native_tool_call') {
        const proof = parseNativeToolCallCheckpoint(content);
        this.callResolutions.set(proof.providerCallId, {
          arguments: normalizePlainJson(proof.resolvedArguments, 'Frozen native resolved arguments'),
          catalog: proof.modelHandleCatalog,
          original: normalizePlainJson(proof.arguments, 'Frozen native provider arguments'),
          ...(proof.argumentResolutionError !== undefined ? { error: proof.argumentResolutionError } : {})
        });
        const toolCallId = this.deps.toolCallIdFor(proof.providerOrdinal, proof.providerCallId, proof.toolName);
        if (!this.calls.has(toolCallId)) {
          const call: NativeSessionCall = {
            toolCallId,
            providerCallId: proof.providerCallId,
            name: proof.toolName,
            arguments: normalizePlainJson(proof.arguments, 'Native call proof arguments'),
            providerOrdinal: proof.providerOrdinal,
            responseId: proof.responseId,
            itemSeq: String(checkpoint.stream_seq),
            asyncDeclared: proof.async === true,
            admitted: false,
            settled: false,
            resultOccurrence: false,
            delivered: false
          };
          this.calls.set(toolCallId, call);
          this.callByProviderId.set(call.providerCallId, call);
          this.responseFor(call.responseId);
        }
      } else {
        const control = parseNativeControlCheckpoint(content);
        if (control.type === 'response.created') {
          const unverifiedIds = nativeUnverifiedResultCallIds(content);
          if (unverifiedIds) {
            for (const providerCallId of unverifiedIds) {
              const call = this.callByProviderId.get(providerCallId);
              if (!call || !this.durableCallOrdinals.has(providerCallId)) {
                throw new Error(`Native unverified result ${providerCallId} has no durable admission identity.`);
              }
              this.uncertainResultCalls.add(call.toolCallId);
            }
            this.unsafeResultAdmission ??= nativeResultAdmissionUnknownError();
          }
          if (!checkpointCreatedOrder.includes(control.responseId)) checkpointCreatedOrder.push(control.responseId);
          this.responseFor(control.responseId);
          if (!this.firstResponseLost && !this.firstResponseId && !previouslyObserved
            && this.responseOrder.length === 1) this.firstResponseId = control.responseId;
        } else if (control.type === 'response.completed' || control.type === 'response.incomplete') {
          const response = this.responseFor(control.responseId);
          response.boundarySeq = String(checkpoint.stream_seq);
          response.boundaryReason = control.reason;
          response.completed = control.type === 'response.completed';
          response.admissionBoundary = isNativeAdmissionBoundary(control);
        }
      }
    }
    if (previouslyObserved?.previousResponseId) {
      // Restore attribution without changing the order reconstructed from durable stream facts.
      this.responseFor(previouslyObserved.responseId).previousResponseId = previouslyObserved.previousResponseId;
    }
    // SourceLinks may predate the bounded checkpoints. Within the surviving tail the accepted
    // response.created stream sequence, not a hashed row id or a SourceLink read, owns the order.
    const retainedCreated = new Set(checkpointCreatedOrder);
    this.responseOrder.splice(0, this.responseOrder.length,
      ...this.responseOrder.filter(id => !retainedCreated.has(id)), ...checkpointCreatedOrder);
    // Rebuild only deterministic item revisions; a cumulative/final revision may also contain
    // exactly one part and must never create a second occurrence during recovery.
    const message = await this.getOptional('Message', assistantMessageIdFor(this.deps.turnId, this.deps.modelRequestId));
    if (message) {
      const revisions = (await listAllDomainRows(this.deps.database, 'MessageRevision', {
        message_id: requireId(message.id, 'Message.id')
      })).sort((left, right) => {
        const a = BigInt(String(left.revision_seq)); const b = BigInt(String(right.revision_seq));
        return a < b ? -1 : a > b ? 1 : 0;
      });
      const rebuiltCallCounts = new Map<string, number>();
      for (const revision of revisions) {
        const metadata = await this.requireDomain(
          'ContentObject',
          requireId(revision.content_object_id, 'MessageRevision.content_object_id')
        ) as unknown as ContentObjectMetadata;
        const value = asRecord(normalizePlainJson(
          JSON.parse((await this.deps.contentStore.read(metadata)).toString('utf8')),
          'Native assistant revision'
        ));
        const parts = Array.isArray(value?.parts) ? value.parts : undefined;
        if (!parts || parts.length !== 1) continue;
        const part = asRecord(parts[0]);
        if (!part) continue;
        const outputItem = asRecord(part.outputItem);
        const responseId = typeof outputItem?.providerResponseId === 'string' && outputItem.providerResponseId.length > 0
          ? outputItem.providerResponseId
          : undefined;
        if (!responseId) continue;
        if (asRecord(part.functionCall)) {
          const localCallIndex = rebuiltCallCounts.get(responseId) ?? 0;
          const itemKey = `call:${responseId}:${localCallIndex}`;
          if (revision.id !== nativeItemRevisionId(this.deps.turnId, this.deps.modelRequestId, itemKey)) continue;
          rebuiltCallCounts.set(responseId, localCallIndex + 1);
          this.recordItemPart(itemKey, part);
        } else {
          const ordinal = typeof outputItem?.ordinal === 'number' && Number.isSafeInteger(outputItem.ordinal)
            ? outputItem.ordinal
            : undefined;
          if (ordinal === undefined) continue;
          const itemKey = `content:${responseId}:${ordinal}`;
          if (revision.id !== nativeItemRevisionId(this.deps.turnId, this.deps.modelRequestId, itemKey)) continue;
          this.recordItemPart(itemKey, part);
        }
      }
    }
    const pending = await this.deps.effects.listNativePendingWork({
      conversationId: this.deps.conversationId,
      turnId: this.deps.turnId,
      includeUndelivered: true
    });
    const pendingByCallId = new Map(pending.map((entry) => [entry.toolCallId, entry]));
    for (const call of this.calls.values()) {
      const admission = await this.deps.effects.readNativeAdmission(call.toolCallId);
      call.admitted = admission !== undefined;
      const pendingEntry = pendingByCallId.get(call.toolCallId);
      if (call.admitted && pendingEntry && pendingEntry.callContextSegmentId === undefined) {
        // A Host lost between the admission commit and its Context call occurrence. Repair the
        // occurrence now; otherwise no result occurrence could ever close this call.
        await this.deps.context.ensureNativeToolCall({
          conversationId: this.deps.conversationId,
          toolCallId: call.toolCallId,
          providerCallId: call.providerCallId
        });
      }
      if (pendingEntry) {
        call.settled = pendingEntry.settled;
        call.delivered = pendingEntry.delivered;
        call.resultOccurrence = pendingEntry.resultContextSegmentId !== undefined;
      } else if (call.admitted) {
        call.settled = true;
        call.delivered = true;
        call.resultOccurrence = true;
      }
      if (call.settled && !call.toolModelResultId) {
        const terminal = await this.deps.effects.readTerminalResult(call.toolCallId, false);
        call.toolModelResultId = terminal?.toolModelResultId;
      }
      // Schedule only after reconstructing all steering/result uncertainty. A Host takeover
      // discovering an unverified result must not launch more side effects before it refuses.
    }
    for (const receipt of await this.deps.modelProvider.nativeSteering.receiptsForTurn(this.deps.turnId)) {
      this.steerReceipts.set(receipt.submissionId, receipt);
    }
    // A Host may die after the tool result create reached the wire but before any correlated
    // response.created checkpoint was observed. Unresolved steering on this same request plus
    // an admitted undelivered tool result cannot prove it was never sent. Fail closed rather
    // than automatically re-submitting the result, even without a specific CAS marker.
    const ambiguousSteer = [...this.steerReceipts.values()].some(receipt =>
      receipt.modelRequestId === this.deps.modelRequestId
      && ['sent', 'accepted', 'waiting_for_input', 'delivery_unknown'].includes(receipt.state));
    if (ambiguousSteer) {
      for (const call of this.calls.values()) {
        if (call.admitted && !call.delivered) this.uncertainResultCalls.add(call.toolCallId);
      }
      if (this.uncertainResultCalls.size > 0) {
        this.unsafeResultAdmission ??= nativeResultAdmissionUnknownError();
      }
    }
    // A result settled before this Host boot may or may not have reached a result create. That is
    // not resolved here: AgentLoop never resumes a physical chain with durable progress after a
    // Host change (hasDurableChainProgress); it closes the chain locally and continues the Turn
    // with a fresh full request built from Context, where each result occurs exactly once.
    for (const call of this.calls.values()) {
      if (call.admitted && !call.settled) {
        // Even an unsafe provider admission must not discard a previously started tool. The
        // dispatcher reconciles its durable EffectIntent/Receipt without issuing it twice;
        // AgentLoop parks the Turn until all admitted external work has settled.
        this.scheduleExecution(call);
      }
    }
  }

  public hooks(): OpenAIResponsesNativeHooks {
    return {
      onController: (controller) => {
        if (controller) {
          this.controller = controller;
          // Capture the owner token once; every later callback/pump mutation reuses exactly it.
          this.controllerFence = currentExecutionLeaseFence() ?? this.creationFence;
          if (this.deps.capabilities.steering && this.controllerFence) {
            const fence = this.controllerFence;
            // A reconnect re-registers under the same ModelRequest; drop the stale handle first so
            // no obsolete registration can outlive its stream.
            this.unregisterSteering?.();
            this.unregisterSteering = this.deps.modelProvider.registerNativeSteeringSession({
              conversationId: this.deps.conversationId,
              turnId: this.deps.turnId,
              modelRequestId: this.deps.modelRequestId,
              fence,
              steer: (command) => this.steerCommand(command)
            });
          }
          this.pumpSignal();
          return;
        }
        this.controller = undefined;
        this.unregisterSteering?.();
        this.unregisterSteering = undefined;
      }
    };
  }

  /** Binds the durable stream identity of the current dispatch attempt/socket generation. */
  public bindStream(identity: { attemptSeq: string; socketGeneration: string }): void {
    const boundAttemptSeq = this.stream?.attemptSeq ?? this.durableAttemptSeq;
    if (boundAttemptSeq !== undefined && boundAttemptSeq !== identity.attemptSeq && this.hasDurableChainProgress()) {
      // A new Attempt re-sends the frozen input. After admitted calls or streamed items that input
      // no longer describes the conversation: the model would re-issue executed tools under new
      // identities. Such a chain is closed into Context and rebased, never replayed.
      throw new Error(
        `Native ModelRequest ${this.deps.modelRequestId} has durable chain progress; Attempt ${identity.attemptSeq} must not replay its frozen input.`
      );
    }
    if (
      this.stream
      && (this.stream.attemptSeq !== identity.attemptSeq || this.stream.socketGeneration !== identity.socketGeneration)
    ) {
      // A fresh decode pass restarts call ordinals for the new durable stream generation.
      this.responseCallCounts.clear();
    }
    this.stream = identity;
  }

  /**
   * Chain-global call ordinal. A durable ToolCallSourceLink outlives a pruned proof or a
   * socket-generation reset, so replayed provider IDs reuse that ordinal and genuinely new
   * calls start after the highest committed/proven call; response-local output ordinals never
   * become ToolCall identities.
   */
  private nextGlobalCallOrdinal(responseId: string, providerCallId: string): number {
    const known = this.durableCallOrdinals.get(providerCallId);
    if (known) {
      const call = this.calls.get(known.toolCallId);
      if (call && call.responseId !== responseId) {
        throw new Error(`Native provider call ${providerCallId} changed its response identity.`);
      }
      return known.providerOrdinal;
    }
    const live = this.callByProviderId.get(providerCallId);
    if (live) {
      if (live.responseId !== responseId) throw new Error(`Native provider call ${providerCallId} changed responses.`);
      return live.providerOrdinal;
    }
    // This generation's call count is not a global identity after a reconnect/pruned proof.
    let max = -1;
    for (const entry of this.durableCallOrdinals.values()) max = Math.max(max, entry.providerOrdinal);
    for (const call of this.calls.values()) max = Math.max(max, call.providerOrdinal);
    return max + 1;
  }

  private countCallItem(responseId: string): void {
    this.responseCallCounts.set(responseId, (this.responseCallCounts.get(responseId) ?? 0) + 1);
  }

  private recordItemPart(key: string, part: Record<string, unknown>): void {
    if (this.itemPartKeys.has(key)) return;
    this.itemPartKeys.add(key);
    this.itemPartsOrdered.push({ key, part });
  }

  /**
   * Parses a 'tool_calls' output_item_done envelope into its single call. Returns undefined for
   * any other item or a multi-call envelope (which stays on the ordinary checkpoint path and is
   * executed by the terminal batch, never admitted mid-chain).
   */
  public parseCallItem(content: PlainJsonValue): NativeCallItemEnvelope | undefined {
    const record = asRecord(content);
    if (!record || record.type !== 'tool_calls' || !Array.isArray(record.calls)) return undefined;
    if (record.calls.length !== 1) return undefined;
    const outputItem = asRecord(record.outputItem);
    const call = asRecord(record.calls[0]);
    if (!call) return undefined;
    const providerCallId = typeof call.id === 'string' && call.id.length > 0 ? call.id : undefined;
    const responseId = typeof outputItem?.providerResponseId === 'string' && outputItem.providerResponseId.length > 0
      ? outputItem.providerResponseId
      : undefined;
    const ordinal = typeof call.ordinal === 'number' && Number.isSafeInteger(call.ordinal) && call.ordinal >= 0
      ? call.ordinal
      : undefined;
    const name = typeof call.name === 'string' && call.name.trim().length > 0 ? call.name.trim() : undefined;
    if (!providerCallId || !responseId || ordinal === undefined || !name) return undefined;
    return {
      ...(outputItem
        ? {
            outputItem: {
              id: requireText(outputItem.id, 'tool_calls outputItem.id'),
              ordinal: typeof outputItem.ordinal === 'number' ? outputItem.ordinal : ordinal,
              ...(outputItem.phase === 'commentary' || outputItem.phase === 'final_answer'
                ? { phase: outputItem.phase }
                : {}),
              providerResponseId: responseId,
              ...(typeof outputItem.previousResponseId === 'string'
                ? { previousResponseId: outputItem.previousResponseId }
                : {})
            }
          }
        : {}),
      call: {
        id: providerCallId,
        ordinal,
        name,
        arguments: normalizePlainJson(call.arguments ?? {}, `Native call ${name} arguments`),
        ...(typeof call.thoughtSignature === 'string' ? { thoughtSignature: call.thoughtSignature } : {}),
        ...(call.async === true ? { async: true } : {})
      }
    };
  }

  /**
   * The durable native_tool_call proof for one parsed call item (checkpointed before admission).
   * The provider ordinal is the transport's chain-unique call ordinal, identical to the terminal
   * aggregate's array order, so re-stream duplicates and the terminal replay derive the same
   * ToolCall identity.
   */
  public buildCallProof(item: NativeCallItemEnvelope): PlainJsonValue {
    const responseId = item.outputItem!.providerResponseId!;
    const knownCall = this.callByProviderId.get(item.call.id);
    if (knownCall && (knownCall.responseId !== responseId || knownCall.name !== item.call.name
      || knownCall.asyncDeclared !== (item.call.async === true))) {
      throw new Error(`Native call ${item.call.id} changed its durable response/tool identity on replay.`);
    }
    const frozenResolution = this.callResolutions.get(item.call.id);
    if (frozenResolution?.original !== undefined
      && canonicalPlainJson(frozenResolution.original, 'Frozen replayed provider arguments')
        !== canonicalPlainJson(normalizePlainJson(item.call.arguments, 'Replayed provider arguments'),
          'Replayed provider arguments')) {
      throw new Error(`Native call ${item.call.id} changed its provider arguments on replay.`);
    }
    // A frozen, content-addressed resolution is the authority for a replayed call; the current
    // resolver is consulted only for a call seen for the first time.
    const resolution = frozenResolution ?? {
      ...this.deps.resolveCallArguments(item.call.name, item.call.arguments),
      catalog: this.currentModelHandleCatalog(),
      original: normalizePlainJson(item.call.arguments, 'Native provider arguments')
    };
    this.callResolutions.set(item.call.id, resolution);
    return normalizePlainJson({
      type: 'native_tool_call',
      responseId,
      toolName: item.call.name,
      arguments: item.call.arguments,
      resolvedArguments: resolution.arguments,
      modelHandleCatalog: resolution.catalog,
      ...(resolution.error !== undefined ? { argumentResolutionError: resolution.error } : {}),
      providerCallId: item.call.id,
      providerOrdinal: this.nextGlobalCallOrdinal(responseId, item.call.id),
      // The exact flag the provider returned; admission eligibility is decided separately at the
      // admission boundary (declared policy + actual flag), never by rewriting transport facts.
      async: item.call.async === true,
      // The shared item reference survives proof → admission CAS → context unchanged, so
      // projection/recovery keeps response/ordinal identity after checkpoint pruning.
      outputItem: item.outputItem as unknown as PlainJsonValue
    }, 'Native tool call proof');
  }

  /** In-memory per-item text accumulation from incremental output deltas (never persisted). */
  public observeDelta(content: PlainJsonValue): void {
    const record = asRecord(content);
    if (!record || (record.type !== 'text_delta' && record.type !== 'thought_delta')) return;
    const outputItem = asRecord(record.outputItem);
    const itemId = typeof outputItem?.id === 'string' ? outputItem.id : undefined;
    const text = typeof record.text === 'string' ? record.text : '';
    if (!itemId || text.length === 0) return;
    const accumulator = this.itemAccumulators.get(itemId) ?? { text: '', thought: '' };
    if (record.type === 'thought_delta') {
      accumulator.thought += text;
      if (typeof record.thoughtSignature === 'string') accumulator.thoughtSignature = record.thoughtSignature;
    } else {
      accumulator.text += text;
    }
    this.itemAccumulators.set(itemId, accumulator);
  }

  /**
   * Durable in-tail handling of one checkpointed native call item: real item-only revision, then
   * immediate admission for declared-async calls. Synchronous calls wait for their proven response
   * boundary (or the ordinary terminal batch when the chain ends without one).
   */
  public async admitStreamedCall(
    item: NativeCallItemEnvelope,
    streamSeq: string | bigint,
    result: StreamEventResult
  ): Promise<void> {
    const responseId = item.outputItem!.providerResponseId!;
    this.responseFor(responseId);
    const durableResponseCalls = [...this.calls.values()].filter(call => call.responseId === responseId).length;
      // The response-local revision index must survive a socket reconnect even if that
      // generation did not replay earlier call items of this same physical response.
      const localCallIndex = Math.max(this.responseCallCounts.get(responseId) ?? 0, durableResponseCalls);
    const providerOrdinal = this.nextGlobalCallOrdinal(responseId, item.call.id);
    const toolCallId = this.deps.toolCallIdFor(providerOrdinal, item.call.id, item.call.name);
    if (result.checkpointed && this.durableCallOrdinals.has(item.call.id)) {
      // A pruned proof can be checkpointed again on re-stream. SourceLink/native admission is
      // already the durable identity; never append a second item revision or re-execute its tool.
      if (!this.calls.has(toolCallId)) throw new Error(`Native admitted call ${item.call.id} was not recovered.`);
      return;
    }
    if (!result.checkpointed) {
      if (result.ignoredReason === 'duplicate' && !this.calls.has(toolCallId)) {
        // Re-stream after reconnect: rebuild the record and resume its durable frontier.
        const call = this.newSessionCall(item, providerOrdinal, toolCallId, streamSeq);
        this.calls.set(toolCallId, call);
        this.callByProviderId.set(call.providerCallId, call);
        await this.resumeCallFrontier(call);
      }
      return;
    }
    this.countCallItem(responseId);
    const part = {
      id: item.call.id,
      functionCall: { name: item.call.name, args: item.call.arguments },
      ...(item.call.thoughtSignature ? { thoughtSignature: item.call.thoughtSignature } : {}),
      ...(item.call.async === true ? { async: true } : {}),
      ...(item.outputItem ? { outputItem: item.outputItem } : {})
    };
    this.recordItemPart(`call:${responseId}:${localCallIndex}`, part);
    // The proving revision is a real fact; the call's Context occurrence belongs to the native
    // tool pair append so the model never sees one call twice.
    await this.deps.turnOutput.appendNativeAssistantItem({
      turnId: this.deps.turnId,
      modelRequestId: this.deps.modelRequestId,
      itemKey: `call:${responseId}:${localCallIndex}`,
      content: canonicalPlainJson({ role: 'model', parts: [part] } as unknown as PlainJsonValue, 'Native call item revision'),
      cumulativeContent: this.cumulativeItemContent(),
      contentType: MESSAGE_CONTENT_TYPE,
      contextDisposition: 'exclude'
    });
    const call = this.newSessionCall(item, providerOrdinal, toolCallId, streamSeq);
    this.calls.set(toolCallId, call);
    this.callByProviderId.set(call.providerCallId, call);
    if (call.asyncDeclared) {
      // An actual async flag without frozen authorization is a hard contract violation; the
      // admission boundary rejects it loudly instead of rewriting the transport fact to sync.
      if (!this.isAsyncAuthorized(call.name)) {
        throw new Error(
          `Provider declared async for native tool ${call.name} without frozen nativeAsync authorization.`
        );
      }
      await this.admitCall(call, { streamSeq: String(streamSeq) });
    }
  }

  private newSessionCall(
    item: NativeCallItemEnvelope,
    providerOrdinal: number,
    toolCallId: string,
    streamSeq: string | bigint
  ): NativeSessionCall {
    return {
      toolCallId,
      providerCallId: item.call.id,
      name: item.call.name,
      arguments: item.call.arguments,
      providerOrdinal,
      responseId: item.outputItem!.providerResponseId!,
      itemSeq: String(streamSeq),
      ...(item.call.thoughtSignature ? { thoughtSignature: item.call.thoughtSignature } : {}),
      asyncDeclared: item.call.async === true,
      admitted: false,
      settled: false,
      resultOccurrence: false,
      delivered: false
    };
  }

  /**
   * Durable in-tail handling of a completed text/reasoning item: item-only revision + its own
   * Context segment, preserving canonical prefix < call < suffix < result order.
   */
  public async admitStreamedContentItem(
    event: ProviderOutputStreamEvent,
    result: StreamEventResult
  ): Promise<void> {
    // A terminal/foreign-identity result means the item belongs to a superseded stream; the
    // aggregate path already owns its content. Droppable-checkpoint misses still persist revisions.
    if (result.terminal) return;
    const record = asRecord(event.content);
    if (!record || (record.type !== 'output_item_done' && record.type !== 'thought_done')) return;
    const outputItem = asRecord(record.outputItem);
    const itemId = typeof outputItem?.id === 'string' ? outputItem.id : undefined;
    if (!itemId) return;
    const accumulator = this.itemAccumulators.get(itemId);
    const thought = record.type === 'thought_done';
    const text = thought ? accumulator?.thought ?? '' : accumulator?.text ?? '';
    if (text.length === 0) return;
    const ordinal = typeof outputItem?.ordinal === 'number' && Number.isSafeInteger(outputItem.ordinal)
      ? outputItem.ordinal
      : undefined;
    const responseId = typeof outputItem?.providerResponseId === 'string' && outputItem.providerResponseId.length > 0
      ? outputItem.providerResponseId
      : undefined;
    // Provider ordinals are response-local: an item without its response identity cannot get a
    // collision-free durable key and is left to the final aggregate.
    if (ordinal === undefined || responseId === undefined) return;
    const part = thought
      ? {
          text,
          thought: true,
          ...(accumulator?.thoughtSignature ?? (typeof record.thoughtSignature === 'string' ? record.thoughtSignature : undefined)
            ? { thoughtSignature: accumulator?.thoughtSignature ?? record.thoughtSignature as string }
            : {}),
          ...(outputItem ? { outputItem } : {})
        }
      : { text, ...(outputItem ? { outputItem } : {}) };
    this.recordItemPart(`content:${responseId}:${ordinal}`, part);
    await this.deps.turnOutput.appendNativeAssistantItem({
      turnId: this.deps.turnId,
      modelRequestId: this.deps.modelRequestId,
      itemKey: `content:${responseId}:${ordinal}`,
      content: canonicalPlainJson({ role: 'model', parts: [part] } as unknown as PlainJsonValue, 'Native content item revision'),
      cumulativeContent: this.cumulativeItemContent(),
      contentType: MESSAGE_CONTENT_TYPE,
      contextDisposition: 'append'
    });
  }

  /**
   * Durable in-tail native_control handling after the control checkpoint was accepted: steering
   * receipt transitions, response boundary bookkeeping (the result-occurrence barrier), proven
   * synchronous admission and capability persistence. Delivery itself stays outside the tail.
   */
  public async afterNativeControl(
    event: ProviderOutputStreamEvent,
    result: StreamEventResult
  ): Promise<void> {
    if (!result.checkpointed && result.ignoredReason !== 'duplicate') return;
    const content = asRecord(event.content) as unknown as OpenAIResponsesNativeEvent | undefined;
    if (!content || typeof content.type !== 'string'
      || typeof content.responseId !== 'string' || content.responseId.length === 0) {
      throw new Error('Native control observation lacks a valid event type or response identity.');
    }
    switch (content.type) {
      case 'response.created': {
        this.responseFor(content.responseId);
        const unverifiedIds = nativeUnverifiedResultCallIds(content as unknown as Record<string, unknown>);
        if (unverifiedIds) {
          for (const providerCallId of unverifiedIds) {
            const call = this.callByProviderId.get(providerCallId);
            if (!call || !call.admitted) {
              throw new Error(`Native unverified result ${providerCallId} has no admitted tool identity.`);
            }
            this.uncertainResultCalls.add(call.toolCallId);
          }
          this.unsafeResultAdmission ??= nativeResultAdmissionUnknownError();
        }
        if (content.previousResponseId) {
          const created = this.responseFor(content.responseId);
          if (created.previousResponseId && created.previousResponseId !== content.previousResponseId) {
            throw new Error(`Native response ${created.responseId} changed its predecessor.`);
          }
          created.previousResponseId = content.previousResponseId;
        }
        if (!this.firstResponseLost && !this.firstResponseId && this.responseOrder.length === 1) {
          this.firstResponseId = content.responseId;
        }
        if (content.capabilities) {
          await this.deps.modelProvider.persistNativeCapabilities(
            this.deps.modelRequestId,
            this.requireStream().attemptSeq,
            this.requireStream().socketGeneration,
            content.capabilities
          );
        }
        // previous_response_id alone only identifies a chain predecessor. The transport attributes
        // a successor to a submission (submissionId) only when exactly one provider-accepted steer
        // is outstanding on that predecessor; the accepted user Message then enters Context here,
        // exactly once. Ambiguous candidates stay pending/unknown instead of being guessed.
        const submissionId = content.submissionId;
        if (content.previousResponseId && submissionId) {
          const applied = await this.serializeSteer(submissionId, async () => {
            const receipt = this.steerReceipts.get(submissionId);
            if (!receipt || (receipt.state !== 'accepted' && receipt.state !== 'waiting_for_input')
              || (receipt.targetResponseId !== content.previousResponseId
                && receipt.responseId !== content.previousResponseId)
              || (content.steerId && receipt.steerId && content.steerId !== receipt.steerId)) return false;
            const next = await this.deps.modelProvider.nativeSteering.applyToContext({
              turnId: this.deps.turnId, commandId: submissionId, responseId: content.responseId
            });
            this.steerReceipts.set(next.submissionId, next);
            this.emitSteering(next);
            return true;
          });
          if (!applied) {
            this.diagnose(`Native successor ${content.responseId} supplied an unverified steering submission ${submissionId}; no receipt was applied.`);
          }
        } else if (content.previousResponseId && [...this.steerReceipts.values()].some(receipt =>
          (receipt.state === 'accepted' || receipt.state === 'waiting_for_input')
          && (receipt.targetResponseId === content.previousResponseId
            || receipt.responseId === content.previousResponseId))) {
          this.diagnose(`Native successor ${content.responseId} lacks a provider-attested steering submission identity; receipt application is deferred.`);
        }
        // Result admission: the server admitted these call outputs into the chain at exactly this
        // point. Append their Context occurrences and mark delivery BEFORE any successor output —
        // local durable writes only, never an awaited future admission inside this tail.
        const admittedCallIds = content.admittedToolResultCallIds;
        if (Array.isArray(admittedCallIds) && admittedCallIds.length > 0) {
          const deliveredCalls: NativeSessionCall[] = [];
          for (const callId of admittedCallIds) {
            if (typeof callId !== 'string') continue;
            const call = this.callByProviderId.get(callId);
            if (!call || call.delivered) continue;
            if (!call.settled) {
              throw new Error(`Provider admitted a result for unsettled native call ${call.toolCallId}.`);
            }
            await this.appendResultOccurrence(call);
            call.delivered = true;
            this.inFlightDeliveries.delete(call.toolCallId);
            deliveredCalls.push(call);
          }
          if (deliveredCalls.length > 0) {
            await this.deps.effects.markNativeResultsDelivered({
              source: {
                kind: 'callback',
                key: `agent-loop:${this.deps.modelRequestId}:native-delivery:${content.responseId}`
              },
              deliveries: deliveredCalls.map((call) => ({
                toolCallId: call.toolCallId,
                carrierModelRequestId: this.deps.modelRequestId,
                providerResponseId: content.responseId,
                ...(typeof content.connectionGeneration === 'number'
                  ? { connectionGeneration: String(content.connectionGeneration) }
                  : {}),
                ...(content.streamId ? { streamId: content.streamId } : {})
              }))
            });
          }
        }
        this.pumpSignal();
        return;
      }
      case 'response.completed':
      case 'response.incomplete': {
        const response = this.responseFor(content.responseId);
        response.boundarySeq = String(event.streamSeq);
        response.boundaryReason = content.reason;
        response.completed = content.type === 'response.completed';
        // Preserve this physical response's independent raw input/output observation before
        // releasing a tool batch. Aggregate ModelRequest usage_json is billing for the whole chain,
        // never a measure of its latest model-visible prompt. Missing usage remains unknown.
        const stream = this.requireStream();
        const timing = asRecord(event.content)?.timing;
        await this.deps.modelProvider.persistNativeResponseUsage(
          this.deps.modelRequestId, stream.attemptSeq, stream.socketGeneration, {
            responseId: content.responseId,
            ...(response.previousResponseId || content.previousResponseId
              ? { previousResponseId: response.previousResponseId ?? content.previousResponseId } : {}),
            streamSeq: event.streamSeq,
            ...(content.usage ? { usage: content.usage } : {}),
            ...(content.responseId === this.firstResponseId
              ? { contextRootId: this.deps.initialContextRootId } : {}),
            // The capability measured this response's first output and output time; the control
            // plane validates it before folding it into the request's per-response metrics.
            ...(timing !== undefined ? { timing: timing as ModelResponseTiming } : {})
          }
        );
        // Original-root calibration: only the FIRST physical response's actual input tokens,
        // exactly once; later/cumulative usage never substitutes for this anchor.
        if (content.responseId === this.firstResponseId) {
          const inputTokens = usageInputTokens(content.usage);
          if (inputTokens !== undefined) {
            await this.deps.modelProvider.persistNativeInitialPromptTokens(
              this.deps.modelRequestId,
              this.requireStream().attemptSeq,
              this.requireStream().socketGeneration,
              inputTokens
            );
          }
        }
        response.admissionBoundary = isNativeAdmissionBoundary({
          type: content.type,
          responseId: content.responseId,
          ...(content.reason !== undefined ? { reason: content.reason } : {})
        });
        if (content.requiredInput) await this.admitRequiredInput(content.requiredInput);
        if (response.admissionBoundary) {
          await this.admitResponseSyncCalls(response);
        }
        if (response.completed) {
          for (const receipt of [...this.steerReceipts.values()]) {
            // response.created already durably applied the correct user message to Context;
            // only this *same* completed successor proves its continuation finished.
            if (receipt.state === 'continuing' && receipt.successorResponseId === response.responseId) {
              await this.transitionSteer(receipt.submissionId, ['continuing'], 'completed');
            }
          }
        }
        this.pumpSignal();
        return;
      }
      case 'response.steer.submitted': {
        const commandId = content.submissionId;
        if (!commandId) return;
        await this.transitionSteer(commandId, ['queued'], 'sent');
        return;
      }
      case 'response.steer.accepted': {
        const commandId = content.submissionId;
        if (!commandId) return;
        await this.transitionSteer(commandId, ['sent'], 'accepted', {
          ...(content.steerId ? { steerId: content.steerId } : {}),
          ...(content.responseId ? { responseId: content.responseId } : {}),
          ...(content.requiredInput ? { requiredInput: content.requiredInput } : {})
        });
        if (content.requiredInput) await this.admitRequiredInput(content.requiredInput);
        this.pumpSignal();
        return;
      }
      case 'response.steer.pending': {
        const commandId = content.submissionId;
        if (!commandId) return;
        await this.transitionSteer(commandId, ['sent', 'accepted'], 'waiting_for_input', {
          ...(content.steerId ? { steerId: content.steerId } : {}),
          ...(content.responseId ? { responseId: content.responseId } : {}),
          ...(content.requiredInput ? { requiredInput: content.requiredInput } : {})
        });
        if (content.requiredInput) await this.admitRequiredInput(content.requiredInput);
        this.pumpSignal();
        return;
      }
      case 'response.steer.failed': {
        const commandId = content.submissionId;
        if (!commandId) return;
        await this.transitionSteer(commandId, ['queued', 'sent', 'accepted', 'waiting_for_input'], 'failed', {
          error: content.error?.message ?? 'Native steering rejected by the provider.'
        });
        this.pumpSignal();
        return;
      }
      case 'response.steer.disconnected': {
        const commandId = content.submissionId;
        if (!commandId) return;
        const receipt = this.steerReceipts.get(commandId);
        if (!receipt || receipt.state === 'continuing' || receipt.state === 'completed') return;
        if (receipt.state !== 'queued' && receipt.state !== 'sent'
          && receipt.state !== 'accepted' && receipt.state !== 'waiting_for_input') return;
        // The transport may have begun wire-writing before a submitted control was committed:
        // queued + a real disconnect is UNKNOWN, not proof of a never-sent submission. Retain
        // body/status, never automatically resend or mark the user instruction applied.
        await this.transitionSteer(commandId,
          ['queued', 'sent', 'accepted', 'waiting_for_input'], 'delivery_unknown');
        this.pumpSignal();
        return;
      }
      default:
        return;
    }
  }

  /**
   * Session end of the logical request. A host handoff keeps every durable frontier untouched for
   * the next owner; cancel/failure closes admitted work before the lane may end; steering receipts
   * finalize from the chain outcome. Never runs twice.
   */
  public async dispose(outcome: 'completed' | 'failed' | 'cancelled' | 'handoff'): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeSettlements?.();
    this.unsubscribeSettlements = undefined;
    this.unregisterSteering?.();
    this.unregisterSteering = undefined;
    if (outcome === 'handoff') {
      // The next lease generation recovers the exact durable frontier; nothing is cancelled,
      // settled, or finalized on behalf of a still-running detached effect.
      this.controller = undefined;
      return;
    }
    // Every admitted call is closed independently: one call whose effect cannot be cancelled yet
    // must not leave its already-settled siblings without a result occurrence in Context.
    let closureError: unknown;
    for (const call of this.calls.values()) {
      if (!call.admitted) continue;
      try {
        if (outcome !== 'completed' && !call.settled) {
          await this.deps.closeAdmittedCall(
            call.toolCallId,
            `agent-loop:${this.deps.modelRequestId}:native-chain-${outcome}:${call.toolCallId}`
          );
          call.settled = true;
          const terminal = await this.deps.effects.readTerminalResult(call.toolCallId, false);
          call.toolModelResultId = terminal?.toolModelResultId;
        }
        if (call.settled && !call.delivered && call.toolModelResultId && !call.resultOccurrence) {
          // A provider create with ambiguous steering is NOT a delivery receipt. Once its logical
          // transport ends, the already-settled result still belongs in durable Context for the
          // next full-request preflight (or for a visible failed/cancelled Turn). Freeze child refs
          // first; never send another wire result or invent native_delivery on this closure path.
          await this.buildFunctionCallOutput(call);
          await this.appendResultOccurrence(call);
        }
      } catch (error) {
        if (isExecutionHandoffError(error)) throw error;
        closureError ??= error;
        this.diagnose(`native result closure failed for ${call.toolCallId}: ${errorMessage(error)}`);
      }
    }
    for (const receipt of [...this.steerReceipts.values()]) {
      try {
        if (receipt.state === 'queued') {
          await this.transitionSteer(receipt.submissionId, ['queued'], 'failed', {
            error: 'Native chain ended before the steering submission reached the wire.'
          });
        } else if (receipt.state === 'continuing') {
          // Only a proven successor/context application may complete a receipt.
          await this.transitionSteer(receipt.submissionId, ['continuing'], 'completed');
        } else if (receipt.state === 'sent' || receipt.state === 'accepted' || receipt.state === 'waiting_for_input') {
          // Sent/accepted/waiting carry no application proof — an honest uncertain close, even
          // when the logical request itself completed. Never auto-resend; recover from facts.
          await this.transitionSteer(
            receipt.submissionId,
            ['sent', 'accepted', 'waiting_for_input'],
            'delivery_unknown'
          );
        }
      } catch (error) {
        this.diagnose(`native steering finalization failed for ${receipt.submissionId}: ${errorMessage(error)}`);
      }
    }
    if (outcome !== 'completed') {
      // The pending work above is durably disposed; the lane may end at the next boundary.
      this.controller?.endLogicalRequest();
    }
    this.controller = undefined;
    // AgentLoop's request-boundary closure retries whatever could not be closed here.
    if (closureError !== undefined) throw closureError;
  }

  private async steerCommand(command: NativeSteerCommand): Promise<NativeSteeringReceipt> {
    if (!this.deps.capabilities.steering) {
      throw new Error('Native steering is not enabled for this request.');
    }
    // Do not accept an input against a transport chain whose settled batch is already being
    // durably transferred to the next logical request.
    if (this.preparingCheckpoint || this.yieldingForRuntimeInput || this.disposed) {
      throw new Error('Native request is checkpointing; send steering input to the next request.');
    }
    const controller = this.controller;
    if (!controller) throw new Error('Turn has no live native chain for steering.');
    let receipt = await this.deps.modelProvider.nativeSteering.submit({
      turnId: this.deps.turnId,
      conversationId: this.deps.conversationId,
      modelRequestId: this.deps.modelRequestId,
      commandId: command.commandId,
      content: command.content,
      ...(controller.responseId ? { previousResponseId: controller.responseId } : {}),
      ...(controller.connectionGeneration !== undefined
        ? { connectionGeneration: controller.connectionGeneration }
        : {})
    });
    this.steerReceipts.set(receipt.submissionId, receipt);
    this.emitSteering(receipt);
    if (receipt.state !== 'queued') return receipt;
    const previousResponseId = controller.responseId;
    // Write-ahead fence: Host loss after a wire write but before an observed submitted event
    // must never leave a replayable queued receipt. 'sent' is an attempted-send state here; a
    // proven not_sent rejection below closes it as failed rather than inventing delivery.
    const attempted = await this.transitionSteer(command.commandId, ['queued'], 'sent');
    if (!attempted || attempted.state !== 'sent') return this.steerReceipts.get(command.commandId) ?? receipt;
    try {
      await controller.steer({
        submissionId: command.commandId,
        input: [command.content],
        ...(previousResponseId ? { previousResponseId } : {})
      });
    } catch (error) {
      if (isOpenAIResponsesNativeDeliveryError(error)) {
        if (error.disposition === 'not_sent') {
          const failed = await this.transitionSteer(command.commandId, ['sent'], 'failed', {
            error: error.detail.reason === 'steering_pending_unproven'
              ? 'A previous native steering submission is still awaiting provider attribution; this instruction was not sent.'
              : `Native steering was not sent (${error.detail.reason ?? 'transport refused'}); submit a new instruction to retry.`
          });
          return failed ?? this.steerReceipts.get(command.commandId) ?? attempted;
        }
        if (error.disposition === 'admission_unknown') {
          const unknown = await this.transitionSteer(command.commandId,
            ['sent', 'accepted', 'waiting_for_input'], 'delivery_unknown');
          return unknown ?? this.steerReceipts.get(command.commandId) ?? attempted;
        }
      }
      throw error;
    }
    return this.steerReceipts.get(command.commandId) ?? attempted;
  }

  private async admitCall(
    call: NativeSessionCall,
    identity: { streamSeq: string; completedResponseStreamSeq?: string; providerResponseId?: string }
  ): Promise<void> {
    if (call.admitted || this.disposed) return;
    const stream = this.requireStream();
    const definition = this.deps.resolveDefinition(call.name);
    const resolution = this.callResolutions.get(call.providerCallId);
    if (!resolution) throw new Error(`Native call ${call.providerCallId} has no frozen argument resolution proof.`);
    call.arguments = resolution.arguments;
    const dispatchInput: ReliableAgentToolDispatchInput & { definition: ReliableAgentToolDefinition } = {
      turnId: this.deps.turnId,
      modelRequestId: this.deps.modelRequestId,
      toolCallId: call.toolCallId,
      providerCallId: call.providerCallId,
      toolName: call.name,
      arguments: call.arguments,
      definition
    };
    const [policy] = await this.deps.freezePolicies([dispatchInput]);
    if (!policy) throw new Error('Native call policy freeze returned no decision.');
    const streamIdentity: NativeToolCallStreamIdentity = {
      attemptSeq: stream.attemptSeq,
      socketGeneration: stream.socketGeneration,
      streamSeq: identity.streamSeq,
      ...(identity.completedResponseStreamSeq !== undefined
        ? { completedResponseStreamSeq: identity.completedResponseStreamSeq }
        : {}),
      ...(identity.providerResponseId !== undefined ? { providerResponseId: identity.providerResponseId } : {})
    };
    await this.deps.effects.createToolCallBatch({
      source: { kind: 'callback', key: `agent-loop:${this.deps.modelRequestId}:native-admit:${call.toolCallId}` },
      batchId: stableNativeBatchId(this.deps.modelRequestId, call.toolCallId),
      turnId: this.deps.turnId,
      modelRequestId: this.deps.modelRequestId,
      messageId: assistantMessageIdFor(this.deps.turnId, this.deps.modelRequestId),
      entries: [{
        toolCallId: call.toolCallId,
        toolName: call.name,
        arguments: call.arguments,
        providerCallId: call.providerCallId,
        providerOrdinal: call.providerOrdinal,
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
        policy
      }],
      streamIdentity
    });
    await this.deps.context.appendNativeToolCall({
      conversationId: this.deps.conversationId,
      toolCallId: call.toolCallId,
      providerCallId: call.providerCallId
    });
    call.admitted = true;
    if (resolution.error !== undefined) {
      // Same honest failure as the terminal batch: no dispatch, a real failed result to deliver.
      const failed = await this.deps.effects.settleWithoutEffect({
        source: {
          kind: 'internal',
          key: `agent-loop:${call.toolCallId}:invalid-model-handle-reference`
        },
        toolCallId: call.toolCallId,
        status: 'failed',
        detail: {
          code: 'invalid_model_handle_reference',
          error: resolution.error
        }
      });
      call.settled = true;
      call.toolModelResultId = failed.terminal?.toolModelResultId;
      this.pumpSignal();
      return;
    }
    this.scheduleExecution(call);
  }

  private async admitRequiredInput(requiredInput: readonly OpenAIResponsesRequiredInput[]): Promise<void> {
    for (const entry of requiredInput) {
      if (entry.type !== 'function_call_output' && entry.type !== 'custom_tool_call_output') continue;
      const callId = entry.callId;
      if (!callId) continue;
      const call = this.callByProviderId.get(callId);
      if (!call || call.admitted || call.asyncDeclared) continue;
      const response = this.responseFor(call.responseId);
      if (response.admissionBoundary && response.boundarySeq) {
        // Awaited inside the serialized event tail: a later sync sweep observes the admission.
        await this.admitCall(call, {
          streamSeq: call.itemSeq,
          completedResponseStreamSeq: response.boundarySeq,
          providerResponseId: response.responseId
        });
      } else {
        response.syncRequired = true;
      }
    }
  }

  private async admitResponseSyncCalls(response: NativeSessionResponse): Promise<void> {
    if (!response.boundarySeq) return;
    for (const call of this.calls.values()) {
      if (call.responseId !== response.responseId || call.admitted || call.asyncDeclared) continue;
      await this.admitCall(call, {
        streamSeq: call.itemSeq,
        completedResponseStreamSeq: response.boundarySeq,
        providerResponseId: response.responseId
      });
    }
    response.syncRequired = false;
  }


  /**
   * Starts external execution outside the onEvent tail. The real dispatcher owns every scheduling
   * decision (per-category classifiers, serial/parallel policy, approvals, shared Turn limits) —
   * the session never imposes a second scheduler. Never re-executes committed effects: dispatch
   * reconciles the durable frontier on replay.
   */
  private scheduleExecution(call: NativeSessionCall): void {
    const fence = this.activeFence();
    const run = async () => {
      try {
        const resolution = this.callResolutions.get(call.providerCallId);
        if (!resolution) throw new Error(`Native call ${call.providerCallId} has no frozen argument resolution proof.`);
        call.arguments = resolution.arguments;
        if (resolution.error !== undefined) {
          // A crash may happen after admission but before the rejected reference is settled.
          // Recovery must reproduce that failure, never dispatch the raw childRef as a new call.
          await this.deps.effects.settleWithoutEffect({
            source: { kind: 'internal', key: `agent-loop:${call.toolCallId}:invalid-model-handle-reference` },
            toolCallId: call.toolCallId, status: 'failed',
            detail: { code: 'invalid_model_handle_reference', error: resolution.error }
          });
        } else {
          await this.deps.dispatchCall({
            turnId: this.deps.turnId,
            modelRequestId: this.deps.modelRequestId,
            toolCallId: call.toolCallId,
            providerCallId: call.providerCallId,
            toolName: call.name,
            arguments: call.arguments
          });
        }
      } catch (error) {
        if (!isExecutionHandoffError(error)) {
          this.diagnose(`native call ${call.toolCallId} dispatch failed: ${errorMessage(error)}`);
        }
        return;
      }
      await this.onSettlement(call.toolCallId);
    };
    if (fence) void runWithExecutionLeaseFence(fence, run);
    else void run();
  }

  private async onSettlement(toolCallId: string): Promise<void> {
    const call = this.calls.get(toolCallId);
    if (!call || call.settled) return;
    const terminal = await this.deps.effects.readTerminalResult(toolCallId, false);
    if (!terminal) return;
    call.settled = true;
    call.toolModelResultId = terminal.toolModelResultId;
    // No Context append here: the occurrence lands only at the proven admission created event
    // (or the explicit closure path), so a successor that never saw the result never follows it.
    this.pumpSignal();
  }

  private async resumeCallFrontier(call: NativeSessionCall): Promise<void> {
    const admission = await this.deps.effects.readNativeAdmission(call.toolCallId);
    call.admitted = admission !== undefined;
    const terminal = await this.deps.effects.readTerminalResult(call.toolCallId, false);
    call.settled = terminal !== undefined;
    call.toolModelResultId = terminal?.toolModelResultId;
    if (call.admitted && !call.settled) this.scheduleExecution(call);
    if (call.settled) this.pumpSignal();
  }

  private async appendResultOccurrence(call: NativeSessionCall): Promise<void> {
    if (call.resultOccurrence || !call.toolModelResultId) return;
    const sources = await listAllDomainRows(this.deps.database, 'ContextSegmentSource', {
      source_kind: 'tool_model_result',
      source_id: call.toolModelResultId
    });
    if (sources.length === 0) {
      await this.deps.context.appendNativeToolResult({
        conversationId: this.deps.conversationId,
        toolCallId: call.toolCallId,
        toolModelResultId: call.toolModelResultId
      });
    }
    call.resultOccurrence = true;
  }

  private pumpSignal(): void {
    if (this.disposed || !this.controller) return;
    if (this.pumpRunning) {
      this.pumpDirty = true;
      return;
    }
    this.pumpRunning = true;
    const fence = this.activeFence();
    const run = async () => {
      try {
        await this.pumpLoop();
      } catch (error) {
        this.diagnose(`native delivery pump failed: ${errorMessage(error)}`);
      } finally {
        this.pumpRunning = false;
        if (this.pumpDirty && !this.disposed) {
          this.pumpDirty = false;
          this.pumpSignal();
        }
      }
    };
    if (fence) void runWithExecutionLeaseFence(fence, run);
    else void run();
  }

  /**
   * Server-admission delivery, outside the onEvent tail. Per response: never submit while any
   * required synchronous output of that response is unsettled; include every settled undelivered
   * result (sync and newly ready async) in call order. Async-only responses deliver independently.
   */
  private async pumpLoop(): Promise<void> {
    for (;;) {
      this.pumpDirty = false;
      if (this.disposed || this.yieldingForRuntimeInput || !this.controller) return;
      if (this.unsafeResultAdmission || this.budgetClosureRequested) {
        // A result that may already have reached the Provider can NEVER be resubmitted, nor can
        // another tool result be sent into that ambiguous physical chain; a chain at its physical
        // budget cannot carry another create either. Both end the logical request: dispose closes
        // every settled result into Context and the Turn continues with a fresh full request. Do
        // not end the chain until every admitted external effect truly settles;
        // requestNativeLogicalEnd otherwise clears the transport's outstanding-async set before
        // the work exists durably.
        if (this.inFlightDeliveries.size === 0
          && [...this.calls.values()].every(call => !call.admitted || call.settled)) {
          this.yieldingForRuntimeInput = true;
          this.controller.endLogicalRequest();
          this.deps.onDiagnostic?.(this.unsafeResultAdmission
            ? 'Native logical request ended after an unverified result admission; settled results continue from Context.'
            : 'Native logical request ended at its physical budget; settled results continue from Context.');
        }
        return;
      }
      const ready = this.collectDeliverable();
      if (ready.length === 0) return;
      if (await this.yieldAtNativeBatchBoundary(ready)) return;
      const latestBoundary = [...this.responseOrder].reverse()
        .map(id => this.responses.get(id)).find(response => response?.admissionBoundary && response.boundarySeq);
      const observed = await this.deps.modelProvider.readNativeLatestResponseUsage(this.deps.modelRequestId);
      const stream = this.requireStream();
      const pressure = latestBoundary !== undefined && (
        !observed || observed.responseId !== latestBoundary.responseId
        || observed.attemptSeq !== stream.attemptSeq || observed.socketGeneration !== stream.socketGeneration
        || nativePhysicalResponseBudgetPressure({
          budget: this.deps.budget,
          physicalInputTokens: observed.inputTokens,
          physicalResponseCount: observed.physicalResponseCount
        })
      );
      if (this.inFlightDeliveries.size > 0) {
        // Never send another create while an earlier result admission is unresolved; its
        // response.created (or its uncertainty) re-runs this pump.
        const blockedResponseId = this.responseOrder[this.responseOrder.length - 1] ?? 'unknown';
        if (this.lastBackpressureResponseId !== blockedResponseId) {
          this.lastBackpressureResponseId = blockedResponseId;
          this.diagnose('Native response cannot checkpoint yet; tool-result delivery is backpressured.');
        }
        return;
      }
      if (pressure) {
        // An unattributed steer blocks a logical-request checkpoint, but need not block a
        // required tool-result create when physical usage is known safely below capacity. Near
        // capacity (or with unknown usage) no create may be sent: waiting would leave the
        // provider waiting for these outputs with nothing that ever ends the chain. End the
        // logical request instead once every admitted effect settles.
        this.budgetClosureRequested = true;
        continue;
      }
      const adapter = await this.deps.resolveAdapter(this.deps.providerId);
      if (!adapter.materializeNativeToolOutput) {
        throw new Error(`Provider adapter ${this.deps.providerId} lacks materializeNativeToolOutput.`);
      }
      // Freeze and reserve newly exposed child refs in delivery order. Concurrent settlements
      // must never both allocate A1 from the same pre-batch catalog.
      const baseOutputs: OpenAIResponsesToolOutput[] = [];
      for (const call of ready) baseOutputs.push(await this.buildFunctionCallOutput(call));
      const outputs = await adapter.materializeNativeToolOutput(baseOutputs);
      const controller = this.controller;
      if (!controller || this.disposed || this.yieldingForRuntimeInput
        || this.inFlightDeliveries.size > 0) return;
      // The batch stays in-flight until the admission commit lands via the checkpointed
      // response.created carrying admittedToolResultCallIds — never marked from this promise alone.
      for (const call of ready) this.inFlightDeliveries.add(call.toolCallId);
      try {
        await controller.submitToolResults(outputs);
      } catch (error) {
        for (const call of ready) this.inFlightDeliveries.delete(call.toolCallId);
        if (!isOpenAIResponsesNativeDeliveryError(error)) throw error;
        if (error.disposition === 'admission_unknown') {
          for (const call of ready) this.uncertainResultCalls.add(call.toolCallId);
          // Whatever made the admission unknown (an ambiguous successor, a local write that
          // outlived its deadline, a released controller), these results can never be resent on
          // this chain and nothing else would ever deliver them. Stop only after all admitted
          // effects settle; pumpLoop requests the real physical response boundary without
          // cancelling or re-sending any of those effects.
          this.unsafeResultAdmission ??= nativeResultAdmissionUnknownError();
          this.pumpDirty = true;
        }
        this.diagnose(`native result delivery ${error.disposition}: ${error.message}`);
        return;
      }
      if (!this.pumpDirty && this.collectDeliverable().length === 0) return;
    }
  }

  /**
   * The safe default is one complete physical response + its entire settled tool batch per
   * logical ModelRequest. The same user Turn continues via AgentLoop's next frozen full-request
   * CompressionCoordinator preflight. Native delivery is NOT acknowledged on a local yield:
   * result occurrences (and child-handle projections) are durably retained for the next request.
   * An incomplete steered response, any unadmitted/unsettled call, in-flight result admission or
   * steering receipt prevents the checkpoint; already-issued external effects are never cancelled.
   */
  private async yieldAtNativeBatchBoundary(ready: readonly NativeSessionCall[]): Promise<boolean> {
    const latestResponseId = this.responseOrder[this.responseOrder.length - 1];
    const latest = latestResponseId ? this.responses.get(latestResponseId) : undefined;
    const readyIds = new Set(ready.map(call => call.toolCallId));
    if (!latest?.completed || !latest.boundarySeq || this.inFlightDeliveries.size > 0
      || this.hasPendingSteering()
      || [...this.calls.values()].some(call =>
        !call.admitted || !call.settled || (!call.delivered && !readyIds.has(call.toolCallId)))) return false;
    const controller = this.controller;
    if (!controller || this.disposed) return false;
    this.preparingCheckpoint = true;
    try {
      for (const call of ready) {
        // Freeze output bytes/child refs before the Context occurrence: replay must not allocate
        // a new handle or regenerate a different tool result for the successor request.
        await this.buildFunctionCallOutput(call);
        await this.appendResultOccurrence(call);
      }
      if (this.controller !== controller || this.disposed || this.hasPendingSteering()
        || this.inFlightDeliveries.size > 0
        || this.responseOrder[this.responseOrder.length - 1] !== latestResponseId) {
        throw new Error('Native checkpoint lost its completed response/controller frontier.');
      }
      this.yieldingForRuntimeInput = true;
      controller.endLogicalRequest();
      this.deps.onDiagnostic?.('Native logical request checkpointed at a complete, settled physical tool batch.');
      return true;
    } finally {
      this.preparingCheckpoint = false;
    }
  }

  private hasPendingSteering(): boolean {
    return [...this.steerReceipts.values()].some(receipt => {
      // Historical receipts belong to older ModelRequests and cannot block a freshly frozen
      // full-request continuation.
      if (receipt.modelRequestId && receipt.modelRequestId !== this.deps.modelRequestId) return false;
      if (['queued', 'sent', 'accepted', 'waiting_for_input', 'continuing'].includes(receipt.state)) return true;
      // A delivery-unknown steer can still produce a successor after a local disconnect
      // observation, but only while no successor of its target exists. Once the provider created
      // a response after that target, the steer was consumed (or dropped) by it; the terminal
      // receipt must not block every later checkpoint of this logical request.
      return receipt.state === 'delivery_unknown' && !this.steerTargetHasSuccessor(receipt);
    });
  }

  private steerTargetHasSuccessor(receipt: NativeSteeringReceipt): boolean {
    const target = receipt.targetResponseId ?? receipt.responseId;
    if (!target) return false;
    const index = this.responseOrder.indexOf(target);
    if (index >= 0 && index < this.responseOrder.length - 1) return true;
    return [...this.responses.values()].some(response => response.previousResponseId === target);
  }

  private collectDeliverable(): NativeSessionCall[] {
    const ready: NativeSessionCall[] = [];
    for (const responseId of this.responseOrder) {
      const response = this.responses.get(responseId);
      if (!response?.admissionBoundary || !response.boundarySeq) continue;
      const calls = [...this.calls.values()]
        .filter((call) => call.responseId === responseId)
        .sort((left, right) => left.providerOrdinal - right.providerOrdinal);
      const syncUnsettled = calls.some((call) => !call.asyncDeclared && !call.settled);
      if (syncUnsettled) continue;
      for (const call of calls) {
        if (call.admitted && call.settled && !call.delivered
          && !this.inFlightDeliveries.has(call.toolCallId)
          && !this.uncertainResultCalls.has(call.toolCallId)) {
          ready.push(call);
        }
      }
    }
    return ready.sort((left, right) => left.providerOrdinal - right.providerOrdinal);
  }

  private async buildFunctionCallOutput(call: NativeSessionCall): Promise<OpenAIResponsesToolOutput> {
    if (!call.toolModelResultId) throw new Error(`Native call ${call.toolCallId} has no settled result.`);
    const result = await this.requireDomain('ToolModelResult', call.toolModelResultId);
    const revision = await this.requireDomain(
      'MessageRevision',
      requireId(result.message_revision_id, 'ToolModelResult.message_revision_id')
    );
    const metadata = await this.requireDomain(
      'ContentObject',
      requireId(revision.content_object_id, 'MessageRevision.content_object_id')
    ) as unknown as ContentObjectMetadata;
    const raw = (await this.deps.contentStore.read(metadata)).toString('utf8');
    if (['run_agent', 'read_agent_answer', 'submit_plan'].includes(call.name)
      || isCollaborationHandleTool(call.name)) {
      const frozen = await freezeNativeChildToolProjection({
        database: this.deps.database, contentStore: this.deps.contentStore,
        modelRequestId: this.deps.modelRequestId, toolCallId: call.toolCallId,
        toolModelResultId: call.toolModelResultId, messageRevisionId: String(revision.id),
        contentObjectId: metadata.id, toolName: call.name, raw,
        catalog: this.childCatalog, now: this.deps.now()
      });
      this.childCatalog = frozen.catalog;
      // Projection metadata is local authority only; the provider receives the frozen output bytes.
      return { type: 'function_call_output', callId: call.providerCallId, output: frozen.output };
    }
    if (call.name === SKILLS_TOOL_NAME) {
      // A loaded skill is read as its rendered text, the same bytes a full request replays for it.
      const projected = projectToolResultBatch([{
        toolName: call.name,
        response: projectToolResultForModel(call.name, JSON.parse(raw) as unknown, this.childCatalog)
      }]).items[0].response;
      const text = readModelTextToolResponse(projected);
      if (text) return { type: 'function_call_output', callId: call.providerCallId, output: text.text };
    }
    const parsed = asRecord(normalizePlainJson(JSON.parse(raw), 'Native ToolModelResult content'));
    const parts = Array.isArray(parsed?.parts) ? parsed.parts : undefined;
    let output: string | Array<Record<string, unknown>> = raw;
    if (parts && parts.some((part) => asRecord(part)?.inlineData !== undefined || asRecord(part)?.inline_data !== undefined)) {
      output = parts.map((part): Record<string, unknown> => {
        const record = asRecord(part) ?? {};
        if (typeof record.text === 'string') return { type: 'input_text', text: record.text };
        return record as Record<string, unknown>;
      });
    }
    return {
      type: 'function_call_output',
      callId: call.providerCallId,
      output
    };
  }

  private responseFor(responseId: string): NativeSessionResponse {
    const existing = this.responses.get(responseId);
    if (existing) return existing;
    const response: NativeSessionResponse = {
      responseId,
      admissionBoundary: false,
      completed: false,
      syncRequired: false
    };
    this.responses.set(responseId, response);
    this.responseOrder.push(responseId);
    return response;
  }

  /** Frozen authorization for early async admission; orthogonal to the provider-returned flag. */
  private isAsyncAuthorized(name: string): boolean {
    if (!this.deps.capabilities.asyncTools) return false;
    const metadata = asRecord(this.deps.resolveDefinition(name).metadata);
    return metadata?.nativeAsync === true;
  }

  private requireStream(): { attemptSeq: string; socketGeneration: string } {
    if (!this.stream) throw new Error('Native session is not bound to a dispatch stream identity.');
    return this.stream;
  }

  private activeFence(): ExecutionLeaseFence | undefined {
    return this.controllerFence ?? this.creationFence;
  }

  private emitSteering(receipt: NativeSteeringReceipt): void {
    this.deps.modelProvider.emitNativeSteeringUpdate({
      conversationId: this.deps.conversationId,
      receipts: [receipt],
      commandId: receipt.submissionId
    });
  }

  /**
   * Replay-tolerant receipt transition: re-streamed events are idempotent no-ops when the receipt
   * already reached (or moved past) the target state; genuine drift is diagnosed, never hidden.
   */
  private transitionSteer(
    commandId: string,
    from: readonly OpenAIResponsesSteeringState[],
    to: OpenAIResponsesSteeringState,
    extras?: {
      steerId?: string;
      responseId?: string;
      successorResponseId?: string;
      requiredInput?: OpenAIResponsesRequiredInput[];
      error?: string;
    }
  ): Promise<NativeSteeringReceipt | undefined> {
    // The provider event tail and the steering command's send promise can both report one
    // submission's outcome concurrently. Serialize per submission so each observer decides from
    // the committed state of the previous one instead of racing on the same stale in-memory state.
    return this.serializeSteer(commandId, () => this.transitionSteerNow(commandId, from, to, extras));
  }

  private serializeSteer<T>(commandId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.steerTails.get(commandId) ?? Promise.resolve();
    const next = previous.then(run, run);
    const tail = next.then(() => undefined, () => undefined);
    this.steerTails.set(commandId, tail);
    void tail.then(() => {
      if (this.steerTails.get(commandId) === tail) this.steerTails.delete(commandId);
    });
    return next;
  }

  private async transitionSteerNow(
    commandId: string,
    from: readonly OpenAIResponsesSteeringState[],
    to: OpenAIResponsesSteeringState,
    extras?: {
      steerId?: string;
      responseId?: string;
      successorResponseId?: string;
      requiredInput?: OpenAIResponsesRequiredInput[];
      error?: string;
    }
  ): Promise<NativeSteeringReceipt | undefined> {
    const receipt = this.steerReceipts.get(commandId);
    if (!receipt) {
      this.diagnose(`native steering event for unknown submission ${commandId}`);
      return undefined;
    }
    if (receipt.state === to) return receipt;
    if (!from.includes(receipt.state)) {
      this.diagnose(`native steering receipt ${commandId} ignored ${receipt.state} → ${to}`);
      return undefined;
    }
    const next = await this.deps.modelProvider.nativeSteering.transition({
      turnId: this.deps.turnId,
      commandId,
      from,
      to,
      ...(extras ? { extras } : {})
    });
    this.steerReceipts.set(commandId, next);
    this.emitSteering(next);
    return next;
  }

  private async requireDomain(domain: string, id: string): Promise<DomainRow> {
    const snapshot = await this.deps.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0] as DomainRow | null;
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async getOptional(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.deps.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return (snapshot.snapshot[0] as DomainRow | null) ?? null;
  }

  /** Whole-chain-so-far aggregate content; the durable current projection target per item. */
  private cumulativeItemContent(): string {
    const parts = this.itemPartsOrdered.map((entry) => entry.part);
    return canonicalPlainJson({ role: 'model', parts } as unknown as PlainJsonValue, 'Native cumulative revision');
  }

  private diagnose(message: string): void {
    (this.deps.onDiagnostic ?? ((text) => console.warn('[reliable-kernel]', text)))(message);
  }
}

function nativeResultAdmissionUnknownError(): Error {
  return Object.assign(new Error(
    'NATIVE_RESULT_ADMISSION_UNKNOWN: A physical response may have consumed a tool result while an in-flight steer shares its predecessor. No provider admission or steering application can be proven; the Turn must fail safely without resending the result or automatically rebasing its chain.'
  ), { code: 'NATIVE_RESULT_ADMISSION_UNKNOWN' });
}

/** Local uncertainty observation, NEVER a provider result-admission proof. */
function nativeUnverifiedResultCallIds(content: Record<string, unknown>): string[] | undefined {
  const marker = 'response_created_without_unique_result_admission';
  const raw = content.unverifiedToolResultCallIds;
  if (raw === undefined && content.reason !== marker) return undefined;
  if (content.type !== 'response.created' || content.reason !== marker
    || content.admittedToolResultCallIds !== undefined
    || !Array.isArray(raw) || raw.length === 0
    || raw.some(value => typeof value !== 'string' || value.length === 0)
    || new Set(raw).size !== raw.length) {
    throw new Error('Native unverified tool results require one strictly identified response.created without an admission acknowledgment.');
  }
  return [...raw] as string[];
}

function stableNativeBatchId(modelRequestId: string, toolCallId: string): string {
  return `rk_tool_call_batch_${createHash('sha256')
    .update(JSON.stringify([modelRequestId, toolCallId]))
    .digest('hex')
    .slice(0, 32)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function usageInputTokens(usage: Record<string, unknown> | undefined): number | undefined {
  const value = usage?.input_tokens;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty id.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}
