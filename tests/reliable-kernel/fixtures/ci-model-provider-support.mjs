import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
export const load = file => require(path.join(compiled, file));
export const kernel = load('backend/reliableKernel/index.js');
export const llm = load('backend/capabilities/llmProvider.js');
export const conversion = load('backend/capabilities/unifiedMessageConversion.js');
export const adaptation = load('backend/capabilities/providerParameterAdaptation.js');

export const user = text => ({ role: 'user', parts: [{ text }] });
export const model = parts => ({ role: 'model', parts });
export const call = (id, name = 'read', args = {}) => ({ id, functionCall: { name, args } });
export const result = (id, name = 'read', response = {}) => ({ id, functionResponse: { name, response } });
export const EDIT_TOOL = {
  name: 'edit', description: 'Edit a file.',
  parameters: load('backend/world/modules/tools/definitions/edit/index.js').editToolParameters()
};

export function settings(provider = 'openai-compatible', overrides = {}) {
  const models = { 'openai-compatible': 'model-a', 'openai-responses': 'gpt-5.6-sol',
    claude: 'claude-opus-5-5', gemini: 'gemini-3.7-flash' };
  const id = overrides.id ?? `ci-${provider}`;
  const selected = overrides.model ?? models[provider];
  return { id, name: id, provider, model: selected,
    baseUrl: provider === 'gemini' ? 'https://provider.invalid/v1beta' : 'https://provider.invalid/v1',
    models: [{ id: selected, name: selected }], apiKey: 'offline-placeholder',
    toolCallFormat: 'function-call', openaiResponsesTransport: 'http', stream: true,
    retryOnError: false, retryMaxAttempts: 0, retryDelaySeconds: 0,
    enableMultimodalTools: true, systemPromptPrefix: '', modelConfigs: [],
    promptCache: { enabled: false, mode: 'key', ttl: '30m' }, createdAt: 1, updatedAt: 1,
    ...overrides };
}

export function startRequest(contents = [user('hello')], overrides = {}) {
  return { id: 'ci-provider-request', invocationId: 'ci-provider-invocation',
    conversationId: 'ci-provider-conversation', contents, tools: [], ...overrides };
}

export function fullRequest(config = settings(), contents = [user('hello')], tools = []) {
  return { kind: 'full-model-request', modelRequestId: `request-${config.id}`,
    conversationId: `conversation-${config.id}`, attemptSeq: '1', socketGeneration: '1',
    providerId: config.id, modelId: config.model,
    authoritySnapshot: {
      model: { providerConfigId: config.id, provider: config.provider, modelId: config.model },
      toolPolicy: { allowedTools: tools.map(tool => tool.name), preset: 'custom', sourceConfigs: {} },
      systemPrompt: { text: 'system instruction' }
    }, recipe: { tools },
    context: contents.map((content, index) => ({ segmentId: `segment-${index}`,
      segmentKind: 'message', messageRole: content.role,
      contentType: 'application/vnd.limcode.message+json', content: JSON.stringify(content) })),
    attachmentCatalogState: { catalog: [], placements: [] } };
}

export function fakeCapability(start) {
  return { start, abort() {}, cancelRetry() {}, dispose() {} };
}

export const accepted = { async onEvent(event) {
  return { accepted: true, checkpointed: true, terminal: event.kind === 'completed' };
} };

export async function wire(config, contents = [user('hello')], overrides = {}) {
  return llm.dryRunLlmProvider(startRequest(contents, overrides), { settings: async () => config });
}

export const sse = chunks => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } });
export const compatDelta = (delta, finish_reason = null) => ({
  choices: [{ index: 0, delta, finish_reason }]
});
export const geminiChunk = (parts, finishReason) => ({ candidates: [{
  content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {})
}] });

export function claudeSse(parts, stopReason = 'end_turn') {
  const events = [{ type: 'message_start', message: { id: 'claude-reply', type: 'message',
    role: 'assistant', content: [], model: 'claude-opus-5-5', stop_reason: null,
    usage: { input_tokens: 5, output_tokens: 1 } } }];
  parts.forEach((part, index) => {
    events.push({ type: 'content_block_start', index, content_block: part.thought
      ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' } });
    events.push({ type: 'content_block_delta', index, delta: part.thought
      ? { type: 'thinking_delta', thinking: part.text } : { type: 'text_delta', text: part.text } });
    if (part.thought) events.push({ type: 'content_block_delta', index,
      delta: { type: 'signature_delta', signature: part.signature ?? 'ci-claude-signature' } });
    events.push({ type: 'content_block_stop', index });
  });
  events.push({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } },
    { type: 'message_stop' });
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}

export async function withFetch(respond, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const entry = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) };
    calls.push(entry);
    return respond(entry, init, calls.length);
  };
  try { return await run(calls); }
  finally { globalThis.fetch = original; }
}

export async function send(config, contents = [user('hello')], overrides = {}) {
  const events = [];
  await llm.startLlmProvider(startRequest(contents, overrides), event => events.push(event),
    { settings: async () => config });
  return events;
}

export async function adaptedReply(config, contents, tools = []) {
  const capability = llm.createLlmProviderCapability({ settings: async () => config });
  const events = [];
  try {
    await new kernel.LlmCapabilityFullRequestAdapter(config.id, capability)
      .sendFullRequest(fullRequest(config, contents, tools), { async onEvent(event) {
        events.push(event); return { accepted: true, checkpointed: true, terminal: event.kind === 'completed' };
      } });
    return events.at(-1).content;
  } finally { capability.dispose(); }
}

export async function providerFailure(message, rawError, retryPolicy) {
  const config = settings();
  const request = fullRequest(config);
  if (retryPolicy) request.authoritySnapshot.model.retryPolicy = retryPolicy;
  const adapter = new kernel.LlmCapabilityFullRequestAdapter(config.id, fakeCapability((input, emit) => {
    emit({ type: 'llm:error', payload: { requestId: input.id, message, rawError } });
  }));
  try { await adapter.sendFullRequest(request, accepted); }
  catch (error) { return error; }
  throw new Error('Expected provider failure.');
}
