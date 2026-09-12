import { createHash } from 'crypto';
import { associateDebugCapture, captureDebug, debugCaptureSources, debugSource, DebugHttpObservation, getDebugCaptureContext, type DebugCaptureRecorder } from '../reliableKernel/debugCapture/observer';
import {
  groupAtomicMessageContents,
  isModelToolResponseMultimodalMimeType
} from '../reliableKernel/modelFacingContextProjection';
import { estimateTokenCount, sliceByTokens } from 'tokenx';
import { mapWithBoundedConcurrency } from './boundedConcurrency';
import { createProxyFetch } from './proxyFetch';
import { createTerminalValidatedFetch } from './terminalValidatedFetch';
import { createLlmStreamEventBatcher } from './llmStreamEventBatcher';
import { LIMCODE_OPENAI_RESPONSES_WS_IMPLEMENTATION } from './openAIResponsesWebSocketIdentity';
import { installProviderCompatibility } from './geminiProviderAdaptation';
import {
  assertCanonicalProviderToolContext,
  cloneInlineDataPart,
  createMultimodalPreparationContext,
  mediaReferenceLabel,
  prepareInlineDataForLlm,
  prepareLlmStartRequestMultimodal,
  prepareNativeCompactContentsMultimodal,
  requireCanonicalInlineDataSize,
  resolveAttachmentOnce,
  type MultimodalPreparationContext
} from './llmRequestContentPreparation';
import {
  createDoneTiming,
  disposeThoughtBlock,
  emitThoughtDeltas,
  emitUnifiedChunk,
  emitUnifiedResponse,
  errorSearchText,
  finishThoughtBlock,
  fromUnifiedCompletedContent,
  hasStreamTimingChunk,
  isRecord,
  isSensitiveLlmErrorField,
  mergeUsageMetadata,
  nonEmptyRecord,
  nowMonotonicMs,
  shouldCloseThoughtBlock,
  stringifyJson,
  stripUndefined,
  sumUsageMetadata,
  toPlainJsonLike,
  usageMetadataFromChunk,
  visibleTextFromParts,
  type ActiveThoughtBlock,
  type OpenAIResponsesNativeChainContext
} from './llmStreamEventProjection';
import { toUnifiedContents, toUnifiedRequest } from './unifiedMessageConversion';
import type {
  LimCodeOpenAIResponsesStreamChunk,
  OpenAIResponsesFormatAdapter,
  OpenAIResponsesWebSocketDecision,
  OpenAIResponsesWebSocketPhase,
  OpenAIResponsesWebSocketPhaseKind,
  OpenAIResponsesWebSocketStreamOptions,
  OpenAIResponsesWebSocketTimeoutPhase
} from './openAIResponsesWebSocketSession';
import { LlmEventType } from '../world/modules/llm/events';
import {
  isAstraModel,
  normalizeOpenAIResponsesNativeSettings,
  openAIResponsesNativeCapabilities
} from '../../shared/openAIResponsesCapabilities';
import type {
  OpenAIResponsesNativeCapabilities,
  OpenAIResponsesToolOutput
} from '../../shared/openAIResponsesNative';
import { OpenAIResponsesNativeDeliveryError } from './openAIResponsesNativeControl';
import type {
  OpenAIResponsesNativeController,
  OpenAIResponsesNativeHooks,
  OpenAIResponsesNativeResultAdmission
} from './openAIResponsesNativeControl';
import { ATTACHMENT_OBSERVATION_PROMPT_REVISION } from '../world/modules/llm/contracts';
import type {
  LlmCompactDryRunResult,
  LlmCompactRequest,
  LlmCompactResult,
  LlmAttachmentObservation,
  LlmAttachmentObservationRequirement,
  LlmDryRunOptions,
  LlmDryRunResult,
  LlmResolveInvocationRequest,
  LlmStartRequest,
  LlmModelSettings
} from '../world/modules/llm/contracts';
import type { Emit, LlmCapability, LlmStartRuntimeControls } from './types';
import {
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  DEFAULT_LLM_COMPRESSION_SUMMARY_SYSTEM_PROMPT,
  DEFAULT_LLM_COMPRESSION_SUMMARY_USER_PROMPT,
  DEFAULT_LLM_COMPRESSION_OUTPUT_RESERVE_TOKENS,
  normalizeLlmCompressionMaxDurationMinutes,
  DEFAULT_LLM_COMPRESSION_SUMMARY_TARGET_TOKENS,
  DEFAULT_LLM_CONTEXT_WINDOW_TOKENS,
  DEFAULT_SEGMENTED_SUMMARY_SYSTEM_PROMPT,
  DEFAULT_SEGMENTED_SUMMARY_USER_PROMPT,
  isInlineDataPart,
  DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
  MAX_LLM_RETRY_DELAY_SECONDS,
  DEFAULT_LLM_RETRY_ON_ERROR,
  isTextPart,
  isVisibleTextPart,
  isProviderContextPart,
  createDefaultLlmPromptCacheConfig,
  defaultLlmPromptCacheModeForProvider,
  defaultLlmPromptCacheTtlForProvider,
  isPromptCacheSupportedProvider
} from '../../shared/protocol';
import {
  ATTACHMENT_OBSERVATION_UNAVAILABLE_UNCERTAINTY,
  isUnavailableAttachmentObservation,
  normalizeAttachmentObservationRequirement,
  normalizeLlmAttachmentObservation,
  renderAttachmentObservationStateContent
} from '../reliableKernel/attachmentObservations';
import type {
  ContentPart,
  InlineDataPart,
  LlmCompressionConfigRecord,
  LlmGenerationConfigRecord,
  LlmInvocationSettingsSnapshotRecord,
  LlmProviderConfigRecord,
  LlmProviderHeadersRecord,
  LlmProviderKind,
  LlmProviderModelRecord,
  LlmOpenAIResponsesTransport,
  LlmPromptCacheConfigRecord,
  LlmPromptCacheMode,
  LlmPromptCacheTtl,
  LlmRequestBodyRecord,
  LlmToolCallFormat,
  LlmRawErrorInfoRecord,
  LlmThinkingLevel,
  LlmUsageMetadataRecord,
  MessageContent,
} from '../../shared/protocol';

export const DEFAULT_LLM_BASE_URL = 'https://api.openai.com/v1';
const COMPRESSION_DEBUG_PREFIX = '[LimCode][CompressionDebug]';
type MaybeProvider<T, TArg = void> = T | undefined | ((arg: TArg) => T | undefined | Promise<T | undefined>);
type LlmSettingsRequest = LlmStartRequest | LlmCompactRequest | LlmResolveInvocationRequest | undefined;
type LlmCompressionSettingsProvider = (request: LlmCompactRequest) => LlmCompressionConfigRecord | undefined | Promise<LlmCompressionConfigRecord | undefined>;

type UnifiedModule = typeof import('unified-llm-provider');
type UnifiedContent = import('unified-llm-provider').Content;
type UnifiedLLMRequest = import('unified-llm-provider').LLMRequest;
type UnifiedLLMResponse = import('unified-llm-provider').LLMResponse;
type UnifiedLLMCompactResponse = import('unified-llm-provider').LLMCompactResponse;
type UnifiedLLMStreamChunk = import('unified-llm-provider').LLMStreamChunk;
type UnifiedModelCatalogEntry = import('unified-llm-provider').ModelCatalogEntry;

interface UnifiedDryRunResult {
  url: string;
  method: 'POST';
  stream: boolean;
  headers: Record<string, string>;
  body: unknown;
  bodyText: string;
  curl: string;
  providerName: string;
  inputFormat: string;
  outputFormat: string;
  timestamp: number;
}

interface UnifiedDryRunCapable {
  dryRun(request: unknown, options?: { inputFormat?: string; outputFormat?: string; stream?: boolean; curl?: { includeApiKey?: boolean; prettyBody?: boolean } }): Promise<UnifiedDryRunResult>;
  compactDryRun?(request: unknown, options?: {
    inputFormat?: string;
    outputFormat?: string;
    requestBody?: LlmRequestBodyRecord;
    curl?: { includeApiKey?: boolean; prettyBody?: boolean };
  }): Promise<UnifiedDryRunResult>;
}

interface UnifiedChatProvider extends UnifiedDryRunCapable {
  chat<T>(request: unknown, options: {
    inputFormat: 'unified';
    outputFormat: 'unified';
    signal?: AbortSignal;
  }): Promise<T>;
  chatStream<T>(request: unknown, options: {
    inputFormat: 'unified';
    outputFormat: 'unified';
    signal?: AbortSignal;
  }): AsyncIterable<T>;
}

export interface LlmProviderTransportTrace {
  requestId: string;
  conversationId: string;
  phase: OpenAIResponsesWebSocketPhaseKind
    | 'continuation_decision'
    | 'http_fallback'
    | 'http_cooldown';
  observedAt: number;
  sessionKeyHash: string;
  connectionGeneration: number;
  elapsedMs?: number;
  connectionReused?: boolean;
  connectionReason?: OpenAIResponsesWebSocketDecision['connectionReason'];
  mode?: OpenAIResponsesWebSocketDecision['mode'];
  reason?: string;
  timeoutPhase?: OpenAIResponsesWebSocketTimeoutPhase;
  fullInputItemCount?: number;
  sentInputItemCount?: number;
  responseCreateFrameSha256?: string;
  responseCreateFrameBytes?: number;
  responseCreateSeq?: number;
}

export interface LlmProviderOptions {
  debugCapture?: DebugCaptureRecorder;
  settings: MaybeProvider<LlmProviderConfigRecord, LlmSettingsRequest>;
  proxy?: MaybeProvider<string>;
  compressionSettings?: LlmCompressionSettingsProvider;
  activeCompressionSettings?: (request?: { conversationId?: string; providerConfigId?: string; model?: string }) => LlmCompressionConfigRecord | undefined | Promise<LlmCompressionConfigRecord | undefined>;

  headers?: MaybeProvider<Record<string, string>>;
  resolveAttachment?: (input: { attachmentId?: string; sourcePath?: string; mimeType?: string; name?: string }) => Promise<InlineDataPart | undefined>;
  onTransportTrace?: (trace: LlmProviderTransportTrace) => void;
  onCompressionProgress?: () => void;
}
interface RetryControl {
  cancelRequested: boolean;
  wakeRetryWait?: () => void;
}

interface LlmAttemptFailure {
  message: string;
  rawError?: LlmRawErrorInfoRecord;
  createdAt?: number;
  streamOutputDurationMs?: number;
}

interface LlmAttemptRetryRecoveryNotice {
  retryAttempt: number;
  retryMaxAttempts: number;
}

interface LlmAttemptTimingState {
  firstStreamChunkAt?: number;
  firstStreamChunkMark?: number;
  streamTimingChunkCount: number;
}

const OPENAI_RESPONSES_WS_RETRY_BUDGET_MS = 120_000;
const OPENAI_RESPONSES_HTTP_COOLDOWN_MS = 60_000;
const openAIResponsesHttpCooldowns = new Map<string, number>();
type OpenAIResponsesWebSocketSessionModule = typeof import('./openAIResponsesWebSocketSession');
let loadedOpenAIResponsesWebSocketSession: OpenAIResponsesWebSocketSessionModule | undefined;
let loadingOpenAIResponsesWebSocketSession: Promise<OpenAIResponsesWebSocketSessionModule> | undefined;

async function openAIResponsesWebSocketSession(): Promise<OpenAIResponsesWebSocketSessionModule> {
  if (loadedOpenAIResponsesWebSocketSession) return loadedOpenAIResponsesWebSocketSession;
  loadingOpenAIResponsesWebSocketSession ??= import('./openAIResponsesWebSocketSession');
  loadedOpenAIResponsesWebSocketSession = await loadingOpenAIResponsesWebSocketSession;
  return loadedOpenAIResponsesWebSocketSession;
}

function resetLoadedOpenAIResponsesWebSocketSessions(): void {
  loadedOpenAIResponsesWebSocketSession?.resetOpenAIResponsesWebSocketSessions();
}

class LlmAttemptFailureError extends Error {
  public constructor(public readonly failure: LlmAttemptFailure) {
    super(failure.message);
    this.name = 'LlmAttemptFailureError';
  }
}



/**
 * LLM capability 只维护 unified/Gemini-like 请求。
 * provider 真实 wire format 交给 unified-llm-provider 的 provider/format registry 处理。
 */
export function createLlmProviderCapability(options: LlmProviderOptions): LlmCapability {
  const controllers = new Map<string, AbortController>();
  const retryControls = new Map<string, RetryControl>();
  const resolvedRuntimeSettingsByInvocationId = new Map<string, LlmProviderConfigRecord>();

  return {
    resolveInvocation(request, emit) {
      void resolveLlmInvocationProvider(request, emit, options, resolvedRuntimeSettingsByInvocationId);
    },
    start(request, emit, controls) {
      controllers.get(request.id)?.abort(createAbortError(`Superseded LLM request: ${request.id}`));
      retryControls.get(request.id)?.wakeRetryWait?.();

      const controller = new AbortController();
      const retryControl: RetryControl = { cancelRequested: false };
      controllers.set(request.id, controller);
      retryControls.set(request.id, retryControl);

      void startLlmProvider(request, emit, options, controller.signal, resolvedRuntimeSettingsByInvocationId, retryControl, controls)
        .finally(() => {
          if (controllers.get(request.id) === controller) {
            controllers.delete(request.id);
          }
          if (retryControls.get(request.id) === retryControl) retryControls.delete(request.id);
          if (request.invocationId) resolvedRuntimeSettingsByInvocationId.delete(request.invocationId);
        });
    },
    compact(request, emit) {
      const previous = controllers.get(request.id);
      if (previous) {
        logCompressionDebug('capability.compact.supersede', compactRequestDebugInfo(request));
        retryControls.get(request.id)?.wakeRetryWait?.();
        previous.abort(createAbortError(`Superseded LLM compact request: ${request.id}`));
      }
      const controller = new AbortController();
      const retryControl: RetryControl = { cancelRequested: false };
      controllers.set(request.id, controller);
      retryControls.set(request.id, retryControl);
      logCompressionDebug('capability.compact.start', compactRequestDebugInfo(request));
      void compactLlmProvider(request, emit, options, controller.signal, retryControl)
        .finally(() => {
          const stillActive = controllers.get(request.id) === controller;
          logCompressionDebug('capability.compact.finally', {
            ...compactRequestDebugInfo(request),
            stillActive,
            signalAborted: controller.signal.aborted,
            abortReason: abortReasonText(controller.signal.reason)
          });
          if (stillActive) controllers.delete(request.id);
          if (retryControls.get(request.id) === retryControl) retryControls.delete(request.id);
        });
    },
    dryRun(request, dryRunOptions) {
      return dryRunLlmProvider(request, options, dryRunOptions, resolvedRuntimeSettingsByInvocationId);
    },
    dryRunCompact(request, dryRunOptions) {
      return dryRunCompactLlmProvider(request, options, dryRunOptions);
    },
    listModels(config) {
      return listLlmProviderModels(config, options);
    },
    cancelRetry(requestId) {
      const control = retryControls.get(requestId);
      if (!control) return;
      control.cancelRequested = true;
      control.wakeRetryWait?.();
    },
    abort(requestId) {
      const control = retryControls.get(requestId);
      if (control) control.cancelRequested = true;
      control?.wakeRetryWait?.();
      const controller = controllers.get(requestId);
      if (!controller) return;
      controllers.delete(requestId);
      controller.abort(createAbortError(`Aborted LLM request: ${requestId}`));
    },
    dispose() {
      for (const control of retryControls.values()) {
        control.cancelRequested = true;
        control.wakeRetryWait?.();
      }
      retryControls.clear();
      for (const [requestId, controller] of controllers) {
        controller.abort(createAbortError(`Disposed LLM capability during request: ${requestId}`));
      }
      controllers.clear();
      resolvedRuntimeSettingsByInvocationId.clear();
      resetLoadedOpenAIResponsesWebSocketSessions();
      openAIResponsesHttpCooldowns.clear();
    }
  };
}

export async function startLlmProvider(
  request: LlmStartRequest,
  emit: Emit,
  options: LlmProviderOptions,
  signal?: AbortSignal,
  resolvedRuntimeSettingsByInvocationId?: Map<string, LlmProviderConfigRecord>,
  retryControl: RetryControl = { cancelRequested: false },
  controls?: LlmStartRuntimeControls
): Promise<void> {
  const streamEvents = createLlmStreamEventBatcher(emit, {
    onDerived: options.debugCapture ? (event, inputs) => {
      if (options.debugCapture?.active(getDebugCaptureContext(request))) associateDebugCapture(event, inputs.flatMap(input => [...debugCaptureSources(input)]));
    } : undefined,
    onTerminalMetrics: (metrics) => {
      if (metrics.rawDeltaEvents === 0) return;
      console.log('[LimCode][LlmStreamAggregation]', JSON.stringify({
        requestId: request.id,
        ...metrics,
        reductionRatio: Number((metrics.emittedDeltaEvents / metrics.rawDeltaEvents).toFixed(4))
      }));
    }
  });
  const streamEmit = streamEvents.emit;
  try {
    const settings = await resolveRuntimeSettings(request, options, resolvedRuntimeSettingsByInvocationId);
    emitLlmStarted(streamEmit, request.id, request.invocationId, resolveModelDisplayName(settings));
    const nativeCapabilities = openAIResponsesNativeCapabilities({
      provider: settings.provider,
      model: settings.model,
      baseUrl: settings.baseUrl,
      transport: settings.openaiResponsesTransport,
      nativeResponses: settings.nativeResponses
    });

    const unified = await importUnifiedLlmProvider();
    const registry = unified.createBootstrapExtensionRegistry();
    const proxy = normalizeOptionalString(await resolveMaybe(options.proxy));
    const proxyFetch = proxy ? createProxyFetch(proxy) : undefined;
    const debugContext = getDebugCaptureContext(request) ?? { conversationId: request.conversationId ?? '', modelRequestId: request.id };
    const providerFetch = createTerminalValidatedFetch(proxyFetch ?? fetch, settings.provider, {
      createObservation: options.debugCapture ? () => new DebugHttpObservation(options.debugCapture!, debugContext, unified.attachLlmResponseObserver) : undefined
    });
    const headers = mergeHeaders(await resolveMaybe(options.headers), settings.headers);
    const requestBody = withoutNativeServerSideCompaction(
      requestBodyWithOpenAIPromptCacheKey(settings, request.conversationId),
      request.contents
    );
    if (proxy) console.log(`[LimCode] LLM proxy enabled: ${proxy}`);
    const providerConfig = {
      provider: settings.provider,
      model: settings.model,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      ...(settings.contextWindowTokens ? { contextWindow: settings.contextWindowTokens } : {}),
      ...(headers ? { headers } : {}),
      ...(requestBody ? { requestBody } : {}),
      ...unifiedPromptCacheConfigEntry(settings, requestBody),
      ...openAIResponsesWebSocketConfigEntry(settings, request.conversationId),
      ...(proxy ? { proxy } : {}),
      fetch: providerFetch
    };
    const provider = installProviderCompatibility(
      unified.createLLMFromConfig(providerConfig, registry.llmProviders) as UnifiedChatProvider,
      settings.provider,
      settings.model
    );
    const httpFallbackProvider = isOpenAIResponsesWebSocketMode(settings)
      ? installProviderCompatibility(unified.createLLMFromConfig({
          ...providerConfig,
          transport: undefined,
          webSocketSessionKey: undefined
        }, registry.llmProviders) as UnifiedChatProvider, settings.provider, settings.model)
      : undefined;

    const retryEnabled = settings.retryOnError !== false;
    const maxRetries = normalizeRetryMaxAttempts(settings.retryMaxAttempts) ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS;
    let retryCount = 0;
    let sawRetry = false;

    while (true) {
      try {
        await runLlmAttempt(
          request,
          streamEmit,
          settings,
          provider,
          httpFallbackProvider,
          unified,
          options,
          signal,
          sawRetry ? { retryAttempt: retryCount, retryMaxAttempts: maxRetries } : undefined,
          proxy,
          nativeCapabilities,
          controls
        );
        return;
      } catch (error) {
        if (isRequestAbort(signal)) return;
        const failure = failureFromCaughtError(error);
        const nextRetryCount = retryCount + 1;
        const canRetry = retryEnabled
          && !retryControl.cancelRequested
          && (maxRetries === -1 || nextRetryCount <= maxRetries);

        if (!canRetry) {
          if (retryControl.cancelRequested && retryCount > 0) {
            emitLlmRetryCancelled(streamEmit, request.id, failure.message, retryCount, maxRetries, failure.rawError);
          }
          emitLlmError(streamEmit, request.id, failure.message, failure.rawError, {
            retryAttempt: retryCount || undefined,
            retryMaxAttempts: retryEnabled ? maxRetries : 0,
            createdAt: failure.createdAt,
            streamOutputDurationMs: failure.streamOutputDurationMs
          });
          return;
        }

        sawRetry = true;
        retryCount = nextRetryCount;
        const retryDelayMs = retryDelayForAttempt(retryCount, settings.retryDelaySeconds);
        emitLlmRetryScheduled(streamEmit, request.id, failure.message, failure.rawError, retryCount, maxRetries, retryDelayMs);
        const shouldRetry = await waitForRetryDelay(retryDelayMs, retryControl, signal);
        if (!shouldRetry) {
          emitLlmRetryCancelled(streamEmit, request.id, failure.message, retryCount, maxRetries, failure.rawError);
          emitLlmError(streamEmit, request.id, failure.message, failure.rawError, {
            retryAttempt: retryCount,
            retryMaxAttempts: maxRetries,
            createdAt: failure.createdAt,
            streamOutputDurationMs: failure.streamOutputDurationMs
          });
          return;
        }
        emitLlmRetryStarted(streamEmit, request.id, failure.message, failure.rawError, retryCount, maxRetries);
      }
    }
  } catch (error) {
    if (isRequestAbort(signal)) return;
    const failure = failureFromCaughtError(error);
    emitLlmError(streamEmit, request.id, failure.message, failure.rawError, {
      createdAt: failure.createdAt,
      streamOutputDurationMs: failure.streamOutputDurationMs
    });
  } finally {
    streamEvents.dispose();
  }
}

async function runLlmAttempt(
  request: LlmStartRequest,
  emit: Emit,
  settings: LlmProviderConfigRecord,
  provider: UnifiedChatProvider,
  httpFallbackProvider: UnifiedChatProvider | undefined,
  unified: UnifiedModule,
  options: LlmProviderOptions,
  signal?: AbortSignal,
  retryRecoveryNotice?: LlmAttemptRetryRecoveryNotice,
  proxy?: string,
  nativeCapabilities?: OpenAIResponsesNativeCapabilities,
  controls?: LlmStartRuntimeControls
): Promise<void> {
  const debugContext = getDebugCaptureContext(request) ?? { conversationId: request.conversationId ?? '', modelRequestId: request.id };
  const observingEmit = (value: unknown): Emit => {
    if (!options.debugCapture?.active(debugContext)) return emit;
    const sdkSource = debugSource(unified.getLlmObservation(value));
    const refs = sdkSource ? [sdkSource] : debugCaptureSources(value);
    return event => {
      const ref = captureDebug(options.debugCapture, debugContext, () => ({ stage: 'capability.output', sources: refs, payload: event, metadata: { kind: event.type } }));
      if (ref) associateDebugCapture(event, [ref]);
      emit(event);
    };
  };
  const preparedRequest = await prepareLlmStartRequestMultimodal(request, options, nativeCapabilities);
  const unifiedRequest = toUnifiedRequest(
    preparedRequest,
    effectiveRequestGenerationConfig(request, settings),
    settings.provider,
    nativeCapabilities
  );
  const forceStreaming = isOpenAIResponsesWebSocketMode(settings);
  if (settings.stream === false && !forceStreaming) {
    const response = await provider.chat<UnifiedLLMResponse>(unifiedRequest, {
      inputFormat: 'unified',
      outputFormat: 'unified',
      signal
    });
    if (signal?.aborted) throw createAbortError(`Aborted LLM request: ${request.id}`);
    if (hasUnifiedError(response)) {
      throw new LlmAttemptFailureError(failureFromProviderError(response.error, { rawResponse: response.rawResponse }));
    }
    emitRetryRecovered(request.id, emit, retryRecoveryNotice);
    emitUnifiedResponse(request.id, response, observingEmit(response));
    const completedAt = Date.now();
    emit({
      type: LlmEventType.Done,
      payload: {
        requestId: request.id,
        createdAt: completedAt,
        completedAt,
        streamOutputDurationMs: 0,
        ...(usageMetadataFromCompact(response.usageMetadata) ? { usageMetadata: usageMetadataFromCompact(response.usageMetadata) } : {})
      }
    });
    return;
  }

  let latestUsageMetadata: LlmUsageMetadataRecord | undefined;
  let chainUsageTotals: LlmUsageMetadataRecord | undefined;
  const nativeChain: OpenAIResponsesNativeChainContext = {};
  const completedContents: MessageContent[] = [];
  const timing: LlmAttemptTimingState = { streamTimingChunkCount: 0 };
  let activeThoughtBlock: ActiveThoughtBlock | undefined;
  let retryRecoveryPending = retryRecoveryNotice !== undefined;
  const nativeHooks = controls?.native;
  // 只包装 onController（媒体解析）；onLaneQueueState 等其他本地 hook 原样透传。
  const wrappedNativeHooks: OpenAIResponsesNativeHooks | undefined = nativeHooks
    ? {
        ...nativeHooks,
        ...(nativeHooks.onController
          ? {
              onController: (controller: OpenAIResponsesNativeController | undefined) =>
                nativeHooks.onController!(controller ? wrapOpenAIResponsesNativeController(controller, options) : undefined)
            }
          : {})
      }
    : undefined;
  const nativeStreamOptions = forceStreaming && nativeCapabilities && (
    nativeCapabilities.asyncTools || nativeCapabilities.steering
    || nativeCapabilities.reasoningUpdates || nativeCapabilities.multiplexing)
    ? {
        ...(wrappedNativeHooks ?? {}),
        steering: nativeCapabilities.steering,
        reasoningUpdates: nativeCapabilities.reasoningUpdates,
        multiplexing: nativeCapabilities.multiplexing
      }
    : undefined;
  const nativeHttpSession = !forceStreaming
    && nativeCapabilities?.asyncTools === true
    && settings.provider === 'openai-responses';
  try {
    const stream: AsyncIterable<UnifiedLLMStreamChunk> = forceStreaming
      ? streamOpenAIResponsesWithLimCodeSession({
          request,
          settings,
          provider,
          httpFallbackProvider,
          unified,
          unifiedRequest,
          signal,
          retryRecoveryNotice,
          proxy,
          onTransportTrace: options.onTransportTrace,
          debugCapture: options.debugCapture,
          ...(nativeStreamOptions ? { native: nativeStreamOptions } : {})
        })
      : nativeHttpSession
        ? streamOpenAIResponsesNativeHttpSession({
            provider,
            unifiedRequest,
            signal,
            ...(wrappedNativeHooks ? { hooks: wrappedNativeHooks } : {})
          })
        : provider.chatStream<UnifiedLLMStreamChunk>(unifiedRequest, {
            inputFormat: 'unified',
            outputFormat: 'unified',
            signal
          });
    for await (const chunk of stream) {
      const chunkEmit = observingEmit(chunk);
      if (signal?.aborted) throw createAbortError(`Aborted LLM request: ${request.id}`);
      if (hasUnifiedError(chunk)) {
        const failure = failureFromProviderError(chunk.error, {
          rawChunk: (chunk as { rawChunk?: unknown }).rawChunk ?? chunk,
          ...createDoneTiming(timing.firstStreamChunkAt, Date.now(), timing.firstStreamChunkMark, nowMonotonicMs(), timing.streamTimingChunkCount)
        });
        throw new LlmAttemptFailureError(failure);
      }
      const chunkAt = Date.now();
      const chunkMark = nowMonotonicMs();
      const nativeEvent = (chunk as LimCodeOpenAIResponsesStreamChunk).nativeEvent;
      if (nativeEvent) {
        if (nativeEvent.type === 'response.created') {
          // 新 response 开始：上一 response 的 usage 并入链聚合，输出 item 归属切换。
          if (latestUsageMetadata) {
            chainUsageTotals = sumUsageMetadata(chainUsageTotals, latestUsageMetadata);
            latestUsageMetadata = undefined;
          }
          nativeChain.current = {
            responseId: nativeEvent.responseId,
            ...(nativeEvent.previousResponseId ? { previousResponseId: nativeEvent.previousResponseId } : {})
          };
        }
        chunkEmit({
          type: LlmEventType.NativeControl,
          payload: {
            requestId: request.id,
            event: nativeEvent.type === 'response.created' && nativeCapabilities
              ? { ...nativeEvent, capabilities: nativeCapabilities }
              : nativeEvent
          }
        });
      }
      if (retryRecoveryPending && hasStreamTimingChunk(chunk)) {
        emitRetryRecovered(request.id, emit, retryRecoveryNotice);
        retryRecoveryPending = false;
      }
      activeThoughtBlock = emitThoughtDeltas(request.id, activeThoughtBlock, chunk, chunkAt, chunkEmit, nativeChain);
      if (activeThoughtBlock && shouldCloseThoughtBlock(chunk)) activeThoughtBlock = finishThoughtBlock(request.id, activeThoughtBlock, chunkAt, chunkEmit);
      const chunkUsageMetadata = usageMetadataFromChunk(chunk);
      if (chunkUsageMetadata) latestUsageMetadata = mergeUsageMetadata(latestUsageMetadata, chunkUsageMetadata);
      const completedContent = (chunk as LimCodeOpenAIResponsesStreamChunk).completedContent;
      if (completedContent) completedContents.push(fromUnifiedCompletedContent(completedContent, nativeChain));
      const httpCompletedContents = (chunk as OpenAIResponsesHttpNativeStreamChunk).completedContents;
      if (Array.isArray(httpCompletedContents)) {
        for (const content of httpCompletedContents) {
          completedContents.push(fromUnifiedCompletedContent(content, nativeChain));
        }
      }
      if (hasStreamTimingChunk(chunk)) {
        timing.firstStreamChunkAt ??= chunkAt;
        timing.firstStreamChunkMark ??= chunkMark;
        timing.streamTimingChunkCount += 1;
      }
      emitUnifiedChunk(request.id, chunk, chunkEmit, nativeChain);
    }
  } catch (error) {
    const aborted = isRequestAbort(signal);
    if (activeThoughtBlock) activeThoughtBlock = aborted
      ? disposeThoughtBlock(activeThoughtBlock)
      : finishThoughtBlock(request.id, activeThoughtBlock, Date.now(), emit);
    if (aborted) throw createAbortError(`Aborted LLM request: ${request.id}`);
    const failure = failureFromCaughtError(error);
    const failureTiming = createDoneTiming(
      timing.firstStreamChunkAt,
      Date.now(),
      timing.firstStreamChunkMark,
      nowMonotonicMs(),
      timing.streamTimingChunkCount
    );
    throw new LlmAttemptFailureError({
      ...failure,
      createdAt: failureTiming.createdAt,
      ...(failureTiming.streamOutputDurationMs !== undefined
        ? { streamOutputDurationMs: failureTiming.streamOutputDurationMs }
        : {})
    });
  }

  if (signal?.aborted) throw createAbortError(`Aborted LLM request: ${request.id}`);
  const finishedAt = Date.now();
  const finishedMark = nowMonotonicMs();
  if (activeThoughtBlock) finishThoughtBlock(request.id, activeThoughtBlock, finishedAt, emit);
  if (retryRecoveryPending) emitRetryRecovered(request.id, emit, retryRecoveryNotice);
  // 原生链可能有多个物理 response；Done 只在逻辑链尾发出，内容按链序聚合，
  // 每个 part 的 outputItem.providerResponseId/previousResponseId 保留边界，绝不跨边界静默拼接。
  const authoritativeCompletedContent = completedContents.length === 0
    ? undefined
    : completedContents.length === 1
      ? completedContents[0]
      : { role: 'model' as const, parts: completedContents.flatMap((content) => content.parts) };
  const aggregatedUsageMetadata = latestUsageMetadata
    ? sumUsageMetadata(chainUsageTotals, latestUsageMetadata)
    : chainUsageTotals;
  emit({
    type: LlmEventType.Done,
    payload: {
      requestId: request.id,
      ...(authoritativeCompletedContent ? { content: authoritativeCompletedContent } : {}),
      ...createDoneTiming(timing.firstStreamChunkAt, finishedAt, timing.firstStreamChunkMark, finishedMark, timing.streamTimingChunkCount),
      completedAt: finishedAt,
      ...(aggregatedUsageMetadata ? { usageMetadata: aggregatedUsageMetadata } : {})
    }
  });
}

async function* streamOpenAIResponsesWithLimCodeSession(input: {
  debugCapture?: DebugCaptureRecorder;
  request: LlmStartRequest;
  settings: LlmProviderConfigRecord;
  provider: UnifiedChatProvider;
  httpFallbackProvider?: UnifiedChatProvider;
  unified: UnifiedModule;
  unifiedRequest: UnifiedLLMRequest;
  signal?: AbortSignal;
  retryRecoveryNotice?: LlmAttemptRetryRecoveryNotice;
  proxy?: string;
  native?: OpenAIResponsesWebSocketStreamOptions['native'];
  onTransportTrace?: (trace: LlmProviderTransportTrace) => void;
}): AsyncGenerator<LimCodeOpenAIResponsesStreamChunk> {
  const conversationId = requireOpenAIResponsesWebSocketConversationId(input.request.conversationId);
  const sessionKey = createOpenAIResponsesWebSocketSessionKey(input.settings, conversationId);
  const now = Date.now();
  for (const [key, expiresAt] of openAIResponsesHttpCooldowns) {
    if (expiresAt <= now) openAIResponsesHttpCooldowns.delete(key);
  }
  const cooldownUntil = openAIResponsesHttpCooldowns.get(sessionKey) ?? 0;
  if (input.httpFallbackProvider && cooldownUntil > now) {
    reportTransportPolicyTrace(input, sessionKey, 'http_cooldown', 'temporary_ws_cooldown');
    yield* input.httpFallbackProvider.chatStream<LimCodeOpenAIResponsesStreamChunk>(input.unifiedRequest, {
      inputFormat: 'unified',
      outputFormat: 'unified',
      signal: input.signal
    });
    return;
  }
  const reliableAttempt = input.request.reliableProviderAttempt;
  const retryTimeBudgetExhausted = reliableAttempt?.requestCreatedAt !== undefined
    && reliableAttempt.attemptSeq > 1
    && now - reliableAttempt.requestCreatedAt >= OPENAI_RESPONSES_WS_RETRY_BUDGET_MS;
  if (input.httpFallbackProvider && retryTimeBudgetExhausted) {
    openAIResponsesHttpCooldowns.set(sessionKey, now + OPENAI_RESPONSES_HTTP_COOLDOWN_MS);
    reportTransportPolicyTrace(input, sessionKey, 'http_fallback', 'ws_retry_time_budget_exhausted');
    yield* input.httpFallbackProvider.chatStream<LimCodeOpenAIResponsesStreamChunk>(input.unifiedRequest, {
      inputFormat: 'unified',
      outputFormat: 'unified',
      signal: input.signal
    });
    return;
  }
  if (cooldownUntil > 0) openAIResponsesHttpCooldowns.delete(sessionKey);

  const dryRun = await input.provider.dryRun(input.unifiedRequest, {
    inputFormat: 'unified',
    outputFormat: 'unified',
    stream: true
  });
  const format = new input.unified.OpenAIResponsesFormat(input.settings.model) as OpenAIResponsesFormatAdapter;
  const continuation = openAIResponsesContinuationHint(input.request, input.unifiedRequest);
  try {
    const { streamOpenAIResponsesWebSocketSession } = await openAIResponsesWebSocketSession();
    yield* streamOpenAIResponsesWebSocketSession({
      debugCapture: input.debugCapture ? {
        recorder: input.debugCapture,
        context: getDebugCaptureContext(input.request) ?? { conversationId, modelRequestId: input.request.id },
        metadata: { url: dryRun.url }
      } : undefined,
      sessionKey,
      url: dryRun.url,
      headers: dryRun.headers,
      body: dryRun.body,
      format,
      ...(continuation ? { continuation } : {}),
      ...(input.native ? { native: input.native } : {}),
      forceNewConnection: reliableAttempt?.attemptSeq !== undefined
        && reliableAttempt.attemptSeq > 1,
      signal: input.signal,
      proxy: input.proxy,
      onDecision: (decision) => {
        reportTransportTrace(input, {
          requestId: input.request.id,
          conversationId,
          phase: 'continuation_decision',
          observedAt: Date.now(),
          sessionKeyHash: decision.sessionKeyHash,
          connectionGeneration: decision.connectionGeneration,
          connectionReused: decision.connectionReused,
          connectionReason: decision.connectionReason,
          mode: decision.mode,
          reason: decision.reason,
          fullInputItemCount: decision.fullInputItemCount,
          sentInputItemCount: decision.sentInputItemCount
        });
        console.log('[LimCode][OpenAIResponsesWS]', JSON.stringify({
          implementation: LIMCODE_OPENAI_RESPONSES_WS_IMPLEMENTATION,
          requestId: input.request.id,
          conversationId: input.request.conversationId ?? '',
          sessionKeyHash: decision.sessionKeyHash,
          connectionGeneration: decision.connectionGeneration,
          connectionReused: decision.connectionReused,
          connectionReason: decision.connectionReason,
          mode: decision.mode,
          reason: decision.reason,
          fullInputItemCount: decision.fullInputItemCount,
          sentInputItemCount: decision.sentInputItemCount,
          fullInputFingerprint: decision.fullInputFingerprint,
          sentInputFingerprint: decision.sentInputFingerprint,
          baselineFingerprint: decision.baselineFingerprint
        }));
      },
      onPhase: (phase) => reportTransportTrace(input, traceFromWebSocketPhase(input, phase))
    });
    openAIResponsesHttpCooldowns.delete(sessionKey);
  } catch (error) {
    if (!input.httpFallbackProvider || !shouldFallbackOpenAIResponsesToHttp(input, error)) throw error;
    openAIResponsesHttpCooldowns.set(sessionKey, Date.now() + OPENAI_RESPONSES_HTTP_COOLDOWN_MS);
    reportTransportPolicyTrace(input, sessionKey, 'http_fallback', 'ws_retry_budget_exhausted');
    yield* input.httpFallbackProvider.chatStream<LimCodeOpenAIResponsesStreamChunk>(input.unifiedRequest, {
      inputFormat: 'unified',
      outputFormat: 'unified',
      signal: input.signal
    });
  }
}

interface OpenAIResponsesNativeHttpQueuedSubmission {
  outputs: readonly OpenAIResponsesToolOutput[];
  resolve: (admission: OpenAIResponsesNativeResultAdmission) => void;
  reject: (error: unknown) => void;
}

/** vendor fork 在 Astra SSE 解码时附加的原生事件（结构子集；无 WS 连接代）。 */
interface OpenAIResponsesHttpNativeStreamChunk extends UnifiedLLMStreamChunk {
  nativeEvent?: {
    type: 'response.created' | 'response.completed' | 'response.incomplete';
    responseId: string;
    previousResponseId?: string;
    reason?: string;
    usage?: Record<string, unknown>;
    admittedToolResultCallIds?: string[];
  };
  completedContents?: UnifiedContent[];
}

/**
 * HTTP/SSE 原生会话：与 WS 同一个 OpenAIResponsesNativeController 契约的轻量泵。
 * 逻辑请求跨多个物理 SSE response 存活；submitToolResults 排入队列，达界后以
 * stateless 全量历史（既有 unified contents + 已解码 response 输出原样回传 + 每个就绪结果
 * 一个 function_call_output raw input item）发起下一个物理 response，并在其真实
 * response.created 解决准入收据。store=false，不伪造任何物理连接身份；steering 仅 WS。
 */
async function* streamOpenAIResponsesNativeHttpSession(input: {
  provider: UnifiedChatProvider;
  unifiedRequest: UnifiedLLMRequest;
  signal?: AbortSignal;
  hooks?: OpenAIResponsesNativeHooks;
}): AsyncGenerator<UnifiedLLMStreamChunk> {
  const queue: OpenAIResponsesNativeHttpQueuedSubmission[] = [];
  let logicalEnded = false;
  let latestResponseId: string | undefined;
  let waiting: (() => void) | undefined;
  const wake = (): void => {
    const pending = waiting;
    waiting = undefined;
    pending?.();
  };
  const controller: OpenAIResponsesNativeController = {
    get responseId() { return latestResponseId; },
    connectionGeneration: undefined,
    streamId: undefined,
    steer() {
      return Promise.reject(new OpenAIResponsesNativeDeliveryError(
        'not_sent',
        'Astra steering requires the native WebSocket transport.'
      ));
    },
    submitToolResults(outputs) {
      if (outputs.length === 0) {
        return Promise.reject(new OpenAIResponsesNativeDeliveryError(
          'failed',
          'Native tool-result submission requires at least one output.'
        ));
      }
      if (logicalEnded) {
        return Promise.reject(new OpenAIResponsesNativeDeliveryError(
          'not_sent',
          'Logical native request already ended.'
        ));
      }
      return new Promise<OpenAIResponsesNativeResultAdmission>((resolve, reject) => {
        queue.push({ outputs, resolve, reject });
        wake();
      });
    },
    endLogicalRequest() {
      logicalEnded = true;
      wake();
    }
  };
  input.hooks?.onController?.(controller);

  const rejectQueued = (error: OpenAIResponsesNativeDeliveryError): void => {
    for (const submission of queue.splice(0, queue.length)) submission.reject(error);
  };
  // 跨物理 response 维护所有未决原生调用 ID：同步/异步结果都经同一控制器泵交付，
  // async 只影响内核的早期准入时点，不影响"结果必须回传"。任何 response 接收到的调用
  // 进入集合，只有随续流真实交付（drain 进出站历史）才移除；部分就绪不影响其余未决项。
  const pendingNativeCallIds = new Set<string>();
  let contents = input.unifiedRequest.contents;
  try {
    for (;;) {
      const drained = queue.splice(0, queue.length);
      for (const submission of drained) {
        for (const output of submission.outputs) {
          if (output.callId) pendingNativeCallIds.delete(output.callId);
        }
      }
      let drainedSettled = false;
      const responseContents: UnifiedContent[] = [];
      try {
        for await (const chunk of input.provider.chatStream<UnifiedLLMStreamChunk>(
          { ...input.unifiedRequest, contents },
          { inputFormat: 'unified', outputFormat: 'unified', signal: input.signal }
        )) {
          const nativeChunk = chunk as OpenAIResponsesHttpNativeStreamChunk;
          const nativeEvent = nativeChunk.nativeEvent;
          if (nativeEvent?.type === 'response.created' && typeof nativeEvent.responseId === 'string' && nativeEvent.responseId) {
            latestResponseId = nativeEvent.responseId;
            if (!drainedSettled && drained.length > 0) {
              drainedSettled = true;
              const admission: OpenAIResponsesNativeResultAdmission = { responseId: nativeEvent.responseId };
              for (const submission of drained) submission.resolve(admission);
              // 数据级观察：本 create 实际携带的结果 call_id，供内核先落投递事实再处理新输出。
              const admittedToolResultCallIds = drained.flatMap((submission) =>
                submission.outputs.map((output) => output.callId).filter((callId): callId is string => !!callId));
              if (admittedToolResultCallIds.length > 0) {
                nativeChunk.nativeEvent = { ...nativeEvent, admittedToolResultCallIds };
              }
            }
          }
          collectNativeHttpOutstandingCallIds(chunk, pendingNativeCallIds);
          if (Array.isArray(nativeChunk.completedContents)) responseContents.push(...nativeChunk.completedContents);
          yield chunk;
        }
      } catch (error) {
        // 续流 POST 已经发起：无法证明"从未到达线上"，一律 admission_unknown；
        // not_sent 只留给从未 drain 出站（尚在队列）的提交。
        const deliveryError = new OpenAIResponsesNativeDeliveryError(
          'admission_unknown',
          `Native HTTP continuation failed after the continuation request began: ${error instanceof Error ? error.message : String(error)}`
        );
        for (const submission of drained) submission.reject(deliveryError);
        rejectQueued(deliveryError);
        throw error;
      }

      // 还有任何未决调用（同步或异步，含更早 response 遗留下来且尚未交付的）且队列空：
      // 等待内核经控制器交付或显式终止逻辑请求；全部已决且队列空时才是普通终态。
      while (queue.length === 0 && !logicalEnded && pendingNativeCallIds.size > 0) {
        await new Promise<void>((resolveWait, rejectWait) => {
          const onAbort = (): void => {
            waiting = undefined;
            rejectWait(createAbortError(`Aborted LLM request while awaiting native HTTP continuation.`));
          };
          waiting = () => {
            input.signal?.removeEventListener('abort', onAbort);
            resolveWait();
          };
          if (input.signal?.aborted) {
            waiting = undefined;
            rejectWait(createAbortError(`Aborted LLM request while awaiting native HTTP continuation.`));
            return;
          }
          input.signal?.addEventListener('abort', onAbort, { once: true });
        });
      }
      if (queue.length === 0) break;
      contents = [
        ...contents,
        ...responseContents,
        ...queue.flatMap((submission) => submission.outputs.map(nativeToolOutputContent))
      ];
    }
  } finally {
    input.hooks?.onController?.(undefined);
    rejectQueued(new OpenAIResponsesNativeDeliveryError(
      'not_sent',
      'Native HTTP session ended before the submission reached the wire.'
    ));
  }
}

/**
 * 从流式 chunk 收集接收到的原生调用 ID（async:true/false/缺失全部计入）。
 * 原生 HTTP 会话里同步与异步结果都经控制器交付，结果未回传前会话不得结束。
 */
function collectNativeHttpOutstandingCallIds(chunk: UnifiedLLMStreamChunk, pending: Set<string>): void {
  const callParts = [
    ...(chunk.functionCalls ?? []),
    ...(chunk.partsDelta ?? []).filter((part) => 'functionCall' in part)
  ];
  for (const part of callParts) {
    if (!('functionCall' in part)) continue;
    const callId = part.functionCall.callId;
    if (callId) pending.add(callId);
  }
}

/** 把交付的工具输出包装成 raw input item 内容，借 providerContext 无损直通到线上。 */
function nativeToolOutputContent(output: OpenAIResponsesToolOutput): UnifiedContent {
  return {
    role: 'user',
    parts: [{
      providerContext: {
        provider: 'openai',
        format: 'openai-responses',
        endpoint: 'responses',
        itemType: output.type,
        rawItem: nativeToolOutputRawItem(output)
      }
    }]
  } as unknown as UnifiedContent;
}

function nativeToolOutputRawItem(output: OpenAIResponsesToolOutput): Record<string, unknown> {
  if (output.type === 'mcp_approval_response') {
    return {
      type: 'mcp_approval_response',
      ...(output.approvalRequestId ? { approval_request_id: output.approvalRequestId } : {}),
      ...(output.approve !== undefined ? { approve: output.approve } : {})
    };
  }
  return {
    type: output.type,
    ...(output.callId ? { call_id: output.callId } : {}),
    ...(output.output !== undefined ? { output: output.output } : {})
  };
}

function openAIResponsesContinuationHint(
  request: LlmStartRequest,
  unifiedRequest: UnifiedLLMRequest
): OpenAIResponsesWebSocketStreamOptions['continuation'] | undefined {
  const metadata = request.openAIResponsesContinuation;
  if (!metadata) return undefined;
  const kinds = metadata.volatileTailContentKinds;
  if (!Array.isArray(kinds) || kinds.length > unifiedRequest.contents.length) {
    return {
      volatileTailContents: [],
      volatileTailContentKinds: [],
      forceFullReason: 'invalid_volatile_tail_boundary'
    };
  }
  return {
    volatileTailContents: unifiedRequest.contents.slice(unifiedRequest.contents.length - kinds.length),
    volatileTailContentKinds: [...kinds],
    ...(typeof metadata.forceFullReason === 'string' && metadata.forceFullReason
      ? { forceFullReason: metadata.forceFullReason }
      : {})
  };
}

function shouldFallbackOpenAIResponsesToHttp(
  input: {
    request: LlmStartRequest;
    retryRecoveryNotice?: LlmAttemptRetryRecoveryNotice;
  },
  error: unknown
): boolean {
  const raw = rawErrorFromUnknown(error);
  if (findNestedMetadata(raw, 'receivedSemanticOutput') === true) return false;
  if (findNestedMetadata(raw, 'retryable') === false) return false;

  const status = findNestedNumber(raw, 'status');
  const signature = JSON.stringify(raw).toLowerCase();
  const recoverable = findNestedMetadata(raw, 'retryable') === true
    || status === 408
    || status === 425
    || status === 429
    || (status !== undefined && status >= 500 && status <= 599)
    || /econnreset|econnrefused|enotfound|enetunreach|ehostunreach|etimedout|eai_again|network_changed|socket hang up|network error|fetch failed|websocket closed before|timed? out|unexpected server response:\s*(?:408|425|429|5\d\d)\b/.test(signature);
  if (!recoverable) return false;

  const attempt = input.request.reliableProviderAttempt;
  const attemptLimitReached = attempt !== undefined && attempt.attemptSeq >= attempt.maxAttempts;
  const elapsedBudgetReached = attempt?.requestCreatedAt !== undefined
    && Date.now() - attempt.requestCreatedAt >= OPENAI_RESPONSES_WS_RETRY_BUDGET_MS;
  const legacyLimitReached = input.retryRecoveryNotice !== undefined
    && input.retryRecoveryNotice.retryAttempt >= input.retryRecoveryNotice.retryMaxAttempts;
  return attemptLimitReached || elapsedBudgetReached || legacyLimitReached;
}

function reportTransportPolicyTrace(
  input: {
    request: LlmStartRequest;
    onTransportTrace?: (trace: LlmProviderTransportTrace) => void;
  },
  sessionKey: string,
  phase: 'http_fallback' | 'http_cooldown',
  reason: string
): void {
  reportTransportTrace(input, {
    requestId: input.request.id,
    conversationId: input.request.conversationId ?? '',
    phase,
    observedAt: Date.now(),
    sessionKeyHash: createHash('sha256').update(sessionKey).digest('hex').slice(0, 12),
    connectionGeneration: 0,
    reason
  });
}

function findNestedMetadata(
  value: unknown,
  key: string,
  depth = 0,
  seen = new Set<object>()
): boolean | undefined {
  if (depth > 8 || value === null || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  if (isRecord(value) && typeof value[key] === 'boolean') return value[key] as boolean;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const nested = findNestedMetadata(child, key, depth + 1, seen);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function findNestedNumber(
  value: unknown,
  key: string,
  depth = 0,
  seen = new Set<object>()
): number | undefined {
  if (depth > 8 || value === null || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  if (isRecord(value) && typeof value[key] === 'number' && Number.isFinite(value[key])) return value[key] as number;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const nested = findNestedNumber(child, key, depth + 1, seen);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function traceFromWebSocketPhase(
  input: { request: LlmStartRequest },
  phase: OpenAIResponsesWebSocketPhase
): LlmProviderTransportTrace {
  return {
    requestId: input.request.id,
    conversationId: input.request.conversationId ?? '',
    phase: phase.phase,
    observedAt: phase.observedAt,
    sessionKeyHash: phase.sessionKeyHash,
    connectionGeneration: phase.connectionGeneration,
    ...(phase.elapsedMs !== undefined ? { elapsedMs: phase.elapsedMs } : {}),
    ...(phase.connectionReused !== undefined ? { connectionReused: phase.connectionReused } : {}),
    ...(phase.connectionReason ? { connectionReason: phase.connectionReason } : {}),
    ...(phase.mode ? { mode: phase.mode } : {}),
    ...(phase.reason ? { reason: phase.reason } : {}),
    ...(phase.timeoutPhase ? { timeoutPhase: phase.timeoutPhase } : {}),
    ...(phase.responseCreateFrameSha256
      ? { responseCreateFrameSha256: phase.responseCreateFrameSha256 }
      : {}),
    ...(phase.responseCreateFrameBytes !== undefined
      ? { responseCreateFrameBytes: phase.responseCreateFrameBytes }
      : {}),
    ...(phase.responseCreateSeq !== undefined
      ? { responseCreateSeq: phase.responseCreateSeq }
      : {})
  };
}

function reportTransportTrace(
  input: { onTransportTrace?: (trace: LlmProviderTransportTrace) => void; debugCapture?: DebugCaptureRecorder; request?: LlmStartRequest },
  trace: LlmProviderTransportTrace
): void {
  try {
    captureDebug(input.debugCapture, (input.request ? getDebugCaptureContext(input.request) : undefined)
      ?? { conversationId: trace.conversationId, modelRequestId: trace.requestId },
      () => ({ stage: 'transport.phase', payload: trace, metadata: { phase: trace.phase } }));
    input.onTransportTrace?.(trace);
  } catch {
    // Observability is best-effort and must not become Provider authority.
  }
}

function emitRetryRecovered(requestId: string, emit: Emit, notice: LlmAttemptRetryRecoveryNotice | undefined): void {
  if (!notice) return;
  emitLlmRetryRecovered(emit, requestId, '自动重试成功。', notice.retryAttempt, notice.retryMaxAttempts);
}

function hasUnifiedError(value: unknown): value is { error: unknown; rawResponse?: unknown; rawChunk?: unknown } {
  return isRecord(value) && value.error !== undefined && value.error !== null;
}

function failureFromCaughtError(error: unknown): LlmAttemptFailure {
  if (error instanceof LlmAttemptFailureError) return error.failure;
  const rawError = rawErrorFromUnknown(error);
  return { message: messageFromRawError(rawError), rawError, createdAt: Date.now() };
}

function failureFromProviderError(error: unknown, extras: Record<string, unknown> = {}): LlmAttemptFailure {
  const rawError = rawErrorFromUnknown(error, extras);
  return {
    message: messageFromRawError(rawError),
    rawError,
    createdAt: typeof extras.createdAt === 'number' ? extras.createdAt : Date.now(),
    ...(typeof extras.streamOutputDurationMs === 'number' ? { streamOutputDurationMs: extras.streamOutputDurationMs } : {})
  };
}

export function rawErrorFromUnknown(error: unknown, extras: Record<string, unknown> = {}): LlmRawErrorInfoRecord {
  const base = toPlainJsonLike(error);
  const baseRecord = isRecord(base) ? base : { data: base };
  const merged: LlmRawErrorInfoRecord = { ...baseRecord };
  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined && !isSensitiveLlmErrorField(key)) merged[key] = toPlainJsonLike(value);
  }
  if (typeof merged.message !== 'string') {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : undefined;
    if (message) merged.message = message;
  }
  return merged;
}

function messageFromRawError(rawError: LlmRawErrorInfoRecord): string {
  return summarizeLlmRawError(rawError);
}

export function summarizeLlmRawError(rawError: LlmRawErrorInfoRecord): string {
  const summary = summarizeLlmRawErrorBase(rawError);
  const evidence = wireInvariantEvidence(rawError);
  return evidence && remoteReportsMissingToolResultId(rawError)
    ? `${summary} Local wire invariant passed before fetch; ${evidence}.`
    : summary;
}

function summarizeLlmRawErrorBase(rawError: LlmRawErrorInfoRecord): string {
  const direct = specificErrorMessage(rawError.message);
  if (direct) return direct;
  for (const candidate of [
    rawError.rawBody,
    rawError.rawChunk,
    rawError.rawResponse,
    rawError.data,
    rawError.bodyText
  ]) {
    const message = nestedMessage(candidate);
    if (message) return message;
  }
  const bodyText = specificErrorMessage(rawError.bodyText);
  if (bodyText) return bodyText;
  const dataText = specificErrorMessage(rawError.data);
  if (dataText) return dataText;
  const kind = typeof rawError.kind === 'string' && rawError.kind.trim() ? rawError.kind.trim() : 'llm_error';
  const status = typeof rawError.status === 'number' ? ` HTTP ${rawError.status}` : '';
  return `LLM 请求失败：${kind}${status}`;
}

function wireInvariantEvidence(rawError: LlmRawErrorInfoRecord): string | undefined {
  const headers = isRecord(rawError.headers) ? rawError.headers : undefined;
  const value = headers?.['x-limcode-wire-invariant'];
  return typeof value === 'string' && /^passed; body_sha256=[a-f0-9]{64}$/.test(value)
    ? value.slice('passed; '.length)
    : undefined;
}

function remoteReportsMissingToolResultId(rawError: LlmRawErrorInfoRecord): boolean {
  const text = stringifyJson(toPlainJsonLike(rawError));
  return /(?:missing|required)[^\n]{0,160}(?:tool_call_id|call_id|tool_use_id|functionResponse)|(?:tool_call_id|call_id|tool_use_id|functionResponse)[^\n]{0,160}(?:missing|required)/i.test(text);
}

function nestedMessage(value: unknown, depth = 0, seen = new Set<object>()): string | undefined {
  if (depth > 8 || value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        const nested = nestedMessage(parsed, depth + 1, seen);
        if (nested) return nested;
      } catch {
        // Keep the original non-JSON text as a final specific-message candidate.
      }
    }
    return specificErrorMessage(trimmed);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = nestedMessage(item, depth + 1, seen);
      if (message) return message;
    }
    return undefined;
  }
  if (!isRecord(value) || seen.has(value)) return undefined;
  seen.add(value);

  for (const key of ['message', 'detail', 'error_description', 'reason']) {
    const message = specificErrorMessage(value[key]);
    if (message) return message;
  }
  for (const key of [
    'error',
    'response',
    'cause',
    'details',
    'incomplete_details',
    'rawBody',
    'rawChunk',
    'rawResponse',
    'data'
  ]) {
    const message = nestedMessage(value[key], depth + 1, seen);
    if (message) return message;
  }
  return undefined;
}

function specificErrorMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || isGenericLlmErrorLabel(trimmed)) return undefined;
  return truncateForSummary(trimmed);
}

function isGenericLlmErrorLabel(value: string): boolean {
  return new Set([
    'error',
    'stream_error',
    'upstream_error',
    'http_error',
    'response_error',
    'decode_error',
    'stream_read_error',
    'stream_parse_error',
    'llm_error'
  ]).has(value.trim().toLowerCase());
}

function truncateForSummary(value: string): string {
  const limit = 600;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function retryDelayForAttempt(retryAttempt: number, configuredDelaySeconds?: number): number {
  const configured = normalizeRetryDelaySeconds(configuredDelaySeconds);
  if (configured > 0) return configured * 1_000;
  const base = Math.min(8_000, 500 * (2 ** Math.max(0, retryAttempt - 1)));
  return Math.max(0, Math.round(base * (0.75 + Math.random() * 0.25)));
}

function normalizeRetryDelaySeconds(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const seconds = Math.floor(number);
  if (seconds <= 0) return 0;
  return Math.min(seconds, MAX_LLM_RETRY_DELAY_SECONDS);
}

function waitForRetryDelay(delayMs: number, control: RetryControl, signal?: AbortSignal): Promise<boolean> {
  if (control.cancelRequested) return Promise.resolve(false);
  if (signal?.aborted) return Promise.reject(createAbortError('Aborted LLM retry wait.'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const previousWake = control.wakeRetryWait;
    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onAbort);
      control.wakeRetryWait = previousWake;
    };
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(createAbortError('Aborted LLM retry wait.'));
    };
    control.wakeRetryWait = () => {
      previousWake?.();
      settle(false);
    };
    timeout = setTimeout(() => settle(!control.cancelRequested), delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function resolveLlmInvocationProvider(
  request: LlmResolveInvocationRequest,
  emit: Emit,
  options: LlmProviderOptions,
  resolvedRuntimeSettingsByInvocationId?: Map<string, LlmProviderConfigRecord>
): Promise<void> {
  try {
    const settings = normalizeSettings(await resolveMaybe(options.settings, request));
    const compressionConfig = await options.activeCompressionSettings?.({ conversationId: request.conversationId, providerConfigId: settings.id, model: settings.model });
    resolvedRuntimeSettingsByInvocationId?.set(request.invocationId, settings);
    emit({ type: LlmEventType.InvocationResolved, payload: { invocationId: request.invocationId, requestId: request.requestId, settings: snapshotFromSettings(settings, compressionConfig), resolvedAt: Date.now() } });
  } catch (error) {
    emit({ type: LlmEventType.InvocationResolveError, payload: { invocationId: request.invocationId, requestId: request.requestId, message: error instanceof Error ? error.message : String(error), resolvedAt: Date.now() } });
  }
}

export async function dryRunLlmProvider(request: LlmStartRequest, options: LlmProviderOptions, dryRunOptions: LlmDryRunOptions = {}, resolvedRuntimeSettingsByInvocationId?: Map<string, LlmProviderConfigRecord>): Promise<LlmDryRunResult> {
  const settings = await resolveRuntimeSettings(request, options, resolvedRuntimeSettingsByInvocationId);
  const apiKeyAvailable = !!settings.apiKey;
  const runtimeSettings = apiKeyAvailable ? settings : { ...settings, apiKey: 'limcode-dry-run-placeholder-key' };

  const unified = await importUnifiedLlmProvider();
  const registry = unified.createBootstrapExtensionRegistry();
  const proxy = normalizeOptionalString(await resolveMaybe(options.proxy));
  const proxyFetch = proxy ? createProxyFetch(proxy) : undefined;
  const providerFetch = createTerminalValidatedFetch(proxyFetch ?? fetch, runtimeSettings.provider);
  const headers = mergeHeaders(await resolveMaybe(options.headers), runtimeSettings.headers);
  const requestBody = withoutNativeServerSideCompaction(
    requestBodyWithOpenAIPromptCacheKey(runtimeSettings, request.conversationId),
    request.contents
  );
  const provider = installProviderCompatibility(unified.createLLMFromConfig({
    provider: runtimeSettings.provider,
    model: runtimeSettings.model,
    apiKey: runtimeSettings.apiKey,
    baseUrl: runtimeSettings.baseUrl,
    ...(runtimeSettings.contextWindowTokens ? { contextWindow: runtimeSettings.contextWindowTokens } : {}),
    ...(headers ? { headers } : {}),
    ...(requestBody ? { requestBody } : {}),
    ...unifiedPromptCacheConfigEntry(runtimeSettings, requestBody),
    ...openAIResponsesWebSocketConfigEntry(runtimeSettings, request.conversationId),
    ...(proxy ? { proxy } : {}),
    fetch: providerFetch
  }, registry.llmProviders) as UnifiedChatProvider, runtimeSettings.provider, runtimeSettings.model);

  const dryRun = (provider as unknown as Partial<UnifiedDryRunCapable>).dryRun;
  if (typeof dryRun !== 'function') {
    throw new Error('当前 unified-llm-provider 版本不支持 provider.dryRun，请更新依赖。');
  }

  const nativeCapabilities = openAIResponsesNativeCapabilities({
    provider: runtimeSettings.provider,
    model: runtimeSettings.model,
    baseUrl: runtimeSettings.baseUrl,
    transport: runtimeSettings.openaiResponsesTransport,
    nativeResponses: runtimeSettings.nativeResponses
  });
  const preparedRequest = await prepareLlmStartRequestMultimodal(request, options, nativeCapabilities);
  const webSocketMode = isOpenAIResponsesWebSocketMode(runtimeSettings);
  const result = await dryRun.call(provider, toUnifiedRequest(
    preparedRequest,
    effectiveRequestGenerationConfig(request, runtimeSettings),
    runtimeSettings.provider,
    nativeCapabilities
  ), {
    inputFormat: 'unified',
    outputFormat: 'unified',
    stream: runtimeSettings.stream !== false || webSocketMode,
    curl: { includeApiKey: dryRunOptions.includeApiKey === true, prettyBody: true }
  });

  if (webSocketMode) {
    const displayResult = openAIResponsesWebSocketDryRunResult(result, dryRunOptions.includeApiKey === true, runtimeSettings.model);
    return formatUnifiedDryRunResult(displayResult, runtimeSettings, unified, dryRunOptions, apiKeyAvailable, displayResult.maskedCurl);
  }
  return formatUnifiedDryRunResult(result, runtimeSettings, unified, dryRunOptions, apiKeyAvailable);
}

export async function dryRunCompactLlmProvider(
  request: LlmCompactRequest,
  options: LlmProviderOptions,
  dryRunOptions: LlmDryRunOptions = {}
): Promise<LlmCompactDryRunResult> {
  const methodConfig = normalizeCompressionConfig(
    request.methodConfigSnapshot ?? await options.compressionSettings?.(request),
    request.methodKind
  );
  if (methodConfig.kind === 'disabled') throw new Error('当前压缩方法已关闭。');
  const generatedAt = Date.now();
  if (methodConfig.kind === 'openai_responses_compact') {
    const observationContract = normalizeCompressionAttachmentObservationContract(request);
    if (observationContract.requirements.length > 0) {
      throw new TypeError('Provider-native Compact cannot carry text-summary Attachment observations.');
    }
    const call = await dryRunOpenAIResponsesCompact(request, methodConfig, options, dryRunOptions);
    return {
      kind: 'provider_requests',
      methodKind: methodConfig.kind,
      calls: [{ ...call, id: `${request.id}:compact`, label: 'Responses Compact', ordinal: 0 }],
      generatedAt
    };
  }
  if (methodConfig.kind === 'deterministic_summary' || methodConfig.kind === 'manual_summary') {
    await prepareCompressionMediaSemantics(request, methodConfig, options);
    return {
      kind: 'no_provider_call',
      methodKind: methodConfig.kind,
      calls: [],
      note: methodConfig.kind === 'manual_summary'
        ? '该方法只生成本地可编辑摘要，不会调用 Provider；媒体必须已有持久化 observation。'
        : '该方法使用确定性本地摘要，不会调用 Provider；媒体必须已有持久化 observation。',
      generatedAt
    };
  }

  const resolved = await resolveSummaryProvider(request, methodConfig, options, { allowPlaceholderApiKey: true });
  if (!resolved.provider) throw new Error('无法构造压缩 dry-run Provider。');
  const mediaSemantics = await prepareCompressionMediaSemanticsDryRun(
    request,
    methodConfig,
    options,
    resolved
  );
  const semanticRequest = mediaSemantics.request;
  if (summaryDeltaContents(semanticRequest).length === 0) {
    return {
      kind: mediaSemantics.observationCalls.length > 0 ? 'provider_requests' : 'no_provider_call',
      methodKind: methodConfig.kind,
      calls: [],
      note: '没有新的摘要源；沿用并收口现有 replacement summary。',
      generatedAt
    };
  }

  const summaryCalls: SummaryProviderCall[] = methodConfig.kind === 'segmented_summary'
    ? buildSegmentedSummaryProviderCalls(semanticRequest, methodConfig, resolved.settings)
    : [buildSummaryProviderCall(semanticRequest, methodConfig, resolved.settings)];
  if (methodConfig.kind === 'llm_summary' && !isSummaryProviderCallWithinWindow(summaryCalls[0]!, resolved.settings)) {
    throw new Error('compression_request_too_large: summary input exceeds the frozen Provider input limit.');
  }
  const dryRunCalls = [...mediaSemantics.observationCalls, ...summaryCalls];
  const unified = await importUnifiedLlmProvider();
  const providerDryRun = (resolved.provider as unknown as Partial<UnifiedDryRunCapable>).dryRun;
  if (typeof providerDryRun !== 'function') throw new Error('当前 unified-llm-provider 版本不支持 provider.dryRun。');
  const results = [] as LlmCompactDryRunResult['calls'];
  for (const [ordinal, call] of dryRunCalls.entries()) {
    const result = await providerDryRun.call(resolved.provider, call.request, {
      inputFormat: 'unified',
      outputFormat: 'unified',
      stream: resolved.stream,
      curl: { includeApiKey: dryRunOptions.includeApiKey === true, prettyBody: true }
    });
    results.push({
      ...formatUnifiedDryRunResult(result, resolved.settings, unified, dryRunOptions, resolved.apiKeyAvailable),
      id: ordinal < mediaSemantics.observationCalls.length
        ? `${request.id}:attachment-observation:${ordinal}`
        : `${request.id}:summary:${ordinal - mediaSemantics.observationCalls.length}`,
      label: call.label,
      ordinal
    });
  }
  return {
    kind: 'provider_requests',
    methodKind: methodConfig.kind,
    calls: results,
    ...(methodConfig.kind === 'segmented_summary' || mediaSemantics.observationCalls.length > 0 ? {
      note: [
        ...(mediaSemantics.observationCalls.length > 0
          ? ['前置请求逐个分析缺失的 F 附件；后续 summary dry-run 使用明确的 observation 占位值。']
          : []),
        ...(methodConfig.kind === 'segmented_summary'
          ? ['仅展示可预先确定的 leaf summary requests；后续 hierarchy merge requests 依赖前序 Provider 摘要，运行时动态构造。']
          : [])
      ].join(' ')
    } : {}),
    generatedAt
  };
}

async function dryRunOpenAIResponsesCompact(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  options: LlmProviderOptions,
  dryRunOptions: LlmDryRunOptions
): Promise<LlmDryRunResult> {
  const preparedContext = await prepareNativeCompactContentsMultimodal(request.contents, options);
  const normalizedContext = assertCanonicalProviderToolContext(preparedContext);
  const settings = await resolveCompactProviderSettings(request, methodConfig, normalizedContext, options);
  if (settings.provider !== 'openai-responses') throw new Error('OpenAI 原生压缩仅支持 openai-responses 渠道格式。');
  const apiKeyAvailable = !!settings.apiKey;
  const runtimeSettings = apiKeyAvailable ? settings : { ...settings, apiKey: 'limcode-dry-run-placeholder-key' };
  const unified = await importUnifiedLlmProvider();
  const registry = unified.createBootstrapExtensionRegistry();
  const proxy = normalizeOptionalString(await resolveMaybe(options.proxy));
  const proxyFetch = proxy ? createProxyFetch(proxy) : undefined;
  const providerFetch = createTerminalValidatedFetch(proxyFetch ?? fetch, runtimeSettings.provider);
  const headers = mergeHeaders(await resolveMaybe(options.headers), runtimeSettings.headers);
  const requestBody = requestBodyWithOpenAIPromptCacheKey(runtimeSettings, request.conversationId);
  const provider = unified.createLLMFromConfig({
    provider: runtimeSettings.provider,
    model: runtimeSettings.model,
    apiKey: runtimeSettings.apiKey,
    baseUrl: runtimeSettings.baseUrl,
    ...(runtimeSettings.contextWindowTokens ? { contextWindow: runtimeSettings.contextWindowTokens } : {}),
    ...(headers ? { headers } : {}),
    ...(requestBody ? { requestBody } : {}),
    ...unifiedPromptCacheConfigEntry(runtimeSettings, requestBody),
    ...(proxy ? { proxy } : {}),
    fetch: providerFetch
  }, registry.llmProviders) as unknown as Partial<UnifiedDryRunCapable>;
  if (typeof provider.compactDryRun !== 'function') {
    throw new Error('当前 unified-llm-provider 版本不支持 provider.compactDryRun。');
  }
  const result = await provider.compactDryRun(
    { contents: normalizedContext.flatMap((content) => toUnifiedContents(content, 'openai-responses')) },
    {
      inputFormat: 'unified',
      outputFormat: 'unified',
      ...(requestBody ? { requestBody } : {}),
      curl: { includeApiKey: dryRunOptions.includeApiKey === true, prettyBody: true }
    }
  );
  return formatUnifiedDryRunResult(result, runtimeSettings, unified, dryRunOptions, apiKeyAvailable);
}

function formatUnifiedDryRunResult(
  result: UnifiedDryRunResult,
  settings: LlmProviderConfigRecord,
  unified: UnifiedModule,
  options: LlmDryRunOptions,
  apiKeyAvailable: boolean,
  maskedCurlOverride?: string
): LlmDryRunResult {
  return {
    provider: settings.provider,
    model: settings.model,
    providerName: result.providerName,
    url: result.url,
    method: result.method,
    stream: result.stream,
    headers: result.headers,
    body: result.body,
    bodyText: result.bodyText,
    curl: result.curl,
    maskedCurl: maskedCurlOverride ?? unified.formatRequestAsCurl(result.url, result.headers, result.body, { includeApiKey: false, prettyBody: true }),
    inputFormat: result.inputFormat,
    outputFormat: result.outputFormat,
    generatedAt: result.timestamp,
    maskedSecrets: options.includeApiKey !== true || !apiKeyAvailable,
    apiKeyAvailable
  };
}

export async function listLlmProviderModels(config: LlmProviderConfigRecord, options: LlmProviderOptions): Promise<LlmProviderModelRecord[]> {
  const settings = normalizeSettings(config);

  const unified = await importUnifiedLlmProvider();
  const headers = mergeHeaders(await resolveMaybe(options.headers), settings.headers);
  const result = await unified.listAvailableModels({
    provider: settings.provider,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    ...(headers ? { headers } : {}),
    outputFormat: 'unified'
  });

  return result.models.map(modelCatalogEntryToRecord);
}

export type LlmCompressionMethodHandler = (
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  options: LlmProviderOptions,
  signal?: AbortSignal
) => Promise<LlmCompactResult>;

const compressionMethodHandlers = new Map<LlmCompressionConfigRecord['kind'], LlmCompressionMethodHandler>();

export function registerLlmCompressionMethod(kind: LlmCompressionConfigRecord['kind'], handler: LlmCompressionMethodHandler): void {
  compressionMethodHandlers.set(kind, handler);
}

function ensureDefaultCompressionMethodsRegistered(): void {
  if (compressionMethodHandlers.size > 0) return;
  registerLlmCompressionMethod('openai_responses_compact', compactWithOpenAIResponses);
  registerLlmCompressionMethod('llm_summary', compactWithSummary);
  registerLlmCompressionMethod('segmented_summary', compactWithSegmentedSummary);
  registerLlmCompressionMethod('deterministic_summary', compactWithSummary);
  registerLlmCompressionMethod('manual_summary', compactWithSummary);
}

export async function compactLlmProvider(
  request: LlmCompactRequest,
  emit: Emit,
  options: LlmProviderOptions,
  signal?: AbortSignal,
  retryControl: RetryControl = { cancelRequested: false }
): Promise<void> {
  logCompressionDebug('provider.compact.begin', { ...compactRequestDebugInfo(request), signalAborted: signal?.aborted === true });
  try {
    ensureDefaultCompressionMethodsRegistered();
    const methodConfig = normalizeCompressionConfig(
      request.methodConfigSnapshot ?? await options.compressionSettings?.(request),
      request.methodKind
    );
    logCompressionDebug('provider.compact.methodResolved', {
      ...compactRequestDebugInfo(request),
      methodConfigId: methodConfig.id,
      methodConfigKind: methodConfig.kind,
      signalAborted: signal?.aborted === true
    });
    if (methodConfig.kind === 'disabled') {
      throw new Error('当前压缩方法已关闭。');
    }

    const handler = compressionMethodHandlers.get(methodConfig.kind);
    if (!handler) throw new Error(`未注册的压缩方法：${methodConfig.kind}`);

    // Freeze resolved media once for the whole native compact operation. Capability retries must
    // replay identical bytes even when the original reference was a mutable local sourcePath.
    const handlerRequest = methodConfig.kind === 'openai_responses_compact'
      ? { ...request, contents: await prepareNativeCompactContentsMultimodal(request.contents, options) }
      : request;

    const retrySettings = await resolveCompactRetrySettings(request, methodConfig, options);
    // segmented_summary is a bounded multi-call operation. Retrying the whole handler would replay
    // already-paid leaf calls, so recovery must happen at the durable ModelRequest boundary instead.
    const retryEnabled = retrySettings?.retryOnError !== false
      && isRetryCapableCompressionMethod(methodConfig.kind)
      && methodConfig.kind !== 'segmented_summary';
    const maxRetries = normalizeRetryMaxAttempts(retrySettings?.retryMaxAttempts) ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS;
    let retryCount = 0;
    let sawRetry = false;
    const handlerOptions: LlmProviderOptions = {
      ...options,
      onCompressionProgress: () => {
        if (signal?.aborted) return;
        emit({ type: LlmEventType.CompactProgress, payload: { requestId: request.id } });
      }
    };

    while (true) {
      try {
        const result = await handler(handlerRequest, methodConfig, handlerOptions, signal);
        logCompressionDebug('provider.compact.done', {
          ...compactRequestDebugInfo(request),
          resultId: result.id,
          resultContentCount: result.contents.length,
          resultMethodKind: result.methodConfig?.kind,
          retryCount,
          signalAborted: signal?.aborted === true
        });

        if (sawRetry) emitLlmRetryRecovered(emit, request.id, '自动重试成功，压缩已恢复。', retryCount, maxRetries);
        emitCompactDone(emit, request, result, Date.now());
        return;
      } catch (error) {
        if (isRequestAbort(signal)) {
          logCompressionDebug('provider.compact.cancelledByRequestAbort', {
            ...compactRequestDebugInfo(request),
            error: errorDebugInfo(error),
            abortReason: abortReasonText(signal?.reason)
          });
          return;
        }

        const failure = failureFromCaughtError(error);
        const nextRetryCount = retryCount + 1;
        const canRetry = retryEnabled
          && isRetryableCompactFailure(error, failure)
          && !retryControl.cancelRequested
          && (maxRetries === -1 || nextRetryCount <= maxRetries);

        if (!canRetry) {
          if (retryControl.cancelRequested && retryCount > 0) {
            emitLlmRetryCancelled(emit, request.id, failure.message, retryCount, maxRetries, failure.rawError);
          }
          emitCompactError(emit, request, failure, Date.now(), {
            retryAttempt: retryCount || undefined,
            retryMaxAttempts: retryEnabled ? maxRetries : 0
          });
          return;
        }

        sawRetry = true;
        retryCount = nextRetryCount;
        const retryDelayMs = retryDelayForAttempt(retryCount, retrySettings?.retryDelaySeconds);
        logCompressionDebug('provider.compact.retryScheduled', {
          ...compactRequestDebugInfo(request),
          message: failure.message,
          retryCount,
          maxRetries,
          retryDelayMs
        });
        emitLlmRetryScheduled(emit, request.id, failure.message, failure.rawError, retryCount, maxRetries, retryDelayMs);
        const shouldRetry = await waitForRetryDelay(retryDelayMs, retryControl, signal);
        if (!shouldRetry) {
          emitLlmRetryCancelled(emit, request.id, failure.message, retryCount, maxRetries, failure.rawError);
          emitCompactError(emit, request, failure, Date.now(), {
            retryAttempt: retryCount,
            retryMaxAttempts: maxRetries
          });
          return;
        }
        emitLlmRetryStarted(emit, request.id, failure.message, failure.rawError, retryCount, maxRetries);
      }
    }
  } catch (error) {
    if (isRequestAbort(signal)) {
      logCompressionDebug('provider.compact.cancelledByRequestAbort', {
        ...compactRequestDebugInfo(request),
        error: errorDebugInfo(error),
        abortReason: abortReasonText(signal?.reason)
      });
      return;
    }
    const failure = failureFromCaughtError(error);
    emitCompactError(emit, request, failure, Date.now());
  }
}

function emitCompactDone(emit: Emit, request: LlmCompactRequest, result: LlmCompactResult, completedAt: number): void {
  logCompressionDebug('provider.compact.emitDone', { ...compactRequestDebugInfo(request), completedAt });
  emit({
    type: LlmEventType.CompactDone,
    payload: {
      requestId: request.id,
      blockId: request.blockId,
      conversationId: request.conversationId,
      result,
      completedAt
    }
  });
}

function emitCompactError(
  emit: Emit,
  request: LlmCompactRequest,
  failure: LlmAttemptFailure,
  completedAt: number,
  extra: { retryAttempt?: number; retryMaxAttempts?: number } = {}
): void {
  logCompressionDebug('provider.compact.emitError', {
    ...compactRequestDebugInfo(request),
    message: failure.message,
    rawError: failure.rawError,
    completedAt,
    retryAttempt: extra.retryAttempt,
    retryMaxAttempts: extra.retryMaxAttempts
  });
  emit({
    type: LlmEventType.CompactError,
    payload: {
      requestId: request.id,
      blockId: request.blockId,
      conversationId: request.conversationId,
      message: failure.message,
      ...(failure.rawError ? { rawError: failure.rawError } : {}),
      ...(extra.retryAttempt !== undefined ? { retryAttempt: extra.retryAttempt } : {}),
      ...(extra.retryMaxAttempts !== undefined ? { retryMaxAttempts: extra.retryMaxAttempts } : {}),
      completedAt
    }
  });
}

async function resolveCompactRetrySettings(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  options: LlmProviderOptions
): Promise<LlmProviderConfigRecord | undefined> {
  if (!isRetryCapableCompressionMethod(methodConfig.kind)) return undefined;
  const model = compressionMethodModelOverride(methodConfig);
  return resolveRuntimeSettings({
    id: request.id,
    contents: request.contents,
    tools: [],
    conversationId: request.conversationId,
    ...(model ? { model } : {})
  }, options);
}

function isRetryCapableCompressionMethod(kind: LlmCompressionConfigRecord['kind']): boolean {
  return kind === 'openai_responses_compact' || kind === 'llm_summary' || kind === 'segmented_summary';
}

function compressionMethodModelOverride(methodConfig: LlmCompressionConfigRecord): LlmModelSettings | undefined {
  if (methodConfig.kind === 'openai_responses_compact') {
    const providerConfigId = methodConfig.openaiResponsesCompact?.providerConfigId?.trim();
    const model = methodConfig.openaiResponsesCompact?.model?.trim();
    return providerConfigId || model ? { ...(providerConfigId ? { providerConfigId } : {}), model: model || '' } : undefined;
  }
  if (methodConfig.kind === 'llm_summary' || methodConfig.kind === 'segmented_summary') {
    const providerConfigId = methodConfig.llmSummary?.providerConfigId?.trim();
    const model = methodConfig.llmSummary?.model?.trim();
    return providerConfigId || model ? { ...(providerConfigId ? { providerConfigId } : {}), model: model || '' } : undefined;
  }
  return undefined;
}

function isRetryableCompactFailure(error: unknown, failure: LlmAttemptFailure): boolean {
  const text = `${failure.message}\n${errorSearchText(error)}`.toLowerCase();
  return !(
    text.includes('当前压缩方法已关闭')
    || text.includes('未注册的压缩方法')
    || text.includes('缺少 llm api key')
    || text.includes('openai 原生压缩仅支持')
    || text.includes('media_size_unknown')
    || text.includes('media_semantics_unavailable')
    || text.includes('compression_request_too_large')
    || text.includes('compression_source_too_large')
  );
}



async function resolveCompactProviderSettings(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  contents: MessageContent[],
  options: LlmProviderOptions
): Promise<LlmProviderConfigRecord> {
  const modelOverride = methodConfig.openaiResponsesCompact?.model?.trim();
  const providerConfigId = methodConfig.openaiResponsesCompact?.providerConfigId?.trim();
  return resolveRuntimeSettings({
    id: request.id,
    contents,
    tools: [],
    conversationId: request.conversationId,
    ...(request.settingsSnapshot ? { settingsSnapshot: request.settingsSnapshot } : {}),
    model: {
      ...(providerConfigId ? { providerConfigId } : {}),
      model: modelOverride || ''
    }
  }, options);
}

async function compactWithOpenAIResponses(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  options: LlmProviderOptions,
  signal?: AbortSignal
): Promise<LlmCompactResult> {
  const preparedContext = await prepareNativeCompactContentsMultimodal(request.contents, options);
  const normalizedContext = assertCanonicalProviderToolContext(preparedContext);
  const settings = await resolveCompactProviderSettings(request, methodConfig, normalizedContext, options);

  if (settings.provider !== 'openai-responses') {
    throw new Error('OpenAI 原生压缩仅支持 openai-responses 渠道格式。');
  }
  if (!settings.apiKey) {
    throw new Error('缺少 LLM API Key。请在全局设置的“渠道”页签里填写并保存。');
  }

  const unified = await importUnifiedLlmProvider();
  const registry = unified.createBootstrapExtensionRegistry();
  const proxy = normalizeOptionalString(await resolveMaybe(options.proxy));
  const proxyFetch = proxy ? createProxyFetch(proxy) : undefined;
  const providerFetch = createTerminalValidatedFetch(proxyFetch ?? fetch, settings.provider);
  const headers = mergeHeaders(await resolveMaybe(options.headers), settings.headers);
  const requestBody = requestBodyWithOpenAIPromptCacheKey(settings, request.conversationId);
  logCompressionDebug('provider.compact.openaiResponses.settings', {
    ...compactRequestDebugInfo(request),
    providerConfigId: settings.id,
    providerConfigName: settings.name,
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    methodConfigId: methodConfig.id,
    methodConfigKind: methodConfig.kind,
    hasProxy: !!proxy,
    headerKeys: headers ? Object.keys(headers) : [],
    hasRequestBody: !!requestBody
  });
  const provider = unified.createLLMFromConfig({
    provider: settings.provider,
    model: settings.model,
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    ...(settings.contextWindowTokens ? { contextWindow: settings.contextWindowTokens } : {}),
    ...(headers ? { headers } : {}),
    ...(requestBody ? { requestBody } : {}),
    ...unifiedPromptCacheConfigEntry(settings, requestBody),
    ...(proxy ? { proxy } : {}),
    fetch: providerFetch
  }, registry.llmProviders) as unknown as { compact?: (request: unknown, options?: unknown) => Promise<UnifiedLLMCompactResponse> };

  if (typeof provider.compact !== 'function') {
    throw new Error('当前 unified-llm-provider 不支持 provider.compact。');
  }

  let compacted: UnifiedLLMCompactResponse;
  try {
    logCompressionDebug('provider.compact.openaiResponses.request', {
      ...compactRequestDebugInfo(request),
      normalizedContentCount: normalizedContext.length,
      signalAborted: signal?.aborted === true
    });
    compacted = await provider.compact(
      { contents: normalizedContext.flatMap((content) => toUnifiedContents(content, 'openai-responses')) },
      {
        inputFormat: 'unified',
        outputFormat: 'unified',
        signal,
        ...(requestBody ? { requestBody } : {})
      }
    );
    if (hasUnifiedError(compacted)) {
      throw new LlmAttemptFailureError(failureFromProviderError(compacted.error, { rawResponse: compacted.rawResponse ?? compacted }));
    }
    logCompressionDebug('provider.compact.openaiResponses.response', {
      ...compactRequestDebugInfo(request),
      responseId: compacted.id,
      object: compacted.object,
      contentCount: compacted.contents?.length ?? 0,
      hasUsage: compacted.usageMetadata !== undefined
    });
  } catch (error) {
    logCompressionDebug('provider.compact.openaiResponses.throw', {
      ...compactRequestDebugInfo(request),
      error: errorDebugInfo(error),
      signalAborted: signal?.aborted === true
    });
    // 压缩方法是用户明确选择的策略。OpenAI 原生压缩失败时必须保持该策略失败，
    // 交给外层按同一方法重试，不能在单次尝试内偷偷切换为分段总结。
    throw error;
  }

  return {
    id: compacted.id,
    object: compacted.object,
    createdAt: compacted.createdAt,
    // The compact endpoint returns the canonical next context window. Keep every unified item and
    // its top-level providerContext metadata intact; rebuilding known part variants here used to
    // discard raw retained-message ids/status and made the supposedly opaque result lossy.
    contents: (compacted.contents ?? []) as unknown as MessageContent[],
    usageMetadata: usageMetadataFromCompact(compacted.usageMetadata),
    settingsSnapshot: snapshotFromSettings(settings, methodConfig),
    rawResponse: compacted.rawResponse,
    methodConfig
  };
}

function isContextLengthExceededError(error: unknown): boolean {
  const text = errorSearchText(error).toLowerCase();
  return text.includes('context_length_exceeded')
    || text.includes('context window')
    || text.includes('exceeds the context')
    || text.includes('maximum context length')
    || text.includes('too many tokens');
}

interface PreparedCompressionMediaSemantics {
  request: LlmCompactRequest;
  profileSha256?: string;
  requirements: LlmAttachmentObservationRequirement[];
  observations: LlmAttachmentObservation[];
  provider?: ResolvedSummaryProvider;
}

interface CompressionAttachmentObservationContract {
  profileSha256?: string;
  requirements: LlmAttachmentObservationRequirement[];
}

interface SemanticContentsProjection {
  contents: MessageContent[];
  representedRefs: Set<string>;
}

const ATTACHMENT_OBSERVATION_TARGET_TOKENS = 1_024;
// Attachment observation runs one Provider call per media body and must survive
// reasoning-heavy models that spend part of the output budget on thoughts.
// Kept local on purpose: SUMMARY_PROVIDER_MIN_OUTPUT_TOKENS is shared with the
// generic summary floor and the truncation retry step, so widening it there
// would change unrelated compression paths.
const ATTACHMENT_OBSERVATION_MAX_OUTPUT_TOKENS = 8_192;
const ATTACHMENT_OBSERVATION_MAX_SUMMARY_CHARS = 8_000;
const ATTACHMENT_OBSERVATION_MAX_ITEM_CHARS = 2_000;
const ATTACHMENT_OBSERVATION_MAX_SALIENT_FACTS = 32;
const ATTACHMENT_OBSERVATION_MAX_UNCERTAINTIES = 16;
// Structured-output wobble is random, so one reformulated attempt recovers most
// failures that previously aborted the entire compression turn.
const ATTACHMENT_OBSERVATION_MAX_ATTEMPTS = 2;

export class LlmMediaSemanticsUnavailableError extends Error {
  public readonly code = 'media_semantics_unavailable';
  public readonly attachmentRef?: string;
  public readonly cause?: unknown;

  public constructor(reason: string, attachmentRef?: string, cause?: unknown) {
    super(`media_semantics_unavailable: ${attachmentRef ? `${attachmentRef}: ` : ''}${reason}`);
    this.name = 'LlmMediaSemanticsUnavailableError';
    this.attachmentRef = attachmentRef;
    this.cause = cause;
  }
}

const attachmentMediaSemanticsCache = new WeakMap<
  LlmCompactRequest,
  { cacheKey: string; promise: Promise<PreparedCompressionMediaSemantics> }
>();

async function prepareCompressionMediaSemantics(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  options: LlmProviderOptions,
  signal?: AbortSignal,
  initialProvider?: ResolvedSummaryProvider
): Promise<PreparedCompressionMediaSemantics> {
  const cacheKey = [
    methodConfig.id,
    methodConfig.kind,
    request.attachmentObservationProfileSha256 ?? 'no-observation-profile'
  ].join('\0');
  const cached = attachmentMediaSemanticsCache.get(request);
  if (cached?.cacheKey === cacheKey) return cached.promise;
  const promise = prepareCompressionMediaSemanticsUncached(
    request,
    methodConfig,
    options,
    signal,
    initialProvider
  );
  const entry = { cacheKey, promise };
  attachmentMediaSemanticsCache.set(request, entry);
  try {
    return await promise;
  } catch (error) {
    if (attachmentMediaSemanticsCache.get(request) === entry) {
      attachmentMediaSemanticsCache.delete(request);
    }
    throw error;
  }
}

async function prepareCompressionMediaSemanticsUncached(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  options: LlmProviderOptions,
  signal?: AbortSignal,
  initialProvider?: ResolvedSummaryProvider
): Promise<PreparedCompressionMediaSemantics> {
  const contract = normalizeCompressionAttachmentObservationContract(request);
  if (contract.requirements.length === 0) {
    if (compressionRequestContainsInlineMedia(request)) {
      throw new LlmMediaSemanticsUnavailableError(
        'text compression contains media without a frozen F-reference observation contract.'
      );
    }
    return {
      request,
      requirements: [],
      observations: [],
      ...(initialProvider ? { provider: initialProvider } : {})
    };
  }

  const requirementsById = new Map(contract.requirements.map((requirement) => [
    requirement.attachmentId,
    requirement
  ]));
  const bodies = collectCompressionMediaBodies(request, requirementsById);
  const observationsByRef = new Map<string, LlmAttachmentObservation>();
  const missing = contract.requirements.filter((requirement) => {
    if (!requirement.cachedObservation || isUnavailableAttachmentObservation(requirement.cachedObservation)) return true;
    observationsByRef.set(requirement.attachmentRef, cloneAttachmentObservation(requirement.cachedObservation));
    return false;
  });

  let provider = initialProvider;
  if (missing.length > 0) {
    const localOnly = methodConfig.kind === 'deterministic_summary' || methodConfig.kind === 'manual_summary';
    if (!localOnly) provider ??= await resolveSummaryProvider(request, methodConfig, options);
    if (localOnly || !provider?.provider) {
      missing.forEach((requirement) => observationsByRef.set(
        requirement.attachmentRef,
        unavailableAttachmentObservation(requirement)
      ));
    } else {
      const preparation = createMultimodalPreparationContext();
      const analyzed = await mapWithBoundedConcurrency(
        missing,
        isOpenAIResponsesWebSocketMode(provider.settings) ? 1 : SEGMENTED_SUMMARY_CONCURRENCY,
        async (requirement, _index, siblingSignal) => {
          const body = bodies.get(requirement.attachmentId);
          if (!body) return unavailableAttachmentObservation(requirement);
          try {
            return await analyzeCompressionAttachment(
              requirement,
              body,
              provider!,
              options,
              preparation,
              siblingSignal
            );
          } catch (error) {
            if (isRequestAbort(siblingSignal)) throw error;
            return unavailableAttachmentObservation(requirement);
          }
        },
        signal
      );
      analyzed.forEach((observation) => observationsByRef.set(observation.attachmentRef, observation));
    }
  }

  const observations = contract.requirements.map((requirement) => {
    const observation = observationsByRef.get(requirement.attachmentRef);
    if (!observation) {
      throw new LlmMediaSemanticsUnavailableError(
        'no complete structured observation was produced.',
        requirement.attachmentRef
      );
    }
    return cloneAttachmentObservation(observation);
  });
  return {
    request: projectCompressionRequestWithObservations(request, contract.requirements, observations),
    profileSha256: contract.profileSha256,
    requirements: contract.requirements,
    observations,
    ...(provider ? { provider } : {})
  };
}

interface PreparedCompressionMediaSemanticsDryRun extends PreparedCompressionMediaSemantics {
  observationCalls: SummaryProviderCall[];
}

async function prepareCompressionMediaSemanticsDryRun(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  options: LlmProviderOptions,
  provider: ResolvedSummaryProvider
): Promise<PreparedCompressionMediaSemanticsDryRun> {
  const contract = normalizeCompressionAttachmentObservationContract(request);
  if (contract.requirements.length === 0) {
    if (compressionRequestContainsInlineMedia(request)) {
      throw new LlmMediaSemanticsUnavailableError(
        'text compression contains media without a frozen F-reference observation contract.'
      );
    }
    return {
      request,
      requirements: [],
      observations: [],
      provider,
      observationCalls: []
    };
  }
  const requirementsById = new Map(contract.requirements.map((requirement) => [
    requirement.attachmentId,
    requirement
  ]));
  const bodies = collectCompressionMediaBodies(request, requirementsById);
  const preparation = createMultimodalPreparationContext();
  const observations: LlmAttachmentObservation[] = [];
  const observationCalls: SummaryProviderCall[] = [];
  for (const requirement of contract.requirements) {
    if (requirement.cachedObservation && !isUnavailableAttachmentObservation(requirement.cachedObservation)) {
      observations.push(cloneAttachmentObservation(requirement.cachedObservation));
      continue;
    }
    if (!provider.provider) {
      throw new LlmMediaSemanticsUnavailableError(
        'the dry-run summary Provider is unavailable, so uncached media cannot be inspected.',
        requirement.attachmentRef
      );
    }
    const body = bodies.get(requirement.attachmentId);
    if (!body) {
      throw new LlmMediaSemanticsUnavailableError(
        'the frozen compression source does not contain a resolvable media body.',
        requirement.attachmentRef
      );
    }
    const media = await prepareAttachmentObservationMedia(
      requirement,
      body,
      options,
      preparation
    );
    observationCalls.push(buildAttachmentObservationProviderCall(
      requirement,
      media
    ));
    observations.push({
      attachmentRef: requirement.attachmentRef,
      summary: `[dry-run placeholder: runtime observation output for ${requirement.attachmentRef}]`,
      salientFacts: [],
      uncertainties: ['Dry-run cannot know the Provider observation response.']
    });
  }
  return {
    request: projectCompressionRequestWithObservations(request, contract.requirements, observations),
    profileSha256: contract.profileSha256,
    requirements: contract.requirements,
    observations,
    provider,
    observationCalls
  };
}

function normalizeCompressionAttachmentObservationContract(
  request: LlmCompactRequest
): CompressionAttachmentObservationContract {
  const profile = request.attachmentObservationProfileSha256;
  const rawRequirements = request.attachmentObservationRequirements;
  if (profile === undefined && rawRequirements === undefined) return { requirements: [] };
  if (typeof profile !== 'string' || !/^[0-9a-f]{64}$/i.test(profile)) {
    throw new TypeError('Compression Attachment observation profile must be a SHA-256 hex digest.');
  }
  if (!Array.isArray(rawRequirements) || rawRequirements.length === 0) {
    throw new TypeError('Compression Attachment observation requirements must be a non-empty array.');
  }
  const refs = new Set<string>();
  const attachmentIds = new Set<string>();
  const requirements = rawRequirements.map((value, index) => {
    const requirement = normalizeAttachmentObservationRequirement(
      value,
      `attachmentObservationRequirements[${index}]`
    );
    if (refs.has(requirement.attachmentRef) || attachmentIds.has(requirement.attachmentId)) {
      throw new Error('Compression Attachment observation requirements contain duplicate identities.');
    }
    refs.add(requirement.attachmentRef);
    attachmentIds.add(requirement.attachmentId);
    return requirement;
  });
  return { profileSha256: profile.toLowerCase(), requirements };
}

function compressionRequestContainsInlineMedia(request: LlmCompactRequest): boolean {
  const collections = [
    ...(request.priorSummaryContents ? [request.priorSummaryContents] : []),
    request.contents,
    ...(request.segments ?? [])
  ];
  return collections.some((contents) => contents.some((content) => content.parts.some((part) =>
    isInlineDataPart(part)
      || (isFunctionResponsePart(part) && (part.functionResponse.parts?.length ?? 0) > 0)
  )));
}

function collectCompressionMediaBodies(
  request: LlmCompactRequest,
  requirementsById: ReadonlyMap<string, LlmAttachmentObservationRequirement>
): Map<string, InlineDataPart> {
  const bodies = new Map<string, InlineDataPart>();
  const collections = [
    ...(request.priorSummaryContents ? [request.priorSummaryContents] : []),
    request.contents,
    ...(request.segments ?? [])
  ];
  for (const contents of collections) {
    for (const content of contents) {
      for (const part of content.parts) {
        if (isInlineDataPart(part)) collectCompressionMediaBody(part, requirementsById, bodies);
        if (isFunctionResponsePart(part)) {
          for (const media of part.functionResponse.parts ?? []) {
            collectCompressionMediaBody(media, requirementsById, bodies);
          }
        }
      }
    }
  }
  return bodies;
}

function collectCompressionMediaBody(
  part: InlineDataPart,
  requirementsById: ReadonlyMap<string, LlmAttachmentObservationRequirement>,
  bodies: Map<string, InlineDataPart>
): void {
  const attachmentId = part.inlineData.attachmentId?.trim();
  const requirement = attachmentId ? requirementsById.get(attachmentId) : undefined;
  if (!attachmentId || !requirement) {
    throw new LlmMediaSemanticsUnavailableError(
      'a summary media body has no matching frozen F-reference observation requirement.'
    );
  }
  if (part.inlineData.mimeType !== requirement.mimeType
    || (part.inlineData.name !== undefined && part.inlineData.name !== requirement.name)
    || (part.inlineData.sizeBytes !== undefined && part.inlineData.sizeBytes !== requirement.sizeBytes)) {
    throw new LlmMediaSemanticsUnavailableError(
      'media metadata conflicts with the frozen Attachment catalog.',
      requirement.attachmentRef
    );
  }
  if (!bodies.has(attachmentId)) bodies.set(attachmentId, cloneInlineDataPart(part));
}

async function analyzeCompressionAttachment(
  requirement: LlmAttachmentObservationRequirement,
  body: InlineDataPart,
  provider: ResolvedSummaryProvider,
  options: LlmProviderOptions,
  preparation: MultimodalPreparationContext,
  signal?: AbortSignal
): Promise<LlmAttachmentObservation> {
  const providerMedia = await prepareAttachmentObservationMedia(
    requirement,
    body,
    options,
    preparation,
    signal
  );
  let lastError: unknown;
  for (let attempt = 0; attempt < ATTACHMENT_OBSERVATION_MAX_ATTEMPTS; attempt += 1) {
    const correction = lastError === undefined
      ? undefined
      : (lastError instanceof Error ? lastError.message : String(lastError)).slice(0, 300);
    const call = buildAttachmentObservationProviderCall(
      requirement,
      providerMedia,
      correction
    );
    // Compatibility retry stays enabled so a truncated reply can grow its output
    // budget instead of failing the turn outright.
    const response = await executeSummaryProviderCall(
      provider,
      call.request,
      signal
    );
    try {
      return parseAttachmentObservationResponse(response, requirement.attachmentRef);
    } catch (error) {
      lastError = error;
      logCompressionDebug('provider.compact.observation.parseRetry', {
        attachmentRef: requirement.attachmentRef,
        attempt: attempt + 1,
        maxAttempts: ATTACHMENT_OBSERVATION_MAX_ATTEMPTS,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
  throw new LlmMediaSemanticsUnavailableError(
    'the analysis Provider did not return the required structured observation.',
    requirement.attachmentRef,
    lastError
  );
}

async function prepareAttachmentObservationMedia(
  requirement: LlmAttachmentObservationRequirement,
  body: InlineDataPart,
  options: LlmProviderOptions,
  preparation: MultimodalPreparationContext,
  signal?: AbortSignal
): Promise<InlineDataPart> {
  if (!isModelToolResponseMultimodalMimeType(requirement.mimeType)) {
    throw new LlmMediaSemanticsUnavailableError(
      `MIME type ${requirement.mimeType} is outside the stable multimodal analysis policy.`,
      requirement.attachmentRef
    );
  }
  let prepared: ContentPart;
  try {
    prepared = await prepareInlineDataForLlm(body, options, false, 'native_compact', preparation);
  } catch (error) {
    if (isRequestAbort(signal)) throw error;
    throw new LlmMediaSemanticsUnavailableError(
      'exact media bytes could not be resolved.',
      requirement.attachmentRef,
      error
    );
  }
  if (!isInlineDataPart(prepared) || !prepared.inlineData.data) {
    throw new LlmMediaSemanticsUnavailableError(
      'the Attachment resolver did not return an inline media body.',
      requirement.attachmentRef
    );
  }
  const resolvedBytes = requireCanonicalInlineDataSize(prepared, 'Attachment observation media');
  if (resolvedBytes !== requirement.sizeBytes || prepared.inlineData.mimeType !== requirement.mimeType) {
    throw new LlmMediaSemanticsUnavailableError(
      'resolved media bytes conflict with frozen Attachment metadata.',
      requirement.attachmentRef
    );
  }
  return {
    inlineData: {
      mimeType: requirement.mimeType,
      data: prepared.inlineData.data,
      name: requirement.name
    }
  };
}

function buildAttachmentObservationProviderCall(
  requirement: LlmAttachmentObservationRequirement,
  media: InlineDataPart,
  correction?: string
): SummaryProviderCall {
  const systemPrompt = [
    `Attachment observation contract revision: ${ATTACHMENT_OBSERVATION_PROMPT_REVISION}.`,
    'Inspect exactly the attached media body. Return only one JSON object, without Markdown fences or prose.',
    'Use exactly these keys: attachmentRef, summary, salientFacts, uncertainties.',
    'attachmentRef must equal the supplied F reference. summary must be concise but semantically complete.',
    'salientFacts and uncertainties must be JSON string arrays. Do not infer facts that are not visible.',
    `Hard limits: summary at most ${ATTACHMENT_OBSERVATION_MAX_SUMMARY_CHARS} characters;`
      + ` salientFacts at most ${ATTACHMENT_OBSERVATION_MAX_SALIENT_FACTS} items;`
      + ` uncertainties at most ${ATTACHMENT_OBSERVATION_MAX_UNCERTAINTIES} items;`
      + ` every array item at most ${ATTACHMENT_OBSERVATION_MAX_ITEM_CHARS} characters.`,
    'Emit the JSON object as the very first and only visible output. Never place it inside reasoning.',
    ...(correction ? [`Your previous reply was rejected: ${correction} Return only the corrected JSON object.`] : [])
  ].join('\n');
  const sourceContent: MessageContent = {
    role: 'user',
    parts: [{
      text: [
        `attachmentRef: ${requirement.attachmentRef}`,
        `name: ${requirement.name}`,
        `mimeType: ${requirement.mimeType}`,
        `sizeBytes: ${requirement.sizeBytes}`,
        'Analyze this body now and return the strict JSON observation.'
      ].join('\n')
    }, media]
  };
  return {
    label: `Attachment ${requirement.attachmentRef} observation`,
    sourceContents: [sourceContent],
    targetTokens: ATTACHMENT_OBSERVATION_TARGET_TOKENS,
    request: {
      contents: [sourceContent],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: {
        temperature: 0,
        maxOutputTokens: ATTACHMENT_OBSERVATION_MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingLevel: 'low' }
      }
    }
  };
}

// Scans for the first balanced top-level JSON object, ignoring braces inside
// strings. Lets a Provider that wraps its JSON in prose still succeed.
function extractFirstJsonObject(text: string): string | undefined {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

// Clamps instead of rejecting: an over-long list is a formatting wobble, not a
// reason to abort the whole compression turn.
function coerceObservationTextList(value: unknown, maxItems: number): string[] {
  if (!Array.isArray(value)) return [];
  const items: string[] = [];
  for (const entry of value) {
    if (items.length >= maxItems) break;
    const text = typeof entry === 'string'
      ? entry
      : typeof entry === 'number' || typeof entry === 'boolean'
        ? String(entry)
        : undefined;
    if (text === undefined) continue;
    const trimmed = text.trim();
    if (trimmed.length === 0) continue;
    items.push(trimmed.slice(0, ATTACHMENT_OBSERVATION_MAX_ITEM_CHARS));
  }
  return items;
}

function parseAttachmentObservationResponse(
  value: string,
  expectedRef: string
): LlmAttachmentObservation {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('Attachment observation response was empty.');
  }
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced ? fenced[1]!.trim() : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch (error) {
    const extracted = extractFirstJsonObject(candidate) ?? extractFirstJsonObject(trimmed);
    if (!extracted) throw error;
    parsed = JSON.parse(extracted) as unknown;
  }
  if (!isRecord(parsed)) throw new TypeError('Attachment observation response must be an object.');
  const summaryText = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
  if (summaryText.length === 0) {
    throw new TypeError('Attachment observation response is missing a summary.');
  }
  if (parsed.attachmentRef !== undefined && parsed.attachmentRef !== expectedRef) {
    logCompressionDebug('provider.compact.observation.refMismatch', {
      expectedRef,
      reportedRef: parsed.attachmentRef
    });
  }
  // Unknown keys are dropped and the F reference is taken from the frozen
  // requirement: each call carries exactly one media body, so the caller is the
  // authoritative source for the reference.
  return normalizeLlmAttachmentObservation({
    attachmentRef: expectedRef,
    summary: summaryText.slice(0, ATTACHMENT_OBSERVATION_MAX_SUMMARY_CHARS),
    salientFacts: coerceObservationTextList(
      parsed.salientFacts,
      ATTACHMENT_OBSERVATION_MAX_SALIENT_FACTS
    ),
    uncertainties: coerceObservationTextList(
      parsed.uncertainties,
      ATTACHMENT_OBSERVATION_MAX_UNCERTAINTIES
    )
  }, 'Attachment observation response');
}

function projectCompressionRequestWithObservations(
  request: LlmCompactRequest,
  requirements: readonly LlmAttachmentObservationRequirement[],
  observations: readonly LlmAttachmentObservation[]
): LlmCompactRequest {
  const requirementById = new Map(requirements.map((requirement) => [requirement.attachmentId, requirement]));
  const observationByRef = new Map(observations.map((observation) => [observation.attachmentRef, observation]));
  const prior = projectSemanticContents(request.priorSummaryContents ?? [], requirementById, observationByRef);
  const current = projectSemanticContents(request.contents, requirementById, observationByRef);
  const currentMissing = missingRepresentedObservations(requirements, prior.representedRefs, current.representedRefs);
  const contents = currentMissing.length > 0
    ? [attachmentObservationStateContent(currentMissing, observationByRef), ...current.contents]
    : current.contents;

  let segments: MessageContent[][] | undefined;
  if (request.segments !== undefined) {
    const represented = new Set(prior.representedRefs);
    segments = request.segments.map((segment) => {
      const projected = projectSemanticContents(segment, requirementById, observationByRef);
      projected.representedRefs.forEach((ref) => represented.add(ref));
      return projected.contents;
    });
    const missing = requirements.filter((requirement) => !represented.has(requirement.attachmentRef));
    if (missing.length > 0) {
      const state = attachmentObservationStateContent(missing, observationByRef);
      if (segments.length === 0) segments.push([state]);
      else segments[0] = [state, ...segments[0]];
    }
  }
  return {
    ...request,
    contents,
    ...(request.priorSummaryContents !== undefined ? { priorSummaryContents: prior.contents } : {}),
    ...(segments !== undefined ? { segments } : {})
  };
}

function projectSemanticContents(
  contents: readonly MessageContent[],
  requirementById: ReadonlyMap<string, LlmAttachmentObservationRequirement>,
  observationByRef: ReadonlyMap<string, LlmAttachmentObservation>
): SemanticContentsProjection {
  const representedRefs = new Set<string>();
  const projected = contents.map((content): MessageContent => ({
    role: content.role,
    parts: content.parts.flatMap((part): ContentPart[] => {
      if (isInlineDataPart(part)) {
        const requirement = requireObservationForMedia(part, requirementById);
        const observation = requireObservationByRef(requirement.attachmentRef, observationByRef);
        representedRefs.add(requirement.attachmentRef);
        return [{ text: attachmentObservationDescriptor(requirement, observation) }];
      }
      if (isFunctionResponsePart(part) && part.functionResponse.parts?.length) {
        const retained: InlineDataPart[] = [];
        const descriptors: ContentPart[] = [];
        for (const media of part.functionResponse.parts) {
          const requirement = requireObservationForMedia(media, requirementById);
          const observation = requireObservationByRef(requirement.attachmentRef, observationByRef);
          representedRefs.add(requirement.attachmentRef);
          descriptors.push({ text: attachmentObservationDescriptor(requirement, observation) });
        }
        const cloned = cloneJsonValue(part);
        if (retained.length > 0) cloned.functionResponse.parts = retained;
        else delete cloned.functionResponse.parts;
        return [cloned, ...descriptors];
      }
      return [cloneJsonValue(part)];
    })
  }));
  return { contents: projected, representedRefs };
}

function requireObservationForMedia(
  media: InlineDataPart,
  requirementById: ReadonlyMap<string, LlmAttachmentObservationRequirement>
): LlmAttachmentObservationRequirement {
  const attachmentId = media.inlineData.attachmentId?.trim();
  const requirement = attachmentId ? requirementById.get(attachmentId) : undefined;
  if (!requirement) {
    throw new LlmMediaSemanticsUnavailableError(
      'a summary media body has no matching frozen F-reference observation requirement.'
    );
  }
  return requirement;
}

function requireObservationByRef(
  attachmentRef: string,
  observations: ReadonlyMap<string, LlmAttachmentObservation>
): LlmAttachmentObservation {
  const observation = observations.get(attachmentRef);
  if (!observation) {
    throw new LlmMediaSemanticsUnavailableError('a required observation is missing.', attachmentRef);
  }
  return observation;
}

function missingRepresentedObservations(
  requirements: readonly LlmAttachmentObservationRequirement[],
  ...representedSets: ReadonlySet<string>[]
): LlmAttachmentObservationRequirement[] {
  return requirements.filter((requirement) =>
    representedSets.every((represented) => !represented.has(requirement.attachmentRef))
  );
}

function attachmentObservationStateContent(
  requirements: readonly LlmAttachmentObservationRequirement[],
  observations: ReadonlyMap<string, LlmAttachmentObservation>
): MessageContent {
  return renderAttachmentObservationStateContent(
    requirements,
    requirements.map((requirement) =>
      requireObservationByRef(requirement.attachmentRef, observations))
  );
}

function attachmentObservationDescriptor(
  requirement: LlmAttachmentObservationRequirement,
  observation: LlmAttachmentObservation
): string {
  return JSON.stringify({
    kind: 'attachment_observation',
    promptRevision: ATTACHMENT_OBSERVATION_PROMPT_REVISION,
    ...attachmentObservationModelRecord(requirement, observation)
  });
}

function attachmentObservationModelRecord(
  requirement: LlmAttachmentObservationRequirement,
  observation: LlmAttachmentObservation
): Record<string, unknown> {
  return {
    attachmentRef: requirement.attachmentRef,
    name: requirement.name,
    mimeType: requirement.mimeType,
    sizeBytes: requirement.sizeBytes,
    summary: observation.summary,
    salientFacts: [...observation.salientFacts],
    uncertainties: [...observation.uncertainties]
  };
}

function compressionSummaryContents(
  summary: string,
  targetTokens: number,
  requirements: readonly LlmAttachmentObservationRequirement[],
  observations: readonly LlmAttachmentObservation[]
): MessageContent[] {
  const contents = summaryContents(summary, targetTokens);
  if (requirements.length === 0) return contents;
  const byRef = new Map(observations.map((observation) => [observation.attachmentRef, observation]));
  return [...contents, attachmentObservationStateContent(requirements, byRef)];
}

function attachmentObservationResultFields(
  prepared: PreparedCompressionMediaSemantics
): Pick<LlmCompactResult, 'attachmentObservationProfileSha256' | 'attachmentObservations'> {
  if (!prepared.profileSha256) return {};
  return {
    attachmentObservationProfileSha256: prepared.profileSha256,
    attachmentObservations: prepared.observations.map(cloneAttachmentObservation)
  };
}

function cloneAttachmentObservation(observation: LlmAttachmentObservation): LlmAttachmentObservation {
  return {
    attachmentRef: observation.attachmentRef,
    summary: observation.summary,
    salientFacts: [...observation.salientFacts],
    uncertainties: [...observation.uncertainties]
  };
}

function unavailableAttachmentObservation(
  requirement: LlmAttachmentObservationRequirement
): LlmAttachmentObservation {
  return {
    attachmentRef: requirement.attachmentRef,
    summary: `Attachment ${requirement.attachmentRef} (${requirement.name}) was preserved without content analysis.`,
    salientFacts: [
      `Original attachment preserved as ${requirement.attachmentRef}.`,
      `Metadata: mimeType=${requirement.mimeType}; sizeBytes=${requirement.sizeBytes}.`
    ],
    uncertainties: [ATTACHMENT_OBSERVATION_UNAVAILABLE_UNCERTAINTY]
  };
}

async function compactWithSummary(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  options: LlmProviderOptions,
  signal?: AbortSignal
): Promise<LlmCompactResult> {
  const mediaSemantics = await prepareCompressionMediaSemantics(request, methodConfig, options, signal);
  const summary = await generateSummaryText(
    mediaSemantics.request,
    methodConfig,
    options,
    signal,
    mediaSemantics.provider
  );
  const contents = compressionSummaryContents(
    summary.text,
    effectiveSummaryTargetTokens(methodConfig),
    mediaSemantics.requirements,
    mediaSemantics.observations
  );
  return {
    id: `summary-${request.blockId}`,
    object: 'limcode.context_summary',
    createdAt: Date.now(),
    contents,
    ...(summary.settings ? { settingsSnapshot: snapshotFromSettings(summary.settings, methodConfig) } : {}),
    methodConfig,
    ...attachmentObservationResultFields(mediaSemantics)
  };
}

/** Generates bounded deltas, then replaces prior+delta state with one structured rolling summary. */
async function compactWithSegmentedSummary(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  options: LlmProviderOptions,
  signal?: AbortSignal
): Promise<LlmCompactResult> {
  const initialProvider = await resolveSummaryProvider(request, methodConfig, options);
  const mediaSemantics = await prepareCompressionMediaSemantics(
    request,
    methodConfig,
    options,
    signal,
    initialProvider
  );
  const provider = mediaSemantics.provider ?? initialProvider;
  const semanticRequest = mediaSemantics.request;
  const targetTokens = effectiveSummaryTargetTokens(methodConfig);
  const priorSummaryText = semanticRequest.priorSummaryContents?.length
    ? plainTextOfContents(semanticRequest.priorSummaryContents)
    : '';
  const sourceContents = summaryDeltaContents(semanticRequest);
  const deterministic = deterministicReplacementSummary(priorSummaryText, sourceContents, targetTokens);
  let finalSummary = deterministic;

  if (sourceContents.length > 0 && provider.provider) {
    const calls = buildSegmentedSummaryProviderCalls(semanticRequest, methodConfig, provider.settings);
    const deltaSummaries = await mapWithBoundedConcurrency(
      calls,
      isOpenAIResponsesWebSocketMode(provider.settings) ? 1 : SEGMENTED_SUMMARY_CONCURRENCY,
      (call, _index, siblingSignal) => summarizeSingleRound(provider, call, siblingSignal),
      signal
    );
    const merged = await mergeSegmentedSummaryHierarchy(
      provider,
      calls.map((call, index) => ({
        summary: deltaSummaries[index] ?? '',
        sourceContents: call.sourceContents
      })),
      priorSummaryText,
      methodConfig,
      targetTokens,
      signal
    );
    if (merged) finalSummary = finalizeStructuredSummary(merged, deterministic, targetTokens);
  }

  const contents = compressionSummaryContents(
    finalSummary,
    targetTokens,
    mediaSemantics.requirements,
    mediaSemantics.observations
  );
  return {
    id: `summary-${request.blockId}`,
    object: 'limcode.context_summary',
    createdAt: Date.now(),
    contents,
    ...(provider.settings ? { settingsSnapshot: snapshotFromSettings(provider.settings, methodConfig) } : {}),
    methodConfig,
    ...attachmentObservationResultFields(mediaSemantics)
  };
}

/** Extracts a prior summary as merge input; it is never mechanically prefixed to the replacement. */
function plainTextOfContents(contents: MessageContent[]): string {
  const text = contents
    .flatMap((content) => content.parts.filter(isVisibleTextPart).map((part) => part.text))
    .join('\n')
    .trim();
  return text.replace(/^\[Context Summary\]\s*/, '').trim();
}

function summaryDeltaContents(request: LlmCompactRequest): MessageContent[] {
  if (request.segments && request.segments.length > 0) return request.segments.flatMap((segment) => segment);
  return request.contents;
}

/** 取一个回合中最后一条“正式回答”(model + 可见文本) 的可见文本，用作下一回合前情。 */
function finalAnswerTextOf(segment: MessageContent[]): string {
  for (let index = segment.length - 1; index >= 0; index -= 1) {
    const content = segment[index];
    if (content.role !== 'model') continue;
    const text = content.parts.filter(isVisibleTextPart).map((part) => part.text).join('\n').trim();
    if (text) return text;
  }
  return '';
}

const SUMMARY_TAG_PATTERN = /<summary>([\s\S]*?)<\/summary>/i;
function extractSummaryTag(text: string): string {
  const match = SUMMARY_TAG_PATTERN.exec(text);
  return (match ? match[1] : text).trim();
}

interface ResolvedSummaryProvider {
  provider: ReturnType<UnifiedModule['createLLMFromConfig']> | undefined;
  settings: LlmProviderConfigRecord;
  stream: boolean;
  apiKeyAvailable: boolean;
  unified?: UnifiedModule;
  proxy?: string;
  webSocketSessionKey?: string;
  omitUnsupportedMaxOutputTokens: boolean;
  onCompressionProgress?: () => void;
}

/** 组装总结用 provider（复用运行时渠道解析 + 代理/头合并）；无 API Key 时 provider 为 undefined 表示回退确定性摘要。 */
async function resolveSummaryProvider(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  options: LlmProviderOptions,
  behavior: { allowPlaceholderApiKey?: boolean } = {}
): Promise<ResolvedSummaryProvider> {
  const summarySettings = methodConfig.llmSummary;
  const providerConfigId = summarySettings?.providerConfigId?.trim();
  const model = summarySettings?.model?.trim();
  const settings = await resolveRuntimeSettings({
    id: request.id,
    contents: request.contents,
    tools: [],
    conversationId: request.conversationId,
    ...(request.settingsSnapshot ? { settingsSnapshot: request.settingsSnapshot } : {}),
    ...(providerConfigId || model ? { model: { ...(providerConfigId ? { providerConfigId } : {}), model: model || '' } } : {})
  }, options);

  const apiKeyAvailable = !!settings.apiKey;
  if (!apiKeyAvailable && behavior.allowPlaceholderApiKey !== true) {
    return {
      provider: undefined,
      settings,
      stream: false,
      apiKeyAvailable: false,
      omitUnsupportedMaxOutputTokens: false
    };
  }
  const runtimeSettings = apiKeyAvailable ? settings : { ...settings, apiKey: 'limcode-dry-run-placeholder-key' };
  const unified = await importUnifiedLlmProvider();
  const registry = unified.createBootstrapExtensionRegistry();
  const proxy = normalizeOptionalString(await resolveMaybe(options.proxy));
  const proxyFetch = proxy ? createProxyFetch(proxy) : undefined;
  const providerFetch = createTerminalValidatedFetch(proxyFetch ?? fetch, runtimeSettings.provider);
  const headers = mergeHeaders(await resolveMaybe(options.headers), settings.headers);
  const requestBody = requestBodyWithOpenAIPromptCacheKey(runtimeSettings, request.conversationId);
  const provider = installProviderCompatibility(unified.createLLMFromConfig({
    provider: runtimeSettings.provider,
    model: runtimeSettings.model,
    apiKey: runtimeSettings.apiKey,
    baseUrl: runtimeSettings.baseUrl,
    ...(runtimeSettings.contextWindowTokens ? { contextWindow: runtimeSettings.contextWindowTokens } : {}),
    ...(headers ? { headers } : {}),
    ...(requestBody ? { requestBody } : {}),
    ...unifiedPromptCacheConfigEntry(runtimeSettings, requestBody),
    ...openAIResponsesWebSocketConfigEntry(runtimeSettings, request.conversationId),
    ...(proxy ? { proxy } : {}),
    fetch: providerFetch
  }, registry.llmProviders), runtimeSettings.provider, runtimeSettings.model);
  return {
    provider,
    settings,
    stream: settings.stream !== false,
    apiKeyAvailable,
    unified,
    onCompressionProgress: options.onCompressionProgress,
    ...(proxy ? { proxy } : {}),
    ...(isOpenAIResponsesWebSocketMode(settings)
      ? {
          webSocketSessionKey: createOpenAIResponsesWebSocketSessionKey(
            settings,
            `${requireOpenAIResponsesWebSocketConversationId(request.conversationId)}\ncompression-summary\n${request.id}`
          )
        }
      : {}),
    omitUnsupportedMaxOutputTokens: false
  };
}

interface SummaryProviderCall {
  label: string;
  sourceContents: MessageContent[];
  targetTokens: number;
  request: {
    contents: MessageContent[];
    systemInstruction: { parts: Array<{ text: string }> };
    generationConfig?: LlmGenerationConfigRecord;
  };
}

const ROLLING_SUMMARY_STRUCTURE_INSTRUCTION = [
  '输出必须是一份替代全部旧摘要与新增记录的最新摘要，不要逐字拼接旧摘要。',
  '删除已被新事实替代的旧决定；同一事实只保留一次。',
  '必须严格使用以下标题，缺少内容时写“无”：',
  '目标',
  '重要约束、决定和准确标识',
  '工作状态',
  '  - 已完成',
  '  - 正在做',
  '  - 受阻',
  '下一步',
  '相关文件',
  '必须保留准确的路径、符号名、命令、报错、URL、版本号和业务 ID。'
].join('\n');

function buildSummaryProviderCall(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  settings: LlmProviderConfigRecord
): SummaryProviderCall {
  const summarySettings = methodConfig.llmSummary;
  const targetTokens = effectiveSummaryTargetTokens(methodConfig);
  const systemPrompt = withSummaryTargetInstruction(
    `${summarySettings?.systemPrompt?.trim() || DEFAULT_LLM_COMPRESSION_SUMMARY_SYSTEM_PROMPT}\n\n${ROLLING_SUMMARY_STRUCTURE_INSTRUCTION}`,
    targetTokens
  );
  const userPrompt = summarySettings?.userPrompt?.trim() || DEFAULT_LLM_COMPRESSION_SUMMARY_USER_PROMPT;
  const transcript = renderContentsForSummary(request.contents);
  const priorSummary = request.priorSummaryContents?.length
    ? plainTextOfContents(request.priorSummaryContents)
    : '';
  return {
    label: 'Context Summary',
    sourceContents: request.contents,
    targetTokens,
    request: {
      contents: [{ role: 'user', parts: [{ text: [
        userPrompt,
        '',
        '【旧摘要（只作为待更新的前情，不要原样附加）】',
        priorSummary || '无',
        '',
        '【新增历史】',
        transcript || '无'
      ].join('\n') }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: summaryGenerationConfig(methodConfig, settings, targetTokens)
    }
  };
}

interface SegmentedSummaryChunk {
  requestContents: MessageContent[];
  sourceContents: MessageContent[];
}

interface SegmentedSummaryUnit extends SegmentedSummaryChunk {
  kind: 'message' | 'tool_exchange' | 'tool_results';
  estimatedTokens: number;
  functionCallCount: number;
  functionResponseCount: number;
}

function buildSegmentedSummaryProviderCalls(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  settings: LlmProviderConfigRecord
): SummaryProviderCall[] {
  const totalTargetTokens = effectiveSummaryTargetTokens(methodConfig);
  const sourceSegments = (request.segments && request.segments.length > 0
    ? request.segments
    : request.contents.length > 0 ? [request.contents] : [])
    .filter((segment) => segment.length > 0);
  if (sourceSegments.length === 0) return [];
  const priorSummaryText = request.priorSummaryContents?.length ? plainTextOfContents(request.priorSummaryContents) : '';
  const units: SegmentedSummaryUnit[] = sourceSegments.flatMap((segment) =>
    groupAtomicMessageContents(segment).map((group) => ({
      kind: group.kind,
      estimatedTokens: group.estimatedTokens,
      functionCallCount: group.functionCallCount,
      functionResponseCount: group.functionResponseCount,
      requestContents: group.items,
      sourceContents: group.items
    }))
  );
  const groups: SegmentedSummaryChunk[] = [];
  let current: SegmentedSummaryChunk = { requestContents: [], sourceContents: [] };

  const priorFor = (index: number): string => index === 0
    ? priorSummaryText
    : finalAnswerTextOf(groups[index - 1]?.requestContents ?? []);
  const fits = (contents: MessageContent[], index: number): boolean => isSummaryProviderCallWithinWindow(
    buildSegmentDeltaCall(contents, index, priorFor(index), methodConfig, settings, totalTargetTokens),
    settings
  );
  const pushCurrent = (): void => {
    if (current.requestContents.length === 0) return;
    if (groups.length >= MAX_SEGMENTED_SUMMARY_LEAF_CALLS) {
      throw new Error(
        `compression_source_too_large: segmented summary exceeds the ${MAX_SEGMENTED_SUMMARY_LEAF_CALLS}-leaf call budget.`
      );
    }
    groups.push(current);
    current = { requestContents: [], sourceContents: [] };
  };

  for (const unit of units) {
    const candidate = [...current.requestContents, ...unit.requestContents];
    if (fits(candidate, groups.length)) {
      current.requestContents = candidate;
      current.sourceContents.push(...unit.sourceContents);
      continue;
    }
    pushCurrent();
    const safeUnits = splitOversizedSummaryUnit(
      unit,
      groups.length,
      priorFor(groups.length),
      methodConfig,
      settings,
      totalTargetTokens,
      MAX_SEGMENTED_SUMMARY_LEAF_CALLS - groups.length
    );
    for (const safeUnit of safeUnits) {
      const next = [...current.requestContents, ...safeUnit.requestContents];
      if (!fits(next, groups.length)) pushCurrent();
      if (!fits(safeUnit.requestContents, groups.length)) {
        throw new Error(
          `compression_request_too_large: fixed summary prompt cannot fit chunk ${groups.length + 1} in the frozen Provider window.`
        );
      }
      current.requestContents.push(...safeUnit.requestContents);
      current.sourceContents.push(...safeUnit.sourceContents);
    }
  }
  pushCurrent();
  if (groups.length > MAX_SEGMENTED_SUMMARY_LEAF_CALLS) {
    throw new Error(
      `compression_source_too_large: segmented summary requires ${groups.length} leaf calls; limit is ${MAX_SEGMENTED_SUMMARY_LEAF_CALLS}.`
    );
  }

  const targetTokensPerCall = Math.max(128, Math.ceil(totalTargetTokens / groups.length));
  return groups.map((group, index) => {
    const priorContext = index === 0 ? priorSummaryText : finalAnswerTextOf(groups[index - 1]?.requestContents ?? []);
    const call = buildSegmentDeltaCall(
      group.requestContents,
      index,
      priorContext,
      methodConfig,
      settings,
      targetTokensPerCall,
      group.sourceContents
    );
    if (!isSummaryProviderCallWithinWindow(call, settings)) {
      throw new Error(`compression_request_too_large: summary chunk ${index + 1} exceeds the frozen Provider input limit.`);
    }
    return call;
  });
}

function splitOversizedSummaryUnit(
  unit: SegmentedSummaryUnit,
  index: number,
  priorContext: string,
  methodConfig: LlmCompressionConfigRecord,
  settings: LlmProviderConfigRecord,
  targetTokens: number,
  maxChunks: number
): SegmentedSummaryChunk[] {
  if (maxChunks <= 0) {
    throw new Error('compression_source_too_large: segmented summary exhausted the leaf call budget.');
  }
  const direct = buildSegmentDeltaCall(
    unit.requestContents,
    index,
    priorContext,
    methodConfig,
    settings,
    targetTokens
  );
  if (isSummaryProviderCallWithinWindow(direct, settings)) return [unit];

  const message = unit.kind === 'message' && unit.requestContents.length === 1
    ? unit.requestContents[0]
    : undefined;
  const textPart = message?.parts.length === 1 && isVisibleTextPart(message.parts[0])
    ? message.parts[0]
    : undefined;
  if (message && textPart) {
    const chunks: SegmentedSummaryChunk[] = [];
    const conservativePrior = sliceByTokens(
      'previous-context '.repeat(SEGMENTED_PRIOR_CONTEXT_TOKENS * 2),
      0,
      SEGMENTED_PRIOR_CONTEXT_TOKENS
    );
    let remaining = textPart.text;
    while (remaining.length > 0) {
      if (chunks.length >= maxChunks) {
        throw new Error('compression_source_too_large: oversized message exceeds the leaf call budget.');
      }
      const fitting = largestFittingSummaryTextPrefix(
        remaining,
        message.role,
        index + chunks.length,
        conservativePrior,
        methodConfig,
        settings,
        targetTokens
      );
      if (!fitting) break;
      const chunk: MessageContent = { role: message.role, parts: [{ ...textPart, text: fitting }] };
      chunks.push({ requestContents: [chunk], sourceContents: [chunk] });
      remaining = remaining.slice(fitting.length);
    }
    if (remaining.length === 0 && chunks.length > 0) return chunks;
  }

  const transcript = renderContentsForSummary(unit.requestContents);
  const chunks: SegmentedSummaryChunk[] = [];
  const conservativePrior = sliceByTokens(
    'previous-context '.repeat(SEGMENTED_PRIOR_CONTEXT_TOKENS * 2),
    0,
    SEGMENTED_PRIOR_CONTEXT_TOKENS
  );
  let remaining = transcript;
  while (remaining.length > 0) {
    if (chunks.length >= maxChunks) {
      throw new Error(`compression_source_too_large: oversized ${unit.kind} exceeds the leaf call budget.`);
    }
    const fitting = largestFittingSummaryTextPrefix(
      remaining,
      'user',
      index + chunks.length,
      conservativePrior,
      methodConfig,
      settings,
      targetTokens
    );
    if (!fitting) break;
    const chunk: MessageContent = { role: 'user', parts: [{ text: fitting }] };
    chunks.push({ requestContents: [chunk], sourceContents: [chunk] });
    remaining = remaining.slice(fitting.length);
  }
  if (remaining.length === 0 && chunks.length > 0) return chunks;
  throw new Error(
    `compression_request_too_large: ${unit.kind} summary unit cannot be losslessly split for the frozen Provider window.`
  );
}

function largestFittingSummaryTextPrefix(
  text: string,
  role: MessageContent['role'],
  index: number,
  priorContext: string,
  methodConfig: LlmCompressionConfigRecord,
  settings: LlmProviderConfigRecord,
  targetTokens: number
): string {
  let low = 1;
  let high = Math.max(1, estimateTokenCount(text));
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidateText = sliceByTokens(text, 0, middle);
    if (!candidateText) {
      low = middle + 1;
      continue;
    }
    const call = buildSegmentDeltaCall(
      [{ role, parts: [{ text: candidateText }] }],
      index,
      priorContext,
      methodConfig,
      settings,
      targetTokens
    );
    if (isSummaryProviderCallWithinWindow(call, settings)) {
      best = candidateText;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function buildSegmentDeltaCall(
  segment: MessageContent[],
  index: number,
  priorContext: string,
  methodConfig: LlmCompressionConfigRecord,
  settings: LlmProviderConfigRecord,
  targetTokens: number,
  sourceContents: MessageContent[] = segment
): SummaryProviderCall {
  const boundedPrior = headTailTextByTokens(
    priorContext,
    Math.min(SEGMENTED_PRIOR_CONTEXT_TOKENS, targetTokens)
  );
  const transcript = renderContentsForSummary(segment);
  const userText = `${DEFAULT_SEGMENTED_SUMMARY_USER_PROMPT}\n\n【前情(只读，不要重新总结)】\n${boundedPrior || '无'}\n\n【本回合记录】\n${transcript}`;
  return {
    label: `Segment ${index + 1}`,
    sourceContents,
    targetTokens,
    request: {
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      systemInstruction: {
        parts: [{ text: withSummaryTargetInstruction(
          `${DEFAULT_SEGMENTED_SUMMARY_SYSTEM_PROMPT}\n\n${ROLLING_SUMMARY_STRUCTURE_INSTRUCTION}`,
          targetTokens
        ) }]
      },
      generationConfig: summaryGenerationConfig(methodConfig, settings, targetTokens)
    }
  };
}

function buildSummaryReplacementMergeCall(
  priorSummaryText: string,
  deltaSummaries: readonly string[],
  sourceContents: MessageContent[],
  methodConfig: LlmCompressionConfigRecord,
  settings: LlmProviderConfigRecord,
  targetTokens: number
): SummaryProviderCall {
  return {
    label: 'Summary replacement merge',
    sourceContents,
    targetTokens,
    request: {
      contents: [{ role: 'user', parts: [{ text: [
        '【旧摘要】',
        priorSummaryText || '无',
        '',
        '【新增分段摘要】',
        ...deltaSummaries.map((summary, index) => `--- delta ${index + 1} ---\n${extractSummaryTag(summary) || '无'}`)
      ].join('\n') }] }],
      systemInstruction: { parts: [{ text: withSummaryTargetInstruction(
        `把旧摘要与全部 delta 合并为一份新的 replacement summary。\n\n${ROLLING_SUMMARY_STRUCTURE_INSTRUCTION}`,
        targetTokens
      ) }] },
      generationConfig: summaryGenerationConfig(methodConfig, settings, targetTokens)
    }
  };
}

interface SegmentedSummaryNode {
  summary: string;
  sourceContents: MessageContent[];
}

async function mergeSegmentedSummaryHierarchy(
  provider: ResolvedSummaryProvider,
  initialNodes: readonly SegmentedSummaryNode[],
  priorSummaryText: string,
  methodConfig: LlmCompressionConfigRecord,
  targetTokens: number,
  signal?: AbortSignal
): Promise<string> {
  let nodes = [...initialNodes];
  for (let level = 0; nodes.length > 1; level += 1) {
    if (level >= MAX_SEGMENTED_SUMMARY_HIERARCHY_LEVELS) {
      throw new Error('compression_source_too_large: segmented summary exceeded the hierarchy depth limit.');
    }
    const groups = packSegmentedSummaryNodes(nodes, methodConfig, provider.settings, targetTokens);
    if (groups.length >= nodes.length) {
      throw new Error('compression_request_too_large: summary deltas cannot be merged inside the frozen Provider window.');
    }
    nodes = await mapWithBoundedConcurrency(
      groups,
      isOpenAIResponsesWebSocketMode(provider.settings) ? 1 : SEGMENTED_SUMMARY_CONCURRENCY,
      async (group, _index, siblingSignal) => {
        if (group.length === 1) return group[0]!;
        const call = buildSummaryReplacementMergeCall(
          '',
          group.map((node) => node.summary),
          group.flatMap((node) => node.sourceContents),
          methodConfig,
          provider.settings,
          targetTokens
        );
        return {
          summary: await summarizeSingleRound(provider, call, siblingSignal),
          sourceContents: call.sourceContents
        };
      },
      signal
    );
  }
  if (nodes.length === 0) return '';
  if (!priorSummaryText) return nodes[0]!.summary;
  const call = buildSummaryReplacementMergeCall(
    priorSummaryText,
    [nodes[0]!.summary],
    nodes[0]!.sourceContents,
    methodConfig,
    provider.settings,
    targetTokens
  );
  if (!isSummaryProviderCallWithinWindow(call, provider.settings)) {
    throw new Error('compression_request_too_large: prior summary and segmented delta cannot fit a merge request.');
  }
  return summarizeSingleRound(provider, call, signal);
}

function packSegmentedSummaryNodes(
  nodes: readonly SegmentedSummaryNode[],
  methodConfig: LlmCompressionConfigRecord,
  settings: LlmProviderConfigRecord,
  targetTokens: number
): SegmentedSummaryNode[][] {
  const groups: SegmentedSummaryNode[][] = [];
  let current: SegmentedSummaryNode[] = [];
  for (const node of nodes) {
    const candidate = [...current, node];
    const fits = current.length === 0 || isSummaryProviderCallWithinWindow(
      buildSummaryReplacementMergeCall(
        '',
        candidate.map((entry) => entry.summary),
        [],
        methodConfig,
        settings,
        targetTokens
      ),
      settings
    );
    if (fits) {
      current = candidate;
      continue;
    }
    groups.push(current);
    current = [node];
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function withSummaryTargetInstruction(prompt: string, targetTokens: number | undefined): string {
  if (typeof targetTokens !== 'number' || !Number.isFinite(targetTokens) || targetTokens <= 0) return prompt;
  return `${prompt}\n\n将可见摘要正文控制在约 ${Math.floor(targetTokens)} tokens；优先保留标识符、数字、文件名、依赖关系、决定和未完成事项。`;
}

const MAX_SEGMENTED_SUMMARY_LEAF_CALLS = 32;
const MAX_SEGMENTED_SUMMARY_HIERARCHY_LEVELS = 6;
const SEGMENTED_SUMMARY_CONCURRENCY = 3;
const SEGMENTED_PRIOR_CONTEXT_TOKENS = 1_024;
const SUMMARY_PROVIDER_MIN_OUTPUT_TOKENS = 2_048;
const SUMMARY_PROVIDER_REASONING_HEADROOM_MULTIPLIER = 2;
const SUMMARY_PROVIDER_ESTIMATOR_SLACK_TOKENS = 8_000;

/**
 * `targetTokens` is the desired visible summary length, while Provider output accounting also
 * includes hidden reasoning tokens. Keep those two budgets separate: use the target in the prompt,
 * default summary reasoning to low, and reserve a bounded hard-output ceiling. An explicit method
 * `maxOutputTokens`/`thinkingConfig` remains authoritative.
 */
function summaryGenerationConfig(
  methodConfig: LlmCompressionConfigRecord,
  settings: LlmProviderConfigRecord,
  targetTokensOverride?: number
): LlmGenerationConfigRecord | undefined {
  const targetTokens = targetTokensOverride ?? methodConfig.llmSummary?.targetTokens;
  const inherited = settings.generationConfig ?? {};
  const method = methodConfig.llmSummary?.generationConfig ?? {};
  const {
    maxOutputTokens: inheritedMaxOutputTokens,
    thinkingConfig: inheritedThinkingConfig,
    ...inheritedRest
  } = inherited;
  const {
    maxOutputTokens: methodMaxOutputTokens,
    thinkingConfig: methodThinkingConfig,
    ...methodRest
  } = method;
  const derivedMaxOutputTokens = typeof targetTokens === 'number'
    && Number.isFinite(targetTokens)
    && targetTokens > 0
    ? Math.max(
        SUMMARY_PROVIDER_MIN_OUTPUT_TOKENS,
        Math.min(
          DEFAULT_LLM_COMPRESSION_OUTPUT_RESERVE_TOKENS,
          Math.ceil(targetTokens * SUMMARY_PROVIDER_REASONING_HEADROOM_MULTIPLIER)
        )
      )
    : inheritedMaxOutputTokens;
  const generationConfig = {
    ...inheritedRest,
    ...methodRest,
    ...((methodMaxOutputTokens ?? derivedMaxOutputTokens) !== undefined
      ? { maxOutputTokens: methodMaxOutputTokens ?? derivedMaxOutputTokens }
      : {}),
    thinkingConfig: methodThinkingConfig ?? {
      ...(inheritedThinkingConfig ?? {}),
      thinkingLevel: 'low' as const
    }
  };
  return Object.keys(generationConfig).length > 0 ? generationConfig : undefined;
}

async function summarizeSingleRound(
  resolved: ResolvedSummaryProvider,
  call: SummaryProviderCall,
  signal?: AbortSignal
): Promise<string> {
  const fallback = deterministicReplacementSummary('', call.sourceContents, call.targetTokens);
  if (!resolved.provider) return fallback;

  try {
    const trimmed = (await executeSummaryProviderCall(
      resolved,
      call.request,
      signal,
      { allowCompatibilityRetry: false }
    )).trim();
    return finalizeStructuredSummary(extractSummaryTag(trimmed), fallback, call.targetTokens);
  } catch (error) {
    if (isRequestAbort(signal)) throw error;
    const contextLength = isContextLengthExceededError(error);
    logCompressionDebug('provider.compact.segmentedSummary.segmentFallback', {
      error: errorDebugInfo(error),
      segmentContents: call.sourceContents.length,
      contextLength
    });
    if (!contextLength) throw error;
    return fallback;
  }
}

async function executeSummaryProviderCall(
  resolved: ResolvedSummaryProvider,
  request: SummaryProviderCall['request'],
  signal?: AbortSignal,
  options: { allowCompatibilityRetry?: boolean } = {}
): Promise<string> {
  if (!resolved.provider) return '';
  const execute = async (activeRequest: SummaryProviderCall['request']): Promise<string> => {
    if (resolved.stream || isOpenAIResponsesWebSocketMode(resolved.settings)) {
      let text = '';
      const stream = isOpenAIResponsesWebSocketMode(resolved.settings)
        ? createSummaryWebSocketStream(resolved, activeRequest, signal)
        : resolved.provider!.chatStream<UnifiedLLMStreamChunk>(activeRequest, {
            inputFormat: 'unified',
            outputFormat: 'unified',
            signal
          });
      for await (const chunk of stream) {
        if (hasUnifiedError(chunk)) {
          throw new LlmAttemptFailureError(failureFromProviderError(chunk.error, {
            rawChunk: (chunk as { rawChunk?: unknown }).rawChunk ?? chunk
          }));
        }
        text += chunk.textDelta ?? visibleTextFromParts(chunk.partsDelta ?? []);
        if (chunk.textDelta?.trim() || chunk.partsDelta?.some((part) =>
          'text' in part && typeof part.text === 'string' && part.text.trim()
        )) {
          resolved.onCompressionProgress?.();
        }
      }
      return text;
    }

    const response = await resolved.provider!.chat<UnifiedLLMResponse>(activeRequest, {
      inputFormat: 'unified',
      outputFormat: 'unified',
      signal
    });
    if (hasUnifiedError(response)) {
      throw new LlmAttemptFailureError(failureFromProviderError(response.error, {
        rawResponse: response.rawResponse ?? response
      }));
    }
    return visibleTextFromParts(response.content?.parts ?? []);
  };

  const initialRequest = resolved.omitUnsupportedMaxOutputTokens
    ? withoutMaxOutputTokens(request)
    : request;
  try {
    return await execute(initialRequest);
  } catch (error) {
    if (options.allowCompatibilityRetry === false) throw error;
    if (hasMaxOutputTokens(initialRequest) && isUnsupportedMaxOutputTokensError(error)) {
      resolved.omitUnsupportedMaxOutputTokens = true;
      logCompressionDebug('provider.compact.summary.compatibilityRetry', {
        providerConfigId: resolved.settings.id,
        provider: resolved.settings.provider,
        transport: resolved.settings.openaiResponsesTransport,
        removedParameter: 'max_output_tokens'
      });
      return execute(withoutMaxOutputTokens(initialRequest));
    }
    if (hasMaxOutputTokens(initialRequest) && isMaxOutputTokensIncompleteError(error)) {
      const previousMaxOutputTokens = initialRequest.generationConfig!.maxOutputTokens!;
      const nextMaxOutputTokens = Math.min(DEFAULT_LLM_COMPRESSION_OUTPUT_RESERVE_TOKENS, Math.max(
        previousMaxOutputTokens + SUMMARY_PROVIDER_MIN_OUTPUT_TOKENS,
        previousMaxOutputTokens * 2
      ));
      if (nextMaxOutputTokens > previousMaxOutputTokens) {
        logCompressionDebug('provider.compact.summary.outputBudgetRetry', {
          providerConfigId: resolved.settings.id,
          provider: resolved.settings.provider,
          previousMaxOutputTokens,
          nextMaxOutputTokens
        });
        return execute(withMaxOutputTokens(initialRequest, nextMaxOutputTokens));
      }
    }
    throw error;
  }
}

async function* createSummaryWebSocketStream(
  resolved: ResolvedSummaryProvider,
  request: SummaryProviderCall['request'],
  signal?: AbortSignal
): AsyncGenerator<UnifiedLLMStreamChunk> {
  const providerDryRun = (resolved.provider as unknown as Partial<UnifiedDryRunCapable> | undefined)?.dryRun;
  if (!resolved.provider || typeof providerDryRun !== 'function' || !resolved.unified || !resolved.webSocketSessionKey) {
    throw new Error('OpenAI Responses WebSocket 摘要缺少已解析的 Provider 传输信息。');
  }
  const dryRun = await providerDryRun.call(resolved.provider, request, {
    inputFormat: 'unified',
    outputFormat: 'unified',
    stream: true
  });
  const format = new resolved.unified.OpenAIResponsesFormat(resolved.settings.model) as OpenAIResponsesFormatAdapter;
  const { streamOpenAIResponsesWebSocketSession } = await openAIResponsesWebSocketSession();
  yield* streamOpenAIResponsesWebSocketSession({
    sessionKey: resolved.webSocketSessionKey,
    url: dryRun.url,
    headers: dryRun.headers,
    body: dryRun.body,
    format,
    signal,
    proxy: resolved.proxy
  });
}

function hasMaxOutputTokens(request: SummaryProviderCall['request']): boolean {
  return typeof request.generationConfig?.maxOutputTokens === 'number';
}

function withoutMaxOutputTokens(request: SummaryProviderCall['request']): SummaryProviderCall['request'] {
  if (!hasMaxOutputTokens(request)) return request;
  const generationConfig = { ...request.generationConfig };
  delete generationConfig.maxOutputTokens;
  const next = { ...request };
  if (Object.keys(generationConfig).length > 0) next.generationConfig = generationConfig;
  else delete next.generationConfig;
  return next;
}

function withMaxOutputTokens(
  request: SummaryProviderCall['request'],
  maxOutputTokens: number
): SummaryProviderCall['request'] {
  return {
    ...request,
    generationConfig: { ...(request.generationConfig ?? {}), maxOutputTokens }
  };
}

function isUnsupportedMaxOutputTokensError(error: unknown): boolean {
  const text = summaryErrorSearchText(error);
  return text.includes('max_output_tokens')
    && (text.includes('unsupported parameter') || text.includes('unknown parameter') || text.includes('not supported'));
}

function isMaxOutputTokensIncompleteError(error: unknown): boolean {
  const text = summaryErrorSearchText(error);
  return text.includes('max_output_tokens')
    && (text.includes('incomplete') || text.includes('exhaust') || text.includes('limit'));
}

function summaryErrorSearchText(error: unknown): string {
  const failure = error instanceof LlmAttemptFailureError
    ? stringifyJson(toPlainJsonLike(error.failure))
    : '';
  return `${errorSearchText(error)}\n${failure}`.toLowerCase();
}

interface GeneratedSummaryTextResult { text: string; settings?: LlmProviderConfigRecord }

async function generateSummaryText(
  request: LlmCompactRequest,
  methodConfig: LlmCompressionConfigRecord,
  options: LlmProviderOptions,
  signal?: AbortSignal,
  resolvedProvider?: ResolvedSummaryProvider
): Promise<GeneratedSummaryTextResult> {
  const targetTokens = effectiveSummaryTargetTokens(methodConfig);
  const priorSummaryText = request.priorSummaryContents?.length
    ? plainTextOfContents(request.priorSummaryContents)
    : '';
  const fallback = deterministicReplacementSummary(priorSummaryText, request.contents, targetTokens);
  if (methodConfig.kind === 'deterministic_summary' || methodConfig.kind === 'manual_summary') {
    return { text: fallback };
  }

  if (request.contents.length === 0) return { text: fallback };

  const resolved = resolvedProvider ?? await resolveSummaryProvider(request, methodConfig, options);
  if (!resolved.provider) return { text: fallback, settings: resolved.settings };

  const call = buildSummaryProviderCall(request, methodConfig, resolved.settings);
  if (!isSummaryProviderCallWithinWindow(call, resolved.settings)) {
    throw new Error('compression_request_too_large: summary input exceeds the frozen Provider input limit.');
  }
  const text = extractSummaryTag((await executeSummaryProviderCall(resolved, call.request, signal)).trim());
  return {
    text: finalizeStructuredSummary(text, fallback, targetTokens),
    settings: resolved.settings
  };
}

function normalizeCompressionConfig(input: LlmCompressionConfigRecord | undefined, fallbackKind?: LlmCompressionConfigRecord['kind']): LlmCompressionConfigRecord {
  const now = Date.now();
  const kind = input?.kind ?? fallbackKind ?? 'llm_summary';
  return {
    id: input?.id ?? 'inline-compression-config',
    name: input?.name ?? '临时压缩方法',
    kind,
    maxDurationMinutes: normalizeLlmCompressionMaxDurationMinutes(input?.maxDurationMinutes),
    trigger: input?.trigger ?? { mode: 'manual' },
    ...(input?.openaiResponsesCompact ? { openaiResponsesCompact: input.openaiResponsesCompact } : {}),
    ...(input?.llmSummary ? { llmSummary: input.llmSummary } : {}),
    createdAt: input?.createdAt ?? now,
    updatedAt: input?.updatedAt ?? now
  };
}

function usageMetadataFromCompact(value: unknown): LlmUsageMetadataRecord | undefined {
  const cleaned = stripUndefined(value);
  return isRecord(cleaned) && Object.keys(cleaned).length > 0 ? cleaned as LlmUsageMetadataRecord : undefined;
}

function renderContentsForSummary(contents: MessageContent[]): string {
  return contents.map((content, index) => `${index + 1}. ${content.role}: ${content.parts.map(renderSummaryPart).filter(Boolean).join('\n') || '[empty]'}`).join('\n\n');
}

function renderSummaryPart(part: ContentPart): string {
  if (isTextPart(part)) return part.thought === true ? '' : part.text;
  if (isFunctionCallPart(part)) return `[tool call] ${part.functionCall.name}: ${stringifyJson(part.functionCall.args)}`;
  if (isFunctionResponsePart(part)) return `[tool result] ${part.functionResponse.name}: ${stringifyJson(part.functionResponse.response)}`;
  if (isInlineDataPart(part)) return `[inline data] ${part.inlineData.mimeType}`;
  if (isFileDataPart(part)) return `[file] ${part.fileData.uri}`;
  if (isProviderContextPart(part)) return `[provider context] ${part.providerContext.format}:${part.providerContext.itemType ?? 'context'}`;
  return '';
}

type StructuredSummaryField = 'goals' | 'constraints' | 'completed' | 'active' | 'blocked' | 'next' | 'files';

interface StructuredSummary {
  goals: string[];
  constraints: string[];
  completed: string[];
  active: string[];
  blocked: string[];
  next: string[];
  files: string[];
}

function emptyStructuredSummary(): StructuredSummary {
  return { goals: [], constraints: [], completed: [], active: [], blocked: [], next: [], files: [] };
}

function effectiveSummaryTargetTokens(methodConfig: LlmCompressionConfigRecord): number {
  const configured = methodConfig.llmSummary?.targetTokens;
  if (typeof configured !== 'number' || !Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_LLM_COMPRESSION_SUMMARY_TARGET_TOKENS;
  }
  return Math.max(1, Math.min(DEFAULT_LLM_COMPRESSION_SUMMARY_TARGET_TOKENS, Math.floor(configured)));
}

function deterministicReplacementSummary(
  priorSummaryText: string,
  contents: MessageContent[],
  targetTokens: number
): string {
  const prior = parseStructuredSummary(priorSummaryText)
    ?? structuredSummaryFromLooseText(priorSummaryText, 'active');
  const delta = structuredSummaryFromContents(contents);
  return fitStructuredSummary(mergeStructuredSummaries(prior, delta), targetTokens);
}

function structuredSummaryFromContents(contents: MessageContent[]): StructuredSummary {
  const summary = emptyStructuredSummary();
  for (const content of contents) {
    for (const part of content.parts) {
      const rendered = renderSummaryPart(part).trim();
      if (!rendered) continue;
      const facts = splitSummaryFacts(rendered);
      const textField: StructuredSummaryField = content.role === 'user' ? 'goals' : 'completed';
      for (const fact of facts) {
        appendSummaryFact(summary, textField, fact);
        if (looksLikeConstraint(fact)) appendSummaryFact(summary, 'constraints', fact);
        if (looksBlocked(fact)) appendSummaryFact(summary, 'blocked', fact);
        if (looksLikeNextStep(fact)) appendSummaryFact(summary, 'next', fact);
        for (const file of extractFileReferences(fact)) appendSummaryFact(summary, 'files', file);
      }
    }
  }
  if (contents.length > 0 && summary.active.length === 0) {
    const latest = [...contents].reverse().find((content) => content.role === 'model');
    const latestText = latest?.parts.map(renderSummaryPart).filter(Boolean).join('\n').trim();
    if (latestText) appendSummaryFact(summary, 'active', `最近状态：${headTailTextByTokens(latestText, 256)}`);
  }
  return summary;
}

function structuredSummaryFromLooseText(text: string, fallbackField: StructuredSummaryField): StructuredSummary {
  const summary = emptyStructuredSummary();
  for (const fact of splitSummaryFacts(stripSummaryEnvelope(text))) {
    let field = fallbackField;
    if (looksLikeConstraint(fact)) field = 'constraints';
    else if (looksBlocked(fact)) field = 'blocked';
    else if (looksLikeNextStep(fact)) field = 'next';
    appendSummaryFact(summary, field, fact);
    for (const file of extractFileReferences(fact)) appendSummaryFact(summary, 'files', file);
  }
  return summary;
}

function parseStructuredSummary(text: string): StructuredSummary | undefined {
  const source = stripSummaryEnvelope(text);
  if (!isStructuredSummaryText(source)) return undefined;
  const summary = emptyStructuredSummary();
  let field: StructuredSummaryField | undefined;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^#{1,6}\s*/, '');
    if (!line) continue;
    const heading = summaryHeading(line);
    if (heading) {
      field = heading.field;
      if (heading.rest && heading.rest !== '无') appendSummaryFact(summary, field, heading.rest);
      continue;
    }
    if (line === '工作状态' || line === '工作状态：') {
      field = undefined;
      continue;
    }
    if (!field) continue;
    const fact = line.replace(/^[-*•]\s*/, '').trim();
    if (fact && fact !== '无') appendSummaryFact(summary, field, fact);
  }
  return summary;
}

function summaryHeading(line: string): { field: StructuredSummaryField; rest: string } | undefined {
  const normalized = line.replace(/[：:]\s*/, ':');
  const headings: Array<[string, StructuredSummaryField]> = [
    ['重要约束、决定和准确标识', 'constraints'],
    ['重要约束、决定和标识', 'constraints'],
    ['- 已完成', 'completed'],
    ['已完成', 'completed'],
    ['- 正在做', 'active'],
    ['正在做', 'active'],
    ['- 受阻', 'blocked'],
    ['受阻', 'blocked'],
    ['下一步', 'next'],
    ['相关文件', 'files'],
    ['目标', 'goals']
  ];
  for (const [heading, field] of headings) {
    if (normalized === heading || normalized === `${heading}:`) return { field, rest: '' };
    if (normalized.startsWith(`${heading}:`)) return { field, rest: normalized.slice(heading.length + 1).trim() };
  }
  return undefined;
}

function isStructuredSummaryText(text: string): boolean {
  const source = stripSummaryEnvelope(text);
  return ['目标', '重要约束、决定', '工作状态', '已完成', '正在做', '受阻', '下一步', '相关文件']
    .every((heading) => source.includes(heading));
}

function finalizeStructuredSummary(candidate: string, fallback: string, targetTokens: number): string {
  const fallbackSummary = parseStructuredSummary(fallback)
    ?? structuredSummaryFromLooseText(fallback, 'active');
  const parsed = parseStructuredSummary(candidate);
  if (!parsed || structuredSummaryFactCount(parsed) === 0) {
    return fitStructuredSummary(fallbackSummary, targetTokens);
  }
  return fitStructuredSummary(mergeStructuredSummaries(fallbackSummary, parsed), targetTokens);
}

function structuredSummaryFactCount(summary: StructuredSummary): number {
  return Object.values(summary).reduce((count, facts) => count + facts.length, 0);
}

function mergeStructuredSummaries(prior: StructuredSummary, delta: StructuredSummary): StructuredSummary {
  const merged = emptyStructuredSummary();
  for (const field of Object.keys(merged) as StructuredSummaryField[]) {
    merged[field] = replacementMergeFacts(prior[field], delta[field]);
  }
  return merged;
}

const MAX_STRUCTURED_SUMMARY_FACTS_PER_FIELD = 80;

function replacementMergeFacts(prior: readonly string[], delta: readonly string[]): string[] {
  const facts = new Map<string, string>();
  for (const fact of [...prior, ...delta]) {
    const normalized = normalizeSummaryFact(fact);
    if (!normalized || normalized === '无') continue;
    const key = summaryReplacementKey(normalized);
    facts.delete(key);
    facts.set(key, normalized);
  }
  const values = [...facts.values()];
  if (values.length <= MAX_STRUCTURED_SUMMARY_FACTS_PER_FIELD) return values;
  return [
    values[0]!,
    ...values.slice(-(MAX_STRUCTURED_SUMMARY_FACTS_PER_FIELD - 1))
  ];
}

function summaryReplacementKey(fact: string): string {
  const keyValue = /^(.{1,96}?)[：:=]\s*/.exec(fact)?.[1]
    ?.trim()
    .replace(/^(?:必须|不得|不要|只能|需要|require|must|never|only)\s*/i, '')
    .toLowerCase();
  if (keyValue) return `key:${keyValue}`;
  const file = extractFileReferences(fact)[0];
  if (file && fact.length < 180) return `file:${file.toLowerCase()}`;
  return `fact:${fact.toLowerCase()}`;
}

function appendSummaryFact(summary: StructuredSummary, field: StructuredSummaryField, fact: string): void {
  const normalized = normalizeSummaryFact(fact);
  if (!normalized || normalized === '无') return;
  summary[field] = replacementMergeFacts(summary[field], [headTailTextByTokens(normalized, 512)]);
}

function normalizeSummaryFact(value: string): string {
  return value.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\s+/g, ' ').trim();
}

function splitSummaryFacts(text: string): string[] {
  const lines = text.split(/\r?\n+/).map(normalizeSummaryFact).filter(Boolean);
  if (lines.length > 1) return lines;
  return text.split(/(?<=[。！？.!?])\s+/).map(normalizeSummaryFact).filter(Boolean);
}

function looksLikeConstraint(text: string): boolean {
  return /(?:必须|不得|不要|只能|需要|限制|约束|require|must|never|only)/i.test(text);
}

function looksBlocked(text: string): boolean {
  return /(?:受阻|失败|错误|报错|无法|缺少|blocked|failed|error|cannot|missing)/i.test(text);
}

function looksLikeNextStep(text: string): boolean {
  return /(?:下一步|待办|随后|接下来|尚未|todo|next|remaining)/i.test(text);
}

function extractFileReferences(text: string): string[] {
  const matches = text.match(/(?:[A-Za-z]:\\[^\s"'`]+|\/(?:[^\s"'`]+\/)*[^\s"'`]+|(?:[\w.@-]+\/)+[\w.@-]+\.[A-Za-z0-9_-]+)/g) ?? [];
  return [...new Set(matches.map((entry) => entry.replace(/[),.;，。；]+$/, '')))];
}

function formatStructuredSummary(summary: StructuredSummary): string {
  const list = (facts: readonly string[]) => facts.length > 0
    ? facts.map((fact) => `- ${fact}`).join('\n')
    : '- 无';
  return [
    '目标',
    list(summary.goals),
    '',
    '重要约束、决定和准确标识',
    list(summary.constraints),
    '',
    '工作状态',
    '  - 已完成',
    indentSummaryFacts(summary.completed),
    '  - 正在做',
    indentSummaryFacts(summary.active),
    '  - 受阻',
    indentSummaryFacts(summary.blocked),
    '',
    '下一步',
    list(summary.next),
    '',
    '相关文件',
    list(summary.files)
  ].join('\n');
}

function indentSummaryFacts(facts: readonly string[]): string {
  return facts.length > 0
    ? facts.map((fact) => `    - ${fact}`).join('\n')
    : '    - 无';
}

function fitStructuredSummary(input: StructuredSummary, targetTokens: number): string {
  const summary = Object.fromEntries((Object.keys(input) as StructuredSummaryField[]).map((field) => [
    field,
    replacementMergeFacts([], input[field])
  ])) as unknown as StructuredSummary;
  let rendered = formatStructuredSummary(summary);
  if (estimateTokenCount(rendered) <= targetTokens) return rendered;

  const dropOrder: StructuredSummaryField[] = ['completed', 'files', 'goals', 'constraints', 'next', 'blocked', 'active'];
  let changed = true;
  while (estimateTokenCount(rendered) > targetTokens && changed) {
    changed = false;
    for (const field of dropOrder) {
      if (summary[field].length <= 2) continue;
      summary[field].splice(1, 1);
      changed = true;
      rendered = formatStructuredSummary(summary);
      if (estimateTokenCount(rendered) <= targetTokens) return rendered;
    }
  }

  for (const perFactLimit of [256, 128, 64, 32, 16, 8]) {
    for (const field of Object.keys(summary) as StructuredSummaryField[]) {
      summary[field] = summary[field].map((fact) => headTailTextByTokens(fact, perFactLimit));
    }
    rendered = formatStructuredSummary(summary);
    if (estimateTokenCount(rendered) <= targetTokens) return rendered;
  }
  return fitTextToTokenLimit(rendered, targetTokens);
}

function summaryContents(summary: string, targetTokens: number): MessageContent[] {
  const prefix = '[Context Summary]\n\n';
  const prefixTokens = estimateTokenCount(prefix);
  const bodyBudget = Math.max(1, targetTokens - prefixTokens);
  const structured = parseStructuredSummary(summary);
  const boundedBody = structured
    ? fitStructuredSummary(structured, bodyBudget)
    : fitTextToTokenLimit(summary, bodyBudget);
  const text = targetTokens > prefixTokens
    ? `${prefix}${boundedBody}`
    : fitTextToTokenLimit(boundedBody, targetTokens);
  return [{ role: 'user', parts: [{ text: fitTextToTokenLimit(text, targetTokens) }] }];
}

function stripSummaryEnvelope(text: string): string {
  return extractSummaryTag(text.replace(/^\s*\[Context Summary\]\s*/i, '')).trim();
}

function headTailTextByTokens(text: string, limit: number): string {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  if (estimateTokenCount(text) <= normalizedLimit) return text;
  const marker = ' … [缩短] … ';
  const markerTokens = estimateTokenCount(marker);
  if (normalizedLimit <= markerTokens + 1) return fitTextToTokenLimit(text, normalizedLimit);
  const available = normalizedLimit - markerTokens;
  const headTokens = Math.max(1, Math.floor(available * 0.6));
  const tailTokens = Math.max(1, available - headTokens);
  return fitTextToTokenLimit(
    `${sliceByTokens(text, 0, headTokens)}${marker}${sliceByTokens(text, -tailTokens)}`,
    normalizedLimit
  );
}

function fitTextToTokenLimit(text: string, limit: number): string {
  const normalizedLimit = Math.max(1, Math.floor(limit));
  if (estimateTokenCount(text) <= normalizedLimit) return text;
  let end = normalizedLimit;
  let sliced = sliceByTokens(text, 0, end);
  while (end > 0 && estimateTokenCount(sliced) > normalizedLimit) {
    end -= 1;
    sliced = sliceByTokens(text, 0, end);
  }
  return sliced;
}

function isSummaryProviderCallWithinWindow(
  call: SummaryProviderCall,
  settings: LlmProviderConfigRecord
): boolean {
  const contextWindowTokens = settings.contextWindowTokens ?? DEFAULT_LLM_CONTEXT_WINDOW_TOKENS;
  const outputTokens = call.request.generationConfig?.maxOutputTokens
    ?? DEFAULT_LLM_COMPRESSION_OUTPUT_RESERVE_TOKENS;
  const inputLimit = contextWindowTokens
    - Math.max(DEFAULT_LLM_COMPRESSION_OUTPUT_RESERVE_TOKENS, outputTokens)
    - SUMMARY_PROVIDER_ESTIMATOR_SLACK_TOKENS;
  if (inputLimit <= 0) return false;
  return estimateTokenCount(JSON.stringify({
    contents: call.request.contents,
    systemInstruction: call.request.systemInstruction
  })) <= inputLimit;
}

function modelCatalogEntryToRecord(model: UnifiedModelCatalogEntry): LlmProviderModelRecord {
  return {
    id: model.id,
    name: model.displayName || model.label || model.name || model.id,
    ...(model.createdAt ? { createdAt: model.createdAt } : {})
  };
}

function normalizeSettings(settings: LlmProviderConfigRecord | undefined): LlmProviderConfigRecord {
  const headers = normalizeHeaders(settings?.headers);
  const generationConfig = settings?.generationConfig;
  const requestBody = settings?.requestBody;
  const nativeResponses = normalizeOpenAIResponsesNativeSettings(settings?.nativeResponses);
  const contextWindowTokens = normalizeContextWindowTokens(settings?.contextWindowTokens);
  const retryMaxAttempts = normalizeRetryMaxAttempts(settings?.retryMaxAttempts) ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS;
  return adaptAstraNativeParameterSettings({
    id: settings?.id?.trim() || 'llm-provider-config-default',
    name: settings?.name?.trim() || '默认渠道',
    provider: normalizeProvider(settings?.provider),
    baseUrl: settings?.baseUrl?.trim() || DEFAULT_LLM_BASE_URL,
    model: settings?.model?.trim() ?? '',
    models: settings?.models ?? [],
    apiKey: settings?.apiKey?.trim() ?? '',
    toolCallFormat: normalizeToolCallFormat(settings?.toolCallFormat),
    openaiResponsesTransport: normalizeOpenAIResponsesTransport(settings?.openaiResponsesTransport),
    stream: settings?.stream !== false,
    retryOnError: settings?.retryOnError !== false ? DEFAULT_LLM_RETRY_ON_ERROR : false,
    retryMaxAttempts,
    retryDelaySeconds: normalizeRetryDelaySeconds(settings?.retryDelaySeconds),
    enableMultimodalTools: settings?.enableMultimodalTools !== false,
    ...(contextWindowTokens ? { contextWindowTokens } : {}),
    systemPromptPrefix: typeof settings?.systemPromptPrefix === 'string' ? settings.systemPromptPrefix : '',
    ...(headers ? { headers } : {}),
    ...(nonEmptyRecord(generationConfig) ? { generationConfig } : {}),
    ...(nonEmptyRecord(requestBody) ? { requestBody } : {}),
    promptCache: normalizePromptCache(settings?.promptCache, normalizeProvider(settings?.provider)),
    ...(nativeResponses ? { nativeResponses } : {}),
    modelConfigs: settings?.modelConfigs ?? [],
    createdAt: settings?.createdAt ?? 0,
    updatedAt: settings?.updatedAt ?? 0
  });
}

/** Astra 模型不支持的请求参数；reasoning none/minimal 也不受支持。 */
const ASTRA_UNSUPPORTED_REQUEST_BODY_KEYS: Record<string, true> = {
  temperature: true,
  top_p: true,
  top_logprobs: true,
  logprobs: true
};
const ASTRA_UNSUPPORTED_INCLUDE_VALUES: Record<string, true> = {
  'message.output_text.logprobs': true
};

/**
 * Astra 参数适配：精确 Astra 模型 + openai-responses 时，剔除不支持的 temperature/top_p/
 * top_logprobs/logprobs，把 reasoning none/minimal 提升为 low。其他模型/渠道原样返回（同一引用）。
 * 适配在设置解析时完成，冻结快照/恢复因此总是携带有效值。幂等。
 */
function adaptAstraNativeParameterSettings(settings: LlmProviderConfigRecord): LlmProviderConfigRecord {
  if (settings.provider !== 'openai-responses' || !isAstraModel(settings.model)) return settings;
  const generationConfig = adaptAstraGenerationConfig(settings.generationConfig);
  const requestBody = adaptAstraRequestBody(settings.requestBody);
  if (generationConfig === settings.generationConfig && requestBody === settings.requestBody) return settings;
  const next = { ...settings };
  if (generationConfig !== settings.generationConfig) {
    if (generationConfig && nonEmptyRecord(generationConfig)) next.generationConfig = generationConfig;
    else delete next.generationConfig;
  }
  if (requestBody !== settings.requestBody) {
    if (requestBody && nonEmptyRecord(requestBody)) next.requestBody = requestBody;
    else delete next.requestBody;
  }
  return next;
}

function adaptAstraGenerationConfig(
  generationConfig: LlmGenerationConfigRecord | undefined
): LlmGenerationConfigRecord | undefined {
  if (!generationConfig) return generationConfig;
  const thinkingLevel = generationConfig.thinkingConfig?.thinkingLevel;
  const adaptedLevel: LlmThinkingLevel | undefined = thinkingLevel === 'none' || thinkingLevel === 'minimal' ? 'low' : thinkingLevel;
  const changed = generationConfig.temperature !== undefined
    || generationConfig.topP !== undefined
    || adaptedLevel !== thinkingLevel;
  if (!changed) return generationConfig;
  const next: LlmGenerationConfigRecord = { ...generationConfig };
  delete next.temperature;
  delete next.topP;
  if (adaptedLevel !== thinkingLevel && generationConfig.thinkingConfig) {
    next.thinkingConfig = { ...generationConfig.thinkingConfig, thinkingLevel: adaptedLevel };
  }
  return next;
}

/**
 * 单次请求实际使用的 generationConfig：冻结调用快照携带时以快照为准（冻结 recipe 的
 * base reasoning 等），否则用解析出的渠道/模型配置。Astra 目标上快照值同样过一遍参数适配。
 */
function effectiveRequestGenerationConfig(
  request: LlmStartRequest,
  settings: LlmProviderConfigRecord
): LlmGenerationConfigRecord | undefined {
  const frozen = request.settingsSnapshot?.generationConfig;
  if (!frozen) return settings.generationConfig;
  return settings.provider === 'openai-responses' && isAstraModel(settings.model)
    ? adaptAstraGenerationConfig(frozen)
    : frozen;
}

function adaptAstraRequestBody(requestBody: LlmRequestBodyRecord | undefined): LlmRequestBodyRecord | undefined {
  if (!requestBody) return requestBody;
  const entries = Object.entries(requestBody).filter(([key]) => !ASTRA_UNSUPPORTED_REQUEST_BODY_KEYS[key]);
  const include = requestBody.include;
  const adaptedInclude = Array.isArray(include)
    ? include.filter((value) => !(typeof value === 'string' && ASTRA_UNSUPPORTED_INCLUDE_VALUES[value]))
    : undefined;
  const includeChanged = Array.isArray(include) && adaptedInclude !== undefined && adaptedInclude.length !== include.length;
  if (entries.length === Object.keys(requestBody).length && !includeChanged) return requestBody;
  const next = Object.fromEntries(entries) as LlmRequestBodyRecord;
  if (adaptedInclude !== undefined) {
    if (adaptedInclude.length > 0) next.include = adaptedInclude;
    else delete next.include;
  }
  return next;
}

async function resolveRuntimeSettings(
  request: LlmStartRequest | LlmCompactRequest,
  options: LlmProviderOptions,
  resolvedRuntimeSettingsByInvocationId?: Map<string, LlmProviderConfigRecord>
): Promise<LlmProviderConfigRecord> {
  const cached = request.invocationId ? resolvedRuntimeSettingsByInvocationId?.get(request.invocationId) : undefined;
  if (cached) return normalizeSettings(cached);
  return normalizeSettings(await resolveMaybe(options.settings, request));
}

function snapshotFromSettings(settings: LlmProviderConfigRecord, compressionConfig?: LlmCompressionConfigRecord): LlmInvocationSettingsSnapshotRecord {
  const modelId = settings.model.trim();
  const modelName = modelId ? settings.models.find((model) => model.id === modelId)?.name.trim() || modelId : undefined;
  return {
    providerConfigId: settings.id,
    providerConfigName: settings.name,
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    ...(modelId ? { modelId } : {}),
    ...(modelName ? { modelName, displayModelName: modelName } : {}),
    toolCallFormat: settings.toolCallFormat,
    openaiResponsesTransport: settings.openaiResponsesTransport,
    stream: settings.stream !== false,
    retryOnError: settings.retryOnError !== false,
    retryMaxAttempts: normalizeRetryMaxAttempts(settings.retryMaxAttempts) ?? DEFAULT_LLM_RETRY_MAX_ATTEMPTS,
    retryDelaySeconds: normalizeRetryDelaySeconds(settings.retryDelaySeconds),
    enableMultimodalTools: settings.enableMultimodalTools !== false,
    ...(settings.contextWindowTokens ? { contextWindowTokens: settings.contextWindowTokens } : {}),
    ...(settings.systemPromptPrefix.trim() ? { systemPromptPrefix: settings.systemPromptPrefix } : {}),
    ...(settings.generationConfig ? { generationConfig: settings.generationConfig } : {}),
    ...(settings.requestBody ? { requestBody: settings.requestBody } : {}),
    ...(settings.promptCache ? { promptCache: settings.promptCache } : {}),
    ...(settings.nativeResponses ? { nativeResponses: settings.nativeResponses } : {}),
    ...(compressionConfig?.id ? { compressionConfigId: compressionConfig.id } : {}),
    ...(compressionConfig?.kind ? { compressionMethodKind: compressionConfig.kind } : {}),
    ...(compressionConfig?.trigger ? { compressionTrigger: compressionConfig.trigger } : {}),
    ...(compressionConfig ? { compressionConfigSnapshot: cloneJsonValue(compressionConfig) } : {}),
    ...(settings.headers ? { headers: maskSensitiveHeaders(settings.headers) } : {})
  };
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function resolveModelDisplayName(settings: LlmProviderConfigRecord): string | undefined {
  const modelId = settings.model.trim();
  if (!modelId) return undefined;
  const catalogName = settings.models.find((model) => model.id === modelId)?.name.trim();
  return catalogName || modelId;
}

function maskSensitiveHeaders(headers: LlmProviderHeadersRecord): LlmProviderHeadersRecord {
  const masked: LlmProviderHeadersRecord = {};
  for (const [key, value] of Object.entries(headers)) {
    masked[key] = isSensitiveHeaderName(key) ? maskSecretValue(value) : value;
  }
  return masked;
}

function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === 'authorization' || normalized === 'x-api-key' || normalized === 'x-goog-api-key' || normalized === 'api-key' || normalized === 'openai-key' || normalized.includes('token') || normalized.includes('secret') || normalized.includes('key');
}

function maskSecretValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length <= 8 ? '••••••••' : `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

function normalizeProvider(provider: LlmProviderKind | undefined): LlmProviderKind {
  return provider === 'gemini' || provider === 'claude' || provider === 'openai-compatible' || provider === 'openai-responses' || provider === 'deepseek'
    ? provider
    : 'openai-compatible';
}

function normalizeToolCallFormat(format: LlmToolCallFormat | undefined): LlmToolCallFormat {
  return format === 'function-call' ? format : 'function-call';
}

function normalizeOpenAIResponsesTransport(value: unknown): LlmOpenAIResponsesTransport {
  return value === 'websocket' ? 'websocket' : 'http';
}

function normalizePromptCache(input: LlmPromptCacheConfigRecord | undefined, provider: LlmProviderKind): LlmPromptCacheConfigRecord {
  if (!input || typeof input !== 'object') return createDefaultLlmPromptCacheConfig(provider);
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : true,
    mode: normalizePromptCacheMode(input.mode, provider),
    ttl: normalizePromptCacheTtl(input.ttl, provider)
  };
}

function normalizePromptCacheMode(input: unknown, provider: LlmProviderKind): LlmPromptCacheMode {
  if (provider === 'openai-responses' && input === 'explicit') return 'explicit';
  return defaultLlmPromptCacheModeForProvider(provider);
}

function normalizePromptCacheTtl(input: unknown, provider: LlmProviderKind): LlmPromptCacheTtl {
  if (provider === 'openai-responses') return '30m';
  if (provider === 'claude') return input === '5m' || input === '1h' ? input : defaultLlmPromptCacheTtlForProvider(provider);
  return defaultLlmPromptCacheTtlForProvider(provider);
}

function unifiedPromptCacheConfigEntry(settings: LlmProviderConfigRecord, requestBody?: LlmRequestBodyRecord): { promptCache: Record<string, unknown> } | Record<string, never> {
  const promptCache = unifiedPromptCacheFromSettings(settings, requestBody);
  return promptCache ? { promptCache } : {};
}

function unifiedPromptCacheFromSettings(settings: LlmProviderConfigRecord, requestBody?: LlmRequestBodyRecord): Record<string, unknown> | undefined {
  if (!isPromptCacheSupportedProvider(settings.provider)) return undefined;
  const promptCache = normalizePromptCache(settings.promptCache, settings.provider);
  if (!promptCache.enabled) return undefined;
  if (settings.provider === 'openai-responses') {
    const effectiveRequestBody = requestBody ?? settings.requestBody;
    const key = typeof effectiveRequestBody?.prompt_cache_key === 'string' && effectiveRequestBody.prompt_cache_key.trim()
      ? effectiveRequestBody.prompt_cache_key.trim()
      : undefined;
    if (promptCache.mode === 'key') return key ? { enabled: true, mode: 'key', key } : undefined;
    return {
      enabled: true,
      mode: 'explicit',
      ttl: promptCache.ttl,
      breakpoints: { messages: true },
      ...(key ? { key } : {})
    };
  }
  return {
    enabled: true,
    ttl: promptCache.ttl,
    mode: 'explicit',
    breakpoints: { system: true, tools: true, messages: true }
  };
}

function requestBodyWithOpenAIPromptCacheKey(settings: LlmProviderConfigRecord, conversationId?: string): LlmRequestBodyRecord | undefined {
  const requestBody = settings.requestBody;
  if (settings.provider !== 'openai-responses') return requestBody;
  if (typeof requestBody?.prompt_cache_key === 'string' && requestBody.prompt_cache_key.trim()) return requestBody;
  const promptCache = normalizePromptCache(settings.promptCache, settings.provider);
  if (!promptCache.enabled || !conversationId?.trim()) return requestBody;
  return {
    ...(requestBody ?? {}),
    prompt_cache_key: createOpenAIPromptCacheKey(settings, conversationId)
  };
}

function createOpenAIPromptCacheKey(settings: LlmProviderConfigRecord, conversationId: string): string {
  return createHash('sha256')
    .update([
      settings.id,
      settings.model,
      conversationId
    ].join('\n'))
    .digest('hex')
    .slice(0, 32);
}

function openAIResponsesWebSocketConfigEntry(settings: LlmProviderConfigRecord, conversationId?: string): Record<string, unknown> {
  if (!isOpenAIResponsesWebSocketMode(settings)) return {};
  return {
    transport: 'websocket',
    webSocketSessionKey: createOpenAIResponsesWebSocketSessionKey(
      settings,
      requireOpenAIResponsesWebSocketConversationId(conversationId)
    )
  };
}

function openAIResponsesWebSocketDryRunResult(result: UnifiedDryRunResult, includeApiKey: boolean, model?: string): UnifiedDryRunResult & { maskedCurl: string } {
  const url = toWebSocketUrl(result.url);
  const body = openAIResponsesWebSocketDryRunPayload(result.body, isAstraModel(model));
  const headers = result.headers;
  return {
    ...result,
    providerName: `${result.providerName} WebSocket`,
    url,
    body,
    bodyText: stringifyJsonPretty(body),
    curl: formatWebSocketDryRun(url, includeApiKey ? headers : maskSensitiveHeaders(headers), body),
    maskedCurl: formatWebSocketDryRun(url, maskSensitiveHeaders(headers), body)
  };
}

function openAIResponsesWebSocketDryRunPayload(body: unknown, preserveNativeCache = false): Record<string, unknown> {
  const record = isRecord(body) ? stripOpenAIResponsesWebSocketUnsupportedFields(body, preserveNativeCache) as Record<string, unknown> : {};
  delete record.type;
  delete record.stream;
  delete record.background;
  delete record.previous_response_id;
  // Astra WS 必须保留显式缓存选项与断点；其他模型保持原有剥离行为。
  if (!preserveNativeCache) delete record.prompt_cache_options;
  return { type: 'response.create', ...record, store: false };
}

function stripOpenAIResponsesWebSocketUnsupportedFields(value: unknown, preserveNativeCache = false): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripOpenAIResponsesWebSocketUnsupportedFields(entry, preserveNativeCache));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => preserveNativeCache || key !== 'prompt_cache_breakpoint')
    .map(([key, nested]) => [key, stripOpenAIResponsesWebSocketUnsupportedFields(nested, preserveNativeCache)]));
}

function formatWebSocketDryRun(url: string, headers: Record<string, string>, body: unknown): string {
  return [
    '# WebSocket mode：先建立连接，再发送 response.create JSON 事件。',
    `CONNECT ${url}`,
    '',
    '# Headers',
    stringifyJsonPretty(headers),
    '',
    '# Send',
    stringifyJsonPretty(body)
  ].join('\n');
}

function toWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
  else if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
  return parsed.toString();
}

function stringifyJsonPretty(value: unknown): string {
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function isOpenAIResponsesWebSocketMode(settings: LlmProviderConfigRecord): boolean {
  return settings.provider === 'openai-responses' && settings.openaiResponsesTransport === 'websocket';
}

export function createOpenAIResponsesWebSocketSessionKey(
  settings: LlmProviderConfigRecord,
  conversationId: string
): string {
  return createHash('sha256')
    .update([
      'openai-responses-websocket',
      settings.id,
      settings.baseUrl,
      settings.model,
      requireOpenAIResponsesWebSocketConversationId(conversationId)
    ].join('\n'))
    .digest('hex')
    .slice(0, 32);
}

function requireOpenAIResponsesWebSocketConversationId(conversationId: string | undefined): string {
  const normalized = conversationId?.trim();
  if (!normalized) {
    throw new TypeError('OpenAI Responses WebSocket requests require a non-empty conversationId.');
  }
  return normalized;
}

function normalizeHeaders(headers: unknown): LlmProviderHeadersRecord | undefined {
  if (!isRecord(headers)) return undefined;
  const result: LlmProviderHeadersRecord = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = rawKey.trim();
    if (!key) continue;
    if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') continue;
    result[key] = String(rawValue).trim();
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function mergeHeaders(...records: Array<Record<string, string> | undefined>): LlmProviderHeadersRecord | undefined {
  const result: LlmProviderHeadersRecord = {};
  for (const record of records) {
    if (!record) continue;
    for (const [rawKey, rawValue] of Object.entries(record)) {
      const key = rawKey.trim();
      if (!key) continue;
      const existingKey = Object.keys(result).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      // 保留默认头的拼写，避免 SDK 再补同名头后被 fetch 拼接成多值。
      result[existingKey ?? key] = rawValue;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeContextWindowTokens(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : undefined;
}

function normalizeRetryMaxAttempts(value: unknown): number | undefined {
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  const attempts = Math.floor(number);
  return attempts < -1 ? -1 : attempts;
}

type NativeAttachmentResolverOptions = Pick<LlmProviderOptions, 'resolveAttachment'>;

/**
 * 原生控制器包装：steer/submitToolResults 先经过既有授权附件解析（与请求多模态准备同一
 * fenced root / 会话身份），再把线级形状交给 Transport/会话的原始控制器。准入收据原样回传。
 * 解析失败必须让提交直接失败——绝不静默降级、绝不把媒体 JSON 化成文本。
 */
function wrapOpenAIResponsesNativeController(
  controller: OpenAIResponsesNativeController,
  options: LlmProviderOptions
): OpenAIResponsesNativeController {
  return {
    get responseId() { return controller.responseId; },
    get connectionGeneration() { return controller.connectionGeneration; },
    get streamId() { return controller.streamId; },
    async steer(command) {
      const input = await Promise.all(command.input.map((content) => resolveNativeSteeringContent(content, options)));
      await controller.steer({ ...command, input });
    },
    async submitToolResults(outputs) {
      const resolved = await resolveOpenAIResponsesNativeToolOutputs(outputs, options);
      return controller.submitToolResults(resolved);
    },
    endLogicalRequest() {
      controller.endLogicalRequest();
    }
  };
}

async function resolveNativeSteeringContent(
  content: MessageContent,
  options: NativeAttachmentResolverOptions
): Promise<MessageContent> {
  const preparation = createMultimodalPreparationContext();
  const parts = await Promise.all(content.parts.map(async (part) => {
    if (!isInlineDataPart(part) || part.inlineData.data) return part;
    const resolved = await resolveAttachmentOnce(part, options, preparation);
    if (!resolved?.inlineData.data) {
      throw new Error(`Native steering attachment ${mediaReferenceLabel(part)} could not be resolved under the current fenced root.`);
    }
    return resolved;
  }));
  return { ...content, parts };
}

/**
 * 把内核交付的原生工具输出解析为线级形状。function_call_output.output 的媒体块可以携带
 * 托管引用（attachmentId/sourcePath/sha256 + mimeType），在此解析成 data URL；input_text 与
 * 已就绪的 data URL 块原样透传。Adapter 的 materializeNativeToolOutput 与控制器包装共用本函数。
 */
export async function resolveOpenAIResponsesNativeToolOutputs(
  outputs: readonly OpenAIResponsesToolOutput[],
  options: NativeAttachmentResolverOptions
): Promise<OpenAIResponsesToolOutput[]> {
  const preparation = createMultimodalPreparationContext();
  return Promise.all(outputs.map(async (output) => {
    if (!Array.isArray(output.output)) return output;
    return { ...output, output: await resolveNativeOutputBlocks(output.output, options, preparation) };
  }));
}

async function resolveNativeOutputBlocks(
  blocks: Array<Record<string, unknown>>,
  options: NativeAttachmentResolverOptions,
  preparation: MultimodalPreparationContext
): Promise<Array<Record<string, unknown>>> {
  return Promise.all(blocks.map(async (block) => {
    if ('inlineData' in block) {
      throw new TypeError('Native tool output blocks must be Responses content blocks, not raw InlineDataPart values.');
    }
    const managed = nativeManagedBlockReference(block);
    if (!managed) return block;
    const resolved = await resolveAttachmentOnce(managed, options, preparation);
    if (!resolved?.inlineData.data) {
      throw new Error(`Native tool output attachment ${mediaReferenceLabel(managed)} could not be resolved under the current fenced root.`);
    }
    const dataUrl = `data:${resolved.inlineData.mimeType || 'application/octet-stream'};base64,${resolved.inlineData.data}`;
    const name = typeof block.name === 'string' && block.name ? block.name : resolved.inlineData.name;
    return block.type === 'input_image'
      ? { type: 'input_image', image_url: dataUrl, ...(name ? { name } : {}) }
      : { type: 'input_file', file_data: dataUrl, ...(name ? { filename: name } : {}) };
  }));
}

/** 识别携带托管引用的媒体块；已含线级 data URL 或非媒体块返回 undefined。 */
function nativeManagedBlockReference(block: Record<string, unknown>): InlineDataPart | undefined {
  if (block.type !== 'input_image' && block.type !== 'input_file') return undefined;
  if (typeof block.image_url === 'string' || typeof block.file_data === 'string') return undefined;
  const attachmentId = typeof block.attachmentId === 'string' && block.attachmentId.trim() ? block.attachmentId : undefined;
  const sourcePath = typeof block.sourcePath === 'string' && block.sourcePath.trim() ? block.sourcePath : undefined;
  const sha256 = typeof block.sha256 === 'string' && block.sha256.trim() ? block.sha256 : undefined;
  if (!attachmentId && !sourcePath && !sha256) return undefined;
  const mimeType = typeof block.mimeType === 'string' ? block.mimeType : '';
  const name = typeof block.name === 'string' && block.name ? block.name : undefined;
  return {
    inlineData: {
      mimeType,
      ...(name ? { name } : {}),
      ...(attachmentId ? { attachmentId } : {}),
      ...(sourcePath ? { sourcePath } : {}),
      ...(sha256 ? { sha256 } : {})
    }
  };
}

function isNativeConfigurationUpdatePart(part: ContentPart): boolean {
  if (!isProviderContextPart(part)) return false;
  if (part.providerContext.itemType === 'configuration_update') return true;
  const rawItem = part.providerContext.rawItem;
  return isRecord(rawItem) && rawItem.type === 'configuration_update';
}

/**
 * 服务端 compaction 与 reasoning configuration_update 是官方不支持组合：历史携带
 * configuration_update 时，从有效请求体中剥掉 context_management 与 truncation:'auto'。
 * LimCode 本地压缩仍是唯一压缩权威；无 configuration_update 时原样返回（同一引用）。
 */
function withoutNativeServerSideCompaction(
  requestBody: LlmRequestBodyRecord | undefined,
  contents: readonly MessageContent[]
): LlmRequestBodyRecord | undefined {
  if (!requestBody) return requestBody;
  if (!contents.some((content) => content.parts.some(isNativeConfigurationUpdatePart))) return requestBody;
  const stripContextManagement = 'context_management' in requestBody;
  const stripTruncation = requestBody.truncation === 'auto';
  if (!stripContextManagement && !stripTruncation) return requestBody;
  const next = { ...requestBody };
  if (stripContextManagement) delete next.context_management;
  if (stripTruncation) delete next.truncation;
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

async function resolveMaybe<T, TArg = void>(value: MaybeProvider<T, TArg>, arg?: TArg): Promise<T | undefined> {
  if (typeof value === 'function') return (value as (input: TArg | undefined) => T | undefined | Promise<T | undefined>)(arg);
  return value;
}

async function importUnifiedLlmProvider(): Promise<UnifiedModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<UnifiedModule>;
  return dynamicImport('unified-llm-provider');
}
function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function isRequestAbort(signal?: AbortSignal): boolean {
  // 只在本请求自己的 AbortController 被触发时静默取消。
  // 某些网络层会把 ECONNRESET / socket hang up / 超时包装成 AbortError；
  // 如果不校验 signal.aborted，这类真实失败会被误判为用户取消，导致压缩块一直停在 running。
  return signal?.aborted === true;
}

function compactRequestDebugInfo(request: LlmCompactRequest): Record<string, unknown> {
  return {
    requestId: request.id,
    blockId: request.blockId,
    conversationId: request.conversationId,
    invocationId: request.invocationId,
    methodKind: request.methodKind,
    methodConfigId: request.methodConfigId,
    sourceHash: request.sourceHash,
    contentCount: request.contents.length,
    segmentCount: request.segments?.length ?? 0,
    priorSummaryCount: request.priorSummaryContents?.length ?? 0
  };
}

function errorDebugInfo(error: unknown): unknown {
  return toPlainJsonLike(error);
}

function abortReasonText(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) return undefined;
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  return String(reason);
}

function logCompressionDebug(stage: string, payload: Record<string, unknown>): void {
  const log = /throw|error|cancel|abort/i.test(stage) ? console.warn : console.info;
  log('[LimCode][Compression][Provider]', stage, payload);
}

function emitLlmStarted(emit: Emit, requestId: string, invocationId: string | undefined, model: string | undefined): void {
  emit({ type: LlmEventType.Started, payload: { requestId, ...(invocationId ? { invocationId } : {}), ...(model ? { model } : {}), startedAt: Date.now() } });
}

function emitLlmError(
  emit: Emit,
  requestId: string,
  message: string,
  rawError?: LlmRawErrorInfoRecord,
  extra: { retryAttempt?: number; retryMaxAttempts?: number; createdAt?: number; streamOutputDurationMs?: number } = {}
): void {
  emit({
    type: LlmEventType.Error,
    payload: {
      requestId,
      message,
      ...(rawError ? { rawError } : {}),
      ...(extra.retryAttempt !== undefined ? { retryAttempt: extra.retryAttempt } : {}),
      ...(extra.retryMaxAttempts !== undefined ? { retryMaxAttempts: extra.retryMaxAttempts } : {}),
      ...(extra.createdAt !== undefined ? { createdAt: extra.createdAt } : {}),
      ...(extra.streamOutputDurationMs !== undefined ? { streamOutputDurationMs: extra.streamOutputDurationMs } : {})
    }
  });
}

function emitLlmRetryScheduled(emit: Emit, requestId: string, message: string, rawError: LlmRawErrorInfoRecord | undefined, retryAttempt: number, retryMaxAttempts: number, retryDelayMs: number): void {
  emit({ type: LlmEventType.RetryScheduled, payload: { requestId, message, retryAttempt, retryMaxAttempts, retryDelayMs, createdAt: Date.now(), ...(rawError ? { rawError } : {}) } });
}

function emitLlmRetryStarted(emit: Emit, requestId: string, message: string, rawError: LlmRawErrorInfoRecord | undefined, retryAttempt: number, retryMaxAttempts: number): void {
  emit({ type: LlmEventType.RetryStarted, payload: { requestId, message, retryAttempt, retryMaxAttempts, createdAt: Date.now(), ...(rawError ? { rawError } : {}) } });
}

function emitLlmRetryCancelled(emit: Emit, requestId: string, message: string, retryAttempt: number, retryMaxAttempts: number, rawError?: LlmRawErrorInfoRecord): void {
  emit({ type: LlmEventType.RetryCancelled, payload: { requestId, message, retryAttempt, retryMaxAttempts, createdAt: Date.now(), ...(rawError ? { rawError } : {}) } });
}

function emitLlmRetryRecovered(emit: Emit, requestId: string, message: string, retryAttempt: number, retryMaxAttempts: number): void {
  emit({ type: LlmEventType.RetryRecovered, payload: { requestId, message, retryAttempt, retryMaxAttempts, createdAt: Date.now() } });
}
