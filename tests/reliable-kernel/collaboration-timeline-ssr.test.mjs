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
    assert.match(withoutMessage.html, /所属回合没有已加载的消息，位置待确认/);
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

// A conversation with 10 loaded messages and older collaboration cards whose Turns are outside
// loaded history, as a collaboration history page returns them.
function olderCardRecords(numbers) {
  const ids = numbers.map((number) => `older-${String(number).padStart(2, '0')}`);
  const byId = (rows) => Object.fromEntries(rows.map((row) => [row.id, row]));
  return {
    CollaborationMessage: byId(ids.map((id, index) => ({ id, message_seq: String(numbers[index]), mode: 'message', text_preview: `较早协作 ${id}` }))),
    CollaborationMessageSourceLink: byId(ids.map((id) => ({ id: `${id}-source`, message_id: id, conversation_id: 'peer', source_kind: 'tool', turn_id: null }))),
    CollaborationMessageTargetLink: byId(ids.map((id) => ({ id: `${id}-target`, message_id: id, conversation_id: 'self', inbox_item_id: `${id}-inbox` }))),
    RuntimeDelivery: byId(ids.map((id) => ({ id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: 'self',
      target_turn_id: `${id}-unloaded-turn`, attempt_seq: '1', state: 'consumed' })))
  };
}

test('40 older collaboration cards never push the 10 newest messages out, and an earlier page opens at the top', async () => {
  const pinia = await import('pinia');
  const vue = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const posted = [];
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, atob,
    requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    acquireVsCodeApi() { return { postMessage(message) { posted.push(structuredClone(message)); }, getState() { return {}; }, setState() {} }; }
  };
  let server;
  let app;
  try {
    server = await createWebviewSsrServer();
    const { default: MessageList } = await server.ssrLoadModule('/src/components/conversation/ReliableMessageList.vue');
    const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
    globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
    const isolated = pinia.createPinia();
    pinia.setActivePinia(isolated);
    const feed = useReliableKernelClientFeedStore();
    feed.sessionId = 'session';
    feed.projections.activeConversationWindow = { conversationId: 'self' };
    feed.records = {
      Conversation: { peer: { id: 'peer', title: '调研对话', status: 'active' } },
      Turn: { turn: { id: 'turn', conversation_id: 'self', status: 'terminated', created_at: '2026-01-02T00:00:00.000Z' } },
      Message: Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
        const id = `m${index + 1}`;
        return [id, { id, conversation_id: 'self', message_seq: String(index + 1), revision_id: `revision-${index + 1}`,
          role: index % 2 ? 'model' : 'user', created_at: '2026-01-02T00:00:00.000Z' }];
      })),
      MessageTurnLink: Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
        const id = `m${index + 1}`;
        return [`link-${id}`, { id: `link-${id}`, message_id: id, turn_id: 'turn', role: index % 2 ? 'model' : 'user' }];
      }))
    };
    feed.collaborationHistoryConversationId = 'self';
    feed.collaborationHistoryRecords = olderCardRecords(Array.from({ length: 40 }, (_, index) => index + 41));
    feed.collaborationHistoryNextBeforeMessageSeq = '41';
    feed.collaborationHistoryNextBeforeId = 'older-41';
    feed.collaborationHistoryHasMore = true;
    feed.collaborationHistoryLoadedPages = 1;

    let setup;
    const ssr = vue.createSSRApp(MessageList, {}).use(isolated);
    ssr.mixin({ created() { if (this.$.type.__name === MessageList.__name) setup = this.$.setupState; } });
    const html = await renderToString(ssr);
    assert.equal(setup.timelineRows.length, 50);
    for (let number = 1; number <= 10; number += 1) {
      assert.match(html, new RegExp(`data-timeline-row-key="m${number}"`), `message m${number} must stay mounted`);
    }
    assert.match(html, /所属回合在更早的历史中，位置待确认/);
    assert.doesNotMatch(html, /所属回合暂无消息/);
    assert.equal(setup.timelineRows[0].id, 'collaboration:older-41', 'older cards sit above the first message');

    // Mount the same component on a no-op renderer so its watchers run like in the browser; this
    // part is about which rows are mounted, not about markup.
    const clientList = { ...MessageList, render: () => null };
    const renderer = vue.createRenderer({
      patchProp() {}, insert() {}, remove() {}, createElement() { return {}; },
      createText() { return {}; }, createComment() { return {}; }, setText() {},
      setElementText() {}, parentNode() { return null; }, nextSibling() { return null; },
      querySelector() { return null; }, setScopeId() {}, cloneNode(node) { return node; },
      insertStaticContent() { return [{}, {}]; }
    });
    let live;
    app = renderer.createApp(clientList, {}).use(isolated);
    app.mixin({ created() { if (this.$.type.__name === MessageList.__name) live = this.$.setupState; } });
    app.provide(vue.ssrContextKey, { modules: new Set() });
    app.mount({});
    await vue.nextTick();
    assert.equal(live.segmentStart, 20, 'the latest segment follows the newest messages');
    assert.deepEqual(live.visibleMessageRows.map((message) => message.id), Array.from({ length: 10 }, (_, index) => `m${index + 1}`));

    live.showEarlierCollaboration();
    const request = posted.findLast((message) => message.type === 'reliable-kernel.collaboration-history-request');
    assert.equal(request?.beforeMessageSeq, '41');
    const page = olderCardRecords(Array.from({ length: 20 }, (_, index) => index + 21));
    feed.observe({
      type: 'reliable-kernel.collaboration-history-result', requestId: request.requestId, sessionId: 'session', conversationId: 'self',
      page: {
        records: Object.fromEntries(Object.entries(page).map(([type, rows]) => [type, Object.values(rows)])),
        nextBeforeMessageSeq: '21', nextBeforeId: 'older-21', hasMore: true, scanProgress: false, scannedRows: 20, responseBytes: 4096
      }
    });
    await vue.nextTick();
    assert.equal(feed.collaborationHistoryLoadedPages, 2);
    assert.equal(live.timelineRows.length, 70);
    assert.equal(live.segmentStart, 0, 'the earlier page opens where it was requested: at the top');
    assert.equal(live.visibleTimelineRows[0].id, 'collaboration:older-21');
    assert.ok(live.visibleTimelineRows.slice(0, 20).every((row) => row.kind === 'collaboration'
      && Number(row.card.messageId.slice('older-'.length)) <= 40), 'the new cards are the first mounted rows, below the button');

    // Another card of an older Turn inserted above the mounted rows keeps what the user is reading.
    live.showLaterSegment();
    await vue.nextTick();
    const reading = live.visibleTimelineRows[0].id;
    const inserted = olderCardRecords([5]);
    feed.collaborationHistoryRecords = Object.fromEntries(Object.entries(feed.collaborationHistoryRecords)
      .map(([type, rows]) => [type, { ...rows, ...(inserted[type] ?? {}) }]));
    await vue.nextTick();
    assert.equal(live.timelineRows.length, 71);
    assert.equal(live.visibleTimelineRows[0].id, reading, 'an inserted older row keeps the reading position');
  } finally {
    app?.unmount();
    if (server) await server.close();
    pinia.setActivePinia(previousPinia);
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  }
});
