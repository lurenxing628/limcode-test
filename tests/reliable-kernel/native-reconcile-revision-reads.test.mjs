import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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

const PROVIDER_ID = 'native-reconcile-provider';
const MODEL_ID = 'gpt-6-astra';
const MESSAGE_CONTENT_TYPE = 'application/vnd.limcode.message+json';
const capabilities = { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false, explicitCaching: true };
const syncDefinition = { name: 'native_probe', description: 'one synchronous native tool', parameters: { type: 'object' } };
const asyncDefinition = { name: 'native_async_probe', description: 'one asynchronous native tool',
  parameters: { type: 'object' }, metadata: { nativeAsync: true } };

const rows = async (app, domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain)
  .list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;

async function waitFor(predicate, label, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(`Timed out waiting for ${label}`);
}

/** The AgentLoop ToolCall identity of one native provider call (providerToolCallId). */
function toolCallIdFor(modelRequestId, providerOrdinal, providerCallId, name) {
  return `rk_tool_call_${createHash('sha256')
    .update(JSON.stringify([modelRequestId, String(providerOrdinal), providerCallId ?? name]))
    .digest('hex')
    .slice(0, 32)}`;
}

const outputItem = (responseId, ordinal) => ({ id: `item-${responseId}-${ordinal}`, ordinal, providerResponseId: responseId });

async function emitText(emit, responseId, ordinal, text) {
  await emit('output_delta', { type: 'text_delta', text, outputItem: outputItem(responseId, ordinal) });
  await emit('output_item_done', { type: 'output_item_done', outputItem: outputItem(responseId, ordinal) });
}

async function emitThought(emit, responseId, ordinal, text, thoughtSignature) {
  await emit('output_delta', { type: 'thought_delta', text, thoughtSignature, outputItem: outputItem(responseId, ordinal) });
  await emit('output_item_done', { type: 'thought_done', thoughtSignature, outputItem: outputItem(responseId, ordinal) });
}

async function emitCall(emit, responseId, ordinal, callId, { async = false } = {}) {
  await emit('output_item_done', {
    type: 'tool_calls',
    calls: [{ id: callId, ordinal, name: async ? asyncDefinition.name : syncDefinition.name,
      arguments: { callId }, ...(async ? { async: true } : {}) }],
    outputItem: outputItem(responseId, ordinal)
  });
}

function authorityFor(request) {
  return {
    turnId: request.turnId,
    executorAgentId: request.executorAgentId,
    executionPreset: { content: JSON.stringify({ providerConfigId: PROVIDER_ID, modelId: MODEL_ID }) },
    authoritySnapshot: { content: JSON.stringify({
      kind: 'effective-turn-authority',
      turnId: request.turnId,
      conversationId: request.conversationId,
      executorAgentId: request.executorAgentId,
      model: { providerConfigId: PROVIDER_ID, provider: 'openai-responses', modelId: MODEL_ID,
        baseUrl: 'https://native-reconcile.invalid/v1', openaiResponsesTransport: 'http',
        nativeResponses: { enabled: true, asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false },
        retryPolicy: { enabled: false, maxRetries: 0 } },
      modelProfile: { compressionThresholdTokens: 1000000, contextWindowTokens: 1200000,
        tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
      toolPolicy: { id: 'native-tools', allowedTools: [syncDefinition.name, asyncDefinition.name], preset: 'custom',
        toolConfigs: {}, sourceConfigs: {} },
      planReviewPolicy: { mode: 'never' },
      systemPrompt: { id: 'prompt-empty', text: '' },
      runtimeContext: { id: null, name: '', template: '' },
      workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
    }) }
  };
}

/** Streams one scripted native logical request over the real SQLite/CAS kernel, then verifies. */
async function withStreamedChain(name, script, verify) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-reconcile-revision-reads-'));
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  let app;
  const adapter = {
    providerId: PROVIDER_ID,
    async materializeNativeToolOutput(outputs) { return outputs; },
    async sendFullRequest(_request, controls) {
      let streamSeq = 0;
      const emit = (kind, content, extra = {}) => controls.onEvent({ kind, streamSeq: String(++streamSeq), content, ...extra });
      controls.native.onController({
        responseId: 'r-a',
        endLogicalRequest() {},
        async steer() { throw new Error('No steering in this fixture.'); },
        async submitToolResults() { throw new Error('This fixture never submits tool results into the chain.'); }
      });
      try {
        await script({ app, emit });
      } finally {
        controls.native.onController(undefined);
      }
    }
  };
  const settle = key => async (input) => (await app.runtime.effects.settleWithoutEffect({
    source: { kind: 'internal', key: `${key}:${input.toolCallId}` },
    toolCallId: input.toolCallId, status: 'succeeded', detail: { ok: true, callId: input.providerCallId }
  })).terminal;
  const dependencies = {
    authorityCompiler: { async compile(request) { return authorityFor(request); } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('unexpected MCP call'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
    providers: { resolve() { return adapter; } },
    toolDispatcher: {
      definitions() { return [syncDefinition, asyncDefinition]; },
      dispatch: settle('native-reconcile-ordinary'),
      scheduleAdmittedCall: settle('native-reconcile-admitted')
    }
  };
  try {
    app = await kernel.ReliableKernelApplication.open(root, dependencies);
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: name, title: 'Native reconcile reads', status: 'active', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: `${name}-agent`, conversation_id: name, agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now
      })
    ]);
    const started = await app.turns.input({ source: { kind: 'command', key: `${name}-input` }, conversationId: name,
      leaseOwnerId: 'fixture', hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 300000).toISOString(), content: 'Stream a native chain.' });
    const [lease] = await rows(app, 'ExecutionLease', { turn_id: started.turnId });
    const fence = { id: lease.id, conversationId: lease.conversation_id, turnId: lease.turn_id,
      ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation) };
    const outcome = await kernel.runWithExecutionLeaseFence(fence, () => app.agentLoop.drive(started.turnId))
      .catch(error => ({ terminalStatus: 'threw', error }));
    const [modelRequest] = await rows(app, 'ModelRequest', { turn_id: started.turnId });
    await verify({ app, conversationId: name, turnId: started.turnId, modelRequestId: modelRequest.id, outcome });
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** A session wired like AgentLoop's native dispatch, whose CAS reads are observed. */
function observedSession(app, { conversationId, turnId, modelRequestId }, reads) {
  const loop = app.agentLoop;
  const contentStore = new Proxy(loop.contentStore, {
    get(target, property) {
      if (property === 'read') {
        return async (metadata) => {
          reads.push(metadata.id);
          return target.read(metadata);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
  const unused = () => { throw new Error('reconcile must not dispatch or close native calls'); };
  return new NativeRequestSession({
    database: loop.database, contentStore, context: loop.context, turnOutput: loop.turnOutput,
    effects: loop.effects, tools: loop.tools, modelProvider: loop.modelProvider,
    conversationId, turnId, modelRequestId, providerId: PROVIDER_ID, modelId: MODEL_ID, capabilities,
    budget: { maxPhysicalResponses: 1000, maxOutputTokens: 1000000 },
    initialContextRootId: 'unused-root', modelHandleCatalog: {},
    resolveAdapter: unused, resolveDefinition: unused, resolveCallArguments: unused, freezePolicies: unused,
    dispatchCall: unused, closeAdmittedCall: unused,
    toolCallIdFor: (providerOrdinal, providerCallId, name) => toolCallIdFor(modelRequestId, providerOrdinal, providerCallId, name),
    now: () => new Date().toISOString()
  });
}

async function readJson(app, contentObjectId) {
  const [metadata] = await rows(app, 'ContentObject', { id: contentObjectId });
  return JSON.parse((await app.contentStore.read(metadata)).toString('utf8'));
}

/**
 * Reconciles a fresh session and proves it rebuilt exactly the durable item revisions, in chain
 * order, while never reading content that only a cumulative or final aggregate revision owns.
 */
async function assertReconcileReadsItemsOnly(app, ids, expectedKeys, { expectAggregate }) {
  const { turnId, modelRequestId } = ids;
  const sources = await rows(app, 'ToolCallSourceLink', { model_request_id: modelRequestId });
  for (const source of sources) {
    const [toolCall] = await rows(app, 'ToolCall', { id: source.tool_call_id });
    assert.equal(source.tool_call_id, toolCallIdFor(modelRequestId, source.provider_ordinal, source.provider_call_id,
      toolCall.tool_name), 'fixture ToolCall identity matches AgentLoop');
  }
  const messageId = kernel.assistantMessageIdFor(turnId, modelRequestId);
  const revisions = await rows(app, 'MessageRevision', { message_id: messageId });
  const byId = new Map(revisions.map(revision => [revision.id, revision]));
  const items = expectedKeys.map(key => byId.get(kernel.nativeItemRevisionId(turnId, modelRequestId, key)));
  const cumulative = expectedKeys.map(key => byId.get(kernel.nativeCumulativeRevisionId(turnId, modelRequestId, key)));
  const aggregate = byId.get(kernel.assistantMessageRevisionIdFor(turnId, modelRequestId));
  assert.ok(items.every(Boolean), 'every expected item has its item-only revision');
  assert.ok(cumulative.every(Boolean), 'every expected item has its cumulative projection revision');
  assert.equal(Boolean(aggregate), expectAggregate, 'final aggregate presence');
  assert.equal(revisions.length, expectedKeys.length * 2 + (aggregate ? 1 : 0), 'no other revision belongs to the Message');

  const itemParts = [];
  for (const revision of items) itemParts.push((await readJson(app, revision.content_object_id)).parts[0]);
  const reads = [];
  const session = observedSession(app, { conversationId: ids.conversationId, turnId, modelRequestId }, reads);
  try {
    await session.reconcile();
    assert.deepEqual(session.itemPartsOrdered.map(entry => entry.key), expectedKeys, 'items are rebuilt in chain order');
    assert.deepEqual(session.itemPartsOrdered.map(entry => entry.part), itemParts, 'rebuilt parts equal the item revisions');
    assert.equal(session.hasDurableChainProgress(), true);
  } finally {
    await session.dispose('handoff');
  }
  const itemContent = new Set(items.map(revision => revision.content_object_id));
  const projectionOnly = [...cumulative, ...(aggregate ? [aggregate] : [])]
    .map(revision => revision.content_object_id)
    .filter(id => !itemContent.has(id));
  assert.ok(projectionOnly.length >= expectedKeys.length - 1, 'the chain has cumulative content beyond the first item');
  for (const id of itemContent) assert.ok(reads.includes(id), `item content ${id} is read`);
  for (const id of projectionOnly) assert.ok(!reads.includes(id), `projection content ${id} is not read`);
  return itemParts;
}

test('reconcile of an interrupted mixed native chain rebuilds items without reading cumulative content', { timeout: 60000 }, async () => {
  await withStreamedChain('native-reconcile-interrupted', async ({ app, emit }) => {
    await emit('native_control', { type: 'response.created', responseId: 'r-a', capabilities });
    await emitThought(emit, 'r-a', 0, 'reasoning about the first step '.repeat(8), 'sig-A');
    await emitText(emit, 'r-a', 1, 'visible text before tools '.repeat(12));
    await emitCall(emit, 'r-a', 2, 'call-async-1', { async: true });
    await waitFor(async () => (await rows(app, 'ToolModelResult')).length >= 1, 'the async call settled');
    await emitCall(emit, 'r-a', 3, 'call-sync-1');
    await emitText(emit, 'r-a', 4, 'suffix after the calls');
    await emit('native_control', { type: 'response.completed', responseId: 'r-a', usage: { input_tokens: 10, output_tokens: 10 } });
    await emit('native_control', { type: 'response.created', responseId: 'r-b', capabilities });
    await emitText(emit, 'r-b', 0, 'the second response reuses ordinal zero '.repeat(6));
    await emitCall(emit, 'r-b', 1, 'call-async-2', { async: true });
    await emitThought(emit, 'r-b', 2, 'second reasoning item', 'sig-B');
    await emitText(emit, 'r-b', 3, 'last visible text');
    throw new Error('fixture provider failed in the middle of the chain');
  }, async ({ app, outcome, ...ids }) => {
    assert.notEqual(outcome.terminalStatus, 'completed');
    const parts = await assertReconcileReadsItemsOnly(app, ids, [
      'content:r-a:0', 'content:r-a:1', 'call:r-a:0', 'call:r-a:1', 'content:r-a:4',
      'content:r-b:0', 'call:r-b:0', 'content:r-b:2', 'content:r-b:3'
    ], { expectAggregate: false });
    assert.deepEqual(parts.filter(part => part.thought).map(part => part.thoughtSignature), ['sig-A', 'sig-B']);
    assert.deepEqual(parts.filter(part => part.functionCall).map(part => [part.id, part.functionCall.name, part.async === true]), [
      ['call-async-1', asyncDefinition.name, true],
      ['call-sync-1', syncDefinition.name, false],
      ['call-async-2', asyncDefinition.name, true]
    ]);
  });
});

test('reconcile of a completed two-response native chain skips cumulative and final aggregate content', { timeout: 60000 }, async () => {
  await withStreamedChain('native-reconcile-completed', async ({ emit }) => {
    const parts = [];
    await emit('native_control', { type: 'response.created', responseId: 'r-a', capabilities });
    for (let ordinal = 0; ordinal < 3; ordinal += 1) {
      const text = `first response item ${ordinal} `.repeat(10 + ordinal);
      await emitText(emit, 'r-a', ordinal, text);
      parts.push({ text, outputItem: outputItem('r-a', ordinal) });
    }
    await emit('native_control', { type: 'response.completed', responseId: 'r-a', usage: { input_tokens: 10, output_tokens: 10 } });
    await emit('native_control', { type: 'response.created', responseId: 'r-b', capabilities });
    await emitThought(emit, 'r-b', 0, 'final reasoning', 'sig-final');
    parts.push({ text: 'final reasoning', thought: true, thoughtSignature: 'sig-final', outputItem: outputItem('r-b', 0) });
    await emitText(emit, 'r-b', 1, 'final answer');
    parts.push({ text: 'final answer', outputItem: outputItem('r-b', 1) });
    const usage = { input_tokens: 10, output_tokens: 10, total_tokens: 20 };
    await emit('native_control', { type: 'response.completed', responseId: 'r-b', usage });
    await emit('completed', { role: 'model', parts }, { usage });
  }, async ({ app, outcome, ...ids }) => {
    assert.equal(outcome.terminalStatus, 'completed', String(outcome.error?.stack ?? ''));
    const parts = await assertReconcileReadsItemsOnly(app, ids, [
      'content:r-a:0', 'content:r-a:1', 'content:r-a:2', 'content:r-b:0', 'content:r-b:1'
    ], { expectAggregate: true });
    assert.equal(parts[3].thoughtSignature, 'sig-final');
    const messageId = kernel.assistantMessageIdFor(ids.turnId, ids.modelRequestId);
    const [current] = await rows(app, 'MessageCurrentRevisionLink', { message_id: messageId });
    assert.equal(current.revision_id, kernel.assistantMessageRevisionIdFor(ids.turnId, ids.modelRequestId),
      'the displayed revision is the final aggregate');
    const [displayed] = await rows(app, 'MessageRevision', { id: current.revision_id });
    const [displayedContent] = await rows(app, 'ContentObject', { id: displayed.content_object_id });
    assert.equal(displayedContent.content_type, MESSAGE_CONTENT_TYPE);
    assert.equal((await readJson(app, displayed.content_object_id)).parts.length, 5, 'the display keeps the whole chain');
  });
});
