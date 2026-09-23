const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');

const {
  resetOpenAIResponsesWebSocketSessions,
  streamOpenAIResponsesWebSocketSession
} = require(path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension', 'backend/capabilities/openAIResponsesWebSocketSession.js'));

async function formatForTest() {
  const unified = await import('unified-llm-provider');
  return new unified.OpenAIResponsesFormat('gpt-6-astra');
}

function requestBody(format, contents, overrides = {}) {
  return {
    ...format.encodeRequest({ contents }, true),
    ...overrides
  };
}

function user(text) {
  return { role: 'user', parts: [{ text }] };
}

function model(text) {
  return { role: 'model', parts: [{ text }] };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageItem(id, text, outputIndex) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }]
  };
}

function sendMessageResponse(socket, id, itemId, text, outputIndex = 0, options = {}) {
  const streamFields = options.streamId ? { stream_id: options.streamId } : {};
  socket.send(JSON.stringify({ type: 'response.created', ...streamFields, response: { id, ...(options.previousResponseId ? { previous_response_id: options.previousResponseId } : {}) } }));
  socket.send(JSON.stringify({
    type: 'response.output_text.delta',
    ...streamFields,
    response_id: id,
    item_id: itemId,
    output_index: outputIndex,
    content_index: 0,
    delta: text
  }));
  socket.send(JSON.stringify({
    type: 'response.output_item.done',
    ...streamFields,
    response_id: id,
    output_index: outputIndex,
    item: messageItem(itemId, text, outputIndex)
  }));
  socket.send(JSON.stringify({
    type: 'response.completed',
    ...streamFields,
    response: {
      id,
      status: 'completed',
      output: [],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
    }
  }));
}

async function createServer(onRequest, serverOptions = {}) {
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    perMessageDeflate: false,
    ...serverOptions
  });
  await once(server, 'listening');
  let connection = 0;
  server.on('connection', (socket, upgradeRequest) => {
    const connectionIndex = connection++;
    socket.on('message', (raw) => {
      const payloadText = raw.toString();
      onRequest(socket, JSON.parse(payloadText), connectionIndex, upgradeRequest, payloadText);
    });
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/v1/responses`,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function drive(options, onChunk) {
  const chunks = [];
  for await (const chunk of streamOpenAIResponsesWebSocketSession(options)) {
    chunks.push(chunk);
    if (onChunk) await onChunk(chunk);
  }
  return chunks;
}

async function collect(options) {
  return drive(options);
}

function streamOptions(server, format, sessionKey, body, overrides = {}) {
  return {
    sessionKey,
    url: server.url,
    headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' },
    body,
    format,
    ...overrides
  };
}

function nativeOptions(flags, holder = { calls: [] }) {
  return {
    steering: flags.steering === true,
    reasoningUpdates: flags.reasoningUpdates === true,
    multiplexing: flags.multiplexing === true,
    onController(controller) {
      holder.calls.push(controller);
      holder.controller = controller ?? undefined;
    }
  };
}

function nativeEvents(chunks) {
  return chunks.filter((chunk) => chunk.nativeEvent).map((chunk) => chunk.nativeEvent);
}

function streamedText(chunks) {
  return chunks.map((chunk) => chunk.textDelta ?? '').join('');
}

test('完整历史首 create 准入实际发送结果，增量首 create 不冒认未重发的历史结果', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const format = await formatForTest();
  const frames = [];
  const server = await createServer((socket, request) => {
    frames.push(request);
    sendMessageResponse(socket, `resp_history_${frames.length}`, `msg_history_${frames.length}`,
      frames.length === 1 ? 'history admitted' : 'next answer', 0,
      request.previous_response_id ? { previousResponseId: request.previous_response_id } : {});
  });
  const initialInput = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '{"type":"function_call_output","call_id":"call_text"}' }] },
    { type: 'function_call', call_id: 'call_history', name: 'probe', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call_history', output: 'history result' },
    { type: 'custom_tool_call_output', call_id: 'call_custom', output: 'custom result' },
    { type: 'reasoning', call_id: 'call_not_a_result', summary: [], encrypted_content: '{"type":"function_call_output","call_id":"call_encrypted"}' },
    { type: 'mcp_approval_response', approval_request_id: 'approval_only', approve: true }
  ];
  const options = { native: nativeOptions({}), timeouts: { firstEventMs: 2000, eventIdleMs: 2000, responseMs: 8000 } };
  try {
    const first = await collect(streamOptions(server, format, 'native-history-admission',
      requestBody(format, [], { input: initialInput }), options));
    const firstCreated = nativeEvents(first).find((event) => event.type === 'response.created');
    const actualIds = frames[0].input
      .filter((item) => ['function_call_output', 'custom_tool_call_output'].includes(item.type))
      .map((item) => item.call_id);
    assert.deepEqual(actualIds, ['call_history', 'call_custom']);
    assert.deepEqual(firstCreated.admittedToolResultCallIds, actualIds);
    assert.equal(firstCreated.responseCreateSeq, '1');

    const decisions = [];
    const next = await collect(streamOptions(server, format, 'native-history-admission',
      requestBody(format, [], {
        input: [...initialInput, ...format.encodeRequest({ contents: [model('history admitted'), user('continue')] }, true).input]
      }), { ...options, onDecision: (decision) => decisions.push(decision) }));
    assert.equal(decisions[0].mode, 'incremental');
    assert.equal(frames[1].previous_response_id, 'resp_history_1');
    assert.equal(frames[1].input.length, 1);
    assert.ok(frames[1].input.every((item) => item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output'));
    assert.equal(nativeEvents(next).find((event) => event.type === 'response.created').admittedToolResultCallIds, undefined);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('原生转向被接受后以自动续接完成，steered 不完整不失败且续接链可增量延续', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const format = await formatForTest();
  const frames = [];
  const server = await createServer((socket, request, connection) => {
    frames.push({ request, connection });
    if (request.type === 'response.create') {
      if (request.previous_response_id === 'resp_2') {
        socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_3', previous_response_id: 'resp_2' } }));
        socket.send(JSON.stringify({
          type: 'response.completed',
          response: { id: 'resp_3', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 0, total_tokens: 3 } }
        }));
        return;
      }
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }));
      socket.send(JSON.stringify({
        type: 'response.output_text.delta',
        response_id: 'resp_1',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: '草稿'
      }));
      return;
    }
    if (request.type === 'response.steer') {
      socket.send(JSON.stringify({ type: 'response.steer.accepted', steer: { id: 'steer_1', previous_response_id: 'resp_1' } }));
      socket.send(JSON.stringify({
        type: 'response.output_item.done',
        response_id: 'resp_1',
        output_index: 0,
        item: messageItem('msg_1', '草稿', 0)
      }));
      socket.send(JSON.stringify({
        type: 'response.incomplete',
        response: { id: 'resp_1', status: 'incomplete', incomplete_details: { reason: 'steered' } }
      }));
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_2', previous_response_id: 'resp_1' } }));
      socket.send(JSON.stringify({
        type: 'response.output_text.delta',
        response_id: 'resp_2',
        item_id: 'msg_2',
        output_index: 0,
        content_index: 0,
        delta: '小计划'
      }));
      socket.send(JSON.stringify({
        type: 'response.output_item.done',
        response_id: 'resp_2',
        output_index: 0,
        item: messageItem('msg_2', '小计划', 0)
      }));
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp_2', status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } }
      }));
    }
  });
  const holder = { calls: [] };
  try {
    const native = nativeOptions({ steering: true }, holder);
    let steered = false;
    let steerPromise;
    const chunks = await drive(
      streamOptions(server, format, 'native-steer-chain', requestBody(format, [user('写一份项目计划')]), {
        native,
        timeouts: { firstEventMs: 2000, eventIdleMs: 2000, responseMs: 8000 }
      }),
      async (chunk) => {
        if (!steered && chunk.nativeEvent?.type === 'response.created') {
          steered = true;
          steerPromise = holder.controller.steer({
            submissionId: 'sub-1',
            input: [user('两周内由一名开发者完成')]
          });
        }
      }
    );
    await steerPromise;

    const events = nativeEvents(chunks);
    assert.deepEqual(events.map((event) => event.type), [
      'response.created',
      'response.steer.submitted',
      'response.steer.accepted',
      'response.incomplete',
      'response.created',
      'response.completed'
    ]);
    assert.deepEqual(events.map((event) => event.responseId), [
      'resp_1', 'resp_1', 'resp_1', 'resp_1', 'resp_2', 'resp_2'
    ]);
    assert.equal(events[1].submissionId, 'sub-1');
    assert.equal(events[2].steerId, 'steer_1');
    assert.equal(events[3].reason, 'steered');
    assert.equal(events[4].previousResponseId, 'resp_1');
    assert.equal(streamedText(chunks), '草稿小计划');
    assert.ok(!chunks.some((chunk) => chunk.error), 'steered incomplete must not surface as an error');

    // The wire steer carries only type/previous_response_id/input; the local submissionId never leaves.
    assert.equal(frames.length, 2);
    const steerFrame = frames[1].request;
    assert.equal(steerFrame.type, 'response.steer');
    assert.deepEqual(Object.keys(steerFrame).sort(), ['input', 'previous_response_id', 'type']);
    assert.equal(steerFrame.previous_response_id, 'resp_1');
    assert.match(JSON.stringify(steerFrame.input), /两周内由一名开发者完成/);
    assert.equal(holder.calls.length, 2);
    assert.equal(holder.calls[1], undefined);

    // The logical chain commits a continuation tail that a later turn can continue incrementally.
    const decisions = [];
    await collect(streamOptions(
      server,
      format,
      'native-steer-chain',
      requestBody(format, [
        user('写一份项目计划'),
        model('草稿'),
        user('两周内由一名开发者完成'),
        model('小计划'),
        user('继续')
      ]),
      {
        native: nativeOptions({ steering: true }),
        onDecision: (decision) => decisions.push(decision),
        timeouts: { firstEventMs: 2000, eventIdleMs: 2000, responseMs: 8000 }
      }
    ));
    const continuationCreate = frames[2].request;
    assert.equal(continuationCreate.type, 'response.create');
    assert.equal(continuationCreate.previous_response_id, 'resp_2');
    assert.equal(continuationCreate.input.length, 1);
    assert.match(JSON.stringify(continuationCreate.input[0]), /继续/);
    assert.doesNotMatch(JSON.stringify(continuationCreate.input), /草稿|小计划|两周内/);
    assert.equal(decisions[0].mode, 'incremental');
    assert.equal(decisions[0].reason, 'matched_exact_prefix');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('原生转向在已完成竞先后仍然续接且不失联', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const format = await formatForTest();
  const server = await createServer((socket, request) => {
    if (request.type === 'response.create') {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }));
      socket.send(JSON.stringify({
        type: 'response.output_text.delta',
        response_id: 'resp_1',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: '初稿'
      }));
      return;
    }
    if (request.type === 'response.steer') {
      // The original response completes before the steer is accepted; a continuation still follows.
      socket.send(JSON.stringify({
        type: 'response.output_item.done',
        response_id: 'resp_1',
        output_index: 0,
        item: messageItem('msg_1', '初稿', 0)
      }));
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 } }
      }));
      socket.send(JSON.stringify({ type: 'response.steer.accepted', steer: { id: 'steer_race', previous_response_id: 'resp_1' } }));
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_2', previous_response_id: 'resp_1' } }));
      socket.send(JSON.stringify({
        type: 'response.output_text.delta',
        response_id: 'resp_2',
        item_id: 'msg_2',
        output_index: 0,
        content_index: 0,
        delta: '修订'
      }));
      socket.send(JSON.stringify({
        type: 'response.output_item.done',
        response_id: 'resp_2',
        output_index: 0,
        item: messageItem('msg_2', '修订', 0)
      }));
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp_2', status: 'completed', output: [], usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } }
      }));
    }
  });
  const holder = { calls: [] };
  try {
    let steered = false;
    const chunks = await drive(
      streamOptions(server, format, 'native-steer-race', requestBody(format, [user('起草')]), {
        native: nativeOptions({ steering: true }, holder),
        timeouts: { firstEventMs: 2000, eventIdleMs: 2000, responseMs: 8000 }
      }),
      async (chunk) => {
        if (!steered && chunk.nativeEvent?.type === 'response.created') {
          steered = true;
          await holder.controller.steer({ submissionId: 'sub-race', input: [user('改短')] });
        }
      }
    );
    const events = nativeEvents(chunks);
    assert.deepEqual(events.map((event) => event.type), [
      'response.created',
      'response.steer.submitted',
      'response.completed',
      'response.steer.accepted',
      'response.created',
      'response.completed'
    ]);
    assert.equal(streamedText(chunks), '初稿修订');
    assert.ok(!chunks.some((chunk) => chunk.error));
    assert.equal(holder.calls.at(-1), undefined);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('转向等待必需输入时提交工具结果恢复续接且不重复转向输入', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const format = await formatForTest();
  const frames = [];
  const tools = [{
    type: 'function',
    name: 'get_project_status',
    description: '查询项目状态',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }];
  const server = await createServer((socket, request, connection) => {
    frames.push({ request, connection });
    if (request.type === 'response.create' && !request.previous_response_id) {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }));
      socket.send(JSON.stringify({
        type: 'response.output_item.done',
        response_id: 'resp_1',
        output_index: 0,
        item: { id: 'fc_1', type: 'function_call', call_id: 'call_project', name: 'get_project_status', arguments: '{}' }
      }));
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 } }
      }));
      return;
    }
    if (request.type === 'response.steer') {
      socket.send(JSON.stringify({ type: 'response.steer.accepted', steer: { id: 'steer_wait', previous_response_id: 'resp_1' } }));
      socket.send(JSON.stringify({
        type: 'response.steer.pending',
        steer: { id: 'steer_wait', previous_response_id: 'resp_1' },
        reason: 'waiting_for_required_input',
        required_input: [{ type: 'function_call_output', call_id: 'call_project', name: 'get_project_status' }]
      }));
      return;
    }
    if (request.type === 'response.create' && request.previous_response_id === 'resp_1') {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_2', previous_response_id: 'resp_1' } }));
      socket.send(JSON.stringify({
        type: 'response.output_text.delta',
        response_id: 'resp_2',
        item_id: 'msg_2',
        output_index: 0,
        content_index: 0,
        delta: '更新后的计划'
      }));
      socket.send(JSON.stringify({
        type: 'response.output_item.done',
        response_id: 'resp_2',
        output_index: 0,
        item: messageItem('msg_2', '更新后的计划', 0)
      }));
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp_2', status: 'completed', output: [], usage: { input_tokens: 11, output_tokens: 4, total_tokens: 15 } }
      }));
    }
  });
  const holder = { calls: [] };
  try {
    let acted = false;
    let admissionPromise;
    const chunks = await drive(
      streamOptions(server, format, 'native-steer-required', requestBody(format, [user('先查状态再出计划')], { tools }), {
        native: nativeOptions({ steering: true }, holder),
        timeouts: { firstEventMs: 2000, eventIdleMs: 400, responseMs: 8000 }
      }),
      async (chunk) => {
        if (chunk.nativeEvent?.type === 'response.created' && !acted) {
          acted = true;
          await holder.controller.steer({ submissionId: 'sub-wait', input: [user('先别开工')] });
          return;
        }
        if (chunk.nativeEvent?.type === 'response.steer.pending' && !admissionPromise) {
          // Capture only: the admission resolves when this same generator processes the matching
          // response.created, so awaiting it inside the consumer callback would deadlock.
          admissionPromise = holder.controller.submitToolResults([{
            type: 'function_call_output',
            callId: 'call_project',
            output: '{"status":"设计完成"}'
          }]);
        }
      }
    );
    const admission = await admissionPromise;

    const events = nativeEvents(chunks);
    assert.deepEqual(events.map((event) => event.type), [
      'response.created',
      'response.steer.submitted',
      'response.completed',
      'response.steer.accepted',
      'response.steer.pending',
      'response.created',
      'response.completed'
    ]);
    const pending = events.find((event) => event.type === 'response.steer.pending');
    assert.deepEqual(pending.requiredInput, [{ type: 'function_call_output', callId: 'call_project', name: 'get_project_status' }]);

    // Admission resolves with the identity captured from the matching response.created.
    assert.equal(admission.responseId, 'resp_2');
    assert.equal(admission.previousResponseId, 'resp_1');
    assert.equal(typeof admission.connectionGeneration, 'number');

    // The continuation create carries frozen original settings, the latest response ID and only
    // the tool output: the accepted steering is server-prepended, never repeated by the client.
    const continuation = frames.find((frame) => frame.request.type === 'response.create' && frame.request.previous_response_id === 'resp_1');
    assert.deepEqual(continuation.request.input, [{
      type: 'function_call_output',
      call_id: 'call_project',
      output: '{"status":"设计完成"}'
    }]);
    assert.doesNotMatch(JSON.stringify(continuation.request.input), /先别开工/);
    assert.deepEqual(continuation.request.tools, frames[0].request.tools);
    assert.equal(continuation.request.model, frames[0].request.model);
    assert.equal(continuation.request.store, false);
    assert.equal(streamedText(chunks), '更新后的计划');
    assert.equal(holder.calls.at(-1), undefined);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('异步调用待提交期间保持流与控制器存活并暂停事件空闲超时', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const format = await formatForTest();
  const frames = [];
  const tools = [{
    type: 'function',
    name: 'lookup_weather',
    description: '后台查询天气',
    async: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }];
  const server = await createServer((socket, request, connection) => {
    frames.push({ request, connection });
    if (request.type === 'response.create' && !request.previous_response_id) {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }));
      socket.send(JSON.stringify({
        type: 'response.output_text.delta',
        response_id: 'resp_1',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: '处理中'
      }));
      socket.send(JSON.stringify({
        type: 'response.output_item.done',
        response_id: 'resp_1',
        output_index: 0,
        item: messageItem('msg_1', '处理中', 0)
      }));
      socket.send(JSON.stringify({
        type: 'response.output_item.done',
        response_id: 'resp_1',
        output_index: 1,
        item: { id: 'fc_a', type: 'function_call', call_id: 'call_weather', name: 'lookup_weather', arguments: '{}', async: true }
      }));
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 } }
      }));
      return;
    }
    if (request.type === 'response.create' && request.previous_response_id === 'resp_1') {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_2', previous_response_id: 'resp_1' } }));
      socket.send(JSON.stringify({
        type: 'response.output_text.delta',
        response_id: 'resp_2',
        item_id: 'msg_2',
        output_index: 0,
        content_index: 0,
        delta: '完成'
      }));
      socket.send(JSON.stringify({
        type: 'response.output_item.done',
        response_id: 'resp_2',
        output_index: 0,
        item: messageItem('msg_2', '完成', 0)
      }));
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp_2', status: 'completed', output: [], usage: { input_tokens: 9, output_tokens: 1, total_tokens: 10 } }
      }));
    }
  });
  const holder = { calls: [] };
  try {
    let sawCompleted = false;
    let admissionPromise;
    const chunks = await drive(
      streamOptions(server, format, 'native-async-keepalive', requestBody(format, [user('查天气并继续')], { tools }), {
        native: nativeOptions({}, holder),
        timeouts: { firstEventMs: 2000, eventIdleMs: 150, responseMs: 8000 }
      }),
      async (chunk) => {
        if (chunk.nativeEvent?.type === 'response.completed' && !sawCompleted) {
          sawCompleted = true;
          // The 400ms client-side wait far exceeds the 150ms event-idle deadline; an intentional
          // async-result wait must pause that deadline instead of failing the stream.
          await delay(400);
          assert.notEqual(holder.controller, undefined, 'controller must stay registered past response.completed');
          // Capture only: admission resolves when this generator processes the continuation's
          // response.created; awaiting it inside the consumer callback would deadlock.
          admissionPromise = holder.controller.submitToolResults([{
            type: 'function_call_output',
            callId: 'call_weather',
            output: '{"temp_c":22}'
          }]);
        }
      }
    );
    const admission = await admissionPromise;
    assert.equal(admission.responseId, 'resp_2');
    assert.equal(streamedText(chunks), '处理中完成');
    assert.ok(!chunks.some((chunk) => chunk.error));
    assert.equal(holder.calls.length, 2);
    assert.equal(holder.calls[1], undefined, 'controller unregisters only after the continuation completes');
    const continuation = frames.find((frame) => frame.request.type === 'response.create' && frame.request.previous_response_id === 'resp_1');
    assert.deepEqual(continuation.request.input, [{
      type: 'function_call_output',
      call_id: 'call_weather',
      output: '{"temp_c":22}'
    }]);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('endLogicalRequest 在响应边界结束流并注销控制器', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const format = await formatForTest();
  const frames = [];
  const tools = [{
    type: 'function',
    name: 'slow_lookup',
    async: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }];
  const server = await createServer((socket, request, connection) => {
    frames.push({ request, connection });
    if (request.type !== 'response.create') return;
    socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }));
    socket.send(JSON.stringify({
      type: 'response.output_item.done',
      response_id: 'resp_1',
      output_index: 0,
      item: { id: 'fc_slow', type: 'function_call', call_id: 'call_slow', name: 'slow_lookup', arguments: '{}', async: true }
    }));
    socket.send(JSON.stringify({
      type: 'response.completed',
      response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } }
    }));
  });
  const holder = { calls: [] };
  try {
    const chunks = await drive(
      streamOptions(server, format, 'native-logical-end', requestBody(format, [user('启动后台查询')], { tools }), {
        native: nativeOptions({}, holder),
        timeouts: { firstEventMs: 2000, eventIdleMs: 500, responseMs: 8000 }
      }),
      async (chunk) => {
        if (chunk.nativeEvent?.type === 'response.completed') {
          holder.controller.endLogicalRequest();
        }
      }
    );
    assert.equal(chunks.filter((chunk) => chunk.error).length, 0);
    assert.equal(frames.length, 1, 'no continuation create may escape after logical end');
    assert.equal(holder.calls.at(-1), undefined);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('多车道复用单连接按 stream_id 路由交错事件且车道错误互不影响', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const format = await formatForTest();
  const frames = [];
  let firstLane;
  const server = await createServer((socket, request, connection) => {
    frames.push({ request, connection });
    if (request.type !== 'response.create') return;
    if (!firstLane) {
      firstLane = request.stream_id;
      socket.send(JSON.stringify({ type: 'response.created', stream_id: firstLane, response: { id: 'resp_A1' } }));
      return;
    }
    const secondLane = request.stream_id;
    socket.send(JSON.stringify({ type: 'response.created', stream_id: secondLane, response: { id: 'resp_B1' } }));
    // Both lanes are created; interleave deltas and fail only the first lane.
    socket.send(JSON.stringify({
      type: 'response.output_text.delta', stream_id: firstLane, response_id: 'resp_A1',
      item_id: 'msg_a', output_index: 0, content_index: 0, delta: '甲'
    }));
    socket.send(JSON.stringify({
      type: 'response.output_text.delta', stream_id: secondLane, response_id: 'resp_B1',
      item_id: 'msg_b', output_index: 0, content_index: 0, delta: '乙'
    }));
    socket.send(JSON.stringify({
      type: 'error', stream_id: firstLane, status: 400,
      error: { type: 'invalid_request_error', code: 'previous_response_not_found', message: 'lane A evicted' }
    }));
    socket.send(JSON.stringify({
      type: 'response.output_item.done', stream_id: secondLane, response_id: 'resp_B1',
      output_index: 0, item: messageItem('msg_b', '乙', 0)
    }));
    socket.send(JSON.stringify({
      type: 'response.completed', stream_id: secondLane,
      response: { id: 'resp_B1', status: 'completed', output: [], usage: { input_tokens: 6, output_tokens: 1, total_tokens: 7 } }
    }));
  });
  try {
    const driveLane = (sessionKey) => drive(
      streamOptions(server, format, sessionKey, requestBody(format, [user('并行任务')]), {
        native: nativeOptions({ multiplexing: true }),
        timeouts: { firstEventMs: 2000, eventIdleMs: 2000, responseMs: 8000 }
      })
    );
    const [chunksA, chunksB] = await Promise.all([
      driveLane('multiplex-lane-a'),
      driveLane('multiplex-lane-b')
    ]);
    assert.equal(new Set(frames.map((frame) => frame.connection)).size, 1, 'one pooled connection serves both lanes');
    const laneIds = [...new Set(frames.map((frame) => frame.request.stream_id))];
    assert.equal(laneIds.length, 2);
    for (const laneId of laneIds) assert.match(laneId, /^lane-/);

    const failed = chunksA.some((chunk) => chunk.error) ? chunksA : chunksB;
    const survived = failed === chunksA ? chunksB : chunksA;
    assert.ok(chunksA.some((chunk) => chunk.error) !== chunksB.some((chunk) => chunk.error), 'exactly one lane fails');
    assert.equal(streamedText(failed).includes('乙'), false, 'the failed lane never receives the other lane output');
    assert.ok(!nativeEvents(failed).some((event) => event.type === 'response.completed'));
    assert.equal(streamedText(survived), '乙');
    assert.deepEqual(
      nativeEvents(survived).map((event) => event.type),
      ['response.created', 'response.completed'],
      'the surviving lane completes despite the other lane failing'
    );
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('中止后旧代转向续接与响应事件不会污染同车道的新一代', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const format = await formatForTest();
  const frames = [];
  let sawSecondCreate = false;
  const server = await createServer((socket, request, connection) => {
    frames.push({ request, connection });
    if (request.type === 'response.create' && !sawSecondCreate) {
      socket.send(JSON.stringify({ type: 'response.created', stream_id: request.stream_id, response: { id: 'resp_old' } }));
      return;
    }
    if (request.type === 'response.steer') {
      socket.send(JSON.stringify({ type: 'response.steer.accepted', stream_id: request.stream_id, steer: { id: 'steer_stale', previous_response_id: 'resp_old' } }));
      return;
    }
    if (request.type === 'response.create' && sawSecondCreate) {
      // Stale events from the aborted generation interleave ahead of the new response.
      socket.send(JSON.stringify({
        type: 'response.output_text.delta', stream_id: request.stream_id, response_id: 'resp_old',
        item_id: 'msg_old', output_index: 0, content_index: 0, delta: '旧'
      }));
      socket.send(JSON.stringify({
        type: 'response.completed', stream_id: request.stream_id,
        response: { id: 'resp_old', status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }
      }));
      socket.send(JSON.stringify({ type: 'response.created', stream_id: request.stream_id, response: { id: 'resp_stale', previous_response_id: 'resp_old' } }));
      socket.send(JSON.stringify({
        type: 'response.output_text.delta', stream_id: request.stream_id, response_id: 'resp_stale',
        item_id: 'msg_stale', output_index: 0, content_index: 0, delta: '陈旧'
      }));
      socket.send(JSON.stringify({ type: 'response.created', stream_id: request.stream_id, response: { id: 'resp_new' } }));
      socket.send(JSON.stringify({
        type: 'response.output_text.delta', stream_id: request.stream_id, response_id: 'resp_new',
        item_id: 'msg_new', output_index: 0, content_index: 0, delta: '新鲜'
      }));
      socket.send(JSON.stringify({
        type: 'response.output_item.done', stream_id: request.stream_id, response_id: 'resp_new',
        output_index: 0, item: messageItem('msg_new', '新鲜', 0)
      }));
      socket.send(JSON.stringify({
        type: 'response.completed', stream_id: request.stream_id,
        response: { id: 'resp_new', status: 'completed', output: [], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } }
      }));
    }
  });
  const holder = { calls: [] };
  try {
    const controller = new AbortController();
    let steered = false;
    await assert.rejects(
      drive(
        streamOptions(server, format, 'stale-generation-lane', requestBody(format, [user('第一代')]), {
          native: nativeOptions({ steering: true, multiplexing: true }, holder),
          signal: controller.signal,
          timeouts: { firstEventMs: 2000, eventIdleMs: 2000, responseMs: 8000 }
        }),
        async (chunk) => {
          if (!steered && chunk.nativeEvent?.type === 'response.created') {
            steered = true;
            await holder.controller.steer({ submissionId: 'sub-stale', input: [user('过期指令')] });
          }
          if (chunk.nativeEvent?.type === 'response.steer.accepted') controller.abort();
        }
      ),
      (error) => error.name === 'AbortError'
    );

    sawSecondCreate = true;
    const chunks = await collect(streamOptions(
      server,
      format,
      'stale-generation-lane',
      requestBody(format, [user('第二代')]),
      {
        native: nativeOptions({ multiplexing: true }),
        timeouts: { firstEventMs: 2000, eventIdleMs: 2000, responseMs: 8000 }
      }
    ));
    assert.equal(streamedText(chunks), '新鲜');
    const events = nativeEvents(chunks);
    assert.deepEqual(events.map((event) => event.type), ['response.created', 'response.completed']);
    assert.deepEqual(events.map((event) => event.responseId), ['resp_new', 'resp_new']);
    assert.equal(new Set(frames.map((frame) => frame.connection)).size, 1, 'same physical lane is reused after local abort');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('努力变更在兼容续接上使用 configuration_update 且顶层推理保持锚定', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const format = await formatForTest();
  const frames = [];
  const server = await createServer((socket, request, connection) => {
    frames.push({ request, connection });
    if (request.type !== 'response.create') return;
    const seq = frames.filter((frame) => frame.request.type === 'response.create').length;
    if (seq === 1) sendMessageResponse(socket, 'resp_1', 'msg_1', '方案');
    else if (seq === 2) sendMessageResponse(socket, 'resp_2', 'msg_2', '已加固', 0, { previousResponseId: 'resp_1' });
    else sendMessageResponse(socket, 'resp_3', 'msg_3', '收尾', 0, { previousResponseId: 'resp_2' });
  });
  try {
    const native = () => nativeOptions({ reasoningUpdates: true });
    const decisions = [];
    const base = { native: native(), onDecision: (decision) => decisions.push(decision), timeouts: { firstEventMs: 2000, eventIdleMs: 2000, responseMs: 8000 } };
    await collect(streamOptions(server, format, 'native-reasoning', requestBody(format, [user('设计')], { reasoning: { effort: 'low' } }), base));
    await collect(streamOptions(server, format, 'native-reasoning', requestBody(format, [user('设计'), model('方案'), user('加固')], { reasoning: { effort: 'high' } }), { ...base, native: native() }));
    await collect(streamOptions(server, format, 'native-reasoning', requestBody(format, [user('设计'), model('方案'), user('加固'), model('已加固'), user('收尾')], { reasoning: { effort: 'high' } }), { ...base, native: native() }));

    assert.equal(frames.length, 3);
    const second = frames[1].request;
    assert.equal(second.previous_response_id, 'resp_1');
    assert.equal(second.reasoning.effort, 'low', 'request-level effort stays anchored at the prefix value');
    assert.deepEqual(second.input[0], { type: 'configuration_update', reasoning: { effort: 'high' } });
    assert.equal(second.input.length, 2, 'update precedes only the new suffix');
    assert.match(JSON.stringify(second.input[1]), /加固/);
    assert.deepEqual(decisions[1].reasoningUpdateApplied, { fromEffort: 'low', toEffort: 'high' });

    const third = frames[2].request;
    assert.equal(third.previous_response_id, 'resp_2');
    assert.equal(third.reasoning.effort, 'low', 'anchored effort persists across the chain');
    assert.ok(!third.input.some((item) => item.type === 'configuration_update'), 'no adjacent or repeated updates');
    assert.equal(decisions[2].reasoningUpdateApplied, undefined);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('原生路径与支持显式缓存的模型保留显式缓存字段，其他模型的旧路径保持剥离行为', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const format = await formatForTest();
  const unified = await import('unified-llm-provider');
  const frames = [];
  const server = await createServer((socket, request, connection) => {
    frames.push({ request, connection });
    if (request.type !== 'response.create') return;
    const seq = frames.filter((frame) => frame.request.type === 'response.create').length;
    sendMessageResponse(socket, `resp_cache_${seq}`, `msg_${seq}`, '好');
  });
  try {
    const bodyWithCache = (sessionSalt, bodyFormat = format) => {
      const body = requestBody(bodyFormat, [user(`缓存问题${sessionSalt}`)], {
        prompt_cache_options: { mode: 'explicit', ttl: '30m' }
      });
      body.input[0].content[0].prompt_cache_breakpoint = { mode: 'explicit' };
      return body;
    };
    await collect(streamOptions(server, format, 'native-cache', bodyWithCache('原生'), {
      native: nativeOptions({}),
      timeouts: { firstEventMs: 2000, eventIdleMs: 2000, responseMs: 8000 }
    }));
    // 显式缓存只按模型判断（官方：GPT-5.6 and later），旧路径上的 Astra、Sol、GPT-5.6 同样保留。
    for (const [salt, model] of [['旧式 Astra', 'gpt-6-astra'], ['旧式 Sol', 'gpt-6-sol'], ['旧式 5.6', 'gpt-5.6']]) {
      const modelFormat = new unified.OpenAIResponsesFormat(model);
      await collect(streamOptions(server, modelFormat, `legacy-cache-${model}`, bodyWithCache(salt, modelFormat), {
        timeouts: { firstEventMs: 2000, eventIdleMs: 2000, responseMs: 8000 }
      }));
    }
    const olderFormat = new unified.OpenAIResponsesFormat('gpt-5.5');
    await collect(streamOptions(server, olderFormat, 'legacy-cache-older', bodyWithCache('旧式 5.5', olderFormat), {
      timeouts: { firstEventMs: 2000, eventIdleMs: 2000, responseMs: 8000 }
    }));

    const nativeCreate = frames[0].request;
    assert.deepEqual(nativeCreate.prompt_cache_options, { mode: 'explicit', ttl: '30m' });
    assert.deepEqual(nativeCreate.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' });

    for (const index of [1, 2, 3]) {
      const create = frames[index].request;
      assert.deepEqual(create.prompt_cache_options, { mode: 'explicit', ttl: '30m' }, create.model);
      assert.deepEqual(create.input[0].content[0].prompt_cache_breakpoint, { mode: 'explicit' }, create.model);
    }

    const legacyCreate = frames[4].request;
    assert.equal(legacyCreate.model, 'gpt-5.5');
    assert.equal('prompt_cache_options' in legacyCreate, false);
    assert.equal('prompt_cache_breakpoint' in legacyCreate.input[0].content[0], false);
    assert.equal('stream_id' in nativeCreate, false, 'exclusive native mode uses no named lane');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('未启用原生时流行为逐字节保持：无原生事件、控制器或车道', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const format = await formatForTest();
  const frames = [];
  const server = await createServer((socket, request, connection) => {
    frames.push({ request, connection });
    if (request.type === 'response.create') sendMessageResponse(socket, 'resp_plain', 'msg_plain', '普通回答');
  });
  try {
    const chunks = await collect(streamOptions(server, format, 'plain-legacy', requestBody(format, [user('你好')]), {
      timeouts: { firstEventMs: 2000, eventIdleMs: 2000, responseMs: 8000 }
    }));
    assert.equal(streamedText(chunks), '普通回答');
    assert.equal(nativeEvents(chunks).length, 0);
    assert.equal(frames.length, 1);
    const create = frames[0].request;
    assert.equal(create.type, 'response.create');
    assert.equal('stream_id' in create, false);
    assert.equal(create.store, false);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('转向发送按车道串行：前一次确认后才放行下一次', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const format = await formatForTest();
  const steerFrames = [];
  let acceptedSent = 0;
  const server = await createServer((socket, request) => {
    if (request.type === 'response.create') {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }));
      socket.send(JSON.stringify({
        type: 'response.output_text.delta',
        response_id: 'resp_1',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: '运行中'
      }));
      return;
    }
    if (request.type === 'response.steer') {
      steerFrames.push({ request, acceptedSentAtArrival: acceptedSent });
      const steerIndex = steerFrames.length;
      socket.send(JSON.stringify({ type: 'response.steer.accepted', steer: { id: `steer_${steerIndex}`, previous_response_id: 'resp_1' } }));
      acceptedSent += 1;
      if (steerIndex === 2) {
        socket.send(JSON.stringify({
          type: 'response.incomplete',
          response: { id: 'resp_1', status: 'incomplete', incomplete_details: { reason: 'steered' } }
        }));
        sendMessageResponse(socket, 'resp_2', 'msg_2', '完成', 0, { previousResponseId: 'resp_1' });
      }
    }
  });
  const holder = { calls: [] };
  try {
    let started = false;
    let steerPromises = [];
    const chunks = await drive(
      streamOptions(server, format, 'native-steer-serial', requestBody(format, [user('长跑任务')]), {
        native: nativeOptions({ steering: true }, holder),
        timeouts: { firstEventMs: 2000, eventIdleMs: 2000, responseMs: 8000 }
      }),
      async (chunk) => {
        if (!started && chunk.nativeEvent?.type === 'response.created') {
          started = true;
          steerPromises = [
            holder.controller.steer({ submissionId: 'sub-one', input: [user('第一条')] }),
            holder.controller.steer({ submissionId: 'sub-two', input: [user('第二条')] })
          ];
        }
      }
    );
    await Promise.all(steerPromises);
    assert.equal(steerFrames.length, 2);
    assert.equal(steerFrames[0].acceptedSentAtArrival, 0, 'first steer goes out before any ack');
    assert.equal(steerFrames[1].acceptedSentAtArrival, 1, 'second steer waits for the first ack');
    const submissions = nativeEvents(chunks).filter((event) => event.type === 'response.steer.submitted');
    assert.deepEqual(submissions.map((event) => event.submissionId), ['sub-one', 'sub-two']);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('已接受转向等待自动续接时就绪的异步结果排队到续接边界后再承认', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const format = await formatForTest();
  const frames = [];
  const tools = [{
    type: 'function',
    name: 'lookup_price',
    async: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }];
  const server = await createServer((socket, request, connection) => {
    frames.push({ request, connection });
    if (request.type === 'response.create' && !request.previous_response_id) {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } }));
      socket.send(JSON.stringify({
        type: 'response.output_item.done',
        response_id: 'resp_1',
        output_index: 0,
        item: { id: 'fc_price', type: 'function_call', call_id: 'call_price', name: 'lookup_price', arguments: '{}', async: true }
      }));
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } }
      }));
      return;
    }
    if (request.type === 'response.steer') {
      socket.send(JSON.stringify({ type: 'response.steer.accepted', steer: { id: 'steer_auto', previous_response_id: 'resp_1' } }));
      // The automatic successor runs first; the explicit result create must follow it.
      sendMessageResponse(socket, 'resp_2', 'msg_2', '自动续接', 0, { previousResponseId: 'resp_1' });
      return;
    }
    if (request.type === 'response.create' && request.previous_response_id === 'resp_2') {
      sendMessageResponse(socket, 'resp_3', 'msg_3', '结果已用', 0, { previousResponseId: 'resp_2' });
    }
  });
  const holder = { calls: [] };
  try {
    let admissionPromise;
    const chunks = await drive(
      streamOptions(server, format, 'native-race-gate', requestBody(format, [user('边查价边写')], { tools }), {
        native: nativeOptions({ steering: true }, holder),
        timeouts: { firstEventMs: 2000, eventIdleMs: 2000, responseMs: 8000 }
      }),
      async (chunk) => {
        if (chunk.nativeEvent?.type === 'response.created' && chunk.nativeEvent.responseId === 'resp_1') {
          await holder.controller.steer({ submissionId: 'sub-auto', input: [user('先降价')] });
          return;
        }
        if (chunk.nativeEvent?.type === 'response.steer.accepted' && !admissionPromise) {
          // The async result is ready immediately after acceptance; it must queue behind the
          // automatic successor instead of racing it for admission. Capture only: admission
          // resolves when this generator processes the explicit continuation's response.created,
          // so awaiting it inside the consumer callback would deadlock.
          admissionPromise = holder.controller.submitToolResults([{
            type: 'function_call_output',
            callId: 'call_price',
            output: '{"price":1200}'
          }]);
        }
      }
    );
    const admission = await admissionPromise;
    assert.equal(admission.responseId, 'resp_3', 'admission binds the explicit continuation, not the automatic successor');
    assert.equal(admission.previousResponseId, 'resp_2', 'the result create waited for the automatic successor boundary');
    const explicitCreate = frames.find((frame) => frame.request.type === 'response.create' && frame.request.previous_response_id);
    assert.equal(explicitCreate.request.previous_response_id, 'resp_2');
    assert.deepEqual(explicitCreate.request.input, [{
      type: 'function_call_output',
      call_id: 'call_price',
      output: '{"price":1200}'
    }]);
    assert.doesNotMatch(JSON.stringify(explicitCreate.request.input), /先降价/);
    const events = nativeEvents(chunks);
    const types = events.map((event) => `${event.type}:${event.responseId}`);
    const acceptedIndex = types.indexOf('response.steer.accepted:resp_1');
    const autoIndex = types.indexOf('response.created:resp_2');
    const admittedIndex = types.indexOf('response.created:resp_3');
    assert.ok(acceptedIndex >= 0 && autoIndex > acceptedIndex && admittedIndex > autoIndex,
      `accepted steer → automatic successor → admitted explicit continuation: ${types.join(',')}`);
    const admittedCreated = events[admittedIndex];
    assert.deepEqual(admittedCreated.admittedToolResultCallIds, ['call_price']);
    assert.equal(events[autoIndex].admittedToolResultCallIds, undefined,
      'the automatic successor is never labeled as a result admission');
    assert.equal(streamedText(chunks), '自动续接结果已用');
    assert.ok(!chunks.some((chunk) => chunk.error));
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('单连接最多16个活跃响应，槽位按序原子授予且可中止', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const format = await formatForTest();
  const frames = [];
  const laneSockets = new Map();
  const laneResponses = new Map();
  const server = await createServer((socket, request, connection) => {
    frames.push({ request, connection });
    if (request.type !== 'response.create') return;
    laneSockets.set(request.stream_id, socket);
    const responseId = `resp_lane_${laneResponses.size + 1}`;
    laneResponses.set(request.stream_id, responseId);
    socket.send(JSON.stringify({ type: 'response.created', stream_id: request.stream_id, response: { id: responseId } }));
    // Responses stay in flight until the test completes them.
  });
  const completeLane = (streamId) => {
    const socket = laneSockets.get(streamId);
    const responseId = laneResponses.get(streamId);
    socket.send(JSON.stringify({
      type: 'response.output_item.done', stream_id: streamId, response_id: responseId,
      output_index: 0, item: messageItem(`msg_${responseId}`, '完成', 0)
    }));
    socket.send(JSON.stringify({
      type: 'response.completed', stream_id: streamId,
      response: { id: responseId, status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }
    }));
  };
  const waitForFrames = async (count) => {
    for (let waited = 0; frames.length < count && waited < 300; waited += 1) await delay(10);
    assert.equal(frames.length, count);
  };
  try {
    const queueStates = [];
    const driveLane = (index, signal) => drive(
      streamOptions(server, format, `slot-lane-${index}`, requestBody(format, [user(`任务${index}`)]), {
        native: {
          ...nativeOptions({ multiplexing: true }),
          onLaneQueueState(queued) {
            queueStates.push({ index, queued });
          }
        },
        ...(signal ? { signal } : {}),
        timeouts: { firstEventMs: 5000, eventIdleMs: 4000, responseMs: 20000 }
      })
    );
    const drives = [];
    for (let index = 1; index <= 16; index += 1) drives.push(driveLane(index));
    await waitForFrames(16);
    assert.equal(new Set(frames.map((frame) => frame.connection)).size, 1);

    const seventeenth = driveLane(17);
    const eighteenth = driveLane(18);
    await delay(150);
    assert.equal(frames.length, 16, 'waiting lanes never send before a permit');

    completeLane(frames[0].request.stream_id);
    await waitForFrames(17);
    await delay(150);
    assert.equal(frames.length, 17, 'the first dequeued waiter holds an atomic reservation; the second still waits');

    completeLane(frames[1].request.stream_id);
    await waitForFrames(18);

    const abortNineteenth = new AbortController();
    const nineteenth = driveLane(19, abortNineteenth.signal);
    await delay(150);
    assert.equal(frames.length, 18, 'the 19th lane queues behind full capacity');
    abortNineteenth.abort();
    await assert.rejects(nineteenth, (error) => error.name === 'AbortError');

    completeLane(frames[16].request.stream_id);
    completeLane(frames[17].request.stream_id);
    await Promise.all([seventeenth, eighteenth]);
    for (const frame of frames.slice(2, 16)) completeLane(frame.request.stream_id);
    await Promise.all(drives);

    const entered = queueStates.filter((state) => state.queued).map((state) => state.index);
    const left = queueStates.filter((state) => !state.queued).map((state) => state.index);
    for (const index of [17, 18, 19]) {
      assert.ok(entered.includes(index), `lane ${index} reports wait enter`);
      assert.ok(left.includes(index), `lane ${index} reports wait leave (including abort cleanup)`);
    }
    assert.ok(!entered.includes(1), 'a lane that never waits never reports a queue state');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('等待异步结果的父请求释放活跃许可，16个子请求仍可并行运行', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const format = await formatForTest();
  const frames = [];
  const laneSockets = new Map();
  const laneResponses = new Map();
  const tools = [{
    type: 'function',
    name: 'child_lookup',
    async: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }];
  const server = await createServer((socket, request, connection) => {
    frames.push({ request, connection });
    if (request.type !== 'response.create') return;
    laneSockets.set(request.stream_id, socket);
    if (request.previous_response_id) {
      // The parent's continuation after its async result: complete immediately, tagged with the
      // parent lane so the multiplexed router can deliver it.
      sendMessageResponse(socket, 'resp_parent_done', 'msg_parent_done', '父完成', 0, {
        previousResponseId: request.previous_response_id,
        streamId: request.stream_id
      });
      return;
    }
    const responseId = `resp_${laneResponses.size + 1}`;
    laneResponses.set(request.stream_id, responseId);
    if (JSON.stringify(request.input ?? []).includes('父任务')) {
      socket.send(JSON.stringify({ type: 'response.created', stream_id: request.stream_id, response: { id: responseId } }));
      socket.send(JSON.stringify({
        type: 'response.output_item.done', stream_id: request.stream_id, response_id: responseId,
        output_index: 0,
        item: { id: 'fc_child', type: 'function_call', call_id: 'call_child', name: 'child_lookup', arguments: '{}', async: true }
      }));
      socket.send(JSON.stringify({
        type: 'response.completed', stream_id: request.stream_id,
        response: { id: responseId, status: 'completed', output: [], usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 } }
      }));
      return;
    }
    socket.send(JSON.stringify({ type: 'response.created', stream_id: request.stream_id, response: { id: responseId } }));
    // Child responses stay in flight until the test completes them.
  });
  const completeLane = (streamId) => {
    const socket = laneSockets.get(streamId);
    const responseId = laneResponses.get(streamId);
    socket.send(JSON.stringify({
      type: 'response.output_item.done', stream_id: streamId, response_id: responseId,
      output_index: 0, item: messageItem(`msg_${responseId}`, '完成', 0)
    }));
    socket.send(JSON.stringify({
      type: 'response.completed', stream_id: streamId,
      response: { id: responseId, status: 'completed', output: [], usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }
    }));
  };
  const waitForFrames = async (count) => {
    for (let waited = 0; frames.length < count && waited < 300; waited += 1) await delay(10);
    assert.equal(frames.length, count);
  };
  const holder = { calls: [] };
  const queueStates = [];
  try {
    let parentWaitingResolve;
    const parentWaiting = new Promise((resolve) => { parentWaitingResolve = resolve; });
    const parentDrive = drive(
      streamOptions(server, format, 'parent-lane', requestBody(format, [user('父任务')], { tools }), {
        native: {
          ...nativeOptions({ multiplexing: true }, holder),
          onLaneQueueState(queued) {
            queueStates.push(queued);
          }
        },
        timeouts: { firstEventMs: 5000, eventIdleMs: 4000, responseMs: 20000 }
      }),
      async (chunk) => {
        if (chunk.nativeEvent?.type === 'response.completed') parentWaitingResolve();
      }
    );
    await parentWaiting;
    assert.equal(frames.length, 1, 'parent holds its lane while waiting for the async result');

    const childDrives = [];
    for (let index = 1; index <= 16; index += 1) {
      childDrives.push(drive(
        streamOptions(server, format, `child-lane-${index}`, requestBody(format, [user(`子任务${index}`)]), {
          native: nativeOptions({ multiplexing: true }),
          timeouts: { firstEventMs: 5000, eventIdleMs: 4000, responseMs: 20000 }
        })
      ));
    }
    await waitForFrames(17);

    const admissionPromise = holder.controller.submitToolResults([{
      type: 'function_call_output',
      callId: 'call_child',
      output: '{"price":42}'
    }]);
    await delay(150);
    assert.equal(frames.length, 17, 'parent continuation waits for a freed permit at full capacity');

    completeLane(frames[1].request.stream_id);
    await waitForFrames(18);
    const admission = await admissionPromise;
    assert.equal(admission.responseId, 'resp_parent_done');
    await parentDrive;
    assert.deepEqual(queueStates, [true, false], 'parent reports permit wait enter/leave exactly once');

    for (const frame of frames.slice(2, 17)) completeLane(frame.request.stream_id);
    await Promise.all(childDrives);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});
