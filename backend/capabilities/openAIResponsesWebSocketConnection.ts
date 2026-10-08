import { createHash } from 'crypto';
import { networkInterfaces } from 'os';
import { HttpsProxyAgent } from 'https-proxy-agent';
import WebSocket, { type RawData } from 'ws';
import { isRetryableOpenAIResponsesWebSocketClose } from './openAIResponsesWebSocketRetryPolicy';

/**
 * Low-level OpenAI Responses WebSocket connection mechanics shared by the exclusive session
 * transport and the native multiplexed lane pool. Everything here is connection-scoped and free
 * of per-request conversation state.
 */

export const MAX_SOCKET_AGE_MS = 55 * 60 * 1_000;
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
export const DEFAULT_SEND_TIMEOUT_MS = 10_000;
export const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 120_000;
export const DEFAULT_EVENT_IDLE_TIMEOUT_MS = 120_000;
export const DEFAULT_RESPONSE_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
export const DEFAULT_PONG_TIMEOUT_MS = 60_000;
export const DEFAULT_PRE_SEND_PROBE_STALE_MS = 45_000;
export const DEFAULT_PRE_SEND_PROBE_TIMEOUT_MS = 2_000;
export const NETWORK_IDENTITY_CHECK_INTERVAL_MS = 2_000;

export type OpenAIResponsesWebSocketConnectionReason =
  | 'reused'
  | 'new_connection'
  | 'retry_forced_reconnect'
  | 'socket_expired'
  | 'socket_unhealthy'
  | 'handshake_identity_changed';

export type OpenAIResponsesWebSocketPhaseKind =
  | 'lock_wait'
  | 'lock_acquired'
  | 'socket_opening'
  | 'socket_reused'
  | 'socket_opened'
  | 'socket_probe_started'
  | 'socket_probe_succeeded'
  | 'send_started'
  | 'request_sent'
  | 'first_raw_event'
  | 'first_semantic_event'
  | 'terminal'
  | 'timeout'
  | 'abort'
  | 'transport_error';

export interface OpenAIResponsesWebSocketPhase {
  phase: OpenAIResponsesWebSocketPhaseKind;
  observedAt: number;
  sessionKeyHash: string;
  connectionGeneration: number;
  elapsedMs?: number;
  connectionReused?: boolean;
  connectionReason?: OpenAIResponsesWebSocketConnectionReason;
  mode?: 'full' | 'incremental';
  reason?: string;
  timeoutPhase?: OpenAIResponsesWebSocketTimeoutPhase;
  responseCreateFrameBytes?: number;
  responseCreateSeq?: number;
  streamId?: string;
}

/** Minimal phase-observation identity; sessions and multiplexed lanes both satisfy it. */
export interface OpenAIResponsesWebSocketPhaseSource {
  key: string;
  connectionGeneration: number;
}

export function observeOpenAIResponsesWebSocketPhase(
  source: OpenAIResponsesWebSocketPhaseSource,
  onPhase: ((phase: OpenAIResponsesWebSocketPhase) => void) | undefined,
  phase: OpenAIResponsesWebSocketPhaseKind,
  detail: Partial<OpenAIResponsesWebSocketPhase> = {}
): void {
  if (!onPhase) return;
  const observation: OpenAIResponsesWebSocketPhase = {
    ...detail,
    phase,
    observedAt: Date.now(),
    sessionKeyHash: createHash('sha256').update(source.key).digest('hex').slice(0, 12),
    connectionGeneration: detail.connectionGeneration ?? source.connectionGeneration
  };
  try {
    onPhase(observation);
  } catch {
    // Diagnostics must never become transport authority or fail a provider request.
  }
}

export function observeOpenAIResponsesWebSocketFailure(
  source: OpenAIResponsesWebSocketPhaseSource,
  onPhase: ((phase: OpenAIResponsesWebSocketPhase) => void) | undefined,
  signal: AbortSignal | undefined,
  error: unknown
): void {
  const timeout = error instanceof OpenAIResponsesWebSocketTimeoutError ? error : undefined;
  const aborted = isAbort(signal, error);
  observeOpenAIResponsesWebSocketPhase(
    source,
    onPhase,
    timeout ? 'timeout' : aborted ? 'abort' : 'transport_error',
    {
      ...(timeout ? { timeoutPhase: timeout.phase } : {}),
      reason: timeout ? `timeout_${timeout.phase}` : aborted ? 'signal_aborted' : errorName(error)
    }
  );
}

export function errorName(error: unknown): string {
  if (error instanceof Error && error.name.trim()) return error.name.trim();
  return typeof error === 'string' && error.trim() ? 'Error' : 'UnknownError';
}

export interface OpenAIResponsesWebSocketTimeouts {
  handshakeMs: number;
  sendMs: number;
  firstEventMs: number;
  eventIdleMs: number;
  responseMs: number;
  heartbeatIntervalMs: number;
  pongTimeoutMs: number;
  preSendProbeStaleMs: number;
  preSendProbeTimeoutMs: number;
}

export type OpenAIResponsesWebSocketTimeoutPhase =
  | 'handshake'
  | 'send'
  | 'health_probe'
  | 'first_event'
  | 'event_idle'
  | 'response';

export class OpenAIResponsesWebSocketTimeoutError extends Error {
  public readonly code = 'LLM_TRANSPORT_TIMEOUT';
  public readonly transport = 'websocket';
  public readonly retryable = true;
  public readonly transportAttemptsExhausted = false;
  public readonly receivedServerEvent: boolean;
  public receivedSemanticOutput = false;

  public constructor(
    public readonly phase: OpenAIResponsesWebSocketTimeoutPhase,
    public readonly timeoutMs: number,
    receivedServerEvent = false
  ) {
    super(`OpenAI Responses WebSocket ${phase} timed out after ${timeoutMs}ms.`);
    this.name = 'OpenAIResponsesWebSocketTimeoutError';
    this.receivedServerEvent = receivedServerEvent;
  }
}

export class OpenAIResponsesWebSocketCloseError extends Error {
  public readonly transport = 'websocket';
  public readonly retryable: boolean;
  public readonly transportAttemptsExhausted = false;
  public receivedSemanticOutput = false;

  public constructor(
    public readonly closeCode: number,
    public readonly closeReason: string,
    public readonly phase: 'connecting' | 'awaiting_first_event' | 'streaming',
    public readonly receivedServerEvent: boolean
  ) {
    super(`OpenAI Responses WebSocket closed before terminal event: ${closeCode}${closeReason ? ` ${closeReason}` : ''}`);
    this.name = 'WebSocketCloseError';
    this.retryable = isRetryableOpenAIResponsesWebSocketClose(closeCode, closeReason);
  }
}

export function structuredTransportError(
  message: string,
  code: string,
  phase: 'connecting' | 'awaiting_first_event' | 'streaming',
  receivedServerEvent: boolean
): Error {
  return Object.assign(new Error(message), {
    code,
    transport: 'websocket' as const,
    phase,
    receivedServerEvent,
    receivedSemanticOutput: false,
    retryable: true,
    transportAttemptsExhausted: false
  });
}

export interface OpenAIResponsesWebSocketConnectionConfig {
  url: string;
  headers: Record<string, string>;
  proxy?: string;
  identityHash: string;
}

export interface OpenAIResponsesWebSocketLastRequestState {
  durableInputItems: unknown[];
  baseSignature: string;
  volatileTailLayout?: string;
  /** Native mode: reasoning object sent on the wire when this baseline's prefix was anchored. */
  nativeAnchoredReasoning?: unknown;
  /** Native mode: effective reasoning effort after applied configuration_update items. */
  nativeEffectiveEffort?: string;
}

export interface OpenAIResponsesWebSocketLastResponseState {
  responseId: string;
  outputItems: unknown[];
}

/**
 * Connection-local continuation baseline. Exclusive sessions and multiplexed lanes each own one;
 * it is an optimization cache, never authority, and is invalidated on any uncertainty.
 */
export interface OpenAIResponsesWebSocketContinuationState {
  lastRequest?: OpenAIResponsesWebSocketLastRequestState;
  lastResponse?: OpenAIResponsesWebSocketLastResponseState;
  successfulIncrementalRequests: number;
}

export function invalidateOpenAIResponsesWebSocketContinuation(
  state: OpenAIResponsesWebSocketContinuationState
): void {
  state.lastRequest = undefined;
  state.lastResponse = undefined;
  state.successfulIncrementalRequests = 0;
}

const proxyAgents = new Map<string, HttpsProxyAgent<string>>();

/** Clears process-local proxy agent cache; called by session/pool reset entry points. */
export function resetOpenAIResponsesWebSocketConnectionState(): void {
  proxyAgents.clear();
}

export function webSocketConnectionConfig(options: {
  url: string;
  headers: Record<string, string>;
  proxy?: string;
}): OpenAIResponsesWebSocketConnectionConfig {
  const url = toWebSocketUrl(options.url);
  const headers = webSocketHeaders(options.headers);
  const proxy = normalizeProxyUrl(options.proxy);
  return {
    url,
    headers,
    ...(proxy ? { proxy } : {}),
    identityHash: canonicalHash({
      url,
      headers,
      proxy: proxy ?? null,
      networkIdentityFingerprint: currentNetworkIdentityFingerprint()
    })
  };
}

export function currentNetworkIdentityFingerprint(): string {
  let addresses: string[];
  try {
    addresses = Object.entries(networkInterfaces())
      .flatMap(([name, records]) => (records ?? [])
        .filter((record) => !record.internal)
        .map((record) => [
          name,
          String(record.family),
          record.address,
          record.netmask,
          record.cidr ?? '',
          String(record.scopeid ?? '')
        ].join(':')))
      .sort();
  } catch {
    addresses = ['network-interfaces-unavailable'];
  }
  return createHash('sha256')
    .update(addresses.length > 0 ? addresses.join('\n') : 'no-external-network')
    .digest('hex');
}

export function webSocketHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    if (normalized === 'content-type' || normalized === 'content-length'
      || normalized === 'connection' || normalized === 'upgrade'
      || normalized.startsWith('sec-websocket-')) continue;
    result[normalized] = value;
  }
  return result;
}

export function normalizeProxyUrl(proxy?: string): string | undefined {
  const normalized = proxy?.trim();
  return normalized ? new URL(normalized).toString() : undefined;
}

export function proxyAgent(proxy?: string): HttpsProxyAgent<string> | undefined {
  const normalized = proxy?.trim();
  if (!normalized) return undefined;
  const cached = proxyAgents.get(normalized);
  if (cached) return cached;
  const agent = new HttpsProxyAgent(normalized, { rejectUnauthorized: false });
  proxyAgents.set(normalized, agent);
  return agent;
}

export function toWebSocketUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  return url.toString();
}

export async function openSocket(
  connection: OpenAIResponsesWebSocketConnectionConfig,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<WebSocket> {
  throwIfAborted(signal);
  const agent = proxyAgent(connection.proxy);
  return new Promise<WebSocket>((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(connection.url, {
      headers: connection.headers,
      perMessageDeflate: false,
      ...(agent ? { agent } : {}),
      ...(connection.proxy ? { rejectUnauthorized: false } : {})
    });
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        try { socket.terminate(); } catch { /* noop */ }
        reject(error);
      } else resolve(socket);
    };
    const onAbort = () => finish(abortError(signal));
    const onOpen = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = (code: number, reason: Buffer) => finish(
      new OpenAIResponsesWebSocketCloseError(code, reason.toString('utf8').trim(), 'connecting', false)
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(
      () => finish(new OpenAIResponsesWebSocketTimeoutError('handshake', timeoutMs)),
      timeoutMs
    );
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

export interface OpenAIResponsesWebSocketHeartbeatHandle {
  socket?: WebSocket;
  connectedAt?: number;
  lastPongAt?: number;
  heartbeatTimer?: NodeJS.Timeout;
}

/**
 * Heartbeat semantics shared by sessions and pooled connections. `invalidateOwnedSocket` runs
 * only when the handle still owns `socket`; the owner performs its own teardown inside it.
 */
export function startOpenAIResponsesWebSocketHeartbeat(
  handle: OpenAIResponsesWebSocketHeartbeatHandle,
  socket: WebSocket,
  timeouts: OpenAIResponsesWebSocketTimeouts,
  invalidateOwnedSocket: () => void
): void {
  clearInterval(handle.heartbeatTimer);
  handle.lastPongAt = Date.now();

  socket.on('pong', () => {
    if (handle.socket === socket) handle.lastPongAt = Date.now();
  });
  socket.on('error', invalidateOwnedSocket);
  socket.on('close', invalidateOwnedSocket);

  const heartbeat = setInterval(() => {
    if (handle.socket !== socket) {
      clearInterval(heartbeat);
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      invalidateOwnedSocket();
      return;
    }
    const lastPongAt = handle.lastPongAt ?? handle.connectedAt ?? 0;
    if (Date.now() - lastPongAt >= timeouts.pongTimeoutMs) {
      invalidateOwnedSocket();
      return;
    }
    try {
      socket.ping((error?: Error) => {
        if (error) invalidateOwnedSocket();
      });
    } catch {
      invalidateOwnedSocket();
    }
  }, timeouts.heartbeatIntervalMs);
  heartbeat.unref?.();
  handle.heartbeatTimer = heartbeat;
}

export function probeSocket(socket: WebSocket, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      socket.off('pong', onPong);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(abortError(signal));
    const onPong = () => finish();
    const onError = (error: Error) => finish(error);
    const onClose = (code: number, reason: Buffer) => finish(
      new OpenAIResponsesWebSocketCloseError(code, reason.toString('utf8').trim(), 'connecting', false)
    );
    const timeout = setTimeout(
      () => finish(new OpenAIResponsesWebSocketTimeoutError('health_probe', timeoutMs)),
      timeoutMs
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once('pong', onPong);
    socket.once('error', onError);
    socket.once('close', onClose);
    try {
      socket.ping((error?: Error) => {
        if (error) finish(error);
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function sendWithDeadline(
  socket: WebSocket,
  payload: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onAbort = () => finish(abortError(signal));
    const timeout = setTimeout(
      () => finish(new OpenAIResponsesWebSocketTimeoutError('send', timeoutMs)),
      timeoutMs
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.send(payload, (error) => finish(error ?? undefined));
  });
}

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly items: Array<{ value?: T; done?: true; error?: Error }> = [];
  private readonly waiters: Array<(item: { value?: T; done?: true; error?: Error }) => void> = [];
  private closed = false;

  public push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value });
      return;
    }
    this.items.push({ value });
  }

  public end(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit({ done: true });
  }

  public fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.emit({ error });
  }

  private emit(item: { value?: T; done?: true; error?: Error }): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  public async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const item = this.items.shift() ?? await new Promise<{
        value?: T;
        done?: true;
        error?: Error;
      }>((resolve) => this.waiters.push(resolve));
      if (item.error) throw item.error;
      if (item.done) return;
      if (item.value !== undefined) yield item.value;
    }
  }
}

export function parseWebSocketData(data: RawData): { ok: true; value: Record<string, unknown> } | { ok: false; error: Error } {
  try {
    const text = typeof data === 'string'
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : data instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(data)).toString('utf8')
          : Buffer.isBuffer(data)
            ? data.toString('utf8')
            : Buffer.from(data as Uint8Array).toString('utf8');
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new Error('WebSocket event must be a JSON object.');
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

export function eventType(value: Record<string, unknown>): string {
  return typeof value.type === 'string'
    ? value.type
    : typeof value.event === 'string'
      ? value.event
      : '';
}

export function nestedMessage(value: Record<string, unknown>): string | undefined {
  const direct = normalizedString(value.message);
  if (direct && !isGenericErrorLabel(direct)) return direct;
  if (isRecord(value.error)) {
    const message = normalizedString(value.error.message);
    if (message && !isGenericErrorLabel(message)) return message;
  }
  if (isRecord(value.response)) return nestedMessage(value.response);
  return undefined;
}

const GENERIC_ERROR_LABELS: Record<string, true> = {
  stream_error: true,
  upstream_error: true,
  http_error: true,
  response_error: true,
  decode_error: true,
  stream_read_error: true,
  stream_parse_error: true,
  llm_error: true
};

export function isGenericErrorLabel(value: string): boolean {
  return GENERIC_ERROR_LABELS[value.trim().toLowerCase()] === true;
}

export function resolvedTimeouts(
  overrides: Partial<OpenAIResponsesWebSocketTimeouts> | undefined
): OpenAIResponsesWebSocketTimeouts {
  return {
    handshakeMs: positiveTimeout(overrides?.handshakeMs, DEFAULT_HANDSHAKE_TIMEOUT_MS, 'handshakeMs'),
    sendMs: positiveTimeout(overrides?.sendMs, DEFAULT_SEND_TIMEOUT_MS, 'sendMs'),
    firstEventMs: positiveTimeout(overrides?.firstEventMs, DEFAULT_FIRST_EVENT_TIMEOUT_MS, 'firstEventMs'),
    eventIdleMs: positiveTimeout(overrides?.eventIdleMs, DEFAULT_EVENT_IDLE_TIMEOUT_MS, 'eventIdleMs'),
    responseMs: positiveTimeout(overrides?.responseMs, DEFAULT_RESPONSE_TIMEOUT_MS, 'responseMs'),
    heartbeatIntervalMs: positiveTimeout(
      overrides?.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      'heartbeatIntervalMs'
    ),
    pongTimeoutMs: positiveTimeout(overrides?.pongTimeoutMs, DEFAULT_PONG_TIMEOUT_MS, 'pongTimeoutMs'),
    preSendProbeStaleMs: positiveTimeout(
      overrides?.preSendProbeStaleMs,
      DEFAULT_PRE_SEND_PROBE_STALE_MS,
      'preSendProbeStaleMs'
    ),
    preSendProbeTimeoutMs: positiveTimeout(
      overrides?.preSendProbeTimeoutMs,
      DEFAULT_PRE_SEND_PROBE_TIMEOUT_MS,
      'preSendProbeTimeoutMs'
    )
  };
}

function positiveTimeout(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

export function canonicalHash(value: unknown): string {
  return createHash('sha256').update(canonicalString(value)).digest('hex');
}

export function canonicalString(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalString).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalString(record[key])}`).join(',')}}`;
}

export function cloneJson<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function numericField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

export function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error(signal?.reason ? String(signal.reason) : 'OpenAI Responses WebSocket request aborted.');
  error.name = 'AbortError';
  return error;
}

export function isAbort(signal: AbortSignal | undefined, error: unknown): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}
