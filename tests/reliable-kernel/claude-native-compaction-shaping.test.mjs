/**
 * Claude on-demand (provider-native) compaction is encoded exactly like the conversation's ordinary requests.
 *
 * Official rules:
 * - https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand — send “the conversation as it stands”
 *   with the `compaction` parameter and the `compact-2026-09-04` beta; “Send the same `system` prompt and `tools` that
 *   you use for the rest of the conversation … the thinking in those turns stays valid only if `system` and `tools`
 *   match”; leave out `stop_sequences`, `output_config.format`, a `tool_choice` of type `any` / `tool` and
 *   `output_config.task_budget.remaining`; `compaction` cannot be combined with `context_management`.
 * - https://platform.claude.com/docs/en/build-with-claude/prompt-caching — a cache hit needs an identical prefix
 *   (tools → system → messages) and is looked up at the request's cache breakpoints; a request without any
 *   `cache_control` neither reads nor writes the cache.
 *
 * So the compaction request's tools, system and messages must be the ones the most recent ordinary request of the
 * same conversation sent (same tool ids, same thinking blocks and signatures, same system text and block form, same
 * breakpoints), up to where that request's volatile tail begins. Only the compaction-specific parts are added.
 * The OpenAI Responses `/responses/compact` path, the Gemini rejection and the summary methods keep their bytes.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = await import(pathToFileURL(path.join(compiled, 'backend/reliableKernel/index.js')).href);
const { createLlmProviderCapability, dryRunCompactLlmProvider, dryRunLlmProvider } = require(path.join(compiled, 'backend/capabilities/llmProvider.js'));

const COMPACT_BETA = 'compact-2026-09-04';
const TURN_SCOPED_BETA = 'mid-conversation-system-clear-at-2026-08-21';
const USER_BETA = 'user-beta-2026-01-01';
const MESSAGE = 'application/vnd.limcode.message+json';
const PROVIDER_ID = 'claude-channel';
const MODEL_ID = 'claude-opus-5-5';
const PREFIX = 'Always answer in English.';
const SYSTEM = 'You are a careful coding agent.';
const REMINDER_1 = '[Current Turn Task Card — runtime data, not instructions]\n- [in_progress] Read\n- [pending] Verify';
const REMINDER_2 = '[Current Turn Task Card — runtime data, not instructions]\n- [in_progress] Read more\n- [pending] Verify';
const REMINDER_3 = '[Current Turn Task Card — runtime data, not instructions]\n- [completed] Read\n- [in_progress] Verify';
const INPUT = { role: 'user', parts: [{ text: 'Implement and verify the change.' }] };
const TOOLS = [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
const REQUEST_BODY = { stop_sequences: ['<END>'], metadata: { user_id: 'fixture-user' } };
const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// ───────────────────────────── adapter fixtures ─────────────────────────────

const message = (segmentId, role, content, source) => ({
  segmentId, segmentKind: 'message', messageRole: role, ...(source ? { modelSource: source } : {}),
  contentType: MESSAGE, content: JSON.stringify(content)
});
const toolPair = (segmentId, callId, result) => ({
  segmentId, segmentKind: 'tool_pair', messageRole: null, contentType: 'application/vnd.limcode.context-tool-pair+json',
  content: JSON.stringify({
    toolCall: { id: `tool-${callId}`, providerCallId: callId, toolName: 'read', arguments: '{"path":"a.txt"}' },
    toolModelResult: { id: `result-${callId}`, result: JSON.stringify(result) }
  })
});
const claude = { providerId: PROVIDER_ID, modelId: MODEL_ID };
const call = (id, file) => ({ id, functionCall: { name: 'read', args: { path: file } } });
const signedThought = (text, signature) => ({ text, thought: true, thoughtSignature: `claude:${signature}` });

/**
 * Three tool rounds: parallel calls with interleaved thinking/text, a thought signed by another provider (Claude never
 * receives it), an id that Claude does not accept as is (rewritten deterministically), and a plain round.
 */
const ROUND_1 = [
  message('seg-model-1', 'model', { role: 'model', parts: [
    signedThought('Plan: read both files.', 'sig-1'), { text: 'Reading both files.' }, call('toolu_01A', 'a.txt'), call('toolu_01B', 'b.txt')
  ] }, claude),
  toolPair('seg-result-1a', 'toolu_01A', { ok: true, text: 'alpha' }),
  toolPair('seg-result-1b', 'toolu_01B', { ok: true, text: 'beta' })
];
const ROUND_2 = [
  message('seg-model-2', 'model', { role: 'model', parts: [
    { text: 'Reasoning from another channel.', thought: true, thoughtSignature: 'gemini:foreign-signature' },
    signedThought('Need c.txt as well.', 'sig-2'), call('functions.read:2', 'c.txt')
  ] }, claude),
  toolPair('seg-result-2', 'functions.read:2', { ok: true, text: 'gamma' })
];
const ROUND_3 = [
  message('seg-model-3', 'model', { role: 'model', parts: [signedThought('Verify d.txt.', 'sig-3'), call('toolu_03', 'd.txt')] }, claude),
  toolPair('seg-result-3', 'toolu_03', { ok: true, text: 'delta' })
];
/** The window request N saw; request N answered with ROUND_3, then the window was compacted. */
const WINDOW_N = [message('seg-user', 'user', INPUT), ...ROUND_1, ...ROUND_2];
const WINDOW_FULL = [...WINDOW_N, ...ROUND_3];
const HISTORY_N = [{ segmentId: 'seg-model-1', content: REMINDER_1 }, { segmentId: 'seg-model-2', content: REMINDER_2 }];
const HISTORY_FULL = [...HISTORY_N, { segmentId: 'seg-model-3', content: REMINDER_3 }];

function authority(claudeTurnScopedReminders) {
  return {
    model: {
      providerConfigId: PROVIDER_ID, provider: 'claude', modelId: MODEL_ID, systemPromptPrefix: PREFIX,
      ...(claudeTurnScopedReminders ? { claudeTurnScopedReminders: true } : {}),
      generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
      requestBody: REQUEST_BODY
    },
    toolPolicy: { allowedTools: ['read'], preset: 'custom', sourceConfigs: {} },
    systemPrompt: { text: SYSTEM }
  };
}

function ordinaryRequest({ context, reminder, history, claudeTurnScopedReminders = false }) {
  return {
    kind: 'full-model-request', modelRequestId: `model-request-${context.length}`, conversationId: 'conversation-shaping',
    attemptSeq: '1', socketGeneration: '1', providerId: PROVIDER_ID, modelId: MODEL_ID,
    authoritySnapshot: authority(claudeTurnScopedReminders),
    recipe: { kind: 'reliable-agent-turn', round: String(context.length), tools: TOOLS },
    context, attachmentCatalogState: { catalog: [], placements: [] },
    requestAddenda: {
      ...(reminder ? { turnReminder: { content: reminder, unfinishedTaskCount: 1, activeChildCount: 0, runningProcessCount: 0 } } : {}),
      ...(history ? { turnReminderHistory: history } : {})
    }
  };
}

function compactionRequest({ context, history, claudeTurnScopedReminders = false }) {
  const base = ordinaryRequest({ context, history, claudeTurnScopedReminders });
  return {
    ...base,
    modelRequestId: 'compaction-request',
    authoritySnapshot: {
      ...base.authoritySnapshot,
      compression: {
        enabled: true, methodKind: 'provider_native',
        config: { id: 'native', name: 'Native', kind: 'provider_native', trigger: { mode: 'manual' } },
        provider: { providerConfigId: PROVIDER_ID, provider: 'claude', modelId: MODEL_ID, contextWindowTokens: 200000, maxOutputTokens: 16000 }
      }
    },
    recipe: { kind: 'reliable-context-compression', sourceRootId: 'root', sourceSegmentCount: context.length, blockId: 'block',
      compressionMethodKind: 'provider_native', sourceHash: 'hash', tools: TOOLS },
    requestAddenda: history ? { turnReminderHistory: history } : undefined
  };
}

function settingsFor({ provider = 'claude', model = MODEL_ID, promptCache = true, baseUrl = 'https://example.invalid/v1' } = {}) {
  return {
    id: `${provider}-channel`, name: provider, provider, baseUrl, model, models: [{ id: model, name: model }], apiKey: '',
    toolCallFormat: 'function-call', openaiResponsesTransport: 'http', stream: true, retryOnError: false, retryMaxAttempts: 0,
    retryDelaySeconds: 0, enableMultimodalTools: true, systemPromptPrefix: provider === 'claude' ? PREFIX : '', contextWindowTokens: 200000,
    promptCache: provider === 'claude' ? { enabled: promptCache, mode: 'explicit', ttl: '1h' } : { enabled: promptCache, mode: 'key', ttl: '30m' },
    headers: provider === 'claude' ? { 'anthropic-beta': USER_BETA } : {},
    generationConfig: { thinkingConfig: { thinkingLevel: 'high' } }, modelConfigs: [], createdAt: 1, updatedAt: 1
  };
}

const fakeCapability = (capture) => ({
  start(input, emit) { capture.start = structuredClone(input); emit({ type: 'llm:done', payload: { requestId: input.id } }); },
  compact(input, emit) {
    capture.compact = structuredClone(input);
    emit({ type: 'llm:compactDone', payload: { requestId: input.id, result: { contents: [{ role: 'user', parts: [{ text: 'compacted' }] }] } } });
  },
  abort() {}, cancelRetry() {}, dispose() {}
});
const accepted = { onEvent: async () => ({ accepted: true, checkpointed: true, terminal: false }) };

async function renderOrdinary(request, settings = settingsFor()) {
  const capture = {};
  await new kernel.LlmCapabilityFullRequestAdapter(request.providerId, fakeCapability(capture)).sendFullRequest(request, accepted);
  const wire = await dryRunLlmProvider(capture.start, { settings });
  return { start: capture.start, headers: wire.headers, body: wire.body };
}

async function renderCompaction(request, settings = settingsFor()) {
  const capture = {};
  await new kernel.LlmCapabilityFullRequestAdapter(request.providerId, fakeCapability(capture)).sendFullRequest(request, accepted);
  const dry = await dryRunCompactLlmProvider(capture.compact, { settings, compressionSettings: async () => undefined });
  assert.equal(dry.calls.length, 1);
  return { compact: capture.compact, call: dry.calls[0], headers: dry.calls[0].headers, body: JSON.parse(dry.calls[0].bodyText) };
}

// ───────────────────────────── wire helpers ─────────────────────────────

const withoutCacheControl = (value) => JSON.parse(JSON.stringify(value, (key, entry) => key === 'cache_control' ? undefined : entry));
const betas = (headers) => String(headers['anthropic-beta'] ?? '').split(',').filter(Boolean);
const blocks = (messages, type) => messages.flatMap((entry) => Array.isArray(entry.content) ? entry.content.filter((block) => block.type === type) : []);
const toolUseIds = (messages) => blocks(messages, 'tool_use').map((block) => block.id);
const toolResultIds = (messages) => blocks(messages, 'tool_result').map((block) => block.tool_use_id);

/** Every cache_control marker of an encoded request, as a readable location. */
function cacheMarkers(body) {
  const markers = [];
  (body.tools ?? []).forEach((tool, index) => { if (tool.cache_control) markers.push(`tools[${index}]`); });
  if (Array.isArray(body.system)) body.system.forEach((block, index) => { if (block.cache_control) markers.push(`system[${index}]`); });
  body.messages.forEach((entry, index) => {
    if (Array.isArray(entry.content)) entry.content.forEach((block, blockIndex) => { if (block.cache_control) markers.push(`messages[${index}].content[${blockIndex}]`); });
  });
  if (body.cache_control) markers.push('top-level');
  return markers;
}

function lastUserBlock(messages) {
  const index = messages.findLastIndex((entry) => entry.role === 'user');
  return `messages[${index}].content[${messages[index].content.length - 1}]`;
}

const CACHE = { type: 'ephemeral', ttl: '1h' };
const REWRITTEN_ID = /^functions_read_2_[0-9a-f]{8}$/;

// ───────────────────────────── Claude ─────────────────────────────

test('Claude 原生压缩：多轮工具循环的 tools、system 与消息前缀和上一次普通请求逐字节相同，并带同样的缓存断点', async () => {
  const ordinary = await renderOrdinary(ordinaryRequest({ context: WINDOW_N, reminder: REMINDER_3 }));
  const compaction = await renderCompaction(compactionRequest({ context: WINDOW_FULL }));

  // The ordinary request's volatile tail is its reminder, the last user message (it also carries that request's breakpoint).
  assert.deepEqual(ordinary.start.openAIResponsesContinuation.volatileTailContentKinds, ['turn_reminder']);
  const tail = ordinary.body.messages.at(-1);
  assert.deepEqual(tail, { role: 'user', content: [{ type: 'text', text: REMINDER_3, cache_control: CACHE }] });
  const stable = ordinary.body.messages.slice(0, -1);

  // Messages: the stable part of the ordinary request is a byte-identical prefix of the compaction request.
  assert.deepEqual(compaction.body.messages.slice(0, stable.length), stable);
  assert.deepEqual(compaction.body.messages.map((entry) => entry.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
  // Tool ids are the stored ones (a non-conforming id is rewritten the same way as in ordinary requests).
  const ids = toolUseIds(compaction.body.messages);
  assert.deepEqual(ids.slice(0, 3), toolUseIds(stable));
  assert.equal(ids[0], 'toolu_01A');
  assert.equal(ids[1], 'toolu_01B');
  assert.match(ids[2], REWRITTEN_ID);
  assert.equal(ids[3], 'toolu_03');
  assert.deepEqual(toolResultIds(compaction.body.messages), ids);
  // Parallel results answer their calls in one user message.
  assert.deepEqual(toolResultIds([compaction.body.messages[2]]), ['toolu_01A', 'toolu_01B']);
  // Thinking blocks keep their text, order and Claude signatures; another provider's thought is not sent.
  assert.deepEqual(blocks(compaction.body.messages, 'thinking'), [
    { type: 'thinking', thinking: 'Plan: read both files.', signature: 'sig-1' },
    { type: 'thinking', thinking: 'Need c.txt as well.', signature: 'sig-2' },
    { type: 'thinking', thinking: 'Verify d.txt.', signature: 'sig-3' }
  ]);
  assert.deepEqual(compaction.body.messages[1].content.map((block) => block.type), ['thinking', 'text', 'tool_use', 'tool_use']);
  assert.equal(JSON.stringify(compaction.body).includes('Reasoning from another channel.'), false);

  // System and tools: identical, including the block form and breakpoints the prompt cache needs.
  assert.deepEqual(compaction.body.system, ordinary.body.system);
  assert.deepEqual(compaction.body.system, [{ type: 'text', text: `${PREFIX}\n\n${SYSTEM}`, cache_control: CACHE }]);
  assert.deepEqual(compaction.body.tools, ordinary.body.tools);
  assert.equal(compaction.body.tools.length, 1);
  assert.equal(compaction.body.tools[0].name, 'read');
  // One breakpoint each on tools, system and the last user message, like every ordinary request.
  assert.deepEqual(cacheMarkers(ordinary.body), ['tools[0]', 'system[0]', lastUserBlock(ordinary.body.messages)]);
  assert.deepEqual(cacheMarkers(compaction.body), ['tools[0]', 'system[0]', lastUserBlock(compaction.body.messages)]);
  assert.equal(lastUserBlock(compaction.body.messages), 'messages[6].content[0]');

  // Compaction-specific parts: beta header, compaction body, forbidden fields removed; model settings unchanged.
  assert.deepEqual(betas(compaction.headers), [USER_BETA, COMPACT_BETA]);
  assert.equal(betas(ordinary.headers).includes(COMPACT_BETA), false);
  assert.equal(compaction.body.compaction.type, 'summarize');
  assert.match(compaction.body.compaction.instructions, /^Summarize the transcript for exact continuation/);
  assert.equal(compaction.call.stream, false);
  assert.equal('stream' in compaction.body, false);
  assert.deepEqual(ordinary.body.stop_sequences, ['<END>']);
  assert.equal('stop_sequences' in compaction.body, false);
  assert.deepEqual(compaction.body.metadata, REQUEST_BODY.metadata);
  for (const key of ['model', 'max_tokens', 'thinking', 'output_config']) assert.deepEqual(compaction.body[key], ordinary.body[key], key);
  assert.deepEqual(
    Object.keys(compaction.body).sort(),
    ['compaction', 'max_tokens', 'messages', 'metadata', 'model', 'output_config', 'system', 'thinking', 'tools']
  );

  // Against the ordinary request the next round would send over the same window: only the breakpoint position differs.
  const next = await renderOrdinary(ordinaryRequest({ context: WINDOW_FULL, reminder: REMINDER_3 }));
  assert.deepEqual(withoutCacheControl(compaction.body.messages), withoutCacheControl(next.body.messages.slice(0, -1)));
});

test('Claude 原生压缩：渠道关闭提示缓存时不带任何 cache_control，system 与普通请求一样是字符串', async () => {
  const settings = settingsFor({ promptCache: false });
  const ordinary = await renderOrdinary(ordinaryRequest({ context: WINDOW_N, reminder: REMINDER_3 }), settings);
  const compaction = await renderCompaction(compactionRequest({ context: WINDOW_FULL }), settings);
  assert.equal(JSON.stringify(ordinary.body).includes('cache_control'), false);
  assert.equal(JSON.stringify(compaction.body).includes('cache_control'), false);
  assert.equal(compaction.body.system, `${PREFIX}\n\n${SYSTEM}`);
  assert.equal(compaction.body.system, ordinary.body.system);
  assert.deepEqual(compaction.body.tools, ordinary.body.tools);
  const stable = ordinary.body.messages.slice(0, -1);
  assert.deepEqual(ordinary.body.messages.at(-1), { role: 'user', content: REMINDER_3 });
  assert.deepEqual(compaction.body.messages.slice(0, stable.length), stable);
  assert.deepEqual(toolUseIds(compaction.body.messages).slice(0, 2), ['toolu_01A', 'toolu_01B']);
  assert.equal(compaction.body.compaction.type, 'summarize');
  assert.deepEqual(betas(compaction.headers), [USER_BETA, COMPACT_BETA]);
});

test('Claude 原生压缩：轮内系统消息开关打开时，整条普通请求（含本轮提醒）都是压缩请求的前缀', async () => {
  const ordinary = await renderOrdinary(ordinaryRequest({ context: WINDOW_N, reminder: REMINDER_3, history: HISTORY_N, claudeTurnScopedReminders: true }));
  const compaction = await renderCompaction(compactionRequest({ context: WINDOW_FULL, history: HISTORY_FULL, claudeTurnScopedReminders: true }));
  assert.equal(compaction.compact.settingsSnapshot.claudeTurnScopedReminders, true);
  // In this layout the current reminder is a turn-scoped system message that later requests keep in place: no tail.
  assert.deepEqual(ordinary.body.messages.at(-1), { role: 'system', clear_at: 'next_user_message', content: REMINDER_3 });
  assert.deepEqual(
    compaction.body.messages.map((entry) => entry.role),
    ['user', 'system', 'assistant', 'user', 'system', 'assistant', 'user', 'system', 'assistant', 'user']
  );
  // The ordinary breakpoint sits on the user message before its system section; the compaction one on its last user
  // message. Apart from that marker the whole ordinary request is a prefix of the compaction request.
  assert.deepEqual(cacheMarkers(ordinary.body), ['tools[0]', 'system[0]', 'messages[6].content[0]']);
  assert.deepEqual(cacheMarkers(compaction.body), ['tools[0]', 'system[0]', 'messages[9].content[0]']);
  assert.deepEqual(
    withoutCacheControl(compaction.body.messages.slice(0, ordinary.body.messages.length)),
    withoutCacheControl(ordinary.body.messages)
  );
  assert.deepEqual(compaction.body.messages.slice(0, 6), ordinary.body.messages.slice(0, 6));
  for (const entry of compaction.body.messages.filter((item) => item.role === 'system')) {
    assert.equal(entry.clear_at, 'next_user_message');
    assert.equal(JSON.stringify(entry).includes('cache_control'), false);
  }
  assert.deepEqual(compaction.body.messages.filter((item) => item.role === 'system').map((item) => item.content), [REMINDER_1, REMINDER_2, REMINDER_3]);
  assert.deepEqual(compaction.body.system, ordinary.body.system);
  assert.deepEqual(compaction.body.tools, ordinary.body.tools);
  assert.deepEqual(toolUseIds(compaction.body.messages).slice(0, 3), toolUseIds(ordinary.body.messages));
  assert.deepEqual(blocks(compaction.body.messages, 'thinking').map((block) => block.signature), ['sig-1', 'sig-2', 'sig-3']);
  assert.deepEqual(betas(compaction.headers), [USER_BETA, TURN_SCOPED_BETA, COMPACT_BETA]);
  assert.equal(compaction.body.compaction.type, 'summarize');

  // Switch off with the same stored history: no system messages, and the reminder-free ordinary request is the prefix.
  const off = await renderCompaction(compactionRequest({ context: WINDOW_FULL, history: HISTORY_FULL }));
  const offOrdinary = await renderOrdinary(ordinaryRequest({ context: WINDOW_N, history: HISTORY_N }));
  assert.equal(off.body.messages.some((entry) => entry.role === 'system'), false);
  assert.deepEqual(betas(off.headers), [USER_BETA, COMPACT_BETA]);
  assert.deepEqual(
    withoutCacheControl(off.body.messages.slice(0, offOrdinary.body.messages.length)),
    withoutCacheControl(offOrdinary.body.messages)
  );
});

async function withServer(respond, run) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({ path: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(respond()));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/v1`, calls);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Claude 原生压缩：实际发出的请求体与 dry-run 相同，返回的签名块原样保留', async () => {
  const signed = { type: 'compaction', content: 'SUMMARY_MARKER', signature: 'signed-compaction' };
  await withServer(() => ({ id: 'msg_c', type: 'message', role: 'assistant', content: [signed], stop_reason: 'compaction',
    usage: { input_tokens: 0, output_tokens: 0, iterations: [{ input_tokens: 10, output_tokens: 5 }] } }),
  async (baseUrl, calls) => {
    const settings = { ...settingsFor({ baseUrl }), apiKey: 'dummy-test-key', stream: false };
    const rendered = await renderCompaction(compactionRequest({ context: WINDOW_FULL }), settings);
    const capability = createLlmProviderCapability({ settings: async () => settings, compressionSettings: async () => undefined });
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('compaction timed out')), 10_000);
        capability.compact(rendered.compact, (event) => {
          if (event.type !== 'llm:compactDone' && event.type !== 'llm:compactError') return;
          clearTimeout(timer);
          resolve(event);
        });
      });
      assert.equal(result.type, 'llm:compactDone', JSON.stringify(result.payload));
      assert.deepEqual(result.payload.result.contents[0].parts[0].providerContext.rawItem, signed);
    } finally {
      capability.dispose();
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, '/v1/messages');
    assert.deepEqual(calls[0].body, rendered.body);
    assert.deepEqual(betas(calls[0].headers), [USER_BETA, COMPACT_BETA]);
    assert.deepEqual(toolUseIds(calls[0].body.messages).slice(0, 2), ['toolu_01A', 'toolu_01B']);
    assert.deepEqual(cacheMarkers(calls[0].body), ['tools[0]', 'system[0]', 'messages[6].content[0]']);
  });
});

// ───────────────────── other providers and methods keep their bytes ─────────────────────

/**
 * sha256(JSON.stringify({url, headers, body})) of these dry-runs as produced before this change
 * (codex/agent-collaboration ecdc1b2b): the fix is Claude-only.
 */
const UNCHANGED_BASELINE = {
  openaiResponsesNative: 'a0b88af17076c4d3a7b6b52e32ab0c7e662ce12a3ea0e41a9b2e0f4e6ce09762',
  claudeLlmSummary: '61bbdd12120c96d6b9f339034fead8fce85bf69e698ee0288d21f413c0e69228'
};

function handcraftedCompactRequest(provider, model, methodKind) {
  return {
    id: 'pin-request', blockId: 'pin-block', conversationId: 'pin-conversation', methodKind,
    methodConfigSnapshot: { id: 'pin-method', name: 'Pin', kind: methodKind, trigger: { mode: 'manual' },
      llmSummary: { targetTokens: 1000, reasoning: { mode: 'provider_default' } }, createdAt: 1, updatedAt: 1 },
    settingsSnapshot: { providerConfigId: `${provider}-channel`, provider, modelId: model },
    systemInstruction: { role: 'user', parts: [{ text: SYSTEM }] },
    tools: TOOLS,
    nativeGenerationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
    contents: [
      INPUT,
      { role: 'model', parts: [{ text: 'Reading.' }, call('call_01', 'a.txt')] },
      { role: 'user', parts: [{ id: 'call_01', functionResponse: { name: 'read', response: { ok: true, text: 'alpha' } } }] },
      { role: 'model', parts: [{ text: 'Done.' }] }
    ]
  };
}
const fingerprint = (call) => sha256({ url: call.url, headers: call.headers, body: JSON.parse(call.bodyText) });
const dryRunCompact = (request, settings) => dryRunCompactLlmProvider(request, { settings: async () => settings, compressionSettings: async () => undefined });

test('OpenAI Responses /responses/compact 与摘要类压缩的请求字节不变；Gemini 仍然没有原生压缩适配器', async () => {
  const openai = await dryRunCompact(handcraftedCompactRequest('openai-responses', 'gpt-5.5', 'provider_native'),
    settingsFor({ provider: 'openai-responses', model: 'gpt-5.5', baseUrl: 'https://api.openai.com/v1' }));
  assert.equal(openai.calls.length, 1);
  assert.match(openai.calls[0].url, /\/responses\/compact$/);
  assert.equal(fingerprint(openai.calls[0]), UNCHANGED_BASELINE.openaiResponsesNative);

  const summary = await dryRunCompact(handcraftedCompactRequest('claude', MODEL_ID, 'llm_summary'), settingsFor());
  assert.equal(summary.calls.length, 1);
  assert.equal(fingerprint(summary.calls[0]), UNCHANGED_BASELINE.claudeLlmSummary);

  await assert.rejects(
    dryRunCompact(handcraftedCompactRequest('gemini', 'gemini-3.5-flash', 'provider_native'),
      settingsFor({ provider: 'gemini', model: 'gemini-3.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' })),
    (error) => error.code === 'PROVIDER_CAPABILITY_MISMATCH' && /gemini 渠道没有可用的 Provider 原生压缩适配器/.test(error.message)
  );
});
