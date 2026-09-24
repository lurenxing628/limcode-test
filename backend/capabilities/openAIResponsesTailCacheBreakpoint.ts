/**
 * OpenAI Responses 显式提示缓存（GPT-5.6 及之后，`prompt_cache_options.mode: "explicit"`）下的易失尾巴。
 *
 * 官方依据（https://developers.openai.com/api/docs/guides/prompt-caching）：
 * - 显式模式只在开发者放置的断点处写缓存；“Content after the last selected breakpoint is processed at the uncached
 *   input-token rate without a cache-write charge, so you can avoid writing changing content that is unlikely to be reused.”
 *   写入按 1.25 倍计价，读取 0.1 倍。
 * - 查找只走本次请求里的断点（“Explicit-only mode: The first 2 and latest 50 explicit breakpoints”，从最长前缀往短找）；
 *   断点前面的前缀必须原样出现在之后的请求里、且那里同样有断点，才能读到。
 *
 * 内核每次请求把本轮提醒（以及本 Turn 输入被压缩掉时重新注入的输入）作为易失尾巴放在内容最后，下一次请求就不在原位了。
 * 接入库（unified-llm-provider `markLastOpenAIResponsesBreakpointCarrier`）把消息断点放在最后一个可承载块上，
 * 正好落在易失尾巴上：每次都按写入价重写整段前缀，下一次请求的断点换了位置，永远读不到，只剩开发者指令命中。
 *
 * 这里把同一个断点挪到易失尾巴之前最后一个可承载项的最后一块上（写入点，开发者指令断点不动）。
 * 可承载项与接入库一致：数组 content 的 message（最后一块是 input_text / input_image / input_file），
 * 以及数组 output 的 function_call_output。只用于无状态的完整重放（HTTP、WebSocket 回退的 HTTP、HTTP dry-run）；
 * WebSocket 续接链里尾巴随 previous_response_id 留在会话原位，由调用方决定不挪。
 *
 * 写入点每个请求都可能换位置（新回合的新输入、数组形式的新工具结果），它的前缀此前没写过；只靠它，新回合第一次请求
 * 只能读到开发者指令，整段历史按写入价重写。所以再在写入点之前最后一条用户消息（上一回合的输入，或本回合的输入）上
 * 放一个读取断点：之前的请求把写入点放在那里时已经写过这段前缀。断点总数最多 3 个（开发者指令、读取点、写入点）。
 */
import { supportsOpenAIExplicitPromptCache } from '../../shared/openAIResponsesCapabilities';
import { isRecord } from './llmStreamEventProjection';
import type { EncodedProviderRequest } from './providerParameterAdaptation';

/**
 * `volatileTailCount` 是内容末尾的易失条数（每条内容编码为一条 user message）。
 *
 * 有易失尾巴时：尾巴条数不对或尾巴不全是数组 content 的 user message、尾巴上没有恰好一个断点、尾巴前面没有可承载项、
 * 尾巴前面最后一个可承载项已经带断点（例如只有开发者指令）时原样返回同一引用；否则把尾巴上的断点挪到尾巴之前
 * 最后一个可承载项上（写入点），再补读取断点。没有易失尾巴时接入库的断点就是写入点，只补读取断点。
 * 不是 explicit 模式或模型不支持显式断点时原样返回。
 */
export function withOpenAIResponsesCacheBreakpointBeforeVolatileTail(
  request: EncodedProviderRequest,
  volatileTailCount: number
): EncodedProviderRequest {
  const body = request.body;
  if (!Number.isSafeInteger(volatileTailCount) || volatileTailCount < 0) return request;
  if (!isRecord(body) || !Array.isArray(body.input)) return request;
  if (!isRecord(body.prompt_cache_options) || body.prompt_cache_options.mode !== 'explicit') return request;
  if (typeof body.model !== 'string' || !supportsOpenAIExplicitPromptCache(body.model)) return request;
  const input = body.input as unknown[];
  if (volatileTailCount === 0) {
    const target = lastMarkedCarrierIndex(input);
    const next = target === undefined ? undefined : withReadBreakpointBefore(input, target);
    return next ? { ...request, body: { ...body, input: next } } : request;
  }
  const moved = withBreakpointMovedBeforeTail(input, input.length - volatileTailCount);
  if (!moved) return request;
  return { ...request, body: { ...body, input: withReadBreakpointBefore(moved.input, moved.target) ?? moved.input } };
}

/** 尾巴上恰好一个断点挪到尾巴之前最后一个可承载项上；返回新 input 与写入点下标，做不到时返回 undefined。 */
function withBreakpointMovedBeforeTail(
  input: readonly unknown[],
  tailStart: number
): { input: unknown[]; target: number } | undefined {
  if (tailStart <= 0) return undefined;
  const tail = input.slice(tailStart);
  if (!tail.every(isUserMessageItem)) return undefined;

  let breakpoint: unknown;
  let breakpoints = 0;
  const strippedTail = tail.map((item) => {
    const record = item as Record<string, unknown>;
    const content = record.content as unknown[];
    if (!content.some(hasBreakpoint)) return item;
    return {
      ...record,
      content: content.map((block) => {
        if (!isRecord(block) || !hasBreakpoint(block)) return block;
        breakpoints += 1;
        breakpoint ??= block.prompt_cache_breakpoint;
        const { prompt_cache_breakpoint: _moved, ...rest } = block;
        return rest;
      })
    };
  });
  if (breakpoints !== 1) return undefined;

  for (let index = tailStart - 1; index >= 0; index -= 1) {
    const blocks = carrierBlocks(input[index]);
    const last = blocks?.[blocks.length - 1];
    if (!blocks || !isCacheableBlock(last)) continue;
    if (hasBreakpoint(last)) return undefined;
    const next = [...input.slice(0, tailStart), ...strippedTail];
    next[index] = withMarkedCarrier(input[index], breakpoint);
    return { input: next, target: index };
  }
  return undefined;
}

/**
 * 在写入点之前最后一条用户消息上补一个读取断点（标记形状照写入点的）。没有这样的用户消息、它已经带断点时
 * 返回 undefined。工具结果、assistant 输出与开发者指令不作为读取点。
 */
function withReadBreakpointBefore(input: readonly unknown[], target: number): unknown[] | undefined {
  const breakpoint = markerOf(input[target]);
  if (breakpoint === undefined) return undefined;
  for (let index = target - 1; index >= 0; index -= 1) {
    if (!isUserMessageItem(input[index])) continue;
    const blocks = carrierBlocks(input[index]);
    const last = blocks?.[blocks.length - 1];
    if (!blocks || !isCacheableBlock(last)) continue;
    if (hasBreakpoint(last)) return undefined;
    const next = [...input];
    next[index] = withMarkedCarrier(input[index], breakpoint);
    return next;
  }
  return undefined;
}

/** 最后一个带断点的可承载项（接入库放的消息断点）；只有开发者指令带断点时不算。 */
function lastMarkedCarrierIndex(input: readonly unknown[]): number | undefined {
  for (let index = input.length - 1; index >= 0; index -= 1) {
    if (markerOf(input[index]) === undefined) continue;
    return isRecord(input[index]) && (input[index] as Record<string, unknown>).role === 'developer' ? undefined : index;
  }
  return undefined;
}

function markerOf(item: unknown): unknown {
  const blocks = carrierBlocks(item);
  const last = blocks?.[blocks.length - 1];
  return isRecord(last) && hasBreakpoint(last) ? last.prompt_cache_breakpoint : undefined;
}

/** 可承载项的最后一块加上断点（新对象，不改动原项）。 */
function withMarkedCarrier(item: unknown, breakpoint: unknown): unknown {
  const record = item as Record<string, unknown>;
  const blocks = carrierBlocks(item) as unknown[];
  const last = blocks[blocks.length - 1] as Record<string, unknown>;
  const markedBlocks = [...blocks.slice(0, -1), { ...last, prompt_cache_breakpoint: breakpoint }];
  return record.type === 'function_call_output'
    ? { ...record, output: markedBlocks }
    : { ...record, content: markedBlocks };
}

/** 一条内容编码成的 user message：role 为 user，content 为数组。 */
function isUserMessageItem(item: unknown): boolean {
  return isRecord(item)
    && (item.type === undefined || item.type === 'message')
    && item.role === 'user'
    && Array.isArray(item.content);
}

/** 可承载 `prompt_cache_breakpoint` 的块数组（与接入库 getOpenAIResponsesBreakpointCarrierBlocks 一致）。 */
function carrierBlocks(item: unknown): unknown[] | undefined {
  if (!isRecord(item)) return undefined;
  const blocks = item.type === 'function_call_output'
    ? item.output
    : item.type === undefined || item.type === 'message'
      ? item.content
      : undefined;
  return Array.isArray(blocks) && blocks.length > 0 ? blocks : undefined;
}

function isCacheableBlock(block: unknown): block is Record<string, unknown> {
  return isRecord(block) && (block.type === 'input_text' || block.type === 'input_image' || block.type === 'input_file');
}

function hasBreakpoint(block: unknown): boolean {
  return isRecord(block) && 'prompt_cache_breakpoint' in block;
}
