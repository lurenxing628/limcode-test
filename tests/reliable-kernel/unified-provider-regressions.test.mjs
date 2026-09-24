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
const { startLlmProvider } = require(path.join(root, 'dist/extension/backend/capabilities/llmProvider.js'));
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
