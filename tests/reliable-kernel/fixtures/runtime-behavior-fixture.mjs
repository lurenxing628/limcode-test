import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
export const load = relative => require(path.join(compiled, relative));
export const kernel = load('backend/reliableKernel/index.js');
export const repo = domain => kernel.DOMAIN_REPOSITORIES.domain(domain);
export const { ReliableConversationRunner } = load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { emptyConversationContextHandleStateStep } = load('backend/reliableKernel/conversationContextHandleState.js');
const { askUserTool } = load('backend/world/modules/tools/definitions/askUser/index.js');
const { submitPlanTool } = load('backend/world/modules/tools/definitions/submitPlan/index.js');
const { taskListTool } = load('backend/world/modules/tools/definitions/taskList/index.js');
export const NOW = '2026-10-13T00:00:00.000Z';
export const text = value => ({ role: 'model', parts: [{ text: value }] });
export const gate = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
export const rows = async (database, domain, where = {}) => (await database.snapshotAll(repo(domain).list({
  where, orderBy: { column: 'id', direction: 'asc' }, limit: 1000
}))).snapshot;
export async function until(check, message = 'Expected committed state was not reached') {
  const end = Date.now() + 5000;
  do { if (await check()) return; await new Promise(setImmediate); } while (Date.now() < end);
  throw new Error(message);
}

export async function createBatchFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-context-batches-'));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  const database = await kernel.RuntimeDatabase.open(authority);
  const store = kernel.ContentAddressedStore.forDatabase(authority, database);
  const body = await store.ingest(database, 'shared context batch body', 'text/plain');
  return {
    now: NOW, database, binding, authority, store,
    async segments(ids) { await database.transaction(ids.map(id => repo('ContextSegment').insert({
      id, content_object_id: body.id, segment_kind: 'system', created_at: NOW
    }))); },
    async close() { await database.close(); await fs.rm(directory, { recursive: true, force: true }); }
  };
}

// One real Application/SQLite writer per suite. A scenario only allocates its own Conversation,
// policy and external provider port; it never substitutes an in-memory writer for production code.
export async function createBehaviorRuntime(prefix = 'behavior') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-${prefix}-`));
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  const binding = await kernel.initializeEmptyRuntimeRoot(authority);
  const optionsByConversation = new Map();
  const optionsByTurn = new Map();
  const calls = [];
  const definitions = [askUserTool, submitPlanTool, ...(taskListTool ? [taskListTool] : []), {
    declaration: { name: 'counter', description: 'Observable offline effect', parameters: { type: 'object' },
      metadata: { readonly: true, defaultAutoApproveExecution: true, defaultAutoSubmitResult: true } }
  }, {
    declaration: { name: 'read', description: 'Offline gated read', parameters: { type: 'object' },
      metadata: { readonly: true, defaultAutoApproveExecution: true, defaultAutoSubmitResult: true } }
  }];
  const compile = async request => {
    const options = optionsByConversation.get(request.conversationId) ?? {};
    const document = { kind: 'effective-turn-authority', turnId: request.turnId,
      conversationId: request.conversationId, executorAgentId: request.executorAgentId,
      model: { providerConfigId: 'behavior-provider', provider: 'fixture', modelId: 'behavior-model',
        retryPolicy: { enabled: false, maxRetries: 0 } },
      modelProfile: { compressionThresholdTokens: 100000, contextWindowTokens: 128000,
        tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
      toolPolicy: { id: 'behavior-tools', allowedTools: ['ask_user', 'submit_plan', 'update_task_list', 'counter', 'read', 'run_agent'],
        preset: 'custom', toolConfigs: options.toolConfigs ?? {}, sourceConfigs: {} },
      planReviewPolicy: { mode: 'optional' }, systemPrompt: { id: 'behavior-prompt', text: '' },
      runtimeContext: { id: null, name: '', template: '' },
      workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null } };
    return { turnId: request.turnId, executorAgentId: request.executorAgentId,
      executionPreset: { content: JSON.stringify({ providerConfigId: 'behavior-provider', modelId: 'behavior-model' }) },
      authoritySnapshot: { content: JSON.stringify(document) } };
  };
  const provider = { providerId: 'behavior-provider', async sendFullRequest(request, controls) {
    calls.push(request); const options = optionsByConversation.get(request.conversationId) ?? {};
    const localCalls = calls.filter(call => call.conversationId === request.conversationId).length;
    if (options.reply) return options.reply(request, controls, localCalls);
    await controls.onEvent({ kind: 'completed', streamSeq: '1', content: text('completed') });
  } };
  const app = await kernel.ReliableKernelApplication.open(authority, {
    authorityCompiler: { compile }, resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('Unexpected MCP call'); } },
    mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
    attachmentSettings: { async loadGlobalSettings() { return { section: 'attachments',
      settings: { maxStoredInlineFileMb: 25 }, filePath: 'unused' }; } },
    providers: { resolve() { return provider; } },
    createToolDispatcher: deps => new kernel.ReliableToolDispatcher({ ...deps, effects: deps.runtime.effects,
      host: { definitions() { return definitions; }, async cancelTurnWaits() {}, async dispose() {},
        async executeNoEffect(definition, input, policy, emit, signal) {
          const option = optionsByTurn.get(input.turnId) ?? {};
          return option.execute ? option.execute(input, signal) : { ok: true, output: 'offline result' };
        }
      }
    })
  });
  let sequence = 0;
  const scopes = [];
  return {
    app, authority, binding, directory, calls,
    async scope(label, options = {}) {
      const id = `${prefix}-${label}-${++sequence}`;
      optionsByConversation.set(id, options);
      const at = new Date().toISOString();
      await app.database.transaction([
        repo('Conversation').insert({ id, title: label, status: 'active', created_at: at, updated_at: at }),
        emptyConversationContextHandleStateStep(id, at),
        repo('AgentConversationLink').insert({ id: `${id}-agent`, conversation_id: id,
          agent_id: 'behavior-agent', role: 'default', created_at: at, updated_at: at })
      ]);
      const ownerId = `${id}-owner`;
      const lease = () => ({ conversationId: id, leaseOwnerId: ownerId, hostBootId: app.database.hostBootId,
        leaseExpiresAt: new Date(Date.now() + 120000).toISOString() });
      let commands = 0;
      const h = { app, id, conversationId: id, ownerId, options,
        get providerCalls() { return calls.filter(call => call.conversationId === id).length; },
        lease,
        async input(content, key = `input-${++commands}`) {
          const input = await app.turns.input({ source: { kind: 'command', key: `${id}:${key}` }, ...lease(), content });
          if (input.turnId) optionsByTurn.set(input.turnId, options);
          return input;
        },
        async run(content, key = `run-${++commands}`) {
          return app.agentLoop.runInput({ source: { kind: 'command', key: `${id}:${key}` }, ...lease(), content });
        },
        runner(errors = []) {
          const runner = new ReliableConversationRunner(app, ownerId, (error, context) => errors.push({ error, context }));
          scopes.push(runner); return runner;
        },
        async tool(turnId, name, args, suffix = `tool-${++commands}`) {
          const toolCallId = `${id}:${suffix}`;
          await app.runtime.effects.createToolCall({ source: { kind: 'internal', key: `${toolCallId}:create` },
            toolCallId, turnId, toolName: name, arguments: args });
          return { turnId, modelRequestId: `${id}:request`, toolCallId, toolName: name, arguments: args };
        },
        rows: (domain, where = {}) => rows(app.database, domain, { conversation_id: id, ...where })
      };
      return h;
    },
    async close() {
      for (const runner of scopes) runner.dispose();
      await Promise.all(scopes.map(runner => runner.waitForIdle()));
      await app.close(); await fs.rm(directory, { recursive: true, force: true });
    }
  };
}
