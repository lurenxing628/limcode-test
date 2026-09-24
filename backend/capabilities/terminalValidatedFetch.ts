import type { LlmProviderKind } from '../../shared/protocol';
import type { DebugHttpObservation } from '../reliableKernel/debugCapture/observer';
import {
  annotateProviderWireError,
  emitProviderWireInvariantTrace,
  inspectFinalProviderWireBody,
  type LlmProviderWireInvariantTrace
} from './providerWireInvariant';

export type {
  LlmProviderWireInvariantTrace,
  LlmProviderWireToolItemTrace
} from './providerWireInvariant';

const DEFAULT_BODY_IDLE_TIMEOUT_MS = 60_000;

export interface TerminalValidatedFetchOptions {
  bodyIdleTimeoutMs?: number;
  onWireInvariantTrace?: (trace: LlmProviderWireInvariantTrace) => void;
  createObservation?: () => DebugHttpObservation;
  /**
   * OpenAI Responses：线上看到的终态（流里的 response.completed / response.incomplete，或非流式响应体的 status）。
   * 只报线上原文，不依赖接入库怎么解码 response.incomplete。
   */
  onResponsesTerminal?: (terminal: ResponsesTerminalEvidence) => void;
}

/** 一个 Responses 响应的终态：状态、incomplete 原因与原始 usage。 */
export interface ResponsesTerminalEvidence {
  status: string;
  reason?: string;
  usage?: unknown;
}

export class LlmHttpStreamTerminationError extends Error {
  public readonly code: 'LLM_STREAM_TRUNCATED' | 'LLM_TRANSPORT_TIMEOUT';
  public readonly phase = 'response_body';

  public constructor(
    message: string,
    code: 'LLM_STREAM_TRUNCATED' | 'LLM_TRANSPORT_TIMEOUT' = 'LLM_STREAM_TRUNCATED',
    public readonly timeoutMs?: number,
    public readonly cause?: unknown
  ) {
    // The SDK's stream_read_error retains only the message, dropping code and cause.
    super(`[${code}] ${message}`);
    this.name = 'LlmHttpStreamTerminationError';
    this.code = code;
  }
}

/**
 * Keeps the provider package's format decoding, but refuses to turn a transport EOF into a
 * successful model completion unless the raw SSE protocol carried provider terminal evidence.
 */
export function createTerminalValidatedFetch(
  baseFetch: typeof fetch,
  provider: LlmProviderKind,
  options: TerminalValidatedFetchOptions = {}
): typeof fetch {
  const bodyIdleTimeoutMs = positiveTimeout(options.bodyIdleTimeoutMs ?? DEFAULT_BODY_IDLE_TIMEOUT_MS);
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const observation = options.createObservation?.();
    const wireTrace = await inspectFinalProviderWireBody(input, init, provider);
    if (wireTrace) emitProviderWireInvariantTrace(options.onWireInvariantTrace, wireTrace);
    observation?.request(input, init);
    let response: Response;
    try { response = await baseFetch(input, init); }
    catch (error) { observation?.end('fetch_error', error); throw error; }
    if (!response.ok && wireTrace?.toolItems.length) {
      response = annotateProviderWireError(response, wireTrace.bodySha256);
    }
    const validatedStream = response.ok && isEventStream(response.headers.get('content-type'));
    const onResponsesTerminal = provider === 'openai-responses' ? options.onResponsesTerminal : undefined;
    if (onResponsesTerminal && response.ok && !validatedStream && response.body && isJson(response.headers.get('content-type'))) {
      // 非流式 Responses：先读完响应体取终态，再原样交给接入库解码。
      const text = await response.text();
      try {
        const terminal = responsesTerminalEvidence(JSON.parse(text));
        if (terminal) onResponsesTerminal(terminal);
      } catch {
        // 解析失败由接入库报告；这里只记录明确的终态。
      }
      response = new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    if (!response.body || (!validatedStream && !observation)) return response;

    const reader = response.body.getReader();
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const tracker = validatedStream ? new SseTerminalTracker(provider, onResponsesTerminal) : undefined;
    // Fetch implementations expose decoded response bytes while commonly retaining the encoded
    // Content-Length header. Only compare lengths when no content coding can change the byte count.
    const expectedBytes = hasIdentityContentEncoding(response.headers.get('content-encoding'))
      ? contentLength(response.headers.get('content-length'))
      : undefined;
    let receivedBytes = 0;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (closed) return;
        try {
          const next = await (validatedStream ? readWithIdleDeadline(reader, bodyIdleTimeoutMs) : reader.read()).catch((error: unknown) => {
            // Only transport reads are eligible; parser failures and explicit cancellation are not.
            if (validatedStream && !closed && !signal?.aborted && !tracker?.sawTerminal && isBodyConnectionFailure(error)) {
              throw new LlmHttpStreamTerminationError(
                `${provider} SSE response body read interrupted: ${error.message}`,
                'LLM_STREAM_TRUNCATED', undefined, error
              );
            }
            throw error;
          });
          if (!next.done) {
            receivedBytes += next.value.byteLength;
            observation?.raw(next.value);
            tracker?.push(next.value);
            controller.enqueue(next.value);
            return;
          }

          closed = true;
          tracker?.finish();
          if (validatedStream && expectedBytes !== undefined && receivedBytes !== expectedBytes) {
            throw new LlmHttpStreamTerminationError(
              `HTTP stream ended after ${receivedBytes} of ${expectedBytes} declared bytes.`
            );
          }
          if (tracker && !tracker.sawTerminal) {
            throw new LlmHttpStreamTerminationError(
              `${provider} SSE stream ended without provider terminal evidence.`
            );
          }
          controller.close();
          observation?.end('eof');
        } catch (error) {
          closed = true;
          observation?.end('read_error', error);
          void reader.cancel(error).catch(() => undefined);
          controller.error(error);
        }
      },
      async cancel(reason) {
        closed = true;
        observation?.end('cancel', reason);
        await reader.cancel(reason);
      }
    });

    const wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
    return observation ? observation.bind(wrapped) : wrapped;
  };
}

class SseTerminalTracker {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private currentEvent = '';
  private dataLines: string[] = [];
  public sawTerminal = false;

  public constructor(
    private readonly provider: LlmProviderKind,
    private readonly onResponsesTerminal?: (terminal: ResponsesTerminalEvidence) => void
  ) {}

  public push(bytes: Uint8Array): void {
    this.buffer += this.decoder.decode(bytes, { stream: true });
    this.consumeCompleteLines();
  }

  public finish(): void {
    this.buffer += this.decoder.decode();
    if (this.buffer) {
      const trailing = this.buffer;
      this.buffer = '';
      this.consumeLine(trailing.endsWith('\r') ? trailing.slice(0, -1) : trailing);
    }
    this.dispatch();
  }

  private consumeCompleteLines(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const rawLine of lines) {
      this.consumeLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine);
    }
  }

  private consumeLine(line: string): void {
    if (!line) {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator >= 0 ? line.slice(0, separator) : line;
    const rawValue = separator >= 0 ? line.slice(separator + 1) : '';
    const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;
    if (field === 'event') this.currentEvent = value.trim();
    else if (field === 'data') this.dataLines.push(value);
  }

  private dispatch(): void {
    const event = this.currentEvent;
    const data = this.dataLines.join('\n');
    this.currentEvent = '';
    this.dataLines = [];
    if (!data && !event) return;
    if (data.trim() === '[DONE]' || terminalEventName(event)) {
      this.sawTerminal = true;
      return;
    }
    if (!data) return;
    try {
      const value = JSON.parse(data);
      if (this.provider === 'openai-responses') {
        const terminal = responsesTerminalEvidence(value);
        // response.incomplete 同样是这个响应的终态（https://platform.openai.com/docs/api-reference/responses-streaming），不是被截断的流。
        if (terminal?.status === 'incomplete') this.sawTerminal = true;
        if (terminal) this.onResponsesTerminal?.(terminal);
      }
      if (hasTerminalJsonEvidence(value, this.provider)) this.sawTerminal = true;
    } catch {
      // The provider package owns parse errors. This layer only records positive terminal evidence.
    }
  }
}

/** Responses 终态：流事件 `{type, response:{status,…}}` 或非流式响应体 `{object:'response', status,…}`。 */
function responsesTerminalEvidence(value: unknown): ResponsesTerminalEvidence | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const nested = record.response && typeof record.response === 'object' && !Array.isArray(record.response)
    ? record.response as Record<string, unknown>
    : undefined;
  const response = nested ?? (record.object === 'response' ? record : undefined);
  if (!response) return undefined;
  const status = typeof response.status === 'string' ? response.status : undefined;
  if (status !== 'completed' && status !== 'incomplete') return undefined;
  const details = response.incomplete_details && typeof response.incomplete_details === 'object'
    ? response.incomplete_details as Record<string, unknown>
    : undefined;
  const reason = typeof details?.reason === 'string' && details.reason.trim() ? details.reason.trim() : undefined;
  return {
    status,
    ...(reason ? { reason } : {}),
    ...(response.usage !== undefined && response.usage !== null ? { usage: response.usage } : {})
  };
}

function isJson(value: string | null): boolean {
  const type = value?.toLowerCase().split(';', 1)[0]?.trim() ?? '';
  return type === 'application/json' || type.endsWith('+json');
}

function terminalEventName(event: string): boolean {
  return event === 'response.completed' || event === 'message_stop';
}

function hasTerminalJsonEvidence(value: unknown, provider: LlmProviderKind, depth = 0): boolean {
  if (depth > 8 || value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some((entry) => hasTerminalJsonEvidence(entry, provider, depth + 1));
  if (typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'response.completed' || record.type === 'message_stop') return true;
  if (provider === 'openai-responses') {
    const response = record.response;
    if (response && typeof response === 'object'
      && (response as Record<string, unknown>).status === 'completed') return true;
  }
  for (const key of ['finish_reason', 'finishReason', 'stop_reason']) {
    const reason = record[key];
    if (typeof reason === 'string' && reason.trim()) return true;
  }
  return Object.values(record).some((entry) => hasTerminalJsonEvidence(entry, provider, depth + 1));
}

function isBodyConnectionFailure(error: unknown, depth = 0): error is Error {
  if (depth > 6 || !(error instanceof Error) || error.name === 'AbortError' || error.name === 'SyntaxError') {
    return false;
  }
  const { code, cause } = error as Error & { code?: unknown; cause?: unknown };
  return error.message === 'terminated'
    || (typeof code === 'string' && /^(?:UND_ERR_SOCKET|UND_ERR_BODY_TIMEOUT|ECONNRESET|ECONNABORTED|EPIPE|ETIMEDOUT)$/.test(code))
    || isBodyConnectionFailure(cause, depth + 1);
}

async function readWithIdleDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LlmHttpStreamTerminationError(
      `HTTP response body was idle for ${timeoutMs}ms.`,
      'LLM_TRANSPORT_TIMEOUT',
      timeoutMs
    )), timeoutMs);
  });
  try {
    return await Promise.race([reader.read(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isEventStream(value: string | null): boolean {
  return value?.toLowerCase().split(';', 1)[0]?.trim() === 'text/event-stream';
}

function contentLength(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function hasIdentityContentEncoding(value: string | null): boolean {
  return value === null || value.trim() === '' || value.trim().toLowerCase() === 'identity';
}

function positiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('bodyIdleTimeoutMs must be positive.');
  return value;
}
