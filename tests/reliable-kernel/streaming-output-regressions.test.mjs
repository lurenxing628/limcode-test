import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const root = process.cwd();
const kernel = await import(pathToFileURL(path.join(
  root,
  'dist/extension/backend/reliableKernel/index.js'
)).href);
const clientFeedShared = await import(pathToFileURL(path.join(
  root,
  'dist/extension/shared/reliableKernelClientFeed.js'
)).href);

function emptyClientProjection() {
  return {
    navigationSummary: { conversations: [] },
    activeConversationWindow: {
      conversationId: '', messages: [], visibleMessageCount: '0', lastMessageSeq: '0',
      projectContexts: [], conversationProjectLinks: [], conversationReuseLinks: [],
      conversationBranchLinks: [], conversationOriginLinks: [], agentConversationLinks: [],
      queuedTurnIntents: [], compressionBlocks: [], conversationContextStatuses: [], taskList: []
    },
    activeTurnSummary: {
      turns: [], executionLeases: [], turnTerminations: [], turnExecutorLinks: [],
      modelRequests: [], modelContextProjections: [], modelRequestMessageLinks: []
    },
    activeToolAndInteractionSummary: {
      messageTurnLinks: [], toolCalls: [], toolCallSourceLinks: [], toolCallPolicySnapshots: [],
      toolCallEvents: [], toolExecutions: [], toolOutcomes: [], toolModelResults: [],
      toolResultArtifacts: [], interactionRequests: [], interactionOwnerLinks: [],
      interactionToolCallLinks: [], interactionResponses: [], fileChangeSets: [],
      fileChangeSetMembers: [], fileChangeDecisions: [], fileMutationReceipts: [],
      fileMutationReceiptMembers: [], processes: [], processOriginLinks: [], processOutputChunks: [],
      processReceipts: []
    },
    subagentDeliverySummary: {
      childExecutions: [], childExecutionParentLinks: [], childExecutionTurnLinks: [],
      childExecutionActiveTurnLinks: [], childTurns: [], childExecutionLeases: [],
      childTurnTerminations: [], childTurnExecutorLinks: [], childExecutionActivities: [],
      answerBridges: [], answerSubmissions: [], runtimeInboxItems: [], runtimeDeliveries: [],
      runtimeDeliveryIntentLinks: []
    }
  };
}

async function createWebviewTestServer() {
  return createWebviewSsrServer();
}

test('detail load errors use bounded backoff, manual reset, and durable invalidation', async (context) => {
  const server = await createWebviewTestServer();
  const previousWindow = globalThis.window;
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const posted = [];
  let persistedState;
  let nextTimerId = 1;
  const timers = new Map();
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(callback) {
      callback(performance.now());
      return 1;
    },
    cancelAnimationFrame() {},
    acquireVsCodeApi() {
      return {
        postMessage(message) { posted.push(message); },
        getState() { return persistedState; },
        setState(value) { persistedState = value; }
      };
    }
  };
  context.after(async () => {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  });

  const pinia = await import('pinia');
  const { useReliableKernelClientFeedStore } = await server.ssrLoadModule(
    '/src/stores/useReliableKernelClientFeedStore.ts'
  );
  pinia.setActivePinia(pinia.createPinia());
  const store = useReliableKernelClientFeedStore();
  store.observe({
    type: 'reliable-kernel.snapshot',
    sessionId: 'detail-retry-session',
    hostBootId: 'detail-retry-boot',
    messageSeq: '1',
    snapshotCommitSeq: '1',
    projections: {}
  });

  globalThis.setTimeout = (callback, delay = 0) => {
    const id = nextTimerId++;
    timers.set(id, { callback, delay: Number(delay) });
    return id;
  };
  globalThis.clearTimeout = (id) => {
    timers.delete(id);
  };

  const memberId = 'member-detail-retry';
  const detailKey = `file-change-diff:${memberId}`;
  const detailRequests = () => posted.filter((message) => message.type === 'reliable-kernel.detail-request');
  const failLatest = (message) => {
    const request = detailRequests().at(-1);
    assert.ok(request);
    store.observe({
      type: 'reliable-kernel.detail-error',
      requestId: request.requestId,
      sessionId: 'detail-retry-session',
      message
    });
  };
  const runTimer = (delay) => {
    const timer = [...timers.entries()].find(([, value]) => value.delay === delay);
    assert.ok(timer, `expected a ${delay}ms retry timer`);
    timers.delete(timer[0]);
    timer[1].callback();
  };

  store.requestDetail('file-change-diff', memberId, { priority: 'expanded' });
  assert.equal(detailRequests().length, 1);
  failLatest('first failure');
  assert.equal(store.details[detailKey].retryCount, 1);
  runTimer(250);
  assert.equal(detailRequests().length, 2);
  failLatest('second failure');
  runTimer(750);
  assert.equal(detailRequests().length, 3);
  failLatest('third failure');
  runTimer(2_000);
  assert.equal(detailRequests().length, 4);
  failLatest('fourth failure');
  assert.equal(store.details[detailKey].status, 'error');
  assert.equal(store.details[detailKey].retryCount, 4);
  assert.equal([...timers.values()].some((timer) => timer.delay < 20_000), false,
    'automatic retries stop after the three configured retry admissions');

  store.requestDetail('file-change-diff', memberId, { priority: 'expanded' });
  assert.equal(detailRequests().length, 4, 'ordinary demand must not bypass an exhausted retry budget');
  store.retryDetail('file-change-diff', memberId, { priority: 'expanded' });
  assert.equal(detailRequests().length, 5, 'manual retry resets the exhausted budget immediately');
  assert.equal(store.details[detailKey].status, 'loading');
  failLatest('manual attempt failure');
  assert.equal(store.details[detailKey].retryCount, 1);

  store.observe({
    type: 'reliable-kernel.changes',
    sessionId: 'detail-retry-session',
    hostBootId: 'detail-retry-boot',
    messageSeq: '2',
    commitSeq: '2',
    changes: [{
      type: 'FileChangeSetMember',
      operation: 'upsert',
      id: memberId,
      record: { id: memberId, change_set_id: 'change-set-detail-retry' }
    }]
  });
  assert.equal(store.details[detailKey], undefined, 'a durable member revision invalidates its stale error cache');
  assert.equal([...timers.values()].some((timer) => timer.delay === 250), false,
    'durable invalidation also cancels the pending retry timer');
  store.requestDetail('file-change-diff', memberId, { priority: 'expanded' });
  assert.equal(detailRequests().length, 6, 'fresh demand is admitted after durable invalidation');
});

test('pinned timeline bodies do not evict the only oversized visible detail or ordinary LRU entry', async (context) => {
  const server = await createWebviewTestServer();
  const previousWindow = globalThis.window;
  const posted = [];
  let persistedState;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(callback) {
      callback(performance.now());
      return 1;
    },
    cancelAnimationFrame() {},
    acquireVsCodeApi() {
      return {
        postMessage(message) { posted.push(message); },
        getState() { return persistedState; },
        setState(value) { persistedState = value; }
      };
    }
  };
  context.after(async () => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  });

  const pinia = await import('pinia');
  const { useReliableKernelClientFeedStore } = await server.ssrLoadModule(
    '/src/stores/useReliableKernelClientFeedStore.ts'
  );
  pinia.setActivePinia(pinia.createPinia());
  const store = useReliableKernelClientFeedStore();
  store.observe({
    type: 'reliable-kernel.snapshot',
    sessionId: 'detail-cache-session',
    hostBootId: 'detail-cache-boot',
    messageSeq: '1',
    snapshotCommitSeq: '1',
    projections: {}
  });

  const pinnedKey = 'message-content:pinned-visible-revision';
  const oversizedKey = 'tool-result-content:oversized-visible-tool';
  store.details[pinnedKey] = { status: 'ready', text: 'pinned', totalBytes: 32 * 1024 * 1024 };
  store.detailCacheMeta[pinnedKey] = { lastAccessedAt: 1, bytes: 32 * 1024 * 1024 };
  store.details[oversizedKey] = { status: 'ready', text: 'oversized', totalBytes: 16 * 1024 * 1024 + 1 };
  store.detailCacheMeta[oversizedKey] = { lastAccessedAt: 2, bytes: 16 * 1024 * 1024 + 1 };
  store.setPinnedDetailKeys([pinnedKey]);

  assert.equal(store.details[pinnedKey]?.status, 'ready');
  assert.equal(store.details[oversizedKey]?.status, 'ready',
    'the sole oversized unpinned detail must remain mounted instead of starting a hydration loop');
  store.requestDetail('tool-result-content', 'oversized-visible-tool', { priority: 'expanded' });
  assert.equal(posted.some((message) => message.type === 'reliable-kernel.detail-request'), false,
    'ready oversized detail demand must not issue another transport request');

  delete store.details[oversizedKey];
  delete store.detailCacheMeta[oversizedKey];
  const ordinaryKey = 'tool-arguments-content:ordinary-visible-tool';
  store.details[ordinaryKey] = { status: 'ready', text: 'ordinary', totalBytes: 8 };
  store.detailCacheMeta[ordinaryKey] = { lastAccessedAt: 3, bytes: 8 };
  store.setPinnedDetailKeys([pinnedKey]);
  assert.equal(store.details[ordinaryKey]?.status, 'ready',
    'pinned timeline bytes must not consume the ordinary detail LRU budget');
});
test('transient sequence gap retains the contiguous prefix and atomically adopts a cumulative snapshot', async (context) => {
  const server = await createWebviewTestServer();
  const previousWindow = globalThis.window;
  const posted = [];
  let persistedState;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(callback) {
      callback(performance.now());
      return 1;
    },
    cancelAnimationFrame() {},
    acquireVsCodeApi() {
      return {
        postMessage(message) { posted.push(message); },
        getState() { return persistedState; },
        setState(value) { persistedState = value; }
      };
    }
  };
  context.after(async () => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  });

  const pinia = await import('pinia');
  const { useReliableKernelClientFeedStore } = await server.ssrLoadModule(
    '/src/stores/useReliableKernelClientFeedStore.ts'
  );
  pinia.setActivePinia(pinia.createPinia());
  const store = useReliableKernelClientFeedStore();
  store.observe({
    type: 'reliable-kernel.snapshot',
    sessionId: 'transient-gap-session',
    hostBootId: 'transient-gap-boot',
    navigationGeneration: '7',
    messageSeq: '1',
    snapshotCommitSeq: '0',
    projections: { activeConversationWindow: { conversationId: 'conversation-transient-gap' } }
  });

  const item = (fromStreamSeq, streamSeq, text) => ({
    turnId: 'turn-transient-gap',
    modelRequestId: 'request-transient-gap',
    requestSeq: '1',
    providerId: 'provider-transient-gap',
    modelId: 'model-transient-gap',
    attemptSeq: '1',
    socketGeneration: '1',
    afterCommitSeq: '0',
    fromStreamSeq,
    observedAt: '2026-08-21T00:00:00.000Z',
    event: {
      kind: 'output_delta',
      streamSeq,
      content: { type: 'text_delta', text }
    }
  });
  const envelope = (deliveryId, events) => ({
    type: 'reliable-kernel.transient-batch',
    deliveryId,
    sessionId: 'transient-gap-session',
    hostBootId: 'transient-gap-boot',
    navigationGeneration: '7',
    conversationId: 'conversation-transient-gap',
    events
  });

  store.observe(envelope('delivery-contiguous', [item('1', '1', 'A')]));
  assert.equal(store.transientModelRequests['request-transient-gap'].text, 'A');
  assert.ok(posted.some((message) =>
    message.type === 'reliable-kernel.transient-ack'
    && message.deliveryId === 'delivery-contiguous'
  ));

  store.observe(envelope('delivery-gap', [item('3', '3', 'C')]));
  const retained = store.transientModelRequests['request-transient-gap'];
  assert.equal(retained.text, 'A', 'the renderer must not accept a non-contiguous suffix');
  assert.equal(retained.streamSeq, '1');
  assert.equal(retained.recovering, true);
  assert.equal(posted.some((message) =>
    message.type === 'reliable-kernel.transient-ack'
    && message.deliveryId === 'delivery-gap'
  ), false, 'a gapped delivery intentionally withholds its ACK');
  const request = posted.find((message) => message.type === 'reliable-kernel.transient-snapshot-request');
  assert.ok(request);
  assert.equal(request.afterStreamSeq, '1');
  assert.equal(request.modelRequestId, 'request-transient-gap');

  store.observe({
    type: 'reliable-kernel.transient-snapshot',
    deliveryId: 'delivery-replay',
    requestId: request.requestId,
    sessionId: 'transient-gap-session',
    hostBootId: 'transient-gap-boot',
    navigationGeneration: '7',
    conversationId: 'conversation-transient-gap',
    turnId: 'turn-transient-gap',
    modelRequestId: 'request-transient-gap',
    requestSeq: '1',
    providerId: 'provider-transient-gap',
    modelId: 'model-transient-gap',
    attemptSeq: '1',
    socketGeneration: '1',
    afterCommitSeq: '0',
    headStreamSeq: '3',
    observedAt: '2026-08-21T00:00:01.000Z',
    events: [item('1', '3', 'ABC')]
  });

  const recovered = store.transientModelRequests['request-transient-gap'];
  assert.equal(recovered.text, 'ABC');
  assert.equal(recovered.streamSeq, '3');
  assert.equal(recovered.recovering, false);
  assert.ok(posted.some((message) =>
    message.type === 'reliable-kernel.transient-ack'
    && message.deliveryId === 'delivery-replay'
    && message.heads[0]?.streamSeq === '3'
  ));
  assert.ok(posted.some((message) =>
    message.type === 'reliable-kernel.client-diagnostic'
    && message.eventKind === 'transient-snapshot-replayed'
  ));
  // The panel routes Feed control through the one shared predicate (main-panel-feed-routing drives it).
  const { isReliableKernelControlMessage } = await server.ssrLoadModule(path.join(root, 'shared/reliableKernelClientFeed.ts'));
  for (const type of ['reliable-kernel.transient-ack', 'reliable-kernel.transient-snapshot-request']) {
    assert.equal(isReliableKernelControlMessage({ type }), true, `${type} is Feed control`);
  }
  const mainPanel = fs.readFileSync(path.join(root, 'vscode/panels/MainPanel.ts'), 'utf8');
  assert.match(mainPanel, /isReliableKernelControlMessage\(raw\)/);
});

test('completed transient tool preview remains authoritative until message body and tool facts are ready', async (context) => {
  const server = await createWebviewTestServer();
  context.after(async () => server.close());
  const { reconcileReliableTransientRequests } = await server.ssrLoadModule(
    '/src/domain/reliableTransientLifecycle.ts'
  );
  const requests = {
    'request-tool-handoff': {
      conversationId: 'conversation-tool-handoff',
      turnId: 'turn-tool-handoff',
      modelRequestId: 'request-tool-handoff',
      requestSeq: '1',
      providerId: 'provider',
      modelId: 'model',
      afterCommitSeq: '1',
      streamSeq: '3',
      text: '',
      thought: '',
      outputParts: [{ id: 'provider-call-handoff', functionCall: { name: 'read', args: { path: 'a.ts' } } }],
      toolCalls: [{
        id: 'preview:provider-call-handoff',
        callId: 'provider-call-handoff',
        name: 'read',
        argumentsText: '{"path":"a.ts"}',
        receivedChars: 15,
        final: true,
        createdAt: 1,
        updatedAt: 2
      }],
      status: 'completed',
      startedAt: 1,
      updatedAt: 2
    }
  };
  const records = {
    ModelRequest: {
      'request-tool-handoff': {
        id: 'request-tool-handoff',
        turn_id: 'turn-tool-handoff',
        request_seq: '1',
        status: 'terminal',
        terminal_state: 'completed'
      }
    },
    ModelRequestMessageLink: {
      link: {
        id: 'link',
        model_request_id: 'request-tool-handoff',
        message_id: 'message-tool-handoff'
      }
    },
    Message: {
      'message-tool-handoff': {
        id: 'message-tool-handoff',
        revision_id: 'revision-tool-handoff'
      }
    },
    ToolCall: {
      'tool-call-handoff': {
        id: 'tool-call-handoff',
        turn_id: 'turn-tool-handoff',
        tool_name: 'read'
      }
    },
    ToolCallSourceLink: {
      source: {
        id: 'source',
        tool_call_id: 'tool-call-handoff',
        model_request_id: 'request-tool-handoff',
        message_id: 'message-tool-handoff',
        provider_call_id: 'provider-call-handoff',
        provider_ordinal: 0
      }
    }
  };

  reconcileReliableTransientRequests(requests, records, {});
  assert.ok(requests['request-tool-handoff'], 'durable shell/tool rows alone cannot retire the visible preview');
  reconcileReliableTransientRequests(requests, records, {
    'message-content:revision-tool-handoff': { status: 'ready', text: '{}', totalBytes: 2 }
  });
  assert.equal(requests['request-tool-handoff'], undefined,
    'the preview retires once the durable message body and matching tool facts can render');

  const component = fs.readFileSync(path.join(
    root,
    'webview/src/components/content/parts/FunctionCallPartView.vue'
  ), 'utf8');
  assert.match(component, /if \(!partId \|\| !props\.messageId\) return undefined;/);
  assert.doesNotMatch(component, /!props\.messageId \|\| toolCall\.value/,
    'a newly visible durable ToolCall must not prematurely hide the retained preview');
  assert.match(component, /shouldKeepTransientToolCallPreview\(/,
    'the visible tool part must hand off to its matching durable execution state');
});

test('tool preview yields to a matching durable execution or outcome before the model request ends', async (context) => {
  const server = await createWebviewTestServer();
  context.after(async () => server.close());
  const { shouldKeepTransientToolCallPreview } = await server.ssrLoadModule(
    '/src/domain/reliableTransientModel.ts'
  );

  assert.equal(shouldKeepTransientToolCallPreview(undefined, undefined), true);
  assert.equal(shouldKeepTransientToolCallPreview({ status: 'queued' }, undefined), true,
    'a newly admitted call has not yet proved that execution started');
  assert.equal(shouldKeepTransientToolCallPreview({ status: 'queued' }, 'missing'), true);
  assert.equal(shouldKeepTransientToolCallPreview({ status: 'executing' }, undefined), false,
    'an executing tool must show its durable progress while the model request remains active');
  assert.equal(shouldKeepTransientToolCallPreview({ status: 'awaiting_child' }, undefined), false);
  assert.equal(shouldKeepTransientToolCallPreview({ status: 'queued' }, 'succeeded'), false,
    'a visible outcome wins even if the call status arrives a feed update later');
  assert.equal(shouldKeepTransientToolCallPreview({ status: 'success' }, 'succeeded'), false);
  assert.equal(shouldKeepTransientToolCallPreview({ status: 'error' }, 'failed'), false);
  assert.equal(shouldKeepTransientToolCallPreview({ status: 'warning' }, 'missing'), false,
    'a terminal call keeps its durable card visible while its outcome detail loads');
});

test('run_agent list reports an empty query without implying a child was started', async (context) => {
  const server = await createWebviewTestServer();
  const previousWindow = globalThis.window;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  context.after(async () => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  });
  const { runAgentToolDisplay, isRunAgentSpawnArguments } = await server.ssrLoadModule(
    '/src/components/content/toolDisplay/runAgentToolDisplay.ts'
  );
  const display = runAgentToolDisplay({
    result: { operation: 'list', scope: 'direct', totalDirect: 0, totalDescendants: 0, tasks: [] }
  });
  assert.equal(display.headerActions.length, 0);
  assert.equal(display.outputSections.length, 1);
  assert.equal(display.outputSections[0].title, '子 Agent 查询结果');
  assert.deepEqual(display.outputSections[0].rows, [
    { label: '操作', value: '列出已有子 Agent（不会启动新任务）' },
    { label: '范围', value: '直接子任务' },
    { label: '已有子任务', value: '0 个' },
    { label: '结果', value: '当前没有子任务；本次查询未启动子 Agent' }
  ]);
  for (const operation of ['list', 'read', 'wait', 'send', 'interrupt_subtree']) {
    assert.equal(isRunAgentSpawnArguments(JSON.stringify({ operation })), false, operation);
  }
  assert.equal(isRunAgentSpawnArguments('{invalid'), false);
  assert.equal(isRunAgentSpawnArguments(JSON.stringify({ operation: 'spawn' })), true);
  const component = fs.readFileSync(path.join(root,
    'webview/src/components/content/parts/FunctionCallPartView.vue'), 'utf8');
  assert.match(component, /isRunAgentSpawnArguments\(call\.args\)/,
    'the queued status must use the exact spawn operation');
});

test('process stream detail pages every CAS chunk beyond the projection window', async () => {
  const processId = 'process-detail-regression';
  const buffers = new Map();
  const rows = [];
  const expectedParts = [];
  for (let index = 0; index < 301; index += 1) {
    const bytes = index === 149
      ? Buffer.from([0xf0, 0x9f])
      : index === 150
        ? Buffer.from([0x99, 0x82])
        : Buffer.from(`${index.toString().padStart(3, '0')}|`, 'utf8');
    const objectId = `content-${index}`;
    buffers.set(objectId, bytes);
    rows.push({
      id: `chunk-${index.toString().padStart(4, '0')}`,
      process_id: processId,
      chunk_seq: BigInt(index + 1),
      stream_kind: 'stdout',
      content_object_id: objectId,
      byte_length: BigInt(bytes.length),
      created_at: '2026-08-04T00:00:00.000Z'
    });
    expectedParts.push(bytes);
  }
  const expected = Buffer.concat(expectedParts);
  const processRow = {
    id: processId,
    retained_bytes: BigInt(expected.length),
    retained_chunks: BigInt(rows.length)
  };
  let chunkIndexReads = 0;
  const database = {
    async snapshot(reads) {
      return {
        snapshotCommitSeq: '1',
        snapshot: reads.map((read) => {
          if (read.kind !== 'get') throw new Error(`unexpected read ${read.kind}`);
          if (read.domain === 'Process' && read.id === processId) return processRow;
          if (read.domain === 'ContentObject' && buffers.has(read.id)) {
            const bytes = buffers.get(read.id);
            return { id: read.id, byte_length: BigInt(bytes.length) };
          }
          return null;
        })
      };
    },
    async snapshotAll(read) {
      chunkIndexReads += 1;
      assert.equal(read.domain, 'ProcessOutputChunk');
      assert.deepEqual(read.where, { process_id: processId });
      return { snapshotCommitSeq: '1', snapshot: rows };
    }
  };
  const contentStore = {
    async readChunk(metadata, offset, maxBytes) {
      const bytes = buffers.get(metadata.id);
      assert.ok(bytes);
      return {
        chunk: bytes.subarray(offset, Math.min(bytes.length, offset + maxBytes)),
        totalBytes: bytes.length
      };
    }
  };
  const reader = new kernel.ClientDetailReader(database, contentStore);
  reader.setProcessOutputReconciler(async () => ({
    retainedBytes: String(expected.length),
    retainedChunks: String(rows.length),
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0)
  }));
  const pages = [];
  let offset = 0;
  for (;;) {
    const page = await reader.read({
      kind: 'process-stdout', recordId: processId, offset, maxBytes: 257
    });
    pages.push(Buffer.from(page.chunk, 'base64'));
    if (!page.hasMore) break;
    assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  const actual = Buffer.concat(pages);
  assert.deepEqual(actual, expected);
  assert.equal(actual.toString('utf8').includes('�'), false);
  assert.equal(chunkIndexReads, 1, 'page reads reuse the rebuildable metadata index instead of rescanning every chunk');
});

test('concurrent Message detail reads batch immutable Revision and ContentObject metadata', async () => {
  const revisionIds = Array.from({ length: 4 }, (_, index) => `revision-batch-${index}`);
  const bodies = new Map(revisionIds.map((revisionId, index) => [
    `content-batch-${index}`,
    Buffer.from(`${revisionId}:${'x'.repeat(160)}`, 'utf8')
  ]));
  const snapshotCalls = [];
  const database = {
    async snapshot(reads) {
      snapshotCalls.push(reads.map((read) => `${read.domain}:${read.id}`));
      return {
        snapshotCommitSeq: '1',
        snapshot: reads.map((read) => {
          if (read.domain === 'MessageRevision') {
            const index = revisionIds.indexOf(read.id);
            return index < 0 ? null : { id: read.id, content_object_id: `content-batch-${index}` };
          }
          if (read.domain === 'ContentObject' && bodies.has(read.id)) return { id: read.id };
          return null;
        })
      };
    }
  };
  const contentStore = {
    async readChunk(metadata, offset, maxBytes) {
      const bytes = bodies.get(metadata.id);
      assert.ok(bytes);
      const end = Math.min(bytes.length, offset + maxBytes);
      return { chunk: bytes.subarray(offset, end), totalBytes: bytes.length };
    }
  };
  const reader = new kernel.ClientDetailReader(database, contentStore);
  const firstPages = await Promise.all(revisionIds.map((recordId) => reader.read({
    kind: 'message-content', recordId, offset: 0, maxBytes: 64
  })));
  assert.equal(firstPages.every((page) => page.hasMore), true);
  assert.equal(snapshotCalls.length, 2);
  assert.deepEqual(snapshotCalls[0], revisionIds.map((id) => `MessageRevision:${id}`));
  assert.deepEqual(snapshotCalls[1], revisionIds.map((_, index) => `ContentObject:content-batch-${index}`));

  await Promise.all(firstPages.map((page, index) => reader.read({
    kind: 'message-content', recordId: revisionIds[index], offset: page.nextOffset, maxBytes: 64
  })));
  assert.equal(snapshotCalls.length, 2,
    'continuation pages reuse immutable metadata instead of issuing two more worker reads each');
});

test('turn-intent preview resolves a background command through RuntimeDeliveryIntentLink', async () => {
  const intentId = 'runtime-process-intent';
  const conversationId = 'runtime-process-conversation';
  const envelopeObjectId = 'runtime-process-envelope';
  const argumentsObjectId = 'runtime-process-arguments';
  const envelopeBytes = Buffer.from(JSON.stringify({
    version: 1,
    kind: 'runtime_continuation',
    sourceTurnId: 'runtime-process-source-turn'
  }), 'utf8');
  const argumentsBytes = Buffer.from(JSON.stringify({
    command: 'npm run check\n  -- --focused'
  }), 'utf8');
  const rows = {
    TurnIntent: [{
      id: intentId,
      conversation_id: conversationId,
      turn_id: null,
      state: 'queued',
      created_at: '2026-08-21T00:00:00.000Z',
      updated_at: '2026-08-21T00:00:00.000Z'
    }],
    ChildExecutionIntentLink: [],
    TurnIntentRevision: [{
      id: 'runtime-process-intent-revision',
      intent_id: intentId,
      revision_seq: 1n,
      content_object_id: envelopeObjectId,
      created_at: '2026-08-21T00:00:00.000Z'
    }],
    ContentObject: [
      {
        id: envelopeObjectId,
        content_type: 'application/vnd.limcode.turn-intent+json',
        byte_length: BigInt(envelopeBytes.length)
      },
      {
        id: argumentsObjectId,
        content_type: 'application/json',
        byte_length: BigInt(argumentsBytes.length)
      }
    ],
    RuntimeDeliveryIntentLink: [{
      id: 'runtime-process-delivery-intent-link',
      delivery_id: 'runtime-process-delivery',
      turn_intent_id: intentId,
      created_at: '2026-08-21T00:00:00.000Z'
    }],
    RuntimeDelivery: [{
      id: 'runtime-process-delivery',
      inbox_item_id: 'runtime-process-inbox',
      target_conversation_id: conversationId,
      target_turn_id: null,
      phase: 'next_turn',
      attempt_seq: 1n,
      retry_of_delivery_id: null,
      state: 'pending',
      failure_reason: null,
      created_at: '2026-08-21T00:00:00.000Z',
      updated_at: '2026-08-21T00:00:00.000Z'
    }],
    RuntimeInboxItem: [{
      id: 'runtime-process-inbox',
      source_kind: 'process_receipt',
      source_id: 'runtime-process-receipt'
    }],
    ProcessReceipt: [{
      id: 'runtime-process-receipt',
      process_id: 'runtime-process',
      outcome: 'succeeded',
      exit_code: 0n,
      exit_signal: null
    }],
    Process: [{ id: 'runtime-process', status: 'exited' }],
    ProcessOriginLink: [{
      id: 'runtime-process-origin',
      process_id: 'runtime-process',
      tool_call_id: 'runtime-process-tool-call'
    }],
    ToolCall: [{
      id: 'runtime-process-tool-call',
      arguments_object_id: argumentsObjectId
    }]
  };
  const content = new Map([
    [envelopeObjectId, envelopeBytes],
    [argumentsObjectId, argumentsBytes]
  ]);
  const database = {
    async snapshot(reads) {
      return {
        snapshotCommitSeq: '1',
        snapshot: reads.map((read) => {
          const candidates = rows[read.domain] ?? [];
          if (read.kind === 'get') {
            return candidates.find((row) => row.id === read.id) ?? null;
          }
          if (read.kind !== 'list') throw new Error(`unexpected read ${read.kind}`);
          const where = read.where ?? {};
          return candidates.filter((row) => Object.entries(where).every(
            ([field, expected]) => row[field] === expected
          )).slice(0, read.limit);
        })
      };
    }
  };
  const contentStore = {
    async read(metadata) {
      const bytes = content.get(metadata.id);
      assert.ok(bytes, `missing content bytes for ${metadata.id}`);
      return bytes;
    }
  };
  const reader = new kernel.ClientDetailReader(database, contentStore);
  const detail = await reader.read({
    kind: 'turn-intent-preview',
    recordId: intentId,
    conversationId,
    offset: 0,
    maxBytes: 64 * 1024
  });
  const preview = JSON.parse(Buffer.from(detail.chunk, 'base64').toString('utf8'));
  assert.equal(preview.version, 3);
  assert.equal(preview.kind, 'runtime_continuation');
  assert.equal(preview.deliveryId, 'runtime-process-delivery');
  assert.deepEqual(preview.source, {
    kind: 'background_process',
    inboxItemId: 'runtime-process-inbox',
    sourceId: 'runtime-process-receipt',
    processId: 'runtime-process',
    processReceiptId: 'runtime-process-receipt',
    processStatus: 'exited',
    outcome: 'succeeded',
    commandPreview: 'npm run check -- --focused',
    toolCallId: 'runtime-process-tool-call',
    exitCode: '0'
  });
});

test('slow ACK compacts unsent visible commits without allocating wire sequence gaps or snapshot fallback', async () => {
  let onCommit;
  const projection = emptyClientProjection();
  const database = {
    hostBootId: 'backpressure-boot',
    async externalDataVersion() { return '1'; },
    async clientProjectionSnapshotAndSubscribe(_conversationId, listener) {
      onCommit = listener;
      return {
        barrier: { snapshotCommitSeq: '0', snapshot: projection },
        unsubscribe() {}
      };
    },
    async clientProjectionSnapshot() {
      return { snapshotCommitSeq: '0', snapshot: projection };
    }
  };
  const sent = [];
  const feed = new kernel.BoundedClientFeed(database);
  const connection = await feed.connect({ send(message) { sent.push(message); } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].messageSeq, '1');

  for (let index = 1; index <= 50; index += 1) {
    onCommit({
      commitSeq: String(index),
      changes: [{
        domain: 'Conversation',
        kind: 'upsert',
        id: 'conversation-backpressure',
        record: {
          id: 'conversation-backpressure',
          title: `latest-${index}`,
          status: 'active',
          created_at: '2026-08-20T00:00:00.000Z',
          updated_at: `2026-08-20T00:00:${String(index % 60).padStart(2, '0')}.000Z`
        }
      }]
    });
  }

  const queued = feed.inspectSession(connection.sessionId);
  assert.equal(queued.snapshotRequired, false);
  assert.equal(queued.queuedBatches, 1);
  assert.equal(queued.nextMessageSeq, '2', 'unsent compacted batches do not consume transport sequence ids');

  feed.acknowledge({
    sessionId: connection.sessionId,
    hostBootId: connection.hostBootId,
    messageSeq: '1'
  });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].type, 'reliable-kernel.changes');
  assert.equal(sent[1].messageSeq, '2');
  assert.equal(sent[1].commitSeq, '50');
  assert.equal(sent[1].changes.length, 1);
  assert.equal(sent[1].changes[0].record.title, 'latest-50');

  let state = clientFeedShared.createEmptyReliableKernelClientState();
  let applied = clientFeedShared.applyReliableKernelDataMessage(state, sent[0]);
  assert.equal(applied.snapshotRequired, false);
  state = applied.state;
  applied = clientFeedShared.applyReliableKernelDataMessage(state, sent[1]);
  assert.equal(applied.snapshotRequired, false, applied.reason);
  assert.equal(applied.state.records.Conversation['conversation-backpressure'].title, 'latest-50');
  feed.disconnect(connection.sessionId);
});

test('client summary keeps a long provider_call_id byte-for-byte', async () => {
  const providerCallId = `provider-${'identity'.repeat(600)}`;
  const projection = {
    navigationSummary: { conversations: [] },
    activeConversationWindow: {
      conversationId: 'conversation-provider-id', messages: [], visibleMessageCount: '0',
      lastMessageSeq: '0', projectContexts: [], conversationProjectLinks: [],
      conversationReuseLinks: [], conversationBranchLinks: [], conversationOriginLinks: [],
      agentConversationLinks: [], queuedTurnIntents: [], compressionBlocks: [], conversationContextStatuses: [], taskList: []
    },
    activeTurnSummary: {
      turns: [], executionLeases: [], turnTerminations: [], turnExecutorLinks: [],
      modelRequests: [], modelRequestMessageLinks: []
    },
    activeToolAndInteractionSummary: {
      messageTurnLinks: [], toolCalls: [],
      toolCallSourceLinks: [{
        id: 'source-link', tool_call_id: 'tool-call', model_request_id: 'model-request',
        provider_call_id: providerCallId, provider_ordinal: '0',
        display_text: 'x'.repeat(8_000)
      }],
      toolCallPolicySnapshots: [], toolCallEvents: [], toolExecutions: [], toolOutcomes: [],
      toolModelResults: [], toolResultArtifacts: [], interactionRequests: [], interactionOwnerLinks: [],
      interactionToolCallLinks: [], interactionResponses: [], fileChangeSets: [], fileChangeSetMembers: [],
      fileChangeDecisions: [], fileMutationReceipts: [], fileMutationReceiptMembers: [], processes: [],
      processOriginLinks: [], processOutputChunks: [], processReceipts: []
    },
    subagentDeliverySummary: {
      childExecutions: [], childExecutionParentLinks: [], childExecutionTurnLinks: [],
      childExecutionActiveTurnLinks: [], childTurns: [], childExecutionLeases: [],
      childTurnTerminations: [], childTurnExecutorLinks: [], answerBridges: [], answerSubmissions: [],
      runtimeInboxItems: [], runtimeDeliveries: [], runtimeDeliveryIntentLinks: []
    }
  };
  const sent = [];
  const database = {
    hostBootId: 'provider-id-boot',
    async externalDataVersion() { return '1'; },
    async clientProjectionSnapshotAndSubscribe() {
      return {
        barrier: { snapshotCommitSeq: '1', snapshot: projection },
        unsubscribe() {}
      };
    }
  };
  const feed = new kernel.BoundedClientFeed(database);
  const connection = await feed.connect({
    activeConversationId: 'conversation-provider-id',
    send(message) { sent.push(message); }
  });
  const link = sent[0].projections.activeToolAndInteractionSummary.toolCallSourceLinks[0];
  assert.equal(link.provider_call_id, providerCallId);
  assert.equal(link.summary_truncated, true);
  feed.disconnect(connection.sessionId);
});

test('retry activity disappears as soon as the current attempt renders model output', async (context) => {
  const server = await createWebviewTestServer();
  context.after(async () => server.close());
  const { reliableRetryStreamingActivityLabel } = await server.ssrLoadModule(
    '/src/domain/reliableTransientActivity.ts'
  );

  assert.equal(reliableRetryStreamingActivityLabel({
    retryAttempt: 1,
    retryMaxAttempts: 3,
    hasVisibleOutput: false
  }), '第 1/3 次自动恢复已启动，正在连接并等待 LLM 输出');
  assert.equal(reliableRetryStreamingActivityLabel({
    retryAttempt: 1,
    retryMaxAttempts: 3,
    hasVisibleOutput: true
  }), undefined);
});

test('user upward scroll detaches the reactive sticky signal across later content growth', async (context) => {
  const server = await createWebviewTestServer();
  const previousWindow = globalThis.window;
  const previousElement = globalThis.Element;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousResizeObserver = globalThis.ResizeObserver;
  const previousMutationObserver = globalThis.MutationObserver;
  const frames = new Map();
  const resizeObservers = [];
  let nextFrameId = 1;
  let app;

  class FakeElement extends EventTarget {
    scrollTop = 800;
    scrollHeight = 1_000;
    clientHeight = 200;
    firstElementChild = null;
    scrollTo(input) {
      this.scrollTop = typeof input === 'number' ? input : input.top ?? this.scrollTop;
    }
    closest() { return null; }
  }
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      resizeObservers.push(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  }
  globalThis.Element = FakeElement;
  globalThis.HTMLElement = FakeElement;
  globalThis.ResizeObserver = FakeResizeObserver;
  globalThis.MutationObserver = FakeMutationObserver;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); }
  };
  context.after(async () => {
    app?.unmount();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousElement === undefined) delete globalThis.Element;
    else globalThis.Element = previousElement;
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousHTMLElement;
    if (previousResizeObserver === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = previousResizeObserver;
    if (previousMutationObserver === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = previousMutationObserver;
    await server.close();
  });

  const vue = await import('vue');
  const { useBottomStickyScroller } = await server.ssrLoadModule(
    '/src/composables/useBottomStickyScroller.ts'
  );
  const element = new FakeElement();
  let sticky;
  const renderer = vue.createRenderer({
    patchProp() {}, insert() {}, remove() {}, createElement() { return {}; },
    createText() { return {}; }, createComment() { return {}; }, setText() {},
    setElementText() {}, parentNode() { return null; }, nextSibling() { return null; },
    querySelector() { return null; }, setScopeId() {}, cloneNode(node) { return node; },
    insertStaticContent() { return [{}, {}]; }
  });
  app = renderer.createApp(vue.defineComponent({
    setup() {
      const scroller = vue.ref(element);
      sticky = useBottomStickyScroller(scroller, { reattachDelayMs: 0 });
      return () => null;
    }
  }));
  app.mount({});
  await vue.nextTick();
  assert.equal(sticky.stickyToBottom.value, true);

  const wheel = new Event('wheel');
  Object.defineProperty(wheel, 'deltaY', { value: -120 });
  element.dispatchEvent(wheel);
  element.scrollTop = 600;
  element.dispatchEvent(new Event('scroll'));
  assert.equal(sticky.stickyToBottom.value, false, 'upward user intent detaches follow-latest immediately');

  element.scrollHeight = 1_200;
  resizeObservers.forEach((observer) => observer.callback([]));
  for (const [id, callback] of [...frames]) {
    frames.delete(id);
    callback(performance.now());
  }
  assert.equal(element.scrollTop, 600, 'later content growth must preserve the detached reading position');
  assert.equal(sticky.stickyToBottom.value, false);

  element.scrollTop = 1_000;
  element.dispatchEvent(new Event('scroll'));
  assert.equal(sticky.stickyToBottom.value, true, 'returning to the exact bottom reattaches follow-latest');

  const conversationView = fs.readFileSync(path.join(
    root,
    'webview/src/components/conversation/ConversationView.vue'
  ), 'utf8');
  const messageList = fs.readFileSync(path.join(
    root,
    'webview/src/components/conversation/ReliableMessageList.vue'
  ), 'utf8');
  assert.match(conversationView, /:follow-latest="followLatestTimeline"/);
  assert.match(messageList, /\(\) => props\.followLatest/);
});

test('streaming tool preview coalesces updates by frame and preserves pending partial before final', async (context) => {
  const server = await createWebviewTestServer();
  const previousWindow = globalThis.window;
  const frames = new Map();
  const cancelledFrames = [];
  let nextFrameId = 1;
  let app;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame(callback) {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      cancelledFrames.push(id);
      frames.delete(id);
    }
  };
  context.after(async () => {
    app?.unmount();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server.close();
  });

  const vue = await import('vue');
  const { default: StreamingToolCallPreview } = await server.ssrLoadModule(
    '/src/components/content/parts/StreamingToolCallPreview.vue'
  );
  // ssrLoadModule only emits ssrRender; this test exercises setup/watch scheduling, not the template.
  StreamingToolCallPreview.render = () => null;
  const previewState = (updatedAt, final = false) => ({
    id: 'preview:call-frame',
    callId: 'call-frame',
    name: 'custom_tool',
    argumentsText: '',
    receivedChars: 0,
    final,
    createdAt: 1,
    updatedAt
  });
  const preview = vue.ref(previewState(1));
  const renderer = vue.createRenderer({
    patchProp() {},
    insert() {},
    remove() {},
    createElement() { return {}; },
    createText() { return {}; },
    createComment() { return {}; },
    setText() {},
    setElementText() {},
    parentNode() { return null; },
    nextSibling() { return null; },
    querySelector() { return null; },
    setScopeId() {},
    cloneNode(node) { return node; },
    insertStaticContent() { return [{}, {}]; }
  });
  app = renderer.createApp(vue.defineComponent({
    setup() {
      return () => vue.h(StreamingToolCallPreview, {
        preview: preview.value,
        active: true
      });
    }
  }));
  app.provide(vue.ssrContextKey, { modules: new Set() });
  app.mount({});
  await vue.nextTick();
  assert.equal(frames.size, 0, 'the initial preview is visible without waiting for a frame');

  preview.value = previewState(2);
  await vue.nextTick();
  assert.equal(frames.size, 1);
  const firstFrameId = [...frames.keys()][0];

  preview.value = previewState(3);
  await vue.nextTick();
  assert.deepEqual([...frames.keys()], [firstFrameId], 'fast updates share one pending frame');

  const firstFrame = frames.get(firstFrameId);
  frames.delete(firstFrameId);
  firstFrame(performance.now());
  await vue.nextTick();
  preview.value = previewState(4);
  await vue.nextTick();
  assert.equal(frames.size, 1, 'an update after the prior frame schedules the next natural frame');
  const partialFrameId = [...frames.keys()][0];

  preview.value = previewState(5, true);
  await vue.nextTick();
  assert.deepEqual([...frames.keys()], [partialFrameId], 'final keeps the pending partial frame');
  assert.deepEqual(cancelledFrames, []);

  const partialFrame = frames.get(partialFrameId);
  frames.delete(partialFrameId);
  partialFrame(performance.now());
  await vue.nextTick();
  assert.equal(frames.size, 1, 'final is scheduled for the frame after the pending partial');
  const finalFrameId = [...frames.keys()][0];
  assert.notEqual(finalFrameId, partialFrameId);

  const finalFrame = frames.get(finalFrameId);
  frames.delete(finalFrameId);
  finalFrame(performance.now());
  await vue.nextTick();
  assert.equal(frames.size, 0);

  preview.value = previewState(6, true);
  await vue.nextTick();
  assert.equal(frames.size, 0, 'final without a pending partial is still committed immediately');
});
