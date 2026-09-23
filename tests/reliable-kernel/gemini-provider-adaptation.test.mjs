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
  dryRunLlmProvider,
  startLlmProvider
} = require(path.join(root, 'dist/extension/backend/capabilities/llmProvider.js'));
const {
  toUnifiedRequest
} = require(path.join(root, 'dist/extension/backend/capabilities/unifiedMessageConversion.js'));
const {
  emitUnifiedChunk,
  emitUnifiedResponse,
  fromUnifiedCompletedContent
} = require(path.join(root, 'dist/extension/backend/capabilities/llmStreamEventProjection.js'));
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

test('E0 calls flushed by an end-of-stream finalizeStream hook get their signatures from the same tracker', () => {
  // The vendored package has no finalizeStream yet; this stands in for the one that flushes calls
  // still pending when a gateway ends the stream without finish_reason.
  const model = '[v]gemini-3.5-flash';
  const format = new unified.OpenAICompatibleFormat(model);
  format.finalizeStream = (state) => {
    const pending = [...state.pendingToolCalls.values()].filter((entry) => !entry.emitted && entry.name);
    for (const entry of pending) entry.emitted = true;
    const functionCalls = pending.map((entry) => ({ functionCall: { name: entry.name, args: {}, callId: entry.callId } }));
    return functionCalls.length > 0 ? { functionCalls, partsDelta: [...functionCalls] } : undefined;
  };
  const provider = installGeminiOpenAICompatibleThoughtSignatures({ format }, 'openai-compatible', model);
  const state = provider.format.createStreamState();
  const emitted = [
    delta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'list_items', arguments: '' }, extra_content: { google: { thoughtSignature: 'SIG_A' } } }] }),
    delta({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'list_items', arguments: '' } }] })
  ].flatMap((chunk) => provider.format.decodeStreamChunk(chunk, state).functionCalls ?? []);
  emitted.push(...(provider.format.finalizeStream(state)?.functionCalls ?? []));
  assert.deepEqual(emitted.map((part) => [part.functionCall.callId, part.thoughtSignatures?.gemini]), [
    ['call_a', 'SIG_A'],
    ['call_b', undefined]
  ]);

  const onlyAtFinalize = installGeminiOpenAICompatibleThoughtSignatures({
    format: Object.assign(new unified.OpenAICompatibleFormat(model), { finalizeStream: format.finalizeStream })
  }, 'openai-compatible', model);
  const finalizeState = onlyAtFinalize.format.createStreamState();
  onlyAtFinalize.format.decodeStreamChunk(delta({ tool_calls: [{ index: 0, id: 'call_only', type: 'function', function: { name: 'list_items', arguments: '' }, extra_content: { google: { thought_signature: 'SIG_ONLY' } } }] }), finalizeState);
  assert.equal(onlyAtFinalize.format.finalizeStream(finalizeState).functionCalls[0].thoughtSignatures.gemini, 'SIG_ONLY');
});

test('E0 no dummy is injected next to OpenRouter reasoning_details, which carry the Gemini signature', () => {
  const envelope = JSON.stringify({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'ENCRYPTED', id: 'r1', format: 'google-gemini-v1', index: 0 }] });
  const history = (thoughtPart) => ({
    contents: [
      { role: 'user', parts: [{ text: 'weather?' }] },
      {
        role: 'model',
        parts: [
          thoughtPart,
          { functionCall: { name: 'get_weather', args: { city: 'Paris' }, callId: 'call_paris' } }
        ]
      }
    ]
  });
  const model = 'google/gemini-3-pro-preview';
  for (const thoughtPart of [
    { text: '', thought: true, thoughtSignatures: { 'openai-compatible': envelope } },
    { text: '', thought: true, thoughtSignature: `openai-compatible:${envelope}` }
  ]) {
    const encoded = openAICompatibleGemini(model).format.encodeRequest(history(thoughtPart), false);
    assert.equal(encoded.messages[1].tool_calls[0].extra_content, undefined);
  }
  // A plain reasoning_signature string is not an OpenRouter envelope: the plain-gateway dummy stays.
  const plain = openAICompatibleGemini(model).format.encodeRequest(
    history({ text: 'thought', thought: true, thoughtSignatures: { 'openai-compatible': 'plain-signature' } }),
    false
  );
  assert.equal(plain.messages[1].tool_calls[0].extra_content.google.thought_signature, DUMMY_SIGNATURE);
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

function geminiConfig(overrides = {}) {
  return providerConfig({
    provider: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.7-flash',
    apiKey: '',
    ...overrides
  });
}

async function geminiWireContents(contents, overrides = {}) {
  const result = await dryRunLlmProvider({
    id: 'request-gemini-wire',
    invocationId: 'invocation-gemini-wire',
    conversationId: 'conversation-gemini-wire',
    contents,
    tools: []
  }, { settings: async () => geminiConfig(overrides) });
  return result.body.contents;
}

function wireShape(contents) {
  return contents.map((content) => `${content.role}:${content.parts.map((part) => {
    if (part.functionCall) return `FC(${part.functionCall.id})${part.thoughtSignature ? `+${part.thoughtSignature}` : ''}`;
    if (part.functionResponse) return `FR(${part.functionResponse.id})`;
    if (part.thought) return `THOUGHT(${part.text})${part.thoughtSignature ? `+${part.thoughtSignature}` : ''}`;
    return `TEXT(${part.text})`;
  }).join(',')}`);
}

const call = (id, signature) => ({
  id,
  functionCall: { name: 'render', args: { id } },
  ...(signature ? { thoughtSignature: `gemini:${signature}` } : {})
});
const response = (id) => ({ id, functionResponse: { name: 'render', response: { ok: id } } });
const userText = (text) => ({ role: 'user', parts: [{ text }] });
const CATALOG = '[LimCode 托管附件目录：仅包含不可变元数据，不包含附件正文。]';

test('E1 Gemini pairs parallel responses split by an attachment catalog into the next user content', async () => {
  const contents = await geminiWireContents([
    userText('render three'),
    { role: 'model', parts: [call('r1', 'SIG'), call('r2'), call('r3')] },
    { role: 'user', parts: [response('r1')] },
    userText(CATALOG),
    { role: 'user', parts: [response('r2')] },
    { role: 'user', parts: [response('r3')] }
  ]);
  assert.deepEqual(wireShape(contents), [
    'user:TEXT(render three)',
    'model:FC(r1)+SIG,FC(r2),FC(r3)',
    `user:FR(r1),FR(r2),FR(r3),TEXT(${CATALOG})`
  ]);
});

test('E1 Gemini moves text placed before the responses behind them and pairs consecutive batches separately', async () => {
  const contents = await geminiWireContents([
    userText('go'),
    { role: 'model', parts: [call('a', 'SIG_A'), call('b')] },
    userText(CATALOG),
    { role: 'user', parts: [response('b'), response('a')] },
    { role: 'model', parts: [call('c', 'SIG_C')] },
    { role: 'user', parts: [response('c')] },
    userText('next question')
  ]);
  assert.deepEqual(wireShape(contents), [
    'user:TEXT(go)',
    'model:FC(a)+SIG_A,FC(b)',
    `user:FR(b),FR(a),TEXT(${CATALOG})`,
    'model:FC(c)+SIG_C',
    'user:FR(c)',
    'user:TEXT(next question)'
  ]);
});

test('E1 Gemini leaves already paired turns and adjacent response merging as before', async () => {
  const history = [
    userText('go'),
    { role: 'model', parts: [call('a', 'SIG_A'), call('b')] },
    { role: 'user', parts: [response('a')] },
    { role: 'user', parts: [response('b')] },
    { role: 'model', parts: [call('c', 'SIG_C')] },
    { role: 'user', parts: [response('c'), { text: 'tool note' }] },
    userText('continue')
  ];
  const contents = await geminiWireContents(history);
  assert.deepEqual(wireShape(contents), [
    'user:TEXT(go)',
    'model:FC(a)+SIG_A,FC(b)',
    'user:FR(a),FR(b)',
    'model:FC(c)+SIG_C',
    'user:FR(c),TEXT(tool note)',
    'user:TEXT(continue)'
  ]);
});

test('E1 pairing only applies to Gemini: other providers keep their own history shape', () => {
  const history = [
    userText('go'),
    { role: 'model', parts: [call('a'), call('b')] },
    { role: 'user', parts: [response('a')] },
    userText(CATALOG),
    { role: 'user', parts: [response('b')] }
  ];
  for (const providerKind of ['openai-compatible', 'openai-responses', 'deepseek']) {
    const request = toUnifiedRequest({ id: 'r', conversationId: 'c', contents: history, tools: [] }, undefined, providerKind);
    assert.deepEqual(request.contents.map((content) => content.parts.length), [1, 2, 1, 1, 1], providerKind);
  }
});

test('E2 unsigned calls in the current Gemini turn get the dummy on the first call of each step', async () => {
  const contents = await geminiWireContents([
    userText('earlier question'),
    { role: 'model', parts: [call('old')] },
    { role: 'user', parts: [response('old')] },
    userText('current question'),
    { role: 'model', parts: [{ text: 'thinking', thought: true }, call('a'), call('b')] },
    { role: 'user', parts: [response('a'), response('b')] },
    { role: 'model', parts: [call('c')] },
    { role: 'user', parts: [response('c')] }
  ]);
  assert.deepEqual(wireShape(contents), [
    'user:TEXT(earlier question)',
    'model:FC(old)',
    'user:FR(old)',
    'user:TEXT(current question)',
    `model:THOUGHT(thinking),FC(a)+${DUMMY_SIGNATURE},FC(b)`,
    'user:FR(a),FR(b)',
    `model:FC(c)+${DUMMY_SIGNATURE}`,
    'user:FR(c)'
  ]);
});

test('E2 existing signatures stay untouched and signed turns are sent unchanged', async () => {
  const history = [
    userText('go'),
    { role: 'model', parts: [call('a', 'SIG_A'), call('b')] },
    { role: 'user', parts: [response('a'), response('b')] },
    { role: 'model', parts: [call('c', 'SIG_C')] },
    { role: 'user', parts: [response('c')] }
  ];
  assert.deepEqual(wireShape(await geminiWireContents(history)), [
    'user:TEXT(go)',
    'model:FC(a)+SIG_A,FC(b)',
    'user:FR(a),FR(b)',
    'model:FC(c)+SIG_C',
    'user:FR(c)'
  ]);
});

test('E2 a response content that also carries text does not end the current turn', async () => {
  const contents = await geminiWireContents([
    userText('go'),
    { role: 'model', parts: [call('a')] },
    { role: 'user', parts: [response('a')] },
    userText(CATALOG),
    { role: 'model', parts: [call('b')] },
    { role: 'user', parts: [response('b'), { text: 'note' }] },
    { role: 'model', parts: [call('c')] },
    { role: 'user', parts: [response('c')] }
  ]);
  // The catalog user content starts the turn; the mixed response content does not.
  assert.deepEqual(wireShape(contents).slice(4), [
    `model:FC(b)+${DUMMY_SIGNATURE}`,
    'user:FR(b),TEXT(note)',
    `model:FC(c)+${DUMMY_SIGNATURE}`,
    'user:FR(c)'
  ]);
  assert.equal(wireShape(contents)[1], 'model:FC(a)');
});

test('E2 Gemini 2.5 (signatures optional) keeps its unsigned history as before', async () => {
  const contents = await geminiWireContents([
    userText('go'),
    { role: 'model', parts: [call('a')] },
    { role: 'user', parts: [response('a')] }
  ], { model: 'gemini-2.5-flash' });
  assert.deepEqual(wireShape(contents), ['user:TEXT(go)', 'model:FC(a)', 'user:FR(a)']);
});

test('E3 Gemini drops thoughts signed by other providers and keeps its own and unsigned ones', async () => {
  const contents = await geminiWireContents([
    userText('go'),
    {
      role: 'model',
      parts: [
        { text: 'claude thought', thought: true, thoughtSignature: 'claude:ErUB-claude' },
        { text: 'responses thought', thought: true, thoughtSignature: 'openai-responses:gAAAA' },
        { text: 'gemini thought', thought: true, thoughtSignature: 'gemini:SIG_T' },
        { text: 'summary without signature', thought: true },
        { text: 'answer' }
      ]
    },
    userText('next')
  ]);
  assert.deepEqual(wireShape(contents), [
    'user:TEXT(go)',
    'model:THOUGHT(gemini thought)+SIG_T,THOUGHT(summary without signature),TEXT(answer)',
    'user:TEXT(next)'
  ]);
});

test('E3 a model content left with only foreign thoughts is removed instead of sent empty', async () => {
  const contents = await geminiWireContents([
    userText('a'),
    { role: 'model', parts: [{ text: 'interrupted', thought: true, thoughtSignature: 'claude:sig' }] },
    userText('b')
  ]);
  assert.deepEqual(wireShape(contents), ['user:TEXT(a)', 'user:TEXT(b)']);
});

test('E3 signature-only thought parts from other providers are dropped like any other foreign thought', async () => {
  const envelope = JSON.stringify({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'ENC', format: 'google-gemini-v1', index: 0 }] });
  const contents = await geminiWireContents([
    userText('go'),
    {
      role: 'model',
      parts: [
        { text: '', thought: true, thoughtSignature: `openai-compatible:${envelope}` },
        { text: '', thought: true, thoughtSignature: 'claude:sig-only' },
        { text: 'answer' }
      ]
    },
    { role: 'model', parts: [{ text: '', thought: true, thoughtSignature: `openai-compatible:${envelope}` }] },
    userText('next')
  ]);
  assert.deepEqual(wireShape(contents), ['user:TEXT(go)', 'model:TEXT(answer)', 'user:TEXT(next)']);
});

test('E3 foreign-thought projection only applies to Gemini', () => {
  const history = [
    userText('a'),
    { role: 'model', parts: [{ text: 'claude thought', thought: true, thoughtSignature: 'claude:sig' }, { text: 'answer' }] }
  ];
  for (const providerKind of ['openai-compatible', 'openai-responses', 'deepseek']) {
    const request = toUnifiedRequest({ id: 'r', conversationId: 'c', contents: history, tools: [] }, undefined, providerKind);
    assert.equal(request.contents[1].parts[0].thought, true, providerKind);
  }
});

// ---------------------------------------------------------------------------------------------
// E4: Gemini tool schemas follow the documented Schema subset
// (https://ai.google.dev/api/generate-content#v1beta.Schema).

/** Frozen copy of the sanitizer before E4; built-in tool schemas must come out byte-identical. */
const LEGACY_GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  'title', 'default', 'const', '$defs', 'definitions', '$schema', 'not', 'if', 'then', 'else',
  'prefixItems', 'additionalProperties', 'propertyNames', 'multipleOf', 'exclusiveMinimum', 'exclusiveMaximum'
]);
function isPlainRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function legacySanitizeGeminiFunctionSchema(value) {
  if (Array.isArray(value)) return value.map(legacySanitizeGeminiFunctionSchema);
  if (!isPlainRecord(value)) return value;
  const result = {};
  let stringifiedEnum = false;
  for (const [key, child] of Object.entries(value)) {
    if (LEGACY_GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    if (key === 'properties' && isPlainRecord(child)) {
      result.properties = Object.fromEntries(Object.entries(child)
        .map(([propertyName, propertySchema]) => [propertyName, legacySanitizeGeminiFunctionSchema(propertySchema)]));
      continue;
    }
    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(child)) {
      const otherKeys = Object.keys(value).filter((candidate) =>
        candidate !== key && !LEGACY_GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(candidate));
      if (otherKeys.length === 0 && child.length > 0) {
        const first = legacySanitizeGeminiFunctionSchema(child[0]);
        if (isPlainRecord(first)) Object.assign(result, first);
      }
      continue;
    }
    if (key === 'enum' && Array.isArray(child)) {
      result.enum = child.map((item) => String(item));
      stringifiedEnum = true;
      continue;
    }
    result[key] = legacySanitizeGeminiFunctionSchema(child);
  }
  if (stringifiedEnum && (result.type === 'integer' || result.type === 'number')) result.type = 'string';
  if (Array.isArray(result.required) && isPlainRecord(result.properties)) {
    const required = result.required.filter((propertyName) =>
      typeof propertyName === 'string' && Object.prototype.hasOwnProperty.call(result.properties, propertyName));
    if (required.length > 0) result.required = required;
    else delete result.required;
  }
  return result;
}

async function loadBuiltinToolSchemas() {
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function patched(request, parent, isMain) {
    if (request === 'vscode') return { Uri: { file: (value) => ({ fsPath: value }) }, workspace: {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const definitions = require(path.join(root, 'dist/extension/backend/world/modules/tools/definitions/index.js'));
    const created = [
      ...definitions.createBuiltinToolDefinitions({ command: { toolName: 'bash', description: 'Synthetic shell.' } }),
      definitions.agentBoardTool
    ];
    const byName = new Map(created.map((definition) => [definition.declaration.name, {
      name: definition.declaration.name,
      description: definition.declaration.description ?? '',
      parameters: definition.declaration.parameters
    }]));
    // The full edit union (the edit tool itself sends it flattened) exercises constraint-only branches.
    const edit = byName.get('edit');
    byName.set('edit_union_probe', { name: 'edit_union_probe', description: 'probe', parameters: edit.parameters });
    return [...byName.values()];
  } finally {
    Module._load = originalLoad;
  }
}

async function geminiWireDeclarations(tools, provider, model) {
  const result = await dryRunLlmProvider({
    id: `schemas-${provider}`, invocationId: `schemas-${provider}`, conversationId: 'conversation-schemas',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    tools
  }, { settings: async () => providerConfig({ provider, model }) });
  return provider === 'gemini'
    ? result.body.tools[0].functionDeclarations
    : result.body.tools.map((tool) => tool.function);
}

test('E4 every built-in tool schema is byte-identical to the pre-E4 Gemini sanitizer output', async () => {
  const tools = await loadBuiltinToolSchemas();
  assert.ok(tools.length >= 20, `expected the built-in tool set, got ${tools.length}`);
  const sourceParameters = new Map(toUnifiedRequest({ id: 'r', conversationId: 'c', contents: [], tools }, undefined, 'gemini')
    .tools[0].functionDeclarations.map((declaration) => [declaration.name, declaration.parameters]));
  for (const [provider, model] of [['gemini', 'gemini-3.7-flash'], ['openai-compatible', '[v]gemini-3.5-flash']]) {
    const declarations = await geminiWireDeclarations(tools, provider, model);
    assert.equal(declarations.length, tools.length, provider);
    for (const declaration of declarations) {
      assert.equal(
        JSON.stringify(declaration.parameters),
        JSON.stringify(legacySanitizeGeminiFunctionSchema(sourceParameters.get(declaration.name))),
        `${provider} ${declaration.name}`
      );
    }
  }
});

function mcpToolParameters() {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', description: 'file path', format: 'uri' },
      nullableString: { type: ['string', 'null'], description: 'pydantic Optional[str]' },
      multiType: { type: ['string', 'number'] },
      anyOfNullable: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null, title: 'Anyofnullable' },
      anyOfUnion: { description: 'mixed', anyOf: [{ type: 'string' }, { type: 'number', minimum: 0 }] },
      oneOfUnion: { oneOf: [{ type: 'string' }, { $ref: '#/$defs/Item' }] },
      mode: { const: 'fast', type: 'string' },
      onlyConst: { const: 'fixed' },
      numericConst: { const: 3, type: 'integer' },
      tags: { type: 'array', items: { type: 'string' }, uniqueItems: true, examples: [['a']] },
      ref: { $ref: '#/$defs/Item', description: 'the item' },
      legacyRef: { allOf: [{ $ref: '#/definitions/Legacy' }], description: 'pydantic v1 style' },
      tree: { $ref: '#/$defs/Node' },
      dangling: { $ref: '#/$defs/Missing', description: 'unknown target' },
      remote: { $ref: 'https://example.invalid/schema.json', type: 'string' },
      map: { type: 'object', patternProperties: { '^x-': { type: 'string' } } },
      count: { type: 'integer', exclusiveMinimum: 0, multipleOf: 2 },
      title: { type: 'string', description: 'a property literally named title' },
      const: { type: 'string', description: 'a property literally named const' }
    },
    required: ['path', 'title', 'const'],
    $defs: {
      Item: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      Node: { type: 'object', properties: { children: { type: 'array', items: { $ref: '#/$defs/Node' } } } }
    },
    definitions: { Legacy: { type: 'object', properties: { name: { type: 'string' } } } }
  };
}

const EXPECTED_MCP_PARAMETERS = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'file path', format: 'uri' },
    nullableString: { type: 'string', description: 'pydantic Optional[str]', nullable: true },
    multiType: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    anyOfNullable: { type: 'string', nullable: true },
    anyOfUnion: { description: 'mixed', anyOf: [{ type: 'string' }, { type: 'number', minimum: 0 }] },
    oneOfUnion: {
      anyOf: [{ type: 'string' }, { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }]
    },
    mode: { enum: ['fast'], type: 'string' },
    onlyConst: { enum: ['fixed'], type: 'string' },
    numericConst: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
    ref: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], description: 'the item' },
    legacyRef: { description: 'pydantic v1 style', type: 'object', properties: { name: { type: 'string' } } },
    tree: {
      type: 'object',
      properties: { children: { type: 'array', items: { type: 'object' } } }
    },
    dangling: { description: 'unknown target' },
    remote: { type: 'string' },
    map: { type: 'object' },
    count: { type: 'integer' },
    title: { type: 'string', description: 'a property literally named title' },
    const: { type: 'string', description: 'a property literally named const' }
  },
  required: ['path', 'title', 'const']
};

test('E4 MCP schemas are reduced to the documented Gemini Schema subset', async () => {
  const parameters = mcpToolParameters();
  const original = structuredClone(parameters);
  for (const [provider, model] of [['gemini', 'gemini-3.7-flash'], ['openai-compatible', '[v]gemini-3.5-flash']]) {
    const [declaration] = await geminiWireDeclarations([{ name: 'fs_read', description: 'MCP tool', parameters }], provider, model);
    assert.deepEqual(declaration.parameters, EXPECTED_MCP_PARAMETERS, provider);
    // Every field the gateway rejected with "Unknown name ... Cannot find field" is gone.
    assert.doesNotMatch(JSON.stringify(declaration.parameters),
      /"(?:\$ref|\$defs|definitions|uniqueItems|examples|patternProperties|additionalProperties|multipleOf|exclusiveMinimum)"/);
  }
  assert.deepEqual(parameters, original, 'the source schema must not be mutated');
});

test('E4 non-Gemini providers keep MCP schemas untouched by the Gemini sanitizer', async () => {
  const parameters = mcpToolParameters();
  const result = await dryRunLlmProvider({
    id: 'schemas-claude', invocationId: 'schemas-claude', conversationId: 'conversation-schemas',
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    tools: [{ name: 'fs_read', description: 'MCP tool', parameters }]
  }, { settings: async () => providerConfig({ provider: 'openai-compatible', model: 'gpt-5.5' }) });
  assert.match(JSON.stringify(result.body.tools[0].function.parameters), /"nullableString":\{"type":\["string","null"\]/);
});

// ---------------------------------------------------------------------------------------------
// E5: a Gemini function call's signature stays on the call part it arrived on
// ("return this signature in the exact part where it was received", thought-signatures doc).

async function nativeGeminiStreamEvents(context, chunks) {
  context.mock.method(globalThis, 'fetch', async () => new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  ));
  const events = [];
  await startLlmProvider({
    id: 'request-native-gemini', invocationId: 'invocation-native-gemini', conversationId: 'conversation-native-gemini',
    contents: [{ role: 'user', parts: [{ text: 'go' }] }],
    tools: [{ name: 'list_items', description: 'List items.', parameters: { type: 'object', properties: {} } }]
  }, (event) => events.push(event), { settings: async () => geminiConfig({ apiKey: 'offline-placeholder' }) });
  assert.equal(events.some((event) => event.type === LlmEventType.Error), false);
  return events;
}

const geminiChunk = (parts, finishReason) => ({
  candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }]
});

test('E5 a streamed call signature is not copied onto the preceding thought summary', async (context) => {
  const events = await nativeGeminiStreamEvents(context, [
    geminiChunk([{ text: 'Planning the call.', thought: true }]),
    geminiChunk([{ functionCall: { name: 'list_items', args: {}, id: 'c1' }, thoughtSignature: 'SIG_FC' }]),
    geminiChunk([{ text: '' }], 'STOP')
  ]);
  const thoughtSignatures = events
    .filter((event) => event.type === LlmEventType.ThoughtDone || event.type === LlmEventType.ThoughtDelta)
    .map((event) => event.payload.thoughtSignature);
  assert.deepEqual(thoughtSignatures, [undefined, undefined]);
  const calls = events.filter((event) => event.type === LlmEventType.ToolCall).flatMap((event) => event.payload.calls);
  assert.deepEqual(calls.map((call) => [call.id, call.thoughtSignature]), [['c1', 'gemini:SIG_FC']]);
});

test('E5 a signed call without any thought does not create an empty thought part', async (context) => {
  const events = await nativeGeminiStreamEvents(context, [
    geminiChunk([{ functionCall: { name: 'list_items', args: {}, id: 'c1' }, thoughtSignature: 'SIG_FC' }], 'STOP')
  ]);
  assert.equal(events.some((event) => event.type === LlmEventType.ThoughtDone), false);
  const calls = events.filter((event) => event.type === LlmEventType.ToolCall).flatMap((event) => event.payload.calls);
  assert.deepEqual(calls.map((call) => call.thoughtSignature), ['gemini:SIG_FC']);
});

test('E5 signatures carried by thought or text parts keep their current handling', async (context) => {
  const events = await nativeGeminiStreamEvents(context, [
    geminiChunk([{ text: 'Thinking.', thought: true, thoughtSignature: 'SIG_THOUGHT' }]),
    geminiChunk([{ functionCall: { name: 'list_items', args: {}, id: 'c1' }, thoughtSignature: 'SIG_FC' }]),
    geminiChunk([{ text: 'Done.' }]),
    geminiChunk([{ text: '', thoughtSignature: 'SIG_TEXT' }], 'STOP')
  ]);
  const thoughtDone = events.filter((event) => event.type === LlmEventType.ThoughtDone)
    .map((event) => event.payload.thoughtSignature);
  assert.deepEqual(thoughtDone, ['gemini:SIG_THOUGHT', 'gemini:SIG_TEXT']);
});

// ---------------------------------------------------------------------------------------------
// Provider items in ordinary replies (group D, D4): the Responses `compaction` output item of a
// reply made with `context_management` is kept and replayed as it came
// (https://developers.openai.com/api/docs/guides/compaction, "append output items as usual").

const RESPONSES_COMPACTION = {
  provider: 'openai', format: 'openai-responses', endpoint: 'responses', itemType: 'compaction',
  rawItem: { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque' }
};

test('D4 completed content keeps provider items in place with their output item', () => {
  const outputItem = { id: 'cmp_1', ordinal: 0 };
  const content = fromUnifiedCompletedContent({
    role: 'model',
    parts: [
      { providerContext: RESPONSES_COMPACTION, outputItem },
      { text: 'answer', outputItem: { id: 'msg_1', ordinal: 1 } }
    ]
  });
  assert.deepEqual(content.parts, [
    { providerContext: RESPONSES_COMPACTION, outputItem },
    { text: 'answer', outputItem: { id: 'msg_1', ordinal: 1 } }
  ]);
});

test('D4 streamed provider items become OutputItemDone events with the part, in stream order', () => {
  const events = [];
  emitUnifiedChunk('request-d4', {
    textDelta: 'answer',
    partsDelta: [{ providerContext: RESPONSES_COMPACTION }, { text: 'answer' }, { providerContext: { ...RESPONSES_COMPACTION, rawItem: { type: 'compaction', id: 'cmp_2' } } }]
  }, (event) => events.push(event));
  assert.deepEqual(events.map((event) => [event.type, event.payload.part?.providerContext.rawItem.id ?? event.payload.text]), [
    [LlmEventType.OutputItemDone, 'cmp_1'],
    [LlmEventType.Delta, 'answer'],
    [LlmEventType.OutputItemDone, 'cmp_2']
  ]);
  assert.deepEqual(events[0].payload, { requestId: 'request-d4', part: { providerContext: RESPONSES_COMPACTION } });

  // A chunk without provider items emits exactly what it did before.
  const plain = [];
  emitUnifiedChunk('request-d4', { textDelta: 'answer', partsDelta: [{ text: 'answer' }] }, (event) => plain.push(event));
  assert.deepEqual(plain, [{ type: LlmEventType.Delta, payload: { requestId: 'request-d4', text: 'answer' } }]);
});

test('D4 non-streamed provider items are emitted before the visible text', () => {
  const events = [];
  emitUnifiedResponse('request-d4', {
    content: { role: 'model', parts: [{ text: 'answer' }, { providerContext: RESPONSES_COMPACTION }] }
  }, (event) => events.push(event));
  assert.deepEqual(events.map((event) => event.type), [LlmEventType.OutputItemDone, LlmEventType.Delta]);
  assert.deepEqual(events[0].payload.part, { providerContext: RESPONSES_COMPACTION });
});

test('D4 Gemini drops provider items of other formats and contents left empty', async () => {
  const contents = await geminiWireContents([
    userText('q1'),
    { role: 'model', parts: [{ providerContext: RESPONSES_COMPACTION }, { text: 'answer' }] },
    { role: 'model', parts: [{ providerContext: { provider: 'anthropic', format: 'claude', itemType: 'compaction', rawItem: { type: 'compaction', content: 's' } } }] },
    { role: 'model', parts: [{ text: 'kept' }], providerContext: { provider: 'openai', format: 'openai-responses', itemType: 'message', rawItem: {} } },
    userText('q2')
  ]);
  assert.deepEqual(wireShape(contents), ['user:TEXT(q1)', 'model:TEXT(answer)', 'model:TEXT(kept)', 'user:TEXT(q2)']);
  assert.doesNotMatch(JSON.stringify(contents), /providerContext/);
});

test('D4 other providers still receive provider items for their own encoders', () => {
  const history = [userText('q1'), { role: 'model', parts: [{ providerContext: RESPONSES_COMPACTION }, { text: 'answer' }] }];
  for (const providerKind of ['openai-responses', 'claude', 'openai-compatible']) {
    const request = toUnifiedRequest({ id: 'r', conversationId: 'c', contents: history, tools: [] }, undefined, providerKind);
    assert.deepEqual(request.contents.flatMap((content) => content.parts).filter((part) => part.providerContext).length, 1, providerKind);
  }
});
