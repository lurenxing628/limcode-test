import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { startLlmProvider } from '../../dist/extension/backend/capabilities/llmProvider.js';

// C8：没有任何可见输出和工具调用、且结束原因表示出错/被过滤/被截断时按失败上报。
// 结束原因依据：OpenAI Chat Completions finish_reason（length、content_filter）、OpenRouter 流中途错误 finish_reason "error"
// （https://openrouter.ai/docs/api-reference/errors）、Claude stop_reason
// （https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons）、Gemini FinishReason
// （https://ai.google.dev/api/generate-content#FinishReason）。

async function withServer(respond, run) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
    const result = respond(req.url);
    res.writeHead(result.status ?? 200, { 'content-type': result.sse ? 'text/event-stream' : 'application/json' });
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
    id: `finish-${provider}-${model}`, name: 'Finish', provider, baseUrl, model, models: [], apiKey: 'dummy-test-key',
    toolCallFormat: 'function-call', openaiResponsesTransport: 'http', stream: true, retryOnError: false,
    retryMaxAttempts: 0, retryDelaySeconds: 0, enableMultimodalTools: true, systemPromptPrefix: '',
    promptCache: { enabled: false, mode: 'key', ttl: '30m' }, modelConfigs: [], createdAt: 1, updatedAt: 1,
    ...overrides
  };
}

async function run(providerSettings) {
  const events = [];
  await startLlmProvider({ id: 'finish-request', conversationId: 'finish-conversation', contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    tools: [{ name: 'list_items', description: 'List items', parameters: { type: 'object', properties: {} } }] },
  (event) => events.push(event), { settings: async () => providerSettings });
  return {
    done: events.some((event) => event.type === 'llm:done'),
    error: events.find((event) => event.type === 'llm:error')?.payload,
    text: events.filter((event) => event.type === 'llm:delta').map((event) => event.payload.text ?? '').join('')
  };
}

const sse = (chunks) => `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
const openAIChunk = (delta, finish = null) => ({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });

test('C8 OpenAI 兼容：只有思考就以 length / content_filter / error 结束时按失败上报并写明原因', async () => {
  for (const finish of ['length', 'content_filter', 'error']) {
    await withServer(() => ({ sse: sse([openAIChunk({ role: 'assistant', reasoning_content: 'thinking...' }), openAIChunk({}, finish)]) }), async (base) => {
      const result = await run(settings('openai-compatible', `${base}/v1`, 'reasoner'));
      assert.equal(result.done, false, finish);
      assert.ok(result.error, finish);
      assert.match(result.error.message, new RegExp(`结束原因：${finish}`));
      assert.equal(result.error.rawError.finishReason, finish);
    });
  }
});

test('C8 OpenAI 兼容：有输出、有工具调用或正常结束的回复保持原样', async () => {
  const cases = [
    ['text + length', [openAIChunk({ role: 'assistant', content: 'partial answer' }), openAIChunk({}, 'length')], 'partial answer'],
    ['tool call + length', [openAIChunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'list_items', arguments: '{}' } }] }), openAIChunk({}, 'length')], ''],
    ['empty + stop', [openAIChunk({ role: 'assistant', content: '' }), openAIChunk({}, 'stop')], ''],
    ['empty + no finish reason', [openAIChunk({ role: 'assistant', content: '' })], '']
  ];
  for (const [label, chunks, text] of cases) {
    await withServer(() => ({ sse: sse(chunks) }), async (base) => {
      const result = await run(settings('openai-compatible', `${base}/v1`, 'reasoner'));
      assert.equal(result.done, true, label);
      assert.equal(result.error, undefined, label);
      assert.equal(result.text, text, label);
    });
  }
});

test('C8 非流式：空内容 + length 失败，有内容时成功', async () => {
  const completion = (content, finish) => ({ id: 'c', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }] });
  await withServer(() => ({ body: completion('', 'length') }), async (base) => {
    const result = await run(settings('openai-compatible', `${base}/v1`, 'reasoner', { stream: false }));
    assert.equal(result.done, false);
    assert.match(result.error.message, /结束原因：length/);
  });
  await withServer(() => ({ body: completion('complete', 'length') }), async (base) => {
    const result = await run(settings('openai-compatible', `${base}/v1`, 'reasoner', { stream: false }));
    assert.equal(result.done, true);
    assert.equal(result.error, undefined);
  });
  await withServer(() => ({ body: completion('', 'stop') }), async (base) => {
    const result = await run(settings('openai-compatible', `${base}/v1`, 'reasoner', { stream: false }));
    assert.equal(result.done, true, '正常结束的空回复行为不变');
  });
});

const claudeStream = (blocks, stopReason) => [
  ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4-6', stop_reason: null, usage: { input_tokens: 5, output_tokens: 1 } } }],
  ...blocks.flatMap((block, index) => block.type === 'thinking'
    ? [
        ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } }],
        ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig' } }],
        ['content_block_stop', { type: 'content_block_stop', index }]
      ]
    : [
        ['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } }],
        ['content_block_stop', { type: 'content_block_stop', index }]
      ]),
  ['message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 3 } }],
  ['message_stop', { type: 'message_stop' }]
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

test('C8 Claude：只有思考的 max_tokens、refusal、model_context_window_exceeded 按失败上报；有文字时不变', async () => {
  for (const [stopReason, expected] of [['max_tokens', 'MAX_TOKENS'], ['refusal', 'refusal'], ['model_context_window_exceeded', 'model_context_window_exceeded']]) {
    await withServer(() => ({ sse: claudeStream([{ type: 'thinking', thinking: 'long thought' }], stopReason) }), async (base) => {
      const result = await run(settings('claude', `${base}/v1`, 'claude-sonnet-4-6'));
      assert.equal(result.done, false, stopReason);
      assert.match(result.error.message, new RegExp(`结束原因：${expected}`), stopReason);
    });
  }
  await withServer(() => ({ sse: claudeStream([{ type: 'thinking', thinking: 't' }, { type: 'text', text: 'answer so far' }], 'max_tokens') }), async (base) => {
    const result = await run(settings('claude', `${base}/v1`, 'claude-sonnet-4-6'));
    assert.equal(result.done, true);
    assert.equal(result.text, 'answer so far');
  });
  await withServer(() => ({ sse: claudeStream([{ type: 'thinking', thinking: 't' }], 'end_turn') }), async (base) => {
    const result = await run(settings('claude', `${base}/v1`, 'claude-sonnet-4-6'));
    assert.equal(result.done, true, 'end_turn 保持原样');
  });
});

test('C8 Gemini：没有内容的 SAFETY / MAX_TOKENS / MALFORMED_FUNCTION_CALL 等按失败上报', async () => {
  for (const finish of ['SAFETY', 'MAX_TOKENS', 'RECITATION', 'MALFORMED_FUNCTION_CALL', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'UNEXPECTED_TOOL_CALL']) {
    await withServer(() => ({ sse: `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'hidden', thought: true }] }, finishReason: finish }] })}\n\n` }), async (base) => {
      const result = await run(settings('gemini', `${base}/v1beta`, 'gemini-2.5-flash'));
      assert.equal(result.done, false, finish);
      assert.match(result.error.message, new RegExp(`结束原因：${finish}`), finish);
    });
  }
  await withServer(() => ({ sse: `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'visible' }] }, finishReason: 'MAX_TOKENS' }] })}\n\n` }), async (base) => {
    const result = await run(settings('gemini', `${base}/v1beta`, 'gemini-2.5-flash'));
    assert.equal(result.done, true);
    assert.equal(result.text, 'visible');
  });
  await withServer(() => ({ sse: `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }] })}\n\n` }), async (base) => {
    const result = await run(settings('gemini', `${base}/v1beta`, 'gemini-2.5-flash'));
    assert.equal(result.done, true, 'STOP 保持原样');
  });
});
