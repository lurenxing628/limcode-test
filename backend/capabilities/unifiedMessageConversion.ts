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
import { layoutTurnReminderContents, type TurnReminderLayout } from './claudeTurnScopedReminders';

type UnifiedContent = import('unified-llm-provider').Content;
type UnifiedPart = import('unified-llm-provider').Part;
type UnifiedLLMRequest = import('unified-llm-provider').LLMRequest;
type UnifiedFunctionDeclaration = import('unified-llm-provider').FunctionDeclaration;

export function toUnifiedRequest(
  request: LlmStartRequest,
  generationConfig?: LlmGenerationConfigRecord,
  providerKind?: LlmProviderKind,
  nativeCapabilities?: OpenAIResponsesNativeCapabilities,
  turnReminderLayout: TurnReminderLayout = 'tail'
): UnifiedLLMRequest {
  const nativeAsync = nativeCapabilities?.asyncTools === true;
  // 轮内系统消息只发给 Claude；其他 provider 一律按原来的尾巴模式，历史提醒不会以任何形式发过去。
  const requestContents = layoutTurnReminderContents(
    request.contents,
    providerKind === 'claude' && turnReminderLayout === 'claude_turn_scoped' ? 'claude_turn_scoped' : 'tail'
  );
  const contents = providerKind === 'gemini'
    ? mergeGeminiFunctionResponseTurns(projectGeminiThoughtReplay(projectGeminiProviderContext(requestContents)))
    : providerKind === 'claude'
      ? projectClaudeThoughtReplay(requestContents)
      : providerKind === 'openai-compatible'
        ? projectOpenAICompatibleThoughtReplay(projectForeignProviderContext(requestContents, 'openai-compatible'))
        : requestContents;
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
 * 发给原生 Gemini 时摘掉别家格式的不透明 provider 项（例如 Responses 普通回复里的服务端 compaction 项、
 * Claude 的 compaction 块）：接入库的 Gemini 编码器会把 `providerContext` 原样抄进 parts，
 * Gemini 的 Part/Content 没有这个字段，整条请求会被拒。Gemini 自己格式的项保留（目前没有）。
 * 摘掉后为空的内容整条去掉，不发出空 parts。
 * Claude 的编码器本来就不发别家的项（只还原自己的 compaction 块），不在这里处理。
 */
function projectGeminiProviderContext(contents: readonly MessageContent[]): readonly MessageContent[] {
  return projectForeignProviderContext(contents, 'gemini');
}

/**
 * 摘掉不是 `format` 格式的 provider 项（part 与内容级的 `providerContext`），摘空的内容整条去掉。
 * - Gemini：见 projectGeminiProviderContext。
 * - OpenAI 兼容：编码器不发 provider 项，但一条只剩 provider 项的内容（例如 Responses 回复里只有推理项与
 *   服务端 compaction 项、思考摘要已被摘掉）会编码成 `{"role":"assistant","content":""}` 这样的空消息。
 */
function projectForeignProviderContext(contents: readonly MessageContent[], format: string): readonly MessageContent[] {
  let changed = false;
  const projected: MessageContent[] = [];
  for (const content of contents) {
    const contentContext = (content as MessageContent & { providerContext?: unknown }).providerContext;
    const foreignContentContext = contentContext !== undefined && !isProviderContextOfFormat(contentContext, format);
    const parts = content.parts.filter((part) => !isProviderContextPart(part) || isProviderContextOfFormat(part.providerContext, format));
    if (!foreignContentContext && parts.length === content.parts.length) {
      projected.push(content);
      continue;
    }
    changed = true;
    if (parts.length === 0) continue;
    const { providerContext: _foreign, ...rest } = content as MessageContent & { providerContext?: unknown };
    projected.push({ ...(foreignContentContext ? rest : content), parts });
  }
  return changed ? projected : contents;
}

function isProviderContextOfFormat(value: unknown, format: string): boolean {
  return isRecord(value) && value.format === format;
}

/**
 * 发给原生 Gemini 时摘掉别家 provider 签过的思考 part，与 Claude 路径的 projectClaudeThoughtReplay 同理：
 * 别家签名对 Gemini 无效（接入库本来就不会把它发出去），剩下的只是另一个模型的思考文字，
 * 却会以 `thought: true` 冒充 Gemini 自己的思考回放。
 * - Gemini 自己签过的思考原样保留：官方要求“把完整响应的所有 part 按原样回传”，签名留在收到它的 part 上
 *   （https://ai.google.dev/gemini-api/docs/generate-content/thinking、
 *   https://ai.google.dev/gemini-api/docs/thought-signatures）。
 * - 无签名的思考保留：Gemini 3 的思考摘要本身不带签名（签名在函数调用或最后一个 part 上），
 *   无法与别家无签名思考区分，按官方“完整回传”处理。
 * 摘掉后为空的 model 内容整条去掉，不发出空 parts。
 */
function projectGeminiThoughtReplay(contents: readonly MessageContent[]): readonly MessageContent[] {
  let dropped = 0;
  const projected: MessageContent[] = [];
  for (const content of contents) {
    if (content.role !== 'model') {
      projected.push(content);
      continue;
    }
    const parts = content.parts.filter((part) => !isOtherProviderSignedThought(part, 'gemini'));
    dropped += content.parts.length - parts.length;
    if (parts.length === content.parts.length) projected.push(content);
    else if (parts.length > 0) projected.push({ ...content, parts });
  }
  if (dropped === 0) return contents;
  try {
    console.info('[LimCode][GeminiThoughtReplay]', JSON.stringify({ droppedForeignThoughtParts: dropped }));
  } catch {
    // 可观测性永远不是 provider 权威。
  }
  return projected;
}

/**
 * OpenAI 兼容格式把历史思考写回 `reasoning_content`。中途换过模型时，Claude、Gemini、Responses
 * 产出的思考（带各自的签名）不是这个模型的推理过程，回传过去只会误导它，所以去掉；
 * 本渠道自己的思考（签名为 openai-compatible，或没有签名）照常回传。
 */
function projectOpenAICompatibleThoughtReplay(contents: readonly MessageContent[]): readonly MessageContent[] {
  let dropped = 0;
  const projected: MessageContent[] = [];
  for (const content of contents) {
    if (content.role !== 'model') {
      projected.push(content);
      continue;
    }
    const parts = content.parts.filter((part) => !isOtherProviderSignedThought(part, 'openai-compatible'));
    dropped += content.parts.length - parts.length;
    if (parts.length === content.parts.length) projected.push(content);
    else if (parts.length > 0) projected.push({ ...content, parts });
  }
  return dropped === 0 ? contents : projected;
}

function isOtherProviderSignedThought(part: ContentPart, provider: string): boolean {
  if (!isTextPart(part) || part.thought !== true) return false;
  const signature = normalizedSignatureString(part.thoughtSignature);
  const signedBy = signature ? parsePortableThoughtSignature(signature)?.provider : undefined;
  return signedBy !== undefined && signedBy !== provider;
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
  // 只有 layoutTurnReminderContents 在 Claude 轮内系统消息模式下才会写这个字段。
  const claudeSystemMessage = (content as MessageContent & { claudeSystemMessage?: unknown }).claudeSystemMessage;
  return {
    role: content.role === 'model' ? 'model' : 'user',
    parts: content.parts.map((part) => toUnifiedPart(part, nativeAsync)),
    ...(claudeSystemMessage ? { claudeSystemMessage } : {}),
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
