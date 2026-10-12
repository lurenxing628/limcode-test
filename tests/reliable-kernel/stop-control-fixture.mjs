import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
export const load = file => require(path.join(compiled, file));
export const kernel = load('backend/reliableKernel/index.js');
export const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
export const answer = text => ({ role: 'model', parts: [{ text }] });
export const call = (id, name, args) => ({ id, functionCall: { name, args } });
export const gate = () => {
  let release;
  const value = { settled: false, promise: new Promise(resolve => { release = resolve; }) };
  value.resolve = result => { value.settled = true; release(result); };
  return value;
};
const { emptyConversationContextHandleStateStep } = load('backend/reliableKernel/conversationContextHandleState.js');
const { ReliableChildAgentCoordinator } = load('backend/reliableKernel/childAgentCoordinator.js');
const { ReliableConversationRunner } = load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { createRuntimeDeliveryWakeHandler } = load('backend/application/reliableKernel/runtimeDeliveryWakeHandler.js');
const { askUserTool } = load('backend/world/modules/tools/definitions/askUser/index.js');
const { runAgentTool } = load('backend/world/modules/tools/definitions/runAgent/index.js');
const { submitPlanTool } = load('backend/world/modules/tools/definitions/submitPlan/index.js');
const { createCommandTool } = load('backend/world/modules/tools/definitions/command/index.js');
const bashTool = createCommandTool({ toolName: 'bash', description: 'Run a fixture command.' });

const mcpTool = (name, guarded = false) => ({
  execution: 'runtime',
  declaration: { name, description: name, parameters: { type: 'object', properties: {} },
    source: { kind: 'mcp', sourceId: 'fixture', sourceName: 'fixture', originalToolName: name },
    metadata: { category: 'general', scope: 'general', riskLevel: 'read', readonly: true, defaultEnabled: true,
      ...(guarded ? { defaultAutoApproveExecution: false } : {}) } },
  async execute() { assert.fail('MCP must execute through the real effect dispatcher'); }
});

/** Main and peer hosts use the same real control plane; only external settings/model/MCP replies are scripted. */
export async function openStopHost(rootPath, { label = 'stop-suite', directory } = {}) {
  let serial = 0, coordinator;
  const now = () => new Date().toISOString();
  const f = { rootPath, directory, now, errors: [], modelCalls: [], mcpCalls: [],
    id: name => `${label}-${name}-${++serial}`,
    model: async request => answer(`completed ${request.conversationId}`),
    mcpHandler: () => new Promise(() => {}) };
  const authority = request => ({
    kind: 'effective-turn-authority', turnId: request.turnId, conversationId: request.conversationId, executorAgentId: request.executorAgentId,
    model: { providerConfigId: 'provider', provider: 'openai-compatible', modelId: 'model', retryPolicy: { enabled: false, maxRetries: 0 } },
    modelProfile: { contextWindowTokens: 128000, compressionThresholdTokens: 100000, tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
    toolPolicy: { id: 'stop-tools', allowedTools: ['ask_user', 'submit_plan', 'run_agent', 'bash'], preset: 'custom',
      sourceConfigs: { fixture: { enabled: true } },
      toolConfigs: { run_agent: { config: { maxChildAgentDepth: 3, maxConcurrentAgents: 8 } } } },
    planReviewPolicy: { mode: 'optional' }, systemPrompt: { id: 'prompt', text: '' },
    runtimeContext: { id: null, name: '', template: '' },
    workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
  });
  const root = new kernel.RootAuthority(() => rootPath);
  f.app = await kernel.ReliableKernelApplication.open(root, {
    holdRuntimeConvergence: true,
    authorityCompiler: { async compile(request) { return { turnId: request.turnId, executorAgentId: request.executorAgentId,
      executionPreset: { content: JSON.stringify({ providerConfigId: 'provider', modelId: 'model' }) },
      authoritySnapshot: { content: JSON.stringify(authority(request)) } }; } },
    resolveWorkEnvironment: async () => undefined,
    providers: { resolve(providerId) { return { providerId, async sendFullRequest(request, controls) {
      f.modelCalls.push(request);
      const content = await f.model(request, controls.signal);
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: Array.isArray(content) ? { role: 'model', parts: content } : content });
    } }; } },
    mcpConnections: { async toolAnnotations() { return {}; }, callTool(...args) { f.mcpCalls.push(args); return f.mcpHandler(...args); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) =>
      new kernel.ReliableToolDispatcher({ database, contentStore, effects: runtime.effects, files, fileMutations, processes, mcp, interactions,
        host: {
          definitions() { return [askUserTool, submitPlanTool, runAgentTool, bashTool, mcpTool('fixture_hang'), mcpTool('fixture_guarded', true)]; },
          async dispatchSpecial(_definition, input, frozen, signal, admission) { return coordinator.dispatch(input, signal, frozen, admission); },
          async cancelTurnWaits(input) { await coordinator.cancelParentWaits(input); },
          async quiesce(reason) { await coordinator.quiesce(reason); },
          async dispose() {}
        } })
  });
  const { app } = f;
  coordinator = new ReliableChildAgentCoordinator({ database: app.database, ...app.runtime, turns: app.turns, modelProvider: app.modelProvider,
    agentLoop: app.agentLoop, agents: { async resolve() { return { agentId: 'agent-main', agentType: 'worker' }; } },
    modelProfiles: { async initializeConversation() { return { created: true }; } }, deliveryWakeups: app.processDeliveries,
    ownedProcessCleanup: app.childOwnedProcessCleanup, deadHostEffects: app.phaseDRecovery });
  f.coordinator = coordinator;
  f.runner = new ReliableConversationRunner(app, `${label}:${app.database.hostBootId}`, error => { f.errors.push(error); });
  app.processDeliveries.setWakeHandler(createRuntimeDeliveryWakeHandler({ application: () => app,
    conversations: () => f.runner, children: () => coordinator }));
  f.root = root;
  f.rows = async (name, where = {}) => (await app.database.snapshotAll(repo(name).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000 }))).snapshot;
  f.get = async (name, id) => (await app.database.snapshot([repo(name).get(id)])).snapshot[0];
  f.conversation = async label => {
    const id = f.id(label), at = now();
    await app.database.transaction([
      repo('Conversation').insert({ id, title: label, status: 'active', created_at: at, updated_at: at }),
      emptyConversationContextHandleStateStep(id, at),
      repo('AgentConversationLink').insert({ id: `${id}-agent`, conversation_id: id, agent_id: 'agent-main', role: 'default', created_at: at, updated_at: at })
    ]);
    return id;
  };
  f.input = (conversationId, key = f.id('input'), content = key) => app.turns.input({ source: { kind: 'command', key }, conversationId, content,
    leaseOwnerId: f.runner.leaseOwnerId, hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 600000).toISOString() });
  f.source = async (turnId, name = 'fixture_hang', args = {}) => {
    const toolCallId = f.id('tool');
    await app.runtime.effects.createToolCall({ source: { kind: 'internal', key: toolCallId }, toolCallId, turnId, toolName: name, arguments: args });
    return { kind: 'tool', turnId, toolCallId };
  };
  f.spawn = async (parentTurnId, { receipt = true, taskName = 'worker' } = {}) => {
    const source = await f.source(parentTurnId, 'run_agent', { operation: 'spawn', taskName, prompt: 'Inspect', foregroundWaitMs: 0 });
    const spawned = await app.runtime.children.spawn({ sourceToolCallId: source.toolCallId, childAgentId: 'agent-main',
      modelFallback: { providerConfigId: 'provider', model: 'model' }, title: taskName, prompt: 'Inspect', completionPolicy: 'background', sourceSettlement: 'child_handle',
      leaseOwnerId: coordinator.childLeaseOwnerId, leaseExpiresAt: new Date(Date.now() + 600000).toISOString(), leaseDurationMs: 600000 });
    await app.runtime.children.claimSpawnDispatch(spawned.effectIntentId);
    if (receipt) {
      const recorded = await app.runtime.children.recordSpawnReceipt({ sourceKey: `fixture-spawn:${spawned.attemptId}`, attemptId: spawned.attemptId,
        outcome: 'succeeded', detail: { adapter: 'reliable-local-agent-loop' } });
      await app.runtime.children.reconcileSpawnReceipt(recorded.effectReceiptId);
    }
    return { ...spawned, toolCallId: source.toolCallId };
  };
  f.until = async (probe, label, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (f.errors.length) throw f.errors[0];
      const result = await probe();
      if (result) return result;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail(label);
  };
  let closed = false;
  f.close = async () => {
    if (closed) return;
    closed = true;
    f.runner.dispose();
    await app.beginHandoff();
    await f.runner.waitForIdle();
    await coordinator.dispose();
    await app.close();
  };
  return f;
}

export async function openStopFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-stop-suite-'));
  const rootPath = path.join(directory, 'runtime');
  await kernel.initializeEmptyRuntimeRoot(new kernel.RootAuthority(() => rootPath));
  const f = await openStopHost(rootPath, { directory });
  const peers = new Set();
  f.peer = async (mode, label = mode) => {
    const peer = await openPeer(f, mode, f.id(label));
    peers.add(peer);
    return peer;
  };
  let controlPeer;
  const deadPeers = new Map();
  const alive = peer => peer && peer.child.exitCode === null && peer.child.signalCode === null;
  f.livePeer = async () => {
    if (!alive(controlPeer)) controlPeer = await f.peer('mcp', 'live-owner');
    return controlPeer;
  };
  f.deadPeer = async (mode, label) => {
    if (deadPeers.has(mode)) return deadPeers.get(mode);
    const reused = alive(controlPeer);
    const peer = reused ? controlPeer : await f.peer(mode, label);
    const ready = reused ? await peer.request('prepare', { mode, label }) : peer.ready;
    // Both dead-host contracts get separate durable identities from one actual Host death.
    // A standalone spawn test opens only its own spawn; the preceding MCP test prepares it in a full run.
    if (mode === 'mcp') {
      const spawn = await peer.request('prepare', { mode: 'spawn', label: 'dead-spawn' });
      deadPeers.set('spawn', { ...peer, ready: spawn });
    }
    const view = { ...peer, ready };
    deadPeers.set(mode, view);
    return view;
  };
  const closeHost = f.close;
  f.close = async () => {
    for (const peer of peers) await peer.close();
    for (const processRow of await f.rows('Process')) {
      if (['running', 'starting'].includes(processRow.status)) await f.app.processes.stopOwnedProcess(processRow.id);
    }
    await closeHost();
    await fs.rm(directory, { recursive: true, force: true });
  };
  return f;
}

async function openPeer(f, mode, label) {
  const child = childProcess.fork(fileURLToPath(new URL('./stop-peer-host.mjs', import.meta.url)), [f.rootPath, mode, label], {
    execArgv: [], env: { ...process.env, LIMCODE_TEST_EXTENSION_ROOT: compiled }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced'
  });
  let output = '', serial = 0, readyResolve, readyReject;
  const pending = new Map();
  child.stdout.on('data', bytes => { output += bytes.toString(); });
  child.stderr.on('data', bytes => { output += bytes.toString(); });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => {
    const error = new Error(`Peer ${label} exited (${code ?? signal}): ${output}`);
    readyReject?.(error);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    resolve({ code, signal });
  }));
  const readyPromise = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.on('error', error => { readyReject?.(error); });
  child.on('message', message => {
    if (message.kind === 'ready') { readyResolve(message.ready); readyReject = undefined; return; }
    if (message.kind === 'error' && !message.id) { readyReject?.(new Error(message.error)); return; }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.kind === 'error') entry.reject(new Error(message.error));
    else entry.resolve(message.result);
  });
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Peer ${label} readiness timed out: ${output}`)), 5000); });
  let ready;
  try { ready = await Promise.race([readyPromise, timeout]); }
  catch (error) { child.kill('SIGKILL'); await exited; throw error; }
  finally { clearTimeout(timer); }
  const peer = { ready, child,
    request(action, input = {}) {
      if (!child.connected) return Promise.reject(new Error(`Peer ${label} is disconnected`));
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Peer ${label} action ${action} timed out: ${output}`)); }, 5000);
        pending.set(id, { resolve, reject, timer });
        child.send({ id, action, input });
      });
    },
    async kill() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); return exited; },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { await peer.request('close'); }
      finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; }
    }
  };
  return peer;
}
