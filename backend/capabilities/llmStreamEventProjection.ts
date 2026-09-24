/**
 * unified/provider wire 值 → LimCode 事件/记录的投影。
 * 负责流式 chunk 与完成响应的事件发射、思考块生命周期与进度计时、用量元数据合并、
 * thought signature 便携格式互转、provider 错误记录的敏感字段清洗与文本化，
 * 以及本 capability 内各模块共用的 wire 值谓词。本模块不依赖 llmProvider，是 capability 内的叶模块。
 */
import type { LimCodeOpenAIResponsesStreamChunk } from './openAIResponsesWebSocketSession';
import { LlmEventType } from '../world/modules/llm/events';
import type {
  ContentPart,
  LlmUsageMetadataRecord,
  MessageContent,
  ModelOutputItemReference,
  ProviderContextPart
} from '../../shared/protocol';
import type { Emit } from './types';

type UnifiedContent = import('unified-llm-provider').Content;
type UnifiedPart = import('unified-llm-provider').Part;
type UnifiedLLMResponse = import('unified-llm-provider').LLMResponse;
type UnifiedLLMStreamChunk = import('unified-llm-provider').LLMStreamChunk;

const THOUGHT_PROGRESS_INTERVAL_MS = 500;

export function fromUnifiedCompletedContent(
  content: UnifiedContent,
  nativeChain?: OpenAIResponsesNativeChainContext
): MessageContent {
  const parts: ContentPart[] = [];
  for (const part of content.parts ?? []) {
    const outputItem = stampNativeResponse(modelOutputItemFromValue(part), nativeChain);
    if (isUnifiedThoughtTextPart(part)) {
      const signature = thoughtSignatureFromPart(part);
      parts.push({
        text: part.text ?? '',
        thought: true,
        ...(signature ? { thoughtSignature: signature } : {}),
        ...(outputItem ? { outputItem } : {})
      });
      continue;
    }
    if ('text' in part && typeof part.text === 'string') {
      parts.push({ text: part.text, ...(outputItem ? { outputItem } : {}) });
      continue;
    }
    if (isUnifiedFunctionCallPart(part)) {
      const signature = thoughtSignatureFromPart(part);
      const receivedAsync = 'async' in part.functionCall && part.functionCall.async === true;
      parts.push({
        ...(part.functionCall.callId ? { id: part.functionCall.callId } : {}),
        functionCall: {
          name: part.functionCall.name,
          args: part.functionCall.args ?? {}
        },
        ...(signature ? { thoughtSignature: signature } : {}),
        // 接收到的原生异步标记是历史事实，与当前 capability 无关，始终无损保留。
        ...(receivedAsync ? { async: true } : {}),
        ...(outputItem ? { outputItem } : {})
      });
      continue;
    }
    // 不透明的 provider 项（如 Responses 普通回复里的服务端 compaction 项）原位保留，随回复存入历史并原样回放。
    const providerContext = unifiedProviderContextOf(part);
    if (providerContext) parts.push({ providerContext, ...(outputItem ? { outputItem } : {}) });
  }
  return { role: 'model', parts };
}

/**
 * The opaque provider item of a unified part: today the Responses `compaction` output item of an
 * ordinary reply made with `context_management`, which later requests append as usual
 * (https://developers.openai.com/api/docs/guides/compaction).
 */
function unifiedProviderContextOf(part: unknown): ProviderContextPart['providerContext'] | undefined {
  if (!isRecord(part) || !isRecord(part.providerContext)) return undefined;
  const context = part.providerContext;
  return typeof context.provider === 'string' && typeof context.format === 'string'
    ? context as unknown as ProviderContextPart['providerContext']
    : undefined;
}

/**
 * Provider items travel as `OutputItemDone { part: { providerContext } }`; the reliable adapter
 * appends them to the completed reply in event order and drops repeats of the same item.
 */
function emitProviderContextParts(
  requestId: string,
  parts: readonly unknown[],
  emit: Emit,
  nativeChain?: OpenAIResponsesNativeChainContext
): void {
  for (const part of parts) {
    const providerContext = unifiedProviderContextOf(part);
    if (!providerContext) continue;
    const outputItem = stampNativeResponse(modelOutputItemFromValue(part), nativeChain);
    emit({
      type: LlmEventType.OutputItemDone,
      payload: { requestId, ...(outputItem ? { outputItem } : {}), part: { providerContext } }
    });
  }
}

/** Splits a chunk's provider items into those before its first other part and the rest, keeping stream order. */
function splitProviderContextParts(parts: readonly UnifiedPart[]): { leading: UnifiedPart[]; trailing: UnifiedPart[] } {
  const firstOther = parts.findIndex((part) => !unifiedProviderContextOf(part));
  const cut = firstOther < 0 ? parts.length : firstOther;
  return {
    leading: parts.slice(0, cut).filter((part) => !!unifiedProviderContextOf(part)),
    trailing: parts.slice(cut).filter((part) => !!unifiedProviderContextOf(part))
  };
}

export function emitUnifiedChunk(
  requestId: string,
  chunk: UnifiedLLMStreamChunk,
  emit: Emit,
  nativeChain?: OpenAIResponsesNativeChainContext
): void {
  const outputItem = stampNativeResponse(modelOutputItemFromValue(chunk), nativeChain);
  const providerContextParts = splitProviderContextParts(chunk.partsDelta ?? []);
  emitProviderContextParts(requestId, providerContextParts.leading, emit, nativeChain);
  if ((chunk.partsDelta ?? []).some(isSignedVisibleTextPart)) {
    emitVisibleTextParts(requestId, chunk.partsDelta ?? [], emit, outputItem);
  } else {
    const text = chunk.textDelta ?? visibleTextFromParts(chunk.partsDelta ?? []);
    if (text) emit({
      type: LlmEventType.Delta,
      payload: { requestId, text, ...(outputItem ? { outputItem } : {}) }
    });
  }

  const argumentDeltas = (chunk as LimCodeOpenAIResponsesStreamChunk).toolCallArgumentDeltas ?? [];
  if (argumentDeltas.length > 0) {
    emit({
      type: LlmEventType.ToolCallDelta,
      payload: {
        requestId,
        ...(outputItem ? { outputItem } : {}),
        calls: argumentDeltas.map((delta) => ({
          id: delta.callId,
          ...(delta.name ? { name: delta.name } : {}),
          argumentsDelta: delta.argumentsDelta,
          ...(delta.replace ? { replace: true } : {}),
          ...(delta.streamIndex ? { streamIndex: delta.streamIndex } : {})
        }))
      }
    });
  }

  const callParts = [
    ...(chunk.functionCalls ?? []),
    ...(chunk.partsDelta ?? []).filter(isUnifiedFunctionCallPart)
  ];
  const stableCallIndexes = new Map<string, number>();
  const calls: Array<{ id: string; name: string; argsJson: string; thoughtSignature?: string; async?: boolean }> = [];
  callParts.forEach((part, index) => {
    const stableCallId = part.functionCall.callId;
    const thoughtSignature = thoughtSignatureFromPart(part);
    const receivedAsync = 'async' in part.functionCall && part.functionCall.async === true;
    const candidate = {
      id: stableCallId ?? `tool_call_${index}`,
      name: part.functionCall.name,
      argsJson: stringifyJson(part.functionCall.args ?? {}),
      ...(thoughtSignature ? { thoughtSignature } : {}),
      ...(receivedAsync ? { async: true } : {})
    };
    const existingIndex = stableCallId ? stableCallIndexes.get(stableCallId) : undefined;
    if (existingIndex === undefined) {
      if (stableCallId) stableCallIndexes.set(stableCallId, calls.length);
      calls.push(candidate);
      return;
    }

    const existing = calls[existingIndex];
    calls[existingIndex] = {
      id: existing.id,
      name: existing.name.trim() ? existing.name : candidate.name,
      argsJson: candidate.argsJson.length > existing.argsJson.length ? candidate.argsJson : existing.argsJson,
      ...(existing.thoughtSignature || candidate.thoughtSignature
        ? { thoughtSignature: existing.thoughtSignature ?? candidate.thoughtSignature }
        : {}),
      ...(existing.async === true || candidate.async === true ? { async: true } : {})
    };
  });

  if (calls.length > 0) {
    emit({
      type: LlmEventType.ToolCallPreviewDone,
      payload: { requestId, callIds: calls.map((call) => call.id).filter((id): id is string => !!id) }
    });
    emit({ type: LlmEventType.ToolCall, payload: {
      requestId,
      ...(outputItem ? { outputItem } : {}),
      calls
    } });
  }

  emitProviderContextParts(requestId, providerContextParts.trailing, emit, nativeChain);

  const outputItemDone = stampNativeResponse(modelOutputItemDoneFromChunk(chunk), nativeChain);
  if (outputItemDone) {
    emit({
      type: LlmEventType.OutputItemDone,
      payload: { requestId, outputItem: outputItemDone }
    });
  }
}

export function emitUnifiedResponse(requestId: string, response: UnifiedLLMResponse, emit: Emit): void {
  const parts = response.content?.parts ?? [];
  // Provider items (the compaction item precedes the other output items) go first.
  emitProviderContextParts(requestId, parts, emit);
  if (parts.some(isSignedVisibleTextPart) || parts.some(isOutputItemVisibleTextPart)) {
    emitUnifiedResponsePartsInOrder(requestId, parts, emit);
    return;
  }
  const visibleText = visibleTextFromParts(parts);
  if (visibleText) emit({ type: LlmEventType.Delta, payload: { requestId, text: visibleText } });

  const thoughtParts = parts.filter(isUnifiedThoughtTextPart);
  for (const part of thoughtParts) emitCompletedThoughtPart(requestId, part, emit);

  const calls = parts.filter(isUnifiedFunctionCallPart).map((part, index) => completedToolCall(part, index));
  if (calls.length > 0) emit({ type: LlmEventType.ToolCall, payload: { requestId, calls } });
}

/**
 * A reply with a signature on a visible text part (Gemini: "The final content part (`text`,
 * `inlineData`…) returned by the model may contain a `thought_signature`", which "you must return
 * ... in the exact part where it was received"; https://ai.google.dev/gemini-api/docs/thought-signatures).
 * Its parts are emitted in response order, so the signed text part keeps both its signature and its
 * place after the thoughts. Replies without such a part keep the emission above unchanged.
 *
 * The same in-order emission serves a reply whose visible text carries an output item (a Responses
 * assistant message with `phase`, which must be preserved and resent on every assistant message:
 * https://developers.openai.com/api/reference/resources/responses). Consecutive text of one output
 * item becomes one group whose Deltas carry that item, so each message is stored, and replayed, as its
 * own item with its own phase instead of being merged into one untagged text.
 */
function emitUnifiedResponsePartsInOrder(requestId: string, parts: readonly UnifiedPart[], emit: Emit): void {
  let callIndex = 0;
  let textGroup: UnifiedPart[] = [];
  let textGroupItem: ModelOutputItemReference | undefined;
  const flushTextGroup = (): void => {
    if (textGroup.length > 0) emitVisibleTextParts(requestId, textGroup, emit, textGroupItem);
    textGroup = [];
    textGroupItem = undefined;
  };
  for (const part of parts) {
    if (isUnifiedVisibleTextPart(part)) {
      const outputItem = modelOutputItemFromValue(part);
      if (textGroup.length > 0 && outputItem?.id !== textGroupItem?.id) flushTextGroup();
      textGroup.push(part);
      textGroupItem = outputItem;
      continue;
    }
    flushTextGroup();
    if (isUnifiedThoughtTextPart(part)) {
      emitCompletedThoughtPart(requestId, part, emit);
    } else if (isUnifiedFunctionCallPart(part)) {
      emit({ type: LlmEventType.ToolCall, payload: { requestId, calls: [completedToolCall(part, callIndex)] } });
      callIndex += 1;
    }
  }
  flushTextGroup();
}

function emitCompletedThoughtPart(requestId: string, part: UnifiedPart, emit: Emit): void {
  const text = typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '';
  const signature = thoughtSignatureFromPart(part);
  const thoughtStartedAt = Date.now();
  if (text) emit({ type: LlmEventType.ThoughtDelta, payload: { requestId, text, thoughtStartedAt, thoughtElapsedMs: 0, ...(signature ? { thoughtSignature: signature } : {}) } });
  if (text || signature) emit({ type: LlmEventType.ThoughtDone, payload: { requestId, thoughtStartedAt, thoughtDurationMs: 0, ...(signature ? { thoughtSignature: signature } : {}) } });
}

function completedToolCall(
  part: Extract<UnifiedPart, { functionCall: unknown }>,
  index: number
): { id: string; name: string; argsJson: string; thoughtSignature?: string } {
  const thoughtSignature = thoughtSignatureFromPart(part);
  return {
    id: part.functionCall.callId ?? `tool_call_${index}`,
    name: part.functionCall.name,
    argsJson: stringifyJson(part.functionCall.args ?? {}),
    ...(thoughtSignature ? { thoughtSignature } : {})
  };
}

/**
 * Visible text of parts that include a signed text part. Gemini puts the signature of a reply
 * without function calls on its last part, and while streaming "may return the thought signature in
 * a part with an empty text content part"; it must go back "in the exact part where it was received"
 * (https://ai.google.dev/gemini-api/docs/thought-signatures), and parts with signatures are neither
 * concatenated together nor merged with a part without one
 * (https://ai.google.dev/gemini-api/docs/generate-content/thinking). So each signed text part,
 * empty or not, is its own Delta carrying its signature; the unsigned text between them is emitted
 * as before. Such a signature is not a thought and never opens a thought block.
 */
function emitVisibleTextParts(
  requestId: string,
  parts: readonly UnifiedPart[],
  emit: Emit,
  outputItem?: ModelOutputItemReference
): void {
  let unsignedText = '';
  const flushUnsignedText = (): void => {
    if (unsignedText) emit({ type: LlmEventType.Delta, payload: { requestId, text: unsignedText, ...(outputItem ? { outputItem } : {}) } });
    unsignedText = '';
  };
  for (const part of parts) {
    if (!isUnifiedVisibleTextPart(part)) continue;
    const text = (part as { text: string }).text;
    const thoughtSignature = thoughtSignatureFromPart(part);
    if (!thoughtSignature) {
      unsignedText += text;
      continue;
    }
    flushUnsignedText();
    emit({ type: LlmEventType.Delta, payload: { requestId, text, thoughtSignature, ...(outputItem ? { outputItem } : {}) } });
  }
  flushUnsignedText();
}

export interface LlmDoneTiming {
  createdAt: number;
  streamOutputDurationMs?: number;
}

export function createDoneTiming(
  firstChunkAt: number | undefined,
  finishedAt = Date.now(),
  firstChunkMark?: number,
  finishedMark?: number,
  _streamChunkCount = 0
): LlmDoneTiming {
  const rawDurationMs = firstChunkAt === undefined
    ? undefined
    : firstChunkMark !== undefined && finishedMark !== undefined
      ? finishedMark - firstChunkMark
      : finishedAt - firstChunkAt;

  const streamOutputDurationMs = rawDurationMs !== undefined
    ? Math.max(0, Math.round(rawDurationMs))
    : undefined;

  return {
    createdAt: firstChunkAt ?? finishedAt,
    ...(streamOutputDurationMs !== undefined ? { streamOutputDurationMs } : {})
  };
}

export function nowMonotonicMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function usageMetadataFromChunk(chunk: UnifiedLLMStreamChunk): LlmUsageMetadataRecord | undefined {
  const cleaned = stripUndefined(chunk.usageMetadata);
  return isRecord(cleaned) && Object.keys(cleaned).length > 0
    ? cleaned as LlmUsageMetadataRecord
    : undefined;
}

export function mergeUsageMetadata(
  previous: LlmUsageMetadataRecord | undefined,
  next: LlmUsageMetadataRecord
): LlmUsageMetadataRecord {
  if (!previous) return next;
  return { ...previous, ...next };
}

/** 原生链上当前正在解码的物理 response；output item 元数据按它标记归属边界。 */
export interface OpenAIResponsesNativeChainContext {
  current?: { responseId: string; previousResponseId?: string };
}

/** 跨 response 聚合计费 token：链上每个物理 response 的输入/输出都是真实计费量。 */
export function sumUsageMetadata(
  previous: LlmUsageMetadataRecord | undefined,
  next: LlmUsageMetadataRecord
): LlmUsageMetadataRecord {
  if (!previous) return next;
  const summed: LlmUsageMetadataRecord = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      (summed as Record<string, unknown>)[key] = value;
      continue;
    }
    const base = (previous as Record<string, unknown>)[key];
    (summed as Record<string, unknown>)[key] = (typeof base === 'number' && Number.isFinite(base) ? base : 0) + value;
  }
  return summed;
}

/** 给 output item 元数据标记原生 response 边界；非原生路径原样返回（同一引用）。 */
function stampNativeResponse(
  outputItem: ModelOutputItemReference | undefined,
  nativeChain?: OpenAIResponsesNativeChainContext
): ModelOutputItemReference | undefined {
  const current = nativeChain?.current;
  if (!outputItem || !current) return outputItem;
  if (outputItem.providerResponseId === current.responseId
    && outputItem.previousResponseId === current.previousResponseId) return outputItem;
  return {
    ...outputItem,
    providerResponseId: current.responseId,
    ...(current.previousResponseId ? { previousResponseId: current.previousResponseId } : {})
  };
}

export function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined);
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    result[key] = stripUndefined(child);
  }
  return result;
}

function modelOutputItemFromValue(value: unknown): ModelOutputItemReference | undefined {
  const source = isRecord(value) ? isRecord(value.outputItem) ? value.outputItem : undefined : undefined;
  if (!source || typeof source.id !== 'string' || !source.id.trim()
    || typeof source.ordinal !== 'number' || !Number.isSafeInteger(source.ordinal) || source.ordinal < 0) {
    return undefined;
  }
  const phase = source.phase === 'commentary' || source.phase === 'final_answer'
    ? source.phase
    : undefined;
  const providerResponseId = typeof source.providerResponseId === 'string' && source.providerResponseId.trim()
    ? source.providerResponseId
    : undefined;
  const previousResponseId = typeof source.previousResponseId === 'string' && source.previousResponseId.trim()
    ? source.previousResponseId
    : undefined;
  return {
    id: source.id,
    ordinal: source.ordinal,
    ...(phase ? { phase } : {}),
    ...(providerResponseId ? { providerResponseId } : {}),
    ...(previousResponseId ? { previousResponseId } : {})
  };
}

function modelOutputItemDoneFromChunk(chunk: UnifiedLLMStreamChunk): ModelOutputItemReference | undefined {
  const value = (chunk as LimCodeOpenAIResponsesStreamChunk).outputItemDone;
  return value ? modelOutputItemFromValue({ outputItem: value }) : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function hasStreamTimingChunk(chunk: UnifiedLLMStreamChunk): boolean {
  return hasStreamOutput(chunk)
    || hasThoughtOutput(chunk)
    || hasSignedVisibleTextPart(chunk)
    || ((chunk as LimCodeOpenAIResponsesStreamChunk).toolCallArgumentDeltas?.length ?? 0) > 0
    || (chunk as LimCodeOpenAIResponsesStreamChunk).nativeEvent !== undefined;
}

function hasThoughtOutput(chunk: UnifiedLLMStreamChunk): boolean {
  return !!thoughtSignatureFromChunk(chunk) || (chunk.partsDelta ?? []).some((part) => isUnifiedThoughtTextPart(part) && (!!part.text || !!thoughtSignatureFromPart(part)));
}

function hasStreamOutput(chunk: UnifiedLLMStreamChunk): boolean {
  if (chunk.textDelta || visibleTextFromParts(chunk.partsDelta ?? [])) return true;
  if ((chunk.functionCalls?.length ?? 0) > 0) return true;
  return (chunk.partsDelta ?? []).some(isUnifiedFunctionCallPart);
}

export function visibleTextFromParts(parts: UnifiedPart[]): string {
  return parts.map((part) => 'text' in part && (part as { thought?: unknown }).thought !== true ? part.text ?? '' : '').join('');
}

export interface ActiveThoughtBlock {
  startedAt: number;
  progressTimer?: ReturnType<typeof setInterval>;
  thoughtSignature?: string;
  outputItem?: ModelOutputItemReference;
}

export function emitThoughtDeltas(requestId: string, current: ActiveThoughtBlock | undefined, chunk: UnifiedLLMStreamChunk, at: number, emit: Emit, nativeChain?: OpenAIResponsesNativeChainContext): ActiveThoughtBlock | undefined {
  let block = current;
  const outputItem = stampNativeResponse(modelOutputItemFromValue(chunk), nativeChain);
  const chunkSignature = thoughtSignatureFromChunk(chunk);
  if (chunkSignature) {
    block ??= createActiveThoughtBlock(requestId, at, emit, outputItem);
    block.outputItem ??= outputItem;
    block.thoughtSignature = chunkSignature;
  }
  for (const part of chunk.partsDelta ?? []) {
    if (!isUnifiedThoughtTextPart(part)) continue;
    const text = part.text ?? '';
    block ??= createActiveThoughtBlock(requestId, at, emit, outputItem);
    block.outputItem ??= outputItem;
    const signature = thoughtSignatureFromPart(part);
    if (signature) block.thoughtSignature = signature;
    if (!text) continue;
    emit({
      type: LlmEventType.ThoughtDelta,
      payload: {
        requestId,
        text,
        thoughtStartedAt: block.startedAt,
        thoughtElapsedMs: Math.max(0, at - block.startedAt),
        ...(block.outputItem ? { outputItem: block.outputItem } : {}),
        ...(signature ? { thoughtSignature: signature } : {})
      }
    });
  }
  return block;
}

function createActiveThoughtBlock(
  requestId: string,
  startedAt: number,
  emit: Emit,
  outputItem?: ModelOutputItemReference
): ActiveThoughtBlock {
  const block: ActiveThoughtBlock = { startedAt, ...(outputItem ? { outputItem } : {}) };
  block.progressTimer = setInterval(() => {
    emit({
      type: LlmEventType.ThoughtProgress,
      payload: {
        requestId,
        thoughtStartedAt: block.startedAt,
        thoughtElapsedMs: Math.max(0, Date.now() - block.startedAt),
        ...(block.outputItem ? { outputItem: block.outputItem } : {}),
        ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {})
      }
    });
  }, THOUGHT_PROGRESS_INTERVAL_MS);
  return block;
}

export function disposeThoughtBlock(block: ActiveThoughtBlock): undefined {
  if (block.progressTimer) clearInterval(block.progressTimer);
  return undefined;
}

export function shouldCloseThoughtBlock(chunk: UnifiedLLMStreamChunk): boolean {
  return (chunk as LimCodeOpenAIResponsesStreamChunk).reasoningItemDone === true
    || !!chunk.finishReason
    || hasStreamOutput(chunk)
    || hasThoughtSignatureOnlyOutput(chunk)
    || hasSignedVisibleTextPart(chunk);
}

export function finishThoughtBlock(requestId: string, block: ActiveThoughtBlock, finishedAt: number, emit: Emit): undefined {
  disposeThoughtBlock(block);
  emit({
    type: LlmEventType.ThoughtDone,
    payload: {
      requestId,
      thoughtStartedAt: block.startedAt,
      thoughtDurationMs: Math.max(0, finishedAt - block.startedAt),
      ...(block.outputItem ? { outputItem: block.outputItem } : {}),
      ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {})
    }
  });
  return undefined;
}

function isUnifiedThoughtTextPart(part: UnifiedPart): part is UnifiedPart & { text?: string; thought?: unknown } {
  return (part as { thought?: unknown }).thought === true;
}

function isUnifiedFunctionCallPart(part: UnifiedPart): part is Extract<UnifiedPart, { functionCall: unknown }> {
  return 'functionCall' in part;
}

/** A text part that is not a thought, including an empty one. */
function isUnifiedVisibleTextPart(part: UnifiedPart): boolean {
  return !isUnifiedThoughtTextPart(part)
    && !isUnifiedFunctionCallPart(part)
    && typeof (part as { text?: unknown }).text === 'string';
}

/** A visible text part that arrived with a signature: only Gemini returns these today. */
function isSignedVisibleTextPart(part: UnifiedPart): boolean {
  return isUnifiedVisibleTextPart(part) && !!thoughtSignatureFromPart(part);
}

/** A visible text part tagged with its output item (a Responses assistant message with `phase`). */
function isOutputItemVisibleTextPart(part: UnifiedPart): boolean {
  return isUnifiedVisibleTextPart(part) && modelOutputItemFromValue(part) !== undefined;
}

function hasSignedVisibleTextPart(chunk: UnifiedLLMStreamChunk): boolean {
  return (chunk.partsDelta ?? []).some(isSignedVisibleTextPart);
}

function thoughtSignatureFromPart(part: UnifiedPart): string | undefined {
  const record = part as { thoughtSignature?: unknown; thoughtSignatures?: unknown };
  return normalizedSignatureString(record.thoughtSignature) ?? portableThoughtSignatureFromMap(record.thoughtSignatures);
}

/**
 * Chunk-level signature that belongs to a thought block. Gemini puts a signature on the part it
 * belongs to (a function call, or the last, possibly empty, text part of a reply without calls), and
 * the unified Gemini decoder mirrors every part signature onto the chunk; that mirrored copy is not a
 * thought. Treating it as one stored the signature a second time, on the preceding thought summary
 * or on an extra empty thought part, although the signature must be returned "in the exact part where
 * it was received" (https://ai.google.dev/gemini-api/docs/thought-signatures). The call keeps its own
 * signature through the ToolCall event, a text part through its Delta event.
 */
function thoughtSignatureFromChunk(chunk: UnifiedLLMStreamChunk): string | undefined {
  const record = chunk as { thoughtSignature?: unknown; thoughtSignatures?: unknown };
  const signature = normalizedSignatureString(record.thoughtSignature) ?? portableThoughtSignatureFromMap(record.thoughtSignatures);
  if (!signature || !isNonThoughtPartSignatureMirror(chunk, signature)) return signature;
  return undefined;
}

function isNonThoughtPartSignatureMirror(chunk: UnifiedLLMStreamChunk, signature: string): boolean {
  const value = thoughtSignatureValue(signature);
  const carriedBy = (part: UnifiedPart): boolean => {
    const partSignature = thoughtSignatureFromPart(part);
    return partSignature !== undefined && thoughtSignatureValue(partSignature) === value;
  };
  const parts = chunk.partsDelta ?? [];
  const carriers = [
    ...(chunk.functionCalls ?? []),
    ...parts.filter((part) => isUnifiedFunctionCallPart(part) || isUnifiedVisibleTextPart(part))
  ];
  return carriers.some(carriedBy)
    && !parts.some((part) => !isUnifiedFunctionCallPart(part) && !isUnifiedVisibleTextPart(part) && carriedBy(part));
}

function thoughtSignatureValue(signature: string): string {
  return parsePortableThoughtSignature(signature)?.value ?? signature;
}

function hasThoughtSignatureOnlyOutput(chunk: UnifiedLLMStreamChunk): boolean {
  const parts = chunk.partsDelta ?? [];
  const hasSignature = !!thoughtSignatureFromChunk(chunk) || parts.some((part) => isUnifiedThoughtTextPart(part) && !!thoughtSignatureFromPart(part));
  if (!hasSignature) return false;
  return !parts.some((part) => isUnifiedThoughtTextPart(part) && !!part.text);
}

export function normalizedSignatureString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

const THOUGHT_SIGNATURE_PROVIDER_ORDER = ['gemini', 'claude', 'openai-compatible', 'openai-responses'] as const;

function portableThoughtSignatureFromMap(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const provider of THOUGHT_SIGNATURE_PROVIDER_ORDER) {
    const signature = portableThoughtSignatureFromEntry(provider, value[provider]);
    if (signature) return signature;
  }
  for (const [provider, raw] of Object.entries(value)) {
    const signature = portableThoughtSignatureFromEntry(provider, raw);
    if (signature) return signature;
  }
  return undefined;
}

function portableThoughtSignatureFromEntry(provider: string, raw: unknown): string | undefined {
  const signature = normalizedSignatureString(raw);
  if (!signature) return undefined;
  const parsedSignature = parsePortableThoughtSignature(signature);
  if (parsedSignature) return `${parsedSignature.provider}:${parsedSignature.value}`;
  const normalizedProvider = normalizedSignatureProvider(provider);
  return normalizedProvider ? `${normalizedProvider}:${signature}` : undefined;
}

export function thoughtSignaturesFromPortableSignature(signature: string | undefined): Record<string, string> | undefined {
  const normalized = normalizedSignatureString(signature);
  if (!normalized) return undefined;
  const parsed = parsePortableThoughtSignature(normalized);
  return parsed ? { [parsed.provider]: parsed.value } : undefined;
}

export function parsePortableThoughtSignature(signature: string): { provider: string; value: string } | undefined {
  const colonIndex = signature.indexOf(':');
  if (colonIndex <= 0) return undefined;
  const provider = normalizedSignatureProvider(signature.slice(0, colonIndex));
  const value = signature.slice(colonIndex + 1).trim();
  if (!provider || !value) return undefined;
  return { provider, value };
}

function normalizedSignatureProvider(provider: string): string | undefined {
  const normalized = provider.trim().toLowerCase();
  if (!normalized || normalized === 'openai' || !/^[a-z0-9_-]+$/.test(normalized)) return undefined;
  return normalized;
}


export function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return String(value);
  }
}

export function nonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length > 0;
}

export function errorSearchText(error: unknown): string {
  const parts: string[] = [];
  if (typeof error === 'string') parts.push(error);
  if (error instanceof Error) {
    parts.push(error.name, error.message);
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined) parts.push(stringifyJson(toPlainJsonLike(cause)));
  }
  if (isRecord(error)) {
    parts.push(stringifyJson(toPlainJsonLike(error)));
    for (const key of ['message', 'bodyText', 'data', 'rawBody', 'rawResponse', 'response', 'error']) {
      const value = error[key];
      if (value !== undefined) parts.push(typeof value === 'string' ? value : stringifyJson(toPlainJsonLike(value)));
    }
  } else {
    parts.push(stringifyJson(toPlainJsonLike(error)));
  }
  return parts.filter(Boolean).join('\n');
}

export function toPlainJsonLike(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol' || typeof value === 'function') return String(value);
  if (value instanceof Error) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const source = value as Error & Record<string, unknown> & { cause?: unknown };
    const result: Record<string, unknown> = {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
    if (source.cause !== undefined) result.cause = toPlainJsonLike(source.cause, seen);
    for (const [key, child] of Object.entries(source)) {
      if (key === 'name' || key === 'message' || key === 'stack' || key === 'cause') continue;
      if (isSensitiveLlmErrorField(key)) continue;
      result[key] = toPlainJsonLike(child, seen);
    }
    return result;
  }
  if (typeof Headers !== 'undefined' && value instanceof Headers) {
    return plainRecordFromEntries(value.entries(), seen);
  }
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => toPlainJsonLike(item, seen));
  if (typeof (value as { entries?: unknown }).entries === 'function' && typeof (value as { forEach?: unknown }).forEach === 'function') {
    try {
      return plainRecordFromEntries((value as { entries(): Iterable<[string, unknown]> }).entries(), seen);
    } catch {
      // fall through
    }
  }
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveLlmErrorField(key)) continue;
    result[key] = toPlainJsonLike(child, seen);
  }
  return result;
}

function plainRecordFromEntries(entries: Iterable<[string, unknown]>, seen: WeakSet<object>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, child] of entries) {
    if (isSensitiveLlmErrorField(key)) continue;
    result[key] = toPlainJsonLike(child, seen);
  }
  return result;
}

export function isSensitiveLlmErrorField(key: string): boolean {
  const normalized = key.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normalized) return false;
  return normalized === 'authorization'
    || normalized.endsWith('authorization')
    || normalized === 'cookie'
    || normalized.endsWith('cookie')
    || normalized === 'auth'
    || normalized === 'credentials'
    || normalized === 'credential'
    || normalized === 'password'
    || normalized.endsWith('password')
    || normalized === 'passwd'
    || normalized === 'secret'
    || normalized.endsWith('secret')
    || normalized.endsWith('secretkey')
    || normalized === 'privatekey'
    || normalized.endsWith('privatekey')
    || normalized === 'accesskey'
    || normalized.endsWith('accesskey')
    || normalized === 'apikey'
    || normalized.endsWith('apikey')
    || normalized === 'xapikey'
    || normalized === 'token'
    || normalized.endsWith('authtoken')
    || normalized.endsWith('accesstoken')
    || normalized.endsWith('refreshtoken')
    || normalized.endsWith('sessiontoken')
    || normalized.endsWith('bearertoken')
    || normalized.endsWith('idtoken');
}
