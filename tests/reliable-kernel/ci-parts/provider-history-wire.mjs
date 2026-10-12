import assert from 'node:assert/strict';

import fs from 'node:fs/promises';

import os from 'node:os';

import path from 'node:path';

import { createRequire } from 'node:module';

import { after, test } from 'node:test';

const require = createRequire(import.meta.url);

const compiled = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');

const load = file => require(path.join(compiled, file));

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
  async stat(uri) { const stat = await fs.stat(uri.fsPath); return { type: stat.isDirectory() ? 2 : 1, size: stat.size, ctime: stat.ctimeMs, mtime: stat.mtimeMs }; }
} } };

Module._load = function(request, parent, isMain) {
  return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
};

after(() => { Module._load = originalLoad; });

const kernel = load('backend/reliableKernel/index.js');

const { emptyConversationContextHandleStateStep } = load('backend/reliableKernel/conversationContextHandleState.js');

const { VscodeConfigurationAuthority } = load('backend/reliableKernel/vscodeConfigurationAuthority.js');

const { ReliableConversationRunner } = load('backend/application/reliableKernel/ReliableConversationRunner.js');

const { ReliableToolDispatcher } = load('backend/reliableKernel/toolDispatcher.js');

const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');

const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');

const { dryRunLlmProvider } = load('backend/capabilities/llmProvider.js');

const { applyFrozenModelProviderConfig } = load('backend/reliableKernel/llmCapabilityProviderRegistry.js');

const { LlmEventType } = load('backend/world/modules/llm/events.js');

const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);

const rows = async (app, domain, where) => (await app.database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))).snapshot;

// 1x1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const CONVERSATION = 'conversation-tool-batch';

/** Two MCP tools as McpRuntimeManager declares them: `srv_shot` answers with an image, `srv_list` with text. */
const mcpTool = (name, originalToolName) => ({
  execution: 'runtime',
  declaration: {
    name, description: `MCP ${name}`, parameters: { type: 'object', properties: {} },
    source: { kind: 'mcp', sourceId: 'srv', sourceName: 'srv', originalToolName },
    metadata: { category: 'general', scope: 'general', riskLevel: 'read', readonly: true, defaultEnabled: false,
      defaultAutoApproveExecution: true, defaultAutoSubmitResult: true }
  },
  async execute() { throw new Error('MCP execution must use the reliable McpEffect control plane.'); }
});

const definitions = [mcpTool('srv_shot', 'shot'), mcpTool('srv_list', 'list')];

const call = (id, name) => ({ id, functionCall: { name, args: {} } });

const answer = text => ({ role: 'model', parts: [{ text }] });

/**
 * One conversation on one provider kind. Only the external model and the MCP server are synthetic:
 * tool dispatch, MCP results, managed attachments, the attachment catalog projection, the provider
 * adapter and the provider request encoder are production code. `send` answers each request and
 * sees the frozen request, the adapter's LlmStartRequest and the encoded wire body.
 */
async function fixture({ providerKind, modelId, baseUrl = 'https://example.invalid/v1', send }, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-tool-batch-wire-'));
  const configuration = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(path.join(root, 'settings'))));
  const save = async (section, settings) => configuration.saveGlobalSettings(section, settings, (await configuration.loadGlobalSettings(section)).revision);
  const provider = { ...createDefaultLlmProviderConfig({ name: 'synthetic tool batch' }), id: 'synthetic-batch',
    provider: providerKind, baseUrl, model: modelId,
    models: [{ id: modelId, name: 'synthetic' }], modelConfigs: [], generationConfig: {}, contextWindowTokens: 200000 };
  const errors = [], requests = [];
  let app, runner;
  try {
    await save('llmProviderConfigs', { configs: [provider] });
    await save('llm', { activeProviderConfigId: provider.id });
    await configuration.mutations.setToolPolicy({ scopeKind: 'global', sourceConfigs: { srv: { enabled: true } } });
    const rootAuthority = new kernel.RootAuthority(() => path.join(root, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(rootAuthority);
    app = await kernel.ReliableKernelApplication.open(rootAuthority, {
      authorityCompiler: configuration, compressionSettingsAuthority: configuration, attachmentSettings: configuration,
      resolveWorkEnvironment: async () => undefined,
      processCompletionDelivery: { scanIntervalMs: 60000 },
      mcpConnections: {
        async toolAnnotations() { return { readOnlyHint: true }; },
        async callTool(_serverId, toolName) {
          return toolName === 'shot'
            ? { content: [{ type: 'text', text: 'screenshot taken' }, { type: 'image', data: PNG, mimeType: 'image/png' }] }
            : { content: [{ type: 'text', text: 'two items' }] };
        }
      },
      mcpPolicyGate: { async authorize() { return { toolPolicyAllowed: true, planReviewAllowed: true }; } },
      providers: { resolve(providerId) { return { providerId, async sendFullRequest(request, controls) {
        try {
          let start;
          const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
            start(input, emit) { start = input; emit({ type: LlmEventType.Done, payload: { requestId: input.id } }); }, abort() {}, dispose() {}
          });
          await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, terminal: true, checkpointed: true }; } });
          const effective = applyFrozenModelProviderConfig(await configuration.providerConfig(providerId), request.modelId);
          const wire = (await dryRunLlmProvider(start, { settings: { ...effective, apiKey: '' } })).body;
          requests.push({ request, start, wire });
          await controls.onEvent({ kind: 'completed', streamSeq: '1', content: await send(requests.length, { request, start, wire }) });
        } catch (error) {
          errors.push(error);
          await controls.onEvent({ kind: 'completed', streamSeq: '1', content: answer('Synthetic provider assertion failed.') });
        }
      } }; } },
      createToolDispatcher: dependencies => new ReliableToolDispatcher({ ...dependencies, effects: dependencies.runtime.effects,
        host: { definitions: () => definitions } })
    });
    const now = new Date().toISOString();
    await app.database.transaction([
      repo('Conversation').insert({ id: CONVERSATION, title: 'tool batch', status: 'active', created_at: now, updated_at: now }),
      emptyConversationContextHandleStateStep(CONVERSATION, now),
      repo('AgentConversationLink').insert({ id: `${CONVERSATION}-agent`, conversation_id: CONVERSATION, agent_id: 'main', role: 'default', created_at: now, updated_at: now })
    ]);
    await app.recover();
    runner = new ReliableConversationRunner(app, 'synthetic-tool-batch-owner');
    const turn = async (text) => {
      const started = await runner.input({ conversationId: CONVERSATION, commandId: `input-${requests.length}-${text}`, text });
      const deadline = Date.now() + 20000;
      let termination;
      while (!termination && Date.now() < deadline) {
        if (errors.length) throw errors[0];
        [termination] = await rows(app, 'TurnTermination', { turn_id: started.turnId });
        if (!termination) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(termination?.terminal_status, 'completed', termination?.reason ?? 'the Turn did not terminate');
      return started.turnId;
    };
    await run({ app, requests, turn });
    assert.deepEqual(errors, []);
  } finally {
    runner?.dispose();
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

function registerCases(test) {

test('a server-side compaction item from an ordinary Responses reply is stored with the reply and replayed verbatim on the next request', { timeout: 120000 }, async () => {
  // https://developers.openai.com/api/docs/guides/compaction: with `context_management` the response
  // output carries an encrypted compaction item; stateless chaining appends output items as usual.
  const compaction = { provider: 'openai', format: 'openai-responses', endpoint: 'responses', itemType: 'compaction',
    rawItem: { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-compaction-state' } };
  const wires = [];
  await fixture({ providerKind: 'openai-responses', modelId: 'gpt-5.5', async send(round, { wire }) {
    wires.push(wire);
    return round === 1
      ? { role: 'model', parts: [{ providerContext: compaction }, { text: 'First answer.' }] }
      : answer('Second answer.');
  } }, async ({ turn }) => {
    await turn('first question');
    await turn('second question');
  });
  assert.equal(wires.length, 2);
  const input = wires[1].input.filter(item => item.role !== 'system' && item.role !== 'developer');
  const compactionIndex = input.findIndex(item => item.type === 'compaction');
  assert.deepEqual(input[compactionIndex], compaction.rawItem, 'the item is replayed byte for byte');
  assert.equal(input.filter(item => item.type === 'compaction').length, 1);
  const texts = input.map(item => JSON.stringify(item));
  const firstQuestion = texts.findIndex(text => text.includes('first question'));
  const firstAnswer = texts.findIndex(text => text.includes('First answer.'));
  const secondQuestion = texts.findIndex(text => text.includes('second question'));
  assert.ok(firstQuestion < compactionIndex && compactionIndex < firstAnswer && firstAnswer < secondQuestion,
    `output order is kept: ${texts.map(text => text.slice(0, 60)).join(' | ')}`);
});
}

export { registerCases };
