const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WebSocketServer } = require('ws');

const {
  LIMCODE_OPENAI_RESPONSES_WS_IMPLEMENTATION,
  resetOpenAIResponsesWebSocketSessions,
  streamOpenAIResponsesWebSocketSession
} = require('../dist/extension/backend/capabilities/openAIResponsesWebSocketSession.js');
const {
  OpenAIResponsesContinuationProjection
} = require('../dist/extension/backend/capabilities/openAIResponsesContinuationProjection.js');
const {
  OPENAI_RESPONSES_RETRYABLE_PRE_TERMINAL_CLOSE_CODES,
  classifyOpenAIResponsesPreTerminalWebSocketClose,
  isRetryableOpenAIResponsesWebSocketClose
} = require('../dist/extension/backend/capabilities/openAIResponsesWebSocketRetryPolicy.js');

async function formatForTest() {
  const unified = await import('unified-llm-provider');
  return new unified.OpenAIResponsesFormat('gpt-test');
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

function sendCompleted(socket, id, outputItems, options = {}) {
  socket.send(JSON.stringify({ type: 'response.created', response: { id } }));
  for (const [outputIndex, item] of outputItems.entries()) {
    if (item.type === 'message') {
      for (const block of item.content ?? []) {
        if (block.type === 'output_text' && block.text) {
          socket.send(JSON.stringify({
            type: 'response.output_text.delta',
            response_id: id,
            item_id: item.id,
            output_index: outputIndex,
            content_index: 0,
            delta: block.text
          }));
        }
      }
    }
    socket.send(JSON.stringify({
      type: 'response.output_item.done',
      response_id: id,
      output_index: outputIndex,
      item
    }));
  }
  socket.send(JSON.stringify({
    type: 'response.completed',
    response: {
      id,
      status: 'completed',
      // The real compatibility endpoint behaves this way: output_item.done is complete,
      // while response.completed.response.output is empty.
      output: options.completedOutput ?? [],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
    }
  }), options.afterCompleted);
}

function reasoningItem(id, blocks, signature) {
  return {
    id,
    type: 'reasoning',
    summary: blocks.map((text) => ({ type: 'summary_text', text })),
    ...(signature ? { encrypted_content: signature } : {})
  };
}

function reasoningModel(text, signature, extraParts = []) {
  return {
    role: 'model',
    parts: [{
      text,
      thought: true,
      ...(signature ? { thoughtSignatures: { 'openai-responses': signature } } : {})
    }, ...extraParts]
  };
}

function sendReasoningDelta(socket, id, itemId, summaryIndex, delta) {
  socket.send(JSON.stringify({
    type: 'response.reasoning_summary_text.delta',
    response_id: id,
    item_id: itemId,
    output_index: 0,
    summary_index: summaryIndex,
    delta
  }));
}

function sendReasoningTextDone(socket, id, itemId, summaryIndex, text) {
  socket.send(JSON.stringify({
    type: 'response.reasoning_summary_text.done',
    response_id: id,
    item_id: itemId,
    output_index: 0,
    summary_index: summaryIndex,
    text
  }));
}

function sendReasoningSummaryPart(socket, phase, id, itemId, summaryIndex, text) {
  socket.send(JSON.stringify({
    type: `response.reasoning_summary_part.${phase}`,
    response_id: id,
    item_id: itemId,
    output_index: 0,
    summary_index: summaryIndex,
    part: { type: 'summary_text', text }
  }));
}

function sendOutputItemDone(socket, id, outputIndex, item) {
  socket.send(JSON.stringify({
    type: 'response.output_item.done',
    response_id: id,
    output_index: outputIndex,
    item
  }));
}

function sendResponseCompleted(socket, id, output = []) {
  socket.send(JSON.stringify({
    type: 'response.completed',
    response: {
      id,
      status: 'completed',
      output,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
    }
  }));
}

function sendResponseCompletedWithoutOutput(socket, id) {
  socket.send(JSON.stringify({
    type: 'response.completed',
    response: {
      id,
      status: 'completed',
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
    }
  }));
}

function streamedThought(chunks) {
  return chunks
    .flatMap((chunk) => chunk.partsDelta ?? [])
    .filter((part) => part.thought === true)
    .map((part) => part.text ?? '')
    .join('');
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

async function collect(options) {
  const chunks = [];
  for await (const chunk of streamOpenAIResponsesWebSocketSession(options)) chunks.push(chunk);
  return chunks;
}

test('调试观察保留陌生工具编号与实际追加目标，原始消息在解析前捕获', async () => {
  resetOpenAIResponsesWebSocketSessions();
  const format = await formatForTest();
  const observations = [];
  const recorder = {
    active: () => 'capture-a',
    record(input) {
      observations.push(structuredClone(input));
      return { runId: 'capture-a', captureSeq: observations.length };
    }
  };
  const server = await createServer((socket) => {
    socket.send(JSON.stringify({ type: 'response.output_item.added', output_index: 0,
      item: { type: 'function_call', id: 'fc-a', call_id: 'call-a', name: 'bash', arguments: '' } }));
    socket.send(JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'fc-foreign', output_index: 9, delta: '{"x":1}' }));
    sendCompleted(socket, 'response-a', [{ type: 'function_call', id: 'fc-a', call_id: 'call-a', name: 'bash', arguments: '{}' }]);
  });
  try {
    await collect(streamOptions(server, format, 'debug-routing', requestBody(format, [user('test')]), {
      debugCapture: { recorder, context: { conversationId: 'conversation-a', modelRequestId: 'request-a', attemptSeq: '1', socketGeneration: '1' } }
    }));
    const wrong = observations.find(e => e.stage === 'ws.tool_assembly' && e.metadata.rawItemId === 'fc-foreign');
    assert.equal(wrong.metadata.callId, 'call-a');
    assert.equal(wrong.metadata.selectionReason, 'single_active_fallback');
    assert.equal(wrong.payload, '{"x":1}');
    const raw = observations[wrong.sources[0].captureSeq - 1];
    assert.equal(raw.stage, 'transport.receive');
    assert.equal(JSON.parse(Buffer.from(raw.bytes).toString()).item_id, 'fc-foreign');
    assert.equal(observations.filter(e => e.stage === 'transport.send').length, 1);
  } finally { resetOpenAIResponsesWebSocketSessions(); await server.close(); }
});

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

test('Responses WebSocket pre-terminal retry policy covers every configured reconnect close', () => {
  const retryableCodes = [1000, 1001, 1005, 1006, 1008, 1011, 1012, 1013, 1014, 1015];
  assert.deepEqual([...OPENAI_RESPONSES_RETRYABLE_PRE_TERMINAL_CLOSE_CODES], retryableCodes);
  for (const closeCode of retryableCodes) {
    assert.equal(isRetryableOpenAIResponsesWebSocketClose(closeCode), true, `close ${closeCode}`);
    assert.deepEqual(
      classifyOpenAIResponsesPreTerminalWebSocketClose(
        `OpenAI Responses WebSocket closed before terminal event: ${closeCode}`
      ),
      { closeCode, retryable: true }
    );
  }
  for (const closeCode of [1002, 1003, 1004, 1007, 1009, 1010, 1016, 3000]) {
    assert.equal(isRetryableOpenAIResponsesWebSocketClose(closeCode), false, `close ${closeCode}`);
    assert.deepEqual(
      classifyOpenAIResponsesPreTerminalWebSocketClose(
        `OpenAI Responses WebSocket closed before terminal event: ${closeCode}`
      ),
      { closeCode, retryable: false }
    );
  }
});

test('continuation projection avoids cloning unchanged chunks and never mutates rewritten chunks', () => {
  const projection = new OpenAIResponsesContinuationProjection();
  const first = { partsDelta: [{ text: 'A', thought: true }] };
  const firstResult = projection.observe({
    type: 'response.reasoning_summary_text.delta',
    item_id: 'reasoning_projection_identity',
    output_index: 0,
    summary_index: 0,
    delta: 'A'
  }, first);
  assert.strictEqual(firstResult.chunk, first);

  const second = { partsDelta: [{ text: 'B', thought: true }] };
  const secondSnapshot = structuredClone(second);
  const secondResult = projection.observe({
    type: 'response.reasoning_summary_text.delta',
    item_id: 'reasoning_projection_identity',
    output_index: 0,
    summary_index: 1,
    delta: 'B'
  }, second);
  assert.notStrictEqual(secondResult.chunk, second);
  assert.deepEqual(second, secondSnapshot);
  assert.equal(streamedThought([secondResult.chunk]), '\nB');
});

test('Codex-style WS continuation uses output_item.done and never duplicates prior assistant output', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const assistant = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'assistant-1', annotations: [] }]
  };
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    sendCompleted(socket, `resp_${requests.length}`, requests.length === 1 ? [assistant] : []);
  });
  try {
    const format = await formatForTest();
    const decisions = [];
    const firstChunks = await collect(streamOptions(
      server,
      format,
      'assistant-prefix',
      requestBody(format, [user('user-1')]),
      { onDecision: (decision) => decisions.push(decision) }
    ));
    assert.equal(firstChunks.map((chunk) => chunk.textDelta ?? '').join(''), 'assistant-1');

    await collect(streamOptions(
      server,
      format,
      'assistant-prefix',
      requestBody(format, [user('user-1'), model('assistant-1'), user('user-2')]),
      { onDecision: (decision) => decisions.push(decision) }
    ));

    assert.equal(requests.length, 2);
    assert.equal(requests[0].connection, requests[1].connection);
    assert.equal(requests[1].request.previous_response_id, 'resp_1');
    assert.equal(requests[1].request.input.length, 1);
    assert.equal(requests[1].request.input[0].role, 'user');
    assert.match(JSON.stringify(requests[1].request.input[0]), /user-2/);
    assert.doesNotMatch(JSON.stringify(requests[1].request.input), /assistant-1/);
    assert.equal(decisions[0].mode, 'full');
    assert.equal(decisions[1].mode, 'incremental');
    assert.equal(decisions[1].reason, 'matched_exact_prefix');
    assert.equal(LIMCODE_OPENAI_RESPONSES_WS_IMPLEMENTATION, 'codex-output-items-v1');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('provider-local volatile tail keeps current Turn input and full task reminder on incremental requests', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const answers = ['answer-1', 'answer-2', 'answer-3'];
  const server = await createServer((socket, request, connection) => {
    const index = requests.length;
    requests.push({ request, connection });
    sendCompleted(socket, `resp_tail_${index + 1}`, [{
      id: `msg_tail_${index + 1}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: answers[index], annotations: [] }]
    }]);
  });
  try {
    const format = await formatForTest();
    const initial = user('initial request');
    const frozenCurrent = user('frozen current Turn input');
    const taskV1 = user('[Current Turn Task Card] task-v1');
    const decisions = [];
    await collect(streamOptions(
      server,
      format,
      'volatile-turn-tail',
      requestBody(format, [initial, frozenCurrent, taskV1]),
      {
        continuation: {
          volatileTailContents: [frozenCurrent, taskV1],
          volatileTailContentKinds: ['current_turn_input', 'turn_reminder']
        },
        onDecision: (decision) => decisions.push(decision)
      }
    ));

    const runtimeDelivery = user('runtime tool result');
    const taskV2 = user('[Current Turn Task Card] task-v2');
    await collect(streamOptions(
      server,
      format,
      'volatile-turn-tail',
      requestBody(format, [initial, model('answer-1'), runtimeDelivery, frozenCurrent, taskV2]),
      {
        continuation: {
          volatileTailContents: [frozenCurrent, taskV2],
          volatileTailContentKinds: ['current_turn_input', 'turn_reminder']
        },
        onDecision: (decision) => decisions.push(decision)
      }
    ));

    assert.equal(requests[1].request.previous_response_id, 'resp_tail_1');
    assert.equal(requests[1].request.input.length, 3);
    assert.match(JSON.stringify(requests[1].request.input[0]), /runtime tool result/);
    assert.match(JSON.stringify(requests[1].request.input[1]), /frozen current Turn input/);
    assert.match(JSON.stringify(requests[1].request.input[2]), /task-v2/);
    assert.doesNotMatch(JSON.stringify(requests[1].request.input), /answer-1|task-v1/);
    assert.equal(decisions[1].mode, 'incremental');
    assert.equal(decisions[1].reason, 'matched_exact_prefix');

    const nextInput = user('next runtime result');
    await collect(streamOptions(
      server,
      format,
      'volatile-turn-tail',
      requestBody(format, [
        initial,
        model('answer-1'),
        runtimeDelivery,
        model('answer-2'),
        nextInput,
        frozenCurrent
      ]),
      {
        continuation: {
          volatileTailContents: [frozenCurrent],
          volatileTailContentKinds: ['current_turn_input']
        },
        onDecision: (decision) => decisions.push(decision)
      }
    ));
    assert.equal('previous_response_id' in requests[2].request, false);
    assert.equal(requests[2].request.input.length, 6);
    assert.equal(decisions[2].mode, 'full');
    assert.equal(decisions[2].reason, 'volatile_tail_layout_changed');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('a fresh task reminder is a valid incremental suffix when durable history exactly matches the baseline', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const decisions = [];
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    sendCompleted(socket, `resp_task_only_${requests.length}`, requests.length === 1 ? [{
      id: 'msg_task_only_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'first answer', annotations: [] }]
    }] : []);
  });
  try {
    const format = await formatForTest();
    const initial = user('initial request');
    const taskV1 = user('[Current Turn Task Card] task-v1');
    await collect(streamOptions(
      server,
      format,
      'task-only-suffix',
      requestBody(format, [initial, taskV1]),
      {
        continuation: {
          volatileTailContents: [taskV1],
          volatileTailContentKinds: ['turn_reminder']
        },
        onDecision: (decision) => decisions.push(decision)
      }
    ));

    const taskV2 = user('[Current Turn Task Card] task-v2');
    await collect(streamOptions(
      server,
      format,
      'task-only-suffix',
      requestBody(format, [initial, model('first answer'), taskV2]),
      {
        continuation: {
          volatileTailContents: [taskV2],
          volatileTailContentKinds: ['turn_reminder']
        },
        onDecision: (decision) => decisions.push(decision)
      }
    ));

    assert.equal(requests[1].request.previous_response_id, 'resp_task_only_1');
    assert.equal(requests[1].request.input.length, 1);
    assert.match(JSON.stringify(requests[1].request.input[0]), /task-v2/);
    assert.doesNotMatch(JSON.stringify(requests[1].request.input), /task-v1|first answer/);
    assert.equal(decisions[1].mode, 'incremental');
    assert.equal(decisions[1].reason, 'matched_exact_prefix');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('edited durable history and changed request properties strictly fall back to full input', { concurrency: false }, async () => {
  for (const fixture of [
    {
      name: 'edited-history',
      secondContents: [user('edited original'), model('base answer'), user('next')],
      secondOverrides: {},
      reason: 'input_prefix_mismatch_at:0'
    },
    {
      name: 'changed-properties',
      secondContents: [user('original'), model('base answer'), user('next')],
      secondOverrides: { temperature: 0.7 },
      reason: 'request_properties_changed'
    }
  ]) {
    resetOpenAIResponsesWebSocketSessions();
    const requests = [];
    const decisions = [];
    const server = await createServer((socket, request, connection) => {
      requests.push({ request, connection });
      sendCompleted(socket, `${fixture.name}-${requests.length}`, requests.length === 1 ? [{
        id: `${fixture.name}-message`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'base answer', annotations: [] }]
      }] : []);
    });
    try {
      const format = await formatForTest();
      await collect(streamOptions(
        server,
        format,
        `strict-full-${fixture.name}`,
        requestBody(format, [user('original')]),
        { onDecision: (decision) => decisions.push(decision) }
      ));
      await collect(streamOptions(
        server,
        format,
        `strict-full-${fixture.name}`,
        requestBody(format, fixture.secondContents, fixture.secondOverrides),
        { onDecision: (decision) => decisions.push(decision) }
      ));
      assert.equal('previous_response_id' in requests[1].request, false);
      assert.equal(requests[1].request.input.length, 3);
      assert.equal(decisions[1].mode, 'full');
      assert.equal(decisions[1].reason, fixture.reason);
    } finally {
      resetOpenAIResponsesWebSocketSessions();
      await server.close();
    }
  }
});

test('100-round continuation performs one full rebase after every 16 successful incremental requests', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const server = await createServer((socket, request, connection) => {
    const ordinal = requests.length + 1;
    requests.push({ request, connection });
    sendCompleted(socket, `resp_rebase_${ordinal}`, [{
      id: `msg_rebase_${ordinal}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: `answer-${ordinal}`, annotations: [] }]
    }]);
  });
  try {
    const format = await formatForTest();
    const durable = [user('start')];
    const decisions = [];
    for (let ordinal = 1; ordinal <= 100; ordinal += 1) {
      const reminder = user(`[Current Turn Task Card] round-${ordinal}`);
      await collect(streamOptions(
        server,
        format,
        'fixed-periodic-rebase',
        requestBody(format, [...durable, reminder]),
        {
          continuation: {
            volatileTailContents: [reminder],
            volatileTailContentKinds: ['turn_reminder']
          },
          onDecision: (decision) => decisions.push(decision)
        }
      ));
      durable.push(model(`answer-${ordinal}`), user(`runtime-${ordinal}`));
    }

    const fullIndexes = [];
    const incrementalIndexes = [];
    for (const [index, decision] of decisions.entries()) {
      (decision.mode === 'full' ? fullIndexes : incrementalIndexes).push(index);
    }
    assert.deepEqual(fullIndexes, [0, 17, 34, 51, 68, 85]);
    assert.equal(fullIndexes.length, 6);
    assert.equal(incrementalIndexes.length, 94);
    assert.ok(fullIndexes.slice(1).every((index) => decisions[index].reason === 'periodic_rebase'));
    for (const index of incrementalIndexes) {
      const expectedReminder = `[Current Turn Task Card] round-${index + 1}`;
      assert.ok(JSON.stringify(requests[index].request.input.at(-1)).includes(expectedReminder));
      assert.equal(requests[index].request.previous_response_id, `resp_rebase_${index}`);
    }
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('request_sent counts exact UTF-8 frame bytes and response.create sequence resets on reconnect', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const server = await createServer((socket, request, connection, _upgradeRequest, payloadText) => {
    requests.push({ request, connection, payloadText });
    sendCompleted(socket, `resp_frame_${requests.length}`, []);
  });
  try {
    const format = await formatForTest();
    const firstInput = user('中文原始字节🙂🚀');
    const phasesByRequest = [];
    for (const [index, contents] of [
      [firstInput],
      [firstInput, user('第二轮')],
      [firstInput, user('第二轮'), user('重连后')]
    ].entries()) {
      const phases = [];
      phasesByRequest.push(phases);
      await collect(streamOptions(
        server,
        format,
        'utf8-frame-length',
        requestBody(format, contents),
        {
          ...(index === 2 ? { forceNewConnection: true } : {}),
          onPhase: (phase) => phases.push(phase)
        }
      ));
    }

    assert.deepEqual(requests.map((entry) => entry.connection), [0, 0, 1]);
    const sentPhases = phasesByRequest.map((phases) => phases.find((phase) => phase.phase === 'request_sent'));
    assert.deepEqual(sentPhases.map((phase) => phase.responseCreateSeq), [1, 2, 1]);
    assert.deepEqual(sentPhases.map((phase) => phase.connectionGeneration), [1, 1, 2]);
    for (const [index, phase] of sentPhases.entries()) {
      const payloadText = requests[index].payloadText;
      assert.equal(phase.responseCreateFrameBytes, Buffer.byteLength(payloadText, 'utf8'));
      assert.doesNotMatch(
        JSON.stringify(requests[index].request),
        /responseCreateFrameBytes|responseCreateSeq/
      );
    }
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('changed handshake identity reconnects with fresh auth and clears connection-local continuation', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const assistant = {
    id: 'msg_handshake_identity',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'authenticated answer', annotations: [] }]
  };
  const server = await createServer((socket, request, connection, upgradeRequest) => {
    requests.push({
      request,
      connection,
      authorization: upgradeRequest.headers.authorization,
      tenant: upgradeRequest.headers['x-tenant']
    });
    sendCompleted(socket, `resp_handshake_${requests.length}`, requests.length === 1 ? [assistant] : []);
  });
  try {
    const format = await formatForTest();
    const decisions = [];
    await collect(streamOptions(
      server,
      format,
      'handshake-identity',
      requestBody(format, [user('first')]),
      {
        headers: {
          Authorization: 'Bearer old-key',
          'X-Tenant': 'tenant-a',
          'Content-Type': 'application/json'
        },
        onDecision: (decision) => decisions.push(decision)
      }
    ));
    await collect(streamOptions(
      server,
      format,
      'handshake-identity',
      requestBody(format, [user('first'), model('authenticated answer'), user('second')]),
      {
        headers: {
          authorization: 'Bearer new-key',
          'x-tenant': 'tenant-b',
          'content-type': 'application/json'
        },
        onDecision: (decision) => decisions.push(decision)
      }
    ));

    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].connection, requests[1].connection);
    assert.equal(requests[0].authorization, 'Bearer old-key');
    assert.equal(requests[1].authorization, 'Bearer new-key');
    assert.equal(requests[0].tenant, 'tenant-a');
    assert.equal(requests[1].tenant, 'tenant-b');
    assert.equal('previous_response_id' in requests[1].request, false);
    assert.equal(requests[1].request.input.length, 3);
    assert.equal(decisions[1].connectionReused, false);
    assert.equal(decisions[1].connectionReason, 'handshake_identity_changed');
    assert.equal(decisions[1].reason, 'new_socket_generation');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('a physical WS reconnect clears connection-local previous_response_id and full-replays context', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const assistant = {
    id: 'msg_reconnect',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'before reconnect', annotations: [] }]
  };
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    sendCompleted(socket, `resp_reconnect_${requests.length}`, requests.length === 1 ? [assistant] : [], {
      afterCompleted: requests.length === 1 ? () => socket.close() : undefined
    });
  });
  try {
    const format = await formatForTest();
    await collect(streamOptions(
      server,
      format,
      'reconnect-full-replay',
      requestBody(format, [user('first')])
    ));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const decisions = [];
    await collect(streamOptions(
      server,
      format,
      'reconnect-full-replay',
      requestBody(format, [user('first'), model('before reconnect'), user('second')]),
      { onDecision: (decision) => decisions.push(decision) }
    ));

    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].connection, requests[1].connection);
    assert.equal('previous_response_id' in requests[1].request, false);
    assert.equal(requests[1].request.input.length, 3);
    assert.equal(decisions[0].connectionReused, false);
    assert.equal(decisions[0].mode, 'full');
    assert.equal(decisions[0].reason, 'new_socket_generation');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('a reliable retry explicitly forces a fresh physical socket and clears previous_response_id', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const assistant = {
    id: 'msg_force_retry_base',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'before retry', annotations: [] }]
  };
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    sendCompleted(socket, `resp_force_retry_${requests.length}`, requests.length === 1 ? [assistant] : []);
  });
  try {
    const format = await formatForTest();
    await collect(streamOptions(
      server,
      format,
      'force-fresh-retry',
      requestBody(format, [user('first')])
    ));
    const decisions = [];
    await collect(streamOptions(
      server,
      format,
      'force-fresh-retry',
      requestBody(format, [user('first'), model('before retry'), user('retry input')]),
      {
        forceNewConnection: true,
        onDecision: (decision) => decisions.push(decision)
      }
    ));

    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].connection, requests[1].connection);
    assert.equal('previous_response_id' in requests[1].request, false);
    assert.equal(requests[1].request.input.length, 3);
    assert.equal(decisions[0].connectionReused, false);
    assert.equal(decisions[0].connectionReason, 'retry_forced_reconnect');
    assert.equal(decisions[0].mode, 'full');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('aborting an in-flight response invalidates continuation before the next injected input', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  let resolveHeldRequest;
  const heldRequest = new Promise((resolve) => { resolveHeldRequest = resolve; });
  const assistant = {
    id: 'msg_abort_base',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'base answer', annotations: [] }]
  };
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) {
      sendCompleted(socket, 'resp_abort_base', [assistant]);
      return;
    }
    if (requests.length === 2) {
      resolveHeldRequest();
      return;
    }
    sendCompleted(socket, 'resp_after_abort', []);
  });
  try {
    const format = await formatForTest();
    const context = [user('first'), model('base answer')];
    await collect(streamOptions(server, format, 'abort-invalidates', requestBody(format, [user('first')])));

    const abort = new AbortController();
    const interrupted = collect(streamOptions(
      server,
      format,
      'abort-invalidates',
      requestBody(format, [...context, user('interrupted input')]),
      { signal: abort.signal }
    ));
    await heldRequest;
    abort.abort(new Error('synthetic user steer'));
    await assert.rejects(interrupted, /synthetic user steer/);

    await collect(streamOptions(
      server,
      format,
      'abort-invalidates',
      requestBody(format, [...context, user('interrupted input'), user('injected follow-up')])
    ));

    assert.equal(requests.length, 3);
    assert.equal(requests[1].request.previous_response_id, 'resp_abort_base');
    assert.notEqual(requests[1].connection, requests[2].connection);
    assert.equal('previous_response_id' in requests[2].request, false);
    assert.equal(requests[2].request.input.length, 4);
    assert.match(JSON.stringify(requests[2].request.input), /injected follow-up/);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('tool argument deltas stream independently and completed function calls are not duplicated in the suffix', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const toolCall = {
    id: 'fc_item_1',
    type: 'function_call',
    call_id: 'call_write_1',
    name: 'write',
    arguments: '{"path":"a.txt","content":"hello"}'
  };
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_tool_1' } }));
      socket.send(JSON.stringify({
        type: 'response.output_item.added',
        response_id: 'resp_tool_1',
        output_index: 0,
        item: { ...toolCall, arguments: '' }
      }));
      socket.send(JSON.stringify({
        type: 'response.function_call_arguments.delta',
        response_id: 'resp_tool_1',
        item_id: toolCall.id,
        output_index: 0,
        delta: '{"path":"a.txt",'
      }));
      socket.send(JSON.stringify({
        type: 'response.function_call_arguments.delta',
        response_id: 'resp_tool_1',
        item_id: toolCall.id,
        output_index: 0,
        delta: '"content":"hello"}'
      }));
      socket.send(JSON.stringify({
        type: 'response.output_item.done',
        response_id: 'resp_tool_1',
        output_index: 0,
        item: toolCall
      }));
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: { id: 'resp_tool_1', status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 } }
      }));
      return;
    }
    sendCompleted(socket, 'resp_tool_2', []);
  });
  try {
    const format = await formatForTest();
    const chunks = await collect(streamOptions(
      server,
      format,
      'tool-prefix',
      requestBody(format, [user('write a file')])
    ));
    const argumentDeltas = chunks.flatMap((chunk) => chunk.toolCallArgumentDeltas ?? []);
    const streamedArgs = argumentDeltas
      .reduce((value, delta) => delta.replace ? delta.argumentsDelta : value + delta.argumentsDelta, '');
    assert.deepEqual(
      argumentDeltas.map((delta) => delta.argumentsDelta),
      ['{"path":"a.txt",', '"content":"hello"}']
    );
    assert.equal(streamedArgs, toolCall.arguments);

    const modelToolCall = {
      role: 'model',
      parts: [{
        functionCall: {
          name: toolCall.name,
          args: { path: 'a.txt', content: 'hello' },
          callId: toolCall.call_id
        }
      }]
    };
    const toolResult = {
      role: 'user',
      parts: [{
        functionResponse: {
          name: toolCall.name,
          response: { ok: true },
          callId: toolCall.call_id
        }
      }]
    };
    await collect(streamOptions(
      server,
      format,
      'tool-prefix',
      requestBody(format, [user('write a file'), modelToolCall, toolResult])
    ));

    assert.equal(requests[1].request.previous_response_id, 'resp_tool_1');
    assert.equal(requests[1].request.input.length, 1);
    assert.equal(requests[1].request.input[0].type, 'function_call_output');
    assert.equal(requests[1].request.input[0].call_id, toolCall.call_id);
    assert.equal(requests[1].request.input.some((item) => item.type === 'function_call'), false);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('synchronous text delta bursts preserve provider event boundaries', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const assistant = {
    id: 'msg_text_burst',
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'hello world', annotations: [] }]
  };
  const server = await createServer((socket) => {
    socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_text_burst' } }));
    socket.send(JSON.stringify({
      type: 'response.output_item.added',
      response_id: 'resp_text_burst',
      output_index: 0,
      item: { ...assistant, status: 'in_progress', content: [] }
    }));
    for (const delta of ['hello ', 'world']) {
      socket.send(JSON.stringify({
        type: 'response.output_text.delta',
        response_id: 'resp_text_burst',
        item_id: assistant.id,
        output_index: 0,
        content_index: 0,
        delta
      }));
    }
    sendOutputItemDone(socket, 'resp_text_burst', 0, assistant);
    sendResponseCompleted(socket, 'resp_text_burst');
  });
  try {
    const format = await formatForTest();
    const chunks = await collect(streamOptions(
      server,
      format,
      'text-delta-burst',
      requestBody(format, [user('stream text')])
    ));
    assert.deepEqual(
      chunks.map((chunk) => chunk.textDelta).filter((delta) => typeof delta === 'string' && delta),
      ['hello ', 'world']
    );
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('later tool calls keep streaming output-index-only argument deltas after visible text', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const firstCall = {
    id: 'fc_item_first',
    type: 'function_call',
    call_id: 'call_first',
    name: 'read',
    arguments: '{"path":"a.txt"}'
  };
  const commentary = {
    id: 'msg_commentary_between_tools',
    type: 'message',
    role: 'assistant',
    phase: 'commentary',
    content: [{ type: 'output_text', text: '继续处理第二个文件。', annotations: [] }]
  };
  const secondCall = {
    id: 'fc_item_second',
    type: 'function_call',
    call_id: 'call_second',
    name: 'read',
    arguments: '{"path":"b.txt"}'
  };
  const server = await createServer((socket) => {
    socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_two_tools' } }));
    socket.send(JSON.stringify({
      type: 'response.output_item.added', response_id: 'resp_two_tools', output_index: 0,
      item: { ...firstCall, arguments: '' }
    }));
    socket.send(JSON.stringify({
      type: 'response.function_call_arguments.delta', response_id: 'resp_two_tools',
      item_id: firstCall.id, output_index: 0, delta: firstCall.arguments
    }));
    sendOutputItemDone(socket, 'resp_two_tools', 0, firstCall);
    socket.send(JSON.stringify({
      type: 'response.output_text.delta', response_id: 'resp_two_tools',
      item_id: commentary.id, output_index: 1, content_index: 0, delta: commentary.content[0].text
    }));
    sendOutputItemDone(socket, 'resp_two_tools', 1, commentary);
    socket.send(JSON.stringify({
      type: 'response.output_item.added', response_id: 'resp_two_tools', output_index: 2,
      item: { ...secondCall, arguments: '' }
    }));
    socket.send(JSON.stringify({
      type: 'response.function_call_arguments.delta', response_id: 'resp_two_tools',
      output_index: 2, delta: '{"path":'
    }));
    socket.send(JSON.stringify({
      type: 'response.in_progress', response: { id: 'resp_two_tools', status: 'in_progress' }
    }));
    socket.send(JSON.stringify({
      type: 'response.function_call_arguments.delta', response_id: 'resp_two_tools',
      output_index: 2, delta: '"b.txt"}'
    }));
    sendOutputItemDone(socket, 'resp_two_tools', 2, secondCall);
    sendResponseCompleted(socket, 'resp_two_tools');
  });
  try {
    const format = await formatForTest();
    const chunks = await collect(streamOptions(
      server,
      format,
      'tool-output-index-aliases',
      requestBody(format, [user('read two files')])
    ));
    const secondDeltas = chunks
      .flatMap((chunk) => chunk.toolCallArgumentDeltas ?? [])
      .filter((delta) => delta.callId === secondCall.call_id);
    assert.deepEqual(secondDeltas.map((delta) => delta.argumentsDelta), ['{"path":', '"b.txt"}']);
    assert.equal(secondDeltas.some((delta) => delta.replace === true), false);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('complete multi-block reasoning deltas use one canonical newline in stream and continuation ledger', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const signature = 'reasoning-signature-complete';
  const reasoning = reasoningItem('rs_complete', ['block-A', 'block-B'], signature);
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_reasoning_complete' } }));
      sendReasoningDelta(socket, 'resp_reasoning_complete', reasoning.id, 0, 'block-A');
      sendReasoningDelta(socket, 'resp_reasoning_complete', reasoning.id, 1, 'block-B');
      sendOutputItemDone(socket, 'resp_reasoning_complete', 0, reasoning);
      sendResponseCompleted(socket, 'resp_reasoning_complete');
      return;
    }
    sendCompleted(socket, 'resp_reasoning_complete_next', []);
  });
  try {
    const format = await formatForTest();
    const initial = user('reason about two blocks');
    const chunks = await collect(streamOptions(
      server,
      format,
      'reasoning-complete-multi-block',
      requestBody(format, [initial])
    ));
    assert.equal(streamedThought(chunks), 'block-A\nblock-B');

    const decisions = [];
    await collect(streamOptions(
      server,
      format,
      'reasoning-complete-multi-block',
      requestBody(format, [initial, reasoningModel('block-A\nblock-B', signature), user('continue')]),
      { onDecision: (decision) => decisions.push(decision) }
    ));
    assert.equal(requests[1].request.previous_response_id, 'resp_reasoning_complete');
    assert.equal(requests[1].request.input.length, 1);
    assert.equal(decisions[0].mode, 'incremental');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('summary added, delta, text done, and part done events validate without duplicating blocks', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const signature = 'reasoning-signature-lifecycle';
  const reasoning = reasoningItem('rs_lifecycle', ['life-A', 'life-B'], signature);
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_reasoning_lifecycle' } }));
      socket.send(JSON.stringify({
        type: 'response.output_item.added',
        response_id: 'resp_reasoning_lifecycle',
        output_index: 0,
        item: { id: reasoning.id, type: 'reasoning', summary: [] }
      }));
      for (const [summaryIndex, text] of ['life-A', 'life-B'].entries()) {
        sendReasoningSummaryPart(socket, 'added', 'resp_reasoning_lifecycle', reasoning.id, summaryIndex, '');
        sendReasoningDelta(socket, 'resp_reasoning_lifecycle', reasoning.id, summaryIndex, text);
        sendReasoningTextDone(socket, 'resp_reasoning_lifecycle', reasoning.id, summaryIndex, text);
        sendReasoningSummaryPart(socket, 'done', 'resp_reasoning_lifecycle', reasoning.id, summaryIndex, text);
      }
      sendOutputItemDone(socket, 'resp_reasoning_lifecycle', 0, reasoning);
      sendResponseCompletedWithoutOutput(socket, 'resp_reasoning_lifecycle');
      return;
    }
    sendCompleted(socket, 'resp_reasoning_lifecycle_next', []);
  });
  try {
    const format = await formatForTest();
    const initial = user('reason through full lifecycle');
    const chunks = await collect(streamOptions(
      server,
      format,
      'reasoning-full-lifecycle',
      requestBody(format, [initial])
    ));
    assert.equal(streamedThought(chunks), 'life-A\nlife-B');

    await collect(streamOptions(
      server,
      format,
      'reasoning-full-lifecycle',
      requestBody(format, [initial, reasoningModel('life-A\nlife-B', signature), user('continue')])
    ));
    assert.equal(requests[1].request.previous_response_id, 'resp_reasoning_lifecycle');
    assert.equal(requests[1].request.input.length, 1);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('summary text done-only blocks are projected canonically even when the decoder suppresses block two', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const signature = 'reasoning-signature-text-done-only';
  const reasoning = reasoningItem('rs_text_done_only', ['text-done-A', 'text-done-B'], signature);
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_text_done_only' } }));
      sendReasoningTextDone(socket, 'resp_text_done_only', reasoning.id, 0, 'text-done-A');
      sendReasoningTextDone(socket, 'resp_text_done_only', reasoning.id, 1, 'text-done-B');
      sendOutputItemDone(socket, 'resp_text_done_only', 0, reasoning);
      sendResponseCompleted(socket, 'resp_text_done_only');
      return;
    }
    sendCompleted(socket, 'resp_text_done_only_next', []);
  });
  try {
    const format = await formatForTest();
    const initial = user('done events only');
    const chunks = await collect(streamOptions(
      server,
      format,
      'reasoning-text-done-only',
      requestBody(format, [initial])
    ));
    assert.equal(streamedThought(chunks), 'text-done-A\ntext-done-B');

    await collect(streamOptions(
      server,
      format,
      'reasoning-text-done-only',
      requestBody(format, [
        initial,
        reasoningModel('text-done-A\ntext-done-B', signature),
        user('continue')
      ])
    ));
    assert.equal(requests[1].request.previous_response_id, 'resp_text_done_only');
    assert.equal(requests[1].request.input.length, 1);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('done-only multi-block reasoning shares the same canonical terminal projection', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const signature = 'reasoning-signature-done-only';
  const reasoning = reasoningItem('rs_done_only', ['done-A', 'done-B'], signature);
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_reasoning_done_only' } }));
      sendOutputItemDone(socket, 'resp_reasoning_done_only', 0, reasoning);
      sendResponseCompleted(socket, 'resp_reasoning_done_only');
      return;
    }
    sendCompleted(socket, 'resp_reasoning_done_only_next', []);
  });
  try {
    const format = await formatForTest();
    const initial = user('done-only reasoning');
    const chunks = await collect(streamOptions(
      server,
      format,
      'reasoning-done-only',
      requestBody(format, [initial])
    ));
    assert.equal(streamedThought(chunks), 'done-A\ndone-B');

    await collect(streamOptions(
      server,
      format,
      'reasoning-done-only',
      requestBody(format, [initial, reasoningModel('done-A\ndone-B', signature), user('continue')])
    ));
    assert.equal(requests[1].request.previous_response_id, 'resp_reasoning_done_only');
    assert.equal(requests[1].request.input.length, 1);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('partial reasoning deltas accept only the exact suffix supplied by the terminal item', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const signature = 'reasoning-signature-partial';
  const reasoning = reasoningItem('rs_partial', ['partial-A', 'partial-B'], signature);
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_reasoning_partial' } }));
      sendReasoningDelta(socket, 'resp_reasoning_partial', reasoning.id, 0, 'partial-A');
      sendOutputItemDone(socket, 'resp_reasoning_partial', 0, reasoning);
      sendResponseCompleted(socket, 'resp_reasoning_partial');
      return;
    }
    sendCompleted(socket, 'resp_reasoning_partial_next', []);
  });
  try {
    const format = await formatForTest();
    const initial = user('partial reasoning');
    const chunks = await collect(streamOptions(
      server,
      format,
      'reasoning-partial',
      requestBody(format, [initial])
    ));
    assert.equal(streamedThought(chunks), 'partial-A\npartial-B');

    await collect(streamOptions(
      server,
      format,
      'reasoning-partial',
      requestBody(format, [initial, reasoningModel('partial-A\npartial-B', signature), user('continue')])
    ));
    assert.equal(requests[1].request.previous_response_id, 'resp_reasoning_partial');
    assert.equal(requests[1].request.input.length, 1);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('a terminal reasoning revision that conflicts with streamed blocks does not commit continuation', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const signature = 'reasoning-signature-revised';
  const revised = reasoningItem('rs_revised', ['revision-A', 'revision-C'], signature);
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_reasoning_revised' } }));
      sendReasoningDelta(socket, 'resp_reasoning_revised', revised.id, 0, 'revision-A');
      sendReasoningDelta(socket, 'resp_reasoning_revised', revised.id, 1, 'revision-B');
      sendOutputItemDone(socket, 'resp_reasoning_revised', 0, revised);
      sendResponseCompleted(socket, 'resp_reasoning_revised');
      return;
    }
    sendCompleted(socket, 'resp_reasoning_revised_next', []);
  });
  try {
    const format = await formatForTest();
    const initial = user('revision safety');
    const chunks = await collect(streamOptions(
      server,
      format,
      'reasoning-revision-conflict',
      requestBody(format, [initial])
    ));
    assert.equal(streamedThought(chunks), 'revision-A\nrevision-B');

    const decisions = [];
    await collect(streamOptions(
      server,
      format,
      'reasoning-revision-conflict',
      requestBody(format, [initial, reasoningModel('revision-A\nrevision-B', signature), user('continue')]),
      { onDecision: (decision) => decisions.push(decision) }
    ));
    assert.equal('previous_response_id' in requests[1].request, false);
    assert.equal(requests[1].request.input.length, 3);
    assert.equal(decisions[0].mode, 'full');
    assert.equal(decisions[0].reason, 'no_completed_baseline');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('completed output owns reasoning and tool order while done supplies one trusted signature', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const signature = 'reasoning-signature-tool';
  const reasoning = reasoningItem('rs_tool', ['tool-A', 'tool-B'], signature);
  const call = {
    id: 'fc_tool',
    type: 'function_call',
    call_id: 'call_tool',
    name: 'read',
    arguments: '{"path":"a.txt"}'
  };
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_reasoning_tool' } }));
      sendReasoningDelta(socket, 'resp_reasoning_tool', reasoning.id, 0, 'tool-A');
      sendReasoningDelta(socket, 'resp_reasoning_tool', reasoning.id, 1, 'tool-B');
      sendOutputItemDone(socket, 'resp_reasoning_tool', 0, reasoning);
      sendOutputItemDone(socket, 'resp_reasoning_tool', 1, call);
      sendResponseCompleted(socket, 'resp_reasoning_tool', [
        { ...reasoning, encrypted_content: 'completed-copy-must-not-win' },
        call
      ]);
      return;
    }
    sendCompleted(socket, 'resp_reasoning_tool_next', []);
  });
  try {
    const format = await formatForTest();
    const initial = user('reason then read');
    const chunks = await collect(streamOptions(
      server,
      format,
      'reasoning-tool-order',
      requestBody(format, [initial])
    ));
    assert.equal(streamedThought(chunks), 'tool-A\ntool-B');

    const assistant = reasoningModel('tool-A\ntool-B', signature, [{
      functionCall: { name: call.name, args: { path: 'a.txt' }, callId: call.call_id }
    }]);
    const toolResult = {
      role: 'user',
      parts: [{
        functionResponse: { name: call.name, response: { ok: true }, callId: call.call_id }
      }]
    };
    await collect(streamOptions(
      server,
      format,
      'reasoning-tool-order',
      requestBody(format, [initial, assistant, toolResult])
    ));
    assert.equal(requests[1].request.previous_response_id, 'resp_reasoning_tool');
    assert.equal(requests[1].request.input.length, 1);
    assert.equal(requests[1].request.input[0].type, 'function_call_output');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('multiple independent reasoning items preserve boundaries and commit one exact continuation baseline', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const first = reasoningItem('rs_first', ['first'], 'signature-first');
  const second = reasoningItem('rs_second', ['second'], 'signature-second');
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_multiple_reasoning' } }));
      sendOutputItemDone(socket, 'resp_multiple_reasoning', 0, first);
      sendOutputItemDone(socket, 'resp_multiple_reasoning', 1, second);
      sendResponseCompleted(socket, 'resp_multiple_reasoning', [first, second]);
      return;
    }
    sendCompleted(socket, 'resp_multiple_reasoning_next', []);
  });
  try {
    const format = await formatForTest();
    const initial = user('multiple reasoning items');
    const chunks = await collect(streamOptions(
      server,
      format,
      'multiple-reasoning-items',
      requestBody(format, [initial])
    ));
    assert.equal(streamedThought(chunks), 'first\nsecond');
    assert.deepEqual(
      chunks.find((chunk) => chunk.completedContent)?.completedContent,
      {
        role: 'model',
        parts: [
          {
            text: 'first',
            thought: true,
            thoughtSignatures: { 'openai-responses': 'signature-first' },
            outputItem: { id: 'rs_first', ordinal: 0 }
          },
          {
            text: 'second',
            thought: true,
            thoughtSignatures: { 'openai-responses': 'signature-second' },
            outputItem: { id: 'rs_second', ordinal: 1 }
          }
        ]
      }
    );

    await collect(streamOptions(
      server,
      format,
      'multiple-reasoning-items',
      requestBody(format, [initial, {
        role: 'model',
        parts: [
          {
            text: 'first',
            thought: true,
            thoughtSignatures: { 'openai-responses': 'signature-first' }
          },
          {
            text: 'second',
            thought: true,
            thoughtSignatures: { 'openai-responses': 'signature-second' }
          }
        ]
      }, user('continue')])
    ));
    assert.equal(requests[1].request.previous_response_id, 'resp_multiple_reasoning');
    assert.equal(requests[1].request.input.length, 1);
    assert.equal(requests[1].request.input[0].role, 'user');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('completed content preserves reasoning-tool-reasoning-text order', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const first = reasoningItem('rs_order_first', ['inspect'], 'signature-inspect');
  const second = reasoningItem('rs_order_second', ['verify'], 'signature-verify');
  const call = {
    id: 'fc_order',
    type: 'function_call',
    call_id: 'call_order',
    name: 'read',
    arguments: '{"path":"ordered.txt"}'
  };
  const answer = {
    id: 'msg_order',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'done', annotations: [] }]
  };
  const server = await createServer((socket) => {
    sendCompleted(socket, 'resp_reasoning_tool_reasoning', [first, call, second, answer]);
  });
  try {
    const format = await formatForTest();
    const chunks = await collect(streamOptions(
      server,
      format,
      'reasoning-tool-reasoning-order',
      requestBody(format, [user('preserve ordered output')])
    ));
    assert.equal(streamedThought(chunks), 'inspect\nverify');
    assert.deepEqual(
      chunks.find((chunk) => chunk.completedContent)?.completedContent,
      {
        role: 'model',
        parts: [
          {
            text: 'inspect',
            thought: true,
            thoughtSignatures: { 'openai-responses': 'signature-inspect' },
            outputItem: { id: 'rs_order_first', ordinal: 0 }
          },
          {
            functionCall: {
              name: 'read',
              args: { path: 'ordered.txt' },
              callId: 'call_order'
            },
            outputItem: { id: 'fc_order', ordinal: 1 }
          },
          {
            text: 'verify',
            thought: true,
            thoughtSignatures: { 'openai-responses': 'signature-verify' },
            outputItem: { id: 'rs_order_second', ordinal: 2 }
          },
          {
            text: 'done',
            outputItem: { id: 'msg_order', ordinal: 3 }
          }
        ]
      }
    );
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('multiple assistant message items preserve commentary/final phases and one continuation baseline', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const commentary = {
    id: 'msg_phase_commentary',
    type: 'message',
    role: 'assistant',
    phase: 'commentary',
    content: [{ type: 'output_text', text: '先检查环境。', annotations: [] }]
  };
  const finalAnswer = {
    id: 'msg_phase_final',
    type: 'message',
    role: 'assistant',
    phase: 'final_answer',
    content: [{ type: 'output_text', text: '检查完成。', annotations: [] }]
  };
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) {
      sendCompleted(socket, 'resp_message_phases', [commentary, finalAnswer]);
      return;
    }
    sendCompleted(socket, 'resp_message_phases_next', []);
  });
  try {
    const format = await formatForTest();
    const initial = user('check the environment');
    const chunks = await collect(streamOptions(
      server,
      format,
      'multiple-message-phases',
      requestBody(format, [initial])
    ));
    const completed = chunks.find((chunk) => chunk.completedContent)?.completedContent;
    assert.deepEqual(completed, {
      role: 'model',
      parts: [
        {
          text: '先检查环境。',
          outputItem: { id: commentary.id, ordinal: 0, phase: 'commentary' }
        },
        {
          text: '检查完成。',
          outputItem: { id: finalAnswer.id, ordinal: 1, phase: 'final_answer' }
        }
      ]
    });

    const nextBody = requestBody(format, [initial, user('continue')]);
    nextBody.input.splice(1, 0,
      {
        type: 'message', role: 'assistant', phase: 'commentary',
        content: [{ type: 'output_text', text: '先检查环境。' }]
      },
      {
        type: 'message', role: 'assistant', phase: 'final_answer',
        content: [{ type: 'output_text', text: '检查完成。' }]
      }
    );
    await collect(streamOptions(server, format, 'multiple-message-phases', nextBody));
    assert.equal(requests[1].request.previous_response_id, 'resp_message_phases');
    assert.equal(requests[1].request.input.length, 1);
    assert.equal(requests[1].request.input[0].role, 'user');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('done-only terminal membership with a non-contiguous output index does not commit continuation', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const assistant = {
    id: 'msg_done_index_gap',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'gap-output', annotations: [] }]
  };
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_done_index_gap' } }));
      socket.send(JSON.stringify({
        type: 'response.output_text.delta',
        response_id: 'resp_done_index_gap',
        item_id: assistant.id,
        output_index: 2,
        content_index: 0,
        delta: 'gap-output'
      }));
      sendOutputItemDone(socket, 'resp_done_index_gap', 2, assistant);
      sendResponseCompleted(socket, 'resp_done_index_gap');
      return;
    }
    sendCompleted(socket, 'resp_done_index_gap_next', []);
  });
  try {
    const format = await formatForTest();
    const initial = user('index gap safety');
    await collect(streamOptions(
      server,
      format,
      'done-output-index-gap',
      requestBody(format, [initial])
    ));

    const decisions = [];
    await collect(streamOptions(
      server,
      format,
      'done-output-index-gap',
      requestBody(format, [initial, model('gap-output'), user('continue')]),
      { onDecision: (decision) => decisions.push(decision) }
    ));
    assert.equal('previous_response_id' in requests[1].request, false);
    assert.equal(decisions[0].mode, 'full');
    assert.equal(decisions[0].reason, 'no_completed_baseline');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('a first-event black hole emits transport phases, invalidates the socket, and releases the session lock', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) return;
    sendCompleted(socket, 'resp_after_first_event_timeout', [{
      id: 'msg_after_first_event_timeout',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'recovered', annotations: [] }]
    }]);
  });
  try {
    const format = await formatForTest();
    const firstPhases = [];
    await assert.rejects(
      collect(streamOptions(
        server,
        format,
        'first-event-black-hole',
        requestBody(format, [user('wait forever')]),
        {
          onPhase: (phase) => firstPhases.push(phase),
          timeouts: { firstEventMs: 40, eventIdleMs: 100, responseMs: 500, sendMs: 100, handshakeMs: 100 }
        }
      )),
      (error) => error?.code === 'LLM_TRANSPORT_TIMEOUT'
        && error?.phase === 'first_event'
        && error?.timeoutMs === 40
    );
    assert.deepEqual(firstPhases.map((phase) => phase.phase).slice(0, 6), [
      'lock_wait', 'lock_acquired', 'socket_opening', 'socket_opened', 'send_started', 'request_sent'
    ]);
    assert.equal(firstPhases.some((phase) => phase.phase === 'first_raw_event'), false);
    assert.equal(firstPhases.at(-1)?.phase, 'timeout');
    assert.equal(firstPhases.at(-1)?.timeoutPhase, 'first_event');

    const recoveryPhases = [];
    const chunks = await collect(streamOptions(
      server,
      format,
      'first-event-black-hole',
      requestBody(format, [user('wait forever'), user('retry safely')]),
      {
        onPhase: (phase) => recoveryPhases.push(phase),
        timeouts: { firstEventMs: 100, eventIdleMs: 100, responseMs: 500, sendMs: 100, handshakeMs: 100 }
      }
    ));
    assert.equal(chunks.map((chunk) => chunk.textDelta ?? '').join(''), 'recovered');
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].connection, requests[1].connection);
    assert.equal('previous_response_id' in requests[1].request, false);
    assert.ok(recoveryPhases.some((phase) => phase.phase === 'first_raw_event'));
    assert.ok(recoveryPhases.some((phase) => phase.phase === 'first_semantic_event'));
    assert.equal(recoveryPhases.at(-1)?.phase, 'terminal');
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('a relay that stalls while assembling tool arguments fails on the event-idle deadline and releases the session lock', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_stalled_tool' } }));
      socket.send(JSON.stringify({
        type: 'response.output_item.added',
        response_id: 'resp_stalled_tool',
        output_index: 0,
        item: {
          id: 'fc_stalled_tool',
          type: 'function_call',
          call_id: 'call_stalled_tool',
          name: 'bash',
          arguments: ''
        }
      }));
      socket.send(JSON.stringify({
        type: 'response.function_call_arguments.delta',
        response_id: 'resp_stalled_tool',
        item_id: 'fc_stalled_tool',
        output_index: 0,
        delta: '{"command":"printf ok\\n"}'
      }));
      return;
    }
    sendCompleted(socket, 'resp_after_stall', []);
  });
  try {
    const format = await formatForTest();
    await assert.rejects(
      collect(streamOptions(
        server,
        format,
        'stalled-tool-call',
        requestBody(format, [user('run a command')]),
        { timeouts: {
          firstEventMs: 100,
          eventIdleMs: 40,
          responseMs: 500,
          sendMs: 100,
          handshakeMs: 100
        } }
      )),
      (error) => error?.code === 'LLM_TRANSPORT_TIMEOUT'
        && error?.phase === 'event_idle'
        && error?.timeoutMs === 40
    );

    await collect(streamOptions(
      server,
      format,
      'stalled-tool-call',
      requestBody(format, [user('run a command'), user('retry safely')]),
      { timeouts: {
        firstEventMs: 100,
        eventIdleMs: 100,
        responseMs: 500,
        sendMs: 100,
        handshakeMs: 100
      } }
    ));
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].connection, requests[1].connection);
    assert.equal('previous_response_id' in requests[1].request, false);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('OPEN WebSocket 空闲超过 55 分钟 age cap 后必须淘汰并以完整上下文重连', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const realDateNow = Date.now;
  let fakeNow = realDateNow();
  Date.now = () => fakeNow;
  const requests = [];
  const assistant = {
    id: 'msg_idle_ttl',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'before idle ttl', annotations: [] }]
  };
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    sendCompleted(socket, `resp_idle_ttl_${requests.length}`, requests.length === 1 ? [assistant] : []);
  });
  try {
    const format = await formatForTest();
    await collect(streamOptions(
      server,
      format,
      'idle-ttl-target',
      requestBody(format, [user('first')])
    ));

    fakeNow += 55 * 60 * 1_000 + 1;
    await collect(streamOptions(
      server,
      format,
      'idle-ttl-eviction-trigger',
      requestBody(format, [user('trigger eviction')])
    ));
    const decisions = [];
    await collect(streamOptions(
      server,
      format,
      'idle-ttl-target',
      requestBody(format, [user('first'), model('before idle ttl'), user('after idle')]),
      {
        onDecision: (decision) => decisions.push(decision),
        onPhase: (phase) => phases.push(phase)
      }
    ));

    assert.equal(requests.length, 3);
    assert.notEqual(requests[0].connection, requests[2].connection);
    assert.equal('previous_response_id' in requests[2].request, false);
    assert.equal(requests[2].request.input.length, 3);
    assert.equal(decisions[0].connectionReused, false);
    assert.equal(decisions[0].mode, 'full');
  } finally {
    Date.now = realDateNow;
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('WS reuse admission keeps a healthy OPEN socket across a 55s inter-turn pause', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const realDateNow = Date.now;
  let fakeNow = realDateNow();
  Date.now = () => fakeNow;
  const requests = [];
  const decisions = [];
  const phases = [];
  const assistant = {
    id: 'msg_reuse_idle',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'reuse baseline', annotations: [] }]
  };
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    sendCompleted(socket, `resp_reuse_idle_${requests.length}`, requests.length === 1 ? [assistant] : []);
  });
  try {
    const format = await formatForTest();
    await collect(streamOptions(
      server,
      format,
      'reuse-idle-boundary',
      requestBody(format, [user('first')]),
      {
        onDecision: (decision) => decisions.push(decision),
        onPhase: (phase) => phases.push(phase)
      }
    ));

    fakeNow += 55_000;
    await collect(streamOptions(
      server,
      format,
      'reuse-idle-boundary',
      requestBody(format, [user('first'), model('reuse baseline'), user('second')]),
      {
        onDecision: (decision) => decisions.push(decision),
        onPhase: (phase) => phases.push(phase)
      }
    ));

    fakeNow += 55_000;
    await collect(streamOptions(
      server,
      format,
      'reuse-idle-boundary',
      requestBody(format, [
        user('first'),
        model('reuse baseline'),
        user('second'),
        user('third')
      ]),
      { onDecision: (decision) => decisions.push(decision) }
    ));

    assert.equal(requests.length, 3);
    assert.equal(requests[0].connection, requests[1].connection);
    assert.equal(requests[1].request.previous_response_id, 'resp_reuse_idle_1');
    assert.equal(decisions[1].connectionReason, 'reused');
    assert.equal(decisions[1].mode, 'incremental');

    assert.equal(requests[1].connection, requests[2].connection);
    assert.equal(requests[2].request.previous_response_id, 'resp_reuse_idle_2');
    assert.equal(decisions[2].connectionReused, true);
    assert.equal(decisions[2].connectionReason, 'reused');
    assert.equal(decisions[2].mode, 'incremental');
    assert.ok(phases.some((phase) => phase.phase === 'socket_probe_started'));
    assert.ok(phases.some((phase) => phase.phase === 'socket_probe_succeeded'));
  } finally {
    Date.now = realDateNow;
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('heartbeat invalidates an OPEN socket that stops answering pong before the next request', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    sendCompleted(socket, `resp_heartbeat_${requests.length}`, []);
  }, { autoPong: false });
  const timeouts = {
    handshakeMs: 100,
    sendMs: 100,
    firstEventMs: 100,
    eventIdleMs: 100,
    responseMs: 500,
    heartbeatIntervalMs: 10,
    pongTimeoutMs: 30,
    preSendProbeStaleMs: 20,
    preSendProbeTimeoutMs: 20
  };
  try {
    const format = await formatForTest();
    await collect(streamOptions(
      server,
      format,
      'heartbeat-unresponsive',
      requestBody(format, [user('first')]),
      { timeouts }
    ));
    await new Promise((resolve) => setTimeout(resolve, 55));
    await collect(streamOptions(
      server,
      format,
      'heartbeat-unresponsive',
      requestBody(format, [user('first'), user('second')]),
      { timeouts }
    ));

    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].connection, requests[1].connection);
    assert.equal('previous_response_id' in requests[1].request, false);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('configured reconnect closes before response terminal are retryable after partial output', { concurrency: false }, async () => {
  for (const fixture of [
    { closeCode: 1000, reason: 'normal transport close', retryable: true },
    { closeCode: 1001, reason: 'going away', retryable: true },
    { closeCode: 1005, reason: '', retryable: true, closeWithoutStatus: true },
    { closeCode: 1006, reason: '', retryable: true, terminate: true },
    { closeCode: 1011, reason: 'internal error', retryable: true },
    { closeCode: 1012, reason: 'service restart', retryable: true },
    { closeCode: 1013, reason: 'Try Again Later', retryable: true },
    { closeCode: 1014, reason: 'bad gateway', retryable: true },
    { closeCode: 1008, reason: 'policy violation', retryable: true }
  ]) {
    resetOpenAIResponsesWebSocketSessions();
    const server = await createServer((socket) => {
      socket.send(JSON.stringify({ type: 'response.created', response: { id: `resp_close_${fixture.closeCode}` } }));
      socket.send(JSON.stringify({
        type: 'response.output_text.delta',
        response_id: `resp_close_${fixture.closeCode}`,
        item_id: `msg_close_${fixture.closeCode}`,
        output_index: 0,
        content_index: 0,
        delta: 'partial output'
      }), () => {
        if (fixture.terminate) socket.terminate();
        else if (fixture.closeWithoutStatus) socket.close();
        else socket.close(fixture.closeCode, fixture.reason);
      });
    });
    try {
      const format = await formatForTest();
      await assert.rejects(
        collect(streamOptions(
          server,
          format,
          `pre-terminal-close-${fixture.closeCode}`,
          requestBody(format, [user('must reach a Responses terminal event')])
        )),
        (error) => error?.name === 'WebSocketCloseError'
          && error?.closeCode === fixture.closeCode
          && error?.phase === 'streaming'
          && error?.receivedServerEvent === true
          && error?.receivedSemanticOutput === true
          && error?.retryable === fixture.retryable
      );
    } finally {
      resetOpenAIResponsesWebSocketSessions();
      await server.close();
    }
  }
});

test('response.created before EOF remains replay-safe and the next request uses a fresh socket', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const requests = [];
  const server = await createServer((socket, request, connection) => {
    requests.push({ request, connection });
    if (requests.length === 1) {
      socket.send(JSON.stringify({
        type: 'response.created',
        response: { id: 'resp_created_only' }
      }), () => socket.close(1000, 'created without semantic output'));
      return;
    }
    sendCompleted(socket, 'resp_after_created_eof', []);
  });
  try {
    const format = await formatForTest();
    await assert.rejects(
      collect(streamOptions(
        server,
        format,
        'created-before-eof',
        requestBody(format, [user('first attempt')])
      )),
      (error) => error?.name === 'WebSocketCloseError'
        && error?.receivedServerEvent === true
        && error?.receivedSemanticOutput === false
        && error?.retryable === true
    );

    await collect(streamOptions(
      server,
      format,
      'created-before-eof',
      requestBody(format, [user('first attempt'), user('retry')])
    ));
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0].connection, requests[1].connection);
    assert.equal('previous_response_id' in requests[1].request, false);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});

test('response.cancelled is surfaced as a provider error instead of a completed response', { concurrency: false }, async () => {
  resetOpenAIResponsesWebSocketSessions();
  const server = await createServer((socket) => {
    socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp_cancelled' } }));
    socket.send(JSON.stringify({ type: 'response.cancelled', response_id: 'resp_cancelled' }));
  });
  try {
    const format = await formatForTest();
    const chunks = await collect(streamOptions(
      server,
      format,
      'provider-cancelled',
      requestBody(format, [user('cancelled upstream')])
    ));
    assert.equal(chunks.some((chunk) => chunk.error), true);
    assert.match(JSON.stringify(chunks), /response\.cancelled/);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    await server.close();
  }
});
