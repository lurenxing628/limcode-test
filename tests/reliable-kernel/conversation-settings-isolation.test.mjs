import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test, { after } from 'node:test';
import { createServer } from 'vite';
import { createPinia } from 'pinia';

const root = process.cwd();
const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
const vscodeStub = createVscodeStub();
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};
after(() => { Module._load = originalLoad; });

const protocol = require(path.join(root, 'dist/extension/shared/protocol.js'));
const { VscodeReliableKernelCommandRouter } = require(path.join(
  root,
  'dist/extension/backend/application/reliableKernel/VscodeReliableKernelCommandRouter.js'
));
const { ReliableKernelWebviewFeedBridge } = require(path.join(
  root,
  'dist/extension/backend/reliableKernel/webviewFeedBridge.js'
));

const { VscodeConfigurationAuthority } = require(path.join(
  root,
  'dist/extension/backend/reliableKernel/vscodeConfigurationAuthority.js'
));
const { createVscodeStoragePaths } = require(path.join(root, 'dist/extension/backend/capabilities/vscodeStorage/paths.js'));
const { workEnvironmentIdFromUri } = require(path.join(root, 'dist/extension/shared/workEnvironmentCatalog.js'));

const conversationSnapshot = (conversationId, name) => ({
  conversationId,
  section: 'common',
  settings: { conversationId, name },
  filePath: ''
});

function webview(posted) {
  return {
    async postMessage(message) {
      posted.push(message);
      return true;
    }
  };
}

function productStub() {
  return {
    debugCapture: { setListener() {} },
    toolHost: { setStateChangeListener() {} },
    application: {
      database: {
        async transaction() {},
        conversationOwners: { async run(conversationId, operation) { return operation(); } }
      },
      webviewFeed: { reconnect() {} }
    }
  };
}

function conversationUpdateRouter(options) {
  const router = new VscodeReliableKernelCommandRouter(productStub(), options);
  router.requireRow = async (domain, id) => ({ id });
  router.readConversationSettings = async (conversationId, section) => ({
    conversationId,
    section,
    settings: { conversationId, name: '改名后的标题' },
    filePath: ''
  });
  return router;
}

const updateMessage = {
  id: 'req-update-1',
  type: protocol.BridgeMessageType.ConversationSettingsUpdate,
  channel: 'command',
  payload: { section: 'common', settings: { conversationId: 'conv-a', name: '改名后的标题' } }
};

/** 每个 Webview 面板持有独立 Pinia；用两套真实 store 分别模拟绑定 A 与 B 的面板。 */
async function withConversationStores(run) {
  const previousWindow = globalThis.window;
  const posted = [];
  let persisted;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    setTimeout() { return 0; },
    clearTimeout() {},
    acquireVsCodeApi() {
      return {
        postMessage(message) { posted.push(message); },
        getState() { return persisted; },
        setState(value) { persisted = value; }
      };
    }
  };
  const server = await createServer({
    configFile: path.join(root, 'vite.config.ts'),
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error'
  });
  try {
    const { useConversationSettingsStore } = await server.ssrLoadModule('/src/stores/useConversationSettingsStore.ts');
    const piniaA = createPinia();
    const piniaB = createPinia();
    const storeA = useConversationSettingsStore(piniaA);
    const storeB = useConversationSettingsStore(piniaB);
    await run({ storeA, storeB, posted });
  } finally {
    await server.close();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

const savedUpdates = (posted) => posted.filter(
  (message) => message.type === protocol.BridgeMessageType.ConversationSettingsUpdate
);

const settingsSnapshots = (posted) => posted.filter(
  (message) => message.type === protocol.BridgeMessageType.ConversationSettingsSnapshot
);

test('绑定 B 的视图收到 A 的快照后标题、conversationId 与保存目标都不变', async () => {
  await withConversationStores(async ({ storeA, storeB, posted }) => {
    storeA.request('conv-a');
    storeB.request('conv-b');
    storeB.applySnapshot(conversationSnapshot('conv-b', '会话B标题'));
    const fromA = conversationSnapshot('conv-a', '会话A标题');
    storeA.applySnapshot(fromA);
    storeB.applySnapshot(fromA);
    assert.equal(storeA.common.name, '会话A标题');
    assert.equal(storeB.common.conversationId, 'conv-b');
    assert.equal(storeB.common.name, '会话B标题');
    storeB.save();
    const saves = savedUpdates(posted);
    assert.equal(saves.length, 1);
    assert.equal(saves[0].payload.settings.conversationId, 'conv-b');
  });
});

test('导航 A→B 后迟到的 A 快照被丢弃，B 自己的快照正常应用', async () => {
  await withConversationStores(async ({ storeA }) => {
    storeA.request('conv-a');
    storeA.applySnapshot(conversationSnapshot('conv-a', '会话A'));
    storeA.request('conv-b');
    const pendingB = { ...storeA.common };
    storeA.applySnapshot(conversationSnapshot('conv-a', '迟到的A'));
    assert.deepEqual(storeA.common, pendingB);
    storeA.applySnapshot(conversationSnapshot('conv-b', '会话B'));
    assert.equal(storeA.common.conversationId, 'conv-b');
    assert.equal(storeA.common.name, '会话B');
  });
});

test('同一会话的多个视图都能同步同一份更新快照', async () => {
  await withConversationStores(async ({ storeA, storeB }) => {
    storeA.request('conv-a');
    storeB.request('conv-a');
    const updated = conversationSnapshot('conv-a', '同步后的标题');
    storeA.applySnapshot(updated);
    storeB.applySnapshot(updated);
    assert.equal(storeA.common.name, '同步后的标题');
    assert.equal(storeB.common.name, '同步后的标题');
    assert.equal(storeA.common.conversationId, 'conv-a');
    assert.equal(storeB.common.conversationId, 'conv-a');
  });
});

test('离开会话后迟到的快照和错误不能恢复旧目标，保存不发出命令', async () => {
  await withConversationStores(async ({ storeA, posted }) => {
    storeA.request('conv-a');
    storeA.applySnapshot(conversationSnapshot('conv-a', '会话A'));
    storeA.request('');
    const cleared = { ...storeA.common };
    const status = storeA.status;
    const requestCount = posted.length;
    storeA.applySnapshot(conversationSnapshot('conv-a', '迟到的A'));
    storeA.applyError({ conversationId: 'conv-a', message: '迟到的删除结果' });
    storeA.applyError({ message: '没有作用域的错误' });
    storeA.save();
    assert.equal(storeA.common.conversationId, '');
    assert.deepEqual(storeA.common, cleared);
    assert.equal(storeA.status, status);
    assert.equal(posted.length, requestCount);
  });
});

test('未绑定任何会话的视图丢弃会话快照', async () => {
  await withConversationStores(async ({ storeA }) => {
    storeA.applySnapshot(conversationSnapshot('conv-a', '会话A标题'));
    assert.equal(storeA.common.conversationId, '');
    assert.equal(storeA.common.name, '');
  });
});

test('快照内外会话身份错位时整份丢弃，不覆盖当前表单', async () => {
  await withConversationStores(async ({ storeA }) => {
    storeA.request('conv-b');
    storeA.applySnapshot(conversationSnapshot('conv-b', '会话B标题'));
    const before = { ...storeA.common };
    storeA.applySnapshot({
      conversationId: 'conv-b',
      section: 'common',
      settings: { conversationId: 'conv-a', name: '错位标题' },
      filePath: ''
    });
    assert.deepEqual(storeA.common, before);
  });
});

test('已删除会话的错误只影响仍绑定该会话的视图', async () => {
  await withConversationStores(async ({ storeA }) => {
    storeA.request('conv-b');
    const loadingStatus = storeA.status;
    const failure = 'fixture: conversation removed';
    storeA.applyError({ message: failure, conversationId: 'conv-a' });
    assert.equal(storeA.status, loadingStatus);
    storeA.applyError({ message: failure, conversationId: 'conv-b' });
    assert.equal(storeA.status, failure);
  });
});

test('会话更新经实际路由和 Feed 只送达同会话面板', async () => {
  const bridge = new ReliableKernelWebviewFeedBridge({}, {});
  const aPosts = [];
  const otherAPosts = [];
  const bPosts = [];
  const panelA = webview(aPosts);
  const panelOtherA = webview(otherAPosts);
  const panelB = webview(bPosts);
  try {
    const clientA = bridge.attach(panelA, { kind: 'mainPanel', conversationId: 'conv-a' });
    bridge.attach(panelOtherA, { kind: 'planDetail', conversationId: 'conv-a' });
    bridge.attach(panelB, { kind: 'mainPanel', conversationId: 'conv-b' });
    const router = conversationUpdateRouter({
      postToConversation: (conversationId, message) => bridge.postToConversation(conversationId, message),
      broadcast: (message) => {
        for (const panel of [panelA, panelOtherA, panelB]) void panel.postMessage(message);
      }
    });
    await router.dispatch(clientA, panelA, updateMessage);
    assert.equal(settingsSnapshots(aPosts).length, 1);
    assert.equal(settingsSnapshots(aPosts)[0].payload.settings.name, '改名后的标题');
    assert.equal(settingsSnapshots(otherAPosts).length, 1);
    assert.deepEqual(settingsSnapshots(otherAPosts)[0].payload.settings, settingsSnapshots(aPosts)[0].payload.settings);
    assert.deepEqual(settingsSnapshots(bPosts), []);
  } finally {
    bridge.close();
  }
});

test('只有全局广播能力时，会话更新仍只回复请求方', async () => {
  const requesterPosts = [];
  const unrelatedPosts = [];
  const otherPanel = webview(unrelatedPosts);
  const router = conversationUpdateRouter({ broadcast: (message) => { void otherPanel.postMessage(message); } });
  await router.dispatch('client-a', webview(requesterPosts), updateMessage);
  assert.equal(settingsSnapshots(requesterPosts).length, 1);
  assert.equal(settingsSnapshots(requesterPosts)[0].payload.settings.conversationId, 'conv-a');
  assert.deepEqual(unrelatedPosts, []);
});

test('已删除会话的读取错误携带 conversation scope 供视图按期望目标过滤', async () => {
  const posted = [];
  const router = new VscodeReliableKernelCommandRouter(productStub(), {});
  router.readConversationSettings = async () => undefined;
  await router.dispatch('client-deleted', webview(posted), {
    id: 'req-get-deleted',
    type: protocol.BridgeMessageType.ConversationSettingsGet,
    channel: 'command',
    payload: { conversationId: 'conv-deleted', section: 'common' }
  });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, protocol.BridgeMessageType.Error);
  assert.equal(posted[0].payload.code, 'stale_conversation');
  assert.equal(posted[0].scope.kind, 'settings');
  assert.equal(posted[0].scope.level, 'conversation');
  assert.equal(posted[0].scope.id, 'conv-deleted');
});

test('普通读取失败也携带原会话作用域，供导航后的视图拒绝迟到错误', { timeout: 2_000 }, async () => {
  const router = new VscodeReliableKernelCommandRouter(productStub(), {});
  router.readConversationSettings = async () => { throw new Error('fixture read failure'); };
  const errorMessage = await new Promise((resolve) => {
    router.handle('client-a', {
      async postMessage(message) {
        if (message.type === protocol.BridgeMessageType.Error) resolve(message);
        return true;
      }
    }, {
      id: 'request-failed-a',
      type: protocol.BridgeMessageType.ConversationSettingsGet,
      channel: 'settings',
      payload: { conversationId: 'conv-a', section: 'common' }
    });
  });
  await withConversationStores(async ({ storeA, storeB }) => {
    storeA.request('conv-a');
    storeB.request('conv-b');
    const statusB = storeB.status;
    const failure = { conversationId: errorMessage.scope?.id, message: errorMessage.payload.message };
    storeA.applyError(failure);
    storeB.applyError(failure);
    assert.equal(storeA.status, 'fixture read failure');
    assert.equal(storeB.status, statusB);
  });
});

test('按会话投递只到达绑定该会话的面板，已断开的面板不再接收', async () => {
  const bridge = new ReliableKernelWebviewFeedBridge({}, {});
  try {
    const aPosts = [];
    const bPosts = [];
    bridge.attach(webview(aPosts), { kind: 'mainPanel', conversationId: 'conv-a' });
    const clientB = bridge.attach(webview(bPosts), { kind: 'mainPanel', conversationId: 'conv-b' });

    bridge.postToConversation('conv-a', {
      id: 'snapshot-a-1',
      type: protocol.BridgeMessageType.ConversationSettingsSnapshot,
      channel: 'settings',
      scope: { kind: 'settings', level: 'conversation', id: 'conv-a' },
      payload: conversationSnapshot('conv-a', '会话A标题')
    });
    assert.equal(settingsSnapshots(aPosts).length, 1);
    assert.equal(settingsSnapshots(aPosts)[0].payload.settings.name, '会话A标题');
    assert.deepEqual(settingsSnapshots(bPosts), []);

    bridge.detach(clientB);
    bridge.postToConversation('conv-b', {
      id: 'snapshot-b-1',
      type: protocol.BridgeMessageType.ConversationSettingsSnapshot,
      channel: 'settings',
      scope: { kind: 'settings', level: 'conversation', id: 'conv-b' },
      payload: conversationSnapshot('conv-b', '会话B标题')
    });
    assert.deepEqual(settingsSnapshots(bPosts), []);
  } finally {
    bridge.close();
  }
});

const SCOPED_CONVERSATION_LAYERS = [
  ['modelProfiles', 'modelProfileScopeLinks', 'modelProfileId'],
  ['planReviewPolicies', 'planReviewPolicyScopeLinks', 'planReviewPolicyId'],
  ['toolPolicies', 'toolPolicyScopeLinks', 'toolPolicyId'],
  ['skillPolicies', 'skillPolicyScopeLinks', 'skillPolicyId'],
  ['systemPrompts', 'systemPromptScopeLinks', 'systemPromptId'],
  ['runtimeContexts', 'runtimeContextScopeLinks', 'runtimeContextId'],
  ['workEnvironmentPolicies', 'workEnvironmentPolicyScopeLinks', 'workEnvironmentPolicyId'],
  ['checkpointPolicies', 'checkpointPolicyScopeLinks', 'checkpointPolicyId']
];

test('分支复制对话层全部设置，只填目标空位，全局与 Agent 层不变', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-fork-settings-'));
  try {
    const configuration = new VscodeConfigurationAuthority(() =>
      createVscodeStoragePaths(vscodeStub.Uri.file(path.join(directory, 'configuration'))));
    const mutations = configuration.mutations;
    const folderPath = path.join(directory, 'workspace');
    await fs.mkdir(folderPath);
    const uri = vscodeStub.Uri.file(folderPath).toString();
    const environmentId = workEnvironmentIdFromUri(uri);
    await configuration.synchronizeWorkspaceFolders([{ uri, name: 'Fixture', rootPath: folderPath, index: 0 }]);
    const source = { scopeKind: 'conversation', scopeId: 'source' };
    await mutations.setModelProfile({ ...source, provider: 'openai', model: 'source-model' });
    await mutations.setPlanReviewPolicy({ ...source, mode: 'before_mutation', requireForToolRiskLevels: ['write'] });
    await mutations.setToolPolicy({
      ...source, allowedTools: ['read', 'run_agent'],
      toolConfigs: { run_agent: { config: { maxConcurrentAgents: 2 } } }
    });
    await mutations.setSkillPolicy({ ...source, name: 'Source skills' });
    await mutations.setSystemPrompt({ ...source, text: 'source prompt' });
    await mutations.setRuntimeContext({ ...source, template: 'source runtime context' });
    await mutations.setWorkEnvironmentPolicy({
      ...source, enabled: true, allowedWorkEnvironmentIds: [environmentId], defaultWorkEnvironmentId: environmentId
    });
    await mutations.setCheckpointPolicy({ ...source, enabled: false });
    await mutations.selectConversationWorkflow({ conversationId: 'source', scopeKind: 'global' });
    await mutations.selectConversationWorkEnvironment('source', environmentId);
    await mutations.setSystemPrompt({ scopeKind: 'global', text: 'global prompt' });
    await mutations.setToolPolicy({ scopeKind: 'agent', scopeId: 'agent-fixture', allowedTools: ['read'] });
    // The target already owns one Conversation-layer value; the copy must never replace it.
    await mutations.setSystemPrompt({ scopeKind: 'conversation', scopeId: 'target', text: 'target prompt' });
    const before = await configuration.configurationClientState();

    await mutations.copyConversationConfiguration('source', 'target');
    await mutations.copyConversationConfiguration('source', 'target');
    const after = await configuration.configurationClientState();

    const conversationLinks = (state, key, scopeId) => state[key].filter(link =>
      link.scopeKind === 'conversation' && link.scopeId === scopeId);
    for (const [recordsKey, linksKey, recordField] of SCOPED_CONVERSATION_LAYERS) {
      const [sourceLink] = conversationLinks(after, linksKey, 'source');
      const targetLinks = conversationLinks(after, linksKey, 'target');
      assert.equal(targetLinks.length, 1, `${linksKey} target owns exactly one Conversation-layer link`);
      const sourceRecord = after[recordsKey].find(record => record.id === sourceLink[recordField]);
      const targetRecord = after[recordsKey].find(record => record.id === targetLinks[0][recordField]);
      assert.notEqual(targetRecord.id, sourceRecord.id, `${recordsKey} target edits must not change the source`);
      if (recordsKey === 'systemPrompts') {
        assert.equal(targetRecord.text, 'target prompt', 'an existing target value wins');
        continue;
      }
      const { id: sourceId, ...sourceValue } = sourceRecord;
      const { id: targetId, ...targetValue } = targetRecord;
      assert.deepEqual(targetValue, sourceValue, `${recordsKey} is copied completely`);
    }
    const targetTools = after.toolPolicies.find(record =>
      record.id === conversationLinks(after, 'toolPolicyScopeLinks', 'target')[0].toolPolicyId);
    assert.deepEqual(targetTools.toolConfigs.run_agent, { config: { maxConcurrentAgents: 2 } });
    assert.equal(after.conversationWorkflowSelections.filter(item => item.conversationId === 'target').length, 1);
    assert.equal(after.conversationWorkflowSelections.find(item => item.conversationId === 'target').scopeKind, 'global');
    assert.deepEqual(after.conversationWorkEnvironmentLinks
      .filter(item => item.conversationId === 'target').map(item => item.workEnvironmentId), [environmentId]);

    const outsideTarget = state => Object.fromEntries(SCOPED_CONVERSATION_LAYERS.flatMap(([recordsKey, linksKey, recordField]) => {
      const links = state[linksKey].filter(link => !(link.scopeKind === 'conversation' && link.scopeId === 'target'));
      const recordIds = new Set(links.map(link => link[recordField]));
      return [[linksKey, links], [recordsKey, state[recordsKey].filter(record => recordIds.has(record.id))]];
    }));
    assert.deepEqual(outsideTarget(after), outsideTarget(before), 'source, global and Agent layers stay unchanged');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function createVscodeStub() {
  class Uri {
    constructor(fsPath) { this.scheme = 'file'; this.fsPath = path.resolve(fsPath); this.path = this.fsPath.split(path.sep).join('/'); }
    static file(value) { return new Uri(value); }
    static joinPath(base, ...parts) { return new Uri(path.join(base.fsPath, ...parts)); }
    toString() { return `file://${this.path}`; }
  }
  const FileType = { Unknown: 0, File: 1, Directory: 2 };
  return { Uri, FileType, window: { async showWarningMessage() {} }, workspace: { fs: {
    async createDirectory(uri) { await fs.mkdir(uri.fsPath, { recursive: true }); },
    async readFile(uri) { return fs.readFile(uri.fsPath); },
    async writeFile(uri, bytes) { await fs.mkdir(path.dirname(uri.fsPath), { recursive: true }); await fs.writeFile(uri.fsPath, bytes); },
    async readDirectory(uri) { return (await fs.readdir(uri.fsPath, { withFileTypes: true })).map(entry => [entry.name, entry.isDirectory() ? FileType.Directory : FileType.File]); },
    async delete(uri) { await fs.rm(uri.fsPath, { recursive: true, force: true }); },
    async stat(uri) { const stat = await fs.stat(uri.fsPath); return { type: stat.isDirectory() ? FileType.Directory : FileType.File, ctime: stat.ctimeMs, mtime: stat.mtimeMs, size: stat.size }; }
  } } };
}
