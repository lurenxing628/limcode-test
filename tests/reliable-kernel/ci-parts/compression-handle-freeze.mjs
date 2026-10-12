import assert from 'node:assert/strict';

import fs from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import { createRequire } from 'node:module';

import test from 'node:test';

const require = createRequire(import.meta.url);

const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? process.env.LIMCODE_COMPILED_ROOT ?? 'dist/extension');

const load = file => require(path.join(compiled, file));

const kernel = load('backend/reliableKernel/index.js');

const { emptyConversationContextHandleStateStep } = load('backend/reliableKernel/conversationContextHandleState.js');

const {
  CURRENT_MODEL_HANDLE_IDENTITY_CONTRACT_REVISION, buildModelHandleCatalog, modelHandleRef, modelHandleTarget
} = load('backend/reliableKernel/modelHandleCatalog.js');

const { readConversationContextHandleCatalog, rebuildHistoricalConversationContextHandleState } = load('backend/reliableKernel/conversationChildHandles.js');

const { compactRequestForCompressionPlanning } = load('backend/reliableKernel/llmCapabilityProviderAdapter.js');

const { previewCompressionSourceReplay } = load('backend/reliableKernel/compressionRebuildPreview.js');

const { createLlmProviderCapability } = load('backend/capabilities/llmProvider.js');

const capabilities = load('shared/modelCapabilities.js');

const targets = { processId: 'process-hidden', nextOutputHandle: 'rk-process-output:hidden-page', workEnvironmentId: 'work-env-hidden' };

const message = (segmentId, text, segmentKind = 'message') => ({ segmentId, segmentKind, messageRole: 'user',
  contentType: 'application/vnd.limcode.message+json', content: JSON.stringify({ role: 'user', parts: [{ text }] }) });

const nativeState = { role: 'model', parts: [{ providerContext: {
  provider: 'openai', format: 'openai-responses', itemType: 'compaction',
  rawItem: { type: 'compaction', id: 'cmp_hidden', encrypted_content: 'opaque-historical-state' }
} }] };

function request(method, context, catalog, sourceContext, sourceReplay = false) {
  return {
    kind: 'full-model-request', modelRequestId: `freeze-${method}`, conversationId: 'history', attemptSeq: '1', socketGeneration: '1',
    providerId: 'provider', modelId: 'model', authoritySnapshot: {
      model: { providerConfigId: 'provider', provider: 'openai-responses', modelId: 'model' }, toolPolicy: { allowedTools: [] },
      compression: { config: { id: 'compression', kind: method, trigger: { mode: 'manual' }, llmSummary: { targetTokens: 8000 } },
        provider: { providerConfigId: 'provider', provider: 'openai-responses', modelId: 'model' } }
    },
    recipe: { kind: 'reliable-context-compression', trigger: 'manual', sourceSegmentCount: context.length,
      compressionMethodKind: method, ...(method !== 'provider_native' ? { effectiveSummaryMaxTokens: 8000 } : {}),
      ...(catalog === undefined ? {} : { modelHandleCatalog: catalog }), ...(sourceReplay ? { sourceReplay: 'immutable_provenance' } : {}) },
    context, ...(sourceContext ? { compressionSourceContext: sourceContext } : {}), attachmentCatalogState: { catalog: [], placements: [] }
  };
}

async function summarize(compact) {
  const capability = createLlmProviderCapability({ settings: async () => { throw new Error('This regression must not call an external model'); } });
  try {
    return await new Promise((resolve, reject) => capability.compact({
      id: compact.id, blockId: compact.blockId, conversationId: compact.conversationId,
      methodKind: 'deterministic_summary', methodConfigSnapshot: { id: 'deterministic', kind: 'deterministic_summary',
        trigger: { mode: 'manual' }, llmSummary: { targetTokens: 8000 } }, contents: compact.contents,
      ...(compact.priorSummaryContents ? { priorSummaryContents: compact.priorSummaryContents } : {})
    }, event => {
      if (event.type === 'llm:compactDone') resolve(event.payload.result.contents);
      if (event.type === 'llm:compactError') reject(new Error(event.payload.message));
    }));
  } finally { capability.dispose(); }
}

async function withProductionSource(method, oldNative, run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'compression-handle-freeze-'));
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  const provider = { providerConfigId: 'freeze-provider', provider: 'openai-responses', modelId: 'gpt-5.5', baseUrl: 'https://freeze.invalid/v1' };
  const resolved = capabilities.resolveModelCapabilities({ ...provider, transport: 'http' });
  const modelCapabilities = { ...resolved, nativeCompaction: { kind: 'openai_responses', availability: 'verified', reason: 'fixture' } };
  const executionPlan = capabilities.resolveCompressionExecutionPlan({ kind: method, fallbacks: [] }, modelCapabilities);
  const summaryReasoning = capabilities.resolveSummaryReasoning({ mode: 'provider_default', capabilities: modelCapabilities });
  const authorityDocument = input => ({
    kind: 'effective-turn-authority', turnId: input.turnId, conversationId: input.conversationId, executorAgentId: input.executorAgentId,
    model: { providerConfigId: provider.providerConfigId, provider: provider.provider, modelId: provider.modelId },
    modelProfile: { compressionThresholdTokens: 150000, contextWindowTokens: 200000, tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
    compression: { enabled: true, methodKind: method, executionPlan, thresholdTokens: 150000,
      config: { id: `freeze-${method}`, name: method, kind: method,
        trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: 150000 }, llmSummary: { targetTokens: 8000 } },
      provider: { ...provider, capabilities: modelCapabilities, summaryReasoning, contextWindowTokens: 200000, maxOutputTokens: 16000 } },
    toolPolicy: { id: 'tools', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
    systemPrompt: { id: 'prompt', text: '' }, runtimeContext: { id: null, name: '', template: '' },
    workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
  });
  const sent = [];
  let app;
  try {
    app = await kernel.ReliableKernelApplication.open(root, {
      authorityCompiler: { async compile(input) { return { turnId: input.turnId, executorAgentId: input.executorAgentId,
        executionPreset: { content: JSON.stringify({ providerConfigId: provider.providerConfigId, modelId: provider.modelId }) },
        authoritySnapshot: { content: JSON.stringify(authorityDocument(input)) } }; } },
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('no MCP'); } },
      mcpPolicyGate: { async authorize() { assert.fail('no MCP authorization'); } },
      attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
      providers: { resolve(providerId) { return { providerId, async sendFullRequest(input, controls) {
        const compact = compactRequestForCompressionPlanning(input);
        sent.push({ request: input, compact });
        await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { type: 'compression_result',
          contents: method === 'provider_native' ? [nativeState] : await summarize(compact) } });
      } }; } },
      toolDispatcher: { definitions() { return []; }, async dispatch() { assert.fail('no tool effects'); } }
    });
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'history', title: 'Old compressed source', status: 'active', created_at: now, updated_at: now }),
      emptyConversationContextHandleStateStep('history', now),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'history-agent', conversation_id: 'history', agent_id: 'freeze-agent', role: 'default', created_at: now, updated_at: now })
    ]);
    const started = await app.turns.input({ source: { kind: 'command', key: 'original' }, conversationId: 'history',
      leaseOwnerId: 'freeze-owner', hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120000).toISOString(),
      content: 'Run the old background process.' });
    const rows = async (domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
      where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;
    // Reproduce a committed tool result that predates frozen context catalogs. Canonical tool
    // results are projected; ordinary user text intentionally remains verbatim.
    const [authority] = await rows('AuthoritySnapshot', { turn_id: started.turnId });
    const producerRoot = await app.context.currentHeadRootId('history');
    const producerContent = { role: 'model', parts: [{ id: 'old-provider-call',
      functionCall: { name: 'bash', args: { mode: 'start', command: 'old-background-command' } } }] };
    const producerRecipe = await app.contentStore.ingest(app.database, JSON.stringify({ kind: 'reliable-agent-turn',
      round: '1', attachmentCatalogState: { catalog: [], placements: [] } }), 'application/vnd.limcode.model-request-recipe+json');
    const producerCheckpoint = await app.contentStore.ingest(app.database,
      JSON.stringify({ kind: 'completed', streamSeq: '1', content: producerContent }), 'application/vnd.limcode.model-stream-checkpoint+json');
    // Import the complete published producer aggregate; its immutable recipe intentionally has no catalog.
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Operation').insertHistoricalCopy({ id: 'old-producer-operation',
        owner_kind: 'model_request', owner_id: 'old-producer', operation_seq: 1n, tool_call_id: null,
        status: 'completed', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('Attempt').insertHistoricalCopy({ id: 'old-producer-attempt',
        operation_id: 'old-producer-operation', attempt_seq: 1n, status: 'completed',
        created_at: now, updated_at: now, completed_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('ModelRequest').insertHistoricalCopy({ id: 'old-producer',
        turn_id: started.turnId, request_seq: 1n, status: 'terminal', terminal_state: 'completed',
        provider_id: provider.providerConfigId, model_id: provider.modelId, context_window_tokens: 200000n,
        compression_threshold_tokens: 150000n, estimated_context_tokens: 100n, authority_snapshot_id: authority.id,
        settings_snapshot_object_id: null, recipe_object_id: producerRecipe.id, usage_json: null,
        stream_stats_json: { attemptSeq: '1', socketGeneration: '1', retryReason: null }, created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('ModelContextProjection').insert({ id: 'old-producer-projection',
        owner_kind: 'model_request', owner_id: 'old-producer', root_id: producerRoot, purpose: 'provider-request', created_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('ModelStreamCheckpoint').insertHistoricalCopy({ id: 'old-producer-checkpoint',
        model_request_id: 'old-producer', attempt_seq: 1n, socket_generation: 1n, stream_seq: 1n,
        checkpoint_kind: 'terminal_summary', content_object_id: producerCheckpoint.id, created_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('ModelStreamFence').insertHistoricalCopy({ id: 'old-producer-fence',
        model_request_id: 'old-producer', attempt_seq: 1n, socket_generation: 1n, terminal_stream_seq: 1n,
        outcome: 'completed', created_at: now })
    ]);
    const producerMessage = await app.turnOutput.appendAssistantMessage({ turnId: started.turnId,
      modelRequestId: 'old-producer', sourceKey: 'old-producer', content: JSON.stringify(producerContent) });
    const argumentsObject = await app.contentStore.ingest(app.database, JSON.stringify({ mode: 'start', command: 'old-background-command' }), 'application/json');
    const resultObject = await app.contentStore.ingest(app.database,
      JSON.stringify({ ...targets, status: 'background_started', hasMore: true }), 'application/json');
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Message').insert({ id: 'old-tool-message', created_at: now, updated_at: now, deleted_at: null }),
      kernel.DOMAIN_REPOSITORIES.domain('MessageRevision').insert({ id: 'old-tool-revision', message_id: 'old-tool-message',
        revision_seq: 1n, role: 'tool', content_object_id: resultObject.id, created_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').insert({ id: 'old-tool-current',
        message_id: 'old-tool-message', revision_id: 'old-tool-revision', updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').insertWithNextSequence({ id: 'old-tool-membership',
        conversation_id: 'history', message_id: 'old-tool-message', created_at: now }, { column: 'message_seq', scope: { conversation_id: 'history' } }),
      kernel.DOMAIN_REPOSITORIES.domain('MessageTurnLink').insert({ id: 'old-tool-turn-link', turn_id: started.turnId,
        message_id: 'old-tool-message', role: 'tool_result', created_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('ToolCall').insert({ id: 'old-tool-call', turn_id: started.turnId, call_seq: 1n,
        tool_name: 'bash', status: 'terminal', arguments_object_id: argumentsObject.id, created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('ToolCallSourceLink').insert({ id: 'old-tool-source',
        tool_call_id: 'old-tool-call', model_request_id: 'old-producer', message_id: producerMessage.messageId,
        provider_call_id: 'old-provider-call', provider_ordinal: 0n, batch_id: 'old-tool-batch', batch_ordinal: 0n,
        thought_signature: null, created_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('ToolModelResult').insert({ id: 'old-tool-result', tool_call_id: 'old-tool-call',
        message_revision_id: 'old-tool-revision', created_at: now })
    ]);
    await app.context.appendToolPair({ conversationId: 'history', toolCallId: 'old-tool-call',
      toolModelResultId: 'old-tool-result', providerCallId: 'old-provider-call' });
    const authorityObject = (await rows('ContentObject', { id: authority.content_object_id }))[0];
    const document = JSON.parse((await app.contentStore.read(authorityObject)).toString('utf8'));
    const originalRoot = await app.context.currentHeadRootId('history');
    const compressed = await app.compression.create({ conversationId: 'history', headRootId: originalRoot,
      authoritySnapshotId: authority.id, compressSegmentCount: (await app.context.materializeStructure(originalRoot)).records.length,
      title: 'Published summary without a frozen context catalog',
      idempotencyKey: 'published-summary', summary: oldNative ? [nativeState] : [{ role: 'user', parts: [{ text: 'Old summary omitted canonical identities.' }] }] });
    await run({ app, rows, sent, document, turnId: started.turnId, authoritySnapshotId: authority.id, headRootId: compressed.rootId });
  } finally {
    if (app) await app.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function registerCases(test) {
const scenario={method:'llm_summary',replay:false,oldNative:true,label:'expanded source freeze'};
test(`production ${scenario.label} freezes expanded P/O/W before actual dispatch`, { timeout: 60000 }, async () => {
    await withProductionSource(scenario.method, scenario.oldNative, async ({ app, rows, sent, document, turnId, authoritySnapshotId, headRootId }) => {
      if (scenario.replay) {
        const before = (await app.database.snapshot([kernel.DOMAIN_REPOSITORIES.domain('Conversation').get('history')])).snapshotCommitSeq;
        const preview = await previewCompressionSourceReplay({ database: app.database, contentStore: app.contentStore,
          conversationId: 'history', rootId: headRootId, authority: document });
        assert.equal(preview.outcome.kind, 'ready', JSON.stringify(preview));
        assert.equal((await app.database.snapshot([kernel.DOMAIN_REPOSITORIES.domain('Conversation').get('history')])).snapshotCommitSeq, before);
        assert.equal(sent.length, 0, 'preview neither dispatches nor persists provisional identities');
      }
      const result = await app.compressionCoordinator.coordinate({ turnId, authoritySnapshotId, headRootId, trigger: 'manual', compressSegmentCount: 1,
        ...(scenario.replay ? { sourceReplay: 'immutable_provenance' } : {}) });
      assert.equal(result.status, 'compressed', JSON.stringify(result));
      assert.equal(sent.length, 1);
      const catalog = sent[0].request.recipe.modelHandleCatalog;
      for (const [kind, target] of [['process', targets.processId], ['cursor', targets.nextOutputHandle], ['workEnvironment', targets.workEnvironmentId]]) {
        const ref = modelHandleRef(catalog, kind, target);
        assert.ok(ref, `${kind} is frozen before the adapter renders original source`);
        assert.ok(JSON.stringify(sent[0].compact).includes(ref), `${ref} appears in actual projection`);
      }
      const [storedRequest] = await rows('ModelRequest', { id: sent[0].request.modelRequestId });
      const [storedObject] = await rows('ContentObject', { id: storedRequest.recipe_object_id });
      const storedRecipe = JSON.parse((await app.contentStore.read(storedObject)).toString('utf8'));
      assert.deepEqual(storedRecipe.modelHandleCatalog, catalog, 'the durable CAS recipe is the dispatched identity authority');

      const input = { ...sent[0].request, context: sent[0].request.context.map(item => ({ ...item })), compressionSourceContext: sent[0].request.compressionSourceContext?.map(item => ({ ...item })) };
      const sourceItem = input.compressionSourceContext?.[0] ?? input.context[0];
      const sourceText = sourceItem.content; let sourceReads = 0;
      Object.defineProperty(sourceItem, 'content', { enumerable: true, get() { sourceReads++; return sourceText; } });
      const adapter = new kernel.LlmCapabilityFullRequestAdapter(input.providerId, {
        compact(request, emit) { emit({ type: 'llm:compactDone', payload: { requestId: request.id, result: { id: 'prepared', contents: [{role:'user',parts:[{text:'summary'}]}] } } }); },
        start() { throw new Error('compression must not start ordinary chat'); }, abort() {}, dispose() {}
      });
      const prepared = adapter.prepareFullRequest(input); const readsAtPreparation = sourceReads;
      assert.ok(readsAtPreparation > 0);
      await prepared.send({ async onEvent() { return { accepted:true,checkpointed:true,terminal:true }; } });
      assert.equal(sourceReads, readsAtPreparation, 'budget and send share the frozen projection');

      const restored = await readConversationContextHandleCatalog(app.database, app.contentStore, 'history');
      const next = buildModelHandleCatalog([{ processId: 'process-next', nextOutputHandle: 'rk-process-output:next-page', workEnvironmentId: 'work-env-next' }], restored);
      for (const [kind, oldTarget, newTarget] of [['process', targets.processId, 'process-next'],
        ['cursor', targets.nextOutputHandle, 'rk-process-output:next-page'], ['workEnvironment', targets.workEnvironmentId, 'work-env-next']]) {
        assert.notEqual(modelHandleRef(next, kind, oldTarget), modelHandleRef(next, kind, newTarget));
        assert.equal(modelHandleRef(next, kind, oldTarget), modelHandleRef(catalog, kind, oldTarget));
      }
    });
  });
}

export { registerCases };
