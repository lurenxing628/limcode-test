/**
 * LimCode MessageContent/工具 schema → unified-llm-provider 统一请求内容的消息转换。
 * 包含 Gemini functionResponse 回合合并、openai-responses 模型消息分组、
 * thought signature 便携格式回填以及工具参数 schema 的 provider 兼容处理。
 */
import type { LlmStartRequest, ToolSchema } from '../world/modules/llm/contracts';
import {
  isFileDataPart,
  isFunctionCallPart,
  isFunctionResponsePart,
  isInlineDataPart,
  isProviderContextPart,
  isTextPart,
  isVisibleTextPart
} from '../../shared/protocol';
import type {
  ContentPart,
  FunctionCallPart,
  LlmGenerationConfigRecord,
  LlmProviderKind,
  MessageContent
} from '../../shared/protocol';
import {
  isRecord,
  nonEmptyRecord,
  normalizedSignatureString,
  parsePortableThoughtSignature,
  thoughtSignaturesFromPortableSignature
} from './llmStreamEventProjection';
import type { OpenAIResponsesNativeCapabilities } from '../../shared/openAIResponsesNative';

type UnifiedContent = import('unified-llm-provider').Content;
type UnifiedPart = import('unified-llm-provider').Part;
type UnifiedLLMRequest = import('unified-llm-provider').LLMRequest;
type UnifiedFunctionDeclaration = import('unified-llm-provider').FunctionDeclaration;

export function toUnifiedRequest(
  request: LlmStartRequest,
  generationConfig?: LlmGenerationConfigRecord,
  providerKind?: LlmProviderKind,
  nativeCapabilities?: OpenAIResponsesNativeCapabilities
): UnifiedLLMRequest {
  const nativeAsync = nativeCapabilities?.asyncTools === true;
  const contents = providerKind === 'gemini'
    ? mergeGeminiFunctionResponseTurns(request.contents)
    : providerKind === 'claude'
      ? projectClaudeThoughtReplay(request.contents)
      : request.contents;
  return {
    contents: contents.flatMap((content) => toUnifiedContents(content, providerKind, nativeAsync)),
    ...(request.systemInstruction ? { systemInstruction: { parts: request.systemInstruction.parts.map((part) => toUnifiedPart(part, false)) } } : {}),
    ...(request.tools.length === 0 ? {} : {
      tools: [{
        functionDeclarations: request.tools.map((tool) => toUnifiedFunctionDeclaration(tool, nativeAsync))
      }]
    }),
    ...(nonEmptyRecord(generationConfig) ? { generationConfig } : {})
  };
}

/**
 * Claude 把 thinking 块的 signature 定义成必填：它用签名验证这段思考确实由 Claude 生成。
 * 其它渠道产出的思考只带自己那一家的签名，回放时 Claude 适配器仍会写成 thinking 块，
 * 于是整条请求被 Anthropic 以 `thinking.signature: Field required` 拒绝。这些思考对 Claude
 * 也没有任何可用价值，所以在投影阶段就摘掉，只保留 Claude 自己签过的那些。
 */
function projectClaudeThoughtReplay(contents: readonly MessageContent[]): MessageContent[] {
  let dropped = 0;
  const projected = contents.map((content) => {
    const next = withoutForeignClaudeThoughts(content);
    dropped += content.parts.length - next.parts.length;
    return next;
  });
  // 丢弃本身是正确行为，但它替换掉的是一个原本会炸出来的 400，所以留一条只含数量的痕迹：
  // 万一有一天是 Claude 自己的签名在链路上被吞了，这个计数是唯一能看见的信号。
  if (dropped > 0) {
    try {
      console.info('[LimCode][ClaudeThoughtReplay]', JSON.stringify({ droppedForeignThoughtParts: dropped }));
    } catch {
      // 可观测性永远不是 provider 权威。
    }
  }
  return projected;
}

function withoutForeignClaudeThoughts(content: MessageContent): MessageContent {
  if (content.role !== 'model') return content;
  const parts = content.parts.filter((part) => !isForeignThoughtPart(part, 'claude'));
  return parts.length === content.parts.length ? content : { ...content, parts };
}

function isForeignThoughtPart(part: ContentPart, provider: string): boolean {
  if (!isTextPart(part) || part.thought !== true) return false;
  const signature = normalizedSignatureString(part.thoughtSignature);
  return parsePortableThoughtSignature(signature ?? '')?.provider !== provider;
}

/**
 * Gemini 要求：model 内容里有 N 个函数调用时，紧随其后的那一条 user 内容必须恰好带这 N 个函数响应，
 * 否则 400 "Please ensure that the number of function response parts is equal to the number of
 * function call parts of the function call turn"（网关实测 `[v]gemini-3.5-flash`）。官方顺序是
 * “所有调用之后跟所有响应”（FC1, FC2, FR1, FR2；https://ai.google.dev/gemini-api/docs/thought-signatures
 * FAQ：交错会 400）。规范上下文把每个工具结果冻结成独立片段，附件目录等文字还会排在它们中间，
 * 所以这里参照 Claude 的配对修复：把回答同一批调用、分散在多条 user 内容里的函数响应并进紧随其后的
 * 一条 user 内容，夹在中间的其他片段按原顺序放到这些响应之后。已经在一条内容里配齐的轮次保持原样。
 */
function mergeGeminiFunctionResponseTurns(contents: readonly MessageContent[]): MessageContent[] {
  return mergeAdjacentGeminiFunctionResponseTurns(pairGeminiFunctionResponses(contents));
}

function pairGeminiFunctionResponses(contents: readonly MessageContent[]): readonly MessageContent[] {
  const paired: MessageContent[] = [];
  let regrouped = false;
  for (let index = 0; index < contents.length; index += 1) {
    const content = contents[index];
    paired.push(content);
    const calls = content.role === 'model' ? content.parts.filter(isFunctionCallPart) : [];
    if (calls.length === 0) continue;
    const batch = collectGeminiFunctionResponses(contents, index + 1, calls);
    // 只有一条 user 内容时已经满足配对（或没有可配的响应），不动它。
    if (!batch || batch.endIndexExclusive <= index + 2) continue;
    paired.push({ ...contents[index + 1], role: 'user', parts: [...batch.responses, ...batch.trailing] });
    regrouped = true;
    index = batch.endIndexExclusive - 1;
  }
  return regrouped ? paired : contents;
}

interface GeminiFunctionResponseBatch {
  responses: ContentPart[];
  trailing: ContentPart[];
  endIndexExclusive: number;
}

/** 扫描回答一批调用的 user 内容：按调用 id 认领响应，没有 id 的调用按数量认领；遇到非 user 内容即停。 */
function collectGeminiFunctionResponses(
  contents: readonly MessageContent[],
  startIndex: number,
  calls: readonly FunctionCallPart[]
): GeminiFunctionResponseBatch | undefined {
  const callIds = new Set(calls.flatMap((call) => call.id ? [call.id] : []));
  const pendingIds = new Set(callIds);
  let pendingAnonymous = calls.length - callIds.size;
  const responses: ContentPart[] = [];
  const trailing: ContentPart[] = [];
  let index = startIndex;
  for (; index < contents.length && (pendingIds.size > 0 || pendingAnonymous > 0); index += 1) {
    const content = contents[index];
    if (content.role !== 'user') break;
    for (const part of content.parts) {
      if (isFunctionResponsePart(part)) {
        if (part.id && pendingIds.delete(part.id)) {
          responses.push(part);
          continue;
        }
        if (pendingAnonymous > 0 && !(part.id && callIds.has(part.id))) {
          pendingAnonymous -= 1;
          responses.push(part);
          continue;
        }
      }
      trailing.push(part);
    }
  }
  return responses.length > 0 ? { responses, trailing, endIndexExclusive: index } : undefined;
}

/** 原有行为：直接相邻、只含函数响应的 user 内容合并成一条。 */
function mergeAdjacentGeminiFunctionResponseTurns(contents: readonly MessageContent[]): MessageContent[] {
  const merged: MessageContent[] = [];
  for (let index = 0; index < contents.length; index += 1) {
    const content = contents[index];
    if (content.role !== 'user' || content.parts.length === 0 || !content.parts.every(isFunctionResponsePart)) {
      merged.push(content);
      continue;
    }
    const parts: ContentPart[] = [...content.parts];
    while (
      index + 1 < contents.length
      && contents[index + 1].role === 'user'
      && contents[index + 1].parts.length > 0
      && contents[index + 1].parts.every(isFunctionResponsePart)
    ) {
      parts.push(...contents[index + 1].parts);
      index += 1;
    }
    merged.push(parts.length === content.parts.length ? content : { ...content, parts });
  }
  return merged;
}

export function toUnifiedContents(
  content: MessageContent,
  providerKind?: LlmProviderKind,
  nativeAsync = false
): UnifiedContent[] {
  if (providerKind !== 'openai-responses' || content.role !== 'model'
    || (content as MessageContent & { providerContext?: unknown }).providerContext) {
    return [toUnifiedContent(content, nativeAsync)];
  }

  const groups: ContentPart[][] = [];
  for (const part of content.parts) {
    const current = groups[groups.length - 1];
    const currentIdentity = current?.[0]?.outputItem?.id;
    const nextIdentity = part.outputItem?.id;
    if (current && currentIdentity === nextIdentity) current.push(part);
    else groups.push([part]);
  }
  return groups.map((parts) => {
    const outputItem = parts[0]?.outputItem;
    if (outputItem && parts.every((part) => isVisibleTextPart(part))) {
      const rawItem = {
        type: 'message',
        role: 'assistant',
        ...(outputItem.phase ? { phase: outputItem.phase } : {}),
        content: parts.map((part) => ({
          type: 'output_text',
          text: isTextPart(part) ? part.text : ''
        }))
      };
      return {
        role: 'model',
        parts: [],
        providerContext: {
          provider: 'openai',
          format: 'openai-responses',
          endpoint: 'responses',
          itemType: 'message',
          rawItem
        }
      } as UnifiedContent;
    }
    return toUnifiedContent({ role: content.role, parts }, nativeAsync);
  });
}

function toUnifiedContent(content: MessageContent, nativeAsync = false): UnifiedContent {
  const providerContext = (content as MessageContent & { providerContext?: unknown }).providerContext;
  return {
    role: content.role === 'model' ? 'model' : 'user',
    parts: content.parts.map((part) => toUnifiedPart(part, nativeAsync)),
    ...(providerContext ? { providerContext } : {})
  } as UnifiedContent;
}

function toUnifiedPart(part: ContentPart, nativeAsync = false): UnifiedPart {
  if (isTextPart(part)) {
    const thoughtSignatures = thoughtSignaturesFromPortableSignature(part.thoughtSignature);
    return {
      text: part.text,
      ...(part.thought !== undefined ? { thought: part.thought } : {}),
      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      ...(thoughtSignatures ? { thoughtSignatures } : {}),
      ...(part.thoughtElapsedMs !== undefined ? { thoughtElapsedMs: part.thoughtElapsedMs } : {})
    };
  }
  if (isFunctionCallPart(part)) {
    const thoughtSignatures = thoughtSignaturesFromPortableSignature(part.thoughtSignature);
    return {
      functionCall: {
        name: part.functionCall.name,
        args: asRecord(part.functionCall.args),
        ...(part.id ? { callId: part.id } : {}),
        // 已声明/接收的原生异步标记：仅当前目标 capability.asyncTools 为真时编码上线。
        ...(nativeAsync && part.async === true ? { async: true } : {})
      },
      // Gemini 会校验带工具调用的 thoughtSignature；作为 part 同层级字段透传给 provider。
      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
      ...(thoughtSignatures ? { thoughtSignatures } : {})
    };
  }
  if (isFunctionResponsePart(part)) {
    const functionResponse: Record<string, unknown> = {
      name: part.functionResponse.name,
      response: asRecord(part.functionResponse.response),
      ...(part.id ? { callId: part.id } : {})
    };
    const inlineParts = (part.functionResponse.parts ?? [])
      .filter((inlinePart) => inlinePart.inlineData.data)
      .map((inlinePart) => ({
        inlineData: {
          mimeType: inlinePart.inlineData.mimeType,
          data: inlinePart.inlineData.data!,
          ...(inlinePart.inlineData.name ? { name: inlinePart.inlineData.name } : {})
        }
      }));
    if (inlineParts.length > 0) functionResponse.parts = inlineParts;
    return {
      functionResponse
    } as unknown as UnifiedPart;
  }
  if (isInlineDataPart(part)) return part.inlineData.data
    ? { inlineData: { mimeType: part.inlineData.mimeType, data: part.inlineData.data, ...(part.inlineData.name ? { name: part.inlineData.name } : {}) } }
    : { text: `[inlineData unavailable: ${part.inlineData.name ?? part.inlineData.attachmentId ?? part.inlineData.sourcePath ?? part.inlineData.mimeType}]` };
  if (isFileDataPart(part)) {
    // unified-llm-provider 当前统一 Part 没有 fileData；先作为文本占位保留语义。
    return { text: `[fileData:${part.fileData.mimeType ?? 'unknown'}:${part.fileData.uri}]` };
  }
  if (isProviderContextPart(part)) return { providerContext: part.providerContext } as unknown as UnifiedPart;
  return assertNever(part);
}

function toUnifiedFunctionDeclaration(tool: ToolSchema, nativeAsync = false): UnifiedFunctionDeclaration {
  const parameters = isFunctionParameters(tool.parameters)
    ? providerCompatibleFunctionParameters(tool.name, tool.parameters)
    : { type: 'object' as const, properties: {} };
  return {
    name: tool.name,
    description: tool.description,
    parameters,
    // Astra 原生异步声明：仅 per-tool nativeAsync 且当前 capability.asyncTools 时编码。
    ...(nativeAsync && tool.async === true ? { async: true } : {})
  } as UnifiedFunctionDeclaration;
}

function providerCompatibleFunctionParameters(
  toolName: string,
  parameters: UnifiedFunctionDeclaration['parameters']
): UnifiedFunctionDeclaration['parameters'] {
  if (toolName !== 'edit' || !isRecord(parameters)) return parameters;
  const parameterRecord = parameters as unknown as Record<string, unknown>;
  const { oneOf: _unsupportedUnion, ...compatible } = parameterRecord;
  return compatible as UnifiedFunctionDeclaration['parameters'];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return { value };
}

function isFunctionParameters(value: unknown): value is UnifiedFunctionDeclaration['parameters'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (value as { type?: unknown }).type === 'object';
}

function assertNever(value: never): never {
  throw new Error(`Unexpected content part: ${String(value)}`);
}
