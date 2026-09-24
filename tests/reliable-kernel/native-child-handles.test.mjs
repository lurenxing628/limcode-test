import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = file => require(path.join(compiled, file));
const kernel = load('backend/reliableKernel/index.js');
const { NativeRequestSession } = load('backend/reliableKernel/nativeRequestSession.js');
const { readConversationChildHandles, readNativeRequestChildHandles, NATIVE_CHILD_HANDLE_PROJECTION_EVENT } =
  load('backend/reliableKernel/conversationChildHandles.js');
const { resolveModelToolArguments } = load('backend/reliableKernel/modelHandleCatalog.js');
const { parseNativeToolCallCheckpoint } = load('backend/reliableKernel/nativeToolFacts.js');

const capabilities = { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false, explicitCaching: true };
const definition = { name: 'run_agent', description: 'native child handle fixture', parameters: { type: 'object' } };
const rows = async (app, domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain)
  .list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;

test('native logical request persists new child refs before output, resolves same-request send, and restores after reopen', { timeout: 30000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-child-handles-'));
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  let app;
  let capturedRequest;
  const executed = [];
  const outputs = [];
  const adapter = {
    providerId: 'native-provider',
    async materializeNativeToolOutput(values) { return values; },
    async sendFullRequest(request, controls) {
      capturedRequest = request;
      assert.ok(controls.native, 'this must exercise nativeResponses execution, not provider_native compression');
      let sequence = 0;
      const event = (kind, content) => controls.onEvent({ kind, streamSeq: String(++sequence), content });
      const control = content => event('native_control', content);
      const call = (id, ordinal, args, responseId) => event('output_item_done', {
        type: 'tool_calls', calls: [{ id, ordinal, name: 'run_agent', arguments: args, async: false }],
        outputItem: { id: `item-${id}`, ordinal, providerResponseId: responseId }
      });
      let finish;
      let fail;
      const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      const submitted = [];
      controls.native.onController({
        endLogicalRequest() {}, async steer() {},
        async submitToolResults(batch) {
          try {
            const projections = await rows(app, 'ToolCallEvent', { event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT });
            const deliveries = await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' });
            assert.equal(projections.length, submitted.length + batch.length, 'freeze must commit before wire submission');
            assert.equal(deliveries.length, submitted.length, 'freeze must not pretend to be delivery acknowledgment');
            const decoded = batch.map(item => JSON.parse(item.output));
            outputs.push(...batch);
            submitted.push(...batch.map(item => item.callId));
            assert.doesNotMatch(JSON.stringify(decoded), /answerBridgeId|childExecutionId|modelRequestId|childHandles/);
            if (submitted.length === 2) {
              assert.deepEqual(decoded.map(item => item.detail.childRef), ['A1', 'A2']);
              await control({ type: 'response.created', responseId: 'response-followup', previousResponseId: 'response-spawn',
                admittedToolResultCallIds: batch.map(item => item.callId) });
              await call('send', 0, { operation: 'send', childRef: 'A1', prompt: 'follow up original child' }, 'response-followup');
              await call('unknown', 1, { operation: 'send', childRef: 'A999', prompt: 'must not run' }, 'response-followup');
              await control({ type: 'response.completed', responseId: 'response-followup' });
            } else {
              assert.equal(submitted.length, 4);
              assert.equal(decoded[0].detail.childRef, 'A1');
              assert.equal(decoded[1].status, 'failed');
              assert.match(decoded[1].detail.error, /A999/);
              await control({ type: 'response.created', responseId: 'response-final', previousResponseId: 'response-followup',
                admittedToolResultCallIds: batch.map(item => item.callId) });
              await control({ type: 'response.completed', responseId: 'response-final' });
              await event('completed', { role: 'model', parts: [{ text: 'done' }] });
              finish();
            }
          } catch (error) { fail(error); throw error; }
        }
      });
      await control({ type: 'response.created', responseId: 'response-spawn', capabilities });
      await call('spawn-one', 0, { operation: 'spawn', taskName: 'one', prompt: 'first independent task' }, 'response-spawn');
      await call('spawn-two', 1, { operation: 'spawn', taskName: 'two', prompt: 'second independent task' }, 'response-spawn');
      await control({ type: 'response.completed', responseId: 'response-spawn' });
      await done;
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
          baseUrl: 'https://native-fixture.invalid/v1', openaiResponsesTransport: 'http',
          nativeResponses: { enabled: true, asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false },
          retryPolicy: { enabled: false, maxRetries: 0 } },
        modelProfile: { compressionThresholdTokens: 100000, contextWindowTokens: 128000,
          tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
        toolPolicy: { id: 'tools', allowedTools: ['run_agent'], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
        planReviewPolicy: { mode: 'never' }, systemPrompt: { id: 'prompt', text: '' },
        runtimeContext: { id: null, name: '', template: '' },
        workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
      }) }
    }; } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('unused'); } },
    mcpPolicyGate: { async authorize() { throw new Error('unused'); } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
    providers: { resolve() { return adapter; } },
    toolDispatcher: {
      definitions() { return [definition]; },
      async dispatch() { throw new Error('native test must use scheduleAdmittedCall'); },
      async scheduleAdmittedCall(input) {
        executed.push(input.arguments);
        if (input.arguments.operation === 'send') assert.equal(input.arguments.answerBridgeId, 'answer_bridge_one');
        const bridge = input.arguments.operation === 'spawn' ? `answer_bridge_${input.arguments.taskName}` : input.arguments.answerBridgeId;
        const result = await app.runtime.effects.settleWithoutEffect({
          source: { kind: 'internal', key: `fixture:${input.toolCallId}` }, toolCallId: input.toolCallId,
          status: 'succeeded', detail: { ok: true, status: 'running', answerBridgeId: bridge }
        });
        return result.terminal;
      }
    }
  };
  try {
    app = await kernel.ReliableKernelApplication.open(root, dependencies);
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'parent', title: 'parent', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'agent-link', conversation_id: 'parent', agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now })
    ]);
    const started = await app.turns.input({ source: { kind: 'command', key: 'start-native-child-fixture' },
      conversationId: 'parent', leaseOwnerId: 'fixture', hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), content: 'delegate two tasks and follow up' });
    const [lease] = await rows(app, 'ExecutionLease', { turn_id: started.turnId });
    const fence = { id: lease.id, conversationId: lease.conversation_id, turnId: lease.turn_id,
      ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation) };
    const result = await kernel.runWithExecutionLeaseFence(fence, () => app.agentLoop.drive(started.turnId));
    if (result.terminalStatus !== 'completed') {
      assert.fail(JSON.stringify(await rows(app, 'TurnTermination', { turn_id: started.turnId })));
    }
    assert.equal(result.modelRequestIds.length, 1, 'spawn and send share one actual native logical request');
    assert.equal(executed.length, 3, 'unknown short reference never dispatches or spawns');
    assert.deepEqual(capturedRequest.recipe.modelHandleCatalog?.entries ?? [], [], 'initial recipe remains frozen');
    const frozenRefs = await readConversationChildHandles(app.database, app.contentStore, 'parent');
    assert.deepEqual(frozenRefs.map(entry => [entry.ref, entry.target]), [['A1', 'answer_bridge_one'], ['A2', 'answer_bridge_two']]);
    const eventRows = await rows(app, 'ToolCallEvent', { event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT });
    assert.equal(eventRows.length, 4);
    const checkpointRows = await rows(app, 'ModelStreamCheckpoint', { model_request_id: capturedRequest.modelRequestId });
    // Admission events retain source proofs after stream checkpoint pruning; the raw model history
    // and resolved ToolCall facts must still disagree exactly where short refs were translated.
    const [sendSource] = await rows(app, 'ToolCallSourceLink', { provider_call_id: 'send' });
    const [sendCall] = await rows(app, 'ToolCall', { id: sendSource.tool_call_id });
    const [argsMetadata] = await rows(app, 'ContentObject', { id: sendCall.arguments_object_id });
    const sendArgs = JSON.parse((await app.contentStore.read(argsMetadata)).toString('utf8'));
    assert.equal(sendArgs.answerBridgeId, 'answer_bridge_one');
    assert.equal(checkpointRows.length >= 1, true);
    await app.close();
    app = await kernel.ReliableKernelApplication.open(root, dependencies);
    assert.deepEqual(await readNativeRequestChildHandles(app.database, app.contentStore, capturedRequest.modelRequestId), frozenRefs);
    assert.deepEqual(await readConversationChildHandles(app.database, app.contentStore, 'parent'), frozenRefs);
    const recoveredSources = await rows(app, 'ToolCallSourceLink', { model_request_id: capturedRequest.modelRequestId });
    const recovered = new NativeRequestSession({
      database: app.database, contentStore: app.contentStore, context: app.context, turnOutput: app.turnOutput,
      effects: app.runtime.effects, tools: dependencies.toolDispatcher, modelProvider: app.modelProvider,
      conversationId: 'parent', turnId: started.turnId, modelRequestId: capturedRequest.modelRequestId,
      providerId: 'native-provider', modelId: 'gpt-6-astra', capabilities, modelHandleCatalog: { entries: [] },
      resolveAdapter: async () => adapter, resolveDefinition: () => definition,
      resolveCallArguments: (name, args) => ({ arguments: resolveModelToolArguments(name, args, recovered.currentModelHandleCatalog()) }),
      freezePolicies: async () => { throw new Error('recovery must not admit new calls'); },
      dispatchCall: async () => { throw new Error('recovery must not rerun settled calls'); },
      toolCallIdFor: (_ordinal, providerId) => {
        const source = recoveredSources.find(entry => entry.provider_call_id === providerId);
        assert.ok(source, 'recovery identity must already be a committed native ToolCall');
        return source.tool_call_id;
      },
      closeAdmittedCall: async () => {}, now: () => new Date().toISOString()
    });
    await recovered.reconcile();
    assert.equal(resolveModelToolArguments('run_agent', { operation: 'send', childRef: 'A2' }, recovered.currentModelHandleCatalog()).answerBridgeId, 'answer_bridge_two');
    const [firstSource] = await rows(app, 'ToolCallSourceLink', { provider_call_id: 'spawn-one' });
    const [firstResult] = await rows(app, 'ToolModelResult', { tool_call_id: firstSource.tool_call_id });
    const replay = await recovered.buildFunctionCallOutput({ name: 'run_agent', toolCallId: firstSource.tool_call_id,
      providerCallId: 'spawn-one', toolModelResultId: firstResult.id });
    assert.equal(replay.output, outputs[0].output, 'replay bytes cannot change after later child allocations');
    assert.equal((await rows(app, 'ToolCallEvent', { event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT })).length, 4);
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('recovery of admitted unsettled native calls dispatches frozen canonical arguments and settles frozen unknown-reference errors', { timeout: 5000 }, async () => {
  const catalog = { entries: [{ kind: 'child', ref: 'A1', target: 'answer_bridge_original' }] };
  const unknownArgs = { operation: 'send', childRef: 'A999', prompt: 'must remain rejected' };
  let unknownMessage;
  try { resolveModelToolArguments('run_agent', unknownArgs, catalog); } catch (error) { unknownMessage = error.message; }
  const proofs = [
    { type: 'native_tool_call', responseId: 'response', toolName: 'run_agent', providerCallId: 'valid-send', providerOrdinal: 0,
      async: true, arguments: { operation: 'send', childRef: 'A1', prompt: 'continue' },
      resolvedArguments: { operation: 'send', answerBridgeId: 'answer_bridge_original', prompt: 'continue' }, modelHandleCatalog: catalog },
    { type: 'native_tool_call', responseId: 'response', toolName: 'run_agent', providerCallId: 'invalid-send', providerOrdinal: 1,
      async: true, arguments: unknownArgs, resolvedArguments: unknownArgs, argumentResolutionError: unknownMessage, modelHandleCatalog: catalog }
  ];
  const admissions = new Map(proofs.map(proof => [proof.providerCallId, { toolCallId: proof.providerCallId, declaredAsync: true }]));
  const terminals = new Map();
  const dispatched = [];
  const rejected = [];
  let complete;
  const completed = new Promise(resolve => { complete = resolve; });
  const settle = id => { terminals.set(id, { toolModelResultId: `result-${id}` }); if (terminals.size === 2) complete(); };
  const effects = {
    async listNativePendingWork() { return proofs.map(proof => ({ toolCallId: proof.providerCallId, settled: false, delivered: false })); },
    async readNativeAdmission(id) { return admissions.get(id); },
    async readTerminalResult(id) { return terminals.get(id); },
    async settleWithoutEffect(input) { rejected.push(input); settle(input.toolCallId); return { terminal: terminals.get(input.toolCallId) }; }
  };
  const database = {
    async snapshotAll(query) {
      if (query.domain === 'ModelStreamCheckpoint') return { snapshot: proofs.map((_, index) => ({
        checkpoint_kind: 'native_tool_call', content_object_id: String(index), stream_seq: String(index + 1)
      })) };
      return { snapshot: [] };
    },
    async snapshot(queries) { return { snapshot: queries.map(query => query.domain === 'ContentObject' ? { id: query.id } : null) }; }
  };
  // Reproduce the precise crash boundary: provider proof and admission are committed, neither
  // valid execution nor invalid-reference failure has settled yet. The original raw args remain.
  for (const proof of proofs) {
    assert.ok(await effects.readNativeAdmission(proof.providerCallId));
    assert.equal(await effects.readTerminalResult(proof.providerCallId), undefined);
  }
  const session = new NativeRequestSession({
    database, contentStore: { async read(metadata) { return Buffer.from(JSON.stringify({ content: proofs[Number(metadata.id)] })); } },
    effects, tools: {}, modelProvider: { nativeSteering: { async receiptsForTurn() { return []; } } },
    conversationId: 'parent', turnId: 'turn', modelRequestId: 'request', providerId: 'provider', modelId: 'gpt-6-astra',
    // Even a later runtime map must not reinterpret the frozen failed proof into a valid call.
    modelHandleCatalog: { entries: [...catalog.entries, { kind: 'child', ref: 'A999', target: 'answer_bridge_later' }] },
    capabilities, resolveAdapter: async () => { throw new Error('not sending during recovery fixture'); },
    resolveDefinition: () => definition, resolveCallArguments: () => { throw new Error('recovery must use persisted resolution'); },
    freezePolicies: async () => { throw new Error('admitted calls do not refreeze policy'); },
    async dispatchCall(input) { dispatched.push(input); settle(input.toolCallId); return terminals.get(input.toolCallId); },
    toolCallIdFor: (_ordinal, providerId) => providerId, closeAdmittedCall: async () => {}, now: () => new Date().toISOString()
  });
  await session.reconcile();
  await completed;
  assert.equal(dispatched.length, 1);
  assert.deepEqual(dispatched[0].arguments, proofs[0].resolvedArguments);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].toolCallId, 'invalid-send');
  assert.equal(rejected[0].status, 'failed');
  assert.equal(rejected[0].detail.error, unknownMessage);
});

test('native call proofs reject missing catalogs, missing resolutions and raw-to-resolved tampering', () => {
  const proof = { type: 'native_tool_call', responseId: 'response', toolName: 'run_agent', providerCallId: 'call',
    providerOrdinal: 0, async: true, arguments: { operation: 'spawn', prompt: 'original' },
    resolvedArguments: { operation: 'spawn', prompt: 'original' }, modelHandleCatalog: { entries: [] } };
  assert.deepEqual(parseNativeToolCallCheckpoint(proof).arguments, proof.arguments);
  const { resolvedArguments, ...missingResolution } = proof;
  assert.throws(() => parseNativeToolCallCheckpoint(missingResolution), /resolvedArguments/);
  const { modelHandleCatalog, ...missingCatalog } = proof;
  assert.throws(() => parseNativeToolCallCheckpoint(missingCatalog), /modelHandleCatalog/);
  assert.throws(() => parseNativeToolCallCheckpoint({ ...proof, modelHandleCatalog: null }), /modelHandleCatalog/);
  assert.throws(() => parseNativeToolCallCheckpoint({ ...proof, modelHandleCatalog: {} }), /entries/);
  assert.throws(() => parseNativeToolCallCheckpoint({ ...proof, arguments: { operation: 'spawn', prompt: 'tampered' } }), /conflicts with original/);
});
