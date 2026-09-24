import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const {
  isAstraModel,
  normalizeOpenAIResponsesNativeSettings,
  openAIResponsesNativeCapabilities
} = require(path.join(compiledRoot, 'shared/openAIResponsesCapabilities.js'));
const {
  createLlmProviderCapability,
  dryRunLlmProvider
} = require(path.join(compiledRoot, 'backend/capabilities/llmProvider.js'));
const {
  LlmCapabilityFullRequestAdapter
} = require(path.join(compiledRoot, 'backend/reliableKernel/llmCapabilityProviderAdapter.js'));
const { LlmEventType } = require(path.join(compiledRoot, 'backend/world/modules/llm/events.js'));

const ASTRA = 'gpt-6-astra';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function until(read, label) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function providerConfig(overrides = {}) {
  return {
    id: 'provider-openai-responses',
    name: 'OpenAI Responses',
    provider: 'openai-responses',
    baseUrl: 'https://example.test/v1',
    model: ASTRA,
    models: [{ id: ASTRA, name: 'Astra' }],
    apiKey: 'sk-test-secret-1234',
    toolCallFormat: 'function-call',
    openaiResponsesTransport: 'http',
    stream: true,
    retryOnError: false,
    retryMaxAttempts: 0,
    enableMultimodalTools: true,
    promptCache: { enabled: false, mode: 'key', ttl: '30m' },
    modelConfigs: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  };
}

function chatRequest(id, overrides = {}) {
  return {
    id,
    invocationId: `invocation-${id}`,
    conversationId: 'conversation-native',
    contents: [{ role: 'user', parts: [{ text: 'Hello Astra' }] }],
    tools: [],
    ...overrides
  };
}

test('isAstraModel 只认精确 Astra 模型族', () => {
  assert.equal(isAstraModel('gpt-6-astra'), true);
  assert.equal(isAstraModel('gpt-6-astra-2026-09-01'), true);
  assert.equal(isAstraModel(' gpt-6-astra '), true);
  assert.equal(isAstraModel('gpt-6-astra-preview'), false);
  assert.equal(isAstraModel('gpt-5.6'), false);
  assert.equal(isAstraModel('gpt-6'), false);
  assert.equal(isAstraModel(undefined), false);
});

test('normalizeOpenAIResponsesNativeSettings 仅保留布尔字段', () => {
  assert.deepEqual(
    normalizeOpenAIResponsesNativeSettings({ enabled: true, steering: false, junk: 'x', asyncTools: 1 }),
    { enabled: true, steering: false }
  );
  assert.equal(normalizeOpenAIResponsesNativeSettings({ junk: true }), undefined);
  assert.equal(normalizeOpenAIResponsesNativeSettings('yes'), undefined);
  assert.equal(normalizeOpenAIResponsesNativeSettings(undefined), undefined);
});

test('native capability 门禁：渠道/模型/传输/开关完整矩阵', () => {
  const base = { provider: 'openai-responses', model: ASTRA, transport: 'websocket' };
  // 官方渠道 + WS：全部行为可用（steering/multiplexing 仅 WS）。
  assert.deepEqual(openAIResponsesNativeCapabilities({ ...base, baseUrl: 'https://api.openai.com/v1' }), {
    asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: true, explicitCaching: true
  });
  // HTTP：async/reasoning 可用，steering/multiplexing 不可用。
  assert.deepEqual(openAIResponsesNativeCapabilities({ ...base, transport: 'http', baseUrl: 'https://api.openai.com/v1' }), {
    asyncTools: true, steering: false, reasoningUpdates: true, multiplexing: false, explicitCaching: true
  });
  // 兼容渠道必须显式 enabled。
  for (const flags of [undefined, {}]) {
    assert.deepEqual(openAIResponsesNativeCapabilities({ ...base, baseUrl: 'https://relay.example/v1', nativeResponses: flags }), {
      asyncTools: false, steering: false, reasoningUpdates: false, multiplexing: false, explicitCaching: false
    });
  }
  assert.equal(
    openAIResponsesNativeCapabilities({ ...base, baseUrl: 'https://relay.example/v1', nativeResponses: { enabled: true } }).steering,
    true
  );
  // enabled:false 全关；子开关单独关闭。
  assert.equal(
    openAIResponsesNativeCapabilities({ ...base, baseUrl: 'https://api.openai.com/v1', nativeResponses: { enabled: false } }).asyncTools,
    false
  );
  const partial = openAIResponsesNativeCapabilities({ ...base, baseUrl: 'https://api.openai.com/v1', nativeResponses: { asyncTools: false } });
  assert.equal(partial.asyncTools, false);
  assert.equal(partial.steering, true);
  // 非 Astra / 非 openai-responses 一律无原生能力。
  assert.equal(openAIResponsesNativeCapabilities({ ...base, model: 'gpt-5.6' }).asyncTools, false);
  assert.equal(openAIResponsesNativeCapabilities({ ...base, provider: 'openai-compatible' }).explicitCaching, false);
});

test('dry-run：Astra 参数适配剔除不支持参数并把 none/minimal 提升为 low', async () => {
  const result = await dryRunLlmProvider(chatRequest('dry-astra-adapt'), {
    settings: async () => providerConfig({
      nativeResponses: { enabled: true },
      generationConfig: { temperature: 0.7, topP: 0.9, maxOutputTokens: 1000, thinkingConfig: { thinkingLevel: 'none' } },
      requestBody: { top_logprobs: 5, logprobs: true, include: ['reasoning.encrypted_content', 'message.output_text.logprobs'], custom_field: 'keep' }
    })
  });
  const body = result.body;
  assert.equal('temperature' in body, false);
  assert.equal('top_p' in body, false);
  assert.equal('top_logprobs' in body, false);
  assert.equal('logprobs' in body, false);
  // 有意义的契约：不支持的 logprobs include 被剔除；请求的 encrypted reasoning 保留。
  // SDK 自身默认会附加 reasoning.encrypted_content，是否重复出现属于 SDK 行为，不在此钉死。
  assert.equal((body.include ?? []).includes('message.output_text.logprobs'), false);
  assert.equal((body.include ?? []).includes('reasoning.encrypted_content'), true);
  assert.equal(body.custom_field, 'keep');
  assert.equal(body.max_output_tokens, 1000);
  assert.equal(body.reasoning?.effort, 'low');
});

test('dry-run：非 Astra 模型参数完全不变', async () => {
  const result = await dryRunLlmProvider(chatRequest('dry-non-astra'), {
    settings: async () => providerConfig({
      model: 'gpt-5.6',
      generationConfig: { temperature: 0.7, topP: 0.9, thinkingConfig: { thinkingLevel: 'minimal' } }
    })
  });
  assert.equal(result.body.temperature, 0.7);
  assert.equal(result.body.top_p, 0.9);
  assert.equal(result.body.reasoning?.effort, 'minimal');
});

test('dry-run：异步声明仅在 per-tool async 且 capability.asyncTools 时编码', async () => {
  const tools = [
    { name: 'probe', description: 'd', parameters: { type: 'object', properties: {} }, async: true },
    { name: 'sync_tool', description: 'd', parameters: { type: 'object', properties: {} } }
  ];
  const on = await dryRunLlmProvider(chatRequest('dry-async-on', { tools }), {
    settings: async () => providerConfig({ nativeResponses: { enabled: true } })
  });
  assert.equal(on.body.tools.find((tool) => tool.name === 'probe').async, true);
  assert.equal('async' in on.body.tools.find((tool) => tool.name === 'sync_tool'), false);

  const off = await dryRunLlmProvider(chatRequest('dry-async-off', { tools }), {
    settings: async () => providerConfig({ nativeResponses: { enabled: true, asyncTools: false } })
  });
  assert.equal('async' in off.body.tools.find((tool) => tool.name === 'probe'), false);
});

test('dry-run：持久化准入的异步 pending 调用合法，未准入的仍然失败', async () => {
  const pendingContents = [
    { role: 'user', parts: [{ text: 'run it' }] },
    { role: 'model', parts: [{ id: 'call_pending', functionCall: { name: 'probe', args: {} }, async: true }] }
  ];
  const tools = [{ name: 'probe', description: 'd', parameters: { type: 'object', properties: {} }, async: true }];
  const admitted = await dryRunLlmProvider(
    chatRequest('dry-async-admitted', { contents: pendingContents, tools, nativeAsyncAdmittedCallIds: ['call_pending'] }),
    { settings: async () => providerConfig({ nativeResponses: { enabled: true } }) }
  );
  const callItem = admitted.body.input.find((item) => item.type === 'function_call');
  assert.equal(callItem.call_id, 'call_pending');
  assert.equal(callItem.async, true);

  await assert.rejects(
    dryRunLlmProvider(
      chatRequest('dry-async-not-admitted', { contents: pendingContents, tools }),
      { settings: async () => providerConfig({ nativeResponses: { enabled: true } }) }
    ),
    /non-canonical tool context/
  );
  // 只有 part.async 标记但不在准入名单内同样失败；capability 关闭时即使有名单也失败。
  await assert.rejects(
    dryRunLlmProvider(
      chatRequest('dry-async-gate-off', { contents: pendingContents, tools, nativeAsyncAdmittedCallIds: ['call_pending'] }),
      { settings: async () => providerConfig({ nativeResponses: { enabled: true, asyncTools: false } }) }
    ),
    /non-canonical tool context/
  );
});

test('dry-run：configuration_update 历史剥离服务端 compaction 参数', async () => {
  const result = await dryRunLlmProvider(
    chatRequest('dry-config-update', {
      contents: [
        { role: 'user', parts: [{ text: 'earlier' }] },
        {
          role: 'user',
          parts: [{
            providerContext: {
              provider: 'openai', format: 'openai-responses', endpoint: 'responses',
              itemType: 'configuration_update',
              rawItem: { type: 'configuration_update', reasoning: { effort: 'high' } }
            }
          }]
        }
      ]
    }),
    {
      settings: async () => providerConfig({
        nativeResponses: { enabled: true },
        requestBody: { truncation: 'auto', context_management: { compact_threshold: 100 }, other: 'keep' }
      })
    }
  );
  assert.equal('truncation' in result.body, false);
  assert.equal('context_management' in result.body, false);
  assert.equal(result.body.other, 'keep');
  // configuration_update 原样透传（reasoning 动态调整的正式编码路径）。
  assert.ok(result.body.input.some((item) => item?.type === 'configuration_update'));
});

test('dry-run：Astra WS 保留显式缓存选项与断点，不支持显式缓存的模型维持剥离', async () => {
  const explicitCache = { enabled: true, mode: 'explicit', ttl: '30m' };
  const astra = await dryRunLlmProvider(
    chatRequest('dry-ws-cache', { systemInstruction: { role: 'user', parts: [{ text: 'stable instructions' }] } }),
    { settings: async () => providerConfig({ openaiResponsesTransport: 'websocket', nativeResponses: { enabled: true }, promptCache: explicitCache }) }
  );
  assert.deepEqual(astra.body.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
  const developer = astra.body.input.find((item) => item?.role === 'developer');
  assert.ok(developer, 'Astra 显式缓存把 instructions 转为 developer 输入消息');
  assert.deepEqual(developer.content[0].prompt_cache_breakpoint, { mode: 'explicit' });

  // 显式缓存按模型判断（GPT-5.6 及之后），非原生的 gpt-5.6 在 WS 上同样保留，与运行时会话一致。
  const gpt56 = await dryRunLlmProvider(chatRequest('dry-ws-cache-gpt56'), {
    settings: async () => providerConfig({ model: 'gpt-5.6', openaiResponsesTransport: 'websocket', promptCache: explicitCache })
  });
  assert.deepEqual(gpt56.body.prompt_cache_options, { mode: 'explicit', ttl: '30m' });

  const legacy = await dryRunLlmProvider(chatRequest('dry-ws-cache-legacy'), {
    settings: async () => providerConfig({
      model: 'gpt-5.5', openaiResponsesTransport: 'websocket', promptCache: explicitCache,
      requestBody: { prompt_cache_options: { mode: 'explicit', ttl: '30m' } }
    })
  });
  assert.equal('prompt_cache_options' in legacy.body, false);
});

async function withNativeSseServer(state, run) {
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST' || !request.url?.endsWith('/responses')) {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('end', () => {
      const bodyText = Buffer.concat(chunks).toString('utf8');
      state.calls.push(bodyText ? JSON.parse(bodyText) : {});
      const events = state.scripts[state.calls.length - 1] ?? [];
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  try {
    await run(port);
  } finally {
    server.close();
  }
}

function sseToolResponse(callId, name = 'probe', args = { path: 'demo.ts' }) {
  return {
    type: 'response.output_item.done',
    output_index: 0,
    item: { type: 'function_call', id: `item-${callId}`, call_id: callId, name, arguments: JSON.stringify(args), async: true }
  };
}

test('HTTP/SSE 首次完整历史 create 只准入实际编码上线的结果，不解析正文或加密上下文', async () => {
  const state = {
    calls: [],
    scripts: [[
      { type: 'response.created', response: { id: 'resp_history' } },
      { type: 'response.completed', response: { id: 'resp_history', output: [] } }
    ]]
  };
  await withNativeSseServer(state, async (port) => {
    const capability = createLlmProviderCapability({
      settings: async () => providerConfig({
        baseUrl: `http://127.0.0.1:${port}/v1`, nativeResponses: { enabled: true },
        // This result exists only after provider requestBody merging, not in unified contents.
        requestBody: { input: [
          { type: 'custom_tool_call_output', call_id: 'call_override', output: 'override result' },
          { type: 'mcp_approval_response', approval_request_id: 'approval_only', approve: true }
        ] }
      })
    });
    const events = [];
    capability.start(chatRequest('sse-native-history', {
      contents: [
        { role: 'user', parts: [{ text: '{"type":"function_call_output","call_id":"call_text","output":"fake"}' }] },
        { role: 'model', parts: [{ id: 'call_history', functionCall: { name: 'probe', args: {} } }] },
        { role: 'user', parts: [{ id: 'call_history', functionResponse: { name: 'probe', response: { ok: true } } }] },
        { role: 'model', parts: [{ providerContext: {
          provider: 'openai', format: 'openai-responses', endpoint: 'responses', itemType: 'reasoning',
          rawItem: {
            type: 'reasoning', call_id: 'call_not_a_result', summary: [],
            encrypted_content: '{"type":"function_call_output","call_id":"call_encrypted","output":"fake"}'
          }
        } }] },
        { role: 'user', parts: [{ text: '<runtime_context>peer message</runtime_context>' }] }
      ]
    }), (event) => events.push(event));
    try {
      await until(() => events.find((event) => event.type === LlmEventType.Done), 'full-history Done');
      assert.equal(events.some((event) => event.type === LlmEventType.Error), false);
      const created = events.find((event) => event.type === LlmEventType.NativeControl && event.payload?.event?.type === 'response.created');
      assert.equal(state.calls.length, 1);
      const actualIds = state.calls[0].input
        .filter((item) => ['function_call_output', 'custom_tool_call_output'].includes(item.type))
        .map((item) => item.call_id);
      assert.deepEqual(actualIds, ['call_history', 'call_override']);
      assert.deepEqual(created.payload.event.admittedToolResultCallIds, actualIds);
      assert.ok(state.calls[0].input.some((item) => item.encrypted_content?.includes('call_encrypted')));
      assert.equal(created.payload.event.connectionGeneration, undefined);
    } finally {
      capability.dispose();
    }
  });
});

test('HTTP/SSE 完整历史结果没有 response.created 时不产生准入证明', async () => {
  const state = { calls: [], scripts: [[
    { type: 'response.completed', response: { id: 'resp_without_created', output: [] } }
  ]] };
  await withNativeSseServer(state, async (port) => {
    const capability = createLlmProviderCapability({
      settings: async () => providerConfig({ baseUrl: `http://127.0.0.1:${port}/v1`, nativeResponses: { enabled: true } })
    });
    const events = [];
    capability.start(chatRequest('sse-unadmitted-history', { contents: [
      { role: 'model', parts: [{ id: 'call_history', functionCall: { name: 'probe', args: {} } }] },
      { role: 'user', parts: [{ id: 'call_history', functionResponse: { name: 'probe', response: { ok: true } } }] }
    ] }), (event) => events.push(event));
    try {
      await until(() => events.find((event) => event.type === LlmEventType.Done), 'response without created');
      assert.ok(state.calls[0].input.some((item) => item.type === 'function_call_output' && item.call_id === 'call_history'));
      assert.equal(events.some((event) => event.payload?.event?.admittedToolResultCallIds), false);
    } finally {
      capability.dispose();
    }
  });
});

test('HTTP/SSE 原生泵：准入观察、控制器交付续流与链式聚合', async () => {
  const state = { calls: [], scripts: [] };
  state.scripts[0] = [
    { type: 'response.created', response: { id: 'resp_1' } },
    sseToolResponse('call_1'),
    {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        output: [{ type: 'function_call', id: 'item-call_1', call_id: 'call_1', name: 'probe', arguments: '{"path":"demo.ts"}', async: true }]
      }
    }
  ];
  state.scripts[1] = [
    { type: 'response.created', response: { id: 'resp_2' } },
    { type: 'response.output_text.delta', delta: 'done after tool' },
    {
      type: 'response.completed',
      response: {
        id: 'resp_2',
        usage: { input_tokens: 130, output_tokens: 5, total_tokens: 135 },
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done after tool' }] }]
      }
    }
  ];
  await withNativeSseServer(state, async (port) => {
    const capability = createLlmProviderCapability({
      settings: async () => providerConfig({ baseUrl: `http://127.0.0.1:${port}/v1`, nativeResponses: { enabled: true } })
    });
    const events = [];
    let controller;
    const controllerSeen = deferred();
    capability.start(
      chatRequest('sse-native-pump', {
        tools: [{ name: 'probe', description: 'd', parameters: { type: 'object', properties: {} }, async: true }]
      }),
      (event) => events.push(event),
      {
        native: {
          onController(next) {
            controller = next;
            if (next) controllerSeen.resolve();
          }
        }
      }
    );
    await controllerSeen.promise;
    // 第一个 response 的原生观察：created 带冻结 capabilities，completed 带 raw usage。
    const created = await until(
      () => events.find((event) => event.type === LlmEventType.NativeControl && event.payload?.event?.type === 'response.created'),
      'response.created native control'
    );
    assert.equal(created.payload.event.responseId, 'resp_1');
    assert.equal(created.payload.event.capabilities?.asyncTools, true);
    assert.equal(created.payload.event.connectionGeneration, undefined);
    const toolCall = await until(
      () => events.find((event) => event.type === LlmEventType.ToolCall && event.payload?.calls?.[0]?.async === true),
      'async tool call event'
    );
    assert.equal(toolCall.payload.calls[0].id, 'call_1');
    assert.equal(toolCall.payload.outputItem?.providerResponseId, 'resp_1');
    // 异步调用 pending：流仍然存活（控制器可用），submitToolResults 触发第二个物理请求。
    const admission = await controller.submitToolResults([{ type: 'function_call_output', callId: 'call_1', output: '{"ok":true}' }]);
    assert.equal(admission.responseId, 'resp_2');
    assert.equal(admission.connectionGeneration, undefined);
    // 第二个请求是 stateless 全量历史：保留原始 async 调用项 + 原始 call_id 的结果项。
    const continuationBody = await until(() => state.calls[1], 'continuation request body');
    assert.equal(continuationBody.store, false);
    const carriedCall = continuationBody.input.find((item) => item?.type === 'function_call' && item.call_id === 'call_1');
    assert.equal(carriedCall.async, true);
    const delivered = continuationBody.input.find((item) => item?.type === 'function_call_output' && item.call_id === 'call_1');
    assert.equal(delivered.output, '{"ok":true}');
    // 续流 response.created 携带实际发送的结果 call_id。
    const carrierCreated = await until(
      () => events.find((event) => event.type === LlmEventType.NativeControl && event.payload?.event?.type === 'response.created' && event.payload?.event?.responseId === 'resp_2'),
      'carrier response.created'
    );
    assert.deepEqual(carrierCreated.payload.event.admittedToolResultCallIds, ['call_1']);
    controller.endLogicalRequest();
    // Done 只在逻辑链尾：内容跨 response 聚合且按 providerResponseId 标记边界；usage 求和。
    const done = await until(() => events.find((event) => event.type === LlmEventType.Done), 'logical Done');
    assert.equal(done.payload.usageMetadata.promptTokenCount, 230);
    assert.equal(done.payload.usageMetadata.candidatesTokenCount, 15);
    const parts = done.payload.content?.parts ?? [];
    const responseIds = new Set(parts.map((part) => part.outputItem?.providerResponseId).filter(Boolean));
    assert.ok(responseIds.has('resp_1'), '链聚合内容保留第一个 response 边界');
    assert.ok(responseIds.has('resp_2'), '链聚合内容保留第二个 response 边界');
    const asyncPart = parts.find((part) => 'functionCall' in part && part.id === 'call_1');
    assert.equal(asyncPart?.async, true);
    capability.dispose();
  });
});

test('HTTP/SSE 非 Astra：无原生事件、线上无 async、终态即完成', async () => {
  const state = { calls: [], scripts: [] };
  state.scripts[0] = [
    { type: 'response.created', response: { id: 'resp_plain' } },
    { type: 'response.output_text.delta', delta: 'plain answer' },
    {
      type: 'response.completed',
      response: {
        id: 'resp_plain',
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'plain answer' }] }]
      }
    }
  ];
  await withNativeSseServer(state, async (port) => {
    const capability = createLlmProviderCapability({
      settings: async () => providerConfig({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'gpt-5.6' })
    });
    const events = [];
    let controller;
    capability.start(chatRequest('sse-non-astra'), (event) => events.push(event), {
      native: { onController(next) { controller = next; } }
    });
    const done = await until(() => events.find((event) => event.type === LlmEventType.Done), 'plain Done');
    assert.ok(done, '普通模型首个 response 后即完成');
    assert.equal(events.some((event) => event.type === LlmEventType.NativeControl), false);
    assert.equal(controller, undefined);
    assert.equal(state.calls.length, 1);
    capability.dispose();
  });
});

function adapterFixture() {
  return {
    kind: 'full-model-request',
    modelRequestId: 'model-request-native',
    conversationId: 'conversation-native',
    attemptSeq: '1',
    socketGeneration: '1',
    providerId: 'provider-config',
    modelId: ASTRA,
    nativeAsyncAdmittedCallIds: ['call_admitted'],
    authoritySnapshot: {
      model: { providerConfigId: 'provider-config', provider: 'openai-responses', modelId: ASTRA },
      toolPolicy: { allowedTools: ['probe'], preset: 'custom' }
    },
    recipe: { tools: [{ name: 'probe', description: 'd', parameters: { type: 'object' } }] },
    context: [{
      segmentId: 'segment-user', segmentKind: 'message', messageRole: 'user',
      contentType: 'application/vnd.limcode.message+json',
      content: JSON.stringify({ role: 'user', parts: [{ text: 'hello' }] })
    }],
    attachmentCatalogState: { catalog: [], placements: [] }
  };
}

test('adapter：native hooks 透传、native_control 转换与准入名单下传', async () => {
  const nativeEvent = {
    type: 'response.created',
    responseId: 'resp_1',
    capabilities: { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: true, explicitCaching: true }
  };
  const hooks = { onController() {} };
  let startedRequest;
  let startedControls;
  const capability = {
    start(request, emit, controls) {
      startedRequest = request;
      startedControls = controls;
      emit({ type: LlmEventType.NativeControl, payload: { requestId: request.id, event: nativeEvent } });
      emit({ type: LlmEventType.Done, payload: { requestId: request.id } });
    },
    abort() {},
    resolveInvocation() {},
    compact() {},
    dryRun() { throw new Error('unused'); },
    dryRunCompact() { throw new Error('unused'); },
    listModels() { return Promise.resolve([]); },
    cancelRetry() {},
    dispose() {}
  };
  const adapter = new LlmCapabilityFullRequestAdapter('provider-config', capability);
  const streamEvents = [];
  await adapter.sendFullRequest(adapterFixture(), {
    native: hooks,
    async onEvent(event) { streamEvents.push(event); }
  });
  // capability.start 第三参数原样携带内核 native hooks。
  assert.equal(startedControls?.native, hooks);
  // 准入名单下传到 LlmStartRequest。
  assert.deepEqual(startedRequest.nativeAsyncAdmittedCallIds, ['call_admitted']);
  // NativeControl → native_control（非语义进度，内容无损）。
  const control = streamEvents.find((event) => event.kind === 'native_control');
  assert.ok(control, 'adapter 发出 native_control 事件');
  assert.equal(control.semanticProgress, false);
  assert.equal(control.content.type, 'response.created');
  assert.equal(control.content.responseId, 'resp_1');
  assert.equal(control.content.capabilities.asyncTools, true);
  // 终态仍然是 completed。
  assert.equal(streamEvents.at(-1).kind, 'completed');
});

test('adapter materializeNativeToolOutput：托管媒体解析为线级块', async () => {
  const adapter = new LlmCapabilityFullRequestAdapter(
    'provider-config',
    { start() { throw new Error('unused'); }, abort() {}, resolveInvocation() {}, compact() {}, dryRun() { throw new Error('unused'); }, dryRunCompact() { throw new Error('unused'); }, listModels() { return Promise.resolve([]); }, cancelRetry() {}, dispose() {} },
    undefined,
    async (input) => {
      assert.equal(input.attachmentId, 'att-1');
      return { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=', name: 'shot.png' } };
    }
  );
  const outputs = await adapter.materializeNativeToolOutput([
    {
      type: 'function_call_output',
      callId: 'call_1',
      output: [
        { type: 'input_text', text: 'see attached' },
        { type: 'input_image', mimeType: 'image/png', attachmentId: 'att-1', name: 'shot.png' }
      ]
    }
  ]);
  assert.deepEqual(outputs[0].output[0], { type: 'input_text', text: 'see attached' });
  assert.deepEqual(outputs[0].output[1], { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=', name: 'shot.png' });
  // 原始 InlineDataPart 永远不允许直接流出。
  await assert.rejects(
    adapter.materializeNativeToolOutput([
      { type: 'function_call_output', callId: 'call_2', output: [{ inlineData: { mimeType: 'image/png', attachmentId: 'att-9' } }] }
    ]),
    /Responses content blocks/
  );
});
