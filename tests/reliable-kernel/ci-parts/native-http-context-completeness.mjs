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

const { emptyConversationContextHandleStateStep } = require(path.join(compiledRoot, 'backend/reliableKernel/conversationContextHandleState.js'));

const { createLlmProviderCapability } = require(path.join(compiledRoot, 'backend/capabilities/llmProvider.js'));

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
      emptyConversationContextHandleStateStep(CONVERSATION, now),
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

function registerCases(test) {

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
}

export { registerCases };
