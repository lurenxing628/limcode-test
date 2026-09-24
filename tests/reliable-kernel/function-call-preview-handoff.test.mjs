import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

test('a function-call preview yields to the matching durable execution and result', async () => {
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
    globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
    const { default: FunctionCallPartView } = await server.ssrLoadModule(
      '/src/components/content/parts/FunctionCallPartView.vue'
    );
    const { useReliableKernelClientFeedStore } = await server.ssrLoadModule(
      '/src/stores/useReliableKernelClientFeedStore.ts'
    );
    const activePinia = pinia.createPinia();
    pinia.setActivePinia(activePinia);
    const feed = useReliableKernelClientFeedStore();
    const conversationId = 'conversation-preview-handoff';
    const turnId = 'turn-preview-handoff';
    const requestId = 'request-preview-handoff';
    const messageId = 'message-preview-handoff';
    const revisionId = 'revision-preview-handoff';
    const callId = 'tool-preview-handoff';
    const providerCallId = 'provider-preview-handoff';
    const part = { id: providerCallId, functionCall: { name: 'custom_tool', args: { action: 'check' } } };
    feed.projections.activeConversationWindow = { conversationId };
    feed.records = {
      Turn: { [turnId]: { id: turnId, conversation_id: conversationId, status: 'active' } },
      ModelRequest: { [requestId]: { id: requestId, turn_id: turnId, request_seq: '1', status: 'streaming' } },
      Message: { [messageId]: {
        id: messageId, conversation_id: conversationId, message_seq: '1', role: 'model',
        revision_id: revisionId, created_at: '2026-09-24T16:00:00.000Z'
      } },
      MessageTurnLink: { model: { id: 'model', message_id: messageId, turn_id: turnId, role: 'model' } },
      ModelRequestMessageLink: { request: { id: 'request', model_request_id: requestId, message_id: messageId } },
      ToolCall: { [callId]: {
        id: callId, turn_id: turnId, call_seq: '1', tool_name: 'custom_tool', status: 'queued'
      } },
      ToolCallSourceLink: { source: {
        id: 'source', tool_call_id: callId, model_request_id: requestId, message_id: messageId,
        provider_call_id: providerCallId, provider_ordinal: 0
      } }
    };
    feed.details[`message-content:${revisionId}`] = { status: 'ready', text: JSON.stringify({
      role: 'model', parts: [{ ...part, outputItem: { id: 'item-preview-handoff', ordinal: 0 } }]
    }) };
    feed.transientModelRequests[requestId] = {
      conversationId, turnId, modelRequestId: requestId, requestSeq: '1',
      providerId: 'provider', modelId: 'model', streamSeq: '3',
      text: '', thought: '', outputParts: [part],
      toolCalls: [{
        id: `transient-tool-preview:${requestId}:${providerCallId}`,
        callId: providerCallId, name: 'custom_tool', argumentsText: '{"action":"check"}',
        receivedChars: 18, final: true, createdAt: 1, updatedAt: 2
      }], status: 'streaming', startedAt: 1, updatedAt: 2
    };
    const render = () => {
      const app = createSSRApp(FunctionCallPartView, {
        part, messageId, toolOrdinal: 0, streaming: true
      }).use(activePinia);
      app.mixin({ created() {
        if (this.$.type.__name === FunctionCallPartView.__name) this.$.setupState.expanded = true;
      } });
      return renderToString(app);
    };

    const queued = await render();
    assert.match(queued, /class="tool-preview-card/);
    assert.doesNotMatch(queued, /\btool-call-card\b/);

    feed.records.ToolCall[callId] = { ...feed.records.ToolCall[callId], status: 'executing' };
    const executing = await render();
    assert.doesNotMatch(executing, /class="tool-preview-card/);
    assert.match(executing, /\btool-call-card\b/);
    assert.match(executing, /工具执行中/);

    for (const [outcome, expected] of [['succeeded', '工具执行成功'], ['failed', '工具执行失败']]) {
      feed.records.ToolCall[callId] = { ...feed.records.ToolCall[callId], status: 'terminal' };
      feed.records.ToolOutcome = { [callId]: { id: `outcome-${outcome}`, tool_call_id: callId, status: outcome } };
      feed.details[`tool-result-content:${callId}`] = {
        status: 'ready', text: JSON.stringify({ detail: { outcome, proof: 'visible durable result' } })
      };
      const settled = await render();
      assert.doesNotMatch(settled, /class="tool-preview-card/);
      assert.match(settled, /\btool-call-card\b/);
      assert.match(settled, new RegExp(expected));
      assert.match(settled, /visible durable result/);
    }
  } finally {
    pinia.setActivePinia(previousPinia);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    await server?.close();
  }
});
