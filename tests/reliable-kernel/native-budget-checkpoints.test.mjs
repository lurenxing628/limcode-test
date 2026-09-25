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
const { nativePhysicalResponseBudgetPressure } = load('backend/reliableKernel/nativeCompressionGuard.js');

const capabilities = { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false, explicitCaching: true };
const definition = { name: 'native_probe', description: 'one durable native tool', parameters: { type: 'object' }, metadata: { nativeAsync: true } };
const rows = async (app, domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain)
  .list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

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

async function waitFor(predicate, label, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

/** Scripted transport, but real fenced SQLite/CAS, Context, ToolCall, ModelRequest and Turn. */
async function withNativeTurn(options, verify) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-budget-checkpoint-'));
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  const requests = [];
  const executions = [];
  const ended = [];
  const firstSettled = deferred();
  const slowSettlement = deferred();
  const ambiguousCreated = deferred();
  let app;
  let activeTurnId;
  let activeLeaseEpoch;
  let steerSubmissionId;
  const adapter = {
    providerId: 'native-provider',
    async materializeNativeToolOutput(outputs) { return outputs; },
    async sendFullRequest(request, controls) {
      const round = requests.length;
      requests.push(request);
      const responseId = `response-${round}`;
      let sequence = 0;
      const emit = (kind, content) => controls.onEvent({ kind, streamSeq: String(++sequence), content });
      const completion = deferred();
      controls.native.onController({
        get responseId() { return responseId; },
        endLogicalRequest() { ended.push(responseId); completion.resolve(); },
        async steer(command) {
          if (!options.ambiguous) assert.fail('A tool checkpoint must not submit user steering.');
          steerSubmissionId = command.submissionId;
          await emit('native_control', { type: 'response.steer.submitted', responseId,
            submissionId: command.submissionId });
          await emit('native_control', { type: 'response.steer.accepted', responseId,
            submissionId: command.submissionId, steerId: 'provider-steer-1' });
          await emit('native_control', { type: 'response.steer.pending', responseId,
            submissionId: command.submissionId, steerId: 'provider-steer-1',
            requiredInput: [{ type: 'function_call_output', callId: 'call-0-0', name: 'native_probe' }] });
        },
        async submitToolResults(outputs) {
          if (!options.ambiguous) assert.fail('A safe batch is carried through full-request preflight, not a new physical response.');
          assert.deepEqual(outputs.map(output => output.callId), ['call-0-0']);
          await emit('native_control', { type: 'response.steer.disconnected', responseId,
            submissionId: steerSubmissionId, reason: 'successor_application_unverified' });
          await emit('native_control', { type: 'response.created', responseId: 'response-ambiguous-r2',
            previousResponseId: responseId, reason: 'response_created_without_unique_result_admission',
            unverifiedToolResultCallIds: ['call-0-0'] });
          ambiguousCreated.resolve();
          throw new OpenAIResponsesNativeDeliveryError('admission_unknown', 'ambiguous result create', {
            reason: 'response_created_without_unique_result_admission', callIds: ['call-0-0']
          });
        }
      });
      await emit('native_control', { type: 'response.created', responseId, capabilities });
      const calls = [];
      if (round < options.batches) {
        for (let index = 0; index < (options.batchSize ?? 1); index += 1) {
          const callId = `call-${round}-${index}`;
          const part = {
            id: callId,
            functionCall: { name: 'native_probe', args: { round, index } },
            thoughtSignature: `signature-${round}-${index}`,
            outputItem: { id: `item-${callId}`, ordinal: index, providerResponseId: responseId },
            ...(options.asyncTools ? { async: true } : {})
          };
          calls.push(part);
          await emit('output_item_done', {
            type: 'tool_calls', calls: [{ id: callId, ordinal: index, name: 'native_probe',
              arguments: { round, index }, thoughtSignature: part.thoughtSignature,
              ...(options.asyncTools ? { async: true } : {}) }],
            outputItem: part.outputItem
          });
        }
      }
      if (options.ambiguous && round === 0) {
        await app.modelProvider.steer({ commandId: 'ambiguous-steer', turnId: activeTurnId,
          conversationId: 'native-budget', leaseEpoch: activeLeaseEpoch,
          content: { role: 'user', parts: [{ text: 'Steer while the result is required' }] } });
      }
      await emit('native_control', { type: 'response.completed', responseId,
        ...(options.inputTokens === null ? {} : { usage: {
          input_tokens: options.inputTokens ?? 240,
          output_tokens: 12,
          input_tokens_details: { cached_tokens: 110 }
        } })
      });
      if (calls.length > 0) {
        if (options.asyncTools) {
          await firstSettled.promise;
          assert.equal(ended.length, 0, 'a pending async result cannot yield a partial batch');
          const admissions = await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' });
          assert.equal(admissions.length, 0, 'no provider admission is fabricated while another effect runs');
          if (!options.ambiguousPending) slowSettlement.resolve();
        }
        if (options.ambiguousPending) {
          await ambiguousCreated.promise;
          await emit('native_control', { type: 'response.completed', responseId: 'response-ambiguous-r2',
            usage: { input_tokens: 305, output_tokens: 8 } });
          assert.equal(ended.length, 0, 'the unknown result must not close while another external effect is pending');
          assert.equal((await rows(app, 'ToolModelResult')).length, 1,
            'the second admitted effect has not been cancelled or settled prematurely');
          slowSettlement.resolve();
        }
        await completion.promise;
      }
      if (options.ambiguous && !options.ambiguousPending && round === 0) {
        await emit('native_control', { type: 'response.completed', responseId: 'response-ambiguous-r2',
          usage: { input_tokens: 305, output_tokens: 8 } });
      }
      await emit('completed', { role: 'model', parts: calls.length > 0 ? calls : [{ text: 'finished' }] });
      controls.native.onController(undefined);
    }
  };
  const dependencies = {
    authorityCompiler: { async compile(request) { return {
      turnId: request.turnId, executorAgentId: request.executorAgentId,
      executionPreset: { content: JSON.stringify({ providerConfigId: 'native-provider', modelId: 'gpt-6-astra' }) },
      authoritySnapshot: { content: JSON.stringify({ kind: 'effective-turn-authority',
        turnId: request.turnId, conversationId: request.conversationId, executorAgentId: request.executorAgentId,
        model: { providerConfigId: 'native-provider', provider: 'openai-responses', modelId: 'gpt-6-astra',
          baseUrl: 'https://native-budget.invalid/v1',
          openaiResponsesTransport: options.ambiguous ? 'websocket' : 'http',
          nativeResponses: { enabled: true, asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false },
          retryPolicy: { enabled: false, maxRetries: 0 } },
        modelProfile: { compressionThresholdTokens: options.threshold ?? 1000000,
          contextWindowTokens: options.window ?? 1200000,
          tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
        toolPolicy: { id: 'native-tools', allowedTools: ['native_probe'], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
        planReviewPolicy: { mode: 'never' }, systemPrompt: { id: 'prompt', text: '' },
        runtimeContext: { id: null, name: '', template: '' },
        workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
      }) }
    }; } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('unexpected MCP call'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
    providers: { resolve() { return adapter; } },
    toolDispatcher: {
      definitions() { return [definition]; },
      async dispatch() { assert.fail('native calls must use the durable admitted-call dispatcher'); },
      async scheduleAdmittedCall(input) {
        executions.push(input.toolCallId);
        if (options.asyncTools && input.arguments.index === 1) await slowSettlement.promise;
        const settled = await app.runtime.effects.settleWithoutEffect({
          source: { kind: 'internal', key: `native-budget:${input.toolCallId}` },
          toolCallId: input.toolCallId, status: 'succeeded',
          detail: { ok: true, round: input.arguments.round, index: input.arguments.index }
        });
        if (options.asyncTools && input.arguments.index === 0) firstSettled.resolve();
        return settled.terminal;
      }
    }
  };
  try {
    app = await kernel.ReliableKernelApplication.open(root, dependencies);
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: 'native-budget', title: 'Native budget', status: 'active', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: 'native-agent', conversation_id: 'native-budget', agent_id: 'agent-main', role: 'default',
        created_at: now, updated_at: now
      })
    ]);
    const started = await app.turns.input({ source: { kind: 'command', key: `native-budget-${options.batches}-${options.batchSize ?? 1}` },
      conversationId: 'native-budget', leaseOwnerId: 'fixture', hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 300000).toISOString(), content: 'Continue the same Turn' });
    const [lease] = await rows(app, 'ExecutionLease', { turn_id: started.turnId });
    const fence = { id: lease.id, conversationId: lease.conversation_id, turnId: lease.turn_id,
      ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation) };
    activeTurnId = started.turnId;
    activeLeaseEpoch = fence.generation;
    const outcome = options.manual ? undefined
      : await kernel.runWithExecutionLeaseFence(fence, () => app.agentLoop.drive(started.turnId));
    await verify({ app, root, dependencies, started, outcome, requests, executions, ended, fence,
      reopen: async () => { await app.close(); app = await kernel.ReliableKernelApplication.open(root, dependencies); return app; } });
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('active ModelRequest survives Host/socket handoff: replayed async frame executes once, new frame keeps unique ordinal', { timeout: 45000 }, async () => {
  await withNativeTurn({ manual: true, batches: 0 }, async state => {
    const { app, started, fence } = state;
    const [head] = await rows(app, 'ConversationContextHeadLink', { conversation_id: 'native-budget' });
    const [authority] = await rows(app, 'AuthoritySnapshot', { turn_id: started.turnId });
    const created = await app.modelProvider.createModelRequest({
      turnId: started.turnId, contextRootId: head.root_id,
      authoritySnapshotId: authority.id, idempotencyKey: `active-replay:${started.turnId}`,
      recipe: { kind: 'reliable-agent-turn', round: '1', tools: [definition], nativeResponses: capabilities,
        nativeLogicalBudget: { planningInputCapacityTokens: 900000, compressionThresholdTokens: 800000,
          autoCompressionEnabled: false } }
    });
    const modelRequestId = created.modelRequestId;
    const executed = [];
    const releasePending = deferred();
    let wireSubmissions = 0;
    let checkpoints = 0;
    let reopened;
    const makeSession = (runtime, recovered, requestId = modelRequestId, rootId = head.root_id) => new NativeRequestSession({
      database: runtime.database, contentStore: runtime.contentStore, context: runtime.context,
      turnOutput: runtime.turnOutput, effects: runtime.runtime.effects,
      tools: state.dependencies.toolDispatcher, modelProvider: runtime.modelProvider,
      conversationId: 'native-budget', turnId: started.turnId, modelRequestId: requestId,
      providerId: 'native-provider', modelId: 'gpt-6-astra', capabilities,
      budget: { planningInputCapacityTokens: 900000, compressionThresholdTokens: 800000,
        autoCompressionEnabled: false }, initialContextRootId: rootId,
      resolveAdapter: async () => ({ providerId: 'native-provider', materializeNativeToolOutput: async items => items }),
      resolveDefinition: () => definition, resolveCallArguments: (_, value) => ({ arguments: value }),
      freezePolicies: inputs => runtime.agentLoop.freezeDispatchPolicies(inputs),
      dispatchCall: async input => {
        if (input.providerCallId === 'pending-before-handoff') {
          if (!recovered) return { disposition: 'paused', toolCallId: input.toolCallId, reason: 'awaiting_user' };
          await releasePending.promise;
        }
        executed.push(input.providerCallId);
        const settlement = await runtime.runtime.effects.settleWithoutEffect({
          source: { kind: 'internal', key: `native-active:${input.toolCallId}` },
          toolCallId: input.toolCallId, status: 'succeeded', detail: { providerCallId: input.providerCallId }
        });
        return settlement.terminal;
      },
      toolCallIdFor: (ordinal, providerCallId) =>
        `native-tool-${requestId}-${ordinal}-${providerCallId}`,
      closeAdmittedCall: async () => { throw new Error('A Host handoff must not cancel an admitted effect.'); },
      now: () => new Date().toISOString()
    });
    const firstOpened = deferred();
    const firstAdmission = deferred();
    let firstSubmissions = 0;
    const firstDispatch = kernel.runWithExecutionLeaseFence(fence, async () => {
      const session = makeSession(app, false);
      await session.reconcile();
      try {
        await app.modelProvider.dispatch(modelRequestId, {
          providerId: 'native-provider',
          async sendFullRequest(full, controls) {
            session.bindStream({ attemptSeq: full.attemptSeq, socketGeneration: full.socketGeneration });
            session.hooks().onController({ responseId: 'response-before-handoff',
              endLogicalRequest() { throw new Error('An incomplete tool batch cannot be checkpointed.'); },
              async steer() { throw new Error('No steering in this fixture.'); },
              async submitToolResults(outputs) {
                firstSubmissions += 1;
                assert.deepEqual(outputs.map(item => item.callId), ['settled-before-handoff']);
                return firstAdmission.promise;
              }
            });
            firstOpened.resolve({ full, controls, session });
            await new Promise(resolve => controls.signal.addEventListener('abort', resolve, { once: true }));
          }
        });
      } finally { await session.dispose('handoff'); }
    });
    // Handoff can reject the held dispatch before the test reaches assert.rejects below.
    // Attach its observer immediately; do not let Node treat a correct handoff as unhandled.
    void firstDispatch.catch(() => undefined);
    const first = await firstOpened.promise;
    let currentFence = fence;
    const emit = async (runtime, bound, responseId, callId, index, seq) => kernel.runWithExecutionLeaseFence(currentFence, async () => {
      const content = { type: 'tool_calls', calls: [{ id: callId, ordinal: index,
        name: 'native_probe', arguments: { index }, async: true }],
      outputItem: { id: `item-${callId}`, ordinal: index, providerResponseId: responseId } };
      const item = bound.session.parseCallItem(content);
      const proof = bound.session.buildCallProof(item);
      const result = await runtime.modelProvider.recordNativeToolCallProof(modelRequestId,
        bound.full.attemptSeq, bound.full.socketGeneration, String(seq), proof);
      await bound.session.admitStreamedCall(item, String(seq), result);
    });
    const control = async (bound, content, seq) => kernel.runWithExecutionLeaseFence(currentFence, async () => {
      const event = { kind: 'native_control', streamSeq: String(seq), content };
      const result = await bound.controls.onEvent(event);
      await bound.session.afterNativeControl(event, result);
    });
    await control(first, { type: 'response.created', responseId: 'response-before-handoff' }, 1);
    await emit(app, first, 'response-before-handoff', 'settled-before-handoff', 0, 2);
    await emit(app, first, 'response-before-handoff', 'pending-before-handoff', 1, 3);
    await control(first, { type: 'response.completed', responseId: 'response-before-handoff',
      usage: { input_tokens: 170, output_tokens: 9 } }, 4);
    await waitFor(async () => firstSubmissions === 1, 'first settled output submitted once');
    await control(first, { type: 'response.created', responseId: 'response-admit-before-handoff',
      previousResponseId: 'response-before-handoff',
      admittedToolResultCallIds: ['settled-before-handoff'] }, 5);
    firstAdmission.resolve({ responseId: 'response-admit-before-handoff',
      previousResponseId: 'response-before-handoff' });
    await waitFor(async () => (await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length === 1,
      'actual server-created admission for A');
    await waitFor(async () => (await rows(app, 'ToolCallSourceLink', { model_request_id: modelRequestId })).length === 2
      && (await rows(app, 'ToolModelResult')).length === 1,
    'first settled and second pending native admissions');
    assert.deepEqual(executed, ['settled-before-handoff']);
    assert.equal(firstSubmissions, 1);
    assert.equal((await rows(app, 'ContextSegmentSource', { source_kind: 'tool_model_result' })).length, 1,
      'A reached Context only after its true native admission');
    await app.modelProvider.quiesceAllActiveDispatches(new kernel.ExecutionHandoffError('isolated Host handoff'));
    await assert.rejects(firstDispatch, error => kernel.isExecutionHandoffError(error));
    reopened = await state.reopen();
    const claimed = await reopened.turns.claimRecoveryExecution({ turnId: started.turnId,
      leaseOwnerId: 'recovered-native-owner', hostBootId: reopened.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120000).toISOString() });
    assert.ok(claimed, 'the old Host is closed before a new Host may claim execution');
    const [lease] = await rows(reopened, 'ExecutionLease', { turn_id: started.turnId });
    const newFence = { id: lease.id, conversationId: lease.conversation_id, turnId: started.turnId,
      ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation) };
    currentFence = newFence;
    const secondOpened = deferred();
    const completed = deferred();
    const secondDispatch = kernel.runWithExecutionLeaseFence(newFence, async () => {
      const session = makeSession(reopened, true);
      await session.reconcile();
      try {
        await reopened.modelProvider.dispatch(modelRequestId, {
          providerId: 'native-provider',
          async sendFullRequest(full, controls) {
            session.bindStream({ attemptSeq: full.attemptSeq, socketGeneration: full.socketGeneration });
            session.hooks().onController({ responseId: 'response-after-handoff',
              endLogicalRequest() { checkpoints += 1; completed.resolve(); },
              async steer() { throw new Error('No steering in this fixture.'); },
              async submitToolResults() {
                wireSubmissions += 1;
                throw new Error('A fully settled batch must checkpoint first.');
              }
            });
            secondOpened.resolve({ full, controls, session });
            await completed.promise;
            await controls.onEvent({ kind: 'completed', streamSeq: '7', content: { role: 'model',
              parts: ['settled-before-handoff', 'pending-before-handoff', 'fresh-after-handoff']
                .map((id, index) => ({ id, functionCall: { name: 'native_probe', args: { index } } })) } });
            session.hooks().onController(undefined);
          }
        }, { reconnect: true });
      } finally { await session.dispose('completed'); }
    });
    const next = await secondOpened.promise;
    assert.notEqual(next.full.socketGeneration, first.full.socketGeneration);
    await emit(reopened, next, 'response-before-handoff', 'settled-before-handoff', 0, 1);
    await emit(reopened, next, 'response-before-handoff', 'settled-before-handoff', 0, 2);
    assert.deepEqual(executed, ['settled-before-handoff'],
      'pending B must not settle before the new physical response is safely complete');
    await control(next, { type: 'response.created', responseId: 'response-after-handoff',
      previousResponseId: 'response-admit-before-handoff' }, 3);
    await emit(reopened, next, 'response-after-handoff', 'fresh-after-handoff', 0, 4);
    releasePending.resolve();
    await waitFor(async () => (await rows(reopened, 'ToolModelResult')).length === 3,
      'both earlier tools and the fresh async call settle before the new physical boundary');
    await control(next, { type: 'response.completed', responseId: 'response-after-handoff',
      usage: { input_tokens: 240, output_tokens: 7 } }, 5);
    await secondDispatch;
    assert.equal(checkpoints, 1);
    assert.equal(wireSubmissions, 0, 'nothing can race the full-batch checkpoint into a second native create');
    const sources = await rows(reopened, 'ToolCallSourceLink', { model_request_id: modelRequestId });
    assert.deepEqual(sources.map(row => Number(row.provider_ordinal)).sort((a, b) => a - b), [0, 1, 2]);
    assert.equal(new Set(sources.map(row => row.tool_call_id)).size, 3);
    assert.deepEqual(executed.sort(), ['fresh-after-handoff', 'pending-before-handoff', 'settled-before-handoff']);
    assert.equal((await rows(reopened, 'ContextSegmentSource', { source_kind: 'tool_model_result' })).length, 3);
    assert.equal((await rows(reopened, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 1,
      'only actually admitted A has a provider result-delivery fact');
    assert.equal((await rows(reopened, 'ModelRequest', { turn_id: started.turnId })).length, 1);
  });
});

test('ambiguous native result admission closes settled CAS output into Context without inventing provider delivery', async () => {
  let frozenOutputs = 0;
  let contextAppends = 0;
  let cancelledEffects = 0;
  const session = new NativeRequestSession({
    tools: {}, capabilities, modelRequestId: 'ambiguous-request', turnId: 'turn',
    closeAdmittedCall: async () => { cancelledEffects += 1; }
  });
  const call = { toolCallId: 'settled-undelivered', providerCallId: 'wire-call',
    admitted: true, settled: true, toolModelResultId: 'stored-result',
    resultOccurrence: false, delivered: false };
  session.calls.set(call.toolCallId, call);
  session.buildFunctionCallOutput = async () => { frozenOutputs += 1; return { type: 'function_call_output',
    callId: call.providerCallId, output: 'exact CAS result' }; };
  session.appendResultOccurrence = async value => { contextAppends += 1; value.resultOccurrence = true; };
  await session.dispose('completed');
  assert.equal(frozenOutputs, 1);
  assert.equal(contextAppends, 1, 'a terminal but unacknowledged result must survive for the next full request');
  assert.equal(cancelledEffects, 0, 'already-issued external work is not cancelled');
  assert.equal(call.delivered, false, 'a local Context append is not native_delivery');
  await session.dispose('completed');
  assert.equal(contextAppends, 1, 'terminal closure is idempotent');
});

test('R2.completed with unverified steer/result ends the chain and continues the Turn from Context without replay', { timeout: 15000 }, async () => {
  await withNativeTurn({ ambiguous: true, batches: 1, inputTokens: 210 },
    async ({ app, started, outcome, requests, executions, ended }) => {
      assert.equal(outcome.terminalStatus, 'completed',
        JSON.stringify(await rows(app, 'TurnTermination', { turn_id: started.turnId })));
      assert.equal(ended.length, 1, 'the real R2 boundary closes, rather than waiting indefinitely');
      assert.equal(requests.length, 2, 'the Turn continues with one fresh full request, not a chain resubmission');
      assert.equal(new Set(executions).size, 1, 'the external tool effect is executed exactly once');
      const [source] = await rows(app, 'ToolCallSourceLink', { model_request_id: requests[0].modelRequestId });
      assert.equal(source.provider_call_id, 'call-0-0');
      assert.deepEqual(nativeToolPairs(requests[1]).get('call-0-0'), { calls: 1, results: 1 },
        'the continuation carries the call occurrence and its exact result occurrence once each');
      assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 0,
        'R2 has no provider proof that it consumed the result');
      const [result] = await rows(app, 'ToolModelResult', { tool_call_id: source.tool_call_id });
      const [revision] = await rows(app, 'MessageRevision', { id: result.message_revision_id });
      const [metadata] = await rows(app, 'ContentObject', { id: revision.content_object_id });
      assert.match((await app.contentStore.read(metadata)).toString('utf8'), /"ok":true/,
        'the exact ToolModelResult bytes remain readable from CAS');
      assert.equal((await rows(app, 'ContextSegmentSource', { source_kind: 'tool_model_result',
        source_id: result.id })).length, 1, 'the local result occurrence is retained once, not mistaken for native_delivery');
      const steering = (await app.modelProvider.steeringReceipts('native-budget'))
        .find(receipt => receipt.submissionId === 'ambiguous-steer');
      assert.equal(steering.state, 'delivery_unknown');
      assert.equal(steering.successorResponseId, undefined, 'no successor or application is invented');
      const steerMessages = (await rows(app, 'MessageTurnLink', { turn_id: started.turnId }))
        .filter(link => link.role === 'native_steer');
      assert.equal(steerMessages.length, 1, 'the user steering Message remains separately persisted');
    });
});

test('ambiguous A waits for a separately admitted async B, then continues from Context without cancelling either effect', { timeout: 15000 }, async () => {
  await withNativeTurn({ ambiguous: true, ambiguousPending: true, batches: 1, batchSize: 2,
    asyncTools: true, inputTokens: 210 }, async ({ app, started, outcome, requests, executions, ended }) => {
    assert.equal(outcome.terminalStatus, 'completed',
      JSON.stringify(await rows(app, 'TurnTermination', { turn_id: started.turnId })));
    assert.equal(ended.length, 1, 'chain ends only after both admitted external effects really settle');
    assert.equal(requests.length, 2);
    assert.equal(new Set(executions).size, 2);
    assert.equal((await rows(app, 'ToolModelResult')).length, 2);
    assert.equal((await rows(app, 'ContextSegmentSource', { source_kind: 'tool_model_result' })).length, 2);
    assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 0);
    const pairs = nativeToolPairs(requests[1]);
    assert.deepEqual([...pairs.values()], [{ calls: 1, results: 1 }, { calls: 1, results: 1 }]);
  });
});

test('physical native budget never uses chain-summed billing or counts cache-read tokens twice', () => {
  const budget = { planningInputCapacityTokens: 10000, compressionThresholdTokens: 8000, autoCompressionEnabled: true };
  assert.equal(nativePhysicalResponseBudgetPressure({ budget, physicalInputTokens: 1900, physicalResponseCount: 7 }), false);
  assert.equal(nativePhysicalResponseBudgetPressure({ budget, physicalInputTokens: 1900, physicalResponseCount: 8 }), true);
  assert.equal(nativePhysicalResponseBudgetPressure({ budget, physicalResponseCount: 1 }), true, 'unknown is not zero');
  assert.equal(nativePhysicalResponseBudgetPressure({ budget, physicalInputTokens: 9000, physicalResponseCount: 1 }), true);
  assert.equal(nativePhysicalResponseBudgetPressure({ budget: { ...budget, autoCompressionEnabled: false },
    physicalInputTokens: 8000, physicalResponseCount: 1 }), false, 'disabled compression cannot silently apply its threshold');
});

test('105 native tools checkpoint complete batches into successive requests of ONE Turn, with durable recovery', { timeout: 240000 }, async () => {
  await withNativeTurn({ batches: 21, batchSize: 5 }, async state => {
    const { app, requests, outcome, started, executions, ended } = state;
    assert.equal(outcome.terminalStatus, 'completed', JSON.stringify(await rows(app, 'TurnTermination', { turn_id: started.turnId })));
    assert.equal(requests.length, 22);
    assert.equal(ended.length, 21);
    assert.equal(new Set(executions).size, 105, 'a tool effect is not executed again by the carrier request');
    const sources = await rows(app, 'ToolCallSourceLink');
    assert.equal(sources.length, 105);
    assert.equal(new Set(sources.map(source => source.provider_call_id)).size, 105);
    assert.ok(sources.every(source => source.thought_signature ===
      `signature-${Number(source.provider_call_id.split('-')[1])}-${Number(source.provider_call_id.split('-')[2])}`));
    assert.equal((await rows(app, 'ContextSegmentSource', { source_kind: 'tool_model_result' })).length, 105,
      'each tool has precisely one durable Context result occurrence');
    assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 0,
      'a local checkpoint is never a forged provider admission');
    const initial = await app.modelProvider.readNativeLatestResponseUsage(requests[0].modelRequestId);
    assert.equal(initial.inputTokens, 240);
    assert.equal(initial.outputTokens, 12);
    assert.equal(initial.physicalResponseCount, 1);
    assert.equal(initial.contextCovered, undefined, 'a root id is not wire coverage');
    const second = await app.modelProvider.readNativeLatestResponseUsage(requests[1].modelRequestId);
    assert.equal(second.inputTokens, 240, 'response input is not cumulative chain billing');
    assert.equal(second.physicalResponseCount, 1);
    const reopened = await state.reopen();
    assert.equal((await rows(reopened, 'ModelRequest', { turn_id: started.turnId })).length, 22);
    assert.equal((await rows(reopened, 'ContextSegmentSource', { source_kind: 'tool_model_result' })).length, 105);
    assert.equal(executions.length, 105, 'opening a Host never re-executes settled tools');
    const firstSources = await rows(reopened, 'ToolCallSourceLink', { model_request_id: requests[0].modelRequestId });
    const [projection] = await rows(reopened, 'ModelContextProjection', {
      owner_kind: 'model_request', owner_id: requests[0].modelRequestId
    });
    const recovered = new NativeRequestSession({
      database: reopened.database, contentStore: reopened.contentStore,
      context: reopened.context, turnOutput: reopened.turnOutput,
      effects: reopened.runtime.effects, tools: state.dependencies.toolDispatcher,
      modelProvider: reopened.modelProvider, conversationId: 'native-budget', turnId: started.turnId,
      modelRequestId: requests[0].modelRequestId, providerId: 'native-provider', modelId: 'gpt-6-astra',
      capabilities, budget: { planningInputCapacityTokens: 1000000, compressionThresholdTokens: 1000000,
        autoCompressionEnabled: false }, initialContextRootId: projection.root_id,
      resolveAdapter: async () => { throw new Error('recovery must not send another physical request'); },
      resolveDefinition: () => definition,
      resolveCallArguments: (_, value) => ({ arguments: value }),
      freezePolicies: async () => { throw new Error('recovery must not re-admit a tool'); },
      dispatchCall: async () => { throw new Error('recovery must not rerun a tool'); },
      toolCallIdFor: (ordinal, providerCallId) => {
        const source = firstSources.find(row => row.provider_call_id === providerCallId
          && Number(row.provider_ordinal) === ordinal);
        assert.ok(source, `recovered ${providerCallId}/${ordinal} must match its durable SourceLink`);
        return source.tool_call_id;
      },
      closeAdmittedCall: async () => { throw new Error('recovery must not cancel effects'); },
      now: () => new Date().toISOString()
    });
    await recovered.reconcile();
    assert.throws(() => recovered.bindStream({ attemptSeq: '2', socketGeneration: '2' }),
      /durable chain progress/, 'a new Attempt never replays the frozen input of a chain with progress');
    recovered.bindStream({ attemptSeq: '1', socketGeneration: '2' });
    assert.equal(recovered.nextGlobalCallOrdinal('response-0', 'call-0-0'), 0,
      'a re-streamed old call retains its original ToolCall identity');
    assert.equal(recovered.nextGlobalCallOrdinal('response-new', 'call-new'), 5,
      'a new generation cannot reuse already committed ordinal 0');
    await recovered.dispose('handoff');
  });
});

test('pending async result backpressures the physical batch until every tool is settled', { timeout: 30000 }, async () => {
  await withNativeTurn({ batches: 1, batchSize: 2, asyncTools: true, inputTokens: null }, async ({ app, outcome, ended, executions }) => {
    assert.equal(outcome.terminalStatus, 'completed');
    assert.equal(ended.length, 1);
    assert.equal(new Set(executions).size, 2);
    assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 0);
  });
});

test('physical budget near the frozen capacity refuses a new request with compression disabled', { timeout: 30000 }, async () => {
  await withNativeTurn({ batches: 1, window: 10000, threshold: 7000, inputTokens: 5600 },
    async ({ app, outcome, requests, ended, started }) => {
      assert.equal(outcome.terminalStatus, 'failed', JSON.stringify(await rows(app, 'TurnTermination', { turn_id: started.turnId })));
      assert.equal(requests.length, 1, 'no unpreflighted successor reaches the provider');
      assert.equal(ended.length, 1, 'the settled batch still checkpointed without cancelling its tool');
      assert.equal((await rows(app, 'ContextSegmentSource', { source_kind: 'tool_model_result' })).length, 1);
      const [termination] = await rows(app, 'TurnTermination', { turn_id: started.turnId });
      assert.match(termination.reason, /NATIVE_CONTEXT_BUDGET_EXHAUSTED/);
    });
});

test('second same-frontier steer refused before wire is failed visibly, not left queued for unsafe replay', async () => {
  const updates = [];
  let sent = 0;
  const session = new NativeRequestSession({
    tools: {}, capabilities, modelRequestId: 'request', turnId: 'turn', conversationId: 'conversation',
    modelProvider: {
      nativeSteering: {
        async submit({ commandId }) { return session.steerReceipts.get(commandId) ?? {
          submissionId: commandId, state: 'queued',
          targetResponseId: 'predecessor', responseId: 'predecessor', updatedAt: 1
        }; },
        async transition({ commandId, to, extras }) { return { ...session.steerReceipts.get(commandId),
          submissionId: commandId, state: to, message: extras?.error, updatedAt: 2 }; }
      },
      emitNativeSteeringUpdate(update) { updates.push(update); }
    }
  });
  session.steerReceipts.set('already-sent', { submissionId: 'already-sent', state: 'accepted',
    targetResponseId: 'predecessor', responseId: 'predecessor', updatedAt: 1 });
  session.controller = { responseId: 'predecessor', async steer() {
    sent += 1;
    assert.equal(session.steerReceipts.get('second').state, 'sent',
      'durable intent must precede any possible provider wire write');
    throw new OpenAIResponsesNativeDeliveryError('not_sent', 'earlier steering is unproven',
      { reason: 'steering_pending_unproven' });
  } };
  const next = await session.steerCommand({ commandId: 'second', content: { role: 'user', parts: [{ text: 'second direction' }] } });
  assert.equal(sent, 1);
  assert.equal(next.state, 'failed');
  assert.match(next.message, /not sent/);
  assert.equal(session.steerReceipts.get('already-sent').state, 'accepted',
    'a never-sent second instruction cannot change the first submission');
  assert.equal(updates.at(-1).receipts[0].state, 'failed');
  session.steerReceipts.set('possibly-sent', { submissionId: 'possibly-sent', state: 'queued',
    modelRequestId: 'request', targetResponseId: 'predecessor', updatedAt: 1 });
  await session.afterNativeControl({ streamSeq: '1', content: {
    type: 'response.steer.disconnected', responseId: 'predecessor', submissionId: 'possibly-sent',
    reason: 'connection_lost'
  } }, { accepted: true, checkpointed: true, terminal: false });
  assert.equal(session.steerReceipts.get('possibly-sent').state, 'delivery_unknown',
    'queued before local submitted checkpoint is not proof a started wire write was never sent');
  session.controller.steer = async () => {
    sent += 1;
    assert.equal(session.steerReceipts.get('uncertain').state, 'sent');
    throw new OpenAIResponsesNativeDeliveryError('admission_unknown', 'connection closed after write',
      { reason: 'connection_lost' });
  };
  const uncertain = await session.steerCommand({ commandId: 'uncertain',
    content: { role: 'user', parts: [{ text: 'cannot automatically replay this' }] } });
  assert.equal(uncertain.state, 'delivery_unknown');
  assert.equal((await session.steerCommand({ commandId: 'uncertain',
    content: { role: 'user', parts: [{ text: 'cannot automatically replay this' }] } })).state, 'delivery_unknown');
  assert.equal(sent, 2, 'retrying the same durable submission must not write a second wire instruction');
});

test('native provider-created uncertainty is CAS-shaped evidence, never an admission acknowledgment', async () => {
  const session = new NativeRequestSession({ tools: {}, capabilities,
    modelRequestId: 'request', turnId: 'turn', modelProvider: { emitNativeSteeringUpdate() {} } });
  session.callByProviderId.set('wire-call', { toolCallId: 'tool-call', admitted: true,
    responseId: 'r1', providerCallId: 'wire-call' });
  const checkpointed = { accepted: true, checkpointed: true, terminal: false };
  await session.afterNativeControl({ streamSeq: '3', content: {
    type: 'response.created', responseId: 'r2', previousResponseId: 'r1',
    reason: 'response_created_without_unique_result_admission',
    unverifiedToolResultCallIds: ['wire-call']
  } }, checkpointed);
  assert.deepEqual([...session.uncertainResultCalls], ['tool-call']);
  assert.equal(session.unsafeResultAdmissionError().code, 'NATIVE_RESULT_ADMISSION_UNKNOWN');
  assert.equal(session.callByProviderId.get('wire-call').delivered, undefined,
    'an unverified result is never a native_delivery fact');
  await assert.rejects(() => session.afterNativeControl({ streamSeq: '4', content: {
    type: 'response.created', responseId: 'r3', previousResponseId: 'r2',
    reason: 'response_created_without_unique_result_admission',
    unverifiedToolResultCallIds: ['wire-call'], admittedToolResultCallIds: ['wire-call']
  } }, checkpointed), /unverified tool results require/);
});

test('ambiguous result admission is never resubmitted or acknowledged; a completed physical chain fails visibly', async () => {
  const unknown = new OpenAIResponsesNativeDeliveryError('admission_unknown', 'ambiguous successor', {
    reason: 'response_created_without_unique_result_admission', callIds: ['wire-call']
  });
  let sends = 0;
  let ends = 0;
  const session = new NativeRequestSession({
    tools: {}, capabilities, modelRequestId: 'ambiguous-request', turnId: 'turn',
    budget: { planningInputCapacityTokens: 10000, compressionThresholdTokens: 8000,
      autoCompressionEnabled: false },
    modelProvider: { async readNativeLatestResponseUsage() { return {
      responseId: 'r1', streamSeq: '3', attemptSeq: '1', socketGeneration: '1',
      physicalResponseCount: 1, inputTokens: 150
    }; } },
    resolveAdapter: async () => ({ materializeNativeToolOutput: async outputs => outputs })
  });
  session.bindStream({ attemptSeq: '1', socketGeneration: '1' });
  session.responseOrder.push('r1');
  session.responses.set('r1', { responseId: 'r1', admissionBoundary: true, completed: true,
    boundarySeq: '3', syncRequired: false });
  session.calls.set('call', { toolCallId: 'call', providerCallId: 'wire-call', responseId: 'r1',
    providerOrdinal: 0, asyncDeclared: true, admitted: true, settled: true, delivered: false });
  session.calls.set('still-running', { toolCallId: 'still-running', providerCallId: 'another-call',
    responseId: 'r1', providerOrdinal: 1, asyncDeclared: true,
    admitted: true, settled: false, delivered: false });
  session.steerReceipts.set('unknown-steer', { submissionId: 'unknown-steer', state: 'delivery_unknown',
    modelRequestId: 'ambiguous-request', targetResponseId: 'r1' });
  session.buildFunctionCallOutput = async () => ({ type: 'function_call_output', callId: 'wire-call', output: 'stored' });
  session.controller = { endLogicalRequest() { ends += 1; },
    async submitToolResults() { sends += 1; throw unknown; } };
  await session.pumpLoop();
  assert.equal(sends, 1);
  assert.equal(ends, 0, 'an unverified result must not cancel another already-admitted in-flight tool');
  assert.equal(session.collectDeliverable().length, 0, 'an unknown wire result is never auto-resubmitted');
  session.calls.get('still-running').settled = true;
  await session.pumpLoop();
  assert.equal(ends, 1, 'the real physical response boundary is requested only after all effects settle');
  assert.equal(sends, 1, 'settling the second effect never resends an ambiguous wire result');
  assert.match(session.unsafeResultAdmissionError().message, /NATIVE_RESULT_ADMISSION_UNKNOWN/);
  assert.equal(session.calls.get('call').delivered, false);
});

test('unknown steer blocks checkpoint but permits a budget-safe required tool-result create', async () => {
  let submissions = 0;
  let ended = 0;
  const session = new NativeRequestSession({
    tools: {}, modelRequestId: 'request', turnId: 'turn', capabilities,
    budget: { planningInputCapacityTokens: 10000, compressionThresholdTokens: 8000,
      autoCompressionEnabled: false },
    modelProvider: { async readNativeLatestResponseUsage() { return {
      responseId: 'physical-response', attemptSeq: '1', socketGeneration: '1', streamSeq: '2',
      physicalResponseCount: 1, inputTokens: 120
    }; } },
    resolveAdapter: async () => ({ materializeNativeToolOutput: async values => values })
  });
  session.buildFunctionCallOutput = async () => ({ type: 'function_call_output', callId: 'required-call', output: 'settled' });
  session.bindStream({ attemptSeq: '1', socketGeneration: '1' });
  session.responseOrder.push('physical-response');
  session.responses.set('physical-response', { responseId: 'physical-response', admissionBoundary: true,
    completed: true, boundarySeq: '2', syncRequired: false });
  session.calls.set('required-tool', { toolCallId: 'required-tool', responseId: 'physical-response',
    providerCallId: 'required-call', providerOrdinal: 0, asyncDeclared: false,
    admitted: true, settled: true, delivered: false });
  session.steerReceipts.set('unknown-steer', { submissionId: 'unknown-steer', state: 'delivery_unknown',
    modelRequestId: 'request', targetResponseId: 'physical-response' });
  session.controller = {
    endLogicalRequest() { ended += 1; },
    async submitToolResults(outputs) {
      submissions += 1;
      assert.deepEqual(outputs.map(item => item.callId), ['required-call']);
      return { responseId: 'next-physical-response' };
    }
  };
  await session.pumpLoop();
  assert.equal(ended, 0, 'an uncertain steer cannot be carried into a new logical request');
  assert.equal(submissions, 1, 'the server may still require this exact settled tool result');
  assert.deepEqual([...session.inFlightDeliveries], ['required-tool'],
    'submission alone never fabricates a response.created delivery fact');
});

test('two same-predecessor steering receipts do not claim a successor without submission proof', async () => {
  const applied = [];
  const session = new NativeRequestSession({
    tools: {}, capabilities, modelRequestId: 'request', turnId: 'turn',
    modelProvider: { nativeSteering: { async applyToContext(command) {
      applied.push(command.commandId);
      return { ...session.steerReceipts.get(command.commandId), state: 'continuing', successorResponseId: command.responseId };
    } }, emitNativeSteeringUpdate() {} }
  });
  session.bindStream({ attemptSeq: '1', socketGeneration: '1' });
  const receipt = submissionId => ({ submissionId, state: 'accepted', targetResponseId: 'predecessor',
    responseId: 'predecessor', turnId: 'turn', conversationId: 'conversation', updatedAt: 1 });
  session.steerReceipts.set('steer-a', receipt('steer-a'));
  session.steerReceipts.set('steer-b', receipt('steer-b'));
  const accepted = { accepted: true, checkpointed: true, terminal: false };
  await session.afterNativeControl({ streamSeq: '1', content: { type: 'response.created',
    responseId: 'successor-1', previousResponseId: 'predecessor' } }, accepted);
  assert.deepEqual(applied, []);
  assert.equal(session.steerReceipts.get('steer-a').state, 'accepted');
  assert.equal(session.steerReceipts.get('steer-b').state, 'accepted');
  let ended = 0;
  session.controller = { endLogicalRequest() { ended += 1; } };
  session.responses.get('successor-1').completed = true;
  session.responses.get('successor-1').boundarySeq = '2';
  const settledCall = { toolCallId: 'tool-a', responseId: 'successor-1',
    admitted: true, settled: true, delivered: false };
  session.calls.set(settledCall.toolCallId, settledCall);
  assert.equal(await session.yieldAtNativeBatchBoundary([settledCall]), false);
  assert.equal(ended, 0, 'an unproven in-flight steer prevents checkpointing even if tools settled');
  await session.afterNativeControl({ streamSeq: '2', content: { type: 'response.created',
    responseId: 'successor-2', previousResponseId: 'predecessor', submissionId: 'steer-b' } }, accepted);
  assert.deepEqual(applied, ['steer-b'], 'only the explicitly attested submission may enter Context');
  assert.equal(session.steerReceipts.get('steer-a').state, 'accepted');
  assert.equal(session.steerReceipts.get('steer-b').successorResponseId, 'successor-2');
  session.responses.get('successor-2').completed = true;
  session.responses.get('successor-2').boundarySeq = '3';
  session.steerReceipts.set('steer-b', { ...session.steerReceipts.get('steer-b'), state: 'completed' });
  session.steerReceipts.set('steer-a', { ...session.steerReceipts.get('steer-a'), state: 'delivery_unknown',
    targetResponseId: 'successor-2', responseId: 'successor-2' });
  assert.equal(await session.yieldAtNativeBatchBoundary([settledCall]), false);
  assert.equal(ended, 0, 'an unknown steer whose target has no successor yet can still produce one');
  session.steerReceipts.set('steer-a', { ...session.steerReceipts.get('steer-a'),
    targetResponseId: 'predecessor', responseId: 'predecessor' });
  session.inFlightDeliveries.add(settledCall.toolCallId);
  assert.equal(await session.yieldAtNativeBatchBoundary([settledCall]), false);
  assert.equal(ended, 0, 'an unacknowledged physical result is not a safe checkpoint');
  session.inFlightDeliveries.clear();
  const closed = [];
  session.buildFunctionCallOutput = async call => ({ type: 'function_call_output', callId: call.toolCallId, output: 'CAS' });
  session.appendResultOccurrence = async call => { closed.push(call.toolCallId); call.resultOccurrence = true; };
  assert.equal(await session.yieldAtNativeBatchBoundary([settledCall]), true,
    'a terminal unknown steer whose successor already exists no longer blocks the checkpoint');
  assert.equal(ended, 1);
  assert.deepEqual(closed, ['tool-a'], 'the settled result is closed into Context before the chain ends');
});
