import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { normalizeLlmCompressionMaxDurationMinutes, type AttachmentCatalogEntry } from '../../shared/protocol';
import {
  collectAttachmentCatalogFromStoredItems,
  mergeAttachmentCatalog,
  normalizeAttachmentCatalogState,
  type AttachmentCatalogState
} from './attachmentCatalog';
import {
  AttachmentCatalogProjection,
  type AttachmentCatalogProjectionSegment
} from './attachmentCatalogProjection';
import {
  ConversationAttachmentHandleRegistry,
  type ConversationAttachmentHandleProjection
} from './conversationAttachmentHandles';
import {
  ContentAddressedStore,
  type ContentObjectIdentity,
  type ContentObjectMetadata
} from './contentAddressedStore';
import { preparedContentObjectSteps } from './contentObjectTransaction';
import { ContextSequenceControlPlane } from './contextSequence';
import {
  estimateRequestAuthorityTokens,
  ReliableContextTokenEstimator
} from './contextTokenEstimator';
import {
  calculateFullRequestPlanningBudget,
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  preflightCompressionRequest,
  type ContextPlanningFailureCode,
  type FullRequestPlanningBudget,
  type ProjectedRequestTokenBreakdown
} from './modelFacingContextProjection';
import { canonicalPlainJson, normalizePlainJson, type PlainJsonValue } from './plainJson';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { listAllDomainRows } from './repositoryPagination';
import { RuntimeDatabase } from './runtimeDatabase';
import {
  MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT,
  MODEL_STREAM_OUTPUT_DELTA_CHECKPOINT_LIMIT,
  type ContextModelSource,
  type ModelRequestCancelResult
} from './databaseWorkerProtocol';
import {
  frozenCompressionPolicy,
  frozenContextProfile,
  frozenModelIdentity,
  frozenModelSelection,
  frozenProviderRetryPolicy,
  readFrozenTurnAuthority,
  type FrozenProviderRetryPolicy
} from './frozenAuthority';
import {
  applyRequestCompressionSettings,
  readRequestTurnAuthority,
  type CompressionSettingsAuthority
} from './requestCompressionSettings';
import {
  ExecutionHandoffError,
  handoffReason,
  isExecutionHandoffError,
  runWithExecutionLeaseFence,
  type ExecutionLeaseFence
} from './executionLeaseFence';
import type { OpenAIResponsesNativeHooks } from '../capabilities/openAIResponsesNativeControl';
import type {
  OpenAIResponsesNativeCapabilities,
  OpenAIResponsesToolOutput
} from '../../shared/openAIResponsesNative';
import type { MessageContent } from '../../shared/protocol';
import {
  NativeSteeringStore,
  type NativeSteeringReceipt,
  type NativeSteeringUpdate
} from './nativeSteering';
import { TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION } from './nativeToolFacts';
import type { AttachmentIngestService } from './attachmentIngest';

export interface CreateModelRequestCommand {
  turnId: string;
  contextRootId: string;
  authoritySnapshotId: string;
  recipe: PlainJsonValue;
  settingsSnapshotContentObjectId?: string;
  /** Exact adapter projection estimate frozen by the ordinary request planner. */
  projectedEstimatedTokens?: number;
  idempotencyKey: string;
}

export interface ModelRequestCreationResult {
  modelRequestId: string;
  projectionId: string;
  operationId: string;
  attemptId: string;
  requestSeq: string;
  commitSeq?: string;
  deduplicated: boolean;
}

export interface FullProviderContextItem {
  segmentId: string;
  segmentKind: string;
  messageRole: string | null;
  modelSource?: ContextModelSource;
  contentType: string;
  content: string;
}

export interface FullProviderRequest {
  kind: 'full-model-request';
  modelRequestId: string;
  conversationId: string;
  attemptSeq: string;
  socketGeneration: string;
  requestCreatedAt?: number;
  providerId: string;
  modelId: string;
  authoritySnapshot: PlainJsonValue;
  settingsSnapshot?: PlainJsonValue;
  recipe: PlainJsonValue;
  context: FullProviderContextItem[];
  /** Frozen relation-derived model state; never persisted in Context or compression envelopes. */
  attachmentCatalogState: AttachmentCatalogState;
  /**
   * Provider call ids of durably native-admitted ToolCalls of this Conversation. The Provider
   * requires capability + historical async evidence + membership in this list before projecting
   * async-marked call items; populated only for native-frozen requests.
   */
  nativeAsyncAdmittedCallIds?: readonly string[];
  requestAddenda?: {
    currentTurnInput?: {
      messageId: string;
      messageRevisionId: string;
      contentObjectId: string;
      reinject: boolean;
      contentType: string;
      content: string;
    };
    turnReminder?: {
      content: string;
      taskCardSha256?: string;
      unfinishedTaskCount: number;
      activeChildCount: number;
      runningProcessCount: number;
    };
  };
}

export type ProviderOutputStreamEventKind = 'output_delta' | 'output_item_done' | 'completed' | 'native_control';
export const PROVIDER_PARTIAL_OUTPUT_SNAPSHOT_TYPE = 'partial_output_snapshot';
export type ProviderTransientTerminalEventKind = 'failed' | 'cancelled';
export type ProviderStreamEventKind = ProviderOutputStreamEventKind | ProviderTransientTerminalEventKind;

export interface ProviderStreamEvent {
  kind: ProviderStreamEventKind;
  streamSeq: string | bigint;
  content: PlainJsonValue;
  usage?: PlainJsonValue;
  timing?: ProviderStreamTiming;
  /** Process-local signal: false for synthetic clocks such as thought_progress. Never persisted. */
  semanticProgress?: boolean;
}

/** Native control is durable authority, never a client transient replay event. */
export type ProviderTransientStreamEvent = Omit<ProviderStreamEvent, 'kind'> & {
  kind: Exclude<ProviderStreamEventKind, 'native_control'>;
};

export interface ProviderStreamTiming {
  providerStartedAt?: number;
  firstOutputAt?: number;
  completedAt?: number;
  streamOutputDurationMs?: number;
}

export interface ProviderOutputStreamEvent extends ProviderStreamEvent {
  kind: ProviderOutputStreamEventKind;
}

export interface ProviderTransientTerminalObservation {
  attemptSeq: string;
  socketGeneration: string;
  event: ProviderStreamEvent & { kind: ProviderTransientTerminalEventKind };
}

export interface ProviderDispatchControls {
  signal?: AbortSignal;
  /** Process-local Astra native hooks; forwarded by the Provider adapter, never serialized. */
  native?: OpenAIResponsesNativeHooks;
  onEvent(event: ProviderOutputStreamEvent): Promise<StreamEventResult>;
  onCompressionProgress?(streamSeq: string | bigint): Promise<void>;
}

export interface FullRequestProviderAdapter {
  /** Identifies the frozen provider configuration this adapter serves. */
  providerId: string;
  /** Optional exact projection hook. Production adapters use the same projected input for this and send. */
  estimateFullRequestInput?(request: FullProviderRequest): ProjectedRequestTokenBreakdown;
  sendFullRequest(request: FullProviderRequest, controls: ProviderDispatchControls): Promise<void>;
  /**
   * Astra native tool-result wire conversion with original call identity. Required on the native
   * path: managed image/file blocks become valid Responses input blocks; text passes through;
   * unresolvable references throw (never a silent JSON.stringify fallback).
   */
  materializeNativeToolOutput?(
    outputs: readonly OpenAIResponsesToolOutput[]
  ): Promise<readonly OpenAIResponsesToolOutput[]>;
}

export class ModelRequestPreflightError extends Error {
  public constructor(
    public readonly code: ContextPlanningFailureCode,
    message: string,
    public readonly estimatedTokens: number,
    public readonly limitTokens: number
  ) {
    super(message);
    this.name = 'ModelRequestPreflightError';
  }
}

export interface ProviderDispatchOptions {
  signal?: AbortSignal;
  reconnect?: boolean;
  /** Last-resort adapter deadline; transport-specific watchdogs should normally fire first. */
  timeoutMs?: number;
  /** Memory-only terminal overlay, emitted only after the matching durable failure/cancel fact. */
  onTransientTerminal?(observation: ProviderTransientTerminalObservation): void;
}

const DEFAULT_PROVIDER_DISPATCH_TIMEOUT_MS = 20 * 60 * 1_000;
// 思考型模型（kimi-k3 等）在大上下文 prefill / 反代网关缓冲下，首个语义事件与思考间隙可长达数分钟。
// 误杀代价不可恢复（已收到输出后不重放，部分输出作废且手动重新生成会撞同一堵墙）；
// 真死连接仍由 20 分钟 dispatch 超时兼底，用户也可手动取消。因此默认值向宽容侧倾斜。
const DEFAULT_PROVIDER_FIRST_SEMANTIC_TIMEOUT_MS = 300_000;
const DEFAULT_PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS = 600_000;
const DEFAULT_PROVIDER_ACTIVITY_HEARTBEAT_MS = 5_000;
const DEFAULT_COMPRESSION_COMPLETION_TIMEOUT_MS = 4.5 * 60 * 1_000;
const DEFAULT_PROVIDER_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const;
const DEFAULT_ADAPTER_DRAIN_TIMEOUT_MS = 1_000;

export interface ProviderSemanticTimeouts {
  firstSemanticMs: number;
  semanticIdleMs: number;
  compressionCompletionMs: number;
}

/** Public machine-readable defaults; formal validators keep these aligned with the contracts. */
export const RELIABLE_PROVIDER_SEMANTIC_DEADLINES_MS = Object.freeze({
  ordinaryFirst: DEFAULT_PROVIDER_FIRST_SEMANTIC_TIMEOUT_MS,
  ordinaryIdle: DEFAULT_PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS,
  compressionCompletion: DEFAULT_COMPRESSION_COMPLETION_TIMEOUT_MS
});

export interface ProviderDispatchResult {
  modelRequestId: string;
  attemptSeq: string;
  socketGeneration: string;
  terminalState?: string;
  superseded?: true;
}

export interface StreamEventResult {
  accepted: boolean;
  checkpointed: boolean;
  terminal: boolean;
  ignoredReason?: 'old-attempt' | 'old-socket-generation' | 'terminal' | 'checkpoint-capacity' | 'duplicate' | 'coalesced';
}

export interface CompletedModelRequestEvent {
  content: PlainJsonValue;
  usage?: PlainJsonValue;
}

/** One-object steering command; content is a single full MessageContent (composer attachments included). */
export interface NativeSteerCommand {
  commandId: string;
  conversationId: string;
  turnId: string;
  /** ExecutionLease generation captured by the caller's Turn view; proves the command targets the live owner. */
  leaseEpoch: string | bigint;
  content: MessageContent;
}

/** Registered by the Agent loop's native session while its dispatch owns a live native chain. */
export interface NativeSteeringSessionHandle {
  conversationId: string;
  turnId: string;
  modelRequestId: string;
  /** Execution authority captured when the native controller registered; never re-read later. */
  fence: ExecutionLeaseFence;
  steer(command: NativeSteerCommand): Promise<NativeSteeringReceipt>;
}

export type { NativeSteeringReceipt, NativeSteeringUpdate };

export type ProviderTransientReason =
  | 'connection_interrupted'
  | 'rate_limited'
  | 'temporary_service_error'
  | 'first_semantic_timeout'
  | 'stream_stalled'
  | 'compression_timeout';

export class ProviderTransientError extends Error {
  public constructor(
    public readonly reason: ProviderTransientReason,
    message: string,
    /** A new Attempt may replace partial output from the failed Attempt instead of appending to it. */
    public readonly retryAfterOutput = false
  ) {
    super(message);
    this.name = 'ProviderTransientError';
  }
}

type ModelStreamCheckpointKind =
  | 'output_delta'
  | 'output_item_done'
  | 'native_control'
  | 'native_tool_call'
  | 'partial_summary'
  | 'terminal_summary';

interface StreamStats {
  attemptSeq: string;
  socketGeneration: string;
  retryReason: ProviderTransientReason | null;
  retryMaxAttempts?: number;
  retryDelayMs?: number;
  retryNotBeforeAt?: number;
  providerStartedAt?: number;
  firstOutputAt?: number;
  completedAt?: number;
  streamOutputDurationMs?: number;
  /** Low-frequency metadata-only liveness marker; never contains Provider output bytes. */
  lastStreamSeq?: string;
  lastStreamEventAt?: number;
  /** Frozen native capability summary persisted from an accepted response.created; UI gating only. */
  nativeCapabilities?: OpenAIResponsesNativeCapabilities;
  /**
   * The FIRST physical response's actual usage.input_tokens of a native logical chain. Calibrates
   * the original ModelContextProjection root; never substituted by later/cumulative usage.
   */
  nativeInitialPromptTokenCount?: number;
}

interface StreamIdentity {
  attemptSeq: bigint;
  socketGeneration: bigint;
  stats: StreamStats;
}

interface StreamDurabilityState {
  outputDeltaCheckpointed: boolean;
  lastActivityPersistedAt: number;
}

interface FrozenAuthority {
  providerId: string;
  modelId: string;
  contextWindowTokens: number;
  compressionThresholdTokens: number;
  document: PlainJsonValue;
  compressionProviderId?: string;
  compressionModelId?: string;
  retryPolicy: FrozenProviderRetryPolicy;
  compressionRetryPolicy?: FrozenProviderRetryPolicy;
}

interface RequestBundle {
  request: DomainRow;
  operation: DomainRow;
  attempt: DomainRow;
  fence: DomainRow | null;
  turn: DomainRow;
}

interface CreationIdentity {
  turnId: string;
  contextRootId: string;
  authoritySnapshotId: string;
  providerId: string;
  modelId: string;
  contextWindowTokens: number;
  compressionThresholdTokens: number;
  estimatedContextTokens: number;
  settingsSnapshotContentObjectId: string | null;
  recipeIdentity: ContentObjectIdentity;
}

const CONTENT_TYPE_RECIPE = 'application/vnd.limcode.model-request-recipe+json';
const CONTENT_TYPE_CHECKPOINT = 'application/vnd.limcode.model-stream-checkpoint+json';

/** First-release provider path: each socket dispatch is rebuilt from one frozen root and immutable recipe. */
export class ModelProviderControlPlane {
  private readonly context: ContextSequenceControlPlane;
  private readonly attachmentCatalog: AttachmentCatalogProjection;
  private readonly attachmentHandles: ConversationAttachmentHandleRegistry;
  private readonly tokenEstimator: ReliableContextTokenEstimator;
  private readonly now: () => string;
  private readonly epochNow: () => number;
  private readonly semanticTimeouts: ProviderSemanticTimeouts;
  private readonly retryDelaysMs: readonly number[];
  private readonly adapterDrainTimeoutMs: number;
  private readonly compressionSettingsAuthority?: CompressionSettingsAuthority;
  private readonly activeSockets = new Map<string, Set<AbortController>>();
  private readonly activeDispatches = new Set<Promise<ProviderDispatchResult>>();
  private readonly nativeSessions = new Map<string, NativeSteeringSessionHandle>();
  private readonly steeringListeners = new Set<(update: NativeSteeringUpdate) => void>();
  /** Durable Astra steering submissions/receipts; shared with the Agent loop's native session. */
  public readonly nativeSteering: NativeSteeringStore;
  private handoff: ExecutionHandoffError | undefined;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    options: {
      now?: () => string;
      epochNow?: () => number;
      semanticTimeouts?: Partial<ProviderSemanticTimeouts>;
      retryDelaysMs?: readonly number[];
      adapterDrainTimeoutMs?: number;
      compressionSettingsAuthority?: CompressionSettingsAuthority;
      attachments?: AttachmentIngestService;
    } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.compressionSettingsAuthority = options.compressionSettingsAuthority;
    this.epochNow = options.epochNow ?? Date.now;
    this.semanticTimeouts = normalizeSemanticTimeouts(options.semanticTimeouts);
    this.retryDelaysMs = normalizeRetryDelays(options.retryDelaysMs);
    this.adapterDrainTimeoutMs = positiveSafeInteger(
      options.adapterDrainTimeoutMs ?? DEFAULT_ADAPTER_DRAIN_TIMEOUT_MS,
      'adapterDrainTimeoutMs'
    );
    this.context = new ContextSequenceControlPlane(database, contentStore, { now: this.now });
    this.attachmentCatalog = new AttachmentCatalogProjection(database);
    this.attachmentHandles = new ConversationAttachmentHandleRegistry(database, { now: this.now });
    this.tokenEstimator = new ReliableContextTokenEstimator(database, contentStore);
    this.nativeSteering = new NativeSteeringStore(database, contentStore, {
      now: this.now,
      ...(options.attachments ? { attachments: options.attachments } : {})
    });
  }

  public projectAttachmentCatalogState(
    conversationId: string,
    segments: readonly AttachmentCatalogProjectionSegment[],
    additionalMessageRevisionIds: readonly string[] = []
  ): Promise<AttachmentCatalogState> {
    return this.attachmentCatalog.projectState(conversationId, segments, additionalMessageRevisionIds);
  }

  public ensureAttachmentHandles(
    conversationId: string,
    catalog: readonly AttachmentCatalogEntry[]
  ): Promise<ConversationAttachmentHandleProjection> {
    return this.attachmentHandles.ensure(conversationId, catalog);
  }

  public async freezeRequestSettings(turnId: string, authoritySnapshotId: string): Promise<string | undefined> {
    if (!this.compressionSettingsAuthority) return undefined;
    const lastRead = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ModelRequest').list({
        where: { turn_id: turnId }, orderBy: { column: 'request_seq', direction: 'desc' }, limit: 1
      })
    ]);
    const last = rows(lastRead.snapshot[0])[0];
    if (last && last.terminal_state !== 'cancelled') {
      const recipeRow = await this.requireDomain('ContentObject', requireId(last.recipe_object_id, 'ModelRequest.recipe_object_id'));
      const recipe = parsePlainJson(await this.contentStore.read(asContentObjectMetadata(recipeRow)), 'ModelRequest recipe');
      // 普通请求尚未建立时的恢复，必须继续使用先行压缩已经固定的设置。
      if (isCompressionRecipe(recipe)) {
        return optionalId(last.settings_snapshot_object_id, 'ModelRequest.settings_snapshot_object_id') ?? undefined;
      }
    }
    const frozen = await readFrozenTurnAuthority(this.database, this.contentStore, authoritySnapshotId, turnId);
    const selected = await this.compressionSettingsAuthority.loadRequestCompressionSettings(frozenModelSelection(frozen.document));
    const snapshot = normalizePlainJson({ requestCompression: selected }, '请求压缩设置');
    applyRequestCompressionSettings(frozen.document, snapshot);
    const content = await this.contentStore.ingest(
      this.database, canonicalPlainJson(snapshot), 'application/vnd.limcode.model-request-settings+json'
    );
    return content.id;
  }

  public async createModelRequest(command: CreateModelRequestCommand): Promise<ModelRequestCreationResult> {
    const turnId = requireId(command.turnId, 'turnId');
    const contextRootId = requireId(command.contextRootId, 'contextRootId');
    const authoritySnapshotId = requireId(command.authoritySnapshotId, 'authoritySnapshotId');
    const idempotencyKey = requireText(command.idempotencyKey, 'idempotencyKey');
    const settingsSnapshotContentObjectId = command.settingsSnapshotContentObjectId === undefined
      ? null
      : requireId(command.settingsSnapshotContentObjectId, 'settingsSnapshotContentObjectId');
    const recipe = normalizeModelRequestRecipe(command.recipe, 'ModelRequest recipe');
    const recipeBytes = canonicalPlainJson(recipe, 'ModelRequest recipe');
    const recipeIdentity = this.contentStore.identity(recipeBytes, CONTENT_TYPE_RECIPE);
    const modelRequestId = modelRequestIdFor(turnId, idempotencyKey);
    const projectionId = stableId('model_request_projection', modelRequestId);
    const operationId = stableId('model_request_operation', modelRequestId);
    const attemptId = stableId('model_request_attempt', modelRequestId, '1');

    const frozen = await this.readFrozenAuthority(authoritySnapshotId, turnId, settingsSnapshotContentObjectId ?? undefined);
    if (settingsSnapshotContentObjectId) {
      const settingsRow = await this.requireDomain('ContentObject', settingsSnapshotContentObjectId);
      parsePlainJson(await this.contentStore.read(asContentObjectMetadata(settingsRow)), 'ModelRequest settings snapshot');
    }
    const compressionRequest = isCompressionRecipe(recipe);
    const compressionPolicy = compressionRequest ? frozenCompressionPolicy(frozen.document) : undefined;
    if (compressionRequest && !compressionPolicy) {
      throw new Error('Compression ModelRequest requires a frozen compression policy.');
    }
    const frozenProviderId = compressionRequest
      ? requireText(frozen.compressionProviderId, 'Frozen compression providerId')
      : frozen.providerId;
    const frozenModelId = compressionRequest
      ? requireText(frozen.compressionModelId, 'Frozen compression modelId')
      : frozen.modelId;
    const projectedEstimatedTokens = command.projectedEstimatedTokens === undefined
      ? undefined
      : requireNonNegativeSafeNumber(command.projectedEstimatedTokens, 'projectedEstimatedTokens');
    const identityBase = {
      turnId,
      contextRootId,
      authoritySnapshotId,
      providerId: frozenProviderId,
      modelId: frozenModelId,
      contextWindowTokens: compressionPolicy?.provider.contextWindowTokens ?? frozen.contextWindowTokens,
      compressionThresholdTokens: frozen.compressionThresholdTokens
    };
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Turn').get(turnId),
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').get(contextRootId)
    ]);
    const turn = requireRow(snapshot.snapshot[0], `Turn ${turnId}`);
    const contextRoot = requireRow(snapshot.snapshot[1], `ContextSequenceRoot ${contextRootId}`);
    if (contextRoot.conversation_id !== turn.conversation_id) {
      throw new Error('ContextSequenceRoot belongs to another Conversation.');
    }

    const contextEstimate: number = projectedEstimatedTokens ?? (compressionRequest
      ? await this.tokenEstimator.estimateRootPrefix(
          contextRootId,
          compressionSourceSegmentCount(recipe)
        )
      : await this.tokenEstimator.estimateRoot(contextRootId).then((estimate) =>
          estimate.estimatedTokens + (estimate.source === 'provider-observed-delta'
            ? 0
            : estimateRequestAuthorityTokens(frozen.document, recipe))
        ));
    const identity: CreationIdentity = {
      ...identityBase,
      estimatedContextTokens: contextEstimate,
      settingsSnapshotContentObjectId,
      recipeIdentity
    };
    const existing = await this.getOptional('ModelRequest', modelRequestId);
    if (existing) {
      return this.replayCreation(existing, modelRequestId, projectionId, operationId, attemptId, identity);
    }
    const recipeContent = await this.contentStore.prepare(this.database, recipeBytes, CONTENT_TYPE_RECIPE);
    const now = this.timestamp();
    const initialStats: StreamStats = { attemptSeq: '1', socketGeneration: '0', retryReason: null };
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('Turn').assert(turnId, { status: 'active' }),
      ...preparedContentObjectSteps([recipeContent], 'model_request_recipe'),
      DOMAIN_REPOSITORIES.domain('ModelRequest').insertWithNextSequence({
        id: modelRequestId,
        turn_id: turnId,
        status: 'prepared',
        terminal_state: null,
        provider_id: frozenProviderId,
        model_id: frozenModelId,
        context_window_tokens: BigInt(identity.contextWindowTokens),
        compression_threshold_tokens: BigInt(frozen.compressionThresholdTokens),
        estimated_context_tokens: BigInt(contextEstimate),
        authority_snapshot_id: authoritySnapshotId,
        settings_snapshot_object_id: settingsSnapshotContentObjectId,
        recipe_object_id: recipeContent.metadata.id,
        usage_json: null,
        stream_stats_json: initialStats,
        created_at: now,
        updated_at: now
      }, { column: 'request_seq', scope: { turn_id: turnId } }),
      DOMAIN_REPOSITORIES.domain('ModelContextProjection').insert({
        id: projectionId,
        owner_kind: 'model_request',
        owner_id: modelRequestId,
        root_id: contextRootId,
        purpose: 'provider-request',
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Operation').insertWithNextSequence({
        id: operationId,
        owner_kind: 'model_request',
        owner_id: modelRequestId,
        tool_call_id: null,
        status: 'pending',
        created_at: now,
        updated_at: now
      }, { column: 'operation_seq', scope: { owner_kind: 'model_request', owner_id: modelRequestId } }),
      DOMAIN_REPOSITORIES.domain('Attempt').insertWithNextSequence({
        id: attemptId,
        operation_id: operationId,
        status: 'pending',
        created_at: now,
        updated_at: now,
        completed_at: null
      }, { column: 'attempt_seq', scope: { operation_id: operationId } }),
      DOMAIN_REPOSITORIES.domain('Attempt').assert(attemptId, { attempt_seq: 1n })
    ];
    try {
      const commit = await this.database.transaction(steps);
      return {
        modelRequestId,
        projectionId,
        operationId,
        attemptId,
        requestSeq: allocatedValue(commit.allocatedSequences, 'ModelRequest', modelRequestId, 'request_seq'),
        commitSeq: commit.commitSeq,
        deduplicated: false
      };
    } catch (error) {
      if (!isRecoverableProviderRace(error)) throw error;
      const raced = await this.getOptional('ModelRequest', modelRequestId);
      if (!raced) throw error;
      return this.replayCreation(raced, modelRequestId, projectionId, operationId, attemptId, identity);
    }
  }

  private async buildFullRequest(
    modelRequestIdInput: string,
    attemptSeqInput: string | bigint,
    socketGenerationInput: string | bigint
  ): Promise<FullProviderRequest> {
    const modelRequestId = requireId(modelRequestIdInput, 'modelRequestId');
    const attemptSeq = decimalBigInt(attemptSeqInput, 'attemptSeq');
    const socketGeneration = decimalBigInt(socketGenerationInput, 'socketGeneration');
    const request = await this.requireDomain('ModelRequest', modelRequestId);
    const projection = await this.requireDomain('ModelContextProjection', stableId('model_request_projection', modelRequestId));
    if (projection.owner_kind !== 'model_request' || projection.owner_id !== modelRequestId) {
      throw new Error(`ModelRequest ${modelRequestId} has an invalid frozen Context projection.`);
    }
    const frozen = await readFrozenTurnAuthority(
      this.database,
      this.contentStore,
      requireId(request.authority_snapshot_id, 'ModelRequest.authority_snapshot_id'),
      requireId(request.turn_id, 'ModelRequest.turn_id')
    );
    const recipeContent = await this.requireDomain(
      'ContentObject', requireId(request.recipe_object_id, 'ModelRequest.recipe_object_id')
    );
    const settingsId = optionalId(request.settings_snapshot_object_id, 'ModelRequest.settings_snapshot_object_id');
    const settingsContent = settingsId ? await this.requireDomain('ContentObject', settingsId) : null;
    const materializeStartedAt = this.database.performanceMetrics ? performance.now() : undefined;
    const materialized = await this.context.materialize(requireId(projection.root_id, 'ModelContextProjection.root_id'));
    if (materializeStartedAt !== undefined) {
      this.database.recordPerformanceMetric({
        kind: 'context.materialize',
        mode: 'content',
        segmentCount: materialized.segments.length,
        durationMs: performance.now() - materializeStartedAt
      });
    }
    const contentRows = [recipeContent, ...(settingsContent ? [settingsContent] : [])];
    const bytes = await this.contentStore.readMany(contentRows.map(asContentObjectMetadata));
    const recipe = parsePlainJson(bytes[0], 'ModelRequest recipe');
    const settingsSnapshot = settingsContent ? parsePlainJson(bytes[1], 'ModelRequest settings snapshot') : undefined;
    const frozenAuthority = applyRequestCompressionSettings(frozen.document, settingsSnapshot);
    const contextConversationId = requireId(
      materialized.root.conversation_id,
      'ContextSequenceRoot.conversation_id'
    );
    if (contextConversationId !== frozen.conversationId) {
      throw new Error('Frozen Context projection belongs to another Conversation.');
    }
    const primaryModel = frozenModelIdentity(frozenAuthority);
    const compressionPolicy = isCompressionRecipe(recipe)
      ? frozenCompressionPolicy(frozenAuthority)
      : undefined;
    const frozenModel = compressionPolicy
      ? {
          providerId: compressionPolicy.provider.providerConfigId,
          modelId: compressionPolicy.provider.modelId
        }
      : primaryModel;
    if (frozenModel.providerId !== request.provider_id || frozenModel.modelId !== request.model_id) {
      throw new Error('Persisted ModelRequest provider/model no longer matches its frozen AuthoritySnapshot.');
    }
    const providerSegments = compressionRequestSegments(
      recipe,
      requireId(projection.root_id, 'ModelContextProjection.root_id'),
      materialized.segments
    );
    const requestCreatedAt = domainTimestampMs(request.created_at);
    const requestAddenda = await this.materializeRequestAddenda(
      recipe,
      requireId(request.turn_id, 'ModelRequest.turn_id')
    );
    const attachmentCatalogState = normalizeAttachmentCatalogState(
      isRecord(recipe) ? recipe.attachmentCatalogState : undefined,
      'ModelRequest recipe.attachmentCatalogState'
    );
    const nativeAdmittedCallIds = isRecord(recipe) && isRecord(recipe.nativeResponses)
      ? await this.listNativeAdmittedProviderCallIds(contextConversationId)
      : undefined;
    const providerContext = providerSegments.map((segment) => ({
      segmentId: segment.segmentId,
      segmentKind: segment.segmentKind,
      messageRole: segment.messageRole,
      ...(segment.modelSource ? { modelSource: segment.modelSource } : {}),
      contentType: segment.contentObject.content_type,
      content: decodeUtf8Exact(segment.content, `ContextSegment ${segment.segmentId}`)
    }));
    assertAttachmentProjectionCoverage(attachmentCatalogState.catalog, [
      ...providerContext,
      ...(requestAddenda.requestAddenda?.currentTurnInput
        ? [{
            content: requestAddenda.requestAddenda.currentTurnInput.content,
            contentType: requestAddenda.requestAddenda.currentTurnInput.contentType
          }]
        : [])
    ]);
    return {
      kind: 'full-model-request',
      modelRequestId,
      conversationId: frozen.conversationId,
      attemptSeq: attemptSeq.toString(),
      socketGeneration: socketGeneration.toString(),
      ...(requestCreatedAt === undefined ? {} : { requestCreatedAt }),
      providerId: frozenModel.providerId,
      modelId: frozenModel.modelId,
      authoritySnapshot: frozenAuthority,
      ...(settingsSnapshot === undefined ? {} : { settingsSnapshot }),
      recipe,
      context: providerContext,
      attachmentCatalogState,
      ...(nativeAdmittedCallIds !== undefined && nativeAdmittedCallIds.length > 0
        ? { nativeAsyncAdmittedCallIds: nativeAdmittedCallIds }
        : {}),
      ...requestAddenda
    };
  }

  /** Explicit dry-run/replay; it reads only the immutable request projection and CAS objects. */
  public async replay(modelRequestIdInput: string): Promise<FullProviderRequest> {
    const modelRequestId = requireId(modelRequestIdInput, 'modelRequestId');
    const request = await this.requireDomain('ModelRequest', modelRequestId);
    const stats = parseStreamStats(request.stream_stats_json);
    return this.buildFullRequest(modelRequestId, stats.attemptSeq, stats.socketGeneration);
  }

  /** Builds a deterministic ordinary request preview without allocating a ModelRequest sequence. */
  public async previewOrdinaryRequest(command: CreateModelRequestCommand): Promise<FullProviderRequest> {
    const turnId = requireId(command.turnId, 'turnId');
    const contextRootId = requireId(command.contextRootId, 'contextRootId');
    const authoritySnapshotId = requireId(command.authoritySnapshotId, 'authoritySnapshotId');
    const idempotencyKey = requireText(command.idempotencyKey, 'idempotencyKey');
    const recipe = normalizeModelRequestRecipe(command.recipe, 'ModelRequest preview recipe');
    if (isCompressionRecipe(recipe)) throw new TypeError('Ordinary request preview cannot use a compression recipe.');
    const [frozen, materialized] = await Promise.all([
      readRequestTurnAuthority(this.database, this.contentStore, authoritySnapshotId, turnId, command.settingsSnapshotContentObjectId),
      this.context.materialize(contextRootId)
    ]);
    if (requireId(materialized.root.conversation_id, 'ContextSequenceRoot.conversation_id') !== frozen.conversationId) {
      throw new Error('Preview Context projection belongs to another Conversation.');
    }
    const model = frozenModelIdentity(frozen.document);
    const requestAddenda = await this.materializeRequestAddenda(recipe, turnId);
    const attachmentCatalogState = normalizeAttachmentCatalogState(
      isRecord(recipe) ? recipe.attachmentCatalogState : undefined,
      'ModelRequest preview recipe.attachmentCatalogState'
    );
    const providerContext = materialized.segments.map((segment) => ({
      segmentId: segment.segmentId,
      segmentKind: segment.segmentKind,
      messageRole: segment.messageRole,
      ...(segment.modelSource ? { modelSource: segment.modelSource } : {}),
      contentType: segment.contentObject.content_type,
      content: decodeUtf8Exact(segment.content, `ContextSegment ${segment.segmentId}`)
    }));
    assertAttachmentProjectionCoverage(attachmentCatalogState.catalog, [
      ...providerContext,
      ...(requestAddenda.requestAddenda?.currentTurnInput
        ? [{
            content: requestAddenda.requestAddenda.currentTurnInput.content,
            contentType: requestAddenda.requestAddenda.currentTurnInput.contentType
          }]
        : [])
    ]);
    return {
      kind: 'full-model-request',
      modelRequestId: modelRequestIdFor(turnId, idempotencyKey),
      conversationId: frozen.conversationId,
      attemptSeq: '1',
      socketGeneration: '1',
      providerId: model.providerId,
      modelId: model.modelId,
      authoritySnapshot: frozen.document,
      recipe,
      context: providerContext,
      attachmentCatalogState,
      ...requestAddenda
    };
  }

  /** Planning and dispatch both invoke the adapter's exact projection hook. */
  public planFullRequest(
    fullRequest: FullProviderRequest,
    adapter: FullRequestProviderAdapter
  ): FullRequestPlanningBudget {
    if (adapter.providerId !== fullRequest.providerId) {
      throw providerConflict('Request preview adapter does not match its frozen provider.');
    }
    const compression = isCompressionRecipe(fullRequest.recipe)
      ? frozenCompressionPolicy(fullRequest.authoritySnapshot)
      : undefined;
    const context = frozenContextProfile(fullRequest.authoritySnapshot);
    const breakdown = adapter.estimateFullRequestInput?.(fullRequest)
      ?? fallbackRequestBreakdown(estimateFullProviderContextFallback(fullRequest));
    return calculateFullRequestPlanningBudget({
      contextWindowTokens: compression?.provider.contextWindowTokens ?? context.contextWindowTokens,
      maxOutputTokens: compression?.provider.maxOutputTokens
        ?? frozenPrimaryMaxOutputTokens(fullRequest.authoritySnapshot),
      compressionThresholdTokens: compression ? context.contextWindowTokens : context.compressionThresholdTokens,
      breakdown
    });
  }

  /** Reads the single fenced terminal checkpoint; callers never reconstruct results from transient deltas. */
  public async completedEvent(modelRequestIdInput: string): Promise<CompletedModelRequestEvent> {
    const modelRequestId = requireId(modelRequestIdInput, 'modelRequestId');
    const request = await this.requireDomain('ModelRequest', modelRequestId);
    if (request.status !== 'terminal' || request.terminal_state !== 'completed') {
      throw new Error(`ModelRequest ${modelRequestId} is not durably completed.`);
    }
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ModelStreamCheckpoint').list({
        where: { model_request_id: modelRequestId },
        limit: MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT + 1
      })
    ]);
    const terminal = rows(snapshot.snapshot[0])
      .filter((row) => row.checkpoint_kind === 'terminal_summary')
      .sort((left, right) => {
        const a = decimalBigInt(left.stream_seq, 'stream_seq');
        const b = decimalBigInt(right.stream_seq, 'stream_seq');
        return a < b ? 1 : a > b ? -1 : 0;
      })[0];
    if (!terminal) throw new Error(`ModelRequest ${modelRequestId} has no terminal checkpoint.`);
    const contentObject = await this.requireDomain(
      'ContentObject',
      requireId(terminal.content_object_id, 'ModelStreamCheckpoint.content_object_id')
    );
    const envelope = parsePlainJson(
      await this.contentStore.read(asContentObjectMetadata(contentObject)),
      'Model terminal checkpoint'
    );
    if (!isRecord(envelope) || envelope.kind !== 'completed') {
      throw new Error(`ModelRequest ${modelRequestId} terminal checkpoint is not completed.`);
    }
    return {
      content: normalizePlainJson(envelope.content, 'Model terminal checkpoint content'),
      ...(envelope.usage === undefined
        ? {}
        : { usage: normalizePlainJson(envelope.usage, 'Model terminal checkpoint usage') })
    };
  }

  public async dispatch(
    modelRequestIdInput: string,
    adapter: FullRequestProviderAdapter,
    options: ProviderDispatchOptions = {}
  ): Promise<ProviderDispatchResult> {
    if (this.handoff) throw this.handoff;
    const task = this.dispatchRequest(modelRequestIdInput, adapter, options);
    this.activeDispatches.add(task);
    try {
      return await task;
    } finally {
      this.activeDispatches.delete(task);
    }
  }

  /** Cancels only non-terminal ModelRequests owned by one Turn; sibling Turns keep streaming. */
  public async cancelTurnDispatches(turnIdInput: string, reason = 'turn-interrupt-requested'): Promise<number> {
    const turnId = requireId(turnIdInput, 'turnId');
    const requests = await listAllDomainRows(this.database, 'ModelRequest', { turn_id: turnId });
    const active = requests.filter((row) => row.status !== 'terminal');
    await Promise.all(active.map((row) => this.cancel(
      requireId(row.id, 'ModelRequest.id'),
      requireText(reason, 'cancel reason')
    )));
    return active.length;
  }

  /** Stops transient provider work and waits until every dispatch has durably observed cancellation. */
  public async abortAllActiveDispatches(): Promise<void> {
    for (const sockets of this.activeSockets.values()) {
      for (const controller of sockets) controller.abort();
    }
    await Promise.allSettled([...this.activeDispatches]);
  }

  /** Aborts only process-local sockets; the ModelRequest remains resumable for another Host. */
  public async quiesceTurnDispatches(
    turnIdInput: string,
    reason = new ExecutionHandoffError()
  ): Promise<number> {
    const turnId = requireId(turnIdInput, 'turnId');
    const requests = await listAllDomainRows(this.database, 'ModelRequest', { turn_id: turnId });
    let aborted = 0;
    for (const request of requests) {
      const active = this.activeSockets.get(requireId(request.id, 'ModelRequest.id'));
      for (const controller of active ?? []) {
        if (controller.signal.aborted) continue;
        controller.abort(reason);
        aborted += 1;
      }
    }
    return aborted;
  }

  /** Host shutdown uses handoff, never persistent Provider cancellation. */
  public async quiesceAllActiveDispatches(
    reason = new ExecutionHandoffError()
  ): Promise<void> {
    this.handoff = reason;
    for (const sockets of this.activeSockets.values()) {
      for (const controller of sockets) {
        if (!controller.signal.aborted) controller.abort(reason);
      }
    }
    await Promise.allSettled([...this.activeDispatches]);
  }

  /**
   * Agent-loop native sessions register while their dispatch owns a live chain. Returns the
   * unregister callback; registration is identity-checked so a stale stream never evicts a newer one.
   */
  public registerNativeSteeringSession(handle: NativeSteeringSessionHandle): () => void {
    const existing = this.nativeSessions.get(handle.turnId);
    if (existing && existing.modelRequestId !== handle.modelRequestId) {
      throw providerConflict(`Turn ${handle.turnId} already has an active native steering session.`);
    }
    this.nativeSessions.set(handle.turnId, handle);
    return () => {
      if (this.nativeSessions.get(handle.turnId) === handle) this.nativeSessions.delete(handle.turnId);
    };
  }

  /**
   * UI steering commands run outside the Agent loop's AsyncLocalStorage fence. Validate the payload
   * against the session's captured owner token, then execute every write under that exact fence.
   */
  public async steer(command: NativeSteerCommand): Promise<NativeSteeringReceipt> {
    const commandId = requireText(command.commandId, 'NativeSteerCommand.commandId');
    const turnId = requireId(command.turnId, 'NativeSteerCommand.turnId');
    const conversationId = requireId(command.conversationId, 'NativeSteerCommand.conversationId');
    const handle = this.nativeSessions.get(turnId);
    if (!handle) {
      throw new Error(`Turn ${turnId} has no active native steering session.`);
    }
    if (handle.conversationId !== conversationId) {
      throw new Error('Native steering command Conversation does not match the active session.');
    }
    if (handle.fence.generation.toString() !== String(command.leaseEpoch)) {
      throw new Error('Native steering command lease epoch does not match the active Turn owner.');
    }
    return runWithExecutionLeaseFence(handle.fence, () =>
      handle.steer({ ...command, commandId, turnId, conversationId })
    );
  }

  /** Reload/status view: every durable steering receipt of one Conversation, oldest first. */
  public steeringReceipts(conversationId: string): Promise<NativeSteeringReceipt[]> {
    return this.nativeSteering.receiptsForConversation(requireId(conversationId, 'conversationId'));
  }

  /** Process-local steering broadcast; fires only after the matching durable commit. */
  public subscribeSteering(listener: (update: NativeSteeringUpdate) => void): () => void {
    this.steeringListeners.add(listener);
    return () => {
      this.steeringListeners.delete(listener);
    };
  }

  /** Called by the Agent loop's native session after each durable steering commit. */
  public emitNativeSteeringUpdate(update: NativeSteeringUpdate): void {
    for (const listener of this.steeringListeners) {
      try {
        listener(update);
      } catch {
        // Observation must never become a second control path.
      }
    }
  }

  private async dispatchRequest(
    modelRequestIdInput: string,
    adapter: FullRequestProviderAdapter,
    options: ProviderDispatchOptions
  ): Promise<ProviderDispatchResult> {
    const modelRequestId = requireId(modelRequestIdInput, 'modelRequestId');
    if (!adapter || typeof adapter.sendFullRequest !== 'function') {
      throw new TypeError('Provider adapter must implement sendFullRequest.');
    }
    const adapterProviderId = requireText(adapter.providerId, 'Provider adapter.providerId');
    let request = await this.requireDomain('ModelRequest', modelRequestId);
    let stats = parseStreamStats(request.stream_stats_json);
    if (request.status === 'terminal') throw new Error('Terminal ModelRequest cannot be dispatched.');
    if (adapterProviderId !== request.provider_id) {
      throw providerConflict(`Provider adapter ${adapterProviderId} does not match frozen provider ${String(request.provider_id)}.`);
    }
    if (options.reconnect !== true && stats.socketGeneration !== '0') {
      throw new Error('ModelRequest was already dispatched; use reconnect explicitly.');
    }

    let attemptSeq = decimalBigInt(stats.attemptSeq, 'ModelRequest attemptSeq');
    let retryPolicy: FrozenProviderRetryPolicy | undefined;
    for (;;) {
      const pendingIdentity: StreamIdentity = {
        attemptSeq,
        socketGeneration: decimalBigInt(stats.socketGeneration, 'socketGeneration'),
        stats
      };
      if (stats.retryNotBeforeAt !== undefined && stats.retryNotBeforeAt > this.epochNow()) {
        const delayController = new AbortController();
        const detachCallerSignal = relayAbort(options.signal, delayController);
        const unregister = this.registerActiveSocket(modelRequestId, delayController);
        const abortWaiter = createAbortWaiter(delayController.signal);
        const delayWaiter = createRetryDelayWaiter(stats.retryNotBeforeAt, this.epochNow);
        try {
          await Promise.race([
            delayWaiter.promise,
            abortWaiter.promise
          ]);
        } finally {
          delayWaiter.dispose();
          abortWaiter.dispose();
          detachCallerSignal();
          unregister();
        }
        if (delayController.signal.aborted) {
          const handoff = handoffReason(delayController.signal);
          if (handoff) throw handoff;
          const cancelled = await this.cancelCurrentRequest(modelRequestId, 'cancelled-during-provider-retry-delay');
          return this.finishCancelledDispatch(modelRequestId, pendingIdentity, cancelled, options, 0n);
        }
        request = await this.requireDomain('ModelRequest', modelRequestId);
        const currentStats = parseStreamStats(request.stream_stats_json);
        if (request.status === 'terminal' || !sameStats(currentStats, stats)) {
          return this.finishResolvedDispatch(modelRequestId, pendingIdentity, options, 0n);
        }
      }

      if (options.signal?.aborted) {
        const handoff = handoffReason(options.signal);
        if (handoff) throw handoff;
        const cancelled = await this.cancelCurrentRequest(modelRequestId, 'cancelled-before-provider-dispatch');
        return this.finishCancelledDispatch(modelRequestId, pendingIdentity, cancelled, options, 0n);
      }
      const currentIdentity: StreamIdentity = {
        attemptSeq,
        socketGeneration: decimalBigInt(stats.socketGeneration, 'socketGeneration'),
        stats
      };
      const expectedGeneration = currentIdentity.socketGeneration + 1n;
      let fullRequest: FullProviderRequest;
      try {
        fullRequest = await this.buildFullRequest(modelRequestId, attemptSeq, expectedGeneration);
        this.assertRequestPreflight(request, fullRequest, adapter);
        retryPolicy ??= retryPolicyForFullRequest(fullRequest);
      } catch (error) {
        const applied = await this.failRequest(modelRequestId, currentIdentity, error);
        if (applied) {
          this.emitTransientTerminal(options, currentIdentity, 'failed', 1n, providerFailureTerminalState(error));
        }
        throw error;
      }
      const identity = await this.openSocketGeneration(modelRequestId, attemptSeq, stats);
      let lastObservedStreamSeq = 0n;
      let sawReplayUnsafeProviderEvent = false;
      const controller = new AbortController();
      const detachCallerSignal = relayAbort(options.signal, controller);
      const unregister = this.registerActiveSocket(modelRequestId, controller);
      const abortWaiter = createAbortWaiter(controller.signal);
      const compression = isCompressionRecipe(fullRequest.recipe);
      const configuredTimeoutMs = compression
        ? normalizeLlmCompressionMaxDurationMinutes(
            frozenCompressionPolicy(fullRequest.authoritySnapshot)?.config.maxDurationMinutes
          ) * 60_000
        : DEFAULT_PROVIDER_DISPATCH_TIMEOUT_MS;
      const timeoutWaiter = createProviderTimeoutWaiter(
        options.timeoutMs ?? configuredTimeoutMs
      );
      const progressWaiter = compression
        ? createCompressionProgressWaiter(this.semanticTimeouts.compressionCompletionMs)
        : createSemanticProgressWaiter({
            firstSemanticMs: this.semanticTimeouts.firstSemanticMs,
            semanticIdleMs: this.semanticTimeouts.semanticIdleMs
          });
      // Native logical requests span physical response boundaries; between a boundary and the next
      // response.created the server intentionally waits for our tool results/steering, and the
      // client lane-admission queue may hold this request before its first response.created.
      // Both are proven local/server waits: suspend the idle watchdog, never the total deadline.
      const nativeRequest = !compression
        && isRecord(fullRequest.recipe)
        && isRecord(fullRequest.recipe.nativeResponses);
      const nativeWait = { boundary: false, laneQueue: false, suspended: false };
      const updateNativeWaitSuspension = (next: Partial<{ boundary: boolean; laneQueue: boolean }>): void => {
        if (!nativeRequest) return;
        if (next.boundary !== undefined) nativeWait.boundary = next.boundary;
        if (next.laneQueue !== undefined) nativeWait.laneQueue = next.laneQueue;
        const shouldSuspend = nativeWait.boundary || nativeWait.laneQueue;
        if (shouldSuspend === nativeWait.suspended) return;
        nativeWait.suspended = shouldSuspend;
        if (shouldSuspend) {
          (progressWaiter as SemanticProgressWaiter).suspend();
        } else {
          (progressWaiter as SemanticProgressWaiter).resume();
        }
      };
      const streamDurability: StreamDurabilityState = {
        outputDeltaCheckpointed: false,
        lastActivityPersistedAt: this.epochNow() - (compression ? DEFAULT_PROVIDER_ACTIVITY_HEARTBEAT_MS : 0)
      };
      const adapterOutcome = Promise.resolve()
        .then(() => adapter.sendFullRequest(fullRequest, {
          signal: controller.signal,
          ...(nativeRequest
            ? {
                native: {
                  onLaneQueueState: (queued: boolean) =>
                    updateNativeWaitSuspension({ laneQueue: queued === true })
                }
              }
            : {}),
          ...(compression ? {
            onCompressionProgress: async (streamSeq: string | bigint) => {
              if (controller.signal.aborted) return;
              const observedSeq = decimalBigInt(streamSeq, 'Provider compression progress streamSeq');
              if (observedSeq <= lastObservedStreamSeq) return;
              lastObservedStreamSeq = observedSeq;
              progressWaiter.observeProgress();
              await this.persistStreamActivityIfDue(
                modelRequestId,
                identity.attemptSeq,
                identity.socketGeneration,
                observedSeq,
                this.epochNow(),
                streamDurability
              );
            }
          } : {}),
          onEvent: async (event) => {
            const observedSeq = decimalBigInt(event.streamSeq, 'Provider event streamSeq');
            if (observedSeq > lastObservedStreamSeq) lastObservedStreamSeq = observedSeq;
            // Control acknowledgments never count as semantic progress; a proven input-wait
            // suspends the idle watchdog until the next response.created proves server activity.
            let semanticProgress = event.semanticProgress !== false;
            if (event.kind === 'native_control') {
              semanticProgress = false;
              if (nativeRequest) {
                const controlType = isRecord(event.content) ? event.content.type : undefined;
                if (controlType === 'response.completed' || controlType === 'response.incomplete') {
                  updateNativeWaitSuspension({ boundary: true });
                } else if (controlType === 'response.created') {
                  updateNativeWaitSuspension({ boundary: false, laneQueue: false });
                }
              }
            }
            if (semanticProgress) {
              sawReplayUnsafeProviderEvent = true;
              progressWaiter.observeProgress();
            }
            return this.recordDispatchStreamEvent(
              modelRequestId,
              identity.attemptSeq,
              identity.socketGeneration,
              event,
              semanticProgress,
              streamDurability
            );
          }
        }))
        .then(
          () => ({ kind: 'resolved' as const }),
          (error: unknown) => ({ kind: 'rejected' as const, error })
        );
      let outcome: Awaited<typeof adapterOutcome>
        | { kind: 'aborted' }
        | { kind: 'timed_out'; error: ProviderTransientError }
        | { kind: 'semantic_timed_out'; error: ProviderTransientError };
      try {
        outcome = await Promise.race([
          adapterOutcome,
          abortWaiter.promise,
          timeoutWaiter.promise,
          progressWaiter.promise
        ]);
      } finally {
        abortWaiter.dispose();
        timeoutWaiter.dispose();
        progressWaiter.dispose();
        detachCallerSignal();
        unregister();
      }
      if (outcome.kind === 'aborted') {
        const handoff = handoffReason(controller.signal);
        if (handoff) throw handoff;
        const cancelled = await this.cancelCurrentRequest(modelRequestId, 'cancelled-during-provider-dispatch');
        return this.finishCancelledDispatch(modelRequestId, identity, cancelled, options, lastObservedStreamSeq);
      }
      let error: unknown;
      if (outcome.kind === 'resolved') {
        const resolved = await this.finishResolvedDispatch(modelRequestId, identity, options, lastObservedStreamSeq);
        if (resolved.terminalState || resolved.superseded) return resolved;
        error = new ProviderTransientError(
          'connection_interrupted',
          'Provider adapter resolved before committing a completed terminal checkpoint.'
        );
      } else if (outcome.kind === 'timed_out' || outcome.kind === 'semantic_timed_out') {
        error = outcome.error;
        controller.abort(outcome.error);
        await settleWithin(adapterOutcome, this.adapterDrainTimeoutMs);
      } else {
        error = outcome.error;
      }
      if (
        outcome.kind !== 'timed_out'
        && outcome.kind !== 'semantic_timed_out'
        && (controller.signal.aborted || isAbortError(error))
      ) {
        const handoff = handoffReason(controller.signal)
          ?? (isExecutionHandoffError(error) ? error : undefined);
        if (handoff) throw handoff;
        const cancelled = await this.cancelCurrentRequest(modelRequestId, 'cancelled-during-provider-dispatch');
        return this.finishCancelledDispatch(modelRequestId, identity, cancelled, options, lastObservedStreamSeq);
      }
      if (!(error instanceof ProviderTransientError)) {
        const applied = await this.failRequest(modelRequestId, identity, error);
        if (!applied) return this.finishResolvedDispatch(modelRequestId, identity, options, lastObservedStreamSeq);
        this.emitTransientTerminal(
          options,
          identity,
          'failed',
          lastObservedStreamSeq + 1n,
          providerFailureTerminalState(error)
        );
        throw error;
      }
      if (sawReplayUnsafeProviderEvent && !error.retryAfterOutput) {
        const replayUnsafe = Object.assign(
          new Error(`${error.message}（已收到 Provider 输出，不自动重放请求。）`),
          { cause: error }
        );
        const applied = await this.failRequest(modelRequestId, identity, replayUnsafe);
        if (!applied) return this.finishResolvedDispatch(modelRequestId, identity, options, lastObservedStreamSeq);
        this.emitTransientTerminal(
          options,
          identity,
          'failed',
          lastObservedStreamSeq + 1n,
          providerFailureTerminalState(replayUnsafe)
        );
        throw replayUnsafe;
      }
      const maxRetries = retryPolicy?.enabled ? retryPolicy.maxRetries : 0;
      if (identity.attemptSeq >= BigInt(maxRetries + 1)) {
        const applied = await this.failRequest(modelRequestId, identity, error);
        if (!applied) return this.finishResolvedDispatch(modelRequestId, identity, options, lastObservedStreamSeq);
        this.emitTransientTerminal(
          options,
          identity,
          'failed',
          lastObservedStreamSeq + 1n,
          providerFailureTerminalState(error),
          { retryAttempt: maxRetries, retryMaxAttempts: maxRetries }
        );
        throw error;
      }
      const retryAttempt = await this.createTransientRetry(
        modelRequestId,
        identity,
        error.reason,
        maxRetries,
        retryPolicy?.retryDelayMs ?? 0
      );
      if (retryAttempt === null) {
        return this.finishResolvedDispatch(modelRequestId, identity, options, lastObservedStreamSeq);
      }
      this.emitTransientTerminal(
        options,
        identity,
        'failed',
        lastObservedStreamSeq + 1n,
        `provider_transient_${error.reason}`,
        {
          retrying: true,
          discardOutput: true,
          retryAttempt: Number(retryAttempt.attemptSeq - 1n),
          retryMaxAttempts: maxRetries,
          retryDelayMs: retryAttempt.delayMs,
          retryNotBeforeAt: retryAttempt.retryNotBeforeAt
        }
      );
      request = await this.requireDomain('ModelRequest', modelRequestId);
      stats = parseStreamStats(request.stream_stats_json);
      attemptSeq = retryAttempt.attemptSeq;
    }
  }

  /** Persistent request-level cancellation; one writer transaction always targets the latest identity. */
  public async cancel(modelRequestIdInput: string, reason = 'cancelled-by-user'): Promise<boolean> {
    const modelRequestId = requireId(modelRequestIdInput, 'modelRequestId');
    try {
      const result = await this.cancelCurrentRequest(modelRequestId, requireText(reason, 'cancel reason'));
      return result.cancelled;
    } catch (error) {
      // A recovery owner may replace the generation between the owning-host check and this CAS.
      // Its local socket must still be stopped, but the new owner remains solely responsible for
      // persistent ModelRequest state.
      this.abortActiveSockets(modelRequestId, isExecutionHandoffError(error) ? error : undefined);
      throw error;
    } finally {
      this.abortActiveSockets(modelRequestId);
    }
  }

  /**
   * Provider deltas already fan out through the process-local transient observer. Persist only the
   * first ordinary delta as a bounded progress marker; no production recovery reader reconstructs
   * output from later delta samples. Semantic item boundaries and the terminal fence continue to
   * await their own durable transaction.
   */
  private async recordDispatchStreamEvent(
    modelRequestId: string,
    attemptSeq: bigint,
    socketGeneration: bigint,
    event: ProviderOutputStreamEvent,
    semanticProgress: boolean,
    state: StreamDurabilityState
  ): Promise<StreamEventResult> {
    const observedAt = this.epochNow();
    if (event.kind === 'output_delta' && state.outputDeltaCheckpointed) {
      if (semanticProgress && await this.persistStreamActivityIfDue(
        modelRequestId,
        attemptSeq,
        socketGeneration,
        event.streamSeq,
        observedAt,
        state
      )) {
        return { accepted: false, checkpointed: false, terminal: true, ignoredReason: 'terminal' };
      }
      return this.recordUndurableDispatchEvent('coalesced');
    }

    const result = await this.recordStreamEvent(modelRequestId, attemptSeq, socketGeneration, event);
    if (
      event.kind === 'output_delta'
      && (result.checkpointed
        || result.ignoredReason === 'duplicate'
        || result.ignoredReason === 'checkpoint-capacity')
    ) {
      state.outputDeltaCheckpointed = true;
    }
    if (
      !result.terminal
      && result.accepted
      && semanticProgress
      && await this.persistStreamActivityIfDue(
        modelRequestId,
        attemptSeq,
        socketGeneration,
        event.streamSeq,
        observedAt,
        state
      )
    ) {
      return { accepted: false, checkpointed: false, terminal: true, ignoredReason: 'terminal' };
    }
    return result;
  }

  private async persistStreamActivityIfDue(
    modelRequestId: string,
    attemptSeq: bigint,
    socketGeneration: bigint,
    streamSeqInput: string | bigint,
    observedAt: number,
    state: StreamDurabilityState
  ): Promise<boolean> {
    if (observedAt - state.lastActivityPersistedAt < DEFAULT_PROVIDER_ACTIVITY_HEARTBEAT_MS) return false;
    const activity = await this.database.recordModelStreamActivity({
      modelRequestId,
      attemptSeq,
      socketGeneration,
      streamSeq: decimalBigInt(streamSeqInput, 'Provider activity streamSeq'),
      observedAt,
      now: this.timestamp()
    });
    if (activity.accepted) state.lastActivityPersistedAt = observedAt;
    return activity.terminal;
  }

  private recordUndurableDispatchEvent(ignoredReason: 'coalesced'): StreamEventResult {
    if (this.database.performanceMetrics) {
      this.database.recordPerformanceMetric({
        kind: 'provider.stream_event',
        eventKind: 'output_delta',
        checkpointed: false,
        transactionCount: 0,
        durationMs: 0
      });
    }
    return { accepted: true, checkpointed: false, terminal: false, ignoredReason };
  }

  public async recordStreamEvent(
    modelRequestIdInput: string,
    attemptSeqInput: string | bigint,
    socketGenerationInput: string | bigint,
    eventInput: ProviderOutputStreamEvent
  ): Promise<StreamEventResult> {
    const event = normalizeStreamEvent(eventInput);
    const completed = event.kind === 'completed';
    const partialSummary = event.kind === 'output_item_done'
      && isRecord(event.content)
      && event.content.type === PROVIDER_PARTIAL_OUTPUT_SNAPSHOT_TYPE;
    const checkpointKind: ModelStreamCheckpointKind = event.kind === 'completed'
      ? 'terminal_summary'
      : partialSummary
        ? 'partial_summary'
        : event.kind;
    return this.recordStreamCheckpoint(modelRequestIdInput, attemptSeqInput, socketGenerationInput, {
      checkpointKind,
      envelopeKind: event.kind,
      streamSeq: event.streamSeq,
      content: event.content,
      ...(event.usage !== undefined ? { usage: event.usage } : {}),
      ...(event.timing !== undefined ? { timing: event.timing } : {})
    });
  }

  /**
   * Essential durable admission proof for one completed native call item. Non-droppable and outside
   * the ordinary checkpoint capacity; the kernel executes the call only when this returns
   * checkpointed=true. Never emitted for deltas.
   */
  public async recordNativeToolCallProof(
    modelRequestIdInput: string,
    attemptSeqInput: string | bigint,
    socketGenerationInput: string | bigint,
    streamSeqInput: string | bigint,
    proof: PlainJsonValue
  ): Promise<StreamEventResult> {
    return this.recordStreamCheckpoint(modelRequestIdInput, attemptSeqInput, socketGenerationInput, {
      checkpointKind: 'native_tool_call',
      envelopeKind: 'native_tool_call',
      streamSeq: decimalBigInt(streamSeqInput, 'streamSeq'),
      content: normalizePlainJson(proof, 'Native tool call proof')
    });
  }

  /** Persists the frozen native capabilities observed on an accepted response.created for UI gating. */
  public async persistNativeCapabilities(
    modelRequestIdInput: string,
    attemptSeqInput: string | bigint,
    socketGenerationInput: string | bigint,
    capabilities: OpenAIResponsesNativeCapabilities
  ): Promise<boolean> {
    const summary = normalizeNativeCapabilitiesSummary(capabilities);
    return this.mergeNativeStreamStats(modelRequestIdInput, attemptSeqInput, socketGenerationInput, (stats) => {
      const existing = isRecord(stats.nativeCapabilities) ? stats.nativeCapabilities : undefined;
      if (existing
        && existing.asyncTools === summary.asyncTools
        && existing.steering === summary.steering
        && existing.reasoningUpdates === summary.reasoningUpdates
        && existing.multiplexing === summary.multiplexing
        && existing.explicitCaching === summary.explicitCaching) {
        return { outcome: 'present' };
      }
      return { outcome: 'write', stats: { ...stats, nativeCapabilities: summary } };
    });
  }

  /**
   * Persists the first physical response's actual prompt tokens of a native chain exactly once;
   * later responses and cumulative totals never overwrite this original-root anchor.
   */
  public async persistNativeInitialPromptTokens(
    modelRequestIdInput: string,
    attemptSeqInput: string | bigint,
    socketGenerationInput: string | bigint,
    tokenCountInput: number
  ): Promise<boolean> {
    const tokenCount = requireNonNegativeSafeNumber(tokenCountInput, 'nativeInitialPromptTokenCount');
    return this.mergeNativeStreamStats(modelRequestIdInput, attemptSeqInput, socketGenerationInput, (stats) =>
      stats.nativeInitialPromptTokenCount !== undefined
        ? { outcome: 'present' as const }
        : { outcome: 'write' as const, stats: { ...stats, nativeInitialPromptTokenCount: tokenCount } }
    );
  }

  /**
   * Optimistic stream-stats merge for native anchors. The heartbeat writer mutates the same JSON
   * column mid-stream, so a stale full-column assert is retried from a fresh read (bounded)
   * instead of failing the dispatch; an identity change or a concurrent anchor write ends the
   * attempt honestly, and every retry re-validates before writing.
   */
  private async mergeNativeStreamStats(
    modelRequestIdInput: string,
    attemptSeqInput: string | bigint,
    socketGenerationInput: string | bigint,
    merge: (stats: StreamStats) => { outcome: 'write'; stats: StreamStats } | { outcome: 'present' }
  ): Promise<boolean> {
    const modelRequestId = requireId(modelRequestIdInput, 'modelRequestId');
    const attemptSeq = decimalBigInt(attemptSeqInput, 'attemptSeq');
    const socketGeneration = decimalBigInt(socketGenerationInput, 'socketGeneration');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const request = await this.requireDomain('ModelRequest', modelRequestId);
      if (request.status === 'terminal') return false;
      const stats = parseStreamStats(request.stream_stats_json);
      if (stats.attemptSeq !== attemptSeq.toString() || stats.socketGeneration !== socketGeneration.toString()) {
        return false;
      }
      const decision = merge(stats);
      if (decision.outcome === 'present') return true;
      try {
        await this.database.transaction([
          DOMAIN_REPOSITORIES.domain('ModelRequest').assert(modelRequestId, {
            status: request.status,
            // JSON predicates compare encoded bytes, not normalized object key order.
            stream_stats_json: request.stream_stats_json
          }),
          DOMAIN_REPOSITORIES.domain('ModelRequest').update(modelRequestId, {
            stream_stats_json: decision.stats,
            updated_at: this.timestamp()
          })
        ]);
        return true;
      } catch (error) {
        if (!isAssertionFailure(error) || attempt === 2) throw error;
      }
    }
    return false;
  }

  private async recordStreamCheckpoint(
    modelRequestIdInput: string,
    attemptSeqInput: string | bigint,
    socketGenerationInput: string | bigint,
    event: {
      checkpointKind: ModelStreamCheckpointKind;
      envelopeKind: string;
      streamSeq: bigint;
      content: PlainJsonValue;
      usage?: PlainJsonValue;
      timing?: ProviderStreamTiming;
    }
  ): Promise<StreamEventResult> {
    const modelRequestId = requireId(modelRequestIdInput, 'modelRequestId');
    const attemptSeq = decimalBigInt(attemptSeqInput, 'attemptSeq');
    const socketGeneration = decimalBigInt(socketGenerationInput, 'socketGeneration');
    const completed = event.checkpointKind === 'terminal_summary';
    const checkpointKind = event.checkpointKind;
    const metricStartedAt = this.database.performanceMetrics ? performance.now() : undefined;
    let transactionCount = 0;
    const finish = (result: StreamEventResult): StreamEventResult => {
      if (metricStartedAt !== undefined) {
        this.database.recordPerformanceMetric({
          kind: 'provider.stream_event',
          eventKind: checkpointKind === 'native_control' || checkpointKind === 'native_tool_call' ? 'other' : checkpointKind,
          checkpointed: result.checkpointed,
          transactionCount,
          durationMs: performance.now() - metricStartedAt
        });
      }
      return result;
    };
    const checkpointId = stableId(
      'model_stream_checkpoint',
      modelRequestId,
      attemptSeq.toString(),
      socketGeneration.toString(),
      event.streamSeq.toString()
    );
    const checkpointBytes = canonicalPlainJson({
      kind: event.envelopeKind,
      streamSeq: event.streamSeq.toString(),
      content: event.content,
      ...(event.usage !== undefined ? { usage: event.usage } : {}),
      ...(event.timing !== undefined ? { timing: event.timing } : {})
    });
    const checkpointIdentity = this.contentStore.identity(checkpointBytes, CONTENT_TYPE_CHECKPOINT);
    const preflight = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ModelRequest').get(modelRequestId),
      DOMAIN_REPOSITORIES.domain('ModelStreamFence').list({ where: { model_request_id: modelRequestId }, limit: 1 }),
      DOMAIN_REPOSITORIES.domain('ModelStreamCheckpoint').get(checkpointId),
      DOMAIN_REPOSITORIES.domain('ModelStreamCheckpoint').list({
        where: { model_request_id: modelRequestId },
        limit: MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT + 1
      })
    ]);
    const request = requireRow(preflight.snapshot[0], `ModelRequest ${modelRequestId}`);
    const stats = parseStreamStats(request.stream_stats_json);
    const existingCheckpoint = preflight.snapshot[2] as DomainRow | null;
    if (existingCheckpoint) {
      assertExactStreamCheckpoint(existingCheckpoint, {
        modelRequestId,
        attemptSeq,
        socketGeneration,
        streamSeq: event.streamSeq,
        checkpointKind,
        contentObjectId: checkpointIdentity.id
      });
      return finish({
        accepted: false,
        checkpointed: false,
        terminal: request.status === 'terminal',
        ignoredReason: 'duplicate'
      });
    }
    if (request.status === 'terminal' || rows(preflight.snapshot[1]).length > 0) {
      return finish({ accepted: false, checkpointed: false, terminal: true, ignoredReason: 'terminal' });
    }
    if (stats.attemptSeq !== attemptSeq.toString()) {
      return finish({ accepted: false, checkpointed: false, terminal: false, ignoredReason: 'old-attempt' });
    }
    if (stats.socketGeneration !== socketGeneration.toString()) {
      return finish({
        accepted: false,
        checkpointed: false,
        terminal: false,
        ignoredReason: 'old-socket-generation'
      });
    }
    // Native control/admission facts are essential durable rows outside the droppable display cap.
    const activeCheckpoints = rows(preflight.snapshot[3])
      .filter((row) => row.checkpoint_kind !== 'native_control' && row.checkpoint_kind !== 'native_tool_call');
    if (
      checkpointKind === 'output_delta'
      && activeCheckpoints.filter((row) => row.checkpoint_kind === 'output_delta').length
        >= MODEL_STREAM_OUTPUT_DELTA_CHECKPOINT_LIMIT
    ) {
      return finish({
        accepted: true,
        checkpointed: false,
        terminal: false,
        ignoredReason: 'checkpoint-capacity'
      });
    }
    if (
      checkpointKind === 'output_item_done'
      && activeCheckpoints.length >= MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT
    ) {
      return finish({
        accepted: true,
        checkpointed: false,
        terminal: false,
        ignoredReason: 'checkpoint-capacity'
      });
    }
    const content = await this.contentStore.prepare(this.database, checkpointBytes, CONTENT_TYPE_CHECKPOINT);
    const result = await this.database.commitModelStreamEvent({
      modelRequestId,
      checkpointId,
      attemptSeq,
      socketGeneration,
      streamSeq: event.streamSeq,
      checkpointKind,
      terminalFenceId: completed ? stableId('model_stream_fence', modelRequestId) : null,
      contentObject: content.metadata,
      ...(content.insert ? { contentInsert: content.insert } : {}),
      usage: completed ? (event.usage ?? null) : null,
      terminalStats: completed ? terminalStreamStats(stats, event.timing) : null,
      now: this.timestamp()
    });
    transactionCount = result.commit ? 1 : 0;
    return finish({
      accepted: result.accepted,
      checkpointed: result.checkpointed,
      terminal: result.terminal,
      ...(result.ignoredReason ? { ignoredReason: result.ignoredReason } : {})
    });
  }

  private async openSocketGeneration(
    modelRequestId: string,
    attemptSeq: bigint,
    expectedStats: StreamStats
  ): Promise<StreamIdentity> {
    // Same heartbeat-tolerant retry as terminalizeRequest: the full stats assert guards identity,
    // a benign metadata write between the bundle read and the transaction must not force a stale
    // stream error while the identity is provably unchanged.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const bundle = await this.readRequestBundle(modelRequestId, attemptSeq);
      if (bundle.request.status === 'terminal' || bundle.fence) throw new Error('Terminal ModelRequest cannot open a socket.');
      if (bundle.turn.status !== 'active') {
        await this.cancelCurrentRequest(modelRequestId, 'turn-not-active');
        throw new Error('ModelRequest parent Turn is not active.');
      }
      const currentStats = parseStreamStats(bundle.request.stream_stats_json);
      if (!sameStats(currentStats, expectedStats) || currentStats.attemptSeq !== attemptSeq.toString()) {
        throw staleStreamError('ModelRequest identity changed before socket open.');
      }
      const socketGeneration = decimalBigInt(currentStats.socketGeneration, 'socketGeneration') + 1n;
      const nextStats: StreamStats = { ...currentStats, socketGeneration: socketGeneration.toString() };
      delete nextStats.retryNotBeforeAt;
      delete nextStats.retryDelayMs;
      delete nextStats.lastStreamSeq;
      delete nextStats.lastStreamEventAt;
      const now = this.timestamp();
      try {
        await this.database.transaction([
          DOMAIN_REPOSITORIES.domain('Turn').assert(requireId(bundle.turn.id, 'Turn.id'), { status: 'active' }),
          DOMAIN_REPOSITORIES.domain('ModelRequest').assert(modelRequestId, {
            status: bundle.request.status,
            stream_stats_json: bundle.request.stream_stats_json
          }),
          DOMAIN_REPOSITORIES.domain('ModelStreamFence').assertNone({ model_request_id: modelRequestId }),
          DOMAIN_REPOSITORIES.domain('Attempt').assert(requireId(bundle.attempt.id, 'Attempt.id'), {
            operation_id: bundle.operation.id,
            attempt_seq: attemptSeq
          }),
          DOMAIN_REPOSITORIES.domain('Attempt').update(requireId(bundle.attempt.id, 'Attempt.id'), {
            status: 'running', updated_at: now
          }),
          DOMAIN_REPOSITORIES.domain('Operation').update(requireId(bundle.operation.id, 'Operation.id'), {
            status: 'running', updated_at: now
          }),
          DOMAIN_REPOSITORIES.domain('ModelRequest').update(modelRequestId, {
            status: 'streaming', stream_stats_json: nextStats, updated_at: now
          })
        ]);
        return { attemptSeq, socketGeneration, stats: nextStats };
      } catch (error) {
        if (!isAssertionFailure(error)) throw error;
        if (attempt === 2) {
          const latest = await this.requireDomain('ModelRequest', modelRequestId);
          const latestTurn = await this.requireDomain('Turn', requireId(latest.turn_id, 'ModelRequest.turn_id'));
          if (latestTurn.status !== 'active' && latest.status !== 'terminal') {
            await this.cancel(modelRequestId, 'turn-not-active');
          }
          throw staleStreamError('ModelRequest identity changed before socket open.');
        }
      }
    }
    throw staleStreamError('ModelRequest identity changed before socket open.');
  }

  private async createTransientRetry(
    modelRequestId: string,
    failed: StreamIdentity,
    reason: ProviderTransientReason,
    maxRetries: number,
    configuredDelayMs: number
  ): Promise<{ attemptSeq: bigint; delayMs: number; retryNotBeforeAt: number } | null> {
    if (!Number.isSafeInteger(maxRetries) || maxRetries <= 0 || maxRetries > 10) {
      throw new Error('Provider retry policy must allow between 1 and 10 retries.');
    }
    const retryOrdinal = Number(failed.attemptSeq);
    if (retryOrdinal > maxRetries) throw new Error('Provider transient retry budget is exhausted.');
    const nextAttemptSeq = failed.attemptSeq + 1n;
    const attemptId = stableId('model_request_attempt', modelRequestId, nextAttemptSeq.toString());
    const delayMs = configuredDelayMs > 0
      ? configuredDelayMs
      : retryDelayMs(retryOrdinal, this.retryDelaysMs, `${modelRequestId}:${retryOrdinal}`);
    const retryNotBeforeAt = this.epochNow() + delayMs;
    // Same heartbeat-tolerant retry: assertion failures from benign stats metadata writes are
    // retried from a fresh bundle; a genuine concurrent retry (unique/identity race) still loses.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const bundle = await this.readRequestBundle(modelRequestId, failed.attemptSeq);
      const currentStats = parseStreamStats(bundle.request.stream_stats_json);
      if (
        bundle.request.status === 'terminal'
        || bundle.fence
        || bundle.turn.status !== 'active'
        || !sameStats(currentStats, failed.stats)
      ) return null;
      const now = this.timestamp();
      const nextStats: StreamStats = {
        attemptSeq: nextAttemptSeq.toString(),
        socketGeneration: '0',
        retryReason: reason,
        retryMaxAttempts: maxRetries,
        retryDelayMs: delayMs,
        retryNotBeforeAt
      };
      try {
        await this.database.transaction([
          DOMAIN_REPOSITORIES.domain('Turn').assert(requireId(bundle.turn.id, 'Turn.id'), { status: 'active' }),
          DOMAIN_REPOSITORIES.domain('ModelRequest').assert(modelRequestId, {
            status: 'streaming', stream_stats_json: bundle.request.stream_stats_json
          }),
          DOMAIN_REPOSITORIES.domain('ModelStreamFence').assertNone({ model_request_id: modelRequestId }),
          DOMAIN_REPOSITORIES.domain('Attempt').assert(requireId(bundle.attempt.id, 'Attempt.id'), {
            status: 'running', attempt_seq: failed.attemptSeq
          }),
          DOMAIN_REPOSITORIES.domain('Attempt').update(requireId(bundle.attempt.id, 'Attempt.id'), {
            status: 'transient_failed', updated_at: now, completed_at: now
          }),
          DOMAIN_REPOSITORIES.domain('Attempt').insertWithNextSequence({
            id: attemptId,
            operation_id: requireId(bundle.operation.id, 'Operation.id'),
            status: 'pending',
            created_at: now,
            updated_at: now,
            completed_at: null
          }, { column: 'attempt_seq', scope: { operation_id: requireId(bundle.operation.id, 'Operation.id') } }),
          DOMAIN_REPOSITORIES.domain('Attempt').assert(attemptId, { attempt_seq: nextAttemptSeq }),
          DOMAIN_REPOSITORIES.domain('ModelRequest').update(modelRequestId, {
            status: 'retrying', stream_stats_json: nextStats, updated_at: now
          })
        ]);
        return { attemptSeq: nextAttemptSeq, delayMs, retryNotBeforeAt };
      } catch (error) {
        if (!isRecoverableProviderRace(error)) throw error;
        if (!isAssertionFailure(error) || attempt === 2) return null;
      }
    }
    return null;
  }

  private async cancelCurrentRequest(
    modelRequestId: string,
    terminalState: string
  ): Promise<ModelRequestCancelResult> {
    const result = await this.database.cancelCurrentModelRequest({
      modelRequestId,
      terminalState,
      now: this.timestamp()
    });
    this.abortActiveSockets(modelRequestId);
    return result;
  }

  private async finishResolvedDispatch(
    modelRequestId: string,
    identity: StreamIdentity,
    options: ProviderDispatchOptions,
    lastObservedStreamSeq: bigint
  ): Promise<ProviderDispatchResult> {
    const request = await this.requireDomain('ModelRequest', modelRequestId);
    const current = parseStreamStats(request.stream_stats_json);
    const terminalState = typeof request.terminal_state === 'string' ? request.terminal_state : undefined;
    const sameIdentity = sameStats(current, identity.stats);
    const terminalIdentity = sameIdentity
      ? identity
      : {
          attemptSeq: decimalBigInt(current.attemptSeq, 'stream_stats.attemptSeq'),
          socketGeneration: decimalBigInt(current.socketGeneration, 'stream_stats.socketGeneration')
        };
    const terminalStreamSeq = sameIdentity ? lastObservedStreamSeq + 1n : 1n;
    if (terminalState && isCancellationTerminalState(terminalState)) {
      this.emitTransientTerminal(options, terminalIdentity, 'cancelled', terminalStreamSeq, terminalState);
      throw abortError();
    }
    if (terminalState && isProviderFailureTerminalState(terminalState)) {
      this.emitTransientTerminal(options, terminalIdentity, 'failed', terminalStreamSeq, terminalState);
    }
    return dispatchResult(modelRequestId, identity, {
      superseded: !sameIdentity,
      terminalState
    });
  }

  private finishCancelledDispatch(
    modelRequestId: string,
    identity: StreamIdentity,
    result: ModelRequestCancelResult,
    options: ProviderDispatchOptions,
    lastObservedStreamSeq: bigint
  ): ProviderDispatchResult {
    const sameIdentity = result.attemptSeq === identity.attemptSeq.toString()
      && result.socketGeneration === identity.socketGeneration.toString();
    const terminalIdentity = {
      attemptSeq: decimalBigInt(result.attemptSeq, 'cancel result attemptSeq'),
      socketGeneration: decimalBigInt(result.socketGeneration, 'cancel result socketGeneration')
    };
    const terminalStreamSeq = sameIdentity ? lastObservedStreamSeq + 1n : 1n;
    if (result.terminalState && isCancellationTerminalState(result.terminalState)) {
      this.emitTransientTerminal(
        options,
        terminalIdentity,
        'cancelled',
        terminalStreamSeq,
        result.terminalState
      );
      throw abortError();
    }
    if (result.terminalState && isProviderFailureTerminalState(result.terminalState)) {
      this.emitTransientTerminal(options, terminalIdentity, 'failed', terminalStreamSeq, result.terminalState);
    }
    return dispatchResult(modelRequestId, identity, {
      superseded: result.attemptSeq !== identity.attemptSeq.toString()
        || result.socketGeneration !== identity.socketGeneration.toString(),
      ...(result.terminalState ? { terminalState: result.terminalState } : {})
    });
  }

  private emitTransientTerminal(
    options: ProviderDispatchOptions,
    identity: Pick<StreamIdentity, 'attemptSeq' | 'socketGeneration'>,
    kind: ProviderTransientTerminalEventKind,
    streamSeq: bigint,
    terminalState: string,
    detail: {
      retrying?: boolean;
      discardOutput?: boolean;
      retryAttempt?: number;
      retryMaxAttempts?: number;
      retryDelayMs?: number;
      retryNotBeforeAt?: number;
    } = {}
  ): void {
    if (!options.onTransientTerminal) return;
    try {
      options.onTransientTerminal({
        attemptSeq: identity.attemptSeq.toString(),
        socketGeneration: identity.socketGeneration.toString(),
        event: {
          kind,
          streamSeq: (streamSeq > 0n ? streamSeq : 1n).toString(),
          content: {
            terminalState,
            ...(detail.retrying ? { retrying: true } : {}),
            ...(detail.discardOutput ? { discardOutput: true } : {}),
            ...(detail.retryAttempt !== undefined ? { retryAttempt: detail.retryAttempt } : {}),
            ...(detail.retryMaxAttempts !== undefined ? { retryMaxAttempts: detail.retryMaxAttempts } : {}),
            ...(detail.retryDelayMs !== undefined ? { retryDelayMs: detail.retryDelayMs } : {}),
            ...(detail.retryNotBeforeAt !== undefined ? { retryNotBeforeAt: detail.retryNotBeforeAt } : {})
          }
        }
      });
    } catch {
      // The transient overlay is observational; durable ModelRequest state remains authoritative.
    }
  }

  private registerActiveSocket(modelRequestId: string, controller: AbortController): () => void {
    const active = this.activeSockets.get(modelRequestId) ?? new Set<AbortController>();
    active.add(controller);
    this.activeSockets.set(modelRequestId, active);
    // Closes the window where global handoff starts after dispatch() passed its admission check but
    // before the socket registered itself in activeSockets.
    if (this.handoff && !controller.signal.aborted) controller.abort(this.handoff);
    return () => {
      active.delete(controller);
      if (active.size === 0) this.activeSockets.delete(modelRequestId);
    };
  }

  private abortActiveSockets(modelRequestId: string, reason?: unknown): void {
    for (const controller of this.activeSockets.get(modelRequestId) ?? []) {
      if (!controller.signal.aborted) controller.abort(reason);
    }
  }

  private async failRequest(modelRequestId: string, identity: StreamIdentity, error: unknown): Promise<boolean> {
    return this.terminalizeRequest(modelRequestId, identity, {
      attemptStatus: 'failed',
      operationStatus: 'failed',
      terminalState: providerFailureTerminalState(error)
    });
  }

  private async terminalizeRequest(
    modelRequestId: string,
    identity: StreamIdentity,
    terminal: { attemptStatus: string; operationStatus: string; terminalState: string }
  ): Promise<boolean> {
    // The full stream_stats assert doubles as the identity fence, but the activity heartbeat also
    // writes that column. A benign metadata write must not strand the request non-terminal:
    // identity is re-validated on every attempt and the bounded retry absorbs the metadata race.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const bundle = await this.readRequestBundle(modelRequestId, identity.attemptSeq);
      if (bundle.request.status === 'terminal' || bundle.fence) return false;
      const currentStats = parseStreamStats(bundle.request.stream_stats_json);
      if (!sameStats(currentStats, identity.stats)) return false;
      const now = this.timestamp();
      try {
        await this.database.transaction([
          DOMAIN_REPOSITORIES.domain('ModelRequest').assert(modelRequestId, {
            status: bundle.request.status, stream_stats_json: bundle.request.stream_stats_json
          }),
          DOMAIN_REPOSITORIES.domain('ModelStreamFence').assertNone({ model_request_id: modelRequestId }),
          DOMAIN_REPOSITORIES.domain('Attempt').assert(requireId(bundle.attempt.id, 'Attempt.id'), {
            operation_id: bundle.operation.id, attempt_seq: identity.attemptSeq
          }),
          DOMAIN_REPOSITORIES.domain('Attempt').update(requireId(bundle.attempt.id, 'Attempt.id'), {
            status: terminal.attemptStatus, updated_at: now, completed_at: now
          }),
          DOMAIN_REPOSITORIES.domain('Operation').update(requireId(bundle.operation.id, 'Operation.id'), {
            status: terminal.operationStatus, updated_at: now
          }),
          DOMAIN_REPOSITORIES.domain('ModelRequest').update(modelRequestId, {
            status: 'terminal', terminal_state: terminal.terminalState, updated_at: now
          })
        ]);
        return true;
      } catch (error) {
        if (!isAssertionFailure(error) || attempt === 2) throw error;
      }
    }
    return false;
  }

  private async readRequestBundle(modelRequestId: string, attemptSeq: bigint): Promise<RequestBundle> {
    const operationId = stableId('model_request_operation', modelRequestId);
    const attemptId = stableId('model_request_attempt', modelRequestId, attemptSeq.toString());
    const request = await this.requireDomain('ModelRequest', modelRequestId);
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Operation').get(operationId),
      DOMAIN_REPOSITORIES.domain('Attempt').get(attemptId),
      DOMAIN_REPOSITORIES.domain('ModelStreamFence').list({ where: { model_request_id: modelRequestId }, limit: 1 }),
      DOMAIN_REPOSITORIES.domain('Turn').get(requireId(request.turn_id, 'ModelRequest.turn_id'))
    ]);
    return {
      request,
      operation: requireRow(snapshot.snapshot[0], `Operation for ${modelRequestId}`),
      attempt: requireRow(snapshot.snapshot[1], `Attempt ${attemptSeq} for ${modelRequestId}`),
      fence: rows(snapshot.snapshot[2])[0] ?? null,
      turn: requireRow(snapshot.snapshot[3], `Turn for ${modelRequestId}`)
    };
  }

  private async readFrozenAuthority(authoritySnapshotId: string, turnId: string, settingsSnapshotContentObjectId?: string): Promise<FrozenAuthority> {
    const frozen = await readRequestTurnAuthority(
      this.database,
      this.contentStore,
      authoritySnapshotId,
      turnId,
      settingsSnapshotContentObjectId
    );
    const model = frozenModelIdentity(frozen.document);
    const context = frozenContextProfile(frozen.document);
    const compression = frozenCompressionPolicy(frozen.document);
    const retryPolicy = frozenProviderRetryPolicy(frozen.document);
    return {
      ...model,
      document: frozen.document,
      contextWindowTokens: context.contextWindowTokens,
      compressionThresholdTokens: context.compressionThresholdTokens,
      retryPolicy,
      ...(compression ? {
        compressionProviderId: compression.provider.providerConfigId,
        compressionModelId: compression.provider.modelId,
        compressionRetryPolicy: compression.provider.retryPolicy
      } : {})
    };
  }

  private assertRequestPreflight(
    request: DomainRow,
    fullRequest: FullProviderRequest,
    adapter: FullRequestProviderAdapter
  ): void {
    const compression = isCompressionRecipe(fullRequest.recipe)
      ? frozenCompressionPolicy(fullRequest.authoritySnapshot)
      : undefined;
    // Model-independent estimates are compression-planning input, never ordinary Provider-send
    // authority. A real ordinary context limit is reported by the Provider itself.
    if (!compression) return;
    const contextWindowTokens = compression.provider.contextWindowTokens;
    const maxOutputTokens = compression.provider.maxOutputTokens;
    const persistedEstimate = requireNonNegativeSafeNumber(
      request.estimated_context_tokens,
      'ModelRequest.estimated_context_tokens'
    );
    const breakdown = adapter.estimateFullRequestInput?.(fullRequest)
      ?? fallbackRequestBreakdown(persistedEstimate);
    const result = preflightCompressionRequest({
      contextWindowTokens,
      maxOutputTokens,
      compressionThresholdTokens: contextWindowTokens,
      breakdown
    });
    if (result.status === 'ready') return;
    throw new ModelRequestPreflightError(
      result.code,
      `${result.code}: ${result.message} (estimated=${result.estimatedTokens}, limit=${result.limitTokens})`,
      result.estimatedTokens,
      result.limitTokens
    );
  }

  private async materializeRequestAddenda(
    recipe: PlainJsonValue,
    expectedTurnId: string
  ): Promise<Pick<FullProviderRequest, 'requestAddenda'>> {
    if (!isRecord(recipe) || recipe.kind !== 'reliable-agent-turn') return {};
    const currentRef = isRecord(recipe.currentTurnInput) ? recipe.currentTurnInput : undefined;
    const hasCurrentReference = currentRef !== undefined;
    const reinjectCurrent = currentRef?.reinject === true;
    let currentTurnInput: NonNullable<FullProviderRequest['requestAddenda']>['currentTurnInput'];
    if (hasCurrentReference) {
      const messageId = requireId(currentRef.messageId, 'ModelRequest recipe.currentTurnInput.messageId');
      const messageRevisionId = requireId(
        currentRef.messageRevisionId,
        'ModelRequest recipe.currentTurnInput.messageRevisionId'
      );
      const contentObjectId = requireId(
        currentRef.contentObjectId,
        'ModelRequest recipe.currentTurnInput.contentObjectId'
      );
      const snapshot = await this.database.snapshot([
        DOMAIN_REPOSITORIES.domain('MessageRevision').get(messageRevisionId),
        DOMAIN_REPOSITORIES.domain('MessageTurnLink').list({
          where: { turn_id: expectedTurnId, message_id: messageId, role: 'input' }, limit: 2
        }),
        DOMAIN_REPOSITORIES.domain('ContentObject').get(contentObjectId)
      ]);
      const revision = requireRow(snapshot.snapshot[0], `MessageRevision ${messageRevisionId}`);
      const links = rows(snapshot.snapshot[1]);
      const metadata = requireRow(snapshot.snapshot[2], `ContentObject ${contentObjectId}`);
      if (
        revision.message_id !== messageId
        || revision.content_object_id !== contentObjectId
        || revision.role !== 'user'
        || links.length !== 1
      ) {
        throw new Error('Frozen current Turn input reference conflicts with durable Message facts.');
      }
      currentTurnInput = {
        messageId,
        messageRevisionId,
        contentObjectId,
        reinject: reinjectCurrent,
        contentType: requireText(metadata.content_type, 'Current Turn input ContentObject.content_type'),
        content: decodeUtf8Exact(
          await this.contentStore.read(asContentObjectMetadata(metadata)),
          `Current Turn input ${messageRevisionId}`
        )
      };
    }
    const task = recipe.turnTaskCardReminderEnabled === false
      ? undefined
      : isRecord(recipe.turnTaskCard) ? recipe.turnTaskCard : undefined;
    const runtime = isRecord(recipe.runtimeStatusCard) ? recipe.runtimeStatusCard : undefined;
    const completionCheck = isRecord(recipe.openTaskCompletionCheck)
      ? recipe.openTaskCompletionCheck
      : undefined;
    const reminderParts = [
      typeof task?.card === 'string' && task.card.trim() ? task.card.trim() : '',
      typeof completionCheck?.card === 'string' && completionCheck.card.trim()
        ? completionCheck.card.trim()
        : '',
      typeof runtime?.card === 'string' && runtime.card.trim() ? runtime.card.trim() : ''
    ].filter(Boolean);
    const unfinishedTaskCount = nonNegativeRecipeInteger(task?.counts, 'unfinished');
    const activeChildCount = nonNegativeRecipeInteger(runtime, 'activeChildCount');
    const runningProcessCount = nonNegativeRecipeInteger(runtime, 'runningProcessCount');
    const turnReminder = reminderParts.length === 0 ? undefined : {
      content: reminderParts.join('\n\n'),
      ...(typeof task?.cardSha256 === 'string' && task.cardSha256.trim()
        ? { taskCardSha256: task.cardSha256.trim() }
        : {}),
      unfinishedTaskCount,
      activeChildCount,
      runningProcessCount
    };
    if (!currentTurnInput && !turnReminder) return {};
    return { requestAddenda: {
      ...(currentTurnInput ? { currentTurnInput } : {}),
      ...(turnReminder ? { turnReminder } : {})
    } };
  }

  private async replayCreation(
    request: DomainRow,
    modelRequestId: string,
    projectionId: string,
    operationId: string,
    attemptId: string,
    expected: CreationIdentity
  ): Promise<ModelRequestCreationResult> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ModelContextProjection').get(projectionId),
      DOMAIN_REPOSITORIES.domain('Operation').get(operationId),
      DOMAIN_REPOSITORIES.domain('Attempt').get(attemptId)
    ]);
    const projection = requireRow(snapshot.snapshot[0], `ModelContextProjection ${projectionId}`);
    const operation = requireRow(snapshot.snapshot[1], `Operation ${operationId}`);
    const attempt = requireRow(snapshot.snapshot[2], `Attempt ${attemptId}`);
    const matches = request.turn_id === expected.turnId
      && request.authority_snapshot_id === expected.authoritySnapshotId
      && request.provider_id === expected.providerId
      && request.model_id === expected.modelId
      && request.context_window_tokens === BigInt(expected.contextWindowTokens)
      && request.compression_threshold_tokens === BigInt(expected.compressionThresholdTokens)
      && request.estimated_context_tokens === BigInt(expected.estimatedContextTokens)
      && (request.settings_snapshot_object_id ?? null) === expected.settingsSnapshotContentObjectId
      && request.recipe_object_id === expected.recipeIdentity.id
      && projection.owner_kind === 'model_request'
      && projection.owner_id === modelRequestId
      && projection.root_id === expected.contextRootId
      && operation.owner_kind === 'model_request'
      && operation.owner_id === modelRequestId
      && attempt.operation_id === operationId
      && attempt.attempt_seq === 1n;
    if (!matches) {
      throw providerConflict(`ModelRequest idempotency key conflicts with committed immutable request ${modelRequestId}.`);
    }
    return {
      modelRequestId,
      projectionId,
      operationId,
      attemptId,
      requestSeq: requireBigInt(request.request_seq, 'ModelRequest.request_seq').toString(),
      deduplicated: true
    };
  }

  /** Every durably native-admitted provider call id of the Conversation, in ToolCall order. */
  private async listNativeAdmittedProviderCallIds(conversationId: string): Promise<readonly string[]> {
    const turns = await listAllDomainRows(this.database, 'Turn', { conversation_id: conversationId });
    const providerCallIds: string[] = [];
    for (const turn of turns) {
      const calls = await listAllDomainRows(this.database, 'ToolCall', {
        turn_id: requireId(turn.id, 'Turn.id')
      });
      if (calls.length === 0) continue;
      const snapshot = await this.database.snapshot(calls.flatMap((call) => [
        DOMAIN_REPOSITORIES.domain('ToolCallEvent').list({
          where: {
            tool_call_id: requireId(call.id, 'ToolCall.id'),
            event_kind: TOOL_CALL_EVENT_KIND_NATIVE_ADMISSION
          },
          limit: 1
        }),
        DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').list({
          where: { tool_call_id: requireId(call.id, 'ToolCall.id') },
          limit: 1
        })
      ]));
      for (let index = 0; index < calls.length; index += 1) {
        const events = rows(snapshot.snapshot[index * 2]);
        if (events.length === 0) continue;
        const links = rows(snapshot.snapshot[index * 2 + 1]);
        const providerCallId = links[0]?.provider_call_id;
        if (typeof providerCallId === 'string' && providerCallId.length > 0) {
          providerCallIds.push(providerCallId);
        }
      }
    }
    return providerCallIds;
  }

  private async requireDomain(domain: string, id: string): Promise<DomainRow> {
    const row = await this.getOptional(domain, id);
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async getOptional(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    return (snapshot.snapshot[0] as DomainRow | null) ?? null;
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

interface SemanticProgressWaiter {
  promise: Promise<{ kind: 'semantic_timed_out'; error: ProviderTransientError }>;
  observeProgress(): void;
  suspend(): void;
  resume(): void;
  dispose(): void;
}

function createSemanticProgressWaiter(timeouts: { firstSemanticMs: number; semanticIdleMs: number }): SemanticProgressWaiter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sawProgress = false;
  let settled = false;
  // A proven native input-wait (response boundary with outstanding required input) is not a stall:
  // the server deliberately waits for our tool results/steering, possibly longer than any idle
  // deadline (manual approvals included). The total dispatch timeout remains the outer bound.
  let suspended = false;
  let resolveTimeout!: (outcome: { kind: 'semantic_timed_out'; error: ProviderTransientError }) => void;
  const promise = new Promise<{ kind: 'semantic_timed_out'; error: ProviderTransientError }>((resolve) => {
    resolveTimeout = resolve;
  });
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const arm = (timeoutMs: number) => {
    clear();
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const reason: ProviderTransientReason = sawProgress ? 'stream_stalled' : 'first_semantic_timeout';
      resolveTimeout({
        kind: 'semantic_timed_out',
        error: new ProviderTransientError(
          reason,
          sawProgress
            ? `Provider stream made no semantic progress for ${timeoutMs}ms.`
            : `Provider produced no semantic event within ${timeoutMs}ms.`,
          // An idle timeout necessarily follows semantic output. Replace that incomplete Attempt
          // wholesale; first-semantic timeout has no output and does not need this exception.
          sawProgress
        )
      });
    }, timeoutMs);
  };
  arm(timeouts.firstSemanticMs);
  return {
    promise,
    observeProgress() {
      if (settled || suspended) return;
      sawProgress = true;
      // Re-arm immediately when the Provider event is observed. The durable checkpoint Promise may
      // itself block behind SQLite/CAS work; clearing the old timer until that Promise settles leaves
      // this dispatch with no semantic watchdog and lets one stuck event survive to the 20-minute
      // adapter deadline.
      arm(timeouts.semanticIdleMs);
    },
    suspend() {
      if (settled) return;
      suspended = true;
      clear();
    },
    resume() {
      if (settled || !suspended) return;
      suspended = false;
      // The next response proves liveness by itself; grant a fresh semantic window from here.
      arm(sawProgress ? timeouts.semanticIdleMs : timeouts.firstSemanticMs);
    },
    dispose() {
      settled = true;
      clear();
    }
  };
}

function createCompressionProgressWaiter(timeoutMs: number): {
  promise: Promise<{ kind: 'semantic_timed_out'; error: ProviderTransientError }>;
  observeProgress(): void;
  dispose(): void;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let resolveTimeout!: (outcome: { kind: 'semantic_timed_out'; error: ProviderTransientError }) => void;
  const promise = new Promise<{ kind: 'semantic_timed_out'; error: ProviderTransientError }>((resolve) => {
    resolveTimeout = resolve;
  });
  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveTimeout({
        kind: 'semantic_timed_out',
        error: new ProviderTransientError(
          'compression_timeout',
          `Provider compression made no text or thought progress for ${timeoutMs}ms.`
        )
      });
    }, timeoutMs);
  };
  arm();
  return {
    promise,
    observeProgress() {
      if (!settled) arm();
    },
    dispose() {
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }
  };
}

function normalizeSemanticTimeouts(
  value: Partial<ProviderSemanticTimeouts> | undefined
): ProviderSemanticTimeouts {
  return {
    firstSemanticMs: positiveSafeInteger(
      value?.firstSemanticMs ?? DEFAULT_PROVIDER_FIRST_SEMANTIC_TIMEOUT_MS,
      'semanticTimeouts.firstSemanticMs'
    ),
    semanticIdleMs: positiveSafeInteger(
      value?.semanticIdleMs ?? DEFAULT_PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS,
      'semanticTimeouts.semanticIdleMs'
    ),
    compressionCompletionMs: positiveSafeInteger(
      value?.compressionCompletionMs ?? DEFAULT_COMPRESSION_COMPLETION_TIMEOUT_MS,
      'semanticTimeouts.compressionCompletionMs'
    )
  };
}

function normalizeRetryDelays(value: readonly number[] | undefined): readonly number[] {
  const delays = value ?? DEFAULT_PROVIDER_RETRY_DELAYS_MS;
  if (delays.length === 0 || delays.length > 10) {
    throw new TypeError('retryDelaysMs must contain between 1 and 10 delays.');
  }
  return delays.map((delay, index) => {
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 10_000) {
      throw new TypeError(`retryDelaysMs[${index}] must be an integer in [0, 10000].`);
    }
    return delay;
  });
}

function retryDelayMs(retryOrdinal: number, delays: readonly number[], jitterKey?: string): number {
  if (!Number.isSafeInteger(retryOrdinal) || retryOrdinal <= 0) {
    throw new TypeError('retryOrdinal must be a positive safe integer.');
  }
  const base = delays[Math.min(delays.length - 1, retryOrdinal - 1)]!;
  if (!jitterKey || base === 0) return base;
  const byte = createHash('sha256').update(jitterKey).digest()[0] ?? 0;
  const factor = 0.75 + (byte / 255) * 0.25;
  return Math.max(0, Math.round(base * factor));
}

function retryPolicyForFullRequest(request: FullProviderRequest): FrozenProviderRetryPolicy {
  if (isCompressionRecipe(request.recipe)) {
    const compression = frozenCompressionPolicy(request.authoritySnapshot);
    if (!compression) throw new Error('Compression ModelRequest has no frozen compression retry policy.');
    return compression.provider.retryPolicy;
  }
  return frozenProviderRetryPolicy(request.authoritySnapshot);
}

function createRetryDelayWaiter(targetEpochMs: number, epochNow: () => number): {
  promise: Promise<{ kind: 'elapsed' }>;
  dispose(): void;
} {
  const delay = Math.max(0, targetEpochMs - epochNow());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<{ kind: 'elapsed' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'elapsed' }), delay);
  });
  return {
    promise,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }
  };
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.then(() => undefined, () => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer.`);
  return value;
}

function requirePositiveSafeNumber(value: unknown, label: string): number {
  const parsed = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return parsed as number;
}

function requireNonNegativeSafeNumber(value: unknown, label: string): number {
  const parsed = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return parsed as number;
}

function createProviderTimeoutWaiter(timeoutMsInput: number): {
  promise: Promise<{ kind: 'timed_out'; error: ProviderTransientError }>;
  dispose(): void;
} {
  if (!Number.isSafeInteger(timeoutMsInput) || timeoutMsInput <= 0) {
    throw new TypeError('Provider dispatch timeoutMs must be a positive safe integer.');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const error = new ProviderTransientError(
    'connection_interrupted',
    `Provider dispatch timed out after ${timeoutMsInput}ms.`
  );
  const promise = new Promise<{ kind: 'timed_out'; error: ProviderTransientError }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timed_out', error }), timeoutMsInput);
  });
  return {
    promise,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }
  };
}

function compressionRequestSegments<T>(
  recipe: PlainJsonValue,
  projectionRootId: string,
  segments: readonly T[]
): readonly T[] {
  if (!isRecord(recipe) || recipe.kind !== 'reliable-context-compression') return segments;
  if (recipe.sourceRootId !== projectionRootId) {
    throw new Error('Compression recipe source root does not match its immutable ModelContextProjection.');
  }
  const count = recipe.sourceSegmentCount;
  if (!Number.isSafeInteger(count) || (count as number) <= 0 || (count as number) > segments.length) {
    throw new Error('Compression recipe sourceSegmentCount is outside the frozen Context projection.');
  }
  if (recipe.compressionMethodKind === 'openai_responses_compact') {
    if (count !== segments.length) {
      throw new Error('Provider-native compression must freeze the complete model-visible Context projection.');
    }
    return segments;
  }
  // The finite tail is retained verbatim by ContextCompression.create and must never be sent to
  // the compact Provider as summary source, otherwise the next request duplicates that tail.
  return segments.slice(0, count as number);
}

function isCompressionRecipe(recipe: PlainJsonValue): boolean {
  return isRecord(recipe) && recipe.kind === 'reliable-context-compression';
}

function compressionSourceSegmentCount(recipe: PlainJsonValue): number {
  if (!isRecord(recipe) || recipe.kind !== 'reliable-context-compression') {
    throw new TypeError('ModelRequest recipe is not a compression request.');
  }
  const count = recipe.sourceSegmentCount;
  if (!Number.isSafeInteger(count) || (count as number) <= 0) {
    throw new RangeError('Compression recipe sourceSegmentCount must be a positive safe integer.');
  }
  return count as number;
}

function frozenPrimaryMaxOutputTokens(authority: PlainJsonValue): number {
  const document = isRecord(authority) ? authority : undefined;
  const model = document && isRecord(document.model) ? document.model : undefined;
  const value = model?.maxOutputTokens;
  return Number.isSafeInteger(value) && (value as number) > 0
    ? value as number
    : DEFAULT_OUTPUT_RESERVE_TOKENS;
}

function fallbackRequestBreakdown(estimatedTokens: number): ProjectedRequestTokenBreakdown {
  return {
    systemTokens: 0,
    toolSchemaTokens: 0,
    providerFramingTokens: 0,
    contextTokens: estimatedTokens,
    currentInputTokens: 0,
    runtimeDeliveryTokens: 0,
    turnReminderTokens: 0,
    mediaTokens: 0,
    fixedTokens: 0,
    bodyTokens: estimatedTokens,
    fullTokens: estimatedTokens
  };
}

function assertAttachmentProjectionCoverage(
  relationCatalog: readonly AttachmentCatalogEntry[],
  storedItems: ReadonlyArray<{ content: string; contentType?: string }>
): void {
  const referenced = collectAttachmentCatalogFromStoredItems(storedItems);
  if (referenced.length === 0) return;
  mergeAttachmentCatalog(relationCatalog, referenced);
  const relationIds = new Set(relationCatalog.map((entry) => entry.attachmentId));
  if (referenced.some((entry) => !relationIds.has(entry.attachmentId))) {
    throw new Error('Managed attachment metadata has no AttachmentLink in the frozen Context lineage.');
  }
}

function estimateFullProviderContextFallback(request: FullProviderRequest): number {
  return request.context.reduce((total, item) => {
    const next = total + Math.ceil(Buffer.byteLength(item.content, 'utf8') / 4);
    if (!Number.isSafeInteger(next)) throw new RangeError('Fallback Provider Context estimate is too large.');
    return next;
  }, 0);
}

function nonNegativeRecipeInteger(container: PlainJsonValue | undefined, key: string): number {
  const record = isRecord(container) ? container : undefined;
  const value = record?.[key];
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function dispatchResult(
  modelRequestId: string,
  identity: StreamIdentity,
  options: { superseded?: boolean; terminalState?: string } = {}
): ProviderDispatchResult {
  return {
    modelRequestId,
    attemptSeq: identity.attemptSeq.toString(),
    socketGeneration: identity.socketGeneration.toString(),
    ...(options.terminalState ? { terminalState: options.terminalState } : {}),
    ...(options.superseded ? { superseded: true as const } : {})
  };
}

function relayAbort(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => undefined;
  const abort = () => target.abort(source.reason);
  if (source.aborted) target.abort(source.reason);
  else source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}

function createAbortWaiter(signal: AbortSignal): {
  promise: Promise<{ kind: 'aborted' }>;
  dispose(): void;
} {
  let listener: (() => void) | null = null;
  const promise = signal.aborted
    ? Promise.resolve({ kind: 'aborted' as const })
    : new Promise<{ kind: 'aborted' }>((resolve) => {
        listener = () => resolve({ kind: 'aborted' });
        signal.addEventListener('abort', listener, { once: true });
      });
  return {
    promise,
    dispose: () => {
      if (listener) signal.removeEventListener('abort', listener);
      listener = null;
    }
  };
}

function isCancellationTerminalState(value: string): boolean {
  return value !== 'completed'
    && value !== 'provider_failed'
    && !value.startsWith('provider_transient_');
}

function isProviderFailureTerminalState(value: string): boolean {
  return value === 'provider_failed' || value.startsWith('provider_transient_');
}

function providerFailureTerminalState(error: unknown): string {
  return error instanceof ProviderTransientError
    ? `provider_transient_${error.reason}`
    : 'provider_failed';
}

function decodeUtf8Exact(bytes: Buffer, label: string): string {
  const value = bytes.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes)) {
    throw new Error(`${label} is not valid UTF-8 and cannot enter a full Provider request.`);
  }
  return value;
}

function assertExactStreamCheckpoint(
  row: DomainRow,
  expected: {
    modelRequestId: string;
    attemptSeq: bigint;
    socketGeneration: bigint;
    streamSeq: bigint;
    checkpointKind: string;
    contentObjectId: string;
  }
): void {
  if (
    row.model_request_id !== expected.modelRequestId
    || row.attempt_seq !== expected.attemptSeq
    || row.socket_generation !== expected.socketGeneration
    || row.stream_seq !== expected.streamSeq
    || row.checkpoint_kind !== expected.checkpointKind
    || row.content_object_id !== expected.contentObjectId
  ) {
    const error = new Error(`ModelStream checkpoint ${String(row.id)} conflicts with an existing event identity.`) as Error & {
      code: string;
    };
    error.code = 'MODEL_STREAM_IDEMPOTENCY_CONFLICT';
    throw error;
  }
}

function normalizeStreamEvent(event: ProviderStreamEvent): {
  kind: ProviderOutputStreamEventKind;
  streamSeq: bigint;
  content: PlainJsonValue;
  usage?: PlainJsonValue;
  timing?: ProviderStreamTiming;
} {
  if (!event || !['output_delta', 'output_item_done', 'completed', 'native_control'].includes(event.kind)) {
    throw new TypeError(`Unsupported Provider stream event: ${String(event?.kind)}`);
  }
  const streamSeq = decimalBigInt(event.streamSeq, 'streamSeq');
  if (streamSeq <= 0n) throw new TypeError('streamSeq must be positive.');
  return {
    kind: event.kind as ProviderOutputStreamEventKind,
    streamSeq,
    content: normalizePlainJson(event.content, 'Provider stream event content'),
    ...(event.usage !== undefined ? { usage: normalizePlainJson(event.usage, 'Provider stream usage') } : {}),
    ...(event.timing !== undefined ? { timing: normalizeProviderTiming(event.timing) } : {})
  };
}

function parseStreamStats(value: unknown): StreamStats {
  if (!isRecord(value)) throw new Error('ModelRequest.stream_stats_json must be an object.');
  const attemptSeq = decimalString(value.attemptSeq, 'stream_stats.attemptSeq');
  const socketGeneration = decimalString(value.socketGeneration, 'stream_stats.socketGeneration');
  if (value.retryReason !== null && !isTransientReason(value.retryReason)) {
    throw new Error('ModelRequest.stream_stats_json has an invalid retryReason.');
  }
  return {
    attemptSeq,
    socketGeneration,
    retryReason: value.retryReason as ProviderTransientReason | null,
    ...(optionalBoundedInteger(value.retryMaxAttempts, 'retryMaxAttempts', 1, 10) !== undefined
      ? { retryMaxAttempts: optionalBoundedInteger(value.retryMaxAttempts, 'retryMaxAttempts', 1, 10) }
      : {}),
    ...(optionalBoundedInteger(value.retryDelayMs, 'retryDelayMs', 0, Number.MAX_SAFE_INTEGER) !== undefined
      ? { retryDelayMs: optionalBoundedInteger(value.retryDelayMs, 'retryDelayMs', 0, Number.MAX_SAFE_INTEGER) }
      : {}),
    ...(optionalBoundedInteger(value.retryNotBeforeAt, 'retryNotBeforeAt', 1, Number.MAX_SAFE_INTEGER) !== undefined
      ? { retryNotBeforeAt: optionalBoundedInteger(value.retryNotBeforeAt, 'retryNotBeforeAt', 1, Number.MAX_SAFE_INTEGER) }
      : {}),
    ...normalizeProviderTiming(value),
    ...(optionalDecimalString(value.lastStreamSeq, 'lastStreamSeq') !== undefined
      ? { lastStreamSeq: optionalDecimalString(value.lastStreamSeq, 'lastStreamSeq') }
      : {}),
    ...(optionalTimestamp(value.lastStreamEventAt, 'lastStreamEventAt') !== undefined
      ? { lastStreamEventAt: optionalTimestamp(value.lastStreamEventAt, 'lastStreamEventAt') }
      : {}),
    ...(isRecord(value.nativeCapabilities)
      ? { nativeCapabilities: normalizeNativeCapabilitiesSummary(value.nativeCapabilities) }
      : {}),
    ...(optionalNonNegativeTokenCount(value.nativeInitialPromptTokenCount) !== undefined
      ? { nativeInitialPromptTokenCount: optionalNonNegativeTokenCount(value.nativeInitialPromptTokenCount) }
      : {})
  };
}

function optionalNonNegativeTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalizeNativeCapabilitiesSummary(value: unknown): OpenAIResponsesNativeCapabilities {
  const record = isRecord(value) ? value : {};
  return {
    asyncTools: record.asyncTools === true,
    steering: record.steering === true,
    reasoningUpdates: record.reasoningUpdates === true,
    multiplexing: record.multiplexing === true,
    explicitCaching: record.explicitCaching === true
  };
}

function terminalStreamStats(stats: StreamStats, timing?: ProviderStreamTiming): DomainRow {
  const terminal: DomainRow = { ...stats, ...(timing ?? {}) };
  delete terminal.lastStreamSeq;
  delete terminal.lastStreamEventAt;
  return terminal;
}

function normalizeProviderTiming(value: unknown): ProviderStreamTiming {
  if (!isRecord(value)) throw new TypeError('Provider stream timing must be an object.');
  return {
    ...(optionalTimestamp(value.providerStartedAt, 'providerStartedAt') !== undefined
      ? { providerStartedAt: optionalTimestamp(value.providerStartedAt, 'providerStartedAt') }
      : {}),
    ...(optionalTimestamp(value.firstOutputAt, 'firstOutputAt') !== undefined
      ? { firstOutputAt: optionalTimestamp(value.firstOutputAt, 'firstOutputAt') }
      : {}),
    ...(optionalTimestamp(value.completedAt, 'completedAt') !== undefined
      ? { completedAt: optionalTimestamp(value.completedAt, 'completedAt') }
      : {}),
    ...(optionalTimestamp(value.streamOutputDurationMs, 'streamOutputDurationMs', true) !== undefined
      ? { streamOutputDurationMs: optionalTimestamp(value.streamOutputDurationMs, 'streamOutputDurationMs', true) }
      : {})
  };
}

function optionalBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`Provider stream ${label} must be an integer in [${minimum}, ${maximum}].`);
  }
  return value as number;
}

function domainTimestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function optionalDecimalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return decimalString(value, label);
}

function optionalTimestamp(value: unknown, label: string, allowZero = false): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (allowZero ? (value as number) < 0 : (value as number) <= 0)) {
    throw new TypeError(`Provider stream timing ${label} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer.`);
  }
  return value as number;
}

function sameStats(left: StreamStats, right: StreamStats): boolean {
  return left.attemptSeq === right.attemptSeq
    && left.socketGeneration === right.socketGeneration
    && left.retryReason === right.retryReason
    && left.retryMaxAttempts === right.retryMaxAttempts
    && left.retryDelayMs === right.retryDelayMs
    && left.retryNotBeforeAt === right.retryNotBeforeAt;
}

function parsePlainJson(bytes: Buffer, label: string): PlainJsonValue {
  try {
    return normalizePlainJson(JSON.parse(bytes.toString('utf8')), label);
  } catch (error) {
    throw new Error(`${label} is not valid plain JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function allocatedValue(
  allocated: readonly { domain: string; id: string; column: string; value: string }[],
  domain: string,
  id: string,
  column: string
): string {
  const entry = allocated.find((candidate) =>
    candidate.domain === domain && candidate.id === id && candidate.column === column
  );
  if (!entry) throw new Error(`Missing writer allocation ${domain}.${column} for ${id}.`);
  return entry.value;
}

export function modelRequestIdFor(turnIdInput: string, idempotencyKeyInput: string): string {
  return stableId(
    'model_request',
    requireId(turnIdInput, 'turnId'),
    requireText(idempotencyKeyInput, 'idempotencyKey')
  );
}

function stableId(kind: string, ...parts: string[]): string {
  const digest = createHash('sha256')
    .update('limcode-reliable-kernel-provider\0')
    .update(kind)
    .update('\0')
    .update(parts.join('\0'))
    .digest('hex');
  return `${kind}_${digest}`;
}

function asContentObjectMetadata(row: DomainRow): ContentObjectMetadata {
  return row as ContentObjectMetadata;
}

function isTransientReason(value: unknown): value is ProviderTransientReason {
  return value === 'connection_interrupted'
    || value === 'rate_limited'
    || value === 'temporary_service_error'
    || value === 'first_semantic_timeout'
    || value === 'stream_stalled'
    || value === 'compression_timeout';
}

function isRecoverableProviderRace(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'SQLITE_CONSTRAINT_UNIQUE'
    || code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}

function isAssertionFailure(error: unknown): boolean {
  return errorCode(error) === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as Error & { code?: string }).code : undefined;
}

function providerConflict(message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = 'MODEL_REQUEST_IDEMPOTENCY_CONFLICT';
  return error;
}

function staleStreamError(message: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = 'MODEL_STREAM_IDENTITY_STALE';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function abortError(): Error {
  const error = new Error('Provider request was cancelled.');
  error.name = 'AbortError';
  return error;
}

function rows(value: unknown): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError('Repository list result must be an array.');
  return value as DomainRow[];
}

function requireRow(value: unknown, label: string): DomainRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value as DomainRow;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function optionalId(value: unknown, label: string): string | null {
  return value === null || value === undefined ? null : requireId(value, label);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value.trim();
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError(`${label} must be a non-negative SQLite INTEGER.`);
  return value;
}

function decimalBigInt(value: unknown, label: string): bigint {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new TypeError(`${label} must be non-negative.`);
    return value;
  }
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string or bigint.`);
  }
  return BigInt(value);
}

function decimalString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string.`);
  }
  return value;
}

function normalizeModelRequestRecipe(value: PlainJsonValue, label: string): PlainJsonValue {
  const normalized = normalizePlainJson(value, label);
  if (!isRecord(normalized)) throw new TypeError(`${label} must be an object.`);
  if ('attachmentCatalog' in normalized) {
    throw new TypeError(`${label} must use attachmentCatalogState, not attachmentCatalog.`);
  }
  const attachmentCatalogState = normalized.attachmentCatalogState === undefined
    ? { catalog: [], placements: [] }
    : normalizeAttachmentCatalogState(normalized.attachmentCatalogState, `${label}.attachmentCatalogState`);
  return normalizePlainJson({
    ...normalized,
    attachmentCatalogState
  }, label);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
