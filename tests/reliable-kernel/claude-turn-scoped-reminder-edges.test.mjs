/**
 * Claude turn-scoped reminders: the two edges the first version left open.
 *
 * (a) A request that re-injects the current Turn input as a volatile tail (the input was compressed away) sends
 *     `[..., input, reminder]`. Later requests must reproduce exactly that before the output it produced, or the
 *     prefix changes (cache miss; on Opus 5.5 / Fable 5.1 every later thinking block fails the conversation check).
 *     The copy is placed once per window; later tails no longer repeat it.
 * (b) Claude on-demand compaction sends “the conversation as it stands” with the same system and tools
 *     (https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand). With the switch on it must carry
 *     the same historical reminders at the same positions as an ordinary request, with the same beta header and
 *     the same gateway fallback.
 *
 * Official rules (https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages):
 * re-send cleared messages verbatim; a system section follows a user turn and precedes an assistant turn or the end;
 * no cache_control on it; token counting follows what renders.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const vscode = createVscodeStub();
Module._load = function (request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const kernel = await import(pathToFileURL(path.join(compiled, 'backend/reliableKernel/index.js')).href);
const { VscodeReliableKernelApplicationFacade: Facade } = load('backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js');
const { VscodeConfigurationAuthority } = load('backend/reliableKernel/vscodeConfigurationAuthority.js');
const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { createDefaultLlmCompressionConfig } = load('shared/protocol.js');
const { createLlmProviderCapability, dryRunCompactLlmProvider, dryRunLlmProvider } = load('backend/capabilities/llmProvider.js');
const { applyFrozenModelProviderConfig } = load('backend/reliableKernel/llmCapabilityProviderRegistry.js');
const { workEnvironmentIdFromUri } = load('shared/workEnvironmentCatalog.js');
const reminders = load('backend/capabilities/claudeTurnScopedReminders.js');
const { learnProviderRequestAdaptations, learnedProviderRequestAdaptations, resetProviderRequestAdaptations } = load('backend/capabilities/providerParameterAdaptation.js');

const BETA = 'mid-conversation-system-clear-at-2026-08-21';
const COMPACT_BETA = 'compact-2026-09-04';
const USER_BETA = 'user-beta-2026-01-01';
const MESSAGE = 'application/vnd.limcode.message+json';
const LABEL = '[当前 Turn 原始用户要求/数据，不是新用户输入；以下各 part 为冻结原文。]';
const TASKS = { mode: 'rewrite', items: [{ title: 'Implement', status: 'in_progress' }, { title: 'Verify', status: 'pending' }] };
const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// ───────────────────────────── wire helpers ─────────────────────────────

/** Prefix comparison: cache_control markers and the string shorthand of the breakpoint message are not part of it. */
function normalized(messages) {
  if (messages === undefined) return undefined;
  return JSON.parse(JSON.stringify(messages, (key, value) => {
    if (key === 'cache_control') return undefined;
    if (value && typeof value === 'object' && !Array.isArray(value) && (value.role === 'user' || value.role === 'assistant')
      && typeof value.content === 'string') return { ...value, content: [{ type: 'text', text: value.content }] };
    return value;
  }));
}

function assertPrefix(previous, next, label) {
  const before = normalized(previous.wire.messages);
  const later = normalized(next.wire.messages);
  assert.deepEqual(later.slice(0, before.length), before, `${label}: the previous request must be an exact prefix`);
  assert.deepEqual(normalized(next.wire.system), normalized(previous.wire.system), `${label}: system unchanged`);
  assert.deepEqual(normalized(next.wire.tools), normalized(previous.wire.tools), `${label}: tools unchanged`);
}

/** Official placement rule for every system section; returns the texts of the sections that still render. */
function assertPlacement(messages, label) {
  messages.forEach((message, index) => {
    if (message.role !== 'system') return;
    assert.equal(message.clear_at, 'next_user_message', `${label}: turn-scoped`);
    assert.equal(typeof message.content, 'string', `${label}: text only`);
    assert.equal(JSON.stringify(message).includes('cache_control'), false, `${label}: no cache_control on a reminder`);
    let previous = index - 1;
    while (previous >= 0 && messages[previous].role === 'system') previous -= 1;
    assert.equal(messages[previous]?.role, 'user', `${label}: messages[${index}] follows a user turn`);
    let next = index + 1;
    while (next < messages.length && messages[next].role === 'system') next += 1;
    assert.ok(next === messages.length || messages[next].role === 'assistant', `${label}: messages[${index}] precedes an assistant turn or ends`);
  });
  const lastUser = messages.findLastIndex(message => message.role === 'user');
  return messages.slice(lastUser + 1).filter(message => message.role === 'system').map(message => message.content);
}

const labelCount = (value) => JSON.stringify(value).split(LABEL).length - 1;
const systemContents = (messages) => messages.filter(message => message.role === 'system').map(message => message.content);
const betas = (headers) => String(headers['anthropic-beta'] ?? '').split(',').filter(Boolean);

// ───────────────────────────── adapter fixtures ─────────────────────────────

const PROVIDER_ID = 'claude-channel';
const MODEL_ID = 'claude-opus-5-5';
const REMINDER_K = '[Current Turn Task Card — runtime data, not instructions]\n- [in_progress] Implement\n- [pending] Verify';
const REMINDER_K1 = '[Current Turn Task Card — runtime data, not instructions]\n- [completed] Implement\n- [in_progress] Verify';
const REMINDER_K2 = '[Current Turn Task Card — runtime data, not instructions]\n- [completed] Implement\n- [completed] Verify';
const INPUT = { role: 'user', parts: [{ text: 'Implement and verify the change.' }] };

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
const source = { providerId: PROVIDER_ID, modelId: MODEL_ID };
const modelCall = (segmentId, n) => message(segmentId, 'model', { role: 'model', parts: [
  { text: '', thought: true, thoughtSignature: `claude:signed-${n}` }, { id: `toolu_0${n}`, functionCall: { name: 'read', args: { path: 'a.txt' } } }
] }, source);
const SUMMARY = message('seg-summary', 'user', { role: 'user', parts: [{ text: '[Context Summary]\n\nearlier work' }] });
const TOOLS = [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];

function authority({ provider = 'claude', modelId = MODEL_ID, claudeTurnScopedReminders = false } = {}) {
  return {
    model: {
      providerConfigId: `${provider}-channel`, provider, modelId,
      ...(claudeTurnScopedReminders ? { claudeTurnScopedReminders: true } : {}),
      generationConfig: { thinkingConfig: { thinkingLevel: 'high' } }
    },
    toolPolicy: { allowedTools: ['read'], preset: 'custom', sourceConfigs: {} },
    systemPrompt: { text: 'You are a careful coding agent.' }
  };
}

function ordinaryRequest({ provider = 'claude', modelId = MODEL_ID, claudeTurnScopedReminders = false, context, reminder, history,
  reinject = true, input = INPUT, attachmentCatalogState = { catalog: [], placements: [] }, modelHandleCatalog }) {
  return {
    kind: 'full-model-request', modelRequestId: `model-request-${context.length}`, conversationId: 'conversation-edges',
    attemptSeq: '1', socketGeneration: '1', providerId: `${provider}-channel`, modelId,
    authoritySnapshot: authority({ provider, modelId, claudeTurnScopedReminders }),
    recipe: { kind: 'reliable-agent-turn', round: String(context.length), tools: TOOLS, ...(modelHandleCatalog ? { modelHandleCatalog } : {}) },
    context, attachmentCatalogState,
    requestAddenda: {
      currentTurnInput: {
        messageId: 'message-current', messageRevisionId: 'revision-current', contentObjectId: 'content-current',
        reinject, contentType: MESSAGE, content: JSON.stringify(input)
      },
      ...(reminder ? { turnReminder: { content: reminder, unfinishedTaskCount: 1, activeChildCount: 0, runningProcessCount: 0 } } : {}),
      ...(history ? { turnReminderHistory: history } : {})
    }
  };
}

function settingsFor(provider = 'claude', modelId = MODEL_ID, baseUrl = 'https://example.invalid/v1', id = `${provider}-channel`) {
  return {
    id, name: provider, provider, baseUrl, model: modelId, models: [{ id: modelId, name: modelId }], apiKey: '',
    toolCallFormat: 'function-call', openaiResponsesTransport: 'http', stream: true, retryOnError: false, retryMaxAttempts: 0,
    retryDelaySeconds: 0, enableMultimodalTools: true, systemPromptPrefix: '', contextWindowTokens: 200000,
    promptCache: provider === 'claude' ? { enabled: true, mode: 'explicit', ttl: '1h' } : { enabled: true, mode: 'key', ttl: '30m' },
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

async function render(request, settings = settingsFor(request.authoritySnapshot.model.provider, request.modelId)) {
  const capture = {};
  const adapter = new kernel.LlmCapabilityFullRequestAdapter(request.providerId, fakeCapability(capture));
  await adapter.sendFullRequest(request, { onEvent: async () => ({ accepted: true, checkpointed: true, terminal: false }) });
  const estimate = adapter.estimateFullRequestInput(request);
  const wire = await dryRunLlmProvider(capture.start, { settings });
  return { start: capture.start, estimate, url: wire.url, headers: wire.headers, wire: wire.body, messages: wire.body.messages };
}

/** The same request as the capability sends it after the gateway rejected turn-scoped system messages. */
async function renderTail(rendered, settings = settingsFor()) {
  const { claudeTurnScopedReminders: _switch, ...snapshot } = rendered.start.settingsSnapshot;
  return (await dryRunLlmProvider({ ...rendered.start, settingsSnapshot: snapshot }, { settings })).body;
}

function compactionRequest({ claudeTurnScopedReminders = false, context, history, compressionProvider = 'claude', compressionModel = MODEL_ID }) {
  const base = ordinaryRequest({ claudeTurnScopedReminders, context, history, reinject: false });
  return {
    ...base,
    modelRequestId: 'compaction-request',
    providerId: `${compressionProvider}-channel`,
    modelId: compressionModel,
    authoritySnapshot: {
      ...base.authoritySnapshot,
      compression: {
        enabled: true, methodKind: 'provider_native',
        config: { id: 'native', name: 'Native', kind: 'provider_native', trigger: { mode: 'manual' } },
        provider: { providerConfigId: `${compressionProvider}-channel`, provider: compressionProvider, modelId: compressionModel,
          contextWindowTokens: 200000, maxOutputTokens: 16000 }
      }
    },
    recipe: { kind: 'reliable-context-compression', sourceRootId: 'root', sourceSegmentCount: context.length, blockId: 'block',
      compressionMethodKind: 'provider_native', sourceHash: 'hash', tools: TOOLS },
    requestAddenda: history ? { turnReminderHistory: history } : undefined
  };
}

async function renderCompaction(request, settings = settingsFor(request.authoritySnapshot.compression.provider.provider, request.modelId)) {
  const capture = {};
  const adapter = new kernel.LlmCapabilityFullRequestAdapter(request.providerId, fakeCapability(capture));
  await adapter.sendFullRequest(request, { onEvent: async () => ({ accepted: true, checkpointed: true, terminal: false }) });
  const estimate = adapter.estimateFullRequestInput(request);
  const dry = await dryRunCompactLlmProvider(capture.compact, { settings, compressionSettings: async () => undefined });
  const call = dry.calls[0];
  return { compact: capture.compact, estimate, call, body: JSON.parse(call.bodyText), headers: call.headers };
}

// ─────────────────── (a) re-injected current Turn input: adapter + wire ───────────────────

/**
 * After a compression that removed the Turn input: request k re-injects it, k+1 and k+2 follow. The history the
 * control plane materializes carries the input only on the first reinjecting request's output (it is then in the window).
 */
function reinjectionRounds(options = {}) {
  const k = [SUMMARY];
  const k1 = [SUMMARY, modelCall('seg-model-k', 1), toolPair('seg-result-k', 'toolu_01', { ok: true, text: 'alpha' })];
  const k2 = [...k1, modelCall('seg-model-k1', 2), toolPair('seg-result-k1', 'toolu_02', { ok: true, text: 'beta' })];
  const input = options.input ?? INPUT;
  const reinjectedInput = { messageRevisionId: 'revision-current', contentType: MESSAGE, content: JSON.stringify(input) };
  const common = { claudeTurnScopedReminders: options.claudeTurnScopedReminders ?? true, input, ...options.request };
  return [
    ordinaryRequest({ ...common, context: k, reminder: REMINDER_K }),
    ordinaryRequest({ ...common, context: k1, reminder: REMINDER_K1,
      history: [{ segmentId: 'seg-model-k', content: REMINDER_K, reinjectedInput }] }),
    ordinaryRequest({ ...common, context: k2, reminder: REMINDER_K2,
      history: [{ segmentId: 'seg-model-k', content: REMINDER_K, reinjectedInput }, { segmentId: 'seg-model-k1', content: REMINDER_K1 }] })
  ];
}

test('(a) 重新注入输入的请求之后：后续请求逐字节重现那次发出的输入与提醒，输入在窗口里只出现一次', async () => {
  const [k, k1, k2] = await Promise.all(reinjectionRounds().map((request) => render(request)));
  assertPrefix(k, k1, 'k → k+1');
  assertPrefix(k1, k2, 'k+1 → k+2');
  assert.deepEqual(k.messages.map((entry) => entry.role), ['user', 'user', 'system']);
  assert.deepEqual(k1.messages.map((entry) => entry.role), ['user', 'user', 'system', 'assistant', 'user', 'system']);
  assert.deepEqual(k2.messages.map((entry) => entry.role),
    ['user', 'user', 'system', 'assistant', 'user', 'system', 'assistant', 'user', 'system']);
  for (const [label, entry] of [['k', k], ['k+1', k1], ['k+2', k2]]) {
    assert.equal(labelCount(entry.messages), 1, `${label}: the input is in the window exactly once`);
    assert.deepEqual(assertPlacement(entry.messages, label), [entry === k ? REMINDER_K : entry === k1 ? REMINDER_K1 : REMINDER_K2]);
  }
  assert.deepEqual(systemContents(k2.messages), [REMINDER_K, REMINDER_K1, REMINDER_K2], 'every reminder stays at its position');
  // Planning estimate: the placed copy is ordinary context, the superseded tail is not sent, cleared reminders cost nothing.
  assert.equal(k1.estimate.currentInputTokens, 0);
  assert.ok(k1.estimate.contextTokens > k.estimate.contextTokens + k.estimate.currentInputTokens - 1);
});

test('(a) 网关回退与其他 provider：尾巴模式与开关关闭逐字节相同，历史副本不以任何形式发出', async () => {
  const on = reinjectionRounds();
  const off = reinjectionRounds({ claudeTurnScopedReminders: false });
  for (const index of [1, 2]) {
    const rendered = await render(on[index]);
    const disabled = await render(off[index]);
    assert.deepEqual(await renderTail(rendered), disabled.wire, `request ${index}: tail fallback equals switch off`);
    assert.equal(labelCount(disabled.messages), 1);
    assert.equal(JSON.stringify(disabled.start).includes('turnReminder'), false);
  }
  for (const [provider, modelId] of [['openai-compatible', 'gpt-5.5'], ['gemini', 'gemini-3.5-flash'], ['openai-responses', 'gpt-5.5'], ['openai-compatible', 'deepseek-v4-flash']]) {
    const request = (claudeTurnScopedReminders) => reinjectionRounds({ claudeTurnScopedReminders, request: { provider, modelId } })[1];
    const withSwitch = await render(request(true));
    const without = await render(request(false));
    assert.equal(JSON.stringify(withSwitch), JSON.stringify(without), `${provider}: the switch changes nothing`);
    assert.equal(JSON.stringify(withSwitch.start).includes('turnReminder'), false);
  }
});

test('(a) 网关回退后估算按实际发出的尾巴布局：与开关关闭时相同，不再计入不会发出的历史副本', async () => {
  resetProviderRequestAdaptations();
  try {
    const [, k1] = reinjectionRounds();
    const off = await render(reinjectionRounds({ claudeTurnScopedReminders: false })[1]);
    const turnScoped = await render(k1);
    assert.notDeepEqual(turnScoped.estimate, off.estimate, 'turn-scoped: the history copy of the input is sent and counted');
    // 这个渠道与模型的网关拒绝过轮内系统消息：之后按尾巴模式发送，估算也按尾巴模式。
    learnProviderRequestAdaptations(
      { providerConfigId: PROVIDER_ID, provider: 'claude', baseUrl: 'https://example.invalid/v1', model: MODEL_ID, configRevision: 1 },
      { status: 400, rawBody: { type: 'error', error: { type: 'invalid_request_error', message: 'messages.3.clear_at: Extra inputs are not permitted' } } },
      { claudeTurnScopedReminders: true }
    );
    const fallenBack = await render(k1);
    assert.deepEqual(fallenBack.estimate, off.estimate);
    assert.deepEqual(await renderTail(fallenBack), off.wire, 'and the wire is the switch-off request');
  } finally {
    resetProviderRequestAdaptations();
  }
});

test('(a) 轮内系统消息模式不挪断点：尾巴输入已有历史副本、本轮没有提醒时，断点仍在最后一条 user 消息', async () => {
  const [, k1] = reinjectionRounds();
  const request = { ...k1, requestAddenda: { ...k1.requestAddenda, turnReminder: undefined } };
  const rendered = await render(request);
  const messages = rendered.messages;
  assert.equal(labelCount(messages.at(-1)), 0, 'the tail copy of the input is not sent');
  const marked = messages.flatMap((entry, index) =>
    Array.isArray(entry.content) && entry.content.some((block) => block.cache_control) ? [index] : []);
  assert.deepEqual(marked, [messages.findLastIndex((entry) => entry.role === 'user')],
    'nothing volatile is at the end, so the breakpoint stays on the last user message');
});

test('(a) 托管媒体：历史副本按那次请求的位置投影，其余内容与开关关闭时完全相同', async () => {
  const image = { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=', attachmentId: 'attachment-1', name: 'a.png', sizeBytes: 8 } };
  const input = { role: 'user', parts: [{ text: 'Implement what the screenshot shows.' }, image] };
  // The same attachment was already shown before the reinjection (kept tail) and is shown again afterwards.
  const earlier = message('seg-earlier', 'user', { role: 'user', parts: [{ text: 'earlier upload' }, image] });
  const later = message('seg-later', 'user', { role: 'user', parts: [{ text: 'the same file again' }, image] });
  const reinjectedInput = { messageRevisionId: 'revision-current', contentType: MESSAGE, content: JSON.stringify(input) };
  const k = ordinaryRequest({ claudeTurnScopedReminders: true, input, context: [SUMMARY, earlier], reminder: REMINDER_K });
  const nextContext = [SUMMARY, earlier, modelCall('seg-model-k', 1), toolPair('seg-result-k', 'toolu_01', { ok: true }), later];
  const k1 = ordinaryRequest({ claudeTurnScopedReminders: true, input, context: nextContext, reminder: REMINDER_K1,
    history: [{ segmentId: 'seg-model-k', content: REMINDER_K, reinjectedInput }] });
  const startK = (await render(k)).start;
  const startK1 = (await render(k1)).start;
  const tailOf = (start) => start.contents.find((content) => content.turnReminder === undefined && content.parts[0]?.text === LABEL);
  const placed = startK1.contents.find((content) => content.turnReminder?.placement === 'history' && content.turnReminder.kind === 'reinjected_input');
  assert.deepEqual(placed.parts, tailOf(startK).parts, 'the placed copy is exactly the tail request k sent (its media body suppressed as a repeat)');
  assert.match(JSON.stringify(placed.parts), /repeated_managed_media_body_omitted/);
  // Everything else is projected exactly as without the copy: the tail fallback equals the switch-off request.
  const off = (await render(ordinaryRequest({ input, context: nextContext, reminder: REMINDER_K1 }))).start;
  assert.deepEqual(reminders.layoutTurnReminderContents(startK1.contents, 'tail'), off.contents);
});

test('(a) 发送形态：历史副本在轮内系统消息模式下作为 user 消息发送，尾巴副本只在尾巴模式发送', () => {
  const user = { role: 'user', parts: [{ text: 'u' }] };
  const model = { role: 'model', parts: [{ text: 'm' }] };
  const placedInput = reminders.markedReinjectedInput({ role: 'user', parts: [{ text: 'input' }] }, 'history');
  const history = reminders.turnReminderContent('h', { placement: 'history' });
  const tailInput = reminders.markedReinjectedInput({ role: 'user', parts: [{ text: 'input' }] }, 'current');
  const current = reminders.turnReminderContent('c', { placement: 'current' });
  const afterModel = reminders.turnReminderContent('after-model', { placement: 'history' });
  const contents = [user, placedInput, history, model, user, model, afterModel, model, tailInput, current];
  assert.deepEqual(reminders.turnReminderDeliveries(contents, 'claude_turn_scoped'),
    [undefined, 'user', 'system', undefined, undefined, undefined, 'user', undefined, 'omitted', 'user']);
  assert.deepEqual(reminders.turnReminderDeliveries(contents, 'tail'),
    [undefined, 'omitted', 'omitted', undefined, undefined, undefined, 'omitted', undefined, 'user', 'user']);
  assert.deepEqual(reminders.layoutTurnReminderContents(contents, 'tail'),
    [user, model, user, model, model, { role: 'user', parts: [{ text: 'input' }] }, { role: 'user', parts: [{ text: 'c' }] }]);
});

// ─────────────────── (b) Claude native compaction: adapter + wire ───────────────────

function toolLoop() {
  return [
    message('seg-user', 'user', INPUT),
    modelCall('seg-model-1', 1),
    toolPair('seg-result-1', 'toolu_01', { ok: true, text: 'alpha' }),
    modelCall('seg-model-2', 2),
    toolPair('seg-result-2', 'toolu_02', { ok: true, text: 'beta' })
  ];
}
const LOOP_HISTORY = [{ segmentId: 'seg-model-1', content: REMINDER_K }, { segmentId: 'seg-model-2', content: REMINDER_K1 }];

/**
 * sha256(JSON.stringify(...)) of the LlmCompactRequest and the dry-run {url, headers, body} of this Claude native
 * compaction with the switch off (and switch on with a compaction target that is not the conversation's own
 * channel/model). `compact` is what the pre-change build (codex/agent-collaboration e66a79da) produced. `wire` was
 * re-pinned when the Claude compaction request started to be encoded like ordinary requests
 * (claude-native-compaction-shaping.test.mjs): stored tool ids instead of `toolu_0`/`toolu_1`, the real tool
 * definitions instead of `tools: []`, and the channel's cache breakpoints (system in block form); nothing else changed.
 * `compact` re-pinned once more when the compaction settings snapshot started to carry the turn's frozen
 * systemPromptPrefix (same channel and model); the wire is unchanged.
 */
const COMPACTION_BASELINE = {
  compact: '7d527234ab5402ab3cc3596187ae4ee3fb390531e1bb3e5f7d1f0ad5b114789c',
  wire: 'bccd0de636d8ae778f64c6b42e5dc0c4175b8e60450d398f86d8296ca9f476a8'
};
const compactionFingerprint = (rendered) => ({
  compact: sha256(rendered.compact),
  wire: sha256({ url: rendered.call.url, headers: rendered.headers, body: rendered.body })
});

test('(b) Claude 原生压缩：关闭时与改动前逐字节相同；换了压缩模型时同样不带提醒', async () => {
  const off = await renderCompaction(compactionRequest({ context: toolLoop(), history: LOOP_HISTORY }));
  assert.deepEqual(compactionFingerprint(off), COMPACTION_BASELINE);
  assert.equal(off.body.messages.some((entry) => entry.role === 'system'), false);
  assert.deepEqual(betas(off.headers), [USER_BETA, COMPACT_BETA]);
  // Switch on, but compaction runs on another model: its prefix differs anyway, and the switch was frozen for the
  // conversation's own channel only.
  const otherModel = compactionRequest({ claudeTurnScopedReminders: true, context: toolLoop(), history: LOOP_HISTORY, compressionModel: 'claude-sonnet-5' });
  const other = await renderCompaction(otherModel, { ...settingsFor('claude', 'claude-sonnet-5'), models: [{ id: 'claude-sonnet-5', name: 'Sonnet' }] });
  assert.equal(other.body.messages.some((entry) => entry.role === 'system'), false);
  assert.equal(JSON.stringify(other.compact).includes('turnReminder'), false);
  assert.equal(other.compact.settingsSnapshot.claudeTurnScopedReminders, undefined);
});

test('(b) Claude 原生压缩：打开后历史提醒与普通请求同位置、同放置规则、同 beta 头；清除的提醒不计 token', async () => {
  const context = toolLoop();
  const ordinary = await render(ordinaryRequest({ claudeTurnScopedReminders: true, context, reminder: REMINDER_K2, history: LOOP_HISTORY, reinject: false }));
  const compaction = await renderCompaction(compactionRequest({ claudeTurnScopedReminders: true, context, history: LOOP_HISTORY }));
  // The compaction request is the ordinary request without its volatile tail (the current reminder).
  assert.equal(ordinary.messages.at(-1).role, 'system');
  assert.deepEqual(normalized(compaction.body.messages), normalized(ordinary.messages.slice(0, -1)));
  assert.deepEqual(compaction.body.messages.map((entry) => entry.role), ['user', 'system', 'assistant', 'user', 'system', 'assistant', 'user']);
  assert.deepEqual(systemContents(compaction.body.messages), [REMINDER_K, REMINDER_K1]);
  assertPlacement(compaction.body.messages, 'compaction');
  assert.deepEqual(betas(compaction.headers), [USER_BETA, BETA, COMPACT_BETA]);
  assert.equal(compaction.body.compaction.type, 'summarize');
  assert.equal(compaction.compact.settingsSnapshot.claudeTurnScopedReminders, true);
  // Cleared reminders cost nothing in the compaction planning estimate.
  const withoutHistory = await renderCompaction(compactionRequest({ claudeTurnScopedReminders: true, context }));
  assert.deepEqual(compaction.estimate, withoutHistory.estimate);
});

test('(b) Claude 原生压缩：窗口里重新注入过的输入同样放回原位', async () => {
  const context = [SUMMARY, modelCall('seg-model-k', 1), toolPair('seg-result-k', 'toolu_01', { ok: true, text: 'alpha' })];
  const reinjectedInput = { messageRevisionId: 'revision-current', contentType: MESSAGE, content: JSON.stringify(INPUT) };
  const history = [{ segmentId: 'seg-model-k', content: REMINDER_K, reinjectedInput }];
  const ordinary = await render(ordinaryRequest({ claudeTurnScopedReminders: true, context, reminder: REMINDER_K1, history }));
  const compaction = await renderCompaction(compactionRequest({ claudeTurnScopedReminders: true, context, history }));
  assert.deepEqual(normalized(compaction.body.messages), normalized(ordinary.messages.slice(0, -1)));
  assert.deepEqual(compaction.body.messages.map((entry) => entry.role), ['user', 'user', 'system', 'assistant', 'user']);
  assert.equal(labelCount(compaction.body.messages), 1);
});

const signed = { type: 'compaction', content: 'SUMMARY_MARKER', signature: 'signed-compaction' };
const rejection = (text) => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: text } } });

async function withServer(respond, run) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
    calls.push(call);
    const result = respond(call, calls.length);
    res.writeHead(result.status ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/v1`, calls);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function compact(settings, request) {
  const capability = createLlmProviderCapability({ settings: async () => settings, compressionSettings: async () => undefined });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('compaction timed out')), 10_000);
      capability.compact(request, (event) => {
        if (event.type !== 'llm:compactDone' && event.type !== 'llm:compactError') return;
        clearTimeout(timer);
        resolve(event);
      });
    });
  } finally {
    capability.dispose();
  }
}

test('(b) Claude 原生压缩：网关明确拒绝时立即以尾巴模式重发，并对这个目标记住', async () => {
  resetProviderRequestAdaptations();
  const hasSystem = (body) => body.messages.some((entry) => entry.role === 'system');
  await withServer((call) => hasSystem(call.body)
    ? rejection('messages.1.clear_at: Extra inputs are not permitted')
    : { body: { id: 'msg_c', type: 'message', role: 'assistant', content: [signed], stop_reason: 'compaction', usage: { input_tokens: 0, output_tokens: 0, iterations: [{ input_tokens: 10, output_tokens: 5 }] } } },
  async (baseUrl, calls) => {
    const settings = { ...settingsFor('claude', MODEL_ID, baseUrl), apiKey: 'dummy-test-key', stream: false };
    const { compact: request } = await renderCompaction(compactionRequest({ claudeTurnScopedReminders: true, context: toolLoop(), history: LOOP_HISTORY }), settings);
    const result = await compact(settings, request);
    assert.equal(result.type, 'llm:compactDone', JSON.stringify(result.payload));
    assert.equal(calls.length, 2);
    assert.equal(hasSystem(calls[0].body), true);
    assert.equal(betas(calls[0].headers).includes(BETA), true);
    assert.equal(hasSystem(calls[1].body), false, 'the retry is the old compaction request');
    assert.deepEqual(betas(calls[1].headers), [USER_BETA, COMPACT_BETA]);
    assert.deepEqual(result.payload.result.contents[0].parts[0].providerContext.rawItem, signed);
    assert.equal(learnedProviderRequestAdaptations({ providerConfigId: settings.id, provider: 'claude', baseUrl, model: MODEL_ID, configRevision: settings.updatedAt }).claudeTurnScopedReminders, 'tail');
  });
  resetProviderRequestAdaptations();
});

// ─────────────────── runtime: the real kernel end to end ───────────────────

const FILLER = 'Background requirements for the change, repeated to make the input large. '.repeat(700);
const START = `start-work\n${FILLER}`;
const COMPRESSION_THRESHOLD = 6000;

/** The scripted model: task list, three reads, a final text (the open task forces one completion check). */
function scriptedReply(request, count) {
  const signedThought = { text: '', thought: true, thoughtSignature: `claude:signed-${count}` };
  const round = Number(request.recipe.round);
  const input = request.requestAddenda?.currentTurnInput?.content ?? '';
  if (!input.includes('start-work')) return [signedThought, { text: `reply ${count}` }];
  if (round === 1) return [signedThought, { text: 'Planning.' }, { id: `toolu_task_${count}`, functionCall: { name: 'update_task_list', args: TASKS } }];
  if (round <= 4) return [signedThought, { id: `toolu_read_${count}`, functionCall: { name: 'read', args: { path: 'a.txt' } } }];
  return request.recipe.openTaskCompletionCheck
    ? [signedThought, { text: 'Stopping; Verify is still open.' }]
    : [signedThought, { text: 'Implemented.' }];
}

function compressionConfig(kind) {
  return {
    ...createDefaultLlmCompressionConfig(`${kind} fixture`), id: `compression-${kind}`, kind,
    bodyTargetTokens: 4096, fallbacks: [],
    providerNative: { trustMode: 'trust_configured_endpoint' },
    llmSummary: { targetTokens: 1024, reasoning: { mode: 'provider_default' } },
    trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: COMPRESSION_THRESHOLD }
  };
}

async function withRuntime(run, { claudeTurnScopedReminders = true, compression }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-reminder-edges-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const getPaths = () => createVscodeStoragePaths(vscode.Uri.file(path.join(directory, 'configuration')));
  let configuration = new VscodeConfigurationAuthority(getPaths);
  const claude = {
    ...createDefaultLlmProviderConfig({ name: 'Claude fixture' }), id: 'claude-fixture', provider: 'claude',
    baseUrl: 'https://example.invalid/v1', model: MODEL_ID, models: [{ id: MODEL_ID, name: 'Opus 5.5' }],
    contextWindowTokens: 200000, promptCache: { enabled: true, mode: 'explicit', ttl: '5m' },
    retryOnError: false, retryMaxAttempts: 0, retryDelaySeconds: 0, headers: { 'anthropic-beta': USER_BETA },
    ...(claudeTurnScopedReminders ? { claudeTurnScopedReminders: true } : {})
  };
  const config = compressionConfig(compression);
  const save = async (section, settings) => {
    const current = await configuration.loadGlobalSettings(section);
    await configuration.saveGlobalSettings(section, settings, current.revision);
  };
  await save('llmProviderConfigs', { configs: [claude] });
  await save('llm', { activeProviderConfigId: claude.id });
  await save('llmCompressionConfigs', { configs: [config] });
  await save('llmCompression', { defaultConfigId: config.id, providerBindings: [], modelBindings: [] });
  const setCompressionTrigger = (mode) => save('llmCompressionConfigs', { configs: [{ ...config, trigger: { ...config.trigger, mode } }] });
  await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['read', 'update_task_list'] });
  const agent = await configuration.mutations.createAgent({ name: 'Reminder edges fixture', kind: 'custom' });
  const folderPath = path.join(directory, 'workspace');
  await fs.mkdir(folderPath);
  const uri = vscode.Uri.file(folderPath).toString();
  await configuration.synchronizeWorkspaceFolders([{ uri, name: 'Fixture', rootPath: folderPath, index: 0 }]);
  await configuration.mutations.selectConversationWorkEnvironment('source', workEnvironmentIdFromUri(uri));
  const requests = [];
  const compactions = [];
  let toolCount = 0;
  let app;
  const providerSettings = async (providerId, modelId) =>
    ({ ...applyFrozenModelProviderConfig(await configuration.providerConfig(providerId), modelId), apiKey: '' });
  let facade;
  const open = async () => {
    configuration = new VscodeConfigurationAuthority(getPaths);
    await configuration.synchronizeWorkspaceFolders([{ uri, name: 'Fixture', rootPath: folderPath, index: 0 }]);
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: configuration, compressionSettingsAuthority: configuration, attachmentSettings: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('no MCP'); } },
      mcpPolicyGate: { async authorize() { assert.fail('no MCP'); } },
      providers: { resolve(providerId) {
        return { providerId, async sendFullRequest(request, controls) {
          if (request.recipe.kind === 'reliable-context-compression') {
            // One compression is enough: the rest of the Turn runs on the compressed window.
            await setCompressionTrigger('manual');
            if (request.recipe.compressionMethodKind !== 'provider_native') {
              await controls.onEvent({ kind: 'completed', streamSeq: '1', content: {
                type: 'compression_result', contents: [{ role: 'user', parts: [{ text: 'Synthetic summary of the earlier work.' }] }]
              } });
              compactions.push({ request });
              return;
            }
            let compactRequest;
            const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
              compact(input, emit) {
                compactRequest = structuredClone(input);
                emit({ type: 'llm:compactDone', payload: { requestId: input.id, result: {
                  id: 'msg_compaction', object: 'message',
                  contents: [{ role: 'model', parts: [{ providerContext: {
                    provider: 'anthropic', format: 'claude', endpoint: '/v1/messages', itemType: 'compaction', rawItem: signed
                  } }] }]
                } } });
              },
              start() { assert.fail('compaction only'); }, abort() {}, cancelRetry() {}, dispose() {}
            });
            await adapter.sendFullRequest(request, controls);
            const dry = await dryRunCompactLlmProvider(compactRequest, {
              settings: await providerSettings(providerId, request.modelId), compressionSettings: async () => undefined
            });
            compactions.push({ request, compact: compactRequest, wire: JSON.parse(dry.calls[0].bodyText), headers: dry.calls[0].headers });
            return;
          }
          let start;
          const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
            start(input, emit) { start = structuredClone(input); emit({ type: 'llm:done', payload: { requestId: input.id } }); },
            abort() {}, cancelRetry() {}, dispose() {}
          });
          await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, checkpointed: true, terminal: false }; } });
          const dryRun = await dryRunLlmProvider(start, { settings: await providerSettings(providerId, request.modelId) });
          const entry = { request, start, wire: dryRun.body, headers: dryRun.headers, afterCompression: compactions.length };
          requests.push(entry);
          await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: scriptedReply(request, requests.length) } });
        } };
      } },
      toolDispatcher: {
        definitions() {
          return [
            { name: 'update_task_list', description: 'Synthetic task list', parameters: { type: 'object' } },
            { name: 'read', description: 'Synthetic read', parameters: { type: 'object' } }
          ];
        },
        async dispatch(input) {
          // After the second tool call the window is over the threshold: the next round compresses it, Turn input included.
          if (++toolCount === 2) await setCompressionTrigger('token_threshold');
          const settled = await app.runtime.effects.settleWithoutEffect({
            source: { kind: 'internal', key: `fixture:${input.toolCallId}` },
            toolCallId: input.toolCallId, status: 'succeeded',
            detail: input.toolName === 'update_task_list'
              ? { kind: 'task-list', operation: { kind: 'task_list.operation', ...TASKS } }
              : { text: 'alpha' }
          });
          return settled.terminal ?? app.runtime.effects.readTerminalResult(input.toolCallId, true);
        }
      }
    });
    facade = Object.create(Facade.prototype);
    facade.product = { application: app, configuration };
    facade.historyEntries = [];
    facade.refreshConversationHistory = async () => {};
  };
  try {
    await open();
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'source', title: 'Source', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: 'source-agent', conversation_id: 'source', agent_id: agent.id, role: 'default', created_at: now, updated_at: now
      })
    ]);
    const rows = async (domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
      where, orderBy: { column: 'id', direction: 'asc' }, limit: 200
    }))).snapshot;
    await run({
      requests, compactions,
      get facade() { return facade; },
      async reopen() { await app.close(); await open(); },
      async lastMessage(conversationId, role) {
        const memberships = await rows('MessagePartOfConversation', { conversation_id: conversationId });
        for (const member of memberships.sort((left, right) => Number(right.message_seq - left.message_seq))) {
          const [current] = await rows('MessageCurrentRevisionLink', { message_id: member.message_id });
          const [revision] = await rows('MessageRevision', { id: current.revision_id });
          if (revision.role === role) return { sourceConversationId: conversationId, messageId: member.message_id, expectedRevisionId: revision.id };
        }
        assert.fail('no such message');
      },
      async turn(text, conversationId = 'source') {
        const input = await app.turns.input({
          source: { kind: 'command', key: `${conversationId}:${requests.length}:${text.slice(0, 16)}` }, conversationId,
          leaseOwnerId: 'reminder-edges-owner', hostBootId: app.database.hostBootId,
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), content: text
        });
        const [lease] = await rows('ExecutionLease', { turn_id: input.turnId });
        const result = await kernel.runWithExecutionLeaseFence({
          id: lease.id, conversationId, turnId: input.turnId, ownerId: lease.owner_id,
          hostBootId: lease.host_boot_id, generation: BigInt(lease.generation)
        }, () => app.agentLoop.drive(input.turnId)).catch(error => ({ terminalStatus: 'failed', error }));
        assert.equal(result.terminalStatus, 'completed',
          JSON.stringify({ result: String(result.error?.stack ?? result.error ?? ''), termination: await rows('TurnTermination', { turn_id: input.turnId }) }));
      }
    });
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('(a) 真实内核：Turn 中途压缩掉输入并重新注入后，每次请求都是下一次的前缀，输入只出现一次', { timeout: 180_000 }, async () => {
  await withRuntime(async h => {
    await h.turn(START);
    assert.equal(h.compactions.length, 1, 'one compression inside the Turn');
    const reinjecting = h.requests.filter(entry => entry.request.requestAddenda?.currentTurnInput?.reinject);
    assert.ok(reinjecting.length >= 3, `the rest of the Turn re-injects the compressed input: ${reinjecting.length}`);
    const first = h.requests.indexOf(reinjecting[0]);
    assert.equal(h.requests[first].afterCompression, 1);
    // The first reinjecting request carries the tail: [summary…, input, reminder].
    assert.equal(labelCount(h.requests[first].wire.messages), 1);
    assert.equal(h.requests[first].wire.messages.at(-1).role, 'system');
    await h.turn('second-turn');
    for (let index = first + 1; index < h.requests.length; index += 1) {
      assertPrefix(h.requests[index - 1], h.requests[index], `request ${index} → ${index + 1}`);
      assertPlacement(h.requests[index].wire.messages, `request ${index + 1}`);
      assert.equal(labelCount(h.requests[index].wire.messages), 1, `request ${index + 1}: the input is in the window once`);
      assert.equal(String(h.requests[index].headers['anthropic-beta']).split(',').includes(BETA), true);
    }
    // The reminder of the first reinjecting request is re-sent verbatim right after the input it followed.
    const next = normalized(h.requests[first + 1].wire.messages);
    const at = next.findIndex(entry => JSON.stringify(entry).includes(LABEL));
    assert.equal(next[at + 1].role, 'system');
    assert.equal(next[at + 1].content, h.requests[first].wire.messages.at(-1).content);

    // Restart: only durable facts remain (fresh caches, fresh process-local adaptation state).
    const beforeRestart = h.requests.at(-1);
    await h.reopen();
    await h.turn('after-restart');
    const afterRestart = h.requests.at(-1);
    assertPrefix(beforeRestart, afterRestart, 'after restart');
    assertPlacement(afterRestart.wire.messages, 'after restart');
    assert.equal(labelCount(afterRestart.wire.messages), 1);

    // Fork: the copied rounds share their ModelRequest recipes, so the same input is placed at the same position.
    const fork = await h.facade.forkConversation({ ...(await h.lastMessage('source', 'model')), command: { commandId: 'fork-reminder-edges' } });
    await h.turn('in-fork', fork.conversationId);
    const inFork = h.requests.at(-1);
    assert.equal(inFork.request.conversationId, fork.conversationId);
    assertPrefix(afterRestart, inFork, 'fork');
    assertPlacement(inFork.wire.messages, 'fork');
    assert.equal(labelCount(inFork.wire.messages), 1);
  }, { compression: 'llm_summary' });
});

test('(b) 真实内核：Claude 原生压缩请求带着历史提醒，与上一次普通请求前缀相同；之后仍逐次前缀稳定', { timeout: 180_000 }, async () => {
  await withRuntime(async h => {
    await h.turn(START);
    assert.equal(h.compactions.length, 1);
    const [compaction] = h.compactions;
    assert.equal(compaction.request.recipe.compressionMethodKind, 'provider_native');
    const before = h.requests.filter(entry => entry.afterCompression === 0).at(-1);
    const previous = normalized(before.wire.messages);
    const compacted = normalized(compaction.wire.messages);
    assert.deepEqual(compacted.slice(0, previous.length), previous, 'the last ordinary request is an exact prefix of the compaction request');
    assert.deepEqual(compacted.slice(previous.length).map(entry => entry.role), ['assistant', 'user'], 'plus its output and tool results');
    assert.deepEqual(compaction.wire.system, before.wire.system, 'the same system blocks and breakpoint');
    assert.deepEqual(compaction.wire.tools, before.wire.tools, 'the same tools and breakpoint');
    assert.ok(systemContents(compaction.wire.messages).length >= 1, 'the historical reminders are there');
    assertPlacement(compaction.wire.messages, 'compaction');
    assert.equal(betas(compaction.headers).includes(BETA), true);
    assert.equal(betas(compaction.headers).includes(COMPACT_BETA), true);
    assert.equal(compaction.compact.settingsSnapshot.claudeTurnScopedReminders, true);
    // After the compaction the input is re-injected; from then on every request is the next one's prefix.
    const after = h.requests.filter(entry => entry.afterCompression === 1);
    assert.ok(after.length >= 3);
    for (let index = 1; index < after.length; index += 1) {
      assertPrefix(after[index - 1], after[index], `after compaction ${index}`);
      assertPlacement(after[index].wire.messages, `after compaction ${index + 1}`);
      assert.equal(labelCount(after[index].wire.messages), 1);
    }
  }, { compression: 'provider_native' });
});

test('(b) 真实内核：开关关闭时 Claude 原生压缩请求没有 system 消息，也不带轮内系统消息 beta 头', { timeout: 180_000 }, async () => {
  await withRuntime(async h => {
    await h.turn(START);
    assert.equal(h.compactions.length, 1);
    const [compaction] = h.compactions;
    assert.equal(compaction.wire.messages.some(entry => entry.role === 'system'), false);
    assert.equal(betas(compaction.headers).includes(BETA), false);
    assert.equal(compaction.compact.settingsSnapshot.claudeTurnScopedReminders, undefined);
    assert.equal(JSON.stringify(compaction.compact).includes('turnReminder'), false);
    for (const entry of h.requests) assert.equal(entry.wire.messages.some(message => message.role === 'system'), false);
  }, { compression: 'provider_native', claudeTurnScopedReminders: false });
});

function createVscodeStub() {
  class Uri {
    constructor(fsPath) { this.scheme = 'file'; this.fsPath = path.resolve(fsPath); this.path = this.fsPath.split(path.sep).join('/'); }
    static file(value) { return new Uri(value); }
    static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
    toString() { return `file://${this.path}`; }
  }
  const FileType = { Unknown: 0, File: 1, Directory: 2 };
  return { Uri, FileType, workspace: { fs: {
    async createDirectory(uri) { await fs.mkdir(uri.fsPath, { recursive: true }); },
    async readFile(uri) { return fs.readFile(uri.fsPath); },
    async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
    async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map(entry => [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File]); },
    async delete(uri) { await fs.rm(uri.fsPath, { recursive: true, force: true }); },
    async stat(uri) { const stat = await fs.stat(uri.fsPath); return { type: stat.isDirectory() ? FileType.Directory : FileType.File, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size }; }
  } } };
}
