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
const { NativeRequestSession } = require(path.join(compiledRoot, 'backend/reliableKernel/nativeRequestSession.js'));
const MODEL = 'gpt-6-astra';
const CONVERSATION = 'native-http-context-completeness';
const NATIVE = { enabled: true, asyncTools: true, steering: true, reasoningUpdates: true, multiplexing: false };

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

async function contextParts(app) {
  const [head] = await rows(app, 'ConversationContextHeadLink', { conversation_id: CONVERSATION });
  const window = await app.context.materialize(head.root_id);
  return window.segments.flatMap(segment => {
    const contentType = segment.contentObject.content_type;
    if (!contentType.endsWith('+json') && contentType !== 'application/json') return [];
    const payload = JSON.parse(segment.content.toString('utf8'));
    return payload.parts ?? [payload];
  });
}

async function hasCompletedResponse(app, modelRequestId, responseId) {
  const checkpoints = await rows(app, 'ModelStreamCheckpoint', {
    model_request_id: modelRequestId, checkpoint_kind: 'native_control'
  });
  for (const checkpoint of checkpoints) {
    const [metadata] = await rows(app, 'ContentObject', { id: checkpoint.content_object_id });
    const payload = (await app.contentStore.read(metadata)).toString('utf8');
    if (payload.includes('response.completed') && payload.includes(responseId)) return true;
  }
  return false;
}

function assertOnce(value, markers, label) {
  const serialized = JSON.stringify(value);
  for (const marker of markers) {
    assert.equal(serialized.split(marker).length - 1, 1, `${label} must contain ${marker} exactly once`);
  }
}

async function aggregateParts(app, modelRequestId) {
  const [link] = await rows(app, 'ModelRequestMessageLink', { model_request_id: modelRequestId });
  const [current] = await rows(app, 'MessageCurrentRevisionLink', { message_id: link.message_id });
  const [revision] = await rows(app, 'MessageRevision', { id: current.revision_id });
  const [content] = await rows(app, 'ContentObject', { id: revision.content_object_id });
  return JSON.parse((await app.contentStore.read(content)).toString('utf8')).parts;
}

// Deliberately use the real HTTP provider, Runtime writer, SQLite and CAS. Mocked provider events
// would skip the SSE decoder whose missing item completion caused this regression.
async function withHttpRuntime(run, { providerAdapter, retryPolicy = { enabled: false, maxRetries: 0 } } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-native-http-context-'));
  const slowTool = deferred();
  const frames = [];
  const drives = [];
  let app;
  let executionCount = 0;
  let sequence = 0;
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.once('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      frames.push({ response, body: JSON.parse(body) });
      response.flushHeaders();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const configuration = {
    id: 'native-http-context-provider', name: 'Native HTTP Context', provider: 'openai-responses',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: MODEL,
    models: [{ id: MODEL, name: MODEL }], apiKey: 'offline-test-key',
    toolCallFormat: 'function-call', openaiResponsesTransport: 'http', nativeResponses: NATIVE,
    stream: true, retryOnError: false, retryMaxAttempts: 0, enableMultimodalTools: true,
    promptCache: { enabled: false, mode: 'key', ttl: '30m' }, modelConfigs: [], createdAt: 1, updatedAt: 1
  };
  const adapter = providerAdapter ?? new kernel.LlmCapabilityFullRequestAdapter(configuration.id,
    createLlmProviderCapability({ settings: configuration }));
  const tool = {
    declaration: {
      name: 'native_probe', description: 'Run an isolated native HTTP test probe.',
      parameters: { type: 'object', properties: { slow: { type: 'boolean' } }, additionalProperties: false },
      source: { kind: 'builtin' },
      metadata: { readonly: true, defaultAutoApproveExecution: true, defaultAutoSubmitResult: true }
    },
    execution: 'runtime',
    async execute(arguments_, _dependencies, context) {
      executionCount += 1;
      if (arguments_.slow === true) await slowTool.promise;
      context.signal.throwIfAborted();
      return { ok: true, output: arguments_.slow === true ? 'slow-probe-result' : 'fast-probe-result' };
    }
  };
  const dependencies = {
    authorityCompiler: { async compile(request) {
      return {
        turnId: request.turnId, executorAgentId: request.executorAgentId,
        executionPreset: { content: JSON.stringify({ providerConfigId: configuration.id, modelId: MODEL }) },
        authoritySnapshot: { content: JSON.stringify({
          kind: 'effective-turn-authority', turnId: request.turnId,
          conversationId: request.conversationId, executorAgentId: request.executorAgentId,
          model: { providerConfigId: configuration.id, provider: configuration.provider, modelId: MODEL,
            baseUrl: configuration.baseUrl, openaiResponsesTransport: 'http', nativeResponses: NATIVE,
            retryPolicy },
          modelProfile: { compressionThresholdTokens: 100000, contextWindowTokens: 128000,
            tokenEstimator: { kind: 'utf8-bytes-ceil', bytesPerToken: 4 } },
          planReviewPolicy: { mode: 'never' },
          toolPolicy: { id: 'native-http-context-policy', allowedTools: ['native_probe'], preset: 'custom',
            toolConfigs: { native_probe: { nativeAsync: true, autoApproveExecution: true,
              autoSubmitResult: true, config: {} } }, sourceConfigs: {} },
          systemPrompt: { id: 'native-http-context-prompt', text: '' },
          runtimeContext: { id: null, name: '', template: '' },
          workEnvironmentPolicy: { id: null, enabled: false, allowedWorkEnvironmentIds: [],
            defaultWorkEnvironmentId: null }
        }) }
      };
    } },
    resolveWorkEnvironment: async () => undefined,
    mcpConnections: { async toolAnnotations() { return {}; }, async callTool() { assert.fail('not an MCP tool'); } },
    mcpPolicyGate: { async authorize() { assert.fail('not an MCP tool'); } },
    attachmentSettings: { async loadGlobalSettings() {
      return { section: 'attachments', settings: { maxStoredInlineFileMb: 25 }, filePath: 'settings/attachments.json' };
    } },
    providers: { resolve(providerId) { assert.equal(providerId, configuration.id); return adapter; } },
    createToolDispatcher: ({ database, contentStore, runtime, files, fileMutations, processes, mcp, interactions }) =>
      new kernel.ReliableToolDispatcher({ database, contentStore, effects: runtime.effects,
        files, fileMutations, processes, mcp, interactions, host: {
          definitions() { return [tool]; },
          executeNoEffect(definition, input, _authority, emit, signal) {
            return definition.execute(input.arguments, undefined, { signal, emit });
          }
        } })
  };
  const authority = new kernel.RootAuthority(() => path.join(directory, 'runtime'));
  await kernel.initializeEmptyRuntimeRoot(authority);
  function send(response, event) {
    response.write(`data: ${JSON.stringify({ sequence_number: ++sequence, ...event })}\n\n`);
  }
  function done(response, responseId, index, item) {
    send(response, { type: 'response.output_item.done', response_id: responseId, output_index: index, item });
  }
  function content(response, responseId, index, value, { thought = false, delta = true, close = true, signature = true } = {}) {
    const item = thought
      ? { type: 'reasoning', id: `${responseId}-reasoning-${index}`,
          summary: [{ type: 'summary_text', text: value }], ...(signature ? { encrypted_content: `signature-${value}` } : {}) }
      : { type: 'message', id: `${responseId}-message-${index}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: value, annotations: [] }] };
    if (delta) {
      send(response, { type: 'response.output_item.added', response_id: responseId, output_index: index,
        item: thought ? { type: 'reasoning', id: item.id, summary: [] }
          : { ...item, status: 'in_progress', content: [] } });
      send(response, { type: thought ? 'response.reasoning_summary_text.delta' : 'response.output_text.delta',
        response_id: responseId, item_id: item.id, output_index: index,
        ...(thought ? { summary_index: 0 } : { content_index: 0 }), delta: value });
    }
    if (close) done(response, responseId, index, item);
    return item;
  }
  function completed(response, responseId, output) {
    send(response, { type: 'response.completed', response: { id: responseId, status: 'completed',
      model: MODEL, output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } });
    response.end('data: [DONE]\n\n');
  }
  try {
    app = await kernel.ReliableKernelApplication.open(authority, dependencies);
    const now = new Date().toISOString();
    await app.database.transaction([
      kernel.DOMAIN_REPOSITORIES.domain('Conversation').insert({ id: CONVERSATION,
        title: 'Native HTTP Context', status: 'active', created_at: now, updated_at: now }),
      kernel.DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({ id: 'native-http-context-agent',
        conversation_id: CONVERSATION, agent_id: 'agent-main', role: 'default', created_at: now, updated_at: now })
    ]);
    await run({
      get app() { return app; }, frames, send, done, content, completed, until,
      releaseTool: () => slowTool.resolve(), executions: () => executionCount,
      created(response, responseId) {
        send(response, { type: 'response.created', response: { id: responseId,
          status: 'in_progress', model: MODEL, output: [] } });
      },
      async startTurn(key) {
        const started = await app.turns.input({ source: { kind: 'command', key }, conversationId: CONVERSATION,
          leaseOwnerId: 'native-http-context-owner', hostBootId: app.database.hostBootId,
          leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(), content: `HTTP completeness ${key}.` });
        const [lease] = await rows(app, 'ExecutionLease', { turn_id: started.turnId });
        assert.ok(lease, 'the test drives under its actual execution lease');
        const completion = kernel.runWithExecutionLeaseFence({ id: lease.id, conversationId: lease.conversation_id,
          turnId: lease.turn_id, ownerId: lease.owner_id, hostBootId: lease.host_boot_id,
          generation: BigInt(lease.generation) }, () => app.agentLoop.drive(started.turnId));
        void completion.catch(() => {});
        drives.push(completion);
        return { ...started, completion };
      },
      async reopen() {
        await app.close();
        app = await kernel.ReliableKernelApplication.open(authority, dependencies);
      }
    });
  } finally {
    slowTool.resolve();
    for (const frame of frames) frame.response.destroy();
    if (app) await app.close();
    await Promise.allSettled(drives);
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('native HTTP preserves each plain/reasoning item across two physical responses and a full successor',
  { timeout: 30_000 }, async () => {
    await withHttpRuntime(async h => {
      const turn = await h.startTurn('interleaved-items');
      const first = await h.until(() => h.frames[0], 'first HTTP response');
      h.created(first.response, 'http-items-a');
      const prefix = h.content(first.response, 'http-items-a', 0, 'ALPHA-PREFIX');
      const thought = h.content(first.response, 'http-items-a', 1, 'ALPHA-THOUGHT', { thought: true });
      const fast = { type: 'function_call', id: 'http-fast-item', call_id: 'http-fast-call',
        name: 'native_probe', arguments: '{}', async: true, status: 'completed' };
      const slow = { type: 'function_call', id: 'http-slow-item', call_id: 'http-slow-call',
        name: 'native_probe', arguments: '{"slow":true}', async: true, status: 'completed' };
      h.done(first.response, 'http-items-a', 2, fast);
      h.done(first.response, 'http-items-a', 3, slow);
      await h.until(() => h.executions() === 2, 'both asynchronous tools');
      const suffix = h.content(first.response, 'http-items-a', 4, 'ALPHA-SUFFIX');
      const suffixThought = h.content(first.response, 'http-items-a', 5, 'AFTER-TOOLS-THOUGHT', { thought: true });
      const unsignedThought = h.content(first.response, 'http-items-a', 6, 'UNSIGNED-AFTER-TOOLS', { thought: true, signature: false });
      h.completed(first.response, 'http-items-a', [prefix, thought, fast, slow, suffix, suffixThought, unsignedThought]);
      const second = await h.until(() => h.frames.find(frame => frame !== first
        && frame.body.input?.some(item => item.type === 'function_call_output' && item.call_id === fast.call_id)),
      'fast result physical successor');
      const [request] = await rows(h.app, 'ModelRequest', { turn_id: turn.turnId });
      assert.equal((await rows(h.app, 'ModelRequest', { turn_id: turn.turnId })).length, 1,
        'the first two physical responses belong to one logical ModelRequest');
      h.created(second.response, 'http-items-b');
      const beta = h.content(second.response, 'http-items-b', 0, 'BETA-TEXT');
      const betaThought = h.content(second.response, 'http-items-b', 1, 'BETA-THOUGHT', { thought: true });
      h.completed(second.response, 'http-items-b', [beta, betaThought]);
      await h.until(() => hasCompletedResponse(h.app, request.id, 'http-items-b'),
        'second response durable completion');
      h.releaseTool();
      const successor = await h.until(() => h.frames.find(frame => frame !== first && frame !== second),
        'full request after the slow tool');
      assert.equal(successor.body.previous_response_id, undefined, 'HTTP resumes from the committed full Context');
      assert.equal(successor.body.store, false);
      const markers = ['ALPHA-PREFIX', 'ALPHA-THOUGHT', 'ALPHA-SUFFIX', 'AFTER-TOOLS-THOUGHT', 'UNSIGNED-AFTER-TOOLS', 'BETA-TEXT', 'BETA-THOUGHT'];
      // Signatures also contain their text marker; compare semantic text separately from signatures.
      const plainParts = parts => parts.filter(part => typeof part.text === 'string').map(part => part.text);
      assertOnce(plainParts(await contextParts(h.app)), markers, 'successor Context');
      const bodyText = successor.body.input.flatMap(item =>
        (item.content ?? item.summary ?? []).filter(part => typeof part.text === 'string').map(part => part.text));
      assertOnce(bodyText, markers, 'actual full successor HTTP input');
      for (const marker of ['ALPHA-THOUGHT', 'AFTER-TOOLS-THOUGHT', 'BETA-THOUGHT']) {
        assert.equal(successor.body.input.filter(item => item.encrypted_content === `signature-${marker}`).length, 1);
      }
      const unsignedPart = (await contextParts(h.app)).find(part => part.text === 'UNSIGNED-AFTER-TOOLS');
      assert.equal(unsignedPart.thoughtSignature, undefined, 'an unsigned reasoning item must not inherit another item signature');
      const serialized = JSON.stringify(await contextParts(h.app));
      assert.ok(serialized.indexOf('ALPHA-PREFIX') < serialized.indexOf(fast.call_id));
      assert.ok(serialized.indexOf(fast.call_id) < serialized.indexOf('ALPHA-SUFFIX'));
      assert.ok(serialized.indexOf('ALPHA-SUFFIX') < serialized.indexOf('BETA-TEXT'));
      h.created(successor.response, 'http-items-final');
      h.completed(successor.response, 'http-items-final', [h.content(successor.response, 'http-items-final', 0, 'FINAL-TEXT')]);
      assert.equal((await turn.completion).terminalStatus, 'completed');
      assertOnce(plainParts(await aggregateParts(h.app, request.id)), markers, 'original logical request final CAS');
      assertOnce(plainParts(await contextParts(h.app)), [...markers, 'FINAL-TEXT'], 'completed Context');
      assert.equal(h.executions(), 2, 'text closure must not replay the tools');
    });
  });

test('native HTTP closes done-only and terminal-only items once, including late duplicate done and reopen',
  { timeout: 30_000 }, async () => {
    await withHttpRuntime(async h => {
      const turn = await h.startTurn('item-closure');
      const first = await h.until(() => h.frames[0], 'item closure request');
      h.created(first.response, 'http-closure');
      const alpha = h.content(first.response, 'http-closure', 0, 'CLOSED-ALPHA');
      const doneOnly = h.content(first.response, 'http-closure', 1, 'CLOSED-DONE-ONLY', { delta: false });
      const reasoning = h.content(first.response, 'http-closure', 2, 'CLOSED-REASONING', { thought: true, delta: false });
      const multiReasoning = { type: 'reasoning', id: 'http-closure-multi-summary',
        summary: [{ type: 'summary_text', text: 'CLOSED-MULTI-ONE' }, { type: 'summary_text', text: 'CLOSED-MULTI-TWO' }],
        encrypted_content: 'signature-multi-summary' };
      h.send(first.response, { type: 'response.output_item.added', response_id: 'http-closure', output_index: 3,
        item: { type: 'reasoning', id: multiReasoning.id, summary: [] } });
      for (const [summary_index, part] of multiReasoning.summary.entries()) {
        h.send(first.response, { type: 'response.reasoning_summary_text.delta', response_id: 'http-closure',
          item_id: multiReasoning.id, output_index: 3, summary_index, delta: part.text });
      }
      h.done(first.response, 'http-closure', 3, multiReasoning);
      await h.until(async () => {
        const parts = await contextParts(h.app);
        return ['CLOSED-ALPHA', 'CLOSED-DONE-ONLY', 'CLOSED-REASONING']
          .every(marker => parts.some(part => part.text === marker))
          && parts.some(part => part.text === 'CLOSED-MULTI-ONE\nCLOSED-MULTI-TWO');
      }, 'each completed item persisted before response.completed');
      const [request] = await rows(h.app, 'ModelRequest', { turn_id: turn.turnId });
      assert.equal(request.status, 'streaming', 'item durability must precede the response terminal');
      assert.equal((await rows(h.app, 'ModelRequestMessageLink', { model_request_id: request.id })).length, 1);
      // A late duplicate arrives after other items changed the cumulative current revision.
      h.done(first.response, 'http-closure', 0, alpha);
      h.done(first.response, 'http-closure', 2, reasoning);
      const terminalOnly = h.content(first.response, 'http-closure', 4, 'CLOSED-TERMINAL-ONLY', { delta: false, close: false });
      const terminalReasoning = h.content(first.response, 'http-closure', 5, 'CLOSED-TERMINAL-REASONING',
        { thought: true, delta: false, close: false });
      h.completed(first.response, 'http-closure', [alpha, doneOnly, reasoning, multiReasoning, terminalOnly, terminalReasoning]);
      assert.equal((await turn.completion).terminalStatus, 'completed');
      const markers = ['CLOSED-ALPHA', 'CLOSED-DONE-ONLY', 'CLOSED-REASONING',
        'CLOSED-MULTI-ONE', 'CLOSED-MULTI-TWO', 'CLOSED-TERMINAL-ONLY', 'CLOSED-TERMINAL-REASONING'];
      const texts = async () => (await contextParts(h.app)).filter(part => typeof part.text === 'string').map(part => part.text);
      assertOnce(await texts(), markers, 'completed item Context');
      assertOnce((await aggregateParts(h.app, request.id)).map(part => part.text ?? ''), markers, 'final CAS');
      const before = await rows(h.app, 'ContextSegmentSource', { source_kind: 'message_revision' });
      await h.reopen();
      assertOnce(await texts(), markers, 'reopened Context');
      assert.deepEqual(await rows(h.app, 'ContextSegmentSource', { source_kind: 'message_revision' }), before,
        'reopen must not append an aggregate alongside the already closed items');
      const next = await h.startTurn('after-item-closure-reopen');
      const frame = await h.until(() => h.frames[1], 'request after reopen');
      const wireTexts = frame.body.input.flatMap(item => (item.content ?? item.summary ?? [])
        .filter(part => typeof part.text === 'string').map(part => part.text));
      assertOnce(wireTexts, markers, 'reopened next HTTP request');
      for (const marker of ['CLOSED-REASONING', 'CLOSED-TERMINAL-REASONING']) {
        assert.equal(frame.body.input.filter(item => item.encrypted_content === `signature-${marker}`).length, 1);
      }
      assert.equal(frame.body.input.filter(item => item.encrypted_content === 'signature-multi-summary').length, 1);
      h.created(frame.response, 'http-after-reopen');
      h.completed(frame.response, 'http-after-reopen', [h.content(frame.response, 'http-after-reopen', 0, 'REOPEN-FINISHED')]);
      assert.equal((await next.completion).terminalStatus, 'completed');
      assert.equal(h.executions(), 0);
    });
  });

for (const closedDeltas of [true, false]) test(`native HTTP retains ${closedDeltas ? 'streamed' : 'done-only'} completed plain/reasoning items through a provider error and Runtime reopen`,
  { timeout: 30_000 }, async () => {
    await withHttpRuntime(async h => {
      const turn = await h.startTurn('closed-before-error');
      const first = await h.until(() => h.frames[0], 'erroring HTTP request');
      h.created(first.response, 'http-error');
      const text = h.content(first.response, 'http-error', 0, 'ERROR-CLOSED-TEXT', { delta: closedDeltas });
      const thought = h.content(first.response, 'http-error', 1, 'ERROR-CLOSED-REASONING', { thought: true, delta: closedDeltas });
      h.content(first.response, 'http-error', 2, 'ERROR-UNFINISHED-TEXT', { close: false });
      h.send(first.response, { type: 'response.failed', response: { id: 'http-error', status: 'failed',
        model: MODEL, output: [text, thought], error: { code: 'invalid_api_key', message: 'Synthetic terminal provider error.' } } });
      first.response.end('data: [DONE]\n\n');
      assert.equal((await turn.completion).terminalStatus, 'failed');
      const markers = ['ERROR-CLOSED-TEXT', 'ERROR-CLOSED-REASONING'];
      const [failedRequest] = await rows(h.app, 'ModelRequest', { turn_id: turn.turnId });
      assertOnce((await aggregateParts(h.app, failedRequest.id)).map(part => part.text ?? ''),
        [...markers, 'ERROR-UNFINISHED-TEXT'], 'failed transcript aggregate');
      assertOnce((await contextParts(h.app)).map(part => part.text ?? ''), markers, 'failed Turn Context');
      assert.doesNotMatch(JSON.stringify(await contextParts(h.app)), /ERROR-UNFINISHED-TEXT/,
        'an unfinished delta is failed transcript content, not a closed Context item');
      await h.reopen();
      assertOnce((await contextParts(h.app)).map(part => part.text ?? ''), markers, 'failed Turn reopened Context');
      const next = await h.startTurn('after-error-reopen');
      const frame = await h.until(() => h.frames[1], 'request after the failed Turn');
      const wireTexts = frame.body.input.flatMap(item => (item.content ?? item.summary ?? [])
        .filter(part => typeof part.text === 'string').map(part => part.text));
      assertOnce(wireTexts, markers, 'next HTTP request after provider failure');
      assert.doesNotMatch(JSON.stringify(frame.body.input), /ERROR-UNFINISHED-TEXT/);
      assert.equal(frame.body.input.filter(item => item.encrypted_content === 'signature-ERROR-CLOSED-REASONING').length, 1);
      h.created(frame.response, 'http-error-recovered');
      h.completed(frame.response, 'http-error-recovered', [h.content(frame.response, 'http-error-recovered', 0, 'ERROR-RECOVERED')]);
      assert.equal((await next.completion).terminalStatus, 'completed');
    });
  });

test('native result pump and completed disposal serialize one frozen result across transport failure',
  { timeout: 30_000 }, async () => {
    const prepareEntered = deferred();
    const duplicatePrepareEntered = deferred();
    const releasePrepare = deferred();
    const disposalEntered = deferred();
    const requests = [];
    let prepareCount = 0;
    const capabilities = { asyncTools: true, steering: true, reasoningUpdates: true,
      multiplexing: false, explicitCaching: true };
    // Script only the transport cutoff. All admissions, tool execution, frozen result writes,
    // Context appends, retry decisions and Turn completion run through the production Runtime.
    const adapter = {
      providerId: 'native-http-context-provider',
      async materializeNativeToolOutput(outputs) { return outputs; },
      async sendFullRequest(request, controls) {
        const round = requests.length;
        requests.push(request);
        const responseId = `http-dispose-race-${round}`;
        let sequence = 0;
        const emit = (kind, content) => controls.onEvent({ kind, streamSeq: String(++sequence), content });
        const ended = deferred();
        controls.native.onController({
          get responseId() { return responseId; },
          endLogicalRequest() { ended.resolve(); },
          async steer() { assert.fail('this race does not steer'); },
          async submitToolResults() { assert.fail('a settled batch must use the next full request'); }
        });
        try {
          await emit('native_control', { type: 'response.created', responseId, capabilities });
          if (round === 0) {
            await emit('output_item_done', {
              type: 'tool_calls', calls: [{ id: 'http-dispose-race-call', ordinal: 0,
                name: 'native_probe', arguments: {}, async: false }],
              outputItem: { id: 'http-dispose-race-item', ordinal: 0, providerResponseId: responseId }
            });
            await emit('native_control', { type: 'response.completed', responseId,
              usage: { input_tokens: 10, output_tokens: 1 } });
            await prepareEntered.promise;
            throw new kernel.ProviderTransientError('connection_interrupted',
              'Synthetic transport reset after response.completed.', true);
          }
          await emit('native_control', { type: 'response.completed', responseId,
            usage: { input_tokens: 12, output_tokens: 2 } });
          await emit('completed', { role: 'model', parts: [{ text: 'RACE-CONTINUED' }] });
        } finally {
          controls.native.onController(undefined);
        }
      }
    };
    const originalDispose = NativeRequestSession.prototype.dispose;
    NativeRequestSession.prototype.dispose = function (...arguments_) {
      disposalEntered.resolve(arguments_[0]);
      return originalDispose.apply(this, arguments_);
    };
    try {
      await withHttpRuntime(async h => {
        const originalPrepare = h.app.contentStore.prepare.bind(h.app.contentStore);
        h.app.contentStore.prepare = async (...arguments_) => {
          if (arguments_[2] === 'application/vnd.limcode.native-child-handle-projection+json') {
            prepareCount += 1;
            if (prepareCount === 1) {
              prepareEntered.resolve();
              await releasePrepare.promise;
            } else {
              duplicatePrepareEntered.resolve();
              // A broken implementation reaches this second preparation before the first facts
              // commit. Let the first one win so the duplicate assertion reproduces reliably.
              await delay(60);
            }
          }
          return originalPrepare(...arguments_);
        };
        const turn = await h.startTurn('pump-dispose-race');
        await prepareEntered.promise;
        assert.equal(await disposalEntered.promise, 'completed',
          'the disposal must overlap the already-started native result freeze');
        // The repaired queue never starts a second CAS preparation. The short deadline releases
        // its first operation; on the old path the second preparation supplies the release.
        await Promise.race([duplicatePrepareEntered.promise, delay(100)]);
        releasePrepare.resolve();
        const result = await turn.completion;
        assert.equal(result.terminalStatus, 'completed');
        assert.equal(h.executions(), 1, 'transport recovery must reuse the settled tool');
        assert.equal(prepareCount, 1, 'pump and disposal must freeze the same result once');
        const calls = await rows(h.app, 'ToolCall', { turn_id: turn.turnId });
        assert.equal(calls.length, 1);
        assert.equal((await rows(h.app, 'ToolModelResult', { tool_call_id: calls[0].id })).length, 1);
        assert.equal((await rows(h.app, 'ToolCallEvent', {
          tool_call_id: calls[0].id, event_kind: 'native_child_handle_projection'
        })).length, 1);
        assert.equal((await rows(h.app, 'ContextSegmentSource', {
          source_kind: 'tool_model_result'
        })).length, 1, 'both closure paths must share the same result Context occurrence');
        assert.equal((await rows(h.app, 'TurnTermination', { turn_id: turn.turnId }))[0].terminal_status, 'completed');
        assert.ok((await rows(h.app, 'ModelRequest', { turn_id: turn.turnId }))
          .every(row => row.status === 'terminal' && row.terminal_state !== null),
        'no request may remain streaming after closure');
        const successor = requests.find(request => request.context.some(item => {
          if (item.contentType !== 'application/vnd.limcode.context-tool-pair+json') return false;
          return JSON.parse(item.content).toolModelResult;
        }));
        assert.ok(successor, 'recovery must send the already committed tool result');
        assert.equal(successor.context.filter(item => item.contentType === 'application/vnd.limcode.context-tool-pair+json'
          && JSON.parse(item.content).toolModelResult).length, 1);
      }, { providerAdapter: adapter, retryPolicy: { enabled: true, maxRetries: 2, retryDelayMs: 0 } });
    } finally {
      releasePrepare.resolve();
      NativeRequestSession.prototype.dispose = originalDispose;
    }
  });

test('native HTTP completed-call deduplication ignores object key order while preserving frozen values and array order',
  { timeout: 30_000 }, async t => {
    const { LlmEventType } = require(path.join(compiledRoot, 'backend/world/modules/llm/events.js'));
    const original = {
      b: 2, a: 1, nested: { z: 9, a: 8 },
      array: [{ y: 2, x: 1 }, { p: 3, q: 4 }], list: [3, 1, 2]
    };
    const reordered = {
      list: [3, 1, 2], array: [{ x: 1, y: 2 }, { q: 4, p: 3 }],
      nested: { a: 8, z: 9 }, a: 1, b: 2
    };
    const originalBytes = JSON.stringify(original);
    async function runBoundary(boundary, laterArguments) {
      const responseId = `http-call-dedup-${boundary}`;
      const call = arguments_ => ({ type: 'function_call', id: 'dedup-item', call_id: 'dedup-call',
        name: 'dedup_probe', arguments: JSON.stringify(arguments_), async: false, status: 'completed' });
      const outputArguments = boundary === 'arguments-to-item' ? laterArguments : original;
      const script = [
        { type: 'response.created', response: { id: responseId, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', response_id: responseId, output_index: 0,
          item: { ...call(original), arguments: '', status: 'in_progress' } },
        { type: 'response.function_call_arguments.delta', response_id: responseId,
          item_id: 'dedup-item', output_index: 0, delta: originalBytes },
        { type: 'response.function_call_arguments.done', response_id: responseId,
          item_id: 'dedup-item', call_id: 'dedup-call', name: 'dedup_probe', output_index: 0,
          arguments: originalBytes },
        { type: 'response.output_item.done', response_id: responseId, output_index: 0,
          item: call(outputArguments) },
        { type: 'response.completed', response: { id: responseId, status: 'completed',
          output: [call(laterArguments)], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } }
      ];
      const server = http.createServer((request, response) => {
        request.resume();
        request.once('end', () => {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          script.forEach((event, sequence_number) => {
            response.write(`data: ${JSON.stringify({ sequence_number, ...event })}\n\n`);
          });
          response.end('data: [DONE]\n\n');
        });
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const capability = createLlmProviderCapability({ settings: {
        id: 'native-http-dedup-provider', name: 'Native HTTP Dedup', provider: 'openai-responses',
        model: MODEL, models: [{ id: MODEL, name: MODEL }], apiKey: 'offline-test-key',
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, toolCallFormat: 'function-call',
        openaiResponsesTransport: 'http', nativeResponses: NATIVE, stream: true,
        retryOnError: false, retryMaxAttempts: 0, enableMultimodalTools: true,
        promptCache: { enabled: false, mode: 'key', ttl: '30m' }, modelConfigs: [], createdAt: 1, updatedAt: 1
      } });
      const events = [];
      let controller;
      try {
        capability.start({ id: `dedup-${boundary}`, invocationId: `dedup-${boundary}-invocation`,
          conversationId: 'native-http-dedup-conversation',
          contents: [{ role: 'user', parts: [{ text: 'Call dedup_probe once.' }] }],
          tools: [{ name: 'dedup_probe', description: 'Check one immutable native call.',
            parameters: { type: 'object', properties: {
              a: { type: 'number' }, b: { type: 'number' }, nested: { type: 'object' },
              array: { type: 'array', items: { type: 'object' } }, list: { type: 'array', items: { type: 'number' } }
            }, additionalProperties: false } }]
        }, event => {
          events.push(event);
          if (event.type === LlmEventType.NativeControl && event.payload?.event?.type === 'response.completed') {
            controller.endLogicalRequest();
          }
        }, { native: { onController(next) { controller = next ?? controller; } } });
        const terminal = await until(() => events.find(event =>
          event.type === LlmEventType.Done || event.type === LlmEventType.Error), `${boundary} completion`);
        const calls = events.filter(event => event.type === LlmEventType.ToolCall)
          .flatMap(event => event.payload.calls);
        assert.equal(calls.length, 1, 'repeated completion must never emit a second call');
        assert.equal(calls[0].id, 'dedup-call');
        assert.equal(calls[0].argsJson, originalBytes, 'comparison must not rewrite the emitted arguments');
        return terminal;
      } finally {
        capability.dispose();
        await new Promise(resolve => server.close(resolve));
      }
    }
    for (const boundary of ['arguments-to-item', 'item-to-terminal']) {
      await t.test(`${boundary}: nested object keys may reorder`, async () => {
        assert.equal((await runBoundary(boundary, reordered)).type, LlmEventType.Done);
      });
      await t.test(`${boundary}: an actual nested value change is rejected`, async () => {
        const terminal = await runBoundary(boundary, { ...reordered, nested: { a: 8, z: 99 } });
        assert.equal(terminal.type, LlmEventType.Error);
        assert.match(terminal.payload.message, /changed its frozen facts/);
      });
      await t.test(`${boundary}: array order remains part of the frozen arguments`, async () => {
        const terminal = await runBoundary(boundary, { ...reordered, list: [2, 1, 3] });
        assert.equal(terminal.type, LlmEventType.Error);
        assert.match(terminal.payload.message, /changed its frozen facts/);
      });
    }
  });
