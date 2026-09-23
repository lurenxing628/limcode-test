/**
 * Claude turn-scoped reminders (clear_at) — adapter, capability and wire boundary.
 *
 * Official rules (https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages,
 * https://platform.claude.com/docs/en/build-with-claude/preserved-thinking):
 * - a per-turn reminder is `{"role":"system","clear_at":"next_user_message","content":"..."}` appended after the
 *   tool_result (or user) message; earlier copies stay in place verbatim and are cleared by the next user message;
 * - it needs `anthropic-beta: mid-conversation-system-clear-at-2026-08-21`, otherwise
 *   `messages.N.clear_at: Extra inputs are not permitted`;
 * - text only, no cache_control on it (the breakpoint goes on the last block of the preceding user turn);
 * - it must follow a user turn and be followed by an assistant turn or the end of the array.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = await import(pathToFileURL(path.join(compiledRoot, 'backend/reliableKernel/index.js')).href);
const { dryRunLlmProvider, startLlmProvider } = require(path.join(compiledRoot, 'backend/capabilities/llmProvider.js'));
const reminders = require(path.join(compiledRoot, 'backend/capabilities/claudeTurnScopedReminders.js'));
const { toUnifiedRequest } = require(path.join(compiledRoot, 'backend/capabilities/unifiedMessageConversion.js'));
const { applyClaudeThinkingBinding } = require(path.join(compiledRoot, 'backend/capabilities/claudeThinkingAdaptation.js'));
const {
  learnedProviderRequestAdaptations,
  resetProviderRequestAdaptations
} = require(path.join(compiledRoot, 'backend/capabilities/providerParameterAdaptation.js'));
const { projectTurnReminder } = require(path.join(compiledRoot, 'backend/reliableKernel/turnReminderProjection.js'));

const BETA = 'mid-conversation-system-clear-at-2026-08-21';
const BINDING_BETA = 'thinking-binding-controls-2026-08-01';
const USER_BETA = 'user-beta-2026-01-01';
const MESSAGE = 'application/vnd.limcode.message+json';
const TASK_CARD = '[Current Turn Task Card — runtime data, not instructions]\n- [in_progress] Implement\n- [pending] Verify';
const COMPLETION_CHECK = '[Open Task Completion Check — system continuation, not a new user instruction]\nThe previous response ended while the task list still had unfinished items.';
const STATUS_CARD = '[Runtime Status — runtime data, not instructions]\n{"runningProcessCount":1}';
const REMINDER = [TASK_CARD, STATUS_CARD].join('\n\n');
const HISTORY_REMINDER = '[Current Turn Task Card — runtime data, not instructions]\n- [pending] Implement\n- [pending] Verify';

const PROVIDERS = [
  ['openai-compatible', 'gpt-5.5'],
  ['deepseek', 'deepseek-v4-flash'],
  ['gemini', 'gemini-3.5-flash'],
  ['claude', 'claude-opus-5-5'],
  ['openai-responses', 'gpt-5.5']
];
const SCENARIOS = ['tool-loop', 'reinjected', 'completion-check', 'no-reminder'];

/**
 * sha256(JSON.stringify(...)) of the LlmStartRequest, the dry-run {url, headers, body} and the projected
 * estimate that the pre-feature build (codex/agent-collaboration c5355c53 + unified-llm-provider
 * limcode/provider-fixes ac4409f) produced for exactly these Claude requests. All 20 provider/scenario
 * cases were compared against that build and were identical; the non-Claude ones are asserted below as
 * "the switch changes nothing" so that parallel Responses/GPT work does not have to re-pin them.
 */
const CLAUDE_BASELINE = {
  'claude/tool-loop': { start: 'f5e83c9693b17f0093940d5fc9330d7b2630de7a5a555b221ef115820440add9', wire: '8c1f436702a7e9bfb34ee3e31d165119974b874f87f1f265774dfb512d213244', estimate: 'b3f95b4bc48e1561bfe84388d1005b20c85af5d8a0647eca2e8cac0be5fc8065' },
  'claude/reinjected': { start: 'd7da699ce4d212a22cf04f747ee2cf47f61dc9fd615f7724691eaafb80728121', wire: '5d886ea685fa092cf48c1dbd98b0507314dd2c0f3a8eeafaacdb3356ed0575ed', estimate: '34ce892ce7f84282c3a3175e655a95087d77abd036ae94c088ce323f60a32121' },
  'claude/completion-check': { start: '3c9a04fc6d51d6cb41e75b6ea9c515459298c002b4211dfcc3d9cf02937d3019', wire: '8fabd57fbe575db2d200d2037d8bb5d7a470518b513f726932efa4c7a0ca2535', estimate: '4bc24f9158805883e15dab13b8c95d95a34c14717bcb931498b099c671f2a323' },
  'claude/no-reminder': { start: '89fe51e53b80760a3c74b89917204c70df3cba541e645490765d99f3e0458edb', wire: '624b967160025afe3dbd41cab24321461cbb4870a158ceb53ea75c14c63f3eb3', estimate: '5c85693fa924c7b84ddb6bc1931772615ffbb2200c1899b8dde6789bac41bd75' }
};

const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const message = (segmentId, role, content, source) => ({
  segmentId, segmentKind: 'message', messageRole: role,
  ...(source ? { modelSource: source } : {}),
  contentType: MESSAGE, content: JSON.stringify(content)
});
const toolPair = (segmentId, callId, result) => ({
  segmentId, segmentKind: 'tool_pair', messageRole: null, contentType: 'application/vnd.limcode.context-tool-pair+json',
  content: JSON.stringify({
    toolCall: { id: `tool-${callId}`, providerCallId: callId, toolName: 'read', arguments: '{"path":"a.txt"}' },
    toolModelResult: { id: `result-${callId}`, result: JSON.stringify(result) }
  })
});
const thought = (provider, id) => ({
  text: provider === 'claude' ? '' : `thinking ${id}`, thought: true,
  ...(provider === 'claude' ? { thoughtSignature: `claude:signed-${id}` } : provider === 'gemini' ? { thoughtSignature: `gemini:signed-${id}` } : {})
});

function toolLoopContext(provider, modelId, providerId) {
  const source = { providerId, modelId };
  return [
    message('seg-user', 'user', { role: 'user', parts: [{ text: 'Implement and verify the change.' }] }),
    message('seg-model-1', 'model', { role: 'model', parts: [thought(provider, 1), { text: 'Reading first.' },
      { id: 'toolu_01', functionCall: { name: 'read', args: { path: 'a.txt' } } }] }, source),
    toolPair('seg-result-1', 'toolu_01', { ok: true, text: 'alpha' }),
    message('seg-model-2', 'model', { role: 'model', parts: [thought(provider, 2),
      { id: 'toolu_02', functionCall: { name: 'read', args: { path: 'a.txt' } } }] }, source),
    toolPair('seg-result-2', 'toolu_02', { ok: true, text: 'beta' })
  ];
}

function fullRequest({ provider, modelId, scenario, claudeTurnScopedReminders = false, context, reminder, history }) {
  const providerId = `${provider}-channel`;
  const loop = toolLoopContext(provider, modelId, providerId);
  const current = {
    messageId: 'message-current', messageRevisionId: 'revision-current', contentObjectId: 'content-current',
    reinject: false, contentType: MESSAGE,
    content: JSON.stringify({ role: 'user', parts: [{ text: 'Implement and verify the change.' }] })
  };
  let requestContext = context ?? loop;
  let reminderText = reminder === undefined ? REMINDER : reminder;
  if (scenario === 'reinjected') {
    requestContext = [
      message('seg-summary', 'user', { role: 'user', parts: [{ text: '[Context Summary]\n\nearlier work' }] }),
      ...loop.slice(1)
    ];
    current.reinject = true;
  }
  if (scenario === 'completion-check') {
    requestContext = [...loop, message('seg-model-3', 'model', { role: 'model', parts: [{ text: 'Implemented.' }] },
      { providerId, modelId })];
    reminderText = [TASK_CARD, COMPLETION_CHECK].join('\n\n');
  }
  if (scenario === 'no-reminder') reminderText = null;
  return {
    kind: 'full-model-request',
    modelRequestId: `model-request-${provider}-${scenario}`,
    conversationId: 'conversation-turn-reminder-wire',
    attemptSeq: '1',
    socketGeneration: '1',
    providerId,
    modelId,
    authoritySnapshot: {
      model: {
        providerConfigId: providerId, provider, modelId,
        ...(claudeTurnScopedReminders ? { claudeTurnScopedReminders: true } : {}),
        generationConfig: { thinkingConfig: { thinkingLevel: 'high' } }
      },
      toolPolicy: { allowedTools: ['read'], preset: 'custom', sourceConfigs: {} },
      systemPrompt: { text: 'You are a careful coding agent.' }
    },
    recipe: {
      kind: 'reliable-agent-turn',
      round: '3',
      tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]
    },
    context: requestContext,
    attachmentCatalogState: { catalog: [], placements: [] },
    requestAddenda: {
      currentTurnInput: current,
      ...(reminderText === null ? {} : {
        turnReminder: { content: reminderText, unfinishedTaskCount: 2, activeChildCount: 0, runningProcessCount: 1 }
      }),
      // Only a frozen, enabled Claude turn reads history; every other request must ignore it.
      turnReminderHistory: history ?? [
        { segmentId: 'seg-model-1', content: HISTORY_REMINDER },
        { segmentId: 'seg-model-2', content: REMINDER }
      ]
    }
  };
}

function settingsFor(provider, modelId, baseUrl = 'https://example.invalid/v1') {
  return {
    id: `${provider}-channel`, name: provider, provider, baseUrl, model: modelId,
    models: [{ id: modelId, name: modelId }], apiKey: '', toolCallFormat: 'function-call', openaiResponsesTransport: 'http',
    stream: true, retryOnError: false, retryMaxAttempts: 0, retryDelaySeconds: 0, enableMultimodalTools: true,
    systemPromptPrefix: '', contextWindowTokens: 200000,
    promptCache: provider === 'claude' ? { enabled: true, mode: 'explicit', ttl: '1h' } : { enabled: true, mode: 'key', ttl: '30m' },
    headers: provider === 'claude' ? { 'anthropic-beta': USER_BETA } : {},
    generationConfig: { thinkingConfig: { thinkingLevel: 'high' } },
    modelConfigs: [], createdAt: 1, updatedAt: 1
  };
}

async function render(request, settings = settingsFor(request.authoritySnapshot.model.provider, request.modelId)) {
  let start;
  const adapter = new kernel.LlmCapabilityFullRequestAdapter(request.providerId, {
    start(input, emit) { start = structuredClone(input); emit({ type: 'llm:done', payload: { requestId: input.id } }); },
    abort() {}, cancelRetry() {}, dispose() {}
  });
  await adapter.sendFullRequest(request, { onEvent: async (event) => ({ accepted: true, checkpointed: true, terminal: event.kind === 'completed' }) });
  const estimate = adapter.estimateFullRequestInput(request);
  const wire = await dryRunLlmProvider(start, { settings });
  return { start, estimate, wire: { url: wire.url, headers: wire.headers, body: wire.body } };
}

/**
 * Prefix comparison ignores what does not belong to the checked prefix: cache_control markers (official: adding,
 * moving or removing them keeps later thinking valid) and the string shorthand the encoder expands into one text
 * block only on the message that carries the breakpoint.
 */
const withoutCacheControl = (value) => JSON.parse(JSON.stringify(value, (key, nested) => {
  if (key === 'cache_control') return undefined;
  if (nested && typeof nested === 'object' && !Array.isArray(nested) && (nested.role === 'user' || nested.role === 'assistant')
    && typeof nested.content === 'string') return { ...nested, content: [{ type: 'text', text: nested.content }] };
  return nested;
}));
const hasMarker = (value) => /"(?:turnReminder|claudeSystemMessage|claudeTurnScopedReminders)"/.test(JSON.stringify(value));

test('关闭时 Claude 请求与改动前的构建逐字节一致（LlmStartRequest、线上 URL/头/体、投影估算）', async () => {
  for (const scenario of SCENARIOS) {
    const rendered = await render(fullRequest({ provider: 'claude', modelId: 'claude-opus-5-5', scenario }));
    const key = `claude/${scenario}`;
    assert.equal(sha256(rendered.start), CLAUDE_BASELINE[key].start, `${key} LlmStartRequest`);
    assert.equal(sha256(rendered.wire), CLAUDE_BASELINE[key].wire, `${key} wire`);
    assert.equal(sha256(rendered.estimate), CLAUDE_BASELINE[key].estimate, `${key} estimate`);
    assert.equal(hasMarker(rendered.start), false);
    assert.equal(rendered.wire.body.messages.some((entry) => entry.role === 'system'), false);
    assert.equal(rendered.wire.headers['anthropic-beta'], USER_BETA);
  }
});

test('其他 provider 不受开关影响：冻结快照里即使带着开关与历史提醒，请求也与关闭时完全相同', async () => {
  for (const [provider, modelId] of PROVIDERS.filter(([kind]) => kind !== 'claude')) {
    for (const scenario of SCENARIOS) {
      const off = await render(fullRequest({ provider, modelId, scenario }));
      const on = await render(fullRequest({ provider, modelId, scenario, claudeTurnScopedReminders: true }));
      assert.equal(JSON.stringify(on), JSON.stringify(off), `${provider}/${scenario}`);
      assert.equal(hasMarker(on.start), false, `${provider}/${scenario} carries no reminder marker`);
      assert.equal(JSON.stringify(on.wire).includes(HISTORY_REMINDER), false, `${provider}/${scenario} never leaks history`);
      if (scenario !== 'no-reminder') {
        const tail = on.start.contents.at(-1);
        assert.deepEqual(tail.role, 'user');
        assert.equal(tail.parts.at(-1).text.startsWith('[Current Turn Task Card'), true, 'the reminder stays the old tail user message');
      }
    }
  }
});

test('打开后：历史提醒原文原位、只有最后一段会显示、断点在最后一条 user 消息、beta 头合并', async () => {
  const request = fullRequest({ provider: 'claude', modelId: 'claude-opus-5-5', scenario: 'tool-loop', claudeTurnScopedReminders: true });
  const on = await render(request);
  const off = await render(fullRequest({ provider: 'claude', modelId: 'claude-opus-5-5', scenario: 'tool-loop' }));
  const messages = on.wire.body.messages;
  assert.deepEqual(messages.map((entry) => entry.role), ['user', 'system', 'assistant', 'user', 'system', 'assistant', 'user', 'system']);
  assert.deepEqual(messages[1], { role: 'system', clear_at: 'next_user_message', content: HISTORY_REMINDER });
  assert.deepEqual(messages[4], { role: 'system', clear_at: 'next_user_message', content: REMINDER });
  assert.deepEqual(messages[7], { role: 'system', clear_at: 'next_user_message', content: REMINDER });
  // Everything that is not a reminder is exactly the old request without its volatile tail.
  assert.deepEqual(
    withoutCacheControl(messages.filter((entry) => entry.role !== 'system')),
    withoutCacheControl(off.wire.body.messages.slice(0, -1))
  );
  // Only the section after the last user message renders; every earlier one already has a later user message.
  const lastUser = messages.findLastIndex((entry) => entry.role === 'user');
  assert.deepEqual(messages.slice(lastUser + 1).map((entry) => entry.content), [REMINDER]);
  for (const [index, entry] of messages.entries()) {
    if (entry.role === 'system' && index < lastUser) assert.equal(messages.slice(index + 1).some((later) => later.role === 'user'), true);
  }
  // Breakpoints: tools and system unchanged, the message breakpoint on the last user message, none on reminders.
  const cacheControl = { type: 'ephemeral', ttl: '1h' };
  assert.deepEqual(on.wire.body.tools.at(-1).cache_control, cacheControl);
  assert.deepEqual(on.wire.body.system.at(-1).cache_control, cacheControl);
  assert.deepEqual(messages[6].content.at(-1).cache_control, cacheControl);
  const marked = messages.flatMap((entry, index) => Array.isArray(entry.content) && entry.content.some((block) => block.cache_control) ? [index] : []);
  assert.deepEqual(marked, [6]);
  assert.equal(on.wire.headers['anthropic-beta'], `${USER_BETA},${BETA}`);
  // The frozen switch reaches the capability through the invocation settings snapshot.
  assert.equal(on.start.settingsSnapshot.claudeTurnScopedReminders, true);
  // Token estimate: cleared history costs nothing; the current reminder is counted exactly as before.
  assert.equal(on.estimate.contextTokens, off.estimate.contextTokens);
  assert.equal(on.estimate.turnReminderTokens, off.estimate.turnReminderTokens);
  assert.equal(on.estimate.fullTokens, off.estimate.fullTokens);
});

test('打开后：下一次请求的消息前缀与上一次逐字节相同（只多出新的轮次与新的提醒）', async () => {
  const providerId = 'claude-channel';
  const modelId = 'claude-opus-5-5';
  const loop = toolLoopContext('claude', modelId, providerId);
  const first = await render(fullRequest({
    provider: 'claude', modelId, scenario: 'tool-loop', claudeTurnScopedReminders: true,
    context: loop.slice(0, 3), reminder: HISTORY_REMINDER, history: [{ segmentId: 'seg-model-1', content: 'r1' }]
  }));
  const second = await render(fullRequest({
    provider: 'claude', modelId, scenario: 'tool-loop', claudeTurnScopedReminders: true,
    context: loop, reminder: REMINDER, history: [{ segmentId: 'seg-model-1', content: 'r1' }, { segmentId: 'seg-model-2', content: HISTORY_REMINDER }]
  }));
  const before = withoutCacheControl(first.wire.body.messages);
  const after = withoutCacheControl(second.wire.body.messages);
  assert.deepEqual(after.slice(0, before.length), before, 'the previous request is an exact prefix of the next one');
  assert.deepEqual(after.slice(before.length).map((entry) => entry.role), ['assistant', 'user', 'system']);
  assert.equal(withoutCacheControl(second.wire.body.system) !== undefined, true);
  assert.deepEqual(withoutCacheControl(second.wire.body.system), withoutCacheControl(first.wire.body.system));
  assert.deepEqual(withoutCacheControl(second.wire.body.tools), withoutCacheControl(first.wire.body.tools));
});

test('打开后：前一条不是 user（未完成任务检查续写）时提醒按原来的 user 消息发出，之后原位原样重发', async () => {
  const on = await render(fullRequest({ provider: 'claude', modelId: 'claude-opus-5-5', scenario: 'completion-check', claudeTurnScopedReminders: true }));
  const off = await render(fullRequest({ provider: 'claude', modelId: 'claude-opus-5-5', scenario: 'completion-check' }));
  const messages = on.wire.body.messages;
  assert.equal(messages.at(-1).role, 'user');
  assert.deepEqual(withoutCacheControl(messages.at(-1)), withoutCacheControl(off.wire.body.messages.at(-1)));
  assert.deepEqual(messages.at(-2).role, 'assistant');
  // Next request: the same reminder sits verbatim before the output it produced.
  const providerId = 'claude-channel';
  const loop = toolLoopContext('claude', 'claude-opus-5-5', providerId);
  const model3 = message('seg-model-3', 'model', { role: 'model', parts: [{ text: 'Implemented.' }] }, { providerId, modelId: 'claude-opus-5-5' });
  const model4 = message('seg-model-4', 'model', { role: 'model', parts: [{ text: 'Verified too.' }] }, { providerId, modelId: 'claude-opus-5-5' });
  const next = await render(fullRequest({
    provider: 'claude', modelId: 'claude-opus-5-5', scenario: 'tool-loop', claudeTurnScopedReminders: true,
    context: [...loop, model3, model4, message('seg-user-2', 'user', { role: 'user', parts: [{ text: 'thanks' }] })],
    reminder: null,
    history: [
      { segmentId: 'seg-model-1', content: HISTORY_REMINDER },
      { segmentId: 'seg-model-2', content: REMINDER },
      { segmentId: 'seg-model-4', content: [TASK_CARD, COMPLETION_CHECK].join('\n\n') }
    ]
  }));
  const before = withoutCacheControl(messages);
  const after = withoutCacheControl(next.wire.body.messages);
  assert.deepEqual(after.slice(0, before.length), before);
  assert.deepEqual(after.slice(before.length).map((entry) => entry.role), ['assistant', 'user']);
});

test('发送形态规则：只看前一条非 system 内容；重新注入过的历史提醒在失去原位置时不发送；尾巴模式只留本轮提醒', () => {
  const user = { role: 'user', parts: [{ text: 'u' }] };
  const model = { role: 'model', parts: [{ text: 'm' }] };
  const history = reminders.turnReminderContent('h', { placement: 'history' });
  const reinjectedHistory = reminders.turnReminderContent('r', { placement: 'history', afterReinjectedInput: true });
  const current = reminders.turnReminderContent('c', { placement: 'current' });
  const contents = [user, history, model, reinjectedHistory, model, user, current];
  assert.deepEqual(reminders.turnReminderDeliveries(contents, 'claude_turn_scoped'),
    [undefined, 'system', undefined, 'omitted', undefined, undefined, 'system']);
  assert.deepEqual(reminders.turnReminderDeliveries([model, history, model, current], 'claude_turn_scoped'),
    [undefined, 'user', undefined, 'user']);
  assert.deepEqual(reminders.turnReminderDeliveries(contents, 'tail'),
    [undefined, 'omitted', undefined, 'omitted', undefined, undefined, 'user']);
  const tail = reminders.layoutTurnReminderContents(contents, 'tail');
  assert.deepEqual(tail, [user, model, model, user, { role: 'user', parts: [{ text: 'c' }] }]);
  const plain = [user, model];
  assert.equal(reminders.layoutTurnReminderContents(plain, 'claude_turn_scoped'), plain, 'no marker: the very same array');
  const unified = toUnifiedRequest({ id: 'r', contents, tools: [] }, undefined, 'gemini', undefined, 'claude_turn_scoped');
  assert.equal(JSON.stringify(unified).includes('claudeSystemMessage'), false, 'non-Claude providers always get the tail layout');
  assert.equal(unified.contents.length, 5);
  const claude = toUnifiedRequest({ id: 'r', contents, tools: [] }, undefined, 'claude', undefined, 'claude_turn_scoped');
  assert.deepEqual(claude.contents.map((content) => content.claudeSystemMessage?.clearAt ?? content.role),
    ['user', 'next_user_message', 'model', 'model', 'user', 'next_user_message']);
});

test('recipe 是提醒文本的唯一来源：同一 recipe 永远生成逐字节相同的提醒', () => {
  const recipe = {
    kind: 'reliable-agent-turn',
    turnTaskCard: { card: `  ${TASK_CARD}\n`, cardSha256: 'a'.repeat(64), counts: { unfinished: 2 } },
    turnTaskCardReminderEnabled: true,
    openTaskCompletionCheck: { kind: 'open_task_completion_check', card: COMPLETION_CHECK },
    runtimeStatusCard: { card: STATUS_CARD, activeChildCount: 1, runningProcessCount: 1 }
  };
  const projected = projectTurnReminder(recipe);
  assert.deepEqual(projected, {
    content: [TASK_CARD, COMPLETION_CHECK, STATUS_CARD].join('\n\n'),
    taskCardSha256: 'a'.repeat(64), unfinishedTaskCount: 2, activeChildCount: 1, runningProcessCount: 1
  });
  assert.deepEqual(projectTurnReminder(structuredClone(recipe)), projected);
  assert.equal(projectTurnReminder({ ...recipe, turnTaskCardReminderEnabled: false }).content, [COMPLETION_CHECK, STATUS_CARD].join('\n\n'));
  assert.equal(projectTurnReminder({ kind: 'reliable-context-compression' }), undefined);
  assert.equal(projectTurnReminder({ kind: 'reliable-agent-turn' }), undefined);
});

test('网关拒绝文本识别：只认明确的 clear_at / system 角色 / 位置错误', () => {
  for (const text of [
    'messages.7.clear_at: Extra inputs are not permitted',
    '{"type":"error","error":{"type":"invalid_request_error","message":"messages.3.clear_at: Extra inputs are not permitted"}}',
    'messages.3: a turn-scoped system message supports text blocks only (clear_at: \'next_user_message\')',
    'messages: Unexpected role "system". The Messages API accepts a top-level `system` parameter, not "system" as an input message role.',
    "messages.3.role: Input should be 'user' or 'assistant'",
    'Unknown field: messages[3].clear_at',
    'system messages are not supported by this upstream',
    'messages.4: a system message must immediately follow a user turn'
  ]) assert.equal(reminders.claudeTurnScopedRemindersRejected(text), true, text);
  for (const text of [
    'max_tokens: Field required',
    'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.',
    'thinking.adaptive.block_binding: Extra inputs are not permitted',
    'temperature: Extra inputs are not permitted',
    'overloaded_error'
  ]) assert.equal(reminders.claudeTurnScopedRemindersRejected(text), false, text);
});

test('beta 头：与用户自定义头、保留思考自动加的头逗号合并并去重；关闭且请求体没有轮内系统消息时原样返回', () => {
  const body = { messages: [{ role: 'user', content: 'q' }, { role: 'system', clear_at: 'next_user_message', content: 'r' }] };
  const merged = reminders.withClaudeTurnScopedSystemBeta({ body, headers: { 'Anthropic-Beta': `${USER_BETA}, ${BINDING_BETA}` } }, true);
  assert.deepEqual(merged.headers, { 'anthropic-beta': `${USER_BETA},${BINDING_BETA},${BETA}` });
  const again = reminders.withClaudeTurnScopedSystemBeta(merged, true);
  assert.equal(again, merged, 'already present: unchanged');
  const inactive = { body: { messages: [{ role: 'user', content: 'q' }] }, headers: { 'anthropic-beta': USER_BETA } };
  assert.equal(reminders.withClaudeTurnScopedSystemBeta(inactive, false), inactive);
  assert.deepEqual(reminders.withClaudeTurnScopedSystemBeta({ body, headers: {} }, false).headers, { 'anthropic-beta': BETA },
    'a body that carries clear_at always gets the header');
});

test('保留思考 strip_thinking 去掉只剩思考的 assistant 时，它前面的轮内系统消息一并去掉（否则 system 后面紧跟 user）', () => {
  const body = {
    model: 'claude-opus-5-5', thinking: { type: 'adaptive' },
    messages: [
      { role: 'user', content: 'q1' },
      { role: 'system', clear_at: 'next_user_message', content: 'r1' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's1' }] },
      { role: 'user', content: 'q2' },
      { role: 'system', clear_at: 'next_user_message', content: 'r2' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 's2' }, { type: 'text', text: 'a2' }] },
      { role: 'user', content: 'q3' },
      { role: 'system', clear_at: 'next_user_message', content: 'r3' }
    ]
  };
  const stripped = applyClaudeThinkingBinding({ body, headers: {} }, 'strip_thinking').body;
  assert.deepEqual(stripped.messages, [
    { role: 'user', content: 'q1' },
    { role: 'user', content: 'q2' },
    { role: 'system', clear_at: 'next_user_message', content: 'r2' },
    { role: 'assistant', content: [{ type: 'text', text: 'a2' }] },
    { role: 'user', content: 'q3' },
    { role: 'system', clear_at: 'next_user_message', content: 'r3' }
  ]);
});

const CLAUDE_OK_STREAM = [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-opus-5-5', stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PONG' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }],
  ['message_stop', { type: 'message_stop' }]
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

async function withServer(respond, run) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') };
    calls.push(call);
    const result = respond(call, calls.length);
    res.writeHead(result.status ?? 200, { 'content-type': result.sse ? 'text/event-stream' : 'application/json' });
    res.end(result.sse ?? JSON.stringify(result.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/v1`, calls);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const rejection = (message) => ({ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message } } });
const hasSystem = (body) => body.messages.some((entry) => entry.role === 'system');

async function turnScopedStart(baseUrl, id) {
  const request = fullRequest({ provider: 'claude', modelId: 'claude-opus-5-5', scenario: 'tool-loop', claudeTurnScopedReminders: true });
  const settings = { ...settingsFor('claude', 'claude-opus-5-5', baseUrl), apiKey: 'dummy-test-key' };
  const { start } = await render(request, settings);
  const tailBody = (await dryRunLlmProvider({ ...start, settingsSnapshot: { ...start.settingsSnapshot, claudeTurnScopedReminders: undefined } }, { settings })).body;
  return { start: { ...start, id }, settings, tailBody };
}

async function send(start, settings) {
  const events = [];
  await startLlmProvider(start, (event) => events.push(event), { settings: async () => settings });
  return events;
}

for (const reason of [
  'messages.7.clear_at: Extra inputs are not permitted',
  'messages: Unexpected role "system". The Messages API accepts a top-level `system` parameter, not "system" as an input message role.',
  'messages.1: a system message must immediately follow a user turn'
]) {
  test(`网关回退：${reason.slice(0, 48)}… 的 400 立即以原来的尾巴模式重发，不占重试次数，并对这个目标记住`, async () => {
    resetProviderRequestAdaptations();
    await withServer((call) => hasSystem(call.body) ? rejection(reason) : { sse: CLAUDE_OK_STREAM }, async (baseUrl, calls) => {
      const { start, settings, tailBody } = await turnScopedStart(baseUrl, 'fallback-1');
      const events = await send(start, settings);
      assert.equal(events.some((event) => event.type === 'llm:error'), false, JSON.stringify(events.filter((event) => event.type === 'llm:error')));
      assert.equal(events.some((event) => event.type === 'llm:retryScheduled' || event.type === 'llm:retryStarted'), false);
      assert.equal(calls.length, 2);
      assert.equal(hasSystem(calls[0].body), true);
      assert.equal(String(calls[0].headers['anthropic-beta']).split(',').includes(BETA), true);
      assert.deepEqual(calls[1].body, tailBody, 'the retry is exactly the old tail-mode request');
      assert.equal(String(calls[1].headers['anthropic-beta']), USER_BETA, 'no clear_at beta in tail mode');
      assert.equal(learnedProviderRequestAdaptations({ providerConfigId: settings.id, provider: 'claude', baseUrl, model: settings.model }).claudeTurnScopedReminders, 'tail');

      // Later requests to this target go straight to tail mode.
      const next = await turnScopedStart(baseUrl, 'fallback-2');
      await send(next.start, next.settings);
      assert.equal(calls.length, 3);
      assert.deepEqual(calls[2].body, next.tailBody);
    });
    // Another target is unaffected.
    await withServer(() => ({ sse: CLAUDE_OK_STREAM }), async (baseUrl, calls) => {
      const other = await turnScopedStart(baseUrl, 'fallback-other');
      await send(other.start, { ...other.settings, id: 'another-claude-channel' });
      assert.equal(calls.length, 1);
      assert.equal(hasSystem(calls[0].body), true);
    });
  });
}

test('网关回退：无关的 400 不回退、原样报错；没用轮内系统消息的请求不学习', async () => {
  resetProviderRequestAdaptations();
  await withServer(() => rejection('max_tokens: Field required'), async (baseUrl, calls) => {
    const { start, settings } = await turnScopedStart(baseUrl, 'unrelated');
    const events = await send(start, settings);
    assert.equal(calls.length, 1);
    assert.equal(events.some((event) => event.type === 'llm:error'), true);
    assert.equal(learnedProviderRequestAdaptations({ providerConfigId: settings.id, provider: 'claude', baseUrl, model: settings.model }).claudeTurnScopedReminders, undefined);
  });
  await withServer(() => rejection('messages.7.clear_at: Extra inputs are not permitted'), async (baseUrl, calls) => {
    const request = fullRequest({ provider: 'claude', modelId: 'claude-opus-5-5', scenario: 'tool-loop' });
    const settings = { ...settingsFor('claude', 'claude-opus-5-5', baseUrl), apiKey: 'dummy-test-key' };
    const { start } = await render(request, settings);
    await send({ ...start, id: 'off-request' }, settings);
    assert.equal(calls.length, 1, 'switch off: no fallback retry');
    assert.equal(learnedProviderRequestAdaptations({ providerConfigId: settings.id, provider: 'claude', baseUrl, model: settings.model }).claudeTurnScopedReminders, undefined);
  });
});

test('与保留思考回退同时生效：drop_block 重发同时带两个 beta 头，轮内系统消息保持不变', async () => {
  resetProviderRequestAdaptations();
  const mismatch = 'messages.2.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. '
    + 'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".';
  await withServer((call) => call.body.thinking?.block_binding ? { sse: CLAUDE_OK_STREAM } : rejection(mismatch), async (baseUrl, calls) => {
    const { start, settings } = await turnScopedStart(baseUrl, 'binding');
    await send(start, settings);
    assert.equal(calls.length, 2);
    assert.deepEqual(String(calls[1].headers['anthropic-beta']).split(','), [USER_BETA, BINDING_BETA, BETA]);
    assert.deepEqual(calls[1].body.messages, calls[0].body.messages);
  });
});
