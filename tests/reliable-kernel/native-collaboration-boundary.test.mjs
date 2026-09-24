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
const { parseNativeToolCallCheckpoint, parseNativeDeliveryContent } = load('backend/reliableKernel/nativeToolFacts.js');

const capabilities = { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false, explicitCaching: true };
const definition = name => ({ name, description: 'native collaboration handle fixture', parameters: { type: 'object' } });
const rows = async (app, domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain)
  .list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;

test('pending peer messages end a native tool loop at its first settled response boundary without user steering', { timeout: 30000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-peer-boundary-'));
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  let app;
  const executed = [];
  const requests = [];
  const transients = [];
  let chainEnds = 0;
  let wireSubmissions = 0;
  const adapter = {
    providerId: 'native-provider',
    async materializeNativeToolOutput(values) { return values; },
    async sendFullRequest(request, controls) {
      requests.push(request);
      let sequence = 0;
      const event = (kind, content) => controls.onEvent({ kind, streamSeq: String(++sequence), content });
      const control = content => event('native_control', content);
      if (requests.length === 1) {
        let end;
        const ended = new Promise(resolve => { end = resolve; });
        controls.native.onController({
          endLogicalRequest() { chainEnds += 1; end(); },
          async steer() { assert.fail('Peer messages must not use the user-steering API'); },
          async submitToolResults() { wireSubmissions += 1; assert.fail('Peer input must cross the first settled tool boundary before another native response'); }
        });
        await control({ type: 'response.created', responseId: 'response-first', capabilities });
        await event('output_item_done', { type: 'tool_calls', calls: [{ id: 'list-a', ordinal: 0, name: 'list_agents', arguments: {}, async: false }],
          outputItem: { id: 'list-item-a', ordinal: 0, providerResponseId: 'response-first' } });
        await event('output_item_done', { type: 'tool_calls', calls: [{ id: 'list-b', ordinal: 1, name: 'list_agents', arguments: {}, async: false }],
          outputItem: { id: 'list-item-b', ordinal: 1, providerResponseId: 'response-first' } });
        // The peer finished the follow-up this running conversation requested earlier; its result
        // returns to the requester's live Turn instead of waiting for a later Turn.
        await app.runtime.collaboration.completeRequestsForTurn({ turnId: 'peer-turn', text: 'PEER_RUNTIME_BOUNDARY_MESSAGE' });
        await control({ type: 'response.completed', responseId: 'response-first' });
        await ended;
        assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 0, 'a local yield is never provider delivery acknowledgment');
        assert.equal((await rows(app, 'ContextSegmentSource', { source_kind: 'tool_model_result' })).length, 2, 'both settled tool results are retained before ending the chain');
        await event('completed', { role: 'model', parts: [
          { id: 'list-a', functionCall: { name: 'list_agents', args: {} } },
          { id: 'list-b', functionCall: { name: 'list_agents', args: {} } }
        ] });
        controls.native.onController(undefined);
      } else {
        assert.equal(requests.length, 2);
        const peer = request.context.find(item => item.segmentKind === 'runtime_context');
        assert.ok(peer, 'the next request must contain the durable peer envelope');
        const envelope = JSON.parse(peer.content);
        assert.equal(envelope.kind, 'collaboration_message');
        assert.equal(envelope.content, 'PEER_RUNTIME_BOUNDARY_MESSAGE');
        assert.equal(envelope.sourceConversationId, 'peer');
        assert.equal(envelope.sourceKind, 'completion');
        assert.match(envelope.note, /not a new user instruction/i);
        const projected = load('backend/reliableKernel/runtimeDeliveryProjection.js').renderRuntimeDeliveryModelEnvelope(
          envelope, undefined, request.recipe.modelHandleCatalog);
        assert.equal(envelope.delivery, 'completion_reply');
        assert.match(projected, /^\[Collaboration reply from another conversation, not from this conversation's user\. /);
        assert.match(projected, /"messageRef":"M[0-9]+"/);
        assert.match(projected, /"replyToMessageRef":"M[0-9]+"/);
        assert.doesNotMatch(projected, /sourceConversationId|targetConversationId|messageId/);
        const carriedToolResult = request.context.find(item => item.segmentKind === 'tool_pair' && item.content.includes('list_agents')
          && item.content.includes('toolModelResult'));
        assert.ok(carriedToolResult, 'admission names are derived from the body actually sent by this carrier');
        await control({ type: 'response.created', responseId: 'response-unadmitted', capabilities });
        assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 0,
          'a response.created without explicit call IDs cannot prove either historical result');
        await control({ type: 'response.completed', responseId: 'response-unadmitted' });
        await control({ type: 'response.created', responseId: 'response-admit-a', admittedToolResultCallIds: ['list-a'] });
        assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 1,
          'only the first named historical result is marked at its durable response.created');
        await control({ type: 'response.completed', responseId: 'response-admit-a' });
        await control({ type: 'response.created', responseId: 'response-admit-b', admittedToolResultCallIds: ['list-b'] });
        assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 2,
          'the second historical result requires its own response.created admission');
        // Terminal checkpoint pruning keeps only the last 32 stream rows. Both admissions must
        // already be durable delivery facts before this long response removes their checkpoints.
        for (let ordinal = 0; ordinal < 40; ordinal += 1) {
          await event('output_item_done', { type: 'output_item_done',
            outputItem: { id: `empty-item-${ordinal}`, ordinal, providerResponseId: 'response-admit-b' } });
        }
        await control({ type: 'response.completed', responseId: 'response-admit-b' });
        await event('completed', { role: 'model', parts: [{ text: 'Processed the peer message.' }] });
      }
    }
  };
  const dependencies = {
    transientObserver: { observe(event) { transients.push(event); } },
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
        toolPolicy: { id: 'tools', allowedTools: ['list_agents', 'send_agent_message'], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
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
      definitions() { return [definition('list_agents'), definition('send_agent_message')]; },
      async dispatch() { throw new Error('native test must use scheduleAdmittedCall'); },
      async scheduleAdmittedCall(input) {
        executed.push(input.arguments);
        if (input.toolName === 'send_agent_message') assert.equal(input.arguments.targetConversationId, 'conversation_one');
        const target = input.toolName === 'list_agents' ? `conversation_${executed.length === 1 ? 'one' : 'two'}` : input.arguments.targetConversationId;
        const result = await app.runtime.effects.settleWithoutEffect({
          source: { kind: 'internal', key: `fixture:${input.toolCallId}` }, toolCallId: input.toolCallId,
          status: 'succeeded', detail: { kind: 'agent_collaboration', ok: true, status: 'running', conversationId: target }
        });
        return result.terminal;
      }
    }
  };
  try {
    app = await kernel.ReliableKernelApplication.open(root, dependencies);
    const now = new Date().toISOString();
    const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
    // A durable follow-up request from parent to peer, already bound to the peer Turn that finished it.
    const requestPayload = await app.contentStore.ingest(app.database, 'Please review the change.', 'text/vnd.limcode.collaboration-message');
    await app.database.transaction([
      ...['parent', 'peer'].map(id => repo('Conversation').insert({ id, title: id, status: 'active', created_at: now, updated_at: now })),
      repo('AgentConversationLink').insert({ id: 'agent-link', conversation_id: 'parent', agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now }),
      repo('Turn').insert({ id: 'peer-turn', conversation_id: 'peer', status: 'terminated', created_at: now, updated_at: now, terminal_at: now }),
      repo('TurnTermination').insert({ id: 'peer-turn-done', turn_id: 'peer-turn', terminal_status: 'completed', reason: 'fixture', created_at: now }),
      repo('CollaborationMessage').insertWithNextSequence({ id: 'request-message', dedupe_key: 'request-message', mode: 'followup', created_at: now }, { column: 'message_seq', scope: {} }),
      repo('CollaborationMessageSourceLink').insert({ id: 'request-source', message_id: 'request-message', conversation_id: 'parent', source_kind: 'tool', source_key: 'request-call', turn_id: null, tool_call_id: null, board_post_id: null, created_at: now }),
      repo('RuntimeInboxItem').insert({ id: 'request-inbox', dedupe_key: 'request-message', source_kind: 'collaboration_message', source_id: 'request-message', state: 'routed', created_at: now, updated_at: now }),
      repo('CollaborationMessageTargetLink').insert({ id: 'request-target', message_id: 'request-message', conversation_id: 'peer', inbox_item_id: 'request-inbox', anchor_turn_id: null, created_at: now }),
      repo('CollaborationMessagePayloadLink').insert({ id: 'request-payload', message_id: 'request-message', content_object_id: requestPayload.id, created_at: now }),
      repo('CollaborationBudget').insert({ id: 'request-budget', origin_kind: 'turn', origin_key: 'parent-origin', authority_turn_id: 'parent-origin', created_at: now }),
      repo('CollaborationRequest').insert({ id: 'request', message_id: 'request-message', budget_id: 'request-budget', automatic: 1n, state: 'pending', created_at: now, updated_at: now }),
      repo('CollaborationRequestTurnLink').insert({ id: 'request-turn', request_id: 'request', turn_id: 'peer-turn', created_at: now })
    ]);
    const started = await app.turns.input({ source: { kind: 'command', key: 'start-native-peer-fixture' },
      conversationId: 'parent', leaseOwnerId: 'fixture', hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), content: 'Work while accepting team messages' });
    const [lease] = await rows(app, 'ExecutionLease', { turn_id: started.turnId });
    const fence = { id: lease.id, conversationId: lease.conversation_id, turnId: lease.turn_id,
      ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation) };
    const result = await kernel.runWithExecutionLeaseFence(fence, () => app.agentLoop.drive(started.turnId));
    assert.equal(result.terminalStatus, 'completed', JSON.stringify(await rows(app, 'TurnTermination', { turn_id: started.turnId })));
    assert.equal(result.modelRequestIds.length, 2);
    assert.equal(chainEnds, 1);
    assert.equal(wireSubmissions, 0);
    assert.equal(executed.length, 2, 'a carrier request must not rerun either settled tool');
    for (const request of requests) {
      const visible = transients.filter(event => event.modelRequestId === request.modelRequestId);
      assert.ok(visible.length > 0);
      let nextSequence = 1n;
      for (const event of visible) {
        assert.equal(BigInt(event.fromStreamSeq), nextSequence,
          'only observed native controls are covered between visible events');
        nextSequence = BigInt(event.event.streamSeq) + 1n;
      }
    }
    const carrierVisible = transients.filter(event => event.modelRequestId === requests[1].modelRequestId);
    assert.deepEqual([carrierVisible[0].fromStreamSeq, carrierVisible[0].event.streamSeq], ['1', '6'],
      'the first visible item covers the five preceding native controls');
    assert.deepEqual([carrierVisible.at(-1).fromStreamSeq, carrierVisible.at(-1).event.streamSeq], ['46', '47'],
      'the final visible event covers only its observed response boundary');
    const delivered = await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' });
    assert.equal(delivered.length, 2);
    for (const [providerCallId, expectedResponseId] of [
      ['list-a', 'response-admit-a'], ['list-b', 'response-admit-b']
    ]) {
      const [source] = await rows(app, 'ToolCallSourceLink', { provider_call_id: providerCallId });
      const [delivery] = delivered.filter(row => row.tool_call_id === source.tool_call_id);
      assert.ok(delivery, `${providerCallId} retains its own delivery fact after pruning`);
      const [metadata] = await rows(app, 'ContentObject', { id: delivery.content_object_id });
      const content = JSON.parse((await app.contentStore.read(metadata)).toString('utf8'));
      assert.equal(parseNativeDeliveryContent(content).providerResponseId, expectedResponseId);
    }
    const carrierCheckpoints = await rows(app, 'ModelStreamCheckpoint', { model_request_id: requests[1].modelRequestId });
    assert.equal(carrierCheckpoints.length, 33, 'terminal pruning keeps only the bounded checkpoint tail');
    assert.ok(carrierCheckpoints.every(row => Number(row.stream_seq) > 5),
      'both response.created admission checkpoints were pruned after their delivery facts committed');
    const inputs = await rows(app, 'PendingTurnInput', { turn_id: started.turnId, input_kind: 'runtime_delivery' });
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].state, 'consumed');
    const [deliveryInput] = await rows(app, 'RuntimeDeliveryInputLink', { pending_turn_input_id: inputs[0].id });
    assert.ok(deliveryInput.handled_at, 'handling has its own committed timestamp');
    assert.equal((await rows(app, 'PendingTurnInput', { input_kind: 'native_steering' })).length, 0);
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
