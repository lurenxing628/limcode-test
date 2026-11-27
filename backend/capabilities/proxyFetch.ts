/**
 * LimCode - HTTP CONNECT proxy fetch implementation.
 *
 * The provider package consumes the returned body as a standard Web ReadableStream. Transport
 * deadlines and HTTP framing validation live here so a dead or truncated proxy tunnel can never
 * masquerade as a clean provider EOF.
 */

import * as http from 'http';
import type * as net from 'net';
import * as tls from 'tls';
import { URL } from 'url';
import { EXTENSION_USER_AGENT } from '../../shared/extensionIdentity';

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_BODY_IDLE_TIMEOUT_MS = 600_000;
const DEFAULT_OVERALL_TIMEOUT_MS = 15 * 60 * 1_000;

export interface ProxyFetchTimeoutOptions {
  connectTimeoutMs?: number;
  /** null 显式禁用 body idle deadline；长驻 SSE 等流式连接由调用方 AbortSignal 管理。 */
  bodyIdleTimeoutMs?: number | null;
  /** null 显式禁用整体 deadline；缺省仍是 LLM 请求适用的 15 分钟上限。 */
  overallTimeoutMs?: number | null;
}

export type ProxyFetchFailurePhase = 'connect' | 'response_body' | 'response';

export class ProxyFetchTransportError extends Error {
  public readonly code: 'LLM_TRANSPORT_TIMEOUT' | 'LLM_STREAM_TRUNCATED';

  public constructor(
    message: string,
    code: 'LLM_TRANSPORT_TIMEOUT' | 'LLM_STREAM_TRUNCATED',
    public readonly phase: ProxyFetchFailurePhase,
    public readonly timeoutMs?: number
  ) {
    super(message);
    this.name = 'ProxyFetchTransportError';
    this.code = code;
  }
}

interface ResolvedProxyFetchTimeouts {
  connectTimeoutMs: number;
  bodyIdleTimeoutMs?: number;
  overallTimeoutMs?: number;
}

interface ResponseDeadlineOptions {
  bodyIdleTimeoutMs?: number;
  overallTimeoutMs?: number;
  overallDeadlineAt?: number;
  method: string;
}

/**
 * Creates a fetch-compatible function that tunnels requests through an HTTP CONNECT proxy.
 * Passing no proxy deliberately returns the platform fetch unchanged.
 */
export function createProxyFetch(
  proxyUrl?: string,
  timeoutOptions: ProxyFetchTimeoutOptions = {}
): typeof fetch {
  if (!proxyUrl) return fetch;

  const proxyParsed = new URL(proxyUrl);
  if (proxyParsed.protocol !== 'http:') {
    throw new TypeError(`Unsupported proxy protocol: ${proxyParsed.protocol}`);
  }
  const timeouts = resolveTimeouts(timeoutOptions);

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const inputRequest = input instanceof Request ? input : undefined;
    const targetUrl = typeof input === 'string'
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL(input.url);
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      throw new TypeError(`Unsupported target protocol: ${targetUrl.protocol}`);
    }

    const method = (init?.method ?? inputRequest?.method ?? 'GET').toUpperCase();
    const requestHeaders = new Headers(inputRequest?.headers);
    if (init?.headers) {
      new Headers(init.headers).forEach((value, key) => requestHeaders.set(key, value));
    }
    if (!requestHeaders.has('user-agent')) requestHeaders.set('user-agent', EXTENSION_USER_AGENT);

    const bodyBuffer = init?.body !== undefined
      ? await requestBodyBuffer(init.body)
      : inputRequest?.body
        ? Buffer.from(await inputRequest.clone().arrayBuffer())
        : Buffer.alloc(0);
    requestHeaders.set('host', targetUrl.host);
    requestHeaders.set('content-length', String(bodyBuffer.length));
    requestHeaders.set('connection', 'close');

    const signal = init?.signal ?? inputRequest?.signal;
    throwIfAborted(signal);
    const overallDeadlineAt = timeouts.overallTimeoutMs === undefined
      ? undefined
      : Date.now() + timeouts.overallTimeoutMs;
    const socket = await connectThroughProxy(targetUrl, proxyParsed, signal, {
      connectTimeoutMs: timeouts.connectTimeoutMs,
      ...(timeouts.overallTimeoutMs !== undefined ? { overallTimeoutMs: timeouts.overallTimeoutMs } : {}),
      ...(overallDeadlineAt !== undefined ? { overallDeadlineAt } : {})
    });

    try {
      const requestTarget = `${targetUrl.pathname || '/'}${targetUrl.search}`;
      const headerLines = Array.from(requestHeaders.entries(), ([key, value]) => `${key}: ${value}`);
      socket.write(`${method} ${requestTarget} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n`);
      if (bodyBuffer.length > 0) socket.write(bodyBuffer);
      return await readResponse(socket, signal, {
        ...(timeouts.bodyIdleTimeoutMs !== undefined ? { bodyIdleTimeoutMs: timeouts.bodyIdleTimeoutMs } : {}),
        ...(timeouts.overallTimeoutMs !== undefined ? { overallTimeoutMs: timeouts.overallTimeoutMs } : {}),
        ...(overallDeadlineAt !== undefined ? { overallDeadlineAt } : {}),
        method
      });
    } catch (error) {
      socket.destroy();
      throw error;
    }
  };
}

function connectThroughProxy(
  targetUrl: URL,
  proxyParsed: URL,
  signal: AbortSignal | undefined,
  deadlines: { connectTimeoutMs: number; overallTimeoutMs?: number; overallDeadlineAt?: number }
): Promise<tls.TLSSocket | net.Socket> {
  return new Promise((resolve, reject) => {
    const targetPort = targetUrl.port || (targetUrl.protocol === 'https:' ? '443' : '80');
    const targetAuthority = `${targetUrl.hostname}:${targetPort}`;
    const isHttps = targetUrl.protocol === 'https:';
    let settled = false;
    let proxyRequest: http.ClientRequest | undefined;
    let tunnelSocket: net.Socket | undefined;
    let tlsSocket: tls.TLSSocket | undefined;

    const connectTimer = setTimeout(() => finishReject(new ProxyFetchTransportError(
      `Proxy CONNECT timed out after ${deadlines.connectTimeoutMs}ms.`,
      'LLM_TRANSPORT_TIMEOUT',
      'connect',
      deadlines.connectTimeoutMs
    )), deadlines.connectTimeoutMs);
    const remainingOverallMs = deadlines.overallDeadlineAt === undefined
      ? undefined
      : Math.max(1, deadlines.overallDeadlineAt - Date.now());
    const overallTimer = remainingOverallMs === undefined ? undefined : setTimeout(() => finishReject(new ProxyFetchTransportError(
      `Proxy request exceeded its ${deadlines.overallTimeoutMs}ms overall deadline while connecting.`,
      'LLM_TRANSPORT_TIMEOUT',
      'response',
      deadlines.overallTimeoutMs
    )), remainingOverallMs);

    const cleanup = () => {
      clearTimeout(connectTimer);
      if (overallTimer !== undefined) clearTimeout(overallTimer);
      signal?.removeEventListener('abort', onAbort);
    };
    const destroyPending = () => {
      proxyRequest?.destroy();
      tlsSocket?.destroy();
      if (tunnelSocket !== tlsSocket) tunnelSocket?.destroy();
    };
    const finishResolve = (socket: tls.TLSSocket | net.Socket) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      destroyPending();
      reject(error);
    };
    const onAbort = () => finishReject(abortError(signal));

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }

    proxyRequest = http.request({
      hostname: proxyParsed.hostname,
      port: proxyParsed.port || 80,
      method: 'CONNECT',
      path: targetAuthority,
      headers: proxyAuthorizationHeader(proxyParsed)
    });

    proxyRequest.once('connect', (response: http.IncomingMessage, socket: net.Socket) => {
      tunnelSocket = socket;
      if (settled) {
        socket.destroy();
        return;
      }
      if (response.statusCode !== 200) {
        finishReject(new Error(`Proxy CONNECT failed: ${response.statusCode ?? 'unknown status'}`));
        return;
      }
      if (!isHttps) {
        finishResolve(socket);
        return;
      }

      tlsSocket = tls.connect({
        socket,
        servername: targetUrl.hostname,
        rejectUnauthorized: false
      });
      tlsSocket.once('secureConnect', () => finishResolve(tlsSocket!));
      tlsSocket.once('error', (error: Error) => finishReject(new Error(`TLS error: ${error.message}`)));
    });
    proxyRequest.once('response', (response) => {
      response.resume();
      finishReject(new Error(`Proxy CONNECT failed: ${response.statusCode ?? 'unknown status'}`));
    });
    proxyRequest.once('error', (error: Error) => {
      finishReject(new Error(`Proxy request failed: ${error.message}`));
    });
    proxyRequest.end();
  });
}

/** Parses the HTTP/1.1 response and exposes only decoded body bytes to the provider. */
function readResponse(
  socket: tls.TLSSocket | net.Socket,
  signal: AbortSignal | undefined,
  deadlines: ResponseDeadlineOptions
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let headerBuffer = Buffer.alloc(0);
    let headersParsed = false;
    let responseResolved = false;
    let lifecycleFinished = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let isChunked = false;
    let contentLength: number | undefined;
    let nonChunkedReceived = 0;
    let chunkedBuffer = Buffer.alloc(0);
    let chunkedDone = false;
    let bodyIdleTimer: ReturnType<typeof setTimeout> | undefined;

    const remainingOverallMs = deadlines.overallDeadlineAt === undefined
      ? undefined
      : Math.max(1, deadlines.overallDeadlineAt - Date.now());
    const overallTimer = remainingOverallMs === undefined ? undefined : setTimeout(() => fail(new ProxyFetchTransportError(
      `Proxy response exceeded its ${deadlines.overallTimeoutMs}ms overall deadline.`,
      'LLM_TRANSPORT_TIMEOUT',
      'response',
      deadlines.overallTimeoutMs
    )), remainingOverallMs);

    const cleanup = () => {
      if (overallTimer !== undefined) clearTimeout(overallTimer);
      if (bodyIdleTimer !== undefined) clearTimeout(bodyIdleTimer);
      bodyIdleTimer = undefined;
      signal?.removeEventListener('abort', onAbort);
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
    };
    const finishLifecycle = () => {
      if (lifecycleFinished) return false;
      lifecycleFinished = true;
      cleanup();
      return true;
    };
    const fail = (error: Error) => {
      if (!finishLifecycle()) return;
      socket.destroy();
      if (!responseResolved) {
        responseResolved = true;
        reject(error);
        return;
      }
      try { controller?.error(error); } catch { /* body already released/cancelled */ }
    };
    const completeBody = (destroySocket: boolean) => {
      if (!finishLifecycle()) return;
      if (destroySocket) socket.destroy();
      try { controller?.close(); } catch { /* body already released/cancelled */ }
    };
    const armBodyIdleDeadline = () => {
      if (lifecycleFinished || deadlines.bodyIdleTimeoutMs === undefined) return;
      if (bodyIdleTimer !== undefined) clearTimeout(bodyIdleTimer);
      bodyIdleTimer = setTimeout(() => fail(new ProxyFetchTransportError(
        `Proxy response body was idle for ${deadlines.bodyIdleTimeoutMs}ms.`,
        'LLM_TRANSPORT_TIMEOUT',
        'response_body',
        deadlines.bodyIdleTimeoutMs
      )), deadlines.bodyIdleTimeoutMs);
    };
    const onAbort = () => fail(abortError(signal));

    const processBodyData = (data: Buffer) => {
      if (lifecycleFinished || data.length === 0) return;
      armBodyIdleDeadline();
      if (isChunked) {
        chunkedBuffer = Buffer.concat([chunkedBuffer, data]);
        const decoded = decodeChunkedStream(chunkedBuffer);
        chunkedBuffer = Buffer.from(decoded.remaining);
        for (const chunk of decoded.chunks) controller?.enqueue(new Uint8Array(chunk));
        if (decoded.done) {
          chunkedDone = true;
          completeBody(true);
        }
        return;
      }

      if (contentLength !== undefined) {
        const remaining = contentLength - nonChunkedReceived;
        if (data.length > remaining) {
          throw truncatedError(
            `HTTP response exceeded its declared Content-Length of ${contentLength} bytes.`
          );
        }
        nonChunkedReceived += data.length;
        controller?.enqueue(new Uint8Array(data));
        if (nonChunkedReceived === contentLength) completeBody(true);
        return;
      }

      controller?.enqueue(new Uint8Array(data));
    };

    const parseHeaders = (chunk: Buffer) => {
      headerBuffer = Buffer.concat([headerBuffer, chunk]);
      const headerEnd = headerBuffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;

      const headerPart = headerBuffer.subarray(0, headerEnd).toString('latin1');
      const lines = headerPart.split('\r\n');
      const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})(?:\s+(.*))?$/.exec(lines[0] ?? '');
      if (!statusMatch) throw new Error('Invalid HTTP response status line from proxy tunnel.');
      const statusCode = Number(statusMatch[1]);
      const statusText = statusMatch[2] ?? '';
      const responseHeaders = new Headers();
      for (const line of lines.slice(1)) {
        const colonIndex = line.indexOf(':');
        if (colonIndex <= 0) throw new Error('Invalid HTTP response header from proxy tunnel.');
        const key = line.slice(0, colonIndex).trim();
        const value = line.slice(colonIndex + 1).trim();
        responseHeaders.append(key, value);
      }

      const transferEncoding = responseHeaders.get('transfer-encoding')?.toLowerCase() ?? '';
      isChunked = transferEncoding.split(',').some((entry) => entry.trim() === 'chunked');
      contentLength = isChunked ? undefined : parseContentLength(responseHeaders.get('content-length'));
      headersParsed = true;
      const bodyRemainder = headerBuffer.subarray(headerEnd + 4);
      headerBuffer = Buffer.alloc(0);

      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController;
        },
        cancel() {
          if (!finishLifecycle()) return;
          socket.destroy();
        }
      });
      responseResolved = true;
      resolve(new Response(stream, {
        status: statusCode,
        statusText: statusText || undefined,
        headers: responseHeaders
      }));

      if (responseHasNoBody(deadlines.method, statusCode)) {
        completeBody(true);
        return;
      }
      if (contentLength === 0) {
        completeBody(true);
        return;
      }
      armBodyIdleDeadline();
      if (bodyRemainder.length > 0) processBodyData(bodyRemainder);
    };

    const onData = (chunk: Buffer) => {
      if (lifecycleFinished || signal?.aborted) return;
      try {
        if (!headersParsed) parseHeaders(chunk);
        else processBodyData(chunk);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const validateEof = (kind: 'ended' | 'closed') => {
      if (lifecycleFinished || signal?.aborted) return;
      if (!headersParsed) {
        fail(truncatedError(`Proxy tunnel ${kind} before HTTP response headers were complete.`));
        return;
      }
      if (isChunked && !chunkedDone) {
        fail(truncatedError('Chunked HTTP response ended before the zero-length terminal chunk.'));
        return;
      }
      if (contentLength !== undefined && nonChunkedReceived !== contentLength) {
        fail(truncatedError(
          `HTTP response ended after ${nonChunkedReceived} of ${contentLength} declared bytes.`
        ));
        return;
      }
      if (kind === 'closed') {
        fail(truncatedError('Proxy tunnel closed without a clean HTTP EOF.'));
        return;
      }
      completeBody(false);
    };
    const onEnd = () => validateEof('ended');
    const onClose = () => validateEof('closed');
    const onError = (error: Error) => fail(error);

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

function decodeChunkedStream(data: Buffer): { chunks: Buffer[]; remaining: Buffer; done: boolean } {
  const chunks: Buffer[] = [];
  let offset = 0;

  while (offset < data.length) {
    const sizeEnd = data.indexOf('\r\n', offset);
    if (sizeEnd < 0) break;
    const sizeLine = data.subarray(offset, sizeEnd).toString('ascii');
    const semicolon = sizeLine.indexOf(';');
    const sizeToken = (semicolon >= 0 ? sizeLine.slice(0, semicolon) : sizeLine).trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeToken)) {
      throw truncatedError(`Invalid chunk-size line: ${JSON.stringify(sizeLine)}.`);
    }
    const chunkSize = Number.parseInt(sizeToken, 16);
    if (!Number.isSafeInteger(chunkSize)) throw truncatedError('HTTP chunk size exceeds the safe integer range.');

    const chunkDataStart = sizeEnd + 2;
    if (chunkSize === 0) {
      let trailerOffset = chunkDataStart;
      for (;;) {
        const trailerEnd = data.indexOf('\r\n', trailerOffset);
        if (trailerEnd < 0) return { chunks, remaining: data.subarray(offset), done: false };
        if (trailerEnd === trailerOffset) {
          return { chunks, remaining: data.subarray(trailerEnd + 2), done: true };
        }
        const trailerLine = data.subarray(trailerOffset, trailerEnd).toString('latin1');
        if (!trailerLine.includes(':')) throw truncatedError('Invalid HTTP chunk trailer.');
        trailerOffset = trailerEnd + 2;
      }
    }

    const chunkDataEnd = chunkDataStart + chunkSize;
    if (chunkDataEnd + 2 > data.length) break;
    if (data[chunkDataEnd] !== 0x0d || data[chunkDataEnd + 1] !== 0x0a) {
      throw truncatedError('HTTP chunk data was not followed by CRLF.');
    }
    chunks.push(Buffer.from(data.subarray(chunkDataStart, chunkDataEnd)));
    offset = chunkDataEnd + 2;
  }

  return { chunks, remaining: data.subarray(offset), done: false };
}

async function requestBodyBuffer(body: RequestInit['body']): Promise<Buffer> {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (typeof Blob !== 'undefined' && body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  throw new TypeError('Proxy fetch only supports buffered request bodies.');
}

function proxyAuthorizationHeader(proxy: URL): Record<string, string> | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  const credential = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return { 'Proxy-Authorization': `Basic ${Buffer.from(credential).toString('base64')}` };
}

function parseContentLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw truncatedError(`Invalid Content-Length header: ${JSON.stringify(value)}.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw truncatedError('Content-Length exceeds the safe integer range.');
  return parsed;
}

function responseHasNoBody(method: string, statusCode: number): boolean {
  return method === 'HEAD' || (statusCode >= 100 && statusCode < 200) || statusCode === 204 || statusCode === 304;
}

function truncatedError(message: string): ProxyFetchTransportError {
  return new ProxyFetchTransportError(message, 'LLM_STREAM_TRUNCATED', 'response_body');
}

function resolveTimeouts(options: ProxyFetchTimeoutOptions): ResolvedProxyFetchTimeouts {
  return {
    connectTimeoutMs: positiveTimeout(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 'connectTimeoutMs'),
    bodyIdleTimeoutMs: optionalTimeout(options.bodyIdleTimeoutMs, DEFAULT_BODY_IDLE_TIMEOUT_MS, 'bodyIdleTimeoutMs'),
    overallTimeoutMs: optionalTimeout(options.overallTimeoutMs, DEFAULT_OVERALL_TIMEOUT_MS, 'overallTimeoutMs')
  };
}

function optionalTimeout(value: number | null | undefined, fallback: number, label: string): number | undefined {
  if (value === null) return undefined;
  return positiveTimeout(value, fallback, label);
}

function positiveTimeout(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Request cancelled');
  error.name = 'AbortError';
  return error;
}
