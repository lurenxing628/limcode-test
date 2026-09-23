import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  createLlmProviderCapability,
  dryRunLlmProvider,
  startLlmProvider
} from '../../dist/extension/backend/capabilities/llmProvider.js';
import {
  adaptRequestParameters,
  learnProviderRequestAdaptations,
  learnedProviderRequestAdaptations,
  resetProviderRequestAdaptations,
  unsupportedRequestParameters
} from '../../dist/extension/backend/capabilities/providerParameterAdaptation.js';

// 真实错误文本：网关实测 + 官方/公开 issue（出处见 providerParameterAdaptation.ts 头注释）。
const GATEWAY_REASONING_EFFORT = '{"error":{"message":"Error: Current provider response failed: reasoning_effort: Extra inputs are not permitted","type":"invalid_request_error"}}';
const OPENAI_MAX_TOKENS = { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", type: 'invalid_request_error', param: 'max_tokens', code: 'unsupported_parameter' } };
const OPENAI_TEMPERATURE_VALUE = { error: { message: "Unsupported value: 'temperature' does not support 0.7 with this model. Only the default (1) value is supported.", type: 'invalid_request_error', param: 'temperature', code: 'unsupported_value' } };
const OPENAI_TEMPERATURE_PARAMETER = { error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", type: 'invalid_request_error', param: 'temperature', code: 'unsupported_parameter' } };
const OPENAI_TOP_P_PARAMETER = { error: { message: "Unsupported parameter: 'top_p' is not supported with this model.", type: 'invalid_request_error', param: 'top_p', code: 'unsupported_parameter' } };
const AZURE_STREAM_OPTIONS = { error: { code: null, message: 'Unrecognized request argument supplied: stream_options', param: null, type: 'invalid_request_error' } };
const AZURE_REASONING_EFFORT = { error: { message: 'Unrecognized request argument supplied: reasoning_effort', type: 'invalid_request_error', param: null, code: null } };
const ANTHROPIC_TEMPERATURE_DEPRECATED = { type: 'error', error: { type: 'invalid_request_error', message: 'temperature is deprecated for this model.' } };
const ANTHROPIC_TEMPERATURE_THINKING = { type: 'error', error: { type: 'invalid_request_error', message: '`temperature` may only be set to 1 when thinking is enabled. Please consult our documentation at https://docs.claude.com/en/docs/build-with-claude/extended-thinking#important-considerations-when-using-extended-thinking' } };
const TRT_REASONING_CONTENT = "[{'type': 'extra_forbidden', 'loc': ('body', 'messages', 2, 'assistant', 'reasoning_content'), 'msg': 'Extra inputs are not permitted', 'input': 'thinking about temperature'}]";
const MISTRAL_REASONING_CONTENT = { detail: [{ type: 'extra_forbidden', loc: ['body', 'messages', 2, 'assistant', 'reasoning_content'], msg: 'Extra inputs are not permitted', input: '...' }] };
const DATABRICKS_REASONING_CONTENT = { message: 'messages.0.reasoning_content: Extra inputs are not permitted' };
const CEREBRAS_REASONING_CONTENT = { message: "messages.2.assistant.reasoning_content: property 'messages.2.assistant.reasoning_content' is unsupported", type: 'invalid_request_error', param: 'validation_error', code: 'wrong_api_format' };
const GROQ_REASONING_CONTENT = { error: { message: "'messages.4' : for 'role:assistant' the following must be satisfied[('messages.4' : property 'reasoning_content' is unsupported)]", type: 'invalid_request_error' } };
const ZEN_REASONING_CONTENT = "Extra inputs are not permitted, field: 'reasoning_content', value: []";

const text = (value) => typeof value === 'string' ? value : JSON.stringify(value);

test('C1 匹配器：真实 400 文本逐条识别被点名的参数', () => {
  const cases = [
    [GATEWAY_REASONING_EFFORT, ['reasoning_effort']],
    [OPENAI_MAX_TOKENS, ['max_tokens']],
    [OPENAI_TEMPERATURE_VALUE, ['temperature']],
    [OPENAI_TEMPERATURE_PARAMETER, ['temperature']],
    [OPENAI_TOP_P_PARAMETER, ['top_p']],
    [AZURE_STREAM_OPTIONS, ['stream_options']],
    [AZURE_REASONING_EFFORT, ['reasoning_effort']],
    [ANTHROPIC_TEMPERATURE_DEPRECATED, ['temperature']],
    [ANTHROPIC_TEMPERATURE_THINKING, ['temperature']],
    [TRT_REASONING_CONTENT, ['reasoning_content']],
    [MISTRAL_REASONING_CONTENT, ['reasoning_content']],
    [DATABRICKS_REASONING_CONTENT, ['reasoning_content']],
    [CEREBRAS_REASONING_CONTENT, ['reasoning_content']],
    [GROQ_REASONING_CONTENT, ['reasoning_content']],
    [ZEN_REASONING_CONTENT, ['reasoning_content']],
    ['messages.1.reasoning_details: Extra inputs are not permitted', ['reasoning_details']],
    ["Unknown parameter: 'messages[1].reasoning_signature'.", ['reasoning_signature']]
  ];
  for (const [error, expected] of cases) {
    assert.deepEqual(unsupportedRequestParameters(text(error)), expected, text(error));
  }
});

test('C1 匹配器：语义不明确或要求保留字段的错误一律不匹配', () => {
  const negatives = [
    // DeepSeek 要求回传 reasoning_content：绝不能当成“不支持”。
    { error: { message: 'The `reasoning_content` in the thinking mode must be passed back to the API.', type: 'invalid_request_error', param: null, code: 'invalid_request_error' } },
    // 值不被支持而不是参数不被支持：不能擅自去掉推理强度。
    { error: { message: "Unsupported value: 'reasoning_effort' does not support 'minimal' with this model. Supported values are: 'low', 'medium', and 'high'.", param: 'reasoning_effort', code: 'unsupported_value' } },
    // max_tokens 超限不是参数改名。
    { error: { message: 'max_tokens is too large: 200000. This model supports at most 128000 completion tokens, whereas you provided 200000.', param: 'max_tokens' } },
    // 别的字段被拒绝：不属于自适配范围。
    { detail: [{ type: 'extra_forbidden', loc: ['body', 'user'], msg: 'Extra inputs are not permitted', input: 'temperature reasoning_effort' }] },
    "[{'type': 'extra_forbidden', 'loc': ('body', 'metadata'), 'msg': 'Extra inputs are not permitted', 'input': 'reasoning_content'}]",
    { error: { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens.", code: 'context_length_exceeded' } },
    { error: { message: 'Rate limit reached for requests', type: 'requests', code: 'rate_limit_exceeded' } },
    { error: { message: 'temperature: Input should be less than or equal to 2', type: 'invalid_request_error' } },
    'fetch failed: socket hang up'
  ];
  for (const error of negatives) assert.deepEqual(unsupportedRequestParameters(text(error)), [], text(error));
});

const target = (overrides = {}) => ({ providerConfigId: 'unit-provider', provider: 'openai-compatible', baseUrl: 'https://gateway.example/v1', model: 'claude-sonnet-5', ...overrides });

test('C1 学习：只认 400/422，5xx、429 与无状态码的网络错误不记忆', () => {
  resetProviderRequestAdaptations();
  const body = JSON.parse(GATEWAY_REASONING_EFFORT);
  assert.deepEqual(learnProviderRequestAdaptations(target(), { kind: 'http_error', status: 500, bodyText: GATEWAY_REASONING_EFFORT, rawBody: body }), []);
  assert.deepEqual(learnProviderRequestAdaptations(target(), { kind: 'http_error', status: 502, bodyText: GATEWAY_REASONING_EFFORT }), []);
  assert.deepEqual(learnProviderRequestAdaptations(target(), { kind: 'http_error', status: 429, bodyText: GATEWAY_REASONING_EFFORT }), []);
  assert.deepEqual(learnProviderRequestAdaptations(target(), { message: 'reasoning_effort: Extra inputs are not permitted' }), []);
  assert.deepEqual(learnedProviderRequestAdaptations(target()).parameters, []);
  assert.deepEqual(learnProviderRequestAdaptations(target(), { kind: 'http_error', status: 400, bodyText: GATEWAY_REASONING_EFFORT, rawBody: body }), ['parameter:reasoning_effort']);
  assert.deepEqual(learnProviderRequestAdaptations(target({ model: 'mistral-medium' }), { status: 422, rawBody: MISTRAL_REASONING_CONTENT }), ['parameter:reasoning_content']);
  assert.deepEqual(learnedProviderRequestAdaptations(target()).parameters, ['reasoning_effort']);
  // 其他目标（模型、baseUrl、渠道 id 任一不同）完全不受影响。
  assert.deepEqual(learnedProviderRequestAdaptations(target({ model: 'claude-opus-5' })).parameters, []);
  assert.deepEqual(learnedProviderRequestAdaptations(target({ baseUrl: 'https://other.example/v1' })).parameters, []);
  assert.deepEqual(learnedProviderRequestAdaptations(target({ providerConfigId: 'other' })).parameters, []);
  // max_tokens 改名只对 Chat Completions 形状生效；Claude 的 max_tokens 是必填项。
  assert.deepEqual(learnProviderRequestAdaptations(target({ provider: 'claude', model: 'x' }), { status: 400, rawBody: OPENAI_MAX_TOKENS }), []);
  resetProviderRequestAdaptations();
});

test('C1 请求适配：只动被记住的参数，没有适配时返回同一引用', () => {
  const body = {
    model: 'm', max_tokens: 100, temperature: 0.2, top_p: 0.9, reasoning_effort: 'high', stream: true, stream_options: { include_usage: true },
    messages: [
      { role: 'user', content: 'hi', reasoning_content: 'user field is not ours' },
      { role: 'assistant', content: 'a', reasoning_content: 'r', reasoning_signature: 's', reasoning_details: [{ type: 'reasoning.text' }] }
    ]
  };
  const snapshot = structuredClone(body);
  assert.equal(adaptRequestParameters(body, new Set(), 'openai-compatible'), body);
  const adapted = adaptRequestParameters(body, new Set(['reasoning_effort', 'stream_options', 'max_tokens', 'reasoning_content', 'reasoning_details']), 'openai-compatible');
  assert.deepEqual(adapted, {
    model: 'm', temperature: 0.2, top_p: 0.9, stream: true, max_completion_tokens: 100,
    messages: [
      { role: 'user', content: 'hi', reasoning_content: 'user field is not ours' },
      { role: 'assistant', content: 'a', reasoning_signature: 's' }
    ]
  });
  assert.deepEqual(body, snapshot, '原请求体不能被原地修改');
  const claude = adaptRequestParameters({ model: 'c', max_tokens: 10, temperature: 0.5 }, new Set(['max_tokens', 'temperature']), 'claude');
  assert.deepEqual(claude, { model: 'c', max_tokens: 10 });
});

function providerSettings(baseUrl, overrides = {}) {
  return {
    id: 'adaptation-provider', name: 'Adaptation', provider: 'openai-compatible', baseUrl, model: 'claude-sonnet-5',
    models: [], apiKey: 'dummy-test-key', toolCallFormat: 'function-call', openaiResponsesTransport: 'http', stream: true,
    retryOnError: false, retryMaxAttempts: 0, retryDelaySeconds: 0, enableMultimodalTools: true, systemPromptPrefix: '',
    promptCache: { enabled: false, mode: 'key', ttl: '30m' }, modelConfigs: [], createdAt: 1, updatedAt: 1,
    generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
    ...overrides
  };
}

const OK_STREAM = [
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"PONG"},"finish_reason":null}]}',
  'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
  'data: [DONE]',
  ''
].join('\n\n');

async function withServer(respond, run) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
    calls.push(call);
    const result = await respond(call, calls.length);
    res.writeHead(result.status ?? 200, { 'content-type': result.sse ? 'text/event-stream' : 'application/json' });
    res.end(result.sse ?? (typeof result.body === 'string' ? result.body : JSON.stringify(result.body)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/v1`, calls);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function chat(settings, id = 'adaptation-request', contents = [{ role: 'user', parts: [{ text: 'ping' }] }]) {
  const events = [];
  await startLlmProvider({ id, conversationId: 'adaptation-conversation', contents, tools: [] }, (event) => events.push(event), { settings: async () => settings });
  return events;
}

test('C1 聊天路径：网关拒绝 reasoning_effort 后立即去掉重发一次，不占重试次数，并按目标记住', async () => {
  resetProviderRequestAdaptations();
  await withServer((call) => call.body.reasoning_effort !== undefined
    ? { status: 400, body: GATEWAY_REASONING_EFFORT }
    : { sse: OK_STREAM }, async (baseUrl, calls) => {
    const settings = providerSettings(baseUrl);
    const events = await chat(settings);
    assert.ok(events.some((event) => event.type === 'llm:done'), JSON.stringify(events.filter((event) => event.type === 'llm:error')));
    assert.equal(events.some((event) => event.type === 'llm:error'), false);
    assert.equal(events.some((event) => event.type.startsWith('llm:retry')), false, '自适配重发不是普通重试');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.reasoning_effort, 'high');
    assert.equal(calls[1].body.reasoning_effort, undefined);
    // 除被拒参数外，其余请求体逐字节不变。
    const { reasoning_effort: _removed, ...firstWithoutEffort } = calls[0].body;
    assert.deepEqual(calls[1].body, firstWithoutEffort);

    // 同一目标的后续请求直接适配，不再先失败一次。
    await chat(settings, 'adaptation-request-2');
    assert.equal(calls.length, 3);
    assert.equal(calls[2].body.reasoning_effort, undefined);

    // dry-run 展示与真实请求一致。
    const dry = await dryRunLlmProvider({ id: 'dry', conversationId: 'adaptation-conversation', contents: [{ role: 'user', parts: [{ text: 'ping' }] }], tools: [] }, { settings: async () => settings });
    assert.equal(dry.body.reasoning_effort, undefined);

    // 其他目标（换模型）完全不受影响。
    const other = await dryRunLlmProvider({ id: 'dry-other', conversationId: 'adaptation-conversation', contents: [{ role: 'user', parts: [{ text: 'ping' }] }], tools: [] },
      { settings: async () => ({ ...settings, model: 'claude-opus-5' }) });
    assert.equal(other.body.reasoning_effort, 'high');
  });
  resetProviderRequestAdaptations();
});

test('C1 聊天路径：不明确的 400 与 5xx 保持原有失败/重试语义', async () => {
  resetProviderRequestAdaptations();
  await withServer(() => ({ status: 400, body: { error: { message: "Invalid value for 'reasoning_effort': 'ultra'.", type: 'invalid_request_error' } } }), async (baseUrl, calls) => {
    const events = await chat(providerSettings(baseUrl, { id: 'adaptation-unclear' }));
    assert.equal(calls.length, 1);
    assert.ok(events.some((event) => event.type === 'llm:error'));
  });
  await withServer(() => ({ status: 500, body: GATEWAY_REASONING_EFFORT }), async (baseUrl, calls) => {
    const events = await chat(providerSettings(baseUrl, { id: 'adaptation-5xx' }));
    assert.equal(calls.length, 1, '5xx 不是参数问题');
    assert.ok(events.some((event) => event.type === 'llm:error'));
  });
  resetProviderRequestAdaptations();
});

test('C1 聊天路径：严格服务拒绝助手消息的 reasoning_content 时只去掉该字段', async () => {
  resetProviderRequestAdaptations();
  const history = [
    { role: 'user', parts: [{ text: 'first' }] },
    { role: 'model', parts: [{ text: 'plan', thought: true }, { text: 'answer' }] },
    { role: 'user', parts: [{ text: 'second' }] }
  ];
  await withServer((call) => call.body.messages.some((message) => 'reasoning_content' in message)
    ? { status: 400, body: CEREBRAS_REASONING_CONTENT }
    : { sse: OK_STREAM }, async (baseUrl, calls) => {
    const events = await chat(providerSettings(baseUrl, { id: 'adaptation-message-field', model: 'gpt-oss-120b', generationConfig: undefined }), 'message-field', history);
    assert.ok(events.some((event) => event.type === 'llm:done'));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.messages[1].reasoning_content, 'plan');
    assert.deepEqual(calls[1].body.messages[1], { role: 'assistant', content: 'answer' });
  });
  resetProviderRequestAdaptations();
});

test('C1 聊天路径：OpenAI 要求 max_completion_tokens 时改名重发', async () => {
  resetProviderRequestAdaptations();
  await withServer((call) => call.body.max_tokens !== undefined
    ? { status: 400, body: OPENAI_MAX_TOKENS }
    : { sse: OK_STREAM }, async (baseUrl, calls) => {
    const events = await chat(providerSettings(baseUrl, { id: 'adaptation-max-tokens', model: 'gpt-5.5', generationConfig: { maxOutputTokens: 321 } }));
    assert.ok(events.some((event) => event.type === 'llm:done'));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.max_tokens, 321);
    assert.equal(calls[1].body.max_tokens, undefined);
    assert.equal(calls[1].body.max_completion_tokens, 321);
  });
  resetProviderRequestAdaptations();
});

test('C1 摘要路径：拒绝 temperature 后立即去掉重发', async () => {
  resetProviderRequestAdaptations();
  await withServer((call) => call.body.temperature !== undefined
    ? { status: 400, body: OPENAI_TEMPERATURE_VALUE }
    : { body: { id: 's', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '<summary>目标\n无</summary>' }, finish_reason: 'stop' }] } },
  async (baseUrl, calls) => {
    const settings = providerSettings(baseUrl, { id: 'adaptation-summary', model: 'gpt-5.5', stream: false, generationConfig: undefined });
    const capability = createLlmProviderCapability({ settings: async () => settings, compressionSettings: async () => undefined });
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('summary timed out')), 10_000);
        capability.compact({
          id: 'summary-request', blockId: 'summary-block', conversationId: 'summary-conversation', methodKind: 'llm_summary',
          methodConfigSnapshot: { id: 'summary-method', name: 'Summary', kind: 'llm_summary', trigger: { mode: 'manual' },
            llmSummary: { targetTokens: 1000, reasoning: { mode: 'provider_default' }, generationConfig: { temperature: 0.7 } }, createdAt: 1, updatedAt: 1 },
          contents: [{ role: 'user', parts: [{ text: 'history' }] }]
        }, (event) => {
          if (event.type !== 'llm:compactDone' && event.type !== 'llm:compactError') return;
          clearTimeout(timer);
          resolve(event);
        });
      });
      assert.equal(result.type, 'llm:compactDone', JSON.stringify(result.payload));
      assert.equal(calls.length, 2);
      assert.equal(calls[0].body.temperature, 0.7);
      assert.equal(calls[1].body.temperature, undefined);
    } finally {
      capability.dispose();
    }
  });
  resetProviderRequestAdaptations();
});

test('C1 助手消息的 reasoning 字段：只认明确指向 messages[N] 的错误，不与 Responses 顶层 reasoning 混淆', () => {
  const positives = [
    // https://github.com/can1357/oh-my-pi/issues/1157
    "Error: 400 Error from provider: Extra inputs are not permitted, field: 'messages[2].reasoning'",
    'messages.1.reasoning: Extra inputs are not permitted',
    { detail: [{ type: 'extra_forbidden', loc: ['body', 'messages', 2, 'assistant', 'reasoning'], msg: 'Extra inputs are not permitted', input: 'x' }] },
    "[{'type': 'extra_forbidden', 'loc': ('body', 'messages', 2, ..., 'reasoning'), 'msg': 'Extra inputs are not permitted'}]",
    { message: "messages.2.assistant.reasoning: property 'messages.2.assistant.reasoning' is unsupported", type: 'invalid_request_error' },
    { error: { message: "'messages.4' : for 'role:assistant' the following must be satisfied[('messages.4' : property 'reasoning' is unsupported)]" } },
    "Unknown parameter: 'messages[1].reasoning'."
  ];
  for (const error of positives) assert.deepEqual(unsupportedRequestParameters(text(error)), ['reasoning'], text(error));
  const topLevel = [
    "Unknown parameter: 'reasoning'.",
    'reasoning: Extra inputs are not permitted',
    { detail: [{ type: 'extra_forbidden', loc: ['body', 'reasoning'], msg: 'Extra inputs are not permitted' }] },
    "Unsupported parameter: 'reasoning.effort' is not supported with this model.",
    "Extra inputs are not permitted, field: 'reasoning'",
    'Unrecognized request argument supplied: reasoning'
  ];
  for (const error of topLevel) assert.deepEqual(unsupportedRequestParameters(text(error)), [], text(error));
  assert.deepEqual(unsupportedRequestParameters(GATEWAY_REASONING_EFFORT), ['reasoning_effort']);
  assert.deepEqual(unsupportedRequestParameters('messages.0.reasoning_content: Extra inputs are not permitted'), ['reasoning_content']);

  const body = { model: 'm', reasoning: { effort: 'high' }, messages: [{ role: 'assistant', content: 'a', reasoning: 'r', reasoning_details: [] }, { role: 'user', content: 'u', reasoning: 'keep' }] };
  assert.deepEqual(adaptRequestParameters(body, new Set(['reasoning']), 'openai-compatible'), {
    model: 'm', reasoning: { effort: 'high' },
    messages: [{ role: 'assistant', content: 'a', reasoning_details: [] }, { role: 'user', content: 'u', reasoning: 'keep' }]
  });
  const responsesBody = { model: 'gpt-5.5', reasoning: { effort: 'high' }, input: [] };
  assert.equal(adaptRequestParameters(responsesBody, new Set(['reasoning']), 'openai-responses'), responsesBody);
});

// 从 Gemini 换到严格 OpenAI 兼容服务：历史工具调用上的 Gemini 签名 `extra_content` 被拒时只去掉它。
test('C1 工具调用上的 extra_content：严格服务的报错形状逐条识别，其他字段不误判', () => {
  const positives = [
    "[{'type': 'extra_forbidden', 'loc': ('body', 'messages', 1, 'assistant', 'tool_calls', 0, 'extra_content'), 'msg': 'Extra inputs are not permitted', 'input': {'google': {'thought_signature': 'SIG'}}}]",
    { detail: [{ type: 'extra_forbidden', loc: ['body', 'messages', 1, 'assistant', 'tool_calls', 0, 'extra_content'], msg: 'Extra inputs are not permitted', input: {} }] },
    'messages.1.tool_calls.0.extra_content: Extra inputs are not permitted',
    { message: "messages.1.assistant.tool_calls.0.extra_content: property 'messages.1.assistant.tool_calls.0.extra_content' is unsupported", type: 'invalid_request_error' },
    { error: { message: "'messages.1.tool_calls.0' : property 'extra_content' is unsupported" } },
    "Unknown parameter: 'messages[1].tool_calls[0].extra_content'.",
    { error: { message: "Additional properties are not allowed ('extra_content' was unexpected) - 'messages.1.tool_calls.0'" } },
    'Failed to deserialize the JSON body into the target type: messages[1].tool_calls[0]: unknown field `extra_content`, expected one of `id`, `type`, `function` at line 1 column 412'
  ];
  for (const error of positives) assert.deepEqual(unsupportedRequestParameters(text(error)), ['extra_content'], text(error));
  const negatives = [
    // 不是被拒绝，只是提到了这个名字。
    { error: { message: 'Function call is missing a thought_signature in functionCall parts. See extra_content in the docs.' } },
    { detail: [{ type: 'extra_forbidden', loc: ['body', 'metadata'], msg: 'Extra inputs are not permitted', input: 'extra_content' }] },
    'extra_content_extended: Extra inputs are not permitted'
  ];
  for (const error of negatives) assert.deepEqual(unsupportedRequestParameters(text(error)), [], text(error));

  const body = {
    model: 'm',
    messages: [
      { role: 'user', content: 'u', extra_content: 'keep' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'a', type: 'function', function: { name: 'f', arguments: '{}' }, extra_content: { google: { thought_signature: 'SIG' } } },
        { id: 'b', type: 'function', function: { name: 'g', arguments: '{}' } }
      ] },
      { role: 'tool', tool_call_id: 'a', content: 'r' }
    ]
  };
  const adapted = adaptRequestParameters(body, new Set(['extra_content']), 'openai-compatible');
  assert.deepEqual(adapted.messages[1].tool_calls, [
    { id: 'a', type: 'function', function: { name: 'f', arguments: '{}' } },
    { id: 'b', type: 'function', function: { name: 'g', arguments: '{}' } }
  ]);
  assert.equal(adapted.messages[0], body.messages[0], '非助手消息不动');
  assert.equal(adapted.messages[1].tool_calls[1], body.messages[1].tool_calls[1], '没有该字段的调用保持同一引用');
  const noSignatures = { model: 'm', messages: [{ role: 'assistant', content: 'a', tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] }] };
  assert.equal(adaptRequestParameters(noSignatures, new Set(['extra_content']), 'openai-compatible'), noSignatures);
});

test('C1 聊天路径：从 Gemini 换到严格服务后，历史里的 extra_content 被拒时去掉重发并按目标记住', async () => {
  resetProviderRequestAdaptations();
  const history = [
    { role: 'user', parts: [{ text: 'weather?' }] },
    { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' }, callId: 'call_1' }, thoughtSignature: 'gemini:GEMINI_SIG' }] },
    { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { result: 'sunny' }, callId: 'call_1' } }] }
  ];
  const TRT_EXTRA_CONTENT = "[{'type': 'extra_forbidden', 'loc': ('body', 'messages', 1, 'assistant', 'tool_calls', 0, 'extra_content'), 'msg': 'Extra inputs are not permitted', 'input': {'google': {'thought_signature': 'GEMINI_SIG'}}}]";
  const carriesExtraContent = (call) => call.body.messages.some((message) => Array.isArray(message.tool_calls)
    && message.tool_calls.some((toolCall) => 'extra_content' in toolCall));
  await withServer((call) => carriesExtraContent(call)
    ? { status: 400, body: TRT_EXTRA_CONTENT }
    : { sse: OK_STREAM }, async (baseUrl, calls) => {
    const settings = providerSettings(baseUrl, { id: 'adaptation-extra-content', model: 'llama-4-maverick', generationConfig: undefined });
    const events = await chat(settings, 'extra-content', history);
    assert.ok(events.some((event) => event.type === 'llm:done'), JSON.stringify(events.filter((event) => event.type === 'llm:error')));
    assert.equal(events.some((event) => event.type.startsWith('llm:retry')), false, '自适配重发不是普通重试');
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body.messages[1].tool_calls[0].extra_content.google.thought_signature, 'GEMINI_SIG');
    assert.equal(carriesExtraContent(calls[1]), false);
    // 除工具调用上的 extra_content 外，请求体不变。
    const stripped = structuredClone(calls[0].body);
    delete stripped.messages[1].tool_calls[0].extra_content;
    assert.deepEqual(calls[1].body, stripped);

    await chat(settings, 'extra-content-2', history);
    assert.equal(calls.length, 3, '同一目标之后直接去掉，不再先失败一次');
    assert.equal(carriesExtraContent(calls[2]), false);
    // 其他目标照常回传签名（Gemini 需要它）。
    const other = await dryRunLlmProvider({ id: 'dry-extra-other', conversationId: 'adaptation-conversation', contents: history, tools: [] },
      { settings: async () => ({ ...settings, model: 'gemini-3.5-flash' }) });
    assert.equal(other.body.messages[1].tool_calls[0].extra_content.google.thought_signature, 'GEMINI_SIG');
  });
  resetProviderRequestAdaptations();
});
