import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

// Synthetic feed only: no persisted runtime, user data or full extension build.
test('SSR keeps collaboration visible in a 35-message Turn and pages it with the same 30-row window', async () => {
  const pinia = await import('pinia');
  const { createSSRApp, nextTick } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, atob,
    requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    acquireVsCodeApi() { return { postMessage() {}, getState() { return {}; }, setState() {} }; }
  };
  let server;
  try {
    server = await createWebviewSsrServer();
    const { default: MessageList } = await server.ssrLoadModule('/src/components/conversation/ReliableMessageList.vue');
    const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
    globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
    const isolated = pinia.createPinia();
    pinia.setActivePinia(isolated);
    const feed = useReliableKernelClientFeedStore();
    feed.projections.activeConversationWindow = { conversationId: 'self' };
    feed.records = {
      Conversation: { peer: { id: 'peer', title: '调研对话', status: 'active' } },
      Turn: { turn: { id: 'turn', conversation_id: 'self', status: 'terminated' } },
      Message: Object.fromEntries(Array.from({ length: 35 }, (_, index) => {
        const number = index + 1;
        const id = `m${number}`;
        return [id, { id, conversation_id: 'self', message_seq: String(number), revision_id: `revision-${number}`,
          role: 'user', created_at: '2026-01-01T00:00:00.000Z' }];
      })),
      MessageTurnLink: Object.fromEntries(Array.from({ length: 35 }, (_, index) => {
        const id = `m${index + 1}`;
        return [`link-${id}`, { id: `link-${id}`, message_id: id, turn_id: 'turn', role: 'user' }];
      })),
      CollaborationMessage: { card: { id: 'card', message_seq: '1', mode: 'followup', text_preview: '继续处理' } },
      CollaborationMessageSourceLink: { source: { id: 'source', message_id: 'card', conversation_id: 'peer', source_kind: 'tool' } },
      CollaborationMessageTargetLink: { target: { id: 'target', message_id: 'card', conversation_id: 'self', inbox_item_id: 'inbox' } },
      RuntimeDelivery: { delivery: { id: 'delivery', inbox_item_id: 'inbox', target_conversation_id: 'self',
        target_turn_id: 'turn', attempt_seq: '1', state: 'consumed' } }
    };
    const render = async () => {
      let setup;
      const app = createSSRApp(MessageList, {}).use(isolated);
      app.mixin({ created() { if (this.$.type.__name === MessageList.__name) setup = this.$.setupState; } });
      return { html: await renderToString(app), setup };
    };
    const recent = await render();
    assert.equal(recent.setup.timelineRows.length, 36);
    assert.equal(recent.setup.visibleTimelineRows.length, 30);
    assert.match(recent.html, /data-timeline-row-key="collaboration:card"/);
    assert.match(recent.html, /来自对话 调研对话/);
    assert.match(recent.html, /按回合归组，具体顺序待确认/);
    assert.match(recent.html, /data-timeline-row-key="m35"/);
    assert.doesNotMatch(recent.html, /data-timeline-row-key="m1"/);
    const { captureScrollAnchor, restoreScrollAfterHistoryLoad } =
      await server.ssrLoadModule('/src/components/conversation/scrollAnchor.ts');
    let cardTop = 80;
    const cardRow = {
      dataset: { timelineRowKey: 'collaboration:card' },
      getBoundingClientRect: () => ({ top: cardTop, bottom: cardTop + 40 })
    };
    const scroller = {
      scrollTop: 100, scrollHeight: 800, clientHeight: 200,
      getBoundingClientRect: () => ({ top: 0, bottom: 200 }),
      querySelectorAll: () => [cardRow]
    };
    const anchor = captureScrollAnchor({ scroller, visibleRows: recent.setup.visibleTimelineRows });
    assert.equal(anchor.anchorId, 'collaboration:card');
    cardTop = 170; // an earlier page prepends 90px above this independently keyed card
    assert.equal(restoreScrollAfterHistoryLoad({ scroller, anchor }), true);
    assert.equal(scroller.scrollTop, 190);
    assert.equal(recent.setup.segmentStart, 6);
    recent.setup.showEarlierSegment();
    await nextTick();
    assert.equal(recent.setup.segmentStart, 0);
    assert.equal(recent.setup.visibleTimelineRows.some((row) => row.id === 'm1'), true);
    assert.equal(recent.setup.visibleTimelineRows.some((row) => row.id === 'collaboration:card'), false);
    recent.setup.showLaterSegment();
    await nextTick();
    assert.equal(recent.setup.visibleTimelineRows.some((row) => row.id === 'collaboration:card'), true);

    feed.records.Message = {};
    feed.records.MessageTurnLink = {};
    feed.removedConversationIds = ['peer'];
    await nextTick();
    const withoutMessage = await render();
    assert.match(withoutMessage.html, /来自已删除的对话/);
    assert.match(withoutMessage.html, /所属回合暂无消息，位置待确认/);
    assert.doesNotMatch(withoutMessage.html, /还没有消息，发一条试试/);
    feed.records.CollaborationMessage['failed'] = { id: 'failed', message_seq: '2', mode: 'message', text_preview: '失败通知' };
    feed.records.CollaborationMessageSourceLink['failed-source'] = {
      id: 'failed-source', message_id: 'failed', conversation_id: 'peer', source_kind: 'tool'
    };
    feed.records.CollaborationMessageTargetLink['failed-target'] = {
      id: 'failed-target', message_id: 'failed', conversation_id: 'self', inbox_item_id: 'failed-inbox'
    };
    feed.records.RuntimeDelivery['failed-delivery'] = {
      id: 'failed-delivery', inbox_item_id: 'failed-inbox', target_conversation_id: 'self',
      target_turn_id: null, attempt_seq: '1', state: 'failed'
    };
    await nextTick();
    const failed = await render();
    assert.match(failed.html, /data-timeline-row-key="collaboration:failed"/);
    assert.match(failed.html, /投递失败/);
    assert.match(failed.html, /投递未进入回合，位置待确认/);
    assert.equal(failed.setup.visibleTimelineRows.length, 2);
  } finally {
    if (server) await server.close();
    pinia.setActivePinia(previousPinia);
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
