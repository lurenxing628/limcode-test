import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createWebviewSsrServer } from './webview-ssr-server.mjs';

const require = createRequire(import.meta.url);
const kernel = require(path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension', 'backend/reliableKernel/index.js'));
const NOW = '2026-09-22T00:00:00.000Z';
const row = (domain, value) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(value);

/**
 * A real Runtime and bounded feed. `source` holds the forked message; `branch` and `doomed-branch`
 * are its forks, each with the copied message and the ConversationBranchLink a fork commits;
 * `unrelated` has no messages.
 */
async function openRuntime() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-fork-request-wiring-'));
  const fixture = await kernel.resetCandidateRuntimeRoot(directory);
  const database = await kernel.RuntimeDatabase.open(fixture.authority, { hostBootId: 'fork-request-wiring' });
  const store = new kernel.ContentAddressedStore(fixture.authority, fixture.binding);
  const userMessage = async (id, revisionId, conversationId, text) => {
    const content = await store.ingest(database, JSON.stringify({ role: 'user', parts: [{ text }] }), 'application/vnd.limcode.message+json');
    return [
      row('Message', { id, created_at: NOW, updated_at: NOW, deleted_at: null }),
      row('MessageRevision', { id: revisionId, message_id: id, revision_seq: 1n, role: 'user', content_object_id: content.id, created_at: NOW }),
      row('MessageCurrentRevisionLink', { id: `${id}-current`, message_id: id, revision_id: revisionId, updated_at: NOW }),
      row('MessagePartOfConversation', { id: `${id}-member`, conversation_id: conversationId, message_id: id, message_seq: 1n, created_at: NOW })
    ];
  };
  const fork = async (id) => [
    row('Conversation', { id, title: id, status: 'active', created_at: NOW, updated_at: NOW }),
    ...await userMessage(`${id}-message-a`, `${id}-revision-1`, id, '从这里分支'),
    row('ConversationBranchLink', { id: `${id}-link`, target_conversation_id: id, source_conversation_id: 'source',
      source_message_revision_id: 'revision-1', created_at: NOW })
  ];
  await database.transaction([
    ...['source', 'elsewhere', 'unrelated'].map((id) => row('Conversation', { id, title: id, status: 'active', created_at: NOW, updated_at: NOW })),
    ...await userMessage('message-a', 'revision-1', 'source', '从这里分支'),
    ...await fork('branch'),
    ...await fork('doomed-branch')
  ]);
  const feed = new kernel.BoundedClientFeed(database);
  return {
    database,
    feed,
    async close() {
      feed.close();
      await database.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  };
}

async function until(condition, label) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// Drives the real useChat module through its bridge: host messages go in through the Webview
// message listener, every request the Webview posts is captured, and the Runtime data arrives as the
// frames a real bounded feed sends, acknowledged by the Webview store.
test('useChat 只在本次点击且仍在源对话时打开分支，重放或迟到的结果改为可打开的提示', async (t) => {
  const runtime = await openRuntime();
  const pinia = await import('pinia');
  const { effectScope, nextTick } = await import('vue');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const host = { posted: [], listeners: new Set(), state: undefined };
  /** The feed session of the Webview currently open and the frames it has not observed yet. */
  const view = { store: undefined, sessionId: undefined, inbox: [], delivered: [] };
  globalThis.window = {
    addEventListener(type, listener) { if (type === 'message') host.listeners.add(listener); },
    removeEventListener(_type, listener) { host.listeners.delete(listener); },
    setTimeout, clearTimeout,
    requestAnimationFrame(callback) { return setTimeout(() => callback(Date.now()), 0); },
    cancelAnimationFrame(id) { clearTimeout(id); },
    acquireVsCodeApi() {
      return {
        postMessage(message) {
          const plain = structuredClone(message);
          if (plain?.type === 'reliable-kernel.ack') runtime.feed.acknowledge(plain);
          else host.posted.push(plain);
        },
        getState() { return host.state; },
        setState(value) { host.state = structuredClone(value); }
      };
    }
  };
  let server;
  const scopes = [];
  try {
    server = await createWebviewSsrServer();
    const { BridgeMessageType } = await server.ssrLoadModule(path.join(process.cwd(), 'shared/protocol.ts'));
    const emit = (message) => { for (const listener of [...host.listeners]) listener({ data: message }); };
    const posted = (type) => host.posted.filter((message) => message.type === type);
    const pump = () => {
      while (view.inbox.length > 0) view.store.observe(view.inbox.shift());
    };
    const settled = () => {
      if (view.inbox.length > 0 || !view.sessionId) return false;
      const session = runtime.feed.inspectSession(view.sessionId);
      return session.inflightMessageSeq === null && session.queuedBatches === 0 && !session.snapshotRequired;
    };

    /** A freshly loaded Webview: new module state, bridge and Pinia, with optional persisted state. */
    const openWebview = async (persisted) => {
      server.moduleGraph.invalidateAll();
      delete globalThis.window.__limcodeBridge;
      delete globalThis.window.__limcodeVsCodeApi;
      host.listeners.clear();
      host.posted = [];
      host.state = persisted;
      pinia.setActivePinia(pinia.createPinia());
      const { useChat } = await server.ssrLoadModule('/src/composables/useChat.ts');
      const { useReliableKernelClientFeedStore } = await server.ssrLoadModule('/src/stores/useReliableKernelClientFeedStore.ts');
      if (view.sessionId) runtime.feed.disconnect(view.sessionId);
      Object.assign(view, { store: useReliableKernelClientFeedStore(), sessionId: undefined, inbox: [], delivered: [] });
      const scope = effectScope();
      scopes.push(scope);
      const chat = scope.run(() => useChat());
      /** Shows a Conversation: a new feed session whose snapshot this Webview observes. */
      const show = async (conversationId) => {
        if (view.sessionId) runtime.feed.disconnect(view.sessionId);
        view.inbox = [];
        const connection = await runtime.feed.connect({
          activeConversationId: conversationId,
          send: (message) => {
            view.delivered.push(message);
            view.inbox.push(message);
            queueMicrotask(pump);
          }
        });
        view.sessionId = connection.sessionId;
        await until(settled, `the snapshot of ${conversationId}`);
        await nextTick();
      };
      /** Commits a real Conversation deletion and returns the frame types it reached this view as. */
      const deleteConversation = async (conversationId) => {
        const before = view.delivered.length;
        await new kernel.ConversationDeletionControlPlane(runtime.database).delete(conversationId);
        await until(() => view.delivered.length > before && settled(), `the deletion of ${conversationId}`);
        await nextTick();
        return view.delivered.slice(before).map((message) => message.type);
      };
      return { chat, show, deleteConversation };
    };
    const forkResult = (request, conversationId = 'branch') => ({
      id: `result-${request.id}`, type: BridgeMessageType.ConversationForkResult, channel: 'control', correlationId: request.id,
      payload: { ...request.payload, commandId: request.payload.command.commandId, conversationId, status: 'accepted' }
    });

    await t.test('点击后仍在源对话：打开分支', async () => {
      const { chat, show } = await openWebview();
      await show('source');
      assert.equal(chat.forkConversationFrom('source', 'message-a', 'revision-1'), true);
      const [request] = posted(BridgeMessageType.ConversationFork);
      emit(forkResult(request));
      assert.deepEqual(posted(BridgeMessageType.ConversationOpen).map((message) => message.payload), [{ conversationId: 'branch' }]);
      assert.equal(chat.conversationForkReadyNotice.value, undefined);
    });

    await t.test('点击后已切到别的对话：不拉回，只在源对话提示打开分支', async () => {
      const { chat, show } = await openWebview();
      await show('source');
      chat.forkConversationFrom('source', 'message-a', 'revision-1');
      const [request] = posted(BridgeMessageType.ConversationFork);
      await show('elsewhere');
      emit(forkResult(request));
      assert.deepEqual(posted(BridgeMessageType.ConversationOpen), [], 'the user who moved on is not pulled away');
      assert.equal(chat.conversationForkReadyNotice.value, undefined, 'the notice belongs to the source conversation');
      await show('source');
      assert.deepEqual(chat.conversationForkReadyNotice.value, { sourceConversationId: 'source', conversationId: 'branch', replayed: false });
      chat.openForkReadyNotice();
      assert.deepEqual(posted(BridgeMessageType.ConversationOpen).map((message) => message.payload), [{ conversationId: 'branch' }]);
      assert.equal(chat.conversationForkReadyNotice.value, undefined);
    });

    await t.test('重载后自动重放的旧请求：不跳转，只提示可打开', async () => {
      const command = { commandId: 'fork-command-old', expectedVersion: 0, issuedAt: 1 };
      const payload = { sourceConversationId: 'source', messageId: 'message-a', expectedRevisionId: 'revision-1', command };
      const persisted = { reliableConversationControls: {
        conversationActions: {}, pendingTurnInputs: {}, failedTurnInputs: {},
        forkRequests: { [command.commandId]: {
          actionId: command.commandId, sourceConversationId: 'source', messageId: 'message-a', payload,
          requestId: 'lost-request', sentSessionId: 'session-before-reload'
        } }
      } };
      const { chat, show } = await openWebview(persisted);
      await show('source');
      const replays = posted(BridgeMessageType.ConversationFork);
      assert.equal(replays.length, 1, 'the unconfirmed command is still re-sent to learn its outcome');
      assert.equal(replays[0].payload.command.commandId, command.commandId);
      emit(forkResult(replays[0]));
      assert.deepEqual(posted(BridgeMessageType.ConversationOpen), [], 'a replayed result never navigates by itself');
      assert.deepEqual(chat.conversationForkReadyNotice.value, { sourceConversationId: 'source', conversationId: 'branch', replayed: true });
      chat.dismissForkReadyNotice();
      assert.equal(chat.conversationForkReadyNotice.value, undefined);
    });

    await t.test('分支对话被删除后提示随之消失，不会再打开已删除的对话', async () => {
      const { chat, show, deleteConversation } = await openWebview();
      await show('source');
      chat.forkConversationFrom('source', 'message-a', 'revision-1');
      const [request] = posted(BridgeMessageType.ConversationFork);
      await show('elsewhere');
      emit(forkResult(request, 'doomed-branch'));
      await show('source');
      assert.deepEqual(chat.conversationForkReadyNotice.value, { sourceConversationId: 'source', conversationId: 'doomed-branch', replayed: false });
      assert.deepEqual(await deleteConversation('unrelated'), ['reliable-kernel.changes']);
      assert.ok(chat.conversationForkReadyNotice.value, 'another deletion leaves the notice');
      // A fork always holds copied messages, so its deletion reaches this view as a fresh snapshot,
      // not as a Conversation remove.
      assert.deepEqual(await deleteConversation('doomed-branch'), ['reliable-kernel.snapshot']);
      assert.equal(chat.conversationForkReadyNotice.value, undefined, 'the fork is gone, so is its notice');
      chat.openForkReadyNotice();
      assert.deepEqual(posted(BridgeMessageType.ConversationOpen), [], 'the deleted fork is never opened');
    });

    await t.test('被拒绝的分支显示明确的中文提示，其他失败的提示不与原因矛盾', async () => {
      const { chat, show } = await openWebview();
      await show('source');
      chat.forkConversationFrom('source', 'message-a', 'revision-1');
      let [request] = posted(BridgeMessageType.ConversationFork);
      emit({ id: 'error-1', type: BridgeMessageType.Error, channel: 'diagnostics', correlationId: request.id,
        payload: { requestType: BridgeMessageType.ConversationFork, code: 'fork_rejected', message: '分支点所在的轮次仍在运行，请等待本轮结束后再从这条消息创建分支。' } });
      assert.equal(chat.conversationActionNotice.value, '未创建分支：分支点所在的轮次仍在运行，请等待本轮结束后再从这条消息创建分支。');
      assert.deepEqual([...chat.forkPendingTargetIds.value], []);

      chat.forkConversationFrom('source', 'message-a', 'revision-1');
      request = posted(BridgeMessageType.ConversationFork).at(-1);
      emit({ id: 'error-2', type: BridgeMessageType.Error, channel: 'diagnostics', correlationId: request.id,
        payload: { requestType: BridgeMessageType.ConversationFork, message: 'Fork 源 Message Revision 已变化，请基于当前内容重新创建分支。' } });
      assert.doesNotMatch(chat.conversationActionNotice.value, /重放同一分支命令/);
      assert.match(chat.conversationActionNotice.value, /可再次点击分支按钮/);
    });
  } finally {
    for (const scope of scopes) scope.stop();
    // Let queued timers (for example frame callbacks) drain before the fake Webview disappears.
    await new Promise((resolve) => setTimeout(resolve, 50));
    pinia.setActivePinia(previousPinia);
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    await server?.close();
    await runtime.close();
  }
});
