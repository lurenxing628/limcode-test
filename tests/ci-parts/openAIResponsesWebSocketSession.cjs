const test = require('node:test');

const assert = require('node:assert/strict');

const { once } = require('node:events');

const { WebSocketServer } = require('ws');

const {
  LIMCODE_OPENAI_RESPONSES_WS_IMPLEMENTATION,
  resetOpenAIResponsesWebSocketSessions,
  streamOpenAIResponsesWebSocketSession
} = require('../../dist/extension/backend/capabilities/openAIResponsesWebSocketSession.js');

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

function registerCases(test) {

test('continuation crosses the 16-incremental boundary once and performs an exact full rebase', { concurrency: false }, async () => {
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
    for (let ordinal = 1; ordinal <= 18; ordinal += 1) {
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
    assert.deepEqual(fullIndexes, [0, 17]);
    assert.equal(fullIndexes.length, 2);
    assert.equal(incrementalIndexes.length, 16);
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
}

module.exports = { registerCases };
