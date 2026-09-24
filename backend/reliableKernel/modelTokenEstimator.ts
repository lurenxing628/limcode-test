import { estimateTokenCount } from 'tokenx';
import type { ContentPart, InlineDataPart, MessageContent } from '../../shared/protocol';

const MESSAGE_OVERHEAD_TOKENS = 4;
const FUNCTION_OVERHEAD_TOKENS = 4;
const FILE_REFERENCE_TOKENS = 258;

export function estimateMessageContentsTokens(contents: readonly MessageContent[]): number {
  return safeTokenCount(contents.reduce((total, content) =>
    total + estimateMessageContentTokens(content), 0), 'MessageContent token estimate');
}

/** Informational media subtotal. It is already included in estimateMessageContentsTokens(). */
export function estimateMessageContentsMediaTokens(contents: readonly MessageContent[]): number {
  return safeTokenCount(contents.reduce((total, content) => total + content.parts.reduce(
    (partTotal, part) => partTotal + estimateContentPartMediaTokens(part), 0
  ), 0), 'MessageContent media token estimate');
}

export function estimateMessageContentTokens(content: MessageContent): number {
  const wholeContext = asRecord(content as unknown)?.providerContext;
  if (wholeContext) return estimateProviderContextTokens(wholeContext);
  return MESSAGE_OVERHEAD_TOKENS + content.parts.reduce((total, part) =>
    total + estimateContentPartTokens(part), 0);
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const estimated = estimateTokenCount(text);
  return Number.isFinite(estimated) && estimated > 0 ? Math.ceil(estimated) : 0;
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTextTokens(safeJsonString(value));
}

/** Removes the convenience ciphertext copy when rawItem already owns the exact replay value. */
export function canonicalizeCompressionContents(contents: readonly MessageContent[]): MessageContent[] {
  return contents.map((content) => ({
    ...content,
    parts: content.parts.map((part) => canonicalizeCompressionPart(part))
  }));
}

function canonicalizeCompressionPart(part: ContentPart): ContentPart {
  if (!('providerContext' in part)) return part;
  const context = part.providerContext;
  const raw = asRecord(context.rawItem);
  if (
    typeof context.encryptedContent === 'string'
    && typeof raw?.encrypted_content === 'string'
    && context.encryptedContent === raw.encrypted_content
  ) {
    const { encryptedContent: _duplicate, ...canonical } = context;
    return { providerContext: canonical };
  }
  return part;
}

function estimateContentPartTokens(part: ContentPart): number {
  if ('providerContext' in part) return estimateProviderContextTokens(part.providerContext);
  if ('text' in part) return estimateTextTokens(part.text);
  if ('functionCall' in part) {
    return FUNCTION_OVERHEAD_TOKENS
      + estimateTextTokens(part.functionCall.name)
      + estimateJsonTokens(part.functionCall.args ?? {});
  }
  if ('functionResponse' in part) {
    const attachmentTokens = part.functionResponse.parts?.reduce((total, nested) =>
      total + estimateInlineDataTokens(nested), 0) ?? 0;
    return FUNCTION_OVERHEAD_TOKENS
      + estimateTextTokens(part.functionResponse.name)
      + estimateJsonTokens(part.functionResponse.response ?? {})
      + attachmentTokens;
  }
  if ('inlineData' in part) return estimateInlineDataTokens(part);
  if ('fileData' in part) return FILE_REFERENCE_TOKENS;
  return 0;
}

function estimateContentPartMediaTokens(part: ContentPart): number {
  if ('inlineData' in part) return estimateInlineDataTokens(part);
  if ('fileData' in part) return FILE_REFERENCE_TOKENS;
  if ('functionResponse' in part) {
    return part.functionResponse.parts?.reduce((total, nested) =>
      total + estimateInlineDataTokens(nested), 0) ?? 0;
  }
  if ('providerContext' in part) {
    const context = asRecord(part.providerContext);
    const raw = asRecord(context?.rawItem);
    if (raw?.type !== 'message' || !Array.isArray(raw.content)) return 0;
    return raw.content.reduce((total, value) => {
      const block = asRecord(value);
      if (block?.type === 'input_image' && typeof block.image_url === 'string') {
        return total + estimateInlineDataTokens({ inlineData: {
          mimeType: 'image/unknown', data: dataUrlBase64(block.image_url)
        } });
      }
      if (block?.type === 'input_file' && typeof block.file_data === 'string') {
        return total + estimateInlineDataTokens({ inlineData: {
          mimeType: 'application/octet-stream', data: dataUrlBase64(block.file_data)
        } });
      }
      return total;
    }, 0);
  }
  return 0;
}

function estimateProviderContextTokens(value: unknown): number {
  const context = asRecord(value);
  const raw = asRecord(context?.rawItem);
  if (!raw) return 0;
  switch (raw.type) {
  case 'message': {
    const blocks = Array.isArray(raw.content) ? raw.content : [];
    return MESSAGE_OVERHEAD_TOKENS + blocks.reduce((total, value) => {
      const block = asRecord(value);
      if (!block) return total;
      if (typeof block.text === 'string') return total + estimateTextTokens(block.text);
      if (block.type === 'input_image' && typeof block.image_url === 'string') {
        return total + estimateInlineDataTokens({ inlineData: {
          mimeType: 'image/unknown', data: dataUrlBase64(block.image_url)
        } });
      }
      if (block.type === 'input_file' && typeof block.file_data === 'string') {
        return total + estimateInlineDataTokens({ inlineData: {
          mimeType: 'application/octet-stream', data: dataUrlBase64(block.file_data)
        } });
      }
      return total;
    }, 0);
  }
  case 'function_call':
    return FUNCTION_OVERHEAD_TOKENS
      + estimateTextTokens(typeof raw.name === 'string' ? raw.name : '')
      + estimateTextTokens(typeof raw.arguments === 'string'
        ? raw.arguments
        : safeJsonString(raw.arguments ?? {}));
  case 'function_call_output':
    return FUNCTION_OVERHEAD_TOKENS + estimateTextTokens(typeof raw.output === 'string'
      ? raw.output
      : safeJsonString(raw.output ?? {}));
  case 'reasoning':
    return Array.isArray(raw.summary) ? raw.summary.reduce((total, value) => {
      const summary = asRecord(value);
      return total + estimateTextTokens(typeof summary?.text === 'string' ? summary.text : '');
    }, 0) : 0;
  case 'configuration_update': {
    // Native reasoning selection item; tiny but model-visible on the wire.
    const reasoning = asRecord(raw.reasoning);
    return FUNCTION_OVERHEAD_TOKENS
      + estimateTextTokens(typeof reasoning?.effort === 'string' ? reasoning.effort : '');
  }
  case 'compaction':
    // Claude's compaction block carries its summary as readable `content` that the model reads on
    // every later request, so it is counted like text. OpenAI's carries only `encrypted_content`, an
    // opaque provider handle that is not a text prompt and has no local size.
    return typeof raw.content === 'string' ? estimateTextTokens(raw.content) : 0;
  default:
    return 0;
  }
}

function estimateInlineDataTokens(part: InlineDataPart): number {
  const rawBytes = inlineDataRawBytes(part.inlineData);
  if (rawBytes <= 0) return 0;
  const mimeType = part.inlineData.mimeType;
  if (mimeType.startsWith('image/')) {
    return Math.max(258, Math.ceil(rawBytes / (300 * 1024)) * 258);
  }
  if (mimeType.startsWith('audio/')) {
    return Math.max(32, Math.ceil(rawBytes / (16 * 1024)) * 32);
  }
  if (mimeType.startsWith('video/')) {
    return Math.max(263, Math.ceil(rawBytes / (256 * 1024)) * 263);
  }
  return Math.max(258, Math.ceil(rawBytes / (100 * 1024)) * 258);
}

function inlineDataRawBytes(value: InlineDataPart['inlineData']): number {
  if (Number.isSafeInteger(value.sizeBytes) && (value.sizeBytes as number) > 0) {
    return value.sizeBytes as number;
  }
  if (typeof value.data === 'string' && value.data.length > 0) {
    return Math.ceil(value.data.length * 3 / 4);
  }
  return 0;
}

function safeJsonString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function dataUrlBase64(value: string): string {
  const comma = value.indexOf(',');
  return comma >= 0 ? value.slice(comma + 1) : value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeTokenCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} is outside the safe integer range.`);
  return value;
}
