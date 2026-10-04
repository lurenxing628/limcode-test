import assert from 'node:assert/strict';
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
// 官方 DeepSeek / MiMo 接口在 OpenAI 兼容渠道里交给接入库的 DeepSeek 格式编码。
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

async function captureProviderWire(providerKind, libraryKind, guarded = true) {
  let bodyText;
  let requestHeaders;
  const remoteField = providerKind === 'openai-compatible'
    ? 'tool_call_id'
    : providerKind === 'openai-responses'
      ? 'call_id'
      : providerKind === 'claude'
        ? 'tool_use_id'
        : 'functionResponse.name';
  const baseFetch = async (_input, init) => {
    bodyText = String(init.body);
    requestHeaders = [...new Headers(init.headers)];
    return new Response(JSON.stringify({
      error: { message: `missing required field ${remoteField}` }
    }), {
      status: 422,
      headers: { 'content-type': 'application/json' }
    });
  };
  const providerFetch = guarded ? createTerminalValidatedFetch(baseFetch, providerKind) : baseFetch;
  const registry = unified.createBootstrapExtensionRegistry();
  const provider = unified.createLLMFromConfig({
    provider: libraryKind,
    model: providerKind === 'gemini' ? 'gemini-2.5-flash' : 'test-model',
    apiKey: 'super-secret-api-key',
    baseUrl: 'https://provider.invalid/v1',
    fetch: providerFetch
  }, registry.llmProviders);
  const result = await provider.chat(unifiedToolExchange(), {
    inputFormat: 'unified',
    outputFormat: 'unified'
  });
  return { bodyText, body: JSON.parse(bodyText), requestHeaders, result, remoteField };
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
  test(`${providerKind}（接入库 ${libraryKind} 格式）transport preserves encoded tool-result bytes and provider errors`, async () => {
    const captured = await captureProviderWire(providerKind, libraryKind);
    const direct = await captureProviderWire(providerKind, libraryKind, false);
    assertWireToolResult(providerKind, captured.body);
    assert.equal(captured.bodyText, direct.bodyText);
    assert.deepEqual(captured.requestHeaders, direct.requestHeaders);

    const error = captured.result.error;
    assert.ok(error, 'the synthetic 422 response must remain a provider error');
    assert.equal(summarizeLlmRawError(error), summarizeLlmRawError(direct.result.error));
    assert.match(summarizeLlmRawError(error), new RegExp(`missing required field ${captured.remoteField}`));
    assert.doesNotMatch(JSON.stringify(error), /x-limcode-wire-invariant|body_sha256|bodySha256/);
  });
}

test('terminal evidence comes only from each provider protocol envelope, never tool/content fields', async () => {
  const valid = {
    'openai-compatible': { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    gemini: { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] },
    claude: { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    'openai-responses': { type: 'response.completed', response: { status: 'completed' } }
  };
  const falseEvidence = [
    { finishReason: 'arbitrary' }, { finish_reason: 'arbitrary' }, { stop_reason: 'arbitrary' },
    { type: 'message_stop' }, { type: 'response.completed' }, { response: { status: 'completed' } }
  ];
  const content = (provider, data) => provider === 'gemini'
    ? { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'save_record', args: data } }] } }] }
    : provider === 'openai-compatible'
      ? { choices: [{ delta: { content: JSON.stringify(data) }, finish_reason: null }], metadata: data }
      : provider === 'claude'
        ? { type: 'content_block_start', content_block: { type: 'tool_use', id: 'call', name: 'save_record', input: data } }
        : { type: 'response.output_item.added', item: { type: 'function_call', name: 'save_record', arguments: JSON.stringify(data), metadata: data } };
  for (const provider of Object.keys(valid)) {
    const guarded = (chunks) => createTerminalValidatedFetch(async () => new Response(
      chunks.map(data => `data: ${JSON.stringify(data)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } }
    ), provider)('https://fixture.invalid');
    await (await guarded([valid[provider]])).text();
    for (const evidence of falseEvidence) {
      await assert.rejects((await guarded([content(provider, evidence)])).text(),
        error => error.code === 'LLM_STREAM_TRUNCATED', `${provider}: ${JSON.stringify(evidence)}`);
      await (await guarded([content(provider, evidence), valid[provider]])).text();
    }
  }
});

test('named Responses terminals still report status and usage to the empty-output guard', async () => {
  for (const status of ['completed', 'incomplete']) {
    const terminals = [];
    const value = { type: `response.${status}`, response: { status,
      incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
      usage: { output_tokens: 256, output_tokens_details: { reasoning_tokens: 256 } } } };
    const body = `event: response.${status}\ndata: ${JSON.stringify(value)}\n\n`;
    const guarded = createTerminalValidatedFetch(async () => new Response(body,
      { headers: { 'content-type': 'text/event-stream' } }), 'openai-responses', {
      onResponsesTerminal: terminal => terminals.push(terminal)
    });
    assert.equal(await (await guarded('https://fixture.invalid')).text(), body);
    assert.deepEqual(terminals, [{ status, ...(status === 'incomplete' ? { reason: 'max_output_tokens' } : {}), usage: value.response.usage }]);
  }
});
