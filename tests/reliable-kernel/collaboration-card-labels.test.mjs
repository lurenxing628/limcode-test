import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const kernel = require(path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension', 'backend/reliableKernel/index.js'));
const NOW = '2026-09-22T00:00:00.000Z';
const LATER = '2026-09-23T00:00:00.000Z';
const row = (domain, value) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(value);

/**
 * The frames a real bounded feed sends to a Webview bound to `target`: its snapshot, then whatever
 * one committed deletion of the peer `gone` produces. `gone` is also a fork of `target`, so like any
 * fork it holds a copied message and the ConversationBranchLink from `target`.
 */
async function feedFrames() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-collaboration-card-labels-'));
  let database;
  const feedClient = { received: [] };
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
    const incoming = async (id, from, text) => {
      const payload = await store.ingest(database, text, 'text/vnd.limcode.collaboration-message');
      return [
        kernel.DOMAIN_REPOSITORIES.domain('CollaborationMessage').insertWithNextSequence({ id, dedupe_key: id, mode: 'message', created_at: NOW }, { column: 'message_seq', scope: {} }),
        row('CollaborationMessageSourceLink', { id: `${id}-source`, message_id: id, conversation_id: from, source_kind: 'tool', source_key: id, turn_id: null, tool_call_id: null, created_at: NOW }),
        row('RuntimeInboxItem', { id: `${id}-inbox`, dedupe_key: id, source_kind: 'collaboration_message', source_id: id, state: 'available', created_at: NOW, updated_at: NOW }),
        row('CollaborationMessageTargetLink', { id: `${id}-target`, message_id: id, conversation_id: 'target', inbox_item_id: `${id}-inbox`, anchor_turn_id: null, created_at: NOW }),
        row('CollaborationMessagePayloadLink', { id: `${id}-payload`, message_id: id, content_object_id: payload.id, created_at: NOW }),
        row('RuntimeDelivery', { id: `${id}-delivery`, inbox_item_id: `${id}-inbox`, target_conversation_id: 'target', target_turn_id: 'target-turn', phase: 'current_turn',
          attempt_seq: 1n, retry_of_delivery_id: null, state: 'consumed', failure_reason: null, created_at: NOW, updated_at: NOW }),
        row('RuntimeDeliveryInputLink', { id: `${id}-input`, delivery_id: `${id}-delivery`, pending_turn_input_id: `${id}-pending-input`, handled_at: NOW, created_at: NOW, updated_at: NOW })
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
      ...await incoming('from-gone', 'gone', '来自将被删除的对话')
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
      return { snapshot, deletion: feedClient.received.slice(1) };
    } finally { feed.close(); }
  } finally {
    if (database) await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('a real snapshot and Conversation deletion drive the card and queue labels, the fork button and the fork notice', async (t) => {
  const { snapshot, deletion } = await feedFrames();
  assert.equal(snapshot.type, 'reliable-kernel.snapshot');
  assert.deepEqual(deletion.map((message) => message.type), ['reliable-kernel.snapshot'],
    'deleting a Conversation that has messages reaches the target session as a fresh snapshot, not a Conversation remove');
  const navigation = snapshot.projections.navigationSummary.conversations.map((value) => value.id);
  assert.equal(navigation.includes('sender') || navigation.includes('gone'), false, 'both peers are outside the navigation list');

  const { createServer } = await import('vite');
  const pinia = await import('pinia');
  const { createSSRApp, nextTick } = await import('vue');
  const { renderToString } = await import('@vue/server-renderer');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const command = { commandId: 'fork-command-replayed', expectedVersion: 0, issuedAt: 1 };
  const host = { posted: [], listeners: new Set(), state: { reliableConversationControls: {
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
    setTimeout, clearTimeout,
    requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    acquireVsCodeApi() {
      return {
        postMessage(message) { host.posted.push(structuredClone(message)); },
        getState() { return host.state; },
        setState(value) { host.state = structuredClone(value); }
      };
    }
  };
  const server = await createServer({ configFile: path.join(process.cwd(), 'vite.config.ts'), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  const isolated = pinia.createPinia();
  pinia.setActivePinia(isolated);
  try {
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
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 50));
    pinia.setActivePinia(previousPinia);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    await server.close();
  }
});
