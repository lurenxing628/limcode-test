import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const compiledRoot = process.env.LIMCODE_COMPILED_ROOT
  ? path.resolve(root, process.env.LIMCODE_COMPILED_ROOT)
  : path.join(root, 'dist/extension');
const kernel = await import(pathToFileURL(
  path.join(compiledRoot, 'backend/reliableKernel/index.js')
).href);

const ASTRA_MODEL = 'gpt-6-astra';
const PROVIDER_ID = 'provider-native';

/**
 * Native (Astra) orchestration regression scenarios against the real kernel. The scripted seams
 * are the provider adapter (transport envelopes + process-local controller) and the tool
 * dispatcher; every durable fact comes from the real SQLite/CAS control planes.
 */

function nativeAuthorityDocument(overrides = {}) {
  return {
    kind: 'effective-turn-authority',
    ...overrides,
    model: {
      providerConfigId: PROVIDER_ID,
      provider: 'openai-responses',
      modelId: ASTRA_MODEL,
      baseUrl: 'https://api.openai.com',
      openaiResponsesTransport: 'websocket',
      nativeResponses: { enabled: true },
      thinkingConfig: { thinkingLevel: 'high', reasoningMode: 'standard' },
      retryPolicy: { enabled: false, maxRetries: 0 }
    },
    modelProfile: {
      compressionThresholdTokens: 100000,
      contextWindowTokens: 128000,
      tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
    },
    toolPolicy: { id: 'tools-default', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
    systemPrompt: { id: 'prompt-default', text: '' },
    runtimeContext: { id: null, name: '', template: '' },
    workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
  };
}

function dependencies(nativeTools, dispatcher, adapter) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: {
            content: JSON.stringify({ providerConfigId: PROVIDER_ID, modelId: ASTRA_MODEL })
          },
          authoritySnapshot: {
            content: JSON.stringify(nativeAuthorityDocument({
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId
            }))
          }
        };
      }
    },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: {
      async toolAnnotations() { return {}; },
      async callTool() { return null; }
    },
    mcpPolicyGate: {
      async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; }
    },
    attachmentSettings: {
      async loadGlobalSettings() {
        return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' };
      }
    },
    providers: {
      resolve(providerId) {
        assert.equal(providerId, PROVIDER_ID);
        return adapter;
      }
    },
    toolDispatcher: dispatcher
  };
}

/** Records dispatches and settles them through the real effect plane; app binds lazily after open. */
function recordingDispatcher(nativeTools, shared) {
  const settlementListeners = new Set();
  const bound = { app: undefined };
  const definitions = nativeTools.map((tool) => ({
    name: tool.name,
    description: `${tool.name} fixture`,
    parameters: {},
    ...(tool.nativeAsync ? { metadata: { nativeAsync: true } } : {})
  }));
  const settle = async (input) => {
    shared?.dispatchedInputs.push(input);
    const result = await bound.app.effects.settleWithoutEffect({
      source: { kind: 'internal', key: `fixture-dispatch:${input.toolCallId}` },
      toolCallId: input.toolCallId,
      status: 'succeeded',
      detail: { ok: true, toolCallId: input.toolCallId }
    });
    for (const listener of settlementListeners) listener({ toolCallId: input.toolCallId });
    return result.terminal ?? { disposition: 'settled', toolCallId: input.toolCallId, status: 'succeeded' };
  };
  return {
    bind(app) { bound.app = app; },
    definitions() { return definitions; },
    dispatch: settle,
    scheduleAdmittedCall: settle,
    subscribeToolSettlements({ turnId }, listener) {
      settlementListeners.add(listener);
      return () => settlementListeners.delete(listener);
    }
  };
}

function nativeAdapter(behavior) {
  const record = {
    steers: [],
    submissions: [],
    endLogicalRequestCalls: 0,
    dispatchedInputs: [],
    requests: []
  };
  let dispatchOrdinal = 0;
  const adapter = {
    providerId: PROVIDER_ID,
    async materializeNativeToolOutput(outputs) { return outputs; },
    async sendFullRequest(request, controls) {
      dispatchOrdinal += 1;
      record.requests.push(request);
      let streamSeq = 0;
      let end;
      const ended = new Promise(resolve => { end = resolve; });
      const emit = async (kind, content, extra = {}) => {
        streamSeq += 1;
        return controls.onEvent({ kind, streamSeq: String(streamSeq), content, ...extra });
      };
      const controller = {
        responseId: 'r1',
        connectionGeneration: 1,
        streamId: undefined,
        async steer(command) { record.steers.push(command); },
        async submitToolResults(outputs) {
          record.submissions.push(outputs);
          return { responseId: 'r-submit-1', previousResponseId: 'r1', connectionGeneration: 1 };
        },
        endLogicalRequest() { record.endLogicalRequestCalls += 1; end(); }
      };
      record.controller = controller;
      controls.native?.onController?.(controller);
      try {
        await behavior({ emit, ended, controls, request, record, controller, dispatchOrdinal });
      } finally {
        controls.native?.onController?.(undefined);
      }
    }
  };
  return { adapter, record };
}

async function waitFor(condition, label, spins = 400) {
  for (let spin = 0; spin < spins; spin += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(condition(), `timed out waiting for ${label}`);
}

async function withNativeApp(name, nativeTools, run, behavior) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const { adapter, record } = nativeAdapter(behavior);
  const dispatcher = recordingDispatcher(nativeTools, record);
  const app = await kernel.ReliableKernelApplication.open(
    authority,
    dependencies(nativeTools, dispatcher, adapter)
  );
  dispatcher.bind(app);
  try {
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: name, title: name, status: 'active', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: `${name}-agent-link`, conversation_id: name, agent_id: 'agent-main',
        role: 'default', created_at: now, updated_at: now
      })
    ]);
    const started = await app.turns.input({
      source: { kind: 'command', key: `${name}-input` },
      conversationId: name,
      leaseOwnerId: `${name}-owner`,
      hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      content: 'do native work'
    });
    const turnId = started.turnId;
    const lease = (await list(app, 'ExecutionLease', { turn_id: turnId }))[0];
    const fence = {
      id: lease.id,
      conversationId: lease.conversation_id,
      turnId: lease.turn_id,
      ownerId: lease.owner_id,
      hostBootId: lease.host_boot_id,
      generation: BigInt(lease.generation)
    };
    await run({ app, name, turnId, fence, record, dispatcher, adapter });
  } finally {
    await app.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
}

/** Actionable failure: assert the loop outcome together with the durable terminal reason. */
async function expectDriveTerminal(app, turnId, result, expected) {
  if (result.terminalStatus !== expected) {
    const terminations = await list(app, 'TurnTermination', { turn_id: turnId });
    const reason = terminations[0]?.reason ?? '(no TurnTermination)';
    assert.equal(
      result.terminalStatus,
      expected,
      `drive returned '${result.terminalStatus}', expected '${expected}'; terminal reason: ${reason}`
    );
  }
}

/**
 * Runs the loop and rethrows failures with the full nested cause chain (cause/originalError/
 * terminalError) so a combined 'could not record terminal state' shows both layers immediately.
 */
async function driveWithCauses(app, fence, turnId) {
  try {
    return await kernel.runWithExecutionLeaseFence(fence, () => app.agentLoop.drive(turnId));
  } catch (error) {
    const seen = new Set();
    const chain = [];
    const visit = (value, depth) => {
      if (!value || seen.has(value) || depth > 6) return;
      seen.add(value);
      chain.push(`${'  '.repeat(depth)}${value instanceof Error ? `${value.name}: ${value.message}` : String(value)}`);
      visit(value?.cause, depth + 1);
      visit(value?.originalError, depth + 1);
      visit(value?.terminalError, depth + 1);
    };
    visit(error, 0);
    const enriched = new Error(`drive threw; nested causes:\n${chain.join('\n')}`);
    enriched.cause = error;
    throw enriched;
  }
}

async function list(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 500
  }))).snapshot;
}

async function readCheckpointContents(app, modelRequestId, kind) {
  const rows = (await list(app, 'ModelStreamCheckpoint', { model_request_id: modelRequestId }))
    .filter((row) => row.checkpoint_kind === kind);
  const contents = [];
  for (const row of rows.sort((left, right) => (BigInt(left.stream_seq) < BigInt(right.stream_seq) ? -1 : 1))) {
    const metadata = (await app.database.snapshot([
      kernel.DOMAIN_REPOSITORIES.domain('ContentObject').get(row.content_object_id)
    ])).snapshot[0];
    contents.push(JSON.parse((await app.contentStore.read(metadata)).toString('utf8')));
  }
  return contents;
}

function textItemEnvelope(itemId, ordinal, responseId) {
  return {
    type: 'output_item_done',
    outputItem: { id: itemId, ordinal, providerResponseId: responseId }
  };
}

test('native async result checkpoints into a second ModelRequest of the same Turn without forging result admission', async () => {
  const name = 'native-async-early';
  await withNativeApp(name, [{ name: 'read_file', nativeAsync: true }], async ({ app, turnId, fence, record }) => {
    const result = await driveWithCauses(app, fence, turnId);
    await expectDriveTerminal(app, turnId, result, 'completed');
    assert.equal(record.dispatchedInputs.length, 1);
    assert.equal(record.dispatchedBeforeCompleted, true, 'tool dispatch preceded the terminal completed event');
    assert.equal(record.submissions.length, 0, 'safe full-request carryover does not submit a second physical result create');
    assert.equal(record.endLogicalRequestCalls, 1, 'exactly one settled tool batch ends its physical chain');

    const calls = await list(app, 'ToolCall', { turn_id: turnId });
    assert.equal(calls.length, 1);
    const toolCallId = calls[0].id;
    const events = await list(app, 'ToolCallEvent', { tool_call_id: toolCallId });
    assert.equal(events.filter((row) => row.event_kind === 'native_admission').length, 1,
      'exactly one durable native admission');
    assert.equal(events.filter((row) => row.event_kind === 'native_delivery').length, 0,
      'scripted next response.created did not attest any explicit native call result');

    const callOccurrences = await list(app, 'ContextSegmentSource', { source_kind: 'tool_call', source_id: toolCallId });
    assert.equal(callOccurrences.length, 1, 'one call context occurrence, never duplicated');
    const results = await list(app, 'ToolModelResult', { tool_call_id: toolCallId });
    assert.equal(results.length, 1);
    const resultOccurrences = await list(app, 'ContextSegmentSource', { source_kind: 'tool_model_result', source_id: results[0].id });
    assert.equal(resultOccurrences.length, 1, 'one settled result occurrence survives the batch checkpoint');
    assert.equal((await list(app, 'ToolModelResult', { tool_call_id: toolCallId })).length, 1,
      'the completed tool retains its CAS-backed result instead of being run again');

    // Canonical order: user input < prefix text < call < suffix text < result.
    const head = (await list(app, 'ConversationContextHeadLink', { conversation_id: name }))[0];
    const structure = await app.context.materializeStructure(head.root_id);
    const kinds = structure.records.map((record) => record.segment.segment_kind);
    const messageIndexes = kinds.flatMap((kind, index) => kind === 'message' ? [index] : []);
    const pairIndexes = kinds.flatMap((kind, index) => kind === 'tool_pair' ? [index] : []);
    assert.ok(messageIndexes.length >= 3, 'user input + prefix + suffix message segments exist');
    assert.equal(pairIndexes.length, 2, 'native call + result partial pairs');
    assert.ok(pairIndexes[0] > messageIndexes[1], 'call occurrence after the prefix segment');
    assert.ok(messageIndexes[2] > pairIndexes[0], 'suffix segment after the call occurrence');
    assert.ok(pairIndexes[1] > messageIndexes[2], 'result occurrence after the suffix segment');

    const modelRequests = await list(app, 'ModelRequest', { turn_id: turnId });
    assert.equal(modelRequests.length, 2, 'the settled batch continues inside the same Turn after one full preflight');
    assert.equal(record.requests.length, 2);
    const observed = await app.modelProvider.readNativeLatestResponseUsage(record.requests[0].modelRequestId);
    assert.equal(observed.inputTokens, undefined,
      'omitted physical usage stays unknown even when logical completed reports a bill');
    const requestLinks = (await list(app, 'ModelRequestMessageLink', {}))
      .filter((row) => row.model_request_id === record.requests[0].modelRequestId);
    assert.equal(requestLinks.length, 1);
    const revisions = (await list(app, 'MessageRevision', { message_id: requestLinks[0].message_id }))
      .sort((left, right) => Number(right.revision_seq - left.revision_seq));
    const aggregateMetadata = (await app.database.snapshot([
      kernel.DOMAIN_REPOSITORIES.domain('ContentObject').get(revisions[0].content_object_id)
    ])).snapshot[0];
    const aggregate = JSON.parse((await app.contentStore.read(aggregateMetadata)).toString('utf8'));
    assert.equal(aggregate.parts.length, 3, 'current aggregate revision = prefix + call + suffix');
  }, async ({ emit, ended, request, record, dispatchOrdinal }) => {
    if (dispatchOrdinal === 2) {
      assert.ok(request.context.some(segment => segment.segmentKind === 'tool_pair'
        && segment.content.includes('toolModelResult')),
        'the second ModelRequest carries the original CAS-backed result from this Turn');
      await emit('native_control', { type: 'response.created', responseId: 'r2' });
      await emit('native_control', { type: 'response.completed', responseId: 'r2',
        usage: { input_tokens: 70, output_tokens: 5, total_tokens: 75 } });
      await emit('completed', { role: 'model', parts: [{ text: 'result carried to final answer' }] });
      return;
    }
    assert.equal(dispatchOrdinal, 1);
    await emit('native_control', {
      type: 'response.created', responseId: 'r1',
      capabilities: { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: true, explicitCaching: true }
    });
    await emit('output_delta', { type: 'text_delta', text: 'prefix ', outputItem: { id: 'i1', ordinal: 0, providerResponseId: 'r1' } });
    await emit('output_item_done', textItemEnvelope('i1', 0, 'r1'));
    await emit('output_item_done', {
      type: 'tool_calls',
      outputItem: { id: 'i2', ordinal: 1, providerResponseId: 'r1' },
      calls: [{ id: 'call-1', ordinal: 0, name: 'read_file', arguments: { path: 'fixture.txt' }, async: true }]
    });
    await emit('output_delta', { type: 'text_delta', text: 'suffix', outputItem: { id: 'i3', ordinal: 2, providerResponseId: 'r1' } });
    await emit('output_item_done', textItemEnvelope('i3', 2, 'r1'));
    // Admission + execution land while the model is still "generating"; the boundary gate holds
    // the delivery submission until the response boundary is emitted below.
    await waitFor(() => record.dispatchedInputs.length === 1, 'mid-stream dispatch');
    record.dispatchedBeforeCompleted = record.dispatchedInputs.length === 1;
    await emit('native_control', { type: 'response.completed', responseId: 'r1' });
    await ended;
    assert.equal(record.submissions.length, 0,
      'unknown physical input never induces an unpreflighted result create');
    await emit('completed', {
      role: 'model',
      parts: [
        { text: 'prefix ', outputItem: { id: 'i1', ordinal: 0, providerResponseId: 'r1' } },
        { id: 'call-1', functionCall: { name: 'read_file', args: { path: 'fixture.txt' } }, async: true, outputItem: { id: 'i2', ordinal: 1, providerResponseId: 'r1' } },
        { text: 'suffix', outputItem: { id: 'i3', ordinal: 2, providerResponseId: 'r1' } }
      ]
    }, { usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150 } });
  });
});

test('steering persists its user Message but an unattested successor never applies it to Context', async () => {
  const name = 'native-steer-flow';
  let driveStartedResolve;
  const driveStarted = new Promise((resolve) => { driveStartedResolve = resolve; });
  await withNativeApp(name, [], async ({ app, turnId, fence, record }) => {
    const updates = [];
    const unsubscribe = app.modelProvider.subscribeSteering((update) => updates.push(update));
    const drivePromise = driveWithCauses(app, fence, turnId);
    driveStartedResolve();
    await waitFor(() => record.steers !== undefined && record.controller !== undefined, 'controller registration');
    // Stale lease epoch is rejected before any durable write.
    await assert.rejects(
      app.modelProvider.steer({
        commandId: 'cmd-stale', conversationId: name, turnId,
        leaseEpoch: fence.generation + 1n,
        content: { role: 'user', parts: [{ text: 'stale' }] }
      }),
      /lease epoch/
    );
    const receipt = await app.modelProvider.steer({
      commandId: 'cmd-1', conversationId: name, turnId,
      leaseEpoch: fence.generation,
      content: { role: 'user', parts: [{ text: 'steer note' }] }
    });
    assert.equal(receipt.submissionId, 'cmd-1');
    assert.equal(receipt.state, 'sent');
    assert.equal(receipt.targetResponseId, 'r1');
    assert.equal(record.steers.length, 1);
    assert.deepEqual(record.steers[0].input, [{ role: 'user', parts: [{ text: 'steer note' }] }]);
    const steerLinks = (await list(app, 'MessageTurnLink', { turn_id: turnId }))
      .filter((row) => row.role === 'native_steer');
    assert.equal(steerLinks.length, 1, 'visible steer user message linked as native_steer');
    const pendingInputs = await list(app, 'PendingTurnInput', { turn_id: turnId, input_kind: 'native_steer' });
    assert.equal(pendingInputs.length, 1);
    assert.equal(pendingInputs[0].state, 'sent');
    const result = await drivePromise;
    unsubscribe();
    await expectDriveTerminal(app, turnId, result, 'completed');
    const receipts = await app.modelProvider.steeringReceipts(name);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].state, 'delivery_unknown');
    assert.equal(receipts[0].successorResponseId, undefined);
    assert.equal(typeof receipts[0].updatedAt, 'number');
    const steerMessageRevision = (await list(app, 'MessageRevision', { message_id: steerLinks[0].message_id }))[0];
    const [body] = await list(app, 'ContentObject', { id: steerMessageRevision.content_object_id });
    assert.match((await app.contentStore.read(body)).toString('utf8'), /steer note/);
    const occurrences = await list(app, 'ContextSegmentSource', { source_kind: 'message_revision', source_id: steerMessageRevision.id });
    assert.equal(occurrences.length, 0, 'without an attributed steer the persisted user message is not Context');
    assert.ok(updates.length >= 3, 'sent, accepted and delivery-unknown broadcasts observed');
    assert.equal(record.steers.length, 1, 'unknown delivery must not silently resubmit');
    assert.equal(updates[0].conversationId, name);
    assert.equal(updates[0].receipts[0].submissionId, 'cmd-1');
  }, async ({ emit, record }) => {
    await driveStarted;
    await emit('native_control', {
      type: 'response.created', responseId: 'r1',
      capabilities: { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: true, explicitCaching: true }
    });
    await emit('output_delta', { type: 'text_delta', text: 'before steer ', outputItem: { id: 'i1', ordinal: 0, providerResponseId: 'r1' } });
    await emit('output_item_done', textItemEnvelope('i1', 0, 'r1'));
    await waitFor(() => record.steers.length === 1, 'steer submission');
    await emit('native_control', { type: 'response.steer.accepted', responseId: 'r1', submissionId: 'cmd-1', steerId: 'steer-1' });
    await emit('output_delta', { type: 'text_delta', text: 'pre-successor ', outputItem: { id: 'i2', ordinal: 1, providerResponseId: 'r1' } });
    await emit('output_item_done', textItemEnvelope('i2', 1, 'r1'));
    await emit('native_control', { type: 'response.incomplete', responseId: 'r1', reason: 'steered',
      usage: { input_tokens: 55, output_tokens: 5, total_tokens: 60 } });
    await emit('native_control', { type: 'response.steer.disconnected', responseId: 'r1',
      submissionId: 'cmd-1', reason: 'successor_application_unverified' });
    await emit('native_control', { type: 'response.created', responseId: 'r2', previousResponseId: 'r1' });
    await emit('output_delta', { type: 'text_delta', text: 'after steer', outputItem: { id: 'i3', ordinal: 2, providerResponseId: 'r2' } });
    await emit('output_item_done', textItemEnvelope('i3', 2, 'r2'));
    await emit('native_control', { type: 'response.completed', responseId: 'r2' });
    await emit('completed', {
      role: 'model',
      parts: [
        { text: 'before steer ', outputItem: { id: 'i1', ordinal: 0, providerResponseId: 'r1' } },
        { text: 'pre-successor ', outputItem: { id: 'i2', ordinal: 1, providerResponseId: 'r1' } },
        { text: 'after steer', outputItem: { id: 'i3', ordinal: 2, providerResponseId: 'r2' } }
      ]
    }, { usage: { input_tokens: 90, output_tokens: 20, total_tokens: 110 } });
  });
});

test('synchronous tool waits for a real completion boundary then checkpoints a settled result without forged admission', async () => {
  const name = 'native-sync-boundary';
  await withNativeApp(name, [{ name: 'write_file', nativeAsync: false }], async ({ app, turnId, fence, record }) => {
    const result = await driveWithCauses(app, fence, turnId);
    await expectDriveTerminal(app, turnId, result, 'completed');
    assert.equal(record.dispatchedInputs.length, 1);
    assert.equal(record.endLogicalRequestCalls, 1);
    assert.equal(record.submissions.length, 0, 'local checkpoint does not fabricate provider result admission');
    const calls = await list(app, 'ToolCall', { turn_id: turnId });
    assert.equal(calls.length, 1);
    const deliveries = (await list(app, 'ToolCallEvent', { tool_call_id: calls[0].id }))
      .filter((row) => row.event_kind === 'native_delivery');
    assert.equal(deliveries.length, 0);
    assert.equal((await list(app, 'ToolModelResult', { tool_call_id: calls[0].id })).length, 1);
    assert.equal((await list(app, 'ContextSegmentSource', { source_kind: 'tool_model_result' })).length, 1);
    assert.equal((await list(app, 'ModelRequest', { turn_id: turnId })).length, 2,
      'the completed safe batch advances within the same Turn via a full request');
    const modelRequestId = (await list(app, 'ModelRequest', { turn_id: turnId }))
      .sort((left, right) => (BigInt(left.request_seq) < BigInt(right.request_seq) ? -1 : 1))[0].id;
    const proofs = await readCheckpointContents(app, modelRequestId, 'native_tool_call');
    assert.equal(proofs.length, 1);
    assert.equal(proofs[0].content.async, false, 'sync proof is honestly not async');
  }, async ({ emit, ended, request, record, dispatchOrdinal }) => {
    if (dispatchOrdinal === 2) {
      assert.ok(request.context.some(segment => segment.segmentKind === 'tool_pair'
        && segment.content.includes('toolModelResult')));
      await emit('native_control', { type: 'response.created', responseId: 'r2' });
      await emit('native_control', { type: 'response.completed', responseId: 'r2',
        usage: { input_tokens: 75, output_tokens: 5, total_tokens: 80 } });
      await emit('completed', { role: 'model', parts: [{ text: 'sync result carried' }] });
      return;
    }
    assert.equal(dispatchOrdinal, 1);
    await emit('native_control', { type: 'response.created', responseId: 'r1', capabilities: { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: true, explicitCaching: true } });
    await emit('output_item_done', {
      type: 'tool_calls',
      outputItem: { id: 'i1', ordinal: 0, providerResponseId: 'r1' },
      calls: [{ id: 'call-sync-1', ordinal: 0, name: 'write_file', arguments: { path: 'out.txt', text: 'x' } }]
    });
    // No execution before the proven boundary + required input: the pump must wait for both.
    await emit('native_control', {
      type: 'response.completed', responseId: 'r1',
      usage: { input_tokens: 70, output_tokens: 10, total_tokens: 80 },
      requiredInput: [{ type: 'function_call_output', callId: 'call-sync-1' }]
    });
    await ended;
    assert.equal(record.submissions.length, 0, 'settled synchronous batch waits for next full request');
    await emit('completed', { role: 'model', parts: [
      { id: 'call-sync-1', functionCall: { name: 'write_file', args: { path: 'out.txt', text: 'x' } },
        outputItem: { id: 'i1', ordinal: 0, providerResponseId: 'r1' } }
    ] }, { usage: { input_tokens: 70, output_tokens: 10, total_tokens: 80 } });
  });
});

test('native durable checkpoints ignore the droppable ordinary cap and persist capability/usage anchors', async () => {
  const name = 'native-checkpoint-cap';
  await withNativeApp(name, [], async ({ app, turnId, fence, record }) => {
    record.assertCheckpointPressure = async () => {
      const [request] = await list(app, 'ModelRequest', { turn_id: turnId });
      assert.equal(request.status, 'streaming');
      const ordinary = (await list(app, 'ModelStreamCheckpoint', { model_request_id: request.id }))
        .filter((row) => row.checkpoint_kind === 'output_item_done');
      assert.ok(ordinary.length <= 33, `droppable item checkpoints stay capped, got ${ordinary.length}`);
      const controls = await readCheckpointContents(app, request.id, 'native_control');
      assert.ok(controls.length >= 40, 'active native control facts survive ordinary checkpoint pressure');
      // Exercise the real heartbeat writer before the native usage anchor, without relying on
      // machine load to cross the periodic heartbeat interval.
      const checkpoints = await list(app, 'ModelStreamCheckpoint', { model_request_id: request.id });
      const streamSeq = checkpoints.reduce((latest, row) => {
        const seq = BigInt(row.stream_seq);
        return seq > latest ? seq : latest;
      }, 0n);
      const activity = await app.database.recordModelStreamActivity({
        modelRequestId: request.id,
        attemptSeq: BigInt(request.stream_stats_json.attemptSeq),
        socketGeneration: BigInt(request.stream_stats_json.socketGeneration),
        streamSeq,
        observedAt: Date.now(),
        now: new Date().toISOString()
      });
      assert.equal(activity.accepted, true);
    };
    const result = await driveWithCauses(app, fence, turnId);
    await expectDriveTerminal(app, turnId, result, 'completed');
    const requests = await list(app, 'ModelRequest', { turn_id: turnId });
    assert.equal(requests.length, 1);
    const stats = typeof requests[0].stream_stats_json === 'string'
      ? JSON.parse(requests[0].stream_stats_json)
      : requests[0].stream_stats_json;
    assert.deepEqual(stats.nativeCapabilities, {
      asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: true, explicitCaching: true
    });
    assert.equal(stats.nativeInitialPromptTokenCount, 55, 'first response usage anchors the original root');
  }, async ({ emit, record }) => {
    await emit('native_control', {
      type: 'response.created', responseId: 'r1',
      capabilities: { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: true, explicitCaching: true }
    });
    for (let index = 0; index < 40; index += 1) {
      await emit('output_delta', { type: 'text_delta', text: `part-${index} `, outputItem: { id: `i${index}`, ordinal: index, providerResponseId: 'r1' } });
      await emit('output_item_done', textItemEnvelope(`i${index}`, index, 'r1'));
      await emit('native_control', { type: 'response.created', responseId: index === 0 ? 'r1' : `rx-${index}`, previousResponseId: 'r1' });
    }
    await record.assertCheckpointPressure();
    await emit('native_control', { type: 'response.completed', responseId: 'r1', usage: { input_tokens: 55, output_tokens: 5, total_tokens: 60 } });
    await emit('completed', {
      role: 'model',
      parts: [{ text: 'aggregated' }]
    }, { usage: { input_tokens: 55, output_tokens: 5, total_tokens: 60 } });
  });
});

test('semantic idle watchdog stays quiet during a proven native input wait', async () => {
  const name = 'native-input-wait';
  await withNativeApp(name, [{ name: 'read_file', nativeAsync: true }], async ({ app, turnId, fence, adapter }) => {
    // A short-idle control plane proves the suspension; the composed loop would use the default
    // 10-minute deadlines, so this scenario drives the control plane directly. Margins stay
    // deterministic under concurrent suites: the proven input wait (600ms) exceeds the 250ms idle
    // deadline by >2x, while every post-resume emit cycle is two durable writes (<deadline even
    // under heavy DB load).
    const controlPlane = new kernel.ModelProviderControlPlane(app.database, app.contentStore, {
      semanticTimeouts: { firstSemanticMs: 300, semanticIdleMs: 250, compressionCompletionMs: 400 },
      retryDelaysMs: [0],
      adapterDrainTimeoutMs: 20
    });
    const head = (await list(app, 'ConversationContextHeadLink', { conversation_id: name }))[0];
    const authoritySnapshot = (await list(app, 'AuthoritySnapshot', { turn_id: turnId }))[0];
    const created = await controlPlane.createModelRequest({
      turnId,
      contextRootId: head.root_id,
      authoritySnapshotId: authoritySnapshot.id,
      recipe: {
        kind: 'reliable-agent-turn',
        round: '1',
        tools: [{ name: 'read_file', description: 'fixture', parameters: {}, metadata: { nativeAsync: true } }],
        nativeResponses: { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: true, explicitCaching: true }
      },
      idempotencyKey: `${name}:round:1`
    });
    const dispatch = await kernel.runWithExecutionLeaseFence(fence, () =>
      controlPlane.dispatch(created.modelRequestId, adapter, { reconnect: false }));
    assert.equal(dispatch.terminalState, 'completed', 'the proven input wait resumes and completes without stream_stalled');
    const request = (await list(app, 'ModelRequest', { turn_id: turnId }))
      .find((row) => row.id === created.modelRequestId);
    assert.equal(request.terminal_state, 'completed');
  }, async ({ emit }) => {
    await emit('native_control', { type: 'response.created', responseId: 'r1', capabilities: { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: true, explicitCaching: true } });
    await emit('output_item_done', {
      type: 'tool_calls',
      outputItem: { id: 'i1', ordinal: 0, providerResponseId: 'r1' },
      calls: [{ id: 'call-wait-1', ordinal: 0, name: 'read_file', arguments: {}, async: true }]
    });
    await emit('native_control', { type: 'response.completed', responseId: 'r1' });
    // More than twice the semantic idle deadline: a proven input wait must not stall the stream.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await emit('native_control', {
      type: 'response.created', responseId: 'r-submit-1', previousResponseId: 'r1',
      admittedToolResultCallIds: ['call-wait-1']
    });
    await emit('native_control', { type: 'response.completed', responseId: 'r-submit-1' });
    await emit('completed', {
      role: 'model',
      parts: [
        { id: 'call-wait-1', functionCall: { name: 'read_file', args: {} }, async: true, outputItem: { id: 'i1', ordinal: 0, providerResponseId: 'r1' } },
        { text: 'resumed', outputItem: { id: 'i2', ordinal: 1, providerResponseId: 'r-submit-1' } }
      ]
    }, { usage: { input_tokens: 40, output_tokens: 5, total_tokens: 45 } });
  });
});
