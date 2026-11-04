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
  const calls = { attached: [], visible: [], detached: [], messages: [], controls: [], created: [], pages: [] };
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
    folders: [{ uri: 'file:///project-a', name: 'project-a', index: 0 }, { uri: 'file:///project-b', name: 'project-b', index: 1 }],
    getProjectFolderCandidates() { return this.folders; },
    async getConversationHistoryPage(input) {
      calls.pages.push(input);
      return {
        scope: { kind: 'all' },
        originLinks: [],
        pageInfo: { limit: input.limit, hasNext: true, nextCursor: 'next-page', total: 3 },
        entries: [
          { id: 'open-a', title: '已打开', updatedAt: 3, isRunning: true, projectFolderUri: 'file:///project-a', projectName: 'project-a' },
          { id: 'history-b', title: '', updatedAt: 2, isRunning: false, runStatusLabel: '等待上级', projectFolderUri: 'file:///closed', projectName: 'closed' },
          { id: 'unbound-c', title: '未绑定', updatedAt: 1, isRunning: false }
        ]
      };
    }
  };
}

async function waitFor(condition) {
  for (let attempt = 0; !condition(); attempt++) {
    if (attempt > 200) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
    openConversation: async (conversationId) => { opened.push(conversationId); },
    waiting: () => undefined
  });
  const port = await server.start(0, '127.0.0.1');
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${port}`;

  const index = await (await fetch(`${base}/`)).text();
  assert.match(index, /acquireVsCodeApi/);
  assert.match(index, /__limcode_sse/);
  assert.match(index, /"open-a"/);
  assert.match(index, /--vscode-editor-background/);
  assert.ok(index.indexOf('height: var(--limcode-app-height') > index.indexOf('<title>'), '布局样式排在应用样式之后');
  assert.equal(await (await fetch(`${base}/assets/main.js`)).text(), 'console.log(1)');
  assert.equal((await fetch(`${base}/..%2Flan-mobile-outside.txt`)).status, 404);

  const status = await (await fetch(`${base}/__limcode_status`)).json();
  assert.deepEqual(status.conversations, [
    { id: 'open-a', title: '已打开', isOpen: true, updatedAt: 3, projectName: 'project-a', statusLabel: '运行中', foreign: false },
    { id: 'history-b', title: 'history-b', isOpen: false, updatedAt: 2, projectName: 'closed', statusLabel: '等待上级', foreign: true },
    { id: 'unbound-c', title: '未绑定', isOpen: false, updatedAt: 1, foreign: false }
  ]);
  assert.equal(status.nextCursor, 'next-page');
  assert.equal(status.total, 3);
  assert.deepEqual(status.folders, [{ uri: 'file:///project-a', name: 'project-a' }, { uri: 'file:///project-b', name: 'project-b' }]);
  assert.deepEqual(status.scope, { kind: 'currentProject' }, '默认只看当前项目');
  assert.deepEqual(application.calls.pages.at(-1), { scopeKind: 'currentProject', limit: 50 });

  const statusFor = async (query) => (await (await fetch(`${base}/__limcode_status?${query}`)).json()).scope;
  assert.deepEqual(await statusFor('scope=all&cursor=c2'), { kind: 'all' });
  assert.deepEqual(application.calls.pages.at(-1), { scopeKind: 'all', cursor: 'c2', limit: 50 });
  assert.deepEqual(await statusFor('scope=unbound'), { kind: 'unbound' });
  assert.deepEqual(await statusFor('scope=project&folder=file%3A%2F%2F%2Fproject-b'), { kind: 'project', folderUri: 'file:///project-b' });
  assert.deepEqual(application.calls.pages.at(-1), { scopeKind: 'project', projectFolderUri: 'file:///project-b', limit: 50 });
  assert.deepEqual(await statusFor('scope=project&folder=file%3A%2F%2F%2Fgone'), { kind: 'currentProject' }, '记住的项目不在这个窗口时退回当前项目');
  const allFolders = application.folders;
  application.folders = [];
  assert.deepEqual(await statusFor(''), { kind: 'all' }, '窗口没有打开文件夹时看全部');
  application.folders = allFolders;

  // 读取失败要把原因带给页面，不能返回一个空列表。
  const readPage = application.getConversationHistoryPage;
  application.getConversationHistoryPage = async () => { throw new Error('读取历史失败'); };
  const failed = await fetch(`${base}/__limcode_status`);
  assert.equal(failed.status, 500);
  assert.equal(await failed.text(), '读取历史失败');
  application.getConversationHistoryPage = readPage;

  // 只有属于这个窗口的项目才带给新建；其它情况走默认项目，避免后端因项目不在工作区而报错。
  const createIn = (query) => fetch(`${base}/__limcode_new${query}`, { method: 'POST' }).then((response) => response.json());
  assert.deepEqual(await createIn('?folder=file%3A%2F%2F%2Fproject-b'), { conversationId: 'created-conversation' });
  assert.deepEqual(application.calls.created.at(-1), { projectFolderUri: 'file:///project-b' });
  assert.deepEqual(await createIn('?folder=file%3A%2F%2F%2Fgone'), { conversationId: 'created-conversation' });
  assert.deepEqual(application.calls.created.at(-1), {});
  assert.deepEqual(await createIn(''), { conversationId: 'created-conversation' });
  assert.deepEqual(application.calls.created.at(-1), {});
  assert.deepEqual(opened.splice(0), ['created-conversation', 'created-conversation', 'created-conversation']);

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

  // 断线时桌面端像面板被隐藏那样暂停推送，期间的消息排队，不写进断掉的连接；
  // 重连后补发排队的消息，并让桌面端像面板重新显示那样重发完整状态。
  await waitFor(() => application.calls.visible.length === 2);
  assert.deepEqual(application.calls.visible, [['client-1', true], ['client-1', false]]);
  application.webviews.get('client-1').postMessage({ type: 'offline', n: 3 });
  const replay = readFrames(await fetch(`${base}/__limcode_sse${query}`), 1);
  assert.deepEqual(await replay, [{ type: 'offline', n: 3 }]);
  assert.deepEqual(application.calls.visible.slice(2, 4), [['client-1', false], ['client-1', true]]);
  assert.equal(application.calls.attached.length, 1, '重连接回原会话');

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

test('手机访问：运行时没启动好时说明原因，桌面没打开对话时按当前项目选一个', async (t) => {
  const application = fakeApplication();
  const pages = [];
  application.getConversationHistoryPage = async (input) => {
    pages.push(input);
    return { scope: { kind: input.scopeKind }, originLinks: [], entries: application.emptyHistory ? [] : [{ id: 'recent', title: '最近' }], pageInfo: { limit: 1, hasNext: false, total: 1 } };
  };
  let ready;
  let startupResult = new Promise((resolve, reject) => { ready = { resolve, reject }; });
  let waiting = { title: '正在等待另一个窗口', description: '它正在合并旧数据' };
  let active;
  const opened = [];
  const server = new LanMobileAccessServer({
    application: () => startupResult,
    webviewRoot: os.tmpdir(),
    workspaceName: () => '工作区',
    activeConversationId: () => active,
    openConversations: () => [],
    openConversation: async (conversationId) => { opened.push(conversationId); },
    waiting: () => waiting
  });
  const base = `http://127.0.0.1:${await server.start(0, '127.0.0.1')}`;
  t.after(() => server.stop());
  const startup = async () => (await fetch(`${base}/__limcode_startup`)).json();
  const land = async () => (await fetch(`${base}/__limcode_landing`, { method: 'POST' })).json();

  assert.deepEqual(await startup(), { ready: false, waiting }, '还在启动时马上返回，不等运行时');
  waiting = undefined;
  assert.deepEqual(await startup(), { ready: false });
  ready.resolve(application);
  assert.deepEqual(await startup(), { ready: true });

  assert.equal((await fetch(`${base}/__limcode_landing`)).status, 404, '只接受 POST，避免预取时新建对话');
  assert.deepEqual(await land(), { conversationId: 'recent' });
  assert.deepEqual(pages.at(-1), { scopeKind: 'currentProject', limit: 1 });
  application.folders = [];
  await land();
  assert.deepEqual(pages.at(-1), { scopeKind: 'unbound', limit: 1 }, '窗口没打开文件夹时不进入其它项目的对话');
  application.emptyHistory = true;
  assert.deepEqual(await land(), { conversationId: 'created-conversation' }, '没有对话就新建');
  assert.equal(application.calls.created.length, 1);
  active = 'desktop-active';
  assert.deepEqual(await land(), { conversationId: 'desktop-active' }, '桌面已打开对话时进入它');
  assert.deepEqual(opened, ['recent', 'recent', 'created-conversation', 'desktop-active'], '进入的对话由这个窗口接管');

  startupResult = Promise.reject(new Error('数据目录不可用'));
  startupResult.catch(() => undefined);
  assert.deepEqual(await startup(), { ready: false, error: '数据目录不可用' });
});

test('远程访问开关：状态栏常驻，设置页开关后状态栏跟着变并记住，状态回传给设置页', async (t) => {
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

  // 窗口启动时状态栏就有开关，但默认不监听。
  await restoreLanMobileAccess(context, startup);
  assert.equal(statusItems.length, 1);
  assert.ok(statusItems[0].shown);
  assert.equal(statusItems[0].text, '$(remote) 远程访问：关');
  assert.equal(statusItems[0].command, 'limcode-test.lanMobileAccess', '点一下就开启');
  assert.ok(context.subscriptions.includes(statusItems[0]), '窗口关闭时一起释放');

  await lanMobileAccessCommand(context, startup, { clientId: 'settings-1' });
  assert.deepEqual(posted.map(([clientId, message]) => [clientId, message.type, message.channel]), [['settings-1', 'lanMobileAccess.state', 'settings']]);
  assert.deepEqual(lastState(), { enabled: false, urls: [] });
  assert.equal(stored.get('lanMobileAccess.enabled'), undefined, '默认关闭：读取状态不会开启');

  await lanMobileAccessCommand(context, startup, { clientId: 'settings-1', enabled: true });
  assert.equal(lastState().enabled, true);
  assert.match(lastState().urls[0], /^http:\/\/[\d.]+:\d+$/);
  const port = Number(new URL(lastState().urls[0]).port);
  assert.equal((await fetch(`http://127.0.0.1:${port}/missing.js`)).status, 404, '已在监听');
  assert.equal(stored.get('lanMobileAccess.enabled'), true);
  assert.equal(statusItems.length, 1, '开关复用同一个状态栏项');
  assert.equal(statusItems[0].text, `$(remote) 远程访问 :${port}`);

  // 再开一次不会重复监听；另一个设置页随后也能收到变化。
  await lanMobileAccessCommand(context, startup, { clientId: 'gone' });
  await restoreLanMobileAccess(context, startup);
  assert.equal(statusItems.length, 1);

  posted.length = 0;
  await lanMobileAccessCommand(context, startup, { clientId: 'settings-1', enabled: false });
  assert.deepEqual(posted.map(([clientId]) => clientId), ['settings-1'], '已关闭的设置页不再收到状态');
  assert.deepEqual(lastState(), { enabled: false, urls: [] });
  assert.equal(stored.get('lanMobileAccess.enabled'), false);
  assert.equal(statusItems[0].text, '$(remote) 远程访问：关', '关闭后状态栏留着，可以再点开');
  assert.equal(statusItems.length, 1);
  assert.equal(statusItems[0].disposed, false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/missing.js`));

  // 状态栏点击不带参数：关着时直接开启，再给出地址。
  const notices = [];
  vscode.window.showInformationMessage = async (message) => { notices.push(message); return undefined; };
  t.after(() => { delete vscode.window.showInformationMessage; });
  await lanMobileAccessCommand(context, startup);
  assert.equal(stored.get('lanMobileAccess.enabled'), true);
  assert.match(statusItems[0].text, /^\$\(remote\) 远程访问 :\d+$/);
  assert.match(notices[0], /远程访问已开启：http:\/\//);
});
