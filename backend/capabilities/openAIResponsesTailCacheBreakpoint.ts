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
 * 这里把同一个断点挪到易失尾巴之前最后一个可承载项的最后一块上（断点数不变，开发者指令断点不动）。
 * 可承载项与接入库一致：数组 content 的 message（最后一块是 input_text / input_image / input_file），
 * 以及数组 output 的 function_call_output。只用于无状态的完整重放（HTTP、WebSocket 回退的 HTTP、HTTP dry-run）；
 * WebSocket 续接链里尾巴随 previous_response_id 留在会话原位，由调用方决定不挪。
 */
import { supportsOpenAIExplicitPromptCache } from '../../shared/openAIResponsesCapabilities';
import { isRecord } from './llmStreamEventProjection';
import type { EncodedProviderRequest } from './providerParameterAdaptation';

/**
 * `volatileTailCount` 是内容末尾的易失条数（每条内容编码为一条 user message）。以下情况原样返回同一引用：
 * 不是 explicit 模式或模型不支持显式断点；尾巴条数不对或尾巴不全是数组 content 的 user message；
 * 尾巴上没有恰好一个断点；尾巴前面没有可承载项；尾巴前面最后一个可承载项已经带断点（例如只有开发者指令）。
 */
export function withOpenAIResponsesCacheBreakpointBeforeVolatileTail(
  request: EncodedProviderRequest,
  volatileTailCount: number
): EncodedProviderRequest {
  const body = request.body;
  if (!Number.isSafeInteger(volatileTailCount) || volatileTailCount <= 0) return request;
  if (!isRecord(body) || !Array.isArray(body.input)) return request;
  if (!isRecord(body.prompt_cache_options) || body.prompt_cache_options.mode !== 'explicit') return request;
  if (typeof body.model !== 'string' || !supportsOpenAIExplicitPromptCache(body.model)) return request;
  const input = body.input as unknown[];
  const tailStart = input.length - volatileTailCount;
  if (tailStart <= 0) return request;
  const tail = input.slice(tailStart);
  if (!tail.every(isUserMessageItem)) return request;

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
  if (breakpoints !== 1) return request;

  for (let index = tailStart - 1; index >= 0; index -= 1) {
    const item = input[index];
    const blocks = carrierBlocks(item);
    const last = blocks?.[blocks.length - 1];
    if (!blocks || !isCacheableBlock(last)) continue;
    if (hasBreakpoint(last)) return request;
    const markedBlocks = [...blocks.slice(0, -1), { ...last, prompt_cache_breakpoint: breakpoint }];
    const record = item as Record<string, unknown>;
    const next = [...input.slice(0, tailStart), ...strippedTail];
    next[index] = record.type === 'function_call_output'
      ? { ...record, output: markedBlocks }
      : { ...record, content: markedBlocks };
    return { ...request, body: { ...body, input: next } };
  }
  return request;
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
