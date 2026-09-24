import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const require = createRequire(import.meta.url);
const kernel = require(path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension', 'backend/reliableKernel/index.js'));
const EARLIER = '2026-09-21T00:00:00.000Z';
const NOW = '2026-09-22T00:00:00.000Z';
const LATER = '2026-09-23T00:00:00.000Z';
const row = (domain, value) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(value);

/**
 * The frames a real bounded feed sends to a Webview bound to `target`: its snapshot, then whatever
 * one committed deletion of the peer `gone` produces. `gone` is also a fork of `target`, so like any
 * fork it holds a copied message and the ConversationBranchLink from `target`. The Runtime stays open
 * so its detail reader can answer the Webview's detail requests.
 */
async function openRuntime() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-collaboration-card-labels-'));
  let database;
  const feedClient = { received: [] };
  const close = async () => {
    if (database) await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  };
  try {
    const fixture = await kernel.resetCandidateRuntimeRoot(directory);
    database = await kernel.RuntimeDatabase.open(fixture.authority, { hostBootId: 'collaboration-card-labels' });
    const store = new kernel.ContentAddressedStore(fixture.authority, fixture.binding);
    const userMessage = async (id, turnId, text) => {
      const content = await store.ingest(database, JSON.stringify({ role: 'user', parts: [{ text }] }), 'application/vnd.limcode.message+json');
      return [
        row('Message', { id, created_at: NOW, updated_at: NOW, deleted_at: null }),
        row('MessageRevision', { id: `${id}-revision`, message_id: id, revision_seq: 1n, role: 'user', content_object_id: content.id, created_at: NOW }),
        row('MessageCurrentRevisionLink', { id: `${id}-current`, message_id: id, revision_id: `${id}-revision`, updated_at: NOW }),
        row('MessagePartOfConversation', { id: `${id}-member`, conversation_id: id.split('-')[0], message_id: id,
          message_seq: id.endsWith('second') ? 2n : 1n, created_at: NOW }),
        ...(turnId ? [row('MessageTurnLink', { id: `${id}-turn`, turn_id: turnId, message_id: id, role: 'user', created_at: NOW })] : [])
      ];
    };
    /** Delivered into the finished Turn unless `failedAt` says it failed, sent at that time, before reaching a Turn. */
    const incoming = async (id, from, text, failedAt) => {
      const payload = await store.ingest(database, text, 'text/vnd.limcode.collaboration-message');
      const sentAt = failedAt ?? NOW;
      return [
        kernel.DOMAIN_REPOSITORIES.domain('CollaborationMessage').insertWithNextSequence({ id, dedupe_key: id, mode: 'message', created_at: sentAt }, { column: 'message_seq', scope: {} }),
        row('CollaborationMessageSourceLink', { id: `${id}-source`, message_id: id, conversation_id: from, source_kind: 'tool', source_key: id, turn_id: null, tool_call_id: null, created_at: NOW }),
        row('RuntimeInboxItem', { id: `${id}-inbox`, dedupe_key: id, source_kind: 'collaboration_message', source_id: id, state: 'available', created_at: NOW, updated_at: NOW }),
        row('CollaborationMessageTargetLink', { id: `${id}-target`, message_id: id, conversation_id: 'target', inbox_item_id: `${id}-inbox`, anchor_turn_id: null, created_at: NOW }),
        row('CollaborationMessagePayloadLink', { id: `${id}-payload`, message_id: id, content_object_id: payload.id, created_at: NOW }),
        failedAt
          ? row('RuntimeDelivery', { id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: 'target', target_turn_id: null, phase: 'next_turn',
            attempt_seq: 1n, retry_of_delivery_id: null, state: 'failed', failure_reason: 'wake-dead-letter', created_at: sentAt, updated_at: sentAt })
          : row('RuntimeDelivery', { id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: 'target', target_turn_id: 'target-turn', phase: 'current_turn',
            attempt_seq: 1n, retry_of_delivery_id: null, state: 'consumed', failure_reason: null, created_at: NOW, updated_at: NOW }),
        ...(failedAt ? [] : [row('RuntimeDeliveryInputLink', { id: `${id}-input`, delivery_id: `${id}-delivery`, pending_turn_input_id: `${id}-pending-input`, handled_at: NOW, created_at: NOW, updated_at: NOW })])
      ];
    };
    await database.transaction([
      row('Conversation', { id: 'target', title: 'target', status: 'active', created_at: NOW, updated_at: NOW }),
      // A placeholder title: the sidebar and the card show the first user message instead.
      row('Conversation', { id: 'sender', title: '新对话', status: 'active', created_at: NOW, updated_at: NOW }),
      row('Conversation', { id: 'gone', title: '会被删除的对话', status: 'active', created_at: NOW, updated_at: NOW }),
      // Newer conversations push both peers out of the bounded navigation list.
      ...Array.from({ length: 205 }, (_value, index) => row('Conversation', { id: `busy-${index}`, title: `busy ${index}`, status: 'active', created_at: LATER, updated_at: LATER })),
      row('Turn', { id: 'target-turn', conversation_id: 'target', status: 'terminated', created_at: NOW, updated_at: NOW, terminal_at: NOW }),
      row('Turn', { id: 'target-running', conversation_id: 'target', status: 'active', created_at: NOW, updated_at: NOW, terminal_at: null }),
      ...await userMessage('sender-first', null, '调研登录流程'),
      ...await userMessage('target-first', 'target-turn', '第一轮'),
      ...await userMessage('target-second', 'target-running', '第二轮'),
      ...await userMessage('gone-first', null, '第一轮'),
      row('ConversationBranchLink', { id: 'gone-branch', target_conversation_id: 'gone', source_conversation_id: 'target',
        source_message_revision_id: 'target-first-revision', created_at: NOW }),
      ...await incoming('from-sender', 'sender', '来自调研对话'),
      ...await incoming('from-gone', 'gone', '来自将被删除的对话'),
      // Failed before the first message of `target`, whose whole history the snapshot loads.
      ...await incoming('failed-early', 'sender', '比第一条消息更早的任务', EARLIER)
    ]);
    const feed = new kernel.BoundedClientFeed(database);
    try {
      const connection = await feed.connect({ activeConversationId: 'target', send: (message) => feedClient.received.push(message) });
      const snapshot = feedClient.received[0];
      feed.acknowledge({ sessionId: connection.sessionId, hostBootId: connection.hostBootId, messageSeq: snapshot.messageSeq });
      await new kernel.ConversationDeletionControlPlane(database).delete('gone');
      for (let attempt = 0; attempt < 400 && feedClient.received.length === 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return { snapshot, deletion: feedClient.received.slice(1), details: new kernel.ClientDetailReader(database, store), close };
    } finally { feed.close(); }
  } catch (error) {
    await close();
    throw error;
  }
}

test('a real snapshot and Conversation deletion drive the card and queue labels, the fork button and the fork notice', async (t) => {
  const runtime = await openRuntime();
  const { snapshot, deletion } = runtime;
  assert.equal(snapshot.type, 'reliable-kernel.snapshot');
  assert.deepEqual(deletion.map((message) => message.type), ['reliable-kernel.snapshot'],
    'deleting a Conversation that has messages reaches the target session as a fresh snapshot, not a Conversation remove');
  const navigation = snapshot.projections.navigationSummary.conversations.map((value) => value.id);
  assert.equal(navigation.includes('sender') || navigation.includes('gone'), false, 'both peers are outside the navigation list');

  const pinia = await import('pinia');
  const { createSSRApp, nextTick } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const command = { commandId: 'fork-command-replayed', expectedVersion: 0, issuedAt: 1 };
  // Detail requests are answered by the Runtime's own reader, as the extension host does.
  const host = { posted: [], listeners: new Set(), answerDetail: undefined, detailReads: [], state: { reliableConversationControls: {
    conversationActions: {}, pendingTurnInputs: {}, failedTurnInputs: {},
    // An unconfirmed fork from before a reload: its replayed result offers the fork as a notice.
    forkRequests: { [command.commandId]: {
      actionId: command.commandId, sourceConversationId: 'target', messageId: 'target-first',
      payload: { sourceConversationId: 'target', messageId: 'target-first', expectedRevisionId: 'target-first-revision', command },
      requestId: 'lost-request', sentSessionId: 'session-before-reload'
    } }
  } } };
  globalThis.window = {
    addEventListener(type, listener) { if (type === 'message') host.listeners.add(listener); },
    removeEventListener(_type, listener) { host.listeners.delete(listener); },
    setTimeout, clearTimeout, atob,
    requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    acquireVsCodeApi() {
      return {
        postMessage(message) {
          const plain = structuredClone(message);
          host.posted.push(plain);
          if (plain?.type === 'reliable-kernel.detail-request') host.answerDetail(plain);
        },
        getState() { return host.state; },
        setState(value) { host.state = structuredClone(value); }
      };
    }
  };
  let server;
  const isolated = pinia.createPinia();
  pinia.setActivePinia(isolated);
  try {
    server = await createWebviewSsrServer();
    const { BridgeMessageType } = await server.ssrLoadModule(path.join(process.cwd(), 'shared/protocol.ts'));
    const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
    const { collaborationCardLabel } = await server.ssrLoadModule('/src/domain/reliableCollaborationTimeline.ts');
    const { default: messageList } = await server.ssrLoadModule('/src/components/conversation/ReliableMessageList.vue');
    const { default: queuePanel } = await server.ssrLoadModule('/src/components/input/ReliableQueuePanel.vue');
    // Tooltip panels size themselves against the viewport while rendering (set after Vite starts,
    // which treats a global document as a browser).
    globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
    const mount = async (component) => {
      let setupState;
      const app = createSSRApp(component, {}).use(isolated);
      app.mixin({ created() { if (this.$.type.__name === component.__name) setupState = this.$.setupState; } });
      return { html: await renderToString(app), setup: setupState };
    };
    const feed = useReliableKernelClientFeedStore();
    host.answerDetail = (request) => host.detailReads.push(runtime.details.read({ ...request, conversationId: 'target' }).then(
      (detail) => feed.observe({ type: 'reliable-kernel.detail-result', requestId: request.requestId, sessionId: request.sessionId, detail }),
      (error) => feed.observe({ type: 'reliable-kernel.detail-error', requestId: request.requestId, sessionId: request.sessionId, message: String(error?.message ?? error) })
    ));
    feed.observe(snapshot);
    await nextTick();
    const peers = feed.records.CollaborationPeerConversation ?? {};
    assert.deepEqual(Object.keys(peers).sort(), ['gone', 'sender'], 'the snapshot peers become their own records');
    assert.equal(peers.sender.display_title, '调研登录流程');

    const labels = (setup) => Object.values(setup.collaborationTimeline.afterMessage).flat().map((card) => collaborationCardLabel(card)).sort();
    let list = await mount(messageList);
    let queue = await mount(queuePanel);
    assert.deepEqual(labels(list.setup), ['来自对话 会被删除的对话', '来自对话 调研登录流程']);
    assert.match(list.html, /来自对话 调研登录流程/);
    assert.deepEqual(list.setup.collaborationTimeline.beforeMessage['target-first']?.map((card) => [card.messageId, card.status]),
      [['failed-early', 'failed']], 'a failure older than every message sits above the first one when the whole history is loaded');
    assert.match(list.html, /比第一条消息更早的任务/);
    assert.equal(queue.setup.collaborationSourceLabel('gone'), '来自对话 会被删除的对话');

    await t.test('a replayed fork result shows the notice until the fork is deleted', async () => {
      const [replayed] = host.posted.filter((message) => message.type === BridgeMessageType.ConversationFork);
      assert.equal(replayed?.payload.command.commandId, command.commandId);
      assert.equal(list.setup.forkBlocked({ id: 'target-first', conversationId: 'target', role: 'user', status: 'done' }), true,
        'the replayed fork of this message is still pending');
      for (const listener of host.listeners) listener({ data: {
        id: 'fork-result', type: BridgeMessageType.ConversationForkResult, channel: 'control', correlationId: replayed.id,
        payload: { ...replayed.payload, commandId: command.commandId, conversationId: 'gone', status: 'accepted' }
      } });
      await nextTick();
      list = await mount(messageList);
      assert.match(list.html, /之前的分支请求已完成，分支已创建。/);
      assert.match(list.html, /打开分支/);
    });

    await t.test('the fork button follows the running Turn and a pending fork', async () => {
      const message = (id) => ({ id, conversationId: 'target', role: 'user', status: 'done' });
      assert.equal(list.setup.forkBlocked(message('target-first')), false, 'a message of a completed Turn can be forked again once its fork resolved');
      assert.equal(list.setup.forkBlocked(message('target-second')), true, 'a message of the running Turn cannot');
      const forkButtons = list.html.match(/<button[^>]*aria-label="复制本对话至此"[^>]*>/g) ?? [];
      assert.equal(forkButtons.length, 2);
      assert.deepEqual(forkButtons.map((button) => /\sdisabled/.test(button)), [false, true]);
    });

    for (const frame of deletion) feed.observe(frame);
    await nextTick();
    assert.equal(feed.records.ConversationBranchLink?.['gone-branch'], undefined, 'the branch link went with the fork');
    list = await mount(messageList);
    queue = await mount(queuePanel);
    assert.deepEqual(labels(list.setup), ['来自对话 调研登录流程', '来自已删除的对话'], 'the card of the deleted peer reads as deleted');
    assert.match(list.html, /来自已删除的对话/);
    assert.equal(queue.setup.collaborationSourceLabel('gone'), '来自已删除的对话');
    assert.equal(queue.setup.collaborationSourceLabel('sender'), '来自对话 调研登录流程');
    assert.doesNotMatch(list.html, /分支已创建/, 'the notice of a deleted fork is gone');
    host.posted = [];
    list.setup.openForkReadyNotice();
    assert.deepEqual(host.posted.filter((message) => message.type === BridgeMessageType.ConversationOpen), [],
      '"打开分支" never opens the deleted fork');

    // Every detail request is answered, so no request deadline or retry timer outlives the test.
    for (let attempt = 0; attempt < 400 && Object.keys(feed.pendingDetails).length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.deepEqual(Object.keys(feed.pendingDetails), []);
    list = await mount(messageList);
    assert.match(list.html, /第一轮/, 'the message bodies came from the Runtime detail reader');
  } finally {
    await Promise.allSettled(host.detailReads);
    await new Promise((resolve) => setTimeout(resolve, 50));
    pinia.setActivePinia(previousPinia);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    await server?.close();
    await runtime.close();
  }
});

/** The rows of one saved message of `target`, linked to its Turn when one is given. */
function targetMessageRows({ id, seq, role = 'user', turnId, at = NOW, contentId }) {
  return [
    row('Message', { id, created_at: at, updated_at: at, deleted_at: null }),
    row('MessageRevision', { id: `${id}-revision`, message_id: id, revision_seq: 1n, role, content_object_id: contentId, created_at: at }),
    row('MessageCurrentRevisionLink', { id: `${id}-current`, message_id: id, revision_id: `${id}-revision`, updated_at: at }),
    row('MessagePartOfConversation', { id: `${id}-member`, conversation_id: 'target', message_id: id, message_seq: BigInt(seq), created_at: at }),
    ...(turnId ? [row('MessageTurnLink', { id: `${id}-turn`, turn_id: turnId, message_id: id, role, created_at: at })] : [])
  ];
}

/** A collaboration message from `sender` to `target`, sent at `at`, with the newest delivery attempt `delivery`. */
function incomingRows({ id, mode = 'message', at, payloadId, delivery }) {
  const { state, turnId = null } = delivery;
  return [
    kernel.DOMAIN_REPOSITORIES.domain('CollaborationMessage').insertWithNextSequence({ id, dedupe_key: id, mode, created_at: at }, { column: 'message_seq', scope: {} }),
    row('CollaborationMessageSourceLink', { id: `${id}-source`, message_id: id, conversation_id: 'sender', source_kind: 'tool', source_key: id, turn_id: null, tool_call_id: null, created_at: at }),
    row('RuntimeInboxItem', { id: `${id}-inbox`, dedupe_key: id, source_kind: 'collaboration_message', source_id: id, state: 'available', created_at: at, updated_at: at }),
    row('CollaborationMessageTargetLink', { id: `${id}-target`, message_id: id, conversation_id: 'target', inbox_item_id: `${id}-inbox`, anchor_turn_id: null, created_at: at }),
    row('CollaborationMessagePayloadLink', { id: `${id}-payload`, message_id: id, content_object_id: payloadId, created_at: at }),
    row('RuntimeDelivery', { id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: 'target', target_turn_id: turnId, phase: 'next_turn',
      attempt_seq: 1n, retry_of_delivery_id: null, state, failure_reason: state === 'failed' ? 'wake-dead-letter' : null, created_at: at, updated_at: at }),
    ...(state === 'consumed' ? [row('RuntimeDeliveryInputLink', { id: `${id}-input`, delivery_id: `${id}-delivery`, pending_turn_input_id: `${id}-pending-input`, handled_at: at, created_at: at, updated_at: at })] : [])
  ];
}

/**
 * A Runtime of its own for one scenario with the Conversations `target` and `sender`. `seed` returns
 * the rows of its first transaction and `commit(rows)` writes a later one; `snapshot()` is the first
 * frame a bounded feed bound to `target` sends, and `connect()` keeps such a feed open; `details`
 * answers the Webview's detail requests as the extension host does.
 */
async function openScenario(name, seed) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `limcode-collaboration-${name}-`));
  let database;
  const close = async () => {
    if (database) await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  };
  try {
    const fixture = await kernel.resetCandidateRuntimeRoot(directory);
    database = await kernel.RuntimeDatabase.open(fixture.authority, { hostBootId: `collaboration-${name}` });
    const store = new kernel.ContentAddressedStore(fixture.authority, fixture.binding);
    const ingest = {
      message: async (role, text) => (await store.ingest(database, JSON.stringify({ role, parts: [{ text }] }), 'application/vnd.limcode.message+json')).id,
      payload: async (text) => (await store.ingest(database, text, 'text/vnd.limcode.collaboration-message')).id
    };
    await database.transaction([
      row('Conversation', { id: 'target', title: 'target', status: 'active', created_at: EARLIER, updated_at: EARLIER }),
      row('Conversation', { id: 'sender', title: '调研对话', status: 'active', created_at: EARLIER, updated_at: EARLIER }),
      ...await seed(ingest)
    ]);
    const snapshot = async () => {
      const feed = new kernel.BoundedClientFeed(database);
      const received = [];
      try {
        await feed.connect({ activeConversationId: 'target', send: (message) => received.push(message) });
        return received[0];
      } finally { feed.close(); }
    };
    const feeds = [];
    /** A live feed bound to `target`; `take()` returns the frames sent since the last call, each acknowledged. */
    const connect = async () => {
      const feed = new kernel.BoundedClientFeed(database);
      feeds.push(feed);
      const received = [];
      let taken = 0;
      const connection = await feed.connect({ activeConversationId: 'target', send: (message) => received.push(message) });
      const take = async () => {
        for (let attempt = 0; attempt < 400 && received.length === taken; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const frames = [];
        for (let idle = 0; idle < 10;) {
          if (taken < received.length) {
            const frame = received[taken++];
            frames.push(frame);
            feed.acknowledge({ sessionId: connection.sessionId, hostBootId: connection.hostBootId, messageSeq: frame.messageSeq });
            idle = 0;
          } else {
            await new Promise((resolve) => setTimeout(resolve, 5));
            idle += 1;
          }
        }
        return frames;
      };
      return { take };
    };
    const commit = (rows) => database.transaction(rows);
    return { ingest, snapshot, connect, commit, details: new kernel.ClientDetailReader(database, store), close: async () => {
      for (const feed of feeds) feed.close();
      await close();
    } };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Renders the real message list over feed frames. `open(scenario)` gives a fresh store whose detail
 * requests the scenario's Runtime answers; `mount()` waits until every one is answered, so no
 * request timer outlives the test.
 */
async function withMessageList(body) {
  const pinia = await import('pinia');
  const { createSSRApp, nextTick } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const host = { answerDetail: undefined, reads: [] };
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout, atob,
    requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    acquireVsCodeApi() {
      return {
        postMessage(message) {
          const plain = structuredClone(message);
          if (plain?.type === 'reliable-kernel.detail-request') host.answerDetail(plain);
        },
        getState() { return undefined; },
        setState() {}
      };
    }
  };
  let server;
  try {
    server = await createWebviewSsrServer();
    const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
    const { default: messageList } = await server.ssrLoadModule('/src/components/conversation/ReliableMessageList.vue');
    globalThis.document = { documentElement: { clientWidth: 1280, clientHeight: 800 } };
    const mount = async (active) => {
      let setup;
      const app = createSSRApp(messageList, {}).use(active);
      app.mixin({ created() { if (this.$.type.__name === messageList.__name) setup = this.$.setupState; } });
      return { html: await renderToString(app), setup };
    };
    /** A store bound to one scenario; `observe(frames)` then `mount()` renders what it holds. */
    const open = (scenario) => {
      const active = pinia.createPinia();
      pinia.setActivePinia(active);
      const feed = useReliableKernelClientFeedStore();
      host.answerDetail = (request) => host.reads.push(scenario.details.read({ ...request, conversationId: 'target' }).then(
        (detail) => feed.observe({ type: 'reliable-kernel.detail-result', requestId: request.requestId, sessionId: request.sessionId, detail }),
        (error) => feed.observe({ type: 'reliable-kernel.detail-error', requestId: request.requestId, sessionId: request.sessionId, message: String(error?.message ?? error) })
      ));
      return {
        feed,
        observe: async (...frames) => {
          for (const frame of frames) feed.observe(frame);
          await nextTick();
        },
        /** Renders twice: the first render asks for the message bodies, the second shows them. */
        mount: async () => {
          await mount(active);
          for (let attempt = 0; attempt < 400 && Object.keys(feed.pendingDetails).length > 0; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
          await Promise.allSettled(host.reads);
          assert.deepEqual(Object.keys(feed.pendingDetails), [], 'every detail request was answered');
          return mount(active);
        }
      };
    };
    await body(open);
  } finally {
    await Promise.allSettled(host.reads);
    pinia.setActivePinia(previousPinia);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    await server?.close();
  }
}

/** Card ids per bucket of the mounted list's collaboration timeline. */
function placedCards(setup) {
  const ids = (buckets) => Object.fromEntries(Object.entries(buckets).map(([anchor, cards]) => [anchor, cards.map((card) => card.messageId)]));
  const timeline = setup.collaborationTimeline;
  return {
    before: ids(timeline.beforeMessage),
    after: ids(timeline.afterMessage),
    turnWithoutMessage: timeline.turnWithoutMessage.map((card) => card.messageId),
    unbound: timeline.unbound.map((card) => card.messageId)
  };
}

test('a failed card older than every loaded message is placed by whether message 1 is loaded', async (t) => {
  await withMessageList(async (open) => {
    await t.test('a gap after message 1 leaves the card above message 1', async () => {
      const scenario = await openScenario('gap', async (ingest) => [
        ...(await Promise.all([1, 2, 3].map(async (seq) => targetMessageRows({ id: `target-${seq}`, seq, contentId: await ingest.message('user', `第 ${seq} 条`) })))).flat(),
        ...incomingRows({ id: 'failed-early', at: EARLIER, payloadId: await ingest.payload('比第一条消息更早的任务'), delivery: { state: 'failed' } })
      ]);
      try {
        const snapshot = await scenario.snapshot();
        // Message 2 is missing, as a byte trim that keeps a protected first message leaves the window.
        const window = snapshot.projections.activeConversationWindow;
        assert.deepEqual(window.messages.map((message) => message.id), ['target-1', 'target-2', 'target-3']);
        window.messages = window.messages.filter((message) => message.id !== 'target-2');
        const view = open(scenario);
        await view.observe(snapshot);
        const { html, setup } = await view.mount();
        assert.equal(setup.hasLoadedFloorGap, true);
        assert.deepEqual(placedCards(setup), { before: { 'target-1': ['failed-early'] }, after: {}, turnWithoutMessage: [], unbound: [] },
          'a failure older than message 1 belongs above it whatever the gap holds');
        assert.match(html, /比第一条消息更早的任务/);
      } finally { await scenario.close(); }
    });

    await t.test('a window that starts after message 1 holds the card back until the earlier history loads', async () => {
      const scenario = await openScenario('window', async (ingest) => {
        const contentId = await ingest.message('user', '较早的消息');
        return [
          // One more message than the snapshot window holds, so message 1 stays in the earlier history.
          ...Array.from({ length: 201 }, (_value, index) => targetMessageRows({ id: `target-${index + 1}`, seq: index + 1, contentId })).flat(),
          ...incomingRows({ id: 'failed-early', at: EARLIER, payloadId: await ingest.payload('比第一条消息更早的任务'), delivery: { state: 'failed' } })
        ];
      });
      try {
        const snapshot = await scenario.snapshot();
        const window = snapshot.projections.activeConversationWindow;
        assert.equal(window.messages[0]?.id, 'target-2', 'the window starts after message 1');
        const view = open(scenario);
        await view.observe(snapshot);
        const { html, setup } = await view.mount();
        assert.equal(setup.earliestLoadedFloor, 2);
        assert.equal(setup.canRequestEarlierHistory, true, 'the earlier history can be loaded');
        assert.deepEqual(placedCards(setup), { before: {}, after: {}, turnWithoutMessage: [], unbound: [] },
          'the card is neither above nor below a loaded message: the earlier history holds its position');
        assert.doesNotMatch(html, /比第一条消息更早的任务/);
      } finally { await scenario.close(); }
    });
  });
});

/** `NOW` plus the given seconds. */
const after = (seconds) => new Date(Date.parse(NOW) + seconds * 1000).toISOString();

/** A Turn of `target` started at `at`, ended with `ended` when given. */
function targetTurnRows({ id, at, ended }) {
  return [
    row('Turn', { id, conversation_id: 'target', status: ended ? 'terminated' : 'active', created_at: at, updated_at: at, terminal_at: ended ? at : null }),
    ...(ended ? [row('TurnTermination', { id: `${id}-termination`, turn_id: id, terminal_status: ended.status, reason: ended.reason, created_at: at })] : [])
  ];
}

test('an incoming card stays visible while the Turn it started has no saved message', async (t) => {
  const TASK = '请调研登录流程并汇报';
  await withMessageList(async (open) => {
    /** The task that created `target` started `task-turn`, which ended as `ended` before saving any text. */
    const firstTurnEnded = async (name, ended) => {
      const scenario = await openScenario(name, async (ingest) => [
        ...targetTurnRows({ id: 'task-turn', at: after(1), ended }),
        ...incomingRows({ id: 'task', mode: 'followup', at: NOW, payloadId: await ingest.payload(TASK), delivery: { state: 'consumed', turnId: 'task-turn' } })
      ]);
      try {
        const view = open(scenario);
        await view.observe(await scenario.snapshot());
        return await view.mount();
      } finally { await scenario.close(); }
    };

    await t.test('a created Conversation whose first request failed shows its task above the failure', async () => {
      const { html, setup } = await firstTurnEnded('first-request-failed', { status: 'failed', reason: 'HTTP 429' });
      assert.match(html, new RegExp(TASK), 'the task the Conversation was created for is shown');
      assert.deepEqual(placedCards(setup), { before: {}, after: {}, turnWithoutMessage: ['task'], unbound: [] });
      assert.ok(html.indexOf(TASK) < html.indexOf('本轮执行失败'), 'the task that started the Turn precedes its failure');
      assert.doesNotMatch(html, /还没有消息/, 'the empty hint does not stand in for the card');
    });

    await t.test('a first Turn the user stopped still shows its task', async () => {
      const { html, setup } = await firstTurnEnded('first-turn-stopped', { status: 'interrupted', reason: 'User requested stop.' });
      assert.match(html, new RegExp(TASK));
      assert.deepEqual(placedCards(setup).turnWithoutMessage, ['task']);
      assert.doesNotMatch(html, /还没有消息/);
    });

    await t.test('the card stays visible across the first request, in the same place', async () => {
      const scenario = await openScenario('first-request', async (ingest) => [
        ...incomingRows({ id: 'task', mode: 'followup', at: NOW, payloadId: await ingest.payload(TASK), delivery: { state: 'pending' } })
      ]);
      try {
        const live = await scenario.connect();
        const view = open(scenario);
        const stage = async (frames) => {
          await view.observe(...frames);
          const mounted = await view.mount();
          assert.match(mounted.html, new RegExp(TASK));
          assert.doesNotMatch(mounted.html, /还没有消息/);
          return mounted;
        };
        let mounted = await stage(await live.take());
        assert.deepEqual(placedCards(mounted.setup).unbound, ['task'], 'waiting for the next Turn');

        const recipeId = await scenario.ingest.payload('{}');
        await scenario.commit([
          ...targetTurnRows({ id: 'task-turn', at: after(1) }),
          kernel.DOMAIN_REPOSITORIES.domain('RuntimeDelivery').update('task-delivery', { state: 'consumed', target_turn_id: 'task-turn', updated_at: after(1) }),
          row('RuntimeDeliveryInputLink', { id: 'task-input', delivery_id: 'task-delivery', pending_turn_input_id: 'task-pending-input', handled_at: after(1), created_at: after(1), updated_at: after(1) }),
          row('ModelRequest', { id: 'task-request', turn_id: 'task-turn', request_seq: 1n, status: 'prepared', terminal_state: null, provider_id: 'provider', model_id: 'model',
            context_window_tokens: 1000n, compression_threshold_tokens: 800n, estimated_context_tokens: 10n, authority_snapshot_id: 'authority', settings_snapshot_object_id: null,
            recipe_object_id: recipeId, usage_json: null, stream_stats_json: { attemptSeq: '1', socketGeneration: '0', retryReason: null }, created_at: after(2), updated_at: after(2) }),
          row('Operation', { id: 'task-operation', owner_kind: 'model_request', owner_id: 'task-request', operation_seq: 1n, tool_call_id: null, status: 'pending', created_at: after(2), updated_at: after(2) }),
          row('Attempt', { id: 'task-attempt', operation_id: 'task-operation', attempt_seq: 1n, status: 'pending', created_at: after(2), updated_at: after(2), completed_at: null })
        ]);
        mounted = await stage(await live.take());
        assert.deepEqual(placedCards(mounted.setup), { before: {}, after: {}, turnWithoutMessage: ['task'], unbound: [] },
          'the first request has nothing to show yet');
        assert.match(mounted.html, /正在启动 LLM 请求/);
        assert.ok(mounted.html.indexOf(TASK) < mounted.html.indexOf('正在启动 LLM 请求'), 'the task precedes the running request');

        await scenario.commit([
          ...targetMessageRows({ id: 'reply', seq: 1, role: 'model', turnId: 'task-turn', at: after(3), contentId: await scenario.ingest.message('model', '已开始调研') }),
          row('ModelRequestMessageLink', { id: 'task-request-message', model_request_id: 'task-request', message_id: 'reply', created_at: after(3) })
        ]);
        mounted = await stage(await live.take());
        assert.deepEqual(placedCards(mounted.setup), { before: { reply: ['task'] }, after: {}, turnWithoutMessage: [], unbound: [] },
          'above the reply once it is saved');
        const task = mounted.html.indexOf(TASK);
        assert.ok(mounted.html.indexOf('data-timeline-row-key="reply"') < task && task < mounted.html.indexOf('data-message-id="reply"'),
          'drawn in the reply\'s row, above the reply');
      } finally { await scenario.close(); }
    });

    await t.test('an older card of a Turn without a message sits where that Turn started, between earlier and later messages', async () => {
      const scenario = await openScenario('older-turn', async (ingest) => [
        ...targetTurnRows({ id: 'user-turn', at: NOW, ended: { status: 'completed', reason: 'completed' } }),
        ...targetMessageRows({ id: 'earlier-question', seq: 1, turnId: 'user-turn', at: NOW, contentId: await ingest.message('user', '早先的问题') }),
        ...targetMessageRows({ id: 'earlier-answer', seq: 2, role: 'model', turnId: 'user-turn', at: after(1), contentId: await ingest.message('model', '早先的回答') }),
        ...incomingRows({ id: 'task', mode: 'followup', at: after(2), payloadId: await ingest.payload(TASK), delivery: { state: 'consumed', turnId: 'task-turn' } }),
        ...targetTurnRows({ id: 'task-turn', at: after(3), ended: { status: 'failed', reason: 'HTTP 429' } }),
        ...targetTurnRows({ id: 'later-turn', at: after(10) }),
        ...targetMessageRows({ id: 'later-question', seq: 3, turnId: 'later-turn', at: after(10), contentId: await ingest.message('user', '后来的问题') })
      ]);
      try {
        const view = open(scenario);
        await view.observe(await scenario.snapshot());
        const { html, setup } = await view.mount();
        assert.deepEqual(placedCards(setup), { before: {}, after: { 'earlier-answer': ['task'] }, turnWithoutMessage: [], unbound: [] },
          'after the last message created before that Turn started');
        assert.ok(html.indexOf('早先的回答') < html.indexOf(TASK) && html.indexOf(TASK) < html.indexOf('后来的问题'));
      } finally { await scenario.close(); }
    });
  });
});
