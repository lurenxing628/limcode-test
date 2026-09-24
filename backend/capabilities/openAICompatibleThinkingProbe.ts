/**
 * “测试这个模型”：向 OpenAI 兼容渠道的一个模型发最多 9 次极短的请求，测出它用哪种思考参数写法、
 * 能否关闭思考、接受哪些 `reasoning_effort`，结果写成这个模型的能力证据（`source: 'verified_probe'`）。
 *
 * - 只在用户点按钮时运行（可能产生少量费用），从不自动触发。
 * - 请求体完全由这里决定：一句合成的 user 消息、`stream`、`max_tokens` 和这一步要试的思考参数；
 *   不带渠道的请求体和生成参数，不经过请求改写（installRequestAdaptation）和进程内记住的参数适配。
 * - 地址与请求头（含认证）取自接入库的 dryRun，经代理与终止校验的 fetch 自己发出。
 * - 每次请求读到第一段思考或正文增量就中止连接：接入库的 parseSSE 跳出循环不会取消响应体，这里自己 abort。
 *
 * 测试步骤：
 * 1. 基线：不带任何思考参数。
 * 2. 基线没有思考输出：依次用三种写法打开思考，第一个让模型开始思考的就是写法；再用同一写法关闭一次，得出能否关闭。
 * 3. 基线已经在思考：依次用三种写法关闭思考，第一个让思考消失的就是写法、且可以关闭；都关不掉时记为不能关闭，
 *    写法取没被拒绝的一种（优先自动识别的那一种）。
 * 4. 强度：用选定写法打开思考，逐个带上 low / medium / high / max，没被拒绝的记为接受。
 * 5. 始终没有看到思考输出：记为“未检测到思考”（`family: 'none'`、不带写法），发送时继续按自动识别。
 */
import type {
  LlmProviderConfigRecord,
  LlmProviderModelRecord,
  LlmThinkingLevel,
  OpenAICompatibleThinkingFormat
} from '../../shared/protocol';
import {
  resolveModelCapabilities,
  type ModelCapabilitySnapshot,
  type ModelReasoningCapability
} from '../../shared/modelCapabilities';
import { resolveOpenAICompatibleDialect } from '../../shared/openAICompatibleDialect';
import { OPENAI_COMPATIBLE_THINKING_PROBE_MAX_REQUESTS } from '../../shared/openAICompatibleThinkingProbe';
import { createProxyFetch } from './proxyFetch';
import { createTerminalValidatedFetch } from './terminalValidatedFetch';

type MaybeProvider<T> = T | undefined | ((arg: void) => T | undefined | Promise<T | undefined>);
type ProbeFormat = Exclude<OpenAICompatibleThinkingFormat, 'omit'>;
type ProbeOutcome =
  | { kind: 'thinking' }
  | { kind: 'answer' }
  /** 流正常结束但既没有思考也没有正文（例如输出上限被隐藏的推理用完）：按“没有看到思考”处理。 */
  | { kind: 'empty' }
  | { kind: 'rejected'; status: number; message: string };

export interface OpenAICompatibleThinkingProbeOptions {
  proxy?: MaybeProvider<string>;
  /** 与普通请求相同的全局请求头（例如 User-Agent）；渠道请求头在它之后合并。 */
  headers?: MaybeProvider<Record<string, string>>;
  /** 单次请求从发出到读到第一段增量的上限，默认 30 秒。 */
  requestTimeoutMs?: number;
  now?: () => Date;
}

export interface OpenAICompatibleProbedResult {
  format: ProbeFormat;
  canDisable: boolean;
  efforts: LlmThinkingLevel[];
}

const PROBE_PROMPT = 'Reply with OK.';
const PROBE_MAX_TOKENS = 64;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const PROBE_FORMATS: readonly ProbeFormat[] = ['deepseek', 'enable_thinking', 'reasoning_effort'];
const PROBE_EFFORTS: readonly LlmThinkingLevel[] = ['low', 'medium', 'high', 'max'];
const ERROR_BODY_LIMIT = 4096;
const STREAM_SCAN_LIMIT = 256 * 1024;

export async function probeOpenAICompatibleThinking(
  config: LlmProviderConfigRecord,
  options: OpenAICompatibleThinkingProbeOptions = {}
): Promise<LlmProviderModelRecord> {
  if (config.provider !== 'openai-compatible') throw new Error('只有 OpenAI 兼容渠道可以测试思考参数。');
  const modelId = config.model.trim();
  if (!modelId) throw new Error('没有选择要测试的模型。');
  const baseUrl = config.baseUrl.trim();
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('接口地址不是有效的网址。'); }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('接口地址不能包含账号密码、查询串或片段；请把认证信息放在渠道请求头里。');
  }

  const transport = await probeTransport(config, modelId, baseUrl, options);
  const session = new ProbeSession(transport, modelId, config.apiKey, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  const automatic = resolveOpenAICompatibleDialect(baseUrl, modelId).format;
  const result = await runProbe(session, automatic);

  const baseline = resolveModelCapabilities({
    provider: 'openai-compatible', baseUrl, modelId, providerConfigId: config.id, transport: 'http'
  });
  const capabilitySnapshot: ModelCapabilitySnapshot = {
    ...baseline,
    source: 'verified_probe',
    verifiedAt: (options.now?.() ?? new Date()).toISOString(),
    reasoning: probedReasoning(result)
  };
  return {
    id: modelId,
    name: config.models.find((model) => model.id === modelId)?.name ?? modelId,
    capabilitySnapshot
  };
}

/**
 * 自动识别是开关写法时先试它（少碰一次对方不认的参数）；OpenAI 写法始终最后试：
 * 同时认开关和强度的服务，按开关写法才能关闭思考。
 */
function formatOrder(automatic: OpenAICompatibleThinkingFormat): ProbeFormat[] {
  if (automatic === 'deepseek' || automatic === 'enable_thinking') {
    return [automatic, ...PROBE_FORMATS.filter((format) => format !== automatic)];
  }
  return [...PROBE_FORMATS];
}

async function runProbe(
  session: ProbeSession,
  automatic: OpenAICompatibleThinkingFormat
): Promise<OpenAICompatibleProbedResult | undefined> {
  const order = formatOrder(automatic);
  const baseline = await session.send({});
  if (baseline.kind === 'rejected') {
    throw new Error(`不带思考参数的请求也被拒绝（HTTP ${baseline.status}）：${baseline.message}`);
  }

  let format: ProbeFormat | undefined;
  let canDisable = false;
  const accepted = new Set<LlmThinkingLevel>();
  if (baseline.kind !== 'thinking') {
    for (const candidate of order) {
      if ((await session.send(enableParams(candidate))).kind === 'thinking') { format = candidate; break; }
    }
    if (!format) return undefined;
    // OpenAI 写法打开思考用的就是 reasoning_effort: high。
    if (format === 'reasoning_effort') accepted.add('high');
    canDisable = isQuiet(await session.send(disableParams(format)));
  } else {
    const notRejected: ProbeFormat[] = [];
    for (const candidate of order) {
      const outcome = await session.send(disableParams(candidate));
      if (isQuiet(outcome)) { format = candidate; canDisable = true; break; }
      if (outcome.kind !== 'rejected') notRejected.push(candidate);
    }
    format ??= notRejected.find((candidate) => candidate === automatic)
      ?? notRejected[0]
      ?? (PROBE_FORMATS.includes(automatic as ProbeFormat) ? automatic as ProbeFormat : 'reasoning_effort');
  }

  const efforts: LlmThinkingLevel[] = [];
  for (const level of PROBE_EFFORTS) {
    if (accepted.has(level) || (await session.send(effortParams(format, level))).kind !== 'rejected') efforts.push(level);
  }
  return { format, canDisable, efforts };
}

function isQuiet(outcome: ProbeOutcome): boolean {
  return outcome.kind === 'answer' || outcome.kind === 'empty';
}

function enableParams(format: ProbeFormat): Record<string, unknown> {
  switch (format) {
    case 'deepseek': return { thinking: { type: 'enabled' } };
    case 'enable_thinking': return { enable_thinking: true };
    case 'reasoning_effort': return { reasoning_effort: 'high' };
  }
}

function disableParams(format: ProbeFormat): Record<string, unknown> {
  switch (format) {
    case 'deepseek': return { thinking: { type: 'disabled' } };
    case 'enable_thinking': return { enable_thinking: false };
    case 'reasoning_effort': return { reasoning_effort: 'none' };
  }
}

function effortParams(format: ProbeFormat, level: LlmThinkingLevel): Record<string, unknown> {
  return format === 'reasoning_effort' ? { reasoning_effort: level } : { ...enableParams(format), reasoning_effort: level };
}

function probedReasoning(result: OpenAICompatibleProbedResult | undefined): ModelReasoningCapability {
  if (!result) {
    return {
      family: 'none', levels: [], supportsBudget: false, canDisable: false, alwaysOn: false,
      outputLimitIncludesThinking: true, requiresThoughtSignatures: false
    };
  }
  return {
    family: result.format === 'reasoning_effort' ? 'openai_effort' : 'deepseek_toggle',
    levels: result.efforts,
    supportsBudget: false,
    canDisable: result.canDisable,
    alwaysOn: !result.canDisable,
    outputLimitIncludesThinking: true,
    requiresThoughtSignatures: false,
    wireFormat: result.format
  };
}

interface ProbeTransport {
  url: string;
  headers: Record<string, string>;
  fetch: typeof fetch;
}

class ProbeSession {
  private count = 0;

  public constructor(
    private readonly transport: ProbeTransport,
    private readonly modelId: string,
    private readonly apiKey: string,
    private readonly timeoutMs: number
  ) {}

  public async send(thinking: Record<string, unknown>): Promise<ProbeOutcome> {
    if (this.count >= OPENAI_COMPATIBLE_THINKING_PROBE_MAX_REQUESTS) throw new Error('测试请求次数超过上限。');
    const attempt = ++this.count;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const body = {
      model: this.modelId,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
      stream: true,
      max_tokens: PROBE_MAX_TOKENS,
      ...thinking
    };
    const fail = (detail: string) => new Error(`第 ${attempt} 次请求${detail}`);
    try {
      let response: Response;
      try {
        response = await this.transport.fetch(this.transport.url, {
          method: 'POST', headers: this.transport.headers, body: JSON.stringify(body), signal: controller.signal
        });
      } catch (error) {
        throw fail(timedOut ? this.timeoutText() : `没有发出去或连接断开：${this.redact(errorText(error))}`);
      }
      if (!response.ok) {
        const message = this.redact(errorExcerpt(await boundedText(response, ERROR_BODY_LIMIT).catch(() => '')));
        // 400 / 422：对方不认这个参数或取值；其余（认证、限流、服务端错误）无法得出结论。
        if (response.status === 400 || response.status === 422) return { kind: 'rejected', status: response.status, message };
        throw fail(`失败（HTTP ${response.status}）${message ? `：${message}` : ''}`);
      }
      try {
        const outcome = await firstSignal(response);
        return outcome.kind === 'rejected' ? { ...outcome, message: this.redact(outcome.message) } : outcome;
      } catch (error) {
        throw fail(timedOut ? this.timeoutText() : `的回复读取失败：${this.redact(errorText(error))}`);
      }
    } finally {
      clearTimeout(timer);
      // 看到第一段增量后立即断开，不再等模型写完。
      controller.abort();
    }
  }

  private timeoutText(): string {
    return `在 ${Math.max(1, Math.round(this.timeoutMs / 1000))} 秒内没有收到回复`;
  }

  /** 报错可能回显请求头：去掉密钥与 Bearer 凭据。 */
  private redact(text: string): string {
    const key = this.apiKey.trim();
    const masked = key.length >= 4 ? text.split(key).join('***') : text;
    return masked.replace(/Bearer\s+[^\s"',;]+/gi, 'Bearer ***');
  }
}

/**
 * 读到第一段思考或正文增量就返回（调用方随即断开）。`delta.reasoning_content`（DeepSeek 等）与
 * `delta.reasoning`（OpenRouter）都算思考；服务端忽略 stream、直接回 JSON 时按 message 判断。
 */
async function firstSignal(response: Response): Promise<ProbeOutcome> {
  if (!response.body) return { kind: 'empty' };
  if (!/text\/event-stream/i.test(response.headers.get('content-type') ?? '')) {
    return classifyPayload(parseJson(await boundedText(response, STREAM_SCAN_LIMIT)), 'message') ?? { kind: 'empty' };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        received += value.byteLength;
        buffer += decoder.decode(value, { stream: true });
      }
      if (done) buffer += `${decoder.decode()}\n`;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return { kind: 'empty' };
        const outcome = classifyPayload(parseJson(data), 'delta');
        if (outcome) return outcome;
      }
      if (done || received > STREAM_SCAN_LIMIT) return { kind: 'empty' };
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function classifyPayload(value: unknown, key: 'delta' | 'message'): ProbeOutcome | undefined {
  if (!isRecord(value)) return undefined;
  // 有的网关在 200 的流里回错误对象。
  if (value.error !== undefined && value.error !== null) {
    return { kind: 'rejected', status: 200, message: errorExcerpt(JSON.stringify({ error: value.error })) };
  }
  for (const choice of Array.isArray(value.choices) ? value.choices : []) {
    const part = isRecord(choice) ? choice[key] : undefined;
    if (!isRecord(part)) continue;
    if (nonEmptyText(part.reasoning_content) || nonEmptyText(part.reasoning)) return { kind: 'thinking' };
    if (typeof part.content === 'string' && part.content.trim()) return { kind: 'answer' };
  }
  return undefined;
}

function nonEmptyText(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) text += decoder.decode(value, { stream: true });
      if (done || text.length >= limit) break;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return text.slice(0, limit);
}

function errorExcerpt(text: string): string {
  const parsed = parseJson(text);
  const error = isRecord(parsed) ? parsed.error : undefined;
  const message = isRecord(error) && typeof error.message === 'string' ? error.message
    : typeof error === 'string' ? error
      : isRecord(parsed) && typeof parsed.message === 'string' ? parsed.message
        : text;
  const compact = message.replace(/\s+/g, ' ').trim();
  return compact.length > 300 ? `${compact.slice(0, 300)}…` : compact;
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    // Node 的 fetch 把网络原因放在 cause 里（例如 ECONNREFUSED）。
    const cause = (error as { cause?: unknown }).cause;
    return `${error.message}${cause instanceof Error ? `（${cause.message}）` : ''}`;
  }
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

type UnifiedModule = typeof import('unified-llm-provider');

async function importUnifiedLlmProvider(): Promise<UnifiedModule> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<UnifiedModule>;
  return dynamicImport('unified-llm-provider');
}

async function resolveOption<T>(value: MaybeProvider<T>): Promise<T | undefined> {
  return typeof value === 'function' ? (value as () => T | undefined | Promise<T | undefined>)() : value;
}

/** 与普通请求相同的合并规则：后面的覆盖前面的，保留先出现的键名拼写。 */
function mergeHeaders(...records: Array<Record<string, string> | undefined>): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const record of records) {
    for (const [rawKey, rawValue] of Object.entries(record ?? {})) {
      const key = rawKey.trim();
      if (!key || typeof rawValue !== 'string') continue;
      const existing = Object.keys(result).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
      result[existing ?? key] = rawValue.trim();
    }
  }
  return Object.keys(result).length ? result : undefined;
}

/** 接入库 OpenAI 兼容格式给出的地址与请求头（含认证）；请求体不用它的，由测试自己决定。 */
async function probeTransport(
  config: LlmProviderConfigRecord,
  modelId: string,
  baseUrl: string,
  options: OpenAICompatibleThinkingProbeOptions
): Promise<ProbeTransport> {
  const unified = await importUnifiedLlmProvider();
  const registry = unified.createBootstrapExtensionRegistry();
  const proxy = (await resolveOption(options.proxy))?.trim() || undefined;
  const providerFetch = createTerminalValidatedFetch(proxy ? createProxyFetch(proxy) : fetch, 'openai-compatible');
  const headers = mergeHeaders(await resolveOption(options.headers), config.headers);
  const provider = unified.createLLMFromConfig({
    provider: 'openai-compatible',
    model: modelId,
    apiKey: config.apiKey.trim(),
    baseUrl,
    ...(headers ? { headers } : {}),
    fetch: providerFetch
  } as Parameters<UnifiedModule['createLLMFromConfig']>[0], registry.llmProviders) as unknown as {
    dryRun(request: unknown, options: { inputFormat: 'unified'; outputFormat: 'unified'; stream: boolean; curl?: { includeApiKey?: boolean } }): Promise<{ url: string; headers: Record<string, string> }>;
  };
  const dryRun = await provider.dryRun(
    { contents: [{ role: 'user', parts: [{ text: PROBE_PROMPT }] }] },
    { inputFormat: 'unified', outputFormat: 'unified', stream: true, curl: { includeApiKey: false } }
  );
  return { url: dryRun.url, headers: { ...dryRun.headers }, fetch: providerFetch };
}
