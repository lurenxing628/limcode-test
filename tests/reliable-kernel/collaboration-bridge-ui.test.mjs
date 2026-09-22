import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import { createPinia, disposePinia } from 'pinia';
import { createSSRApp, reactive } from 'vue';
import { renderToString } from '@vue/server-renderer';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return { window: { async showWarningMessage() {} } };
  return originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });
const root = process.cwd();
const { BridgeMessageType: Type } = require(path.join(root, 'dist/extension/shared/protocol.js'));
const { VscodeReliableKernelCommandRouter: Router } = require(path.join(root, 'dist/extension/backend/application/reliableKernel/VscodeReliableKernelCommandRouter.js'));

function routerFixture() {
  const calls = []; const posted = [];
  const collaboration = {
    async listMembers(id) { calls.push(['list', id]); return { rootConversationId: id, members: [] }; },
    async listMessages(input) { calls.push(['mailbox', input]); return { messages: [], nextCursor: null, olderCursor: null }; },
    async readConversation(input) { calls.push(['readConversation', input]); return { conversationId: input.targetConversationId, title: '目标', status: 'active', messages: [], olderMessageId: null, hasMore: false }; },
    async listPermissions() { return []; }, async listPermissionCandidates() { return []; },
    async send(input) { calls.push(['send', input]); return { messageId: 'message-1' }; },
    async setPermission(input) { calls.push(['permission', input]); return input; }
  };
  const router = new Router({
    debugCapture: { setListener() {} }, toolHost: { setStateChangeListener() {} },
    application: { database: { conversationOwners: { async run(id, operation) { calls.push(['owner', id]); return operation(); } } },
      runtime: { collaboration, collaborationBoard: { async executeUser(identity, args) { calls.push(['board', identity, args]); return { channels: [] }; } } } }
  }, { conversationIdForClient: clientId => clientId === 'client-a' ? 'conversation-a' : undefined });
  const webview = { async postMessage(message) { posted.push(message); return true; } };
  const dispatch = (type, payload) => router.dispatch('client-a', webview, { id: 'request-1', type, channel: 'command', payload });
  return { calls, posted, dispatch };
}

test('协作路由拒绝伪造源对话，不能读取目录或替其他面板授予权限', async () => {
  const { dispatch, calls } = routerFixture();
  await assert.rejects(dispatch(Type.CollaborationGet, { conversationId: 'conversation-b' }), /当前面板/);
  await assert.rejects(dispatch(Type.CollaborationPermissionSet, { conversationId: 'conversation-b', targetConversationId: 'conversation-c', commandId: 'grant', allowRead: true, allowSend: true, allowWake: true }), /当前面板/);
  assert.deepEqual(calls, []);
});

test('读取目标对话仍携带真实源身份，历史分页不混入新消息游标', async () => {
  const { dispatch, calls } = routerFixture();
  await dispatch(Type.CollaborationConversationRead, { conversationId: 'conversation-a', targetConversationId: 'conversation-b', beforeMessageId: 'earliest' });
  assert.deepEqual(calls[0], ['readConversation', { conversationId: 'conversation-a', targetConversationId: 'conversation-b', beforeMessageId: 'earliest', limit: 30 }]);
  await dispatch(Type.CollaborationGet, { conversationId: 'conversation-a', beforeMessageId: 'older' });
  assert.deepEqual(calls.find(call => call[0] === 'mailbox')[1], { conversationId: 'conversation-a', beforeMessageId: 'older', limit: 50 });
});

test('用户发消息保留用户来源、原消息关联并经过源对话owner', async () => {
  const { dispatch, calls, posted } = routerFixture();
  await dispatch(Type.CollaborationSend, { conversationId: 'conversation-a', commandId: 'user-command', targetConversationId: 'conversation-b', text: '继续分析', mode: 'followup', replyToMessageId: 'original-message' });
  assert.deepEqual(calls, [['owner', 'conversation-a'], ['send', {
    source: { kind: 'user', conversationId: 'conversation-a', commandId: 'user-command' }, targetConversationId: 'conversation-b', text: '继续分析', mode: 'followup', replyToMessageId: 'original-message'
  }]]);
  assert.equal(posted[0].type, Type.CollaborationCommandResult);
  assert.equal(posted[0].correlationId, 'request-1');
});

test('留言板调用独立用户API，不伪造turn/tool身份', async () => {
  const { dispatch, calls } = routerFixture();
  await dispatch(Type.CollaborationBoardCommand, { conversationId: 'conversation-a', commandId: 'board-command', operation: 'post', channelId: 'channel', text: '进展' });
  assert.deepEqual(calls, [['owner', 'conversation-a'], ['board', { conversationId: 'conversation-a', commandId: 'board-command' }, { operation: 'post', channelId: 'channel', text: '进展' }]]);
});

async function withStore(run) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const posted = [];
  let messageListener;
  globalThis.window = {
    addEventListener(name, callback) { if (name === 'message') messageListener = callback; }, removeEventListener() {},
    setTimeout, clearTimeout,
    acquireVsCodeApi() { return { postMessage(message) { structuredClone(message); posted.push(message); }, getState() {}, setState() {} }; }
  };
  const server = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  const pinia = createPinia();
  try {
    const { useCollaborationStore } = await server.ssrLoadModule('/src/stores/useCollaborationStore.ts');
    const store = useCollaborationStore(pinia);
    const reply = (request, type, payload) => messageListener({ data: { id: 'response', correlationId: request.id, type, channel: 'state', payload } });
    await run({ store, posted, reply, server, pinia });
  } finally {
    disposePinia(pinia);
    await server.close();
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument;
  }
}

test('store将响应式消息重建成可clone纯数据，错误重试复用命令id', async () => {
  await withStore(async ({ store, posted, reply }) => {
    const input = reactive({ conversationId: 'conversation-a', targetConversationId: 'conversation-b', text: '协作内容', mode: 'message', replyToMessageId: 'original', uiOnly: reactive({ private: '不能发送' }) });
    const first = store.send(input);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].payload.uiOnly, undefined);
    assert.equal(posted[0].payload.replyToMessageId, 'original');
    reply(posted[0], Type.Error, { message: '确认丢失' });
    await assert.rejects(first, /确认丢失/);
    const retry = store.send(input);
    assert.equal(posted[1].payload.commandId, posted[0].payload.commandId);
    reply(posted[1], Type.CollaborationCommandResult, { conversationId: 'conversation-a', messageId: 'saved' });
    await retry;
  });
});

test('store按请求关联和对话校验接收快照，迟到响应不会覆盖其他对话', async () => {
  await withStore(async ({ store, posted, reply }) => {
    const first = store.refresh('conversation-a'); const second = store.refresh('conversation-b');
    const snapshot = id => ({ conversationId: id, rootConversationId: id, members: [], messages: [], permissions: [], permissionCandidates: [], nextCursor: null, olderCursor: null });
    reply(posted[1], Type.CollaborationSnapshot, snapshot('conversation-b'));
    await second;
    reply(posted[0], Type.CollaborationSnapshot, snapshot('conversation-a'));
    await first;
    assert.equal(store.snapshots['conversation-a'].conversationId, 'conversation-a');
    assert.equal(store.snapshots['conversation-b'].conversationId, 'conversation-b');
    const mismatched = store.refresh('conversation-a');
    reply(posted[2], Type.CollaborationSnapshot, snapshot('conversation-c'));
    await assert.rejects(mismatched, /不匹配/);
    assert.equal(store.snapshots['conversation-c'], undefined);
  });
});

test('协作入口SSR可渲染，未绑定对话时禁止发起操作', async () => {
  await withStore(async ({ server, pinia }) => {
    const { default: panel } = await server.ssrLoadModule('/src/components/input/CollaborationPanel.vue');
    globalThis.document = { documentElement: { clientWidth: 1200, clientHeight: 900 } };
    const html = await renderToString(createSSRApp(panel).use(pinia));
    assert.match(html, /协作/);
    assert.match(html, /aria-haspopup="dialog"/);
    assert.match(html, /disabled/);
  });
});
