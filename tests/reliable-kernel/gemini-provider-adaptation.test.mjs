import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const root = process.cwd();
const require = createRequire(import.meta.url);
const {
  installGeminiOpenAICompatibleThoughtSignatures
} = require(path.join(root, 'dist/extension/backend/capabilities/geminiProviderAdaptation.js'));
const {
  startLlmProvider
} = require(path.join(root, 'dist/extension/backend/capabilities/llmProvider.js'));
const { LlmEventType } = require(path.join(root, 'dist/extension/backend/world/modules/llm/events.js'));
const unified = await import('unified-llm-provider');

// Thought signature rules: https://ai.google.dev/gemini-api/docs/thought-signatures
// (moved to https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures).
const DUMMY_SIGNATURE = 'skip_thought_signature_validator';

function providerConfig(overrides = {}) {
  return {
    id: 'provider-gemini-adaptation',
    name: 'Gemini adaptation',
    provider: 'openai-compatible',
    baseUrl: 'https://example.invalid/v1',
    model: '[v]gemini-3.5-flash',
    models: [],
    apiKey: 'offline-placeholder',
    toolCallFormat: 'function-call',
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

function openAICompatibleGemini(modelId) {
  return installGeminiOpenAICompatibleThoughtSignatures({
    format: new unified.OpenAICompatibleFormat(modelId)
  }, 'openai-compatible', modelId);
}

function sse(chunks) {
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' }
  });
}

function delta(delta, finishReason = null) {
  return { choices: [{ index: 0, delta, finish_reason: finishReason }] };
}

/**
 * Shape recorded from the gateway for `[v]gemini-3.5-flash` (two parallel calls): the id and the
 * signature arrive with empty arguments, the arguments follow in later deltas, and only the first
 * parallel call carries a signature.
 */
function recordedParallelStream({ withIds = true } = {}) {
  const call = (index, id, extra) => ({
    index,
    ...(withIds ? { id } : {}),
    type: 'function',
    function: { name: 'get_weather', arguments: '' },
    ...(extra ? { extra_content: extra } : {})
  });
  return [
    delta({ role: 'assistant', content: '', reasoning_content: 'Planning two weather calls.' }),
    delta({ tool_calls: [call(0, 'call_paris', { google: { thoughtSignature: 'SIG_FIRST' } })] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"city":"Paris"}' } }] }),
    delta({ tool_calls: [call(1, 'call_tokyo')] }),
    delta({ tool_calls: [{ index: 1, function: { arguments: '{"city":"Tokyo"}' } }] }),
    delta({}, 'stop')
  ];
}

async function streamedToolCalls(context, chunks, model = '[v]gemini-3.5-flash') {
  context.mock.method(globalThis, 'fetch', async () => sse(chunks));
  const events = [];
  await startLlmProvider({
    id: `request-${model}`,
    invocationId: `invocation-${model}`,
    conversationId: 'conversation-gemini-adaptation',
    contents: [{ role: 'user', parts: [{ text: 'Weather in Paris and Tokyo, in parallel.' }] }],
    tools: [{
      name: 'get_weather',
      description: 'Get weather for a city',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
    }]
  }, (event) => events.push(event), { settings: async () => providerConfig({ model }) });
  assert.equal(events.some((event) => event.type === LlmEventType.Error), false);
  const calls = new Map();
  for (const event of events) {
    if (event.type !== LlmEventType.ToolCall) continue;
    for (const call of event.payload.calls) calls.set(call.id, { ...calls.get(call.id), ...call });
  }
  return [...calls.values()];
}

test('E0 streamed parallel Gemini calls keep the signature on the first call only (thought-signatures: parallel calls)', async (context) => {
  const calls = await streamedToolCalls(context, recordedParallelStream());
  assert.deepEqual(calls.map((call) => [call.id, JSON.parse(call.argsJson).city, call.thoughtSignature]), [
    ['call_paris', 'Paris', 'gemini:SIG_FIRST'],
    ['call_tokyo', 'Tokyo', undefined]
  ]);
});

test('E0 streamed calls without ids are matched by their position in the message, not the per-chunk ordinal', async () => {
  const provider = openAICompatibleGemini('[v]gemini-3.5-flash');
  const state = provider.format.createStreamState();
  const decodedCalls = recordedParallelStream({ withIds: false })
    .map((chunk) => provider.format.decodeStreamChunk(chunk, state))
    .flatMap((chunk) => chunk.functionCalls ?? []);
  assert.deepEqual(decodedCalls.map((part) => [part.functionCall.args.city, part.thoughtSignatures?.gemini]), [
    ['Paris', 'SIG_FIRST'],
    ['Tokyo', undefined]
  ]);
});

test('E0 a signature that arrives after the id, keyed only by index, still lands on that call', () => {
  const provider = openAICompatibleGemini('[v]gemini-3.5-flash');
  const state = provider.format.createStreamState();
  const chunks = [
    delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'list_items', arguments: '' } }] }),
    delta({ tool_calls: [{ index: 0, extra_content: { google: { thought_signature: 'SIG_LATE' } } }] }),
    delta({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'list_items', arguments: '{}' } }] }),
    delta({}, 'tool_calls')
  ];
  const decodedCalls = chunks
    .map((chunk) => provider.format.decodeStreamChunk(chunk, state))
    .flatMap((chunk) => chunk.functionCalls ?? []);
  assert.deepEqual(decodedCalls.map((part) => [part.functionCall.callId, part.thoughtSignatures?.gemini]), [
    ['call_a', 'SIG_LATE'],
    ['call_b', undefined]
  ]);
});

test('E0 non-streamed parallel response keeps the signature on the first call only', () => {
  const provider = openAICompatibleGemini('[v]gemini-3.5-flash');
  const decoded = provider.format.decodeResponse({
    choices: [{
      message: {
        content: null,
        tool_calls: [
          {
            id: 'call_paris',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            extra_content: { google: { thought_signature: 'SIG_FIRST' } }
          },
          { id: 'call_tokyo', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }
        ]
      },
      finish_reason: 'tool_calls'
    }]
  });
  assert.deepEqual(decoded.content.parts.map((part) => part.thoughtSignatures?.gemini), ['SIG_FIRST', undefined]);
});

test('E0 signatures are kept for any OpenAI-compatible model whose response carries extra_content', async (context) => {
  const calls = await streamedToolCalls(context, recordedParallelStream(), 'relay/flash-latest');
  assert.deepEqual(calls.map((call) => call.thoughtSignature), ['gemini:SIG_FIRST', undefined]);

  const provider = openAICompatibleGemini('relay/flash-latest');
  const encoded = provider.format.encodeRequest({
    contents: [{
      role: 'model',
      parts: [
        { functionCall: { name: 'get_weather', args: { city: 'Paris' }, callId: 'call_paris' }, thoughtSignature: 'gemini:SIG_FIRST' },
        { functionCall: { name: 'get_weather', args: { city: 'Tokyo' }, callId: 'call_tokyo' } }
      ]
    }]
  }, false);
  assert.deepEqual(encoded.messages[0].tool_calls.map((call) => call.extra_content), [
    { google: { thought_signature: 'SIG_FIRST', thoughtSignature: 'SIG_FIRST' } },
    undefined
  ]);
});

test('E0 dummy signatures for unsigned history are only added for Gemini models that validate them', () => {
  const unsignedHistory = {
    contents: [
      { role: 'user', parts: [{ text: 'weather?' }] },
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'get_weather', args: { city: 'Paris' }, callId: 'call_paris' } },
          { functionCall: { name: 'get_weather', args: { city: 'Tokyo' }, callId: 'call_tokyo' } }
        ]
      }
    ]
  };
  for (const model of ['[v]gemini-3.5-flash', 'firebase/gemini-3.7-flash', 'gemini-4-pro', 'gemini-flash-latest']) {
    const encoded = openAICompatibleGemini(model).format.encodeRequest(structuredClone(unsignedHistory), false);
    assert.deepEqual(
      encoded.messages[1].tool_calls.map((call) => call.extra_content?.google?.thought_signature),
      [DUMMY_SIGNATURE, DUMMY_SIGNATURE],
      model
    );
  }
  // Gemini 2.5 does not validate function-call signatures, so its requests stay as they were.
  for (const model of ['gpt-5.5', 'claude-sonnet-5', 'gemini-3-relay/gpt-6-astra', 'relay/flash-latest', 'models/gemini-2.5-pro']) {
    const wrapped = openAICompatibleGemini(model).format.encodeRequest(structuredClone(unsignedHistory), false);
    const plain = new unified.OpenAICompatibleFormat(model).encodeRequest(structuredClone(unsignedHistory), false);
    assert.equal(JSON.stringify(wrapped), JSON.stringify(plain), model);
  }
});

test('E0 responses without extra_content decode exactly as before', () => {
  const raw = {
    choices: [{
      message: {
        content: 'done',
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'read', arguments: '{"path":"a"}' } }]
      },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
  };
  const wrapped = openAICompatibleGemini('gpt-5.5').format.decodeResponse(structuredClone(raw));
  const plain = new unified.OpenAICompatibleFormat('gpt-5.5').decodeResponse(structuredClone(raw));
  assert.deepEqual(wrapped, plain);

  const chunks = [
    delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'read', arguments: '' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] }),
    delta({}, 'tool_calls')
  ];
  const wrappedFormat = openAICompatibleGemini('gpt-5.5').format;
  const plainFormat = new unified.OpenAICompatibleFormat('gpt-5.5');
  const wrappedState = wrappedFormat.createStreamState();
  const plainState = plainFormat.createStreamState();
  for (const chunk of chunks) {
    assert.deepEqual(
      wrappedFormat.decodeStreamChunk(structuredClone(chunk), wrappedState),
      plainFormat.decodeStreamChunk(structuredClone(chunk), plainState)
    );
  }
});

test('E0 another provider\'s signature on a call is never sent as a Gemini signature', () => {
  const encoded = openAICompatibleGemini('[v]gemini-3.5-flash').format.encodeRequest({
    contents: [{
      role: 'model',
      parts: [{
        functionCall: { name: 'read', args: {}, callId: 'call_a' },
        thoughtSignature: 'openai-responses:gAAAA-encrypted',
        thoughtSignatures: { 'openai-responses': 'gAAAA-encrypted' }
      }]
    }]
  }, false);
  assert.equal(encoded.messages[0].tool_calls[0].extra_content.google.thought_signature, DUMMY_SIGNATURE);
});
