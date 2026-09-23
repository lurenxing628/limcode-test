import { createHash } from 'crypto';
import WebSocket, { type RawData } from 'ws';
import { captureDebug, associateDebugCapture, debugCaptureSources } from '../reliableKernel/debugCapture/observer';
import { observeToolAssembly, type DebugWebSocketObservation } from '../reliableKernel/debugCapture/webSocketObservation';
import type {
  Content,
  LLMRequest,
  LLMStreamChunk,
  StreamDecodeState
} from 'unified-llm-provider';
import type { AssistantMessagePhase, ModelOutputItemReference } from '../../shared/protocol';
import { supportsOpenAIExplicitPromptCache } from '../../shared/openAIResponsesCapabilities';
import type {
  OpenAIResponsesNativeEvent,
  OpenAIResponsesRequiredInput,
  OpenAIResponsesSteeringCommand,
  OpenAIResponsesToolOutput
} from '../../shared/openAIResponsesNative';
import {
  OpenAIResponsesNativeDeliveryError,
  type OpenAIResponsesNativeController,
  type OpenAIResponsesNativeHooks,
  type OpenAIResponsesNativeResultAdmission
} from './openAIResponsesNativeControl';
import {
  OpenAIResponsesContinuationProjection,
  hasSemanticChunkOutput
} from './openAIResponsesContinuationProjection';
import {
  AsyncEventQueue,
  MAX_SOCKET_AGE_MS,
  NETWORK_IDENTITY_CHECK_INTERVAL_MS,
  OpenAIResponsesWebSocketCloseError,
  OpenAIResponsesWebSocketTimeoutError,
  abortError,
  canonicalHash,
  canonicalString,
  cloneJson,
  errorText,
  eventType,
  invalidateOpenAIResponsesWebSocketContinuation,
  isAbort,
  isRecord,
  nestedMessage,
  normalizedString,
  numericField,
  observeOpenAIResponsesWebSocketFailure,
  observeOpenAIResponsesWebSocketPhase,
  openSocket,
  parseWebSocketData,
  probeSocket,
  resetOpenAIResponsesWebSocketConnectionState,
  resolvedTimeouts,
  sendWithDeadline,
  shortCanonicalHash,
  startOpenAIResponsesWebSocketHeartbeat,
  structuredTransportError,
  throwIfAborted,
  webSocketConnectionConfig,
  type OpenAIResponsesWebSocketConnectionReason,
  type OpenAIResponsesWebSocketContinuationState,
  type OpenAIResponsesWebSocketPhase,
  type OpenAIResponsesWebSocketPhaseKind,
  type OpenAIResponsesWebSocketTimeoutPhase,
  type OpenAIResponsesWebSocketTimeouts
} from './openAIResponsesWebSocketConnection';
import {
  acquireOpenAIResponsesWebSocketLane,
  resetOpenAIResponsesWebSocketMultiplexer
} from './openAIResponsesWebSocketMultiplexer';
export { LIMCODE_OPENAI_RESPONSES_WS_IMPLEMENTATION } from './openAIResponsesWebSocketIdentity';
export {
  OpenAIResponsesWebSocketCloseError,
  OpenAIResponsesWebSocketTimeoutError,
  type OpenAIResponsesWebSocketPhase,
  type OpenAIResponsesWebSocketPhaseKind,
  type OpenAIResponsesWebSocketTimeoutPhase,
  type OpenAIResponsesWebSocketTimeouts
} from './openAIResponsesWebSocketConnection';

const MAX_RETAINED_SESSIONS = 32;
const IDLE_SESSION_TTL_MS = MAX_SOCKET_AGE_MS;
const MAX_SUCCESSFUL_INCREMENTAL_REQUESTS = 16;

export interface OpenAIResponsesToolCallArgumentDelta {
  callId: string;
  name?: string;
  argumentsDelta: string;
  replace?: boolean;
  streamIndex?: string;
}

export interface LimCodeOpenAIResponsesStreamChunk extends LLMStreamChunk {
  toolCallArgumentDeltas?: OpenAIResponsesToolCallArgumentDelta[];
  /** Output item owning this semantic chunk, when the Responses event identifies one. */
  outputItem?: ModelOutputItemReference;
  /** Terminal metadata update for an output item, including a late message phase. */
  outputItemDone?: ModelOutputItemReference;
  /** Marks the provider boundary between independent reasoning output items. */
  reasoningItemDone?: boolean;
  /** Exact ordered model content proven against the terminal Responses output. */
  completedContent?: Content;
  /** Native provider control observation; present only on capability-gated native streams. */
  nativeEvent?: OpenAIResponsesNativeEvent;
}

export interface OpenAIResponsesWebSocketDecision {
  sessionKeyHash: string;
  connectionGeneration: number;
  connectionReused: boolean;
  connectionReason: OpenAIResponsesWebSocketConnectionReason;
  mode: 'full' | 'incremental';
  reason: string;
  fullInputItemCount: number;
  sentInputItemCount: number;
  fullInputFingerprint: string;
  sentInputFingerprint: string;
  baselineFingerprint?: string;
  previousResponseIdUsed?: string;
  /** Multiplexed native lane carrying this request. */
  streamId?: string;
  /** Native dynamic reasoning: applied configuration_update instead of rewriting the prefix. */
  reasoningUpdateApplied?: { fromEffort: string; toEffort: string };
}

export type { OpenAIResponsesWebSocketConnectionReason } from './openAIResponsesWebSocketConnection';

export interface OpenAIResponsesFormatAdapter {
  createStreamState(): StreamDecodeState;
  decodeStreamChunk(raw: unknown, state: StreamDecodeState): LLMStreamChunk;
  encodeRequest(request: LLMRequest, stream?: boolean): unknown;
}

export interface OpenAIResponsesWebSocketStreamOptions {
  debugCapture?: DebugWebSocketObservation;
  sessionKey: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  format: OpenAIResponsesFormatAdapter;
  /** Provider-local only. Nothing in this object is placed on the WebSocket wire. */
  continuation?: {
    volatileTailContents: Content[];
    volatileTailContentKinds: Array<'current_turn_input' | 'turn_reminder'>;
    forceFullReason?: string;
  };
  /**
   * Capability-gated native Astra mode. Absence preserves the legacy exclusive-session transport
   * byte for byte; presence enables native events, controllers and optional lane multiplexing.
   */
  native?: OpenAIResponsesNativeTransportOptions;
  /** Reliable retries must never reuse the physical socket that owned the failed attempt. */
  forceNewConnection?: boolean;
  signal?: AbortSignal;
  proxy?: string;
  onDecision?: (decision: OpenAIResponsesWebSocketDecision) => void;
  onPhase?: (phase: OpenAIResponsesWebSocketPhase) => void;
  /** Transport deadlines are independently configurable for deterministic tests and slow relays. */
  timeouts?: Partial<OpenAIResponsesWebSocketTimeouts>;
}

export interface OpenAIResponsesNativeTransportOptions extends OpenAIResponsesNativeHooks {
  steering: boolean;
  reasoningUpdates: boolean;
  multiplexing: boolean;
}

interface WebSocketSession extends OpenAIResponsesWebSocketContinuationState {
  key: string;
  socket?: WebSocket;
  connectedAt?: number;
  lastPongAt?: number;
  heartbeatTimer?: NodeJS.Timeout;
  connectionIdentityHash?: string;
  connectionGeneration: number;
  responseCreateSeq: number;
  lastUsedAt: number;
  lockTail: Promise<void>;
  activeOperations: number;
}

interface PreparedCreatePayload {
  payload: Record<string, unknown>;
  fullBody: Record<string, unknown>;
  fullInputItems: unknown[];
  durableInputItems: unknown[];
  baseSignature: string;
  volatileTailLayout?: string;
  decision: OpenAIResponsesWebSocketDecision;
  /** Native mode: reasoning anchored on the wire for the committed baseline. */
  nativeAnchoredReasoning?: unknown;
  /** Native mode: effective effort after the applied configuration_update, when any. */
  nativeEffectiveEffort?: string;
}

interface LocalContinuationBoundary {
  durableInputItems: unknown[];
  volatileInputItems: unknown[];
  volatileTailLayout?: string;
  forceFullReason?: string;
}

interface SocketAdmission {
  reused: boolean;
  reason: OpenAIResponsesWebSocketConnectionReason;
}

interface ToolCallAccumulator {
  callId: string;
  name?: string;
  arguments: string;
  streamIndex?: string;
}

interface ToolCallAccumulatorRegistry {
  readonly active: Set<ToolCallAccumulator>;
  readonly byAlias: Map<string, ToolCallAccumulator>;
}

interface OutputItemRegistry {
  readonly byAlias: Map<string, ModelOutputItemReference>;
  nextOrdinal: number;
}

const sessions = new Map<string, WebSocketSession>();

/**
 * Codex-style Responses WebSocket session:
 * - continuation is tied to one physical socket generation;
 * - the baseline uses the same canonical semantic projection yielded to the reliable kernel;
 * - only response.completed commits continuation state;
 * - every uncertainty falls back to a full request.
 *
 * With `options.native` present the stream becomes a capability-gated native logical request: it
 * may span steering successors and tool-result continuations on one connection, emits native
 * control events as chunks, registers a process-local controller, and can run as a named lane on
 * the multiplexed connection pool. Without it, behavior is byte-compatible with the legacy
 * exclusive-session transport.
 */
export async function* streamOpenAIResponsesWebSocketSession(
  options: OpenAIResponsesWebSocketStreamOptions
): AsyncGenerator<LimCodeOpenAIResponsesStreamChunk> {
  if (options.native) {
    yield* streamOpenAIResponsesNativeSession(
      options as OpenAIResponsesWebSocketStreamOptions & { native: OpenAIResponsesNativeTransportOptions }
    );
    return;
  }
  const session = sessionFor(options.sessionKey);
  yield* withSessionLock(session, options, () => streamLocked(session, options));
}

export function resetOpenAIResponsesWebSocketSessions(): void {
  for (const session of sessions.values()) closeAndInvalidate(session, true);
  sessions.clear();
  resetOpenAIResponsesWebSocketMultiplexer();
  resetOpenAIResponsesWebSocketConnectionState();
}

async function* streamLocked(
  session: WebSocketSession,
  options: OpenAIResponsesWebSocketStreamOptions
): AsyncGenerator<LimCodeOpenAIResponsesStreamChunk> {
  let connection: SocketAdmission;
  try {
    throwIfAborted(options.signal);
    connection = await ensureSocket(session, options, resolvedTimeouts(options.timeouts));
  } catch (error) {
    const annotated = markReceivedSemanticOutput(error, false);
    observeTransportFailure(session, options, annotated);
    closeAndInvalidate(session, true);
    if (isAbort(options.signal, annotated)) throw abortError(options.signal);
    throw annotated;
  }
  const socket = session.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    closeAndInvalidate(session, true);
    throw new Error('OpenAI Responses WebSocket connection is unavailable.');
  }

  const fullBody = sanitizeResponsesCreateBody(options.body, preservesExplicitPromptCache(options.body));
  const prepared = prepareCreatePayload(
    session,
    { key: session.key, connectionGeneration: session.connectionGeneration },
    fullBody,
    connection,
    options.format,
    options.continuation
  );
  options.onDecision?.(prepared.decision);

  const decodeState = options.format.createStreamState();
  const continuationProjection = new OpenAIResponsesContinuationProjection();
  const toolCalls: ToolCallAccumulatorRegistry = {
    active: new Set(),
    byAlias: new Map()
  };
  const outputItems: OutputItemRegistry = { byAlias: new Map(), nextOrdinal: 0 };
  let responseId: string | undefined;
  let completedProjection: ReturnType<OpenAIResponsesContinuationProjection['completedProjection']>;
  let sawSemanticOutput = false;
  let completed = false;

  try {
    for await (const raw of sendCreateAndReadEvents(
      socket,
      prepared.payload,
      resolvedTimeouts(options.timeouts),
      options.signal,
      (phase, detail) => observeTransportPhase(session, options, phase, detail),
      requireConnectionIdentity(session),
      () => webSocketConnectionConfig(options).identityHash,
      () => {
        session.responseCreateSeq += 1;
        return session.responseCreateSeq;
      },
      options.debugCapture ? { ...options.debugCapture, metadata: {
        sessionKeyHash: prepared.decision.sessionKeyHash,
        connectionGeneration: session.connectionGeneration,
        transport: 'websocket'
      } } : undefined
    )) {
      const type = eventType(raw);
      responseId = responseIdFromPayload(raw) ?? responseId;
      const outputItem = observeOutputItem(raw, outputItems);
      const argumentDeltas = captureToolCallArgumentDeltas(raw, toolCalls, options.debugCapture);
      if (isTerminalEvent(raw)) {
        observeTransportPhase(session, options, 'terminal', { reason: type ?? 'terminal' });
      }

      if (isProviderErrorPayload(raw)) {
        closeAndInvalidate(session, true);
        yield createErrorStreamChunk(errorInfoFromPayload(raw, sawSemanticOutput));
        return;
      }

      // The session is the sole nativeEvent authority on this channel; the format decoder's
      // nativeEvent surface (SSE-only) never applies here and is excluded from the chunk type.
      let decoded: Omit<LLMStreamChunk, 'nativeEvent'>;
      try {
        captureDebug(options.debugCapture?.recorder, options.debugCapture?.context, () => ({
          stage: 'ws.decode_input', payload: raw, sources: debugCaptureSources(raw)
        }));
        decoded = options.format.decodeStreamChunk(raw, decodeState);
      } catch (error) {
        closeAndInvalidate(session, true);
        const wrapped = new Error(`OpenAI Responses WebSocket decode failed: ${errorText(error)}`);
        (wrapped as Error & { cause?: unknown }).cause = error;
        throw wrapped;
      }

      const decodedChunk: LimCodeOpenAIResponsesStreamChunk = {
        ...decoded,
        ...(outputItem.current ? { outputItem: outputItem.current } : {}),
        ...(outputItem.done ? { outputItemDone: outputItem.done } : {}),
        ...(argumentDeltas.length > 0 ? { toolCallArgumentDeltas: argumentDeltas } : {})
      };
      const projected = continuationProjection.observe(raw, decodedChunk);
      if (type === 'response.completed') {
        completedProjection = continuationProjection.completedProjection();
      }
      const projectedChunk: Omit<LLMStreamChunk, 'nativeEvent'> = projected.chunk;
      const chunk: LimCodeOpenAIResponsesStreamChunk = {
        ...projectedChunk,
        ...(outputItem.current ? { outputItem: outputItem.current } : {}),
        ...(outputItem.done ? { outputItemDone: outputItem.done } : {}),
        ...(argumentDeltas.length > 0 ? { toolCallArgumentDeltas: argumentDeltas } : {}),
        ...(type === 'response.output_item.done' && isRecord(raw.item) && raw.item.type === 'reasoning'
          ? { reasoningItemDone: true }
          : {}),
        ...(completedProjection ? { completedContent: completedProjection.content } : {})
      };
      const semanticOutput = projected.semanticOutput
        || hasSemanticChunkOutput(chunk)
        || argumentDeltas.length > 0;
      if (semanticOutput && !sawSemanticOutput) {
        observeTransportPhase(session, options, 'first_semantic_event');
      }
      if (semanticOutput) sawSemanticOutput = true;
      const observed = captureDebug(options.debugCapture?.recorder, options.debugCapture?.context, () => ({
        stage: 'ws.decoded', payload: chunk, sources: debugCaptureSources(raw)
      }));
      if (observed) associateDebugCapture(chunk, [observed]);
      if (hasMeaningfulChunk(chunk)) yield chunk;
      if (outputItem.done) unregisterOutputItem(outputItems, outputItem.done);

      if (type === 'response.completed') {
        completed = true;
        break;
      }
      if (isTerminalEvent(raw)) {
        closeAndInvalidate(session, true);
        return;
      }
    }

    if (!completed) {
      closeAndInvalidate(session, true);
      throw new Error('OpenAI Responses WebSocket closed before response.completed.');
    }

    const resolvedResponseId = responseId;
    const normalizedOutputItems = completedProjection?.outputItems.map(
      (item) => stripWebSocketOnlyInputFields(item)
    );
    const outputStateReliable = normalizedOutputItems !== undefined
      && (normalizedOutputItems.length > 0 || !sawSemanticOutput);

    session.lastUsedAt = Date.now();

    if (!resolvedResponseId || !outputStateReliable || session.socket !== socket || socket.readyState !== WebSocket.OPEN) {
      invalidateContinuation(session);
      return;
    }

    session.lastRequest = {
      body: cloneJson(prepared.fullBody),
      durableInputItems: prepared.durableInputItems.map(cloneJson),
      baseSignature: prepared.baseSignature,
      ...(prepared.volatileTailLayout ? { volatileTailLayout: prepared.volatileTailLayout } : {})
    };
    session.lastResponse = {
      responseId: resolvedResponseId,
      outputItems: normalizedOutputItems.map(cloneJson)
    };
    session.successfulIncrementalRequests = prepared.decision.mode === 'incremental'
      ? session.successfulIncrementalRequests + 1
      : 0;
  } catch (error) {
    captureDebug(options.debugCapture?.recorder, options.debugCapture?.context, () => ({
      stage: 'ws.error', payload: { message: errorText(error) }
    }));
    const annotated = markReceivedSemanticOutput(error, sawSemanticOutput);
    observeTransportFailure(session, options, annotated);
    closeAndInvalidate(session, true);
    if (isAbort(options.signal, annotated)) throw abortError(options.signal);
    throw annotated;
  } finally {
    if (!completed) closeAndInvalidate(session, true);
  }
}

async function* withSessionLock<T>(
  session: WebSocketSession,
  options: OpenAIResponsesWebSocketStreamOptions,
  operation: () => AsyncGenerator<T>
): AsyncGenerator<T> {
  const queuedAt = Date.now();
  observeTransportPhase(session, options, 'lock_wait');
  const previous = session.lockTail.catch(() => undefined);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  session.lockTail = previous.then(() => gate);

  let acquired = false;
  const onLaneQueueState = options.native?.onLaneQueueState;
  const localCapacityWait = session.activeOperations > 0;
  if (localCapacityWait) {
    try {
      onLaneQueueState?.(true);
    } catch {
      // Local wait diagnostics must never become lock authority.
    }
  }
  try {
    try {
      await waitForTurn(previous, options.signal);
    } finally {
      if (localCapacityWait) {
        try {
          onLaneQueueState?.(false);
        } catch {
          // Local wait diagnostics must never become lock authority.
        }
      }
    }
    acquired = true;
    session.activeOperations += 1;
    observeTransportPhase(session, options, 'lock_acquired', { elapsedMs: Date.now() - queuedAt });
    yield* operation();
  } catch (error) {
    if (!acquired) observeTransportFailure(session, options, error);
    throw error;
  } finally {
    if (acquired) {
      session.activeOperations = Math.max(0, session.activeOperations - 1);
      release();
    } else void previous.finally(release);
  }
}

async function waitForTurn(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await previous;
    return;
  }
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    void previous.then(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function sessionFor(key: string): WebSocketSession {
  evictIdleSessions();
  const existing = sessions.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }
  const session: WebSocketSession = {
    key,
    connectionGeneration: 0,
    responseCreateSeq: 0,
    lastUsedAt: Date.now(),
    successfulIncrementalRequests: 0,
    lockTail: Promise.resolve(),
    activeOperations: 0
  };
  sessions.set(key, session);
  evictOverflowSessions();
  return session;
}

function evictIdleSessions(now = Date.now()): void {
  for (const [key, session] of sessions) {
    if (session.activeOperations > 0) continue;
    if (now - session.lastUsedAt < IDLE_SESSION_TTL_MS) continue;
    // Heartbeats now evict dead relays proactively, so a healthy idle socket remains warm until
    // the same 55-minute age cap used by admission instead of being discarded after 15 minutes.
    closeAndInvalidate(session, true);
    sessions.delete(key);
  }
}

function observeTransportPhase(
  session: WebSocketSession,
  options: OpenAIResponsesWebSocketStreamOptions,
  phase: OpenAIResponsesWebSocketPhaseKind,
  detail: Partial<OpenAIResponsesWebSocketPhase> = {}
): void {
  observeOpenAIResponsesWebSocketPhase(session, options.onPhase, phase, detail);
}

function observeTransportFailure(
  session: WebSocketSession,
  options: OpenAIResponsesWebSocketStreamOptions,
  error: unknown
): void {
  observeOpenAIResponsesWebSocketFailure(session, options.onPhase, options.signal, error);
}

function evictOverflowSessions(): void {
  if (sessions.size <= MAX_RETAINED_SESSIONS) return;
  const candidates = [...sessions.values()]
    .filter((session) => session.activeOperations === 0)
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  for (const session of candidates.slice(0, Math.max(0, sessions.size - MAX_RETAINED_SESSIONS))) {
    closeAndInvalidate(session, true);
    sessions.delete(session.key);
  }
}

async function ensureSocket(
  session: WebSocketSession,
  options: OpenAIResponsesWebSocketStreamOptions,
  timeouts: OpenAIResponsesWebSocketTimeouts
): Promise<SocketAdmission> {
  const connection = webSocketConnectionConfig(options);
  const forceNewConnection = options.forceNewConnection === true;
  if (forceNewConnection) closeAndInvalidate(session, true);
  const socket = session.socket;
  const expired = session.connectedAt !== undefined
    && Date.now() - session.connectedAt >= MAX_SOCKET_AGE_MS;
  const identityMatches = session.connectionIdentityHash === connection.identityHash;
  let socketUnhealthy = false;
  if (socket?.readyState === WebSocket.OPEN && !expired && identityMatches) {
    const lastHealthAt = session.lastPongAt ?? session.connectedAt ?? 0;
    if (Date.now() - lastHealthAt >= timeouts.preSendProbeStaleMs) {
      const startedAt = Date.now();
      observeTransportPhase(session, options, 'socket_probe_started');
      try {
        await probeSocket(socket, timeouts.preSendProbeTimeoutMs, options.signal);
        session.lastPongAt = Date.now();
        observeTransportPhase(session, options, 'socket_probe_succeeded', {
          elapsedMs: Date.now() - startedAt
        });
      } catch (error) {
        if (isAbort(options.signal, error)) throw error;
        socketUnhealthy = true;
        closeAndInvalidate(session, true);
      }
    }
    if (!socketUnhealthy && session.socket === socket && socket.readyState === WebSocket.OPEN) {
      const admission = { reused: true, reason: 'reused' } as const;
      observeTransportPhase(session, options, 'socket_reused', {
        connectionReused: true,
        connectionReason: admission.reason
      });
      return admission;
    }
  }

  const reason: SocketAdmission['reason'] = forceNewConnection
    ? 'retry_forced_reconnect'
    : socketUnhealthy
      ? 'socket_unhealthy'
      : socket?.readyState === WebSocket.OPEN && !identityMatches
        ? 'handshake_identity_changed'
        : expired
          ? 'socket_expired'
          : 'new_connection';

  // previous_response_id is connection-local. Any physical reconnect starts a new chain.
  observeTransportPhase(session, options, 'socket_opening', {
    connectionGeneration: session.connectionGeneration + 1,
    connectionReused: false,
    connectionReason: reason
  });
  closeAndInvalidate(session, true);
  session.socket = await openSocket(
    connection,
    timeouts.handshakeMs,
    options.signal
  );
  session.connectedAt = Date.now();
  session.connectionIdentityHash = connection.identityHash;
  session.connectionGeneration += 1;
  session.responseCreateSeq = 0;
  session.lastUsedAt = Date.now();
  const ownedSocket = session.socket;
  startOpenAIResponsesWebSocketHeartbeat(session, ownedSocket, timeouts, () => {
    if (session.socket !== ownedSocket) return;
    closeAndInvalidate(session, true);
  });
  observeTransportPhase(session, options, 'socket_opened', {
    connectionReused: false,
    connectionReason: reason
  });
  return { reused: false, reason };
}

function requireConnectionIdentity(session: WebSocketSession): string {
  if (!session.connectionIdentityHash) throw new Error('OpenAI Responses WebSocket connection identity is missing.');
  return session.connectionIdentityHash;
}

function prepareCreatePayload(
  continuation: OpenAIResponsesWebSocketContinuationState,
  identity: { key: string; connectionGeneration: number },
  fullBody: Record<string, unknown>,
  connection: SocketAdmission,
  format: OpenAIResponsesFormatAdapter,
  continuationHint: OpenAIResponsesWebSocketStreamOptions['continuation'],
  native?: OpenAIResponsesNativeTransportOptions,
  streamId?: string
): PreparedCreatePayload {
  const connectionReused = connection.reused;
  const fullInputItems = Array.isArray(fullBody.input) ? fullBody.input.map(cloneJson) : [];
  const boundary = localContinuationBoundary(
    fullInputItems,
    format,
    continuationHint,
    native !== undefined || preservesExplicitPromptCache(fullBody)
  );
  // Native dynamic reasoning keeps request-level reasoning out of the baseline signature so a pure
  // effort change can ride a configuration_update instead of rewriting the cached prefix.
  const signatureBase = requestBase(fullBody);
  if (native?.reasoningUpdates) delete signatureBase.reasoning;
  const baseSignature = canonicalHash(signatureBase);
  const baseline = continuation.lastRequest && continuation.lastResponse
    ? [...continuation.lastRequest.durableInputItems, ...continuation.lastResponse.outputItems]
    : undefined;

  let reason = 'no_completed_baseline';
  let canIncrement = false;
  if (!connectionReused) reason = 'new_socket_generation';
  else if (!continuation.lastRequest || !continuation.lastResponse || !baseline) reason = 'no_completed_baseline';
  else if (boundary.forceFullReason) reason = boundary.forceFullReason;
  else if (continuation.lastRequest.baseSignature !== baseSignature) reason = 'request_properties_changed';
  else if (continuation.lastRequest.volatileTailLayout !== boundary.volatileTailLayout) {
    reason = 'volatile_tail_layout_changed';
  } else if (continuation.successfulIncrementalRequests >= MAX_SUCCESSFUL_INCREMENTAL_REQUESTS) {
    reason = 'periodic_rebase';
  } else {
    const mismatch = prefixMismatchReason(boundary.durableInputItems, baseline);
    if (mismatch) reason = mismatch;
    else if (
      boundary.durableInputItems.length === baseline.length
      && boundary.volatileInputItems.length === 0
    ) reason = 'no_strict_input_suffix';
    else {
      reason = 'matched_exact_prefix';
      canIncrement = true;
    }
  }

  // Native dynamic reasoning: only a pure effort change on an otherwise compatible continuation
  // rides a configuration_update; any other reasoning shape change rebases with a full request.
  let reasoningUpdate: { fromEffort: string; toEffort: string } | undefined;
  if (canIncrement && native?.reasoningUpdates && continuation.lastRequest) {
    const anchored = continuation.lastRequest.nativeAnchoredReasoning;
    const caller = fullBody.reasoning;
    const anchoredEffort = continuation.lastRequest.nativeEffectiveEffort
      ?? reasoningEffortOf(anchored);
    const callerEffort = reasoningEffortOf(caller);
    const shapeMatches = canonicalString(reasoningWithoutEffort(anchored) ?? null)
      === canonicalString(reasoningWithoutEffort(caller) ?? null);
    if (!shapeMatches) {
      canIncrement = false;
      reason = 'reasoning_shape_changed';
    } else if (
      anchoredEffort !== undefined
      && callerEffort !== undefined
      && anchoredEffort !== callerEffort
    ) {
      reasoningUpdate = { fromEffort: anchoredEffort, toEffort: callerEffort };
    }
  }

  const sentInput = canIncrement && baseline
    ? [
        ...boundary.durableInputItems.slice(baseline.length),
        ...boundary.volatileInputItems
      ]
    : fullInputItems;
  if (reasoningUpdate) {
    sentInput.unshift({ type: 'configuration_update', reasoning: { effort: reasoningUpdate.toEffort } });
  }
  const payload: Record<string, unknown> = {
    type: 'response.create',
    ...fullBody,
    input: sentInput,
    store: false,
    ...(canIncrement && continuation.lastResponse
      ? { previous_response_id: continuation.lastResponse.responseId }
      : {}),
    ...(streamId ? { stream_id: streamId } : {})
  };
  if (canIncrement && native?.reasoningUpdates && continuation.lastRequest) {
    // Keep the request-level reasoning anchored at the prefix's original value for the whole
    // chain; an appended configuration_update (when present) selects the effective effort.
    const anchored = continuation.lastRequest.nativeAnchoredReasoning;
    if (anchored !== undefined) payload.reasoning = cloneJson(anchored);
    else delete payload.reasoning;
  }
  const nativeAnchoredReasoning = canIncrement
    ? continuation.lastRequest?.nativeAnchoredReasoning
    : cloneJson(fullBody.reasoning);
  const nativeEffectiveEffort = reasoningUpdate?.toEffort
    ?? (canIncrement
      ? continuation.lastRequest?.nativeEffectiveEffort
        ?? reasoningEffortOf(continuation.lastRequest?.nativeAnchoredReasoning)
      : reasoningEffortOf(fullBody.reasoning));
  return {
    payload,
    fullBody,
    fullInputItems,
    durableInputItems: boundary.durableInputItems,
    baseSignature,
    ...(boundary.volatileTailLayout ? { volatileTailLayout: boundary.volatileTailLayout } : {}),
    ...(native
      ? {
          ...(nativeAnchoredReasoning !== undefined
            ? { nativeAnchoredReasoning: cloneJson(nativeAnchoredReasoning) }
            : {}),
          ...(nativeEffectiveEffort !== undefined ? { nativeEffectiveEffort } : {})
        }
      : {}),
    decision: {
      sessionKeyHash: createHash('sha256').update(identity.key).digest('hex').slice(0, 12),
      connectionGeneration: identity.connectionGeneration,
      connectionReused,
      connectionReason: connection.reason,
      mode: canIncrement ? 'incremental' : 'full',
      reason,
      fullInputItemCount: fullInputItems.length,
      sentInputItemCount: sentInput.length,
      fullInputFingerprint: shortCanonicalHash(fullInputItems),
      sentInputFingerprint: shortCanonicalHash(sentInput),
      ...(baseline ? { baselineFingerprint: shortCanonicalHash(baseline) } : {}),
      ...(canIncrement && continuation.lastResponse
        ? { previousResponseIdUsed: continuation.lastResponse.responseId }
        : {}),
      ...(streamId ? { streamId } : {}),
      ...(reasoningUpdate ? { reasoningUpdateApplied: reasoningUpdate } : {})
    }
  };
}

function reasoningEffortOf(reasoning: unknown): string | undefined {
  return isRecord(reasoning) ? normalizedString(reasoning.effort) : undefined;
}

function reasoningWithoutEffort(reasoning: unknown): unknown {
  if (!isRecord(reasoning)) return reasoning;
  const { effort: _effort, ...rest } = reasoning;
  return rest;
}

function localContinuationBoundary(
  fullInputItems: unknown[],
  format: OpenAIResponsesFormatAdapter,
  continuation: OpenAIResponsesWebSocketStreamOptions['continuation'],
  native = false
): LocalContinuationBoundary {
  if (!continuation) {
    return {
      durableInputItems: fullInputItems,
      volatileInputItems: []
    };
  }
  const volatileTailLayout = `managed:${continuation.volatileTailContentKinds.join(',')}`;
  if (continuation.forceFullReason) {
    return {
      durableInputItems: fullInputItems,
      volatileInputItems: [],
      volatileTailLayout,
      forceFullReason: continuation.forceFullReason
    };
  }
  if (continuation.volatileTailContents.length !== continuation.volatileTailContentKinds.length) {
    return {
      durableInputItems: fullInputItems,
      volatileInputItems: [],
      volatileTailLayout,
      forceFullReason: 'invalid_volatile_tail_boundary'
    };
  }
  if (continuation.volatileTailContents.length === 0) {
    return {
      durableInputItems: fullInputItems,
      volatileInputItems: [],
      volatileTailLayout
    };
  }

  let encoded: unknown;
  try {
    encoded = format.encodeRequest({ contents: continuation.volatileTailContents }, false);
  } catch {
    return {
      durableInputItems: fullInputItems,
      volatileInputItems: [],
      volatileTailLayout,
      forceFullReason: 'volatile_tail_encode_failed'
    };
  }
  if (!isRecord(encoded) || !Array.isArray(encoded.input) || encoded.input.length === 0) {
    return {
      durableInputItems: fullInputItems,
      volatileInputItems: [],
      volatileTailLayout,
      forceFullReason: 'volatile_tail_encode_failed'
    };
  }
  const volatileInputItems = encoded.input.map((item) => stripWebSocketOnlyInputFields(item, native));
  const offset = fullInputItems.length - volatileInputItems.length;
  if (offset < 0) {
    return {
      durableInputItems: fullInputItems,
      volatileInputItems: [],
      volatileTailLayout,
      forceFullReason: 'volatile_tail_boundary_mismatch'
    };
  }
  for (let index = 0; index < volatileInputItems.length; index += 1) {
    if (canonicalString(fullInputItems[offset + index]) === canonicalString(volatileInputItems[index])) continue;
    return {
      durableInputItems: fullInputItems,
      volatileInputItems: [],
      volatileTailLayout,
      forceFullReason: 'volatile_tail_boundary_mismatch'
    };
  }
  return {
    durableInputItems: fullInputItems.slice(0, offset),
    volatileInputItems,
    volatileTailLayout
  };
}

/**
 * Explicit prompt caching (`prompt_cache_options` and content `prompt_cache_breakpoint`) is documented
 * for GPT-5.6 and later (https://developers.openai.com/api/docs/guides/prompt-caching#summary-of-model-differences),
 * and the WebSocket mode guide places no model restriction on request fields. Those exact official ids keep
 * the fields on every WebSocket path; any other model keeps the historical strip behavior unchanged.
 */
function preservesExplicitPromptCache(body: unknown): boolean {
  return isRecord(body) && typeof body.model === 'string' && supportsOpenAIExplicitPromptCache(body.model);
}

function sanitizeResponsesCreateBody(value: unknown, native = false): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('OpenAI Responses WebSocket body must be a JSON object.');
  const next = cloneJson(value);
  delete next.type;
  delete next.stream;
  delete next.background;
  delete next.previous_response_id;
  // Explicit prompt caching is retained on native GPT-6 channels and for models that support it
  // (see preservesExplicitPromptCache); other models keep the historical strip behavior unchanged.
  if (!native) delete next.prompt_cache_options;
  next.store = false;
  next.input = Array.isArray(next.input) ? next.input.map((item) => stripWebSocketOnlyInputFields(item, native)) : [];
  return next;
}

function stripWebSocketOnlyInputFields(value: unknown, native = false): unknown {
  if (Array.isArray(value)) return value.map((item) => stripWebSocketOnlyInputFields(item, native));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'prompt_cache_breakpoint' && !native) continue;
    result[key] = stripWebSocketOnlyInputFields(child, native);
  }
  return result;
}

function requestBase(body: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === 'input' || key === 'previous_response_id' || key === 'stream'
      || key === 'background' || key === 'type') continue;
    result[key] = value;
  }
  return result;
}

function prefixMismatchReason(items: unknown[], prefix: unknown[]): string | undefined {
  if (prefix.length > items.length) return `cached_prefix_longer:${prefix.length}>${items.length}`;
  for (let index = 0; index < prefix.length; index += 1) {
    if (canonicalString(items[index]) !== canonicalString(prefix[index])) {
      return `input_prefix_mismatch_at:${index}`;
    }
  }
  return undefined;
}

async function* sendCreateAndReadEvents(
  socket: WebSocket,
  payload: Record<string, unknown>,
  timeouts: OpenAIResponsesWebSocketTimeouts,
  signal: AbortSignal | undefined,
  observe: ((
    phase: OpenAIResponsesWebSocketPhaseKind,
    detail?: Partial<OpenAIResponsesWebSocketPhase>
  ) => void) | undefined,
  expectedConnectionIdentityHash: string,
  currentConnectionIdentityHash: () => string,
  nextResponseCreateSeq: () => number,
  debug?: DebugWebSocketObservation
): AsyncGenerator<Record<string, unknown>> {
  const queue = new AsyncEventQueue<Record<string, unknown>>();
  let sawTerminal = false;
  let sawEvent = false;
  let rawSequence = 0;
  let sentSequence = 0;
  let firstEventTimeout: ReturnType<typeof setTimeout> | undefined;
  let eventIdleTimeout: ReturnType<typeof setTimeout> | undefined;
  let responseTimeout: ReturnType<typeof setTimeout> | undefined;
  let networkIdentityTimer: ReturnType<typeof setInterval> | undefined;
  const clearResponseTimeouts = () => {
    if (firstEventTimeout !== undefined) clearTimeout(firstEventTimeout);
    if (eventIdleTimeout !== undefined) clearTimeout(eventIdleTimeout);
    if (responseTimeout !== undefined) clearTimeout(responseTimeout);
    if (networkIdentityTimer !== undefined) clearInterval(networkIdentityTimer);
    firstEventTimeout = undefined;
    eventIdleTimeout = undefined;
    responseTimeout = undefined;
    networkIdentityTimer = undefined;
  };
  const failAfter = (phase: OpenAIResponsesWebSocketTimeoutPhase, timeoutMs: number) => {
    queue.fail(new OpenAIResponsesWebSocketTimeoutError(phase, timeoutMs, sawEvent));
  };
  const armEventIdleTimeout = () => {
    if (eventIdleTimeout !== undefined) clearTimeout(eventIdleTimeout);
    eventIdleTimeout = setTimeout(() => failAfter('event_idle', timeouts.eventIdleMs), timeouts.eventIdleMs);
  };
  const cleanup = () => {
    clearResponseTimeouts();
    signal?.removeEventListener('abort', onAbort);
    socket.off('message', onMessage);
    socket.off('error', onError);
    socket.off('close', onClose);
  };
  const onAbort = () => queue.fail(abortError(signal));
  const onMessage = (data: RawData) => {
    rawSequence += 1;
    const received = captureDebug(debug?.recorder, debug?.context, () => ({
      stage: 'transport.receive', bytes: data,
      metadata: { ...debug?.metadata, rawSequence, responseCreateSeq: sentSequence }
    }));
    const parsed = parseWebSocketData(data);
    if (!parsed.ok) {
      captureDebug(debug?.recorder, debug?.context, () => ({ stage: 'ws.parse_error',
        payload: { message: parsed.error.message }, sources: received ? [received] : [] }));
      queue.fail(parsed.error);
      return;
    }
    const value = parsed.value;
    if (received) associateDebugCapture(value, [received]);
    if (!sawEvent) {
      sawEvent = true;
      observe?.('first_raw_event');
      if (firstEventTimeout !== undefined) clearTimeout(firstEventTimeout);
      firstEventTimeout = undefined;
    }
    armEventIdleTimeout();
    queue.push(value);
    if (isTerminalEvent(value)) {
      sawTerminal = true;
      clearResponseTimeouts();
      queue.end();
    }
  };
  const onError = (error: Error) => {
    const wrapped = structuredTransportError(
      error.message || 'OpenAI Responses WebSocket transport error.',
      typeof (error as Error & { code?: unknown }).code === 'string'
        ? (error as Error & { code: string }).code
        : 'websocket_error',
      sawEvent ? 'streaming' : 'awaiting_first_event',
      sawEvent
    );
    (wrapped as Error & { cause?: unknown }).cause = error;
    queue.fail(wrapped);
  };
  const onClose = (code: number, reason: Buffer) => {
    if (sawTerminal) queue.end();
    else queue.fail(new OpenAIResponsesWebSocketCloseError(
      code,
      reason.toString('utf8').trim(),
      sawEvent ? 'streaming' : 'awaiting_first_event',
      sawEvent
    ));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  socket.on('message', onMessage);
  socket.once('error', onError);
  socket.once('close', onClose);

  try {
    throwIfAborted(signal);
    firstEventTimeout = setTimeout(
      () => failAfter('first_event', timeouts.firstEventMs),
      timeouts.firstEventMs
    );
    responseTimeout = setTimeout(
      () => failAfter('response', timeouts.responseMs),
      timeouts.responseMs
    );
    networkIdentityTimer = setInterval(() => {
      if (sawTerminal) return;
      try {
        if (currentConnectionIdentityHash() !== expectedConnectionIdentityHash) {
          queue.fail(structuredTransportError(
            'OpenAI Responses WebSocket local network changed.',
            'network_changed',
            sawEvent ? 'streaming' : 'awaiting_first_event',
            sawEvent
          ));
        }
      } catch {
        // A transient failure to enumerate interfaces is not itself network authority.
      }
    }, NETWORK_IDENTITY_CHECK_INTERVAL_MS);
    const payloadText = JSON.stringify(payload);
    const responseCreateFrameSha256 = createHash('sha256').update(payloadText, 'utf8').digest('hex');
    const responseCreateFrameBytes = Buffer.byteLength(payloadText, 'utf8');
    const responseCreateSeq = nextResponseCreateSeq();
    sentSequence = responseCreateSeq;
    captureDebug(debug?.recorder, debug?.context, () => ({ stage: 'transport.send', payload: payloadText,
      metadata: { ...debug?.metadata, responseCreateSeq } }));
    observe?.('send_started');
    await sendWithDeadline(socket, payloadText, timeouts.sendMs, signal);
    observe?.('request_sent', {
      responseCreateFrameSha256,
      responseCreateFrameBytes,
      responseCreateSeq
    });
    yield* queue;
  } finally {
    cleanup();
  }
}

function observeOutputItem(
  raw: Record<string, unknown>,
  registry: OutputItemRegistry,
  ordinalBase = 0
): { current?: ModelOutputItemReference; done?: ModelOutputItemReference } {
  const type = eventType(raw);
  const item = isRecord(raw.item) ? raw.item : undefined;
  const aliases = outputItemAliases(item, raw, ordinalBase);
  if (aliases.length === 0) return {};
  const matches = [...new Set(aliases
    .map((alias) => registry.byAlias.get(alias))
    .filter((value): value is ModelOutputItemReference => !!value))];
  if (matches.length > 1) return {};

  const existing = matches[0];
  const wireOrdinal = typeof raw.output_index === 'number'
    && Number.isSafeInteger(raw.output_index)
    && raw.output_index >= 0
      ? ordinalBase + raw.output_index
      : undefined;
  const ordinal = existing?.ordinal ?? wireOrdinal ?? registry.nextOrdinal;
  registry.nextOrdinal = Math.max(registry.nextOrdinal, ordinal + 1);
  const wireId = (item ? normalizedString(item.id) : undefined) ?? normalizedString(raw.item_id);
  const phase = assistantMessagePhase(item?.phase) ?? assistantMessagePhase(raw.phase) ?? existing?.phase;
  const reference: ModelOutputItemReference = {
    id: existing?.id ?? wireId ?? `output:${ordinal}`,
    ordinal,
    ...(phase ? { phase } : {})
  };
  for (const alias of [...aliases, `reference:${reference.id}`]) registry.byAlias.set(alias, reference);
  if (existing && existing !== reference) {
    for (const [alias, value] of registry.byAlias) {
      if (value === existing) registry.byAlias.set(alias, reference);
    }
  }
  return type === 'response.output_item.done'
    ? { current: reference, done: reference }
    : { current: reference };
}

function unregisterOutputItem(registry: OutputItemRegistry, reference: ModelOutputItemReference): void {
  for (const [alias, value] of registry.byAlias) {
    if (value === reference || value.id === reference.id) registry.byAlias.delete(alias);
  }
}

function outputItemAliases(
  item: Record<string, unknown> | undefined,
  event: Record<string, unknown>,
  ordinalBase = 0
): string[] {
  const itemId = (item ? normalizedString(item.id) : undefined) ?? normalizedString(event.item_id);
  const outputIndex = typeof event.output_index === 'number'
    && Number.isSafeInteger(event.output_index)
    && event.output_index >= 0
      ? event.output_index
      : undefined;
  return [
    ...(itemId ? [`item:${itemId}`] : []),
    ...(outputIndex !== undefined ? [`output:${ordinalBase + outputIndex}`] : [])
  ];
}

function assistantMessagePhase(value: unknown): AssistantMessagePhase | undefined {
  return value === 'commentary' || value === 'final_answer' ? value : undefined;
}

function captureToolCallArgumentDeltas(
  raw: Record<string, unknown>,
  registry: ToolCallAccumulatorRegistry,
  debug?: DebugWebSocketObservation,
  ordinalBase = 0
): OpenAIResponsesToolCallArgumentDelta[] {
  const type = eventType(raw);
  if (type === 'response.output_item.added' && isRecord(raw.item)
    && raw.item.type === 'function_call') {
    const accumulator = toolAccumulatorFromItem(raw.item, raw, ordinalBase);
    if (!accumulator) return [];
    registerToolAccumulator(registry, accumulator, raw.item, raw, ordinalBase);
    observeToolAssembly(debug, raw, accumulator, '', accumulator.arguments, 'append', 'registered_item');
    return accumulator.arguments
      ? [{
          callId: accumulator.callId,
          ...(accumulator.name ? { name: accumulator.name } : {}),
          argumentsDelta: accumulator.arguments,
          ...(accumulator.streamIndex ? { streamIndex: accumulator.streamIndex } : {})
        }]
      : [];
  }

  if (type === 'response.function_call_arguments.delta') {
    let selection = 'unmatched';
    const accumulator = findToolAccumulator(raw, registry, debug?.recorder.active(debug.context) ? (reason) => { selection = reason; } : undefined, ordinalBase);
    const delta = typeof raw.delta === 'string' ? raw.delta : '';
    if (!accumulator || !delta) {
      observeToolAssembly(debug, raw, accumulator, accumulator?.arguments ?? '', delta, 'rejected', selection);
      return [];
    }
    const before = accumulator.arguments;
    accumulator.arguments += delta;
    observeToolAssembly(debug, raw, accumulator, before, delta, 'append', selection);
    return [{
      callId: accumulator.callId,
      ...(accumulator.name ? { name: accumulator.name } : {}),
      argumentsDelta: delta,
      ...(accumulator.streamIndex ? { streamIndex: accumulator.streamIndex } : {})
    }];
  }

  if ((type === 'response.function_call_arguments.done'
      || type === 'response.output_item.done')
    && (type !== 'response.output_item.done'
      || (isRecord(raw.item) && raw.item.type === 'function_call'))) {
    const source = type === 'response.output_item.done' && isRecord(raw.item) ? raw.item : raw;
    let selection = 'unmatched';
    const registered = findToolAccumulator(raw, registry, debug?.recorder.active(debug.context) ? (reason) => { selection = reason; } : undefined, ordinalBase);
    const accumulator = registered
      ?? (isRecord(source) ? toolAccumulatorFromItem(source, raw, ordinalBase) : undefined);
    const finalArguments = isRecord(source) ? normalizedString(source.arguments) : undefined;
    let deltas: OpenAIResponsesToolCallArgumentDelta[] = [];
    const before = accumulator?.arguments ?? '';
    if (accumulator && finalArguments !== undefined && finalArguments !== accumulator.arguments) {
      if (finalArguments.startsWith(accumulator.arguments)) {
        const suffix = finalArguments.slice(accumulator.arguments.length);
        accumulator.arguments = finalArguments;
        if (suffix) {
          deltas = [{
            callId: accumulator.callId,
            ...(accumulator.name ? { name: accumulator.name } : {}),
            argumentsDelta: suffix,
            ...(accumulator.streamIndex ? { streamIndex: accumulator.streamIndex } : {})
          }];
        }
      } else {
        accumulator.arguments = finalArguments;
        deltas = [{
          callId: accumulator.callId,
          ...(accumulator.name ? { name: accumulator.name } : {}),
          argumentsDelta: finalArguments,
          replace: true,
          ...(accumulator.streamIndex ? { streamIndex: accumulator.streamIndex } : {})
        }];
      }
    }
    for (const delta of deltas) observeToolAssembly(debug, raw, accumulator, before, delta.argumentsDelta, delta.replace ? 'replace' : 'append', selection);
    observeToolAssembly(debug, raw, accumulator, accumulator?.arguments ?? '', '', 'complete', selection);
    if (registered) unregisterToolAccumulator(registry, registered);
    return deltas;
  }
  return [];
}

function toolAccumulatorFromItem(
  item: Record<string, unknown>,
  event: Record<string, unknown>,
  ordinalBase = 0
): ToolCallAccumulator | undefined {
  const callId = normalizedString(item.call_id) ?? normalizedString(event.call_id);
  if (!callId) return undefined;
  return {
    callId,
    ...(normalizedString(item.name) ? { name: normalizedString(item.name) } : {}),
    arguments: normalizedString(item.arguments) ?? '',
    ...(streamIndex(item, event, ordinalBase) ? { streamIndex: streamIndex(item, event, ordinalBase) } : {})
  };
}

function findToolAccumulator(
  event: Record<string, unknown>,
  registry: ToolCallAccumulatorRegistry,
  selected?: (reason: string) => void,
  ordinalBase = 0
): ToolCallAccumulator | undefined {
  const item = isRecord(event.item) ? event.item : undefined;
  const matches = [...new Set(toolAccumulatorAliases(item, event, undefined, ordinalBase)
    .map((key) => registry.byAlias.get(key))
    .filter((value): value is ToolCallAccumulator => !!value))];
  if (matches.length === 1) { selected?.('alias'); return matches[0]; }
  if (matches.length > 1) { selected?.('ambiguous_alias'); return undefined; }

  const callId = normalizedString(event.call_id) ?? (item ? normalizedString(item.call_id) : undefined);
  if (callId) {
    const callMatches = [...registry.active].filter((value) => value.callId === callId);
    if (callMatches.length === 1) { selected?.('call_id'); return callMatches[0]; }
    if (callMatches.length > 1) { selected?.('ambiguous_call_id'); return undefined; }
  }
  selected?.(registry.active.size === 1 ? 'single_active_fallback' : 'unmatched');
  return registry.active.size === 1 ? registry.active.values().next().value : undefined;
}

function registerToolAccumulator(
  registry: ToolCallAccumulatorRegistry,
  accumulator: ToolCallAccumulator,
  item: Record<string, unknown>,
  event: Record<string, unknown>,
  ordinalBase = 0
): void {
  registry.active.add(accumulator);
  for (const alias of toolAccumulatorAliases(item, event, accumulator.callId, ordinalBase)) {
    registry.byAlias.set(alias, accumulator);
  }
}

function unregisterToolAccumulator(
  registry: ToolCallAccumulatorRegistry,
  accumulator: ToolCallAccumulator
): void {
  registry.active.delete(accumulator);
  for (const [alias, registered] of registry.byAlias) {
    if (registered === accumulator) registry.byAlias.delete(alias);
  }
}

function toolAccumulatorAliases(
  item: Record<string, unknown> | undefined,
  event: Record<string, unknown>,
  fallbackCallId?: string,
  ordinalBase = 0
): string[] {
  const itemId = (item ? normalizedString(item.id) : undefined) ?? normalizedString(event.item_id);
  const callId = normalizedString(event.call_id)
    ?? (item ? normalizedString(item.call_id) : undefined)
    ?? fallbackCallId;
  const outputIndex = typeof event.output_index === 'number' ? event.output_index : undefined;
  return [
    ...(itemId ? [`item:${itemId}`] : []),
    ...(outputIndex !== undefined ? [`output:${ordinalBase + outputIndex}`] : []),
    ...(callId ? [`call:${callId}`] : [])
  ];
}

function streamIndex(
  item: Record<string, unknown>,
  event: Record<string, unknown>,
  ordinalBase = 0
): string | undefined {
  return normalizedString(item.id)
    ?? normalizedString(event.item_id)
    ?? (typeof event.output_index === 'number' ? `output:${ordinalBase + event.output_index}` : undefined);
}

function responseIdFromPayload(raw: Record<string, unknown>): string | undefined {
  return normalizedString(raw.response_id)
    ?? (isRecord(raw.response) ? normalizedString(raw.response.id) : undefined)
    ?? (eventType(raw) === 'response.created' ? normalizedString(raw.id) : undefined);
}

function isTerminalEvent(value: Record<string, unknown>): boolean {
  const type = eventType(value);
  return type === 'response.completed'
    || type === 'response.failed'
    || type === 'response.incomplete'
    || type === 'response.cancelled'
    || type === 'error'
    || type.endsWith('.failed')
    || type.endsWith('.incomplete');
}

function isProviderErrorPayload(value: Record<string, unknown>): boolean {
  const type = eventType(value);
  if (type === 'response.cancelled' || type === 'error' || type.includes('error') || type.includes('failed') || type.includes('incomplete')) return true;
  if (value.error !== undefined && value.error !== null) return true;
  const response = value.response;
  if (!isRecord(response)) return false;
  const status = normalizedString(response.status)?.toLowerCase();
  return status === 'failed' || status === 'incomplete' || status === 'cancelled';
}

function errorInfoFromPayload(
  payload: Record<string, unknown>,
  receivedSemanticOutput: boolean
): Record<string, unknown> {
  const status = numericField(payload.status)
    ?? numericField(payload.status_code)
    ?? (isRecord(payload.response) ? numericField(payload.response.status_code) : undefined);
  const errorRecord = isRecord(payload.error)
    ? payload.error
    : isRecord(payload.response) && isRecord(payload.response.error)
      ? payload.response.error
      : undefined;
  const code = normalizedString(errorRecord?.code) ?? normalizedString(payload.code);
  const retryable = providerErrorRetryable(code, status);
  return {
    kind: 'stream_error',
    rawChunk: cloneJson(payload),
    event: eventType(payload) || undefined,
    ...(code ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    transportAttemptsExhausted: false,
    receivedServerEvent: true,
    receivedSemanticOutput,
    ...(payload.headers && isRecord(payload.headers) ? { headers: cloneJson(payload.headers) } : {}),
    ...(nestedMessage(payload)
      ? { message: nestedMessage(payload) }
      : { message: `OpenAI Responses WebSocket received ${eventType(payload) || 'a terminal error'} before response.completed.` }),
    rawBody: cloneJson(payload)
  };
}

function markReceivedSemanticOutput(error: unknown, receivedSemanticOutput: boolean): unknown {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return error;
  try {
    (error as { receivedSemanticOutput?: boolean }).receivedSemanticOutput = receivedSemanticOutput;
  } catch {
    // Best-effort diagnostic metadata; the adapter also fences replay from emitted semantic output.
  }
  return error;
}

function providerErrorRetryable(code: string | undefined, status: number | undefined): boolean | undefined {
  if (code && [
    'invalid_api_key',
    'authentication_error',
    'permission_denied',
    'invalid_request_error',
    'context_length_exceeded',
    'insufficient_quota',
    'billing_hard_limit_reached'
  ].includes(code)) return false;
  if (code && [
    'previous_response_not_found',
    'websocket_connection_limit_reached',
    'rate_limit_exceeded',
    'server_error',
    'internal_error',
    'service_unavailable',
    'timeout'
  ].includes(code)) return true;
  if (status === 408 || status === 425 || status === 429 || (status !== undefined && status >= 500)) return true;
  if (status !== undefined && status >= 400 && status < 500) return false;
  return undefined;
}

function createErrorStreamChunk(error: Record<string, unknown>): LimCodeOpenAIResponsesStreamChunk {
  return {
    error: error as never,
    rawChunk: error.rawChunk ?? error.rawBody ?? error.message
  };
}

function hasMeaningfulChunk(chunk: LimCodeOpenAIResponsesStreamChunk): boolean {
  return !!chunk.textDelta
    || (chunk.partsDelta?.length ?? 0) > 0
    || (chunk.functionCalls?.length ?? 0) > 0
    || (chunk.toolCallArgumentDeltas?.length ?? 0) > 0
    || !!chunk.finishReason
    || !!chunk.usageMetadata
    || !!chunk.error
    || !!chunk.thoughtSignature
    || !!chunk.thoughtSignatures
    || chunk.reasoningItemDone === true
    || !!chunk.outputItemDone
    || !!chunk.completedContent
    || !!chunk.nativeEvent;
}

function closeAndInvalidate(session: WebSocketSession, terminate: boolean): void {
  const socket = session.socket;
  session.socket = undefined;
  session.connectedAt = undefined;
  session.lastPongAt = undefined;
  session.responseCreateSeq = 0;
  if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
  session.heartbeatTimer = undefined;
  session.connectionIdentityHash = undefined;
  invalidateContinuation(session);
  if (!socket) return;
  try {
    if (terminate) socket.terminate();
    else socket.close();
  } catch { /* noop */ }
}

function invalidateContinuation(session: WebSocketSession): void {
  invalidateOpenAIResponsesWebSocketContinuation(session);
}


// ---------------------------------------------------------------------------
// Native capability-gated persistent response sessions
// ---------------------------------------------------------------------------

/**
 * One logical native request may span several physical Responses on one connection: an automatic
 * steering successor, a required tool-input continuation, or continuations delivering async tool
 * results. The chain below keeps the stream open across those boundaries while preserving
 * per-response decode state and chain-unique output/tool identities. Non-native streams never
 * reach this section.
 */

interface NativeChainLease {
  readonly connectionGeneration: number;
  readonly streamId: string | undefined;
  readonly continuation: OpenAIResponsesWebSocketContinuationState;
  readonly connectionReused: boolean;
  readonly connectionReason: OpenAIResponsesWebSocketConnectionReason;
  sendFrame(
    frame: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ responseCreateSeq?: number }>;
  events(): AsyncIterable<Record<string, unknown>>;
  healthy(): boolean;
  /**
   * Active-response capacity, separate from lane ownership: held while a response may run for
   * this lease, released during proven client-input waits, reacquired before a create/steer that
   * can start a response. Idempotent; the exclusive session implements both as no-ops.
   */
  acquirePermit(signal?: AbortSignal): Promise<void>;
  releasePermit(): void;
  release(outcome: 'quiescent' | 'error' | 'abort', staleCreatesExpected: number): void;
}

interface NativePendingSteer {
  submissionId: string;
  input: OpenAIResponsesSteeringCommand['input'];
  wireInput: unknown[];
  targetResponseId: string;
  steerId?: string;
  state: 'queued' | 'sent' | 'accepted' | 'waiting_for_input' | 'continuing' | 'failed';
  resolve: () => void;
  reject: (error: Error) => void;
}

interface NativePendingToolSubmission {
  wireItems: unknown[];
  /** Plain provider call IDs, used to settle outstanding async tracking. */
  callIds: string[];
  /** Coverage keys matching the required-input gate (`approval:` prefixed for approvals). */
  coverageKeys: string[];
  resolve: (admission: OpenAIResponsesNativeResultAdmission) => void;
  reject: (error: Error) => void;
}

interface NativeAdmittedPendingBatch {
  batch: NativePendingToolSubmission[];
  previousResponseId: string;
  /** Accepted steers the server prepends to this create (snapshot at send), in accept order. */
  appliedSteerCount: number;
  responseCreateSeq?: number;
}

interface NativeActiveResponse {
  responseId: string;
  responseCreateSeq?: number;
  decodeState: StreamDecodeState;
  projection: OpenAIResponsesContinuationProjection;
  toolCalls: ToolCallAccumulatorRegistry;
  ordinalBase: number;
}

interface NativeChainState {
  lease: NativeChainLease;
  options: OpenAIResponsesWebSocketStreamOptions & { native: OpenAIResponsesNativeTransportOptions };
  native: OpenAIResponsesNativeTransportOptions;
  timeouts: OpenAIResponsesWebSocketTimeouts;
  prepared: PreparedCreatePayload;
  frozenWireSettings: Record<string, unknown>;
  asyncToolNames: Set<string>;
  outputRegistry: OutputItemRegistry;
  outbox: LimCodeOpenAIResponsesStreamChunk[];
  outboxSignal: { promise: Promise<void>; resolve: () => void };
  initialResponseCreateSeq?: number;
  latestResponseId?: string;
  latestTerminalResponseId?: string;
  chainResponseIds: Set<string>;
  chainTail: unknown[];
  chainTailReliable: boolean;
  activeResponse?: NativeActiveResponse;
  seenAnyResponse: boolean;
  sawSemanticOutput: boolean;
  firstEventSeen: boolean;
  steerQueue: NativePendingSteer[];
  steerInFlight?: NativePendingSteer;
  steerSending: boolean;
  steersById: Map<string, NativePendingSteer>;
  acceptedUnapplied: NativePendingSteer[];
  createQueue: NativePendingToolSubmission[];
  createInFlight?: NativeAdmittedPendingBatch;
  createSending: boolean;
  outstandingAsyncCalls: Set<string>;
  pendingRequiredCalls: Map<string, OpenAIResponsesRequiredInput>;
  requiredCalls: Map<string, OpenAIResponsesRequiredInput>;
  requiredInputPending: boolean;
  endRequested: boolean;
  released: boolean;
  quiesced: boolean;
  providerErrorEnd: boolean;
}

async function* streamOpenAIResponsesNativeSession(
  options: OpenAIResponsesWebSocketStreamOptions & { native: OpenAIResponsesNativeTransportOptions }
): AsyncGenerator<LimCodeOpenAIResponsesStreamChunk> {
  const native = options.native;
  const timeouts = resolvedTimeouts(options.timeouts);
  if (native.multiplexing) {
    const sessionKeyHash = createHash('sha256').update(options.sessionKey).digest('hex').slice(0, 12);
    const admission = await acquireOpenAIResponsesWebSocketLane({
      sessionKey: options.sessionKey,
      url: options.url,
      headers: options.headers,
      ...(options.proxy ? { proxy: options.proxy } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      timeouts,
      ...(options.forceNewConnection !== undefined
        ? { forceNewConnection: options.forceNewConnection }
        : {}),
      ...(options.onPhase ? { onPhase: options.onPhase } : {}),
      ...(native.onLaneQueueState ? { onLaneQueueState: native.onLaneQueueState } : {}),
      ...(options.debugCapture
        ? {
            debug: {
              ...options.debugCapture,
              metadata: { ...options.debugCapture.metadata, sessionKeyHash, transport: 'websocket' }
            }
          }
        : {})
    });
    yield* runNativeChain(admission.lease, options, native, timeouts);
    return;
  }
  const session = sessionFor(options.sessionKey);
  yield* withSessionLock(session, options, () => streamExclusiveNativeLocked(session, options, native, timeouts));
}

async function* streamExclusiveNativeLocked(
  session: WebSocketSession,
  options: OpenAIResponsesWebSocketStreamOptions & { native: OpenAIResponsesNativeTransportOptions },
  native: OpenAIResponsesNativeTransportOptions,
  timeouts: OpenAIResponsesWebSocketTimeouts
): AsyncGenerator<LimCodeOpenAIResponsesStreamChunk> {
  let admission: SocketAdmission;
  try {
    throwIfAborted(options.signal);
    admission = await ensureSocket(session, options, timeouts);
  } catch (error) {
    const annotated = markReceivedSemanticOutput(error, false);
    observeTransportFailure(session, options, annotated);
    closeAndInvalidate(session, true);
    if (isAbort(options.signal, annotated)) throw abortError(options.signal);
    throw annotated;
  }
  const socket = session.socket;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    closeAndInvalidate(session, true);
    throw new Error('OpenAI Responses WebSocket connection is unavailable.');
  }
  const lease = createExclusiveNativeLease(session, socket, options, admission);
  yield* runNativeChain(lease, options, native, timeouts);
}

function createExclusiveNativeLease(
  session: WebSocketSession,
  socket: WebSocket,
  options: OpenAIResponsesWebSocketStreamOptions,
  admission: SocketAdmission
): NativeChainLease {
  const queue = new AsyncEventQueue<Record<string, unknown>>();
  const debug = options.debugCapture
    ? {
        ...options.debugCapture,
        metadata: {
          ...options.debugCapture.metadata,
          sessionKeyHash: createHash('sha256').update(session.key).digest('hex').slice(0, 12),
          connectionGeneration: session.connectionGeneration,
          transport: 'websocket'
        }
      }
    : undefined;
  let sawEvent = false;
  let rawSequence = 0;
  let released = false;
  const onMessage = (data: RawData) => {
    rawSequence += 1;
    const received = captureDebug(debug?.recorder, debug?.context, () => ({
      stage: 'transport.receive',
      bytes: data,
      metadata: { ...debug?.metadata, rawSequence, responseCreateSeq: session.responseCreateSeq }
    }));
    const parsed = parseWebSocketData(data);
    if (!parsed.ok) {
      captureDebug(debug?.recorder, debug?.context, () => ({
        stage: 'ws.parse_error',
        payload: { message: parsed.error.message },
        sources: received ? [received] : []
      }));
      queue.fail(parsed.error);
      return;
    }
    if (received) associateDebugCapture(parsed.value, [received]);
    sawEvent = true;
    queue.push(parsed.value);
  };
  const onError = (error: Error) => {
    const wrapped = structuredTransportError(
      error.message || 'OpenAI Responses WebSocket transport error.',
      typeof (error as Error & { code?: unknown }).code === 'string'
        ? (error as Error & { code: string }).code
        : 'websocket_error',
      sawEvent ? 'streaming' : 'awaiting_first_event',
      sawEvent
    );
    (wrapped as Error & { cause?: unknown }).cause = error;
    queue.fail(wrapped);
  };
  const onClose = (code: number, reason: Buffer) => {
    queue.fail(new OpenAIResponsesWebSocketCloseError(
      code,
      reason.toString('utf8').trim(),
      sawEvent ? 'streaming' : 'awaiting_first_event',
      sawEvent
    ));
  };
  const onAbort = () => queue.fail(abortError(options.signal));
  socket.on('message', onMessage);
  socket.once('error', onError);
  socket.once('close', onClose);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const expectedConnectionIdentityHash = requireConnectionIdentity(session);
  const networkIdentityTimer = setInterval(() => {
    try {
      if (webSocketConnectionConfig(options).identityHash !== expectedConnectionIdentityHash) {
        queue.fail(structuredTransportError(
          'OpenAI Responses WebSocket local network changed.',
          'network_changed',
          sawEvent ? 'streaming' : 'awaiting_first_event',
          sawEvent
        ));
      }
    } catch {
      // A transient failure to enumerate interfaces is not itself network authority.
    }
  }, NETWORK_IDENTITY_CHECK_INTERVAL_MS);
  networkIdentityTimer.unref?.();
  return {
    connectionGeneration: session.connectionGeneration,
    streamId: undefined,
    continuation: session,
    connectionReused: admission.reused,
    connectionReason: admission.reason,
    async sendFrame(frame, timeoutMs, signal) {
      if (released) throw new Error('OpenAI Responses WebSocket lane lease is released.');
      if (session.socket !== socket || socket.readyState !== WebSocket.OPEN) {
        throw structuredTransportError(
          'OpenAI Responses WebSocket connection is unavailable.',
          'websocket_unavailable',
          'streaming',
          sawEvent
        );
      }
      const isCreate = eventType(frame) === 'response.create';
      const responseCreateSeq = isCreate ? ++session.responseCreateSeq : undefined;
      const payloadText = JSON.stringify(frame);
      captureDebug(debug?.recorder, debug?.context, () => ({
        stage: 'transport.send',
        payload: payloadText,
        metadata: {
          ...debug?.metadata,
          ...(responseCreateSeq !== undefined ? { responseCreateSeq } : {})
        }
      }));
      await sendWithDeadline(socket, payloadText, timeoutMs, signal);
      return responseCreateSeq !== undefined ? { responseCreateSeq } : {};
    },
    events() {
      return queue;
    },
    healthy() {
      return session.socket === socket && socket.readyState === WebSocket.OPEN;
    },
    acquirePermit() {
      // The exclusive session lock already serializes the whole connection.
      return Promise.resolve();
    },
    releasePermit() {
      // The exclusive session lock already serializes the whole connection.
    },
    release(outcome) {
      if (released) return;
      released = true;
      clearInterval(networkIdentityTimer);
      options.signal?.removeEventListener('abort', onAbort);
      socket.off('message', onMessage);
      socket.off('error', onError);
      socket.off('close', onClose);
      queue.end();
      if (outcome !== 'quiescent') closeAndInvalidate(session, true);
    }
  };
}

async function* runNativeChain(
  lease: NativeChainLease,
  options: OpenAIResponsesWebSocketStreamOptions & { native: OpenAIResponsesNativeTransportOptions },
  native: OpenAIResponsesNativeTransportOptions,
  timeouts: OpenAIResponsesWebSocketTimeouts
): AsyncGenerator<LimCodeOpenAIResponsesStreamChunk> {
  const fullBody = sanitizeResponsesCreateBody(options.body, true);
  const identity = { key: options.sessionKey, connectionGeneration: lease.connectionGeneration };
  const prepared = prepareCreatePayload(
    lease.continuation,
    identity,
    fullBody,
    { reused: lease.connectionReused, reason: lease.connectionReason },
    options.format,
    options.continuation,
    native,
    lease.streamId
  );
  options.onDecision?.(prepared.decision);

  const frozenWireSettings = { ...prepared.payload };
  delete frozenWireSettings.type;
  delete frozenWireSettings.input;
  delete frozenWireSettings.previous_response_id;
  const state: NativeChainState = {
    lease,
    options,
    native,
    timeouts,
    prepared,
    frozenWireSettings,
    asyncToolNames: collectNativeAsyncToolNames(fullBody),
    outputRegistry: { byAlias: new Map(), nextOrdinal: 0 },
    outbox: [],
    outboxSignal: createNativeSignal(),
    chainResponseIds: new Set(),
    chainTail: [],
    chainTailReliable: true,
    seenAnyResponse: false,
    sawSemanticOutput: false,
    firstEventSeen: false,
    steerQueue: [],
    steerSending: false,
    steersById: new Map(),
    acceptedUnapplied: [],
    createQueue: [],
    createSending: false,
    outstandingAsyncCalls: new Set(),
    pendingRequiredCalls: new Map(),
    requiredCalls: new Map(),
    requiredInputPending: false,
    endRequested: false,
    released: false,
    quiesced: false,
    providerErrorEnd: false
  };

  let releaseOutcome: 'quiescent' | 'error' | 'abort' = 'error';
  let staleCreatesExpected = 0;
  let controllerRegistered = false;
  try {
    state.initialResponseCreateSeq = await sendNativeCreateFrame(state, prepared.payload);
    const controller = createNativeController(state);
    native.onController?.(controller);
    controllerRegistered = true;
    yield* nativeChainEventLoop(state);
    if (state.providerErrorEnd) {
      rejectNativePendingWork(state, 'failed', 'lane_error');
      releaseOutcome = 'error';
      staleCreatesExpected = countStaleCreatesExpected(state);
      return;
    }
    commitNativeContinuation(state);
    releaseOutcome = 'quiescent';
  } catch (error) {
    captureDebug(options.debugCapture?.recorder, options.debugCapture?.context, () => ({
      stage: 'ws.error',
      payload: { message: errorText(error) }
    }));
    const annotated = markReceivedSemanticOutput(error, state.sawSemanticOutput);
    observeOpenAIResponsesWebSocketFailure(identity, options.onPhase, options.signal, annotated);
    const aborted = isAbort(options.signal, annotated);
    staleCreatesExpected = countStaleCreatesExpected(state);
    const disconnected = aborted ? [] : disconnectNativeSteerChunks(state);
    rejectNativePendingWork(state, aborted ? 'abort' : 'admission_unknown', 'connection_lost');
    releaseOutcome = aborted ? 'abort' : 'error';
    for (const chunk of disconnected) yield chunk;
    if (aborted) throw abortError(options.signal);
    throw annotated;
  } finally {
    state.released = true;
    if (controllerRegistered) native.onController?.(undefined);
    lease.release(releaseOutcome, releaseOutcome === 'quiescent' ? 0 : staleCreatesExpected);
  }
}

async function sendNativeCreateFrame(
  state: NativeChainState,
  payload: Record<string, unknown>
): Promise<number | undefined> {
  const payloadText = JSON.stringify(payload);
  const responseCreateFrameSha256 = createHash('sha256').update(payloadText, 'utf8').digest('hex');
  const responseCreateFrameBytes = Buffer.byteLength(payloadText, 'utf8');
  observeNativePhase(state, 'send_started');
  const { responseCreateSeq } = await state.lease.sendFrame(payload, state.timeouts.sendMs, state.options.signal);
  observeNativePhase(state, 'request_sent', {
    responseCreateFrameSha256,
    responseCreateFrameBytes,
    ...(responseCreateSeq !== undefined ? { responseCreateSeq } : {})
  });
  return responseCreateSeq;
}

function observeNativePhase(
  state: NativeChainState,
  phase: OpenAIResponsesWebSocketPhaseKind,
  detail: Partial<OpenAIResponsesWebSocketPhase> = {}
): void {
  observeOpenAIResponsesWebSocketPhase(
    { key: state.options.sessionKey, connectionGeneration: state.lease.connectionGeneration },
    state.options.onPhase,
    phase,
    {
      ...(state.lease.streamId ? { streamId: state.lease.streamId } : {}),
      ...detail
    }
  );
}

function createNativeSignal(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function notifyNativeOutbox(state: NativeChainState): void {
  state.outboxSignal.resolve();
  state.outboxSignal = createNativeSignal();
}

function queueNativeEvent(state: NativeChainState, event: OpenAIResponsesNativeEvent): void {
  state.outbox.push({ nativeEvent: event });
  notifyNativeOutbox(state);
}

function drainNativeOutbox(state: NativeChainState): LimCodeOpenAIResponsesStreamChunk[] {
  return state.outbox.splice(0);
}

function createNativeController(state: NativeChainState): OpenAIResponsesNativeController {
  return {
    get responseId() {
      return state.latestResponseId;
    },
    get connectionGeneration() {
      return state.lease.connectionGeneration;
    },
    get streamId() {
      return state.lease.streamId;
    },
    steer(command) {
      return enqueueNativeSteer(state, command);
    },
    submitToolResults(outputs) {
      return enqueueNativeToolSubmission(state, outputs);
    },
    endLogicalRequest() {
      requestNativeLogicalEnd(state);
    }
  };
}

async function* nativeChainEventLoop(
  state: NativeChainState
): AsyncGenerator<LimCodeOpenAIResponsesStreamChunk> {
  const iterator = state.lease.events()[Symbol.asyncIterator]();
  const responseDeadlineAt = Date.now() + state.timeouts.responseMs;
  const firstEventDeadlineAt = Date.now() + state.timeouts.firstEventMs;
  let lastEventAt = Date.now();
  let abortReject!: (error: Error) => void;
  const abortRace = new Promise<never>((_resolve, reject) => {
    abortReject = reject;
  });
  const onAbort = () => abortReject(abortError(state.options.signal));
  state.options.signal?.addEventListener('abort', onAbort, { once: true });
  // A wire-event read is never abandoned mid-race: the same pending read is carried across
  // outbox-only wakeups and replaced only after it settles, so a lost race can never discard a
  // queued event (an orphaned read would silently swallow the next frame, e.g. steer.accepted).
  let pendingNext: Promise<
    | { kind: 'event'; step: IteratorResult<Record<string, unknown>> }
    | { kind: 'failed'; error: Error }
  > | undefined;
  const readNext = () => {
    pendingNext = iterator.next().then(
      (step) => ({ kind: 'event' as const, step }),
      (error: Error) => ({ kind: 'failed' as const, error })
    );
    return pendingNext;
  };
  try {
    for (;;) {
      throwIfAborted(state.options.signal);
      pumpSteerQueue(state);
      pumpCreateQueue(state);
      for (const chunk of drainNativeOutbox(state)) yield chunk;
      if (state.providerErrorEnd) return;
      if (isNativeChainQuiescent(state)) {
        state.quiesced = true;
        return;
      }
      // A proven client-input wait holds lane ownership but no active-response permit, so other
      // conversations' responses can run on this connection meanwhile.
      if (isNativeChainPermitReleasableWait(state)) state.lease.releasePermit();

      const now = Date.now();
      const deadlines: Array<{ at: number; phase: 'first_event' | 'event_idle' | 'response'; ms: number }> = [
        { at: responseDeadlineAt, phase: 'response', ms: state.timeouts.responseMs }
      ];
      if (!state.firstEventSeen) {
        deadlines.push({ at: firstEventDeadlineAt, phase: 'first_event', ms: state.timeouts.firstEventMs });
      } else if (!isNativeChainWaitingOnClient(state)) {
        deadlines.push({ at: lastEventAt + state.timeouts.eventIdleMs, phase: 'event_idle', ms: state.timeouts.eventIdleMs });
      }
      deadlines.sort((left, right) => left.at - right.at);
      const deadline = deadlines[0];
      if (now >= deadline.at) {
        throw new OpenAIResponsesWebSocketTimeoutError(deadline.phase, deadline.ms, state.firstEventSeen);
      }

      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        pendingNext ??= readNext();
        const result = await Promise.race([
          pendingNext,
          abortRace.then(() => ({ kind: 'aborted' as const })),
          state.outboxSignal.promise.then(() => ({ kind: 'outbox' as const })),
          new Promise<{ kind: 'timeout' }>((resolve) => {
            timeoutHandle = setTimeout(
              () => resolve({ kind: 'timeout' }),
              Math.max(1, deadline.at - now)
            );
          })
        ]);
        if (result.kind === 'timeout') {
          throw new OpenAIResponsesWebSocketTimeoutError(deadline.phase, deadline.ms, state.firstEventSeen);
        }
        if (result.kind === 'aborted') throw abortError(state.options.signal);
        if (result.kind === 'outbox') continue;
        pendingNext = undefined;
        if (result.kind === 'failed') throw result.error;
        if (result.step.done) {
          throw new OpenAIResponsesWebSocketCloseError(1005, '', 'streaming', state.firstEventSeen);
        }
        const raw = result.step.value;
        lastEventAt = Date.now();
        if (!state.firstEventSeen) {
          state.firstEventSeen = true;
          observeNativePhase(state, 'first_raw_event');
        }
        for (const chunk of processNativeWireEvent(state, raw)) yield chunk;
      } finally {
        clearTimeout(timeoutHandle);
      }
    }
  } finally {
    state.options.signal?.removeEventListener('abort', onAbort);
    // The lease owns queue termination: release() ends the queue and settles any parked read.
    // This finally must NOT await iterator.return() — async generators serialize it behind a
    // parked read, which only settles at release, and release runs after this loop exits: that
    // ordering deadlocks teardown permanently.
  }
}

/**
 * Quiescence requires a terminal boundary with nothing outstanding: no response in flight, no
 * steer queued/sent/accepted-unapplied, no required input wait, no outstanding tool calls and no
 * tool-result create queued or awaiting admission. Anything else keeps the stream alive so an
 * automatic successor or required-input continuation can arrive without deadlock.
 */
function isNativeChainQuiescent(state: NativeChainState): boolean {
  if (!state.seenAnyResponse || state.activeResponse) return false;
  if (state.providerErrorEnd) return false;
  if (state.endRequested) return true;
  if (state.steerSending || state.steerInFlight || state.steerQueue.length > 0) return false;
  if (state.createSending || state.createInFlight || state.createQueue.length > 0) return false;
  if (state.acceptedUnapplied.length > 0) return false;
  if (state.requiredInputPending) return false;
  if (state.outstandingAsyncCalls.size > 0) return false;
  if (state.requiredCalls.size > 0 || state.pendingRequiredCalls.size > 0) return false;
  return true;
}

/**
 * A terminal boundary with outstanding async calls, required input, queued coverage waiters or an
 * unadmitted continuation is an intentional client-side wait, not a stalled socket: the per-event
 * idle deadline pauses there (the total logical budget and cancellation never pause).
 */
function isNativeChainWaitingOnClient(state: NativeChainState): boolean {
  if (state.activeResponse || !state.seenAnyResponse || state.endRequested) return false;
  return state.outstandingAsyncCalls.size > 0
    || state.requiredCalls.size > 0
    || state.pendingRequiredCalls.size > 0
    || state.requiredInputPending
    || state.createQueue.length > 0
    || state.createInFlight !== undefined
    || state.createSending
    || state.steerInFlight !== undefined
    || state.steerSending;
}

/**
 * A proven client-input wait with nothing that can start a response outstanding: the lane's
 * active-response permit is released so other conversations can use the capacity. Permits are
 * retained across expected automatic successors, sent-unacked steers, unadmitted creates and any
 * in-flight response.
 */
function isNativeChainPermitReleasableWait(state: NativeChainState): boolean {
  if (!state.seenAnyResponse || state.activeResponse || state.endRequested) return false;
  if (state.steerSending || state.steerInFlight || state.steerQueue.length > 0) return false;
  if (state.acceptedUnapplied.some((steer) => steer.state === 'accepted')) return false;
  if (state.createSending || state.createInFlight) return false;
  return state.outstandingAsyncCalls.size > 0
    || state.requiredCalls.size > 0
    || state.pendingRequiredCalls.size > 0
    || state.requiredInputPending
    || state.createQueue.length > 0;
}

function processNativeWireEvent(
  state: NativeChainState,
  raw: Record<string, unknown>
): LimCodeOpenAIResponsesStreamChunk[] {
  const type = eventType(raw);
  switch (type) {
    case 'response.steer.accepted':
      handleNativeSteerAccepted(state, raw);
      return drainNativeOutbox(state);
    case 'response.steer.pending':
      handleNativeSteerPending(state, raw);
      return drainNativeOutbox(state);
    case 'response.steer.failed':
      handleNativeSteerFailed(state, raw);
      return drainNativeOutbox(state);
    case 'response.created':
      return startNativeResponse(state, raw);
    case 'response.completed':
    case 'response.incomplete':
      return finishNativeResponse(state, raw, type);
    default:
      if (isTerminalEvent(raw)) observeNativePhase(state, 'terminal', { reason: type || 'terminal' });
      if (isProviderErrorPayload(raw)) return failNativeChainWithProviderError(state, raw);
      if (!state.activeResponse) return [];
      return decodeNativeWireEvent(state, raw);
  }
}

function startNativeResponse(
  state: NativeChainState,
  raw: Record<string, unknown>
): LimCodeOpenAIResponsesStreamChunk[] {
  const responseId = responseIdFromPayload(raw);
  if (!responseId) return [];
  const response = isRecord(raw.response) ? raw.response : undefined;
  const previousResponseId = (response ? normalizedString(response.previous_response_id) : undefined)
    ?? normalizedString(raw.previous_response_id);
  if (state.activeResponse) {
    // A new response before the previous one terminated breaks the projection chain; the
    // continuation baseline falls back to a full rebase rather than trusting a partial tail.
    state.chainTailReliable = false;
  }

  let admittedSeq = state.seenAnyResponse ? undefined : state.initialResponseCreateSeq;
  // Only the prepared input was sent: incremental creates may omit results that remain in
  // fullBody/history, while rebased initial creates can carry prior native tool results.
  let admittedToolResultCallIds: string[] | undefined = state.seenAnyResponse
    ? undefined
    : nativeWireToolResultCallIds(state.prepared.payload.input);
  const inFlight = state.createInFlight;
  if (inFlight) {
    state.createInFlight = undefined;
    // The server prepends only the accepted steers snapshotted when this create was sent;
    // steers accepted afterwards keep waiting for their own continuation boundary.
    const appliedSteers = state.acceptedUnapplied.splice(0, inFlight.appliedSteerCount);
    markNativeSteersApplied(state, appliedSteers);
    for (const steer of appliedSteers) {
      state.chainTail.push(...steer.wireInput);
    }
    state.chainTail.push(...inFlight.batch.flatMap((sub) => sub.wireItems));
    const admission: OpenAIResponsesNativeResultAdmission = {
      responseId,
      previousResponseId: inFlight.previousResponseId,
      connectionGeneration: state.lease.connectionGeneration,
      ...(state.lease.streamId ? { streamId: state.lease.streamId } : {})
    };
    admittedSeq = inFlight.responseCreateSeq;
    admittedToolResultCallIds = inFlight.batch.flatMap((sub) => sub.callIds);
    for (const sub of inFlight.batch) sub.resolve(admission);
  } else if (state.seenAnyResponse && state.acceptedUnapplied.length > 0) {
    // Automatic steering successor: the accepted input enters history before this response.
    appendAcceptedSteerInputsToTail(state);
  }

  state.requiredCalls = new Map();
  state.requiredInputPending = [...state.steersById.values()].some(
    (steer) => steer.state === 'waiting_for_input'
  );
  state.activeResponse = {
    responseId,
    ...(admittedSeq !== undefined ? { responseCreateSeq: admittedSeq } : {}),
    decodeState: state.options.format.createStreamState(),
    projection: new OpenAIResponsesContinuationProjection(),
    toolCalls: { active: new Set(), byAlias: new Map() },
    ordinalBase: state.outputRegistry.nextOrdinal
  };
  state.seenAnyResponse = true;
  state.chainResponseIds.add(responseId);
  state.latestResponseId = responseId;
  queueNativeEvent(state, {
    type: 'response.created',
    responseId,
    connectionGeneration: state.lease.connectionGeneration,
    ...(previousResponseId ? { previousResponseId } : {}),
    ...(state.lease.streamId ? { streamId: state.lease.streamId } : {}),
    ...(admittedSeq !== undefined ? { responseCreateSeq: String(admittedSeq) } : {}),
    ...(admittedToolResultCallIds && admittedToolResultCallIds.length > 0
      ? { admittedToolResultCallIds }
      : {})
  });
  return drainNativeOutbox(state);
}

function finishNativeResponse(
  state: NativeChainState,
  raw: Record<string, unknown>,
  type: 'response.completed' | 'response.incomplete'
): LimCodeOpenAIResponsesStreamChunk[] {
  observeNativePhase(state, 'terminal', { reason: type });
  const response = isRecord(raw.response) ? raw.response : undefined;
  const incompleteDetails = response && isRecord(response.incomplete_details)
    ? response.incomplete_details
    : undefined;
  const incompleteReason = type === 'response.incomplete'
    ? normalizedString(incompleteDetails?.reason)
    : undefined;
  // A steered incomplete is a normal boundary on the native path; every other incomplete stays
  // as strict as the legacy transport.
  const steeredBoundary = type === 'response.incomplete'
    && incompleteReason === 'steered'
    && state.native.steering;
  if (type === 'response.incomplete' && !steeredBoundary) {
    return failNativeChainWithProviderError(state, raw);
  }

  const chunks: LimCodeOpenAIResponsesStreamChunk[] = [];
  const active = state.activeResponse;
  if (active) chunks.push(...decodeNativeWireEvent(state, raw));
  // A steered boundary terminalizes from done items only: the server finished the current output
  // item before switching, so the same proven segment (never fabricated) joins the chain tail.
  const projection = active?.projection;
  const segment = projection
    ? (steeredBoundary
        ? projection.incompleteBoundaryProjection()
        : projection.completedProjection())
    : undefined;
  const responseId = responseIdFromPayload(raw) ?? active?.responseId ?? state.latestResponseId ?? '';
  if (segment) {
    state.chainTail.push(
      ...segment.outputItems.map((item) => stripWebSocketOnlyInputFields(item, true))
    );
    if (chunks.length > 0) {
      chunks[chunks.length - 1] = { ...chunks[chunks.length - 1], completedContent: segment.content };
    } else {
      chunks.push({ completedContent: segment.content });
    }
  } else {
    state.chainTailReliable = false;
  }

  state.requiredCalls = state.pendingRequiredCalls;
  state.pendingRequiredCalls = new Map();
  const requiredInput = [...state.requiredCalls.values()];
  state.latestTerminalResponseId = responseId || undefined;
  state.activeResponse = undefined;
  queueNativeEvent(state, {
    type,
    responseId,
    connectionGeneration: state.lease.connectionGeneration,
    ...(state.lease.streamId ? { streamId: state.lease.streamId } : {}),
    ...(incompleteReason ? { reason: incompleteReason } : {}),
    ...(type === 'response.completed'
      ? nativeResponseUsage(raw) ? { usage: nativeResponseUsage(raw) } : {}
      : {}),
    ...(requiredInput.length > 0 ? { requiredInput } : {}),
    ...(active?.responseCreateSeq !== undefined
      ? { responseCreateSeq: String(active.responseCreateSeq) }
      : {})
  });
  chunks.push(...drainNativeOutbox(state));
  return chunks;
}

function nativeResponseUsage(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const response = isRecord(raw.response) ? raw.response : undefined;
  if (response && isRecord(response.usage)) return response.usage;
  return isRecord(raw.usage) ? raw.usage : undefined;
}

function failNativeChainWithProviderError(
  state: NativeChainState,
  raw: Record<string, unknown>
): LimCodeOpenAIResponsesStreamChunk[] {
  state.providerErrorEnd = true;
  return [createErrorStreamChunk(errorInfoFromPayload(raw, state.sawSemanticOutput))];
}

function decodeNativeWireEvent(
  state: NativeChainState,
  raw: Record<string, unknown>
): LimCodeOpenAIResponsesStreamChunk[] {
  const active = state.activeResponse;
  if (!active) return [];
  const type = eventType(raw);
  const outputItem = observeOutputItem(raw, state.outputRegistry, active.ordinalBase);
  const argumentDeltas = captureToolCallArgumentDeltas(
    raw,
    active.toolCalls,
    state.options.debugCapture,
    active.ordinalBase
  );
  if (type === 'response.output_item.done' && isRecord(raw.item)) {
    classifyNativeCallItem(state, raw.item);
  }

  // The session is the sole nativeEvent authority on this channel; the format decoder's
  // nativeEvent surface (SSE-only) never applies here and is excluded from the chunk type.
  let decoded: Omit<LLMStreamChunk, 'nativeEvent'>;
  try {
    captureDebug(state.options.debugCapture?.recorder, state.options.debugCapture?.context, () => ({
      stage: 'ws.decode_input',
      payload: raw,
      sources: debugCaptureSources(raw)
    }));
    decoded = state.options.format.decodeStreamChunk(raw, active.decodeState);
  } catch (error) {
    const wrapped = new Error(`OpenAI Responses WebSocket decode failed: ${errorText(error)}`);
    (wrapped as Error & { cause?: unknown }).cause = error;
    throw wrapped;
  }

  const decodedChunk: LimCodeOpenAIResponsesStreamChunk = {
    ...decoded,
    ...(outputItem.current ? { outputItem: outputItem.current } : {}),
    ...(outputItem.done ? { outputItemDone: outputItem.done } : {}),
    ...(argumentDeltas.length > 0 ? { toolCallArgumentDeltas: argumentDeltas } : {})
  };
  const projected = active.projection.observe(raw, decodedChunk);
  const projectedChunk: Omit<LLMStreamChunk, 'nativeEvent'> = projected.chunk;
  const chunk: LimCodeOpenAIResponsesStreamChunk = {
    ...projectedChunk,
    ...(outputItem.current ? { outputItem: outputItem.current } : {}),
    ...(outputItem.done ? { outputItemDone: outputItem.done } : {}),
    ...(argumentDeltas.length > 0 ? { toolCallArgumentDeltas: argumentDeltas } : {}),
    ...(type === 'response.output_item.done' && isRecord(raw.item) && raw.item.type === 'reasoning'
      ? { reasoningItemDone: true }
      : {})
  };
  const semanticOutput = projected.semanticOutput
    || hasSemanticChunkOutput(chunk)
    || argumentDeltas.length > 0;
  if (semanticOutput && !state.sawSemanticOutput) {
    observeNativePhase(state, 'first_semantic_event');
  }
  if (semanticOutput) state.sawSemanticOutput = true;
  const observed = captureDebug(state.options.debugCapture?.recorder, state.options.debugCapture?.context, () => ({
    stage: 'ws.decoded',
    payload: chunk,
    sources: debugCaptureSources(raw)
  }));
  if (observed) associateDebugCapture(chunk, [observed]);
  if (outputItem.done) unregisterOutputItem(state.outputRegistry, outputItem.done);
  return hasMeaningfulChunk(chunk) ? [chunk] : [];
}

/**
 * Main's authority rule: a call is async only when the returned item says `async: true` AND the
 * frozen request declared that tool async. Missing/false flags and undeclared async items stay
 * synchronous and become required inputs for the continuation gate.
 */
function classifyNativeCallItem(state: NativeChainState, item: Record<string, unknown>): void {
  const itemType = normalizedString(item.type);
  const name = normalizedString(item.name);
  if (itemType === 'function_call' || itemType === 'custom_tool_call') {
    const callId = normalizedString(item.call_id);
    if (!callId) return;
    if (item.async === true && name !== undefined && state.asyncToolNames.has(name)) {
      state.outstandingAsyncCalls.add(callId);
      return;
    }
    state.pendingRequiredCalls.set(callId, {
      type: itemType === 'function_call' ? 'function_call_output' : 'custom_tool_call_output',
      callId,
      ...(name ? { name } : {})
    });
    return;
  }
  if (itemType === 'mcp_approval_request') {
    const approvalRequestId = normalizedString(item.id);
    if (!approvalRequestId) return;
    state.pendingRequiredCalls.set(`approval:${approvalRequestId}`, {
      type: 'mcp_approval_response',
      approvalRequestId,
      ...(name ? { name } : {})
    });
  }
}

function handleNativeSteerAccepted(state: NativeChainState, raw: Record<string, unknown>): void {
  const steer = isRecord(raw.steer) ? raw.steer : undefined;
  const steerId = steer ? normalizedString(steer.id) : undefined;
  const target = steer ? normalizedString(steer.previous_response_id) : undefined;
  const inFlight = state.steerInFlight;
  if (!inFlight || (target !== undefined && target !== inFlight.targetResponseId)) {
    captureDebug(state.options.debugCapture?.recorder, state.options.debugCapture?.context, () => ({
      stage: 'ws.steer_stale',
      payload: { steerId, target }
    }));
    return;
  }
  inFlight.steerId = steerId;
  inFlight.state = 'accepted';
  if (steerId) state.steersById.set(steerId, inFlight);
  state.acceptedUnapplied.push(inFlight);
  state.steerInFlight = undefined;
  queueNativeEvent(state, {
    type: 'response.steer.accepted',
    responseId: target ?? inFlight.targetResponseId,
    submissionId: inFlight.submissionId,
    ...(steerId ? { steerId } : {}),
    connectionGeneration: state.lease.connectionGeneration,
    ...(state.lease.streamId ? { streamId: state.lease.streamId } : {})
  });
  // The next serialized steer may only go out after this ack.
  pumpSteerQueue(state);
}

function handleNativeSteerPending(state: NativeChainState, raw: Record<string, unknown>): void {
  const steer = isRecord(raw.steer) ? raw.steer : undefined;
  const steerId = steer ? normalizedString(steer.id) : undefined;
  const submission = (steerId ? state.steersById.get(steerId) : undefined) ?? state.steerInFlight;
  if (!submission) return;
  submission.state = 'waiting_for_input';
  state.requiredInputPending = true;
  const requiredInput = parseNativeRequiredInput(raw.required_input);
  for (const entry of requiredInput) {
    const key = entry.callId ?? (entry.approvalRequestId ? `approval:${entry.approvalRequestId}` : undefined);
    if (key) state.requiredCalls.set(key, entry);
  }
  queueNativeEvent(state, {
    type: 'response.steer.pending',
    responseId: submission.targetResponseId,
    submissionId: submission.submissionId,
    ...(steerId ? { steerId } : {}),
    ...(requiredInput.length > 0 ? { requiredInput } : {}),
    connectionGeneration: state.lease.connectionGeneration,
    ...(state.lease.streamId ? { streamId: state.lease.streamId } : {})
  });
}

function handleNativeSteerFailed(state: NativeChainState, raw: Record<string, unknown>): void {
  const steer = isRecord(raw.steer) ? raw.steer : undefined;
  const steerId = steer ? normalizedString(steer.id) : undefined;
  const submission = (steerId ? state.steersById.get(steerId) : undefined) ?? state.steerInFlight;
  if (!submission) return;
  submission.state = 'failed';
  if (steerId) state.steersById.delete(steerId);
  const appliedIndex = state.acceptedUnapplied.indexOf(submission);
  if (appliedIndex >= 0) state.acceptedUnapplied.splice(appliedIndex, 1);
  if (state.steerInFlight === submission) state.steerInFlight = undefined;
  state.requiredInputPending = [...state.steersById.values()].some(
    (pending) => pending.state === 'waiting_for_input'
  );
  const errorRecord = isRecord(raw.error) ? raw.error : undefined;
  const code = normalizedString(errorRecord?.code);
  queueNativeEvent(state, {
    type: 'response.steer.failed',
    responseId: submission.targetResponseId,
    submissionId: submission.submissionId,
    ...(steerId ? { steerId } : {}),
    input: submission.input,
    error: {
      ...(code ? { code } : {}),
      message: nestedMessage(raw) ?? 'OpenAI Responses steering failed.'
    },
    connectionGeneration: state.lease.connectionGeneration,
    ...(state.lease.streamId ? { streamId: state.lease.streamId } : {})
  });
  pumpSteerQueue(state);
}

function parseNativeRequiredInput(value: unknown): OpenAIResponsesRequiredInput[] {
  if (!Array.isArray(value)) return [];
  const parsed: OpenAIResponsesRequiredInput[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const type = normalizedString(entry.type);
    if (type !== 'function_call_output'
      && type !== 'custom_tool_call_output'
      && type !== 'mcp_approval_response') continue;
    const callId = normalizedString(entry.call_id);
    const approvalRequestId = normalizedString(entry.approval_request_id);
    const name = normalizedString(entry.name);
    parsed.push({
      type,
      ...(callId ? { callId } : {}),
      ...(approvalRequestId ? { approvalRequestId } : {}),
      ...(name ? { name } : {})
    });
  }
  return parsed;
}

function enqueueNativeSteer(
  state: NativeChainState,
  command: OpenAIResponsesSteeringCommand
): Promise<void> {
  if (state.released || state.quiesced) {
    return Promise.reject(nativeDeliveryError('not_sent', 'controller_released', command.submissionId));
  }
  if (state.endRequested) {
    return Promise.reject(nativeDeliveryError('not_sent', 'logical_request_ended', command.submissionId));
  }
  if (!state.native.steering) {
    return Promise.reject(nativeDeliveryError('not_sent', 'steering_not_enabled', command.submissionId));
  }
  const submissionId = normalizedString(command.submissionId);
  if (!submissionId || !Array.isArray(command.input) || command.input.length === 0) {
    return Promise.reject(nativeDeliveryError('not_sent', 'invalid_input', command.submissionId));
  }
  const targetResponseId = normalizedString(command.previousResponseId) ?? state.latestResponseId;
  if (!targetResponseId) {
    return Promise.reject(nativeDeliveryError('not_sent', 'no_response_yet', submissionId));
  }
  let wireInput: unknown[];
  try {
    wireInput = encodeNativeSteerInput(state.options.format, command.input);
  } catch {
    return Promise.reject(nativeDeliveryError('not_sent', 'encode_failed', submissionId));
  }
  return new Promise<void>((resolve, reject) => {
    state.steerQueue.push({
      submissionId,
      input: command.input,
      wireInput,
      targetResponseId,
      state: 'queued',
      resolve,
      reject
    });
    pumpSteerQueue(state);
  });
}

/**
 * Steering sends are serialized per lane: only one submission may await its accepted/failed ack,
 * because the official ack carries no client correlation. Queued-unsent submissions reject as
 * `not_sent` on teardown; only the sent-unacked one (and accepted-unapplied ones) can become
 * `response.steer.disconnected` observations.
 */
function pumpSteerQueue(state: NativeChainState): void {
  if (state.steerSending || state.steerInFlight || state.steerQueue.length === 0) return;
  if (state.released || state.endRequested) return;
  const steer = state.steerQueue.shift()!;
  // The wire event accepts ONLY type, previous_response_id and input; submissionId never leaves
  // the client.
  const frame: Record<string, unknown> = {
    type: 'response.steer',
    previous_response_id: steer.targetResponseId,
    input: steer.wireInput
  };
  state.steerSending = true;
  void (async () => {
    try {
      await state.lease.acquirePermit(state.options.signal);
    } catch (error) {
      state.steerSending = false;
      steer.reject(isAbort(state.options.signal, error)
        ? abortError(state.options.signal)
        : nativeDeliveryError('not_sent', state.released ? 'controller_released' : 'capacity_unavailable', steer.submissionId));
      return;
    }
    if (state.released || state.endRequested) {
      state.steerSending = false;
      state.lease.releasePermit();
      steer.reject(nativeDeliveryError(
        'not_sent',
        state.released ? 'controller_released' : 'logical_request_ended',
        steer.submissionId
      ));
      return;
    }
    // The permit is intentionally retained after this send: an accepted steer may produce an
    // automatic successor, which must count against active-response capacity.
    state.lease.sendFrame(frame, state.timeouts.sendMs, state.options.signal).then(
      () => {
        state.steerSending = false;
        if (state.released) {
          steer.reject(nativeDeliveryError('not_sent', 'controller_released', steer.submissionId));
          return;
        }
        state.steerInFlight = steer;
        steer.state = 'sent';
        steer.resolve();
        queueNativeEvent(state, {
          type: 'response.steer.submitted',
          responseId: steer.targetResponseId,
          submissionId: steer.submissionId,
          input: steer.input,
          connectionGeneration: state.lease.connectionGeneration,
          ...(state.lease.streamId ? { streamId: state.lease.streamId } : {})
        });
      },
      (error: unknown) => {
        state.steerSending = false;
        steer.reject(isAbort(state.options.signal, error)
          ? abortError(state.options.signal)
          : nativeDeliveryError('not_sent', 'send_failed', steer.submissionId));
      }
    );
  })();
}

function enqueueNativeToolSubmission(
  state: NativeChainState,
  outputs: readonly OpenAIResponsesToolOutput[]
): Promise<OpenAIResponsesNativeResultAdmission> {
  if (state.released || state.quiesced) {
    return Promise.reject(nativeDeliveryError('not_sent', 'controller_released'));
  }
  if (state.endRequested) {
    return Promise.reject(nativeDeliveryError('not_sent', 'logical_request_ended'));
  }
  let built: { wireItems: unknown[]; callIds: string[]; coverageKeys: string[] };
  try {
    built = buildNativeToolOutputItems(outputs);
  } catch {
    return Promise.reject(nativeDeliveryError('not_sent', 'invalid_input'));
  }
  if (built.wireItems.length === 0) {
    return Promise.reject(nativeDeliveryError('not_sent', 'invalid_input'));
  }
  for (const callId of built.callIds) state.outstandingAsyncCalls.delete(callId);
  for (const key of built.coverageKeys) {
    state.requiredCalls.delete(key);
    state.pendingRequiredCalls.delete(key);
  }
  return new Promise<OpenAIResponsesNativeResultAdmission>((resolve, reject) => {
    state.createQueue.push({ ...built, resolve, reject });
    pumpCreateQueue(state);
    // Wake the read loop: a queued or in-flight continuation changes the client-wait deadline
    // computation and the quiescence evaluation.
    notifyNativeOutbox(state);
  });
}

/**
 * Continuation creates never escape while the lane's latest response is mid-flight, while any
 * required synchronous output is uncovered, or while a steer could still produce an automatic
 * successor ahead of this create — an unread automatic response.created must never be
 * misattributed as a result admission. Once coverage is complete and no automatic successor is
 * expected, the queued submissions merge into one create carrying the frozen original settings
 * and the latest response ID. Accepted steering is server-prepended by the API and never repeated
 * in this input; the create snapshots how many accepted steers the server will prepend to it.
 */
function pumpCreateQueue(state: NativeChainState): void {
  if (state.createSending || state.createInFlight || state.createQueue.length === 0) return;
  if (state.released || state.endRequested) return;
  if (state.activeResponse || !state.latestTerminalResponseId) return;
  // A queued, sending or sent-unacked steer may still be accepted and queue an automatic
  // successor ahead of this create; an accepted steer without a pending required input
  // definitively will. Only waiting_for_required_input steers cannot auto-continue.
  if (state.steerQueue.length > 0 || state.steerSending || state.steerInFlight) return;
  if (state.acceptedUnapplied.some((steer) => steer.state === 'accepted')) return;
  const covered = new Set(state.createQueue.flatMap((sub) => sub.coverageKeys));
  for (const key of state.requiredCalls.keys()) {
    if (!covered.has(key)) return;
  }
  const batch = state.createQueue.splice(0);
  const previousResponseId = state.latestTerminalResponseId;
  const frame: Record<string, unknown> = {
    ...state.frozenWireSettings,
    type: 'response.create',
    input: batch.flatMap((sub) => sub.wireItems),
    previous_response_id: previousResponseId,
    store: false
  };
  state.createSending = true;
  void (async () => {
    try {
      await state.lease.acquirePermit(state.options.signal);
    } catch (error) {
      state.createSending = false;
      for (const sub of batch) {
        sub.reject(isAbort(state.options.signal, error)
          ? abortError(state.options.signal)
          : nativeDeliveryError('not_sent', state.released ? 'controller_released' : 'capacity_unavailable', undefined, sub.callIds));
      }
      return;
    }
    // Revalidate the full gate after the capacity wait: a steer accepted meanwhile now expects
    // an automatic successor ahead of this create, and anything else may have ended the chain.
    const covered = new Set(batch.flatMap((sub) => sub.coverageKeys));
    const gateOpen = !state.released
      && !state.endRequested
      && !state.activeResponse
      && state.latestTerminalResponseId !== undefined
      && state.steerQueue.length === 0
      && !state.steerSending
      && !state.steerInFlight
      && !state.acceptedUnapplied.some((steer) => steer.state === 'accepted')
      && [...state.requiredCalls.keys()].every((key) => covered.has(key));
    if (!gateOpen) {
      state.createSending = false;
      state.lease.releasePermit();
      state.createQueue.unshift(...batch);
      notifyNativeOutbox(state);
      return;
    }
    // The permit stays held: the admitted continuation will run a response on this lane.
    state.lease.sendFrame(frame, state.timeouts.sendMs, state.options.signal).then(
      ({ responseCreateSeq }) => {
        state.createSending = false;
        if (state.released) {
          for (const sub of batch) {
            sub.reject(nativeDeliveryError('not_sent', 'controller_released', undefined, sub.callIds));
          }
          return;
        }
        state.createInFlight = {
          batch,
          previousResponseId,
          appliedSteerCount: state.acceptedUnapplied.length,
          ...(responseCreateSeq !== undefined ? { responseCreateSeq } : {})
        };
        notifyNativeOutbox(state);
      },
      (error: unknown) => {
        state.createSending = false;
        for (const sub of batch) {
          sub.reject(isAbort(state.options.signal, error)
            ? abortError(state.options.signal)
            : nativeDeliveryError('not_sent', 'send_failed', undefined, sub.callIds));
        }
      }
    );
  })();
}

function requestNativeLogicalEnd(state: NativeChainState): void {
  if (state.released || state.quiesced) return;
  state.endRequested = true;
  // The kernel has durably disposed of this work; the stream ends at the next response boundary.
  state.outstandingAsyncCalls.clear();
  for (const steer of state.steerQueue.splice(0)) {
    steer.reject(nativeDeliveryError('not_sent', 'logical_request_ended', steer.submissionId));
  }
  for (const sub of state.createQueue.splice(0)) {
    sub.reject(nativeDeliveryError('not_sent', 'logical_request_ended', undefined, sub.callIds));
  }
  notifyNativeOutbox(state);
}

function appendAcceptedSteerInputsToTail(state: NativeChainState): void {
  const applied = state.acceptedUnapplied.splice(0);
  markNativeSteersApplied(state, applied);
  for (const steer of applied) {
    state.chainTail.push(...steer.wireInput);
  }
}

/**
 * Once a continuation exists for an accepted steer (automatic successor or an admitted explicit
 * create), the steer is no longer pending: it transitions to continuing and leaves the ack map,
 * so requiredInputPending recomputes false and a late failure frame is treated as stale.
 */
function markNativeSteersApplied(state: NativeChainState, steers: NativePendingSteer[]): void {
  for (const steer of steers) {
    steer.state = 'continuing';
    if (steer.steerId) state.steersById.delete(steer.steerId);
  }
}

/**
 * Responses the server may still create for a dead lease: continuations of accepted (or possibly
 * accepted) steering, admissions of unacknowledged creates, and the initial response when its
 * created never arrived. The in-flight response itself is already filtered by retired identity.
 */
function countStaleCreatesExpected(state: NativeChainState): number {
  return (state.initialResponseCreateSeq !== undefined && !state.seenAnyResponse ? 1 : 0)
    + state.acceptedUnapplied.length
    + (state.createInFlight ? 1 : 0)
    + (state.steerInFlight ? 1 : 0);
}

/**
 * Connection loss with unresolved steering: sent-unacked and accepted-unapplied submissions are
 * delivery-unknown and surface as response.steer.disconnected observations. Queued-unsent
 * submissions instead reject as `not_sent`; they were never on the wire.
 */
function disconnectNativeSteerChunks(state: NativeChainState): LimCodeOpenAIResponsesStreamChunk[] {
  const events: OpenAIResponsesNativeEvent[] = [];
  if (state.steerInFlight) {
    events.push({
      type: 'response.steer.disconnected',
      responseId: state.steerInFlight.targetResponseId,
      submissionId: state.steerInFlight.submissionId,
      input: state.steerInFlight.input,
      connectionGeneration: state.lease.connectionGeneration,
      ...(state.lease.streamId ? { streamId: state.lease.streamId } : {})
    });
    state.steerInFlight = undefined;
  }
  for (const steer of state.acceptedUnapplied.splice(0)) {
    events.push({
      type: 'response.steer.disconnected',
      responseId: steer.targetResponseId,
      submissionId: steer.submissionId,
      ...(steer.steerId ? { steerId: steer.steerId } : {}),
      input: steer.input,
      connectionGeneration: state.lease.connectionGeneration,
      ...(state.lease.streamId ? { streamId: state.lease.streamId } : {})
    });
  }
  return events.map((nativeEvent) => ({ nativeEvent }));
}

function rejectNativePendingWork(
  state: NativeChainState,
  disposition: 'not_sent' | 'admission_unknown' | 'failed' | 'abort',
  reasonOrError: string | unknown
): void {
  const aborted = disposition === 'abort';
  const reason = typeof reasonOrError === 'string' ? reasonOrError : 'connection_lost';
  for (const steer of state.steerQueue.splice(0)) {
    steer.reject(aborted
      ? abortError(state.options.signal)
      : nativeDeliveryError('not_sent', reason, steer.submissionId));
  }
  for (const sub of state.createQueue.splice(0)) {
    sub.reject(aborted
      ? abortError(state.options.signal)
      : nativeDeliveryError('not_sent', reason, undefined, sub.callIds));
  }
  const inFlight = state.createInFlight;
  state.createInFlight = undefined;
  if (inFlight) {
    for (const sub of inFlight.batch) {
      sub.reject(aborted
        ? abortError(state.options.signal)
        : nativeDeliveryError(
            disposition === 'failed' ? 'failed' : 'admission_unknown',
            reason,
            undefined,
            sub.callIds
          ));
    }
  }
}

function commitNativeContinuation(state: NativeChainState): void {
  const normalizedTail = state.chainTailReliable ? state.chainTail : undefined;
  const outputStateReliable = normalizedTail !== undefined
    && (normalizedTail.length > 0 || !state.sawSemanticOutput);
  if (!state.latestTerminalResponseId || !outputStateReliable || !state.lease.healthy()) {
    invalidateOpenAIResponsesWebSocketContinuation(state.lease.continuation);
    return;
  }
  state.lease.continuation.lastRequest = {
    body: cloneJson(state.prepared.fullBody),
    durableInputItems: state.prepared.durableInputItems.map(cloneJson),
    baseSignature: state.prepared.baseSignature,
    ...(state.prepared.volatileTailLayout ? { volatileTailLayout: state.prepared.volatileTailLayout } : {}),
    ...(state.prepared.nativeAnchoredReasoning !== undefined
      ? { nativeAnchoredReasoning: cloneJson(state.prepared.nativeAnchoredReasoning) }
      : {}),
    ...(state.prepared.nativeEffectiveEffort !== undefined
      ? { nativeEffectiveEffort: state.prepared.nativeEffectiveEffort }
      : {})
  };
  state.lease.continuation.lastResponse = {
    responseId: state.latestTerminalResponseId,
    outputItems: (normalizedTail ?? []).map(cloneJson)
  };
  state.lease.continuation.successfulIncrementalRequests = state.prepared.decision.mode === 'incremental'
    ? state.lease.continuation.successfulIncrementalRequests + 1
    : 0;
}

function buildNativeToolOutputItems(
  outputs: readonly OpenAIResponsesToolOutput[]
): { wireItems: unknown[]; callIds: string[]; coverageKeys: string[] } {
  const wireItems: unknown[] = [];
  const callIds: string[] = [];
  const coverageKeys: string[] = [];
  for (const output of outputs) {
    if (output.type === 'mcp_approval_response') {
      const approvalRequestId = normalizedString(output.approvalRequestId);
      if (!approvalRequestId) throw new Error('mcp_approval_response requires approvalRequestId.');
      wireItems.push({
        type: 'mcp_approval_response',
        approval_request_id: approvalRequestId,
        approve: output.approve === true
      });
      coverageKeys.push(`approval:${approvalRequestId}`);
      continue;
    }
    const callId = normalizedString(output.callId);
    if (!callId) throw new Error(`${output.type} requires callId.`);
    const payload = typeof output.output === 'string'
      ? output.output
      : JSON.stringify(output.output ?? null);
    wireItems.push({ type: output.type, call_id: callId, output: payload });
    callIds.push(callId);
    coverageKeys.push(callId);
  }
  return { wireItems, callIds, coverageKeys };
}

function nativeWireToolResultCallIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.flatMap((item: unknown) =>
    isRecord(item) && (item.type === 'function_call_output' || item.type === 'custom_tool_call_output')
      && typeof item.call_id === 'string' && item.call_id.trim()
      ? [item.call_id]
      : []))];
}

function encodeNativeSteerInput(
  format: OpenAIResponsesFormatAdapter,
  input: OpenAIResponsesSteeringCommand['input']
): unknown[] {
  const contents = input.map((message) => {
    const parts: unknown[] = [];
    for (const part of message.parts) {
      if ('text' in part) {
        if (!part.thought) parts.push({ text: part.text });
      } else if ('inlineData' in part) parts.push({ inlineData: part.inlineData });
      else if ('fileData' in part) parts.push({ fileData: part.fileData });
    }
    return { role: 'user' as const, parts };
  }).filter((content) => content.parts.length > 0);
  if (contents.length === 0) throw new Error('OpenAI Responses steering input must contain user content.');
  // The format encoder owns wire validation; unsupported parts surface as encode_failed.
  const encoded = format.encodeRequest({ contents: contents as Content[] }, false);
  if (!isRecord(encoded) || !Array.isArray(encoded.input) || encoded.input.length === 0) {
    throw new Error('OpenAI Responses steering input encoding failed.');
  }
  return encoded.input.map((item) => stripWebSocketOnlyInputFields(item, true));
}

function collectNativeAsyncToolNames(fullBody: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  if (!Array.isArray(fullBody.tools)) return names;
  for (const tool of fullBody.tools) {
    if (!isRecord(tool) || tool.async !== true) continue;
    const type = normalizedString(tool.type);
    if (type !== 'function' && type !== 'custom') continue;
    const name = normalizedString(tool.name);
    if (name) names.add(name);
  }
  return names;
}

function nativeDeliveryError(
  disposition: 'not_sent' | 'admission_unknown' | 'failed',
  reason: string,
  submissionId?: string,
  callIds?: string[]
): OpenAIResponsesNativeDeliveryError {
  return new OpenAIResponsesNativeDeliveryError(
    disposition,
    `OpenAI Responses native delivery ${disposition}: ${reason}.`,
    {
      ...(submissionId ? { submissionId } : {}),
      ...(callIds && callIds.length > 0 ? { callIds: [...callIds] } : {}),
      reason
    }
  );
}
