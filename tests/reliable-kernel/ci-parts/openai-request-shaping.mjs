import assert from 'node:assert/strict';

import http from 'node:http';

import test from 'node:test';

import { WebSocketServer } from 'ws';

import {
  createLlmProviderCapability,
  dryRunCompactLlmProvider,
  dryRunLlmProvider,
  probeLlmProviderNativeCompaction,
  startLlmProvider
} from '../../../dist/extension/backend/capabilities/llmProvider.js';

import { resetOpenAIResponsesWebSocketSessions } from '../../../dist/extension/backend/capabilities/openAIResponsesWebSocketSession.js';

function responsesSettings(baseUrl, overrides = {}) {
  return {
    id: 'shaping-provider', name: 'Shaping', provider: 'openai-responses', baseUrl, model: 'gpt-5.5', models: [],
    apiKey: 'dummy-test-key', toolCallFormat: 'function-call', openaiResponsesTransport: 'http', stream: true,
    retryOnError: false, retryMaxAttempts: 0, retryDelaySeconds: 0, enableMultimodalTools: true, systemPromptPrefix: '',
    promptCache: { enabled: true, mode: 'key', ttl: '30m' }, modelConfigs: [], createdAt: 1, updatedAt: 1,
    ...overrides
  };
}

function nativeCompactRequest(id = 'compact-request') {
  return {
    id, blockId: `${id}-block`, conversationId: 'shaping-conversation', methodKind: 'provider_native',
    methodConfigSnapshot: { id: 'native', name: 'Native', kind: 'provider_native', trigger: { mode: 'manual' }, llmSummary: { targetTokens: 1000 }, createdAt: 1, updatedAt: 1 },
    contents: [
      { role: 'user', parts: [{ text: 'Remember MARKER=42.' }] },
      { role: 'model', parts: [{ text: 'MARKER=42.' }] }
    ],
    tools: []
  };
}

async function withCompactWebSocket(reply, run) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const frames = [];
  server.on('connection', (socket, request) => {
    assert.equal(request.url, '/v1/responses');
    socket.on('message', (bytes) => {
      const frame = JSON.parse(bytes.toString('utf8'));
      frames.push(frame);
      reply(socket, frame);
    });
  });
  try {
    return await run(`http://127.0.0.1:${server.address().port}/v1`, frames);
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  }
}

function completeNativeCompact(socket, output) {
  socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp-native-compact' } }));
  for (const [index, item] of output.entries()) {
    socket.send(JSON.stringify({ type: 'response.output_item.done', output_index: index, item }));
  }
  socket.send(JSON.stringify({ type: 'response.completed', response: {
    id: 'resp-native-compact', object: 'response', status: 'completed', output,
    usage: { input_tokens: 20, output_tokens: 4, total_tokens: 24 }
  } }));
}

function registerCases(test) {

test('GPT-6 WebSocket native Compact uses a final trigger and replays the encrypted item', async () => {
  const item = { id: 'cmp-ws-1', type: 'compaction', encrypted_content: 'opaque-ws-context' };
  await withCompactWebSocket((socket, frame) => {
    if (frame.input.at(-1).type === 'compaction_trigger') {
      completeNativeCompact(socket, [item]);
      return;
    }
    assert.deepEqual(frame.input[0], item);
    const answer = { id: 'msg-replay', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'MARKER=42' }] };
    socket.send(JSON.stringify({ type: 'response.created', response: { id: 'resp-replay' } }));
    socket.send(JSON.stringify({ type: 'response.output_text.delta', response_id: 'resp-replay',
      item_id: answer.id, output_index: 0, content_index: 0, delta: 'MARKER=42' }));
    socket.send(JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: answer }));
    socket.send(JSON.stringify({ type: 'response.completed', response: {
      id: 'resp-replay', status: 'completed', output: [answer]
    } }));
  }, async (baseUrl, frames) => {
    const settings = responsesSettings(baseUrl, {
      model: 'gpt-6-sol', openaiResponsesTransport: 'websocket',
      nativeResponses: { enabled: true, multiplexing: false },
      promptCache: { enabled: false, mode: 'key', ttl: '30m' }
    });
    const request = nativeCompactRequest('ws-native-compact');
    const options = { settings: async () => settings, compressionSettings: async () => undefined };
    const dry = await dryRunCompactLlmProvider(request, options);
    assert.equal(dry.calls[0].url, baseUrl.replace(/^http:/, 'ws:') + '/responses');
    assert.equal(dry.calls[0].body.input.at(-1).type, 'compaction_trigger');
    assert.equal(dry.calls[0].body.store, false);
    assert.deepEqual(dry.calls[0].body.tools, []);
    assert.doesNotMatch(dry.calls[0].maskedCurl, /dummy-test-key/);

    let compactedContents;
    const capability = createLlmProviderCapability(options);
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket compact timed out')), 10_000);
        capability.compact(request, (event) => {
          if (event.type !== 'llm:compactDone' && event.type !== 'llm:compactError') return;
          clearTimeout(timer);
          resolve(event);
        });
      });
      assert.equal(result.type, 'llm:compactDone', JSON.stringify(result.payload));
      const contents = result.payload.result.contents;
      compactedContents = contents;
      assert.deepEqual(contents[0].parts[0].providerContext.rawItem, item);
      assert.equal(frames.length, 1);
      assert.equal(frames[0].type, 'response.create');
      assert.equal(frames[0].input.at(-1).type, 'compaction_trigger');
      assert.equal(frames[0].input.length, 3);
      assert.equal(frames[0].previous_response_id, undefined);
      assert.equal(frames[0].stream_id, undefined);

      const replay = await dryRunLlmProvider({
        id: 'ws-compact-replay', conversationId: 'shaping-conversation',
        contents: [...contents, { role: 'user', parts: [{ text: 'Continue.' }] }], tools: []
      }, options);
      assert.match(JSON.stringify(replay.body.input), /opaque-ws-context/);
    } finally {
      capability.dispose();
    }

    const probe = await probeLlmProviderNativeCompaction(settings, options);
    assert.equal(probe.capabilitySnapshot.nativeCompaction.availability, 'verified');
    assert.equal(frames.length, 2);

    const events = [];
    try {
      await startLlmProvider({ id: 'ws-replay-live', conversationId: 'shaping-conversation',
        contents: [...compactedContents, { role: 'user', parts: [{ text: 'Recall the marker.' }] }], tools: []
      }, (event) => events.push(event), options, AbortSignal.timeout(10_000));
      assert.equal(events.some((event) => event.type === 'llm:done'), true);
      assert.match(events.filter((event) => event.type === 'llm:delta').map((event) => event.payload.text).join(''), /MARKER=42/);
      assert.equal(frames.length, 3);
    } finally {
      resetOpenAIResponsesWebSocketSessions();
    }
  });
});
test('GPT-6 WebSocket native Compact rejects a completed response without encrypted state', async () => {
  await withCompactWebSocket((socket) => completeNativeCompact(socket, [
    { id: 'msg-1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'No compact state.' }] }
  ]), async (baseUrl) => {
    const settings = responsesSettings(baseUrl, {
      model: 'gpt-6-sol', openaiResponsesTransport: 'websocket',
      nativeResponses: { enabled: true, multiplexing: false }
    });
    const options = { settings: async () => settings, compressionSettings: async () => undefined };
    const capability = createLlmProviderCapability(options);
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket compact timed out')), 10_000);
        capability.compact(nativeCompactRequest('ws-native-empty'), (event) => {
          if (event.type !== 'llm:compactDone' && event.type !== 'llm:compactError') return;
          clearTimeout(timer);
          resolve(event);
        });
      });
      assert.equal(result.type, 'llm:compactError');
      assert.match(JSON.stringify(result.payload), /no encrypted compaction item/);
    } finally {
      capability.dispose();
    }
    const probe = await probeLlmProviderNativeCompaction(settings, options);
    assert.equal(probe.capabilitySnapshot.nativeCompaction.availability, 'unsupported');
  });
});
}

export { registerCases };
