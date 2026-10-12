import assert from 'node:assert/strict';

import fs from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import { createRequire } from 'node:module';

import { setTimeout as delay } from 'node:timers/promises';

import test from 'node:test';

const require = createRequire(import.meta.url);

const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');

const load = file => require(path.join(compiled, file));

const kernel = load('backend/reliableKernel/index.js');

const { emptyConversationContextHandleStateStep } = load('backend/reliableKernel/conversationContextHandleState.js');

const { OpenAIResponsesNativeDeliveryError } = load('backend/capabilities/openAIResponsesNativeControl.js');

const capabilityModule = load('shared/modelCapabilities.js');

const capabilities = { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false, explicitCaching: true };

const syncDefinition = { name: 'native_probe', description: 'one synchronous native tool', parameters: { type: 'object' } };

const asyncDefinition = { name: 'native_async_probe', description: 'one asynchronous native tool',
  parameters: { type: 'object' }, metadata: { nativeAsync: true } };

const CONVERSATION = 'native-chain-recovery';

const rows = async (app, domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain)
  .list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function waitFor(predicate, label, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

/** Per provider call id: native call occurrences and result-pair occurrences one full request carries. */
function nativeToolPairs(request) {
  const calls = new Map();
  for (const item of request.context) {
    if (item.contentType !== 'application/vnd.limcode.context-tool-pair+json') continue;
    const pair = JSON.parse(item.content);
    const id = pair.toolCall.providerCallId ?? pair.toolCall.id;
    const entry = calls.get(id) ?? { calls: 0, results: 0 };
    if (pair.toolModelResult) entry.results += 1; else entry.calls += 1;
    calls.set(id, entry);
  }
  return calls;
}

async function emitCall(emit, responseId, callId, index, { async = false } = {}) {
  await emit('output_item_done', {
    type: 'tool_calls',
    calls: [{ id: callId, ordinal: index, name: async ? 'native_async_probe' : 'native_probe',
      arguments: { callId }, ...(async ? { async: true } : {}) }],
    outputItem: { id: `item-${callId}`, ordinal: index, providerResponseId: responseId }
  });
}

async function emitFinalText(emit, responseId, text) {
  await emit('native_control', { type: 'response.created', responseId, capabilities });
  await emit('native_control', { type: 'response.completed', responseId,
    usage: { input_tokens: 220, output_tokens: 5 } });
  await emit('completed', { role: 'model', parts: [{ text }] });
}

function authorityFor(request, options) {
  const compression = options.compressionThreshold === undefined ? undefined : (() => {
    const compressionCapabilities = capabilityModule.resolveModelCapabilities({
      provider: 'openai-compatible', baseUrl: 'https://native-chain-compression.invalid/v1',
      modelId: 'summary-model', providerConfigId: 'summary-provider', transport: 'http'
    });
    return {
      enabled: true,
      methodKind: 'llm_summary',
      executionPlan: capabilityModule.resolveCompressionExecutionPlan({ kind: 'llm_summary', fallbacks: [] }, compressionCapabilities),
      thresholdTokens: options.compressionThreshold,
      config: { id: 'native-chain-compression', name: 'native chain compression', kind: 'llm_summary',
        trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: options.compressionThreshold } },
      provider: { providerConfigId: 'summary-provider', provider: 'openai-compatible', modelId: 'summary-model',
        capabilities: compressionCapabilities,
        summaryReasoning: capabilityModule.resolveSummaryReasoning({ mode: 'provider_default', capabilities: compressionCapabilities }),
        contextWindowTokens: 200000, maxOutputTokens: 16000 }
    };
  })();
  return {
    turnId: request.turnId, executorAgentId: request.executorAgentId,
    executionPreset: { content: JSON.stringify({ providerConfigId: 'native-provider', modelId: 'gpt-6-astra' }) },
    authoritySnapshot: { content: JSON.stringify({ kind: 'effective-turn-authority',
      turnId: request.turnId, conversationId: request.conversationId, executorAgentId: request.executorAgentId,
      model: { providerConfigId: 'native-provider', provider: 'openai-responses', modelId: 'gpt-6-astra',
        baseUrl: 'https://native-chain-recovery.invalid/v1',
        // Provider steering is a WebSocket capability; every other scenario uses HTTP.
        openaiResponsesTransport: options.steer ? 'websocket' : 'http',
        nativeResponses: { enabled: true, asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false },
        retryPolicy: options.retryPolicy ?? { enabled: false, maxRetries: 0 } },
      modelProfile: { compressionThresholdTokens: options.threshold ?? 1000000,
        contextWindowTokens: options.window ?? 1200000,
        tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
      ...(compression ? { compression } : {}),
      toolPolicy: { id: 'native-tools', allowedTools: ['native_probe', 'native_async_probe'], preset: 'custom',
        toolConfigs: {}, sourceConfigs: {} },
      planReviewPolicy: { mode: 'never' }, systemPrompt: { id: 'prompt', text: '' },
      runtimeContext: { id: null, name: '', template: '' },
      workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
    }) }
  };
}

/**
 * Scripted native transport over the real fenced SQLite/CAS kernel. `script` runs one physical
 * logical request per sendFullRequest. The tool dispatcher models the real Host guard: an admitted
 * call that is dispatched again while its execution is still running is refused as "already
 * active" (and recorded), exactly like the production dispatcher.
 */
async function withNativeKernel(options, verify) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-chain-recovery-'));
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  const requests = [];
  const summaryRequests = [];
  const executions = [];
  const duplicates = [];
  const submissions = [];
  const ended = [];
  const gates = new Map();
  const running = new Set();
  const shared = {};
  let app;
  const adapter = {
    providerId: 'native-provider',
    async materializeNativeToolOutput(outputs) { return outputs; },
    async sendFullRequest(request, controls) {
      const round = requests.length;
      requests.push(request);
      const responseId = `response-${round}`;
      let sequence = 0;
      const emit = (kind, content) => controls.onEvent({ kind, streamSeq: String(++sequence), content });
      const end = deferred();
      const live = { responseId };
      controls.native.onController({
        get responseId() { return live.responseId; },
        endLogicalRequest() { ended.push(round); end.resolve(); },
        async steer(command) {
          if (!options.steer) throw new Error('No steering in this fixture.');
          await options.steer({ command, emit, live, round });
        },
        async submitToolResults(outputs) {
          submissions.push(outputs.map(output => output.callId));
          if (options.submit) return options.submit({ outputs, emit, live, round });
          throw new OpenAIResponsesNativeDeliveryError('admission_unknown', 'fixture result write outlived its deadline', {
            reason: 'result_send_outcome_unverified', callIds: outputs.map(output => output.callId)
          });
        }
      });
      try {
        await options.script({ round, request, controls, emit, responseId, live, ended: end, app, shared });
      } finally {
        controls.native.onController(undefined);
      }
    }
  };
  const dependencies = {
    authorityCompiler: { async compile(request) { return authorityFor(request, options); } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('unexpected MCP call'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
    providers: { resolve(providerId) {
      if (providerId !== 'summary-provider') return adapter;
      return { providerId, async sendFullRequest(request, controls) {
        summaryRequests.push(request);
        if (options.summary) return options.summary({ request, controls, app });
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { type: 'compression_result',
          contents: [{ role: 'model', parts: [{ text: 'Earlier useful history is preserved in this short summary.' }] }] } });
      } };
    } },
    toolDispatcher: {
      definitions() { return [syncDefinition, asyncDefinition]; },
      async dispatch(input) {
        // Ordinary (never natively admitted) calls of the terminal batch.
        executions.push(input.providerCallId);
        const settled = await app.runtime.effects.settleWithoutEffect({
          source: { kind: 'internal', key: `native-chain-ordinary:${input.toolCallId}` },
          toolCallId: input.toolCallId, status: 'succeeded', detail: { ok: true, callId: input.providerCallId,
            ...(options.toolResultParts ? { parts: options.toolResultParts } : {}) }
        });
        return settled.terminal;
      },
      async scheduleAdmittedCall(input) {
        if (running.has(input.toolCallId)) {
          duplicates.push(input.providerCallId);
          throw new Error(`ToolCall ${input.toolCallId} already has an active host execution.`);
        }
        running.add(input.toolCallId);
        executions.push(input.providerCallId);
        if (options.background?.includes(input.providerCallId)) {
          // A background effect: the dispatcher returns a pause and its result settles later.
          running.delete(input.toolCallId);
          return { disposition: 'paused', toolCallId: input.toolCallId, reason: 'background_process',
            resumeKey: input.toolCallId };
        }
        try {
          const gate = gates.get(input.providerCallId);
          if (gate) await gate.promise;
          const settled = await app.runtime.effects.settleWithoutEffect({
            source: { kind: 'internal', key: `native-chain-recovery:${input.toolCallId}` },
            toolCallId: input.toolCallId, status: 'succeeded', detail: { ok: true, callId: input.providerCallId,
            ...(options.toolResultParts ? { parts: options.toolResultParts } : {}) }
          });
          return settled.terminal;
        } finally {
          running.delete(input.toolCallId);
        }
      }
    }
  };
  const leaseFor = async turnId => {
    const [lease] = await rows(app, 'ExecutionLease', { turn_id: turnId });
    return { id: lease.id, conversationId: lease.conversation_id, turnId: lease.turn_id,
      ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation) };
  };
  const startTurn = async (key, content) => {
    const started = await app.turns.input({ source: { kind: 'command', key }, conversationId: CONVERSATION,
      leaseOwnerId: 'fixture', hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 300000).toISOString(), content });
    return { turnId: started.turnId, fence: await leaseFor(started.turnId) };
  };
  const drive = (turn) => kernel.runWithExecutionLeaseFence(turn.fence, () => app.agentLoop.drive(turn.turnId));
  const driveUntilSettled = async (turn) => {
    for (let index = 0; index < 20; index += 1) {
      const outcome = await drive(turn);
      if (outcome.terminalStatus !== 'waiting') return outcome;
      await delay(20);
    }
    assert.fail('the Turn kept waiting');
  };
  const reopen = async () => {
    await app.close();
    app = await kernel.ReliableKernelApplication.open(root, dependencies);
    return app;
  };
  const recover = async (turnId) => {
    const claimed = await app.turns.claimRecoveryExecution({ turnId, leaseOwnerId: 'recovered-owner',
      hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120000).toISOString() });
    assert.ok(claimed, 'a new Host may claim the orphaned Turn');
    return { turnId, fence: await leaseFor(turnId) };
  };
  try {
    app = await kernel.ReliableKernelApplication.open(root, dependencies);
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: CONVERSATION, title: 'Native chain recovery', status: 'active', created_at: now, updated_at: now
      }),
      emptyConversationContextHandleStateStep(CONVERSATION, now),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: 'native-chain-recovery-agent', conversation_id: CONVERSATION, agent_id: 'agent-main', role: 'default',
        created_at: now, updated_at: now
      })
    ]);
    await verify({ get app() { return app; }, requests, summaryRequests, executions, duplicates, submissions, ended, gates, shared,
      startTurn, drive, driveUntilSettled, reopen, recover, dependencies });
  } finally {
    for (const gate of gates.values()) gate.resolve();
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const retryPolicy = { enabled: true, maxRetries: 2, retryDelayMs: 1 };

async function seedOverflowHistory(app) {
  const content = await app.contentStore.ingest(app.database,
    'Important earlier work and its conclusions. '.repeat(400), 'text/plain');
  const now = new Date().toISOString();
  const messageId = 'overflow-history-message';
  const revisionId = 'overflow-history-revision';
  const plan = await app.context.prepareMessageAppendMutation({ conversationId: CONVERSATION,
    messageRevisionId: revisionId, contentObjectId: content.id, contentByteLength: content.byte_length });
  await app.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Message').insert({ id: messageId, created_at: now, updated_at: now, deleted_at: null }),
    kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').insertWithNextSequence({ id: revisionId,
      message_id: messageId, role: 'model', content_object_id: content.id, created_at: now
    }, { column: 'revision_seq', scope: { message_id: messageId } }),
    kernel.DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({ id: 'overflow-history-current',
      message_id: messageId, revision_id: revisionId, updated_at: now }),
    kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insertWithNextSequence({ id: 'overflow-history-member',
      conversation_id: CONVERSATION, message_id: messageId, created_at: now
    }, { column: 'message_seq', scope: { conversation_id: CONVERSATION } }),
    ...plan.steps
  ]);
}

function nativeOverflow() {
  return Object.assign(new Error('Provider context window exceeded after native progress'), { code: 'CONTEXT_WINDOW_EXCEEDED' });
}

function registerCases(test) {
const restart=true,attachment=true;
test('a settled native effect survives rebase and a later running effect parks re-drives without duplicate dispatch', { timeout: 30000 }, async () => {
  await withNativeKernel({
    retryPolicy,
    async script({ round, request, emit, responseId, app }) {
      assert.equal(request.attemptSeq, '1', 'native recovery never re-sends the frozen input as a second Attempt');
      if (round === 0) {
        await emit('native_control', { type: 'response.created', responseId, capabilities });
        await emitCall(emit, responseId, 'call-A', 0, { async: true });
        await waitFor(async () => (await rows(app, 'ToolModelResult')).length === 1, 'call-A settled');
        await delay(30);
        throw new kernel.ProviderTransientError('connection_interrupted', 'fixture reset after the first tool settled', true);
      }
      assert.deepEqual(nativeToolPairs(request).get('call-A'), { calls: 1, results: 1 },
        'every carrier keeps the already executed result once');
      if (round === 1) {
        await emit('native_control', { type: 'response.created', responseId, capabilities });
        await emitCall(emit, responseId, 'call-slow', 0, { async: true });
        throw new kernel.ProviderTransientError('connection_interrupted', 'fixture reset while the next tool runs', true);
      }
      assert.equal(round, 2);
      assert.deepEqual(nativeToolPairs(request).get('call-slow'), { calls: 1, results: 1 });
      await emitFinalText(emit, responseId, 'continued from both saved results');
    }
  }, async ({ app, requests, executions, duplicates, gates, startTurn, drive }) => {
    gates.set('call-slow', deferred());
    const turn = await startTurn('transient-settled-then-running', 'Run the first and slow probes.');
    const first = await drive(turn);
    assert.equal(first.terminalStatus, 'waiting', 'the second running tool is neither cancelled nor abandoned');
    assert.equal(requests.length, 2, 'only the settled first effect permits a carrier request');
    assert.deepEqual(executions, ['call-A', 'call-slow']);
    const initialRequests = (await rows(app, 'ModelRequest', { turn_id: turn.turnId }))
      .sort((left, right) => Number(left.request_seq) - Number(right.request_seq));
    assert.equal(initialRequests[0].terminal_state, 'native_chain_rebased');
    assert.notEqual(requests[1].modelRequestId, requests[0].modelRequestId);
    const second = await drive(turn);
    assert.equal(second.terminalStatus, 'waiting');
    assert.equal(requests.length, 2, 'a re-drive never freezes a request with the running call unresolved');
    assert.deepEqual(duplicates, [], 'the re-drive attaches to the running execution instead of dispatching again');
    gates.get('call-slow').resolve();
    await waitFor(async () => (await rows(app, 'ToolModelResult')).length === 2, 'the slow result settled');
    let outcome = await drive(turn);
    for (let index = 0; outcome.terminalStatus === 'waiting' && index < 10; index += 1) {
      await delay(20);
      outcome = await drive(turn);
    }
    assert.equal(outcome.terminalStatus, 'completed',
      JSON.stringify(await rows(app, 'TurnTermination', { turn_id: turn.turnId })));
    assert.deepEqual(executions, ['call-A', 'call-slow'], 'each external effect runs once throughout both recoveries');
    assert.deepEqual(duplicates, []);
    for (const result of await rows(app, 'ToolModelResult')) {
      const [outcomeRow] = await rows(app, 'ToolOutcome', { tool_call_id: result.tool_call_id });
      assert.equal(outcomeRow.status, 'succeeded', 'the real result is the call only outcome');
    }
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map(request => request.attemptSeq), ['1', '1', '1']);
    assert.notEqual(requests[2].modelRequestId, requests[1].modelRequestId);
    assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 0,
      'local Context recovery never invents provider delivery');
  });
});
test(`error-driven native rebases share a bounded retry budget${restart ? ' across Host restart' : ''}`, { timeout: 30000 }, async () => {
    await withNativeKernel({
      retryPolicy,
      async script({ round, emit, responseId, app }) {
        assert.ok(round < 3, 'a fresh ModelRequest must not reset the error-recovery budget');
        await emit('native_control', { type: 'response.created', responseId, capabilities });
        await emitCall(emit, responseId, `budget-call-${round}`, 0, { async: true });
        await waitFor(async () => (await rows(app, 'ToolModelResult')).length === round + 1, 'native tool settled');
        throw new kernel.ProviderTransientError('connection_interrupted', 'repeated fixture transport reset', true);
      }
    }, async state => {
      let turn = await state.startTurn(`bounded-native-${restart}`, 'Run the probe.');
      if (restart) {
        const original = state.app.agentLoop.assertNativeErrorRebaseBudget.bind(state.app.agentLoop);
        let interrupted = false;
        state.app.agentLoop.assertNativeErrorRebaseBudget = async (...args) => {
          await original(...args);
          if (!interrupted) { interrupted = true; throw new kernel.ExecutionHandoffError('restart after durable error-rebase seal'); }
        };
        await assert.rejects(state.drive(turn), error => kernel.isExecutionHandoffError(error));
        await state.reopen();
        turn = await state.recover(turn.turnId);
      }
      const outcome = await state.driveUntilSettled(turn);
      assert.equal(outcome.terminalStatus, 'failed');
      assert.equal(state.requests.length, 3, 'initial request plus exactly two recovery requests');
      assert.deepEqual(state.executions, ['budget-call-0', 'budget-call-1', 'budget-call-2']);
      assert.deepEqual(state.duplicates, []);
      const [termination] = await rows(state.app, 'TurnTermination', { turn_id: turn.turnId });
      assert.match(termination.reason, /retry budget/);
      const requests = await rows(state.app, 'ModelRequest', { turn_id: turn.turnId });
      assert.equal(requests.filter(row => row.terminal_state === 'native_chain_rebased'
        && row.stream_stats_json.failure?.category === 'transient').length, 3);
    });
  });
test(`provider context overflow preserves a settled native effect and its result${attachment ? ' with a managed attachment' : ''}${restart ? ' across a committed-repair Host restart' : ''}`,
    { timeout: 30000 }, async () => {
      await withNativeKernel({
        retryPolicy, compressionThreshold: 1000000,
        ...(attachment ? { toolResultParts: [{ inlineData: { mimeType: 'image/png', name: 'native-result.png',
          data: Buffer.from('native-tool-image-bytes').toString('base64'), storage: 'embedded', status: 'available' } }] } : {}),
        async script({ round, request, emit, responseId, app }) {
          if (round === 0) {
            await emit('native_control', { type: 'response.created', responseId, capabilities });
            await emitCall(emit, responseId, 'overflow-once', 0, { async: true });
            await waitFor(async () => (await rows(app, 'ToolModelResult')).length === 1, 'overflow tool settled');
            throw nativeOverflow();
          }
          assert.deepEqual(nativeToolPairs(request).get('overflow-once'), { calls: 1, results: 1 },
            'the repaired full request consumes the already executed result');
          if (attachment) {
            assert.equal(request.recipe.attachmentCatalogState.catalog.length, 1);
            assert.equal(request.resolvedModelHandleCatalog.entries.filter(entry => entry.kind === 'attachment').length, 1);
          }
          await emitFinalText(emit, responseId, 'Completed using the saved native result.');
        }
      }, async state => {
        await seedOverflowHistory(state.app);
        let turn = await state.startTurn(`native-overflow-once-${restart}`, 'Run the native probe.');
        let committed;
        if (restart) {
          const coordinator = state.app.agentLoop.compressionCoordinator;
          const original = coordinator.recoverProviderContextOverflow.bind(coordinator);
          coordinator.recoverProviderContextOverflow = async input => {
            committed = await original(input);
            assert.equal(committed.status, 'compressed');
            throw new kernel.ExecutionHandoffError('restart after durable native overflow repair');
          };
          await assert.rejects(state.drive(turn), error => kernel.isExecutionHandoffError(error));
          assert.equal(state.summaryRequests.length, 1);
          assert.equal(state.requests.length, 1);
          await state.reopen();
          turn = await state.recover(turn.turnId);
        }
        const outcome = await state.driveUntilSettled(turn);
        assert.equal(outcome.terminalStatus, 'completed', JSON.stringify(await rows(state.app, 'TurnTermination')));
        assert.deepEqual(state.executions, ['overflow-once']);
        assert.deepEqual(state.duplicates, []);
        assert.equal(state.requests.length, 2);
        assert.equal(state.summaryRequests.length, 1, 'repair is paid once even after restart');
        assert.equal((await rows(state.app, 'ToolModelResult')).length, 1);
        const [block] = await rows(state.app, 'CompressionBlock');
        assert.ok(block);
        if (committed) assert.equal(block.id, committed.result.compressionBlockId);
        const first = state.requests[0];
        const [frozen] = await rows(state.app, 'ModelContextProjection', { owner_kind: 'model_request', owner_id: first.modelRequestId });
        const repair = state.summaryRequests[0];
        assert.notEqual(repair.recipe.sourceRootId, frozen.root_id, 'the actual closed native frontier is the frozen repair source');
        assert.equal(repair.recipe.providerContextOverflowRequestId, first.modelRequestId);
        if (attachment) {
          assert.equal(first.recipe.attachmentCatalogState.catalog.length, 0);
          assert.equal((await rows(state.app, 'Attachment')).length, 1);
          const attachmentHandles = state.requests[1].resolvedModelHandleCatalog.entries.filter(entry => entry.kind === 'attachment');
          assert.deepEqual(repair.resolvedModelHandleCatalog.entries.filter(entry => entry.kind === 'attachment'), attachmentHandles,
            'the repaired preview and successor preserve the same stable attachment handle');
        }
        assert.deepEqual(repair.authoritySnapshot.toolPolicy, first.authoritySnapshot.toolPolicy);
        assert.equal(state.requests[1].attemptSeq, '1');
        assert.notEqual(state.requests[1].modelRequestId, first.modelRequestId);
      });
    });
}

export { registerCases };
