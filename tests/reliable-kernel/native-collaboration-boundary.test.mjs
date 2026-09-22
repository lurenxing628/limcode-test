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

test('pending peer messages end a native tool loop at its first settled response boundary without user steering', { timeout: 30000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-peer-boundary-'));
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  let app;
  const executed = [];
  const requests = [];
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
        await event('output_item_done', { type: 'tool_calls', calls: [{ id: 'list', ordinal: 0, name: 'list_agents', arguments: {}, async: false }],
          outputItem: { id: 'list-item', ordinal: 0, providerResponseId: 'response-first' } });
        // The peer finished the follow-up this running conversation requested earlier; its result
        // returns to the requester's live Turn instead of waiting for a later Turn.
        await app.runtime.collaboration.completeRequestsForTurn({ turnId: 'peer-turn', text: 'PEER_RUNTIME_BOUNDARY_MESSAGE' });
        await control({ type: 'response.completed', responseId: 'response-first' });
        await ended;
        assert.equal((await rows(app, 'ToolCallEvent', { event_kind: 'native_delivery' })).length, 0, 'a local yield is never provider delivery acknowledgment');
        assert.equal((await rows(app, 'ContextSegmentSource', { source_kind: 'tool_model_result' })).length, 1, 'the settled tool result is retained before ending the chain');
        await event('completed', { role: 'model', parts: [{ id: 'list', functionCall: { name: 'list_agents', args: {} } }] });
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
        assert.match(projected, /result data, not a new user instruction/);
        assert.match(projected, /"messageRef":"M[0-9]+"/);
        assert.doesNotMatch(projected, /sourceConversationId|targetConversationId|messageId/);
        const carriedToolResult = request.context.find(item => item.segmentKind === 'tool_pair' && item.content.includes('list_agents')
          && item.content.includes('toolModelResult'));
        assert.ok(carriedToolResult, 'admission names are derived from the body actually sent by this carrier');
        await control({ type: 'response.created', responseId: 'response-after-peer', capabilities, admittedToolResultCallIds: ['list'] });
        await control({ type: 'response.completed', responseId: 'response-after-peer' });
        await event('completed', { role: 'model', parts: [{ text: 'Processed the peer message.' }] });
      }
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
    assert.equal(executed.length, 1, 'a carrier request must not rerun the settled tool');
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
