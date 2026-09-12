import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const compiledRoot = process.env.LIMCODE_COMPILED_ROOT
  ? path.resolve(root, process.env.LIMCODE_COMPILED_ROOT)
  : path.join(root, 'dist/extension');
const kernel = await import(pathToFileURL(
  path.join(compiledRoot, 'backend/reliableKernel/index.js')
).href);

function modelContent(text = '') {
  return { role: 'model', parts: text ? [{ text }] : [] };
}

function dependencies(provider = 'openai-responses', retryPolicy = { enabled: true, maxRetries: 3 }, compression = false) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: {
            content: JSON.stringify({ providerConfigId: 'provider-watchdog', modelId: 'model-watchdog' })
          },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: {
                providerConfigId: 'provider-watchdog',
                provider,
                modelId: 'model-watchdog',
                retryPolicy
              },
              modelProfile: {
                compressionThresholdTokens: 100000,
                contextWindowTokens: 128000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              ...(compression ? {
                compression: {
                  enabled: true,
                  methodKind: 'llm_summary',
                  thresholdTokens: 1,
                  config: {
                    id: 'compression-watchdog', name: 'offline summary', kind: 'llm_summary',
                    ...(typeof compression === 'object' ? { maxDurationMinutes: compression.maxDurationMinutes } : {}),
                    trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 1 }
                  },
                  provider: {
                    providerConfigId: 'provider-watchdog', provider, modelId: 'model-watchdog',
                    contextWindowTokens: 128000, maxOutputTokens: 16000, retryPolicy
                  }
                }
              } : {}),
              toolPolicy: { id: 'tools-default', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
              systemPrompt: { id: 'prompt-default', text: '' },
              runtimeContext: { id: null, name: '', template: '' },
              workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
            })
          }
        };
      }
    },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: {
      async toolAnnotations() { return {}; },
      async callTool() { return null; }
    },
    mcpPolicyGate: {
      async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; }
    },
    attachmentSettings: {
      async loadGlobalSettings() {
        return {
          section: 'attachments',
          settings: { maxStoredInlineFileMb: 25 },
          filePath: 'settings/attachments.json'
        };
      }
    },
    providers: {
      resolve(providerId) {
        return {
          providerId,
          async sendFullRequest() { throw new Error('fixture provider must be supplied explicitly'); }
        };
      }
    },
    toolDispatcher: {
      definitions() { return []; },
      async dispatch() { throw new Error('fixture has no tools'); }
    }
  };
}

async function withApp(name, run, provider, retryPolicy, compression) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const app = await kernel.ReliableKernelApplication.open(authority, dependencies(provider, retryPolicy, compression));
  try {
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: name, title: name, status: 'active', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: `${name}-agent-link`, conversation_id: name, agent_id: 'agent-main',
        role: 'default', created_at: now, updated_at: now
      })
    ]);
    const started = await app.turns.input({
      source: { kind: 'command', key: `${name}-input` },
      conversationId: name,
      leaseOwnerId: `${name}-owner`,
      hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      content: 'submit_plan approved, then update_task_list completed'
    });
    await run(app, name, started.turnId);
  } finally {
    await app.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function list(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 100
  }))).snapshot;
}

async function get(app, domain, id) {
  return (await app.database.snapshot([kernel.DOMAIN_REPOSITORIES.domain(domain).get(id)])).snapshot[0];
}

async function createRequest(app, conversationId, turnId, key, compression = false) {
  const head = (await list(app, 'ConversationContextHeadLink', { conversation_id: conversationId }))[0];
  const authority = (await list(app, 'AuthoritySnapshot', { turn_id: turnId }))[0];
  return app.modelProvider.createModelRequest({
    turnId,
    contextRootId: head.root_id,
    authoritySnapshotId: authority.id,
    recipe: compression ? {
      kind: 'reliable-context-compression',
      sourceRootId: head.root_id,
      sourceSegmentCount: 1,
      blockId: 'compression-block-' + key,
      compressionMethodKind: 'llm_summary',
      effectiveSummaryMaxTokens: 8000,
      sourceHash: 'frozen-source-hash'
    } : {
      kind: 'reliable-agent-turn',
      round: '3',
      previousTool: 'update_task_list',
      tools: []
    },
    idempotencyKey: key
  });
}

function controlPlane(app, overrides = {}) {
  return new kernel.ModelProviderControlPlane(app.database, app.contentStore, {
    semanticTimeouts: {
      // Only tests exercising watchdog expiry should opt into subsecond deadlines.
      firstSemanticMs: kernel.RELIABLE_PROVIDER_SEMANTIC_DEADLINES_MS.ordinaryFirst,
      semanticIdleMs: kernel.RELIABLE_PROVIDER_SEMANTIC_DEADLINES_MS.ordinaryIdle,
      compressionCompletionMs: kernel.RELIABLE_PROVIDER_SEMANTIC_DEADLINES_MS.compressionCompletion,
      ...(overrides.semanticTimeouts ?? {})
    },
    retryDelaysMs: overrides.retryDelaysMs ?? [0],
    adapterDrainTimeoutMs: 20
  });
}

function llmCapability(start) {
  return {
    start,
    abort() {},
    resolveInvocation() {},
    compact() {},
    dryRun() { throw new Error('unused'); },
    dryRunCompact() { throw new Error('unused'); },
    listModels() { return Promise.resolve([]); },
    cancelRetry() {},
    dispose() {}
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function summaryCapability(provider) {
  await import('unified-llm-provider');
  const { createLlmProviderCapability } = await import(pathToFileURL(
    path.join(compiledRoot, 'backend/capabilities/llmProvider.js')
  ).href);
  return createLlmProviderCapability({
    settings: {
      id: 'provider-watchdog', name: 'offline compression', provider,
      model: 'model-watchdog', models: [], modelConfigs: [],
      apiKey: 'offline-placeholder', baseUrl: 'https://provider.invalid/v1',
      stream: true, retryOnError: false, retryMaxAttempts: 0,
      toolCallFormat: 'function-call', createdAt: 1, updatedAt: 1
    }
  });
}

function summaryParts(text) {
  return [
    '目标\n- ' + text + '\n',
    '重要约束、决定和准确标识\n- 无\n',
    '工作状态\n- 已完成\n  - 无\n',
    '- 正在做\n  - 无\n- 受阻\n  - 无\n',
    '下一步\n- 无\n',
    '相关文件\n- 无\n'
  ];
}

function summarySseResponse(chunks, signal, idleChunks = []) {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream({
    async pull(controller) {
      await sleep(100);
      if (signal.aborted) {
        controller.error(signal.reason);
        return;
      }
      if (index >= chunks.length && idleChunks.length === 0) {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
      const chunk = index < chunks.length ? chunks[index] : idleChunks[(index - chunks.length) % idleChunks.length];
      index += 1;
      controller.enqueue(encoder.encode(typeof chunk === 'string' ? chunk : 'data: ' + JSON.stringify(chunk) + '\n\n'));
    }
  }), { headers: { 'content-type': 'text/event-stream' } });
}

test('压缩真实思考和文本持续生成超过旧完成期限仍在同一 Attempt 完成', async (context) => {
  await withApp('compression-live-progress', async (app, conversationId, turnId) => {
    let calls = 0;
    context.mock.method(globalThis, 'fetch', async (_input, init) => {
      calls += 1;
      const chunks = [
        ...Array.from({ length: 6 }, (_, index) => ({
          choices: [{ index: 0, delta: { reasoning_content: 'thinking ' + index }, finish_reason: null }]
        })),
        ...summaryParts('summary 0 summary 1').map((content, index) => ({
          choices: [{ index: 0, delta: { content }, finish_reason: index === 5 ? 'stop' : null }]
        }))
      ];
      return summarySseResponse(chunks, init.signal);
    });
    const capability = await summaryCapability('openai-compatible');
    const events = [];
    const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-watchdog', {
      ...capability,
      compact(request, emit) {
        capability.compact(request, (event) => { events.push(event); emit(event); });
      }
    });
    try {
      const request = await createRequest(app, conversationId, turnId, 'live-summary', true);
      const result = await controlPlane(app, {
        semanticTimeouts: { compressionCompletionMs: 500 }
      }).dispatch(request.modelRequestId, adapter);
      assert.equal(result.terminalState, 'completed');
      assert.equal(calls, 1);
      assert.equal(events.filter((event) => event.type === 'llm:compactProgress').length, 12);
      const completed = await app.modelProvider.completedEvent(request.modelRequestId);
      assert.match(JSON.stringify(completed.content), /summary 0 summary 1/);
      assert.doesNotMatch(JSON.stringify(completed.content), /thinking/);
      const checkpoints = await list(app, 'ModelStreamCheckpoint', { model_request_id: request.modelRequestId });
      assert.equal(checkpoints.length, 1);
      assert.equal(checkpoints[0].attempt_seq, 1n);
    } finally {
      capability.dispose();
    }
  }, 'openai-compatible', { enabled: true, maxRetries: 1 }, true);
});

test('压缩输出停滞后心跳、空白、usage 和签名不能续命，重试只采纳完整摘要', async (context) => {
  await withApp('compression-stalled-progress', async (app, conversationId, turnId) => {
    const requestBodies = [];
    context.mock.method(globalThis, 'fetch', async (_input, init) => {
      requestBodies.push(init.body);
      if (requestBodies.length > 1) {
        return summarySseResponse([{
          candidates: [{
            content: { role: 'model', parts: [{ text: summaryParts('recovered summary').join('') }] },
            finishReason: 'STOP'
          }]
        }], init.signal);
      }
      return summarySseResponse([
        { candidates: [{ content: { role: 'model', parts: [{ text: 'discarded thought', thought: true }] } }] },
        { candidates: [{ content: { role: 'model', parts: [{ text: 'discarded summary' }] } }] }
      ], init.signal, [
        ': keep-alive\n\n',
        { candidates: [{ content: { role: 'model', parts: [] } }] },
        { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 2 } },
        { candidates: [{ content: { role: 'model', parts: [{ thought: true, thoughtSignature: 'opaque-signature' }] } }] },
        { candidates: [{ content: { role: 'model', parts: [{ text: ' \n ', thought: true }] } }] }
      ]);
    });
    const capability = await summaryCapability('gemini');
    const progress = [];
    const transient = [];
    const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-watchdog', {
      ...capability,
      compact(request, emit) {
        capability.compact(request, (event) => {
          if (event.type === 'llm:compactProgress') progress.push(event);
          emit(event);
        });
      }
    });
    try {
      const request = await createRequest(app, conversationId, turnId, 'stalled-summary', true);
      const result = await controlPlane(app, {
        semanticTimeouts: { compressionCompletionMs: 750 }
      }).dispatch(request.modelRequestId, adapter, {
        onTransientTerminal: (event) => transient.push(event)
      });
      assert.equal(result.terminalState, 'completed');
      assert.equal(requestBodies.length, 2);
      assert.equal(requestBodies[1], requestBodies[0]);
      assert.equal(progress.length, 3);
      assert.ok(progress.every((event) => Object.keys(event.payload).join() === 'requestId'));
      assert.ok(transient.some((entry) =>
        entry.event.content.terminalState === 'provider_transient_compression_timeout'
        && entry.event.content.retrying === true && entry.event.content.discardOutput === true
      ));
      const completed = await app.modelProvider.completedEvent(request.modelRequestId);
      assert.match(JSON.stringify(completed.content), /recovered summary/);
      assert.doesNotMatch(JSON.stringify(completed.content), /discarded/);
      const checkpoints = await list(app, 'ModelStreamCheckpoint', { model_request_id: request.modelRequestId });
      assert.equal(checkpoints.length, 1);
      assert.equal(checkpoints[0].attempt_seq, 2n);
      assert.equal((await list(app, 'ToolCall')).length, 0);
    } finally {
      capability.dispose();
    }
  }, 'gemini', { enabled: true, maxRetries: 1 }, true);
});

test('压缩最长时间读取冻结配置，普通请求保持20分钟且内部测试覆盖值仍有效', async (context) => {
  const durations = [];
  const originalSetTimeout = globalThis.setTimeout;
  context.mock.method(globalThis, 'setTimeout', (callback, duration, ...args) => {
    durations.push(duration);
    return originalSetTimeout(callback, duration, ...args);
  });
  for (const scenario of [
    { name: 'configured', compression: true, minutes: 37, expected: 37 * 60000 },
    { name: 'default', compression: true, expected: 20 * 60000 },
    { name: 'ordinary', compression: false, minutes: 37, expected: 20 * 60000 },
    { name: 'override', compression: true, minutes: 37, expected: 1500, timeoutMs: 1500 }
  ]) {
    await withApp('compression-duration-' + scenario.name, async (app, conversationId, turnId) => {
      const request = await createRequest(app, conversationId, turnId, scenario.name, scenario.compression);
      durations.length = 0;
      await controlPlane(app).dispatch(request.modelRequestId, {
        providerId: 'provider-watchdog',
        async sendFullRequest(_request, controls) {
          await controls.onEvent({
            kind: 'completed', streamSeq: '1',
            content: scenario.compression
              ? { type: 'compression_result', contents: [modelContent('summary')] }
              : modelContent('ordinary output')
          });
        }
      }, { timeoutMs: scenario.timeoutMs });
      assert.ok(durations.includes(scenario.expected), JSON.stringify(durations));
      if (scenario.expected !== 20 * 60000) assert.ok(!durations.includes(20 * 60000));
    }, 'openai-compatible', { enabled: false, maxRetries: 0 }, { maxDurationMinutes: scenario.minutes });
  }
});

test('压缩首个进度立即可见，后续元数据限频且不保存部分摘要', async () => {
  await withApp('compression-progress-metadata', async (app, conversationId, turnId) => {
    const request = await createRequest(app, conversationId, turnId, 'progress-metadata', true);
    const provider = controlPlane(app, { semanticTimeouts: { compressionCompletionMs: 1000 } });
    let now = 10000;
    provider.epochNow = () => now;
    await provider.dispatch(request.modelRequestId, {
      providerId: 'provider-watchdog',
      async sendFullRequest(_request, controls) {
        await controls.onCompressionProgress('1');
        const first = (await get(app, 'ModelRequest', request.modelRequestId)).stream_stats_json;
        assert.equal(first.lastStreamEventAt, 10000);
        assert.equal(first.lastStreamSeq, '1');
        now = 14999;
        for (let sequence = 2; sequence <= 50; sequence += 1) {
          await controls.onCompressionProgress(String(sequence));
        }
        assert.deepEqual((await get(app, 'ModelRequest', request.modelRequestId)).stream_stats_json, first);
        now = 15000;
        await controls.onCompressionProgress('51');
        const next = (await get(app, 'ModelRequest', request.modelRequestId)).stream_stats_json;
        assert.equal(next.lastStreamEventAt, 15000);
        assert.equal(next.lastStreamSeq, '51');
        now = 25000;
        await controls.onCompressionProgress('51');
        await controls.onCompressionProgress('1');
        assert.deepEqual((await get(app, 'ModelRequest', request.modelRequestId)).stream_stats_json, next);
        assert.equal((await list(app, 'ModelStreamCheckpoint', { model_request_id: request.modelRequestId })).length, 0);
        assert.equal((await list(app, 'CompressionBlock')).length, 0);
        await controls.onEvent({
          kind: 'completed', streamSeq: '52',
          content: { type: 'compression_result', contents: [modelContent('complete summary')] }
        });
      }
    });
    const terminal = await get(app, 'ModelRequest', request.modelRequestId);
    assert.equal(terminal.terminal_state, 'completed');
    assert.equal(terminal.stream_stats_json.lastStreamEventAt, undefined);
    assert.equal((await list(app, 'ModelStreamCheckpoint', { model_request_id: request.modelRequestId })).length, 1);
  }, 'openai-compatible', { enabled: false, maxRetries: 0 }, true);
});

test('压缩重复或迟到进度不能绕过重试上限、取消和总时限', async () => {
  for (const scenario of ['retry-budget', 'cancel', 'dispatch-deadline']) {
    await withApp('compression-guard-' + scenario, async (app, conversationId, turnId) => {
      const request = await createRequest(app, conversationId, turnId, scenario, true);
      const caller = new AbortController();
      const provider = controlPlane(app, { semanticTimeouts: { compressionCompletionMs: 300 } });
      let calls = 0;
      let staleProgress;
      const dispatch = provider.dispatch(request.modelRequestId, {
        providerId: 'provider-watchdog',
        async sendFullRequest(_request, controls) {
          calls += 1;
          if (staleProgress) {
            await staleProgress('999');
            assert.equal((await get(app, 'ModelRequest', request.modelRequestId)).stream_stats_json.lastStreamEventAt, undefined);
          }
          staleProgress = controls.onCompressionProgress;
          let sequence = 1;
          await controls.onCompressionProgress(String(sequence));
          if (scenario === 'cancel') caller.abort();
          while (!controls.signal.aborted) {
            await sleep(50);
            if (scenario !== 'retry-budget') sequence += 1;
            await controls.onCompressionProgress(String(sequence));
          }
          await controls.onCompressionProgress('1000');
          throw controls.signal.reason;
        }
      }, { signal: caller.signal, timeoutMs: scenario === 'dispatch-deadline' ? 200 : 2000 });
      if (scenario === 'cancel') {
        await assert.rejects(dispatch, { name: 'AbortError' });
        assert.match((await get(app, 'ModelRequest', request.modelRequestId)).terminal_state, /cancelled/);
      } else {
        await assert.rejects(dispatch, (error) =>
          error.reason === (scenario === 'retry-budget' ? 'compression_timeout' : 'connection_interrupted')
        );
      }
      assert.equal(calls, scenario === 'retry-budget' ? 2 : 1);
      assert.equal((await list(app, 'ModelStreamCheckpoint', { model_request_id: request.modelRequestId })).length, 0);
    }, 'openai-compatible', { enabled: scenario === 'retry-budget', maxRetries: scenario === 'retry-budget' ? 1 : 0 }, true);
  }
});

async function waitForRequestStatus(app, requestId, status, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const request = await get(app, 'ModelRequest', requestId);
    if (request.status === status) return request;
    await sleep(5);
  }
  throw new Error(`ModelRequest ${requestId} did not reach ${status}.`);
}

test('可靠 Provider 请求携带冻结 Context root 所属的 conversationId', async () => {
  await withApp('provider-conversation-scope', async (app, conversationId, turnId) => {
    const request = await createRequest(app, conversationId, turnId, 'conversation-scope');
    let capturedConversationId;
    await controlPlane(app).dispatch(request.modelRequestId, {
      providerId: 'provider-watchdog',
      async sendFullRequest(fullRequest, controls) {
        capturedConversationId = fullRequest.conversationId;
        await controls.onEvent({
          kind: 'completed', streamSeq: '1',
          content: modelContent('done')
        });
      }
    });

    assert.equal(capturedConversationId, conversationId);
  });
});

test('plan→update_task_list 后只有伪 thought progress 不会续命，semantic stall 自动创建新 Attempt 并完成', async () => {
  await withApp('provider-semantic-stall', async (app, conversationId, turnId) => {
    const request = await createRequest(app, conversationId, turnId, 'task-list-stall');
    const provider = controlPlane(app, { semanticTimeouts: { firstSemanticMs: 40 } });
    let pseudoProgressStats;
    const originalEpochNow = provider.epochNow;
    let epoch = 10_000;
    provider.epochNow = () => epoch;
    const transient = [];
    let calls = 0;
    const result = await provider.dispatch(request.modelRequestId, {
      providerId: 'provider-watchdog',
      async sendFullRequest(fullRequest, controls) {
        calls += 1;
        if (fullRequest.attemptSeq === '1') {
          await controls.onEvent({
            kind: 'output_delta', streamSeq: '1', semanticProgress: false,
            content: { type: 'thought_delta', text: '正在分析' }
          });
          for (let seq = 2; seq <= 5; seq += 1) {
            await sleep(5);
            epoch += 5_000;
            await controls.onEvent({
              kind: 'output_delta',
              streamSeq: String(seq),
              semanticProgress: false,
              content: { type: 'thought_progress', thoughtElapsedMs: seq * 500 }
            });
          }
          pseudoProgressStats = (await get(app, 'ModelRequest', request.modelRequestId)).stream_stats_json;
          await new Promise((resolve) => controls.signal.addEventListener('abort', resolve, { once: true }));
          const aborted = new Error('watchdog aborted stalled socket');
          aborted.name = 'AbortError';
          throw aborted;
        }
        await controls.onEvent({
          kind: 'completed', streamSeq: '1',
          content: modelContent('无需用户继续即可完成')
        });
      }
    }, { onTransientTerminal: (event) => transient.push(event) });

    assert.equal(result.terminalState, 'completed');
    provider.epochNow = originalEpochNow;
    assert.equal(pseudoProgressStats.lastStreamEventAt, undefined,
      '本地 thought_progress 不能伪装成 durable Provider 活动心跳');
    assert.equal(pseudoProgressStats.lastStreamSeq, undefined);
    assert.equal(calls, 2);
    assert.ok(transient.some((entry) =>
      entry.event.content.retrying === true
      && entry.event.content.terminalState === 'provider_transient_first_semantic_timeout'
    ));
    const operation = (await list(app, 'Operation', {
      owner_kind: 'model_request', owner_id: request.modelRequestId
    }))[0];
    assert.equal((await list(app, 'Attempt', { operation_id: operation.id })).length, 2);
    assert.equal((await list(app, 'MessageRevision')).filter((revision) => revision.role === 'user').length, 1);
  });
});

test('已收到文本、思考或工具输出后发生 semantic idle stall 会切换 Attempt，只采纳恢复输出', async () => {
  for (const fixture of [
    {
      kind: 'text',
      content: { type: 'text_delta', text: 'discarded stall text' }
    },
    {
      kind: 'thought',
      content: { type: 'thought_delta', text: 'discarded stall thought' }
    },
    {
      kind: 'tool',
      content: {
        type: 'tool_call_delta',
        calls: [{ id: 'discarded-stall-call', name: 'echo', argumentsDelta: '{"partial":', streamIndex: '0' }]
      }
    }
  ]) {
    await withApp(`provider-stall-after-${fixture.kind}`, async (app, conversationId, turnId) => {
      const request = await createRequest(app, conversationId, turnId, `stall-after-${fixture.kind}`);
      const terminals = [];
      let calls = 0;
      await controlPlane(app, {
        semanticTimeouts: { firstSemanticMs: 1_000, semanticIdleMs: 500 }
      }).dispatch(request.modelRequestId, {
        providerId: 'provider-watchdog',
        async sendFullRequest(fullRequest, controls) {
          calls += 1;
          if (fullRequest.attemptSeq === '1') {
            await controls.onEvent({
              kind: 'output_delta', streamSeq: '1', content: fixture.content
            });
            await new Promise((resolve) => controls.signal.addEventListener('abort', resolve, { once: true }));
            const aborted = new Error('watchdog replaced stalled partial stream');
            aborted.name = 'AbortError';
            throw aborted;
          }
          await controls.onEvent({
            kind: 'completed', streamSeq: '1',
            content: modelContent(`recovered-${fixture.kind}`)
          });
        }
      }, { onTransientTerminal: (event) => terminals.push(event) });

      assert.equal(calls, 2);
      const durableRequest = await get(app, 'ModelRequest', request.modelRequestId);
      assert.equal(durableRequest.terminal_state, 'completed');
      assert.equal(durableRequest.stream_stats_json.attemptSeq, '2');
      const operation = (await list(app, 'Operation', {
        owner_kind: 'model_request', owner_id: request.modelRequestId
      }))[0];
      const attempts = (await list(app, 'Attempt', { operation_id: operation.id }))
        .slice()
        .sort((left, right) => Number(left.attempt_seq) - Number(right.attempt_seq));
      assert.deepEqual(attempts.map((entry) => entry.status), ['transient_failed', 'completed']);
      assert.ok(terminals.some((terminal) =>
        terminal.attemptSeq === '1'
        && terminal.event.content.terminalState === 'provider_transient_stream_stalled'
        && terminal.event.content.retrying === true
        && terminal.event.content.discardOutput === true
      ));
      const completed = await app.modelProvider.completedEvent(request.modelRequestId);
      assert.deepEqual(completed.content, modelContent(`recovered-${fixture.kind}`));
      const checkpoints = await list(app, 'ModelStreamCheckpoint', { model_request_id: request.modelRequestId });
      assert.ok(checkpoints.every((checkpoint) => checkpoint.attempt_seq === 2n),
        'terminal prune must discard the stalled Attempt checkpoint');
    });
  }
});

test('Responses WS event_idle 在已有语义输出后废弃旧 Attempt 并自动恢复', async () => {
  await withApp('provider-responses-ws-event-idle-retry', async (app, conversationId, turnId) => {
    const request = await createRequest(app, conversationId, turnId, 'responses-ws-event-idle-retry');
    const transientTerminals = [];
    const requestContents = [];
    let calls = 0;
    const adapter = new kernel.LlmCapabilityFullRequestAdapter(
      'provider-watchdog',
      llmCapability((llmRequest, emit) => {
        calls += 1;
        requestContents.push(llmRequest.contents);
        if (calls === 1) {
          emit({
            type: 'llm:thoughtDelta',
            payload: { requestId: llmRequest.id, text: 'discarded timeout thought' }
          });
          emit({
            type: 'llm:error',
            payload: {
              requestId: llmRequest.id,
              message: 'OpenAI Responses WebSocket event_idle timed out after 120000ms.',
              rawError: {
                name: 'OpenAIResponsesWebSocketTimeoutError',
                code: 'LLM_TRANSPORT_TIMEOUT',
                transport: 'websocket',
                phase: 'event_idle',
                timeoutMs: 120_000,
                receivedServerEvent: true,
                receivedSemanticOutput: true,
                retryable: true,
                transportAttemptsExhausted: false
              }
            }
          });
          return;
        }
        emit({
          type: 'llm:done',
          payload: { requestId: llmRequest.id, content: modelContent('recovered after event_idle') }
        });
      })
    );

    const result = await controlPlane(app, {
      semanticTimeouts: { firstSemanticMs: 1_000, semanticIdleMs: 1_000 }
    }).dispatch(request.modelRequestId, adapter, {
      onTransientTerminal: (event) => transientTerminals.push(event)
    });

    assert.equal(result.terminalState, 'completed');
    assert.equal(calls, 2);
    assert.deepEqual(requestContents[1], requestContents[0],
      'whole-Attempt replacement must preserve the frozen durable Context input');
    const durableRequest = await get(app, 'ModelRequest', request.modelRequestId);
    assert.equal(durableRequest.terminal_state, 'completed');
    assert.equal(durableRequest.stream_stats_json.attemptSeq, '2');
    const operation = (await list(app, 'Operation', {
      owner_kind: 'model_request', owner_id: request.modelRequestId
    }))[0];
    const attempts = (await list(app, 'Attempt', { operation_id: operation.id }))
      .slice()
      .sort((left, right) => Number(left.attempt_seq) - Number(right.attempt_seq));
    assert.deepEqual(attempts.map((entry) => entry.status), ['transient_failed', 'completed']);
    assert.ok(transientTerminals.some((terminal) =>
      terminal.attemptSeq === '1'
      && terminal.event.content.terminalState === 'provider_transient_connection_interrupted'
      && terminal.event.content.retrying === true
      && terminal.event.content.discardOutput === true
    ));
    const completed = await app.modelProvider.completedEvent(request.modelRequestId);
    assert.deepEqual(completed.content, modelContent('recovered after event_idle'));
    const checkpoints = await list(app, 'ModelStreamCheckpoint', {
      model_request_id: request.modelRequestId
    });
    assert.ok(checkpoints.every((checkpoint) => checkpoint.attempt_seq === 2n),
      'successful recovery must prune the timed-out Attempt checkpoint');
  });
});

test('Gemini SSE terminated 经真实 SDK 包装后仍丢弃部分思考和工具调用并自动恢复', async (t) => {
  const { createLlmProviderCapability } = await import(pathToFileURL(
    path.join(compiledRoot, 'backend/capabilities/llmProvider.js')
  ).href);
  await withApp('gemini-sse-read-retry', async (app, conversationId, turnId) => {
    let calls = 0;
    let releaseFailure;
    const failureGate = new Promise((resolve) => { releaseFailure = resolve; });
    const encoder = new TextEncoder();
    const sse = (candidate) => encoder.encode(`data: ${JSON.stringify({ candidates: [candidate] })}\n\n`);
    const requestBodies = [];
    t.mock.method(globalThis, 'fetch', async (_input, init) => {
      calls += 1;
      requestBodies.push(init.body);
      if (calls > 1) {
        return new Response(sse({
          content: { role: 'model', parts: [{ text: 'recovered from SSE disconnect' }] },
          finishReason: 'STOP'
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      const chunks = [
        sse({ content: { role: 'model', parts: [{ text: 'discarded thought', thought: true }] } }),
        sse({ content: { role: 'model', parts: [{ functionCall: { name: 'unused_tool', args: { value: 1 } } }] } })
      ];
      return new Response(new ReadableStream({
        async pull(controller) {
          if (chunks.length) return controller.enqueue(chunks.shift());
          await failureGate;
          controller.error(new TypeError('terminated', {
            cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })
          }));
        }
      }), { headers: { 'content-type': 'text/event-stream' } });
    });
    const capability = createLlmProviderCapability({
      settings: {
        id: 'provider-watchdog', name: 'offline Gemini', provider: 'gemini',
        model: 'model-watchdog', models: [], modelConfigs: [],
        apiKey: 'offline-placeholder', baseUrl: 'https://provider.invalid/v1beta',
        stream: true, retryOnError: false, retryMaxAttempts: 0,
        toolCallFormat: 'function-call', createdAt: 1, updatedAt: 1
      }
    });
    const events = [];
    const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-watchdog', {
      ...capability,
      start(request, emit) {
        capability.start(request, (event) => {
          events.push(event);
          emit(event);
          if (event.type === 'llm:toolcall') releaseFailure();
        });
      }
    });
    try {
      const request = await createRequest(app, conversationId, turnId, 'real-sdk-sse-retry');
      const result = await controlPlane(app, {
        semanticTimeouts: { firstSemanticMs: 10_000, semanticIdleMs: 10_000 }
      }).dispatch(request.modelRequestId, adapter);
      assert.equal(result.terminalState, 'completed');
      assert.equal(calls, 2, 'must retry in the durable ControlPlane, not inside the SDK/capability');
      assert.equal(requestBodies[1], requestBodies[0]);
      const error = events.find((event) => event.type === 'llm:error');
      assert.match(error.payload.message, /SSE 流读取中断（已接收 2 个数据块）/);
      assert.match(error.payload.message, /LLM_STREAM_TRUNCATED/);
      assert.ok(events.some((event) => event.type === 'llm:thoughtDelta'));
      const completed = await app.modelProvider.completedEvent(request.modelRequestId);
      assert.deepEqual(completed.content, modelContent('recovered from SSE disconnect'));
      const checkpoints = await list(app, 'ModelStreamCheckpoint', { model_request_id: request.modelRequestId });
      assert.ok(checkpoints.every((entry) => entry.attempt_seq === 2n));
      assert.equal((await list(app, 'ToolCall')).length, 0, 'failed Attempt tool output must not execute');
    } finally {
      releaseFailure();
      capability.dispose();
    }
  }, 'gemini');
});

test('中文服务暂时不可用经真实 SSE 和 SDK 后自动替换失败 Attempt', async (context) => {
  const { createLlmProviderCapability } = await import(pathToFileURL(
    path.join(compiledRoot, 'backend/capabilities/llmProvider.js')
  ).href);
  await withApp('localized-service-error-retry', async (app, conversationId, turnId) => {
    const requestBodies = [];
    context.mock.method(globalThis, 'fetch', async (_input, init) => {
      requestBodies.push(init.body);
      const chunks = requestBodies.length === 1
        ? [
            { choices: [{ index: 0, delta: { reasoning_content: 'discarded thought' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: { content: 'discarded answer' }, finish_reason: null }] },
            { error: { message: '模型服务暂时不可用，请稍后重试' } }
          ]
        : [{ choices: [{ index: 0, delta: { content: 'recovered from temporary service failure' }, finish_reason: 'stop' }] }];
      return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' }
      });
    });
    const capability = createLlmProviderCapability({
      settings: {
        id: 'provider-watchdog', name: 'offline service failure', provider: 'openai-compatible',
        model: 'model-watchdog', models: [], modelConfigs: [],
        apiKey: 'offline-placeholder', baseUrl: 'https://provider.invalid/v1',
        stream: true, retryOnError: false, retryMaxAttempts: 0,
        toolCallFormat: 'function-call', createdAt: 1, updatedAt: 1
      }
    });
    const events = [];
    const transientTerminals = [];
    const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-watchdog', {
      ...capability,
      start(request, emit) {
        capability.start(request, (event) => {
          events.push(event);
          emit(event);
        });
      }
    });
    try {
      const request = await createRequest(app, conversationId, turnId, 'localized-service-error-retry');
      const result = await controlPlane(app, {
        semanticTimeouts: { firstSemanticMs: 10_000, semanticIdleMs: 10_000 }
      }).dispatch(request.modelRequestId, adapter, {
        onTransientTerminal: (event) => transientTerminals.push(event)
      });
      assert.equal(result.terminalState, 'completed');
      assert.equal(requestBodies.length, 2, 'only the reliable ControlPlane retries the failed request');
      assert.equal(requestBodies[1], requestBodies[0]);
      assert.ok(events.some((event) => event.type === 'llm:thoughtDelta'));
      assert.ok(events.some((event) => event.type === 'llm:delta'));
      assert.equal(events.find((event) => event.type === 'llm:error').payload.message, '模型服务暂时不可用，请稍后重试');
      assert.ok(transientTerminals.some((terminal) =>
        terminal.attemptSeq === '1'
        && terminal.event.content.terminalState === 'provider_transient_temporary_service_error'
        && terminal.event.content.retrying === true
        && terminal.event.content.discardOutput === true
      ));
      const completed = await app.modelProvider.completedEvent(request.modelRequestId);
      assert.deepEqual(completed.content, modelContent('recovered from temporary service failure'));
      const checkpoints = await list(app, 'ModelStreamCheckpoint', { model_request_id: request.modelRequestId });
      assert.ok(checkpoints.every((checkpoint) => checkpoint.attempt_seq === 2n));
      assert.equal((await list(app, 'ToolCall')).length, 0);
    } finally {
      capability.dispose();
    }
  }, 'openai-compatible');
});

test('SSE 服务繁忙按冻结的四次重试预算恢复或终止', async (context) => {
  const { createLlmProviderCapability } = await import(pathToFileURL(
    path.join(compiledRoot, 'backend/capabilities/llmProvider.js')
  ).href);
  const serviceBusyMessage = "Streaming error: 503: {'code': 'SERVICE_BUSY', 'message': '服务繁忙，请稍后重试', 'traceId': 'trace-service-busy-fixture'}";
  for (const recover of [true, false]) {
    await context.test(recover ? '第四次重试成功' : '耗尽四次重试后停止', async (scenario) => {
      await withApp(`sse-service-busy-${recover ? 'recover' : 'exhausted'}`, async (app, conversationId, turnId) => {
        const requestBodies = [];
        scenario.mock.method(globalThis, 'fetch', async (_input, init) => {
          requestBodies.push(init.body);
          const chunks = recover && requestBodies.length === 5
            ? [{ choices: [{ index: 0, delta: { content: 'recovered from service busy' }, finish_reason: 'stop' }] }]
            : [
                { choices: [{ index: 0, delta: { reasoning_content: 'discarded thought' }, finish_reason: null }] },
                { choices: [{ index: 0, delta: { content: 'discarded answer' }, finish_reason: null }] },
                { error: { message: requestBodies.length === 1 ? '模型服务暂时不可用，请稍后重试' : serviceBusyMessage } }
              ];
          return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
            headers: { 'content-type': 'text/event-stream' }
          });
        });
        const capability = createLlmProviderCapability({
          settings: {
            id: 'provider-watchdog', name: 'offline service busy', provider: 'openai-compatible',
            model: 'model-watchdog', models: [], modelConfigs: [],
            apiKey: 'offline-placeholder', baseUrl: 'https://provider.invalid/v1',
            stream: true, retryOnError: false, retryMaxAttempts: 0,
            toolCallFormat: 'function-call', createdAt: 1, updatedAt: 1
          }
        });
        try {
          const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-watchdog', capability);
          const request = await createRequest(app, conversationId, turnId, 'sse-service-busy-budget');
          const transientTerminals = [];
          const dispatch = controlPlane(app, {
            semanticTimeouts: { firstSemanticMs: 10_000, semanticIdleMs: 10_000 }
          }).dispatch(request.modelRequestId, adapter, {
            onTransientTerminal: (event) => transientTerminals.push(event)
          });
          if (recover) {
            assert.equal((await dispatch).terminalState, 'completed');
            const completed = await app.modelProvider.completedEvent(request.modelRequestId);
            assert.deepEqual(completed.content, modelContent('recovered from service busy'));
          } else {
            await assert.rejects(dispatch, /SERVICE_BUSY/);
            const durableRequest = await get(app, 'ModelRequest', request.modelRequestId);
            assert.equal(durableRequest.terminal_state, 'provider_transient_temporary_service_error');
          }
          assert.equal(requestBodies.length, 5, 'initial Attempt plus exactly four configured retries');
          assert.ok(requestBodies.every((body) => body === requestBodies[0]));
          const retryingTerminals = transientTerminals.filter((terminal) => terminal.event.content.retrying === true);
          assert.deepEqual(retryingTerminals.map((terminal) => terminal.attemptSeq), ['1', '2', '3', '4']);
          assert.ok(retryingTerminals.every((terminal) => terminal.event.content.discardOutput === true));
          const operation = (await list(app, 'Operation', {
            owner_kind: 'model_request', owner_id: request.modelRequestId
          }))[0];
          const attempts = (await list(app, 'Attempt', { operation_id: operation.id }))
            .sort((left, right) => Number(left.attempt_seq) - Number(right.attempt_seq));
          assert.deepEqual(attempts.map((attempt) => attempt.status), [
            'transient_failed', 'transient_failed', 'transient_failed', 'transient_failed', recover ? 'completed' : 'failed'
          ]);
          assert.equal((await list(app, 'ToolCall')).length, 0);
        } finally {
          capability.dispose();
        }
      }, 'openai-compatible', { enabled: true, maxRetries: 4 });
    });
  }
});

test('incomplete chunked read 遵守冻结重试次数和关闭自动重试设置', async (testContext) => {
  const message = 'Streaming error: peer closed connection without sending complete message body (incomplete chunked read)';
  for (const scenario of [
    { name: 'recover', enabled: true, recover: true, attempts: 5 },
    { name: 'exhausted', enabled: true, recover: false, attempts: 5 },
    { name: 'disabled', enabled: false, recover: false, attempts: 1 }
  ]) {
    await testContext.test(scenario.name, async () => {
      await withApp('chunked-read-' + scenario.name, async (app, conversationId, turnId) => {
        const bodies = [];
        const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-watchdog', llmCapability((request, emit) => {
          bodies.push(JSON.stringify(request.contents));
          if (scenario.recover && bodies.length === scenario.attempts) {
            emit({ type: 'llm:done', payload: { requestId: request.id, content: modelContent('recovered') } });
          } else {
            emit({ type: 'llm:thoughtDelta', payload: { requestId: request.id, text: 'discarded partial thought' } });
            emit({ type: 'llm:error', payload: { requestId: request.id, message } });
          }
        }));
        const created = await createRequest(app, conversationId, turnId, 'chunked-read-budget');
        const terminals = [];
        const dispatch = controlPlane(app, {
          semanticTimeouts: { firstSemanticMs: 10_000, semanticIdleMs: 10_000 }
        }).dispatch(created.modelRequestId, adapter, { onTransientTerminal: (event) => terminals.push(event) });
        if (scenario.recover) {
          assert.equal((await dispatch).terminalState, 'completed');
          assert.deepEqual((await app.modelProvider.completedEvent(created.modelRequestId)).content, modelContent('recovered'));
        } else {
          await assert.rejects(dispatch, /incomplete chunked read/);
          assert.equal((await get(app, 'ModelRequest', created.modelRequestId)).terminal_state, 'provider_transient_connection_interrupted');
        }
        assert.equal(bodies.length, scenario.attempts);
        assert.ok(bodies.every((body) => body === bodies[0]));
        assert.equal(terminals.filter((terminal) => terminal.event.content.retrying === true).length, scenario.attempts - 1);
        const operation = (await list(app, 'Operation', { owner_kind: 'model_request', owner_id: created.modelRequestId }))[0];
        assert.equal((await list(app, 'Attempt', { operation_id: operation.id })).length, scenario.attempts);
      }, 'openai-responses', { enabled: scenario.enabled, maxRetries: scenario.enabled ? 4 : 0 });
    });
  }
});

test('普通 transient error 在已有语义输出后仍不盲目重放', async () => {
  await withApp('provider-generic-no-replay-after-output', async (app, conversationId, turnId) => {
    const request = await createRequest(app, conversationId, turnId, 'generic-no-replay-after-output');
    let calls = 0;
    await assert.rejects(
      controlPlane(app, {
        semanticTimeouts: { firstSemanticMs: 500, semanticIdleMs: 500 }
      }).dispatch(request.modelRequestId, {
        providerId: 'provider-watchdog',
        async sendFullRequest(_fullRequest, controls) {
          calls += 1;
          await controls.onEvent({
            kind: 'output_delta', streamSeq: '1',
            content: { type: 'text_delta', text: 'generic partial output' }
          });
          throw new kernel.ProviderTransientError('temporary_service_error', 'generic transient after output');
        }
      }),
      /不自动重放请求/
    );
    assert.equal(calls, 1);
    assert.equal((await get(app, 'ModelRequest', request.modelRequestId)).terminal_state, 'provider_failed');
  });
});

test('Agent loop 将 Provider 失败部分输出物化为不进入 Context 的唯一 Message', async () => {
  await withApp('agent-loop-durable-partial-output', async (app, conversationId, turnId) => {
    let providerCalls = 0;
    let nextRequestContents;
    const adapter = new kernel.LlmCapabilityFullRequestAdapter(
      'provider-watchdog',
      llmCapability((llmRequest, emit) => {
        providerCalls += 1;
        if (providerCalls === 1) {
          emit({
            type: 'llm:thoughtDelta',
            payload: { requestId: llmRequest.id, text: 'durable partial thought' }
          });
          emit({
            type: 'llm:delta',
            payload: { requestId: llmRequest.id, text: 'durable partial answer' }
          });
          emit({
            type: 'llm:toolcall',
            payload: {
              requestId: llmRequest.id,
              calls: [{ id: 'incomplete-call', name: 'unused_tool', argsJson: '{"value":1}' }]
            }
          });
          emit({
            type: 'llm:error',
            payload: {
              requestId: llmRequest.id,
              message: 'provider protocol error after partial output',
              rawError: { code: 'PROVIDER_PROTOCOL_ERROR', retryable: false }
            }
          });
          return;
        }
        nextRequestContents = llmRequest.contents;
        emit({
          type: 'llm:done',
          payload: {
            requestId: llmRequest.id,
            content: modelContent('next request completed')
          }
        });
      })
    );
    app.agentLoop.providers = {
      resolve(providerId) {
        assert.equal(providerId, 'provider-watchdog');
        return adapter;
      }
    };

    const headBefore = (await list(app, 'ConversationContextHeadLink', {
      conversation_id: conversationId
    }))[0].root_id;
    const failed = await app.agentLoop.drive(turnId);
    assert.equal(failed.terminalStatus, 'failed');
    assert.equal(failed.modelRequestIds.length, 1);
    assert.equal(failed.assistantMessageIds.length, 1);
    assert.equal(providerCalls, 1);

    const modelRequestId = failed.modelRequestIds[0];
    const durableRequest = await get(app, 'ModelRequest', modelRequestId);
    assert.equal(durableRequest.status, 'terminal');
    assert.equal(durableRequest.terminal_state, 'provider_failed');
    const checkpoints = await list(app, 'ModelStreamCheckpoint', { model_request_id: modelRequestId });
    assert.equal(checkpoints.filter((row) => row.checkpoint_kind === 'partial_summary').length, 1);

    const requestLinks = await list(app, 'ModelRequestMessageLink', { model_request_id: modelRequestId });
    assert.equal(requestLinks.length, 1);
    const messageId = requestLinks[0].message_id;
    assert.equal(messageId, failed.assistantMessageIds[0]);
    assert.ok(await get(app, 'Message', messageId));
    const revisions = await list(app, 'MessageRevision', { message_id: messageId });
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].role, 'model');
    assert.equal((await list(app, 'MessageCurrentRevisionLink', { message_id: messageId })).length, 1);
    assert.equal((await list(app, 'MessagePartOfConversation', {
      conversation_id: conversationId, message_id: messageId
    })).length, 1);
    assert.equal((await list(app, 'MessageTurnLink', {
      turn_id: turnId, message_id: messageId, role: 'model'
    })).length, 1);

    const contentObject = await get(app, 'ContentObject', revisions[0].content_object_id);
    const partialContent = JSON.parse((await app.contentStore.read(contentObject)).toString('utf8'));
    assert.deepEqual(partialContent, {
      role: 'model',
      parts: [
        { text: 'durable partial thought', thought: true },
        { text: 'durable partial answer' }
      ]
    });
    assert.equal(partialContent.parts.some((part) => part.functionCall), false);
    assert.equal((await list(app, 'ContextSegmentSource', {
      source_kind: 'message_revision', source_id: revisions[0].id
    })).length, 0);
    assert.equal((await list(app, 'ConversationContextHeadLink', {
      conversation_id: conversationId
    }))[0].root_id, headBefore, '失败部分消息不得推进 Context head');

    const replayedMessageId = await app.agentLoop.materializeFailedPartialOutput(turnId, modelRequestId);
    assert.equal(replayedMessageId, messageId);
    assert.equal((await list(app, 'ModelRequestMessageLink', { model_request_id: modelRequestId })).length, 1);
    assert.equal((await list(app, 'MessageRevision', { message_id: messageId })).length, 1);
    assert.equal((await list(app, 'ConversationContextHeadLink', {
      conversation_id: conversationId
    }))[0].root_id, headBefore, '失败快照重入不得推进 Context head');

    const nextTurn = await app.turns.input({
      source: { kind: 'command', key: 'agent-loop-durable-partial-output-next-input' },
      conversationId,
      leaseOwnerId: 'agent-loop-durable-partial-output-next-owner',
      hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      content: 'next user request'
    });
    const completed = await app.agentLoop.drive(nextTurn.turnId);
    assert.equal(completed.terminalStatus, 'completed');
    assert.equal(providerCalls, 2);
    assert.ok(nextRequestContents);
    assert.equal(JSON.stringify(nextRequestContents).includes('durable partial answer'), false);
    assert.equal(JSON.stringify(nextRequestContents).includes('durable partial thought'), false);
  });
});

test('Agent loop 的空 Provider 失败不创建部分 Message', async () => {
  await withApp('agent-loop-empty-provider-failure', async (app, conversationId, turnId) => {
    const adapter = new kernel.LlmCapabilityFullRequestAdapter(
      'provider-watchdog',
      llmCapability((llmRequest, emit) => {
        emit({
          type: 'llm:error',
          payload: {
            requestId: llmRequest.id,
            message: 'invalid request before output',
            rawError: { retryable: false }
          }
        });
      })
    );
    app.agentLoop.providers = { resolve() { return adapter; } };
    const headBefore = (await list(app, 'ConversationContextHeadLink', {
      conversation_id: conversationId
    }))[0].root_id;

    const failed = await app.agentLoop.drive(turnId);
    assert.equal(failed.terminalStatus, 'failed');
    assert.deepEqual(failed.assistantMessageIds, []);
    assert.equal(failed.modelRequestIds.length, 1);
    const modelRequestId = failed.modelRequestIds[0];
    assert.equal((await list(app, 'ModelRequestMessageLink', { model_request_id: modelRequestId })).length, 0);
    assert.equal((await list(app, 'ModelStreamCheckpoint', { model_request_id: modelRequestId }))
      .some((row) => row.checkpoint_kind === 'partial_summary'), false);
    assert.equal((await list(app, 'MessageTurnLink', { turn_id: turnId, role: 'model' })).length, 0);
    assert.equal((await list(app, 'ConversationContextHeadLink', {
      conversation_id: conversationId
    }))[0].root_id, headBefore);
  });
});

test('连续 semantic idle stall 会自动重试到冻结预算上限后才终止', async () => {
  await withApp('provider-stall-retry-exhaustion', async (app, conversationId, turnId) => {
    const request = await createRequest(app, conversationId, turnId, 'stall-retry-exhaustion');
    let calls = 0;
    await assert.rejects(
      controlPlane(app, {
        semanticTimeouts: { firstSemanticMs: 80, semanticIdleMs: 20 }
      }).dispatch(request.modelRequestId, {
        providerId: 'provider-watchdog',
        async sendFullRequest(_fullRequest, controls) {
          calls += 1;
          await controls.onEvent({
            kind: 'output_delta', streamSeq: '1',
            content: { type: 'text_delta', text: `stalled-${calls}` }
          });
          await new Promise((resolve) => controls.signal.addEventListener('abort', resolve, { once: true }));
          const aborted = new Error(`watchdog aborted stalled Attempt ${calls}`);
          aborted.name = 'AbortError';
          throw aborted;
        }
      }),
      (error) => /no semantic progress for 20ms/.test(error.message)
        && !/不自动重放请求/.test(error.message)
    );
    assert.equal(calls, 4);
    const durableRequest = await get(app, 'ModelRequest', request.modelRequestId);
    assert.equal(durableRequest.terminal_state, 'provider_transient_stream_stalled');
    const operation = (await list(app, 'Operation', {
      owner_kind: 'model_request', owner_id: request.modelRequestId
    }))[0];
    const attempts = (await list(app, 'Attempt', { operation_id: operation.id }))
      .slice()
      .sort((left, right) => Number(left.attempt_seq) - Number(right.attempt_seq));
    assert.deepEqual(attempts.map((entry) => entry.status), [
      'transient_failed', 'transient_failed', 'transient_failed', 'failed'
    ]);
  });
});

test('冻结 retryMaxAttempts=3 允许连续 transient failures 后第四个 Attempt 恢复', async () => {
  await withApp('provider-bounded-retry', async (app, conversationId, turnId) => {
    const request = await createRequest(app, conversationId, turnId, 'bounded-retry');
    const provider = controlPlane(app);
    let calls = 0;
    await provider.dispatch(request.modelRequestId, {
      providerId: 'provider-watchdog',
      async sendFullRequest(_fullRequest, controls) {
        calls += 1;
        if (calls <= 3) throw new kernel.ProviderTransientError('temporary_service_error', `temporary-${calls}`);
        await controls.onEvent({
          kind: 'completed', streamSeq: '1', content: modelContent('recovered')
        });
      }
    });
    assert.equal(calls, 4);
    const operation = (await list(app, 'Operation', {
      owner_kind: 'model_request', owner_id: request.modelRequestId
    }))[0];
    const attempts = await list(app, 'Attempt', { operation_id: operation.id });
    assert.equal(attempts.length, 4);
    assert.equal(attempts.filter((entry) => entry.status === 'transient_failed').length, 3);
  });
});

test('已提交 retrying/not-before 在 Host handoff 后由新 ControlPlane 恢复，且永久错误不重试', async () => {
  await withApp('provider-retry-recovery', async (app, conversationId, turnId) => {
    const handoffRetryDelayMs = 10_000;
    const request = await createRequest(app, conversationId, turnId, 'retry-recovery');
    const firstHost = controlPlane(app, { retryDelaysMs: [handoffRetryDelayMs] });
    const firstDispatch = firstHost.dispatch(request.modelRequestId, {
      providerId: 'provider-watchdog',
      async sendFullRequest() {
        throw new kernel.ProviderTransientError('connection_interrupted', 'temporary handoff fixture');
      }
    });
    const retrying = await waitForRequestStatus(app, request.modelRequestId, 'retrying');
    assert.equal(retrying.stream_stats_json.attemptSeq, '2');
    assert.ok(retrying.stream_stats_json.retryNotBeforeAt > Date.now());
    await firstHost.quiesceAllActiveDispatches(new kernel.ExecutionHandoffError('fixture handoff'));
    await assert.rejects(firstDispatch, /handoff/i);

    const secondHost = controlPlane(app, { retryDelaysMs: [handoffRetryDelayMs] });
    secondHost.epochNow = () => Date.now() + handoffRetryDelayMs;
    await secondHost.dispatch(request.modelRequestId, {
      providerId: 'provider-watchdog',
      async sendFullRequest(fullRequest, controls) {
        assert.equal(fullRequest.attemptSeq, '2');
        await controls.onEvent({
          kind: 'completed', streamSeq: '1', content: modelContent('resumed')
        });
      }
    }, { reconnect: true });
    assert.equal((await get(app, 'ModelRequest', request.modelRequestId)).terminal_state, 'completed');

    const permanent = await createRequest(app, conversationId, turnId, 'permanent-no-retry');
    let permanentCalls = 0;
    await assert.rejects(secondHost.dispatch(permanent.modelRequestId, {
      providerId: 'provider-watchdog',
      async sendFullRequest() {
        permanentCalls += 1;
        throw new Error('invalid request schema');
      }
    }), /invalid request schema/);
    assert.equal(permanentCalls, 1);
  });
});

test('冻结 retryDelayMs 固定重试间隔，覆盖内核自动退避且不加抖动', async () => {
  const configuredDelayMs = 30_000;
  await withApp('provider-fixed-retry-delay', async (app, conversationId, turnId) => {
    const request = await createRequest(app, conversationId, turnId, 'fixed-retry-delay');
    // 内核退避表配置为 0ms；固定间隔生效时应完全取代它。
    const host = controlPlane(app, { retryDelaysMs: [0] });
    const dispatch = host.dispatch(request.modelRequestId, {
      providerId: 'provider-watchdog',
      async sendFullRequest() {
        throw new kernel.ProviderTransientError('connection_interrupted', 'fixed delay fixture');
      }
    });
    const retrying = await waitForRequestStatus(app, request.modelRequestId, 'retrying');
    assert.equal(retrying.stream_stats_json.retryDelayMs, configuredDelayMs);
    assert.ok(retrying.stream_stats_json.retryNotBeforeAt > Date.now() + configuredDelayMs / 2);
    await host.quiesceAllActiveDispatches(new kernel.ExecutionHandoffError('fixture handoff'));
    await assert.rejects(dispatch, /handoff/i);
  }, 'openai-responses', { enabled: true, maxRetries: 2, retryDelayMs: configuredDelayMs });
});

test('冻结 retryDelayMs=0 时仍走内核自动退避表', async () => {
  await withApp('provider-auto-retry-delay', async (app, conversationId, turnId) => {
    const request = await createRequest(app, conversationId, turnId, 'auto-retry-delay');
    const host = controlPlane(app, { retryDelaysMs: [4_000] });
    const dispatch = host.dispatch(request.modelRequestId, {
      providerId: 'provider-watchdog',
      async sendFullRequest() {
        throw new kernel.ProviderTransientError('connection_interrupted', 'auto delay fixture');
      }
    });
    const retrying = await waitForRequestStatus(app, request.modelRequestId, 'retrying');
    // 自动退避带确定性抖动，落在 [75%, 100%] 区间内。
    assert.ok(retrying.stream_stats_json.retryDelayMs >= 3_000);
    assert.ok(retrying.stream_stats_json.retryDelayMs <= 4_000);
    await host.quiesceAllActiveDispatches(new kernel.ExecutionHandoffError('fixture handoff'));
    await assert.rejects(dispatch, /handoff/i);
  }, 'openai-responses', { enabled: true, maxRetries: 2, retryDelayMs: 0 });
});

test('生产 deadline 固定为普通首语义300秒/idle600秒与压缩无进度270秒', () => {
  assert.deepEqual(kernel.RELIABLE_PROVIDER_SEMANTIC_DEADLINES_MS, {
    ordinaryFirst: 300_000,
    ordinaryIdle: 600_000,
    compressionCompletion: 270_000
  });
});

test('Phase 0 Provider/Process/Client Feed 里程碑基准报告真实原始计数', { timeout: 120_000 }, () => {
  const run = childProcess.spawnSync(process.execPath, [
    'scripts/reliable-kernel/benchmark-phase0-milestones.mjs',
    '--samples=1'
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 110_000,
    maxBuffer: 16 * 1024 * 1024
  });
  assert.equal(run.status, 0, [run.stdout, run.stderr].filter(Boolean).join('\n'));
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.existingAggregation, {
    intervalMs: 32,
    maxBatchEvents: 24,
    maxBufferedChars: 1024
  });
  assert.equal(report.checkpointCapacity, 33);

  const expected = new Map([
    [1, { transactions: 2, rows: 2, drops: 0 }],
    [10, { transactions: 2, rows: 2, drops: 0 }],
    [33, { transactions: 2, rows: 2, drops: 0 }],
    [100, { transactions: 2, rows: 2, drops: 0 }]
  ]);
  for (const providerCase of report.provider) {
    const measurement = providerCase.measurements[0];
    const target = expected.get(providerCase.eventCount);
    assert.equal(measurement.durableStreamTransactions, target.transactions);
    assert.equal(measurement.modelStreamWorkerTransactions, target.transactions);
    assert.equal(measurement.retainedCheckpointRows, target.rows);
    assert.equal(measurement.capacityDrops, target.drops);
    assert.equal(measurement.contextMaterializeCalls, 1);
  }
  for (const boundary of report.providerCapacityBoundary.measurements) {
    assert.equal(boundary.checkpointed, true);
    assert.equal(boundary.ignoredReason, null);
    assert.equal(boundary.transactionCount, 1);
  }

  if (!report.process.skipped) {
    assert.deepEqual(report.process.map((entry) => entry.command), ['true', 'printf_x', 'node_version']);
    for (const processCase of report.process) {
      const measurement = processCase.measurements[0];
      assert.equal(
        measurement.terminalStatus,
        'succeeded',
        `${processCase.command}: ${JSON.stringify(measurement.processEvidence)}`
      );
      for (const phase of ['spawn', 'identity_ready', 'terminal_receipt']) {
        assert.ok(measurement.phases[phase].count >= 1, `${processCase.command} lacks ${phase}`);
      }
      if (processCase.command === 'true') {
        assert.equal(measurement.phases.output_import.count, 0);
      } else {
        assert.ok(measurement.phases.output_import.count >= 1, `${processCase.command} lacks output_import`);
      }
    }
  }

  const feed = report.clientFeed.measurements[0];
  assert.equal(feed.withoutWebview.feedListenerEvents, 0);
  assert.equal(feed.withWebview.feedListenerEvents, 1);
  assert.ok(feed.withWebview.databaseListenerCount > feed.withoutWebview.databaseListenerCount);
});

test('Provider persists only the first delta while item_done and terminal remain durable', async () => {
  await withApp('provider-recovery-checkpoint-policy', async (app, conversationId, turnId) => {
    const request = await createRequest(app, conversationId, turnId, 'recovery-checkpoint-policy');
    const results = [];
    let liveHeartbeat;
    const provider = controlPlane(app, {
      semanticTimeouts: { firstSemanticMs: 1_000, semanticIdleMs: 1_000 }
    });
    const originalEpochNow = provider.epochNow;
    let epoch = 10_000;
    provider.epochNow = () => epoch;
    try {
      await provider.dispatch(request.modelRequestId, {
        providerId: 'provider-watchdog',
        async sendFullRequest(_request, controls) {
          results.push(await controls.onEvent({
            kind: 'output_delta', streamSeq: '1', content: { type: 'text_delta', text: 'first' }
          }));
          results.push(await controls.onEvent({
            kind: 'output_delta', streamSeq: '2', content: { type: 'text_delta', text: 'x'.repeat(9_000) }
          }));
          results.push(await controls.onEvent({
            kind: 'output_delta', streamSeq: '3', content: { type: 'text_delta', text: 'y'.repeat(9_000) }
          }));
          await sleep(270);
          epoch += 5_000;
          results.push(await controls.onEvent({
            kind: 'output_delta', streamSeq: '4', content: { type: 'text_delta', text: 'after-time-window' }
          }));
          liveHeartbeat = (await get(app, 'ModelRequest', request.modelRequestId)).stream_stats_json;
          results.push(await controls.onEvent({
            kind: 'output_item_done', streamSeq: '5', content: { type: 'thought_done' }
          }));
          results.push(await controls.onEvent({
            kind: 'completed', streamSeq: '6', content: modelContent('done')
          }));
        }
      });
    } finally {
      provider.epochNow = originalEpochNow;
    }
    assert.deepEqual(results.map((result) => [result.checkpointed, result.ignoredReason ?? null]), [
      [true, null],
      [false, 'coalesced'],
      [false, 'coalesced'],
      [false, 'coalesced'],
      [true, null],
      [true, null]
    ]);
    assert.equal(liveHeartbeat.lastStreamSeq, '4');
    assert.equal(liveHeartbeat.lastStreamEventAt, 15_000);
    const durableRequest = await get(app, 'ModelRequest', request.modelRequestId);
    assert.equal(durableRequest.stream_stats_json.lastStreamSeq, undefined,
      'terminal summary replaces live heartbeat fields with authoritative terminal timing');
    const checkpoints = await list(app, 'ModelStreamCheckpoint', { model_request_id: request.modelRequestId });
    assert.equal(checkpoints.filter((row) => row.checkpoint_kind === 'output_item_done').length, 1);
  });
});

test('Provider semantic checkpoint overflow 有界合并且 terminal summary 仍可提交', async () => {
  await withApp('provider-semantic-checkpoint-overflow', async (app, conversationId, turnId) => {
    const request = await createRequest(app, conversationId, turnId, 'semantic-checkpoint-overflow');
    const results = [];
    await controlPlane(app, {
      // This fixture intentionally performs 41 sequential SQLite transactions. Keep the semantic
      // deadline above test-runner/worker scheduling jitter; the dedicated commit-stall case below
      // owns the short watchdog boundary.
      semanticTimeouts: { firstSemanticMs: 500, semanticIdleMs: 500 }
    }).dispatch(request.modelRequestId, {
      providerId: 'provider-watchdog',
      async sendFullRequest(_request, controls) {
        await controls.onEvent({
          kind: 'output_delta', streamSeq: '1', content: { type: 'text_delta', text: 'first' }
        });
        for (let item = 1; item <= 40; item += 1) {
          results.push(await controls.onEvent({
            kind: 'output_item_done',
            streamSeq: String(item + 1),
            content: { type: 'synthetic_item', item }
          }));
        }
        results.push(await controls.onEvent({
          kind: 'completed', streamSeq: '42',
          content: modelContent('terminal survives capacity')
        }));
      }
    });
    const durableRequest = await get(app, 'ModelRequest', request.modelRequestId);
    assert.equal(durableRequest.status, 'terminal');
    assert.equal(durableRequest.terminal_state, 'completed');
    assert.ok(results.some((result) => result.ignoredReason === 'checkpoint-capacity'));
    assert.equal(results.at(-1).terminal, true);
    const checkpoints = await list(app, 'ModelStreamCheckpoint', {
      model_request_id: request.modelRequestId
    });
    assert.equal(checkpoints.length, 33);
    assert.equal(checkpoints.filter((row) => row.checkpoint_kind === 'terminal_summary').length, 1);
  });
});

test('native control and tool admission checkpoints remain durable after visual checkpoint coalescing', async () => {
  const { MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT } = await import(pathToFileURL(
    path.join(compiledRoot, 'backend/reliableKernel/databaseWorkerProtocol.js')
  ).href);
  const normalItemCount = MODEL_STREAM_ACTIVE_CHECKPOINT_LIMIT + 1;
  await withApp('provider-native-critical-checkpoints', async (app, conversationId, turnId) => {
    const request = await createRequest(app, conversationId, turnId, 'native-critical-checkpoints');
    let ordinaryCoalesced = false;
    const durableIds = [];
    await controlPlane(app, {
      semanticTimeouts: { firstSemanticMs: 10_000, semanticIdleMs: 10_000 }
    }).dispatch(request.modelRequestId, {
      providerId: 'provider-watchdog',
      async sendFullRequest(fullRequest, controls) {
        for (let item = 1; item <= normalItemCount; item += 1) {
          const result = await controls.onEvent({
            kind: 'output_item_done',
            streamSeq: String(item),
            content: { type: 'synthetic_item', item }
          });
          ordinaryCoalesced ||= result.ignoredReason === 'checkpoint-capacity';
        }
        let sequence = BigInt(normalItemCount);
        for (const checkpointKind of ['native_control', 'native_tool_call']) {
          sequence += 1n;
          const checkpointId = `${request.modelRequestId}-${checkpointKind}`;
          const content = await app.contentStore.prepare(
            app.database,
            JSON.stringify({ kind: checkpointKind, streamSeq: sequence.toString() }),
            'application/json'
          );
          const committed = await app.database.commitModelStreamEvent({
            modelRequestId: request.modelRequestId,
            checkpointId,
            attemptSeq: BigInt(fullRequest.attemptSeq),
            socketGeneration: BigInt(fullRequest.socketGeneration),
            streamSeq: sequence,
            checkpointKind,
            terminalFenceId: null,
            contentObject: content.metadata,
            ...(content.insert ? { contentInsert: content.insert } : {}),
            usage: null,
            terminalStats: null,
            now: new Date().toISOString()
          });
          assert.equal(committed.checkpointed, true, `${checkpointKind} must authorize durable recovery, not just transient display`);
          const persisted = await get(app, 'ModelStreamCheckpoint', checkpointId);
          assert.equal(persisted.content_object_id, content.metadata.id);
          durableIds.push(checkpointId);
        }
        await controls.onEvent({
          kind: 'completed', streamSeq: String(sequence + 1n),
          content: modelContent('native facts survived checkpoint pressure')
        });
      }
    });
    assert.equal(ordinaryCoalesced, true);
    for (const id of durableIds) assert.ok(await get(app, 'ModelStreamCheckpoint', id));
    assert.equal((await get(app, 'ModelRequest', request.modelRequestId)).terminal_state, 'completed');
  });
});

test('单条 thought 后的合法静默在 idle 边界内完成且不创建重试 Attempt', async () => {
  await withApp('provider-legitimate-thought-silence', async (app, conversationId, turnId) => {
    const provider = controlPlane(app, {
      // 合法静默只需小于 idle 边界；并行测试负载下 SQLite/CAS 调度抖动可达数百毫秒，
      // 边界留足余量，避免把测试环境抖动误判成看门狗误触发。
      semanticTimeouts: {
        firstSemanticMs: 1_000,
        semanticIdleMs: 1_000,
        compressionCompletionMs: 2_000
      }
    });
    const request = await createRequest(app, conversationId, turnId, 'legitimate-thought-silence');
    let calls = 0;
    await provider.dispatch(request.modelRequestId, {
      providerId: 'provider-watchdog',
      async sendFullRequest(_request, controls) {
        calls += 1;
        await controls.onEvent({
          kind: 'output_delta', streamSeq: '1',
          content: { type: 'thought_delta', text: 'planning one long step' }
        });
        await sleep(80);
        await controls.onEvent({
          kind: 'completed', streamSeq: '2',
          content: modelContent('completed without reconnect')
        });
      }
    });
    assert.equal(calls, 1);
    const operation = (await list(app, 'Operation', {
      owner_kind: 'model_request', owner_id: request.modelRequestId
    }))[0];
    assert.equal((await list(app, 'Attempt', { operation_id: operation.id })).length, 1);
  });
});

test('正常 semantic progress 会刷新 idle watchdog，首语义 black-hole 会自动 retry', async () => {
  await withApp('provider-semantic-progress', async (app, conversationId, turnId) => {
    const provider = controlPlane(app, {
      // Repeated progress must outlive the first-event deadline, while the idle deadline allows
      // ordinary SQLite scheduling jitter now that it intentionally stays armed during each commit.
      semanticTimeouts: { firstSemanticMs: 50, semanticIdleMs: 150 }
    });
    const progressing = await createRequest(app, conversationId, turnId, 'normal-semantic-progress');
    let progressCalls = 0;
    await provider.dispatch(progressing.modelRequestId, {
      providerId: 'provider-watchdog',
      async sendFullRequest(_request, controls) {
        progressCalls += 1;
        for (let seq = 1; seq <= 4; seq += 1) {
          await sleep(20);
          await controls.onEvent({
            kind: 'output_delta', streamSeq: String(seq),
            content: { type: 'thought_delta', text: `semantic-${seq}` }
          });
        }
        await controls.onEvent({
          kind: 'completed', streamSeq: '5', content: modelContent('normal')
        });
      }
    });
    assert.equal(progressCalls, 1);

    const firstEventBlackHole = await createRequest(app, conversationId, turnId, 'first-semantic-timeout');
    const terminals = [];
    let blackHoleCalls = 0;
    await provider.dispatch(firstEventBlackHole.modelRequestId, {
      providerId: 'provider-watchdog',
      async sendFullRequest(request, controls) {
        blackHoleCalls += 1;
        if (request.attemptSeq === '1') {
          await new Promise((resolve) => controls.signal.addEventListener('abort', resolve, { once: true }));
          const aborted = new Error('first semantic watchdog abort');
          aborted.name = 'AbortError';
          throw aborted;
        }
        await controls.onEvent({
          kind: 'completed', streamSeq: '1', content: modelContent('first timeout recovered')
        });
      }
    }, { onTransientTerminal: (event) => terminals.push(event) });
    assert.equal(blackHoleCalls, 2);
    assert.ok(terminals.some((entry) =>
      entry.event.content.terminalState === 'provider_transient_first_semantic_timeout'
    ));
  });
});

test('Provider 在 durable stream event 提交阻塞时仍保持 semantic idle watchdog', async () => {
  await withApp('provider-semantic-commit-stall', async (app, conversationId, turnId) => {
    const provider = controlPlane(app, {
      semanticTimeouts: { firstSemanticMs: 120, semanticIdleMs: 35 }
    });
    const request = await createRequest(app, conversationId, turnId, 'semantic-commit-stall');
    const originalCommit = app.database.commitModelStreamEvent.bind(app.database);
    let releaseCommit;
    let commitStarted;
    const commitStartedPromise = new Promise((resolve) => { commitStarted = resolve; });
    const releaseCommitPromise = new Promise((resolve) => { releaseCommit = resolve; });
    app.database.commitModelStreamEvent = async (input) => {
      if (input.modelRequestId !== request.modelRequestId) return originalCommit(input);
      commitStarted();
      await releaseCommitPromise;
      return originalCommit(input);
    };
    const dispatch = provider.dispatch(request.modelRequestId, {
      providerId: 'provider-watchdog',
      async sendFullRequest(_request, controls) {
        await controls.onEvent({
          kind: 'output_delta', streamSeq: '1',
          content: { type: 'thought_delta', text: 'checkpoint blocks' }
        });
      }
    }, { timeoutMs: 500 });
    try {
      await commitStartedPromise;
      // 关键语义是 semantic idle watchdog 判定 stream_stalled；不要用品尝墙钟时间断言，
      // retryAfterOutput 允许多个 Attempt 后，Windows/CI 负载下 300ms 阈值会稳定误报。
      await assert.rejects(dispatch, (error) =>
        error?.reason === 'stream_stalled' && /no semantic progress for 35ms/.test(error.message));
    } finally {
      releaseCommit();
      app.database.commitModelStreamEvent = originalCommit;
    }
  });
});

test('transient failures 达到冻结上限后才终止，408/425/429/5xx 均可分类为自动 retry', async () => {
  await withApp('provider-retry-exhaustion', async (app, conversationId, turnId) => {
    const request = await createRequest(app, conversationId, turnId, 'retry-exhaustion');
    const provider = controlPlane(app);
    let calls = 0;
    await assert.rejects(provider.dispatch(request.modelRequestId, {
      providerId: 'provider-watchdog',
      async sendFullRequest() {
        calls += 1;
        throw new kernel.ProviderTransientError('temporary_service_error', `exhaust-${calls}`);
      }
    }), /exhaust-4/);
    assert.equal(calls, 4);
    const terminal = await get(app, 'ModelRequest', request.modelRequestId);
    assert.equal(terminal.status, 'terminal');
    assert.equal(terminal.terminal_state, 'provider_transient_temporary_service_error');
  });

  async function classifiedStatus(status) {
    const capability = {
      start(request, emit) {
        emit({
          type: 'llm:error',
          payload: { requestId: request.id, message: `HTTP ${status}`, rawError: { status } }
        });
      },
      compact() { throw new Error('unused'); }, abort() {}, cancelRetry() {}, dispose() {}, listModels: async () => []
    };
    const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-watchdog', capability);
    return adapter.sendFullRequest({
      kind: 'full-model-request', modelRequestId: `status-${status}`,
      conversationId: 'conversation-status',
      attemptSeq: '1', socketGeneration: '1', providerId: 'provider-watchdog', modelId: 'model-watchdog',
      authoritySnapshot: {
        model: { provider: 'openai-responses' },
        toolPolicy: { allowedTools: [], preset: 'custom', sourceConfigs: {} }
      },
      recipe: { tools: [] }, context: [],
      attachmentCatalogState: { catalog: [], placements: [] }
    }, { onEvent: async () => ({ accepted: true, checkpointed: true, terminal: false }) });
  }
  for (const status of [408, 425, 429, 500, 503]) {
    await assert.rejects(classifiedStatus(status), (error) => error instanceof kernel.ProviderTransientError);
  }
});

test('所有可恢复的 Responses 终态前关闭都会创建 durable Attempt 2 并自动恢复', async () => {
  for (const fixture of [
    { closeCode: 1000, reason: '' },
    { closeCode: 1001, reason: ' Going Away' },
    { closeCode: 1005, reason: ' No Status Received' },
    { closeCode: 1006, reason: ' Abnormal Closure' },
    { closeCode: 1008, reason: ' Policy Violation' },
    { closeCode: 1011, reason: ' Internal Error' },
    { closeCode: 1012, reason: ' Service Restart' },
    { closeCode: 1013, reason: ' Try Again Later' },
    { closeCode: 1014, reason: ' Bad Gateway' },
    { closeCode: 1015, reason: ' TLS Handshake' }
  ]) {
    await withApp(`provider-pre-terminal-close-${fixture.closeCode}`, async (app, conversationId, turnId) => {
      const request = await createRequest(app, conversationId, turnId, `pre-terminal-close-${fixture.closeCode}`);
      const message = `OpenAI Responses WebSocket closed before terminal event: ${fixture.closeCode}${fixture.reason}`;
      let calls = 0;
      const capability = {
        start(llmRequest, emit) {
          calls += 1;
          if (calls === 1) {
            emit({
              type: 'llm:error',
              payload: {
                requestId: llmRequest.id,
                message,
                rawError: {
                  name: 'WebSocketCloseError',
                  message,
                  closeCode: fixture.closeCode,
                  phase: 'awaiting_first_event',
                  receivedServerEvent: false,
                  retryable: false,
                  transportAttemptsExhausted: false
                }
              }
            });
            return;
          }
          emit({ type: 'llm:done', payload: { requestId: llmRequest.id, completedAt: Date.now() } });
        },
        compact() { throw new Error('unused'); },
        abort() {}, cancelRetry() {}, dispose() {}, listModels: async () => []
      };
      const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-watchdog', capability);
      await controlPlane(app, {
        semanticTimeouts: { firstSemanticMs: 500, semanticIdleMs: 500 }
      }).dispatch(request.modelRequestId, adapter);

      assert.equal(calls, 2);
      assert.equal((await get(app, 'ModelRequest', request.modelRequestId)).terminal_state, 'completed');
      const operation = (await list(app, 'Operation', {
        owner_kind: 'model_request', owner_id: request.modelRequestId
      }))[0];
      const attempts = (await list(app, 'Attempt', { operation_id: operation.id }))
        .slice()
        .sort((left, right) => Number(left.attempt_seq) - Number(right.attempt_seq));
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0].status, 'transient_failed');
      assert.equal(attempts[1].status, 'completed');
    });
  }
});

test('配置的终态前关闭在文本、思考或工具输出后仍切换 Attempt，最终只采纳恢复输出', async () => {
  for (const fixture of [
    {
      closeCode: 1013,
      reason: 'upstream websocket disconnected; please reconnect',
      emitPartial(requestId, emit) {
        emit({ type: 'llm:delta', payload: { requestId, text: 'discarded text' } });
      }
    },
    {
      closeCode: 1006,
      reason: 'abnormal closure',
      emitPartial(requestId, emit) {
        emit({
          type: 'llm:thoughtDelta',
          payload: { requestId, text: 'discarded thought', thoughtStartedAt: Date.now(), thoughtElapsedMs: 1 }
        });
      }
    },
    {
      closeCode: 1008,
      reason: 'policy violation',
      emitPartial(requestId, emit) {
        emit({
          type: 'llm:toolCallDelta',
          payload: {
            requestId,
            calls: [{ id: 'discarded-call', name: 'echo', argumentsDelta: '{"partial":', streamIndex: '0' }]
          }
        });
      }
    }
  ]) {
    await withApp(`provider-close-after-output-${fixture.closeCode}`, async (app, conversationId, turnId) => {
      const request = await createRequest(app, conversationId, turnId, `close-after-output-${fixture.closeCode}`);
      const message = `OpenAI Responses WebSocket closed before terminal event: ${fixture.closeCode} ${fixture.reason}`;
      const terminals = [];
      let calls = 0;
      const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-watchdog', {
        start(llmRequest, emit) {
          calls += 1;
          if (calls === 1) {
            fixture.emitPartial(llmRequest.id, emit);
            emit({
              type: 'llm:error',
              payload: {
                requestId: llmRequest.id,
                message,
                rawError: {
                  name: 'WebSocketCloseError',
                  message,
                  closeCode: fixture.closeCode,
                  phase: 'streaming',
                  receivedServerEvent: true,
                  receivedSemanticOutput: true,
                  retryable: false,
                  transportAttemptsExhausted: false
                }
              }
            });
            return;
          }
          emit({ type: 'llm:delta', payload: { requestId: llmRequest.id, text: `recovered-${fixture.closeCode}` } });
          emit({ type: 'llm:done', payload: { requestId: llmRequest.id, completedAt: Date.now() } });
        },
        compact() { throw new Error('unused'); },
        abort() {}, cancelRetry() {}, dispose() {}, listModels: async () => []
      });

      await controlPlane(app).dispatch(request.modelRequestId, adapter, {
        onTransientTerminal: (terminal) => terminals.push(terminal)
      });

      assert.equal(calls, 2);
      const durableRequest = await get(app, 'ModelRequest', request.modelRequestId);
      assert.equal(durableRequest.terminal_state, 'completed');
      assert.equal(durableRequest.stream_stats_json.attemptSeq, '2');
      const operation = (await list(app, 'Operation', {
        owner_kind: 'model_request', owner_id: request.modelRequestId
      }))[0];
      const attempts = (await list(app, 'Attempt', { operation_id: operation.id }))
        .slice()
        .sort((left, right) => Number(left.attempt_seq) - Number(right.attempt_seq));
      assert.deepEqual(attempts.map((entry) => entry.status), ['transient_failed', 'completed']);
      assert.ok(terminals.some((terminal) =>
        terminal.attemptSeq === '1'
        && terminal.event.content.retrying === true
        && terminal.event.content.discardOutput === true
      ));
      const completed = await app.modelProvider.completedEvent(request.modelRequestId);
      assert.deepEqual(completed.content, modelContent(`recovered-${fixture.closeCode}`));
      const checkpoints = await list(app, 'ModelStreamCheckpoint', { model_request_id: request.modelRequestId });
      assert.ok(checkpoints.length > 0);
      assert.ok(checkpoints.every((checkpoint) => checkpoint.attempt_seq === 2n),
        'terminal prune must discard every failed-Attempt checkpoint');
    });
  }
});

test('response.created 后首语义前 EOF 仍会创建 durable Attempt 2 并自动恢复', async () => {
  await withApp('provider-created-before-eof', async (app, conversationId, turnId) => {
    const request = await createRequest(app, conversationId, turnId, 'created-before-eof');
    let calls = 0;
    const capability = {
      start(llmRequest, emit) {
        calls += 1;
        if (calls === 1) {
          emit({
            type: 'llm:error',
            payload: {
              requestId: llmRequest.id,
              message: 'OpenAI Responses WebSocket closed after response.created',
              rawError: {
                name: 'WebSocketCloseError',
                message: 'OpenAI Responses WebSocket closed before terminal event: 1000',
                closeCode: 1000,
                phase: 'streaming',
                receivedServerEvent: true,
                receivedSemanticOutput: false,
                retryable: true,
                transportAttemptsExhausted: false
              }
            }
          });
          return;
        }
        emit({ type: 'llm:done', payload: { requestId: llmRequest.id, completedAt: Date.now() } });
      },
      compact() { throw new Error('unused'); },
      abort() {}, cancelRetry() {}, dispose() {}, listModels: async () => []
    };
    const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-watchdog', capability);
    await controlPlane(app).dispatch(request.modelRequestId, adapter);

    assert.equal(calls, 2);
    assert.equal((await get(app, 'ModelRequest', request.modelRequestId)).terminal_state, 'completed');
    const operation = (await list(app, 'Operation', {
      owner_kind: 'model_request', owner_id: request.modelRequestId
    }))[0];
    const attempts = await list(app, 'Attempt', { operation_id: operation.id });
    assert.equal(attempts.length, 2);
    assert.equal(attempts.filter((entry) => entry.status === 'transient_failed').length, 1);
  });
});

test('0.1.35 retryable/error metadata映射为持久 retry authority，exhausted 与永久错误保持终态', async () => {
  async function runRawError(rawError) {
    const capability = {
      start(request, emit) {
        emit({ type: 'llm:error', payload: { requestId: request.id, message: rawError.message, rawError } });
      },
      compact() { throw new Error('unused'); },
      abort() {},
      cancelRetry() {},
      dispose() {},
      listModels: async () => []
    };
    const adapter = new kernel.LlmCapabilityFullRequestAdapter('provider-watchdog', capability);
    return adapter.sendFullRequest({
      kind: 'full-model-request',
      modelRequestId: `metadata-${Math.random()}`,
      conversationId: 'conversation-metadata',
      attemptSeq: '1', socketGeneration: '1',
      providerId: 'provider-watchdog', modelId: 'model-watchdog',
      authoritySnapshot: {
        model: { provider: 'openai-responses' },
        toolPolicy: { allowedTools: [], preset: 'custom', sourceConfigs: {} }
      },
      recipe: { tools: [] }, context: [],
      attachmentCatalogState: { catalog: [], placements: [] }
    }, { onEvent: async () => ({ accepted: true, checkpointed: true, terminal: false }) });
  }

  await assert.rejects(
    runRawError({ message: 'gateway reset', transport: 'websocket', retryable: true }),
    (error) => error instanceof kernel.ProviderTransientError && error.reason === 'connection_interrupted'
  );
  await assert.rejects(
    runRawError({ message: 'Unexpected server response: 429', transport: 'websocket' }),
    (error) => error instanceof kernel.ProviderTransientError && error.reason === 'rate_limited'
  );
  await assert.rejects(
    runRawError({
      message: 'OpenAI Responses WebSocket closed before terminal event: 1006 Abnormal Closure',
      closeCode: 1006,
      phase: 'awaiting_first_event',
      receivedServerEvent: false,
      receivedSemanticOutput: false,
      retryable: false,
      transportAttemptsExhausted: false
    }),
    (error) => error instanceof kernel.ProviderTransientError && error.reason === 'connection_interrupted'
  );
  await assert.rejects(
    runRawError({
      message: 'OpenAI Responses WebSocket closed before terminal event: 1000',
      closeCode: 1000,
      phase: 'awaiting_first_event',
      receivedServerEvent: false,
      receivedSemanticOutput: false,
      retryable: false,
      transportAttemptsExhausted: false
    }),
    (error) => error instanceof kernel.ProviderTransientError && error.reason === 'connection_interrupted'
  );
  await assert.rejects(
    runRawError({
      message: 'OpenAI Responses WebSocket closed before terminal event: 1000',
      closeCode: 1000,
      phase: 'streaming',
      receivedServerEvent: true,
      receivedSemanticOutput: false,
      retryable: true,
      transportAttemptsExhausted: false
    }),
    (error) => error instanceof kernel.ProviderTransientError
      && error.reason === 'connection_interrupted'
  );
  await assert.rejects(
    runRawError({
      message: 'OpenAI Responses WebSocket closed before terminal event: 1008 policy violation',
      closeCode: 1008,
      phase: 'streaming',
      receivedServerEvent: true,
      receivedSemanticOutput: true,
      retryable: false,
      transportAttemptsExhausted: false
    }),
    (error) => error instanceof kernel.ProviderTransientError
      && error.reason === 'connection_interrupted'
      && error.retryAfterOutput === true
  );
  await assert.rejects(
    runRawError({ message: 'transport exhausted', retryable: true, transportAttemptsExhausted: true }),
    (error) => !(error instanceof kernel.ProviderTransientError)
  );
  await assert.rejects(
    runRawError({ message: 'context length exceeded', status: 400, retryable: false }),
    (error) => !(error instanceof kernel.ProviderTransientError)
  );
});
