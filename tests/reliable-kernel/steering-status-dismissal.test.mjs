import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

// Synthetic receipts only: the panel reads this view's persisted VS Code webview state, which a
// reload keeps while every in-memory store starts empty.
test('a closed failed steering receipt stays closed when the view reloads', async () => {
  const pinia = await import('pinia');
  const { createSSRApp } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  let viewState = {};
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, atob,
    requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    acquireVsCodeApi() {
      return { postMessage() {}, getState() { return viewState; }, setState(value) { viewState = structuredClone(value); } };
    }
  };
  let server;
  try {
    server = await createWebviewSsrServer();
    const { default: Panel } = await server.ssrLoadModule('/src/components/input/SteeringStatusPanel.vue');
    const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
    const steering = await server.ssrLoadModule('/src/composables/steeringReceipts.ts');
    globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
    const failed = { submissionId: 'failed-steer', conversationId: 'conversation-a', turnId: 'turn-a', modelRequestId: 'request-a',
      state: 'failed', messageId: 'steer-message', message: '提供方拒绝了转向', updatedAt: 1_000 };
    const render = async (receipts = [failed]) => {
      // Each render is a fresh view: a new Pinia and receipts re-read from the durable status.
      const isolated = pinia.createPinia();
      pinia.setActivePinia(isolated);
      const feed = useReliableKernelClientFeedStore();
      feed.projections.activeConversationWindow = { conversationId: 'conversation-a' };
      steering.steeringReceiptsByConversationState().value = {};
      steering.mergeSteeringReceipts('conversation-a', receipts);
      let setup;
      const app = createSSRApp(Panel, {}).use(isolated);
      app.mixin({ created() { if (this.$.type.__name === Panel.__name) setup = this.$.setupState; } });
      return { html: await renderToString(app), setup };
    };

    const first = await render();
    assert.match(first.html, /转向失败/);
    assert.match(first.html, /提供方拒绝了转向/);
    assert.doesNotMatch(first.html, /不会自动重发|请核对后重新提交/);
    const accepted = { ...failed, submissionId: 'accepted-steer', state: 'accepted' };
    const unknown = { ...failed, submissionId: 'unknown-steer', state: 'delivery_unknown' };
    assert.doesNotMatch((await render([accepted, unknown])).html, /转向回执状态/,
      '无操作价值的中间态和投递未知不占输入区');
    const applied = { ...failed, submissionId: 'success-steer', state: 'continuing',
      targetResponseId: 'before', successorResponseId: 'after', responseId: 'after', updatedAt: Date.now() };
    const success = await render([applied]);
    assert.match(success.html, /已生效/);
    assert.doesNotMatch(success.html, /提供方拒绝了转向/,
      '成功回执不应携带前一状态的错误消息');
    first.setup.dismissReceipt(failed);
    assert.ok(viewState.steeringReceiptDismissals?.['conversation-a']?.['failed-steer'], 'the dismissal is written to this view state');

    const reloaded = await render();
    assert.doesNotMatch(reloaded.html, /转向失败/, 'the durable failed receipt does not reappear after the user closed it');
    assert.doesNotMatch(reloaded.html, /转向回执状态/);

    viewState = {};
    const otherView = await render();
    assert.match(otherView.html, /转向失败/, 'without that view state the receipt is still shown');
  } finally {
    if (server) await server.close();
    pinia.setActivePinia(previousPinia);
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
