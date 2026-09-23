import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
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
  return (await gate.authorize({ toolCallId: calls[0].id, serverId: 'exa', toolName: 'search' })).toolPolicyAllowed;
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

test('the MCP source admission contract names the keys the code uses', async () => {
  const { TOOL_POLICY_ALL_MCP_SOURCES } = load('shared/protocol.js');
  const { toolConfigKey } = load('shared/toolPolicyResolution.js');
  const contract = JSON.parse(await fs.readFile(path.resolve('docs/architecture/reliable-kernel/contracts/tool.json'), 'utf8'));
  assert.ok(contract.mcpCapability.sourceAdmission.includes(`全来源拒绝'${TOOL_POLICY_ALL_MCP_SOURCES}'`));
  assert.ok(contract.mcpCapability.sourceAdmission.includes("'mcp:<来源id>/<原始工具名>'"));
  assert.equal(toolConfigKey({ name: 'exa_search_2', source: { kind: 'mcp', sourceId: 'exa', originalToolName: 'search' } }), 'mcp:exa/search');
  assert.equal(toolConfigKey({ name: 'x', source: { kind: 'mcp', sourceId: 'id/with:odd', originalToolName: 'a/b' } }), 'mcp:id%2Fwith%3Aodd/a/b', 'the source id splits one way only');
  assert.equal(toolConfigKey({ name: 'read' }), 'read');
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
  const prepared = [];
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
    mcp: { async prepare(input) { reached.push('mcp'); prepared.push(input); throw new Error('The MCP effect plane is not part of this fixture.'); } },
    host: { definitions: () => [{ execution: 'runtime', declaration, async execute() { throw new Error('not reached'); } }] }
  });
  await dispatcher.dispatch({ turnId: 'turn', modelRequestId: 'request', toolCallId: 'call', toolName: declaration.name, arguments: {} }).catch(() => undefined);
  return { rejected: settlements.filter(entry => entry.status === 'rejected').map(entry => entry.detail.reason), reached, prepared };
}

test('dispatch admission refuses an MCP call its source settings deny, even when the frozen list names it', async () => {
  const { TOOL_POLICY_ALL_MCP_SOURCES } = load('shared/protocol.js');
  const declaration = { ...mcpTool('exa', 'exa_search').declaration };
  for (const sourceConfigs of [{ [TOOL_POLICY_ALL_MCP_SOURCES]: { enabled: false } }, { exa: { enabled: false } }, { exa: { enabled: true, disabledTools: ['search'] } }, {}]) {
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
    source: { kind: 'mcp', sourceId: 'exa', originalToolName: 'search' } };
  const estimate = toolPolicy => estimateRequestAuthorityTokens({ toolPolicy }, { tools: [read, search] });
  const readOnly = estimateRequestAuthorityTokens({ toolPolicy: { allowedTools: ['read'] } }, { tools: [read] });
  const both = estimateRequestAuthorityTokens({ toolPolicy: { allowedTools: ['read'], sourceConfigs: { exa: { enabled: true } } } }, { tools: [read, search] });
  assert.ok(both > readOnly);
  assert.equal(estimate({ allowedTools: ['read', 'exa_search'], sourceConfigs: { [TOOL_POLICY_ALL_MCP_SOURCES]: { enabled: false } } }), readOnly, 'an all-sources deny drops the listed MCP tool');
  assert.equal(estimate({ allowedTools: ['read', 'exa_search'], sourceConfigs: { exa: { enabled: false } } }), readOnly, 'a disabled source drops it');
  assert.equal(estimate({ allowedTools: ['read'], sourceConfigs: { exa: { enabled: true } } }), both, 'an enabled source counts without a list entry');
  assert.equal(estimate({ allowedTools: ['read', 'exa_search'] }), readOnly, 'a list naming the tool of an unconfigured source counts nothing');
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

test('MCP tool names do not depend on which server connects first, stay within 64 characters, and a per-tool disable keeps its tool', { timeout: 120000 }, async () => {
  const { McpRuntimeManager, dedupeMcpToolNames } = load('backend/application/mcpRuntimeManager.js');
  const { toolAllowedByPolicy } = load('shared/toolPolicyResolution.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-mcp-names-'));
  try {
    // A real stdio MCP server whose tool names come from its arguments.
    const script = path.join(root, 'server.cjs');
    await fs.writeFile(script, `
const { Server } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/index.js'))});
const { StdioServerTransport } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});
const { ListToolsRequestSchema } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/types.js'))});
const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: process.argv.slice(2).map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) }));
server.connect(new StdioServerTransport());
`);
    const config = (id, name, tools, enabled) => ({ id, name, enabled, transport: { kind: 'stdio', command: process.execPath, args: [script, ...tools] }, createdAt: 1, updatedAt: 1 });
    // A 49-character tool name: with a long server prefix the full name would pass the 64-character
    // function-name limit of OpenAI and Gemini.
    const LONG = 'list_all_repository_collaborators_with_permission';
    const LONG_SERVER = 'A very long server name that keeps going for quite a while';
    const servers = [
      ['mcp-server-a', '搜索服务', ['search']], ['mcp-server-b', '文件工具', ['search', LONG]],
      ['mcp-upper', 'Search!', ['find']], ['mcp-lower', 'search?', ['find']],
      ['mcp-exa', 'exa', ['search']],
      ['mcp-long-1', LONG_SERVER, [LONG]], ['mcp-long-2', `${LONG_SERVER}!`, [LONG]]
    ];
    /** Connects the servers one at a time in this order, as separate refreshes would; returns sourceId/original name -> tool name. */
    const namesConnectingIn = async (order) => {
      let settings = { servers: [] };
      const manager = new McpRuntimeManager({ async loadGlobalSettings() { return { settings }; } });
      try {
        for (let count = 1; count <= order.length; count += 1) {
          const enabled = new Set(order.slice(0, count));
          settings = { servers: servers.map(([id, name, tools]) => config(id, name, tools, enabled.has(id))) };
          await manager.refreshFromSettings({ discover: true });
        }
        assert.deepEqual(manager.sourceRecords().map(source => source.status), servers.map(([id]) => order.includes(id) ? 'connected' : 'disabled'));
        return Object.fromEntries(dedupeMcpToolNames(manager.runtimeTools(), ['read', 'search', 'run_agent'])
          .map(tool => [`${tool.declaration.source.sourceId}/${tool.declaration.source.originalToolName}`, tool.declaration.name]));
      } finally { await manager.dispose(); }
    };
    const ids = servers.map(([id]) => id);
    const forward = await namesConnectingIn(ids);
    const backward = await namesConnectingIn([...ids].reverse());
    assert.deepEqual(backward, forward, 'the same tool gets the same name whichever server connected first');
    assert.equal(new Set(Object.values(forward)).size, Object.keys(forward).length, 'names stay unique');
    assert.equal(forward['mcp-exa/search'], 'exa_search', 'an ordinary server name keeps its prefix');
    // A server name with no ASCII letters falls back to a short stable hash of the server id, never the whole id.
    const hash8 = (value) => createHash('sha256').update(value).digest('hex').slice(0, 8);
    assert.equal(forward['mcp-server-a/search'], `mcp-${hash8('mcp-server-a')}_search`);
    assert.equal(forward['mcp-server-b/search'], `mcp-${hash8('mcp-server-b')}_search`);
    assert.equal(forward[`mcp-server-b/${LONG}`], `mcp-${hash8('mcp-server-b')}_${LONG}`, '14 + 49 characters fit');
    for (const [key, name] of Object.entries(forward)) {
      assert.ok(name.length <= 64, `${key} -> ${name} (${name.length})`);
      assert.match(name, /^[a-zA-Z0-9_-]+$/);
    }
    // Too long a name is cut to 64 with a hash of the whole name; the same cut name from another server is told apart.
    const longOne = forward[`mcp-long-1/${LONG}`], longTwo = forward[`mcp-long-2/${LONG}`];
    const full = `a-very-long-server-name-that-keeps-going-for-quite-a-while_${LONG}`;
    assert.equal(longOne, `${full.slice(0, 55)}_${hash8(full)}`);
    assert.equal(longTwo.length, 64);
    assert.notEqual(longTwo, longOne);
    // The names of one fallback-named server do not change when the other one is not connected.
    const aloneA = await namesConnectingIn(['mcp-server-a']);
    assert.equal(aloneA['mcp-server-a/search'], forward['mcp-server-a/search']);
    assert.deepEqual(await namesConnectingIn(ids), forward, 'the names are the same on every run');

    // A per-tool disable names the tool as its server does, so it disables that tool, and only it, whatever the display names.
    const policy = { allowedTools: [], sourceConfigs: { 'mcp-server-a': { enabled: true, disabledTools: ['search'] }, 'mcp-server-b': { enabled: true } } };
    const allowed = (names, key) => toolAllowedByPolicy(policy, { name: names[key], source: { kind: 'mcp', sourceId: key.split('/')[0], originalToolName: key.split('/')[1] } });
    for (const names of [forward, backward]) {
      assert.equal(allowed(names, 'mcp-server-a/search'), false);
      assert.equal(allowed(names, 'mcp-server-b/search'), true);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('MCP tool names every model API rejects get a stable provider-safe name; valid names and the original-name identity stay as they were', { timeout: 120000 }, async () => {
  // Live Chat, Responses, Claude and Gemini requests all answer one such name with a 400 for the whole
  // request (`.`, `/`, a space, non-ASCII; Gemini also a first character that is not a letter or `_`).
  const { McpRuntimeManager, dedupeMcpToolNames } = load('backend/application/mcpRuntimeManager.js');
  const { toolAllowedByPolicy, toolConfigKey } = load('shared/toolPolicyResolution.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-mcp-safe-names-'));
  try {
    const script = path.join(root, 'server.cjs');
    await fs.writeFile(script, `
const { Server } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/index.js'))});
const { StdioServerTransport } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/server/stdio.js'))});
const { ListToolsRequestSchema } = require(${JSON.stringify(require.resolve('@modelcontextprotocol/sdk/types.js'))});
const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: process.argv.slice(2).map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })) }));
server.connect(new StdioServerTransport());
`);
    const LONG_DOTTED = `x.${'y'.repeat(80)}`;
    const servers = [
      ['mcp-github', 'GitHub', ['repos.list', 'repos/list', 'repos_list', 'search']],
      ['mcp-fs', 'fs', ['files/read']],
      ['mcp-weather', 'my-server', ['get weather']],
      ['mcp-notes', 'notes', ['创建笔记', 'create']],
      ['mcp-7zip', '7zip', ['extract']],
      ['mcp-long', 'long', [LONG_DOTTED]]
    ];
    const names = async () => {
      const settings = { servers: servers.map(([id, name, tools]) => ({ id, name, enabled: true, transport: { kind: 'stdio', command: process.execPath, args: [script, ...tools] }, createdAt: 1, updatedAt: 1 })) };
      const manager = new McpRuntimeManager({ async loadGlobalSettings() { return { settings }; } });
      try {
        await manager.refreshFromSettings({ discover: true });
        assert.deepEqual(manager.sourceRecords().map(source => source.status), servers.map(() => 'connected'));
        return dedupeMcpToolNames(manager.runtimeTools(), ['read', 'search', 'run_agent']);
      } finally { await manager.dispose(); }
    };
    const tools = await names();
    const byKey = Object.fromEntries(tools.map(tool => [`${tool.declaration.source.sourceId}/${tool.declaration.source.originalToolName}`, tool.declaration.name]));
    const hash8 = (value) => createHash('sha256').update(value).digest('hex').slice(0, 8);
    assert.deepEqual(byKey, {
      'mcp-github/repos.list': `github_repos_list_${hash8('github_repos.list')}`,
      'mcp-github/repos/list': `github_repos_list_${hash8('github_repos/list')}`,
      'mcp-github/repos_list': 'github_repos_list',
      'mcp-github/search': 'github_search',
      'mcp-fs/files/read': `fs_files_read_${hash8('fs_files/read')}`,
      'mcp-weather/get weather': `my-server_get_weather_${hash8('my-server_get weather')}`,
      'mcp-notes/创建笔记': `notes_${hash8('notes_创建笔记')}`,
      'mcp-notes/create': 'notes_create',
      'mcp-7zip/extract': `_7zip_extract_${hash8('7zip_extract')}`,
      [`mcp-long/${LONG_DOTTED}`]: `${`long_x_${'y'.repeat(80)}`.slice(0, 55)}_${hash8(`long_${LONG_DOTTED}`)}`
    }, 'valid names are byte-identical; others are rewritten and always carry the hash of the name they replace');
    for (const name of Object.values(byKey)) {
      assert.match(name, /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/, `${name} is accepted by OpenAI, Claude and Gemini`);
    }
    assert.equal(new Set(Object.values(byKey)).size, tools.length, 'names that differ only in rewritten characters stay apart');
    assert.deepEqual(Object.fromEntries((await names()).map(tool => [`${tool.declaration.source.sourceId}/${tool.declaration.source.originalToolName}`, tool.declaration.name])), byKey,
      'the names are the same after a restart');

    // Settings and dispatch keep naming the tool as its server does.
    const dotted = tools.find(tool => tool.declaration.source.originalToolName === 'repos.list');
    assert.equal(toolConfigKey(dotted.declaration), 'mcp:mcp-github/repos.list');
    const policy = { allowedTools: [], sourceConfigs: { 'mcp-github': { enabled: true, disabledTools: ['repos.list'] } } };
    assert.deepEqual(tools.filter(tool => tool.declaration.source.sourceId === 'mcp-github').map(tool => [tool.declaration.source.originalToolName, toolAllowedByPolicy(policy, tool.declaration)]),
      [['repos.list', false], ['repos/list', true], ['repos_list', true], ['search', true]]);
    // The per-tool auto-approve saved under the original-name key reaches the call made by the rewritten name.
    const chinese = tools.find(tool => tool.declaration.source.originalToolName === '创建笔记').declaration;
    const dispatched = await directAdmission({ declaration: chinese, toolPolicy: { allowedTools: [],
      sourceConfigs: { 'mcp-notes': { enabled: true } }, toolConfigs: { 'mcp:mcp-notes/创建笔记': { autoApproveExecution: true } } } });
    assert.deepEqual(dispatched.rejected, []);
    assert.deepEqual(dispatched.prepared.map(input => [input.serverId, input.toolName]), [['mcp-notes', '创建笔记']], 'the server is called with its own tool name');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
