import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
const {
  startLlmProvider
} = require('../../dist/extension/backend/capabilities/llmProvider.js');
const {
  resetOpenAIResponsesWebSocketSessions,
  streamOpenAIResponsesWebSocketSession
} = require('../../dist/extension/backend/capabilities/openAIResponsesWebSocketSession.js');

function providerConfig(baseUrl) {
  return {
    id: 'provider-ws-policy',
    name: 'WS Policy Fixture',
    provider: 'openai-responses',
    baseUrl,
    model: 'gpt-test',
    models: [{ id: 'gpt-test', name: 'GPT Test' }],
    apiKey: 'sk-test',
    toolCallFormat: 'function-call',
    openaiResponsesTransport: 'websocket',
    stream: true,
    retryOnError: false,
    retryMaxAttempts: 0,
    enableMultimodalTools: true,
    promptCache: { enabled: false, mode: 'key', ttl: '30m' },
    modelConfigs: [],
    createdAt: 1,
    updatedAt: 1
  };
}

function reliableRequest(id, conversationId, attemptOverrides = {}) {
  return {
    id,
    conversationId,
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    tools: [],
    reliableProviderAttempt: {
      attemptSeq: 5,
      maxAttempts: 5,
      requestCreatedAt: Date.now(),
      ...attemptOverrides
    }
  };
}

async function createFallbackServer({
  sendCreatedBeforeClose = false,
  sendSemanticBeforeClose = false,
  sendSignatureOnlyReasoningBeforeClose = false,
  completeWebSocket = false
} = {}) {
  let httpCalls = 0;
  let webSocketCalls = 0;
  const webSocketRequests = [];
  const httpRequests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.resume();
    request.once('end', () => {
      httpRequests.push(JSON.parse(body));
      httpCalls += 1;
      const responseId = `resp_http_${httpCalls}`;
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
      });
      for (const event of [
        { type: 'response.created', response: { id: responseId } },
        {
          type: 'response.output_text.delta',
          response_id: responseId,
          item_id: `msg_http_${httpCalls}`,
          output_index: 0,
          content_index: 0,
          delta: `HTTP rescue ${httpCalls}`
        },
        {
          type: 'response.output_item.done',
          response_id: responseId,
          output_index: 0,
          item: {
            id: `msg_http_${httpCalls}`,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: `HTTP rescue ${httpCalls}`, annotations: [] }]
          }
        },
        {
          type: 'response.completed',
          response: {
            id: responseId,
            status: 'completed',
            output: [],
            usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 }
          }
        }
      ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketCalls += 1;
      const connection = webSocketCalls;
      webSocket.once('message', (raw) => {
        const payloadText = raw.toString();
        const requestBody = JSON.parse(payloadText);
        webSocketRequests.push({ connection, request: requestBody, payloadText });
        if (completeWebSocket) {
          const responseId = `resp_ws_${connection}`;
          const text = `WS success ${connection}`;
          webSocket.send(JSON.stringify({ type: 'response.created', response: { id: responseId } }));
          webSocket.send(JSON.stringify({
            type: 'response.output_text.delta', response_id: responseId,
            item_id: `msg_ws_${connection}`, output_index: 0, content_index: 0, delta: text
          }));
          webSocket.send(JSON.stringify({
            type: 'response.output_item.done', response_id: responseId, output_index: 0,
            item: {
              id: `msg_ws_${connection}`, type: 'message', role: 'assistant',
              content: [{ type: 'output_text', text, annotations: [] }]
            }
          }));
          webSocket.send(JSON.stringify({
            type: 'response.completed',
            response: { id: responseId, status: 'completed', output: [] }
          }));
          return;
        }
        if (!sendCreatedBeforeClose) {
          webSocket.terminate();
          return;
        }
        webSocket.send(JSON.stringify({
          type: 'response.created',
          response: { id: `resp_ws_${connection}` }
        }), () => {
          if (sendSignatureOnlyReasoningBeforeClose) {
            webSocket.send(JSON.stringify({
              type: 'response.output_item.done',
              response_id: `resp_ws_${connection}`,
              output_index: 0,
              item: {
                id: `reasoning_ws_${connection}`,
                type: 'reasoning',
                summary: [],
                encrypted_content: `opaque_reasoning_${connection}`
              }
            }), () => webSocket.terminate());
            return;
          }
          if (!sendSemanticBeforeClose) {
            webSocket.terminate();
            return;
          }
          webSocket.send(JSON.stringify({
            type: 'response.output_text.delta',
            response_id: `resp_ws_${connection}`,
            item_id: `msg_ws_${connection}`,
            output_index: 0,
            content_index: 0,
            delta: 'partial semantic output'
          }), () => webSocket.terminate());
        });
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    counts: () => ({ httpCalls, webSocketCalls }),
    webSocketRequests: () => [...webSocketRequests],
    httpRequests: () => structuredClone(httpRequests),
    async close() {
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise((resolve) => webSocketServer.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function runFallbackRequest(server, id, conversationId, traces, attemptOverrides, debugCapture, tools = []) {
  const events = [];
  await startLlmProvider(
    { ...reliableRequest(id, conversationId, attemptOverrides), tools },
    (event) => events.push(event),
    {
      debugCapture,
      settings: async () => providerConfig(server.baseUrl),
      onTransportTrace: (trace) => traces.push(trace)
    }
  );
  return events;
}

async function responsesFormat() {
  const unified = await import('unified-llm-provider');
  return new unified.OpenAIResponsesFormat('gpt-test');
}

test('自动切换连接后仍明确保留编辑工具的非严格参数约束', async t => {
  resetOpenAIResponsesWebSocketSessions();
  const server = await createFallbackServer({ sendCreatedBeforeClose: true });
  t.after(async () => { resetOpenAIResponsesWebSocketSessions(); await server.close(); });
  const { editToolParameters } = require('../../dist/extension/backend/world/modules/tools/definitions/edit/index.js');
  const parameters = editToolParameters();
  const original = structuredClone(parameters);
  const events = await runFallbackRequest(server, 'edit-fallback', 'edit-fallback-conversation', [], undefined, undefined, [{ name: 'edit', description: '编辑文件', parameters }]);
  assert.ok(events.some(event => event.type === 'llm:done'));
  assert.deepEqual(server.counts(), { httpCalls: 1, webSocketCalls: 1 });
  for (const body of [server.webSocketRequests()[0].request, server.httpRequests()[0]]) {
    const edit = body.tools.find(tool => tool.name === 'edit');
    assert.equal(edit.strict, false, '连接切换不能恢复自动严格模式');
    assert.equal(edit.parameters.oneOf, undefined);
    assert.deepEqual(edit.parameters.required, ['path', 'mode']);
    assert.deepEqual(edit.parameters.properties.mode.enum, ['hunk', 'insert', 'delete']);
  }
  assert.deepEqual(parameters, original);
});

test('取证跟随真实长连接切换到普通连接，并保留同一请求的来源', async t => {
  resetOpenAIResponsesWebSocketSessions();
  const server = await createFallbackServer({ sendCreatedBeforeClose: true });
  t.after(async () => { resetOpenAIResponsesWebSocketSessions(); await server.close(); });
  const records = [];
  const recorder = { active: () => 'capture-fallback', record: event => {
    records.push(structuredClone(event)); return { runId: 'capture-fallback', captureSeq: records.length };
  } };
  const events = await runFallbackRequest(server, 'request-debug-fallback', 'conversation-debug-fallback', [], undefined, recorder);
  assert.ok(events.some(event => event.type === 'llm:done'));
  assert.deepEqual(server.counts(), { httpCalls: 1, webSocketCalls: 1 });
  assert.ok(records.some(event => event.stage === 'transport.receive' && event.metadata.transport === 'websocket'));
  assert.ok(records.some(event => event.stage === 'transport.receive' && event.metadata.transport === 'http'));
  assert.ok(records.some(event => event.stage === 'transport.phase' && event.metadata.phase === 'http_fallback'));
  assert.ok(records.some(event => event.stage === 'http.decoded'));
  assert.ok(records.some(event => event.stage === 'capability.output' && event.sources.length > 0));
  assert.ok(records.filter(event => event.context).every(event => event.context.modelRequestId === 'request-debug-fallback'));
});

function responseRequestBody(format, contents) {
  return format.encodeRequest({ contents }, true);
}

function userContent(text) {
  return { role: 'user', parts: [{ text }] };
}

async function collectWebSocketStream(options) {
  const chunks = [];
  for await (const chunk of streamOpenAIResponsesWebSocketSession(options)) chunks.push(chunk);
  return chunks;
}

test('WS budget exhaustion falls back once to HTTP and applies a short conversation cooldown', async () => {
  const server = await createFallbackServer();
  try {
    const firstTraces = [];
    const first = await runFallbackRequest(server, 'fallback-1', 'conversation-fallback', firstTraces);
    assert.equal(first.some((event) => event.type === 'llm:error'), false);
    assert.equal(first.some((event) => event.type === 'llm:done'), true);
    assert.deepEqual(server.counts(), { httpCalls: 1, webSocketCalls: 1 });
    assert.ok(firstTraces.some((trace) => trace.phase === 'http_fallback'));

    const secondTraces = [];
    const second = await runFallbackRequest(server, 'fallback-2', 'conversation-fallback', secondTraces);
    assert.equal(second.some((event) => event.type === 'llm:error'), false);
    assert.equal(second.some((event) => event.type === 'llm:done'), true);
    assert.deepEqual(server.counts(), { httpCalls: 2, webSocketCalls: 1 });
    assert.ok(secondTraces.some((trace) => trace.phase === 'http_cooldown'));
  } finally {
    await server.close();
  }
});

test('an exhausted 120s retry budget goes directly to HTTP instead of opening another WS', async () => {
  const server = await createFallbackServer();
  try {
    const traces = [];
    const events = await runFallbackRequest(
      server,
      'time-budget-fallback',
      'conversation-time-budget-fallback',
      traces,
      { attemptSeq: 2, maxAttempts: 5, requestCreatedAt: Date.now() - 120_001 }
    );
    assert.equal(events.some((event) => event.type === 'llm:error'), false);
    assert.equal(events.some((event) => event.type === 'llm:done'), true);
    assert.deepEqual(server.counts(), { httpCalls: 1, webSocketCalls: 0 });
    assert.ok(traces.some((trace) =>
      trace.phase === 'http_fallback' && trace.reason === 'ws_retry_time_budget_exhausted'
    ));
  } finally {
    await server.close();
  }
});

test('response.created before EOF remains replay-safe and falls back after retry exhaustion', async () => {
  const server = await createFallbackServer({ sendCreatedBeforeClose: true });
  try {
    const traces = [];
    const events = await runFallbackRequest(
      server,
      'no-fallback-after-event',
      'conversation-no-fallback-after-event',
      traces
    );
    assert.equal(events.some((event) => event.type === 'llm:error'), false);
    assert.equal(events.some((event) => event.type === 'llm:done'), true);
    assert.deepEqual(server.counts(), { httpCalls: 1, webSocketCalls: 1 });
    assert.equal(traces.some((trace) => trace.phase === 'http_fallback'), true);
  } finally {
    await server.close();
  }
});

test('a WS failure after semantic output never falls back or replays', async () => {
  const server = await createFallbackServer({
    sendCreatedBeforeClose: true,
    sendSemanticBeforeClose: true
  });
  try {
    const traces = [];
    const events = await runFallbackRequest(
      server,
      'no-fallback-after-semantic-output',
      'conversation-no-fallback-after-semantic-output',
      traces
    );
    assert.equal(events.some((event) => event.type === 'llm:error'), true);
    assert.equal(events.some((event) => event.type === 'llm:done'), false);
    assert.deepEqual(server.counts(), { httpCalls: 0, webSocketCalls: 1 });
    assert.equal(traces.some((trace) => trace.phase === 'http_fallback'), false);
  } finally {
    await server.close();
  }
});

test('signature-only reasoning before EOF is semantic and never falls back or replays', async () => {
  const server = await createFallbackServer({
    sendCreatedBeforeClose: true,
    sendSignatureOnlyReasoningBeforeClose: true
  });
  try {
    const traces = [];
    const events = await runFallbackRequest(
      server,
      'no-fallback-after-signature-only-reasoning',
      'conversation-no-fallback-after-signature-only-reasoning',
      traces
    );
    assert.equal(events.some((event) => event.type === 'llm:thoughtDone'), true);
    assert.equal(events.some((event) => event.type === 'llm:error'), true);
    assert.equal(events.some((event) => event.type === 'llm:done'), false);
    assert.deepEqual(server.counts(), { httpCalls: 0, webSocketCalls: 1 });
    assert.equal(traces.some((trace) => trace.phase === 'http_fallback'), false);
    const error = events.find((event) => event.type === 'llm:error');
    assert.equal(error?.payload?.rawError?.receivedServerEvent, true);
    assert.equal(error?.payload?.rawError?.receivedSemanticOutput, true);
  } finally {
    await server.close();
  }
});

test('reliable Attempt 2 forces a fresh physical WS and full request', async () => {
  const server = await createFallbackServer({ completeWebSocket: true });
  try {
    const conversationId = 'conversation-force-fresh-retry';
    await runFallbackRequest(
      server,
      'force-fresh-retry',
      conversationId,
      [],
      { attemptSeq: 1, maxAttempts: 5 }
    );
    const retryTraces = [];
    await runFallbackRequest(
      server,
      'force-fresh-retry',
      conversationId,
      retryTraces,
      { attemptSeq: 2, maxAttempts: 5 }
    );

    assert.deepEqual(server.counts(), { httpCalls: 0, webSocketCalls: 2 });
    const requests = server.webSocketRequests();
    assert.deepEqual(requests.map((entry) => entry.connection), [1, 2]);
    assert.equal('previous_response_id' in requests[1].request, false);
    assert.ok(retryTraces.some((trace) =>
      trace.phase === 'continuation_decision'
      && trace.connectionReason === 'retry_forced_reconnect'
      && trace.connectionReused === false
      && trace.mode === 'full'
    ));
    const requestSent = retryTraces.find((trace) => trace.phase === 'request_sent');
    assert.ok(requestSent);
    assert.equal(requestSent.responseCreateSeq, 1);
    assert.equal(requestSent.responseCreateFrameBytes, Buffer.byteLength(requests[1].payloadText, 'utf8'));
  } finally {
    await server.close();
  }
});

test('abort and event-idle timeout never leak a reasoning signature into the next continuation ledger', async () => {
  for (const fixture of [
    { name: 'abort', abort: true },
    { name: 'event-idle-timeout', abort: false }
  ]) {
    resetOpenAIResponsesWebSocketSessions();
    const requests = [];
    let connectionCount = 0;
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false });
    await new Promise((resolve) => server.once('listening', resolve));
    server.on('connection', (socket) => {
      const connection = connectionCount++;
      socket.on('message', (raw) => {
        const request = JSON.parse(raw.toString());
        const ordinal = requests.length;
        requests.push({ connection, request });
        if (ordinal === 0) {
          socket.send(JSON.stringify({
            type: 'response.created', response: { id: `resp_stale_${fixture.name}` }
          }));
          socket.send(JSON.stringify({
            type: 'response.output_item.done',
            response_id: `resp_stale_${fixture.name}`,
            output_index: 0,
            item: {
              id: `reasoning_stale_${fixture.name}`,
              type: 'reasoning',
              summary: [],
              encrypted_content: `opaque_stale_${fixture.name}`
            }
          }));
          return;
        }
        if (ordinal === 1) {
          const responseId = `resp_fresh_${fixture.name}`;
          const reasoning = {
            id: `reasoning_fresh_${fixture.name}`,
            type: 'reasoning',
            summary: [],
            encrypted_content: `opaque_fresh_${fixture.name}`
          };
          socket.send(JSON.stringify({ type: 'response.created', response: { id: responseId } }));
          socket.send(JSON.stringify({
            type: 'response.output_item.done', response_id: responseId, output_index: 0, item: reasoning
          }));
          socket.send(JSON.stringify({
            type: 'response.completed',
            response: {
              id: responseId,
              status: 'completed',
              output: [{ ...reasoning, encrypted_content: `completed_signature_${fixture.name}` }]
            }
          }));
          return;
        }
        socket.send(JSON.stringify({
          type: 'response.created', response: { id: `resp_suffix_${fixture.name}` }
        }));
        socket.send(JSON.stringify({
          type: 'response.completed',
          response: { id: `resp_suffix_${fixture.name}`, status: 'completed', output: [] }
        }));
      });
    });

    const address = server.address();
    const format = await responsesFormat();
    const sessionKey = `reasoning-ledger-${fixture.name}`;
    const common = {
      sessionKey,
      url: `http://127.0.0.1:${address.port}/v1/responses`,
      headers: { Authorization: 'Bearer test' },
      format,
      timeouts: {
        handshakeMs: 100,
        sendMs: 100,
        firstEventMs: 100,
        eventIdleMs: 30,
        responseMs: 500
      }
    };
    try {
      const controller = new AbortController();
      const interrupted = streamOpenAIResponsesWebSocketSession({
        ...common,
        body: responseRequestBody(format, [userContent('stale attempt')]),
        signal: controller.signal
      });
      const signatureChunk = await interrupted.next();
      assert.equal(signatureChunk.done, false);
      assert.match(JSON.stringify(signatureChunk.value), new RegExp(`opaque_stale_${fixture.name}`));
      if (fixture.abort) controller.abort(new Error(`fixture-${fixture.name}`));
      await assert.rejects(
        async () => {
          while (!(await interrupted.next()).done) { /* drain */ }
        },
        fixture.abort
          ? new RegExp(`fixture-${fixture.name}`)
          : (error) => error?.code === 'LLM_TRANSPORT_TIMEOUT' && error?.phase === 'event_idle'
      );

      const freshSignature = `opaque_fresh_${fixture.name}`;
      await collectWebSocketStream({
        ...common,
        body: responseRequestBody(format, [userContent('fresh attempt')])
      });
      await collectWebSocketStream({
        ...common,
        body: responseRequestBody(format, [
          userContent('fresh attempt'),
          {
            role: 'model',
            parts: [{
              thought: true,
              thoughtSignatures: { 'openai-responses': freshSignature }
            }]
          },
          userContent('suffix')
        ])
      });

      assert.equal(requests.length, 3);
      assert.deepEqual(requests.map((entry) => entry.connection), [0, 1, 1]);
      assert.equal(requests[2].request.previous_response_id, `resp_fresh_${fixture.name}`);
      assert.equal(requests[2].request.input.length, 1);
      assert.match(JSON.stringify(requests[2].request.input), /suffix/);
      assert.doesNotMatch(JSON.stringify(requests[2].request), new RegExp(`opaque_stale_${fixture.name}`));
    } finally {
      resetOpenAIResponsesWebSocketSessions();
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test('heartbeat invalidates an OPEN socket that stops answering pong', async () => {
  resetOpenAIResponsesWebSocketSessions();
  let connectionCount = 0;
  const server = new WebSocketServer({
    host: '127.0.0.1',
    port: 0,
    perMessageDeflate: false,
    autoPong: false
  });
  await new Promise((resolve) => server.once('listening', resolve));
  server.on('connection', (socket) => {
    connectionCount += 1;
    socket.on('message', () => {
      const responseId = `resp_heartbeat_${connectionCount}`;
      socket.send(JSON.stringify({ type: 'response.created', response: { id: responseId } }));
      socket.send(JSON.stringify({
        type: 'response.completed',
        response: { id: responseId, status: 'completed', output: [] }
      }));
    });
  });
  const address = server.address();
  const options = {
    sessionKey: 'tracked-heartbeat-policy',
    url: `http://127.0.0.1:${address.port}/v1/responses`,
    headers: { Authorization: 'Bearer test' },
    body: { model: 'gpt-test', input: [{ role: 'user', content: 'hello' }] },
    format: {
      createStreamState: () => ({}),
      decodeStreamChunk: () => ({}),
      decodeResponse: () => ({ content: { role: 'model', parts: [] } }),
      encodeRequest: () => ({ input: [] })
    },
    timeouts: {
      handshakeMs: 100,
      sendMs: 100,
      firstEventMs: 100,
      eventIdleMs: 100,
      responseMs: 500,
      heartbeatIntervalMs: 10,
      pongTimeoutMs: 30,
      preSendProbeStaleMs: 20,
      preSendProbeTimeoutMs: 20
    }
  };
  try {
    for await (const _chunk of streamOpenAIResponsesWebSocketSession(options)) { /* drain */ }
    await new Promise((resolve) => setTimeout(resolve, 55));
    for await (const _chunk of streamOpenAIResponsesWebSocketSession(options)) { /* drain */ }
    assert.equal(connectionCount, 2);
  } finally {
    resetOpenAIResponsesWebSocketSessions();
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
});
