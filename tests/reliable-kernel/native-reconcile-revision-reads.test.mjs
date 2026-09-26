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

const PROVIDER_ID = 'native-reconcile-provider';
const MODEL_ID = 'gpt-6-astra';
const RESPONSE_ID = 'r1';
const ITEM_COUNT = 6;
const capabilities = { asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false, explicitCaching: true };

const rows = async (app, domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain)
  .list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;

function itemText(index) {
  return `item ${index} `.padEnd(96 + index * 16, String.fromCharCode(97 + index));
}

function adapterFor(ending) {
  return {
    providerId: PROVIDER_ID,
    async materializeNativeToolOutput(outputs) { return outputs; },
    async sendFullRequest(_request, controls) {
      let streamSeq = 0;
      const emit = (kind, content, extra = {}) => controls.onEvent({ kind, streamSeq: String(++streamSeq), content, ...extra });
      controls.native?.onController?.({
        responseId: RESPONSE_ID,
        connectionGeneration: 1,
        streamId: undefined,
        async steer() { throw new Error('No steering in this fixture.'); },
        async submitToolResults() { throw new Error('No tool results in this fixture.'); },
        endLogicalRequest() {}
      });
      try {
        await emit('native_control', { type: 'response.created', responseId: RESPONSE_ID, capabilities });
        const parts = [];
        for (let ordinal = 0; ordinal < ITEM_COUNT; ordinal += 1) {
          const outputItem = { id: `item-${ordinal}`, ordinal, providerResponseId: RESPONSE_ID };
          await emit('output_delta', { type: 'text_delta', text: itemText(ordinal), outputItem });
          await emit('output_item_done', { type: 'output_item_done', outputItem });
          parts.push({ text: itemText(ordinal), outputItem });
        }
        if (ending === 'interrupted') throw new Error('fixture provider failed after streaming every item');
        const usage = { input_tokens: 80, output_tokens: ITEM_COUNT, total_tokens: 80 + ITEM_COUNT };
        await emit('native_control', { type: 'response.completed', responseId: RESPONSE_ID, usage });
        await emit('completed', { role: 'model', parts }, { usage });
      } finally {
        controls.native?.onController?.(undefined);
      }
    }
  };
}

function dependencies(adapter) {
  return {
    authorityCompiler: {
      async compile(request) {
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
              nativeResponses: { enabled: true }, retryPolicy: { enabled: false, maxRetries: 0 } },
            modelProfile: { compressionThresholdTokens: 1000000, contextWindowTokens: 1200000,
              tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
            toolPolicy: { id: 'tools-none', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
            systemPrompt: { id: 'prompt-empty', text: '' },
            runtimeContext: { id: null, name: '', template: '' },
            workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
          }) }
        };
      }
    },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('unexpected MCP call'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
    providers: { resolve() { return adapter; } },
    toolDispatcher: {
      definitions() { return []; },
      async dispatch() { throw new Error('unexpected tool dispatch'); },
      async scheduleAdmittedCall() { throw new Error('unexpected tool admission'); }
    }
  };
}

async function withStreamedChain(ending, verify) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-reconcile-revision-reads-'));
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  let app;
  try {
    app = await kernel.ReliableKernelApplication.open(root, dependencies(adapterFor(ending)));
    const conversationId = `native-reconcile-${ending}`;
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId, title: 'Native reconcile reads', status: 'active', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: `${conversationId}-agent`, conversation_id: conversationId, agent_id: 'agent-main', role: 'default',
        created_at: now, updated_at: now
      })
    ]);
    const started = await app.turns.input({ source: { kind: 'command', key: `${conversationId}-input` }, conversationId,
      leaseOwnerId: 'fixture', hostBootId: app.database.hostBootId,
      leaseExpiresAt: new Date(Date.now() + 300000).toISOString(), content: 'Stream items.' });
    const [lease] = await rows(app, 'ExecutionLease', { turn_id: started.turnId });
    const fence = { id: lease.id, conversationId: lease.conversation_id, turnId: lease.turn_id,
      ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation) };
    const outcome = await kernel.runWithExecutionLeaseFence(fence, () => app.agentLoop.drive(started.turnId))
      .catch(error => ({ terminalStatus: 'threw', error }));
    const [modelRequest] = await rows(app, 'ModelRequest', { turn_id: started.turnId });
    await verify({ app, conversationId, turnId: started.turnId, modelRequestId: modelRequest.id, outcome });
  } finally {
    await app?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** A session wired exactly like AgentLoop's native dispatch, whose CAS reads are observed. */
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
    dispatchCall: unused, toolCallIdFor: unused, closeAdmittedCall: unused,
    now: () => new Date().toISOString()
  });
}

async function classifiedRevisions(app, turnId, modelRequestId) {
  const messageId = kernel.assistantMessageIdFor(turnId, modelRequestId);
  const revisions = await rows(app, 'MessageRevision', { message_id: messageId });
  const keys = Array.from({ length: ITEM_COUNT }, (_, ordinal) => `content:${RESPONSE_ID}:${ordinal}`);
  const byId = new Map(revisions.map(revision => [revision.id, revision]));
  const items = keys.map(key => byId.get(kernel.nativeItemRevisionId(turnId, modelRequestId, key)));
  const cumulative = keys.map(key => byId.get(kernel.nativeCumulativeRevisionId(turnId, modelRequestId, key)));
  const aggregate = byId.get(kernel.assistantMessageRevisionIdFor(turnId, modelRequestId));
  assert.ok(items.every(Boolean), 'every streamed item has its item-only revision');
  assert.ok(cumulative.every(Boolean), 'every streamed item has its cumulative projection revision');
  assert.equal(revisions.length, ITEM_COUNT * 2 + (aggregate ? 1 : 0), 'no other revision belongs to the Message');
  return { keys, items, cumulative, aggregate };
}

for (const ending of ['completed', 'interrupted']) {
  test(`reconcile of a ${ending} native chain rebuilds items without reading cumulative or aggregate content`, { timeout: 30000 }, async () => {
    await withStreamedChain(ending, async ({ app, conversationId, turnId, modelRequestId, outcome }) => {
      if (ending === 'completed') assert.equal(outcome.terminalStatus, 'completed');
      else assert.notEqual(outcome.terminalStatus, 'completed');
      const { keys, items, cumulative, aggregate } = await classifiedRevisions(app, turnId, modelRequestId);
      assert.equal(Boolean(aggregate), ending === 'completed', 'only the completed chain has a final aggregate');

      const reads = [];
      const session = observedSession(app, { conversationId, turnId, modelRequestId }, reads);
      await session.reconcile();

      assert.deepEqual(session.itemPartsOrdered.map(entry => entry.key), keys, 'items are rebuilt in chain order');
      assert.deepEqual(session.itemPartsOrdered.map(entry => entry.part.text), keys.map((_, ordinal) => itemText(ordinal)));
      assert.equal(session.hasDurableChainProgress(), true);
      const itemContent = new Set(items.map(revision => revision.content_object_id));
      const projectionOnly = [...cumulative, ...(aggregate ? [aggregate] : [])]
        .map(revision => revision.content_object_id)
        .filter(id => !itemContent.has(id));
      assert.ok(projectionOnly.length >= ITEM_COUNT - 1, 'the fixture has cumulative content beyond the first item');
      for (const id of itemContent) assert.ok(reads.includes(id), `item content ${id} is read`);
      for (const id of projectionOnly) assert.ok(!reads.includes(id), `projection content ${id} is not read`);
      assert.equal(new Set(reads.filter(id => itemContent.has(id))).size, ITEM_COUNT);
    });
  });
}
