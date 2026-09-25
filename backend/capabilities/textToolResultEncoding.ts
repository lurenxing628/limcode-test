/**
 * 内核投影成文本的工具结果（`{ output }` / `{ error }`，见 ModelTextToolResponse）按文本交给模型。
 *
 * 接入库对每个 functionResponse 都发 `JSON.stringify(response)`：技能正文会变成一行带 `\n`、`\"` 转义的
 * JSON 字符串。这里在编码之后、发送之前，把这类结果换回原文，按各家线上格式放在能承载文本的位置：
 * - Claude：`tool_result.content` 本来就可以是字符串；失败结果同时标 `is_error: true`
 *   （https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls）。
 * - Chat Completions：`tool` 消息的 content 是字符串（DeepSeek 方言的数组形式换第一块 text）。
 * - Responses：`function_call_output.output` 可以是字符串（显式缓存断点把它改成 input_text 数组时换第一块）。
 * - Gemini：`FunctionResponse.response` 必须是对象，官方约定用 `output` / `error` 两个键，原样保留。
 * 只改写整段正好是这种形状的结果；其他工具结果逐字节不变。
 */
import type { LlmProviderKind } from '../../shared/protocol';
import { readModelTextToolResponse } from '../reliableKernel/modelFacingContextProjection';
import type { EncodedProviderRequest } from './providerParameterAdaptation';

export function withPlainTextToolResultRequest(
  request: EncodedProviderRequest,
  provider: LlmProviderKind
): EncodedProviderRequest {
  const body = withPlainTextToolResults(request.body, provider);
  return body === request.body ? request : { ...request, body };
}

/** 没有可改写的结果时原样返回同一引用。 */
export function withPlainTextToolResults(body: unknown, provider: LlmProviderKind): unknown {
  if (!isRecord(body)) return body;
  switch (provider) {
  case 'claude':
    return mapListField(body, 'messages', (message) => mapListField(message, 'content', claudeToolResult));
  case 'openai-compatible':
    return mapListField(body, 'messages', chatToolMessage);
  case 'openai-responses':
    return mapListField(body, 'input', responsesToolOutput);
  default:
    return body;
  }
}

/**
 * `/responses/compact` 的请求由 buildCompactProviderRequest 编码，不经过普通请求的编码后处理器；
 * 同样把文本结果换回原文，压缩模型读到的与普通请求一致。
 */
export function installPlainTextToolResultCompactEncoding<T>(provider: T, providerKind: LlmProviderKind): T {
  const runtime = provider as T & {
    buildCompactProviderRequest?: (...args: unknown[]) => unknown;
    __limcodePlainTextCompactToolResults?: true;
  };
  if (!runtime || runtime.__limcodePlainTextCompactToolResults) return provider;
  const build = runtime.buildCompactProviderRequest;
  if (typeof build !== 'function') return provider;
  runtime.buildCompactProviderRequest = function buildPlainTextCompactRequest(this: unknown, ...args: unknown[]): unknown {
    const built = build.apply(this, args);
    if (!isRecord(built)) return built;
    const body = withPlainTextToolResults(built.body, providerKind);
    return body === built.body ? built : { ...built, body };
  };
  runtime.__limcodePlainTextCompactToolResults = true;
  return provider;
}

function claudeToolResult(block: unknown): unknown {
  if (!isRecord(block) || block.type !== 'tool_result') return block;
  const replaced = replaceEncodedText(block.content, 'text');
  if (!replaced) return block;
  return { ...block, content: replaced.content, ...(replaced.error ? { is_error: true } : {}) };
}

function chatToolMessage(message: unknown): unknown {
  if (!isRecord(message) || message.role !== 'tool') return message;
  const replaced = replaceEncodedText(message.content, 'text');
  return replaced ? { ...message, content: replaced.content } : message;
}

function responsesToolOutput(item: unknown): unknown {
  if (!isRecord(item) || item.type !== 'function_call_output') return item;
  const replaced = replaceEncodedText(item.output, 'input_text');
  return replaced ? { ...item, output: replaced.content } : item;
}

/** 字符串，或首块是 `blockType` 文字块的数组（其余媒体块保持原位）。 */
function replaceEncodedText(
  value: unknown,
  blockType: 'text' | 'input_text'
): { content: unknown; error: boolean } | undefined {
  if (typeof value === 'string') {
    const text = decodeTextToolResponse(value);
    return text ? { content: text.text, error: text.error } : undefined;
  }
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first = value[0];
  if (!isRecord(first) || first.type !== blockType || typeof first.text !== 'string') return undefined;
  const text = decodeTextToolResponse(first.text);
  return text
    ? { content: [{ ...first, text: text.text }, ...value.slice(1)], error: text.error }
    : undefined;
}

function decodeTextToolResponse(encoded: string): { text: string; error: boolean } | undefined {
  // 先看前缀，免得每个工具结果都整段解析一遍。
  if (!encoded.startsWith('{"output":') && !encoded.startsWith('{"error":')) return undefined;
  try {
    return readModelTextToolResponse(JSON.parse(encoded) as unknown);
  } catch {
    return undefined;
  }
}

function mapListField(record: unknown, key: string, map: (entry: unknown) => unknown): unknown {
  if (!isRecord(record) || !Array.isArray(record[key])) return record;
  const list = record[key] as unknown[];
  let changed = false;
  const next = list.map((entry) => {
    const mapped = map(entry);
    if (mapped !== entry) changed = true;
    return mapped;
  });
  return changed ? { ...record, [key]: next } : record;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
