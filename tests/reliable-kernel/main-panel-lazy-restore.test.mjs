import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import { createRequire } from 'node:module';

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
  fire(value) {
    for (const listener of [...this.listeners]) listener(value);
  }
  dispose() {
    this.listeners.clear();
  }
}

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
    this.path = fsPath;
    this.scheme = 'file';
    this.authority = '';
  }
  static file(fsPath) { return new Uri(fsPath); }
  static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
  toString() { return `file://${this.fsPath}`; }
}

let registeredSerializer;
const createdPanels = [];
const warnings = [];

function createMockPanel({
  title = '恢复的对话',
  visible = false,
  active = false,
  viewColumn = 1,
  revealSetsVisible = false,
  revealFiresViewState = false
} = {}) {
  const disposed = new EventEmitter();
  const changedView = new EventEmitter();
  const received = new EventEmitter();
  let isDisposed = false;
  let currentHtml = '';
  let currentOptions = {};
  const htmlWrites = [];
  const optionsWrites = [];

  const panel = {
    title,
    visible,
    active,
    viewColumn,
    failNextHtml: undefined,
    reveals: 0,
    htmlWrites,
    optionsWrites,
    get isDisposed() { return isDisposed; },
    get viewStateListenerCount() { return changedView.listeners.size; },
    get messageListenerCount() { return received.listeners.size; },
    reveal(column) {
      panel.reveals += 1;
      if (column !== undefined) panel.viewColumn = column;
      if (revealSetsVisible) {
        panel.visible = true;
        panel.active = true;
        if (revealFiresViewState) {
          changedView.fire({ webviewPanel: panel });
        }
      }
    },
    setVisible(nextVisible, nextActive = nextVisible) {
      panel.visible = nextVisible;
      panel.active = nextActive;
      changedView.fire({ webviewPanel: panel });
    },
    onDidDispose: disposed.event,
    onDidChangeViewState: changedView.event,
    dispose() {
      if (isDisposed) return;
      isDisposed = true;
      disposed.fire();
      disposed.dispose();
      changedView.dispose();
      received.dispose();
    },
    receiveMessage(message) {
      received.fire(message);
    },
    webview: {
      cspSource: 'vscode-webview:',
      asWebviewUri: uri => uri,
      onDidReceiveMessage: received.event,
      get options() {
        return currentOptions;
      },
      set options(value) {
        optionsWrites.push(value);
        currentOptions = value;
      },
      get html() {
        return currentHtml;
      },
      set html(value) {
        if (panel.failNextHtml) {
          const error = panel.failNextHtml;
          panel.failNextHtml = undefined;
          throw error;
        }
        htmlWrites.push(value);
        currentHtml = value;
      }
    }
  };
  return panel;
}

const vscode = {
  Uri,
  EventEmitter,
  ViewColumn: { One: 1, Two: 2 },
  workspace: { workspaceFolders: [] },
  window: {
    activeTextEditor: undefined,
    registerWebviewPanelSerializer(_viewType, serializer) {
      registeredSerializer = serializer;
      return { dispose() {} };
    },
    createWebviewPanel(_viewType, title, viewColumn, options) {
      const panel = createMockPanel({ title, visible: true, active: true, viewColumn });
      panel.initialCreateOptions = options;
      createdPanels.push(panel);
      return panel;
    },
    showWarningMessage(message) {
      warnings.push(message);
      return Promise.resolve(undefined);
    },
    showInformationMessage() {
      return Promise.resolve(undefined);
    },
    showErrorMessage() {
      return Promise.resolve(undefined);
    }
  },
  commands: {
    executeCommand: async () => undefined
  }
};

Module._load = function load(name, parent, isMain) {
  return name === 'vscode' ? vscode : originalLoad.call(this, name, parent, isMain);
};

after(() => {
  Module._load = originalLoad;
});

const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { MainPanel } = require(path.join(compiledRoot, 'vscode/panels/MainPanel.js'));
const { BridgeMessageType } = require(path.join(compiledRoot, 'shared/protocol.js'));

const extensionUri = Uri.file(path.resolve('.'));

function createControlledStartup() {
  let resolveWait;
  let rejectWait;
  const ready = new Promise((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  ready.catch(() => undefined);
  let waitingStatus;
  const waitingListeners = new Set();
  return {
    startup: {
      wait: () => ready,
      waiting: () => waitingStatus,
      onDidChangeWaiting(listener) {
        waitingListeners.add(listener);
        return { dispose: () => waitingListeners.delete(listener) };
      }
    },
    reportWaiting(status) {
      waitingStatus = status;
      for (const listener of [...waitingListeners]) listener(status);
    },
    get waitingListenerCount() {
      return waitingListeners.size;
    },
    resolve: resolveWait,
    reject: rejectWait
  };
}

function createFacade(overrides = {}) {
  let clientSeq = 0;
  const attached = [];
  const detached = [];
  const visibilityEvents = [];
  const handledMessages = [];
  const recovered = [];
  const titles = new Map();

  const facade = {
    attached,
    detached,
    visibilityEvents,
    handledMessages,
    recovered,
    titles,
    waitUntilHydrated: async () => {},
    conversationExists: async () => true,
    getConversationDisplayTitle: (id) => titles.get(id) ?? `标题-${id}`,
    getConversationHistoryEntries: () => [],
    createConversation: async () => 'created-conv',
    recoverConversation: async (id) => { recovered.push(id); },
    attachWebview(webview, meta) {
      const id = `client-${++clientSeq}`;
      attached.push({ id, webview, meta });
      return id;
    },
    setWebviewVisible(clientId, visible) {
      visibilityEvents.push({ clientId, visible });
    },
    detachWebview(clientId) {
      detached.push(clientId);
    },
    handleReliableKernelControl: async () => true,
    handleWebviewMessage(clientId, message) {
      handledMessages.push({ clientId, message });
    },
    ...overrides
  };
  return facade;
}

test('restoring a hidden panel defers mounting while keeping panel management functional', async () => {
  const { startup, reportWaiting, resolve } = createControlledStartup();
  const facade = createFacade();
  facade.titles.set('conv-hidden', '旧标题');
  const hiddenPanel = createMockPanel({ title: '旧标题', visible: false, active: false });

  try {
    MainPanel.registerSerializer({ subscriptions: [], extensionUri }, startup);
    const restorePromise = registeredSerializer.deserializeWebviewPanel(hiddenPanel, { conversationId: 'conv-hidden' });

    // While startup is pending and panel is hidden, neither initializing HTML nor webview options are written.
    assert.equal(hiddenPanel.htmlWrites.length, 0);
    assert.equal(hiddenPanel.optionsWrites.length, 0);
    reportWaiting({ title: '正在等待另一个窗口', description: '迁移中' });
    assert.equal(hiddenPanel.htmlWrites.length, 0);

    resolve(facade);
    await restorePromise;

    // Even after startup resolves, hidden panel stays unmounted.
    assert.equal(hiddenPanel.htmlWrites.length, 0);
    assert.equal(hiddenPanel.optionsWrites.length, 0);
    assert.equal(facade.attached.length, 0);
    assert.equal(facade.visibilityEvents.length, 0);
    assert.equal(hiddenPanel.messageListenerCount, 0);

    // Panel management works seamlessly on the deferred panel.
    assert.deepEqual(MainPanel.getOpenConversationPanelStates(), [
      { conversationId: 'conv-hidden', visible: false, active: false }
    ]);

    facade.titles.set('conv-hidden', '新标题');
    MainPanel.refreshConversationTitle('conv-hidden');
    assert.equal(hiddenPanel.title, '新标题');
    assert.equal(facade.attached.length, 0);

    const draftPosts = [];
    const asked = MainPanel.saveComposerDrafts((clientId, message) => {
      draftPosts.push({ clientId, message });
      return true;
    });
    assert.equal(asked, 0);
    assert.equal(draftPosts.length, 0);

    // closePanelsByConversationId disposes the deferred panel without calling detachWebview.
    MainPanel.closePanelsByConversationId('conv-hidden');
    assert.equal(hiddenPanel.isDisposed, true);
    assert.equal(facade.detached.length, 0);
    assert.deepEqual(MainPanel.getOpenConversationPanelStates(), []);
  } finally {
    hiddenPanel.dispose();
  }
});

test('switching a deferred hidden panel to visible mounts it exactly once and forwards messages', async () => {
  const { startup, resolve } = createControlledStartup();
  const facade = createFacade();
  const hiddenPanel = createMockPanel({ visible: false, active: false });

  try {
    MainPanel.registerSerializer({ subscriptions: [], extensionUri }, startup);
    resolve(facade);
    await registeredSerializer.deserializeWebviewPanel(hiddenPanel, { conversationId: 'conv-lazy' });

    assert.equal(facade.attached.length, 0);
    assert.equal(hiddenPanel.htmlWrites.length, 0);

    // Becoming visible mounts once.
    hiddenPanel.setVisible(true, true);
    assert.equal(facade.attached.length, 1);
    assert.equal(facade.attached[0].meta.conversationId, 'conv-lazy');
    assert.equal(hiddenPanel.optionsWrites.length, 1);
    assert.equal(hiddenPanel.htmlWrites.length, 1);
    assert.deepEqual(facade.visibilityEvents, [{ clientId: 'client-1', visible: true }]);
    assert.equal(hiddenPanel.messageListenerCount, 1);

    // Messages flow normally after mounting.
    hiddenPanel.receiveMessage({ type: BridgeMessageType.HistoryList, id: 'msg-1' });
    assert.equal(facade.handledMessages.length, 1);
    assert.equal(facade.handledMessages[0].clientId, 'client-1');

    // Draft saving now includes the mounted panel.
    const draftClients = [];
    assert.equal(MainPanel.saveComposerDrafts((clientId) => {
      draftClients.push(clientId);
      return true;
    }), 1);
    assert.deepEqual(draftClients, ['client-1']);

    // Hiding and showing again updates visibility without re-mounting.
    hiddenPanel.setVisible(false, false);
    hiddenPanel.setVisible(true, true);
    assert.equal(facade.attached.length, 1);
    assert.equal(hiddenPanel.htmlWrites.length, 1);
    assert.deepEqual(facade.visibilityEvents, [
      { clientId: 'client-1', visible: true },
      { clientId: 'client-1', visible: false },
      { clientId: 'client-1', visible: true }
    ]);

    hiddenPanel.dispose();
    assert.deepEqual(facade.detached, ['client-1']);
    assert.deepEqual(MainPanel.getOpenConversationPanelStates(), []);
  } finally {
    hiddenPanel.dispose();
  }
});

test('createOrShow deduplicates a deferred hidden panel and mounts it when reveal makes it visible', async () => {
  const { startup, resolve } = createControlledStartup();
  const facade = createFacade();
  const hiddenPanel = createMockPanel({
    visible: false,
    active: false,
    revealSetsVisible: true,
    revealFiresViewState: false
  });
  const createdBefore = createdPanels.length;

  try {
    MainPanel.registerSerializer({ subscriptions: [], extensionUri }, startup);
    resolve(facade);
    await registeredSerializer.deserializeWebviewPanel(hiddenPanel, { conversationId: 'conv-dedup' });
    assert.equal(facade.attached.length, 0);

    await MainPanel.createOrShow(extensionUri, facade, { conversationId: 'conv-dedup' });

    assert.equal(createdPanels.length, createdBefore, 'should reuse existing deferred panel instead of creating a new one');
    assert.equal(hiddenPanel.reveals, 1);
    assert.equal(facade.attached.length, 1, 'mountIfVisible should mount immediately after synchronous reveal');
    assert.equal(hiddenPanel.htmlWrites.length, 1);
    assert.deepEqual(facade.visibilityEvents, [{ clientId: 'client-1', visible: true }]);
  } finally {
    hiddenPanel.dispose();
  }
});

test('disposing a deferred hidden panel before it ever becomes visible cleans up without detachWebview', async () => {
  const { startup, resolve } = createControlledStartup();
  const facade = createFacade();
  const hiddenPanel = createMockPanel({ visible: false, active: false });

  try {
    MainPanel.registerSerializer({ subscriptions: [], extensionUri }, startup);
    resolve(facade);
    await registeredSerializer.deserializeWebviewPanel(hiddenPanel, { conversationId: 'conv-dispose-early' });

    assert.equal(MainPanel.getOpenConversationPanelStates().length, 1);
    hiddenPanel.dispose();

    assert.equal(facade.attached.length, 0);
    assert.equal(facade.detached.length, 0);
    assert.equal(hiddenPanel.htmlWrites.length, 0);
    assert.equal(hiddenPanel.viewStateListenerCount, 0);
    assert.deepEqual(MainPanel.getOpenConversationPanelStates(), []);
  } finally {
    hiddenPanel.dispose();
  }
});

test('revealing a hidden panel before startup completes renders initializing HTML immediately and mounts on startup', async () => {
  const control = createControlledStartup();
  const facade = createFacade();
  const hiddenPanel = createMockPanel({ visible: false, active: false });

  try {
    MainPanel.registerSerializer({ subscriptions: [], extensionUri }, control.startup);
    const restorePromise = registeredSerializer.deserializeWebviewPanel(hiddenPanel, { conversationId: 'conv-early-click' });

    assert.equal(hiddenPanel.htmlWrites.length, 0);

    // User clicks the hidden tab while startup is still in progress.
    hiddenPanel.setVisible(true, true);
    assert.equal(hiddenPanel.htmlWrites.length, 1);
    assert.match(hiddenPanel.htmlWrites[0], /正在恢复对话标签页/);

    // Subsequent waiting updates refresh the visible initializing HTML.
    control.reportWaiting({ title: '等待数据目录释放', description: '另一个窗口正在合并' });
    assert.equal(hiddenPanel.htmlWrites.length, 2);
    assert.match(hiddenPanel.htmlWrites[1], /等待数据目录释放/);

    // Once startup finishes, the now-visible panel mounts immediately.
    control.resolve(facade);
    await restorePromise;

    assert.equal(control.waitingListenerCount, 0);
    assert.equal(facade.attached.length, 1);
    assert.equal(hiddenPanel.htmlWrites.length, 3);
    assert.deepEqual(facade.visibilityEvents, [{ clientId: 'client-1', visible: true }]);
  } finally {
    hiddenPanel.dispose();
  }
});

test('startup failure while hidden defers unavailable HTML until the tab becomes visible', async () => {
  const control1 = createControlledStartup();
  const hiddenFailedPanel = createMockPanel({ visible: false, active: false });
  const control2 = createControlledStartup();
  const hiddenClosedPanel = createMockPanel({ visible: false, active: false });

  try {
    MainPanel.registerSerializer({ subscriptions: [], extensionUri }, control1.startup);
    const failedPromise = registeredSerializer.deserializeWebviewPanel(hiddenFailedPanel, { conversationId: 'conv-fail-1' });
    control1.reject(new Error('SQLite 启动失败'));
    await failedPromise;

    // Must not touch webview.html while still hidden.
    assert.equal(hiddenFailedPanel.htmlWrites.length, 0);
    assert.equal(hiddenFailedPanel.optionsWrites.length, 0);

    // Clicking the tab shows the unavailable HTML immediately.
    hiddenFailedPanel.setVisible(true, true);
    assert.equal(hiddenFailedPanel.htmlWrites.length, 1);
    assert.match(hiddenFailedPanel.htmlWrites[0], /SQLite 启动失败/);
    assert.equal(hiddenFailedPanel.viewStateListenerCount, 0);

    // Disposing a failed hidden tab without viewing it never writes HTML.
    MainPanel.registerSerializer({ subscriptions: [], extensionUri }, control2.startup);
    const closedPromise = registeredSerializer.deserializeWebviewPanel(hiddenClosedPanel, { conversationId: 'conv-fail-2' });
    control2.reject(new Error('不可达错误'));
    await closedPromise;
    assert.equal(hiddenClosedPanel.htmlWrites.length, 0);
    hiddenClosedPanel.dispose();
    assert.equal(hiddenClosedPanel.htmlWrites.length, 0);
  } finally {
    hiddenFailedPanel.dispose();
    hiddenClosedPanel.dispose();
  }
});

test('restoring a visible panel mounts immediately and deferred mount failure rolls back cleanly', async () => {
  const control1 = createControlledStartup();
  const facade1 = createFacade();
  const visiblePanel = createMockPanel({ visible: true, active: true });

  const control2 = createControlledStartup();
  const facade2 = createFacade();
  const flakyHiddenPanel = createMockPanel({ visible: false, active: false });
  const warningsBefore = warnings.length;

  try {
    // 1. Restoring a visible panel keeps immediate initializing HTML + immediate mount.
    MainPanel.registerSerializer({ subscriptions: [], extensionUri }, control1.startup);
    const visibleRestore = registeredSerializer.deserializeWebviewPanel(visiblePanel, { conversationId: 'conv-visible' });
    assert.equal(visiblePanel.htmlWrites.length, 1);
    assert.match(visiblePanel.htmlWrites[0], /正在恢复对话标签页/);
    control1.resolve(facade1);
    await visibleRestore;
    assert.equal(facade1.attached.length, 1);
    assert.equal(visiblePanel.htmlWrites.length, 2);

    // 2. Deferred mount throwing on html write rolls back detachWebview and keeps MainPanel.panels intact.
    MainPanel.registerSerializer({ subscriptions: [], extensionUri }, control2.startup);
    control2.resolve(facade2);
    await registeredSerializer.deserializeWebviewPanel(flakyHiddenPanel, { conversationId: 'conv-flaky' });

    flakyHiddenPanel.failNextHtml = new Error('Simulated webview html error');
    flakyHiddenPanel.setVisible(true, true);

    assert.equal(facade2.attached.length, 1);
    assert.deepEqual(facade2.detached, ['client-1']);
    assert.equal(warnings.length, warningsBefore + 1);
    assert.equal(
      MainPanel.getOpenConversationPanelStates().some((item) => item.conversationId === 'conv-flaky'),
      true,
      'MainPanel.panels must remain intact after failed deferred mount'
    );
    // Unmounted panel must still be skipped by saveComposerDrafts.
    const draftClients = [];
    MainPanel.saveComposerDrafts((clientId) => { draftClients.push(clientId); return true; });
    assert.deepEqual(draftClients, ['client-1']); // Only visiblePanel's client-1 from facade1

    // Retrying visibility succeeds cleanly.
    flakyHiddenPanel.setVisible(false, false);
    flakyHiddenPanel.setVisible(true, true);
    assert.equal(facade2.attached.length, 2);
    assert.equal(flakyHiddenPanel.htmlWrites.length, 1);

    flakyHiddenPanel.dispose();
    assert.deepEqual(facade2.detached, ['client-1', 'client-2']);
  } finally {
    visiblePanel.dispose();
    flakyHiddenPanel.dispose();
  }
});

test('createOrShow mounts newly created panels immediately and hidden non-chat restore defers until visible', async () => {
  const control = createControlledStartup();
  const facade = createFacade();
  const hiddenSettingsPanel = createMockPanel({
    title: 'Limcode Test 设置',
    visible: false,
    active: false,
    revealSetsVisible: true,
    revealFiresViewState: false
  });
  let createdChatPanel;

  try {
    // 1. Newly created panel via createOrShow mounts immediately.
    const beforeCount = createdPanels.length;
    await MainPanel.createOrShow(extensionUri, facade, { conversationId: 'conv-fresh' });
    assert.equal(createdPanels.length, beforeCount + 1);
    createdChatPanel = createdPanels.at(-1);
    assert.equal(facade.attached.length, 1);
    assert.equal(createdChatPanel.htmlWrites.length, 1);

    // 2. Restoring a hidden non-chat panel defers mounting until revealed/visible.
    MainPanel.registerSerializer({ subscriptions: [], extensionUri }, control.startup);
    control.resolve(facade);
    await registeredSerializer.deserializeWebviewPanel(hiddenSettingsPanel, { kind: 'globalSettings' });

    assert.equal(facade.attached.length, 1, 'hidden settings panel must not mount during restore');
    assert.equal(hiddenSettingsPanel.htmlWrites.length, 0);

    const beforeReuseCount = createdPanels.length;
    await MainPanel.createOrShow(extensionUri, facade, { kind: 'globalSettings', reuse: true });
    assert.equal(createdPanels.length, beforeReuseCount, 'should reuse existing deferred settings panel');
    assert.equal(hiddenSettingsPanel.reveals, 1);
    assert.equal(facade.attached.length, 2);
    assert.equal(hiddenSettingsPanel.htmlWrites.length, 1);
  } finally {
    createdChatPanel?.dispose();
    hiddenSettingsPanel.dispose();
  }
});
