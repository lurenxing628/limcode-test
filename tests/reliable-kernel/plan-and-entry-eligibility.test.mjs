import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
class Uri {
  constructor(value) { this.scheme = 'file'; this.fsPath = path.resolve(value); this.path = this.fsPath; }
  static file(value) { return new Uri(value); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.path}`; }
}
const vscode = { Uri, FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 }, workspace: { fs: {
  createDirectory: uri => fs.mkdir(uri.fsPath, { recursive: true }), readFile: uri => fs.readFile(uri.fsPath),
  async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
  async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map(item => [item.name, item.isDirectory() ? 2 : 1]); },
  delete: uri => fs.rm(uri.fsPath, { recursive: true, force: true }),
  async stat(uri) { const s = await fs.stat(uri.fsPath); return { type: s.isDirectory() ? 2 : 1, size: s.size, ctime: s.ctimeMs, mtime: s.mtimeMs }; }
} } };
Module._load = function(request, parent, isMain) { return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain); };
after(() => { Module._load = originalLoad; });

const dist = file => require(path.join(process.cwd(), 'dist/extension', file));
const { childConversationModelProfiles } = dist('backend/reliableKernel/childThinkingInheritance.js');
const kernel = dist('backend/reliableKernel/index.js');
const { VscodeConfigurationAuthority } = dist('backend/reliableKernel/vscodeConfigurationAuthority.js');
const { createVscodeStoragePaths } = dist('backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = dist('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { ReliableChildAgentCoordinator } = dist('backend/reliableKernel/childAgentCoordinator.js');
const { readFrozenTurnAuthority } = dist('backend/reliableKernel/frozenAuthority.js');
const { submitPlanTool } = dist('backend/world/modules/tools/definitions/submitPlan/index.js');
const { projectFolderAssignmentSteps } = dist('backend/reliableKernel/conversationProject.js');
const {
  evaluateConversationEntryEligibility,
  evaluateConversationHostEligibility
} = dist('backend/application/reliableKernel/conversationHostEligibility.js');

test('复审 #1：计划审批“在新对话中执行”在不合格窗口只记录回答；合格窗口续跑父 Turn 时才派生并驱动子 Agent', { timeout: 120000 }, async () => {
  await runtimeFixture(async f => {
    await f.configuration.mutations.setToolPolicy({ scopeKind: 'agent', scopeId: f.parentAgent.id, allowedTools: ['read', 'submit_plan'] });
    await f.configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['read', 'run_agent', 'submit_plan', 'write'] });
    const planned = await f.app.agentLoop.runInput(f.input('plan'));
    assert.equal(planned.terminalStatus, 'waiting');
    const [request] = await f.list('InteractionRequest');
    assert.equal(request.request_kind, 'plan_review');
    const owners = f.app.database.conversationOwners;
    // This window does not serve the parent Conversation (its project folder is not open here).
    owners.setClaimEligibilityProbe(async () => false);
    const before = f.requests.length;
    // VscodeReliableKernelCommandRouter.handleInteractionResolve: resolvePlanReview inside runConversationCommand.
    const resolved = await owners.run('parent', () => f.app.interactions.resolvePlanReview({
      source: { kind: 'command', key: 'approve-in-ineligible-window' }, requestId: request.id,
      decision: 'accept', response: { executionTarget: 'new_conversation', agentType: f.childAgent.id } }));
    await f.coordinator.waitForIdle();
    assert.equal(resolved.won, true, '回答已记录');
    assert.equal(resolved.terminal, undefined, '委派留给合格窗口');
    assert.deepEqual(await f.list('ChildExecution'), [], '不合格窗口不派生子 Agent');
    assert.equal(f.requests.length, before, '不合格窗口不调用 Provider');
    assert.equal((await f.list('InteractionResponse', { request_id: request.id })).length, 1);
    assert.equal((await f.list('InteractionRequest', { id: request.id }))[0].status, 'pending');
    await assert.rejects(f.coordinator.ensureApprovedPlan({ sourceToolCallId: 'unused', parentTurnId: planned.turnId,
      requestedAgentId: f.childAgent.id, prompt: 'x', expected: {} }), /serves the parent Conversation/);

    // The window serving the parent resumes the Turn: the recorded approval is completed there.
    owners.setClaimEligibilityProbe(async () => true);
    const resumed = await owners.run('parent', () => f.app.agentLoop.drive(planned.turnId));
    await f.coordinator.waitForIdle();
    const [child] = await f.list('ChildExecution');
    assert.ok(child, '合格窗口派生了子 Agent');
    assert.ok(f.requests.slice(before).some((r) => r.conversationId === child.child_conversation_id), '子 Agent 在合格窗口运行');
    assert.equal((await f.list('InteractionRequest', { id: request.id }))[0].status, 'succeeded');
    assert.equal(resumed.terminalStatus, 'completed');
  }, {
    async send(request, controls, f) {
      let part = { text: 'done' };
      if (request.conversationId === 'parent' && !f.sent.has('plan')) {
        f.sent.add('plan');
        part = { id: 'submit-plan', functionCall: { name: 'submit_plan', args: { plan: 'Edit the parser.',
          taskList: { mode: 'rewrite', items: [{ title: 'Fix', description: 'Edit.', status: 'pending', delete: false }] } } } };
      }
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [part] } });
    }
  });
});

test('复审 #2：项目文件夹移动后，空闲对话在本窗口选择工作环境即可继续；新 Turn 由选中的工作环境定位', { timeout: 120000 }, async () => {
  let markSendStarted;
  const sendStarted = new Promise(resolve => { markSendStarted = resolve; });
  await runtimeFixture(async f => {
    const oldProject = { uri: Uri.file(path.join(f.root, 'project-old')).toString(), name: 'project-old' };
    const moved = Uri.file(path.join(f.root, 'project-renamed'));
    await fs.mkdir(moved.fsPath, { recursive: true });
    // This window has the moved folder open; the Conversation still points at the old location.
    await f.configuration.synchronizeWorkspaceFolders([{ uri: moved.toString(), name: 'project-renamed', rootPath: moved.fsPath, index: 0 }]);
    await f.app.database.transaction(projectFolderAssignmentSteps({ conversationId: 'parent', folder: oldProject, now: new Date().toISOString() }));
    const dependencies = {
      database: f.app.database,
      contentStore: f.app.contentStore,
      workspaceFolderUris: () => [moved.toString()],
      workEnvironments: () => f.configuration.workEnvironments(),
      nextTurnWorkEnvironment: (id) => f.app.turns.previewNextTurnWorkEnvironment(id)
    };
    const refused = await evaluateConversationEntryEligibility(dependencies, 'parent');
    assert.equal(refused.eligible, false);
    assert.equal(refused.reason, 'next_work_environment_unavailable');
    assert.deepEqual(await evaluateConversationHostEligibility(dependencies, 'parent'), {
      eligible: false, reason: 'project_not_open', projectUri: oldProject.uri, projectName: 'project-old'
    }, '后台恢复仍按项目判断');

    const environment = (await f.configuration.workEnvironments()).find((candidate) => candidate.uri === moved.toString());
    await f.configuration.mutations.selectConversationWorkEnvironment('parent', environment.id);
    assert.deepEqual(await evaluateConversationEntryEligibility(dependencies, 'parent'), { eligible: true }, '选择后可以继续');

    const before = f.requests.length;
    const running = f.app.agentLoop.runInput(f.input('after-move'));
    // requests is recorded before async wire preparation. Wait for the send hook itself,
    // and observe runInput immediately so fixture cleanup cannot create an unhandled rejection.
    await Promise.race([sendStarted, running.then(() => { throw new Error('The Turn ended before its provider send started.'); })]);
    assert.ok(f.requests.length > before);
    // While the Turn runs, its frozen chosen work environment places it here; the old project does not.
    assert.deepEqual(await evaluateConversationHostEligibility(dependencies, 'parent'), { eligible: true });
    f.releaseSend();
    const result = await running;
    assert.equal(result.terminalStatus, 'completed');
    const frozenPolicy = (await f.frozen(result.turnId)).document.workEnvironmentPolicy;
    assert.equal(frozenPolicy.defaultWorkEnvironmentId, environment.id);
    assert.ok(frozenPolicy.allowedWorkEnvironmentIds.includes(environment.id));
    // A maintenance Turn (manual compression) freezes the real preview's policy for this window: the
    // same policy compile() froze for the ordinary Turn, not an approximation.
    const maintenance = await f.app.turns.previewMaintenanceAuthority('parent', result.turnId);
    assert.deepEqual(maintenance.workEnvironmentPolicy, frozenPolicy);
    // Once the chosen folder is gone, the real preview reports it and an idle Conversation is not served here.
    await fs.rm(moved.fsPath, { recursive: true, force: true });
    await f.configuration.synchronizeWorkspaceFolders([]);
    assert.equal((await f.app.turns.previewNextTurnWorkEnvironment('parent')).error !== undefined, true);
    assert.deepEqual(await evaluateConversationHostEligibility(dependencies, 'parent'), {
      eligible: false, reason: 'project_not_open', projectUri: oldProject.uri, projectName: 'project-old'
    });
  }, {
    async send(_request, controls, f) {
      await new Promise((resolve) => { f.releaseSend = resolve; markSendStarted(); });
      await controls.onEvent({ kind: 'completed', streamSeq: '1', content: { role: 'model', parts: [{ text: 'done' }] } });
    }
  });
});

async function saveProvider(configuration, model = 'synthetic-model') {
  const save = async (section, settings) => configuration.saveGlobalSettings(section, settings, (await configuration.loadGlobalSettings(section)).revision);
  const provider = { ...createDefaultLlmProviderConfig({ name: 'synthetic' }), id: 'child-boundary', provider: 'openai-compatible',
    model, models: [{ id: model, name: 'synthetic' }], modelConfigs: [], generationConfig: {} };
  await save('llmProviderConfigs', { configs: [provider] });
  await save('llm', { activeProviderConfigId: provider.id });
  return provider;
}

async function runtimeFixture(run, hooks, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-child-tool-boundary-runtime-'));
  let app, coordinator;
  try {
    const { dryRunLlmProvider } = dist('backend/capabilities/llmProvider.js');
    const { applyFrozenModelProviderConfig } = dist('backend/reliableKernel/llmCapabilityProviderRegistry.js');
    const { LlmEventType } = dist('backend/world/modules/llm/events.js');
    const configuration = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(path.join(root, 'settings'))));
    const provider = await saveProvider(configuration, options.model);
    const parentAgent = await configuration.mutations.createAgent({ name: 'orchestrator', kind: 'custom' });
    const childAgent = await configuration.mutations.createAgent({ name: 'implementer', kind: 'custom' });
    await configuration.mutations.setToolPolicy({ scopeKind: 'agent', scopeId: parentAgent.id,
      allowedTools: ['read', 'run_agent'], toolConfigs: { run_agent: { config: { maxChildAgentDepth: 3 } } } });
    await configuration.mutations.setToolPolicy({ scopeKind: 'agent', scopeId: childAgent.id,
      allowedTools: ['bash', 'read', 'write'] });
    await configuration.mutations.setSkillPolicy({ scopeKind: 'agent', scopeId: parentAgent.id, sourceConfigs: { agents: { enabled: true, disabledSkills: ['deploy'] } } });
    const authority = new kernel.RootAuthority(() => path.join(root, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(authority);
    const requests = [], wires = [];
    let f;
    const list = async (domain, where = {}) => (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))).snapshot;
    const frozen = async turnId => {
      const [row] = await list('AuthoritySnapshot', { turn_id: turnId });
      return readFrozenTurnAuthority(app.database, app.contentStore, row.id, turnId);
    };
    const compileRequests = [];
    const compiler = {
      async compile(request) { compileRequests.push(structuredClone(request)); return configuration.compile(request); },
      previewWorkEnvironment: (request) => configuration.previewWorkEnvironment(request)
    };
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: compiler, compressionSettingsAuthority: configuration, attachmentSettings: configuration,
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { return null; } },
      mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
      providers: { resolve(providerId) { return { providerId, async sendFullRequest(request, controls) {
        requests.push(request);
        let projected;
        const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
          start(input, emit) { projected = input; emit({ type: LlmEventType.Done, payload: { requestId: input.id } }); }, abort() {}, dispose() {}
        });
        await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, terminal: true, checkpointed: true }; } });
        const effective = applyFrozenModelProviderConfig(await configuration.providerConfig(providerId), request.modelId);
        const wire = await dryRunLlmProvider(projected, { settings: { ...effective, baseUrl: 'https://example.invalid/v1', apiKey: '' } });
        wires.push({ conversationId: request.conversationId, turnId: request.turnId, body: wire.body });
        return hooks.send(request, controls, f);
      } }; } },
      // The production dispatcher: re-entering a waiting submit_plan call completes a recorded approval.
      createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) =>
        new kernel.ReliableToolDispatcher({
          database, contentStore, effects: runtime.effects, files, fileMutations, processes, mcp, interactions,
          host: { definitions() { return [submitPlanTool]; }, async cancelTurnWaits() {}, async dispose() {} }
        })
    });
    const profileInits = [];
    const productProfiles = childConversationModelProfiles(configuration.mutations);
    coordinator = new ReliableChildAgentCoordinator({ database: app.database, ...app.runtime, modelProvider: app.modelProvider, turns: app.turns, agentLoop: app.agentLoop,
      agents: { async resolve() { return { agentId: childAgent.id, agentType: 'worker' }; } },
      // Production wiring (VscodeReliableKernelProductRuntime uses the same adapter).
      modelProfiles: { async initializeConversation(input) {
        profileInits.push(structuredClone(input));
        const failure = f.failProfile?.(input);
        if (failure) throw failure;
        return productProfiles.initializeConversation(input);
      } }
    });
    // Production wiring: a Plan approved to run in a new conversation goes through the same coordinator.
    app.interactions.setPlanDelegator({ preview: input => coordinator.previewApprovedPlan(input), ensure: input => coordinator.ensureApprovedPlan(input),
      mayEnsure: input => coordinator.mayEnsureApprovedPlan(input) });
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: 'parent', title: 'Synthetic', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'parent-agent', conversation_id: 'parent', agent_id: parentAgent.id, role: 'default', created_at: now, updated_at: now })
    ]);
    const input = key => ({ source: { kind: 'command', key }, conversationId: 'parent', leaseOwnerId: 'boundary-owner', hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120000).toISOString(), content: `synthetic input ${key}` });
    f = { app, configuration, coordinator, provider, root, parentAgent, childAgent, input, requests, wires, list, frozen, compileRequests, profileInits, sent: new Set() };
    await run(f);
  } finally {
    if (coordinator) await coordinator.dispose();
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
