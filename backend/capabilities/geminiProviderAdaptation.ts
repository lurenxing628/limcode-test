import { randomUUID } from 'node:crypto';
/**
 * Gemini provider 适配：thinking 配置按模型能力规范化、工具 schema 清洗、
 * OpenAI 兼容 wire 上 Gemini thought signature 的请求/响应双向透传，
 * 以及 provider schema encoder 的安装入口（installProviderCompatibility）。
 */
import {
  geminiThinkingCapabilityForModel,
  isGeminiThinkingLevelSupported
} from '../../shared/geminiThinking';
import type { LlmProviderKind } from '../../shared/protocol';
import { isRecord, normalizedSignatureString, parsePortableThoughtSignature } from './llmStreamEventProjection';

export function installProviderCompatibility<T>(
  provider: T,
  providerKind: LlmProviderKind,
  modelId: string
): T {
  return installGeminiOpenAICompatibleThoughtSignatures(
    installProviderSchemaEncoder(provider, providerKind, modelId),
    providerKind,
    modelId
  );
}

function installProviderSchemaEncoder<T>(
  provider: T,
  providerKind: LlmProviderKind,
  modelId: string
): T {
  const geminiOpenAICompatible = providerKind === 'openai-compatible' && isGeminiOpenAICompatibleModelName(modelId);
  if (providerKind !== 'gemini' && providerKind !== 'openai-responses' && providerKind !== 'claude' && !geminiOpenAICompatible) return provider;
  const fillsCurrentTurnSignatures = providerKind === 'gemini' && geminiModelMayValidateSignatures(modelId);
  const runtimeProvider = provider as T & {
    format?: {
      encodeRequest?: (request: unknown, stream: boolean) => unknown;
      __limcodeProviderSchemaEncoder?: true;
    };
  };
  const format = runtimeProvider.format;
  if (!format || typeof format.encodeRequest !== 'function' || format.__limcodeProviderSchemaEncoder) return provider;
  const originalEncodeRequest = format.encodeRequest.bind(format);
  format.encodeRequest = (request, stream) => {
    const claudeProjection = providerKind === 'claude'
      ? projectClaudeCompactionBlocks(request)
      : { request, blocks: new Map<string, unknown>() };
    const normalizedRequest = providerKind === 'gemini'
      ? normalizeGeminiThinkingRequest(claudeProjection.request, modelId)
      : claudeProjection.request;
    const encoded = originalEncodeRequest(normalizedRequest, stream);
    if (providerKind === 'gemini' || geminiOpenAICompatible) {
      restoreGeminiToolSchemas(encoded, normalizedRequest);
      if (providerKind === 'gemini' && fillsCurrentTurnSignatures) fillGeminiCurrentTurnSignatures(encoded);
    } else if (providerKind === 'claude') {
      restoreClaudeCompactionBlocks(encoded, claudeProjection.blocks);
      restoreClaudeToolResultPairing(encoded);
    } else if (isRecord(encoded) && Array.isArray(encoded.tools)) {
      for (const tool of encoded.tools) {
        if (isRecord(tool) && tool.type === 'function' && tool.name === 'edit') tool.strict = false;
      }
    }
    return encoded;
  };
  format.__limcodeProviderSchemaEncoder = true;
  return provider;
}

interface ClaudeToolResultBatch {
  toolResults: unknown[];
  trailing: unknown[];
  endIndexExclusive: number;
}

interface ClaudeCompactionProjection {
  request: unknown;
  blocks: Map<string, unknown>;
}

/**
 * unified-llm-provider does not yet know Anthropic's signed compaction block. Replace each frozen
 * ProviderContext part with a collision-resistant text marker for ordinary message encoding, then
 * restore the exact opaque block in the encoded Messages payload. No field of the signed block is
 * interpreted or rewritten here.
 */
function projectClaudeCompactionBlocks(request: unknown): ClaudeCompactionProjection {
  if (!isRecord(request) || !Array.isArray(request.contents)) {
    return { request, blocks: new Map() };
  }
  const blocks = new Map<string, unknown>();
  const markerScope = randomUUID();
  let ordinal = 0;
  let changed = false;
  const contents = request.contents.map((content) => {
    if (!isRecord(content) || !Array.isArray(content.parts)) return content;
    let contentChanged = false;
    const parts = content.parts.map((part) => {
      if (!isClaudeCompactionProviderPart(part)) return part;
      const marker = `\u241eLIMCODE_CLAUDE_COMPACTION_${markerScope}_${ordinal}\u241e`;
      ordinal += 1;
      blocks.set(marker, part.providerContext.rawItem);
      contentChanged = true;
      changed = true;
      return { text: marker };
    });
    return contentChanged ? { ...content, parts } : content;
  });
  return changed ? { request: { ...request, contents }, blocks } : { request, blocks };
}

function isClaudeCompactionProviderPart(value: unknown): value is {
  providerContext: { format: string; itemType?: string; rawItem: unknown };
} {
  if (!isRecord(value) || !isRecord(value.providerContext)) return false;
  const context = value.providerContext;
  return context.format === 'claude'
    && context.itemType === 'compaction'
    && isRecord(context.rawItem)
    && context.rawItem.type === 'compaction';
}

function restoreClaudeCompactionBlocks(encodedRequest: unknown, blocks: ReadonlyMap<string, unknown>): void {
  if (blocks.size === 0 || !isRecord(encodedRequest) || !Array.isArray(encodedRequest.messages)) return;
  for (const message of encodedRequest.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    message.content = message.content.map((block) => {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') return block;
      return blocks.get(block.text) ?? block;
    });
  }
}

/**
 * Claude 要求一条 assistant 消息里的每个 tool_use 都在紧随其后的那一条 user 消息里拿到 tool_result。
 * 规范上下文把每个工具结果冻结成独立片段，附件目录之类的片段还会排在它们中间，编码后就是多条 user 消息，
 * 并行工具调用因此被判为 `tool_use ids were found without tool_result blocks immediately after`。
 * 这里只重排 Claude 出站消息：同一批 tool_result 合并进紧邻的一条 user 消息，夹在中间的其他内容按原顺序追加到其后。
 */
function restoreClaudeToolResultPairing(encodedRequest: unknown): void {
  if (!isRecord(encodedRequest) || !Array.isArray(encodedRequest.messages)) return;
  const messages = encodedRequest.messages;
  const paired: unknown[] = [];
  let regrouped = false;
  for (let index = 0; index < messages.length; index += 1) {
    paired.push(messages[index]);
    const toolUseIds = claudeToolUseIds(messages[index]);
    if (toolUseIds.length === 0) continue;
    const batch = collectClaudeToolResults(messages, index + 1, toolUseIds);
    if (!batch) continue;
    paired.push({ role: 'user', content: [...batch.toolResults, ...batch.trailing] });
    if (batch.endIndexExclusive > index + 2 || batch.trailing.length > 0) regrouped = true;
    index = batch.endIndexExclusive - 1;
  }
  if (regrouped) encodedRequest.messages = paired;
}

function claudeToolUseIds(message: unknown): string[] {
  if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content)) return [];
  return message.content.flatMap((block) => isRecord(block)
    && block.type === 'tool_use'
    && typeof block.id === 'string'
    && block.id.length > 0
    ? [block.id]
    : []);
}

/** Scans the user messages that answer one assistant tool_use batch; stops at the first non-user message. */
function collectClaudeToolResults(
  messages: readonly unknown[],
  startIndex: number,
  toolUseIds: readonly string[]
): ClaudeToolResultBatch | undefined {
  const pending = new Set(toolUseIds);
  const toolResults: unknown[] = [];
  const trailing: unknown[] = [];
  let index = startIndex;
  for (; index < messages.length && pending.size > 0; index += 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== 'user') break;
    for (const block of claudeContentBlocks(message.content)) {
      const toolUseId = isRecord(block) && block.type === 'tool_result' && typeof block.tool_use_id === 'string'
        ? block.tool_use_id
        : undefined;
      if (toolUseId !== undefined && pending.delete(toolUseId)) toolResults.push(block);
      else trailing.push(block);
    }
  }
  return toolResults.length > 0 ? { toolResults, trailing, endIndexExclusive: index } : undefined;
}

function claudeContentBlocks(content: unknown): unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content === 'string' && content.length > 0) return [{ type: 'text', text: content }];
  return [];
}

/**
 * Google's documented dummy signature for function calls that Gemini did not produce itself
 * (history transferred from another model, or injected calls):
 * https://ai.google.dev/gemini-api/docs/thought-signatures (FAQ).
 */
const GEMINI_THOUGHT_SIGNATURE_SKIP_VALIDATOR = 'skip_thought_signature_validator';

/**
 * Gemini-like models on the OpenAI-compatible wire that receive the dummy for unsigned history:
 * everything the capability table resolves to a Gemini 3 thinking level, plus Gemini names it does
 * not know yet (`gemini-4-pro`, `gemini-flash-latest`).
 */
function fillsMissingGeminiSignatures(modelId: string): boolean {
  if (geminiThinkingCapabilityForModel(modelId).kind === 'thinkingLevel') return true;
  return isGeminiOpenAICompatibleModelName(modelId) && geminiModelMayValidateSignatures(modelId);
}

/**
 * Gemini 3 validates function-call signatures; Gemini 1.x/2.x do not ("Gemini 2.5 ... optional" in
 * https://ai.google.dev/gemini-api/docs/thought-signatures), so their existing requests stay unchanged.
 * Unknown Gemini names are treated as validating: the dummy is accepted either way.
 */
function geminiModelMayValidateSignatures(modelId: string): boolean {
  const kind = geminiThinkingCapabilityForModel(modelId).kind;
  if (kind === 'thinkingLevel') return true;
  if (kind === 'thinkingBudget') return false;
  const major = /^gemini-(\d+)/i.exec(geminiOpenAICompatibleBaseName(modelId))?.[1];
  return major === undefined || Number(major) >= 3;
}

/** `gemini-2.5-flash`, `models/gemini-3-pro`, `[v]gemini-3.5-flash`, `gemini-flash-latest`. */
function isGeminiOpenAICompatibleModelName(modelId: string): boolean {
  return /^gemini-(?:\d|pro(?:-|$)|flash(?:-|$))/i.test(geminiOpenAICompatibleBaseName(modelId));
}

function geminiOpenAICompatibleBaseName(modelId: string): string {
  return modelId.slice(modelId.lastIndexOf('/') + 1).trim().replace(/^\[[^\]]+\][\s_-]*/, '');
}

/**
 * An OpenAI-compatible model that reads Gemini signatures in `tool_calls[].extra_content`: a Gemini
 * name or a model the capability table knows as Gemini. Other models only see the Chat Completions
 * `tool_calls` fields `id`/`type`/`function`, and strict servers reject anything else.
 */
export function openAICompatibleModelReadsGeminiSignatures(modelId: string): boolean {
  const kind = geminiThinkingCapabilityForModel(modelId).kind;
  return kind === 'thinkingLevel' || kind === 'thinkingBudget' || isGeminiOpenAICompatibleModelName(modelId);
}

/**
 * The content with the Gemini signatures of its function calls removed (the values the OpenAI-
 * compatible encoder would send as `extra_content.google.thought_signature`); every other part and
 * other providers' signatures stay as they are. Returns the same object when nothing is removed.
 */
export function withoutGeminiFunctionCallSignatures<T extends { parts: readonly unknown[] }>(content: T): T {
  let changed = false;
  const parts = content.parts.map((part) => {
    if (!isRecord(part) || !isRecord(part.functionCall)) return part;
    const projected: Record<string, unknown> = { ...part };
    let partChanged = false;
    const portable = normalizedSignatureString(part.thoughtSignature);
    // An unprefixed signature is sent as a Gemini one (geminiSignatureFromUnifiedPart).
    if (portable && (parsePortableThoughtSignature(portable)?.provider ?? 'gemini') === 'gemini') {
      delete projected.thoughtSignature;
      partChanged = true;
    }
    if (isRecord(part.thoughtSignatures) && 'gemini' in part.thoughtSignatures) {
      const { gemini: _gemini, ...others } = part.thoughtSignatures;
      if (Object.keys(others).length > 0) projected.thoughtSignatures = others;
      else delete projected.thoughtSignatures;
      partChanged = true;
    }
    if (!partChanged) return part;
    changed = true;
    return projected;
  });
  return changed ? { ...content, parts } : content;
}

/**
 * Gemini thought signatures on the OpenAI-compatible wire travel in
 * `tool_calls[].extra_content.google.thought_signature`
 * (https://ai.google.dev/gemini-api/docs/thought-signatures, "OpenAI compatibility").
 *
 * - Decoding runs for every OpenAI-compatible model: a signature is kept whenever the response
 *   carries one, whatever the model is called on the gateway.
 * - Encoding returns the stored Gemini signature on the call it was received on. The dummy
 *   signature for calls that never had one is only added for Gemini-like models.
 * - Streaming matches signatures by call id, and by the call's position in the message only when
 *   the call has no id. The per-chunk ordinal is never compared with the global `index`: that made
 *   the second parallel call inherit the first call's signature.
 * - A signature that arrives after its call was already emitted (complete arguments first, the
 *   signature in a later delta) is delivered by emitting the same call again with the signature;
 *   consumers merge calls by id.
 */
export function installGeminiOpenAICompatibleThoughtSignatures<T>(
  provider: T,
  providerKind: LlmProviderKind,
  modelId: string
): T {
  if (providerKind !== 'openai-compatible') return provider;
  const fillMissingSignatures = fillsMissingGeminiSignatures(modelId);
  const runtimeProvider = provider as T & {
    format?: {
      encodeRequest?: (request: unknown, stream: boolean) => unknown;
      decodeResponse?: (raw: unknown) => unknown;
      decodeStreamChunk?: (raw: unknown, state: unknown) => unknown;
      finalizeStream?: (state: unknown) => unknown;
      __limcodeGeminiOpenAIThoughtSignatures?: true;
    };
  };
  const format = runtimeProvider.format;
  if (!format || format.__limcodeGeminiOpenAIThoughtSignatures) return provider;

  if (typeof format.encodeRequest === 'function') {
    const encodeRequest = format.encodeRequest.bind(format);
    format.encodeRequest = (request, stream) => {
      const encoded = encodeRequest(request, stream);
      attachGeminiOpenAIThoughtSignaturesToRequest(encoded, request, fillMissingSignatures);
      return encoded;
    };
  }
  if (typeof format.decodeResponse === 'function') {
    const decodeResponse = format.decodeResponse.bind(format);
    format.decodeResponse = (raw) => {
      const signatures = emptyGeminiOpenAIToolCallSignatures();
      readGeminiOpenAIToolCallSignatures(raw, 'message', signatures);
      const decoded = decodeResponse(raw);
      attachGeminiSignaturesToUnifiedCalls(decoded, signatures);
      return decoded;
    };
  }
  const streamSignatures = new WeakMap<object, GeminiOpenAIToolCallSignatures>();
  const signaturesForStream = (state: unknown): GeminiOpenAIToolCallSignatures => {
    const stateKey = isRecord(state) ? state : format;
    let signatures = streamSignatures.get(stateKey);
    if (!signatures) {
      signatures = emptyGeminiOpenAIToolCallSignatures();
      streamSignatures.set(stateKey, signatures);
    }
    return signatures;
  };
  if (typeof format.decodeStreamChunk === 'function') {
    const decodeStreamChunk = format.decodeStreamChunk.bind(format);
    format.decodeStreamChunk = (raw, state) => {
      const signatures = signaturesForStream(state);
      readGeminiOpenAIToolCallSignatures(raw, 'delta', signatures);
      const decoded = decodeStreamChunk(raw, state);
      attachGeminiSignaturesToUnifiedCalls(decoded, signatures);
      return decoded;
    };
  }
  if (typeof format.finalizeStream === 'function') {
    // Calls flushed by an end-of-stream hook belong to the same message and keep the same tracker.
    const finalizeStream = format.finalizeStream.bind(format);
    format.finalizeStream = (state) => {
      const decoded = finalizeStream(state);
      attachGeminiSignaturesToUnifiedCalls(decoded, signaturesForStream(state));
      return decoded;
    };
  }
  format.__limcodeGeminiOpenAIThoughtSignatures = true;
  return provider;
}

/**
 * Signatures seen so far in one assistant message. `position` is the call's place in the message
 * (order of first appearance on the wire), which is what decoded unified calls are emitted in.
 */
interface GeminiOpenAIToolCallSignatures {
  byId: Map<string, string>;
  byPosition: Map<number, string>;
  positionById: Map<string, number>;
  positionByIndex: Map<number, number>;
  lastPosition: number | undefined;
  nextPosition: number;
  /** Unified calls already matched; their count is the position of the next id-less call. */
  decodedCalls: WeakSet<object>;
  decodedCallCount: number;
  /**
   * Calls with an id that were emitted before their signature arrived (the library emits a streamed
   * call as soon as its arguments are complete JSON), keyed by position.
   */
  unsignedEmittedCalls: Map<number, { callId: string; part: Record<string, unknown> }>;
}

function attachGeminiOpenAIThoughtSignaturesToRequest(
  encoded: unknown,
  source: unknown,
  fillMissingSignatures: boolean
): void {
  if (!isRecord(encoded) || !isRecord(source)) return;
  const messages = Array.isArray(encoded.messages) ? encoded.messages.filter(isRecord) : [];
  const encodedCallGroups = messages.flatMap((message) =>
    message.role === 'assistant' && Array.isArray(message.tool_calls)
      ? [message.tool_calls.filter(isRecord)]
      : []);
  const sourceContents = Array.isArray(source.contents) ? source.contents.filter(isRecord) : [];
  const sourceCallGroups = sourceContents.flatMap((content) => {
    if (content.role !== 'model' || !Array.isArray(content.parts)) return [];
    const parts = content.parts.filter(isRecord);
    const calls = parts.filter((part) => isRecord(part.functionCall));
    return calls.length > 0 ? [{ calls, carriesReasoningDetails: parts.some(carriesOpenRouterReasoningDetails) }] : [];
  });

  for (let groupIndex = 0; groupIndex < Math.min(encodedCallGroups.length, sourceCallGroups.length); groupIndex += 1) {
    const encodedCalls = encodedCallGroups[groupIndex];
    const { calls: sourceCalls, carriesReasoningDetails } = sourceCallGroups[groupIndex];
    const sourceSignatures = sourceCalls.map(geminiSignatureFromUnifiedPart);
    // OpenRouter carries Gemini's signatures inside the replayed `reasoning_details`; a dummy in
    // extra_content next to them is untested there, so only plain gateways get it.
    const transferredGroup = fillMissingSignatures
      && !carriesReasoningDetails
      && sourceSignatures.every((signature) => !signature);
    for (let callIndex = 0; callIndex < Math.min(encodedCalls.length, sourceCalls.length); callIndex += 1) {
      const signature = sourceSignatures[callIndex]
        ?? (transferredGroup ? GEMINI_THOUGHT_SIGNATURE_SKIP_VALIDATOR : undefined);
      if (!signature) continue;
      const toolCall = encodedCalls[callIndex];
      const extraContent = isRecord(toolCall.extra_content) ? toolCall.extra_content : {};
      const google = isRecord(extraContent.google) ? extraContent.google : {};
      const attachedSignature = normalizedSignatureString(google.thought_signature)
        ?? normalizedSignatureString(google.thoughtSignature)
        ?? signature;
      // Google documents snake_case; the tested gateway only reads camelCase. Send both.
      toolCall.extra_content = {
        ...extraContent,
        google: {
          ...google,
          thought_signature: attachedSignature,
          thoughtSignature: attachedSignature
        }
      };
    }
  }
}

/**
 * A part whose OpenAI-compatible signature is the replay envelope for OpenRouter
 * `reasoning_details` (a JSON object string, https://openrouter.ai/docs/use-cases/reasoning-tokens).
 */
function carriesOpenRouterReasoningDetails(part: Record<string, unknown>): boolean {
  const signatures = isRecord(part.thoughtSignatures) ? part.thoughtSignatures : undefined;
  const portable = normalizedSignatureString(part.thoughtSignature);
  const parsedPortable = portable ? parsePortableThoughtSignature(portable) : undefined;
  const envelope = normalizedSignatureString(signatures?.['openai-compatible'])
    ?? (parsedPortable?.provider === 'openai-compatible' ? parsedPortable.value : undefined);
  if (!envelope?.startsWith('{')) return false;
  try {
    const parsed: unknown = JSON.parse(envelope);
    return isRecord(parsed) && Array.isArray(parsed.reasoning_details) && parsed.reasoning_details.length > 0;
  } catch {
    return false;
  }
}

function readGeminiOpenAIToolCallSignatures(
  raw: unknown,
  messageKey: 'message' | 'delta',
  signatures: GeminiOpenAIToolCallSignatures
): void {
  if (!isRecord(raw) || !Array.isArray(raw.choices)) return;
  const choice = raw.choices.find(isRecord);
  if (!choice) return;
  const rawMessage = choice[messageKey];
  if (!isRecord(rawMessage) || !Array.isArray(rawMessage.tool_calls)) return;
  const streamed = messageKey === 'delta';
  for (const toolCall of rawMessage.tool_calls) {
    if (!isRecord(toolCall)) continue;
    const callId = normalizedSignatureString(toolCall.id);
    const position = streamed
      ? streamedToolCallPosition(signatures, toolCall, callId)
      : claimNextPosition(signatures);
    if (callId && !signatures.positionById.has(callId)) signatures.positionById.set(callId, position);
    const signature = geminiOpenAIToolCallSignature(toolCall);
    if (!signature) continue;
    if (callId) signatures.byId.set(callId, signature);
    signatures.byPosition.set(position, signature);
  }
}

/**
 * A streamed delta belongs to the call with the same `index`; without an index a new id starts a
 * new call and an id-less fragment continues the latest call.
 */
function streamedToolCallPosition(
  signatures: GeminiOpenAIToolCallSignatures,
  toolCall: Record<string, unknown>,
  callId: string | undefined
): number {
  if (typeof toolCall.index === 'number' && Number.isSafeInteger(toolCall.index)) {
    const known = signatures.positionByIndex.get(toolCall.index);
    if (known !== undefined) return rememberLastPosition(signatures, known);
    const position = (callId ? signatures.positionById.get(callId) : undefined) ?? claimNextPosition(signatures);
    signatures.positionByIndex.set(toolCall.index, position);
    return rememberLastPosition(signatures, position);
  }
  if (callId) {
    return rememberLastPosition(signatures, signatures.positionById.get(callId) ?? claimNextPosition(signatures));
  }
  return signatures.lastPosition ?? claimNextPosition(signatures);
}

function claimNextPosition(signatures: GeminiOpenAIToolCallSignatures): number {
  const position = signatures.nextPosition;
  signatures.nextPosition += 1;
  return rememberLastPosition(signatures, position);
}

function rememberLastPosition(signatures: GeminiOpenAIToolCallSignatures, position: number): number {
  signatures.lastPosition = position;
  return position;
}

function geminiOpenAIToolCallSignature(toolCall: Record<string, unknown>): string | undefined {
  const extraContent = isRecord(toolCall.extra_content) ? toolCall.extra_content : undefined;
  const google = isRecord(extraContent?.google) ? extraContent.google : undefined;
  const vertex = isRecord(extraContent?.vertex) ? extraContent.vertex : undefined;
  return normalizedSignatureString(google?.thought_signature)
    ?? normalizedSignatureString(google?.thoughtSignature)
    ?? normalizedSignatureString(vertex?.thought_signature)
    ?? normalizedSignatureString(vertex?.thoughtSignature);
}

function attachGeminiSignaturesToUnifiedCalls(
  decoded: unknown,
  signatures: GeminiOpenAIToolCallSignatures
): void {
  if (!isRecord(decoded)) return;
  const candidates = [
    ...(Array.isArray(decoded.functionCalls) ? decoded.functionCalls : []),
    ...(Array.isArray(decoded.partsDelta) ? decoded.partsDelta : []),
    ...(isRecord(decoded.content) && Array.isArray(decoded.content.parts) ? decoded.content.parts : [])
  ];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.functionCall) || signatures.decodedCalls.has(candidate)) continue;
    signatures.decodedCalls.add(candidate);
    const position = signatures.decodedCallCount;
    signatures.decodedCallCount += 1;
    const callId = normalizedSignatureString(candidate.functionCall.callId);
    const knownPosition = callId ? signatures.positionById.get(callId) : undefined;
    const signature = callId
      ? signatures.byId.get(callId) ?? (knownPosition !== undefined ? signatures.byPosition.get(knownPosition) : undefined)
      : signatures.byPosition.get(position);
    if (!signature) {
      if (callId) signatures.unsignedEmittedCalls.set(knownPosition ?? position, { callId, part: candidate });
      continue;
    }
    const existing = isRecord(candidate.thoughtSignatures) ? candidate.thoughtSignatures : {};
    candidate.thoughtSignatures = { ...existing, gemini: signature };
  }
  reemitLateSignedCalls(decoded, signatures);
}

/** Emits again, with its signature, each already emitted call whose signature arrived since. */
function reemitLateSignedCalls(decoded: Record<string, unknown>, signatures: GeminiOpenAIToolCallSignatures): void {
  for (const [position, { callId, part }] of signatures.unsignedEmittedCalls) {
    const signature = signatures.byId.get(callId) ?? signatures.byPosition.get(position);
    if (!signature) continue;
    signatures.unsignedEmittedCalls.delete(position);
    const existing = isRecord(part.thoughtSignatures) ? part.thoughtSignatures : {};
    const signed = { ...part, thoughtSignatures: { ...existing, gemini: signature } };
    signatures.decodedCalls.add(signed);
    decoded.functionCalls = [...(Array.isArray(decoded.functionCalls) ? decoded.functionCalls : []), signed];
  }
}

function geminiSignatureFromUnifiedPart(part: Record<string, unknown>): string | undefined {
  const signatures = isRecord(part.thoughtSignatures) ? part.thoughtSignatures : undefined;
  const mapped = normalizedSignatureString(signatures?.gemini);
  if (mapped) return mapped;
  const portable = normalizedSignatureString(part.thoughtSignature);
  if (!portable) return undefined;
  // Another provider's portable signature is not a Gemini signature; an unprefixed value is.
  const parsed = parsePortableThoughtSignature(portable);
  if (!parsed) return portable;
  return parsed.provider === 'gemini' ? parsed.value : undefined;
}

function emptyGeminiOpenAIToolCallSignatures(): GeminiOpenAIToolCallSignatures {
  return {
    byId: new Map(),
    byPosition: new Map(),
    positionById: new Map(),
    positionByIndex: new Map(),
    lastPosition: undefined,
    nextPosition: 0,
    decodedCalls: new WeakSet(),
    decodedCallCount: 0,
    unsignedEmittedCalls: new Map()
  };
}

/**
 * Native Gemini validates signatures only in the current turn: everything after the newest user
 * content that carries ordinary content (text, media) rather than a functionResponse. In that turn
 * "the first functionCall part in each step ... must include its thought_signature", otherwise 400
 * (https://ai.google.dev/gemini-api/docs/thought-signatures). Calls produced by another model, or
 * retried on Gemini after another model failed, have no Gemini signature; the documented dummy
 * goes on the first call of each such model content. Existing signatures are never touched.
 *
 * A user content that mixes function responses with text is not treated as a turn boundary, so the
 * turn can only be over-estimated; a dummy in an unvalidated earlier turn is harmless.
 */
function fillGeminiCurrentTurnSignatures(encodedRequest: unknown): void {
  if (!isRecord(encodedRequest) || !Array.isArray(encodedRequest.contents)) return;
  const contents = encodedRequest.contents;
  let turnStart = 0;
  for (let index = contents.length - 1; index >= 0; index -= 1) {
    if (isGeminiTurnStartingUserContent(contents[index])) {
      turnStart = index + 1;
      break;
    }
  }
  for (const content of contents.slice(turnStart)) {
    if (!isRecord(content) || content.role !== 'model' || !Array.isArray(content.parts)) continue;
    const firstCall = content.parts.find((part) => isRecord(part) && isRecord(part.functionCall));
    if (!isRecord(firstCall) || normalizedSignatureString(firstCall.thoughtSignature)) continue;
    firstCall.thoughtSignature = GEMINI_THOUGHT_SIGNATURE_SKIP_VALIDATOR;
  }
}

function isGeminiTurnStartingUserContent(content: unknown): boolean {
  if (!isRecord(content) || content.role !== 'user' || !Array.isArray(content.parts)) return false;
  const parts = content.parts.filter(isRecord);
  return parts.length > 0 && !parts.some((part) => isRecord(part.functionResponse));
}

function normalizeGeminiThinkingRequest(request: unknown, modelId: string): unknown {
  if (!isRecord(request)) return request;
  const capability = geminiThinkingCapabilityForModel(modelId);
  if (capability.kind === 'unknown') return request;

  const generationConfig = isRecord(request.generationConfig) ? request.generationConfig : {};
  const sourceThinkingConfig = isRecord(generationConfig.thinkingConfig)
    ? generationConfig.thinkingConfig
    : {};
  const thinkingConfig: Record<string, unknown> = { ...sourceThinkingConfig };

  if (capability.kind === 'thinkingLevel') {
    const configuredLevel = sourceThinkingConfig.thinkingLevel;
    const unset = configuredLevel === undefined || configuredLevel === 'not-set' || configuredLevel === 'non-set';
    if (sourceThinkingConfig.thinkingBudget !== undefined
      || !unset && !isGeminiThinkingLevelSupported(capability, configuredLevel)) {
      throw Object.assign(new Error(`Unsupported Gemini thinking configuration for ${modelId}: use a supported thinkingLevel, not a numeric budget.`),
        { code: 'UNSUPPORTED_REASONING_CONFIGURATION' });
    }
    if (isGeminiThinkingLevelSupported(capability, configuredLevel)) {
      thinkingConfig.thinkingLevel = configuredLevel;
      if (thinkingConfig.includeThoughts === undefined) thinkingConfig.includeThoughts = true;
    } else {
      // Missing/unset means Provider default. Explicit unsupported values are rejected above.
      delete thinkingConfig.thinkingLevel;
      if (sourceThinkingConfig.includeThoughts === undefined) delete thinkingConfig.includeThoughts;
    }
    delete thinkingConfig.thinkingBudget;
  } else {
    if (capability.kind === 'thinkingBudget' && sourceThinkingConfig.thinkingLevel !== undefined
      && sourceThinkingConfig.thinkingLevel !== 'not-set' && sourceThinkingConfig.thinkingLevel !== 'non-set') {
      throw Object.assign(new Error(`Unsupported Gemini thinkingLevel for ${modelId}: use thinkingBudget.`),
        { code: 'UNSUPPORTED_REASONING_CONFIGURATION' });
    }
    delete thinkingConfig.thinkingLevel;
    if (capability.kind === 'unsupported') delete thinkingConfig.thinkingBudget;
  }

  const nextGenerationConfig: Record<string, unknown> = { ...generationConfig };
  if (Object.keys(thinkingConfig).length > 0) nextGenerationConfig.thinkingConfig = thinkingConfig;
  else delete nextGenerationConfig.thinkingConfig;
  const { generationConfig: _sourceGenerationConfig, ...requestWithoutGenerationConfig } = request;
  return Object.keys(nextGenerationConfig).length > 0
    ? { ...requestWithoutGenerationConfig, generationConfig: nextGenerationConfig }
    : requestWithoutGenerationConfig;
}

function restoreGeminiToolSchemas(encodedRequest: unknown, sourceRequest: unknown): void {
  if (!isRecord(encodedRequest) || !isRecord(sourceRequest)) return;
  const encodedGroups = Array.isArray(encodedRequest.tools) ? encodedRequest.tools : [];
  const sourceGroups = Array.isArray(sourceRequest.tools) ? sourceRequest.tools : [];
  const sourceDeclarations = sourceGroups.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.functionDeclarations)) return [];
    return group.functionDeclarations.filter(isRecord);
  });
  const sourceByName = new Map(sourceDeclarations
    .filter((declaration) => typeof declaration.name === 'string')
    .map((declaration) => [declaration.name as string, declaration]));
  const encodedDeclarations = encodedGroups.flatMap((group) => {
    if (!isRecord(group)) return [];
    if (Array.isArray(group.functionDeclarations)) return group.functionDeclarations.filter(isRecord);
    return group.type === 'function' && isRecord(group.function) ? [group.function] : [];
  });
  for (const declaration of encodedDeclarations) {
    if (typeof declaration.name !== 'string') continue;
    const source = sourceByName.get(declaration.name);
    if (!source?.parameters) continue;
    declaration.parameters = withOnlyDefinedGeminiRequired(sanitizeGeminiFunctionSchema(source.parameters));
  }
}

/**
 * Gemini function parameters accept only the documented Schema subset
 * (https://ai.google.dev/api/generate-content#v1beta.Schema); any other field is rejected with
 * 400 "Invalid JSON payload received. Unknown name ... Cannot find field" (gateway-tested for
 * `uniqueItems`, `examples`, `$ref`, `patternProperties` and `type` arrays).
 *
 * Kept as-is (documented values): type, format, description, nullable, enum, maxItems, minItems,
 * required, minProperties, maxProperties, minLength, maxLength, pattern, example, propertyOrdering,
 * minimum, maximum. Recursed into (documented schemas): properties, items, anyOf.
 * `title` and `default` are documented too but have always been removed here; they carry no
 * validation and removing them keeps every built-in tool schema byte-identical.
 */
const GEMINI_SCHEMA_VALUE_FIELDS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'maxItems',
  'minItems',
  'required',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'propertyOrdering',
  'minimum',
  'maximum'
]);

const GEMINI_SCHEMA_UNION_FIELDS = new Set(['anyOf', 'oneOf', 'allOf']);

/** Local `$ref` chains deeper than this are cut like a cycle, so shared definitions cannot explode. */
const GEMINI_SCHEMA_MAX_REF_DEPTH = 8;

interface GeminiSchemaContext {
  root: unknown;
  refStack: readonly string[];
}

function sanitizeGeminiFunctionSchema(value: unknown, context?: GeminiSchemaContext): unknown {
  const schemaContext = context ?? { root: value, refStack: [] };
  if (Array.isArray(value)) return value.map((item) => sanitizeGeminiFunctionSchema(item, schemaContext));
  if (!isRecord(value)) return value;
  if (typeof value.$ref === 'string') return sanitizeGeminiSchemaReference(value, value.$ref, schemaContext);

  const result: Record<string, unknown> = {};
  const merges: Record<string, unknown>[] = [];
  let stringifiedEnum = false;
  let nonStringEnum = false;
  let nullable = false;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'properties' && isRecord(child)) {
      result.properties = Object.fromEntries(
        Object.entries(child).map(([propertyName, propertySchema]) => [
          propertyName,
          sanitizeGeminiFunctionSchema(propertySchema, schemaContext)
        ])
      );
      continue;
    }
    if (GEMINI_SCHEMA_UNION_FIELDS.has(key) && Array.isArray(child)) {
      const union = sanitizeGeminiSchemaUnion(value, key, child, schemaContext);
      if (union.anyOf) result.anyOf = union.anyOf;
      merges.push(...union.merges);
      nullable ||= union.nullable;
      continue;
    }
    if (key === 'type' && Array.isArray(child)) {
      // JSON Schema `type: [T, "null"]` is Gemini `type: T, nullable: true`.
      const types = child.filter((type): type is string => typeof type === 'string');
      const nonNull = types.filter((type) => type.toLowerCase() !== 'null');
      // `items` belong to the array type and `properties`/`required` to the object type: the first
      // listed type would put them on a string (`{type: "string", items}`).
      if (nonNull.length > 0) result.type = geminiTypeForTypeSpecificFields(value, nonNull) ?? nonNull[0];
      else if (types.length > 0) result.type = types[0];
      if (nonNull.length > 1 && !hasTypeSpecificGeminiFields(value)) {
        delete result.type;
        result.anyOf = nonNull.map((type) => ({ type }));
      }
      nullable ||= nonNull.length > 0 && nonNull.length < types.length;
      continue;
    }
    if (key === 'const') {
      // A string `const` is a single-value enum; other literals keep being dropped as before.
      if (typeof child === 'string' && !Object.prototype.hasOwnProperty.call(value, 'enum')) {
        result.enum = [child];
        if (value.type === undefined) result.type = 'string';
      }
      continue;
    }
    if (key === 'enum' && Array.isArray(child)) {
      result.enum = child.map((item) => String(item));
      stringifiedEnum = true;
      nonStringEnum ||= child.some((item) => typeof item !== 'string');
      continue;
    }
    if (key === 'items') {
      const items = Array.isArray(child) ? child[0] : child;
      if (items !== undefined) result.items = sanitizeGeminiFunctionSchema(items, schemaContext);
      continue;
    }
    if (GEMINI_SCHEMA_VALUE_FIELDS.has(key)) result[key] = cloneGeminiSchemaValue(child);
  }

  for (const merge of merges) mergeGeminiSchemaInto(result, merge);
  if (nullable && result.nullable === undefined) result.nullable = true;
  if (stringifiedEnum && (result.type === 'integer' || result.type === 'number')) result.type = 'string';
  // Gemini enums are strings: numbers stringified above need the matching type (a typeless string
  // enum is sent as before).
  if (nonStringEnum && result.type === undefined) result.type = 'string';
  if (Array.isArray(result.required) && isRecord(result.properties)) {
    const required = result.required.filter((propertyName): propertyName is string =>
      typeof propertyName === 'string' && Object.prototype.hasOwnProperty.call(result.properties, propertyName)
    );
    if (required.length > 0) result.required = required;
    else delete result.required;
  }
  return result;
}

/**
 * Final pass over the sanitized parameters: Gemini checks every `required` name against the same
 * schema's own `properties`. A schema without properties (for example a parent whose properties are
 * defined only in its `anyOf` branches, which keep their own required lists) drops its `required`.
 * Runs after unions and `allOf` members are folded, so a required list that met its properties in the
 * parent is kept.
 */
function withOnlyDefinedGeminiRequired(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withOnlyDefinedGeminiRequired);
  if (!isRecord(schema)) return schema;
  if (isRecord(schema.properties)) {
    for (const [name, property] of Object.entries(schema.properties)) {
      schema.properties[name] = withOnlyDefinedGeminiRequired(property);
    }
  }
  if (schema.items !== undefined) schema.items = withOnlyDefinedGeminiRequired(schema.items);
  if (Array.isArray(schema.anyOf)) schema.anyOf = schema.anyOf.map(withOnlyDefinedGeminiRequired);
  if (Array.isArray(schema.required) && !isRecord(schema.properties)) delete schema.required;
  return schema;
}

/** The listed type that the schema's type-specific fields belong to, if any. */
function geminiTypeForTypeSpecificFields(value: Record<string, unknown>, types: readonly string[]): string | undefined {
  const wanted = value.items !== undefined ? 'array'
    : value.properties !== undefined || value.required !== undefined ? 'object'
      : undefined;
  return wanted ? types.find((type) => type.toLowerCase() === wanted) : undefined;
}

/**
 * Local references (`#/$defs/...`, `#/definitions/...`, any JSON pointer into the parameters) are
 * inlined before `$defs`/`definitions` are dropped; sibling keywords at the reference site win. A
 * recursive or overly deep reference becomes an object without further structure; a reference that
 * cannot be resolved locally is dropped with its siblings kept.
 */
function sanitizeGeminiSchemaReference(
  value: Record<string, unknown>,
  ref: string,
  context: GeminiSchemaContext
): unknown {
  const { $ref: _ref, ...siblings } = value;
  const target = resolveLocalGeminiSchemaReference(context.root, ref);
  if (!isRecord(target)) return sanitizeGeminiFunctionSchema(siblings, context);
  if (context.refStack.includes(ref) || context.refStack.length >= GEMINI_SCHEMA_MAX_REF_DEPTH) {
    return sanitizeGeminiFunctionSchema({ type: 'object', ...siblings }, context);
  }
  return sanitizeGeminiFunctionSchema({ ...target, ...siblings }, {
    root: context.root,
    refStack: [...context.refStack, ref]
  });
}

function resolveLocalGeminiSchemaReference(root: unknown, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const segment of ref.slice(2).split('/')) {
    let key: string;
    try {
      key = decodeURIComponent(segment).replace(/~1/g, '/').replace(/~0/g, '~');
    } catch {
      return undefined;
    }
    if (Array.isArray(node)) node = node[Number(key)];
    else if (isRecord(node) && Object.prototype.hasOwnProperty.call(node, key)) node = node[key];
    else return undefined;
  }
  return node;
}

interface GeminiSchemaUnion {
  anyOf?: unknown[];
  merges: Record<string, unknown>[];
  nullable: boolean;
}

/**
 * `anyOf` is documented and kept when every branch is a standalone typed schema; `oneOf` is sent the
 * same way. A `null` branch becomes `nullable: true`, and a single remaining branch is folded into
 * the parent. `allOf` members are folded into the parent. Constraint-only branches (no type, e.g. the
 * `required`-only branches of an exactly-one-of) keep the previous behaviour: the first branch is
 * used when the union stands alone, otherwise the union is dropped.
 */
function sanitizeGeminiSchemaUnion(
  parent: Record<string, unknown>,
  key: string,
  branches: readonly unknown[],
  context: GeminiSchemaContext
): GeminiSchemaUnion {
  const sanitized = branches.map((branch) => sanitizeGeminiFunctionSchema(branch, context));
  if (key === 'allOf') {
    if (sanitized.length > 0 && sanitized.every(isRecord)) return { merges: sanitized, nullable: false };
  } else {
    const nonNull = sanitized.filter((branch) => !isGeminiNullSchema(branch));
    const nullable = nonNull.length < sanitized.length;
    if (nonNull.length > 0 && nonNull.every(isTypedGeminiSchema)) {
      return nonNull.length === 1
        ? { merges: [nonNull[0]], nullable }
        : { anyOf: nonNull, merges: [], nullable };
    }
  }
  const otherKeys = Object.keys(parent).filter((candidate) => candidate !== key && keepsGeminiSchemaKey(candidate));
  if (otherKeys.length === 0 && sanitized.length > 0 && isRecord(sanitized[0])) {
    return { merges: [sanitized[0]], nullable: false };
  }
  return { merges: [], nullable: false };
}

function keepsGeminiSchemaKey(key: string): boolean {
  return GEMINI_SCHEMA_VALUE_FIELDS.has(key)
    || GEMINI_SCHEMA_UNION_FIELDS.has(key)
    || key === 'properties'
    || key === 'items'
    || key === 'const'
    || key === '$ref';
}

function isGeminiNullSchema(value: unknown): boolean {
  return isRecord(value) && typeof value.type === 'string' && value.type.toLowerCase() === 'null';
}

function isTypedGeminiSchema(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (typeof value.type === 'string' || Array.isArray(value.anyOf));
}

function hasTypeSpecificGeminiFields(value: Record<string, unknown>): boolean {
  return ['properties', 'items', 'enum', 'const', 'required'].some((key) => value[key] !== undefined);
}

/** Folds a branch into its parent: the parent's own keywords win, properties and required are unioned. */
function mergeGeminiSchemaInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (key === 'properties' && isRecord(value)) {
      target.properties = { ...value, ...(isRecord(target.properties) ? target.properties : {}) };
    } else if (key === 'required' && Array.isArray(value)) {
      const required = Array.isArray(target.required) ? target.required : [];
      target.required = [...required, ...value.filter((name) => !required.includes(name))];
    } else if (!Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] = value;
    }
  }
}

function cloneGeminiSchemaValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneGeminiSchemaValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneGeminiSchemaValue(child)]));
}
