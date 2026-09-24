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
import type { ModelOutputItemReference } from '../../shared/protocol';
import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { freezeNativeChildToolProjection, readNativeRequestChildHandles, withChildHandles } from './conversationChildHandles';
import { isCollaborationHandleTool, normalizeModelHandleCatalog, type ModelHandleCatalog } from './modelHandleCatalog';
import { ContextSequenceControlPlane } from './contextSequence';
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
  boundarySeq?: string;
  boundaryReason?: string;
  admissionBoundary: boolean;
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
  private readonly calls = new Map<string, NativeSessionCall>();
  private readonly callByProviderId = new Map<string, NativeSessionCall>();
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
  private firstResponseId?: string;
  private pumpRunning = false;
  private pumpDirty = false;
  private readonly inFlightDeliveries = new Set<string>();
  private disposed = false;
  private yieldingForRuntimeInput = false;
  private childCatalog: ModelHandleCatalog;
  private readonly callResolutions = new Map<string, { arguments: PlainJsonValue; error?: string; catalog: ModelHandleCatalog }>();

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

  /** Rebuilds in-memory orchestration state from durable facts after a crash/reconnect. */
  public async reconcile(): Promise<void> {
    this.childCatalog = withChildHandles(this.childCatalog,
      await readNativeRequestChildHandles(this.deps.database, this.deps.contentStore, this.deps.modelRequestId));
    const checkpoints = await listAllDomainRows(this.deps.database, 'ModelStreamCheckpoint', {
      model_request_id: this.deps.modelRequestId
    });
    const contentRows = new Map<string, DomainRow>();
    for (const checkpoint of checkpoints) {
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
          this.responseFor(control.responseId);
          this.firstResponseId ??= control.responseId;
        } else if (control.type === 'response.completed' || control.type === 'response.incomplete') {
          const response = this.responseFor(control.responseId);
          response.boundarySeq = String(checkpoint.stream_seq);
          response.boundaryReason = control.reason;
          response.admissionBoundary = isNativeAdmissionBoundary(control);
        }
      }
    }
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
      turnId: this.deps.turnId
    });
    const pendingByCallId = new Map(pending.map((entry) => [entry.toolCallId, entry]));
    for (const call of this.calls.values()) {
      const admission = await this.deps.effects.readNativeAdmission(call.toolCallId);
      call.admitted = admission !== undefined;
      const pendingEntry = pendingByCallId.get(call.toolCallId);
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
      if (call.admitted && !call.settled) {
        // Never re-executes committed effects: the dispatcher reconciles its own durable frontier.
        this.scheduleExecution(call);
      }
    }
    for (const receipt of await this.deps.modelProvider.nativeSteering.receiptsForTurn(this.deps.turnId)) {
      this.steerReceipts.set(receipt.submissionId, receipt);
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
   * Pure peek at the chain-global call ordinal for the next call of one response: call counts of
   * every earlier response plus this response's count so far. Observation order across the logical
   * chain matches the terminal aggregate's call array order; provider-local ordinals are never
   * used as identity.
   */
  private nextGlobalCallOrdinal(responseId: string): number {
    let ordinal = 0;
    for (const id of this.responseOrder) {
      if (id === responseId) break;
      ordinal += this.responseCallCounts.get(id) ?? 0;
    }
    return ordinal + (this.responseCallCounts.get(responseId) ?? 0);
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
    const resolution = this.callResolutions.get(item.call.id)
      ?? { ...this.deps.resolveCallArguments(item.call.name, item.call.arguments), catalog: this.currentModelHandleCatalog() };
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
      providerOrdinal: this.nextGlobalCallOrdinal(responseId),
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
    const localCallIndex = this.responseCallCounts.get(responseId) ?? 0;
    const providerOrdinal = this.nextGlobalCallOrdinal(responseId);
    const toolCallId = this.deps.toolCallIdFor(providerOrdinal, item.call.id, item.call.name);
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
        this.firstResponseId ??= content.responseId;
        if (content.capabilities) {
          await this.deps.modelProvider.persistNativeCapabilities(
            this.deps.modelRequestId,
            this.requireStream().attemptSeq,
            this.requireStream().socketGeneration,
            content.capabilities
          );
        }
        // A successor created after an accepted steer proves application: the steering user
        // Message enters Context exactly once and the receipt becomes 'continuing'.
        const previousResponseId = content.previousResponseId;
        if (previousResponseId) {
          for (const receipt of [...this.steerReceipts.values()]) {
            if (receipt.state !== 'accepted' && receipt.state !== 'waiting_for_input') continue;
            if (receipt.targetResponseId !== previousResponseId && receipt.responseId !== previousResponseId) {
              continue;
            }
            const next = await this.deps.modelProvider.nativeSteering.applyToContext({
              turnId: this.deps.turnId,
              commandId: receipt.submissionId,
              responseId: content.responseId
            });
            this.steerReceipts.set(next.submissionId, next);
            this.emitSteering(next);
          }
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
        return;
      }
      case 'response.steer.disconnected': {
        const commandId = content.submissionId;
        if (!commandId) return;
        const receipt = this.steerReceipts.get(commandId);
        if (!receipt || receipt.state === 'continuing' || receipt.state === 'completed') return;
        if (receipt.state !== 'sent' && receipt.state !== 'accepted' && receipt.state !== 'waiting_for_input') {
          return;
        }
        // Sent-unacked or accepted-unapplied: retain body/status, never auto-resend.
        await this.transitionSteer(commandId, ['sent', 'accepted', 'waiting_for_input'], 'delivery_unknown');
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
    if (outcome !== 'completed') {
      for (const call of this.calls.values()) {
        if (!call.admitted || call.settled) continue;
        await this.deps.closeAdmittedCall(
          call.toolCallId,
          `agent-loop:${this.deps.modelRequestId}:native-chain-${outcome}:${call.toolCallId}`
        );
        call.settled = true;
        const terminal = await this.deps.effects.readTerminalResult(call.toolCallId, false);
        call.toolModelResultId = terminal?.toolModelResultId;
        if (call.toolModelResultId && !call.resultOccurrence) {
          await this.appendResultOccurrence(call);
        }
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
  }

  private async steerCommand(command: NativeSteerCommand): Promise<NativeSteeringReceipt> {
    if (!this.deps.capabilities.steering) {
      throw new Error('Native steering is not enabled for this request.');
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
    try {
      await controller.steer({
        submissionId: command.commandId,
        input: [command.content],
        ...(previousResponseId ? { previousResponseId } : {})
      });
    } catch (error) {
      if (isOpenAIResponsesNativeDeliveryError(error) && error.disposition === 'not_sent') {
        // Never wire-written: the durable submission stays queued and resubmission is safe.
        return receipt;
      }
      throw error;
    }
    if (this.controller !== controller) return receipt;
    const sent = await this.transitionSteer(command.commandId, ['queued'], 'sent');
    return sent ?? receipt;
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
      const ready = this.collectDeliverable();
      if (ready.length === 0) return;
      if (await this.yieldAtRuntimeInputBoundary(ready)) return;
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
      // The batch stays in-flight until the admission commit lands via the checkpointed
      // response.created carrying admittedToolResultCallIds — never marked from this promise alone.
      for (const call of ready) this.inFlightDeliveries.add(call.toolCallId);
      try {
        await controller.submitToolResults(outputs);
      } catch (error) {
        for (const call of ready) this.inFlightDeliveries.delete(call.toolCallId);
        if (!isOpenAIResponsesNativeDeliveryError(error)) throw error;
        // Every rejection surfaces honestly: nothing is marked, the settled result stays
        // recoverable, and only future proven events (settlement/boundary/registration) may
        // re-drive delivery — never a timer loop bypassing frozen retry policy.
        this.diagnose(`native result delivery ${error.disposition}: ${error.message}`);
        return;
      }
      if (!this.pumpDirty && this.collectDeliverable().length === 0) return;
    }
  }

  /**
   * Peer/runtime data cannot use the user-steering channel. At a completed physical response with
   * all tools settled, close the transport chain normally and let the next ModelRequest absorb
   * RuntimeDelivery through the existing context authority. No tool is cancelled and no provider
   * ACK is invented: undelivered results are retained in Context for the carrier request.
   */
  private async yieldAtRuntimeInputBoundary(ready: readonly NativeSessionCall[]): Promise<boolean> {
    const latestResponseId = this.responseOrder[this.responseOrder.length - 1];
    const latest = latestResponseId ? this.responses.get(latestResponseId) : undefined;
    if (!latest?.admissionBoundary || !latest.boundarySeq || this.inFlightDeliveries.size > 0
      || [...this.calls.values()].some(call => !call.admitted || !call.settled)
      || [...this.steerReceipts.values()].some(receipt =>
        ['queued', 'sent', 'accepted', 'waiting_for_input'].includes(receipt.state))) return false;
    const pending = await this.deps.database.snapshot([
      DOMAIN_REPOSITORIES.domain('RuntimeDelivery').list({
        where: { target_turn_id: this.deps.turnId, phase: 'current_turn', state: 'pending' }, limit: 1
      }),
      DOMAIN_REPOSITORIES.domain('PendingTurnInput').list({
        where: { turn_id: this.deps.turnId, input_kind: 'runtime_delivery', state: 'pending' }, limit: 1
      })
    ]);
    if (!pending.snapshot.some(value => Array.isArray(value) && value.length > 0)) return false;
    const controller = this.controller;
    if (!controller || this.disposed) return false;
    for (const call of ready) {
      // Reserve refs before another request can rebuild from these newly retained results.
      await this.buildFunctionCallOutput(call);
      await this.appendResultOccurrence(call);
    }
    if (this.controller !== controller || this.disposed) return false;
    this.yieldingForRuntimeInput = true;
    controller.endLogicalRequest();
    this.diagnose('Native logical request yielded at a settled tool boundary for pending runtime input.');
    return true;
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
        if (call.admitted && call.settled && !call.delivered && !this.inFlightDeliveries.has(call.toolCallId)) {
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
    if (['run_agent', 'read_agent_answer', 'submit_agent_answer', 'submit_plan'].includes(call.name)
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
  private async transitionSteer(
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
