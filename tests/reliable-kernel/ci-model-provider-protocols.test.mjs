import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { load, kernel, llm, conversion, adaptation, user, model, call, result,
  settings, startRequest, fullRequest, fakeCapability, accepted, wire, sse,
  compatDelta, geminiChunk, claudeSse, withFetch, send, adaptedReply,
  providerFailure, EDIT_TOOL } from './fixtures/ci-model-provider-support.mjs';

const unified = await import('unified-llm-provider');
const thinking = load('backend/capabilities/claudeThinkingAdaptation.js');
const reminders = load('backend/capabilities/claudeTurnScopedReminders.js');
const capabilities = load('shared/modelCapabilities.js');
const BINDING_ERROR = { status: 400, rawBody: { error: { message:
  'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. '
  + 'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".' } } };
afterEach(() => adaptation.resetProviderRequestAdaptations());

test('Claude 保留自身思考签名、剔除外来思考，改写工具 id 后结果仍配对', () => {
  const contents = [user('read'), model([
    { text: 'own', thought: true, thoughtSignature: 'claude:own-signature' },
    { text: 'foreign', thought: true, thoughtSignature: 'openai-responses:foreign-signature' },
    call('functions.read:0', 'read', { path: 'a' })
  ]), { role: 'user', parts: [result('functions.read:0', 'read', { output: 'ok' })] }];
  const request = conversion.toUnifiedRequest(startRequest(contents), undefined, 'claude');
  const messages = new unified.ClaudeFormat('claude-opus-5-5').encodeRequest(request, false).messages;
  const blocks = messages.flatMap(message => Array.isArray(message.content) ? message.content : []);
  assert.deepEqual(blocks.filter(block => block.type === 'thinking'),
    [{ type: 'thinking', thinking: 'own', signature: 'own-signature' }]);
  const id = blocks.find(block => block.type === 'tool_use').id;
  assert.match(id, /^[a-zA-Z0-9_-]+$/);
  assert.equal(blocks.find(block => block.type === 'tool_result').tool_use_id, id);
});

test('Claude 前缀失配按实际发出的状态升级，迟到的旧请求不越级去掉思考', () => {
  const target = { providerConfigId: 'binding', provider: 'claude', baseUrl: 'https://relay.invalid/v1', model: 'claude-opus-5-5' };
  const first = adaptation.createProviderRequestAdaptationSession({ conversationId: 'binding-conversation' });
  const concurrent = adaptation.createProviderRequestAdaptationSession({ conversationId: 'binding-conversation' });
  const retry = adaptation.createProviderRequestAdaptationRetry(target, {}, first);
  assert.equal(retry.shouldRetryImmediately(BINDING_ERROR), true);
  assert.equal(first.claudeThinkingBinding, 'drop_block');
  assert.equal(adaptation.createProviderRequestAdaptationRetry(target, {}, concurrent)
    .shouldRetryImmediately(BINDING_ERROR), true);
  assert.equal(concurrent.claudeThinkingBinding, 'drop_block');
  assert.equal(adaptation.learnedConversationClaudeThinkingBinding('binding-conversation'), 'drop_block');
  first.sentClaudeThinkingBinding = 'drop_block';
  assert.equal(retry.shouldRetryImmediately(BINDING_ERROR), true);
  assert.equal(first.claudeThinkingBinding, 'strip_thinking');
  const body = { thinking: { type: 'adaptive' }, messages: [
    { role: 'user', content: 'q' }, { role: 'assistant', content: [
      { type: 'thinking', thinking: 'private', signature: 'signature' }, { type: 'text', text: 'answer' }
    ] }
  ] };
  assert.deepEqual(thinking.applyClaudeThinkingBinding({ body, headers: {} }, first.claudeThinkingBinding).body.messages,
    [{ role: 'user', content: 'q' }, { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }]);
});

test('Claude extended 模型使用预算，adaptive 始终思考模型不会发送 disabled', () => {
  const profile = id => thinking.claudeThinkingFamilyProfile(capabilities.anthropicModelReasoningCapability(id));
  const extended = thinking.adaptClaudeThinkingForFamily({ headers: {},
    body: { model: 'old', thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
    canonicalRequest: { generationConfig: { thinkingConfig: { thinkingBudget: 4096 } } }
  }, profile('claude-sonnet-4-5'));
  assert.deepEqual(extended.body, { model: 'old', thinking: { type: 'enabled', budget_tokens: 4096 } });
  const adaptive = thinking.adaptClaudeThinkingForFamily({ headers: {},
    body: { model: 'new', thinking: { type: 'disabled' }, max_tokens: 1000 }
  }, profile('claude-opus-5-5'));
  assert.deepEqual(adaptive.body, { model: 'new', max_tokens: 1000 });
});

test('Claude 原生压缩和普通请求共用冻结 system、tools 与带签名历史前缀', async () => {
  const config = settings('claude', { stream: false, systemPromptPrefix: 'frozen prefix',
    promptCache: { enabled: true, mode: 'explicit', ttl: '1h' },
    requestBody: { stop_sequences: ['END'], context_management: { edits: [] }, metadata: { user_id: 'ci' } } });
  const contents = [user('read'), model([{ text: 'reason', thought: true, thoughtSignature: 'claude:sig' },
    call('call_1', 'edit', { path: 'a', mode: 'hunk', hunks: [] })]),
    { role: 'user', parts: [result('call_1', 'edit', { ok: true })] }];
  const systemInstruction = user('system');
  const frozen = fullRequest(config, contents, [EDIT_TOOL]);
  frozen.authoritySnapshot.model.systemPromptPrefix = 'frozen prefix';
  frozen.authoritySnapshot.systemPrompt.text = 'system';
  let projected;
  await new kernel.LlmCapabilityFullRequestAdapter(config.id, fakeCapability((input, emit) => {
    projected = input; emit({ type: 'llm:done', payload: { requestId: input.id } });
  })).sendFullRequest(frozen, accepted);
  const ordinary = await llm.dryRunLlmProvider(projected, { settings: async () => config });
  const compact = await llm.dryRunCompactLlmProvider({ id: 'claude-compact', blockId: 'block',
    conversationId: 'ci-provider-conversation', methodKind: 'provider_native',
    methodConfigSnapshot: { id: 'native', name: 'native', kind: 'provider_native', trigger: { mode: 'manual' }, createdAt: 1, updatedAt: 1 },
    settingsSnapshot: { providerConfigId: config.id, provider: config.provider, modelId: config.model },
    systemInstruction, tools: [EDIT_TOOL], contents
  }, { settings: async () => config, compressionSettings: async () => undefined });
  const body = JSON.parse(compact.calls[0].bodyText);
  assert.deepEqual(body.system, ordinary.body.system);
  assert.deepEqual(body.tools, ordinary.body.tools);
  assert.deepEqual(body.messages, ordinary.body.messages);
  assert.equal(body.compaction.type, 'summarize');
  assert.equal('stop_sequences' in body, false);
  assert.equal('context_management' in body, false);
  assert.deepEqual(body.metadata, { user_id: 'ci' });
  assert.match(compact.calls[0].headers['anthropic-beta'], /compact-2026-09-04/);
});

test('Claude 易失输入和提醒前的模型正文承载缓存断点，原请求不变', () => {
  const cache = { type: 'ephemeral', ttl: '1h' };
  const request = { headers: {}, body: { messages: [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: [{ type: 'text', text: 'answer' }, { type: 'thinking', thinking: '', signature: 'sig' }] },
    { role: 'user', content: [{ type: 'text', text: 'reinjected' }] },
    { role: 'user', content: [{ type: 'text', text: 'reminder', cache_control: cache }] }
  ] } };
  const before = structuredClone(request);
  const moved = reminders.withClaudeCacheBreakpointBeforeVolatileTail(request, 2);
  assert.deepEqual(moved.body.messages[1].content[0].cache_control, cache);
  assert.equal('cache_control' in moved.body.messages[1].content[1], false);
  assert.equal('cache_control' in moved.body.messages[3].content[0], false);
  assert.deepEqual(request, before);
});

test('Claude 任务卡是原位 system，第三方运行状态始终是 user', () => {
  const card = reminders.turnReminderContent('task\n\nstatus', { placement: 'history',
    identitySplit: { user: 'status', system: 'task' } });
  const next = reminders.turnReminderContent('next task', { placement: 'current' });
  const content = reminders.layoutTurnReminderContents([user('question'), card, model([{ text: 'answer' }]), user('next'), next], 'claude_turn_scoped');
  const body = new unified.ClaudeFormat('claude-opus-5-5').encodeRequest(
    conversion.toUnifiedRequest(startRequest(content), undefined, 'claude', undefined, 'claude_turn_scoped'), false);
  assert.deepEqual(body.messages.map(message => message.role), ['user', 'user', 'system', 'assistant', 'user', 'system']);
  assert.equal(body.messages[1].content, 'status');
  assert.deepEqual(body.messages[2], { role: 'system', clear_at: 'next_user_message', content: 'task' });
  const marked = reminders.withClaudeTurnScopedSystemBeta({ body, headers: { 'Anthropic-Beta': 'user-beta' } }, true);
  assert.equal(marked.headers['anthropic-beta'], `user-beta,${reminders.CLAUDE_TURN_SCOPED_SYSTEM_BETA}`);
});

test('Claude 网关拒绝 clear_at 后只给原目标记住尾巴模式', () => {
  const target = { providerConfigId: 'claude-reminders', provider: 'claude', model: 'claude-opus-5-5', baseUrl: 'https://gateway.invalid/v1' };
  const retry = adaptation.createProviderRequestAdaptationRetry(target, { claudeTurnScopedReminders: true });
  const error = { status: 400, rawBody: { error: { message: 'messages.2.clear_at: Extra inputs are not permitted' } } };
  assert.equal(retry.shouldRetryImmediately(error), true);
  assert.equal(retry.shouldRetryImmediately(error), false);
  assert.equal(adaptation.claudeTurnScopedRemindersFallenBack(target), true);
  assert.equal(adaptation.claudeTurnScopedRemindersFallenBack({ ...target, providerConfigId: 'other' }), false);
  const tail = reminders.layoutTurnReminderContents([user('q'),
    reminders.turnReminderContent('old', { placement: 'history' }), model([{ text: 'a' }]),
    reminders.turnReminderContent('current', { placement: 'current' })], 'tail');
  assert.deepEqual(tail, [user('q'), model([{ text: 'a' }]), user('current')]);
});

test('Gemini 文本签名保留原 part，空尾签名不变成思考', async () => {
  const config = settings('gemini');
  const reply = await withFetch(() => sse([
    geminiChunk([{ text: 'Thinking.', thought: true }]), geminiChunk([{ text: 'Hello' }]),
    geminiChunk([{ text: ' world', thoughtSignature: 'SIGNED_TEXT' }]),
    geminiChunk([{ text: '', thoughtSignature: 'SIGNED_TAIL' }], 'STOP')
  ]), () => adaptedReply(config, [user('go')]));
  const parts = reply.parts.map(({ thoughtDurationMs: ignored, ...part }) => part);
  assert.deepEqual(parts, [{ text: 'Thinking.', thought: true }, { text: 'Hello' },
    { text: ' world', thoughtSignature: 'gemini:SIGNED_TEXT' }, { text: '', thoughtSignature: 'gemini:SIGNED_TAIL' }]);
  const replayed = (await wire(config, [user('go'), model(parts)])).body.contents.at(-1).parts;
  assert.deepEqual(replayed.at(-1), { text: '', thoughtSignature: 'SIGNED_TAIL' });
});

test('Gemini 兼容流中并行调用的迟到签名归回原调用，同内容无 id 调用保持独立', async () => {
  const config = settings('openai-compatible', { model: '[v]gemini-3.5-flash' });
  const tools = [{ name: 'lookup', description: 'lookup', parameters: { type: 'object', properties: { key: { type: 'string' } } } }];
  const reply = await withFetch(() => sse([
    compatDelta({ tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"key":"a"}' } }] }),
    compatDelta({ tool_calls: [{ index: 0, extra_content: { google: { thought_signature: 'LATE' } } }] }),
    compatDelta({ tool_calls: [{ index: 1, type: 'function', function: { name: 'lookup', arguments: '{"key":"a"}' } }] }),
    compatDelta({}, 'tool_calls')
  ]), () => adaptedReply(config, [user('parallel')], tools));
  const calls = reply.parts.filter(part => part.functionCall);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].id, calls[1].id);
  assert.deepEqual(calls.map(part => [part.functionCall.args.key, part.thoughtSignature]), [['a', 'gemini:LATE'], ['a', undefined]]);
});

test('Gemini 当前工具步补签名，并行响应和目录按整批配对', async () => {
  const config = settings('gemini');
  const contents = [user('go'), model([call('a', 'render'), call('b', 'render')]),
    { role: 'user', parts: [result('a', 'render', { ok: true })] }, user('ATTACHMENT_CATALOG'),
    { role: 'user', parts: [result('b', 'render', { ok: true })] }];
  const body = (await wire(config, contents)).body;
  const calls = body.contents[1].parts;
  assert.equal(calls[0].thoughtSignature, 'skip_thought_signature_validator');
  assert.equal(calls[1].thoughtSignature, undefined);
  assert.deepEqual(body.contents[2].parts.filter(part => part.functionResponse).map(part => part.functionResponse.id), ['a', 'b']);
  assert.equal(body.contents[2].parts.at(-1).text, 'ATTACHMENT_CATALOG');
});

test('Gemini MCP schema 只发送可接受的子集并保持原 schema', async () => {
  const parameters = { type: 'object', additionalProperties: false,
    properties: { optional: { type: ['string', 'null'] },
      item: { $ref: '#/$defs/Item', description: 'item' },
      tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      mode: { type: 'string', const: 'fast' } }, required: ['item'],
    $defs: { Item: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } } };
  const before = structuredClone(parameters);
  const body = (await wire(settings('gemini'), [user('schema')],
    { tools: [{ name: 'mcp', description: 'MCP', parameters }] })).body;
  assert.deepEqual(body.tools[0].functionDeclarations[0].parameters, { type: 'object',
    properties: { optional: { type: 'string', nullable: true },
      item: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], description: 'item' },
      tags: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['fast'] } }, required: ['item'] });
  assert.deepEqual(parameters, before);
});

test('GPT6 最终 none 保留 Sol 采样，Astra 始终思考会归一化并去掉采样', async () => {
  const sampling = { temperature: 0.3, top_p: 0.9, logprobs: true, reasoning: { effort: 'none' } };
  const sol = (await wire(settings('openai-responses', { model: 'gpt-6-sol', requestBody: sampling }))).body;
  assert.equal(sol.reasoning.effort, 'none');
  assert.equal(sol.temperature, 0.3);
  const astra = (await wire(settings('openai-responses', { model: 'gpt-6-astra', requestBody: sampling }))).body;
  assert.equal(astra.reasoning.effort, 'low');
  assert.equal('temperature' in astra, false);
  assert.equal('top_p' in astra, false);
});

test('GPT6 冻结 reasoning.mode 与 configuration_update 不被实时配置覆盖', async () => {
  const config = settings('openai-responses', { model: 'gpt-6-sol', reasoningMode: 'pro',
    generationConfig: { thinkingConfig: { thinkingLevel: 'high' } } });
  const request = fullRequest(config);
  request.authoritySnapshot.model.generationConfig = { thinkingConfig: { thinkingLevel: 'none' } };
  request.recipe.nativeReasoning = { baseEffort: 'none', baseMode: 'standard',
    updates: [{ effort: 'minimal' }], effectiveEffort: 'minimal' };
  let projected;
  await new kernel.LlmCapabilityFullRequestAdapter(config.id, fakeCapability((input, emit) => {
    projected = input; emit({ type: 'llm:done', payload: { requestId: input.id } });
  })).sendFullRequest(request, accepted);
  const body = (await llm.dryRunLlmProvider(projected, { settings: async () => config })).body;
  assert.equal(body.reasoning.effort, 'none');
  assert.equal(body.reasoning.mode, 'standard');
  assert.deepEqual(body.input.filter(item => item.type === 'configuration_update').map(item => item.reasoning.effort), ['low']);
});

test('可靠 adapter 的权威回复保留思考、工具、思考的顺序和独立签名', async () => {
  const config = settings();
  const parts = [{ text: 'first', thought: true, thoughtSignature: 'openai-responses:first' },
    call('ordered', 'echo', { value: 1 }), { text: 'second', thought: true, thoughtSignature: 'openai-responses:second' }, { text: 'answer' }];
  const events = [];
  const adapter = new kernel.LlmCapabilityFullRequestAdapter(config.id, fakeCapability((input, emit) => {
    emit({ type: 'llm:thoughtDelta', payload: { requestId: input.id, text: 'first', thoughtStartedAt: 1000 } });
    emit({ type: 'llm:thoughtDone', payload: { requestId: input.id, thoughtStartedAt: 1000, thoughtDurationMs: 7 } });
    emit({ type: 'llm:toolcall', payload: { requestId: input.id, calls: [{ id: 'ordered', name: 'echo', argsJson: '{"value":1}' }] } });
    emit({ type: 'llm:thoughtDelta', payload: { requestId: input.id, text: 'second', thoughtStartedAt: 2000 } });
    emit({ type: 'llm:thoughtDone', payload: { requestId: input.id, thoughtStartedAt: 2000, thoughtDurationMs: 9 } });
    emit({ type: 'llm:done', payload: { requestId: input.id, content: model(parts) } });
  }));
  await adapter.sendFullRequest(fullRequest(config, [user('hello')],
    [{ name: 'echo', description: 'echo', parameters: { type: 'object' } }]), { async onEvent(event) {
      events.push(event); return { accepted: true, checkpointed: true, terminal: event.kind === 'completed' };
    } });
  assert.deepEqual(events.at(-1).content.parts, [{ ...parts[0], thoughtDurationMs: 7 }, parts[1],
    { ...parts[2], thoughtDurationMs: 9 }, parts[3]]);
});

test('真正 429 限流保留 Retry-After 的最早时间和替换部分输出语义', async () => {
  const error = await providerFailure('rate limited', { status: 429, headers: { 'Retry-After': '60' } });
  assert.ok(error instanceof kernel.ProviderTransientError);
  assert.equal(error.reason, 'rate_limited');
  assert.equal(error.retryOptions.retryAfterMs, 60_000);
  assert.equal(error.retryAfterOutput, true);
});

test('额度错误默认永久，显式强制重试沿用原错和等待且总开关有效', async () => {
  const raw = { status: 429, code: 'insufficient_quota', headers: { 'retry-after': '2' } };
  const normal = await providerFailure('quota exhausted', raw);
  assert.equal(normal instanceof kernel.ProviderTransientError, false);
  const policy = { enabled: true, maxRetries: 2, forceAllErrors: true };
  const forced = await providerFailure('quota exhausted', raw, policy);
  assert.ok(forced instanceof kernel.ProviderTransientError);
  assert.equal(forced.retryOptions.retryAfterMs, 2000);
  assert.equal(forced.message, 'quota exhausted');
  assert.equal((await providerFailure('quota exhausted', raw, { ...policy, enabled: false })).constructor,
    normal.constructor);
});

const SKILL = load('backend/world/modules/skill/skillLookup.js').renderLoadedSkill({
  name: 'demo', source: '.claude', baseDirectory: '/skills/demo', entryPath: '/skills/demo/SKILL.md',
  body: '# Demo\n\n1. Say "hi"\tthen stop.', bodyStartLine: 5
}, '# Demo\n\n1. Say "hi"\tthen stop.');
const SKILL_ERROR = '未找到技能 "nope"。';
const READ_RESULT = { status: 'succeeded', detail: { output: 'x' } };
const TOOL_HISTORY = [user('use skill'), model([call('skill', 'skills', { name: 'demo' }),
  call('missing', 'skills', { name: 'nope' }), call('read', 'read', { path: 'a' })]),
  { role: 'user', parts: [result('skill', 'skills', { output: SKILL }),
    result('missing', 'skills', { error: SKILL_ERROR }), result('read', 'read', READ_RESULT)] }];

function assertOutgoing(config, body) {
  const protocol = config.provider;
  if (protocol === 'gemini') {
    const replies = body.contents.flatMap(content => content.parts).filter(part => part.functionResponse)
      .map(part => part.functionResponse.response);
    assert.deepEqual(replies, [{ output: SKILL }, { error: SKILL_ERROR }, READ_RESULT]);
    const edit = body.tools[0].functionDeclarations.find(tool => tool.name === 'edit').parameters;
    assert.deepEqual(edit.properties.mode.enum, ['hunk', 'insert', 'delete']);
    assert.ok(edit.properties.hunks);
    return;
  }
  let tool, values;
  if (protocol === 'claude') {
    values = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
      .filter(block => block.type === 'tool_result').map(block => block.content);
    tool = body.tools.find(entry => entry.name === 'edit').input_schema;
  } else if (protocol === 'openai-responses') {
    values = body.input.filter(item => item.type === 'function_call_output').map(item => item.output);
    const declaration = body.tools.find(entry => entry.name === 'edit');
    assert.equal(declaration.strict, false);
    tool = declaration.parameters;
  } else {
    values = body.messages.filter(message => message.role === 'tool').map(message => message.content);
    tool = body.tools.find(entry => entry.function.name === 'edit').function.parameters;
  }
  assert.deepEqual(values, [SKILL, SKILL_ERROR, JSON.stringify(READ_RESULT)]);
  assert.deepEqual(tool.properties.mode.enum, ['hunk', 'insert', 'delete']);
  assert.ok(tool.properties.hunks);
}

test('Chat Completions length 截断工具参数不会执行半个调用，技能正文按原文发送', async () => {
  const config = settings('openai-compatible');
  await withFetch(entry => { assertOutgoing(config, entry.body); return sse([
    compatDelta({ tool_calls: [{ index: 0, id: 'truncated', type: 'function', function: { name: 'edit', arguments: '{"path":' } }] }),
    compatDelta({}, 'length')
  ]); }, async () => {
    const events = await send(config, TOOL_HISTORY, { tools: [EDIT_TOOL] });
    assert.equal(events.some(event => event.type === 'llm:done'), false);
    assert.equal(events.some(event => event.type === 'llm:toolcall'), false);
    assert.match(events.find(event => event.type === 'llm:error').payload.message, /参数可能被截断/);
  });
});

test('Claude 仅思考的 refusal 是失败，任务工具结果保持原文', async () => {
  const config = settings('claude');
  await withFetch(entry => { assertOutgoing(config, entry.body); return claudeSse([{ text: 'thinking', thought: true }], 'refusal'); }, async () => {
    const events = await send(config, TOOL_HISTORY, { tools: [EDIT_TOOL] });
    assert.equal(events.some(event => event.type === 'llm:done'), false);
    assert.match(events.find(event => event.type === 'llm:error').payload.message, /refusal/);
  });
});

test('Gemini 工具参数中的 finishReason 不充当终态，技能结果使用官方对象', async () => {
  const config = settings('gemini', { model: 'gemini-2.5-flash' });
  await withFetch(entry => { assertOutgoing(config, entry.body); return sse([
    geminiChunk([{ functionCall: { name: 'edit', args: { finishReason: 'STOP', path: 'a', mode: 'hunk', hunks: [] } } }])
  ]); }, async () => {
    const events = await send(config, TOOL_HISTORY, { tools: [EDIT_TOOL] });
    assert.equal(events.some(event => event.type === 'llm:done'), false);
    assert.match(events.find(event => event.type === 'llm:error').payload.message, /LLM_STREAM_TRUNCATED/);
  });
});

test('Responses 推理耗尽输出预算的 incomplete 是失败，工具与正文不丢失原格式', async () => {
  const config = settings('openai-responses', { generationConfig: { maxOutputTokens: 256 } });
  await withFetch(entry => { assertOutgoing(config, entry.body); return sse([
    { type: 'response.created', response: { id: 'response', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'reason', type: 'reasoning', summary: [] } },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'reason', type: 'reasoning', summary: [], encrypted_content: 'opaque' } },
    { type: 'response.incomplete', response: { id: 'response', status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' }, usage: { output_tokens: 256,
        output_tokens_details: { reasoning_tokens: 256 }, input_tokens: 12 } } }
  ]); }, async () => {
    const events = await send(config, TOOL_HISTORY, { tools: [EDIT_TOOL] });
    assert.equal(events.some(event => event.type === 'llm:done'), false);
    assert.match(events.find(event => event.type === 'llm:error').payload.message, /max_output_tokens/);
  });
});

test('DeepSeek 用 thinking.type 与换算 effort，原有思考以 reasoning_content 回传', async () => {
  const config = settings('openai-compatible', { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro',
    generationConfig: { thinkingConfig: { thinkingLevel: 'medium' } } });
  const body = (await wire(config, [user('go'), model([{ text: 'thought', thought: true }, { text: 'answer' }])])).body;
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.messages.find(message => message.role === 'assistant').reasoning_content, 'thought');
});

test('百炼 enable_thinking 写法关闭时不夹带不接受的 effort', async () => {
  const config = settings('openai-compatible', { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen3-max',
    generationConfig: { thinkingConfig: { thinkingLevel: 'none' } } });
  const body = (await wire(config)).body;
  assert.equal(body.enable_thinking, false);
  assert.equal('reasoning_effort' in body, false);
  assert.equal('thinking' in body, false);
});

test('Kimi 始终思考只发 effort，并保留工具回放要求的 reasoning_content', async () => {
  const config = settings('openai-compatible', { baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k3',
    generationConfig: { thinkingConfig: { thinkingLevel: 'medium' } } });
  const body = (await wire(config, TOOL_HISTORY, { tools: [EDIT_TOOL] })).body;
  assert.equal(body.reasoning_effort, 'high');
  assert.equal('thinking' in body, false);
  assert.equal(body.messages.find(message => message.role === 'assistant').reasoning_content, '');
});

test('MiMo 把工具文件放到批后 user，图片保留在 tool', async () => {
  const config = settings('openai-compatible', { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2-pro' });
  const contents = [user('read'), model([call('file-call', 'read')]),
    { role: 'user', parts: [{ ...result('file-call', 'read', { ok: true }), functionResponse: {
      name: 'read', response: { ok: true }, parts: [
        { inlineData: { mimeType: 'application/pdf', data: Buffer.from('%PDF fixture').toString('base64') } },
        { inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=' } }
      ] } }] }];
  const body = (await wire(config, contents, { tools: [{ ...EDIT_TOOL, name: 'read' }] })).body;
  const at = body.messages.findIndex(message => message.role === 'tool');
  assert.equal(body.messages[at].content.some(block => block.type === 'file'), false);
  assert.equal(body.messages[at].content.some(block => block.type === 'image_url'), true);
  assert.equal(body.messages[at + 1].role, 'user');
  assert.equal(body.messages[at + 1].content[1].type, 'file');
});

test('一次 thinking probe 校准形成绑定目标的证据，手动选择仍优先', async () => {
  const { probeOpenAICompatibleThinking } = load('backend/capabilities/openAICompatibleThinkingProbe.js');
  const config = settings('openai-compatible', { model: 'deepseek-like',
    requestBody: { privateHistory: 'must not enter probe' } });
  await withFetch((entry, init) => {
    assert.equal(entry.body.privateHistory, undefined);
    if (entry.body.reasoning_effort === 'medium') return new Response(JSON.stringify({ error: { message: 'medium is not supported' } }),
      { status: 400, headers: { 'content-type': 'application/json' } });
    const thinkingEnabled = entry.body.thinking?.type === 'enabled';
    return sse([compatDelta(thinkingEnabled ? { reasoning_content: 'thinking' } : { content: 'OK' })]);
  }, async calls => {
    const record = await probeOpenAICompatibleThinking(config);
    assert.equal(calls.length, 7);
    assert.deepEqual(record.capabilitySnapshot.reasoning.levels, ['low', 'high', 'max']);
    assert.equal(record.capabilitySnapshot.reasoning.wireFormat, 'deepseek');
    const tested = { ...config, models: [record] };
    assert.equal(capabilities.resolveProviderOpenAICompatibleDialect(tested, config.model).source, 'probe');
    assert.equal(capabilities.resolveProviderOpenAICompatibleDialect({ ...tested, openaiCompatibleThinkingFormat: 'omit' }, config.model).format, 'omit');
    assert.notEqual(capabilities.resolveProviderOpenAICompatibleDialect({ ...tested, baseUrl: 'https://changed.invalid/v1' }, config.model).source, 'probe');
  });
});

test('Responses compact 只发送允许字段和冻结系统指令', async () => {
  const config = settings('openai-responses', { model: 'gpt-5.5', stream: false,
    requestBody: { context_management: [{ type: 'compaction' }], reasoning: { effort: 'high' },
      service_tier: 'flex', prompt_cache_key: 'fixed' } });
  const compact = await llm.dryRunCompactLlmProvider({ id: 'responses-compact', blockId: 'block',
    conversationId: 'compact', methodKind: 'provider_native',
    methodConfigSnapshot: { id: 'native', name: 'native', kind: 'provider_native', trigger: { mode: 'manual' }, createdAt: 1, updatedAt: 1 },
    settingsSnapshot: { providerConfigId: config.id, provider: config.provider, modelId: config.model },
    systemInstruction: user('frozen instructions'), contents: [user('history')], tools: []
  }, { settings: async () => config, compressionSettings: async () => undefined });
  const body = JSON.parse(compact.calls[0].bodyText);
  assert.match(compact.calls[0].url, /\/responses\/compact$/);
  assert.equal(body.instructions, 'frozen instructions');
  assert.equal(body.service_tier, 'flex');
  assert.equal('context_management' in body, false);
  assert.equal('reasoning' in body, false);
});

test('Responses HTTP 断点挪到易失尾巴之前的数组工具结果，原输入不变', () => {
  const { withOpenAIResponsesCacheBreakpointBeforeVolatileTail } = load('backend/capabilities/openAIResponsesTailCacheBreakpoint.js');
  const breakpoint = { mode: 'explicit' };
  const input = [{ role: 'developer', content: [{ type: 'input_text', text: 'system', prompt_cache_breakpoint: breakpoint }] },
    { role: 'user', content: [{ type: 'input_text', text: 'question' }] },
    { type: 'function_call', call_id: 'call', name: 'read', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call', output: [{ type: 'input_text', text: 'answer' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'reinjected' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'reminder', prompt_cache_breakpoint: breakpoint }] }];
  const original = structuredClone(input);
  const moved = withOpenAIResponsesCacheBreakpointBeforeVolatileTail({ headers: {}, body: {
    model: 'gpt-5.6', input, prompt_cache_options: { mode: 'explicit', ttl: '30m' }
  } }, 2);
  assert.deepEqual(moved.body.input[3].output[0].prompt_cache_breakpoint, breakpoint);
  assert.equal('prompt_cache_breakpoint' in moved.body.input[5].content[0], false);
  assert.deepEqual(input, original);
});

test('网关拒绝自动 effort 后同次调用重发，目标记忆随配置修订失效', async () => {
  const config = settings('openai-compatible', { generationConfig: { thinkingConfig: { thinkingLevel: 'high' } } });
  await withFetch(entry => entry.body.reasoning_effort
    ? new Response(JSON.stringify({ error: { message: 'reasoning_effort: Extra inputs are not permitted' } }),
      { status: 400, headers: { 'content-type': 'application/json' } })
    : sse([compatDelta({ content: 'PONG' }), compatDelta({}, 'stop')]), async calls => {
    const events = await send(config);
    assert.equal(events.filter(event => event.type === 'llm:done').length, 1);
    assert.equal(calls.length, 2);
    await send(config, [user('again')]);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].body.reasoning_effort, undefined);
    await send({ ...config, updatedAt: 2 }, [user('revision')]);
    assert.equal(calls.length, 5);
    assert.equal(calls[3].body.reasoning_effort, 'high');
  });
});

test('可靠请求只采用 AuthoritySnapshot 冻结的前置提示词', async () => {
  const config = settings();
  const request = fullRequest(config);
  request.authoritySnapshot.model.systemPromptPrefix = '本次冻结的模型要求';
  request.authoritySnapshot.systemPrompt.text = '已组装的系统提示词';
  request.authoritySnapshot.runtimeContext = { template: '运行环境说明' };
  request.settingsSnapshot = { systemPromptPrefix: '任务开始后才修改的设置' };
  request.context.unshift({ segmentId: 'system', segmentKind: 'system', messageRole: null,
    contentType: 'text/plain', content: '本轮附加说明' });
  let captured;
  await new kernel.LlmCapabilityFullRequestAdapter(config.id, fakeCapability((input, emit) => {
    captured = input; emit({ type: 'llm:done', payload: { requestId: input.id } });
  })).sendFullRequest(request, accepted);
  assert.equal(captured.systemInstruction.parts[0].text,
    '本次冻结的模型要求\n\n已组装的系统提示词\n\n运行环境说明\n\n本轮附加说明');
  assert.equal(captured.settingsSnapshot.systemPromptPrefix, '本次冻结的模型要求');
});

test('运行规则按固定顺序原样注入，用户文件里的占位符保持原文', () => {
  const { composeRuntimeContextRuleParts } = load('backend/reliableKernel/runtimeContextRendering.js');
  assert.deepEqual(composeRuntimeContextRuleParts([
    { id: 'project-c', scope: 'project', kind: 'CLAUDE', path: '/p/CLAUDE.md', exists: true, content: 'PROJECT-C' },
    { id: 'project-a', scope: 'project', kind: 'AGENTS', path: '/p/AGENTS.md', exists: true, content: 'PROJECT-A {{$agent.name}}' },
    { id: 'global-c', scope: 'global', kind: 'CLAUDE', path: '/g/CLAUDE.md', exists: true, content: 'GLOBAL-C' },
    { id: 'global-a', scope: 'global', kind: 'AGENTS', path: '/g/AGENTS.md', exists: true, content: 'GLOBAL-A' }
  ]), ['[全局规则 (AGENTS.md)]\nGLOBAL-A', '[全局规则 (CLAUDE.md)]\nGLOBAL-C',
    '[项目规则 (AGENTS.md)]\nPROJECT-A {{$agent.name}}', '[项目规则 (CLAUDE.md)]\nPROJECT-C']);
});
