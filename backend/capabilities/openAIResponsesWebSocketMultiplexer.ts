import { createHash } from 'crypto';
import WebSocket, { type RawData } from 'ws';
import { captureDebug, associateDebugCapture } from '../reliableKernel/debugCapture/observer';
import type { DebugWebSocketObservation } from '../reliableKernel/debugCapture/webSocketObservation';
import {
  AsyncEventQueue,
  MAX_SOCKET_AGE_MS,
  NETWORK_IDENTITY_CHECK_INTERVAL_MS,
  OpenAIResponsesWebSocketCloseError,
  abortError,
  currentNetworkIdentityFingerprint,
  eventType,
  invalidateOpenAIResponsesWebSocketContinuation,
  isAbort,
  isRecord,
  normalizedString,
  observeOpenAIResponsesWebSocketPhase,
  openSocket,
  parseWebSocketData,
  probeSocket,
  resetOpenAIResponsesWebSocketConnectionState,
  sendWithDeadline,
  startOpenAIResponsesWebSocketHeartbeat,
  structuredTransportError,
  throwIfAborted,
  webSocketConnectionConfig,
  type OpenAIResponsesWebSocketConnectionConfig,
  type OpenAIResponsesWebSocketConnectionReason,
  type OpenAIResponsesWebSocketContinuationState,
  type OpenAIResponsesWebSocketPhase,
  type OpenAIResponsesWebSocketTimeouts
} from './openAIResponsesWebSocketConnection';

/**
 * Genuine connection multiplexing for native Responses conversations.
 *
 * Physical sockets are pooled by exact connection identity (URL, auth headers, proxy and local
 * network fingerprint). Each conversation occupies a named lane (`stream_id`) on one connection:
 * one reader routes every frame to its lane, requests on the same lane stay FIFO and never
 * overlap, and a lane cancellation, request error or timeout never kills unrelated lanes. A
 * connection accepts up to 32 distinct lane names before rolling over to a fresh connection
 * without disturbing active lanes, and at most 16 in-flight responses run per connection:
 * additional lanes wait on abortable client-side slots so their read deadlines only start once
 * the server can actually run them. Physical connection failure invalidates every lane cache on
 * that connection only.
 */

const MAX_NAMED_LANES_PER_CONNECTION = 32;
const MAX_ACTIVE_RESPONSES_PER_CONNECTION = 16;
const MAX_RETAINED_CONNECTIONS = 32;
const IDLE_CONNECTION_TTL_MS = MAX_SOCKET_AGE_MS;

export interface OpenAIResponsesWebSocketLaneLease {
  readonly streamId: string;
  readonly connectionGeneration: number;
  readonly connectionReused: boolean;
  readonly connectionReason: OpenAIResponsesWebSocketConnectionReason;
  /** Lane-owned continuation baseline; committed on quiescent release, invalidated otherwise. */
  readonly continuation: OpenAIResponsesWebSocketContinuationState;
  /** Response IDs the router currently delivers to this lease (includes adopted successors). */
  readonly knownResponseIds: ReadonlySet<string>;
  /**
   * Sends one frame on the owning connection. Resolves with the per-connection response.create
   * sequence for create frames so the chain can stamp traces and native events.
   */
  sendFrame(
    frame: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ responseCreateSeq?: number; frameBytes: number }>;
  /** Routed wire events for this lease; ends on release, fails on connection loss. */
  events(): AsyncIterable<Record<string, unknown>>;
  /** True while the owning connection is open and usable for a continuation commit. */
  healthy(): boolean;
  /**
   * Active-response permits are separate from lane ownership: a lease holds one only while the
   * server may run a response for it, releases it during proven client-input waits, and
   * reacquires (waiting on capacity if needed) before a create/steer that can start a response.
   * Both are idempotent; release() always returns any held permit.
   */
  acquirePermit(signal?: AbortSignal): Promise<void>;
  releasePermit(): void;
  /**
   * Ends the logical request. `staleCreatesExpected` counts continuation responses the server may
   * still produce for this lane (accepted steers, unadmitted creates, in-flight response); their
   * events are swallowed so stale generations can never reach a later lease on this lane.
   */
  release(outcome: 'quiescent' | 'error' | 'abort', staleCreatesExpected: number): void;
}

export interface OpenAIResponsesWebSocketLaneAdmission {
  lease: OpenAIResponsesWebSocketLaneLease;
  connectionReused: boolean;
  connectionReason: OpenAIResponsesWebSocketConnectionReason;
}

export interface OpenAIResponsesWebSocketLaneAcquireOptions {
  sessionKey: string;
  url: string;
  headers: Record<string, string>;
  proxy?: string;
  signal?: AbortSignal;
  timeouts: OpenAIResponsesWebSocketTimeouts;
  /** Reliable retries must never reuse the physical socket that owned the failed attempt. */
  forceNewConnection?: boolean;
  onPhase?: (phase: OpenAIResponsesWebSocketPhase) => void;
  /** Proven local capacity-wait observer; fired exactly on wait enter/leave. */
  onLaneQueueState?: (queued: boolean) => void;
  debug?: DebugWebSocketObservation;
}

interface PooledLane {
  readonly name: string;
  readonly connection: PooledConnection;
  readonly continuation: OpenAIResponsesWebSocketContinuationState;
  readonly retiredResponseIds: Set<string>;
  lease?: MultiplexedLaneLease;
  readonly waiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>;
  staleCreatesExpected: number;
  lastUsedAt: number;
}

interface PooledConnection {
  readonly identityHash: string;
  readonly identityFingerprint: string;
  readonly generation: number;
  socket?: WebSocket;
  connectedAt: number;
  lastPongAt?: number;
  heartbeatTimer?: NodeJS.Timeout;
  networkIdentityTimer?: NodeJS.Timeout;
  readonly lanes: Map<string, PooledLane>;
  /** Logical lane leases owned on this connection (kept across client-input waits). */
  openLeases: number;
  /** Active-response permits in use (≤16 with reservations); held only while a response may run. */
  activeResponsePermits: number;
  /** Permits atomically reserved for dequeued slot waiters, not yet consumed or returned. */
  reservedPermits: number;
  /** FIFO waiters for a max-16 active-response permit on this connection; abortable. */
  readonly slotWaiters: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>;
  responseCreateSeq: number;
  closing: boolean;
  draining: boolean;
  lastUsedAt: number;
  rawSequence: number;
}

interface PoolEntry {
  current?: PooledConnection;
  readonly connections: Set<PooledConnection>;
  /** In-flight physical connection creation shared by concurrent acquirers (check-then-act race). */
  connecting?: Promise<PooledConnection>;
}

const multiplexerPool = new Map<string, PoolEntry>();
let multiplexerConnectionGeneration = 0;

class MultiplexedLaneLease implements OpenAIResponsesWebSocketLaneLease {
  public readonly knownResponseIds = new Set<string>();
  private readonly queue = new AsyncEventQueue<Record<string, unknown>>();
  private released = false;
  private rawSequence = 0;
  private permitHeld = false;

  public constructor(
    private readonly lane: PooledLane,
    public readonly connectionReused: boolean,
    public readonly connectionReason: OpenAIResponsesWebSocketConnectionReason,
    private readonly onLaneQueueState?: (queued: boolean) => void,
    private readonly debug?: DebugWebSocketObservation
  ) {}

  public get streamId(): string {
    return this.lane.name;
  }

  public get connectionGeneration(): number {
    return this.lane.connection.generation;
  }

  public get continuation(): OpenAIResponsesWebSocketContinuationState {
    return this.lane.continuation;
  }

  public get sawAnyEvent(): boolean {
    return this.rawSequence > 0;
  }

  /** The lease starts with a permit for its initial create, granted by the acquire path. */
  public holdInitialPermit(): void {
    this.permitHeld = true;
  }

  public async acquirePermit(signal?: AbortSignal): Promise<void> {
    if (this.permitHeld) return;
    if (this.released) throw new Error('OpenAI Responses WebSocket lane lease is released.');
    const connection = this.lane.connection;
    if (connection.closing) {
      throw structuredTransportError(
        'OpenAI Responses WebSocket connection is unavailable.',
        'websocket_unavailable',
        'streaming',
        this.sawAnyEvent
      );
    }
    if (connection.activeResponsePermits + connection.reservedPermits < MAX_ACTIVE_RESPONSES_PER_CONNECTION
      && connection.slotWaiters.length === 0) {
      connection.activeResponsePermits += 1;
      this.permitHeld = true;
      return;
    }
    this.emitQueueState(true);
    let granted = false;
    try {
      await waitForConnectionSlot(connection, signal);
      granted = true;
      throwIfAborted(signal);
    } catch (error) {
      if (granted) {
        // A reservation granted concurrently with the abort must return to the pool.
        connection.reservedPermits -= 1;
        grantSlotPermits(connection);
      }
      this.emitQueueState(false);
      throw error;
    }
    this.emitQueueState(false);
    if (this.released) {
      connection.reservedPermits -= 1;
      grantSlotPermits(connection);
      throw new Error('OpenAI Responses WebSocket lane lease is released.');
    }
    // The reservation granted to this waiter is consumed into a live permit.
    connection.reservedPermits -= 1;
    connection.activeResponsePermits += 1;
    this.permitHeld = true;
  }

  public releasePermit(): void {
    if (!this.permitHeld) return;
    this.permitHeld = false;
    const connection = this.lane.connection;
    connection.activeResponsePermits = Math.max(0, connection.activeResponsePermits - 1);
    grantSlotPermits(connection);
  }

  private emitQueueState(queued: boolean): void {
    try {
      this.onLaneQueueState?.(queued);
    } catch {
      // Local wait diagnostics must never become capacity authority.
    }
  }

  public async sendFrame(
    frame: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ responseCreateSeq?: number; frameBytes: number }> {
    if (this.released) throw new Error('OpenAI Responses WebSocket lane lease is released.');
    const connection = this.lane.connection;
    const socket = connection.socket;
    if (connection.closing || !socket || socket.readyState !== WebSocket.OPEN) {
      throw structuredTransportError(
        'OpenAI Responses WebSocket connection is unavailable.',
        'websocket_unavailable',
        'streaming',
        this.sawAnyEvent
      );
    }
    const isCreate = eventType(frame) === 'response.create';
    const responseCreateSeq = isCreate ? ++connection.responseCreateSeq : undefined;
    const payloadText = JSON.stringify(frame);
    captureDebug(this.debug?.recorder, this.debug?.context, () => ({
      stage: 'transport.send',
      payload: payloadText,
      metadata: {
        ...this.debug?.metadata,
        ...(responseCreateSeq !== undefined ? { responseCreateSeq } : {})
      }
    }));
    await sendWithDeadline(socket, payloadText, timeoutMs, signal);
    return { frameBytes: Buffer.byteLength(payloadText, 'utf8'), ...(responseCreateSeq !== undefined ? { responseCreateSeq } : {}) };
  }

  public events(): AsyncIterable<Record<string, unknown>> {
    return this.queue;
  }

  public healthy(): boolean {
    const connection = this.lane.connection;
    return !connection.closing && connection.socket?.readyState === WebSocket.OPEN;
  }

  /** Router entry point: capture then enqueue a frame already filtered for this lease. */
  public deliverFrame(value: Record<string, unknown>, data: RawData): void {
    if (this.released) return;
    this.rawSequence += 1;
    const received = captureDebug(this.debug?.recorder, this.debug?.context, () => ({
      stage: 'transport.receive',
      bytes: data,
      metadata: { ...this.debug?.metadata, rawSequence: this.rawSequence }
    }));
    if (received) associateDebugCapture(value, [received]);
    this.queue.push(value);
  }

  public failQueue(error: Error): void {
    this.queue.fail(error);
  }

  public release(outcome: 'quiescent' | 'error' | 'abort', staleCreatesExpected: number): void {
    if (this.released) return;
    this.released = true;
    const lane = this.lane;
    const connection = lane.connection;
    if (lane.lease === this) lane.lease = undefined;
    this.releasePermit();
    connection.openLeases = Math.max(0, connection.openLeases - 1);
    lane.staleCreatesExpected += Math.max(0, staleCreatesExpected);
    for (const id of this.knownResponseIds) lane.retiredResponseIds.add(id);
    this.knownResponseIds.clear();
    if (outcome !== 'quiescent') invalidateOpenAIResponsesWebSocketContinuation(lane.continuation);
    this.queue.end();
    lane.lastUsedAt = Date.now();
    connection.lastUsedAt = Date.now();
    const waiter = lane.waiters.shift();
    waiter?.resolve();
    if (connection.draining && connection.openLeases === 0) closePooledConnection(connection);
  }
}

export async function acquireOpenAIResponsesWebSocketLane(
  options: OpenAIResponsesWebSocketLaneAcquireOptions
): Promise<OpenAIResponsesWebSocketLaneAdmission> {
  const config = webSocketConnectionConfig(options);
  const streamId = laneNameForSessionKey(options.sessionKey);
  const entry = poolEntryFor(config.identityHash);
  const phaseSource = { key: options.sessionKey, connectionGeneration: 0 };
  const queuedAt = Date.now();
  observeOpenAIResponsesWebSocketPhase(phaseSource, options.onPhase, 'lock_wait', { streamId });
  let queueStateEmitted = false;
  const setQueueState = (queued: boolean) => {
    if (queueStateEmitted === queued) return;
    queueStateEmitted = queued;
    try {
      options.onLaneQueueState?.(queued);
    } catch {
      // Local wait diagnostics must never become capacity authority or fail acquisition.
    }
  };

  let slotPermitConnection: PooledConnection | undefined;
  try {
    for (;;) {
      throwIfAborted(options.signal);
      evictIdleConnections();
      const { connection, connectionReused, connectionReason } = await resolveConnection(
        entry,
        config,
        streamId,
        options
      );
      const source = { key: options.sessionKey, connectionGeneration: connection.generation };
      let lane = connection.lanes.get(streamId);
      if (!lane) {
        lane = {
          name: streamId,
          connection,
          continuation: { successfulIncrementalRequests: 0 },
          retiredResponseIds: new Set(),
          waiters: [],
          staleCreatesExpected: 0,
          lastUsedAt: Date.now()
        };
        connection.lanes.set(streamId, lane);
      }
      if (!lane.lease) {
        if (!slotPermitConnection
          && (connection.activeResponsePermits + connection.reservedPermits
              >= MAX_ACTIVE_RESPONSES_PER_CONNECTION
            || connection.slotWaiters.length > 0)) {
          // Client-side max-16 in-flight enforcement: wait for a permit instead of letting a
          // queued create burn first-event/semantic deadlines without a proved client queue state.
          setQueueState(true);
          await waitForConnectionSlot(connection, options.signal);
          slotPermitConnection = connection;
          continue;
        }
        if (slotPermitConnection) {
          if (slotPermitConnection !== connection) {
            // The reservation belongs to a rotated connection: return it and re-qualify here.
            slotPermitConnection.reservedPermits -= 1;
            grantSlotPermits(slotPermitConnection);
            slotPermitConnection = undefined;
            continue;
          }
          connection.reservedPermits -= 1;
          slotPermitConnection = undefined;
        }
        const lease = new MultiplexedLaneLease(
          lane,
          connectionReused,
          connectionReason,
          options.onLaneQueueState,
          options.debug
        );
        connection.activeResponsePermits += 1;
        lease.holdInitialPermit();
        lane.lease = lease;
        connection.openLeases += 1;
        connection.lastUsedAt = Date.now();
        lane.lastUsedAt = Date.now();
        observeOpenAIResponsesWebSocketPhase(source, options.onPhase, 'lock_acquired', {
          elapsedMs: Date.now() - queuedAt,
          streamId,
          connectionReused,
          connectionReason
        });
        setQueueState(false);
        return { lease, connectionReused, connectionReason };
      }
      setQueueState(true);
      await waitForLaneRelease(lane, options.signal);
    }
  } catch (error) {
    setQueueState(false);
    if (slotPermitConnection) {
      slotPermitConnection.reservedPermits -= 1;
      grantSlotPermits(slotPermitConnection);
    }
    throw error;
  }
}

/** Test/reset hook: terminates every pooled connection and forgets all lane caches. */
export function resetOpenAIResponsesWebSocketMultiplexer(): void {
  for (const entry of multiplexerPool.values()) {
    for (const connection of entry.connections) teardownPooledConnection(connection);
  }
  multiplexerPool.clear();
  resetOpenAIResponsesWebSocketConnectionState();
}

function laneNameForSessionKey(sessionKey: string): string {
  return `lane-${createHash('sha256').update(sessionKey).digest('hex').slice(0, 24)}`;
}

function poolEntryFor(identityHash: string): PoolEntry {
  const existing = multiplexerPool.get(identityHash);
  if (existing) return existing;
  const entry: PoolEntry = { connections: new Set() };
  multiplexerPool.set(identityHash, entry);
  return entry;
}

async function resolveConnection(
  entry: PoolEntry,
  config: OpenAIResponsesWebSocketConnectionConfig,
  streamId: string,
  options: OpenAIResponsesWebSocketLaneAcquireOptions
): Promise<{
  connection: PooledConnection;
  connectionReused: boolean;
  connectionReason: OpenAIResponsesWebSocketConnectionReason;
}> {
  const existing = entry.current;
  let connectionReason: OpenAIResponsesWebSocketConnectionReason = 'reused';
  let replacementReason: OpenAIResponsesWebSocketConnectionReason | undefined;
  if (existing && !existing.closing) {
    const expired = Date.now() - existing.connectedAt >= MAX_SOCKET_AGE_MS;
    const ownsLane = existing.lanes.has(streamId);
    const acceptsNewName = ownsLane || (!existing.draining && existing.lanes.size < MAX_NAMED_LANES_PER_CONNECTION);
    if (options.forceNewConnection === true) {
      // A reliable retry never reuses the physical socket that owned the failed attempt. Active
      // lanes keep running on the old connection, which drains and closes once idle.
      replacementReason = 'retry_forced_reconnect';
    } else if (expired) {
      replacementReason = 'socket_expired';
    } else if (!acceptsNewName) {
      // Named-lane capacity rollover: the old connection keeps its active lanes untouched.
      replacementReason = 'new_connection';
    } else {
      const lastHealthAt = existing.lastPongAt ?? existing.connectedAt;
      let unhealthy = false;
      if (Date.now() - lastHealthAt >= options.timeouts.preSendProbeStaleMs) {
        const source = { key: options.sessionKey, connectionGeneration: existing.generation };
        const startedAt = Date.now();
        observeOpenAIResponsesWebSocketPhase(source, options.onPhase, 'socket_probe_started', { streamId });
        try {
          await probeSocket(existing.socket as WebSocket, options.timeouts.preSendProbeTimeoutMs, options.signal);
          existing.lastPongAt = Date.now();
          observeOpenAIResponsesWebSocketPhase(source, options.onPhase, 'socket_probe_succeeded', {
            elapsedMs: Date.now() - startedAt,
            streamId
          });
        } catch (error) {
          if (isAbort(options.signal, error)) throw error;
          unhealthy = true;
          replacementReason = 'socket_unhealthy';
        }
      }
      if (!unhealthy && !existing.closing && existing.socket?.readyState === WebSocket.OPEN) {
        const source = { key: options.sessionKey, connectionGeneration: existing.generation };
        observeOpenAIResponsesWebSocketPhase(source, options.onPhase, 'socket_reused', {
          streamId,
          connectionReused: true,
          connectionReason
        });
        return { connection: existing, connectionReused: true, connectionReason };
      }
      if (!unhealthy) replacementReason = 'new_connection';
    }
    if (replacementReason) {
      existing.draining = true;
      if (existing.openLeases === 0) closePooledConnection(existing);
      if (entry.current === existing) entry.current = undefined;
    }
  }

  const reason = replacementReason ?? 'new_connection';
  // Concurrent first-time or post-rotation acquirers must share one in-flight creation instead of
  // each opening their own socket: register the promise synchronously before awaiting it.
  if (!entry.connecting) {
    const connecting = openPooledConnection(entry, config, options, streamId, reason);
    entry.connecting = connecting;
    void connecting.then(
      () => {
        if (entry.connecting === connecting) entry.connecting = undefined;
      },
      () => {
        if (entry.connecting === connecting) entry.connecting = undefined;
      }
    );
  }
  const connection = await entry.connecting;
  return { connection, connectionReused: false, connectionReason: reason };
}

async function openPooledConnection(
  entry: PoolEntry,
  config: OpenAIResponsesWebSocketConnectionConfig,
  options: OpenAIResponsesWebSocketLaneAcquireOptions,
  streamId: string,
  reason: OpenAIResponsesWebSocketConnectionReason
): Promise<PooledConnection> {
  const generation = ++multiplexerConnectionGeneration;
  const source = { key: options.sessionKey, connectionGeneration: generation };
  observeOpenAIResponsesWebSocketPhase(source, options.onPhase, 'socket_opening', {
    streamId,
    connectionReused: false,
    connectionReason: reason
  });
  const socket = await openSocket(config, options.timeouts.handshakeMs, options.signal);
  const connection: PooledConnection = {
    identityHash: config.identityHash,
    identityFingerprint: currentNetworkIdentityFingerprint(),
    generation,
    socket,
    connectedAt: Date.now(),
    lanes: new Map(),
    openLeases: 0,
    activeResponsePermits: 0,
    reservedPermits: 0,
    slotWaiters: [],
    responseCreateSeq: 0,
    closing: false,
    draining: false,
    lastUsedAt: Date.now(),
    rawSequence: 0
  };
  entry.connections.add(connection);
  entry.current = connection;
  attachConnectionRouter(connection);
  startOpenAIResponsesWebSocketHeartbeat(connection, socket, options.timeouts, () => {
    if (connection.socket !== socket) return;
    try {
      socket.terminate();
    } catch { /* noop */ }
    failPooledConnection(
      connection,
      new OpenAIResponsesWebSocketCloseError(1006, 'heartbeat failed', 'streaming', false)
    );
  });
  startNetworkIdentityWatch(connection);
  evictOverflowConnections();
  observeOpenAIResponsesWebSocketPhase(source, options.onPhase, 'socket_opened', {
    streamId,
    connectionReused: false,
    connectionReason: reason
  });
  return connection;
}

function attachConnectionRouter(connection: PooledConnection): void {
  const socket = connection.socket as WebSocket;
  socket.on('message', (data) => {
    connection.lastUsedAt = Date.now();
    const parsed = parseWebSocketData(data);
    if (!parsed.ok) {
      failPooledConnection(connection, parsed.error);
      return;
    }
    routeFrame(connection, parsed.value, data);
  });
  socket.once('error', (error: Error) => {
    const wrapped = structuredTransportError(
      error.message || 'OpenAI Responses WebSocket transport error.',
      typeof (error as Error & { code?: unknown }).code === 'string'
        ? (error as Error & { code: string }).code
        : 'websocket_error',
      'streaming',
      connection.rawSequence > 0
    );
    (wrapped as Error & { cause?: unknown }).cause = error;
    failPooledConnection(connection, wrapped);
  });
  socket.once('close', (code: number, reason: Buffer) => {
    failPooledConnection(
      connection,
      new OpenAIResponsesWebSocketCloseError(code, reason.toString('utf8').trim(), 'streaming', connection.rawSequence > 0)
    );
  });
}

function routeFrame(connection: PooledConnection, value: Record<string, unknown>, data: RawData): void {
  connection.rawSequence += 1;
  const streamId = normalizedString(value.stream_id);
  if (streamId) {
    const lane = connection.lanes.get(streamId);
    if (lane) deliverToLane(lane, value, data);
    return;
  }
  const type = eventType(value);
  if (type === 'response.steer.accepted' || type === 'response.steer.pending' || type === 'response.steer.failed') {
    // Steering events carry no stream_id; route by the steered response's owning lane.
    const steer = isRecord(value.steer) ? value.steer : undefined;
    const target = steer ? normalizedString(steer.previous_response_id) : undefined;
    if (target) {
      for (const lane of connection.lanes.values()) {
        if (lane.lease?.knownResponseIds.has(target)) {
          lane.lease.deliverFrame(value, data);
          return;
        }
      }
    }
    return;
  }
  if (type === 'error') {
    // Connection-scoped errors (for example the 60-minute connection limit) reach every lane.
    for (const lane of connection.lanes.values()) lane.lease?.deliverFrame(value, data);
    connection.draining = true;
  }
  // Any other frame without a lane name belongs to the implicit default lane, which native
  // multiplexed traffic never uses; dropping it cannot corrupt a named lane.
}

function deliverToLane(lane: PooledLane, value: Record<string, unknown>, data: RawData): void {
  const type = eventType(value);
  const responseId = responseIdFromPayloadLocal(value);
  if (responseId && lane.retiredResponseIds.has(responseId)) return;
  const lease = lane.lease;
  if (type === 'response.created' && responseId && !lease?.knownResponseIds.has(responseId)) {
    if (lane.staleCreatesExpected > 0) {
      // A continuation the previous lease on this lane still expected; swallow it and retire the
      // id so its remaining events can never reach the next lease.
      lane.staleCreatesExpected -= 1;
      lane.retiredResponseIds.add(responseId);
      return;
    }
    lease?.knownResponseIds.add(responseId);
  } else if (responseId && !lease?.knownResponseIds.has(responseId)) {
    // Events for a response this lease never adopted are stale by definition.
    return;
  }
  lease?.deliverFrame(value, data);
}

function responseIdFromPayloadLocal(raw: Record<string, unknown>): string | undefined {
  return normalizedString(raw.response_id)
    ?? (isRecord(raw.response) ? normalizedString(raw.response.id) : undefined)
    ?? (eventType(raw) === 'response.created' ? normalizedString(raw.id) : undefined);
}

function startNetworkIdentityWatch(connection: PooledConnection): void {
  const timer = setInterval(() => {
    if (connection.closing) {
      clearInterval(timer);
      return;
    }
    try {
      if (currentNetworkIdentityFingerprint() !== connection.identityFingerprint) {
        failPooledConnection(connection, structuredTransportError(
          'OpenAI Responses WebSocket local network changed.',
          'network_changed',
          'streaming',
          connection.rawSequence > 0
        ));
      }
    } catch {
      // A transient failure to enumerate interfaces is not itself network authority.
    }
  }, NETWORK_IDENTITY_CHECK_INTERVAL_MS);
  timer.unref?.();
  connection.networkIdentityTimer = timer;
}

function failPooledConnection(connection: PooledConnection, error: Error): void {
  if (connection.closing) return;
  connection.closing = true;
  clearInterval(connection.networkIdentityTimer);
  clearInterval(connection.heartbeatTimer);
  for (const lane of connection.lanes.values()) {
    // Physical connection failure invalidates every lane cache on this connection.
    invalidateOpenAIResponsesWebSocketContinuation(lane.continuation);
    const lease = lane.lease;
    lane.lease = undefined;
    if (lease) {
      const scoped = error instanceof OpenAIResponsesWebSocketCloseError
        ? new OpenAIResponsesWebSocketCloseError(
            error.closeCode,
            error.closeReason,
            lease.sawAnyEvent ? 'streaming' : 'awaiting_first_event',
            lease.sawAnyEvent
          )
        : error;
      lease.failQueue(scoped);
    }
    const waiters = lane.waiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }
  removeFromPool(connection);
  const slotWaiters = connection.slotWaiters.splice(0);
  for (const waiter of slotWaiters) waiter.reject(error);
  const socket = connection.socket;
  connection.socket = undefined;
  try {
    socket?.terminate();
  } catch { /* noop */ }
}

function closePooledConnection(connection: PooledConnection): void {
  if (connection.closing) return;
  connection.closing = true;
  clearInterval(connection.networkIdentityTimer);
  clearInterval(connection.heartbeatTimer);
  removeFromPool(connection);
  const socket = connection.socket;
  connection.socket = undefined;
  try {
    socket?.close();
  } catch { /* noop */ }
}

function teardownPooledConnection(connection: PooledConnection): void {
  if (!connection.closing) {
    connection.closing = true;
    clearInterval(connection.networkIdentityTimer);
    clearInterval(connection.heartbeatTimer);
    for (const lane of connection.lanes.values()) {
      lane.lease?.failQueue(new Error('OpenAI Responses WebSocket multiplexer reset.'));
      lane.lease = undefined;
      const waiters = lane.waiters.splice(0);
      for (const waiter of waiters) waiter.reject(new Error('OpenAI Responses WebSocket multiplexer reset.'));
    }
    const slotWaiters = connection.slotWaiters.splice(0);
    for (const waiter of slotWaiters) {
      waiter.reject(new Error('OpenAI Responses WebSocket multiplexer reset.'));
    }
  }
  const socket = connection.socket;
  connection.socket = undefined;
  try {
    socket?.terminate();
  } catch { /* noop */ }
}

function removeFromPool(connection: PooledConnection): void {
  const entry = multiplexerPool.get(connection.identityHash);
  if (!entry) return;
  entry.connections.delete(connection);
  if (entry.current === connection) entry.current = undefined;
  if (entry.connections.size === 0) multiplexerPool.delete(connection.identityHash);
}

function evictIdleConnections(now = Date.now()): void {
  for (const entry of multiplexerPool.values()) {
    for (const connection of entry.connections) {
      if (connection.openLeases > 0) continue;
      if (now - connection.lastUsedAt < IDLE_CONNECTION_TTL_MS) continue;
      closePooledConnection(connection);
    }
  }
}

function evictOverflowConnections(): void {
  let total = 0;
  for (const entry of multiplexerPool.values()) total += entry.connections.size;
  if (total <= MAX_RETAINED_CONNECTIONS) return;
  const idle: PooledConnection[] = [];
  for (const entry of multiplexerPool.values()) {
    for (const connection of entry.connections) {
      if (connection.openLeases === 0) idle.push(connection);
    }
  }
  idle.sort((left, right) => left.lastUsedAt - right.lastUsedAt);
  for (const connection of idle.slice(0, Math.max(0, total - MAX_RETAINED_CONNECTIONS))) {
    closePooledConnection(connection);
  }
}

/**
 * Grants freed active-response permits to queued waiters as atomic reservations. The dequeued
 * waiter holds its reservation across its re-qualification loop, so remaining waiters can never
 * bounce it back into the queue while capacity is free.
 */
function grantSlotPermits(connection: PooledConnection): void {
  while (connection.slotWaiters.length > 0
    && connection.activeResponsePermits + connection.reservedPermits
      < MAX_ACTIVE_RESPONSES_PER_CONNECTION) {
    connection.reservedPermits += 1;
    connection.slotWaiters.shift()?.resolve();
  }
}

async function waitForConnectionSlot(connection: PooledConnection, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      const index = connection.slotWaiters.indexOf(waiter);
      if (index >= 0) connection.slotWaiters.splice(index, 1);
      reject(abortError(signal));
    };
    const waiter = {
      resolve: () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      reject: (error: Error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      }
    };
    connection.slotWaiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForLaneRelease(lane: PooledLane, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      const index = lane.waiters.indexOf(waiter);
      if (index >= 0) lane.waiters.splice(index, 1);
      reject(abortError(signal));
    };
    const waiter = {
      resolve: () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      reject: (error: Error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      }
    };
    lane.waiters.push(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
