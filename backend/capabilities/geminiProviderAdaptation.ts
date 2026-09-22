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
import { isRecord, normalizedSignatureString } from './llmStreamEventProjection';

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
  const geminiOpenAICompatible = providerKind === 'openai-compatible'
    && /^gemini-(?:\d|pro(?:-|$)|flash(?:-|$))/i.test(
      modelId.slice(modelId.lastIndexOf('/') + 1).trim().replace(/^\[[^\]]+\][\s_-]*/, '')
    );
  if (providerKind !== 'gemini' && providerKind !== 'openai-responses' && providerKind !== 'claude' && !geminiOpenAICompatible) return provider;
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

const GEMINI_THOUGHT_SIGNATURE_SKIP_VALIDATOR = 'skip_thought_signature_validator';

export function installGeminiOpenAICompatibleThoughtSignatures<T>(
  provider: T,
  providerKind: LlmProviderKind,
  modelId: string
): T {
  if (
    providerKind !== 'openai-compatible'
    || geminiThinkingCapabilityForModel(modelId).kind !== 'thinkingLevel'
  ) return provider;
  const runtimeProvider = provider as T & {
    format?: {
      encodeRequest?: (request: unknown, stream: boolean) => unknown;
      decodeResponse?: (raw: unknown) => unknown;
      decodeStreamChunk?: (raw: unknown, state: unknown) => unknown;
      __limcodeGeminiOpenAIThoughtSignatures?: true;
    };
  };
  const format = runtimeProvider.format;
  if (!format || format.__limcodeGeminiOpenAIThoughtSignatures) return provider;

  if (typeof format.encodeRequest === 'function') {
    const encodeRequest = format.encodeRequest.bind(format);
    format.encodeRequest = (request, stream) => {
      const encoded = encodeRequest(request, stream);
      attachGeminiOpenAIThoughtSignaturesToRequest(encoded, request);
      return encoded;
    };
  }
  if (typeof format.decodeResponse === 'function') {
    const decodeResponse = format.decodeResponse.bind(format);
    format.decodeResponse = (raw) => {
      const signatures = readGeminiOpenAIToolCallSignatures(raw, false);
      const decoded = decodeResponse(raw);
      attachGeminiSignaturesToUnifiedCalls(decoded, signatures);
      return decoded;
    };
  }
  if (typeof format.decodeStreamChunk === 'function') {
    const decodeStreamChunk = format.decodeStreamChunk.bind(format);
    const streamSignatures = new WeakMap<object, GeminiOpenAIToolCallSignatures>();
    format.decodeStreamChunk = (raw, state) => {
      const stateKey = isRecord(state) ? state : format;
      const signatures = streamSignatures.get(stateKey) ?? emptyGeminiOpenAIToolCallSignatures();
      mergeGeminiOpenAIToolCallSignatures(signatures, readGeminiOpenAIToolCallSignatures(raw, true));
      streamSignatures.set(stateKey, signatures);
      const decoded = decodeStreamChunk(raw, state);
      attachGeminiSignaturesToUnifiedCalls(decoded, signatures);
      return decoded;
    };
  }
  format.__limcodeGeminiOpenAIThoughtSignatures = true;
  return provider;
}

interface GeminiOpenAIToolCallSignatures {
  byId: Map<string, string>;
  byIndex: Map<number, string>;
}

function attachGeminiOpenAIThoughtSignaturesToRequest(encoded: unknown, source: unknown): void {
  if (!isRecord(encoded) || !isRecord(source)) return;
  const messages = Array.isArray(encoded.messages) ? encoded.messages.filter(isRecord) : [];
  const encodedCallGroups = messages.flatMap((message) =>
    message.role === 'assistant' && Array.isArray(message.tool_calls)
      ? [message.tool_calls.filter(isRecord)]
      : []);
  const sourceContents = Array.isArray(source.contents) ? source.contents.filter(isRecord) : [];
  const sourceCallGroups = sourceContents.flatMap((content) => {
    if (content.role !== 'model' || !Array.isArray(content.parts)) return [];
    const calls = content.parts.filter((part) => isRecord(part) && isRecord(part.functionCall));
    return calls.length > 0 ? [calls] : [];
  });

  for (let groupIndex = 0; groupIndex < Math.min(encodedCallGroups.length, sourceCallGroups.length); groupIndex += 1) {
    const encodedCalls = encodedCallGroups[groupIndex];
    const sourceCalls = sourceCallGroups[groupIndex];
    const sourceSignatures = sourceCalls.map(geminiSignatureFromUnifiedPart);
    const transferredGroup = sourceSignatures.every((signature) => !signature);
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

function readGeminiOpenAIToolCallSignatures(raw: unknown, stream: boolean): GeminiOpenAIToolCallSignatures {
  const signatures = emptyGeminiOpenAIToolCallSignatures();
  if (!isRecord(raw) || !Array.isArray(raw.choices)) return signatures;
  const choice = raw.choices.find(isRecord);
  if (!choice) return signatures;
  const rawMessage = choice[stream ? 'delta' : 'message'];
  if (!isRecord(rawMessage) || !Array.isArray(rawMessage.tool_calls)) return signatures;
  rawMessage.tool_calls
    .filter((toolCall): toolCall is Record<string, unknown> => isRecord(toolCall))
    .forEach((toolCall, ordinal) => {
      const signature = geminiOpenAIToolCallSignature(toolCall);
      if (!signature) return;
      const callId = normalizedSignatureString(toolCall.id);
      const index = typeof toolCall.index === 'number' && Number.isSafeInteger(toolCall.index)
        ? toolCall.index
        : ordinal;
      if (callId) signatures.byId.set(callId, signature);
      signatures.byIndex.set(index, signature);
    });
  return signatures;
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
  const seen = new Set<object>();
  let ordinal = 0;
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.functionCall) || seen.has(candidate)) continue;
    seen.add(candidate);
    const callId = normalizedSignatureString(candidate.functionCall.callId);
    const signature = (callId ? signatures.byId.get(callId) : undefined) ?? signatures.byIndex.get(ordinal);
    ordinal += 1;
    if (!signature) continue;
    const existing = isRecord(candidate.thoughtSignatures) ? candidate.thoughtSignatures : {};
    candidate.thoughtSignatures = { ...existing, gemini: signature };
  }
}

function geminiSignatureFromUnifiedPart(part: Record<string, unknown>): string | undefined {
  const signatures = isRecord(part.thoughtSignatures) ? part.thoughtSignatures : undefined;
  const mapped = normalizedSignatureString(signatures?.gemini);
  if (mapped) return mapped;
  const portable = normalizedSignatureString(part.thoughtSignature);
  if (!portable) return undefined;
  return portable.startsWith('gemini:') ? portable.slice('gemini:'.length) : portable;
}

function emptyGeminiOpenAIToolCallSignatures(): GeminiOpenAIToolCallSignatures {
  return { byId: new Map(), byIndex: new Map() };
}

function mergeGeminiOpenAIToolCallSignatures(
  target: GeminiOpenAIToolCallSignatures,
  source: GeminiOpenAIToolCallSignatures
): void {
  for (const [id, signature] of source.byId) target.byId.set(id, signature);
  for (const [index, signature] of source.byIndex) target.byIndex.set(index, signature);
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
    declaration.parameters = sanitizeGeminiFunctionSchema(source.parameters);
  }
}

const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  'title',
  'default',
  'const',
  '$defs',
  'definitions',
  '$schema',
  'not',
  'if',
  'then',
  'else',
  'prefixItems',
  'additionalProperties',
  'propertyNames',
  'multipleOf',
  'exclusiveMinimum',
  'exclusiveMaximum'
]);

function sanitizeGeminiFunctionSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeGeminiFunctionSchema);
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  let stringifiedEnum = false;
  for (const [key, child] of Object.entries(value)) {
    if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties' && isRecord(child)) {
      result.properties = Object.fromEntries(
        Object.entries(child).map(([propertyName, propertySchema]) => [
          propertyName,
          sanitizeGeminiFunctionSchema(propertySchema)
        ])
      );
      continue;
    }
    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(child)) {
      const otherKeys = Object.keys(value).filter((candidate) =>
        candidate !== key && !GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(candidate)
      );
      if (otherKeys.length === 0 && child.length > 0) {
        const first = sanitizeGeminiFunctionSchema(child[0]);
        if (isRecord(first)) Object.assign(result, first);
      }
      continue;
    }
    if (key === 'enum' && Array.isArray(child)) {
      result.enum = child.map((item) => String(item));
      stringifiedEnum = true;
      continue;
    }
    result[key] = sanitizeGeminiFunctionSchema(child);
  }

  if (stringifiedEnum && (result.type === 'integer' || result.type === 'number')) result.type = 'string';
  if (Array.isArray(result.required) && isRecord(result.properties)) {
    const required = result.required.filter((propertyName): propertyName is string =>
      typeof propertyName === 'string' && Object.prototype.hasOwnProperty.call(result.properties, propertyName)
    );
    if (required.length > 0) result.required = required;
    else delete result.required;
  }
  return result;
}
