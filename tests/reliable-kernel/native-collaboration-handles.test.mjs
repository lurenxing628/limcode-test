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
const definition = name => ({ name, description: 'native collaboration handle fixture', parameters: { type: 'object' } });
const rows = async (app, domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain)
  .list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;

async function frozenNativeOutput(app, providerCallId) {
  const [source] = await rows(app, 'ToolCallSourceLink', { provider_call_id: providerCallId });
  assert.ok(source, `${providerCallId} has a durable native ToolCall`);
  const [projection] = await rows(app, 'ToolCallEvent', {
    tool_call_id: source.tool_call_id, event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT
  });
  assert.ok(projection, `${providerCallId} freezes its model-facing output before checkpoint`);
  const [metadata] = await rows(app, 'ContentObject', { id: projection.content_object_id });
  const bytes = (await app.contentStore.read(metadata)).toString('utf8');
  return { output: JSON.parse(bytes).output, source };
}

for (const [listTool, sendTool, resultKind] of [['list_agents', 'send_agent_message', 'agent_collaboration'],
  ['list_conversations', 'send_conversation_message', 'cross_conversation']]) test(`native ${sendTool} freezes references across ModelRequests of one Turn, restart and replay`, { timeout: 30000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-child-handles-'));
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  let app;
  const capturedRequests = [];
  const executed = [];
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
        type: 'tool_calls', calls: [{ id, ordinal, name: args.operation === 'spawn' ? listTool : sendTool,
          arguments: args.operation === 'spawn' ? {} : args, async: false }],
        outputItem: { id: `item-${id}`, ordinal, providerResponseId: responseId }
      });
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      controls.native.onController({
        endLogicalRequest() { finish(); },
        async steer() { assert.fail('peer tool results never become user steering'); },
        async submitToolResults() { assert.fail('safe tool batches need a new preflighted full request'); }
      });
      const responseId = ['response-spawn', 'response-followup', 'response-final'][round - 1];
      assert.ok(responseId);
      if (round > 1) {
        const projected = await rows(app, 'ToolCallEvent', { event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT });
        assert.equal(projected.length, round === 2 ? 2 : 4,
          'all prior child refs freeze before the next request');
        assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 0,
          'local checkpoint is not provider result admission');
        const refs = request.recipe.modelHandleCatalog.entries.filter(entry => entry.kind === 'conversation');
        assert.deepEqual(refs.map(entry => [entry.ref, entry.target]),
          [['C1', 'conversation_one'], ['C2', 'conversation_two']]);
        assert.ok(request.context.some(segment => segment.segmentKind === 'tool_pair'),
          'the successor carries frozen Context tool results within this Turn');
      }
      await control({ type: 'response.created', responseId, capabilities });
      if (round === 1) {
        await call('spawn-one', 0, { operation: 'spawn', taskName: 'one' }, responseId);
        await call('spawn-two', 1, { operation: 'spawn', taskName: 'two' }, responseId);
      } else if (round === 2) {
        const mode = sendTool === 'send_conversation_message' ? { mode: 'followup' } : {};
        await call('send', 0, { conversationRef: 'C1', text: 'follow up original peer', ...mode }, responseId);
        await call('unknown', 1, { conversationRef: 'C999', text: 'must not run', ...mode }, responseId);
      }
      await control({ type: 'response.completed', responseId });
      if (round === 3) {
        await event('completed', { role: 'model', parts: [{ text: 'done' }] });
      } else {
        await done;
        await event('completed', { role: 'model', parts: round === 1
          ? [{ id: 'spawn-one', functionCall: { name: listTool, args: {} } },
            { id: 'spawn-two', functionCall: { name: listTool, args: {} } }]
          : [{ id: 'send', functionCall: { name: sendTool, args: { conversationRef: 'C1' } } },
            { id: 'unknown', functionCall: { name: sendTool, args: { conversationRef: 'C999' } } }] });
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
        toolPolicy: { id: 'tools', allowedTools: [listTool, sendTool], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
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
      definitions() { return [definition(listTool), definition(sendTool)]; },
      async dispatch() { throw new Error('native test must use scheduleAdmittedCall'); },
      async scheduleAdmittedCall(input) {
        executed.push(input.arguments);
        if (input.toolName === sendTool) assert.equal(input.arguments.targetConversationId, 'conversation_one');
        const target = input.toolName === listTool ? `conversation_${executed.length === 1 ? 'one' : 'two'}` : input.arguments.targetConversationId;
        const result = await app.runtime.effects.settleWithoutEffect({
          source: { kind: 'internal', key: `fixture:${input.toolCallId}` }, toolCallId: input.toolCallId,
          status: 'succeeded', detail: { kind: resultKind, ok: true, status: 'running', conversationId: target }
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
    assert.equal(result.modelRequestIds.length, 3, 'two settled batches cross separately preflighted ModelRequests in ONE Turn');
    assert.equal(executed.length, 3, 'unknown short reference never dispatches or spawns');
    assert.deepEqual(capturedRequests[0].recipe.modelHandleCatalog?.entries ?? [], [], 'initial recipe remains frozen');
    const frozenRefs = await readConversationChildHandles(app.database, app.contentStore, 'parent');
    assert.deepEqual(frozenRefs.map(entry => [entry.ref, entry.target]), [['C1', 'conversation_one'], ['C2', 'conversation_two']]);
    const eventRows = await rows(app, 'ToolCallEvent', { event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT });
    assert.equal(eventRows.length, 4);
    const checkpointRows = await rows(app, 'ModelStreamCheckpoint', { model_request_id: capturedRequests[0].modelRequestId });
    // Admission events retain source proofs after stream checkpoint pruning; the raw model history
    // and resolved ToolCall facts must still disagree exactly where short refs were translated.
    const [sendSource] = await rows(app, 'ToolCallSourceLink', { provider_call_id: 'send' });
    const [sendCall] = await rows(app, 'ToolCall', { id: sendSource.tool_call_id });
    const [argsMetadata] = await rows(app, 'ContentObject', { id: sendCall.arguments_object_id });
    const sendArgs = JSON.parse((await app.contentStore.read(argsMetadata)).toString('utf8'));
    assert.equal(sendArgs.targetConversationId, 'conversation_one');
    assert.equal(checkpointRows.length >= 1, true);
    const frozenOutputs = [];
    for (const providerCallId of ['spawn-one', 'spawn-two', 'send', 'unknown']) {
      const frozen = await frozenNativeOutput(app, providerCallId);
      assert.doesNotMatch(frozen.output, /conversationId|childExecutionId|modelRequestId|childHandles/);
      frozenOutputs.push({ ...frozen, decoded: JSON.parse(frozen.output) });
    }
    assert.deepEqual(frozenOutputs.slice(0, 2).map(item => item.decoded.detail.conversationRef), ['C1', 'C2']);
    assert.equal(frozenOutputs[2].decoded.detail.conversationRef, 'C1');
    assert.equal(frozenOutputs[3].decoded.status, 'failed');
    assert.match(frozenOutputs[3].decoded.detail.error, /C999/);
    assert.equal((await rows(app, 'ContextSegmentSource', { source_kind: 'tool_model_result' })).length, 4);
    assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 0);
    await app.close();
    app = await kernel.ReliableKernelApplication.open(root, dependencies);
    assert.deepEqual(await readNativeRequestChildHandles(app.database, app.contentStore, capturedRequests[0].modelRequestId), frozenRefs);
    assert.deepEqual(await readConversationChildHandles(app.database, app.contentStore, 'parent'), frozenRefs);
    const recoveredSources = await rows(app, 'ToolCallSourceLink', { model_request_id: capturedRequests[0].modelRequestId });
    const [persistedRequest] = await rows(app, 'ModelRequest', { id: capturedRequests[0].modelRequestId });
    const [recipeMetadata] = await rows(app, 'ContentObject', { id: persistedRequest.recipe_object_id });
    const frozenBudget = JSON.parse((await app.contentStore.read(recipeMetadata)).toString('utf8')).nativeLogicalBudget;
    const [projection] = await rows(app, 'ModelContextProjection', {
      owner_kind: 'model_request', owner_id: capturedRequests[0].modelRequestId
    });
    assert.deepEqual(frozenBudget, capturedRequests[0].recipe.nativeLogicalBudget);
    const recovered = new NativeRequestSession({
      database: app.database, contentStore: app.contentStore, context: app.context, turnOutput: app.turnOutput,
      effects: app.runtime.effects, tools: dependencies.toolDispatcher, modelProvider: app.modelProvider,
      conversationId: 'parent', turnId: started.turnId, modelRequestId: capturedRequests[0].modelRequestId,
      providerId: 'native-provider', modelId: 'gpt-6-astra', capabilities, modelHandleCatalog: { entries: [] },
      budget: frozenBudget, initialContextRootId: projection.root_id,
      resolveAdapter: async () => adapter, resolveDefinition: definition,
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
    assert.equal(resolveModelToolArguments(sendTool, { conversationRef: 'C2' }, recovered.currentModelHandleCatalog()).targetConversationId, 'conversation_two');
    const [firstSource] = await rows(app, 'ToolCallSourceLink', { provider_call_id: 'spawn-one' });
    const [firstResult] = await rows(app, 'ToolModelResult', { tool_call_id: firstSource.tool_call_id });
    const replay = await recovered.buildFunctionCallOutput({ name: listTool, toolCallId: firstSource.tool_call_id,
      providerCallId: 'spawn-one', toolModelResultId: firstResult.id });
    assert.equal(replay.output, frozenOutputs[0].output, 'replay bytes cannot change after later child allocations');
    assert.equal((await rows(app, 'ContextSegmentSource', { source_kind: 'tool_model_result' })).length, 4,
      'replaying a frozen output never duplicates a Context occurrence');
    assert.equal((await rows(app, 'ToolCallEvent', { event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT })).length, 4);
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('native fork_conversation freezes the fork reference before a preflighted send in the same Turn', { timeout: 30000 }, async () => {
  const { ReliableToolDispatcher } = load('backend/reliableKernel/toolDispatcher.js');
  const { CollaborationToolDispatcher } = load('backend/reliableKernel/collaborationToolDispatcher.js');
  const { ReliableConversationLifecycle } = load('backend/application/reliableKernel/conversationLifecycle.js');
  const { crossConversationToolModules } = load('backend/world/modules/tools/definitions/crossConversation/index.js');
  const definitions = crossConversationToolModules.map(module => module.create({}));
  const NOTE = 'NATIVE_FORK_NOTE_4501';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-fork-dispatch-'));
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  let app, collaborationTools, round = 0, forkOutput, sendOutput;
  const dispatched = [];
  const adapter = {
    providerId: 'native-provider',
    async materializeNativeToolOutput(values) { return values; },
    async sendFullRequest(request, controls) {
      assert.ok(controls.native, 'this must exercise nativeResponses execution');
      round += 1;
      let sequence = 0;
      const event = (kind, content) => controls.onEvent({ kind, streamSeq: String(++sequence), content });
      const control = content => event('native_control', content);
      if (round === 1) {
        await control({ type: 'response.created', responseId: 'response-history', capabilities });
        await control({ type: 'response.completed', responseId: 'response-history' });
        await event('completed', { role: 'model', parts: [{ text: 'NATIVE_FIRST_ANSWER_4502' }] });
        return;
      }
      const call = (id, ordinal, name, args, responseId) => event('output_item_done', {
        type: 'tool_calls', calls: [{ id, ordinal, name, arguments: args, async: false }],
        outputItem: { id: `item-${id}`, ordinal, providerResponseId: responseId }
      });
      let finish;
      const done = new Promise(resolve => { finish = resolve; });
      controls.native.onController({
        endLogicalRequest() { finish(); },
        async steer() { assert.fail('fork results are not user steering'); },
        async submitToolResults() { assert.fail('a settled fork or send batch must checkpoint before the next request'); }
      });
      if (round === 3) {
        const frozen = await frozenNativeOutput(app, 'fork-self');
        assert.doesNotMatch(frozen.output, /conversationId|native-fork-dispatch-parent/);
        forkOutput = JSON.parse(frozen.output);
        assert.equal(forkOutput.status, 'succeeded', JSON.stringify(forkOutput));
        assert.match(forkOutput.detail.conversationRef, /^C\d+$/);
        assert.notEqual(forkOutput.detail.conversationRef, forkOutput.detail.sourceConversationRef);
        assert.ok(request.recipe.modelHandleCatalog.entries.some(entry =>
          entry.ref === forkOutput.detail.conversationRef), 'successor recipe freezes the new fork reference');
        assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 0);
        await control({ type: 'response.created', responseId: 'response-send', capabilities });
        await call('send-to-fork', 0, 'send_conversation_message',
          { conversationRef: forkOutput.detail.conversationRef, text: NOTE, mode: 'message' }, 'response-send');
        await control({ type: 'response.completed', responseId: 'response-send' });
      } else if (round === 4) {
        const frozen = await frozenNativeOutput(app, 'send-to-fork');
        assert.doesNotMatch(frozen.output, /conversationId|native-fork-dispatch-parent/);
        sendOutput = JSON.parse(frozen.output);
        assert.ok(request.recipe.modelHandleCatalog.entries.some(entry =>
          entry.ref === forkOutput.detail.conversationRef), 'fork identity persists across the second checkpoint');
        assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 0);
        await control({ type: 'response.created', responseId: 'response-final', capabilities });
        await control({ type: 'response.completed', responseId: 'response-final' });
        await event('completed', { role: 'model', parts: [{ text: 'forked and informed' }] });
      } else {
        assert.equal(round, 2);
        await control({ type: 'response.created', responseId: 'response-fork', capabilities });
        await call('fork-self', 0, 'fork_conversation', {}, 'response-fork');
        await control({ type: 'response.completed', responseId: 'response-fork' });
      }
      if (round < 4) {
        await done;
        await event('completed', { role: 'model', parts: round === 2
          ? [{ id: 'fork-self', functionCall: { name: 'fork_conversation', args: {} } }]
          : [{ id: 'send-to-fork', functionCall: { name: 'send_conversation_message',
            args: { conversationRef: forkOutput.detail.conversationRef, text: NOTE, mode: 'message' } } }] });
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
        // run_agent is frozen too: send, create and fork need it in the same list.
        toolPolicy: { id: 'tools', allowedTools: [...definitions.map(tool => tool.declaration.name), 'run_agent'], preset: 'custom',
          toolConfigs: { run_agent: { config: { crossConversationCollaboration: true } } }, sourceConfigs: {} },
        planReviewPolicy: { mode: 'never' }, systemPrompt: { id: 'prompt', text: '' },
        runtimeContext: { id: null, name: '', template: '' },
        workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
      }) }
    }; } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('unused'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
    providers: { resolve() { return adapter; } },
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) => new ReliableToolDispatcher({
      database, contentStore, effects: runtime.effects, files, fileMutations, processes, mcp, interactions,
      host: {
        definitions: () => definitions,
        async dispatchSpecial(_definition, input, authority, signal) {
          dispatched.push(input.toolName);
          return collaborationTools.dispatch(input, signal, authority);
        }
      }
    })
  };
  const drive = async (key, content) => {
    const started = await app.turns.input({ source: { kind: 'command', key }, conversationId: 'native-fork-dispatch-parent', leaseOwnerId: 'fixture',
      hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), content });
    const [lease] = await rows(app, 'ExecutionLease', { turn_id: started.turnId });
    const fence = { id: lease.id, conversationId: lease.conversation_id, turnId: lease.turn_id,
      ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation) };
    const result = await kernel.runWithExecutionLeaseFence(fence, () => app.agentLoop.drive(started.turnId));
    if (result.terminalStatus !== 'completed') assert.fail(JSON.stringify(await rows(app, 'TurnTermination', { turn_id: started.turnId })));
    return { ...started, result };
  };
  try {
    app = await kernel.ReliableKernelApplication.open(root, dependencies);
    // The Conversation-layer settings store as the fork lifecycle uses it: a copy before the
    // branch commits and a cleanup after a permanent rejection.
    const settings = [];
    const lifecycle = new ReliableConversationLifecycle({ application: app, configuration: { mutations: {
      async copyConversationConfiguration(source, target) { settings.push(['copy', source, target]); },
      async clearConversationConfiguration(target) { settings.push(['clear', target]); }
    } } });
    collaborationTools = new CollaborationToolDispatcher({ database: app.database, contentStore: app.contentStore,
      effects: app.runtime.effects, collaboration: app.runtime.collaboration, conversations: lifecycle });
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'native-fork-dispatch-parent', title: 'parent', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'native-fork-agent-link', conversation_id: 'native-fork-dispatch-parent', agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now })
    ]);
    await drive('native-fork-history', 'NATIVE_FIRST_QUESTION_4503');
    const second = await drive('native-fork-current', 'NATIVE_CURRENT_QUESTION_4504');
    assert.equal(second.result.modelRequestIds.length, 3,
      'fork and send each yield a complete safe tool batch, preserving the same user Turn');
    assert.deepEqual(dispatched, ['fork_conversation', 'send_conversation_message'], 'both calls ran through the production dispatcher');
    assert.equal(sendOutput.status, 'succeeded', JSON.stringify(sendOutput));
    const [forkSource] = await rows(app, 'ToolCallSourceLink', { provider_call_id: 'fork-self' });
    const forkId = kernel.stablePhaseFId('conversation', `conversation-fork:${forkSource.tool_call_id}`);
    const [branch] = await rows(app, 'ConversationBranchLink', { target_conversation_id: forkId });
    assert.equal(branch.source_conversation_id, 'native-fork-dispatch-parent');
    assert.deepEqual(settings, [['copy', 'native-fork-dispatch-parent', forkId]], 'the native fork copies the conversation settings once');
    assert.deepEqual(await rows(app, 'Turn', { conversation_id: forkId, status: 'active' }), [], 'the fork starts no Turn');
    const transcript = (await app.runtime.collaboration.readConversation({ conversationId: forkId, targetConversationId: forkId, limit: 50 })).messages.map(message => message.text);
    assert.ok(transcript.includes('NATIVE_FIRST_QUESTION_4503'), JSON.stringify(transcript));
    assert.ok(!transcript.includes('NATIVE_CURRENT_QUESTION_4504'), 'the running native Turn is never copied');
    // The frozen reference resolved to the fork, not to the caller.
    const [sendSource] = await rows(app, 'ToolCallSourceLink', { provider_call_id: 'send-to-fork' });
    const [sendCall] = await rows(app, 'ToolCall', { id: sendSource.tool_call_id });
    const [argsMetadata] = await rows(app, 'ContentObject', { id: sendCall.arguments_object_id });
    assert.equal(JSON.parse((await app.contentStore.read(argsMetadata)).toString('utf8')).targetConversationId, forkId);
    const [target] = await rows(app, 'CollaborationMessageTargetLink', { conversation_id: forkId });
    assert.ok(target, 'the note was addressed to the fork');
    const refs = await readNativeRequestChildHandles(app.database, app.contentStore, second.result.modelRequestIds[0]);
    assert.ok(refs.some(entry => entry.ref === forkOutput.detail.conversationRef && entry.target === forkId), JSON.stringify(refs));
    assert.ok((await rows(app, 'ToolCallEvent', { event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT })).length >= 2,
      'references freeze into CAS before both native checkpoints');
    assert.equal((await rows(app, 'ContextSegmentSource', { source_kind: 'tool_model_result' })).length, 2);
    assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 0);
    assert.deepEqual(dispatched, ['fork_conversation', 'send_conversation_message'], 'no external effect is replayed');
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
