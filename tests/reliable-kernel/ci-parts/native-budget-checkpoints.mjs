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

const { NativeRequestSession } = load('backend/reliableKernel/nativeRequestSession.js');

const { OpenAIResponsesNativeDeliveryError } = load('backend/capabilities/openAIResponsesNativeControl.js');

const capabilities = { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false, explicitCaching: true };

const definition = { name: 'native_probe', description: 'one durable native tool', parameters: { type: 'object' }, metadata: { nativeAsync: true } };

const rows = async (app, domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain)
  .list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

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
      emptyConversationContextHandleStateStep('native-budget', now),
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

function registerCases(test) {

test('native batch boundary checkpoints four tools and resumes exact frozen call ordinals', { timeout: 240000 }, async () => {
  await withNativeTurn({ batches: 2, batchSize: 2 }, async state => {
    const { app, requests, outcome, started, executions, ended } = state;
    assert.equal(outcome.terminalStatus, 'completed', JSON.stringify(await rows(app, 'TurnTermination', { turn_id: started.turnId })));
    assert.equal(requests.length, 3);
    assert.equal(ended.length, 2);
    assert.equal(new Set(executions).size, 4, 'a tool effect is not executed again by the carrier request');
    const sources = await rows(app, 'ToolCallSourceLink');
    assert.equal(sources.length, 4);
    assert.equal(new Set(sources.map(source => source.provider_call_id)).size, 4);
    assert.ok(sources.every(source => source.thought_signature ===
      `signature-${Number(source.provider_call_id.split('-')[1])}-${Number(source.provider_call_id.split('-')[2])}`));
    assert.equal((await rows(app, 'ContextSegmentSource', { source_kind: 'tool_model_result' })).length, 4,
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
    assert.equal((await rows(reopened, 'ModelRequest', { turn_id: started.turnId })).length, 3);
    assert.equal((await rows(reopened, 'ContextSegmentSource', { source_kind: 'tool_model_result' })).length, 4);
    assert.equal(executions.length, 4, 'opening a Host never re-executes settled tools');
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
    assert.equal(recovered.nextGlobalCallOrdinal('response-0', 'call-0-1'), 1,
      'the distinct second frozen call retains ordinal 1');
    assert.equal(recovered.nextGlobalCallOrdinal('response-new', 'call-new'), 2,
      'a new generation cannot reuse already committed ordinal 0');
    await recovered.dispose('handoff');
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
}

export { registerCases };
