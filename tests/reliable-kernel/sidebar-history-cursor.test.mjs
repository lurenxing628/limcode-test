import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const registeredProviders = [];
const disposable = () => ({ dispose() {} });
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') {
    return {
      window: {
        registerWebviewViewProvider(_id, provider) { registeredProviders.push(provider); return disposable(); },
        onDidChangeActiveTextEditor: disposable,
        showWarningMessage: async () => undefined
      },
      workspace: { onDidChangeWorkspaceFolders: disposable },
      Uri: { joinPath: () => ({}) }
    };
  }
  if (request.endsWith('/panels/MainPanel')) {
    return { MainPanel: {
      onDidChangeConversationPanelState: disposable,
      getOpenConversationPanelStates: () => [],
      createOrShow() {},
      refreshConversationTitle() {}
    } };
  }
  if (request.endsWith('/webview/getWebviewHtml')) {
    return { getWebviewHtml: () => '', getUnavailableWebviewHtml: () => '' };
  }
  return originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const compiledRoot = path.resolve(process.env.LIMCODE_TEST_EXTENSION_ROOT ?? 'dist/extension');
const { registerSidebarEntryView } = require(path.join(compiledRoot, 'vscode/views/SidebarEntryView.js'));
const { VscodeReliableKernelCommandRouter } = require(path.join(
  compiledRoot, 'backend/application/reliableKernel/VscodeReliableKernelCommandRouter.js'
));

const P = 'file:///workspace/project-p';
const Q = 'file:///workspace/project-q';

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
/** Longer than the sidebar's 180ms refresh debounce, so a missing request is really missing. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

function sidebarHost() {
  const listeners = { history: [], reveal: [] };
  const requests = [];
  let scope = { kind: 'project', folderUri: P };
  const backendApp = {
    onDidChangeConversationHistory: (listener) => { listeners.history.push(listener); return disposable(); },
    onDidRevealConversationHistoryTop: (listener) => { listeners.reveal.push(listener); return disposable(); },
    async getConversationHistoryPage(input) {
      requests.push({ ...input });
      return {
        scope,
        entries: [],
        originLinks: [],
        // The backend may re-position or clamp; the host must remember what it actually resolved.
        pageInfo: { cursor: `resolved:${input.cursor ?? 'first'}`, pageIndex: 0, pageSize: 50, total: 0, hasNext: false, hasPrevious: false }
      };
    },
    getCurrentProjectHistoryScope: () => scope,
    getProjectFolderCandidates: () => []
  };
  const context = { extensionUri: {}, subscriptions: [] };
  const before = registeredProviders.length;
  registerSidebarEntryView(context, { wait: async () => backendApp });
  const provider = registeredProviders[before];
  let receive;
  const posted = [];
  provider.resolveWebviewView({
    onDidDispose: disposable,
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage(handler) { receive = handler; return disposable(); },
      postMessage: async (message) => { posted.push(message); return true; }
    }
  });
  return {
    requests,
    posted,
    setScope(next) { scope = next; },
    request(message) { receive({ type: 'sidebar.historyPage.get', limit: 50, ...message }); },
    historyChanged() { for (const listener of listeners.history) listener(); },
    reveal(target) { for (const listener of listeners.reveal) listener(target); },
    dispose() { provider.dispose(); }
  };
}

test('侧栏宿主刷新时重发后端实际返回的当前页游标，而不是请求时的旧游标', async (t) => {
  const host = sidebarHost();
  t.after(() => host.dispose());
  host.request({ scopeKind: 'project', projectFolderUri: P, cursor: 'page-2-request' });
  await waitFor(() => host.posted.length === 1, '首个页面状态');
  assert.equal(host.requests[0].cursor, 'page-2-request');
  host.historyChanged();
  await waitFor(() => host.requests.length === 2, '历史变化后的刷新');
  assert.equal(host.requests[1].cursor, 'resolved:page-2-request');
  host.historyChanged();
  await waitFor(() => host.requests.length === 3, '第二次刷新');
  assert.equal(host.requests[2].cursor, 'resolved:resolved:page-2-request');
});

test('本窗口在当前范围内的动作让侧栏回到第一页，其他项目的动作不改变项目页', async (t) => {
  const host = sidebarHost();
  t.after(() => host.dispose());
  host.request({ scopeKind: 'project', projectFolderUri: P, cursor: 'page-3' });
  await waitFor(() => host.posted.length === 1, '项目页面状态');

  host.reveal({ conversationId: 'q-conversation', projectFolderUri: Q });
  host.reveal({ conversationId: 'unbound-conversation' });
  await settle();
  assert.equal(host.requests.length, 1, '其他项目或未绑定会话的动作不触发项目页刷新');

  host.reveal({ conversationId: 'p-conversation', projectFolderUri: P });
  await waitFor(() => host.requests.length === 2, '回到第一页');
  assert.equal(host.requests[1].cursor, undefined);
  assert.equal(host.requests[1].scopeKind, 'project');

  host.setScope({ kind: 'unbound' });
  host.request({ scopeKind: 'unbound', cursor: 'unbound-page-2' });
  await waitFor(() => host.requests.length === 3 && host.posted.length === 3, '未绑定页面状态');
  host.reveal({ conversationId: 'p-conversation', projectFolderUri: P });
  await settle();
  assert.equal(host.requests.length, 3);
  host.reveal({ conversationId: 'unbound-conversation' });
  await waitFor(() => host.requests.length === 4, '未绑定范围回到第一页');
  assert.equal(host.requests[3].cursor, undefined);

  host.setScope({ kind: 'all' });
  host.request({ scopeKind: 'all', cursor: 'all-page-4' });
  await waitFor(() => host.requests.length === 5 && host.posted.length === 5, '全部历史页面状态');
  host.reveal({ conversationId: 'q-conversation', projectFolderUri: Q });
  await waitFor(() => host.requests.length === 6, '全部历史回到第一页');
  assert.equal(host.requests[5].cursor, undefined);
});

test('命令路由只在本窗口命令期间的提交刷新了该对话行时通知回到第一页', async () => {
  const acted = [];
  const listeners = new Set();
  const commit = (...changes) => {
    for (const listener of [...listeners]) listener({ commitSeq: '1', changes, allocatedSequences: [] });
  };
  const upsert = (domain, id) => ({ domain, kind: 'upsert', id });
  const inputs = [
    // Accepted input: its commit refreshes the Conversation row.
    () => { commit(upsert('TurnIntent', 'intent-1'), upsert('Conversation', 'conversation-a')); return { deduplicated: false, admitted: true, turnId: 'turn-1' }; },
    // Replay of the same command: nothing is committed.
    () => ({ deduplicated: true, admitted: false }),
    // A command whose commit changes other rows and another Conversation only.
    () => { commit(upsert('TurnIntent', 'intent-2'), upsert('Conversation', 'conversation-c')); return { deduplicated: false, admitted: false }; }
  ];
  const router = new VscodeReliableKernelCommandRouter({
    debugCapture: { setListener() {} },
    toolHost: { setStateChangeListener() {} },
    ensureCapabilitiesReady: async () => undefined,
    application: { database: {
      onCommit(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      conversationOwners: { run: (_conversationId, operation) => operation() }
    } },
    conversations: { input: async () => inputs.shift()() }
  }, { onConversationActedOn: (conversationId) => acted.push(conversationId) });
  router.childExecutionIdForConversation = async () => undefined;
  router.postTurnInputResult = () => undefined;
  const input = (conversationId, commandId) => router.handleTurnInput({}, `correlation-${commandId}`, 'turn.start', {
    conversationId, text: 'hi', command: { commandId }
  });
  await input('conversation-a', 'command-1');
  await input('conversation-a', 'command-1');
  await input('conversation-b', 'command-2');
  assert.deepEqual(acted, ['conversation-a']);
  // Runtime work committed after the command returned is not this window's action.
  commit(upsert('Conversation', 'conversation-a'));
  assert.deepEqual(acted, ['conversation-a']);
  assert.equal(listeners.size, 0, '命令结束后不再监听提交');
});
