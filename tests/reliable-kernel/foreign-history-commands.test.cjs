// Times are shown in local time (backupCleanup.formatTime): a zone other than UTC tells it apart from the ISO string.
process.env.TZ = 'Asia/Shanghai';
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
    // One Error for both sides: a fake's rejection is an `Error` to the command, as in the extension host.
    module, exports: module.exports, console, process, Error,
    require(name) {
      if (!Object.prototype.hasOwnProperty.call(dependencies, name)) throw new Error(`Unexpected source dependency: ${name}`);
      return dependencies[name];
    }
  }, { filename });
  return module.exports;
}

const ROOT = '/data/limcode';
const plain = (value) => JSON.parse(JSON.stringify(value));
/** Local time to the minute, as backupCleanup.formatTime shows it (the stub below is this). */
function local(value) {
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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
picks = [], warnings = [], infos = [], discovered = [], empties = [], status = {
  lastMigration: { fromPath: '/old/limcode', toPath: ROOT, migratedAt: '2026-09-01' }, previousDataRoots: ['/old/limcode', '/older/limcode']
}, mergeStates = [], requestError, host } = {}) {
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
      loadCommittedGlobalStatus: async () => plain(status),
      resolveDataRootUri: () => ({ fsPath: ROOT }),
      updateGlobalStatusDataRoot: async (_context, change) => { calls.push(['status', plain(change)]); }
    },
    '../../backend/capabilities/vscodeStorage/paths': { createVscodeStoragePaths: (uri) => ({ globalStoragePath: uri.fsPath }) },
    '../../backend/reliableKernel/runtimeDataSetHistory': {
      openRuntimeDataSetHistory: async (paths, root) => { calls.push(['open-history', plain(paths), root.id]); return { history: true }; }
    },
    '../../backend/reliableKernel/runtimeForeignHistory': {
      discoverForeignRuntimeHistory: async (input) => { calls.push(['discover', plain(input)]); return discovered.shift() ?? []; },
      inspectForeignRuntimeHistory: async (input) => {
        calls.push(['inspect', input.configurationRootPath, plain(input.previousDataRootPaths)]);
        input.onProgress?.(1, entries.length);
        return { configurationRootPath: ROOT, checkedAt: '2026-09-27T00:00:00.000Z', entries };
      },
      previousDataRootsWithoutForeignHistory: async (input) => { calls.push(['empty?', plain(input.previousDataRootPaths)]); return empties.shift() ?? []; },
      locateForeignRuntimeRoot: async (configurationRootPath, location) => { calls.push(['locate', configurationRootPath, plain(location)]); return located; },
      inspectForeignRuntimeStorage: async (paths, root) => {
        calls.push(['storage', plain(paths), root.id]);
        const size = (bytes, fileCount) => ({ bytes, fileCount });
        return { candidateId: 'x', dataSetId: 'data-set-a', observedAt: 'now', selected: false, archiveReclaimsBytes: false,
          categories: { sqlite: size('1024', 1), cas: size('2048', 1), casTemporary: size('0', 0), processSpool: size('0', 0), diagnostics: size('0', 0), other: size('1024', 1), historicalBackups: size('0', 0) },
          total: size('4096', 3) };
      }
    },
    '../../backend/reliableKernel/runtimeForeignHistoryMerge': {
      readForeignRuntimeHistoryMergeStates: async (paths, listed) => {
        calls.push(['merge-states', plain(paths), listed.map((item) => item.id)]);
        return new Map(mergeStates);
      },
      requestForeignRuntimeHistoryMerge: async (paths, request) => {
        calls.push(['request', plain(paths), plain(request)]);
        if (requestError) throw requestError;
      }
    },
    './runtimeDataSetManagement': {
      browseRuntimeHistory: async (_context, label, open, source) => { calls.push(['browse', label, source]); calls.push(['opened', plain(await open())]); },
      formatBytes: (value) => `${value} B`,
      showReadOnly: async (_context, title, text) => { calls.push(['read-only', title, text]); },
      mergeHistoricalDataSetsInBackground: async (_context, current, shouldContinue, ids) => {
        calls.push(['background-merge', current.name, shouldContinue(), plain(ids)]);
      },
      oversizedMergeNote: () => '（较大的库另行说明。）',
      keptForSkippedTip: (skipped) => `（跳过了 ${skipped} 个删掉的对话，清理备份会保留这份。）`
    },
    './backupCleanup': { formatTime: (value) => local(value) }
  });
  const startup = host === undefined ? undefined : { current: () => host };
  return { command, calls, context, state, startup };
}

const CLEANUP = /这份归档或拷来的库原样保留；确认不再需要时，可以在“清理备份”里按覆盖核对后删除。/;

test('外来历史库列表：核验通过的注明来源、原位置和“可以合并进当前库”，完全相同的拷贝折叠；未通过和暂时无法核验的列出位置、大小与原因', async () => {
  const f = fixture({ picks: [undefined] });
  await f.command.manageForeignRuntimeHistory(f.context);
  assert.deepEqual(f.calls.find((call) => call[0] === 'inspect'), ['inspect', ROOT, ['/old/limcode', '/older/limcode']], '历次离开的数据目录都找');
  assert.deepEqual(f.calls.find((call) => call[0] === 'merge-states'), ['merge-states', { globalStoragePath: ROOT },
    ['foreign:archive:0123456789abcdef', 'foreign:archive:1111111111111111', 'foreign:copied:fedcba9876543210', 'foreign:copied:2222222222222222']],
  '合并状态只从当前配置根的账本读');
  const [, items, placeHolder] = f.calls.find((call) => call[0] === 'pick');
  assert.equal(placeHolder, '外来历史库 · 原样保留；核验通过的可以只读查看，也可以合并进当前库');
  assert.equal(items.length, 3, '完全相同的拷贝只显示一份');
  const [archive, copied, unavailable] = items;
  assert.equal(archive.label, '归档 · 20260901-010203-004-abcdef12');
  assert.ok(archive.description.includes(`2 个对话 · 最后活动 ${local('2026-09-01T01:02:03.000Z')} · alpha · 4096 B（3 个文件）`), '时间按本地时间');
  assert.match(archive.detail, /位置：\/data\/limcode\/\.limcode-runtime-backups\/20260901-010203-004-abcdef12\/active/);
  assert.match(archive.detail, /原位置：\/data\/limcode\/\.limcode-runtime\/active/);
  assert.match(archive.detail, /只读；可以合并进当前库/);
  assert.doesNotMatch(archive.detail, /以后的版本/);
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

test('选中核验通过的外来库：可以只读查看、合并进当前库；只读查看经 located 根打开历史，存储占用写明原位置只作记录', async () => {
  const f = fixture({ picks: [0, (items) => items.find((item) => item.action === 'read'), 0, (items) => items.find((item) => item.action === 'storage'), undefined] });
  await f.command.manageForeignRuntimeHistory(f.context);
  const actions = f.calls.filter((call) => call[0] === 'pick')[1];
  assert.deepEqual(actions[1].map((item) => [item.label, item.action]),
    [['只读查看', 'read'], ['合并进当前库', 'merge'], ['查看存储占用', 'storage'], ['打开所在文件夹', 'reveal']]);
  assert.equal(actions[1][1].description, '在后台合并，原目录不改动');
  assert.equal(actions[2], '归档 · 20260901-010203-004-abcdef12');
  assert.equal(f.calls.some((call) => call[0] === 'request'), false, '只读查看不写合并请求');
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

test('以前的数据目录里的归档注明来源（连续迁移后不止上一个目录）', async () => {
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
  assert.equal(items[0].label, '归档（以前的数据目录里） · 20260901-010203-004-abcdef12');
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
  assert.match(infos[0][1], /可以在“历史与存储管理 → 外来历史库”里核验，核验通过的可以只读查看，也可以选择合并进当前库（不会自动合并）。原数据保持原样。/,
    '按发现计数，只承诺核验通过的可以查看和由用户选择合并');
  assert.match(infos[1][1], /^发现 1 个外来历史库/);
  assert.deepEqual(f.calls.find((call) => call[0] === 'discover'), ['discover', {
    paths: { globalStoragePath: ROOT }, configurationRootPath: ROOT, previousDataRootPaths: ['/old/limcode', '/older/limcode']
  }]);
  assert.ok(!f.calls.some((call) => call[0] === 'status'), '都还有归档或拷来的目录：列表不变');
  assert.equal(f.calls.filter((call) => call[0] === 'inspect').length, 1, '点“查看”才核验');
  const stale = fixture({ discovered: [[one]] });
  await stale.command.announceForeignRuntimeHistoryOnStartup(stale.context, () => false);
  assert.equal(stale.calls.some((call) => call[0] === 'info'), false, '窗口已换了运行时就不提示');
});

test('最后一轮 #5 启动发现之后，里面已经没有归档也没有拷来目录的旧数据目录从列表里去掉（由后端保守判定），其它照旧', async () => {
  const f = fixture({ discovered: [[]], empties: [['/older/limcode']] });
  await f.command.announceForeignRuntimeHistoryOnStartup(f.context);
  assert.deepEqual(f.calls.find((call) => call[0] === 'empty?'), ['empty?', ['/old/limcode', '/older/limcode']]);
  assert.deepEqual(f.calls.find((call) => call[0] === 'status'), ['status', { forgetPreviousDataRoots: ['/older/limcode'] }]);
  assert.ok(!f.calls.some((call) => call[0] === 'info'), '什么都没发现：不提示');
});

test('最后一轮 #5 本版本之前迁移过的安装（globalStatus 只有 lastMigration.fromPath，还没有旧目录列表）：上一个目录照旧查看；它空了也不写 globalStatus（不在列表里，没有可去掉的）', async () => {
  const f = fixture({ discovered: [[]], empties: [['/old/limcode']], status: { lastMigration: { fromPath: '/old/limcode', toPath: ROOT, migratedAt: '2026-09-01' } } });
  await f.command.announceForeignRuntimeHistoryOnStartup(f.context);
  assert.deepEqual(f.calls.find((call) => call[0] === 'discover'), ['discover', {
    paths: { globalStoragePath: ROOT }, configurationRootPath: ROOT, previousDataRootPaths: ['/old/limcode']
  }]);
  assert.ok(!f.calls.some((call) => call[0] === 'status'), '不在列表里：不写');
  const listed = fixture({ discovered: [[]], empties: [['/old/limcode']], status: {
    lastMigration: { fromPath: '/old/limcode', toPath: ROOT, migratedAt: '2026-09-01' }, previousDataRoots: ['/older/limcode']
  } });
  await listed.command.announceForeignRuntimeHistoryOnStartup(listed.context);
  assert.deepEqual(listed.calls.find((call) => call[0] === 'discover')[1].previousDataRootPaths, ['/older/limcode', '/old/limcode'], '列表加上最近一次迁移离开的目录');
  assert.ok(!listed.calls.some((call) => call[0] === 'status'));
});

test('合并进当前库：确认框写明只读、复制正文、中断任务与冲突不合并和清理备份提示；确认后按所见身份写请求，再只在后台合并这一个', async () => {
  const f = fixture({ picks: [0, (items) => items.find((item) => item.action === 'merge')], warnings: ['合并'], host: { name: 'window-host', product: {} } });
  await f.command.manageForeignRuntimeHistory(f.context, f.startup);
  const [, message, options, button] = f.calls.find((call) => call[0] === 'warning');
  assert.equal(message, '把这个外来历史库合并进当前库？');
  assert.equal(button, '合并');
  assert.equal(options.modal, true);
  assert.match(options.detail, /来源：\/data\/limcode\/\.limcode-runtime-backups\/20260901-010203-004-abcdef12\/active/);
  assert.match(options.detail, /外来历史库只读：合并不在它的目录里写任何东西，它原样保留；它的正文文件会复制进当前库（不共用文件）/);
  assert.match(options.detail, /还有中断的任务或排队未发送的消息，这次不合并并说明原因（当前版本不在外来目录里收尾），仍可只读查看/);
  assert.match(options.detail, /与当前库有数据冲突时整体不合并/);
  assert.match(options.detail, /你在本版本里删掉的对话不会回来；更早版本里删掉、而这份库里还有的对话会被加回来，合并后可以再删。/);
  assert.doesNotMatch(options.detail, /同一个库的其它拷贝合并进来的也一样/);
  assert.match(options.detail, /（较大的库另行说明。）/);
  assert.match(options.detail, CLEANUP);
  assert.deepEqual(f.calls.find((call) => call[0] === 'request'), ['request', { globalStoragePath: ROOT }, {
    id: 'foreign:archive:0123456789abcdef', location: entry().location, label: '外来历史库（归档 · 20260901-010203-004-abcdef12）',
    expectedDataSetId: 'data-set-a', expectedRootInstanceId: 'instance-a'
  }], '请求带上列表里所见的身份，合并时再核对');
  assert.deepEqual(f.calls.find((call) => call[0] === 'background-merge'), ['background-merge', 'window-host', true, ['foreign:archive:0123456789abcdef']]);
  assert.ok(f.calls.findIndex((call) => call[0] === 'request') < f.calls.findIndex((call) => call[0] === 'background-merge'), '先记录请求再合并');
  assert.equal(f.calls.filter((call) => call[0] === 'pick').length, 2, '开始合并后列表关闭');
});

test('合并进当前库：取消什么也不写；没有打开的当前库时只记录请求；请求被拒时说明原因且不合并', async () => {
  const cancelled = fixture({ picks: [0, (items) => items.find((item) => item.action === 'merge'), undefined], warnings: [undefined], host: { name: 'h', product: {} } });
  await cancelled.command.manageForeignRuntimeHistory(cancelled.context, cancelled.startup);
  assert.equal(cancelled.calls.some((call) => ['request', 'background-merge'].includes(call[0])), false);
  assert.equal(cancelled.calls.filter((call) => call[0] === 'pick').length, 3, '取消后回到列表');

  const noHost = fixture({ picks: [0, (items) => items.find((item) => item.action === 'merge')], warnings: ['合并'], host: {} });
  await noHost.command.manageForeignRuntimeHistory(noHost.context, noHost.startup);
  assert.equal(noHost.calls.filter((call) => call[0] === 'request').length, 1);
  assert.equal(noHost.calls.some((call) => call[0] === 'background-merge'), false);
  assert.deepEqual(noHost.calls.find((call) => call[0] === 'info'), ['info', '已记录合并请求，当前历史库打开后会自动合并。']);

  const refused = fixture({
    picks: [0, (items) => items.find((item) => item.action === 'merge'), undefined], warnings: ['合并'], host: { name: 'h', product: {} },
    requestError: new Error('所选外来历史库已变化，请重新打开外来历史库。')
  });
  await refused.command.manageForeignRuntimeHistory(refused.context, refused.startup);
  assert.deepEqual(refused.calls.find((call) => call[0] === 'error'), ['error', '没有合并：所选外来历史库已变化，请重新打开外来历史库。']);
  assert.equal(refused.calls.some((call) => call[0] === 'background-merge'), false);
});

test('旧拷贝：标出是谁的旧拷贝，合并入口写明不能合并；点开说明原因并提示在“清理备份”里按覆盖处理，不写请求', async () => {
  const oldCurrent = entry({ sameAsLocal: { candidateId: 'default', selected: true, name: '当前历史库' } });
  const oldWorkspace = entry({
    id: 'foreign:archive:3333333333333333', name: '20260902-010203-004-abcdef12',
    sameAsLocal: { candidateId: 'workspace:folder-0123456789abcdef', selected: false, name: 'alpha、beta' }
  });
  const f = fixture({
    entries: [oldCurrent, oldWorkspace], host: { name: 'h', product: {} },
    picks: [0, (items) => items.find((item) => item.action === 'old-copy'), 1, (items) => items.find((item) => item.label === '合并进当前库'), undefined]
  });
  await f.command.manageForeignRuntimeHistory(f.context, f.startup);
  const [, items] = f.calls.find((call) => call[0] === 'pick');
  assert.equal(items[0].label, '归档 · 20260901-010203-004-abcdef12（当前历史库的旧拷贝）');
  assert.match(items[0].detail, /只读；它是当前历史库的旧拷贝，不合并/);
  assert.equal(items[1].label, '归档 · 20260902-010203-004-abcdef12（历史库“alpha、beta”的旧拷贝）', '用可读的库名，不写内部 id');
  const actions = f.calls.filter((call) => call[0] === 'pick');
  assert.deepEqual(actions[1][1][1], { label: '合并进当前库', description: '不能合并：它是当前历史库的旧拷贝', action: 'old-copy' });
  assert.deepEqual(actions[3][1][1], { label: '合并进当前库', description: '不能合并：它是历史库“alpha、beta”的旧拷贝', action: 'old-copy' });
  const shown = f.calls.flatMap((call) => call[0] === 'pick'
    ? [call[2], ...call[1].flatMap((item) => [item.label, item.description, item.detail])]
    : call[0] === 'info' ? [call[1]] : []);
  assert.ok(shown.every((text) => !String(text ?? '').includes('folder-0123456789abcdef')), '任何提示里都没有内部 id');
  const infos = f.calls.filter((call) => call[0] === 'info');
  assert.equal(infos.length, 2);
  assert.match(infos[0][1], /^这个外来历史库是当前历史库的旧拷贝（同一个库的另一份），不合并/);
  assert.match(infos[0][1], /可以在“清理备份”里按覆盖核对后删除/);
  assert.equal(f.calls.some((call) => ['warning', 'request', 'background-merge'].includes(call[0])), false);
});

test('合并状态：已合并（时间）并提示在“清理备份”里按覆盖核对删除；之后有变化的可以再合并；请求中、被拒写明原因；上次合并过的被拒仍显示已合并（时间）', async () => {
  const ids = ['foreign:archive:a000000000000000', 'foreign:archive:b000000000000000', 'foreign:archive:c000000000000000', 'foreign:archive:d000000000000000'];
  const f = fixture({
    entries: ids.map((id, index) => entry({ id, name: `2026090${index + 1}-010203-004-abcdef12` })),
    mergeStates: [
      [ids[0], { state: 'merged', mergedAt: '2026-09-27T08:09:10.000Z', intoCurrent: true, changedSinceMerge: false }],
      [ids[1], { state: 'merged', mergedAt: '2026-09-26T01:02:03.000Z', intoCurrent: true, changedSinceMerge: true }],
      [ids[2], { state: 'requested', requestedAt: '2026-09-27T09:10:11.000Z' }],
      [ids[3], { state: 'blocked', code: 'runtime-data-set-merge-conflict', message: '同一个库的另一份拷贝先合并进来之后，这一份又有了不同的改动。\n第二行细节',
        lastMerged: { mergedAt: '2026-09-25T01:02:03.000Z', intoCurrent: true, changedSinceMerge: true } }]
    ],
    picks: [0, (items) => items.find((item) => item.action === 'merge'), undefined], warnings: [undefined]
  });
  await f.command.manageForeignRuntimeHistory(f.context);
  const [, items] = f.calls.find((call) => call[0] === 'pick');
  assert.equal(local('2026-09-27T08:09:10.000Z'), '2026-09-27 16:09', '本测试在东八区运行');
  assert.ok(items[0].description.startsWith('已合并（2026-09-27 16:09） · 2 个对话'), '时间按本地时间');
  assert.match(items[0].detail, /只读；已合并进当前库/);
  assert.match(items[0].detail, CLEANUP);
  assert.ok(items[1].description.startsWith(`已合并（${local('2026-09-26T01:02:03.000Z')}），之后有变化 · `));
  assert.match(items[1].detail, /只读；可以合并进当前库/);
  assert.ok(items[2].description.startsWith(`已请求合并（${local('2026-09-27T09:10:11.000Z')}），还没有完成 · `));
  assert.ok(items[3].description.startsWith(`已合并（${local('2026-09-25T01:02:03.000Z')}）；暂不能合并 · `));
  assert.match(items[3].detail, / · 只读；没有合并：同一个库的另一份拷贝先合并进来之后，这一份又有了不同的改动。$/);
  assert.doesNotMatch(items[3].detail, /第二行细节/);
  const [, actions, placeHolder] = f.calls.filter((call) => call[0] === 'pick')[1];
  assert.equal(placeHolder, `归档 · 20260901-010203-004-abcdef12 · 已合并（${local('2026-09-27T08:09:10.000Z')}）`);
  assert.equal(actions[1].description, `已合并（${local('2026-09-27T08:09:10.000Z')}）；在后台合并，原目录不改动`);
  assert.match(f.calls.find((call) => call[0] === 'warning')[2].detail, /它上次合并之后没有变化，这次会提示没有新内容/);
  assert.equal(f.calls.filter((call) => call[0] === 'merge-states').length, 2, '每次回到列表都重新读合并状态');
});

test('本地库（当前库或其它本地库）延续的旧身份的拷贝标为那个库的旧拷贝；合并时跳过了删掉的对话的，列表不再说可以在清理备份里删除', async () => {
  const continued = entry({ sameAsLocal: { candidateId: 'default', selected: true, name: '当前历史库', continued: true } });
  const skipped = entry({ id: 'foreign:archive:4444444444444444', name: '20260904-010203-004-abcdef12' });
  const other = entry({
    id: 'foreign:archive:5555555555555555', name: '20260905-010203-004-abcdef12',
    sameAsLocal: { candidateId: 'workspace:folder-0123456789abcdef', selected: false, name: 'alpha', continued: true }
  });
  const f = fixture({
    entries: [continued, skipped, other],
    mergeStates: [['foreign:archive:4444444444444444', { state: 'merged', mergedAt: '2026-09-27T08:09:10.000Z', intoCurrent: true, changedSinceMerge: false, skippedConversations: 2 }]],
    picks: [undefined]
  });
  await f.command.manageForeignRuntimeHistory(f.context);
  const [, items] = f.calls.find((call) => call[0] === 'pick');
  assert.equal(items[0].label, '归档 · 20260901-010203-004-abcdef12（当前历史库（迁移数据目录之前的那一份）的旧拷贝）');
  assert.match(items[0].detail, /只读；它是当前历史库（迁移数据目录之前的那一份）的旧拷贝，不合并/);
  assert.match(items[1].detail, /只读；已合并进当前库 · （跳过了 2 个删掉的对话，清理备份会保留这份。）/);
  assert.doesNotMatch(items[1].detail, CLEANUP, '清理备份会保留它，不再提示可以按覆盖删除');
  assert.equal(items[2].label, '归档 · 20260905-010203-004-abcdef12（历史库“alpha”（迁移数据目录之前的那一份）的旧拷贝）');
  assert.match(items[2].detail, /只读；它是历史库“alpha”（迁移数据目录之前的那一份）的旧拷贝，不合并/);
});

test('有未结束任务的外来库：列表写明原因、不说可以合并；合并入口写明暂不能合并，点开说明原因，不写请求，仍可只读查看', async () => {
  const busy = entry({ unfinishedWork: { finalizable: 2, refused: 1 } });
  const f = fixture({
    entries: [busy], host: { name: 'h', product: {} },
    picks: [0, (items) => items.find((item) => item.label === '合并进当前库'), 0, (items) => items.find((item) => item.action === 'read'), undefined]
  });
  await f.command.manageForeignRuntimeHistory(f.context, f.startup);
  const [, items] = f.calls.find((call) => call[0] === 'pick');
  assert.match(items[0].detail, /有 3 项未结束的任务（旧窗口中断时留下），合并前需要收尾，当前版本不在外来目录里收尾，所以暂不合并；可以只读查看/);
  assert.doesNotMatch(items[0].detail, /可以合并进当前库/);
  const actions = f.calls.filter((call) => call[0] === 'pick')[1][1];
  assert.deepEqual(actions[1], { label: '合并进当前库', description: '暂不能合并：有 3 项未结束的任务', action: 'unfinished' });
  const [, info] = f.calls.find((call) => call[0] === 'info');
  assert.match(info, /有 3 项未结束的任务（旧窗口中断时留下），合并前要先收尾；外来历史库只读，当前版本不在它的目录里收尾，所以暂不合并/);
  assert.equal(f.calls.some((call) => ['warning', 'request', 'background-merge'].includes(call[0])), false);
  assert.ok(f.calls.some((call) => call[0] === 'browse'), '仍可只读查看');
});

test('合并结果与大库会话里的名称：来源和名称可读，工作区库注明', () => {
  const f = fixture();
  assert.equal(f.command.foreignSourceLabel(entry()), '外来历史库（归档 · 20260901-010203-004-abcdef12）');
  assert.equal(f.command.foreignSourceLabel({ ...COPIED, scope: 'workspace:folder-x' }),
    '外来历史库（从别处拷来 · limcode.limcode-copied-2026-09-02T01-02-03-004Z-12345678 · 工作区库）');
  assert.equal(f.command.foreignSourceLabel({ ...COPIED, archiveName: '20260903-010203-004-abcdef12' }),
    '外来历史库（拷来目录里的归档 · 20260903-010203-004-abcdef12）');
});
