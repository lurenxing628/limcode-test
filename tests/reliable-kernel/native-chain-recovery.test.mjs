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
const { NativeRequestSession } = load('backend/reliableKernel/nativeRequestSession.js');
const { OpenAIResponsesNativeDeliveryError } = load('backend/capabilities/openAIResponsesNativeControl.js');
const { parseNativeToolCallCheckpoint } = load('backend/reliableKernel/nativeToolFacts.js');
const { nativeFullRequestExceedsBudget } = load('backend/reliableKernel/nativeCompressionGuard.js');
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

async function within(promise, label, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish within ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally {
    clearTimeout(timer);
  }
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

function requestText(request) {
  return request.context.map(item => typeof item.content === 'string' ? item.content : '').join('\n');
}

/** Native calls whose Context call occurrence has no result occurrence: an unresolved Provider call. */
async function unresolvedNativeCalls(app) {
  return (await app.runtime.effects.listNativePendingWork({ conversationId: CONVERSATION }))
    .filter(entry => entry.callContextSegmentId !== undefined && entry.resultContextSegmentId === undefined);
}

async function emitCall(emit, responseId, callId, index, { async = false } = {}) {
  await emit('output_item_done', {
    type: 'tool_calls',
    calls: [{ id: callId, ordinal: index, name: async ? 'native_async_probe' : 'native_probe',
      arguments: { callId }, ...(async ? { async: true } : {}) }],
    outputItem: { id: `item-${callId}`, ordinal: index, providerResponseId: responseId }
  });
}

async function emitToolResponse(emit, responseId, callIds, { usage = { input_tokens: 200, output_tokens: 10 } } = {}) {
  await emit('native_control', { type: 'response.created', responseId, capabilities });
  for (const [index, callId] of callIds.entries()) await emitCall(emit, responseId, callId, index);
  await emit('native_control', { type: 'response.completed', responseId, ...(usage ? { usage } : {}) });
}

async function emitFinalText(emit, responseId, text) {
  await emit('native_control', { type: 'response.created', responseId, capabilities });
  await emit('native_control', { type: 'response.completed', responseId,
    usage: { input_tokens: 220, output_tokens: 5 } });
  await emit('completed', { role: 'model', parts: [{ text }] });
}

function callPart(callId, index, responseId) {
  return { id: callId, functionCall: { name: 'native_probe', args: { callId } },
    outputItem: { id: `item-${callId}`, ordinal: index, providerResponseId: responseId } };
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
    providers: { resolve() { return adapter; } },
    toolDispatcher: {
      definitions() { return [syncDefinition, asyncDefinition]; },
      async dispatch(input) {
        // Ordinary (never natively admitted) calls of the terminal batch.
        executions.push(input.providerCallId);
        const settled = await app.runtime.effects.settleWithoutEffect({
          source: { kind: 'internal', key: `native-chain-ordinary:${input.toolCallId}` },
          toolCallId: input.toolCallId, status: 'succeeded', detail: { ok: true, callId: input.providerCallId }
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
            toolCallId: input.toolCallId, status: 'succeeded', detail: { ok: true, callId: input.providerCallId }
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
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: 'native-chain-recovery-agent', conversation_id: CONVERSATION, agent_id: 'agent-main', role: 'default',
        created_at: now, updated_at: now
      })
    ]);
    await verify({ get app() { return app; }, requests, executions, duplicates, submissions, ended, gates, shared,
      startTurn, drive, driveUntilSettled, reopen, recover, dependencies });
  } finally {
    for (const gate of gates.values()) gate.resolve();
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const retryPolicy = { enabled: true, maxRetries: 2, retryDelayMs: 1 };

async function steerDuring(app, turnId, fence, commandId, text) {
  return kernel.runWithExecutionLeaseFence(fence, () => app.modelProvider.steer({ commandId, turnId,
    conversationId: CONVERSATION, leaseEpoch: fence.generation, content: { role: 'user', parts: [{ text }] } }));
}

const acceptSteer = async ({ command, emit, live }) => {
  await emit('native_control', { type: 'response.steer.submitted', responseId: live.responseId,
    submissionId: command.submissionId });
  await emit('native_control', { type: 'response.steer.accepted', responseId: live.responseId,
    submissionId: command.submissionId, steerId: `provider-${command.submissionId}` });
};

test('a transient failure after a tool executed never retries the frozen input; the Turn continues from Context', { timeout: 30000 }, async () => {
  await withNativeKernel({
    retryPolicy,
    async script({ round, request, emit, responseId, app }) {
      if (round === 0) {
        await emit('native_control', { type: 'response.created', responseId, capabilities });
        await emitCall(emit, responseId, 'call-A', 0, { async: true });
        await waitFor(async () => (await rows(app, 'ToolModelResult')).length === 1, 'call-A settled');
        await delay(30);
        throw new kernel.ProviderTransientError('connection_interrupted', 'fixture socket reset after output', true);
      }
      if (request.attemptSeq !== '1') {
        // A replayed frozen input makes the model re-issue the executed tool under a new identity.
        await emit('native_control', { type: 'response.created', responseId, capabilities });
        await emitCall(emit, responseId, 'call-B', 0, { async: true });
        await emitFinalText(emit, `${responseId}-final`, 'replayed');
        return;
      }
      await emitFinalText(emit, responseId, 'continued from Context');
    }
  }, async ({ app, requests, executions, startTurn, driveUntilSettled }) => {
    const turn = await startTurn('transient-after-tool', 'Run the probe.');
    const outcome = await driveUntilSettled(turn);
    assert.equal(outcome.terminalStatus, 'completed',
      JSON.stringify(await rows(app, 'TurnTermination', { turn_id: turn.turnId })));
    assert.deepEqual(executions, ['call-A'], 'the external effect runs exactly once; no re-issued call');
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(request => request.attemptSeq), ['1', '1'], 'no second Attempt re-sent the frozen input');
    assert.notEqual(requests[1].modelRequestId, requests[0].modelRequestId);
    const modelRequests = (await rows(app, 'ModelRequest', { turn_id: turn.turnId }))
      .sort((left, right) => Number(left.request_seq) - Number(right.request_seq));
    assert.equal(modelRequests[0].terminal_state, 'native_chain_rebased');
    assert.deepEqual(nativeToolPairs(requests[1]).get('call-A'), { calls: 1, results: 1 });
    assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 0);
  });
});

test('a transient failure without chain progress still uses the frozen retry policy', { timeout: 30000 }, async () => {
  await withNativeKernel({
    retryPolicy,
    async script({ round, request, emit, responseId }) {
      if (round === 0) throw new kernel.ProviderTransientError('connection_interrupted', 'reset before any output', true);
      assert.equal(request.attemptSeq, '2');
      await emitFinalText(emit, responseId, 'answer after retry');
    }
  }, async ({ app, requests, startTurn, drive }) => {
    const turn = await startTurn('transient-before-progress', 'Say hello.');
    const outcome = await drive(turn);
    assert.equal(outcome.terminalStatus, 'completed',
      JSON.stringify(await rows(app, 'TurnTermination', { turn_id: turn.turnId })));
    assert.equal(requests.length, 2);
    assert.equal(requests[1].modelRequestId, requests[0].modelRequestId, 'the same request is retried');
  });
});

test('a transient failure while an admitted tool runs parks the Turn; re-drives never dispatch it twice', { timeout: 30000 }, async () => {
  await withNativeKernel({
    retryPolicy,
    async script({ round, request, emit, responseId }) {
      if (round === 0) {
        await emit('native_control', { type: 'response.created', responseId, capabilities });
        await emitCall(emit, responseId, 'call-A', 0, { async: true });
        throw new kernel.ProviderTransientError('connection_interrupted', 'fixture socket reset while the tool runs', true);
      }
      if (request.attemptSeq !== '1') {
        await emit('native_control', { type: 'response.created', responseId, capabilities });
        await emitCall(emit, responseId, 'call-B', 0, { async: true });
        return;
      }
      await emitFinalText(emit, responseId, 'continued after the tool settled');
    }
  }, async ({ app, requests, executions, duplicates, gates, startTurn, drive }) => {
    gates.set('call-A', deferred());
    const turn = await startTurn('transient-while-running', 'Run the slow probe.');
    const first = await drive(turn);
    assert.equal(first.terminalStatus, 'waiting', 'the running admitted tool is neither cancelled nor abandoned');
    assert.equal(requests.length, 1, 'nothing is re-sent while the admitted tool is still running');
    assert.deepEqual(executions, ['call-A']);
    // The runner re-drives a waiting Turn whenever its facts change; the tool is still running.
    const second = await drive(turn);
    assert.equal(second.terminalStatus, 'waiting');
    assert.equal(requests.length, 1, 'a re-drive never freezes a request with the running call unresolved');
    assert.deepEqual(duplicates, [], 'the re-drive attaches to the running execution instead of dispatching again');
    gates.get('call-A').resolve();
    await waitFor(async () => (await rows(app, 'ToolModelResult')).length === 1, 'call-A settled');
    let outcome = await drive(turn);
    for (let index = 0; outcome.terminalStatus === 'waiting' && index < 10; index += 1) {
      await delay(20);
      outcome = await drive(turn);
    }
    assert.equal(outcome.terminalStatus, 'completed',
      JSON.stringify(await rows(app, 'TurnTermination', { turn_id: turn.turnId })));
    assert.deepEqual(executions, ['call-A']);
    assert.deepEqual(duplicates, []);
    const [result] = await rows(app, 'ToolModelResult');
    const [outcomeRow] = await rows(app, 'ToolOutcome', { tool_call_id: result.tool_call_id });
    assert.equal(outcomeRow.status, 'succeeded', 'the real result is the call\'s only outcome');
    assert.equal(requests.length, 2);
    assert.deepEqual(nativeToolPairs(requests[1]).get('call-A'), { calls: 1, results: 1 });
  });
});

test('a Host lost during a transient retry delay still rebases a chain with durable progress', { timeout: 15000 }, async () => {
  await withNativeKernel({
    retryPolicy: { enabled: true, maxRetries: 2, retryDelayMs: 20000 },
    async script({ round, controls, emit, responseId, app }) {
      if (round === 0) {
        await emit('native_control', { type: 'response.created', responseId, capabilities });
        await emitCall(emit, responseId, 'call-A', 0, { async: true });
        await waitFor(async () => (await rows(app, 'ToolModelResult')).length === 1, 'call-A settled');
        await new Promise(resolve => controls.signal.addEventListener('abort', resolve, { once: true }));
        return;
      }
      await emitFinalText(emit, responseId, 'continued after the retry-delay handoff');
    }
  }, async (state) => {
    const { requests, executions, startTurn, drive, reopen, recover } = state;
    const turn = await startTurn('retrying-host-loss', 'Run the probe.');
    const driving = drive(turn);
    void driving.catch(() => undefined);
    await waitFor(async () => (await rows(state.app, 'ToolModelResult')).length === 1, 'call-A settled');
    await delay(30);
    await state.app.modelProvider.quiesceAllActiveDispatches(new kernel.ExecutionHandoffError('fixture Host loss'));
    await assert.rejects(driving, error => kernel.isExecutionHandoffError(error));
    await reopen();
    const recovered = await recover(turn.turnId);
    const [request] = await rows(state.app, 'ModelRequest', { turn_id: turn.turnId });
    // An older build (or any pre-progress failure) left this request parked between Attempts.
    const abort = new AbortController();
    const parked = kernel.runWithExecutionLeaseFence(recovered.fence, () => state.app.modelProvider.dispatch(request.id, {
      providerId: 'native-provider',
      async sendFullRequest() { throw new kernel.ProviderTransientError('connection_interrupted', 'reset', true); }
    }, { reconnect: true, signal: abort.signal }));
    void parked.catch(() => undefined);
    await waitFor(async () => (await rows(state.app, 'ModelRequest', { id: request.id }))[0].status === 'retrying',
      'request parked in its retry delay');
    abort.abort(new kernel.ExecutionHandoffError('fixture Host loss during the retry delay'));
    await assert.rejects(parked, error => kernel.isExecutionHandoffError(error));
    const [retrying] = await rows(state.app, 'ModelRequest', { id: request.id });
    assert.equal(retrying.status, 'retrying');
    const outcome = await drive(recovered);
    assert.equal(outcome.terminalStatus, 'completed',
      JSON.stringify(await rows(state.app, 'TurnTermination', { turn_id: turn.turnId })));
    assert.equal(requests.length, 2, 'the parked Attempt never re-sends the frozen input');
    assert.deepEqual(executions, ['call-A']);
    const [sealed] = await rows(state.app, 'ModelRequest', { id: request.id });
    assert.equal(sealed.terminal_state, 'native_chain_rebased');
    assert.deepEqual(nativeToolPairs(requests[1]).get('call-A'), { calls: 1, results: 1 });
  });
});

test('a terminal unknown steer whose successor exists no longer blocks the batch checkpoint', { timeout: 20000 }, async () => {
  await withNativeKernel({
    steer: acceptSteer,
    async script({ round, emit, responseId, live, ended, app, shared }) {
      if (round === 0) {
        await emit('native_control', { type: 'response.created', responseId: 'response-0', capabilities });
        await steerDuring(app, shared.turn.turnId, shared.turn.fence, 'steer-unknown', 'Shorter, please.');
        await emit('native_control', { type: 'response.incomplete', responseId: 'response-0', reason: 'steered',
          usage: { input_tokens: 150, output_tokens: 3 } });
        await emit('native_control', { type: 'response.steer.disconnected', responseId: 'response-0',
          submissionId: 'steer-unknown', reason: 'successor_application_unverified' });
        live.responseId = 'response-0b';
        await emit('native_control', { type: 'response.created', responseId: 'response-0b',
          previousResponseId: 'response-0' });
        await emitCall(emit, 'response-0b', 'call-A', 0);
        await emit('native_control', { type: 'response.completed', responseId: 'response-0b',
          usage: { input_tokens: 200, output_tokens: 10 } });
        await ended.promise;
        await emit('completed', { role: 'model', parts: [callPart('call-A', 0, 'response-0b')] });
        return;
      }
      await emitFinalText(emit, responseId, 'continued after the checkpoint');
    }
  }, async ({ app, requests, executions, submissions, ended, shared, startTurn, drive }) => {
    shared.turn = await startTurn('unknown-steer-successor', 'Run the probe.');
    const outcome = await within(drive(shared.turn), 'the steered chain');
    assert.equal(outcome.terminalStatus, 'completed',
      JSON.stringify(await rows(app, 'TurnTermination', { turn_id: shared.turn.turnId })));
    assert.deepEqual(submissions, [], 'the settled batch checkpoints instead of waiting on the unknown steer');
    assert.deepEqual(ended, [0]);
    assert.deepEqual(executions, ['call-A']);
    assert.deepEqual(nativeToolPairs(requests[1]).get('call-A'), { calls: 1, results: 1 });
  });
});

test('a pending steer plus budget pressure ends the chain instead of stalling for the provider timeout', { timeout: 20000 }, async () => {
  await withNativeKernel({
    steer: acceptSteer,
    async script({ round, emit, responseId, ended, app, shared }) {
      if (round === 0) {
        await emit('native_control', { type: 'response.created', responseId, capabilities });
        await steerDuring(app, shared.turn.turnId, shared.turn.fence, 'steer-pending', 'Use a table.');
        await emitCall(emit, responseId, 'call-A', 0);
        // No usage on the physical response: its size is unknown, so no further create may be sent.
        await emit('native_control', { type: 'response.completed', responseId });
        await ended.promise;
        await emit('completed', { role: 'model', parts: [callPart('call-A', 0, responseId)] });
        return;
      }
      await emitFinalText(emit, responseId, 'continued with a fresh full request');
    }
  }, async ({ app, requests, executions, submissions, ended, shared, startTurn, drive }) => {
    shared.turn = await startTurn('steer-pressure', 'Run the probe.');
    const outcome = await within(drive(shared.turn), 'the pressured steered chain', 8000);
    assert.equal(outcome.terminalStatus, 'completed',
      JSON.stringify(await rows(app, 'TurnTermination', { turn_id: shared.turn.turnId })));
    assert.deepEqual(submissions, [], 'no create is sent into a chain at its physical budget');
    assert.deepEqual(ended, [0], 'the logical request is ended once the admitted tool settled');
    assert.deepEqual(executions, ['call-A']);
    assert.deepEqual(nativeToolPairs(requests[1]).get('call-A'), { calls: 1, results: 1 });
    const receipt = (await app.modelProvider.steeringReceipts(CONVERSATION))
      .find(value => value.submissionId === 'steer-pending');
    assert.equal(receipt.state, 'delivery_unknown', 'an unapplied steer is honestly closed, never replayed');
  });
});

test('a result write with an unverified outcome ends the chain instead of stalling', { timeout: 20000 }, async () => {
  await withNativeKernel({
    steer: acceptSteer,
    async script({ round, emit, responseId, ended, app, shared }) {
      if (round === 0) {
        await emit('native_control', { type: 'response.created', responseId, capabilities });
        await steerDuring(app, shared.turn.turnId, shared.turn.fence, 'steer-open', 'Keep it brief.');
        await emitCall(emit, responseId, 'call-A', 0);
        await emit('native_control', { type: 'response.completed', responseId,
          usage: { input_tokens: 200, output_tokens: 10 } });
        await ended.promise;
        await emit('completed', { role: 'model', parts: [callPart('call-A', 0, responseId)] });
        return;
      }
      await emitFinalText(emit, responseId, 'continued after the unverified write');
    }
  }, async ({ app, requests, executions, submissions, ended, shared, startTurn, drive }) => {
    shared.turn = await startTurn('unverified-result-write', 'Run the probe.');
    const outcome = await within(drive(shared.turn), 'the chain with an unverified result write', 8000);
    assert.equal(outcome.terminalStatus, 'completed',
      JSON.stringify(await rows(app, 'TurnTermination', { turn_id: shared.turn.turnId })));
    assert.deepEqual(submissions, [['call-A']], 'the result was written exactly once and never resent');
    assert.deepEqual(ended, [0]);
    assert.deepEqual(executions, ['call-A']);
    assert.deepEqual(nativeToolPairs(requests[1]).get('call-A'), { calls: 1, results: 1 });
    assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 0,
      'an unverified write is never recorded as a provider delivery');
  });
});

test('an accepted steer attributed to its successor is carried by the next full request', { timeout: 20000 }, async () => {
  await withNativeKernel({
    steer: acceptSteer,
    async script({ round, emit, responseId, live, ended, app, shared }) {
      if (round === 0) {
        await emit('native_control', { type: 'response.created', responseId: 'response-0', capabilities });
        await steerDuring(app, shared.turn.turnId, shared.turn.fence, 'steer-applied', 'Answer in French.');
        await emit('native_control', { type: 'response.incomplete', responseId: 'response-0', reason: 'steered' });
        live.responseId = 'response-0b';
        await emit('native_control', { type: 'response.created', responseId: 'response-0b',
          previousResponseId: 'response-0', submissionId: 'steer-applied', steerId: 'provider-steer-applied' });
        await emitCall(emit, 'response-0b', 'call-A', 0);
        await emit('native_control', { type: 'response.completed', responseId: 'response-0b',
          usage: { input_tokens: 200, output_tokens: 10 } });
        await ended.promise;
        await emit('completed', { role: 'model', parts: [callPart('call-A', 0, 'response-0b')] });
        return;
      }
      await emitFinalText(emit, responseId, 'Réponse finale.');
    }
  }, async ({ app, requests, shared, startTurn, drive }) => {
    shared.turn = await startTurn('applied-steer', 'Run the probe.');
    const outcome = await within(drive(shared.turn), 'the applied-steer chain');
    assert.equal(outcome.terminalStatus, 'completed');
    const receipt = (await app.modelProvider.steeringReceipts(CONVERSATION))
      .find(value => value.submissionId === 'steer-applied');
    assert.equal(receipt.state, 'completed');
    assert.equal(receipt.successorResponseId, 'response-0b');
    const text = requestText(requests[1]);
    assert.equal(text.split('Answer in French.').length - 1, 1, 'the steering instruction is in Context exactly once');
    assert.deepEqual(nativeToolPairs(requests[1]).get('call-A'), { calls: 1, results: 1 });
  });
});

test('a synchronous admitted call still running parks the Turn even when another call progressed', { timeout: 30000 }, async () => {
  await withNativeKernel({
    background: ['call-background'],
    async script({ round, emit, responseId, app }) {
      if (round === 0) {
        await emitToolResponse(emit, responseId, ['call-background', 'call-sync']);
        // The background effect settles outside this chain's observation; the chain then ends at
        // the transport while the synchronous call is still running.
        const [link] = await rows(app, 'ToolCallSourceLink', { provider_call_id: 'call-background' });
        await waitFor(async () => (await rows(app, 'ToolCallEvent', { tool_call_id: link.tool_call_id,
          event_kind: 'native_admission' })).length === 1, 'background call admitted');
        await app.runtime.effects.settleWithoutEffect({
          source: { kind: 'internal', key: 'native-chain-background-settle' }, toolCallId: link.tool_call_id,
          status: 'succeeded', detail: { ok: true, callId: 'call-background' }
        });
        await emit('completed', { role: 'model', parts: [callPart('call-background', 0, responseId),
          callPart('call-sync', 1, responseId)] });
        return;
      }
      await emitFinalText(emit, responseId, 'continued with every result');
    }
  }, async ({ app, requests, duplicates, gates, startTurn, drive }) => {
    gates.set('call-sync', deferred());
    const turn = await startTurn('sync-pending', 'Run both probes.');
    const first = await drive(turn);
    assert.equal(first.terminalStatus, 'waiting', 'an unresolved synchronous call cannot reach the Provider');
    assert.equal(requests.length, 1);
    const [background] = await rows(app, 'ToolCallSourceLink', { provider_call_id: 'call-background' });
    const [backgroundResult] = await rows(app, 'ToolModelResult', { tool_call_id: background.tool_call_id });
    assert.equal((await rows(app, 'ContextSegmentSource', { source_kind: 'tool_model_result',
      source_id: backgroundResult.id })).length, 1, 'the settled sibling progressed into Context');
    gates.get('call-sync').resolve();
    await waitFor(async () => (await rows(app, 'ToolModelResult')).length === 2, 'both calls settled');
    const outcome = await drive(turn);
    assert.equal(outcome.terminalStatus, 'completed',
      JSON.stringify(await rows(app, 'TurnTermination', { turn_id: turn.turnId })));
    assert.deepEqual(duplicates, []);
    assert.deepEqual(nativeToolPairs(requests[1]).get('call-sync'), { calls: 1, results: 1 });
    assert.deepEqual(nativeToolPairs(requests[1]).get('call-background'), { calls: 1, results: 1 });
  });
});

test('steering outcome reported twice is idempotent in the durable receipt store', { timeout: 30000 }, async () => {
  await withNativeKernel({
    async script({ controls }) {
      await new Promise(resolve => controls.signal.addEventListener('abort', resolve, { once: true }));
    }
  }, async ({ app, startTurn }) => {
    const turn = await startTurn('steer-idempotent', 'Hold the Turn.');
    await kernel.runWithExecutionLeaseFence(turn.fence, async () => {
      const store = app.modelProvider.nativeSteering;
      await store.submit({ turnId: turn.turnId, conversationId: CONVERSATION, modelRequestId: 'request-steer',
        commandId: 'steer-twice', content: { role: 'user', parts: [{ text: 'second direction' }] } });
      await store.transition({ turnId: turn.turnId, commandId: 'steer-twice', from: ['queued'], to: 'sent' });
      const first = await store.transition({ turnId: turn.turnId, commandId: 'steer-twice', from: ['sent'], to: 'failed',
        extras: { error: 'transport refused the second steer' } });
      const second = await store.transition({ turnId: turn.turnId, commandId: 'steer-twice',
        from: ['queued', 'sent', 'accepted', 'waiting_for_input'], to: 'failed', extras: { error: 'provider event' } });
      assert.equal(first.state, 'failed');
      assert.equal(second.state, 'failed', 'the repeated terminal outcome is a replay, not a crash');
      assert.equal(second.message, first.message, 'the first durable outcome owns the receipt');
    });
  });
});

test('two concurrent observers of one steer outcome never race the receipt', async () => {
  const writes = [];
  const durable = new Map();
  const session = new NativeRequestSession({
    tools: {}, capabilities, modelRequestId: 'request', turnId: 'turn',
    modelProvider: {
      nativeSteering: {
        async transition({ commandId, to, extras }) {
          const current = durable.get(commandId);
          await delay(5);
          // Like the durable store before idempotency: a same-state write with extras is illegal.
          if (current.state === to) throw new Error(`Native steering receipt ${commandId} cannot transition ${current.state} → ${to}.`);
          writes.push(to);
          const next = { ...current, state: to, message: extras?.error };
          durable.set(commandId, next);
          return next;
        }
      },
      emitNativeSteeringUpdate() {}
    }
  });
  const sent = { submissionId: 'steer', state: 'sent', modelRequestId: 'request', targetResponseId: 'r1', updatedAt: 1 };
  durable.set('steer', sent);
  session.steerReceipts.set('steer', sent);
  const [fromCommand, fromEvent] = await Promise.all([
    session.transitionSteer('steer', ['sent'], 'failed', { error: 'not sent' }),
    session.transitionSteer('steer', ['queued', 'sent', 'accepted', 'waiting_for_input'], 'failed', { error: 'provider event' })
  ]);
  assert.equal(fromCommand.state, 'failed');
  assert.equal(fromEvent.state, 'failed');
  assert.deepEqual(writes, ['failed'], 'exactly one observer writes the outcome');
});

