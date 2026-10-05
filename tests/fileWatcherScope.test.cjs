const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

class MockUri {
  constructor(uriPath) {
    this.path = String(uriPath).replace(/\/{2,}/g, '/');
  }

  static joinPath(base, ...segments) {
    return new MockUri([base.path.replace(/\/$/, ''), ...segments].join('/'));
  }

  toString() {
    return `file://${this.path}`;
  }
}

class MockRelativePattern {
  constructor(base, pattern) {
    this.baseUri = base;
    this.pattern = pattern;
  }
}

const createdPatterns = [];
const createdWatchers = [];
const vscodeMock = {
  Uri: MockUri,
  RelativePattern: MockRelativePattern,
  workspace: {
    fs: {},
    createFileSystemWatcher(relativePattern) {
      createdPatterns.push(relativePattern);
      const listeners = {};
      const watcher = {
        pattern: relativePattern,
        listeners,
        onDidCreate(listener) { listeners.create = listener; },
        onDidChange(listener) { listeners.change = listener; },
        onDidDelete(listener) { listeners.delete = listener; },
        dispose() {}
      };
      createdWatchers.push(watcher);
      return watcher;
    }
  }
};

const previousTsLoader = require.extensions['.ts'];
const originalModuleLoad = Module._load;
require.extensions['.ts'] = function transpileTypeScript(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true
    },
    fileName: filename
  }).outputText;
  module._compile(output, filename);
};
Module._load = function loadWithVscodeMock(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { registerGlobalSettingsWatcher, sectionFromSettingsUri } = require('../vscode/watchers/GlobalSettingsWatcher.ts');

Module._load = originalModuleLoad;
if (previousTsLoader) require.extensions['.ts'] = previousTsLoader;
else delete require.extensions['.ts'];

test('设置监听只从 settings 和三个配置小目录开始', () => {
  createdPatterns.length = 0;
  const subscriptions = [];
  registerGlobalSettingsWatcher({
    globalStorageUri: new MockUri('/canonical-storage'),
    subscriptions
  }, {
    getStorageRootUri() {
      return new MockUri('/custom-data');
    },
    async refreshGlobalSettings() {}
  });

  assert.equal(subscriptions.length, 1);
  assert.deepEqual(createdPatterns.map((entry) => ({
    base: entry.baseUri.path,
    pattern: entry.pattern
  })), [
    {
      base: '/custom-data/settings',
      pattern: '{llm,llm-compression,appearance,attachments,checkpoint-maintenance,debug-capture}.json'
    },
    { base: '/custom-data/settings/llm-provider-configs', pattern: '{index.json,records/*.json}' },
    { base: '/custom-data/settings/llm-compression-configs', pattern: '{index.json,records/*.json}' },
    { base: '/custom-data/settings/mcp-servers', pattern: '{index.json,records/*.json}' },
    { base: '/canonical-storage', pattern: '.limcode-global-status.json' }
  ]);
  assert.equal(createdPatterns.some((entry) => entry.baseUri.path === '/custom-data'), false,
    '不得再从整个插件数据目录递归监听');
  subscriptions.forEach((subscription) => subscription.dispose());
});

const recordStoreSections = [
  ['llm-provider-configs', 'llmProviderConfigs'],
  ['llm-compression-configs', 'llmCompressionConfigs'],
  ['mcp-servers', 'mcpServers']
];
const lockOwnerPaths = [
  'index.json.lock/owner.json',
  'index.json.lock.candidate-test-owner/owner.json',
  'index.json.lock.generation-owner-test-owner/owner.json'
];

test('记录设置只接受持久索引和直接记录，不把读锁与临时文件当作修改', () => {
  for (const [directory, section] of recordStoreSections) {
    const root = `/custom-data/settings/${directory}`;
    for (const file of ['index.json', 'records/config.json']) {
      assert.equal(sectionFromSettingsUri(new MockUri(`${root}/${file}`)), section);
    }
    for (const file of [
      ...lockOwnerPaths, 'owner.json', 'index.json.tmp', 'records/config.json.tmp',
      'records/nested/config.json', 'records/config.json.lock/owner.json'
    ]) {
      assert.equal(sectionFromSettingsUri(new MockUri(`${root}/${file}`)), undefined, file);
    }
  }
});

test('外部设置创建修改删除仍刷新，刷新产生的读锁事件不会循环', (context) => {
  const timers = new Map();
  let timerId = 0;
  context.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    assert.equal(delay, 180);
    timers.set(++timerId, callback);
    return timerId;
  });
  context.mock.method(globalThis, 'clearTimeout', (id) => timers.delete(id));
  const flush = () => {
    const callbacks = [...timers.values()];
    timers.clear();
    callbacks.forEach((callback) => callback());
    return callbacks.length;
  };
  const offset = createdWatchers.length;
  const subscriptions = [];
  const refreshed = [];
  registerGlobalSettingsWatcher({
    globalStorageUri: new MockUri('/canonical-storage'), subscriptions
  }, {
    getStorageRootUri: () => new MockUri('/custom-data'),
    async refreshGlobalSettings(section) {
      refreshed.push(section);
      const store = recordStoreSections.find((entry) => entry[1] === section);
      if (!store) return;
      const watcher = createdWatchers.slice(offset).find((entry) => entry.pattern.baseUri.path.endsWith(`/${store[0]}`));
      // Exercise the callback guard too, even if a filesystem reports a broad directory event.
      for (const file of lockOwnerPaths) {
        for (const event of ['create', 'change', 'delete']) {
          watcher.listeners[event](MockUri.joinPath(watcher.pattern.baseUri, file));
        }
      }
    }
  });
  context.after(() => subscriptions.forEach((subscription) => subscription.dispose()));
  const watchers = createdWatchers.slice(offset);
  for (const event of ['create', 'change', 'delete']) {
    for (const [directory, section] of recordStoreSections) {
      const watcher = watchers.find((entry) => entry.pattern.baseUri.path.endsWith(`/${directory}`));
      for (const file of ['index.json', 'records/config.json']) {
        const count = refreshed.length;
        watcher.listeners[event](MockUri.joinPath(watcher.pattern.baseUri, file));
        assert.equal(flush(), 1);
        assert.deepEqual(refreshed.slice(count), [section]);
        assert.equal(flush(), 0, '读锁事件不得触发后续刷新');
      }
    }
    const rootWatcher = watchers[0];
    const rootSections = [
      ['llm.json', 'llm'], ['llm-compression.json', 'llmCompression'],
      ['appearance.json', 'appearance'], ['attachments.json', 'attachments'],
      ['checkpoint-maintenance.json', 'checkpointMaintenance'], ['debug-capture.json', 'debugCapture']
    ];
    const count = refreshed.length;
    for (const [file] of rootSections) {
      rootWatcher.listeners[event](MockUri.joinPath(rootWatcher.pattern.baseUri, file));
    }
    assert.equal(flush(), 1, '同批根设置事件仍合并刷新');
    assert.deepEqual(refreshed.slice(count), rootSections.map((entry) => entry[1]));
    const statusWatcher = watchers.at(-1);
    statusWatcher.listeners[event](MockUri.joinPath(statusWatcher.pattern.baseUri, '.limcode-global-status.json'));
    assert.equal(flush(), 1);
    assert.equal(refreshed.at(-1), 'common');
    assert.equal(flush(), 0);
  }
});

test('侧栏不再创建旧的会话历史文件监听', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'vscode/views/SidebarEntryView.ts'), 'utf8');
  assert.doesNotMatch(source, /createFileSystemWatcher/);
  assert.doesNotMatch(source, /getConversationHistoryRootUri/);
});

test('调试默认设置复用设置监听，不把取证正文纳入监听', () => {
  assert.equal(sectionFromSettingsUri(new MockUri('/custom-data/settings/debug-capture.json')), 'debugCapture');
  assert.equal(sectionFromSettingsUri(new MockUri('/custom-data/diagnostics/debug-captures/record/events.jsonl')), undefined);
});
