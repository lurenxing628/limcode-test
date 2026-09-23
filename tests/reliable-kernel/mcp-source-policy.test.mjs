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
const { VscodeConfigurationAuthority } = load('backend/reliableKernel/vscodeConfigurationAuthority.js');
const { FrozenAuthorityMcpPolicyGate } = load('backend/reliableKernel/frozenMcpPolicyGate.js');
const { ReliableConversationRunner } = load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { ReliableToolDispatcher } = load('backend/reliableKernel/toolDispatcher.js');
const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { readFileTool } = load('backend/world/modules/tools/definitions/index.js');
const { LlmEventType } = load('backend/world/modules/llm/events.js');
const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
const rows = async (app, domain, where) => (await app.database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))).snapshot;

/** Two MCP servers as McpRuntimeManager declares them: execution goes through the MCP effect plane. */
const mcpTool = (sourceId, name) => ({
  execution: 'runtime',
  declaration: {
    name, description: `MCP ${name}`, parameters: { type: 'object', properties: {} },
    source: { kind: 'mcp', sourceId, sourceName: sourceId, originalToolName: name.split('_').at(-1) },
    metadata: { category: 'general', scope: 'general', riskLevel: 'command', readonly: false, defaultEnabled: false }
  },
  async execute() { throw new Error('MCP execution must use the reliable McpEffect control plane.'); }
});
const definitions = [readFileTool, mcpTool('exa', 'exa_search'), mcpTool('other', 'other_lookup')];
const MCP_NAMES = ['exa_search', 'other_lookup'];
const answer = text => ({ role: 'model', parts: [{ text }] });
const forged = () => ({ role: 'model', parts: [{ functionCall: { id: 'forged-mcp', name: 'exa_search', args: {} } }] });

/**
 * One conversation per scope under test. Only the external model and MCP server are synthetic;
 * settings compile, tool offering, admission and the MCP policy gate are production code.
 */
async function fixture(run, { policy } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-mcp-source-policy-'));
  const configuration = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(path.join(root, 'settings'))));
  const save = async (section, settings) => configuration.saveGlobalSettings(section, settings, (await configuration.loadGlobalSettings(section)).revision);
  const provider = { ...createDefaultLlmProviderConfig({ name: 'synthetic mcp policy' }), id: 'synthetic-mcp',
    provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'gpt-6-astra',
    models: [{ id: 'gpt-6-astra', name: 'synthetic' }], modelConfigs: [], generationConfig: {}, contextWindowTokens: 200000 };
  const offered = new Map(), results = new Map(), errors = [];
  let app, runner, dispatcher;
  try {
    await save('llmProviderConfigs', { configs: [provider] });
    await save('llm', { activeProviderConfigId: provider.id });
    const custom = await configuration.mutations.createAgent({ name: 'Custom', kind: 'custom' });
    // An MCP server enabled in the MCP tab: a global source setting, no global tool list.
    await configuration.mutations.setToolPolicy({ scopeKind: 'global', sourceConfigs: { exa: { enabled: true }, other: { enabled: true } } });
    await policy?.(configuration);
    const conversations = {
      explore: { agentId: 'explore' },
      reviewer: { agentId: 'reviewer' },
      main: { agentId: 'main' },
      custom: { agentId: custom.id },
      saved: { agentId: custom.id },
      readonly: { agentId: 'main', workflowId: 'builtin:readonly' },
      review: { agentId: 'main', workflowId: 'builtin:review' }
    };
    await configuration.mutations.setToolPolicy({ scopeKind: 'conversation', scopeId: 'saved', allowedTools: ['read'] });
    for (const [id, { workflowId }] of Object.entries(conversations)) {
      if (workflowId) await configuration.mutations.selectConversationWorkflow({ conversationId: id, scopeKind: 'workflow', workflowId });
    }
    const rootAuthority = new kernel.RootAuthority(() => path.join(root, 'runtime'));
    await kernel.initializeEmptyRuntimeRoot(rootAuthority);
    app = await kernel.ReliableKernelApplication.open(rootAuthority, {
      authorityCompiler: configuration, compressionSettingsAuthority: configuration, attachmentSettings: configuration,
      resolveWorkEnvironment: async () => undefined,
      processCompletionDelivery: { scanIntervalMs: 60000 },
      mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { throw new Error('External tool calls are forbidden in this fixture.'); } },
      createMcpPolicyGate: ({ database, contentStore }) => new FrozenAuthorityMcpPolicyGate(database, contentStore),
      providers: { resolve(providerId) { return { providerId, async sendFullRequest(request, controls) {
        try {
          const [requestRow] = await rows(app, 'ModelRequest', { id: request.modelRequestId });
          const [turn] = await rows(app, 'Turn', { id: requestRow.turn_id });
          let start;
          const adapter = new kernel.LlmCapabilityFullRequestAdapter(providerId, {
            start(input, emit) { start = input; emit({ type: LlmEventType.Done, payload: { requestId: input.id } }); }, abort() {}, dispose() {}
          });
          await adapter.sendFullRequest(request, { async onEvent() { return { accepted: true, terminal: true, checkpointed: true }; } });
          const conversationId = turn.conversation_id;
          const response = start.contents.flatMap(content => content.parts).find(part => part.functionResponse?.name === 'exa_search');
          if (response) results.set(conversationId, response.functionResponse.response);
          else offered.set(conversationId, start.tools.map(tool => tool.name));
          const forge = !response && (conversationId === 'explore' || conversationId === 'readonly');
          await controls.onEvent({ kind: 'completed', streamSeq: '1', content: forge ? forged() : answer('done') });
        } catch (error) { errors.push(error); await controls.onEvent({ kind: 'completed', streamSeq: '1', content: answer('assertion failed') }); }
      } }; } },
      createToolDispatcher: dependencies => (dispatcher = new ReliableToolDispatcher({ ...dependencies, effects: dependencies.runtime.effects,
        host: { definitions: () => definitions } }))
    });
    const now = new Date().toISOString();
    await app.database.transaction(Object.entries(conversations).flatMap(([id, { agentId }]) => [
      repo('Conversation').insert({ id, title: id, status: 'active', created_at: now, updated_at: now }),
      repo('AgentConversationLink').insert({ id: `${id}-agent`, conversation_id: id, agent_id: agentId, role: 'default', created_at: now, updated_at: now })
    ]));
    await app.recover();
    runner = new ReliableConversationRunner(app, 'synthetic-mcp-owner');
    const turns = {};
    for (const id of Object.keys(conversations)) {
      const started = await runner.input({ conversationId: id, commandId: `input-${id}`, text: 'go' });
      const deadline = Date.now() + 15000;
      let termination;
      while (!termination && Date.now() < deadline) {
        if (errors.length) throw errors[0];
        [termination] = await rows(app, 'TurnTermination', { turn_id: started.turnId });
        if (!termination) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.equal(termination?.terminal_status, 'completed', `${id} Turn did not complete`);
      turns[id] = started.turnId;
    }
    await run({ app, offered, results, turns, dispatcher, gate: new FrozenAuthorityMcpPolicyGate(app.database, app.contentStore) });
    assert.deepEqual(errors, []);
  } finally {
    runner?.dispose();
    if (app) await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

const offeredMcp = (offered, id) => (offered.get(id) ?? []).filter(name => MCP_NAMES.includes(name)).sort();
/** The dispatcher's own offering for a Turn, before the provider adapter filters the request again. */
const dispatcherMcp = async ({ dispatcher, turns }, id) => (await dispatcher.definitions(turns[id])).map(tool => tool.name).filter(name => MCP_NAMES.includes(name)).sort();

async function forgedCallAllowed({ app, turns, gate }, conversationId) {
  const calls = (await rows(app, 'ToolCall', { turn_id: turns[conversationId] })).filter(call => call.tool_name === 'exa_search');
  assert.equal(calls.length, 1, `${conversationId} forged exactly one MCP call`);
  return (await gate.authorize({ toolCallId: calls[0].id, serverId: 'exa' })).toolPolicyAllowed;
}

test('an MCP server enabled globally reaches ordinary Agents but never the built-in read-only Agents or workflows', { timeout: 120000 }, async () => {
  await fixture(async (state) => {
    const { offered, results } = state;
    for (const id of ['explore', 'reviewer', 'readonly', 'review']) {
      assert.deepEqual(offeredMcp(offered, id), [], `${id} must not be offered MCP tools`);
      assert.deepEqual(await dispatcherMcp(state, id), [], `the dispatcher itself must not offer ${id} MCP tools`);
    }
    for (const id of ['main', 'custom', 'saved']) {
      assert.deepEqual(offeredMcp(offered, id), MCP_NAMES, `${id} keeps the globally enabled MCP servers`);
      assert.deepEqual(await dispatcherMcp(state, id), MCP_NAMES);
    }
    for (const id of ['explore', 'readonly']) {
      assert.notEqual(results.get(id)?.status, 'succeeded', `${id} forged MCP call must not run`);
      assert.equal(await forgedCallAllowed(state, id), false, `the MCP policy gate refuses ${id}`);
    }
  });
});

test('a list-less record at the read-only scope keeps the MCP restriction; only that scope can opt a source in', { timeout: 120000 }, async () => {
  await fixture(async (state) => {
    const { offered } = state;
    // Written by the cross-conversation switch at those scopes: no list, so the built-in lists stay.
    assert.deepEqual(offeredMcp(offered, 'reviewer'), []);
    assert.deepEqual(offeredMcp(offered, 'review'), []);
    // The opt-in: enabling a source in the Agent's own source settings admits that source only.
    assert.deepEqual(offeredMcp(offered, 'explore'), ['exa_search']);
    assert.deepEqual(await dispatcherMcp(state, 'explore'), ['exa_search']);
    assert.deepEqual(await dispatcherMcp(state, 'readonly'), []);
    assert.equal(await forgedCallAllowed(state, 'explore'), true);
    // A conversation below a read-only workflow cannot re-enable what the workflow denies.
    assert.deepEqual(offeredMcp(offered, 'readonly'), []);
    assert.equal(await forgedCallAllowed(state, 'readonly'), false);
  }, { policy: async (configuration) => {
    const switchOn = { run_agent: { config: { crossConversationCollaboration: true } } };
    await configuration.mutations.setToolPolicy({ scopeKind: 'agent', scopeId: 'reviewer', toolConfigs: switchOn });
    await configuration.mutations.setToolPolicy({ scopeKind: 'workflow', scopeId: 'builtin:review', toolConfigs: switchOn });
    await configuration.mutations.setToolPolicy({ scopeKind: 'agent', scopeId: 'explore', toolConfigs: switchOn, sourceConfigs: { exa: { enabled: true } } });
    await configuration.mutations.setToolPolicy({ scopeKind: 'conversation', scopeId: 'readonly', sourceConfigs: { exa: { enabled: true } } });
  } });
});

test('the MCP source admission contract names the key the code uses', async () => {
  const { TOOL_POLICY_ALL_MCP_SOURCES } = load('shared/protocol.js');
  const contract = JSON.parse(await fs.readFile(path.resolve('docs/architecture/reliable-kernel/contracts/tool.json'), 'utf8'));
  assert.ok(contract.mcpCapability.sourceAdmission.includes(`全来源拒绝'${TOOL_POLICY_ALL_MCP_SOURCES}'`));
});

/**
 * Admission as a directly dispatched ToolCall with no provider declaration to match, so only the
 * dispatcher's own frozen-policy check can refuse it.
 */
async function directAdmission({ declaration, toolPolicy }) {
  const document = {
    toolPolicy: { allowedTools: [], preset: 'custom', toolConfigs: {}, sourceConfigs: {}, ...toolPolicy },
    planReviewPolicy: { mode: 'off' },
    workEnvironmentPolicy: { enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null }
  };
  const records = {
    ToolCall: [{ id: 'call', turn_id: 'turn', tool_name: declaration.name, call_seq: 1n, status: 'pending' }],
    AuthoritySnapshot: [{ id: 'authority', turn_id: 'turn', content_object_id: 'authority-content' }],
    ContentObject: [{ id: 'authority-content' }],
    Turn: [{ id: 'turn', conversation_id: 'conversation', status: 'active' }]
  };
  const matching = read => (records[read.domain] ?? []).filter(row => Object.entries(read.where ?? {}).every(([key, value]) => row[key] === value));
  const settlements = [];
  const reached = [];
  const dispatcher = new ReliableToolDispatcher({
    database: {
      async snapshot(reads) { return { snapshot: reads.map(read => read.kind === 'get' ? (records[read.domain] ?? []).find(row => row.id === read.id) : matching(read)) }; },
      async snapshotAll(read) { return { snapshot: matching(read) }; }
    },
    contentStore: { async read() { return Buffer.from(JSON.stringify(document)); } },
    effects: {
      subscribeToolModelResults() { return () => {}; },
      async finalizeReadyInOrder() {},
      async readTerminalResult() { return null; },
      async settleWithoutEffect(input) { settlements.push(input); return { status: input.status }; }
    },
    mcp: { async prepare() { reached.push('mcp'); throw new Error('The MCP effect plane is not part of this fixture.'); } },
    host: { definitions: () => [{ execution: 'runtime', declaration, async execute() { throw new Error('not reached'); } }] }
  });
  await dispatcher.dispatch({ turnId: 'turn', modelRequestId: 'request', toolCallId: 'call', toolName: declaration.name, arguments: {} }).catch(() => undefined);
  return { rejected: settlements.filter(entry => entry.status === 'rejected').map(entry => entry.detail.reason), reached };
}

test('dispatch admission refuses an MCP call its source settings deny, even when the frozen list names it', async () => {
  const { TOOL_POLICY_ALL_MCP_SOURCES } = load('shared/protocol.js');
  const declaration = { ...mcpTool('exa', 'exa_search').declaration };
  for (const sourceConfigs of [{ [TOOL_POLICY_ALL_MCP_SOURCES]: { enabled: false } }, { exa: { enabled: false } }, { exa: { enabled: true, disabledTools: ['exa_search'] } }]) {
    const denied = await directAdmission({ declaration, toolPolicy: { allowedTools: ['exa_search'], sourceConfigs } });
    assert.deepEqual(denied.rejected, ['冻结 ToolPolicy 不允许工具 exa_search。'], JSON.stringify(sourceConfigs));
    assert.deepEqual(denied.reached, []);
  }
  const allowed = await directAdmission({ declaration, toolPolicy: { allowedTools: [], sourceConfigs: { exa: { enabled: true } } } });
  assert.deepEqual(allowed.rejected, [], 'an enabled source is admitted without a list entry');
  assert.deepEqual(allowed.reached, ['mcp']);
});

test('the request token estimate counts only the tools the frozen policy admits, MCP included', () => {
  const { estimateRequestAuthorityTokens } = load('backend/reliableKernel/contextTokenEstimator.js');
  const { TOOL_POLICY_ALL_MCP_SOURCES } = load('shared/protocol.js');
  const read = { name: 'read', description: 'Read a file.', parameters: { type: 'object' } };
  const search = { name: 'exa_search', description: 'Search the web with a long description. '.repeat(20), parameters: { type: 'object', properties: { query: { type: 'string' } } },
    source: { kind: 'mcp', sourceId: 'exa' } };
  const estimate = toolPolicy => estimateRequestAuthorityTokens({ toolPolicy }, { tools: [read, search] });
  const readOnly = estimateRequestAuthorityTokens({ toolPolicy: { allowedTools: ['read'] } }, { tools: [read] });
  const both = estimateRequestAuthorityTokens({ toolPolicy: { allowedTools: ['read', 'exa_search'] } }, { tools: [read, search] });
  assert.ok(both > readOnly);
  assert.equal(estimate({ allowedTools: ['read', 'exa_search'], sourceConfigs: { [TOOL_POLICY_ALL_MCP_SOURCES]: { enabled: false } } }), readOnly, 'an all-sources deny drops the listed MCP tool');
  assert.equal(estimate({ allowedTools: ['read', 'exa_search'], sourceConfigs: { exa: { enabled: false } } }), readOnly, 'a disabled source drops it');
  assert.equal(estimate({ allowedTools: ['read'], sourceConfigs: { exa: { enabled: true } } }), both, 'an enabled source counts without a list entry');
  assert.equal(estimate({ allowedTools: ['read', 'exa_search'] }), both, 'an unconfigured source falls back to the list');
});

test('every MCP enforcement point named by the contract decides through the shared rule', async () => {
  const contract = JSON.parse(await fs.readFile(path.resolve('docs/architecture/reliable-kernel/contracts/tool.json'), 'utf8'));
  const points = {
    '工具提供': 'backend/reliableKernel/toolDispatcher.ts',
    '派发准入': 'backend/reliableKernel/toolDispatcher.ts',
    'Provider适配器': 'backend/reliableKernel/llmCapabilityProviderAdapter.ts',
    'token估算': 'backend/reliableKernel/contextTokenEstimator.ts',
    'MCP policy gate': 'backend/reliableKernel/frozenMcpPolicyGate.ts',
    '设置页': 'webview/src/components/settings/tools/ToolPolicyEditor.vue'
  };
  for (const [point, file] of Object.entries(points)) {
    assert.ok(contract.mcpCapability.sourceAdmission.includes(point), `the contract names ${point}`);
    const source = await fs.readFile(path.resolve(file), 'utf8');
    assert.match(source, /import \{[^}]*\btoolAllowedByPolicy\b[^}]*\} from '(?:(?:\.\.\/)+|@)shared\/toolPolicyResolution'/, `${file} imports the shared rule`);
    assert.match(source.replace(/^import[^;]*;$/gm, ''), /\btoolAllowedByPolicy\(/, `${file} calls the shared rule`);
  }
  // The behaviour behind each point is pinned above (offering, admission, estimate, gate) and in the settings view tests.
});
