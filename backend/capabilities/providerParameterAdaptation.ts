/**
 * 不支持参数的自适配（进程内、按目标记忆）。
 *
 * 某次请求返回 400/422 且错误文本明确点名某个参数不被支持时，记住“对这个目标去掉或替换该参数”，
 * 并让调用方立即重试一次；之后同一目标（渠道配置 id + baseUrl + 模型）的请求在编码后直接适配。
 * 其他目标完全不受影响；网络错误、5xx 与语义不明确的 400 一律不匹配。
 *
 * 真实错误文本依据：
 * - 网关实测（openai-compatible → claude-sonnet-5）：
 *   `{"error":{"message":"Error: Current provider response failed: reasoning_effort: Extra inputs are not permitted","type":"invalid_request_error"}}`
 * - OpenAI：`Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.`
 *   （https://github.com/openai/openai-python/issues/2046），
 *   `Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported.`、
 *   `Unsupported parameter: 'temperature' is not supported with this model.`（https://github.com/jupyterlab/jupyter-ai/issues/994）。
 * - Azure OpenAI：`Unrecognized request argument supplied: stream_options`（https://github.com/openai/openai-python/issues/1469）、
 *   `Unrecognized request argument supplied: reasoning_effort`（https://github.com/marimo-team/marimo/issues/6368）。
 * - Anthropic：`temperature is deprecated for this model.`（https://github.com/BerriAI/litellm/pull/28113，
 *   https://platform.claude.com/docs/en/models/sonnet-5/whats-new-sonnet-5 “non-default values returns a 400 error”）、
 *   `` `temperature` may only be set to 1 when thinking is enabled`` （https://platform.claude.com/cookbook/extended-thinking-extended-thinking）。
 * - 严格 OpenAI 兼容服务的助手消息字段：
 *   vLLM/TRT-LLM `[{'type': 'extra_forbidden', 'loc': ('body', 'messages', 2, ..., 'reasoning_content'), 'msg': 'Extra inputs are not permitted'}]`
 *   （https://github.com/gsd-build/gsd-2/issues/4647），
 *   Mistral `{"detail":[{"type":"extra_forbidden","loc":["body","messages",2,"assistant","reasoning_content"],"msg":"Extra inputs are not permitted"}]}`
 *   （https://github.com/BerriAI/litellm/issues/30835，HTTP 422），
 *   Databricks `messages.0.reasoning_content: Extra inputs are not permitted`（https://github.com/plmbr/notebook-intelligence/pull/371），
 *   Cerebras `messages.2.assistant.reasoning_content: property 'messages.2.assistant.reasoning_content' is unsupported`
 *   （https://github.com/NousResearch/hermes-agent/issues/34716），
 *   Groq `'messages.4' : for 'role:assistant' the following must be satisfied[('messages.4' : property 'reasoning_content' is unsupported)]`
 *   （https://github.com/NousResearch/hermes-agent/issues/11089），
 *   OpenCode Zen `Extra inputs are not permitted, field: 'reasoning_content', value: []`（https://github.com/anomalyco/opencode/issues/11446）。
 */
import type { LlmProviderKind } from '../../shared/protocol';
import { isRecord, toPlainJsonLike } from './llmStreamEventProjection';

export interface ProviderRequestTarget {
  providerConfigId: string;
  provider: LlmProviderKind;
  baseUrl: string;
  model: string;
}

/** 编码并合并 requestBody 覆盖之后、真正发往线上的请求（dry-run 与 WebSocket 帧同样取自这里）。 */
export interface EncodedProviderRequest {
  body: unknown;
  /** Provider endpoint 头（不含传输层自动补的 Content-Type/User-Agent）。 */
  headers: Record<string, string>;
  /** 编码前的统一请求，只读。 */
  canonicalRequest?: unknown;
}

export type EncodedProviderRequestPostProcessor = (request: EncodedProviderRequest) => EncodedProviderRequest;

export type AdaptableRequestParameter =
  | 'reasoning_effort'
  | 'max_tokens'
  | 'temperature'
  | 'top_p'
  | 'top_k'
  | 'stream_options'
  | 'reasoning_content'
  | 'reasoning_signature'
  | 'reasoning_details';

const TOP_LEVEL_REMOVABLE_PARAMETERS = ['reasoning_effort', 'temperature', 'top_p', 'top_k', 'stream_options'] as const;
const ASSISTANT_MESSAGE_PARAMETERS = ['reasoning_content', 'reasoning_signature', 'reasoning_details'] as const;
const SAMPLING_PARAMETERS = new Set<AdaptableRequestParameter>(['temperature', 'top_p', 'top_k']);
const ADAPTABLE_PARAMETERS: readonly AdaptableRequestParameter[] = [
  ...TOP_LEVEL_REMOVABLE_PARAMETERS,
  'max_tokens',
  ...ASSISTANT_MESSAGE_PARAMETERS
];
const CHAT_COMPLETIONS_PROVIDERS = new Set<LlmProviderKind>(['openai-compatible', 'deepseek']);

interface TargetAdaptationState {
  parameters: Set<AdaptableRequestParameter>;
}

const adaptationStates = new Map<string, TargetAdaptationState>();

export function providerRequestTargetKey(target: ProviderRequestTarget): string {
  return [target.providerConfigId, target.baseUrl, target.model].join('\n');
}

/** 测试与开发诊断用：清空进程内记住的适配。生产路径不调用。 */
export function resetProviderRequestAdaptations(): void {
  adaptationStates.clear();
}

export function learnedProviderRequestAdaptations(target: ProviderRequestTarget): { parameters: AdaptableRequestParameter[] } {
  const state = adaptationStates.get(providerRequestTargetKey(target));
  return { parameters: state ? [...state.parameters].sort() : [] };
}

/**
 * 在 provider 的“编码 + requestBody 合并”之后挂一个后处理器。chat、chatStream、dryRun（含 WebSocket
 * 路径取帧用的 dryRun）都经过这一步，因此适配同时作用于真实请求与 dry-run 展示。
 */
export function installEncodedRequestPostProcessor<T>(provider: T, postProcess: EncodedProviderRequestPostProcessor): T {
  const runtime = provider as T & {
    buildProviderRequest?: (...args: unknown[]) => unknown;
    __limcodeEncodedRequestPostProcessor?: true;
  };
  if (!runtime || runtime.__limcodeEncodedRequestPostProcessor) return provider;
  const build = runtime.buildProviderRequest;
  if (typeof build !== 'function') return provider;
  runtime.buildProviderRequest = function buildAdaptedProviderRequest(this: unknown, ...args: unknown[]): unknown {
    const built = build.apply(this, args);
    if (!isRecord(built) || !isRecord(built.endpoint)) return built;
    const endpointHeaders = stringRecord(built.endpoint.headers);
    const result = postProcess({ body: built.body, headers: endpointHeaders, canonicalRequest: built.canonicalRequest });
    if (result.body === built.body && result.headers === endpointHeaders) return built;
    if (result.headers === endpointHeaders) return { ...built, body: result.body };
    const transportHeaders = Object.fromEntries(Object.entries(stringRecord(built.headers))
      .filter(([key]) => !Object.keys(endpointHeaders).some((candidate) => candidate.toLowerCase() === key.toLowerCase())));
    return {
      ...built,
      body: result.body,
      endpoint: { ...built.endpoint, headers: result.headers },
      headers: { ...transportHeaders, ...result.headers }
    };
  };
  runtime.__limcodeEncodedRequestPostProcessor = true;
  return provider;
}

/** 把该目标已记住的参数适配应用到编码后的请求体；没有记住任何适配时原样返回同一引用。 */
export function applyLearnedParameterAdaptations(
  request: EncodedProviderRequest,
  target: ProviderRequestTarget
): EncodedProviderRequest {
  const state = adaptationStates.get(providerRequestTargetKey(target));
  if (!state || state.parameters.size === 0) return request;
  const body = adaptRequestParameters(request.body, state.parameters, target.provider);
  return body === request.body ? request : { ...request, body };
}

export function adaptRequestParameters(
  body: unknown,
  parameters: ReadonlySet<AdaptableRequestParameter>,
  provider: LlmProviderKind
): unknown {
  if (!isRecord(body)) return body;
  let next = body;
  const writable = (): Record<string, unknown> => {
    if (next === body) next = { ...body };
    return next;
  };
  for (const parameter of TOP_LEVEL_REMOVABLE_PARAMETERS) {
    if (parameters.has(parameter) && Object.prototype.hasOwnProperty.call(next, parameter)) delete writable()[parameter];
  }
  // 只有 Chat Completions 形状才有 max_tokens → max_completion_tokens 的官方替换；Claude 的 max_tokens 是必填项。
  if (parameters.has('max_tokens') && CHAT_COMPLETIONS_PROVIDERS.has(provider)
    && Object.prototype.hasOwnProperty.call(next, 'max_tokens')) {
    const target = writable();
    if (target.max_completion_tokens === undefined) target.max_completion_tokens = target.max_tokens;
    delete target.max_tokens;
  }
  const messageFields = ASSISTANT_MESSAGE_PARAMETERS.filter((parameter) => parameters.has(parameter));
  if (messageFields.length > 0 && Array.isArray(next.messages)) {
    let changed = false;
    const messages = next.messages.map((message) => {
      if (!isRecord(message) || message.role !== 'assistant') return message;
      if (!messageFields.some((field) => Object.prototype.hasOwnProperty.call(message, field))) return message;
      changed = true;
      const copy = { ...message };
      for (const field of messageFields) delete copy[field];
      return copy;
    });
    if (changed) writable().messages = messages;
  }
  return next;
}

/**
 * 从明确的 400/422 错误中识别被点名的不支持参数，记入该目标的状态。返回本次错误对应、且当前已生效的
 * 适配标识；调用方按“每个请求每个标识只立即重试一次”去重，既覆盖并发请求，也不会死循环。
 */
export function learnProviderRequestAdaptations(target: ProviderRequestTarget, rawError: unknown): string[] {
  const status = providerErrorStatus(rawError);
  if (status !== 400 && status !== 422) return [];
  const text = providerErrorSearchText(rawError);
  if (!text) return [];
  const parameters = unsupportedRequestParameters(text)
    .filter((parameter) => parameter !== 'max_tokens' || CHAT_COMPLETIONS_PROVIDERS.has(target.provider));
  if (parameters.length === 0) return [];
  const key = providerRequestTargetKey(target);
  const state = adaptationStates.get(key) ?? { parameters: new Set<AdaptableRequestParameter>() };
  const learned = parameters.filter((parameter) => !state.parameters.has(parameter));
  for (const parameter of parameters) state.parameters.add(parameter);
  adaptationStates.set(key, state);
  if (learned.length > 0) {
    console.log('[LimCode][ProviderAdaptation]', JSON.stringify({
      providerConfigId: target.providerConfigId,
      provider: target.provider,
      model: target.model,
      status,
      adaptedParameters: learned
    }));
  }
  return parameters.map((parameter) => `parameter:${parameter}`);
}

export interface ProviderRequestAdaptationRetry {
  /** 本次失败可以通过（新的或并发请求刚学到的）适配修复时返回 true；每个适配每个请求最多触发一次。 */
  shouldRetryImmediately(rawError: unknown): boolean;
}

export function createProviderRequestAdaptationRetry(target: ProviderRequestTarget): ProviderRequestAdaptationRetry {
  const attempted = new Set<string>();
  return {
    shouldRetryImmediately(rawError) {
      const fresh = learnProviderRequestAdaptations(target, rawError).filter((id) => !attempted.has(id));
      for (const id of fresh) attempted.add(id);
      return fresh.length > 0;
    }
  };
}

/** 只认明确点名参数的错误文本；导出供单测覆盖正反例。 */
export function unsupportedRequestParameters(errorText: string): AdaptableRequestParameter[] {
  const text = normalizeErrorText(errorText);
  const extraInputs = /extra inputs are not permitted|extra_forbidden/i.test(text);
  return ADAPTABLE_PARAMETERS.filter((parameter) => {
    const name = escapeRegExp(parameter);
    if (parameter === 'max_tokens') {
      return new RegExp(`unsupported parameter:\\s*${Q}max_tokens${Q}`, 'i').test(text)
        && /max_completion_tokens/i.test(text);
    }
    if (new RegExp(`unsupported parameter:\\s*${Q}${name}${Q}`, 'i').test(text)) return true;
    if (new RegExp(`unknown parameter:\\s*${Q}(?:[^'"\`\\s]*[.\\]])?${name}${Q}`, 'i').test(text)) return true;
    if (new RegExp(`unrecognized request argument supplied:\\s*${name}(?![\\w])`, 'i').test(text)) return true;
    if (new RegExp(`property\\s*${Q}(?:[^'"\`\\s]*\\.)?${name}${Q}\\s*is unsupported`, 'i').test(text)) return true;
    if (extraInputs) {
      if (new RegExp(`(?<![\\w])${name}${Q}?\\s*:?\\s*extra inputs are not permitted`, 'i').test(text)) return true;
      if (new RegExp(`extra inputs are not permitted,\\s*field:\\s*${Q}(?:[^'"\`\\s]*[.\\]])?${name}${Q}`, 'i').test(text)) return true;
      if (new RegExp(`${Q}?loc${Q}?\\s*:\\s*[\\[(][^\\])]*${Q}${name}${Q}\\s*[\\])]`, 'i').test(text)) return true;
    }
    if (SAMPLING_PARAMETERS.has(parameter)) {
      if (new RegExp(`unsupported value:\\s*${Q}${name}${Q}\\s*does not support`, 'i').test(text)) return true;
      if (new RegExp(`(?<![\\w])${Q}?${name}${Q}?\\s+is deprecated for this model`, 'i').test(text)) return true;
      if (new RegExp(`${Q}${name}${Q}[^.\\n]{0,80}when thinking is enabled`, 'i').test(text)) return true;
    }
    return false;
  });
}

const Q = `['"\`]`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeErrorText(text: string): string {
  return text.replace(/\\"/g, '"').replace(/\\n/g, '\n');
}

export function providerErrorStatus(rawError: unknown): number | undefined {
  if (!isRecord(rawError)) return undefined;
  if (typeof rawError.status === 'number') return rawError.status;
  for (const key of ['error', 'cause', 'response', 'rawError']) {
    const nested = rawError[key];
    if (isRecord(nested) && typeof nested.status === 'number') return nested.status;
  }
  return undefined;
}

/** 错误中全部可读文本：结构化部分序列化（保留 loc 数组结构），字符串叶子原样保留；不含响应头与调用栈。 */
export function providerErrorSearchText(rawError: unknown): string {
  const plain = toPlainJsonLike(rawError);
  const strings: string[] = [];
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 8) return undefined;
    if (typeof value === 'string') {
      strings.push(value);
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    if (!isRecord(value)) return value;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'headers' || key === 'stack') continue;
      result[key] = visit(child, depth + 1);
    }
    return result;
  };
  const structured = visit(plain, 0);
  let serialized = '';
  try {
    serialized = JSON.stringify(structured) ?? '';
  } catch {
    serialized = '';
  }
  return normalizeErrorText([serialized, ...strings].join('\n'));
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
