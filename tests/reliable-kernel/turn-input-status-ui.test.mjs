import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

let server, vue, pinia, renderToString, Panel, MessageList, useChat, useFeed, T, trace;
const posted = [], listeners = new Set(), timers = new Map();
let timerId = 0, persisted = {};
const oldWindow = globalThis.window;
const oldDocument = globalThis.document;
before(async () => {
  globalThis.window = {
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(_type, fn) { listeners.delete(fn); },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, requestAnimationFrame() {}, cancelAnimationFrame() {},
    acquireVsCodeApi: () => ({ postMessage: (message) => posted.push(structuredClone(message)),
      getState: () => persisted, setState: (value) => { persisted = structuredClone(value); } })
  };
  server = await createWebviewSsrServer();
  vue = await import('vue'); pinia = await import('pinia');
  ({ renderToString } = await import('@vue/server-renderer'));
  ({ default: Panel } = await server.ssrLoadModule('/src/components/input/ReliableQueuePanel.vue'));
  ({ default: MessageList } = await server.ssrLoadModule('/src/components/conversation/ReliableMessageList.vue'));
  ({ useChat } = await server.ssrLoadModule('/src/composables/useChat.ts'));
  ({ useReliableKernelClientFeedStore: useFeed } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts'));
  ({ BridgeMessageType: T } = await server.ssrLoadModule(`${process.cwd()}/shared/protocol.ts`));
  ({ debugCaptureTrace: trace } = await server.ssrLoadModule('/src/transport/debugCapture.ts'));
  globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
});
after(async () => { trace?.update(); await server?.close(); globalThis.window = oldWindow; globalThis.document = oldDocument; });
let nextConversation = 0;
function fixture(t) {
  const store = pinia.createPinia(); pinia.setActivePinia(store);
  const feed = useFeed();
  const conversationId = `send-status-${++nextConversation}`;
  feed.projections = { activeConversationWindow: { conversationId } }; feed.sessionId = 'session'; feed.snapshotRequired = false;
  // Supply the backend detail response so queue rendering starts no real timeout/retry timers.
  const preview = JSON.stringify({ version: 3, kind: 'guidance', text: 'queued input', editorText: 'queued input',
    revisionSeq: '1', position: '1', hold: 'none' });
  for (const id of ['intent', 'queued']) feed.details[`turn-intent-preview:${id}`] = {
    status: 'ready', text: preview, totalBytes: preview.length
  };
  const scope = vue.effectScope(); const chat = scope.run(() => useChat());
  t.after(() => {
    scope.stop();
    for (const requestId of Object.keys(feed.pendingDetails)) feed.finishDetailRequest(requestId);
    feed.$dispose(); timers.clear(); trace.update();
  });
  const ack = (submission, payload = {}) => {
    for (const listener of listeners) listener({ data: { type: T.TurnInputResult, correlationId: submission.requestId,
      payload: { commandId: submission.commandId, conversationId, requestType: submission.requestType,
        status: 'accepted', admitted: true, turnId: 'turn', ...payload } } });
  };
  return { feed, chat, conversationId, ack,
    receipt(submission) { feed.records = { ...feed.records, ConversationCommandReceipt: {
      receipt: { id: 'receipt', command_id: submission.commandId, conversation_id: conversationId }
    } }; },
    message(turnId = 'turn', messageId = 'input', revisionId = 'revision') {
      feed.records = { ...feed.records,
        Turn: { ...feed.records.Turn, [turnId]: { id: turnId, conversation_id: conversationId, status: 'active' } },
        Message: { ...feed.records.Message, [messageId]: { id: messageId, conversation_id: conversationId,
          revision_id: revisionId, revision_seq: '1', role: 'user', message_seq: '1', created_at: '2026-10-08T00:00:00Z' } },
        MessageTurnLink: { ...feed.records.MessageTurnLink, [`link-${messageId}`]: {
          id: `link-${messageId}`, turn_id: turnId, message_id: messageId, role: 'input' } }
      };
    },
    body(revisionId = 'revision', text = 'durable body') {
      const value = JSON.stringify({ role: 'user', parts: [{ text }] });
      feed.details[`message-content:${revisionId}`] = { status: 'ready', text: value, totalBytes: value.length };
    },
    async renderTimeline() {
      await vue.nextTick();
      return renderToString(vue.createSSRApp(MessageList).use(store));
    },
    async render() {
      await vue.nextTick();
      let setup;
      const app = vue.createSSRApp(Panel).use(store);
      app.mixin({ created() { if (this.$.type.__name === Panel.__name) setup = this.$.setupState; } });
      const html = await renderToString(app);
      return { html, setup, groups: setup.queueGroups.map((group) => ({ id: group.id, title: group.title,
        reason: group.reason, states: group.items.map((item) => item.state), count: group.items.length })) };
    }
  };
}
test('idle input is visible immediately and hands off only when its exact durable body is ready', async (t) => {
  const h = fixture(t), submission = h.chat.sendMessage('ordinary input');
  assert.equal(posted.at(-1).id, submission.requestId, 'bridge posts synchronously');
  assert.equal(posted.at(-1).type, T.TurnStart);
  let view = await h.render();
  assert.deepEqual(view.groups, []);
  assert.equal(h.chat.currentTurnInputEchoes.value[0].label, '提交中');
  let html = await h.renderTimeline();
  assert.ok(html.includes('ordinary input'));
  assert.ok(html.includes('提交中'));
  assert.equal(h.feed.records.Message, undefined, 'local echo never creates a durable Message fact');
  assert.ok(!view.html.includes('等待队列 ·'));
  assert.equal(h.chat.currentTurnInputAcknowledgements.value[submission.commandId], undefined);
  h.ack(submission); view = await h.render();
  assert.deepEqual(view.groups, []);
  assert.equal(h.chat.currentTurnInputEchoes.value[0].label, '已保存，正在显示');
  assert.ok(h.chat.currentTurnInputAcknowledgements.value[submission.commandId]);
  h.feed.records = { Turn: { turn: { id: 'turn', conversation_id: h.conversationId, status: 'active' } } };
  assert.deepEqual((await h.render()).groups, []);
  assert.equal(h.chat.currentTurnInputEchoes.value.length, 1, 'a Turn shell is not a ready Message body');
  h.message();
  html = await h.renderTimeline();
  assert.ok(html.includes('ordinary input'));
  assert.equal((html.match(/class="message-floor user /g) ?? []).length, 1, 'pending and durable shells share one row');
  assert.ok(!html.includes('内容加载中'));
  h.body('other-revision', 'unrelated body');
  await vue.nextTick();
  assert.equal(h.chat.currentTurnInputEchoes.value.length, 1, 'another revision cannot retire this draft');
  h.body();
  html = await h.renderTimeline();
  assert.equal(h.chat.currentTurnInputEchoes.value.length, 0);
  assert.ok(html.includes('durable body'));
  assert.ok(!html.includes('ordinary input'));
  assert.ok(h.chat.currentTurnInputAcknowledgements.value[submission.commandId], 'Composer retains its one-shot handoff after Feed');
  h.chat.dismissTurnInputAcknowledgement(submission.commandId);
  assert.equal(h.chat.currentTurnInputAcknowledgements.value[submission.commandId], undefined);
});
test('receipt before ACK confirms the draft once while keeping its body for the exact handoff', async (t) => {
  const h = fixture(t), submission = h.chat.sendMessage('receipt first');
  h.receipt(submission); assert.deepEqual((await h.render()).groups, []);
  assert.ok(h.chat.currentTurnInputAcknowledgements.value[submission.commandId]);
  assert.equal(h.chat.currentTurnInputEchoes.value[0].label, '已保存，正在显示');
  h.chat.dismissTurnInputAcknowledgement(submission.commandId);
  h.ack(submission); assert.deepEqual((await h.render()).groups, []);
  assert.equal(h.chat.currentTurnInputAcknowledgements.value[submission.commandId], undefined, 'late ACK cannot repeat the consumed draft handoff');
  h.message(); h.body(); await vue.nextTick();
  assert.equal(h.chat.currentTurnInputEchoes.value.length, 0);
});
test('busy send is submitting before ACK and only admitted:false becomes a waiting item', async (t) => {
  const h = fixture(t);
  h.feed.records = { Turn: { busy: { id: 'busy', conversation_id: h.conversationId, status: 'active' } } };
  const submission = h.chat.sendMessage('next input');
  assert.equal(submission.requestType, T.TurnEnqueue);
  assert.equal(h.chat.currentTurnInputEchoes.value.length, 0, 'busy submission does not invent an active Message');
  assert.equal((await h.render()).groups[0].id, 'submissions');
  h.ack(submission, { admitted: false, turnId: undefined, intentId: 'intent' });
  assert.deepEqual((await h.render()).groups.map((group) => [group.id, group.states]), [['waiting', ['acknowledged']]]);
  h.feed.records = { ...h.feed.records, TurnIntent: { intent: { id: 'intent', conversation_id: h.conversationId,
    state: 'queued', turn_id: null, created_at: '2026-09-30T00:00:00Z' } } };
  assert.deepEqual((await h.render()).groups.map((group) => [group.id, group.states]), [['waiting', ['queued']]]);
  assert.equal(h.chat.currentTurnInputEchoes.value.length, 0);
});
test('identical input text never matches a different command or Turn', async (t) => {
  const h = fixture(t), first = h.chat.sendMessage('same input'), second = h.chat.sendMessage('same input');
  assert.notEqual(first.commandId, second.commandId);
  h.ack(first, { turnId: 'first-turn' }); h.ack(second, { turnId: 'second-turn' });
  h.message('first-turn', 'first-input', 'first-revision'); h.body('first-revision', 'same input');
  await vue.nextTick();
  assert.deepEqual(h.chat.currentTurnInputEchoes.value.map((echo) => echo.submission.commandId), [second.commandId]);
  assert.equal(h.chat.currentTurnInputEchoes.value[0].displayTarget, undefined);
});
test('a current input edit or deletion retires the submitted body instead of painting old content', async (t) => {
  const h = fixture(t), submission = h.chat.sendMessage('original input');
  h.ack(submission); h.message(); await vue.nextTick();
  assert.equal(h.chat.currentTurnInputEchoes.value[0].displayTarget.revisionId, 'revision');
  h.feed.details['message-content:revision'] = { status: 'error', error: 'temporary read error', text: '', totalBytes: 0 };
  await vue.nextTick();
  assert.equal(h.chat.currentTurnInputEchoes.value.length, 1, 'a body read failure does not erase the submitted text');
  h.feed.records.Message.input = { ...h.feed.records.Message.input, revision_id: 'edited-revision', revision_seq: '2' };
  await vue.nextTick();
  assert.equal(h.chat.currentTurnInputEchoes.value.length, 0);
  const next = h.chat.sendMessage('delete this input');
  h.ack(next, { turnId: 'next-turn' }); h.message('next-turn', 'next-input', 'next-revision'); await vue.nextTick();
  assert.equal(h.chat.currentTurnInputEchoes.value.length, 1);
  delete h.feed.records.Message['next-input'];
  await vue.nextTick();
  assert.equal(h.chat.currentTurnInputEchoes.value.length, 0, 'a removed target is not resurrected as a local draft row');
});
test('local input remains in the timeline while durable queued input keeps its own count', async (t) => {
  const h = fixture(t), submission = h.chat.sendMessage('new input');
  h.feed.records = { TurnIntent: { queued: { id: 'queued', conversation_id: h.conversationId,
    state: 'queued', turn_id: null, created_at: '2026-09-30T00:00:00Z' } } };
  let view = await h.render();
  assert.deepEqual(view.groups.map((group) => [group.id, group.count]), [['waiting', 1]]);
  assert.equal(h.chat.currentTurnInputEchoes.value[0].label, '提交中');
  assert.equal(view.groups[0].reason, '等待当前回复和工具完成');
  h.ack(submission); view = await h.render();
  assert.equal(h.chat.currentTurnInputEchoes.value[0].label, '已保存，正在显示');
  assert.equal(view.groups[0].reason, '等待当前回复和工具完成');
});
test('rejection preserves failure text without claiming queue admission; next send clears it', async (t) => {
  const h = fixture(t), submission = h.chat.sendMessage('preserve my draft');
  h.ack(submission, { status: 'rejected', admitted: undefined, message: 'could not submit' });
  let view = await h.render();
  assert.deepEqual(view.groups.map((group) => group.states), [['failed']]);
  assert.equal(view.groups[0].title, '发送状态');
  assert.equal(h.chat.currentTurnInputFailure.value.text, 'preserve my draft');
  assert.equal(h.chat.currentTurnInputAcknowledgements.value[submission.commandId], undefined);
  assert.ok(!view.html.includes('等待队列 ·'));
  assert.equal(h.chat.currentTurnInputEchoes.value.length, 0);
  h.chat.sendMessage('preserve my draft'); view = await h.render();
  assert.deepEqual(view.groups, []);
  assert.equal(h.chat.currentTurnInputEchoes.value[0].label, '提交中');
});
test('unconfirmed retry preserves command identity and remains separate from the waiting queue', async (t) => {
  const h = fixture(t), submission = h.chat.sendMessage('retry input');
  const timer = [...timers].at(-1); timers.delete(timer[0]); timer[1].fn();
  let view = await h.render();
  assert.deepEqual(view.groups, []);
  assert.equal(h.chat.currentTurnInputEchoes.value[0].label, '消息尚未确认，可重试');
  assert.ok((await h.renderTimeline()).includes('重试确认消息'));
  assert.ok(h.chat.retryTurnInputSubmission(submission.commandId));
  const retransmit = posted.filter((row) => row.id === submission.requestId);
  assert.equal(retransmit.length, 3);
  assert.ok(retransmit.every((row) => row.payload.command.commandId === submission.commandId));
  view = await h.render();
  assert.deepEqual(view.groups, []);
  assert.equal(h.chat.currentTurnInputEchoes.value[0].label, '提交中');
});
test('empty input and empty status do not render a failure or waiting group', async (t) => {
  const h = fixture(t);
  assert.equal(h.chat.sendMessage('  '), undefined);
  const view = await h.render();
  assert.deepEqual(view.groups, []); assert.equal(view.setup.waitReason, ''); assert.equal(view.setup.submissionReason, '');
  assert.ok(!view.html.includes('消息提交与等待状态'));
});
test('send timing is opt-in and never logs message text or attachment content', async (t) => {
  const h = fixture(t), logs = [];
  t.mock.method(console, 'debug', (...args) => logs.push(args));
  h.chat.sendMessage('secret before capture'); assert.equal(logs.length, 0);
  trace.update({ runId: 'timing', status: 'recording', target: { scope: 'conversation', conversationId: h.conversationId } });
  const submission = h.chat.sendMessage('secret content', { role: 'user', parts: [{ text: 'attachment secret' }] });
  h.ack(submission); h.receipt(submission); await h.render();
  assert.deepEqual(logs.map((entry) => entry[1].phase), ['posted', 'ack', 'durable-observed']);
  assert.ok(logs.every((entry) => Number.isFinite(entry[1].elapsedMs)));
  assert.ok(!JSON.stringify(logs).includes('secret'));
  assert.ok(!JSON.stringify(logs).includes('parts'));
});
test('group-local numbering never changes durable drag order or allows reordering pending input', async (t) => {
  const h = fixture(t), submission = h.chat.sendMessage('pending beside queue');
  const intent = (id) => ({ id, conversation_id: h.conversationId, state: 'queued', turn_id: null,
    created_at: '2026-09-30T00:00:00Z' });
  for (const [id, position] of [['first', '1'], ['second', '2']]) {
    const text = JSON.stringify({ version: 3, kind: 'guidance', text: id, editorText: id, position,
      hold: 'none', revisionSeq: position });
    h.feed.details[`turn-intent-preview:${id}`] = { status: 'ready', text, totalBytes: text.length };
  }
  h.feed.records = { TurnIntent: { second: intent('second'), first: intent('first') } };
  let view = await h.render();
  assert.deepEqual(view.groups.map((group) => [group.id, group.count]), [['waiting', 2]]);
  assert.equal(h.chat.currentTurnInputEchoes.value.length, 1);
  assert.deepEqual(view.setup.waitingItems.map((item) => item.id), ['first', 'second']);
  assert.equal(view.setup.canReorder, false, 'unconfirmed submission still blocks reordering');
  const before = posted.filter((message) => message.type === T.GuidanceReorder).length;
  const event = { preventDefault() {}, dataTransfer: { setData() {}, getData: () => 'second' } };
  view.setup.dropOn(event, view.setup.waitingItems[0]);
  assert.equal(posted.filter((message) => message.type === T.GuidanceReorder).length, before);
  h.ack(submission);
  h.feed.records = { ...h.feed.records, Turn: { turn: { id: 'turn', conversation_id: h.conversationId, status: 'active' } } };
  view = await h.render();
  assert.equal(view.setup.canReorder, true);
  view.setup.startDrag(event, view.setup.waitingItems[1]);
  view.setup.dropOn(event, view.setup.waitingItems[0]);
  const reorder = posted.filter((message) => message.type === T.GuidanceReorder).at(-1);
  assert.deepEqual(reorder.payload.items, [
    { intentId: 'second', expectedRevisionSeq: '2' },
    { intentId: 'first', expectedRevisionSeq: '1' }
  ]);
});
