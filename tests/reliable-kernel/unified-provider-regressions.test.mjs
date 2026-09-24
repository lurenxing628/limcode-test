import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// 模型接入库（unified-llm-provider limcode 补丁）与 LimCode 流式投影的回归测试。
// 只在本机起 http 服务模拟上游，走生产路径：startLlmProvider → 接入库编码 / 解码 → 事件投影 →
// 可靠内核的 LlmCapabilityFullRequestAdapter（它把事件拼成最终存下的回复）。不连接任何真实网关。

const require = createRequire(import.meta.url);
const root = process.cwd();
const { startLlmProvider, dryRunLlmProvider } = require(path.join(root, 'dist/extension/backend/capabilities/llmProvider.js'));
const kernel = await import(pathToFileURL(path.join(root, 'dist/extension/backend/reliableKernel/index.js')).href);

async function withServer(respond, run) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    calls.push({ path: req.url, body: text ? JSON.parse(text) : undefined });
    const result = respond({ path: req.url, index: calls.length - 1 });
    res.writeHead(result.status ?? 200, { 'content-type': result.sse !== undefined ? 'text/event-stream' : 'application/json' });
    res.end(result.sse ?? JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function settings(provider, baseUrl, model, overrides = {}) {
  return {
    id: `regression-${provider}`, name: 'Regression', provider, baseUrl, model, models: [], apiKey: 'offline-placeholder',
    toolCallFormat: 'function-call', openaiResponsesTransport: 'http', stream: true, retryOnError: false,
    retryMaxAttempts: 0, retryDelaySeconds: 0, enableMultimodalTools: true, systemPromptPrefix: '',
    promptCache: { enabled: false, mode: 'key', ttl: '30m' }, modelConfigs: [], createdAt: 1, updatedAt: 1,
    ...overrides
  };
}

const TOOLS = [
  { name: 'list_items', description: 'List items.', parameters: { type: 'object', properties: { page: { type: 'integer' } } } },
  { name: 'write_file', description: 'Write a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } }
];

/** 经可靠内核的 full-request adapter 发一次请求，返回最终存下的回复（completed.content）或失败原因。 */
async function sendThroughKernel(providerSettings, contents, tools = TOOLS) {
  const providerId = providerSettings.id;
  const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
    start(input, emit) { void startLlmProvider(input, emit, { settings: async () => providerSettings }); },
    abort() {}, cancelRetry() {}, dispose() {}
  });
  const events = [];
  let error;
  try {
    await adapter.sendFullRequest({
      kind: 'full-model-request', modelRequestId: 'mr-regression', conversationId: 'c-regression', attemptSeq: '1', socketGeneration: '1',
      providerId, modelId: providerSettings.model,
      authoritySnapshot: {
        model: { providerConfigId: providerId, provider: providerSettings.provider, modelId: providerSettings.model },
        toolPolicy: { allowedTools: tools.map((tool) => tool.name), preset: 'custom', sourceConfigs: {} }
      },
      recipe: { tools },
      context: contents.map((content, index) => ({
        segmentId: `s${index}`, segmentKind: 'message', messageRole: content.role,
        contentType: 'application/vnd.limcode.message+json', content: JSON.stringify(content)
      })),
      attachmentCatalogState: { catalog: [], placements: [] }
    }, {
      onEvent: async (event) => {
        events.push(event);
        return { accepted: true, checkpointed: true, terminal: event.kind === 'completed' };
      }
    });
  } catch (caught) {
    error = caught;
  }
  return { completed: events.find((event) => event.kind === 'completed')?.content, error, events };
}

const user = (text) => ({ role: 'user', parts: [{ text }] });
const functionCallsOf = (content) => (content?.parts ?? []).filter((part) => part.functionCall);

// ---- GPT-6 家族 / gpt-5.x 非流式回复的 assistant phase ----

test('非流式 Responses：带 phase 的 assistant message 按 outputItem 存下，回放时带回 phase（gpt-5.5 与 GPT-6 家族）', async () => {
  // OpenAI Responses 参考 phase 字段：“preserve and resend phase on all assistant messages — dropping it can
  // degrade performance”。非流式时以前把全部可见文字拼成一个不带 outputItem 的 Delta，phase 丢失。
  const output = [
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'plan' }], encrypted_content: 'gAAAAB_ENC' },
    { type: 'message', id: 'msg_pre', role: 'assistant', status: 'completed', phase: 'commentary', content: [{ type: 'output_text', text: 'Let me check.', annotations: [] }] },
    { type: 'message', id: 'msg_fin', role: 'assistant', status: 'completed', phase: 'final_answer', content: [{ type: 'output_text', text: 'All done.', annotations: [] }] }
  ];
  for (const model of ['gpt-5.5', 'gpt-6-sol']) {
    await withServer(() => ({
      body: { id: 'resp_1', object: 'response', status: 'completed', error: null, incomplete_details: null, output, usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } }
    }), async (base, calls) => {
      const providerSettings = settings('openai-responses', `${base}/v1`, model, { stream: false });
      const first = await sendThroughKernel(providerSettings, [user('go')], []);
      assert.equal(first.error, undefined, model);
      const visible = first.completed.parts.filter((part) => typeof part.text === 'string' && part.thought !== true);
      assert.deepEqual(visible.map((part) => [part.text, part.outputItem?.id, part.outputItem?.phase]), [
        ['Let me check.', 'msg_pre', 'commentary'],
        ['All done.', 'msg_fin', 'final_answer']
      ], model);

      await sendThroughKernel(providerSettings, [user('go'), first.completed, user('next')], []);
      const replayed = calls[1].body.input.filter((item) => item.type === 'message' && item.role === 'assistant');
      assert.deepEqual(replayed.map((item) => [item.phase, item.content.map((block) => block.text).join('')]), [
        ['commentary', 'Let me check.'],
        ['final_answer', 'All done.']
      ], model);
    });
  }
});

// ---- 没有 id 的流式工具调用只存一条 ----

const geminiSse = (chunks) => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');
const geminiChunk = (parts, finishReason) => ({ candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }] });

test('流式工具调用没有 id 时只存一条（接入库把同一个调用对象同时放进 functionCalls 和 partsDelta）', async () => {
  // Gemini 2.x 等模型的 functionCall 不带 id；接入库对同一个调用对象同时给出 functionCalls 与 partsDelta，
  // 投影以前只按 callId 去重，没有 id 的调用被编成 tool_call_0、tool_call_1 两条，可能执行两次。
  await withServer(() => ({ sse: geminiSse([geminiChunk([{ functionCall: { name: 'list_items', args: { page: 1 } } }], 'STOP')]) }), async (base) => {
    const result = await sendThroughKernel(settings('gemini', `${base}/v1beta`, 'gemini-2.5-flash'), [user('go')]);
    assert.equal(result.error, undefined);
    assert.deepEqual(functionCallsOf(result.completed).map((part) => [part.functionCall.name, part.functionCall.args]), [
      ['list_items', { page: 1 }]
    ]);
  });
});

test('同一块里两个参数相同、都没有 id 的并行调用仍是两条（按对象身份去重，不按内容去重）', async () => {
  await withServer(() => ({ sse: geminiSse([geminiChunk([
    { functionCall: { name: 'list_items', args: { page: 1 } } },
    { functionCall: { name: 'list_items', args: { page: 1 } } }
  ], 'STOP')]) }), async (base) => {
    const result = await sendThroughKernel(settings('gemini', `${base}/v1beta`, 'gemini-2.5-flash'), [user('go')]);
    assert.equal(result.error, undefined);
    const calls = functionCallsOf(result.completed);
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].id, calls[1].id);
  });
});

test('OpenAI 兼容流里不带 id 的工具调用同样只存一条', async () => {
  const chunk = (delta, finish = null) => ({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
  const sse = [
    chunk({ role: 'assistant', tool_calls: [{ index: 0, type: 'function', function: { name: 'list_items', arguments: '{"page":2}' } }] }),
    chunk({}, 'tool_calls')
  ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';
  await withServer(() => ({ sse }), async (base) => {
    const result = await sendThroughKernel(settings('openai-compatible', `${base}/v1`, 'relay-model'), [user('go')]);
    assert.equal(result.error, undefined);
    assert.deepEqual(functionCallsOf(result.completed).map((part) => [part.functionCall.name, part.functionCall.args]), [
      ['list_items', { page: 2 }]
    ]);
  });
});

test('没有 id 的调用分在不同块里到达时各自存下，不会因为占位 id 相同而整轮失败', async () => {
  // 占位 id 以前按“本块内的序号”生成，两块各一个无 id 调用都叫 tool_call_0，可靠内核按 id 合并时
  // 报 “reused tool call id tool_call_0 with conflicting content”，整次请求失败。
  await withServer(() => ({ sse: geminiSse([
    geminiChunk([{ functionCall: { name: 'list_items', args: { page: 1 } } }]),
    geminiChunk([{ functionCall: { name: 'list_items', args: { page: 2 } } }], 'STOP')
  ]) }), async (base) => {
    const result = await sendThroughKernel(settings('gemini', `${base}/v1beta`, 'gemini-2.5-flash'), [user('go')]);
    assert.equal(result.error, undefined, result.error?.message);
    const calls = functionCallsOf(result.completed);
    assert.deepEqual(calls.map((part) => part.functionCall.args), [{ page: 1 }, { page: 2 }]);
    assert.notEqual(calls[0].id, calls[1].id);
  });

  const chunk = (delta, finish = null) => ({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
  const sse = [
    chunk({ role: 'assistant', tool_calls: [{ index: 0, type: 'function', function: { name: 'list_items', arguments: '{"page":1}' } }] }),
    chunk({ tool_calls: [{ index: 1, type: 'function', function: { name: 'list_items', arguments: '{"page":2}' } }] }),
    chunk({}, 'tool_calls')
  ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';
  await withServer(() => ({ sse }), async (base) => {
    const result = await sendThroughKernel(settings('openai-compatible', `${base}/v1`, 'relay-model'), [user('go')]);
    assert.equal(result.error, undefined, result.error?.message);
    assert.deepEqual(functionCallsOf(result.completed).map((part) => part.functionCall.args), [{ page: 1 }, { page: 2 }]);
  });
});

// ---- finish_reason=length 截断的工具参数错误不整包重试 ----

/** 直接走 capability 层（渠道自己的“出错重试”设置），返回全部事件。 */
async function runCapability(providerSettings, contents = [user('go')]) {
  const events = [];
  await startLlmProvider({ id: 'capability-request', conversationId: 'capability-conversation', contents, tools: TOOLS },
    (event) => events.push(event), { settings: async () => providerSettings });
  return events;
}

test('finish_reason=length 截断工具参数时不整包重试（接入库标 retryable:false，重试判断尊重它）', async () => {
  // Chat Completions：finish_reason “length” 表示达到请求里的最大 token 数，原样重发会在同一上限处
  // 再次截断；以前按“出错重试”整包重发（默认 4 次），每次都耗满输出上限。
  const chunk = (delta, finish = null) => ({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
  const truncatedStream = [
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"hel' } }] }),
    chunk({}, 'length')
  ].map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n';
  const truncatedBody = {
    id: 'c', object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"hel' } }] }, finish_reason: 'length' }]
  };
  for (const [label, response, overrides] of [
    ['stream', { sse: truncatedStream }, {}],
    ['non-stream', { body: truncatedBody }, { stream: false }]
  ]) {
    await withServer(() => response, async (base, calls) => {
      const events = await runCapability(settings('openai-compatible', `${base}/v1`, 'relay-model', {
        retryOnError: true, retryMaxAttempts: 2, ...overrides
      }));
      assert.equal(calls.length, 1, label);
      assert.equal(events.some((event) => event.type === 'llm:retryScheduled'), false, label);
      const error = events.find((event) => event.type === 'llm:error')?.payload;
      assert.match(error?.message ?? '', /参数可能被截断/, label);
      assert.equal(error.rawError.retryable, false, label);
      // 可靠内核自己的尝试预算也不把它当作可重放的临时故障。
      const kernelResult = await sendThroughKernel(settings('openai-compatible', `${base}/v1`, 'relay-model', overrides), [user('go')]);
      assert.ok(kernelResult.error, label);
      assert.equal(kernelResult.error instanceof kernel.ProviderTransientError, false, label);
    });
  }
});

test('没有 retryable:false 的普通错误仍按渠道设置重试', async () => {
  await withServer(({ index }) => (index === 0
    ? { status: 503, body: { error: { message: 'temporarily unavailable', type: 'server_error' } } }
    : { sse: `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n` }),
  async (base, calls) => {
    const events = await runCapability(settings('openai-compatible', `${base}/v1`, 'relay-model', { retryOnError: true, retryMaxAttempts: 2, retryDelaySeconds: 0 }));
    assert.equal(calls.length, 2);
    assert.ok(events.some((event) => event.type === 'llm:done'));
  });
});

// ---- 接入库协议修复的端到端回归：修复被回退时这些测试会失败 ----

/** 真实编码链路（接入库编码 + LimCode 请求改写）产出的请求（url 与 body）。 */
function dryRun(providerSettings, contents, tools = TOOLS) {
  return dryRunLlmProvider({ id: 'dry-run', invocationId: 'dry-run', conversationId: 'dry-run', contents, tools },
    { settings: async () => providerSettings });
}

const openAIChunk = (delta, finish = null, extra = {}) => ({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish, ...extra }] });
const openAISse = (chunks, { done = true } = {}) => chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '');

test('finish_reason:"error" 按错误上报，即使前面已经有可见文字（流式与非流式）', async () => {
  // OpenRouter errors-and-debugging：200 之后的错误以 finish_reason "error" 的块终止流；非流式把错误放在
  // choice 里。以前有文字时当作正常结束，半截回复被存成成功。
  const stream = openAISse([
    openAIChunk({ role: 'assistant', content: 'partial answer' }),
    openAIChunk({ content: '' }, 'error', { native_finish_reason: 'MALFORMED_FUNCTION_CALL' })
  ]);
  const body = { id: 'c', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'partial answer' }, finish_reason: 'error', error: { code: 502, message: 'Provider disconnected' } }] };
  for (const [label, response, overrides] of [['stream', { sse: stream }, {}], ['non-stream', { body }, { stream: false }]]) {
    await withServer(() => response, async (base) => {
      const events = await runCapability(settings('openai-compatible', `${base}/v1`, 'relay-model', overrides));
      assert.equal(events.some((event) => event.type === 'llm:done'), false, label);
      assert.match(events.find((event) => event.type === 'llm:error')?.payload.message ?? '', /finish_reason: "error"/, label);
    });
  }
});

test('Responses 函数工具默认发送 strict:false', async () => {
  // https://developers.openai.com/api/docs/guides/function-calling#strict-mode：“To opt out of strict mode in
  // Responses and keep non-strict, best-effort function calling, explicitly set strict: false.”
  const result = await dryRun(settings('openai-responses', 'https://api.openai.com/v1', 'gpt-5.5'), [user('hi')]);
  assert.deepEqual(result.body.tools.map((tool) => [tool.name, tool.strict]), [['list_items', false], ['write_file', false]]);
});

test('Claude：其他渠道产生的不合规工具调用 id 改写成 Claude 接受的 id，tool_use 与 tool_result 一致', async () => {
  // Messages API：tool_use.id 与 tool_result.tool_use_id 须匹配 ^[a-zA-Z0-9_-]+$。Kimi 风格的
  // functions.list_items:0 原样发出会被拒绝。
  const history = [
    user('hi'),
    { role: 'model', parts: [{ id: 'functions.list_items:0', functionCall: { name: 'list_items', args: {} } }, { id: 'toolu_01ABC', functionCall: { name: 'list_items', args: { page: 2 } } }] },
    { role: 'user', parts: [
      { id: 'functions.list_items:0', functionResponse: { name: 'list_items', response: { ok: 1 } } },
      { id: 'toolu_01ABC', functionResponse: { name: 'list_items', response: { ok: 2 } } }
    ] }
  ];
  const result = await dryRun(settings('claude', 'https://api.anthropic.com/v1', 'claude-opus-5-5'), history);
  const toolUses = result.body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === 'tool_use');
  const toolResults = result.body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []).filter((block) => block.type === 'tool_result');
  for (const block of toolUses) assert.match(block.id, /^[a-zA-Z0-9_-]+$/);
  assert.equal(toolUses[1].id, 'toolu_01ABC', '已合规的 id 原样发出');
  assert.notEqual(toolUses[0].id, 'functions.list_items:0');
  assert.deepEqual(toolResults.map((block) => block.tool_use_id), toolUses.map((block) => block.id));
});

test('Gemini 请求 URL 对模型 id 做百分号编码', async () => {
  // 网关常用带方括号、空格或 # 的模型别名；不编码时 # 之后的部分会被当成 URL 片段丢掉，请求打到错误的路径。
  const base = 'https://generativelanguage.googleapis.com/v1beta';
  const bracketed = await dryRun(settings('gemini', base, '[v]gemini-3.5-flash'), [user('hi')]);
  assert.equal(new URL(bracketed.url).pathname, '/v1beta/models/%5Bv%5Dgemini-3.5-flash:streamGenerateContent');
  const hashed = await dryRun(settings('gemini', base, 'tuned/gemini flash#2'), [user('hi')]);
  const url = new URL(hashed.url);
  assert.equal(url.pathname, '/v1beta/models/tuned/gemini%20flash%232:streamGenerateContent');
  assert.equal(url.hash, '');
  const official = await dryRun(settings('gemini', base, 'gemini-2.5-flash'), [user('hi')]);
  assert.equal(new URL(official.url).pathname, '/v1beta/models/gemini-2.5-flash:streamGenerateContent', '官方 id 不变');
});

test('DeepSeek 思考等级按官方取值映射（minimal→low、medium/xhigh→high），不再被当成未设置', async () => {
  // https://api-docs.deepseek.com/guides/thinking_mode：reasoning_effort 只接受 low / high / max，其他等级按对照表映射。
  const expected = {
    minimal: { thinking: { type: 'enabled' }, reasoning_effort: 'low' },
    low: { thinking: { type: 'enabled' }, reasoning_effort: 'low' },
    medium: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
    xhigh: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
    max: { thinking: { type: 'enabled' }, reasoning_effort: 'max' },
    none: { thinking: { type: 'disabled' } }
  };
  for (const [level, params] of Object.entries(expected)) {
    const result = await dryRun(settings('openai-compatible', 'https://api.deepseek.com/v1', 'deepseek-v4-pro', {
      generationConfig: { thinkingConfig: { thinkingLevel: level } }
    }), [user('hi')], []);
    const actual = Object.fromEntries(['thinking', 'reasoning_effort', 'enable_thinking'].filter((key) => key in result.body).map((key) => [key, result.body[key]]));
    assert.deepEqual(actual, params, level);
  }
});

test('流结束补发：收到 [DONE] 时没有 finish_reason 的无参数调用按 {} 存下；连接干净断开时按参数截断报错', async () => {
  // 部分中转在工具调用流里不发 finish_reason，最后一个（无参数）调用只能在流结束时补发。只有收到
  // data: [DONE] 才能确定流已结束；没有 [DONE] 的 EOF 可能是连接在参数发完之前断开，按 {} 补发会让
  // 参数全可选的 write_file 真的以空参数执行。
  const nameOnly = (name) => openAIChunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '' } }] });
  await withServer(() => ({ sse: openAISse([nameOnly('list_items')]) }), async (base) => {
    const result = await sendThroughKernel(settings('openai-compatible', `${base}/v1`, 'relay-model'), [user('go')]);
    assert.equal(result.error, undefined, result.error?.message);
    assert.deepEqual(functionCallsOf(result.completed).map((part) => [part.id, part.functionCall.name, part.functionCall.args]), [
      ['call_1', 'list_items', {}]
    ]);
  });
  // 没有 [DONE] 也没有 finish_reason：LimCode 的 terminalValidatedFetch 先把它判为 LLM_STREAM_TRUNCATED，
  // 接入库（limcode.7）自己也不再按 {} 补发。两层任一层都保证 write_file 不会以空参数存下或执行。
  await withServer(() => ({ sse: openAISse([nameOnly('write_file')], { done: false }) }), async (base) => {
    const result = await sendThroughKernel(settings('openai-compatible', `${base}/v1`, 'relay-model'), [user('go')]);
    assert.equal(result.completed, undefined);
    assert.ok(result.error);
    assert.equal(result.events.some((event) => JSON.stringify(event).includes('write_file')), false);
  });
});
