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
const { emptyConversationContextHandleStateStep } = load('backend/reliableKernel/conversationContextHandleState.js');
const { NativeRequestSession } = load('backend/reliableKernel/nativeRequestSession.js');
const { readConversationChildHandles, readNativeRequestChildHandles, NATIVE_CHILD_HANDLE_PROJECTION_EVENT } =
  load('backend/reliableKernel/conversationChildHandles.js');
const { resolveModelToolArguments } = load('backend/reliableKernel/modelHandleCatalog.js');
const { parseNativeToolCallCheckpoint } = load('backend/reliableKernel/nativeToolFacts.js');

const capabilities = { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false, explicitCaching: true };
const definition = { name: 'run_agent', description: 'native child handle fixture', parameters: { type: 'object' } };
const rows = async (app, domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain)
  .list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;

for (const blockedReference of [false, true]) {
test(`native settled batches freeze child refs across ModelRequests and reopen${blockedReference ? ' with an ordered invalid-reference result' : ''}`, { timeout: 30000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-child-handles-'));
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  let app;
  const capturedRequests = [];
  const executed = [];
  let releasePredecessor;
  const predecessorReady = new Promise(resolve => { releasePredecessor = resolve; });
  const adapter = {
    providerId: 'native-provider',
    async materializeNativeToolOutput(values) { return values; },
    async sendFullRequest(request, controls) {
      capturedRequests.push(request);
      const round = capturedRequests.length;
      assert.ok(controls.native, 'this must exercise nativeResponses execution, not provider_native compression');
      let sequence = 0;
      const event = (kind, content) => controls.onEvent({ kind, streamSeq: String(++sequence), content });
      const control = content => event('native_control', content);
      const call = (id, ordinal, args, responseId) => event('output_item_done', {
        type: 'tool_calls', calls: [{ id, ordinal, name: 'run_agent', arguments: args, async: false }],
        outputItem: { id: `item-${id}`, ordinal, providerResponseId: responseId }
      });
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      controls.native.onController({
        endLogicalRequest() { finish(); },
        async steer() { assert.fail('child tool results never become user steering'); },
        async submitToolResults() { assert.fail('the complete settled batch must yield to a preflighted full request'); }
      });
      const responseId = ['response-spawn', 'response-followup', 'response-final'][round - 1];
      assert.ok(responseId, 'two complete batches then one final response');
      if (round > 1) {
        const projected = await rows(app, 'ToolCallEvent', { event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT });
        assert.equal(projected.length, round === 2 ? 2 : 4,
          'prior batch child refs are frozen before the carrier request');
        assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 0,
          'context carryover is not a native provider admission');
        const childRefs = request.recipe.modelHandleCatalog.entries.filter(entry => entry.kind === 'child');
        assert.deepEqual(childRefs.map(entry => [entry.ref, entry.target]),
          [['A1', 'answer_bridge_one'], ['A2', 'answer_bridge_two']]);
        assert.ok(request.context.some(segment => segment.segmentKind === 'tool_pair'
          && segment.content.includes(round === 2 ? 'spawn-one' : 'send')),
        'the next frozen full-request context retains the previous tool batch');
      }
      await control({ type: 'response.created', responseId, capabilities });
      if (round === 1) {
        await call('spawn-one', 0, { operation: 'spawn', taskName: 'one', prompt: 'first independent task' }, responseId);
        await call('spawn-two', 1, { operation: 'spawn', taskName: 'two', prompt: 'second independent task' }, responseId);
      } else if (round === 2) {
        await call('send', 0, { operation: 'send', childRef: 'A1', prompt: 'follow up original child' }, responseId);
        await call('unknown', 1, { operation: 'send', childRef: 'A999', prompt: 'must not run' }, responseId);
      }
      await control({ type: 'response.completed', responseId });
      if (blockedReference && round === 2) {
        const [source] = await rows(app, 'ToolCallSourceLink', { provider_call_id: 'unknown' });
        assert.ok(source, 'the invalid reference was durably admitted while its predecessor waits');
        assert.equal((await rows(app, 'Operation', { tool_call_id: source.tool_call_id }))[0].status, 'failed');
        assert.equal((await rows(app, 'ToolResultArtifact', { tool_call_id: source.tool_call_id })).length, 1);
        assert.equal(await app.runtime.effects.readTerminalResult(source.tool_call_id, false), null,
          'a failed artifact behind an unfinished predecessor is not yet a model result');
        releasePredecessor();
      }
      if (round === 3) {
        await event('completed', { role: 'model', parts: [{ text: 'done' }] });
      } else {
        await done;
        await event('completed', { role: 'model', parts: round === 1
          ? [{ id: 'spawn-one', functionCall: { name: 'run_agent', args: { operation: 'spawn', taskName: 'one', prompt: 'first independent task' } } },
            { id: 'spawn-two', functionCall: { name: 'run_agent', args: { operation: 'spawn', taskName: 'two', prompt: 'second independent task' } } }]
          : [{ id: 'send', functionCall: { name: 'run_agent', args: { operation: 'send', childRef: 'A1', prompt: 'follow up original child' } } },
            { id: 'unknown', functionCall: { name: 'run_agent', args: { operation: 'send', childRef: 'A999', prompt: 'must not run' } } }] });
      }
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
      subscribeToolSettlements({ turnId }, listener) {
        return app.runtime.effects.subscribeToolModelResults(events => {
          for (const event of events) if (event.turnId === turnId) listener(event);
        });
      },
      async dispatch() { throw new Error('native test must use scheduleAdmittedCall'); },
      async scheduleAdmittedCall(input) {
        executed.push(input.arguments);
        if (input.arguments.operation === 'send') {
          assert.equal(input.arguments.answerBridgeId, 'answer_bridge_one');
          if (blockedReference) await predecessorReady;
        }
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
      emptyConversationContextHandleStateStep('parent', now),
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
    assert.equal(result.modelRequestIds.length, 3, 'two safe tool batches yield before the final ModelRequest of ONE Turn');
    assert.equal(new Set(result.modelRequestIds).size, 3);
    assert.equal(executed.length, 3, 'unknown short reference never dispatches or spawns');
    assert.deepEqual(capturedRequests[0].recipe.modelHandleCatalog?.entries ?? [], [], 'initial recipe remains frozen');
    const frozenRefs = await readConversationChildHandles(app.database, app.contentStore, 'parent');
    assert.deepEqual(frozenRefs.map(entry => [entry.ref, entry.target]), [['A1', 'answer_bridge_one'], ['A2', 'answer_bridge_two']]);
    const eventRows = await rows(app, 'ToolCallEvent', { event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT });
    assert.equal(eventRows.length, 4);
    const checkpointRows = await rows(app, 'ModelStreamCheckpoint', { model_request_id: capturedRequests[0].modelRequestId });
    // Admission events retain source proofs after stream checkpoint pruning; the raw model history
    // and resolved ToolCall facts must still disagree exactly where short refs were translated.
    const [sendSource] = await rows(app, 'ToolCallSourceLink', { provider_call_id: 'send' });
    const [sendCall] = await rows(app, 'ToolCall', { id: sendSource.tool_call_id });
    const [argsMetadata] = await rows(app, 'ContentObject', { id: sendCall.arguments_object_id });
    const sendArgs = JSON.parse((await app.contentStore.read(argsMetadata)).toString('utf8'));
    assert.equal(sendArgs.answerBridgeId, 'answer_bridge_one');
    assert.equal(checkpointRows.length >= 1, true);
    const frozenOutputs = [];
    for (const row of eventRows) {
      const [metadata] = await rows(app, 'ContentObject', { id: row.content_object_id });
      const projection = JSON.parse((await app.contentStore.read(metadata)).toString('utf8'));
      assert.ok([capturedRequests[0].modelRequestId, capturedRequests[1].modelRequestId]
        .includes(projection.modelRequestId), 'frozen child result belongs to its own ModelRequest');
      const decoded = JSON.parse(projection.output);
      assert.doesNotMatch(projection.output, /answerBridgeId|childExecutionId|modelRequestId|childHandles/);
      frozenOutputs.push({ toolCallId: row.tool_call_id, output: projection.output, decoded });
    }
    assert.deepEqual(frozenOutputs.filter(item => item.decoded.detail?.childRef)
      .map(item => item.decoded.detail.childRef).sort(), ['A1', 'A1', 'A2']);
    assert.equal(frozenOutputs.filter(item => item.decoded.status === 'failed').length, 1);
    assert.match(frozenOutputs.find(item => item.decoded.status === 'failed').decoded.detail.error, /A999/);
    assert.equal((await rows(app, 'ContextSegmentSource', { source_kind: 'tool_model_result' })).length, 4);
    assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 0);
    await app.close();
    app = await kernel.ReliableKernelApplication.open(root, dependencies);
    assert.deepEqual(await readNativeRequestChildHandles(app.database, app.contentStore, capturedRequests[0].modelRequestId), frozenRefs);
    assert.deepEqual(await readConversationChildHandles(app.database, app.contentStore, 'parent'), frozenRefs);
    const recoveredSources = await rows(app, 'ToolCallSourceLink', { model_request_id: capturedRequests[0].modelRequestId });
    const [frozenRequest] = await rows(app, 'ModelRequest', { id: capturedRequests[0].modelRequestId });
    const [projection] = await rows(app, 'ModelContextProjection', {
      owner_kind: 'model_request', owner_id: capturedRequests[0].modelRequestId
    });
    const [requestRecipeMetadata] = await rows(app, 'ContentObject', { id: frozenRequest.recipe_object_id });
    const persistedRecipe = JSON.parse((await app.contentStore.read(requestRecipeMetadata)).toString('utf8'));
    const frozenBudget = persistedRecipe.nativeLogicalBudget;
    assert.deepEqual(frozenBudget, capturedRequests[0].recipe.nativeLogicalBudget);
    assert.ok(frozenBudget && projection?.root_id, 'recovery must use the request\'s real frozen budget and Context root');
    const recovered = new NativeRequestSession({
      database: app.database, contentStore: app.contentStore, context: app.context, turnOutput: app.turnOutput,
      effects: app.runtime.effects, tools: dependencies.toolDispatcher, modelProvider: app.modelProvider,
      conversationId: 'parent', turnId: started.turnId, modelRequestId: capturedRequests[0].modelRequestId,
      providerId: 'native-provider', modelId: 'gpt-6-astra', capabilities, modelHandleCatalog: { entries: [] },
      budget: frozenBudget, initialContextRootId: projection.root_id,
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
    assert.equal(replay.output, frozenOutputs.find(item => item.toolCallId === firstSource.tool_call_id).output,
      'replay bytes cannot change after later child allocations');
    assert.equal((await rows(app, 'ContextSegmentSource', { source_kind: 'tool_model_result' })).length, 4,
      'replay never adds a second result occurrence');
    assert.equal((await rows(app, 'ToolCallEvent', { event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT })).length, 4);
  } finally {
    releasePredecessor();
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
}

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
    async listNativePendingWork() { return proofs.map(proof => ({ toolCallId: proof.providerCallId, settled: false, delivered: false,
      callContextSegmentId: `segment-${proof.providerCallId}` })); },
    async readNativeAdmission(id) { return admissions.get(id); },
    async readTerminalResult(id) { return terminals.get(id); },
    async settleWithoutEffect(input) { rejected.push(input); settle(input.toolCallId); return { terminal: terminals.get(input.toolCallId) }; }
  };
  const database = {
    async snapshotAll(query) {
      if (query.domain === 'ModelStreamCheckpoint') return { snapshot: proofs.map((_, index) => ({
        checkpoint_kind: 'native_tool_call', content_object_id: String(index), stream_seq: String(index + 1),
        attempt_seq: '1', socket_generation: '1'
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
    effects, tools: {}, modelProvider: {
      async readNativeLatestResponseUsage() { return undefined; },
      nativeSteering: { async receiptsForTurn() { return []; } }
    },
    conversationId: 'parent', turnId: 'turn', modelRequestId: 'request', providerId: 'provider', modelId: 'gpt-6-astra',
    // Even a later runtime map must not reinterpret the frozen failed proof into a valid call.
    modelHandleCatalog: { entries: [...catalog.entries, { kind: 'child', ref: 'A999', target: 'answer_bridge_later' }] },
    capabilities, budget: { planningInputCapacityTokens: 128000, compressionThresholdTokens: 100000,
      autoCompressionEnabled: false }, initialContextRootId: 'fixture-frozen-context-root',
    resolveAdapter: async () => { throw new Error('not sending during recovery fixture'); },
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

test('native call proofs reject missing catalogs and missing resolutions and keep the frozen resolution as recorded', () => {
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
  // The content-addressed frozen resolution is the authority; a later resolver never re-derives it.
  const frozen = { ...proof, resolvedArguments: { operation: 'spawn', prompt: 'original', frozenBy: 'an earlier build' } };
  assert.deepEqual(parseNativeToolCallCheckpoint(frozen).resolvedArguments, frozen.resolvedArguments);
});

function nativeResultProjectionFixture(results) {
  const domains = new Map();
  const bodies = new Map();
  const put = (domain, row) => {
    if (!domains.has(domain)) domains.set(domain, new Map());
    domains.get(domain).set(row.id, row);
  };
  put('Conversation', { id: 'projection-conversation' });
  put('Turn', { id: 'projection-turn', conversation_id: 'projection-conversation' });
  const initialState = emptyConversationContextHandleStateStep('projection-conversation', '2026-09-30T00:00:00.000Z');
  put(initialState.domain, initialState.row);
  put('ModelRequest', { id: 'projection-request', turn_id: 'projection-turn' });
  for (const [index, result] of results.entries()) {
    const id = `projection-call-${index}`;
    const body = `result-body-${index}`;
    put('ToolCall', { id, turn_id: 'projection-turn', tool_name: result.name, status: 'terminal' });
    put('ToolCallSourceLink', { id: `source-${index}`, tool_call_id: id, model_request_id: 'projection-request' });
    put('ToolModelResult', { id: `result-${index}`, tool_call_id: id, message_revision_id: `revision-${index}` });
    put('MessageRevision', { id: `revision-${index}`, content_object_id: body });
    put('ContentObject', { id: body, content_type: 'application/json' });
    bodies.set(body, JSON.stringify(result.value));
  }
  const select = read => [...(domains.get(read.domain)?.values() ?? [])]
    .filter(row => Object.entries(read.where ?? {}).every(([key, value]) => row[key] === value));
  const database = {
    async snapshot(reads) { return { snapshot: reads.map(read => read.kind === 'get'
      ? domains.get(read.domain)?.get(read.id) ?? null : select(read).slice(0, read.limit)) }; },
    async snapshotAll(read) { return { snapshot: select(read) }; },
    async transaction(steps) {
      const apply = step => {
        if (step.kind === 'savepoint') { step.steps.forEach(apply); return; }
        if (step.kind === 'insert' || step.kind === 'insertWithNextSequence') {
          assert.equal(domains.get(step.domain)?.has(step.row.id) ?? false, false, 'projection must be frozen once');
          put(step.domain, { ...step.row });
        } else if (step.kind === 'update') {
          const current = domains.get(step.domain)?.get(step.id);
          assert.ok(current, 'updates require an existing fixture row');
          put(step.domain, { ...current, ...step.patch });
        } else if (step.kind === 'assert') {
          const current = domains.get(step.domain)?.get(step.id);
          assert.ok(current, 'assertions require an existing fixture row');
          for (const [key, value] of Object.entries(step.where)) assert.deepEqual(current[key], value);
        } else if (step.kind === 'assertNone') {
          assert.equal(select(step).length, 0);
        } else assert.fail(`Unsupported fixture transaction step: ${step.kind}`);
      };
      steps.forEach(apply);
      return {};
    }
  };
  let counter = 0;
  const contentStore = {
    async read(metadata) { assert.ok(bodies.has(metadata.id)); return Buffer.from(bodies.get(metadata.id)); },
    async readMany(metadata) { return Promise.all(metadata.map(value => this.read(value))); },
    async prepare(_database, content, contentType) {
      const metadata = { id: `projection-body-${counter++}`, content_type: contentType, sha256: 'fixture',
        byte_length: BigInt(Buffer.byteLength(content)), storage_key: `projection-${counter}` };
      bodies.set(metadata.id, content);
      put('ContentObject', metadata);
      return { metadata };
    }
  };
  const submitted = [];
  let ended = 0;
  const session = new NativeRequestSession({ database, contentStore, tools: {}, capabilities,
    modelRequestId: 'projection-request', turnId: 'projection-turn', providerId: 'projection-provider',
    modelHandleCatalog: { entries: [] }, now: () => new Date().toISOString(),
    budget: { planningInputCapacityTokens: 200000, compressionThresholdTokens: 180000, autoCompressionEnabled: false },
    modelProvider: { async readNativeLatestResponseUsage() { return {
      responseId: 'projection-response', streamSeq: '3', attemptSeq: '1', socketGeneration: '1',
      physicalResponseCount: 1, inputTokens: 150
    }; } },
    resolveAdapter: async () => ({ materializeNativeToolOutput: async outputs => outputs })
  });
  session.bindStream({ attemptSeq: '1', socketGeneration: '1' });
  session.responseOrder.push('projection-response');
  session.responses.set('projection-response', { responseId: 'projection-response', admissionBoundary: true,
    completed: true, boundarySeq: '3', syncRequired: false });
  for (const [index, result] of results.entries()) {
    session.calls.set(`projection-call-${index}`, { name: result.name, toolCallId: `projection-call-${index}`,
      toolModelResultId: `result-${index}`, providerCallId: `wire-${index}`, responseId: 'projection-response',
      providerOrdinal: index, asyncDeclared: true, admitted: true, settled: true, delivered: false });
  }
  session.calls.set('still-running', { name: 'slow_fixture', toolCallId: 'still-running', providerCallId: 'wire-slow',
    responseId: 'projection-response', providerOrdinal: results.length, asyncDeclared: true,
    admitted: true, settled: false, delivered: false });
  session.controller = { endLogicalRequest() { ended += 1; }, async submitToolResults(outputs) { submitted.push(outputs); } };
  return { session, database, contentStore, bodies, domains, submitted, ended: () => ended };
}

test('native async process results are bounded, actionable and durably replayed without changing receipts', async () => {
  const raw = { status: 'succeeded', detail: { status: 'background_started', processId: 'new-native-process',
    stdout: 'large output\n'.repeat(20000), hasMore: true, nextOutputHandle: 'rk-process-output:native-page' } };
  const fixture = nativeResultProjectionFixture([{ name: 'bash', value: raw }]);
  await fixture.session.pumpLoop();
  assert.equal(fixture.submitted.length, 1, 'the unsettled async sibling keeps this on the native delivery path');
  const output = fixture.submitted[0][0].output;
  assert.ok(output.length < 20000, 'the whole large receipt must never reach the wire');
  assert.doesNotMatch(output, /new-native-process|rk-process-output:native-page/);
  assert.match(output, /P1/);
  assert.match(output, /O1/);
  assert.deepEqual(resolveModelToolArguments('bash', { mode: 'output', processRef: 'P1', cursor: 'O1' },
    fixture.session.currentModelHandleCatalog()), { mode: 'output', processId: 'new-native-process', outputHandle: 'rk-process-output:native-page' });
  assert.equal(fixture.bodies.get('result-body-0'), JSON.stringify(raw), 'receipt bytes stay immutable');
  const restored = await readNativeRequestChildHandles(fixture.database, fixture.contentStore, 'projection-request');
  assert.ok(restored.some(entry => entry.kind === 'process' && entry.ref === 'P1' && entry.target === 'new-native-process'));
  fixture.session.childCatalog = { entries: restored };
  const replay = await fixture.session.buildFunctionCallOutput(fixture.session.calls.get('projection-call-0'));
  assert.equal(replay.output, output, 'already frozen delivery bytes must survive recovery unchanged');
  assert.equal(fixture.domains.get('ToolCallEvent').size, 1);
});

test('oversized native result batches wait for settled work then rebase instead of sending unbounded bytes', async () => {
  const results = Array.from({ length: 6 }, (_, index) => ({ name: 'bash', value: {
    status: 'succeeded', detail: { status: 'background_started', processId: `batch-process-${index}`,
      stdout: 'large output\n'.repeat(20000), hasMore: true }
  } }));
  const fixture = nativeResultProjectionFixture(results);
  await fixture.session.pumpLoop();
  assert.equal(fixture.submitted.length, 0);
  assert.equal(fixture.session.budgetClosureRequested, true);
  assert.equal(fixture.ended(), 0, 'the other already-admitted effect must not be cancelled');
  fixture.session.calls.get('still-running').settled = true;
  await fixture.session.pumpLoop();
  assert.equal(fixture.ended(), 1);
  assert.equal(fixture.submitted.length, 0);
});

test('native bounded projection keeps receipt media separate from JSON and preserves exact image data', () => {
  const { projectNativeToolResultOutput } = load('backend/reliableKernel/modelFacingContextProjection.js');
  const raw = { status: 'succeeded', detail: { path: 'image.png', parts: [{ inlineData: {
    mimeType: 'image/png', data: 'aW1hZ2U=', name: 'image.png'
  } }] } };
  const output = projectNativeToolResultOutput('read', raw, { entries: [] });
  assert.equal(output[0].type, 'input_text');
  assert.doesNotMatch(output[0].text, /aW1hZ2U=|inlineData/);
  assert.deepEqual(output[1], { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' });
  assert.equal(raw.detail.parts[0].inlineData.data, 'aW1hZ2U=');
});
