const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const ts = require('typescript');

function source(relative, dependencies = {}, expose = []) {
  const file = path.resolve(__dirname, '../..', relative);
  const output = { exports: {} };
  const requireSource = name => {
    if (Object.hasOwn(dependencies, name)) return dependencies[name];
    if (name.startsWith('.')) {
      const target = path.resolve(path.dirname(file), name);
      if (fs.existsSync(`${target}.ts`)) return source(path.relative(path.resolve(__dirname, '../..'), `${target}.ts`), dependencies);
    }
    return require(name);
  };
  const text = fs.readFileSync(file, 'utf8');
  const script = relative.endsWith('.vue') ? text.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1] : text;
  const input = script + (expose.length ? `\nmodule.exports = { ${expose.join(', ')} };` : '');
  vm.runInNewContext(ts.transpileModule(input, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText, { module: output, exports: output.exports, require: requireSource, process, Buffer, console, setTimeout, clearTimeout, AbortController, defineProps: dependencies.defineProps, withDefaults: (props, defaults) => ({ ...defaults, ...props }) });
  return output.exports;
}
const catalog = source('shared/workEnvironmentCatalog.ts');
const selection = source('shared/workEnvironmentSelection.ts');
const boundary = source('backend/reliableKernel/workEnvironmentBoundary.ts');
const local = name => catalog.createLocalFolderWorkEnvironmentRecord({ name, uri: `file:///workspace/${name}`, rootPath: `/workspace/${name}`, available: true });
const A = local('A');
const B = local('B');
const remote = catalog.createRemoteServerWorkEnvironmentRecord({ id: 'remote', host: 'example.invalid' });
const environments = [A, B, remote];
const policy = { allowedWorkEnvironmentIds: environments.map(record => record.id), defaultWorkEnvironmentId: A.id };

function plain(value) { return JSON.parse(JSON.stringify(value)); }

test('shared selection honors explicit, inherited, project, default and singleton without order fallback', () => {
  const resolve = extra => selection.resolveWorkEnvironmentSelection({ environments, policy, project: { uri: B.uri }, ...extra });
  assert.equal(resolve({}).active.id, B.id);
  assert.equal(resolve({ explicitWorkEnvironmentId: remote.id }).active.id, remote.id);
  assert.equal(resolve({ inheritedPolicy: { ...policy, defaultWorkEnvironmentId: remote.id } }).active.id, remote.id);
  assert.equal(resolve({ project: undefined }).active.id, A.id);
  assert.match(resolve({ policy: { allowedWorkEnvironmentIds: [A.id] } }).error, /未获当前策略允许/);
  assert.match(resolve({ environments: [A, { ...B, available: false }] }).error, /不可用/);
  assert.match(resolve({ project: undefined, policy: { allowedWorkEnvironmentIds: [B.id, A.id] } }).error, /多个工作环境/);
  assert.equal(resolve({ environments: [B], project: undefined, policy: undefined }).active.id, B.id);
  assert.match(resolve({ explicitWorkEnvironmentId: 'deleted' }).error, /不存在/);
  // A starting directory (a user-approved Plan's planning directory) narrows nothing and is used only
  // while this choice's own list admits it; otherwise the usual order applies without an error.
  const preferred = resolve({ preferredWorkEnvironmentId: remote.id });
  assert.equal(preferred.active.id, remote.id);
  assert.deepEqual(plain(preferred.allowed.map(record => record.id)), policy.allowedWorkEnvironmentIds);
  assert.equal(resolve({ explicitWorkEnvironmentId: A.id, preferredWorkEnvironmentId: remote.id }).active.id, A.id);
  const outside = resolve({ policy: { allowedWorkEnvironmentIds: [A.id, B.id] }, preferredWorkEnvironmentId: remote.id });
  assert.equal(outside.active.id, B.id);
  assert.equal(outside.error, undefined);
  assert.equal(resolve({ preferredWorkEnvironmentId: 'deleted' }).active.id, B.id);
});

test('frozen default cannot fall into another allowed environment after removal', () => {
  const frozen = { enabled: false, allowedWorkEnvironmentIds: [A.id, B.id], defaultWorkEnvironmentId: B.id };
  assert.equal(boundary.resolveFrozenWorkEnvironmentBoundary(frozen, [A, B]).active.id, B.id);
  assert.throws(() => boundary.resolveFrozenWorkEnvironmentBoundary(frozen, [A]), /已不可用/);
  assert.equal(boundary.resolveFrozenWorkEnvironmentBoundary({ ...frozen, defaultWorkEnvironmentId: null }, [A]).active, undefined);
});

test('commandRunner executes its selected B root and rejects missing selection instead of using allowed A', async () => {
  const spawned = [];
  const { createCommandCapability } = source('backend/capabilities/commandRunner.ts', {
    'node:child_process': { spawn(executable, args, options) {
      spawned.push({ executable, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { end() {} };
      child.stdout.setEncoding = () => {}; child.stderr.setEncoding = () => {};
      queueMicrotask(() => child.emit('close', 0));
      return child;
    } },
    './backgroundProcessManager': { BackgroundProcessManager: class { dispose() {} } },
    './workEnvironmentProvider': { isRemoteServerCommandEnvironment: () => false },
    './windowsPowerShell': { resolveWindowsPowerShell: () => ({ executable: 'powershell', edition: 'windows-powershell' }), powerShellCommandSyntaxGuidance: () => '' }
  });
  const command = createCommandCapability();
  const result = await command.run({ command: 'pwd' }, undefined, { workEnvironment: B, accessibleWorkEnvironments: [A, B] });
  assert.equal(result.exitCode, 0);
  assert.equal(spawned[0].options.cwd, B.rootPath);
  const noSelection = await command.run({ command: 'pwd' }, undefined, { accessibleWorkEnvironments: [A] });
  assert.match(noSelection.stderr, /明确且可用/);
  const removed = await command.run({ command: 'pwd' }, undefined, { workEnvironment: { ...B, available: false }, accessibleWorkEnvironments: [A] });
  assert.match(removed.stderr, /不可用/);
  assert.equal(spawned.length, 1);
});

function makeStore() {
  const state = { workEnvironments: [A, B], workEnvironmentPolicies: [{ id: 'policy', enabled: false, ...policy }],
    workEnvironmentPolicyScopeLinks: [{ id: 'policy-link', scopeKind: 'global', role: 'active', workEnvironmentPolicyId: 'policy', createdAt: 1, updatedAt: 1 }],
    conversationWorkEnvironmentLinks: [], conversationWorkflowSelections: [], agents: [] };
  const feed = { records: { ConversationProjectLink: { link: { conversation_id: 'conversation', project_context_id: 'project-b', role: 'primary' } }, ProjectContext: { 'project-b': { uri: B.uri } } }, projections: {} };
  const { useWorkEnvironmentStore } = source('webview/src/stores/useWorkEnvironmentStore.ts', {
    pinia: { defineStore(_id, definition) {
      const store = { ...definition.state() };
      for (const [name, getter] of Object.entries(definition.getters)) Object.defineProperty(store, name, { get: () => getter.call(store) });
      for (const [name, action] of Object.entries(definition.actions)) store[name] = action.bind(store);
      return () => store;
    } },
    '@shared/protocol': { createMessageId: () => 'fixture' },
    '@shared/workEnvironmentCatalog': catalog,
    '@shared/workEnvironmentSelection': selection,
    '@webview/transport': { bridge: { request() {} }, BridgeMessageType: {} },
    './useClientStateStore': { useClientStateStore: () => state },
    './useReliableKernelClientFeedStore': { useReliableKernelClientFeedStore: () => feed },
    './useAgentStore': { useAgentStore: () => ({ activeAgentForConversation: () => undefined }) },
    './useWorkflowStore': { DEFAULT_WORKFLOW_OPTION_ID: 'global', useWorkflowStore: () => ({ activeWorkflowIdForConversation: () => 'global' }) }
  });
  return { state, feed, store: useWorkEnvironmentStore() };
}

test('composer store resolves B with switching disabled and separately reads child frozen remote authority', () => {
  const { store, state, feed } = makeStore();
  assert.equal(store.workEnvironmentEnabledForConversation('conversation'), false);
  assert.equal(store.activeEnvironmentForConversation('conversation').id, B.id);
  state.workEnvironments.push(remote);
  feed.projections.activeConversationWindow = { activeTurnWorkEnvironment: { conversationId: 'conversation', turnId: 'child-turn', enabled: false, allowedWorkEnvironmentIds: [remote.id], defaultWorkEnvironmentId: remote.id } };
  assert.equal(store.frozenEnvironmentSelectionForConversation('conversation').active.id, remote.id);
  assert.equal(store.activeEnvironmentForConversation('conversation').id, B.id);
  state.workEnvironments = state.workEnvironments.filter(record => record.id !== B.id);
  assert.match(store.environmentSelectionForConversation('conversation').error, /不存在/);
  feed.projections.activeConversationWindow.activeTurnWorkEnvironment = null;
  feed.records.Turn = { turn: { conversation_id: 'conversation', status: 'active' } };
  assert.match(store.frozenEnvironmentSelectionForConversation('conversation').error, /信息不可用/);
});

test('ProductRuntime subscribes once, captures complete add/remove/reorder snapshots and broadcasts after sync', async () => {
  let listener, subscriptions = 0, disposed = 0;
  const workspace = { workspaceFolders: [], onDidChangeWorkspaceFolders(callback) { listener = callback; subscriptions += 1; return { dispose() { disposed += 1; } }; } };
  const imports = fs.readFileSync(path.resolve(__dirname, '../../backend/application/reliableKernel/VscodeReliableKernelProductRuntime.ts'), 'utf8');
  const dependencies = Object.fromEntries([...imports.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => [match[1], {}]));
  dependencies.vscode = { workspace, window: { showErrorMessage() {} } };
  dependencies['./ExternalDataVersionWatcher'] = { ExternalDataVersionWatcher: class { cancel() {} async stop() {} } };
  const { VscodeReliableKernelProductRuntime } = source('backend/application/reliableKernel/VscodeReliableKernelProductRuntime.ts', dependencies);
  const observed = [], broadcasts = [];
  let queue = Promise.resolve();
  const runtime = new VscodeReliableKernelProductRuntime({
    application: { database: {}, async beginHandoff() {}, async close() {} },
    configuration: { mutations: { retireModelProfileAuthority() {} }, synchronizeWorkspaceFolders(folders) {
      return queue = queue.then(async () => { observed.push(plain(folders)); });
    } },
    toolHost: { async dispose() {} }, childAgents: { async dispose() {} }, fileDiffs: { dispose() {} },
    conversations: { dispose() {}, async waitForIdle() {} }, diagnostics: { async close() {} }, debugCapture: { async close() {} },
    initializeConfiguration: async () => undefined,
    onConfigurationChanged: () => { broadcasts.push(observed.length); }
  });
  const folder = record => ({ name: record.name, uri: { fsPath: record.rootPath, toString: () => record.uri } });
  workspace.workspaceFolders = [folder(A), folder(B)]; listener({});
  workspace.workspaceFolders = [folder(B), folder(A)]; listener({});
  workspace.workspaceFolders = [folder(A)]; listener({});
  await runtime.workspaceFoldersChangeTask;
  assert.equal(subscriptions, 1);
  assert.deepEqual(observed.map(folders => folders.map(record => record.name)), [['A', 'B'], ['B', 'A'], ['A']]);
  assert.deepEqual(observed[1].map(record => record.index), [0, 1]);
  assert.equal(broadcasts.length, 3);
  await runtime.close();
  assert.equal(disposed, 1);
});


test('policy editor preserves an unset default and other Host allowances until an explicit choice', () => {
  const calls = [];
  let policy = { id: 'policy', enabled: true, allowedWorkEnvironmentIds: [A.id, B.id, remote.id] };
  const store = {
    availableEnvironments: [A, B],
    effectivePolicyFor: () => ({ policy }), localPolicyFor: () => ({ policy }),
    setPolicyForScope: (...args) => calls.push(args)
  };
  const relative = 'webview/src/components/settings/workEnvironment/WorkEnvironmentPolicyEditor.vue';
  const text = fs.readFileSync(path.resolve(__dirname, '../..', relative), 'utf8');
  const dependencies = Object.fromEntries([...text.matchAll(/from ['"]([^'"]+)['"]/g)].map(match => [match[1], {}]));
  Object.assign(dependencies, {
    defineProps: () => ({ scopeKind: 'global' }),
    vue: { ref: value => ({ value }), computed: fn => ({ get value() { return fn(); } }), watch() {} },
    '@shared/workEnvironmentCatalog': catalog,
    '@webview/stores/useWorkEnvironmentStore': { useWorkEnvironmentStore: () => store },
    './creationActions': { WORK_ENVIRONMENT_CREATE_ACTIONS: [] },
    '@webview/composables/useSettingsLoading': { useSettingsLoadingText: () => ({}) }
  });
  const editor = source(relative, dependencies, ['defaultEnvironmentId', 'setPolicyEnabled', 'toggleAllowed', 'clearDefault']);
  assert.equal(editor.defaultEnvironmentId.value, '');
  editor.setPolicyEnabled(false);
  assert.deepEqual(plain(calls.at(-1)[2]), [A.id, B.id, remote.id]);
  assert.equal(calls.at(-1)[3], undefined);
  policy = { ...policy, defaultWorkEnvironmentId: B.id };
  editor.toggleAllowed(B, false);
  assert.deepEqual(plain(calls.at(-1)[2]), [A.id, remote.id]);
  assert.equal(calls.at(-1)[3], undefined);
  editor.clearDefault();
  assert.equal(calls.at(-1)[3], undefined);
});


test('failed workspace initialization is retryable after a folder event while success remains deduplicated', async () => {
  const code = fs.readFileSync(path.resolve(__dirname, '../../backend/application/reliableKernel/VscodeReliableKernelProductRuntime.ts'), 'utf8');
  const initializer = code.slice(code.indexOf('    let configurationInitialization:'), code.indexOf('    let authority = options.authority;'));
  const createInitializer = new Function('configuration', 'currentWorkspaceFolders', ts.transpileModule(
    initializer + '\nreturn initializeConfiguration;', { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
  ).outputText);
  let folders = [A], calls = 0, release;
  const observed = [];
  const initialize = createInitializer({ synchronizeWorkspaceFolders(snapshot) {
    observed.push(snapshot);
    calls += 1;
    if (calls === 1) return Promise.reject(new Error('initial synchronization failed'));
    return new Promise(resolve => { release = resolve; });
  } }, () => folders);
  await assert.rejects(initialize(), /initial synchronization failed/);
  folders = [B];
  const recovered = initialize();
  assert.equal(initialize(), recovered);
  assert.equal(calls, 2);
  assert.equal(observed[1][0].id, B.id);
  release();
  await recovered;
  assert.equal(initialize(), recovered);
  assert.equal(calls, 2);
});
