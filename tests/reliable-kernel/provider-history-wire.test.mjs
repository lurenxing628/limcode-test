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
const { ReliableConversationRunner } = load('backend/application/reliableKernel/ReliableConversationRunner.js');
const { ReliableToolDispatcher } = load('backend/reliableKernel/toolDispatcher.js');
const { createVscodeStoragePaths } = load('backend/capabilities/vscodeStorage/paths.js');
const { createDefaultLlmProviderConfig } = load('backend/capabilities/vscodeStorage/llmProviderConfigs.js');
const { dryRunLlmProvider } = load('backend/capabilities/llmProvider.js');
const { applyFrozenModelProviderConfig } = load('backend/reliableKernel/llmCapabilityProviderRegistry.js');
const { projectStoredModelFacingWindow } = load('backend/reliableKernel/modelFacingContextProjection.js');
const { LlmEventType } = load('backend/world/modules/llm/events.js');
const repo = name => kernel.DOMAIN_REPOSITORIES.domain(name);
const rows = async (app, domain, where) => (await app.database.snapshotAll(repo(domain).list({ where, orderBy: { column: 'id', direction: 'asc' }, limit: 100 }))).snapshot;

// 1x1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const CATALOG_MARKER = 'LimCode 托管附件目录';
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

/** The request's conversation as one line per entry: `R:kind` with R = u(ser)/a(ssistant)/t(ool). */
function wireShape(wire) {
  const isCatalog = value => JSON.stringify(value).includes(CATALOG_MARKER);
  if (Array.isArray(wire.messages)) {
    return wire.messages.filter(message => message.role !== 'system' && message.role !== 'developer').map(message => {
      if (message.role === 'tool') return `t:${message.tool_call_id}`;
      if (message.role === 'assistant') {
        const ids = message.tool_calls?.map(entry => entry.id)
          ?? (Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_use').map(block => block.id) : []);
        return ids.length ? `a:calls=${ids.join(',')}` : 'a:text';
      }
      if (Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result')) {
        return `u:${message.content.map(block => block.type === 'tool_result' ? `result=${block.tool_use_id}` : isCatalog(block) ? 'catalog' : block.type).join('+')}`;
      }
      return isCatalog(message) ? 'u:catalog' : 'u:text';
    });
  }
  if (Array.isArray(wire.contents)) {
    return wire.contents.map(content => `${content.role === 'model' ? 'a' : 'u'}:${content.parts.map(part =>
      part.functionCall ? `call=${part.functionCall.id ?? part.functionCall.name}`
        : part.functionResponse ? `result=${part.functionResponse.id ?? part.functionResponse.name}`
          : isCatalog(part) ? 'catalog' : part.inlineData ? 'media' : 'text').join('+')}`);
  }
  return wire.input.filter(item => item.role !== 'system' && item.role !== 'developer').map(item => {
    if (item.type === 'function_call') return `a:call=${item.call_id}`;
    if (item.type === 'function_call_output') return `t:${item.call_id}`;
    return `${item.role === 'assistant' ? 'a' : 'u'}:${isCatalog(item) ? 'catalog' : 'text'}`;
  });
}

const PROVIDERS = [
  ['openai-compatible', 'gpt-5.5'],
  // 官方 DeepSeek 接口：OpenAI 兼容渠道里走接入库的 DeepSeek 格式（工具结果可带图片）。
  ['openai-compatible', 'deepseek-v4-flash', 'https://api.deepseek.com/v1'],
  ['gemini', 'gemini-3.5-flash'],
  ['claude', 'claude-sonnet-5'],
  ['openai-responses', 'gpt-5.5']
];

/** Where the catalog of the screenshot lands in the request after one Turn of tool calls. */
async function catalogAfterToolTurn(providerKind, modelId, calls, baseUrl) {
  let shape, start;
  await fixture({ providerKind, modelId, baseUrl, async send(round, observed) {
    if (round === 1) return { role: 'model', parts: calls };
    if (round === 2) {
      shape = wireShape(observed.wire);
      start = observed.start;
    }
    return answer('Saw the screenshot.');
  } }, async ({ turn }) => { await turn('take a screenshot'); });
  return { shape, start };
}

for (const [providerKind, modelId, baseUrl] of PROVIDERS) {
  test(`${providerKind}/${modelId}: an attachment catalog after the first result of a parallel batch waits until the batch ends`, { timeout: 120000 }, async () => {
    const { shape } = await catalogAfterToolTurn(providerKind, modelId, [call('shot1', 'srv_shot'), call('list2', 'srv_list')], baseUrl);
    const expected = {
      // Chat Completions: every `tool` message directly after the assistant tool_calls (the dry-run
      // before this fix had the catalog user message between `tool shot1` and `tool list2`).
      'openai-compatible': ['u:text', 'a:calls=shot1,list2', 't:shot1', 't:list2', 'u:catalog'],
      // Gemini: both function responses in one turn right after the model's two calls (a split batch is a live 400).
      gemini: ['u:text', 'a:call=shot1+call=list2', 'u:result=shot1+result=list2', 'u:catalog'],
      // Claude: both tool_result blocks in the user message right after the tool_use blocks.
      claude: ['u:text', 'a:calls=shot1,list2', 'u:result=shot1+result=list2', 'u:catalog'],
      'openai-responses': ['u:text', 'a:call=shot1', 'a:call=list2', 't:shot1', 't:list2', 'u:catalog']
    }[providerKind];
    assert.deepEqual(shape, expected);
  });
}

test('an attachment catalog after a lone tool result stays directly after it', { timeout: 120000 }, async () => {
  for (const [providerKind, modelId] of [['openai-compatible', 'gpt-5.5'], ['gemini', 'gemini-3.5-flash']]) {
    const { shape } = await catalogAfterToolTurn(providerKind, modelId, [call('shot1', 'srv_shot')]);
    assert.deepEqual(shape, providerKind === 'gemini'
      ? ['u:text', 'a:call=shot1', 'u:result=shot1', 'u:catalog']
      : ['u:text', 'a:calls=shot1', 't:shot1', 'u:catalog']);
  }
});

test('the token estimate projects a parallel batch with the same catalog placement as the request', { timeout: 120000 }, async () => {
  let checked = false;
  await fixture({ providerKind: 'openai-compatible', modelId: 'gpt-5.5', async send(round, { request, start }) {
    if (round === 1) return { role: 'model', parts: [call('shot1', 'srv_shot'), call('list2', 'srv_list')] };
    if (round === 2) {
      const stored = projectStoredModelFacingWindow(request.context, request.attachmentCatalogState, request.recipe.modelHandleCatalog);
      const kinds = contents => contents.map(content => content.parts.map(part =>
        part.functionResponse ? 'result' : part.functionCall ? 'call' : JSON.stringify(part).includes(CATALOG_MARKER) ? 'catalog' : 'other').join('+'));
      assert.deepEqual(kinds(stored.contents), ['other', 'call+call', 'result', 'result', 'catalog']);
      assert.deepEqual(kinds(start.contents), kinds(stored.contents));
      checked = true;
    }
    return answer('done');
  } }, async ({ turn }) => { await turn('take a screenshot'); });
  assert.equal(checked, true);
});

/**
 * A native (Responses) history after a switch of model: the async call `call_async` is stored as its
 * own call occurrence and its result as a later occurrence, after the synchronous `call_list` exchange.
 */
function nativeHistoryRequest(providerKind, modelId, { lateResult = true } = {}) {
  const segment = (segmentId, segmentKind, messageRole, content, contentType = 'application/vnd.limcode.message+json') =>
    ({ segmentId, segmentKind, messageRole, contentType, content: JSON.stringify(content) });
  const asyncCall = { id: 'tool-call-async', providerCallId: 'call_async', responseId: 'resp-1', async: true, callSeq: '1',
    toolName: 'srv_shot', argumentsContentType: 'application/json', arguments: '{}' };
  const pairType = 'application/vnd.limcode.context-tool-pair+json';
  const nativeCall = segment('native-call', 'tool_pair', null, { kind: 'tool_pair', native: true, toolCall: asyncCall }, pairType);
  const nativeResult = segment('native-result', 'tool_pair', null, { kind: 'tool_pair', native: true, toolCall: asyncCall,
    toolModelResult: { id: 'result-async', messageRevisionId: 'revision-async', resultContentType: 'application/json', result: '{"status":"succeeded"}' } }, pairType);
  const exchange = [
    segment('list-call', 'message', 'model', { role: 'model', parts: [{ id: 'call_list', functionCall: { name: 'srv_list', args: {} } }] }),
    segment('list-result', 'tool_pair', null, { kind: 'tool_pair',
      toolCall: { id: 'tool-call-list', providerCallId: 'call_list', callSeq: '2', toolName: 'srv_list', argumentsContentType: 'application/json', arguments: '{}' },
      toolModelResult: { id: 'result-list', messageRevisionId: 'revision-list', resultContentType: 'application/json', result: '{"status":"succeeded"}' } }, pairType),
    segment('waiting', 'message', 'model', { role: 'model', parts: [{ text: 'Waiting for the job.' }] })
  ];
  return {
    kind: 'full-model-request', modelRequestId: 'model-request-native-history', conversationId: 'conversation-native-history',
    attemptSeq: '1', socketGeneration: '1', providerId: 'provider-config', modelId,
    authoritySnapshot: {
      model: { providerConfigId: 'provider-config', provider: providerKind, modelId },
      toolPolicy: { allowedTools: ['srv_shot', 'srv_list'], preset: 'custom' }
    },
    recipe: { tools: ['srv_shot', 'srv_list'].map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } })) },
    context: [
      segment('start', 'message', 'user', { role: 'user', parts: [{ text: 'start the long job and meanwhile list' }] }),
      nativeCall,
      ...(lateResult ? [...exchange, nativeResult] : [nativeResult, ...exchange]),
      segment('next', 'message', 'user', { role: 'user', parts: [{ text: 'is it done?' }] })
    ],
    attachmentCatalogState: { catalog: [], placements: [] }
  };
}

async function projectNativeHistory(providerKind, modelId, options) {
  let start;
  await new kernel.LlmCapabilityFullRequestAdapter('provider-config', {
    start(input, emit) { start = input; emit({ type: LlmEventType.Done, payload: { requestId: input.id } }); }, abort() {}, dispose() {}
  }).sendFullRequest(nativeHistoryRequest(providerKind, modelId, options), { async onEvent() { return { accepted: true, terminal: true, checkpointed: true }; } });
  const baseUrl = modelId.startsWith('deepseek') ? 'https://api.deepseek.com'
    : providerKind === 'claude' ? 'https://api.anthropic.com'
      : providerKind === 'gemini' ? 'https://generativelanguage.googleapis.com' : 'https://api.openai.com/v1';
  const settings = { ...createDefaultLlmProviderConfig({ name: 'native history' }), id: 'provider-config', provider: providerKind,
    baseUrl, model: modelId, apiKey: '' };
  const unified = start.contents.map(content => `${content.role === 'model' ? 'a' : 'u'}:${content.parts.map(part =>
    part.functionCall ? `call=${part.id}` : part.functionResponse ? `result=${part.id}` : 'text').join('+')}`);
  const body = (await dryRunLlmProvider(start, { settings })).body;
  return { unified, wire: wireShape(body), violations: toolPairingViolations(body) };
}

/**
 * Tool call/result pairing the provider itself enforces, checked on the encoded request body:
 * - Chat Completions: an assistant `tool_calls` message is followed by one `tool` message per call id.
 * - Claude Messages: every `tool_use` of an assistant message has its `tool_result` in the very next
 *   user message (https://docs.claude.com/en/docs/agents-and-tools/tool-use/implement-tool-use).
 * - Gemini: a model turn with N function calls is followed by a user turn with the N function
 *   responses (https://ai.google.dev/gemini-api/docs/function-calling).
 * - Responses: every `function_call` has a `function_call_output` later in the input.
 */
function toolPairingViolations(wire) {
  const violations = [];
  const sameIds = (expected, actual) => JSON.stringify([...expected].sort()) === JSON.stringify([...actual].sort());
  if (Array.isArray(wire.contents)) {
    wire.contents.forEach((content, index) => {
      const calls = content.parts.filter(part => part.functionCall).map(part => part.functionCall.id ?? part.functionCall.name);
      if (content.role !== 'model' || calls.length === 0) return;
      const next = wire.contents[index + 1];
      const results = next?.role === 'user' ? next.parts.filter(part => part.functionResponse)
        .map(part => part.functionResponse.id ?? part.functionResponse.name) : [];
      if (!sameIds(calls, results)) violations.push(`contents[${index}] calls ${calls} answered by ${results}`);
    });
    return violations;
  }
  if (Array.isArray(wire.messages)) {
    const messages = wire.messages;
    messages.forEach((message, index) => {
      if (message.role !== 'assistant') return;
      if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
        const calls = message.tool_calls.map(entry => entry.id);
        const results = [];
        for (let next = index + 1; messages[next]?.role === 'tool'; next += 1) results.push(messages[next].tool_call_id);
        if (!sameIds(calls, results)) violations.push(`messages[${index}] tool_calls ${calls} answered by ${results}`);
        return;
      }
      const calls = Array.isArray(message.content) ? message.content.filter(block => block.type === 'tool_use').map(block => block.id) : [];
      if (calls.length === 0) return;
      const next = messages[index + 1];
      const results = next?.role === 'user' && Array.isArray(next.content)
        ? next.content.filter(block => block.type === 'tool_result').map(block => block.tool_use_id) : [];
      if (!sameIds(calls, results)) violations.push(`messages[${index}] tool_use ${calls} answered by ${results}`);
    });
    return violations;
  }
  wire.input.forEach((item, index) => {
    if (item.type !== 'function_call') return;
    if (!wire.input.slice(index + 1).some(later => later.type === 'function_call_output' && later.call_id === item.call_id)) {
      violations.push(`input[${index}] function_call ${item.call_id} has no later output`);
    }
  });
  return violations;
}

for (const [providerKind, modelId] of [['openai-compatible', 'gpt-5.5'], ['openai-compatible', 'deepseek-v4-flash']]) {
  test(`${providerKind}/${modelId}: a native async result that arrived later is sent right after its call`, async () => {
    // Before: `assistant tool_calls=[call_async]` was followed by another assistant message, and
    // `tool call_async` came four messages later, which Chat Completions rejects.
    const late = await projectNativeHistory(providerKind, modelId);
    assert.deepEqual(late.wire,
      ['u:text', 'a:calls=call_async', 't:call_async', 'a:calls=call_list', 't:call_list', 'a:text', 'u:text']);
    assert.deepEqual(late.violations, []);
    // A result that already follows its call is sent exactly as before.
    assert.deepEqual((await projectNativeHistory(providerKind, modelId, { lateResult: false })).wire,
      ['u:text', 'a:calls=call_async', 't:call_async', 'a:calls=call_list', 't:call_list', 'a:text', 'u:text']);
  });
}

test('Claude and Gemini targets also receive a late native async result right after its call', async () => {
  // Before: Claude got `assistant tool_use(call_async), assistant tool_use(call_list), user tool_result(call_list), ...,
  // user tool_result(call_async)`; the two adjacent assistant messages merge and call_async has no tool_result in the
  // next user message (a 400). Gemini got the same order: a model turn with two calls answered by one response.
  const expected = {
    claude: ['u:text', 'a:calls=call_async', 'u:result=call_async', 'a:calls=call_list', 'u:result=call_list', 'a:text', 'u:text'],
    gemini: ['u:text', 'a:call=call_async', 'u:result=call_async', 'a:call=call_list', 'u:result=call_list', 'a:text', 'u:text']
  };
  for (const [providerKind, modelId] of [['claude', 'claude-sonnet-5'], ['gemini', 'gemini-3.5-flash']]) {
    const late = await projectNativeHistory(providerKind, modelId);
    assert.deepEqual(late.violations, [], providerKind);
    assert.deepEqual(late.wire, expected[providerKind], providerKind);
    const inPlace = await projectNativeHistory(providerKind, modelId, { lateResult: false });
    assert.deepEqual(inPlace.violations, [], providerKind);
    assert.deepEqual(inPlace.wire, expected[providerKind], providerKind);
  }
});

test('Responses keeps the chronological native placement', async () => {
  const chronological = ['u:text', 'a:call=call_async', 'a:call=call_list', 'u:result=call_list', 'a:text', 'u:result=call_async', 'u:text'];
  const responses = await projectNativeHistory('openai-responses', 'gpt-5.5');
  assert.deepEqual(responses.unified, chronological);
  assert.deepEqual(responses.wire,
    ['u:text', 'a:call=call_async', 'a:call=call_list', 't:call_list', 'a:text', 't:call_async', 'u:text']);
  assert.deepEqual(responses.violations, []);
});

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
