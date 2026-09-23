import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { dryRunLlmProvider, startLlmProvider } from '../../dist/extension/backend/capabilities/llmProvider.js';
import {
  applyClaudeThinkingBinding,
  claudeThinkingBindingModeForError
} from '../../dist/extension/backend/capabilities/claudeThinkingAdaptation.js';
import {
  learnedProviderRequestAdaptations,
  resetProviderRequestAdaptations
} from '../../dist/extension/backend/capabilities/providerParameterAdaptation.js';

// https://platform.claude.com/docs/en/build-with-claude/preserved-thinking 原文。
const BINDING_BETA = 'thinking-binding-controls-2026-08-01';
const PREFIX_MISMATCH_400 = {
  type: 'error',
  error: {
    type: 'invalid_request_error',
    message: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. '
      + 'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". '
      + 'That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header. '
      + 'The `system` prompt differs from when the block was created.'
  }
};
const BLOCK_BINDING_REJECTED_400 = {
  type: 'error',
  error: { type: 'invalid_request_error', message: 'thinking.adaptive.block_binding: Extra inputs are not permitted' }
};
const TAMPERED_SIGNATURE_400 = {
  type: 'error',
  error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block' }
};

test('C2 匹配：只有前缀失配原文触发 drop_block；网关拒绝 block_binding 才退回去掉思考块', () => {
  const mismatch = JSON.stringify(PREFIX_MISMATCH_400);
  assert.equal(claudeThinkingBindingModeForError(mismatch, undefined), 'drop_block');
  assert.equal(claudeThinkingBindingModeForError(mismatch, 'drop_block'), 'drop_block');
  assert.equal(claudeThinkingBindingModeForError(mismatch, 'strip_thinking'), 'strip_thinking', '去掉后不能再放回');
  assert.equal(claudeThinkingBindingModeForError(JSON.stringify(TAMPERED_SIGNATURE_400), undefined), undefined,
    '签名本身无效时 prefix_mismatch_behavior 不适用');
  const rejected = JSON.stringify(BLOCK_BINDING_REJECTED_400);
  assert.equal(claudeThinkingBindingModeForError(rejected, 'drop_block'), 'strip_thinking');
  assert.equal(claudeThinkingBindingModeForError(rejected, undefined), undefined, '没发过 block_binding 时不接管用户自己的配置');
  assert.equal(claudeThinkingBindingModeForError('`thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified', undefined), undefined);
});

test('C2 请求改写：drop_block 带 beta 头与 block_binding；strip_thinking 去掉全部思考块且不带 block_binding', () => {
  const body = {
    model: 'claude-opus-5-5', max_tokens: 1000, thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
    messages: [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's1' }, { type: 'redacted_thinking', data: 'r1' }, { type: 'text', text: 'a1' }] },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'only thinking', signature: 's2' }] },
      { role: 'user', content: [{ type: 'text', text: 'q3' }] }
    ]
  };
  const snapshot = structuredClone(body);
  const headers = { 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'Anthropic-Beta': 'compact-2026-09-04' };
  const dropped = applyClaudeThinkingBinding({ body, headers }, 'drop_block');
  assert.deepEqual(dropped.body.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });
  assert.deepEqual(dropped.body.messages, body.messages, 'drop_block 由 API 丢弃失配块，本地不改历史');
  assert.deepEqual(dropped.headers, { 'x-api-key': 'k', 'anthropic-version': '2023-06-01', 'anthropic-beta': `compact-2026-09-04,${BINDING_BETA}` });
  // 不带 thinking 时这些模型默认就是 adaptive；显式写出等价于省略。
  const { thinking: _thinking, ...withoutThinking } = body;
  assert.deepEqual(applyClaudeThinkingBinding({ body: withoutThinking, headers: {} }, 'drop_block').body.thinking,
    { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } });

  const stripped = applyClaudeThinkingBinding({ body: dropped.body, headers }, 'strip_thinking');
  assert.equal(stripped.headers, headers, 'strip 模式不再发送 beta 头');
  assert.deepEqual(stripped.body.thinking, { type: 'adaptive' });
  assert.deepEqual(stripped.body.messages, [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
    { role: 'user', content: 'q2' },
    { role: 'user', content: [{ type: 'text', text: 'q3' }] }
  ]);
  assert.deepEqual(body, snapshot, '原请求体不能被原地修改');
});

const CLAUDE_OK_STREAM = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-opus-5-5', stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PONG' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
  ['message_stop', { type: 'message_stop' }]
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

async function withServer(respond, run) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
    calls.push(call);
    const result = respond(call);
    res.writeHead(result.status ?? 200, { 'content-type': result.sse ? 'text/event-stream' : 'application/json' });
    res.end(result.sse ?? JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/v1`, calls);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function claudeSettings(baseUrl, overrides = {}) {
  return {
    id: 'claude-binding', name: 'Claude', provider: 'claude', baseUrl, model: 'claude-opus-5-5', models: [],
    apiKey: 'dummy-test-key', toolCallFormat: 'function-call', openaiResponsesTransport: 'http', stream: true,
    retryOnError: false, retryMaxAttempts: 0, retryDelaySeconds: 0, enableMultimodalTools: true, systemPromptPrefix: '',
    promptCache: { enabled: false, mode: 'explicit', ttl: '5m' }, modelConfigs: [], createdAt: 1, updatedAt: 1,
    generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
    ...overrides
  };
}

const HISTORY = [
  { role: 'user', parts: [{ text: 'first question' }] },
  { role: 'model', parts: [{ text: '', thought: true, thoughtSignature: 'claude:signed-block-1' }, { text: 'first answer' }] },
  { role: 'user', parts: [{ text: 'second question' }] }
];

const hasThinkingBlock = (body) => body.messages.some((message) => Array.isArray(message.content)
  && message.content.some((block) => block.type === 'thinking' || block.type === 'redacted_thinking'));

async function chat(settings, id) {
  const events = [];
  await startLlmProvider({ id, conversationId: 'claude-binding-conversation', contents: HISTORY, tools: [] }, (event) => events.push(event), { settings: async () => settings });
  return events;
}

test('C2 官方端点：前缀失配 400 后带 beta 头与 drop_block 重试一次，并记住这个选择', async () => {
  resetProviderRequestAdaptations();
  await withServer((call) => call.body.thinking?.block_binding?.prefix_mismatch_behavior === 'drop_block'
    && String(call.headers['anthropic-beta'] ?? '').split(',').includes(BINDING_BETA)
    ? { sse: CLAUDE_OK_STREAM }
    : { status: 400, body: PREFIX_MISMATCH_400 }, async (baseUrl, calls) => {
    const settings = claudeSettings(baseUrl);
    const events = await chat(settings, 'binding-1');
    assert.ok(events.some((event) => event.type === 'llm:done'), JSON.stringify(events.filter((event) => event.type === 'llm:error')));
    assert.equal(events.some((event) => event.type.startsWith('llm:retry')), false);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].headers['anthropic-beta'], undefined);
    assert.equal(calls[0].body.thinking.block_binding, undefined);
    assert.ok(hasThinkingBlock(calls[1].body), 'drop_block 模式保留思考块，由 API 决定丢弃哪些');
    // 除 thinking.block_binding 外请求体不变。
    const { thinking: firstThinking, ...firstRest } = calls[0].body;
    const { thinking: secondThinking, ...secondRest } = calls[1].body;
    assert.deepEqual(secondRest, firstRest);
    assert.deepEqual(secondThinking, { ...firstThinking, block_binding: { prefix_mismatch_behavior: 'drop_block' } });
    assert.equal(learnedProviderRequestAdaptations({ providerConfigId: settings.id, provider: 'claude', baseUrl, model: settings.model }).claudeThinkingBinding, 'drop_block');

    await chat(settings, 'binding-2');
    assert.equal(calls.length, 3, '之后的请求一开始就带上 drop_block');
    assert.equal(calls[2].body.thinking.block_binding.prefix_mismatch_behavior, 'drop_block');
  });
  resetProviderRequestAdaptations();
});

test('C2 网关不转发 beta 头：退回去掉全部思考块并一直保持去掉', async () => {
  resetProviderRequestAdaptations();
  await withServer((call) => {
    if (call.body.thinking?.block_binding) return { status: 400, body: BLOCK_BINDING_REJECTED_400 };
    if (hasThinkingBlock(call.body)) return { status: 400, body: PREFIX_MISMATCH_400 };
    return { sse: CLAUDE_OK_STREAM };
  }, async (baseUrl, calls) => {
    const settings = claudeSettings(baseUrl, { id: 'claude-binding-gateway' });
    const events = await chat(settings, 'gateway-1');
    assert.ok(events.some((event) => event.type === 'llm:done'), JSON.stringify(events.filter((event) => event.type === 'llm:error')));
    assert.equal(calls.length, 3);
    assert.ok(hasThinkingBlock(calls[0].body));
    assert.ok(calls[1].body.thinking.block_binding);
    assert.equal(hasThinkingBlock(calls[2].body), false);
    assert.equal(calls[2].body.thinking.block_binding, undefined);
    assert.equal(String(calls[2].headers['anthropic-beta'] ?? '').includes(BINDING_BETA), false);
    assert.deepEqual(calls[2].body.messages[1], { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] });

    await chat(settings, 'gateway-2');
    assert.equal(calls.length, 4);
    assert.equal(hasThinkingBlock(calls[3].body), false, '去掉的思考块不能中途放回');

    const dry = await dryRunLlmProvider({ id: 'dry', conversationId: 'claude-binding-conversation', contents: HISTORY, tools: [] }, { settings: async () => settings });
    assert.equal(hasThinkingBlock(dry.body), false);
  });
  resetProviderRequestAdaptations();
});

test('C2 不相关的 Claude 400 与其他渠道保持原样', async () => {
  resetProviderRequestAdaptations();
  await withServer(() => ({ status: 400, body: TAMPERED_SIGNATURE_400 }), async (baseUrl, calls) => {
    const events = await chat(claudeSettings(baseUrl, { id: 'claude-binding-tampered' }), 'tampered');
    assert.equal(calls.length, 1);
    assert.ok(events.some((event) => event.type === 'llm:error'));
  });
  resetProviderRequestAdaptations();
});

test('C2 原生压缩路径：前缀失配同样立即以 drop_block 重试', async () => {
  resetProviderRequestAdaptations();
  const { createLlmProviderCapability } = await import('../../dist/extension/backend/capabilities/llmProvider.js');
  const signed = { type: 'compaction', content: 'SUMMARY_MARKER', signature: 'signed-compaction' };
  await withServer((call) => call.body.thinking?.block_binding?.prefix_mismatch_behavior === 'drop_block'
    ? { body: { id: 'msg_c', type: 'message', role: 'assistant', content: [signed], stop_reason: 'compaction', usage: { iterations: [{ input_tokens: 10, output_tokens: 5 }] } } }
    : { status: 400, body: PREFIX_MISMATCH_400 }, async (baseUrl, calls) => {
    const settings = claudeSettings(baseUrl, { id: 'claude-binding-compaction', stream: false });
    const capability = createLlmProviderCapability({ settings: async () => settings, compressionSettings: async () => undefined });
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('compaction timed out')), 10_000);
        capability.compact({
          id: 'compaction-request', blockId: 'compaction-block', conversationId: 'claude-binding-conversation', methodKind: 'provider_native',
          methodConfigSnapshot: { id: 'native', name: 'Native', kind: 'provider_native', trigger: { mode: 'manual' }, llmSummary: { targetTokens: 1000 }, createdAt: 1, updatedAt: 1 },
          contents: HISTORY, nativeGenerationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'high' } }, nativeRequestBody: {}, tools: []
        }, (event) => {
          if (event.type !== 'llm:compactDone' && event.type !== 'llm:compactError') return;
          clearTimeout(timer);
          resolve(event);
        });
      });
      assert.equal(result.type, 'llm:compactDone', JSON.stringify(result.payload));
      assert.equal(calls.length, 2);
      assert.match(calls[1].headers['anthropic-beta'], new RegExp(BINDING_BETA));
      assert.match(calls[1].headers['anthropic-beta'], /compact-2026-09-04/);
      assert.deepEqual(result.payload.result.contents[0].parts[0].providerContext.rawItem, signed);
    } finally {
      capability.dispose();
    }
  });
  resetProviderRequestAdaptations();
});
