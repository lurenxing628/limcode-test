import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
export const load = file => require(path.join(compiled, file));
export const kernel = load('backend/reliableKernel/index.js');
export const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
export const gate = () => {
  const value = { settled: false };
  let done; value.promise = new Promise(resolve => { done = resolve; });
  value.resolve = result => { value.settled = true; value.value = result; done(result); };
  return value;
};
export const answer = text => ({ role: 'model', parts: [{ text }] });
const { emptyConversationContextHandleStateStep } = load('backend/reliableKernel/conversationContextHandleState.js');
const { preparedContentObjectSteps } = load('backend/reliableKernel/contentObjectTransaction.js');
const { ReliableChildAgentCoordinator } = load('backend/reliableKernel/childAgentCoordinator.js');
const { ReliableConversationRunner } = load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { ReliableConversationLifecycle } = load('backend/application/reliableKernel/conversationLifecycle.js');
const { createRuntimeDeliveryWakeHandler } = load('backend/application/reliableKernel/runtimeDeliveryWakeHandler.js');
const { LlmEventType } = load('backend/world/modules/llm/events.js');

/** The suite owns one real writer/reader worker. Only external settings and model responses are synthetic. */
export async function openDeliveryFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-delivery-suite-'));
  const root = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(root);
  let serial = 0, app, coordinator, runner;
  const now = () => new Date().toISOString();
  const configs = new Map(), modelProfiles = new Map(), environments = new Map(), observed = [];
  const configuration = {
    async resolveAgent() { return { agentId: 'agent-main', agentType: 'main' }; },
    async configurationClientState() { return {
      modelProfileScopeLinks: [...modelProfiles.keys()].map(scopeId => ({ scopeKind: 'conversation', scopeId })),
      conversationWorkEnvironmentLinks: [...environments.keys()].map(conversationId => ({ conversationId }))
    }; },
    mutations: {
      async initializeConversationModelProfile(input) { if (!modelProfiles.has(input.conversationId)) modelProfiles.set(input.conversationId, structuredClone(input)); return { created: true }; },
      async initializeConversationWorkEnvironment(id, environment) { environments.set(id, environment); },
      async clearConversationConfiguration(id) { modelProfiles.delete(id); environments.delete(id); }
    }
  };
  const authority = request => ({
    kind: 'effective-turn-authority', turnId: request.turnId, conversationId: request.conversationId, executorAgentId: request.executorAgentId,
    model: { providerConfigId: 'provider', provider: 'openai-compatible', modelId: 'model', retryPolicy: { enabled: false, maxRetries: 0 } },
    modelProfile: { contextWindowTokens: 128000, compressionThresholdTokens: 100000, tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
    toolPolicy: { id: 'delivery-tools', allowedTools: ['run_agent', 'read'], preset: 'custom', sourceConfigs: {},
      toolConfigs: { run_agent: { config: { maxChildAgentDepth: 3, maxConcurrentAgents: 4, maxAutomaticFollowups: 32, crossConversationCollaboration: true } } },
      ...(configs.get(request.conversationId) ?? {}) },
    planReviewPolicy: { mode: 'never' }, systemPrompt: { id: 'prompt', text: '' },
    runtimeContext: { id: null, name: '', template: '' },
    workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
  });
  const f = { directory, root, now, configs, modelProfiles, environments, observed, errors: [],
    get app() { return app; }, get coordinator() { return coordinator; }, get runner() { return runner; },
    model: async request => answer(`completed ${request.conversationId}`) };
  const dependencies = {
    holdRuntimeConvergence: true,
    authorityCompiler: { async compile(request) { return { turnId: request.turnId, executorAgentId: request.executorAgentId,
      executionPreset: { content: JSON.stringify({ providerConfigId: 'provider', modelId: 'model' }) },
      authoritySnapshot: { content: JSON.stringify(authority(request)) } }; } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('unexpected MCP'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
    providers: { resolve(providerId) { return { providerId, async sendFullRequest(request, controls) {
      const [record] = await f.rows('ModelRequest', { id: request.modelRequestId });
      const seen = { ...request, turnId: record.turn_id };
      let start;
      const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
        start(input, emit) { start = input; emit({ type: LlmEventType.Done, payload: { requestId: input.id } }); }, abort() {}, dispose() {}
      });
      await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, terminal: true, checkpointed: true }; } });
      observed.push({ ...seen, start });
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: await f.model(seen, start, controls.signal) });
    } }; } },
    toolDispatcher: { definitions() { return []; }, async dispatch() { assert.fail('unexpected model tool'); } }
  };
  app = await kernel.ReliableKernelApplication.open(root, dependencies);
  f.rows = async (domain, where = {}) => (await app.database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;
  f.get = async (domain, id) => (await app.database.snapshot([repo(domain).get(id)])).snapshot[0];
  f.id = label => `${label}-${++serial}`;
  f.addConversation = async (label, project) => {
    const id = f.id(label), at = now();
    await app.database.transaction([
      repo('Conversation').insert({ id, title: label, status: 'active', created_at: at, updated_at: at }),
      emptyConversationContextHandleStateStep(id, at),
      repo('AgentConversationLink').insert({ id: `${id}-agent`, conversation_id: id, agent_id: 'agent-main', role: 'default', created_at: at, updated_at: at }),
      ...(project ? kernel.projectFolderAssignmentSteps({ conversationId: id, folder: project, now: at }) : [])
    ]);
    return id;
  };
  f.source = async (conversationId, turnId, toolName = 'send_agent_message', args = {}) => {
    const toolCallId = f.id('tool');
    await app.runtime.effects.createToolCall({ source: { kind: 'internal', key: toolCallId }, toolCallId, turnId, toolName, arguments: args });
    return { kind: 'tool', turnId, toolCallId };
  };
  f.endTurn = async (turnId, terminalStatus = 'completed') => {
    if ((await f.get('Turn', turnId)).status === 'terminated') return;
    await app.database.transaction([repo('Turn').update(turnId, { status: 'terminated', terminal_at: now(), updated_at: now() }),
      repo('TurnTermination').insert({ id: f.id('termination'), turn_id: turnId, terminal_status: terminalStatus, reason: 'fixture completed', created_at: now() }),
      repo('ExecutionLease').deleteByUnique({ conversation_id: (await f.get('Turn', turnId)).conversation_id, turn_id: turnId })]);
  };
  f.scenario = async (label, budget = 32) => {
    const prefix = f.id(label), at = now();
    const ids = Object.fromEntries(['root', 'left', 'right', 'outsider'].map(name => [name, `${prefix}-${name}`]));
    const project = { uri: pathToFileURL(path.join(directory, prefix)).href, name: prefix };
    const settings = JSON.stringify({ toolPolicy: { allowedTools: ['run_agent'], toolConfigs: { run_agent: { config: { maxAutomaticFollowups: budget, crossConversationCollaboration: true } } } } });
    const content = await app.contentStore.prepare(app.database, settings, 'application/json');
    await app.database.transaction([
      ...preparedContentObjectSteps([content], 'delivery_suite_policy'),
      ...Object.entries(ids).flatMap(([name, id]) => [
        repo('Conversation').insert({ id, title: name, status: 'active', created_at: at, updated_at: at }),
        emptyConversationContextHandleStateStep(id, at),
        repo('AgentConversationLink').insert({ id: `${id}-agent`, conversation_id: id, agent_id: 'agent-main', role: 'default', created_at: at, updated_at: at }),
        ...kernel.projectFolderAssignmentSteps({ conversationId: id, folder: project, now: at }),
        repo('Turn').insert({ id: `${id}-turn`, conversation_id: id, status: name === 'right' ? 'terminated' : 'active', created_at: at, updated_at: at, terminal_at: name === 'right' ? at : null }),
        ...(name !== 'right' ? [repo('ExecutionLease').insert({ id: `${id}-lease`, conversation_id: id, turn_id: `${id}-turn`, owner_id: 'fixture-owner', host_boot_id: app.database.hostBootId, generation: 1n, acquired_at: at, expires_at: new Date(Date.now() + 600000).toISOString() })] : []),
        repo('AuthoritySnapshot').insert({ id: `${id}-authority`, turn_id: `${id}-turn`, content_object_id: content.metadata.id, created_at: at }),
        ...(name === 'right' ? [repo('TurnTermination').insert({ id: `${id}-done`, turn_id: `${id}-turn`, terminal_status: 'completed', reason: 'fixture idle', created_at: at })] : [])
      ]),
      ...['left', 'right'].flatMap(name => [
        repo('ChildExecution').insert({ id: `${ids[name]}-child`, child_conversation_id: ids[name], status: name === 'left' ? 'active' : 'idle', created_at: at, updated_at: at }),
        repo('ChildExecutionParentLink').insert({ id: `${ids[name]}-parent`, child_execution_id: `${ids[name]}-child`, source_tool_call_id: `${ids[name]}-spawn`, parent_child_execution_id: null, parent_turn_id: `${ids.root}-turn`, created_at: at }),
        repo('ChildExecutionTurnLink').insert({ id: `${ids[name]}-member`, child_execution_id: `${ids[name]}-child`, turn_id: `${ids[name]}-turn`, turn_seq: 1n, created_at: at })
      ])
    ]);
    const s = { ...ids, prefix, project, at, turn: name => `${ids[name]}-turn`,
      source: (name = 'left', toolName, args) => f.source(ids[name], `${ids[name]}-turn`, toolName, args),
      send: async (from, target, mode = 'message', text = 'peer data', extra = {}) => app.runtime.collaboration.send({
        source: await f.source(ids[from] ?? from, `${ids[from] ?? from}-turn`, extra.crossConversation ? 'send_conversation_message' : 'send_agent_message'),
        targetConversationId: ids[target] ?? target, mode, text, ...extra }) };
    return s;
  };
  f.admit = async (s, conversationId, turnId, deliveryId) => {
    const frozen = await f.get('AuthoritySnapshot', `${s.root}-authority`);
    const steps = await app.runtime.deliveries.prepareNextTurnDeliverySteps(conversationId, turnId, now(), deliveryId);
    await app.database.transaction([repo('Turn').insert({ id: turnId, conversation_id: conversationId, status: 'active', created_at: now(), updated_at: now(), terminal_at: null }),
      repo('ExecutionLease').insert({ id: `${turnId}-lease`, conversation_id: conversationId, turn_id: turnId, owner_id: 'fixture-owner', host_boot_id: app.database.hostBootId, generation: 1n, acquired_at: now(), expires_at: new Date(Date.now() + 600000).toISOString() }),
      repo('AuthoritySnapshot').insert({ id: `${turnId}-authority`, turn_id: turnId, content_object_id: frozen.content_object_id, created_at: now() }), ...steps]);
  };
  f.continuation = async (s, conversationId, turnId, deliveryId) => {
    const content = await app.contentStore.prepare(app.database, JSON.stringify({ version: 1, kind: 'runtime_continuation', sourceTurnId: null }), 'application/vnd.limcode.turn-intent+json');
    await app.database.transaction([...preparedContentObjectSteps([content], 'delivery_suite_intent'),
      repo('TurnIntent').insert({ id: `${turnId}-intent`, conversation_id: conversationId, turn_id: null, state: 'queued', created_at: now(), updated_at: now() }),
      repo('TurnIntentRevision').insert({ id: `${turnId}-revision`, intent_id: `${turnId}-intent`, revision_seq: 1n, content_object_id: content.metadata.id, created_at: now() }),
      repo('RuntimeDeliveryIntentLink').insert({ id: `${turnId}-delivery`, delivery_id: deliveryId, turn_intent_id: `${turnId}-intent`, created_at: now() })]);
    await f.admit(s, conversationId, turnId, deliveryId);
    await app.database.transaction([repo('TurnIntent').update(`${turnId}-intent`, { turn_id: turnId, state: 'admitted', updated_at: now() })]);
  };
  f.parentTurn = async (label, config) => {
    const conversationId = await f.addConversation(label);
    if (config) configs.set(conversationId, config);
    const result = await app.turns.input({ source: { kind: 'command', key: f.id('input') }, conversationId, content: label,
      leaseOwnerId: 'fixture-owner', hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 600000).toISOString() });
    return { conversationId, turnId: result.turnId };
  };
  f.spawn = async parent => {
    const source = await f.source(parent.conversationId, parent.turnId, 'run_agent', { operation: 'spawn', taskName: 'worker', prompt: 'Inspect' });
    const child = await app.runtime.children.spawn({ sourceToolCallId: source.toolCallId, childAgentId: 'agent-child', modelFallback: { providerConfigId: 'provider', model: 'model' },
      prompt: 'Inspect', completionPolicy: 'background', sourceSettlement: 'child_handle', leaseOwnerId: `child-driver:${app.database.hostBootId}`,
      leaseExpiresAt: new Date(Date.now() + 600000).toISOString(), leaseDurationMs: 600000 });
    await app.runtime.children.claimSpawnDispatch(child.effectIntentId);
    const receipt = await app.runtime.children.recordSpawnReceipt({ sourceKey: `fixture-spawn:${child.attemptId}`, attemptId: child.attemptId, outcome: 'succeeded', detail: { adapter: 'reliable-local-agent-loop' } });
    await app.runtime.children.reconcileSpawnReceipt(receipt.effectReceiptId);
    return child;
  };
  coordinator = new ReliableChildAgentCoordinator({ database: app.database, ...app.runtime, turns: app.turns, modelProvider: app.modelProvider, agentLoop: app.agentLoop,
    agents: { async resolve() { return { agentId: 'agent-child', agentType: 'worker' }; } },
    modelProfiles: { async initializeConversation() { return { created: true }; } }, deliveryWakeups: app.processDeliveries });
  f.lifecycle = new ReliableConversationLifecycle({ application: app, configuration });
  f.reopen = async () => {
    await f.deactivateRunner();
    await coordinator.dispose();
    await app.close();
    app = await kernel.ReliableKernelApplication.open(root, dependencies);
    f.lifecycle = new ReliableConversationLifecycle({ application: app, configuration });
  };
  f.activateRunner = () => {
    runner ??= new ReliableConversationRunner(app, 'delivery-suite-owner', error => { f.errors.push(error); });
    const wake = createRuntimeDeliveryWakeHandler({ application: () => app, conversations: () => runner, children: () => coordinator });
    app.processDeliveries.setWakeHandler(wake);
    return runner;
  };
  f.deactivateRunner = async () => { runner?.dispose(); await runner?.waitForIdle(); runner = undefined; app.processDeliveries.setWakeHandler(undefined); };
  f.until = async (probe, label) => {
    // No quiet sleeps: each retry yields to worker replies and the concrete pending operation.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) { if (f.errors.length) throw f.errors[0]; const result = await probe(); if (result) return result; await new Promise(resolve => setImmediate(resolve)); }
    assert.fail(label);
  };
  f.close = async () => { runner?.dispose(); await runner?.waitForIdle(); await coordinator.dispose(); await app.close(); await fs.rm(directory, { recursive: true, force: true }); };
  return f;
}
