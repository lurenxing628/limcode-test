// OpenAI Responses WebSocket 上的显式提示缓存续接。依据 OpenAI 官方文档：
// - 提示缓存：https://developers.openai.com/api/docs/guides/prompt-caching（explicit 模式只用开发者放置的断点；
//   “Each request can create up to four cache writes”；Multi-turn agent 示例 “A breakpoint is added after each tool result”，
//   断点放在 function_call_output 数组形式的 input_text 上）。
// - Responses create 参考 prompt_cache_options：“For cache matching, OpenAI considers up to the latest 80 breakpoints in
//   the conversation”；prompt_cache_breakpoint “Marks the exact end of a reusable prompt prefix”。
// - WebSocket 模式：https://developers.openai.com/api/docs/guides/websocket-mode（续接只发送新 input 与 previous_response_id）。
// 只用本地假服务器，不连接任何模型或网关。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { startLlmProvider, dryRunLlmProvider } = require(path.join(compiledRoot, 'backend/capabilities/llmProvider.js'));
const session = require(path.join(compiledRoot, 'backend/capabilities/openAIResponsesWebSocketSession.js'));

const BREAKPOINT = { mode: 'explicit' };
const EXPLICIT = { enabled: true, mode: 'explicit', ttl: '30m' };
const KEY = { enabled: true, mode: 'key', ttl: '30m' };
const OFF = { enabled: false, mode: 'key', ttl: '30m' };

function responseEventsFor(index, responseId) {
  const plan = [
    { kind: 'call', callId: 'call_1', args: '{"path":"a"}' },
    { kind: 'call', callId: 'call_2', args: '{"path":"b"}' },
    { kind: 'text', text: 'done' },
    { kind: 'text', text: 'ok' },
    { kind: 'text', text: 'ok2' }
  ][index] ?? { kind: 'text', text: `t${index}` };
  const events = [{ type: 'response.created', response: { id: responseId } }];
  if (plan.kind === 'call') {
    const item = { id: `fc_${index}`, type: 'function_call', call_id: plan.callId, name: 'read', arguments: plan.args };
    events.push({ type: 'response.output_item.added', response_id: responseId, output_index: 0, item: { ...item, arguments: '' } });
    events.push({ type: 'response.function_call_arguments.delta', response_id: responseId, item_id: item.id, output_index: 0, delta: plan.args });
    events.push({ type: 'response.output_item.done', response_id: responseId, output_index: 0, item });
  } else {
    const item = { id: `msg_${index}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: plan.text, annotations: [] }] };
    events.push({ type: 'response.output_text.delta', response_id: responseId, item_id: item.id, output_index: 0, content_index: 0, delta: plan.text });
    events.push({ type: 'response.output_item.done', response_id: responseId, output_index: 0, item });
  }
  events.push({ type: 'response.completed', response: { id: responseId, status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } });
  return events;
}

/** HTTP（SSE）与 WebSocket 共用一个本地端点；按到达顺序回放同一套响应计划。 */
async function createServer({ terminateWebSocket = false } = {}) {
  const records = [];
  let counter = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.once('end', () => {
      const index = counter++;
      records.push({ kind: 'http', text: body });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of responseEventsFor(index, `resp_${index + 1}`)) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      if (terminateWebSocket) {
        webSocket.once('message', () => webSocket.terminate());
        return;
      }
      webSocket.on('message', (raw) => {
        records.push({ kind: 'ws', text: raw.toString() });
        const index = counter++;
        for (const event of responseEventsFor(index, `resp_${index + 1}`)) webSocket.send(JSON.stringify(event));
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    records,
    async close() {
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise((resolve) => webSocketServer.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function settingsFor(baseUrl, { model, transport, promptCache }) {
  return {
    id: 'wire-baseline-provider', name: 'Wire baseline', provider: 'openai-responses', baseUrl,
    model, models: [{ id: model, name: model }], apiKey: 'sk-test', toolCallFormat: 'function-call',
    openaiResponsesTransport: transport, stream: true, retryOnError: false, retryMaxAttempts: 0,
    enableMultimodalTools: true, promptCache, modelConfigs: [], createdAt: 1, updatedAt: 1
  };
}

const tools = [{ name: 'read', description: '读取文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];
const system = { role: 'user', parts: [{ text: 'stable instructions' }] };
const user = (text) => ({ role: 'user', parts: [{ text }] });
const call = (id, args) => ({ role: 'model', parts: [{ functionCall: { name: 'read', args }, id }] });
const result = (id, value) => ({ role: 'user', parts: [{ functionResponse: { name: 'read', response: { text: value } }, id }] });
const answer = (value) => ({ role: 'model', parts: [{ text: value }] });

/** 两轮工具循环后接一条新的用户消息；可选每轮末尾的易失任务卡（turn_reminder）。 */
function rounds(withReminder) {
  const history = [
    [user('task')],
    [user('task'), call('call_1', { path: 'a' }), result('call_1', 'A')],
    [user('task'), call('call_1', { path: 'a' }), result('call_1', 'A'), call('call_2', { path: 'b' }), result('call_2', 'B')],
    [user('task'), call('call_1', { path: 'a' }), result('call_1', 'A'), call('call_2', { path: 'b' }), result('call_2', 'B'), answer('done'), user('next')]
  ];
  return history.map((contents, index) => withReminder
    ? { contents: [...contents, user(`[Current Turn Task Card] round-${index + 1}`)], kinds: ['turn_reminder'] }
    : { contents, kinds: [] });
}

function startRequest(name, index, round, attempt) {
  return {
    id: `${name}-r${index + 1}`,
    invocationId: `${name}-inv-${index + 1}`,
    conversationId: `conversation-${name}`,
    contents: round.contents,
    tools,
    systemInstruction: system,
    openAIResponsesContinuation: { volatileTailContentKinds: round.kinds },
    ...(attempt ? { reliableProviderAttempt: attempt } : {})
  };
}

async function runScenario(name, config, withReminder) {
  session.resetOpenAIResponsesWebSocketSessions();
  const server = await createServer();
  const decisions = [];
  try {
    for (const [index, round] of rounds(withReminder).entries()) {
      const events = [];
      await startLlmProvider(startRequest(name, index, round), (event) => events.push(event), {
        settings: async () => settingsFor(server.baseUrl, config),
        onTransportTrace: (trace) => {
          if (trace.phase === 'continuation_decision') decisions.push(`${trace.mode}:${trace.reason}`);
        }
      });
      const failure = events.find((event) => event.type === 'llm:error');
      assert.equal(failure, undefined, `${name} round ${index + 1}: ${JSON.stringify(failure?.payload)}`);
    }
  } finally {
    session.resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
  return {
    frames: server.records.map((record) => ({ kind: record.kind, text: record.text.replaceAll(server.baseUrl, 'BASE') })),
    decisions
  };
}

function breakpointPaths(input) {
  const paths = [];
  input.forEach((item, itemIndex) => {
    const blocks = item.type === 'function_call_output' ? item.output : item.content;
    if (!Array.isArray(blocks)) return;
    blocks.forEach((block, blockIndex) => {
      if (block?.prompt_cache_breakpoint !== undefined) {
        assert.deepEqual(block.prompt_cache_breakpoint, BREAKPOINT);
        paths.push(`${itemIndex}.${blockIndex}`);
      }
    });
  });
  return paths;
}

const arrayOutput = (text, marked = false) => [{ type: 'input_text', text, ...(marked ? { prompt_cache_breakpoint: BREAKPOINT } : {}) }];
const userItem = (text, marked = false) => ({ role: 'user', content: [{ type: 'input_text', text, ...(marked ? { prompt_cache_breakpoint: BREAKPOINT } : {}) }] });

test('explicit 工具循环在 WebSocket 上首帧之后全部增量发送，每帧只在最新的可承载块上打断点', async () => {
  for (const model of ['gpt-5.6', 'gpt-6-sol', 'gpt-6-astra']) {
    for (const withReminder of [false, true]) {
      const label = `${model}/${withReminder ? 'reminder' : 'plain'}`;
      const { frames, decisions } = await runScenario(`explicit-${model}-${withReminder}`, { model, transport: 'websocket', promptCache: EXPLICIT }, withReminder);
      assert.deepEqual(decisions, [
        'full:new_socket_generation',
        'incremental:matched_exact_prefix',
        'incremental:matched_exact_prefix',
        'incremental:matched_exact_prefix'
      ], label);
      const requests = frames.map((frame) => JSON.parse(frame.text));
      assert.ok(frames.every((frame) => frame.kind === 'ws'), label);
      for (const [index, request] of requests.entries()) {
        assert.deepEqual(request.prompt_cache_options, { mode: 'explicit', ttl: '30m' }, `${label} #${index}`);
        assert.equal(request.previous_response_id, index === 0 ? undefined : `resp_${index}`, `${label} #${index}`);
        for (const item of request.input.filter((entry) => entry.type === 'function_call_output')) {
          assert.ok(Array.isArray(item.output), `${label} #${index}: 工具结果是数组形式`);
        }
      }
      // 首帧是完整请求：开发者指令断点 + 最新可承载块的断点。
      assert.deepEqual(requests[0].input[0], {
        role: 'developer', content: [{ type: 'input_text', text: 'stable instructions', prompt_cache_breakpoint: BREAKPOINT }]
      }, label);
      assert.deepEqual(breakpointPaths(requests[0].input), ['0.0', `${requests[0].input.length - 1}.0`], label);
      const reminder = (round, marked) => userItem(`[Current Turn Task Card] round-${round}`, marked);
      const expectedFrames = withReminder
        ? [
            [{ type: 'function_call_output', call_id: 'call_1', output: arrayOutput('{"text":"A"}') }, reminder(2, true)],
            [{ type: 'function_call_output', call_id: 'call_2', output: arrayOutput('{"text":"B"}') }, reminder(3, true)],
            [userItem('next'), reminder(4, true)]
          ]
        : [
            [{ type: 'function_call_output', call_id: 'call_1', output: arrayOutput('{"text":"A"}', true) }],
            [{ type: 'function_call_output', call_id: 'call_2', output: arrayOutput('{"text":"B"}', true) }],
            [userItem('next', true)]
          ];
      for (const [offset, expected] of expectedFrames.entries()) {
        assert.deepEqual(requests[offset + 1].input, expected, `${label} 增量帧 ${offset + 1}`);
      }
    }
  }
});

test('WebSocket 回退到 HTTP 与 HTTP 传输一样保持字符串工具结果，请求体逐字节一致', async () => {
  const round = rounds(false)[2];
  const name = 'explicit-fallback';
  const bodies = [];
  for (const [transport, terminateWebSocket] of [['http', false], ['websocket', true]]) {
    session.resetOpenAIResponsesWebSocketSessions();
    const server = await createServer({ terminateWebSocket });
    const traces = [];
    try {
      const events = [];
      await startLlmProvider(startRequest(name, 2, round, { attemptSeq: 5, maxAttempts: 5, requestCreatedAt: Date.now() }),
        (event) => events.push(event), {
          settings: async () => settingsFor(server.baseUrl, { model: 'gpt-5.6', transport, promptCache: EXPLICIT }),
          onTransportTrace: (trace) => traces.push(trace)
        });
      assert.equal(events.some((event) => event.type === 'llm:error'), false, transport);
      const httpBodies = server.records.filter((record) => record.kind === 'http');
      assert.equal(httpBodies.length, 1, transport);
      if (transport === 'websocket') assert.ok(traces.some((trace) => trace.phase === 'http_fallback'));
      bodies.push(httpBodies[0].text);
    } finally {
      session.resetOpenAIResponsesWebSocketSessions();
      await server.close();
    }
  }
  assert.equal(bodies[1], bodies[0]);
  const body = JSON.parse(bodies[0]);
  assert.deepEqual(body.input.filter((item) => item.type === 'function_call_output').map((item) => item.output),
    ['{"text":"A"}', '{"text":"B"}']);
  assert.deepEqual(breakpointPaths(body.input), ['0.0', '1.0']);
});

test('WS dry-run：explicit 显示数组形式工具结果且断点在最新工具结果上；HTTP dry-run 保持字符串形式', async () => {
  const contents = rounds(false)[2].contents;
  const dryRun = async (transport) => (await dryRunLlmProvider({
    id: `dry-${transport}`, invocationId: `dry-${transport}-inv`, conversationId: 'conversation-dry-explicit',
    contents, tools, systemInstruction: system
  }, { settings: async () => settingsFor('http://127.0.0.1:9/v1', { model: 'gpt-5.6', transport, promptCache: EXPLICIT }) })).body;
  const ws = await dryRun('websocket');
  assert.equal(ws.type, 'response.create');
  assert.deepEqual(ws.input.filter((item) => item.type === 'function_call_output').map((item) => item.output),
    [arrayOutput('{"text":"A"}'), arrayOutput('{"text":"B"}', true)]);
  assert.deepEqual(breakpointPaths(ws.input), ['0.0', `${ws.input.length - 1}.0`]);
  const httpBody = await dryRun('http');
  assert.deepEqual(httpBody.input.filter((item) => item.type === 'function_call_output').map((item) => item.output),
    ['{"text":"A"}', '{"text":"B"}']);
  assert.deepEqual(breakpointPaths(httpBody.input), ['0.0', '1.0']);
});

// ---- 会话层：直接交给 WebSocket 会话的请求体 ----

async function createSessionServer(onCreate) {
  const frames = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
  await new Promise((resolve) => server.once('listening', resolve));
  let creates = 0;
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const text = raw.toString();
      frames.push(text);
      const request = JSON.parse(text);
      if (request.type !== 'response.create') return;
      creates += 1;
      for (const event of onCreate(creates, request)) socket.send(JSON.stringify(event));
    });
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/v1/responses`,
    frames,
    async close() {
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function messageResponse(id, text, previousResponseId) {
  return [
    { type: 'response.created', response: { id, ...(previousResponseId ? { previous_response_id: previousResponseId } : {}) } },
    { type: 'response.output_text.delta', response_id: id, item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', response_id: id, output_index: 0,
      item: { id: `msg_${id}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } },
    { type: 'response.completed', response: { id, status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } }
  ];
}

async function drain(options, onChunk) {
  for await (const chunk of session.streamOpenAIResponsesWebSocketSession(options)) {
    if (onChunk) await onChunk(chunk);
  }
}

function explicitBody(model, input) {
  return {
    model, store: false, include: ['reasoning.encrypted_content'], input,
    prompt_cache_options: { mode: 'explicit', ttl: '30m' }, stream: true
  };
}

test('真实内容前缀变化仍然整包发送：只忽略内容块上的断点标记', async () => {
  const unified = await import('unified-llm-provider');
  const format = new unified.OpenAIResponsesFormat('gpt-5.6');
  const call1 = { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' };
  const first = [userItem('task', true)];
  const baselineSecond = [userItem('task'), call1, { type: 'function_call_output', call_id: 'call_1', output: arrayOutput('A', true) }];
  const fixtures = [
    { name: 'only-marker-moved', second: baselineSecond, mode: 'incremental', reason: 'matched_exact_prefix' },
    { name: 'edited-user-text', second: [userItem('task edited'), ...baselineSecond.slice(1)], mode: 'full', reason: 'input_prefix_mismatch_at:0' },
    {
      name: 'extra-block-field',
      second: [{ role: 'user', content: [{ type: 'input_text', text: 'task', detail: 'x' }] }, ...baselineSecond.slice(1)],
      mode: 'full', reason: 'input_prefix_mismatch_at:0'
    },
    {
      // 字符串与数组形式的工具结果是内容形式差异，不是断点标记，不能忽略。
      name: 'tool-output-form',
      first: [userItem('task'), call1, { type: 'function_call_output', call_id: 'call_1', output: 'A' }, userItem('go on', true)],
      second: [
        userItem('task'),
        call1,
        { type: 'function_call_output', call_id: 'call_1', output: arrayOutput('A') },
        userItem('go on'),
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'r1' }] },
        userItem('more', true)
      ],
      mode: 'full', reason: 'input_prefix_mismatch_at:2'
    },
    // 断点只在 explicit 模式下忽略：同样只移动了断点、但请求不是 explicit 时严格比较。
    { name: 'not-explicit-mode', second: baselineSecond, withoutExplicitOptions: true, mode: 'full', reason: 'input_prefix_mismatch_at:0' }
  ];
  for (const fixture of fixtures) {
    session.resetOpenAIResponsesWebSocketSessions();
    const server = await createSessionServer((index, request) => index === 1 && fixture.name !== 'tool-output-form'
      ? [
          { type: 'response.created', response: { id: 'resp_1' } },
          { type: 'response.output_item.done', response_id: 'resp_1', output_index: 0, item: { id: 'fc_1', ...call1 } },
          { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [] } }
        ]
      : messageResponse(`resp_${index}`, `r${index}`, request.previous_response_id));
    const decisions = [];
    const body = (input) => {
      const value = explicitBody('gpt-5.6', input);
      if (fixture.withoutExplicitOptions) delete value.prompt_cache_options;
      return value;
    };
    const options = (input) => ({
      sessionKey: `explicit-prefix-${fixture.name}`, url: server.url, headers: { Authorization: 'Bearer test-key' },
      body: body(input), format, onDecision: (decision) => decisions.push(decision),
      timeouts: { firstEventMs: 3000, eventIdleMs: 3000, responseMs: 8000 }
    });
    try {
      await drain(options(fixture.first ?? first));
      await drain(options(fixture.second));
      const sent = JSON.parse(server.frames[1]);
      assert.equal(decisions[1].mode, fixture.mode, fixture.name);
      assert.equal(decisions[1].reason, fixture.reason, fixture.name);
      if (fixture.mode === 'full') {
        assert.equal('previous_response_id' in sent, false, fixture.name);
        assert.equal(sent.input.length, fixture.second.length, fixture.name);
      } else {
        assert.equal(sent.previous_response_id, 'resp_1', fixture.name);
        assert.deepEqual(sent.input, [baselineSecond[2]], fixture.name);
      }
    } finally {
      session.resetOpenAIResponsesWebSocketSessions();
      await server.close();
    }
  }
});

/** 原生 GPT-6：第一次逻辑请求里模型调用工具，经控制器链内交付结果；第二次逻辑请求带新的用户消息。 */
async function nativeChain(model, promptCache) {
  session.resetOpenAIResponsesWebSocketSessions();
  const unified = await import('unified-llm-provider');
  const format = new unified.OpenAIResponsesFormat(model);
  const bodyFormat = new unified.OpenAIResponsesFormat(model, promptCache);
  const server = await createSessionServer((index, request) => {
    if (index !== 1) return messageResponse(`resp_n${index}`, index === 2 ? 'done' : 'ok', request.previous_response_id);
    return [
      { type: 'response.created', response: { id: 'resp_n1' } },
      { type: 'response.output_item.done', response_id: 'resp_n1', output_index: 0,
        item: { id: 'fc_n1', type: 'function_call', call_id: 'call_n1', name: 'read', arguments: '{"path":"a"}' } },
      { type: 'response.completed', response: { id: 'resp_n1', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } }
    ];
  });
  const decisions = [];
  const toolsWire = [{ functionDeclarations: [{ name: 'read', description: '读取', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] }];
  const systemInstruction = { role: 'user', parts: [{ text: 'stable instructions' }] };
  const holder = {};
  const options = (body) => ({
    sessionKey: `native-${model}`, url: server.url, headers: { Authorization: 'Bearer test-key' }, body, format,
    native: { steering: true, reasoningUpdates: false, multiplexing: false, onController(controller) { holder.controller = controller ?? undefined; } },
    timeouts: { firstEventMs: 3000, eventIdleMs: 3000, responseMs: 10000 },
    onDecision: (decision) => decisions.push(`${decision.mode}:${decision.reason}`)
  });
  try {
    let admission;
    await drain(options(bodyFormat.encodeRequest({ systemInstruction, contents: [user('task')], tools: toolsWire }, true)), (chunk) => {
      if (chunk.nativeEvent?.type === 'response.completed' && !admission && holder.controller) {
        admission = holder.controller.submitToolResults([{ type: 'function_call_output', callId: 'call_n1', output: '{"text":"A"}' }]);
      }
    });
    await admission;
    await drain(options(bodyFormat.encodeRequest({ systemInstruction, tools: toolsWire, contents: [
      user('task'),
      { role: 'model', parts: [{ functionCall: { name: 'read', args: { path: 'a' }, callId: 'call_n1' } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'read', response: { text: 'A' }, callId: 'call_n1' } }] },
      answer('done'),
      user('next')
    ] }, true)));
  } finally {
    session.resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
  return { frames: server.frames.map((text) => ({ kind: 'ws', text })), decisions };
}

test('原生 GPT-6（Astra / Sol）explicit：链内工具结果以数组形式带断点，下一次逻辑请求增量续接', async () => {
  const promptCache = { enabled: true, mode: 'explicit', ttl: '30m', breakpoints: { messages: true, toolOutputs: true } };
  for (const model of ['gpt-6-astra', 'gpt-6-sol']) {
    const { frames, decisions } = await nativeChain(model, promptCache);
    assert.deepEqual(decisions, ['full:new_socket_generation', 'incremental:matched_exact_prefix'], model);
    const requests = frames.map((frame) => JSON.parse(frame.text));
    assert.equal(requests.length, 3, model);
    assert.deepEqual(breakpointPaths(requests[0].input), ['0.0', '1.0'], model);
    assert.equal(requests[1].previous_response_id, 'resp_n1', model);
    assert.deepEqual(requests[1].input, [{ type: 'function_call_output', call_id: 'call_n1', output: arrayOutput('{"text":"A"}', true) }], model);
    assert.deepEqual(requests[1].prompt_cache_options, { mode: 'explicit', ttl: '30m' }, model);
    assert.equal(requests[2].previous_response_id, 'resp_n2', model);
    assert.deepEqual(requests[2].input, [userItem('next', true)], model);
  }
});

// ---- 逐字节回归：以下摘要由改动前的构建（codex/agent-collaboration e66a79da + unified-llm-provider
// 0.1.37-limcode.5）用同一套假服务器与请求录制。非 explicit 模式、HTTP 传输与 GPT-5.6 之前的模型必须不变。
function wireDigest(frames) {
  return createHash('sha256').update(frames.map((frame) => `${frame.kind}:${frame.text}`).join('\n')).digest('hex');
}

const INCREMENTAL_AFTER_FIRST = [
  'full:new_socket_generation',
  'incremental:matched_exact_prefix',
  'incremental:matched_exact_prefix',
  'incremental:matched_exact_prefix'
];

const WIRE_BASELINE = [
  { name: 'websocket-gpt-5.6-key-reminder', config: { model: 'gpt-5.6', transport: 'websocket', promptCache: KEY }, reminder: true,
    digest: '23cba28de04f493231c0a0ac54e042e2f69503025b4f016dfad28112b617f342', decisions: INCREMENTAL_AFTER_FIRST },
  { name: 'websocket-gpt-5.6-key-plain', config: { model: 'gpt-5.6', transport: 'websocket', promptCache: KEY }, reminder: false,
    digest: '637f5f71d4fbda72f4a0fdf9adfa404c39bd3e5f4cf002eb203411aee31d37da', decisions: INCREMENTAL_AFTER_FIRST },
  { name: 'websocket-gpt-5.6-off-plain', config: { model: 'gpt-5.6', transport: 'websocket', promptCache: OFF }, reminder: false,
    digest: 'c0193c1ebb7a2dfd42e19aa6ac73e29943f963b28a234dc43ad70ba32933c8e7', decisions: INCREMENTAL_AFTER_FIRST },
  { name: 'websocket-gpt-5.6-off-reminder', config: { model: 'gpt-5.6', transport: 'websocket', promptCache: OFF }, reminder: true,
    digest: 'ec7ae4b547d9a1648302440e4256ec58e8e9f68c7195f89e08be0c337124dceb', decisions: INCREMENTAL_AFTER_FIRST },
  { name: 'websocket-gpt-5.5-explicit-reminder', config: { model: 'gpt-5.5', transport: 'websocket', promptCache: EXPLICIT }, reminder: true,
    digest: 'd08525a3fca5a7f83dcc3129427291a6589792a34c11b5335d7cd712ed361e10', decisions: INCREMENTAL_AFTER_FIRST },
  { name: 'websocket-gpt-5.5-explicit-plain', config: { model: 'gpt-5.5', transport: 'websocket', promptCache: EXPLICIT }, reminder: false,
    digest: '3cc75db9bd9edf9bcb04d855c6bed4b7898156758afc49cdf1b5edd1a031f6ab', decisions: INCREMENTAL_AFTER_FIRST },
  { name: 'http-gpt-5.6-explicit-reminder', config: { model: 'gpt-5.6', transport: 'http', promptCache: EXPLICIT }, reminder: true,
    digest: '52cdd32f54ed9bd522c5da709988434a5cd7c227f54a4c8edb055acb58c4a049', decisions: [] },
  { name: 'http-gpt-5.6-explicit-plain', config: { model: 'gpt-5.6', transport: 'http', promptCache: EXPLICIT }, reminder: false,
    digest: 'fd33e28303f205e454da068fc1ccf56b5a2808c51edf68a2a4f24d843a981c81', decisions: [] },
  { name: 'http-gpt-5.6-key-plain', config: { model: 'gpt-5.6', transport: 'http', promptCache: KEY }, reminder: false,
    digest: 'b7176b372bf884d1d17aeac79785b1bfdf6b07851b71dbecaaae9e1a57b95de9', decisions: [] },
  { name: 'http-gpt-5.5-explicit-plain', config: { model: 'gpt-5.5', transport: 'http', promptCache: EXPLICIT }, reminder: false,
    digest: '61ffc4697a2312133e210d8408b45d87d1fa10eaf2c550ce859dbd4e1daf62dc', decisions: [] }
];

test('非 explicit 模式、HTTP 传输与 GPT-5.6 之前的模型：线上帧与改动前构建逐字节一致', async () => {
  for (const scenario of WIRE_BASELINE) {
    const { frames, decisions } = await runScenario(scenario.name, scenario.config, scenario.reminder);
    assert.deepEqual(decisions, scenario.decisions, scenario.name);
    assert.equal(wireDigest(frames), scenario.digest,
      `${scenario.name} 线上帧与改动前不同：\n${frames.map((frame) => `${frame.kind}: ${frame.text}`).join('\n')}`);
  }
});

test('dry-run 与原生 GPT-6 非 explicit 链：与改动前构建逐字节一致', async () => {
  const dryRun = async (name, config) => JSON.stringify((await dryRunLlmProvider({
    id: `${name}-dry`, invocationId: `${name}-dry-inv`, conversationId: `conversation-${name}`,
    contents: rounds(true)[3].contents, tools, systemInstruction: system
  }, { settings: async () => settingsFor('http://127.0.0.1:9/v1', config) })).body);
  const digest = (text) => createHash('sha256').update(text).digest('hex');
  assert.equal(digest(await dryRun('dry-http-gpt-5.6-explicit', { model: 'gpt-5.6', transport: 'http', promptCache: EXPLICIT })),
    '738bf1917adc550b4d017d20f9cc970b792a49fd9be9dd31732bc648e85410ae');
  assert.equal(digest(await dryRun('dry-websocket-gpt-5.6-key', { model: 'gpt-5.6', transport: 'websocket', promptCache: KEY })),
    'e2beed62bd2d07f569091ace2988038f361f5fdfea92027a4aa103917793201e');
  assert.equal(digest(await dryRun('dry-websocket-gpt-5.5-explicit', { model: 'gpt-5.5', transport: 'websocket', promptCache: EXPLICIT })),
    'ef06f409f69b47c77d8937abff5a23c887d93cf2ec5a31f7cb822195890b9773');

  for (const [model, promptCache, expected] of [
    ['gpt-6-astra', { enabled: true, mode: 'key', key: 'k1' }, 'b40f947cbcf7f622fc475fe1487cc9b66ff15d88e3b2eed24a642310c3a2a2d1'],
    ['gpt-6-astra', undefined, 'fa0d04979d5e1ca7948b8f9ffc07df490dfc3bc8d2df9b45c5003396bc0c4bd3'],
    ['gpt-6-sol', { enabled: true, mode: 'key', key: 'k1' }, 'b5c3deb831c62787d811ad4e51cdfdf0bf355fff57c167b9286379d44081b5ef']
  ]) {
    const { frames, decisions } = await nativeChain(model, promptCache);
    assert.deepEqual(decisions, ['full:new_socket_generation', 'incremental:matched_exact_prefix'], model);
    assert.equal(wireDigest(frames), expected, `${model} 原生链线上帧与改动前不同：\n${frames.map((frame) => frame.text).join('\n')}`);
    // 非 explicit：链内工具结果仍是字符串，且没有任何断点。
    const inChain = JSON.parse(frames[1].text);
    assert.deepEqual(inChain.input, [{ type: 'function_call_output', call_id: 'call_n1', output: '{"text":"A"}' }], model);
  }
});
