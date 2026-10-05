import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

// The sidebar shows history ordered by Conversation.updated_at. A command of this window that
// refreshes a Conversation moves it to the top of the first page; the sidebar must follow it there
// instead of re-reading the page it left, where the Conversation is no longer listed. Real Facade,
// command router, sidebar host, Runtime database and turn control plane; only VS Code is mocked.

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const registeredProviders = [];
const disposable = () => ({ dispose() {} });
class EventEmitter {
  listeners = new Set();
  event = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value) { for (const listener of [...this.listeners]) listener(value); }
  dispose() { this.listeners.clear(); }
}
const vscode = {
  EventEmitter,
  Uri: { parse: (text) => ({ toString: () => text }), joinPath: () => ({}) },
  window: {
    registerWebviewViewProvider(_id, provider) { registeredProviders.push(provider); return disposable(); },
    onDidChangeActiveTextEditor: disposable,
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined
  },
  workspace: { onDidChangeWorkspaceFolders: disposable, workspaceFolders: [] },
  commands: { executeCommand: async () => undefined }
};
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  if (request.endsWith('/panels/MainPanel')) {
    return { MainPanel: {
      onDidChangeConversationPanelState: disposable,
      getOpenConversationPanelStates: () => [],
      createOrShow() {},
      refreshConversationTitle() {},
      closePanelsByConversationId() {}
    } };
  }
  if (request.endsWith('/webview/getWebviewHtml')) return { getWebviewHtml: () => '', getUnavailableWebviewHtml: () => '' };
  return originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const kernel = require(path.join(compiledRoot, 'backend/reliableKernel/index.js'));
const { emptyConversationContextHandleStateStep } = require(path.join(compiledRoot, 'backend/reliableKernel/conversationContextHandleState.js'));
const { VscodeReliableKernelApplicationFacade: Facade } = require(path.join(
  compiledRoot, 'backend/application/reliableKernel/VscodeReliableKernelApplicationFacade.js'
));
const { registerSidebarEntryView } = require(path.join(compiledRoot, 'vscode/views/SidebarEntryView.js'));
const { BridgeMessageType } = require(path.join(compiledRoot, 'shared/protocol.js'));

const P = 'file:///workspace/project-p';
const PAGE_SIZE = 50;
const CONVERSATIONS = 57;
const row = (domain, value) => kernel.DOMAIN_REPOSITORIES.domain(domain).insert(value);
const conversationId = (index) => `p-${String(index).padStart(2, '0')}`;

async function waitFor(predicate, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
/** Longer than the Facade's 25ms commit refresh plus the sidebar's 180ms debounce. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

/**
 * 57 Conversations of project P, oldest first: page 2 lists p-07…p-01. p-03 and p-05 each run a
 * Turn, and p-05 also has one queued guidance message. Everything before the returned harness
 * starts is dated in the past; commands then use the real clock.
 */
async function openHarness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-history-local-actions-'));
  const root = await kernel.resetCandidateRuntimeRoot(directory);
  const database = await kernel.RuntimeDatabase.open(root.authority, { hostBootId: 'history-local-actions' });
  const store = kernel.ContentAddressedStore.forDatabase(root.authority, database);
  let seconds = 0;
  let realClock = false;
  const now = () => realClock ? new Date().toISOString() : new Date(Date.UTC(2026, 8, 1) + ++seconds * 1000).toISOString();
  const control = new kernel.TurnControlPlane(database, store, {
    now,
    authorityCompiler: {
      async compile(request) {
        return {
          turnId: request.turnId,
          executorAgentId: request.executorAgentId,
          executionPreset: { content: JSON.stringify({ providerConfigId: 'fake-local', modelId: 'fake-model' }) },
          authoritySnapshot: { content: JSON.stringify({
            kind: 'effective-turn-authority',
            turnId: request.turnId,
            executorAgentId: request.executorAgentId,
            model: { providerConfigId: 'fake-local', modelId: 'fake-model', maxOutputTokens: 16_000 },
            policies: { toolPolicyId: 'tools-default', systemPromptId: 'prompt-default' }
          }) }
        };
      }
    }
  });
  const lease = { leaseOwnerId: 'history-local-actions-owner', hostBootId: database.hostBootId, leaseExpiresAt: '2099-01-01T00:00:00.000Z' };
  const conversationRows = (from, to) => {
    const steps = [];
    for (let index = from; index <= to; index += 1) {
      const id = conversationId(index);
      const at = now();
      steps.push(
        row('Conversation', { id, title: id, status: 'active', created_at: at, updated_at: at }),
        emptyConversationContextHandleStateStep(id, at),
        row('ConversationProjectLink', { id: `project-link-${id}`, conversation_id: id, project_context_id: 'project-p', role: 'primary', created_at: at, updated_at: at }),
        row('AgentConversationLink', { id: `agent-link-${id}`, conversation_id: id, agent_id: 'main', role: 'default', created_at: at, updated_at: at })
      );
    }
    return steps;
  };
  const input = (id, key, content) => control.input({ source: { kind: 'command', key }, conversationId: id, ...lease, content });
  const created = now();
  await database.transaction([row('ProjectContext', { id: 'project-p', kind: 'folder', uri: P, name: 'P', created_at: created, updated_at: created })]);
  await database.transaction(conversationRows(1, 3));
  const runningP03 = await input('p-03', 'seed-p-03', '第三个对话正在运行');
  await database.transaction(conversationRows(4, 5));
  const runningP05 = await input('p-05', 'seed-p-05', '第五个对话正在运行');
  const guidanceP05 = await input('p-05', 'seed-p-05-guidance', '排队等待的消息');
  assert.equal(runningP03.admitted, true);
  assert.equal(runningP05.admitted, true);
  assert.equal(guidanceP05.admitted, false, '运行中的对话再发的消息进入排队');
  await database.transaction(conversationRows(6, CONVERSATIONS));
  realClock = true;

  const product = {
    debugCapture: { setListener() {} },
    toolHost: { setStateChangeListener() {} },
    ensureCapabilitiesReady: async () => undefined,
    application: {
      database,
      contentStore: store,
      turns: control,
      modelProvider: { subscribeSteering: () => () => undefined },
      webviewFeed: { postToConversation() {}, reconnect() {} }
    },
    configuration: { agents: async () => [] },
    // The reliable conversation runner's command shapes, straight onto the real control plane.
    conversations: {
      input: (command) => control.input({ source: { kind: 'command', key: command.commandId }, conversationId: command.conversationId, ...lease, content: command.text }),
      interrupt: (command) => control.requestExternalInterrupt(command.conversationId, {
        source: { kind: 'command', key: command.commandId },
        turnId: command.turnId,
        ...(command.expectedLeaseGeneration ? { expectedLeaseGeneration: command.expectedLeaseGeneration } : {}),
        reason: command.reason
      }),
      cancelGuidance: (command) => control.cancelGuidance({
        source: { kind: 'command', key: command.commandId },
        conversationId: command.conversationId,
        intentId: command.intentId,
        expectedRevisionSeq: command.expectedRevisionSeq
      })
    },
    close: async () => undefined
  };
  const facade = new Facade({}, product, () => ({}), {});
  const reveals = [];
  facade.onDidRevealConversationHistoryTop((target) => reveals.push(target.conversationId));

  const before = registeredProviders.length;
  registerSidebarEntryView({ extensionUri: {}, subscriptions: [] }, { wait: async () => facade });
  const provider = registeredProviders[before];
  const posted = [];
  let receive;
  provider.resolveWebviewView({
    onDidDispose: disposable,
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage(handler) { receive = handler; return disposable(); },
      postMessage: async (message) => { posted.push(message); return true; }
    }
  });
  const panelMessages = [];
  const panel = { postMessage: async (message) => { panelMessages.push(message); return true; } };
  let commandSeq = 0;
  t.after(async () => {
    provider.dispose();
    await facade.dispose();
    await database.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const states = () => posted.filter((message) => message.type === 'sidebar.state');
  const harness = {
    database,
    reveals,
    running: { 'p-03': runningP03.turnId, 'p-05': runningP05.turnId },
    guidanceIntentId: guidanceP05.intentId,
    states,
    lastState: () => states().at(-1),
    /** The sidebar asks for a page the way its webview does. */
    async showPage(pageIndex) {
      let page = await facade.getConversationHistoryPage({ scopeKind: 'project', projectFolderUri: P, limit: PAGE_SIZE });
      for (let index = 0; index < pageIndex; index += 1) {
        page = await facade.getConversationHistoryPage({ scopeKind: 'project', projectFolderUri: P, cursor: page.pageInfo.nextCursor, limit: PAGE_SIZE });
      }
      const from = states().length;
      receive({ type: 'sidebar.historyPage.get', scopeKind: 'project', projectFolderUri: P, cursor: page.pageInfo.cursor, limit: PAGE_SIZE });
      await waitFor(() => states().slice(from).some((message) => message.history.pageInfo.pageIndex === pageIndex), `第 ${pageIndex + 1} 页`);
      await settle();
      assert.equal(harness.lastState().history.pageInfo.pageIndex, pageIndex);
      return harness.lastState().history.entries.map((entry) => entry.id);
    },
    sidebar(message) { receive(message); },
    /** A panel command through the real router, with a fresh command id unless one is given. */
    panel(type, payload, commandId = `command-${++commandSeq}`) {
      return facade.commandRouter.dispatch('panel-client', panel, {
        id: `request-${commandId}-${++commandSeq}`,
        type,
        payload: { ...payload, command: { commandId } }
      }).then(() => commandId);
    },
    panelMessages,
    /** The sidebar ends on the first page with the Conversation on top; nothing after the action shows another page. */
    async expectRevealedOnTop(id, since) {
      await waitFor(() => harness.lastState()?.history.pageInfo.pageIndex === 0
        && harness.lastState().history.entries[0]?.id === id, `${id} 位于第 1 页首位`);
      await settle();
      const after = states().slice(since);
      assert.ok(after.length > 0);
      assert.deepEqual(after.map((message) => message.history.pageInfo.pageIndex).filter((index) => index !== 0), [],
        '动作之后不再显示离开前的那一页');
      assert.equal(harness.lastState().history.pageInfo.pageIndex, 0);
      assert.equal(harness.lastState().history.entries[0].id, id);
    },
    async expectStayed(pageIndex, since, revealsBefore) {
      await settle();
      assert.deepEqual(reveals, revealsBefore, '没有回到第一页的通知');
      assert.ok(states().slice(since).every((message) => message.history.pageInfo.pageIndex === pageIndex), '侧栏停在原页');
      assert.equal(harness.lastState().history.pageInfo.pageIndex, pageIndex);
    }
  };
  return harness;
}

test('侧栏在第 2 页重命名其中的对话：回到第 1 页，改名的对话在首位；面板改名同样如此', async (t) => {
  const harness = await openHarness(t);
  assert.deepEqual(await harness.showPage(1), ['p-07', 'p-06', 'p-05', 'p-04', 'p-03', 'p-02', 'p-01']);

  let since = harness.states().length;
  harness.sidebar({ type: 'renameConversation', conversationId: 'p-06', title: '改过名的对话' });
  await harness.expectRevealedOnTop('p-06', since);
  assert.equal(harness.lastState().history.entries[0].title, '改过名的对话');
  assert.deepEqual(harness.reveals, ['p-06']);

  // The panel's conversation settings rename the same way.
  assert.deepEqual(await harness.showPage(1), ['p-08', 'p-07', 'p-05', 'p-04', 'p-03', 'p-02', 'p-01']);
  since = harness.states().length;
  await harness.panel(BridgeMessageType.ConversationSettingsUpdate, { section: 'common', settings: { conversationId: 'p-02', name: '面板里改的名字' } });
  await harness.expectRevealedOnTop('p-02', since);
  assert.deepEqual(harness.reveals, ['p-06', 'p-02']);
});

test('面板停止第 2 页上运行中的对话后回到第 1 页；合并到已有停止请求和重放都不翻页；侧栏停止同样回到第 1 页', async (t) => {
  const harness = await openHarness(t);
  await harness.showPage(1);
  let since = harness.states().length;
  const stop = { conversationId: 'p-05', turnId: harness.running['p-05'], leaseEpoch: 0, cascadeChildAgents: false };
  const commandId = await harness.panel(BridgeMessageType.TurnInterrupt, stop);
  await harness.expectRevealedOnTop('p-05', since);
  assert.deepEqual(harness.reveals, ['p-05']);
  assert.equal(harness.panelMessages.at(-1).payload.status, 'accepted');

  // A second stop joins the pending request and a replay commits nothing: neither refreshes p-05.
  await harness.showPage(1);
  since = harness.states().length;
  await harness.panel(BridgeMessageType.TurnInterrupt, stop);
  assert.equal(harness.panelMessages.at(-1).payload.status, 'coalesced');
  await harness.panel(BridgeMessageType.TurnInterrupt, stop, commandId);
  await harness.expectStayed(1, since, ['p-05']);

  // The sidebar's own stop button on p-03 (page 2 as well).
  const [lease] = (await harness.database.snapshot([kernel.DOMAIN_REPOSITORIES.domain('ExecutionLease').list({
    where: { turn_id: harness.running['p-03'] }, limit: 2
  })])).snapshot[0];
  since = harness.states().length;
  harness.sidebar({
    type: 'abortConversation',
    conversationId: 'p-03',
    requestId: 'sidebar-stop-p-03',
    turnId: harness.running['p-03'],
    leaseGeneration: String(lease.generation)
  });
  await harness.expectRevealedOnTop('p-03', since);
  assert.deepEqual(harness.reveals, ['p-05', 'p-03']);
});

test('取消排队消息、发送新消息后回到第 1 页；重放同一条消息不翻页', async (t) => {
  const harness = await openHarness(t);
  await harness.showPage(1);
  let since = harness.states().length;
  await harness.panel(BridgeMessageType.GuidanceCancel, { conversationId: 'p-05', intentId: harness.guidanceIntentId, expectedRevisionSeq: '1' });
  await harness.expectRevealedOnTop('p-05', since);

  await harness.showPage(1);
  since = harness.states().length;
  const commandId = await harness.panel(BridgeMessageType.TurnStart, { conversationId: 'p-04', text: '新消息' });
  await harness.expectRevealedOnTop('p-04', since);
  assert.equal(harness.panelMessages.at(-1).payload.status, 'accepted');

  await harness.showPage(1);
  since = harness.states().length;
  await harness.panel(BridgeMessageType.TurnStart, { conversationId: 'p-04', text: '新消息' }, commandId);
  assert.equal(harness.panelMessages.at(-1).payload.status, 'replayed');
  await harness.expectStayed(1, since, ['p-05', 'p-04']);
});
