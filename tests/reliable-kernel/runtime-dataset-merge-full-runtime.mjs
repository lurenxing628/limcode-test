// A full production Runtime composition (application, conversation
// runner, child-agent coordinator, delivery wake handler) on a given RootAuthority. Only the model
// Provider is synthetic, and every call to it is recorded. For runtime-dataset-merge-e2e.test.mjs.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const load = (file) => require(path.join(compiled, file));
const Module = require('node:module');
const originalLoad = Module._load;
class Uri {
  constructor(value) { this.scheme = 'file'; this.fsPath = path.resolve(value); this.path = this.fsPath; }
  static file(value) { return new Uri(value); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.path}`; }
}
const vscode = { Uri, FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 }, workspace: { fs: {
  createDirectory: (uri) => fs.mkdir(uri.fsPath, { recursive: true }), readFile: (uri) => fs.readFile(uri.fsPath),
  async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
  async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map((item) => [item.name, item.isDirectory() ? 2 : 1]); },
  delete: (uri) => fs.rm(uri.fsPath, { recursive: true, force: true }),
  async stat(uri) { const stat = await fs.stat(uri.fsPath); return { type: stat.isDirectory() ? 2 : 1, size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs }; }
} } };
Module._load = function(request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};

export const kernel = load('backend/reliableKernel/index.js');
const { VscodeConfigurationAuthority } = load('backend/reliableKernel/vscodeConfigurationAuthority.js');
const { childConversationModelProfiles } = load('backend/reliableKernel/childThinkingInheritance.js');
const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { ReliableChildAgentCoordinator } = load('backend/reliableKernel/childAgentCoordinator.js');
const { ReliableConversationRunner } = load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { createRuntimeDeliveryWakeHandler } = load('backend/application/reliableKernel/runtimeDeliveryWakeHandler.js');
const { ReliableToolDispatcher } = load('backend/reliableKernel/toolDispatcher.js');
const { CollaborationToolDispatcher } = load('backend/reliableKernel/collaborationToolDispatcher.js');
const { runAgentTool } = load('backend/world/modules/tools/definitions/runAgent/index.js');
const { agentCollaborationToolModules } = load('backend/world/modules/tools/definitions/agentCollaboration/index.js');
const { LlmEventType } = load('backend/world/modules/llm/events.js');
const definitions = [runAgentTool, ...agentCollaborationToolModules.map((module) => module.create({}))];
export const repo = (name) => kernel.DOMAIN_REPOSITORIES.domain(name);

/**
 * Opens the composition. `send(request, controls, start)` is the synthetic Provider body; every call is
 * pushed to `calls` before it runs. `settingsRoot` holds agents and provider configuration.
 */
export async function openFullRuntime({ authority, settingsRoot, send, hostLabel = 'merge-e2e' }) {
  const configuration = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(settingsRoot)));
  const save = async (section, settings) => configuration.saveGlobalSettings(section, settings, (await configuration.loadGlobalSettings(section)).revision);
  const provider = { ...createDefaultLlmProviderConfig({ name: 'synthetic' }), id: 'synthetic-provider',
    provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'gpt-6-astra',
    models: [{ id: 'gpt-6-astra', name: 'synthetic' }], modelConfigs: [], generationConfig: {}, contextWindowTokens: 200000 };
  const existing = (await configuration.loadGlobalSettings('llmProviderConfigs')).settings;
  if (!existing?.configs?.some?.((config) => config.id === provider.id)) {
    await save('llmProviderConfigs', { configs: [provider] });
    await save('llm', { activeProviderConfigId: provider.id });
    await configuration.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: definitions.map((tool) => tool.declaration.name) });
  }
  const settingsFile = path.join(settingsRoot, 'merge-e2e-agents.json');
  let ids = await fs.readFile(settingsFile, 'utf8').then(JSON.parse, () => undefined);
  if (!ids) {
    const parent = await configuration.mutations.createAgent({ name: 'Synthetic root', kind: 'custom' });
    const worker = await configuration.mutations.createAgent({ name: 'Synthetic worker', kind: 'custom' });
    ids = { parent: parent.id, worker: worker.id };
    await fs.writeFile(settingsFile, JSON.stringify(ids));
  }
  const calls = [];
  const errors = [];
  let app, coordinator, runner, collaborationTools;
  app = await kernel.ReliableKernelApplication.open(authority, {
    authorityCompiler: configuration, compressionSettingsAuthority: configuration, attachmentSettings: configuration,
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('External tool calls are forbidden.'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    providers: { resolve(providerId) { return { providerId, async sendFullRequest(request, controls) {
      calls.push({ modelRequestId: request.modelRequestId, conversationId: request.conversationId, attemptSeq: request.attemptSeq });
      let start;
      const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
        start(input, emit) { start = input; emit({ type: LlmEventType.Done, payload: { requestId: input.id } }); }, abort() {}, dispose() {}
      });
      await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, terminal: true, checkpointed: true }; } });
      // `start` is the provider-facing request (its contents), for a Provider that answers by content.
      await send(request, controls, start);
    } }; } },
    createToolDispatcher: (dependencies) => new ReliableToolDispatcher({ ...dependencies, effects: dependencies.runtime.effects,
      host: {
        definitions: () => definitions,
        async dispatchSpecial(_definition, input, authorityInput, signal, admission) {
          return await collaborationTools.dispatch(input, signal, authorityInput)
            ?? await coordinator.dispatch(input, signal, authorityInput, admission);
        },
        cancelTurnWaits: (input) => coordinator.cancelParentWaits(input),
        quiesce: (reason) => coordinator.quiesce(reason)
      }
    })
  });
  collaborationTools = new CollaborationToolDispatcher({ database: app.database, contentStore: app.contentStore,
    effects: app.runtime.effects, collaboration: app.runtime.collaboration, board: app.runtime.collaborationBoard });
  coordinator = new ReliableChildAgentCoordinator({ database: app.database, ...app.runtime,
    modelProvider: app.modelProvider, turns: app.turns, agentLoop: app.agentLoop,
    agents: { async resolve() { return { agentId: ids.worker, agentType: 'worker' }; } },
    modelProfiles: childConversationModelProfiles(configuration.mutations),
    deliveryWakeups: app.processDeliveries, ownedProcessCleanup: app.childOwnedProcessCleanup
  });
  runner = new ReliableConversationRunner(app, `${hostLabel}-owner`);
  const wake = createRuntimeDeliveryWakeHandler({ application: () => app, conversations: () => runner, children: () => coordinator });
  const wakes = [];
  app.processDeliveries.setWakeHandler(async (request) => { wakes.push(structuredClone(request)); return wake(request); });
  return {
    app, runner, coordinator, calls, errors, wakes, agentIds: ids,
    /** The production startup order of VscodeReliableKernelProductRuntime.startRecovery. */
    async startupRecovery() {
      const report = await app.recover();
      await coordinator.recoverStartup();
      const runnerReport = await runner.recoverStartup();
      await app.refreshExternalRuntimeWork();
      return { report, runnerReport };
    },
    async close() {
      runner?.dispose();
      if (coordinator) await coordinator.dispose();
      if (app) await app.close();
    }
  };
}

export async function createRootConversation(app, agentId, conversationId) {
  const now = new Date().toISOString();
  await app.database.transaction([
    repo('Conversation').insert({ id: conversationId, title: conversationId, status: 'active', created_at: now, updated_at: now }),
    repo('AgentConversationLink').insert({ id: `${conversationId}-agent`, conversation_id: conversationId, agent_id: agentId, role: 'default', created_at: now, updated_at: now })
  ]);
}

export const modelAnswer = (text) => ({ role: 'model', parts: [{ text }] });
