const test = require('node:test');

const assert = require('node:assert/strict');

const Module = require('node:module');

const http = require('node:http');

const { WebSocketServer } = require('ws');

const originalLoad = Module._load;

Module._load = function patched(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      Uri: { joinPath: (...parts) => ({ fsPath: parts.map((part) => part?.fsPath ?? String(part)).join('/') }) },
      workspace: { fs: {} }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { normalizeLlmProviderConfig } = require('../../dist/extension/backend/capabilities/vscodeStorage/llmProviderConfigs.js');

Module._load = originalLoad;

const {
  createLlmProviderCapability,
  createOpenAIResponsesWebSocketSessionKey,
  dryRunCompactLlmProvider,
  dryRunLlmProvider,
  startLlmProvider
} = require('../../dist/extension/backend/capabilities/llmProvider.js');

const { LlmEventType } = require('../../dist/extension/backend/world/modules/llm/events.js');

function providerConfig(overrides = {}) {
  return {
    id: 'provider-openai-responses',
    name: 'OpenAI Responses',
    provider: 'openai-responses',
    baseUrl: 'https://example.test/v1',
    model: 'gpt-test',
    models: [{ id: 'gpt-test', name: 'GPT Test' }],
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

function chatRequest(id = 'request-websocket') {
  return {
    id,
    invocationId: `invocation-${id}`,
    conversationId: 'conversation-websocket',
    contents: [{ role: 'user', parts: [{ text: 'Hello over WebSocket' }] }],
    tools: []
  };
}

async function createTransportFallbackServer({
  sendCreatedBeforeClose = false,
  sendSemanticBeforeClose = false
} = {}) {
  let httpCalls = 0;
  let webSocketCalls = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.once('end', () => {
      httpCalls += 1;
      const responseId = `resp_http_${httpCalls}`;
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
      });
      const events = [
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
      ];
      for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end('data: [DONE]\n\n');
    });
  });
  const webSocketServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketCalls += 1;
      webSocket.once('message', () => {
        if (sendCreatedBeforeClose) {
          webSocket.send(JSON.stringify({
            type: 'response.created',
            response: { id: `resp_ws_${webSocketCalls}` }
          }), () => {
            if (!sendSemanticBeforeClose) {
              webSocket.terminate();
              return;
            }
            webSocket.send(JSON.stringify({
              type: 'response.output_text.delta',
              response_id: `resp_ws_${webSocketCalls}`,
              item_id: `msg_ws_${webSocketCalls}`,
              output_index: 0,
              content_index: 0,
              delta: 'partial semantic output'
            }), () => webSocket.terminate());
          });
        } else webSocket.terminate();
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    counts: () => ({ httpCalls, webSocketCalls }),
    async close() {
      for (const client of webSocketServer.clients) client.terminate();
      await new Promise((resolve) => webSocketServer.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

async function runTransportFallbackRequest(
  server,
  id,
  traces,
  conversationId = 'conversation-http-fallback'
) {
  const events = [];
  await startLlmProvider({
    ...chatRequest(id),
    conversationId,
    reliableProviderAttempt: {
      attemptSeq: 5,
      maxAttempts: 5,
      requestCreatedAt: Date.now()
    }
  }, (event) => events.push(event), {
    settings: async () => providerConfig({
      baseUrl: server.baseUrl,
      openaiResponsesTransport: 'websocket',
      retryOnError: false,
      retryMaxAttempts: 0
    }),
    onTransportTrace: (trace) => traces.push(trace)
  });
  return events;
}

function registerCases(test) {

test('final recoverable WS failure falls back to HTTP once and applies a short conversation cooldown', async () => {
  const server = await createTransportFallbackServer();
  try {
    const firstTraces = [];
    const firstEvents = await runTransportFallbackRequest(server, 'request-http-rescue-1', firstTraces);
    assert.equal(firstEvents.some((event) => event.type === LlmEventType.Error), false);
    assert.equal(firstEvents.some((event) => event.type === LlmEventType.Done), true);
    assert.deepEqual(server.counts(), { httpCalls: 1, webSocketCalls: 1 });
    assert.ok(firstTraces.some((trace) => trace.phase === 'http_fallback'));

    const secondTraces = [];
    const secondEvents = await runTransportFallbackRequest(server, 'request-http-rescue-2', secondTraces);
    assert.equal(secondEvents.some((event) => event.type === LlmEventType.Error), false);
    assert.equal(secondEvents.some((event) => event.type === LlmEventType.Done), true);
    assert.deepEqual(server.counts(), { httpCalls: 2, webSocketCalls: 1 });
    assert.ok(secondTraces.some((trace) => trace.phase === 'http_cooldown'));
  } finally {
    await server.close();
  }
});
test('WS failure after semantic output never falls back to HTTP or replays the request', async () => {
  const server = await createTransportFallbackServer({
    sendCreatedBeforeClose: true,
    sendSemanticBeforeClose: true
  });
  try {
    const traces = [];
    const events = await runTransportFallbackRequest(
      server,
      'request-no-rescue-after-semantic-output',
      traces,
      'conversation-no-rescue-after-semantic-output'
    );
    assert.equal(events.some((event) => event.type === LlmEventType.Error), true);
    assert.equal(events.some((event) => event.type === LlmEventType.Done), false);
    assert.deepEqual(server.counts(), { httpCalls: 0, webSocketCalls: 1 });
    assert.equal(traces.some((trace) => trace.phase === 'http_fallback'), false);
  } finally {
    await server.close();
  }
});
}

module.exports = { registerCases };
