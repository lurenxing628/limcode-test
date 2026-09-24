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

function modelOutput(text) {
  return { role: 'model', parts: [{ text }] };
}

function frozenPolicy() {
  return {
    displayAutoExpand: false,
    displayAutoOpenDiff: false,
    executionGate: 'automatic',
    changeApplyMode: 'unsupported',
    changeApplyDelaySeconds: 0,
    autoSubmitResult: true,
    schedulingMode: 'parallel'
  };
}

const SCHEDULER_DEFINITIONS = [
  { declaration: { name: 'read', description: 'readonly fixture', parameters: { type: 'object' } } },
  { declaration: { name: 'run_agent', description: 'child fixture', parameters: { type: 'object' } } }
];

/** Full recipe entries matching the host declarations exactly (production definition shape). */
function schedulerRecipeTools(names) {
  return SCHEDULER_DEFINITIONS
    .filter((definition) => names.includes(definition.declaration.name))
    .map((definition) => ({
      name: definition.declaration.name,
      description: definition.declaration.description,
      parameters: definition.declaration.parameters
    }));
}

/** Observes scheduled task settlement so a rejected call fails the test promptly, not via timeout. */
function watchScheduled(tasks) {
  const state = { settled: new Map() };
  for (const [index, task] of tasks.entries()) {
    Promise.resolve(task).then(
      (result) => { state.settled.set(index, result); },
      (error) => { state.settled.set(index, error); }
    );
  }
  return state;
}

async function untilScheduling(state, allowedSettled, predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    const premature = [...state.settled.keys()].filter((index) => !allowedSettled.has(index));
    if (premature.length > 0) {
      const details = premature.map((index) => {
        const value = state.settled.get(index);
        return value instanceof Error
          ? `#${index} threw ${String(value && value.message)}`
          : `#${index} settled ${JSON.stringify(value)}`;
      }).join('; ');
      throw new Error(`Premature scheduled settlement while waiting for ${label}: ${details}`);
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function dependencies(host = { definitions: () => [] }, toolPolicyOverrides = {}) {
  return {
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: {
            content: JSON.stringify({ providerConfigId: 'provider-native', modelId: 'model-native' })
          },
          authoritySnapshot: {
            content: JSON.stringify({
              kind: 'effective-turn-authority',
              turnId: request.turnId,
              conversationId: request.conversationId,
              executorAgentId: request.executorAgentId,
              model: {
                providerConfigId: 'provider-native',
                provider: 'openai-responses',
                modelId: 'model-native',
                retryPolicy: { enabled: false, maxRetries: 0 }
              },
              modelProfile: {
                compressionThresholdTokens: 100000,
                contextWindowTokens: 128000,
                tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
              },
              toolPolicy: {
                id: 'tools-default',
                allowedTools: [],
                preset: 'custom',
                toolConfigs: {},
                sourceConfigs: {},
                ...toolPolicyOverrides
              },
              planReviewPolicy: { mode: 'never' },
              systemPrompt: { id: 'prompt-default', text: '' },
              runtimeContext: { id: null, name: '', template: '' },
              workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
            })
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
        return {
          providerId,
          async sendFullRequest() { throw new Error('fixture provider must be supplied explicitly'); }
        };
      }
    },
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) =>
      new kernel.ReliableToolDispatcher({
        database,
        contentStore,
        effects: runtime.effects,
        files,
        fileMutations,
        processes,
        mcp,
        interactions,
        host
      })
  };
}

async function list(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where,
    orderBy: { column: 'id', direction: 'asc' },
    limit: 100
  }))).snapshot;
}

async function leaseFence(app, conversationId) {
  const lease = (await list(app, 'ExecutionLease', { conversation_id: conversationId }))[0];
  assert.ok(lease, 'test Turn must own an ExecutionLease');
  return {
    id: lease.id,
    conversationId: lease.conversation_id,
    turnId: lease.turn_id,
    ownerId: lease.owner_id,
    hostBootId: lease.host_boot_id,
    generation: lease.generation
  };
}

async function withNativeApp(name, run, host, toolPolicyOverrides) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const authority = new kernel.RootAuthority(() => path.join(parent, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const app = await kernel.ReliableKernelApplication.open(authority, dependencies(host, toolPolicyOverrides));
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
      content: 'native tool admission fixture'
    });
    await run(app, name, started.turnId);
  } finally {
    await app.close();
    await fs.rm(parent, { recursive: true, force: true });
  }
}

async function createStreamingRequest(app, turnId, key, tools = []) {
  const turn = (await list(app, 'Turn', { id: turnId }))[0];
  const head = (await list(app, 'ConversationContextHeadLink', { conversation_id: turn.conversation_id }))[0];
  const authoritySnapshot = (await list(app, 'AuthoritySnapshot', { turn_id: turnId }))[0];
  const created = await app.modelProvider.createModelRequest({
    turnId,
    contextRootId: head.root_id,
    authoritySnapshotId: authoritySnapshot.id,
    recipe: { kind: 'reliable-agent-turn', round: '1', tools },
    idempotencyKey: key
  });
  // Drive the established dispatch socket-open: it commits the full streaming aggregate
  // (ModelRequest streaming + running Operation/Attempt + first socket generation) before the
  // adapter starts, then the holding adapter keeps the stream open for the test.
  const opened = deferred();
  const hold = deferred();
  const dispatchPromise = app.modelProvider.dispatch(created.modelRequestId, {
    providerId: 'provider-native',
    async sendFullRequest(_request, controls) {
      opened.resolve(controls);
      if (controls.signal.aborted) return;
      await Promise.race([
        hold.promise,
        new Promise((resolve) => controls.signal.addEventListener('abort', resolve, { once: true }))
      ]);
    }
  });
  // Teardown aborts the held stream; the terminal classification is not part of any assertion.
  void dispatchPromise.catch(() => undefined);
  const controls = await opened.promise;
  const request = (await list(app, 'ModelRequest', { id: created.modelRequestId }))[0];
  assert.equal(request.status, 'streaming', 'dispatch socket-open must commit the streaming aggregate');
  const stats = request.stream_stats_json;
  return {
    modelRequestId: created.modelRequestId,
    controls,
    close: hold.resolve,
    identity: {
      attemptSeq: String(stats.attemptSeq),
      socketGeneration: String(stats.socketGeneration)
    }
  };
}

async function insertAssistantMessage(app, modelRequestId, key) {
  const now = new Date().toISOString();
  const messageId = `message-${key}`;
  await app.database.transaction([
    kernel.DOMAIN_REPOSITORIES.domain('Message').insert({
      id: messageId, created_at: now, updated_at: now, deleted_at: null
    }),
    kernel.DOMAIN_REPOSITORIES.domain('ModelRequestMessageLink').insert({
      id: `request-message-link-${key}`,
      model_request_id: modelRequestId,
      message_id: messageId,
      created_at: now
    })
  ]);
  return messageId;
}

async function persistNativeCheckpoint(app, request, streamSeq, checkpointKind, payload) {
  const result = checkpointKind === 'native_tool_call'
    ? await app.modelProvider.recordNativeToolCallProof(
        request.modelRequestId,
        request.identity.attemptSeq,
        request.identity.socketGeneration,
        String(streamSeq),
        payload
      )
    : await app.modelProvider.recordStreamEvent(
        request.modelRequestId,
        request.identity.attemptSeq,
        request.identity.socketGeneration,
        { kind: 'native_control', streamSeq: String(streamSeq), content: payload }
      );
  assert.deepEqual(
    { accepted: result.accepted, checkpointed: result.checkpointed },
    { accepted: true, checkpointed: true },
    `native checkpoint ${checkpointKind}@${streamSeq} must persist`
  );
  const persisted = (await list(app, 'ModelStreamCheckpoint', { model_request_id: request.modelRequestId }))
    .filter((row) => String(row.stream_seq) === String(streamSeq) && row.checkpoint_kind === checkpointKind);
  assert.equal(persisted.length, 1, `native checkpoint ${checkpointKind}@${streamSeq} must be uniquely readable`);
  return persisted[0].id;
}

function nativeEntry(toolCallId, overrides = {}) {
  return {
    toolCallId,
    toolName: 'read',
    arguments: { path: '/tmp/native-fixture' },
    providerCallId: `call-${toolCallId}`,
    providerOrdinal: 0,
    policy: frozenPolicy(),
    ...overrides
  };
}

function nativeItemCheckpoint(entry, overrides = {}) {
  return {
    type: 'native_tool_call',
    responseId: 'resp-1',
    toolName: entry.toolName,
    arguments: entry.arguments,
    resolvedArguments: entry.arguments,
    modelHandleCatalog: { entries: [] },
    providerCallId: entry.providerCallId,
    providerOrdinal: entry.providerOrdinal,
    async: true,
    ...overrides
  };
}

function batchInput(turnId, modelRequestId, messageId, entry, key) {
  return {
    source: { kind: 'callback', key: `test:${key}` },
    batchId: `batch-${key}`,
    turnId,
    modelRequestId,
    messageId,
    entries: [entry]
  };
}

test('native async streamed admission persists call facts plus admission event atomically', async () => {
  await withNativeApp('native-async-admission', async (app, conversationId, turnId) => {
    const effects = app.runtime.effects;
    const request = await createStreamingRequest(app, turnId, 'req-1');
    const messageId = await insertAssistantMessage(app, request.modelRequestId, 'req-1');
    const entry = nativeEntry('tool-call-async-1');
    const outputItem = {
      id: 'item-async-1',
      ordinal: 0,
      phase: 'commentary',
      providerResponseId: 'resp-1'
    };
    const checkpointId = await persistNativeCheckpoint(
      app,
      request,
      1,
      'native_tool_call',
      nativeItemCheckpoint(entry, { outputItem })
    );

    const created = await effects.createToolCallBatch({
      ...batchInput(turnId, request.modelRequestId, messageId, entry, 'async-1'),
      streamIdentity: { ...request.identity, streamSeq: '1' }
    });
    assert.equal(created.deduplicated, false);
    assert.equal(created.calls.length, 1);

    const call = (await list(app, 'ToolCall', { id: entry.toolCallId }))[0];
    assert.equal(call.status, 'pending');
    assert.equal(call.tool_name, 'read');

    const admission = await effects.readNativeAdmission(entry.toolCallId);
    assert.ok(admission, 'admission event must be durable');
    assert.equal(admission.declaredAsync, true);
    assert.equal(admission.responseId, 'resp-1');
    assert.equal(admission.providerCallId, entry.providerCallId);
    assert.equal(admission.checkpointId, checkpointId);
    assert.deepEqual(admission.outputItem, outputItem, 'the actual output item survives pruning in the admission CAS');

    const replay = await effects.createToolCallBatch({
      ...batchInput(turnId, request.modelRequestId, messageId, entry, 'async-1'),
      streamIdentity: { ...request.identity, streamSeq: '1' }
    });
    assert.equal(replay.deduplicated, true);
    assert.equal(replay.calls[0].toolCallId, entry.toolCallId);

    const pending = await effects.listNativePendingWork({ conversationId });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].toolCallId, entry.toolCallId);
    assert.equal(pending[0].settled, false);
    assert.equal(pending[0].delivered, false);
    assert.equal(pending[0].turnActive, true);
    assert.equal(pending[0].messageId, messageId);
    await assert.rejects(
      effects.assertNativeWorkSettledForConversation(conversationId),
      (error) => error.code === 'NATIVE_ASYNC_WORK_PENDING' && String(error.message).includes(entry.toolCallId)
    );
  });
});

test('streamed admission rejects every unproven shape and keeps legacy semantics', async () => {
  await withNativeApp('native-admission-rejects', async (app, conversationId, turnId) => {
    const effects = app.runtime.effects;
    const request = await createStreamingRequest(app, turnId, 'req-2');
    const modelRequestId = request.modelRequestId;
    const messageId = await insertAssistantMessage(app, modelRequestId, 'req-2');
    const entry = nativeEntry('tool-call-reject-1');
    await persistNativeCheckpoint(app, request, 1, 'native_tool_call', nativeItemCheckpoint(entry));

    // Missing checkpoint.
    await assert.rejects(
      effects.createToolCallBatch({
        ...batchInput(turnId, modelRequestId, messageId, nativeEntry('tool-call-missing-proof'), 'rej-missing'),
        streamIdentity: { ...request.identity, streamSeq: '90' }
      }),
      /no persisted complete native call item/
    );
    // Argument mismatch against the persisted complete item.
    await assert.rejects(
      effects.createToolCallBatch({
        ...batchInput(turnId, modelRequestId, messageId, nativeEntry(entry.toolCallId, { arguments: { path: '/other' } }), 'rej-args'),
        streamIdentity: { ...request.identity, streamSeq: '1' }
      }),
      /does not match ToolCall/
    );
    // Anonymous native calls are never admitted.
    await assert.rejects(
      effects.createToolCallBatch({
        ...batchInput(turnId, modelRequestId, messageId, nativeEntry(entry.toolCallId, { providerCallId: undefined }), 'rej-anon'),
        streamIdentity: { ...request.identity, streamSeq: '1' }
      }),
      /original provider call id/
    );
    // A wrong checkpoint kind is not the complete native call item.
    await persistNativeCheckpoint(app, request, 2, 'native_control', {
      type: 'response.created', responseId: 'resp-1'
    });
    await assert.rejects(
      effects.createToolCallBatch({
        ...batchInput(turnId, modelRequestId, messageId, nativeEntry(entry.toolCallId), 'rej-kind'),
        streamIdentity: { ...request.identity, streamSeq: '2' }
      }),
      /no persisted complete native call item/
    );
    // The legacy completed-batch path still rejects a non-terminal ModelRequest.
    await assert.rejects(
      effects.createToolCallBatch(batchInput(turnId, modelRequestId, messageId, nativeEntry('tool-call-legacy'), 'rej-legacy')),
      /is not the completed Provider source/
    );
    // A terminal ModelRequest is never a streamed-admission source; complete the stream through
    // the established dispatch path.
    await request.controls.onEvent({ kind: 'completed', streamSeq: '90', content: modelOutput('done') });
    assert.equal(
      (await list(app, 'ModelRequest', { id: modelRequestId }))[0].status,
      'terminal',
      'the completed Provider event must terminalize the request'
    );
    await assert.rejects(
      effects.createToolCallBatch({
        ...batchInput(turnId, modelRequestId, messageId, entry, 'rej-terminal'),
        streamIdentity: { ...request.identity, streamSeq: '1' }
      }),
      /already terminal/
    );
  });
});

test('sync native calls admit only at the matching response boundary', async () => {
  await withNativeApp('native-sync-boundary', async (app, conversationId, turnId) => {
    const effects = app.runtime.effects;
    const request = await createStreamingRequest(app, turnId, 'req-3');
    const modelRequestId = request.modelRequestId;
    const messageId = await insertAssistantMessage(app, modelRequestId, 'req-3');
    const entry = nativeEntry('tool-call-sync-1');
    await persistNativeCheckpoint(app, request, 1, 'native_tool_call', nativeItemCheckpoint(entry, { async: false }));

    // Sync never admits at mere item completion.
    await assert.rejects(
      effects.createToolCallBatch({
        ...batchInput(turnId, modelRequestId, messageId, entry, 'sync-no-boundary'),
        streamIdentity: { ...request.identity, streamSeq: '1' }
      }),
      /requires completedResponseStreamSeq and providerResponseId/
    );
    // A response.created observation is not an admission boundary.
    await persistNativeCheckpoint(app, request, 2, 'native_control', {
      type: 'response.created', responseId: 'resp-1'
    });
    await assert.rejects(
      effects.createToolCallBatch({
        ...batchInput(turnId, modelRequestId, messageId, entry, 'sync-created'),
        streamIdentity: { ...request.identity, streamSeq: '1', completedResponseStreamSeq: '2', providerResponseId: 'resp-1' }
      }),
      /is not an admission boundary/
    );
    // A boundary of another provider response cannot admit this call.
    await persistNativeCheckpoint(app, request, 3, 'native_control', {
      type: 'response.completed', responseId: 'resp-other'
    });
    await assert.rejects(
      effects.createToolCallBatch({
        ...batchInput(turnId, modelRequestId, messageId, entry, 'sync-other-response'),
        streamIdentity: { ...request.identity, streamSeq: '1', completedResponseStreamSeq: '3', providerResponseId: 'resp-other' }
      }),
      /belongs to provider response/
    );
    // The exact completed boundary of the same response admits.
    await persistNativeCheckpoint(app, request, 4, 'native_control', {
      type: 'response.completed', responseId: 'resp-1'
    });
    const created = await effects.createToolCallBatch({
      ...batchInput(turnId, modelRequestId, messageId, entry, 'sync-admitted'),
      streamIdentity: { ...request.identity, streamSeq: '1', completedResponseStreamSeq: '4', providerResponseId: 'resp-1' }
    });
    assert.equal(created.deduplicated, false);
    const admission = await effects.readNativeAdmission(entry.toolCallId);
    assert.equal(admission.declaredAsync, false);
  });
});

test('settled result context, delivery marking and closure complete the native lifecycle', async () => {
  await withNativeApp('native-lifecycle', async (app, conversationId, turnId) => {
    const effects = app.runtime.effects;
    const context = app.context;
    const fence = await leaseFence(app, conversationId);
    const request = await createStreamingRequest(app, turnId, 'req-4');
    const modelRequestId = request.modelRequestId;
    const messageId = await insertAssistantMessage(app, modelRequestId, 'req-4');
    const entry = nativeEntry('tool-call-life-1');
    await persistNativeCheckpoint(app, request, 1, 'native_tool_call', nativeItemCheckpoint(entry));
    await effects.createToolCallBatch({
      ...batchInput(turnId, modelRequestId, messageId, entry, 'life-1'),
      streamIdentity: { ...request.identity, streamSeq: '1' }
    });

    // Settlement commits the single ToolModelResult; context call occurrence follows.
    const settlement = await effects.settleWithoutEffect({
      source: { kind: 'internal', key: 'settle-life-1' },
      toolCallId: entry.toolCallId,
      status: 'succeeded',
      detail: { output: 'native result body' }
    });
    assert.equal(settlement.terminal?.toolCallId, entry.toolCallId);

    const rootIdBefore = (await list(app, 'ConversationContextHeadLink', { conversation_id: conversationId }))[0].root_id;
    await kernel.runWithExecutionLeaseFence(fence, () => context.appendNativeToolCall({
      conversationId,
      toolCallId: entry.toolCallId
    }));
    const callSources = await list(app, 'ContextSegmentSource', { source_kind: 'tool_call', source_id: entry.toolCallId });
    assert.equal(callSources.length, 1);
    const callSegment = (await list(app, 'ContextSegment', { id: callSources[0].segment_id }))[0];
    assert.equal(callSegment.segment_kind, 'tool_pair');

    // The prefix with the open call occurrence is not closed.
    const rootAfterCall = (await list(app, 'ConversationContextHeadLink', { conversation_id: conversationId }))[0].root_id;
    await assert.rejects(
      context.assertNativeContextClosed(rootAfterCall),
      (error) => error.code === 'NATIVE_ASYNC_WORK_PENDING'
    );
    assert.notEqual(rootIdBefore, rootAfterCall);

    // Unverified delivery (no durable response.created admission) is rejected.
    const deliverySource = { kind: 'internal', key: 'deliver-life-1' };
    await assert.rejects(
      effects.markNativeResultsDelivered({
        source: deliverySource,
        deliveries: [{ toolCallId: entry.toolCallId, carrierModelRequestId: modelRequestId, providerResponseId: 'resp-2' }]
      }),
      /delivery is unverified/
    );

    // The carrier's response.created naming the provider call id proves admission.
    await persistNativeCheckpoint(app, request, 2, 'native_control', {
      type: 'response.created', responseId: 'resp-2', admittedToolResultCallIds: [entry.providerCallId]
    });
    const resultRow = (await list(app, 'ToolModelResult', { tool_call_id: entry.toolCallId }))[0];
    await kernel.runWithExecutionLeaseFence(fence, () => context.appendNativeToolResult({
      conversationId,
      toolCallId: entry.toolCallId,
      toolModelResultId: resultRow.id
    }));
    const resultSources = await list(app, 'ContextSegmentSource', { source_kind: 'tool_model_result', source_id: resultRow.id });
    assert.equal(resultSources.length, 1);

    const marked = await kernel.runWithExecutionLeaseFence(fence, () => effects.markNativeResultsDelivered({
      source: deliverySource,
      deliveries: [{ toolCallId: entry.toolCallId, carrierModelRequestId: modelRequestId, providerResponseId: 'resp-2' }]
    }));
    assert.equal(marked.deduplicated, false);
    assert.equal(marked.events.length, 1);

    // Same-carrier replay deduplicates; a conflicting carrier is a hard error.
    const replay = await effects.markNativeResultsDelivered({
      source: deliverySource,
      deliveries: [{ toolCallId: entry.toolCallId, carrierModelRequestId: modelRequestId, providerResponseId: 'resp-2' }]
    });
    assert.equal(replay.deduplicated, true);
    await assert.rejects(
      effects.markNativeResultsDelivered({
        source: { kind: 'internal', key: 'deliver-life-1-conflict' },
        deliveries: [{ toolCallId: entry.toolCallId, carrierModelRequestId: modelRequestId, providerResponseId: 'resp-3' }]
      }),
      /conflicting native delivery/
    );

    const pending = await effects.listNativePendingWork({ conversationId });
    assert.equal(pending.length, 0);
    await effects.assertNativeWorkSettledForConversation(conversationId);
    const rootIdFinal = (await list(app, 'ConversationContextHeadLink', { conversation_id: conversationId }))[0].root_id;
    await context.assertNativeContextClosed(rootIdFinal);
    await context.assertNativeContextClosed(rootIdFinal, resultSources[0].segment_id);
  });
});

test('delivery pump settlement wake fires from the dispatcher subscription', async () => {
  await withNativeApp('native-settlement-wake', async (app, conversationId, turnId) => {
    const effects = app.runtime.effects;
    const request = await createStreamingRequest(app, turnId, 'req-5');
    const modelRequestId = request.modelRequestId;
    const messageId = await insertAssistantMessage(app, modelRequestId, 'req-5');
    const entry = nativeEntry('tool-call-wake-1');
    await persistNativeCheckpoint(app, request, 1, 'native_tool_call', nativeItemCheckpoint(entry));
    await effects.createToolCallBatch({
      ...batchInput(turnId, modelRequestId, messageId, entry, 'wake-1'),
      streamIdentity: { ...request.identity, streamSeq: '1' }
    });

    const wakes = [];
    const unsubscribe = app.toolDispatcher.subscribeToolSettlements({ turnId }, (event) => {
      wakes.push(event.toolCallId);
    });
    try {
      await effects.settleWithoutEffect({
        source: { kind: 'internal', key: 'settle-wake-1' },
        toolCallId: entry.toolCallId,
        status: 'succeeded',
        detail: { output: 'wake me' }
      });
      assert.deepEqual(wakes, [entry.toolCallId]);
    } finally {
      unsubscribe();
    }
    await effects.settleWithoutEffect({
      source: { kind: 'internal', key: 'settle-wake-1-again' },
      toolCallId: entry.toolCallId,
      status: 'succeeded',
      detail: { output: 'wake me' }
    });
    assert.deepEqual(wakes, [entry.toolCallId], 'unsubscribed listeners must not fire');
  });
});

test('no-lease closure appends settled result occurrences and ordinary pair validation stays strict', async () => {
  await withNativeApp('native-no-lease-closure', async (app, conversationId, turnId) => {
    const effects = app.runtime.effects;
    const context = app.context;
    const fence = await leaseFence(app, conversationId);
    const request = await createStreamingRequest(app, turnId, 'req-6');
    const modelRequestId = request.modelRequestId;
    const messageId = await insertAssistantMessage(app, modelRequestId, 'req-6');
    const entry = nativeEntry('tool-call-closure-1');
    await persistNativeCheckpoint(app, request, 1, 'native_tool_call', nativeItemCheckpoint(entry));
    await effects.createToolCallBatch({
      ...batchInput(turnId, modelRequestId, messageId, entry, 'closure-1'),
      streamIdentity: { ...request.identity, streamSeq: '1' }
    });
    await effects.settleWithoutEffect({
      source: { kind: 'internal', key: 'settle-closure-1' },
      toolCallId: entry.toolCallId,
      status: 'cancelled',
      detail: { reason: 'turn cancelled before delivery' }
    });
    await kernel.runWithExecutionLeaseFence(fence, () => context.appendNativeToolCall({
      conversationId,
      toolCallId: entry.toolCallId
    }));

    // An unfenced closure while the Turn/lease are live must fail the atomic no-lease assertion.
    const resultRow = (await list(app, 'ToolModelResult', { tool_call_id: entry.toolCallId }))[0];
    await assert.rejects(
      context.appendNativeToolResult({
        conversationId,
        toolCallId: entry.toolCallId,
        toolModelResultId: resultRow.id
      })
    );
    assert.equal(
      (await list(app, 'ContextSegmentSource', { source_kind: 'tool_model_result', source_id: resultRow.id })).length,
      0,
      'the rejected unfenced closure must not commit a result occurrence'
    );

    // Terminal Turn + released lease through the established APIs: complete the stream, then
    // terminalize the Turn under the captured fence (the terminal transaction releases the lease).
    await request.controls.onEvent({ kind: 'completed', streamSeq: '90', content: modelOutput('stream complete') });
    await kernel.runWithExecutionLeaseFence(fence, () => app.turns.terminal({
      source: { kind: 'internal', key: 'closure-terminal' },
      turnId,
      terminalStatus: 'cancelled',
      reason: 'native closure fixture'
    }));
    assert.equal(
      (await list(app, 'ExecutionLease', { conversation_id: conversationId })).length,
      0,
      'the Turn terminal transaction must release the ExecutionLease'
    );
    assert.equal((await list(app, 'Turn', { id: turnId }))[0].status, 'terminated');
    await context.appendNativeToolResult({
      conversationId,
      toolCallId: entry.toolCallId,
      toolModelResultId: resultRow.id
    });
    await effects.assertNativeWorkSettledForConversation(conversationId);
    const head = (await list(app, 'ConversationContextHeadLink', { conversation_id: conversationId }))[0];
    await context.assertNativeContextClosed(head.root_id);

    // The public generic validators still reject a one-source ordinary tool_pair.
    assert.throws(
      () => kernel.validateNewContextSegmentSources('tool_pair', [
        { sourceKind: 'tool_call', sourceId: 'ordinary-call', sourceRevision: 1n }
      ]),
      /tool_call and tool_model_result/
    );
    const shape = kernel.classifyToolPairSources([
      { sourceKind: 'tool_call', sourceId: 'c1', sourceRevision: 1n },
      { sourceKind: 'tool_model_result', sourceId: 'r1', sourceRevision: 1n }
    ]);
    assert.equal(shape.kind, 'atomic');
    assert.equal(
      kernel.classifyToolPairSources([{ sourceKind: 'tool_call', sourceId: 'c1', sourceRevision: 1n }]).kind,
      'native_call'
    );
    assert.equal(
      kernel.classifyToolPairSources([{ sourceKind: 'tool_model_result', sourceId: 'r1', sourceRevision: 1n }]).kind,
      'native_result'
    );
  });
});

test('a fork moves a late native result behind its cut and only checks its own retained calls', async () => {
  await withNativeApp('native-fork-late-result', async (app, conversationId, turnId) => {
    const effects = app.runtime.effects;
    const context = app.context;
    const firstFence = await leaseFence(app, conversationId);
    const firstRequest = await createStreamingRequest(app, turnId, 'late-req-1');
    const firstMessage = await insertAssistantMessage(app, firstRequest.modelRequestId, 'late-req-1');
    const late = nativeEntry('tool-call-late-a');
    await persistNativeCheckpoint(app, firstRequest, 1, 'native_tool_call', nativeItemCheckpoint(late));
    await effects.createToolCallBatch({
      ...batchInput(turnId, firstRequest.modelRequestId, firstMessage, late, 'late-a'),
      streamIdentity: { ...firstRequest.identity, streamSeq: '1' }
    });
    await kernel.runWithExecutionLeaseFence(firstFence, () => context.appendNativeToolCall({ conversationId, toolCallId: late.toolCallId }));
    // The call settles with its Turn, but its result occurrence has not reached the Context yet.
    await effects.settleWithoutEffect({
      source: { kind: 'internal', key: 'late-settle-a' }, toolCallId: late.toolCallId,
      status: 'succeeded', detail: { output: 'late native result body' }
    });
    await firstRequest.controls.onEvent({ kind: 'completed', streamSeq: '90', content: modelOutput('first response') });
    await kernel.runWithExecutionLeaseFence(firstFence, () => app.turns.terminal({
      source: { kind: 'internal', key: 'late-first-terminal' }, turnId, terminalStatus: 'cancelled', reason: 'late result fixture'
    }));
    const [lateCall] = await list(app, 'ContextSegmentSource', { source_kind: 'tool_call', source_id: late.toolCallId });
    const fork = (key, rootId, endSegmentId) => app.runtime.conversationFork.fork({
      idempotencyKey: key, reuseKey: key, sourceConversationId: conversationId, sourceContextRootId: rootId,
      sourceContextEndSegmentId: endSegmentId, targetTitle: key, targetAgentId: 'agent-main'
    });
    const openRoot = (await list(app, 'ConversationContextHeadLink', { conversation_id: conversationId }))[0].root_id;
    await assert.rejects(fork('late-open-call', openRoot, lateCall.segment_id), (error) => error.code === 'NATIVE_ASYNC_WORK_PENDING',
      'a retained call whose result is not in the Context still rejects the fork');

    // A later Turn runs and admits its own unsettled native call; then the earlier result's
    // occurrence is appended behind that later history.
    const second = await app.turns.input({
      source: { kind: 'command', key: 'late-second-input' }, conversationId,
      leaseOwnerId: 'late-second-owner', hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), content: 'later user input after the cut'
    });
    const secondFence = await leaseFence(app, conversationId);
    const secondRequest = await createStreamingRequest(app, second.turnId, 'late-req-2');
    const secondMessage = await insertAssistantMessage(app, secondRequest.modelRequestId, 'late-req-2');
    const running = nativeEntry('tool-call-late-b', { providerCallId: 'call-late-b' });
    await persistNativeCheckpoint(app, secondRequest, 1, 'native_tool_call', nativeItemCheckpoint(running));
    await effects.createToolCallBatch({
      ...batchInput(second.turnId, secondRequest.modelRequestId, secondMessage, running, 'late-b'),
      streamIdentity: { ...secondRequest.identity, streamSeq: '1' }
    });
    await kernel.runWithExecutionLeaseFence(secondFence, () => context.appendNativeToolCall({ conversationId, toolCallId: running.toolCallId }));
    const [lateResult] = await list(app, 'ToolModelResult', { tool_call_id: late.toolCallId });
    await kernel.runWithExecutionLeaseFence(secondFence, () => context.appendNativeToolResult({
      conversationId, toolCallId: late.toolCallId, toolModelResultId: lateResult.id
    }));
    const [lateResultSource] = await list(app, 'ContextSegmentSource', { source_kind: 'tool_model_result', source_id: lateResult.id });
    const [runningCall] = await list(app, 'ContextSegmentSource', { source_kind: 'tool_call', source_id: running.toolCallId });
    const headRoot = (await list(app, 'ConversationContextHeadLink', { conversation_id: conversationId }))[0].root_id;
    const sourceSegments = (await context.materializeStructure(headRoot)).records.map((record) => record.segment.id);
    const cutIndex = sourceSegments.indexOf(lateCall.segment_id);
    assert.ok(sourceSegments.indexOf(lateResultSource.segment_id) > sourceSegments.indexOf(runningCall.segment_id),
      'fixture: the late result lands after the later Turn history');

    const moved = await fork('late-result-moved', headRoot, lateCall.segment_id);
    const forkSegments = (await context.materializeStructure(moved.targetRootId)).records.map((record) => record.segment.id);
    assert.deepEqual(forkSegments, [...sourceSegments.slice(0, cutIndex + 1), lateResultSource.segment_id],
      'the cut never extends over later history; the settled result is appended behind it');
    const forkContent = (await context.materialize(moved.targetRootId)).segments
      .map((segment) => segment.content.toString('utf8')).join('\n');
    assert.doesNotMatch(forkContent, /later user input after the cut/);
    assert.match(forkContent, /late native result body/);
    const [forkRoot] = await list(app, 'ContextSequenceRoot', { id: moved.targetRootId });
    assert.ok(forkRoot.estimated_tokens > 0n);
    assert.equal((await fork('late-result-moved', headRoot, lateCall.segment_id)).deduplicated, true);

    await assert.rejects(fork('late-running-call', headRoot, runningCall.segment_id), (error) => error.code === 'NATIVE_ASYNC_WORK_PENDING',
      'retaining the running Turn call makes it part of the fork and it still rejects');
  });
});

test('fork_conversation copies the completed history of a caller whose native Turn still runs an async call', async () => {
  const { ReliableConversationLifecycle } = await import(pathToFileURL(
    path.join(compiledRoot, 'backend/application/reliableKernel/conversationLifecycle.js')
  ).href);
  await withNativeApp('native-fork-completed-history', async (app, conversationId, turnId) => {
    const firstFence = await leaseFence(app, conversationId);
    await kernel.runWithExecutionLeaseFence(firstFence, () => app.turns.terminal({
      source: { kind: 'internal', key: 'native-fork-first-terminal' }, turnId, terminalStatus: 'completed', reason: 'completed fixture Turn'
    }));
    // The calling Turn is still running a native logical request with an unsettled async call.
    const current = await app.turns.input({
      source: { kind: 'command', key: 'native-fork-current-input' }, conversationId,
      leaseOwnerId: 'native-fork-owner', hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), content: 'current native turn asks to fork itself'
    });
    const currentFence = await leaseFence(app, conversationId);
    const request = await createStreamingRequest(app, current.turnId, 'native-fork-current');
    const message = await insertAssistantMessage(app, request.modelRequestId, 'native-fork-current');
    const running = nativeEntry('tool-call-native-fork', { providerCallId: 'call-native-fork' });
    await persistNativeCheckpoint(app, request, 1, 'native_tool_call', nativeItemCheckpoint(running));
    await app.runtime.effects.createToolCallBatch({
      ...batchInput(current.turnId, request.modelRequestId, message, running, 'native-fork'),
      streamIdentity: { ...request.identity, streamSeq: '1' }
    });
    await kernel.runWithExecutionLeaseFence(currentFence, () => app.context.appendNativeToolCall({ conversationId, toolCallId: running.toolCallId }));
    const copied = [];
    // Recorded, not thrown: a failed cleanup is only logged, so a throwing stub could never fail this test.
    const cleared = [];
    const lifecycle = new ReliableConversationLifecycle({ application: app, configuration: { mutations: {
      async copyConversationConfiguration(source, target) { copied.push([source, target]); },
      async clearConversationConfiguration(target) { cleared.push(target); }
    } } });

    const fork = await lifecycle.forkCompletedHistory({ sourceConversationId: conversationId, commandId: 'native-fork-tool-call' });
    assert.equal(fork.deduplicated, false);
    assert.deepEqual(copied, [[conversationId, fork.conversationId]]);
    const [head] = await list(app, 'ConversationContextHeadLink', { conversation_id: fork.conversationId });
    const content = (await app.context.materialize(head.root_id)).segments.map((segment) => segment.content.toString('utf8')).join('\n');
    assert.match(content, /native tool admission fixture/);
    assert.doesNotMatch(content, /current native turn asks to fork itself/, 'the running Turn is never copied');
    assert.deepEqual(await list(app, 'Turn', { conversation_id: fork.conversationId, status: 'active' }), []);
    assert.equal((await list(app, 'ToolCall', { id: running.toolCallId }))[0].status !== 'terminal', true, 'the caller keeps running');
    const replay = await lifecycle.forkCompletedHistory({ sourceConversationId: conversationId, commandId: 'native-fork-tool-call' });
    assert.deepEqual([replay.conversationId, replay.deduplicated], [fork.conversationId, true]);
    // A permanent rejection of the same command (here a replay with other facts) never clears the
    // settings of the fork that command already committed.
    await assert.rejects(lifecycle.fork({ sourceConversationId: conversationId, messageId: message,
      expectedRevisionId: 'another-revision', commandId: 'native-fork-tool-call' }), /different source facts/);
    assert.deepEqual(cleared, [], 'a committed fork never clears its settings');
    request.close();
  });
});

test('frozen nativeAsync policy reaches recipe metadata only for opted-in tools', async () => {
  const host = {
    definitions: () => [
      { declaration: { name: 'native_probe', description: 'probe', parameters: { type: 'object' } } },
      { declaration: { name: 'plain_tool', description: 'plain', parameters: { type: 'object' }, metadata: { readonly: true } } },
      { declaration: { name: 'vendor_async', description: 'vendor', parameters: { type: 'object' }, metadata: { nativeAsync: true } } }
    ]
  };
  await withNativeApp('native-async-definitions', async (app, conversationId, turnId) => {
    const definitions = await app.toolDispatcher.definitions(turnId);
    const byName = new Map(definitions.map((definition) => [definition.name, definition]));
    assert.deepEqual(
      byName.get('native_probe')?.metadata,
      { nativeAsync: true },
      'the frozen policy opt-in must reach the recipe metadata'
    );
    assert.deepEqual(
      byName.get('plain_tool')?.metadata,
      { readonly: true },
      'an explicit false opt-out leaves declaration metadata untouched and never enables async'
    );
    assert.equal(
      byName.get('vendor_async')?.metadata,
      undefined,
      'a declaration-carried flag without policy opt-in never reaches the recipe'
    );
  }, host, {
    allowedTools: ['native_probe', 'plain_tool', 'vendor_async'],
    toolConfigs: {
      native_probe: { nativeAsync: true, config: {} },
      plain_tool: { nativeAsync: false, config: {} }
    }
  });
});

async function admitNativeCall(app, options) {
  const entry = nativeEntry(options.toolCallId, {
    toolName: options.toolName ?? 'read',
    arguments: options.arguments ?? { path: '/tmp/native-fixture' },
    providerCallId: options.providerCallId ?? `call-${options.toolCallId}`,
    providerOrdinal: options.providerOrdinal ?? 0,
    policy: options.policy ?? frozenPolicy()
  });
  await persistNativeCheckpoint(
    app,
    options.request,
    options.streamSeq,
    'native_tool_call',
    nativeItemCheckpoint(entry, { async: options.declaredAsync ?? true })
  );
  await app.runtime.effects.createToolCallBatch({
    ...batchInput(options.turnId, options.request.modelRequestId, options.messageId, entry, `admit-${options.toolCallId}`),
    streamIdentity: { ...options.request.identity, streamSeq: String(options.streamSeq) }
  });
  return entry;
}

function scheduleInput(turnId, modelRequestId, entry) {
  return {
    turnId,
    modelRequestId,
    toolCallId: entry.toolCallId,
    providerCallId: entry.providerCallId,
    toolName: entry.toolName,
    arguments: entry.arguments
  };
}

test('native scheduler shares the ordinary lane cap across per-item calls', async () => {
  const started = [];
  const gates = new Map();
  const host = {
    definitions: () => SCHEDULER_DEFINITIONS,
    async executeNoEffect(definition, input) {
      started.push(input.toolCallId);
      const gate = deferred();
      gates.set(input.toolCallId, gate);
      await gate.promise;
      return { ok: true, output: 'done' };
    }
  };
  await withNativeApp('native-schedule-ordinary-cap', async (app, conversationId, turnId) => {
    const effects = app.runtime.effects;
    const request = await createStreamingRequest(app, turnId, 'req-cap', schedulerRecipeTools(['read']));
    const modelRequestId = request.modelRequestId;
    const messageId = await insertAssistantMessage(app, modelRequestId, 'req-cap');
    const entries = [];
    for (let index = 0; index < 9; index += 1) {
      entries.push(await admitNativeCall(app, {
        turnId,
        request,
        messageId,
        toolCallId: `tool-call-cap-${index}`,
        streamSeq: index + 1,
        providerOrdinal: index
      }));
    }
    const tasks = entries.map((entry) =>
      app.toolDispatcher.scheduleAdmittedCall(scheduleInput(turnId, modelRequestId, entry))
    );
    const watch = watchScheduled(tasks);
    const allowedSettled = new Set();
    await untilScheduling(watch, allowedSettled, () => started.length === 8, 'ordinary lane admits exactly eight calls');
    assert.ok(!started.includes('tool-call-cap-8'), 'the ninth call waits for a lane slot');
    gates.get('tool-call-cap-0').resolve();
    allowedSettled.add(0);
    await tasks[0];
    await untilScheduling(watch, allowedSettled, () => started.includes('tool-call-cap-8'), 'a freed slot starts the queued ninth call');
    for (const [index, gate] of [...gates.entries()]) {
      if (index !== 'tool-call-cap-0') gate.resolve();
    }
    for (let index = 1; index < tasks.length; index += 1) allowedSettled.add(index);
    const results = await Promise.all(tasks);
    assert.ok(results.every((result) => result.status === 'succeeded'));
  }, host, { allowedTools: ['read', 'run_agent'] });
});

test('native scheduler preserves serial policy ordering across generations', async () => {
  const started = [];
  const gates = new Map();
  const host = {
    definitions: () => SCHEDULER_DEFINITIONS,
    async executeNoEffect(definition, input) {
      started.push(input.toolCallId);
      const gate = deferred();
      gates.set(input.toolCallId, gate);
      await gate.promise;
      return { ok: true, output: 'done' };
    }
  };
  await withNativeApp('native-schedule-serial', async (app, conversationId, turnId) => {
    const request = await createStreamingRequest(app, turnId, 'req-serial', schedulerRecipeTools(['read']));
    const modelRequestId = request.modelRequestId;
    const messageId = await insertAssistantMessage(app, modelRequestId, 'req-serial');
    const serialPolicy = { ...frozenPolicy(), schedulingMode: 'serial' };
    const specs = [
      { toolCallId: 'tool-call-seq-a', policy: frozenPolicy() },
      { toolCallId: 'tool-call-seq-s1', policy: serialPolicy },
      { toolCallId: 'tool-call-seq-b', policy: frozenPolicy() },
      { toolCallId: 'tool-call-seq-s2', policy: serialPolicy }
    ];
    const entries = [];
    for (const [index, spec] of specs.entries()) {
      entries.push(await admitNativeCall(app, {
        turnId,
        request,
        messageId,
        toolCallId: spec.toolCallId,
        streamSeq: index + 1,
        providerOrdinal: index,
        policy: spec.policy
      }));
    }
    const tasks = entries.map((entry) =>
      app.toolDispatcher.scheduleAdmittedCall(scheduleInput(turnId, modelRequestId, entry))
    );
    const watch = watchScheduled(tasks);
    const allowedSettled = new Set();
    await untilScheduling(watch, allowedSettled, () => started.length === 1, 'only the first parallel call runs before the serial point');
    assert.deepEqual(started, ['tool-call-seq-a']);
    gates.get('tool-call-seq-a').resolve();
    allowedSettled.add(0);
    await untilScheduling(watch, allowedSettled, () => started.length === 2, 'the serial call drains the earlier generation');
    assert.deepEqual(started, ['tool-call-seq-a', 'tool-call-seq-s1']);
    assert.ok(!started.includes('tool-call-seq-b'), 'a later parallel call waits for the serial call');
    gates.get('tool-call-seq-s1').resolve();
    allowedSettled.add(1);
    await untilScheduling(watch, allowedSettled, () => started.includes('tool-call-seq-b'), 'the next generation starts after the serial call');
    assert.ok(!started.includes('tool-call-seq-s2'), 'the next serial call drains the new generation first');
    gates.get('tool-call-seq-b').resolve();
    allowedSettled.add(2);
    await untilScheduling(watch, allowedSettled, () => started.includes('tool-call-seq-s2'), 'the drained serial call runs last');
    gates.get('tool-call-seq-s2').resolve();
    allowedSettled.add(3);
    const results = await Promise.all(tasks);
    assert.ok(results.every((result) => result.status === 'succeeded'));
  }, host, { allowedTools: ['read', 'run_agent'] });
});

test('native scheduler child admission releases the slot at the durable barrier', async () => {
  const started = [];
  const admissions = new Map();
  const gates = new Map();
  const host = {
    definitions: () => SCHEDULER_DEFINITIONS,
    async dispatchSpecial(definition, input, authority, signal, admission) {
      started.push(input.toolCallId);
      admissions.set(input.toolCallId, admission);
      const gate = deferred();
      gates.set(input.toolCallId, gate);
      await gate.promise;
      return {
        disposition: 'paused',
        toolCallId: input.toolCallId,
        reason: 'awaiting_child',
        resumeKey: input.toolCallId
      };
    }
  };
  await withNativeApp('native-schedule-child-barrier', async (app, conversationId, turnId) => {
    const request = await createStreamingRequest(app, turnId, 'req-child', schedulerRecipeTools(['run_agent']));
    const modelRequestId = request.modelRequestId;
    const messageId = await insertAssistantMessage(app, modelRequestId, 'req-child');
    const entries = [];
    for (let index = 0; index < 9; index += 1) {
      entries.push(await admitNativeCall(app, {
        turnId,
        request,
        messageId,
        toolCallId: `tool-call-child-${index}`,
        toolName: 'run_agent',
        arguments: { operation: 'spawn', taskName: `Inspect admission slot ${index}`, prompt: `Check child admission ${index}` },
        streamSeq: index + 1,
        providerOrdinal: index
      }));
    }
    const tasks = entries.map((entry) =>
      app.toolDispatcher.scheduleAdmittedCall(scheduleInput(turnId, modelRequestId, entry))
    );
    const watch = watchScheduled(tasks);
    const allowedSettled = new Set();
    await untilScheduling(watch, allowedSettled, () => started.length === 8, 'child starts are bounded by the shared admission barrier');
    assert.ok(!started.includes('tool-call-child-8'), 'the ninth child waits for an admission slot');
    assert.equal(typeof admissions.get('tool-call-child-0')?.release, 'function');
    admissions.get('tool-call-child-0').release();
    await untilScheduling(watch, allowedSettled, () => started.includes('tool-call-child-8'), 'releasing the durable barrier admits the queued child');
    assert.equal(gates.has('tool-call-child-0'), true, 'the released child keeps running past the barrier');
    for (const gate of gates.values()) gate.resolve();
    for (let index = 0; index < tasks.length; index += 1) allowedSettled.add(index);
    const results = await Promise.all(tasks);
    assert.ok(results.every((result) => result.disposition === 'paused'));
  }, host, { allowedTools: ['read', 'run_agent'] });
});
