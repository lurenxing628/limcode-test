import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const observedAt = Date.parse('2026-09-24T16:23:44.000Z');
const conversationId = 'conversation-activity';
const turnId = 'turn-activity';
const requestId = 'model-request-activity';
const messageId = 'message-activity';
const revisionId = 'revision-activity';

test('native early Revision reuses the visible model row while an empty request keeps its activity row', async () => {
  const pinia = await import('pinia');
  const { createSSRApp } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, atob,
    requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    acquireVsCodeApi() { return { postMessage() {}, getState() {}, setState() {} }; }
  };
  let server;
  try {
    server = await createWebviewSsrServer();
    const { default: MessageList } = await server.ssrLoadModule('/src/components/conversation/ReliableMessageList.vue');
    const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
    globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
    const activePinia = pinia.createPinia();
    pinia.setActivePinia(activePinia);
    const feed = useReliableKernelClientFeedStore();
    feed.projections.activeConversationWindow = { conversationId };
    feed.records = {
      Turn: { [turnId]: {
        id: turnId, conversation_id: conversationId, status: 'active',
        created_at: '2026-09-24T16:23:20.000Z'
      } },
      ModelRequest: { [requestId]: {
        id: requestId, turn_id: turnId, request_seq: '1', status: 'streaming',
        model_id: 'gpt-6-sol', created_at: '2026-09-24T16:23:20.000Z',
        stream_stats_json: { lastStreamSeq: '300', lastStreamEventAt: observedAt }
      } },
      Message: { [messageId]: {
        id: messageId, conversation_id: conversationId, message_seq: '1', role: 'model',
        revision_id: revisionId, created_at: '2026-09-24T16:23:21.000Z'
      } },
      ModelRequestMessageLink: { linked: {
        id: 'linked', model_request_id: requestId, message_id: messageId
      } }
    };
    feed.details[`message-content:${revisionId}`] = { status: 'ready', text: JSON.stringify({
      role: 'model', parts: [{ text: '正在分析', outputItem: { id: 'item-1', ordinal: 0 } }]
    }) };
    feed.transientModelRequests[requestId] = {
      conversationId, turnId, modelRequestId: requestId, requestSeq: '1',
      providerId: 'provider', modelId: 'gpt-6-sol', streamSeq: '300',
      text: '正在分析', thought: '', toolCalls: [],
      outputParts: [{ text: '正在分析', outputItem: { id: 'item-1', ordinal: 0 } }],
      status: 'streaming', startedAt: observedAt, updatedAt: observedAt
    };
    const render = async () => {
      let setup;
      const app = createSSRApp(MessageList, {}).use(activePinia);
      app.mixin({ created() { if (this.$.type.__name === MessageList.__name) setup = this.$.setupState; } });
      return { html: await renderToString(app), setup };
    };

    const visible = await render();
    assert.deepEqual(visible.setup.messages.map((message) => message.id), [messageId],
      'the native transient is merged into the already durable Message');
    assert.equal(visible.setup.latestRequestHasVisibleModelRow, true);
    assert.equal(visible.setup.activityLabel, undefined);
    assert.equal((visible.html.match(/class="floor-role-name"[^>]*>gpt-6-sol/g) ?? []).length, 1);
    assert.doesNotMatch(visible.html, /data-activity-kind="preparing"/,
      'no second model name or waiting row is rendered under visible output');

    delete feed.records.Message[messageId];
    delete feed.records.ModelRequestMessageLink.linked;
    delete feed.transientModelRequests[requestId];
    const empty = await render();
    assert.deepEqual(empty.setup.messages, []);
    assert.equal(empty.setup.latestRequestHasVisibleModelRow, false);
    assert.equal(empty.setup.activityLabel, '正在等待模型回复');
    assert.doesNotMatch(empty.html, /最近流活动|#300|LLM 终态/);
    assert.match(empty.html, /data-activity-kind="preparing"/,
      'the activity row remains when no model output is visible');
  } finally {
    pinia.setActivePinia(previousPinia);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    await server?.close();
  }
});
