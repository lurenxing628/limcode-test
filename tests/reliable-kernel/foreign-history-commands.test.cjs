const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');

/** Loads vscode/commands/foreignRuntimeHistory.ts with every dependency replaced by a recording fake. */
function loadCommand(dependencies) {
  const filename = path.resolve(__dirname, '../../vscode/commands/foreignRuntimeHistory.ts');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText, {
    module, exports: module.exports, console, process,
    require(name) {
      if (!Object.prototype.hasOwnProperty.call(dependencies, name)) throw new Error(`Unexpected source dependency: ${name}`);
      return dependencies[name];
    }
  }, { filename });
  return module.exports;
}

const ROOT = '/data/limcode';
const plain = (value) => JSON.parse(JSON.stringify(value));

function entry(overrides) {
  return {
    id: 'foreign:archive:0123456789abcdef', name: '20260901-010203-004-abcdef12', scope: 'default',
    location: {
      kind: 'archive', containerPath: `${ROOT}/.limcode-runtime-backups/20260901-010203-004-abcdef12`,
      containerName: '.limcode-runtime-backups/20260901-010203-004-abcdef12', dataRootRelativePath: 'active'
    },
    status: 'verified', locatedPath: `${ROOT}/.limcode-runtime-backups/20260901-010203-004-abcdef12/active`,
    recordedDataRootPath: `${ROOT}/.limcode-runtime/active`, dataSetId: 'data-set-a', rootInstanceId: 'instance-a', runtimeKernelEpoch: 5,
    size: { bytes: '4096', fileCount: 3 }, summary: { projectNames: ['alpha'], conversationCount: 2, lastActivityAt: '2026-09-01T01:02:03.000Z' },
    ...overrides
  };
}

const COPIED = entry({
  id: 'foreign:copied:fedcba9876543210', name: 'limcode.limcode-copied-2026-09-02T01-02-03-004Z-12345678',
  location: {
    kind: 'copied', side: 'current', baseDataRootPath: ROOT, containerPath: '/data/limcode.limcode-copied-2026-09-02T01-02-03-004Z-12345678',
    containerName: 'limcode.limcode-copied-2026-09-02T01-02-03-004Z-12345678', dataRootRelativePath: '.limcode-runtime/active'
  },
  status: 'failed', code: 'foreign-history-epoch-not-current', reason: '它是已发布的旧格式（第 4 代）。当前版本只在数据目录自己的历史库上先备份再升级旧格式，不升级从别处拷来的目录，所以不能在这里打开它。它原样保留，不会被删除。',
  locatedPath: '/data/limcode.limcode-copied-2026-09-02T01-02-03-004Z-12345678/.limcode-runtime/active', size: { bytes: '8192', fileCount: 5 },
  summary: undefined
});

function fixture({ entries = [entry(), entry({ id: 'foreign:archive:1111111111111111', duplicateOf: 'foreign:archive:0123456789abcdef' }), COPIED,
  entry({ id: 'foreign:copied:2222222222222222', status: 'unavailable', code: 'foreign-history-copy-failed', reason: '暂时无法核验：复制数据库到私有临时目录失败（ENOSPC）。', summary: undefined })],
picks = [], warnings = [], infos = [], discovered = [] } = {}) {
  const calls = [];
  const state = new Map();
  const context = { globalState: { get: (key) => state.get(key), update: async (key, value) => { state.set(key, value); } } };
  const vscode = {
    ProgressLocation: { Notification: 15 },
    Uri: { file: (fsPath) => ({ scheme: 'file', fsPath }) },
    commands: { executeCommand: async (...args) => { calls.push(['command', ...plain(args)]); } },
    window: {
      withProgress: async (options, task) => { calls.push(['progress', options.title]); return task({ report() {} }); },
      async showQuickPick(items, options) {
        calls.push(['pick', plain(items), options?.placeHolder]);
        const next = picks.shift();
        return typeof next === 'function' ? next(items) : typeof next === 'number' ? items[next] : next;
      },
      async showWarningMessage(message, ...items) { calls.push(['warning', message, ...items]); return warnings.shift(); },
      async showInformationMessage(message, ...items) { calls.push(['info', message, ...items]); return infos.shift(); },
      async showErrorMessage(message) { calls.push(['error', message]); }
    }
  };
  const located = { id: 'located-root' };
  const command = loadCommand({
    vscode,
    '../../backend/capabilities/vscodeStorage/globalStatus': {
      loadCommittedGlobalStatus: async () => ({ lastMigration: { fromPath: '/old/limcode', toPath: ROOT, migratedAt: '2026-09-01' } }),
      resolveDataRootUri: () => ({ fsPath: ROOT })
    },
    '../../backend/capabilities/vscodeStorage/paths': { createVscodeStoragePaths: (uri) => ({ globalStoragePath: uri.fsPath }) },
    '../../backend/reliableKernel/runtimeDataSetHistory': {
      openRuntimeDataSetHistory: async (paths, root) => { calls.push(['open-history', plain(paths), root.id]); return { history: true }; }
    },
    '../../backend/reliableKernel/runtimeForeignHistory': {
      discoverForeignRuntimeHistory: async (input) => { calls.push(['discover', plain(input)]); return discovered.shift() ?? []; },
      inspectForeignRuntimeHistory: async (input) => {
        calls.push(['inspect', input.configurationRootPath, input.previousDataRootPath]);
        input.onProgress?.(1, entries.length);
        return { configurationRootPath: ROOT, checkedAt: '2026-09-27T00:00:00.000Z', entries };
      },
      locateForeignRuntimeRoot: async (configurationRootPath, location) => { calls.push(['locate', configurationRootPath, plain(location)]); return located; },
      inspectForeignRuntimeStorage: async (paths, root) => {
        calls.push(['storage', plain(paths), root.id]);
        const size = (bytes, fileCount) => ({ bytes, fileCount });
        return { candidateId: 'x', dataSetId: 'data-set-a', observedAt: 'now', selected: false, archiveReclaimsBytes: false,
          categories: { sqlite: size('1024', 1), cas: size('2048', 1), casTemporary: size('0', 0), processSpool: size('0', 0), diagnostics: size('0', 0), other: size('1024', 1), historicalBackups: size('0', 0) },
          total: size('4096', 3) };
      }
    },
    './runtimeDataSetManagement': {
      browseRuntimeHistory: async (_context, label, open, source) => { calls.push(['browse', label, source]); calls.push(['opened', plain(await open())]); },
      formatBytes: (value) => `${value} B`,
      showReadOnly: async (_context, title, text) => { calls.push(['read-only', title, text]); }
    }
  });
  return { command, calls, context, state };
}

test('外来历史库列表：核验通过的注明来源、原位置和“以后的版本支持合并”，完全相同的拷贝折叠；未通过和暂时无法核验的列出位置、大小与原因', async () => {
  const f = fixture({ picks: [undefined] });
  await f.command.manageForeignRuntimeHistory(f.context);
  assert.deepEqual(f.calls.find((call) => call[0] === 'inspect'), ['inspect', ROOT, '/old/limcode']);
  const [, items, placeHolder] = f.calls.find((call) => call[0] === 'pick');
  assert.match(placeHolder, /只读；以后的版本支持合并/);
  assert.equal(items.length, 3, '完全相同的拷贝只显示一份');
  const [archive, copied, unavailable] = items;
  assert.equal(archive.label, '归档 · 20260901-010203-004-abcdef12');
  assert.match(archive.description, /2 个对话 · 最后活动 2026-09-01 01:02 · alpha · 4096 B（3 个文件）/);
  assert.match(archive.detail, /位置：\/data\/limcode\/\.limcode-runtime-backups\/20260901-010203-004-abcdef12\/active/);
  assert.match(archive.detail, /原位置：\/data\/limcode\/\.limcode-runtime\/active/);
  assert.match(archive.detail, /只读；以后的版本支持合并/);
  assert.match(archive.detail, /另有 1 份完全相同的拷贝/);
  assert.equal(copied.label, '未通过核验 · 从别处拷来 · limcode.limcode-copied-2026-09-02T01-02-03-004Z-12345678');
  assert.equal(copied.description, '8192 B（5 个文件）');
  assert.match(copied.detail, /原因：它是已发布的旧格式（第 4 代）/);
  assert.match(copied.detail, /原样保留，不会自动删除/);
  assert.match(unavailable.label, /^暂时无法核验 · /);
  assert.match(unavailable.detail, /暂时无法核验：复制数据库到私有临时目录失败/);
});

test('选中未通过的外来库：说明原因与位置，只提供“打开所在文件夹”，不删除', async () => {
  const f = fixture({ picks: [1, undefined], warnings: ['打开所在文件夹'] });
  await f.command.manageForeignRuntimeHistory(f.context);
  const warning = f.calls.find((call) => call[0] === 'warning');
  assert.match(warning[1], /没有通过核验：它是已发布的旧格式/);
  assert.match(warning[1], /原样保留，不会被自动删除/);
  assert.deepEqual(warning.slice(2), ['打开所在文件夹']);
  assert.deepEqual(f.calls.find((call) => call[0] === 'command'),
    ['command', 'revealFileInOS', { scheme: 'file', fsPath: COPIED.location.containerPath }]);
  assert.equal(f.calls.some((call) => ['browse', 'storage', 'locate'].includes(call[0])), false);
});

test('选中核验通过的外来库：只读查看经 located 根打开历史，存储占用写明原位置只作记录', async () => {
  const f = fixture({ picks: [0, (items) => items.find((item) => item.action === 'read'), 0, (items) => items.find((item) => item.action === 'storage'), undefined] });
  await f.command.manageForeignRuntimeHistory(f.context);
  const actions = f.calls.filter((call) => call[0] === 'pick')[1];
  assert.deepEqual(actions[1].map((item) => item.label), ['只读查看', '查看存储占用', '打开所在文件夹']);
  assert.match(actions[2], /只读；以后的版本支持合并/);
  assert.deepEqual(f.calls.find((call) => call[0] === 'browse'), ['browse', '归档 · 20260901-010203-004-abcdef12', '外来历史库']);
  assert.deepEqual(f.calls.filter((call) => call[0] === 'locate').map((call) => call.slice(1)), [
    [ROOT, entry().location], [ROOT, entry().location]
  ]);
  assert.deepEqual(f.calls.find((call) => call[0] === 'open-history'), ['open-history', { globalStoragePath: ROOT }, 'located-root']);
  assert.deepEqual(f.calls.find((call) => call[0] === 'storage'), ['storage', { globalStoragePath: ROOT }, 'located-root']);
  const [, title, text] = f.calls.find((call) => call[0] === 'read-only');
  assert.equal(title, '外来历史库占用');
  assert.match(text, /原位置（只作记录，不会访问）：\/data\/limcode\/\.limcode-runtime\/active/);
  assert.match(text, /SQLite 数据库：1 个文件，1024 B/);
  assert.match(text, /合计：3 个文件，4096 B/);
});

test('上一个数据目录里的归档注明来源', async () => {
  const previous = entry({
    location: {
      kind: 'archive', side: 'previous', baseDataRootPath: '/old/limcode',
      containerPath: '/old/limcode/.limcode-runtime-backups/20260901-010203-004-abcdef12',
      containerName: 'limcode/.limcode-runtime-backups/20260901-010203-004-abcdef12', dataRootRelativePath: 'active'
    }
  });
  const f = fixture({ entries: [previous], picks: [undefined] });
  await f.command.manageForeignRuntimeHistory(f.context);
  const [, items] = f.calls.find((call) => call[0] === 'pick');
  assert.equal(items[0].label, '归档（上一个数据目录里） · 20260901-010203-004-abcdef12');
});

test('启动发现：新条目只提示一次，之后再出现的新条目另行提示；“查看”打开外来历史库列表', async () => {
  const one = { id: 'foreign:archive:aaaaaaaaaaaaaaaa' };
  const two = { id: 'foreign:copied:bbbbbbbbbbbbbbbb' };
  const f = fixture({ discovered: [[one, two], [one, two], [one, two, { id: 'foreign:copied:cccccccccccccccc' }]], infos: [undefined, '查看'], picks: [undefined] });
  await f.command.announceForeignRuntimeHistoryOnStartup(f.context);
  await f.command.announceForeignRuntimeHistoryOnStartup(f.context);
  await f.command.announceForeignRuntimeHistoryOnStartup(f.context);
  for (let turn = 0; turn < 100 && !f.calls.some((call) => call[0] === 'inspect'); turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const infos = f.calls.filter((call) => call[0] === 'info');
  assert.equal(infos.length, 2);
  assert.match(infos[0][1], /^发现 2 个外来历史库/);
  assert.match(infos[0][1], /可以在“历史与存储管理 → 外来历史库”里核验，核验通过的可以只读查看；以后的版本支持合并/, '按发现计数，只承诺核验通过的可以查看');
  assert.match(infos[1][1], /^发现 1 个外来历史库/);
  assert.deepEqual(f.calls.find((call) => call[0] === 'discover'), ['discover', {
    paths: { globalStoragePath: ROOT }, configurationRootPath: ROOT, previousDataRootPath: '/old/limcode'
  }]);
  assert.equal(f.calls.filter((call) => call[0] === 'inspect').length, 1, '点“查看”才核验');
  const stale = fixture({ discovered: [[one]] });
  await stale.command.announceForeignRuntimeHistoryOnStartup(stale.context, () => false);
  assert.equal(stale.calls.some((call) => call[0] === 'info'), false, '窗口已换了运行时就不提示');
});
