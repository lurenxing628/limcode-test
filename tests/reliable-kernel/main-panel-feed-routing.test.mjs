import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

// The real extension receives Webview messages only through MainPanel's onDidReceiveMessage. Feed
// tests that call the bridge directly cannot notice a request type the panel sends to the command
// router instead, so this test drives the real panel listener.
const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
class EventEmitter {
  listeners = new Set();
  event = (listener, receiver, disposables) => {
    const bound = receiver ? listener.bind(receiver) : listener;
    this.listeners.add(bound);
    const disposable = { dispose: () => this.listeners.delete(bound) };
    disposables?.push(disposable);
    return disposable;
  };
  fire(value) { for (const listener of [...this.listeners]) listener(value); }
  dispose() { this.listeners.clear(); }
}
class Uri {
  constructor(fsPath) { this.fsPath = fsPath; this.path = fsPath; this.scheme = 'file'; this.authority = ''; }
  static file(fsPath) { return new Uri(fsPath); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.fsPath}`; }
}
let registeredSerializer;
const vscode = {
  Uri, EventEmitter, ViewColumn: { One: 1 }, workspace: { workspaceFolders: [] },
  window: {
    registerWebviewPanelSerializer(_viewType, serializer) {
      registeredSerializer = serializer;
      return { dispose() {} };
    }
  }
};
Module._load = function load(name, parent, isMain) {
  return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { MainPanel } = require(path.join(compiledRoot, 'vscode/panels/MainPanel.js'));
const feedProtocol = require(path.join(compiledRoot, 'shared/reliableKernelClientFeed.js'));
const { ReliableKernelWebviewFeedBridge } = require(path.join(compiledRoot, 'backend/reliableKernel/webviewFeedBridge.js'));

test('MainPanel 把协作历史请求和所有 Feed 控制消息交给可靠 Feed，而不是命令路由', { timeout: 15000 }, async () => {
  const bridge = new ReliableKernelWebviewFeedBridge({}, {});
  const control = [];
  const commands = [];
  let receive;
  const disposed = new EventEmitter();
  const panel = {
    title: 'Limcode Test', visible: true, viewColumn: 1,
    onDidDispose: disposed.event,
    onDidChangeViewState: new EventEmitter().event,
    reveal() {},
    dispose() { disposed.fire(); disposed.dispose(); },
    webview: {
      options: {}, cspSource: 'vscode-webview:', html: '',
      asWebviewUri: (uri) => uri,
      onDidReceiveMessage(listener, receiver, disposables) {
        receive = receiver ? listener.bind(receiver) : listener;
        const disposable = { dispose() { receive = undefined; } };
        disposables?.push(disposable);
        return disposable;
      }
    }
  };
  const facade = {
    waitUntilHydrated: async () => {},
    conversationExists: async () => true,
    getConversationDisplayTitle: () => '协作对话',
    retainConversation: async () => {},
    releaseConversation: async () => {},
    attachWebview: () => 'panel-client',
    setWebviewVisible() {},
    detachWebview() {},
    handleReliableKernelControl(clientId, message) {
      const handled = bridge.handleControl(clientId, message);
      control.push({ type: message.type, handled });
      return handled;
    },
    handleWebviewMessage(_clientId, message) { commands.push(message.type); }
  };
  try {
    MainPanel.registerSerializer({ subscriptions: [], extensionUri: Uri.file(process.cwd()) }, { wait: async () => facade });
    await registeredSerializer.deserializeWebviewPanel(panel, { conversationId: 'conversation' });
    assert.equal(typeof receive, 'function', 'the restored chat panel must listen for Webview messages');

    // Exactly what the Webview store posts to bootstrap and page collaboration history.
    receive({
      type: feedProtocol.RELIABLE_KERNEL_COLLABORATION_HISTORY_REQUEST_MESSAGE,
      requestId: 'collaboration-request', sessionId: 'session', conversationId: 'conversation', limit: 50
    });
    assert.deepEqual(control.map((entry) => entry.type), [feedProtocol.RELIABLE_KERNEL_COLLABORATION_HISTORY_REQUEST_MESSAGE]);
    assert.equal(await control[0].handled, true, 'the Feed bridge must own the collaboration history request');
    assert.deepEqual(commands, [], 'a Feed request that reaches the command router is never answered');

    // Every Webview→Host message type the protocol declares (requests, ACKs, diagnostics) must be
    // routed the same way, and the bridge must claim each one.
    const outgoing = Object.entries(feedProtocol)
      .filter(([name, value]) => typeof value === 'string' && /_(?:REQUEST|ACK|DIAGNOSTIC)_MESSAGE$/.test(name))
      .map(([, value]) => value);
    assert.ok(outgoing.length >= 8);
    assert.deepEqual([...outgoing].sort(), [...feedProtocol.RELIABLE_KERNEL_CONTROL_MESSAGE_TYPES].sort());
    control.length = 0;
    for (const type of outgoing) receive({ type });
    assert.deepEqual(control.map((entry) => entry.type), outgoing);
    for (const entry of control) assert.equal(await entry.handled, true, `${entry.type} must be claimed by the Feed bridge`);
    assert.deepEqual(commands, []);

    receive({ type: 'conversation.settings.get', payload: {} });
    assert.deepEqual(commands, ['conversation.settings.get'], 'ordinary bridge messages still reach the command router');
  } finally {
    panel.dispose();
  }
});
