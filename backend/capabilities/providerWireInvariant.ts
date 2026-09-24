import { createHash } from 'node:crypto';
import type { LlmProviderKind } from '../../shared/protocol';

export interface LlmProviderWireToolItemTrace {
  index: string;
  idSha256?: string;
}

export interface LlmProviderWireInvariantTrace {
  bodySha256: string;
  messageCount: number;
  toolItems: LlmProviderWireToolItemTrace[];
}

export async function inspectFinalProviderWireBody(
  input: string | URL | Request,
  init: RequestInit | undefined,
  provider: LlmProviderKind
): Promise<LlmProviderWireInvariantTrace | undefined> {
  const payload = await requestBodyPayload(input, init);
  if (!payload) return undefined;
  const bodySha256 = createHash('sha256').update(payload.hashInput).digest('hex');
  let body: unknown;
  try {
    body = JSON.parse(payload.text);
  } catch (cause) {
    throw wireInvariantError(provider, bodySha256, 'final request body is not valid UTF-8 JSON', cause);
  }
  const root = requireWireRecord(body, provider, bodySha256, 'request body');
  if (provider === 'openai-compatible') {
    return inspectOpenAICompatible(root, provider, bodySha256);
  }
  if (provider === 'openai-responses') return inspectOpenAIResponses(root, provider, bodySha256);
  if (provider === 'claude') return inspectClaude(root, provider, bodySha256);
  return inspectGemini(root, provider, bodySha256);
}

export function emitProviderWireInvariantTrace(
  observer: ((trace: LlmProviderWireInvariantTrace) => void) | undefined,
  trace: LlmProviderWireInvariantTrace
): void {
  try {
    observer?.(trace);
  } catch {
    // Privacy-safe observability is best effort and never provider authority.
  }
  try {
    if (trace.toolItems.length > 0) {
      console.info('[LimCode][ProviderWireInvariant]', JSON.stringify(trace));
    }
  } catch {
    // Console transports are observability only.
  }
}

export function annotateProviderWireError(response: Response, bodySha256: string): Response {
  const headers = new Headers(response.headers);
  headers.set('x-limcode-wire-invariant', `passed; body_sha256=${bodySha256}`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function inspectOpenAICompatible(
  root: Record<string, unknown>,
  provider: LlmProviderKind,
  bodySha256: string
): LlmProviderWireInvariantTrace {
  const messages = requireWireArray(root.messages, provider, bodySha256, 'messages');
  const toolItems: LlmProviderWireToolItemTrace[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = asWireRecord(messages[index]);
    if (message?.role !== 'tool') continue;
    toolItems.push(requiredIdTrace(
      message.tool_call_id,
      `messages[${index}]`,
      'tool_call_id',
      provider,
      bodySha256
    ));
  }
  return { bodySha256, messageCount: messages.length, toolItems };
}

function inspectOpenAIResponses(
  root: Record<string, unknown>,
  provider: LlmProviderKind,
  bodySha256: string
): LlmProviderWireInvariantTrace {
  const input = requireWireArray(root.input, provider, bodySha256, 'input');
  const toolItems: LlmProviderWireToolItemTrace[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const item = asWireRecord(input[index]);
    if (item?.type !== 'function_call_output') continue;
    toolItems.push(requiredIdTrace(item.call_id, `input[${index}]`, 'call_id', provider, bodySha256));
  }
  return { bodySha256, messageCount: input.length, toolItems };
}

function inspectClaude(
  root: Record<string, unknown>,
  provider: LlmProviderKind,
  bodySha256: string
): LlmProviderWireInvariantTrace {
  const messages = requireWireArray(root.messages, provider, bodySha256, 'messages');
  const toolItems: LlmProviderWireToolItemTrace[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = asWireRecord(messages[messageIndex]);
    if (!Array.isArray(message?.content)) continue;
    for (let itemIndex = 0; itemIndex < message.content.length; itemIndex += 1) {
      const item = asWireRecord(message.content[itemIndex]);
      if (item?.type !== 'tool_result') continue;
      toolItems.push(requiredIdTrace(
        item.tool_use_id,
        `messages[${messageIndex}].content[${itemIndex}]`,
        'tool_use_id',
        provider,
        bodySha256
      ));
    }
  }
  return { bodySha256, messageCount: messages.length, toolItems };
}

function inspectGemini(
  root: Record<string, unknown>,
  provider: LlmProviderKind,
  bodySha256: string
): LlmProviderWireInvariantTrace {
  const contents = requireWireArray(root.contents, provider, bodySha256, 'contents');
  const toolItems: LlmProviderWireToolItemTrace[] = [];
  for (let contentIndex = 0; contentIndex < contents.length; contentIndex += 1) {
    const content = asWireRecord(contents[contentIndex]);
    if (!Array.isArray(content?.parts)) continue;
    for (let partIndex = 0; partIndex < content.parts.length; partIndex += 1) {
      const part = asWireRecord(content.parts[partIndex]);
      if (!part || !Object.prototype.hasOwnProperty.call(part, 'functionResponse')) continue;
      const location = `contents[${contentIndex}].parts[${partIndex}]`;
      const response = requireWireRecord(
        part.functionResponse,
        provider,
        bodySha256,
        `${location}.functionResponse`
      );
      if (typeof response.name !== 'string' || !response.name.trim()) {
        throw wireInvariantError(provider, bodySha256, `Gemini ${location}.functionResponse.name must be non-empty`);
      }
      if (!asWireRecord(response.response)) {
        throw wireInvariantError(provider, bodySha256, `Gemini ${location}.functionResponse.response must be an object`);
      }
      const itemTrace: LlmProviderWireToolItemTrace = { index: location };
      if (response.id !== undefined) {
        if (typeof response.id !== 'string' || !response.id.trim()) {
          throw wireInvariantError(provider, bodySha256, `Gemini ${location}.functionResponse.id must be non-empty when provided`);
        }
        itemTrace.idSha256 = hashId(response.id);
      }
      toolItems.push(itemTrace);
    }
  }
  return { bodySha256, messageCount: contents.length, toolItems };
}

interface RequestBodyPayload {
  text: string;
  hashInput: string | Buffer;
}

async function requestBodyPayload(
  input: string | URL | Request,
  init: RequestInit | undefined
): Promise<RequestBodyPayload | undefined> {
  if (typeof init?.body === 'string') return { text: init.body, hashInput: init.body };
  let bytes: Buffer | undefined;
  if (init?.body !== undefined && init.body !== null) bytes = await bodyValueBytes(init.body);
  else if (typeof Request !== 'undefined' && input instanceof Request && input.body) {
    bytes = Buffer.from(await input.clone().arrayBuffer());
  }
  if (!bytes) return undefined;
  return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), hashInput: bytes };
}

async function bodyValueBytes(body: NonNullable<RequestInit['body']>): Promise<Buffer> {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  if (typeof Blob !== 'undefined' && body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new TypeError('LLM final request body must be inspectable bytes before fetch.');
}

function requiredIdTrace(
  value: unknown,
  index: string,
  field: string,
  provider: LlmProviderKind,
  bodySha256: string
): LlmProviderWireToolItemTrace {
  if (typeof value !== 'string' || !value.trim()) {
    throw wireInvariantError(provider, bodySha256, `${index}.${field} must be a non-empty string`);
  }
  return { index, idSha256: hashId(value) };
}

function hashId(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requireWireArray(
  value: unknown,
  provider: LlmProviderKind,
  bodySha256: string,
  label: string
): unknown[] {
  if (!Array.isArray(value)) throw wireInvariantError(provider, bodySha256, `${label} must be an array`);
  return value;
}

function requireWireRecord(
  value: unknown,
  provider: LlmProviderKind,
  bodySha256: string,
  label: string
): Record<string, unknown> {
  const record = asWireRecord(value);
  if (!record) throw wireInvariantError(provider, bodySha256, `${label} must be an object`);
  return record;
}

function asWireRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function wireInvariantError(
  provider: LlmProviderKind,
  bodySha256: string,
  detail: string,
  cause?: unknown
): Error {
  const error = new Error(`LLM ${provider} wire invariant failed: ${detail}; body_sha256=${bodySha256}.`);
  return Object.assign(
    error,
    { code: 'LLM_WIRE_INVARIANT_FAILED', provider, bodySha256, ...(cause === undefined ? {} : { cause }) }
  );
}
