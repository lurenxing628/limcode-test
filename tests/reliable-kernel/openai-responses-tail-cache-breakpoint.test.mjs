/**
 * OpenAI Responses 显式提示缓存（GPT-5.6 及之后）在尾巴模式下的消息断点。
 *
 * 官方（https://developers.openai.com/api/docs/guides/prompt-caching）：
 * - 显式模式只在开发者放置的断点处写缓存（写入 1.25 倍，读取 0.1 倍）；“Content after the last selected breakpoint is
 *   processed at the uncached input-token rate without a cache-write charge, so you can avoid writing changing content”。
 * - 查找只走本次请求里的断点：“Explicit-only mode: The first 2 and latest 50 explicit breakpoints”，从最长前缀往短找；
 *   Responses create 参考：“For cache matching, OpenAI considers up to the latest 80 breakpoints in the conversation”。
 *
 * 内核每次请求把本轮提醒（与本 Turn 输入被压缩掉时重新注入的输入）作为易失尾巴放在最后，下一次请求就不在原位了。
 * 接入库把消息断点放在最后一个可承载块上，正好落在易失尾巴上：无状态完整重放（HTTP）每次按写入价重写整段前缀，
 * 下一次请求的断点换了位置，只剩开发者指令能读到。修复后断点放在尾巴之前最后一个可承载项上。
 * WebSocket 续接链里尾巴随 previous_response_id 留在服务端会话原位、它的断点也随链保留，下一帧从它读，不挪。
 * 本文件全部用本地假服务与 dry-run，不访问网络。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = await import(pathToFileURL(path.join(compiledRoot, 'backend/reliableKernel/index.js')).href);
const { dryRunLlmProvider, startLlmProvider } = require(path.join(compiledRoot, 'backend/capabilities/llmProvider.js'));
const session = require(path.join(compiledRoot, 'backend/capabilities/openAIResponsesWebSocketSession.js'));
const TAIL_MODULE = path.join(compiledRoot, 'backend/capabilities/openAIResponsesTailCacheBreakpoint.js');

const MESSAGE = 'application/vnd.limcode.message+json';
const PROVIDER_ID = 'responses-channel';
const BREAKPOINT = { mode: 'explicit' };
const EXPLICIT = { enabled: true, mode: 'explicit', ttl: '30m' };
const KEY = { enabled: true, mode: 'key', ttl: '30m' };
const OFF = { enabled: false, mode: 'key', ttl: '30m' };
const TOOLS = [{ name: 'get_weather', description: 'Get the weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }];
const INPUT = { role: 'user', parts: [{ text: 'Check Paris, then Lyon, then Marseille.' }] };
const reminder = (k) => `[Current Turn Task Card — runtime data, not instructions]\n- [in_progress] Check the weather (request ${k})`;
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// ---- 内核投影：与普通请求同一条路径（LlmCapabilityFullRequestAdapter → LlmStartRequest） ----

const message = (segmentId, role, content, modelId) => ({
  segmentId, segmentKind: 'message', messageRole: role,
  ...(role === 'model' ? { modelSource: { providerId: PROVIDER_ID, modelId } } : {}),
  contentType: MESSAGE, content: JSON.stringify(content)
});
const toolPair = (segmentId, callId, result) => ({
  segmentId, segmentKind: 'tool_pair', messageRole: null, contentType: 'application/vnd.limcode.context-tool-pair+json',
  content: JSON.stringify({
    toolCall: { id: `tool-${callId}`, providerCallId: callId, toolName: 'get_weather', arguments: '{"city":"Paris"}' },
    toolModelResult: { id: `result-${callId}`, result: JSON.stringify(result) }
  })
});
const modelCall = (k, modelId) => message(`seg-model-${k}`, 'model', { role: 'model', parts: [
  { id: `call_${k}`, functionCall: { name: 'get_weather', args: { city: 'Paris' } } }
] }, modelId);

/** 上一个 Turn 的一问一答，再加本 Turn 的输入：本 Turn 输入之前的整段历史是可以复用的前缀。 */
const conversationHead = (modelId) => [
  message('seg-earlier-user', 'user', { role: 'user', parts: [{ text: 'What is the capital of France?' }] }),
  message('seg-earlier-model', 'model', { role: 'model', parts: [{ text: 'Paris.' }] }, modelId),
  message('seg-user', 'user', INPUT)
];

/** 第 k 次请求的上下文：开头若干项，然后 k-1 轮已完成的工具调用与结果。 */
function loopContext(k, modelId, head = conversationHead(modelId)) {
  const context = [...head];
  for (let round = 1; round < k; round += 1) {
    context.push(modelCall(round, modelId), toolPair(`seg-result-${round}`, `call_${round}`, { ok: true, condition: 'rain' }));
  }
  return context;
}

function fullRequest({ modelId, provider = 'openai-responses', context, reminderText, reinject = false, id = 'request' }) {
  return {
    kind: 'full-model-request', modelRequestId: id, conversationId: 'conversation-responses-tail-cache', attemptSeq: '1', socketGeneration: '1',
    providerId: PROVIDER_ID, modelId,
    authoritySnapshot: {
      model: { providerConfigId: PROVIDER_ID, provider, modelId, generationConfig: { maxOutputTokens: 4096 } },
      toolPolicy: { allowedTools: ['get_weather'], preset: 'custom', sourceConfigs: {} },
      systemPrompt: { text: 'You are a careful assistant.' }
    },
    recipe: { kind: 'reliable-agent-turn', round: '1', tools: TOOLS },
    context,
    attachmentCatalogState: { catalog: [], placements: [] },
    requestAddenda: {
      currentTurnInput: {
        messageId: 'message-input', messageRevisionId: 'revision-input', contentObjectId: 'content-input',
        reinject, contentType: MESSAGE, content: JSON.stringify(INPUT)
      },
      ...(reminderText ? { turnReminder: { content: reminderText, unfinishedTaskCount: 1, activeChildCount: 0, runningProcessCount: 0 } } : {})
    }
  };
}

function settingsFor(baseUrl, { model, transport = 'http', promptCache = EXPLICIT, provider = 'openai-responses' }) {
  return {
    id: PROVIDER_ID, name: 'responses', provider, baseUrl, model, models: [{ id: model, name: model }],
    apiKey: '', toolCallFormat: 'function-call', openaiResponsesTransport: transport, stream: true,
    retryOnError: false, retryMaxAttempts: 0, retryDelaySeconds: 0, enableMultimodalTools: true, systemPromptPrefix: '',
    contextWindowTokens: 200000, promptCache, modelConfigs: [], createdAt: 1, updatedAt: 1
  };
}

async function project(request) {
  let start;
  const adapter = new kernel.LlmCapabilityFullRequestAdapter(request.providerId, {
    start(input, emit) { start = structuredClone(input); emit({ type: 'llm:done', payload: { requestId: input.id } }); },
    abort() {}, cancelRetry() {}, dispose() {}
  });
  await adapter.sendFullRequest(request, { onEvent: async (event) => ({ accepted: true, checkpointed: true, terminal: event.kind === 'completed' }) });
  return start;
}

async function dryRunBody(request, config) {
  return (await dryRunLlmProvider(await project(request), { settings: async () => settingsFor('https://example.invalid/v1', config) })).body;
}

/** input 里带断点的项下标；断点只允许出现在该项最后一块上。 */
function breakpointIndexes(input) {
  return input.flatMap((item, index) => {
    const blocks = item.type === 'function_call_output' ? item.output : item.content;
    if (!Array.isArray(blocks)) return [];
    const marked = blocks.flatMap((block, blockIndex) => block?.prompt_cache_breakpoint !== undefined ? [blockIndex] : []);
    if (marked.length === 0) return [];
    assert.deepEqual(marked, [blocks.length - 1], `input[${index}]: breakpoint on the last block`);
    assert.deepEqual(blocks.at(-1).prompt_cache_breakpoint, BREAKPOINT);
    return [index];
  });
}

/** 断点标记本身不是前缀内容。 */
const withoutMarkers = (value) => JSON.parse(JSON.stringify(value, (key, nested) => key === 'prompt_cache_breakpoint' ? undefined : nested));

/**
 * 官方查找规则的最小模型（显式模式）：每个断点写入到它为止的前缀；之后的请求只在自己（续接链上则是整个会话）
 * 的断点处查找，从最长到最短，命中之前写入过的前缀。`conversation(body, index)` 给出服务端看到的完整会话与本帧起点。
 * 返回每次请求读到的会话项数。
 */
function simulateExplicitCache(bodies, conversation = (body) => ({ items: body.input, frameStart: 0 })) {
  const written = new Set();
  return bodies.map((body, index) => {
    const { input: _input, previous_response_id: _previous, type: _type, stream: _stream, ...settings } = body;
    const head = JSON.stringify(settings);
    const { items, frameStart } = conversation(body, index);
    const plain = withoutMarkers(items);
    const key = (end) => `${head}\n${JSON.stringify(plain.slice(0, end))}`;
    const marks = breakpointIndexes(items);
    let read = 0;
    for (const mark of [...marks].reverse()) {
      if (written.has(key(mark + 1))) { read = mark + 1; break; }
    }
    for (const mark of marks) if (mark >= frameStart) written.add(key(mark + 1));
    return read;
  });
}

const isTailItem = (item, text) => item.role === 'user' && JSON.stringify(item).includes(text);

// ---- 无状态完整重放（HTTP / dry-run） ----

test('HTTP 工具循环（尾巴是本轮提醒）：消息断点在尾巴之前最后一个可承载项上，之后每次请求在同一位置读到', async () => {
  for (const modelId of ['gpt-5.6', 'gpt-6-sol']) {
    const bodies = [];
    for (let k = 1; k <= 4; k += 1) {
      bodies.push(await dryRunBody(fullRequest({ modelId, context: loopContext(k, modelId), reminderText: reminder(k) }), { model: modelId }));
    }
    // 断点在尾巴上时每次请求只读到开发者指令（1 项）。
    assert.deepEqual(simulateExplicitCache(bodies), [0, 4, 4, 4], `${modelId}: every later request reads the history before the current input`);
    for (const [index, body] of bodies.entries()) {
      const label = `${modelId} request ${index + 1}`;
      const tail = body.input.at(-1);
      assert.equal(isTailItem(tail, 'Current Turn Task Card'), true, `${label}: the reminder is still the tail`);
      assert.equal(JSON.stringify(tail).includes('prompt_cache_breakpoint'), false, `${label}: no breakpoint on the volatile reminder`);
      const inputIndex = body.input.findIndex((item) => item.role === 'user' && JSON.stringify(item).includes('Check Paris'));
      assert.equal(inputIndex, 3, label);
      // 开发者指令、上一回合的用户输入（读取点）、尾巴之前最后一个可承载项（本回合输入）。
      assert.deepEqual(breakpointIndexes(body.input), [0, 1, inputIndex], `${label}: developer instructions + previous input + the carrier before the tail`);
      assert.equal(body.input[0].role, 'developer', label);
      assert.deepEqual(body.prompt_cache_options, { mode: 'explicit', ttl: '30m' }, label);
    }
    // 第 k 次请求断点为止的前缀（含标记）原样出现在第 k+1 次请求里，而且那里同样有断点。
    for (let k = 0; k + 1 < bodies.length; k += 1) {
      const end = breakpointIndexes(bodies[k].input).at(-1) + 1;
      assert.equal(JSON.stringify(bodies[k + 1].input.slice(0, end)), JSON.stringify(bodies[k].input.slice(0, end)), `${modelId}: prefix of request ${k + 1}`);
    }
  }
});

test('重新注入的输入与提醒都在断点之后；断点在压缩摘要上，下一次请求仍能读到', async () => {
  const modelId = 'gpt-5.6';
  const summary = message('seg-summary', 'user', { role: 'user', parts: [{ text: '[Context Summary]\n\nearlier work' }] });
  const bodies = [];
  for (let k = 1; k <= 3; k += 1) {
    bodies.push(await dryRunBody(fullRequest({ modelId, context: loopContext(k, modelId, [summary]), reminderText: reminder(k), reinject: true }), { model: modelId }));
  }
  assert.deepEqual(simulateExplicitCache(bodies), [0, 2, 2]);
  for (const [index, body] of bodies.entries()) {
    const tail = body.input.slice(-2);
    assert.equal(isTailItem(tail[0], 'Check Paris, then Lyon'), true, `request ${index + 1}: reinjected input`);
    assert.equal(isTailItem(tail[1], 'Current Turn Task Card'), true, `request ${index + 1}: reminder`);
    assert.equal(JSON.stringify(tail).includes('prompt_cache_breakpoint'), false, `request ${index + 1}: nothing volatile is marked`);
    assert.deepEqual(breakpointIndexes(body.input), [0, 1], `request ${index + 1}: breakpoint on the summary`);
  }
});

test('纯函数边界：形状对不上时原样返回同一引用；断点可以挪到数组形式的工具结果上；不改动输入', () => {
  const { withOpenAIResponsesCacheBreakpointBeforeVolatileTail: move } = require(TAIL_MODULE);
  const user = (text, marked = false) => ({ role: 'user', content: [{ type: 'input_text', text, ...(marked ? { prompt_cache_breakpoint: BREAKPOINT } : {}) }] });
  const developer = { role: 'developer', content: [{ type: 'input_text', text: 'stable', prompt_cache_breakpoint: BREAKPOINT }] };
  const call = { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{}' };
  const stringOutput = { type: 'function_call_output', call_id: 'call_1', output: 'A' };
  const arrayOutput = { type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'A' }] };
  const assistant = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] };
  const body = (input, extra = {}) => ({ headers: {}, body: { model: 'gpt-5.6', input, prompt_cache_options: { mode: 'explicit', ttl: '30m' }, ...extra } });

  const same = (request, count, why) => assert.equal(move(request, count), request, why);
  const plain = body([developer, user('q'), call, stringOutput, user('r', true)]);
  same(body([developer, call, stringOutput, user('r', true)]), 0, 'no volatile tail and no earlier user message to read');
  same(plain, 5, 'the tail covers the whole input');
  same(plain, 2, 'the tail must be user messages only');
  same(body([developer, user('q'), user('r', true)], { prompt_cache_options: { mode: 'implicit', ttl: '30m' } }), 1, 'implicit mode');
  same(body([developer, user('q'), user('r', true)], { prompt_cache_options: undefined }), 1, 'key mode');
  same(body([developer, user('q'), user('r', true)], { model: 'gpt-5.5' }), 1, 'model without explicit breakpoints');
  same(body([developer, user('q'), user('r')]), 1, 'no breakpoint on the tail');
  same(body([developer, user('q'), user('i', true), user('r', true)]), 2, 'more than one breakpoint on the tail');
  same(body([call, stringOutput, user('r', true)]), 1, 'no carrier before the tail');
  same(body([developer, call, stringOutput, assistant, user('r', true)]), 1, 'only the already-marked developer instructions before the tail');

  const request = body([developer, user('q'), call, arrayOutput, assistant, user('r', true)]);
  const snapshot = JSON.stringify(request);
  const moved = move(request, 1);
  assert.deepEqual(moved.body.input, [
    developer,
    user('q', true),
    call,
    { ...arrayOutput, output: [{ type: 'input_text', text: 'A', prompt_cache_breakpoint: BREAKPOINT }] },
    assistant,
    user('r')
  ]);
  assert.equal(JSON.stringify(request), snapshot, 'the input is not mutated');
  const toUser = move(body([developer, user('q'), call, stringOutput, user('i'), user('r', true)]), 2);
  assert.deepEqual(breakpointIndexes(toUser.body.input), [0, 1], 'string tool results are not carriers; the breakpoint goes to the user message');

  // 新回合：写入点落在新的用户输入上，另在上一条用户消息（上一回合的输入）上放一个读取断点，共 3 个。
  const nextTurn = move(body([developer, user('q'), call, stringOutput, assistant, user('next'), user('r', true)]), 1);
  assert.deepEqual(breakpointIndexes(nextTurn.body.input), [0, 1, 5]);
  // 没有易失尾巴时，接入库的断点就在最后一个可承载项上；同样补上前一条用户消息的读取断点。
  const noTail = move(body([developer, user('q'), call, arrayOutput, assistant, user('next', true)]), 0);
  assert.deepEqual(breakpointIndexes(noTail.body.input), [0, 1, 5]);
  // 读取点只找用户消息：工具结果不算“上一回合输入”；已带断点的不重复标记。
  const outputsOnly = move(body([developer, call, arrayOutput, call, arrayOutput, user('r', true)]), 1);
  assert.deepEqual(breakpointIndexes(outputsOnly.body.input), [0, 4]);
  same(body([developer, user('q', true), user('next', true)]), 0, 'the previous user message already carries a breakpoint');
});

test('尾巴之前只有已带断点的开发者指令（输入被压缩掉、没有摘要）：请求与改动前构建逐字节一致', async () => {
  const modelId = 'gpt-5.6';
  const bodies = [];
  for (let k = 2; k <= 3; k += 1) {
    bodies.push(await dryRunBody(fullRequest({ modelId, context: loopContext(k, modelId, []), reminderText: reminder(k), reinject: true }), { model: modelId }));
  }
  for (const body of bodies) {
    // developer、function_call / 字符串 function_call_output……、重新注入的输入、提醒：尾巴之前没有别的可承载项。
    assert.deepEqual(breakpointIndexes(body.input), [0, body.input.length - 1]);
  }
  assert.equal(sha256(JSON.stringify(bodies)), '043d256347d48a3ca6624d4d8720fb0ae5787f5ac8399769f91dd06b28e5b7d7');
});

// ---- 传输路径：本地假服务（HTTP SSE 与 WebSocket 共用一个端点） ----

function responsePlan(index) {
  return [
    { kind: 'call', callId: 'call_1' },
    { kind: 'call', callId: 'call_2' },
    { kind: 'text', text: 'done' },
    { kind: 'text', text: 'ok' }
  ][index] ?? { kind: 'text', text: `t${index}` };
}

function responseEvents(index, responseId) {
  const plan = responsePlan(index);
  const item = plan.kind === 'call'
    ? { id: `fc_${index}`, type: 'function_call', call_id: plan.callId, name: 'get_weather', arguments: '{"city":"Paris"}' }
    : { id: `msg_${index}`, type: 'message', role: 'assistant', content: [{ type: 'output_text', text: plan.text, annotations: [] }] };
  const events = [{ type: 'response.created', response: { id: responseId } }];
  if (plan.kind === 'call') {
    events.push({ type: 'response.output_item.added', response_id: responseId, output_index: 0, item: { ...item, arguments: '' } });
    events.push({ type: 'response.function_call_arguments.delta', response_id: responseId, item_id: item.id, output_index: 0, delta: item.arguments });
  } else {
    events.push({ type: 'response.output_text.delta', response_id: responseId, item_id: item.id, output_index: 0, content_index: 0, delta: plan.text });
  }
  events.push({ type: 'response.output_item.done', response_id: responseId, output_index: 0, item });
  events.push({ type: 'response.completed', response: { id: responseId, status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } } });
  return { events, item };
}

/** 记录每个请求体；WebSocket 上按 previous_response_id 维护服务端会话（此前各帧的输入与输出）。 */
async function createServer({ terminateWebSocket = false } = {}) {
  const records = [];
  const conversations = new Map();
  let counter = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.once('end', () => {
      const index = counter++;
      records.push({ kind: 'http', text: body });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of responseEvents(index, `resp_${index + 1}`).events) response.write(`data: ${JSON.stringify(event)}\n\n`);
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
        const text = raw.toString();
        const frame = JSON.parse(text);
        const index = counter++;
        const responseId = `resp_${index + 1}`;
        const prior = frame.previous_response_id ? conversations.get(frame.previous_response_id) : [];
        assert.ok(prior, `unknown previous_response_id ${frame.previous_response_id}`);
        const { events, item } = responseEvents(index, responseId);
        records.push({ kind: 'ws', text, conversation: [...prior, ...frame.input], frameStart: prior.length });
        conversations.set(responseId, [...prior, ...frame.input, item]);
        for (const event of events) webSocket.send(JSON.stringify(event));
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
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

const system = { role: 'user', parts: [{ text: 'stable instructions' }] };
const user = (text) => ({ role: 'user', parts: [{ text }] });
const call = (id) => ({ role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } }, id }] });
const result = (id, value) => ({ role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { text: value } }, id }] });
const answer = (value) => ({ role: 'model', parts: [{ text: value }] });

/** 两轮工具循环后模型回答、用户接着问；每次请求末尾是本轮提醒（尾巴模式）。 */
function rounds() {
  const history = [
    [user('task')],
    [user('task'), call('call_1'), result('call_1', 'A')],
    [user('task'), call('call_1'), result('call_1', 'A'), call('call_2'), result('call_2', 'B')],
    [user('task'), call('call_1'), result('call_1', 'A'), call('call_2'), result('call_2', 'B'), answer('done'), user('next')]
  ];
  return history.map((contents, index) => [...contents, user(`[Current Turn Task Card] round-${index + 1}`)]);
}

function startRequest(name, index, contents, attempt) {
  return {
    id: `${name}-r${index + 1}`, invocationId: `${name}-inv-${index + 1}`, conversationId: `conversation-${name}`,
    contents, tools: TOOLS, systemInstruction: system,
    openAIResponsesContinuation: { volatileTailContentKinds: ['turn_reminder'] },
    ...(attempt ? { reliableProviderAttempt: attempt } : {})
  };
}

/** `name` 决定 conversationId（进而决定 prompt_cache_key）：要逐字节比较的两次运行用同一个名字。 */
async function runRounds(name, config, { terminateWebSocket = false, only } = {}) {
  session.resetOpenAIResponsesWebSocketSessions();
  const server = await createServer({ terminateWebSocket });
  const traces = [];
  const dryRuns = [];
  try {
    for (const [index, contents] of rounds().entries()) {
      if (only !== undefined && index !== only) continue;
      const settings = { ...settingsFor(server.baseUrl, config), apiKey: 'sk-test' };
      const attempt = terminateWebSocket ? { attemptSeq: 5, maxAttempts: 5, requestCreatedAt: Date.now() } : undefined;
      const request = startRequest(name, index, contents, attempt);
      dryRuns.push((await dryRunLlmProvider(request, { settings: async () => settings })).body);
      const events = [];
      await startLlmProvider(request, (event) => events.push(event), {
        settings: async () => settings,
        onTransportTrace: (trace) => traces.push(trace)
      });
      const failure = events.find((event) => event.type === 'llm:error');
      assert.equal(failure, undefined, `${name} round ${index + 1}: ${JSON.stringify(failure?.payload)}`);
    }
  } finally {
    session.resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
  return { records: server.records, traces, dryRuns, baseUrl: server.baseUrl };
}

test('HTTP 发送与 dry-run 一致；WebSocket 回退的 HTTP 与 HTTP 传输逐字节相同，断点都在尾巴之前', async () => {
  const httpRun = await runRounds('tail-transport', { model: 'gpt-5.6' });
  const sent = httpRun.records.map((record) => JSON.parse(record.text));
  assert.equal(httpRun.records.every((record) => record.kind === 'http'), true);
  assert.equal(sent.length, 4);
  // 'task' 在前三次请求里都是尾巴之前最后一个可承载项；第四次（新回合）换成新的用户消息 'next'，
  // 同时在上一回合的用户输入 'task' 上放一个读取断点，读到前三次写下的前缀（改动前只读到开发者指令）。
  assert.deepEqual(simulateExplicitCache(sent), [0, 2, 2, 2]);
  for (const [index, body] of sent.entries()) {
    assert.deepEqual(body, httpRun.dryRuns[index], `round ${index + 1}: dry-run shows exactly what is sent`);
    assert.equal(JSON.stringify(body.input.at(-1)).includes('prompt_cache_breakpoint'), false, `round ${index + 1}: tail unmarked`);
    const lastUser = body.input.findLastIndex((item, itemIndex) => item.role === 'user' && itemIndex < body.input.length - 1);
    assert.deepEqual(breakpointIndexes(body.input), lastUser === 1 ? [0, 1] : [0, 1, lastUser], `round ${index + 1}`);
    assert.ok(breakpointIndexes(body.input).length <= 4, `round ${index + 1}: at most four breakpoints`);
  }

  for (const only of [0, 2]) {
    const fallback = await runRounds('tail-transport', { model: 'gpt-5.6', transport: 'websocket' }, { terminateWebSocket: true, only });
    assert.ok(fallback.traces.some((trace) => trace.phase === 'http_fallback'), `round ${only + 1}: fell back to HTTP`);
    const bodies = fallback.records.filter((record) => record.kind === 'http');
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].text.replaceAll(fallback.baseUrl, 'BASE'), httpRun.records[only].text.replaceAll(httpRun.baseUrl, 'BASE'),
      `round ${only + 1}: the HTTP fallback sends the same bytes as the HTTP transport`);
  }
});

test('WebSocket 续接链：尾巴与它的断点随链留在原位，每一帧读到上一帧发出的全部内容；WS dry-run 与首帧一致', async () => {
  const run = await runRounds('tail-ws', { model: 'gpt-5.6', transport: 'websocket' });
  const frames = run.records.filter((record) => record.kind === 'ws');
  assert.equal(frames.length, 4);
  const bodies = frames.map((frame) => JSON.parse(frame.text));
  assert.deepEqual(bodies.map((body) => body.previous_response_id), [undefined, 'resp_1', 'resp_2', 'resp_3']);
  for (const [index, body] of bodies.entries()) {
    // 续接帧只发新增输入；尾巴在服务端会话里不再移动，断点照旧放在本帧最新的可承载块（尾巴）上。
    assert.deepEqual(breakpointIndexes(body.input).at(-1), body.input.length - 1, `frame ${index + 1}: newest carrier`);
    assert.equal(isTailItem(body.input.at(-1), `round-${index + 1}`), true, `frame ${index + 1}: the tail is the reminder`);
  }
  const reads = simulateExplicitCache(bodies, (_body, index) => ({ items: frames[index].conversation, frameStart: frames[index].frameStart }));
  // 每一帧读到的正好是上一帧结束时服务端会话的全部输入（上一帧的尾巴也在里面）。
  assert.deepEqual(reads, [0, frames[0].conversation.length, frames[1].conversation.length, frames[2].conversation.length]);
  const firstFrame = bodies[0];
  assert.deepEqual(run.dryRuns[0].input, firstFrame.input, 'the WebSocket dry-run shows the first (full) frame');
  assert.deepEqual(run.dryRuns[0].prompt_cache_options, firstFrame.prompt_cache_options);
});

// ---- 逐字节回归：以下摘要由改动前的构建（codex/agent-collaboration 84bdbed9 + unified-llm-provider 0.1.37-limcode.6）
// 用同一套请求录制。非 explicit 模式、GPT-5.6 之前的模型、其他 provider（含 Claude）与 WebSocket 续接链必须不变。

const DRY_RUN_BASELINE = [
  { name: 'responses-gpt-5.6-key', config: { model: 'gpt-5.6', promptCache: KEY }, digest: '0d1e3c089b2f445a75889c79753b7d288afae44f1c57bfdfffc5af10e77a75cb' },
  { name: 'responses-gpt-5.6-off', config: { model: 'gpt-5.6', promptCache: OFF }, digest: 'b561ce5cf42f1f1adada6a4c533270bde8eddb0ac039c9e1521c271f2b174c0f' },
  { name: 'responses-gpt-5.5-explicit', config: { model: 'gpt-5.5', promptCache: EXPLICIT }, digest: '7a218bd5513c1f79cfa582ffac2b1d182850bb76b1707498b88625454353462e' },
  { name: 'responses-gpt-5.4-explicit', config: { model: 'gpt-5.4', promptCache: EXPLICIT }, digest: '8577a7a999fc58581229cccab09ffcd0bae3a3ab370f88be3c30f97ab9e5bebd' },
  { name: 'responses-ws-gpt-5.6-explicit', config: { model: 'gpt-5.6', transport: 'websocket', promptCache: EXPLICIT }, digest: '0bd835a00dea2221caf2c3148da270d76f5c03f3c3a621a3b7f9a546945c4e09' },
  { name: 'responses-ws-gpt-5.6-key', config: { model: 'gpt-5.6', transport: 'websocket', promptCache: KEY }, digest: 'c5cee6f6ea6eceaa1dcedc5e8e5032012db857ef5e418e3826c6b73b043d3be5' },
  { name: 'compatible-gpt-5.6', config: { model: 'gpt-5.6', provider: 'openai-compatible', promptCache: EXPLICIT }, digest: 'c1cb6a71fc469202d32d58e7023951bc17a76945d4b6a4b539137df704660406' },
  { name: 'gemini', config: { model: 'gemini-3-pro-preview', provider: 'gemini', promptCache: EXPLICIT }, digest: 'da52f34b200c39d5acb1c7410544df3ce6d9b9ad31ecfe6271962b69f51eef31' },
  { name: 'claude', config: { model: 'claude-opus-5-5', provider: 'claude', promptCache: { enabled: true, mode: 'explicit', ttl: '5m' } }, digest: '100e5977a37281498c53142c170acf81bcd79095e79d9e04ff7a8399c5346327' }
];

test('非 explicit 模式、GPT-5.6 之前的模型、其他 provider 与 WebSocket：dry-run 与改动前构建逐字节一致', async () => {
  const actual = [];
  for (const scenario of DRY_RUN_BASELINE) {
    const modelId = scenario.config.model;
    const provider = scenario.config.provider ?? 'openai-responses';
    const bodies = [];
    for (const reinject of [false, true]) {
      for (let k = 1; k <= 3; k += 1) {
        bodies.push(await dryRunBody(fullRequest({ modelId, provider, context: loopContext(k, modelId), reminderText: reminder(k), reinject }), scenario.config));
      }
    }
    actual.push({ name: scenario.name, digest: sha256(JSON.stringify(bodies)) });
  }
  assert.deepEqual(actual, DRY_RUN_BASELINE.map(({ name, digest }) => ({ name, digest })));
});

const WIRE_BASELINE = [
  { name: 'ws-gpt-5.6-explicit', config: { model: 'gpt-5.6', transport: 'websocket', promptCache: EXPLICIT }, digest: '94a84c8aaef881b4f30ecff543dd4facd54c9f3cc867bb275e06c654b5ed4cdc' },
  { name: 'ws-gpt-6-sol-explicit', config: { model: 'gpt-6-sol', transport: 'websocket', promptCache: EXPLICIT }, digest: 'aebba2f2b04105852fbfb4c861bd1adc168f30422a236c26e669757867cdf70c' },
  { name: 'http-gpt-5.6-key', config: { model: 'gpt-5.6', promptCache: KEY }, digest: '1c113937ab191f6f489b79da29432f45530a9b937757ab1ad3f1ed57ca0395c9' },
  { name: 'http-gpt-5.5-explicit', config: { model: 'gpt-5.5', promptCache: EXPLICIT }, digest: '52df107670945b85cbe7bc63eddc847bcd0b32b8136481da66e24d894bca4944' }
];

test('WebSocket 续接链与非 explicit 的 HTTP：线上请求与改动前构建逐字节一致', async () => {
  const actual = [];
  for (const scenario of WIRE_BASELINE) {
    const run = await runRounds(`wire-${scenario.name}`, scenario.config);
    actual.push({ name: scenario.name, digest: sha256(run.records.map((record) => `${record.kind}:${record.text.replaceAll(run.baseUrl, 'BASE')}`).join('\n')) });
  }
  assert.deepEqual(actual, WIRE_BASELINE.map(({ name, digest }) => ({ name, digest })));
});
