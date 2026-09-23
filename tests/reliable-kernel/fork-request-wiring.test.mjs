import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

// Drives the real useChat module through its bridge: host messages go in through the Webview
// message listener and every request the Webview posts is captured.
test('useChat 只在本次点击且仍在源对话时打开分支，重放或迟到的结果改为可打开的提示', async (t) => {
  const { createServer } = await import('vite');
  const pinia = await import('pinia');
  const { effectScope, nextTick } = await import('vue');
  const previousPinia = pinia.getActivePinia();
  const previousWindow = globalThis.window;
  const host = { posted: [], listeners: new Set(), state: undefined };
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
  const server = await createServer({
    configFile: path.join(process.cwd(), 'vite.config.ts'),
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'error'
  });
  const scopes = [];
  try {
    const { BridgeMessageType } = await server.ssrLoadModule(path.join(process.cwd(), 'shared/protocol.ts'));
    const emit = (message) => { for (const listener of [...host.listeners]) listener({ data: message }); };
    const posted = (type) => host.posted.filter((message) => message.type === type);

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
      const feed = useReliableKernelClientFeedStore();
      const scope = effectScope();
      scopes.push(scope);
      const chat = scope.run(() => useChat());
      let seq = 0;
      const show = async (conversationId) => {
        seq += 1;
        feed.observe({
          type: 'reliable-kernel.snapshot', sessionId: `session-${conversationId}-${seq}`, hostBootId: 'boot',
          messageSeq: '1', snapshotCommitSeq: '1', projections: { activeConversationWindow: { conversationId } }
        });
        await nextTick();
      };
      return { chat, show };
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
    await server.close();
  }
});
