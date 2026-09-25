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
  event = (listener, receiver, disposables) => {
    const bound = receiver ? listener.bind(receiver) : listener;
    this.listeners.add(bound);
    const disposable = { dispose: () => this.listeners.delete(bound) };
    disposables?.push(disposable);
    return disposable;
  };
  fire(value) { for (const listener of this.listeners) listener(value); }
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
const { RootAuthority } = require(path.join(compiledRoot, 'backend/reliableKernel/rootAuthority.js'));
const { initializeEmptyRuntimeRoot } = require(path.join(compiledRoot, 'backend/reliableKernel/runtimeDatabase.js'));
const { ConversationRuntimeOwnerManager } = require(path.join(compiledRoot, 'backend/reliableKernel/ConversationRuntimeOwnerManager.js'));

test('另一宿主主持对话时，恢复面板仍可查看已提交事实，关闭面板不影响对方所有权', { timeout: 15000 }, async () => {
  const fixture = await createFixture();
  const panel = createPanel();
  const attachedClients = new Set();
  let recoveryAttempted = false;
  let finishRecovery;
  const recoverySettled = new Promise(resolve => { finishRecovery = resolve; });
  try {
    await fixture.peer.claim('restored-conversation');
    const facade = createFacade({
      attachWebview() { attachedClients.add('restored-client'); return 'restored-client'; },
      detachWebview(id) { attachedClients.delete(id); },
      recoverConversation(id) {
        recoveryAttempted = true;
        return fixture.owner.run(id, async () => {}).finally(finishRecovery);
      }
    });
    MainPanel.registerSerializer({ subscriptions: [], extensionUri: Uri.file(fixture.directory) }, {
      wait: async () => facade
    });
    await registeredSerializer.deserializeWebviewPanel(panel, { conversationId: 'restored-conversation' });
    await recoverySettled;
    assert.deepEqual([...attachedClients], ['restored-client']);
    assert.equal(typeof panel.receiveMessage, 'function', '被动面板应照常接收 Feed 和命令');
    assert.equal(recoveryAttempted, true, '打开面板仍应尝试死宿主恢复');
    assert.equal(fixture.peer.owns('restored-conversation'), true);
    panel.dispose();
    assert.equal(attachedClients.size, 0);
    assert.equal(fixture.peer.owns('restored-conversation'), true, '被动面板关闭不得释放对方 owner');
    assert.equal(await fixture.peer.releaseIfIdle('restored-conversation'), true);
    assert.equal(await fixture.owner.tryClaim('restored-conversation'), true);
  } finally {
    panel.dispose();
    await fixture.close();
  }
});

test('另一宿主运行中仍可从历史打开聊天，重复打开只聚焦本窗口面板', { timeout: 15000 }, async () => {
  const fixture = await createFixture();
  const panel = createPanel();
  const created = [];
  let finishRecovery;
  const recoverySettled = new Promise(resolve => { finishRecovery = resolve; });
  vscode.window.createWebviewPanel = () => { created.push(panel); return panel; };
  try {
    await fixture.peer.claim('live-peer-conversation');
    const facade = createFacade({
      recoverConversation: id => fixture.owner.run(id, async () => {}).finally(finishRecovery)
    });
    const options = { kind: 'chat', conversationId: 'live-peer-conversation', reuse: true };
    await MainPanel.createOrShow(Uri.file(fixture.directory), facade, options);
    await recoverySettled;
    assert.equal(created.length, 1, '活跃 peer 不得阻止本地创建被动聊天视图');
    assert.equal(typeof panel.receiveMessage, 'function');
    assert.equal(fixture.owner.owns(options.conversationId), false);
    assert.equal(fixture.peer.owns(options.conversationId), true);
    await MainPanel.createOrShow(Uri.file(fixture.directory), facade, options);
    assert.equal(created.length, 1, '同窗口重复打开只应聚焦现有聊天');
    assert.equal(panel.reveals, 1);
  } finally {
    delete vscode.window.createWebviewPanel;
    panel.dispose();
    await fixture.close();
  }
});

for (const failureStage of ['attach', 'render']) {
  test(`恢复面板在 ${failureStage} 失败后不会占有对话`, { timeout: 15000 }, async () => {
    const fixture = await createFixture();
    const panel = createPanel();
    const attachedClients = new Set();
    let recoveryAttempted = false;
    try {
      const injectedFailure = new Error(`Webview ${failureStage} failed`);
      const facade = createFacade({
        recoverConversation() { recoveryAttempted = true; return Promise.resolve(); },
        attachWebview() {
          if (failureStage === 'attach') throw injectedFailure;
          attachedClients.add('restored-client');
          panel.failNextHtml = injectedFailure;
          return 'restored-client';
        },
        detachWebview(id) { attachedClients.delete(id); }
      });
      MainPanel.registerSerializer({ subscriptions: [], extensionUri: Uri.file(fixture.directory) }, {
        wait: async () => facade
      });
      await registeredSerializer.deserializeWebviewPanel(panel, { conversationId: `failed-${failureStage}` });
      assert.equal(attachedClients.size, 0, '失败后必须清理 Feed 连接');
      assert.equal(recoveryAttempted, false, '面板初始化失败不应启动运行恢复');
      assert.equal(await fixture.peer.tryClaim(`failed-${failureStage}`), true);
    } finally {
      panel.dispose();
      await fixture.close();
    }
  });
}

test('恢复排队时面板已关闭，不建立 Feed 或恢复会话', { timeout: 15000 }, async () => {
  const fixture = await createFixture();
  const panel = createPanel();
  let resumeStartup;
  const gate = new Promise(resolve => { resumeStartup = resolve; });
  let recovered = false;
  try {
    const facade = createFacade({
      recoverConversation() { recovered = true; return Promise.resolve(); },
      attachWebview() { assert.fail('已关闭的面板不得建立 Feed'); }
    });
    MainPanel.registerSerializer({ subscriptions: [], extensionUri: Uri.file(fixture.directory) }, {
      wait: async () => { await gate; return facade; }
    });
    const restoration = registeredSerializer.deserializeWebviewPanel(panel, { conversationId: 'restored-conversation' });
    panel.dispose();
    resumeStartup();
    await restoration;
    assert.equal(recovered, false);
    assert.equal(await fixture.peer.tryClaim('restored-conversation'), true);
  } finally {
    resumeStartup();
    panel.dispose();
    await fixture.close();
  }
});

function createFacade(overrides = {}) {
  return {
    waitUntilHydrated: async () => {},
    conversationExists: async () => true,
    getConversationDisplayTitle: () => '恢复的对话',
    recoverConversation: async () => {},
    attachWebview: () => 'restored-client',
    setWebviewVisible() {},
    detachWebview() {},
    handleReliableKernelControl: async () => true,
    handleWebviewMessage() {},
    ...overrides
  };
}

function createPanel() {
  const disposed = new EventEmitter();
  const changedView = new EventEmitter();
  const received = new EventEmitter();
  let isDisposed = false;
  const panel = {
    title: '恢复的对话', visible: true, viewColumn: 1, failNextHtml: undefined, reveals: 0,
    reveal() { panel.reveals += 1; },
    onDidDispose: disposed.event,
    onDidChangeViewState: changedView.event,
    dispose() {
      if (isDisposed) return;
      isDisposed = true;
      disposed.fire();
      disposed.dispose();
    },
    receiveMessage(message) { received.fire(message); },
    webview: {
      options: {}, cspSource: 'vscode-webview:',
      asWebviewUri: uri => uri,
      onDidReceiveMessage: received.event,
      set html(_value) {
        if (!panel.failNextHtml) return;
        const error = panel.failNextHtml;
        panel.failNextHtml = undefined;
        throw error;
      }
    }
  };
  return panel;
}

async function createFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-panel-owner-'));
  const authority = new RootAuthority(() => path.join(directory, 'control', 'active'));
  const binding = await initializeEmptyRuntimeRoot(authority);
  const owner = new ConversationRuntimeOwnerManager(binding, 'restoring-window');
  const peer = new ConversationRuntimeOwnerManager(binding, 'peer-window');
  owner.setPendingWorkProbe(async () => false);
  peer.setPendingWorkProbe(async () => false);
  return { directory, owner, peer, async close() {
    await Promise.all([owner.close(), peer.close()]);
    await fs.rm(directory, { recursive: true, force: true });
  } };
}
