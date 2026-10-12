import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { kernel, load, settings as providerSettings, sse, compatDelta } from './ci-model-provider-support.mjs';

const { emptyConversationContextHandleStateStep, readCurrentConversationContextHandleState } =
  load('backend/reliableKernel/conversationContextHandleState.js');

export async function openProviderRuntimeFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-ci-model-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  const settings = new Map([
    ['compatible', providerSettings('openai-compatible', { id: 'compatible' })],
    ['claude', providerSettings('claude', { id: 'claude' })],
    ['gemini', providerSettings('gemini', { id: 'gemini' })],
    ['responses', providerSettings('openai-responses', { id: 'responses' })]
  ]);
  const conversationProviders = new Map();
  const conversationRetries = new Map();
  const requests = [];
  let app;
  let registry;
  let activeRequest;
  let respond = () => sse([compatDelta({ content: 'reply' }), compatDelta({}, 'stop')]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const entry = { url: String(url), body: JSON.parse(String(init?.body ?? '{}')), init };
    if (activeRequest) activeRequest.wire = entry.body;
    return respond(entry, activeRequest?.request);
  };

  const open = async () => {
    registry = new kernel.ReliableLlmProviderRegistry({ loadProviderConfig: async id => settings.get(id) });
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: { async compile(request) {
        const selected = settings.get(conversationProviders.get(request.conversationId) ?? 'compatible');
        const retryPolicy = conversationRetries.get(request.conversationId) ?? {
          enabled: selected.retryOnError, maxRetries: selected.retryMaxAttempts
        };
        return { turnId: request.turnId, executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: selected.id, modelId: selected.model }) },
          authoritySnapshot: { content: JSON.stringify({ kind: 'effective-turn-authority',
            turnId: request.turnId, conversationId: request.conversationId,
            executorAgentId: request.executorAgentId,
            model: { providerConfigId: selected.id, provider: selected.provider, modelId: selected.model, retryPolicy },
            modelProfile: { compressionThresholdTokens: 100000, contextWindowTokens: 128000,
              tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
            toolPolicy: { id: 'tools-default', allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {} },
            systemPrompt: { id: 'prompt-default', text: '' },
            runtimeContext: { id: null, name: '', template: '' },
            workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
          }) }
        };
      } },
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('no MCP'); } },
      mcpPolicyGate: { async authorize() { assert.fail('no MCP'); } },
      attachmentSettings: { async loadGlobalSettings() {
        return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' };
      } },
      providers: { resolve(providerId) {
        return { providerId, async sendFullRequest(request, controls) {
          const entry = { request, events: [] };
          requests.push(entry);
          activeRequest = entry;
          try {
            return await registry.resolve(providerId).sendFullRequest(request, { ...controls,
              async onEvent(event) { entry.events.push(event); return controls.onEvent(event); }
            });
          } finally { activeRequest = undefined; }
        } };
      } },
      toolDispatcher: { definitions() { return []; }, async dispatch() { assert.fail('no tool can run'); } }
    });
  };

  const rows = async (domain, where = {}) => (await app.database.snapshotAll(
    kernel.DOMAIN_REPOSITORIES.domain(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 200 })
  )).snapshot;
  await open();
  let command = 0;
  const fixture = {
    get app() { return app; },
    authority, settings, requests, directory,
    setFetch(handler) { respond = handler; },
    provider(id) { return registry.resolve(id); },
    setProvider(conversationId, providerConfigId) { conversationProviders.set(conversationId, providerConfigId); },
    rows,
    async createConversation(id, providerConfigId = 'compatible') {
      conversationProviders.set(id, providerConfigId);
      const now = new Date().toISOString();
      await app.database.transaction([
        kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id, title: id, status: 'active', created_at: now, updated_at: now }),
        emptyConversationContextHandleStateStep(id, now),
        kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: `${id}-agent`,
          conversation_id: id, agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now })
      ]);
    },
    async restart() {
      await app.close();
      registry.dispose();
      load('backend/capabilities/providerParameterAdaptation.js').resetProviderRequestAdaptations();
      await open();
    },
    async input(conversationId, content, { retryPolicy } = {}) {
      if (retryPolicy) conversationRetries.set(conversationId, retryPolicy);
      return app.turns.input({ source: { kind: 'command', key: `${conversationId}-input-${++command}` },
        conversationId, leaseOwnerId: 'ci-provider-owner', hostBootId: app.database.hostBootId,
        leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), content });
    },
    async turn(conversationId, content, options) {
      const input = await fixture.input(conversationId, content, options);
      const [lease] = await rows('ExecutionLease', { turn_id: input.turnId });
      const result = await kernel.runWithExecutionLeaseFence({ id: lease.id, conversationId,
        turnId: input.turnId, ownerId: lease.owner_id, hostBootId: lease.host_boot_id,
        generation: BigInt(lease.generation) }, () => app.agentLoop.drive(input.turnId));
      assert.equal(result.terminalStatus, 'completed');
      return input.turnId;
    },
    async request(conversationId, turnId, key, { recipe = {} } = {}) {
      const [head] = await rows('ConversationContextHeadLink', { conversation_id: conversationId });
      const [frozen] = await rows('AuthoritySnapshot', { turn_id: turnId });
      const handles = await readCurrentConversationContextHandleState(app.database, app.contentStore, conversationId);
      return app.modelProvider.createModelRequest({ turnId, contextRootId: head.root_id,
        authoritySnapshotId: frozen.id, recipe: { kind: 'reliable-agent-turn', round: '1', tools: [],
          modelHandleCatalog: handles.catalog, contextHandleScope: { conversationId,
            rootId: handles.row.context_root_id, provenanceRevision: String(handles.row.provenance_revision),
            resetFence: String(handles.row.requires_native_reset) }, ...recipe }, idempotencyKey: key });
    },
    async close() {
      try { await app.close(); }
      finally {
        registry.dispose();
        globalThis.fetch = originalFetch;
        load('backend/capabilities/providerParameterAdaptation.js').resetProviderRequestAdaptations();
        await fs.rm(directory, { recursive: true, force: true });
      }
    }
  };
  return fixture;
}
