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

function messageItem(id, text, outputIndex) {
  return {
    id,
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text }]
  };
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

function registerCases(test) {

test('canonical item completion refuses rewritten text, conflicting identity, and unproven signatures', () => {
  const { OpenAIResponsesContinuationProjection } = require(path.resolve(
    process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension',
    'backend/capabilities/openAIResponsesContinuationProjection.js'));
  const reasoning = { type: 'reasoning', id: 'exact-item', summary: [{ type: 'summary_text', text: 'exact text' }] };
  const message = messageItem('exact-item', 'exact text');
  const cases = [
    {
      item: { ...reasoning, summary: [{ type: 'summary_text', text: 'changed text' }] },
      delta: { type: 'response.reasoning_summary_text.delta', summary_index: 0, delta: 'exact text' },
      decoded: { partsDelta: [{ thought: true, text: 'exact text' }] }
    },
    {
      item: reasoning,
      delta: { type: 'response.reasoning_summary_text.delta', summary_index: 0, delta: 'exact text' },
      decoded: { partsDelta: [{ thought: true, text: 'exact text', thoughtSignatures: { 'openai-responses': 'untrusted' } }] }
    },
    {
      item: { ...reasoning, encrypted_content: 'not-proven-by-decoder' },
      delta: { type: 'response.reasoning_summary_text.delta', summary_index: 0, delta: 'exact text' },
      decoded: { partsDelta: [{ thought: true, text: 'exact text' }] }
    },
    {
      item: { ...reasoning, id: 'different-item' },
      delta: { type: 'response.reasoning_summary_text.delta', summary_index: 0, delta: 'exact text' },
      decoded: { partsDelta: [{ thought: true, text: 'exact text' }] }
    },
    {
      item: { ...message, content: [{ type: 'output_text', text: 'changed text' }] },
      delta: { type: 'response.output_text.delta', content_index: 0, delta: 'exact text' },
      decoded: { textDelta: 'exact text' }
    }
  ];
  for (const { item, delta, decoded } of cases) {
    const projection = new OpenAIResponsesContinuationProjection();
    const streamed = projection.observe({ ...delta, item_id: 'exact-item', output_index: 0 }, decoded);
    assert.equal(streamed.completedItem, undefined, 'a delta cannot close an immutable item');
    const closed = projection.observe({ type: 'response.output_item.done', output_index: 0, item }, {});
    assert.equal(closed.completedItem, undefined, 'invalid closure evidence cannot freeze canonical bytes');
    projection.observe({ type: 'response.completed', response: { output: [item] } }, {});
    assert.equal(projection.completedProjection(), undefined, 'final aggregation must still fail closed');
  }
  const missingIndex = new OpenAIResponsesContinuationProjection();
  assert.equal(missingIndex.observe({ type: 'response.output_item.done', item: reasoning }, {}).completedItem,
    undefined, 'item-only proof requires the provider output ordinal');
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
    for (let waited = 0; frames.length < count && waited < 300; waited += 1) await new Promise(resolve => setImmediate(resolve));
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
    while (!queueStates.some(state => state.index === 17 && state.queued)) await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames.length, 16, 'waiting lanes never send before a permit');

    completeLane(frames[0].request.stream_id);
    await waitForFrames(17);
    assert.equal(frames.length, 17, 'the dequeued waiter owns the released permit');

    const aborted = new AbortController();
    const cancelled = driveLane(18, aborted.signal);
    while (!queueStates.some(state => state.index === 18 && state.queued)) await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames.length, 17, 'cancelled waiter never writes a frame');
    aborted.abort();
    await assert.rejects(cancelled, error => error.name === 'AbortError');

    completeLane(frames[16].request.stream_id);
    await seventeenth;
    for (const frame of frames.slice(1, 16)) completeLane(frame.request.stream_id);
    await Promise.all(drives);

    const entered = queueStates.filter((state) => state.queued).map((state) => state.index);
    const left = queueStates.filter((state) => !state.queued).map((state) => state.index);
    for (const index of [17, 18]) {
      assert.ok(entered.includes(index), `lane ${index} reports wait enter`);
      assert.ok(left.includes(index), `lane ${index} reports wait leave (including abort cleanup)`);
    }
    assert.ok(!entered.includes(1), 'a lane that never waits never reports a queue state');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});
}

module.exports = { registerCases };
