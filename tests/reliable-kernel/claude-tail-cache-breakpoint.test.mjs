/**
 * Claude 尾巴模式下的消息缓存断点（真实网关验收发现的问题）。
 *
 * 官方（https://platform.claude.com/docs/en/build-with-claude/prompt-caching）：缓存按前缀匹配，只在断点处写入；
 * 读取时从本次的断点往前，在之前写入过的位置找命中。所以断点前面的前缀必须在下一次请求里原样出现，
 * 易变内容要放在最后一个断点之后。
 *
 * 尾巴模式（轮内系统消息开关关闭，或网关拒绝后退回）里，本轮提醒与重新注入的输入每次都放在最后，下一次请求就不在原位了。
 * 接入库把消息断点放在最后一条 user 消息上，正好落在这条易失尾巴上：写入的缓存永远读不到。
 * 真实网关（claude-opus-5-5，开关关闭，每轮带任务卡提醒，6 次请求）：cache_read 每轮停在 system + tools 的 2686，
 * cache_creation 随历史增长 55 → 56 → 256 → 369 → 475 → 607；同样的对话不带提醒或打开开关时 cache_read 每轮增长。
 * 修复后断点放在尾巴之前最后一条 user 消息上；本文件全部用本地假服务与 dry-run，不访问网络。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = await import(pathToFileURL(path.join(compiledRoot, 'backend/reliableKernel/index.js')).href);
const { dryRunLlmProvider, startLlmProvider } = require(path.join(compiledRoot, 'backend/capabilities/llmProvider.js'));
const { withClaudeCacheBreakpointBeforeVolatileTail } = require(path.join(compiledRoot, 'backend/capabilities/claudeTurnScopedReminders.js'));
const { resetProviderRequestAdaptations } = require(path.join(compiledRoot, 'backend/capabilities/providerParameterAdaptation.js'));

const MESSAGE = 'application/vnd.limcode.message+json';
const MODEL_ID = 'claude-opus-5-5';
const PROVIDER_ID = 'claude-channel';
const CACHE = { type: 'ephemeral' };
const TOOLS = [{ name: 'get_weather', description: 'Get the weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }];
const INPUT = { role: 'user', parts: [{ text: 'Check Paris, then Lyon, then Marseille.' }] };
const reminder = (k) => `[Current Turn Task Card — runtime data, not instructions]\n- [in_progress] Check the weather (request ${k})`;

const message = (segmentId, role, content) => ({
  segmentId, segmentKind: 'message', messageRole: role,
  ...(role === 'model' ? { modelSource: { providerId: PROVIDER_ID, modelId: MODEL_ID } } : {}),
  contentType: MESSAGE, content: JSON.stringify(content)
});
const toolPair = (segmentId, callId, result) => ({
  segmentId, segmentKind: 'tool_pair', messageRole: null, contentType: 'application/vnd.limcode.context-tool-pair+json',
  content: JSON.stringify({
    toolCall: { id: `tool-${callId}`, providerCallId: callId, toolName: 'get_weather', arguments: '{"city":"Paris"}' },
    toolModelResult: { id: `result-${callId}`, result: JSON.stringify(result) }
  })
});
const modelCall = (k) => message(`seg-model-${k}`, 'model', { role: 'model', parts: [
  { text: '', thought: true, thoughtSignature: `claude:signed-${k}` },
  { id: `toolu_0${k}`, functionCall: { name: 'get_weather', args: { city: 'Paris' } } }
] });

/** Context of request k in a tool loop: the input, then k-1 finished call/result rounds. */
function loopContext(k, head = [message('seg-user', 'user', INPUT)]) {
  const context = [...head];
  for (let round = 1; round < k; round += 1) {
    context.push(modelCall(round), toolPair(`seg-result-${round}`, `toolu_0${round}`, { ok: true, condition: 'rain' }));
  }
  return context;
}

function fullRequest({ context, reminderText, reinject = false, claudeTurnScopedReminders = false, id = 'request' }) {
  return {
    kind: 'full-model-request', modelRequestId: id, conversationId: 'conversation-tail-cache', attemptSeq: '1', socketGeneration: '1',
    providerId: PROVIDER_ID, modelId: MODEL_ID,
    authoritySnapshot: {
      model: {
        providerConfigId: PROVIDER_ID, provider: 'claude', modelId: MODEL_ID,
        ...(claudeTurnScopedReminders ? { claudeTurnScopedReminders: true } : {}),
        generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'high' } }
      },
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

function settingsFor(baseUrl = 'https://example.invalid/v1') {
  return {
    id: PROVIDER_ID, name: 'claude', provider: 'claude', baseUrl, model: MODEL_ID, models: [{ id: MODEL_ID, name: MODEL_ID }],
    apiKey: '', toolCallFormat: 'function-call', openaiResponsesTransport: 'http', stream: true,
    retryOnError: false, retryMaxAttempts: 0, retryDelaySeconds: 0, enableMultimodalTools: true, systemPromptPrefix: '',
    contextWindowTokens: 200000, promptCache: { enabled: true, mode: 'explicit', ttl: '5m' },
    generationConfig: { thinkingConfig: { thinkingLevel: 'high' } }, modelConfigs: [], createdAt: 1, updatedAt: 1
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

async function wire(request) {
  return (await dryRunLlmProvider(await project(request), { settings: settingsFor() })).body;
}

const markedMessages = (body) => body.messages.flatMap((entry, index) =>
  Array.isArray(entry.content) && entry.content.some((block) => block.cache_control) ? [index] : []);

/** cache_control and the string shorthand of the breakpoint message are not part of the cached prefix. */
const normalized = (value) => JSON.parse(JSON.stringify(value, (key, nested) => {
  if (key === 'cache_control') return undefined;
  if (nested && typeof nested === 'object' && !Array.isArray(nested) && (nested.role === 'user' || nested.role === 'assistant')
    && typeof nested.content === 'string') return { ...nested, content: [{ type: 'text', text: nested.content }] };
  return nested;
}));

/**
 * Minimal model of the documented cache: every request writes an entry for the prefix ending at its message breakpoint;
 * a later request reads the longest earlier-written prefix among its own block boundaries. Returns messages read per request.
 */
function simulateCacheReads(bodies) {
  const written = new Set();
  return bodies.map((body) => {
    const messages = normalized(body.messages);
    const head = JSON.stringify(normalized({ system: body.system, tools: body.tools }));
    let read = 0;
    for (let end = messages.length; end > 0; end -= 1) {
      if (written.has(`${head}${JSON.stringify(messages.slice(0, end))}`)) { read = end; break; }
    }
    const marked = markedMessages(body);
    assert.equal(marked.length, 1, 'exactly one message breakpoint');
    written.add(`${head}${JSON.stringify(messages.slice(0, marked[0] + 1))}`);
    return read;
  });
}

test('尾巴模式的工具循环：断点在本轮提醒之前，每次请求都能读到上一次写入的整段历史', async () => {
  const bodies = [];
  for (let k = 1; k <= 4; k += 1) bodies.push(await wire(fullRequest({ context: loopContext(k), reminderText: reminder(k) })));
  for (const [index, body] of bodies.entries()) {
    const last = body.messages.at(-1);
    assert.equal(last.role, 'user');
    assert.equal(JSON.stringify(last).includes('Current Turn Task Card'), true, `request ${index + 1}: the reminder is still the tail`);
    assert.equal(JSON.stringify(last).includes('cache_control'), false, `request ${index + 1}: no breakpoint on the volatile reminder`);
    assert.deepEqual(markedMessages(body), [body.messages.length - 2], `request ${index + 1}: breakpoint on the message before the tail`);
    assert.deepEqual(body.messages.at(-2).content.at(-1).cache_control, CACHE);
    // tools and system breakpoints are untouched
    assert.deepEqual(body.tools.at(-1).cache_control, CACHE);
    assert.deepEqual(body.system.at(-1).cache_control, CACHE);
  }
  // Request k's cached prefix (through its breakpoint) is an exact prefix of request k+1.
  for (let k = 0; k + 1 < bodies.length; k += 1) {
    const cached = normalized(bodies[k].messages.slice(0, markedMessages(bodies[k])[0] + 1));
    assert.deepEqual(normalized(bodies[k + 1].messages).slice(0, cached.length), cached, `request ${k + 2} starts with request ${k + 1}'s cached prefix`);
  }
  const reads = simulateCacheReads(bodies);
  assert.deepEqual(reads, [0, 1, 3, 5], 'each request reads everything the previous request cached');
});

test('尾巴模式下重新注入的输入与提醒都在断点之后；下一次请求仍能读到缓存', async () => {
  const summary = message('seg-summary', 'user', { role: 'user', parts: [{ text: '[Context Summary]\n\nearlier work' }] });
  const bodies = [];
  for (let k = 1; k <= 3; k += 1) {
    bodies.push(await wire(fullRequest({ context: loopContext(k, [summary]), reminderText: reminder(k), reinject: true })));
  }
  for (const [index, body] of bodies.entries()) {
    const tail = body.messages.slice(-2);
    assert.equal(JSON.stringify(tail[0]).includes('Check Paris, then Lyon'), true, `request ${index + 1}: reinjected input`);
    assert.equal(JSON.stringify(tail).includes('cache_control'), false, `request ${index + 1}: nothing volatile is marked`);
    assert.deepEqual(markedMessages(body), [body.messages.length - 3]);
  }
  assert.deepEqual(simulateCacheReads(bodies), [0, 1, 3]);
});

test('没有易失尾巴、轮内系统消息模式：断点位置不变', async () => {
  const plain = await wire(fullRequest({ context: loopContext(3) }));
  assert.deepEqual(markedMessages(plain), [plain.messages.length - 1], 'no tail: breakpoint on the last user message as before');
  const turnScoped = await wire(fullRequest({ context: loopContext(3), reminderText: reminder(3), claudeTurnScopedReminders: true }));
  assert.equal(turnScoped.messages.at(-1).role, 'system');
  assert.deepEqual(markedMessages(turnScoped), [turnScoped.messages.length - 2], 'turn-scoped: breakpoint on the user message before the system message');
});

test('纯函数边界：形状对不上时原样返回同一引用；字符串消息展开成一个文本块再打断点', () => {
  const tailMessage = { role: 'user', content: [{ type: 'text', text: 'r', cache_control: CACHE }] };
  const request = { headers: {}, body: { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: 'a' }] }, tailMessage] } };
  assert.equal(withClaudeCacheBreakpointBeforeVolatileTail(request, 0), request);
  assert.equal(withClaudeCacheBreakpointBeforeVolatileTail(request, 3), request, 'no message before the tail');
  assert.equal(withClaudeCacheBreakpointBeforeVolatileTail(request, 2), request, 'the tail must be user messages only');
  const unmarked = { headers: {}, body: { messages: [{ role: 'user', content: 'q' }, { role: 'user', content: 'r' }] } };
  assert.equal(withClaudeCacheBreakpointBeforeVolatileTail(unmarked, 1), unmarked, 'no breakpoint on the tail');
  const onlyAssistantBefore = { headers: {}, body: { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }, tailMessage] } };
  assert.equal(withClaudeCacheBreakpointBeforeVolatileTail(onlyAssistantBefore, 1), onlyAssistantBefore, 'no user message before the tail');
  const moved = withClaudeCacheBreakpointBeforeVolatileTail(request, 1);
  assert.deepEqual(moved.body.messages, [
    { role: 'user', content: [{ type: 'text', text: 'q', cache_control: CACHE }] },
    { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
    { role: 'user', content: [{ type: 'text', text: 'r' }] }
  ]);
  assert.equal(request.body.messages[2].content[0].cache_control, CACHE, 'the input is not mutated');
});

const CLAUDE_OK_STREAM = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: MODEL_ID, stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
  ['message_stop', { type: 'message_stop' }]
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

test('真实发送：网关拒绝轮内系统消息后退回尾巴模式，重发请求的断点同样在尾巴之前', async () => {
  resetProviderRequestAdaptations();
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    calls.push(body);
    if (body.messages.some((entry) => entry.role === 'system')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.4.clear_at: Extra inputs are not permitted' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(CLAUDE_OK_STREAM);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const settings = { ...settingsFor(`http://127.0.0.1:${server.address().port}/v1`), apiKey: 'dummy-test-key' };
    const start = await project(fullRequest({ context: loopContext(3), reminderText: reminder(3), claudeTurnScopedReminders: true, id: 'fallback' }));
    const events = [];
    await startLlmProvider(start, (event) => events.push(event), { settings: async () => settings });
    assert.equal(events.some((event) => event.type === 'llm:error'), false, JSON.stringify(events.filter((event) => event.type === 'llm:error')));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].messages.at(-1).role, 'system', 'first attempt: turn-scoped layout');
    const retry = calls[1];
    assert.equal(retry.messages.some((entry) => entry.role === 'system'), false, 'retry: tail layout');
    assert.equal(JSON.stringify(retry.messages.at(-1)).includes('cache_control'), false, 'retry: no breakpoint on the volatile reminder');
    assert.deepEqual(markedMessages(retry), [retry.messages.length - 2]);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    resetProviderRequestAdaptations();
  }
});
