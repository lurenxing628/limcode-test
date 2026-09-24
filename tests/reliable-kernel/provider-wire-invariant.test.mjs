import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const root = process.cwd();
const require = createRequire(import.meta.url);
const {
  createTerminalValidatedFetch,
  LlmHttpStreamTerminationError
} = require(path.join(root, 'dist/extension/backend/capabilities/terminalValidatedFetch.js'));
const {
  summarizeLlmRawError
} = require(path.join(root, 'dist/extension/backend/capabilities/llmProvider.js'));
const unified = await import('unified-llm-provider');

function failingSse(error, terminal = false) {
  let sent = false;
  return new Response(new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new TextEncoder().encode(terminal
          ? 'data: [DONE]\n\n'
          : 'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}\n\n'));
      } else {
        controller.error(error);
      }
    }
  }), { headers: { 'content-type': 'text/event-stream' } });
}

test('SSE reader 的明确连接故障归一为截断并保留 cause', async () => {
  for (const error of [
    new TypeError('terminated'),
    Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
    new Error('read failed', { cause: Object.assign(new Error('peer reset'), { code: 'ECONNRESET' }) })
  ]) {
    const guarded = createTerminalValidatedFetch(async () => failingSse(error), 'gemini');
    const response = await guarded('https://provider.invalid');
    await assert.rejects(response.text(), (actual) =>
      actual instanceof LlmHttpStreamTerminationError
      && actual.code === 'LLM_STREAM_TRUNCATED'
      && actual.phase === 'response_body'
      && actual.cause === error
    );
  }
});

test('SSE reader 的取消、未知/解析错误及终态后的错误不转换为截断', async () => {
  for (const [error, terminal, abort, useRequest] of [
    [new DOMException('stopped', 'AbortError'), false, false, false],
    [new TypeError('terminated'), false, true, false],
    [new TypeError('terminated'), false, true, true],
    [new SyntaxError('invalid JSON'), false, false, false],
    [new Error('unknown failure'), false, false, false],
    [new TypeError('terminated'), true, false, false]
  ]) {
    const controller = new AbortController();
    const guarded = createTerminalValidatedFetch(async () => {
      if (abort) controller.abort();
      return failingSse(error, terminal);
    }, 'gemini');
    const response = useRequest
      ? await guarded(new Request('https://provider.invalid', { signal: controller.signal }))
      : await guarded('https://provider.invalid', { signal: controller.signal });
    await assert.rejects(response.text(), (actual) => actual === error);
  }
});

test('真实 SDK 的 SSE JSON 解析错误不因响应体封装变成截断', async () => {
  const provider = unified.createLLMFromConfig({
    provider: 'gemini', model: 'gemini-test', apiKey: 'offline-placeholder',
    baseUrl: 'https://provider.invalid/v1beta',
    fetch: createTerminalValidatedFetch(async () => new Response(
      'data: invalid-json\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    ), 'gemini')
  }, unified.createBootstrapExtensionRegistry().llmProviders);
  const chunks = [];
  for await (const chunk of provider.chatStream({
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }]
  }, { inputFormat: 'unified', outputFormat: 'unified' })) chunks.push(chunk);
  assert.equal(chunks.find((chunk) => chunk.error)?.error.kind, 'stream_parse_error');
  assert.doesNotMatch(JSON.stringify(chunks), /LLM_STREAM_TRUNCATED/);
});

const callId = 'super-secret-call-id';
const privateOutput = 'private-output-do-not-log';
// 官方 DeepSeek / MiMo 接口在 OpenAI 兼容渠道里交给接入库的 DeepSeek 格式编码，校验仍按 OpenAI 兼容的 wire 形状。
const providers = [
  ['openai-compatible', 'openai-compatible'],
  ['openai-compatible', 'deepseek'],
  ['openai-responses', 'openai-responses'],
  ['claude', 'claude'],
  ['gemini', 'gemini']
];

function unifiedToolExchange() {
  return {
    contents: [
      {
        role: 'model',
        parts: [{ functionCall: { name: 'edit', args: { path: 'secret.txt' }, callId } }]
      },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'edit', response: { output: privateOutput }, callId } }]
      }
    ]
  };
}

async function captureProviderWire(providerKind, libraryKind) {
  let bodyText;
  let returnedResponse;
  const traces = [];
  const remoteField = providerKind === 'openai-compatible'
    ? 'tool_call_id'
    : providerKind === 'openai-responses'
      ? 'call_id'
      : providerKind === 'claude'
        ? 'tool_use_id'
        : 'functionResponse.name';
  const baseFetch = async (_input, init) => {
    bodyText = String(init.body);
    returnedResponse = new Response(JSON.stringify({
      error: { message: `missing required field ${remoteField}` }
    }), {
      status: 422,
      headers: { 'content-type': 'application/json' }
    });
    return returnedResponse;
  };
  const guardedFetch = createTerminalValidatedFetch(baseFetch, providerKind, {
    onWireInvariantTrace: (trace) => traces.push(trace)
  });
  const registry = unified.createBootstrapExtensionRegistry();
  const provider = unified.createLLMFromConfig({
    provider: libraryKind,
    model: providerKind === 'gemini' ? 'gemini-2.5-flash' : 'test-model',
    apiKey: 'super-secret-api-key',
    baseUrl: 'https://provider.invalid/v1',
    fetch: guardedFetch
  }, registry.llmProviders);
  const result = await provider.chat(unifiedToolExchange(), {
    inputFormat: 'unified',
    outputFormat: 'unified'
  });
  return { bodyText, body: JSON.parse(bodyText), result, traces };
}

function assertWireToolResult(providerKind, body) {
  if (providerKind === 'openai-compatible') {
    const item = body.messages.find((message) => message.role === 'tool');
    assert.equal(item.tool_call_id, callId);
    return;
  }
  if (providerKind === 'openai-responses') {
    const item = body.input.find((entry) => entry.type === 'function_call_output');
    assert.equal(item.call_id, callId);
    return;
  }
  if (providerKind === 'claude') {
    const item = body.messages.flatMap((message) => message.content)
      .find((entry) => entry.type === 'tool_result');
    assert.equal(item.tool_use_id, callId);
    return;
  }
  const item = body.contents.flatMap((content) => content.parts)
    .find((part) => part.functionResponse)?.functionResponse;
  assert.equal(item.id, callId);
  assert.equal(item.name, 'edit');
}

for (const [providerKind, libraryKind] of providers) {
  test(`${providerKind}（接入库 ${libraryKind} 格式）final fetch validates its actual wire tool-result shape and emits only safe evidence`, async () => {
    const captured = await captureProviderWire(providerKind, libraryKind);
    assertWireToolResult(providerKind, captured.body);
    assert.equal(captured.traces.length, 1);
    const trace = captured.traces[0];
    assert.equal('provider' in trace, false);
    assert.equal(
      trace.bodySha256,
      createHash('sha256').update(Buffer.from(captured.bodyText, 'utf8')).digest('hex')
    );
    assert.equal(trace.messageCount, 2);
    assert.equal(trace.toolItems.length, 1);
    assert.match(trace.toolItems[0].index, /^(?:messages|input|contents)\[/);
    assert.equal(trace.toolItems[0].idSha256, createHash('sha256').update(callId).digest('hex'));

    const serializedTrace = JSON.stringify(trace);
    assert.doesNotMatch(serializedTrace, new RegExp(callId));
    assert.doesNotMatch(serializedTrace, new RegExp(privateOutput));
    assert.doesNotMatch(serializedTrace, /api.?key|authorization|headers/i);

    const error = captured.result.error;
    assert.ok(error, 'the synthetic 422 response must remain a provider error');
    const summary = summarizeLlmRawError(error);
    assert.match(summary, /local wire invariant passed/i);
    assert.match(summary, new RegExp(trace.bodySha256));
  });
}

test('required provider-specific IDs fail closed before fetch', async () => {
  const invalidBodies = [
    ['openai-compatible', { messages: [{ role: 'tool', content: 'x' }] }],
    ['openai-compatible', { messages: [{ role: 'tool', content: [{ type: 'text', text: 'x' }] }] }],
    ['openai-responses', { input: [{ type: 'function_call_output', output: 'x' }] }],
    ['claude', { messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }] }]
  ];
  for (const [providerKind, body] of invalidBodies) {
    let fetchCalls = 0;
    const guarded = createTerminalValidatedFetch(async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    }, providerKind);
    await assert.rejects(
      guarded('https://provider.invalid', { method: 'POST', body: JSON.stringify(body) }),
      /wire invariant.*(?:tool_call_id|call_id|tool_use_id)/i
    );
    assert.equal(fetchCalls, 0, `${providerKind} malformed wire body reached fetch`);
  }
});

test('Gemini validates functionResponse protocol without inventing an OpenAI ID requirement', async () => {
  let fetchCalls = 0;
  const traces = [];
  const guarded = createTerminalValidatedFetch(async () => {
    fetchCalls += 1;
    return new Response('{}', { status: 400 });
  }, 'gemini', { onWireInvariantTrace: (trace) => traces.push(trace) });
  const body = {
    contents: [{ role: 'user', parts: [{ functionResponse: { name: 'edit', response: { ok: true } } }] }]
  };
  await guarded('https://provider.invalid', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(fetchCalls, 1);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].toolItems[0].idSha256, undefined);

  const malformed = {
    contents: [{ role: 'user', parts: [{ functionResponse: { response: { ok: true } } }] }]
  };
  await assert.rejects(
    guarded('https://provider.invalid', { method: 'POST', body: JSON.stringify(malformed) }),
    /Gemini.*functionResponse\.name/i
  );
  assert.equal(fetchCalls, 1);
});
