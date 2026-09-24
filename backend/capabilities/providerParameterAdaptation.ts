/**
 * 不支持参数的自适配（进程内、按目标记忆）。
 *
 * 某次请求返回 400/422 且错误文本明确点名某个参数不被支持时，记住“对这个目标去掉或替换该参数”，
 * 并让调用方立即重试一次；之后同一目标（渠道配置 id + baseUrl + 模型）的请求在编码后直接适配。
 * 其他目标完全不受影响；网络错误、5xx 与语义不明确的 400 一律不匹配。
 * Claude 保留思考的前缀失配（claudeThinkingAdaptation.ts）用同一套按目标记忆与立即重发。
 * Claude 轮内系统消息被网关明确拒绝时（claudeTurnScopedReminders.ts），同样按目标退回原来的尾巴模式并立即重发。
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
 *   OpenCode Zen `Extra inputs are not permitted, field: 'reasoning_content', value: []`（https://github.com/anomalyco/opencode/issues/11446），
 *   OpenCode Go `Extra inputs are not permitted, field: 'messages[2].reasoning'`（https://github.com/can1357/oh-my-pi/issues/1157）。
 *   助手消息上的 OpenRouter 风格 `reasoning` 与 Responses 顶层的 `reasoning` 对象同名，只认明确指向 messages[N] 的错误。
 * - 方言写上的思考开关（顶层 `thinking`、`enable_thinking`）：不认它们的网关按上面同样的形状报错
 *   （`Unrecognized request argument supplied: thinking`、`loc: ['body', 'thinking']`、`property 'thinking' is unsupported`）。
 *   只认顶层：Claude 思考块、消息上的同名字段与 `chat_template_kwargs.enable_thinking` 被拒时去掉顶层键修不好。
 * - 工具调用上的 Gemini 签名 `tool_calls[].extra_content`（https://ai.google.dev/gemini-api/docs/thought-signatures
 *   “OpenAI compatibility”）：从 Gemini 换到严格服务后，历史里的签名会原样带过去。按上面同一批严格服务的报错
 *   形状识别（extra_forbidden 的 loc、`property '…' is unsupported`、`Unknown parameter`），另认
 *   `Additional properties are not allowed ('extra_content' was unexpected)`（JSON Schema 校验）与
 *   serde 的 ``unknown field `extra_content` ``。这个字段只会出现在工具调用上，所以只要错误点名它就去掉全部工具调用上的它。
 */
import type { LlmProviderKind } from '../../shared/protocol';
import { isRecord, toPlainJsonLike } from './llmStreamEventProjection';
import {
  applyClaudeThinkingBinding,
  claudeThinkingBindingModeForError,
  type ClaudeThinkingBindingMode
} from './claudeThinkingAdaptation';
import { claudeTurnScopedRemindersRejected } from './claudeTurnScopedReminders';

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
  | 'thinking'
  | 'enable_thinking'
  | 'max_tokens'
  | 'temperature'
  | 'top_p'
  | 'top_k'
  | 'stream_options'
  | 'reasoning_content'
  | 'reasoning_signature'
  | 'reasoning_details'
  | 'reasoning'
  | 'extra_content';

const TOP_LEVEL_REMOVABLE_PARAMETERS = [
  'reasoning_effort', 'thinking', 'enable_thinking', 'temperature', 'top_p', 'top_k', 'stream_options'
] as const;
/**
 * 只认顶层的参数：Claude 思考块、助手消息上的同名字段、`chat_template_kwargs.enable_thinking` 等嵌套键被拒时，
 * 去掉顶层键修不好，不能匹配。
 */
const TOP_LEVEL_ONLY_PARAMETERS = new Set<AdaptableRequestParameter>(['thinking', 'enable_thinking']);
const ASSISTANT_MESSAGE_PARAMETERS = ['reasoning_content', 'reasoning_signature', 'reasoning_details', 'reasoning'] as const;
/** 与顶层参数同名的助手消息字段：只接受明确落在 messages[N] 上的错误。 */
const MESSAGE_SCOPED_ONLY_PARAMETERS = new Set<AdaptableRequestParameter>(['reasoning']);
const SAMPLING_PARAMETERS = new Set<AdaptableRequestParameter>(['temperature', 'top_p', 'top_k']);
/** 助手消息 `tool_calls[]` 上的字段。 */
const TOOL_CALL_PARAMETERS = ['extra_content'] as const;
const ADAPTABLE_PARAMETERS: readonly AdaptableRequestParameter[] = [
  ...TOP_LEVEL_REMOVABLE_PARAMETERS,
  'max_tokens',
  ...ASSISTANT_MESSAGE_PARAMETERS,
  ...TOOL_CALL_PARAMETERS
];
const CHAT_COMPLETIONS_PROVIDERS = new Set<LlmProviderKind>(['openai-compatible']);

interface TargetAdaptationState {
  parameters: Set<AdaptableRequestParameter>;
  /** Claude 保留思考的前缀失配处理；只会 drop_block → strip_thinking 单向推进，不会放回。 */
  claudeThinkingBinding?: ClaudeThinkingBindingMode;
  /** 网关明确拒绝了轮内系统消息：这个目标之后的请求退回原来的尾巴模式（进程内记住）。 */
  claudeTurnScopedReminders?: 'tail';
}

/** 本次请求的上下文：只有确实用了轮内系统消息的请求，才把相关 400 当成需要回退的信号。 */
export interface ProviderRequestAdaptationContext {
  claudeTurnScopedReminders?: boolean;
}

const adaptationStates = new Map<string, TargetAdaptationState>();

export function providerRequestTargetKey(target: ProviderRequestTarget): string {
  return [target.providerConfigId, target.baseUrl, target.model].join('\n');
}

/** 测试与开发诊断用：清空进程内记住的适配。生产路径不调用。 */
export function resetProviderRequestAdaptations(): void {
  adaptationStates.clear();
}

export function learnedProviderRequestAdaptations(target: ProviderRequestTarget): {
  parameters: AdaptableRequestParameter[];
  claudeThinkingBinding?: ClaudeThinkingBindingMode;
  claudeTurnScopedReminders?: 'tail';
} {
  const state = adaptationStates.get(providerRequestTargetKey(target));
  return {
    parameters: state ? [...state.parameters].sort() : [],
    ...(state?.claudeThinkingBinding ? { claudeThinkingBinding: state.claudeThinkingBinding } : {}),
    ...(state?.claudeTurnScopedReminders ? { claudeTurnScopedReminders: state.claudeTurnScopedReminders } : {})
  };
}

/** 这个目标已经因网关拒绝轮内系统消息而退回尾巴模式。 */
export function claudeTurnScopedRemindersFallenBack(target: ProviderRequestTarget): boolean {
  return adaptationStates.get(providerRequestTargetKey(target))?.claudeTurnScopedReminders === 'tail';
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

/** 把该目标已记住的适配应用到编码后的请求；没有记住任何适配时原样返回同一引用。 */
export function applyLearnedRequestAdaptations(
  request: EncodedProviderRequest,
  target: ProviderRequestTarget
): EncodedProviderRequest {
  const state = adaptationStates.get(providerRequestTargetKey(target));
  if (!state) return request;
  let next = request;
  if (state.parameters.size > 0) {
    const body = adaptRequestParameters(next.body, state.parameters, target.provider);
    if (body !== next.body) next = { ...next, body };
  }
  if (target.provider === 'claude' && state.claudeThinkingBinding) {
    next = applyClaudeThinkingBinding(next, state.claudeThinkingBinding);
  }
  return next;
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
  const toolCallFields = TOOL_CALL_PARAMETERS.filter((parameter) => parameters.has(parameter));
  if ((messageFields.length > 0 || toolCallFields.length > 0) && Array.isArray(next.messages)) {
    let changed = false;
    const messages = next.messages.map((message) => {
      if (!isRecord(message) || message.role !== 'assistant') return message;
      const toolCalls = toolCallFields.length > 0 ? withoutToolCallFields(message.tool_calls, toolCallFields) : message.tool_calls;
      if (toolCalls === message.tool_calls
        && !messageFields.some((field) => Object.prototype.hasOwnProperty.call(message, field))) return message;
      changed = true;
      const copy = { ...message };
      for (const field of messageFields) delete copy[field];
      if (toolCalls !== message.tool_calls) copy.tool_calls = toolCalls;
      return copy;
    });
    if (changed) writable().messages = messages;
  }
  return next;
}

/** 去掉工具调用上被记住的字段；没有任何调用带这些字段时返回同一引用。 */
function withoutToolCallFields(toolCalls: unknown, fields: readonly string[]): unknown {
  if (!Array.isArray(toolCalls)) return toolCalls;
  let changed = false;
  const next = toolCalls.map((toolCall) => {
    if (!isRecord(toolCall) || !fields.some((field) => Object.prototype.hasOwnProperty.call(toolCall, field))) return toolCall;
    changed = true;
    const copy = { ...toolCall };
    for (const field of fields) delete copy[field];
    return copy;
  });
  return changed ? next : toolCalls;
}

/**
 * 从明确的 400/422 错误中识别被点名的不支持参数，记入该目标的状态。返回本次错误对应、且当前已生效的
 * 适配标识；调用方按“每个请求每个标识只立即重试一次”去重，既覆盖并发请求，也不会死循环。
 */
export function learnProviderRequestAdaptations(
  target: ProviderRequestTarget,
  rawError: unknown,
  context: ProviderRequestAdaptationContext = {}
): string[] {
  const status = providerErrorStatus(rawError);
  if (status !== 400 && status !== 422) return [];
  const text = providerErrorSearchText(rawError);
  if (!text) return [];
  const key = providerRequestTargetKey(target);
  const state = adaptationStates.get(key) ?? { parameters: new Set<AdaptableRequestParameter>() };
  const parameters = unsupportedRequestParameters(text)
    .filter((parameter) => parameter !== 'max_tokens' || CHAT_COMPLETIONS_PROVIDERS.has(target.provider));
  const binding = target.provider === 'claude'
    ? claudeThinkingBindingModeForError(text, state.claudeThinkingBinding)
    : undefined;
  const turnScopedFallback = target.provider === 'claude' && context.claudeTurnScopedReminders === true
    && claudeTurnScopedRemindersRejected(text);
  if (parameters.length === 0 && !binding && !turnScopedFallback) return [];
  const learned = parameters.filter((parameter) => !state.parameters.has(parameter));
  for (const parameter of parameters) state.parameters.add(parameter);
  const learnedBinding = binding !== undefined && binding !== state.claudeThinkingBinding ? binding : undefined;
  if (binding) state.claudeThinkingBinding = binding;
  const learnedTurnScopedFallback = turnScopedFallback && state.claudeTurnScopedReminders !== 'tail';
  if (turnScopedFallback) state.claudeTurnScopedReminders = 'tail';
  adaptationStates.set(key, state);
  if (learned.length > 0 || learnedBinding || learnedTurnScopedFallback) {
    console.log('[LimCode][ProviderAdaptation]', JSON.stringify({
      providerConfigId: target.providerConfigId,
      provider: target.provider,
      model: target.model,
      status,
      ...(learned.length > 0 ? { adaptedParameters: learned } : {}),
      ...(learnedBinding ? { claudeThinkingBinding: learnedBinding } : {}),
      ...(learnedTurnScopedFallback ? { claudeTurnScopedReminders: 'tail' } : {})
    }));
  }
  return [
    ...parameters.map((parameter) => `parameter:${parameter}`),
    ...(binding ? [`claude-thinking-binding:${binding}`] : []),
    ...(turnScopedFallback ? ['claude-turn-scoped-reminders:tail'] : [])
  ];
}

export interface ProviderRequestAdaptationRetry {
  /** 本次失败可以通过（新的或并发请求刚学到的）适配修复时返回 true；每个适配每个请求最多触发一次。 */
  shouldRetryImmediately(rawError: unknown): boolean;
}

export function createProviderRequestAdaptationRetry(
  target: ProviderRequestTarget,
  context: ProviderRequestAdaptationContext = {}
): ProviderRequestAdaptationRetry {
  const attempted = new Set<string>();
  return {
    shouldRetryImmediately(rawError) {
      const fresh = learnProviderRequestAdaptations(target, rawError, context).filter((id) => !attempted.has(id));
      for (const id of fresh) attempted.add(id);
      return fresh.length > 0;
    }
  };
}

/** 只认明确点名参数的错误文本；导出供单测覆盖正反例。 */
export function unsupportedRequestParameters(errorText: string): AdaptableRequestParameter[] {
  const text = withoutEchoedInputs(normalizeErrorText(errorText));
  const extraInputs = /extra inputs are not permitted|extra_forbidden/i.test(text);
  return ADAPTABLE_PARAMETERS.filter((parameter) => {
    const name = escapeRegExp(parameter);
    if (MESSAGE_SCOPED_ONLY_PARAMETERS.has(parameter)) return messageFieldRejected(text, name, extraInputs);
    if (TOP_LEVEL_ONLY_PARAMETERS.has(parameter)) return topLevelFieldRejected(text, name, extraInputs);
    if (parameter === 'extra_content') return toolCallFieldRejected(text, name, extraInputs);
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

/** 错误明确点名顶层字段：不带任何路径前缀，loc 只有 body 一层。 */
function topLevelFieldRejected(text: string, name: string, extraInputs: boolean): boolean {
  if (new RegExp(`unsupported parameter:\\s*${Q}${name}${Q}`, 'i').test(text)) return true;
  if (new RegExp(`unknown parameter:\\s*${Q}${name}${Q}`, 'i').test(text)) return true;
  if (new RegExp(`unrecognized request argument supplied:\\s*${name}(?![\\w])`, 'i').test(text)) return true;
  // Groq 的消息级写法 `'messages.4' : property 'x' is unsupported` 指向消息上的字段。
  if (new RegExp(`(?<!messages[.\\[]\\d+\\]?${Q}\\s*:\\s*)property\\s*${Q}${name}${Q}\\s*is unsupported`, 'i').test(text)) return true;
  if (!extraInputs) return false;
  if (new RegExp(`(?<![\\w.\\[\\]])${name}${Q}?\\s*:?\\s*extra inputs are not permitted`, 'i').test(text)) return true;
  if (new RegExp(`extra inputs are not permitted,\\s*field:\\s*${Q}${name}${Q}`, 'i').test(text)) return true;
  return new RegExp(`${Q}?loc${Q}?\\s*:\\s*[\\[(]\\s*(?:${Q}body${Q}\\s*,\\s*)?${Q}${name}${Q}\\s*[\\])]`, 'i').test(text);
}

/** 错误明确指向 messages[N]（可带 assistant 角色层级）上的某个字段。 */
function messageFieldRejected(text: string, name: string, extraInputs: boolean): boolean {
  const path = `messages(?:\\.|\\[)\\d+\\]?(?:\\.assistant)?\\.${name}(?![\\w])`;
  if (new RegExp(`unknown parameter:\\s*${Q}${path}${Q}`, 'i').test(text)) return true;
  if (new RegExp(`property\\s*${Q}${path}${Q}\\s*is unsupported`, 'i').test(text)) return true;
  if (new RegExp(`${Q}messages\\.\\d+${Q}\\s*:\\s*property\\s*${Q}${name}${Q}\\s*is unsupported`, 'i').test(text)) return true;
  if (!extraInputs) return false;
  if (new RegExp(`${path}${Q}?\\s*:?\\s*extra inputs are not permitted`, 'i').test(text)) return true;
  if (new RegExp(`extra inputs are not permitted,\\s*field:\\s*${Q}${path}${Q}`, 'i').test(text)) return true;
  return new RegExp(`${Q}?loc${Q}?\\s*:\\s*[\\[(][^\\])]*${Q}messages${Q}\\s*,\\s*\\d+\\s*,\\s*(?:(?:${Q}assistant${Q}|\\.\\.\\.)\\s*,\\s*)?${Q}${name}${Q}\\s*[\\])]`, 'i').test(text);
}

/** 错误明确点名工具调用上的字段（该字段名只会出现在 `messages[N].tool_calls[M]` 上）。 */
function toolCallFieldRejected(text: string, name: string, extraInputs: boolean): boolean {
  const path = `(?:[^'"\`\\s]*[.\\]])?${name}(?![\\w])`;
  if (new RegExp(`unknown parameter:\\s*${Q}${path}${Q}`, 'i').test(text)) return true;
  if (new RegExp(`property\\s*${Q}${path}${Q}\\s*is unsupported`, 'i').test(text)) return true;
  if (new RegExp(`additional properties are not allowed \\(${Q}${name}${Q} was unexpected\\)`, 'i').test(text)) return true;
  if (new RegExp(`unknown field\\s*${Q}${name}${Q}`, 'i').test(text)) return true;
  if (!extraInputs) return false;
  if (new RegExp(`${path}${Q}?\\s*:?\\s*extra inputs are not permitted`, 'i').test(text)) return true;
  if (new RegExp(`extra inputs are not permitted,\\s*field:\\s*${Q}${path}${Q}`, 'i').test(text)) return true;
  return new RegExp(`${Q}?loc${Q}?\\s*:\\s*[\\[(][^\\])]*${Q}${name}${Q}\\s*[\\])]`, 'i').test(text);
}

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

/**
 * 错误中全部可读文本：结构化部分序列化（保留 loc 数组结构），字符串叶子原样保留；不含响应头与调用栈。
 * pydantic 风格的错误把被拒字段的值原样回显在 `input` 里（常常就是用户消息），这里一律去掉：结构化的 `input` 键不看，
 * 字符串里（原始响应体、`HTTP 400: {...}` 这类消息、Python repr）的 `'input': …` 也跳过，只按 msg / message / loc 判断。
 */
export function providerErrorSearchText(rawError: unknown): string {
  const plain = toPlainJsonLike(rawError);
  const strings: string[] = [];
  const visit = (value: unknown, depth: number): unknown => {
    if (depth > 8) return undefined;
    if (typeof value === 'string') {
      const cleaned = withoutEchoedInputs(normalizeErrorText(value));
      strings.push(cleaned);
      return cleaned;
    }
    if (Array.isArray(value)) return value.map((item) => visit(item, depth + 1));
    if (!isRecord(value)) return value;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'headers' || key === 'stack' || key === 'input') continue;
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

/** 去掉文本里 `"input": …` / `'input': …` 形式的回显值（JSON 或 Python repr，值可以嵌套）。 */
function withoutEchoedInputs(text: string): string {
  const pattern = /,?\s*(['"])input\1\s*:\s*/g;
  let result = '';
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const valueEnd = echoedValueEnd(text, match.index + match[0].length);
    result += text.slice(cursor, match.index);
    cursor = valueEnd;
    pattern.lastIndex = Math.max(valueEnd, match.index + 1);
  }
  return cursor === 0 ? text : result + text.slice(cursor);
}

/** 从值的开头扫到它结束的位置：成对的括号与引号内部整体跳过，遇到同层的逗号或外层的右括号为止。 */
function echoedValueEnd(text: string, start: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) {
        quote = undefined;
        if (depth === 0) return index + 1;
      }
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '{' || char === '[' || char === '(') depth += 1;
    else if (char === '}' || char === ']' || char === ')') {
      if (depth === 0) return index;
      depth -= 1;
      if (depth === 0) return index + 1;
    } else if ((char === ',' || char === '\n') && depth === 0) return index;
  }
  return text.length;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
