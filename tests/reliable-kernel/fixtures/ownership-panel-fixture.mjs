import { createOwnershipScope } from './ownership-scope-fixture.mjs';
// Focused production ownership boundary; old review matrices are absent.
import assert from 'node:assert/strict';
import { after } from 'node:test';

import fs from 'node:fs/promises';

import os from 'node:os';

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

function startupOf(wait) {
  return { wait, waiting: () => undefined, onDidChangeWaiting: () => ({ dispose() {} }) };
}

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
  const { outer: directory, binding } = await createOwnershipScope('panel');
  const owner = new ConversationRuntimeOwnerManager(binding, 'restoring-window');
  const peer = new ConversationRuntimeOwnerManager(binding, 'peer-window');
  owner.setPendingWorkProbe(async () => false);
  peer.setPendingWorkProbe(async () => false);
  return { directory, owner, peer, async close() {
    await Promise.all([owner.close(), peer.close()]);
    await fs.rm(directory, { recursive: true, force: true });
  } };
}

export const scenario1 = async () => {
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
    MainPanel.registerSerializer({ subscriptions: [], extensionUri: Uri.file(fixture.directory) }, startupOf(async () => facade));
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
};
