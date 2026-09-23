import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiledRoot, 'backend/reliableKernel/index.js'));
const { createLlmProviderCapability } = require(path.join(compiledRoot, 'backend/capabilities/llmProvider.js'));
const { resetOpenAIResponsesWebSocketSessions } = require(path.join(compiledRoot, 'backend/capabilities/openAIResponsesWebSocketSession.js'));
const { WebSocketServer } = require('ws');
const MODEL = 'gpt-6-astra';
const NATIVE_SETTINGS = {
  enabled: true, asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function until(read, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function rows(app, domain, where = {}) {
  return (await app.database.snapshotAll(kernel.DOMAIN_REPOSITORIES.domain(domain).list({
    where, orderBy: { column: 'id', direction: 'asc' }, limit: 100
  }))).snapshot;
}

async function forkNativeMessage(app, conversationId, modelRequestId, key) {
  const [head] = await rows(app, 'ConversationContextHeadLink', { conversation_id: conversationId });
  const [output] = await rows(app, 'ModelRequestMessageLink', { model_request_id: modelRequestId });
  const [current] = await rows(app, 'MessageCurrentRevisionLink', { message_id: output.message_id });
  const structure = await app.context.materializeStructure(head.root_id);
  return app.runtime.conversationFork.fork({
    idempotencyKey: key, reuseKey: key,
    sourceConversationId: conversationId, sourceContextRootId: head.root_id,
    sourceContextEndSegmentId: structure.records.at(-1).segment.id,
    sourceMessageRevisionId: current.revision_id, expectedCurrentMessageRevisionId: current.revision_id,
    targetTitle: key, targetAgentId: 'agent-main'
  });
}

async function createSettingsAuthority(directory, provider) {
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
  let authority;
  try {
    const { VscodeConfigurationAuthority } = require(path.join(compiledRoot, 'backend/reliableKernel/vscodeConfigurationAuthority.js'));
    const { createVscodeStoragePaths } = require(path.join(compiledRoot, 'backend/capabilities/vscodeStorage/paths.js'));
    authority = new VscodeConfigurationAuthority(() => createVscodeStoragePaths(Uri.file(path.join(directory, 'settings'))));
  } finally { Module._load = originalLoad; }
  const save = async (section, settings) => authority.saveGlobalSettings(section, settings, (await authority.loadGlobalSettings(section)).revision);
  await save('llmProviderConfigs', { configs: [provider] });
  await save('llm', { activeProviderConfigId: provider.id });
  const agent = await authority.mutations.createAgent({ name: 'native actual authority', kind: 'custom' });
  await authority.mutations.setToolPolicy({ scopeKind: 'global', allowedTools: ['native_probe'], toolConfigs: { native_probe: { nativeAsync: true, autoApproveExecution: true, autoSubmitResult: true, config: {} } } });
  const { createDefaultLlmCompressionConfig } = require(path.join(compiledRoot, 'shared/protocol.js'));
  const compression = { ...createDefaultLlmCompressionConfig('synthetic native compression'), kind: 'deterministic_summary', bodyTargetTokens: 2048, llmSummary: { targetTokens: 1024 }, trigger: { mode: 'manual', thresholdUnit: 'tokens', thresholdTokens: 120000 } };
  await save('llmCompressionConfigs', { configs: [compression] });
  await save('llmCompression', { defaultConfigId: compression.id, providerBindings: [], modelBindings: [] });
  return { authority, agentId: agent.id, async enableCompression() {
    await save('llmCompressionConfigs', { configs: [{ ...compression, trigger: { mode: 'token_threshold', thresholdUnit: 'tokens', thresholdTokens: 10000 } }] });
  } };
}

async function withNativeRuntime(run, { transport = 'websocket', realAuthority = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-native-integration-'));
  const probePath = path.join(directory, 'probe.txt');
  await fs.writeFile(probePath, 'content from the real native probe file');
  const releaseTool = deferred();
  const frames = [];
  const drives = [];
  let turnFailure;
  let executions = 0;
  let httpCalls = 0;
  let sequence = 0;
  const server = http.createServer((request, response) => {
    httpCalls += 1;
    if (transport !== 'http') {
      response.writeHead(500);
      response.end('This fixture exercises only the native WebSocket path.');
      return;
    }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.once('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      frames.push({ response, body: JSON.parse(body) });
      response.flushHeaders();
    });
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => {
    socket.on('message', bytes => { frames.push({ socket, body: JSON.parse(bytes.toString()) }); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const configuration = {
    id: 'native-integration-provider', name: 'Native integration', provider: 'openai-responses',
    baseUrl, model: MODEL, models: [{ id: MODEL, name: MODEL }], apiKey: 'offline-test-key',
    toolCallFormat: 'function-call', openaiResponsesTransport: transport,
    nativeResponses: NATIVE_SETTINGS, stream: true, retryOnError: false, retryMaxAttempts: 0,
    enableMultimodalTools: true, promptCache: { enabled: false, mode: 'key', ttl: '30m' },
    modelConfigs: [], createdAt: 1, updatedAt: 1
  };
  const capability = createLlmProviderCapability({ settings: configuration });
  const adapter = new kernel.LlmCapabilityFullRequestAdapter(configuration.id, capability);
  const definition = {
    declaration: {
      name: 'native_probe', description: 'Read the isolated integration probe file.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      source: { kind: 'builtin' },
      metadata: { readonly: true, defaultAutoApproveExecution: true, defaultAutoSubmitResult: true }
    },
    execution: 'runtime',
    async execute(_arguments, _dependencies, context) {
      executions += 1;
      await releaseTool.promise;
      context.signal.throwIfAborted();
      return { ok: true, output: await fs.readFile(probePath, 'utf8') };
    }
  };
  const stored = realAuthority ? await createSettingsAuthority(directory, configuration) : undefined;
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  let app;
  try {
    app = await kernel.ReliableKernelApplication.open(authority, {
      authorityCompiler: stored?.authority ?? {
        async compile(request) {
          return {
            turnId: request.turnId, executorAgentId: request.executorAgentId,
            executionPreset: { content: JSON.stringify({ providerConfigId: configuration.id, modelId: configuration.model }) },
            authoritySnapshot: {
              content: JSON.stringify({
                kind: 'effective-turn-authority', turnId: request.turnId,
                conversationId: request.conversationId, executorAgentId: request.executorAgentId,
                model: {
                  providerConfigId: configuration.id, provider: 'openai-responses', modelId: configuration.model,
                  baseUrl, openaiResponsesTransport: transport, nativeResponses: NATIVE_SETTINGS,
                  thinkingConfig: configuration.generationConfig?.thinkingConfig,
                  retryPolicy: { enabled: false, maxRetries: 0 }
                },
                modelProfile: {
                  compressionThresholdTokens: 100000, contextWindowTokens: 128000,
                  tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 }
                },
                planReviewPolicy: { mode: 'never' },
                toolPolicy: {
                  id: 'native-integration-policy', allowedTools: ['native_probe'], preset: 'custom',
                  toolConfigs: { native_probe: {
                    nativeAsync: true, autoApproveExecution: true, autoSubmitResult: true, config: {}
                  } }, sourceConfigs: {}
                },
                systemPrompt: { id: 'native-integration-prompt', text: '' },
                runtimeContext: { id: null, name: '', template: '' },
                workEnvironmentPolicy: {
                  id: null, enabled: false, allowedWorkEnvironmentIds: [], defaultWorkEnvironmentId: null
                }
              })
            }
          };
        }
      },
      ...(stored ? { compressionSettingsAuthority: stored.authority } : {}),
      resolveWorkEnvironment: async () => undefined,
      mcpConnections: {
        async toolAnnotations() { return {}; },
        async callTool() { throw new Error('The native probe is not an MCP tool.'); }
      },
      mcpPolicyGate: {
        async authorize() { throw new Error('The native probe must not enter the MCP policy path.'); }
      },
      attachmentSettings: {
        async loadGlobalSettings() {
          return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' };
        }
      },
      providers: { resolve(providerId) { assert.equal(providerId, configuration.id); return adapter; } },
      createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) =>
        new kernel.ReliableToolDispatcher({
          database, contentStore, effects: runtime.effects, files, fileMutations, processes, mcp, interactions,
          host: {
            definitions() { return [definition]; },
            executeNoEffect(tool, input, _authority, emit, signal) {
              return tool.execute(input.arguments, undefined, { signal, emit });
            }
          }
        })
    });
    const conversationId = 'native-integration-conversation';
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: conversationId, title: 'Native integration', status: 'active', created_at: now, updated_at: now
      }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: 'native-integration-agent-link', conversation_id: conversationId, agent_id: stored?.agentId ?? 'agent-main',
        role: 'default', created_at: now, updated_at: now
      })
    ]);
    async function startTurn(key, content, targetConversationId = conversationId) {
      const started = await app.turns.input({
        source: { kind: 'command', key }, conversationId: targetConversationId, leaseOwnerId: 'native-integration-owner',
        hostBootId: app.database.hostBootId, leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), content
      });
      turnFailure = undefined;
      const [lease] = await rows(app, 'ExecutionLease', { turn_id: started.turnId });
      assert.ok(lease, 'the fixture must drive under its acquired execution lease');
      const fence = {
        id: lease.id, conversationId: lease.conversation_id, turnId: lease.turn_id,
        ownerId: lease.owner_id, hostBootId: lease.host_boot_id, generation: BigInt(lease.generation)
      };
      const completion = kernel.runWithExecutionLeaseFence(fence, () => app.agentLoop.drive(started.turnId));
      void completion.then(async result => {
        if (result.terminalStatus === 'completed') return;
        const terminations = await rows(app, 'TurnTermination', { turn_id: started.turnId });
        turnFailure = new Error(`Native Turn ${started.turnId} ended ${result.terminalStatus}: ${terminations.map(row => row.reason).join('; ')}`);
      }).catch(error => { turnFailure = error; });
      drives.push(completion);
      return { ...started, completion };
    }
    function send(socket, event) {
      const payload = JSON.stringify({ sequence_number: ++sequence, ...event });
      if (transport === 'http') socket.write(`data: ${payload}\n\n`);
      else socket.send(payload);
    }
    function created(socket, responseId, previousResponseId) {
      send(socket, { type: 'response.created', response: {
        id: responseId, status: 'in_progress', model: configuration.model, output: [],
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {})
      } });
    }
    function text(socket, responseId, index, value) {
      const item = {
        type: 'message', id: `${responseId}-message-${index}`, role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: value, annotations: [] }]
      };
      send(socket, { type: 'response.output_text.delta', response_id: responseId,
        item_id: item.id, output_index: index, content_index: 0, delta: value });
      send(socket, { type: 'response.output_item.done', response_id: responseId, output_index: index, item });
      return item;
    }
    function completed(socket, responseId, output) {
      send(socket, { type: 'response.completed', response: {
        id: responseId, status: 'completed', model: configuration.model, output,
        usage: { input_tokens: realAuthority ? 50000 : 10, output_tokens: 5, total_tokens: realAuthority ? 50005 : 15 }
      } });
      if (transport === 'http') socket.end('data: [DONE]\n\n');
    }
    function configureModel(model, thinkingLevel, reasoningMode) {
      configuration.model = model;
      configuration.models = [{ id: model, name: model }];
      configuration.generationConfig = { thinkingConfig: { thinkingLevel, ...(reasoningMode ? { reasoningMode } : {}) } };
    }
    await run({
      app, conversationId, startTurn, frames, send, created, text, completed, stored, configuration,
      async setThinking(value) {
        assert.ok(stored);
        await stored.authority.mutations.setModelProfile({ scopeKind: 'conversation', scopeId: conversationId,
          providerConfigId: configuration.id, provider: configuration.provider, model: configuration.model,
          thinkingOverride: value ? { kind: 'openai-effort', value } : null });
      },
      until: (read, label) => until(async () => {
        if (turnFailure) throw turnFailure;
        return read();
      }, label),
      releaseTool, configureModel, executions: () => executions, httpCalls: () => httpCalls
    });
  } finally {
    releaseTool.resolve();
    resetOpenAIResponsesWebSocketSessions();
    for (const socket of sockets.clients) socket.terminate();
    for (const frame of frames) frame.response?.destroy();
    if (app) await app.close();
    await Promise.allSettled(drives);
    await Promise.all([
      new Promise(resolve => sockets.close(resolve)),
      new Promise(resolve => server.close(resolve))
    ]);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

for (const transport of ['http', 'websocket']) test(`review P1-2真实authority high恢复默认与auto compression组合 ${transport}`, { timeout: 60000 }, async () => {
  await withNativeRuntime(async h => {
    const connection = frame => frame.socket ?? frame.response;
    // Seed low base, then apply high via a configuration_update so the next native recipe
    // carries high in updates, rather than using high merely as its initial base effort.
    for (const [index, effort] of ['low', 'high'].entries()) {
      await h.setThinking(effort);
      const seed = await h.startTurn(`review-seed-${index}`, index === 0 ? 'synthetic historical evidence '.repeat(18000) : 'raise effort');
      const frame = await h.until(() => h.frames[index], `seed ${effort}`);
      h.created(connection(frame), `review-seed-response-${index}`);
      h.completed(connection(frame), `review-seed-response-${index}`, [h.text(connection(frame), `review-seed-response-${index}`, 0, 'done')]);
      assert.equal((await seed.completion).terminalStatus, 'completed');
    }
    const turn = await h.startTurn('review-native-carried-high', 'use native probe');
    const first = await h.until(() => h.frames[2], 'carried high initial');
    h.created(connection(first), 'review-high-1');
    const call = { type: 'function_call', id: 'review-tool-item', call_id: 'review-tool-call', name: 'native_probe', arguments: '{}', async: true, status: 'completed' };
    h.send(connection(first), { type: 'response.output_item.done', response_id: 'review-high-1', output_index: 0, item: call });
    await h.until(() => h.executions() === 1, 'pending native tool');
    await h.setThinking(null);
    await h.stored.enableCompression();
    h.completed(connection(first), 'review-high-1', [call]);
    h.releaseTool.resolve();
    const continuation = await h.until(() => h.frames[3], 'same-request native tool continuation');
    h.created(connection(continuation), 'review-tool-finished');
    h.completed(connection(continuation), 'review-tool-finished', [h.text(connection(continuation), 'review-tool-finished', 0, 'done')]);
    assert.equal((await turn.completion).terminalStatus, 'completed');
    // This transport fixture covers a new Turn; the same-Turn fresh/pending precedence red
    // regression is driven through real kernel requests in session-thinking-runtime.test.mjs.
    const next = await h.startTurn('review-new-request-reset', 'new request after tool completion');
    const frame = await h.until(() => h.frames[4], 'new ordinary request after automatic compression');
    h.created(connection(frame), 'review-restored');
    h.completed(connection(frame), 'review-restored', [h.text(connection(frame), 'review-restored', 0, 'done')]);
    assert.equal((await next.completion).terminalStatus, 'completed');
    assert.ok((await rows(h.app, 'CompressionBlock')).length > 0, 'real automatic compression must have executed');
    assert.equal(frame.body.reasoning?.effort, undefined);
    assert.deepEqual(frame.body.input.filter(item => item.type === 'configuration_update'), []);
    assert.equal(frame.body.previous_response_id, undefined);
    const calls = new Set(frame.body.input.filter(item => item.type === 'function_call').map(item => item.call_id));
    for (const output of frame.body.input.filter(item => item.type === 'function_call_output')) assert.ok(calls.has(output.call_id), 'tool pair kept together on full rebase');
    assert.equal(h.executions(), 1, 'no duplicate side effect');
  }, { transport, realAuthority: true });
});

test('Astra executes a durable async call before response completion and delivers its original result once', { timeout: 60_000 }, async () => {
  await withNativeRuntime(async harness => {
    const { app, conversationId, frames, created, text, completed, send, until } = harness;
    const turn = await harness.startTurn('native-first-turn', 'Start the probe and continue while it runs.');
    const first = await until(() => frames.find(frame => frame.body.type === 'response.create'), 'initial native request');
    assert.equal(first.body.model, MODEL);
    assert.equal(first.body.tools.find(tool => tool.name === 'native_probe')?.async, true);
    created(first.socket, 'native-response-1');
    const prefix = text(first.socket, 'native-response-1', 0, 'Before the background call.');
    const call = {
      type: 'function_call', id: 'native-function-item', call_id: 'original-native-call',
      name: 'native_probe', arguments: '{}', async: true, status: 'completed'
    };
    send(first.socket, {
      type: 'response.output_item.done', response_id: 'native-response-1', output_index: 1, item: call
    });
    await until(() => harness.executions() === 1, 'native execution before response.completed');
    const [admitted] = await rows(app, 'ToolCall', { turn_id: turn.turnId });
    assert.ok(admitted);
    const [request] = await rows(app, 'ModelRequest', { turn_id: turn.turnId });
    assert.equal(request.status, 'streaming');
    assert.equal((await rows(app, 'ToolModelResult', { tool_call_id: admitted.id })).length, 0);
    await assert.rejects(app.runtime.effects.assertNativeWorkSettledForConversation(conversationId), {
      code: 'NATIVE_ASYNC_WORK_PENDING'
    });
    const suffix = text(first.socket, 'native-response-1', 2, 'Continuing while the probe is still running.');
    completed(first.socket, 'native-response-1', [prefix, call, suffix]);
    harness.releaseTool.resolve();
    const delivery = await until(() => frames.find(frame => frame.body.type === 'response.create'
      && frame.body.input?.some(item => item.type === 'function_call_output')), 'native result delivery');
    assert.equal(delivery.body.previous_response_id, 'native-response-1');
    const outputs = delivery.body.input.filter(item => item.type === 'function_call_output');
    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].call_id, 'original-native-call');
    assert.match(JSON.stringify(outputs[0].output), /content from the real native probe file/);
    assert.equal((await rows(app, 'ToolCallEvent', { tool_call_id: admitted.id, event_kind: 'native_delivery' })).length, 0);
    created(delivery.socket, 'native-response-2', 'native-response-1');
    const answer = text(delivery.socket, 'native-response-2', 0, 'The probe result has arrived.');
    completed(delivery.socket, 'native-response-2', [answer]);
    const finished = await turn.completion;
    assert.equal(finished.terminalStatus, 'completed');
    assert.equal(harness.executions(), 1);
    assert.equal(harness.httpCalls(), 0);
    assert.equal((await rows(app, 'ToolModelResult', { tool_call_id: admitted.id })).length, 1);
    assert.equal((await rows(app, 'ToolCallEvent', { tool_call_id: admitted.id, event_kind: 'native_delivery' })).length, 1);
    assert.deepEqual(await app.runtime.effects.listNativePendingWork({ conversationId }), []);
    const [head] = await rows(app, 'ConversationContextHeadLink', { conversation_id: conversationId });
    const [callSource] = await rows(app, 'ContextSegmentSource', { source_kind: 'tool_call', source_id: admitted.id });
    const [resultRow] = await rows(app, 'ToolModelResult', { tool_call_id: admitted.id });
    const [resultSource] = await rows(app, 'ContextSegmentSource', { source_kind: 'tool_model_result', source_id: resultRow.id });
    // The result settled after the call; a cut at the call moves that result behind the cut
    // instead of extending the fork over the later suffix text.
    const cut = await app.runtime.conversationFork.fork({
      idempotencyKey: 'native-cut-at-call-fork', reuseKey: 'native-cut-at-call-fork',
      sourceConversationId: conversationId, sourceContextRootId: head.root_id,
      sourceContextEndSegmentId: callSource.segment_id, targetTitle: 'Cut at native call', targetAgentId: 'agent-main'
    });
    const cutSegments = (await app.context.materializeStructure(cut.targetRootId)).records.map(record => record.segment.id);
    assert.deepEqual(cutSegments.slice(-2), [callSource.segment_id, resultSource.segment_id]);
    const cutContent = (await app.context.materialize(cut.targetRootId)).segments.map(segment => segment.content.toString('utf8')).join('\n');
    assert.doesNotMatch(cutContent, /Continuing while the probe is still running/);
    const forked = await forkNativeMessage(app, conversationId, request.id, 'native-closed-prefix-fork');
    assert.deepEqual(await app.runtime.effects.listNativePendingWork({ conversationId: forked.targetConversationId }), []);

    // A fresh physical connection must reconstruct canonical history rather than rely on cache state.
    resetOpenAIResponsesWebSocketSessions();
    const frameCount = frames.length;
    const next = await harness.startTurn('native-second-turn', 'Confirm the preserved order.', forked.targetConversationId);
    const restored = await until(() => frames.slice(frameCount).find(frame => frame.body.type === 'response.create'), 'fresh canonical history');
    const input = restored.body.input;
    const callPositions = input.flatMap((item, index) => item.type === 'function_call' ? [index] : []);
    const resultPositions = input.flatMap((item, index) => item.type === 'function_call_output' ? [index] : []);
    assert.equal(callPositions.length, 1);
    assert.equal(resultPositions.length, 1);
    assert.equal(input[callPositions[0]].call_id, 'original-native-call');
    assert.equal(input[callPositions[0]].async, true);
    assert.equal(input[resultPositions[0]].call_id, 'original-native-call');
    const prefixPosition = input.findIndex(item => JSON.stringify(item).includes('Before the background call.'));
    const suffixPosition = input.findIndex(item => JSON.stringify(item).includes('Continuing while the probe is still running.'));
    assert.ok(prefixPosition >= 0 && prefixPosition < callPositions[0]);
    assert.ok(callPositions[0] < suffixPosition && suffixPosition < resultPositions[0]);
    created(restored.socket, 'native-response-3');
    completed(restored.socket, 'native-response-3', [text(restored.socket, 'native-response-3', 0, 'Order confirmed.')]);
    assert.equal((await next.completion).terminalStatus, 'completed');
    assert.equal(harness.executions(), 1);
  });
});

test('accepted steering waits for an actual synchronous result without resending the queued instruction', { timeout: 60_000 }, async () => {
  await withNativeRuntime(async harness => {
    const { app, conversationId, frames, created, text, completed, send, until } = harness;
    const turn = await harness.startTurn('native-pending-steer', 'Read the probe.');
    const first = await until(() => frames.find(frame => frame.body.type === 'response.create'), 'steering request');
    created(first.socket, 'steer-response-1');
    const prefix = text(first.socket, 'steer-response-1', 0, 'Reading the probe now.');
    const call = {
      type: 'function_call', id: 'synchronous-native-item', call_id: 'original-synchronous-call',
      name: 'native_probe', arguments: '{}', async: false, status: 'completed'
    };
    send(first.socket, {
      type: 'response.output_item.done', response_id: 'steer-response-1', output_index: 1, item: call
    });
    await until(async () => (await rows(app, 'ModelRequest', { turn_id: turn.turnId }))
      .find(request => request.stream_stats_json?.nativeCapabilities?.steering === true), 'frozen steering capability');
    const [lease] = await rows(app, 'ExecutionLease', { turn_id: turn.turnId });
    const instruction = 'Use the probe result, but report only its length.';
    const input = {
      commandId: 'native-steering-command', conversationId, turnId: turn.turnId,
      leaseEpoch: BigInt(lease.generation), content: { role: 'user', parts: [{ text: instruction }] }
    };
    await assert.rejects(app.modelProvider.steer({
      ...input, commandId: 'native-steering-stale-lease', leaseEpoch: input.leaseEpoch + 1n
    }));
    assert.deepEqual(await app.modelProvider.steeringReceipts(conversationId), []);
    const queued = await app.modelProvider.steer(input);
    assert.ok(queued.state === 'queued' || queued.state === 'sent');
    const steering = await until(() => frames.find(frame => frame.body.type === 'response.steer'), 'steering send');
    assert.deepEqual(Object.keys(steering.body).sort(), ['input', 'previous_response_id', 'type']);
    assert.equal(steering.body.previous_response_id, 'steer-response-1');
    assert.ok(JSON.stringify(steering.body.input).includes(instruction));
    const receipt = async () => (await app.modelProvider.steeringReceipts(conversationId))
      .find(value => value.submissionId === queued.submissionId);
    assert.ok(['queued', 'sent'].includes((await receipt()).state));
    send(steering.socket, {
      type: 'response.steer.accepted',
      steer: { id: 'server-steer-pending', previous_response_id: 'steer-response-1' }
    });
    await until(async () => (await receipt())?.state === 'accepted', 'durable steering acceptance');
    assert.equal(harness.executions(), 0, 'async:false must not execute before its response boundary');
    completed(first.socket, 'steer-response-1', [prefix, call]);
    send(first.socket, {
      type: 'response.steer.pending',
      steer: { id: 'server-steer-pending', previous_response_id: 'steer-response-1' },
      reason: 'waiting_for_required_input',
      required_input: [{ type: 'function_call_output', call_id: 'original-synchronous-call', name: 'native_probe' }]
    });
    await until(async () => (await receipt())?.state === 'waiting_for_input', 'required-input receipt');
    await until(() => harness.executions() === 1, 'boundary-admitted synchronous execution');
    harness.releaseTool.resolve();
    const delivery = await until(() => frames.find(frame => frame.body.type === 'response.create'
      && frame.body.input?.some(item => item.type === 'function_call_output')), 'required tool result');
    assert.equal(delivery.body.previous_response_id, 'steer-response-1');
    assert.equal(delivery.body.input.find(item => item.type === 'function_call_output').call_id, 'original-synchronous-call');
    assert.equal(JSON.stringify(delivery.body.input).includes(instruction), false);
    created(delivery.socket, 'steer-response-2', 'steer-response-1');
    await until(async () => (await receipt())?.state === 'continuing', 'proven steering continuation');
    completed(delivery.socket, 'steer-response-2', [
      text(delivery.socket, 'steer-response-2', 0, 'The probe contains 39 characters.')
    ]);
    const finished = await turn.completion;
    assert.equal(finished.terminalStatus, 'completed');
    assert.equal(finished.modelRequestIds.length, 1);
    const durable = await receipt();
    assert.equal(durable.state, 'completed');
    assert.equal(durable.targetResponseId, 'steer-response-1');
    assert.equal(durable.successorResponseId, 'steer-response-2');
    assert.ok(durable.messageId);
    const restoredProvider = new kernel.ModelProviderControlPlane(app.database, app.contentStore, { attachments: app.attachments });
    const restored = (await restoredProvider.steeringReceipts(conversationId))
      .find(value => value.submissionId === queued.submissionId);
    assert.equal(restored.state, 'completed');
    assert.equal(restored.messageId, durable.messageId);
    assert.equal(frames.filter(frame => frame.body.type === 'response.steer').length, 1);
    assert.equal(harness.executions(), 1);
  });
});

test('a steered incomplete response consumes its automatic successor within the same logical request', { timeout: 60_000 }, async () => {
  await withNativeRuntime(async harness => {
    const { app, conversationId, frames, created, text, completed, send, until } = harness;
    const turn = await harness.startTurn('native-automatic-steer', 'Begin the first direction.');
    const first = await until(() => frames.find(frame => frame.body.type === 'response.create'), 'automatic steering request');
    created(first.socket, 'automatic-response-1');
    const prefix = text(first.socket, 'automatic-response-1', 0, 'The already-visible original direction.');
    await until(async () => (await rows(app, 'ModelRequest', { turn_id: turn.turnId }))
      .find(request => request.stream_stats_json?.nativeCapabilities?.steering === true), 'automatic steering capability');
    const [lease] = await rows(app, 'ExecutionLease', { turn_id: turn.turnId });
    const queued = await app.modelProvider.steer({
      commandId: 'automatic-steering-command', conversationId, turnId: turn.turnId,
      leaseEpoch: BigInt(lease.generation),
      content: { role: 'user', parts: [{ text: 'Change direction without discarding the earlier output.' }] }
    });
    await until(() => frames.find(frame => frame.body.type === 'response.steer'), 'automatic steering send');
    send(first.socket, {
      type: 'response.steer.accepted',
      steer: { id: 'server-steer-automatic', previous_response_id: 'automatic-response-1' }
    });
    send(first.socket, {
      type: 'response.incomplete',
      response: {
        id: 'automatic-response-1', status: 'incomplete', output: [prefix],
        incomplete_details: { reason: 'steered' },
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }
      }
    });
    created(first.socket, 'automatic-response-2', 'automatic-response-1');
    completed(first.socket, 'automatic-response-2', [
      text(first.socket, 'automatic-response-2', 0, 'The new direction after steering.')
    ]);
    const finished = await turn.completion;
    assert.equal(finished.terminalStatus, 'completed');
    assert.equal(finished.modelRequestIds.length, 1);
    assert.equal(frames.filter(frame => frame.body.type === 'response.create').length, 1);
    assert.equal(harness.httpCalls(), 0);
    const receipt = (await app.modelProvider.steeringReceipts(conversationId))
      .find(value => value.submissionId === queued.submissionId);
    assert.equal(receipt.state, 'completed');
    assert.equal(receipt.targetResponseId, 'automatic-response-1');
    assert.equal(receipt.successorResponseId, 'automatic-response-2');
  });
});

test('native SSE admits async work before completion and resumes statelessly with its original result', { timeout: 60_000 }, async () => {
  await withNativeRuntime(async harness => {
    const { app, conversationId, frames, created, text, completed, send, until } = harness;
    const turn = await harness.startTurn('native-sse-turn', 'Read the probe asynchronously over SSE.');
    const first = await until(() => frames.find(frame => frame.response), 'native SSE request');
    assert.equal(first.body.tools.find(tool => tool.name === 'native_probe')?.async, true);
    assert.equal(first.body.store, false);
    created(first.response, 'native-sse-response-1');
    const prefix = text(first.response, 'native-sse-response-1', 0, 'Before the SSE background call.');
    const call = {
      type: 'function_call', id: 'native-sse-function-item', call_id: 'original-native-sse-call',
      name: 'native_probe', arguments: '{}', async: true, status: 'completed'
    };
    send(first.response, {
      type: 'response.output_item.done', response_id: 'native-sse-response-1', output_index: 1, item: call
    });
    await until(() => harness.executions() === 1, 'native SSE execution before response.completed');
    const [admitted] = await rows(app, 'ToolCall', { turn_id: turn.turnId });
    const [request] = await rows(app, 'ModelRequest', { turn_id: turn.turnId });
    assert.equal(request.status, 'streaming');
    assert.equal(request.stream_stats_json.nativeCapabilities.asyncTools, true);
    assert.equal(request.stream_stats_json.nativeCapabilities.steering, false);
    const suffix = text(first.response, 'native-sse-response-1', 2, 'Continuing independently over SSE.');
    completed(first.response, 'native-sse-response-1', [prefix, call, suffix]);
    harness.releaseTool.resolve();
    const delivery = await until(() => frames.find(frame => frame.response && frame !== first
      && frame.body.input?.some(item => item.type === 'function_call_output')), 'stateless SSE result carrier');
    assert.equal(delivery.body.store, false);
    assert.equal(delivery.body.previous_response_id, undefined);
    const calls = delivery.body.input.filter(item => item.type === 'function_call');
    const results = delivery.body.input.filter(item => item.type === 'function_call_output');
    assert.equal(calls.length, 1);
    assert.equal(results.length, 1);
    assert.equal(calls[0].call_id, 'original-native-sse-call');
    assert.equal(calls[0].async, true);
    assert.equal(results[0].call_id, 'original-native-sse-call');
    assert.match(JSON.stringify(results[0].output), /content from the real native probe file/);
    created(delivery.response, 'native-sse-response-2');
    completed(delivery.response, 'native-sse-response-2', [
      text(delivery.response, 'native-sse-response-2', 0, 'SSE result received.')
    ]);
    assert.equal((await turn.completion).terminalStatus, 'completed');
    assert.equal((await rows(app, 'ToolModelResult', { tool_call_id: admitted.id })).length, 1);
    assert.equal((await rows(app, 'ToolCallEvent', { tool_call_id: admitted.id, event_kind: 'native_delivery' })).length, 1);
    assert.equal(harness.executions(), 1);
    assert.equal(harness.httpCalls(), 2);
    assert.equal(frames.some(frame => frame.socket), false);
    assert.deepEqual(await app.runtime.effects.listNativePendingWork({ conversationId }), []);
  }, { transport: 'http' });
});

for (const transport of ['websocket', 'http']) {
  test(`native ${transport} keeps synchronous calls pending until boundary and result admission`, { timeout: 60_000 }, async () => {
    await withNativeRuntime(async harness => {
      const { app, frames, created, text, completed, send, until } = harness;
      const turn = await harness.startTurn('native-sync-turn', 'Read the probe synchronously.');
      const first = await until(() => frames.find(frame => frame.response || frame.body.type === 'response.create'),
        'synchronous native request');
      const channel = first.response ?? first.socket;
      assert.equal(first.body.tools.find(tool => tool.name === 'native_probe')?.async, true);
      created(channel, 'native-sync-1');
      const call = {
        type: 'function_call', id: 'native-sync-item', call_id: 'original-native-sync-call',
        name: 'native_probe', arguments: '{}', async: false, status: 'completed'
      };
      send(channel, {
        type: 'response.output_item.done', response_id: 'native-sync-1', output_index: 0, item: call
      });
      const request = await until(async () => (await rows(app, 'ModelRequest', { turn_id: turn.turnId }))[0],
        'synchronous native ModelRequest');
      await until(async () => (await rows(app, 'ModelStreamCheckpoint', {
        model_request_id: request.id, checkpoint_kind: 'native_tool_call'
      })).length === 1, 'synchronous call item proof');
      assert.equal(harness.executions(), 0, 'a returned async:false overrides the offered async declaration');
      assert.deepEqual(await rows(app, 'ToolCall', { turn_id: turn.turnId }), []);
      completed(channel, 'native-sync-1', [call]);
      await until(() => harness.executions() === 1, 'boundary-admitted synchronous call');
      harness.releaseTool.resolve();
      const delivery = await until(() => frames.find(frame => frame !== first
        && frame.body.input?.some(item => item.type === 'function_call_output')), 'synchronous result carrier');
      if (transport === 'http') {
        assert.equal(delivery.body.input.find(item => item.type === 'function_call').async, false);
      }
      assert.equal(delivery.body.input.find(item => item.type === 'function_call_output').call_id,
        'original-native-sync-call');
      const carrier = delivery.response ?? delivery.socket;
      created(carrier, 'native-sync-2', delivery.body.previous_response_id);
      completed(carrier, 'native-sync-2', [
        text(carrier, 'native-sync-2', 0, 'The synchronous result was received.')
      ]);
      assert.equal((await turn.completion).terminalStatus, 'completed');
      assert.equal((await rows(app, 'ModelRequest', { turn_id: turn.turnId })).length, 1);
    }, { transport });
  });
}

for (const transport of ['websocket', 'http']) {
  test(`reasoning updates survive ${transport} continuation and rebase across model switches`, { timeout: 60_000 }, async () => {
    await withNativeRuntime(async harness => {
      const { frames, created, text, completed, until } = harness;
      async function respond(key, inspect) {
        const before = frames.length;
        const turn = await harness.startTurn(`reasoning-${key}`, `Reasoning scenario ${key}.`);
        const frame = await until(() => frames.slice(before).find(value =>
          value.response || (value.body.type === 'response.create' && value.body.generate !== false)
        ), `reasoning ${key} request`);
        for (let index = 1; index < frame.body.input.length; index += 1) {
          assert.equal(frame.body.input[index - 1].type === 'configuration_update'
            && frame.body.input[index].type === 'configuration_update', false,
          'the wire protocol forbids adjacent configuration updates');
        }
        inspect(frame.body);
        const responseId = `reasoning-response-${key}`;
        const channel = frame.response ?? frame.socket;
        created(channel, responseId, frame.body.previous_response_id);
        completed(channel, responseId, [text(channel, responseId, 0, `Finished ${key}.`)]);
        assert.equal((await turn.completion).terminalStatus, 'completed');
      }
      const updates = body => body.input.filter(item => item.type === 'configuration_update');
      const effectiveEffort = body => updates(body).at(-1)?.reasoning?.effort ?? body.reasoning?.effort;
      let baseEffort;
      harness.configureModel(MODEL, 'low');
      await respond('initial-low', body => {
        baseEffort = body.reasoning?.effort;
        assert.equal(baseEffort, 'low');
      });
      harness.configureModel(MODEL, 'high');
      await respond('changed-high', body => {
        assert.equal(body.reasoning?.effort, baseEffort);
        assert.equal(updates(body).at(-1)?.reasoning?.effort, 'high');
      });
      await respond('unchanged-high', body => {
        assert.equal(body.reasoning?.effort, baseEffort);
        if (body.previous_response_id) {
          assert.equal(updates(body).length, 0);
        } else {
          assert.equal(updates(body).length, 1);
          assert.equal(effectiveEffort(body), 'high');
        }
      });
      harness.configureModel(MODEL, undefined);
      await respond('restored-service-default', body => {
        assert.equal(body.reasoning?.effort, undefined, 'old anchored effort must not be reintroduced');
        assert.deepEqual(updates(body), [], 'old configuration updates must not restore high');
        assert.equal(body.previous_response_id, undefined, 'restoring omission uses a full rebase');
      });
      harness.configureModel(MODEL, 'medium');
      await respond('changed-medium', body => {
        assert.equal(body.reasoning?.effort, 'medium', 'new base after restoring defaults');
        assert.equal(effectiveEffort(body), 'medium');
      });
      harness.configureModel('gpt-5.6', 'high');
      await respond('other-model', body => {
        assert.equal(body.model, 'gpt-5.6');
        assert.deepEqual(updates(body), []);
        assert.equal(body.tools.find(tool => tool.name === 'native_probe')?.async, undefined);
      });
      harness.configureModel(MODEL, 'low');
      await respond('returned-low', body => {
        assert.equal(body.model, MODEL);
        assert.equal(effectiveEffort(body), 'low');
      });
    }, { transport });
  });
}

// GPT-6 Sol / Luna 与 Astra 共享原生路径（Using GPT-6 “What's new”；guides/async-tool-calling 与 guides/steering）。
for (const model of ['gpt-6-sol', 'gpt-6-luna']) {
  for (const transport of ['http', 'websocket']) {
    test(`${model} native ${transport} admits an async call before completion and delivers its original result once`, { timeout: 60_000 }, async () => {
      await withNativeRuntime(async harness => {
        const { app, conversationId, frames, created, text, completed, send, until } = harness;
        harness.configureModel(model, 'high');
        const turn = await harness.startTurn(`family-${model}-${transport}`, 'Read the probe asynchronously.');
        const first = await until(() => frames.find(frame => frame.response || frame.body.type === 'response.create'),
          `${model} native request`);
        const channel = first.response ?? first.socket;
        assert.equal(first.body.model, model);
        assert.equal(first.body.tools.find(tool => tool.name === 'native_probe')?.async, true);
        assert.equal(first.body.reasoning?.effort, 'high');
        created(channel, `${model}-response-1`);
        const call = {
          type: 'function_call', id: `${model}-function-item`, call_id: `original-${model}-call`,
          name: 'native_probe', arguments: '{}', async: true, status: 'completed'
        };
        send(channel, { type: 'response.output_item.done', response_id: `${model}-response-1`, output_index: 0, item: call });
        await until(() => harness.executions() === 1, `${model} execution before response.completed`);
        const [request] = await rows(app, 'ModelRequest', { turn_id: turn.turnId });
        assert.equal(request.stream_stats_json.nativeCapabilities.asyncTools, true);
        assert.equal(request.stream_stats_json.nativeCapabilities.steering, transport === 'websocket');
        completed(channel, `${model}-response-1`, [call]);
        harness.releaseTool.resolve();
        const delivery = await until(() => frames.find(frame => frame !== first
          && frame.body.input?.some(item => item.type === 'function_call_output')), `${model} result carrier`);
        const results = delivery.body.input.filter(item => item.type === 'function_call_output');
        assert.equal(results.length, 1);
        assert.equal(results[0].call_id, `original-${model}-call`);
        const carrier = delivery.response ?? delivery.socket;
        created(carrier, `${model}-response-2`, delivery.body.previous_response_id);
        completed(carrier, `${model}-response-2`, [text(carrier, `${model}-response-2`, 0, 'Result received.')]);
        assert.equal((await turn.completion).terminalStatus, 'completed');
        assert.equal(harness.executions(), 1);
        assert.deepEqual(await app.runtime.effects.listNativePendingWork({ conversationId }), []);
      }, { transport });
    });
  }
}

// 官方：configuration_update “supported by the GPT-6 model family in standard, single-agent mode”
// （guides/reasoning “Change reasoning mid-conversation”）。pro 模式下改推理强度只能换请求级 effort。
for (const model of ['gpt-6-astra', 'gpt-6-sol']) {
  for (const transport of ['websocket', 'http']) {
    test(`${model} pro reasoning mode never sends configuration_update over ${transport}`, { timeout: 60_000 }, async () => {
      await withNativeRuntime(async harness => {
        const { frames, created, text, completed, until } = harness;
        async function respond(key) {
          const before = frames.length;
          const turn = await harness.startTurn(`pro-${model}-${key}`, `Pro scenario ${key}.`);
          const frame = await until(() => frames.slice(before).find(value =>
            value.response || (value.body.type === 'response.create' && value.body.generate !== false)
          ), `pro ${key} request`);
          const responseId = `pro-${model}-${key}`;
          const channel = frame.response ?? frame.socket;
          created(channel, responseId, frame.body.previous_response_id);
          completed(channel, responseId, [text(channel, responseId, 0, `Finished ${key}.`)]);
          assert.equal((await turn.completion).terminalStatus, 'completed');
          return frame.body;
        }
        const updates = body => body.input.filter(item => item.type === 'configuration_update');
        harness.configureModel(model, 'low', 'pro');
        const low = await respond('low');
        assert.deepEqual(low.reasoning && { mode: low.reasoning.mode, effort: low.reasoning.effort }, { mode: 'pro', effort: 'low' });
        harness.configureModel(model, 'high', 'pro');
        const high = await respond('high');
        assert.deepEqual(updates(high), []);
        assert.equal(high.reasoning?.mode, 'pro');
        assert.equal(high.reasoning?.effort, 'high', 'pro mode changes the request-level effort directly');
        // 回到 standard 后动态推理更新恢复。
        harness.configureModel(model, 'medium', 'standard');
        await respond('standard-medium');
        harness.configureModel(model, 'xhigh', 'standard');
        const standard = await respond('standard-xhigh');
        assert.equal(standard.reasoning?.effort, 'medium');
        assert.equal(updates(standard).at(-1)?.reasoning?.effort, 'xhigh');
      }, { transport });
    });
  }
}

test('ready async results wait behind an automatic steer successor and retain actual context order', { timeout: 60_000 }, async () => {
  await withNativeRuntime(async harness => {
    const { app, conversationId, frames, created, text, completed, send, until } = harness;
    const turn = await harness.startTurn('combined-native-turn', 'Start the probe and keep working.');
    const first = await until(() => frames.find(frame => frame.body.type === 'response.create'), 'combined native request');
    created(first.socket, 'combined-response-1');
    const prefix = text(first.socket, 'combined-response-1', 0, 'Starting the asynchronous probe.');
    const call = {
      type: 'function_call', id: 'combined-function-item', call_id: 'steered-async-call',
      name: 'native_probe', arguments: '{}', async: true, status: 'completed'
    };
    send(first.socket, {
      type: 'response.output_item.done', response_id: 'combined-response-1', output_index: 1, item: call
    });
    await until(() => harness.executions() === 1, 'combined native execution');
    const [lease] = await rows(app, 'ExecutionLease', { turn_id: turn.turnId });
    const instruction = 'Continue in the new direction while the probe runs.';
    await app.modelProvider.steer({
      commandId: 'combined-native-steer', conversationId, turnId: turn.turnId,
      leaseEpoch: BigInt(lease.generation), content: { role: 'user', parts: [{ text: instruction }] }
    });
    await until(() => frames.find(frame => frame.body.type === 'response.steer'), 'combined steering send');
    send(first.socket, {
      type: 'response.steer.accepted',
      steer: { id: 'combined-server-steer', previous_response_id: 'combined-response-1' }
    });
    completed(first.socket, 'combined-response-1', [prefix, call]);
    harness.releaseTool.resolve();
    await until(async () => (await rows(app, 'ToolModelResult')).length === 1, 'ready result before automatic successor');
    created(first.socket, 'combined-response-2', 'combined-response-1');
    const automatic = text(first.socket, 'combined-response-2', 0, 'Automatic successor has not received the probe result.');
    completed(first.socket, 'combined-response-2', [automatic]);
    const delivery = await until(() => frames.find(frame => frame.body.type === 'response.create'
      && frame.body.input?.some(item => item.type === 'function_call_output')), 'result after automatic successor');
    assert.equal(delivery.body.previous_response_id, 'combined-response-2');
    created(delivery.socket, 'combined-response-3', 'combined-response-2');
    completed(delivery.socket, 'combined-response-3', [
      text(delivery.socket, 'combined-response-3', 0, 'The result is now available.')
    ]);
    assert.equal((await turn.completion).terminalStatus, 'completed');
    resetOpenAIResponsesWebSocketSessions();
    const before = frames.length;
    const next = await harness.startTurn('combined-next-turn', 'Confirm the actual chronology.');
    const restored = await until(() => frames.slice(before).find(frame => frame.body.type === 'response.create'), 'combined restored history');
    const input = restored.body.input;
    const userPosition = input.findIndex(item => JSON.stringify(item).includes(instruction));
    const automaticPosition = input.findIndex(item =>
      JSON.stringify(item).includes('Automatic successor has not received the probe result.')
    );
    const resultPosition = input.findIndex(item => item.type === 'function_call_output' && item.call_id === 'steered-async-call');
    assert.ok(userPosition >= 0 && userPosition < automaticPosition);
    assert.ok(automaticPosition < resultPosition);
    assert.equal(input.filter(item => JSON.stringify(item).includes(instruction)).length, 1);
    created(restored.socket, 'combined-response-4');
    completed(restored.socket, 'combined-response-4', [
      text(restored.socket, 'combined-response-4', 0, 'Chronology confirmed.')
    ]);
    assert.equal((await next.completion).terminalStatus, 'completed');
    assert.equal(harness.executions(), 1);
  });
});

test('forking a native response never copies an unapplied steering instruction as ordinary user history', { timeout: 60_000 }, async () => {
  await withNativeRuntime(async harness => {
    const { app, conversationId, frames, created, text, completed, send, until } = harness;
    const turn = await harness.startTurn('failed-steer-fork-turn', 'Finish the original direction.');
    const first = await until(() => frames.find(frame => frame.body.type === 'response.create'), 'failed-steer request');
    created(first.socket, 'failed-steer-response');
    await until(async () => (await rows(app, 'ModelRequest', { turn_id: turn.turnId }))
      .some(request => request.stream_stats_json?.nativeCapabilities?.steering === true), 'failed-steer capability');
    const [lease] = await rows(app, 'ExecutionLease', { turn_id: turn.turnId });
    const instruction = 'This instruction was never applied by the provider.';
    const queued = await app.modelProvider.steer({
      commandId: 'failed-steer-fork-command', conversationId, turnId: turn.turnId,
      leaseEpoch: BigInt(lease.generation), content: { role: 'user', parts: [{ text: instruction }] }
    });
    const steering = await until(() => frames.find(frame => frame.body.type === 'response.steer'), 'failed-steer send');
    send(first.socket, {
      type: 'response.steer.accepted',
      steer: { id: 'failed-steer-id', previous_response_id: 'failed-steer-response' }
    });
    const original = text(first.socket, 'failed-steer-response', 0, 'The successfully finished original output.');
    completed(first.socket, 'failed-steer-response', [original]);
    send(first.socket, {
      type: 'response.steer.failed',
      steer: {
        id: 'failed-steer-id', previous_response_id: 'failed-steer-response', input: steering.body.input
      },
      error: { code: 'invalid_input', message: 'The steering instruction was rejected.' }
    });
    await turn.completion;
    const receipt = (await app.modelProvider.steeringReceipts(conversationId))
      .find(value => value.submissionId === queued.submissionId);
    assert.equal(receipt.state, 'failed');
    const sourceRevisions = await rows(app, 'MessageRevision', { message_id: receipt.messageId });
    assert.equal(sourceRevisions.length, 1);
    const [sourceContent] = await rows(app, 'ContentObject', { id: sourceRevisions[0].content_object_id });
    assert.ok((await app.contentStore.read(sourceContent)).toString('utf8').includes(instruction));
    const [sourceRequest] = await rows(app, 'ModelRequest', { turn_id: turn.turnId });
    const forked = await forkNativeMessage(app, conversationId, sourceRequest.id, 'failed-steer-fork');
    const copied = [];
    for (const membership of await rows(app, 'MessagePartOfConversation', { conversation_id: forked.targetConversationId })) {
      const [current] = await rows(app, 'MessageCurrentRevisionLink', { message_id: membership.message_id });
      const [revision] = await rows(app, 'MessageRevision', { id: current.revision_id });
      const [metadata] = await rows(app, 'ContentObject', { id: revision.content_object_id });
      copied.push((await app.contentStore.read(metadata)).toString('utf8'));
    }
    assert.ok(copied.some(content => content.includes('The successfully finished original output.')));
    assert.equal(copied.some(content => content.includes(instruction)), false);
  });
});
