import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;

class EventEmitter {
  listeners = new Set();
  event = (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}

const statusItems = [];
const vscode = {
  EventEmitter,
  Uri: { file: (fsPath) => ({ fsPath }), joinPath: (base, ...parts) => ({ fsPath: path.join(base.fsPath, ...parts) }) },
  ViewColumn: { One: 1 },
  StatusBarAlignment: { Right: 2 },
  workspace: { workspaceFolders: [], name: '工作区' },
  commands: { executeCommand: async () => undefined },
  window: {
    createStatusBarItem() {
      const item = { shown: false, disposed: false, show() { this.shown = true; }, dispose() { this.disposed = true; } };
      statusItems.push(item);
      return item;
    }
  }
};
Module._load = function load(name, parent, isMain) {
  return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { LanMobileAccessServer, lanMobileAccessCommand, restoreLanMobileAccess } = require(path.join(compiledRoot, 'vscode/lanMobileAccess.js'));
const { RELIABLE_KERNEL_ACK_MESSAGE } = require(path.join(compiledRoot, 'shared/reliableKernelClientFeed.js'));

function fakeApplication() {
  const calls = { attached: [], visible: [], detached: [], messages: [], controls: [], created: [] };
  const webviews = new Map();
  return {
    calls,
    webviews,
    attachWebview(webview, meta) {
      const clientId = `client-${calls.attached.length + 1}`;
      calls.attached.push(meta);
      webviews.set(clientId, webview);
      return clientId;
    },
    setWebviewVisible(clientId, visible) { calls.visible.push([clientId, visible]); },
    detachWebview(clientId) { calls.detached.push(clientId); },
    handleWebviewMessage(clientId, message) { calls.messages.push([clientId, message]); },
    handleReliableKernelControl(clientId, message) { calls.controls.push([clientId, message]); return true; },
    async createConversation(options) { calls.created.push(options); return 'created-conversation'; },
    getConversationDisplayTitle(conversationId) { return conversationId ? `标题 ${conversationId}` : '新对话'; },
    getConversationHistoryEntries() { return [{ id: 'open-a', title: '已打开' }, { id: 'history-b', title: '历史对话' }]; }
  };
}

async function readFrames(response, count) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const frames = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    let end;
    while ((end = text.indexOf('\n\n')) >= 0) {
      const block = text.slice(0, end);
      text = text.slice(end + 2);
      if (block.startsWith('data: ')) frames.push(JSON.parse(block.slice(6)));
    }
  }
  await reader.cancel();
  return frames;
}

test('手机访问：页面注入桥接脚本，SSE 下发后端消息，POST 上行按面板规则路由', async (t) => {
  const webviewRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lan-mobile-'));
  t.after(() => fs.rm(webviewRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(webviewRoot, 'assets'));
  await fs.writeFile(path.join(webviewRoot, 'index.html'), '<!doctype html><html><head><title>x</title></head><body><div id="app"></div></body></html>');
  await fs.writeFile(path.join(webviewRoot, 'assets', 'main.js'), 'console.log(1)');
  await fs.writeFile(path.join(os.tmpdir(), 'lan-mobile-outside.txt'), 'secret');

  const application = fakeApplication();
  const opened = [];
  const server = new LanMobileAccessServer({
    application: async () => application,
    webviewRoot,
    workspaceName: () => '工作区',
    activeConversationId: () => 'open-a',
    openConversations: () => ['open-a'],
    openConversation: async (conversationId) => { opened.push(conversationId); }
  });
  const port = await server.start(0, '127.0.0.1');
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${port}`;

  const index = await (await fetch(`${base}/`)).text();
  assert.match(index, /acquireVsCodeApi/);
  assert.match(index, /__limcode_sse/);
  assert.match(index, /"open-a"/);
  assert.match(index, /--vscode-editor-background/);
  assert.equal(await (await fetch(`${base}/assets/main.js`)).text(), 'console.log(1)');
  assert.equal((await fetch(`${base}/..%2Flan-mobile-outside.txt`)).status, 404);

  const status = await (await fetch(`${base}/__limcode_status`)).json();
  assert.deepEqual(status.conversations, [
    { id: 'open-a', title: '标题 open-a', isOpen: true },
    { id: 'history-b', title: '历史对话', isOpen: false }
  ]);

  // 首条上行消息先于 SSE 建立会话：期间的下行消息排队，连上后补发。
  const query = '?sid=phone-1&cid=open-a';
  const post = (body) => fetch(`${base}/__limcode_msg${query}`, { method: 'POST', body: JSON.stringify(body) }).then((response) => response.json());
  assert.deepEqual(await post({ type: 'webview.ready', id: 'm1' }), { ok: true });
  assert.equal(application.calls.attached.length, 1);
  assert.deepEqual(application.calls.attached[0], { kind: 'mainPanel', panelId: 'mobile-phone-1', title: '标题 open-a', conversationId: 'open-a' });
  assert.deepEqual(application.calls.visible, [['client-1', true]]);
  assert.deepEqual(application.calls.messages, [['client-1', { type: 'webview.ready', id: 'm1' }]]);
  application.webviews.get('client-1').postMessage({ type: 'queued', n: 1 });

  const stream = await fetch(`${base}/__limcode_sse${query}`);
  assert.equal(stream.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const frames = readFrames(stream, 2);
  application.webviews.get('client-1').postMessage({ type: 'live', n: 2 });
  assert.deepEqual(await frames, [{ type: 'queued', n: 1 }, { type: 'live', n: 2 }]);
  assert.equal(application.calls.attached.length, 1, '同一个 sid 复用同一个会话');

  assert.deepEqual(await post({ type: 'conversation.open', id: 'm2', payload: { conversationId: 'history-b' } }), { ok: true, redirectCid: 'history-b' });
  assert.deepEqual(await post({ type: 'conversation.create', id: 'm3', payload: {} }), { ok: true, redirectCid: 'created-conversation' });
  assert.deepEqual(opened, ['history-b', 'created-conversation']);
  assert.equal(application.calls.messages.length, 1, '打开和新建对话不交给后端消息处理');

  const control = { type: RELIABLE_KERNEL_ACK_MESSAGE, feedEpoch: 'e', ackedSequence: 1 };
  assert.deepEqual(await post(control), { ok: true });
  assert.deepEqual(application.calls.controls, [['client-1', control]]);
  assert.equal(application.calls.messages.length, 1, '回执走控制通道');

  server.stop();
  assert.deepEqual(application.calls.detached, ['client-1']);
  assert.equal(server.listening, false);
});

test('远程访问开关：设置页开启后出现状态栏项并记住，关闭后撤下，状态回传给设置页', async (t) => {
  const stored = new Map();
  const context = {
    extensionUri: { fsPath: os.tmpdir() },
    subscriptions: [],
    workspaceState: { get: (key) => stored.get(key), update: async (key, value) => { stored.set(key, value); } }
  };
  const posted = [];
  const host = { postToWebview(clientId, message) { posted.push([clientId, message]); return clientId !== 'gone'; } };
  const startup = { current: () => host, wait: async () => host };
  const lastState = () => posted.at(-1)[1].payload;
  t.after(() => lanMobileAccessCommand(context, startup, { clientId: 'cleanup', enabled: false }));

  await lanMobileAccessCommand(context, startup, { clientId: 'settings-1' });
  assert.deepEqual(posted.map(([clientId, message]) => [clientId, message.type, message.channel]), [['settings-1', 'lanMobileAccess.state', 'settings']]);
  assert.deepEqual(lastState(), { enabled: false, urls: [] });
  assert.equal(statusItems.length, 0, '默认关闭：读取状态不会开启');

  await lanMobileAccessCommand(context, startup, { clientId: 'settings-1', enabled: true });
  assert.equal(lastState().enabled, true);
  assert.match(lastState().urls[0], /^http:\/\/[\d.]+:\d+$/);
  const port = Number(new URL(lastState().urls[0]).port);
  assert.equal((await fetch(`http://127.0.0.1:${port}/missing.js`)).status, 404, '已在监听');
  assert.equal(stored.get('lanMobileAccess.enabled'), true);
  assert.equal(statusItems.length, 1);
  assert.ok(statusItems[0].shown);
  assert.match(statusItems[0].text, /远程访问/);
  assert.equal(statusItems[0].command, 'limcode-test.lanMobileAccess');

  // 再开一次不会重复监听；另一个设置页随后也能收到变化。
  await lanMobileAccessCommand(context, startup, { clientId: 'gone' });
  await restoreLanMobileAccess(context, startup);
  assert.equal(statusItems.length, 1);

  posted.length = 0;
  await lanMobileAccessCommand(context, startup, { clientId: 'settings-1', enabled: false });
  assert.deepEqual(posted.map(([clientId]) => clientId), ['settings-1'], '已关闭的设置页不再收到状态');
  assert.deepEqual(lastState(), { enabled: false, urls: [] });
  assert.equal(stored.get('lanMobileAccess.enabled'), false);
  assert.ok(statusItems[0].disposed);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/missing.js`));
});
