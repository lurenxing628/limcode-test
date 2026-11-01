import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { load, kernel, llm, conversion, adaptation, user, model, call, result,
  settings, startRequest, fullRequest, fakeCapability, accepted, wire, sse,
  compatDelta, geminiChunk, claudeSse, withFetch, send, adaptedReply,
  providerFailure, EDIT_TOOL } from './fixtures/ci-model-provider-support.mjs';

const unified = await import('unified-llm-provider');
const thinking = load('backend/capabilities/claudeThinkingAdaptation.js');
const reminders = { ...load('backend/capabilities/claudeTurnScopedReminders.js'),
  ...load('backend/capabilities/turnReminderLayout.js') };
const capabilities = load('shared/modelCapabilities.js');
const runtimeDeliveryProjection = load('backend/reliableKernel/runtimeDeliveryProjection.js');
const BINDING_ERROR = { status: 400, rawBody: { error: { message:
  'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. '
  + 'Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block".' } } };
afterEach(() => adaptation.resetProviderRequestAdaptations());

test('压缩预算复用实际历史快照计数，按最后存活输出计费并排除 Claude 已清除系统内容', () => {
  for (const provider of ['openai-responses', 'claude']) {
    const config = settings(provider);
    const request = fullRequest(config, [user('question'), model([{ text: 'first' }]), model([{ text: 'last' }])]);
    request.authoritySnapshot.model.claudeTurnScopedReminders = true;
    request.recipe.kind = 'reliable-agent-turn';
    const adapter = new kernel.LlmCapabilityFullRequestAdapter(config.id, fakeCapability(() => {}));
    const before = adapter.estimateFullRequestInput(request);
    request.requestAddenda = { turnReminderHistory: [{
      segmentId: 'segment-1', budgetSegmentId: 'segment-2',
      delivery: provider === 'claude' ? 'claude_turn_scoped' : 'user_history',
      content: 'task details '.repeat(1_000) + 'running=1',
      identitySplit: { user: 'running=1', system: 'task details '.repeat(1_000) }
    }] };
    const after = adapter.estimateFullRequestInput(request);
    const extra = after.contextTokens - before.contextTokens;
    assert.ok(extra > 0);
    if (provider === 'claude') assert.ok(extra < 20, 'cleared system content must not count');
    else assert.ok(extra > 1_000);
    assert.deepEqual([...after.historyTokensBySegment], [['segment-2', extra]]);
    const budget = kernel.calculateFullRequestPlanningBudget({ contextWindowTokens: 200_000,
      compressionThresholdTokens: 100_000, breakdown: after });
    assert.deepEqual(budget.historyTokensBySegment, after.historyTokensBySegment);
    assert.equal(budget.breakdown.historyTokensBySegment, undefined, 'process-local costs must not enter summary metadata');
  }
});

test('手动压缩只计历史快照，不重算语义正文，也不按普通发送拒绝待摘要的外来原生状态', async t => {
  const config = settings('openai-responses');
  const request = fullRequest(config, [user('question'), model([{ text: 'output' }])]);
  request.recipe.kind = 'reliable-agent-turn';
  request.requestAddenda = { turnReminderHistory: [{ segmentId: 'segment-1', delivery: 'user_history', content: 'frozen snapshot' }] };
  const adapter = new kernel.LlmCapabilityFullRequestAdapter(config.id, fakeCapability(() => {}));
  const expected = adapter.estimateFullRequestInput(request).historyTokensBySegment;
  request.context.unshift({ segmentId: 'old-compact', segmentKind: 'compression', messageRole: null,
    contentType: 'application/vnd.limcode.compression-contents+json', content: JSON.stringify({
      kind: 'compression_contents', version: 1, contents: [model([{ text: 'old native state' }])],
      nativeBinding: { providerConfigId: 'previous-channel', provider: 'openai-responses', modelId: 'previous-model' }
    }) });
  assert.throws(() => adapter.estimateFullRequestInput(request), /incompatible/);
  const estimator = load('backend/reliableKernel/modelTokenEstimator.js');
  const estimate = estimator.estimateMessageContentTokens;
  const seen = [];
  t.mock.method(estimator, 'estimateMessageContentTokens', content => { seen.push(content); return estimate(content); });
  const actual = await load('backend/reliableKernel/llmCapabilityProviderAdapter.js').estimateHistoricalReminderTokens(request);
  assert.deepEqual(actual, expected);
  assert.equal(seen.length, 1, 'manual accounting must tokenize only the snapshot');
});

test('获取模型列表时各渠道均使用已配置的代理', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async () => assert.fail('模型列表请求绕过了已配置的代理'));
  t.mock.method(load('backend/capabilities/proxyFetch.js'), 'createProxyFetch', proxy => {
    assert.equal(proxy, 'http://proxy.invalid:7890');
    return async url => {
      requests.push(String(url));
      return Response.json({ data: [{ id: 'proxy-model' }], has_more: false,
        models: [{ name: 'models/proxy-model', displayName: 'Proxy model', supportedGenerationMethods: ['generateContent'] }] });
    };
  });
  for (const provider of ['openai-compatible', 'openai-responses', 'gemini', 'claude']) {
    const models = await llm.listLlmProviderModels(settings(provider), { proxy: async () => 'http://proxy.invalid:7890' });
    assert.ok(models.some(model => model.id === 'proxy-model'), provider);
  }
  assert.equal(requests.length, 4);
});

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

test('未知 Gemini 模型显式选择的思考等级按原值发送，未设置时不填入等级', async () => {
  const { validateSessionThinkingOverride, applySessionThinkingOverride } = load('shared/sessionThinking.js');
  const config = settings('gemini', { model: 'gemini-4-argon',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });
  for (const value of ['minimal', 'low', 'medium', 'high']) {
    const override = validateSessionThinkingOverride({ kind: 'gemini-level', value }, 'gemini', config.model,
      undefined, undefined, config);
    const request = await wire({ ...config, generationConfig: applySessionThinkingOverride(undefined, override) });
    assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel, value);
  }
  assert.throws(() => validateSessionThinkingOverride({ kind: 'gemini-level', value: 'none' }, 'gemini', config.model));
  const request = await wire(config);
  assert.equal(request.body.generationConfig?.thinkingConfig?.thinkingLevel, undefined);
});

test('Gemini 自定义网关复用渠道 Key 发送 x-api-key，Google 官方端点保持原认证头', async () => {
  const gateway = settings('gemini', { apiKey: 'offline-gateway-key' });
  const gatewayRequest = startRequest([user('auth')]);
  const gatewayDryRun = await llm.dryRunLlmProvider(gatewayRequest, { settings: async () => gateway }, { includeApiKey: true });
  assert.equal(gatewayDryRun.headers['x-goog-api-key'], 'offline-gateway-key');
  assert.equal(gatewayDryRun.headers['x-api-key'], 'offline-gateway-key');

  const official = settings('gemini', {
    apiKey: 'offline-official-key',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta'
  });
  const officialDryRun = await llm.dryRunLlmProvider(gatewayRequest, { settings: async () => official }, { includeApiKey: true });
  assert.equal(officialDryRun.headers['x-goog-api-key'], 'offline-official-key');
  assert.equal(officialDryRun.headers['x-api-key'], undefined);

  const overridden = settings('gemini', { apiKey: 'offline-channel-key', headers: { 'X-API-Key': 'explicit-gateway-key' } });
  const overriddenDryRun = await llm.dryRunLlmProvider(gatewayRequest, { settings: async () => overridden }, { includeApiKey: true });
  assert.equal(overriddenDryRun.headers['x-api-key'] ?? overriddenDryRun.headers['X-API-Key'], 'explicit-gateway-key');
});

for (const stream of [true, false]) {
  test(`Gemini ${stream ? '流式' : '非流式'}斜杠模型保留路径分隔符并编码段内字符`, async () => {
    const config = settings('gemini', { stream, model: 'vendor/gemini model' });
    await withFetch((entry, init) => {
      assert.equal(init.method, 'POST');
      assert.equal(entry.url, `https://provider.invalid/v1beta/models/vendor/gemini%20model:${stream
        ? 'streamGenerateContent?alt=sse' : 'generateContent'}`);
      const chunk = geminiChunk([{ text: 'hello' }], 'STOP');
      return stream ? sse([chunk]) : Response.json(chunk);
    }, async calls => {
      const events = await send(config);
      assert.equal(calls.length, 1);
      assert.equal(events.some(event => event.type === 'llm:error'), false);
      assert.ok(events.some(event => event.type === 'llm:done'));
      assert.equal(config.model, 'vendor/gemini model');
    });
  });

  for (const modelId of ['gemini-model', 'vendor/gemini-model']) {
    test(`Gemini HTTP 405 提示基于实际状态与${stream ? '流式' : '非流式'}动作（${modelId}）`, async () => {
      const config = settings('gemini', { stream, model: modelId });
      const body = { detail: 'Method Not Allowed' };
      await withFetch(() => Response.json(body, { status: 405, headers: { Allow: 'GET' } }), async calls => {
        const events = await send(config);
        assert.equal(calls.length, 1); // 不自动改协议、编码或端点重发。
        const failure = events.find(event => event.type === 'llm:error').payload;
        assert.match(failure.message, /Method Not Allowed/);
        assert.match(failure.message, /Gemini HTTP 405/);
        assert.ok(failure.message.includes(`POST models/<model>:${stream ? 'streamGenerateContent' : 'generateContent'}`));
        assert.match(failure.message, /Base URL.*API 版本前缀.*POST 路由/);
        assert.match(failure.message, /仅凭 405 不能确定具体原因/);
        assert.equal(failure.message.includes('模型 ID 含有 /'), modelId.includes('/'));
        assert.equal(failure.rawError.status, 405);
        assert.deepEqual(failure.rawError.rawBody, body);
        assert.equal(JSON.stringify(failure.rawError).includes('Gemini HTTP 405'), false);
        assert.equal(JSON.stringify(failure).includes('offline-placeholder'), false);
        const normal = await providerFailure(failure.message, failure.rawError);
        assert.equal(normal.status, 405);
        assert.equal(normal instanceof kernel.ProviderTransientError, false);
        const forced = await providerFailure(failure.message, failure.rawError,
          { enabled: true, maxRetries: 2, forceAllErrors: true });
        assert.equal(forced.status, 405);
        assert.ok(forced instanceof kernel.ProviderTransientError);
        assert.equal(forced.reason, 'temporary_service_error');
      });
    });
  }
}

test('可靠 adapter 的不同会话请求共用 Gemini 405 诊断且不改变失败分类', async () => {
  const config = settings('gemini', { model: 'vendor/gemini-model' });
  const capability = llm.createLlmProviderCapability({ settings: async () => config });
  try {
    await withFetch(() => Response.json({ detail: 'Method Not Allowed' }, { status: 405 }), async calls => {
      for (const conversationId of ['main-conversation', 'child-conversation']) {
        const request = { ...fullRequest(config), conversationId, modelRequestId: `request-${conversationId}` };
        await assert.rejects(
          new kernel.LlmCapabilityFullRequestAdapter(config.id, capability).sendFullRequest(request, accepted),
          error => {
            assert.equal(error.status, 405);
            assert.equal(error instanceof kernel.ProviderTransientError, false);
            assert.match(error.message, /Method Not Allowed\nGemini HTTP 405/);
            assert.match(error.message, /完整模型路径/);
            return true;
          }
        );
      }
      assert.equal(calls.length, 2);
    });
  } finally { capability.dispose(); }
});

for (const [provider, status] of [['gemini', 404], ['gemini', 500], ['openai-compatible', 405]]) {
  test(`${provider} HTTP ${status} 不追加 Gemini 405 诊断`, async () => {
    await withFetch(() => Response.json({ detail: 'Method Not Allowed' }, { status }), async calls => {
      const events = await send(settings(provider, { model: 'vendor/gemini-model' }));
      assert.equal(calls.length, 1);
      assert.equal(events.find(event => event.type === 'llm:error').payload.message.includes('Gemini HTTP 405'), false);
    });
  });
}

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

test('额度错误默认永久，显式强制重试保留原错并忽略服务端等待且总开关有效', async () => {
  const raw = { status: 429, code: 'insufficient_quota', headers: { 'retry-after': '2' } };
  const normal = await providerFailure('quota exhausted', raw);
  assert.equal(normal instanceof kernel.ProviderTransientError, false);
  const policy = { enabled: true, maxRetries: 2, forceAllErrors: true };
  const forced = await providerFailure('quota exhausted', raw, policy);
  assert.ok(forced instanceof kernel.ProviderTransientError);
  assert.equal(forced.retryOptions.retryAfterMs, undefined);
  assert.equal(forced.message, 'quota exhausted');
  assert.equal((await providerFailure('quota exhausted', raw, { ...policy, enabled: false })).constructor,
    normal.constructor);
});

test('强制重试忽略秒、毫秒和 Gemini 等待提示，包括超过普通自动等待上限的提示', async () => {
  const policy = { enabled: true, maxRetries: 2, forceAllErrors: true };
  for (const raw of [
    { status: 503, headers: { 'Retry-After': '300' } },
    { status: 503, headers: { 'retry-after-ms': '300000' } },
    { status: 429, details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '300s' }] },
    { status: 503, headers: { 'Retry-After': '601' } }
  ]) {
    const forced = await providerFailure('service unavailable', raw, policy);
    assert.ok(forced instanceof kernel.ProviderTransientError);
    assert.equal(forced.retryOptions.retryAfterMs, undefined);
  }
  const normal = await providerFailure('service unavailable', { status: 503, headers: { 'Retry-After': '300' } });
  assert.equal(normal.retryOptions.retryAfterMs, 300_000);
  const tooLong = await providerFailure('service unavailable', { status: 503, headers: { 'Retry-After': '601' } });
  assert.equal(tooLong instanceof kernel.ProviderTransientError, false);
  assert.match(tooLong.message, /超过自动等待上限/);
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

for (const separateUsage of [false, true]) {
  test(separateUsage ? 'Gemini 等待独立终态用量并保留签名和工具尾部，不等待 HTTP EOF'
    : 'Gemini 完整工具调用和 STOP 用量到齐后完成，不等待 HTTP EOF 或取消回执', async () => {
    const config = settings('gemini');
    const usage = { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 };
    const frame = value => `data: ${JSON.stringify(value)}\n\n`;
    const encode = value => new TextEncoder().encode(value);
    const tool = id => ({ functionCall: { id, name: 'edit', args: { path: 'a', mode: 'hunk', hunks: [] } } });
    const terminal = geminiChunk([tool('complete-call')], 'STOP');
    if (!separateUsage) terminal.usageMetadata = usage;
    let controller, cancelled = false, timer, pending;
    let sawCall;
    const callReceived = new Promise(resolve => { sawCall = resolve; });
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Gemini 正式终态后仍在等待 HTTP EOF')), 1000);
    });
    await withFetch(() => new Response(new ReadableStream({
      start(value) {
        controller = value;
        // Earlier usage is provisional and must not close a later STOP frame.
        const prefix = separateUsage ? frame({ usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 } }) : '';
        controller.enqueue(encode(prefix + frame(terminal)));
      },
      cancel() {
        cancelled = true;
        // Transport cleanup must not hold model completion hostage either.
        return separateUsage ? undefined : new Promise(() => {});
      }
    }), { headers: { 'content-type': 'text/event-stream' } }), async calls => {
      const events = [];
      pending = llm.startLlmProvider(startRequest([user('offline terminal probe')], { tools: [EDIT_TOOL] }), event => {
        events.push(event);
        if (event.type === 'llm:toolcall') sawCall();
      }, { settings: async () => config });
      try {
        if (separateUsage) {
          await Promise.race([callReceived, deadline]);
          assert.equal(cancelled, false);
          assert.equal(events.some(event => event.type === 'llm:done'), false);
          const signedCall = { ...tool('tail-call'), thoughtSignature: 'SIGNED_CALL' };
          const signedTail = frame(geminiChunk([{ text: '', thoughtSignature: 'SIGNED_TAIL' }]));
          const split = Math.floor(signedTail.length / 2);
          controller.enqueue(encode(frame(geminiChunk([signedCall])) + frame({ usageMetadata: usage })
            + signedTail.slice(0, split)));
          controller.enqueue(encode(signedTail.slice(split)));
        }
        await Promise.race([pending, deadline]);
        assert.equal(calls.length, 1);
        assert.equal(cancelled, true);
        assert.equal(events.some(event => event.type === 'llm:error'), false);
        const done = events.filter(event => event.type === 'llm:done');
        assert.equal(done.length, 1);
        assert.deepEqual(done[0].payload.usageMetadata, usage);
        const toolCalls = events.filter(event => event.type === 'llm:toolcall').flatMap(event => event.payload.calls);
        assert.deepEqual(toolCalls.map(call => call.id), separateUsage ? ['complete-call', 'tail-call'] : ['complete-call']);
        if (separateUsage) {
          assert.equal(toolCalls[1].thoughtSignature, 'gemini:SIGNED_CALL');
          assert.ok(events.some(event => event.type === 'llm:delta' && event.payload.thoughtSignature === 'gemini:SIGNED_TAIL'));
        }
      } finally {
        clearTimeout(timer);
        if (!cancelled) controller.close();
        await pending;
      }
    });
  });
}

for (const provider of ['claude', 'openai-responses']) {
  test(`${provider} 正式终态后保留最终用量并完成，不等待 HTTP EOF`, async () => {
    const config = settings(provider);
    const frame = value => `data: ${JSON.stringify(value)}\n\n`;
    const item = { id: 'terminal-message', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'offline probe', annotations: [] }] };
    const response = { id: 'terminal-response', object: 'response', status: 'completed', output: [item],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } };
    const claude = provider === 'claude' ? await claudeSse([{ text: 'offline probe' }]).text() : '';
    const prefix = provider === 'claude' ? claude.slice(0, claude.indexOf('event: message_stop'))
      : frame({ type: 'response.created', response: { id: response.id, status: 'in_progress', output: [] } })
        + frame({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'offline probe' })
        + frame({ type: 'response.output_item.done', output_index: 0, item });
    const terminal = provider === 'claude'
      ? frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } })
        + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      : frame({ type: 'response.completed', response });
    const encode = value => new TextEncoder().encode(value);
    let controller, cancelled = false, timer, pending, sawOutput;
    const outputReceived = new Promise(resolve => { sawOutput = resolve; });
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${provider} 正式终态后仍在等待 HTTP EOF`)), 1000);
    });
    await withFetch(() => new Response(new ReadableStream({
      start(value) { controller = value; value.enqueue(encode(prefix)); },
      cancel() { cancelled = true; return new Promise(() => {}); }
    }), { headers: { 'content-type': 'text/event-stream' } }), async calls => {
      const events = [];
      pending = llm.startLlmProvider(startRequest(), event => {
        events.push(event);
        if (event.type === 'llm:delta') sawOutput();
      }, { settings: async () => config });
      try {
        await Promise.race([outputReceived, deadline]);
        // Claude message_delta and a completed output item still have protocol tail to read.
        assert.equal(cancelled, false);
        assert.equal(events.some(event => event.type === 'llm:done'), false);
        controller.enqueue(encode(terminal));
        await Promise.race([pending, deadline]);
        assert.equal(calls.length, 1);
        assert.equal(cancelled, true);
        assert.equal(events.some(event => event.type === 'llm:error'), false);
        const done = events.filter(event => event.type === 'llm:done');
        assert.equal(done.length, 1);
        assert.equal(done[0].payload.usageMetadata.promptTokenCount, 5);
        assert.equal(done[0].payload.usageMetadata.candidatesTokenCount, provider === 'claude' ? 7 : 3);
      } finally {
        clearTimeout(timer);
        if (!cancelled) controller.close();
        await pending;
      }
    });
  });
}

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

test('Responses prompt_cache_key 始终限制在 64 字符，超长自定义值不直接发给供应商', async () => {
  const conversationId = `conversation_${'a'.repeat(64)}`;
  const automatic = await wire(settings('openai-responses', { promptCache: { enabled: true, mode: 'key', ttl: '30m' } }),
    [user('hello')], { conversationId });
  assert.equal(automatic.body.prompt_cache_key, 'a'.repeat(64));
  assert.equal(automatic.body.prompt_cache_key.length, 64);

  const custom = await wire(settings('openai-responses', {
    promptCache: { enabled: true, mode: 'key', ttl: '30m' },
    requestBody: { prompt_cache_key: 'custom-key-that-is-too-long-'.padEnd(65, 'x') }
  }), [user('hello')], { conversationId: 'short-conversation' });
  assert.equal(custom.body.prompt_cache_key, 'short-conversation');

  const disabled = await wire(settings('openai-responses', {
    promptCache: { enabled: false, mode: 'key', ttl: '30m' },
    requestBody: { prompt_cache_key: 'x'.repeat(65) }
  }));
  assert.equal('prompt_cache_key' in disabled.body, false);
});

test('后台 process completion envelope 的 Gemini 式回显不会进入流式或终态正文', async () => {
  const config = settings('gemini', { model: 'gemini-2.5-pro' });
  const request = fullRequest(config, [user('run the background command'), model([{ text: 'waiting' }])]);
  const envelope = {
    kind: 'process_completion', status: 'completed', sourceId: 'process-1', processId: 'process-1',
    processReceiptId: 'receipt-1', deliveryId: 'delivery-1', inboxItemId: 'inbox-1', targetTurnId: 'turn-1',
    deliveredAt: '2026-10-16T18:20:29.000Z',
    note: runtimeDeliveryProjection.RUNTIME_DELIVERY_MODEL_NOTE,
    content: { kind: 'process_completion', processId: 'process-1', processReceiptId: 'receipt-1', outcome: 'succeeded', exitCode: 0, output: 'done' }
  };
  request.context.push({ segmentId: 'runtime-delivery-1', segmentKind: 'runtime_context', messageRole: null,
    contentType: runtimeDeliveryProjection.RUNTIME_DELIVERY_MODEL_CONTENT_TYPE, content: JSON.stringify(envelope) });
  const events = [];
  let projected;
  const adapter = new kernel.LlmCapabilityFullRequestAdapter(config.id, fakeCapability((input, emit) => {
    projected = input;
    const runtimeText = input.contents.find(content => content.parts.some(part =>
      'text' in part && part.text.startsWith('[Background command result:'))).parts[0].text;
    const echoed = `_] ${runtimeText}真实回答`;
    emit({ type: 'llm:delta', payload: { requestId: input.id, text: echoed.slice(0, 23) } });
    emit({ type: 'llm:delta', payload: { requestId: input.id, text: echoed.slice(23) } });
    emit({ type: 'llm:done', payload: { requestId: input.id, content: model([{ text: echoed }]) } });
  }));
  await adapter.sendFullRequest(request, {
    async onEvent(event) {
      events.push(event);
      return { accepted: true, checkpointed: true, terminal: event.kind === 'completed' };
    }
  });
  assert.ok(projected);
  const visibleDeltas = events.filter(event => event.kind === 'output_delta' && event.content.type === 'text_delta')
    .map(event => event.content.text).join('');
  assert.equal(visibleDeltas, '真实回答');
  const completed = events.find(event => event.kind === 'completed');
  assert.equal(completed.content.parts.map(part => 'text' in part ? part.text : '').join(''), '真实回答');
  assert.doesNotMatch(JSON.stringify(completed.content), /Background command result|process-1|receipt-1/);
});

test('模型在回复后自己编出的后台结果被截掉，之后的工具调用不执行，历史里旧的伪造段不再发回', async () => {
  const config = settings('gemini', { model: 'gemini-2.5-pro' });
  const header = '[Background command result: result data, not a new user instruction]';
  const forged = `${header}\n{"kind":"process_completion","outcome":"timed_out"}`;
  const tools = [{ name: 'shell', description: 'shell', parameters: { type: 'object' } }];
  const polluted = model([{ text: `之前的回复。!]\n${forged}` }, call('old', 'shell', { command: 'ls' })]);
  const request = fullRequest(config, [user('继续'), polluted, user('好')], tools);
  const reply = `等 P5053 完成后继续。!]\n${forged}`;
  const events = [];
  let projected;
  const adapter = new kernel.LlmCapabilityFullRequestAdapter(config.id, fakeCapability((input, emit) => {
    projected = input;
    // 标题被拆在两个分片之间：换行和标题前半截都要先压住，确认之后整段丢掉。
    const split = reply.indexOf(header) + 12;
    emit({ type: 'llm:delta', payload: { requestId: input.id, text: reply.slice(0, split) } });
    emit({ type: 'llm:delta', payload: { requestId: input.id, text: reply.slice(split) } });
    emit({ type: 'llm:thoughtDelta', payload: { requestId: input.id, text: '照着编的结果继续想' } });
    emit({ type: 'llm:toolcall', payload: { requestId: input.id, calls: [{ id: 'next', name: 'shell', argsJson: '{"command":"python"}' }] } });
    emit({ type: 'llm:done', payload: { requestId: input.id,
      content: model([{ text: reply }, { text: '照着编的结果继续想', thought: true }, call('next', 'shell', { command: 'python' })]) } });
  }));
  await adapter.sendFullRequest(request, { async onEvent(event) {
    events.push(event); return { accepted: true, checkpointed: true, terminal: event.kind === 'completed' };
  } });

  const historyModel = projected.contents.find(content => content.role === 'model');
  assert.deepEqual(historyModel.parts.map(part => 'text' in part ? part.text : part.functionCall.name), ['之前的回复。!]', 'shell']);
  const visible = events.filter(event => event.kind === 'output_delta' && event.content.type === 'text_delta')
    .map(event => event.content.text).join('');
  assert.equal(visible, '等 P5053 完成后继续。!]');
  assert.equal(events.some(event => event.content?.type === 'thought_delta' || event.content?.type === 'tool_calls'), false);
  const completed = events.find(event => event.kind === 'completed');
  assert.deepEqual(completed.content.parts, [{ text: '等 P5053 完成后继续。!]' }]);
});

test('正文里提到投递标题、或换行后只是相似开头时照常显示', async () => {
  const config = settings('gemini', { model: 'gemini-2.5-pro' });
  const reply = '收到的是 [Background command result: …] 这类投递。\n[Child tasks] 都已结束。\n[Coll';
  const events = [];
  const adapter = new kernel.LlmCapabilityFullRequestAdapter(config.id, fakeCapability((input, emit) => {
    for (const piece of reply.match(/[\s\S]{1,5}/g)) emit({ type: 'llm:delta', payload: { requestId: input.id, text: piece } });
    emit({ type: 'llm:done', payload: { requestId: input.id } });
  }));
  await adapter.sendFullRequest(fullRequest(config), { async onEvent(event) {
    events.push(event); return { accepted: true, checkpointed: true, terminal: event.kind === 'completed' };
  } });
  const visible = events.filter(event => event.kind === 'output_delta' && event.content.type === 'text_delta')
    .map(event => event.content.text).join('');
  assert.equal(visible, reply);
  assert.equal(events.find(event => event.kind === 'completed').content.parts.map(part => part.text).join(''), reply);
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

test('图片策略和当前输入附件由冻结请求投影，不采用后来编辑的设置', async () => {
  const config = settings();
  const request = fullRequest(config);
  const historyImages = { resizeEnabled: false, limitEnabled: false, omitOldestEnabled: true, maxDimension: 2048, maxMB: 3 };
  request.authoritySnapshot.model.historyImages = historyImages;
  request.settingsSnapshot = { historyImages: { maxDimension: 2048, maxMB: 20 } };
  request.requestAddenda = { currentTurnInputs: [{ messageId: 'input', messageRevisionId: 'revision',
    contentObjectId: 'content', reinject: false, contentType: 'application/vnd.limcode.message+json',
    content: JSON.stringify({ role: 'user', parts: [{ inlineData: { attachmentId: 'current-image', mimeType: 'image/png' } }] }) }] };
  let captured;
  await new kernel.LlmCapabilityFullRequestAdapter(config.id, fakeCapability((input, emit) => {
    captured = input; emit({ type: 'llm:done', payload: { requestId: input.id } });
  })).sendFullRequest(request, accepted);
  assert.deepEqual(captured.settingsSnapshot.historyImages, historyImages);
  assert.deepEqual(captured.currentTurnImageAttachmentIds, ['current-image']);
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
