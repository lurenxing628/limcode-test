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

for (const [listTool, sendTool, resultKind] of [['list_agents', 'send_agent_message', 'agent_collaboration'],
  ['list_conversations', 'send_conversation_message', 'cross_conversation']]) test(`native ${sendTool} references freeze before output and survive same-request send, restart and replay`, { timeout: 30000 }, async () => {
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
        type: 'tool_calls', calls: [{ id, ordinal, name: args.operation === 'spawn' ? listTool : sendTool, arguments: args.operation === 'spawn' ? {} : args, async: false }],
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
            assert.doesNotMatch(JSON.stringify(decoded), /conversationId|childExecutionId|modelRequestId|childHandles/);
            if (submitted.length === 2) {
              assert.deepEqual(decoded.map(item => item.detail.conversationRef), ['C1', 'C2']);
              await control({ type: 'response.created', responseId: 'response-followup', previousResponseId: 'response-spawn',
                admittedToolResultCallIds: batch.map(item => item.callId) });
              const mode = sendTool === 'send_conversation_message' ? { mode: 'followup' } : {};
              await call('send', 0, { conversationRef: 'C1', text: 'follow up original peer', ...mode }, 'response-followup');
              await call('unknown', 1, { conversationRef: 'C999', text: 'must not run', ...mode }, 'response-followup');
              await control({ type: 'response.completed', responseId: 'response-followup' });
            } else {
              assert.equal(submitted.length, 4);
              assert.equal(decoded[0].detail.conversationRef, 'C1');
              assert.equal(decoded[1].status, 'failed');
              assert.match(decoded[1].detail.error, /C999/);
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
    assert.equal(result.modelRequestIds.length, 1, 'spawn and send share one actual native logical request');
    assert.equal(executed.length, 3, 'unknown short reference never dispatches or spawns');
    assert.deepEqual(capturedRequest.recipe.modelHandleCatalog?.entries ?? [], [], 'initial recipe remains frozen');
    const frozenRefs = await readConversationChildHandles(app.database, app.contentStore, 'parent');
    assert.deepEqual(frozenRefs.map(entry => [entry.ref, entry.target]), [['C1', 'conversation_one'], ['C2', 'conversation_two']]);
    const eventRows = await rows(app, 'ToolCallEvent', { event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT });
    assert.equal(eventRows.length, 4);
    const checkpointRows = await rows(app, 'ModelStreamCheckpoint', { model_request_id: capturedRequest.modelRequestId });
    // Admission events retain source proofs after stream checkpoint pruning; the raw model history
    // and resolved ToolCall facts must still disagree exactly where short refs were translated.
    const [sendSource] = await rows(app, 'ToolCallSourceLink', { provider_call_id: 'send' });
    const [sendCall] = await rows(app, 'ToolCall', { id: sendSource.tool_call_id });
    const [argsMetadata] = await rows(app, 'ContentObject', { id: sendCall.arguments_object_id });
    const sendArgs = JSON.parse((await app.contentStore.read(argsMetadata)).toString('utf8'));
    assert.equal(sendArgs.targetConversationId, 'conversation_one');
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
    assert.equal(replay.output, outputs[0].output, 'replay bytes cannot change after later child allocations');
    assert.equal((await rows(app, 'ToolCallEvent', { event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT })).length, 4);
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('native fork_conversation runs through the dispatcher and its frozen reference addresses the fork in the same request', { timeout: 30000 }, async () => {
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
      let finish, fail;
      const done = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      controls.native.onController({
        endLogicalRequest() {}, async steer() {},
        async submitToolResults(batch) {
          try {
            const [output] = batch.map(item => JSON.parse(item.output));
            assert.doesNotMatch(JSON.stringify(output), /conversationId|native-fork-dispatch-parent/);
            if (!forkOutput) {
              forkOutput = output;
              assert.equal(output.status, 'succeeded', JSON.stringify(output));
              assert.match(output.detail.conversationRef, /^C\d+$/);
              assert.notEqual(output.detail.conversationRef, output.detail.sourceConversationRef);
              await control({ type: 'response.created', responseId: 'response-send', previousResponseId: 'response-fork', admittedToolResultCallIds: batch.map(item => item.callId) });
              await call('send-to-fork', 0, 'send_conversation_message', { conversationRef: output.detail.conversationRef, text: NOTE, mode: 'message' }, 'response-send');
              await control({ type: 'response.completed', responseId: 'response-send' });
            } else {
              sendOutput = output;
              await control({ type: 'response.created', responseId: 'response-final', previousResponseId: 'response-send', admittedToolResultCallIds: batch.map(item => item.callId) });
              await control({ type: 'response.completed', responseId: 'response-final' });
              await event('completed', { role: 'model', parts: [{ text: 'forked and informed' }] });
              finish();
            }
          } catch (error) { fail(error); throw error; }
        }
      });
      await control({ type: 'response.created', responseId: 'response-fork', capabilities });
      await call('fork-self', 0, 'fork_conversation', {}, 'response-fork');
      await control({ type: 'response.completed', responseId: 'response-fork' });
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
        toolPolicy: { id: 'tools', allowedTools: definitions.map(tool => tool.declaration.name), preset: 'custom',
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
    const lifecycle = new ReliableConversationLifecycle({ application: app, configuration: { mutations: { async copyConversationConfiguration() {} } } });
    collaborationTools = new CollaborationToolDispatcher({ database: app.database, contentStore: app.contentStore,
      effects: app.runtime.effects, collaboration: app.runtime.collaboration, conversations: lifecycle });
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'native-fork-dispatch-parent', title: 'parent', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'native-fork-agent-link', conversation_id: 'native-fork-dispatch-parent', agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now })
    ]);
    await drive('native-fork-history', 'NATIVE_FIRST_QUESTION_4503');
    const second = await drive('native-fork-current', 'NATIVE_CURRENT_QUESTION_4504');
    assert.equal(second.result.modelRequestIds.length, 1, 'fork and send share one native logical request');
    assert.deepEqual(dispatched, ['fork_conversation', 'send_conversation_message'], 'both calls ran through the production dispatcher');
    assert.equal(sendOutput.status, 'succeeded', JSON.stringify(sendOutput));
    const [forkSource] = await rows(app, 'ToolCallSourceLink', { provider_call_id: 'fork-self' });
    const forkId = kernel.stablePhaseFId('conversation', `conversation-fork:${forkSource.tool_call_id}`);
    const [branch] = await rows(app, 'ConversationBranchLink', { target_conversation_id: forkId });
    assert.equal(branch.source_conversation_id, 'native-fork-dispatch-parent');
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
    assert.ok((await rows(app, 'ToolCallEvent', { event_kind: NATIVE_CHILD_HANDLE_PROJECTION_EVENT })).length >= 2, 'references freeze before each native output');
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
