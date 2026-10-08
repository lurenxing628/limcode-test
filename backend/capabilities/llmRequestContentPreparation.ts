/**
 * provider 请求边界的内容准备：多模态附件解析/降级占位、Native Compact 媒体 canonical 校验，
 * 以及工具调用上下文的规范化（孤儿响应转文本、未闭环调用补兜底响应）。
 */
import { isModelToolResponseMultimodalMimeType } from '../reliableKernel/modelFacingContextProjection';
import type { LlmStartRequest } from '../world/modules/llm/contracts';
import {
  isFunctionCallPart,
  isFunctionResponsePart,
  isInlineDataPart,
  isTextPart
} from '../../shared/protocol';
import type {
  ContentPart,
  FunctionCallPart,
  FunctionResponsePart,
  InlineDataPart,
  MessageContent
} from '../../shared/protocol';
import { decodeCanonicalBase64 } from './canonicalBase64';
import { errorSearchText, isRecord, stringifyJson } from './llmStreamEventProjection';
import type { OpenAIResponsesNativeCapabilities } from '../../shared/openAIResponsesNative';
/** llmProvider.LlmProviderOptions 中本模块需要的子集；结构性兼容，避免回依赖 llmProvider。 */
export interface LlmMultimodalPreparationOptions {
  resolveAttachment?: (input: { attachmentId?: string; sourcePath?: string; mimeType?: string; name?: string }) => Promise<InlineDataPart | undefined>;
}

// 产品能力边界：附件存储/预览不受此集合限制；送模只使用各 Provider 的共同稳定类型。
// 其他 MIME 会转为显式文本占位，避免静默丢失，也不伪装模型已经读取过该附件。
const TOOL_RESPONSE_CONTEXT_FALLBACK_MESSAGE = '工具调用在本次 LLM 请求上下文中没有对应响应，已自动补充兜底响应。原工具执行结果不可用；如仍需要结果，请重新执行相关操作。';

interface ToolCallContextNormalizationResult {
  contents: MessageContent[];
  orphanResponseCount: number;
  fallbackResponseCount: number;
}

interface TrackedFunctionCall {
  part: FunctionCallPart;
  contentIndex: number;
  closed: boolean;
}

export async function prepareLlmStartRequestMultimodal(
  request: LlmStartRequest,
  options: LlmMultimodalPreparationOptions,
  nativeCapabilities?: OpenAIResponsesNativeCapabilities
): Promise<LlmStartRequest> {
  const preparation = createMultimodalPreparationContext();
  const [contents, systemInstruction] = await Promise.all([
    Promise.all(request.contents.map((content) =>
      prepareLlmContentMultimodal(content, options, false, 'ordinary', preparation))),
    request.systemInstruction
      ? prepareLlmContentMultimodal(request.systemInstruction, options, false, 'ordinary', preparation)
      : Promise.resolve(undefined)
  ]);
  const normalized = assertCanonicalProviderToolContext(contents, nativeAsyncAdmission(request, nativeCapabilities));
  return {
    ...request,
    contents: normalized,
    ...(systemInstruction ? { systemInstruction } : {})
  };
}

/**
 * 当前请求允许保持 pending 的原生异步调用集合。例外同时要求：
 * 目标 capability.asyncTools 为真（当前 target 才有异步编码资格）、调用 part 携带 async 标记
 * （历史证据）且 call ID 在 Kernel/Tools 持久化准入名单内（权威证明）。
 */
function nativeAsyncAdmission(
  request: LlmStartRequest,
  nativeCapabilities?: OpenAIResponsesNativeCapabilities
): { admittedCallIds: ReadonlySet<string> } | undefined {
  if (nativeCapabilities?.asyncTools !== true) return undefined;
  const admittedCallIds = new Set((request.nativeAsyncAdmittedCallIds ?? []).map((id) => id.trim()).filter(Boolean));
  return admittedCallIds.size > 0 ? { admittedCallIds } : undefined;
}

export async function prepareNativeCompactContentsMultimodal(
  contents: MessageContent[],
  options: LlmMultimodalPreparationOptions
): Promise<MessageContent[]> {
  const preparation = createMultimodalPreparationContext();
  return Promise.all(contents.map((content) =>
    prepareLlmContentMultimodal(content, options, false, 'native_compact', preparation)));
}

export function assertCanonicalProviderToolContext(
  contents: MessageContent[],
  nativeAsync?: { admittedCallIds: ReadonlySet<string> }
): MessageContent[] {
  const normalized = normalizeToolCallResponseContext(contents, nativeAsync);
  if (normalized.orphanResponseCount > 0 || normalized.fallbackResponseCount > 0) {
    throw new Error(
      `Provider boundary rejected non-canonical tool context: ${normalized.orphanResponseCount} orphan response(s), ${normalized.fallbackResponseCount} unresolved call(s).`
    );
  }
  return contents;
}

function normalizeToolCallResponseContext(
  contents: MessageContent[],
  nativeAsync?: { admittedCallIds: ReadonlySet<string> }
): ToolCallContextNormalizationResult {
  const pendingById = new Map<string, TrackedFunctionCall>();
  const pendingByName = new Map<string, TrackedFunctionCall[]>();
  const calls: TrackedFunctionCall[] = [];
  let orphanResponseCount = 0;

  const normalized = contents.map((content, contentIndex) => {
    let changed = false;
    const parts = content.parts.map((part) => {
      if (isFunctionCallPart(part)) {
        const tracked: TrackedFunctionCall = { part, contentIndex, closed: false };
        calls.push(tracked);
        const id = normalizeToolCallId(part.id);
        if (id) {
          pendingById.set(id, tracked);
        } else {
          const list = pendingByName.get(part.functionCall.name) ?? [];
          list.push(tracked);
          pendingByName.set(part.functionCall.name, list);
        }
        return part;
      }

      if (!isFunctionResponsePart(part)) return part;

      const matched = consumeMatchingFunctionCall(part, pendingById, pendingByName);
      if (matched) return part;

      orphanResponseCount += 1;
      changed = true;
      return orphanFunctionResponseTextPart(part);
    });
    return changed ? { ...content, parts } : content;
  });

  const fallbackResponsesByContentIndex = new Map<number, FunctionResponsePart[]>();
  for (const call of calls) {
    if (call.closed) continue;
    // 持久化准入的原生异步调用可以合法保持 pending；普通未决调用仍然走兜底并失败。
    if (nativeAsync && call.part.async === true) {
      const callId = normalizeToolCallId(call.part.id);
      if (callId && nativeAsync.admittedCallIds.has(callId)) continue;
    }
    const list = fallbackResponsesByContentIndex.get(call.contentIndex) ?? [];
    list.push(fallbackFunctionResponsePart(call.part));
    fallbackResponsesByContentIndex.set(call.contentIndex, list);
  }

  if (fallbackResponsesByContentIndex.size === 0) {
    return { contents: normalized, orphanResponseCount, fallbackResponseCount: 0 };
  }

  const repaired: MessageContent[] = [];
  let fallbackResponseCount = 0;
  normalized.forEach((content, index) => {
    repaired.push(content);
    const fallbackResponses = fallbackResponsesByContentIndex.get(index);
    if (!fallbackResponses?.length) return;
    fallbackResponseCount += fallbackResponses.length;
    repaired.push({ role: 'user', parts: fallbackResponses });
  });

  return { contents: repaired, orphanResponseCount, fallbackResponseCount };
}

function consumeMatchingFunctionCall(
  response: FunctionResponsePart,
  pendingById: Map<string, TrackedFunctionCall>,
  pendingByName: Map<string, TrackedFunctionCall[]>
): TrackedFunctionCall | undefined {
  const responseId = normalizeToolCallId(response.id);
  if (responseId) {
    const matched = pendingById.get(responseId);
    if (matched) {
      matched.closed = true;
      pendingById.delete(responseId);
      return matched;
    }
  }

  const queue = pendingByName.get(response.functionResponse.name);
  const matched = queue?.shift();
  if (!matched) return undefined;
  matched.closed = true;
  if (queue && queue.length === 0) pendingByName.delete(response.functionResponse.name);
  return matched;
}

function orphanFunctionResponseTextPart(part: FunctionResponsePart): ContentPart {
  return {
    text: [
      '[工具响应上下文兜底]',
      '原因: 当前 LLM 请求上下文中没有找到这条工具响应对应的工具调用，已转为普通文本，避免 provider 拒绝请求。',
      `name: ${part.functionResponse.name}`,
      ...(part.id ? [`callId: ${part.id}`] : []),
      `response: ${stringifyJson(part.functionResponse.response)}`
    ].join('\n')
  };
}

function fallbackFunctionResponsePart(call: FunctionCallPart): FunctionResponsePart {
  return {
    ...(call.id ? { id: call.id } : {}),
    functionResponse: {
      name: call.functionCall.name,
      response: {
        ok: false,
        status: 'error',
        recovered: true,
        interrupted: true,
        message: TOOL_RESPONSE_CONTEXT_FALLBACK_MESSAGE,
        ...(call.id ? { toolCallId: call.id } : {})
      }
    }
  };
}

function normalizeToolCallId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

type MultimodalPreparationMode = 'ordinary' | 'native_compact';

interface AttachmentResolutionCacheEntry {
  mimeType?: string;
  name?: string;
  promise: Promise<InlineDataPart | undefined>;
}

export interface MultimodalPreparationContext {
  attachmentResolutions: Map<string, AttachmentResolutionCacheEntry>;
  canonicalMediaSizes: Map<string, number>;
}

export function createMultimodalPreparationContext(): MultimodalPreparationContext {
  return { attachmentResolutions: new Map<string, AttachmentResolutionCacheEntry>(), canonicalMediaSizes: new Map() };
}

async function prepareLlmContentMultimodal(
  content: MessageContent,
  options: LlmMultimodalPreparationOptions,
  toolResponse: boolean,
  mode: MultimodalPreparationMode = 'ordinary',
  preparation: MultimodalPreparationContext = createMultimodalPreparationContext()
): Promise<MessageContent> {
  const parts = await Promise.all(content.parts.map((part) =>
    prepareLlmPartMultimodal(part, options, toolResponse, mode, preparation)));
  return { ...content, parts: parts.flat() };
}

async function prepareLlmPartMultimodal(
  part: ContentPart,
  options: LlmMultimodalPreparationOptions,
  toolResponse: boolean,
  mode: MultimodalPreparationMode,
  preparation: MultimodalPreparationContext
): Promise<ContentPart[]> {
  if (isInlineDataPart(part)) {
    return [await prepareInlineDataForLlm(part, options, toolResponse, mode, preparation)];
  }
  if (isFunctionResponsePart(part) && part.functionResponse.parts?.length) {
    const prepared = await Promise.all(part.functionResponse.parts.map((inlinePart) =>
      prepareInlineDataForLlm(inlinePart, options, true, mode, preparation)));
    const inlineParts = prepared.filter(isInlineDataPart).filter((inlinePart) => isSupportedToolResponseInlineData(inlinePart));
    const placeholders = prepared.filter(isTextPart).map((textPart) => textPart.text).filter(Boolean);
    return [{
      ...part,
      functionResponse: {
        ...part.functionResponse,
        response: placeholders.length > 0 ? withAttachmentPlaceholders(part.functionResponse.response, placeholders) : part.functionResponse.response,
        ...(inlineParts.length > 0 ? { parts: inlineParts } : {})
      }
    }];
  }
  return [part];
}

export async function prepareInlineDataForLlm(
  part: InlineDataPart,
  options: LlmMultimodalPreparationOptions,
  toolResponse: boolean,
  mode: MultimodalPreparationMode,
  preparation: MultimodalPreparationContext
): Promise<ContentPart> {
  if (mode === 'ordinary' && toolResponse && !isSupportedToolResponseInlineData(part)) {
    return attachmentPlaceholderPart(part, '附件类型不在工具响应白名单中');
  }
  if (part.inlineData.data) {
    if (mode === 'native_compact') requireCanonicalInlineDataSize(part, 'Native Compact media', preparation);
    return toolResponse && !isSupportedToolResponseInlineData(part)
      ? attachmentPlaceholderPart(part, '附件类型不在工具响应白名单中')
      : part;
  }

  let resolved: InlineDataPart | undefined;
  try {
    resolved = await resolveAttachmentOnce(part, options, preparation);
  } catch (error) {
    if (error instanceof AttachmentResolutionMetadataConflictError) throw error;
    if (mode === 'native_compact') {
      throw new LlmNativeCompactMediaError(mediaReferenceLabel(part), errorSearchText(error));
    }
    resolved = undefined;
  }
  if (resolved?.inlineData.data) {
    if (mode === 'native_compact') requireCanonicalInlineDataSize(resolved, 'Resolved Native Compact media', preparation);
    return toolResponse && !isSupportedToolResponseInlineData(resolved)
      ? attachmentPlaceholderPart(resolved, '附件类型不在工具响应白名单中')
      : resolved;
  }
  if (mode === 'native_compact') {
    throw new LlmNativeCompactMediaError(
      mediaReferenceLabel(part),
      resolved?.inlineData.error ?? (options.resolveAttachment ? 'attachment resolver returned no bytes' : 'attachment resolver is unavailable')
    );
  }
  return attachmentPlaceholderPart(part, resolved?.inlineData.error ?? '附件读取失败');
}

class AttachmentResolutionMetadataConflictError extends Error {
  public constructor(key: string) {
    super(`Attachment resolver metadata conflicts for ${key}.`);
    this.name = 'AttachmentResolutionMetadataConflictError';
  }
}

export async function resolveAttachmentOnce(
  part: InlineDataPart,
  options: LlmMultimodalPreparationOptions,
  preparation: MultimodalPreparationContext
): Promise<InlineDataPart | undefined> {
  if (!options.resolveAttachment) return undefined;
  const attachmentId = part.inlineData.attachmentId?.trim();
  const sourcePath = part.inlineData.sourcePath?.trim();
  const mimeType = part.inlineData.mimeType?.trim() || undefined;
  const name = part.inlineData.name?.trim() || undefined;
  const key = attachmentId
    ? `attachment:${attachmentId}`
    : sourcePath
      ? `source:${sourcePath}`
      : `descriptor:${mimeType ?? ''}\0${name ?? ''}`;
  const existing = preparation.attachmentResolutions.get(key);
  if (existing) {
    if ((existing.mimeType && mimeType && existing.mimeType !== mimeType)
      || (existing.name && name && existing.name !== name)) {
      throw new AttachmentResolutionMetadataConflictError(key);
    }
    existing.mimeType ??= mimeType;
    existing.name ??= name;
    const resolved = await existing.promise;
    return resolved ? cloneInlineDataPart(resolved) : undefined;
  }
  const input = {
    attachmentId: part.inlineData.attachmentId,
    sourcePath: part.inlineData.sourcePath,
    mimeType: part.inlineData.mimeType,
    name: part.inlineData.name
  };
  const promise = Promise.resolve().then(() => options.resolveAttachment!(input));
  preparation.attachmentResolutions.set(key, { mimeType, name, promise });
  const resolved = await promise;
  return resolved ? cloneInlineDataPart(resolved) : undefined;
}

export function cloneInlineDataPart(part: InlineDataPart): InlineDataPart {
  return { ...part, inlineData: { ...part.inlineData } };
}

export class LlmNativeCompactMediaError extends Error {
  public readonly code = 'media_size_unknown';

  public constructor(reference: string, reason: string) {
    super(`media_size_unknown: Native Compact cannot resolve exact media bytes for ${reference}: ${reason}`);
    this.name = 'LlmNativeCompactMediaError';
  }
}

export function requireCanonicalInlineDataSize(part: InlineDataPart, label: string, preparation?: MultimodalPreparationContext): number {
  const data = part.inlineData.data;
  if (!data) {
    throw new LlmNativeCompactMediaError(mediaReferenceLabel(part), `${label} is not canonical base64`);
  }
  let byteLength = preparation?.canonicalMediaSizes.get(data);
  if (byteLength === undefined) {
    try {
      byteLength = decodeCanonicalBase64(data).byteLength;
    } catch {
      throw new LlmNativeCompactMediaError(mediaReferenceLabel(part), `${label} is not canonical base64`);
    }
    preparation?.canonicalMediaSizes.set(data, byteLength);
  }
  if (part.inlineData.sizeBytes !== undefined && part.inlineData.sizeBytes !== byteLength) {
    throw new LlmNativeCompactMediaError(
      mediaReferenceLabel(part),
      `${label} declared ${part.inlineData.sizeBytes} bytes but resolved ${byteLength}`
    );
  }
  return byteLength;
}

export function mediaReferenceLabel(part: InlineDataPart): string {
  return part.inlineData.attachmentId
    ?? part.inlineData.sourcePath
    ?? part.inlineData.name
    ?? part.inlineData.mimeType;
}

function isSupportedToolResponseInlineData(part: InlineDataPart): boolean {
  return isModelToolResponseMultimodalMimeType(part.inlineData.mimeType);
}

function withAttachmentPlaceholders(response: unknown, placeholders: string[]): unknown {
  const key = 'multimodalAttachmentPlaceholders';
  if (isRecord(response)) {
    const previous = Array.isArray(response[key]) ? response[key].filter((item): item is string => typeof item === 'string') : [];
    return { ...response, [key]: [...previous, ...placeholders] };
  }
  return { response, [key]: placeholders };
}

function attachmentPlaceholderPart(part: InlineDataPart, reason: string): ContentPart {
  const name = part.inlineData.name || part.inlineData.sourcePath || part.inlineData.attachmentId || '未命名附件';
  return {
    text: `[附件不可用: ${name}; mimeType=${part.inlineData.mimeType}; reason=${reason}]`
  };
}
